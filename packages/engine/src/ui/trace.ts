import { EASE_OUT, esc, must, reducedMotion } from '../core/dom';
import type { PlayerState } from '../core/player';
import { slideSwap, swapText } from '../core/transitions';
import { site } from '../site';
import { labelOf, packetsOf, type LessonLike, type PacketLike } from '../types';
import { ICONS } from './icons';

export function traceMarkup(): string {
  const config = site().trace;
  const heads = ['序号', config.timeHead, '来源', '目标', '类型', '说明', '大小'].map((title) => `<th>${title}</th>`).join('');
  return `
  <section class="panel packets">
    <div class="panel-head bar">
      <h2 class="panel-title sm">${config.title}</h2>
      <div class="packet-legend" aria-label="颜色图例"></div>
      <div class="packet-actions">
        <button class="btn speed" type="button" data-action="speed" title="播放速度"><span class="speed-label">1×</span></button>
        <button class="btn icon" type="button" data-action="prev" title="上一步 (←)" aria-label="上一步">${ICONS.prev}</button>
        <button class="btn primary toggle" type="button" data-action="toggle" title="播放 / 暂停 (空格)">
          <span class="toggle-icon">
            <svg class="icon-playpause" viewBox="0 0 12 14" width="12" height="14" aria-hidden="true"><path class="pp-a"/><path class="pp-b"/></svg>
            ${ICONS.reset.replace('<svg', '<svg class="icon-replay"')}
          </span>
          <span class="toggle-label"></span>
        </button>
        <button class="btn" type="button" data-action="step" title="一次一个事件">单步</button>
        <button class="btn" type="button" data-action="reset" title="回到概览 (Esc)" aria-label="重置">${ICONS.reset}<span class="btn-text">重置</span></button>
      </div>
    </div>
    <div class="packet-scroll">
      <table class="packet-table">
        <colgroup><col class="c-no"><col class="${config.timeColClass ?? 'c-time'}"><col class="c-src"><col class="c-dst"><col class="c-type"><col><col class="c-size"></colgroup>
        <thead><tr>${heads}</tr></thead>
        <tbody class="packet-empty-body"><tr class="packet-empty" hidden><td colspan="7">还没有事件发生。</td></tr></tbody>
        <tbody class="packet-rows"></tbody>
      </table>
    </div>
  </section>`;
}

const legendHtml = (lesson: LessonLike<any>) =>
  lesson.legend
    .map(([color, text]) => (color ? `<span class="legend-item"><i class="legend-dot step-badge ${color}"></i>${esc(text)}</span>` : `<span class="legend-note">${esc(text)}</span>`))
    .join('');

function rowsHtml(lesson: LessonLike<any>): string {
  const config = site();
  return (packetsOf(lesson) as PacketLike[])
    .map(({ color, row, from, to, lost }, index) => `
      <tr data-packet="${index}" class="${lost ? 'is-lost' : ''}" tabindex="0" hidden>
        <td><span class="step-badge ${color}">${index + 1}</span></td>
        <td>${esc(config.rowTime(row, lesson))}</td>
        <td>${esc(labelOf(lesson, from))}</td>
        <td>${esc(labelOf(lesson, to))}</td>
        <td>${esc(row.type)}</td>
        <td title="${esc(row.info)}">${esc(row.info)}${lost ? `<span class="lost-chip">${config.trace.lostChip}</span>` : ''}</td>
        <td>${esc(config.formatSize(row.size))}</td>
      </tr>`)
    .join('');
}

const opacityOf = (row: HTMLElement) => (row.hidden ? 0 : Number(getComputedStyle(row).opacity));

