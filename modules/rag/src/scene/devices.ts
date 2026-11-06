/**
 * 设备节点的等距图形。每个设备是一段 SVG 字符串，坐标原点在节点中心。
 * 数据节点（DATA）没有图形，外形由课程给它的数据结构图元决定。节点用途见 lessons/types.ts 的 NODE_IDS。
 */
import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText, type Project } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };
const LABEL = 'fill="var(--art-paper)" letter-spacing="1"';

/** 水平面上的一圈：近似圆的多边形。 */
function disc(p: Project, cx: number, cy: number, z: number, r: number, attrs: string): string {
  const points = Array.from({ length: 28 }, (_, i) => p(cx + r * Math.cos((i / 28) * Math.PI * 2), cy + r * Math.sin((i / 28) * Math.PI * 2), z));
  return polygon(points, attrs);
}

/** 圆柱的侧面：两条竖边之间的面。 */
function drum(p: Project, r: number, z: number, h: number, fill: string): string {
  const k = 0.7071;
  const [lx, ly] = p(-r * k, r * k, z);
  const [rx, ry] = p(r * k, -r * k, z);
  const [lx2, ly2] = p(-r * k, r * k, z + h);
  const [rx2, ry2] = p(r * k, -r * k, z + h);
  return polygon([[lx, ly], [lx2, ly2], [rx2, ry2], [rx, ry]], `fill="${fill}" stroke="none"`) + disc(p, 0, 0, z, r, `fill="none" ${mid}`);
}

/** 应用：带底座的显示器。屏幕上的行是 screen-line，render 事件时逐行画出回答。 */
function app(): string {
  const p = projector(0, 18);
  const w = 100;
  const d = 8;
  const h = 72;
  const x = -w / 2;
  const y = -10;
  const f = facesOf(p, x, y, 8, w, d, h);
  let art = shadow(p, -40, -32, 80, 64, 26);
  art += box(p, -40, -32, 0, 80, 64, 6, { width: 1.9 });
  art += box(p, -7, -12, 6, 14, 12, 4, { width: 1.3 });
  art += box(p, x, y, 8, w, d, h, { width: 2.1 });
  art += quad(f.left, 5, 5, w - 10, h - 10, `fill="var(--art-screen)" ${mid}`);
  art += quad(f.left, 5, h - 14, w - 10, 9, `fill="var(--art-navy)" ${thin}`);
  // 屏幕上是一次问答：右边一条用户问题，左边几行回答，最后一行是引用编号。
  const rows: Array<[number, number, number, string]> = [
    [46, 46, 38, 'var(--term-prompt)'],
    [35, 12, 64, 'var(--term-text)'],
    [26, 12, 52, 'var(--term-text)'],
    [17, 12, 60, 'var(--term-text)'],
    [8, 12, 24, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, u, length, color] of rows) screen += polyline([f.left(u, v), f.left(u + length, v)], `class="screen-line" stroke="${color}" stroke-width="2.8" stroke-linecap="round" pathLength="1"`);
  return `${art}<g class="screen-content">${screen}</g>`;
}

