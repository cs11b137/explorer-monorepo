import { MAXALIGN, rd16, rd32, wr16, wr32, wr64 } from './bytes';
import { BLCKSZ, Page, type Tid } from './page';

/** 依据 src/include/access/nbtree.h 和 itup.h（REL_17_STABLE）。 */
export const BTP_LEAF = 1 << 0;
export const BTP_ROOT = 1 << 1;
export const BTP_META = 1 << 3;
export const BTREE_MAGIC = 0x053162;
export const BTREE_VERSION = 4;
export const BTREE_DEFAULT_FILLFACTOR = 90;
export const BTREE_NONLEAF_FILLFACTOR = 70;
export const P_NONE = 0;
export const P_HIKEY = 1;
export const SizeOfBTPageOpaque = 16;
export const INDEX_SIZE_MASK = 0x1fff;
export const INDEX_ALT_TID_MASK = 0x2000;
export const LEAF_SPLIT_DISTANCE = 0.05;
export const INTERNAL_SPLIT_DISTANCE = 0.075;

export interface IndexTuple {
  block: number;
  posid: number;
  info: number;
  /** undefined 表示负无穷：内部页的第一个下行链接不存键。 */
  key?: number;
}

export function encodeIndexTuple(t: IndexTuple): Uint8Array {
  const size = t.info & INDEX_SIZE_MASK;
  const out = new Uint8Array(size);
  wr16(out, 0, t.block >>> 16);
  wr16(out, 2, t.block & 0xffff);
  wr16(out, 4, t.posid);
  wr16(out, 6, t.info);
  if (t.key !== undefined) wr32(out, 8, t.key >>> 0);
  return out;
}

export function decodeIndexTuple(b: Uint8Array): IndexTuple {
  const info = rd16(b, 6);
  const size = info & INDEX_SIZE_MASK;
  return {
    block: ((rd16(b, 0) << 16) | rd16(b, 2)) >>> 0,
    posid: rd16(b, 4),
    info,
    key: size > 8 ? rd32(b, 8) | 0 : undefined,
  };
}

export interface BtOpaque {
  prev: number;
  next: number;
  level: number;
  flags: number;
  cycle: number;
}

export function readOpaque(page: Page): BtOpaque {
  const o = page.special;
  const b = page.bytes;
  return { prev: rd32(b, o), next: rd32(b, o + 4), level: rd32(b, o + 8), flags: rd16(b, o + 12), cycle: rd16(b, o + 14) };
}

function writeOpaque(page: Page, v: Partial<BtOpaque>): void {
  const o = page.special;
  const b = page.bytes;
  if (v.prev !== undefined) wr32(b, o, v.prev);
  if (v.next !== undefined) wr32(b, o + 4, v.next);
  if (v.level !== undefined) wr32(b, o + 8, v.level);
  if (v.flags !== undefined) wr16(b, o + 12, v.flags);
}

/**
 * src/port/qsort 的模板（pg_qsort）的直译。_bt_deltasortsplits 用它按 delta 排序候选分裂点，
 * 它不是稳定排序，delta 相同时谁排前面决定最终的分裂点，所以必须和 C 版本走同样的路径。
 */
