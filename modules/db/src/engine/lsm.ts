/**
 * LSM 树：LevelDB 1.23 的日志、MemTable、SSTable、读路径和合并。
 * 编码按 LevelDB 源码（db/log_format.h、db/write_batch.cc、db/memtable.cc、table/*.cc、util/bloom.cc、util/hash.cc）实现，
 * 写出的 .log 和 .ldb 已与真实 LevelDB 写出的文件逐字节比对（tests/golden/leveldb.json）。
 * PostgreSQL 没有 LSM，这一课的对照对象是它的 B+ 树和堆页。
 */
import { crcUpdate, CRC_INIT, crcFinal } from './crc32c';

export const kTypeDeletion = 0;
export const kTypeValue = 1;
/** 查找时用的类型：和 kTypeValue 相同，配合最大序列号排在同一键的所有版本前面。 */
export const kValueTypeForSeek = kTypeValue;
export const kMaxSequenceNumber = (1n << 56n) - 1n;

export const TABLE_MAGIC = 0xdb4775248b80fb57n;
export const BLOCK_TRAILER_SIZE = 5;
/** 两个 BlockHandle 各最多 20 字节，补齐到 40，再加 8 字节 magic。 */
export const FOOTER_SIZE = 48;
export const HANDLE_MAX = 20;
export const LOG_BLOCK_SIZE = 32768;
export const LOG_HEADER_SIZE = 7;
export const LOG_FULL = 1;
export const LOG_FIRST = 2;
export const LOG_MIDDLE = 3;
export const LOG_LAST = 4;
export const LOG_TYPE_NAMES = ['kZeroType', 'kFullType', 'kFirstType', 'kMiddleType', 'kLastType'];
export const FILTER_BASE_LG = 11;
export const BLOOM_SEED = 0xbc9f1d34;
export const FILTER_NAME = 'filter.leveldb.BuiltinBloomFilter2';
/** config::kMaxMemCompactLevel：刷盘时最多推到第 2 层。 */
export const MAX_MEM_COMPACT_LEVEL = 2;
export const NUM_LEVELS = 7;

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
export const str = (bytes: ArrayLike<number>): string => String.fromCharCode(...Array.from(bytes));

// ---------- 定长和变长整数（util/coding.cc） ----------

export function putFixed32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

export function putFixed64(out: number[], v: bigint): void {
  for (let shift = 0n; shift < 64n; shift += 8n) out.push(Number((v >> shift) & 0xffn));
}

