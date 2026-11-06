/**
 * 本站的嵌入模型：在知识库的段落上训练的 LSA（潜在语义分析，Deerwester et al. 1990），16 维。
 *
 * 为什么选它（而不是小型 skip-gram 词向量，或字符 n-gram 哈希加随机投影）：
 * - 确定：训练就是一次矩阵分解（Jacobi 法，顺序固定），没有随机初始化和学习率，结果逐位可复现；浏览器里几毫秒训练完。
 * - 有语义：它从「哪些词常出现在同一段里」学到相近的意思。「漏水」和「渗水」、「到账」和「退回」在知识库里总一起出现，
 *   所以「保温杯漏水了怎么办？」和「杯盖渗水该怎么处理？」一个共同的词都没有，向量却很近（BM25 给它们 0 分）。
 *   字符 n-gram 哈希只看字面，和 BM25 是同一类东西，讲不出向量检索的长处；skip-gram 在二十几段文字上训练，结果太噪、太依赖种子。
 * - 小：16 维，一个向量 64 字节 float32，能逐字节展示。
 *
 * 训练（trainEmbedder）：
 *   1. 把每个段落切成词（和 BM25 同一套切词：汉字二元组、小写的字母数字词），得到词表；
 *   2. 词 × 段落的权重矩阵 A：w = (1 + ln tf) · ln(N / df)（tf-idf 的对数写法）；
 *   3. 对 Gram 矩阵 AᵀA（段落 × 段落）做特征分解，取最大的 16 个特征值 λ 和特征向量 v，奇异值 σ = √λ；
 *   4. 每个词的 16 维向量 u = A[词] · v / σ，也就是截断 SVD 里 U 的那一行。这就是「嵌入表」。
 * 嵌入（embed）：文本切词 → 查表得到每个词的向量 → 按词的权重做加权平均（池化）→ L2 归一化。
 * 段落自己的嵌入方向和 LSA 的文档向量 Σ·V 一致；新文本（查询）就是 LSA 的 fold-in。
 *
 * 和真实嵌入模型的差别：真实模型（OpenAI text-embedding-3、Voyage 等）是在海量通用语料上训练的 Transformer，
 * 输出上千维，词表外的说法也懂；本站的「模型」只在这一个小知识库上训练，词表外的词（OOV）直接丢掉。机制（文本 → 定长向量 → 归一化 → 比余弦）相同，规模和质量差得很远。
 */
import { termsOf } from '@explorer/llm-core/bm25';
import { PARAGRAPHS } from './kb';
import { jacobiEigen } from './linalg';
import { normalize, norm, type Vec } from './vector';

export const EMBED_DIM = 16;

export interface EmbedModel {
  dim: number;
  /** 训练用的段落数 N。 */
  docs: number;
  /** 词表，按在训练语料里第一次出现的顺序。 */
  vocab: string[];
  /** 每个词出现在几个段落里。 */
  df: Map<string, number>;
  /** 每个词的 idf = ln(N / df)。 */
  idf: Map<string, number>;
  /** 嵌入表：每个词的 dim 维向量（fp32）。 */
  table: Map<string, Vec>;
  /** 奇异值 σ，从大到小。 */
  sigma: number[];
  /** Jacobi 用了几轮扫描。 */
  sweeps: number;
}

/** 一个词在一段文本里的权重：(1 + ln tf) · idf。 */
export const termWeight = (tf: number, idf: number): number => (tf > 0 ? (1 + Math.log(tf)) * idf : 0);

function counts(terms: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const term of terms) out.set(term, (out.get(term) ?? 0) + 1);
  return out;
}

