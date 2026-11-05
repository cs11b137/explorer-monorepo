import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.3" stroke-linejoin="round"`;

/** 程序：带引脚的底座上立着一块源码屏。屏上的行是 screen-line，render 事件时逐行画出。 */
function program(): string {
  const p = projector(0, 22);
  const w = 104;
  const d = 8;
  const h = 78;
  const x = -w / 2;
  const y = -10;
  const f = facesOf(p, x, y, 10, w, d, h);
  let art = shadow(p, -50, -40, 100, 80, 30);
  for (let i = 0; i < 7; i++) {
    const at = -42 + i * 14;
    art += polyline([p(at, 40, 0), p(at, 47, -2)], 'stroke="var(--art-steel-dark)" stroke-width="2"');
    art += polyline([p(50, -36 + i * 12, 0), p(57, -36 + i * 12, -2)], 'stroke="var(--art-steel-dark)" stroke-width="2"');
  }
  art += box(p, -50, -40, 0, 100, 80, 10, { width: 2.1 });
  const baseTop = facesOf(p, -50, -40, 0, 100, 80, 10).top;
  art += quad(baseTop, 12, 60, 76, 12, `fill="var(--art-navy)" ${thin}`);
  art += box(p, x, y, 10, w, d, h, { width: 2.2 });
  art += quad(f.left, 5, 5, w - 10, h - 10, `fill="var(--art-screen)" stroke="${STROKE}" stroke-width="1.6"`);
  art += quad(f.left, 5, h - 15, w - 10, 10, `fill="var(--art-navy)" ${thin}`);
  const rows: Array<[number, number, number, string]> = [
    [52, 12, 34, 'var(--term-prompt)'],
    [42, 20, 56, 'var(--term-text)'],
    [32, 20, 42, 'var(--term-text)'],
    [22, 28, 48, 'var(--term-text)'],
    [12, 12, 14, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, u, length, color] of rows) screen += polyline([f.left(u, v), f.left(u + length, v)], `class="screen-line" stroke="${color}" stroke-width="3" stroke-linecap="round" pathLength="1"`);
  art += `<g class="screen-content">${screen}</g>`;
  return art;
}

/** 分配器：一格一格的抽屉柜，顶面是大小不一的内存块。 */
function allocator(): string {
  const p = projector(0, 14);
  let art = shadow(p, -46, -38, 92, 76, 26);
  art += box(p, -46, -38, 0, 92, 76, 48, { width: 2.1 });
  const f = facesOf(p, -46, -38, 0, 92, 76, 48);
  for (let row = 0; row < 3; row++) {
    art += quad(f.left, 7, 5 + row * 14, 78, 11, `fill="${row === 1 ? 'var(--art-amber)' : 'var(--art-paper)'}" ${thin}`);
    art += quad(f.left, 38, 9 + row * 14, 16, 3, `fill="var(--art-navy)" stroke="none"`);
    art += quad(f.right, 7, 5 + row * 14, 62, 11, `fill="var(--art-steel)" ${thin}`);
  }
  const blocks: Array<[number, number, number, number, string]> = [
    [7, 7, 22, 26, 'var(--art-cyan)'],
    [33, 7, 52, 26, 'var(--art-paper)'],
    [7, 37, 52, 30, 'var(--art-paper)'],
    [63, 37, 22, 30, 'var(--art-navy)'],
  ];
  for (const [u, v, bw, bh, color] of blocks) art += quad(f.top, u, v, bw, bh, `fill="${color}" ${thin}`);
  return art;
}

/** 哈希函数：把任意长的键压成固定宽度的搅拌器。 */
function hasher(): string {
  const p = projector(0, 14);
  let art = shadow(p, -44, -44, 88, 88, 26);
  art += box(p, -44, -44, 0, 88, 88, 30, { width: 2.1 });
  art += box(p, -30, -30, 30, 60, 60, 14, { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)', width: 1.9 });
  art += topText(p, 0, 0, 44, 'FNV', 15, 'fill="var(--art-paper)" letter-spacing="1"');
  const f = facesOf(p, -44, -44, 0, 88, 88, 30);
  for (let i = 0; i < 5; i++) art += quad(f.left, 10 + i * 14, 7, 9, 16, `fill="${i === 2 ? 'var(--art-amber)' : 'var(--art-paper)'}" ${thin}`);
  for (let i = 0; i < 3; i++) art += polygon([f.right(10 + i * 24, 7), f.right(26 + i * 24, 7), f.right(18 + i * 24, 23)], `fill="var(--art-steel)" ${thin}`);
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
  prog: { art: program(), radius: 76, labelY: 96 },
  alloc: { art: allocator(), radius: 64, labelY: 84 },
  hasher: { art: hasher(), radius: 64, labelY: 84 },
  stack: { ...DATA, radius: 62 },
  array: DATA,
  aux: DATA,
  queue: DATA,
  table: DATA,
  tree: DATA,
  graph: DATA,
  list: DATA,
  text: DATA,
  pattern: DATA,
};

/** 有设备图形的节点。其余节点的外形由数据结构决定。 */
export const hasArt = (id: NodeId): boolean => NODE_SPECS[id].art !== '';
