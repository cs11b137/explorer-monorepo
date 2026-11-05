import { labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';
import type { ArtView } from '../scene/art';

/** 编译流水线上的阶段和产物。每课取其中几个。 */
export const NODE_IDS = [
  'source', 'lexer', 'tokens', 'parser', 'tree', 'lrtable', 'symtab', 'irgen', 'ir', 'cfg',
  'ssa', 'optimizer', 'isel', 'regalloc', 'frame', 'encoder', 'object', 'linker', 'image',
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'CHAR' | 'TOKEN' | 'CALL' | 'NODE' | 'SHIFT' | 'REDUCE' | 'TABLE' | 'SCOPE' | 'SYM' | 'TYPE' | 'ERROR'
  | 'IR' | 'CFG' | 'LIVE' | 'DOM' | 'PHI' | 'PASS' | 'ISEL' | 'REG' | 'SPILL' | 'FRAME' | 'ENCODE' | 'ELF' | 'RELOC' | 'LINK';


/** 编译阶段，对应顶栏的 7 档。 */
export const PHASES = ['词法', '语法', '语义', '中间码', '优化', '目标码', '链接'] as const;

export interface Row {
  /** 所属编译阶段，1–7。 */
  phase: number;
  /** 这一阶段在本课里的第几个动作，由 seal 按顺序编号。 */
  count: number;
  type: TraceType;
  info: string;
  /** 数字是字节数，'reg' 是只涉及寄存器，null 表示这一步没有字节产物。 */
  size: number | 'reg' | null;
}

export type ArtUpdate = Record<string, ArtView | null>;

export interface PacketEvent {
  type: 'packet';
  from: NodeId;
  to: NodeId;
  color: Color;
  label: string;
  payload: string[];
  row: Row;
  wire: Wire;
  /** 事件到达时更新哪些产物面板。第一个键是这一刻的主角，窄屏时相机跟着它。 */
  art?: ArtUpdate;
  /** 只用于真实的编译错误：事件在半路中止并显示叉号。 */
  lost?: boolean;
  quick?: boolean;
}

export interface StreamEvent {
  type: 'stream';
  packets: PacketEvent[];
  spacing?: number;
}

export type LessonEvent =
  | PacketEvent
  | StreamEvent
  | { type: 'focus'; nodes: NodeId[] }
  | { type: 'show'; nodes: NodeId[] }
  | { type: 'note'; at: NodeId; text: string; tone?: 'navy' | 'green' | 'amber' }
  | { type: 'art'; set: ArtUpdate };

export interface Step {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: LessonEvent[];
}

export type LessonGroup = 'front' | 'middle' | 'back';

/** 产物面板在场景里的矩形：x、y、宽、高。 */
export type PanelRect = [x: number, y: number, w: number, h: number];

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 主要涉及的编译阶段，取 1–7 的闭区间。 */
  layer: [number, number];
  nodes: NodeId[];
  /** 每个节点在该课场景里的位置。按课指定，避免通道穿过设备。 */
  place: Partial<Record<NodeId, [number, number]>>;
  labels: Partial<Record<NodeId, [string, string]>>;
  panels: Record<string, PanelRect>;
  /** 开始播放时每个面板显示什么。没有的面板要等事件填入。 */
  initial: Record<string, ArtView>;
  start: NodeId[];
  legend: Array<[Color | null, string]>;
  overview: { full: string; description: string; facts: Fact[] };
  steps: Step[];
  outro: { title: string; desc: string; text: string; facts: Fact[] };
}

export type Timed = LessonEvent & { step: number };

export { labelOf, packetsOf };


export const formatCount = (row: Pick<Row, 'phase' | 'count'>): string => `${PHASES[row.phase - 1]} #${row.count}`;

export function formatSize(size: Row['size']): string {
  if (size === 'reg') return '寄存器';
  if (size === null) return '—';
  if (size >= 1024) return `${+(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

const updatesOf = (event: LessonEvent): ArtUpdate[] => {
  if (event.type === 'art') return [event.set];
  if (event.type === 'packet') return event.art ? [event.art] : [];
  if (event.type === 'stream') return event.packets.flatMap((packet) => (packet.art ? [packet.art] : []));
  return [];
};

/** 把产物更新从头折叠到第 end 个事件。后退和跳步都走这里，所以不会残留后面的状态。 */
export function foldArts(events: LessonEvent[], end: number, initial: Record<string, ArtView>): Map<string, ArtView> {
  const panels = new Map<string, ArtView>(Object.entries(initial));
  for (const event of events.slice(0, end)) {
    for (const update of updatesOf(event)) {
      for (const [slot, view] of Object.entries(update)) {
        if (view === null) panels.delete(slot);
        else panels.set(slot, view);
      }
    }
  }
  return panels;
}

/** 第 end 个事件之前最后更新的面板：窄屏时相机对准它。 */
export function focusSlot(events: LessonEvent[], end: number, fallback: string): string {
  for (let index = Math.min(end, events.length) - 1; index >= 0; index--) {
    const updates = updatesOf(events[index]);
    for (let at = updates.length - 1; at >= 0; at--) {
      const key = Object.keys(updates[at]).find((slot) => updates[at][slot] !== null);
      if (key) return key;
    }
  }
  return fallback;
}
