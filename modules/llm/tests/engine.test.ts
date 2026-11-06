/**
 * 推理组的引擎模拟（src/engine/）：账本公式、前缀缓存、块分配器和调度器。
 * 模型计算来自 src/model/，这里核对引擎的行为和账本公式与真实运行一致。
 */
import { describe, expect, it } from 'vitest';
import { BlockAllocator, blocksFor, pagedSlots, reservedSlots, Scheduler, type Request } from '../src/engine/paged';
import { blockHash, blockKeys, fnv1a64, PrefixCache, ROOT_HASH, u64Bytes } from '../src/engine/prefix';
import { archOf, forwardFlops, H100, kvBytesPerToken, LLAMA3_8B, miniKvBytesPerToken, miniWeightBytesRead, paramsOf, ridgePoint, roofline, weightBytesRead } from '../src/engine/roofline';
import { MODEL, TOKENIZER } from '../src/model';
import { FlopMeter } from '../src/model/tensor';
import { decodeStep, forward, generate, KVCache, lastLogits, paramCount } from '../src/model/transformer';
import { utf8Encode } from '@explorer/llm-core/utf8';

const W = MODEL;
const C = W.config;
const T = TOKENIZER;

describe('账本公式（roofline.ts）', () => {
  const arch = archOf(C);

  it('迷你模型：公式算出的 FLOPs 和 FlopMeter 逐个相同', () => {
    const tokens = T.encode('the cache keeps the keys');
    const meter = new FlopMeter();
    const cache = new KVCache(C);
    forward(W, tokens, { cache, meter, lastLogitsOnly: true });
    expect(meter.total).toBe(forwardFlops(arch, 0, tokens.length).total);
    // 不只算最后一个位置时，输出层按位置数计。
    expect(forward(W, tokens).meter.total).toBe(forwardFlops(arch, 0, tokens.length, false).total);
    for (let i = 0; i < 5; i++) {
      const before = meter.total;
      const pos = cache.length;
      decodeStep(W, cache, tokens[i], meter);
      expect(meter.total - before).toBe(forwardFlops(arch, pos, 1).total);
    }
    // 分段预填充：从位置 start 开始的一段。
    const tail = new FlopMeter();
    const half = new KVCache(C);
    forward(W, tokens.slice(0, 3), { cache: half });
    forward(W, tokens.slice(3), { cache: half, meter: tail, lastLogitsOnly: true });
    expect(tail.total).toBe(forwardFlops(arch, 3, tokens.length - 3).total);
  });

  it('迷你模型：参数量、读权重字节、KV 字节两种算法一致', () => {
    expect(paramsOf(arch).total).toBe(paramCount(W));
    for (const n of [1, 3, 8]) expect(miniWeightBytesRead(W, n, 2)).toBe(weightBytesRead(arch, n, 2));
    expect(kvBytesPerToken(arch, 2)).toBe(miniKvBytesPerToken(C, 2));
    expect(kvBytesPerToken(arch, 2)).toBe(KVCache.valuesPerToken(C) * 2);
  });

  it('Llama 3 8B：公开配置算出 8030261248 个参数，每 token 的 KV 128 KiB', () => {
    const p = paramsOf(LLAMA3_8B);
    expect(p.total).toBe(8_030_261_248);
    expect(p.layerMatmul).toBe(4096 * 4096 * 2 + 4096 * 1024 * 2 + 3 * 4096 * 14336);
    expect(kvBytesPerToken(LLAMA3_8B, 2)).toBe(128 * 1024);
    expect(kvBytesPerToken(LLAMA3_8B, 2) * LLAMA3_8B.context).toBe(1024 ** 3);
  });

  it('roofline：取两者中较大的时间，拐点是算力 / 带宽', () => {
    expect(ridgePoint(H100)).toBeCloseTo(989e12 / 3.35e12, 6);
    const r = roofline(1e12, 1e9, H100);
    expect(r.time).toBe(Math.max(r.compute, r.memory));
    expect(r.bound).toBe(r.intensity > ridgePoint(H100) ? 'compute' : 'memory');
  });
});

