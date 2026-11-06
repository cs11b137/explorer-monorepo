/**
 * 推理组第四课：连续批处理与 PagedAttention。
 * 真实执行：4 个请求交给 engine/paged.ts 的调度器，每一轮真的调 forward（预填充或解码 1 个 token），
 * 块分配、块表、释放都是调度器运行的结果；「按最大长度预留」和「静态批处理」两个对照也由同一份运行算出。
 */
import { tokenIds, wire } from '../decode/structures';
import { blocksFor, pagedSlots, reservedSlots, Scheduler, type Iteration, type Request, type SeqSnapshot } from '../engine/paged';
import { miniKvBytesPerToken, miniWeightBytesRead } from '../engine/roofline';
import { MODEL, TOKENIZER } from '../model';
import { i32Bytes } from '../model/numeric';
import { note, pk, render, show, state, type } from './dsl';
import { blockTableLayer, conceptOf, FP16_BYTES, labelOf, layerOf } from './infer-common';
import type { Color, DsCell, GridPrim, Lesson, LessonEvent, PacketEvent } from './types';

const W = MODEL;
const C = W.config;
const T = TOKENIZER;

/** 调度器配置。块大小：vLLM 在 GPU 上默认 16 个 token；迷你模型窗口只有 32，这里用 4。 */
export const CONFIG = { numBlocks: 16, blockSize: 4, maxSeqs: 3, eos: T.eos };
export const MAX_TOKENS = 12;
export const PROMPTS: Array<[string, string]> = [
  ['R0', 'the model writes'],
  ['R1', 'a token is'],
  ['R2', 'the tokenizer'],
  ['R3', 'the model turns each token'],
];
const requests: Request[] = PROMPTS.map(([id, text]) => ({ id, prompt: T.encode(text), maxTokens: MAX_TOKENS }));
const COLORS: Record<string, Color> = { R0: 'blue', R1: 'teal', R2: 'violet', R3: 'amber' };

function runWith(policy: 'continuous' | 'static') {
  const scheduler = new Scheduler(W, { ...CONFIG, policy });
  for (const request of requests) scheduler.add(request);
  scheduler.run();
  return scheduler;
}
export const continuous = runWith('continuous');
export const staticRun = runWith('static');
export const log = continuous.log;
const B = CONFIG.blockSize;

/** 每个位置的 KV 字节（fp16）。 */
export const perToken = miniKvBytesPerToken(C, FP16_BYTES);
export const blockBytes = perToken * B;

// ---------- 从运行结果里找关键的几轮 ----------

const first = log[0];
/** 第一个结束的请求和它结束的那一轮。 */
export const firstFinish = log.find((it) => it.finished.length > 0)!;
export const finishedFirst = firstFinish.finished[0];
/** 等待的请求被接纳的那一轮。 */
export const lateAdmit = log.find((it) => it.index > 1 && it.admitted.length > 0)!;
export const lateId = lateAdmit.admitted[0];
/** 已用块最多的一轮。 */
export const peak = log.reduce((best, it) => (it.usedBlocks > best.usedBlocks ? it : best));
export const peakReserved = reservedSlots(peak.seqs, C.maxSeq);
export const peakPaged = pagedSlots(peak.seqs, B);
export const waste = { reserved: (peakReserved.reserved - peakReserved.used) * perToken, paged: (peakPaged.reserved - peakPaged.used) * perToken };
/** 按最大长度预留时，整个池子能同时放几个请求。 */
export const reserveFits = Math.floor((CONFIG.numBlocks * B) / C.maxSeq);
export const poolBytes = CONFIG.numBlocks * blockBytes;
const lateSeq = continuous.seqs.find((seq) => seq.request.id === lateId)!;
const lateStatic = staticRun.seqs.find((seq) => seq.request.id === lateId)!;
/** 一轮里 3 个请求各解码 1 个 token：分开算要读 3 遍权重，拼成一批只读 1 遍。 */
const decodeRound = log.find((it) => it.decode.length === CONFIG.maxSeqs && it.prefill.length === 0)!;
export const batchRead = { separate: decodeRound.decode.length * miniWeightBytesRead(W, 1, FP16_BYTES), batched: miniWeightBytesRead(W, decodeRound.decode.length, FP16_BYTES), flops: decodeRound.stepFlops };

