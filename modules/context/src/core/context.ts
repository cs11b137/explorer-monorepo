/**
 * 上下文工程的几样小工具：按轮次截断、清理旧的工具结果、在展开后的提示里定位一段文字、
 * 找出资料之间相互矛盾的条目、数一个值在历史里被复制了几次、把不可信内容包起来。
 * 全部是确定的纯函数，课程里的偏移、比例、冲突项都从这里算出来。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import type { ContentBlockParam, MessageParam } from './anthropic';
import type { RenderedPrompt } from './template';
import { encodeText, SPECIAL_ID, tokenBytes, type SpecialToken } from './tokens';

// ---------- 轮次 ----------

const blocksOf = (message: MessageParam): ContentBlockParam[] => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);

/** 一条消息是不是一轮的开头：用户自己说的话，而不是送回的工具结果。 */
export const startsRound = (message: MessageParam): boolean => message.role === 'user' && !blocksOf(message).some((block) => block.type === 'tool_result');

/** 所有轮次开头的下标。一轮 = 用户的一句话 + 之后的工具往返 + 助手的回答。 */
export const roundStarts = (messages: readonly MessageParam[]): number[] => messages.flatMap((message, i) => (startsRound(message) ? [i] : []));

/**
 * 截断点对齐到轮次：从 start 往后找第一个轮次开头。
 * 按条或按「一问一答」丢消息，可能把 tool_use 丢了、留下它的 tool_result，API 会 400；对齐到轮次就不会。
 */
export function alignToRound(messages: readonly MessageParam[], start: number): number {
  const next = roundStarts(messages).find((i) => i >= start);
  return next ?? messages.length;
}

// ---------- 工具结果清理 ----------

export interface ClearedResult {
  /** 第几条消息、第几个块。 */
  message: number;
  block: number;
  toolUseId: string;
  /** 对应的工具名（从前一条消息的 tool_use 里找）。 */
  name: string;
  /** 原来的内容。 */
  text: string;
}

export interface ClearOptions {
  /** 保留最近几次工具结果。 */
  keep: number;
  /** 替换被清掉的结果的文字。 */
  placeholder: string;
  /** 永远不清的工具名。 */
  exclude?: string[];
}

const resultText = (content: string | Array<{ type: string; text?: string }> | undefined): string => (typeof content === 'string' ? content : (content ?? []).map((item) => item.text ?? '').join('\n'));

/**
 * 清理旧的工具结果：只留最近 keep 次，更早的 tool_result 内容换成占位文字，tool_use 和配对关系不动。
 * 不改传入的数组，返回新的消息列表和被清掉的是哪些。
 */
export function clearToolResults(messages: readonly MessageParam[], options: ClearOptions): { messages: MessageParam[]; cleared: ClearedResult[] } {
  const all: ClearedResult[] = [];
  messages.forEach((message, i) => {
    blocksOf(message).forEach((block, j) => {
      if (block.type !== 'tool_result') return;
      const previous = messages[i - 1];
      const use = previous && typeof previous.content !== 'string' ? previous.content.find((item) => item.type === 'tool_use' && item.id === block.tool_use_id) : undefined;
      all.push({ message: i, block: j, toolUseId: block.tool_use_id, name: use && use.type === 'tool_use' ? use.name : '', text: resultText(block.content) });
    });
  });
  const candidates = all.filter((item) => !options.exclude?.includes(item.name));
  const cleared = candidates.slice(0, Math.max(0, candidates.length - options.keep));
  const hit = new Set(cleared.map((item) => `${item.message}:${item.block}`));
  const out = messages.map((message, i): MessageParam => {
    if (typeof message.content === 'string') return message;
    return { ...message, content: message.content.map((block, j) => (hit.has(`${i}:${j}`) && block.type === 'tool_result' ? { ...block, content: options.placeholder } : block)) };
  });
  return { messages: out, cleared };
}

// ---------- 位置 ----------

export interface Location {
  /** 在展开后文本里的 UTF-8 字节偏移。 */
  byte: number;
  /** 落在第几个 token（从 0 数）。 */
  token: number;
  /** 总 token 数。 */
  total: number;
  /** token / total：在上下文里的相对位置，0 是开头，接近 1 是结尾。 */
  share: number;
}

/** 在展开后的提示里找一段文字（第 nth 次出现），给出它的字节偏移、所在的 token 和相对位置。找不到会报错。 */
export function locate(prompt: RenderedPrompt, needle: string, nth = 0): Location {
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = prompt.text.indexOf(needle, at + 1);
    if (at < 0) throw new Error(`提示里没有第 ${nth + 1} 个「${needle}」`);
  }
  const byte = utf8Encode(prompt.text.slice(0, at)).length;
  let end = 0;
  let token = 0;
  while (token < prompt.ids.length) {
    end += tokenBytes(prompt.ids[token]).length;
    if (end > byte) break;
    token++;
  }
  return { byte, token, total: prompt.tokens, share: token / prompt.tokens };
}

/** 一段文字在 text 里出现了几次（不重叠）。 */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

// ---------- 冲突 ----------

export interface Fact {
  key: string;
  value: string;
  source: string;
}

