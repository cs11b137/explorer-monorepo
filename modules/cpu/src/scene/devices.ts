import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText, type Point, type Project } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.2" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.6" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)', width: 1.7 };

/** 把平面多边形拉伸成立体，只画朝向观察者的侧面。 */
function extrude(p: Project, points: Array<[number, number]>, z: number, h: number, topFill = 'url(#face-top)'): string {
  const edges = points.map((a, i) => [a, points[(i + 1) % points.length]] as const);
  const walls = edges
    .map(([a, b]) => ({ a, b, depth: a[0] + a[1] + b[0] + b[1], facing: (b[0] - a[0]) * 1 - (b[1] - a[1]) * 1 }))
    .filter((edge) => edge.facing < 0 || edge.depth > 0)
    .sort((x, y) => x.depth - y.depth);
  let art = '';
  for (const { a, b } of walls) {
    const fill = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'url(#face-left)' : 'url(#face-right)';
    art += polygon([p(a[0], a[1], z), p(b[0], b[1], z), p(b[0], b[1], z + h), p(a[0], a[1], z + h)], `fill="${fill}" ${mid}`);
  }
  art += polygon(points.map(([x, y]): Point => p(x, y, z + h)), `fill="${topFill}" ${mid}`);
  return art;
}

/** 芯片：基板、引脚和裸片，裸片上印部件名。 */
function chip(name: string, size = 72, die = 'navy'): string {
  const p = projector(0, 0);
  const half = size / 2;
  let art = shadow(p, -half, -half, size, size, 20);
  const pins = Math.floor((size - 12) / 10);
  for (let i = 0; i < pins; i++) {
    const at = -half + 9 + i * 10;
    art += polyline([p(at, half, 0), p(at, half + 7, -2)], 'stroke="var(--art-steel-dark)" stroke-width="1.8"');
    art += polyline([p(half, at, 0), p(half + 7, at, -2)], 'stroke="var(--art-steel-dark)" stroke-width="1.8"');
  }
  art += box(p, -half, -half, 0, size, size, 7, { width: 1.9 });
  const inner = size * 0.64;
  const style = die === 'navy' ? NAVY : { top: 'var(--art-teal)', left: 'var(--art-teal)', right: 'var(--art-navy-2)', width: 1.7 };
  art += box(p, -inner / 2, -inner / 2, 7, inner, inner, 9, style);
  art += topText(p, 0, 0, 16, name, Math.min(size * 0.16, 62 / (name.length * 0.62)), 'fill="var(--art-paper)" letter-spacing="0.5"');
  return art;
}

/** 寄存器：一条长方块，正面一排位灯，顶面印名字。 */
function register(name: string, lit: number[] = [1, 3, 4, 6]): string {
  const p = projector(0, 4);
  const w = 84;
  const d = 40;
  const h = 18;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, h, { width: 1.9 });
  const f = facesOf(p, -w / 2, -d / 2, 0, w, d, h);
  for (let i = 0; i < 8; i++) art += quad(f.left, 5 + i * 9.6, 5, 7.4, 8, `fill="${lit.includes(i) ? 'var(--art-cyan)' : 'var(--art-steel-soft)'}" ${thin}`);
  art += topText(p, 0, 0, h, name, name.length > 3 ? 12 : 15, 'fill="var(--art-line)"');
  return art;
}

