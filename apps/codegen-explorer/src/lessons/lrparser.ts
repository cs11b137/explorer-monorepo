import { concept, makeLayer, tokenRecord, wire } from '../decode/structures';
import { LR_INPUT, LR_RUN, LR_TABLE } from '../compiler';
import { AUG, END, EXPR_GRAMMAR, fmtAction, fmtItem, fmtProduction, type LrNode, type LrStep } from '../compiler/lr';
import type { ArtView, Tone, TreeNode } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';

const G = EXPR_GRAMMAR;
const T = LR_TABLE;
const TERMS = G.terminals;
const NONTERMS = G.nonterminals;
const COLS = ['', ...TERMS, ...NONTERMS];

/** ACTION/GOTO 表：每格都来自生成器的结果。 */
function tableView(opts: { cell?: { state: number; symbol: string; tone: Tone }; goto?: { state: number; symbol: string }; upTo?: number; sub?: string } = {}): ArtView {
  const count = opts.upTo ?? T.sets.length;
  return {
    kind: 'table',
    title: 'SLR 分析表',
    sub: opts.sub ?? `${T.sets.length} 个状态，${T.conflicts.length} 个冲突`,
    center: true,
    size: 11.5,
    cols: COLS,
    widths: COLS.map((_, index) => (index === 0 ? 30 : 40)),
    rows: T.sets.map((_set, state) => ({
      cells: COLS.map((symbol, index) => {
        if (index === 0) return String(state);
        if (state >= count) return '';
        if (TERMS.includes(symbol)) return fmtAction(T.action[state].get(symbol));
        const to = T.goto[state].get(symbol);
        return to === undefined ? '' : String(to);
      }),
      tones: COLS.map((symbol) => {
        if (opts.cell && opts.cell.state === state && opts.cell.symbol === symbol) return opts.cell.tone;
        if (opts.goto && opts.goto.state === state && opts.goto.symbol === symbol) return 'violet' as Tone;
        return null;
      }),
    })),
  };
}

const grammarLines = G.productions.map((production, index) => ({ text: `${index === 0 ? '  ' : String(index).padStart(2)}  ${fmtProduction(production)}` }));

const grammarView = (rule: number | null, sub = '增广文法'): ArtView => ({
  kind: 'code', title: '产生式', sub, size: 12.5,
  lines: grammarLines.map((line, index) => ({ ...line, tone: index === rule ? 'violet' : undefined })),
});

const itemsView = (state: number, sub?: string): ArtView => {
  const set = T.sets[state];
  const kernelCount = set.kernel.length;
  return {
    kind: 'code', title: `项集 I${state}`, sub: sub ?? `核心项 ${kernelCount} 个，闭包共 ${set.items.length} 个`, size: 12.5,
    lines: set.items.map((item, index) => ({ text: fmtItem(G, item), tone: index < kernelCount ? 'amber' as Tone : undefined })),
  };
};

const stackView = (step: Pick<LrStep, 'stack' | 'input'>, caption?: string, tone?: Tone): ArtView => ({
  kind: 'stack',
  title: 'LR 栈',
  sub: '状态和符号成对入栈',
  cells: step.stack.map((item, index) => ({ text: item.symbol === END ? '⊥' : item.symbol, sub: `I${item.state}`, tone: index === step.stack.length - 1 ? tone ?? 'blue' : undefined })),
  rest: step.input.map((text, index) => ({ text, tone: index === 0 ? 'amber' as Tone : undefined })),
  restLabel: '剩余输入',
  caption,
});

function treeOf(nodes: LrNode[], lit: number | null): ArtView {
  const list: TreeNode[] = [];
  const walk = (node: LrNode, parent: string | null) => {
    list.push({ id: String(node.id), label: node.label, parent, tone: node.id === lit ? 'green' : undefined });
    node.children.forEach((child) => walk(child, String(node.id)));
  };
  nodes.forEach((node) => walk(node, null));
  return { kind: 'tree', title: '语法树', sub: '自底向上长出来', nodes: list };
}

/** 在第 index 步执行之后，栈里有哪些子树。 */
function forestAfter(index: number): LrNode[] {
  const forest: LrNode[] = [];
  LR_RUN.steps.slice(0, index + 1).forEach((step) => {
    if (step.action.t === 'shift') forest.push(step.node!);
    if (step.action.t === 'reduce') {
      forest.length -= step.node!.children.length;
      forest.push(step.node!);
    }
  });
  return forest;
}

