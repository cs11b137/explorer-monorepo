/** 把 alloca 提升成 SSA：算支配边界、插 φ、再沿支配树重命名。对应 LLVM 的 mem2reg。 */
import { cloneFunc, reg, successors, type Inst, type IrFunc, type Operand } from './ir';
import { dominance, liveness, variableFlow, type Dominance } from './dataflow';

export type SsaEvent =
  | { kind: 'phi'; variable: string; block: string; name: string; because: string[] }
  | { kind: 'rename'; block: string; removed: string; variable: string; value: string; action: 'load' | 'store' }
  | { kind: 'incoming'; block: string; phi: string; from: string; value: string };

export interface SsaResult {
  fn: IrFunc;
  dom: Dominance;
  defSites: Map<string, string[]>;
  phis: Array<{ variable: string; block: string; name: string }>;
  events: SsaEvent[];
}

export function promote(input: IrFunc): SsaResult {
  const fn = cloneFunc(input);
  const dom = dominance(fn);
  
  const allocas = fn.blocks.flatMap((block) => block.insts.flatMap((inst) => (inst.op === 'alloca' ? [inst.dst] : [])));
  const isSlot = (operand: Operand) => operand.k === 'reg' && allocas.includes(operand.name);
  const defSites = new Map<string, string[]>(allocas.map((name) => [name, []]));
  for (const block of fn.blocks) {
    for (const inst of block.insts) {
      if (inst.op === 'store' && isSlot(inst.ptr)) {
        const name = (inst.ptr as { name: string }).name;
        if (!defSites.get(name)!.includes(block.name)) defSites.get(name)!.push(block.name);
      }
    }
  }

  // 只在变量入口仍然活跃的块里放 φ（剪枝 SSA），否则死变量也会带来无用的 φ。
  const flow = liveness(variableFlow(fn));
  const liveIn = new Map(flow.rows.map((row) => [row.name, new Set(row.in)]));
  const short = (name: string) => name.replace(/\.addr$/, '');
  const events: SsaEvent[] = [];
  const phis: SsaResult['phis'] = [];
  const phiAt = new Map<string, Map<string, Extract<Inst, { op: 'phi' }>>>(fn.blocks.map((block) => [block.name, new Map()]));
  for (const variable of allocas) {
    const placed = new Set<string>();
    const work = [...defSites.get(variable)!];
    let version = 0;
    while (work.length) {
      const site = work.pop()!;
      for (const target of dom.frontier.get(site) ?? []) {
        if (placed.has(target) || !liveIn.get(target)!.has(short(variable))) continue;
        placed.add(target);
        const name = `${short(variable)}.${version++}`;
        phiAt.get(target)!.set(variable, { op: 'phi', dst: name, incoming: [] });
        phis.push({ variable, block: target, name });
        events.push({ kind: 'phi', variable, block: target, name, because: [site] });
        if (!defSites.get(variable)!.includes(target)) work.push(target);
      }
    }
  }

  const replaced = new Map<string, Operand>();
  const resolve = (operand: Operand): Operand => (operand.k === 'reg' && replaced.has(operand.name) ? resolve(replaced.get(operand.name)!) : operand);
  const fmt = (operand: Operand) => (operand.k === 'reg' ? `%${operand.name}` : operand.k === 'const' ? String(operand.value) : operand.k === 'global' ? `@${operand.name}` : 'undef');
  const visited = new Set<string>();
  const byName = new Map(fn.blocks.map((block) => [block.name, block]));

  function rename(blockName: string, from: string | null, incoming: Map<string, Operand>): void {
    const phiHere = phiAt.get(blockName)!;
    const values = new Map(incoming);
    if (from) {
      for (const [variable, phi] of phiHere) {
        const value = resolve(incoming.get(variable) ?? { k: 'undef' });
        phi.incoming.push([value, from]);
        events.push({ kind: 'incoming', block: blockName, phi: phi.dst, from, value: fmt(value) });
      }
    }
    if (visited.has(blockName)) return;
    visited.add(blockName);
    for (const [variable, phi] of phiHere) values.set(variable, reg(phi.dst));
    const block = byName.get(blockName)!;
    const kept: Inst[] = [];
    for (const inst of block.insts) {
      if (inst.op === 'alloca') continue;
      if (inst.op === 'load' && isSlot(inst.ptr)) {
        const variable = (inst.ptr as { name: string }).name;
        const value = values.get(variable) ?? ({ k: 'undef' } as Operand);
        replaced.set(inst.dst, value);
        events.push({ kind: 'rename', block: blockName, removed: inst.dst, variable: short(variable), value: fmt(resolve(value)), action: 'load' });
        continue;
      }
      if (inst.op === 'store' && isSlot(inst.ptr)) {
        const variable = (inst.ptr as { name: string }).name;
        const value = resolve(inst.val);
        values.set(variable, value);
        events.push({ kind: 'rename', block: blockName, removed: variable, variable: short(variable), value: fmt(value), action: 'store' });
        continue;
      }
      kept.push(inst);
    }
    block.insts = [...phiHere.values(), ...kept];
    for (const next of successors(block)) rename(next, blockName, values);
  }

  rename(fn.blocks[0].name, null, new Map());

  // 所有 load 都已有了去向，这才能把旧名字替换干净；φ 的操作数也可能指向被删的 load。
  for (const block of fn.blocks) {
    for (const inst of block.insts) mapAll(inst, resolve);
  }
  return { fn, dom, defSites, phis, events };
}

function mapAll(inst: Inst, resolve: (operand: Operand) => Operand): void {
  switch (inst.op) {
    case 'load': inst.ptr = resolve(inst.ptr); break;
    case 'store': inst.val = resolve(inst.val); inst.ptr = resolve(inst.ptr); break;
    case 'bin': case 'icmp': inst.a = resolve(inst.a); inst.b = resolve(inst.b); break;
    case 'phi': inst.incoming = inst.incoming.map(([value, block]) => [resolve(value), block]); break;
    case 'call': inst.args = inst.args.map(resolve); break;
    case 'condbr': inst.cond = resolve(inst.cond); break;
    case 'ret': inst.val = resolve(inst.val); break;
    default: break;
  }
}
