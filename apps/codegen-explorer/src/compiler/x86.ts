/** x86-64 指令编码器。依据 Intel SDM 第 2 卷，字节选择和 LLVM MC 一致，由测试逐字节对照 clang。 */

export const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
export const REG64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];

export const RAX = 0, RCX = 1, RDX = 2, RBX = 3, RSP = 4, RBP = 5, RSI = 6, RDI = 7, R8 = 8, R9 = 9, R10 = 10, R11 = 11, R12 = 12, R13 = 13, R14 = 14, R15 = 15;

export interface R { n: number; wide: boolean }
export const r32 = (n: number): R => ({ n, wide: false });
export const r64 = (n: number): R => ({ n, wide: true });
export const regName = (r: R) => (r.wide ? REG64 : REG32)[r.n];

export interface Mem {
  /** 'rip' 是 RIP 相对寻址，配合 sym 产生重定位。 */
  base: number | 'rip';
  index?: number;
  scale?: 1 | 2 | 4 | 8;
  disp?: number;
  sym?: string;
  wide?: boolean;
}
export interface Imm { imm: number }

const isMem = (operand: R | Mem | Imm): operand is Mem => 'base' in operand;
const isImm = (operand: R | Mem | Imm): operand is Imm => 'imm' in operand;

export type Cond = 'l' | 'le' | 'g' | 'ge' | 'e' | 'ne';
const CC: Record<Cond, number> = { e: 0x4, ne: 0x5, l: 0xc, ge: 0xd, le: 0xe, g: 0xf };
export const invertCond = (cc: Cond): Cond => ({ l: 'ge', ge: 'l', le: 'g', g: 'le', e: 'ne', ne: 'e' } as const)[cc];

export type Alu = 'add' | 'or' | 'and' | 'sub' | 'xor' | 'cmp';

export type Ins =
  | { m: 'push' | 'pop'; r: R }
  | { m: Alu; d: R | Mem; s: R | Mem | Imm }
  | { m: 'mov'; d: R | Mem; s: R | Mem | Imm }
  | { m: 'test'; d: R; s: R }
  | { m: 'imul'; d: R; s: R | Mem; imm?: number }
  | { m: 'lea'; d: R; s: Mem }
  | { m: 'neg'; d: R }
  | { m: 'call'; sym: string }
  | { m: 'jmp'; label: string }
  | { m: 'jcc'; cc: Cond; label: string }
  | { m: 'ret' };

export type PartKind = 'rex' | 'opcode' | 'modrm' | 'sib' | 'disp' | 'imm' | 'rel';

export interface Part { kind: PartKind; from: number; to: number }

export interface RelocNeed { offset: number; sym: string; type: 'R_X86_64_PC32' | 'R_X86_64_PLT32'; addend: number }

export interface Encoded {
  bytes: number[];
  parts: Part[];
  rex: { w: number; r: number; x: number; b: number } | null;
  modrm: { mod: number; reg: number; rm: number; regExt: boolean } | null;
  sib: { scale: number; index: number; base: number } | null;
  reloc: RelocNeed | null;
  /** 跳转的 rel 字段宽度，0 表示这条指令不是相对跳转。 */
  relSize: 0 | 1 | 4;
}

const ALU_INDEX: Record<Alu, number> = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };
const fitsI8 = (value: number) => value >= -128 && value <= 127;

class Out {
  bytes: number[] = [];
  parts: Part[] = [];
  rex: Encoded['rex'] = null;
  modrm: Encoded['modrm'] = null;
  sib: Encoded['sib'] = null;
  reloc: RelocNeed | null = null;
  relSize: 0 | 1 | 4 = 0;

  part(kind: PartKind, data: number[]): void {
    const from = this.bytes.length;
    this.bytes.push(...data.map((byte) => byte & 0xff));
    this.parts.push({ kind, from, to: this.bytes.length });
  }

  /** REX 只在需要时出现：64 位操作数或用到 r8–r15。 */
  emitRex(w: boolean, reg: number, index: number, rm: number): void {
    const r = reg >> 3;
    const x = index >> 3;
    const b = rm >> 3;
    if (!w && !r && !x && !b) return;
    this.rex = { w: w ? 1 : 0, r, x, b };
    this.part('rex', [0x40 | ((w ? 1 : 0) << 3) | (r << 2) | (x << 1) | b]);
  }

  emitModrm(mod: number, reg: number, rm: number, regExt: boolean): void {
    this.modrm = { mod, reg: reg & 7, rm: rm & 7, regExt };
    this.part('modrm', [(mod << 6) | ((reg & 7) << 3) | (rm & 7)]);
  }