/** 存储阵列：扁平板，顶面一排排存储行，高亮当前行。 */
function memory(tag: string, litRow: number, tone = 'var(--art-amber)'): string {
  const p = projector(0, 0);
  const w = 80;
  const d = 72;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 12, { width: 1.9 });
  const top = facesOf(p, -w / 2, -d / 2, 0, w, d, 12).top;
  art += quad(top, 5, 4, w - 10, 14, `fill="var(--art-navy)" ${thin}`);
  for (let row = 0; row < 5; row++) art += quad(top, 5, 20 + row * 9.4, w - 10, 8, `fill="${row === litRow ? tone : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  art += topText(p, 0, -25, 12, tag, 9.5, 'fill="var(--art-paper)"');
  return art;
}

/** 寄存器堆：四层薄板叠起来，顶层露出行格。 */
function regfile(): string {
  const p = projector(0, 14);
  const w = 78;
  const d = 66;
  let art = shadow(p, -w / 2, -d / 2, w, d, 22);
  for (let level = 0; level < 4; level++) art += box(p, -w / 2, -d / 2, level * 9, w, d, 7, { width: 1.5 });
  const top = facesOf(p, -w / 2, -d / 2, 27, w, d, 7).top;
  for (let row = 0; row < 6; row++) art += quad(top, 6, 6 + row * 9.2, w - 12, 7.4, `fill="${row === 2 ? 'var(--art-cyan)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  return art;
}

/** ALU：教科书里带缺口的梯形符号，拉伸成立体。 */
function aluBlock(): string {
  const p = projector(0, 8);
  const shape: Array<[number, number]> = [[-38, -44], [-10, -44], [0, -28], [10, -44], [38, -44], [20, 36], [-20, 36]];
  let art = polygon([p(20, 36), p(52, 36), p(70, -44), p(38, -44)], 'class="iso-shadow"');
  art += extrude(p, shape, 0, 20);
  art += topText(p, 0, 2, 20, 'ALU', 15, 'fill="var(--art-line)"');
  return art;
}

/** 多路选择器：窄梯形，用于前递单元。 */
function muxBlock(tag: string): string {
  const p = projector(0, 6);
  const shape: Array<[number, number]> = [[-34, -36], [34, -36], [20, 32], [-20, 32]];
  let art = polygon([p(20, 32), p(44, 32), p(58, -36), p(34, -36)], 'class="iso-shadow"');
  art += extrude(p, shape, 0, 18);
  art += topText(p, 0, -2, 18, tag, 13, 'fill="var(--art-line)"');
  return art;
}

/** 行波进位加法器：板子上一串全加器，进位线把它们串起来。 */
function adder(): string {
  const p = projector(0, 6);
  const w = 110;
  const d = 52;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 6, { top: 'var(--art-green-soft)', width: 1.9 });
  const count = 4;
  for (let i = 0; i < count; i++) {
    const x = -w / 2 + 7 + i * 25.5;
    art += box(p, x, -13, 6, 20, 26, 11, { ...NAVY, width: 1.3 });
    art += topText(p, x + 10, 0, 17, 'FA', 7.5, 'fill="var(--art-paper)"');
    if (i < count - 1) art += polyline([p(x + 20, 0, 12), p(x + 25.5, 0, 12)], `stroke="var(--art-amber)" stroke-width="2.4"`);
  }
  return art;
}

/** 桶形移位器：块顶上交错的连线，表示每层可以错开若干位。 */
function shifter(): string {
  const p = projector(0, 6);
  const s = 70;
  let art = shadow(p, -s / 2, -s / 2, s, s, 18);
  art += box(p, -s / 2, -s / 2, 0, s, s, 22, { width: 1.9 });
  const top = facesOf(p, -s / 2, -s / 2, 0, s, s, 22).top;
  art += quad(top, 6, 6, s - 12, s - 12, `fill="var(--art-steel-soft)" ${thin}`);
  for (let i = 0; i < 5; i++) {
    art += polyline([top(12 + i * 9, 10), top(12 + i * 9, 24), top(21 + i * 9 > 58 ? 58 : 21 + i * 9, 46), top(21 + i * 9 > 58 ? 58 : 21 + i * 9, 60)], `stroke="${i === 2 ? 'var(--art-amber)' : STROKE}" stroke-width="1.5" stroke-linejoin="round"`);
  }
  return art;
}

