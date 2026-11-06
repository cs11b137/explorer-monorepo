/**
 * 重排序：对第一轮召回的几十个候选，用更贵、更准的打分器重新排一遍，只留前几个放进提示。
 *
 * 真实的重排序器是交叉编码器（cross-encoder）模型：把查询和段落拼在一起送进 Transformer，一次前向输出一个相关度分数
 * （Cohere Rerank、Voyage rerank、bge-reranker 一类）。它比双塔的向量检索准，因为能看到查询和段落之间逐词的对应，
 * 但每个候选都要单独跑一次模型，所以只用在少量候选上。
 *
 * 本站跑不了交叉编码器，用一个可计算的替身（crossScore），只取「同时看查询和段落」这一点：
 *   score = 0.5 · cos(嵌入(查询), 嵌入(段落)) + 0.5 · 覆盖率
 *   覆盖率 = 段落里出现了的查询词的 idf 之和 / 查询全部词的 idf 之和（词表外的词按最大 idf 算）。
 * 覆盖率只能把两段文字放在一起才算得出来，这是它和「各自算向量再比较」的区别。权重 0.5 / 0.5 是本站选的。
 */
import { termsOf } from '@explorer/llm-core/bm25';
import { EMBEDDER, embedVector, type EmbedModel } from './embed';
import { DistanceMeter } from './meter';
import { dot } from './vector';

export const RERANK_WEIGHTS = { vector: 0.5, coverage: 0.5 } as const;

export interface CrossScore {
  score: number;
  /** 两个嵌入的余弦。 */
  cosine: number;
  /** 查询词的 idf 覆盖率 0–1。 */
  coverage: number;
  /** 段落里出现了的查询词。 */
  matched: string[];
  /** 查询里的全部词（去重）。 */
  terms: string[];
}

/** 给一对（查询，段落）打分（记 1 次 rerank）。 */
export function crossScore(query: string, passage: string, meter?: DistanceMeter, model: EmbedModel = EMBEDDER): CrossScore {
  const terms = [...new Set(termsOf(query))];
  const passageTerms = new Set(termsOf(passage));
  const maxIdf = Math.log(model.docs);
  const idfOf = (term: string) => model.idf.get(term) ?? maxIdf;
  const total = terms.reduce((sum, term) => sum + idfOf(term), 0);
  const matched = terms.filter((term) => passageTerms.has(term));
  const coverage = total ? matched.reduce((sum, term) => sum + idfOf(term), 0) / total : 0;
  const cosine = dot(embedVector(query, model), embedVector(passage, model));
  meter?.add('rerank');
  return { score: RERANK_WEIGHTS.vector * cosine + RERANK_WEIGHTS.coverage * coverage, cosine, coverage, matched, terms };
}

export interface Reranked<T> {
  item: T;
  /** 原来的名次（从 1 开始）。 */
  before: number;
  /** 重排后的名次。 */
  rank: number;
  cross: CrossScore;
}

/** 对候选重新打分、排序（同分按原名次），取前 topN 个。 */
export function rerank<T extends { text: string }>(query: string, candidates: readonly T[], topN = candidates.length, meter?: DistanceMeter): Array<Reranked<T>> {
  return candidates
    .map((item, i) => ({ item, before: i + 1, rank: 0, cross: crossScore(query, item.text, meter) }))
    .sort((a, b) => b.cross.score - a.cross.score || a.before - b.before)
    .slice(0, topN)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
