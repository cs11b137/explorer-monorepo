/**
 * 最小的张量运算。向量是 number[]，矩阵是按行存放的 number[][]（W[out][in]，y = W·x）。
 *
 * 数值约定：权重和每一步的输出都按 fp32 舍入保存（Math.fround），累加在 float64 里做，
 * 相当于「fp32 存储、高精度累加」。所以课程里展示的 fp32 字节就是计算真正用到的值。
 *
 * FLOPs 约定（整站统一，轨迹表的「运算量」列用它）：只计乘加，每次乘加算 2 FLOPs，
 * 也就是矩阵乘和注意力里的点积、加权求和。RMSNorm、softmax、激活函数这些逐元素运算量级小得多，按惯例不计。
 */

export type Vec = number[];
export type Mat = number[][];

/** FLOPs 的分类，课程可以按类展示「这一步花在哪」。 */
export type FlopKind = 'qkv' | 'score' | 'mix' | 'wo' | 'ffn' | 'lmhead' | 'lora' | 'other';

/** 累计 FLOPs。传给 forward 等函数，它们按上面的约定往里加。 */
export class FlopMeter {
  total = 0;
  readonly by: Record<FlopKind, number> = { qkv: 0, score: 0, mix: 0, wo: 0, ffn: 0, lmhead: 0, lora: 0, other: 0 };

  add(kind: FlopKind, flops: number): void {
    this.total += flops;
    this.by[kind] += flops;
  }
}

/** fp32 舍入。fp64 模式（训练、梯度检查）下换成恒等函数。 */
export type Round = (value: number) => number;
export const FP32: Round = Math.fround;
export const FP64: Round = (value) => value;

export const zeros = (n: number): Vec => new Array<number>(n).fill(0);
export const zerosMat = (rows: number, cols: number): Mat => Array.from({ length: rows }, () => zeros(cols));

export function dot(a: Vec, b: Vec): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** y = W·x。W 是 out × in，计 2·out·in FLOPs。 */
export function matvec(w: Mat, x: Vec, round: Round = FP32, meter?: FlopMeter, kind: FlopKind = 'other'): Vec {
  const out = new Array<number>(w.length);
  for (let i = 0; i < w.length; i++) out[i] = round(dot(w[i], x));
  meter?.add(kind, 2 * w.length * x.length);
  return out;
}

/** y = Wᵀ·x，反向传播用。 */
export function matTvec(w: Mat, x: Vec): Vec {
  const out = zeros(w[0].length);
  for (let i = 0; i < w.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const row = w[i];
    for (let j = 0; j < row.length; j++) out[j] += row[j] * xi;
  }
  return out;
}

/** G += a ⊗ b（外积累加），反向传播用。 */
export function addOuter(g: Mat, a: Vec, b: Vec): void {
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    const row = g[i];
    for (let j = 0; j < b.length; j++) row[j] += ai * b[j];
  }
}

export const add = (a: Vec, b: Vec, round: Round = FP32): Vec => a.map((value, i) => round(value + b[i]));
export const mul = (a: Vec, b: Vec, round: Round = FP32): Vec => a.map((value, i) => round(value * b[i]));

export interface RmsNormResult {
  /** 归一化并乘上 γ 之后的输出。 */
  y: Vec;
  /** sqrt(mean(x²) + eps)，反向传播要用。 */
  rms: number;
}

/** RMSNorm：y = x / sqrt(mean(x²) + eps) ⊙ γ。LLaMA 系模型用它代替 LayerNorm（不减均值，没有偏置）。 */
export function rmsnorm(x: Vec, gamma: Vec, eps: number, round: Round = FP32): RmsNormResult {
  let sum = 0;
  for (const value of x) sum += value * value;
  const rms = Math.sqrt(sum / x.length + eps);
  return { y: x.map((value, i) => round((value / rms) * gamma[i])), rms };
}

/** 数值稳定的 softmax：先减最大值。-Infinity（被掩码的位置）得到 0。 */
export function softmax(x: Vec, round: Round = FP32): Vec {
  let max = -Infinity;
  for (const value of x) if (value > max) max = value;
  if (max === -Infinity) return x.map(() => 0);
  const exps = x.map((value) => (value === -Infinity ? 0 : Math.exp(value - max)));
  let sum = 0;
  for (const value of exps) sum += value;
  return exps.map((value) => round(value / sum));
}

export function logSumExp(x: Vec): number {
  let max = -Infinity;
  for (const value of x) if (value > max) max = value;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const value of x) if (value !== -Infinity) sum += Math.exp(value - max);
  return max + Math.log(sum);
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
/** SiLU（也叫 Swish）：z · σ(z)。SwiGLU 前馈网络的门控激活。 */
export const silu = (z: number): number => z * sigmoid(z);
/** SiLU 的导数：σ(z) · (1 + z · (1 − σ(z)))。 */
export const siluGrad = (z: number): number => {
  const s = sigmoid(z);
  return s * (1 + z * (1 - s));
};

/** 最大值的下标；并列时取下标最小的，保证确定。 */
export function argmax(x: Vec): number {
  let best = 0;
  for (let i = 1; i < x.length; i++) if (x[i] > x[best]) best = i;
  return best;
}

export const cloneMat = (m: Mat): Mat => m.map((row) => row.slice());