/** 乘法器：顶面是部分积方阵。 */
function multiplier(): string {
  const p = projector(0, 6);
  const s = 70;
  let art = shadow(p, -s / 2, -s / 2, s, s, 18);
  art += box(p, -s / 2, -s / 2, 0, s, s, 20, { width: 1.9 });
  const top = facesOf(p, -s / 2, -s / 2, 0, s, s, 20).top;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) art += quad(top, 7 + col * 14.2, 7 + row * 14.2, 12, 12, `fill="${col + row === 3 ? 'var(--art-cyan)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  }
  return art;
}

/** 规格化与舍入：顶面是把长位串收窄的漏斗。 */
function normalizer(): string {
  const p = projector(0, 6);
  const s = 70;
  let art = shadow(p, -s / 2, -s / 2, s, s, 18);
  art += box(p, -s / 2, -s / 2, 0, s, s, 20, { width: 1.9 });
  const top = facesOf(p, -s / 2, -s / 2, 0, s, s, 20).top;
  art += polygon([top(8, 10), top(62, 10), top(46, 60), top(24, 60)], `fill="var(--art-amber-soft)" ${mid}`);
  for (const v of [22, 34, 46]) art += polyline([top(14 + (v - 10) * 0.28, v), top(56 - (v - 10) * 0.28, v)], `stroke="${STROKE}" stroke-width="1"`);
  return art;
}

/** 解码器：一根输入线在顶面展开成多根输出线。 */
function decoderBlock(): string {
  const p = projector(0, 6);
  const w = 78;
  const d = 66;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 20, { width: 1.9 });
  const top = facesOf(p, -w / 2, -d / 2, 0, w, d, 20).top;
  art += quad(top, 6, 6, w - 12, d - 12, `fill="var(--art-steel-soft)" ${thin}`);
  for (let i = 0; i < 5; i++) art += polyline([top(14, d / 2), top(34, d / 2), top(60, 12 + i * 10.5)], `stroke="${i === 1 ? 'var(--art-amber)' : STROKE}" stroke-width="1.5" stroke-linejoin="round"`);
  return art;
}

/** 立即数生成：顶面一个楔形，表示符号扩展。 */
function immBlock(): string {
  const p = projector(0, 4);
  const s = 66;
  let art = shadow(p, -s / 2, -s / 2, s, s, 16);
  art += box(p, -s / 2, -s / 2, 0, s, s, 16, { width: 1.9 });
  const top = facesOf(p, -s / 2, -s / 2, 0, s, s, 16).top;
  art += polygon([top(10, 26), top(10, 40), top(56, 58), top(56, 8)], `fill="var(--art-green-soft)" ${mid}`);
  art += topText(p, 0, 0, 16, 'IMM', 10, 'fill="var(--art-line)"');
  return art;
}

/** 流水级：一段工作台，后面立着这一级的流水寄存器。 */
function stage(tag: string, accent: string): string {
  const p = projector(0, 8);
  const w = 66;
  const d = 62;
  let art = shadow(p, -w / 2, -d / 2, w, d, 16);
  art += box(p, -w / 2, -d / 2, 0, w, d, 10, { width: 1.9 });
  art += box(p, -w / 2 + 4, -d / 2 + 4, 10, 10, d - 8, 24, { top: accent, left: accent, right: 'var(--art-navy-2)', width: 1.5 });
  art += box(p, -w / 2 + 22, -d / 2 + 10, 10, 34, d - 20, 10, { width: 1.5 });
  art += topText(p, 5, 0, 20, tag, tag.length > 2 ? 11 : 13, 'fill="var(--art-line)"');
  return art;
}

/** 分支预测器：顶面四格代表计数器的四个状态。 */
function predictorBlock(): string {
  const p = projector(0, 6);
  const w = 84;
  const d = 58;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 18, { width: 1.9 });
  const top = facesOf(p, -w / 2, -d / 2, 0, w, d, 18).top;
  for (let i = 0; i < 4; i++) art += quad(top, 6 + i * 18.4, 10, 16, 38, `fill="${i === 2 ? 'var(--art-amber)' : i === 3 ? 'var(--art-cyan)' : 'var(--art-paper)'}" ${thin}`);
  return art;
}

/** 缓存：扁盒子，顶面是组和路构成的方阵。 */
function cacheBlock(litRow: number): string {
  const p = projector(0, 4);
  const w = 88;
  const d = 66;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 16, { width: 1.9 });
  const top = facesOf(p, -w / 2, -d / 2, 0, w, d, 16).top;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) art += quad(top, 7 + col * 38, 7 + row * 13.4, 36, 11.4, `fill="${row === litRow && col === 0 ? 'var(--art-cyan)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  }
  return art;
}

