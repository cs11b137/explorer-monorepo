/** 中间表示：LLVM IR 的一个小子集，打印结果是 clang 能读懂的真实文本。 */
import type { Span } from './parser';

export type Operand =
  | { k: 'reg'; name: string }
  | { k: 'const'; value: number }
  | { k: 'global'; name: string }
  | { k: 'undef' };

export const reg = (name: string): Operand => ({ k: 'reg', name });
export const num = (value: number): Operand => ({ k: 'const', value });
export const glob = (name: string): Operand => ({ k: 'global', name });

export type BinKind = 'add' | 'sub' | 'mul';
export type Pred = 'slt' | 'sle' | 'sgt' | 'sge' | 'eq' | 'ne';

export type Inst = { src?: Span } & (
  | { op: 'alloca'; dst: string }
  | { op: 'load'; dst: string; ptr: Operand }
  | { op: 'store'; val: Operand; ptr: Operand }
  | { op: 'bin'; kind: BinKind; dst: string; a: Operand; b: Operand }
  | { op: 'icmp'; pred: Pred; dst: string; a: Operand; b: Operand }
  | { op: 'phi'; dst: string; incoming: Array<[Operand, string]> }
  | { op: 'call'; dst: string; fn: string; args: Operand[] }
  | { op: 'br'; target: string }
  | { op: 'condbr'; cond: Operand; yes: string; no: string }
  | { op: 'ret'; val: Operand }
);

export interface Block { name: string; insts: Inst[] }

export interface IrFunc { name: string; params: string[]; blocks: Block[] }

export interface IrModule { globals: string[]; externs: Array<{ name: string; arity: number }>; funcs: IrFunc[] }

/** 未命名的值在内部用 $ 开头，打印时才按出现顺序编号，和 LLVM 的做法一样。 */
export function slotNames(fn: IrFunc): Map<string, string> {
  const slots = new Map<string, string>();
  let next = 0;
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      if ('dst' in inst && inst.dst.startsWith('$') && !slots.has(inst.dst)) slots.set(inst.dst, String(next++));
    }
  }
  return slots;
}

export function fmtOperand(operand: Operand, slots?: Map<string, string>): string {
  switch (operand.k) {
    case 'reg': return `%${slots?.get(operand.name) ?? operand.name}`;
    case 'const': return String(operand.value);
    case 'global': return `@${operand.name}`;
    case 'undef': return 'undef';
  }
}

export function fmtInst(inst: Inst, slots?: Map<string, string>): string {
  const o = (operand: Operand) => fmtOperand(operand, slots);
  const d = (name: string) => `%${slots?.get(name) ?? name}`;
  switch (inst.op) {
    case 'alloca': return `${d(inst.dst)} = alloca i32, align 4`;
    case 'load': return `${d(inst.dst)} = load i32, ptr ${o(inst.ptr)}, align 4`;
    case 'store': return `store i32 ${o(inst.val)}, ptr ${o(inst.ptr)}, align 4`;
    case 'bin': return `${d(inst.dst)} = ${inst.kind} nsw i32 ${o(inst.a)}, ${o(inst.b)}`;
    case 'icmp': return `${d(inst.dst)} = icmp ${inst.pred} i32 ${o(inst.a)}, ${o(inst.b)}`;
    case 'phi': return `${d(inst.dst)} = phi i32 ${inst.incoming.map(([value, block]) => `[ ${o(value)}, %${block} ]`).join(', ')}`;
    case 'call': return `${d(inst.dst)} = call i32 @${inst.fn}(${inst.args.map((arg) => `i32 noundef ${o(arg)}`).join(', ')})`;
    case 'br': return `br label %${inst.target}`;
    case 'condbr': return `br i1 ${o(inst.cond)}, label %${inst.yes}, label %${inst.no}`;
    case 'ret': return `ret i32 ${o(inst.val)}`;
  }
}

/** 函数体的文本行：基本块标签顶格，指令缩进两格。 */
export function fmtBody(fn: IrFunc): string[] {
  const slots = slotNames(fn);
  const lines: string[] = [];
  fn.blocks.forEach((block, index) => {
    if (index) lines.push('');
    lines.push(`${block.name}:`);
    for (const inst of block.insts) lines.push(`  ${fmtInst(inst, slots)}`);
  });
  return lines;
}

export const fmtHeader = (fn: IrFunc) => `define dso_local i32 @${fn.name}(${fn.params.map((param) => `i32 noundef %${param}`).join(', ')}) {`;

export function fmtFunc(fn: IrFunc): string {
  return [fmtHeader(fn), ...fmtBody(fn), '}'].join('\n');
}

/** 完整模块文本，可以直接交给 clang -x ir。 */
export function fmtModule(module: IrModule, triple = 'x86_64-unknown-linux-gnu'): string {
  return [
    `target triple = "${triple}"`,
    '',
    ...module.globals.map((name) => `@${name} = dso_local global i32 0, align 4`),
    '',
    ...module.funcs.flatMap((fn) => [fmtFunc(fn), '']),
    ...module.externs.map((ext) => `declare i32 @${ext.name}(${Array.from({ length: ext.arity }, () => 'i32 noundef').join(', ')})`),
    '',
  ].join('\n');
}

export const cloneFunc = (fn: IrFunc): IrFunc => structuredClone(fn);

export const blockOf = (fn: IrFunc, name: string): Block => {
  const block = fn.blocks.find((item) => item.name === name);
  if (!block) throw new Error(`没有基本块 ${name}`);
  return block;
};

/** 指令读取的操作数。 */
export function operandsOf(inst: Inst): Operand[] {
  switch (inst.op) {
    case 'load': return [inst.ptr];
    case 'store': return [inst.val, inst.ptr];
    case 'bin': case 'icmp': return [inst.a, inst.b];
    case 'phi': return inst.incoming.map(([value]) => value);
    case 'call': return inst.args;
    case 'condbr': return [inst.cond];
    case 'ret': return [inst.val];
    default: return [];
  }
}

export function mapOperands(inst: Inst, map: (operand: Operand) => Operand): void {
  switch (inst.op) {
    case 'load': inst.ptr = map(inst.ptr); break;
    case 'store': inst.val = map(inst.val); inst.ptr = map(inst.ptr); break;
    case 'bin': case 'icmp': inst.a = map(inst.a); inst.b = map(inst.b); break;
    case 'phi': inst.incoming = inst.incoming.map(([value, block]) => [map(value), block]); break;
    case 'call': inst.args = inst.args.map(map); break;
    case 'condbr': inst.cond = map(inst.cond); break;
    case 'ret': inst.val = map(inst.val); break;
    default: break;
  }
}

export function successors(block: Block): string[] {
  const last = block.insts[block.insts.length - 1];
  if (!last) return [];
  if (last.op === 'br') return [last.target];
  if (last.op === 'condbr') return [last.yes, last.no];
  return [];
}

export function predecessors(fn: IrFunc): Map<string, string[]> {
  const preds = new Map<string, string[]>(fn.blocks.map((block) => [block.name, []]));
  for (const block of fn.blocks) for (const next of successors(block)) preds.get(next)!.push(block.name);
  return preds;
}

export const dstOf = (inst: Inst): string | null => ('dst' in inst ? inst.dst : null);
