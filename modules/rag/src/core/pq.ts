/**
 * 乘积量化 PQ（Jégou、Douze、Schmid，Product quantization for nearest neighbor search，IEEE TPAMI 2011；FAISS 的 IndexPQ）：
 *
 * - 切子空间：d 维向量切成 M 段，每段 dsub = d / M 维；
 * - 训练码本：每个子空间单独做 k-means，得到 ksub 个子质心（ksub = 2^nbits，FAISS 默认 nbits = 8 即 256 个；
 *   本站的数据只有二三十个向量，用更小的 ksub）；
 * - 编码：每段换成最近的子质心的编号，一个编号存一个 uint8，一个向量从 d × 4 字节变成 M 字节
 *   （nbits < 8 时 FAISS 会把编号按位紧挨着存，本站一律一个字节一个编号，课程里说明）；
 * - ADC（非对称距离计算）：查询不量化。先算查询每一段到该子空间每个子质心的平方距离，得到一张 M × ksub 的表；
 *   某个码的近似距离 = 把 M 个编号对应的表项加起来。和每个库向量比较只要 M 次查表加法，不用碰原始向量。
 * 近似距离等于查询到「解码后的向量」的平方距离（逐位一致，测试核对），和真实距离的差就是量化误差。
 */
import type { Hit } from './flat';
import { topK } from './flat';
import { CentroidFinder, kmeans, nearest, type KMeansResult } from './kmeans';
import { DistanceMeter } from './meter';
import { l2sq, type Vec } from './vector';

export interface PqCodebook {
  d: number;
  /** 子空间个数 M。 */
  m: number;
  /** 每个子空间的维数 d / M。 */
  dsub: number;
  /** 每个子空间的子质心个数。 */
  ksub: number;
  /** centroids[j][c]：第 j 个子空间的第 c 个子质心（dsub 维，fp32）。 */
  centroids: Vec[][];
  /** 每个子空间的 k-means 过程。 */
  train: KMeansResult[];
}

/** 第 j 段：[j × dsub, (j + 1) × dsub)。 */
export const subvector = (v: readonly number[], j: number, dsub: number): Vec => v.slice(j * dsub, (j + 1) * dsub);

export interface PqTrainOptions {
  iters?: number;
  seed?: number;
  meter?: DistanceMeter;
}

/** 训练码本。每个子空间用 seed + j 作种子。距离按 k-means 的口径记 train（每个子空间 N × ksub 次子距离，合计折成 N × ksub 次完整距离）。 */
export function trainPq(vectors: readonly Vec[], m: number, ksub: number, options: PqTrainOptions = {}): PqCodebook {
  const d = vectors[0].length;
  if (d % m) throw new Error(`维度 ${d} 不能被 M = ${m} 整除`);
  if (ksub > 256) throw new Error('一个编号存一个 uint8，ksub 最多 256');
  const dsub = d / m;
  const train = Array.from({ length: m }, (_, j) => kmeans(vectors.map((v) => subvector(v, j, dsub)), ksub, { iters: options.iters, seed: (options.seed ?? 1) + j }));
  // 每个子空间的距离只有 dsub 维，M 次子距离合起来才等于一次完整距离：每个子空间每轮记 N × ksub / M 次（四舍五入）。
  if (options.meter) for (const result of train) options.meter.add('train', Math.round((result.iterations.length * vectors.length * ksub) / m));
  return { d, m, dsub, ksub, centroids: train.map((result) => result.centroids), train };
}

/** 编码：每段换成最近子质心的编号（uint8）。 */
export const pqEncode = (cb: PqCodebook, v: Vec): number[] => Array.from({ length: cb.m }, (_, j) => nearest(cb.centroids[j], subvector(v, j, cb.dsub)).index);

/** 解码：编号换回子质心，拼成 d 维向量。 */
export const pqDecode = (cb: PqCodebook, codes: readonly number[]): Vec => codes.flatMap((c, j) => cb.centroids[j][c]);

/** ADC 距离表：table[j][c] = ‖查询第 j 段 − 第 j 个子空间的第 c 个子质心‖²。计算量等于 ksub 次完整距离，记 ksub 次 adc-table。 */
export function adcTable(cb: PqCodebook, query: Vec, meter?: DistanceMeter): number[][] {
  meter?.add('adc-table', cb.ksub);
  return Array.from({ length: cb.m }, (_, j) => {
    const q = subvector(query, j, cb.dsub);
    return cb.centroids[j].map((c) => l2sq(q, c));
  });
}

/** 一个码的近似平方距离：M 次查表求和。 */
export const adcDistance = (table: readonly (readonly number[])[], codes: readonly number[]): number => codes.reduce((sum, c, j) => sum + table[j][c], 0);

export interface PqSearch {
  table: number[][];
  /** 每个码的近似平方距离，按下标。 */
  distances: number[];
  hits: Hit[];
}

/** 用 ADC 搜索一批码：建表一次，每个码查表一次（记 adc）。 */
export function pqSearch(cb: PqCodebook, codes: readonly (readonly number[])[], query: Vec, k: number, meter?: DistanceMeter): PqSearch {
  const table = adcTable(cb, query, meter);
  const distances = codes.map((code) => adcDistance(table, code));
  meter?.add('adc', codes.length);
  return { table, distances, hits: topK('l2', distances, k) };
}

/** 原始向量和 PQ 码的字节数：d × 4 对 M（每个编号一个 uint8）。 */
export const pqBytes = (cb: PqCodebook): { raw: number; code: number; codebook: number } => ({ raw: cb.d * 4, code: cb.m, codebook: cb.m * cb.ksub * cb.dsub * 4 });

/**
 * 批量编码（入库）：每个向量的 M 段各和 ksub 个子质心比一次，合起来等于 ksub 次完整距离（和 ADC 表同一个口径），
 * 每个向量记 ksub 次 build。结果和逐个 pqEncode 相同。
 */
export function pqEncodeAll(cb: PqCodebook, vectors: readonly Vec[], meter?: DistanceMeter): number[][] {
  meter?.add('build', vectors.length * cb.ksub);
  // 每个子空间建一次 CentroidFinder（结果和 nearest 逐位相同），直接按偏移读第 j 段，不切子向量。
  const finders = cb.centroids.map((centroids) => new CentroidFinder(centroids));
  return vectors.map((v) => {
    if (v.length !== cb.d) throw new Error(`维度不一致：${v.length} 和 ${cb.d}`);
    const code: number[] = new Array(cb.m);
    for (let j = 0; j < cb.m; j++) code[j] = finders[j].find(v, j * cb.dsub);
    return code;
  });
}

/** 码字按 FAISS 的写法紧挨着存要几个字节：⌈M × nbits / 8⌉，nbits = log2(ksub)。本站一律一个编号一个 uint8（M 字节）。 */
export const pqPackedBytes = (cb: PqCodebook): number => Math.ceil((cb.m * Math.log2(cb.ksub)) / 8);