/** 总线：一条长轨道，上面有信号线和接头。 */
function busRail(): string {
  const p = projector(0, 2);
  const len = 170;
  const d = 26;
  let art = shadow(p, -len / 2, -d / 2, len, d, 12);
  art += box(p, -len / 2, -d / 2, 0, len, d, 7, { top: 'var(--art-steel-soft)', width: 1.9 });
  const top = facesOf(p, -len / 2, -d / 2, 0, len, d, 7).top;
  for (const v of [6, 13, 20]) art += polyline([top(5, v), top(len - 5, v)], `stroke="${v === 13 ? 'var(--art-amber)' : STROKE}" stroke-width="1.2"`);
  return art;
}

/** 内存条：立着的电路板，金手指朝下。 */
function dimm(): string {
  const p = projector(0, 12);
  const w = 118;
  const d = 6;
  const h = 40;
  const x = -w / 2;
  let art = shadow(p, x, -12, w, 24, 20);
  art += box(p, x, -3, 0, w, d, h, { top: 'var(--art-green-soft)', left: 'var(--art-green-soft)', right: 'var(--art-steel)', width: 1.9 });
  const f = facesOf(p, x, -3, 0, w, d, h).left;
  for (let i = 0; i < 5; i++) art += quad(f, 6 + i * 22, 13, 18, 22, `fill="var(--art-navy)" ${thin}`);
  for (let i = 0; i < 20; i++) art += quad(f, 5 + i * 5.6, 2, 3.4, 6, 'fill="var(--art-amber)" stroke="none"');
  return art;
}

/** DRAM bank：存储单元阵列，当前打开的行亮着，前面是行缓冲（感应放大器）。 */
function bankArray(): string {
  const p = projector(0, 0);
  const w = 90;
  const d = 76;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 10, { width: 1.9 });
  const top = facesOf(p, -w / 2, -d / 2, 0, w, d, 10).top;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) art += quad(top, 6 + col * 11.2, 6 + row * 10, 9.6, 8.4, `fill="${row === 2 ? 'var(--art-amber)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.7"`);
  }
  art += quad(top, 6, 58, w - 12, 12, `fill="var(--art-navy)" ${thin}`);
  return art;
}

/** 网卡一类的外设：板卡加接口。 */
function deviceCard(): string {
  const p = projector(0, 4);
  const w = 96;
  const d = 60;
  let art = shadow(p, -w / 2, -d / 2, w, d, 18);
  art += box(p, -w / 2, -d / 2, 0, w, d, 6, { top: 'var(--art-green-soft)', width: 1.9 });
  art += box(p, -32, -18, 6, 34, 34, 10, { ...NAVY, width: 1.4 });
  art += box(p, 18, -22, 6, 24, 44, 18, { width: 1.5 });
  const face = facesOf(p, 18, -22, 6, 24, 44, 18).right;
  art += quad(face, 6, 4, 14, 10, `fill="var(--art-screen)" ${thin}`);
  art += quad(face, 24, 4, 14, 10, `fill="var(--art-screen)" ${thin}`);
  return art;
}

