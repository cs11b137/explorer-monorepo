import { segTone } from '../decode/structures';
import type { Cell, BitsWidget, CellLike, GridWidget, KvWidget, PanelContent, Tone } from '../scene/widgets';
import type { CacheLine, AddressParts } from '../sim/cache';
import { fieldsOf } from '../sim/float';
import type { CycleSnapshot, PipelineResult, StageName } from '../sim/pipeline';
import { decode, hex32, segmentsOf } from '../sim/riscv';

/** 数值面板的小工具。课程只负责把模拟器算出的值放进来。 */
export const cell = (t: string, tone?: Tone, solid = false, span?: number): Cell => ({ t, tone, solid, span });
export const on = (t: string, tone: Tone = 'blue'): Cell => ({ t, tone, solid: true });
export const dim = (t: string): Cell => ({ t, tone: 'dim' });

export const kv = (title: string, rows: Array<[string, CellLike]>): KvWidget => ({ kind: 'kv', title, rows });
export const grid = (title: string, cols: Array<[string, number]>, rows: CellLike[][]): GridWidget => ({ kind: 'grid', title, cols, rows });

export const bitsPanel = (title: string, value: number, width: number, segs: BitsWidget['segs'], caption?: string, cellWidth?: number): BitsWidget => ({ kind: 'bits', title, value, width, segs, caption, cell: cellWidth });

export const hx = (value: number): string => hex32(value);
/** 十六进制后面带上有符号十进制。 */
export const dec = (value: number): string => String(value | 0);

/** 指令字的位图，按格式分段上色。 */
export function instructionBits(word: number, title: string, cellWidth = 15, caption?: string): BitsWidget {
  const d = decode(word);
  return bitsPanel(title, word, 32, segmentsOf(d).map((seg) => ({ name: seg.name, short: seg.immHi !== undefined && seg.immHi === seg.immLo ? String(seg.immHi) : undefined, hi: seg.hi, lo: seg.lo, tone: segTone(seg.kind) })), caption, cellWidth);
}

export function floatBits(bits: number, title: string, caption?: string, cellWidth = 12): BitsWidget {
  return bitsPanel(title, bits, 32, [
    { name: 'S', hi: 31, lo: 31, tone: 'violet' },
    { name: '阶码 E', hi: 30, lo: 23, tone: 'amber' },
    { name: '尾数 F', hi: 22, lo: 0, tone: 'teal' },
  ], caption, cellWidth);
}

export function addressBits(address: number, parts: AddressParts, title: string, cellWidth = 13): BitsWidget {
  return bitsPanel(title, address, 32, [
    { name: `标记 tag = 0x${parts.tag.toString(16)}`, hi: 31, lo: parts.indexBits + parts.offsetBits, tone: 'violet' },
    { name: 'index', hi: parts.indexBits + parts.offsetBits - 1, lo: parts.offsetBits, tone: 'amber' },
    { name: 'offset', hi: parts.offsetBits - 1, lo: 0, tone: 'teal' },
  ], `${hx(address)}：组 ${parts.index}，块内第 ${parts.offset} 字节`, cellWidth);
}

export const fieldsCaption = (bits: number): string => {
  const f = fieldsOf(bits);
  return `S=${f.sign}  E=${f.exponent}  F=0x${f.fraction.toString(16)}  ${hx(bits)}`;
};

/** 寄存器堆的一小段。changed 里的寄存器高亮。 */
export function regsPanel(title: string, regs: ArrayLike<number>, list: number[], changed: number[] = [], width = 96): GridWidget {
  return grid(title, [['寄存器', 52], ['值', width]], list.map((reg) => [changed.includes(reg) ? on(`x${reg}`, 'green') : `x${reg}`, changed.includes(reg) ? cell(hx(regs[reg]), 'green') : hx(regs[reg])]));
}

const STAGE_TONE: Record<StageName, Tone> = { IF: 'teal', ID: 'blue', EX: 'amber', MEM: 'green', WB: 'violet' };

