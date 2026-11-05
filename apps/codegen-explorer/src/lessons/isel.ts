import { irLine, registers, textBytes, wire } from '../decode/structures';
import { SUM } from '../compiler';
import type { SelectEvent } from '../compiler/isel';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { irView } from './views';

const mir = SUM.mir;
const fn = SUM.licm.fn;
const all = mir.events;
const flat = mir.blocks.flatMap((block) => block.insts.map((_, index) => ({ block: block.name, label: block.label, index })));

/** 事件 → 它产生的 MIR 行在总表里的下标。 */
const positions: Array<number[]> = [];
{
  let at = 0;
  for (const event of all) {
    positions.push(event.mir.map(() => at++));
  }
}
const textAt = all.flatMap((event) => event.mir);

function mirView(shown: Set<number>, fresh: Set<number>, sub: string, tone: Tone = 'amber'): ArtView {
  const lines: CodeLine[] = [];
  let focus: number | undefined;
  let last = '';
  flat.forEach((item, index) => {
    if (item.block !== last) {
      last = item.block;
      lines.push({ text: `${item.label}:  ; ${item.block}`, head: true });
    }
    if (!shown.has(index)) return;
    if (fresh.has(index) && focus === undefined) focus = lines.length;
    lines.push({ text: `  ${textAt[index]}`, tone: fresh.has(index) ? tone : undefined });
  });
  return { kind: 'code', title: '机器 IR（MIR）', sub, lines, focus };
}

function rulesView(rows: Array<[string, string]>, lit?: number): ArtView {
  return {
    kind: 'table',
    title: '选中的模式',
    sub: `${rows.length} 条`,
    cols: ['IR 模式', '机器指令'],
    widths: [118, 288],
    rows: rows.slice(-5).map(([a, b], index, list) => ({ cells: [a, b], tone: index === list.length - 1 && lit !== undefined ? 'amber' as Tone : undefined })),
    size: 11.5,
  };
}

const shown = new Set<number>();
const rules: Array<[string, string]> = [];

function eventFor(event: SelectEvent, label: string, rule: [string, string], color: 'amber' | 'blue' | 'green' | 'violet' = 'amber', quick = true): PacketEvent {
  const index = all.indexOf(event);
  const fresh = new Set(positions[index]);
  fresh.forEach((at) => shown.add(at));
  rules.push(rule);
  const irText = event.ir.split('\n');
  const layers = irText.filter((text) => /^%|^br|^store|^ret|^call/.test(text)).map((text) => irLine(text, 'teal', '输入的 IR'));
  const out = textBytes('输出的 MIR', event.mir.join('\n') || '（不产生指令）', color, event.rule);
  return pk('ir', 'isel', color, label, [event.mir[0] ?? '不产生指令'], [6, 'ISEL', `${rule[0]} → ${event.mir.join('；') || '不产生指令'}`, null],
    wire(`基本块 ${event.block} 的模式匹配`, 'mem', 'text', ...layers, out), {
      quick,
      art: {
        mir: mirView(new Set(shown), fresh, `${shown.size} 条`, color === 'green' ? 'green' : 'amber'),
        rules: rulesView([...rules], 0),
        ir: irView(fn, { title: 'LLVM IR', sub: '选择的输入', tone: (text) => (event.ir.includes(text) ? 'amber' : undefined) }),
      },
    });
}

const phiCopies = all.filter((event) => event.ir.startsWith('φ'));
const byIr = (test: (text: string) => boolean) => all.find((event) => test(event.ir))!;
const argCopy = byIr((text) => text.startsWith('参数'));
const mulEvent = byIr((text) => text.includes('mul nsw'));
const adds = all.filter((event) => event.ir.includes('add nsw') && !event.ir.includes('%call'));
const cmpEvent = byIr((text) => text.includes('icmp'));
const storeEvent = byIr((text) => text.startsWith('store'));
const callEvent = byIr((text) => text.includes('@scale'));
const add5Event = byIr((text) => text.includes('%add5 ='));
const retEvent = byIr((text) => text.startsWith('ret'));
const brEvents = all.filter((event) => event.ir.startsWith('br label'));

