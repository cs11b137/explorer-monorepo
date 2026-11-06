import type { Wire } from '../decode/writer';
import type { Color, DsFrame, LessonEvent, NodeId, PacketEvent, Row } from './types';

type RowTuple = [tokens: number, type: Row['type'], info: string, size: Row['size']];

export interface PacketExtra {
  lost?: boolean;
  locked?: boolean;
  quick?: boolean;
  ds?: DsFrame;
  fromAt?: [number, number];
  toAt?: [number, number];
}

/** 课程里最常用的事件写法：谁到谁、什么颜色、标签、卡片内容、轨迹行（累计输入 token、类型、说明、字节数）、解码结构。 */
export function pk(from: NodeId, to: NodeId, color: Color, label: string, payload: string[], [tokens, type, info, size]: RowTuple, wire: Wire, extra: PacketExtra = {}): PacketEvent {
  return { type: 'packet', from, to, color, label, payload, row: { tokens, type, info, size }, wire, ...extra };
}

export const note = (at: NodeId, text: string, tone: 'navy' | 'green' | 'amber' = 'navy'): LessonEvent => ({ type: 'note', at, text, tone });
export const state = (node: NodeId, set: Record<string, string | null>): LessonEvent => ({ type: 'state', node, set });
export const show = (...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes });
export const showIn = (frame: NodeId[], ...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes, frame });
export const camera = (...frame: NodeId[]): LessonEvent => ({ type: 'camera', frame: frame.length ? frame : undefined });
export const type = (text: string): LessonEvent => ({ type: 'type', text });
export const render: LessonEvent = { type: 'render' };
export const ds = (frame: DsFrame): LessonEvent => ({ type: 'ds', frame });
