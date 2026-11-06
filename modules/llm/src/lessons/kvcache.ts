/**
 * 推理组第二课：KV cache 增长与上下文窗口上限。
 * 真实执行：「the cache keeps」预填充后一直解码，直到 cache 放满上下文窗口（32 个位置），再多一步 forward 就报错。
 * 每个位置的字节数由公式 2 × 层数 × KV 头数 × head_dim × 每个数的字节数 算出，并和 KVCache.valuesPerToken 核对；
 * 同一个公式外推到 Llama 3 8B。带 cache 和不带 cache 的 FLOPs 都是真实运行的结果（两者输出一致，tests/model.test.ts）。
 */
import { tokenIds, wire } from '../decode/structures';
import { archOf, H100, kvBytesPerToken, LLAMA3_8B, LLAMA31_CONTEXT, miniKvBytesPerToken, paramsOf } from '../engine/roofline';
import { MODEL, TOKENIZER } from '../model';
import { argmax, FlopMeter } from '../model/tensor';
import { decodeStep, forward, generate, KVCache, lastLogits } from '../model/transformer';
import { cellsOf, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { bytesText, conceptOf, FP16_BYTES, kvLayer, labelOf, PROMPT, PROMPT_IDS } from './infer-common';
import type { DsCell, GridPrim, Lesson, LessonEvent, PacketEvent, RowPrim, TowerPrim } from './types';

const W = MODEL;
const C = W.config;
const N = PROMPT_IDS.length;
const T = TOKENIZER;

// ---------- 真实运行：一直解码到窗口放满 ----------

const meter = new FlopMeter();
const cache = new KVCache(C);
const prefillTrace = forward(W, PROMPT_IDS, { cache, meter, lastLogitsOnly: true });
export const prefillFlops = meter.total;
const afterPrefill = cache.clone();

export interface DecodeRecord {
  pos: number;
  input: number;
  token: number;
  /** 到这一步为止累计的 FLOPs。 */
  total: number;
  flops: number;
}
/** 每一步：把上一个 token 写进位置 pos，得到下一个 token。 */
export const steps: DecodeRecord[] = [];
export const firstToken = argmax(lastLogits(prefillTrace));
{
  let input = firstToken;
  while (cache.length < C.maxSeq) {
    const before = meter.total;
    const pos = cache.length;
    const token = argmax(decodeStep(W, cache, input, meter).logits);
    steps.push({ pos, input, token, total: meter.total, flops: meter.total - before });
    input = token;
  }
}
/** 生成的全部 token：第一个来自预填充，之后每步一个。 */
export const generated = [firstToken, ...steps.map((s) => s.token)];
/** 窗口满了以后再走一步会怎样：forward 抛出的错误原文。 */
export const overflowError = (() => {
  try {
    forward(W, [generated[generated.length - 1]], { cache: cache.clone() });
    return '';
  } catch (error) {
    return (error as Error).message;
  }
})();

// ---------- 带 cache 和不带 cache ----------

/** 和上面一样从提示词生成，不带 cache 每一步把整个序列从头算一遍。两者 token 逐个相同。 */
export const COMPARE_TOKENS = C.maxSeq - N;
export const withCache = generate(W, PROMPT_IDS, { maxTokens: COMPARE_TOKENS });
export const noCache = generate(W, PROMPT_IDS, { maxTokens: COMPARE_TOKENS, noCache: true });

// ---------- 字节账 ----------

const arch = archOf(C);
/** 迷你模型每个位置的 KV 字节（fp16）。 */
export const perToken = kvBytesPerToken(arch, FP16_BYTES);
if (perToken !== miniKvBytesPerToken(C, FP16_BYTES)) throw new Error('kvcache：两种算法得到的每 token 字节数不同');
export const windowBytes = perToken * C.maxSeq;

const L3 = LLAMA3_8B;
export const llama = (() => {
  const params = paramsOf(L3);
  const perTok = kvBytesPerToken(L3, FP16_BYTES);
  const noGqa = kvBytesPerToken({ ...L3, kvHeads: L3.heads }, FP16_BYTES);
  const weights = params.total * FP16_BYTES;
  return {
    perToken: perTok,
    noGqa,
    weights,
    context8k: perTok * L3.context,
    context128k: perTok * LLAMA31_CONTEXT,
    noGqa128k: noGqa * LLAMA31_CONTEXT,
    /** 80 GB 显存放下权重以后还能放多少个位置。 */
    fit80: Math.floor((H100.memory - weights) / perTok),
    noGqaFits: weights + noGqa * LLAMA31_CONTEXT <= H100.memory,
  };
})();

// ---------- 图元 ----------

const ROWS = 4;
const COLS = C.maxSeq / ROWS;
const seq = [...PROMPT_IDS, ...generated];

/** cache 的 32 个槽，按位置排成 4 × 8。 */
function kvGrid(filled: number, fresh: number[] = [], lift: 'fresh' | 'all' = 'fresh'): GridPrim {
  return {
    kind: 'grid',
    id: 'kv',
    w: 40,
    rows: Array.from({ length: ROWS }, (_, r) => `${r * COLS}–${r * COLS + COLS - 1}`),
    cols: Array.from({ length: COLS }, (_, c) => `+${c}`),
    cells: Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c): DsCell => {
        const pos = r * COLS + c;
        if (pos >= filled) return { v: '' };
        return { v: shortLabel(seq[pos], 4), key: `p${pos}`, tone: pos < N ? 'teal' : 'amber', lift: lift === 'all' || fresh.includes(pos) || undefined };
      }),
    ),
  };
}