function stepEvent(index: number): PacketEvent {
  const step = LR_RUN.steps[index];
  const next = LR_RUN.steps[index + 1];
  const { action, cell } = step;
  const tokenInfo = LR_INPUT[step.tokenIndex]?.token;
  const lookup = concept('查表', [
    ['当前状态', `I${cell.state}`, '栈顶的状态。'],
    ['向前看', cell.symbol, '输入里下一个记号的种类。'],
    ['ACTION 格', fmtAction(action as never), action.t === 'shift' ? 'sN 表示移进并转到状态 N。' : action.t === 'reduce' ? 'rN 表示按第 N 条产生式归约。' : 'acc 表示接受。'],
  ], action.t === 'shift' ? 'amber' : action.t === 'reduce' ? 'green' : 'blue');
  if (action.t === 'shift') {
    return pk('lrtable', 'parser', 'amber', `移进 ${LR_INPUT[step.tokenIndex].text}`, [`I${cell.state} 遇 ${cell.symbol} → ${fmtAction(action)}`], [2, 'SHIFT', `状态 ${cell.state} 遇到 ${cell.symbol}：${fmtAction(action)}，把 ${LR_INPUT[step.tokenIndex].text} 压栈`, tokenInfo.text.length],
      wire('LR 驱动器查 ACTION 表', 'mem', 'text', tokenRecord(tokenInfo, '被移进栈的记号。', 'amber'), lookup), {
        quick: true,
        art: {
          stack: stackView(next, `s${action.to}：移进 ${LR_INPUT[step.tokenIndex].text}，转到 I${action.to}`, 'amber'),
          table: tableView({ cell: { state: cell.state, symbol: cell.symbol, tone: 'amber' } }),
          items: itemsView(action.to),
          tree: treeOf(forestAfter(index), step.node!.id),
        },
      });
  }
  if (action.t === 'reduce') {
    const production = G.productions[action.rule];
    const gotoCell = step.gotoCell!;
    const layer = makeLayer(`归约 · ${fmtProduction(production)}`, 'green', `弹出 ${production.rhs.length} 项`);
    layer.field('产生式', `#${action.rule} ${fmtProduction(production)}`);
    layer.field('弹栈后露出', `I${gotoCell.state}`);
    layer.field('GOTO 格', `GOTO[I${gotoCell.state}, ${gotoCell.symbol}] = ${gotoCell.to}`, () => {}, { note: '归约之后要压入左部符号，下一个状态查 GOTO 表。' });
    return pk('parser', 'tree', 'green', `归约 ${production.lhs}`, [fmtProduction(production)], [2, 'REDUCE', `状态 ${cell.state} 向前看 ${cell.symbol}：${fmtAction(action)}，${fmtProduction(production)}，再查 GOTO[${gotoCell.state}, ${gotoCell.symbol}] = ${gotoCell.to}`, null],
      wire('LR 驱动器按产生式归约', 'mem', '示意', lookup, layer), {
        quick: true,
        art: {
          stack: stackView(next, `r${action.rule}：${fmtProduction(production)}，GOTO = I${gotoCell.to}`, 'green'),
          table: tableView({ cell: { state: cell.state, symbol: cell.symbol, tone: 'green' }, goto: gotoCell }),
          items: grammarView(action.rule, `按第 ${action.rule} 条归约`),
          tree: treeOf(forestAfter(index), step.node!.id),
        },
      });
  }
  return pk('lrtable', 'parser', 'blue', '接受', ['acc'], [2, 'TABLE', `状态 ${cell.state} 遇到 $：acc，整个表达式解析成功`, null],
    wire('输入读完，栈里只剩开始符号', 'mem', '示意', lookup), {
      art: {
        stack: stackView(step, '接受：输入读完，栈里只剩 E'),
        table: tableView({ cell: { state: cell.state, symbol: cell.symbol, tone: 'blue' } }),
      },
    });
}

const index0 = LR_RUN.steps;
const firstPlus = index0.findIndex((step) => step.action.t === 'shift' && step.cell.symbol === '+');
const starShift = index0.findIndex((step) => step.action.t === 'shift' && step.cell.symbol === '*');
const mulReduce = index0.findIndex((step) => step.action.t === 'reduce' && step.action.rule === 3);
const decision = LR_RUN.steps[starShift];
const ranges = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => stepEvent(from + offset));

