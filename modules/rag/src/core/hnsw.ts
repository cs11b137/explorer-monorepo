/**
 * HNSW（分层可导航小世界图，Malkov & Yashunin，Efficient and Robust Approximate Nearest Neighbor Search Using
 * Hierarchical Navigable Small World Graphs，arXiv 1603.09320，2016；IEEE TPAMI 42(4)，2020），按论文的算法 1、2、4、5 实现：
 *
 * - 层数：每个新节点的最高层 l = ⌊−ln(U) · mL⌋，U 是 (0, 1] 的均匀随机数（固定种子），mL = 1/ln(M)（论文建议的取值）。
 *   越高的层节点越少（大约每层少到 1/M），最高层的那个节点是全图的入口。
 * - 插入（算法 1）：从入口出发，在 l 以上的各层用 ef = 1 贪心下降；从第 min(L, l) 层到第 0 层，
 *   每层用 efConstruction 做一次 SEARCH-LAYER 找候选，挑 M 个当邻居（算法 4 的启发式），连双向边；
 *   邻居的度数超过上限（第 0 层 Mmax0 = 2M，其余层 M）时，用同样的启发式剪掉多余的边。
 * - 选邻居的启发式（算法 4，extendCandidates = keepPrunedConnections = false，和 hnswlib 一致）：
 *   候选按离基准点从近到远看，只有当它离基准点比离已选的每个邻居都近时才选，让边指向不同的方向。
 * - 查询（算法 5）：上面各层 ef = 1 贪心下降到第 0 层，第 0 层用 ef（FAISS 的 efSearch、hnswlib 的 ef）个候选做最佳优先搜索，取前 k。
 * 距离一律用平方欧氏距离。每次算距离都记进 DistanceMeter（插入记 build，查询记 query）。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import type { Hit } from './flat';
import { DistanceMeter, type DistanceKind } from './meter';
import { l2sq, type Vec } from './vector';

export interface HnswOptions {
  /** 每个节点在每层新连的边数（第 0 层的度数上限是 2M）。 */
  M: number;
  efConstruction: number;
  seed?: number;
  /** 层数的归一化系数，默认 1/ln(M)。 */
  mL?: number;
  /** 选邻居的方法：heuristic（论文算法 4，默认）或 simple（最近的 M 个，算法 3）。 */
  select?: 'heuristic' | 'simple';
}

export interface LayerVisit {
  layer: number;
  /** 这一层从哪个（些）节点出发。 */
  entry: number[];
  /** 按访问顺序：每个被算过距离的节点和它的平方距离。 */
  visited: Array<{ node: number; dist: number }>;
  /** 这一层的结果，从近到远（ef 个以内）。 */
  result: number[];
}

export interface InsertTrace {
  node: number;
  level: number;
  /** 插入前的入口和最高层（空图时是 −1）。 */
  entry: number;
  maxLevel: number;
  /** 每一层的搜索：l 以上各层 ef = 1 的贪心下降，以及 min(L, l) 到 0 层的 efConstruction 搜索。 */
  visits: LayerVisit[];
  /** 每一层选中的邻居，以及因为度数超限被剪掉的边（谁失去了哪些邻居）。 */
  links: Array<{ layer: number; neighbors: number[]; pruned: Array<{ node: number; removed: number[] }> }>;
  /** 这个节点成了新的入口（第一个节点，或它的层数比原来的最高层高）。 */
  newEntry: boolean;
  /** 这次插入算了几次距离。 */
  distances: number;
}

export interface HnswGraph {
  M: number;
  Mmax0: number;
  efConstruction: number;
  mL: number;
  select: 'heuristic' | 'simple';
  /** 每个节点的最高层。 */
  levels: number[];
  /** neighbors[layer].get(node)：这个节点在这一层的邻居。 */
  neighbors: Array<Map<number, number[]>>;
  entry: number;
  maxLevel: number;
  inserts: InsertTrace[];
}

export interface HnswSearch {
  /** 从最高层到第 0 层，每层的访问记录。 */
  visits: LayerVisit[];
  hits: Hit[];
  /** 一共算了几次距离。 */
  computed: number;
}

/** 按种子给 n 个节点抽层数：⌊−ln(U) · mL⌋，U = 1 − rand() ∈ (0, 1]。 */
export function drawLevels(n: number, mL: number, seed: number): number[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(-Math.log(1 - rand()) * mL));
}

