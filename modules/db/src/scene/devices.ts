import type { NodeId } from '../lessons/types';
import { box, facesOf, polygon, polyline, projector, quad, shadow, STROKE, topText } from '@explorer/engine/scene/iso';

const thin = `stroke="${STROKE}" stroke-width="1.1" stroke-linejoin="round"`;
const mid = `stroke="${STROKE}" stroke-width="1.5" stroke-linejoin="round"`;
const NAVY = { top: 'var(--art-navy)', left: 'var(--art-navy)', right: 'var(--art-navy-2)' };

/** 客户端：带底座的终端。屏幕上的行是 screen-line，render 事件时逐行显示。 */
function terminal(accent: string): string {
  const p = projector(0, 6);
  const w = 86;
  const d = 6;
  const h = 64;
  const x = -w / 2;
  const y = -10;
  const f = facesOf(p, x, y, 6, w, d, h);
  let art = shadow(p, -34, -28, 68, 56, 24);
  art += box(p, -34, -28, 0, 68, 56, 5, { width: 1.7 });
  art += box(p, -6, -10, 5, 12, 10, 6, { width: 1.3 });
  art += box(p, x, y, 6, w, d, h, { width: 1.9 });
  art += quad(f.left, 4, 4, w - 8, h - 8, `fill="var(--art-screen)" ${mid}`);
  art += quad(f.left, 4, h - 12, w - 8, 8, `fill="${accent}" ${thin}`);
  const rows: Array<[number, number, string]> = [
    [36, 10, 'var(--term-prompt)'],
    [28, 34, 'var(--term-text)'],
    [20, 52, 'var(--term-text)'],
    [12, 24, 'var(--term-ok)'],
  ];
  let screen = '';
  for (const [v, length, color] of rows) screen += polyline([f.left(9, v), f.left(9 + length, v)], `class="screen-line" stroke="${color}" stroke-width="2.6" stroke-linecap="round" pathLength="1"`);
  return `${art}<g class="screen-content">${screen}</g>`;
}

/** 后端进程：机箱，正面有状态灯，顶面标着进程。 */
function backend(tag: string, accent = 'var(--art-cyan)'): string {
  const p = projector(0, 8);
  let art = shadow(p, -38, -38, 76, 76, 24);
  art += box(p, -38, -38, 0, 76, 76, 12, { ...NAVY, width: 1.8 });
  art += box(p, -32, -32, 12, 64, 64, 28, { width: 1.8 });
  const f = facesOf(p, -32, -32, 12, 64, 64, 28);
  art += quad(f.top, 10, 10, 44, 44, `fill="var(--art-navy)" ${thin}`);
  art += topText(p, 0, 0, 40, tag, 11, 'fill="var(--art-paper)"');
  for (let i = 0; i < 3; i++) art += quad(f.left, 7 + i * 19, 15, 13, 6, `fill="${i === 0 ? accent : 'var(--art-steel)'}" ${thin}`);
  for (let i = 0; i < 3; i++) art += polyline([f.right(8, 6 + i * 7), f.right(56, 6 + i * 7)], 'stroke="var(--art-line-soft)" stroke-width="1.1"');
  return art;
}

/** 解析器：一张带括号的稿纸。 */
function parser(): string {
  const p = projector(0, 2);
  let art = shadow(p, -42, -36, 84, 72, 18);
  art += box(p, -42, -36, 0, 84, 72, 6, { width: 1.8 });
  art += box(p, -36, -32, 6, 72, 64, 4, { width: 1.4, top: 'var(--art-paper)' });
  const top = facesOf(p, -36, -32, 6, 72, 64, 4).top;
  art += quad(top, 5, 5, 62, 12, `fill="var(--art-navy)" ${thin}`);
  for (const [v, a, b, tone] of [[23, 6, 36, 'var(--art-amber)'], [32, 14, 54, 'var(--art-steel)'], [41, 14, 40, 'var(--art-cyan)'], [50, 6, 30, 'var(--art-steel)']] as Array<[number, number, number, string]>) {
    art += polyline([top(a, v), top(b, v)], `stroke="${tone}" stroke-width="3.2" stroke-linecap="round"`);
  }
  return art + topText(p, 0, -21, 10, 'SQL', 9, 'fill="var(--art-paper)"');
}

