import { EASE_OUT, esc, must, reducedMotion } from '../core/dom';
import { lessonStatus } from '../core/progress';
import type { PlayerState } from '../core/player';
import { site } from '../site';
import type { LessonLike } from '../types';
import { ICONS } from './icons';

function lessonMarkup(lesson: LessonLike<any>): string {
  const steps = lesson.steps
    .map(
      (step, index) => `
      <li class="step" data-step="${index}" style="--i:${index}">
        <button class="step-btn" type="button">
          <span class="step-num"><span>${index + 1}</span>${ICONS.check}</span>
          <span class="step-text"><span class="step-title">${esc(step.title)}</span><span class="step-desc">${esc(step.desc)}</span></span>
        </button>
      </li>`,
    )
    .join('');
  return `
    <li class="proto" data-group="${lesson.group}" data-lesson="${lesson.id}">
      <button class="proto-row" type="button" aria-expanded="false">
        <span class="status-dot new"></span>
        <span class="proto-text"><span class="proto-name">${esc(lesson.name)}</span><span class="proto-full">${esc(lesson.title)}</span></span>
        <span class="proto-chev">${ICONS.chev}</span>
      </button>
      <div class="steps-wrap"><div class="steps-clip"><ol class="steps">${steps}</ol></div></div>
    </li>`;
}

export function sidebarMarkup(lessons: Array<LessonLike<any>>): string {
  const config = site().sidebar;
  const tabs = [{ id: 'all', label: '全部' }, ...config.tabs].map((tab, index) => {
    const count = tab.id === 'all' ? lessons.length : lessons.filter((lesson) => lesson.group === tab.id).length;
    return `<button class="tab ${index === 0 ? 'is-active' : ''}" type="button" role="tab" aria-selected="${index === 0}" data-group="${tab.id}"><span>${tab.label}</span><span class="tab-count">${count}</span></button>`;
  }).join('');
  return `
  <aside class="panel sidebar" id="lessons">
    <div class="panel-head">
      <h2 class="panel-title">${config.title}</h2>
      <span class="more" aria-hidden="true">${ICONS.dots}</span>
      <button class="drawer-close" type="button" aria-label="关闭课程列表" title="关闭 (Esc)">${ICONS.close}</button>
    </div>
    <div class="tabs" role="tablist">${tabs}<span class="tab-indicator"></span></div>
    <ul class="proto-list">${lessons.map(lessonMarkup).join('')}</ul>
  </aside>`;
}

export function moveTabIndicator(root: HTMLElement): void {
  const active = root.querySelector<HTMLElement>('.tab.is-active');
  const indicator = must<HTMLElement>(root, '.tab-indicator');
  if (!active || !active.offsetWidth) return;
  indicator.style.left = `${active.offsetLeft}px`;
  indicator.style.width = `${active.offsetWidth}px`;
}

export function initSidebar(root: HTMLElement, handlers: { onSelect(id: string): void; onStep(step: number): void }): void {
  const list = must<HTMLElement>(root, '.proto-list');
  moveTabIndicator(root);
  requestAnimationFrame(() => must(root, '.tabs').classList.add('is-ready'));

  function filter(group: string): void {
    const items = [...list.querySelectorAll<HTMLElement>('.proto')];
    const before = new Map(items.filter((item) => !item.hidden).map((item) => [item, item.getBoundingClientRect().top]));
    items.forEach((item) => {
      item.hidden = group !== 'all' && item.dataset.group !== group;
    });
    list.scrollTop = 0;
    if (reducedMotion()) return;
    for (const item of items) {
      if (item.hidden) continue;
      const was = before.get(item);
      if (was === undefined) {
        item.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
      } else {
        const delta = was - item.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) item.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 420, easing: EASE_OUT });
      }
    }
  }

  root.addEventListener('click', (event) => {
    const target = event.target as Element;
    const tab = target.closest<HTMLElement>('.tab');
    if (tab) {
      root.querySelectorAll('.tab').forEach((other) => {
        other.classList.toggle('is-active', other === tab);
        other.setAttribute('aria-selected', String(other === tab));
      });
      moveTabIndicator(root);
      filter(tab.dataset.group!);
      return;
    }
    const stepBtn = target.closest<HTMLElement>('.step-btn');
    if (stepBtn) {
      handlers.onStep(Number(stepBtn.closest<HTMLElement>('.step')!.dataset.step));
      return;
    }
    const row = target.closest<HTMLElement>('.proto-row');
    if (row) {
      const item = row.closest<HTMLElement>('.proto')!;
      if (item.classList.contains('is-active')) setOpen(item, !item.classList.contains('is-open'));
      else handlers.onSelect(item.dataset.lesson!);
    }
  });
}

function setOpen(item: HTMLElement, open: boolean): void {
  item.classList.toggle('is-open', open);
  item.querySelector('.proto-row')!.setAttribute('aria-expanded', String(open));
}

export function renderStatuses(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.proto').forEach((item) => {
    const dot = item.querySelector<HTMLElement>('.status-dot')!;
    const status = lessonStatus(item.dataset.lesson!);
    if (!dot.classList.contains(status)) {
      dot.className = `status-dot ${status} is-changed`;
    }
  });
}

export function renderSidebar(root: HTMLElement, state: PlayerState, lesson: LessonLike<any>): void {
  const current = must<HTMLElement>(root, `.proto[data-lesson="${lesson.id}"]`);
  if (!current.classList.contains('is-active')) {
    root.querySelectorAll<HTMLElement>('.proto').forEach((item) => {
      const active = item === current;
      item.classList.toggle('is-active', active);
      setOpen(item, active);
      if (!active) item.querySelectorAll('.step').forEach((step) => step.classList.remove('is-active', 'is-done'));
    });
    const list = must<HTMLElement>(root, '.proto-list');
    requestAnimationFrame(() => {
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top + current.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    });
  }
  current.querySelectorAll<HTMLElement>('.step').forEach((step, index) => {
    step.classList.toggle('is-active', state.steps[index] === 'active');
    step.classList.toggle('is-done', state.steps[index] === 'done');
  });
}