  /** 写 ModRM、可选的 SIB 和位移。reg 可能是寄存器号，也可能是 opcode 扩展。 */
  operand(reg: number, rm: R | Mem, regExt: boolean, trailing: number): void {
    if (!isMem(rm)) {
      this.emitModrm(3, reg, rm.n, regExt);
      return;
    }
    if (rm.base === 'rip') {
      this.emitModrm(0, reg, 5, regExt);
      const at = this.bytes.length;
      this.part('disp', [0, 0, 0, 0]);
      if (rm.sym) this.reloc = { offset: at, sym: rm.sym, type: 'R_X86_64_PC32', addend: -4 - trailing };
      return;
    }
    const disp = rm.disp ?? 0;
    const base = rm.base;
    const needSib = rm.index !== undefined || (base & 7) === 4;
    // rbp 和 r13 的 mod=00 表示别的寻址方式，所以位移为 0 也要写一个 disp8。
    const mod = disp === 0 && (base & 7) !== 5 ? 0 : fitsI8(disp) ? 1 : 2;
    this.emitModrm(mod, reg, needSib ? 4 : base, regExt);
    if (needSib) {
      const scaleBits = { 1: 0, 2: 1, 4: 2, 8: 3 }[rm.scale ?? 1]!;
      const index = rm.index ?? 4;
      this.sib = { scale: scaleBits, index: index & 7, base: base & 7 };
      this.part('sib', [(scaleBits << 6) | ((index & 7) << 3) | (base & 7)]);
    }
    if (mod === 1) this.part('disp', [disp]);
    if (mod === 2) this.part('disp', [disp, disp >> 8, disp >> 16, disp >> 24]);
  }
}

const le32 = (value: number) => [value, value >> 8, value >> 16, value >> 24];

const memIndex = (operand: Mem) => operand.index ?? 0;
const memBase = (operand: Mem) => (operand.base === 'rip' ? 0 : operand.base);

/** long 只影响 jmp 和 jcc：false 用 rel8，true 用 rel32。rel 字段先写 0，由汇编器回填。 */
export function encode(ins: Ins, long = false): Encoded {
  const out = new Out();
  const rexFor = (wide: boolean, reg: number, rm: R | Mem) => out.emitRex(wide, reg, isMem(rm) ? memIndex(rm) : 0, isMem(rm) ? memBase(rm) : rm.n);
  switch (ins.m) {
    case 'push':
    case 'pop':
      out.emitRex(false, 0, 0, ins.r.n);
      out.part('opcode', [(ins.m === 'push' ? 0x50 : 0x58) + (ins.r.n & 7)]);
      break;
    case 'ret':
      out.part('opcode', [0xc3]);
      break;
    case 'call': {
      out.part('opcode', [0xe8]);
      const at = out.bytes.length;
      out.part('rel', [0, 0, 0, 0]);
      out.reloc = { offset: at, sym: ins.sym, type: 'R_X86_64_PLT32', addend: -4 };
      break;
    }
    case 'jmp':
      out.part('opcode', [long ? 0xe9 : 0xeb]);
      out.part('rel', long ? [0, 0, 0, 0] : [0]);
      out.relSize = long ? 4 : 1;
      break;
    case 'jcc':
      out.part('opcode', long ? [0x0f, 0x80 + CC[ins.cc]] : [0x70 + CC[ins.cc]]);
      out.part('rel', long ? [0, 0, 0, 0] : [0]);
      out.relSize = long ? 4 : 1;
      break;
    case 'neg':
      out.emitRex(ins.d.wide, 0, 0, ins.d.n);
      out.part('opcode', [0xf7]);
      out.operand(3, ins.d, true, 0);
      break;
    case 'test':
      rexFor(ins.d.wide || ins.s.wide, ins.s.n, ins.d);
      out.part('opcode', [0x85]);
      out.operand(ins.s.n, ins.d, false, 0);
      break;
    case 'lea':
      out.emitRex(ins.d.wide, ins.d.n, memIndex(ins.s), memBase(ins.s));
      out.part('opcode', [0x8d]);
      out.operand(ins.d.n, ins.s, false, 0);
      break;
    case 'imul': {
      const wide = ins.d.wide;
      rexFor(wide, ins.d.n, ins.s);
      if (ins.imm === undefined) {
        out.part('opcode', [0x0f, 0xaf]);
        out.operand(ins.d.n, ins.s, false, 0);
      } else if (fitsI8(ins.imm)) {
        out.part('opcode', [0x6b]);
        out.operand(ins.d.n, ins.s, false, 1);
        out.part('imm', [ins.imm]);
      } else {
        out.part('opcode', [0x69]);
        out.operand(ins.d.n, ins.s, false, 4);
        out.part('imm', le32(ins.imm));
      }
      break;
    }
    case 'mov': {
      const { d, s } = ins;
      if (isImm(s)) {
        if (isMem(d)) {
          rexFor(Boolean(d.wide), 0, d);
          out.part('opcode', [0xc7]);
          out.operand(0, d, true, 4);
          out.part('imm', le32(s.imm));
        } else if (d.wide) {
          rexFor(true, 0, d);
          out.part('opcode', [0xc7]);
          out.operand(0, d, true, 4);
          out.part('imm', le32(s.imm));
        } else {
          out.emitRex(false, 0, 0, d.n);
          out.part('opcode', [0xb8 + (d.n & 7)]);
          out.part('imm', le32(s.imm));
        }
      } else if (isMem(s)) {
        const dest = d as R;
        rexFor(dest.wide, dest.n, s);
        out.part('opcode', [0x8b]);
        out.operand(dest.n, s, false, 0);
      } else {
        const wide = isMem(d) ? s.wide : d.wide;
        rexFor(wide, s.n, d);
        out.part('opcode', [0x89]);
        out.operand(s.n, d, false, 0);
      }
      break;
    }
    default: {
      const { d, s } = ins;
      const index = ALU_INDEX[ins.m];
      const wide = isMem(d) ? Boolean(d.wide) || (!isImm(s) && !isMem(s) && s.wide) : d.wide;
      if (isImm(s)) {
        if (fitsI8(s.imm)) {
          rexFor(wide, 0, d);
          out.part('opcode', [0x83]);
          out.operand(index, d, true, 1);
          out.part('imm', [s.imm]);
        } else if (!isMem(d) && d.n === RAX) {
          // eax/rax 有更短的专用编码，LLVM 也选这种。
          out.emitRex(wide, 0, 0, 0);
          out.part('opcode', [(index << 3) | 5]);
          out.part('imm', le32(s.imm));
        } else {
          rexFor(wide, 0, d);
          out.part('opcode', [0x81]);
          out.operand(index, d, true, 4);
          out.part('imm', le32(s.imm));
        }
      } else if (isMem(s)) {
        const dest = d as R;
        rexFor(dest.wide, dest.n, s);
        out.part('opcode', [(index << 3) | 3]);
        out.operand(dest.n, s, false, 0);
      } else {
        rexFor(wide, s.n, d);
        out.part('opcode', [(index << 3) | 1]);
        out.operand(s.n, d, false, 0);
      }
    }
  }
  return { bytes: out.bytes, parts: out.parts, rex: out.rex, modrm: out.modrm, sib: out.sib, reloc: out.reloc, relSize: out.relSize };
}

