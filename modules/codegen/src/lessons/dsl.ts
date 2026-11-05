import type { Wire } from '../decode/writer';
import type { ArtUpdate, Color, Lesson, LessonEvent, NodeId, PacketEvent, Row } from './types';
import { packetsOf } from './types';

type RowTuple = [phase: number, type: Row['type'], info: string, size: Row['size']];

export interface PacketExtra {
  lost?: boolean;
  quick?: boolean;
  art?: ArtUpdate;
}

/** 课程里最常用的事件写法：谁到谁、什么颜色、标签、卡片内容、轨迹行、解码结构。 */
export function pk(from: NodeId, to: NodeId, color: Color, label: string, payload: string[], [phase, type, info, size]: RowTuple, wire: Wire, extra: PacketExtra = {}): PacketEvent {
  return { type: 'packet', from, to, color, label, payload, row: { phase, count: 0, type, info, size }, wire, ...extra };
}

export const note = (at: NodeId, text: string, tone: 'navy' | 'green' | 'amber' = 'navy'): LessonEvent => ({ type: 'note', at, text, tone });
export const art = (set: ArtUpdate): LessonEvent => ({ type: 'art', set });
export const show = (...nodes: NodeId[]): LessonEvent => ({ type: 'show', nodes });

/** 课程写完后调用：按顺序给每个事件编上「阶段计数」。 */
export function seal(lesson: Lesson): Lesson {
  const counts = new Map<number, number>();
  for (const packet of packetsOf(lesson)) {
    const next = (counts.get(packet.row.phase) ?? 0) + 1;
    counts.set(packet.row.phase, next);
    packet.row.count = next;
  }
  return lesson;
}
