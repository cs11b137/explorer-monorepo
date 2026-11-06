/**
 * 字节级 BPE 分词器（GPT-2 / tiktoken 那一类）。
 *
 * - 初始词表是 256 个单字节，所以任何文本都能编码，不会有「未知字符」。
 * - 训练：反复找语料里出现最多的相邻 token 对，把它合并成一个新 token，记下合并规则。
 * - 编码：先预分词（按空格、字母、汉字、数字、标点切块，块之间不合并），
 *   再在每块里按规则的先后（rank）反复合并，直到没有可用的规则。
 *
 * 本站的简化：预分词把连续汉字单独成块（GPT-2 的正则会把汉字和拉丁字母并成一块）；
 * 并列最多的对取 id 字典序最小的，保证训练结果确定。
 */
import { CORPUS, EOS_TEXT, NUM_MERGES } from './corpus';
import { hex2, utf8Decode, utf8Encode } from './utf8';

export interface Merge {
  /** 规则的先后，从 0 开始。编码时 rank 小的先用。 */
  rank: number;
  /** 被合并的两个 token。 */
  pair: [number, number];
  /** 合并出的新 token id，等于 256 + rank。 */
  id: number;
  /** 训练到这一条时，这个对在语料里出现的次数。 */
  count: number;
}

/**
 * 预分词。各分支依次是：可带前导空格的连续汉字、连续字母（含其他文字）、连续数字、连续标点符号，
 * 以及空白（后面紧跟非空白时，最后一个空格留给下一个词当前导空格）。拼起来等于原文。
 */
const PRETOKEN = / ?\p{Script=Han}+| ?[^\s\p{N}\p{P}\p{S}\p{Script=Han}]+| ?\p{N}+| ?[\p{P}\p{S}]+|\s+(?!\S)|\s+/gu;

export function pretokenize(text: string): string[] {
  return [...text.matchAll(PRETOKEN)].map((match) => match[0]);
}

/** 一条合并规则在一次编码里的应用记录，课程按它做动画。 */
export interface MergeApplication {
  merge: Merge;
  /** 这次合并在每个块里发生的位置（合并前的下标）。 */
  at: Array<{ chunk: number; index: number }>;
  /** 合并后每个块的 token。 */
  after: number[][];
  /** 到这条规则为止累计的查表次数。 */
  lookups: number;
}

export interface EncodeTrace {
  text: string;
  /** 预分词的块。 */
  chunks: string[];
  /** 每块的 UTF-8 字节，也就是合并前的初始 token。 */
  bytes: number[][];
  /** 按 rank 顺序真正用上的规则。 */
  steps: MergeApplication[];
  /** 每块最终的 token。 */
  tokens: number[][];
  /** 拼起来的 token id 序列。 */
  ids: number[];
  /**
   * 查表次数：每一轮都要把每块里所有相邻对拿去合并表里查一次 rank。
   * 最后一轮查完发现没有可用规则，也算在内。课程轨迹表的「运算量」用它。
   */
  lookups: number;
}

export class BpeTokenizer {
  /** id → 字节。0–255 是单字节，之后是合并出的 token，最后一个是结束符（没有字节）。 */
  readonly vocab: number[][];
  readonly eos: number;
  private readonly ranks: Map<string, number>;

  constructor(readonly merges: Merge[]) {
    this.vocab = Array.from({ length: 256 }, (_, byte) => [byte]);
    for (const merge of merges) this.vocab.push([...this.vocab[merge.pair[0]], ...this.vocab[merge.pair[1]]]);
    this.eos = this.vocab.length;
    this.vocab.push([]);
    this.ranks = new Map(merges.map((merge) => [`${merge.pair[0]},${merge.pair[1]}`, merge.rank]));
  }

  /** 词表大小，含结束符。 */
  get size(): number {
    return this.vocab.length;
  }

  /** 训练：在语料上学 numMerges 条合并规则。出现次数不到 2 的对不再合并，规则可能少于 numMerges。 */
  static train(corpus: readonly string[], numMerges: number): BpeTokenizer {
    // 同样的块只存一份，带上出现次数。
    const counts = new Map<string, number>();
    for (const doc of corpus) for (const chunk of pretokenize(doc)) counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
    const words = [...counts].map(([chunk, count]) => ({ ids: utf8Encode(chunk), count }));
    const merges: Merge[] = [];
    for (let rank = 0; rank < numMerges; rank++) {
      const pairs = new Map<string, number>();
      for (const word of words) {
        for (let i = 0; i + 1 < word.ids.length; i++) {
          const key = `${word.ids[i]},${word.ids[i + 1]}`;
          pairs.set(key, (pairs.get(key) ?? 0) + word.count);
        }
      }
      let best: [number, number] | null = null;
      let bestCount = 0;
      for (const [key, count] of pairs) {
        const pair = key.split(',').map(Number) as [number, number];
        if (count > bestCount || (count === bestCount && best && (pair[0] < best[0] || (pair[0] === best[0] && pair[1] < best[1])))) {
          best = pair;
          bestCount = count;
        }
      }
      if (!best || bestCount < 2) break;
      const id = 256 + rank;
      merges.push({ rank, pair: best, id, count: bestCount });
      for (const word of words) word.ids = mergePair(word.ids, best, id);
    }
    return new BpeTokenizer(merges);
  }

