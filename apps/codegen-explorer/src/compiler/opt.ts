/** 优化：稀疏条件常量传播、死代码消除、循环不变量外提。 */
import { cloneFunc, dstOf, fmtInst, fmtOperand, mapOperands, num, operandsOf, predecessors, slotNames, successors, type Inst, type IrFunc, type Operand } from './ir';
import { dominance, dominates, reversePostorder } from './dataflow';

/** 格的三层：TOP 还不知道，常量，BOTTOM 运行时才知道。 */
export type Lattice = 'top' | 'bottom' | number;

export const fmtLattice = (value: Lattice): string => (value === 'top' ? '⊤' : value === 'bottom' ? '⊥' : String(value));

export interface SccpEvent {
  block: string;
  text: string;
  dst: string;
  from: Lattice;
  to: Lattice;
  why: string;
}

const fits32 = (value: number) => value >= -2147483648 && value <= 2147483647;

function foldBin(kind: 'add' | 'sub' | 'mul', a: number, b: number): number | null {
  const exact = kind === 'add' ? BigInt(a) + BigInt(b) : kind === 'sub' ? BigInt(a) - BigInt(b) : BigInt(a) * BigInt(b);
  // nsw：有符号溢出的结果是 poison，这里不折叠，留给运行时。
  return fits32(Number(exact)) ? Number(exact) : null;
}

function foldCmp(pred: string, a: number, b: number): number {
  const result = pred === 'slt' ? a < b : pred === 'sle' ? a <= b : pred === 'sgt' ? a > b : pred === 'sge' ? a >= b : pred === 'eq' ? a === b : a !== b;
  return result ? 1 : 0;
}

export interface SccpResult {
  fn: IrFunc;
  values: Map<string, Lattice>;
  events: SccpEvent[];
  /** 被常量替换的使用点。 */
  replaced: Array<{ inst: string; dst: string; value: number; before: string; after: string }>;
  removedBlocks: string[];
}

