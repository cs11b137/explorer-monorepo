/** 把语法树翻译成未优化的 IR。命名和块结构遵循 clang -O0，便于逐行对照。 */
import { glob, num, reg, type BinKind, type Block, type Inst, type IrFunc, type IrModule, type Operand, type Pred } from './ir';
import type { Expr, Program, Span, Stmt, Top } from './parser';

const BIN: Partial<Record<string, BinKind>> = { '+': 'add', '-': 'sub', '*': 'mul' };
const NAME: Record<BinKind, string> = { add: 'add', sub: 'sub', mul: 'mul' };
const PRED: Partial<Record<string, Pred>> = { '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge', '==': 'eq', '!=': 'ne' };

export interface GenEvent {
  /** 指令写到了哪个基本块。 */
  block: string;
  inst: Inst;
  span: Span;
}

const wrap32 = (value: number) => value | 0;

function foldBin(kind: BinKind, a: number, b: number): number {
  if (kind === 'add') return wrap32(a + b);
  if (kind === 'sub') return wrap32(a - b);
  return Math.imul(a, b);
}

function foldCmp(pred: Pred, a: number, b: number): boolean {
  switch (pred) {
    case 'slt': return a < b;
    case 'sle': return a <= b;
    case 'sgt': return a > b;
    case 'sge': return a >= b;
    case 'eq': return a === b;
    case 'ne': return a !== b;
  }
}

/** 统计 return 的位置：只有一条且在函数末尾时直接 ret，否则走 retval 和 return 块。 */
function countReturns(stmt: Stmt): number {
  switch (stmt.k) {
    case 'return': return 1;
    case 'block': return stmt.stmts.reduce((sum, item) => sum + countReturns(item), 0);
    case 'while': return countReturns(stmt.body);
    case 'if': return countReturns(stmt.then) + (stmt.else ? countReturns(stmt.else) : 0);
    default: return 0;
  }
}

