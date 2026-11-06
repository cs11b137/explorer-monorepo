/**
 * IEEE 754 浮点的位模式和小端字节（fp32 / fp16 / bf16），以及 int32 小端。
 * LLM EXPLORER 的数值格式课、量化课和 RAG EXPLORER 的向量编码共用（原来在 modules/llm/src/model/numeric.ts，抽到这里，行为不变）。
 *
 * - fp32：IEEE 754 binary32。
 * - fp16：IEEE 754 binary16，由 fp32 按「就近舍入、平局取偶」得到（和 ggml 的 GGML_FP32_TO_FP16、numpy 的 astype(float16) 一致）。
 * - bf16：fp32 的高 16 位，就近舍入、平局取偶（和 PyTorch、ggml 一致）。
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
