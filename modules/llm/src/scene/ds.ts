/**
 * 数据结构图元的几何和绘制。全部是纯函数：同一份图元总是得到同样的条目，
 * 所以前进、后退、跳步看到的形态一致，单元测试也能直接检查范围是否重叠。
 */
import { esc } from '@explorer/engine/core/dom';
import type { Color, DsCell, DsFrame, DsMark, GraphPrim, GridPrim, NodeId, Prim, RingPrim, RowPrim, Tone, TowerPrim } from '../lessons/types';
import { box as isoBox, projector, topText, type Project } from '@explorer/engine/scene/iso';

export type Box = [left: number, top: number, right: number, bottom: number];

/** 场景里的一个可动条目。同 key 的条目在两帧之间移动，形成动画。 */
export interface Item {
  key: string;
  x: number;
  y: number;
  /** 绘制顺序，小的先画。 */
  order: number;
  html: string;
  /** 相对 (x, y) 的范围。 */
  box: Box;
  /** 边：两端随节点移动时单独补间。 */
  line?: [number, number, number, number];
}

const COS30 = Math.cos(Math.PI / 6);
const iso = (x: number, y: number): [number, number] => [(x - y) * COS30, (x + y) * 0.5];
const P: Project = projector(0, 0);

const SOCKET_H = 5;
const TOKEN_H = 11;
const LIFT = 11;
const CELL_TOP = SOCKET_H + TOKEN_H;

const faces = { top: 'var(--ds-top)', left: 'var(--ds-left)', right: 'var(--ds-right)', stroke: 'var(--ds-line)' };

/** 中文按整字宽，其余按半字宽估算文字宽度，只用来留位置。 */
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) units += char.charCodeAt(0) > 0x2e80 ? 1 : 0.52;
  return units * size;
}

const fit = (text: string, room: number, max: number) => Math.max(9, Math.min(max, room / Math.max(1, textWidth(text, 1))));

const toneClass = (tone: Tone | undefined) => `ds-c ds-${tone ?? 'plain'}`;

function pill(x: number, y: number, text: string, color: Color | undefined, cls = 'ds-mark'): string {
  const size = 12;
  const width = textWidth(text, size) + 12;
  return `<g class="${cls} ${color ?? 'blue'}"><rect x="${(x - width / 2).toFixed(1)}" y="${y - 10}" width="${width.toFixed(1)}" height="20" rx="3"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text></g>`;
}

/** 从一个目标点向上立的标记。同一格有多个标记时往上摞。 */
function markItems(owner: string, marks: DsMark[] | undefined, pointOf: (mark: DsMark) => [number, number] | null, base: number): Item[] {
  if (!marks?.length) return [];
  const seen = new Map<string, number>();
  const items: Item[] = [];
  for (const mark of marks) {
    const point = pointOf(mark);
    if (!point) continue;
    const slot = `${point[0].toFixed(0)},${point[1].toFixed(0)}`;
    const level = seen.get(slot) ?? 0;
    seen.set(slot, level + 1);
    const rise = 26 + level * 22;
    const half = textWidth(mark.text, 12) / 2 + 6;
    const dx = mark.dx ?? 0;
    items.push({
      key: `${owner}:m:${mark.text}`,
      x: point[0],
      y: point[1],
      order: base + 1000 + level,
      html: `<line class="ds-pin ${mark.color ?? 'blue'}" x1="0" y1="0" x2="${dx}" y2="${-rise + 10}"/>${pill(dx, -rise, mark.text, mark.color)}`,
      box: [Math.min(-half, dx - half), -rise - 10, Math.max(half, dx + half), 0],
    });
  }
  return items;
}

// ---------- 一排格子 ----------

function rowGeometry(prim: RowPrim) {
  const axis = prim.axis ?? 'x';
  const w = prim.w ?? 56;
  const d = prim.d ?? (axis === 'x' ? w : 34);
  const center = prim.center ?? (prim.cells.length - 1) / 2;
  const [ox, oy] = prim.at ?? [0, 0];
  const at = (index: number): [number, number] => {
    const [x, y] = axis === 'x' ? iso((index - center) * w, 0) : iso(0, (index - center) * d);
    return [ox + x, oy + y];
  };
  return { axis, w, d, at };
}