if (lateAdmit.index !== firstFinish.index + 1) throw new Error('batching：等待的请求应在第一个请求结束的下一轮被接纳');

// ---------- 图元 ----------

const STATUS: Record<SeqSnapshot['status'], string> = { waiting: '等待', running: '运行', finished: '结束' };
const MAX_BLOCKS = Math.max(...requests.map((r) => blocksFor(r.prompt.length + r.maxTokens, B)));

/** 请求表：状态、KV 位置数、块表（逻辑块 → 物理块）。 */
function requestGrid(seqs: SeqSnapshot[], lift: string[] = [], shown = seqs.length): GridPrim {
  return {
    kind: 'grid',
    id: 'q',
    w: 44,
    rows: seqs.slice(0, shown).map((seq) => seq.id),
    cols: ['状态', '位置', ...Array.from({ length: MAX_BLOCKS }, (_, i) => `L${i}`)],
    cells: seqs.slice(0, shown).map((seq): DsCell[] => {
      const tone = seq.status === 'finished' ? 'dim' : seq.status === 'waiting' ? undefined : COLORS[seq.id];
      const up = lift.includes(seq.id) || undefined;
      return [
        { v: STATUS[seq.status], tone, lift: up },
        { v: String(seq.length), tone },
        ...Array.from({ length: MAX_BLOCKS }, (_, i): DsCell => (i < seq.blockTable.length ? { v: `#${seq.blockTable[i]}`, tone: COLORS[seq.id], lift: up } : { v: '' })),
      ];
    }),
  };
}

const POOL_COLS = 4;
/** 物理块池：每格一个物理块，写着属于哪个请求，热度是块里填了几个位置。 */
function poolGrid(seqs: readonly SeqSnapshot[], fresh: number[] = []): GridPrim {
  const owner = new Map<number, { id: string; fill: number }>();
  for (const seq of seqs) {
    seq.blockTable.forEach((physical, logical) => owner.set(physical, { id: seq.id, fill: Math.min(B, seq.length - logical * B) }));
  }
  return {
    kind: 'grid',
    id: 'p',
    w: 50,
    rows: Array.from({ length: CONFIG.numBlocks / POOL_COLS }, (_, r) => `#${r * POOL_COLS}`),
    cols: Array.from({ length: POOL_COLS }, (_, c) => `+${c}`),
    cells: Array.from({ length: CONFIG.numBlocks / POOL_COLS }, (_, r) =>
      Array.from({ length: POOL_COLS }, (_, c): DsCell => {
        const physical = r * POOL_COLS + c;
        const slot = owner.get(physical);
        if (!slot) return { v: '' };
        return { v: `${slot.id}·${slot.fill}`, key: `b${physical}`, tone: COLORS[slot.id], heat: 0.3 + (0.7 * slot.fill) / B, lift: fresh.includes(physical) || undefined };
      }),
    ),
  };
}

const waitingSnapshot: SeqSnapshot[] = requests.map((r) => ({ id: r.id, status: 'waiting', length: 0, blockTable: [], output: [] }));

// ---------- 字节层 ----------

function batchInputs(it: Iteration): number[] {
  const out: number[] = [];
  for (const { id } of it.prefill) out.push(...requests.find((r) => r.id === id)!.prompt);
  for (const id of it.decode) {
    const seq = continuous.seqs.find((s) => s.request.id === id)!;
    const before = log[it.index - 2].seqs.find((s) => s.id === id)!;
    out.push(seq.output[before.output.length - 1]);
  }
  return out;
}

function freedLayer(freed: Iteration['freed']) {
  const blocks = freed.flatMap((f) => f.blocks);
  const layer = layerOf(`int32 freed[${blocks.length}] · ${blocks.length * 4} 字节`, 'green', '还回空闲队列末尾的物理块');
  freed.forEach((f) => f.blocks.forEach((b, i) => layer.field(`${f.id} 的 L${i}`, `物理块 ${b}`, () => layer.raw(i32Bytes(b)), { note: `${f.id} 结束，这一块立刻可以分给别的请求。` })));
  return layer;
}

// ---------- 事件 ----------

