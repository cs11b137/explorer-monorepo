import { svgEl } from '@explorer/engine/core/dom';
import type { Box, StageApi, StagePlugin } from '@explorer/engine/scene/stage';
import { foldBoards, type Lesson, type LessonEvent } from '../lessons/types';
import type { BoardSpec } from './board-types';
import { renderBoard } from './boards';
import { NODE_SPECS } from './devices';

/** 面板窄于这个宽度时，镜头只跟着刚变化的结构板，否则字太小看不清。 */
const BOARD_ONLY_WIDTH = 480;
/** 手机上结构板按这个宽度重新排版，文字才不至于太小。 */
const NARROW_BOARD_WIDTH = 560;

/** 结构板：页、树、缓冲池、锁表等。镜头框住全部节点和结构板，整课不变，所以结构板不会被裁掉。 */
export function boardPlugin(api: StageApi<Lesson>): StagePlugin<Lesson> {
  const { svg, bodyEls } = api;
  const boardLayer = svg.querySelector<SVGGElement>('.board-layer')!;
  let lesson: Lesson | null = null;
  let events: LessonEvent[] = [];
  let narrow = false;
  const boardMemo = new Map<string, BoardSpec>();
  const boardSize = new Map<string, { w: number; h: number }>();
  let latestBoard: string | null = null;

  /** 窄屏只显示一块结构板，把它放在所有结构板的最上沿，紧贴节点下方。 */
  function narrowBoardTop(): number {
    return Math.min(...Object.values(lesson?.boards ?? {}).map((slot) => slot.rect[1]));
  }

  /** 重画结构板。内容是纯函数算出来的，spec 没变就不动。 */
  function renderBoards(end: number): void {
    if (!lesson) return;
    const { specs, latest } = foldBoards(lesson, events, end);
    const moved = latest !== latestBoard;
    latestBoard = latest;
    for (const [id, spec] of specs) {
      if (boardMemo.get(id) === spec) continue;
      boardMemo.set(id, spec);
      const slot = boardLayer.querySelector<SVGGElement>(`[data-board="${id}"]`);
      if (!slot) continue;
      const [, , fullW, fullH] = lesson.boards[id].rect;
      const w = narrow ? Math.min(fullW, NARROW_BOARD_WIDTH) : fullW;
      // 窄屏重排后可能多占几行，先量一次，再按实际高度画外框。
      const h = narrow ? Math.max(fullH, renderBoard(spec, w, fullH).height + 10) : fullH;
      slot.innerHTML = renderBoard(spec, w, h).svg;
      boardSize.set(id, { w, h });
    }
    const shown = latestBoard ?? Object.keys(lesson.boards)[0];
    boardLayer.querySelectorAll<SVGGElement>('.board-slot').forEach((slot) => {
      const id = slot.dataset.board!;
      slot.style.visibility = narrow && id !== shown ? 'hidden' : '';
      const [x, y] = lesson!.boards[id].rect;
      slot.setAttribute('transform', `translate(${x} ${narrow ? narrowBoardTop() : y})`);
    });
    if (narrow && moved) api.setView(api.frameFor(api.frameTarget()));
  }

  return {
    /** 窄屏时把节点沿横向压缩到结构板的宽度，这样设备和结构板都能留在画面里。 */
    placeOf(_id, at) {
      if (!narrow || !lesson) return at;
      const xs = lesson.nodes.map((node) => lesson!.place[node]![0]);
      const min = Math.min(...xs);
      const max = Math.max(...xs);
      const span = NARROW_BOARD_WIDTH - 110;
      return [20 + 55 + (max > min ? ((at[0] - min) / (max - min)) * span : span / 2), at[1]];
    },
    radiusOf: (id) => NODE_SPECS[id as keyof typeof NODE_SPECS].radius * (narrow ? 0.75 : 1),
    frame() {
      const slots = Object.entries(lesson?.boards ?? {});
      const boxes: Box[] = [];
      for (const id of api.nodes()) {
        const [x, y] = api.placeOf(id);
        const b = bodyEls[id].getBBox();
        boxes.push({ x: x + b.x, y: y + b.y, w: b.width, h: b.height });
      }
      if (narrow && slots.length) {
        const chosen = slots.find(([id]) => id === latestBoard) ?? slots[0];
        const size = boardSize.get(chosen[0]) ?? { w: chosen[1].rect[2], h: chosen[1].rect[3] };
        boxes.push({ x: chosen[1].rect[0], y: narrowBoardTop(), w: size.w, h: size.h });
      } else {
        for (const [, slot] of slots) {
          const [x, y, w, h] = slot.rect;
          boxes.push({ x, y, w, h });
        }
      }
      return api.fitBoxes(boxes);
    },
    maxLabelScale: () => (narrow ? 1.15 : 1.5),
    load(next, timeline) {
      lesson = next;
      events = timeline as LessonEvent[];
      narrow = svg.getBoundingClientRect().width < BOARD_ONLY_WIDTH;
      boardMemo.clear();
      boardSize.clear();
      latestBoard = null;
      boardLayer.replaceChildren();
      for (const [id, slot] of Object.entries(next.boards)) {
        const [x, y] = slot.rect;
        svgEl('g', { class: 'board-slot', 'data-board': id, transform: `translate(${x} ${y})` }, boardLayer);
      }
      renderBoards(0);
    },
    render: renderBoards,
    beforeFit() {
      const wasNarrow = narrow;
      narrow = svg.getBoundingClientRect().width < BOARD_ONLY_WIDTH;
      if (wasNarrow !== narrow) api.replace();
    },
    afterFit(end) {
      boardMemo.clear();
      renderBoards(end);
      api.setView(api.frameFor(api.frameTarget()));
    },
  };
}