function showRow(row: HTMLElement, delay = 0): void {
  const from = opacityOf(row);
  row.dataset.shown = '1';
  row.getAnimations().forEach((animation) => animation.cancel());
  row.hidden = false;
  if (reducedMotion() || from === 1) return;
  row.animate(
    [{ opacity: from, transform: `translateY(${10 * (1 - from)}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 360, delay: from > 0 ? 0 : delay, easing: EASE_OUT, fill: 'backwards' },
  );
}

function hideRow(row: HTMLElement): void {
  const from = opacityOf(row);
  row.dataset.shown = '0';
  row.getAnimations().forEach((animation) => animation.cancel());
  if (reducedMotion() || from === 0) {
    row.hidden = true;
    return;
  }
  const fade = row.animate([{ opacity: from }, { opacity: 0 }], { duration: 180 * from, fill: 'forwards' });
  fade.onfinish = () => {
    if (row.dataset.shown === '0') row.hidden = true;
    fade.cancel();
  };
}

function syncRows(root: HTMLElement, state: PlayerState): void {
  const rows = [...root.querySelectorAll<HTMLElement>('tr[data-packet]')];
  const wanted = rows.map((_, index) => !state.started || state.packets[index] !== 'future');
  const entering = rows.filter((row, index) => wanted[index] && row.dataset.shown !== '1');
  const leaving = rows.filter((row, index) => !wanted[index] && row.dataset.shown === '1');
  leaving.forEach(hideRow);
  entering.forEach((row, index) => showRow(row, (leaving.length ? 200 : 0) + (entering.length > 1 ? index * 35 : 0)));
  rows.forEach((row, index) => row.classList.toggle('is-current', state.started && state.packets[index] === 'current'));
  const scroll = must<HTMLElement>(root, '.packet-scroll');
  if (state.started && entering.length === 1) requestAnimationFrame(() => scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' }));
  if (!state.started && entering.length) scroll.scrollTo({ top: 0, behavior: 'smooth' });
  const empty = must<HTMLElement>(root, '.packet-empty');
  const isEmpty = state.started && !wanted.some(Boolean);
  if (isEmpty && empty.dataset.shown !== '1') showRow(empty, leaving.length ? 220 : 0);
  if (!isEmpty && empty.dataset.shown === '1') hideRow(empty);
}

export function renderTrace(root: HTMLElement, state: PlayerState, lesson: LessonLike<any>): void {
  const body = must<HTMLElement>(root, '.packet-rows');
  const legend = must<HTMLElement>(root, '.packet-legend');
  if (root.dataset.lesson !== lesson.id) {
    const first = !root.dataset.lesson;
    root.dataset.lesson = lesson.id;
    if (first) legend.innerHTML = legendHtml(lesson);
    else slideSwap(legend, () => (legend.innerHTML = legendHtml(lesson)), { distance: 16 });
    body.innerHTML = rowsHtml(lesson);
    site().trace.onLesson?.(root, lesson);
    must<HTMLElement>(root, '.packet-scroll').scrollTop = 0;
  }
  syncRows(root, state);
  const toggle = must<HTMLElement>(root, '.toggle');
  toggle.classList.toggle('is-playing', state.playing);
  toggle.classList.toggle('is-done', state.done && !state.playing);
  swapText(must(root, '.toggle-label'), state.playing ? '暂停' : state.done ? '重播' : '播放');
  must<HTMLButtonElement>(root, '[data-action="step"]').disabled = state.done;
  must<HTMLButtonElement>(root, '[data-action="prev"]').disabled = !state.started;
}

export function visibleRows(root: HTMLElement): number[] {
  return [...root.querySelectorAll<HTMLElement>('tr[data-packet]')]
    .filter((row) => !row.hidden && row.dataset.shown === '1')
    .map((row) => Number(row.dataset.packet));
}

export function setSpeedLabel(root: HTMLElement, speed: number): void {
  swapText(must(root, '.speed-label'), `${speed}×`);
}

export function initTrace(root: HTMLElement, handlers: Record<'toggle' | 'step' | 'reset' | 'prev' | 'speed', () => void> & { inspect(index: number): void }): void {
  root.addEventListener('click', (event) => {
    const target = event.target as Element;
    const action = target.closest<HTMLButtonElement>('[data-action]');
    if (action && !action.disabled) handlers[action.dataset.action as 'toggle' | 'step' | 'reset' | 'prev' | 'speed']();
    const row = target.closest<HTMLElement>('tr[data-packet]');
    if (row && !row.hidden) handlers.inspect(Number(row.dataset.packet));
  });
  root.addEventListener('keydown', (event) => {
    const row = event.key === 'Enter' ? (event.target as Element).closest<HTMLElement>('tr[data-packet]') : null;
    if (row && !row.hidden) handlers.inspect(Number(row.dataset.packet));
  });
}
