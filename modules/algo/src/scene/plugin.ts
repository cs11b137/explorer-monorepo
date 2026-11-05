import { clock, type Ctl } from '@explorer/engine/core/clock';
import { svgEl } from '@explorer/engine/core/dom';
import type { StageApi, StagePlugin } from '@explorer/engine/scene/stage';
import { foldDs, NODE_IDS, type Lesson, type LessonEvent, type NodeId, type Prim } from '../lessons/types';
import { hasArt, NODE_SPECS } from './devices';
import { itemsOf, lessonBounds, type Box, type Item } from './ds';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** 数据结构当前画出来的条目，按节点分组，靠 key 在帧之间对应。 */
interface LiveItem {
  outer: SVGGElement;
  inner: SVGGElement;
  item: Item;
}

/** 数据结构图元：节点的形态就是当前的数据结构，条目按 key 在帧之间移动。 */
export function dsPlugin(api: StageApi<Lesson>): StagePlugin<Lesson> {
  const { nodeEls, bodyEls } = api;
  const dsEls = Object.fromEntries(NODE_IDS.map((id) => [id, nodeEls[id].querySelector<SVGGElement>('.ds')!])) as Record<NodeId, SVGGElement>;
  const dsLive = new Map<NodeId, Map<string, LiveItem>>();
  const dsCtl = new Map<NodeId, Ctl>();
  const dsMemo = new Map<NodeId, string>();
  let dsBounds: Partial<Record<NodeId, Box>> = {};
  let lesson: Lesson | null = null;
  let events: LessonEvent[] = [];

  /** 把一个节点的数据结构更新到新的一帧：同 key 的条目移动，新条目淡入，消失的条目移除。 */
  function drawDs(id: NodeId, prims: Prim[] | undefined): void {
    const live = dsLive.get(id) ?? new Map<string, LiveItem>();
    dsLive.set(id, live);
    const previous = dsCtl.get(id);
    if (previous) previous.cancelled = true;
    const ctl: Ctl = { cancelled: false };
    dsCtl.set(id, ctl);
    const animate = live.size > 0;
    const items = itemsOf(prims);
    const keep = new Set(items.map((item) => item.key));
    for (const [key, entry] of live) {
      if (keep.has(key)) continue;
      entry.outer.remove();
      live.delete(key);
    }
    const moves: Array<() => void> = [];
    for (const item of items) {
      let entry = live.get(item.key);
      if (!entry) {
        const outer = svgEl('g', { class: 'ds-item', 'data-key': item.key, transform: `translate(${item.x.toFixed(1)} ${item.y.toFixed(1)})` });
        const inner = svgEl('g', {}, outer);
        inner.innerHTML = item.html;
        entry = { outer, inner, item };
        live.set(item.key, entry);
        if (animate) {
          const fresh = entry;
          fresh.inner.style.opacity = '0';
          moves.push(() => void clock.tween(280, ctl, (t) => (fresh.inner.style.opacity = t >= 1 ? '' : String(t))).then(() => (fresh.inner.style.opacity = '')));
        }
      } else {
        const before = entry.item;
        const current = entry;
        current.inner.removeAttribute('transform');
        current.inner.style.opacity = '';
        if (before.html !== item.html) current.inner.innerHTML = item.html;
        current.outer.setAttribute('transform', `translate(${item.x.toFixed(1)} ${item.y.toFixed(1)})`);
        const dx = before.x - item.x;
        const dy = before.y - item.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          const arc = Math.min(26, Math.hypot(dx, dy) * 0.22);
          current.inner.setAttribute('transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
          moves.push(() => void clock.tween(440, ctl, (t) => {
            const eased = easeInOut(t);
            const left = 1 - eased;
            current.inner.setAttribute('transform', t >= 1 ? '' : `translate(${(dx * left).toFixed(1)} ${(dy * left - arc * Math.sin(Math.PI * eased)).toFixed(1)})`);
          }));
        }
        const fromLine = before.line;
        const toLine = item.line;
        if (fromLine && toLine && fromLine.some((value, index) => Math.abs(value - toLine[index]) > 0.5)) {
          const edge = current.inner.querySelector('line');
          if (edge) {
            moves.push(() => void clock.tween(440, ctl, (t) => {
              const eased = easeInOut(t);
              (['x1', 'y1', 'x2', 'y2'] as const).forEach((name, index) => edge.setAttribute(name, (fromLine[index] + (toLine[index] - fromLine[index]) * eased).toFixed(1)));
            }));
          }
        }
        current.item = item;
      }
    }
    // 按深度重排，让前面的格子盖住后面的。appendChild 对已在正确位置的元素也安全。
    const parent = dsEls[id];
    for (const item of items) parent.appendChild(live.get(item.key)!.outer);
    moves.forEach((start) => start());
  }

  function renderDs(end: number): void {
    if (!lesson) return;
    const frame = foldDs(lesson.initial, events, end);
    for (const id of api.nodes() as readonly NodeId[]) {
      const memo = JSON.stringify(frame[id] ?? []);
      if (dsMemo.get(id) === memo) continue;
      dsMemo.set(id, memo);
      drawDs(id, frame[id]);
    }
  }

  function clearDs(): void {
    for (const ctl of dsCtl.values()) ctl.cancelled = true;
    dsCtl.clear();
    dsLive.clear();
    dsMemo.clear();
    for (const id of NODE_IDS) dsEls[id].replaceChildren();
  }

  return {
    radiusOf: (id) => lesson?.radius?.[id as NodeId] ?? NODE_SPECS[id as NodeId].radius,
    labelPoint: (id) => lesson?.labelAt?.[id as NodeId] ?? [0, NODE_SPECS[id as NodeId].labelY],
    /** 节点在场景里占的范围（相对节点中心）。数据节点取整节课的最大范围，再并上名称。 */
    bodyBox(raw) {
      const id = raw as NodeId;
      const data = dsBounds[id];
      if (!data || hasArt(id)) return bodyEls[id].getBBox();
      const label = nodeEls[id].querySelector<SVGGElement>('.node-label')!.getBBox();
      const grow = (api.labelScale() - 1) / 2;
      const left = Math.min(data[0], label.x - label.width * grow);
      const top = Math.min(data[1], label.y - label.height * grow);
      const right = Math.max(data[2], label.x + label.width * (1 + grow));
      const bottom = Math.max(data[3], label.y + label.height * (1 + grow));
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
    canBump: (id) => hasArt(id as NodeId),
    load(next, timeline) {
      lesson = next;
      events = timeline as LessonEvent[];
      clearDs();
      dsBounds = lessonBounds(next.initial, events as Parameters<typeof lessonBounds>[1]);
      renderDs(0);
    },
    render: renderDs,
  };
}
