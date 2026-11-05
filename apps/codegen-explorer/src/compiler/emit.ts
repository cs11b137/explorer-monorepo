/** 帧布局、把 MIR 改写成真实指令、回填跳转，并输出汇编文本。 */
import { encode, fmtIns, r32, r64, R10, R11, RBP, RSP, type Encoded, type Ins, type Mem, type R } from './x86';
import { fmtMInst, type MFunc, type MInst, type MOperand } from './isel';
import { analyze, linearScan, type Allocation, type Analysis } from './regalloc';

export type LineGroup = 'prologue' | 'body' | 'epilogue';

export interface AsmLine {
  ins: Ins;
  group: LineGroup;
  block: string;
  /** 对应的 MIR 文本，序言和尾声没有。 */
  mir: string | null;
  /** 落在这条指令上的标签。空块的标签会顺延到下一条指令。 */
  labels: string[];
}

export interface FrameInfo {
  callee: number[];
  /** sub rsp 的字节数：溢出槽加对齐填充。 */
  localBytes: number;
  padding: number;
  spillSlots: Map<string, number>;
  hasCall: boolean;
}

export interface LoweredFunc { name: string; lines: AsmLine[]; frame: FrameInfo }

/** 改写一条 MIR。三地址的 add 在这里才定 add 还是 lea，因为要看分配结果。 */
export function lower(mf: MFunc, allocation: Allocation): LoweredFunc {
  const { assign, spilled, usedCallee } = allocation;
  const spillSlots = new Map<string, number>();
  spilled.forEach((name, index) => spillSlots.set(name, -(8 * usedCallee.length + 4 * (index + 1))));
  const spillBytes = spilled.length ? 4 * spilled.length : 0;
  // 进入函数时 rsp ≡ 8 (mod 16)。push rbp 和每个 push 各 8 字节，有调用时补齐到 16 的倍数。
  const pushed = 8 + 8 + 8 * usedCallee.length;
  const rounded = spillBytes % 8 ? spillBytes + (8 - (spillBytes % 8)) : spillBytes;
  const padding = mf.hasCall || rounded ? (16 - ((pushed + rounded) % 16)) % 16 : 0;
  const localBytes = rounded + padding;

  const lines: AsmLine[] = [];
  const add = (ins: Ins, group: LineGroup, block: string, mir: string | null, labels: string[] = []) => lines.push({ ins, group, block, mir, labels });
  const first = mf.blocks[0].name;
  add({ m: 'push', r: r64(RBP) }, 'prologue', first, null);
  add({ m: 'mov', d: r64(RBP), s: r64(RSP) }, 'prologue', first, null);
  usedCallee.forEach((reg) => add({ m: 'push', r: r64(reg) }, 'prologue', first, null));
  if (localBytes) add({ m: 'sub', d: r64(RSP), s: { imm: localBytes } }, 'prologue', first, null);

  const slotOf = (name: string): Mem => ({ base: RBP, disp: spillSlots.get(name)! });
  const isSpilled = (operand: MOperand) => operand.k === 'v' && spillSlots.has(operand.name);
  const regOf = (operand: MOperand): R => {
    if (operand.k === 'p') return r32(operand.n);
    if (operand.k === 'v') {
      const reg = assign.get(operand.name);
      if (reg === undefined) throw new Error(`${operand.name} 没有寄存器`);
      return r32(reg);
    }
    throw new Error('立即数不能当寄存器');
  };

  let pending: string[] = [];
  for (const block of mf.blocks) {
    if (block !== mf.blocks[0]) pending.push(block.label);
    const put = (ins: Ins, mir: string) => {
      add(ins, 'body', block.name, mir, pending);
      pending = [];
    };
    for (const inst of block.insts) {
      const mir = fmtMInst(inst);
      /** 溢出的操作数先读进 r10/r11，写操作数最后写回内存。 */
      const scratch = [R11, R10];
      const read = (operand: MOperand): R => {
        if (!isSpilled(operand)) return regOf(operand);
        const temp = r32(scratch.shift()!);
        put({ m: 'mov', d: temp, s: slotOf((operand as { name: string }).name) }, mir);
        return temp;
      };
      const argOf = (operand: MOperand): R | { imm: number } => (operand.k === 'imm' ? { imm: operand.value } : read(operand));
      const dest = (operand: MOperand): R => (isSpilled(operand) ? r32(R11) : regOf(operand));
      const commit = (operand: MOperand, reg: R) => {
        if (isSpilled(operand)) put({ m: 'mov', d: slotOf((operand as { name: string }).name), s: reg }, mir);
      };
      lowerOne(inst, { put: (ins) => put(ins, mir), read, argOf, dest, commit });
    }
  }

  // RET 之前插入尾声。
  const out: AsmLine[] = [];
  for (const line of lines) {
    if (line.ins.m === 'ret') {
      let labels = line.labels;
      const put = (ins: Ins) => {
        out.push({ ins, group: 'epilogue', block: line.block, mir: null, labels });
        labels = [];
      };
      if (localBytes) put({ m: 'add', d: r64(RSP), s: { imm: localBytes } });
      [...usedCallee].reverse().forEach((reg) => put({ m: 'pop', r: r64(reg) }));
      put({ m: 'pop', r: r64(RBP) });
      put({ m: 'ret' });
    } else out.push(line);
  }
  return { name: mf.name, lines: out, frame: { callee: usedCallee, localBytes, padding, spillSlots, hasCall: mf.hasCall } };
}

