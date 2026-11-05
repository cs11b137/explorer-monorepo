import { esc } from '@explorer/engine/core/dom';
import type { Color } from '../lessons/types';

/**
 * 结构图上的数值面板：把部件里的当前值直接画出来。
 * 尺寸只由内容决定，不依赖 DOM 测量，所以布局几何可以在单元测试里检查。
 */
export type Tone = Color | 'dim' | 'red';

export interface Cell {
  t: string;
  /** 文字和描边的颜色。 */
  tone?: Tone;
  /** 实心填充，用于表示「当前在用」的格子。 */
  solid?: boolean;
  /** 跨几列。 */
  span?: number;
}

export type CellLike = string | Cell;

export interface KvWidget {
  kind: 'kv';
  title: string;
  rows: Array<[key: string, value: CellLike]>;
}

export interface GridWidget {
  kind: 'grid';
  title: string;
  /** 列标题和列宽（场景单位）。 */
  cols: Array<[head: string, width: number]>;
  rows: CellLike[][];
}

export interface BitSeg {
  name: string;
  /** 格子太窄、放不下 name 时用的短标签，比如单独一位的立即数位写成 12。 */
  short?: string;
  hi: number;
  lo: number;
  tone: Tone;
}

export interface BitsWidget {
  kind: 'bits';
  title: string;
  width: number;
  value: number;
  segs: BitSeg[];
  /** 单格宽度，默认 15。 */
  cell?: number;
  /** 下方的说明行，比如位串表示的数值。 */
  caption?: string;
}

export type Widget = KvWidget | GridWidget | BitsWidget;
/** 一块面板可以竖着叠放多个小部件。 */
export type PanelContent = Widget | Widget[];

const TITLE_H = 22;
const ROW_H = 20;
const PAD = 7;
const FONT = 13;
const GAP = 6;

/** Iosevka 等宽 ASCII 宽 0.5 em，中文按 1 em。 */
export function textWidth(text: string, size = FONT): number {
  let width = 0;
  for (const char of text) width += char.charCodeAt(0) < 0x2e80 ? size * 0.5 : size;
  return width;
}

const cellText = (cell: CellLike) => (typeof cell === 'string' ? cell : cell.t);
const toneOf = (cell: CellLike): Tone | undefined => (typeof cell === 'string' ? undefined : cell.tone);
const solidOf = (cell: CellLike): boolean => (typeof cell === 'string' ? false : Boolean(cell.solid));
const spanOf = (cell: CellLike): number => (typeof cell === 'string' ? 1 : cell.span ?? 1);

const kvKeyWidth = (widget: KvWidget) => Math.max(0, ...widget.rows.map(([key]) => textWidth(key)));
const kvValueWidth = (widget: KvWidget) => Math.max(0, ...widget.rows.map(([, value]) => textWidth(cellText(value))));

export function widgetSize(widget: Widget): { width: number; height: number } {
  const title = textWidth(widget.title, 12) + PAD * 2;
  if (widget.kind === 'kv') {
    return { width: Math.max(title, kvKeyWidth(widget) + kvValueWidth(widget) + 12 + PAD * 2), height: TITLE_H + widget.rows.length * ROW_H + 5 };
  }
  if (widget.kind === 'grid') {
    const width = widget.cols.reduce((sum, [, w]) => sum + w, 0) + PAD * 2;
    return { width: Math.max(title, width), height: TITLE_H + (widget.rows.length + 1) * ROW_H + 5 };
  }
  const cell = widget.cell ?? 15;
  return { width: Math.max(title, widget.width * cell + PAD * 2, widget.caption ? textWidth(widget.caption, 12.5) + PAD * 2 : 0), height: TITLE_H + 15 + ROW_H + 15 + (widget.caption ? 17 : 0) + 3 };
}

export function panelWidgets(content: PanelContent): Widget[] {
  return Array.isArray(content) ? content : [content];
}

export function panelSize(content: PanelContent): { width: number; height: number } {
  const sizes = panelWidgets(content).map(widgetSize);
  return { width: Math.max(...sizes.map((size) => size.width)), height: sizes.reduce((sum, size) => sum + size.height, 0) + GAP * (sizes.length - 1) };
}

const toneClass = (tone?: Tone) => (tone ? ` t-${tone}` : '');

function frame(widget: Widget, width: number, height: number): string {
  return `<rect class="wg-box" width="${width}" height="${height}" rx="3"/><path class="wg-rule" d="M0,${TITLE_H} H${width}"/><text class="wg-title" x="${PAD}" y="${TITLE_H / 2 + 0.5}">${esc(widget.title)}</text>`;
}

/** 一个单元格。key 用来判断它的值有没有变化，变了就闪一下。 */
function cellSvg(key: string, cell: CellLike, x: number, y: number, width: number, align: 'start' | 'middle', fresh: Set<string>): string {
  const tone = toneOf(cell);
  const solid = solidOf(cell);
  const text = cellText(cell);
  const flash = fresh.has(key) ? ' is-fresh' : '';
  const tx = align === 'middle' ? x + width / 2 : x + 3;
  const anchor = align === 'middle' ? 'middle' : 'start';
  const bg = solid || flash ? `<rect class="wg-cell${solid ? ' is-solid' : ''}${toneClass(tone)}${flash}" x="${x + 0.5}" y="${y + 1}" width="${width - 1}" height="${ROW_H - 2}" rx="2"/>` : '';
  return `${bg}<text class="wg-text${solid ? ' on-solid' : ''}${toneClass(tone)}" x="${tx}" y="${y + ROW_H / 2 + 0.5}" text-anchor="${anchor}">${esc(text)}</text>`;
}

