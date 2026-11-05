/**
 * 场景里的中间产物：源码、token 流、语法树、栈、表格、CFG、活跃区间、字节、栈帧。
 * 这里全是纯函数：视图数据进，SVG 字符串出。不碰 DOM，所以前进、后退、跳步都能重算出同样的画面，
 * 也能在单元测试里检查有没有文字放不下。
 */
import { esc } from '@explorer/engine/core/dom';
import type { Color } from '../lessons/types';

export type Tone = Color | 'red';

export interface Mark { from: number; to: number; tone: Tone }

export interface CodeLine {
  text: string;
  gutter?: string;
  tone?: Tone;
  marks?: Mark[];
  dim?: boolean;
  strike?: boolean;
  /** 行尾注释，靠右显示。 */
  note?: string;
  head?: boolean;
}

export interface TreeNode { id: string; label: string; parent: string | null; tone?: Tone; sub?: string; ghost?: boolean }

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'box' | 'circle';
  label: string;
  lines?: Array<string | { text: string; tone?: Tone; strike?: boolean; dim?: boolean }>;
  tone?: Tone;
  /** 接受状态画双圈。 */
  ring?: boolean;
  dim?: boolean;
}

export interface GraphEdge { from: string; to: string; label?: string; tone?: Tone; bend?: number; dim?: boolean; dash?: boolean }

export type ArtView = { title: string; sub?: string } & (
  | { kind: 'code'; lines: CodeLine[]; focus?: number; size?: number }
  | { kind: 'tokens'; tokens: Array<{ text: string; tag?: string; tone?: Tone; dim?: boolean }>; size?: number }
  | { kind: 'tree'; nodes: TreeNode[] }
  | { kind: 'stack'; cells: Array<{ text: string; sub?: string; tone?: Tone }>; rest?: Array<{ text: string; tone?: Tone }>; restLabel?: string; caption?: string }
  | { kind: 'table'; cols: string[]; widths?: number[]; rows: Array<{ cells: string[]; tone?: Tone; tones?: Array<Tone | null>; dim?: boolean }>; size?: number; center?: boolean }
  | { kind: 'graph'; width: number; height: number; nodes: GraphNode[]; edges: GraphEdge[] }
  | { kind: 'bars'; max: number; rows: Array<{ label: string; start: number; end: number; tone?: Tone; value?: string; dim?: boolean; dash?: boolean }>; cursor?: number; bands?: Array<{ from: number; to: number; label: string }>; marks?: Array<{ at: number; label: string }> }
  | { kind: 'bytes'; groups: Array<{ label: string; bytes: number[]; tone: Tone; dim?: boolean; lit?: boolean }>; size?: number; caption?: string }
  | { kind: 'frame'; cells: Array<{ offset: string; value: string; note?: string; tone?: Tone; dim?: boolean }>; pointers: Array<{ name: string; at: number; tone: Tone }> }
  | { kind: 'layout'; total: number; rows: Array<{ label: string; from: number; to: number; tone: Tone; note?: string; lit?: boolean; dim?: boolean }> }
);

export interface Rect { x: number; y: number; w: number; h: number }

/** Iosevka 的拉丁字符宽 0.5em，箭头和 ⋯ 是 1em；中文回退字体也是 1em。 */
const WIDE = new Set(['→', '←', '⋯']);
export function textWidth(text: string, size: number): number {
  let units = 0;
  for (const char of text) units += char.charCodeAt(0) > 0x2e7f || WIDE.has(char) ? 1 : 0.5;
  return units * size;
}

const HEAD = 30;
const PAD = 12;

const toneVar = (tone: Tone) => (tone === 'red' ? 'var(--err-text)' : `var(--c-${tone})`);
const num = (value: number) => Number(value.toFixed(2));

interface Ctx { w: number; h: number; issues: string[]; title: string }

function text(x: number, y: number, content: string, cls: string, size: number, extra = ''): string {
  return `<text x="${num(x)}" y="${num(y)}" class="${cls}" font-size="${size}" dominant-baseline="central"${extra ? ` ${extra}` : ''}>${esc(content)}</text>`;
}

function fits(ctx: Ctx, content: string, size: number, room: number): void {
  const width = textWidth(content, size);
  if (width > room + 0.5) ctx.issues.push(`${ctx.title}: “${content}” 宽 ${width.toFixed(0)}，只有 ${room.toFixed(0)}`);
}

