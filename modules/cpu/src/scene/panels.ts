import { timeline } from '../core/player';
import type { Lesson } from '../lessons/types';
import { panelSize, type PanelContent } from './widgets';

export interface PanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 每块面板在整节课里内容不一样，取最大尺寸作为占位，这样布局不会跳。 */
export function panelBoxes(lesson: Lesson): Map<string, PanelBox> {
  const sizes = new Map<string, { width: number; height: number }>();
  const grow = (id: string, content: PanelContent) => {
    const size = panelSize(content);
    const before = sizes.get(id) ?? { width: 0, height: 0 };
    sizes.set(id, { width: Math.max(before.width, size.width), height: Math.max(before.height, size.height) });
  };
  for (const [id, content] of Object.entries(lesson.initial)) grow(id, content);
  for (const event of timeline(lesson)) {
    if (event.type !== 'probe') continue;
    for (const [id, content] of Object.entries(event.set)) if (content) grow(id, content);
  }
  const boxes = new Map<string, PanelBox>();
  for (const [id, size] of sizes) {
    const at = lesson.panels[id];
    if (!at) throw new Error(`${lesson.id}: 面板 ${id} 没有位置`);
    boxes.set(id, { x: at[0], y: at[1], ...size });
  }
  return boxes;
}