const cellLift = (cell: DsCell | undefined) => (cell?.lift ? LIFT : 0);

/** 一格顶面中心的位置，相对节点中心。事件可以瞄准这里。 */
export function rowAim(prim: RowPrim, index: number): [number, number] {
  const [x, y] = rowGeometry(prim).at(index);
  return [x, y - CELL_TOP - cellLift(prim.cells[index])];
}

/**
 * 本站相对 algo 的扩展：heat（0–1）把格子画成热力图，颜色在底色和 tone 色之间按比例混合。
 * 比例走 CSS 变量 --heat，颜色混合在 site.css 的 .ds-heat 里，深浅主题各自取色。
 */
function cellClass(cell: DsCell): string {
  if (cell.heat === undefined) return `class="${toneClass(cell.tone)}"`;
  const heat = Math.max(0, Math.min(1, cell.heat));
  const color = cell.tone && cell.tone !== 'dim' && cell.tone !== 'empty' && cell.tone !== 'head' ? cell.tone : 'blue';
  return `class="ds-c ds-heat ds-heat-${color}${heat > 0.55 ? ' ds-hot' : ''}" style="--heat: ${(heat * 100).toFixed(0)}%"`;
}

function cellMarkup(cell: DsCell, w: number, d: number, room: number, max: number, forced?: number): string {
  const size = forced ?? fit(cell.v, room, max);
  return `<g ${cellClass(cell)}>${isoBox(P, -w / 2 + 3, -d / 2 + 3, SOCKET_H, w - 6, d - 6, TOKEN_H, { ...faces, width: 1.5 })}${topText(P, 0, 0, CELL_TOP, esc(cell.v), +size.toFixed(1), 'class="ds-v"')}</g>`;
}

function rowItems(prim: RowPrim): Item[] {
  const { axis, w, d, at } = rowGeometry(prim);
  const items: Item[] = [];
  const halfX = ((w + d) / 2) * COS30;
  const halfY = (w + d) / 4;
  prim.cells.forEach((cell, index) => {
    const [x, y] = at(index);
    const depth = index * 2;
    const sub = cell.sub ?? (prim.bare ? '' : String(index));
    const subMark = sub
      ? axis === 'x'
        ? topText(P, 0, d / 2 + 10, 0, esc(sub), 13, 'class="ds-sub"')
        : topText(P, -w / 2 - 12, 0, 0, esc(sub), 12.5, 'class="ds-sub"')
      : '';
    items.push({
      key: `${prim.id}:s:${index}`,
      x,
      y,
      order: depth,
      html: `<g class="ds-socket">${isoBox(P, -w / 2, -d / 2, 0, w, d, SOCKET_H, { top: 'var(--ds-socket-top)', left: 'var(--ds-socket-left)', right: 'var(--ds-socket-right)', stroke: 'var(--ds-socket-line)', width: 1.2 })}</g>${subMark}`,
      box: [-halfX - 12, -halfY - SOCKET_H, halfX + 12, halfY + 18],
    });
    if (!cell.v || cell.tone === 'empty') return;
    const lift = cellLift(cell);
    items.push({
      key: `${prim.id}:v:${cell.key ?? index}`,
      x,
      y: y - lift,
      order: depth + 1,
      html: cellMarkup(cell, w, d, (axis === 'x' ? w : w) - 12, axis === 'x' ? w * 0.44 : 16),
      box: [-halfX, -halfY - CELL_TOP, halfX, halfY],
    });
  });
  items.push(...markItems(prim.id, prim.marks, (mark) => (typeof mark.at === 'number' ? rowAim(prim, mark.at) : null), prim.cells.length * 2));
  if (prim.title) {
    const [x, y] = at(0);
    const half = textWidth(prim.title, 12.5) + 4;
    const gap = halfX + 8;
    items.push({
      key: `${prim.id}:title`,
      x: x - gap,
      y: y - 2,
      order: -1,
      html: `<text class="ds-title" text-anchor="end" dominant-baseline="central">${esc(prim.title)}</text>`,
      box: [-half, -9, 2, 9],
    });
  }
  return items;
}

// ---------- 二维表 ----------

