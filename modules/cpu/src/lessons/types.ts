import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';
import type { PanelContent } from '../scene/widgets';

export const NODE_IDS = [
  'pc', 'imem', 'decoder', 'immgen', 'regfile', 'alu', 'control', 'dmem',
  'rega', 'regb', 'regy', 'adder', 'shifter', 'multiplier', 'flags', 'norm',
  'sif', 'sid', 'sex', 'smem', 'swb', 'hazard', 'predictor',
  'core0', 'core1', 'cache', 'cache1', 'bus', 'memctrl', 'dram', 'bank', 'dma', 'device', 'asm',
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'FETCH' | 'DECODE' | 'EXEC' | 'MEM' | 'WB' | 'FWD' | 'STALL' | 'FLUSH'
  | 'HIT' | 'MISS' | 'BUS' | 'CTRL' | 'CMD' | 'DATA' | 'IRQ' | 'ENC' | 'CALC';


/** 'reg' 只涉及寄存器，'sig' 是控制信号，数字是字节数，`${n}b` 是位数，null 没有数据。 */
export type RowSize = number | 'reg' | 'sig' | `${number}b` | null;

export interface Row {
  /** 周期号。含义由课程的 clock 决定，见 formatCycle。 */
  cycle: number;
  /** 同一课里有两次独立运行时的标记（如「静态」「预测」）。各次运行各自从头计周期。 */
  run?: string;
  type: TraceType;
  info: string;
  size: RowSize;
}

export interface PacketEvent {
  type: 'packet';
  from: NodeId;
  to: NodeId;
  color: Color;
  label: string;
  payload: string[];
  row: Row;
  wire: Wire;
  /** 只用于被冲掉或中止的事件：在半路停下并显示叉号。 */
  lost?: boolean;
  /** 总线独占之类的操作，标签上显示锁形图标。 */
  locked?: boolean;
  quick?: boolean;
}

export interface StreamEvent {
  type: 'stream';
  packets: PacketEvent[];
  spacing?: number;
}

/**
 * 更新结构图里的数值面板。面板内容整块替换，值为 null 时移除。
 * 和 state 一样由事件序列折叠得到，所以前进、后退、跳步都能重算出同样的画面。
 */
export interface ProbeEvent {
  type: 'probe';
  set: Record<string, PanelContent | null>;
  /** 这一帧至少停留多少毫秒，让人看清逐位变化。 */
  hold?: number;
}

export type LessonEvent =
  | PacketEvent
  | StreamEvent
  | ProbeEvent
  | { type: 'focus'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'show'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'camera'; frame?: NodeId[] }
  | { type: 'type'; text: string }
  | { type: 'note'; at: NodeId; text: string; tone?: 'navy' | 'green' | 'amber' }
  | { type: 'state'; node: NodeId; set: Record<string, string | null> };

export interface Step {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: LessonEvent[];
}

export type LessonGroup = 'data' | 'cpu' | 'memio';

/** 「周期」列的单位：真实时钟周期、内存时钟、门延迟，或不计时的运算步骤。 */
export type ClockUnit = 'cycle' | 'nck' | 'gate' | 'step';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 主要涉及的抽象层级，取 1–7 的闭区间。 */
  layer: [number, number];
  clock: ClockUnit;
  nodes: NodeId[];
  /** 每个节点在该课场景里的位置。按课指定，避免通道穿过设备。 */
  place: Partial<Record<NodeId, [number, number]>>;
  labels: Partial<Record<NodeId, [string, string]>>;
  /** 数值面板左上角的位置。面板 id 通常是节点 id；节点隐藏时面板也隐藏。 */
  panels: Record<string, [number, number]>;
  /** 播放前结构图里就显示的初始值。 */
  initial: Record<string, PanelContent>;
  /** 这节课的主面板（流水线图、真值表、缓存表等）。窄面板时必须不滚动就能完整看到。 */
  main: string[];
  /** 窄面板时读数区的排法：字符串是单独一块，数组是压成一行。没列出的排在后面。 */
  strip: Array<string | string[]>;
  start: NodeId[];
  legend: Array<[Color | null, string]>;
  overview: { full: string; description: string; facts: Fact[] };
  steps: Step[];
  outro: { title: string; desc: string; text: string; facts: Fact[] };
}

export type Timed = LessonEvent & { step: number };

export { labelOf, packetsOf };


export function formatCycle(cycle: number, clock: ClockUnit, run?: string): string {
  const prefix = run ? `${run} · ` : '';
  if (clock === 'gate') return `${prefix}${cycle} 门延迟`;
  if (clock === 'step') return `${prefix}第 ${cycle} 步`;
  if (clock === 'nck') return `${prefix}${cycle.toLocaleString('en-US')} nCK`;
  return `${prefix}${cycle.toLocaleString('en-US')}`;
}

export function formatSize(size: RowSize): string {
  if (size === 'reg') return '寄存器';
  if (size === 'sig') return '信号';
  if (size === null) return '—';
  if (typeof size === 'string') return `${size.slice(0, -1)} 位`;
  if (size >= 1024 * 1024) return `${+(size / 1024 / 1024).toFixed(1)} MiB`;
  if (size >= 1024) return `${+(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

export const foldStates = (events: LessonEvent[], end: number) => engineFoldStates<NodeId>(events, end);

/** 从 initial 开始把 probe 事件折叠到第 end 个事件，得到当时每块数值面板的内容。 */
export function foldProbes(initial: Record<string, PanelContent>, events: LessonEvent[], end: number): Map<string, PanelContent> {
  const panels = new Map<string, PanelContent>(Object.entries(initial));
  for (const event of events.slice(0, end)) {
    if (event.type !== 'probe') continue;
    for (const [key, value] of Object.entries(event.set)) {
      if (value === null) panels.delete(key);
      else panels.set(key, value);
    }
  }
  return panels;
}
