import './styles/tokens.css';
import './styles/app.css';
import { clock } from './core/clock';
import { must } from './core/dom';
import { applyLayout } from './core/layout';
import { createPlayer, type Player, type PlayerState } from './core/player';
import { configureProgress, loadSpeed, loadView, recordProgress, saveSpeed, saveTheme, saveView } from './core/progress';
import { createStage } from './scene/stage';
import { configureSite, type SiteConfig } from './site';
import type { LessonLike } from './types';
import { createInspector } from './ui/inspector';
import { overviewMarkup, renderOverview } from './ui/overview';
import { fitLabels, initSequence, renderSequence } from './ui/sequence';
import { initSidebar, moveTabIndicator, renderSidebar, renderStatuses, sidebarMarkup } from './ui/sidebar';
import { initViewSwitch, simulationMarkup, type ViewName } from './ui/simulation';
import { initTheme, moveLayerMarker, renderProgress, renderTopbar, topbarMarkup } from './ui/topbar';
import { initTrace, renderTrace, setSpeedLabel, traceMarkup, visibleRows } from './ui/trace';

/** 把一个站点配置跑起来。一个页面只运行一个站点。 */
export function createApp<L extends LessonLike<any>>(config: SiteConfig<L>): void {
configureSite(config);
configureProgress(config.storagePrefix);
const LESSONS = config.lessons;
const app = must<HTMLElement>(document, '#app');
app.innerHTML = `
  <div class="shell">
    ${topbarMarkup()}
    <main class="workspace">
      ${sidebarMarkup(LESSONS)}
      ${simulationMarkup()}
      ${overviewMarkup()}
      ${traceMarkup()}
    </main>
    <div class="scrim" aria-hidden="true"></div>
  </div>`;

const shell = must<HTMLElement>(app, '.shell');
const topbar = must<HTMLElement>(app, '.topbar');
const sidebar = must<HTMLElement>(app, '.sidebar');
const simulation = must<HTMLElement>(app, '.simulation');
const overview = must<HTMLElement>(app, '.overview');
const trace = must<HTMLElement>(app, '.packets');
const sequence = must<HTMLElement>(app, '.sequence');
const root = document.documentElement;

let lesson: L | null = null;
let player: Player | null = null;
let lastState: PlayerState | null = null;

const drawerOpen = () => shell.classList.contains('is-drawer-open');
const drawerButton = must<HTMLElement>(app, '.drawer-btn');

function setDrawer(open: boolean): void {
  const stacked = root.classList.contains('is-stacked');
  shell.classList.toggle('is-drawer-open', open);
  root.classList.toggle('is-locked', open);
  drawerButton.setAttribute('aria-expanded', String(open));
  sidebar.inert = stacked && !open;
  if (open) must<HTMLElement>(sidebar, '.drawer-close').focus({ preventScroll: true });
  else if (stacked && sidebar.contains(document.activeElement)) drawerButton.focus({ preventScroll: true });
}

function relayout(): void {
  const { stacked } = applyLayout(shell);
  if (stacked) sidebar.inert = !drawerOpen();
  else setDrawer(false);
  moveTabIndicator(sidebar);
  if (lesson) moveLayerMarker(topbar, lesson);
}

drawerButton.addEventListener('click', () => setDrawer(!drawerOpen()));
must(sidebar, '.drawer-close').addEventListener('click', () => setDrawer(false));
must(app, '.scrim').addEventListener('click', () => setDrawer(false));
relayout();
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', relayout);

initTheme(topbar, saveTheme);

const scene = createStage<L>(must<SVGSVGElement>(simulation, '.network'), config.stage);

const views = initViewSwitch(simulation, loadView() === 'sequence' ? 'sequence' : 'network', (view: ViewName, persist) => {
  player?.setMode(view);
  if (persist) saveView(view);
  if (view === 'sequence') {
    fitLabels(sequence);
    if (lastState && lesson) renderSequence(sequence, lastState, lesson);
  }
});

const inspector = createInspector(must<HTMLElement>(simulation, '.inspector'), {
  visible: () => visibleRows(trace),
  onChange(index) {
    app.querySelectorAll('.is-inspected').forEach((element) => element.classList.remove('is-inspected'));
    root.classList.toggle('is-inspecting', index !== null);
    if (index === null) return;
    app.querySelectorAll(`tr[data-packet="${index}"], .seq-arrow[data-packet="${index}"]`).forEach((element) => element.classList.add('is-inspected'));
    trace.querySelector(`tr[data-packet="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  },
});

function inspect(index: number): void {
  if (!lesson || !player) return;
  if (lastState?.playing || lastState?.running) player.pause();
  inspector.open(lesson, index);
}

initSequence(sequence, inspect);

function render(state: PlayerState, current: L): void {
  renderTopbar(topbar, state, current);
  renderSidebar(sidebar, state, current);
  renderOverview(overview, state, current, LESSONS.indexOf(current));
  renderTrace(trace, state, current);
  const open = inspector.index();
  if (open !== null && !visibleRows(trace).includes(open)) inspector.close();
  renderSequence(sequence, state, current);
}

function select(id: string): void {
  if (lesson?.id === id) {
    player?.reset();
    return;
  }
  inspector.close();
  player?.dispose();
  const next = LESSONS.find((item) => item.id === id)!;
  lesson = next;
  scene.load(next);
  player = createPlayer(next, scene, (state) => {
    lastState = state;
    if (recordProgress(next.id, next.steps.length, state)) {
      renderProgress(topbar, LESSONS);
      renderStatuses(sidebar);
    }
    render(state, next);
  }, { ...config.player, mode: views.view() });
  player.reset();
}

const closeDrawerSoon = () => {
  if (drawerOpen()) setTimeout(() => setDrawer(false), 220);
};

initSidebar(sidebar, {
  onSelect(id) {
    select(id);
    closeDrawerSoon();
  },
  onStep(step) {
    player?.jump(step);
    closeDrawerSoon();
  },
});

must<HTMLElement>(overview, '.back-btn').addEventListener('click', () => player?.reset());

const SPEEDS = [0.5, 1, 1.5, 2];

function setSpeed(speed: number, persist = true): void {
  clock.speed = speed;
  setSpeedLabel(trace, speed);
  if (persist) saveSpeed(speed);
}

const savedSpeed = loadSpeed();
if (SPEEDS.includes(savedSpeed)) setSpeed(savedSpeed, false);

function next(): void {
  if (!lastState?.started) player?.jump(0);
  else if (lesson && lastState.activeStep < lesson.steps.length - 1) player?.jump(lastState.activeStep + 1);
}

function previous(): void {
  if (!lastState?.started || !lesson) return;
  if (lastState.done) player?.jump(lesson.steps.length - 1);
  else if (lastState.activeStep > 0) player?.jump(lastState.activeStep - 1);
  else player?.reset();
}

initTrace(trace, {
  toggle: () => player?.toggle(),
  step: () => player?.step(),
  reset: () => player?.reset(),
  prev: previous,
  speed: () => setSpeed(SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length]),
  inspect,
});

const KEYS: Record<string, () => void> = {
  ' ': () => player?.toggle(),
  ArrowRight: () => (inspector.isOpen() ? inspector.step(1) : next()),
  ArrowLeft: () => (inspector.isOpen() ? inspector.step(-1) : previous()),
  Escape: () => (drawerOpen() ? setDrawer(false) : inspector.isOpen() ? inspector.close() : player?.reset()),
  v: () => views.toggle(),
  V: () => views.toggle(),
};

for (const type of ['keydown', 'keyup'] as const) {
  window.addEventListener(type, (event) => {
    const action = KEYS[event.key];
    if (!action || !player || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    if (type === 'keydown' && !event.repeat) action();
  });
}

renderProgress(topbar, LESSONS);
renderStatuses(sidebar);

void document.fonts.ready.then(() => {
  select(LESSONS[0].id);
  relayout();
  root.dataset.ready = '1';
});
}
