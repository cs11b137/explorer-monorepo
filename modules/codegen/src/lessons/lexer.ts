import { dfaStep, makeLayer, textBytes, tokenRecord, wire } from '../decode/structures';
import { LEXED } from '../compiler';
import { ACCEPTING, DFA, DFA_STATES, lex, type DfaState, type LexRun } from '../compiler/lexer';
import { SOURCE, SOURCE_LINES } from '../compiler/source';
import type { ArtView, GraphEdge, GraphNode, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Color, Lesson, PacketEvent } from './types';
import { LINE_STARTS, sourceView, tokenStrip } from './views';

const POS: Record<DfaState, [number, number]> = {
  START: [226, 150], ID: [104, 54], NUM: [46, 132], WS: [46, 220], PUNCT: [130, 270],
  ASSIGN: [325, 30], EQ: [440, 30], LT: [345, 110], LE: [460, 110], GT: [345, 190], GE: [460, 190], BANG: [325, 270], NE: [440, 270],
};
const CLASS_LABEL: Record<string, string> = { letter: 'a-z_', digit: '0-9', space: '空白', punct: '+-*;,(){}' };

/** DFA 图：节点和边都从真实的转移表生成。 */
function dfaView(current: DfaState | null, from: DfaState | null = null, sub = `${DFA_STATES.length} 个状态`): ArtView {
  const merged = new Map<string, string[]>();
  for (const state of DFA_STATES) {
    for (const [cls, to] of Object.entries(DFA[state])) {
      const key = `${state}>${to}`;
      merged.set(key, [...(merged.get(key) ?? []), CLASS_LABEL[cls] ?? cls]);
    }
  }
  const edges: GraphEdge[] = [...merged].map(([key, labels]) => {
    const [a, b] = key.split('>') as [DfaState, DfaState];
    const tone: Tone | undefined = from === a && current === b ? 'amber' : undefined;
    return { from: a, to: b, label: labels.join(' '), tone };
  });
  const nodes: GraphNode[] = DFA_STATES.map((state) => ({
    id: state, x: POS[state][0], y: POS[state][1], w: 38, h: 38, shape: 'circle', label: state, ring: ACCEPTING.has(state), tone: state === current ? 'amber' : undefined,
  }));
  return { kind: 'graph', title: '词法 DFA', sub, width: 490, height: 296, nodes, edges };
}

const tokensUpTo = (offset: number) => LEXED.tokens.filter((token) => token.kind !== 'eof' && token.end <= offset).length;

function charEvents(run: LexRun, sourceText = SOURCE, inSource = true): PacketEvent[] {
  return run.steps.map((step) => {
    const shown = step.char === '\n' ? '\\n' : step.char === ' ' ? '空格' : step.char;
    const color: Color = step.to ? 'amber' : 'slate';
    return pk('source', 'lexer', color, shown, [step.to ? `${step.from} → ${step.to}` : `${step.from} 没有转移`], [1, 'CHAR', step.to ? `读 ${shown}，${step.from} → ${step.to}` : `读 ${shown}，${step.from} 没有转移，记号结束`, step.to ? 1 : null],
      wire(`词法器读 ${inSource ? 'sum.c' : `“${sourceText}”`} 第 ${step.offset} 字节`, 'mem', 'text', dfaStep(step.char, step.cls, step.from, step.to, color === 'amber' ? 'amber' : 'slate')), {
        quick: true,
        art: {
          dfa: dfaView(step.to ?? step.from, step.to ? step.from : null, step.to ? `${step.from} → ${step.to}` : '停机，记号结束'),
          ...(inSource ? { src: sourceView({ spans: [{ span: { from: run.from, to: step.to ? step.offset + 1 : step.offset }, tone: 'amber' }, ...(step.to ? [] : [{ span: { from: step.offset, to: step.offset + 1 }, tone: 'slate' as Tone }])] }) } : {}),
        },
      });
  });
}

