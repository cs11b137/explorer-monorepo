import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.1" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };

/** 一张带标题条的薄片：源码、IR、目标文件这类“文本产物”都从它派生。 */
function sheet(tag: string, rows: Array<[number, string]>, accent = 'var(--art-navy)'): string {
  const p = projector(0, 2);
  let art = shadow(p, -40, -34, 80, 68, 14);
  art += box(p, -40, -34, 0, 80, 68, 6, { width: 1.8 });
  const top = facesOf(p, -40, -34, 0, 80, 68, 6).top;
  art += quad(top, 5, 4, 70, 13, `fill="${accent}" ${thin}`);
  rows.forEach(([length, color], index) => {
    art += quad(top, 9, 22 + index * 8.5, length, 4.6, `fill="${color}" stroke="none"`);
  });
  art += topText(p, 0, -23.5, 6, tag, 9.5, 'fill="var(--art-paper)"');
  return art;
}

/** 一块方形机器，顶面留给各自的图案。 */
function machine(height: number, paint: (top: (u: number, v: number) => [number, number]) => string, side = true): string {
  const p = projector(0, height / 2 - 6);
  let art = shadow(p, -36, -36, 72, 72, 20);
  art += box(p, -36, -36, 0, 72, 72, height, { width: 1.9 });
  const f = facesOf(p, -36, -36, 0, 72, 72, height);
  art += quad(f.top, 6, 6, 60, 60, `fill="var(--art-steel-soft)" ${thin}`);
  art += paint(f.top);
  if (side) {
    art += quad(f.left, 8, height * 0.28, 24, height * 0.42, `fill="var(--art-paper)" ${thin}`);
    for (const u of [40, 49, 58]) art += quad(f.left, u, height * 0.3, 5, height * 0.38, `fill="var(--art-steel)" ${thin}`);
    for (let i = 0; i < 2; i++) art += polyline([f.right(8, height * (0.32 + i * 0.3)), f.right(64, height * (0.32 + i * 0.3))], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  }
  return art;
}

/** 词法器：顶面是字符格，一条光带扫过。 */
const lexer = () => machine(26, (top) => {
  let art = '';
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      const lit = col === 2;
      art += quad(top, 10 + col * 10.6, 13 + row * 16, 9.2, 13.5, `fill="${lit ? 'var(--art-amber)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
    }
  }
  return art;
});

/** token 托盘：底座上一排小块。 */
function tokenTray(): string {
  const p = projector(0, 6);
  let art = shadow(p, -44, -24, 88, 48, 14);
  art += box(p, -44, -24, 0, 88, 48, 5, { width: 1.8 });
  const colors = ['var(--art-cyan)', 'var(--art-paper)', 'var(--art-amber)', 'var(--art-paper)', 'var(--art-steel)'];
  colors.forEach((color, index) => {
    art += box(p, -38 + index * 15.5, -11, 5, 12, 22, 9 + (index % 2) * 4, { top: color, left: 'var(--art-steel-soft)', right: 'var(--art-steel)', width: 1.1 });
  });
  return art;
}

function treeGlyph(top: (u: number, v: number) => [number, number], ox = 0, oy = 0): string {
  const nodes: Array<[number, number]> = [[36, 15], [20, 36], [52, 36], [12, 56], [30, 56]];
  const links: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [1, 4]];
  let art = '';
  for (const [a, b] of links) art += polyline([top(nodes[a][0] + ox, nodes[a][1] + oy), top(nodes[b][0] + ox, nodes[b][1] + oy)], `stroke="${STROKE}" stroke-width="1.6"`);
  nodes.forEach(([u, v], index) => {
    const ring = Array.from({ length: 16 }, (_, i) => top(u + ox + 5 * Math.cos((i / 16) * Math.PI * 2), v + oy + 5 * Math.sin((i / 16) * Math.PI * 2)));
    art += polygon(ring, `fill="${index === 0 ? 'var(--art-amber)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="1"`);
  });
  return art;
}

const parser = () => machine(26, (top) => treeGlyph(top));

function treeSlab(): string {
  const p = projector(0, 0);
  let art = shadow(p, -38, -38, 76, 76, 14);
  art += box(p, -38, -38, 0, 76, 76, 6, { width: 1.8 });
  art += treeGlyph(facesOf(p, -38, -38, 0, 76, 76, 6).top, 2, 2);
  return art;
}

/** 分析表：一张方格板，亮的一格就是当前查到的动作。 */
function lrTable(): string {
  const p = projector(0, 0);
  let art = shadow(p, -40, -36, 80, 72, 14);
  art += box(p, -40, -36, 0, 80, 72, 6, { width: 1.8 });
  const top = facesOf(p, -40, -36, 0, 80, 72, 6).top;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      const head = row === 0 || col === 0;
      const lit = row === 2 && col === 3;
      art += quad(top, 5 + col * 11.6, 5 + row * 12.6, 10.6, 11.6, `fill="${lit ? 'var(--art-amber)' : head ? 'var(--art-navy)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.7"`);
    }
  }
  return art;
}

