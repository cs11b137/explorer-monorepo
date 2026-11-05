/** 控制流图上的分析：活跃变量和支配关系。 */
import { predecessors, successors, type IrFunc } from './ir';

export interface FlowBlock { name: string; use: string[]; def: string[]; succ: string[] }

export interface LiveRow { name: string; use: string[]; def: string[]; in: string[]; out: string[] }

export interface LiveUpdate {
  round: number;
  block: string;
  in: string[];
  out: string[];
  changed: boolean;
}

export interface LiveResult { rows: LiveRow[]; updates: LiveUpdate[]; rounds: number }

/** 经典的后向迭代：IN = USE ∪ (OUT − DEF)，OUT = 各后继 IN 的并集，直到不再变化。 */
export function liveness(blocks: FlowBlock[]): LiveResult {
  const live = new Map(blocks.map((block) => [block.name, { in: new Set<string>(), out: new Set<string>() }]));
  const updates: LiveUpdate[] = [];
  let round = 0;
  let changed = true;
  while (changed) {
    changed = false;
    round++;
    for (const block of [...blocks].reverse()) {
      const entry = live.get(block.name)!;
      const out = new Set(block.succ.flatMap((name) => [...live.get(name)!.in]));
      const nextIn = new Set([...block.use, ...[...out].filter((name) => !block.def.includes(name))]);
      const moved = nextIn.size !== entry.in.size || out.size !== entry.out.size;
      entry.in = nextIn;
      entry.out = out;
      if (moved) changed = true;
      updates.push({ round, block: block.name, in: [...nextIn].sort(), out: [...out].sort(), changed: moved });
    }
  }
  return {
    rows: blocks.map((block) => ({ name: block.name, use: block.use, def: block.def, in: [...live.get(block.name)!.in].sort(), out: [...live.get(block.name)!.out].sort() })),
    updates,
    rounds: round,
  };
}

/** 把 -O0 IR 的每个 alloca 当作一个变量，load 是使用，store 是定义。 */
export function variableFlow(fn: IrFunc): FlowBlock[] {
  const slots = new Set(fn.blocks.flatMap((block) => block.insts.flatMap((inst) => (inst.op === 'alloca' ? [inst.dst] : []))));
  const short = (name: string) => name.replace(/\.addr$/, '');
  return fn.blocks.map((block) => {
    const use: string[] = [];
    const def: string[] = [];
    for (const inst of block.insts) {
      if (inst.op === 'load' && inst.ptr.k === 'reg' && slots.has(inst.ptr.name)) {
        const name = short(inst.ptr.name);
        if (!def.includes(name) && !use.includes(name)) use.push(name);
      }
      if (inst.op === 'store' && inst.ptr.k === 'reg' && slots.has(inst.ptr.name)) {
        const name = short(inst.ptr.name);
        if (!def.includes(name)) def.push(name);
      }
    }
    return { name: block.name, use, def, succ: successors(block) };
  });
}

export function reversePostorder(fn: IrFunc): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const byName = new Map(fn.blocks.map((block) => [block.name, block]));
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    successors(byName.get(name)!).forEach(visit);
    order.push(name);
  };
  visit(fn.blocks[0].name);
  return order.reverse();
}

export interface Dominance {
  idom: Map<string, string | null>;
  frontier: Map<string, string[]>;
  children: Map<string, string[]>;
  order: string[];
}

/** Cooper、Harvey、Kennedy 的迭代算法。 */
export function dominance(fn: IrFunc): Dominance {
  const order = reversePostorder(fn);
  const rank = new Map(order.map((name, index) => [name, index]));
  const preds = predecessors(fn);
  const entry = order[0];
  const idom = new Map<string, string | null>([[entry, entry]]);
  const intersect = (a: string, b: string): string => {
    let x = a;
    let y = b;
    while (x !== y) {
      while (rank.get(x)! > rank.get(y)!) x = idom.get(x)!;
      while (rank.get(y)! > rank.get(x)!) y = idom.get(y)!;
    }
    return x;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of order.slice(1)) {
      const done = preds.get(name)!.filter((pred) => idom.has(pred));
      const next = done.slice(1).reduce((best, pred) => intersect(best, pred), done[0]);
      if (idom.get(name) !== next) {
        idom.set(name, next);
        changed = true;
      }
    }
  }
  const frontier = new Map<string, string[]>(order.map((name) => [name, []]));
  for (const name of order) {
    const list = preds.get(name)!.filter((pred) => idom.has(pred));
    if (list.length < 2) continue;
    for (const pred of list) {
      let runner = pred;
      while (runner !== idom.get(name)) {
        const set = frontier.get(runner)!;
        if (!set.includes(name)) set.push(name);
        runner = idom.get(runner)!;
      }
    }
  }
  idom.set(entry, null);
  const children = new Map<string, string[]>(order.map((name) => [name, []]));
  for (const name of order.slice(1)) children.get(idom.get(name)!)!.push(name);
  return { idom, frontier, children, order };
}

/** a 是否支配 b。 */
export function dominates(dom: Dominance, a: string, b: string): boolean {
  let at: string | null = b;
  while (at) {
    if (at === a) return true;
    at = dom.idom.get(at) ?? null;
  }
  return false;
}
