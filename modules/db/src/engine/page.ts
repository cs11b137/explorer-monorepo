import { align, MAXALIGN, rd16, rd32, rd64, wr16, wr32, wr64 } from './bytes';

/** 依据 src/include/storage/bufpage.h 和 itemid.h（REL_17_STABLE）。 */
export const BLCKSZ = 8192;
export const SizeOfPageHeaderData = 24;
export const PG_PAGE_LAYOUT_VERSION = 4;
export const PD_HAS_FREE_LINES = 0x0001;
export const PD_PAGE_FULL = 0x0002;
export const PD_ALL_VISIBLE = 0x0004;
export const LP_UNUSED = 0;
export const LP_NORMAL = 1;
export const LP_REDIRECT = 2;
export const LP_DEAD = 3;
export const LP_NAMES = ['LP_UNUSED', 'LP_NORMAL', 'LP_REDIRECT', 'LP_DEAD'];

/** 依据 src/include/access/htup_details.h。 */
export const SizeofHeapTupleHeader = 23;
export const HEAP_HASNULL = 0x0001;
export const HEAP_HASVARWIDTH = 0x0002;
export const HEAP_XMAX_LOCK_ONLY = 0x0080;
export const HEAP_XMIN_COMMITTED = 0x0100;
export const HEAP_XMIN_INVALID = 0x0200;
export const HEAP_XMAX_COMMITTED = 0x0400;
export const HEAP_XMAX_INVALID = 0x0800;
export const HEAP_XMAX_IS_MULTI = 0x1000;
export const HEAP_UPDATED = 0x2000;
export const HEAP_NATTS_MASK = 0x07ff;
export const HEAP_KEYS_UPDATED = 0x2000;
export const HEAP_HOT_UPDATED = 0x4000;
export const HEAP_ONLY_TUPLE = 0x8000;

export interface ItemId {
  off: number;
  flags: number;
  len: number;
}

export const encodeItemId = ({ off, flags, len }: ItemId): number => (off | (flags << 15) | (len << 17)) >>> 0;
export const decodeItemId = (word: number): ItemId => ({ off: word & 0x7fff, flags: (word >>> 15) & 3, len: word >>> 17 });

export type Tid = [block: number, offset: number];

/** 一页真实字节。头部、行指针和元组都写在同一块缓冲区里。 */
export class Page {
  bytes: Uint8Array;

  constructor(readonly size = BLCKSZ, special = 0, bytes?: Uint8Array) {
    this.bytes = bytes ?? new Uint8Array(size);
    if (!bytes) {
      // PageInit
      this.lower = SizeOfPageHeaderData;
      this.upper = size - MAXALIGN(special);
      this.special = size - MAXALIGN(special);
      wr16(this.bytes, 18, (size & 0xff00) | PG_PAGE_LAYOUT_VERSION);
    }
  }

  clone(): Page {
    return new Page(this.size, 0, this.bytes.slice());
  }

  get lsn(): bigint {
    // PageXLogRecPtr 先存高 32 位，再存低 32 位。
    return (BigInt(rd32(this.bytes, 0)) << 32n) | BigInt(rd32(this.bytes, 4));
  }
  set lsn(v: bigint) {
    wr32(this.bytes, 0, Number(v >> 32n));
    wr32(this.bytes, 4, Number(v & 0xffffffffn));
  }
  get checksum(): number { return rd16(this.bytes, 8); }
  get flags(): number { return rd16(this.bytes, 10); }
  set flags(v: number) { wr16(this.bytes, 10, v); }
  get lower(): number { return rd16(this.bytes, 12); }
  set lower(v: number) { wr16(this.bytes, 12, v); }
  get upper(): number { return rd16(this.bytes, 14); }
  set upper(v: number) { wr16(this.bytes, 14, v); }
  get special(): number { return rd16(this.bytes, 16); }
  set special(v: number) { wr16(this.bytes, 16, v); }
  get pruneXid(): number { return rd32(this.bytes, 20); }
  set pruneXid(v: number) { wr32(this.bytes, 20, v); }

  /** PageGetMaxOffsetNumber */
  get maxOffset(): number {
    return this.lower <= SizeOfPageHeaderData ? 0 : (this.lower - SizeOfPageHeaderData) >> 2;
  }

  lpOffset(n: number): number {
    return SizeOfPageHeaderData + (n - 1) * 4;
  }

  lp(n: number): ItemId {
    return decodeItemId(rd32(this.bytes, this.lpOffset(n)));
  }