export function putVarint(out: number[], value: number | bigint): void {
  let v = BigInt(value);
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

export const varintBytes = (value: number | bigint): number[] => {
  const out: number[] = [];
  putVarint(out, value);
  return out;
};

export function getVarint(b: ArrayLike<number>, at: number): { value: number; next: number } {
  let result = 0n;
  let shift = 0n;
  let p = at;
  for (;;) {
    const byte = b[p++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
  }
  return { value: Number(result), next: p };
}

export const getFixed32 = (b: ArrayLike<number>, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
export const getFixed64 = (b: ArrayLike<number>, at: number): bigint => BigInt(getFixed32(b, at)) | (BigInt(getFixed32(b, at + 4)) << 32n);

// ---------- 校验和与哈希 ----------

const MASK_DELTA = 0xa282ead8;

/** crc32c::Mask：先循环右移 15 位再加常数。数据里本身含有 CRC 时，再算 CRC 会出问题，所以存的是掩码后的值。 */
export const maskCrc = (crc: number): number => ((((crc >>> 15) | (crc << 17)) >>> 0) + MASK_DELTA) >>> 0;
export const unmaskCrc = (masked: number): number => {
  const rot = (masked - MASK_DELTA) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
};

/** util/hash.cc 的 Hash：类似 MurmurHash，按 4 字节小端读入。 */
export function levelHash(data: ArrayLike<number>, seed: number): number {
  const m = 0xc6a4a793;
  const n = data.length;
  let h = (seed ^ Math.imul(n, m)) >>> 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    h = (h + getFixed32(data, i)) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  const rest = n - i;
  if (rest > 0) {
    if (rest === 3) h = (h + (data[i + 2] << 16)) >>> 0;
    if (rest >= 2) h = (h + (data[i + 1] << 8)) >>> 0;
    h = (h + data[i]) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ (h >>> 24)) >>> 0;
  }
  return h;
}

export const bloomHash = (key: ArrayLike<number>): number => levelHash(key, BLOOM_SEED);

// ---------- 布隆过滤器（util/bloom.cc） ----------

export class BloomPolicy {
  readonly k: number;

  constructor(readonly bitsPerKey = 10) {
    // 0.69 约等于 ln 2，这时误判率最低。
    this.k = Math.max(1, Math.min(30, Math.floor(bitsPerKey * 0.69)));
  }

  /** 每个键的 k 个探针位置：双重哈希，增量是哈希值循环右移 17 位。 */
  probes(key: ArrayLike<number>, bits: number, k = this.k): number[] {
    let h = bloomHash(key);
    const delta = ((h >>> 17) | (h << 15)) >>> 0;
    const out: number[] = [];
    for (let j = 0; j < k; j++) {
      out.push(h % bits);
      h = (h + delta) >>> 0;
    }
    return out;
  }

  create(keys: Uint8Array[]): Uint8Array {
    let bits = keys.length * this.bitsPerKey;
    // 键太少时误判率很高，所以至少 64 位。
    if (bits < 64) bits = 64;
    const bytes = Math.ceil(bits / 8);
    bits = bytes * 8;
    const out = new Uint8Array(bytes + 1);
    out[bytes] = this.k;
    for (const key of keys) for (const pos of this.probes(key, bits)) out[pos >> 3] |= 1 << (pos & 7);
    return out;
  }

  mayMatch(key: ArrayLike<number>, filter: Uint8Array): boolean {
    if (filter.length < 2) return false;
    const bits = (filter.length - 1) * 8;
    const k = filter[filter.length - 1];
    if (k > 30) return true;
    return this.probes(key, bits, k).every((pos) => filter[pos >> 3] & (1 << (pos & 7)));
  }
}

// ---------- 内部键 ----------

/** 内部键 = 用户键 + 8 字节 tag，tag = 序列号 << 8 | 类型。 */
export function internalKey(user: Uint8Array, seq: number | bigint, type: number): Uint8Array {
  const out = Array.from(user);
  putFixed64(out, (BigInt(seq) << 8n) | BigInt(type));
  return Uint8Array.from(out);
}

export interface ParsedKey {
  user: Uint8Array;
  seq: bigint;
  type: number;
}

export function parseInternalKey(ikey: ArrayLike<number>): ParsedKey {
  const n = ikey.length;
  const tag = getFixed64(ikey, n - 8);
  return { user: Uint8Array.from(Array.from(ikey).slice(0, n - 8)), seq: tag >> 8n, type: Number(tag & 0xffn) };
}

export function compareBytes(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** InternalKeyComparator：用户键升序，tag 降序，所以同一个键的新版本排在前面。 */
export function compareInternal(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const r = compareBytes(Array.from(a).slice(0, a.length - 8), Array.from(b).slice(0, b.length - 8));
  if (r) return r;
  const ta = getFixed64(a, a.length - 8);
  const tb = getFixed64(b, b.length - 8);
  return ta > tb ? -1 : ta < tb ? 1 : 0;
}

/** BytewiseComparator::FindShortestSeparator 加上内部键的处理。 */
export function shortestSeparator(start: Uint8Array, limit: Uint8Array): Uint8Array {
  const us = start.subarray(0, start.length - 8);
  const ul = limit.subarray(0, limit.length - 8);
  const min = Math.min(us.length, ul.length);
  let diff = 0;
  while (diff < min && us[diff] === ul[diff]) diff++;
  if (diff >= min) return start;
  const byte = us[diff];
  if (byte < 0xff && byte + 1 < ul[diff]) {
    const tmp = Uint8Array.from(us.subarray(0, diff + 1));
    tmp[diff] += 1;
    if (tmp.length < us.length && compareBytes(us, tmp) < 0) return internalKey(tmp, kMaxSequenceNumber, kValueTypeForSeek);
  }
  return start;
}

/** BytewiseComparator::FindShortSuccessor：第一个不是 0xff 的字节加 1，后面截掉。 */
export function shortSuccessor(key: Uint8Array): Uint8Array {
  const user = key.subarray(0, key.length - 8);
  for (let i = 0; i < user.length; i++) {
    if (user[i] !== 0xff) {
      const tmp = Uint8Array.from(user.subarray(0, i + 1));
      tmp[i] += 1;
      if (tmp.length < user.length) return internalKey(tmp, kMaxSequenceNumber, kValueTypeForSeek);
      return key;
    }
  }
  return key;
}

// ---------- 日志（db/log_writer.cc）和 WriteBatch（db/write_batch.cc） ----------

export interface BatchOp {
  type: typeof kTypeValue | typeof kTypeDeletion;
  key: Uint8Array;
  value: Uint8Array;
}

/** WriteBatch::rep_：8 字节序列号、4 字节条数，然后每条是类型字节加带长度前缀的键（和值）。 */
export function batchRep(seq: number, ops: BatchOp[]): Uint8Array {
  const out: number[] = [];
  putFixed64(out, BigInt(seq));
  putFixed32(out, ops.length);
  for (const op of ops) {
    out.push(op.type);
    putVarint(out, op.key.length);
    out.push(...op.key);
    if (op.type === kTypeValue) {
      putVarint(out, op.value.length);
      out.push(...op.value);
    }
  }
  return Uint8Array.from(out);
}

export interface LogRecord {
  /** 记录在日志文件里的偏移。 */
  offset: number;
  bytes: Uint8Array;
  type: number;
}

export function logRecordCrc(type: number, payload: ArrayLike<number>): number {
  return maskCrc(crcFinal(crcUpdate(crcUpdate(CRC_INIT, [type]), payload)));
}

export class LogWriter {
  readonly bytes: number[] = [];
  private blockOffset = 0;

  constructor(readonly number: number) {}

  /** AddRecord：放不进当前 32 KiB 块就切成 FIRST/MIDDLE/LAST 几段；块尾不足 7 字节时补零。 */
  addRecord(payload: Uint8Array): LogRecord[] {
    const out: LogRecord[] = [];
    let left = payload.length;
    let at = 0;
    let begin = true;
    do {
      const leftover = LOG_BLOCK_SIZE - this.blockOffset;
      if (leftover < LOG_HEADER_SIZE) {
        for (let i = 0; i < leftover; i++) this.bytes.push(0);
        this.blockOffset = 0;
      }
      const avail = LOG_BLOCK_SIZE - this.blockOffset - LOG_HEADER_SIZE;
      const fragment = Math.min(left, avail);
      const end = left === fragment;
      const type = begin && end ? LOG_FULL : begin ? LOG_FIRST : end ? LOG_LAST : LOG_MIDDLE;
      const data = payload.subarray(at, at + fragment);
      const record: number[] = [];
      putFixed32(record, logRecordCrc(type, data));
      record.push(fragment & 0xff, fragment >>> 8, type, ...data);
      out.push({ offset: this.bytes.length, bytes: Uint8Array.from(record), type });
      this.bytes.push(...record);
      this.blockOffset += record.length;
      at += fragment;
      left -= fragment;
      begin = false;
    } while (left > 0);
    return out;
  }
}

// ---------- 跳表的随机高度（util/random.h、db/skiplist.h） ----------

export class LevelRandom {
  private seed: number;

  constructor(s: number) {
    this.seed = s & 0x7fffffff;
    if (this.seed === 0 || this.seed === 2147483647) this.seed = 1;
  }

  /** seed = seed × 16807 mod (2^31 − 1)，Park–Miller 最小标准生成器。 */
  next(): number {
    const product = BigInt(this.seed) * 16807n;
    let seed = Number((product >> 31n) + (product & 0x7fffffffn));
    if (seed > 2147483647) seed -= 2147483647;
    this.seed = seed;
    return seed;
  }
}

export const SKIPLIST_MAX_HEIGHT = 12;

// ---------- MemTable（db/memtable.cc） ----------

export interface MemEntry {
  seq: number;
  type: number;
  user: Uint8Array;
  value: Uint8Array;
  ikey: Uint8Array;
  /** MemTable::Add 写进 arena 的字节：varint32 内部键长、内部键、varint32 值长、值。 */
  encoded: Uint8Array;
  /** 跳表节点的高度，由 Random(0xdeadbeef) 决定。 */
  height: number;
}

export class MemTable {
  /** 按内部键排好序，就是跳表第 0 层从头到尾的顺序。 */
  readonly entries: MemEntry[] = [];
  private readonly rnd = new LevelRandom(0xdeadbeef);

  randomHeight(): number {
    let height = 1;
    while (height < SKIPLIST_MAX_HEIGHT && this.rnd.next() % 4 === 0) height++;
    return height;
  }

  add(seq: number, type: number, user: Uint8Array, value: Uint8Array): MemEntry {
    const ikey = internalKey(user, seq, type);
    const encoded: number[] = [];
    putVarint(encoded, ikey.length);
    encoded.push(...ikey);
    putVarint(encoded, value.length);
    encoded.push(...value);
    const entry: MemEntry = { seq, type, user, value, ikey, encoded: Uint8Array.from(encoded), height: this.randomHeight() };
    let at = 0;
    while (at < this.entries.length && compareInternal(this.entries[at].ikey, ikey) < 0) at++;
    this.entries.splice(at, 0, entry);
    return entry;
  }

  /** 找第一个不小于 (key, seq) 的项；用户键相同才算命中。 */
  get(user: Uint8Array, seq: number): MemEntry | null {
    const lookup = internalKey(user, seq, kValueTypeForSeek);
    const hit = this.entries.find((entry) => compareInternal(entry.ikey, lookup) >= 0);
    return hit && compareBytes(hit.user, user) === 0 ? hit : null;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** LookupKey：MemTable 查找用的键，varint32 长度 + 用户键 + tag。 */
export function lookupKey(user: Uint8Array, seq: number): Uint8Array {
  const out: number[] = [];
  putVarint(out, user.length + 8);
  out.push(...internalKey(user, seq, kValueTypeForSeek));
  return Uint8Array.from(out);
}

// ---------- 块（table/block_builder.cc、table/block.cc） ----------

export interface BlockEntry {
  /** 在块内的偏移。 */
  offset: number;
  shared: number;
  nonShared: number;
  valueLength: number;
  key: Uint8Array;
  value: Uint8Array;
  /** 头部三个 varint 各占的字节数。 */
  headerLengths: [number, number, number];
  length: number;
}

export class BlockBuilder {
  private buffer: number[] = [];
  private restarts: number[] = [0];
  private counter = 0;
  private lastKey: Uint8Array = new Uint8Array();

  constructor(readonly restartInterval: number) {}

  get empty(): boolean {
    return this.buffer.length === 0;
  }

  add(key: Uint8Array, value: Uint8Array): void {
    let shared = 0;
    if (this.counter < this.restartInterval) {
      const min = Math.min(this.lastKey.length, key.length);
      while (shared < min && this.lastKey[shared] === key[shared]) shared++;
    } else {
      // 重启点：存完整的键，查找时可以从这里开始二分。
      this.restarts.push(this.buffer.length);
      this.counter = 0;
    }
    putVarint(this.buffer, shared);
    putVarint(this.buffer, key.length - shared);
    putVarint(this.buffer, value.length);
    this.buffer.push(...key.subarray(shared), ...value);
    this.lastKey = key;
    this.counter += 1;
  }

  currentSizeEstimate(): number {
    return this.buffer.length + this.restarts.length * 4 + 4;
  }

  finish(): Uint8Array {
    const out = [...this.buffer];
    for (const r of this.restarts) putFixed32(out, r);
    putFixed32(out, this.restarts.length);
    return Uint8Array.from(out);
  }

  reset(): void {
    this.buffer = [];
    this.restarts = [0];
    this.counter = 0;
    this.lastKey = new Uint8Array();
  }
}

export interface ParsedBlock {
  entries: BlockEntry[];
  restarts: number[];
  /** 重启点数组在块内的起点。 */
  restartsAt: number;
}

export function parseBlock(block: Uint8Array): ParsedBlock {
  const count = getFixed32(block, block.length - 4);
  const restartsAt = block.length - 4 - count * 4;
  const restarts = Array.from({ length: count }, (_, i) => getFixed32(block, restartsAt + i * 4));
  const entries: BlockEntry[] = [];
  let at = 0;
  let last = new Uint8Array();
  while (at < restartsAt) {
    const a = getVarint(block, at);
    const b = getVarint(block, a.next);
    const c = getVarint(block, b.next);
    const keyAt = c.next;
    const key = Uint8Array.from([...last.subarray(0, a.value), ...block.subarray(keyAt, keyAt + b.value)]);
    const value = block.slice(keyAt + b.value, keyAt + b.value + c.value);
    const length = keyAt + b.value + c.value - at;
    entries.push({ offset: at, shared: a.value, nonShared: b.value, valueLength: c.value, key, value, headerLengths: [a.next - at, b.next - a.next, c.next - b.next], length });
    last = key;
    at += length;
  }
  return { entries, restarts, restartsAt };
}

export interface BlockHandle {
  offset: number;
  size: number;
}

export function encodeHandle(handle: BlockHandle): number[] {
  const out: number[] = [];
  putVarint(out, handle.offset);
  putVarint(out, handle.size);
  return out;
}

export function decodeHandle(b: ArrayLike<number>, at = 0): BlockHandle & { next: number } {
  const offset = getVarint(b, at);
  const size = getVarint(b, offset.next);
  return { offset: offset.value, size: size.value, next: size.next };
}

/** 块尾 5 字节：压缩类型 + 掩码后的 CRC-32C（覆盖块内容和类型字节）。 */
export function blockTrailer(contents: ArrayLike<number>, type = 0): number[] {
  const crc = crcFinal(crcUpdate(crcUpdate(CRC_INIT, contents), [type]));
  const out = [type];
  putFixed32(out, maskCrc(crc));
  return out;
}

// ---------- 过滤块（table/filter_block.cc） ----------

export class FilterBlockBuilder {
  private keys: Uint8Array[] = [];
  private result: number[] = [];
  private offsets: number[] = [];

  constructor(readonly policy: BloomPolicy) {}

  startBlock(blockOffset: number): void {
    const index = Math.floor(blockOffset / (1 << FILTER_BASE_LG));
    while (index > this.offsets.length) this.generate();
  }

  /** 加入过滤器的是用户键：InternalFilterPolicy 先去掉 8 字节 tag。 */
  addKey(ikey: Uint8Array): void {
    this.keys.push(ikey.subarray(0, ikey.length - 8));
  }

  private generate(): void {
    this.offsets.push(this.result.length);
    if (!this.keys.length) return;
    this.result.push(...this.policy.create(this.keys));
    this.keys = [];
  }

  finish(): Uint8Array {
    if (this.keys.length) this.generate();
    const arrayOffset = this.result.length;
    const out = [...this.result];
    for (const offset of this.offsets) putFixed32(out, offset);
    putFixed32(out, arrayOffset);
    out.push(FILTER_BASE_LG);
    return Uint8Array.from(out);
  }
}

export interface ParsedFilterBlock {
  filters: Array<{ offset: number; bytes: Uint8Array }>;
  arrayOffset: number;
  baseLg: number;
}

export function parseFilterBlock(block: Uint8Array): ParsedFilterBlock {
  const n = block.length;
  const baseLg = block[n - 1];
  const arrayOffset = getFixed32(block, n - 5);
  const count = (n - 5 - arrayOffset) / 4;
  const starts = Array.from({ length: count }, (_, i) => getFixed32(block, arrayOffset + i * 4));
  const filters = starts.map((start, i) => ({ offset: start, bytes: block.slice(start, i + 1 < count ? starts[i + 1] : arrayOffset) }));
  return { filters, arrayOffset, baseLg };
}

// ---------- SSTable（table/table_builder.cc、table/format.cc） ----------

export interface TableOptions {
  blockSize: number;
  restartInterval: number;
  bitsPerKey: number;
}

export const DEFAULT_TABLE_OPTIONS: TableOptions = { blockSize: 4096, restartInterval: 16, bitsPerKey: 10 };

export interface TableLayout {
  dataBlocks: BlockHandle[];
  filter: BlockHandle;
  metaindex: BlockHandle;
  index: BlockHandle;
  footer: number;
  size: number;
}

export function buildTable(entries: Array<{ ikey: Uint8Array; value: Uint8Array }>, options: TableOptions): { bytes: Uint8Array; layout: TableLayout } {
  const policy = new BloomPolicy(options.bitsPerKey);
  const out: number[] = [];
  const data = new BlockBuilder(options.restartInterval);
  const index = new BlockBuilder(1);
  const filter = new FilterBlockBuilder(policy);
  const dataBlocks: BlockHandle[] = [];
  let lastKey: Uint8Array = new Uint8Array();
  // 数据块写完后，要等看到下一个键才能算出分隔键，所以索引项先挂起。
  const state: { pending: BlockHandle | null } = { pending: null };
  filter.startBlock(0);

  const writeRaw = (contents: Uint8Array): BlockHandle => {
    const handle = { offset: out.length, size: contents.length };
    out.push(...contents, ...blockTrailer(contents));
    return handle;
  };
  const flush = () => {
    if (data.empty) return;
    state.pending = writeRaw(data.finish());
    dataBlocks.push(state.pending);
    data.reset();
    filter.startBlock(out.length);
  };

  for (const entry of entries) {
    if (state.pending) {
      index.add(shortestSeparator(lastKey, entry.ikey), Uint8Array.from(encodeHandle(state.pending)));
      state.pending = null;
    }
    filter.addKey(entry.ikey);
    lastKey = entry.ikey;
    data.add(entry.ikey, entry.value);
    if (data.currentSizeEstimate() >= options.blockSize) flush();
  }
  flush();
  const filterHandle = writeRaw(filter.finish());
  const meta = new BlockBuilder(options.restartInterval);
  meta.add(enc(FILTER_NAME), Uint8Array.from(encodeHandle(filterHandle)));
  const metaHandle = writeRaw(meta.finish());
  if (state.pending) index.add(shortSuccessor(lastKey), Uint8Array.from(encodeHandle(state.pending)));
  const indexHandle = writeRaw(index.finish());
  const footer = out.length;
  const handles = [...encodeHandle(metaHandle), ...encodeHandle(indexHandle)];
  while (handles.length < HANDLE_MAX * 2) handles.push(0);
  out.push(...handles);
  putFixed32(out, Number(TABLE_MAGIC & 0xffffffffn));
  putFixed32(out, Number(TABLE_MAGIC >> 32n));
  return { bytes: Uint8Array.from(out), layout: { dataBlocks, filter: filterHandle, metaindex: metaHandle, index: indexHandle, footer, size: out.length } };
}

export interface Footer {
  metaindex: BlockHandle;
  index: BlockHandle;
  /** 两个 BlockHandle 实际用掉的字节数，后面是补零。 */
  used: number;
  magic: bigint;
}

export function parseFooter(file: Uint8Array): Footer {
  const at = file.length - FOOTER_SIZE;
  const meta = decodeHandle(file, at);
  const index = decodeHandle(file, meta.next);
  return { metaindex: { offset: meta.offset, size: meta.size }, index: { offset: index.offset, size: index.size }, used: index.next - at, magic: getFixed64(file, file.length - 8) };
}

export const blockOf = (file: Uint8Array, handle: BlockHandle): Uint8Array => file.subarray(handle.offset, handle.offset + handle.size);

/** 打开一个表：读 footer、索引块、元索引块和过滤块。真实实现会把它们缓存在 TableCache 里。 */
export class Table {
  readonly footer: Footer;
  readonly index: ParsedBlock;
  readonly metaindex: ParsedBlock;
  readonly filterHandle: BlockHandle;
  readonly filter: ParsedFilterBlock;
  readonly policy: BloomPolicy;

  constructor(readonly bytes: Uint8Array, bitsPerKey = 10) {
    this.footer = parseFooter(bytes);
    if (this.footer.magic !== TABLE_MAGIC) throw new Error('不是 SSTable：magic 不对');
    this.index = parseBlock(blockOf(bytes, this.footer.index));
    this.metaindex = parseBlock(blockOf(bytes, this.footer.metaindex));
    const meta = this.metaindex.entries.find((entry) => str(entry.key) === FILTER_NAME)!;
    this.filterHandle = decodeHandle(meta.value);
    this.filter = parseFilterBlock(blockOf(bytes, this.filterHandle));
    this.policy = new BloomPolicy(bitsPerKey);
  }

  dataHandles(): BlockHandle[] {
    return this.index.entries.map((entry) => decodeHandle(entry.value));
  }

  /** 所有数据项，按内部键顺序。 */
  entries(): BlockEntry[] {
    return this.dataHandles().flatMap((handle) => parseBlock(blockOf(this.bytes, handle)).entries);
  }

  filterFor(blockOffset: number): Uint8Array {
    return this.filter.filters[blockOffset >> this.filter.baseLg]?.bytes ?? new Uint8Array();
  }

  /** Table::InternalGet：先在索引块里找，再问过滤器，过滤器说可能有才读数据块。 */
  get(user: Uint8Array, seq: number): TableProbe {
    const target = internalKey(user, seq, kValueTypeForSeek);
    const indexEntry = this.index.entries.find((entry) => compareInternal(entry.key, target) >= 0);
    if (!indexEntry) return { indexEntry: null, handle: null, mayMatch: false, entry: null };
    const handle = decodeHandle(indexEntry.value);
    const mayMatch = this.policy.mayMatch(user, this.filterFor(handle.offset));
    if (!mayMatch) return { indexEntry, handle, mayMatch, entry: null };
    const block = parseBlock(blockOf(this.bytes, handle));
    const hit = block.entries.find((entry) => compareInternal(entry.key, target) >= 0);
    const entry = hit && compareBytes(hit.key.subarray(0, hit.key.length - 8), user) === 0 ? hit : null;
    return { indexEntry, handle, mayMatch, entry };
  }
}

export interface TableProbe {
  indexEntry: BlockEntry | null;
  handle: BlockHandle | null;
  mayMatch: boolean;
  entry: BlockEntry | null;
}

// ---------- 数据库（db/db_impl.cc、db/version_set.cc 的简化版） ----------

export interface FileMeta {
  number: number;
  level: number;
  smallest: Uint8Array;
  largest: Uint8Array;
  table: Table;
}

export const userOf = (ikey: Uint8Array): Uint8Array => ikey.subarray(0, ikey.length - 8);

export interface DbOptions extends TableOptions {
  /** MemTable 放多少条就算满。LevelDB 按内存用量（write_buffer_size，默认 4 MiB）判断，本课按条数。 */
  memEntries: number;
  /** L0 文件数到这个值就合并。LevelDB 是 config::kL0_CompactionTrigger = 4。 */
  l0Trigger: number;
}

export interface WriteResult {
  seq: number;
  op: BatchOp;
  batch: Uint8Array;
  records: LogRecord[];
  logNumber: number;
  entry: MemEntry;
  /** 这次写入前 MemTable 满了：冻结成 imm，换了新日志。 */
  switched: { frozenLog: number; newLog: number } | null;
}

export interface FlushResult {
  file: FileMeta;
  /** 删掉的旧日志。 */
  obsoleteLog: number;
  /** PickLevelForMemTableOutput 为什么选这一层。 */
  reason: string;
}

export interface GetStep {
  where: string;
  level: 'mem' | 'imm' | number;
  file?: FileMeta;
  result: 'miss' | 'range' | 'filter' | 'absent' | 'found' | 'deleted';
  probe?: TableProbe;
  entry?: MemEntry;
}

export interface GetResult {
  value: Uint8Array | null;
  steps: GetStep[];
}

export interface MergeRow {
  ikey: Uint8Array;
  value: Uint8Array;
  from: number;
  drop: null | 'shadowed' | 'tombstone';
}

export interface CompactionResult {
  level: number;
  inputs: FileMeta[][];
  rows: MergeRow[];
  outputs: FileMeta[];
  /** 合并后被 VersionEdit 删掉的文件。 */
  deleted: Array<[number, number]>;
}

export class LsmDb {
  mem = new MemTable();
  imm: MemTable | null = null;
  readonly levels: FileMeta[][] = Array.from({ length: NUM_LEVELS }, () => []);
  lastSeq = 0;
  log: LogWriter;
  immLog = 0;

  constructor(readonly options: DbOptions, public nextFile: number) {
    this.log = new LogWriter(this.nextFile++);
  }

  /** 直接放一个已有的表文件，用来布置课程开始前的状态。 */
  install(level: number, number: number, entries: Array<{ seq: number; type: number; key: string; value: string }>): FileMeta {
    const sorted = entries.map((e) => ({ ikey: internalKey(enc(e.key), e.seq, e.type), value: enc(e.value) })).sort((a, b) => compareInternal(a.ikey, b.ikey));
    const file = this.makeFile(level, number, sorted);
    this.addFile(file);
    this.lastSeq = Math.max(this.lastSeq, ...entries.map((e) => e.seq));
    return file;
  }

  private makeFile(level: number, number: number, entries: Array<{ ikey: Uint8Array; value: Uint8Array }>): FileMeta {
    const { bytes } = buildTable(entries, this.options);
    return { number, level, smallest: entries[0].ikey, largest: entries[entries.length - 1].ikey, table: new Table(bytes, this.options.bitsPerKey) };
  }

  private addFile(file: FileMeta): void {
    const list = this.levels[file.level];
    list.push(file);
    // VersionSet::Builder 每层都按最小键排；读 L0 时再按文件号从新到旧。
    list.sort((a, b) => compareInternal(a.smallest, b.smallest) || a.number - b.number);
  }

  put(key: string, value: string): WriteResult {
    return this.write({ type: kTypeValue, key: enc(key), value: enc(value) });
  }

  delete(key: string): WriteResult {
    return this.write({ type: kTypeDeletion, key: enc(key), value: new Uint8Array() });
  }

  /** DBImpl::Write：MakeRoomForWrite、写日志、插入 MemTable。每次写一个只有一条操作的 WriteBatch。 */
  private write(op: BatchOp): WriteResult {
    let switched: WriteResult['switched'] = null;
    if (this.mem.size >= this.options.memEntries) {
      if (this.imm) throw new Error('imm 还没刷完，真实实现会在这里等后台线程');
      const frozenLog = this.log.number;
      this.imm = this.mem;
      this.immLog = frozenLog;
      this.log = new LogWriter(this.nextFile++);
      this.mem = new MemTable();
      switched = { frozenLog, newLog: this.log.number };
    }
    const seq = this.lastSeq + 1;
    const batch = batchRep(seq, [op]);
    const records = this.log.addRecord(batch);
    const entry = this.mem.add(seq, op.type, op.key, op.value);
    this.lastSeq = seq;
    return { seq, op, batch, records, logNumber: this.log.number, entry, switched };
  }

  private overlaps(level: number, smallest: Uint8Array, largest: Uint8Array): FileMeta[] {
    return this.levels[level].filter((f) => compareBytes(userOf(f.largest), smallest) >= 0 && compareBytes(userOf(f.smallest), largest) <= 0);
  }

  /** CompactMemTable → WriteLevel0Table：把 imm 按顺序写成一个表文件。 */
  flush(): FlushResult {
    const imm = this.imm;
    if (!imm) throw new Error('没有要刷的 imm');
    const number = this.nextFile++;
    const entries = imm.entries.map((e) => ({ ikey: e.ikey, value: e.value }));
    const lo = userOf(entries[0].ikey);
    const hi = userOf(entries[entries.length - 1].ikey);
    // Version::PickLevelForMemTableOutput：和 L0 不重叠时，可以往下推，直到下一层有重叠或到 kMaxMemCompactLevel。
    let level = 0;
    let reason = '和 L0 已有文件的键范围重叠，只能放在 L0';
    if (!this.overlaps(0, lo, hi).length) {
      while (level < MAX_MEM_COMPACT_LEVEL && !this.overlaps(level + 1, lo, hi).length) level++;
      reason = `和 L0 不重叠，推到 L${level}`;
    }
    const file = this.makeFile(level, number, entries);
    this.addFile(file);
    this.imm = null;
    return { file, obsoleteLog: this.immLog, reason };
  }

  /** DBImpl::Get + Version::Get：MemTable、imm，然后 L0 从新到旧，再往下每层最多一个文件。 */
  get(key: string): GetResult {
    const user = enc(key);
    const seq = this.lastSeq;
    const steps: GetStep[] = [];
    for (const [level, table] of [['mem', this.mem], ['imm', this.imm]] as const) {
      if (!table) continue;
      const entry = table.get(user, seq);
      if (entry) {
        steps.push({ where: level === 'mem' ? 'MemTable' : '只读 MemTable', level, result: entry.type === kTypeValue ? 'found' : 'deleted', entry });
        return { value: entry.type === kTypeValue ? entry.value : null, steps };
      }
      steps.push({ where: level === 'mem' ? 'MemTable' : '只读 MemTable', level, result: 'miss' });
    }
    for (let level = 0; level < NUM_LEVELS; level++) {
      // L0 的文件互相重叠，要从新到旧逐个看；更深的层不重叠，二分找到唯一可能的文件（FindFile）。
      const files = level === 0 ? [...this.levels[0]].sort((a, b) => b.number - a.number) : this.levels[level].filter((f) => compareBytes(userOf(f.largest), user) >= 0).slice(0, 1);
      for (const file of files) {
        const where = `L${level} #${file.number}`;
        const inRange = compareBytes(user, userOf(file.smallest)) >= 0 && compareBytes(user, userOf(file.largest)) <= 0;
        if (!inRange) {
          steps.push({ where, level, file, result: 'range' });
          continue;
        }
        const probe = file.table.get(user, seq);
        if (!probe.mayMatch) {
          steps.push({ where, level, file, result: 'filter', probe });
          continue;
        }
        if (!probe.entry) {
          steps.push({ where, level, file, result: 'absent', probe });
          continue;
        }
        const type = parseInternalKey(probe.entry.key).type;
        steps.push({ where, level, file, result: type === kTypeValue ? 'found' : 'deleted', probe });
        return { value: type === kTypeValue ? probe.entry.value : null, steps };
      }
    }
    return { value: null, steps };
  }

  needsCompaction(): boolean {
    return this.levels[0].length >= this.options.l0Trigger;
  }

  /** PickCompaction（L0）+ DoCompactionWork：选输入、多路归并、丢掉被覆盖的版本和用不着的墓碑。 */
  compact(): CompactionResult {
    const level = 0;
    // L0 的文件互相重叠：先取一个，再把和它重叠的 L0 文件都拉进来，直到范围不再扩大。
    let inputs0 = [this.levels[0][0]];
    for (;;) {
      const lo = inputs0.map((f) => userOf(f.smallest)).reduce((a, b) => (compareBytes(a, b) <= 0 ? a : b));
      const hi = inputs0.map((f) => userOf(f.largest)).reduce((a, b) => (compareBytes(a, b) >= 0 ? a : b));
      const next = this.overlaps(0, lo, hi);
      if (next.length === inputs0.length) break;
      inputs0 = next;
    }
    const lo = inputs0.map((f) => userOf(f.smallest)).reduce((a, b) => (compareBytes(a, b) <= 0 ? a : b));
    const hi = inputs0.map((f) => userOf(f.largest)).reduce((a, b) => (compareBytes(a, b) >= 0 ? a : b));
    const inputs1 = this.overlaps(level + 1, lo, hi);
    const all = [...inputs0, ...inputs1];
    const merged = all
      .flatMap((file) => file.table.entries().map((entry) => ({ ikey: entry.key, value: entry.value, from: file.number })))
      .sort((a, b) => compareInternal(a.ikey, b.ikey));
    // 没有快照时，最小快照就是最新的序列号。
    const smallestSnapshot = BigInt(this.lastSeq);
    const rows: MergeRow[] = [];
    let currentUser: Uint8Array | null = null;
    let lastSeqForKey = kMaxSequenceNumber;
    for (const item of merged) {
      const key = parseInternalKey(item.ikey);
      if (!currentUser || compareBytes(key.user, currentUser) !== 0) {
        currentUser = key.user;
        lastSeqForKey = kMaxSequenceNumber;
      }
      let drop: MergeRow['drop'] = null;
      if (lastSeqForKey <= smallestSnapshot) drop = 'shadowed';
      else if (key.type === kTypeDeletion && key.seq <= smallestSnapshot && this.isBaseLevelForKey(level + 2, key.user)) drop = 'tombstone';
      lastSeqForKey = key.seq;
      rows.push({ ...item, drop });
    }
    const kept = rows.filter((row) => !row.drop);
    const outputs = kept.length ? [this.makeFile(level + 1, this.nextFile++, kept)] : [];
    const deleted: Array<[number, number]> = all.map((f) => [f.level, f.number]);
    for (const [lv, number] of deleted) this.levels[lv] = this.levels[lv].filter((f) => f.number !== number);
    for (const file of outputs) this.addFile(file);
    return { level, inputs: [inputs0, inputs1], rows, outputs, deleted };
  }

  /** 更深的层里没有这个键，墓碑就可以丢掉。 */
  private isBaseLevelForKey(from: number, user: Uint8Array): boolean {
    for (let level = from; level < NUM_LEVELS; level++) if (this.overlaps(level, user, user).length) return false;
    return true;
  }
}
