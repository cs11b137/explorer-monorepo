/**
 * 可串行化快照隔离的最小模型，名字和 src/backend/storage/lmgr/predicate.c（REL_17_STABLE）对应。
 * 读留下 SIREAD 锁；写时检查谁读过它，建立 rw 依赖边（reader → writer）。
 * 提交时如果自己既有入边又有出边（pivot），并且出边指向的事务已先提交，就必须放弃。
 */
export interface Sxact {
  xid: number;
  name: string;
  inConflicts: Set<number>;
  outConflicts: Set<number>;
  sireads: Set<string>;
  writes: Set<string>;
  committed: boolean;
  doomed: boolean;
  commitSeq: number;
  snapshotBefore: Set<number>;
}

export interface SsiEvent {
  kind: 'read' | 'write' | 'edge' | 'commit' | 'abort';
  xid: number;
  detail: string;
}

export class Ssi {
  xacts = new Map<number, Sxact>();
  private seq = 0;

  begin(xid: number, name: string): void {
    const running = new Set([...this.xacts.values()].filter((x) => !x.committed && !x.doomed).map((x) => x.xid));
    this.xacts.set(xid, { xid, name, inConflicts: new Set(), outConflicts: new Set(), sireads: new Set(), writes: new Set(), committed: false, doomed: false, commitSeq: 0, snapshotBefore: running });
  }

  /** PredicateLockRelation / PredicateLockTID：读过就留下 SIREAD，它不阻塞任何人。 */
  read(xid: number, target: string): void {
    this.xacts.get(xid)!.sireads.add(target);
  }

  /** CheckForSerializationConflictIn → FlagRWConflict：有人读过我要写的目标，且我们并发。 */
  write(xid: number, target: string, overlaps: (lock: string) => boolean = (lock) => lock === target): Array<{ reader: number; writer: number }> {
    const me = this.xacts.get(xid)!;
    me.writes.add(target);
    const edges: Array<{ reader: number; writer: number }> = [];
    for (const other of this.xacts.values()) {
      if (other.xid === xid) continue;
      if ([...other.sireads].some(overlaps)) {
        other.outConflicts.add(xid);
        me.inConflicts.add(other.xid);
        edges.push({ reader: other.xid, writer: xid });
      }
    }
    return edges;
  }

  /**
   * PreCommit_CheckForSerializationFailure：
   * 提交者如果是某个 pivot 的“出边目标”，而那个 pivot 又有入边，就把 pivot 判死（它还没提交）。
   */
  commit(xid: number): { ok: boolean; doomed: number[]; reason: string } {
    const me = this.xacts.get(xid)!;
    if (me.doomed) {
      return { ok: false, doomed: [], reason: 'Canceled on identification as a pivot, during commit attempt.' };
    }
    const doomed: number[] = [];
    for (const nearXid of me.inConflicts) {
      const near = this.xacts.get(nearXid)!;
      if (near.committed || near.doomed) continue;
      // near --rw--> me，near 还有入边的话就是 pivot。
      if (near.inConflicts.size > 0) {
        near.doomed = true;
        doomed.push(nearXid);
      }
    }
    me.committed = true;
    me.commitSeq = ++this.seq;
    return { ok: true, doomed, reason: doomed.length ? '先提交者把 pivot 判死' : '没有危险结构' };
  }
}
