/**
 * 数值格式的真实编码，逐字节解码和量化课用。全部是小端。
 *
 * - fp32：IEEE 754 binary32。
 * - fp16：IEEE 754 binary16，由 fp32 按「就近舍入、平局取偶」得到（和 ggml 的 GGML_FP32_TO_FP16 一致）。
 * - bf16：fp32 的高 16 位，就近舍入、平局取偶（和 PyTorch、ggml 一致）。
 * - Q8_0：GGUF 的 8 位块量化。每 32 个值一块：fp16 的 d = absmax / 127，加 32 个 int8，共 34 字节。
 * - Q4_0：GGUF 的 4 位块量化。每 32 个值一块：fp16 的 d = max / −8（max 是绝对值最大的那个数，带符号），
 *   加 16 字节，每字节低 4 位放第 j 个值、高 4 位放第 j+16 个值，存 q + 8（0–15），共 18 字节。
 *   这些和 ggml-quants.c 的 quantize_row_q4_0_ref / quantize_row_q8_0_ref 一致，
 *   tests/vectors/quant.json 是用 ggml 官方的 gguf-py（numpy 实现）独立算出的。
 */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** fp32 的位模式。输入先按 fp32 舍入。 */
export function f32Bits(value: number): number {
  f32[0] = value;
  return u32[0];
}

export function f32FromBits(bits: number): number {
  u32[0] = bits >>> 0;
  return f32[0];
}

const le = (bits: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (bits >>> (i * 8)) & 0xff);

export const f32Bytes = (value: number): number[] => le(f32Bits(value), 4);

/** fp32 → fp16 位模式，就近舍入、平局取偶；溢出变 ±∞，过小变 ±0 或次正规数。 */
export function f16Bits(value: number): number {
  const bits = f32Bits(value);
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  const mant = bits & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 | (mant >>> 13) : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    // 次正规数：带上隐含的 1，右移到 2^-24 的单位上。
    const shift = 14 - e;
    if (shift > 24) return sign;
    const m = mant | 0x800000;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // 进位可以一路进到指数，最大值以上自然变成 0x7c00（∞）。
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

export function f16FromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** 按 fp16 舍入后的值。 */
export const f16Round = (value: number): number => f16FromBits(f16Bits(value));
export const f16Bytes = (value: number): number[] => le(f16Bits(value), 2);

/** fp32 → bf16 位模式：加上 0x7fff 和保留位的最低位，再取高 16 位，就是平局取偶。NaN 保持为安静 NaN。 */
export function bf16Bits(value: number): number {
  const bits = f32Bits(value);
  if ((bits & 0x7fffffff) > 0x7f800000) return ((bits >>> 16) | 0x40) & 0xffff;
  return ((bits + 0x7fff + ((bits >>> 16) & 1)) >>> 16) & 0xffff;
}

export const bf16FromBits = (bits: number): number => f32FromBits((bits & 0xffff) << 16);
export const bf16Round = (value: number): number => bf16FromBits(bf16Bits(value));
export const bf16Bytes = (value: number): number[] => le(bf16Bits(value), 2);

/** int32 小端，token id 数组用。 */
export const i32Bytes = (value: number): number[] => le(value | 0, 4);

// ---------- GGUF 块量化 ----------

/** Q4_0 / Q8_0 每块的值个数。 */
export const QK = 32;

export interface Q8Block {
  /** fp16 的缩放因子 d 的位模式。 */
  d: number;
  /** 32 个 int8，原值 ≈ q · d。 */
  qs: number[];
}

export interface Q4Block {
  d: number;
  /** 32 个无符号 4 位数（0–15），原值 ≈ (q − 8) · d。下标就是原值的下标。 */
  q: number[];
  /** 打包后的 16 字节：qs[j] = q[j] | q[j + 16] << 4。 */
  qs: number[];
}

const blocks = (values: readonly number[]): number[][] => {
  if (values.length % QK) throw new Error(`长度 ${values.length} 不是 ${QK} 的倍数`);
  return Array.from({ length: values.length / QK }, (_, i) => values.slice(i * QK, (i + 1) * QK).map(Math.fround));
};

/** C 的 roundf：一半时远离 0。 */
const roundAway = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

export function quantizeQ8_0(values: readonly number[]): Q8Block[] {
  return blocks(values).map((x) => {
    const amax = Math.max(...x.map(Math.abs));
    const d = Math.fround(amax / 127);
    const id = d ? Math.fround(1 / d) : 0;
    return { d: f16Bits(d), qs: x.map((value) => roundAway(Math.fround(value * id))) };
  });
}

export function dequantizeQ8_0(blocksIn: readonly Q8Block[]): number[] {
  return blocksIn.flatMap((block) => {
    const d = f16FromBits(block.d);
    return block.qs.map((q) => Math.fround(q * d));
  });
}

export function quantizeQ4_0(values: readonly number[]): Q4Block[] {
  return blocks(values).map((x) => {
    let amax = 0;
    let max = 0;
    for (const value of x) {
      if (amax < Math.abs(value)) {
        amax = Math.abs(value);
        max = value;
      }
    }
    const d = Math.fround(max / -8);
    const id = d ? Math.fround(1 / d) : 0;
    // (int8_t)(x·id + 8.5f) 向零截断，再和 15 取小。
    const q = x.map((value) => Math.min(15, Math.trunc(Math.fround(Math.fround(value * id) + 8.5))));
    const qs = Array.from({ length: QK / 2 }, (_, j) => q[j] | (q[j + QK / 2] << 4));
    return { d: f16Bits(d), q, qs };
  });
}

export function dequantizeQ4_0(blocksIn: readonly Q4Block[]): number[] {
  return blocksIn.flatMap((block) => {
    const d = f16FromBits(block.d);
    return block.q.map((q) => Math.fround((q - 8) * d));
  });
}

/** 一块 Q8_0 的 34 个字节：d（fp16）在前，然后是 32 个 int8。 */
export const q8_0Bytes = (block: Q8Block): number[] => [...le(block.d, 2), ...block.qs.map((q) => q & 0xff)];
/** 一块 Q4_0 的 18 个字节：d（fp16）在前，然后是 16 个打包字节。 */
export const q4_0Bytes = (block: Q4Block): number[] => [...le(block.d, 2), ...block.qs];

export type Format = 'f32' | 'f16' | 'bf16' | 'q8_0' | 'q4_0';

/** 每个权重平均占多少字节（含块里的缩放因子）。 */
export const BYTES_PER_WEIGHT: Record<Format, number> = { f32: 4, f16: 2, bf16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/** 一组数在某种格式下的字节，长度不是 32 倍数时量化格式会报错。 */
export function encodeAs(format: Format, values: readonly number[]): number[] {
  if (format === 'f32') return values.flatMap(f32Bytes);
  if (format === 'f16') return values.flatMap(f16Bytes);
  if (format === 'bf16') return values.flatMap(bf16Bytes);
  if (format === 'q8_0') return quantizeQ8_0(values).flatMap(q8_0Bytes);
  return quantizeQ4_0(values).flatMap(q4_0Bytes);
}

/** 编码再解码回来的值，量化误差 = 它和原值之差。 */
export function roundTrip(format: Format, values: readonly number[]): number[] {
  if (format === 'f32') return values.map(Math.fround);
  if (format === 'f16') return values.map(f16Round);
  if (format === 'bf16') return values.map(bf16Round);
  if (format === 'q8_0') return dequantizeQ8_0(quantizeQ8_0(values));
  return dequantizeQ4_0(quantizeQ4_0(values));
}