/** 构造项集的真实过程：I0 的闭包和前几条 goto。 */
function closureEvents(): PacketEvent[] {
  const first = T.sets[0];
  const layer = makeLayer('项集 I0', 'amber', `闭包后 ${first.items.length} 项`);
  first.items.forEach((item) => layer.field(fmtItem(G, item), '', () => {}));
  const events: PacketEvent[] = [
    pk('parser', 'lrtable', 'amber', 'I0', [`${first.items.length} 个项`], [2, 'TABLE', `求闭包：从 ${AUG} → · E 出发得到 I0，共 ${first.items.length} 项`, null],
      wire('LR(0) 项集是生成器的内部结构', 'mem', '示意', layer), { art: { items: itemsView(0, '点后是非终结符就展开'), table: tableView({ upTo: 1, sub: '正在填表' }) } }),
  ];
  for (const [symbol, to] of [...first.transitions].slice(0, 3)) {
    const set = T.sets[to];
    const next = makeLayer(`GOTO(I0, ${symbol}) = I${to}`, 'amber');
    set.kernel.forEach((item) => next.field(fmtItem(G, item), '核心项'));
    events.push(pk('parser', 'lrtable', 'amber', `GOTO ${symbol}`, [`I0 → I${to}`], [2, 'TABLE', `把点移过 ${symbol}：GOTO(I0, ${symbol}) = I${to}`, null],
      wire('点越过一个符号，得到新项集', 'mem', '示意', next), { quick: true, art: { items: itemsView(to), table: tableView({ upTo: to + 1, sub: '正在填表' }) } }));
  }
  const follow = makeLayer('FOLLOW 集', 'violet');
  for (const [symbol, set] of T.follow) follow.field(`FOLLOW(${symbol})`, [...set].join(' '), () => {}, { note: '只在这些向前看符号上归约，所以叫 SLR。' });
  events.push(pk('parser', 'lrtable', 'violet', 'FOLLOW', [...T.follow].map(([symbol, set]) => `${symbol}: ${[...set].join(' ')}`).slice(0, 3), [2, 'TABLE', `算 FOLLOW 集，填归约动作。一共 ${T.sets.length} 个状态，没有冲突`, null],
    wire('归约只发生在 FOLLOW 集里的符号上', 'mem', '示意', follow), { art: { table: tableView() } }));
  return events;
}

