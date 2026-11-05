import type { BoardSpec, BTreeBoard, BarsBoard, FramesBoard, GraphBoard, HashBoard, KvBoard, LanesBoard, PageBoard, SnapshotBoard, TableBoard, Tone, TreeBoard, WalBoard } from './board-types';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => ESC[c]);

/** 结构板字号的统一系数。调大它，所有文字一起变大，宽度估算也跟着变。 */
const FONT = 1.14;

/** Iosevka 的 ASCII 字符宽 0.5 em，中文按 1 em 算。 */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0)! < 0x2e80 ? 0.5 : 1) * size * FONT;
  return width;
}

/** 收集绘制内容，同时记录实际占用的范围。测试用它检查内容不会跑出结构板。 */
class Canvas {
  out: string[] = [];
  maxX = 0;
  maxY = 0;

  private extend(x: number, y: number): void {
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  rect(x: number, y: number, w: number, h: number, cls: string, rx = 2): void {
    this.extend(x + w, y + h);
    this.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${rx}" class="${cls}"/>`);
  }

  text(x: number, y: number, text: string, cls: string, size: number, anchor: 'start' | 'middle' | 'end' = 'start'): void {
    const width = textWidth(text, size);
    const right = anchor === 'start' ? x + width : anchor === 'middle' ? x + width / 2 : x;
    this.extend(right, y + size / 2);
    this.out.push(`<text x="${n(x)}" y="${n(y)}" font-size="${n(size * FONT)}" text-anchor="${anchor}" dominant-baseline="central" class="${cls}">${esc(text)}</text>`);
  }

  line(x1: number, y1: number, x2: number, y2: number, cls: string): void {
    this.extend(Math.max(x1, x2), Math.max(y1, y2));
    this.out.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="${cls}"/>`);
  }

  path(d: string, cls: string, extent?: [number, number]): void {
    if (extent) this.extend(extent[0], extent[1]);
    this.out.push(`<path d="${d}" class="${cls}"/>`);
  }
}

const n = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const toneClass = (tone?: Tone): string => (tone && tone !== 'none' ? ` t-${tone}` : '');

const TITLE = 28;
const PAD = 10;
const LP_FLAG = ['UNUSED', 'NORMAL', 'REDIRECT', 'DEAD'];

function frame(c: Canvas, spec: BoardSpec, w: number, h: number): void {
  c.rect(0, 0, w, h, 'bd-panel', 3);
  c.rect(0, 0, w, TITLE, 'bd-head', 3);
  c.text(PAD, TITLE / 2, spec.title, 'bd-title', 13);
  if (spec.sub) c.text(w - PAD, TITLE / 2, spec.sub, 'bd-sub', 12, 'end');
}

/** 被截断的次数。课程测试要求它是 0：字不能被截到看不懂。 */
let clipped: string[] = [];

/** 把一段文字截到不超过 max。放不下时宁可少显示也不能压到旁边的格子。 */
function clip(text: string, max: number, size: number): string {
  if (textWidth(text, size) <= max) return text;
  clipped.push(text);
  let out = '';
  for (const char of text) {
    if (textWidth(`${out}${char}…`, size) > max) break;
    out += char;
  }
  return `${out}…`;
}

function tableRows(c: Canvas, x: number, y: number, w: number, columns: string[], widths: number[], rows: TableBoard['rows'], rowH = 24): number {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = (w - 2) / total;
  const xs: number[] = [];
  let cursor = x + 1;
  for (const width of widths) {
    xs.push(cursor);
    cursor += width * scale;
  }
  let at = y;
  c.rect(x, at, w, 21, 'bd-thead', 0);
  columns.forEach((name, i) => c.text(xs[i] + 5, at + 10.5, clip(name, widths[i] * scale - 8, 11.5), 'bd-th', 11.5));
  at += 21;
  for (const row of rows) {
    c.rect(x, at, w, rowH, `bd-row${toneClass(row.hot)}${row.hot ? ' is-hot' : ''}${row.muted ? ' is-muted' : ''}`, 0);
    row.cells.forEach((cell, i) => c.text(xs[i] + 5, at + rowH / 2, clip(cell, widths[i] * scale - 8, 13), `bd-td${row.muted ? ' is-muted' : ''}`, 13));
    if (row.strike) c.line(x + 4, at + rowH / 2, x + w - 4, at + rowH / 2, 'bd-strike');
    at += rowH;
  }
  return at;
}

/** 页面带：左边头部和行指针，中间空闲，右边元组。比例是示意的，偏移数字是真的。 */
function drawPage(c: Canvas, s: PageBoard, w: number): void {
  const x0 = PAD;
  const y0 = TITLE + 8;
  const stripW = w - PAD * 2;
  const stripY = y0 + 18;
  const H = 40;
  const lpW = Math.min(46, (stripW - 200) / Math.max(1, s.lps.length + s.tuples.length));
  const tupW = lpW * 1.15;
  const headW = 50;
  const lpTotal = s.lps.length * lpW;
  const specialW = s.special < s.size ? 54 : 0;
  const tupTotal = s.tuples.length * tupW;
  const freeW = stripW - headW - lpTotal - tupTotal - specialW;

  c.text(x0, y0 + 6, '0', 'bd-off', 11.5);
  c.rect(x0, stripY, headW, H, 'bd-seg s-head', 0);
  c.text(x0 + headW / 2, stripY + 13, '页头', 'bd-seg-t', 12, 'middle');
  c.text(x0 + headW / 2, stripY + 28, '24 B', 'bd-seg-s', 11, 'middle');

  const lpCenters = new Map<number, number>();
  s.lps.forEach((lp, i) => {
    const lx = x0 + headW + i * lpW;
    lpCenters.set(lp.n, lx + lpW / 2);
    c.rect(lx, stripY, lpW, H, `bd-seg s-lp f${lp.flags}${toneClass(lp.hot)}${lp.hot ? ' is-hot' : ''}`, 0);
    c.text(lx + lpW / 2, stripY + 13, String(lp.n), 'bd-seg-t', 12.5, 'middle');
    c.text(lx + lpW / 2, stripY + 28, lp.flags === 1 ? String(lp.off) : LP_FLAG[lp.flags].slice(0, 3), 'bd-seg-s', 10.5, 'middle');
  });

  const fx = x0 + headW + lpTotal;
  c.rect(fx, stripY, freeW, H, 'bd-seg s-free', 0);
  const freeText = `空闲 ${s.upper - s.lower} B`;
  if (freeW > textWidth(freeText, 12) + 6) c.text(fx + freeW / 2, stripY + H / 2, freeText, 'bd-seg-s', 12, 'middle');

  const tupleCenters = new Map<number, number>();
  s.tuples.forEach((t, i) => {
    const tx = fx + freeW + i * tupW;
    tupleCenters.set(t.lp, tx + tupW / 2);
    c.rect(tx, stripY, tupW, H, `bd-seg s-tup${t.muted ? ' is-muted' : ''}${toneClass(t.hot)}${t.hot ? ' is-hot' : ''}`, 0);
    c.text(tx + tupW / 2, stripY + 13, t.label, 'bd-seg-t', 12, 'middle');
    c.text(tx + tupW / 2, stripY + 28, String(t.off), 'bd-seg-s', 10.5, 'middle');
  });
  if (specialW) {
    const sx = x0 + stripW - specialW;
    c.rect(sx, stripY, specialW, H, 'bd-seg s-special', 0);
    c.text(sx + specialW / 2, stripY + 13, '特殊区', 'bd-seg-t', 12, 'middle');
    c.text(sx + specialW / 2, stripY + 28, `${s.size - s.special} B`, 'bd-seg-s', 10.5, 'middle');
  }

  // 偏移刻度：pd_lower 和 pd_upper 的位置都是页头里的真实值。
  const lowerText = `pd_lower ${s.lower}`;
  const upperText = `pd_upper ${s.upper}`;
  if (textWidth(lowerText, 11.5) + textWidth(upperText, 11.5) + 8 <= freeW) {
    c.text(fx, y0 + 6, lowerText, 'bd-ptr', 11.5);
    c.text(fx + freeW, y0 + 6, upperText, 'bd-ptr', 11.5, 'end');
  } else {
    // 空闲段太窄时，两个指针合写在一行，放在页面带中间。
    c.text(x0 + stripW / 2, y0 + 6, `pd_lower ${s.lower} · pd_upper ${s.upper}`, 'bd-ptr', 11.5, 'middle');
  }
  c.text(x0 + stripW, y0 + 6, String(s.size), 'bd-off', 11.5, 'end');

  // 行指针到元组的连线：画在带子下方。
  const curveY = stripY + H;
  s.lps.forEach((lp, i) => {
    const from = lpCenters.get(lp.n)!;
    if (lp.flags === 1 && tupleCenters.has(lp.n)) {
      const to = tupleCenters.get(lp.n)!;
      const depth = 13 + (i % 3) * 4;
      c.path(`M${n(from)},${curveY} C${n(from)},${curveY + depth} ${n(to)},${curveY + depth} ${n(to)},${curveY + 1}`, `bd-link${lp.hot ? ' is-hot' : ''}${toneClass(lp.hot)}`, [Math.max(from, to), curveY + depth]);
    }
    if (lp.flags === 2 && lpCenters.has(lp.off)) {
      const to = lpCenters.get(lp.off)!;
      c.path(`M${n(from)},${curveY} C${n(from)},${curveY + 12} ${n(to)},${curveY + 12} ${n(to)},${curveY + 1}`, 'bd-link is-redirect', [Math.max(from, to), curveY + 12]);
    }
  });

  if (s.columns && s.rows) tableRows(c, x0, curveY + 24, stripW, s.columns, s.widths!, s.rows);
}

function drawFrames(c: Canvas, s: FramesBoard, w: number): void {
  const gap = 8;
  const cols = s.columns;
  const cw = (w - PAD * 2 - gap * (cols - 1)) / cols;
  const ch = 80;
  s.frames.forEach((f, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAD + col * (cw + gap);
    const y = TITLE + 12 + row * (ch + gap + 8);
    const isHand = f.id === s.hand;
    c.rect(x, y, cw, ch, `bd-frame${f.tag === '—' ? ' is-empty' : ''}${f.dirty ? ' is-dirty' : ''}${toneClass(f.hot)}${f.hot ? ' is-hot' : ''}`, 2);
    c.text(x + 7, y + 13, `帧 ${f.id}`, 'bd-th', 11.5);
    if (f.dirty) c.text(x + cw - 7, y + 13, '脏', 'bd-dirty', 12, 'end');
    c.text(x + 7, y + 33, clip(f.tag, cw - 14, 14), 'bd-tag', 14);
    // 使用计数：5 个格子，上限就是 BM_MAX_USAGE_COUNT。
    const pip = Math.min(13, (cw - 58) / 5);
    c.text(x + 7, y + 53, 'usage', 'bd-seg-s', 11);
    for (let k = 0; k < 5; k++) c.rect(x + 42 + k * (pip + 1), y + 47, pip, 12, `bd-pip${k < f.usage ? ' is-on' : ''}`, 1);
    c.text(x + 7, y + 69, `ref ${f.ref}`, f.ref ? 'bd-ref is-on' : 'bd-ref', 11.5);
    if (isHand) {
      c.path(`M${n(x + cw / 2 - 6)},${y - 8} L${n(x + cw / 2 + 6)},${y - 8} L${n(x + cw / 2)},${y - 1} Z`, 'bd-hand', [x + cw / 2 + 6, y]);
      c.text(x + cw / 2 + 10, y - 7, '指针', 'bd-ptr', 11);
    }
  });
}

interface NodeBox {
  node: BTreeBoard['levels'][number][number];
  x: number;
  y: number;
  w: number;
}

function drawBTree(c: Canvas, s: BTreeBoard, w: number, h: number): void {
  const top = TITLE + 10;
  const footer = s.footer ? 22 : 0;
  const levelCount = s.levels.length;
  const nodeH = 44;
  const vGap = levelCount > 1 ? Math.min(46, (h - top - footer - 8 - nodeH * levelCount) / (levelCount - 1)) : 0;
  const availW = w - PAD * 2;
  const leafRow = s.levels[levelCount - 1] ?? [];
  const cellsOf = (node: BTreeBoard['levels'][number][number]) => Math.max(1, node.keys.length) + (node.high !== undefined ? 1 : 0);
  const widest = Math.max(...s.levels.map((row) => row.reduce((sum, node) => sum + cellsOf(node), 0) + row.length * 0.2));
  const gaps = (Math.max(...s.levels.map((row) => row.length)) - 1) * 12;
  const cell = Math.min(38, (availW - gaps) / widest);
  const boxW = (node: BTreeBoard['levels'][number][number]) => cellsOf(node) * cell + 4;

  const boxes = new Map<number, NodeBox>();
  // 叶子层先排开，上层节点放在孩子的中点。
  const leafTotal = leafRow.reduce((sum, node) => sum + boxW(node), 0) + (leafRow.length - 1) * 12;
  let cursor = PAD + (availW - leafTotal) / 2;
  const yOf = (level: number) => top + level * (nodeH + vGap);
  for (const node of leafRow) {
    boxes.set(node.block, { node, x: cursor, y: yOf(levelCount - 1), w: boxW(node) });
    cursor += boxW(node) + 12;
  }
  for (let level = levelCount - 2; level >= 0; level--) {
    const row = s.levels[level];
    const placed = row.map((node) => {
      const kids = node.children.map((id) => boxes.get(id)).filter((b): b is NodeBox => Boolean(b));
      const mid = kids.length ? (kids[0].x + kids[kids.length - 1].x + kids[kids.length - 1].w) / 2 : w / 2;
      return { node, x: mid - boxW(node) / 2, y: yOf(level), w: boxW(node) };
    });
    // 同层不能重叠，也不能出框。
    for (let i = 1; i < placed.length; i++) placed[i].x = Math.max(placed[i].x, placed[i - 1].x + placed[i - 1].w + 10);
    const last = placed[placed.length - 1];
    if (last && last.x + last.w > w - PAD) {
      const shift = last.x + last.w - (w - PAD);
      for (const box of placed) box.x -= shift;
    }
    for (const box of placed) {
      box.x = Math.max(PAD, box.x);
      boxes.set(box.node.block, box);
    }
  }

  const hotPath = new Set((s.path ?? []).map(([a, b]) => `${a}>${b}`));
  for (const box of boxes.values()) {
    box.node.children.forEach((child, index) => {
      const kid = boxes.get(child);
      if (!kid) return;
      const fromX = box.x + 2 + cell * (index + 0.5);
      const hot = hotPath.has(`${box.node.block}>${child}`);
      c.line(Math.min(fromX, box.x + box.w), box.y + nodeH, kid.x + kid.w / 2, kid.y, `bd-edge${hot ? ' is-hot' : ''}`);
    });
  }
  // 叶子的右链（btpo_next）。
  leafRow.forEach((node, i) => {
    const next = leafRow[i + 1];
    if (!next) return;
    const a = boxes.get(node.block)!;
    const b = boxes.get(next.block)!;
    c.line(a.x + a.w, a.y + nodeH - 12, b.x, b.y + nodeH - 12, 'bd-rightlink');
  });
  for (const box of boxes.values()) {
    const { node, x, y } = box;
    c.rect(x, y, box.w, nodeH, `bd-node${node.leaf ? ' is-leaf' : ''}${toneClass(node.hot)}${node.hot ? ' is-hot' : ''}`, 2);
    c.text(x + 4, y + 9, `块 ${node.block}`, 'bd-seg-s', 10.5);
    let at = x + 2;
    const cy = y + 18;
    node.keys.forEach((key, index) => {
      c.rect(at, cy, cell, 24, `bd-key${index === node.hotKey ? ' is-hot' : ''}`, 0);
      c.text(at + cell / 2, cy + 12, key === undefined ? '−∞' : String(key), 'bd-keyt', Math.min(13.5, cell * 0.42), 'middle');
      at += cell;
    });
    if (node.high !== undefined) {
      c.rect(at, cy, cell, 24, 'bd-key is-high', 0);
      c.text(at + cell / 2, cy + 12, String(node.high), 'bd-keyt is-high', Math.min(13.5, cell * 0.42), 'middle');
    }
  }
  if (s.footer) c.text(PAD, h - 12, s.footer, 'bd-note', 12.5);
}

const STATUS_CLASS = { committed: 'is-committed', aborted: 'is-aborted', running: 'is-running', future: 'is-future' };

function drawSnapshot(c: Canvas, s: SnapshotBoard, w: number): void {
  const count = s.to - s.from + 1;
  const cell = Math.min(50, (w - PAD * 2) / count);
  const left = PAD + (w - PAD * 2 - cell * count) / 2;
  const y = TITLE + 42;
  const xAt = (xid: number) => left + (xid - s.from) * cell;
  for (let xid = s.from; xid <= s.to; xid++) {
    const x = xAt(xid);
    const inXip = s.xip?.includes(xid);
    c.rect(x + 1, y, cell - 2, 32, `bd-xid ${STATUS_CLASS[s.status[xid] ?? 'future']}${inXip ? ' in-xip' : ''}${xid === s.me ? ' is-me' : ''}`, 2);
    c.text(x + cell / 2, y + 16, String(xid), 'bd-keyt', 12.5, 'middle');
  }
  if (s.xmin !== undefined) {
    const x = xAt(Math.max(s.from, s.xmin));
    // xmin 的标签朝左、xmax 的朝右，两者靠得很近时也不会叠在一起。
    c.path(`M${n(x)},${y - 3} v-13 h-14`, 'bd-bracket', [x, y]);
    c.text(x - 17, y - 16, `xmin ${s.xmin}`, 'bd-ptr', 12, 'end');
  }
  if (s.xmax !== undefined) {
    const x = xAt(Math.min(s.to + 1, s.xmax));
    c.path(`M${n(x)},${y - 3} v-13 h14`, 'bd-bracket', [x + 14, y]);
    c.text(x + 17, y - 16, `xmax ${s.xmax}`, 'bd-ptr', 12);
  }
  if (s.probe !== undefined) {
    const x = xAt(s.probe) + cell / 2;
    c.path(`M${n(x)},${y + 37} l-5,7 h10 Z`, 'bd-hand', [x + 5, y + 44]);
  }
  const ly = y + 56;
  const legend: Array<[string, string]> = [['is-committed', '已提交'], ['is-running', '进行中'], ['is-aborted', '已回滚'], ['is-future', '未开始']];
  let lx = PAD;
  for (const [cls, name] of legend) {
    c.rect(lx, ly - 6, 12, 12, `bd-xid ${cls}`, 2);
    c.text(lx + 16, ly, name, 'bd-seg-s', 11.5);
    lx += 72;
  }
  if (s.text) c.text(w - PAD, ly, s.text, 'bd-tag', 13.5, 'end');
  if (s.probeText) c.text(PAD, ly + 22, clip(s.probeText, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawTable(c: Canvas, s: TableBoard, w: number, h: number): void {
  tableRows(c, PAD, TITLE + 8, w - PAD * 2, s.columns, s.widths, s.rows);
  if (s.note) c.text(PAD, h - 12, clip(s.note, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function chips(c: Canvas, x: number, y: number, maxX: number, items: Array<{ text: string; hot?: Tone }>, arrow: boolean): void {
  let at = x;
  for (const item of items) {
    const width = textWidth(item.text, 12.5) + 12;
    if (at + width > maxX) break;
    if (arrow && at > x) {
      c.line(at - 8, y + 10, at - 1, y + 10, 'bd-chain');
    }
    c.rect(at, y, width, 20, `bd-chip${toneClass(item.hot)}${item.hot ? ' is-hot' : ''}`, 2);
    c.text(at + width / 2, y + 10, item.text, 'bd-keyt', 12.5, 'middle');
    at += width + 9;
  }
}

function drawHash(c: Canvas, s: HashBoard, w: number, h: number): void {
  const fileW = s.files ? Math.min(240, w * 0.38) : 0;
  const leftW = w - PAD * 2 - (fileW ? fileW + 12 : 0);
  const rowH = 25;
  const top = TITLE + 8;
  s.buckets.forEach((chain, i) => {
    const y = top + i * rowH;
    c.rect(PAD, y, 42, rowH - 3, `bd-bucket${i === s.hotBucket ? ' is-hot' : ''}`, 0);
    c.text(PAD + 21, y + (rowH - 3) / 2, `桶 ${i}`, 'bd-seg-s', 11.5, 'middle');
    c.rect(PAD + 42, y, leftW - 42, rowH - 3, `bd-lane${i === s.hotBucket ? ' is-hot' : ''}`, 0);
    chips(c, PAD + 47, y + 1, PAD + leftW - 4, chain, true);
  });
  if (s.files) {
    const fx = w - PAD - fileW;
    let y = top;
    for (const file of s.files) {
      const lines = Math.max(1, Math.ceil(file.items.reduce((sum, item) => sum + textWidth(item.text, 12.5) + 21, 0) / (fileW - 12)));
      const height = 28 + lines * 24;
      c.rect(fx, y, fileW, height, 'bd-file', 2);
      c.text(fx + 7, y + 13, clip(file.label, fileW - 14, 12), 'bd-th', 12);
      let row = 0;
      let at = fx + 6;
      for (const item of file.items) {
        const width = textWidth(item.text, 12.5) + 12;
        if (at + width > fx + fileW - 4) {
          row += 1;
          at = fx + 6;
        }
        c.rect(at, y + 26 + row * 24, width, 20, `bd-chip is-file${toneClass(item.hot)}${item.hot ? ' is-hot' : ''}`, 2);
        c.text(at + width / 2, y + 36 + row * 24, item.text, 'bd-keyt', 12.5, 'middle');
        at += width + 5;
      }
      y += height + 8;
    }
  }
  if (s.footer) c.text(PAD, h - 12, clip(s.footer, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawLanes(c: Canvas, s: LanesBoard, w: number, h: number): void {
  const labelW = s.labelWidth ?? 66;
  const avail = w - PAD * 2 - labelW;
  const hasSub = s.rows.some((row) => row.cells.some((cell) => cell.sub));
  const rowH = hasSub ? 44 : 32;
  const cellH = hasSub ? 38 : 26;
  const longest = Math.max(1, ...s.rows.map((row) => row.cells.reduce((sum, cell) => sum + (cell.gap ? 0.4 : 1), 0)));
  const base = s.cell ?? 34;
  const cell = Math.min(base, avail / longest);
  let y = TITLE + 8;
  for (const row of s.rows) {
    c.text(PAD, y + cellH / 2, clip(row.label, labelW - 4, 12), row.hot ? 'bd-th is-hot' : 'bd-th', 12);
    let x = PAD + labelW;
    for (const item of row.cells) {
      if (item.gap) {
        x += cell * 0.4;
        continue;
      }
      c.rect(x, y, cell - 2, cellH, `bd-cell${item.muted ? ' is-muted' : ''}${toneClass(item.hot)}${item.hot ? ' is-hot' : ''}`, 1);
      const size = Math.min(13, (cell - 4) / Math.max(1, textWidth(item.text, 1)));
      c.text(x + (cell - 2) / 2, y + (item.sub ? 13 : cellH / 2), item.text, item.muted ? 'bd-keyt is-muted' : 'bd-keyt', size, 'middle');
      if (item.sub) c.text(x + (cell - 2) / 2, y + 29, item.sub, 'bd-seg-s', Math.min(10.5, (cell - 4) / Math.max(1, textWidth(item.sub, 1))), 'middle');
      x += cell;
    }
    y += rowH;
  }
  if (s.footer) c.text(PAD, h - 12, clip(s.footer, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawGraph(c: Canvas, s: GraphBoard, w: number, h: number): void {
  const cx = w / 2;
  const cy = TITLE + (h - TITLE - (s.footer ? 22 : 0)) / 2;
  const rx = Math.min(w / 2 - 70, 170);
  const ry = Math.min((h - TITLE - (s.footer ? 22 : 0)) / 2 - 32, 90);
  const place = new Map<string, { x: number; y: number }>();
  s.nodes.forEach((node, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / s.nodes.length;
    place.set(node.id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  });
  const NW = 104;
  const NH = 42;
  for (const edge of s.edges) {
    const a = place.get(edge.from)!;
    const b = place.get(edge.to)!;
    // 从矩形边界出发到矩形边界，箭头不会被节点盖住。
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clipAt = (dirx: number, diry: number) => {
      const tx = Math.abs(dirx) > 0 ? NW / 2 / Math.abs(dirx) : Infinity;
      const ty = Math.abs(diry) > 0 ? NH / 2 / Math.abs(diry) : Infinity;
      return Math.min(tx, ty);
    };
    const t = clipAt(dx, dy);
    const nx = (-dy / Math.hypot(dx, dy)) * 7;
    const ny = (dx / Math.hypot(dx, dy)) * 7;
    const x1 = a.x + dx * t + nx;
    const y1 = a.y + dy * t + ny;
    const x2 = b.x - dx * t + nx;
    const y2 = b.y - dy * t + ny;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    c.line(x1, y1, x2, y2, `bd-wait${toneClass(edge.tone)}`);
    const ax = x2;
    const ay = y2;
    const w1 = angle + 2.7;
    const w2 = angle - 2.7;
    c.path(`M${n(ax)},${n(ay)} L${n(ax + 9 * Math.cos(w1))},${n(ay + 9 * Math.sin(w1))} L${n(ax + 9 * Math.cos(w2))},${n(ay + 9 * Math.sin(w2))} Z`, `bd-arrow${toneClass(edge.tone)}`);
    if (edge.label) {
      const mx = (x1 + x2) / 2 + nx * 1.1;
      const my = (y1 + y2) / 2 + ny * 1.1;
      const lw = textWidth(edge.label, 11.5) + 8;
      c.rect(mx - lw / 2, my - 8, lw, 16, 'bd-edge-bg', 2);
      c.text(mx, my, edge.label, 'bd-seg-s', 11.5, 'middle');
    }
  }
  for (const node of s.nodes) {
    const p = place.get(node.id)!;
    c.rect(p.x - NW / 2, p.y - NH / 2, NW, NH, `bd-gnode${toneClass(node.tone)}${node.tone && node.tone !== 'none' ? ' is-hot' : ''}`, 3);
    c.text(p.x, p.y - (node.sub ? 8 : 0), node.label, 'bd-tag', 13.5, 'middle');
    if (node.sub) c.text(p.x, p.y + 10, node.sub, 'bd-seg-s', 11, 'middle');
  }
  if (s.footer) c.text(PAD, h - 12, clip(s.footer, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawWal(c: Canvas, s: WalBoard, w: number, h: number): void {
  const avail = w - PAD * 2;
  const perRow = Math.max(3, Math.floor(avail / 104));
  const cw = avail / perRow;
  const top = TITLE + 10;
  const ch = 56;
  s.records.forEach((rec, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = PAD + col * cw;
    const y = top + row * (ch + 8);
    c.rect(x + 1, y, cw - 3, ch, `bd-rec${rec.durable ? ' is-durable' : ''}${rec.torn ? ' is-torn' : ''}${toneClass(rec.tone)}${rec.hot ? ' is-hot' : ''}`, 2);
    c.text(x + 7, y + 13, clip(rec.lsn, cw - 14, 11.5), 'bd-seg-s', 11.5);
    c.text(x + 7, y + 30, clip(rec.label, cw - 14, 13), 'bd-tag', 13);
    c.text(x + 7, y + 46, clip(rec.mark ?? `${rec.size} B`, cw - 14, 11), 'bd-seg-s', 11);
  });
  const rows = Math.max(1, Math.ceil(s.records.length / perRow));
  let y = top + rows * (ch + 8) + 4;
  for (const pointer of s.pointers) {
    c.rect(PAD, y, 8, 14, `bd-pmark${toneClass(pointer.tone)}`, 1);
    c.text(PAD + 14, y + 7, pointer.name, 'bd-th', 12);
    c.text(PAD + 130, y + 7, pointer.lsn, 'bd-tag', 13);
    y += 19;
  }
  if (s.footer) c.text(PAD, h - 12, clip(s.footer, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawTree(c: Canvas, s: TreeBoard, w: number): void {
  const rowH = 24;
  const top = TITLE + 8;
  const stack: number[] = [];
  s.rows.forEach((row, i) => {
    const y = top + i * rowH;
    const x = PAD + row.depth * 18;
    if (row.depth > 0) {
      const parentY = stack[row.depth - 1] ?? y - rowH;
      c.path(`M${x - 10},${n(parentY + 10)} V${y + 11} H${x - 2}`, 'bd-treeline');
    }
    stack[row.depth] = y;
    const width = textWidth(row.name, 13.5) + 10;
    c.rect(x, y, width, 21, `bd-tnode${toneClass(row.hot)}${row.hot ? ' is-hot' : ''}`, 2);
    c.text(x + 5, y + 10.5, row.name, 'bd-tag', 13.5);
    if (row.detail) c.text(x + width + 7, y + 10.5, clip(row.detail, w - PAD - (x + width + 7), 12.5), 'bd-seg-s', 12.5);
  });
}

function drawBars(c: Canvas, s: BarsBoard, w: number, h: number): void {
  const labelW = 128;
  const totalW = 64;
  const trackW = w - PAD * 2 - labelW - totalW - 8;
  const top = TITLE + 12;
  const rowH = 66;
  s.bars.forEach((bar, i) => {
    const y = top + i * rowH;
    c.text(PAD, y + 11, clip(bar.label, labelW - 6, 12.5), bar.winner ? 'bd-tag is-win' : 'bd-tag', 12.5);
    c.rect(PAD + labelW, y, trackW, 22, 'bd-track', 1);
    let x = PAD + labelW;
    for (const part of bar.parts) {
      const width = Math.max(0, (part.value / s.max) * trackW);
      if (width <= 0.3) continue;
      c.rect(x, y, width, 22, `bd-part${toneClass(part.tone)}`, 0);
      x += width;
    }
    c.text(w - PAD, y + 11, bar.total, bar.winner ? 'bd-tag is-win' : 'bd-tag', 13.5, 'end');
    // 每一部分都带色块和数字，一行放不下就换行。
    let lx = PAD;
    let ly = y + 34;
    for (const part of bar.parts) {
      if (part.value <= 0) continue;
      const text = `${part.name} ${part.value.toFixed(2)}`;
      const width = textWidth(text, 11) + 16;
      if (lx + width > w - PAD) {
        lx = PAD;
        ly += 15;
      }
      c.rect(lx, ly - 4, 8, 8, `bd-part${toneClass(part.tone)}`, 1);
      c.text(lx + 11, ly, text, 'bd-seg-s', 11);
      lx += width + 6;
    }
  });
  if (s.footer) c.text(PAD, h - 12, clip(s.footer, w - PAD * 2, 12.5), 'bd-note', 12.5);
}

function drawKv(c: Canvas, s: KvBoard, w: number): void {
  const keyW = s.keyWidth ?? 150;
  const rowH = 24;
  s.rows.forEach((row, i) => {
    const y = TITLE + 8 + i * rowH;
    c.rect(PAD, y, w - PAD * 2, rowH - 2, `bd-row${toneClass(row.hot)}${row.hot ? ' is-hot' : ''}`, 0);
    c.text(PAD + 6, y + (rowH - 2) / 2, clip(row.k, keyW - 8, 12.5), 'bd-th', 12.5);
    c.text(PAD + keyW, y + (rowH - 2) / 2, clip(row.v, w - PAD * 2 - keyW - 6, 13), 'bd-td', 13);
  });
}

export interface BoardRender {
  svg: string;
  width: number;
  height: number;
  clipped: string[];
}

/** 纯函数：同样的 spec 一定画出同样的内容，所以后退和跳步不会留下旧状态。 */
export function renderBoard(spec: BoardSpec, w: number, h: number): BoardRender {
  const c = new Canvas();
  clipped = [];
  frame(c, spec, w, h);
  // 外框不算内容：测试和窄屏重排要的是内容实际占到哪里。
  c.maxX = 0;
  c.maxY = 0;
  switch (spec.kind) {
    case 'page':
      drawPage(c, spec, w);
      break;
    case 'frames':
      drawFrames(c, spec, w);
      break;
    case 'btree':
      drawBTree(c, spec, w, h);
      break;
    case 'snapshot':
      drawSnapshot(c, spec, w);
      break;
    case 'table':
      drawTable(c, spec, w, h);
      break;
    case 'hash':
      drawHash(c, spec, w, h);
      break;
    case 'lanes':
      drawLanes(c, spec, w, h);
      break;
    case 'graph':
      drawGraph(c, spec, w, h);
      break;
    case 'wal':
      drawWal(c, spec, w, h);
      break;
    case 'tree':
      drawTree(c, spec, w);
      break;
    case 'bars':
      drawBars(c, spec, w, h);
      break;
    case 'kv':
      drawKv(c, spec, w);
      break;
  }
  return { svg: c.out.join(''), width: c.maxX, height: c.maxY, clipped };
}
