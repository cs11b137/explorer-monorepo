import { concept, makeLayer, textBytes, tokenRecord, wire } from '../decode/structures';
import { PARSED } from '../compiler';
import { parse, ParseError, type Expr, type ParseEvent, type Rule, type Stmt } from '../compiler/parser';
import { SOURCE } from '../compiler/source';
import type { ArtView, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { exprTree, sourceView, sourceSlice } from './views';

const { program, events } = PARSED;
const { tokens } = program;
const sum = program.tops.find((top) => top.k === 'func' && top.body)!;
const body = (sum as Extract<typeof sum, { k: 'func' }>).body!;
const loop = body.stmts.find((stmt) => stmt.k === 'while') as Extract<Stmt, { k: 'while' }>;
const statement = (loop.body as Extract<Stmt, { k: 'block' }>).stmts[0] as Extract<Stmt, { k: 'expr' }>;
const root = statement.e;

const GRAMMAR: Array<[Rule | 'none', string]> = [
  ['stmt', 'stmt       → while | decl | expr ;'],
  ['assign', 'assign     → equality [ = assign ]'],
  ['equality', 'equality   → relational { == relational }'],
  ['relational', 'relational → additive { < additive }'],
  ['additive', 'additive   → term { + term }'],
  ['term', 'term       → unary { * unary }'],
  ['unary', 'unary      → - unary | primary'],
  ['primary', 'primary    → NUM | ID | ID (...) | ( assign )'],
];

const grammarView = (rule: Rule | null): ArtView => ({
  kind: 'code',
  title: '文法',
  sub: '一条规则一个函数',
  size: 12.5,
  lines: GRAMMAR.map(([name, text]) => ({ text, tone: name === rule ? 'amber' : undefined })),
});

const stackView = (stack: Rule[], caption?: string): ArtView => ({
  kind: 'stack',
  title: '调用栈',
  sub: `深度 ${stack.length}`,
  cells: stack.map((rule) => ({ text: rule })),
  caption,
});

const treeView = (known: Set<number>, lit?: Map<number, Tone>, sub = '节点在函数返回时才建好'): ArtView => ({ kind: 'tree', title: '语法树', sub, nodes: exprTree(root, { known, lit }) });

const fromToken = tokens.findIndex((token) => token.offset === statement.span.from);
const toToken = tokens.findIndex((token) => token.end === statement.span.to);
const matchIndex = (tok: number) => events.findIndex((event) => event.kind === 'match' && event.tok === tok);

/** 到第 tok 个记号被匹配、并且紧随其后的节点都建好为止，已存在的节点。 */
function builtUpTo(tok: number): Set<number> {
  const stop = tok + 1 <= toToken ? matchIndex(tok + 1) : events.length;
  const known = new Set<number>();
  const start = matchIndex(fromToken);
  events.slice(start, stop).forEach((event: ParseEvent) => {
    if (event.kind === 'node') known.add(event.id);
  });
  return known;
}

function matchEvent(tok: number, text?: string, color: 'amber' | 'blue' | 'green' = 'amber'): PacketEvent {
  const event = events[matchIndex(tok)] as Extract<ParseEvent, { kind: 'match' }>;
  const token = tokens[tok];
  const stack = event.stack;
  const rule = stack[stack.length - 1];
  const known = builtUpTo(tok);
  const built = [...known].filter((id) => !builtUpTo(tok - 1 < fromToken ? tok : tok - 1).has(id) || tok === fromToken);
  const layer = tokenRecord(token, `此刻在 ${rule}() 里，用 match 吃掉它。`);
  const frames = makeLayer('调用栈', 'amber', `深度 ${stack.length}`);
  stack.forEach((name, index) => frames.field(`第 ${index + 1} 层`, `${name}()`, () => {}));
  return pk('tokens', 'parser', color, token.text, [`${rule}() 匹配`], [2, 'CALL', `${rule}() 吃掉 ${token.text}，调用栈深度 ${stack.length}`, token.text.length],
    wire(text ?? '解析器用当前规则匹配一个记号', 'mem', 'text', layer, frames), {
      quick: true,
      art: {
        stack: stackView(stack),
        grammar: grammarView(rule),
        tree: treeView(known, new Map(built.map((id) => [id, 'amber' as Tone]))),
        src: sourceView({ spans: [{ span: { from: token.offset, to: token.end }, tone: 'amber' }], sub: `第 ${token.line} 行` }),
      },
    });
}

function findExpr(e: Expr, test: (e: Expr) => boolean): Expr | null {
  if (test(e)) return e;
  const kids = e.k === 'bin' ? [e.l, e.r] : e.k === 'assign' ? [e.target, e.value] : [];
  for (const kid of kids) {
    const found = findExpr(kid, test);
    if (found) return found;
  }
  return null;
}

const mulNode = findExpr(root, (e) => e.k === 'bin' && e.op === '*')!;
const innerAdd = findExpr(root, (e) => e.k === 'bin' && e.op === '+' && e.r === mulNode)!;
const outerAdd = findExpr(root, (e) => e.k === 'bin' && e.op === '+' && e !== innerAdd)!;

const treeEvent = (node: Expr, label: string, info: string, why: string): PacketEvent =>
  pk('parser', 'tree', 'green', label, [sourceSlice(node.span)], [2, 'NODE', info, node.span.to - node.span.from],
    wire('语法树节点覆盖的源码范围', 'mem', 'text', textBytes(`节点 · ${label}`, sourceSlice(node.span), 'green', `源文件第 ${node.span.from}–${node.span.to - 1} 字节`), concept('节点内容', [['种类', node.k === 'bin' ? `二元运算 ${node.op}` : node.k], ['为什么在这里建', why]], 'green')), {
      art: { tree: treeView(builtUpTo(tokens.findIndex((token) => token.end === node.span.to)), new Map([[node.id, 'green' as Tone]]), `建好了 ${sourceSlice(node.span)}`) },
    });

// 真实跑一次语法错误：把分号删掉，让解析器报错。
const BROKEN = SOURCE.replace('i = i + 1;', 'i = i + 1');
const brokenError = (() => {
  try {
    parse(BROKEN);
    throw new Error('这段输入应该报错');
  } catch (error) {
    return error as ParseError;
  }
})();

/** 从 stmt 下到吃掉第一个操作数时经过了几层。 */
const firstStack = (events[matchIndex(fromToken)] as Extract<ParseEvent, { kind: 'match' }>).stack;
const DESCENT = firstStack.length - firstStack.lastIndexOf('stmt');

const tokenIndex = (text: string, after: number) => tokens.findIndex((token, index) => index > after && token.text === text);
const plus1 = tokenIndex('+', fromToken);
const star = tokenIndex('*', fromToken);
const plus2 = tokenIndex('+', star);

export const llparser: Lesson = seal({
  id: 'llparser',
  name: 'LL PARSER',
  title: '递归下降',
  group: 'front',
  layer: [2, 2],
  nodes: ['tokens', 'parser', 'tree'],
  place: { tokens: [140, 56], parser: [450, 56], tree: [760, 56] },
  labels: { tokens: ['TOKEN 流', '来自词法器'], parser: ['语法分析器', '递归下降'], tree: ['语法树', 'AST'] },
  panels: { grammar: [10, 146, 440, 190], src: [10, 346, 440, 320], stack: [460, 146, 430, 150], tree: [460, 306, 430, 360] },
  initial: { grammar: grammarView(null), src: sourceView({ sub: '从上往下解析' }), stack: stackView([]), tree: treeView(new Set()) },
  start: ['tokens'],
  legend: [['amber', '匹配记号'], ['green', '建好节点'], ['slate', '语法错误'], [null, '阶段计数数的是解析动作']],
  overview: {
    full: '每条语法规则写成一个函数',
    description: '语法分析把记号流变成树。递归下降最直接：一条规则一个函数，函数之间互相调用，调用栈的形状就是语法结构。这一课跟踪循环体里的 s = s + m * n + i，看优先级和结合性怎么由函数的调用关系决定。',
    facts: [
      ['方向', '自顶向下，从左到右'],
      ['向前看', '1 个记号'],
      ['优先级', '层次越深优先级越高'],
      ['结合性', '循环造出左结合'],
      ['真实世界', 'clang 和 GCC 的解析器都是手写的递归下降'],
    ],
  },
  steps: [
    {
      title: '规则变函数',
      desc: '看一个记号，决定调哪个函数',
      detail: '解析 stmt 时先看当前记号：是 while 就走循环，是 int 就走声明，否则当表达式。只看一个记号就能决定走哪条路，所以叫 LL(1)。L 是从左到右读，第二个 L 是最左推导，1 是向前看的个数。',
      facts: [['当前记号', 's'], ['不是 while 和 int', '走表达式这条路'], ['函数', 'stmt() → assign() → …']],
      events: [show('parser'), matchEvent(fromToken, '第一个记号 s：从 stmt 一路调到 primary 才吃掉它')],
    },
    {
      title: '一路下降',
      desc: `吃掉一个标识符要穿过 ${DESCENT} 个函数`,
      detail: `表达式的规则按优先级分层：赋值在最外，乘法在最里。要读到一个操作数，就得穿过每一层。所以从 stmt 到 primary 一下子多了 ${DESCENT} 层，但每层的函数只有几行。primary 吃掉 s 之后，上面几层发现下一个记号不是自己要的，就逐层返回。`,
      facts: [['从 stmt 往下', `${DESCENT} 层`], ['第一个节点', '变量 s'], ['s 后面的 =', '让 assign 知道这是赋值']],
      events: [matchEvent(fromToken + 1), matchEvent(fromToken + 2), show('tree')],
    },
    {
      title: '优先级',
      desc: '乘法在更深的函数里，所以先建好',
      detail: '读到 + 时，additive 要右操作数，于是调 term。term 读完 m 看到 *，就继续吃 n，把 m * n 建好才返回。没有任何优先级表，优先级完全由谁调用谁决定：term 在 additive 之下，乘法就比加法绑得更紧。',
      facts: [['先建好', 'm * n'], ['右操作数', '整个 m * n'], ['调用关系', 'additive → term → unary']],
      events: [matchEvent(plus1), matchEvent(plus1 + 1), matchEvent(star), matchEvent(star + 1), treeEvent(mulNode, 'm * n', '建好乘法节点 m * n', 'term() 的循环吃完 * 右边的 n 后建它。'), treeEvent(innerAdd, 's + m * n', '建好加法节点 s + m * n', 'additive() 拿到右操作数后建它。')],
    },
    {
      title: '左结合',
      desc: '循环把旧的树放到左边',
      detail: 'additive 用循环处理连续的加号：每轮把已有的结果当左孩子，再读一个 term 当右孩子。所以 a + b + c 成了 (a + b) + c。如果写成右递归，树会往右长，减法的结果就错了。这也是文法要写成循环的原因：LL 不能直接处理左递归，E → E + T 会无限调用自己。',
      facts: [['树的形状', '(s + m*n) + i'], ['处理方式', 'while 循环'], ['左递归', 'LL 解析器处理不了']],
      events: [matchEvent(plus2), matchEvent(plus2 + 1), treeEvent(outerAdd, 's + m * n + i', '建好最外层加法', '循环的第二轮，把上一轮的结果放到左边。'), treeEvent(root, 's = …', '建好赋值节点', 'assign() 最后建它，右边是整棵加法树。'), matchEvent(toToken, '分号由 stmt 吃掉，这条语句结束', 'blue'), note('tree', '和 clang AST 结构一致', 'green')],
    },
    {
      title: '语法错误',
      desc: '记号对不上，就停在这里',
      detail: `把第 12 行的分号删掉再解析一次。stmt 想吃分号，却看到了 }，这是一个真正的报错，位置来自记号里记下的行列号。错误信息说清楚要什么、看到什么，是手写解析器的一大好处。真实编译器还会设法恢复，继续找后面的错误。`,
      facts: [['报错位置', `第 ${brokenError.token.line} 行`], ['期望', '分号'], ['实际', '}']],
      events: [
        pk('tokens', 'parser', 'slate', '}', ['这里应该是 ;'], [2, 'ERROR', `${brokenError.token.line}:${brokenError.token.col} ${brokenError.message.replace(/^\d+:\d+: /, '')}`, 1],
          wire('对照输入：把第 12 行的分号删掉', 'mem', 'text', tokenRecord(brokenError.token, 'match(semi) 看到的是这个记号，于是抛错。', 'slate'), concept('报错', [['期望', 'semi'], ['实际', brokenError.token.kind], ['信息', brokenError.message]], 'slate')), { lost: true }),
      ],
    },
  ],
  outro: {
    title: '调用栈就是语法',
    desc: '优先级和结合性都写在了函数结构里',
    text: '递归下降好读、好调试、报错也好写，所以主流 C 编译器都手写它。它的限制是不能处理左递归，也可能要多看几个记号。真实的 C 还有麻烦：a * b; 既可能是乘法也可能是声明，解析时得查符号表才知道 a 是不是类型名。',
    facts: [['思路', '规则就是函数'], ['限制', '不能有左递归'], ['下一课', 'LR PARSER']],
  },
});

