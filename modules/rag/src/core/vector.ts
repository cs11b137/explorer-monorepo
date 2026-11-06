/**
 * 向量运算和向量的字节编码。
 *
 * - 相似度：点积、余弦、（平方）欧氏距离。向量 L2 归一化之后 ‖a − b‖² = 2 − 2·cos(a, b)，点积就是余弦，
 *   所以三种度量给出的排序完全一致（`relation` 返回三者，测试核对）。真实的嵌入 API（如 OpenAI）返回的向量已归一化。
 * - 字节：float32 / float16 小端（IEEE 754，公开格式），int8 标量量化（每个向量一个缩放系数，本站写法），
 *   以及 base64（RFC 4648），OpenAI embeddings 的 `encoding_format: "base64"` 返回的就是 float32 小端字节的 base64。
 *
 * 数值：向量按 fp32 存（Math.fround），累加在 float64 里做，和 LLM EXPLORER 的约定一致。
 */
import { f16Bits, f16FromBits, f32Bits, f32FromBits } from '@explorer/llm-core/float';

export type Vec = number[];

export const dot = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) throw new Error(`维度不一致：${a.length} 和 ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

export const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));

/** L2 归一化，结果按 fp32 舍入。零向量原样返回（全是 0）。 */
export function normalize(a: readonly number[]): Vec {
  const n = norm(a);
  return a.map((x) => Math.fround(n ? x / n : 0));
}

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  const d = norm(a) * norm(b);
  return d ? dot(a, b) / d : 0;
};

/** 平方欧氏距离（FAISS 的 IndexFlatL2 返回的就是平方距离，省掉开方不影响排序）。 */
export const l2sq = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length) throw new Error(`维度不一致：${a.length} 和 ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum;
};

export const l2 = (a: readonly number[], b: readonly number[]): number => Math.sqrt(l2sq(a, b));

/** 度量：ip 点积（越大越近）、cosine 余弦（越大越近）、l2 平方欧氏距离（越小越近）。 */
export type Metric = 'ip' | 'cosine' | 'l2';

/** 度量的原始值：点积、余弦，或平方欧氏距离。 */
export function metricValue(metric: Metric, a: readonly number[], b: readonly number[]): number {
  if (metric === 'ip') return dot(a, b);
  if (metric === 'cosine') return cosine(a, b);
  return l2sq(a, b);
}

/** 排序键：越大越近。l2 取负号，三种度量可以用同一个排序。 */
export const closeness = (metric: Metric, a: readonly number[], b: readonly number[]): number => (metric === 'l2' ? -l2sq(a, b) : metricValue(metric, a, b));

/** 两个向量的三种度量，以及它们是否都是单位向量。归一化后 l2sq = 2 − 2·dot。 */
export function relation(a: readonly number[], b: readonly number[]): { dot: number; cosine: number; l2sq: number; unit: boolean } {
  const unit = Math.abs(norm(a) - 1) < 1e-6 && Math.abs(norm(b) - 1) < 1e-6;
  return { dot: dot(a, b), cosine: cosine(a, b), l2sq: l2sq(a, b), unit };
}

// ---------- 字节编码 ----------

const le = (bits: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (bits >>> (i * 8)) & 0xff);

/** float32 小端字节：每个数 4 字节。 */
export const f32VectorBytes = (v: readonly number[]): number[] => v.flatMap((x) => le(f32Bits(x), 4));

/** float16 小端字节：每个数 2 字节（就近舍入、平局取偶）。 */
export const f16VectorBytes = (v: readonly number[]): number[] => v.flatMap((x) => le(f16Bits(x), 2));

/** float16 存进去再读出来的值（舍入误差 = 它和原值之差）。 */
export const f16RoundTrip = (v: readonly number[]): Vec => v.map((x) => f16FromBits(f16Bits(x)));

/** 从 float32 小端字节读回向量。 */
export function f32FromVectorBytes(bytes: readonly number[]): Vec {
  if (bytes.length % 4) throw new Error('float32 字节数必须是 4 的倍数');
  return Array.from({ length: bytes.length / 4 }, (_, i) => f32FromBits(bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24)));
}

export interface Int8Vector {
  /** 每个分量的 int8 码，−127..127。 */
  codes: number[];
  /** 缩放系数：值 ≈ code × scale。scale = 最大绝对值 / 127。 */
  scale: number;
}

/**
 * int8 标量量化：对称、每个向量一个缩放系数（absmax / 127，fp32），就近取整（远离 0）。
 * 这是本站的写法：真实产品各有各的做法（有的按整个数据集统计取值范围，有的存成 uint8 加偏移），只取「4 字节变 1 字节、误差有界」这一点。
 */
export function quantizeInt8(v: readonly number[]): Int8Vector {
  const absmax = Math.max(...v.map(Math.abs));
  const scale = Math.fround(absmax / 127);
  const codes = v.map((x) => (scale ? Math.max(-127, Math.min(127, Math.sign(x) * Math.round(Math.abs(x) / scale))) : 0));
  return { codes, scale };
}

export const dequantizeInt8 = (q: Int8Vector): Vec => q.codes.map((code) => Math.fround(code * q.scale));

/** int8 码的字节（补码）。 */
export const int8Bytes = (q: Int8Vector): number[] => q.codes.map((code) => code & 0xff);

/** 每个分量占的字节数。 */
export const BYTES_PER_DIM = { f32: 4, f16: 2, int8: 1 } as const;

// ---------- base64（RFC 4648 §4，带 = 填充） ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function base64Decode(text: string): number[] {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) throw new Error(`不是 base64 字符：${char}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * fp32 值在 JSON 里的最短写法：取最少的有效数字，使它按 fp32 读回来还是同一个数（最多 9 位）。
 * 返回一个 double，JSON.stringify 写出来就是这个短写法。真实 API 的 JSON 里浮点数就是这样的短写法（比如 -0.006929283）。
 */
export function f32Json(x: number): number {
  const f = Math.fround(x);
  if (f === 0) return 0;
  for (let p = 1; p <= 9; p++) {
    const short = Number(f.toPrecision(p));
    if (Math.fround(short) === f) return short;
  }
  return f;
}