function outRow(count: number): RowPrim {
  const SHOW = 5;
  const from = Math.max(0, count - SHOW);
  const ids = generated.slice(from, count);
  return { kind: 'row', id: 'o', w: 44, cells: cellsOf([...ids.map((id) => shortLabel(id, 5)), ...Array(SHOW - ids.length).fill(null)], { rest: 'amber', keys: [...ids.map((_, i) => `g${from + i}`), ...Array.from({ length: SHOW - ids.length }, (_, i) => `e${i}`)], subs: ids.map((_, i) => String(N + from + i)) }) };
}

const memTower = (frames: Array<[string, string, 'blue' | 'teal' | 'amber' | 'slate']>): TowerPrim => ({ kind: 'tower', id: 'm', frames: frames.map(([key, text, tone]) => ({ key, text, tone })) });

// ---------- 事件 ----------

const kvState = (positions: number, flops: number): LessonEvent => state('gpu', { 'cache 位置': `${positions} / ${C.maxSeq}`, 'cache 字节': `${positions * perToken} B`, FLOPs: String(flops) });

function appendPacket(step: DecodeRecord): PacketEvent {
  const filled = step.pos + 1;
  return pk('gpu', 'kv', 'amber', `位置 ${step.pos}`, [`「${labelOf(step.input)}」`, `+${perToken} 字节`], [step.total, 'KV', `「${labelOf(step.input)}」写进位置 ${step.pos}，cache 共 ${filled * perToken} 字节；选出「${labelOf(step.token)}」`, perToken],
    wire(`位置 ${step.pos} 追加的一行`, 'mem', 'internal', kvLayer('kv', cache, step.pos, step.pos + 1, { color: 'amber' })),
    { ds: { kv: [kvGrid(filled, [step.pos])], out: [outRow(step.pos - N + 2)] } });
}