export function sccp(input: IrFunc): SccpResult {
  const fn = cloneFunc(input);
  const slots = slotNames(fn);
  const values = new Map<string, Lattice>();
  const events: SccpEvent[] = [];
  const executable = new Set<string>();
  const visitedBlocks = new Set<string>();
  const defs = new Map<string, { inst: Inst; block: string }>();
  const usersOf = new Map<string, Array<{ inst: Inst; block: string }>>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      const dst = dstOf(inst);
      if (dst) defs.set(dst, { inst, block: block.name });
      for (const operand of operandsOf(inst)) {
        if (operand.k === 'reg') {
          if (!usersOf.has(operand.name)) usersOf.set(operand.name, []);
          usersOf.get(operand.name)!.push({ inst, block: block.name });
        }
      }
    }
  }
  fn.params.forEach((param) => values.set(param, 'bottom'));
  const get = (operand: Operand): Lattice => {
    if (operand.k === 'const') return operand.value;
    if (operand.k === 'undef') return 'top';
    if (operand.k === 'global') return 'bottom';
    return values.get(operand.name) ?? 'top';
  };
  const blockQueue: Array<[string | null, string]> = [[null, fn.blocks[0].name]];
  const valueQueue: Array<{ inst: Inst; block: string }> = [];

  function setValue(inst: Inst, block: string, dst: string, to: Lattice, why: string): void {
    const from = values.get(dst) ?? 'top';
    if (from === to || from === 'bottom') return;
    values.set(dst, to);
    events.push({ block, text: fmtInst(inst, slots), dst, from, to, why });
    usersOf.get(dst)?.forEach((user) => valueQueue.push(user));
  }

  function visit(inst: Inst, block: string): void {
    switch (inst.op) {
      case 'bin': {
        const a = get(inst.a);
        const b = get(inst.b);
        if (a === 'top' || b === 'top') return;
        if (a === 'bottom' || b === 'bottom') {
          const zero = inst.kind === 'mul' && (a === 0 || b === 0);
          if (zero) return setValue(inst, block, inst.dst, 0, '乘数里有 0，结果一定是 0');
          return setValue(inst, block, inst.dst, 'bottom', '操作数运行时才知道');
        }
        const folded = foldBin(inst.kind, a, b);
        return setValue(inst, block, inst.dst, folded ?? 'bottom', folded === null ? '有符号溢出，不折叠' : `${a} ${inst.kind} ${b} 可以直接算出来`);
      }
      case 'icmp': {
        const a = get(inst.a);
        const b = get(inst.b);
        if (a === 'top' || b === 'top') return;
        if (a === 'bottom' || b === 'bottom') return setValue(inst, block, inst.dst, 'bottom', '操作数运行时才知道');
        return setValue(inst, block, inst.dst, foldCmp(inst.pred, a, b), '两边都是常量');
      }
      case 'phi': {
        let merged: Lattice = 'top';
        for (const [value, from] of inst.incoming) {
          if (!executable.has(`${from}>${block}`)) continue;
          const v = get(value);
          if (v === 'top') continue;
          if (merged === 'top') merged = v;
          else if (merged !== v) merged = 'bottom';
        }
        if (merged === 'top') return;
        return setValue(inst, block, inst.dst, merged, merged === 'bottom' ? '各条入边的值不同' : '可达入边的值相同');
      }
      case 'load':
      case 'call':
        return setValue(inst, block, inst.dst, 'bottom', inst.op === 'call' ? '函数返回值运行时才知道' : '内存里的值运行时才知道');
      case 'condbr': {
        const c = get(inst.cond);
        if (c === 'top') return;
        if (c === 'bottom' || c !== 0) blockQueue.push([block, inst.yes]);
        if (c === 'bottom' || c === 0) blockQueue.push([block, inst.no]);
        return;
      }
      case 'br':
        blockQueue.push([block, inst.target]);
        return;
      default:
        return;
    }
  }

  const byName = new Map(fn.blocks.map((block) => [block.name, block]));
  while (blockQueue.length || valueQueue.length) {
    while (valueQueue.length) {
      const { inst, block } = valueQueue.shift()!;
      if (visitedBlocks.has(block)) visit(inst, block);
    }
    const edge = blockQueue.shift();
    if (!edge) continue;
    const [from, to] = edge;
    if (from) {
      const key = `${from}>${to}`;
      if (executable.has(key)) continue;
      executable.add(key);
    }
    const block = byName.get(to)!;
    if (visitedBlocks.has(to)) {
      block.insts.filter((inst) => inst.op === 'phi').forEach((inst) => visit(inst, to));
      continue;
    }
    visitedBlocks.add(to);
    block.insts.forEach((inst) => visit(inst, to));
  }

  // 用不动点的结果改写程序。
  const replaced: SccpResult['replaced'] = [];
  const constOf = (operand: Operand): Operand => {
    if (operand.k !== 'reg') return operand;
    const value = values.get(operand.name);
    return typeof value === 'number' ? num(value) : operand;
  };
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      const before = fmtInst(inst, slots);
      const changedDsts: Array<{ dst: string; value: number }> = [];
      for (const operand of operandsOf(inst)) {
        if (operand.k === 'reg' && typeof values.get(operand.name) === 'number') changedDsts.push({ dst: operand.name, value: values.get(operand.name) as number });
      }
      if (!changedDsts.length) continue;
      mapOperands(inst, constOf);
      // 交换律：常量放右边，和 LLVM 的规范形式一致，后端也更好选 imm 模式。
      if (inst.op === 'bin' && inst.kind !== 'sub' && inst.a.k === 'const' && inst.b.k !== 'const') [inst.a, inst.b] = [inst.b, inst.a];
      const after = fmtInst(inst, slots);
      const dst = dstOf(inst) ?? '';
      changedDsts.forEach((item) => replaced.push({ inst: dst, dst: item.dst, value: item.value, before, after }));
    }
  }

  // 常量条件：分支折叠，删除走不到的块。
  for (const block of fn.blocks) {
    const last = block.insts[block.insts.length - 1];
    if (last?.op === 'condbr' && last.cond.k === 'const') {
      const target = last.cond.value !== 0 ? last.yes : last.no;
      block.insts[block.insts.length - 1] = { op: 'br', target, src: last.src };
    }
  }
  const reachable = new Set(reversePostorder(fn));
  const removedBlocks = fn.blocks.filter((block) => !reachable.has(block.name)).map((block) => block.name);
  fn.blocks = fn.blocks.filter((block) => reachable.has(block.name));
  const preds = predecessors(fn);
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      if (inst.op === 'phi') inst.incoming = inst.incoming.filter(([, from]) => preds.get(block.name)!.includes(from));
    }
  }
  return { fn, values, events, replaced, removedBlocks };
}

export interface DceResult {
  fn: IrFunc;
  /** 被删掉的指令文本，按程序顺序。 */
  removed: Array<{ block: string; text: string; dst: string }>;
  live: string[];
}

/** 标记-清除：从有副作用的指令出发，把用到的定义都标活，其余删除。 */
export function dce(input: IrFunc): DceResult {
  const fn = cloneFunc(input);
  const slots = slotNames(fn);
  const defs = new Map<string, Inst>();
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      const dst = dstOf(inst);
      if (dst) defs.set(dst, inst);
    }
  }
  const hasEffect = (inst: Inst) => ['store', 'call', 'br', 'condbr', 'ret'].includes(inst.op);
  const liveInsts = new Set<Inst>();
  const work: Inst[] = [];
  for (const block of fn.blocks) for (const inst of block.insts) if (hasEffect(inst)) work.push(inst);
  while (work.length) {
    const inst = work.pop()!;
    if (liveInsts.has(inst)) continue;
    liveInsts.add(inst);
    for (const operand of operandsOf(inst)) {
      if (operand.k === 'reg') {
        const def = defs.get(operand.name);
        if (def) work.push(def);
      }
    }
  }
  const removed: DceResult['removed'] = [];
  for (const block of fn.blocks) {
    block.insts = block.insts.filter((inst) => {
      if (liveInsts.has(inst)) return true;
      removed.push({ block: block.name, text: fmtInst(inst, slots), dst: dstOf(inst) ?? '' });
      return false;
    });
  }
  return { fn, removed, live: [...liveInsts].flatMap((inst) => dstOf(inst) ?? []) };
}

