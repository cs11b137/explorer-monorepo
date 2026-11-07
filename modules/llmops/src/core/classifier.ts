/**
 * 本站的小文本分类器：字符 n-gram 的特征哈希 + 逻辑回归，在本站自写的小数据集上真训练（固定种子）。
 * 注入检测（injection.ts）和内容审核（moderation.ts）都用它。它是教学用的玩具：几十条样本、几百个桶，
 * 不代表真实产品（真实的检测器是在大得多的数据上训练的大模型或专门的分类模型）。
 *
 * 1. 规范化 normalize：NFKC（全角转半角、兼容字符合并）、转小写、去掉空白和零宽字符。绕过检测的人常插空格、换全角字母；
 * 2. 切 n-gram：规范化、去掉标点后的文字按码点取长度 1–3 的全部片段（中文没有空格，按字取片段是常见做法）；
 * 3. 特征哈希：每个片段的 UTF-8 字节过 32 位 FNV-1a，对桶数取余得到桶号；出现过的桶值为 1，再除以 √(桶数)（L2 归一化），
 *    所以长短不同的句子可以比；不同片段落进同一个桶就是「碰撞」，桶越少碰撞越多；
 * 4. 逻辑回归：p = σ(w·x + b)，交叉熵损失加 L2，随机梯度下降，每轮按固定种子打乱样本顺序。
 */
import { fnv1a32 } from '@explorer/llm-core/hash';
import { mulberry32 } from '@explorer/llm-core/prng';
import { utf8Encode } from '@explorer/llm-core/utf8';

// ---------- 规范化和切片 ----------

/** 零宽字符和 BOM：U+200B–U+200D、U+2060、U+FEFF。 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** NFKC、小写、去掉空白和零宽字符。 */
export const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(INVISIBLE, '').replace(/\s+/gu, '');

/** 切片前再去掉标点（\p{P}）：句末是句号还是问号不该影响判断（本站数据集里注入多是祈使句、正常问题多是问句，留着标点分类器会学到这个巧合）。 */
export const featureText = (text: string): string => normalize(text).replace(/\p{P}/gu, '');

/** 规范化后的全部 n-gram（按码点，长度取 ns 里的每个值），按出现顺序，可以重复。 */
export function charNgrams(text: string, ns: readonly number[] = [1, 2, 3]): string[] {
  const chars = [...featureText(text)];
  const out: string[] = [];
  for (const n of ns) for (let i = 0; i + n <= chars.length; i++) out.push(chars.slice(i, i + n).join(''));
  return out;
}

/** 片段 → 32 位 FNV-1a 哈希。同一批片段在训练、评估、每个审核类别里会反复出现，哈希只算一次。 */
const HASHES = new Map<string, number>();
const hashOf = (gram: string): number => {
  let h = HASHES.get(gram);
  if (h === undefined) {
    h = fnv1a32(utf8Encode(gram));
    HASHES.set(gram, h);
  }
  return h;
};

/** 一个片段落进哪个桶。 */
export const bucketOf = (gram: string, dims: number): number => hashOf(gram) % dims;

export interface Features {
  /** 出现过的桶号，升序。 */
  buckets: number[];
  /** 每个桶的值（都相同：1 / √桶数）。 */
  value: number;
  /** 桶号 → 落进来的片段（去重，按出现顺序）。 */
  grams: Map<number, string[]>;
}

/**
 * 算过的特征，键是桶数、n 和文字。同一条文字会被训练（每个审核类别各训练一次）、评估、预测反复用到，
 * 规范化（NFKC）和切片只做一次。返回给调用方的是副本，调用方改了也不影响缓存。
 */
const FEATURES = new Map<string, Features>();

/** 文字 → 稀疏特征向量。 */
export function featuresOf(text: string, dims: number, ns: readonly number[] = [1, 2, 3]): Features {
  const key = `${dims}|${ns.join(',')}|${text}`;
  let f = FEATURES.get(key);
  if (!f) {
    const grams = new Map<number, string[]>();
    for (const gram of charNgrams(text, ns)) {
      const bucket = bucketOf(gram, dims);
      const list = grams.get(bucket);
      if (!list) grams.set(bucket, [gram]);
      else if (!list.includes(gram)) list.push(gram);
    }
    const buckets = [...grams.keys()].sort((a, b) => a - b);
    f = { buckets, value: buckets.length ? 1 / Math.sqrt(buckets.length) : 0, grams };
    if (FEATURES.size < 20_000) FEATURES.set(key, f);
  }
  return { buckets: f.buckets.slice(), value: f.value, grams: new Map([...f.grams].map(([bucket, list]) => [bucket, list.slice()])) };
}

// ---------- 逻辑回归 ----------

export interface Sample {
  text: string;
  /** 1 是正类。 */
  label: 0 | 1;
}

export interface TrainOptions {
  /** 桶数。 */
  dims?: number;
  ns?: readonly number[];
  epochs?: number;
  /** 学习率。 */
  lr?: number;
  /** L2 正则系数。 */
  l2?: number;
  seed?: number;
  /** 正类样本梯度的倍数。1 是不加权；'balanced' 是负类数 / 正类数（正类很少时用，审核分类器每类只有几条正例）。 */
  positiveWeight?: number | 'balanced';
}

export const DEFAULT_TRAIN: Required<TrainOptions> = { dims: 1024, ns: [1, 2, 3], epochs: 80, lr: 1, l2: 1e-4, seed: 7, positiveWeight: 1 };

