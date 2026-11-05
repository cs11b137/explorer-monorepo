import { irLine, textBytes, wire } from '../decode/structures';
import { MAIN, SUM } from '../compiler';
import { fmtInst, slotNames, type Inst } from '../compiler/ir';
import type { GenEvent } from '../compiler/irgen';
import { SOURCE, SOURCE_LINES } from '../compiler/source';
import { pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { irView, sourceView } from './views';

const events = MAIN.genEvents.get('sum')!;
const fn = SUM.o0;
const slots = slotNames(fn);
const lineOf = (event: GenEvent) => SOURCE.slice(0, event.span.from).split('\n').length;
const textOf = (inst: Inst) => fmtInst(inst, slots);
const allInsts = fn.blocks.reduce((sum, block) => sum + block.insts.length, 0);

/** 第 count 条事件之前已经写出的指令。 */
const knownAt = (count: number) => new Set(events.slice(0, count).map((event) => event.inst));

function emit(indices: number[], label: string, why: string, quick = true): PacketEvent {
  const list = indices.map((index) => events[index]);
  const first = list[0];
  const texts = list.map((event) => textOf(event.inst));
  const known = knownAt(indices[indices.length - 1] + 1);
  const fresh = new Set(list.map((event) => event.inst));
  const layers = texts.slice(0, 4).map((text) => irLine(text));
  return pk('irgen', 'ir', 'teal', label, [texts[0].slice(0, 34), ...(texts.length > 1 ? [`还有 ${texts.length - 1} 条`] : [])], [4, 'IR', `第 ${lineOf(first)} 行 → ${texts[0].replace(', align 4', '')}${texts.length > 1 ? ` 等 ${texts.length} 条` : ''}`, texts.reduce((sum, text) => sum + text.length, 0)],
    wire(`写入基本块 ${first.block}。${why}`, 'mem', 'text', ...layers), {
      quick,
      art: {
        ir: irView(fn, { title: 'LLVM IR', sub: `${known.size} / ${allInsts} 条`, known, tone: (_text, inst) => (fresh.has(inst) ? 'amber' : undefined), focus: texts[0] }),
        src: sourceView({ spans: list.slice(0, 1).map((event) => ({ span: event.span, tone: 'amber' as const })), size: 13, lines: [{ line: lineOf(first), tone: 'amber' }] }),
      },
    });
}

const idx = (test: (event: GenEvent) => boolean, from = 0) => events.findIndex((event, index) => index >= from && test(event));
const onLine = (line: number) => events.map((event, index) => (lineOf(event) === line ? index : -1)).filter((index) => index >= 0);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => from + offset);

const param = onLine(4);
const lineK = onLine(5);
const lineM = onLine(6);
const lineD = onLine(7);
const lineS = onLine(8);
const lineI = onLine(9);
const condStart = idx((event) => event.block === 'while.cond');
const bodyStart = idx((event) => event.block === 'while.body');
const endStart = idx((event) => event.block === 'while.end');
const entryBr = condStart - 1;
const assignLine = onLine(11);
const incLine = onLine(12);
const backBr = endStart - 1;
const totalLine = onLine(14);
const returnLine = onLine(15);

