/**
 * 暴力 kNN（FAISS 的 IndexFlatIP / IndexFlatL2）：查询和库里每个向量都算一次距离，取最近的 k 个。
 * 结果是精确的，所以它是所有近似索引的「标准答案」：召回率@k 就是拿近似结果和它比。成本是 N 次距离计算。
 */
import { DistanceMeter } from './meter';
import { metricValue, type Metric, type Vec } from './vector';

export interface Hit {
  /** 向量在数据集里的下标（FAISS 里的 id）。 */
  id: number;
  /** 度量的原始值：ip / cosine 越大越近，l2 是平方距离、越小越近。 */
  score: number;
}

export interface FlatSearch {
  /** 最近的 k 个，从近到远（同分按下标）。 */
  hits: Hit[];
  /** 和每个向量的度量值，按下标。 */
  scores: number[];
  /** 这次算了几次距离（= 向量数）。 */
  computed: number;
}

/** 按「越近越前」排序，同分按下标，取前 k 个。 */
export function topK(metric: Metric, scores: readonly number[], k: number, ids?: readonly number[]): Hit[] {
  const order = (ids ?? scores.map((_, i) => i)).map((id) => ({ id, score: scores[id] }));
  order.sort((a, b) => (metric === 'l2' ? a.score - b.score : b.score - a.score) || a.id - b.id);
  return order.slice(0, k);
}

/** 暴力搜索。ids 给出时只在这些下标里搜（前过滤）。 */
export function flatSearch(vectors: readonly Vec[], query: Vec, k: number, metric: Metric = 'ip', meter?: DistanceMeter, ids?: readonly number[]): FlatSearch {
  const scores: number[] = new Array(vectors.length).fill(NaN);
  const candidates = ids ?? vectors.map((_, i) => i);
  for (const id of candidates) scores[id] = metricValue(metric, query, vectors[id]);
  meter?.add('query', candidates.length);
  return { hits: topK(metric, scores, k, candidates), scores, computed: candidates.length };
}

/** 是否 a 比 b 更近。 */
export const closer = (metric: Metric, a: number, b: number): boolean => (metric === 'l2' ? a < b : a > b);

// ---------- 扫描时维护前 k 个（堆） ----------

export interface HeapStep {
  id: number;
  score: number;
  /** push：堆还没满，直接放进去；replace：比堆顶（目前第 k 近的）更近，替换堆顶；skip：不够近，丢掉。 */
  action: 'push' | 'replace' | 'skip';
  /** replace 时被挤出去的下标。 */
  evicted?: number;
  /** 这一步之后堆里的下标，从近到远。 */
  heap: number[];
}

/**
 * 按下标顺序扫一遍分数，用一个装 k 个的堆维护目前最近的 k 个：堆顶是这 k 个里最远的那个，
 * 新来的只要比堆顶近就替换它。内存只要 k 个位置，不用把 N 个分数全部排序；结果和 topK 相同（同分时下标小的优先）。
 * 不另算距离（分数来自 flatSearch 的 scores）。
 */
export function scanTopK(metric: Metric, scores: readonly number[], k: number, ids?: readonly number[]): HeapStep[] {
  const better = (a: number, b: number) => closer(metric, scores[a], scores[b]) || (scores[a] === scores[b] && a < b);
  const heap: number[] = [];
  const steps: HeapStep[] = [];
  for (const id of ids ?? scores.map((_, i) => i)) {
    let action: HeapStep['action'] = 'skip';
    let evicted: number | undefined;
    if (heap.length < k) {
      heap.push(id);
      action = 'push';
    } else if (better(id, heap[heap.length - 1])) {
      evicted = heap.pop();
      heap.push(id);
      action = 'replace';
    }
    heap.sort((a, b) => (better(a, b) ? -1 : 1));
    steps.push({ id, score: scores[id], action, evicted, heap: heap.slice() });
  }
  return steps;
}

