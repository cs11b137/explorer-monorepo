/**
 * 推理组第一课：预填充与解码。真实执行一次 8 个位置的预填充和 3 步增量解码，
 * FLOPs 取自 forward 的 FlopMeter，读权重的字节数按权重形状数出来（engine/roofline.ts），
 * 再用同一套公式外推到 Llama 3 8B。tests/narrative.infer.test.ts 核对文案。
 */
import { floatMatrix, floatVector, tokenIds, wire } from '../decode/structures';
import { archOf, forwardFlops, H100, LLAMA3_8B, miniWeightBytesRead, paramsOf, ridgePoint, roofline, weightBytesRead } from '../engine/roofline';
import { MODEL } from '../model';
import { argmax, FlopMeter } from '../model/tensor';
import { decodeStep, forward, KVCache, lastLogits } from '../model/transformer';
import { cellsOf, shortLabel } from './common';
import { ds, note, pk, render, show, state, type } from './dsl';
import { conceptOf, flopsText, FP16_BYTES, kvLayer, labelOf, msText, PROMPT, PROMPT_IDS, ratioText } from './infer-common';
import type { DsCell, GridPrim, Lesson, LessonEvent, RowPrim } from './types';

const W = MODEL;
const C = W.config;
const N = PROMPT_IDS.length;
/** 解码几步。 */
export const DECODE_STEPS = 3;

// ---------- 真实运行 ----------

const meter = new FlopMeter();
const cache = new KVCache(C);
const prefillTrace = forward(W, PROMPT_IDS, { cache, meter, lastLogitsOnly: true });
export const prefillFlops = meter.total;
export const prefillBy = { ...meter.by };
const firstLogits = lastLogits(prefillTrace);
export const firstToken = argmax(firstLogits);
const prefillCache = cache.clone();

export interface DecodeRecord {
  pos: number;
  input: number;
  token: number;
  flops: number;
  /** 到这一步为止的累计 FLOPs。 */
  total: number;
  hidden: number[];
}
export const decodes: DecodeRecord[] = [];
{
  let input = firstToken;
  for (let i = 0; i < DECODE_STEPS; i++) {
    const before = meter.total;
    const pos = cache.length;
    const trace = decodeStep(W, cache, input, meter);
    const token = argmax(trace.logits);
    decodes.push({ pos, input, token, flops: meter.total - before, total: meter.total, hidden: trace.embed });
    input = token;
  }
}
const generated = [firstToken, ...decodes.map((d) => d.token)];

// ---------- 账本：读权重的字节数和算术强度 ----------

const arch = archOf(C);
const params = paramsOf(arch);
/** 一次前向读的权重字节（fp16）。 */
export const prefillBytes = miniWeightBytesRead(W, N, FP16_BYTES);
export const decodeBytes = miniWeightBytesRead(W, 1, FP16_BYTES);
/** 只看 Transformer 层：矩阵 + RMSNorm 的 γ。 */
const layerBytes = C.nLayers * (params.layerMatmul + params.layerNorm) * FP16_BYTES;
const lmHeadBytes = params.lmHead * FP16_BYTES;
export const prefillLayerFlops = prefillFlops - prefillBy.lmhead;
export const decodeLayerFlops = decodes[0].flops - 2 * params.lmHead;
export const intensity = {
  prefill: prefillFlops / prefillBytes,
  decode: decodes[0].flops / decodeBytes,
  prefillLayers: prefillLayerFlops / layerBytes,
  decodeLayers: decodeLayerFlops / layerBytes,
  lmHead: (2 * params.lmHead) / lmHeadBytes,
};
/** 不只算最后一个位置的 logits 时，输出层多花的 FLOPs。 */
export const lmHeadSaved = (N - 1) * 2 * params.lmHead;

// ---------- 外推：Llama 3 8B 在 H100 上的理论下限 ----------