  /** 这对 token 的合并规则 rank；没有规则时是 undefined。 */
  rankOf(a: number, b: number): number | undefined {
    return this.ranks.get(`${a},${b}`);
  }

  /** 编码。每块独立地反复合并 rank 最小的相邻对（tiktoken 的做法）。 */
  encode(text: string): number[] {
    const out: number[] = [];
    for (const chunk of pretokenize(text)) {
      let ids = utf8Encode(chunk);
      for (;;) {
        let bestRank = Infinity;
        for (let i = 0; i + 1 < ids.length; i++) bestRank = Math.min(bestRank, this.rankOf(ids[i], ids[i + 1]) ?? Infinity);
        if (bestRank === Infinity) break;
        const merge = this.merges[bestRank];
        ids = mergePair(ids, merge.pair, merge.id);
      }
      out.push(...ids);
    }
    return out;
  }

  /**
   * 带过程的编码：所有块一起，按 rank 从小到大一条条应用规则。
   * 每块里被用上的 rank 一定是递增的（新 token 参与的规则总是学得更晚），所以结果和 encode 完全相同。
   */
  encodeTrace(text: string): EncodeTrace {
    const chunks = pretokenize(text);
    const bytes = chunks.map((chunk) => utf8Encode(chunk));
    let tokens = bytes.map((ids) => ids.slice());
    const steps: MergeApplication[] = [];
    let lookups = 0;
    for (;;) {
      let bestRank = Infinity;
      for (const ids of tokens) {
        for (let i = 0; i + 1 < ids.length; i++) {
          lookups++;
          bestRank = Math.min(bestRank, this.rankOf(ids[i], ids[i + 1]) ?? Infinity);
        }
      }
      if (bestRank === Infinity) break;
      const merge = this.merges[bestRank];
      const at: MergeApplication['at'] = [];
      tokens = tokens.map((ids, chunk) => mergePair(ids, merge.pair, merge.id, (index) => at.push({ chunk, index })));
      steps.push({ merge, at, after: tokens.map((ids) => ids.slice()), lookups });
    }
    return { text, chunks, bytes, steps, tokens, ids: tokens.flat(), lookups };
  }

  /** 解码：拼接每个 token 的字节，再按 UTF-8 解码。结束符不产生文字。 */
  decode(ids: readonly number[]): string {
    return utf8Decode(this.bytesOfAll(ids));
  }

  bytesOf(id: number): number[] {
    const bytes = this.vocab[id];
    if (!bytes) throw new Error(`没有 token ${id}`);
    return bytes;
  }

  bytesOfAll(ids: readonly number[]): number[] {
    return ids.flatMap((id) => this.bytesOf(id));
  }

  /**
   * token 的展示文字：字节是完整的 UTF-8 时显示文字，空格写成 ␣；
   * 切在字符中间的 token 显示十六进制字节，比如「E6 A8」。
   */
  label(id: number): string {
    if (id === this.eos) return EOS_TEXT;
    const bytes = this.bytesOf(id);
    const text = utf8Decode(bytes);
    if (text.includes('�') || /[\x00-\x1f\x7f]/.test(text)) return bytes.map(hex2).join(' ');
    return text.replace(/ /g, '␣');
  }
}

/** 把 ids 里所有不重叠的 pair（从左到右）换成 id。onHit 收到每次合并在原序列里的下标。 */
export function mergePair(ids: readonly number[], pair: readonly [number, number], id: number, onHit?: (index: number) => void): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (i + 1 < ids.length && ids[i] === pair[0] && ids[i + 1] === pair[1]) {
      onHit?.(i);
      out.push(id);
      i++;
    } else {
      out.push(ids[i]);
    }
  }
  return out;
}

/**
 * GPT-2 的 bytes_to_unicode 映射：把 256 个字节一一映射成可打印字符，tokenizer.json 的 vocab 和 merges 就用这些字符写。
 * 可打印的 ASCII 和 Latin-1 字节映射成自己，其余（空格、控制字符、0x7F–0xA0、0xAD）依次映射到 U+0100 起。
 * 所以空格是「Ġ」（U+0120），汉字的字节会变成「æ¨¡」这样的「乱码」。
 */
export const BYTE_TO_UNICODE: readonly string[] = (() => {
  const keep: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) keep.push(b);
  for (let b = 0xa1; b <= 0xac; b++) keep.push(b);
  for (let b = 0xae; b <= 0xff; b++) keep.push(b);
  const out: string[] = new Array(256);
  for (const b of keep) out[b] = String.fromCodePoint(b);
  let next = 0;
  for (let b = 0; b < 256; b++) if (!out[b]) out[b] = String.fromCodePoint(256 + next++);
  return out;
})();

/** 一串字节在 tokenizer.json 里的写法。 */
export const gpt2Text = (bytes: readonly number[]): string => bytes.map((byte) => BYTE_TO_UNICODE[byte]).join('');

/** 一条合并规则在 tokenizer.json 的 merges 数组里的写法：两边用一个空格隔开，比如 "Ġ t"。 */
export function mergeEntry(tokenizer: BpeTokenizer, merge: Merge): string {
  return `${gpt2Text(tokenizer.bytesOf(merge.pair[0]))} ${gpt2Text(tokenizer.bytesOf(merge.pair[1]))}`;
}

/** 全站共用的分词器：在内置语料上训练。模块加载时训练一次，几毫秒。 */
export const TOKENIZER = BpeTokenizer.train(CORPUS, NUM_MERGES);