export interface LoopInfo { header: string; latch: string; blocks: string[]; preheader: string }

export interface LicmEvent {
  text: string;
  block: string;
  dst: string;
  verdict: 'hoist' | 'stay';
  why: string;
}

export interface LicmResult { fn: IrFunc; loops: LoopInfo[]; events: LicmEvent[]; hoisted: string[]; createdPreheader: boolean }

/** 自然循环：回边 latch→header 且 header 支配 latch。 */
export function findLoops(fn: IrFunc): Array<{ header: string; latch: string; blocks: string[] }> {
  const dom = dominance(fn);
  const preds = predecessors(fn);
  const loops: Array<{ header: string; latch: string; blocks: string[] }> = [];
  for (const block of fn.blocks) {
    for (const next of successors(block)) {
      if (!dominates(dom, next, block.name)) continue;
      const body = new Set<string>([next]);
      const work = [block.name];
      while (work.length) {
        const name = work.pop()!;
        if (body.has(name)) continue;
        body.add(name);
        work.push(...preds.get(name)!);
      }
      loops.push({ header: next, latch: block.name, blocks: fn.blocks.map((item) => item.name).filter((name) => body.has(name)) });
    }
  }
  return loops;
}

const PURE = new Set(['bin', 'icmp']);

export function licm(input: IrFunc): LicmResult {
  const fn = cloneFunc(input);
  const slots = slotNames(fn);
  const events: LicmEvent[] = [];
  const hoisted: string[] = [];
  const loops: LoopInfo[] = [];
  let createdPreheader = false;
  // 内层循环先处理，提到外层后还有机会继续外提。
  const found = findLoops(fn).sort((a, b) => a.blocks.length - b.blocks.length);
  for (const loop of found) {
    const preds = predecessors(fn);
    const outside = preds.get(loop.header)!.filter((name) => !loop.blocks.includes(name));
    const onlySucc = outside.length === 1 && successors(fn.blocks.find((block) => block.name === outside[0])!).length === 1;
    let preheader = outside[0];
    if (!onlySucc) {
      preheader = `${loop.header}.ph`;
      createdPreheader = true;
      const headerIndex = fn.blocks.findIndex((block) => block.name === loop.header);
      fn.blocks.splice(headerIndex, 0, { name: preheader, insts: [{ op: 'br', target: loop.header }] });
      for (const name of outside) {
        const block = fn.blocks.find((item) => item.name === name)!;
        const last = block.insts[block.insts.length - 1];
        if (last.op === 'br' && last.target === loop.header) last.target = preheader;
        if (last.op === 'condbr') {
          if (last.yes === loop.header) last.yes = preheader;
          if (last.no === loop.header) last.no = preheader;
        }
      }
      for (const inst of fn.blocks[headerIndex + 1].insts) {
        if (inst.op === 'phi') {
          const inside = inst.incoming.filter(([, from]) => !outside.includes(from));
          const out = inst.incoming.filter(([, from]) => outside.includes(from));
          inst.incoming = [[out[0][0], preheader], ...inside];
        }
      }
    }
    loops.push({ ...loop, preheader });
    const defsInLoop = new Set<string>();
    for (const name of loop.blocks) {
      for (const inst of fn.blocks.find((block) => block.name === name)!.insts) {
        const dst = dstOf(inst);
        if (dst) defsInLoop.add(dst);
      }
    }
    const moved: Inst[] = [];
    let changed = true;
    const verdicts = new Map<string, LicmEvent>();
    while (changed) {
      changed = false;
      for (const name of loop.blocks) {
        const block = fn.blocks.find((item) => item.name === name)!;
        block.insts = block.insts.filter((inst) => {
          const dst = dstOf(inst);
          if (!dst) return true;
          const text = fmtInst(inst, slots);
          if (!PURE.has(inst.op)) {
            verdicts.set(dst, { text, block: name, dst, verdict: 'stay', why: inst.op === 'phi' ? 'φ 每轮循环取不同的值' : '可能有副作用或依赖内存' });
            return true;
          }
          const inLoop = operandsOf(inst).filter((operand) => operand.k === 'reg' && defsInLoop.has(operand.name));
          if (inLoop.length) {
            verdicts.set(dst, { text, block: name, dst, verdict: 'stay', why: `依赖循环内定义的 ${inLoop.map((operand) => fmtOperand(operand, slots)).join('、')}` });
            return true;
          }
          verdicts.set(dst, { text, block: name, dst, verdict: 'hoist', why: '操作数都在循环外定义，不读内存也不会陷入，可以提前算' });
          defsInLoop.delete(dst);
          moved.push(inst);
          hoisted.push(dst);
          changed = true;
          return false;
        });
      }
    }
    events.push(...verdicts.values());
    const pre = fn.blocks.find((block) => block.name === preheader)!;
    pre.insts.splice(pre.insts.length - 1, 0, ...moved);
  }
  return { fn, loops, events, hoisted, createdPreheader };
}