/** 带计数的距离：同一次搜索里每个节点只算一次。缓存是按节点下标的 Float64Array（−1 表示还没算，平方距离不会是负数）。 */
class Dist {
  readonly cache: Float64Array;
  count = 0;
  constructor(private readonly vectors: readonly Vec[], private readonly query: Vec, private readonly meter: DistanceMeter | undefined, private readonly kind: DistanceKind) {
    this.cache = new Float64Array(vectors.length).fill(-1);
  }
  of(node: number): number {
    let d = this.cache[node];
    if (d < 0) {
      d = l2sq(this.query, this.vectors[node]);
      this.cache[node] = d;
      this.count++;
      this.meter?.add(this.kind);
    }
    return d;
  }
}

/** 按（距离，下标）比较：和原来数组排序用的比较函数一致，是全序，所以任何正确的有序结构给出的顺序都相同。 */
const before = (cache: Float64Array, a: number, b: number): boolean => cache[a] < cache[b] || (cache[a] === cache[b] && a < b);

/** 候选集：按（距离，下标）的最小堆，弹出的总是最近的那个（和排好序的数组 shift 的结果相同）。 */
function heapPush(heap: number[], cache: Float64Array, node: number): void {
  let i = heap.length;
  heap.push(node);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!before(cache, node, heap[parent])) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = node;
}

function heapPop(heap: number[], cache: Float64Array): number {
  const top = heap[0];
  const last = heap.pop()!;
  const n = heap.length;
  if (n) {
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const child = r < n && before(cache, heap[r], heap[l]) ? r : l;
      if (!before(cache, heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
  }
  return top;
}

/** 有序数组里按（距离，下标）插入（二分找位置）。 */
function sortedInsert(list: number[], cache: Float64Array, node: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(cache, list[mid], node)) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, node);
}

/** SEARCH-LAYER（算法 2）：从 entry 出发的最佳优先搜索，保留 ef 个最近的。 */
function searchLayer(graph: HnswGraph, dist: Dist, entry: number[], ef: number, layer: number): LayerVisit {
  const cache = dist.cache;
  const seen = new Uint8Array(cache.length);
  for (const node of entry) seen[node] = 1;
  const visited = entry.map((node) => ({ node, dist: dist.of(node) }));
  const byDist = (a: number, b: number) => cache[a] - cache[b] || a - b;
  const candidates: number[] = [];
  for (const node of entry) heapPush(candidates, cache, node);
  const results = entry.slice().sort(byDist);
  while (results.length > ef) results.pop();
  const links = graph.neighbors[layer];
  while (candidates.length) {
    const c = heapPop(candidates, cache);
    if (cache[c] > cache[results[results.length - 1]]) break;
    const list = links.get(c);
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (seen[e]) continue;
      seen[e] = 1;
      const d = dist.of(e);
      visited.push({ node: e, dist: d });
      if (results.length < ef || d < cache[results[results.length - 1]]) {
        heapPush(candidates, cache, e);
        sortedInsert(results, cache, e);
        if (results.length > ef) results.pop();
      }
    }
  }
  return { layer, entry, visited, result: results };
}

/** 选邻居：从候选里挑至多 m 个。toBase 给出候选到基准点的距离；启发式时，候选之间的距离也要算（每次记 1 次）。 */
function selectNeighbors(graph: HnswGraph, vectors: readonly Vec[], toBase: (node: number) => number, candidates: readonly number[], m: number, local: DistanceMeter): number[] {
  const sorted = candidates.map((node) => ({ node, d: toBase(node) })).sort((a, b) => a.d - b.d || a.node - b.node);
  if (graph.select === 'simple') return sorted.slice(0, m).map((item) => item.node);
  const chosen: number[] = [];
  let pairs = 0;
  for (let k = 0; k < sorted.length; k++) {
    if (chosen.length >= m) break;
    const item = sorted[k];
    const v = vectors[item.node];
    let keep = true;
    for (let j = 0; j < chosen.length; j++) {
      pairs++;
      if (l2sq(v, vectors[chosen[j]]) < item.d) {
        keep = false;
        break;
      }
    }
    if (keep) chosen.push(item.node);
  }
  // 计数只是整数加法，攒到最后一次记，结果相同。
  if (pairs) local.add('build', pairs);
  return chosen;
}

/** 建一张空图（还没插入任何节点）。levels 是每个节点的最高层。 */
export function emptyHnsw(levels: number[], options: HnswOptions): HnswGraph {
  const maxLevel = Math.max(0, ...levels);
  return {
    M: options.M,
    Mmax0: 2 * options.M,
    efConstruction: options.efConstruction,
    mL: options.mL ?? 1 / Math.log(options.M),
    select: options.select ?? 'heuristic',
    levels,
    neighbors: Array.from({ length: maxLevel + 1 }, () => new Map<number, number[]>()),
    entry: -1,
    maxLevel: -1,
    inserts: [],
  };
}