export const REAL_PROMPT = 1000;
const L3 = LLAMA3_8B;
export const real = (() => {
  const p = paramsOf(L3);
  const pf = forwardFlops(L3, 0, REAL_PROMPT);
  const pb = weightBytesRead(L3, REAL_PROMPT, FP16_BYTES);
  const df = forwardFlops(L3, REAL_PROMPT, 1);
  const db = weightBytesRead(L3, 1, FP16_BYTES);
  return { params: p, prefill: { flops: pf.total, bytes: pb, roof: roofline(pf.total, pb, H100) }, decode: { flops: df.total, bytes: db, roof: roofline(df.total, db, H100) }, ridge: ridgePoint(H100) };
})();
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const tokensPerSecond = Math.floor(1 / real.decode.roof.time);

// ---------- 图元 ----------

const promptLabels = PROMPT_IDS.map(labelOf);
const tokensRow = (lift: number[] = []): RowPrim => ({ kind: 'row', id: 't', w: 40, cells: cellsOf(PROMPT_IDS.map((id) => shortLabel(id, 5)), { subs: PROMPT_IDS.map(String), rest: 'blue', lift }) });

/** 隐藏状态：预填充时是 N × d 的矩阵，解码时只有 1 行。热度是 |x| 的相对大小，数值在检查器里。 */
function hiddenGrid(rows: number[][], labels: string[], tone: 'blue' | 'amber'): GridPrim {
  const max = Math.max(...rows.flat().map(Math.abs));
  return {
    kind: 'grid',
    id: 'x',
    w: 24,
    rows: labels.map((label) => [...label].slice(0, 4).join('')),
    cols: Array.from({ length: C.dModel }, (_, i) => String(i)),
    cells: rows.map((row) => row.map((value): DsCell => ({ v: ' ', tone, heat: Math.abs(value) / max }))),
  };
}

const KV_SLOTS = N + DECODE_STEPS;
function kvRow(filled: number, fresh: number[] = []): RowPrim {
  const labels = [...PROMPT_IDS, ...generated].slice(0, filled).map((id) => shortLabel(id, 4));
  return {
    kind: 'row',
    id: 'kv',
    axis: 'y',
    w: 44,
    d: 30,
    cells: cellsOf(Array.from({ length: KV_SLOTS }, (_, i) => (i < filled ? labels[i] : null)), { tones: Object.fromEntries(Array.from({ length: filled }, (_, i) => [i, i < N ? 'teal' : 'amber'])), lift: fresh }),
  };
}

function outRow(count: number, fresh?: number): RowPrim {
  return { kind: 'row', id: 'o', w: 44, cells: cellsOf(Array.from({ length: DECODE_STEPS + 1 }, (_, i) => (i < count ? shortLabel(generated[i], 5) : null)), { rest: 'amber', lift: fresh === undefined ? [] : [fresh] }) };
}

const compareGrid: GridPrim = {
  kind: 'grid',
  id: 'c',
  w: 64,
  rows: [`预填充 ${N}`, '解码 1'],
  cols: ['FLOPs', '读权重', '比值'],
  cells: [
    [{ v: String(prefillFlops) }, { v: `${prefillBytes} B` }, { v: intensity.prefill.toFixed(2), tone: 'green' }],
    [{ v: String(decodes[0].flops) }, { v: `${decodeBytes} B` }, { v: intensity.decode.toFixed(2), tone: 'amber' }],
  ],
};

const realGrid: GridPrim = {
  kind: 'grid',
  id: 'r',
  w: 72,
  rows: [`预填充 ${REAL_PROMPT}`, '解码 1'],
  cols: ['FLOPs', '读权重', '下限'],
  cells: [
    [{ v: flopsText(real.prefill.flops).replace('FLOPs', '') }, { v: gb(real.prefill.bytes) }, { v: msText(real.prefill.roof.time), tone: 'green' }],
    [{ v: flopsText(real.decode.flops).replace('FLOPs', '') }, { v: gb(real.decode.bytes) }, { v: msText(real.decode.roof.time), tone: 'amber' }],
  ],
};

// ---------- 字节层 ----------