/** 汇编器：一个小终端窗口，屏幕上是几行代码。 */
function terminal(): string {
  const p = projector(0, 8);
  const w = 88;
  const d = 7;
  const h = 62;
  const x = -w / 2;
  const y = -10;
  const f = facesOf(p, x, y, 6, w, d, h);
  let art = shadow(p, -36, -28, 72, 56, 22);
  art += box(p, -36, -28, 0, 72, 56, 6, { width: 1.8 });
  art += box(p, x, y, 6, w, d, h, { width: 2 });
  art += quad(f.left, 4, 4, w - 8, h - 8, `fill="var(--art-screen)" ${mid}`);
  art += quad(f.left, 4, h - 13, w - 8, 9, `fill="var(--art-navy)" ${thin}`);
  const rows: Array<[number, number, string]> = [[40, 44, 'var(--term-prompt)'], [30, 58, 'var(--term-text)'], [20, 36, 'var(--term-text)'], [10, 50, 'var(--term-ok)']];
  for (const [v, length, color] of rows) art += polyline([f.left(10, v), f.left(10 + length, v)], `stroke="${color}" stroke-width="2.8" stroke-linecap="round"`);
  return art;
}

export interface NodeSpec {
  art: string;
  /** 通道到节点中心的裁切半径。 */
  radius: number;
  /** 节点名称相对中心的纵向位置。 */
  labelY: number;
  /** 设备图形的半宽和顶部（相对中心，向上为负）。几何测试和相机取景用。 */
  halfWidth: number;
  top: number;
}

const spec = (art: string, radius: number, labelY: number, halfWidth: number, top: number): NodeSpec => ({ art, radius, labelY, halfWidth, top });

export const NODE_SPECS: Record<NodeId, NodeSpec> = {
  pc: spec(register('PC'), 58, 52, 56, -40),
  imem: spec(memory('IMEM', 1), 60, 56, 66, -44),
  decoder: spec(decoderBlock(), 58, 56, 64, -40),
  immgen: spec(immBlock(), 52, 54, 58, -38),
  regfile: spec(regfile(), 62, 60, 66, -46),
  alu: spec(aluBlock(), 60, 58, 70, -46),
  control: spec(chip('CTRL'), 58, 58, 68, -44),
  dmem: spec(memory('DMEM', 3, 'var(--art-cyan)'), 60, 56, 66, -44),
  rega: spec(register('A'), 58, 52, 56, -40),
  regb: spec(register('B', [0, 2, 5, 7]), 58, 52, 56, -40),
  regy: spec(register('Y', [2, 3, 6]), 58, 52, 56, -40),
  adder: spec(adder(), 66, 56, 72, -38),
  shifter: spec(shifter(), 56, 56, 62, -44),
  multiplier: spec(multiplier(), 56, 56, 62, -44),
  flags: spec(register('FLAG', [0, 1]), 58, 52, 56, -40),
  norm: spec(normalizer(), 56, 56, 62, -44),
  sif: spec(stage('IF', 'var(--art-cyan)'), 54, 58, 58, -48),
  sid: spec(stage('ID', 'var(--art-steel)'), 54, 58, 58, -48),
  sex: spec(stage('EX', 'var(--art-amber)'), 54, 58, 58, -48),
  smem: spec(stage('MEM', 'var(--art-green)'), 54, 58, 58, -48),
  swb: spec(stage('WB', 'var(--art-teal)'), 54, 58, 58, -48),
  hazard: spec(muxBlock('FWD'), 54, 52, 60, -36),
  predictor: spec(predictorBlock(), 58, 56, 68, -36),
  core0: spec(chip('CORE0'), 58, 58, 68, -44),
  core1: spec(chip('CORE1'), 58, 58, 68, -44),
  cache: spec(cacheBlock(1), 60, 56, 68, -40),
  cache1: spec(cacheBlock(2), 60, 56, 68, -40),
  bus: spec(busRail(), 34, 64, 104, -56),
  memctrl: spec(chip('MC'), 58, 58, 68, -44),
  dram: spec(dimm(), 62, 56, 80, -44),
  bank: spec(bankArray(), 62, 58, 72, -44),
  dma: spec(chip('DMA', 72, 'teal'), 58, 58, 68, -44),
  device: spec(deviceCard(), 62, 56, 72, -44),
  asm: spec(terminal(), 58, 62, 62, -66),
};
