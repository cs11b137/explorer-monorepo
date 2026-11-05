/** 线性扫描寄存器分配（Poletto & Sarkar 1999）：活跃区间按起点排序，扫一遍。 */
import { REG32, RAX, RBX, RCX, RDI, RDX, RSI, R8, R9, R12, R13, R14, R15 } from './x86';
import type { MBlock, MFunc, MInst, MOperand } from './isel';

/** 分配顺序：先用和调用约定不冲突的调用者保存寄存器，eax 和 edi 靠后，被调用者保存的放最后。r10、r11 留给溢出代码。 */
export const CALLER_POOL = [RCX, RDX, RSI, R8, R9, RAX, RDI];
export const CALLEE_POOL = [RBX, R12, R13, R14, R15];
export const FULL_POOL = [...CALLER_POOL, ...CALLEE_POOL];

export const CALLER_SAVED = new Set([RAX, RCX, RDX, RSI, RDI, R8, R9, 10, 11]);

export interface Interval {
  v: string;
  start: number;
  end: number;
  /** 想要的物理寄存器：来自和物理寄存器的复制。 */
  hints: number[];
  /** 想和谁同一个寄存器：来自复制和两地址指令。 */
  partners: string[];
  crossesCall: boolean;
}

export interface FixedRange { reg: number; from: number; to: number; why: string }

export interface Numbered { inst: MInst; pos: number; block: string }

export const defsOf = (inst: MInst): MOperand[] => {
  switch (inst.op) {
    case 'copy': case 'add3': case 'sub3': case 'imul3': case 'loadg': return [inst.d];
    default: return [];
  }
};

export const usesOf = (inst: MInst): MOperand[] => {
  switch (inst.op) {
    case 'copy': return [inst.s];
    case 'add3': case 'sub3': case 'imul3': case 'cmp': return [inst.a, inst.b];
    case 'storeg': return [inst.s];
    default: return [];
  }
};

const vregs = (list: MOperand[]) => list.flatMap((operand) => (operand.k === 'v' ? [operand.name] : []));

function blockSuccessors(blocks: MBlock[], index: number): string[] {
  const block = blocks[index];
  const out: string[] = [];
  let falls = true;
  for (const inst of block.insts) {
    if (inst.op === 'jcc') out.push(inst.label);
    if (inst.op === 'jmp') {
      out.push(inst.label);
      falls = false;
    }
    if (inst.op === 'ret') falls = false;
  }
  if (falls && blocks[index + 1]) out.push(blocks[index + 1].label);
  return out;
}

export interface Analysis {
  intervals: Interval[];
  fixed: FixedRange[];
  numbered: Numbered[];
  callPositions: number[];
  blockRanges: Array<{ name: string; from: number; to: number }>;
  liveOut: Map<string, string[]>;
}

/** 位置编号：第 i 条指令读操作数在 2i，写结果在 2i+1。一个值在 2i 结束时，下一个值可以从 2i+1 开始占同一个寄存器。 */
export function analyze(mf: MFunc): Analysis {
  const numbered: Numbered[] = [];
  const ranges = new Map<string, { from: number; to: number }>();
  let index = 0;
  for (const block of mf.blocks) {
    const from = index * 2;
    for (const inst of block.insts) numbered.push({ inst, pos: index++ * 2, block: block.name });
    ranges.set(block.label, { from, to: index * 2 - 1 });
  }
  const liveIn = new Map(mf.blocks.map((block) => [block.label, new Set<string>()]));
  const liveOut = new Map(mf.blocks.map((block) => [block.label, new Set<string>()]));
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = mf.blocks.length - 1; at >= 0; at--) {
      const block = mf.blocks[at];
      const out = new Set(blockSuccessors(mf.blocks, at).flatMap((label) => [...liveIn.get(label)!]));
      const live = new Set(out);
      for (const inst of [...block.insts].reverse()) {
        vregs(defsOf(inst)).forEach((name) => live.delete(name));
        vregs(usesOf(inst)).forEach((name) => live.add(name));
      }
      if (live.size !== liveIn.get(block.label)!.size || out.size !== liveOut.get(block.label)!.size) changed = true;
      liveIn.set(block.label, live);
      liveOut.set(block.label, out);
    }
  }
  const map = new Map<string, Interval>();
  const touch = (name: string, pos: number) => {
    const item = map.get(name);
    if (!item) map.set(name, { v: name, start: pos, end: pos, hints: [], partners: [], crossesCall: false });
    else {
      item.start = Math.min(item.start, pos);
      item.end = Math.max(item.end, pos);
    }
  };
  for (const block of mf.blocks) {
    const range = ranges.get(block.label)!;
    liveIn.get(block.label)!.forEach((name) => touch(name, range.from));
    liveOut.get(block.label)!.forEach((name) => touch(name, range.to));
  }
  const fixed: FixedRange[] = [];
  const callPositions: number[] = [];
  const open = new Map<number, number>();
  const hint = (name: string, reg: number) => {
    const item = map.get(name)!;
    if (!item.hints.includes(reg)) item.hints.push(reg);
  };
  for (const { inst, pos } of numbered) {
    vregs(usesOf(inst)).forEach((name) => touch(name, pos));
    vregs(defsOf(inst)).forEach((name) => touch(name, pos + 1));
    if (inst.op === 'copy') {
      if (inst.d.k === 'p' && inst.s.k === 'v') hint(inst.s.name, inst.d.n);
      if (inst.s.k === 'p' && inst.d.k === 'v') hint(inst.d.name, inst.s.n);
      if (inst.d.k === 'v' && inst.s.k === 'v') {
        map.get(inst.d.name)!.partners.push(inst.s.name);
        map.get(inst.s.name)!.partners.push(inst.d.name);
      }
      if (inst.d.k === 'p') {
        // 物理寄存器从被写入起就被占用，到使用它的那条指令为止。
        if (inst.why === 'argset') open.set(inst.d.n, pos + 1);
        if (inst.why === 'retval') fixed.push({ reg: inst.d.n, from: pos + 1, to: pos + 3, why: '返回值' });
      }
      if (inst.s.k === 'p') {
        if (inst.why === 'arg') fixed.push({ reg: inst.s.n, from: -1, to: pos, why: '传入的参数' });
        if (inst.why === 'ret') fixed.push({ reg: inst.s.n, from: pos - 1, to: pos, why: '函数返回值' });
      }
    }
    if (inst.op === 'add3' || inst.op === 'sub3' || inst.op === 'imul3') {
      if (inst.d.k === 'v' && inst.a.k === 'v') map.get(inst.d.name)!.partners.push(inst.a.name);
    }
    if (inst.op === 'call') {
      callPositions.push(pos);
      for (const [reg, from] of open) fixed.push({ reg, from, to: pos, why: '传给被调函数的实参' });
      open.clear();
      for (const reg of CALLER_SAVED) fixed.push({ reg, from: pos, to: pos + 1, why: '调用会破坏调用者保存寄存器' });
    }
  }
  const intervals = [...map.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const item of intervals) item.crossesCall = callPositions.some((pos) => item.start < pos && item.end > pos);
  return {
    intervals,
    fixed,
    numbered,
    callPositions,
    blockRanges: mf.blocks.map((block) => ({ name: block.name, ...ranges.get(block.label)! })),
    liveOut: new Map([...liveOut].map(([label, set]) => [label, [...set]])),
  };
}