function fmtMem(mem: Mem, sized: boolean): string {
  const size = sized ? (mem.wide ? 'qword ptr ' : 'dword ptr ') : '';
  if (mem.base === 'rip') return `${size}[rip + ${mem.sym}]`;
  let inner = REG64[mem.base];
  if (mem.index !== undefined) inner += ` + ${mem.scale && mem.scale > 1 ? `${mem.scale}*` : ''}${REG64[mem.index]}`;
  const disp = mem.disp ?? 0;
  if (disp > 0) inner += ` + ${disp}`;
  if (disp < 0) inner += ` - ${-disp}`;
  return `${size}[${inner}]`;
}

function fmtArg(operand: R | Mem | Imm): string {
  if (isImm(operand)) return String(operand.imm);
  if (isMem(operand)) return fmtMem(operand, true);
  return regName(operand);
}

/** Intel 语法，和 clang -masm=intel 的写法相同，可以直接汇编。 */
export function fmtIns(ins: Ins, flavor: 'elf' | 'macho' = 'elf'): string {
  const fix = flavor === 'macho' ? (text: string) => text.replace(/\[rip \+ (\w+)\]/, '[rip + _$1]') : (text: string) => text;
  switch (ins.m) {
    case 'push': case 'pop': return `${ins.m} ${regName(ins.r)}`;
    case 'ret': return 'ret';
    case 'call': return flavor === 'macho' ? `call _${ins.sym}` : `call ${ins.sym}@PLT`;
    case 'jmp': return `jmp ${flavor === 'macho' ? ins.label.replace(/^\./, '') : ins.label}`;
    case 'jcc': return `j${ins.cc} ${flavor === 'macho' ? ins.label.replace(/^\./, '') : ins.label}`;
    case 'neg': return `neg ${regName(ins.d)}`;
    case 'test': return `test ${regName(ins.d)}, ${regName(ins.s)}`;
    case 'lea': return `lea ${regName(ins.d)}, ${fmtMem(ins.s, false)}`;
    case 'imul': return `imul ${regName(ins.d)}, ${fix(fmtArg(ins.s))}${ins.imm === undefined ? '' : `, ${ins.imm}`}`;
    default: return `${ins.m} ${fix(fmtArg(ins.d))}, ${fix(fmtArg(ins.s))}`;
  }
}
