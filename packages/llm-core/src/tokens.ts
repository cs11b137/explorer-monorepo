/**
 * 原在 CONTEXT EXPLORER 的 src/core/tokens.ts（那里转导出，接口不变；AGENT EXPLORER 也用）。核对过的事实见 modules/context/README.md。
 *
 * token 计数。用的是 LLM EXPLORER 那个字节级 BPE（共享包 @explorer/llm-core 的 TOKENIZER，
 * 在 18 篇小语料上学了 96 条合并规则），再加上 chat template 的两个特殊 token。
 *
 * 这是真实执行的计数，但真实模型的分词器不同（词表大几百倍，中文合并得多得多），
 * 所以本站的 token 数只代表量级关系：同一段文字谁多谁少、哪部分占大头，和真实模型一致；绝对值不一致。
 *
 * 特殊 token 只在「模板」里出现。普通文本里即使写了 <|im_start|> 这几个字符，encodeText 也按普通字节编码，
 * 不会变成特殊 token——这是防止用户输入伪造角色边界的基本手段（Hugging Face tokenizers、tiktoken 默认都这样）。
 */
import { TOKENIZER } from './tokenizer';

const T = TOKENIZER;

/** ChatML 的两个特殊 token，id 接在迷你词表后面。 */
export const SPECIAL_TOKENS = ['<|im_start|>', '<|im_end|>'] as const;
export type SpecialToken = (typeof SPECIAL_TOKENS)[number];

/** 特殊 token 的 id：353、354（迷你词表是 0–352，352 是 LLM EXPLORER 的结束符）。 */
export const SPECIAL_ID: Record<SpecialToken, number> = Object.fromEntries(SPECIAL_TOKENS.map((text, i) => [text, T.size + i])) as Record<SpecialToken, number>;

/** 含特殊 token 的词表大小。 */
export const VOCAB_SIZE = T.size + SPECIAL_TOKENS.length;

const SPECIAL_BY_ID = new Map<number, SpecialToken>(SPECIAL_TOKENS.map((text) => [SPECIAL_ID[text], text]));

export const isSpecial = (id: number): boolean => SPECIAL_BY_ID.has(id);

/** 普通文本编码：特殊 token 的字面文字也按字节编码。 */
export const encodeText = (text: string): number[] => T.encode(text);

/** 普通文本的 token 数。 */
export const countTokens = (text: string): number => (text ? T.encode(text).length : 0);

const SPECIAL_PATTERN = new RegExp(`(${SPECIAL_TOKENS.map((text) => text.replace(/[|]/g, '\\|')).join('|')})`);

/** 模板编码：先按特殊 token 的字面文字切开，特殊 token 换成它的 id，其余部分照常编码。只给模板渲染用。 */
export function encodeWithSpecials(text: string): number[] {
  const out: number[] = [];
  for (const piece of text.split(SPECIAL_PATTERN)) {
    if (!piece) continue;
    const special = SPECIAL_ID[piece as SpecialToken];
    if (special !== undefined) out.push(special);
    else out.push(...T.encode(piece));
  }
  return out;
}

/** 一个 token 的字节。特殊 token 没有字节表示，返回它的字面文字的字节只用于展示。 */
export function tokenBytes(id: number): number[] {
  const special = SPECIAL_BY_ID.get(id);
  if (special) return [...special].map((char) => char.charCodeAt(0));
  return T.bytesOf(id);
}

/** 展示文字：空格写成 ␣，换行写成 ↵，半个字符写成十六进制，特殊 token 写原样。 */
export function tokenLabel(id: number): string {
  const special = SPECIAL_BY_ID.get(id);
  if (special) return special;
  const bytes = T.bytesOf(id);
  if (bytes.length === 1 && bytes[0] === 0x0a) return '↵';
  return T.label(id);
}

/** 解码，特殊 token 写回字面文字。 */
export function decodeTokens(ids: readonly number[]): string {
  let out = '';
  let run: number[] = [];
  const flush = () => {
    if (run.length) out += T.decode(run);
    run = [];
  };
  for (const id of ids) {
    const special = SPECIAL_BY_ID.get(id);
    if (special) {
      flush();
      out += special;
    } else run.push(id);
  }
  flush();
  return out;
}

/** 把文本按 token 切成若干段，每段 n 个 token（流式输出时每个 delta 的内容）。切口可能落在汉字中间，所以按 token 的字节拼。 */
export function splitByTokens(text: string, perChunk: number): number[][] {
  const ids = encodeText(text);
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += perChunk) out.push(ids.slice(i, i + perChunk));
  return out;
}

/** 前 n 个 token 的文本（max_tokens 截断）。末尾不完整的 UTF-8 字符丢掉，和服务端只返回完整字符一致。 */
export function truncateTokens(text: string, n: number): { text: string; tokens: number; truncated: boolean } {
  const ids = encodeText(text);
  if (ids.length <= n) return { text, tokens: ids.length, truncated: false };
  const bytes = ids.slice(0, n).flatMap((id) => T.bytesOf(id));
  let decoded = T.decode(ids.slice(0, n));
  // 去掉末尾的替换字符（不完整的多字节字符）。
  while (decoded.endsWith('�') && bytes.length) decoded = decoded.slice(0, -1);
  return { text: decoded, tokens: n, truncated: true };
}