/** 文档库：一个文件盒，里面竖着插了几份文档，最前面一份露出标签。 */
function docs(): string {
  const p = projector(0, 12);
  let art = shadow(p, -44, -36, 88, 72, 22);
  art += box(p, -44, -36, 0, 88, 72, 22, { width: 1.9 });
  const tones = ['var(--art-paper)', 'var(--art-steel-soft)', 'var(--art-paper)', 'var(--art-cyan)'];
  tones.forEach((tone, i) => (art += box(p, -36 + i * 18, -30, 22, 6, 60, 16 + (i % 2) * 6, { top: tone, left: tone, width: 1.3 })));
  const f = facesOf(p, -44, -36, 0, 88, 72, 22);
  art += quad(f.left, 26, 6, 36, 10, `fill="var(--art-navy)" ${thin}`);
  for (let i = 0; i < 2; i++) art += polyline([f.right(10, 7 + i * 7), f.right(60, 7 + i * 7)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** 加载器：一台扫描仪，顶上的进纸口里插着一页文档，正面一盏绿灯。 */
function loader(): string {
  const p = projector(0, 12);
  let art = shadow(p, -42, -34, 84, 68, 22);
  art += box(p, -42, -34, 0, 84, 68, 24, { width: 1.9 });
  art += box(p, -30, -6, 24, 60, 12, 4, { ...NAVY, width: 1.4 });
  // 进纸口里的一页纸：竖着的薄片，上面几行字。
  art += box(p, -24, -2, 28, 48, 3, 30, { top: 'var(--art-paper)', left: 'var(--art-paper)', right: 'var(--art-steel-soft)', width: 1.3 });
  const sheet = facesOf(p, -24, -2, 28, 48, 3, 30);
  for (let i = 0; i < 3; i++) art += polyline([sheet.left(8, 22 - i * 7), sheet.left(i === 2 ? 26 : 40, 22 - i * 7)], 'stroke="var(--art-line-soft)" stroke-width="1.6" stroke-linecap="round"');
  const f = facesOf(p, -42, -34, 0, 84, 68, 24);
  art += quad(f.left, 8, 8, 8, 8, `fill="var(--art-green)" ${thin}`);
  art += quad(f.left, 24, 9, 52, 6, `fill="var(--art-steel)" ${thin}`);
  return art;
}

/** 切分器：一台切纸机，顶面写着 CUT，正面是长短不一的块。 */
function chunker(): string {
  const p = projector(0, 12);
  let art = shadow(p, -46, -38, 92, 76, 24);
  art += box(p, -46, -38, 0, 92, 76, 28, { width: 2 });
  art += box(p, -32, -26, 28, 64, 52, 10, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 38, 'CUT', 14, LABEL);
  const f = facesOf(p, -46, -38, 0, 92, 76, 28);
  const widths = [20, 14, 24, 12];
  let u = 8;
  widths.forEach((bw, i) => {
    art += quad(f.left, u, 8, bw, 12, `fill="${i === 1 ? 'var(--art-amber)' : i % 2 ? 'var(--art-cyan)' : 'var(--art-paper)'}" ${thin}`);
    u += bw + 4;
  });
  // 侧面的刀口。
  art += polygon([f.right(12, 22), f.right(64, 22), f.right(58, 14), f.right(18, 14)], `fill="var(--art-steel)" ${thin}`);
  return art;
}

/** 嵌入模型：一块芯片，顶面写着 EMB，正面一排深浅不一的格子（一个向量）。 */
function embedder(): string {
  const p = projector(0, 10);
  let art = shadow(p, -48, -42, 96, 84, 24);
  art += box(p, -48, -42, 0, 96, 84, 10, { top: 'var(--art-steel-soft)', width: 1.9 });
  art += box(p, -30, -28, 10, 60, 56, 16, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 26, 'EMB', 14, LABEL);
  const board = facesOf(p, -48, -42, 0, 96, 84, 10);
  const shades = ['var(--art-cyan)', 'var(--art-paper)', 'var(--art-amber)', 'var(--art-cyan)', 'var(--art-steel)', 'var(--art-paper)', 'var(--art-amber)'];
  shades.forEach((tone, i) => (art += quad(board.left, 6 + i * 12.5, 2, 9, 6, `fill="${tone}" ${thin}`)));
  for (let i = 0; i < 5; i++) art += quad(board.right, 8 + i * 15, 3, 8, 4, `fill="var(--art-amber)" ${thin}`);
  return art;
}

/** 向量库：三层圆柱（数据库），顶面一圈散点，表示存好的向量。 */
function index(): string {
  const p = projector(0, 14);
  let art = shadow(p, -36, -36, 72, 72, 20);
  for (let i = 0; i < 3; i++) {
    const z = i * 13;
    art += disc(p, 0, 0, z, 34, `fill="var(--art-steel)" ${mid}`);
    art += drum(p, 34, z, 11, 'var(--art-steel-dark)');
    art += disc(p, 0, 0, z + 11, 34, `fill="${i === 2 ? 'var(--art-paper)' : 'var(--art-steel-soft)'}" ${mid}`);
  }
  const dots: Array<[number, number, string]> = [[-14, -8, 'var(--art-navy)'], [-6, 12, 'var(--art-cyan)'], [10, -14, 'var(--art-amber)'], [16, 6, 'var(--art-navy)'], [2, -2, 'var(--art-cyan)'], [-18, 10, 'var(--art-amber)']];
  for (const [x, y, tone] of dots) art += disc(p, x, y, 37, 4, `fill="${tone}" ${thin}`);
  return art;
}

/** 元数据过滤器：底座上一只漏斗，上口大、下口小。 */
function meta(): string {
  const p = projector(0, 12);
  let art = shadow(p, -40, -40, 80, 80, 20);
  art += box(p, -40, -40, 0, 80, 80, 12, { width: 1.9 });
  art += drum(p, 8, 12, 12, 'var(--art-steel-dark)');
  art += disc(p, 0, 0, 24, 8, `fill="var(--art-steel)" ${mid}`);
  // 漏斗的锥面：上下两圈之间连两条母线。
  const k = 0.7071;
  art += polygon([p(-8 * k, 8 * k, 24), p(-32 * k, 32 * k, 44), p(32 * k, -32 * k, 44), p(8 * k, -8 * k, 24)], `fill="var(--art-steel-dark)" ${mid}`);
  art += disc(p, 0, 0, 44, 32, `fill="var(--art-steel-soft)" ${mid}`);
  art += disc(p, 0, 0, 44, 20, `fill="var(--art-cyan)" ${thin}`);
  const f = facesOf(p, -40, -40, 0, 80, 80, 12);
  art += quad(f.left, 8, 3, 30, 6, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** 关键词索引：一排卡片抽屉（图书馆目录），顶面写着 BM25。 */
function bm25(): string {
  const p = projector(0, 10);
  let art = shadow(p, -42, -36, 84, 72, 22);
  for (let i = 0; i < 3; i++) {
    const z = i * 14;
    art += box(p, -42, -36, z, 84, 72, 14, i === 2 ? { ...NAVY, width: 1.6 } : { width: 1.6 });
    const f = facesOf(p, -42, -36, z, 84, 72, 14);
    for (let j = 0; j < 2; j++) art += quad(f.left, 10 + j * 38, 4, 26, 6, `fill="${i === 0 && j === 1 ? 'var(--art-amber)' : 'var(--art-steel)'}" ${thin}`);
  }
  return art + topText(p, 0, 0, 42, 'BM25', 13, LABEL);
}

/** 重排序器：底座上高低不同的三根柱子（名次），最高的一根是绿色。 */
function reranker(): string {
  const p = projector(0, 10);
  let art = shadow(p, -42, -36, 84, 72, 22);
  art += box(p, -42, -36, 0, 84, 72, 10, { width: 1.9 });
  const bars: Array<[number, number, string]> = [[-30, 18, 'var(--art-steel-soft)'], [-8, 40, 'var(--art-green)'], [14, 28, 'var(--art-cyan)']];
  for (const [x, h, tone] of bars) art += box(p, x, -12, 10, 18, 24, h, { top: tone, width: 1.5 });
  const f = facesOf(p, -42, -36, 0, 84, 72, 10);
  art += quad(f.left, 8, 2, 30, 6, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** 大模型：一块大芯片，四周是显存堆栈，顶面写着 LLM。 */
function llm(): string {
  const p = projector(0, 8);
  let art = shadow(p, -54, -46, 108, 92, 26);
  art += box(p, -54, -46, 0, 108, 92, 8, { top: 'var(--art-green-soft)', width: 1.9 });
  art += box(p, -26, -24, 8, 52, 48, 14, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 22, 'LLM', 13, LABEL);
  for (const [x, y] of [[-46, -18], [-46, 4], [32, -18], [32, 4]] as Array<[number, number]>) art += box(p, x, y, 8, 14, 16, 16, { top: 'var(--art-amber)', width: 1.4 });
  const board = facesOf(p, -54, -46, 0, 108, 92, 8);
  for (let i = 0; i < 8; i++) art += quad(board.left, 8 + i * 12, 2, 6, 4, `fill="var(--art-amber)" ${thin}`);
  return art;
}

/** 评估器：一块写字板，纸上三行，前两行打了绿色的勾。 */
function evaluator(): string {
  const p = projector(0, 12);
  let art = shadow(p, -40, -38, 80, 76, 20);
  art += box(p, -40, -38, 0, 80, 76, 8, { ...NAVY, width: 1.8 });
  art += box(p, -32, -30, 8, 64, 60, 3, { top: 'var(--art-paper)', width: 1.3 });
  art += box(p, -12, -40, 8, 24, 8, 8, { top: 'var(--art-steel)', width: 1.3 });
  const top = facesOf(p, -32, -30, 8, 64, 60, 3).top;
  for (let i = 0; i < 3; i++) {
    const v = 12 + i * 16;
    art += quad(top, 22, v, 34, 5, `fill="var(--art-steel-soft)" ${thin}`);
    art += quad(top, 8, v - 1, 8, 7, `fill="${i < 2 ? 'var(--art-green)' : 'var(--art-amber)'}" ${thin}`);
  }
  return art;
}

interface NodeSpec {
  art: string;
  /** 通道到节点中心的裁切半径。 */
  radius: number;
  /** 节点名称相对中心的纵向位置。 */
  labelY: number;
}

const DATA: NodeSpec = { art: '', radius: 64, labelY: 0 };

export const NODE_SPECS: Record<NodeId, NodeSpec> = {
  app: { art: app(), radius: 72, labelY: 90 },
  docs: { art: docs(), radius: 62, labelY: 80 },
  loader: { art: loader(), radius: 62, labelY: 80 },
  chunker: { art: chunker(), radius: 64, labelY: 84 },
  embedder: { art: embedder(), radius: 66, labelY: 82 },
  index: { art: index(), radius: 62, labelY: 80 },
  meta: { art: meta(), radius: 62, labelY: 80 },
  bm25: { art: bm25(), radius: 62, labelY: 80 },
  reranker: { art: reranker(), radius: 62, labelY: 80 },
  llm: { art: llm(), radius: 70, labelY: 84 },
  evaluator: { art: evaluator(), radius: 60, labelY: 78 },
  request: DATA,
  response: DATA,
  text: DATA,
  chunks: DATA,
  tokens: DATA,
  vectors: DATA,
  query: DATA,
  space: DATA,
  codes: DATA,
  results: DATA,
  keywords: DATA,
  fused: DATA,
  prompt: DATA,
  answer: DATA,
  scores: DATA,
  truth: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
