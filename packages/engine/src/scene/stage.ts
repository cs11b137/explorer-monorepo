import { clock, type Ctl } from '../core/clock';
import { svgEl } from '../core/dom';
import { timeline, type Scene } from '../core/player';
import { foldStates, type Color, type EventLike, type KnownEvent, type LessonLike, type PacketLike, type StreamLike } from '../types';

export const COLOR_VAR: Record<Color, string> = {
  blue: 'var(--c-blue)',
  green: 'var(--c-green)',
  amber: 'var(--c-amber)',
  violet: 'var(--c-violet)',
  teal: 'var(--c-teal)',
  slate: 'var(--c-slate)',
};

const VIEW = { width: 1000, height: 640 };
const SPEED_PX_MS = 0.21;
const TRAIL = [10, 20, 30];
const CAMERA_MS = 1100;
/** 画面顶部留给视图切换按钮的高度。 */
const TOP_RESERVE = 54;
/** 面板窄于这个宽度时放大文字，保证手机上也能看清。 */
const LABEL_BASE_WIDTH = 700;

export interface NodeSpec {
  art: string;
  labelY: number;
  radius: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 输入框：浮在某个节点上方的命令行。 */
export interface CommandConfig<L> {
  /** 输入框跟着哪个节点。 */
  anchor(lesson: L | null): string;
  prompt: string;
  textX?: number;
  boxPad?: number;
  checkPad?: number;
  typeMs?: number;
  /** 打完字后节点是否弹一下。 */
  bump?: boolean;
  place?(x: number, y: number, width: number, tagScale: number): { left: number; top: number; leader: string };
}

export interface StageConfig<L extends LessonLike<any> = LessonLike<any>> {
  nodeIds: readonly string[];
  specs: Record<string, NodeSpec>;
  ariaLabel: string;
  margin?: number;
  maxZoomWidth?: number;
  maxLabelScale?: number;
  /** 每个节点内多放的图层。 */
  nodeInner?: string;
  layers?: { afterNodes?: string; afterState?: string };
  /** 没有 state 事件的站点可以不要状态小卡这一层。 */
  stateLayer?: boolean;
  command?: CommandConfig<L> | false;
  /** render 事件时逐行画出屏幕的节点。 */
  screenNodes?: readonly string[];
  /** 相机不随事件移动：show、focus 只增减节点，画面始终框住全部内容。默认开启。 */
  fixedCamera?: boolean;
  /** 监听父元素的尺寸，而不是 SVG 本身。 */
  observeParent?: boolean;
  plugin?(api: StageApi<L>): StagePlugin<L>;
}

/** 插件能用到的场景能力。 */
export interface StageApi<L> {
  svg: SVGSVGElement;
  nodeEls: Record<string, SVGGElement>;
  bodyEls: Record<string, SVGGElement>;
  lesson(): L | null;
  events(): EventLike[];
  nodes(): readonly string[];
  visible(): ReadonlySet<string>;
  placeOf(id: string): [number, number];
  labelScale(): number;
  tagScale(): number;
  setView(view: number[]): void;
  frameFor(target: readonly string[] | 'all'): number[];
  frameTarget(): readonly string[] | 'all';
  moveCamera(target: readonly string[] | 'all', ms: number, ctl: Ctl): Promise<void>;
  fitBoxes(boxes: Box[]): number[];
  fitBounds(minX: number, minY: number, maxX: number, maxY: number, maxScale?: number): number[];
  /** 节点位置变了：重新摆放节点、重算通道。 */
  replace(): void;
  /** 正在播放动画，而不是跳步。 */
  isLive(): boolean;
}

/** 站点对场景的扩展。全部可选，不提供时就是引擎的默认行为。 */
export interface StagePlugin<L> {
  placeOf?(id: string, base: [number, number]): [number, number];
  radiusOf?(id: string): number;
  labelPoint?(id: string): [number, number];
  bodyBox?(id: string): { x: number; y: number; width: number; height: number };
  /** 返回视野就完全接管取景。返回 null 走默认。 */
  frame?(target: readonly string[] | 'all'): number[] | null;
  /** 往取景范围里加东西。 */
  frameBoxes?(target: readonly string[] | 'all', list: readonly string[], boxes: Box[]): void;
  maxLabelScale?(): number;
  canBump?(id: string): boolean;
  /** 换课时调用，此时节点还没摆放。 */
  load?(lesson: L, events: EventLike[]): void;
  /** 把事件序列折叠到 end，更新站点自己的图层。 */
  render?(end: number): void;
  /** 尺寸变化：取景之前。 */
  beforeFit?(): void;
  /** 尺寸变化：文字缩放之后、取景之前。 */
  afterText?(): void;
  /** 尺寸变化：取景和状态小卡都更新之后。 */
  afterFit?(end: number): void;
  /** 引擎不认识的事件。 */
  run?(event: EventLike, ctl: Ctl): Promise<void> | undefined;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const overshoot = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;

type Line = [number, number, number, number];
const along = ([x1, y1, x2, y2]: Line, t: number) => ({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
const lengthOf = ([x1, y1, x2, y2]: Line) => Math.hypot(x2 - x1, y2 - y1);

function defs(): string {
  const colors: Array<[string, string]> = [['idle', 'var(--lane)'], ...Object.entries(COLOR_VAR)];
  const heads = colors
    .map(([name, fill]) => `<marker id="head-${name}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${name === 'idle' ? 5 : 4.4}" markerHeight="${name === 'idle' ? 5 : 4.4}" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${fill}"/></marker>`)
    .join('');
  return `<defs>
    ${heads}
    <pattern id="iso-grid" width="86.6" height="50" patternUnits="userSpaceOnUse">
      <path d="M0,25 L43.3,0 L86.6,25 L43.3,50 Z" fill="none" stroke="var(--grid)" stroke-width="1"/>
    </pattern>
    <radialGradient id="grid-vignette" cx="50%" cy="50%" r="62%">
      <stop offset="0.25" stop-color="var(--panel)" stop-opacity="0"/>
      <stop offset="1" stop-color="var(--panel)" stop-opacity="1"/>
    </radialGradient>
    <linearGradient id="shadow-fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--shadow)" stop-opacity="0.26"/>
      <stop offset="1" stop-color="var(--shadow)" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="shadow-round">
      <stop offset="0" stop-color="var(--shadow)" stop-opacity="0.24"/>
      <stop offset="1" stop-color="var(--shadow)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="face-top" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--face-top-1)"/><stop offset="1" stop-color="var(--face-top-2)"/>
    </linearGradient>
    <linearGradient id="face-left" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--face-left-1)"/><stop offset="1" stop-color="var(--face-left-2)"/>
    </linearGradient>
    <linearGradient id="face-right" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--face-right-1)"/><stop offset="1" stop-color="var(--face-right-2)"/>
    </linearGradient>
  </defs>`;
}

export function stageMarkup<L extends LessonLike<any>>(config: StageConfig<L>): string {
  const command = config.command || null;
  const textX = command?.textX ?? 25;
  const NODE_SPECS = config.specs;
  const nodes = config.nodeIds.map(
    (id) => `<g class="node" data-node="${id}" style="opacity:0"><g class="node-body">
      <g class="device">${NODE_SPECS[id].art}</g>${config.nodeInner ? `\n      ${config.nodeInner}` : ''}
      <g class="node-label"><text class="node-name" text-anchor="middle" y="${NODE_SPECS[id].labelY}"></text><text class="node-sub" text-anchor="middle" y="${NODE_SPECS[id].labelY + 18}"></text></g>
    </g></g>`,
  ).join('');
  return `<svg class="network" viewBox="0 0 ${VIEW.width} ${VIEW.height}" preserveAspectRatio="xMidYMid meet" aria-label="${config.ariaLabel}" role="img">
    ${defs()}
    <rect x="-1500" y="-1200" width="4000" height="3000" fill="url(#iso-grid)"/>
    <rect x="-1500" y="-1200" width="4000" height="3000" fill="url(#grid-vignette)"/>
    <g class="lanes"></g>
    <g class="pulse-layer"></g>
    <g class="nodes">${nodes}</g>${config.layers?.afterNodes ? `\n    ${config.layers.afterNodes}` : ''}${config.stateLayer === false ? '' : '\n    <g class="state-layer"></g>'}${config.layers?.afterState ? `\n    ${config.layers.afterState}` : ''}
    <g class="packet-layer"></g>
    <g class="note-layer"></g>${command ? `
    <g class="cmd-holder"><g class="cmd-bar">
      <path class="cmd-leader" d=""/>
      <rect class="cmd-box" width="168" height="28" rx="3"/>
      <text class="cmd-prompt" x="11" y="14.5" dominant-baseline="central">${command.prompt}</text>
      <text class="cmd-text" x="${textX}" y="14.5" dominant-baseline="central"></text>
      <rect class="cmd-caret" y="7" width="7" height="15"/>
      <path class="cmd-check" d="M0,15 l4,4 l8,-9" pathLength="1"/>
    </g></g>` : ''}
  </svg>`;
}

export interface StageScene<L> extends Scene {
  load(lesson: L): void;
}

interface Snapshot {
  view: number[];
  visible: Set<string>;
  lanes: Set<string>;
  screen: boolean;
  fresh: boolean;
}

export function createStage<L extends LessonLike<any>>(svg: SVGSVGElement, config: StageConfig<L>): StageScene<L> {
  const NODE_IDS = config.nodeIds;
  const NODE_SPECS = config.specs;
  const MARGIN = config.margin ?? 16;
  const MAX_ZOOM_WIDTH = config.maxZoomWidth ?? 470;
  const MAX_LABEL_SCALE = config.maxLabelScale ?? 1.8;
  const fixedCamera = config.fixedCamera ?? true;
  const command = config.command || null;
  const textX = command?.textX ?? 25;
  const nodeEls = Object.fromEntries(NODE_IDS.map((id) => [id, svg.querySelector<SVGGElement>(`.node[data-node="${id}"]`)!])) as Record<string, SVGGElement>;
  const bodyEls = Object.fromEntries(NODE_IDS.map((id) => [id, nodeEls[id].querySelector<SVGGElement>('.node-body')!])) as Record<string, SVGGElement>;
  const lanesEl = svg.querySelector<SVGGElement>('.lanes')!;
  const pulseLayer = svg.querySelector<SVGGElement>('.pulse-layer')!;
  const packetLayer = svg.querySelector<SVGGElement>('.packet-layer')!;
  const noteLayer = svg.querySelector<SVGGElement>('.note-layer')!;
  const stateLayer = svg.querySelector<SVGGElement>('.state-layer');
  // 没有输入框的站点不会收到 type 事件，这几个元素也就不会被用到。
  const cmdHolder = svg.querySelector<SVGGElement>('.cmd-holder')!;
  const cmdBar = svg.querySelector<SVGGElement>('.cmd-bar')!;
  const cmdBox = svg.querySelector<SVGRectElement>('.cmd-box')!;
  const cmdText = svg.querySelector<SVGTextElement>('.cmd-text')!;
  const cmdCaret = svg.querySelector<SVGRectElement>('.cmd-caret')!;
  const cmdCheck = svg.querySelector<SVGPathElement>('.cmd-check')!;
  const cmdLeader = svg.querySelector<SVGPathElement>('.cmd-leader')!;
  const screenLines = () => (config.screenNodes ?? []).flatMap((id) => [...nodeEls[id].querySelectorAll<SVGPolylineElement>('.screen-line')]);

  let lesson: L | null = null;
  let events: EventLike[] = [];
  let laneGeo = new Map<string, Line>();
  let laneEls = new Map<string, SVGPathElement>();
  const visible = new Set<string>();
  const shownLanes = new Set<string>();
  const laneUse = new Map<string, number>();
  let lessonNodes: readonly string[] = [];
  let frameNodes: readonly string[] | 'all' = 'all';
  let view = [0, 0, VIEW.width, VIEW.height];
  let screen = true;
  let everMorphed = false;
  let cameraCtl: Ctl = { cancelled: false };
  let labelScale = 1;
  let tagScale = 1;
  const panelMemo = new Map<string, string>();
  let lastPanelEnd = 0;
  let live = false;

  const placeOf = (id: string): [number, number] => {
    const base: [number, number] = lesson?.place[id] ?? [500, 320];
    return plugin.placeOf?.(id, base) ?? base;
  };
  const radiusOf = (id: string): number => plugin.radiusOf?.(id) ?? NODE_SPECS[id].radius;
  const labelPoint = (id: string): [number, number] => plugin.labelPoint?.(id) ?? [0, NODE_SPECS[id].labelY];
  const bodyBox = (id: string) => plugin.bodyBox?.(id) ?? bodyEls[id].getBBox();
  const canBump = (id: string): boolean => plugin.canBump?.(id) ?? true;

  function setView(next: number[]): void {
    view = next;
    svg.setAttribute('viewBox', next.map((value) => value.toFixed(2)).join(' '));
  }

  /** 把一块范围放进画面。maxScale 限制最大放大倍数，默认由 maxZoomWidth 决定，避免设备被放得过大。 */
  function fitBounds(minX: number, minY: number, maxX: number, maxY: number, maxScale?: number): number[] {
    const rect = svg.getBoundingClientRect();
    const width = rect.width || VIEW.width;
    const height = rect.height || VIEW.height;
    const usable = Math.max(height - TOP_RESERVE, height * 0.6);
    const scale = Math.min(width / (maxX - minX), usable / (maxY - minY), maxScale ?? width / MAX_ZOOM_WIDTH);
    const reserve = height - usable;
    const top = (minY + maxY) / 2 - usable / scale / 2 - reserve / scale;
    return [(minX + maxX) / 2 - width / scale / 2, top, width / scale, height / scale];
  }

  function fitBoxes(boxes: Box[]): number[] {
    const minX = Math.min(...boxes.map((b) => b.x)) - MARGIN;
    const minY = Math.min(...boxes.map((b) => b.y)) - MARGIN;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + MARGIN;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + MARGIN;
    return fitBounds(minX, minY, maxX, maxY);
  }

  /** 让选中的节点填满画面。 */
  function frameFor(target: readonly string[] | 'all'): number[] {
    const custom = plugin.frame?.(target);
    if (custom) return custom;
    const list = (target === 'all' ? lessonNodes : target).filter((id) => lessonNodes.includes(id));
    const boxes = list.map((id) => {
      const [x, y] = placeOf(id);
      const b = bodyBox(id);
      return { x: x + b.x, y: y + b.y, w: b.width, h: b.height };
    });
    plugin.frameBoxes?.(target, list, boxes);
    return fitBoxes(boxes);
  }

  function setFrame(target: readonly string[] | 'all'): void {
    frameNodes = target;
  }

  async function moveCamera(target: readonly string[] | 'all', ms: number, ctl: Ctl, from?: number[]): Promise<void> {
    setFrame(target);
    cameraCtl.cancelled = true;
    const own: Ctl = (cameraCtl = { cancelled: false });
    const start = from ?? view;
    const end = frameFor(target);
    await clock.tween(ms, { get cancelled() { return ctl.cancelled || own.cancelled; } }, (t) => {
      const eased = easeInOut(t);
      setView(start.map((value, index) => value + (end[index] - value) * eased));
    });
  }

  function fitText(): void {
    const width = svg.getBoundingClientRect().width;
    const next = width ? Math.min(plugin.maxLabelScale?.() ?? MAX_LABEL_SCALE, Math.max(1, LABEL_BASE_WIDTH / width)) : 1;
    if (Math.abs(next - labelScale) < 0.01) return;
    labelScale = next;
    tagScale = 1 + (next - 1) * 0.6;
    for (const id of NODE_IDS) applyLabelScale(id);
  }

  function applyLabelScale(id: string): void {
    const [x, ly] = labelPoint(id);
    const y = ly - 12;
    nodeEls[id].querySelector('.node-label')!.setAttribute('transform', `translate(${x} ${y}) scale(${labelScale.toFixed(3)}) translate(${-x} ${-y})`);
  }

  function refit(): void {
    if (!lesson) return;
    cameraCtl.cancelled = true;
    plugin.beforeFit?.();
    fitText();
    plugin.afterText?.();
    setView(frameFor(frameNodes));
    if (cmdText?.textContent) placeCommandBar();
    panelMemo.clear();
    stateLayer?.replaceChildren();
    renderPanels(lastPanelEnd);
    plugin.afterFit?.(lastPanelEnd);
  }

  function setNode(id: string, on: boolean): void {
    if (on) visible.add(id);
    else visible.delete(id);
    nodeEls[id].style.opacity = on ? '1' : '0';
    bodyEls[id].removeAttribute('transform');
  }

  async function dropIn(id: string, ctl: Ctl, delay = 0, ring = true): Promise<void> {
    visible.add(id);
    nodeEls[id].style.opacity = '0';
    if (delay) await clock.wait(delay, ctl);
    await clock.tween(650, ctl, (t) => {
      bodyEls[id].setAttribute('transform', `translate(0 ${(-46 * (1 - overshoot(t))).toFixed(2)})`);
      nodeEls[id].style.opacity = String(Math.min(1, t * 2.4));
    });
    if (ctl.cancelled) return;
    nodeEls[id].style.opacity = '1';
    bodyEls[id].removeAttribute('transform');
    if (ring) void pulse(id, 'var(--ink-strong)', ctl);
  }

  async function liftOut(id: string, ctl: Ctl, delay = 0): Promise<void> {
    visible.delete(id);
    nodeEls[id].style.opacity = '1';
    if (delay) await clock.wait(delay, ctl);
    await clock.tween(380, ctl, (t) => {
      bodyEls[id].setAttribute('transform', `translate(0 ${(-30 * easeIn(t)).toFixed(2)})`);
      nodeEls[id].style.opacity = String(1 - t);
    });
    if (ctl.cancelled) return;
    bodyEls[id].removeAttribute('transform');
    nodeEls[id].style.opacity = '0';
  }

  function bump(id: string, ctl: Ctl): void {
    void clock.tween(340, ctl, (t) => {
      if (t < 1) bodyEls[id].setAttribute('transform', `translate(0 ${(-5 * Math.sin(Math.PI * t)).toFixed(2)})`);
      else bodyEls[id].removeAttribute('transform');
    });
  }

  async function pulse(id: string, color: string, ctl: Ctl, at?: [number, number]): Promise<void> {
    const [px, py] = placeOf(id);
    const x = px + (at?.[0] ?? 0);
    const y = py + (at?.[1] ?? 0);
    const ring = svgEl('circle', { cx: x, cy: y, fill: 'none', stroke: color, 'stroke-width': 2 }, pulseLayer);
    await clock.tween(700, ctl, (t) => {
      ring.setAttribute('r', String(at ? 8 + t * 28 : 14 + t * 46));
      ring.setAttribute('opacity', String(0.6 * (1 - t)));
    });
    ring.remove();
  }

  function drawLane(key: string, amount: number): void {
    const line = laneGeo.get(key)!;
    const path = laneEls.get(key)!;
    const end = along(line, amount);
    path.setAttribute('d', `M${line[0].toFixed(1)},${line[1].toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`);
    path.style.visibility = amount > 0.01 ? '' : 'hidden';
  }

  async function revealLane(key: string, on: boolean, ctl: Ctl, delay = 0): Promise<void> {
    drawLane(key, on ? 0 : 1);
    if (delay) await clock.wait(delay, ctl);
    await clock.tween(on ? 520 : 300, ctl, (t) => drawLane(key, on ? easeOut(t) : 1 - easeIn(t)));
  }

  function syncLanes(ctl?: Ctl, delay = 0): void {
    for (const key of laneGeo.keys()) {
      const [from, to] = key.split('>');
      const want = visible.has(from) && visible.has(to);
      const changed = want !== shownLanes.has(key);
      if (want) shownLanes.add(key);
      else shownLanes.delete(key);
      if (ctl) {
        if (changed) void revealLane(key, want, ctl, delay);
      } else drawLane(key, want ? 1 : 0);
    }
  }

  function setScreen(on: boolean): void {
    screen = on;
    for (const line of screenLines()) {
      line.style.strokeDasharray = '1';
      line.style.strokeDashoffset = on ? '0' : '1';
      line.style.opacity = on ? '1' : '0';
    }
  }

  async function drawScreen(on: boolean, ctl: Ctl, delay = 0): Promise<void> {
    setScreen(!on);
    screen = on;
    if (delay) await clock.wait(delay, ctl);
    const lines = on ? screenLines() : screenLines().reverse();
    for (const line of lines) {
      if (ctl.cancelled) return;
      line.style.opacity = '1';
      await clock.tween(on ? 200 : 90, ctl, (t) => {
        const amount = on ? easeOut(t) : 1 - t;
        line.style.strokeDashoffset = String(1 - amount);
      });
      if (!on) line.style.opacity = '0';
    }
  }

  function placeCommandBar(): void {
    const [x, y] = placeOf(command!.anchor(lesson));
    const width = Number(cmdBox.getAttribute('width'));
    const { left, top, leader } = command!.place?.(x, y, width, tagScale) ?? {
      left: x + 66 - width * tagScale,
      top: y - 106 - 28 * tagScale,
      leader: `M${width - 40},28 L${width - 34},42`,
    };
    cmdHolder.setAttribute('transform', `translate(${left.toFixed(1)} ${top.toFixed(1)}) scale(${tagScale.toFixed(3)})`);
    cmdLeader.setAttribute('d', leader);
  }

  function setCommand(text: string): void {
    cmdBar.classList.remove('is-typing');
    cmdText.textContent = text;
    const length = cmdText.getComputedTextLength();
    cmdBox.setAttribute('width', (length + (command!.boxPad ?? 58)).toFixed(1));
    cmdCheck.setAttribute('transform', `translate(${(length + (command!.checkPad ?? 36)).toFixed(1)} 0)`);
    placeCommandBar();
  }

  function hideCommand(): void {
    if (!command) return;
    cmdBar.classList.remove('is-visible', 'is-typing', 'is-done');
    cmdText.textContent = '';
  }

  async function typeCommand(text: string, ctl: Ctl): Promise<void> {
    setCommand(text);
    cmdText.textContent = '';
    cmdCaret.setAttribute('x', String(textX));
    cmdBar.classList.add('is-visible', 'is-typing');
    await clock.wait(400, ctl);
    for (let count = 1; count <= text.length; count++) {
      if (ctl.cancelled) return;
      cmdText.textContent = text.slice(0, count);
      cmdCaret.setAttribute('x', String(textX + 1 + cmdText.getComputedTextLength()));
      await clock.wait(command!.typeMs ?? 55, ctl);
    }
    if (ctl.cancelled) return;
    cmdBar.classList.remove('is-typing');
    if (command!.bump !== false) bump(command!.anchor(lesson), ctl);
    await clock.wait(500, ctl);
  }

  async function runRender(ctl: Ctl): Promise<void> {
    await clock.wait(200, ctl);
    await drawScreen(true, ctl);
    if (ctl.cancelled) return;
    cmdBar.classList.add('is-done');
    void pulse(command!.anchor(lesson), 'var(--c-green)', ctl);
    await clock.wait(500, ctl);
  }

  function setLaneActive(key: string, color?: Color): void {
    const path = laneEls.get(key);
    if (!path) return;
    path.classList.toggle('is-active', Boolean(color));
    path.style.stroke = color ? COLOR_VAR[color] : '';
    path.setAttribute('marker-end', `url(#head-${color ?? 'idle'})`);
  }

  function holdLane(key: string, color: Color): void {
    laneUse.set(key, (laneUse.get(key) ?? 0) + 1);
    setLaneActive(key, color);
  }

  function releaseLane(key: string): void {
    const count = Math.max(0, (laneUse.get(key) ?? 0) - 1);
    laneUse.set(key, count);
    if (!count) setLaneActive(key);
  }

  function buildTag(event: PacketLike) {
    const color = COLOR_VAR[event.color];
    const trail = TRAIL.map((_, index) => svgEl('circle', { r: 3.6 - index, fill: color, opacity: 0.45 - index * 0.12 }, packetLayer));
    const group = svgEl('g', { class: 'packet' }, packetLayer);
    svgEl('circle', { r: 13, fill: color, opacity: 0.18 }, group);
    svgEl('circle', { r: 6, fill: color, stroke: 'var(--panel)', 'stroke-width': 2 }, group);
    const lock = event.locked ? 14 : 0;
    const bodyHeight = event.payload.length ? event.payload.length * 15 + 9 : 0;
    const tag = svgEl('g', { class: `packet-tag ${event.color}`, transform: `translate(0 -16) scale(${tagScale.toFixed(3)})` }, group);
    const lines = event.payload.map((text, index) => {
      const line = svgEl('text', { y: -bodyHeight + 6 + index * 15, 'dominant-baseline': 'hanging', class: 'packet-field' }, tag);
      line.textContent = text;
      return line;
    });
    const label = svgEl('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', x: lock / 2, y: -bodyHeight - 10.5, class: 'packet-label' }, tag);
    label.textContent = event.label;
    const labelWidth = Math.max(label.getComputedTextLength(), event.label.length * 7.6);
    const width = Math.max(labelWidth + 16 + lock, ...lines.map((line) => line.getComputedTextLength() + 16));
    lines.forEach((line) => line.setAttribute('x', String(-width / 2 + 8)));
    tag.insertBefore(svgEl('rect', { x: -width / 2, y: -bodyHeight - 22, width, height: 22, rx: 3, fill: color }), label);
    if (bodyHeight) {
      tag.insertBefore(svgEl('rect', { x: -width / 2, y: -bodyHeight - 4, width, height: bodyHeight + 4, rx: 3, class: 'packet-body', stroke: color }), tag.firstChild);
    }
    if (lock) {
      const at = -labelWidth / 2 - 4;
      svgEl('path', { class: 'packet-lock', d: `M${at - 6},${-bodyHeight - 10} v-2.4 a3,3 0 0 1 6,0 v2.4 M${at - 7.5},${-bodyHeight - 10} h9 v6.5 h-9 z` }, tag);
    }
    return { group, trail };
  }

  const place = (element: SVGGElement, point: { x: number; y: number }, scale = 1) =>
    element.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) scale(${scale.toFixed(3)})`);

  /** 瞄准某一格的事件走专门的直线，起点和终点按设备半径或格子位置决定。 */
  function aimedLine(event: PacketLike): Line {
    const [fx, fy] = placeOf(event.from);
    const [tx, ty] = placeOf(event.to);
    const ax = fx + (event.fromAt?.[0] ?? 0);
    const ay = fy + (event.fromAt?.[1] ?? 0);
    const bx = tx + (event.toAt?.[0] ?? 0);
    const by = ty + (event.toAt?.[1] ?? 0);
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / length;
    const uy = (by - ay) / length;
    const startClip = event.fromAt ? 4 : Math.min(radiusOf(event.from), length * 0.4);
    const endClip = event.toAt ? 6 : Math.min(radiusOf(event.to), length * 0.4);
    return [ax + ux * startClip, ay + uy * startClip, bx - ux * endClip, by - uy * endClip];
  }

  async function runPacket(event: PacketLike, ctl: Ctl): Promise<void> {
    const key = `${event.from}>${event.to}`;
    const aimed = Boolean(event.fromAt || event.toAt);
    const line = aimed ? aimedLine(event) : laneGeo.get(key);
    if (!line) throw new Error(`${lesson?.id}: 没有通道 ${key}`);
    const speed = event.quick ? SPEED_PX_MS * 2.4 : SPEED_PX_MS;
    const share = event.lost ? 0.55 : 1;
    if (!aimed) holdLane(key, event.color);
    const guide = aimed
      ? svgEl('path', { class: 'lane is-active', d: `M${line[0].toFixed(1)},${line[1].toFixed(1)} L${line[2].toFixed(1)},${line[3].toFixed(1)}`, style: `stroke:${COLOR_VAR[event.color]}`, 'marker-end': `url(#head-${event.color})` }, packetLayer)
      : null;
    const tag = buildTag(event);
    const start = along(line, 0);
    place(tag.group, start, 0);
    // 拖尾的圆点一开始就放在起点，否则第一帧会闪现在坐标原点。
    tag.trail.forEach((dot) => {
      dot.setAttribute('cx', String(start.x));
      dot.setAttribute('cy', String(start.y));
    });
    const cleanup = () => {
      tag.group.remove();
      tag.trail.forEach((dot) => dot.remove());
      guide?.remove();
    };
    await clock.tween(event.quick ? 140 : 220, ctl, (t) => place(tag.group, start, overshoot(t)));
    let at = start;
    await clock.tween((lengthOf(line) * share) / speed, ctl, (t) => {
      at = along(line, t * share);
      place(tag.group, at);
      tag.trail.forEach((dot, index) => {
        const back = along(line, Math.max(0, t * share - TRAIL[index] / lengthOf(line)));
        dot.setAttribute('cx', String(back.x));
        dot.setAttribute('cy', String(back.y));
      });
    });
    if (ctl.cancelled) return cleanup();
    if (event.lost) {
      const cross = svgEl('path', { class: 'drop-cross', d: 'M-6,-6 L6,6 M6,-6 L-6,6', transform: `translate(${at.x} ${at.y})` }, packetLayer);
      await clock.tween(520, ctl, (t) => {
        place(tag.group, { x: at.x, y: at.y + 26 * easeIn(t) }, 1 - 0.4 * t);
        tag.group.style.opacity = String(1 - t);
        tag.trail.forEach((dot) => dot.setAttribute('opacity', String(0.3 * (1 - t))));
        cross.setAttribute('transform', `translate(${at.x} ${at.y}) scale(${overshoot(Math.min(1, t * 2)).toFixed(3)})`);
      });
      cleanup();
      if (!aimed) releaseLane(key);
      await clock.wait(500, ctl);
      await clock.tween(250, ctl, (t) => (cross.style.opacity = String(1 - t)));
      cross.remove();
      return;
    }
    if (canBump(event.to)) bump(event.to, ctl);
    void pulse(event.to, COLOR_VAR[event.color], ctl, event.toAt);
    await clock.tween(180, ctl, (t) => {
      place(tag.group, at, 1 - easeIn(t));
      tag.trail.forEach((dot) => dot.setAttribute('opacity', String(0.3 * (1 - t))));
    });
    cleanup();
    if (!aimed) releaseLane(key);
    await clock.wait(150, ctl);
  }

  async function runStream(event: StreamLike, ctl: Ctl): Promise<void> {
    const running: Array<Promise<void>> = [];
    for (const [index, packet] of event.packets.entries()) {
      if (ctl.cancelled) return;
      running.push(runPacket(packet, ctl));
      if (index < event.packets.length - 1) await clock.wait(event.spacing ?? 480, ctl);
    }
    await Promise.all(running);
  }

  async function runNote(event: Extract<KnownEvent, { type: 'note' }>, ctl: Ctl): Promise<void> {
    const [x, y] = placeOf(event.at);
    const body = bodyBox(event.at);
    const holder = svgEl('g', { transform: `translate(${x} ${y + body.y + 2}) scale(${tagScale.toFixed(3)})` }, noteLayer);
    const group = svgEl('g', { class: `note ${event.tone ?? 'navy'}` }, holder);
    const text = svgEl('text', { class: 'note-text', 'dominant-baseline': 'central' }, group);
    text.textContent = event.text;
    const width = text.getComputedTextLength() + 30;
    const left = -width / 2;
    text.setAttribute('x', String(left + 23));
    text.setAttribute('y', '-25');
    group.insertBefore(svgEl('circle', { class: 'note-dot', cx: left + 13, cy: -25, r: 3.5 }), text);
    group.insertBefore(
      svgEl('path', { class: 'note-box', d: `M${left},-38 h${width} v26 h${-width / 2 + 7} l-7,8 l-7,-8 h${-width / 2 + 7} z` }),
      group.firstChild,
    );
    if (canBump(event.at)) bump(event.at, ctl);
    await clock.tween(320, ctl, (t) => group.setAttribute('transform', `scale(${overshoot(t).toFixed(3)})`));
    await clock.wait(1500, ctl);
    await clock.tween(200, ctl, (t) => {
      group.setAttribute('transform', `scale(${(1 - easeIn(t) * 0.3).toFixed(3)})`);
      group.style.opacity = String(1 - t);
    });
    holder.remove();
  }

  async function runShow(nodes: string[], frame: string[] | undefined, ctl: Ctl): Promise<void> {
    const camera = fixedCamera ? null : moveCamera(frame ?? 'all', CAMERA_MS, ctl);
    if (!fixedCamera) await clock.wait(CAMERA_MS * 0.45, ctl);
    for (const [index, id] of nodes.entries()) {
      if (ctl.cancelled) return;
      const drop = dropIn(id, ctl);
      if (index === nodes.length - 1) await drop;
      else await clock.wait(200, ctl);
    }
    if (ctl.cancelled) return;
    syncLanes(ctl);
    if (camera) await camera;
    await clock.wait(300, ctl);
  }

  async function runFocus(nodes: string[], frame: string[] | undefined, ctl: Ctl): Promise<void> {
    const leaving = NODE_IDS.filter((id) => visible.has(id) && !nodes.includes(id));
    leaving.forEach((id) => visible.delete(id));
    syncLanes(ctl);
    void drawScreen(false, ctl);
    leaving.forEach((id, index) => void liftOut(id, ctl, 120 + index * 70));
    if (fixedCamera) {
      await clock.wait(400, ctl);
      return;
    }
    await clock.wait(250, ctl);
    await moveCamera(frame ?? nodes, CAMERA_MS, ctl);
    await clock.wait(250, ctl);
  }

  /** 重画节点旁的状态小卡（TLB、CR3、运行队列等）。内容没变时不动。 */
  function renderPanels(end: number): void {
    lastPanelEnd = end;
    if (!stateLayer) return;
    const panels = foldStates(events, end);
    for (const id of NODE_IDS) {
      const panel = panels.get(id);
      const memo = panel && Object.keys(panel).length ? JSON.stringify(panel) : '';
      if (panelMemo.get(id) === memo) continue;
      panelMemo.set(id, memo);
      stateLayer.querySelector(`[data-panel="${id}"]`)?.remove();
      if (!panel || !memo) continue;
      const [x, y] = placeOf(id);
      const body = bodyBox(id);
      const group = svgEl('g', { class: 'state-panel', 'data-panel': id }, stateLayer);
      const entries = Object.entries(panel).slice(0, 4);
      const texts = entries.map(([key, value], index) => {
        const name = svgEl('text', { class: 'state-key', x: 8, y: 13 + index * 16, 'dominant-baseline': 'central' }, group);
        name.textContent = key;
        const shown = svgEl('text', { class: 'state-value', y: 13 + index * 16, 'dominant-baseline': 'central' }, group);
        shown.textContent = value;
        return { name, shown };
      });
      const keyWidth = Math.max(...texts.map((item) => item.name.getComputedTextLength()));
      const valueWidth = Math.max(...texts.map((item) => item.shown.getComputedTextLength()));
      texts.forEach((item) => item.shown.setAttribute('x', String(16 + keyWidth)));
      group.insertBefore(svgEl('rect', { class: 'state-box', width: keyWidth + valueWidth + 26, height: entries.length * 16 + 10, rx: 3 }), group.firstChild);
      const toLeft = x > 620;
      const boxWidth = (keyWidth + valueWidth + 26) * tagScale;
      const px = toLeft ? x + body.x - boxWidth - 8 : x + body.x + body.width + 8;
      group.setAttribute('transform', `translate(${px.toFixed(1)} ${(y + body.y).toFixed(1)}) scale(${tagScale.toFixed(3)})`);
      group.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240 });
    }
  }