interface Ctx {
  put(ins: Ins): void;
  read(operand: MOperand): R;
  argOf(operand: MOperand): R | { imm: number };
  dest(operand: MOperand): R;
  commit(operand: MOperand, reg: R): void;
}

function lowerOne(inst: MInst, c: Ctx): void {
  switch (inst.op) {
    case 'copy': {
      const d = c.dest(inst.d);
      if (inst.s.k === 'imm') {
        // 清零用 xor 比 mov 短 3 字节。这里还没有比较，不用担心改写标志位。
        if (inst.s.value === 0) c.put({ m: 'xor', d, s: d });
        else c.put({ m: 'mov', d, s: { imm: inst.s.value } });
      } else {
        const s = c.read(inst.s);
        if (s.n !== d.n) c.put({ m: 'mov', d, s });
      }
      c.commit(inst.d, d);
      return;
    }
    case 'add3': {
      const a = c.read(inst.a);
      const b = c.argOf(inst.b);
      const d = c.dest(inst.d);
      if ('imm' in b) {
        if (d.n === a.n) c.put({ m: 'add', d, s: b });
        else c.put({ m: 'lea', d, s: { base: a.n, disp: b.imm } });
      } else if (d.n === a.n) c.put({ m: 'add', d, s: b });
      else if (d.n === b.n) c.put({ m: 'add', d, s: a });
      else c.put({ m: 'lea', d, s: { base: a.n, index: b.n } });
      c.commit(inst.d, d);
      return;
    }
    case 'sub3': {
      const a = c.read(inst.a);
      const b = c.argOf(inst.b);
      const d = c.dest(inst.d);
      if ('imm' in b) {
        if (d.n !== a.n) c.put({ m: 'mov', d, s: a });
        c.put({ m: 'sub', d, s: b });
      } else if (d.n === b.n) {
        // d = a − d：先取负再加 a。
        c.put({ m: 'neg', d });
        c.put({ m: 'add', d, s: a });
      } else {
        if (d.n !== a.n) c.put({ m: 'mov', d, s: a });
        c.put({ m: 'sub', d, s: b });
      }
      c.commit(inst.d, d);
      return;
    }
    case 'imul3': {
      const a = c.read(inst.a);
      const b = c.argOf(inst.b);
      const d = c.dest(inst.d);
      if ('imm' in b) c.put({ m: 'imul', d, s: a, imm: b.imm });
      else if (d.n === a.n) c.put({ m: 'imul', d, s: b });
      else if (d.n === b.n) c.put({ m: 'imul', d, s: a });
      else {
        c.put({ m: 'mov', d, s: a });
        c.put({ m: 'imul', d, s: b });
      }
      c.commit(inst.d, d);
      return;
    }
    case 'cmp': {
      const a = c.read(inst.a);
      c.put({ m: 'cmp', d: a, s: c.argOf(inst.b) });
      return;
    }
    case 'jcc':
      c.put({ m: 'jcc', cc: inst.cc, label: inst.label });
      return;
    case 'jmp':
      c.put({ m: 'jmp', label: inst.label });
      return;
    case 'loadg': {
      const d = c.dest(inst.d);
      c.put({ m: 'mov', d, s: { base: 'rip', sym: inst.sym } });
      c.commit(inst.d, d);
      return;
    }
    case 'storeg':
      c.put({ m: 'mov', d: { base: 'rip', sym: inst.sym }, s: inst.s.k === 'imm' ? { imm: inst.s.value } : c.read(inst.s) });
      return;
    case 'call':
      c.put({ m: 'call', sym: inst.fn });
      return;
    case 'ret':
      c.put({ m: 'ret' });
      return;
  }
}

export interface Reloc { offset: number; sym: string; type: 'R_X86_64_PC32' | 'R_X86_64_PLT32'; addend: number }

export interface PlacedLine extends AsmLine {
  text: string;
  offset: number;
  enc: Encoded;
  /** 相对跳转的目标偏移和位移值。 */
  jump: { target: number; rel: number } | null;
  reloc: Reloc | null;
}

