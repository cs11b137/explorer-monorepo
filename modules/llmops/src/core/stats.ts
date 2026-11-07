/**
 * 评估和监控用的统计：混淆矩阵、精确率 / 召回率 / F1、Wilson 区间、Cohen's kappa、精确二项检验（McNemar、符号检验）、
 * 固定种子的 bootstrap、分位数、AUC、OTel 显式桶直方图。全部是确定性的纯函数，测试用手算或文献里的例子核对。
 *
 * 约定：
 * - 0 / 0 的比例（没有预测为正时的精确率等）记为 0，并在 `Metrics.undefinedOf` 里标出来，课程文案要说明；
 * - 分位数用线性插值（Hyndman–Fan 第 7 种，NumPy、R 的默认写法）；另给最近秩法（nearestRank），两者在小样本时差别明显；
 * - 随机数一律来自 llm-core 的 mulberry32，种子写在调用处。
 */
import { mulberry32 } from '@explorer/llm-core/prng';

// ---------- 混淆矩阵 ----------

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** 二分类的混淆矩阵：actual、predicted 一一对应，true 是正类（比如「是注入」）。 */
export function confusion(actual: readonly boolean[], predicted: readonly boolean[]): Confusion {
  if (actual.length !== predicted.length) throw new Error('actual 和 predicted 长度不同');
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  actual.forEach((a, i) => {
    const p = predicted[i];
    if (a && p) c.tp++;
    else if (!a && p) c.fp++;
    else if (a && !p) c.fn++;
    else c.tn++;
  });
  return c;
}

export interface Metrics {
  n: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** 误报率 FP / (FP + TN)。 */
  fpr: number;
  /** 特异度 TN / (FP + TN)。 */
  specificity: number;
  /** 分母为 0、按 0 记的指标。 */
  undefinedOf: string[];
}

const ratio = (a: number, b: number, name: string, undef: string[]) => {
  if (b === 0) {
    undef.push(name);
    return 0;
  }
  return a / b;
};

/** 精确率 TP/(TP+FP)、召回率 TP/(TP+FN)、F1 = 2PR/(P+R)、准确率、误报率、特异度。 */
export function metricsOf(c: Confusion): Metrics {
  const undef: string[] = [];
  const precision = ratio(c.tp, c.tp + c.fp, 'precision', undef);
  const recall = ratio(c.tp, c.tp + c.fn, 'recall', undef);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const n = c.tp + c.fp + c.fn + c.tn;
  return {
    n,
    precision,
    recall,
    f1,
    accuracy: ratio(c.tp + c.tn, n, 'accuracy', undef),
    fpr: ratio(c.fp, c.fp + c.tn, 'fpr', undef),
    specificity: ratio(c.tn, c.fp + c.tn, 'specificity', undef),
    undefinedOf: undef,
  };
}

export interface SweepRow {
  threshold: number;
  confusion: Confusion;
  metrics: Metrics;
}

/** 阈值扫描：分数 ≥ 阈值判为正类。 */
export function thresholdSweep(scores: readonly number[], labels: readonly boolean[], thresholds: readonly number[]): SweepRow[] {
  return thresholds.map((threshold) => {
    const c = confusion(labels, scores.map((score) => score >= threshold));
    return { threshold, confusion: c, metrics: metricsOf(c) };
  });
}

/** ROC 曲线下面积：随机取一个正例和一个负例，正例分数更高的概率（同分算一半，Mann–Whitney U / (n₊ n₋)）。 */
export function rocAuc(scores: readonly number[], labels: readonly boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) throw new Error('AUC 需要正例和负例');
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// ---------- 比例的置信区间 ----------

/** 标准正态分布 97.5% 分位数，95% 双侧区间用它。 */
export const Z95 = 1.959963984540054;

export interface Interval {
  /** 点估计 k / n。 */
  estimate: number;
  lo: number;
  hi: number;
}

/**
 * Wilson 得分区间（Wilson 1927）：(p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)。
 * 小样本、比例接近 0 或 1 时比正态近似（Wald）可靠得多：k = 0 时 Wald 区间退化成一个点，Wilson 不会。
 */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (n <= 0) throw new Error('n 必须大于 0');
  if (k < 0 || k > n) throw new Error('k 必须在 0 到 n 之间');
  const p = k / n;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { estimate: p, lo: Math.max(0, (center - half) / denom), hi: Math.min(1, (center + half) / denom) };
}

/** 正态近似（Wald）区间 p̂ ± z√(p̂(1−p̂)/n)，只用来和 Wilson 对比。 */
export function waldInterval(k: number, n: number, z = Z95): Interval {
  const p = k / n;
  const half = z * Math.sqrt((p * (1 - p)) / n);
  return { estimate: p, lo: Math.max(0, p - half), hi: Math.min(1, p + half) };
}

// ---------- 二项分布和精确检验 ----------

/** ln(n!)，n 较小时逐项相加，足够精确。 */
function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