/** 在一组文本上训练 LSA 嵌入。 */
export function trainEmbedder(texts: readonly string[], dim = EMBED_DIM): EmbedModel {
  const docs = texts.map((text) => termsOf(text));
  const N = docs.length;
  if (dim > N) throw new Error(`维度 ${dim} 不能超过段落数 ${N}`);
  const vocab = [...new Set(docs.flat())];
  const df = new Map(vocab.map((term) => [term, docs.filter((terms) => terms.includes(term)).length]));
  const idf = new Map(vocab.map((term) => [term, Math.log(N / df.get(term)!)]));
  const A = docs.map((terms) => new Map([...counts(terms)].map(([term, tf]) => [term, termWeight(tf, idf.get(term)!)])));
  const gram = A.map((a) => A.map((b) => {
    let sum = 0;
    for (const [term, w] of a) sum += w * (b.get(term) ?? 0);
    return sum;
  }));
  const eigen = jacobiEigen(gram);
  const sigma = eigen.values.slice(0, dim).map((value) => Math.sqrt(value));
  const table = new Map<string, Vec>(vocab.map((term) => [term, sigma.map((s, k) => {
    let sum = 0;
    for (let d = 0; d < N; d++) sum += (A[d].get(term) ?? 0) * eigen.vectors[k][d];
    return Math.fround(sum / s);
  })]));
  return { dim, docs: N, vocab, df, idf, table, sigma, sweeps: eigen.sweeps };
}

/** 全站共用的嵌入模型：在知识库的全部段落上训练。模块加载时训练一次。 */
export const EMBEDDER: EmbedModel = trainEmbedder(PARAGRAPHS.map((item) => item.text));

export interface TermHit {
  term: string;
  /** 在这段文本里出现几次。 */
  tf: number;
  idf: number;
  /** 池化时的权重 (1 + ln tf) · idf。 */
  weight: number;
  /** 这个词在嵌入表里的向量。 */
  vector: Vec;
}

export interface EmbedTrace {
  text: string;
  /** 切出来的全部词，按原文顺序，含重复。 */
  terms: string[];
  /** 词表里有的词（去重，按第一次出现的顺序）和它们的权重、向量。 */
  known: TermHit[];
  /** 词表里没有的词（去重）：模型不认识，丢掉。 */
  unknown: string[];
  /** 加权平均池化的结果 Σ w·u / Σ w（fp32），还没归一化。 */
  pooled: Vec;
  /** pooled 的 L2 范数。 */
  norm: number;
  /** 最终的嵌入：pooled 除以范数（fp32）。一个词都不认识时是零向量。 */
  vector: Vec;
}

/** 文本 → 嵌入，带每一步的中间结果。 */
export function embed(text: string, model: EmbedModel = EMBEDDER): EmbedTrace {
  const terms = termsOf(text);
  const known: TermHit[] = [];
  const unknown: string[] = [];
  for (const [term, tf] of counts(terms)) {
    const vector = model.table.get(term);
    if (!vector) unknown.push(term);
    else {
      const idf = model.idf.get(term)!;
      known.push({ term, tf, idf, weight: termWeight(tf, idf), vector });
    }
  }
  const total = known.reduce((sum, hit) => sum + hit.weight, 0);
  const pooled = Array.from({ length: model.dim }, (_, k) => Math.fround(total ? known.reduce((sum, hit) => sum + hit.weight * hit.vector[k], 0) / total : 0));
  const n = norm(pooled);
  return { text, terms, known, unknown, pooled, norm: n, vector: normalize(pooled) };
}

/** 只要向量。 */
export const embedVector = (text: string, model: EmbedModel = EMBEDDER): Vec => embed(text, model).vector;

/** 一个词在嵌入表里的向量；不在词表里时返回 null。 */
export const termVector = (term: string, model: EmbedModel = EMBEDDER): Vec | null => model.table.get(term) ?? null;

/** 嵌入表的大小：词数 × 维度 × 4 字节（fp32）。 */
export const tableBytes = (model: EmbedModel = EMBEDDER): number => model.vocab.length * model.dim * 4;

/** 全部段落的嵌入，和 PARAGRAPHS 一一对应。检索课的默认数据集。 */
export const PARAGRAPH_VECTORS: readonly Vec[] = PARAGRAPHS.map((item) => embedVector(item.text));