function code(view: Extract<ArtView, { kind: 'code' }>, ctx: Ctx): string {
  const size = view.size ?? 13.5;
  const lineH = size + 4.5;
  const top = HEAD + 6;
  const rows = Math.floor((ctx.h - top - 6) / lineH);
  let lines: Array<CodeLine | null> = view.lines;
  if (view.lines.length > rows) {
    // 放不下时取一个窗口，让关注的那一行尽量靠中间。省略处画 ⋯。
    const marked = view.lines.findIndex((line) => line.tone);
    const focus = view.focus ?? Math.max(marked, 0);
    const room = rows - 1;
    const start = Math.max(0, Math.min(view.lines.length - room, focus - Math.floor(room / 2)));
    if (start === 0) lines = [...view.lines.slice(0, room), null];
    else if (start + room >= view.lines.length) lines = [null, ...view.lines.slice(view.lines.length - room)];
    else lines = [null, ...view.lines.slice(start, start + room - 1), null];
  }
  const gutterChars = Math.max(0, ...view.lines.map((line) => line.gutter?.length ?? 0));
  const gutter = gutterChars ? gutterChars * size * 0.5 + 8 : 0;
  const left = PAD + gutter;
  let out = '';
  lines.forEach((line, index) => {
    const y = top + index * lineH;
    const mid = y + lineH / 2;
    if (!line) {
      out += text(left, mid, '⋯', 'art-dim', size);
      return;
    }
    if (line.tone) out += `<rect x="4" y="${num(y)}" width="${ctx.w - 8}" height="${num(lineH)}" rx="2" fill="${toneVar(line.tone)}" opacity="0.14"/><rect x="4" y="${num(y)}" width="3" height="${num(lineH)}" fill="${toneVar(line.tone)}"/>`;
    if (line.gutter) out += text(PAD + gutter - 8, mid, line.gutter, 'art-gutter', size - 1, 'text-anchor="end"');
    for (const mark of line.marks ?? []) {
      const x = left + textWidth(line.text.slice(0, mark.from), size);
      const width = Math.max(textWidth(line.text.slice(mark.from, mark.to), size), size * 0.5);
      out += `<rect class="art-mark" x="${num(x - 1)}" y="${num(y + 1)}" width="${num(width + 2)}" height="${num(lineH - 2)}" rx="2" fill="${toneVar(mark.tone)}" opacity="0.34"/>`;
    }
    const cls = line.dim ? 'art-dim' : line.head ? 'art-label' : 'art-code';
    if (line.text) out += text(left, mid, line.text, cls, size);
    const textW = textWidth(line.text, size);
    if (line.strike) out += `<line x1="${num(left - 1)}" x2="${num(left + textW + 1)}" y1="${num(mid)}" y2="${num(mid)}" stroke="var(--err-text)" stroke-width="1.4"/>`;
    fits(ctx, line.text, size, ctx.w - left - PAD + 4);
    if (line.note) {
      const noteSize = size - 1.5;
      const room = ctx.w - left - textW - PAD - 8;
      fits(ctx, line.note, noteSize, room);
      out += text(ctx.w - PAD + 2, mid, line.note, 'art-note', noteSize, 'text-anchor="end"');
    }
  });
  return out;
}

function tokens(view: Extract<ArtView, { kind: 'tokens' }>, ctx: Ctx): string {
  const size = view.size ?? 12.5;
  const chipH = view.tokens.some((token) => token.tag) ? size + 15 : size + 8;
  const gap = 4;
  let x = PAD;
  let y = HEAD + 6;
  let out = '';
  for (const token of view.tokens) {
    const tagSize = 9;
    const width = Math.max(textWidth(token.text, size), token.tag ? textWidth(token.tag, tagSize) : 0, size * 0.5) + 9;
    if (x + width > ctx.w - PAD) {
      x = PAD;
      y += chipH + gap;
    }
    const tone = token.tone;
    const fill = tone ? toneVar(tone) : 'var(--line-soft)';
    out += `<g class="art-chip${token.dim ? ' is-dim' : ''}">`;
    out += `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${chipH}" rx="2.5" fill="${fill}" fill-opacity="${tone ? 0.2 : 0.55}" stroke="${tone ? toneVar(tone) : 'var(--line-mid)'}" stroke-width="${tone ? 1.3 : 0.8}"/>`;
    if (token.tag) {
      out += text(x + width / 2, y + (size + 3) / 2 + 1, token.text, 'art-code', size, 'text-anchor="middle"');
      out += text(x + width / 2, y + chipH - 6, token.tag, 'art-note', tagSize, 'text-anchor="middle"');
    } else out += text(x + width / 2, y + chipH / 2, token.text, 'art-code', size, 'text-anchor="middle"');
    out += '</g>';
    x += width + gap;
  }
  if (y + chipH > ctx.h - 2) ctx.issues.push(`${ctx.title}: token 超出面板高度 ${y + chipH} > ${ctx.h}`);
  return out;
}

