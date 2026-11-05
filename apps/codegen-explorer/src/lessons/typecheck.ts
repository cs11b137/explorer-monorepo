import { concept, makeLayer, textBytes, wire } from '../decode/structures';
import { BAD_SEMA, MAIN, SEMA } from '../compiler';
import type { Expr, Stmt } from '../compiler/parser';
import { BAD_SOURCE, SOURCE } from '../compiler/source';
import type { Sym } from '../compiler/sema';
import type { ArtView, Tone } from '../scene/art';
import { pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { exprTree, sourceView } from './views';

const KIND_TEXT: Record<Sym['kind'], string> = { global: '全局变量', func: '函数', param: '参数', local: '局部变量' };
const symbols = SEMA.symbols;

function tableView(count: number, lit?: string, sub = '作用域嵌套'): ArtView {
  return {
    kind: 'table',
    title: '符号表',
    sub,
    cols: ['名字', '种类', '类型', '作用域', '声明'],
    widths: [62, 80, 104, 62, 60],
    rows: symbols.slice(0, count).map((sym) => ({
      cells: [sym.name, KIND_TEXT[sym.kind], sym.type, `第 ${sym.depth} 层`, lineOf(sym.span.from)],
      tone: sym.name === lit ? 'amber' as Tone : undefined,
    })),
    size: 12,
  };
}

const lineOf = (offset: number) => `第 ${SOURCE.slice(0, offset).split('\n').length} 行`;

const declareEvent = (sym: Sym, quick = true): PacketEvent => {
  const index = symbols.indexOf(sym);
  return pk('tree', 'symtab', 'amber', `声明 ${sym.name}`, [`${sym.type} · 第 ${sym.depth} 层`], [3, 'SYM', `在第 ${sym.depth} 层作用域声明 ${sym.name}：${KIND_TEXT[sym.kind]}，类型 ${sym.type}`, sym.span.to - sym.span.from],
    wire('声明语句的源码', 'mem', 'text', textBytes(`声明 · ${sym.name}`, SOURCE.slice(sym.span.from, sym.span.to), 'amber', lineOf(sym.span.from)), concept('符号表项', [['名字', sym.name], ['种类', KIND_TEXT[sym.kind]], ['类型', sym.type], ['作用域深度', String(sym.depth), '0 是文件作用域。']], 'amber')), {
      quick,
      art: { sym: tableView(index + 1, sym.name), src: sourceView({ spans: [{ span: sym.span, tone: 'amber' }] }) },
    });
};

const sum = MAIN.program.tops.find((top) => top.k === 'func' && top.body) as Extract<(typeof MAIN.program.tops)[number], { k: 'func' }>;
const loop = sum.body!.stmts.find((stmt) => stmt.k === 'while') as Extract<Stmt, { k: 'while' }>;
const assign = ((loop.body as Extract<Stmt, { k: 'block' }>).stmts[0] as Extract<Stmt, { k: 'expr' }>).e as Extract<Expr, { k: 'assign' }>;

function varsOf(e: Expr): Array<Extract<Expr, { k: 'var' }>> {
  if (e.k === 'var') return [e];
  if (e.k === 'bin') return [...varsOf(e.l), ...varsOf(e.r)];
  if (e.k === 'assign') return [e.target, ...varsOf(e.value)];
  return [];
}

/** 后序遍历，就是类型自底向上定下来的顺序。 */
function postOrder(e: Expr): Expr[] {
  if (e.k === 'bin') return [...postOrder(e.l), ...postOrder(e.r), e];
  if (e.k === 'assign') return [...postOrder(e.value), e];
  return [e];
}

const typedTree = (done: Set<number>, lit?: number): ArtView => ({
  kind: 'tree',
  title: '带类型的语法树',
  sub: '从叶子往根标注',
  nodes: exprTree(assign, {
    lit: lit === undefined ? undefined : new Map([[lit, 'green' as Tone]]),
    sub: (e) => (done.has(e.id) ? SEMA.types.get(e.id) : '?'),
  }),
});

const lookupEvents = varsOf(assign).map((node) => {
  const sym = SEMA.uses.get(node.id)!;
  return pk('symtab', 'tree', 'blue', `查 ${node.name}`, [`第 ${sym.depth} 层 · ${sym.type}`], [3, 'SYM', `使用 ${node.name}：沿作用域由内向外查找，在第 ${sym.depth} 层找到`, node.name.length],
    wire('这个名字在源码里的位置', 'mem', 'text', textBytes(`引用 · ${node.name}`, node.name, 'blue', `源文件第 ${node.span.from} 字节`), concept('查找结果', [['找到', `${KIND_TEXT[sym.kind]} ${sym.name}`], ['声明位置', lineOf(sym.span.from)], ['类型', sym.type]], 'blue')), {
      quick: true,
      art: { sym: tableView(symbols.length, sym.name, `${node.name} → 第 ${sym.depth} 层`), src: sourceView({ spans: [{ span: node.span, tone: 'blue' }] }) },
    });
});

const order = postOrder(assign);
const typeEvents = order.map((node, index) => {
  const done = new Set(order.slice(0, index + 1).map((item) => item.id));
  done.add(assign.target.id);
  const rule = SEMA.events.find((event) => event.kind === 'type' && event.id === node.id) as Extract<(typeof SEMA.events)[number], { kind: 'type' }>;
  const text = SOURCE.slice(node.span.from, node.span.to);
  return pk('symtab', 'tree', 'green', rule.type, [text.slice(0, 18)], [3, 'TYPE', `${text} 的类型是 ${rule.type}：${rule.rule}`, text.length],
    wire('这个表达式的源码范围', 'mem', 'text', textBytes(`表达式`, text, 'green', `类型 ${rule.type}`), concept('类型规则', [['结论', rule.type], ['依据', rule.rule]], 'green')), {
      quick: true,
      art: { typed: typedTree(done, node.id), src: sourceView({ spans: [{ span: node.span, tone: 'green' }] }) },
    });
});

const badDiag = BAD_SEMA.diagnostics[0];
const badLineIndex = BAD_SOURCE.slice(0, badDiag.span.from).split('\n').length;
const badText = BAD_SOURCE.slice(badDiag.span.from, badDiag.span.to);

const errorView = (): ArtView => ({
  kind: 'code',
  title: '诊断',
  sub: '对照输入',
  size: 12.5,
  lines: [
    { text: `第 ${badLineIndex} 行：return ${badText} + n;` },
    { text: badDiag.message, tone: 'red' },
    { text: '' },
    { text: 'clang 的说法：', dim: true },
    { text: "too many arguments to function call,", dim: true },
    { text: "expected single argument 'v', have 2", dim: true },
  ],
});

export const typecheck: Lesson = seal({
  id: 'typecheck',
  name: 'TYPE CHECK',
  title: '符号表与类型',
  group: 'front',
  layer: [3, 3],
  nodes: ['tree', 'symtab'],
  place: { tree: [240, 56], symtab: [660, 56] },
  labels: { tree: ['语法树', '结构已确定'], symtab: ['符号表', '名字 → 声明'] },
  panels: { src: [10, 146, 360, 330], sym: [380, 146, 510, 240], typed: [380, 396, 510, 270], err: [10, 486, 360, 180] },
  initial: { src: sourceView(), sym: tableView(0), typed: typedTree(new Set()) },
  start: ['tree'],
  legend: [['amber', '声明'], ['blue', '查找'], ['green', '标注类型'], ['slate', '报错']],
  overview: {
    full: '语法对了，意思不一定对',
    description: 'x = y + 1; 的语法没问题，但 y 可能没声明，也可能是个函数。语义分析遍历语法树，用符号表记住每个名字的来历，再给每个表达式定类型。不合规矩的程序就在这里被拦下，并且错误能指到具体位置。',
    facts: [
      ['符号总数', `${symbols.length} 个`],
      ['作用域', '栈式嵌套，内层遮蔽外层'],
      ['本站子集的类型', 'int 和函数'],
      ['比较结果', '只能作 if、while 的条件'],
      ['对照工具', 'clang -ast-dump'],
    ],
  },
  steps: [
    {
      title: '文件作用域',
      desc: '先声明，后使用',
      detail: 'C 要求名字先声明再使用。遍历顶层声明，把 total、scale、sum 放进最外层的表。scale 这里只有原型没有函数体，但这已经够了：类型检查只需要知道它的参数和返回类型，定义在哪是链接器的事。',
      facts: [['total', 'int'], ['scale', 'int (int)，只有声明'], ['sum', 'int (int)']],
      events: [show('symtab'), declareEvent(symbols[0], false), declareEvent(symbols[1]), declareEvent(symbols[2])],
    },
    {
      title: '函数作用域',
      desc: '参数和局部变量进内层',
      detail: '进入 sum 时打开一层新作用域。C 规定参数和函数体最外层的块同属一个作用域，所以 int n; 再声明 n 是错的。局部变量按出现顺序加入，每个声明都从自己的声明符之后才可见。',
      facts: [['参数', 'n'], ['局部变量', symbols.filter((sym) => sym.kind === 'local').map((sym) => sym.name).join(' ')], ['作用域深度', '第 1 层']],
      events: symbols.slice(3).map((sym) => declareEvent(sym)),
    },
    {
      title: '解析名字',
      desc: '由内向外查，第一个就是它',
      detail: `s = s + m * n + i 里的每个名字都要查表。查找从最内层开始，内层有同名变量就遮蔽外层。查到的不只是类型，还有“到底是哪一个变量”，后面生成 IR 时靠这个把名字换成具体的存储位置。`,
      facts: [['s m i', '局部变量'], ['n', '参数'], ['total', '第 0 层，全局变量']],
      events: lookupEvents,
    },
    {
      title: '标注类型',
      desc: '叶子先定，再一层层往上推',
      detail: '字面量和变量的类型直接知道，int 加 int 得到 int。真实的 C 还要做整数提升和隐式转换，clang 的语法树里能看到 ImplicitCastExpr。这个子集只有 int，规则简单，但遍历的顺序和思路是一样的。',
      facts: [['遍历', '后序：先孩子后父亲'], ['赋值的类型', '左边的类型'], ['clang 的表现', 'LValueToRValue 隐式转换']],
      events: typeEvents,
    },
    {
      title: '拦下错误',
      desc: '多传一个实参，当场报错',
      detail: `把第 15 行改成 scale(s, n)。语法完全合法，但符号表说 scale 只收一个参数。这种错只有语义分析能发现。clang 对同一输入给出的是 too many arguments 错误，位置也在同一行；单元测试核对过这一点。`,
      facts: [['实参', '2 个'], ['声明', '1 个'], ['报错行', `第 ${badLineIndex} 行`]],
      events: [
        pk('symtab', 'tree', 'slate', '实参不对', ['要 1 个，传了 2 个'], [3, 'ERROR', badDiag.message, badText.length],
          wire('对照输入：scale 多传一个实参', 'mem', 'text', textBytes('出错的调用', badText, 'slate', `第 ${badLineIndex} 行`), (() => {
            const layer = makeLayer('诊断', 'slate');
            layer.field('信息', badDiag.message);
            layer.field('依据', 'scale 的类型是 int (int)', () => {}, { note: '来自第 2 行的原型。' });
            return layer;
          })()), { lost: true, art: { err: errorView() } }),
      ],
    },
  ],
  outro: {
    title: '前端到此结束',
    desc: '程序现在是一棵带类型、名字都解析过的树',
    text: '能走到这里的程序在语法和类型上都站得住脚。前端的三个阶段各管一层：词法管字符，语法管结构，语义管含义。从下一课开始，这棵树会被翻译成和具体语言无关的中间表示。',
    facts: [['输出', '带类型的 AST'], ['报错能力', '精确到行列'], ['下一课', 'IR GEN']],
  },
});
