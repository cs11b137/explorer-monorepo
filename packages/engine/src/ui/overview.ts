import { EASE_OUT, esc, must, reducedMotion } from '../core/dom';
import type { PlayerState } from '../core/player';
import { slideSwap, swapText } from '../core/transitions';
import { site } from '../site';
import { labelOf, packetsOf, type Fact, type LessonLike, type PacketLike, type StreamLike } from '../types';
import { ICONS } from './icons';

export function overviewMarkup(): string {
  return `
  <section class="panel overview">
    <div class="panel-head bar">
      <h2 class="panel-title sm"></h2>
      <span class="more" aria-hidden="true">${ICONS.dots}</span>
      <button class="back-btn" type="button" hidden>${ICONS.back}<span>概览</span></button>
    </div>
    <div class="overview-stage">
      <div class="overview-body" data-view="overview">
        <div class="overview-name"><h3></h3><span class="badge"><i></i><span>学习中</span></span></div>
        <p class="overview-full"></p>
        <p class="overview-desc"></p>
        <dl class="facts overview-facts"></dl>
      </div>
      <div class="overview-body explain" data-view="step" hidden aria-live="polite">
        <div class="explain-label"></div>
        <h3 class="explain-title"></h3>
        <p class="explain-sub"></p>
        <p class="explain-text"></p>
        <div class="explain-packet"><div class="explain-packet-clip"><div class="explain-packet-card"><div class="explain-packet-inner">
          <div class="explain-packet-head"><b></b><span></span></div>
          <div class="explain-payload"></div>
          <div class="explain-meta"></div>
        </div></div></div></div>
        <dl class="facts explain-facts"></dl>
      </div>
    </div>
  </section>`;
}

const factsHtml = (facts: Fact[]) => facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('');

interface PacketInfo {
  event: PacketLike | StreamLike;
  number: number;
  count: number;
  total: number;
}

interface View {
  lesson: LessonLike<any>;
  order: number;
  view: 'overview' | 'step';
  title: string;
  rank: number;
  content: { label: string; title: string; desc: string; text: string; facts: Fact[]; done?: boolean };
  packet: PacketInfo | null;
}

function describe(state: PlayerState, lesson: LessonLike<any>, order: number): View {
  const step = lesson.steps[state.activeStep];
  const packets = packetsOf(lesson) as PacketLike[];
  const live = state.started && !state.done && state.event && (state.event.type === 'packet' || state.event.type === 'stream') && state.event.step === state.activeStep;
  let packet: PacketInfo | null = null;
  if (live && state.event) {
    const event = state.event as unknown as PacketLike | StreamLike;
    const first = event.type === 'stream' ? event.packets[0] : event;
    packet = {
      event,
      number: packets.findIndex((item) => item.row === first.row) + 1,
      count: event.type === 'stream' ? event.packets.length : 1,
      total: packets.length,
    };
  }
  return {
    lesson,
    order,
    view: state.started ? 'step' : 'overview',
    title: state.started ? (state.done ? '课程总结' : '步骤详情') : '概览',
    rank: state.started ? (state.done ? lesson.steps.length : state.activeStep) : -1,
    content: state.done
      ? { label: '课程完成', ...lesson.outro, done: true }
      : { label: `第 ${state.activeStep + 1} 步，共 ${lesson.steps.length} 步`, title: step.title, desc: step.desc, text: step.detail, facts: step.facts },
    packet,
  };
}

function renderPacket(root: HTMLElement, info: PacketInfo, lesson: LessonLike<any>): void {
  const box = must<HTMLElement>(root, '.explain-packet');
  const event = info.event.type === 'stream' ? info.event.packets[0] : info.event;
  box.dataset.color = event.color;
  must(box, 'b').innerHTML = (event.locked ? ICONS.lock : '') + esc(event.label);
  must(box, '.explain-packet-head span').textContent = `${labelOf(lesson, event.from)} → ${labelOf(lesson, event.to)}`;
  must(box, '.explain-payload').textContent = event.payload.join('\n');
  const config = site();
  const flags = [event.lost ? config.overview.lostFlag : '', event.locked ? config.overview.lockedFlag ?? '' : ''].filter(Boolean);
  const extra = config.overview.metaExtra?.(event, lesson);
  const head = info.count > 1 ? `事件 ${info.number}–${info.number + info.count - 1}，共 ${info.total} 个` : `事件 ${info.number}，共 ${info.total} 个`;
  must(box, '.explain-meta').textContent = [head, ...(extra ? [extra] : []), event.row.type, config.formatSize(event.row.size), ...flags].join(' · ');
}