  setLp(n: number, id: ItemId): void {
    wr32(this.bytes, this.lpOffset(n), encodeItemId(id));
  }

  item(n: number): Uint8Array {
    const { off, len } = this.lp(n);
    return this.bytes.subarray(off, off + len);
  }

  /** PageGetExactFreeSpace */
  get exactFree(): number {
    return this.upper - this.lower;
  }

  /** PageGetFreeSpace：要给新元组的行指针留 4 字节。 */
  get free(): number {
    const space = this.exactFree;
    return space < 4 ? 0 : space - 4;
  }

  /**
   * PageAddItemExtended 的核心。offset 省略时，有 PD_HAS_FREE_LINES 就复用未用的行指针，
   * 否则追加。offset 落在已有行指针之间时，把后面的行指针整体后移（索引页用这种方式保持键序）。
   */
  addItem(data: ArrayLike<number>, offset?: number): number {
    const maxOff = this.maxOffset;
    let target = offset ?? 0;
    let needShuffle = false;
    if (!target) {
      target = maxOff + 1;
      if (this.flags & PD_HAS_FREE_LINES) {
        for (let n = 1; n <= maxOff; n++) {
          if (this.lp(n).flags === LP_UNUSED) {
            target = n;
            break;
          }
        }
        if (target > maxOff) this.flags = this.flags & ~PD_HAS_FREE_LINES;
      }
    } else if (target <= maxOff) {
      needShuffle = true;
    }
    const lower = target === maxOff + 1 || needShuffle ? this.lower + 4 : this.lower;
    const size = MAXALIGN(data.length);
    const upper = this.upper - size;
    if (lower > upper) throw new Error('页面放不下这个元组');
    if (needShuffle) this.bytes.copyWithin(this.lpOffset(target + 1), this.lpOffset(target), this.lpOffset(maxOff + 1));
    this.setLp(target, { off: upper, flags: LP_NORMAL, len: data.length });
    this.bytes.set(data as Uint8Array, upper);
    this.lower = lower;
    this.upper = upper;
    return target;
  }

  /**
   * PageRepairFragmentation：把在用的元组按原来的物理顺序紧贴页尾重排，
   * 只移动元组，行指针编号不变。
   */
  repairFragmentation(): void {
    const items: Array<{ n: number; off: number; len: number; data: Uint8Array }> = [];
    let unused = 0;
    for (let n = 1; n <= this.maxOffset; n++) {
      const id = this.lp(n);
      if (id.flags === LP_NORMAL) items.push({ n, off: id.off, len: id.len, data: this.bytes.slice(id.off, id.off + id.len) });
      else if (id.flags === LP_UNUSED) unused++;
    }
    items.sort((a, b) => b.off - a.off);
    let upper = this.special;
    // compactify_tuples 不清零腾出来的空洞，旧字节会留在空闲区里。
    for (const item of items) {
      upper -= MAXALIGN(item.len);
      this.bytes.set(item.data, upper);
      this.setLp(item.n, { off: upper, flags: LP_NORMAL, len: item.len });
    }
    this.upper = upper;
    this.flags = unused > 0 ? this.flags | PD_HAS_FREE_LINES : this.flags & ~PD_HAS_FREE_LINES;
  }
}

// ---------- 堆元组 ----------

export interface Attr {
  name: string;
  type: 'int4' | 'text';
}

export type Value = number | string;

/** 真实的 heap_fill_tuple：int4 按 4 字节对齐，短文本用 1 字节 varlena 头且不对齐。 */
export function fillTuple(schema: Attr[], values: Value[], startAt: number): number[] {
  const out: number[] = [];
  for (const [i, attr] of schema.entries()) {
    const value = values[i];
    if (attr.type === 'int4') {
      while ((startAt + out.length) % 4) out.push(0);
      const v = (value as number) >>> 0;
      out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    } else {
      const text = [...new TextEncoder().encode(value as string)];
      if (text.length + 1 > 127) throw new Error('本课只用短文本');
      out.push(((text.length + 1) << 1) | 1, ...text);
    }
  }
  return out;
}

