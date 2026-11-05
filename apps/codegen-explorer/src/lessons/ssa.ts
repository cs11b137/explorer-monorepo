import { concept, irLine, makeLayer, wire } from '../decode/structures';
import { DOM, SUM } from '../compiler';
import { variableFlow } from '../compiler/dataflow';
import type { ArtView, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { cfgView, irLinesOf, shortIr } from './views';

const before = SUM.o0;
const after = SUM.ssa.fn;
const { events, phis, defSites } = SUM.ssa;

/** 还没重命名的块只列出它读写了哪些变量：放 φ 只看这些，指令文本反而碍事。 */
const flow = variableFlow(before);
const oldLines = (name: string) => {
  const block = flow.find((item) => item.name === name)!;
  return [`写：${block.def.join(' ') || '无'}`, `先读后写或只读：${block.use.join(' ') || '无'}`];
};

const newLines = (name: string, lit?: Tone) => irLinesOf(after, name, (text, inst) => ({ text: shortIr(text), tone: inst.op === 'phi' ? lit ?? 'amber' : undefined }));

function cfg(opts: { lit?: string; tone?: Tone; done?: string[]; phiIn?: boolean; sub?: string; backTone?: boolean } = {}): ArtView {
  const done = opts.done ?? [];
  return cfgView({
    title: '控制流图',
    sub: opts.sub ?? `${before.blocks.length} 个基本块`,
    width: 524,
    height: 472,
    boxW: 330,
    lines: (name) => {
      if (done.includes(name)) return newLines(name);
      const old = oldLines(name);
      if (name === 'while.cond' && opts.phiIn) return [...phis.map((phi) => ({ text: `%${phi.name} = phi i32 ...（入边待填）`, tone: 'amber' as Tone })), ...old];
      return old;
    },
    tone: (name) => (name === opts.lit ? opts.tone ?? 'amber' : undefined),
    edgeTone: (from, to) => (opts.backTone && from === 'while.body' && to === 'while.cond' ? 'amber' : undefined),
  });
}

const domTable = (shown: string[], lit?: string, sub = '支配关系'): ArtView => ({
  kind: 'table',
  title: '支配树与支配边界',
  sub,
  cols: ['基本块', '直接支配者', '支配边界'],
  widths: [96, 110, 100],
  rows: DOM.order.map((name) => ({
    cells: [name, shown.includes(name) ? DOM.idom.get(name) ?? '（入口）' : '', shown.includes(name) ? (DOM.frontier.get(name) ?? []).join(' ') || '∅' : ''],
    tone: name === lit ? 'amber' as Tone : undefined,
  })),
  size: 12,
});

/** 每个变量：定义在哪些块，要不要 φ，当前的值。 */
const variables = [...defSites.keys()];
function varTable(values: Map<string, string>, lit?: string, sub = '每个变量的当前版本'): ArtView {
  return {
    kind: 'table',
    title: '变量表',
    sub,
    cols: ['变量', '定义在', 'φ', '当前值'],
    widths: [44, 120, 48, 94],
    rows: variables.map((slot) => ({
      cells: [slot.replace(/\.addr$/, ''), defSites.get(slot)!.join(' ').replace('while.', ''), phis.find((phi) => phi.variable === slot)?.name ?? '', values.get(slot.replace(/\.addr$/, '')) ?? ''],
      tone: slot.replace(/\.addr$/, '') === lit ? 'amber' as Tone : undefined,
    })),
    size: 12,
  };
}

const domEvents: PacketEvent[] = DOM.order.map((name, index) => {
  const idom = DOM.idom.get(name);
  return pk('cfg', 'ssa', 'blue', name, [idom ? `直接支配者 ${idom}` : '入口块'], [5, 'DOM', idom ? `${name} 的直接支配者是 ${idom}：到 ${name} 必须先经过它` : `${name} 是入口，支配所有块`, null],
    wire('支配树是分析的中间结果', 'mem', '示意', concept(`基本块 ${name}`, [['直接支配者', idom ?? '无'], ['支配树的孩子', DOM.children.get(name)!.join(' ') || '无']], 'blue')), { quick: true, art: { dom: domTable(DOM.order.slice(0, index + 1), name), cfg: cfg({ lit: name, tone: 'blue' }) } });
});

const frontierEvents: PacketEvent[] = DOM.order.filter((name) => (DOM.frontier.get(name) ?? []).length).map((name) =>
  pk('cfg', 'ssa', 'violet', `DF(${name})`, [(DOM.frontier.get(name) ?? []).join(' ')], [5, 'DOM', `${name} 的支配边界是 {${(DOM.frontier.get(name) ?? []).join(' ')}}：控制流在那里汇合`, null],
    wire('支配边界是控制流汇合的地方', 'mem', '示意', concept(`DF(${name})`, [['结果', (DOM.frontier.get(name) ?? []).join(' ')], ['含义', '从这里开始，另一条路径上的定义也能到达']], 'violet')), { art: { dom: domTable(DOM.order, name, '找汇合点'), cfg: cfg({ lit: name, tone: 'violet', backTone: true }) } }));

const phiEvents: PacketEvent[] = phis.map((phi) => {
  const name = phi.variable.replace(/\.addr$/, '');
  return pk('ssa', 'cfg', 'amber', `φ ${name}`, [`放到 ${phi.block}`], [5, 'PHI', `${name} 有 ${defSites.get(phi.variable)!.length} 处定义：在 ${phi.block} 放 φ，命名 %${phi.name}`, null],
    wire('φ 的放置是算法决定的', 'mem', '示意', concept(`φ · ${name}`, [['定义所在块', defSites.get(phi.variable)!.join(' ')], ['放在', phi.block], ['新名字', `%${phi.name}`]], 'amber')), { art: { vars: varTable(new Map(), name, '决定放 φ'), cfg: cfg({ lit: 'while.cond', phiIn: true }) } });
});

const noPhi = variables.filter((slot) => !phis.some((phi) => phi.variable === slot)).map((slot) => slot.replace(/\.addr$/, ''));
const skipEvent = pk('ssa', 'cfg', 'slate', '不用 φ', [noPhi.join(' ')], [5, 'PHI', `${noPhi.join('、')} 只在 entry 定义一次，支配边界为空，不需要 φ`, null],
  wire('只有一个定义的变量不需要 φ', 'mem', '示意', concept('不放 φ 的变量', noPhi.map((name) => [name, '只有一个定义点'] as [string, string]), 'slate')), { quick: true, art: { vars: varTable(new Map(), undefined, '单定义变量不放') } });

const renameByBlock = new Map<string, typeof events>();
for (const event of events) {
  if (event.kind === 'phi') continue;
  const key = event.block;
  if (!renameByBlock.has(key)) renameByBlock.set(key, []);
  renameByBlock.get(key)!.push(event);
}
const values = new Map<string, string>();
const done: string[] = [];
const renameEvents: PacketEvent[] = [...renameByBlock.keys()].map((name) => {
  const list = renameByBlock.get(name)!;
  const renames = list.filter((event) => event.kind === 'rename');
  renames.forEach((event) => {
    if (event.kind === 'rename' && event.action === 'store') values.set(event.variable, event.value);
  });
  if (name === 'while.cond') phis.forEach((phi) => values.set(phi.variable.replace(/\.addr$/, ''), `%${phi.name}`));
  renames.forEach((event) => {
    if (event.kind === 'rename' && event.action === 'store') values.set(event.variable, event.value);
  });
  done.push(name);
  const loads = renames.filter((event) => event.kind === 'rename' && event.action === 'load').length;
  const stores = renames.filter((event) => event.kind === 'rename' && event.action === 'store').length;
  const layer = makeLayer(`重命名 ${name}`, 'green', `删 ${loads} 个 load，${stores} 个 store`);
  renames.slice(0, 12).forEach((event) => {
    if (event.kind !== 'rename') return;
    layer.field(event.action === 'load' ? `load ${event.variable}` : `store ${event.variable}`, event.value, () => {}, { note: event.action === 'load' ? `把用到 %${event.removed.replace(/^\$/, '')} 的地方都换成这个值。` : '这个值成为变量的当前版本。' });
  });
  const firstLine = irLinesOf(after, name)[0];
  return pk('ssa', 'cfg', 'green', name, [`删 ${loads} load ${stores} store`], [5, 'PHI', `沿支配树处理 ${name}：删除 ${loads} 个 load 和 ${stores} 个 store`, null],
    wire(`${name} 重命名后的第一条指令`, 'mem', 'text', irLine(typeof firstLine === 'string' ? firstLine : firstLine.text, 'green', name), layer), {
      art: { vars: varTable(new Map(values), undefined, `处理完 ${name}`), cfg: cfg({ lit: name, tone: 'green', done: [...done] }) },
    });
});

const countInsts = (fn: typeof before) => fn.blocks.reduce((sum, block) => sum + block.insts.length, 0);
const removed = countInsts(before) - countInsts(after);

export const ssa: Lesson = seal({
  id: 'ssa',
  name: 'SSA',
  title: 'φ 节点',
  group: 'middle',
  layer: [5, 5],
  nodes: ['cfg', 'ssa'],
  place: { cfg: [240, 56], ssa: [660, 56] },
  labels: { cfg: ['控制流图', '-O0 的 IR'], ssa: ['SSA 构造', '等价于 mem2reg'] },
  panels: { cfg: [10, 146, 540, 520], dom: [560, 146, 330, 135], vars: [560, 291, 330, 375] },
  initial: { cfg: cfg({}), dom: domTable([], undefined, '尚未计算'), vars: varTable(new Map(), undefined, '变量都还在栈上') },
  start: ['cfg'],
  legend: [['blue', '支配关系'], ['violet', '支配边界'], ['amber', '放 φ'], ['green', '重命名']],
  overview: {
    full: '每个值只定义一次',
    description: 'SSA 规定每个虚拟寄存器只赋值一次，这让“这个值从哪来”一眼可知，很多优化因此变得简单。难点在汇合处：循环头的 s 可能来自初值，也可能来自上一轮。φ 节点就是解决这个问题的。这一课算出放 φ 的位置，把变量都从内存提到寄存器。',
    facts: [
      ['算法', 'Cytron 等人的支配边界法'],
      ['φ 节点', `${phis.length} 个：${phis.map((phi) => `%${phi.name}`).join(' ')}`],
      ['删掉指令', `${removed} 条 alloca、load、store`],
      ['对照工具', 'clang 的 SROA 阶段输出'],
    ],
  },
  steps: [
    {
      title: '支配关系',
      desc: '到 B 必须先过 A，就说 A 支配 B',
      detail: '如果从入口到 B 的每条路都经过 A，A 就支配 B，A 里的定义在 B 里一定已经发生。离 B 最近的那个支配者是它的直接支配者，这些关系连起来是一棵树。这里 while.body 和 while.end 都只能从 while.cond 过来。',
      facts: [['算法', 'Cooper、Harvey、Kennedy 的迭代法'], ['entry', '支配所有块'], ['while.cond', '支配 body 和 end']],
      events: [show('ssa'), ...domEvents],
    },
    {
      title: '支配边界',
      desc: '定义的影响力到此为止',
      detail: 'A 的支配边界是这样一些块：A 支配它的某个前驱，但并不严格支配它本身。换句话说，从 A 走过来的值在这里会遇到别的路径上来的值，这正是需要 φ 的地方。while.body 支配自己，它跳回 while.cond，所以 while.cond 在它的边界上。',
      facts: [['DF(while.body)', (DOM.frontier.get('while.body') ?? []).join(' ')], ['DF(while.cond)', (DOM.frontier.get('while.cond') ?? []).join(' ')], ['DF(entry)', (DOM.frontier.get('entry') ?? []).join(' ') || '∅']],
      events: frontierEvents,
    },
    {
      title: '放置 φ',
      desc: '只放在真正需要的地方',
      detail: `变量的每个定义所在块，它的支配边界都要放 φ，新放的 φ 本身也算定义，要继续算。s 和 i 在 entry 和 while.body 都有定义，所以在 while.cond 放 φ。${noPhi.join('、')} 只定义一次，不需要。放置时还会查活跃信息，不活跃的地方不放，这叫剪枝 SSA。`,
      facts: [['放了 φ', phis.map((phi) => phi.variable).join(' ')], ['没放', noPhi.join(' ')], ['放的位置', 'while.cond']],
      events: [...phiEvents, skipEvent],
    },
    {
      title: '重命名',
      desc: '沿着控制流把名字换成版本',
      detail: 'entry 里 store i32 2 到 k，就记下 k 当前等于 2，store 删掉。之后的 load k 也删掉，所有用到它的地方都换成 2。遇到 φ，φ 的结果就是新版本。沿边走到后继时，把当前版本填进后继 φ 的对应入边，所以 while.body 走完才补上 %add3 这一项。',
      facts: [['load', '换成当前版本'], ['store', '更新当前版本'], ['φ 的第二个入边', '来自 while.body 的 %add3']],
      events: renameEvents,
    },
    {
      title: '结果',
      desc: `少了 ${removed} 条指令，变量都不在内存了`,
      detail: `alloca、load 和 store 全部消失，读写内存变成了直接用值。注意 %mul = mul nsw i32 2, 3 还在，常量折叠是下一课的事；死变量 d 对应的 %add 也还在。把这段 IR 和 clang -O1 在 SROA 之后的输出比较，每一行都相同，包括 %s.0 和 %i.0 这两个名字。`,
      facts: [['指令数', `${countInsts(before)} → ${countInsts(after)}`], ['φ', `%${phis.map((phi) => phi.name).join(' %')}`], ['独立核对', 'clang -mllvm -print-after=sroa']],
      events: [
        pk('ssa', 'cfg', 'green', '完成', [`${countInsts(after)} 条指令`], [5, 'PASS', `SSA 构造完成：${countInsts(before)} 条减到 ${countInsts(after)} 条`, null],
          wire('循环头的 φ', 'mem', 'text', irLine(irLinesOf(after, 'while.cond')[0] as string, 'amber', 'while.cond')), { art: { cfg: cfg({ done: before.blocks.map((block) => block.name), sub: '已经是 SSA 形式' }), vars: varTable(new Map(values), undefined, '最终版本') } }),
        note('ssa', '和 clang 的 SROA 输出相同', 'green'),
      ],
    },
  ],
  outro: {
    title: 'φ 不是一条真指令',
    desc: '它只是说明值从哪条边来',
    text: 'CPU 没有 φ 指令。SSA 只存在于编译器内部，到后端时要把 φ 变回普通的复制，放在前驱块末尾。在此之前它带来的好处是：每个使用都只对应一个定义，常量传播和死代码消除不用再解方程了。',
    facts: [['φ', '只在基本块开头'], ['后端', '要消去 φ'], ['下一课', 'OPTIMIZE']],
  },
});
