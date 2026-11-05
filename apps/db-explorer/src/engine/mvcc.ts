import { HEAP_HOT_UPDATED, HEAP_XMAX_COMMITTED, HEAP_XMAX_INVALID, HEAP_XMAX_LOCK_ONLY, HEAP_XMIN_COMMITTED, HEAP_XMIN_INVALID, HeapPage, readTupleHeader } from './page';
import { rd16, wr16 } from './bytes';

/** src/include/access/clog.h */
export const TRANSACTION_STATUS_IN_PROGRESS = 0;
export const TRANSACTION_STATUS_COMMITTED = 1;
export const TRANSACTION_STATUS_ABORTED = 2;
export const TRANSACTION_STATUS_SUB_COMMITTED = 3;
export const STATUS_NAMES = ['IN_PROGRESS', 'COMMITTED', 'ABORTED', 'SUB_COMMITTED'];
export const CLOG_XACTS_PER_BYTE = 4;

/** 真实的 CLOG 位图：每个事务 2 位，每字节 4 个事务，低位在前。 */
export class Clog {
  bytes = new Uint8Array(8192);

  private place(xid: number): { byte: number; shift: number } {
    const inPage = xid % (8192 * CLOG_XACTS_PER_BYTE);
    return { byte: Math.floor(inPage / CLOG_XACTS_PER_BYTE), shift: (xid % CLOG_XACTS_PER_BYTE) * 2 };
  }

  set(xid: number, status: number): void {
    const { byte, shift } = this.place(xid);
    this.bytes[byte] = (this.bytes[byte] & ~(3 << shift)) | (status << shift);
  }

  get(xid: number): number {
    const { byte, shift } = this.place(xid);
    return (this.bytes[byte] >> shift) & 3;
  }

  byteOf(xid: number): number {
    return this.place(xid).byte;
  }

  clone(): Clog {
    const copy = new Clog();
    copy.bytes = this.bytes.slice();
    return copy;
  }
}

export interface Snapshot {
  xmin: number;
  xmax: number;
  xip: number[];
  curcid: number;
}

/**
 * GetSnapshotData：xmax = 最新完成的事务号 + 1；xmin = 还在运行的最小事务号（没有就等于 xmax）；
 * xip = [xmin, xmax) 之间仍在运行的事务。自己的事务也算“在运行”，不过 GetSnapshotData 会把它跳过，
 * 由可见性判断里的 TransactionIdIsCurrentTransactionId 单独处理。
 */
export function getSnapshot(running: number[], latestCompleted: number, me: number | null = null, curcid = 0): Snapshot {
  const xmax = latestCompleted + 1;
  const active = running.filter((xid) => xid < xmax);
  const others = active.filter((xid) => xid !== me).sort((a, b) => a - b);
  const xmin = active.length ? Math.min(...active) : xmax;
  return { xmin, xmax, xip: others, curcid };
}

/** XidInMVCCSnapshot：true 表示在这个快照看来，xid 还在进行中。 */
export function xidInSnapshot(xid: number, snap: Snapshot): boolean {
  if (xid < snap.xmin) return false;
  if (xid >= snap.xmax) return true;
  return snap.xip.includes(xid);
}

export interface Verdict {
  visible: boolean;
  /** 判断经过的每一步，直接用于界面和检查器。 */
  path: string[];
  /** 这次判断顺手设置的提示位。 */
  hints: number;
}

/**
 * HeapTupleSatisfiesMVCC 的直译（去掉了 pre-9.0 的 HEAP_MOVED 分支和 MultiXact）。
 * 顺序和 heapam_visibility.c 一致：先看 xmin，xmin 通过后再看 xmax。
 */