export interface AllocEvent {
  v: string;
  start: number;
  end: number;
  expired: Array<{ v: string; reg: number }>;
  activeBefore: Array<{ v: string; reg: number; end: number }>;
  blocked: Array<{ reg: number; why: string }>;
  reg: number | null;
  reason: string;
  /** 为腾出寄存器被踢去内存的区间。 */
  evicted: string | null;
}

export interface Allocation {
  assign: Map<string, number>;
  spilled: string[];
  events: AllocEvent[];
  usedCallee: number[];
  maxPressure: number;
}

export function linearScan(analysis: Analysis, pool: number[] = FULL_POOL): Allocation {
  const assign = new Map<string, number>();
  const spilled: string[] = [];
  const events: AllocEvent[] = [];
  let active: Array<{ v: string; reg: number; end: number; start: number }> = [];
  let maxPressure = 0;
  const conflictWithFixed = (reg: number, item: Interval) => analysis.fixed.find((range) => range.reg === reg && range.from <= item.end && item.start <= range.to);
  for (const item of analysis.intervals) {
    const expired = active.filter((entry) => entry.end < item.start);
    active = active.filter((entry) => entry.end >= item.start);
    const busy = new Set(active.map((entry) => entry.reg));
    const blocked: AllocEvent['blocked'] = [];
    const free: number[] = [];
    for (const reg of pool) {
      if (busy.has(reg)) continue;
      const fixed = conflictWithFixed(reg, item);
      if (fixed) blocked.push({ reg, why: fixed.why });
      else free.push(reg);
    }
    const event: AllocEvent = {
      v: item.v,
      start: item.start,
      end: item.end,
      expired: expired.map((entry) => ({ v: entry.v, reg: entry.reg })),
      activeBefore: active.map((entry) => ({ v: entry.v, reg: entry.reg, end: entry.end })),
      blocked,
      reg: null,
      reason: '',
      evicted: null,
    };
    let picked: number | undefined = item.hints.find((reg) => free.includes(reg));
    if (picked !== undefined) event.reason = `和 ${REG32[picked]} 有复制关系，分到它就省一条 mov`;
    if (picked === undefined) {
      for (const partner of item.partners) {
        const reg = assign.get(partner);
        if (reg !== undefined && free.includes(reg)) {
          picked = reg;
          event.reason = `${partner} 刚好结束，复用 ${REG32[reg]}`;
          break;
        }
      }
    }
    if (picked === undefined && free.length) {
      picked = free[0];
      event.reason = item.crossesCall && CALLEE_POOL.includes(picked) ? '跨过了 call，只能放被调用者保存的寄存器' : `按分配顺序第一个空闲的是 ${REG32[picked]}`;
    }
    if (picked === undefined) {
      // 没有空闲寄存器：比较结束得最晚的那个，谁结束晚谁去内存。
      const candidates = active.filter((entry) => !conflictWithFixed(entry.reg, item));
      const victim = candidates.sort((a, b) => b.end - a.end)[0];
      if (victim && victim.end > item.end) {
        picked = victim.reg;
        assign.delete(victim.v);
        spilled.push(victim.v);
        active = active.filter((entry) => entry !== victim);
        event.evicted = victim.v;
        event.reason = `寄存器用完了。${victim.v} 结束得最晚，把它踢去内存，${item.v} 用 ${REG32[picked]}`;
      } else {
        spilled.push(item.v);
        event.reason = `寄存器用完了。${item.v} 自己结束得最晚，它去内存`;
      }
    }
    if (picked !== undefined) {
      event.reg = picked;
      assign.set(item.v, picked);
      active.push({ v: item.v, reg: picked, end: item.end, start: item.start });
    }
    maxPressure = Math.max(maxPressure, active.length);
    events.push(event);
  }
  const usedCallee = CALLEE_POOL.filter((reg) => [...assign.values()].includes(reg));
  return { assign, spilled, events, usedCallee, maxPressure };
}