function pgQsort<T>(a: T[], cmp: (x: T, y: T) => number, lo = 0, n = a.length): void {
  const swap = (i: number, j: number) => {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  };
  const vecswap = (i: number, j: number, count: number) => {
    for (let k = 0; k < count; k++) swap(i + k, j + k);
  };
  const med3 = (x: number, y: number, z: number) =>
    cmp(a[x], a[y]) < 0 ? (cmp(a[y], a[z]) < 0 ? y : cmp(a[x], a[z]) < 0 ? z : x) : cmp(a[y], a[z]) > 0 ? y : cmp(a[x], a[z]) < 0 ? x : z;
  for (;;) {
    if (n < 7) {
      for (let pm = lo + 1; pm < lo + n; pm++) for (let pl = pm; pl > lo && cmp(a[pl - 1], a[pl]) > 0; pl--) swap(pl, pl - 1);
      return;
    }
    let presorted = true;
    for (let pm = lo + 1; pm < lo + n; pm++) {
      if (cmp(a[pm - 1], a[pm]) > 0) {
        presorted = false;
        break;
      }
    }
    if (presorted) return;
    let pm = lo + (n >> 1);
    if (n > 7) {
      let pl = lo;
      let pn = lo + n - 1;
      if (n > 40) {
        const d = n >> 3;
        pl = med3(pl, pl + d, pl + 2 * d);
        pm = med3(pm - d, pm, pm + d);
        pn = med3(pn - 2 * d, pn - d, pn);
      }
      pm = med3(pl, pm, pn);
    }
    swap(lo, pm);
    let pa = lo + 1;
    let pb = pa;
    let pc = lo + n - 1;
    let pd = pc;
    for (;;) {
      let r: number;
      while (pb <= pc && (r = cmp(a[pb], a[lo])) <= 0) {
        if (r === 0) {
          swap(pa, pb);
          pa++;
        }
        pb++;
      }
      while (pb <= pc && (r = cmp(a[pc], a[lo])) >= 0) {
        if (r === 0) {
          swap(pc, pd);
          pd--;
        }
        pc--;
      }
      if (pb > pc) break;
      swap(pb, pc);
      pb++;
      pc--;
    }
    const pnEnd = lo + n;
    const d1 = Math.min(pa - lo, pb - pa);
    vecswap(lo, pb - d1, d1);
    const d2 = Math.min(pd - pc, pnEnd - pd - 1);
    vecswap(pb, pnEnd - d2, d2);
    const left = pb - pa;
    const right = pd - pc;
    if (left <= right) {
      if (left > 1) pgQsort(a, cmp, lo, left);
      if (right > 1) {
        lo = pnEnd - right;
        n = right;
        continue;
      }
      return;
    }
    if (right > 1) pgQsort(a, cmp, pnEnd - right, right);
    if (left > 1) {
      n = left;
      continue;
    }
    return;
  }
}

interface SplitPoint {
  curdelta: number;
  leftfree: number;
  rightfree: number;
  firstrightoff: number;
  newitemonleft: boolean;
}

export interface SplitLog {
  block: number;
  rightBlock: number;
  level: number;
  /** 分裂前（含新键）的全部键。 */
  before: number[];
  leftKeys: number[];
  rightKeys: number[];
  highKey: number | undefined;
  firstRightOff: number;
  newItemOnLeft: boolean;
  fillFactor: number | null;
  leftFree: number;
  rightFree: number;
}

export interface InsertLog {
  key: number;
  path: Array<{ block: number; keys: Array<number | undefined>; chosen: number; next: number }>;
  leaf: number;
  offset: number;
  splits: SplitLog[];
  newRoot: number | null;
}

/**
 * 真实的 nbtree：页、行指针、high key、右链、元页都是真实字节。
 * pageSize 只影响每页能放多少键。pageSize = 8192 时，tests/decode.test.ts 把产出的每一页
 * 和 PostgreSQL 17 建出的索引页逐字节比对；课程用很小的页，这样一屏就能看到分裂。
 */
export class BTree {
  pages: Page[] = [];
  root = 0;
  level = 0;

  /** startLsn 给出时，每次修改都推进页的 pd_lsn（真实系统里它来自 WAL）。 */
  constructor(readonly pageSize = BLCKSZ, private lsnCursor?: bigint) {
    const meta = new Page(pageSize, SizeOfBTPageOpaque);
    writeOpaque(meta, { flags: BTP_META, prev: 0, next: 0, level: 0 });
    this.pages.push(meta);
    this.writeMeta();
  }

  /** _bt_initmetapage / BTMetaPageData。 */
  private writeMeta(): void {
    const meta = this.pages[0];
    const b = meta.bytes;
    const at = 24;
    wr32(b, at, BTREE_MAGIC);
    wr32(b, at + 4, BTREE_VERSION);
    wr32(b, at + 8, this.root);
    wr32(b, at + 12, this.level);
    wr32(b, at + 16, this.root);
    wr32(b, at + 20, this.level);
    wr32(b, at + 24, 0);
    // btm_last_cleanup_num_heap_tuples：float8 的 -1。
    wr64(b, at + 32, 0xbff0000000000000n);
    b[at + 40] = 1;
    // pd_lower 指向 sizeof(BTMetaPageData) = 48 之后。
    meta.lower = at + 48;
  }

