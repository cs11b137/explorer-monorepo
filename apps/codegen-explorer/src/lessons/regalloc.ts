import { concept, makeLayer, registers, textBytes, wire } from '../decode/structures';
import { SUM, TIGHT_ALLOC, TIGHT_POOL } from '../compiler';
import { CALLEE_POOL, FULL_POOL, type AllocEvent, type Interval } from '../compiler/regalloc';
import { fmtMInst } from '../compiler/isel';
import { fmtIns, REG32 } from '../compiler/x86';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { art, note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';

const { analysis, allocation, lowered } = SUM.back;
const { intervals, blockRanges, callPositions } = analysis;
const maxPos = Math.max(...intervals.map((item) => item.end)) + 2;
const BANDS = blockRanges.map((range) => ({ from: range.from, to: range.to + 1, label: range.name.replace('while.', '') }));
const MARKS = callPositions.map((at) => ({ at, label: 'call' }));

function bars(shown: Interval[], assign: Map<string, number>, opts: { cursor?: number; lit?: string; spilled?: string[]; sub?: string; title?: string } = {}): ArtView {
  return {
    kind: 'bars',
    title: opts.title ?? '活跃区间',
    sub: opts.sub ?? `${shown.length} / ${intervals.length} 个虚拟寄存器`,
    max: maxPos,
    bands: BANDS,
    marks: MARKS,
    cursor: opts.cursor,
    rows: intervals.map((item) => {
      const visible = shown.includes(item);
      const reg = assign.get(item.v);
      const spilled = opts.spilled?.includes(item.v);
      return {
        label: `%${item.v}`,
        start: visible ? item.start : 0,
        end: visible ? item.end : 0,
        tone: item.v === opts.lit ? 'amber' as Tone : reg !== undefined ? (CALLEE_POOL.includes(reg) ? 'violet' as Tone : 'blue' as Tone) : undefined,
        dim: !visible,
        dash: spilled,
        value: spilled ? '内存' : reg !== undefined ? REG32[reg] : '',
      };
    }),
  };
}

const roleOf = (reg: number) => (CALLEE_POOL.includes(reg) ? '被调用者保存' : '调用者保存');

function regTable(pool: number[], active: Array<{ v: string; reg: number }>, lit?: number, sub = '当前占用'): ArtView {
  return {
    kind: 'table',
    title: '寄存器分配表',
    sub,
    cols: ['寄存器', '谁保存', '现在是谁'],
    widths: [60, 96, 120],
    rows: pool.map((reg) => {
      const holder = active.find((item) => item.reg === reg);
      return { cells: [REG32[reg], roleOf(reg), holder ? `%${holder.v}` : ''], tone: reg === lit ? 'amber' as Tone : undefined, tones: [null, null, holder ? (CALLEE_POOL.includes(reg) ? 'violet' as Tone : 'blue' as Tone) : null] };
    }),
    size: 12,
  };
}

/** 每条 MIR 对应的真实指令。分配之后才知道 add 该写成 add 还是 lea。 */
const pairs = SUM.mir.blocks.flatMap((block) => block.insts.map((inst) => {
  const mir = fmtMInst(inst);
  return { mir, asm: lowered.lines.filter((line) => line.mir === mir).map((line) => fmtIns(line.ins)) };
}));

function pairsView(lit?: (mir: string) => boolean, sub = 'MIR → x86-64'): ArtView {
  const lines: CodeLine[] = pairs.map((pair) => ({
    text: `${pair.mir.padEnd(26)}${pair.asm.join(' ; ') || '（删除）'}`,
    tone: lit?.(pair.mir) ? 'green' : undefined,
    dim: !pair.asm.length && !lit?.(pair.mir),
  }));
  return { kind: 'code', title: '改写结果', sub, lines, size: 12 };
}

const empty = (sub: string): ArtView => ({ kind: 'code', title: '改写结果', sub, lines: pairs.map((pair) => ({ text: pair.mir, dim: true })), size: 12 });

const intervalEvents: PacketEvent[] = intervals.map((item, index) =>
  pk('isel', 'regalloc', 'blue', `%${item.v}`, [`[${item.start}, ${item.end}]`], [6, 'REG', `%${item.v} 的活跃区间是 [${item.start}, ${item.end}]${item.crossesCall ? '，跨过了 call' : ''}`, null],
    wire('区间由活跃分析算出', 'mem', '示意', concept(`活跃区间 · %${item.v}`, [['开始', String(item.start), '第一次写入的位置。'], ['结束', String(item.end), '最后一次用到的位置。循环里活跃的值要延伸到回边。'], ['跨过 call', item.crossesCall ? '是' : '否']], 'blue')), {
      quick: true,
      art: { bars: bars(intervals.slice(0, index + 1), new Map(), { lit: item.v }) },
    }));

function allocEventPacket(event: AllocEvent, index: number): PacketEvent {
  const reg = event.reg!;
  const assign = new Map(allocation.events.slice(0, index + 1).flatMap((item) => (item.reg === null ? [] : [[item.v, item.reg] as [string, number]])));
  const active = [...event.activeBefore, { v: event.v, reg, end: event.end }];
  const layers = [registers(`%${event.v} → ${REG32[reg]}`, [[REG32[reg], event.reason]], CALLEE_POOL.includes(reg) ? 'violet' : 'blue', roleOf(reg))];
  if (event.expired.length) {
    const freed = makeLayer('到期释放', 'slate');
    event.expired.forEach((item) => freed.field(`%${item.v}`, REG32[item.reg], () => {}, { note: '区间已经结束，寄存器回到空闲池。' }));
    layers.push(freed);
  }
  return pk('isel', 'regalloc', CALLEE_POOL.includes(reg) ? 'violet' : 'blue', `%${event.v} → ${REG32[reg]}`, [event.reason.slice(0, 20)], [6, 'REG', `位置 ${event.start}：%${event.v} → ${REG32[reg]}。${event.reason}`, 'reg'],
    wire('线性扫描的一步', 'regs', 'spec', ...layers), {
      quick: index > 0,
      art: { bars: bars(intervals, assign, { cursor: event.start, lit: event.v, sub: `处理到位置 ${event.start}` }), regs: regTable(FULL_POOL, active, reg) },
    });
}

const allocEvents = allocation.events.map(allocEventPacket);

const rewriteOf = (needle: string) => pairs.find((pair) => pair.asm.some((text) => text.startsWith(needle)))!;
const leaPair = rewriteOf('lea esi');
const addPair = rewriteOf('add esi');
const movPair = rewriteOf('mov edi');
const xorPair = rewriteOf('xor edi');
const removed = pairs.filter((pair) => !pair.asm.length);

const rewrite = (pair: (typeof pairs)[number], label: string, why: string, quick = true): PacketEvent => {
  const text = pair.asm.join('\n') || '（这条复制被删除了）';
  return pk('regalloc', 'isel', 'green', label, [pair.asm[0] ?? '删除'], [6, 'REG', `${pair.mir} → ${pair.asm.join('；') || '删除'}`, null],
    wire('改写后的汇编文本', 'mem', 'text', textBytes('x86-64 指令', text, 'green', pair.mir), concept('为什么这样写', [['原因', why]], 'green')), {
      quick,
      art: { pairs: pairsView((mir) => mir === pair.mir) },
    });
};

const tightAssign = new Map<string, number>();
const tightEvents: PacketEvent[] = TIGHT_ALLOC.events.filter((event) => event.evicted).map((event) => {
  tightAssign.clear();
  const upto = TIGHT_ALLOC.events.indexOf(event);
  TIGHT_ALLOC.events.slice(0, upto + 1).forEach((item) => {
    if (item.reg !== null) tightAssign.set(item.v, item.reg);
    if (item.evicted) tightAssign.delete(item.evicted);
  });
  const evictedSoFar = TIGHT_ALLOC.events.slice(0, upto + 1).flatMap((item) => (item.evicted ? [item.evicted] : []));
  return pk('regalloc', 'isel', 'amber', `溢出 %${event.evicted}`, [`让给 %${event.v}`], [6, 'SPILL', event.reason, null],
    wire('假设只有 4 个寄存器，真实跑同一个算法', 'mem', '示意', concept('溢出决策', [['新来的区间', `%${event.v}，结束于 ${event.end}`], ['被踢的区间', `%${event.evicted}`], ['选择依据', '结束得最晚的那个，这样腾出的寄存器能用得最久']], 'amber')), {
      art: {
        bars: bars(intervals, new Map(tightAssign), { cursor: event.start, lit: event.v, spilled: evictedSoFar, sub: `只有 ${TIGHT_POOL.length} 个寄存器`, title: '假设：寄存器很少' }),
        regs: regTable(TIGHT_POOL, [...event.activeBefore.filter((item) => item.v !== event.evicted), { v: event.v, reg: event.reg!, end: event.end }], event.reg!, '假设只有 4 个'),
      },
    });
});

const usedRegs = [...new Set(allocation.assign.values())].map((reg) => REG32[reg]);

export const regalloc: Lesson = seal({
  id: 'regalloc',
  name: 'REGALLOC',
  title: '线性扫描分配',
  group: 'back',
  layer: [6, 6],
  nodes: ['isel', 'regalloc'],
  place: { isel: [240, 56], regalloc: [660, 56] },
  labels: { isel: ['MIR', '虚拟寄存器'], regalloc: ['寄存器分配', '线性扫描'] },
  panels: { bars: [10, 146, 570, 300], pairs: [10, 456, 570, 210], regs: [590, 146, 300, 310] },
  initial: { bars: bars([], new Map()), pairs: empty('还没有分配'), regs: regTable(FULL_POOL, [], undefined, '全部空闲') },
  start: ['isel'],
  legend: [['blue', '调用者保存'], ['violet', '被调用者保存'], ['green', '改写指令'], ['amber', '溢出']],
  overview: {
    full: '无限的虚拟寄存器，映射到有限的物理寄存器',
    description: 'x86-64 只有 16 个通用寄存器，还要除去 rsp 和 rbp。分配器要决定每个值放在哪里，放不下的只能去内存。线性扫描把每个值看成一段区间，按起点排序扫一遍，又快又好懂，JIT 编译器常用它。',
    facts: [
      ['算法', 'Poletto & Sarkar 1999'],
      ['虚拟寄存器', `${intervals.length} 个`],
      ['用到的物理寄存器', usedRegs.join(' ')],
      ['同时占用最多', `${allocation.maxPressure} 个`],
      ['溢出', `${allocation.spilled.length} 个`],
    ],
  },
  steps: [
    {
      title: '活跃区间',
      desc: '每个值从第一次写活到最后一次读',
      detail: '把指令排成一行编号，读操作数在偶数位置，写结果在奇数位置。这样一个值刚好结束时，下一条指令的结果可以用同一个寄存器。循环里的值要特别处理：%s.0 在回边上还活着，区间要盖住整个循环，这里用到了前面学的活跃分析。',
      facts: [['最长', `%${intervals[0].v}：[${intervals[0].start}, ${intervals[0].end}]`], ['只活一条指令', '%add2 %call %add5'], ['这里的简化', '区间没有空洞']],
      events: [show('regalloc'), ...intervalEvents],
    },
    {
      title: '跨越调用',
      desc: 'n 要活过 call，只能放 ebx',
      detail: '按起点扫描，先来的是 %n。它跨过了 call，而 System V 规定 call 可以随便改调用者保存寄存器，所以 ecx、edx 这些都不行，只能用被调用者保存的 ebx。代价是 sum 自己要在开头保存 ebx，结尾恢复。这也是栈帧里多一项的原因。',
      facts: [['%n', 'ebx'], ['调用者保存', 'rax rcx rdx rsi rdi r8–r11'], ['被调用者保存', 'rbx rbp r12–r15']],
      events: allocEvents.slice(0, 1),
    },
    {
      title: '按顺序分配',
      desc: '到期的先释放，再挑一个空闲的',
      detail: '每处理一个区间，先把已结束的释放，再看有没有空闲寄存器。优先满足复制关系：%s.0 将来要复制进 edi 当实参，直接分到 edi，那条复制就省了。%add3 的第一个操作数 %add2 恰好结束，于是复用 esi，正好符合 x86 的两地址形式。',
      facts: [['%s.0', 'edi，省一条 mov'], ['%add3', '复用 esi'], ['r8d', '第一个需要 REX 前缀的寄存器']],
      events: allocEvents.slice(1),
    },
    {
      title: '改写指令',
      desc: '现在才定 add 还是 lea',
      detail: `${leaPair.mir} 的目标和两个源都不同，用 lea 不破坏源操作数。${addPair.mir} 的目标和第一个源相同，用 add。复制到自己的指令直接删掉，一共删了 ${removed.length} 条。给寄存器清零用 xor 而不是 mov，因为它短 3 字节。`,
      facts: [['lea', leaPair.asm[0]], ['add', addPair.asm[0]], ['删除', `${removed.length} 条复制`]],
      events: [rewrite(leaPair, 'lea', '目标和两个源都不同。', false), rewrite(addPair, 'add', '目标和第一个源相同，两地址形式够用。'), rewrite(movPair, 'mov', '%s.0 的复制，寄存器不同，不能省。'), rewrite(xorPair, 'xor', '清零，xor edi, edi 只要 2 字节，mov edi, 0 要 5 字节。'), rewrite(removed[0], '删除', '源和目标是同一个寄存器。'), note('isel', `MIR 只剩 ${lowered.lines.filter((line) => line.group === 'body').length} 条`, 'green')],
    },
    {
      title: '寄存器不够时',
      desc: '结束最晚的去内存',
      detail: `换个假设：只给 ${TIGHT_POOL.map((reg) => REG32[reg]).join('、')} 四个寄存器，同样的算法跑一遍。%add2 来时全被占了，比较后发现 %n 结束得最晚，就把 %n 踢到栈上，把 ebx 让出来。这是线性扫描的启发式：结束得晚的占得久，踢它最划算。溢出的值每次使用都要读内存，所以循环里尤其要避免。`,
      facts: [['溢出的值', TIGHT_ALLOC.spilled.map((name) => `%${name}`).join(' ')], ['选择依据', '结束最晚'], ['说明', '这一步只演示分配结果']],
      events: [...tightEvents, note('regalloc', `溢出了 ${TIGHT_ALLOC.spilled.length} 个`, 'amber'), art({ bars: bars(intervals, allocation.assign, { sub: '回到真实分配' }), regs: regTable(FULL_POOL, [], undefined, '全部释放') })],
    },
  ],
  outro: {
    title: '一遍扫描，换来寄存器',
    desc: '简单、快，但不一定最优',
    text: '线性扫描只走一遍，时间接近线性，所以 JIT 喜欢它。图着色的结果通常更好，但慢得多。LLVM 默认用的 Greedy 分配器还能把区间切开，这里的简化版不行，所以 %s.0 的区间覆盖了它本不需要的部分。',
    facts: [['本站实现', '线性扫描，无区间分裂'], ['LLVM -O1 及以上', 'Greedy 分配器'], ['下一课', 'STACK FRAME']],
  },
});