export const irgen: Lesson = seal({
  id: 'irgen',
  name: 'IR GEN',
  title: '生成三地址码',
  group: 'middle',
  layer: [4, 4],
  nodes: ['tree', 'irgen', 'ir'],
  place: { tree: [140, 56], irgen: [450, 56], ir: [760, 56] },
  labels: { tree: ['语法树', '带类型'], irgen: ['IR 生成器', '遍历语法树'], ir: ['LLVM IR', '三地址码'] },
  panels: { src: [10, 146, 330, 330], ir: [350, 146, 540, 520] },
  initial: { src: sourceView(), ir: irView(fn, { title: 'LLVM IR', sub: `0 / ${allInsts} 条`, known: new Set() }) },
  start: ['tree', 'irgen'],
  legend: [['blue', '遍历语法树'], ['teal', '写出 IR 指令'], [null, '指令文本和 clang -O0 逐行相同']],
  overview: {
    full: '把树压平成一条条简单指令',
    description: '语法树适合表达结构，不适合做优化，也离机器太远。IR 生成器遍历语法树，写出 LLVM IR：每条指令最多一个运算，中间结果都有名字，控制流变成基本块和跳转。这里的输出和 clang -O0 -emit-llvm 的函数体逐行相同。',
    facts: [
      ['目标形式', 'LLVM IR 文本'],
      ['指令总数', `${allInsts} 条`],
      ['基本块', `${fn.blocks.length} 个：${fn.blocks.map((block) => block.name).join(' ')}`],
      ['局部变量', '都放在栈槽里（alloca）'],
      ['对照工具', 'clang -S -emit-llvm -O0'],
    ],
  },
  steps: [
    {
      title: '变量变栈槽',
      desc: '每个变量先要一块内存',
      detail: '生成器不急着决定变量放哪个寄存器，先让每个变量都有一块栈内存：alloca。写变量就是 store，读变量就是 load。这样生成代码特别简单，不用考虑控制流。代价是有很多多余的内存访问，留给后面的 SSA 构造清理。',
      facts: [['%n.addr', '参数也要复制一份到栈上'], ['alloca', '都集中放在 entry 开头'], ['字面量', '直接写进指令']],
      events: [
        pk('tree', 'irgen', 'blue', 'sum', ['函数定义'], [4, 'IR', '开始翻译函数 sum', SOURCE_LINES[3].length],
          wire('语法树根节点对应的函数头', 'mem', 'text', textBytes('函数头', SOURCE_LINES[3], 'blue', '第 4 行')), { art: { src: sourceView({ lines: [{ line: 4, tone: 'blue' }] }) } }),
        show('ir'),
        emit(param, '参数 n', '参数先从寄存器存到栈槽。', false),
        emit(lineK, 'int k = 2', '局部变量一个 alloca，初始化就是 store。'),
      ],
    },
    {
      title: '拆开表达式',
      desc: '一条指令只做一件事',
      detail: 'int m = k * 3 要先读 k，再乘，再写 m，于是变成 load、mul、store 三条。中间结果 %0 和 %mul 都是虚拟寄存器，数量不限，也都只赋值一次。这就是三地址码：一个操作，两个输入，一个输出。',
      facts: [['%0', 'k 读出来的值'], ['%mul', 'k * 3 的结果'], ['nsw', '有符号溢出是未定义行为']],
      events: [emit([lineM[0]], '栈槽 m', '遇到声明，先要一个栈槽。'), emit([lineM[1]], 'load k', '读变量就是 load。'), emit([lineM[2]], 'mul', '运算结果放进新的虚拟寄存器。'), emit([lineM[3]], 'store m', '写变量就是 store。'), emit(lineD, 'int d', '和上一行一样的模式。'), emit(lineS, 'int s', '常量初始化不需要运算。'), emit(lineI, 'int i', '常量初始化不需要运算。')],
    },
    {
      title: '循环变基本块',
      desc: 'while 拆成三块，靠跳转连起来',
      detail: '机器没有 while，只有跳转。生成器把循环拆成 while.cond、while.body、while.end：条件块算出 i < n，再选择进循环体还是离开；循环体末尾跳回条件块。基本块的规矩是只从开头进、只从结尾出，这正是后面做分析的基础。',
      facts: [['while.cond', '算条件，两路分支'], ['while.body', '循环体，跳回 cond'], ['while.end', '循环之后的代码']],
      events: [emit([entryBr], 'br', 'entry 块结束，跳到条件块。', false), emit(range(condStart, bodyStart), 'i < n', '先 load，再比较，最后两路分支。')],
    },
    {
      title: '三地址码',
      desc: 's = s + m * n + i 变成 8 条指令',
      detail: '遍历语法树是后序的：先生成左右孩子，再生成自己。所以乘法排在第一个加法前面，第一个加法又排在第二个前面，这个顺序正是语法树决定的优先级和结合性。每个变量读一次就 load 一次，这里同一个 %n.addr 读了好几回。',
      facts: [['指令条数', `${assignLine.length} 条`], ['顺序', '语法树的后序遍历'], ['名字冲突', '加后缀变成 %mul1 %add2']],
      events: [...assignLine.map((index) => emit([index], textOf(events[index].inst).split(' ')[0], '后序遍历语法树。')), emit([...incLine, backBr].filter((value, index, all) => all.indexOf(value) === index), 'i = i + 1', '循环变量加一，然后跳回条件块。')],
    },
    {
      title: '函数收尾',
      desc: '写全局变量，调用函数，返回',
      detail: '全局变量 @total 的地址是常量，直接 store 过去。调用 scale 要先 load 实参，结果放进 %call。整个函数只有一个 return 且在末尾，所以直接生成 ret。把这份文本和 clang -O0 的函数体比较，除了属性和元数据注释，每一行都相同。',
      facts: [['@total', '全局变量，地址链接时才定'], ['%call', '函数的返回值'], ['独立核对', '和 clang -O0 逐行相同']],
      events: [emit(totalLine, 'total = s', '@ 开头的是全局名字。', false), emit(returnLine, 'return', '实参、调用、加法、返回。')],
    },
  ],
  outro: {
    title: '一棵树变成了一个函数体',
    desc: `${allInsts} 条指令，${fn.blocks.length} 个基本块`,
    text: '这份 IR 能跑，但很笨：每次用变量都访问内存，k 明明是常量还要 load。生成器故意写得简单，把聪明的事留给优化器。把它交给 clang -x ir 编译运行，结果和 C 源码一致，单元测试核对过。',
    facts: [['语言无关', 'Rust、Swift 等也生成 LLVM IR'], ['变量', '目前都在内存里'], ['下一课', 'DATAFLOW']],
  },
});

