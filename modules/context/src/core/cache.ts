/**
 * Prompt Caching 的模拟，按 Anthropic 文档描述的规则（build-with-claude/prompt-caching）：
 *
 * - 缓存是前缀匹配：键由断点之前的全部字节决定，前面任何一个字节变了，后面的断点全部失效；
 *   渲染顺序是 tools → system → messages。
 * - 断点是内容块上的 cache_control（type: ephemeral，ttl 默认 5m，可选 1h），一次请求最多 4 个；
 *   顶层 cache_control 自动放在最后一个可缓存块上，也占一个名额。
 * - 每个断点向前最多看 20 个块找已有的缓存项；命中的部分记 cache_read_input_tokens，
 *   命中点到最后一个断点之间写入缓存、记 cache_creation_input_tokens（按 TTL 分到 ephemeral_5m / 1h），
 *   最后一个断点之后的记 input_tokens。三者之和是全部输入 token。
 * - 前缀短于模型的最小可缓存长度时静默不缓存，不报错。
 * - 有效期从写入或读取它的那次请求开始算，读取会免费刷新有效期。
 *
 * 真实的缓存键怎么算不公开；这里用 64 位 FNV-1a 把「渲染后的前缀字节」链式哈希成键，
 * 保证「同样的字节得到同样的键、改一个字节就变」这一点，检查器里标 internal。
 * token 数来自本站 ChatML 模板的真实计数（template.ts），块边界是每个内容块的结尾。
 */
import { fnv1a64, u64Bytes } from '@explorer/llm-core/hash';
import type { RenderedPrompt } from './template';

export type Ttl = '5m' | '1h';

export const TTL_SECONDS: Record<Ttl, number> = { '5m': 300, '1h': 3600 };
export const MAX_BREAKPOINTS = 4;
export const LOOKBACK_BLOCKS = 20;

export interface CacheBlock {
  /** 第几个可缓存块（按渲染顺序）。 */
  index: number;
  /** 内容来自请求的哪里：tools、system[0]、messages[2].content[0]…… */
  source: string;
  /** 到这个块结尾为止的前缀：字节数、token 数。 */
  bytes: number;
  tokens: number;
  /** 前缀的链式哈希：hash(上一块的哈希 + 这一块新增的字节)。 */
  hash: bigint;
  /** 这一块上有没有断点，有的话是哪种 TTL。 */
  breakpoint?: Ttl;
}

/** 把展开后的提示切成可缓存块，并标上断点。breakpoints 的键是 source。 */
export function cacheBlocks(prompt: RenderedPrompt, breakpoints: ReadonlyMap<string, Ttl>): CacheBlock[] {
  const blocks: CacheBlock[] = [];
  let hash = 0n;
  let fromByte = 0;
  let tokens = 0;
  for (const piece of prompt.pieces) {
    tokens += piece.tokens;
    if (piece.kind !== 'content' || !piece.source) continue;
    hash = fnv1a64([...u64Bytes(hash), ...prompt.bytes.slice(fromByte, piece.to)]);
    fromByte = piece.to;
    blocks.push({ index: blocks.length, source: piece.source, bytes: piece.to, tokens, hash, breakpoint: breakpoints.get(piece.source) });
  }
  if (breakpoints.size > MAX_BREAKPOINTS) throw new Error(`最多 ${MAX_BREAKPOINTS} 个缓存断点，这里有 ${breakpoints.size} 个`);
  for (const source of breakpoints.keys()) if (!blocks.some((block) => block.source === source)) throw new Error(`断点 ${source} 不在可缓存块里`);
  return blocks;
}

export interface CacheEntry {
  hash: bigint;
  /** 缓存的前缀 token 数。 */
  tokens: number;
  source: string;
  ttl: Ttl;
  /** 过期时刻（秒）。 */
  expires: number;
}

export interface CacheOutcome {
  /** 命中的块下标；没命中是 -1。 */
  hitAt: number;
  read: number;
  write5m: number;
  write1h: number;
  /** 最后一个断点之后、不参与缓存的 token。 */
  input: number;
  /** 这次写入的块下标。 */
  writes: number[];
  /** 因为前缀太短而没有写入的断点。 */
  tooShort: number[];
  /** 查找时看过、但已过期的块下标。 */
  expired: number[];
}

export class PromptCache {
  readonly entries = new Map<bigint, CacheEntry>();

  constructor(
    /** 模型的最小可缓存前缀（token），比如 Claude Opus 5.5 是 512。 */
    readonly minTokens: number,
  ) {}

  /** 处理一次请求：先查命中，再写入新的断点，返回 usage 的拆分。now 是请求开始的时刻（秒）。 */
  process(blocks: readonly CacheBlock[], totalTokens: number, now: number): CacheOutcome {
    const points = blocks.filter((block) => block.breakpoint);
    const outcome: CacheOutcome = { hitAt: -1, read: 0, write5m: 0, write1h: 0, input: totalTokens, writes: [], tooShort: [], expired: [] };
    if (!points.length) return outcome;
    // 每个断点向前看至多 20 个块，取最靠后的有效项。
    for (const point of points) {
      for (let j = point.index; j >= Math.max(0, point.index - LOOKBACK_BLOCKS + 1); j--) {
        const entry = this.entries.get(blocks[j].hash);
        if (!entry) continue;
        if (entry.expires <= now) {
          if (!outcome.expired.includes(j)) outcome.expired.push(j);
          continue;
        }
        if (j > outcome.hitAt) outcome.hitAt = j;
        break;
      }
    }
    let boundary = 0;
    if (outcome.hitAt >= 0) {
      const hit = blocks[outcome.hitAt];
      const entry = this.entries.get(hit.hash)!;
      entry.expires = now + TTL_SECONDS[entry.ttl];
      outcome.read = hit.tokens;
      boundary = hit.tokens;
    }
    for (const point of points) {
      if (point.index <= outcome.hitAt) continue;
      if (point.tokens < this.minTokens) {
        outcome.tooShort.push(point.index);
        continue;
      }
      const ttl = point.breakpoint!;
      const written = point.tokens - boundary;
      if (ttl === '5m') outcome.write5m += written;
      else outcome.write1h += written;
      boundary = point.tokens;
      outcome.writes.push(point.index);
      this.entries.set(point.hash, { hash: point.hash, tokens: point.tokens, source: point.source, ttl, expires: now + TTL_SECONDS[ttl] });
    }
    outcome.input = totalTokens - outcome.read - outcome.write5m - outcome.write1h;
    return outcome;
  }
}

/** 一次请求的缓存结果写成 usage 里的四个字段。 */
export const cacheUsage = (outcome: CacheOutcome) => ({
  input_tokens: outcome.input,
  cache_creation_input_tokens: outcome.write5m + outcome.write1h,
  cache_read_input_tokens: outcome.read,
  cache_creation: { ephemeral_5m_input_tokens: outcome.write5m, ephemeral_1h_input_tokens: outcome.write1h },
});

/** 短哈希，画在格子里。 */
export const shortHash = (hash: bigint): string => hash.toString(16).padStart(16, '0').slice(0, 4);
