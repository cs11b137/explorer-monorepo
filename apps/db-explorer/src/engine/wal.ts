import { MAXALIGN, rd16, rd32, rd64, wr16, wr32, wr64 } from './bytes';
import { CRC_INIT, crcFinal, crcUpdate } from './crc32c';
import { formTuple, HEAP_HOT_UPDATED, HEAP_KEYS_UPDATED, HEAP_ONLY_TUPLE, HEAP_UPDATED, HEAP_XMAX_COMMITTED, HEAP_XMAX_INVALID, HEAP_XMAX_IS_MULTI, HEAP_XMAX_LOCK_ONLY, HEAP_XMIN_COMMITTED, Page, SizeofHeapTupleHeader, writeCtid, type Attr, type Value } from './page';

/** 依据 src/include/access/xlogrecord.h、rmgrlist.h、heapam_xlog.h、xact.h（REL_17_STABLE）。 */
export const SizeOfXLogRecord = 24;
export const XLR_BLOCK_ID_DATA_SHORT = 255;
export const BKPBLOCK_HAS_IMAGE = 0x10;
export const BKPBLOCK_HAS_DATA = 0x20;
export const BKPBLOCK_WILL_INIT = 0x40;
export const BKPBLOCK_SAME_REL = 0x80;
export const BKPIMAGE_HAS_HOLE = 0x01;
export const BKPIMAGE_APPLY = 0x02;
export const RM_XLOG_ID = 0;
export const RM_XACT_ID = 1;
export const RM_HEAP_ID = 10;
export const RM_BTREE_ID = 11;
export const RMGR_NAMES: Record<number, string> = { 0: 'XLOG', 1: 'Transaction', 9: 'Heap2', 10: 'Heap', 11: 'Btree' };
export const XLOG_HEAP_INSERT = 0x00;
export const XLOG_HEAP_DELETE = 0x10;
export const XLOG_HEAP_HOT_UPDATE = 0x40;
export const XLOG_HEAP_INIT_PAGE = 0x80;
export const XLOG_XACT_COMMIT = 0x00;
export const XLOG_CHECKPOINT_ONLINE = 0x10;
export const XLOG_BLCKSZ = 8192;
export const WAL_SEG_SIZE = 16 * 1024 * 1024;
export const SizeOfXLogShortPHD = 24;
export const SizeOfXLogLongPHD = 40;
export const XLOG_PAGE_MAGIC = 0xd116;

export type RelLocator = [spc: number, db: number, rel: number];

export interface BlockRef {
  rel: RelLocator;
  block: number;
  data?: ArrayLike<number>;
  /** 整页镜像。按 XLogRecordAssemble 的做法去掉 pd_lower 到 pd_upper 之间的空洞。 */
  image?: Page;
  willInit?: boolean;
}

export interface RecordInput {
  xid: number;
  prev: bigint;
  rmid: number;
  info: number;
  block?: BlockRef;
  main: ArrayLike<number>;
}

/** XLogRecordAssemble + XLogRecordCRC：真实的记录布局和校验和。 */
export function encodeRecord(input: RecordInput): Uint8Array {
  const parts: number[] = [];
  const { block } = input;
  let image: number[] = [];
  if (block) {
    const data = block.image ? [] : Array.from(block.data ?? []);
    let flags = 0;
    if (data.length) flags |= BKPBLOCK_HAS_DATA;
    if (block.willInit) flags |= BKPBLOCK_WILL_INIT;
    let imageHeader: number[] = [];
    if (block.image) {
      flags |= BKPBLOCK_HAS_IMAGE;
      const page = block.image;
      const holeOffset = page.lower;
      const hole = page.upper - page.lower;
      image = [...page.bytes.subarray(0, holeOffset), ...page.bytes.subarray(page.upper)];
      const buf = new Uint8Array(5);
      wr16(buf, 0, image.length);
      wr16(buf, 2, holeOffset);
      buf[4] = (hole ? BKPIMAGE_HAS_HOLE : 0) | BKPIMAGE_APPLY;
      imageHeader = [...buf];
    }
    const head = new Uint8Array(4);
    head[0] = 0;
    head[1] = flags;
    wr16(head, 2, data.length);
    parts.push(...head, ...imageHeader);
    const rel = new Uint8Array(16);
    wr32(rel, 0, block.rel[0]);
    wr32(rel, 4, block.rel[1]);
    wr32(rel, 8, block.rel[2]);
    wr32(rel, 12, block.block);
    parts.push(...rel);
    if (input.main.length) parts.push(XLR_BLOCK_ID_DATA_SHORT, input.main.length);
    parts.push(...image, ...data);
  } else if (input.main.length) {
    parts.push(XLR_BLOCK_ID_DATA_SHORT, input.main.length);
  }
  parts.push(...Array.from(input.main));
  const total = SizeOfXLogRecord + parts.length;
  const out = new Uint8Array(total);
  wr32(out, 0, total);
  wr32(out, 4, input.xid);
  wr64(out, 8, input.prev);
  out[16] = input.info;
  out[17] = input.rmid;
  out.set(parts, SizeOfXLogRecord);
  return sealRecord(out);
}