/** 经典流水线图：行是动态指令，列是周期，只画到 upTo 拍。 */
export function gantt(result: PipelineResult, upTo: number, options: { title?: string; first?: number; last?: number; textWidth?: number; cellWidth?: number; maxRows?: number } = {}): GridWidget {
  const { title = '流水线图', first = 1, last = result.cycles.length, textWidth = 104, cellWidth = 31 } = options;
  const cols: Array<[string, number]> = [['指令', textWidth]];
  for (let cycle = first; cycle <= last; cycle++) cols.push([String(cycle), cellWidth]);
  const rows = result.instructions
    .filter((item) => Object.keys(item.timeline).some((key) => Number(key) >= first && Number(key) <= last))
    .slice(0, options.maxRows ?? Infinity)
    .map((item) => {
      const cells: CellLike[] = [item.flushed && Object.keys(item.timeline).some((key) => Number(key) <= upTo && result.cycles[Number(key) - 1].flushed.some((f) => f.seq === item.seq)) ? cell(item.text, 'red') : item.text];
      for (let c = first; c <= last; c++) {
        const stage = c <= upTo ? item.timeline[c] : undefined;
        if (!stage) cells.push('');
        else if (stage === 'STALL-ID') cells.push(on('ID', 'red'));
        else if (stage === 'STALL-IF') cells.push(on('IF', 'red'));
        else cells.push(on(stage, c === upTo ? STAGE_TONE[stage] : 'slate'));
      }
      return cells;
    });
  return grid(title, cols, rows);
}

/** 每一级当前的指令和这一拍的值。 */
export function stagePanel(snap: CycleSnapshot | null, stage: StageName, pending = false): KvWidget {
  const view = snap?.stages[stage];
  const title = `${stage} 级`;
  if (!view) return kv(title, [['指令', dim('空泡')], ['值', dim('—')]]);
  let value: CellLike = dim('—');
  if (stage === 'IF') value = `PC=${hx(view.pc)}`;
  if (stage === 'ID') value = snap?.stall ? on('停顿', 'red') : snap?.id ? `rs1=${hx(snap.id.rs1Value)}` : dim('—');
  if (stage === 'EX' && snap?.ex) value = pending ? dim('计算中') : `Y=${hx(snap.ex.result)}`;
  if (stage === 'MEM') value = snap?.mem ? `${snap.mem.write ? '写' : '读'} [${hx(snap.mem.address)}]` : dim('不访问');
  if (stage === 'WB') value = snap?.wb ? `x${snap.wb.rd}=${hx(snap.wb.value)}` : dim('不写');
  return kv(title, [['指令', view.text], ['值', value]]);
}

export const STAGE_NODES: Record<StageName, 'sif' | 'sid' | 'sex' | 'smem' | 'swb'> = { IF: 'sif', ID: 'sid', EX: 'sex', MEM: 'smem', WB: 'swb' };

/** pending 为真时是这一拍刚开始：指令已经各就各位，EX 的结果还没算出来。 */
export function stagePanels(snap: CycleSnapshot | null, pending = false): Record<string, PanelContent> {
  const out: Record<string, PanelContent> = {};
  for (const stage of ['IF', 'ID', 'EX', 'MEM', 'WB'] as StageName[]) out[STAGE_NODES[stage]] = stagePanel(snap, stage, pending);
  return out;
}

const dataText = (line: CacheLine, from = 0, count = 4) => line.data.slice(from, from + count).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');

export interface CacheHighlight {
  set?: number;
  way?: number | null;
  tone?: Tone;
}

/** 缓存的组、路、有效位、标记、LRU 和块内前 4 字节，高亮刚用到的一路。 */
export function cachePanel(title: string, lines: CacheLine[][], hl: CacheHighlight = {}, options: { dirty?: boolean; lruOrder?: boolean } = {}): GridWidget {
  const { dirty = false } = options;
  const cols: Array<[string, number]> = [['组', 26], ['路', 26], ['V', 22]];
  if (dirty) cols.push(['D', 22]);
  cols.push(['标记', 62], ['LRU', 34], ['块内前 4 字节', 92]);
  const rows: CellLike[][] = [];
  lines.forEach((set, index) => {
    const newest = Math.max(...set.map((line) => line.used));
    set.forEach((line, way) => {
      const active = hl.set === index && hl.way === way;
      const tone = hl.tone ?? 'green';
      const row: CellLike[] = [String(index), active ? on(String(way), tone) : String(way), line.valid ? cell('1', active ? tone : undefined) : dim('0')];
      if (dirty) row.push(line.dirty ? on('1', 'amber') : dim('0'));
      row.push(line.valid ? cell(`0x${line.tag.toString(16)}`, active ? tone : undefined) : dim('—'));
      row.push(!line.valid ? dim('—') : set.filter((other) => other.valid).length < 2 || line.used === newest ? dim('新') : cell('旧', 'amber'));
      row.push(line.valid ? cell(dataText(line), active ? tone : undefined) : dim('—'));
      rows.push(row);
    });
  });
  return grid(title, cols, rows);
}