export interface LogReg {
  options: Required<TrainOptions>;
  weights: Float64Array;
  bias: number;
  /** 每一轮训练后在训练集上的平均交叉熵。 */
  losses: number[];
  /** 训练样本数（正类、负类）。 */
  trained: { positive: number; negative: number };
}

export const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

const logitOf = (model: LogReg, f: Features): number => {
  let acc = model.bias;
  for (const bucket of f.buckets) acc += model.weights[bucket] * f.value;
  return acc;
};

/** 交叉熵 −[y ln p + (1−y) ln(1−p)]，p 夹在 [1e-12, 1 − 1e-12]。 */
const crossEntropy = (y: number, p: number) => {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
};

/** 训练：特征只算一次；每一轮按 mulberry32(seed + 轮次) 打乱顺序，逐个样本做梯度下降（权重衰减只作用在出现的桶上；正类样本的梯度乘 positiveWeight）。 */
export function trainLogReg(samples: readonly Sample[], options: TrainOptions = {}): LogReg {
  const o: Required<TrainOptions> = { ...DEFAULT_TRAIN, ...options };
  if (!samples.length) throw new Error('没有训练样本');
  const feats = samples.map((s) => featuresOf(s.text, o.dims, o.ns));
  const model: LogReg = {
    options: o,
    weights: new Float64Array(o.dims),
    bias: 0,
    losses: [],
    trained: { positive: samples.filter((s) => s.label === 1).length, negative: samples.filter((s) => s.label === 0).length },
  };
  const order = samples.map((_, i) => i);
  const w = o.positiveWeight === 'balanced' ? model.trained.negative / Math.max(1, model.trained.positive) : o.positiveWeight;
  // 热循环：桶号放进 Int32Array，学习率等提到局部变量。每一步的浮点运算和顺序与逐条写的公式完全相同
  // （logit 从 bias 开始按桶号升序累加；损失从 0 开始按样本顺序累加），结果逐位一致。
  const { lr, l2 } = o;
  const weights = model.weights;
  const buckets = feats.map((f) => Int32Array.from(f.buckets));
  const values = feats.map((f) => f.value);
  const labels = samples.map((s) => s.label);
  const logit = (i: number, bias: number): number => {
    const b = buckets[i];
    const v = values[i];
    let acc = bias;
    for (let k = 0; k < b.length; k++) acc += weights[b[k]] * v;
    return acc;
  };
  let bias = 0;
  for (let epoch = 0; epoch < o.epochs; epoch++) {
    const rand = mulberry32(o.seed + epoch);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    for (const index of order) {
      const label = labels[index];
      const g = (sigmoid(logit(index, bias)) - label) * (label === 1 ? w : 1);
      const b = buckets[index];
      const v = values[index];
      for (let k = 0; k < b.length; k++) weights[b[k]] -= lr * (g * v + l2 * weights[b[k]]);
      bias -= lr * g;
    }
    let loss = 0;
    for (let i = 0; i < samples.length; i++) loss += crossEntropy(labels[i], sigmoid(logit(i, bias)));
    model.losses.push(loss / samples.length);
  }
  model.bias = bias;
  return model;
}

export interface Contribution {
  bucket: number;
  /** 这个桶的权重 × 特征值：对 logit 的贡献。 */
  amount: number;
  weight: number;
  /** 这条文字里落进这个桶的片段。 */
  grams: string[];
}

export interface Prediction {
  /** 正类的概率。 */
  p: number;
  logit: number;
  bias: number;
  /** 每个出现的桶对 logit 的贡献，按绝对值从大到小。 */
  contributions: Contribution[];
  features: Features;
}

/** 只要正类概率时用它：等于 predict(model, text).p，但不算每个桶的贡献、不排序。 */
export function probability(model: LogReg, text: string): number {
  return sigmoid(logitOf(model, featuresOf(text, model.options.dims, model.options.ns)));
}

/** 预测一条文字：概率、logit，以及每个桶的贡献（能说清楚「为什么判成注入」）。 */
export function predict(model: LogReg, text: string): Prediction {
  const f = featuresOf(text, model.options.dims, model.options.ns);
  const contributions = f.buckets
    .map((bucket) => ({ bucket, amount: model.weights[bucket] * f.value, weight: model.weights[bucket], grams: f.grams.get(bucket)! }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.bucket - b.bucket);
  const logit = logitOf(model, f);
  return { p: sigmoid(logit), logit, bias: model.bias, contributions, features: f };
}

/** 权重最大的几个桶（正的是「像正类」，负的是「像负类」），以及训练集里落进去的片段。 */
export function topWeights(model: LogReg, samples: readonly Sample[], k = 8, sign: 1 | -1 = 1): Array<{ bucket: number; weight: number; grams: string[] }> {
  const grams = new Map<number, Set<string>>();
  for (const s of samples) for (const [bucket, list] of featuresOf(s.text, model.options.dims, model.options.ns).grams) {
    const set = grams.get(bucket) ?? new Set<string>();
    list.forEach((g) => set.add(g));
    grams.set(bucket, set);
  }
  return [...model.weights.entries()]
    .map(([bucket, weight]) => ({ bucket, weight, grams: [...(grams.get(bucket) ?? [])] }))
    .sort((a, b) => sign * (b.weight - a.weight) || a.bucket - b.bucket)
    .slice(0, k);
}