/** 系统目录：三本叠放的账册，书脊上有标签。 */
function catalog(): string {
  const p = projector(0, 8);
  let art = shadow(p, -42, -32, 84, 64, 20);
  const tones = ['var(--art-navy)', 'var(--art-steel)', 'var(--art-cyan)'];
  for (let i = 0; i < 3; i++) {
    const z = i * 12;
    const inset = i * 3;
    art += box(p, -42 + inset, -32 + inset, z, 84 - inset * 2, 64 - inset * 2, 12, { width: 1.5 });
    const f = facesOf(p, -42 + inset, -32 + inset, z, 84 - inset * 2, 64 - inset * 2, 12);
    art += quad(f.left, 6, 3, 66 - inset * 2, 6, `fill="${tones[i]}" ${thin}`);
  }
  return art;
}

/** 优化器：盘面上三条长短不同的路径，最短的被选中。 */
function planner(): string {
  const p = projector(0, 4);
  let art = shadow(p, -42, -42, 84, 84, 24);
  art += box(p, -42, -42, 0, 84, 84, 16, { width: 1.9 });
  const f = facesOf(p, -42, -42, 0, 84, 84, 16);
  art += quad(f.top, 7, 7, 70, 70, `fill="var(--art-steel-soft)" ${thin}`);
  for (const [v, len, tone] of [[18, 54, 'var(--art-steel)'], [36, 26, 'var(--art-green)'], [54, 42, 'var(--art-steel)']] as Array<[number, number, string]>) {
    art += quad(f.top, 12, v, len, 11, `fill="${tone}" ${thin}`);
  }
  art += quad(f.left, 8, 4, 24, 8, `fill="var(--art-navy)" ${thin}`);
  for (const u of [40, 52, 64]) art += quad(f.left, u, 5, 7, 6, `fill="var(--art-steel)" ${thin}`);
  return art;
}

/** 执行器：一条流水线，上面有箭头。 */
function executor(): string {
  const p = projector(0, 6);
  let art = shadow(p, -50, -30, 100, 60, 22);
  art += box(p, -50, -30, 0, 100, 60, 14, { ...NAVY, width: 1.8 });
  const top = facesOf(p, -50, -30, 0, 100, 60, 14).top;
  for (const u of [12, 40, 68]) {
    art += polygon([top(u, 14), top(u + 12, 14), top(u + 22, 30), top(u + 12, 46), top(u, 46), top(u + 10, 30)], 'fill="var(--art-cyan)" stroke="var(--art-paper)" stroke-width="1"');
  }
  art += box(p, -36, -30, 14, 16, 8, 16, { width: 1.3 });
  art += box(p, 18, -30, 14, 16, 8, 16, { width: 1.3 });
  return art;
}

/** 缓冲池：托盘上的帧，部分已被占用。 */
function buffer(): string {
  const p = projector(0, 4);
  let art = shadow(p, -48, -40, 96, 80, 22);
  art += box(p, -48, -40, 0, 96, 80, 14, { width: 1.9 });
  const top = facesOf(p, -48, -40, 0, 96, 80, 14).top;
  const lit = new Set(['0,0', '1,2', '2,1', '3,3', '0,3', '2,2']);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const on = lit.has(`${row},${col}`);
      art += quad(top, 7 + col * 21, 7 + row * 23, 19, 20, `fill="${row === 1 && col === 2 ? 'var(--art-amber)' : on ? 'var(--art-cyan)' : 'var(--art-paper)'}" ${thin}`);
    }
  }
  return art;
}

