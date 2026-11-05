/** IR 解释器：真的把 IR 跑起来，统计每条指令执行了几次。LICM 那一课的次数就来自这里。 */
import { dstOf, type Inst, type IrFunc, type IrModule, type Operand } from './ir';

export interface InterpResult { value: number; globals: Map<string, number>; counts: Map<string, number>; steps: number }

export function interpret(fn: IrFunc, args: number[], module: Pick<IrModule, 'globals'>, externs: Record<string, (...args: number[]) => number>): InterpResult {
  const regs = new Map<string, number>();
  const slots = new Map<string, number>();
  const globals = new Map(module.globals.map((name) => [name, 0]));
  const counts = new Map<string, number>();
  fn.params.forEach((param, index) => regs.set(param, args[index]));
  const value = (operand: Operand): number => {
    if (operand.k === 'const') return operand.value;
    if (operand.k === 'reg') return regs.get(operand.name) ?? 0;
    return 0;
  };
  let block = fn.blocks[0];
  let previous = '';
  let steps = 0;
  const byName = new Map(fn.blocks.map((item) => [item.name, item]));
  for (;;) {
    // φ 要同时取值：先全读，再全写。
    const phis = block.insts.filter((inst): inst is Extract<Inst, { op: 'phi' }> => inst.op === 'phi');
    const values = phis.map((phi) => value(phi.incoming.find(([, from]) => from === previous)![0]));
    phis.forEach((phi, index) => regs.set(phi.dst, values[index]));
    let next: string | null = null;
    for (const inst of block.insts) {
      steps++;
      const key = dstOf(inst) ?? inst.op;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      switch (inst.op) {
        case 'alloca': slots.set(inst.dst, 0); break;
        case 'load':
          regs.set(inst.dst, inst.ptr.k === 'global' ? globals.get(inst.ptr.name)! : slots.get((inst.ptr as { name: string }).name)!);
          break;
        case 'store':
          if (inst.ptr.k === 'global') globals.set(inst.ptr.name, value(inst.val));
          else slots.set((inst.ptr as { name: string }).name, value(inst.val));
          break;
        case 'bin': {
          const a = value(inst.a);
          const b = value(inst.b);
          regs.set(inst.dst, inst.kind === 'add' ? (a + b) | 0 : inst.kind === 'sub' ? (a - b) | 0 : Math.imul(a, b));
          break;
        }
        case 'icmp': {
          const a = value(inst.a);
          const b = value(inst.b);
          const result = inst.pred === 'slt' ? a < b : inst.pred === 'sle' ? a <= b : inst.pred === 'sgt' ? a > b : inst.pred === 'sge' ? a >= b : inst.pred === 'eq' ? a === b : a !== b;
          regs.set(inst.dst, result ? 1 : 0);
          break;
        }
        case 'call': regs.set(inst.dst, externs[inst.fn](...inst.args.map(value))); break;
        case 'br': next = inst.target; break;
        case 'condbr': next = value(inst.cond) ? inst.yes : inst.no; break;
        case 'ret': return { value: value(inst.val), globals, counts, steps };
        case 'phi': break;
      }
    }
    previous = block.name;
    block = byName.get(next!)!;
  }
}