  function clearPanels(): void {
    stateLayer?.replaceChildren();
    panelMemo.clear();
  }

  function placeNodes(): void {
    for (const id of NODE_IDS) {
      const [x, y] = placeOf(id);
      nodeEls[id].setAttribute('transform', `translate(${x} ${y})`);
    }
  }

  /** 按当前的节点位置重算每条通道。往返两条通道各偏向一侧；单向通道也保持同样的偏移。 */
  function buildLanes(): void {
    for (const key of laneGeo.keys()) {
      const [from, to] = key.split('>');
      const [x1, y1] = placeOf(from);
      const [x2, y2] = placeOf(to);
      const length = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / length;
      const uy = (y2 - y1) / length;
      const nx = -uy * 9;
      const ny = ux * 9;
      laneGeo.set(key, [
        x1 + ux * radiusOf(from) + nx,
        y1 + uy * radiusOf(from) + ny,
        x2 - ux * radiusOf(to) + nx,
        y2 - uy * radiusOf(to) + ny,
      ]);
    }
  }

  const plugin: StagePlugin<L> = config.plugin?.({
    svg,
    nodeEls,
    bodyEls,
    lesson: () => lesson,
    events: () => events,
    nodes: () => lessonNodes,
    visible: () => visible,
    placeOf,
    labelScale: () => labelScale,
    tagScale: () => tagScale,
    setView,
    frameFor,
    frameTarget: () => frameNodes,
    moveCamera,
    fitBoxes,
    fitBounds,
    replace() {
      placeNodes();
      buildLanes();
      syncLanes();
    },
    isLive: () => live,
  }) ?? {};