export function satisfiesMVCC(tuple: Uint8Array, snap: Snapshot, clog: Clog, me: number | null = null): Verdict {
  const h = readTupleHeader(tuple);
  const path: string[] = [];
  let hints = 0;
  const setHint = (bit: number) => {
    hints |= bit;
  };
  const no = () => ({ visible: false, path, hints });
  const yes = () => ({ visible: true, path, hints });

  if (!(h.infomask & HEAP_XMIN_COMMITTED)) {
    if (h.infomask & HEAP_XMIN_INVALID) {
      path.push('xmin 已标记无效');
      return no();
    }
    if (h.xmin === me) {
      if (h.cid >= snap.curcid) {
        path.push(`xmin 是自己，但 cid ${h.cid} ≥ 当前命令 ${snap.curcid}`);
        return no();
      }
      if (h.infomask & HEAP_XMAX_INVALID) {
        path.push('xmin 是自己，没有 xmax');
        return yes();
      }
      if (h.xmax !== me) {
        // 删除者不是自己，说明删除的子事务已回滚。
        setHint(HEAP_XMAX_INVALID);
        path.push('xmin 是自己，xmax 不是自己');
        return yes();
      }
      if (h.cid >= snap.curcid) {
        path.push('自己删的，但发生在当前命令之后');
        return yes();
      }
      path.push('自己插入，又被自己删除');
      return no();
    }
    if (xidInSnapshot(h.xmin, snap)) {
      path.push(`xmin ${h.xmin} 在快照里还算进行中`);
      return no();
    }
    if (clog.get(h.xmin) === TRANSACTION_STATUS_COMMITTED) {
      setHint(HEAP_XMIN_COMMITTED);
      path.push(`查 CLOG：xmin ${h.xmin} 已提交，设 HEAP_XMIN_COMMITTED`);
    } else {
      setHint(HEAP_XMIN_INVALID);
      path.push(`查 CLOG：xmin ${h.xmin} 未提交，设 HEAP_XMIN_INVALID`);
      return no();
    }
  } else {
    if (xidInSnapshot(h.xmin, snap)) {
      path.push(`提示位说 xmin ${h.xmin} 已提交，但快照里它还在进行中`);
      return no();
    }
    path.push(`提示位：xmin ${h.xmin} 已提交，且不在快照的进行中集合`);
  }

  if (h.infomask & HEAP_XMAX_INVALID) {
    path.push('没有有效的 xmax：可见');
    return yes();
  }
  if (h.infomask & HEAP_XMAX_LOCK_ONLY) {
    path.push('xmax 只是行锁：可见');
    return yes();
  }
  if (!(h.infomask & HEAP_XMAX_COMMITTED)) {
    if (h.xmax === me) {
      if (h.cid >= snap.curcid) {
        path.push('被自己删除，但发生在当前命令之后：可见');
        return yes();
      }
      path.push('被自己删除：不可见');
      return no();
    }
    if (xidInSnapshot(h.xmax, snap)) {
      path.push(`xmax ${h.xmax} 在快照里还算进行中：可见`);
      return yes();
    }
    if (clog.get(h.xmax) !== TRANSACTION_STATUS_COMMITTED) {
      setHint(HEAP_XMAX_INVALID);
      path.push(`查 CLOG：xmax ${h.xmax} 未提交，设 HEAP_XMAX_INVALID：可见`);
      return yes();
    }
    setHint(HEAP_XMAX_COMMITTED);
    path.push(`查 CLOG：xmax ${h.xmax} 已提交，设 HEAP_XMAX_COMMITTED：不可见`);
    return no();
  }
  if (xidInSnapshot(h.xmax, snap)) {
    path.push(`提示位说 xmax ${h.xmax} 已提交，但快照里它还在进行中：可见`);
    return yes();
  }
  path.push(`提示位：xmax ${h.xmax} 已提交：不可见`);
  return no();
}

/** 把判断时得到的提示位写回元组。提示位不写 WAL。 */
export function applyHints(tuple: Uint8Array, hints: number): void {
  wr16(tuple, 20, rd16(tuple, 20) | hints);
}

/** 全页扫描一遍，返回每个行指针的结论，并把提示位写回页面。 */
export function scanPage(heap: HeapPage, snap: Snapshot, clog: Clog, me: number | null = null): Array<{ off: number; verdict: Verdict }> {
  const out = [];
  for (let off = 1; off <= heap.page.maxOffset; off++) {
    if (heap.page.lp(off).flags !== 1) continue;
    const t = heap.tuple(off);
    const verdict = satisfiesMVCC(t, snap, clog, me);
    applyHints(t, verdict.hints);
    out.push({ off, verdict });
  }
  return out;
}

export { HEAP_HOT_UPDATED };
