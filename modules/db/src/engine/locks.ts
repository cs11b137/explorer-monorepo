/** 依据 src/backend/storage/lmgr/lock.c 的 LockConflicts 和 deadlock.c（REL_17_STABLE）。 */
export const LOCK_MODES = ['AccessShare', 'RowShare', 'RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'] as const;
export type LockMode = (typeof LOCK_MODES)[number];

const conflicts: Record<LockMode, LockMode[]> = {
  AccessShare: ['AccessExclusive'],
  RowShare: ['Exclusive', 'AccessExclusive'],
  RowExclusive: ['Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  ShareUpdateExclusive: ['ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  Share: ['RowExclusive', 'ShareUpdateExclusive', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  ShareRowExclusive: ['RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  Exclusive: ['RowShare', 'RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
  AccessExclusive: ['AccessShare', 'RowShare', 'RowExclusive', 'ShareUpdateExclusive', 'Share', 'ShareRowExclusive', 'Exclusive', 'AccessExclusive'],
};

export const lockConflicts = (a: LockMode, b: LockMode): boolean => conflicts[a].includes(b);

/** 每个事务持有自己 xid 的 ExclusiveLock；等行锁其实是对持有者的 xid 申请 ShareLock（XactLockTableWait）。 */
export interface LockEntry {
  xid: number;
  holders: number[];
  waiters: number[];
}

export interface Backend {
  pid: number;
  xid: number;
}

export interface CycleResult {
  /** 从发起者出发找到的环（事务号序列），没有环就是 null。 */
  cycle: number[] | null;
  /** 深度优先搜索访问过的节点，顺序和 visitedProcs 相同。 */
  visited: number[];
}

/**
 * FindLockCycle 的核心：visitedProcs 记录走过的进程，只有回到起点才算死锁，
 * 回到中间节点不算（那说明环不包含发起者，别的进程会发现它）。
 * edges[a] 是 a 正在等待的事务。
 */
export function findLockCycle(start: number, edges: Map<number, number[]>): CycleResult {
  const visited: number[] = [];
  const stack: number[] = [];
  const walk = (node: number): boolean => {
    const at = visited.indexOf(node);
    if (at >= 0) return at === 0;
    visited.push(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) if (walk(next)) return true;
    stack.pop();
    return false;
  };
  const found = walk(start);
  return { cycle: found ? stack.slice() : null, visited };
}

/** 模拟 xid 级别的等待：拿不到就进队等待。 */
export class LockTable {
  /** 行 → 持有它的事务（行上 xmax 写的那个）。 */
  rows = new Map<string, number>();
  waits = new Map<number, number[]>();
  waitStart = new Map<number, number>();

  lockRow(row: string, xid: number, now: number): { granted: boolean; holder: number | null } {
    const holder = this.rows.get(row);
    if (holder === undefined || holder === xid) {
      this.rows.set(row, xid);
      return { granted: true, holder: null };
    }
    this.waits.set(xid, [holder]);
    this.waitStart.set(xid, now);
    return { granted: false, holder };
  }

  /** 事务结束：释放它的行，等它的人被唤醒。 */
  release(xid: number): number[] {
    for (const [row, holder] of [...this.rows]) if (holder === xid) this.rows.delete(row);
    this.waits.delete(xid);
    this.waitStart.delete(xid);
    const woken: number[] = [];
    for (const [waiter, list] of [...this.waits]) {
      if (list.includes(xid)) {
        this.waits.delete(waiter);
        this.waitStart.delete(waiter);
        woken.push(waiter);
      }
    }
    return woken;
  }

  /** 谁的 deadlock_timeout 先到：等得最久的那个进程先跑 DeadLockCheck。 */
  firstToCheck(): number | null {
    let best: number | null = null;
    let at = Infinity;
    for (const [xid, started] of this.waitStart) {
      if (started < at) {
        at = started;
        best = xid;
      }
    }
    return best;
  }
}
