import { concept, irLine, wire } from '../decode/structures';
import { MAIN, SUM } from '../compiler';
import { interpret } from '../compiler/interp';
import { fmtInst, slotNames, type IrFunc } from '../compiler/ir';
import type { ArtView, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { cfgView, irLinesOf, shortIr } from './views';

const before = SUM.dce.fn;
const after = SUM.licm.fn;
const loop = SUM.licm.loops[0];
const scale = (value: number) => value * 2;
const run = (fn: IrFunc, n: number) => interpret(fn, [n], MAIN.module, { scale });
const N = 100;
const r0 = run(before, N);
const r1 = run(after, N);
const zero0 = run(before, 0);
const zero1 = run(after, 0);
const sizeOf = (fn: IrFunc) => fn.blocks.reduce((sum, block) => sum + block.insts.length, 0);
const hoistedText = fmtInst(after.blocks[0].insts[0], slotNames(after));

function cfg(fn: IrFunc, opts: { loop?: boolean; lit?: (text: string) => Tone | undefined; litBlock?: string; sub?: string; preheader?: boolean } = {}): ArtView {
  return cfgView({
    title: '控制流图',
    sub: opts.sub ?? '循环用黄色标出',
    width: 494,
    height: 472,
    boxW: 330,
    lines: (name) => irLinesOf(fn, name, (text) => ({ text: shortIr(text), tone: opts.lit?.(text) })),
    tone: (name) => (name === opts.litBlock ? 'green' : opts.loop && loop.blocks.includes(name) ? 'amber' : opts.preheader && name === loop.preheader ? 'teal' : undefined),
    edgeTone: (from, to) => (opts.loop && from === loop.latch && to === loop.header ? 'amber' : undefined),
  });
}

function verdictTable(count: number, lit?: string): ArtView {
  const list = SUM.licm.events;
  return {
    kind: 'table',
    title: '不变量判定',
    sub: `${Math.min(count, list.length)} / ${list.length}`,
    cols: ['指令', '结论', '原因'],
    widths: [50, 40, 246],
    rows: list.slice(0, count).map((event) => ({
      cells: [`%${event.dst}`, event.verdict === 'hoist' ? '外提' : '留下', shortWhy(event.why)],
      tone: event.dst === lit ? (event.verdict === 'hoist' ? 'green' as Tone : 'amber' as Tone) : undefined,
      tones: [null, event.verdict === 'hoist' ? 'green' as Tone : null, null],
    })),
    size: 11.5,
  };
}

const shortWhy = (why: string) => (why.startsWith('操作数都在循环外') ? '操作数都在循环外，也不会陷入' : why);

const costView = (showAfter: boolean): ArtView => ({
  kind: 'table',
  title: '真实运行次数',
  sub: `IR 解释器，n = ${N}`,
  cols: ['指标', '外提前', '外提后'],
  widths: [150, 90, 90],
  rows: [
    { cells: [`%mul1 执行次数，n=${N}`, String(r0.counts.get('mul1')), showAfter ? String(r1.counts.get('mul1')) : ''], tone: 'green' as Tone },
    { cells: [`全部指令数，n=${N}`, String(r0.steps), showAfter ? String(r1.steps) : ''] },
    { cells: ['%mul1 执行次数，n=0', String(zero0.counts.get('mul1') ?? 0), showAfter ? String(zero1.counts.get('mul1') ?? 0) : ''], tone: showAfter ? 'amber' as Tone : undefined },
    { cells: [`函数结果，n=${N}`, String(r0.value), showAfter ? String(r1.value) : ''] },
  ],
  size: 12,
});

const verdictEvents: PacketEvent[] = SUM.licm.events.map((event, index) => {
  const hoist = event.verdict === 'hoist';
  return pk('cfg', 'optimizer', hoist ? 'green' : 'slate', `%${event.dst}`, [hoist ? '可以外提' : '留在循环里'], [5, 'PASS', `%${event.dst}：${hoist ? '外提' : '留下'}，${shortWhy(event.why)}`, event.text.length],
    wire(`判断 ${event.block} 里的指令`, 'mem', 'text', irLine(event.text, hoist ? 'green' : 'slate'), concept('判定', [['结论', hoist ? '循环不变，可以外提' : '留在循环里'], ['原因', event.why]], hoist ? 'green' : 'slate')), {
      quick: true,
      art: { verdict: verdictTable(index + 1, event.dst), cfg: cfg(before, { loop: true, lit: (text) => (text === event.text ? (hoist ? 'green' : 'slate') : undefined) }) },
    });
});

export const licm: Lesson = seal({
  id: 'licm',
  name: 'LICM',
  title: '循环不变量外提',
  group: 'middle',
  layer: [5, 5],
  nodes: ['cfg', 'optimizer'],
  place: { cfg: [240, 56], optimizer: [660, 56] },
  labels: { cfg: ['控制流图', '优化后的 SSA'], optimizer: ['LICM', '循环不变量外提'] },
  panels: { cfg: [10, 146, 510, 520], verdict: [530, 146, 360, 230], cost: [530, 386, 360, 280] },
  initial: { cfg: cfg(before, { sub: '外提之前' }), verdict: verdictTable(0), cost: costView(false) },
  start: ['cfg'],
  legend: [['amber', '循环'], ['green', '可以外提'], ['slate', '留在循环里'], ['teal', '前置块']],
  overview: {
    full: '每轮都一样的计算，提到循环外面算一次',
    description: `n * 6 每轮结果都相同，却要算 n 次。LICM 找出循环里值不变的计算，把它提到循环之前。程序的结果不变，循环变快了。这是优化效果最明显的变换之一，因为程序的时间大多花在循环里。`,
    facts: [
      ['循环头', loop.header],
      ['循环块', loop.blocks.join(' ')],
      ['外提', SUM.licm.hoisted.map((name) => `%${name}`).join(' ')],
      [`n=${N} 的乘法`, `${r0.counts.get('mul1')} 次 → ${r1.counts.get('mul1')} 次`],
      ['对照工具', 'clang -mllvm -print-after=licm'],
    ],
  },
  steps: [
    {
      title: '找到循环',
      desc: '回边确定自然循环',
      detail: `循环的定义来自图：如果 A 跳到 B，而 B 支配 A，这条边就是回边。这里 ${loop.latch} → ${loop.header} 是回边。从回边的尾部沿前驱往回走，遇到 B 就停，走过的块就是循环体。这个定义不依赖源码写的是 while 还是 goto。`,
      facts: [['回边', `${loop.latch} → ${loop.header}`], ['循环块', loop.blocks.join(' ')], ['判断依据', 'B 支配 A']],
      events: [
        show('optimizer'),
        pk('cfg', 'optimizer', 'amber', '回边', [`${loop.latch} → ${loop.header}`], [5, 'PASS', `发现回边 ${loop.latch} → ${loop.header}，循环有 ${loop.blocks.length} 个块`, null],
          wire('循环结构是分析结果', 'mem', '示意', concept('自然循环', [['循环头', loop.header], ['回边来源', loop.latch], ['包含的块', loop.blocks.join(' ')]], 'amber')), { art: { cfg: cfg(before, { loop: true }) } }),
      ],
    },
    {
      title: '前置块',
      desc: '提出来的指令要有地方放',
      detail: `前置块是循环头在循环外的唯一前驱，并且只跳向循环头。放在这里的代码在进入循环前正好执行一次。这个函数的 ${loop.preheader} 恰好满足条件，不用新建。如果循环头有多个外部前驱，就要插入一个新块。`,
      facts: [['前置块', loop.preheader], ['需要新建吗', SUM.licm.createdPreheader ? '要' : '不用'], ['条件', '只跳向循环头']],
      events: [
        pk('optimizer', 'cfg', 'teal', '前置块', [loop.preheader], [5, 'PASS', `${loop.preheader} 是循环唯一的外部前驱，用它当前置块`, null],
          wire('前置块的跳转', 'mem', 'text', irLine(fmtInst(before.blocks[0].insts[0], slotNames(before)), 'teal', loop.preheader)), { art: { cfg: cfg(before, { loop: true, preheader: true, sub: '前置块用青色标出' }) } }),
      ],
    },
    {
      title: '判断不变量',
      desc: '操作数都在外面，结果就不变',
      detail: '指令的操作数全部在循环外定义，或者本身也是不变量，它的值就不会变。φ 每轮都变，所以依赖 φ 的指令都不行。%mul1 只用到 n 和常量 6，满足。%cmp 和 %add2 都依赖 φ，只能留下。判断时要反复扫，因为外提一条指令可能让另一条也变成不变量。',
      facts: [['不变', SUM.licm.hoisted.map((name) => `%${name}`).join(' ')], ['留下', SUM.licm.events.filter((event) => event.verdict === 'stay').map((event) => `%${event.dst}`).join(' ')], ['phi', '每轮都变']],
      events: verdictEvents,
    },
    {
      title: '外提',
      desc: '%mul1 搬进前置块',
      detail: `指令从循环体移到前置块的跳转之前，使用它的地方不用改，SSA 里名字还是 %mul1。解释器实际跑一遍 n=${N}：乘法从 ${r0.counts.get('mul1')} 次变成 ${r1.counts.get('mul1')} 次，总指令数从 ${r0.steps} 条减到 ${r1.steps} 条，函数结果都是 ${r0.value}。`,
      facts: [['新位置', loop.preheader], ['乘法次数', `${r0.counts.get('mul1')} → ${r1.counts.get('mul1')}`], ['结果', '不变']],
      events: [
        pk('optimizer', 'cfg', 'green', '外提 %mul1', [hoistedText], [5, 'PASS', `把 ${hoistedText} 移到 ${loop.preheader}`, hoistedText.length],
          wire('移动后的指令，文本不变', 'mem', 'text', irLine(hoistedText, 'green', loop.preheader)), { art: { cfg: cfg(after, { loop: true, lit: (text) => (text === hoistedText ? 'green' : undefined), sub: '外提之后' }), cost: costView(true) } }),
        note('optimizer', `乘法 ${r0.counts.get('mul1')} → ${r1.counts.get('mul1')} 次`, 'green'),
      ],
    },
    {
      title: '这样安全吗',
      desc: '循环可能一次都不跑',
      detail: `n ≤ 0 时循环体不执行，外提后却多算了一次乘法：表里 n=0 时从 ${zero0.counts.get('mul1') ?? 0} 次变成 ${zero1.counts.get('mul1') ?? 0} 次。乘法不会陷入，也没有副作用，多算一次无害。除法就不行：n / 0 提前执行会让本来安全的程序崩溃。clang 的做法是先把循环转成带守卫的形式，再提到 while.body.lr.ph，这样 n ≤ 0 时一次也不多算。`,
      facts: [['能外提', '不会陷入、没有副作用'], ['不能随便外提', '除法、读内存'], ['clang', '先循环旋转，再外提到 while.body.lr.ph']],
      events: [
        pk('optimizer', 'cfg', 'amber', 'n ≤ 0', [`mul 多算 1 次`], [5, 'PASS', `对照 n=0：%mul1 执行 ${zero0.counts.get('mul1') ?? 0} → ${zero1.counts.get('mul1') ?? 0} 次，结果都是 ${zero0.value}`, null],
          wire('真实运行 n=0', 'mem', '示意', concept('n=0 的运行结果', [['外提前', `${zero0.counts.get('mul1') ?? 0} 次乘法，${zero0.steps} 条指令`], ['外提后', `${zero1.counts.get('mul1') ?? 0} 次乘法，${zero1.steps} 条指令`], ['函数结果', `都是 ${zero0.value}`]], 'amber')), { art: { cost: costView(true) } }),
      ],
    },
  ],
  outro: {
    title: '中端到此结束',
    desc: `IR 从 ${sizeOf(SUM.o0)} 条变成 ${sizeOf(after)} 条`,
    text: `这里停在外提。真实的 clang -O1 走得更远：它的归纳变量分析能算出循环的闭式解，直接删掉整个循环，输出里连 while.body 都没有了。本站的小编译器没有实现这一步，好处是后端还能看到一个真实的循环。`,
    facts: [['输入', '-O0 的 IR'], ['输出', `${sizeOf(after)} 条 SSA 指令`], ['下一课', 'ISEL']],
  },
});