function tokenEvent(run: LexRun, noteText?: string): PacketEvent {
  const token = run.token!;
  const count = tokensUpTo(run.to);
  return pk('lexer', 'tokens', 'blue', token.text, [token.kind], [1, 'TOKEN', `产出 ${token.kind}：${token.text}`, token.text.length],
    wire('词法器产出一个记号', 'mem', 'text', tokenRecord(token, noteText)), { art: { toks: tokenStrip(count, count - 1), src: sourceView({ spans: [{ span: { from: run.from, to: run.to }, tone: 'blue' }] }) } });
}

const tokenRuns = LEXED.runs.filter((run) => run.token);
const lessRun = tokenRuns.find((run) => run.token!.kind === 'less')!;
const LE_RUNS = lex('i<=n').runs;
const firstLine = LEXED.runs.filter((run) => run.from < SOURCE_LINES[0].length);
const tokenCount = LEXED.tokens.length - 1;

/** 剩下的行一批一批过，每批是真实的 token 序列。 */
function lineEvents(): PacketEvent[] {
  return SOURCE_LINES.flatMap((text, index) => {
    const line = index + 1;
    const list = LEXED.tokens.filter((token) => token.line === line && token.kind !== 'eof');
    if (!list.length || line === 1) return [];
    const layer = textBytes(`第 ${line} 行 · ${text.length} 字节`, text);
    const kinds = makeLayer('产出的记号', 'green', `${list.length} 个`);
    list.forEach((token) => kinds.field(token.kind, token.text, () => {}, { mono: true }));
    const count = tokensUpTo(LINE_STARTS[index] + text.length);
    return [pk('lexer', 'tokens', 'blue', `第 ${line} 行`, [list.map((token) => token.text).join(' ').slice(0, 24)], [1, 'TOKEN', `第 ${line} 行产出 ${list.length} 个：${list.map((token) => `${token.text}`).join(' ')}`, text.length],
      wire(`sum.c 第 ${line} 行`, 'mem', 'text', layer, kinds), {
        quick: true,
        art: { toks: tokenStrip(count), src: sourceView({ lines: [{ line, tone: 'blue' }] }) },
      })];
  });
}

