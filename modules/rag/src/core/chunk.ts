/**
 * 文本切分（chunking）：把一篇文档切成适合嵌入和检索的块。三种做法：
 *
 * - fixedChunks：固定长度的滑动窗口，按字符（码点）数切，窗口之间可以重叠 overlap 个字符。最简单，但会把一句话拦腰切断。
 * - sentences：按句末标点（。！？；）和换行切成句子，句末标点留在句子里。
 * - recursiveChunks：递归切分，仿 LangChain 的 RecursiveCharacterTextSplitter：先按第一个分隔符（换行）切，
 *   切出来还超长的片段再按下一个分隔符（句号、逗号……）切，最后把相邻的小片段贪心地合并到不超过 size；
 *   开新块时，从上一块末尾带上不超过 overlap 个字符的完整片段作为重叠。分隔符留在片段末尾（keep_separator='end'）。
 *
 * 每块记下在原文里的字符区间（码点下标，左闭右开）、UTF-8 字节区间、token 数（本站 BPE 分词器的真实计数）、
 * 以及和上一块重叠的字符数。块的首尾空白（换行）去掉，区间随之收缩。
 */
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Encode } from '@explorer/llm-core/utf8';

export interface Chunk {
  index: number;
  text: string;
  /** 在原文里的字符区间（码点下标），左闭右开。 */
  from: number;
  to: number;
  /** UTF-8 字节区间，左闭右开。 */
  byteFrom: number;
  byteTo: number;
  /** 本站 BPE 分词器的 token 数。 */
  tokens: number;
  /** 和上一块重叠的字符数（第一块是 0）。 */
  overlap: number;
}

/** 文本的 token 数（本站迷你 BPE，只代表量级关系）。 */
export const countTokens = (text: string): number => (text ? TOKENIZER.encode(text).length : 0);

/** 把字符区间变成一个 Chunk（去掉首尾空白）。 */
function makeChunks(chars: readonly string[], ranges: ReadonlyArray<[number, number]>): Chunk[] {
  const prefixBytes = [0];
  for (const char of chars) prefixBytes.push(prefixBytes[prefixBytes.length - 1] + utf8Encode(char).length);
  const out: Chunk[] = [];
  for (let [from, to] of ranges) {
    while (from < to && /\s/.test(chars[from])) from++;
    while (to > from && /\s/.test(chars[to - 1])) to--;
    if (from >= to) continue;
    const prev = out[out.length - 1];
    const text = chars.slice(from, to).join('');
    out.push({ index: out.length, text, from, to, byteFrom: prefixBytes[from], byteTo: prefixBytes[to], tokens: countTokens(text), overlap: prev ? Math.max(0, prev.to - from) : 0 });
  }
  return out;
}

/** 固定长度切分：每块 size 个字符，步长 size − overlap。最后一块到原文结尾为止。 */
export function fixedChunks(text: string, size: number, overlap = 0): Chunk[] {
  if (size <= 0 || overlap < 0 || overlap >= size) throw new Error('需要 size > 0 且 0 ≤ overlap < size');
  const chars = [...text];
  const ranges: Array<[number, number]> = [];
  for (let from = 0; from < chars.length; from += size - overlap) {
    ranges.push([from, Math.min(chars.length, from + size)]);
    if (from + size >= chars.length) break;
  }
  return makeChunks(chars, ranges);
}

/** 句末标点和换行。 */
const SENTENCE_END = /[。！？；\n]/;

/** 按句子切：每句的字符区间，句末标点（或换行）留在句子里。 */
export function sentenceSpans(text: string): Array<[number, number]> {
  const chars = [...text];
  const out: Array<[number, number]> = [];
  let start = 0;
  chars.forEach((char, i) => {
    if (SENTENCE_END.test(char)) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  });
  if (start < chars.length) out.push([start, chars.length]);
  return out;
}

/** 句子列表（去掉首尾空白，跳过空句）。 */
export const sentences = (text: string): Chunk[] => makeChunks([...text], sentenceSpans(text));

/** 递归切分的默认分隔符：段落（换行）、句号类、逗号类，最后按字符硬切。 */
export const DEFAULT_SEPARATORS = ['\n', '。', '，', ''] as const;

export interface RecursiveOptions {
  size: number;
  overlap?: number;
  separators?: readonly string[];
}

/** 片段：原文里的字符区间。 */
type Piece = [from: number, to: number];

function splitPieces(chars: readonly string[], [from, to]: Piece, separators: readonly string[], size: number): Piece[] {
  const segment = chars.slice(from, to).join('');
  const sepIndex = separators.findIndex((sep) => sep === '' || segment.includes(sep));
  const sep = separators[sepIndex] ?? '';
  const rest = separators.slice(sepIndex + 1);
  const pieces: Piece[] = [];
  if (sep === '') {
    for (let i = from; i < to; i++) pieces.push([i, i + 1]);
  } else {
    const width = [...sep].length;
    let start = from;
    for (let i = from; i <= to - width; i++) {
      if (chars.slice(i, i + width).join('') === sep) {
        pieces.push([start, i + width]);
        start = i + width;
        i += width - 1;
      }
    }
    if (start < to) pieces.push([start, to]);
  }
  return pieces.flatMap((piece) => (piece[1] - piece[0] <= size || !rest.length ? [piece] : splitPieces(chars, piece, rest, size)));
}

/** 递归切分（见文件开头）。 */
export function recursiveChunks(text: string, options: RecursiveOptions): Chunk[] {
  const { size, overlap = 0, separators = DEFAULT_SEPARATORS } = options;
  if (size <= 0 || overlap < 0 || overlap >= size) throw new Error('需要 size > 0 且 0 ≤ overlap < size');
  const chars = [...text];
  const pieces = splitPieces(chars, [0, chars.length], separators, size);
  const ranges: Array<[number, number]> = [];
  let current: Piece[] = [];
  const length = (list: Piece[]) => list.reduce((sum, [a, b]) => sum + b - a, 0);
  for (const piece of pieces) {
    const width = piece[1] - piece[0];
    if (current.length && length(current) + width > size) {
      ranges.push([current[0][0], current[current.length - 1][1]]);
      // 重叠：从上一块的末尾保留不超过 overlap 个字符的完整片段，并且要给新片段留出位置。
      while (current.length && (length(current) > overlap || length(current) + width > size)) current = current.slice(1);
    }
    current.push(piece);
  }
  if (current.length) ranges.push([current[0][0], current[current.length - 1][1]]);
  return makeChunks(chars, ranges);
}

/** 按段落切：一个段落（换行之间）一块，不限长度。 */
export const paragraphChunks = (text: string): Chunk[] => makeChunks([...text], sentenceSpansBy(text, '\n'));

function sentenceSpansBy(text: string, sep: string): Array<[number, number]> {
  const chars = [...text];
  const out: Array<[number, number]> = [];
  let start = 0;
  chars.forEach((char, i) => {
    if (char === sep) {
      out.push([start, i + 1]);
      start = i + 1;
    }
  });
  if (start < chars.length) out.push([start, chars.length]);
  return out;
}
