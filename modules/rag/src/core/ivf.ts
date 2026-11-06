/**
 * IVF（倒排文件，FAISS 的 IndexIVFFlat）：
 *   训练：用 k-means 把向量空间分成 nlist 个簇，质心存在「粗量化器」里；
 *   入库：每个向量放进离它最近的质心的倒排表（list）；
 *   查询：先和 nlist 个质心比，挑最近的 nprobe 个簇，只扫这几个倒排表里的向量。
 * 距离计算从 N 次降到 nlist + （被扫的向量数），代价是答案可能落在没被探查的簇里：召回率 < 1。
 * nprobe = nlist 时等于暴力搜索。距离一律用平方欧氏距离（IndexIVFFlat 的默认 METRIC_L2；向量已归一化，排序和点积相同）。
 */
import { topK, type Hit } from './flat';
import { kmeans, nearest, type KMeansResult } from './kmeans';
import { DistanceMeter } from './meter';
import { l2sq, type Vec } from './vector';

export interface IvfIndex {
  nlist: number;
  centroids: Vec[];
  /** 每个簇的倒排表：向量下标，按入库顺序。 */
  lists: number[][];
  /** 每个向量在哪个簇。 */
  listOf: number[];
  train: KMeansResult;
}

export interface IvfBuildOptions {
  iters?: number;
  seed?: number;
  meter?: DistanceMeter;
}

/** 训练质心并把每个向量放进最近的倒排表（入库时 N × nlist 次距离，记 build）。 */
export function buildIvf(vectors: readonly Vec[], nlist: number, options: IvfBuildOptions = {}): IvfIndex {
  const train = kmeans(vectors, nlist, { iters: options.iters, seed: options.seed, meter: options.meter, kind: 'train' });
  const listOf = vectors.map((v) => nearest(train.centroids, v).index);
  options.meter?.add('build', vectors.length * nlist);
  const lists = Array.from({ length: nlist }, (_, c) => listOf.flatMap((list, id) => (list === c ? [id] : [])));
  return { nlist, centroids: train.centroids, lists, listOf, train };
}

export interface IvfSearch {
  /** 查询到每个质心的平方距离，按簇下标。 */
  centroidDist: number[];
  /** 被探查的簇，从近到远（nprobe 个）。 */
  probed: number[];
  /** 被扫过的向量下标，按探查顺序。 */
  scanned: number[];
  /** 被扫过的向量的平方距离，按下标（没扫过的是 NaN）。 */
  scores: number[];
  hits: Hit[];
  /** 距离计算：质心 nlist 次 + 向量 scanned.length 次。 */
  computed: { centroids: number; vectors: number };
}

export function ivfSearch(index: IvfIndex, vectors: readonly Vec[], query: Vec, k: number, nprobe: number, meter?: DistanceMeter): IvfSearch {
  const centroidDist = index.centroids.map((c) => l2sq(query, c));
  meter?.add('centroid', index.nlist);
  const probed = centroidDist.map((d, c) => ({ d, c })).sort((a, b) => a.d - b.d || a.c - b.c).slice(0, Math.min(nprobe, index.nlist)).map((item) => item.c);
  const scanned = probed.flatMap((c) => index.lists[c]);
  const scores: number[] = new Array(vectors.length).fill(NaN);
  for (const id of scanned) scores[id] = l2sq(query, vectors[id]);
  meter?.add('query', scanned.length);
  return { centroidDist, probed, scanned, scores, hits: topK('l2', scores, k, scanned), computed: { centroids: index.nlist, vectors: scanned.length } };
}