/** 堆文件：一摞 8 KiB 页。 */
function heap(accent: string): string {
  const p = projector(0, 10);
  let art = shadow(p, -38, -32, 76, 64, 20);
  for (let i = 0; i < 4; i++) {
    const z = i * 8;
    art += box(p, -38, -32, z, 76, 64, 6, { width: 1.4, top: i === 3 ? 'var(--art-paper)' : undefined });
  }
  const top = facesOf(p, -38, -32, 24, 76, 64, 6).top;
  art += quad(top, 5, 5, 66, 8, `fill="${accent}" ${thin}`);
  for (let i = 0; i < 4; i++) art += quad(top, 5 + i * 11, 16, 9, 7, `fill="var(--art-steel)" ${thin}`);
  for (let i = 0; i < 3; i++) art += quad(top, 7, 28 + i * 10, 62, 8, `fill="${i === 0 ? 'var(--art-amber-soft)' : 'var(--art-steel-soft)'}" ${thin}`);
  return art;
}

/** B+ 树：底板上一个根、三个叶。 */
function btree(): string {
  const p = projector(0, 10);
  let art = shadow(p, -44, -38, 88, 76, 20);
  art += box(p, -44, -38, 0, 88, 76, 6, { width: 1.7 });
  const nodes: Array<[number, number, number, string]> = [[-6, -6, 34, 'var(--art-navy)'], [-32, 14, 12, 'var(--art-cyan)'], [-6, 20, 12, 'var(--art-steel)'], [20, 8, 12, 'var(--art-steel)']];
  for (const [x, y, z] of nodes.slice(1)) art += polyline([p(0, 0, 34), p(x + 7, y + 7, z + 7)], 'stroke="var(--art-line)" stroke-width="1.5"');
  for (const [x, y, z, top] of nodes.slice(1)) art += box(p, x, y, z - 6, 15, 15, 7, { top, width: 1.3 });
  art += box(p, -9, -9, 30, 18, 18, 9, { ...NAVY, width: 1.4 });
  return art;
}

/** WAL：一卷只能追加的日志带。 */
function wal(): string {
  const rx = 40;
  const ry = 20;
  let art = '<ellipse cx="18" cy="30" rx="54" ry="24" class="iso-shadow round"/>';
  art += `<path d="M${-rx},-12 v30 a${rx},${ry} 0 0 0 ${rx * 2},0 v-30 z" fill="url(#face-right)" stroke="${STROKE}" stroke-width="1.8" stroke-linejoin="round"/>`;
  for (const [offset, tone] of [[-28, 'var(--art-green)'], [-13, 'var(--art-green)'], [2, 'var(--art-green)'], [17, 'var(--art-amber)']] as Array<[number, string]>) {
    art += `<rect x="${offset}" y="9" width="12" height="17" fill="${tone}" stroke="${STROKE}" stroke-width="0.9"/>`;
  }
  art += `<ellipse cx="0" cy="-12" rx="${rx}" ry="${ry}" fill="url(#face-top)" stroke="${STROKE}" stroke-width="1.8"/>`;
  art += `<ellipse cx="0" cy="-12" rx="${rx * 0.55}" ry="${ry * 0.55}" fill="var(--art-steel-soft)" stroke="${STROKE}" stroke-width="1.1"/>`;
  art += `<ellipse cx="0" cy="-12" rx="${rx * 0.18}" ry="${ry * 0.18}" fill="var(--art-navy)" stroke="none"/>`;
  return art;
}

/** 磁盘：叠起来的盘片。 */
function disk(): string {
  const rx = 42;
  const ry = 21;
  const ellipse = (cy: number) => `<ellipse cx="0" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#face-top)" stroke="${STROKE}" stroke-width="1.7"/>`;
  const wall = (cy: number, h: number, fill: string) => `<path d="M${-rx},${cy} v${h} a${rx},${ry} 0 0 0 ${rx * 2},0 v${-h} z" fill="${fill}" stroke="${STROKE}" stroke-width="1.7" stroke-linejoin="round"/>`;
  let art = '<ellipse cx="18" cy="34" rx="56" ry="26" class="iso-shadow round"/>';
  art += wall(18, 16, 'url(#face-right)') + ellipse(18);
  art += wall(0, 16, 'url(#face-left)') + ellipse(0);
  art += wall(-18, 16, 'url(#face-right)') + ellipse(-18);
  art += `<ellipse cx="0" cy="-18" rx="${rx * 0.6}" ry="${ry * 0.6}" fill="var(--art-steel-soft)" stroke="${STROKE}" stroke-width="1.1"/>`;
  art += `<ellipse cx="0" cy="-18" rx="${rx * 0.15}" ry="${ry * 0.15}" fill="var(--art-navy)" stroke="none"/>`;
  return `${art}<circle cx="30" cy="30" r="2.6" fill="var(--art-green)"/>`;
}

