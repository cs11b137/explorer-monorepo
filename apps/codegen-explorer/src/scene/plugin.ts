import { svgEl } from '@explorer/engine/core/dom';
import type { StageApi, StagePlugin } from '@explorer/engine/scene/stage';
import { foldArts, focusSlot, type Lesson, type LessonEvent } from '../lessons/types';
import { compactWidth, renderArt, type ArtView } from './art';

/** 画面顶部留给视图切换按钮的高度，和引擎取景时一样。 */
const TOP_RESERVE = 54;
/** 面板窄于这个宽度时放不下整张图，相机改为对准正在变化的产物面板。 */
const FOCUS_BELOW = 620;
const MAX_FOCUS_SCALE = 1.15;

/** 产物面板：Token、语法树、IR、机器码等。窄屏时一次只看一块，用翻页按钮切换。 */
export function artPlugin(api: StageApi<Lesson>): StagePlugin<Lesson> {
  const { svg } = api;
  const artLayer = svg.querySelector<SVGGElement>('.art-layer')!;
  let lesson: Lesson | null = null;
  let events: LessonEvent[] = [];
  const panelMemo = new Map<string, string>();
  let lastEnd = -1;
  /** 窄屏时相机对准的面板。 */
  let focusPanel = '';
  let focusSize: [number, number] | null = null;
  /** 窄屏时读者手动翻到的面板。下一个事件更新别的面板时失效。 */
  let manualFocus: string | null = null;
  let eventFocus = '';
  /** 窄屏时代码面板的渲染尺寸：同一课取最宽的那一刻，这样面板不会随事件变宽变窄。 */
  const narrowSizes = new Map<string, [number, number]>();
  const pager = svg.parentElement?.querySelector<HTMLButtonElement>('.panel-pager') ?? null;

  const isNarrow = () => {
    const width = svg.getBoundingClientRect().width;
    return width > 0 && width < FOCUS_BELOW;
  };

  /** 窄屏时这个面板用多大。代码面板可以收窄、变矮（放不下的行由窗口滚动），字就能放大。 */
  function narrowSize(slot: string, w: number, h: number): [number, number] {
    const known = narrowSizes.get(slot);
    if (known) return known;
    const views: ArtView[] = [];
    if (lesson!.initial[slot]) views.push(lesson!.initial[slot]);
    for (let end = 1; end <= events.length; end++) {
      const view = foldArts(events, end, {}).get(slot);
      if (view && view !== views[views.length - 1]) views.push(view);
    }
    const width = Math.max(...views.map((view) => compactWidth(view, w)));
    let height = h;
    if (views.every((view) => view.kind === 'code')) {
      const rect = svg.getBoundingClientRect();
      const usable = Math.max(rect.height - TOP_RESERVE, rect.height * 0.6);
      const scale = Math.min(MAX_FOCUS_SCALE, (rect.width || 1) / (width + 12));
      height = Math.round(Math.min(h, usable / scale - 12));
    }
    const size: [number, number] = [width, height];
    narrowSizes.set(slot, size);
    return size;
  }

  function syncFocus(narrow: boolean, folded: Map<string, ArtView>): void {
    svg.classList.toggle('is-narrow', narrow);
    const slots = Object.keys(lesson!.panels).filter((slot) => folded.has(slot));
    artLayer.querySelectorAll<SVGGElement>('.art-panel').forEach((group) => {
      group.style.display = narrow && group.dataset.panel !== focusPanel ? 'none' : '';
    });
    if (!pager) return;
    pager.hidden = !narrow || slots.length < 2;
    if (!pager.hidden) {
      const next = slots[(slots.indexOf(focusPanel) + 1) % slots.length];
      pager.textContent = `${slots.indexOf(focusPanel) + 1}/${slots.length} · 看${folded.get(next)!.title} ›`;
      pager.dataset.next = next;
    }
  }

  /** 重画产物面板。把事件序列折叠到 end，内容没变的面板不动。end 为 0 是概览，展示这节课最终的产物。 */
  function renderPanels(end: number): void {
    lastEnd = end;
    if (!lesson) return;
    const folded = foldArts(events, end === 0 ? events.length : end, lesson.initial);
    const narrow = isNarrow();
    for (const slot of Object.keys(lesson.panels)) {
      const panel = folded.get(slot);
      const memo = panel ? JSON.stringify(panel) : '';
      if (panelMemo.get(slot) === memo) continue;
      const had = Boolean(panelMemo.get(slot));
      panelMemo.set(slot, memo);
      let group = artLayer.querySelector<SVGGElement>(`[data-panel="${slot}"]`);
      if (!panel) {
        group?.remove();
        continue;
      }
      const [x, y, w, h] = lesson.panels[slot];
      if (!group) group = svgEl('g', { class: 'art-panel', 'data-panel': slot, transform: `translate(${x} ${y})` }, artLayer);
      const [rw, rh] = narrow ? narrowSize(slot, w, h) : [w, h];
      group.innerHTML = renderArt(panel, rw, rh).svg;
      if (!had) group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240 });
    }
    const fallback = Object.keys(lesson.panels)[0] ?? '';
    const fromEvents = end === 0 ? fallback : focusSlot(events, end, fallback);
    if (fromEvents !== eventFocus) {
      eventFocus = fromEvents;
      manualFocus = null;
    }
    applyFocus(manualFocus ?? fromEvents, narrow, folded);
  }

  function applyFocus(nextFocus: string, narrow: boolean, folded: Map<string, ArtView>): void {
    const changed = nextFocus !== focusPanel;
    focusPanel = nextFocus;
    const [, , w, h] = lesson!.panels[nextFocus] ?? [0, 0, 0, 0];
    focusSize = narrow && w ? narrowSize(nextFocus, w, h) : null;
    syncFocus(narrow, folded);
    if (changed && narrow) {
      if (api.isLive()) void api.moveCamera('all', 520, { cancelled: false });
      else api.setView(api.frameFor('all'));
    }
  }

  pager?.addEventListener('click', () => {
    if (!lesson || !pager.dataset.next) return;
    manualFocus = pager.dataset.next;
    applyFocus(manualFocus, isNarrow(), foldArts(events, lastEnd === 0 ? events.length : lastEnd, lesson.initial));
  });

  return {
    frame() {
      const panel = lesson && focusPanel ? lesson.panels[focusPanel] : undefined;
      if (!panel || !isNarrow()) return null;
      const [x, y, w, h] = panel;
      const [width, height] = focusSize ?? [w, h];
      return api.fitBounds(x - 6, y - 6, x + width + 6, y + height + 6, MAX_FOCUS_SCALE);
    },
    frameBoxes(_target, _list, boxes) {
      for (const [x, y, w, h] of Object.values(lesson?.panels ?? {})) boxes.push({ x, y, w, h });
    },
    load(next, timeline) {
      lesson = next;
      events = timeline as LessonEvent[];
      artLayer.replaceChildren();
      panelMemo.clear();
      narrowSizes.clear();
      focusPanel = '';
      eventFocus = '';
      manualFocus = null;
      focusSize = null;
      lastEnd = -1;
    },
    render: renderPanels,
    afterText() {
      if (lastEnd < 0) return;
      panelMemo.clear();
      narrowSizes.clear();
      focusPanel = '';
      renderPanels(lastEnd);
    },
  };
}
