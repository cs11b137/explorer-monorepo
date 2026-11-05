import type { DeviceArt, NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.3" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.7" stroke-linejoin="round"`;

/** 终端窗口：立在底座上的屏幕。屏幕上的行是 screen-line，render 事件时逐行显示。 */
function terminal(accent: string): string {
  const p = projector(0, 8);
  const w = 112;
  const d = 8;
  const h = 84;
  const x = -w / 2;
  const y = -14;
  const f = facesOf(p, x, y, 8, w, d, h);
  let art = shadow(p, -44, -36, 88, 72, 32);
  art += box(p, -44, -36, 0, 88, 72, 6, { width: 2 });
  art += box(p, -8, -14, 6, 16, 14, 8, { width: 1.5 });
  art += box(p, x, y, 8, w, d, h, { width: 2.2 });
  art += quad(f.left, 5, 5, w - 10, h - 10, `fill="var(--art-screen)" ${mid}`);
  art += quad(f.left, 5, h - 15, w - 10, 10, `fill="${accent}" ${thin}`);
  for (const [i, u] of [8, 13, 18].entries()) art += `<circle cx="${f.left(u, h - 10)[0].toFixed(2)}" cy="${f.left(u, h - 10)[1].toFixed(2)}" r="1.5" fill="var(--art-paper)" data-i="${i}"/>`;
  const rows: Array<[number, number, string]> = [
    [46, 11, 'var(--term-prompt)'],
    [46 - 11, 44, 'var(--term-text)'],
    [46 - 22, 70, 'var(--term-text)'],
    [46 - 33, 30, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, length, color] of rows) {
    screen += polyline([f.left(12, v), f.left(12 + length, v)], `class="screen-line" stroke="${color}" stroke-width="3.2" stroke-linecap="round" pathLength="1"`);
  }
  art += `<g class="screen-content">${screen}</g>`;
  // 键盘侧的底座刻线
  const top = facesOf(p, -44, -36, 0, 88, 72, 6).top;
  for (const v of [40, 52, 64]) art += polyline([top(14, v), top(74, v)], 'stroke="var(--art-line-soft)" stroke-width="1"');
  return art;
}

/** 内核：三层台阶，顶部是环形特权标记。 */
function kernel(): string {
  const p = projector(0, 8);
  let art = shadow(p, -60, -60, 120, 120, 34);
  art += box(p, -60, -60, 0, 120, 120, 18, { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)', width: 2 });
  art += box(p, -46, -46, 18, 92, 92, 18, { width: 2 });
  art += box(p, -32, -32, 36, 64, 64, 14, { width: 2 });
  const left = facesOf(p, -46, -46, 18, 92, 92, 18).left;
  const right = facesOf(p, -46, -46, 18, 92, 92, 18).right;
  art += quad(left, 8, 6, 34, 6, `fill="var(--art-cyan)" ${thin}`);
  art += quad(left, 48, 6, 34, 6, `fill="var(--art-steel)" ${thin}`);
  art += quad(right, 8, 6, 74, 6, `fill="var(--art-steel)" ${thin}`);
  const top = facesOf(p, -32, -32, 36, 64, 64, 14).top;
  const ring = (radius: number) =>
    Array.from({ length: 32 }, (_, i) => top(32 + radius * Math.cos((i / 32) * Math.PI * 2), 32 + radius * Math.sin((i / 32) * Math.PI * 2)));
  art += polygon(ring(24), `fill="var(--art-paper)" ${mid}`);
  art += polygon(ring(14), `fill="var(--art-navy)" stroke="none"`);
  art += topText(p, 0, 0, 50, 'R0', 11, 'fill="var(--art-paper)"');
  return art;
}

/** 第二个内核模块：顶面是一条队列，按课改名（调度器、页缓存、jbd2 等）。 */
function moduleBlock(): string {
  const p = projector(0, 4);
  let art = shadow(p, -42, -42, 84, 84, 28);
  art += box(p, -42, -42, 0, 84, 84, 32, { width: 2.1 });
  const f = facesOf(p, -42, -42, 0, 84, 84, 32);
  art += quad(f.top, 10, 10, 64, 64, `fill="var(--art-steel-soft)" ${thin}`);
  for (let i = 0; i < 4; i++) art += quad(f.top, 16, 15 + i * 14, 52, 9, `fill="${i === 0 ? 'var(--art-cyan)' : 'var(--art-steel)'}" ${thin}`);
  art += quad(f.left, 10, 9, 26, 12, `fill="var(--art-paper)" ${thin}`);
  for (const u of [44, 54, 64]) art += quad(f.left, u, 11, 6, 8, `fill="var(--art-steel)" ${thin}`);
  for (let i = 0; i < 3; i++) art += polyline([f.right(10, 8 + i * 7), f.right(74, 8 + i * 7)], 'stroke="var(--art-line-soft)" stroke-width="1.2"');
  return art;
}

/** CPU：基板、引脚和中央裸片。 */
function chip(name: string, size = 104): string {
  const p = projector(0, 0);
  const half = size / 2;
  let art = shadow(p, -half, -half, size, size, 26);
  const pins = Math.floor((size - 18) / 11);
  for (let i = 0; i < pins; i++) {
    const at = -half + 12 + i * 11;
    art += polyline([p(at, half, 0), p(at, half + 8, -2)], 'stroke="var(--art-steel-dark)" stroke-width="2"');
    art += polyline([p(half, at, 0), p(half + 8, at, -2)], 'stroke="var(--art-steel-dark)" stroke-width="2"');
  }
  art += box(p, -half, -half, 0, size, size, 8, { width: 2.1 });
  const inner = size * 0.58;
  art += box(p, -inner / 2, -inner / 2, 8, inner, inner, 11, { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)', width: 1.8 });
  art += topText(p, 0, 0, 19, name, size * 0.135, 'fill="var(--art-paper)" letter-spacing="1"');
  return art;
}

/** 中断控制器：小芯片加闪电标记。 */
function apic(): string {
  const p = projector(0, 2);
  let art = shadow(p, -36, -36, 72, 72, 20);
  art += box(p, -36, -36, 0, 72, 72, 16, { width: 2 });
  const f = facesOf(p, -36, -36, 0, 72, 72, 16);
  art += quad(f.top, 12, 12, 48, 48, `fill="var(--art-amber-soft)" ${thin}`);
  art += polygon([f.top(40, 16), f.top(26, 37), f.top(35, 37), f.top(30, 56), f.top(46, 32), f.top(37, 32)], 'fill="var(--art-amber)" stroke="var(--art-line)" stroke-width="1.2" stroke-linejoin="round"');
  art += quad(f.left, 8, 5, 20, 6, `fill="var(--art-steel)" ${thin}`);
  art += quad(f.right, 8, 5, 20, 6, `fill="var(--art-steel)" ${thin}`);
  return art;
}

function keyboard(): string {
  const p = projector(0, 4);
  let art = shadow(p, -66, -36, 132, 72, 22);
  art += box(p, -66, -36, 0, 132, 72, 10, { width: 2 });
  const top = facesOf(p, -66, -36, 0, 132, 72, 10).top;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 10; col++) {
      const lit = row === 1 && col === 1;
      art += quad(top, 7 + col * 12, 8 + row * 14, 10, 11, `class="${lit ? 'key-lit' : ''}" fill="${lit ? 'var(--art-amber)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="1"`);
    }
  }
  return art;
}