function tree(view: Extract<ArtView, { kind: 'tree' }>, ctx: Ctx): string {
  const children = new Map<string | null, TreeNode[]>();
  for (const node of view.nodes) {
    if (!children.has(node.parent)) children.set(node.parent, []);
    children.get(node.parent)!.push(node);
  }
  const size = 12.5;
  const widthOf = (node: TreeNode) => Math.max(textWidth(node.label, size), node.sub ? textWidth(node.sub, 9.5) : 0) + 12;
  const place = new Map<string, { x: number; depth: number }>();
  let cursor = 0;
  let maxDepth = 0;
  const gap = 7;
  const layout = (node: TreeNode, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = children.get(node.id) ?? [];
    if (!kids.length) {
      const width = widthOf(node);
      place.set(node.id, { x: cursor + width / 2, depth });
      cursor += width + gap;
      return;
    }
    kids.forEach((kid) => layout(kid, depth + 1));
    const first = place.get(kids[0].id)!.x;
    const last = place.get(kids[kids.length - 1].id)!.x;
    place.set(node.id, { x: (first + last) / 2, depth });
  };
  (children.get(null) ?? []).forEach((root) => layout(root, 0));
  const totalW = cursor - gap;
  const room = ctx.w - PAD * 2;
  const stretch = totalW > 0 ? Math.min(room / totalW, 1.7) : 1;
  if (totalW > room + 1) ctx.issues.push(`${ctx.title}: 树宽 ${totalW.toFixed(0)}，只有 ${room}`);
  const offset = PAD + (room - totalW * stretch) / 2;
  const nodeH = view.nodes.some((node) => node.sub) ? 30 : 21;
  const levelH = Math.min((ctx.h - HEAD - 16 - nodeH) / Math.max(maxDepth, 1), 54);
  const pos = (id: string) => {
    const at = place.get(id)!;
    return { x: offset + at.x * stretch, y: HEAD + 8 + nodeH / 2 + at.depth * levelH };
  };
  let lines = '';
  let boxes = '';
  for (const node of view.nodes) {
    if (node.ghost) continue;
    const at = pos(node.id);
    if (node.parent && !view.nodes.find((item) => item.id === node.parent)?.ghost) {
      const parent = pos(node.parent);
      lines += `<line x1="${num(parent.x)}" y1="${num(parent.y + nodeH / 2)}" x2="${num(at.x)}" y2="${num(at.y - nodeH / 2)}" stroke="var(--line)" stroke-width="1.3"/>`;
    }
    const width = widthOf(node);
    const tone = node.tone;
    boxes += `<g class="art-tree-node"><rect x="${num(at.x - width / 2)}" y="${num(at.y - nodeH / 2)}" width="${num(width)}" height="${nodeH}" rx="3" fill="${tone ? toneVar(tone) : 'var(--fill-card)'}" fill-opacity="${tone ? 0.22 : 1}" stroke="${tone ? toneVar(tone) : 'var(--line)'}" stroke-width="${tone ? 1.6 : 1}"/>`;
    if (node.sub) {
      boxes += text(at.x, at.y - 6, node.label, 'art-code', size, 'text-anchor="middle"');
      boxes += text(at.x, at.y + 8, node.sub, 'art-note', 9.5, 'text-anchor="middle"');
    } else boxes += text(at.x, at.y, node.label, 'art-code', size, 'text-anchor="middle"');
    boxes += '</g>';
  }
  return lines + boxes;
}

