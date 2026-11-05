/** 依据 src/include/storage/buf_internals.h 和 src/backend/storage/buffer/freelist.c（REL_17_STABLE）。 */
export const BM_MAX_USAGE_COUNT = 5;
export const BUF_REFCOUNT_MASK = (1 << 18) - 1;
export const BUF_USAGECOUNT_SHIFT = 18;
export const BM_DIRTY = 1 << 23;
export const BM_VALID = 1 << 24;
export const BM_TAG_VALID = 1 << 25;
export const BM_PERMANENT = 2 ** 31;

export interface BufTag {
  spc: number;
  db: number;
  rel: number;
  fork: number;
  block: number;
}

export interface Frame {
  id: number;
  tag: BufTag | null;
  usage: number;
  ref: number;
  dirty: boolean;
  /** 页上的 pd_lsn。写脏页之前必须先把 WAL 刷到这里。 */
  lsn: bigint;
}

export type SweepStep = { frame: number; usage: number; ref: number; action: 'dec' | 'skip' | 'take' };

export interface ReadLog {
  hit: boolean;
  frame: number;
  fromFree: boolean;
  sweep: SweepStep[];
  evicted: { tag: BufTag; dirty: boolean; lsn: bigint } | null;
  handBefore: number;
  handAfter: number;
}

export const tagText = (tag: BufTag | null): string => (tag ? `${relName(tag.rel)}/${tag.block}` : '—');
const REL_NAMES = new Map<number, string>();
export const nameRel = (rel: number, name: string): void => void REL_NAMES.set(rel, name);
const relName = (rel: number): string => REL_NAMES.get(rel) ?? String(rel);

const same = (a: BufTag, b: BufTag) => a.spc === b.spc && a.db === b.db && a.rel === b.rel && a.fork === b.fork && a.block === b.block;

/** 真实的缓冲池算法：BufTable 查找、PinBuffer、StrategyGetBuffer 的时钟扫描。 */
export class BufferPool {
  frames: Frame[];
  hand = 0;
  free: number[];

  constructor(size: number) {
    this.frames = Array.from({ length: size }, (_, id) => ({ id, tag: null, usage: 0, ref: 0, dirty: false, lsn: 0n }));
    this.free = this.frames.map((frame) => frame.id);
  }

  lookup(tag: BufTag): Frame | undefined {
    return this.frames.find((frame) => frame.tag && same(frame.tag, tag));
  }

  /** StrategyGetBuffer：先用空闲链表，然后转动时钟。 */
  private strategyGetBuffer(): { frame: Frame; fromFree: boolean; sweep: SweepStep[] } {
    const sweep: SweepStep[] = [];
    while (this.free.length) {
      const frame = this.frames[this.free.shift()!];
      if (frame.ref === 0 && frame.usage === 0) return { frame, fromFree: true, sweep };
    }
    let trycounter = this.frames.length;
    for (;;) {
      const frame = this.frames[this.hand];
      this.hand = (this.hand + 1) % this.frames.length;
      if (frame.ref === 0) {
        if (frame.usage !== 0) {
          sweep.push({ frame: frame.id, usage: frame.usage, ref: frame.ref, action: 'dec' });
          frame.usage -= 1;
          trycounter = this.frames.length;
        } else {
          sweep.push({ frame: frame.id, usage: 0, ref: 0, action: 'take' });
          return { frame, fromFree: false, sweep };
        }
      } else {
        sweep.push({ frame: frame.id, usage: frame.usage, ref: frame.ref, action: 'skip' });
        if (--trycounter === 0) throw new Error('no unpinned buffers available');
      }
    }
  }

  /** ReadBuffer：命中就 PinBuffer（usage_count 加 1，封顶 5）；否则选牺牲帧，新页的 usage_count 从 1 开始。 */
  read(tag: BufTag): ReadLog {
    const handBefore = this.hand;
    const found = this.lookup(tag);
    if (found) {
      found.ref += 1;
      if (found.usage < BM_MAX_USAGE_COUNT) found.usage += 1;
      return { hit: true, frame: found.id, fromFree: false, sweep: [], evicted: null, handBefore, handAfter: this.hand };
    }
    const { frame, fromFree, sweep } = this.strategyGetBuffer();
    const evicted = frame.tag ? { tag: frame.tag, dirty: frame.dirty, lsn: frame.lsn } : null;
    frame.tag = tag;
    frame.ref = 1;
    frame.usage = 1;
    frame.dirty = false;
    frame.lsn = 0n;
    return { hit: false, frame: frame.id, fromFree, sweep, evicted, handBefore, handAfter: this.hand };
  }

  unpin(id: number): void {
    const frame = this.frames[id];
    if (frame.ref <= 0) throw new Error('缓冲区没有被钉住');
    frame.ref -= 1;
  }

  markDirty(id: number, lsn: bigint): void {
    const frame = this.frames[id];
    frame.dirty = true;
    frame.lsn = lsn;
  }

  /** BufferDesc.state 这个 32 位原子字：低 18 位 refcount，接着 4 位 usage_count，高 10 位是标志。 */
  stateWord(id: number): number {
    const f = this.frames[id];
    let state = f.ref + f.usage * 2 ** BUF_USAGECOUNT_SHIFT;
    if (f.dirty) state += BM_DIRTY;
    if (f.tag) state += BM_VALID + BM_TAG_VALID + BM_PERMANENT;
    return state >>> 0;
  }
}