/** 先算记录体，再算头部 xl_crc 之前的部分。 */
export function recordCrc(rec: Uint8Array): number {
  let crc = crcUpdate(CRC_INIT, rec, SizeOfXLogRecord, rec.length);
  crc = crcUpdate(crc, rec, 0, 20);
  return crcFinal(crc);
}

function sealRecord(rec: Uint8Array): Uint8Array {
  wr32(rec, 20, recordCrc(rec));
  return rec;
}

export interface ParsedRecord {
  totLen: number;
  xid: number;
  prev: bigint;
  info: number;
  rmid: number;
  crc: number;
  crcOk: boolean;
  block?: { id: number; flags: number; dataLength: number; rel: RelLocator; number: number; image?: { length: number; holeOffset: number; info: number; bytes: Uint8Array; headerAt: number }; data: Uint8Array; headerAt: number; dataAt: number; relAt: number };
  mainLength: number;
  main: Uint8Array;
  mainAt: number;
  mainHeaderAt: number;
}

/** DecodeXLogRecord 的单块版本：从字节解析，不依赖编码时的任何状态。 */
export function parseRecord(rec: Uint8Array): ParsedRecord {
  const totLen = rd32(rec, 0);
  let at = SizeOfXLogRecord;
  let block: ParsedRecord['block'];
  let mainLength = 0;
  let mainHeaderAt = -1;
  if (at < totLen && rec[at] <= 32) {
    const headerAt = at;
    const flags = rec[at + 1];
    const dataLength = rd16(rec, at + 2);
    at += 4;
    let image: NonNullable<ParsedRecord['block']>['image'];
    if (flags & BKPBLOCK_HAS_IMAGE) {
      image = { length: rd16(rec, at), holeOffset: rd16(rec, at + 2), info: rec[at + 4], bytes: new Uint8Array(), headerAt: at };
      at += 5;
    }
    const relAt = at;
    const rel: RelLocator = [rd32(rec, at), rd32(rec, at + 4), rd32(rec, at + 8)];
    at += 12;
    const number = rd32(rec, at);
    at += 4;
    block = { id: rec[headerAt], flags, dataLength, rel, number, image, data: new Uint8Array(), headerAt, dataAt: 0, relAt };
  }
  if (at < totLen && rec[at] === XLR_BLOCK_ID_DATA_SHORT) {
    mainHeaderAt = at;
    mainLength = rec[at + 1];
    at += 2;
  }
  if (block) {
    if (block.image) {
      block.image.bytes = rec.subarray(at, at + block.image.length);
      at += block.image.length;
    }
    block.dataAt = at;
    block.data = rec.subarray(at, at + block.dataLength);
    at += block.dataLength;
  }
  const mainAt = at;
  const crc = rd32(rec, 20);
  return { totLen, xid: rd32(rec, 4), prev: rd64(rec, 8), info: rec[16], rmid: rec[17], crc, crcOk: recordCrc(rec) === crc, block, mainLength, main: rec.subarray(at, at + mainLength), mainAt, mainHeaderAt };
}

/** xl_heap_header：heap_insert 把元组头里这三个字段放进块数据。 */
const heapHeader = (infomask2: number, infomask: number, hoff: number): number[] => {
  const b = new Uint8Array(5);
  wr16(b, 0, infomask2);
  wr16(b, 2, infomask);
  b[4] = hoff;
  return [...b];
};

