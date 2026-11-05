/** 指令选择：消去 φ，把 IR 映射成带虚拟寄存器的机器指令（MIR）。 */
import { fmtInst, operandsOf, predecessors, slotNames, successors, type Inst, type IrFunc, type Operand } from './ir';
import { REG32, RDI, RSI, RDX, RCX, R8, R9, RAX, type Cond } from './x86';

export type MOperand = { k: 'v'; name: string } | { k: 'p'; n: number } | { k: 'imm'; value: number };

export const V = (name: string): MOperand => ({ k: 'v', name });
export const P = (n: number): MOperand => ({ k: 'p', n });
export const I = (value: number): MOperand => ({ k: 'imm', value });

export type MInst =
  | { op: 'copy'; d: MOperand; s: MOperand; why: 'arg' | 'ret' | 'phi' | 'argset' | 'retval' }
  | { op: 'add3' | 'sub3' | 'imul3'; d: MOperand; a: MOperand; b: MOperand }
  | { op: 'cmp'; a: MOperand; b: MOperand }
  | { op: 'jcc'; cc: Cond; label: string }
  | { op: 'jmp'; label: string }
  | { op: 'loadg'; d: MOperand; sym: string }
  | { op: 'storeg'; s: MOperand; sym: string }
  | { op: 'call'; fn: string; argRegs: number[] }
  | { op: 'ret' };

export interface MBlock { name: string; label: string; insts: MInst[] }

export interface SelectEvent { block: string; ir: string; rule: string; mir: string[] }

export interface PhiCopy { from: string; to: string; dst: string; src: string }

export interface MFunc {
  name: string;
  blocks: MBlock[];
  events: SelectEvent[];
  phiCopies: PhiCopy[];
  hasCall: boolean;
}

export const ARG_REGS = [RDI, RSI, RDX, RCX, R8, R9];

const fmtM = (operand: MOperand) => (operand.k === 'v' ? `%${operand.name}` : operand.k === 'p' ? `$${REG32[operand.n]}` : String(operand.value));

/** MIR 的文本形式，虚拟寄存器写成 %名字，物理寄存器写成 $名字。 */
export function fmtMInst(inst: MInst): string {
  switch (inst.op) {
    case 'copy': return `COPY ${fmtM(inst.d)}, ${fmtM(inst.s)}`;
    case 'add3': return `ADD ${fmtM(inst.d)}, ${fmtM(inst.a)}, ${fmtM(inst.b)}`;
    case 'sub3': return `SUB ${fmtM(inst.d)}, ${fmtM(inst.a)}, ${fmtM(inst.b)}`;
    case 'imul3': return `IMUL ${fmtM(inst.d)}, ${fmtM(inst.a)}, ${fmtM(inst.b)}`;
    case 'cmp': return `CMP ${fmtM(inst.a)}, ${fmtM(inst.b)}`;
    case 'jcc': return `J${inst.cc.toUpperCase()} ${inst.label}`;
    case 'jmp': return `JMP ${inst.label}`;
    case 'loadg': return `LOAD ${fmtM(inst.d)}, @${inst.sym}`;
    case 'storeg': return `STORE @${inst.sym}, ${fmtM(inst.s)}`;
    case 'call': return `CALL @${inst.fn}`;
    case 'ret': return 'RET';
  }
}

const COND: Record<string, Cond> = { slt: 'l', sle: 'le', sgt: 'g', sge: 'ge', eq: 'e', ne: 'ne' };
const INVERT: Record<Cond, Cond> = { l: 'ge', ge: 'l', le: 'g', g: 'le', e: 'ne', ne: 'e' };

/** 把临界边拆开：φ 的复制只能放在只通向它的块里。 */
function splitCritical(fn: IrFunc): void {
  let next = 0;
  for (const block of [...fn.blocks]) {
    const last = block.insts[block.insts.length - 1];
    if (last?.op !== 'condbr') continue;
    const preds = predecessors(fn);
    for (const side of ['yes', 'no'] as const) {
      const target = last[side];
      const targetBlock = fn.blocks.find((item) => item.name === target)!;
      if (preds.get(target)!.length < 2 || !targetBlock.insts.some((inst) => inst.op === 'phi')) continue;
      const name = `crit.${next++}`;
      fn.blocks.splice(fn.blocks.indexOf(block) + 1, 0, { name, insts: [{ op: 'br', target }] });
      last[side] = name;
      for (const inst of targetBlock.insts) {
        if (inst.op === 'phi') inst.incoming = inst.incoming.map(([value, from]) => [value, from === block.name ? name : from]);
      }
    }
  }
}

