import type { Wire } from '../decode/writer';
import type { BoardSpec } from '../scene/board-types';
import type { Color, LessonEvent, NodeId, PacketEvent, Row } from './types';

type RowTuple = [tNs: number, type: Row['type'], info: string, size: Row['size']];

export interface PacketExtra {
  lost?: boolean;
  locked?: boolean;
  quick?: boolean;
}

/** 课程里最常用的事件写法：谁到谁、什么颜色、标签、卡片内容、轨迹行、解码结构。 */
export function pk(from: NodeId, to: NodeId, color: Color, label: string, payload: string[], [tNs, type, info, size]: RowTuple, wire: Wire, extra: PacketExtra = {}): PacketEvent {
  return { type: 'packet', from, to, color, label, payload, row: { tNs, type, info, size }, wire, ...extra };
}

export const note = (at: NodeId, text: string, tone: 'navy' | 'green' | 'amber' = 'navy'): LessonEvent => ({ type: 'note', at, text, tone });
export const state = (node: NodeId, set: Record<string, string | null>): LessonEvent => ({ type: 'state', node, set });
export const show = (...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes });
export const showIn = (frame: NodeId[], ...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes, frame });
export const camera = (...frame: NodeId[]): LessonEvent => ({ type: 'camera', frame: frame.length ? frame : undefined });
export const type = (text: string): LessonEvent => ({ type: 'type', text });
export const render: LessonEvent = { type: 'render' };
export const board = (id: string, spec: BoardSpec): LessonEvent => ({ type: 'board', id, spec });
