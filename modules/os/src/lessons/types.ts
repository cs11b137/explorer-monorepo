import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

export const NODE_IDS = [
  'app', 'proc2', 'kernel', 'k2', 'cpu', 'cpu2', 'apic', 'device',
  'mmu', 'pml4', 'pdpt', 'pd', 'pt', 'ram', 'disk',
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表 TYPE 列的取值。 */
export type TraceType =
  | 'SYSCALL' | 'SYSRET' | 'EXC' | 'IRQ' | 'IPI' | 'MMIO' | 'MSR'
  | 'MEM' | 'DMA' | 'BIO' | 'SCHED' | 'SW';


export interface Row {
  /** 该课时间线上的纳秒数，只表示量级。 */
  tNs: number;
  type: TraceType;
  info: string;
  /** 数字是字节数，'reg' 是只涉及寄存器，null 表示没有数据传输。 */
  size: number | 'reg' | null;
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
  /** 特权或带 lock 前缀的操作，标签上显示锁形图标。 */
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
  | { type: 'state'; node: NodeId; set: Record<string, string | null> };

export interface Step {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: LessonEvent[];
}

export type LessonGroup = 'process' | 'memory' | 'io';
export type DeviceArt = 'keyboard' | 'firmware';

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
  deviceArt?: DeviceArt;
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
  if (size === 'reg') return '寄存器';
  if (size === null) return '—';
  if (size >= 1024 * 1024) return `${+(size / 1024 / 1024).toFixed(1)} MiB`;
  if (size >= 1024) return `${+(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

export const foldStates = (events: LessonEvent[], end: number) => engineFoldStates<NodeId>(events, end);