  private alloc(flags: number, level: number): number {
    const page = new Page(this.pageSize, SizeOfBTPageOpaque);
    writeOpaque(page, { flags, level, prev: 0, next: 0 });
    this.pages.push(page);
    return this.pages.length - 1;
  }

  opaque(block: number): BtOpaque {
    return readOpaque(this.pages[block]);
  }

  isRightmost(block: number): boolean {
    return this.opaque(block).next === P_NONE;
  }

  firstData(block: number): number {
    return this.isRightmost(block) ? 1 : 2;
  }

  tuple(block: number, off: number): IndexTuple {
    return decodeIndexTuple(this.pages[block].item(off));
  }

  /** 键的三向比较。内部页第一项是负无穷。 */
  private itemKey(block: number, off: number): number | undefined {
    return this.tuple(block, off).key;
  }

  /** _bt_search 一层：在内部页二分，找到最后一个键 ≤ 查找键的下行链接。 */
  private binsrchInternal(block: number, key: number): number {
    const page = this.pages[block];
    let low = this.firstData(block);
    let high = page.maxOffset;
    // 不变式：low 之前的键都 ≤ key。第一个数据项（负无穷）总是符合。
    low += 1;
    high += 1;
    while (high > low) {
      const mid = low + ((high - low) >> 1);
      const midKey = this.itemKey(block, mid)!;
      if (key >= midKey) low = mid + 1;
      else high = mid;
    }
    return low - 1;
  }

