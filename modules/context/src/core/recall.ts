/**
 * 记忆召回：按关键词相关度给每条记忆打分（BM25），取分数最高的几条注入上下文。
 *
 * BM25 是经典的检索打分公式（Robertson、Zaragoza，The Probabilistic Relevance Framework: BM25 and Beyond，2009）：
 *
 *   score(D, Q) = Σ_{t ∈ Q} idf(t) · tf(t, D) · (k1 + 1) / (tf(t, D) + k1 · (1 − b + b · |D| / avgdl))
 *   idf(t)      = ln(1 + (N − n(t) + 0.5) / (n(t) + 0.5))
 *
 * N 是记忆条数，n(t) 是含词 t 的条数，|D| 是这条记忆的词数，avgdl 是平均词数。idf 用加 1 再取对数的写法，保证不为负。
 * k1 = 1.2、b = 0.75 是常用的默认值。
 *
 * 词怎么切：中文没有空格，这里把连续的汉字按相邻两个字切成二元组（「杭州市」→「杭州」「州市」），
 * 英文和数字按连续的字母数字切成小写的词。全部确定、可复现，不依赖词典。
 * 关键词召回只看字面：意思相近但没有共同的字（「住址」和「寄到哪里」），分数就是 0。这是它和向量检索的主要区别。
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const HAN = /[㐀-䶿一-鿿]/;

/** 切词：汉字串按二元组，字母数字按词（小写）。单个汉字自成一词。 */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+|[㐀-䶿一-鿿]+/g)) {
    const run = match[0];
    if (!HAN.test(run[0])) out.push(run);
    else if (run.length === 1) out.push(run);
    else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export interface MemoryEntry {
  id: string;
  text: string;
}

export interface TermScore {
  term: string;
  /** 这个词在这条记忆里出现的次数。 */
  tf: number;
  idf: number;
  /** 这个词贡献的分数。 */
  part: number;
}

export interface ScoredEntry extends MemoryEntry {
  score: number;
  /** 这条记忆的词数 |D|。 */
  length: number;
  /** 查询里命中这条记忆的词，按查询里的顺序，不重复。 */
  hits: TermScore[];
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/** 对每条记忆打分，按原顺序返回。查询里重复的词只算一次。 */
export function bm25(entries: readonly MemoryEntry[], query: string, options: Bm25Options = {}): ScoredEntry[] {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  const docs = entries.map((entry) => termsOf(entry.text));
  const N = entries.length;
  const avgdl = docs.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, N);
  const queryTerms = [...new Set(termsOf(query))];
  const df = new Map(queryTerms.map((term) => [term, docs.filter((terms) => terms.includes(term)).length]));
  return entries.map((entry, i) => {
    const terms = docs[i];
    const hits: TermScore[] = [];
    for (const term of queryTerms) {
      const tf = terms.filter((item) => item === term).length;
      if (!tf) continue;
      const n = df.get(term)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const part = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * terms.length) / avgdl));
      hits.push({ term, tf, idf, part });
    }
    return { ...entry, length: terms.length, hits, score: hits.reduce((sum, hit) => sum + hit.part, 0) };
  });
}

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
