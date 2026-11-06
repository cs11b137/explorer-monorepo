/**
 * 连续批处理 + 分页 KV cache 的最小实现，仿 vLLM：
 * - KV cache 的显存切成固定大小的物理块，空闲块排成队列，用一块取一块；
 * - 每个请求有一张块表：第 i 个逻辑块（位置 i·B .. i·B+B−1）在哪个物理块。物理块不必连续；
 * - 调度按「迭代」进行（Orca 提出的 iteration-level scheduling）：每一轮先接纳等待的请求，
 *   新请求这一轮做预填充，已在跑的请求各解码 1 个 token；结束的请求当轮释放块，下一轮就有人顶上。
 *
 * 模型计算是真的：每个请求一个 KVCache，预填充和解码都调 model/ 的 forward，FLOPs 由同一个 FlopMeter 累计。
 * 块表和物理块号是调度器的账，属于引擎内部布局（internal）。
 */
import { argmax, FlopMeter } from '../model/tensor';
import { forward, KVCache, lastLogits, type Weights } from '../model/transformer';

export class BlockAllocator {
  /** 空闲的物理块号，先进先出。 */
  readonly free: number[];

  constructor(readonly numBlocks: number, readonly blockSize: number) {
    this.free = Array.from({ length: numBlocks }, (_, i) => i);
  }

  allocate(): number {
    const block = this.free.shift();
    if (block === undefined) throw new Error('KV 块用完了：需要抢占（本模拟的场景不应走到这里）');
    return block;
  }

  release(blocks: readonly number[]): void {
    this.free.push(...blocks);
  }

  get used(): number {
    return this.numBlocks - this.free.length;
  }
}

/** 放下 n 个位置要几块。 */
export const blocksFor = (positions: number, blockSize: number): number => Math.ceil(positions / blockSize);

export interface Request {
  id: string;
  prompt: number[];
  /** 最多生成多少个 token（API 的 max_tokens）。 */
  maxTokens: number;
}

export type SeqStatus = 'waiting' | 'running' | 'finished';

export interface Sequence {
  request: Request;
  status: SeqStatus;
  cache: KVCache;
  /** 块表：逻辑块号 → 物理块号。结束后清空。 */
  blockTable: number[];
  /** 已生成的 token（不含结束符）。 */
  output: number[];
  /** 下一轮要喂给模型的 token。 */
  next: number | null;
  /** 第几轮被接纳、第几轮结束（从 1 数）。 */
  admittedAt: number | null;
  finishedAt: number | null;
  finishReason: 'eos' | 'length' | 'window' | null;
}

/** 一个请求在某一轮结束时的样子。 */
export interface SeqSnapshot {
  id: string;
  status: SeqStatus;
  /** KV cache 里的位置数。 */
  length: number;
  blockTable: number[];
  output: number[];
}

export interface Iteration {
  /** 第几轮，从 1 数。 */
  index: number;
  admitted: string[];
  /** 这一轮做预填充的请求和它算了几个位置。 */
  prefill: Array<{ id: string; positions: number }>;
  /** 这一轮解码 1 个 token 的请求。 */
  decode: string[];
  /** 这一轮每个请求采样出的 token。 */
  sampled: Record<string, number>;
  finished: string[];
  /** 这一轮新分配的块。 */
  allocated: Array<{ id: string; logical: number; physical: number }>;
  /** 这一轮释放的块。 */
  freed: Array<{ id: string; blocks: number[] }>;
  /** 到这一轮结束为止累计的 FLOPs。 */
  flops: number;
  /** 这一轮花的 FLOPs。 */
  stepFlops: number;
  /** 这一轮结束时的已用块数。 */
  usedBlocks: number;
  freeBlocks: number[];
  seqs: SeqSnapshot[];
}

export interface SchedulerOptions {
  numBlocks: number;
  blockSize: number;
  /** 同时在跑的请求数上限（vLLM 的 max_num_seqs）。 */
  maxSeqs: number;
  /** continuous：迭代级调度；static：一批请求一起开始，全部结束后才接下一批。 */
  policy: 'continuous' | 'static';
  /** 结束符。 */
  eos: number;
}

export class Scheduler {
  readonly allocator: BlockAllocator;
  readonly seqs: Sequence[] = [];
  readonly meter = new FlopMeter();
  readonly log: Iteration[] = [];

  constructor(readonly weights: Weights, readonly options: SchedulerOptions) {
    this.allocator = new BlockAllocator(options.numBlocks, options.blockSize);
  }

  add(request: Request): void {
    this.seqs.push({ request, status: 'waiting', cache: new KVCache(this.weights.config), blockTable: [], output: [], next: null, admittedAt: null, finishedAt: null, finishReason: null });
  }

  get done(): boolean {
    return this.seqs.every((seq) => seq.status === 'finished');
  }