function gridGeometry(prim: GridPrim) {
  const w = prim.w ?? 44;
  const R = prim.rows.length + 1;
  const C = prim.cols.length + 1;
  const [ox, oy] = prim.at ?? [0, 0];
  const at = (r: number, c: number): [number, number] => {
    const [x, y] = iso((c - (C - 1) / 2) * w, (r - (R - 1) / 2) * w);
    return [ox + x, oy + y];
  };
  return { w, at };
}

/** cells[r][c] 顶面中心的位置。第 0 行第 0 列是表头，所以这里加 1。 */
export function gridAim(prim: GridPrim, r: number, c: number): [number, number] {
  const [x, y] = gridGeometry(prim).at(r + 1, c + 1);
  return [x, y - CELL_TOP - cellLift(prim.cells[r]?.[c])];
}

function gridItems(prim: GridPrim): Item[] {
  const { w, at } = gridGeometry(prim);
  const items: Item[] = [];
  const half = w * COS30;
  const box: Box = [-half, -w / 2 - CELL_TOP - LIFT, half, w / 2];
  /** 行头、列头各用同一个字号（取最挤的那个），避免同一排表头一大一小。 */
  const headSize = (texts: string[]) => (texts.length ? Math.min(...texts.map((text) => fit(text, w - 10, Math.min(w * 0.46, 13)))) : undefined);
  const colSize = headSize(prim.cols);
  const rowSize = headSize(prim.rows);
  const put = (key: string, r: number, c: number, cell: DsCell, forced?: number) => {
    const [x, y] = at(r, c);
    const lift = cellLift(cell);
    const socket = `<g class="ds-socket">${isoBox(P, -w / 2, -w / 2, 0, w, w, SOCKET_H, { top: 'var(--ds-socket-top)', left: 'var(--ds-socket-left)', right: 'var(--ds-socket-right)', stroke: 'var(--ds-socket-line)', width: 1 })}</g>`;
    items.push({ key: `${key}:s`, x, y, order: (r + c) * 2, html: socket, box });
    if (cell.v && cell.tone !== 'empty') items.push({ key, x, y: y - lift, order: (r + c) * 2 + 1, html: cellMarkup(cell, w, w, w - 10, w * 0.46, forced), box });
  };
  prim.cols.forEach((text, c) => put(`${prim.id}:hc:${c}`, 0, c + 1, { v: text, tone: 'head' }, colSize));
  prim.rows.forEach((text, r) => put(`${prim.id}:hr:${r}`, r + 1, 0, { v: text, tone: 'head' }, rowSize));
  prim.cells.forEach((row, r) => row.forEach((cell, c) => put(`${prim.id}:${r}:${c}`, r + 1, c + 1, cell)));
  return items;
}

// ---------- 树和图 ----------

export function graphAim(prim: GraphPrim, id: string): [number, number] {
  const node = prim.nodes.find((item) => item.id === id);
  if (!node) throw new Error(`${prim.id}: 没有节点 ${id}`);
  const [ox, oy] = prim.at ?? [0, 0];
  return [ox + node.x, oy + node.y - 12 - (node.lift ? LIFT : 0)];
}

