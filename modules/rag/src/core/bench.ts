/**
 * 规模实验用的合成数据集：知识库只有 27 个段落，几种索引的成本差别在这个规模上看不清，
 * 所以向量检索组的课程在最后一步把同样的索引放到 1000 个向量上跑一遍。
 *
 * 做法：第 i 个向量 = 第 (i mod 27) 个段落向量 + 每个分量独立的高斯噪声（标准差 σ），再 L2 归一化（fp32）。
 * 相当于每个段落有三十几个「说法略有不同」的近亲段落，簇的结构和知识库一致。随机数来自固定种子（mulberry32 + Box–Muller），
 * 结果逐位可复现。查询用 EVAL_SET 的 8 个问题，标准答案是暴力搜索的前 k 个（不记距离）。
 * 这是示例数据，不是真实语料；它只用来比较同一批数据上各种索引的距离计算次数、召回率和字节数。
 */
import { gaussian, mulberry32 } from '@explorer/llm-core/prng';
import { embedVector, PARAGRAPH_VECTORS } from './embed';
import { exactTopK } from './hybrid';
import { EVAL_SET } from './kb';
import { normalize, type Vec } from './vector';

export const BENCH_N = 1000;
/** 每个分量的噪声标准差。 */
export const BENCH_SIGMA = 0.12;
export const BENCH_SEED = 7;
/** 规模实验的召回率@k 用的 k。 */
export const BENCH_K = 10;

/** 合成 n 个向量：段落向量轮流加噪声、归一化。 */
export function benchVectors(n = BENCH_N, sigma = BENCH_SIGMA, seed = BENCH_SEED, base: readonly Vec[] = PARAGRAPH_VECTORS): Vec[] {
  const g = gaussian(mulberry32(seed));
  return Array.from({ length: n }, (_, i) => normalize(base[i % base.length].map((x) => x + sigma * g())));
}

/** 默认的 1000 个合成向量。 */
export const BENCH_VECTORS: readonly Vec[] = benchVectors();

/** 8 个评估问题的查询向量。 */
export const BENCH_QUERIES: readonly Vec[] = EVAL_SET.map((item) => embedVector(item.question));

/** 每个查询在合成数据上的标准答案（暴力搜索的前 BENCH_K 个，不记距离）。 */
export const BENCH_TRUTH: readonly number[][] = BENCH_QUERIES.map((q) => exactTopK(BENCH_VECTORS, q, BENCH_K));
