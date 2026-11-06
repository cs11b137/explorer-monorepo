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

// fp32 / fp16 / bf16 的位模式在共享包里（RAG EXPLORER 的向量编码也用），这里转导出，接口不变。
import { bf16Bytes, bf16Round, f16Bits, f16Bytes, f16FromBits, f16Round, f32Bytes } from '@explorer/llm-core/float';
export * from '@explorer/llm-core/float';

const le = (bits: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (bits >>> (i * 8)) & 0xff);

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