/** 把数据区按 schema 解回来，和 fillTuple 是一对。 */
export function deformTuple(schema: Attr[], data: Uint8Array, startAt: number): Array<{ name: string; value: Value; from: number; to: number; pad: number }> {
  const out = [];
  let at = 0;
  for (const attr of schema) {
    if (attr.type === 'int4') {
      const aligned = align(startAt + at, 4) - startAt;
      const pad = aligned - at;
      at = aligned;
      out.push({ name: attr.name, value: rd32(data, at) | 0, from: at, to: at + 4, pad });
      at += 4;
    } else {
      const header = data[at];
      const len = (header >> 1) - 1;
      out.push({ name: attr.name, value: new TextDecoder().decode(data.subarray(at + 1, at + 1 + len)), from: at, to: at + 1 + len, pad: 0 });
      at += 1 + len;
    }
  }
  return out;
}

export interface TupleHeader {
  xmin: number;
  xmax: number;
  cid: number;
  ctid: Tid;
  infomask2: number;
  infomask: number;
  hoff: number;
}

export function readTupleHeader(t: Uint8Array): TupleHeader {
  return {
    xmin: rd32(t, 0),
    xmax: rd32(t, 4),
    cid: rd32(t, 8),
    ctid: [(rd16(t, 12) << 16 | rd16(t, 14)) >>> 0, rd16(t, 16)],
    infomask2: rd16(t, 18),
    infomask: rd16(t, 20),
    hoff: t[22],
  };
}

export function writeCtid(t: Uint8Array, at: number, [block, offset]: Tid): void {
  wr16(t, at, block >>> 16);
  wr16(t, at + 2, block & 0xffff);
  wr16(t, at + 4, offset);
}

export function formTuple(schema: Attr[], values: Value[], header: { xmin: number; xmax?: number; cid?: number; ctid: Tid; infomask: number; infomask2: number }): Uint8Array {
  const hoff = MAXALIGN(SizeofHeapTupleHeader);
  const body = fillTuple(schema, values, hoff);
  const out = new Uint8Array(hoff + body.length);
  wr32(out, 0, header.xmin);
  wr32(out, 4, header.xmax ?? 0);
  wr32(out, 8, header.cid ?? 0);
  writeCtid(out, 12, header.ctid);
  wr16(out, 18, header.infomask2);
  wr16(out, 20, header.infomask);
  out[22] = hoff;
  out.set(body, hoff);
  return out;
}

/** 堆表：一页堆页加上 heapam.c 里 INSERT / UPDATE / DELETE 对字节做的修改。 */
export class HeapPage {
  page: Page;

  constructor(readonly schema: Attr[], readonly block = 0, size = BLCKSZ) {
    this.page = new Page(size);
  }

  tuple(off: number): Uint8Array {
    return this.page.item(off);
  }

  header(off: number): TupleHeader {
    return readTupleHeader(this.tuple(off));
  }

  values(off: number): Value[] {
    const t = this.tuple(off);
    const h = readTupleHeader(t);
    return deformTuple(this.schema, t.subarray(h.hoff), h.hoff).map((attr) => attr.value);
  }

  private varFlag(): number {
    return this.schema.some((attr) => attr.type === 'text') ? HEAP_HASVARWIDTH : 0;
  }

  /** heap_insert：新元组 xmax 为 0，并带 HEAP_XMAX_INVALID。 */
  insert(values: Value[], xid: number, lsn?: bigint, cid = 0): number {
    const off = this.nextOffset();
    const t = formTuple(this.schema, values, { xmin: xid, cid, ctid: [this.block, off], infomask: this.varFlag() | HEAP_XMAX_INVALID, infomask2: this.schema.length });
    this.page.addItem(t);
    if (lsn !== undefined) this.page.lsn = lsn;
    return off;
  }

  /** 下一个 PageAddItem 会用到的行指针编号。 */
  nextOffset(): number {
    const p = this.page;
    if (p.flags & PD_HAS_FREE_LINES) {
      for (let n = 1; n <= p.maxOffset; n++) if (p.lp(n).flags === LP_UNUSED) return n;
    }
    return p.maxOffset + 1;
  }

  private markPrunable(xid: number): void {
    const prune = this.page.pruneXid;
    if (!prune || xid < prune) this.page.pruneXid = xid;
  }