/** 锁管理器：一把挂锁。 */
function lock(): string {
  const p = projector(0, 14);
  let art = shadow(p, -34, -14, 68, 28, 24);
  art += `<path d="M-20,-14 v-14 a20,16 0 0 1 40,0 v14" fill="none" stroke="var(--art-steel-dark)" stroke-width="7" stroke-linecap="round"/>`;
  art += `<path d="M-20,-14 v-14 a20,16 0 0 1 40,0 v14" fill="none" stroke="var(--art-steel-soft)" stroke-width="3" stroke-linecap="round"/>`;
  art += box(p, -34, -7, 0, 68, 14, 40, { ...NAVY, width: 1.9 });
  const f = facesOf(p, -34, -7, 0, 68, 14, 40).left;
  art += quad(f, 26, 10, 16, 20, `fill="var(--art-amber)" ${thin}`);
  art += quad(f, 31, 15, 6, 10, `fill="var(--art-navy)" stroke="none"`);
  return art;
}

/** 后台写进程：朝下的箭头，把脏页慢慢写出去。 */
function bgwriter(): string {
  const p = projector(0, 6);
  let art = shadow(p, -36, -36, 72, 72, 22);
  art += box(p, -36, -36, 0, 72, 72, 26, { width: 1.8 });
  const f = facesOf(p, -36, -36, 0, 72, 72, 26);
  art += quad(f.top, 10, 10, 52, 52, `fill="var(--art-amber-soft)" ${thin}`);
  art += polygon([f.top(30, 18), f.top(42, 18), f.top(42, 36), f.top(51, 36), f.top(36, 54), f.top(21, 36), f.top(30, 36)], 'fill="var(--art-amber)" stroke="var(--art-line)" stroke-width="1.1" stroke-linejoin="round"');
  for (let i = 0; i < 3; i++) art += quad(f.left, 8 + i * 20, 8, 15, 8, `fill="${i === 2 ? 'var(--art-amber)' : 'var(--art-steel)'}" ${thin}`);
  return art;
}

/** CLOG：每个事务两位的状态图。 */
function clog(): string {
  const p = projector(0, 4);
  let art = shadow(p, -44, -36, 88, 72, 20);
  art += box(p, -44, -36, 0, 88, 72, 12, { width: 1.8 });
  const top = facesOf(p, -44, -36, 0, 88, 72, 12).top;
  const tones = ['var(--art-green)', 'var(--art-green)', 'var(--art-amber)', 'var(--art-green)', 'var(--err-line)', 'var(--art-green)', 'var(--art-paper)', 'var(--art-paper)'];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      art += quad(top, 6 + col * 19.5, 6 + row * 20, 17, 18, `fill="${tones[(row * 4 + col) % tones.length]}" ${thin}`);
    }
  }
  return art;
}

/** 临时文件：虚线边框的文件夹。 */
function temp(): string {
  const p = projector(0, 8);
  let art = shadow(p, -44, -30, 88, 60, 20);
  art += box(p, -44, -30, 0, 88, 60, 30, { width: 1.8, top: 'var(--art-amber-soft)' });
  const f = facesOf(p, -44, -30, 0, 88, 60, 30);
  art += quad(f.left, 7, 7, 74, 16, `fill="var(--art-paper)" stroke="var(--art-amber)" stroke-width="1.3" stroke-dasharray="3 2"`);
  for (let i = 0; i < 3; i++) art += quad(f.top, 8 + i * 25, 12, 20, 34, `fill="var(--art-paper)" stroke="${STROKE}" stroke-width="1" stroke-dasharray="3 2"`);
  return art;
}