const detailed = steps.slice(0, 3);
/** 一段连续的解码步合成一个事件：画面上一次多填几格。 */
function chunkPacket(from: number, to: number): PacketEvent {
  const run = steps.filter((s) => s.pos >= from && s.pos <= to);
  const end = run[run.length - 1];
  const text = T.decode(run.map((s) => s.input));
  return pk('gpu', 'kv', 'amber', `位置 ${from}–${to}`, [`「${text.trim()}」`, `+${run.length * perToken} 字节`], [end.total, 'KV', `解码 ${run.length} 步，位置 ${from}–${to} 写入「${text}」，cache 共 ${(to + 1) * perToken} 字节`, run.length * perToken],
    wire(`位置 ${from}–${to} 追加的 ${run.length} 行`, 'mem', 'internal', kvLayer('kv', cache, from, to + 1, { color: 'amber', labels: (pos) => `${pos}「${labelOf(seq[pos])}」` })),
    { ds: { kv: [kvGrid(to + 1, run.map((s) => s.pos))], out: [outRow(to - N + 2)] } });
}
const middle = [[11, 15], [16, 19], [20, 23]].map(([a, b]) => chunkPacket(a, b));
const tail = [[24, 27], [28, 31]].map(([a, b]) => chunkPacket(a, b));
const last = steps[steps.length - 1];
const at24 = steps.find((s) => s.pos === 23)!;

