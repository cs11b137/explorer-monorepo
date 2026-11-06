/**
 * 设备节点的等距图形。每个设备是一段 SVG 字符串，坐标原点在节点中心。
 * 数据节点（DATA）没有图形，外形由课程给它的数据结构图元决定。节点用途见 lessons/types.ts 的 NODE_IDS。
 * 画法和 RAG、CONTEXT EXPLORER 同一套（引擎的等距图元），形状按本站的角色画。
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

/** 应用界面：带底座的显示器。屏幕上是一段对话：右边用户的话，左边 Agent 的回答。render 事件逐行画出。 */
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
  const rows: Array<[number, number, number, string]> = [
    [46, 46, 38, 'var(--term-prompt)'],
    [35, 12, 60, 'var(--term-text)'],
    [26, 12, 48, 'var(--term-text)'],
    [17, 12, 56, 'var(--term-text)'],
    [8, 12, 30, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, u, length, color] of rows) screen += polyline([f.left(u, v), f.left(u + length, v)], `class="screen-line" stroke="${color}" stroke-width="2.8" stroke-linecap="round" pathLength="1"`);
  return `${art}<g class="screen-content">${screen}</g>`;
}

/** 一台工作站：底座、顶面的名牌、正面一块小屏和一盏灯。Agent、子 Agent、接手的 Agent 都用它，名牌和灯的颜色不同。 */
function station(label: string, light: string, size = 1): string {
  const p = projector(0, 10);
  const w = 84 * size;
  const d = 72 * size;
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

/** 工具执行端：工作台上一把扳手和一个齿轮。 */
function tools(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -40, 88, 80, 24);
  art += box(p, -44, -40, 0, 88, 80, 16, { width: 1.9 });
  const top = facesOf(p, -44, -40, 0, 88, 80, 16).top;
  art += quad(top, 6, 6, 76, 68, `fill="var(--art-steel-soft)" ${thin}`);
  const teeth: Array<[number, number]> = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 ? 22 : 28;
    teeth.push(p(10 + r * Math.cos((i / 16) * Math.PI * 2), 8 + r * Math.sin((i / 16) * Math.PI * 2), 24));
  }
  art += polygon(teeth, `fill="var(--art-navy)" ${mid}`);
  art += disc(p, 10, 8, 24, 8, `fill="var(--art-paper)" ${thin}`);
  art += box(p, -36, -34, 16, 30, 8, 4, { top: 'var(--art-amber)', width: 1.3 });
  const f = facesOf(p, -44, -40, 0, 88, 80, 16);
  art += quad(f.left, 8, 4, 26, 7, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 业务数据库：三层圆柱，顶面几行记录（订单、退货单）。 */
function db(): string {
  const p = projector(0, 14);
  let art = shadow(p, -36, -36, 72, 72, 20);
  for (let i = 0; i < 3; i++) {
    const z = i * 13;
    art += disc(p, 0, 0, z, 34, `fill="var(--art-steel)" ${mid}`);
    art += drum(p, 34, z, 11, 'var(--art-steel-dark)');
    art += disc(p, 0, 0, z + 11, 34, `fill="${i === 2 ? 'var(--art-paper)' : 'var(--art-steel-soft)'}" ${mid}`);
  }
  for (let i = 0; i < 3; i++) art += polyline([p(-16, -14 + i * 12, 37), p(16, -14 + i * 12, 37)], `stroke="${i === 0 ? 'var(--art-amber)' : 'var(--art-navy)'}" stroke-width="3" stroke-linecap="round"`);
  return art;
}

/** 规则库：一个文件盒，里面竖着插了几份文档，最前面一份露出标签。 */
function policy(): string {
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

/** MCP 客户端：宿主里的一块连接器，顶面写着 MCP，侧面伸出插头的两根插脚。 */
function client(): string {
  const p = projector(0, 10);
  let art = shadow(p, -40, -34, 80, 68, 22);
  art += box(p, -40, -34, 0, 80, 68, 24, { width: 1.9 });
  art += box(p, -28, -22, 24, 56, 44, 8, { ...NAVY, width: 1.6 });
  art += topText(p, 0, 0, 32, 'MCP', 13, LABEL);
  for (const y of [-14, 6]) art += box(p, 40, y, 8, 14, 6, 6, { top: 'var(--art-amber)', width: 1.2 });
  const f = facesOf(p, -40, -34, 0, 80, 68, 24);
  ['var(--art-cyan)', 'var(--art-paper)', 'var(--art-green)'].forEach((tone, i) => (art += quad(f.left, 8 + i * 22, 8, 16, 9, `fill="${tone}" ${thin}`)));
  return art;
}

/** MCP 服务器：两层机架，正面有指示灯，顶面写着 SRV。 */
function server(): string {
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
  return art + topText(p, 0, 0, 44, 'SRV', 15, LABEL);
}

/** 授权服务器：底座上一把锁（锁身和锁梁），正面一枚钥匙孔。 */
function authz(): string {
  const p = projector(0, 10);
  let art = shadow(p, -40, -34, 80, 68, 22);
  art += box(p, -40, -34, 0, 80, 68, 14, { width: 1.9 });
  art += box(p, -20, -16, 14, 40, 32, 26, { ...NAVY, width: 1.7 });
  art += polyline([p(-10, 0, 40), p(-10, 0, 54), p(10, 0, 54), p(10, 0, 40)], 'stroke="var(--art-navy)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"');
  const lock = facesOf(p, -20, -16, 14, 40, 32, 26);
  art += quad(lock.left, 15, 8, 10, 10, `fill="var(--art-amber)" ${thin}`);
  const f = facesOf(p, -40, -34, 0, 80, 68, 14);
  art += quad(f.left, 8, 4, 28, 6, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 权限检查：一道闸门，两根立柱架着一根红黄相间的横杆。 */
function guard(): string {
  const p = projector(0, 12);
  let art = shadow(p, -42, -36, 84, 72, 20);
  art += box(p, -42, -36, 0, 84, 72, 10, { width: 1.9 });
  for (const x of [-34, 24]) art += box(p, x, -6, 10, 10, 12, 34, { ...NAVY, width: 1.4 });
  for (let i = 0; i < 6; i++) art += box(p, -30 + i * 10, -3, 34, 10, 6, 6, { top: i % 2 ? 'var(--art-paper)' : 'var(--art-amber)', left: i % 2 ? 'var(--art-paper)' : 'var(--art-amber)', width: 1.1 });
  const f = facesOf(p, -42, -36, 0, 84, 72, 10);
  art += quad(f.left, 8, 2, 30, 6, `fill="var(--art-green)" ${thin}`);
  return art;
}

/** 外部内容：一页网页，顶面写着 WWW，纸上几行字。工具从这里读回的内容不可信。 */
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
  agent: { art: station('AGT', 'var(--art-green)'), radius: 66, labelY: 82 },
  llm: { art: llm(), radius: 70, labelY: 84 },
  tools: { art: tools(), radius: 64, labelY: 82 },
  db: { art: db(), radius: 62, labelY: 80 },
  policy: { art: policy(), radius: 62, labelY: 80 },
  client: { art: client(), radius: 62, labelY: 80 },
  server: { art: server(), radius: 64, labelY: 84 },
  authz: { art: authz(), radius: 62, labelY: 80 },
  subagent: { art: station('SUB', 'var(--art-cyan)', 0.86), radius: 60, labelY: 78 },
  subagent2: { art: station('SUB', 'var(--art-cyan)', 0.86), radius: 60, labelY: 78 },
  peer: { art: station('AGT', 'var(--art-amber)'), radius: 66, labelY: 82 },
  guard: { art: guard(), radius: 62, labelY: 80 },
  web: { art: web(), radius: 60, labelY: 78 },
  request: DATA,
  response: DATA,
  messages: DATA,
  toolset: DATA,
  prompt: DATA,
  calls: DATA,
  results: DATA,
  usage: DATA,
  turns: DATA,
  rpc: DATA,
  wire: DATA,
  caps: DATA,
  catalog: DATA,
  tasks: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
