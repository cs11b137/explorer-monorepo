/**
 * 检索增强的最后一段：把检索到的段落拼进提示（带来源编号），模型照着回答并标出引用，再核对引用是不是对得上来源。
 *
 * - buildPrompt：说明 + 编号的资料 + 问题，每部分记下字符区间和 token 数（本站 BPE 的真实计数）。
 * - 回答是模型写的，本站不跑大模型，课程里写死并标 E.G.；但「每句话标了哪个来源、那个来源里有没有这句话说的事」是可以算的：
 *   checkCitations 把回答切成句子，抽出每句的 [n] 标记，再看被引用的来源是否支持这句话（supports）。
 * - supports 是本站的近似判据：句子里的关键事实（数字、区间、编号，比如「1–3 个工作日」「SR-35」）必须一字不差地出现在来源里，
 *   并且句子的词（汉字二元组）至少有 SUPPORT_MIN 比例出现在来源里。真实系统（RAGAS 的 faithfulness 等）让另一个大模型来判断。
 * - searchResultBlocks：同样的资料写成 Claude Messages API 的 search_result 内容块（字段经核对），模型回答时会返回 search_result_location 引用。
 */
import { termsOf } from '@explorer/llm-core/bm25';
import { countTokens } from './chunk';

export interface Passage {
  id: string;
  title: string;
  text: string;
}

export interface Source extends Passage {
  /** 来源编号，从 1 开始，提示里写成 [n]。 */
  n: number;
}

export type PromptPartKind = 'instruction' | 'source' | 'question' | 'separator';

export interface PromptPart {
  kind: PromptPartKind;
  /** 资料的来源编号（kind 为 source 时）。 */
  n?: number;
  text: string;
  /** 在整段提示里的字符区间（码点下标）。 */
  from: number;
  to: number;
  tokens: number;
}

export interface RagPrompt {
  text: string;
  sources: Source[];
  parts: PromptPart[];
  /** 整段提示的 token 数（整段编码，等于各部分之和，测试核对）。 */
  tokens: number;
}

export const RAG_INSTRUCTION = '请只根据下面的资料回答问题，在用到资料的句子末尾标出来源编号，比如 [1]。资料里没有的，就说不知道。';

/** 一条资料在提示里的写法：[n] 加上段落原文；段落没以标题开头时，前面补上标题。 */
export const sourceLine = (source: Source): string => `[${source.n}] ${source.text.startsWith(source.title) ? '' : source.title}${source.text}`;

/** 拼提示：说明、空行、每条资料一行、空行、「问题：…」。 */
export function buildPrompt(question: string, passages: readonly Passage[], instruction = RAG_INSTRUCTION): RagPrompt {
  const sources = passages.map((passage, i) => ({ ...passage, n: i + 1 }));
  const pieces: Array<Omit<PromptPart, 'from' | 'to' | 'tokens'>> = [{ kind: 'instruction', text: instruction }, { kind: 'separator', text: '\n\n' }];
  sources.forEach((source, i) => {
    pieces.push({ kind: 'source', n: source.n, text: sourceLine(source) });
    pieces.push({ kind: 'separator', text: i + 1 < sources.length ? '\n' : '\n\n' });
  });
  pieces.push({ kind: 'question', text: `问题：${question}` });
  let at = 0;
  const parts = pieces.map((piece): PromptPart => {
    const from = at;
    at += [...piece.text].length;
    return { ...piece, from, to: at, tokens: countTokens(piece.text) };
  });
  const text = pieces.map((piece) => piece.text).join('');
  return { text, sources, parts, tokens: countTokens(text) };
}

// ---------- 引用 ----------

/** 关键事实：数字（含区间、小数、冒号时间）连同紧跟的单位，以及字母数字编号（SR-35、A1024、BW-350）。 */
const FACT = /[A-Za-z]+-?\d+|\d+(?:[.:：]\d+)?(?:\s*[–-]\s*\d+(?:[.:：]\d+)?)?\s*(?:个工作日|个|天|小时|元|分|毫升|升|瓦|年|%)?/g;

/** 一句话里的关键事实，按出现顺序，去重。 */
export const factsOf = (text: string): string[] => [...new Set([...text.matchAll(FACT)].map((match) => match[0].trim()).filter(Boolean))];

