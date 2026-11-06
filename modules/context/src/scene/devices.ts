/**
 * 设备节点的等距图形。每个设备是一段 SVG 字符串，坐标原点在节点中心。
 * 数据节点（DATA）没有图形，外形由课程给它的数据结构图元决定。节点用途见 lessons/types.ts 的 NODE_IDS。
 */
import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText, type Project } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };

/** 顶面上的一圈：近似圆的多边形。 */
function disc(p: Project, cx: number, cy: number, z: number, r: number, attrs: string): string {
  const points = Array.from({ length: 28 }, (_, i) => p(cx + r * Math.cos((i / 28) * Math.PI * 2), cy + r * Math.sin((i / 28) * Math.PI * 2), z));
  return polygon(points, attrs);
}

/** 应用：带底座的显示器。屏幕上的行是 screen-line，render 事件时逐行画出回复。 */
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
  // 屏幕上是一段对话：右边一条用户气泡，左边几行回复。
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

/** SDK：一个工具箱，顶面写着 SDK，正面三个格子是序列化、加头、重试。 */
function sdk(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -36, 88, 72, 24);
  art += box(p, -44, -36, 0, 88, 72, 28, { width: 2 });
  art += box(p, -30, -24, 28, 60, 48, 9, { ...NAVY, width: 1.7 });
  art += topText(p, 0, 0, 37, 'SDK', 14, 'fill="var(--art-paper)" letter-spacing="1"');
  const f = facesOf(p, -44, -36, 0, 88, 72, 28);
  ['var(--art-cyan)', 'var(--art-paper)', 'var(--art-amber)'].forEach((tone, i) => (art += quad(f.left, 8 + i * 26, 8, 20, 12, `fill="${tone}" ${thin}`)));
  for (let i = 0; i < 3; i++) art += polyline([f.right(10, 7 + i * 6), f.right(60, 7 + i * 6)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** 网络：一段带锁的管道，表示 TLS 隧道。 */
function net(): string {
  const p = projector(0, 8);
  let art = shadow(p, -50, -22, 100, 44, 20);
  art += box(p, -50, -22, 0, 100, 44, 22, { width: 1.9 });
  const f = facesOf(p, -50, -22, 0, 100, 44, 22);
  for (let i = 0; i < 5; i++) art += quad(f.left, 8 + i * 18, 7, 12, 8, `fill="${i % 2 ? 'var(--art-steel)' : 'var(--art-cyan)'}" ${thin}`);
  const top = facesOf(p, -50, -22, 0, 100, 44, 22).top;
  art += quad(top, 6, 8, 88, 28, `fill="var(--art-steel-soft)" ${thin}`);
  // 顶面的锁：锁身和锁梁。
  art += box(p, -9, -7, 22, 18, 14, 12, { ...NAVY, width: 1.5 });
  art += polyline([p(-4, 0, 34), p(-4, 0, 41), p(5, 0, 41), p(5, 0, 34)], `stroke="var(--art-navy)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`);
  return art;
}

/** API 入口：两层机架，正面有指示灯，顶面写着 API。 */
function gateway(): string {
  const p = projector(0, 10);
  let art = shadow(p, -40, -40, 80, 80, 26);
  for (let i = 0; i < 2; i++) {
    const z = i * 22;
    art += box(p, -40, -40, z, 80, 80, 22, i === 0 ? { ...NAVY, width: 1.8 } : { width: 1.8 });
    const f = facesOf(p, -40, -40, z, 80, 80, 22);
    for (let j = 0; j < 4; j++) art += quad(f.left, 8 + j * 9, 8, 6, 6, `fill="${j === 0 ? 'var(--art-green)' : 'var(--art-steel)'}" ${thin}`);
    art += quad(f.left, 46, 7, 26, 8, `fill="var(--art-steel-soft)" ${thin}`);
    for (let j = 0; j < 3; j++) art += polyline([f.right(10, 6 + j * 5), f.right(70, 6 + j * 5)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  }
  const top = facesOf(p, -40, -40, 22, 80, 80, 22).top;
  art += quad(top, 14, 14, 52, 52, `fill="var(--art-navy)" ${thin}`);
  return art + topText(p, 0, 0, 44, 'API', 15, 'fill="var(--art-paper)" letter-spacing="1"');
}

/** 限流器：一只漏斗形的桶，桶里有几枚令牌。 */
function rate(): string {
  const p = projector(0, 12);
  let art = shadow(p, -40, -40, 80, 80, 22);
  art += box(p, -40, -40, 0, 80, 80, 14, { width: 1.9 });
  // 桶：从底座往上的圆柱，用几圈叠出来。
  art += disc(p, 0, 0, 14, 30, `fill="var(--art-steel)" ${mid}`);
  art += disc(p, 0, 0, 34, 30, `fill="var(--art-steel-soft)" ${mid}`);
  const [lx, ly] = p(-30 * 0.7071, 30 * 0.7071, 14);
  const [rx, ry] = p(30 * 0.7071, -30 * 0.7071, 14);
  const [lx2, ly2] = p(-30 * 0.7071, 30 * 0.7071, 34);
  const [rx2, ry2] = p(30 * 0.7071, -30 * 0.7071, 34);
  art += polyline([[lx, ly], [lx2, ly2]], `stroke="var(--art-line)" stroke-width="1.6"`) + polyline([[rx, ry], [rx2, ry2]], `stroke="var(--art-line)" stroke-width="1.6"`);
  // 令牌。
  for (const [x, y, tone] of [[-10, -6, 'var(--art-amber)'], [8, -10, 'var(--art-amber)'], [2, 10, 'var(--art-paper)']] as Array<[number, number, string]>) art += box(p, x - 6, y - 6, 34, 12, 12, 5, { top: tone, width: 1.2 });
  const f = facesOf(p, -40, -40, 0, 80, 80, 14);
  art += quad(f.left, 8, 4, 30, 6, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** 模型：一块大芯片，四周是显存堆栈，顶面写着 LLM。 */
function model(): string {
  const p = projector(0, 8);
  let art = shadow(p, -54, -46, 108, 92, 26);
  art += box(p, -54, -46, 0, 108, 92, 8, { top: 'var(--art-green-soft)', width: 1.9 });
  art += box(p, -26, -24, 8, 52, 48, 14, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 22, 'LLM', 13, 'fill="var(--art-paper)" letter-spacing="1"');
  for (const [x, y] of [[-46, -18], [-46, 4], [32, -18], [32, 4]] as Array<[number, number]>) art += box(p, x, y, 8, 14, 16, 16, { top: 'var(--art-amber)', width: 1.4 });
  const board = facesOf(p, -54, -46, 0, 108, 92, 8);
  for (let i = 0; i < 8; i++) art += quad(board.left, 8 + i * 12, 2, 6, 4, `fill="var(--art-amber)" ${thin}`);
  return art;
}

/** 分词器和模板：一台切片机，顶面写着 TOK，正面是长短不一的 token 块。 */
function tokenizer(): string {
  const p = projector(0, 12);
  let art = shadow(p, -46, -40, 92, 80, 26);
  art += box(p, -46, -40, 0, 92, 80, 30, { width: 2 });
  art += box(p, -32, -28, 30, 64, 56, 12, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 42, 'TOK', 15, 'fill="var(--art-paper)" letter-spacing="1"');
  const f = facesOf(p, -46, -40, 0, 92, 80, 30);
  const widths = [10, 18, 8, 22, 12];
  let u = 8;
  widths.forEach((bw, i) => {
    art += quad(f.left, u, 8, bw, 14, `fill="${i === 3 ? 'var(--art-amber)' : i % 2 ? 'var(--art-cyan)' : 'var(--art-paper)'}" ${thin}`);
    u += bw + 3;
  });
  for (let i = 0; i < 3; i++) art += polygon([f.right(10 + i * 22, 6), f.right(26 + i * 22, 6), f.right(18 + i * 22, 22)], `fill="var(--art-steel)" ${thin}`);
  return art;
}

/** 提示缓存：一排抽屉柜，最上面一格拉开，露出存好的前缀。 */
function cache(): string {
  const p = projector(0, 10);
  let art = shadow(p, -40, -36, 80, 72, 22);
  for (let i = 0; i < 3; i++) {
    const z = i * 14;
    art += box(p, -40, -36, z, 80, 72, 14, i === 2 ? { top: 'var(--art-steel-soft)', width: 1.6 } : { width: 1.6 });
    const f = facesOf(p, -40, -36, z, 80, 72, 14);
    art += quad(f.left, 28, 4, 24, 5, `fill="${i === 1 ? 'var(--art-green)' : 'var(--art-steel)'}" ${thin}`);
  }
  // 拉开的抽屉：伸出正面，里面三块是缓存的前缀。
  art += box(p, -34, 30, 28, 68, 18, 10, { top: 'var(--art-paper)', width: 1.5 });
  for (let i = 0; i < 3; i++) art += box(p, -28 + i * 20, 33, 38, 16, 12, 5, { top: i === 2 ? 'var(--art-amber)' : 'var(--art-cyan)', width: 1.1 });
  return art;
}

/** 工具执行端：工作台上一把扳手和一个齿轮。 */
function tools(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -40, 88, 80, 24);
  art += box(p, -44, -40, 0, 88, 80, 16, { width: 1.9 });
  const top = facesOf(p, -44, -40, 0, 88, 80, 16).top;
  art += quad(top, 6, 6, 76, 68, `fill="var(--art-steel-soft)" ${thin}`);
  // 齿轮：顶面上一圈齿，中间一个孔。
  const teeth: Array<[number, number]> = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 ? 22 : 28;
    teeth.push(p(10 + r * Math.cos((i / 16) * Math.PI * 2), 8 + r * Math.sin((i / 16) * Math.PI * 2), 24));
  }
  art += polygon(teeth, `fill="var(--art-navy)" ${mid}`);
  art += disc(p, 10, 8, 24, 8, `fill="var(--art-paper)" ${thin}`);
  // 扳手：一根斜放的长条。
  art += box(p, -36, -34, 16, 30, 8, 4, { top: 'var(--art-amber)', width: 1.3 });
  const f = facesOf(p, -44, -40, 0, 88, 80, 16);
  art += quad(f.left, 8, 4, 26, 7, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 记忆系统：一叠卡片，最上面一张写着 MEM。 */
function memory(): string {
  const p = projector(0, 10);
  let art = shadow(p, -42, -36, 84, 72, 22);
  const tones = ['var(--art-steel)', 'var(--art-paper)', 'var(--art-cyan)'];
  for (let i = 0; i < 3; i++) art += box(p, -42 + i * 3, -36 - i * 3, i * 9, 84, 72, 9, { top: tones[i], width: 1.5 });
  const top = facesOf(p, -36, -42, 18, 84, 72, 9).top;
  art += quad(top, 12, 14, 60, 44, `fill="var(--art-navy)" ${thin}`);
  return art + topText(p, 6, -6, 27, 'MEM', 13, 'fill="var(--art-paper)" letter-spacing="1"');
}

/** 检索库：三个叠起来的圆柱（数据库），顶面一枚放大镜。 */
function store(): string {
  const p = projector(0, 14);
  let art = shadow(p, -36, -36, 72, 72, 20);
  for (let i = 0; i < 3; i++) {
    const z = i * 13;
    art += disc(p, 0, 0, z, 34, `fill="var(--art-steel)" ${mid}`);
    const [lx, ly] = p(-34 * 0.7071, 34 * 0.7071, z);
    const [rx, ry] = p(34 * 0.7071, -34 * 0.7071, z);
    const [lx2, ly2] = p(-34 * 0.7071, 34 * 0.7071, z + 11);
    const [rx2, ry2] = p(34 * 0.7071, -34 * 0.7071, z + 11);
    art += polygon([[lx, ly], [lx2, ly2], [rx2, ry2], [rx, ry]], `fill="var(--art-steel-dark)" stroke="none"`);
    art += disc(p, 0, 0, z + 11, 34, `fill="${i === 2 ? 'var(--art-paper)' : 'var(--art-steel-soft)'}" ${mid}`);
  }
  art += disc(p, -4, -4, 37, 12, `fill="var(--art-cyan)" stroke="var(--art-navy)" stroke-width="3"`);
  art += polyline([p(5, 5, 37), p(16, 16, 37)], 'stroke="var(--art-navy)" stroke-width="4" stroke-linecap="round"');
  return art;
}

/** 压缩器：一台压力机，上面的压板压着一摞纸。 */
function compactor(): string {
  const p = projector(0, 12);
  let art = shadow(p, -42, -36, 84, 72, 22);
  art += box(p, -42, -36, 0, 84, 72, 12, { width: 1.9 });
  // 被压的纸：三张薄片。
  for (let i = 0; i < 3; i++) art += box(p, -26, -20, 12 + i * 4, 52, 40, 4, { top: i === 2 ? 'var(--art-amber)' : 'var(--art-paper)', width: 1.1 });
  // 两根立柱和压板。
  for (const [x, y] of [[-40, -34], [30, 24]] as Array<[number, number]>) art += box(p, x, y, 12, 10, 10, 34, { ...NAVY, width: 1.3 });
  art += box(p, -36, -30, 34, 72, 62, 8, { ...NAVY, width: 1.7 });
  art += topText(p, 0, 0, 42, 'ZIP', 13, 'fill="var(--art-paper)" letter-spacing="1"');
  const f = facesOf(p, -42, -36, 0, 84, 72, 12);
  art += quad(f.left, 8, 3, 26, 6, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 子 Agent：一台小一号的工作站，顶面写着 SUB，正面一块小屏。它有自己的上下文，只把摘要交回。 */
function subagent(): string {
  const p = projector(0, 10);
  let art = shadow(p, -38, -34, 76, 68, 22);
  art += box(p, -38, -34, 0, 76, 68, 24, { width: 1.9 });
  art += box(p, -26, -22, 24, 52, 44, 8, { ...NAVY, width: 1.6 });
  art += topText(p, 0, 0, 32, 'SUB', 13, 'fill="var(--art-paper)" letter-spacing="1"');
  const f = facesOf(p, -38, -34, 0, 76, 68, 24);
  art += quad(f.left, 8, 6, 34, 12, `fill="var(--art-screen)" ${thin}`);
  art += quad(f.left, 48, 8, 16, 8, `fill="var(--art-green)" ${thin}`);
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
  sdk: { art: sdk(), radius: 64, labelY: 84 },
  net: { art: net(), radius: 60, labelY: 72 },
  gateway: { art: gateway(), radius: 66, labelY: 86 },
  rate: { art: rate(), radius: 64, labelY: 84 },
  model: { art: model(), radius: 70, labelY: 84 },
  tokenizer: { art: tokenizer(), radius: 66, labelY: 86 },
  cache: { art: cache(), radius: 64, labelY: 86 },
  tools: { art: tools(), radius: 64, labelY: 82 },
  memory: { art: memory(), radius: 64, labelY: 82 },
  store: { art: store(), radius: 62, labelY: 80 },
  compactor: { art: compactor(), radius: 64, labelY: 82 },
  subagent: { art: subagent(), radius: 60, labelY: 80 },
  request: DATA,
  response: DATA,
  events: DATA,
  messages: DATA,
  prompt: DATA,
  window: DATA,
  usage: DATA,
  docs: DATA,
  schema: DATA,
  out: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