/** 把小部件画成 SVG 片段，返回片段和尺寸。previous 是上一帧的单元值，用来找出变化的格子。 */
export function widgetSvg(widget: Widget, width: number, keyPrefix: string, previous: Map<string, string>, next: Map<string, string>): string {
  const { height } = widgetSize(widget);
  const fresh = new Set<string>();
  const record = (key: string, text: string) => {
    next.set(key, text);
    if (previous.size && previous.has(key) && previous.get(key) !== text) fresh.add(key);
  };
  let body = '';
  if (widget.kind === 'kv') {
    const keyWidth = kvKeyWidth(widget);
    widget.rows.forEach(([key, value], index) => {
      const y = TITLE_H + 2 + index * ROW_H;
      const cellKey = `${keyPrefix}:${key}`;
      record(cellKey, cellText(value));
      body += `<text class="wg-key" x="${PAD}" y="${y + ROW_H / 2 + 0.5}">${esc(key)}</text>`;
      body += cellSvg(cellKey, value, PAD + keyWidth + 6, y, width - PAD * 2 - keyWidth - 6, 'start', fresh);
    });
  } else if (widget.kind === 'grid') {
    let x = PAD;
    const xs = widget.cols.map(([, w]) => {
      const at = x;
      x += w;
      return at;
    });
    widget.cols.forEach(([head], col) => {
      body += `<text class="wg-head" x="${xs[col] + widget.cols[col][1] / 2}" y="${TITLE_H + ROW_H / 2 + 1}" text-anchor="middle">${esc(head)}</text>`;
    });
    widget.rows.forEach((row, rowIndex) => {
      const y = TITLE_H + 2 + (rowIndex + 1) * ROW_H;
      let col = 0;
      row.forEach((cell) => {
        const span = spanOf(cell);
        const cellWidth = widget.cols.slice(col, col + span).reduce((sum, [, w]) => sum + w, 0);
        const key = `${keyPrefix}:${rowIndex}:${col}`;
        record(key, cellText(cell));
        body += cellSvg(key, cell, xs[col], y, cellWidth, 'middle', fresh);
        col += span;
      });
      body += `<path class="wg-rowline" d="M${PAD},${y} H${width - PAD}"/>`;
    });
  } else {
    const cell = widget.cell ?? 15;
    const left = PAD;
    const top = TITLE_H + 15;
    const xOf = (bit: number) => left + (widget.width - 1 - bit) * cell;
    for (const seg of widget.segs) {
      const x1 = xOf(seg.hi);
      const w = (seg.hi - seg.lo + 1) * cell;
      const label = textWidth(seg.name, 10.5) <= w + 2 ? seg.name : seg.short;
      if (label) body += `<text class="wg-seg${toneClass(seg.tone)}" x="${x1 + w / 2}" y="${top - 7}" text-anchor="middle">${esc(label)}</text>`;
      body += `<rect class="wg-segbox${toneClass(seg.tone)}" x="${x1 + 0.5}" y="${top}" width="${w - 1}" height="${ROW_H}" rx="2"/>`;
      if (seg.hi - seg.lo + 1 >= 3) {
        body += `<text class="wg-tick" x="${x1 + cell / 2}" y="${top + ROW_H + 8}" text-anchor="middle">${seg.hi}</text>`;
        if (seg.hi !== seg.lo) body += `<text class="wg-tick" x="${x1 + w - cell / 2}" y="${top + ROW_H + 8}" text-anchor="middle">${seg.lo}</text>`;
      }
    }
    for (let bit = widget.width - 1; bit >= 0; bit--) {
      const value = Math.floor(widget.value / 2 ** bit) % 2;
      const key = `${keyPrefix}:b${bit}`;
      record(key, String(value));
      const x = xOf(bit);
      if (fresh.has(key)) body += `<rect class="wg-cell is-fresh" x="${x + 1}" y="${top + 1}" width="${cell - 2}" height="${ROW_H - 2}" rx="1.5"/>`;
      body += `<text class="wg-bit${value ? ' is-one' : ''}" x="${x + cell / 2}" y="${top + ROW_H / 2 + 0.5}" text-anchor="middle">${value}</text>`;
    }
    if (widget.caption) {
      const y = top + ROW_H + 13;
      next.set(`${keyPrefix}:cap`, widget.caption);
      body += `<text class="wg-caption" x="${PAD}" y="${y + 8}">${esc(widget.caption)}</text>`;
    }
  }
  return frame(widget, width, height) + body;
}

/** 整块面板的 SVG 片段。 */
export function panelSvg(id: string, content: PanelContent, previous: Map<string, string>, next: Map<string, string>, minWidth = 0): { markup: string; width: number; height: number } {
  const size = panelSize(content);
  const width = Math.max(size.width, minWidth);
  const { height } = size;
  let y = 0;
  const parts = panelWidgets(content).map((widget, index) => {
    const part = `<g transform="translate(0 ${y})">${widgetSvg(widget, width, `${id}#${index}`, previous, next)}</g>`;
    y += widgetSize(widget).height + GAP;
    return part;
  });
  return { markup: parts.join(''), width, height };
}