/** 从资料里抽出「键：值」形式的条目（每行一条，全角或半角冒号，去掉行尾的句号、分号）。 */
export function factsOf(text: string, source: string): Fact[] {
  const out: Fact[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?([^：:]{1,20})[：:]\s*(.+?)[。；;]?\s*$/.exec(line);
    if (match) out.push({ key: match[1].trim(), value: match[2].trim(), source });
  }
  return out;
}

export interface Conflict {
  key: string;
  /** 不同的取值，每个取值来自哪些资料，按第一次出现的顺序。 */
  values: Array<{ value: string; sources: string[] }>;
}

/** 同一个键出现了不同的值，就是冲突。值比较前去掉空白。 */
export function conflictsOf(facts: readonly Fact[]): Conflict[] {
  const byKey = new Map<string, Conflict>();
  for (const fact of facts) {
    const conflict = byKey.get(fact.key) ?? { key: fact.key, values: [] };
    byKey.set(fact.key, conflict);
    const norm = fact.value.replace(/\s+/g, '');
    const same = conflict.values.find((item) => item.value.replace(/\s+/g, '') === norm);
    if (same) {
      if (!same.sources.includes(fact.source)) same.sources.push(fact.source);
    } else conflict.values.push({ value: fact.value, sources: [fact.source] });
  }
  return [...byKey.values()].filter((conflict) => conflict.values.length > 1);
}

// ---------- 污染 ----------

/** 一条消息里所有的文字：text 块、tool_use 的参数（JSON）、tool_result 的内容。 */
export function messageText(message: MessageParam): string {
  return blocksOf(message).map((block) => (block.type === 'text' ? block.text : block.type === 'tool_use' ? JSON.stringify(block.input) : resultText(block.content))).join('\n');
}

export interface Ungrounded {
  value: string;
  /** 出现在哪几条助手消息里。 */
  messages: number[];
}

/**
 * 找出助手说过、却没有任何依据的值：pattern 在助手消息（含 tool_use 参数）里匹配到的值，
 * 如果从没在用户消息或工具结果里出现过，就是模型自己写出来的。比如把订单号 A1024 写成了 A1042。
 */
export function ungrounded(messages: readonly MessageParam[], pattern: RegExp): Ungrounded[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const find = (text: string) => [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => match[0]);
  const grounded = new Set(messages.filter((message) => message.role === 'user').flatMap((message) => find(messageText(message))));
  const out = new Map<string, Ungrounded>();
  messages.forEach((message, i) => {
    if (message.role !== 'assistant') return;
    for (const value of find(messageText(message))) {
      if (grounded.has(value)) continue;
      const item = out.get(value) ?? { value, messages: [] };
      if (!item.messages.includes(i)) item.messages.push(i);
      out.set(value, item);
    }
  });
  return [...out.values()];
}

// ---------- 安全编码 ----------

/**
 * 按段重新编码展开后的提示：只有模板自己插入的 <|im_start|>、<|im_end|> 编码成特殊 token，
 * 内容里写的同样字符一律按普通文本编码。renderChatML 是先拼成一串再整段编码，内容里有特殊 token 的字面文字时会被认出来；
 * 没有这种文字时两者结果完全相同（测试核对）。每个 token 仍然归到它第一个字节所在的那一段。
 */
export function encodeSafely(prompt: RenderedPrompt): RenderedPrompt {
  const ids: number[] = [];
  let run = '';
  const flush = () => {
    if (run) ids.push(...encodeText(run));
    run = '';
  };
  for (const piece of prompt.pieces) {
    if (piece.kind === 'special' || (piece.kind === 'prompt' && piece.text === '<|im_start|>')) {
      flush();
      ids.push(SPECIAL_ID[piece.text as SpecialToken]);
    } else run += piece.text;
  }
  flush();
  const pieces = prompt.pieces.map((piece) => ({ ...piece, tokens: 0, ids: [0, 0] as [number, number] }));
  let byte = 0;
  let p = 0;
  ids.forEach((id, index) => {
    while (p < pieces.length - 1 && byte >= pieces[p].to) p++;
    const piece = pieces[p];
    if (piece.tokens === 0) piece.ids = [index, index];
    piece.tokens++;
    piece.ids[1] = index + 1;
    byte += tokenBytes(id).length;
  });
  const bySource: Record<string, number> = {};
  let overhead = 0;
  for (const piece of pieces) {
    if (piece.kind === 'content' && piece.source) bySource[piece.source] = (bySource[piece.source] ?? 0) + piece.tokens;
    else overhead += piece.tokens;
  }
  return { ...prompt, ids, pieces, tokens: ids.length, bySource, overhead };
}

// ---------- 不可信内容 ----------

export interface Wrapped {
  text: string;
  /** 内容里被转义的伪造标签个数。 */
  escaped: number;
}

/**
 * 把不可信的内容（网页、文件、工具结果）包进带来源的标签。内容里如果出现了同名的开闭标签（想提前「关上」包装），
 * 把它们的 < 换成 &lt;，包装就只有最外面这一层。标签名和属性是本站的写法，不是任何 API 的规定。
 */
export function wrapUntrusted(content: string, source: string, tag = 'untrusted'): Wrapped {
  let escaped = 0;
  const safe = content.replace(new RegExp(`<(/?${tag})`, 'gi'), (_, name: string) => {
    escaped++;
    return `&lt;${name}`;
  });
  return { text: `<${tag} source="${source}">\n${safe}\n</${tag}>`, escaped };
}