/** 句子的词有多大比例出现在来源里（0–1）。 */
export function coverageOf(sentence: string, sources: readonly string[]): number {
  const terms = [...new Set(termsOf(sentence))];
  if (!terms.length) return 0;
  const pool = new Set(sources.flatMap((text) => termsOf(text)));
  return terms.filter((term) => pool.has(term)).length / terms.length;
}

/** 词覆盖率至少这么多才算被支持。本站选的阈值。 */
export const SUPPORT_MIN = 0.5;

export interface Support {
  supported: boolean;
  facts: string[];
  /** 来源里找不到的事实。 */
  missing: string[];
  coverage: number;
}

/** 一句话是否被这些来源支持：关键事实全部出现（忽略空白），且词覆盖率 ≥ SUPPORT_MIN。 */
export function supports(sentence: string, sources: readonly string[]): Support {
  const facts = factsOf(sentence);
  // 比较时忽略空白：「1–3个工作日」和「1–3 个工作日」算同一个事实。
  const flat = (text: string) => text.replace(/\s+/g, '');
  const joined = flat(sources.join('\n'));
  const missing = facts.filter((fact) => !joined.includes(flat(fact)));
  const coverage = coverageOf(sentence, sources);
  return { supported: missing.length === 0 && coverage >= SUPPORT_MIN && sources.length > 0, facts, missing, coverage };
}

export interface AnswerSentence {
  /** 去掉 [n] 标记之后的句子。 */
  text: string;
  /** 在回答原文里的字符区间（码点下标，含标记）。 */
  from: number;
  to: number;
  /** 这句标的来源编号，按出现顺序。 */
  cites: number[];
}

/** 把回答切成句子（句末是 。！？ 或换行），句末标点后紧跟的 [n] 也归这一句。 */
export function splitAnswer(answer: string): AnswerSentence[] {
  const chars = [...answer];
  const out: AnswerSentence[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const raw = chars.slice(start, end).join('');
    const cites = [...raw.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    const text = raw.replace(/\s*\[\d+\]/g, '').trim();
    if (text) out.push({ text, from: start, to: end, cites });
    start = end;
  };
  while (i < chars.length) {
    if (/[。！？\n]/.test(chars[i])) {
      let end = i + 1;
      // 句末标点之后的 [n] 标记也算这一句的。
      for (;;) {
        const rest = chars.slice(end).join('');
        const match = /^\s*\[\d+\]/.exec(rest);
        if (!match) break;
        end += [...match[0]].length;
      }
      flush(end);
      i = end;
    } else i++;
  }
  flush(chars.length);
  return out;
}

export type CitationStatus = 'supported' | 'unsupported' | 'uncited' | 'bad-source';

export interface CitationCheck extends AnswerSentence {
  status: CitationStatus;
  support: Support | null;
}

/**
 * 核对引用：每句话标的来源是否存在（bad-source：编号超出范围）、是否支持这句话（supported / unsupported），
 * 没标来源的句子是 uncited。「我不知道」这类不含事实的句子可以不标。
 */
export function checkCitations(answer: string, sources: readonly Source[]): { sentences: CitationCheck[]; supported: number; total: number } {
  const sentences = splitAnswer(answer).map((sentence): CitationCheck => {
    if (!sentence.cites.length) return { ...sentence, status: 'uncited', support: null };
    const cited = sentence.cites.map((n) => sources.find((source) => source.n === n));
    if (cited.some((source) => !source)) return { ...sentence, status: 'bad-source', support: null };
    const support = supports(sentence.text, cited.map((source) => source!.text));
    return { ...sentence, status: support.supported ? 'supported' : 'unsupported', support };
  });
  return { sentences, supported: sentences.filter((item) => item.status === 'supported').length, total: sentences.length };
}

// ---------- Claude Messages API 的 search_result 内容块 ----------

export interface SearchResultBlock {
  type: 'search_result';
  source: string;
  title: string;
  content: Array<{ type: 'text'; text: string }>;
  citations: { enabled: boolean };
}

/**
 * 资料写成 search_result 块（放在 user 消息里，或工具结果里）：type、source、title、content（text 块数组）必填，
 * citations 默认关闭，同一个请求里所有 search_result 要么都开要么都关。source 可以是任何稳定的字符串，这里用 kb://段落 id。
 */
export const searchResultBlocks = (passages: readonly Passage[]): SearchResultBlock[] =>
  passages.map((passage) => ({ type: 'search_result', source: `kb://${passage.id}`, title: passage.title, content: [{ type: 'text', text: passage.text }], citations: { enabled: true } }));
