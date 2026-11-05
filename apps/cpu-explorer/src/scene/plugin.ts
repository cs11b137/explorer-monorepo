import { svgEl } from '@explorer/engine/core/dom';
import type { StageApi, StagePlugin } from '@explorer/engine/scene/stage';
import { foldProbes, NODE_IDS, type Lesson, type LessonEvent, type NodeId } from '../lessons/types';
import { panelBoxes, type PanelBox } from './panels';
import { panelSvg, type PanelContent } from './widgets';

/** 面板窄于这个宽度时，数值面板移到结构图下方的读数区，否则字太小看不清。 */
const STRIP_BELOW = 640;

/** 数值面板：寄存器、流水线图、缓存表等。宽屏放在场景里，窄屏移到结构图下方。 */
export function widgetPlugin(api: StageApi<Lesson>): StagePlugin<Lesson> {
  const { svg } = api;
  const widgetLayer = svg.querySelector<SVGGElement>('.widget-layer')!;
  const stripEl = svg.parentElement!.querySelector<HTMLElement>('.state-strip')!;
  let lesson: Lesson | null = null;
  let events: LessonEvent[] = [];
  let boxes = new Map<string, PanelBox>();
  let stripMode = false;
  const widgetMemo = new Map<string, string>();
  let cellValues = new Map<string, string>();

  /** 窄面板把数值面板移到下方读数区，宽面板放回场景。 */
  function syncStrip(): void {
    const width = svg.parentElement!.getBoundingClientRect().width;
    const next = width > 0 && width < STRIP_BELOW;
    if (next === stripMode) return;
    stripMode = next;
    svg.parentElement!.classList.toggle('is-strip', next);
  }

  /** 重画数值面板。内容由 initial 和 probe 事件折叠得到，变化的单元格会闪一下。 */
  function renderWidgets(end: number): void {
    if (!lesson) return;
    const content = foldProbes(lesson.initial, events, end);
    const values = new Map<string, string>();
    let changed: string | undefined;
    for (const id of Object.keys(lesson.panels)) {
      const panel = content.get(id);
      // 读数区里节点没出现的面板也占好位置，免得排版中途跳动。
      const hidden = !stripMode && NODE_IDS.includes(id as NodeId) && !api.visible().has(id);
      const memo = panel && !hidden ? JSON.stringify(panel) : '';
      if (widgetMemo.get(id) === memo) {
        for (const [key, value] of cellValues) if (key.startsWith(`${id}#`)) values.set(key, value);
        continue;
      }
      changed = id;
      widgetMemo.set(id, memo);
      widgetLayer.querySelector(`[data-widget="${id}"]`)?.remove();
      stripEl.querySelector(`[data-widget="${id}"]`)?.remove();
      if (!memo) continue;
      drawWidget(id, panel as PanelContent, values);
    }
    cellValues = values;
    if (stripMode && changed) orderStrip();
  }

  function drawWidget(id: string, content: PanelContent, values: Map<string, string>): void {
    const at = boxes.get(id);
    const { markup, width, height } = panelSvg(id, content, cellValues, values, at?.width);
    const shell = at ?? { width, height, x: 0, y: 0 };
    if (stripMode) {
      const holder = document.createElement('div');
      holder.className = 'strip-item';
      holder.dataset.widget = id;
      holder.style.setProperty('--w', String(Math.round(width)));
      // 高度取整节课的最大值，内容变化时读数区不跳动。
      holder.innerHTML = `<svg class="wg-svg" viewBox="-1 -1 ${width + 2} ${shell.height + 2}" role="img">${markup}</svg>`;
      stripEl.appendChild(holder);
      return;
    }
    const group = svgEl('g', { class: 'widget', 'data-widget': id, transform: `translate(${shell.x} ${shell.y})` }, widgetLayer);
    group.innerHTML = markup;
  }

  /** 读数区按课程声明的顺序排，主面板不随更新跳动。 */
  function orderStrip(): void {
    if (!lesson) return;
    stripEl.querySelectorAll<HTMLElement>('.strip-row').forEach((row) => {
      [...row.children].forEach((child) => stripEl.appendChild(child));
      row.remove();
    });
    const listed = lesson.strip.flat();
    for (const entry of lesson.strip) {
      if (typeof entry === 'string') {
        const item = stripEl.querySelector(`:scope > [data-widget="${entry}"]`);
        if (item) stripEl.appendChild(item);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'strip-row';
      stripEl.appendChild(row);
      for (const id of entry) {
        const item = stripEl.querySelector(`:scope > [data-widget="${id}"]`);
        if (item) row.appendChild(item);
      }
    }
    for (const id of Object.keys(lesson.panels)) {
      if (listed.includes(id)) continue;
      const item = stripEl.querySelector(`:scope > [data-widget="${id}"]`);
      if (item) stripEl.appendChild(item);
    }
    fitMain();
  }

  /** 面板内滚动时，主面板放不下就等比缩小，保证不滚动也能看全。 */
  function fitMain(): void {
    if (!lesson || !stripMode || document.documentElement.classList.contains('is-single')) return;
    for (const id of lesson.main) stripEl.querySelector<HTMLElement>(`[data-widget="${id}"]`)?.style.removeProperty('max-width');
    const limit = stripEl.getBoundingClientRect().bottom - 6;
    for (const id of lesson.main) {
      const item = stripEl.querySelector<HTMLElement>(`[data-widget="${id}"]`);
      if (!item || item.parentElement !== stripEl) continue;
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= limit || rect.height <= 0) continue;
      const keep = Math.max(0.55, (limit - rect.top) / rect.height);
      item.style.maxWidth = `${Math.floor(item.offsetWidth * keep)}px`;
    }
  }

  const clearWidgets = () => {
    widgetLayer.replaceChildren();
    stripEl.replaceChildren();
    widgetMemo.clear();
  };

  return {
    frameBoxes(target, list, rects) {
      // 输入框浮在节点上方，也要留出位置。
      if (lesson && events.some((event) => event.type === 'type')) {
        const [x, y] = api.placeOf(lesson.start[0]);
        rects.push({ x: x - 124, y: y - 140, w: 190, h: 34 });
      }
      // 宽屏时数值面板也在场景里，要一起框进画面。
      if (!stripMode) {
        for (const [id, panel] of boxes) {
          if (target === 'all' || !NODE_IDS.includes(id as NodeId) || list.includes(id)) rects.push({ x: panel.x, y: panel.y, w: panel.width, h: panel.height });
        }
      }
    },
    load(next, timeline) {
      lesson = next;
      events = timeline as LessonEvent[];
      clearWidgets();
      cellValues = new Map();
      boxes = panelBoxes(next);
      syncStrip();
    },
    render: renderWidgets,
    beforeFit: syncStrip,
    afterFit(end) {
      clearWidgets();
      renderWidgets(end);
    },
  };
}
