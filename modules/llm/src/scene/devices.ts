/**
 * 设备节点的等距图形。每个设备是一段 SVG 字符串，坐标原点在节点中心。
 * 数据节点（DATA）没有图形，外形由课程给它的数据结构图元决定。节点用途见 lessons/types.ts 的 NODE_IDS。
 */
import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };

/** 应用：带底座的显示器。屏幕上的行是 screen-line，render 事件时逐行画出。 */
function client(): string {
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
    [46, 12, 30, 'var(--term-prompt)'],
    [37, 12, 62, 'var(--term-text)'],
    [28, 12, 48, 'var(--term-text)'],
    [19, 12, 56, 'var(--term-text)'],
    [10, 12, 18, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, u, length, color] of rows) screen += polyline([f.left(u, v), f.left(u + length, v)], `class="screen-line" stroke="${color}" stroke-width="2.8" stroke-linecap="round" pathLength="1"`);
  return `${art}<g class="screen-content">${screen}</g>`;
}

/** 推理服务：两层机架，正面有指示灯，顶面写着 API。 */
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
  return art + topText(p, 0, 0, 44, 'API', 15, 'fill="var(--art-paper)" letter-spacing="1"');
}

/** 分词器：一台切片机，顶面写着 BPE，正面是一排切开的小块。 */
function tokenizer(): string {
  const p = projector(0, 12);
  let art = shadow(p, -46, -40, 92, 80, 26);
  art += box(p, -46, -40, 0, 92, 80, 30, { width: 2 });
  art += box(p, -32, -28, 30, 64, 56, 12, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 42, 'BPE', 15, 'fill="var(--art-paper)" letter-spacing="1"');
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

/** 调度器：一块看板，三条泳道上排着长短不一的请求。 */
function sched(): string {
  const p = projector(0, 6);
  let art = shadow(p, -46, -42, 92, 84, 24);
  art += box(p, -46, -42, 0, 92, 84, 16, { width: 1.9 });
  const top = facesOf(p, -46, -42, 0, 92, 84, 16).top;
  art += quad(top, 6, 6, 80, 72, `fill="var(--art-steel-soft)" ${thin}`);
  const lanes: Array<Array<[number, number, string]>> = [
    [[10, 30, 'var(--art-cyan)'], [44, 18, 'var(--art-green)']],
    [[10, 46, 'var(--art-amber)'], [60, 16, 'var(--art-cyan)']],
    [[10, 20, 'var(--art-green)'], [34, 26, 'var(--art-paper)']],
  ];
  lanes.forEach((items, row) => items.forEach(([u, len, tone]) => (art += quad(top, u, 12 + row * 22, len, 16, `fill="${tone}" ${thin}`))));
  const f = facesOf(p, -46, -42, 0, 92, 84, 16);
  art += quad(f.left, 8, 4, 30, 8, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** GPU：电路板上一颗大芯片，四周是 HBM 显存堆栈。 */
function gpu(): string {
  const p = projector(0, 8);
  let art = shadow(p, -54, -46, 108, 92, 26);
  art += box(p, -54, -46, 0, 108, 92, 8, { top: 'var(--art-green-soft)', width: 1.9 });
  art += box(p, -24, -22, 8, 48, 44, 12, { ...NAVY, width: 1.8 });
  art += topText(p, 0, 0, 20, 'GPU', 13, 'fill="var(--art-paper)" letter-spacing="1"');
  for (const [x, y] of [[-46, -18], [-46, 4], [32, -18], [32, 4]] as Array<[number, number]>) {
    art += box(p, x, y, 8, 14, 16, 16, { top: 'var(--art-amber)', width: 1.4 });
  }
  const board = facesOf(p, -54, -46, 0, 108, 92, 8);
  for (let i = 0; i < 8; i++) art += quad(board.left, 8 + i * 12, 2, 6, 4, `fill="var(--art-amber)" ${thin}`);
  return art;
}

/** 权重文件：一叠存储盘，最上面写着 GGUF。 */
function weights(): string {
  const p = projector(0, 10);
  let art = shadow(p, -42, -36, 84, 72, 22);
  const tones = ['var(--art-navy)', 'var(--art-steel)', 'var(--art-paper)'];
  for (let i = 0; i < 3; i++) {
    const z = i * 13;
    art += box(p, -42, -36, z, 84, 72, 13, { width: 1.6, ...(i === 0 ? NAVY : {}) });
    const f = facesOf(p, -42, -36, z, 84, 72, 13);
    art += quad(f.left, 6, 4, 22, 5, `fill="${i === 0 ? 'var(--art-cyan)' : tones[i]}" ${thin}`);
    art += quad(f.left, 62, 4, 6, 5, `fill="var(--art-green)" ${thin}`);
  }
  const top = facesOf(p, -42, -36, 26, 84, 72, 13).top;
  art += quad(top, 12, 14, 60, 44, `fill="var(--art-navy)" ${thin}`);
  return art + topText(p, 0, 0, 39, 'GGUF', 13, 'fill="var(--art-paper)" letter-spacing="1"');
}

/** 采样器：转盘上切成大小不一的扇区，旁边一枚指针。 */
function sampler(): string {
  const p = projector(0, 12);
  let art = shadow(p, -44, -44, 88, 88, 26);
  art += box(p, -44, -44, 0, 88, 88, 22, { width: 2 });
  const f = facesOf(p, -44, -44, 0, 88, 88, 22);
  // 顶面的转盘：按概率切开的扇区，最大的一块是最可能的 token。
  const slices: Array<[number, string]> = [[0.46, 'var(--art-cyan)'], [0.24, 'var(--art-amber)'], [0.16, 'var(--art-green)'], [0.14, 'var(--art-paper)']];
  let from = -Math.PI / 2;
  for (const [share, tone] of slices) {
    const to = from + share * Math.PI * 2;
    const points: Array<[number, number]> = [p(0, 0, 22)];
    for (let i = 0; i <= 10; i++) {
      const a = from + ((to - from) * i) / 10;
      points.push(p(34 * Math.cos(a), 34 * Math.sin(a), 22));
    }
    art += polygon(points, `fill="${tone}" ${thin}`);
    from = to;
  }
  art += polyline([p(0, 0, 22), p(0, 0, 40)], `stroke="var(--art-navy)" stroke-width="3" stroke-linecap="round"`);
  art += polygon([p(-4, 0, 40), p(4, 0, 40), p(0, -14, 40)], `fill="var(--art-navy)" ${thin}`);
  for (let i = 0; i < 4; i++) art += quad(f.left, 8 + i * 19, 7, 13, 8, `fill="${i === 0 ? 'var(--art-amber)' : 'var(--art-steel)'}" ${thin}`);
  return art;
}

/** 反分词：一台拼字机，顶面写着 UTF-8，出口一条纸带。 */
function detok(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -36, 88, 72, 24);
  art += box(p, -44, -36, 0, 88, 72, 26, { width: 2 });
  art += box(p, -30, -24, 26, 60, 48, 10, { ...NAVY, width: 1.7 });
  art += topText(p, 0, 0, 36, 'UTF-8', 12, 'fill="var(--art-paper)" letter-spacing="0.5"');
  const f = facesOf(p, -44, -36, 0, 88, 72, 26);
  art += quad(f.left, 10, 8, 68, 10, `fill="var(--art-paper)" ${thin}`);
  for (let i = 0; i < 5; i++) art += quad(f.left, 14 + i * 13, 10, 9, 6, `fill="${i < 3 ? 'var(--art-cyan)' : 'var(--art-steel-soft)'}" stroke="none"`);
  for (let i = 0; i < 3; i++) art += polyline([f.right(10, 6 + i * 6), f.right(58, 6 + i * 6)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** 优化器：一座斜坡，小球沿梯度往下滚。 */
function grad(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -40, 88, 80, 24);
  art += box(p, -44, -40, 0, 88, 80, 14, { width: 1.9 });
  const top = facesOf(p, -44, -40, 0, 88, 80, 14).top;
  art += quad(top, 6, 6, 76, 68, `fill="var(--art-steel-soft)" ${thin}`);
  const curve: Array<[number, number]> = [];
  for (let i = 0; i <= 12; i++) {
    const u = -34 + (68 * i) / 12;
    curve.push(p(u, 0, 14 + 30 * ((u + 6) / 34) ** 2 * 0.6));
  }
  art += polyline(curve, 'stroke="var(--art-navy)" stroke-width="3" stroke-linecap="round"');
  const [bx, by] = p(-22, 0, 14 + 30 * ((-22 + 6) / 34) ** 2 * 0.6 + 6);
  art += `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="6" fill="var(--art-amber)" ${thin}/>`;
  art += topText(p, 22, 22, 14, '∇', 18, 'fill="var(--art-navy)"');
  return art;
}

/** 视觉投影：一台带镜头的相机，正面的网格表示切好的 patch。 */
function vit(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -38, 88, 76, 24);
  art += box(p, -44, -38, 0, 88, 76, 32, { width: 2 });
  const f = facesOf(p, -44, -38, 0, 88, 76, 32);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) art += quad(f.left, 10 + c * 17, 6 + r * 11, 15, 9, `fill="${r === 0 && c === 0 ? 'var(--art-amber)' : r === 1 ? 'var(--art-green)' : 'var(--art-cyan)'}" ${thin}`);
  art += quad(f.left, 50, 8, 28, 16, `fill="var(--art-navy)" ${thin}`);
  // 顶面的镜头：一圈台阶。
  for (const [radius, z, tone] of [[24, 32, 'var(--art-steel)'], [17, 38, 'var(--art-navy)'], [9, 42, 'var(--art-cyan)']] as Array<[number, number, string]>) {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < 24; i++) ring.push(p(radius * Math.cos((i / 24) * Math.PI * 2), radius * Math.sin((i / 24) * Math.PI * 2), z));
    art += polygon(ring, `fill="${tone}" ${thin}`);
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
  client: { art: client(), radius: 72, labelY: 90 },
  server: { art: server(), radius: 66, labelY: 86 },
  tokenizer: { art: tokenizer(), radius: 66, labelY: 86 },
  sched: { art: sched(), radius: 64, labelY: 82 },
  gpu: { art: gpu(), radius: 70, labelY: 84 },
  weights: { art: weights(), radius: 64, labelY: 82 },
  sampler: { art: sampler(), radius: 66, labelY: 86 },
  detok: { art: detok(), radius: 64, labelY: 84 },
  grad: { art: grad(), radius: 64, labelY: 82 },
  vit: { art: vit(), radius: 64, labelY: 84 },
  text: DATA,
  image: DATA,
  tokens: DATA,
  vocab: DATA,
  embed: DATA,
  hidden: DATA,
  norm: DATA,
  attn: DATA,
  ffn: DATA,
  kv: DATA,
  lmhead: DATA,
  logits: DATA,
  queue: DATA,
  lora: DATA,
  out: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
