/**
 * 记忆召回：按关键词相关度给每条记忆打分（BM25），取分数最高的几条注入上下文。
 *
 * 打分公式和切词在共享包 @explorer/llm-core/bm25（RAG EXPLORER 的混合检索也用），这里转导出，接口和数字不变：
 *   score(D, Q) = Σ_{t ∈ Q} idf(t) · tf(t, D) · (k1 + 1) / (tf(t, D) + k1 · (1 − b + b · |D| / avgdl))
 *   idf(t)      = ln(1 + (N − n(t) + 0.5) / (n(t) + 0.5))，k1 = 1.2、b = 0.75。
 * 汉字按相邻两个字切成二元组，字母数字按小写的词。关键词召回只看字面：意思相近但没有共同的字，分数就是 0。
 */
import { bm25, type Bm25Doc, type Bm25Options, type Bm25Scored } from '@explorer/llm-core/bm25';

export { BM25_B, BM25_K1, bm25, termsOf } from '@explorer/llm-core/bm25';
export type { Bm25Options, TermScore } from '@explorer/llm-core/bm25';

export type MemoryEntry = Bm25Doc;
export type ScoredEntry = Bm25Scored<MemoryEntry>;

export type SkipReason = 'no-overlap' | 'below-min' | 'below-k';

export interface RecallResult {
  /** 全部记忆，按分数从高到低（同分按原顺序）。 */
  ranked: ScoredEntry[];
  /** 召回的：分数 ≥ min 的前 k 条。 */
  picked: ScoredEntry[];
  /** 没召回的，和原因：没有共同的词、分数低于阈值、排在 k 名之后。 */
  skipped: Array<{ entry: ScoredEntry; reason: SkipReason }>;
}

/** 召回：打分、排序，取分数不低于 min 的前 k 条。 */
export function recall(entries: readonly MemoryEntry[], query: string, options: Bm25Options & { k: number; min?: number }): RecallResult {
  const scored = bm25(entries, query, options);
  const ranked = scored.map((entry, i) => ({ entry, i })).sort((a, b) => b.entry.score - a.entry.score || a.i - b.i).map((item) => item.entry);
  const min = options.min ?? 0;
  const picked: ScoredEntry[] = [];
  const skipped: RecallResult['skipped'] = [];
  for (const entry of ranked) {
    if (entry.score === 0) skipped.push({ entry, reason: 'no-overlap' });
    else if (entry.score < min) skipped.push({ entry, reason: 'below-min' });
    else if (picked.length >= options.k) skipped.push({ entry, reason: 'below-k' });
    else picked.push(entry);
  }
  return { ranked, picked, skipped };
}
