/** 编码器的对照矩阵：覆盖 REX 各位、ModRM 三种 mod、SIB、RIP 相对和各种立即数宽度。 */
import { r32, r64, type Alu, type Ins, type Mem } from '../../src/compiler/x86';

const REGS = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const SAMPLE = [0, 3, 5, 7, 8, 12, 13, 15];
const ALUS: Alu[] = ['add', 'or', 'and', 'sub', 'xor', 'cmp'];

const MEMS: Mem[] = [
  { base: 0 }, { base: 5 }, { base: 13 }, { base: 4 }, { base: 12 },
  { base: 5, disp: -4 }, { base: 3, disp: 127 }, { base: 3, disp: 128 }, { base: 3, disp: -129 }, { base: 12, disp: 8 }, { base: 13, disp: 300 },
  { base: 7, index: 1 }, { base: 0, index: 8, scale: 2 }, { base: 5, index: 9, scale: 4 }, { base: 13, index: 3, scale: 8, disp: 16 }, { base: 4, index: 15 }, { base: 12, index: 5, disp: -1000 },
  { base: 'rip', sym: 'total' },
];

export const ENCODER_MATRIX: Ins[] = [
  { m: 'ret' },
  { m: 'call', sym: 'scale' },
  ...REGS.flatMap((n): Ins[] => [{ m: 'push', r: r64(n) }, { m: 'pop', r: r64(n) }]),
  { m: 'push', r: r64(4) },
  { m: 'pop', r: r64(4) },
  ...SAMPLE.flatMap((d) => SAMPLE.flatMap((s): Ins[] => [
    { m: 'mov', d: r32(d), s: r32(s) },
    { m: 'mov', d: r64(d), s: r64(s) },
    { m: 'imul', d: r32(d), s: r32(s) },
    { m: 'imul', d: r32(d), s: r32(s), imm: 6 },
    { m: 'imul', d: r32(d), s: r32(s), imm: 1000 },
    { m: 'test', d: r32(d), s: r32(s) },
    { m: 'lea', d: r32(d), s: { base: s, disp: 1 } },
    ...(s === 4 ? [] : [{ m: 'lea', d: r32(d), s: { base: d, index: s } } as Ins]),
    ...ALUS.flatMap((op): Ins[] => [{ m: op, d: r32(d), s: r32(s) }]),
    { m: 'add', d: r64(d), s: r64(s) },
  ])),
  ...REGS.flatMap((n) => [0, 1, -1, 127, 128, -128, -129, 100000].flatMap((imm): Ins[] => [
    { m: 'mov', d: r32(n), s: { imm } },
    { m: 'mov', d: r64(n), s: { imm } },
    ...ALUS.flatMap((op): Ins[] => [{ m: op, d: r32(n), s: { imm } }, { m: op, d: r64(n), s: { imm } }]),
  ])),
  { m: 'sub', d: r64(4), s: { imm: 8 } },
  { m: 'add', d: r64(4), s: { imm: 32 } },
  ...REGS.flatMap((n): Ins[] => [{ m: 'neg', d: r32(n) }, { m: 'neg', d: r64(n) }]),
  ...MEMS.flatMap((mem) => [1, 8].flatMap((n): Ins[] => [
    { m: 'mov', d: r32(n), s: mem },
    { m: 'mov', d: mem, s: r32(n) },
    { m: 'mov', d: r64(n), s: { ...mem, wide: true } },
    { m: 'mov', d: { ...mem, wide: true }, s: r64(n) },
    { m: 'lea', d: r32(n), s: mem },
    { m: 'lea', d: r64(n), s: mem },
    { m: 'imul', d: r32(n), s: mem },
    { m: 'imul', d: r32(n), s: mem, imm: 3 },
    { m: 'imul', d: r32(n), s: mem, imm: 500 },
    ...ALUS.flatMap((op): Ins[] => [{ m: op, d: r32(n), s: mem }, { m: op, d: mem, s: r32(n) }]),
  ])),
  ...MEMS.flatMap((mem): Ins[] => [
    { m: 'mov', d: mem, s: { imm: 2 } },
    ...ALUS.flatMap((op): Ins[] => [{ m: op, d: mem, s: { imm: 2 } }, { m: op, d: mem, s: { imm: 1000 } }]),
  ]),
];
