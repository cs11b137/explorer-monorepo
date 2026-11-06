/**
 * RAG 评估的可计算近似。RAGAS（Es、James、Espinosa-Anke、Schockaert，arXiv 2309.15217，EACL 2024 系统演示）
 * 和它现在的文档用另一个大模型来拆句子、判断支持关系；本站没有大模型，改用人工标注（kb.ts 的 EVAL_SET）和字面核对：
 *
 * - context precision@K（检索排得准不准）：RAGAS 文档的定义 Σ_k (precision@k × v_k) / 前 K 个里相关的个数，
 *   v_k 是第 k 个是否相关。RAGAS 由大模型判断 v_k，本站用标注的相关段落。
 * - context recall（该找的找全了没有）：RAGAS 文档的定义是「参考答案里能被检索结果支持的陈述 / 参考答案的陈述数」。
 *   本站把参考答案的陈述换成标注的关键事实（facts），按字面在检索到的文字里找（contextRecall）；
 *   另给一个按段落算的检索召回 retrievalRecall = 找到的相关段落 / 全部相关段落。
 * - faithfulness（回答有没有编）：RAGAS 论文的 F = |V| / |S|，S 是回答拆出的陈述，V 是其中能从上下文推出的。
 *   本站按句子拆，用 rag.ts 的 supports（关键事实一字不差 + 词覆盖率）判断能不能从检索到的全部文字推出。
 */
import { splitAnswer, supports, type Support } from './rag';

/** context precision@K。没有任何相关段落时是 0。 */
export function contextPrecision(retrieved: readonly string[], relevant: readonly string[]): { score: number; marks: boolean[]; precisions: number[] } {
  const rel = new Set(relevant);
  const marks = retrieved.map((id) => rel.has(id));
  let hits = 0;
  const precisions = marks.map((mark, i) => {
    if (mark) hits++;
    return hits / (i + 1);
  });
  const total = marks.filter(Boolean).length;
  const score = total ? precisions.reduce((sum, p, i) => sum + (marks[i] ? p : 0), 0) / total : 0;
  return { score, marks, precisions };
}

/** 按段落的检索召回：标注的相关段落有几个被找到。 */
export function retrievalRecall(retrieved: readonly string[], relevant: readonly string[]): { score: number; found: string[]; missed: string[] } {
  const got = new Set(retrieved);
  const found = relevant.filter((id) => got.has(id));
  return { score: relevant.length ? found.length / relevant.length : 0, found, missed: relevant.filter((id) => !got.has(id)) };
}

/** context recall 的近似：参考答案的关键事实有几个出现在检索到的文字里（忽略空白）。 */
export function contextRecall(facts: readonly string[], contexts: readonly string[]): { score: number; found: string[]; missed: string[] } {
  const flat = (text: string) => text.replace(/\s+/g, '');
  const joined = flat(contexts.join('\n'));
  const found = facts.filter((fact) => joined.includes(flat(fact)));
  return { score: facts.length ? found.length / facts.length : 0, found, missed: facts.filter((fact) => !joined.includes(flat(fact))) };
}

/** faithfulness 的近似：回答的每一句（去掉引用标记）能否从全部检索结果推出。 */
export function faithfulness(answer: string, contexts: readonly string[]): { score: number; statements: Array<{ text: string; support: Support }> } {
  const statements = splitAnswer(answer).map((sentence) => ({ text: sentence.text, support: supports(sentence.text, contexts) }));
  const supported = statements.filter((item) => item.support.supported).length;
  return { score: statements.length ? supported / statements.length : 0, statements };
}

/** 回答覆盖了参考答案的几个关键事实（答得全不全）。 */
export const answerFacts = (answer: string, facts: readonly string[]): { score: number; found: string[] } => {
  const flat = (text: string) => text.replace(/\s+/g, '');
  const found = facts.filter((fact) => flat(answer).includes(flat(fact)));
  return { score: facts.length ? found.length / facts.length : 0, found };
};

/** 倒数名次（MRR 的一项）：第一个相关段落排第 r 名就是 1 / r，前 K 个里一个都没有是 0。rank 从 1 开始。 */
export function reciprocalRank(retrieved: readonly string[], relevant: readonly string[]): { score: number; rank: number | null } {
  const rel = new Set(relevant);
  const index = retrieved.findIndex((id) => rel.has(id));
  return index < 0 ? { score: 0, rank: null } : { score: 1 / (index + 1), rank: index + 1 };
}