/** 插入一个节点（算法 1）。 */
export function insertHnsw(graph: HnswGraph, vectors: readonly Vec[], node: number, meter?: DistanceMeter): InsertTrace {
  const level = graph.levels[node];
  const local = new DistanceMeter();
  const dist = new Dist(vectors, vectors[node], local, 'build');
  const trace: InsertTrace = { node, level, entry: graph.entry, maxLevel: graph.maxLevel, visits: [], links: [], newEntry: false, distances: 0 };
  for (let layer = 0; layer <= level; layer++) graph.neighbors[layer].set(node, []);
  if (graph.entry < 0) {
    graph.entry = node;
    graph.maxLevel = level;
    trace.newEntry = true;
    graph.inserts.push(trace);
    return trace;
  }
  let ep = [graph.entry];
  for (let layer = graph.maxLevel; layer > level; layer--) {
    const visit = searchLayer(graph, dist, ep, 1, layer);
    trace.visits.push(visit);
    ep = [visit.result[0]];
  }
  for (let layer = Math.min(graph.maxLevel, level); layer >= 0; layer--) {
    const visit = searchLayer(graph, dist, ep, graph.efConstruction, layer);
    trace.visits.push(visit);
    const neighbors = selectNeighbors(graph, vectors, (other) => dist.of(other), visit.result, graph.M, local);
    graph.neighbors[layer].set(node, neighbors.slice());
    const pruned: InsertTrace['links'][number]['pruned'] = [];
    const cap = layer === 0 ? graph.Mmax0 : graph.M;
    for (const e of neighbors) {
      const list = graph.neighbors[layer].get(e)!;
      list.push(node);
      if (list.length > cap) {
        // list 里的节点互不相同（每个节点只插入一次），每个候选到 e 的距离正好算一次、记一次，不用缓存。
        const base = vectors[e];
        const kept = selectNeighbors(graph, vectors, (other) => (local.add('build'), l2sq(base, vectors[other])), list, cap, local);
        const keptSet = new Set(kept);
        pruned.push({ node: e, removed: list.filter((item) => !keptSet.has(item)) });
        graph.neighbors[layer].set(e, kept);
      }
    }
    trace.links.push({ layer, neighbors, pruned });
    ep = visit.result;
  }
  if (level > graph.maxLevel) {
    graph.entry = node;
    graph.maxLevel = level;
    trace.newEntry = true;
  }
  trace.distances = local.total;
  meter?.add('build', local.total);
  graph.inserts.push(trace);
  return trace;
}

/** 按 0..N−1 的顺序插入全部向量。 */
export function buildHnsw(vectors: readonly Vec[], options: HnswOptions, meter?: DistanceMeter): HnswGraph {
  const mL = options.mL ?? 1 / Math.log(options.M);
  const graph = emptyHnsw(drawLevels(vectors.length, mL, options.seed ?? 1), { ...options, mL });
  vectors.forEach((_, node) => insertHnsw(graph, vectors, node, meter));
  return graph;
}

/** 查询（算法 5）：ef 是第 0 层的候选数，至少取 k。 */
export function hnswSearch(graph: HnswGraph, vectors: readonly Vec[], query: Vec, k: number, ef: number, meter?: DistanceMeter): HnswSearch {
  const dist = new Dist(vectors, query, meter, 'query');
  const visits: LayerVisit[] = [];
  let ep = [graph.entry];
  for (let layer = graph.maxLevel; layer > 0; layer--) {
    const visit = searchLayer(graph, dist, ep, 1, layer);
    visits.push(visit);
    ep = [visit.result[0]];
  }
  const bottom = searchLayer(graph, dist, ep, Math.max(ef, k), 0);
  visits.push(bottom);
  return { visits, hits: bottom.result.slice(0, k).map((id) => ({ id, score: dist.of(id) })), computed: dist.count };
}

/** 第 layer 层的全部边（无向，去重，a < b）。画图用。 */
export function edgesOf(graph: HnswGraph, layer: number): Array<[number, number]> {
  const out = new Set<string>();
  for (const [node, list] of graph.neighbors[layer] ?? []) for (const other of list) out.add(node < other ? `${node},${other}` : `${other},${node}`);
  return [...out].map((key) => key.split(',').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
