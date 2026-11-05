import { must } from '../core/dom';
import { lessonFraction, lessonStatus } from '../core/progress';
import type { PlayerState } from '../core/player';
import { swapText } from '../core/transitions';
import { site } from '../site';
import type { LessonLike } from '../types';
import { ICONS } from './icons';

export function topbarMarkup(): string {
  const { brand, layers } = site();
  const chips = layers.names.map((name, index) => `<span data-layer="${index + 1}" title="第 ${index + 1} ${layers.unit}：${name}">${index + 1}</span>`).join('');
  return `
  <header class="topbar">
    <button class="drawer-btn" type="button" aria-label="课程列表" aria-expanded="false" aria-controls="lessons">${ICONS.menu}<span>课程</span></button>
    <div class="brand">
      <div class="logo-frame">
        <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
        ${brand.logo}
      </div>
      <div class="brand-text">
        <h1>${brand.title}</h1>
        <p>${brand.tagline}</p>
      </div>
    </div>
    <span class="topbar-sep"></span>
    <div class="now">
      <div class="now-label">正在学习</div>
      <div class="now-title"><span class="now-name"></span></div>
      <div class="now-progress"><span class="now-dots"></span><span class="now-step"></span></div>
    </div>
    <span class="topbar-sep sep-layer"></span>
    <div class="layer"${layers.title ? ` title="${layers.title}"` : ''}>
      <div class="layer-head"><span class="layer-label">${layers.label}</span><span class="layer-name"></span></div>
      <div class="layer-chips"><i class="layer-marker"></i>${chips}</div>
    </div>
    <div class="topbar-tools">
      <span class="topbar-sep"></span>
      <div class="learning">
        <div class="learning-head"><span class="learning-label">学习进度</span><span class="learning-value"></span></div>
        <div class="learning-bars" role="img"></div>
        <div class="learning-sub"><span class="learning-done"></span> / <span class="learning-total"></span> 已完成 <span class="dot">·</span> <span class="learning-active"></span> 进行中</div>
      </div>
      <span class="topbar-sep"></span>
      <a class="credit" href="https://x.com/DilumSanjaya" target="_blank" rel="noopener noreferrer" title="本站的版式和交互参考了 Dilum Sanjaya 的 Protocol Explorer">
        <span class="credit-label">灵感来源</span>
        <span class="credit-name">Protocol Explorer · DilumSanjaya ${ICONS.external}</span>
      </a>
      <span class="topbar-sep"></span>
      <div class="theme-toggle" role="group" aria-label="主题">
        <button type="button" data-theme-choice="light" aria-label="浅色模式" title="浅色模式">${ICONS.sun}</button>
        <button type="button" data-theme-choice="dark" aria-label="深色模式" title="深色模式">${ICONS.moon}</button>
      </div>
    </div>
  </header>`;
}

export function initTheme(root: HTMLElement, save: (theme: string) => void): void {
  const sync = () => {
    const current = document.documentElement.dataset.theme;
    root.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((button) => {
      const active = button.dataset.themeChoice === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = current === 'dark' ? '#0b1020' : '#fdfdfe';
    });
  };
  root.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-theme-choice]');
    if (!button) return;
    document.documentElement.dataset.theme = button.dataset.themeChoice;
    save(button.dataset.themeChoice!);
    sync();
  });
  sync();
}

export function renderProgress(root: HTMLElement, lessons: Array<LessonLike<any>>): void {
  const bars = must<HTMLElement>(root, '.learning-bars');
  if (bars.children.length !== lessons.length) {
    bars.innerHTML = lessons.map((lesson, index) => `<span class="learning-seg" data-lesson="${lesson.id}"><i style="--i:${index}"></i></span>`).join('');
  }
  const fractions = lessons.map((lesson) => lessonFraction(lesson.id, lesson.steps.length));
  lessons.forEach((lesson, index) => {
    const seg = bars.children[index] as HTMLElement;
    const percent = Math.round(fractions[index] * 100);
    seg.title = `${lesson.name}：${percent}%`;
    seg.classList.toggle('partial', fractions[index] > 0 && fractions[index] < 1);
    (seg.firstElementChild as HTMLElement).style.width = `${percent}%`;
  });
  const percent = Math.round((fractions.reduce((sum, value) => sum + value, 0) / lessons.length) * 100);
  const statuses = lessons.map((lesson) => lessonStatus(lesson.id));
  swapText(must(root, '.learning-value'), `${percent}%`);
  bars.setAttribute('aria-label', `已完成 ${percent}%`);
  swapText(must(root, '.learning-done'), String(statuses.filter((status) => status === 'done').length));
  must(root, '.learning-total').textContent = String(lessons.length);
  swapText(must(root, '.learning-active'), String(statuses.filter((status) => status === 'progress').length));
}

export function renderTopbar(root: HTMLElement, state: PlayerState, lesson: LessonLike<any>): void {
  swapText(must(root, '.now-name'), `${lesson.name} · ${lesson.title}`);
  const dots = must<HTMLElement>(root, '.now-dots');
  if (dots.dataset.lesson !== lesson.id) {
    dots.dataset.lesson = lesson.id;
    dots.style.setProperty('--dots', String(lesson.steps.length));
    dots.innerHTML = lesson.steps.map(() => '<i></i>').join('');
  }
  [...dots.children].forEach((dot, index) => {
    dot.className = state.steps[index] === 'active' ? 'is-active' : state.steps[index] === 'done' ? 'is-done' : '';
  });
  const stepText = state.done
    ? `已完成 · 共 ${lesson.steps.length} 步`
    : state.started
      ? `第 ${state.activeStep + 1}/${lesson.steps.length} 步 · ${lesson.steps[state.activeStep].title}`
      : `概览 · 共 ${lesson.steps.length} 步`;
  swapText(must(root, '.now-step'), stepText);

  const [lo, hi] = lesson.layer;
  const { layers } = site();
  const name = lo === hi ? layers.names[lo - 1] : `${layers.names[lo - 1]} – ${layers.names[hi - 1]}`;
  const title = layers.lessonTitle?.(lesson);
  if (title !== undefined) must<HTMLElement>(root, '.layer').title = title;
  swapText(must(root, '.layer-name'), name);
  root.querySelectorAll<HTMLElement>('.layer-chips span').forEach((chip) => {
    const value = Number(chip.dataset.layer);
    chip.classList.toggle('is-active', value >= lo && value <= hi);
  });
  moveLayerMarker(root, lesson);
}

export function moveLayerMarker(root: HTMLElement, lesson: LessonLike<any>): void {
  const [lo, hi] = lesson.layer;
  const marker = must<HTMLElement>(root, '.layer-marker');
  const first = root.querySelector<HTMLElement>(`.layer-chips span[data-layer="${lo}"]`);
  const last = root.querySelector<HTMLElement>(`.layer-chips span[data-layer="${hi}"]`);
  if (!first || !last || !first.offsetWidth) return;
  marker.style.left = `${first.offsetLeft}px`;
  marker.style.width = `${last.offsetLeft + last.offsetWidth - first.offsetLeft}px`;
  requestAnimationFrame(() => marker.classList.add('is-ready'));
}