function stack(view: Extract<ArtView, { kind: 'stack' }>, ctx: Ctx): string {
  const size = 12.5;
  const cellH = view.cells.some((cell) => cell.sub) ? 38 : 26;
  const gap = 3;
  let x = PAD;
  let y = HEAD + 6;
  let out = '';
  view.cells.forEach((cell, index) => {
    const width = Math.max(textWidth(cell.text, size), cell.sub ? textWidth(cell.sub, 10) : 0) + 14;
    if (x + width > ctx.w - PAD) {
      x = PAD;
      y += cellH + gap;
    }
    const top = index === view.cells.length - 1;
    const tone = cell.tone ?? (top ? 'blue' : undefined);
    out += `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${cellH}" rx="2" fill="${tone ? toneVar(tone) : 'var(--fill-card)'}" fill-opacity="${tone ? 0.22 : 1}" stroke="${tone ? toneVar(tone) : 'var(--line)'}" stroke-width="${tone ? 1.5 : 1}"/>`;
    if (cell.sub) {
      out += text(x + width / 2, y + 12, cell.text, 'art-code', size, 'text-anchor="middle"');
      out += text(x + width / 2, y + 27, cell.sub, 'art-note', 10, 'text-anchor="middle"');
    } else out += text(x + width / 2, y + cellH / 2, cell.text, 'art-code', size, 'text-anchor="middle"');
    x += width + gap;
  });
  y += cellH + 6;
  if (view.rest) {
    x = PAD;
    if (view.restLabel) {
      out += text(PAD, y + 8, view.restLabel, 'art-note', 11);
      y += 18;
    }
    for (const item of view.rest) {
      const width = textWidth(item.text, size) + 12;
      if (x + width > ctx.w - PAD) {
        x = PAD;
        y += 24;
      }
      out += `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="21" rx="2" fill="${item.tone ? toneVar(item.tone) : 'var(--line-soft)'}" fill-opacity="${item.tone ? 0.22 : 0.55}" stroke="${item.tone ? toneVar(item.tone) : 'var(--line-mid)'}" stroke-width="${item.tone ? 1.4 : 0.8}"/>`;
      out += text(x + width / 2, y + 10.5, item.text, 'art-code', size, 'text-anchor="middle"');
      x += width + 3;
    }
    y += 24;
  }
  if (view.caption) {
    fits(ctx, view.caption, 12, ctx.w - PAD * 2);
    out += text(PAD, y + 9, view.caption, 'art-label', 12);
    y += 20;
  }
  if (y > ctx.h + 1) ctx.issues.push(`${ctx.title}: 栈内容超出面板 ${y} > ${ctx.h}`);
  return out;
}

function table(view: Extract<ArtView, { kind: 'table' }>, ctx: Ctx): string {
  const size = view.size ?? 12;
  const rowH = size + 7;
  const headH = size + 6;
  const room = ctx.w - PAD * 2;
  const natural = view.cols.map((col, index) => Math.max(textWidth(col, size), ...view.rows.map((row) => textWidth(row.cells[index] ?? '', size))) + 8);
  const widths = view.widths ?? natural;
  const sum = widths.reduce((a, b) => a + b, 0);
  const scale = sum < room ? room / sum : 1;
  if (sum > room + 1) ctx.issues.push(`${ctx.title}: 表宽 ${sum.toFixed(0)}，只有 ${room}`);
  const top = HEAD + 3;
  let out = '';
  let x = PAD;
  const xs = widths.map((width) => {
    const at = x;
    x += width * scale;
    return at;
  });
  view.cols.forEach((col, index) => {
    const cx = view.center ? xs[index] + (widths[index] * scale) / 2 : xs[index] + 3;
    out += text(cx, top + headH / 2, col, 'art-th', size - 0.5, view.center ? 'text-anchor="middle"' : '');
  });
  out += `<line x1="${PAD}" x2="${ctx.w - PAD}" y1="${top + headH}" y2="${top + headH}" stroke="var(--line-mid)" stroke-width="1"/>`;
  view.rows.forEach((row, rowIndex) => {
    const y = top + headH + rowIndex * rowH;
    if (row.tone) out += `<rect x="${PAD - 2}" y="${num(y + 0.5)}" width="${ctx.w - PAD * 2 + 4}" height="${rowH - 1}" rx="2" fill="${toneVar(row.tone)}" opacity="0.15"/>`;
    row.cells.forEach((cell, index) => {
      const tone = row.tones?.[index];
      const cellW = widths[index] * scale;
      if (tone) out += `<rect x="${num(xs[index] + 0.5)}" y="${num(y + 1)}" width="${num(cellW - 1)}" height="${rowH - 2}" rx="2" fill="${toneVar(tone)}" opacity="0.32" stroke="${toneVar(tone)}" stroke-width="1.2" stroke-opacity="1"/>`;
      if (!cell) return;
      fits(ctx, cell, size, cellW - 2);
      const cx = view.center ? xs[index] + cellW / 2 : xs[index] + 3;
      out += text(cx, y + rowH / 2, cell, row.dim ? 'art-dim' : 'art-code', size, view.center ? 'text-anchor="middle"' : '');
    });
    if (rowIndex < view.rows.length - 1) out += `<line x1="${PAD}" x2="${ctx.w - PAD}" y1="${num(y + rowH)}" y2="${num(y + rowH)}" stroke="var(--line-faint)" stroke-width="0.8"/>`;
  });
  const bottom = top + headH + view.rows.length * rowH;
  if (bottom > ctx.h + 1) ctx.issues.push(`${ctx.title}: 表高 ${bottom}，只有 ${ctx.h}`);
  return out;
}