function graphItems(prim: GraphPrim): Item[] {
  const r = prim.r ?? 24;
  const [ox, oy] = prim.at ?? [0, 0];
  const byId = new Map(prim.nodes.map((node) => [node.id, node]));
  const items: Item[] = [];
  const clip = r * 1.5;
  for (const edge of prim.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    const line: [number, number, number, number] = [a.x + ux * clip + ox, a.y + uy * clip * 0.6 - 6 + oy, b.x - ux * clip + ox, b.y - uy * clip * 0.6 - 6 + oy];
    const tone = edge.tone ?? 'plain';
    const head = edge.arrow ? ` marker-end="url(#head-${tone === 'plain' || tone === 'dim' || tone === 'head' || tone === 'empty' ? 'idle' : tone})"` : '';
    let html = `<line class="ds-edge ds-e-${tone}" x1="${line[0].toFixed(1)}" y1="${line[1].toFixed(1)}" x2="${line[2].toFixed(1)}" y2="${line[3].toFixed(1)}"${head}/>`;
    if (edge.label) {
      const mx = (line[0] + line[2]) / 2;
      const my = (line[1] + line[3]) / 2;
      html += pill(+mx.toFixed(1), +my.toFixed(1), edge.label, tone === 'plain' || tone === 'dim' || tone === 'head' || tone === 'empty' ? 'slate' : tone, 'ds-weight');
    }
    items.push({ key: `${prim.id}:e:${edge.a}-${edge.b}`, x: 0, y: 0, order: -10, html, box: [Math.min(line[0], line[2]) - 14, Math.min(line[1], line[3]) - 10, Math.max(line[0], line[2]) + 14, Math.max(line[1], line[3]) + 10], line });
  }
  const halfX = r * 2 * COS30;
  for (const node of prim.nodes) {
    const lift = node.lift ? LIFT : 0;
    const size = fit(node.v, r * 1.75, r * 0.82);
    const sub = node.sub ? `<text class="ds-node-sub" y="${r + 13}" text-anchor="middle" dominant-baseline="central">${esc(node.sub)}</text>` : '';
    const half = Math.max(halfX, textWidth(node.sub ?? '', 12.5) / 2 + 2);
    items.push({
      key: `${prim.id}:n:${node.id}`,
      x: ox + node.x,
      y: oy + node.y - lift,
      order: 10 + node.y * 0.01,
      html: `<g class="${toneClass(node.tone)}">${isoBox(P, -r, -r, 0, r * 2, r * 2, 11, { ...faces, width: 1.7 })}${topText(P, 0, 0, 11, esc(node.v), +size.toFixed(1), 'class="ds-v"')}</g>${sub}`,
      box: [-half, -r - 11, half, r + (node.sub ? 22 : 2)],
    });
  }
  items.push(...markItems(prim.id, prim.marks, (mark) => (typeof mark.at === 'string' && byId.has(mark.at) ? graphAim(prim, mark.at) : null), 40));
  return items;
}

// ---------- 环形 ----------

function ringGeometry(prim: RingPrim) {
  const radius = prim.radius ?? 128;
  const w = prim.w ?? 50;
  const [ox, oy] = prim.at ?? [0, 0];
  const angle = (index: number) => -Math.PI / 2 + (index / prim.cells.length) * Math.PI * 2;
  const at = (index: number): [number, number] => {
    const [x, y] = iso(radius * Math.cos(angle(index)), radius * Math.sin(angle(index)));
    return [ox + x, oy + y];
  };
  return { radius, w, angle, at };
}

export function ringAim(prim: RingPrim, index: number): [number, number] {
  const [x, y] = ringGeometry(prim).at(index);
  return [x, y - CELL_TOP - cellLift(prim.cells[index])];
}

function ringItems(prim: RingPrim): Item[] {
  const { radius, w, angle, at } = ringGeometry(prim);
  const [ox, oy] = prim.at ?? [0, 0];
  const items: Item[] = [];
  const half = w * COS30;
  const box: Box = [-half, -w / 2 - CELL_TOP - LIFT, half, w / 2 + 16];
  const circle = (r: number) => Array.from({ length: 48 }, (_, i) => iso(r * Math.cos((i / 48) * Math.PI * 2), r * Math.sin((i / 48) * Math.PI * 2)).map((v) => v.toFixed(1)).join(',')).join(' ');
  const inner = radius - w * 0.72;
  items.push({
    key: `${prim.id}:plate`,
    x: ox,
    y: oy,
    order: -5,
    html: `<polygon class="ds-plate" points="${circle(inner)}"/>`,
    box: [-inner * COS30, -inner / 2, inner * COS30, inner / 2],
  });
  prim.cells.forEach((cell, index) => {
    const [x, y] = at(index);
    const depth = (y + 1000) * 0.01;
    const a = angle(index);
    const out = w / 2 + 11;
    const socket = `<g class="ds-socket">${isoBox(P, -w / 2, -w / 2, 0, w, w, SOCKET_H, { top: 'var(--ds-socket-top)', left: 'var(--ds-socket-left)', right: 'var(--ds-socket-right)', stroke: 'var(--ds-socket-line)', width: 1.2 })}</g>`;
    const sub = cell.sub ?? String(index);
    const label = topText(P, out * Math.cos(a), out * Math.sin(a), 0, esc(sub), 13, 'class="ds-sub"');
    items.push({ key: `${prim.id}:s:${index}`, x, y, order: depth, html: socket + label, box });
    if (!cell.v || cell.tone === 'empty') return;
    items.push({ key: `${prim.id}:v:${cell.key ?? index}`, x, y: y - cellLift(cell), order: depth + 0.001, html: cellMarkup(cell, w, w, w - 12, w * 0.44), box });
  });
  items.push(...markItems(prim.id, prim.marks, (mark) => (typeof mark.at === 'number' ? ringAim(prim, mark.at) : null), 40));
  return items;
}