const weightsConcept = (n: number, bytes: number) =>
  conceptOf(`一次前向读的权重 · ${bytes} 字节（fp16）`, [
    ['每层矩阵', `${C.nLayers} 层 × ${params.layerMatmul} 个`, 'Q、K、V、O 和 SwiGLU 的 gate、up、down，整块读一遍：每个输出都要用到矩阵的一整行。'],
    ['RMSNorm γ', `${C.nLayers} 层 × ${params.layerNorm} 个 + ${params.finalNorm} 个`],
    ['输出层', `${params.lmHead} 个`, `vocab ${C.vocab} × d ${C.dModel}，整块读一遍。`],
    ['嵌入表', `${n} 行 × ${C.dModel} 个`, '只读用到的那几行。'],
    ['合计', `${bytes / FP16_BYTES} 个 × 2 字节`, n > 1 ? `不管这次处理几个位置，矩阵都只读一遍。` : '每生成一个 token，整份矩阵都要再读一遍。'],
  ], 'slate', '按真实部署常用的 fp16 计（本站计算用 fp32）');

const gpuState = (phase: string, positions: string, flops: number, bytes: number): LessonEvent => state('gpu', { 阶段: phase, 位置: positions, FLOPs: String(flops), 读权重: `${bytes} B` });

// ---------- 事件 ----------

function decodeEvents(d: DecodeRecord, index: number): LessonEvent[] {
  const filled = d.pos + 1;
  return [
    gpuState('解码', `第 ${d.pos} 个`, d.total, decodeBytes),
    pk('out', 'gpu', 'amber', `喂回「${labelOf(d.input)}」`, [`位置 ${d.pos}`, '只有 1 个新位置'], [d.total - d.flops, 'IDS', `上一步选出的「${labelOf(d.input)}」作为位置 ${d.pos} 的输入`, 4],
      wire('解码这一步的输入：1 个 token', 'mem', 'format', tokenIds('input', [d.input], { labels: labelOf, color: 'amber' })),
      { ds: { hidden: [hiddenGrid([d.hidden], [labelOf(d.input)], 'amber')] } }),
    pk('weights', 'gpu', 'slate', '再读一遍权重', [`${decodeBytes} 字节`, `只换来 ${d.flops} FLOPs`], [d.total - d.flops, 'LOAD', `为 1 个位置把全部矩阵再读一遍：${decodeBytes} 字节`, decodeBytes],
      wire('解码一步要读的权重', 'vals', '示意', weightsConcept(1, decodeBytes))),
    pk('gpu', 'kv', 'amber', '追加 1 行', [`位置 ${d.pos}`, `${2 * C.nLayers * C.dModel * FP16_BYTES} 字节`], [d.total, 'KV', `位置 ${d.pos} 的 K、V 追加进 cache；注意力读了前面 ${d.pos} 行`, 2 * C.nLayers * C.dModel * FP16_BYTES],
      wire('新写入的一行 KV cache', 'mem', 'internal', kvLayer('kv', cache, d.pos, d.pos + 1, { color: 'amber' })),
      { ds: { kv: [kvRow(filled, [d.pos])] } }),
    pk('gpu', 'out', 'amber', `「${labelOf(d.token)}」`, [`本步 ${d.flops} FLOPs`], [d.total, 'SAMPLE', `第 ${index + 2} 个 token「${labelOf(d.token)}」，这一步 ${d.flops} FLOPs`, 4],
      wire('选出的 token', 'mem', 'format', tokenIds('next', [d.token], { labels: labelOf, color: 'amber' })),
      { ds: { out: [outRow(index + 2, index + 1)] } }),
  ];
}