const fallBr = brEvents.find((event) => !event.mir.length)!;
const jumpBr = brEvents.find((event) => event.mir.length)!;

const fixedLayer = () => registers('调用约定固定的寄存器', [['edi', '第 1 个整数参数。'], ['eax', '返回值。']], 'violet', 'System V AMD64 ABI');

export const isel: Lesson = seal({
  id: 'isel',
  name: 'ISEL',
  title: '指令选择',
  group: 'back',
  layer: [6, 6],
  nodes: ['ir', 'isel', 'regalloc'],
  place: { ir: [140, 56], isel: [450, 56], regalloc: [760, 56] },
  labels: { ir: ['SSA IR', '优化之后'], isel: ['指令选择', '模式匹配'], regalloc: ['寄存器分配', '下一课'] },
  panels: { ir: [10, 146, 430, 350], rules: [10, 506, 430, 160], mir: [450, 146, 440, 520] },
  initial: { ir: irView(fn, { title: 'LLVM IR', sub: '选择的输入' }), rules: rulesView([]), mir: mirView(new Set(), new Set(), '0 条') },
  start: ['ir', 'isel'],
  legend: [['violet', '消去 φ'], ['amber', '选指令'], ['green', '调用约定'], [null, '%名字是虚拟寄存器，$名字是物理寄存器']],
  overview: {
    full: '把通用的 IR 换成 x86-64 的指令',
    description: 'IR 不关心具体 CPU，机器指令却有各种限制：两地址、固定寄存器、特定的寻址方式。指令选择把 IR 的模式对应到机器指令，同时消掉 φ。寄存器还没分配，所以输出里仍然是虚拟寄存器，这种中间形式叫 MIR。',
    facts: [
      ['目标', 'x86-64，32 位操作数'],
      ['输入', `${fn.blocks.reduce((sum, block) => sum + block.insts.length, 0)} 条 SSA 指令`],
      ['输出', `${flat.length} 条 MIR`],
      ['φ 变成', `${mir.phiCopies.length} 条复制`],
      ['调用约定', 'System V AMD64'],
    ],
  },
  steps: [
    {
      title: '消去 φ',
      desc: 'φ 变成前驱块末尾的复制',
      detail: 'CPU 没有 φ。%s.0 = phi [0, entry], [%add3, body] 的意思是：从 entry 来时等于 0，从 body 来时等于 %add3。那就在 entry 末尾写一次 COPY %s.0, 0，在 body 末尾写一次 COPY %s.0, %add3。如果前驱有多个后继，要先把这条边拆开，否则复制会影响别的路径。这里没有这种边。',
      facts: [['φ', '2 个'], ['复制', `${phiCopies.length} 条`], ['副作用', '%s.0 不再只赋值一次，SSA 到此结束']],
      events: [...phiCopies.map((event, index) => eventFor(event, `φ 的复制 ${index + 1}`, [`φ 入边 ${index + 1}`, event.mir[0]], 'violet', index > 0)), show('regalloc')],
    },
    {
      title: '选算术指令',
      desc: '乘常数有专门的三操作数形式',
      detail: 'x86 的 add 只有两个操作数，结果会覆盖第一个，而 IR 是三地址的。这里先用伪指令 ADD d, a, b 记下来，等分配完寄存器再定：d 和 a 相同就是 add，不同就用 lea。乘常数更好办，imul r, r/m, imm 本来就有三个操作数。',
      facts: [['mul %n, 6', 'IMUL %mul1, %n, 6'], ['add', '分配后才定 add 还是 lea'], ['参数', '从 $edi 复制出来']],
      events: [
        eventFor(argCopy, '参数', ['参数 n', argCopy.mir[0]], 'green', false),
        eventFor(mulEvent, 'mul', ['mul %n, 常数', mulEvent.mir[0]]),
        ...adds.map((event) => eventFor(event, 'add', [event.ir.split(' = ')[0] + ' = add', event.mir[0]])),
      ],
    },
    {
      title: '比较加分支',
      desc: '两条 IR 合成两条机器指令',
      detail: 'icmp 和 br 要一起看：x86 的比较只改标志位，分支再读标志位。下一个块就是 while.body，所以真分支直接往下走，只有假分支需要跳。条件要反过来：i < n 时继续，所以写成 i ≥ n 时跳走，也就是 JGE。这样循环内少走一次跳转。',
      facts: [['slt', '反过来是 JGE'], ['落空', '真分支是下一个块'], ['标志位', 'cmp 和 jcc 之间不能插别的算术']],
      events: [eventFor(cmpEvent, 'cmp + jge', ['icmp + br', cmpEvent.mir.join(' ; ')], 'amber', false)],
    },
    {
      title: '调用约定',
      desc: '实参和返回值的寄存器是规定好的',
      detail: 'System V 规定：前六个整数参数放在 rdi、rsi、rdx、rcx、r8、r9，返回值放在 rax。所以调用 scale 前要把实参复制进 $edi，调用后从 $eax 取结果。$ 开头的是物理寄存器，它们给后面的分配器加了约束。全局变量用 RIP 相对寻址，这样代码放在哪个地址都能跑。',
      facts: [['第 1 参数', 'edi'], ['返回值', 'eax'], ['全局变量', 'RIP 相对']],
      events: [
        eventFor(storeEvent, 'store', ['store @全局', storeEvent.mir[0]], 'amber', false),
        eventFor(callEvent, 'call', ['call @f(x)', callEvent.mir.join(' ; ')], 'green'),
        eventFor(add5Event, 'add', ['%add5 = add', add5Event.mir[0]]),
        eventFor(retEvent, 'ret', ['ret %x', retEvent.mir.join(' ; ')], 'green'),
      ],
    },
    {
      title: '块的摆放',
      desc: '能落空就不写跳转',
      detail: '基本块在内存里是连续摆放的。entry 的 br 目标就是下一个块，什么都不用写。while.body 末尾要跳回去，才需要 JMP。选完之后，这段 MIR 已经很像汇编了，只差一件事：把 %名字 换成真正的寄存器。',
      facts: [['省掉的跳转', 'entry → while.cond'], ['留下的跳转', 'while.body → while.cond'], ['MIR 总数', String(flat.length)]],
      events: [
        eventFor(fallBr, 'br（省掉）', ['br 到下一个块', '不写指令'], 'amber', false),
        eventFor(jumpBr, 'br', ['br 回到循环头', jumpBr.mir[0]]),
        pk('isel', 'regalloc', 'blue', 'MIR', [`${flat.length} 条`], [6, 'ISEL', `输出 ${flat.length} 条 MIR，虚拟寄存器 ${SUM.back.analysis.intervals.length} 个，交给寄存器分配`, 'reg'],
          wire('物理寄存器约束来自调用约定', 'regs', 'spec', fixedLayer()), {}),
        note('regalloc', '只差寄存器了', 'green'),
      ],
    },
  ],
  outro: {
    title: '从通用走向具体',
    desc: '指令选择之后，程序只属于 x86-64 了',
    text: '真实的 LLVM 用 SelectionDAG 或 GlobalISel，由 TableGen 描述的上千条模式驱动，可以把好几条 IR 合成一条复杂指令。这里只用几条手写的规则，但问题是一样的：用目标机的指令覆盖 IR，并且满足它的种种约束。',
    facts: [['约束', '两地址、固定寄存器'], ['φ', '已经消失'], ['下一课', 'REGALLOC']],
  },
});