const schedState = (it: Iteration | null, extra: Record<string, string | null> = {}): LessonEvent =>
  state('sched', { 轮次: it ? String(it.index) : '0', 运行: it ? it.seqs.filter((s) => s.status === 'running').map((s) => s.id).join(' ') || '无' : '无', 空闲块: `${it ? it.freeBlocks.length : CONFIG.numBlocks} / ${CONFIG.numBlocks}`, ...extra });

/** 一轮结束、释放之前的样子：这一轮结束的请求仍带着它的块。 */
function beforeFree(it: Iteration): SeqSnapshot[] {
  return it.seqs.map((s) => {
    const freed = it.freed.find((f) => f.id === s.id);
    return freed ? { ...s, status: 'running', blockTable: freed.blocks } : s;
  });
}

function roundEvents(it: Iteration): LessonEvent[] {
  const prev = log[it.index - 2] ?? null;
  const inputs = batchInputs(it);
  const held = beforeFree(it);
  const work = [...it.prefill.map((p) => `${p.id} 预填充 ${p.positions}`), ...it.decode.map((id) => `${id} 解码 1`)];
  const events: LessonEvent[] = [schedState(it)];
  if (it.admitted.length) {
    events.push(pk('sched', 'queue', 'green', `接纳 ${it.admitted.join(' ')}`, it.admitted.map((id) => `${id}：${requests.find((r) => r.id === id)!.prompt.length} 个 token`), [prev?.flops ?? 0, 'SCHED', `第 ${it.index} 轮接纳 ${it.admitted.join('、')}：有名额，空闲块够放下提示词`, null],
      wire('接纳的条件', 'vals', '示意', conceptOf(`第 ${it.index} 轮`, [['名额', `运行中 < ${CONFIG.maxSeqs}（max_num_seqs）`], ['块', '空闲块 ≥ ⌈提示词长度 / 块大小⌉'], ['接纳', it.admitted.join('、')]])),
      { ds: { queue: [requestGrid((prev?.seqs ?? waitingSnapshot).map((s) => (it.admitted.includes(s.id) ? { ...s, status: 'running' } : s)), it.admitted)] } }));
  }
  if (it.allocated.length) {
    const byReq = [...new Set(it.allocated.map((a) => a.id))];
    const tableOf = (id: string) => held.find((s) => s.id === id)!.blockTable;
    const lengthBefore = (id: string) => prev?.seqs.find((p) => p.id === id)?.length ?? 0;
    events.push(pk('sched', 'kv', 'violet', `分配 ${it.allocated.length} 块`, it.allocated.map((a) => `${a.id}.L${a.logical} → #${a.physical}`), [prev?.flops ?? 0, 'ALLOC', `从空闲队列取块：${it.allocated.map((a) => `${a.id} 的 L${a.logical} → 物理块 ${a.physical}`).join('，')}`, byReq.reduce((sum, id) => sum + tableOf(id).length * 4, 0)],
      wire('分配后的块表', 'mem', 'internal', ...byReq.map((id) => blockTableLayer(`block_table[${id}]`, tableOf(id), { blockSize: B, color: COLORS[id] }))),
      { ds: { kv: [poolGrid(held.map((s) => ({ ...s, length: lengthBefore(s.id) })), it.allocated.map((a) => a.physical))] } }));
  }
  events.push(pk('sched', 'gpu', 'slate', `第 ${it.index} 轮`, work, [it.flops, 'MATMUL', `第 ${it.index} 轮：${work.join('，')}，共 ${inputs.length} 个 token，${it.stepFlops} FLOPs`, inputs.length * 4],
    wire(`第 ${it.index} 轮拼成一批的 token`, 'mem', 'format', tokenIds('batch', inputs, { labels: labelOf, summary: '所有请求这一轮要算的 token 拼在一起，一次前向' })),
    { ds: { kv: [poolGrid(held)], queue: [requestGrid(held)] } }));
  return events;
}