/** VACUUM：顶面有一个风扇。 */
function vacuum(): string {
  const p = projector(0, 6);
  let art = shadow(p, -38, -38, 76, 76, 22);
  art += box(p, -38, -38, 0, 76, 76, 26, { ...NAVY, width: 1.8 });
  const top = facesOf(p, -38, -38, 0, 76, 76, 26).top;
  const ring = (radius: number) => Array.from({ length: 28 }, (_, i) => top(38 + radius * Math.cos((i / 28) * Math.PI * 2), 38 + radius * Math.sin((i / 28) * Math.PI * 2)));
  art += polygon(ring(30), `fill="var(--art-paper)" ${mid}`);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const at = (r: number, off: number) => top(38 + r * Math.cos(a + off), 38 + r * Math.sin(a + off));
    art += polygon([at(5, 0), at(25, -0.35), at(25, 0.35)], 'fill="var(--art-cyan)" stroke="var(--art-line)" stroke-width="1"');
  }
  return art;
}

/** startup 进程：带电源标记的机箱，崩溃恢复由它执行。 */
function startup(): string {
  const p = projector(0, 6);
  let art = shadow(p, -38, -38, 76, 76, 22);
  art += box(p, -38, -38, 0, 76, 76, 30, { width: 1.9 });
  const f = facesOf(p, -38, -38, 0, 76, 76, 30);
  const ring = (radius: number) => Array.from({ length: 28 }, (_, i) => f.top(38 + radius * Math.cos((i / 28) * Math.PI * 2), 38 + radius * Math.sin((i / 28) * Math.PI * 2)));
  art += polygon(ring(26), `fill="var(--art-green-soft)" ${mid}`);
  art += polyline([f.top(38, 22), f.top(38, 40)], 'stroke="var(--art-green)" stroke-width="4" stroke-linecap="round"');
  art += polyline(Array.from({ length: 16 }, (_, i) => { const a = -Math.PI / 2 + 0.75 + (i / 15) * (2 * Math.PI - 1.5); return f.top(38 + 15 * Math.cos(a), 38 + 15 * Math.sin(a)); }), 'stroke="var(--art-green)" stroke-width="3" stroke-linecap="round"');
  for (let i = 0; i < 3; i++) art += quad(f.left, 8 + i * 20, 10, 15, 8, `fill="${i === 0 ? 'var(--art-green)' : 'var(--art-steel)'}" ${thin}`);
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
  client: { art: terminal('var(--art-navy)'), radius: 62, labelY: 60 },
  client2: { art: terminal('var(--art-teal)'), radius: 62, labelY: 60 },
  backend: { art: backend('PG'), radius: 62, labelY: 58 },
  backend2: { art: backend('PG', 'var(--art-amber)'), radius: 62, labelY: 58 },
  backend3: { art: backend('PG', 'var(--art-green)'), radius: 62, labelY: 58 },
  parser: { art: parser(), radius: 56, labelY: 50 },
  catalog: { art: catalog(), radius: 56, labelY: 54 },
  planner: { art: planner(), radius: 60, labelY: 54 },
  executor: { art: executor(), radius: 60, labelY: 52 },
  buffer: { art: buffer(), radius: 62, labelY: 56 },
  heap: { art: heap('var(--art-navy)'), radius: 56, labelY: 52 },
  heap2: { art: heap('var(--art-teal)'), radius: 56, labelY: 52 },
  btree: { art: btree(), radius: 56, labelY: 52 },
  wal: { art: wal(), radius: 54, labelY: 54 },
  disk: { art: disk(), radius: 54, labelY: 58 },
  lock: { art: lock(), radius: 54, labelY: 50 },
  bgwriter: { art: bgwriter(), radius: 56, labelY: 52 },
  clog: { art: clog(), radius: 56, labelY: 50 },
  temp: { art: temp(), radius: 56, labelY: 52 },
  vacuum: { art: vacuum(), radius: 56, labelY: 52 },
  startup: { art: startup(), radius: 56, labelY: 52 },
};