function borderPoint(node: GraphNode, tx: number, ty: number): [number, number] {
  const dx = tx - node.x;
  const dy = ty - node.y;
  if (node.shape === 'circle') {
    const length = Math.hypot(dx, dy) || 1;
    return [node.x + (dx / length) * node.w / 2, node.y + (dy / length) * node.w / 2];
  }
  const sx = dx ? Math.abs(node.w / 2 / dx) : Infinity;
  const sy = dy ? Math.abs(node.h / 2 / dy) : Infinity;
  const scale = Math.min(sx, sy);
  return [node.x + dx * scale, node.y + dy * scale];
}

function graph(view: Extract<ArtView, { kind: 'graph' }>, ctx: Ctx): string {
  const room = { w: ctx.w - 12, h: ctx.h - HEAD - 8 };
  if (view.width > room.w + 1 || view.height > room.h + 1) ctx.issues.push(`${ctx.title}: 图 ${view.width}×${view.height}，只有 ${room.w}×${room.h}`);
  const ox = 6 + (room.w - view.width) / 2;
  const oy = HEAD + 4 + (room.h - view.height) / 2;
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  let edges = '';
  for (const edge of view.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const color = edge.tone ? toneVar(edge.tone) : 'var(--line)';
    const marker = `url(#head-${edge.tone && edge.tone !== 'red' ? edge.tone : 'idle'})`;
    const style = `fill="none" stroke="${color}" stroke-width="${edge.tone ? 1.9 : 1.3}"${edge.dash ? ' stroke-dasharray="4 3"' : ''}${edge.dim ? ' opacity="0.35"' : ''} marker-end="${marker}"`;
    let labelX = (a.x + b.x) / 2;
    let labelY = (a.y + b.y) / 2;
    if (edge.from === edge.to) {
      // 自环：画在节点上方。
      const r = a.w / 2;
      edges += `<path d="M${num(a.x - 6)},${num(a.y - r)} C${num(a.x - 20)},${num(a.y - r - 22)} ${num(a.x + 20)},${num(a.y - r - 22)} ${num(a.x + 6)},${num(a.y - r - 1)}" ${style}/>`;
      labelY = a.y - r - 20;
    } else if (edge.bend) {
      const mx = (a.x + b.x) / 2 + edge.bend;
      const my = (a.y + b.y) / 2;
      const [x1, y1] = borderPoint(a, mx, my);
      const [x2, y2] = borderPoint(b, mx, my);
      edges += `<path d="M${num(x1)},${num(y1)} Q${num(mx)},${num(my)} ${num(x2)},${num(y2)}" ${style}/>`;
      // 标签放在靠近起点的位置，避开终点附近常见的方框。
      const t = 0.36;
      labelX = (1 - t) ** 2 * x1 + 2 * t * (1 - t) * mx + t ** 2 * x2;
      labelY = (1 - t) ** 2 * y1 + 2 * t * (1 - t) * my + t ** 2 * y2;
    } else {
      const [x1, y1] = borderPoint(a, b.x, b.y);
      const [x2, y2] = borderPoint(b, a.x, a.y);
      edges += `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" ${style}/>`;
    }
    if (edge.label) {
      const width = textWidth(edge.label, 10) + 6;
      edges += `<rect x="${num(labelX - width / 2)}" y="${num(labelY - 7)}" width="${num(width)}" height="14" rx="2" fill="var(--paper)" opacity="0.92"/>`;
      edges += text(labelX, labelY, edge.label, edge.tone ? 'art-label' : 'art-note', 10, 'text-anchor="middle"');
    }
  }
  let nodes = '';
  for (const node of view.nodes) {
    const tone = node.tone;
    const fill = tone ? toneVar(tone) : 'var(--fill-card)';
    const stroke = tone ? toneVar(tone) : 'var(--line)';
    const opacity = node.dim ? ' opacity="0.45"' : '';
    if (node.shape === 'circle') {
      const r = node.w / 2;
      nodes += `<g${opacity}><circle cx="${node.x}" cy="${node.y}" r="${r}" fill="${tone ? fill : 'var(--paper)'}" fill-opacity="${tone ? 0.3 : 1}" stroke="${stroke}" stroke-width="${tone ? 2 : 1.2}"/>`;
      if (node.ring) nodes += `<circle cx="${node.x}" cy="${node.y}" r="${r - 3}" fill="none" stroke="${stroke}" stroke-width="1"/>`;
      fits(ctx, node.label, 10.5, node.w - 2);
      nodes += text(node.x, node.y, node.label, 'art-code', 10.5, 'text-anchor="middle"');
      nodes += '</g>';
      continue;
    }
    const x = node.x - node.w / 2;
    const y = node.y - node.h / 2;
    nodes += `<g${opacity}><rect x="${num(x)}" y="${num(y)}" width="${node.w}" height="${node.h}" rx="3" fill="${tone ? fill : 'var(--fill-card)'}" fill-opacity="${tone ? 0.16 : 1}" stroke="${stroke}" stroke-width="${tone ? 1.8 : 1.1}"/>`;
    nodes += text(x + 7, y + 10, node.label, 'art-label', 11.5);
    (node.lines ?? []).forEach((line, index) => {
      const item = typeof line === 'string' ? { text: line } : line;
      const ly = y + 25 + index * 14.5;
      if (ly > y + node.h) ctx.issues.push(`${ctx.title}: ${node.id} 的第 ${index} 行放不下`);
      fits(ctx, item.text, 11.5, node.w - 12);
      const tw = textWidth(item.text, 11.5);
      const toneOf = 'tone' in item ? item.tone : undefined;
      if (toneOf) nodes += `<rect x="${num(x + 4)}" y="${num(ly - 7)}" width="${node.w - 8}" height="14" rx="2" fill="${toneVar(toneOf)}" opacity="0.28"/>`;
      nodes += text(x + 7, ly, item.text, 'dim' in item && item.dim ? 'art-dim' : 'art-code', 11.5);
      if ('strike' in item && item.strike) nodes += `<line x1="${num(x + 6)}" x2="${num(x + 8 + tw)}" y1="${num(ly)}" y2="${num(ly)}" stroke="var(--err-text)" stroke-width="1.3"/>`;
    });
    nodes += '</g>';
  }
  return `<g transform="translate(${num(ox)} ${num(oy)})">${edges}${nodes}</g>`;
}