/** 并行复制排成串行：先做目标不再被读的；只剩环时借一个临时虚拟寄存器。 */
export function sequentialize(copies: Array<{ d: string; s: MOperand }>, temp: () => string): Array<{ d: string; s: MOperand }> {
  const pending = copies.filter((copy) => !(copy.s.k === 'v' && copy.s.name === copy.d));
  const out: Array<{ d: string; s: MOperand }> = [];
  while (pending.length) {
    const ready = pending.findIndex((copy) => !pending.some((other) => other !== copy && other.s.k === 'v' && other.s.name === copy.d));
    if (ready >= 0) {
      out.push(pending.splice(ready, 1)[0]);
      continue;
    }
    const first = pending[0];
    const name = temp();
    out.push({ d: name, s: V(first.d) });
    for (const copy of pending) if (copy.s.k === 'v' && copy.s.name === first.d) copy.s = V(name);
  }
  return out;
}

export function select(input: IrFunc): MFunc {
  const fn: IrFunc = structuredClone(input);
  splitCritical(fn);
  const slots = slotNames(fn);
  const display = (name: string) => slots.get(name) ?? name;
  const labelOf = new Map(fn.blocks.map((block, index) => [block.name, `.L${fn.name}_${index}`]));
  const events: SelectEvent[] = [];
  const phiCopies: PhiCopy[] = [];
  const blocks: MBlock[] = [];
  let temps = 0;
  let hasCall = false;
  const useCount = new Map<string, number>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      for (const operand of operandsOf(inst)) if (operand.k === 'reg') useCount.set(operand.name, (useCount.get(operand.name) ?? 0) + 1);
    }
  }
  const newTemp = () => `tmp${temps++}`;

  function value(operand: Operand): MOperand {
    if (operand.k === 'reg') return V(display(operand.name));
    if (operand.k === 'const') return I(operand.value);
    if (operand.k === 'undef') return I(0);
    throw new Error('全局变量不能直接当操作数，应该经过 load 或 store');
  }

  fn.blocks.forEach((block, blockIndex) => {
    const out: MInst[] = [];
    const nextName = fn.blocks[blockIndex + 1]?.name;
    const emitted = (inst: Inst, rule: string, code: MInst[]) => {
      out.push(...code);
      events.push({ block: block.name, ir: fmtInst(inst, slots), rule, mir: code.map(fmtMInst) });
    };
    // 入口把参数从调用约定规定的寄存器复制出来。
    if (blockIndex === 0) {
      fn.params.forEach((param, index) => {
        if (!useCount.get(param)) return;
        const copy: MInst = { op: 'copy', d: V(param), s: P(ARG_REGS[index]), why: 'arg' };
        out.push(copy);
        events.push({ block: block.name, ir: `参数 %${param}`, rule: '参数从 System V 规定的寄存器取出', mir: [fmtMInst(copy)] });
      });
    }
    const phiEdges: Array<{ d: string; s: MOperand }> = [];
    for (const nextBlock of successors(block)) {
      const target = fn.blocks.find((item) => item.name === nextBlock)!;
      for (const inst of target.insts) {
        if (inst.op !== 'phi') continue;
        const incoming = inst.incoming.find(([, from]) => from === block.name);
        if (!incoming) continue;
        phiEdges.push({ d: display(inst.dst), s: value(incoming[0]) });
      }
    }
    const flushPhi = () => {
      for (const copy of sequentialize(phiEdges, newTemp)) {
        const inst: MInst = { op: 'copy', d: V(copy.d), s: copy.s, why: 'phi' };
        out.push(inst);
        const to = successors(block)[0];
        phiCopies.push({ from: block.name, to, dst: copy.d, src: fmtM(copy.s) });
        events.push({ block: block.name, ir: `φ 的入边 ${block.name} → ${to}`, rule: '在前驱块末尾写一次复制，φ 就没了', mir: [fmtMInst(inst)] });
      }
    };
    /** cmp 的左操作数和 imul 的被乘数不能是立即数，先放进一个虚拟寄存器。 */
    const materialize = (operand: MOperand): { reg: MOperand; before: MInst[] } => {
      if (operand.k !== 'imm') return { reg: operand, before: [] };
      const name = newTemp();
      return { reg: V(name), before: [{ op: 'copy', d: V(name), s: operand, why: 'phi' }] };
    };
    block.insts.forEach((inst, instIndex) => {
      switch (inst.op) {
        case 'phi':
          return;
        case 'alloca':
          throw new Error('进入后端前 alloca 应该都已提升');
        case 'bin': {
          const a = materialize(value(inst.a));
          const b = value(inst.b);
          const op = inst.kind === 'add' ? 'add3' : inst.kind === 'sub' ? 'sub3' : 'imul3';
          const rule = inst.kind === 'add' ? 'add → ADD（分配后才定 add 还是 lea）' : inst.kind === 'sub' ? 'sub → SUB' : b.k === 'imm' ? 'mul r, imm → IMUL 三操作数形式' : 'mul r, r → IMUL';
          return emitted(inst, rule, [...a.before, { op, d: V(display(inst.dst)), a: a.reg, b }]);
        }
        case 'icmp':
          // 比较和分支是一个组合模式，在 condbr 那里一起选。
          return;
        case 'condbr': {
          const prev = block.insts[instIndex - 1];
          if (inst.cond.k !== 'reg' || prev?.op !== 'icmp' || prev.dst !== inst.cond.name) throw new Error('条件分支的前一条必须是对应的比较');
          const a = materialize(value(prev.a));
          const cc = COND[prev.pred];
          const code: MInst[] = [...a.before, { op: 'cmp', a: a.reg, b: value(prev.b) }];
          if (inst.yes === nextName) code.push({ op: 'jcc', cc: INVERT[cc], label: labelOf.get(inst.no)! });
          else {
            code.push({ op: 'jcc', cc, label: labelOf.get(inst.yes)! });
            if (inst.no !== nextName) code.push({ op: 'jmp', label: labelOf.get(inst.no)! });
          }
          out.push(...code);
          events.push({
            block: block.name,
            ir: `${fmtInst(prev, slots)}\n${fmtInst(inst, slots)}`,
            rule: 'icmp + br → CMP + Jcc（条件取反，让真分支落空直行）',
            mir: code.map(fmtMInst),
          });
          return;
        }
        case 'br': {
          flushPhi();
          if (inst.target !== nextName) emitted(inst, 'br → JMP', [{ op: 'jmp', label: labelOf.get(inst.target)! }]);
          else events.push({ block: block.name, ir: fmtInst(inst, slots), rule: '目标就是下一个块，直接落空，不用跳转', mir: [] });
          return;
        }
        case 'load':
          if (inst.ptr.k !== 'global') throw new Error('只有全局变量还需要 load');
          return emitted(inst, 'load @g → RIP 相对的 mov', [{ op: 'loadg', d: V(display(inst.dst)), sym: inst.ptr.name }]);
        case 'store':
          if (inst.ptr.k !== 'global') throw new Error('只有全局变量还需要 store');
          return emitted(inst, 'store @g → RIP 相对的 mov', [{ op: 'storeg', s: value(inst.val), sym: inst.ptr.name }]);
        case 'call': {
          hasCall = true;
          const code: MInst[] = inst.args.map((arg, index) => ({ op: 'copy', d: P(ARG_REGS[index]), s: value(arg), why: 'argset' }));
          code.push({ op: 'call', fn: inst.fn, argRegs: inst.args.map((_, index) => ARG_REGS[index]) });
          code.push({ op: 'copy', d: V(display(inst.dst)), s: P(RAX), why: 'ret' });
          return emitted(inst, 'call → 参数进约定寄存器，CALL，结果从 eax 取', code);
        }
        case 'ret':
          return emitted(inst, 'ret → 返回值进 eax，RET', [{ op: 'copy', d: P(RAX), s: value(inst.val), why: 'retval' }, { op: 'ret' }]);
      }
    });
    blocks.push({ name: block.name, label: labelOf.get(block.name)!, insts: out });
  });
  return { name: fn.name, blocks, events, phiCopies, hasCall };
}