export const prefill: Lesson = {
  id: 'prefill',
  name: 'PREFILL & DECODE',
  title: '预填充与解码',
  group: 'infer',
  layer: [5, 6],
  layerNote: '模型层的矩阵乘怎样被推理引擎分成预填充和解码两种形态。',
  opsUnit: 'FLOPs：只计乘加，每次乘加算 2 次（矩阵乘、注意力的点积和加权求和），由 FlopMeter 累计',
  opsShort: 'FLOPs',
  nodes: ['client', 'tokens', 'gpu', 'weights', 'hidden', 'kv', 'out'],
  place: { client: [170, 90], tokens: [190, 420], gpu: [570, 300], weights: [960, 150], hidden: [570, 620], kv: [960, 500], out: [570, 40] },
  labels: {
    client: ['应用', '发出提示词，等第一个 token'],
    tokens: ['提示词', `${N} 个 token`],
    gpu: ['GPU', '算矩阵乘，读显存里的权重'],
    weights: ['权重', `${params.total} 个参数，按 fp16 计 ${params.total * FP16_BYTES} 字节`],
    hidden: ['隐藏状态', '这一次前向要算的位置'],
    kv: ['KV cache', '每个位置一行'],
    out: ['输出', '生成的 token'],
  },
  labelAt: { tokens: [-150, 40], hidden: [-290, 0], kv: [130, 80], out: [150, -20] },
  radius: { tokens: 60, hidden: 120, kv: 60, out: 75 },
  initial: { tokens: [], hidden: [], kv: [], out: [] },
  start: ['client', 'tokens', 'gpu'],
  legend: [['blue', '预填充：整段提示词'], ['amber', '解码：一次一个 token'], ['teal', '写进 KV cache 的位置'], [null, '运算量：累计 FLOPs']],
  overview: {
    full: '为什么第一个 token 慢、后面的 token 快却省不下来',
    description: `生成分两段：预填充一次把整段提示词送进模型，解码每次只算 1 个新 token。这一课真实运行迷你模型：「${PROMPT}」的 ${N} 个 token 一次前向花 ${prefillFlops} FLOPs，之后每步约 ${decodes[0].flops} FLOPs。两段读的权重几乎一样多，所以每读 1 个字节能做的计算差了好几倍：预填充受算力限制，解码受显存带宽限制。`,
    facts: [
      ['模型', `迷你 LLaMA：${C.nLayers} 层，d ${C.dModel}，${params.total} 个参数`],
      ['提示词', `「${PROMPT}」，${N} 个 token`],
      ['预填充', `${prefillFlops} FLOPs`],
      ['解码一步', `${decodes[0].flops}–${decodes[DECODE_STEPS - 1].flops} FLOPs`],
      ['外推', `${L3.name} @ ${H100.name}`],
      ['运算量', '累计 FLOPs'],
    ],
  },
  steps: [
    {
      title: '预填充：整段一起算',
      desc: `${N} 个位置一次前向，${prefillFlops} FLOPs`,
      detail: `提示词的 ${N} 个 token 已经全部知道，可以在一次前向里并行处理：隐藏状态是 ${N} × ${C.dModel} 的矩阵，每个权重矩阵乘的是矩阵而不是向量。这次前向读一遍权重（按 fp16 计 ${prefillBytes} 字节），做了 ${prefillFlops} FLOPs，同时把 ${N} 个位置的 K、V 写进 cache。FFN 占了 ${prefillBy.ffn} FLOPs，是最大的一块。`,
      facts: [['矩阵乘', `${N} × ${C.dModel} 的矩阵 × 权重`], ['FLOPs', `QKV ${prefillBy.qkv} · 注意力 ${prefillBy.score + prefillBy.mix} · O ${prefillBy.wo} · FFN ${prefillBy.ffn} · 输出层 ${prefillBy.lmhead}`], ['读权重', `${prefillBytes} 字节`]],
      events: [
        type(`generate("${PROMPT}")`),
        pk('client', 'tokens', 'blue', 'input_ids', [`${N} 个 token`], [0, 'IDS', `提示词编码成 ${N} 个 token：${promptLabels.join(' ')}`, N * 4],
          wire('提示词的 token id', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: labelOf })),
          { ds: { tokens: [tokensRow()] } }),
        show('weights', 'hidden'),
        pk('tokens', 'gpu', 'blue', `${N} 个一起送`, [`${N} 个位置`, '一次前向'], [0, 'IDS', `${N} 个位置同时进入同一次前向`, N * 4],
          wire('预填充的输入', 'mem', 'format', tokenIds('batch', PROMPT_IDS, { labels: labelOf })),
          { ds: { tokens: [tokensRow(PROMPT_IDS.map((_, i) => i))] } }),
        pk('weights', 'gpu', 'slate', '读一遍权重', [`${prefillBytes} 字节`], [0, 'LOAD', `整份矩阵读一遍，${N} 个位置共用：${prefillBytes} 字节`, prefillBytes],
          wire('预填充要读的权重', 'vals', '示意', weightsConcept(N, prefillBytes))),
        gpuState('预填充', `0–${N - 1}`, prefillFlops, prefillBytes),
        pk('gpu', 'hidden', 'blue', `${N} × ${C.dModel} 矩阵`, [`${prefillFlops} FLOPs`], [prefillFlops, 'MATMUL', `${N} 个位置一起过 ${C.nLayers} 层：${prefillFlops} FLOPs，其中 FFN ${prefillBy.ffn}`, N * C.dModel * 4],
          wire('进入第 0 层的隐藏状态（嵌入）', 'mem', 'format', floatMatrix('x', prefillTrace.positions.map((p) => p.embed), 'f32', { rowNames: (r) => `x[${r}]「${promptLabels[r]}」`, summary: `${N} 行，每行一个位置` })),
          { ds: { hidden: [hiddenGrid(prefillTrace.positions.map((p) => p.embed), promptLabels, 'blue')] } }),
        show('kv'),
        pk('gpu', 'kv', 'teal', `写入 ${N} 行`, [`${N} × ${2 * C.nLayers * C.dModel * FP16_BYTES} 字节`], [prefillFlops, 'KV', `${N} 个位置每层的 K、V 写进 cache`, N * 2 * C.nLayers * C.dModel * FP16_BYTES],
          wire('预填充写入的 KV cache', 'mem', 'internal', kvLayer('kv', prefillCache, 0, N, { labels: (pos) => `${pos}「${promptLabels[pos]}」` })),
          { ds: { kv: [kvRow(N)] } }),
      ],
    },
    {
      title: '第一个 token：TTFT',
      desc: `只有最后一个位置算 logits，选出「${labelOf(firstToken)}」`,
      detail: `预填充结束时，最后一个位置的输出层给出 ${C.vocab} 个 logits，取最大的得到第一个 token「${labelOf(firstToken)}」。前 ${N - 1} 个位置的 logits 没人要，引擎跳过它们的输出层，省下 ${lmHeadSaved} FLOPs。从请求发出到第一个 token 到达的时间叫 TTFT（time to first token），主要就是排队加这次预填充，提示词越长越久。`,
      facts: [['第一个 token', `「${labelOf(firstToken)}」（id ${firstToken}）`], ['跳过的输出层', `${N - 1} 个位置 × ${2 * params.lmHead} FLOPs`], ['TTFT', '排队 + 预填充 + 第一次采样']],
      events: [
        show('out'),
        pk('gpu', 'out', 'blue', `「${labelOf(firstToken)}」`, [`logits[${C.vocab}] → argmax`], [prefillFlops, 'LOGITS', `只算最后一个位置的输出层，argmax 得到 token ${firstToken}「${labelOf(firstToken)}」`, 4],
          wire('最后一个位置的 logits（开头 8 个）和选中的 token', 'mem', 'format',
            floatVector('logits', firstLogits.slice(0, 8), 'f32', { names: (i) => `logits[${i}]「${labelOf(i)}」`, summary: `共 ${C.vocab} 个，这里只列开头几个` }),
            tokenIds('first', [firstToken], { labels: labelOf, color: 'amber', summary: `logits[${firstToken}] = ${firstLogits[firstToken].toFixed(3)}，最大` })),
          { ds: { out: [outRow(1, 0)] } }),
        pk('out', 'client', 'amber', '第一个 token', [`「${labelOf(firstToken)}」`], [prefillFlops, 'STREAM', `第一个 token 到达应用：TTFT 到此为止`, 4],
          wire('流式返回的第一个 token', 'mem', 'format', tokenIds('token', [firstToken], { labels: labelOf, color: 'amber' }))),
        note('client', 'TTFT：等到这里', 'amber'),
      ],
    },
    {
      title: '解码：一次一个 token',
      desc: `每步 ${decodes[0].flops}–${decodes[DECODE_STEPS - 1].flops} FLOPs，却要读 ${decodeBytes} 字节`,
      detail: `下一个 token 依赖上一个，所以解码只能一步一个位置：隐藏状态只有 1 行，矩阵乘退化成矩阵乘向量。每一步都要把整份矩阵从显存再读一遍（${decodeBytes} 字节），只换来约 ${decodes[0].flops} FLOPs，注意力从 cache 里读之前的 K、V，所以每步比上一步多 ${decodes[1].flops - decodes[0].flops} FLOPs。相邻两个 token 之间的时间就是每 token 延迟（TPOT），它主要由「读一遍权重要多久」决定。`,
      facts: [['生成', generated.map((id) => `「${labelOf(id)}」`).join(' ')], ['每步 FLOPs', decodes.map((d) => String(d.flops)).join(' → ')], ['每步读权重', `${decodeBytes} 字节`]],
      events: decodes.flatMap(decodeEvents),
    },
    {
      title: '算术强度：每字节算几次',
      desc: `预填充 ${intensity.prefill.toFixed(2)}，解码 ${intensity.decode.toFixed(2)} FLOPs / 字节`,
      detail: `算术强度 = FLOPs ÷ 读的字节数。预填充 ${N} 个位置共用一次权重读取，强度 ${intensity.prefill.toFixed(2)}；解码每读 1 字节只算 ${intensity.decode.toFixed(2)} 次。只看 ${C.nLayers} 个 Transformer 层差得更多（${intensity.prefillLayers.toFixed(2)} 对 ${intensity.decodeLayers.toFixed(2)}），输出层两边都只算 1 个位置，强度都是 ${intensity.lmHead.toFixed(2)}，拉近了总数。`,
      facts: [['预填充', `${prefillFlops} ÷ ${prefillBytes} = ${intensity.prefill.toFixed(2)}`], ['解码', `${decodes[0].flops} ÷ ${decodeBytes} = ${intensity.decode.toFixed(2)}`], ['只看层', `${intensity.prefillLayers.toFixed(2)} 对 ${intensity.decodeLayers.toFixed(2)}`]],
      events: [
        state('gpu', { 阶段: '对比', 位置: null, FLOPs: `${ratioText(prefillFlops, prefillBytes)} / ${ratioText(decodes[0].flops, decodeBytes)}`, 读权重: null }),
        pk('gpu', 'hidden', 'green', 'FLOPs ÷ 字节', [`预填充 ${intensity.prefill.toFixed(2)}`, `解码 ${intensity.decode.toFixed(2)}`], [decodes[DECODE_STEPS - 1].total, 'MATMUL', `预填充 ${prefillFlops} ÷ ${prefillBytes} = ${intensity.prefill.toFixed(2)}，解码 ${decodes[0].flops} ÷ ${decodeBytes} = ${intensity.decode.toFixed(2)}`, null],
          wire('算术强度', 'vals', '示意', conceptOf('FLOPs ÷ 读权重字节', [
            ['预填充', `${prefillFlops} ÷ ${prefillBytes} = ${intensity.prefill.toFixed(2)}`, `${N} 个位置共用一次权重读取。`],
            ['解码一步', `${decodes[0].flops} ÷ ${decodeBytes} = ${intensity.decode.toFixed(2)}`, '每读 1 个权重（2 字节）只做 1 次乘加。'],
            ['Transformer 层', `${intensity.prefillLayers.toFixed(2)} 对 ${intensity.decodeLayers.toFixed(2)}`, '矩阵部分的强度随位置数线性增长。'],
            ['输出层', `${intensity.lmHead.toFixed(2)} 对 ${intensity.lmHead.toFixed(2)}`, '两边都只为最后一个位置算 logits。'],
          ]))),
        ds({ hidden: [compareGrid] }),
        note('hidden', '解码：每读 2 字节只做 1 次乘加', 'amber'),
      ],
    },
    {
      title: '换到真实规模',
      desc: `${L3.name}：预填充 ${msText(real.prefill.roof.time)}，解码每 token ${msText(real.decode.roof.time)}`,
      detail: `同一套公式套到 ${L3.name}（${(real.params.total / 1e9).toFixed(2)}B 参数，fp16 约 ${gb(real.params.total * FP16_BYTES)}）：${REAL_PROMPT} 个 token 的预填充要 ${flopsText(real.prefill.flops)}，强度 ${Math.round(real.prefill.roof.intensity)}，高于 ${H100.name} 的拐点 ${Math.round(real.ridge)}，算力是瓶颈，理论下限 ${msText(real.prefill.roof.time)}。解码一步只有 ${flopsText(real.decode.flops)}，强度约 ${real.decode.roof.intensity.toFixed(2)}，时间几乎全花在读 ${gb(real.decode.bytes)} 权重上，下限 ${msText(real.decode.roof.time)}，也就是单个请求每秒最多约 ${tokensPerSecond} 个 token。这些是 roofline 估出的下限，真实时间还要加上调度、kernel 启动和读 KV cache 的开销。`,
      facts: [['GPU（规格表）', `${H100.flops / 1e12} TFLOPS · ${H100.bandwidth / 1e12} TB/s`], ['拐点', `${Math.round(real.ridge)} FLOPs / 字节`], ['预填充', `强度 ${Math.round(real.prefill.roof.intensity)} · 算力受限`], ['解码', `强度 ${real.decode.roof.intensity.toFixed(2)} · 访存受限`]],
      events: [
        state('gpu', { 阶段: H100.name, 位置: null, FLOPs: `${H100.flops / 1e12} TFLOPS`, 读权重: `${H100.bandwidth / 1e12} TB/s` }),
        pk('weights', 'gpu', 'slate', L3.name, [`${(real.params.total / 1e9).toFixed(2)}B 参数`, gb(real.params.total * FP16_BYTES)], [decodes[DECODE_STEPS - 1].total, 'LOAD', `${L3.name}：${L3.layers} 层，d ${L3.dModel}，FFN ${L3.ffn}，词表 ${L3.vocab}`, null],
          wire(`${L3.name} 的一次前向`, 'vals', '示意', conceptOf(`${L3.name} @ ${H100.name}（roofline 下限）`, [
            ['参数', `${real.params.total}`, `每层矩阵 ${real.params.layerMatmul} 个 × ${L3.layers} 层 + 嵌入表和输出层各 ${real.params.embed} 个。`],
            [`预填充 ${REAL_PROMPT} 个`, `${flopsText(real.prefill.flops)} · 读 ${gb(real.prefill.bytes)}`],
            ['预填充下限', `算 ${msText(real.prefill.roof.compute)} · 读 ${msText(real.prefill.roof.memory)}`, '两者取大：算力受限。真实时间依硬件和实现而变。', true],
            ['解码一步', `${flopsText(real.decode.flops)} · 读 ${gb(real.decode.bytes)}`],
            ['解码下限', `算 ${msText(real.decode.roof.compute)} · 读 ${msText(real.decode.roof.memory)}`, '两者取大：访存受限。', true],
          ]))),
        ds({ hidden: [realGrid] }),
        note('gpu', `拐点 ${Math.round(real.ridge)} FLOPs / 字节`),
        render,
      ],
    },
  ],
  outro: {
    title: '解码的瓶颈在显存带宽',
    desc: `预填充算力受限，解码访存受限`,
    text: `预填充决定 TTFT，解码决定每 token 延迟。解码每一步都要为 1 个 token 读一遍全部权重，所以推理引擎想方设法让一次读取服务更多 token：把多个请求拼成一批一起解码（连续批处理），把权重压成更少的字节（量化）。解码还要读之前所有位置的 K、V，提示词越长这部分越大，下一课专门算这笔显存账。`,
    facts: [['预填充', `${prefillFlops} FLOPs / ${prefillBytes} 字节`], ['解码一步', `${decodes[0].flops} FLOPs / ${decodeBytes} 字节`], ['下一课', 'KV cache 增长与上下文窗口上限']],
  },
};