function genFunc(top: Extract<Top, { k: 'func' }>, globals: Set<string>): { fn: IrFunc; events: GenEvent[] } {
  const body = top.body!;
  const allocas: Block = { name: 'entry', insts: [] };
  const blocks: Block[] = [{ name: 'entry', insts: [] }];
  const events: GenEvent[] = [];
  const used = new Set<string>(top.params.map((param) => param.name));
  let lastUnique = 0;
  let temp = 0;
  let current: Block | null = blocks[0];
  const scopes: Array<Map<string, string>> = [];
  const direct = countReturns(body) === 1 && body.stmts[body.stmts.length - 1]?.k === 'return';

  /** 名字冲突时追加一个递增的后缀，和 LLVM 的值符号表一致。 */
  function unique(name: string): string {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    for (;;) {
      const candidate = `${name}${++lastUnique}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  }

  const tempName = () => `$${temp++}`;

  function emit(inst: Inst, span: Span): void {
    if (!current) return;
    inst.src = span;
    current.insts.push(inst);
    events.push({ block: current.name, inst, span });
  }

  function emitAlloca(name: string, span: Span): string {
    const dst = unique(name);
    const inst: Inst = { op: 'alloca', dst, src: span };
    allocas.insts.push(inst);
    events.push({ block: 'entry', inst, span });
    return dst;
  }

  function startBlock(name: string): Block {
    const block: Block = { name: unique(name), insts: [] };
    blocks.push(block);
    current = block;
    return block;
  }

  function lookup(name: string): Operand {
    for (let index = scopes.length - 1; index >= 0; index--) {
      const slot = scopes[index].get(name);
      if (slot) return reg(slot);
    }
    if (globals.has(name)) return glob(name);
    throw new Error(`没有变量 ${name}，语义分析应该已经报错`);
  }

  function value(e: Expr): Operand {
    switch (e.k) {
      case 'num':
        return num(e.value);
      case 'var': {
        const dst = tempName();
        emit({ op: 'load', dst, ptr: lookup(e.name) }, e.span);
        return reg(dst);
      }
      case 'neg': {
        const operand = value(e.e);
        if (operand.k === 'const') return num(wrap32(-operand.value));
        const dst = unique('sub');
        emit({ op: 'bin', kind: 'sub', dst, a: num(0), b: operand }, e.span);
        return reg(dst);
      }
      case 'bin': {
        const kind = BIN[e.op];
        if (!kind) throw new Error('比较表达式只能作条件');
        const a = value(e.l);
        const b = value(e.r);
        if (a.k === 'const' && b.k === 'const') return num(foldBin(kind, a.value, b.value));
        const dst = unique(NAME[kind]);
        emit({ op: 'bin', kind, dst, a, b }, e.span);
        return reg(dst);
      }
      case 'assign': {
        const v = value(e.value);
        emit({ op: 'store', val: v, ptr: lookup(e.target.name) }, e.span);
        return v;
      }
      case 'call': {
        const args = e.args.map(value);
        const dst = unique('call');
        emit({ op: 'call', dst, fn: e.fn, args }, e.span);
        return reg(dst);
      }
    }
  }

  /** 条件表达式求值成 i1：比较直接用 icmp，其余和 0 比较。 */
  function condition(e: Expr): Operand | boolean {
    if (e.k === 'bin' && PRED[e.op]) {
      const pred = PRED[e.op]!;
      const a = value(e.l);
      const b = value(e.r);
      if (a.k === 'const' && b.k === 'const') return foldCmp(pred, a.value, b.value);
      const dst = unique('cmp');
      emit({ op: 'icmp', pred, dst, a, b }, e.span);
      return reg(dst);
    }
    const v = value(e);
    if (v.k === 'const') return v.value !== 0;
    const dst = unique('tobool');
    emit({ op: 'icmp', pred: 'ne', dst, a: v, b: num(0) }, e.span);
    return reg(dst);
  }

  let returnSlot = '';
  const exits: Array<() => void> = [];

  function stmt(s: Stmt): void {
    if (!current && s.k !== 'block') return;
    switch (s.k) {
      case 'decl': {
        const slot = emitAlloca(s.name, s.span);
        scopes[scopes.length - 1].set(s.name, slot);
        if (s.init) {
          const v = value(s.init);
          emit({ op: 'store', val: v, ptr: reg(slot) }, s.span);
        }
        return;
      }
      case 'expr':
        value(s.e);
        return;
      case 'block':
        scopes.push(new Map());
        s.stmts.forEach(stmt);
        scopes.pop();
        return;
      case 'return': {
        const v = value(s.value);
        if (direct) {
          emit({ op: 'ret', val: v }, s.span);
          current = null;
          return;
        }
        emit({ op: 'store', val: v, ptr: reg(returnSlot) }, s.span);
        const from = current!;
        exits.push(() => from.insts.push({ op: 'br', target: returnBlockName }));
        current = null;
        return;
      }
      case 'while': {
        emit({ op: 'br', target: '' }, s.span);
        const entryBr = current!.insts[current!.insts.length - 1] as Extract<Inst, { op: 'br' }>;
        const head = startBlock('while.cond');
        entryBr.target = head.name;
        const cond = condition(s.cond);
        const branch: Inst = cond === true ? { op: 'br', target: '' } : { op: 'condbr', cond: typeof cond === 'boolean' ? num(0) : cond, yes: '', no: '' };
        if (cond === false) throw new Error('本子集不支持恒假的循环条件');
        emit(branch, s.cond.span);
        const bodyBlock = startBlock('while.body');
        if (branch.op === 'br') branch.target = bodyBlock.name;
        else branch.yes = bodyBlock.name;
        stmt(s.body);
        emit({ op: 'br', target: head.name }, s.span);
        if (branch.op === 'condbr') {
          const end = startBlock('while.end');
          branch.no = end.name;
        } else current = null;
        return;
      }
      case 'if': {
        const cond = condition(s.cond);
        const isConst = typeof cond === 'boolean';
        const operand = isConst ? num(cond ? 1 : 0) : (cond as Operand);
        const branch: Extract<Inst, { op: 'condbr' }> = { op: 'condbr', cond: operand, yes: '', no: '' };
        emit(branch, s.cond.span);
        const thenBlock = startBlock('if.then');
        branch.yes = thenBlock.name;
        stmt(s.then);
        const afterThen = current as Block | null;
        const elseBr: Array<Extract<Inst, { op: 'br' }>> = [];
        if (afterThen) {
          const jump: Extract<Inst, { op: 'br' }> = { op: 'br', target: '' };
          emit(jump, s.span);
          elseBr.push(jump);
        }
        if (s.else) {
          const elseBlock = startBlock('if.else');
          branch.no = elseBlock.name;
          stmt(s.else);
          if (current) {
            const jump: Extract<Inst, { op: 'br' }> = { op: 'br', target: '' };
            emit(jump, s.span);
            elseBr.push(jump);
          }
        }
        const end = startBlock('if.end');
        if (!s.else) branch.no = end.name;
        elseBr.forEach((jump) => (jump.target = end.name));
        return;
      }
    }
  }

  let returnBlockName = '';
  scopes.push(new Map());
  if (!direct) returnSlot = emitAlloca('retval', body.span);
  for (const param of top.params) {
    
    const span = param.span;
    const slot = emitAlloca(`${param.name}.addr`, span);
    scopes[0].set(param.name, slot);
    emit({ op: 'store', val: reg(param.name), ptr: reg(slot) }, span);
  }
  body.stmts.forEach(stmt);
  if (!direct) {
    const last = startBlock('return');
    returnBlockName = last.name;
    const dst = tempName();
    emit({ op: 'load', dst, ptr: reg(returnSlot) }, body.span);
    emit({ op: 'ret', val: reg(dst) }, body.span);
    exits.forEach((patch) => patch());
  }
  blocks[0].insts = [...allocas.insts, ...blocks[0].insts];
  return { fn: { name: top.name, params: top.params.map((param) => param.name), blocks: blocks.filter((block) => block.insts.length) }, events };
}

export function generate(program: Program): { module: IrModule; events: Map<string, GenEvent[]> } {
  const globals = new Set(program.tops.filter((top) => top.k === 'global').map((top) => top.name));
  const funcs: IrFunc[] = [];
  const events = new Map<string, GenEvent[]>();
  const defined = new Set(program.tops.filter((top) => top.k === 'func' && top.body).map((top) => top.name));
  for (const top of program.tops) {
    if (top.k !== 'func' || !top.body) continue;
    const result = genFunc(top, globals);
    funcs.push(result.fn);
    events.set(top.name, result.events);
  }
  const externs = program.tops.flatMap((top) => (top.k === 'func' && !top.body && !defined.has(top.name) ? [{ name: top.name, arity: top.params.length }] : []));
  return { module: { globals: [...globals], externs, funcs }, events };
}