function bars(view: Extract<ArtView, { kind: 'bars' }>, ctx: Ctx): string {
  const labelW = Math.max(...view.rows.map((row) => textWidth(row.label, 12))) + 6;
  const valueW = Math.max(...view.rows.map((row) => textWidth(row.value ?? '', 12))) + 12;
  const left = PAD + labelW;
  const right = ctx.w - PAD - valueW;
  const scale = (right - left) / view.max;
  const top = HEAD + (view.bands ? 20 : 4);
  const rowH = Math.min((ctx.h - top - 6) / Math.max(view.rows.length, 1), 24);
  const x = (pos: number) => left + Math.max(pos, 0) * scale;
  let out = '';
  (view.bands ?? []).forEach((band, index) => {
    const x1 = x(band.from);
    const x2 = x(band.to);
    if (index % 2 === 0) out += `<rect x="${num(x1)}" y="${HEAD + 2}" width="${num(x2 - x1)}" height="${ctx.h - HEAD - 8}" fill="var(--fill-card)" />`;
    out += `<line x1="${num(x1)}" x2="${num(x1)}" y1="${HEAD + 2}" y2="${ctx.h - 6}" stroke="var(--line-soft)" stroke-width="1"/>`;
    fits(ctx, band.label, 10, x2 - x1);
    out += text((x1 + x2) / 2, HEAD + 10, band.label, 'art-note', 10, 'text-anchor="middle"');
  });
  for (const mark of view.marks ?? []) {
    out += `<line x1="${num(x(mark.at))}" x2="${num(x(mark.at))}" y1="${HEAD + 2}" y2="${ctx.h - 6}" stroke="var(--err-text)" stroke-width="1.2" stroke-dasharray="3 3"/>`;
    out += text(x(mark.at) + 3, ctx.h - 13, mark.label, 'art-note', 10);
  }
  view.rows.forEach((row, index) => {
    const y = top + index * rowH;
    const mid = y + rowH / 2;
    out += text(PAD, mid, row.label, row.dim ? 'art-dim' : 'art-code', 12);
    const x1 = x(row.start);
    const x2 = Math.max(x(row.end), x1 + 4);
    const tone = row.tone;
    const fill = tone ? toneVar(tone) : 'var(--line)';
    out += `<rect x="${num(x1)}" y="${num(mid - 6)}" width="${num(x2 - x1)}" height="12" rx="2" fill="${fill}" fill-opacity="${row.dim ? 0.2 : tone ? 0.75 : 0.42}"${row.dash ? ' stroke="var(--err-text)" stroke-width="1.4" stroke-dasharray="3 2"' : ''}/>`;
    if (row.value) out += text(ctx.w - PAD, mid, row.value, tone ? 'art-label' : 'art-note', 12, 'text-anchor="end"');
  });
  if (view.cursor !== undefined) {
    out += `<line x1="${num(x(view.cursor))}" x2="${num(x(view.cursor))}" y1="${top - 2}" y2="${ctx.h - 6}" stroke="var(--ink-strong)" stroke-width="1.6"/>`;
    out += `<path d="M${num(x(view.cursor) - 4)},${top - 7} h8 l-4,6 z" fill="var(--ink-strong)"/>`;
  }
  return out;
}

