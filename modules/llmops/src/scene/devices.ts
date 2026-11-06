/**
 * 设备节点的等距图形。每个设备是一段 SVG 字符串，坐标原点在节点中心。
 * 数据节点（DATA）没有图形，外形由课程给它的数据结构图元决定。节点用途见 lessons/types.ts 的 NODE_IDS。
 * 画法和同系列的其他站同一套（引擎的等距图元），形状按本站的角色画。
 */
import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText, type Project } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };
const LABEL = 'fill="var(--art-paper)" letter-spacing="1"';

/** 水平面上的一圈：近似圆的多边形。 */
function ring(p: Project, cx: number, cy: number, z: number, r: number, attrs: string): string {
  return polygon(Array.from({ length: 28 }, (_, i) => p(cx + r * Math.cos((i / 28) * Math.PI * 2), cy + r * Math.sin((i / 28) * Math.PI * 2), z)), attrs);
}

/** 竖直的圆柱：底圈、侧面、顶圈。 */
function cylinder(p: Project, cx: number, cy: number, z: number, r: number, h: number, top: string, side: string): string {
  const k = 0.7071;
  const [lx, ly] = p(cx - r * k, cy + r * k, z);
  const [rx, ry] = p(cx + r * k, cy - r * k, z);
  const [lx2, ly2] = p(cx - r * k, cy + r * k, z + h);
  const [rx2, ry2] = p(cx + r * k, cy - r * k, z + h);
  return ring(p, cx, cy, z, r, `fill="${side}" ${mid}`) + polygon([[lx, ly], [lx2, ly2], [rx2, ry2], [rx, ry]], `fill="${side}" stroke="none"`) + ring(p, cx, cy, z + h, r, `fill="${top}" ${mid}`);
}

/** 应用界面：带底座的显示器，屏幕上是一段对话。render 事件逐行画出。 */
function app(): string {
  const p = projector(0, 18);
  const w = 100;
  const h = 72;
  const f = facesOf(p, -w / 2, -10, 8, w, 8, h);
  let art = shadow(p, -40, -32, 80, 64, 26);
  art += box(p, -40, -32, 0, 80, 64, 6, { width: 1.9 });
  art += box(p, -7, -12, 6, 14, 12, 4, { width: 1.3 });
  art += box(p, -w / 2, -10, 8, w, 8, h, { width: 2.1 });
  art += quad(f.left, 5, 5, w - 10, h - 10, `fill="var(--art-screen)" ${mid}`);
  art += quad(f.left, 5, h - 14, w - 10, 9, `fill="var(--art-navy)" ${thin}`);
  const rows: Array<[number, number, number, string]> = [
    [46, 44, 40, 'var(--term-prompt)'],
    [35, 12, 58, 'var(--term-text)'],
    [26, 12, 44, 'var(--term-text)'],
    [17, 50, 34, 'var(--term-prompt)'],
    [8, 12, 36, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, u, length, color] of rows) screen += polyline([f.left(u, v), f.left(u + length, v)], `class="screen-line" stroke="${color}" stroke-width="2.8" stroke-linecap="round" pathLength="1"`);
  return `${art}<g class="screen-content">${screen}</g>`;
}