  /** 让 seq 的块表能放下 positions 个位置，不够就从空闲队列取块。 */
  private grow(seq: Sequence, positions: number, record: Iteration['allocated']): void {
    while (seq.blockTable.length * this.options.blockSize < positions) {
      const physical = this.allocator.allocate();
      record.push({ id: seq.request.id, logical: seq.blockTable.length, physical });
      seq.blockTable.push(physical);
    }
  }

  private finish(seq: Sequence, reason: NonNullable<Sequence['finishReason']>, index: number, freed: Iteration['freed']): void {
    seq.status = 'finished';
    seq.finishReason = reason;
    seq.finishedAt = index;
    freed.push({ id: seq.request.id, blocks: seq.blockTable.slice() });
    this.allocator.release(seq.blockTable);
    seq.blockTable = [];
  }

  /** 跑一轮。 */
  step(): Iteration {
    const index = this.log.length + 1;
    const before = this.meter.total;
    const it: Iteration = { index, admitted: [], prefill: [], decode: [], sampled: {}, finished: [], allocated: [], freed: [], flops: 0, stepFlops: 0, usedBlocks: 0, freeBlocks: [], seqs: [] };
    const { blockSize, maxSeqs, policy, eos } = this.options;

    // 1. 接纳：按到达顺序，有名额、有足够的空闲块放下提示词就接纳。
    //    static 策略下，只有上一批全部结束（没有在跑的请求）才组新的一批。
    const running = () => this.seqs.filter((seq) => seq.status === 'running');
    const canAdmit = policy === 'continuous' || running().length === 0;
    if (canAdmit) {
      for (const seq of this.seqs) {
        if (seq.status !== 'waiting') continue;
        if (running().length >= maxSeqs) break;
        if (blocksFor(seq.request.prompt.length, blockSize) > this.allocator.free.length) break;
        seq.status = 'running';
        seq.admittedAt = index;
        it.admitted.push(seq.request.id);
      }
    }

    // 2. 执行：新请求预填充整段提示词，其余请求解码 1 个 token。
    const finishing: Sequence[] = [];
    for (const seq of running()) {
      const fresh = seq.cache.length === 0;
      const inputs = fresh ? seq.request.prompt : [seq.next!];
      this.grow(seq, seq.cache.length + inputs.length, it.allocated);
      const trace = forward(this.weights, inputs, { cache: seq.cache, meter: this.meter, lastLogitsOnly: true });
      if (fresh) it.prefill.push({ id: seq.request.id, positions: inputs.length });
      else it.decode.push(seq.request.id);
      const token = argmax(lastLogits(trace));
      it.sampled[seq.request.id] = token;
      if (token === eos) {
        finishing.push(seq);
        seq.finishReason = 'eos';
        continue;
      }
      seq.output.push(token);
      seq.next = token;
      if (seq.output.length >= seq.request.maxTokens) {
        finishing.push(seq);
        seq.finishReason = 'length';
      } else if (seq.request.prompt.length + seq.output.length >= this.weights.config.maxSeq) {
        // 和 generate 一致：提示词加输出到了窗口长度就停（下一个 token 已经没有位置可写）。
        finishing.push(seq);
        seq.finishReason = 'window';
      }
    }

    // 3. 结束的请求当轮释放块。static 策略下块也释放，但名额要等整批结束（running 为空）才重新开放。
    for (const seq of finishing) {
      this.finish(seq, seq.finishReason!, index, it.freed);
      it.finished.push(seq.request.id);
    }

    it.flops = this.meter.total;
    it.stepFlops = this.meter.total - before;
    it.usedBlocks = this.allocator.used;
    it.freeBlocks = this.allocator.free.slice();
    it.seqs = this.seqs.map((seq) => ({ id: seq.request.id, status: seq.status, length: seq.cache.length, blockTable: seq.blockTable.slice(), output: seq.output.slice() }));
    this.log.push(it);
    return it;
  }

  run(limit = 200): Iteration[] {
    while (!this.done && this.log.length < limit) this.step();
    if (!this.done) throw new Error(`跑了 ${limit} 轮还没结束`);
    return this.log;
  }
}

/**
 * 「按最大长度预留」的对照：每个在跑的请求一开始就占满上下文窗口那么多个位置（早期系统的做法，
 * 因为不知道它会生成多长）。返回预留的位置数和真正用掉的位置数。
 */
export function reservedSlots(seqs: readonly SeqSnapshot[], maxSeq: number): { reserved: number; used: number } {
  const running = seqs.filter((seq) => seq.status === 'running');
  return { reserved: running.length * maxSeq, used: running.reduce((sum, seq) => sum + seq.length, 0) };
}

/** 分页时的对照：已分配块的位置数和真正用掉的位置数，差值只出现在每个请求的最后一块里。 */
export function pagedSlots(seqs: readonly SeqSnapshot[], blockSize: number): { reserved: number; used: number } {
  const running = seqs.filter((seq) => seq.status === 'running');
  return { reserved: running.reduce((sum, seq) => sum + seq.blockTable.length * blockSize, 0), used: running.reduce((sum, seq) => sum + seq.length, 0) };
}