  new ResizeObserver(refit).observe(config.observeParent ? svg.parentElement! : svg);

  return {
    load(next) {
      // 不同课程的节点位置不同。先全部隐藏，再由 morph 逐个落入，避免节点跳位。
      NODE_IDS.forEach((id) => setNode(id, false));
      everMorphed = false;
      lesson = next;
      events = timeline(next);
      lessonNodes = next.nodes;
      laneEls = new Map();
      laneGeo = new Map();
      shownLanes.clear();
      laneUse.clear();
      lanesEl.replaceChildren();
      clearPanels();
      plugin.load?.(next, events);
      placeNodes();
      for (const id of NODE_IDS) {
        const [name, sub] = next.labels[id] ?? ['', ''];
        const nameEl = nodeEls[id].querySelector('.node-name')!;
        const subEl = nodeEls[id].querySelector('.node-sub')!;
        nameEl.textContent = name;
        subEl.textContent = sub;
        if (plugin.labelPoint) {
          const [lx, ly] = labelPoint(id);
          nameEl.setAttribute('x', String(lx));
          nameEl.setAttribute('y', String(ly));
          subEl.setAttribute('x', String(lx));
          subEl.setAttribute('y', String(ly + 18));
          applyLabelScale(id);
        }
      }
      fitText();
      // 只为本课真正用到的方向建通道。
      const used = new Set<string>();
      for (const step of next.steps) {
        for (const event of step.events as KnownEvent[]) {
          const packets = event.type === 'packet' ? [event] : event.type === 'stream' ? event.packets : [];
          for (const packet of packets) used.add(`${packet.from}>${packet.to}`);
        }
      }
      for (const key of used) {
        laneGeo.set(key, [0, 0, 0, 0]);
        const path = svgEl('path', { class: 'lane', 'data-lane': key, 'marker-end': 'url(#head-idle)' }, lanesEl);
        laneEls.set(key, path);
      }
      buildLanes();
      packetLayer.replaceChildren();
      noteLayer.replaceChildren();
    },
    run(raw: EventLike, ctl) {
      live = true;
      const event = raw as KnownEvent;
      switch (event.type) {
        case 'packet':
          return runPacket(event, ctl);
        case 'stream':
          return runStream(event, ctl);
        case 'type':
          return typeCommand(event.text, ctl);
        case 'focus':
          return runFocus(event.nodes, event.frame, ctl);
        case 'show':
          return runShow(event.nodes, event.frame, ctl);
        case 'camera':
          return moveCamera(event.frame ?? 'all', CAMERA_MS, ctl);
        case 'render':
          return runRender(ctl);
        case 'note':
          return runNote(event, ctl);
        case 'state':
          return Promise.resolve();
        default:
          return plugin.run?.(raw, ctl) ?? Promise.resolve();
      }
    },
    apply(raw: EventLike) {
      live = false;
      const event = raw as KnownEvent;
      if (event.type === 'focus') {
        NODE_IDS.forEach((id) => setNode(id, event.nodes.includes(id)));
        syncLanes();
        hideCommand();
        setScreen(false);
        setFrame(fixedCamera ? 'all' : event.frame ?? event.nodes);
        setView(frameFor(frameNodes));
      }
      if (event.type === 'type') {
        setCommand(event.text);
        cmdBar.classList.add('is-visible');
      }
      if (event.type === 'show') {
        event.nodes.forEach((id) => setNode(id, true));
        syncLanes();
      }
      if (!fixedCamera && (event.type === 'show' || event.type === 'camera')) {
        setFrame(event.frame ?? 'all');
        setView(frameFor(frameNodes));
      }
      if (event.type === 'render') {
        setScreen(true);
        cmdBar.classList.add('is-done');
      }
    },
    overview() {
      live = false;
      NODE_IDS.forEach((id) => setNode(id, lessonNodes.includes(id)));
      syncLanes();
      hideCommand();
      setScreen(true);
      setFrame('all');
      setView(frameFor('all'));
    },
    showStates(end) {
      renderPanels(end);
      plugin.render?.(end);
    },
    snapshot(): Snapshot {
      return { view, visible: new Set(visible), lanes: new Set(shownLanes), screen, fresh: !everMorphed };
    },
    morph(before, ctl) {
      const snap = before as Snapshot;
      everMorphed = true;
      const appearing = NODE_IDS.filter((id) => visible.has(id) && !snap.visible.has(id));
      const leaving = [...snap.visible].filter((id) => !visible.has(id));
      if (!snap.fresh) {
        const target = view;
        setView(snap.view);
        cameraCtl.cancelled = true;
        const own: Ctl = (cameraCtl = { cancelled: false });
        const start = snap.view;
        void clock.tween(CAMERA_MS * 0.8, { get cancelled() { return ctl.cancelled || own.cancelled; } }, (t) => {
          const eased = easeInOut(t);
          setView(start.map((value, index) => value + (target[index] - value) * eased));
        });
      }
      leaving.forEach((id, index) => void liftOut(id, ctl, index * 60));
      appearing.forEach((id, index) => void dropIn(id, ctl, (snap.fresh ? 150 : 250) + index * 110, false));
      const laneDelay = appearing.length ? 500 + appearing.length * 110 : 0;
      for (const key of laneGeo.keys()) {
        const now = shownLanes.has(key);
        if (now !== snap.lanes.has(key)) void revealLane(key, now, ctl, now ? laneDelay : 0);
      }
      // 没有屏幕的站点不能在这里排等待任务：多一个任务就会让共享时钟多转几帧，改变后面动画的时间量化。
      if (config.screenNodes?.length && screen !== snap.screen) void drawScreen(screen, ctl, screen ? laneDelay + 200 : 0);
    },
    clear() {
      live = false;
      for (const child of [...packetLayer.children, ...noteLayer.children]) child.remove();
      pulseLayer.replaceChildren();
      for (const key of laneEls.keys()) {
        laneUse.set(key, 0);
        setLaneActive(key);
      }
    },
  };
}