/** heap_insert 的 WAL：xl_heap_insert + xl_heap_header + 元组数据（从第 23 字节开始，含对齐填充）。 */
export function heapInsertRecord(prev: bigint, xid: number, rel: RelLocator, block: number, page: Page, off: number, image = false): Uint8Array {
  const t = page.item(off);
  const main = new Uint8Array(3);
  wr16(main, 0, off);
  const data = [...heapHeader(rd16(t, 18), rd16(t, 20), t[22]), ...t.subarray(SizeofHeapTupleHeader)];
  return encodeRecord({ xid, prev, rmid: RM_HEAP_ID, info: XLOG_HEAP_INSERT, block: { rel, block, data, image: image ? page : undefined }, main });
}

/** 事务提交记录：最简单的情况下只有一个 8 字节的提交时间。 */
export function commitRecord(prev: bigint, xid: number, xactTime: bigint): Uint8Array {
  const main = new Uint8Array(8);
  wr64(main, 0, xactTime);
  return encodeRecord({ xid, prev, rmid: RM_XACT_ID, info: XLOG_XACT_COMMIT, main });
}

/** heap_delete 的 WAL：xl_heap_delete，没有块数据。 */
export function heapDeleteRecord(prev: bigint, xid: number, rel: RelLocator, block: number, off: number): Uint8Array {
  const main = new Uint8Array(8);
  wr32(main, 0, xid);
  wr16(main, 4, off);
  main[6] = 0x10; // XLHL_KEYS_UPDATED：pg_walinspect 显示 infobits: [KEYS_UPDATED]
  return encodeRecord({ xid, prev, rmid: RM_HEAP_ID, info: XLOG_HEAP_DELETE, block: { rel, block }, main });
}

const XLH_UPDATE_PREFIX_FROM_OLD = 0x20;
const XLH_UPDATE_SUFFIX_FROM_OLD = 0x40;

/** log_heap_update 的 HOT 分支：新旧元组同页时，前后相同的字节不重复记录。 */
export function heapHotUpdateRecord(prev: bigint, xid: number, rel: RelLocator, block: number, page: Page, oldOff: number, newOff: number): Uint8Array {
  const oldT = page.item(oldOff);
  const newT = page.item(newOff);
  const oldData = oldT.subarray(oldT[22]);
  const newData = newT.subarray(newT[22]);
  let prefix = 0;
  while (prefix < Math.min(oldData.length, newData.length) && oldData[prefix] === newData[prefix]) prefix++;
  if (prefix < 3) prefix = 0;
  let suffix = 0;
  while (suffix < Math.min(oldData.length, newData.length) - prefix && oldData[oldData.length - 1 - suffix] === newData[newData.length - 1 - suffix]) suffix++;
  if (suffix < 3) suffix = 0;
  let flags = 0;
  const data: number[] = [];
  if (prefix || suffix) {
    if (prefix) {
      flags |= XLH_UPDATE_PREFIX_FROM_OLD;
      data.push(prefix & 0xff, prefix >> 8);
    }
    if (suffix) {
      flags |= XLH_UPDATE_SUFFIX_FROM_OLD;
      data.push(suffix & 0xff, suffix >> 8);
    }
  }
  data.push(...heapHeader(rd16(newT, 18), rd16(newT, 20), newT[22]));
  // 新元组：先是头部之后的填充/位图，再是没有被前后缀覆盖的中段。
  data.push(...newT.subarray(SizeofHeapTupleHeader, newT[22]));
  data.push(...newData.subarray(prefix, newData.length - suffix));
  const main = new Uint8Array(14);
  wr32(main, 0, xid);
  wr16(main, 4, oldOff);
  main[6] = 0;
  main[7] = flags;
  wr32(main, 8, 0);
  wr16(main, 12, newOff);
  return encodeRecord({ xid, prev, rmid: RM_HEAP_ID, info: XLOG_HEAP_HOT_UPDATE, block: { rel, block, data }, main });
}

const usableOn = (pos: bigint): number => {
  const inPage = Number(pos % BigInt(XLOG_BLCKSZ));
  return XLOG_BLCKSZ - inPage;
};

/** 记录体跨页时要跳过下一页的页头，XLogBytePosToRecPtr 做的就是这个换算。 */
export function advanceLsn(start: bigint, length: number): bigint {
  let pos = start;
  let left = length;
  while (left > 0) {
    const room = usableOn(pos);
    if (left < room) {
      pos += BigInt(left);
      left = 0;
    } else {
      left -= room;
      pos += BigInt(room);
      pos += BigInt(pos % BigInt(WAL_SEG_SIZE) === 0n ? SizeOfXLogLongPHD : SizeOfXLogShortPHD);
    }
  }
  return pos;
}

