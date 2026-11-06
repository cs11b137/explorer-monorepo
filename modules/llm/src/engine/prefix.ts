/**
 * 前缀缓存（automatic prefix caching），仿 vLLM 的做法：
 * - 序列按固定大小切块，只有填满的块才算哈希、才能被复用；
 * - 块哈希 = hash(父块哈希, 本块的 token id)，像链表一样把整段前缀串起来。
 *   所以两块 token 完全相同、但前面任何一个 token 不同，哈希也不同，不会被误用；
 * - 新请求从第 0 块开始逐块查表，遇到第一个不命中的块就停；
 * - 至少留最后一个 token 重新算，因为采样要用它的 logits，而缓存里只有 K、V。
 *
 * 真实引擎的哈希函数可以配置（vLLM 有内置 hash 和 SHA-256 两类），这里用 64 位 FNV-1a 代替：
 * 链式结构和命中规则相同，哈希值本身不同，所以检查器里标 internal。
 */
import { i32Bytes } from '../model/numeric';
import { FlopMeter, type Vec } from '../model/tensor';
import { forward, KVCache, type ForwardTrace, type Weights } from '../model/transformer';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** 64 位 FNV-1a。 */
export function fnv1a64(bytes: readonly number[]): bigint {
  let hash = FNV_OFFSET;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte & 0xff)) * FNV_PRIME) & MASK;
  return hash;
}

/** u64 小端字节。 */
export const u64Bytes = (value: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(i * 8)) & 0xffn));

/** 没有父块时用的哈希。 */
export const ROOT_HASH = 0n;

export interface BlockKey {
  /** 第几块（逻辑块号）。 */
  index: number;
  tokens: number[];
  parent: bigint;
  hash: bigint;
  /** 参与哈希的字节：父哈希 u64 小端 + 每个 token 的 int32 小端。 */
  bytes: number[];
}

/** 一块的哈希。 */
export function blockHash(parent: bigint, tokens: readonly number[]): { hash: bigint; bytes: number[] } {
  const bytes = [...u64Bytes(parent), ...tokens.flatMap(i32Bytes)];
  return { hash: fnv1a64(bytes), bytes };
}

/** 把序列切成满块并逐块算链式哈希。最后不满的一块不算。 */
export function blockKeys(tokens: readonly number[], blockSize: number): BlockKey[] {
  const out: BlockKey[] = [];
  let parent = ROOT_HASH;
  for (let index = 0; (index + 1) * blockSize <= tokens.length; index++) {
    const chunk = tokens.slice(index * blockSize, (index + 1) * blockSize);
    const { hash, bytes } = blockHash(parent, chunk);
    out.push({ index, tokens: chunk, parent, hash, bytes });
    parent = hash;
  }
  return out;
}

/** 缓存里的一块：哈希、所在的物理块号，以及这几个位置每层的 K、V。 */
export interface CachedBlock extends BlockKey {
  /** 物理块号：按写入顺序分配。 */
  physical: number;
  /** [层][块内位置] */
  k: Vec[][];
  v: Vec[][];
  /** 被多少个请求复用过。 */
  hits: number;
}

export interface PrefixMatch {
  /** 这个请求的全部满块。 */
  keys: BlockKey[];
  /** 从第 0 块起连续命中的块。 */
  hits: CachedBlock[];
  /** 第一个没命中的块号（全部命中时等于 keys.length）。 */
  missAt: number;
  /** 复用了多少个位置。 */
  reused: number;
}

export interface PrefillResult extends PrefixMatch {
  /** 只对没命中的位置做的前向。 */
  trace: ForwardTrace;
  cache: KVCache;
  /** 实际算了多少个位置。 */
  computed: number;
  /** 这次新写进缓存的块。 */
  inserted: CachedBlock[];
}

export class PrefixCache {
  readonly blocks = new Map<bigint, CachedBlock>();
  private nextPhysical = 0;

  constructor(readonly blockSize: number) {}

  /** 逐块查表。最多复用到倒数第二个位置：最后一个位置必须重算，才有 logits 可以采样。 */
  match(tokens: readonly number[]): PrefixMatch {
    const keys = blockKeys(tokens, this.blockSize);
    const hits: CachedBlock[] = [];
    const usable = Math.floor((tokens.length - 1) / this.blockSize);
    for (const key of keys.slice(0, usable)) {
      const block = this.blocks.get(key.hash);
      if (!block) break;
      hits.push(block);
    }
    return { keys, hits, missAt: hits.length, reused: hits.length * this.blockSize };
  }

  /** 把命中的块拼回一个 KVCache，接着在它上面算剩下的位置。 */
  restore(weights: Weights, hits: readonly CachedBlock[]): KVCache {
    const cache = new KVCache(weights.config);
    for (const block of hits) {
      for (let l = 0; l < weights.config.nLayers; l++) {
        cache.k[l].push(...block.k[l].map((row) => row.slice()));
        cache.v[l].push(...block.v[l].map((row) => row.slice()));
      }
    }
    return cache;
  }

  /** 把一段算好的序列里所有满块写进缓存（已有的跳过）。 */
  insert(tokens: readonly number[], cache: KVCache): CachedBlock[] {
    const added: CachedBlock[] = [];
    for (const key of blockKeys(tokens.slice(0, cache.length), this.blockSize)) {
      if (this.blocks.has(key.hash)) continue;
      const from = key.index * this.blockSize;
      const to = from + this.blockSize;
      const block: CachedBlock = { ...key, physical: this.nextPhysical++, k: cache.k.map((layer) => layer.slice(from, to).map((row) => row.slice())), v: cache.v.map((layer) => layer.slice(from, to).map((row) => row.slice())), hits: 0 };
      this.blocks.set(key.hash, block);
      added.push(block);
    }
    return added;
  }

  /** 一个请求的预填充：先查前缀，复用命中的 K、V，只算剩下的位置，再把新的满块写回缓存。 */
  prefill(weights: Weights, tokens: readonly number[], meter: FlopMeter = new FlopMeter()): PrefillResult {
    const found = this.match(tokens);
    for (const block of found.hits) block.hits++;
    const cache = this.restore(weights, found.hits);
    const trace = forward(weights, tokens.slice(found.reused), { cache, meter, lastLogitsOnly: true });
    const inserted = this.insert(tokens, cache);
    return { ...found, trace, cache, computed: tokens.length - found.reused, inserted };
  }
}

/** 64 位哈希的短写法：前 4 个十六进制位，画在格子里。 */
export const shortHash = (hash: bigint): string => hash.toString(16).padStart(16, '0').slice(0, 4);
export const fullHash = (hash: bigint): string => `0x${hash.toString(16).padStart(16, '0')}`;
