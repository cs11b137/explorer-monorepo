import { esc, must } from '../core/dom';
import type { PlayerState } from '../core/player';
import { site } from '../site';
import { packetsOf, type KnownEvent, type LessonLike, type PacketLike } from '../types';

const TOP = 18;
const ROW = 52;
const NOTE_ROW = 36;
const STEP_ROW = 42;
const BREAK_ROW = 44;
const SLANT = 16;
const DEFAULT_MIN_LANE = 104;
const DEFAULT_LEFT = 96;
const BREAK_RATIO = 20;

export function sequenceMarkup(): string {
  return `
  <div class="sequence" aria-label="时序图">
    <div class="seq-head"><div class="seq-head-track"></div></div>
    <div class="seq-scroll"><svg class="seq-svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
  </div>`;
}

type Item =
  | { kind: 'step'; step: number }
  | { kind: 'packet'; packet: PacketLike; index: number; step: number }
  | { kind: 'note'; at: string; text: string; tone: string; index: number; step: number }
  | { kind: 'break'; text: string };

/** 把课程展开成纵向条目。时间差悬殊的两个事件之间插入折叠标记。 */
export function buildItems(lesson: LessonLike<any>): Item[] {
  const items: Item[] = [];
  const packets = packetsOf(lesson) as PacketLike[];
  const config = site().sequence;
  const gapOf = (current: PacketLike, before: PacketLike) => config?.gap?.(current, before) ?? 0;
  const gaps = packets.slice(1).map((packet, index) => gapOf(packet, packets[index])).filter((gap) => gap > 0).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  let packetIndex = 0;
  let noteIndex = 0;
  let previous: PacketLike | null = null;
  lesson.steps.forEach((step, stepIndex) => {
    items.push({ kind: 'step', step: stepIndex });
    for (const event of step.events as KnownEvent[]) {
      const list = event.type === 'packet' ? [event] : event.type === 'stream' ? event.packets : [];
      for (const packet of list) {
        if (previous && median > 0 && gapOf(packet, previous) > median * BREAK_RATIO) {
          items.push({ kind: 'break', text: config!.formatGap!(gapOf(packet, previous), lesson) });
        }
        previous = packet;
        items.push({ kind: 'packet', packet, index: packetIndex++, step: stepIndex });
      }
      if (event.type === 'note') items.push({ kind: 'note', at: event.at, text: event.text, tone: event.tone ?? 'navy', index: noteIndex++, step: stepIndex });
    }
  });
  return items;
}

interface Built {
  lesson: LessonLike<any>;
  arrows: SVGGElement[];
  notes: SVGGElement[];
  steps: SVGGElement[];
}

const built = new WeakMap<HTMLElement, Built>();
const widthMemo = new WeakMap<HTMLElement, number>();