  /** heap_update（HOT）：旧版本写 xmax 并指向新版本；新版本是 heap-only 元组。索引完全不动。 */
  hotUpdate(off: number, values: Value[], xid: number, lsn?: bigint, cid = 0): number {
    const newOff = this.nextOffset();
    const t = formTuple(this.schema, values, { xmin: xid, cid, ctid: [this.block, newOff], infomask: this.varFlag() | HEAP_XMAX_INVALID | HEAP_UPDATED, infomask2: this.schema.length | HEAP_ONLY_TUPLE });
    this.page.addItem(t);
    const old = this.tuple(off);
    wr32(old, 4, xid);
    wr32(old, 8, cid);
    writeCtid(old, 12, [this.block, newOff]);
    wr16(old, 18, rd16(old, 18) | HEAP_HOT_UPDATED);
    wr16(old, 20, rd16(old, 20) & ~(HEAP_XMAX_COMMITTED | HEAP_XMAX_INVALID | HEAP_XMAX_IS_MULTI | HEAP_XMAX_LOCK_ONLY));
    this.markPrunable(xid);
    if (lsn !== undefined) this.page.lsn = lsn;
    return newOff;
  }

  /** heap_delete：只写 xmax，元组留在原地。t_ctid 不变，仍指向自己。 */
  delete(off: number, xid: number, lsn?: bigint, cid = 0): void {
    const t = this.tuple(off);
    wr32(t, 4, xid);
    wr32(t, 8, cid);
    wr16(t, 18, rd16(t, 18) | HEAP_KEYS_UPDATED);
    wr16(t, 20, rd16(t, 20) & ~(HEAP_XMAX_COMMITTED | HEAP_XMAX_INVALID | HEAP_XMAX_IS_MULTI | HEAP_XMAX_LOCK_ONLY));
    this.markPrunable(xid);
    if (lsn !== undefined) this.page.lsn = lsn;
  }

  clone(): HeapPage {
    const copy = new HeapPage(this.schema, this.block, this.page.size);
    copy.page = this.page.clone();
    return copy;
  }

  /**
   * 第一阶段 heap_page_prune：死的 HOT 链头改成 LP_REDIRECT 指向仍存活的成员，
   * 没有存活成员的元组变成 LP_DEAD。dead 由调用方按可见性判定给出。
   */
  prune(dead: (off: number) => boolean): { redirects: Array<[number, number]>; deadItems: number[] } {
    const p = this.page;
    const redirects: Array<[number, number]> = [];
    const deadItems: number[] = [];
    const seen = new Set<number>();
    for (let off = 1; off <= p.maxOffset; off++) {
      if (p.lp(off).flags !== LP_NORMAL || seen.has(off)) continue;
      const h = this.header(off);
      if (h.infomask2 & HEAP_ONLY_TUPLE) continue;
      const chain = [off];
      let cursor = h;
      while (cursor.infomask2 & HEAP_HOT_UPDATED) {
        const next = cursor.ctid[1];
        chain.push(next);
        cursor = this.header(next);
      }
      chain.forEach((item) => seen.add(item));
      const firstLive = chain.find((item) => !dead(item));
      if (firstLive === chain[0]) continue;
      if (firstLive) {
        redirects.push([off, firstLive]);
        for (const item of chain) {
          if (item === off) p.setLp(off, { off: firstLive, flags: LP_REDIRECT, len: 0 });
          else if (item === firstLive) break;
          else p.setLp(item, { off: 0, flags: LP_UNUSED, len: 0 });
        }
      } else {
        for (const item of chain) {
          if (item === off) {
            deadItems.push(off);
            p.setLp(off, { off: 0, flags: LP_DEAD, len: 0 });
          } else p.setLp(item, { off: 0, flags: LP_UNUSED, len: 0 });
        }
      }
    }
    p.pruneXid = 0;
    p.repairFragmentation();
    return { redirects, deadItems };
  }

  /** 第二阶段 lazy_vacuum_heap_page：索引清完后，LP_DEAD 才能回收成 LP_UNUSED。 */
  reclaimDead(items: number[]): void {
    const p = this.page;
    for (const off of items) p.setLp(off, { off: 0, flags: LP_UNUSED, len: 0 });
    // PageTruncateLinePointerArray：去掉尾部未用的行指针。
    let max = p.maxOffset;
    while (max > 0 && p.lp(max).flags === LP_UNUSED) {
      wr32(p.bytes, p.lpOffset(max), 0);
      max--;
    }
    p.lower = SizeOfPageHeaderData + max * 4;
    let hasUnused = false;
    for (let n = 1; n <= max; n++) if (p.lp(n).flags === LP_UNUSED) hasUnused = true;
    p.flags = hasUnused ? p.flags | PD_HAS_FREE_LINES : p.flags & ~PD_HAS_FREE_LINES;
  }
}

export const readLsnRaw = (b: Uint8Array): bigint => rd64(b, 0);
export { wr64 };
