/**
 * k-means（Lloyd 算法），IVF 训练质心和 PQ 训练码本都用它。
 *
 * - 初始化：用固定种子的 PRNG 从训练向量里不放回地抽 k 个当初始质心（FAISS 的 Clustering 默认也是随机抽样）。
 * - 每轮：每个向量分给平方欧氏距离最近的质心（N × k 次距离），再把每个质心移到它名下向量的平均值。
 * - 空簇：保留上一轮的质心（FAISS 会拆分最大的簇，本站简化）。
 * - 收敛：没有向量换簇，或到了最大轮数。
 * 每一轮都记下来（质心、分配、误差平方和），课程按轮做动画。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import { DistanceMeter, type DistanceKind } from './meter';
import { l2sq, type Vec } from './vector';

export interface KMeansIteration {
  /** 这一轮结束时的质心（fp32）。 */
  centroids: Vec[];
  /** 这一轮每个向量分到的簇。 */
  assign: number[];
  /** 误差平方和：每个向量到它所分配（更新前）质心的平方距离之和。 */
  inertia: number;
  /** 和上一轮相比换了簇的向量数（第一轮是全部）。 */
  moved: number;
}

export interface KMeansResult {
  k: number;
  /** 初始质心是哪几个训练向量（下标）。 */
  init: number[];
  centroids: Vec[];
  assign: number[];
  iterations: KMeansIteration[];
  /** 每个簇的向量数。 */
  sizes: number[];
}

export interface KMeansOptions {
  iters?: number;
  seed?: number;
  meter?: DistanceMeter;
  /** 距离记在哪一类，默认 train。 */
  kind?: DistanceKind;
}

/** 不放回地抽 k 个下标（部分 Fisher–Yates）。 */
export function sampleIndices(n: number, k: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

/** 离 v 最近的质心下标和平方距离（同距离取下标小的）。 */
export function nearest(centroids: readonly Vec[], v: Vec): { index: number; dist: number } {
  let index = 0;
  let dist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = l2sq(v, centroids[i]);
    if (d < dist) {
      dist = d;
      index = i;
    }
  }
  return { index, dist };
}

/**
 * 批量找最近的质心，结果（下标和平方距离）和逐个调用 nearest 逐位相同，只是跳过不可能更近的质心：
 * - 质心按第 0 维排好序，从 v 的第 0 维所在的位置往两边找；
 * - 平方距离按分量顺序累加，第一项就是 t₀²（t₀ = v₀ − c₀），后面加的都 ≥ 0，浮点加法单调，所以总和 ≥ t₀²；
 *   往一边走 |t₀| 只增不减，一旦 t₀² > 当前最小距离，这一边剩下的都不可能更近（也不可能打平），整边跳过；
 * - 同距离取下标小的（和 nearest 按下标顺序、严格小于才替换的结果一样）。
 * 这只是省掉一定输的比较，算出来的每个距离和 l2sq 一模一样（同样按分量顺序在 float64 里累加，t * t 和 t ** 2 逐位相同）。
 */
export class CentroidFinder {
  readonly k: number;
  readonly dim: number;
  /** 最近一次 find 的平方距离。 */
  dist = Infinity;
  private readonly flat: Float64Array;
  /** 按第 0 维从小到大的质心下标，以及对应的第 0 维。 */
  private readonly order: Int32Array;
  private readonly first: Float64Array;

  constructor(centroids: readonly Vec[]) {
    const k = centroids.length;
    const dim = k ? centroids[0].length : 0;
    this.k = k;
    this.dim = dim;
    this.flat = new Float64Array(k * dim);
    for (let c = 0; c < k; c++) {
      const row = centroids[c];
      if (row.length !== dim) throw new Error(`维度不一致：${dim} 和 ${row.length}`);
      for (let d = 0; d < dim; d++) this.flat[c * dim + d] = row[d];
    }
    const order = Array.from({ length: k }, (_, c) => c).sort((a, b) => this.flat[a * dim] - this.flat[b * dim] || a - b);
    this.order = Int32Array.from(order);
    this.first = Float64Array.from(order, (c) => this.flat[c * dim]);
  }