describe('前缀缓存（prefix.ts）', () => {
  it('FNV-1a 64 的标准测试值', () => {
    expect(fnv1a64([])).toBe(0xcbf29ce484222325n);
    expect(fnv1a64(utf8Encode('a'))).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64(utf8Encode('foobar'))).toBe(0x85944171f73967e8n);
  });

  it('只给满块算哈希，哈希链到父块', () => {
    const tokens = Array.from({ length: 10 }, (_, i) => i + 100);
    const keys = blockKeys(tokens, 4);
    expect(keys).toHaveLength(2);
    expect(keys[0].parent).toBe(ROOT_HASH);
    expect(keys[1].parent).toBe(keys[0].hash);
    expect(keys[1].bytes.slice(0, 8)).toEqual(u64Bytes(keys[0].hash));
    expect(keys[1].hash).toBe(blockHash(keys[0].hash, tokens.slice(4, 8)).hash);
  });

  it('同一块 token、不同的前缀：哈希不同', () => {
    const a = blockKeys([1, 2, 3, 4, 5, 6, 7, 8], 4);
    const b = blockKeys([9, 2, 3, 4, 5, 6, 7, 8], 4);
    expect(a[1].tokens).toEqual(b[1].tokens);
    expect(a[1].hash).not.toBe(b[1].hash);
  });

  it('复用前缀后的 logits 和完整重算逐位相同', () => {
    const cache = new PrefixCache(4);
    const shared = T.encode('the model is trained to predict the next token');
    const a = [...shared, ...T.encode(' in the text.')];
    const b = [...shared, ...T.encode(' at a time.')];
    cache.prefill(W, a);
    const meter = new FlopMeter();
    const hit = cache.prefill(W, b, meter);
    expect(hit.hits.length).toBe(Math.floor(shared.length / 4));
    expect(hit.computed).toBe(b.length - hit.reused);
    const full = forward(W, b, { lastLogitsOnly: true });
    expect(lastLogits(hit.trace)).toEqual(lastLogits(full));
    const ref = new KVCache(C);
    forward(W, b, { cache: ref });
    expect(hit.cache.k).toEqual(ref.k);
    expect(hit.cache.v).toEqual(ref.v);
    expect(meter.total).toBe(forwardFlops(archOf(C), hit.reused, hit.computed).total);
  });

  it('整段都在缓存里时，最后一块也要重算（需要最后一个位置的 logits）', () => {
    const cache = new PrefixCache(4);
    const tokens = T.encode('the model reads the tokens and the model writes').slice(0, 8);
    cache.prefill(W, tokens);
    const again = cache.prefill(W, tokens);
    expect(again.hits.length).toBe(1);
    expect(again.computed).toBe(4);
    expect(lastLogits(again.trace)).toEqual(lastLogits(forward(W, tokens)));
  });

  it('已有的块不重复登记，物理块号按登记顺序', () => {
    const cache = new PrefixCache(4);
    const tokens = T.encode('the model is trained to predict the next token');
    const first = cache.prefill(W, tokens);
    const second = cache.prefill(W, tokens);
    expect(first.inserted.map((b) => b.physical)).toEqual(first.keys.map((_, i) => i));
    expect(second.inserted).toHaveLength(0);
    expect(cache.blocks.size).toBe(first.keys.length);
  });
});