function bytes(view: Extract<ArtView, { kind: 'bytes' }>, ctx: Ctx): string {
  const size = view.size ?? 13.5;
  const cellW = size * 1.45;
  const cellH = size + 7;
  const labelH = 15;
  let x = PAD;
  let y = HEAD + 6;
  let out = '';
  for (const group of view.groups) {
    const labelWidth = textWidth(group.label, 10.5);
    const width = Math.max(group.bytes.length * cellW, labelWidth + 4);
    if (x + width > ctx.w - PAD) {
      x = PAD;
      y += cellH + labelH + 6;
    }
    const cx = x + (width - group.bytes.length * cellW) / 2;
    group.bytes.forEach((byte, index) => {
      const bx = cx + index * cellW;
      out += `<g${group.dim ? ' opacity="0.42"' : ''}><rect x="${num(bx + 0.5)}" y="${num(y)}" width="${num(cellW - 1)}" height="${cellH}" rx="2" fill="${toneVar(group.tone)}" fill-opacity="${group.lit ? 0.42 : 0.18}" stroke="${toneVar(group.tone)}" stroke-width="${group.lit ? 1.8 : 1}"/>`;
      out += text(bx + cellW / 2, y + cellH / 2, byte.toString(16).padStart(2, '0'), 'art-code', size, 'text-anchor="middle"');
      out += '</g>';
    });
    if (group.label) out += text(x + width / 2, y + cellH + labelH / 2 + 1, group.label, group.dim ? 'art-dim' : 'art-note', 10.5, 'text-anchor="middle"');
    x += width + 5;
  }
  y += cellH + labelH + 6;
  if (view.caption) {
    fits(ctx, view.caption, 12, ctx.w - PAD * 2);
    out += text(PAD, y + 6, view.caption, 'art-label', 12);
    y += 16;
  }
  if (y > ctx.h + 1) ctx.issues.push(`${ctx.title}: 字节超出面板 ${y} > ${ctx.h}`);
  return out;
}

function frame(view: Extract<ArtView, { kind: 'frame' }>, ctx: Ctx): string {
  const size = 12.5;
  const top = HEAD + 6;
  const rowH = Math.min((ctx.h - top - 6) / Math.max(view.cells.length, 1), 34);
  const offsetW = Math.max(...view.cells.map((cell) => textWidth(cell.offset, 11.5))) + 8;
  const pointerW = Math.max(0, ...view.pointers.map((item) => textWidth(item.name, 12))) + 22;
  const left = PAD + offsetW;
  const right = ctx.w - PAD - pointerW;
  let out = '';
  view.cells.forEach((cell, index) => {
    const y = top + index * rowH;
    const mid = y + rowH / 2;
    out += text(left - 6, mid, cell.offset, 'art-gutter', 11.5, 'text-anchor="end"');
    const tone = cell.tone;
    out += `<rect x="${num(left)}" y="${num(y + 1)}" width="${num(right - left)}" height="${num(rowH - 2)}" rx="2" fill="${tone ? toneVar(tone) : 'var(--fill-card)'}" fill-opacity="${tone ? 0.2 : 1}" stroke="${tone ? toneVar(tone) : 'var(--line-mid)'}" stroke-width="${tone ? 1.5 : 1}"${cell.dim ? ' opacity="0.45"' : ''}/>`;
    fits(ctx, cell.value, size, right - left - 12);
    out += text(left + 8, mid, cell.value, cell.dim ? 'art-dim' : 'art-code', size);
    if (cell.note) {
      fits(ctx, `${cell.value}${cell.note}`, size, right - left - 8);
      out += text(right - 6, mid, cell.note, 'art-note', 11, 'text-anchor="end"');
    }
  });
  const crowded = new Map<number, number>();
  for (const pointer of view.pointers) {
    const seen = crowded.get(pointer.at) ?? 0;
    crowded.set(pointer.at, seen + 1);
    const y = top + pointer.at * rowH + rowH / 2 + seen * 13 - (view.pointers.filter((item) => item.at === pointer.at).length - 1) * 6.5;
    out += `<path d="M${num(right + 16)},${num(y)} L${num(right + 4)},${num(y)}" stroke="${toneVar(pointer.tone)}" stroke-width="1.8" marker-end="url(#head-${pointer.tone === 'red' ? 'idle' : pointer.tone})"/>`;
    out += text(right + 19, y, pointer.name, 'art-label', 12);
  }
  return out;
}

