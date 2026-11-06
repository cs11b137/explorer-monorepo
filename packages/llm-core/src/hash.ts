/**
 * 64 位 FNV-1a 和 u64 小端字节。llm 的前缀缓存（块哈希）和 context 的提示缓存模拟共用。
 * 真实系统的缓存键用什么哈希不公开或可配置（vLLM 有内置 hash 和 SHA-256），这里只取它「同样的字节得到同样的键」这一点。
 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** 64 位 FNV-1a。 */
export function fnv1a64(bytes: readonly number[]): bigint {
  let hash = FNV_OFFSET;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte & 0xff)) * FNV_PRIME) & MASK;
  return hash;
}

/**
 * 32 位 FNV-1a（偏移基 0x811c9dc5、质数 16777619）。LLMOPS 的特征哈希用它把字符 n-gram 映射到桶号：
 * 比 64 位版快得多（不用 BigInt），桶数只有几百到几千，32 位足够。
 */
export function fnv1a32(bytes: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ (byte & 0xff), 16777619);
  return hash >>> 0;
}

/** u64 小端字节。 */
export const u64Bytes = (value: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(i * 8)) & 0xffn));