export interface Assembled {
  name: string;
  lines: PlacedLine[];
  bytes: number[];
  relocs: Reloc[];
  labels: Map<string, number>;
  /** 跳转从 rel8 放宽到 rel32 的迭代次数。 */
  relaxRounds: number;
}

/** 从都用 rel8 开始，装不下的才放宽成 rel32，反复到稳定。和汇编器的做法一样。 */
export function assemble(fn: LoweredFunc, baseOffset = 0): Assembled {
  const long = new Set<number>();
  let rounds = 0;
  const encodeAll = () => fn.lines.map((line, index) => encode(line.ins, long.has(index)));
  for (;;) {
    rounds++;
    const encoded = encodeAll();
    const offsets: number[] = [];
    const labels = new Map<string, number>();
    let at = 0;
    encoded.forEach((enc, index) => {
      offsets.push(at);
      fn.lines[index].labels.forEach((label) => labels.set(label, at));
      at += enc.bytes.length;
    });
    let grew = false;
    fn.lines.forEach((line, index) => {
      if ((line.ins.m === 'jmp' || line.ins.m === 'jcc') && !long.has(index)) {
        const rel = labels.get(line.ins.label)! - (offsets[index] + encoded[index].bytes.length);
        if (rel < -128 || rel > 127) {
          long.add(index);
          grew = true;
        }
      }
    });
    if (grew) continue;
    const bytes: number[] = [];
    const relocs: Reloc[] = [];
    const lines: PlacedLine[] = fn.lines.map((line, index) => {
      const enc = encoded[index];
      const offset = offsets[index] + baseOffset;
      const data = [...enc.bytes];
      let jump: PlacedLine['jump'] = null;
      let reloc: Reloc | null = null;
      if (line.ins.m === 'jmp' || line.ins.m === 'jcc') {
        const end = offsets[index] + enc.bytes.length;
        const target = labels.get(line.ins.label)!;
        const rel = target - end;
        for (let byte = 0; byte < enc.relSize; byte++) data[data.length - enc.relSize + byte] = (rel >> (8 * byte)) & 0xff;
        jump = { target: target + baseOffset, rel };
      }
      if (enc.reloc) {
        reloc = { offset: offset + enc.reloc.offset, sym: enc.reloc.sym, type: enc.reloc.type, addend: enc.reloc.addend };
        relocs.push(reloc);
      }
      bytes.push(...data);
      return { ...line, text: fmtIns(line.ins), offset, enc: { ...enc, bytes: data }, jump, reloc };
    });
    return { name: fn.name, lines, bytes, relocs, labels, relaxRounds: rounds };
  }
}

export interface BackendResult {
  analysis: Analysis;
  allocation: Allocation;
  lowered: LoweredFunc;
  assembled: Assembled;
}

export function backend(mf: MFunc, baseOffset = 0): BackendResult {
  const analysis = analyze(mf);
  const allocation = linearScan(analysis);
  const lowered = lower(mf, allocation);
  return { analysis, allocation, lowered, assembled: assemble(lowered, baseOffset) };
}

/** 整个模块的汇编文本。macho 只用于在本机经 Rosetta 真实运行，核对语义。 */
export function asmText(funcs: LoweredFunc[], globals: string[], flavor: 'elf' | 'macho' = 'elf'): string {
  const out: string[] = ['\t.intel_syntax noprefix', '\t.text'];
  const sym = (name: string) => (flavor === 'macho' ? `_${name}` : name);
  const label = (name: string) => (flavor === 'macho' ? name.replace(/^\./, '') : name);
  for (const fn of funcs) {
    out.push(`\t.globl ${sym(fn.name)}`);
    out.push('\t.p2align 4, 0x90');
    if (flavor === 'elf') out.push(`\t.type ${fn.name},@function`);
    out.push(`${sym(fn.name)}:`);
    for (const line of fn.lines) {
      line.labels.forEach((name) => out.push(`${label(name)}:`));
      out.push(`\t${fmtIns(line.ins, flavor)}`);
    }
    if (flavor === 'elf') out.push(`\t.size ${fn.name}, .-${fn.name}`);
  }
  if (globals.length && flavor === 'elf') {
    out.push('\t.bss');
    for (const name of globals) out.push(`\t.globl ${name}`, `\t.type ${name},@object`, `\t.size ${name},4`, '\t.p2align 2', `${name}:`, '\t.zero 4');
  }
  if (globals.length && flavor === 'macho') {
    for (const name of globals) out.push(`\t.globl _${name}`, `.zerofill __DATA,__bss,_${name},4,2`);
  }
  if (flavor === 'elf') out.push('\t.section .note.GNU-stack,"",@progbits');
  return `${out.join('\n')}\n`;
}