function animateHeight(root: HTMLElement, update: () => void): void {
  const box = must<HTMLElement>(root, '.explain-packet');
  const before = box.offsetHeight;
  box.getAnimations().forEach((animation) => animation.cancel());
  update();
  const after = box.offsetHeight;
  if (before !== after && !reducedMotion()) {
    box.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 420, easing: EASE_OUT });
  }
}

function fill(root: HTMLElement, view: View): void {
  const panel = must<HTMLElement>(root, '[data-view="overview"]');
  must(panel, 'h3').textContent = view.lesson.name;
  must(panel, '.overview-full').textContent = view.lesson.overview.full;
  must(panel, '.overview-desc').textContent = view.lesson.overview.description;
  must(panel, '.overview-facts').innerHTML = factsHtml(view.lesson.overview.facts);
  panel.hidden = view.view !== 'overview';
  const explain = must<HTMLElement>(root, '.explain');
  explain.hidden = view.view !== 'step';
  explain.classList.toggle('is-done', Boolean(view.content.done));
  must(explain, '.explain-label').textContent = view.content.label;
  must(explain, '.explain-title').textContent = view.content.title;
  must(explain, '.explain-sub').textContent = view.content.desc;
  must(explain, '.explain-text').textContent = view.content.text;
  must(explain, '.explain-facts').innerHTML = factsHtml(view.content.facts);
  explain.scrollTop = 0;
  if (view.packet) renderPacket(root, view.packet, view.lesson);
  must(root, '.explain-packet').classList.toggle('is-open', Boolean(view.packet));
}

const shown = new WeakMap<HTMLElement, View>();
const latest = new WeakMap<HTMLElement, View>();

export function renderOverview(root: HTMLElement, state: PlayerState, lesson: LessonLike<any>, order: number): void {
  const view = describe(state, lesson, order);
  const previous = shown.get(root);
  latest.set(root, view);
  const refill = () => fill(root, latest.get(root)!);
  swapText(must(root, '.panel-title'), view.title, !previous || view.rank >= previous.rank ? 1 : -1);
  const back = must<HTMLElement>(root, '.back-btn');
  const more = must<HTMLElement>(root, '.more');
  const isStep = view.view === 'step';
  if (back.hidden === isStep) {
    back.hidden = !isStep;
    more.hidden = isStep;
    if (!reducedMotion()) {
      (isStep ? back : more).animate([{ transform: 'translateX(14px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE_OUT });
    }
  }
  const stage = must<HTMLElement>(root, '.overview-stage');
  if (!previous) refill();
  else if (view.lesson !== previous.lesson) slideSwap(stage, refill, { direction: view.order > previous.order ? 1 : -1, distance: 32 });
  else if (view.view !== previous.view) slideSwap(stage, refill, { direction: isStep ? 1 : -1, distance: 32 });
  else if (isStep && view.rank !== previous.rank) slideSwap(must(root, '.explain'), refill, { direction: view.rank > previous.rank ? 1 : -1 });
  else if (isStep && view.packet?.number !== previous.packet?.number) {
    const box = must<HTMLElement>(root, '.explain-packet');
    if (view.packet && previous.packet) {
      slideSwap(must(box, '.explain-packet-inner'), () => {
        const next = latest.get(root)!;
        if (next.packet) animateHeight(root, () => renderPacket(root, next.packet!, next.lesson));
      }, { distance: 18 });
    } else {
      animateHeight(root, () => {
        if (view.packet) renderPacket(root, view.packet, view.lesson);
        box.classList.toggle('is-open', Boolean(view.packet));
      });
    }
  }
  shown.set(root, view);
}