/** UEFI 固件：小电路板上的 ROM 芯片。 */
function firmware(): string {
  const p = projector(0, 4);
  let art = shadow(p, -52, -44, 104, 88, 24);
  art += box(p, -52, -44, 0, 104, 88, 6, { top: 'var(--art-green-soft)', width: 2 });
  art += box(p, -26, -20, 6, 52, 40, 12, { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)', width: 1.7 });
  art += topText(p, 0, 0, 18, 'UEFI', 10, 'fill="var(--art-paper)"');
  const top = facesOf(p, -52, -44, 0, 104, 88, 6).top;
  for (const u of [10, 22, 34]) art += polyline([top(u, 8), top(u, 22), top(u + 12, 28)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  for (const v of [62, 72]) art += polyline([top(12, v), top(92, v)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** MMU：盒体顶面是 TLB 条目，正面是地址转换的箭头。 */
function mmu(): string {
  const p = projector(0, 6);
  let art = shadow(p, -42, -42, 84, 84, 28);
  art += box(p, -42, -42, 0, 84, 84, 36, { width: 2.1 });
  const f = facesOf(p, -42, -42, 0, 84, 84, 36);
  art += quad(f.top, 9, 9, 66, 66, `fill="var(--art-steel-soft)" ${thin}`);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) art += quad(f.top, 13 + col * 15, 13 + row * 15, 13, 13, `fill="${row === 2 && col === 1 ? 'var(--art-cyan)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="1"`);
  }
  art += polyline([f.left(14, 18), f.left(66, 18)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round"`);
  art += polyline([f.left(56, 26), f.left(68, 18), f.left(56, 10)], `stroke="${STROKE}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`);
  for (let i = 0; i < 3; i++) art += quad(f.right, 12 + i * 22, 10, 16, 16, `fill="var(--art-steel)" ${thin}`);
  return art;
}

/** 页表：一张薄片，高亮的那一行就是本级命中的表项。 */
function pageTable(tag: string, litRow: number): string {
  const p = projector(0, 0);
  let art = shadow(p, -40, -34, 80, 68, 16);
  art += box(p, -40, -34, 0, 80, 68, 6, { width: 1.9 });
  const top = facesOf(p, -40, -34, 0, 80, 68, 6).top;
  art += quad(top, 5, 4, 70, 13, `fill="var(--art-navy)" ${thin}`);
  for (let row = 0; row < 5; row++) {
    art += quad(top, 5, 19 + row * 9, 70, 8, `fill="${row === litRow ? 'var(--art-amber)' : 'var(--art-paper)'}" stroke="${STROKE}" stroke-width="0.9"`);
  }
  art += topText(p, 0, -23.5, 6, tag, 10, 'fill="var(--art-paper)"');
  return art;
}

/** 内存条：立着的电路板，金手指朝下。 */
function ram(): string {
  const p = projector(0, 12);
  const w = 148;
  const d = 7;
  const h = 46;
  const x = -w / 2;
  let art = shadow(p, x, -14, w, 28, 26);
  art += box(p, x, -3.5, 0, w, d, h, { top: 'var(--art-green-soft)', left: 'var(--art-green-soft)', right: 'var(--art-steel)', width: 2 });
  const f = facesOf(p, x, -3.5, 0, w, d, h).left;
  for (let i = 0; i < 6; i++) art += quad(f, 8 + i * 23, 16, 19, 24, `fill="var(--art-navy)" ${thin}`);
  for (let i = 0; i < 24; i++) art += quad(f, 6 + i * 5.9, 2, 3.6, 7, 'fill="var(--art-amber)" stroke="none"');
  return art;
}

/** 磁盘：三层盘片堆叠。 */
function disk(): string {
  const rx = 52;
  const ry = 26;
  const ellipse = (cy: number, fill: string, sw = 2) => `<ellipse cx="0" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${STROKE}" stroke-width="${sw}"/>`;
  const wall = (cy: number, h: number, fill: string) =>
    `<path d="M${-rx},${cy} v${h} a${rx},${ry} 0 0 0 ${rx * 2},0 v${-h} z" fill="${fill}" stroke="${STROKE}" stroke-width="2" stroke-linejoin="round"/>`;
  let art = `<ellipse cx="22" cy="44" rx="70" ry="34" class="iso-shadow round"/>`;
  art += wall(24, 20, 'url(#face-right)') + ellipse(24, 'url(#face-top)');
  art += wall(2, 20, 'url(#face-left)') + ellipse(2, 'url(#face-top)');
  art += wall(-20, 20, 'url(#face-right)') + ellipse(-20, 'url(#face-top)');
  art += `<ellipse cx="0" cy="-20" rx="${rx * 0.62}" ry="${ry * 0.62}" fill="var(--art-steel-soft)" stroke="${STROKE}" stroke-width="1.3"/>`;
  art += `<ellipse cx="0" cy="-20" rx="${rx * 0.16}" ry="${ry * 0.16}" fill="var(--art-navy)" stroke="none"/>`;
  art += `<circle cx="38" cy="40" r="3" fill="var(--art-green)"/>`;
  return art;
}

interface NodeSpec {
  art: string;
  /** 通道到节点中心的裁切半径。 */
  radius: number;
  /** 节点名称相对中心的纵向位置。 */
  labelY: number;
}

export const NODE_SPECS: Record<NodeId, NodeSpec> = {
  app: { art: terminal('var(--art-navy)'), radius: 78, labelY: 78 },
  proc2: { art: terminal('var(--art-teal)'), radius: 78, labelY: 78 },
  kernel: { art: kernel(), radius: 88, labelY: 92 },
  k2: { art: moduleBlock(), radius: 66, labelY: 64 },
  cpu: { art: chip('CPU'), radius: 76, labelY: 70 },
  cpu2: { art: chip('CPU 1'), radius: 76, labelY: 70 },
  apic: { art: apic(), radius: 56, labelY: 50 },
  device: { art: `<g class="art-keyboard">${keyboard()}</g><g class="art-firmware" hidden>${firmware()}</g>`, radius: 72, labelY: 66 },
  mmu: { art: mmu(), radius: 68, labelY: 66 },
  pml4: { art: pageTable('PML4', 1), radius: 54, labelY: 56 },
  pdpt: { art: pageTable('PDPT', 3), radius: 54, labelY: 56 },
  pd: { art: pageTable('PD', 2), radius: 54, labelY: 56 },
  pt: { art: pageTable('PT', 4), radius: 54, labelY: 56 },
  ram: { art: ram(), radius: 78, labelY: 66 },
  disk: { art: disk(), radius: 70, labelY: 76 },
};

export function setDeviceArt(root: Element, art: DeviceArt): void {
  root.querySelector<SVGGElement>('.art-keyboard')?.toggleAttribute('hidden', art !== 'keyboard');
  root.querySelector<SVGGElement>('.art-firmware')?.toggleAttribute('hidden', art !== 'firmware');
}
