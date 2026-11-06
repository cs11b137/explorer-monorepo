/**
 * BM25 关键词打分。CONTEXT EXPLORER 的记忆召回和 RAG EXPLORER 的混合检索共用（原来在 modules/context/src/core/recall.ts，抽到这里，行为不变）。
 *
 * BM25 是经典的检索打分公式（Robertson、Zaragoza，The Probabilistic Relevance Framework: BM25 and Beyond，2009）：
 *
 *   score(D, Q) = Σ_{t ∈ Q} idf(t) · tf(t, D) · (k1 + 1) / (tf(t, D) + k1 · (1 − b + b · |D| / avgdl))
 *   idf(t)      = ln(1 + (N − n(t) + 0.5) / (n(t) + 0.5))
 *
 * N 是文档条数，n(t) 是含词 t 的条数，|D| 是这条文档的词数，avgdl 是平均词数。idf 用加 1 再取对数的写法，保证不为负。
 * k1 = 1.2、b = 0.75 和这个 idf 都是 Lucene BM25Similarity 的默认写法（核对过 Lucene 10 的文档）；
 * 上面那篇综述本身举的例子是 b = 0.5、k1 = 2，并说很多实验倾向更小的 k1、更大的 b。
 *
 * 词怎么切：中文没有空格，这里把连续的汉字按相邻两个字切成二元组（「杭州市」→「杭州」「州市」），
 * 英文和数字按连续的字母数字切成小写的词。全部确定、可复现，不依赖词典。
 * 关键词打分只看字面：意思相近但没有共同的字（「住址」和「寄到哪里」），分数就是 0。这是它和向量检索的主要区别。
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

/** 一条被打分的文档（记忆条目、文档块）。 */
export interface Bm25Doc {
  id: string;
  text: string;
}

export interface TermScore {
  term: string;
  /** 这个词在这条文档里出现的次数。 */
  tf: number;
  idf: number;
  /** 这个词贡献的分数。 */
  part: number;
}

export type Bm25Scored<T extends Bm25Doc = Bm25Doc> = T & {
  score: number;
  /** 这条文档的词数 |D|。 */
  length: number;
  /** 查询里命中这条文档的词，按查询里的顺序，不重复。 */
  hits: TermScore[];
};

export interface Bm25Options {
  k1?: number;
  b?: number;
}

/** 对每条文档打分，按原顺序返回。查询里重复的词只算一次。 */
export function bm25<T extends Bm25Doc>(entries: readonly T[], query: string, options: Bm25Options = {}): Array<Bm25Scored<T>> {
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
