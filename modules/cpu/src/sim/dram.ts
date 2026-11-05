/** DRAM 的行列访问时序模型。开页策略，只模拟一个 rank。单位是内存时钟（nCK）。 */
export interface DramTiming {
  tRCD: number;
  tCL: number;
  tRP: number;
  tRAS: number;
  /** 一次突发占数据总线的时钟数。BL8 在 DDR 上是 4 个时钟。 */
  burst: number;
  tCK: number;
}

export interface DramGeometry {
  rowBits: number;
  bankBits: number;
  columnBits: number;
  /** 通道宽度决定的字节偏移位数。64 位通道是 3。 */
  byteBits: number;
}

export interface DramAddress {
  row: number;
  bank: number;
  column: number;
  byte: number;
}

export function splitDramAddress(address: number, g: DramGeometry): DramAddress {
  const a = address >>> 0;
  const byte = a & (2 ** g.byteBits - 1);
  const column = (a >>> g.byteBits) & (2 ** g.columnBits - 1);
  const bank = (a >>> (g.byteBits + g.columnBits)) & (2 ** g.bankBits - 1);
  const row = (a >>> (g.byteBits + g.columnBits + g.bankBits)) & (2 ** g.rowBits - 1);
  return { row, bank, column, byte };
}

export type DramCommand = 'ACT' | 'RD' | 'PRE';

export interface CommandEvent {
  cycle: number;
  command: DramCommand;
  bank: number;
  row: number;
  column?: number;
  /** 这条命令要等到这个周期的原因。 */
  why: string;
}

export interface DramAccess {
  address: number;
  parts: DramAddress;
  outcome: 'row-hit' | 'row-closed' | 'row-conflict';
  requestAt: number;
  commands: CommandEvent[];
  dataStart: number;
  dataEnd: number;
  /** 从请求到第一笔数据的时钟数。 */
  latency: number;
  /** 访问结束时每个 bank 打开的行。 */
  openRows: Array<number | null>;
}

export class DramBankModel {
  open: Array<number | null>;
  private lastAct: number[];
  private lastPre: number[];
  private lastRead: number[];
  log: DramAccess[] = [];

  constructor(readonly timing: DramTiming, readonly geometry: DramGeometry) {
    const banks = 2 ** geometry.bankBits;
    this.open = new Array(banks).fill(null);
    this.lastAct = new Array(banks).fill(-Infinity);
    this.lastPre = new Array(banks).fill(-Infinity);
    this.lastRead = new Array(banks).fill(-Infinity);
  }

  /** 按时序约束安排一次读，返回每条命令的周期。 */
  read(address: number, requestAt: number): DramAccess {
    const t = this.timing;
    const parts = splitDramAddress(address, this.geometry);
    const { bank, row, column } = parts;
    const commands: CommandEvent[] = [];
    let at = requestAt;
    let outcome: DramAccess['outcome'];
    if (this.open[bank] === row) {
      outcome = 'row-hit';
    } else {
      if (this.open[bank] !== null) {
        outcome = 'row-conflict';
        const earliest = this.lastAct[bank] + t.tRAS;
        const pre = Math.max(at, earliest);
        commands.push({ cycle: pre, command: 'PRE', bank, row: this.open[bank]!, why: pre === earliest && earliest > at ? `tRAS：上次 ACT 后至少 ${t.tRAS} 个时钟才能预充电` : '旧行要先关掉' });
        this.lastPre[bank] = pre;
        this.open[bank] = null;
        at = pre + t.tRP;
      } else {
        outcome = 'row-closed';
        at = Math.max(at, this.lastPre[bank] + t.tRP);
      }
      commands.push({ cycle: at, command: 'ACT', bank, row, why: outcome === 'row-conflict' ? `tRP：预充电后 ${t.tRP} 个时钟才能激活` : '行未打开，先激活' });
      this.lastAct[bank] = at;
      this.open[bank] = row;
      at += t.tRCD;
    }
    const readAt = Math.max(at, this.lastRead[bank] + t.burst);
    commands.push({ cycle: readAt, command: 'RD', bank, row, column, why: outcome === 'row-hit' ? '行已打开，直接读列' : `tRCD：激活后 ${t.tRCD} 个时钟才能读列` });
    this.lastRead[bank] = readAt;
    const dataStart = readAt + t.tCL;
    const dataEnd = dataStart + t.burst;
    const entry: DramAccess = { address: address >>> 0, parts, outcome, requestAt, commands, dataStart, dataEnd, latency: dataStart - requestAt, openRows: [...this.open] };
    this.log.push(entry);
    return entry;
  }
}