export const lrparser: Lesson = seal({
  id: 'lrparser',
  name: 'LR PARSER',
  title: '移进归约',
  group: 'front',
  layer: [2, 2],
  nodes: ['lrtable', 'parser', 'tree'],
  place: { lrtable: [140, 56], parser: [450, 56], tree: [760, 56] },
  labels: { lrtable: ['分析表', 'ACTION + GOTO'], parser: ['LR 驱动器', '一个循环加一个栈'], tree: ['语法树', '从叶子往上'] },
  panels: { stack: [10, 146, 370, 210], tree: [10, 366, 370, 300], table: [390, 146, 500, 310], items: [390, 466, 500, 200] },
  initial: { stack: stackView({ stack: [{ state: 0, symbol: END }], input: [...LR_INPUT.map((item) => item.text), END] }), table: tableView({ upTo: 0, sub: '还没有生成' }), items: grammarView(null), tree: treeOf([], null) },
  start: ['parser'],
  legend: [['amber', '移进或构造项集'], ['green', '归约'], ['violet', 'FOLLOW'], ['blue', '接受']],
  overview: {
    full: '自底向上，查表决定移进还是归约',
    description: 'LR 解析反着来：先把记号压栈，等栈顶凑齐一条产生式的右部，再把它们换成左部。什么时候做什么，全由一张表决定。这一课真实生成 SLR 表，再用它解析 sum.c 里的 s + m * n + i。',
    facts: [
      ['文法', 'E T F，7 条产生式'],
      ['状态数', `${T.sets.length} 个（和 bison 的自动机一致）`],
      ['冲突', `${T.conflicts.length} 个`],
      ['输入', LR_INPUT.map((item) => item.text).join(' ')],
      ['动作总数', `${LR_RUN.steps.length} 个`],
    ],
  },
  steps: [
    {
      title: '增广文法',
      desc: '多加一条开始规则',
      detail: `这里直接写左递归的文法 E → E + T，LR 解析器处理它毫无压力，这正是它和 LL 的一大不同。再补一条 ${AUG} → E，这样“归约到 ${AUG}”就明确表示整个输入都接受了。`,
      facts: [['产生式', `${G.productions.length} 条`], ['终结符', TERMS.join(' ')], ['非终结符', NONTERMS.join(' ')]],
      events: [
        show('lrtable', 'tree'),
        pk('tree', 'parser', 'blue', '文法', [`${G.productions.length} 条产生式`], [2, 'TABLE', `读入文法：${G.productions.length - 1} 条产生式，非终结符 ${NONTERMS.join(' ')}`, null],
          wire('文法是生成器的输入', 'mem', '示意', concept('表达式文法', G.productions.map((production, index) => [`#${index}`, fmtProduction(production)]), 'blue')), { art: { items: grammarView(null) } }),
      ],
    },
    {
      title: '生成分析表',
      desc: '项集就是解析器的状态',
      detail: '项是带点的产生式，点表示已经读到哪里。从 I0 出发，把点越过一个符号就得到新状态，重复到没有新状态为止。遇到终结符填移进，遇到非终结符填 GOTO。点走到末尾的项，在 FOLLOW 集里的符号上填归约。',
      facts: [['状态数', String(T.sets.length)], ['FOLLOW(E)', [...T.follow.get('E')!].join(' ')], ['FOLLOW(T)', [...T.follow.get('T')!].join(' ')]],
      events: closureEvents(),
    },
    {
      title: '移进和归约',
      desc: '叶子先变成 F，再变成 T 和 E',
      detail: '驱动器只有一个循环：看栈顶状态和下一个记号，查 ACTION。移进就把记号压栈；归约就弹掉产生式右部，再查 GOTO 压入左部。s 依次被归约成 F、T、E，因为下一个记号 + 在它们的 FOLLOW 集里。',
      facts: [['第一个记号', 's'], ['归约链', 'F → id，T → F，E → T'], ['每一步', '查一次表']],
      events: ranges(0, firstPlus + 1),
    },
    {
      title: '优先级写在表里',
      desc: '栈顶是 T 时，看到 * 就继续移进',
      detail: `关键的一格是 ACTION[I${decision.cell.state}, *]。栈里已有 E + T，如果此时归约，就先算了加法。表里写的是 ${fmtAction(decision.action as never)}：继续移进，等 m * n 建好。同样的状态看到 + 或 $ 才归约。优先级没有写成代码，它已经由文法分层编码进表里了。`,
      facts: [['关键一格', `ACTION[I${decision.cell.state}, *] = ${fmtAction(decision.action as never)}`], ['这样才对', 'm * n 先于 s + …'], ['对比 LL', '那里靠函数调用层次']],
      events: [...ranges(firstPlus + 1, mulReduce + 1), note('parser', 'm * n 先归约', 'green')],
    },
    {
      title: '接受',
      desc: '读完输入，栈里只剩 E',
      detail: '接下来归约出 E + T，再把 i 走一遍，最后看到 $ 时动作是 acc。整个过程没有递归调用，只有一个循环和一个栈，所以用生成器生成的解析器能处理很大的文法。把同一文法交给 bison，得到的 LR 自动机和这里的状态一一对应，单元测试会核对。',
      facts: [['总动作数', String(LR_RUN.steps.length)], ['移进', String(LR_RUN.steps.filter((step) => step.action.t === 'shift').length)], ['归约', String(LR_RUN.steps.filter((step) => step.action.t === 'reduce').length)]],
      events: ranges(mulReduce + 1, LR_RUN.steps.length),
    },
  ],
  outro: {
    title: '一张表替代一堆函数',
    desc: 'LR 能处理的文法比 LL 更多',
    text: `左递归对 LR 不是问题，优先级也能从文法分层自然得到。代价是表要靠工具生成，报错也不如手写解析器好写。这里的 SLR 是最简单的一种，bison 默认用的 LALR(1) 向前看更精确，能处理更多文法。GCC 早年用 bison 生成解析器，后来也换成了手写递归下降。`,
    facts: [['方向', '自底向上，最右推导的逆过程'], ['工具', 'yacc、bison'], ['下一课', 'TYPE CHECK']],
  },
});
