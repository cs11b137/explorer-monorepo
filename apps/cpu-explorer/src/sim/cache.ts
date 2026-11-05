import { Memory } from './exec';

export interface CacheConfig {
  sets: number;
  ways: number;
  blockBytes: number;
  /** 下面三个都是周期数，由课程给出的示例参数。 */
  hitCycles: number;
  missPenalty: number;
  writePenalty: number;
  writePolicy: 'write-back' | 'write-through';
  writeMiss: 'allocate' | 'no-allocate';
}

export const log2 = (value: number): number => {
  const result = Math.log2(value);
  if (!Number.isInteger(result)) throw new Error(`${value} 不是 2 的幂`);
  return result;
};

export interface AddressParts {
  tag: number;
  index: number;
  offset: number;
  tagBits: number;
  indexBits: number;
  offsetBits: number;
}

export function splitAddress(address: number, config: Pick<CacheConfig, 'sets' | 'blockBytes'>): AddressParts {
  const offsetBits = log2(config.blockBytes);
  const indexBits = log2(config.sets);
  const a = address >>> 0;
  return {
    offset: a & (config.blockBytes - 1),
    index: (a >>> offsetBits) & (config.sets - 1),
    tag: indexBits + offsetBits >= 32 ? 0 : a >>> (indexBits + offsetBits),
    tagBits: 32 - indexBits - offsetBits,
    indexBits,
    offsetBits,
  };
}

export interface CacheLine {
  valid: boolean;
  dirty: boolean;
  tag: number;
  /** 上次使用的访问序号。越小越该被替换。 */
  used: number;
  /** 块内的真实字节。 */
  data: number[];
}

export interface AccessResult {
  seq: number;
  kind: 'R' | 'W';
  address: number;
  parts: AddressParts;
  hit: boolean;
  set: number;
  /** 命中或填入的路；不分配的写未命中是 null。 */
  way: number | null;
  /** 被替换的有效行。 */
  evicted: { tag: number; dirty: boolean; address: number } | null;
  /** 从下一级读了多少字节。 */
  memReadBytes: number;
  /** 写到下一级多少字节。 */
  memWriteBytes: number;
  startCycle: number;
  endCycle: number;
  /** 访问花的周期数。 */
  cycles: number;
  value: number;
  size: number;
  /** 访问结束时的全部缓存行。 */
  snapshot: CacheLine[][];
}

export class Cache {
  lines: CacheLine[][];
  seq = 0;
  cycle = 0;
  hits = 0;
  misses = 0;
  memReads = 0;
  memWrites = 0;
  memWriteBytes = 0;
  memReadBytes = 0;
  log: AccessResult[] = [];

  constructor(readonly config: CacheConfig, readonly memory: Memory = new Memory()) {
    this.lines = Array.from({ length: config.sets }, () =>
      Array.from({ length: config.ways }, () => ({ valid: false, dirty: false, tag: 0, used: 0, data: new Array(config.blockBytes).fill(0) })),
    );
  }

  private blockAddress(tag: number, index: number): number {
    const { offsetBits, indexBits } = splitAddress(0, this.config);
    return ((tag * 2 ** (indexBits + offsetBits)) + index * 2 ** offsetBits) >>> 0;
  }

  /** 先找空路，没有就替换最久没用的路（LRU）。 */
  private victim(set: CacheLine[]): number {
    const free = set.findIndex((line) => !line.valid);
    if (free >= 0) return free;
    let best = 0;
    set.forEach((line, way) => {
      if (line.used < set[best].used) best = way;
    });
    return best;
  }

  private access(kind: 'R' | 'W', address: number, size: number, value = 0): AccessResult {
    const config = this.config;
    const a = address >>> 0;
    const parts = splitAddress(a, config);
    if (parts.offset + size > config.blockBytes) throw new Error('这个模型不支持跨块访问');
    this.seq += 1;
    const set = this.lines[parts.index];
    let way: number | null = set.findIndex((line) => line.valid && line.tag === parts.tag);
    const hit = way >= 0;
    let evicted: AccessResult['evicted'] = null;
    let memReadBytes = 0;
    let memWriteBytes = 0;
    let cycles = config.hitCycles;
    const blockBase = a - parts.offset;

    if (hit) this.hits += 1;
    else this.misses += 1;

    if (!hit) {
      if (kind === 'R' || config.writeMiss === 'allocate') {
        way = this.victim(set);
        const line = set[way];
        if (line.valid) {
          const oldAddress = this.blockAddress(line.tag, parts.index);
          evicted = { tag: line.tag, dirty: line.dirty, address: oldAddress };
          if (line.dirty) {
            line.data.forEach((byte, index) => this.memory.store8(oldAddress + index, byte));
            memWriteBytes += config.blockBytes;
            cycles += config.writePenalty;
            this.memWrites += 1;
          }
        }
        for (let index = 0; index < config.blockBytes; index++) line.data[index] = this.memory.load8(blockBase + index);
        line.valid = true;
        line.dirty = false;
        line.tag = parts.tag;
        memReadBytes += config.blockBytes;
        cycles += config.missPenalty;
        this.memReads += 1;
      } else {
        way = null;
      }
    }

    let result = 0;
    if (kind === 'R') {
      const line = set[way!];
      for (let index = 0; index < size; index++) result += line.data[parts.offset + index] * 2 ** (8 * index);
      line.used = this.seq;
    } else {
      if (way !== null) {
        const line = set[way];
        for (let index = 0; index < size; index++) line.data[parts.offset + index] = (value >>> (index * 8)) & 0xff;
        line.used = this.seq;
        if (config.writePolicy === 'write-back') line.dirty = true;
      }
      if (config.writePolicy === 'write-through' || way === null) {
        for (let index = 0; index < size; index++) this.memory.store8(a + index, value >>> (index * 8));
        memWriteBytes += size;
        cycles += config.writePenalty;
        this.memWrites += 1;
      }
      result = value >>> 0;
    }
    this.memReadBytes += memReadBytes;
    this.memWriteBytes += memWriteBytes;
    const startCycle = this.cycle + 1;
    this.cycle += cycles;
    const entry: AccessResult = {
      seq: this.seq, kind, address: a, parts, hit, set: parts.index, way, evicted, memReadBytes, memWriteBytes,
      startCycle, endCycle: this.cycle, cycles, value: result, size,
      snapshot: this.lines.map((row) => row.map((line) => ({ ...line, data: [...line.data] }))),
    };
    this.log.push(entry);
    return entry;
  }

  read(address: number, size = 4): AccessResult {
    return this.access('R', address, size);
  }

  write(address: number, value: number, size = 4): AccessResult {
    return this.access('W', address, size, value);
  }

  /** 把所有脏行写回，用来核对内存内容。 */
  flush(): void {
    this.lines.forEach((set, index) => {
      for (const line of set) {
        if (line.valid && line.dirty) {
          const base = this.blockAddress(line.tag, index);
          line.data.forEach((byte, offset) => this.memory.store8(base + offset, byte));
          line.dirty = false;
        }
      }
    });
  }

  get hitRate(): number {
    return this.seq ? this.hits / this.seq : 0;
  }
}
