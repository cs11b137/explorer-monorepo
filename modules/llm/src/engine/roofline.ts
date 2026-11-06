/**
 * 推理组课程用的「账本」：参数量、FLOPs、读权重的字节数、KV cache 的字节数、roofline 时间下限。
 *
 * 同一套公式既用于迷你模型（结果和 forward 的 FlopMeter 逐位核对，tests/engine.test.ts），
 * 也用于外推到真实规模的公开模型配置。FLOPs 的约定和 model/tensor.ts 一致：只计乘加，每次乘加 2 FLOPs。
 */
import { KVCache, type ModelConfig, type Weights } from '../model/transformer';

/** decoder-only（LLaMA 结构）的形状。GQA 时 kvHeads < heads，K、V 投影只有 kvHeads × headDim 行。 */
export interface ArchConfig {
  name: string;
  layers: number;
  dModel: number;
  heads: number;
  kvHeads: number;
  headDim: number;
  /** SwiGLU 隐层宽度。 */
  ffn: number;
  vocab: number;
  /** 上下文窗口（位置数）。 */
  context: number;
}

/**
 * Llama 3 8B 的公开配置（Hugging Face config.json）：32 层，hidden 4096，32 个注意力头、8 个 KV 头（GQA），
 * head_dim 128，intermediate 14336，词表 128256，max_position_embeddings 8192；嵌入表和输出层不共享。
 * Llama 3.1 8B 形状相同，上下文窗口扩到 131072。
 */
export const LLAMA3_8B: ArchConfig = { name: 'Llama 3 8B', layers: 32, dModel: 4096, heads: 32, kvHeads: 8, headDim: 128, ffn: 14336, vocab: 128256, context: 8192 };
export const LLAMA31_CONTEXT = 131072;

/** 迷你模型换成同一种描述，公式就能同时套在两边。 */
export function archOf(config: ModelConfig, name = '迷你模型'): ArchConfig {
  return { name, layers: config.nLayers, dModel: config.dModel, heads: config.nHeads, kvHeads: config.nHeads, headDim: config.headDim, ffn: config.dFF, vocab: config.vocab, context: config.maxSeq };
}

export interface ParamBreakdown {
  /** 嵌入表 vocab × d。 */
  embed: number;
  /** 每层参与矩阵乘的参数：Q、K、V、O 和 SwiGLU 的三个矩阵。 */
  layerMatmul: number;
  /** 每层 RMSNorm 的 γ（2 个）。 */
  layerNorm: number;
  /** 输出层 vocab × d。 */
  lmHead: number;
  finalNorm: number;
  total: number;
}

export function paramsOf(arch: ArchConfig): ParamBreakdown {
  const { dModel: d, heads, kvHeads, headDim, ffn, vocab, layers } = arch;
  const q = d * heads * headDim;
  const kv = 2 * d * kvHeads * headDim;
  const o = heads * headDim * d;
  const layerMatmul = q + kv + o + 3 * d * ffn;
  const layerNorm = 2 * d;
  const embed = vocab * d;
  const lmHead = vocab * d;
  return { embed, layerMatmul, layerNorm, lmHead, finalNorm: d, total: embed + layers * (layerMatmul + layerNorm) + lmHead + d };
}

/** 一次前向处理位置 start..start+n−1 的 FLOPs，分成矩阵乘、注意力、输出层。 */
export interface FlopBreakdown {
  /** 各层的线性投影（Q K V O、FFN）：每个位置 2 × 每层矩阵参数 × 层数。 */
  linear: number;
  /** 注意力的打分和加权求和：位置 p 看 p+1 个位置，每层每头 2 × 2 × headDim × (p+1)。 */
  attention: number;
  /** 输出层。lastOnly 时只算最后一个位置。 */
  lmHead: number;
  total: number;
}