  /** v[offset .. offset + dim) 最近的质心下标（平方距离在 this.dist）。 */
  find(v: readonly number[], offset = 0): number {
    const { k, dim, flat, order, first } = this;
    if (!dim) {
      this.dist = k ? 0 : Infinity;
      return 0;
    }
    if (offset + dim > v.length) throw new Error(`维度不一致：${v.length - offset} 和 ${dim}`);
    const x0 = v[offset];
    let lo = 0;
    let hi = k;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (first[mid] < x0) lo = mid + 1;
      else hi = mid;
    }
    let best = Infinity;
    let index = -1;
    let right = lo;
    let left = lo - 1;
    while (right < k || left >= 0) {
      for (let side = 0; side < 2; side++) {
        let pos: number;
        if (side === 0) {
          if (right >= k) continue;
          pos = right++;
        } else {
          if (left < 0) continue;
          pos = left--;
        }
        const c = order[pos];
        const base = c * dim;
        const t0 = x0 - flat[base];
        const s0 = t0 * t0;
        if (s0 > best) {
          // 这一边剩下的都更远。
          if (side === 0) right = k;
          else left = -1;
          continue;
        }
        let sum = 0;
        sum += s0;
        for (let d = 1; d < dim && sum <= best; d++) {
          const t = v[offset + d] - flat[base + d];
          sum += t * t;
        }
        if (sum < best || (sum === best && c < index)) {
          best = sum;
          index = c;
        }
      }
    }
    if (index < 0) {
      // 距离全是 NaN：和 nearest 一样返回 0、Infinity。
      this.dist = Infinity;
      return 0;
    }
    this.dist = best;
    return index;
  }
}

export function kmeans(vectors: readonly Vec[], k: number, options: KMeansOptions = {}): KMeansResult {
  const { iters = 20, seed = 1, meter, kind = 'train' } = options;
  if (k < 1 || k > vectors.length) throw new Error(`k = ${k} 必须在 1 到 ${vectors.length} 之间`);
  const n = vectors.length;
  const dim = vectors[0].length;
  for (const v of vectors) if (v.length !== dim) throw new Error(`维度不一致：${dim} 和 ${v.length}`);
  const init = sampleIndices(n, k, seed);
  let centroids = init.map((i) => vectors[i].map(Math.fround));
  let assign: number[] = new Array(n).fill(-1);
  const iterations: KMeansIteration[] = [];
  // 分配步用 CentroidFinder（结果和逐个 nearest 逐位相同）；更新步一遍扫完所有向量，按下标顺序累加。
  const sums = new Float64Array(k * dim);
  const counts = new Int32Array(k);
  for (let iter = 0; iter < iters; iter++) {
    const finder = new CentroidFinder(centroids);
    let inertia = 0;
    let moved = 0;
    const next: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const index = finder.find(vectors[i]);
      inertia += finder.dist;
      next[i] = index;
      if (index !== assign[i]) moved++;
    }
    meter?.add(kind, n * k);
    assign = next;
    // 新质心 = 名下向量按下标顺序从 0 累加的和 ÷ 个数，和逐簇 reduce 的累加顺序相同。
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      const v = vectors[i];
      const cbase = c * dim;
      for (let d = 0; d < dim; d++) sums[cbase + d] += v[d];
    }
    const old = centroids;
    centroids = new Array(k);
    for (let c = 0; c < k; c++) {
      const size = counts[c];
      if (!size) {
        centroids[c] = old[c];
        continue;
      }
      const row: Vec = new Array(dim);
      for (let d = 0; d < dim; d++) row[d] = Math.fround(sums[c * dim + d] / size);
      centroids[c] = row;
    }
    iterations.push({ centroids, assign, inertia, moved });
    if (!moved) break;
  }
  const sizes: number[] = new Array(k).fill(0);
  for (const a of assign) if (a >= 0) sizes[a]++;
  return { k, init, centroids, assign, iterations, sizes };
}