export const kvcache: Lesson = {
  id: 'kvcache',
  name: 'KV CACHE',
  title: 'KV cache 与上下文窗口',
  group: 'infer',
  layer: [4, 6],
  layerNote: '注意力要用的 K、V 被推理引擎存在显存里，窗口多长由显存决定。',
  opsUnit: 'FLOPs：带 cache 生成时累计的乘加次数 × 2（不带 cache 的对照另算，写在说明里）',
  opsShort: 'FLOPs',
  nodes: ['client', 'tokens', 'gpu', 'kv', 'out'],
  place: { client: [180, 90], tokens: [190, 420], gpu: [580, 280], kv: [960, 520], out: [960, 80] },
  labels: {
    client: ['应用', '一直生成，直到窗口放满'],
    tokens: ['提示词', `${N} 个 token`],
    gpu: ['GPU', '显存里放着 KV cache'],
    kv: ['KV cache', `${C.maxSeq} 个位置，每个 ${perToken} 字节`],
    out: ['输出', '最近生成的 token'],
  },
  labelAt: { tokens: [-150, 40], kv: [0, 170], out: [150, -30] },
  radius: { tokens: 60, kv: 210, out: 60 },
  initial: { tokens: [], kv: [], out: [] },
  start: ['client', 'tokens', 'gpu'],
  legend: [['teal', '提示词的 K、V'], ['amber', '生成时追加的 K、V'], [null, '运算量：带 cache 的累计 FLOPs']],
  overview: {
    full: '模型怎样记住前文，又为什么记不了太长',
    description: `注意力每一步都要看前面所有位置的 K、V。推理引擎把它们存在显存里，叫 KV cache：每生成一个 token 追加一行，每行 2 × 层数 × KV 头数 × head_dim 个数。这一课让迷你模型从「${PROMPT}」一直生成，直到 ${C.maxSeq} 个位置的窗口放满；再用同一个公式算 ${L3.name}：fp16 下每个 token ${bytesText(llama.perToken)}，${LLAMA31_CONTEXT / 1024}K 上下文要 ${bytesText(llama.context128k)}，比 fp16 权重本身还大。`,
    facts: [
      ['每 token', `2 × ${C.nLayers} 层 × ${C.nHeads} 头 × ${C.headDim} 维 × 2 字节 = ${perToken} 字节`],
      ['窗口', `${C.maxSeq} 个位置 = ${windowBytes} 字节`],
      ['带 / 不带 cache', `${withCache.meter.total} / ${noCache.meter.total} FLOPs`],
      [L3.name, `${bytesText(llama.perToken)} / token`],
      ['运算量', '带 cache 的累计 FLOPs'],
    ],
  },
  steps: [
    {
      title: '预填充写下第一批',
      desc: `${N} 个位置，${N * perToken} 字节`,
      detail: `预填充时每层把 ${N} 个位置的 K（已经过 RoPE）和 V 写进 cache。迷你模型 ${C.nLayers} 层、${C.nHeads} 个头、每头 ${C.headDim} 维，每个位置存 2 × ${C.nLayers} × ${C.nHeads} × ${C.headDim} = ${perToken / FP16_BYTES} 个数，按 fp16 是 ${perToken} 字节。这和 KVCache.valuesPerToken 数出来的一致：每层 K、V 各一行 d_model 维。`,
      facts: [['公式', '2 × 层数 × KV 头数 × head_dim × 每个数的字节'], ['迷你模型', `2 × ${C.nLayers} × ${C.nHeads} × ${C.headDim} × 2 = ${perToken} 字节`], ['预填充后', `${N} 个位置 · ${N * perToken} 字节`]],
      events: [
        type(`generate("${PROMPT}")`),
        pk('client', 'tokens', 'blue', 'input_ids', [`${N} 个 token`], [0, 'IDS', `提示词 ${N} 个 token`, N * 4],
          wire('提示词的 token id', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: labelOf })),
          { ds: { tokens: [{ kind: 'row', id: 't', w: 40, cells: cellsOf(PROMPT_IDS.map((id) => shortLabel(id, 5)), { rest: 'teal' }) }] } }),
        pk('tokens', 'gpu', 'teal', '预填充', [`${N} 个位置`], [prefillFlops, 'MATMUL', `预填充 ${N} 个位置：${prefillFlops} FLOPs`, N * 4],
          wire('预填充的输入', 'mem', 'format', tokenIds('batch', PROMPT_IDS, { labels: labelOf }))),
        show('kv'),
        kvState(N, prefillFlops),
        pk('gpu', 'kv', 'teal', `写入 ${N} 行`, [`${N} × ${perToken} 字节`], [prefillFlops, 'KV', `${N} 个位置的 K、V 写进 cache：${N * perToken} 字节`, N * perToken],
          wire('预填充写入的 KV cache', 'mem', 'internal', kvLayer('kv', afterPrefill, 0, N, { labels: (pos) => `${pos}「${labelOf(PROMPT_IDS[pos])}」`, summary: `每个位置 ${perToken} 字节：${C.nLayers} 层 × (K + V)，各 ${C.dModel} 个 fp16` })),
          { ds: { kv: [kvGrid(N)] } }),
        note('kv', `每个位置 ${perToken} 字节`),
      ],
    },
    {
      title: '每个 token 追加一行',
      desc: `第 ${N} 到第 ${at24.pos} 个位置，cache 涨到 ${(at24.pos + 1) * perToken} 字节`,
      detail: `解码时只有新 token 要算 K、V，算完追加到 cache 末尾，之前的行原样留着，注意力直接读它们。cache 随生成线性增长，每一步多 ${perToken} 字节；注意力要读的行也每步多一行，所以每步的 FLOPs 从 ${steps[0].flops} 涨到 ${at24.flops}。到第 ${at24.pos} 个位置，cache 里已经存着「${T.decode(seq.slice(0, at24.pos + 1)).trim()}」。`,
      facts: [['每步', `+${perToken} 字节`], ['每步 FLOPs', `${steps[0].flops} → ${at24.flops}`], ['cache', `${(at24.pos + 1) * perToken} 字节`]],
      events: [
        show('out'),
        pk('gpu', 'out', 'amber', `「${labelOf(firstToken)}」`, ['预填充选出'], [prefillFlops, 'SAMPLE', `预填充最后一个位置选出「${labelOf(firstToken)}」`, 4],
          wire('第一个 token', 'mem', 'format', tokenIds('token', [firstToken], { labels: labelOf, color: 'amber' })),
          { ds: { out: [outRow(1)] } }),
        ...detailed.flatMap((s) => [kvState(s.pos + 1, s.total), appendPacket(s)]),
        ...middle,
        kvState(at24.pos + 1, at24.total),
      ],
    },
    {
      title: '不用 cache 会怎样',
      desc: `同样生成 ${COMPARE_TOKENS} 个 token：${withCache.meter.total} 对 ${noCache.meter.total} FLOPs`,
      detail: `不存 K、V 也能生成，只是每一步都要把整个序列从头算一遍：第 t 步重算 ${N} + t 个位置。两种做法选出的 token 完全相同，带 cache 共 ${withCache.meter.total} FLOPs，不带 cache 要 ${noCache.meter.total}，是 ${(noCache.meter.total / withCache.meter.total).toFixed(1)} 倍。差距随长度平方增长，所以真实引擎都用 KV cache，用显存换计算。`,
      facts: [['带 cache', `${withCache.meter.total} FLOPs`], ['不带 cache', `${noCache.meter.total} FLOPs`], ['输出', withCache.tokens.join() === noCache.tokens.join() ? '逐个 token 相同' : '不同']],
      events: [
        pk('tokens', 'gpu', 'slate', '从头重算', [`每步 ${N} + t 个位置`, `共 ${noCache.meter.total} FLOPs`], [at24.total, 'MATMUL', `对照：不带 cache 生成 ${COMPARE_TOKENS} 个 token 要 ${noCache.meter.total} FLOPs，带 cache 只要 ${withCache.meter.total}`, null],
          wire('带 cache 和不带 cache', 'vals', '示意', conceptOf('生成同样的 token', [
            ['带 cache', `${withCache.meter.total} FLOPs`, '每步只算 1 个新位置，读 cache 里的 K、V。'],
            ['不带 cache', `${noCache.meter.total} FLOPs`, '每步把整个序列重算一遍，第 t 步算 N + t 个位置。'],
            ['倍数', `${(noCache.meter.total / withCache.meter.total).toFixed(1)}×`],
            ['输出', T.decode(noCache.tokens).trim(), '两种做法逐个 token 相同（tests/model.test.ts 保证 logits 逐位相同）。'],
          ])),
          { ds: { kv: [kvGrid(at24.pos + 1, [], 'all')] } }),
        note('gpu', `不带 cache：${(noCache.meter.total / withCache.meter.total).toFixed(1)} 倍 FLOPs`, 'amber'),
        pk('kv', 'gpu', 'teal', '读 cache', [`${at24.pos + 1} 行`], [at24.total, 'KV', `带 cache 时注意力直接读这 ${at24.pos + 1} 行，不用重算`, (at24.pos + 1) * perToken],
          wire('注意力读的 cache（全部行）', 'mem', 'internal', kvLayer('kv', cache, 0, at24.pos + 1)),
          { ds: { kv: [kvGrid(at24.pos + 1)] } }),
      ],
    },
    {
      title: '窗口放满',
      desc: `${C.maxSeq} 个位置，${windowBytes} 字节，再多一个就放不下`,
      detail: `继续生成到第 ${last.pos} 个位置，cache 的 ${C.maxSeq} 个槽全部用完，共 ${windowBytes} 字节。这时再把「${labelOf(last.token)}」送进模型，forward 直接报错：${overflowError}。迷你模型的窗口是硬上限，真实模型除了训练时的位置范围，更直接的限制是这块显存放不放得下。`,
      facts: [['位置', `${C.maxSeq} / ${C.maxSeq}`], ['cache', `${windowBytes} 字节`], ['生成', `${generated.length} 个 token`]],
      events: [
        ...tail,
        kvState(C.maxSeq, last.total),
        pk('gpu', 'kv', 'amber', `位置 ${C.maxSeq}？`, ['没有空槽'], [last.total, 'ALLOC', `「${labelOf(last.token)}」要写进位置 ${C.maxSeq}，forward 报错「${overflowError}」`, null],
          wire('超出上下文窗口', 'vals', '示意', conceptOf('forward 抛出的错误', [['错误', overflowError], ['cache.free', String(cache.free)], ['已生成', T.decode(generated).trim()]])),
          { lost: true }),
        render,
      ],
    },
    {
      title: `换成 ${L3.name}`,
      desc: `每 token ${bytesText(llama.perToken)}，${LLAMA31_CONTEXT / 1024}K 上下文 ${bytesText(llama.context128k)}`,
      detail: `${L3.name} 有 ${L3.layers} 层，用 GQA 让 ${L3.heads} 个查询头共享 ${L3.kvHeads} 个 KV 头，head_dim ${L3.headDim}：2 × ${L3.layers} × ${L3.kvHeads} × ${L3.headDim} × 2 字节 = ${bytesText(llama.perToken)}，${L3.context} 个位置就是 ${bytesText(llama.context8k)}。上下文扩到 ${LLAMA31_CONTEXT} 的 Llama 3.1 8B 形状相同，一个满长度的请求要 ${bytesText(llama.context128k)}，fp16 权重本身也才 ${bytesText(llama.weights)}。要是 ${L3.heads} 个头各存一份 K、V，每 token ${bytesText(llama.noGqa)}，一个满长度请求加上权重就${llama.noGqaFits ? '刚好' : '放不进'} 80 GB 显存。`,
      facts: [['每 token', `${bytesText(llama.perToken)}（GQA ${L3.kvHeads} 个 KV 头）`], [`${L3.context} 位置`, bytesText(llama.context8k)], [`${LLAMA31_CONTEXT} 位置`, bytesText(llama.context128k)], ['不用 GQA', `${bytesText(llama.noGqa)} / token`]],
      events: [
        state('gpu', { 'cache 位置': null, 'cache 字节': null, FLOPs: null, 显存: '80 GB（示例）' }),
        pk('kv', 'gpu', 'slate', L3.name, [`${bytesText(llama.perToken)} / token`], [last.total, 'ALLOC', `${L3.name}：2 × ${L3.layers} × ${L3.kvHeads} × ${L3.headDim} × 2 = ${llama.perToken} 字节 / token`, null],
          wire(`${L3.name} 的 KV cache 显存账`, 'vals', '示意', conceptOf(`${L3.name} · fp16`, [
            ['每 token', `${llama.perToken} 字节`, `2 × ${L3.layers} 层 × ${L3.kvHeads} 个 KV 头 × ${L3.headDim} × 2 字节。`],
            [`× ${L3.context}`, bytesText(llama.context8k), 'Llama 3 8B 的上下文窗口。'],
            [`× ${LLAMA31_CONTEXT}`, bytesText(llama.context128k), 'Llama 3.1 8B 的上下文窗口，形状相同。'],
            ['权重', bytesText(llama.weights), `${paramsOf(L3).total} 个参数 × 2 字节。`],
            ['80 GB 还能放', `${llama.fit80} 个位置`, '放下权重后剩下的显存全给 KV cache（示例，不计激活和碎片）。', true],
          ])),
          { ds: { kv: [memTower([['w', `权重 ${bytesText(llama.weights)}`, 'blue'], ['k8', `KV 8K ${bytesText(llama.context8k)}`, 'teal'], ['k128', `KV 128K ${bytesText(llama.context128k)}`, 'amber']])] } }),
        note('kv', `${LLAMA31_CONTEXT / 1024}K 上下文的 cache 比权重还大`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '上下文窗口是一笔显存账',
    desc: `每 token ${bytesText(llama.perToken)}，越长越贵`,
    text: `KV cache 用显存换掉了重复计算，代价是它随上下文线性增长，而且每个请求各有一份。显存装不下更长的 cache，或者装不下更多并发请求，就是长上下文贵的根本原因；GQA、KV cache 量化都是在压这笔账。很多请求的开头其实一模一样（同一段系统提示），它们的 K、V 也完全相同，下一课看推理引擎怎样只算一次、让后面的请求直接复用。`,
    facts: [['迷你模型', `${perToken} 字节 / token`], [L3.name, `${bytesText(llama.perToken)} / token`], ['下一课', '前缀缓存（Prompt Caching 原理）']],
  },
};
