/**
 * 推理组第五课：量化。把迷你模型各层的真实权重矩阵从 fp16 量化成 GGUF 的 Q8_0 和 Q4_0，
 * 逐字节解码一块（numeric.ts 的实现和 ggml 官方 gguf-py 逐字节核对过），算误差和体积，
 * 再用量化后的权重真实跑一遍生成，比较 logits 和贪心输出。tests/narrative.infer.test.ts 核对文案。
 */
import { floatVector, q4_0Block, q8_0Block, tokenIds, wire } from '../decode/structures';
import { LLAMA3_8B, paramsOf } from '../engine/roofline';
import { MODEL, TOKENIZER } from '../model';
import { BYTES_PER_WEIGHT, dequantizeQ4_0, dequantizeQ8_0, f16FromBits, f16Round, QK, quantizeQ4_0, quantizeQ8_0, roundTrip, type Format } from '../model/numeric';
import { argmax, type Mat } from '../model/tensor';
import { cloneWeights } from '../model/train';
import { forward, generate, lastLogits, LAYER_TENSORS, type Weights } from '../model/transformer';
import { cellsOf, num, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { conceptOf, labelOf, PROMPT, PROMPT_IDS } from './infer-common';
import type { DsCell, GridPrim, Lesson, LessonEvent, RowPrim } from './types';

const T = TOKENIZER;
const C = MODEL.config;

/** 量化哪些张量：各层的 7 个矩阵。嵌入表和输出层留在 fp16，RMSNorm 的 γ 留在 fp32（GGUF 里一维张量一般不量化）。 */
export const MATRICES = LAYER_TENSORS.filter((key) => Array.isArray(MODEL.layers[0][key][0]));
type MatKey = (typeof MATRICES)[number];

/** 按格式重写所有层矩阵：先存成 fp16，再按格式编码、解码回来。整个矩阵按行优先展开，每 32 个一块。 */
function weightsAs(format: Format): Weights {
  const W = cloneWeights(MODEL);
  for (const layer of W.layers) {
    for (const key of MATRICES) {
      const m = layer[key as MatKey] as Mat;
      const cols = m[0].length;
      const values = roundTrip(format, m.flat().map(f16Round));
      for (let r = 0; r < m.length; r++) for (let c = 0; c < cols; c++) m[r][c] = values[r * cols + c];
    }
  }
  return W;
}

/** 所有被量化的权重（fp16），按张量顺序拼起来。 */
const allValues = MODEL.layers.flatMap((layer) => MATRICES.flatMap((key) => (layer[key as MatKey] as Mat).flat().map(f16Round)));
export const WEIGHT_COUNT = allValues.length;
export const BLOCKS = WEIGHT_COUNT / QK;

// ---------- 演示用的一块：blk.0.attn_q.weight 的前 32 个数 ----------

export const TENSOR = 'blk.0.attn_q.weight';
const tensorRows = MODEL.layers[0].attn_q;
/** 第 0 块：attn_q 的第 0–3 行（每行 8 个数）。 */
export const blockValues = tensorRows.flat().slice(0, QK).map(f16Round);
export const q8 = quantizeQ8_0(blockValues)[0];
export const q4 = quantizeQ4_0(blockValues)[0];
const q8Back = dequantizeQ8_0([q8]);
const q4Back = dequantizeQ4_0([q4]);
export const q8d = f16FromBits(q8.d);
export const q4d = f16FromBits(q4.d);
const absmax = Math.max(...blockValues.map(Math.abs));
/** 绝对值最大的那个数（带符号）和它的下标。Q4_0 用它定 d，这个数正好落在 q = 0。 */
export const extremeIndex = blockValues.findIndex((v) => Math.abs(v) === absmax);

export interface ErrorStats {
  max: number;
  rms: number;
  /** 误差的 RMS ÷ 权重的 RMS。 */
  relative: number;
}
function errorStats(a: readonly number[], b: readonly number[]): ErrorStats {
  let max = 0;
  let sq = 0;
  let ref = 0;
  a.forEach((value, i) => {
    const e = Math.abs(value - b[i]);
    max = Math.max(max, e);
    sq += e * e;
    ref += value * value;
  });
  return { max, rms: Math.sqrt(sq / a.length), relative: Math.sqrt(sq / ref) };
}
export const blockError = { q8: errorStats(blockValues, q8Back), q4: errorStats(blockValues, q4Back) };
export const modelError = { q8: errorStats(allValues, roundTrip('q8_0', allValues)), q4: errorStats(allValues, roundTrip('q4_0', allValues)) };

// ---------- 体积 ----------

export const sizes = Object.fromEntries((['f16', 'q8_0', 'q4_0'] as const).map((f) => [f, Math.round(WEIGHT_COUNT * BYTES_PER_WEIGHT[f])])) as Record<'f16' | 'q8_0' | 'q4_0', number>;
const bitsPerWeight = (f: Format) => BYTES_PER_WEIGHT[f] * 8;
export const llama = (() => {
  const total = paramsOf(LLAMA3_8B).total;
  return { total, f16: total * 2, q8_0: total * BYTES_PER_WEIGHT.q8_0, q4_0: total * BYTES_PER_WEIGHT.q4_0 };
})();
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

// ---------- 真实运行：同一个提示词，三种权重 ----------

const GEN = C.maxSeq - PROMPT_IDS.length;
function runOn(W: Weights) {
  const result = generate(W, PROMPT_IDS, { maxTokens: GEN, stop: T.eos });
  return { ...result, logits: lastLogits(forward(W, PROMPT_IDS, { lastLogitsOnly: true })) };
}
export const runs = { f16: runOn(weightsAs('f16')), q8_0: runOn(weightsAs('q8_0')), q4_0: runOn(weightsAs('q4_0')) };
/** 和 fp16 相比，从第几个生成的 token 起不同（−1 表示全部相同）。 */
export const divergeAt = (format: 'q8_0' | 'q4_0') => runs[format].tokens.findIndex((id, i) => id !== runs.f16.tokens[i]);
export const logitDiff = (format: 'q8_0' | 'q4_0') => Math.max(...runs.f16.logits.map((v, i) => Math.abs(v - runs[format].logits[i])));
const q4At = divergeAt('q4_0');
const total = (key: keyof typeof runs) => runs[key].meter.total;
const opsAfter = { f16: total('f16'), q8_0: total('f16') + total('q8_0'), q4_0: total('f16') + total('q8_0') + total('q4_0') };

if (divergeAt('q8_0') !== -1 || q4At < 0) throw new Error('quant：Q8_0 应保持输出不变、Q4_0 应在某处分叉，文案按此写成');

// ---------- 图元 ----------

const COLS = 8;
/** 一块 32 个数排成 4 × 8：正好是 attn_q 的第 0–3 行。 */
function blockGrid(values: readonly number[], shown: (v: number, i: number) => string, heat: (v: number, i: number) => number, tone: 'blue' | 'teal' | 'amber', lift: number[] = []): GridPrim {
  return {
    kind: 'grid',
    id: 'b',
    w: 40,
    rows: Array.from({ length: QK / COLS }, (_, r) => `行${r}`),
    cols: Array.from({ length: COLS }, (_, c) => String(c)),
    cells: Array.from({ length: QK / COLS }, (_, r) => Array.from({ length: COLS }, (_, c): DsCell => {
      const i = r * COLS + c;
      return { v: shown(values[i], i), key: `w${i}`, tone, heat: heat(values[i], i), lift: lift.includes(i) || undefined };
    })),
  };
}
const f16Grid = blockGrid(blockValues, (v) => num(v, 2), (v) => Math.abs(v) / absmax, 'blue', [extremeIndex]);
const q8Grid = blockGrid(q8.qs, (q) => String(q), (q) => Math.abs(q) / 127, 'teal', [extremeIndex]);
const q4Grid = blockGrid(q4.q, (q) => String(q), (q) => Math.abs(q - 8) / 8, 'amber', [extremeIndex]);

const sizeGrid: GridPrim = {
  kind: 'grid',
  id: 's',
  w: 58,
  rows: ['fp16', 'Q8_0', 'Q4_0'],
  cols: ['字节', '位/权重', '相对误差'],
  cells: [
    [{ v: String(sizes.f16), tone: 'blue' }, { v: String(bitsPerWeight('f16')) }, { v: '—' }],
    [{ v: String(sizes.q8_0), tone: 'teal' }, { v: String(bitsPerWeight('q8_0')) }, { v: `${(modelError.q8.relative * 100).toFixed(2)}%` }],
    [{ v: String(sizes.q4_0), tone: 'amber' }, { v: String(bitsPerWeight('q4_0')) }, { v: `${(modelError.q4.relative * 100).toFixed(1)}%` }],
  ],
};

const SHOW = 6;
/** 输出：第 from 个 token 起的几个，分叉的那一格标出来。 */
function outRow(tokens: number[], from: number, tone: 'blue' | 'teal' | 'amber', diverge = -1): RowPrim {
  const ids = tokens.slice(from, from + SHOW);
  return {
    kind: 'row',
    id: 'o',
    w: 44,
    cells: cellsOf(ids.map((id) => shortLabel(id, 5)), { rest: tone, subs: ids.map((_, i) => String(from + i)), tones: diverge >= from ? { [diverge - from]: 'amber' } : {} }),
    marks: diverge >= from ? [{ at: diverge - from, text: '分叉', color: 'amber' }] : undefined,
  };
}
/** 输出行从分叉点前两格开始显示。 */
const OUT_FROM = Math.max(0, q4At - 2);

// ---------- 事件 ----------

const quantState = (format: string, bytes: string, err: string): LessonEvent => state('weights', { 格式: format, 本块: bytes, 最大误差: err });

export const quant: Lesson = {
  id: 'quant',
  name: 'QUANTIZATION',
  title: '量化（GGUF Q8_0 / Q4_0）',
  group: 'infer',
  layer: [1, 6],
  layerNote: '从量化块的每个字节，到模型层的权重，再到推理引擎加载和计算。',
  opsUnit: 'FLOPs：用 fp16、Q8_0、Q4_0 三份权重各生成一遍的累计乘加次数 × 2（量化本身不计）',
  opsShort: 'FLOPs',
  nodes: ['client', 'weights', 'attn', 'gpu', 'out'],
  place: { client: [170, 90], weights: [560, 110], attn: [520, 480], gpu: [980, 380], out: [980, 680] },
  labels: {
    client: ['终端', 'llama.cpp 的量化工具'],
    weights: ['GGUF 文件', `各层 ${MATRICES.length * C.nLayers} 个矩阵，${WEIGHT_COUNT} 个权重`],
    attn: [TENSOR, '第 0 块：32 个权重'],
    gpu: ['GPU', '用解码回来的权重计算'],
    out: ['输出', `「${PROMPT}」的续写`],
  },
  labelAt: { attn: [-290, 40], out: [-200, 50] },
  radius: { attn: 135, out: 55 },
  initial: { attn: [], out: [] },
  start: ['client', 'weights'],
  legend: [['blue', 'fp16 原值'], ['teal', 'Q8_0：int8'], ['amber', 'Q4_0：4 位'], [null, '运算量：累计 FLOPs']],
  overview: {
    full: '把权重压成 8 位、4 位，模型还能用吗',
    description: `解码受显存带宽限制，权重越小跑得越快、越能塞进普通电脑的内存。这一课把迷你模型各层的 ${WEIGHT_COUNT} 个真实权重从 fp16 量化成 GGUF 的 Q8_0 和 Q4_0：每 ${QK} 个权重一块、共用一个 fp16 缩放因子 d，逐字节拆开一块；再用量化后的权重真实生成一遍。Q8_0 的输出和 fp16 一字不差，Q4_0 前 ${q4At} 个 token 相同，之后开始不一样。`,
    facts: [
      ['块', `${QK} 个权重 + 1 个 fp16 的 d`],
      ['Q8_0', `34 字节 / 块，${bitsPerWeight('q8_0')} 位 / 权重`],
      ['Q4_0', `18 字节 / 块，${bitsPerWeight('q4_0')} 位 / 权重`],
      ['量化的权重', `${WEIGHT_COUNT} 个，${BLOCKS} 块`],
      ['运算量', '累计 FLOPs'],
    ],
  },
  steps: [
    {
      title: 'fp16：每个权重 2 字节',
      desc: `${TENSOR} 的第 0 块，${QK} 个数 ${QK * 2} 字节`,
      detail: `这是第 0 层 Q 投影矩阵的前 ${QK} 个权重，也就是它的第 0–3 行，按 fp16 存每个 2 字节。先用 fp16 权重跑一遍「${PROMPT}」，得到后面比较的基准：生成「${T.decode(runs.f16.tokens).trim()}」，${total('f16')} FLOPs。这一块里绝对值最大的是第 ${extremeIndex} 个，${num(blockValues[extremeIndex], 4)}，它决定了量化的缩放因子。`,
      facts: [['张量', `${TENSOR}（${tensorRows.length} × ${tensorRows[0].length}）`], ['本块', `${QK} 个 × 2 字节 = ${QK * 2} 字节`], ['最大绝对值', `w[${extremeIndex}] = ${num(blockValues[extremeIndex], 4)}`]],
      events: [
        show('attn'),
        pk('weights', 'attn', 'blue', '第 0 块 · fp16', [`${QK} 个权重`, `${QK * 2} 字节`], [0, 'LOAD', `${TENSOR} 的前 ${QK} 个权重（第 0–3 行），fp16 共 ${QK * 2} 字节`, QK * 2],
          wire(`${TENSOR} 第 0 块（fp16）`, 'mem', 'format', floatVector('w', blockValues, 'f16', { names: (i) => `w[${i}]（行${Math.floor(i / COLS)} 列${i % COLS}）`, summary: 'IEEE 754 binary16，小端' })),
          { ds: { attn: [f16Grid] } }),
        quantState('fp16', `${QK * 2} 字节`, '0'),
        show('gpu', 'out'),
        pk('weights', 'gpu', 'blue', '用 fp16 生成', [`${sizes.f16} 字节权重`], [total('f16'), 'MATMUL', `fp16 权重生成 ${runs.f16.tokens.length} 个 token：${total('f16')} FLOPs`, PROMPT_IDS.length * 4],
          wire('提示词', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: labelOf }))),
        pk('gpu', 'out', 'blue', '基准输出', [`${runs.f16.tokens.length} 个 token`], [total('f16'), 'SAMPLE', `fp16 的贪心输出：「${T.decode(runs.f16.tokens)}」`, runs.f16.tokens.length * 4],
          wire('fp16 权重的输出', 'mem', 'format', tokenIds('out', runs.f16.tokens, { labels: labelOf, color: 'blue' })),
          { ds: { out: [outRow(runs.f16.tokens, OUT_FROM, 'blue')] } }),
      ],
    },
    {
      title: 'Q8_0：32 个数共用一个 d',
      desc: `d = ${num(absmax, 4)} / 127，34 字节`,
      detail: `Q8_0 先找这一块的最大绝对值，d = ${num(absmax, 4)} ÷ 127 = ${num(q8d, 6)}，存成 fp16；每个权重除以 d 再四舍五入成 int8，范围 −127 到 127。一块是 2 字节的 d 加 32 个 int8，共 34 字节，平均每个权重 ${bitsPerWeight('q8_0')} 位。还原时 q × d，这一块的最大误差是 ${num(blockError.q8.max, 6)}，不到 d 的一半。`,
      facts: [['d', `${num(q8d, 6)}（fp16）`], ['qs', `32 个 int8，w[${extremeIndex}] → ${num(q8.qs[extremeIndex])}`], ['最大误差', num(blockError.q8.max, 6)]],
      events: [
        type('llama-quantize model-f16.gguf model-q8_0.gguf Q8_0'),
        pk('client', 'weights', 'slate', 'Q8_0', ['每块 34 字节'], [total('f16'), 'QUANT', `把各层矩阵量化成 Q8_0：${BLOCKS} 块，${sizes.q8_0} 字节`, null],
          wire('量化命令', 'vals', '示意', conceptOf('llama-quantize', [['输入', 'model-f16.gguf'], ['输出', 'model-q8_0.gguf'], ['类型', 'Q8_0', '每 32 个权重一块：fp16 的 d + 32 个 int8。']]))),
        pk('attn', 'weights', 'teal', 'block_q8_0', [`d = ${num(q8d, 5)}`, '32 个 int8'], [total('f16'), 'QUANT', `第 0 块：d = ${num(absmax, 4)} / 127 = ${num(q8d, 6)}，w[${extremeIndex}] → ${num(q8.qs[extremeIndex])}，最大误差 ${num(blockError.q8.max, 6)}`, 34],
          wire('GGUF 里的一块 Q8_0', 'mem', 'format', q8_0Block('blk.0.attn_q[0]', q8)),
          { ds: { attn: [q8Grid] } }),
        quantState('Q8_0', '34 字节', num(blockError.q8.max, 5)),
      ],
    },
    {
      title: 'Q4_0：每个只剩 4 位',
      desc: `d = ${num(blockValues[extremeIndex], 4)} / −8，18 字节`,
      detail: `Q4_0 取绝对值最大的那个数本身（带符号），d = ${num(blockValues[extremeIndex], 4)} ÷ −8 = ${num(q4d, 6)}，每个权重变成 0–15 的整数 q，还原为 (q − 8) × d，所以 w[${extremeIndex}] 正好落在 q = ${q4.q[extremeIndex]}、还原得一模一样。两个 4 位数挤一个字节：第 j 个字节的低 4 位是第 j 个权重，高 4 位是第 j + 16 个，16 字节放下 32 个权重，加上 d 一共 18 字节。代价是只剩 16 档，这一块的最大误差 ${num(blockError.q4.max, 6)}，是 Q8_0 的 ${Math.round(blockError.q4.max / blockError.q8.max)} 倍。`,
      facts: [['d', `${num(q4d, 6)}（fp16）`], ['qs[0]', `0x${q4.qs[0].toString(16).padStart(2, '0')}：低 4 位 w[0] = ${q4.q[0]}，高 4 位 w[16] = ${q4.q[16]}`], ['最大误差', num(blockError.q4.max, 6)]],
      events: [
        type('llama-quantize model-f16.gguf model-q4_0.gguf Q4_0'),
        pk('attn', 'weights', 'amber', 'block_q4_0', [`d = ${num(q4d, 5)}`, '16 字节 = 32 个 4 位'], [total('f16'), 'QUANT', `第 0 块：d = ${num(q4d, 6)}，qs[0] = 0x${q4.qs[0].toString(16).padStart(2, '0')}（w[0] = ${q4.q[0]}，w[16] = ${q4.q[16]}），最大误差 ${num(blockError.q4.max, 6)}`, 18],
          wire('GGUF 里的一块 Q4_0：每个字节拆成高低两个 4 位', 'mem', 'format', q4_0Block('blk.0.attn_q[0]', q4)),
          { ds: { attn: [q4Grid] } }),
        quantState('Q4_0', '18 字节', num(blockError.q4.max, 5)),
        note('attn', `w[${extremeIndex}] 落在 q = 0，还原无误差`, 'amber'),
      ],
    },
    {
      title: '整个模型：体积和误差',
      desc: `${WEIGHT_COUNT} 个权重：${sizes.f16} → ${sizes.q8_0} → ${sizes.q4_0} 字节`,
      detail: `各层 ${MATRICES.length * C.nLayers} 个矩阵共 ${WEIGHT_COUNT} 个权重、${BLOCKS} 块：fp16 ${sizes.f16} 字节，Q8_0 ${sizes.q8_0} 字节，Q4_0 ${sizes.q4_0} 字节，约为 fp16 的 ${Math.round((sizes.q4_0 / sizes.f16) * 100)}%。误差的均方根相对权重本身，Q8_0 是 ${(modelError.q8.relative * 100).toFixed(2)}%，Q4_0 是 ${(modelError.q4.relative * 100).toFixed(1)}%。真实 GGUF 每行单独分块，要求行长是 32 的倍数；迷你模型每行只有 ${C.dModel} 或 ${C.dFF} 个数，这里把矩阵按行展开后每 32 个切一块，嵌入表和输出层（${C.vocab} × ${C.dModel}，凑不成整块）留在 fp16。`,
      facts: [['fp16', `${sizes.f16} 字节`], ['Q8_0', `${sizes.q8_0} 字节 · 误差 ${(modelError.q8.relative * 100).toFixed(2)}%`], ['Q4_0', `${sizes.q4_0} 字节 · 误差 ${(modelError.q4.relative * 100).toFixed(1)}%`]],
      events: [
        pk('weights', 'attn', 'slate', `${BLOCKS} 块`, [`fp16 ${sizes.f16}`, `Q8_0 ${sizes.q8_0}`, `Q4_0 ${sizes.q4_0}`], [total('f16'), 'QUANT', `${WEIGHT_COUNT} 个权重：fp16 ${sizes.f16} 字节，Q8_0 ${sizes.q8_0}，Q4_0 ${sizes.q4_0}`, null],
          wire('各层矩阵的体积和误差', 'vals', '示意', conceptOf(`${WEIGHT_COUNT} 个权重，${BLOCKS} 块`, [
            ['fp16', `${sizes.f16} 字节`, '每个 2 字节。'],
            ['Q8_0', `${sizes.q8_0} 字节`, `${BLOCKS} 块 × 34 字节；相对误差 ${(modelError.q8.relative * 100).toFixed(2)}%，最大 ${num(modelError.q8.max, 5)}。`],
            ['Q4_0', `${sizes.q4_0} 字节`, `${BLOCKS} 块 × 18 字节；相对误差 ${(modelError.q4.relative * 100).toFixed(1)}%，最大 ${num(modelError.q4.max, 5)}。`],
            ['不量化', `token_embd、output（fp16），RMSNorm γ（fp32）`],
          ])),
          { ds: { attn: [sizeGrid] } }),
        state('weights', { 格式: 'fp16 / Q8_0 / Q4_0', 本块: null, 最大误差: null, 体积: `${sizes.f16} / ${sizes.q8_0} / ${sizes.q4_0}` }),
      ],
    },
    {
      title: '量化后再跑一遍',
      desc: `Q8_0 输出不变，Q4_0 从第 ${q4At} 个 token 起分叉`,
      detail: `用解码回来的权重真实生成：提示词最后一个位置的 logits，Q8_0 和 fp16 最多差 ${num(logitDiff('q8_0'), 4)}，Q4_0 最多差 ${num(logitDiff('q4_0'), 4)}，最大的那个 logit 都没变，第一个 token 都是「${labelOf(argmax(runs.q4_0.logits))}」。Q8_0 的 ${runs.q8_0.tokens.length} 个 token 和 fp16 完全相同；Q4_0 前 ${q4At} 个相同，第 ${q4At} 个从「${labelOf(runs.f16.tokens[q4At])}」变成「${labelOf(runs.q4_0.tokens[q4At])}」，之后整段续写都不一样了。贪心解码每一步只看最大值，误差平时不改变排名，一旦两个候选很接近，就会选到另一个，后面的文字跟着全变。`,
      facts: [['Q8_0 logits 最大差', num(logitDiff('q8_0'), 4)], ['Q4_0 logits 最大差', num(logitDiff('q4_0'), 4)], ['Q4_0 输出', `「${T.decode(runs.q4_0.tokens).trim()}」`]],
      events: [
        pk('weights', 'gpu', 'teal', '用 Q8_0 生成', [`${sizes.q8_0} 字节权重`], [opsAfter.q8_0, 'MATMUL', `Q8_0 权重生成：${total('q8_0')} FLOPs，logits 最多差 ${num(logitDiff('q8_0'), 4)}`, PROMPT_IDS.length * 4],
          wire('提示词', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: labelOf }))),
        pk('gpu', 'out', 'teal', '和 fp16 相同', [`${runs.q8_0.tokens.length} 个 token`], [opsAfter.q8_0, 'SAMPLE', `Q8_0 的输出：「${T.decode(runs.q8_0.tokens)}」，和 fp16 逐个相同`, runs.q8_0.tokens.length * 4],
          wire('Q8_0 权重的输出', 'mem', 'format', tokenIds('out', runs.q8_0.tokens, { labels: labelOf, color: 'teal' })),
          { ds: { out: [outRow(runs.q8_0.tokens, OUT_FROM, 'teal')] } }),
        pk('weights', 'gpu', 'amber', '用 Q4_0 生成', [`${sizes.q4_0} 字节权重`], [opsAfter.q4_0, 'MATMUL', `Q4_0 权重生成：${total('q4_0')} FLOPs，logits 最多差 ${num(logitDiff('q4_0'), 4)}`, PROMPT_IDS.length * 4],
          wire('提示词', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: labelOf }))),
        pk('gpu', 'out', 'amber', `第 ${q4At} 个分叉`, [`「${labelOf(runs.f16.tokens[q4At])}」→「${labelOf(runs.q4_0.tokens[q4At])}」`], [opsAfter.q4_0, 'SAMPLE', `Q4_0 的输出：「${T.decode(runs.q4_0.tokens)}」，第 ${q4At} 个 token 起和 fp16 不同`, runs.q4_0.tokens.length * 4],
          wire('Q4_0 权重的输出', 'mem', 'format', tokenIds('out', runs.q4_0.tokens, { labels: labelOf, color: 'amber', notes: { [q4At]: `fp16 这里是 ${runs.f16.tokens[q4At]}（${labelOf(runs.f16.tokens[q4At])}）。` } })),
          { ds: { out: [outRow(runs.q4_0.tokens, OUT_FROM, 'amber', q4At)] } }),
        note('out', `Q4_0：第 ${q4At} 个 token 起不同`, 'amber'),
        render,
      ],
    },
  ],
  outro: {
    title: '用一点精度换带宽',
    desc: `4.5 位 / 权重，体积约 fp16 的 ${Math.round((sizes.q4_0 / sizes.f16) * 100)}%`,
    text: `按同样的块格式估算，${LLAMA3_8B.name} 的 ${(llama.total / 1e9).toFixed(2)}B 个参数在 fp16 下约 ${gb(llama.f16)}，Q8_0 约 ${gb(llama.q8_0)}，Q4_0 约 ${gb(llama.q4_0)}（真实文件里个别张量会用别的格式，大小略有出入）。解码每一步都要读一遍权重，字节少了，同样的带宽每秒就能多出几倍 token，也能装进笔记本的内存，所以用 llama.cpp 和 Ollama 在本地跑模型，最常见的就是 4 位左右的 GGUF 量化。Ollama 的默认标签多是 Q4_K_M 这类 K-quant，它是同一思路的改进版：每 256 个权重一个超块，里面每 32 个一组，各组的缩放因子再用 6 位量化。大模型参数多、冗余也多，4 位量化通常只带来很小的质量损失，迷你模型只有 ${MODEL.layers.length} 层、${C.dModel} 维，更容易被它改变输出。`,
    facts: [[`${LLAMA3_8B.name} fp16`, gb(llama.f16)], ['Q8_0', gb(llama.q8_0)], ['Q4_0', gb(llama.q4_0)], ['下一课', 'logits → temperature → softmax']],
  },
};