export const lexer: Lesson = seal({
  id: 'lexer',
  name: 'LEXER',
  title: '词法分析',
  group: 'front',
  layer: [1, 1],
  nodes: ['source', 'lexer', 'tokens'],
  place: { source: [140, 56], lexer: [450, 56], tokens: [760, 56] },
  labels: { source: ['源代码', 'sum.c 的字节'], lexer: ['词法器', '表驱动 DFA'], tokens: ['TOKEN 流', '交给语法分析'] },
  panels: { src: [10, 146, 360, 340], dfa: [380, 146, 510, 340], toks: [10, 496, 880, 170] },
  initial: { src: sourceView(), dfa: dfaView(null) },
  start: ['source'],
  legend: [['amber', '读一个字符'], ['slate', 'DFA 停机'], ['blue', '产出记号'], [null, '大小是这一步读或产出的字节数']],
  overview: {
    full: '把字符流切成一个个记号',
    description: '编译器读到的源文件只是一串字节。词法器按规则把它切成关键字、标识符、数字和符号，顺手扔掉空白。这一课用真实的 DFA 转移表跑一遍 sum.c，产出的记号和 clang -dump-tokens 逐个相同。',
    facts: [
      ['示例程序', '带循环的求和函数 sum'],
      ['状态数', `${DFA_STATES.length} 个`],
      ['记号总数', `${tokenCount} 个（不含文件结束）`],
      ['切分原则', '最长匹配'],
      ['对照工具', 'clang -Xclang -dump-tokens'],
    ],
  },
  steps: [
    {
      title: '读入字节',
      desc: '词法器只看到一串字符',
      detail: '对计算机来说，int 这三个字母只是 0x69、0x6E、0x74。词法器的任务是决定在哪里切开，以及每一段算什么。它不懂语法，只看字符的排列。',
      facts: [['输入', `${SOURCE.length} 字节`], ['输出', '记号序列'], ['丢弃', '空格和换行']],
      events: [
        show('lexer'),
        pk('source', 'lexer', 'amber', 'sum.c', [`${SOURCE.length} 字节`], [1, 'CHAR', `打开 sum.c，第一行是 ${SOURCE_LINES[0]}`, SOURCE_LINES[0].length + 1],
          wire('sum.c 的第一行，换行符也是一个字节', 'mem', 'text', textBytes('sum.c 第 1 行', `${SOURCE_LINES[0]}\n`)), { art: { src: sourceView({ lines: [{ line: 1, tone: 'amber' }] }) } }),
      ],
    },
    {
      title: '跑一遍 DFA',
      desc: '一个字符走一步，直到没路可走',
      detail: 'DFA 是一张表：当前状态加上字符类，查出下一个状态。从 START 读 i 进入 ID，读 n、t 还留在 ID。读到空格时 ID 没有转移，DFA 停下，刚才走过的 int 就是一个记号。空格本身留给下一轮。',
      facts: [['当前记号', 'int'], ['结束状态', 'ID（接受）'], ['没有消耗', '让 DFA 停下的那个空格']],
      events: [...charEvents(firstLine[0]), show('tokens'), tokenEvent(firstLine[0], 'DFA 停在 ID。查关键字表后，种类变成 int。')],
    },
    {
      title: '区分关键字',
      desc: '先按标识符识别，再查一张表',
      detail: 'int 和 total 走的是同一条路，都停在 ID。区别在最后一步：拿切出来的文字查关键字表，查到就是关键字，查不到就是标识符。这样 DFA 不用为每个关键字多画几个状态，状态数能少很多。',
      facts: [['关键字', 'int while if else return'], ['total', '查不到，是 identifier'], ['空白', '进 WS 状态，不产出记号']],
      events: [
        ...charEvents(firstLine[1]).slice(0, 1),
        ...charEvents(firstLine[2]),
        tokenEvent(firstLine[2], '和 int 走同样的路径，但关键字表里没有它。'),
        tokenEvent(firstLine[3]),
        note('lexer', '查表：total 不是关键字'),
      ],
    },
    {
      title: '最长匹配',
      desc: '能多读一个字符，就多读一个',
      detail: `sum.c 里的 < 后面是空格，所以停在 LT，产出 less。如果写的是 i<=n，LT 读到 = 还能继续走到 LE，产出 lessequal，而不是 < 和 = 两个记号。规则很简单：一直走到没有转移为止。`,
      facts: [['sum.c 的 <', '后面是空格，产出 less'], ['i<=n 的 <=', '多走一步，产出 lessequal'], ['同样的规则', '= 和 ==，> 和 >=']],
      events: [
        ...charEvents(lessRun),
        tokenEvent(lessRun, '后面是空格，所以这里只有一个字符。'),
        ...charEvents(LE_RUNS[1], 'i<=n', false),
        pk('lexer', 'tokens', 'green', '<=', ['lessequal'], [1, 'TOKEN', '对照输入 i<=n：<= 是一个记号', 2],
          wire('另一段输入 i<=n，真实跑同一张表', 'mem', 'text', tokenRecord(LE_RUNS[1].token!, '这是对照输入，不属于 sum.c。', 'green')), { art: { dfa: dfaView('LE', 'LT', '对照：i<=n 走到 LE') } }),
      ],
    },
    {
      title: '扫完全程',
      desc: `一共产出 ${tokenCount} 个记号`,
      detail: `其余的行规则相同，这里按行快进。扫到文件尾再补一个 eof。把这份结果和 clang -dump-tokens 对照，种类、原文和行列号全部一致（只有 eof 的位置约定不同）；单元测试会逐个核对。clang 的词法器是手写的 C++，但做的是同一件事。`,
      facts: [['记号总数', String(tokenCount)], ['独立核对', 'clang -dump-tokens'], ['下一站', '语法分析']],
      events: lineEvents(),
    },
  ],
  outro: {
    title: '字节变成了记号',
    desc: '后面的阶段再也不用管空白和字符了',
    text: `词法分析把 ${SOURCE.length} 字节压缩成 ${tokenCount} 个带类型和位置的记号。它只看局部的字符，不知道 total 是不是声明过，也不知道括号配不配对，这些都是后面阶段的事。`,
    facts: [['核心算法', '表驱动 DFA，最长匹配'], ['常见误解', '关键字不必有专门的状态'], ['下一课', 'LL PARSER']],
  },
});

