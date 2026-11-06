import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';
import type { BoardSpec } from '../scene/board-types';

export const NODE_IDS = [
  'client', 'client2', 'backend', 'backend2', 'backend3', 'parser', 'catalog', 'planner', 'executor',
  'buffer', 'heap', 'heap2', 'btree', 'wal', 'disk', 'lock', 'bgwriter', 'clog', 'temp', 'vacuum', 'startup',
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'MSG' | 'PARSE' | 'PLAN' | 'SCAN' | 'PAGE' | 'BUF' | 'IO' | 'LOCK'
  | 'WAL' | 'FSYNC' | 'XACT' | 'HASH' | 'SORT' | 'VAC' | 'REDO'
  | 'MEM' | 'SST' | 'GET' | 'MERGE';


export interface Row {
  /** 该课时间线上的纳秒数，只是量级示例，界面上标 E.G.。 */
  tNs: number;
  type: TraceType;
  info: string;
  /** 字节数；null 表示这一步不传输数据。 */
  size: number | null;
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
  /** 只用于真实的故障和崩溃：事件在半路中止并显示叉号。 */
  lost?: boolean;
  /** 持有或等待锁的操作，标签上显示锁形图标。 */
  locked?: boolean;
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
  | { type: 'focus'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'show'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'camera'; frame?: NodeId[] }
  | { type: 'type'; text: string }
  | { type: 'render' }
  | { type: 'note'; at: NodeId; text: string; tone?: 'navy' | 'green' | 'amber' }
  | { type: 'state'; node: NodeId; set: Record<string, string | null> }
  /** 更新一块结构板。和 state 一样按事件序列折叠，所以前进、后退、跳步都能重算。 */
  | { type: 'board'; id: string; spec: BoardSpec };

export interface Step {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: LessonEvent[];
}

export type LessonGroup = 'query' | 'storage' | 'txn';

export interface BoardSlot {
  /** 结构板在场景里的矩形：x, y, 宽, 高。 */
  rect: [number, number, number, number];
  /** 播放前（概览）显示的内容。 */
  initial: BoardSpec;
}

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 主要涉及的系统层级，取 1–7 的闭区间。 */
  layer: [number, number];
  timeUnit: 'ns' | 'µs' | 'ms' | 's';
  nodes: NodeId[];
  /** 每个节点在该课场景里的位置。按课指定，避免通道穿过设备。 */
  place: Partial<Record<NodeId, [number, number]>>;
  labels: Partial<Record<NodeId, [string, string]>>;
  boards: Record<string, BoardSlot>;
  start: NodeId[];
  legend: Array<[Color | null, string]>;
  overview: { full: string; description: string; facts: Fact[] };
  steps: Step[];
  outro: { title: string; desc: string; text: string; facts: Fact[] };
}

export type Timed = LessonEvent & { step: number };

export { labelOf, packetsOf };


export function formatTime(tNs: number, unit: Lesson['timeUnit']): string {
  if (unit === 'ns') return `${tNs.toLocaleString('en-US')} ns`;
  if (unit === 'µs') return `${(tNs / 1e3).toFixed(3)} µs`;
  if (unit === 'ms') return `${(tNs / 1e6).toFixed(3)} ms`;
  return `${(tNs / 1e9).toFixed(3)} s`;
}

export function formatSize(size: Row['size']): string {
  if (size === null) return '—';
  if (size >= 1024 * 1024) return `${+(size / 1024 / 1024).toFixed(1)} MiB`;
  if (size >= 1024) return `${+(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

/** 把 board 事件从头折叠到第 end 个事件，得到每块结构板当时的内容。 */
export function foldBoards(lesson: Lesson, events: LessonEvent[], end: number): { specs: Map<string, BoardSpec>; latest: string | null } {
  const specs = new Map<string, BoardSpec>(Object.entries(lesson.boards).map(([id, slot]) => [id, slot.initial]));
  let latest: string | null = null;
  for (const event of events.slice(0, end)) {
    if (event.type !== 'board') continue;
    specs.set(event.id, event.spec);
    latest = event.id;
  }
  return { specs, latest };
}

export const foldStates = (events: LessonEvent[], end: number) => engineFoldStates<NodeId>(events, end);
