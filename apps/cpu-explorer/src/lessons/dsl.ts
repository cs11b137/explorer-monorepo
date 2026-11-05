import type { Wire } from '../decode/writer';
import type { PanelContent } from '../scene/widgets';
import type { Color, LessonEvent, NodeId, PacketEvent, Row } from './types';

type RowTuple = [cycle: number, type: Row['type'], info: string, size: Row['size'], run?: string];

export interface PacketExtra {
  lost?: boolean;
  locked?: boolean;
  quick?: boolean;
}

/** 课程里最常用的事件写法：谁到谁、什么颜色、标签、卡片内容、轨迹行、解码结构。 */
export function pk(from: NodeId, to: NodeId, color: Color, label: string, payload: string[], [cycle, type, info, size, run]: RowTuple, wire: Wire, extra: PacketExtra = {}): PacketEvent {
  return { type: 'packet', from, to, color, label, payload, row: { cycle, type, info, size, ...(run ? { run } : {}) }, wire, ...extra };
}

export const note = (at: NodeId, text: string, tone: 'navy' | 'green' | 'amber' = 'navy'): LessonEvent => ({ type: 'note', at, text, tone });
export const state = (node: NodeId, set: Record<string, string | null>): LessonEvent => ({ type: 'state', node, set });
export const show = (...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes });
export const showIn = (frame: NodeId[], ...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes, frame });
export const camera = (...frame: NodeId[]): LessonEvent => ({ type: 'camera', frame: frame.length ? frame : undefined });
export const type = (text: string): LessonEvent => ({ type: 'type', text });
/** 更新数值面板。hold 是这一帧的停留毫秒数。 */
export const probe = (set: Record<string, PanelContent | null>, hold?: number): LessonEvent => ({ type: 'probe', set, hold });