// ---------- 调用栈 ----------

const TOWER = { w: 118, d: 62, h: 22 };

function towerItems(prim: TowerPrim): Item[] {
  const [ox, oy] = prim.at ?? [0, 0];
  const { w, d, h } = TOWER;
  const halfX = ((w + d) / 2) * COS30;
  const halfY = (w + d) / 4;
  const items: Item[] = [{
    key: `${prim.id}:base`,
    x: ox,
    y: oy,
    order: -1,
    html: `<g class="ds-socket">${isoBox(P, -w / 2 - 6, -d / 2 - 6, -6, w + 12, d + 12, 6, { top: 'var(--ds-socket-top)', left: 'var(--ds-socket-left)', right: 'var(--ds-socket-right)', stroke: 'var(--ds-socket-line)', width: 1.4 })}</g>`,
    box: [-halfX - 12, -halfY - 8, halfX + 12, halfY + 14],
  }];
  prim.frames.forEach((frame, index) => {
    const [tx, ty] = P(0, d / 2, h / 2);
    const size = fit(frame.text, w - 12, 13.5);
    items.push({
      key: `${prim.id}:f:${frame.key}`,
      x: ox,
      y: oy - index * h,
      order: index,
      html: `<g class="${toneClass(frame.tone)}">${isoBox(P, -w / 2, -d / 2, 0, w, d, h, { ...faces, width: 1.5 })}<text class="ds-v ds-face" transform="matrix(${COS30.toFixed(4)} 0.5 0 1 ${tx.toFixed(2)} ${ty.toFixed(2)})" font-size="${size.toFixed(1)}" font-weight="800" text-anchor="middle" dominant-baseline="central">${esc(frame.text)}</text></g>`,
      box: [-halfX, -halfY - h, halfX, halfY],
    });
  });
  return items;
}

/** 调用栈里第 level 层侧面的中心，事件瞄准当前函数时用。 */
export function towerAim(prim: TowerPrim, level: number): [number, number] {
  const [ox, oy] = prim.at ?? [0, 0];
  return [ox, oy - level * TOWER.h - 22];
}

// ---------- 汇总 ----------

export function itemsOf(prims: Prim[] | undefined): Item[] {
  const items: Item[] = [];
  for (const prim of prims ?? []) {
    if (prim.kind === 'row') items.push(...rowItems(prim));
    if (prim.kind === 'grid') items.push(...gridItems(prim));
    if (prim.kind === 'graph') items.push(...graphItems(prim));
    if (prim.kind === 'ring') items.push(...ringItems(prim));
    if (prim.kind === 'tower') items.push(...towerItems(prim));
  }
  return items.sort((a, b) => a.order - b.order);
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function boundsOf(prims: Prim[] | undefined): Box | null {
  let out: Box | null = null;
  for (const item of itemsOf(prims)) out = union(out, [item.x + item.box[0], item.y + item.box[1], item.x + item.box[2], item.y + item.box[3]]);
  return out;
}

/** 一个节点在整节课所有帧里的最大范围。相机按它取景，播放中不会因形态变化而抖动。 */
export function lessonBounds(initial: DsFrame, events: Array<{ type: string; ds?: DsFrame; frame?: DsFrame; packets?: Array<{ ds?: DsFrame }> }>): Partial<Record<NodeId, Box>> {
  const out: Partial<Record<NodeId, Box>> = {};
  const add = (frame: DsFrame | undefined) => {
    if (!frame) return;
    for (const [id, prims] of Object.entries(frame) as Array<[NodeId, Prim[]]>) {
      const box = union(out[id] ?? null, boundsOf(prims));
      if (box) out[id] = box;
    }
  };
  add(initial);
  for (const event of events) {
    if (event.type === 'packet') add(event.ds);
    if (event.type === 'ds') add(event.frame as DsFrame);
    if (event.type === 'stream') event.packets?.forEach((packet) => add(packet.ds));
  }
  return out;
}
