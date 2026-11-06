/**
 * 召回率、元数据过滤、混合检索（BM25 + 向量，RRF 融合）。
 *
 * - 召回率@k：近似索引找到的前 k 个里，有几个也在暴力搜索的前 k 个里，除以 k（ANN 评测的通用定义）。
 * - 元数据过滤：前过滤先按条件筛出候选再做向量搜索，一定能拿满 k 个（只要符合条件的够多）；
 *   后过滤先取向量最近的 k 个再筛，符合条件的可能不到 k 个，甚至一个都没有。
 * - RRF（Reciprocal Rank Fusion，Cormack、Clarke、Büttcher，SIGIR 2009）：score(d) = Σ_r 1 / (k + rank_r(d))，
 *   rank 从 1 开始，没出现在某个列表里的不加分；k = 60 是论文用的值。只看名次不看分数，所以 BM25 分和余弦分不用归一化就能合并。
 */
import { bm25, type Bm25Scored } from '@explorer/llm-core/bm25';
import { flatSearch, type Hit } from './flat';
import { DistanceMeter } from './meter';
import type { Metric, Vec } from './vector';

// ---------- 召回率 ----------

/** 召回率@k：found 的前 k 个里，在 truth 前 k 个里的比例。 */
export function recallAtK(found: readonly number[], truth: readonly number[], k: number): number {
  const target = new Set(truth.slice(0, k));
  if (!target.size) return 0;
  return found.slice(0, k).filter((id) => target.has(id)).length / target.size;
}

/** 一批查询的平均召回率@k。 */
export const meanRecall = (pairs: ReadonlyArray<{ found: readonly number[]; truth: readonly number[] }>, k: number): number =>
  pairs.reduce((sum, pair) => sum + recallAtK(pair.found, pair.truth, k), 0) / Math.max(1, pairs.length);

/** 暴力搜索的前 k 个下标：近似索引的标准答案（不记距离）。 */
export const exactTopK = (vectors: readonly Vec[], query: Vec, k: number, metric: Metric = 'ip'): number[] => flatSearch(vectors, query, k, metric).hits.map((hit) => hit.id);

// ---------- 元数据过滤 ----------

export interface FilteredSearch {
  mode: 'pre' | 'post';
  /** 满足条件的向量下标。 */
  allowed: number[];
  /** 向量搜索真正比较过的下标（前过滤是 allowed，后过滤是全部）。 */
  searched: number[];
  /** 后过滤时，过滤之前的前 k 个。 */
  beforeFilter: Hit[];
  /** 最终结果，可能少于 k 个（后过滤）。 */
  hits: Hit[];
  computed: number;
}

/** 带元数据条件的暴力搜索。pre：先筛再搜；post：先搜前 k 个再筛。 */
export function filteredSearch(vectors: readonly Vec[], query: Vec, k: number, allow: (id: number) => boolean, mode: 'pre' | 'post', metric: Metric = 'ip', meter?: DistanceMeter): FilteredSearch {
  const allowed = vectors.flatMap((_, id) => (allow(id) ? [id] : []));
  if (mode === 'pre') {
    const result = flatSearch(vectors, query, k, metric, meter, allowed);
    return { mode, allowed, searched: allowed, beforeFilter: result.hits, hits: result.hits, computed: result.computed };
  }
  const result = flatSearch(vectors, query, k, metric, meter);
  return { mode, allowed, searched: vectors.map((_, id) => id), beforeFilter: result.hits, hits: result.hits.filter((hit) => allow(hit.id)), computed: result.computed };
}

// ---------- 关键词检索 ----------

export interface RankedDoc {
  id: string;
  score: number;
  /** 名次，从 1 开始。 */
  rank: number;
}

/** BM25 检索：分数 > 0 的按分数从高到低（同分按原顺序），取前 k 个。 */
export function bm25Search<T extends { id: string; text: string }>(docs: readonly T[], query: string, k: number): { ranked: RankedDoc[]; scored: Array<Bm25Scored<T>> } {
  const scored = bm25(docs, query);
  const ranked = scored
    .map((doc, i) => ({ doc, i }))
    .filter((item) => item.doc.score > 0)
    .sort((a, b) => b.doc.score - a.doc.score || a.i - b.i)
    .slice(0, k)
    .map((item, index) => ({ id: item.doc.id, score: item.doc.score, rank: index + 1 }));
  return { ranked, scored };
}

/** 向量检索的结果写成同样的形状（id 换成文档的 id）。 */
export const rankedOf = (hits: readonly Hit[], idOf: (index: number) => string): RankedDoc[] => hits.map((hit, index) => ({ id: idOf(hit.id), score: hit.score, rank: index + 1 }));

// ---------- RRF ----------

/** 论文的常数 k（Cormack et al. 2009 用 60）。 */
export const RRF_K = 60;

export interface FusedDoc {
  id: string;
  score: number;
  /** 在每个输入列表里的名次（从 1 开始），没出现是 null。 */
  ranks: Array<number | null>;
  /** 每个列表贡献的分数 1 / (k + rank)。 */
  parts: number[];
  rank: number;
}

/** RRF 融合若干个排好序的列表。同分时按第一次出现的先后（先看第一个列表，再看第二个……）。 */
export function rrf(lists: ReadonlyArray<readonly RankedDoc[]>, k = RRF_K): FusedDoc[] {
  const order: string[] = [];
  for (const list of lists) for (const doc of list) if (!order.includes(doc.id)) order.push(doc.id);
  return order
    .map((id) => {
      const ranks = lists.map((list) => list.find((doc) => doc.id === id)?.rank ?? null);
      const parts = ranks.map((rank) => (rank === null ? 0 : 1 / (k + rank)));
      return { id, ranks, parts, score: parts.reduce((sum, part) => sum + part, 0), rank: 0 };
    })
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) => b.doc.score - a.doc.score || a.i - b.i)
    .map((item, index) => ({ ...item.doc, rank: index + 1 }));
}