export function forwardFlops(arch: ArchConfig, start: number, n: number, lastOnly = true): FlopBreakdown {
  const p = paramsOf(arch);
  const linear = 2 * p.layerMatmul * arch.layers * n;
  // Σ_{pos=start}^{start+n−1} (pos+1)
  const seen = n * start + (n * (n + 1)) / 2;
  const attention = 4 * arch.heads * arch.headDim * arch.layers * seen;
  const lmHead = 2 * p.lmHead * (lastOnly ? 1 : n);
  return { linear, attention, lmHead, total: linear + attention + lmHead };
}

/**
 * 一次前向要从显存读出的权重字节：每层的矩阵和输出层整块读一遍（矩阵乘的每一行都要用到），
 * 嵌入表只读用到的 n 行，RMSNorm 的 γ 很小也计上。不管这次前向处理 1 个还是 n 个位置，矩阵都只读一遍：
 * 这就是预填充的算术强度比解码高的原因。
 */
export function weightBytesRead(arch: ArchConfig, n: number, bytesPerWeight: number): number {
  const p = paramsOf(arch);
  return (arch.layers * (p.layerMatmul + p.layerNorm) + p.lmHead + p.finalNorm + n * arch.dModel) * bytesPerWeight;
}

/** 迷你模型的版本，直接从权重的形状数：和 paramsOf 的公式互相核对。 */
export function miniWeightBytesRead(W: Weights, n: number, bytesPerWeight: number): number {
  let values = W.output.length * W.output[0].length + W.output_norm.length + n * W.config.dModel;
  for (const layer of W.layers) {
    for (const value of Object.values(layer) as Array<number[] | number[][]>) values += Array.isArray(value[0]) ? (value as number[][]).length * (value as number[][])[0].length : value.length;
  }
  return values * bytesPerWeight;
}

/** 每个 token 的 KV cache 字节数：2（K 和 V）× 层数 × KV 头数 × head_dim × 每个数的字节数。 */
export const kvBytesPerToken = (arch: ArchConfig, bytesPerValue: number): number => 2 * arch.layers * arch.kvHeads * arch.headDim * bytesPerValue;

/** 迷你模型用 KVCache.valuesPerToken 得到同一个数，两边核对。 */
export const miniKvBytesPerToken = (config: ModelConfig, bytesPerValue: number): number => KVCache.valuesPerToken(config) * bytesPerValue;

/** 一块 GPU 的两个上限：算力和显存带宽。 */
export interface GpuSpec {
  name: string;
  /** 每秒 FLOPs（稠密，不含稀疏加速）。 */
  flops: number;
  /** 显存带宽，字节 / 秒。 */
  bandwidth: number;
  /** 显存容量，字节。 */
  memory: number;
}

/** NVIDIA H100 SXM5 80GB 规格表：BF16 Tensor Core 稠密 989 TFLOPS（表上 1979 是含稀疏的数），HBM3 3.35 TB/s。 */
export const H100: GpuSpec = { name: 'H100 SXM', flops: 989e12, bandwidth: 3.35e12, memory: 80e9 };

export interface Roofline {
  /** 只受算力限制时的时间（秒）。 */
  compute: number;
  /** 只受带宽限制时的时间（秒）。 */
  memory: number;
  /** 两者取大：理论下限。 */
  time: number;
  bound: 'compute' | 'memory';
  /** 算术强度：FLOPs / 字节。 */
  intensity: number;
}

/** roofline 模型：算和读可以重叠，所以时间下限是两者中较大的那个。 */
export function roofline(flops: number, bytes: number, gpu: GpuSpec): Roofline {
  const compute = flops / gpu.flops;
  const memory = bytes / gpu.bandwidth;
  return { compute, memory, time: Math.max(compute, memory), bound: compute >= memory ? 'compute' : 'memory', intensity: flops / bytes };
}

/** GPU 的「拐点」：算术强度高于它就是算力受限，低于它就是访存受限。 */
export const ridgePoint = (gpu: GpuSpec): number => gpu.flops / gpu.bandwidth;

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
export const KiB = 1024;
