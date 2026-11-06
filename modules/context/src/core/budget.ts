/**
 * 上下文预算：一个窗口装得下多少，每部分各占多少，超了怎么办。
 *
 * 窗口要同时装下输入和这次的输出：输入 token + max_tokens ≤ 上下文窗口（输出要预留出来）。
 * 每部分的 token 数都由 tokens.ts 真实计数；真实模型的窗口是百万量级，本站的课程用小窗口演示同样的比例关系。
 *
 * 超限时的两类策略：
 *   - 截断（trim）：直接丢掉一部分历史。dropOldest 从最早的一轮开始丢，保留最近的；
 *   - 压缩（compact）：把较早的若干轮换成一段摘要。摘要的文字是模型写的（本站作为示例传入），
 *     压缩前后的 token 数、压缩比由这里真实计算。
 */
import { countTokens } from './tokens';

export type PartKind = 'system' | 'tools' | 'history' | 'retrieval' | 'memory' | 'user' | 'output' | 'template';

export interface BudgetPart {
  id: string;
  label: string;
  kind: PartKind;
  tokens: number;
}

export interface BudgetRow extends BudgetPart {
  /** 占窗口的比例，0–1。 */
  share: number;
  /** 这一部分结束时累计用到哪里。 */
  end: number;
}

export interface BudgetPlan {
  window: number;
  /** 输出预留（max_tokens）。 */
  reserved: number;
  /** 输入合计。 */
  input: number;
  /** 输入 + 预留。 */
  used: number;
  /** 还剩多少；超了是负数。 */
  free: number;
  fits: boolean;
  rows: BudgetRow[];
}

/** 拆账：每部分按顺序排进窗口，最后是输出预留。 */
export function planBudget(window: number, parts: readonly BudgetPart[], reserveOutput: number): BudgetPlan {
  let end = 0;
  const rows: BudgetRow[] = [];
  for (const part of [...parts, { id: 'output', label: '输出预留', kind: 'output' as const, tokens: reserveOutput }]) {
    end += part.tokens;
    rows.push({ ...part, share: part.tokens / window, end });
  }
  const input = parts.reduce((sum, part) => sum + part.tokens, 0);
  const used = input + reserveOutput;
  return { window, reserved: reserveOutput, input, used, free: window - used, fits: used <= window, rows };
}

/** 一段文字作为预算的一部分。 */
export const textPart = (id: string, label: string, kind: PartKind, text: string): BudgetPart => ({ id, label, kind, tokens: countTokens(text) });

// ---------- 历史 ----------

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export const turnTokens = (turn: Turn): number => countTokens(turn.text);
export const historyTokens = (turns: readonly Turn[]): number => turns.reduce((sum, turn) => sum + turnTokens(turn), 0);

export interface TrimResult {
  kept: Turn[];
  dropped: Turn[];
  before: number;
  after: number;
}

/** 截断策略：给定历史和预算（token），决定留下哪些。 */
export type TrimStrategy = (turns: readonly Turn[], budget: number) => TrimResult;

/**
 * 从最早的开始丢，一次丢一问一答两条（保持 user / assistant 成对），直到放得下。
 * 最后一条（当前的问题）永远保留：丢了它这次请求就没有意义了。
 */
export const dropOldest: TrimStrategy = (turns, budget) => {
  const before = historyTokens(turns);
  let start = 0;
  while (start < turns.length - 1 && historyTokens(turns.slice(start)) > budget) start += turns[start].role === 'user' && turns[start + 1]?.role === 'assistant' ? 2 : 1;
  const kept = turns.slice(start);
  return { kept, dropped: turns.slice(0, start), before, after: historyTokens(kept) };
};

/** 只留最近 n 条（滑动窗口）。 */
export const keepLast = (n: number): TrimStrategy => (turns) => {
  const kept = turns.slice(Math.max(0, turns.length - n));
  return { kept, dropped: turns.slice(0, turns.length - kept.length), before: historyTokens(turns), after: historyTokens(kept) };
};

export interface CompactResult extends TrimResult {
  summary: Turn;
  summaryTokens: number;
  /** 被压缩的那部分：压缩前 / 压缩后。 */
  ratio: number;
}

/**
 * 压缩：保留最近 keepRecent 条，之前的全部换成一条摘要（作为一条 user 消息放在最前面）。
 * summarize 收到被压缩的那几轮，返回摘要文字（示例，模型写的）。
 */
export function compact(turns: readonly Turn[], keepRecent: number, summarize: (old: readonly Turn[]) => string): CompactResult {
  const cut = Math.max(0, turns.length - keepRecent);
  const old = turns.slice(0, cut);
  const recent = turns.slice(cut);
  const summary: Turn = { role: 'user', text: summarize(old) };
  const summaryTokens = turnTokens(summary);
  const kept = [summary, ...recent];
  const oldTokens = historyTokens(old);
  return { kept, dropped: old, before: historyTokens(turns), after: historyTokens(kept), summary, summaryTokens, ratio: summaryTokens ? oldTokens / summaryTokens : Infinity };
}