describe('块分配器和调度器（paged.ts）', () => {
  it('块分配器先进先出，用完就报错', () => {
    const allocator = new BlockAllocator(3, 4);
    expect([allocator.allocate(), allocator.allocate()]).toEqual([0, 1]);
    allocator.release([0]);
    expect(allocator.allocate()).toBe(2);
    expect(allocator.allocate()).toBe(0);
    expect(() => allocator.allocate()).toThrow();
    expect(blocksFor(9, 4)).toBe(3);
  });

  const prompts = ['the model writes', 'a token is', 'the tokenizer', 'the model turns each token', '大模型的'];
  const requests: Request[] = prompts.map((text, i) => ({ id: `R${i}`, prompt: T.encode(text), maxTokens: 10 }));
  const make = (policy: 'continuous' | 'static', numBlocks = 20, maxSeqs = 3) => {
    const s = new Scheduler(W, { numBlocks, blockSize: 4, maxSeqs, policy, eos: T.eos });
    requests.forEach((r) => s.add(r));
    s.run();
    return s;
  };

  it('每个请求的输出和单独调用 generate 相同', () => {
    for (const policy of ['continuous', 'static'] as const) {
      const s = make(policy);
      for (const seq of s.seqs) {
        const alone = generate(W, seq.request.prompt, { maxTokens: seq.request.maxTokens, stop: T.eos });
        expect(seq.output, `${policy} ${seq.request.id}`).toEqual(alone.tokens);
      }
    }
  });

  it('长生成：撞到上下文窗口时和 generate 停在同一处', () => {
    const s = new Scheduler(W, { numBlocks: 8, blockSize: 4, maxSeqs: 1, policy: 'continuous', eos: -1 });
    const prompt = T.encode('the cache keeps');
    s.add({ id: 'L', prompt, maxTokens: 100 });
    s.run();
    const alone = generate(W, prompt, { maxTokens: 100 });
    expect(s.seqs[0].output).toEqual(alone.tokens);
    expect(s.seqs[0].finishReason).toBe('window');
  });

  it('每一轮：块不重叠、块表放得下 cache、已用 + 空闲 = 总数、名额不超', () => {
    const s = make('continuous');
    for (const it of s.log) {
      const running = it.seqs.filter((seq) => seq.status === 'running');
      expect(running.length).toBeLessThanOrEqual(3);
      const owned = running.flatMap((seq) => seq.blockTable);
      expect(new Set(owned).size).toBe(owned.length);
      expect(owned.length).toBe(it.usedBlocks);
      expect(it.usedBlocks + it.freeBlocks.length).toBe(20);
      for (const seq of running) expect(seq.blockTable.length).toBe(blocksFor(seq.length, 4));
      for (const seq of it.seqs.filter((x) => x.status === 'finished')) expect(seq.blockTable).toEqual([]);
      for (const f of it.freed) expect(owned.some((b) => f.blocks.includes(b))).toBe(false);
    }
  });

  it('结束的请求当轮释放，等待的请求下一轮就被接纳', () => {
    const s = make('continuous');
    const finish = s.log.find((it) => it.finished.length && s.seqs.some((seq) => seq.status === 'finished' && seq.admittedAt! > it.index))!;
    expect(s.log[finish.index].admitted.length).toBeGreaterThan(0);
  });

  it('静态批处理：同样的 FLOPs 和输出，轮数不会更少', () => {
    const a = make('continuous');
    const b = make('static');
    expect(b.meter.total).toBe(a.meter.total);
    expect(b.log.length).toBeGreaterThanOrEqual(a.log.length);
    // 静态批处理里，批没结束之前不接纳新请求。
    for (const it of b.log) {
      if (!it.admitted.length || it.index === 1) continue;
      expect(b.log[it.index - 2].seqs.every((seq) => seq.status !== 'running')).toBe(true);
    }
  });

  it('浪费对照：分页只在最后一块浪费，预留按窗口长度算', () => {
    const s = make('continuous');
    for (const it of s.log) {
      const paged = pagedSlots(it.seqs, 4);
      const reserved = reservedSlots(it.seqs, C.maxSeq);
      expect(paged.used).toBe(reserved.used);
      expect(paged.reserved - paged.used).toBeLessThan(4 * it.seqs.filter((seq) => seq.status === 'running').length || 1);
      expect(reserved.reserved).toBe(C.maxSeq * it.seqs.filter((seq) => seq.status === 'running').length);
    }
  });
});