/** 二项分布的概率 P(X = k)，X ~ B(n, p)。 */
export function binomPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** P(X ≤ k)。 */
export function binomCdf(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = 0; i <= Math.min(k, n); i++) sum += binomPmf(i, n, p);
  return Math.min(1, sum);
}

/**
 * 精确二项检验的双侧 p 值（H0：成功概率是 p）：把所有概率不大于观测值概率的结果加起来（R 的 binom.test 的写法）。
 * p = 0.5 时等于 2 × min(P(X ≤ k), P(X ≥ k))，上限 1。
 */
export function binomTwoSided(k: number, n: number, p = 0.5): number {
  if (n === 0) return 1;
  const observed = binomPmf(k, n, p);
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const pi = binomPmf(i, n, p);
    if (pi <= observed * (1 + 1e-7)) sum += pi;
  }
  return Math.min(1, sum);
}

export interface PairedTest {
  /** 只有 A 对（或 A 更好）的个数。 */
  b: number;
  /** 只有 B 对（或 B 更好）的个数。 */
  c: number;
  /** 两边一样、不参与检验的个数。 */
  ties: number;
  /** 精确双侧 p 值。 */
  p: number;
}

/**
 * McNemar 检验的精确版本（配对的通过 / 不通过）：只看结果不一致的用例，b 个「改前过、改后不过」、c 个「改前不过、改后过」，
 * H0 下 b ~ B(b + c, 0.5)。回归测试比较改提示前后的同一个评估集用它。
 */
export function mcnemarExact(before: readonly boolean[], after: readonly boolean[]): PairedTest {
  if (before.length !== after.length) throw new Error('两次运行的用例数不同');
  let b = 0;
  let c = 0;
  before.forEach((x, i) => {
    if (x && !after[i]) b++;
    else if (!x && after[i]) c++;
  });
  return { b, c, ties: before.length - b - c, p: binomTwoSided(b, b + c, 0.5) };
}

/** 符号检验：配对差值大于 0 的记一个正、小于 0 的记一个负，0 丢掉；H0 下正的个数 ~ B(正 + 负, 0.5)。b 是正的个数，c 是负的个数。 */
export function signTest(diffs: readonly number[]): PairedTest {
  const b = diffs.filter((d) => d > 0).length;
  const c = diffs.filter((d) => d < 0).length;
  return { b, c, ties: diffs.length - b - c, p: binomTwoSided(b, b + c, 0.5) };
}

// ---------- 一致性 ----------

export interface Kappa {
  labels: string[];
  /** table[i][j]：甲标 labels[i]、乙标 labels[j] 的个数。 */
  table: number[][];
  /** 观测一致率。 */
  po: number;
  /** 按各自的边际分布算的偶然一致率。 */
  pe: number;
  kappa: number;
}

/** Cohen's kappa：κ = (po − pe) / (1 − pe)。两人标同一批样本，标签可以多于两类。pe = 1 时（两人都只用一个标签）κ 记为 1。 */
export function cohenKappa(a: readonly string[], b: readonly string[], labels?: readonly string[]): Kappa {
  if (a.length !== b.length || !a.length) throw new Error('两组标注长度要相同且不为空');
  const set = labels ? [...labels] : [...new Set([...a, ...b])].sort();
  const index = new Map(set.map((label, i) => [label, i]));
  const k = set.length;
  const table: number[][] = [];
  for (let i = 0; i < k; i++) table.push(new Array<number>(k).fill(0));
  for (let i = 0; i < a.length; i++) table[index.get(a[i])!][index.get(b[i])!]++;
  return { labels: set, table, ...kappaOfTable(table, a.length) };
}

/**
 * 从 k × k 列联表算 po、pe、κ（cohenKappa 的后半段）。n 是样本数（表里各格之和）。
 * bootstrap 里一次要算几千遍，调用方可以自己数表、直接调它，省掉标签查表；结果和 cohenKappa 逐位相同。
 */
