import { Memory } from './exec';

export type MesiState = 'M' | 'E' | 'S' | 'I';
export type BusOp = 'BusRd' | 'BusRdX' | 'BusUpgr';

export interface LineView {
  state: MesiState;
  value: number;
}

export interface Transition {
  core: number;
  from: MesiState;
  to: MesiState;
}

export interface MesiEvent {
  seq: number;
  core: number;
  kind: 'R' | 'W';
  address: number;
  /** 本地命中且不需要总线。 */
  silent: boolean;
  bus: BusOp | null;
  /** 总线上别的核的反应。 */
  snoops: Transition[];
  self: Transition;
  /** 有 M 状态的核把脏数据冲回内存。 */
  flushedBy: number | null;
  /** 读未命中时数据从哪来。 */
  dataFrom: 'memory' | 'flush' | 'local';
  /** 有没有别的核共享，决定读未命中后进 E 还是 S。 */
  sharedLine: boolean;
  value: number;
  memoryValue: number;
  lines: LineView[];
  /** 这次操作开始和结束的周期，由 MesiLatency 算出。 */
  startCycle: number;
  endCycle: number;
}

/** 教学用的延迟参数，真实芯片差别很大。 */
export interface MesiLatency {
  hit: number;
  /** 总线上发一次失效请求，不带数据。 */
  upgrade: number;
  /** 从内存读一块。 */
  memory: number;
  /** 脏数据冲回内存，额外花费。 */
  flush: number;
}

export const DEFAULT_LATENCY: MesiLatency = { hit: 1, upgrade: 4, memory: 20, flush: 10 };

/**
 * 基于写失效的 MESI 嗅探协议。为了让状态看得清，每个核只缓存同一个地址这一块。
 * M 被 BusRd 嗅探到时冲回内存并降为 S；任何状态被 BusRdX/BusUpgr 嗅探到都变 I；E 变 M 不上总线。
 */
export class MesiSystem {
  lines: LineView[];
  log: MesiEvent[] = [];
  seq = 0;
  cycle = 0;

  constructor(readonly cores: number, readonly address: number, readonly memory: Memory = new Memory(), readonly latency: MesiLatency = DEFAULT_LATENCY) {
    this.lines = Array.from({ length: cores }, () => ({ state: 'I' as MesiState, value: 0 }));
  }

  private finish(event: Omit<MesiEvent, 'seq' | 'memoryValue' | 'lines' | 'address' | 'startCycle' | 'endCycle'>): MesiEvent {
    this.seq += 1;
    const { hit, upgrade, memory, flush } = this.latency;
    const cost = event.silent ? hit : (event.bus === 'BusUpgr' ? upgrade : memory) + (event.flushedBy !== null ? flush : 0);
    const startCycle = this.cycle + 1;
    this.cycle += cost;
    const full: MesiEvent = { ...event, seq: this.seq, address: this.address, memoryValue: this.memory.loadWord(this.address), lines: this.lines.map((line) => ({ ...line })), startCycle, endCycle: this.cycle };
    this.log.push(full);
    return full;
  }

  /** 找到 M 状态的核，把它的数据冲回内存。 */
  private flushOwner(requester: number): number | null {
    const owner = this.lines.findIndex((line, core) => core !== requester && line.state === 'M');
    if (owner < 0) return null;
    this.memory.storeWord(this.address, this.lines[owner].value);
    return owner;
  }

  read(core: number): MesiEvent {
    const line = this.lines[core];
    const from = line.state;
    if (from !== 'I') {
      return this.finish({ core, kind: 'R', silent: true, bus: null, snoops: [], self: { core, from, to: from }, flushedBy: null, dataFrom: 'local', sharedLine: false, value: line.value });
    }
    const flushedBy = this.flushOwner(core);
    const snoops: Transition[] = [];
    let sharedLine = false;
    this.lines.forEach((other, index) => {
      if (index === core || other.state === 'I') return;
      sharedLine = true;
      if (other.state !== 'S') snoops.push({ core: index, from: other.state, to: 'S' });
      other.state = 'S';
    });
    line.value = this.memory.loadWord(this.address);
    line.state = sharedLine ? 'S' : 'E';
    return this.finish({ core, kind: 'R', silent: false, bus: 'BusRd', snoops, self: { core, from, to: line.state }, flushedBy, dataFrom: flushedBy !== null ? 'flush' : 'memory', sharedLine, value: line.value });
  }

  write(core: number, value: number): MesiEvent {
    const line = this.lines[core];
    const from = line.state;
    const v = value >>> 0;
    if (from === 'M' || from === 'E') {
      line.state = 'M';
      line.value = v;
      return this.finish({ core, kind: 'W', silent: true, bus: null, snoops: [], self: { core, from, to: 'M' }, flushedBy: null, dataFrom: 'local', sharedLine: false, value: v });
    }
    const flushedBy = from === 'I' ? this.flushOwner(core) : null;
    const snoops: Transition[] = [];
    this.lines.forEach((other, index) => {
      if (index === core || other.state === 'I') return;
      snoops.push({ core: index, from: other.state, to: 'I' });
      other.state = 'I';
    });
    line.state = 'M';
    line.value = v;
    return this.finish({ core, kind: 'W', silent: false, bus: from === 'S' ? 'BusUpgr' : 'BusRdX', snoops, self: { core, from, to: 'M' }, flushedBy, dataFrom: flushedBy !== null ? 'flush' : from === 'S' ? 'local' : 'memory', sharedLine: snoops.length > 0, value: v });
  }

  /** 现在读这个地址应该得到的值：有 M 就在 M 的缓存里，否则在内存里。 */
  latest(): number {
    const owner = this.lines.find((line) => line.state === 'M');
    return owner ? owner.value : this.memory.loadWord(this.address);
  }
}