  /** _bt_binsrch_insert：叶子页里第一个键 > 查找键的位置。 */
  private binsrchLeaf(block: number, key: number): number {
    const page = this.pages[block];
    let low = this.firstData(block);
    let high = page.maxOffset + 1;
    while (high > low) {
      const mid = low + ((high - low) >> 1);
      if (key >= this.itemKey(block, mid)!) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** _bt_search：从根下降到叶子，记录路径。 */
  search(key: number): { path: InsertLog['path']; leaf: number } {
    const path: InsertLog['path'] = [];
    if (!this.root) return { path, leaf: 0 };
    let block = this.root;
    while (!(this.opaque(block).flags & BTP_LEAF)) {
      const off = this.binsrchInternal(block, key);
      const next = this.tuple(block, off).block;
      path.push({ block, keys: this.keysOf(block), chosen: off, next });
      block = next;
    }
    return { path, leaf: block };
  }

  /** 第一个 ≥ key 的叶子项（_bt_first + _bt_binsrch 的结果）。 */
  firstAtLeast(key: number): { leaf: number; off: number } {
    const { leaf } = this.search(key);
    const page = this.pages[leaf];
    let low = this.firstData(leaf);
    let high = page.maxOffset + 1;
    while (high > low) {
      const mid = low + ((high - low) >> 1);
      if (key > this.itemKey(leaf, mid)!) low = mid + 1;
      else high = mid;
    }
    return { leaf, off: low };
  }

  /** 页内所有键，包括 high key（如果有）。负无穷记成 undefined。 */
  keysOf(block: number): Array<number | undefined> {
    const page = this.pages[block];
    const out: Array<number | undefined> = [];
    for (let off = this.firstData(block); off <= page.maxOffset; off++) out.push(this.itemKey(block, off));
    return out;
  }

  highKey(block: number): number | undefined {
    return this.isRightmost(block) ? undefined : this.itemKey(block, P_HIKEY);
  }

  insert(key: number, tid: Tid): InsertLog {
    const log: InsertLog = { key, path: [], leaf: 0, offset: 0, splits: [], newRoot: null };
    if (!this.root) {
      // _bt_getroot 第一次建根：根同时也是叶子。
      this.root = this.alloc(BTP_LEAF | BTP_ROOT, 0);
      this.level = 0;
      this.writeMeta();
    }
    const { path, leaf } = this.search(key);
    log.path = path;
    log.leaf = leaf;
    const item = encodeIndexTuple({ block: tid[0], posid: tid[1], info: 16, key });
    log.offset = this.binsrchLeaf(leaf, key);
    this.insertOnPage(leaf, item, log.offset, path.map((p) => p.block), log);
    if (this.lsnCursor !== undefined) {
      this.lsnCursor += 0x48n;
      const touched = new Set([leaf, ...log.splits.flatMap((split) => [split.block, split.rightBlock]), ...(log.newRoot ? [log.newRoot, 0] : []), ...(log.splits.length ? path.map((p) => p.block) : [])]);
      for (const block of touched) this.pages[block].lsn = this.lsnCursor;
    }
    return log;
  }

  /** _bt_insertonpg */
  private insertOnPage(block: number, item: Uint8Array, off: number, stack: number[], log: InsertLog): void {
    const page = this.pages[block];
    if (page.free >= MAXALIGN(item.length)) {
      page.addItem(item, off);
      return;
    }
    const firstRight = this.findSplitLoc(block, off, item);
    const { rightBlock, highKeyBytes } = this.split(block, firstRight.firstrightoff, firstRight.newitemonleft, off, item, log, firstRight);
    this.insertParent(block, rightBlock, highKeyBytes, stack, log);
  }

  /** _bt_findsplitloc（单键列、无重复键时的完整路径）。 */
  private findSplitLoc(block: number, newoff: number, newitem: Uint8Array): SplitPoint & { fill: number | null } {
    const page = this.pages[block];
    const opaque = this.opaque(block);
    const isLeaf = Boolean(opaque.flags & BTP_LEAF);
    const isRightmost = opaque.next === P_NONE;
    const maxoff = page.maxOffset;
    const leftspace = page.size - 24 - SizeOfBTPageOpaque;
    let rightspace = leftspace;
    if (!isRightmost) rightspace -= MAXALIGN(page.lp(P_HIKEY).len) + 4;
    const olddataitemstotal = rightspace - page.exactFree;
    const newitemsz = MAXALIGN(newitem.length) + 4;
    const splits: SplitPoint[] = [];
    let minfirstrightsz = Number.MAX_SAFE_INTEGER;

    const record = (firstrightoff: number, newitemonleft: boolean, toleft: number, origsz: number) => {
      const newIsFirstRight = firstrightoff === newoff && !newitemonleft;
      const firstrightsz = newIsFirstRight ? newitemsz : origsz;
      let leftfree = leftspace - toleft;
      let rightfree = rightspace - (olddataitemstotal - toleft);
      // 叶子页的新 high key 可能要追加堆 TID，所以预留 MAXALIGN(sizeof(ItemPointerData))。
      leftfree -= isLeaf ? firstrightsz + 8 : firstrightsz;
      if (newitemonleft) leftfree -= newitemsz;
      else rightfree -= newitemsz;
      if (!isLeaf) rightfree += firstrightsz - (8 + 4);
      if (leftfree >= 0 && rightfree >= 0) {
        minfirstrightsz = Math.min(minfirstrightsz, firstrightsz);
        splits.push({ curdelta: 0, leftfree, rightfree, firstrightoff, newitemonleft });
      }
    };

    let toleft = 0;
    for (let off = this.firstData(block); off <= maxoff; off++) {
      const itemsz = MAXALIGN(page.lp(off).len) + 4;
      if (off < newoff) record(off, false, toleft, itemsz);
      else if (off > newoff) record(off, true, toleft, itemsz);
      else {
        record(off, false, toleft, itemsz);
        record(off, true, toleft, itemsz);
      }
      toleft += itemsz;
    }
    if (newoff > maxoff) record(newoff, false, olddataitemstotal, 0);
    if (!splits.length) throw new Error('找不到可行的分裂点');

    let usemult: boolean;
    let fillfactormult: number;
    if (!isLeaf) {
      usemult = isRightmost;
      fillfactormult = BTREE_NONLEAF_FILLFACTOR / 100;
    } else if (isRightmost) {
      usemult = true;
      fillfactormult = BTREE_DEFAULT_FILLFACTOR / 100;
    } else {
      // _bt_afternewitemoff 在 nkeyatts == 1 时直接返回 false。
      usemult = false;
      fillfactormult = 0.5;
    }
    for (const split of splits) {
      const delta = usemult ? fillfactormult * split.leftfree - (1 - fillfactormult) * split.rightfree : split.leftfree - split.rightfree;
      // int16 赋值向零截断。
      split.curdelta = Math.abs(Math.trunc(delta));
    }
    pgQsort(splits, (a, b) => a.curdelta - b.curdelta);

    // _bt_defaultinterval
    const tolerance = Math.trunc(olddataitemstotal * (isLeaf ? LEAF_SPLIT_DISTANCE : INTERNAL_SPLIT_DISTANCE));
    const best = splits[0];
    let interval = splits.length;
    for (let i = 1; i < splits.length; i++) {
      const s = splits[i];
      if (s.leftfree < best.leftfree - tolerance || s.rightfree < best.rightfree - tolerance || s.leftfree > best.leftfree + tolerance || s.rightfree > best.rightfree + tolerance) {
        interval = i;
        break;
      }
    }

    // _bt_bestsplitloc：叶子页键都不同，惩罚恒为 1，第一个候选就是最优；内部页挑 firstright 最短的。
    const perfect = isLeaf ? 1 : minfirstrightsz;
    let bestpenalty = Number.MAX_SAFE_INTEGER;
    let low = 0;
    for (let i = 0; i < Math.min(interval, splits.length); i++) {
      const s = splits[i];
      let penalty = 1;
      if (!isLeaf) penalty = !s.newitemonleft && s.firstrightoff === newoff ? newitemsz : MAXALIGN(page.lp(s.firstrightoff).len) + 4;
      if (penalty < bestpenalty) {
        bestpenalty = penalty;
        low = i;
      }
      if (penalty <= perfect) break;
    }
    return { ...splits[low], fill: usemult ? fillfactormult : null };
  }

  /** _bt_split：左页用临时页重建，右页新分配；两页都从头按键序写。 */
  private split(block: number, firstrightoff: number, newitemonleft: boolean, newoff: number, newitem: Uint8Array, log: InsertLog, point: { fill: number | null; leftfree: number; rightfree: number }) {
    const orig = this.pages[block];
    const opaque = this.opaque(block);
    const isLeaf = Boolean(opaque.flags & BTP_LEAF);
    const isRootFlagCleared = opaque.flags & ~BTP_ROOT;
    const maxoff = orig.maxOffset;
    const firstdata = this.firstData(block);
    const beforeKeys = this.keysOf(block).filter((k): k is number => k !== undefined);
    const newKey = decodeIndexTuple(newitem).key;

    const firstRightBytes = !newitemonleft && firstrightoff === newoff ? newitem : orig.item(firstrightoff).slice();

    // 左页的新 high key。叶子页走 _bt_truncate：键都不同，保留键列，去掉堆 TID。
    let lefthikey: Uint8Array;
    if (isLeaf) {
      const fr = decodeIndexTuple(firstRightBytes);
      lefthikey = encodeIndexTuple({ block: fr.block, posid: 1, info: 16 | INDEX_ALT_TID_MASK, key: fr.key });
    } else {
      lefthikey = firstRightBytes;
    }

    const left = new Page(orig.size, SizeOfBTPageOpaque);
    const rightBlock = this.alloc(isLeaf ? BTP_LEAF : 0, opaque.level);
    const right = this.pages[rightBlock];
    writeOpaque(left, { flags: isRootFlagCleared, level: opaque.level, prev: opaque.prev, next: rightBlock });
    writeOpaque(right, { prev: block, next: opaque.next, level: opaque.level, flags: isLeaf ? BTP_LEAF : 0 });

    left.addItem(lefthikey);
    if (opaque.next !== P_NONE) right.addItem(orig.item(P_HIKEY));

    const add = (target: Page, bytes: Uint8Array, firstOnPage: boolean) => {
      if (!isLeaf && firstOnPage) {
        // _bt_pgaddtup：内部页第一个数据项截断成负无穷，只保留下行链接。
        const t = decodeIndexTuple(bytes);
        target.addItem(encodeIndexTuple({ block: t.block, posid: 0, info: 8 | INDEX_ALT_TID_MASK }));
      } else target.addItem(bytes);
    };

    let afterLeftHigh = true;
    let afterRightHigh = true;
    const put = (bytes: Uint8Array, off: number, isNew: boolean) => {
      const toLeft = isNew ? newitemonleft : off < firstrightoff;
      if (toLeft) {
        add(left, bytes, afterLeftHigh);
        afterLeftHigh = false;
      } else {
        add(right, bytes, afterRightHigh);
        afterRightHigh = false;
      }
    };
    for (let off = firstdata; off <= maxoff; off++) {
      if (off === newoff) put(newitem, off, true);
      put(orig.item(off).slice(), off, false);
    }
    if (newoff > maxoff) put(newitem, newoff, true);

    // 原来的右邻要改 btpo_prev。
    if (opaque.next !== P_NONE) writeOpaque(this.pages[opaque.next], { prev: rightBlock });

    this.pages[block] = left;
    log.splits.push({
      block,
      rightBlock,
      level: opaque.level,
      before: [...beforeKeys, ...(newKey === undefined ? [] : [newKey])].sort((a, b) => a - b),
      leftKeys: this.keysOf(block).filter((k): k is number => k !== undefined),
      rightKeys: this.keysOf(rightBlock).filter((k): k is number => k !== undefined),
      highKey: decodeIndexTuple(lefthikey).key,
      firstRightOff: firstrightoff,
      newItemOnLeft: newitemonleft,
      fillFactor: point.fill,
      leftFree: point.leftfree,
      rightFree: point.rightfree,
    });
    return { rightBlock, highKeyBytes: lefthikey };
  }

  /** _bt_insert_parent：把左页的 high key 复制一份，下行链接指向右页，插进父页。 */
  private insertParent(left: number, right: number, highKey: Uint8Array, stack: number[], log: InsertLog): void {
    const down = decodeIndexTuple(highKey);
    const item = encodeIndexTuple({ block: right, posid: down.posid, info: down.info, key: down.key });
    if (!stack.length) {
      this.newRoot(left, item, log);
      return;
    }
    const parent = stack[stack.length - 1];
    const off = this.binsrchInternal(parent, down.key!) + 1;
    this.insertOnPage(parent, item, off, stack.slice(0, -1), log);
  }

  /** _bt_newlevel：根裂开时分配新页。第一项是指向左页的负无穷，第二项指向右页。 */
  private newRoot(left: number, item: Uint8Array, log: InsertLog): void {
    const level = this.opaque(left).level + 1;
    const block = this.alloc(BTP_ROOT, level);
    const page = this.pages[block];
    page.addItem(encodeIndexTuple({ block: left, posid: 0, info: 8 | INDEX_ALT_TID_MASK }));
    page.addItem(item);
    this.root = block;
    this.level = level;
    this.writeMeta();
    log.newRoot = block;
  }

  /** btvacuumpage 的结果：删除指向 tid 的叶子项。其余项和行指针按顺序收紧。 */
  removeTid(tid: Tid): { block: number; off: number } | null {
    for (let block = 1; block < this.pages.length; block++) {
      if (!(this.opaque(block).flags & BTP_LEAF)) continue;
      const page = this.pages[block];
      for (let off = this.firstData(block); off <= page.maxOffset; off++) {
        const t = this.tuple(block, off);
        if (t.block === tid[0] && t.posid === tid[1]) {
          // PageIndexMultiDelete：去掉行指针，并把数据压紧。
          const items: Uint8Array[] = [];
          for (let n = 1; n <= page.maxOffset; n++) if (n !== off) items.push(page.item(n).slice());
          const rebuilt = new Page(page.size, SizeOfBTPageOpaque);
          rebuilt.bytes.set(page.bytes.subarray(page.special), page.special);
          rebuilt.bytes.set(page.bytes.subarray(0, 12), 0);
          for (const item of items) rebuilt.addItem(item);
          this.pages[block] = rebuilt;
          return { block, off };
        }
      }
    }
    return null;
  }

  /** 按层列出全部页，给界面画树。 */
  levels(): Array<Array<{ block: number; keys: Array<number | undefined>; high: number | undefined; leaf: boolean; children: number[]; tids: Tid[] }>> {
    if (!this.root) return [];
    const out: ReturnType<BTree['levels']> = [];
    let row = [this.root];
    for (;;) {
      const nodes = row.map((block) => {
        const leaf = Boolean(this.opaque(block).flags & BTP_LEAF);
        const page = this.pages[block];
        const children: number[] = [];
        const tids: Tid[] = [];
        for (let off = this.firstData(block); off <= page.maxOffset; off++) {
          const t = this.tuple(block, off);
          if (leaf) tids.push([t.block, t.posid]);
          else children.push(t.block);
        }
        return { block, keys: this.keysOf(block), high: this.highKey(block), leaf, children, tids };
      });
      out.push(nodes);
      if (nodes[0].leaf) return out;
      row = nodes.flatMap((node) => node.children);
    }
  }
}