export function kappaOfTable(table: readonly (readonly number[])[], n: number): { po: number; pe: number; kappa: number } {
  const k = table.length;
  // 加法顺序和逐项 reduce 相同：对角线从 0 开始逐个加；pe 逐个类别加 (行和 / n)·(列和 / n)。
  let diagonal = 0;
  for (let i = 0; i < k; i++) diagonal += table[i][i];
  const po = diagonal / n;
  let pe = 0;
  for (let i = 0; i < k; i++) {
    let rowSum = 0;
    let colSum = 0;
    for (let j = 0; j < k; j++) {
      rowSum += table[i][j];
      colSum += table[j][i];
    }
    pe += (rowSum / n) * (colSum / n);
  }
  return { po, pe, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

export interface WeightedKappa extends Kappa {
  scheme: 'linear' | 'quadratic';
  /** 加权的观测不一致和期望不一致：Σ wᵢⱼ·Oᵢⱼ / n、Σ wᵢⱼ·rowᵢ·colⱼ / n²。 */
  observed: number;
  expected: number;
}

/**
 * 加权 kappa（有序标签）：κw = 1 − Σ wᵢⱼ Oᵢⱼ / Σ wᵢⱼ Eᵢⱼ。labels 必须按顺序给出（比如 差、可接受、好），
 * 不一致的权重 wᵢⱼ 是 |i − j|（linear）或 (i − j)²（quadratic），对角线为 0；E 是两人各自边际分布的外积。
 * 返回的 po、pe、kappa 字段里，kappa 是加权值，po、pe 和 table 与不加权的 Cohen's kappa 相同（方便并排对比）。期望不一致为 0 时 κw 记为 1。
 */
export function weightedKappa(a: readonly string[], b: readonly string[], labels: readonly string[], scheme: 'linear' | 'quadratic' = 'linear'): WeightedKappa {
  const base = cohenKappa(a, b, labels);
  const k = labels.length;
  const n = a.length;
  const w = (i: number, j: number) => (scheme === 'linear' ? Math.abs(i - j) : (i - j) ** 2);
  const rows = base.table.map((row) => row.reduce((x, y) => x + y, 0));
  const cols = labels.map((_, j) => base.table.reduce((x, row) => x + row[j], 0));
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      observed += (w(i, j) * base.table[i][j]) / n;
      expected += (w(i, j) * rows[i] * cols[j]) / (n * n);
    }
  }
  return { ...base, scheme, observed, expected, kappa: expected === 0 ? 1 : 1 - observed / expected };
}

/** Landis 和 Koch（1977）的文字分档（文献说这只是惯例，没有依据）。 */
export function kappaBand(kappa: number): string {
  if (kappa < 0) return '没有一致';
  if (kappa <= 0.2) return '轻微';
  if (kappa <= 0.4) return '一般';
  if (kappa <= 0.6) return '中等';
  if (kappa <= 0.8) return '相当';
  return '几乎完全';
}

// ---------- bootstrap ----------

export interface BootstrapResult {
  estimate: number;
  lo: number;
  hi: number;
  iterations: number;
  seed: number;
}

/**
 * 百分位 bootstrap：有放回地抽 n 个下标、算统计量，重复 iterations 次，取 2.5% 和 97.5% 分位数（线性插值）。
 * statistic 收到的是下标数组，配对数据（两列同一行）和 kappa 都能用。
 */
export function bootstrap(n: number, statistic: (indices: readonly number[]) => number, options: { iterations?: number; seed?: number; level?: number } = {}): BootstrapResult {
  const iterations = options.iterations ?? 2000;
  const seed = options.seed ?? 1;
  const level = options.level ?? 0.95;
  const rand = mulberry32(seed);
  const all = Array.from({ length: n }, (_, i) => i);
  const values: number[] = [];
  for (let r = 0; r < iterations; r++) {
    const pick: number[] = new Array(n);
    for (let i = 0; i < n; i++) pick[i] = Math.floor(rand() * n);
    values.push(statistic(pick));
  }
  values.sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  return { estimate: statistic(all), lo: quantileSorted(values, alpha), hi: quantileSorted(values, 1 - alpha), iterations, seed };
}

// ---------- 描述统计 ----------

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
export const mean = (values: readonly number[]): number => (values.length ? sum(values) / values.length : 0);

/** 样本标准差（n − 1）。 */
export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/** 已排好序的数组的 q 分位数（0–1），线性插值：位置 h = (n − 1)q。 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (!sorted.length) throw new Error('空数组没有分位数');
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]);
}

/** 分位数（会先排序，不改原数组）。 */
export const quantile = (values: readonly number[], q: number): number => quantileSorted([...values].sort((a, b) => a - b), q);

/** 最近秩法：排序后第 ⌈qn⌉ 个（从 1 数）。很多监控系统的「p99」是这种写法，结果一定是某个真实观测值。 */
export function nearestRank(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error('空数组没有分位数');
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

export interface Percentiles {
  n: number;
  mean: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** 延迟的常用摘要：p50、p95、p99（线性插值）、均值、最小、最大。 */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, mean: mean(sorted), min: sorted[0], p50: quantileSorted(sorted, 0.5), p95: quantileSorted(sorted, 0.95), p99: quantileSorted(sorted, 0.99), max: sorted[sorted.length - 1] };
}

/**
 * 显式桶直方图（OTLP 的 HistogramDataPoint）：bucket_counts 比 bounds 多一个；第 0 个桶是 (−∞, b₀]，
 * 第 i 个是 (bᵢ₋₁, bᵢ]，最后一个是 (bₙ₋₁, +∞)。上界包含在桶里（metrics.proto 的注释）。
 */
export function bucketCounts(values: readonly number[], bounds: readonly number[]): number[] {
  for (let i = 1; i < bounds.length; i++) if (!(bounds[i] > bounds[i - 1])) throw new Error('桶边界必须严格递增');
  const counts = new Array(bounds.length + 1).fill(0);
  for (const v of values) {
    let i = 0;
    while (i < bounds.length && v > bounds[i]) i++;
    counts[i]++;
  }
  return counts;
}