/** 某一轮里结束的请求：块还回空闲队列。 */
function freeEvents(it: Iteration): LessonEvent[] {
  if (!it.freed.length) return [];
  const blocks = it.freed.flatMap((f) => f.blocks);
  return [
    pk('kv', 'sched', 'green', `释放 ${blocks.length} 块`, it.freed.map((f) => `${f.id}：${f.blocks.map((b) => `#${b}`).join(' ')}`), [it.flops, 'FREE', `${it.finished.join('、')} 结束（${[...new Set(it.finished.map((id) => (continuous.seqs.find((s) => s.request.id === id)!.finishReason === 'eos' ? '遇到结束符' : `到了 max_tokens ${MAX_TOKENS}`)))].join('、')}），物理块 ${blocks.join('、')} 当轮还回空闲队列`, blocks.length * 4],
      wire('释放的物理块', 'mem', 'internal', freedLayer(it.freed)),
      { ds: { kv: [poolGrid(it.seqs)], queue: [requestGrid(it.seqs)] } }),
    schedState(it),
  ];
}

const outText = (id: string) => T.decode(continuous.seqs.find((s) => s.request.id === id)!.output);

function arrivals(): LessonEvent[] {
  return requests.map((r, i): PacketEvent =>
    pk('client', 'queue', COLORS[r.id], r.id, [`「${T.decode(r.prompt)}」`, `${r.prompt.length} 个 token`], [0, 'HTTP', `${r.id}：「${T.decode(r.prompt)}」，${r.prompt.length} 个 token，max_tokens ${MAX_TOKENS}`, r.prompt.length * 4],
      wire(`${r.id} 的提示词`, 'mem', 'format', tokenIds('prompt', r.prompt, { labels: labelOf, color: COLORS[r.id] })),
      { ds: { queue: [requestGrid(waitingSnapshot, [], i + 1)] } }),
  );
}

const midRounds = log.filter((it) => it.index > lateAdmit.index && it.index <= peak.index);
const endRounds = log.filter((it) => it.index > peak.index);
const lastRound = log[log.length - 1];


export const batching: Lesson = {
  id: 'batching',
  name: 'CONTINUOUS BATCHING',
  title: '连续批处理与 PagedAttention',
  group: 'infer',
  layer: [6, 6],
  layerNote: '调度和显存分页都发生在推理引擎内部，模型本身不知道。',
  opsUnit: 'FLOPs：调度器每一轮调用 forward 的累计乘加次数 × 2（预填充和解码都算）',
  opsShort: 'FLOPs',
  nodes: ['client', 'queue', 'sched', 'gpu', 'kv'],
  place: { client: [150, 430], queue: [470, 120], sched: [470, 440], gpu: [900, 470], kv: [1010, 130] },
  labels: {
    client: ['应用', `${requests.length} 个请求同时到达`],
    queue: ['请求和块表', '状态、KV 位置数、逻辑块 → 物理块'],
    sched: ['调度器', `最多 ${CONFIG.maxSeqs} 个同时跑，每块 ${B} 个位置`],
    gpu: ['GPU', '每轮把所有请求的 token 拼成一批'],
    kv: ['KV 物理块', `${CONFIG.numBlocks} 块 × ${B} 个位置 = ${poolBytes} 字节`],
  },
  labelAt: { queue: [-60, 170], kv: [0, 170] },
  radius: { queue: 175, kv: 155 },
  initial: { queue: [], kv: [] },
  start: ['client', 'queue', 'sched'],
  legend: [['blue', 'R0'], ['teal', 'R1'], ['violet', 'R2'], ['amber', 'R3'], [null, '格子里「R1·3」：属于 R1，填了 3 个位置'], [null, '运算量：累计 FLOPs']],
  overview: {
    full: '很多请求怎样共用一块 GPU',
    description: `解码一次只算 1 个 token，一个请求喂不饱 GPU，所以推理引擎把很多请求拼在一起跑。这一课真实运行一个仿 vLLM 的调度器：${requests.length} 个请求、最多 ${CONFIG.maxSeqs} 个同时跑、KV cache 切成 ${CONFIG.numBlocks} 个 ${B} 位置的块。${finishedFirst} 在第 ${firstFinish.index} 轮结束，${lateId} 第 ${lateAdmit.index} 轮就顶上；按需分块让峰值只浪费 ${waste.paged} 字节，按最大长度预留要浪费 ${waste.reserved} 字节，池子也只放得下 ${reserveFits} 个请求。`,
    facts: [
      ['请求', `${requests.length} 个，max_tokens ${MAX_TOKENS}`],
      ['同时运行', `最多 ${CONFIG.maxSeqs} 个`],
      ['KV 池', `${CONFIG.numBlocks} 块 × ${B} 位置 × ${perToken} 字节`],
      ['轮数', `连续批处理 ${log.length} 轮 · 静态批处理 ${staticRun.log.length} 轮`],
      ['运算量', '累计 FLOPs'],
    ],
  },
  steps: [
    {
      title: '四个请求排队',
      desc: `${requests.length} 个请求，名额只有 ${CONFIG.maxSeqs} 个`,
      detail: `${requests.length} 个请求同时到达，提示词长短不一，生成多长事先也不知道：有的很快遇到结束符，有的一直写到 max_tokens。调度器同时最多跑 ${CONFIG.maxSeqs} 个（vLLM 的 max_num_seqs），KV cache 的显存被切成 ${CONFIG.numBlocks} 个物理块，每块放 ${B} 个位置的 K、V（${blockBytes} 字节）。vLLM 在 GPU 上默认每块 16 个位置，迷你模型的窗口只有 ${C.maxSeq}，这里用 ${B}。`,
      facts: [['名额', `${CONFIG.maxSeqs} 个`], ['块', `${CONFIG.numBlocks} 个 × ${B} 位置`], ['每块', `${B} × ${perToken} = ${blockBytes} 字节`]],
      events: [
        type(`${requests.length} 个请求，max_tokens=${MAX_TOKENS}`),
        ...arrivals(),
        schedState(null, { 名额: `${CONFIG.maxSeqs}` }),
      ],
    },
    {
      title: `第 1 轮：接纳 ${first.admitted.length} 个，按需分块`,
      desc: `只给提示词分块：${first.allocated.length} 块`,
      detail: `第 1 轮有 ${CONFIG.maxSeqs} 个名额，${first.admitted.join('、')} 被接纳，${requests.filter((r) => !first.admitted.includes(r.id)).map((r) => r.id).join('、')} 继续等。每个请求只按提示词长度分块，${first.prefill.map((p) => `${p.id} ${p.positions} 个位置 ${blocksFor(p.positions, B)} 块`).join('，')}，以后写满一块再要下一块。${first.admitted.length} 个请求的 ${batchInputs(first).length} 个 token 拼成一批做一次预填充，共 ${first.stepFlops} FLOPs，各自选出第一个 token。`,
      facts: [['接纳', first.admitted.join(' ')], ['分配', first.allocated.map((a) => `${a.id} → #${a.physical}`).join(' · ')], ['FLOPs', String(first.stepFlops)]],
      events: [show('kv', 'gpu'), ...roundEvents(first)],
    },
    {
      title: `${finishedFirst} 结束，${lateId} 立刻顶上`,
      desc: `第 ${firstFinish.index} 轮释放，第 ${lateAdmit.index} 轮接纳`,
      detail: `之后每一轮，在跑的请求各解码 1 个 token。${finishedFirst} 写出「${outText(finishedFirst).trim()}」后在第 ${firstFinish.index} 轮遇到结束符，它的块当轮还回空闲队列；第 ${lateAdmit.index} 轮 ${lateId} 就被接纳，它的预填充和 ${lateAdmit.decode.join('、')} 的解码拼在同一批里。这就是迭代级调度（Orca 提出、vLLM 采用）：按「轮」而不是按「整批请求」决定谁上 GPU。解码时 ${decodeRound.decode.length} 个请求拼成一批只读一遍权重（${batchRead.batched} 字节），分开算要读 ${batchRead.separate} 字节。`,
      facts: [[`${finishedFirst} 输出`, `「${outText(finishedFirst).trim()}」`], ['释放', firstFinish.freed.flatMap((f) => f.blocks).map((b) => `#${b}`).join(' ')], [`${lateId} 接纳`, `第 ${lateAdmit.index} 轮`], ['一批解码读权重', `${batchRead.batched} / ${batchRead.separate} 字节`]],
      events: [
        ...log.filter((it) => it.index > 1 && it.index <= firstFinish.index).flatMap((it) => [...roundEvents(it), ...freeEvents(it)]),
        note('kv', `${finishedFirst} 的块当轮就空出来`, 'green'),
        ...roundEvents(lateAdmit),
      ],
    },
    {
      title: '块表：逻辑块 → 物理块',
      desc: `第 ${peak.index} 轮用了 ${peak.usedBlocks} / ${CONFIG.numBlocks} 块`,
      detail: `每个请求的 KV 在逻辑上是连续的位置，物理上却散在池子各处：${lateId} 的块表是 ${peak.seqs.find((s) => s.id === lateId)!.blockTable.map((b) => `#${b}`).join(' → ')}。注意力 kernel 拿着块表，按「位置 ÷ ${B} 取整」查到物理块、按「位置 mod ${B}」找到块内的槽，这就是 PagedAttention，和操作系统的页表是同一个思路。第 ${peak.index} 轮是峰值，${peak.seqs.filter((s) => s.status === 'running').length} 个请求共 ${peakPaged.used} 个位置，占 ${peak.usedBlocks} 块。`,
      facts: [...peak.seqs.filter((s) => s.status === 'running').map((s): [string, string] => [s.id, `${s.length} 个位置 · ${s.blockTable.map((b) => `#${b}`).join(' ')}`]), ['已用', `${peak.usedBlocks} / ${CONFIG.numBlocks} 块`]],
      events: [
        ...midRounds.flatMap((it) => [...roundEvents(it), ...freeEvents(it)]),
        pk('queue', 'gpu', COLORS[lateId], `block_table[${lateId}]`, peak.seqs.find((s) => s.id === lateId)!.blockTable.map((b, i) => `L${i} → #${b}`), [peak.flops, 'KV', `${lateId} 的块表：${peak.seqs.find((s) => s.id === lateId)!.blockTable.map((b, i) => `L${i}→#${b}`).join(' ')}`, peak.seqs.find((s) => s.id === lateId)!.blockTable.length * 4],
          wire(`attention kernel 读的块表（第 ${peak.index} 轮）`, 'mem', 'internal', ...peak.seqs.filter((s) => s.status === 'running').map((s) => blockTableLayer(`block_table[${s.id}]`, s.blockTable, { blockSize: B, color: COLORS[s.id], summary: `${s.length} 个位置，最后一块填了 ${s.length - (s.blockTable.length - 1) * B} 个` }))),
          { ds: { queue: [requestGrid(peak.seqs, [lateId])] } }),
      ],
    },
    {
      title: '按最大长度预留会怎样',
      desc: `峰值浪费：分页 ${waste.paged} 字节，预留 ${waste.reserved} 字节`,
      detail: `早期的服务系统不知道请求会生成多长，只好给每个请求预留整个窗口（${C.maxSeq} 个位置）的连续显存。第 ${peak.index} 轮的 ${peak.seqs.filter((s) => s.status === 'running').length} 个请求实际只用了 ${peakReserved.used} 个位置，预留却要 ${peakReserved.reserved} 个，空着的 ${peakReserved.reserved - peakReserved.used} 个位置就是 ${waste.reserved} 字节；而 ${CONFIG.numBlocks} 块的池子总共 ${CONFIG.numBlocks * B} 个位置，这样只放得下 ${reserveFits} 个请求。分页之后，浪费只出现在每个请求的最后一块里，峰值时 ${peakPaged.reserved - peakPaged.used} 个位置、${waste.paged} 字节。`,
      facts: [['预留', `${peakReserved.reserved} 个位置 · 浪费 ${waste.reserved} 字节`], ['分页', `${peakPaged.reserved} 个位置 · 浪费 ${waste.paged} 字节`], ['池子能放', `预留 ${reserveFits} 个 · 分页 ${CONFIG.maxSeqs} 个还剩 ${CONFIG.numBlocks - peak.usedBlocks} 块`]],
      events: [
        pk('kv', 'sched', 'amber', '对比：按最大长度预留', [`预留 ${peakReserved.reserved} 个位置`, `只用 ${peakReserved.used} 个`], [peak.flops, 'ALLOC', `第 ${peak.index} 轮：预留 ${peakReserved.reserved} 个位置、浪费 ${waste.reserved} 字节；分页只浪费 ${waste.paged} 字节`, null],
          wire(`第 ${peak.index} 轮的 KV 显存账`, 'vals', '示意', conceptOf('预留 vs 分页', [
            ['每个位置', `${perToken} 字节（fp16）`],
            ['按最大长度预留', `${peakReserved.reserved} 个位置，用了 ${peakReserved.used} 个`, `每个请求 ${C.maxSeq} 个位置，空着的 ${peakReserved.reserved - peakReserved.used} 个 × ${perToken} = ${waste.reserved} 字节。`],
            ['分页（块 = 4 个位置）', `${peakPaged.reserved} 个位置，用了 ${peakPaged.used} 个`, `只有每个请求的最后一块没填满：${peakPaged.reserved - peakPaged.used} 个 × ${perToken} = ${waste.paged} 字节。`],
            ['池子', `${CONFIG.numBlocks * B} 个位置`, `按最大长度预留只放得下 ${reserveFits} 个请求。`],
          ])),
          { ds: { kv: [{ ...poolGrid(peak.seqs), cells: poolGrid(peak.seqs).cells.map((row) => row.map((cell) => (cell.v ? cell : { v: '空', tone: 'dim' as const }))) }] } }),
        note('kv', `预留：${CONFIG.numBlocks} 块只够 ${reserveFits} 个请求`, 'amber'),
      ],
    },
    {
      title: '跑完：连续 vs 静态',
      desc: `${log.length} 轮对 ${staticRun.log.length} 轮`,
      detail: `${endRounds.flatMap((it) => it.finished).join('、')} 依次结束，第 ${lastRound.index} 轮全部完成，块全部还回池子。如果用静态批处理，一批请求要等最慢的那个结束才放下一批进来，${lateId} 要到第 ${lateStatic.admittedAt} 轮才开始（连续批处理是第 ${lateSeq.admittedAt} 轮），一共 ${staticRun.log.length} 轮。两种做法算的 FLOPs 完全一样（${continuous.meter.total}），差别只在 GPU 有没有空等。`,
      facts: [['连续批处理', `${log.length} 轮`], ['静态批处理', `${staticRun.log.length} 轮`], [`${lateId} 开始`, `第 ${lateSeq.admittedAt} 轮 vs 第 ${lateStatic.admittedAt} 轮`], ['FLOPs', staticRun.meter.total === continuous.meter.total ? `都是 ${continuous.meter.total}` : '不同']],
      events: [
        ...endRounds.flatMap((it) => [...roundEvents(it), ...freeEvents(it)]),
        pk('sched', 'client', 'green', '全部完成', requests.map((r) => `${r.id}「${outText(r.id).trim().slice(0, 14)}」`), [lastRound.flops, 'STREAM', `${log.length} 轮全部完成；静态批处理要 ${staticRun.log.length} 轮`, null],
          wire('各请求的输出', 'vals', '示意', conceptOf('输出', requests.map((r) => {
            const seq = continuous.seqs.find((s) => s.request.id === r.id)!;
            return [r.id, T.decode(seq.output).trim(), `第 ${seq.admittedAt}–${seq.finishedAt} 轮，${seq.output.length} 个 token，${seq.finishReason === 'eos' ? '遇到结束符' : '到了 max_tokens'}。`] as [string, string, string];
          }))),
          { ds: { queue: [requestGrid(lastRound.seqs)] } }),
        render,
      ],
    },
  ],
  outro: {
    title: '让 GPU 一直有活干',
    desc: `${log.length} 轮跑完 ${requests.length} 个请求`,
    text: `连续批处理解决「谁上 GPU」：每一轮重新排，结束的请求立刻让位，GPU 不空等；PagedAttention 解决「显存怎么分」：KV cache 按固定大小的块按需分配，用块表把逻辑位置映射到物理块，浪费只剩每个请求的最后一块。两者合起来，同一块显存能同时服务更多请求，每次读权重也能服务更多 token。另一条路是让权重本身变小，下一课把真实权重从 fp16 量化成 8 位和 4 位。`,
    facts: [['连续批处理', `${log.length} 轮`], ['峰值浪费', `${waste.paged} 字节（预留 ${waste.reserved}）`], ['下一课', '量化（fp16 → int4，对应 GGUF / Ollama）']],
  },
};
