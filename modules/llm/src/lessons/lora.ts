/**
 * 第十五课：训练一步与 LoRA 微调。在一个样本上做前向 → 交叉熵 → 反向 → 一步更新，再冻结原权重，
 * 只训练低秩的 A、B，最后合并回原权重。全部是 model/ 里的真实计算（backward、sgdStep、loraGrads、loraMerge）。
 * 文案里的数字全部取自下面导出的计算结果，tests/narrative.sample.test.ts 核对。
 */
import { floatMatrix, floatVector, tokenIds, wire } from '../decode/structures';
import { gaussian, mulberry32 } from '../model/prng';
import { FlopMeter, type Mat, type Vec } from '../model/tensor';
import { TOKENIZER } from '../model/tokenizer';
import { crossEntropy, forward, generate, paramCount, sequenceLoss, type Weights } from '../model/transformer';
import { MODEL } from '../model';
import { backward, cloneWeights, eachTensor, loraGrads, loraMerge, sgdStep } from '../model/train';
import { num, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { heatOf, labelBelow } from './sample-common';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

const T = TOKENIZER;

/** 微调用的那一个训练样本：迷你模型没见过这句话。 */
export const TEXT = 'the model is small.';
/** 测试「微调有没有伤到别的」用的另一个提示词。 */
export const OTHER_PROMPT = 'the tokenizer';
export const PROMPT = 'the model';

const sampleIds = [...T.encode(TEXT), T.eos];
export const inputs = sampleIds.slice(0, -1);
export const targets = sampleIds.slice(1);

/** 全参数更新一步的学习率。 */
export const SGD_LR = 0.05;
/** LoRA 的秩、缩放（s = α / r）、学习率、训练步数。 */
export const RANK = 2;
export const ALPHA = 4;
export const SCALE = ALPHA / RANK;
export const LORA_LR = 0.03;
export const LORA_STEPS = 20;
export const LORA_SEED = 1;
/** 给每层的这 7 个线性矩阵都加上适配器。 */
export const ADAPTED = ['attn_q', 'attn_k', 'attn_v', 'attn_output', 'ffn_gate', 'ffn_up', 'ffn_down'] as const;
type AdaptedKey = (typeof ADAPTED)[number];

// ---------- 损失 ----------

const forwardOf = (w: Weights) => forward(w, inputs, { fp64: true });
export const lossOf = (w: Weights) => sequenceLoss(forwardOf(w), targets);
const positionLosses = (w: Weights) => forwardOf(w).positions.map((p, t) => crossEntropy(p.logits, targets[t]));
/** 瞎猜的损失：词表里每个 token 概率相同。 */
export const uniformLoss = Math.log(T.size);

const baseTrace = forwardOf(MODEL);
export const baseLosses = positionLosses(MODEL);
export const baseLoss = lossOf(MODEL);

// ---------- 反向与一步更新 ----------

export const grads = backward(MODEL, baseTrace, targets);
export const gradNorms = (() => {
  const out: Array<{ name: string; norm: number }> = [];
  eachTensor(grads, (name, value) => {
    const flat = Array.isArray(value[0]) ? (value as Mat).flat() : (value as Vec);
    out.push({ name, norm: Math.sqrt(flat.reduce((sum, x) => sum + x * x, 0)) });
  });
  return out;
})();
export const totalGradNorm = Math.sqrt(gradNorms.reduce((sum, item) => sum + item.norm ** 2, 0));
export const gradTop = [...gradNorms].sort((a, b) => b.norm - a.norm).slice(0, 4);
/** logits 处的梯度范数：|softmax − onehot| / 位置数，反向传播的起点。 */
export const logitGrads = baseTrace.positions.map((p, t) => {
  const probs = (() => {
    const max = Math.max(...p.logits);
    const exps = p.logits.map((x) => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((x) => x / sum);
  })();
  return Math.sqrt(probs.reduce((sum, value, i) => sum + (value - (i === targets[t] ? 1 : 0)) ** 2, 0)) / baseTrace.positions.length;
});

export const stepped = cloneWeights(MODEL);
sgdStep(stepped, grads, SGD_LR);
export const steppedLosses = positionLosses(stepped);
export const steppedLoss = lossOf(stepped);
/** 同样的学习率再走一步：损失会不会回升。 */
export const secondLoss = (() => {
  const next = cloneWeights(stepped);
  sgdStep(next, backward(next, forwardOf(next), targets), SGD_LR);
  return lossOf(next);
})();

export const paramTotal = paramCount(MODEL);
/** 全参数训练时需要常驻的 fp32 副本数：参数、梯度、Adam 的 m 和 v。 */
const COPIES_FULL = 4;
export const fullTrainBytes = paramTotal * COPIES_FULL * 4;
/** 7B 参数的模型按同样的 4 份 fp32 算，单位 GB（10^9 字节）。 */
export const BIG7B_GB = Math.round((7e9 * COPIES_FULL * 4) / 1e9);

// ---------- LoRA ----------

export interface Adapter {
  layer: number;
  key: AdaptedKey;
  name: string;
  A: Mat;
  B: Mat;
}

const dims = (W: Mat) => ({ out: W.length, inn: W[0].length });
const weightOf = (w: Weights, layer: number, key: AdaptedKey): Mat => w.layers[layer][key] as Mat;

function initAdapters(): Adapter[] {
  const rand = gaussian(mulberry32(LORA_SEED));
  return MODEL.layers.flatMap((_, layer) =>
    ADAPTED.map((key): Adapter => {
      const { out, inn } = dims(weightOf(MODEL, layer, key));
      return {
        layer,
        key,
        name: `blk.${layer}.${key}`,
        A: Array.from({ length: RANK }, () => Array.from({ length: inn }, () => Math.fround(rand() / Math.sqrt(inn)))),
        B: Array.from({ length: out }, () => new Array<number>(RANK).fill(0)),
      };
    }),
  );
}

/** 原权重加上适配器：每个被适配的矩阵换成 W + s·B·A，其余原样。 */
export function mergeAll(adapters: readonly Adapter[]): Weights {
  const w = cloneWeights(MODEL);
  for (const a of adapters) (w.layers[a.layer] as unknown as Record<string, Mat>)[a.key] = loraMerge(weightOf(MODEL, a.layer, a.key), a.A, a.B, SCALE);
  return w;
}

/** Adam 对一个矩阵的一步（和 model/train.ts 的 Adam 相同的公式，那个类只认整套 Weights）。 */
export function adamMatrix(P: Mat, G: Mat, m: Mat, v: Mat, t: number, lr: number): void {
  const c1 = 1 - 0.9 ** t;
  const c2 = 1 - 0.999 ** t;
  P.forEach((row, i) =>
    row.forEach((_, j) => {
      m[i][j] = 0.9 * m[i][j] + 0.1 * G[i][j];
      v[i][j] = 0.999 * v[i][j] + 0.001 * G[i][j] * G[i][j];
      row[j] -= (lr * (m[i][j] / c1)) / (Math.sqrt(v[i][j] / c2) + 1e-8);
    }),
  );
}

export const adapters = initAdapters();
export const loraCount = adapters.reduce((sum, a) => sum + a.A.length * a.A[0].length + a.B.length * a.B[0].length, 0);
export const adaptedFull = adapters.reduce((sum, a) => sum + weightOf(MODEL, a.layer, a.key).length * weightOf(MODEL, a.layer, a.key)[0].length, 0);
/** LoRA 训练时的常驻字节：冻结的原权重一份，加上适配器的参数、梯度、m、v。 */
export const loraTrainBytes = paramTotal * 4 + loraCount * COPIES_FULL * 4;
/** 7B 级模型里一个 4096×4096 矩阵的账（纯算术，不是本站模型）：全矩阵与同秩 r=8 的 A、B。 */
export const BIG = { size: 4096, rank: 8, full: 4096 * 4096, lora: 8 * 4096 * 2 };

const initial = { A: adapters.map((a) => a.A.map((row) => row.slice())), B: adapters.map((a) => a.B.map((row) => row.slice())) };
export const initialLoss = lossOf(mergeAll(adapters));

const loraMeter = new FlopMeter();
forward(MODEL, inputs, { meter: loraMeter, fp64: true });
/** 前向一次的 FLOPs（原模型）。 */
export const FWD = loraMeter.total;
/** LoRA 不合并时多出来的前向：每个被适配的矩阵多算 x·Aᵀ·Bᵀ，每个位置 2·r·(in+out)。 */
export const LORA_EXTRA = adapters.reduce((sum, a) => sum + inputs.length * 2 * RANK * (weightOf(MODEL, a.layer, a.key)[0].length + weightOf(MODEL, a.layer, a.key).length), 0);

export const curve: number[] = [initialLoss];
{
  const mA = adapters.map((a) => a.A.map((row) => row.map(() => 0)));
  const vA = adapters.map((a) => a.A.map((row) => row.map(() => 0)));
  const mB = adapters.map((a) => a.B.map((row) => row.map(() => 0)));
  const vB = adapters.map((a) => a.B.map((row) => row.map(() => 0)));
  for (let t = 1; t <= LORA_STEPS; t++) {
    const w = mergeAll(adapters);
    const g = backward(w, forwardOf(w), targets);
    adapters.forEach((a, k) => {
      const { dA, dB } = loraGrads(weightOf(g, a.layer, a.key), a.A, a.B, SCALE);
      adamMatrix(a.A, dA, mA[k], vA[k], t, LORA_LR);
      adamMatrix(a.B, dB, mB[k], vB[k], t, LORA_LR);
    });
    curve.push(lossOf(mergeAll(adapters)));
  }
}
export const merged = mergeAll(adapters);
export const finalLoss = curve[curve.length - 1];
export const mergedLosses = positionLosses(merged);

const answer = (w: Weights, prompt: string) => T.decode(generate(w, T.encode(prompt), { maxTokens: 12, stop: T.eos }).tokens);
export const answers = {
  before: answer(MODEL, PROMPT),
  after: answer(merged, PROMPT),
  otherBefore: answer(MODEL, OTHER_PROMPT),
  otherAfter: answer(merged, OTHER_PROMPT),
};

// ---------- 运算量 ----------

/** 训练一步 ≈ 前向 + 2 倍前向的反向，这是常用的估算，不是精确计数。 */
const stepFlops = (extra: number) => 3 * (FWD + extra);
const oneStep = stepFlops(0);
const loraTrain = LORA_STEPS * stepFlops(LORA_EXTRA);
const OPS = { forward: FWD, backward: oneStep, lora: oneStep + loraTrain };

// ---------- 图元 ----------

const lossRow = (values: readonly number[], tone: 'amber' | 'green', id = 'l', title?: string): RowPrim => ({
  kind: 'row',
  id,
  w: 34,
  title,
  cells: values.map((value, t): DsCell => ({ v: num(value, 1), tone, heat: heatOf(value / 12), sub: shortLabel(targets[t], 3) })),
});

const gradRow = (): RowPrim => {
  const top = Math.max(...logitGrads);
  return { kind: 'row', id: 'l', w: 34, cells: logitGrads.map((value, t): DsCell => ({ v: num(value * 100, 1), tone: 'amber', heat: heatOf(value / top), sub: shortLabel(targets[t], 3) })) };
};

const sampleRow = (): RowPrim => ({
  kind: 'row',
  id: 't',
  w: 30,
  cells: cellsOfTokens(inputs),
  marks: [{ at: 0, text: '输入', color: 'blue' }],
});
function cellsOfTokens(ids: readonly number[]): DsCell[] {
  return ids.map((id, i): DsCell => ({ v: shortLabel(id, 3), tone: 'blue', sub: `→${shortLabel(targets[i], 3)}` }));
}

const shape = (W: Mat) => `${W.length}×${W[0].length}`;
const shapeGrid = (): GridPrim => {
  const first = adapters.filter((a) => a.layer === 0);
  return {
    kind: 'grid',
    id: 'a',
    w: 34,
    rows: first.map((a) => a.key.replace('attn_', 'a_').replace('ffn_', 'f_')),
    cols: ['W', 'B', 'A'],
    cells: first.map((a): DsCell[] => [{ v: shape(weightOf(MODEL, a.layer, a.key)), tone: 'dim' }, { v: shape(a.B), tone: 'green' }, { v: shape(a.A), tone: 'green' }]),
  };
};

const curvePoints = [0, 1, 2, 5, 10, LORA_STEPS];
const SHOWN_STEPS = [1, 5, LORA_STEPS];
const curveRow = (upto: number): RowPrim => ({
  kind: 'row',
  id: 'l',
  w: 40,
  cells: curvePoints.map((step): DsCell => (step <= upto ? { v: num(curve[step], 2), tone: 'green', heat: heatOf(curve[step] / 12), sub: `第 ${step} 步` } : { v: '', tone: 'empty', sub: `第 ${step} 步` })),
});

/** 合并时演示的那一个数：第 0 层 attn_q 的 W[0][0]。 */
const demo = adapters[0];
const W0 = weightOf(MODEL, demo.layer, demo.key);
const delta = SCALE * demo.B[0].reduce((sum, b, k) => sum + b * demo.A[k][0], 0);
export const mergeDemo = { w: W0[0][0], delta, merged: weightOf(merged, demo.layer, demo.key)[0][0] };
const mergeRow = (): RowPrim => ({
  kind: 'row',
  id: 'm',
  w: 62,
  cells: [
    { v: num(mergeDemo.w, 4), tone: 'dim', sub: 'W[0][0]' },
    { v: num(mergeDemo.delta, 4), tone: 'green', sub: `+ ${SCALE}·B·A` },
    { v: num(mergeDemo.merged, 4), tone: 'blue', sub: "= W'" },
  ],
});

const ratio = (a: number, b: number) => `${+((a / b) * 100).toFixed(2)}%`;
const kib = (bytes: number) => `${+(bytes / 1024).toFixed(1)} KiB`;

export const lora: Lesson = labelBelow(
  {
    id: 'lora',
    name: 'LoRA FINE-TUNING',
    title: '训练一步与 LoRA 微调',
    group: 'sample',
    layer: [4, 5],
    layerNote: '训练在模型层之下改参数，LoRA 只动其中很小的一部分，再合并回推理用的权重。',
    opsUnit: 'FLOPs：前向由 FlopMeter 统计；反向按前向的 2 倍估算（常用经验值，不是精确计数）；LoRA 不合并时每个适配矩阵多算 x·Aᵀ·Bᵀ；优化器更新是逐元素运算，不计入',
    opsShort: 'FLOPs',
    nodes: ['tokens', 'logits', 'grad', 'weights', 'lora'],
    place: { tokens: [150, 110], logits: [560, 110], grad: [610, 360], weights: [270, 370], lora: [830, 570] },
    labels: {
      tokens: ['训练样本', '输入 → 预测下一个'],
      logits: ['损失', '每个位置的交叉熵（nat）'],
      grad: ['优化器', '梯度与更新'],
      weights: ['权重', `${paramTotal} 个参数`],
      lora: ['LoRA 适配器', `r=${RANK}，W + ${SCALE}·B·A`],
    },
    radius: { tokens: 50, logits: 50, lora: 50 },
    initial: { tokens: [], logits: [], lora: [] },
    start: ['tokens', 'grad', 'weights'],
    legend: [['amber', '损失 / 梯度'], ['green', '训练后 / LoRA 的参数'], ['blue', '输入 / 合并后的权重'], [null, '运算量：训练的 FLOPs']],
    overview: {
      full: '改一次参数，再只改很小一部分',
      description: `预训练好的模型怎样学新东西？这一课用迷你模型在一句它没见过的话「${TEXT}」上走一遍训练：前向算出交叉熵损失，反向得到每个参数的梯度，按学习率更新一步，损失从 ${num(baseLoss, 2)} 降到 ${num(steppedLoss, 2)}。然后冻结原权重，只训练低秩的 A、B 两个小矩阵（LoRA），可训练参数从 ${paramTotal} 个降到 ${loraCount} 个，训练完把它们乘起来加回原权重。`,
      facts: [
        ['训练样本', `「${TEXT}」，${inputs.length} 个位置`],
        ['参数', `${paramTotal} 个`],
        ['全参数更新', `SGD，学习率 ${SGD_LR}`],
        ['LoRA', `r=${RANK}，α=${ALPHA}，${loraCount} 个参数`],
        ['LoRA 训练', `Adam，学习率 ${LORA_LR}，${LORA_STEPS} 步`],
        ['运算量', 'FLOPs（前向 + 估算的反向）'],
      ],
    },
    steps: [
      {
        title: '前向与交叉熵损失',
        desc: `平均损失 ${num(baseLoss, 2)} nat，比瞎猜的 ${num(uniformLoss, 2)} 还差`,
        detail: `训练样本是「${TEXT}」加结束符，每个位置的任务是预测下一个 token，所以输入 ${inputs.length} 个 token，目标是它们右移一位。前向和推理完全相同，区别是每个位置的 logits 都要保留。交叉熵损失是 −log p(目标)，模型给正确答案的概率越小，损失越大；${inputs.length} 个位置的平均是 ${num(baseLoss, 2)} nat。均匀地瞎猜是 ln ${T.size} = ${num(uniformLoss, 2)}，这里更大，说明模型不但不会这句话，还很有把握地预测了别的。`,
        facts: [['输入', inputs.map((id) => T.label(id)).join(' ')], ['目标', targets.map((id) => T.label(id)).join(' ')], ['平均损失', `${num(baseLoss, 3)} nat`], ['瞎猜', `${num(uniformLoss, 3)} nat`]],
        events: [
          type(`train --data "${TEXT}"`),
          show('logits'),
          pk('tokens', 'logits', 'blue', '前向', [`${inputs.length} 个位置`], [OPS.forward, 'LOGITS', `${inputs.length} 个位置各算 ${T.size} 个 logit，和目标比较：平均交叉熵 ${num(baseLoss, 3)} nat`, inputs.length * 4],
            wire('输入 token id（目标是它们右移一位）', 'mem', 'format', tokenIds('inputs', inputs, { labels: (id) => T.label(id), summary: `目标是 ${targets.map((id) => T.label(id)).join(' ')}` })),
            { ds: { tokens: [sampleRow()], logits: [lossRow(baseLosses, 'amber')] } }),
        ],
      },
      {
        title: '反向：每个参数的梯度',
        desc: `梯度和参数同形，共 ${paramTotal} 个数，总范数 ${num(totalGradNorm, 2)}`,
        detail: `反向传播从损失出发，沿着前向的路径倒着走，用链式法则算出损失对每个参数的偏导，也就是梯度，它告诉我们这个参数往哪边动一点、损失会增加还是减少。梯度的形状和参数一样，所以全参数训练要多存一份和模型一样大的梯度。这一步最大的几块是 ${gradTop.map((item) => `${item.name}（${num(item.norm, 2)}）`).join('、')}。`,
        facts: [['梯度', `${paramTotal} 个数，和参数一一对应`], ['总范数', num(totalGradNorm, 3)], ...gradTop.slice(0, 2).map((item): [string, string] => [item.name, `范数 ${num(item.norm, 3)}`])],
        events: [
          pk('logits', 'grad', 'amber', '反向', [`范数 ${num(totalGradNorm, 2)}`], [OPS.backward, 'GRAD', `反向传播：${paramTotal} 个参数各得到一个梯度；最大的是 ${gradTop[0].name}`, grads.output_norm.length * 4],
            wire('output_norm 的梯度（最后一个 RMSNorm 的缩放，8 个数）', 'mem', 'format', floatVector('d_output_norm', grads.output_norm, 'f32', { color: 'amber', summary: '梯度用 fp64 算，这里按 fp32 存下来' })),
            { ds: { logits: [gradRow()] } }),
          state('grad', Object.fromEntries([['总范数', num(totalGradNorm, 2)], ...gradTop.slice(0, 3).map((item) => [item.name, num(item.norm, 2)])])),
        ],
      },
      {
        title: '更新一步',
        desc: `w ← w − ${SGD_LR}·g，损失 ${num(baseLoss, 2)} → ${num(steppedLoss, 2)}`,
        detail: `最朴素的更新是沿梯度反方向走一小步：每个参数减去学习率乘它的梯度，学习率 ${SGD_LR} 时同一句话的损失从 ${num(baseLoss, 2)} 降到 ${num(steppedLoss, 2)}。步子太大会冲过头，同样的学习率再走一步，损失反而回升到 ${num(secondLoss, 2)}，所以实际训练常用 Adam 这类优化器，并给每个参数额外存 2 个状态（m 和 v）。这样全参数训练要常驻参数、梯度、m、v 共 ${COPIES_FULL} 份，这个迷你模型是 ${kib(fullTrainBytes)}，7B 参数的模型按 fp32 算是 ${BIG7B_GB} GB。`,
        facts: [['损失', `${num(baseLoss, 3)} → ${num(steppedLoss, 3)}`], ['学习率', String(SGD_LR)], ['output_norm[0]', `${num(MODEL.output_norm[0], 4)} → ${num(stepped.output_norm[0], 4)}`], ['训练时常驻', `${COPIES_FULL} 份，${kib(fullTrainBytes)}`]],
        events: [
          pk('grad', 'weights', 'green', 'sgdStep', [`lr = ${SGD_LR}`], [OPS.backward, 'GRAD', `w ← w − ${SGD_LR}·g，对全部 ${paramTotal} 个参数；同一样本的损失 ${num(baseLoss, 3)} → ${num(steppedLoss, 3)}；下面只展开 output_norm 的 8 个数`, MODEL.output_norm.length * 4],
            wire('output_norm：更新前后（8 个数）', 'mem', 'format',
              floatVector('output_norm 前', MODEL.output_norm, 'f32', { color: 'blue' }),
              floatVector('output_norm 后', stepped.output_norm, 'f32', { color: 'green', summary: '更新一步之后' })),
            { ds: { logits: [lossRow(steppedLosses, 'green')] } }),
          state('weights', { 损失: `${num(baseLoss, 2)} → ${num(steppedLoss, 2)}`, 学习率: String(SGD_LR) }),
        ],
      },
      {
        title: '冻结原权重，只训练 A、B',
        desc: `可训练参数 ${paramTotal} → ${loraCount} 个`,
        detail: `全参数训练要为每个参数存梯度和优化器状态，大模型承担不起。LoRA 的想法是：微调时权重的改变量 ΔW 可以用两个又瘦又长的矩阵的乘积来近似，W' = W + s·B·A，其中 B 是 out×r，A 是 r×in，r 远小于 out 和 in，s = α/r = ${SCALE}。原权重 W 冻结不动，只训练 A 和 B；B 初始为 0，所以一开始 ΔW = 0，模型和原来完全一样（初始损失 ${num(initialLoss, 2)} = ${num(baseLoss, 2)}）。这里给每层的 ${ADAPTED.length} 个线性矩阵都加上 r=${RANK} 的适配器，共 ${loraCount} 个可训练参数，只有全部参数的 ${ratio(loraCount, paramTotal)}。`,
        facts: [['可训练', `${loraCount} / ${paramTotal} = ${ratio(loraCount, paramTotal)}`], ['被适配的矩阵', `${adapters.length} 个，原有 ${adaptedFull} 个参数`], ['训练时常驻', `${kib(loraTrainBytes)}（全参数 ${kib(fullTrainBytes)}）`], [`${BIG.size}×${BIG.size}，r=${BIG.rank}`, `${BIG.full} → ${BIG.lora}，${ratio(BIG.lora, BIG.full)}`]],
        events: [
          show('lora'),
          pk('weights', 'lora', 'green', '冻结 W', [`A: ${RANK}×in`, `B: out×${RANK}`], [OPS.backward, 'LOAD', `${adapters.length} 个矩阵各加一对 A、B，B 全 0；可训练参数 ${loraCount} 个`, initial.A[0].flat().length * 4],
            wire(`${adapters[0].name} 的 A（高斯初始化）`, 'mem', 'format', floatMatrix('A', initial.A[0], 'f32', { color: 'green', summary: `${shape(initial.A[0])}，每行 ${initial.A[0][0].length} 个` })),
            { ds: { lora: [shapeGrid()] } }),
          note('lora', '只训练 B 和 A，W 保持不动', 'green'),
        ],
      },
      {
        title: `训练 ${LORA_STEPS} 步`,
        desc: `损失 ${num(curve[0], 2)} → ${num(finalLoss, 2)}`,
        detail: `每一步用 W + s·B·A 做前向，反向得到整矩阵的梯度 dW，再由它精确得到 dA = s·Bᵀ·dW 和 dB = s·dW·Aᵀ，只用 Adam 更新 A 和 B。${LORA_STEPS} 步之后损失从 ${num(curve[0], 2)} 降到 ${num(finalLoss, 2)}，「${PROMPT}」的续写从「${answers.before}」变成「${answers.after}」。副作用也要看：同一个模型对「${OTHER_PROMPT}」的续写从「${answers.otherBefore}」变成了「${answers.otherAfter}」，因为只用一个样本训练，别的内容被一起带偏了，真实微调会混入大量多样的数据。`,
        facts: [['损失曲线', curvePoints.map((step) => num(curve[step], 2)).join(' → ')], [`「${PROMPT}」`, `「${answers.before}」→「${answers.after}」`], [`「${OTHER_PROMPT}」`, `「${answers.otherBefore}」→「${answers.otherAfter}」`]],
        events: SHOWN_STEPS.map((step, index) =>
          pk('grad', 'lora', index === 2 ? 'green' : 'amber', `第 ${step} 步`, [`损失 ${num(curve[step], 2)}`], [OPS.backward + step * stepFlops(LORA_EXTRA), 'GRAD', `Adam 更新 A、B：第 ${step} 步后损失 ${num(curve[step], 3)}（共 ${loraCount} 个参数，下面是损失曲线）`, (step + 1) * 4],
            wire('损失曲线（已训练的步）', 'mem', 'format', floatVector('loss', curve.slice(0, step + 1), 'f32', { color: 'green', summary: '第 0 步是 B=0 时，等于原模型的损失' })),
            { ds: { logits: [curveRow(step)] } }),
        ),
      },
      {
        title: '合并回原权重',
        desc: `W' = W + ${SCALE}·B·A，推理时不再有额外开销`,
        detail: `训练完 B·A 是一个和 W 同形的矩阵，直接加到 W 上，得到新的权重 W'。以第 0 层 attn_q 的 W[0][0] 为例：${num(mergeDemo.w, 4)} + ${num(mergeDemo.delta, 4)} = ${num(mergeDemo.merged, 4)}。合并后推理用的仍是普通的权重文件，和没有微调过的模型一样快，也可以不合并，把 A、B 单独存成很小的文件，按需换上不同的适配器。`,
        facts: [['示例', `${num(mergeDemo.w, 4)} + ${num(mergeDemo.delta, 4)} = ${num(mergeDemo.merged, 4)}`], ['合并后的损失', `${num(lossOf(merged), 3)} nat`], ['适配器大小', `${loraCount * 4} 字节（fp32）`]],
        events: [
          pk('lora', 'weights', 'blue', '合并', [`W' = W + ${SCALE}·B·A`], [OPS.lora, 'MATMUL', `${adapters.length} 个矩阵各做一次 W + s·B·A；合并后同一样本的损失 ${num(lossOf(merged), 3)} nat`, weightOf(merged, demo.layer, demo.key)[0].length * 4],
            wire(`${demo.name} 第 0 行：合并前后`, 'mem', 'format',
              floatVector('W[0]', W0[0], 'f32', { color: 'blue' }),
              floatVector("W'[0]", weightOf(merged, demo.layer, demo.key)[0], 'f32', { color: 'green', summary: 'loraMerge：W + s·B·A，按 fp32 存' })),
            { ds: { lora: [mergeRow()], logits: [lossRow(mergedLosses, 'green')] } }),
          state('weights', { 损失: `${num(baseLoss, 2)} → ${num(lossOf(merged), 2)}`, 可训练: `${loraCount} / ${paramTotal}` }),
          render,
        ],
      },
    ],
    outro: {
      title: '改很少的参数，学新的行为',
      desc: `${loraCount} 个参数，让损失降到 ${num(finalLoss, 2)}`,
      text: `LoRA 把一次微调要改的东西压成两个小矩阵，训练省显存，保存也只需要很小的适配器文件，所以社区里的微调模型大多是这样做的。这是本站的最后一课，从首页可以回到任何一课再看一遍。最后说清楚微调和 RAG 的分工：RAG 解决「模型不知道」，把资料检索出来放进提示词，不改参数，知识随时可以更新；微调解决「模型不会这样做」，改参数，让它稳定地学会某种格式、语气或任务，两者经常一起用。`,
      facts: [['可训练参数', ratio(loraCount, paramTotal)], ['损失', `${num(curve[0], 2)} → ${num(finalLoss, 2)}`], ['下一课', '本站完，回首页选其他课程']],
    },
  },
  ['tokens', 'logits', 'lora'],
);