function build(root: HTMLElement, lesson: LessonLike<any>): void {
  const config = site();
  const MIN_LANE = config.sequence?.minLane ?? DEFAULT_MIN_LANE;
  const LEFT = config.sequence?.left ?? DEFAULT_LEFT;
  const packets = packetsOf(lesson) as PacketLike[];
  const used = new Set<string>(packets.flatMap((packet) => [packet.from, packet.to]));
  const lifelines = config.stage.nodeIds.filter((id) => used.has(id)).sort((a, b) => lesson.nodes.indexOf(a) - lesson.nodes.indexOf(b));
  const scroll = must<HTMLElement>(root, '.seq-scroll');
  const width = Math.max(scroll.clientWidth || 800, LEFT + 40 + (lifelines.length - 1) * MIN_LANE + 60);
  widthMemo.set(root, scroll.clientWidth);
  const lane = lifelines.length > 1 ? (width - LEFT - 100) / (lifelines.length - 1) : 0;
  const xOf = (id: string) => LEFT + 50 + lifelines.indexOf(id) * lane;

  must(root, '.seq-head-track').innerHTML = lifelines
    .map((id) => {
      const [name, sub] = lesson.labels[id] ?? [id, ''];
      return `<div class="seq-who" style="left:${xOf(id)}px;max-width:${Math.max(lane - 6, 96)}px" title="${esc(sub)}"><b>${esc(name)}</b><i>${esc(sub)}</i></div>`;
    })
    .join('');
  must<HTMLElement>(root, '.seq-head-track').style.width = `${width}px`;

  let y = TOP;
  const layered: string[] = [];
  const items = buildItems(lesson);
  for (const item of items) {
    if (item.kind === 'step') {
      y += 10;
      const title = `第 ${item.step + 1} 步 · ${lesson.steps[item.step].title}`;
      layered.push(`<g class="seq-step" data-step="${item.step}"><line class="seq-step-line" x1="0" x2="${width}" y1="${y}" y2="${y}"/><text class="seq-step-text" x="12" y="${y}">${esc(title)}</text></g>`);
      y += STEP_ROW - 10;
    } else if (item.kind === 'break') {
      const pill = 72;
      layered.push(`<g class="seq-break"><rect class="seq-break-band" x="${LEFT}" y="${y - 6}" width="${width - LEFT}" height="20"/><path class="seq-wave" d="M${LEFT},${y + 4} q${(width - LEFT) / 8},-7 ${(width - LEFT) / 4},0 t${(width - LEFT) / 4},0 t${(width - LEFT) / 4},0 t${(width - LEFT) / 4},0"/><rect class="seq-break-bg" x="${(LEFT + width) / 2 - pill / 2}" y="${y - 7}" width="${pill}" height="22" rx="3"/><text class="seq-break-text" text-anchor="middle" x="${(LEFT + width) / 2}" y="${y + 4}">${esc(item.text)}</text></g>`);
      y += BREAK_ROW - 8;
    } else if (item.kind === 'note') {
      const x = xOf(item.at);
      layered.push(`<g class="seq-note tone-${item.tone}" data-note="${item.index}" data-step="${item.step}"><circle class="seq-note-dot" cx="${x}" cy="${y}" r="3.5"/><g class="seq-note-pill" data-x="${x + 10}" data-y="${y}"><rect class="seq-note-bg" y="${y - 10}" height="20" rx="3"/><text class="seq-note-text" y="${y}">${esc(item.text)}</text></g></g>`);
      y += NOTE_ROW;
    } else {
      const { packet } = item;
      const x1 = xOf(packet.from);
      const x2 = xOf(packet.to);
      const dir = x2 > x1 ? 1 : -1;
      const share = packet.lost ? 0.6 : 1;
      const ex = x1 + (x2 - x1) * share;
      const ey = y + SLANT * share;
      const angle = (Math.atan2(SLANT, x2 - x1) * 180) / Math.PI;
      const mx = (x1 + ex) / 2;
      const my = (y + ey) / 2;
      const labelAngle = dir > 0 ? angle : angle + 180;
      const cross = packet.lost ? `<path class="seq-cross" d="M${ex - 6},${ey - 6} L${ex + 6},${ey + 6} M${ex + 6},${ey - 6} L${ex - 6},${ey + 6}"/>` : '';
      const tip = packet.lost ? '' : `<path class="seq-tip" transform="translate(${ex} ${ey}) rotate(${angle})" d="M0,0 L-11,-5 L-11,5 Z"/>`;
      layered.push(`<g class="seq-arrow c-${packet.color}${packet.lost ? ' is-lost' : ''}" data-packet="${item.index}" data-step="${item.step}" tabindex="-1">
        <line class="seq-hit" x1="${x1}" y1="${y}" x2="${ex}" y2="${ey}"/>
        <line class="seq-line" x1="${x1}" y1="${y}" x2="${packet.lost ? ex : ex - dir * 8}" y2="${packet.lost ? ey : ey - 1}"/>
        <circle class="seq-dot" cx="${x1}" cy="${y}" r="2.6"/>${tip}${cross}
        <text class="seq-time" x="${LEFT - 6}" y="${y}">${esc(config.rowTime(packet.row, lesson))}</text>
        <g transform="translate(${mx} ${my}) rotate(${labelAngle})">
          <rect class="seq-label-bg" y="-20" height="17" rx="2"/>
          <text class="seq-label-text" text-anchor="middle" y="-11.5" dominant-baseline="central">${esc(packet.label)}</text>
        </g>
      </g>`);
      y += ROW;
    }
  }
  const total = y + 20;
  const lines = lifelines.map((id) => `<line class="seq-life" x1="${xOf(id)}" x2="${xOf(id)}" y1="0" y2="${total}"/>`).join('');
  const svg = must<SVGSVGElement>(root, '.seq-svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(total));
  svg.setAttribute('viewBox', `0 0 ${width} ${total}`);
  svg.innerHTML = lines + layered.join('');
  built.set(root, {
    lesson,
    arrows: [...svg.querySelectorAll<SVGGElement>('.seq-arrow')],
    notes: [...svg.querySelectorAll<SVGGElement>('.seq-note')],
    steps: [...svg.querySelectorAll<SVGGElement>('.seq-step')],
  });
  fitLabels(root);
}

/** 文字宽度只有元素可见时才能量，所以在切到时序视图后再补一次。 */
export function fitLabels(root: HTMLElement): void {
  const svg = must<SVGSVGElement>(root, '.seq-svg');
  svg.querySelectorAll('.seq-label-text').forEach((text) => {
    const width = (text as SVGTextElement).getComputedTextLength() + 12;
    const bg = text.previousElementSibling as SVGRectElement;
    bg.setAttribute('x', String(-width / 2));
    bg.setAttribute('width', String(width));
  });
  svg.querySelectorAll('.seq-note-pill').forEach((pill) => {
    const element = pill as SVGGElement;
    const text = element.querySelector('text') as SVGTextElement;
    const bg = element.querySelector('rect') as SVGRectElement;
    const x = Number(element.dataset.x);
    const width = text.getComputedTextLength() + 14;
    bg.setAttribute('x', String(x));
    bg.setAttribute('width', String(width));
    text.setAttribute('x', String(x + 7));
  });
}

export function renderSequence(root: HTMLElement, state: PlayerState, lesson: LessonLike<any>): void {
  const memo = built.get(root);
  const scroll = must<HTMLElement>(root, '.seq-scroll');
  if (!memo || memo.lesson !== lesson || (scroll.clientWidth && widthMemo.get(root) !== scroll.clientWidth)) build(root, lesson);
  const current = built.get(root)!;
  let latest: SVGGElement | null = null;
  current.arrows.forEach((arrow, index) => {
    const value = state.packets[index];
    const shown = state.started && value !== 'future';
    arrow.classList.toggle('is-shown', shown);
    arrow.classList.toggle('is-current', state.started && value === 'current');
    if (shown) latest = arrow;
  });
  current.notes.forEach((note, index) => {
    const shown = state.started && state.notes[index] !== 'future';
    note.classList.toggle('is-shown', shown);
    if (shown && (!latest || (note.getBBox().y > (latest as SVGGElement).getBBox().y))) latest = note;
  });
  current.steps.forEach((step, index) => step.classList.toggle('is-active', state.started && !state.done && index === state.activeStep));
  if (latest && scroll.clientHeight) {
    const box = (latest as SVGGElement).getBBox();
    const bottom = box.y + box.height + 40;
    if (bottom > scroll.scrollTop + scroll.clientHeight || box.y < scroll.scrollTop) {
      scroll.scrollTo({ top: Math.max(0, bottom - scroll.clientHeight), behavior: 'smooth' });
    }
  } else if (!state.started) {
    scroll.scrollTop = 0;
  }
}

export function initSequence(root: HTMLElement, onInspect: (index: number) => void): void {
  const head = must<HTMLElement>(root, '.seq-head-track');
  const scroll = must<HTMLElement>(root, '.seq-scroll');
  scroll.addEventListener('scroll', () => {
    head.style.transform = `translateX(${-scroll.scrollLeft}px)`;
  });
  root.addEventListener('click', (event) => {
    const arrow = (event.target as Element).closest<SVGGElement>('.seq-arrow.is-shown');
    if (arrow) onInspect(Number(arrow.dataset.packet));
  });
}