/** 下一条记录的起点：MAXALIGN 对齐，落到页首就跳过页头。 */
export function endOfRecord(start: bigint, totLen: number): bigint {
  const end = advanceLsn(start, MAXALIGN(totLen));
  return end;
}

export interface WalEntry {
  lsn: bigint;
  end: bigint;
  prev: bigint;
  bytes: Uint8Array;
  parsed: ParsedRecord;
  label: string;
}

/** WAL 的内存视图：每条记录的真实字节 + 三个指针。 */
export class Wal {
  entries: WalEntry[] = [];
  insert: bigint;
  /** 上一条记录的起点，新记录的 xl_prev。 */
  prev: bigint;
  /** 已经 fsync 到磁盘的位置（XLogFlush 推进它）。 */
  flush: bigint;

  constructor(start: bigint, prev = 0n) {
    this.insert = start;
    this.prev = prev;
    this.flush = start;
  }

  append(bytes: Uint8Array, label: string): WalEntry {
    const lsn = this.insert;
    const entry: WalEntry = { lsn, end: endOfRecord(lsn, bytes.length), prev: this.prev, bytes, parsed: parseRecord(bytes), label };
    this.entries.push(entry);
    this.prev = lsn;
    this.insert = entry.end;
    return entry;
  }

  /** XLogFlush(upto)：写入并 fsync，返回这次刷盘的字节数。 */
  flushTo(upto: bigint): number {
    const delta = upto > this.flush ? Number(upto - this.flush) : 0;
    if (upto > this.flush) this.flush = upto;
    return delta;
  }

  clone(): Wal {
    const copy = new Wal(this.insert, this.prev);
    copy.flush = this.flush;
    copy.entries = this.entries.map((entry) => ({ ...entry, bytes: entry.bytes.slice(), parsed: parseRecord(entry.bytes) }));
    return copy;
  }
}

export type RedoAction = 'BLK_NEEDS_REDO' | 'BLK_DONE' | 'BLK_RESTORED' | 'NO_BLOCK';

export interface RedoStep {
  entry: WalEntry;
  action: RedoAction;
  pageLsnBefore: bigint | null;
  pageLsnAfter: bigint | null;
}

/** RestoreBlockImage：把去掉空洞的整页镜像还原成 8 KiB。 */
export function restoreImage(image: { holeOffset: number; info: number; bytes: Uint8Array }, size = 8192): Page {
  const out = new Uint8Array(size);
  const head = image.info & BKPIMAGE_HAS_HOLE ? image.holeOffset : image.bytes.length;
  out.set(image.bytes.subarray(0, head), 0);
  out.set(image.bytes.subarray(head), size - (image.bytes.length - head));
  return new Page(size, 0, out);
}

/**
 * XLogReadBufferForRedo + heap_xlog_insert：记录有整页镜像就直接恢复（BLK_RESTORED）；
 * 页 LSN ≥ 记录的 EndRecPtr 就跳过（BLK_DONE）；否则重放并把 pd_lsn 设成 EndRecPtr。
 * 只从记录的字节取数据，模拟不依赖崩溃前的内存状态。
 */
