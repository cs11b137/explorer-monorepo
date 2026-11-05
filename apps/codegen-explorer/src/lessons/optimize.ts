import { concept, irLine, makeLayer, wire } from '../decode/structures';
import { SUM } from '../compiler';
import { fmtInst, slotNames, type Inst, type IrFunc } from '../compiler/ir';
import { fmtLattice, type Lattice } from '../compiler/opt';
import type { ArtView, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { irView } from './views';

const ssaFn = SUM.ssa.fn;
const sccpResult = SUM.sccp;
const dceResult = SUM.dce;
const defs: string[] = [...ssaFn.params, ...ssaFn.blocks.flatMap((block) => block.insts.flatMap((inst) => ('dst' in inst ? [inst.dst] : [])))];

function latticeTable(values: Map<string, Lattice>, lit?: string, sub = '每个值的格'): ArtView {
  return {
    kind: 'table',
    title: '格的取值',
    sub,
    cols: ['值', '格', '值', '格'],
    widths: [76, 60, 76, 60],
    rows: Array.from({ length: Math.ceil(defs.length / 2) }, (_, row) => {
      const left = defs[row];
      const right = defs[row + Math.ceil(defs.length / 2)];
      const toneOf = (name: string | undefined, value: Lattice | undefined): Tone | null => (name && name === lit ? 'amber' : typeof value === 'number' ? 'green' : null);
      const lv = values.get(left);
      const rv = right ? values.get(right) : undefined;
      return {
        cells: [`%${left}`, fmtLattice(lv ?? 'top'), right ? `%${right}` : '', right ? fmtLattice(rv ?? 'top') : ''],
        tones: [null, toneOf(left, lv), null, toneOf(right, rv)],
      };
    }),
    size: 12,
  };
}

const listView = (title: string, sub: string, rows: Array<{ text: string; tone?: Tone; strike?: boolean; dim?: boolean }>): ArtView => ({ kind: 'code', title, sub, lines: rows, size: 12.5 });

const ssaView = (lit?: (text: string, inst: Inst) => Tone | undefined, strike?: (text: string) => boolean, fn: IrFunc = ssaFn, sub = 'SSA 形式', focus?: string): ArtView =>
  irView(fn, { title: 'LLVM IR', sub, tone: lit, strike, focus });

const values = new Map<string, Lattice>();
for (const param of ssaFn.params) values.set(param, 'bottom');

const sccpEvents: PacketEvent[] = sccpResult.events.map((event) => {
  values.set(event.dst, event.to);
  const constant = typeof event.to === 'number';
  const snapshot = new Map(values);
  return pk('ssa', 'optimizer', constant ? 'green' : 'amber', `%${event.dst}`, [`${fmtLattice(event.from)} → ${fmtLattice(event.to)}`], [5, 'PASS', `%${event.dst}：${fmtLattice(event.from)} → ${fmtLattice(event.to)}，${event.why}`, event.text.length],
    wire(`常量传播处理 ${event.block}`, 'mem', 'text', irLine(event.text, constant ? 'green' : 'amber'), concept('格的变化', [['之前', fmtLattice(event.from)], ['之后', fmtLattice(event.to)], ['原因', event.why]], constant ? 'green' : 'amber')), {
      quick: true,
      art: { lat: latticeTable(snapshot, event.dst), ir: ssaView((text) => (text === event.text ? (constant ? 'green' : 'amber') : undefined), undefined, ssaFn, 'SSA 形式', event.text) },
    });
});

/** 从哪里开始 φ 有事件：第一次出现 s.0 和第二次。 */
const phiEventIndex = sccpEvents.findIndex((_, index) => sccpResult.events[index].dst.includes('.0'));
const firstThree = sccpEvents.slice(0, Math.max(phiEventIndex, 2));
const others = sccpEvents.slice(Math.max(phiEventIndex, 2));

const seen = new Set<string>();
const replaced = sccpResult.replaced.filter((item) => {
  if (seen.has(item.before)) return false;
  seen.add(item.before);
  return true;
});
const replaceEvents: PacketEvent[] = replaced.map((item) =>
  pk('optimizer', 'ir', 'green', `%${item.dst} → ${item.value}`, [item.after.slice(0, 34)], [5, 'PASS', `把 %${item.dst} 换成 ${item.value}，得到 ${item.after}`, item.after.length],
    wire('替换前后的指令', 'mem', 'text', irLine(item.before, 'slate', '替换前'), irLine(item.after, 'green', '替换后')), {
      art: { ir: ssaView((text) => (text === item.after ? 'green' : undefined), undefined, sccpResult.fn, '常量传播之后', item.after) },
    }));

const removedRows = dceResult.removed.map((item) => ({ text: item.text, strike: true }));
const dceEvents: PacketEvent[] = dceResult.removed.map((item, index) =>
  pk('optimizer', 'ir', 'violet', `删 %${item.dst}`, [item.text.slice(0, 30)], [5, 'PASS', `%${item.dst} 没有被任何有副作用的指令用到，删除：${item.text}`, item.text.length],
    wire('被删掉的指令', 'mem', 'text', irLine(item.text, 'violet', '死代码'), concept('判断依据', [['有副作用吗', '没有，它只算一个值'], ['结果有人用吗', '没有'], ['结论', '删除不改变程序行为']], 'violet')), {
      quick: true,
      art: {
        ir: ssaView((text) => (text === item.text ? 'violet' : undefined), (text) => dceResult.removed.slice(0, index + 1).some((row) => row.text === text), sccpResult.fn, `已删 ${index + 1} 条`, item.text),
        del: listView('已删除', `${index + 1} 条`, removedRows.slice(0, index + 1)),
      },
    }));

const sizeOf = (fn: IrFunc) => fn.blocks.reduce((sum, block) => sum + block.insts.length, 0);
const mul1 = fmtInst(SUM.dce.fn.blocks.find((block) => block.name === 'while.body')!.insts[0], slotNames(SUM.dce.fn));

const legendLayer = makeLayer('三层的格', 'blue');
legendLayer.field('⊤（顶）', '还没算到', () => {}, { note: '乐观假设：可能是任何常量。' });
legendLayer.field('常量', '能确定是这个值', () => {}, { note: '例如 6。' });
legendLayer.field('⊥（底）', '运行时才知道', () => {}, { note: '例如参数 n。一旦到底就不再变化。' });

export const optimize: Lesson = seal({
  id: 'optimize',
  name: 'OPTIMIZE',
  title: '常量传播与死代码消除',
  group: 'middle',
  layer: [5, 5],
  nodes: ['ssa', 'optimizer', 'ir'],
  place: { ssa: [140, 56], optimizer: [450, 56], ir: [760, 56] },
  labels: { ssa: ['SSA IR', '优化的输入'], optimizer: ['优化器', 'SCCP + DCE'], ir: ['优化后的 IR', '更短更快'] },
  panels: { ir: [10, 146, 500, 520], lat: [520, 146, 370, 200], del: [520, 356, 370, 310] },
  initial: { ir: ssaView(), lat: latticeTable(new Map(ssaFn.params.map((param) => [param, 'bottom' as Lattice])), undefined, '开始前都是 ⊤'), del: listView('已删除', '0 条', [{ text: '还没有删除任何指令', dim: true }]) },
  start: ['ssa', 'optimizer'],
  legend: [['green', '得到常量'], ['amber', '落到 ⊥'], ['violet', '删除死代码']],
  overview: {
    full: '能提前算的不留到运行时',
    description: 'k 总是 2，所以 m 总是 6，这些都能在编译时算完。稀疏条件常量传播（SCCP）在 SSA 上跑工作列表，算出哪些值是常量；然后把常量代入，算出来的旧指令就没人用了，死代码消除再把它们删掉。',
    facts: [
      ['常量', `${[...sccpResult.values.values()].filter((value) => typeof value === 'number').length} 个`],
      ['删除指令', `${dceResult.removed.length} 条`],
      ['指令数', `${sizeOf(ssaFn)} → ${sizeOf(dceResult.fn)}`],
      ['算法', 'Wegman–Zadeck SCCP；标记清除 DCE'],
      ['对照工具', 'clang -O1 第二次 SROA 之后的 IR'],
    ],
  },
  steps: [
    {
      title: '三层的格',
      desc: '每个值要么未知、要么常量、要么运行时才知道',
      detail: '给每个 SSA 值一个状态：⊤ 表示还没算到，常量表示已经确定，⊥ 表示运行时才知道。状态只能从上往下走，不能回头，所以算法一定会结束。参数 n 一开始就是 ⊥，其他都从 ⊤ 开始，这种乐观的起点能多发现一些常量。',
      facts: [['⊤', '还没算到'], ['常量', '已经确定'], ['⊥', '运行时才知道']],
      events: [
        pk('ssa', 'optimizer', 'blue', '开始', [`${defs.length} 个值`], [5, 'PASS', `常量传播开始：${defs.length} 个值，参数 n 为 ⊥，其余为 ⊤`, null],
          wire('格是分析的状态', 'mem', '示意', legendLayer), { art: { lat: latticeTable(new Map(ssaFn.params.map((param) => [param, 'bottom' as Lattice])), undefined, 'n 是 ⊥，其余是 ⊤') } }),
        show('ir'),
      ],
    },
    {
      title: '算出常量',
      desc: '%mul 是 6，%add 是 7',
      detail: '从入口开始，%mul = mul nsw i32 2, 3 两边都是常量，直接算出 6。这里还要检查有符号溢出：nsw 标志下溢出的结果是 poison，不能当普通的数折叠。接着 %add 用到 %mul，它的操作数变了，被放回工作列表，算出 7。',
      facts: [['%mul', '6'], ['%add', '7'], ['工作列表', '操作数变了的指令再算一遍']],
      events: firstThree,
    },
    {
      title: '循环里的 φ',
      desc: '两条边的值不同，就是 ⊥',
      detail: 'φ 只看可达的边。第一次到 while.cond 时只有 entry 这条边可达，s.0 和 i.0 暂时是 0。沿着循环算回来，%add4 = 0 + 1 = 1，和入边的 0 不同，i.0 就落到 ⊥，之后的计算跟着变成 ⊥。乐观假设被推翻时，算法会把受影响的值重新算一遍，所以结论是可靠的。',
      facts: [['%i.0', '0 和 %add4 不同，是 ⊥'], ['%s.0', '⊥'], ['%mul1', `n 是 ⊥，所以 ⊥`]],
      events: others,
    },
    {
      title: '代入常量',
      desc: '%mul 的使用点换成 6',
      detail: `格算完后才改程序。%mul1 里的 %mul 换成 6，%add 里的 %mul 也换了。乘法满足交换律，常量统一放到右边，变成 ${mul1}。这和 LLVM 的规范形式一致，后端也更容易匹配带立即数的指令。`,
      facts: [['替换处数', String(replaced.length)], ['结果', mul1], ['规范化', '常量放右边']],
      events: replaceEvents,
    },
    {
      title: '删除死代码',
      desc: '没人用的计算可以直接删',
      detail: `从有副作用的指令出发：store、call、br、ret 必须保留，它们用到的值也保留，一路标记下去。没有被标记的就是死代码。%mul 和 %add 都不再被用到，于是源码里的 k、m、d 在机器码里彻底消失了。变量 d 从来没有用过，这很好理解；k 和 m 用过，但它们的值已经写进了指令。`,
      facts: [['删掉', dceResult.removed.map((item) => `%${item.dst}`).join(' ')], ['指令数', `${sizeOf(ssaFn)} → ${sizeOf(dceResult.fn)}`], ['独立核对', '和 clang 的中间结果相同']],
      events: [...dceEvents, note('ir', 'k m d 都不见了', 'green')],
    },
  ],
  outro: {
    title: '两个优化互相成全',
    desc: '传播制造死代码，消除让代码变短',
    text: `传播本身不删指令，只是让旧的计算没人用；DCE 负责删。真实的优化器有几十个这样的小阶段反复跑。这里的结果和 clang -O1 第二次 SROA 之后的 IR 相同，只差 clang 多推出来的一个 nuw 标志，本站没有做这类推导。`,
    facts: [['关键前提', 'SSA：每个值只有一个定义'], ['没做', '代数化简、公共子表达式消除'], ['下一课', 'LICM']],
  },
});