/** 符号表：两层抽屉。 */
function cabinet(): string {
  const p = projector(0, 22);
  let art = shadow(p, -34, -30, 68, 60, 18);
  art += box(p, -34, -30, 0, 68, 60, 24, { width: 1.9 });
  art += box(p, -34, -30, 24, 68, 60, 24, { width: 1.9 });
  for (const z of [0, 24]) {
    const f = facesOf(p, -34, -30, z, 68, 60, 24);
    art += quad(f.left, 10, 7, 48, 11, `fill="var(--art-paper)" ${thin}`);
    art += quad(f.left, 28, 11, 12, 3, 'fill="var(--art-navy)" stroke="none"');
  }
  const top = facesOf(p, -34, -30, 24, 68, 60, 24).top;
  art += quad(top, 8, 10, 52, 8, `fill="var(--art-cyan)" ${thin}`);
  art += quad(top, 8, 24, 52, 8, `fill="var(--art-paper)" ${thin}`);
  art += quad(top, 8, 38, 36, 8, `fill="var(--art-paper)" ${thin}`);
  return art;
}

const irgen = () => machine(26, (top) => {
  let art = '';
  for (let i = 0; i < 3; i++) art += quad(top, 12, 16 + i * 15, 18, 8, `fill="var(--art-paper)" ${thin}`);
  art += polyline([top(33, 36), top(46, 36)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round"`);
  art += polyline([top(41, 29), top(47, 36), top(41, 43)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`);
  art += quad(top, 50, 18, 10, 36, 'fill="var(--art-amber)" stroke="none"');
  return art;
});

/** CFG：四个小方块，带一条回边。 */
function cfgBoard(): string {
  const p = projector(0, 0);
  let art = shadow(p, -38, -38, 76, 76, 14);
  art += box(p, -38, -38, 0, 76, 76, 6, { width: 1.8 });
  const top = facesOf(p, -38, -38, 0, 76, 76, 6).top;
  const blocks: Array<[number, number, string]> = [[28, 5, 'var(--art-paper)'], [28, 25, 'var(--art-amber)'], [8, 49, 'var(--art-paper)'], [48, 49, 'var(--art-paper)']];
  const links: Array<[number, number]> = [[0, 1], [1, 2], [1, 3]];
  for (const [a, b] of links) art += polyline([top(blocks[a][0] + 10, blocks[a][1] + 6), top(blocks[b][0] + 10, blocks[b][1] + 6)], `stroke="${STROKE}" stroke-width="1.5"`);
  art += polyline([top(8, 52), top(3, 38), top(28, 30)], `stroke="${STROKE}" stroke-width="1.5" stroke-dasharray="3 2"`);
  for (const [u, v, color] of blocks) art += quad(top, u, v, 20, 13, `fill="${color}" stroke="${STROKE}" stroke-width="1"`);
  return art;
}

function ssaSlab(): string {
  const p = projector(0, 0);
  let art = shadow(p, -38, -38, 76, 76, 14);
  art += box(p, -38, -38, 0, 76, 76, 6, { width: 1.8 });
  const top = facesOf(p, -38, -38, 0, 76, 76, 6).top;
  art += quad(top, 14, 14, 48, 48, `fill="var(--art-navy)" ${thin}`);
  art += topText(p, 0, 0, 6, 'φ', 30, 'fill="var(--art-paper)"');
  return art;
}

/** 优化器：漏斗。 */
function optimizer(): string {
  const p = projector(0, 8);
  let art = shadow(p, -34, -34, 68, 68, 18);
  art += box(p, -34, -34, 0, 68, 68, 12, { width: 1.9 });
  art += box(p, -20, -20, 12, 40, 40, 10, { ...NAVY, width: 1.7 });
  art += box(p, -34, -34, 22, 68, 68, 8, { width: 1.9 });
  const top = facesOf(p, -34, -34, 22, 68, 68, 8).top;
  art += quad(top, 12, 12, 44, 44, `fill="var(--art-steel-soft)" ${thin}`);
  for (const [u, v, color] of [[16, 16, 'var(--art-amber)'], [32, 18, 'var(--art-paper)'], [20, 34, 'var(--art-paper)'], [38, 36, 'var(--art-cyan)']] as const) art += quad(top, u, v, 10, 10, `fill="${color}" stroke="${STROKE}" stroke-width="0.9"`);
  return art;
}

/** 指令选择：左边是 IR 形状，右边是匹配上的指令模板。 */
const isel = () => machine(26, (top) => {
  let art = quad(top, 11, 12, 22, 14, `fill="var(--art-paper)" ${thin}`);
  art += quad(top, 11, 30, 22, 14, `fill="var(--art-paper)" ${thin}`);
  art += quad(top, 11, 48, 22, 10, `fill="var(--art-paper)" ${thin}`);
  art += quad(top, 39, 12, 22, 32, `fill="var(--art-amber)" ${thin}`);
  art += quad(top, 39, 48, 22, 10, `fill="var(--art-cyan)" ${thin}`);
  return art;
});

/** 寄存器组：一排立柱，亮的是已占用的。 */
function regBank(): string {
  const p = projector(0, 12);
  let art = shadow(p, -44, -18, 88, 36, 16);
  art += box(p, -44, -18, 0, 88, 36, 6, { width: 1.8 });
  const used = [1, 1, 0, 1, 0, 0];
  used.forEach((on, index) => {
    art += box(p, -40 + index * 13.8, -10, 6, 11, 20, on ? 24 : 12, { top: on ? 'var(--art-amber)' : 'var(--art-paper)', left: on ? 'var(--art-amber-soft)' : 'var(--art-steel-soft)', right: 'var(--art-steel)', width: 1.1 });
  });
  return art;
}

/** 栈：一摞向下长的盘子。 */
function stackPlates(): string {
  const p = projector(0, 18);
  let art = shadow(p, -34, -34, 68, 68, 16);
  const colors = ['var(--art-steel-soft)', 'var(--art-cyan)', 'var(--art-paper)', 'var(--art-amber)'];
  colors.forEach((color, index) => {
    art += box(p, -34, -34, index * 11, 68, 68, 9, { top: color, width: 1.6 });
  });
  return art;
}

/** 编码器：芯片。 */
function encoderChip(): string {
  const p = projector(0, 2);
  const half = 42;
  let art = shadow(p, -half, -half, 84, 84, 18);
  for (let i = 0; i < 6; i++) {
    const at = -half + 10 + i * 13;
    art += polyline([p(at, half, 0), p(at, half + 7, -2)], 'stroke="var(--art-steel-dark)" stroke-width="1.8"');
    art += polyline([p(half, at, 0), p(half + 7, at, -2)], 'stroke="var(--art-steel-dark)" stroke-width="1.8"');
  }
  art += box(p, -half, -half, 0, 84, 84, 7, { width: 2 });
  art += box(p, -25, -25, 7, 50, 50, 9, { ...NAVY, width: 1.7 });
  art += topText(p, 0, 0, 16, '0F AF', 11, 'fill="var(--art-paper)" letter-spacing="0.5"');
  return art;
}

/** 链接器：两个扣在一起的环。 */
function linker(): string {
  const p = projector(0, 6);
  let art = shadow(p, -38, -38, 76, 76, 18);
  art += box(p, -38, -38, 0, 76, 76, 12, { width: 1.9 });
  const top = facesOf(p, -38, -38, 0, 76, 76, 12).top;
  art += quad(top, 7, 7, 62, 62, `fill="var(--art-steel-soft)" ${thin}`);
  const ring = (cu: number, cv: number, radius: number) => Array.from({ length: 28 }, (_, i) => top(cu + radius * Math.cos((i / 28) * Math.PI * 2), cv + radius * Math.sin((i / 28) * Math.PI * 2)));
  art += polygon(ring(29, 38, 15), `fill="none" stroke="var(--art-navy)" stroke-width="5"`);
  art += polygon(ring(47, 38, 15), `fill="none" stroke="var(--art-amber)" stroke-width="5"`);
  return art;
}

/** 自动机：顶面是几个圆圈状态和连线。dashed 为真时连线画成虚线，表示空转移。 */
function automaton(dashed: boolean, accent: string): string {
  const p = projector(0, 0);
  let art = shadow(p, -40, -36, 80, 72, 14);
  art += box(p, -40, -36, 0, 80, 72, 6, { width: 1.8 });
  const top = facesOf(p, -40, -36, 0, 80, 72, 6).top;
  const spots: Array<[number, number]> = dashed ? [[10, 36], [28, 18], [28, 54], [48, 18], [48, 54], [68, 36]] : [[12, 36], [40, 18], [40, 54], [68, 36]];
  const links: Array<[number, number]> = dashed ? [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 5]] : [[0, 1], [0, 2], [1, 3], [2, 3]];
  for (const [a, b] of links) {
    const dash = dashed && (a === 0 || b === 5) ? ' stroke-dasharray="3 2"' : '';
    art += polyline([top(...spots[a]), top(...spots[b])], `stroke="${STROKE}" stroke-width="1.5"${dash}`);
  }
  spots.forEach(([u, v], index) => {
    const ring = (radius: number) => Array.from({ length: 16 }, (_, i) => top(u + radius * Math.cos((i / 16) * Math.PI * 2), v + radius * Math.sin((i / 16) * Math.PI * 2)));
    const last = index === spots.length - 1;
    art += polygon(ring(6), `fill="${last ? accent : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="1"`);
    if (last) art += polygon(ring(3.6), `fill="none" stroke="${STROKE}" stroke-width="0.8"`);
  });
  return art;
}

/** GOT：一排地址槽，亮的一格是函数的槽。 */
function gotRack(): string {
  const p = projector(0, 4);
  let art = shadow(p, -30, -40, 60, 80, 14);
  art += box(p, -30, -40, 0, 60, 80, 6, { width: 1.8 });
  const top = facesOf(p, -30, -40, 0, 60, 80, 6).top;
  for (let row = 0; row < 4; row++) {
    const lit = row === 3;
    art += quad(top, 7, 6 + row * 17.5, 46, 14, `fill="${lit ? 'var(--art-amber)' : row === 0 ? 'var(--art-cyan)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  }
  return art;
}

/** 动态链接器：顶面是一张表和一个指向槽位的箭头。 */
const ldso = () => machine(26, (top) => {
  let art = '';
  for (let i = 0; i < 3; i++) art += quad(top, 11, 13 + i * 14, 26, 10, `fill="${i === 1 ? 'var(--art-cyan)' : 'var(--art-paper)'}" ${thin}`);
  art += polyline([top(40, 31), top(54, 31)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round"`);
  art += polyline([top(49, 25), top(55, 31), top(49, 37)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`);
  art += quad(top, 56, 22, 8, 18, 'fill="var(--art-amber)" stroke="none"');
  return art;
});

interface NodeSpec {
  art: string;
  /** 通道到节点中心的裁切半径。 */
  radius: number;
  /** 节点名称相对中心的纵向位置。 */
  labelY: number;
}

const GREEN = 'var(--art-green)';
const BLUE = 'var(--art-navy)';
const AMBER = 'var(--art-amber)';
const STEEL = 'var(--art-steel)';

export const NODE_SPECS: Record<NodeId, NodeSpec> = {
  regex: { art: sheet('RE', [[30, AMBER], [52, BLUE], [24, STEEL], [44, GREEN], [36, STEEL]]), radius: 62, labelY: 60 },
  nfa: { art: automaton(true, AMBER), radius: 60, labelY: 60 },
  dfa: { art: automaton(false, GREEN), radius: 60, labelY: 60 },
  source: { art: sheet('.c', [[48, BLUE], [34, GREEN], [56, STEEL], [28, AMBER], [44, STEEL]]), radius: 62, labelY: 60 },
  lexer: { art: lexer(), radius: 58, labelY: 60 },
  tokens: { art: tokenTray(), radius: 56, labelY: 60 },
  parser: { art: parser(), radius: 58, labelY: 60 },
  tree: { art: treeSlab(), radius: 58, labelY: 60 },
  lrtable: { art: lrTable(), radius: 60, labelY: 60 },
  symtab: { art: cabinet(), radius: 56, labelY: 60 },
  irgen: { art: irgen(), radius: 58, labelY: 60 },
  ir: { art: sheet('IR', [[52, BLUE], [38, AMBER], [46, STEEL], [30, GREEN], [42, STEEL]], 'var(--art-teal)'), radius: 62, labelY: 60 },
  cfg: { art: cfgBoard(), radius: 58, labelY: 60 },
  ssa: { art: ssaSlab(), radius: 58, labelY: 60 },
  optimizer: { art: optimizer(), radius: 56, labelY: 60 },
  isel: { art: isel(), radius: 58, labelY: 60 },
  regalloc: { art: regBank(), radius: 56, labelY: 60 },
  frame: { art: stackPlates(), radius: 56, labelY: 60 },
  encoder: { art: encoderChip(), radius: 60, labelY: 60 },
  object: { art: sheet('ELF', [[40, STEEL], [56, BLUE], [30, AMBER], [48, STEEL], [36, GREEN]]), radius: 62, labelY: 60 },
  linker: { art: linker(), radius: 58, labelY: 60 },
  image: { art: sheet('a.out', [[58, BLUE], [58, BLUE], [44, GREEN], [58, BLUE], [22, AMBER]], 'var(--art-green)'), radius: 62, labelY: 60 },
  got: { art: gotRack(), radius: 56, labelY: 60 },
  ldso: { art: ldso(), radius: 58, labelY: 60 },
  shlib: { art: sheet('.so', [[48, GREEN], [36, BLUE], [56, STEEL], [30, AMBER], [44, STEEL]], 'var(--art-teal)'), radius: 62, labelY: 60 },
};