/** 一台工作站：底座、顶面的名牌、正面一块小屏和一盏灯。客服后端、评估运行器用它，名牌和灯不同。 */
function station(label: string, light: string): string {
  const p = projector(0, 10);
  const w = 84;
  const d = 72;
  let art = shadow(p, -w / 2, -d / 2, w, d, 24);
  art += box(p, -w / 2, -d / 2, 0, w, d, 26, { width: 1.9 });
  art += box(p, -w / 2 + 12, -d / 2 + 12, 26, w - 24, d - 24, 9, { ...NAVY, width: 1.7 });
  art += topText(p, 0, 0, 35, label, 13, LABEL);
  const f = facesOf(p, -w / 2, -d / 2, 0, w, d, 26);
  art += quad(f.left, 8, 7, w * 0.45, 12, `fill="var(--art-screen)" ${thin}`);
  art += quad(f.left, w * 0.6, 9, 14, 8, `fill="${light}" ${thin}`);
  for (let i = 0; i < 3; i++) art += polyline([f.right(10, 7 + i * 6), f.right(d - 12, 7 + i * 6)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** 防护层：底座上立着一道厚墙，墙面有黄白相间的警示条，墙前一个小检查口。 */
function guard(): string {
  const p = projector(0, 14);
  let art = shadow(p, -44, -36, 88, 72, 22);
  art += box(p, -44, -36, 0, 88, 72, 10, { width: 1.9 });
  art += box(p, -36, -6, 10, 72, 14, 40, { ...NAVY, width: 1.7 });
  const wall = facesOf(p, -36, -6, 10, 72, 14, 40);
  for (let i = 0; i < 6; i++) art += quad(wall.left, 2 + i * 12, 26, 10, 9, `fill="${i % 2 ? 'var(--art-paper)' : 'var(--art-amber)'}" ${thin}`);
  art += quad(wall.left, 26, 6, 20, 12, `fill="var(--art-screen)" ${thin}`);
  const base = facesOf(p, -44, -36, 0, 88, 72, 10);
  art += quad(base.left, 8, 2, 26, 6, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 大模型：一块大芯片，四周是显存堆栈，顶面写着 label。评委模型的底板是琥珀色。 */
function chip(label: string, board: string): string {
  const p = projector(0, 8);
  let art = shadow(p, -54, -46, 108, 92, 26);
  art += box(p, -54, -46, 0, 108, 92, 8, { top: board, width: 1.9 });
  art += box(p, -26, -24, 8, 52, 48, 14, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 22, label, 13, LABEL);
  for (const [x, y] of [[-46, -18], [-46, 4], [32, -18], [32, 4]] as Array<[number, number]>) art += box(p, x, y, 8, 14, 16, 16, { top: 'var(--art-amber)', width: 1.4 });
  const f = facesOf(p, -54, -46, 0, 108, 92, 8);
  for (let i = 0; i < 8; i++) art += quad(f.left, 8 + i * 12, 2, 6, 4, `fill="var(--art-amber)" ${thin}`);
  return art;
}

/** 工具执行端：一只工具箱，盖子上一把扳手。 */
function tools(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -34, 88, 68, 22);
  art += box(p, -44, -34, 0, 88, 68, 26, { width: 1.9 });
  art += box(p, -44, -34, 26, 88, 68, 6, { top: 'var(--art-steel-soft)', width: 1.6 });
  art += box(p, -14, -6, 32, 28, 12, 6, { ...NAVY, width: 1.4 });
  const top = facesOf(p, -44, -34, 26, 88, 68, 6).top;
  art += quad(top, 12, 44, 60, 7, `fill="var(--art-amber)" ${thin}`);
  const f = facesOf(p, -44, -34, 0, 88, 68, 26);
  art += quad(f.left, 34, 9, 20, 8, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** 订单库：三层圆柱，顶面几行记录。 */
function db(): string {
  const p = projector(0, 14);
  let art = shadow(p, -36, -36, 72, 72, 20);
  for (let i = 0; i < 3; i++) art += cylinder(p, 0, 0, i * 13, 34, 11, i === 2 ? 'var(--art-paper)' : 'var(--art-steel-soft)', 'var(--art-steel-dark)');
  for (let i = 0; i < 3; i++) art += polyline([p(-16, -14 + i * 12, 37), p(16, -14 + i * 12, 37)], `stroke="${i === 0 ? 'var(--art-amber)' : 'var(--art-navy)'}" stroke-width="3" stroke-linecap="round"`);
  return art;
}

/** 外部内容：一页网页，顶面写着 WWW，纸上几行字，其中一行是琥珀色（藏着的指令）。 */
function web(): string {
  const p = projector(0, 10);
  let art = shadow(p, -40, -34, 80, 68, 20);
  art += box(p, -40, -34, 0, 80, 68, 10, { width: 1.8 });
  art += box(p, -32, -26, 10, 64, 52, 3, { top: 'var(--art-paper)', width: 1.3 });
  const top = facesOf(p, -32, -26, 10, 64, 52, 3).top;
  art += quad(top, 6, 6, 52, 10, `fill="var(--art-navy)" ${thin}`);
  for (let i = 0; i < 3; i++) art += quad(top, 6, 22 + i * 9, i === 2 ? 26 : 50, 4, `fill="${i === 1 ? 'var(--art-amber)' : 'var(--art-steel-soft)'}" ${thin}`);
  return art + topText(p, -4, -10, 13.5, 'WWW', 10, LABEL);
}

/** 限流器：一只敞口的桶，里面摞着几枚令牌，桶身一个刻度窗。 */
function limiter(): string {
  const p = projector(0, 12);
  let art = shadow(p, -38, -38, 76, 76, 20);
  art += box(p, -40, -40, 0, 80, 80, 8, { width: 1.8 });
  art += cylinder(p, 0, 0, 8, 30, 36, 'var(--art-screen)', 'var(--art-steel)');
  for (let i = 0; i < 3; i++) art += cylinder(p, 0, 0, 12 + i * 8, 20, 5, 'var(--art-amber)', 'var(--art-amber)');
  art += ring(p, 0, 0, 44, 30, `fill="none" ${mid}`);
  return art;
}

/** 人工标注员：底座上三个人（圆柱身体 + 圆头），各自面前一块小板。 */
function raters(): string {
  const p = projector(0, 14);
  let art = shadow(p, -46, -36, 92, 72, 20);
  art += box(p, -46, -36, 0, 92, 72, 8, { width: 1.8 });
  const tones = ['var(--art-navy)', 'var(--art-teal)', 'var(--art-green)'];
  [[-24, 10], [0, -14], [24, 10]].forEach(([x, y], i) => {
    art += cylinder(p, x, y, 8, 9, 22, tones[i], tones[i]);
    art += cylinder(p, x, y, 32, 7, 9, 'var(--art-paper)', 'var(--art-steel-soft)');
  });
  return art;
}

/** OpenTelemetry Collector：一个漏斗形的接收器坐在机箱上，顶面写着 OTEL。 */
function collector(): string {
  const p = projector(0, 12);
  let art = shadow(p, -40, -38, 80, 76, 22);
  art += box(p, -40, -38, 0, 80, 76, 22, { width: 1.9 });
  const f = facesOf(p, -40, -38, 0, 80, 76, 22);
  for (let j = 0; j < 4; j++) art += quad(f.left, 8 + j * 10, 8, 6, 6, `fill="${j === 0 ? 'var(--art-green)' : 'var(--art-steel)'}" ${thin}`);
  art += cylinder(p, 0, 0, 22, 20, 8, 'var(--art-navy)', 'var(--art-navy-2)');
  art += ring(p, 0, 0, 38, 30, `fill="var(--art-steel-soft)" ${mid}`);
  art += polyline([p(-21, 21, 38), p(-14, 14, 30)], mid) + polyline([p(21, -21, 38), p(14, -14, 30)], mid);
  return art + topText(p, 0, 0, 30, 'OTEL', 9.5, LABEL);
}

/** 可观测性后端：一块立着的看板，上面是柱状图和一条折线。 */
function observe(): string {
  const p = projector(0, 18);
  let art = shadow(p, -44, -34, 88, 68, 24);
  art += box(p, -44, -34, 0, 88, 68, 8, { width: 1.9 });
  art += box(p, -46, -8, 8, 92, 10, 60, { width: 2 });
  const f = facesOf(p, -46, -8, 8, 92, 10, 60);
  art += quad(f.left, 5, 5, 82, 50, `fill="var(--art-screen)" ${mid}`);
  [14, 26, 20, 34, 18].forEach((h, i) => (art += quad(f.left, 12 + i * 14, 9, 9, h, `fill="${i === 3 ? 'var(--art-amber)' : 'var(--art-navy)'}" ${thin}`)));
  art += polyline([f.left(10, 40), f.left(30, 46), f.left(50, 38), f.left(78, 48)], 'stroke="var(--art-green)" stroke-width="2.4" stroke-linecap="round"');
  return art;
}

/** 告警：底座上一盏警示灯（琥珀色灯罩）。 */
function alert(): string {
  const p = projector(0, 14);
  let art = shadow(p, -32, -32, 64, 64, 18);
  art += box(p, -32, -32, 0, 64, 64, 10, { width: 1.8 });
  art += cylinder(p, 0, 0, 10, 18, 8, 'var(--art-navy)', 'var(--art-navy-2)');
  art += cylinder(p, 0, 0, 18, 13, 22, 'var(--art-amber)', 'var(--art-amber)');
  art += ring(p, 0, 0, 40, 13, `fill="var(--art-amber-soft)" ${mid}`);
  const f = facesOf(p, -32, -32, 0, 64, 64, 10);
  art += quad(f.left, 6, 2, 22, 6, `fill="var(--art-green)" ${thin}`);
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
  backend: { art: station('APP', 'var(--art-green)'), radius: 66, labelY: 82 },
  guard: { art: guard(), radius: 64, labelY: 82 },
  llm: { art: chip('LLM', 'var(--art-green-soft)'), radius: 70, labelY: 84 },
  tools: { art: tools(), radius: 62, labelY: 80 },
  db: { art: db(), radius: 62, labelY: 80 },
  web: { art: web(), radius: 60, labelY: 78 },
  limiter: { art: limiter(), radius: 62, labelY: 80 },
  harness: { art: station('EVAL', 'var(--art-amber)'), radius: 66, labelY: 82 },
  judge: { art: chip('JDG', 'var(--art-amber-soft)'), radius: 70, labelY: 84 },
  raters: { art: raters(), radius: 62, labelY: 80 },
  collector: { art: collector(), radius: 62, labelY: 82 },
  observe: { art: observe(), radius: 70, labelY: 84 },
  alert: { art: alert(), radius: 56, labelY: 76 },
  message: DATA,
  rules: DATA,
  features: DATA,
  scores: DATA,
  matrix: DATA,
  dataset: DATA,
  results: DATA,
  request: DATA,
  response: DATA,
  buckets: DATA,
  spans: DATA,
  ledger: DATA,
  latency: DATA,
  metrics: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