export function redoOne(entry: WalEntry, page: Page, schemaLen: number): { page: Page; action: RedoAction } {
  const { parsed, end } = entry;
  const { block } = parsed;
  if (!block) return { page, action: 'NO_BLOCK' };
  if (block.image && block.image.info & BKPIMAGE_APPLY) {
    const restored = restoreImage(block.image, page.size);
    restored.lsn = end;
    return { page: restored, action: 'BLK_RESTORED' };
  }
  if (end <= page.lsn) return { page, action: 'BLK_DONE' };
  const op = parsed.info & 0x70;
  if (parsed.rmid === RM_HEAP_ID && op === XLOG_HEAP_INSERT) {
    const off = rd16(parsed.main, 0);
    const d = block.data;
    const hoff = d[4];
    const t = new Uint8Array(SizeofHeapTupleHeader + d.length - 5);
    t.set(d.subarray(5), SizeofHeapTupleHeader);
    wr32(t, 0, parsed.xid);
    writeCtid(t, 12, [block.number, off]);
    wr16(t, 18, rd16(d, 0));
    wr16(t, 20, rd16(d, 2));
    t[22] = hoff;
    page.addItem(t, off);
  } else if (parsed.rmid === RM_HEAP_ID && op === XLOG_HEAP_DELETE) {
    const off = rd16(parsed.main, 4);
    const t = page.item(off);
    wr32(t, 4, rd32(parsed.main, 0));
    wr16(t, 18, rd16(t, 18) | HEAP_KEYS_UPDATED);
    wr16(t, 20, rd16(t, 20) & ~(HEAP_XMAX_COMMITTED | HEAP_XMAX_INVALID | HEAP_XMAX_IS_MULTI | HEAP_XMAX_LOCK_ONLY));
    if (!page.pruneXid || parsed.xid < page.pruneXid) page.pruneXid = parsed.xid;
  } else if (parsed.rmid === RM_HEAP_ID && op === XLOG_HEAP_HOT_UPDATE) {
    redoHotUpdate(parsed, page, block.number);
  } else {
    throw new Error(`本课没有实现 rmid=${parsed.rmid} info=${parsed.info} 的重放`);
  }
  page.lsn = end;
  void schemaLen;
  return { page, action: 'BLK_NEEDS_REDO' };
}

function redoHotUpdate(parsed: ParsedRecord, page: Page, blockNo: number): void {
  const main = parsed.main;
  const oldOff = rd16(main, 4);
  const flags = main[7];
  const newOff = rd16(main, 12);
  const d = parsed.block!.data;
  let at = 0;
  let prefix = 0;
  let suffix = 0;
  if (flags & XLH_UPDATE_PREFIX_FROM_OLD) {
    prefix = rd16(d, at);
    at += 2;
  }
  if (flags & XLH_UPDATE_SUFFIX_FROM_OLD) {
    suffix = rd16(d, at);
    at += 2;
  }
  const infomask2 = rd16(d, at);
  const infomask = rd16(d, at + 2);
  const hoff = d[at + 4];
  at += 5;
  const old = page.item(oldOff);
  const oldData = old.subarray(old[22]);
  const pad = d.subarray(at, at + hoff - SizeofHeapTupleHeader);
  at += hoff - SizeofHeapTupleHeader;
  const middle = d.subarray(at);
  const body = [...oldData.subarray(0, prefix), ...middle, ...oldData.subarray(oldData.length - suffix)];
  const t = new Uint8Array(hoff + body.length);
  wr32(t, 0, parsed.xid);
  writeCtid(t, 12, [blockNo, newOff]);
  wr16(t, 18, infomask2);
  wr16(t, 20, infomask);
  t[22] = hoff;
  t.set(pad, SizeofHeapTupleHeader);
  t.set(body, hoff);
  page.addItem(t, newOff);
  const oldT = page.item(oldOff);
  wr32(oldT, 4, parsed.xid);
  writeCtid(oldT, 12, [blockNo, newOff]);
  wr16(oldT, 18, rd16(oldT, 18) | HEAP_HOT_UPDATED);
  wr16(oldT, 20, rd16(oldT, 20) & ~(HEAP_XMAX_COMMITTED | HEAP_XMAX_INVALID | HEAP_XMAX_IS_MULTI | HEAP_XMAX_LOCK_ONLY));
  if (!page.pruneXid || parsed.xid < page.pruneXid) page.pruneXid = parsed.xid;
}

/** XLogReadRecord 判断 WAL 结束的两条依据：xl_prev 链接和 CRC。 */
export function validateRecord(entry: WalEntry, expectedPrev: bigint): { ok: boolean; reason: string } {
  const p = parseRecord(entry.bytes);
  if (p.totLen < SizeOfXLogRecord) return { ok: false, reason: `xl_tot_len ${p.totLen} 太小` };
  if (p.prev !== expectedPrev) return { ok: false, reason: 'xl_prev 对不上上一条记录' };
  if (!p.crcOk) return { ok: false, reason: 'xl_crc 校验失败' };
  return { ok: true, reason: '头部有效，CRC-32C 一致' };
}

export { formTuple, HEAP_ONLY_TUPLE, HEAP_UPDATED, HEAP_XMIN_COMMITTED };
export type { Attr, Value };