function layout(view: Extract<ArtView, { kind: 'layout' }>, ctx: Ctx): string {
  const room = ctx.w - PAD * 2;
  const barY = HEAD + 5;
  const barH = 16;
  let out = '';
  const scale = room / view.total;
  for (const row of view.rows) {
    if (row.to <= row.from) continue;
    out += `<rect x="${num(PAD + row.from * scale)}" y="${barY}" width="${num(Math.max((row.to - row.from) * scale, 1.5))}" height="${barH}" fill="${toneVar(row.tone)}" fill-opacity="${row.lit ? 0.85 : row.dim ? 0.15 : 0.42}" stroke="${toneVar(row.tone)}" stroke-width="${row.lit ? 1.6 : 0.8}"/>`;
  }
  const top = barY + barH + 6;
  const rowH = Math.min((ctx.h - top - 4) / Math.max(view.rows.length, 1), 22);
  view.rows.forEach((row, index) => {
    const y = top + index * rowH;
    const mid = y + rowH / 2;
    if (row.lit) out += `<rect x="4" y="${num(y)}" width="${ctx.w - 8}" height="${num(rowH)}" rx="2" fill="${toneVar(row.tone)}" opacity="0.16"/>`;
    out += `<rect x="${PAD}" y="${num(mid - 5)}" width="10" height="10" rx="1.5" fill="${toneVar(row.tone)}" fill-opacity="${row.dim ? 0.2 : 0.6}"/>`;
    const span = `${row.from.toString(16).padStart(3, '0')}–${row.to.toString(16).padStart(3, '0')}`;
    out += text(PAD + 16, mid, span, 'art-gutter', 11);
    out += text(PAD + 16 + textWidth(span, 11) + 8, mid, row.label, row.dim ? 'art-dim' : 'art-code', 12.5);
    if (row.note) {
      fits(ctx, row.note, 11, room - 16 - textWidth(span, 11) - 8 - textWidth(row.label, 12.5) - 6);
      out += text(ctx.w - PAD, mid, row.note, 'art-note', 11, 'text-anchor="end"');
    }
  });
  return out;
}

/** 窄屏时面板可以收窄到内容的宽度，字就能放大。只有代码面板能这样做，表格和图的宽度是定死的。 */
export function compactWidth(view: ArtView, w: number): number {
  if (view.kind !== 'code') return w;
  const size = view.size ?? 13.5;
  const gutterChars = Math.max(0, ...view.lines.map((line) => line.gutter?.length ?? 0));
  const gutter = gutterChars ? gutterChars * size * 0.5 + 8 : 0;
  const widest = Math.max(...view.lines.map((line) => textWidth(line.text, size) + (line.note ? textWidth(line.note, size - 1.5) + 14 : 0)), textWidth(view.title, 12.5) + (view.sub ? textWidth(view.sub, 11) + 12 : 0));
  return Math.min(w, Math.ceil(PAD + gutter + widest + PAD + 2));
}

/** 面板外框加内容。rect 只决定尺寸，位置由外层 transform 给。 */
export function renderArt(view: ArtView, w: number, h: number): { svg: string; issues: string[] } {
  const ctx: Ctx = { w, h, issues: [], title: view.title };
  let body = '';
  switch (view.kind) {
    case 'code': body = code(view, ctx); break;
    case 'tokens': body = tokens(view, ctx); break;
    case 'tree': body = tree(view, ctx); break;
    case 'stack': body = stack(view, ctx); break;
    case 'table': body = table(view, ctx); break;
    case 'graph': body = graph(view, ctx); break;
    case 'bars': body = bars(view, ctx); break;
    case 'bytes': body = bytes(view, ctx); break;
    case 'frame': body = frame(view, ctx); break;
    case 'layout': body = layout(view, ctx); break;
  }
  const titleSize = 12.5;
  const titleW = textWidth(view.title, titleSize);
  if (view.sub) {
    const room = w - PAD * 2 - titleW - 10;
    if (textWidth(view.sub, 11) > room) ctx.issues.push(`${view.title}: 副标题“${view.sub}”放不下（${textWidth(view.sub, 11).toFixed(0)} > ${room.toFixed(0)}）`);
  }
  const head = `<rect class="art-box" width="${w}" height="${h}" rx="4"/>` +
    `<line x1="0" x2="${w}" y1="${HEAD - 4}" y2="${HEAD - 4}" stroke="var(--line-soft)" stroke-width="1"/>` +
    text(PAD, HEAD / 2 - 2, view.title, 'art-title', titleSize) +
    (view.sub ? text(w - PAD, HEAD / 2 - 2, view.sub, 'art-sub', 11, 'text-anchor="end"') : '');
  return { svg: head + body, issues: ctx.issues };
}
