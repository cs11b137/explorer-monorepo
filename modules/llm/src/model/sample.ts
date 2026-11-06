/**
 * 采样：从 logits 选出下一个 token。顺序和 Hugging Face transformers 的默认处理链一致：
 *   重复惩罚 → 约束掩码 → temperature → softmax → top-k → top-p → 重新归一化 → 按随机数抽取。
 * llama.cpp 默认把 temperature 放在 top-k / top-p 之后，结果会略有不同；课程里提到时以这里为准。
 *
 * 所有随机数来自调用方传入的 rand（用 prng.ts 的固定种子），同样的种子总是抽到同一个 token。
 */
import { softmax, type Vec } from './tensor';
import { type BpeTokenizer } from '@explorer/llm-core/tokenizer';
import { utf8Encode } from '@explorer/llm-core/utf8';

export interface SampleOptions {
  /** 0 表示贪心（直接取最大），默认 1。 */
  temperature?: number;
  /** 只保留概率最高的 k 个，0 或不填表示不限。 */
  topK?: number;
  /** 核采样：按概率从高到低累加，保留到累计 ≥ p 的最小集合。1 或不填表示不限。 */
  topP?: number;
  /** 重复惩罚（CTRL 论文 / HF 的 repetition_penalty）：出现过的 token，正 logit 除以它、负 logit 乘以它。1 表示不惩罚。 */
  repetitionPenalty?: number;
  /** OpenAI 风格：出现过就减去 presencePenalty。 */
  presencePenalty?: number;
  /** OpenAI 风格：每出现一次减去 frequencyPenalty。 */
  frequencyPenalty?: number;
  /** 约束掩码：allowed[id] 为 false 的 token logit 置为 −∞。见 prefixMask。 */
  allowed?: readonly boolean[];
}

/** 一个候选 token。 */
export interface Candidate {
  id: number;
  /** 经过惩罚和掩码、除以 temperature 之后的 logit。 */
  logit: number;
  /** 全词表 softmax 后的概率。 */
  prob: number;
}

/** 一次采样的全过程，课程按它逐段展示。 */
export interface SampleTrace {
  /** 原始 logits。 */
  raw: Vec;
  /** 惩罚之后。 */
  penalized: Vec;
  /** 掩码之后（被禁止的是 −∞）。 */
  masked: Vec;
  /** 除以 temperature 之后（贪心时等于 masked）。 */
  scaled: Vec;
  /** 全词表的概率。 */
  probs: Vec;
  /** 按概率从高到低排好的全部候选（概率为 0 的不在内）。 */
  ranked: Candidate[];
  /** top-k 之后剩下的。 */
  afterTopK: Candidate[];
  /** top-p 之后剩下的。 */
  afterTopP: Candidate[];
  /** 最终候选重新归一化后的概率，和 afterTopP 一一对应。 */
  final: Array<Candidate & { p: number; cumulative: number }>;
  /** 用到的随机数，[0, 1)；贪心时是 null。 */
  u: number | null;
  /** 选中的 token。 */
  chosen: number;
}

/** 惩罚：history 是已经生成（或已在上下文里）的 token。 */
export function applyPenalties(logits: Vec, history: readonly number[], options: SampleOptions): Vec {
  const out = logits.slice();
  const counts = new Map<number, number>();
  for (const id of history) counts.set(id, (counts.get(id) ?? 0) + 1);
  const penalty = options.repetitionPenalty ?? 1;
  for (const [id, count] of counts) {
    let value = out[id];
    if (penalty !== 1) value = value > 0 ? value / penalty : value * penalty;
    value -= (options.presencePenalty ?? 0) + (options.frequencyPenalty ?? 0) * count;
    out[id] = value;
  }
  return out;
}

/** 先按概率降序，再按 id 升序，保证并列时也确定。 */
const byProb = (a: Candidate, b: Candidate) => b.prob - a.prob || a.id - b.id;

/** top-k：只留前 k 个。 */
export function topK(ranked: readonly Candidate[], k: number | undefined): Candidate[] {
  return k && k > 0 ? ranked.slice(0, k) : ranked.slice();
}

/** top-p：从高到低累加，到累计概率 ≥ p 为止（至少留 1 个）。累加用的是进入这一步时的概率。 */
export function topP(candidates: readonly Candidate[], p: number | undefined): Candidate[] {
  if (p === undefined || p >= 1) return candidates.slice();
  const total = candidates.reduce((sum, item) => sum + item.prob, 0);
  const out: Candidate[] = [];
  let sum = 0;
  for (const item of candidates) {
    out.push(item);
    sum += item.prob / total;
    if (sum >= p) break;
  }
  return out;
}

/** 完整的一次采样。rand 不传或 temperature 为 0 时走贪心。 */
export function sample(logits: Vec, history: readonly number[], options: SampleOptions = {}, rand?: () => number): SampleTrace {
  const penalized = applyPenalties(logits, history, options);
  const masked = options.allowed ? penalized.map((value, id) => (options.allowed![id] ? value : -Infinity)) : penalized.slice();
  if (!masked.some((value) => value > -Infinity)) throw new Error('约束掩码把所有 token 都禁止了');
  const temperature = options.temperature ?? 1;
  const greedy = temperature === 0 || !rand;
  const scaled = greedy ? masked.slice() : masked.map((value) => (value === -Infinity ? value : value / temperature));
  // softmax 在 float64 下做，避免 fp32 舍入让概率和不为 1。
  const probs = softmax(scaled, (value) => value);
  const ranked = probs.flatMap((prob, id) => (prob > 0 ? [{ id, logit: scaled[id], prob }] : [])).sort(byProb);
  const afterTopK = greedy ? ranked.slice(0, 1) : topK(ranked, options.topK);
  const afterTopP = greedy ? afterTopK : topP(afterTopK, options.topP);
  const total = afterTopP.reduce((sum, item) => sum + item.prob, 0);
  let cumulative = 0;
  const final = afterTopP.map((item) => {
    const p = item.prob / total;
    cumulative += p;
    return { ...item, p, cumulative };
  });
  if (greedy) return { raw: logits, penalized, masked, scaled, probs, ranked, afterTopK, afterTopP, final, u: null, chosen: final[0].id };
  const u = rand();
  // 逆累积分布：第一个累计概率超过 u 的候选。浮点误差让最后一个的累计略小于 1 时，落到最后一个。
  const chosen = (final.find((item) => u < item.cumulative) ?? final[final.length - 1]).id;
  return { raw: logits, penalized, masked, scaled, probs, ranked, afterTopK, afterTopP, final, u, chosen };
}

// ---------- 约束解码 ----------

/**
 * 按前缀约束生成掩码：一个 token 允许，当且仅当把它的字节接到已生成的字节后面，仍然是某个合法输出的前缀。
 * 结束符只在已生成的内容本身完整合法时允许。结构化输出（JSON Schema、正则、枚举）都可以归结成这种判定。
 *
 * isPrefix(bytes)：bytes 能否继续写成合法输出。
 * isComplete(bytes)：bytes 本身是否已经是一个完整的合法输出。
 */
export function prefixMask(tokenizer: BpeTokenizer, sofar: readonly number[], isPrefix: (bytes: number[]) => boolean, isComplete: (bytes: number[]) => boolean): boolean[] {
  return tokenizer.vocab.map((bytes, id) => {
    if (id === tokenizer.eos) return isComplete([...sofar]);
    return isPrefix([...sofar, ...bytes]);
  });
}

/** 最简单的约束：输出必须是几个候选字符串之一（枚举）。返回 prefixMask 需要的两个判定。 */
export function choiceConstraint(options: readonly string[]): { isPrefix: (bytes: number[]) => boolean; isComplete: (bytes: number[]) => boolean } {
  const encoded = options.map((option) => utf8Encode(option));
  const startsWith = (whole: number[], part: number[]) => part.length <= whole.length && part.every((byte, i) => whole[i] === byte);
  return {
    isPrefix: (bytes) => encoded.some((option) => startsWith(option, bytes)),
    isComplete: (bytes) => encoded.some((option) => option.length === bytes.length && startsWith(option, bytes)),
  };
}
