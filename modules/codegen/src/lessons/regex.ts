import { concept, dfaTable, textBytes, wire } from '../decode/structures';
import { DFA, MIN_DFA, NFA } from '../compiler';
import { DFA as LEXER_DFA } from '../compiler/lexer';
import { LEXER_KINDS, matchLexer, TOKEN_RULES, type NfaEdge, type Re, type ThompsonStep } from '../compiler/regex';
import type { ArtView, CodeLine, GraphEdge, GraphNode, Tone, TreeNode } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Color, Lesson, LessonEvent, PacketEvent } from './types';

const MAPPING = matchLexer(MIN_DFA, LEXER_DFA, LEXER_KINDS);
if (!MAPPING) throw new Error('最小化的 DFA 和词法器的转移表对不上');
const lexName = (group: number) => MAPPING.get(group)!;

const setText = (set: number[]) => `{${set.join(' ')}}`;
const KIND_SHORT: Record<string, string> = { identifier: 'identifier', numeric_constant: 'numeric_constant' };

// ---------- 规则文本 ----------

const RULE_LINES: CodeLine[] = [
  { text: 'L = [A-Za-z_]', note: '字母或下划线' },
  { text: 'D = [0-9]', note: '数字' },
  { text: '' },
  ...TOKEN_RULES.map((rule) => ({ text: `${rule.kind} = ${rule.re}` })),
];

function rulesView(lit?: number, sub = '两条规则，字母表是 L 和 D'): ArtView {
  return { kind: 'code', title: '词法规则', sub, lines: RULE_LINES.map((line, index) => ({ ...line, tone: lit !== undefined && index === lit + 3 ? 'amber' as Tone : undefined })), size: 14 };
}

// ---------- 正则的语法树 ----------

const reIds = new Map<Re, string>();
NFA.trees.forEach((tree, rule) => {
  let next = 0;
  const walk = (re: Re) => {
    reIds.set(re, `${rule}-${next++}`);
    if (re.k === 'cat' || re.k === 'alt') {
      walk(re.a);
      walk(re.b);
    } else if (re.k === 'star') walk(re.e);
  };
  walk(tree);
});
const RE_LABEL: Record<Re['k'], string> = { sym: '', cat: '·', alt: '|', star: '*' };

/** 某条规则的语法树。built 里的节点在下面标出片段的开始和接受状态。 */
function treeView(rule: number, built: Map<Re, ThompsonStep>, lit?: Re): ArtView {
  const nodes: TreeNode[] = [];
  const walk = (re: Re, parent: string | null) => {
    const step = built.get(re);
    nodes.push({
      id: reIds.get(re)!, parent, label: re.k === 'sym' ? re.s : RE_LABEL[re.k], tone: re === lit ? 'amber' : step ? 'green' : undefined,
      sub: step ? `${step.fragment.start}→${step.fragment.accept}` : ' ',
    });
    if (re.k === 'cat' || re.k === 'alt') {
      walk(re.a, reIds.get(re)!);
      walk(re.b, reIds.get(re)!);
    } else if (re.k === 'star') walk(re.e, reIds.get(re)!);
  };
  walk(NFA.trees[rule], null);
  return { kind: 'tree', title: `${TOKEN_RULES[rule].kind} 的语法树`, sub: TOKEN_RULES[rule].re, nodes };
}

// ---------- NFA 图 ----------

const NFA_W = 860;
const NFA_H = 232;
const colW = (NFA_W - 60) / (NFA.cols - 1);
const rowH = NFA_H / NFA.rows;
const at = (state: number): [number, number] => {
  const [col, row] = NFA.grid.get(state)!;
  return [30 + col * colW, row * rowH];
};

/** 同一行上往回连或跳过中间状态的空转移，要绕开中间的状态：回边从上面绕，跳过的边从下面绕。 */
function liftOf(edge: NfaEdge): number | undefined {
  const [c1, r1] = NFA.grid.get(edge.from)!;
  const [c2, r2] = NFA.grid.get(edge.to)!;
  if (r1 !== r2 || (c2 > c1 && c2 - c1 <= 1)) return undefined;
  const lo = Math.min(c1, c2);
  const hi = Math.max(c1, c2);
  let reach = 0;
  for (const [, [col, row]] of NFA.grid) {
    if (col > lo && col < hi && Math.abs(row - r1) <= 1.5) reach = Math.max(reach, Math.abs(row - r1));
  }
  const apex = (reach + 0.6) * rowH;
  return (c2 < c1 ? -2 : 2) * apex;
}

interface NfaOpts {
  /** 只画已经建好的状态和边；不给就画整个 NFA。 */
  shown?: Set<number>;
  shownEdges?: Set<NfaEdge>;
  lit?: Set<number>;
  litTone?: Tone;
  /** 第二种高亮：子集构造时 move 到的状态。 */
  marked?: Set<number>;
  edges?: Set<NfaEdge>;
  sub: string;
}

function nfaView(opts: NfaOpts): ArtView {
  const visible = (state: number) => !opts.shown || opts.shown.has(state);
  const nodes: GraphNode[] = [];
  for (let state = 0; state < NFA.count; state++) {
    if (!visible(state)) continue;
    const [x, y] = at(state);
    const tone = opts.lit?.has(state) ? opts.litTone ?? 'amber' : opts.marked?.has(state) ? 'blue' : undefined;
    nodes.push({ id: String(state), x, y, w: 28, h: 28, shape: 'circle', label: String(state), ring: NFA.accepts.has(state), tone });
  }
  const edges: GraphEdge[] = NFA.edges.filter((edge) => !opts.shownEdges || opts.shownEdges.has(edge)).map((edge) => ({
    from: String(edge.from), to: String(edge.to), label: edge.sym ?? undefined, dash: edge.sym === null, lift: liftOf(edge),
    tone: opts.edges?.has(edge) ? opts.litTone ?? 'amber' : undefined,
  }));
  return { kind: 'graph', title: 'NFA', sub: opts.sub, width: NFA_W, height: NFA_H, nodes, edges };
}

// ---------- DFA 图 ----------

const DFA_POS: Record<string, [number, number]> = { A: [26, 104], B: [112, 56], C: [112, 156], D: [212, 44], E: [302, 112], F: [212, 156] };
const DFA_BEND: Record<string, number> = { 'D>E': 14, 'E>D': -14 };
/** E 的入边都从上面来，自环放到下面。 */
const LOOP_BELOW = new Set(['E']);

function dfaView(opts: { upTo: number; lit?: string; litTone?: Tone; groupTone?: Map<string, Tone>; sub: string; edge?: string }): ArtView {
  const known = DFA.states.slice(0, opts.upTo);
  const nodes: GraphNode[] = known.map((state) => ({
    id: state.name, x: DFA_POS[state.name][0], y: DFA_POS[state.name][1], w: 34, h: 34, shape: 'circle', label: state.name, ring: Boolean(state.accept),
    tone: state.name === opts.lit ? opts.litTone ?? 'amber' : opts.groupTone?.get(state.name),
  }));
  const edges: GraphEdge[] = [];
  for (const state of known) {
    for (const [sym, to] of DFA.trans.get(state.name)!) {
      if (!known.some((item) => item.name === to)) continue;
      const key = `${state.name}>${to}`;
      edges.push({ from: state.name, to, label: sym, bend: DFA_BEND[key], lift: to === state.name && LOOP_BELOW.has(to) ? 1 : undefined, tone: opts.edge === `${key}:${sym}` ? opts.litTone ?? 'amber' : undefined });
    }
  }
  return { kind: 'graph', title: '子集构造得到的 DFA', sub: opts.sub, width: 330, height: 188, nodes, edges };
}

const groupName = (group: string[]) => group.join('');
const MIN_POS: Array<[number, number]> = [[50, 100], [210, 52], [210, 152]];

function minView(lit?: number, sub = `${MIN_DFA.groups.length} 个状态`, useLexer = false): ArtView {
  const name = (index: number) => (useLexer ? lexName(index) : groupName(MIN_DFA.groups[index]));
  const nodes: GraphNode[] = MIN_DFA.groups.map((_group, index) => ({
    id: String(index), x: MIN_POS[index][0], y: MIN_POS[index][1], w: 46, h: 46, shape: 'circle', label: name(index), ring: Boolean(MIN_DFA.accept[index]), tone: index === lit ? 'green' : undefined,
  }));
  const merged = new Map<string, string[]>();
  for (const [from, row] of MIN_DFA.trans) {
    for (const [sym, to] of row) merged.set(`${from}>${to}`, [...(merged.get(`${from}>${to}`) ?? []), sym]);
  }
  const edges: GraphEdge[] = [...merged].map(([key, syms]) => {
    const [from, to] = key.split('>');
    return { from, to, label: syms.join(' ') };
  });
  return { kind: 'graph', title: useLexer ? '词法器里的这一部分' : '最小化后的 DFA', sub, width: 330, height: 188, nodes, edges };
}

// ---------- 子集表 ----------

function subsetTable(rows: number, cells: Map<string, string>, lit?: string, litCell?: string): ArtView {
  return {
    kind: 'table',
    title: '子集构造',
    sub: `${rows} 个 DFA 状态`,
    cols: ['DFA', 'NFA 状态集合', 'L', 'D', '接受'],
    widths: [36, 150, 34, 34, 126],
    rows: DFA.states.slice(0, rows).map((state) => ({
      cells: [state.name, setText(state.set), cells.get(`${state.name}:L`) ?? '', cells.get(`${state.name}:D`) ?? '', state.accept ? KIND_SHORT[state.accept] : ''],
      tone: state.name === lit ? 'amber' as Tone : undefined,
      tones: [null, null, litCell === `${state.name}:L` ? 'green' as Tone : null, litCell === `${state.name}:D` ? 'green' as Tone : null, null],
    })),
    size: 12,
  };
}

const GROUP_TONES: Tone[] = ['slate', 'blue', 'amber', 'teal', 'violet'];

function partitionTable(round: number, lit?: number): ArtView {
  const info = MIN_DFA.rounds[round];
  return {
    kind: 'table',
    title: '划分',
    sub: `第 ${round + 1} 轮`,
    cols: ['组', '状态', '读 L 到', '读 D 到'],
    widths: [30, 110, 110, 110],
    rows: info.groups.map((group, index) => {
      const sigs = group.map((name) => info.signatures.get(name)!);
      const show = (col: number) => [...new Set(sigs.map((sig) => (sig[col] < 0 ? '无' : `第 ${sig[col]} 组`)))].join('、');
      return { cells: [String(index), group.join(' '), show(0), show(1)], tone: index === lit ? GROUP_TONES[index] : undefined };
    }),
    size: 12,
  };
}

function compareTable(lit?: number): ArtView {
  return {
    kind: 'table',
    title: '和词法器的转移表对照',
    sub: 'lexer.ts 的 DFA',
    cols: ['最小 DFA', '词法器', '读 L', '读 D', '接受'],
    widths: [64, 56, 56, 56, 128],
    rows: MIN_DFA.groups.map((group, index) => {
      const row = MIN_DFA.trans.get(index)!;
      const to = (sym: string) => (row.has(sym) ? lexName(row.get(sym)!) : '无');
      return { cells: [groupName(group), lexName(index), to('L'), to('D'), MIN_DFA.accept[index] ?? ''], tone: index === lit ? 'green' as Tone : undefined };
    }),
    size: 12,
  };
}

// ---------- 事件 ----------

const built = new Map<Re, ThompsonStep>();
const shownStates = new Set<number>();
const shownEdges = new Set<NfaEdge>();

function thompsonEvent(step: ThompsonStep, quick: boolean): PacketEvent {
  built.set(step.re, step);
  step.states.forEach((state) => shownStates.add(state));
  step.edges.forEach((edge) => shownEdges.add(edge));
  const rule = step.rule;
  const { start, accept } = step.fragment;
  const empties = step.edges.filter((edge) => edge.sym === null).length;
  let info: string;
  let why: string;
  if (step.re.k === 'sym') {
    info = `${step.text}：新建状态 ${step.states.join(' 和 ')}，中间一条 ${step.text} 边`;
    why = '最小的片段：读一个符号，从开始走到接受。';
  } else if (step.re.k === 'alt') {
    info = `${step.text}：新开始 ${start} 分到两支，两支汇到新接受 ${accept}`;
    why = '四条空转移：开始分到两支，两支的接受汇到一起。';
  } else if (step.re.k === 'star') {
    info = `${step.text}：新开始 ${start}、新接受 ${accept}，加回边和跳过的边`;
    why = '回边让内部可以重复，跳过的边允许一次也不走。';
  } else {
    info = `${step.text}：状态 ${step.merged!.into} 既是左段的接受，也是右段的开始`;
    why = '连接不加新状态：把右段的开始并进左段的接受。';
  }
  const rows: Array<[string, string, string?]> = [
    ['子表达式', step.text],
    ['新状态', step.states.length ? step.states.join(' ') : '无'],
    ['新边', step.edges.length ? `${step.edges.length} 条，空转移 ${empties} 条` : '无', why],
    ['片段', `${start} → ${accept}`, '每个片段只有一个开始和一个接受，开始没有入边，接受没有出边。'],
  ];
  return pk('regex', 'nfa', 'amber', step.text, [step.states.length ? `新状态 ${step.states.join(' ')}` : `合并到 ${step.merged!.into}`], [1, 'NFA', info, null],
    wire('Thompson 构造的一步', 'mem', '示意', concept(`Thompson · ${step.text}`, rows, 'amber')), {
      quick,
      art: {
        nfa: nfaView({ shown: new Set(shownStates), shownEdges: new Set(shownEdges), lit: new Set([...step.states, start, accept]), edges: new Set(step.edges), sub: `已有 ${shownStates.size} 个状态` }),
        side: treeView(rule, new Map(built), step.re),
      },
    });
}

const ruleSteps = (rule: number) => NFA.steps.filter((step) => step.rule === rule);
const idEvents = ruleSteps(0).map((step, index) => thompsonEvent(step, index === 1));
const numEvents = ruleSteps(1).map((step) => thompsonEvent(step, true));
const joinStep = NFA.steps.find((step) => step.rule === -1)!;
joinStep.states.forEach((state) => shownStates.add(state));
const joinEvent = pk('regex', 'nfa', 'amber', '合并', [`开始状态 ${NFA.start}`], [1, 'NFA', `两条规则合成一个 NFA：新开始 ${NFA.start} 用空转移连到 ${NFA.fragments.map((item) => item.start).join(' 和 ')}`, null],
  wire('多条规则共用一个开始状态', 'mem', '示意', concept('合并规则', [
    ['新开始', String(NFA.start)],
    ['接受 identifier', String(NFA.fragments[0].accept), '每条规则保留自己的接受状态，记住它产出哪种记号。'],
    ['接受 numeric_constant', String(NFA.fragments[1].accept)],
    ['总状态数', String(NFA.count)],
  ], 'amber')), { art: { nfa: nfaView({ lit: new Set([NFA.start]), edges: new Set(joinStep.edges), sub: `${NFA.count} 个状态，${NFA.edges.length} 条边` }) } });

const ruleEvents: PacketEvent[] = TOKEN_RULES.map((rule, index) =>
  pk('regex', 'nfa', 'blue', rule.kind, [rule.re], [1, 'NFA', `规则 ${rule.kind} = ${rule.re}，先解析成语法树`, rule.re.length],
    wire('规则的原文', 'mem', 'text', textBytes(`${rule.kind} 的正则`, rule.re, 'blue', `${rule.re.length} 字节`)), {
      quick: index > 0,
      art: { side: treeView(index, new Map()), nfa: rulesView(index) },
    }));

// 子集构造：先求开始状态的闭包，再对每个 DFA 状态试每个符号。
const cells = new Map<string, string>();
let discovered = 1;
const startState = DFA.states[0];
const startEvent = pk('nfa', 'dfa', 'green', `A = ${setText(startState.set)}`, ['开始状态的闭包'], [1, 'DFA', `开始：从 ${NFA.start} 只走空转移能到 ${setText(startState.set)}，记作 A`, null],
  wire('DFA 状态是 NFA 状态的集合', 'mem', '示意', concept('闭包', [['出发', `{${NFA.start}}`], ['只走空转移能到', setText(startState.set)], ['DFA 状态', 'A', '不接受：集合里没有接受状态。']], 'green')), {
    art: { nfa: nfaView({ lit: new Set(startState.set), litTone: 'green', sub: 'A 的闭包' }), subset: subsetTable(1, new Map(), 'A'), side: dfaView({ upTo: 1, lit: 'A', litTone: 'green', sub: '开始状态' }) },
  });

const subsetEvents: PacketEvent[] = DFA.steps.map((step, index) => {
  const from = DFA.states.find((state) => state.name === step.from)!;
  if (step.to) cells.set(`${step.from}:${step.sym}`, step.to);
  if (step.fresh) discovered++;
  const key = `${step.from}:${step.sym}`;
  const color: Color = !step.to ? 'slate' : step.fresh ? 'green' : 'blue';
  const target = DFA.states.find((state) => state.name === step.to);
  const info = step.to
    ? `${step.from} 读 ${step.sym}：到 ${setText(step.move)}，闭包 ${setText(step.closure)}，${step.fresh ? `新状态 ${step.to}` : `已有的 ${step.to}`}`
    : `${step.from} 读 ${step.sym}：集合里没有 ${step.sym} 边，没有转移`;
  const rows: Array<[string, string, string?]> = step.to
    ? [['当前', `${step.from} = ${setText(from.set)}`], ['读', step.sym], ['move', setText(step.move), `集合里的状态沿 ${step.sym} 边能到的状态。`], ['闭包', setText(step.closure), '再把只走空转移能到的都加进来。'], ['结果', step.fresh ? `${step.to}（新）` : step.to, target?.accept ? `含接受状态 ${target.acceptBy}，接受 ${target.accept}。` : '不含接受状态。']]
    : [['当前', `${step.from} = ${setText(from.set)}`], ['读', step.sym], ['move', '空集', '这里不补死状态：没有转移就是停机，由最长匹配收尾。']];
  return pk('nfa', 'dfa', color, `${step.from} ${step.sym}`, [step.to ? `→ ${step.to}` : '无转移'], [1, 'DFA', info, null],
    wire('子集构造的一步', 'mem', '示意', concept(`${step.from} 读 ${step.sym}`, rows, color)), {
      quick: index > 3,
      art: {
        subset: subsetTable(discovered, new Map(cells), step.from, step.to ? key : undefined),
        nfa: nfaView({ lit: new Set(step.closure), litTone: 'green', marked: new Set(from.set), sub: step.to ? `${step.from} 读 ${step.sym}，得到 ${step.to}` : `${step.from} 读 ${step.sym}，没有转移` }),
        side: dfaView({ upTo: discovered, lit: step.to ?? step.from, litTone: step.to ? 'green' : 'slate', edge: step.to ? `${step.from}>${step.to}:${step.sym}` : undefined, sub: `${discovered} 个状态` }),
      },
    });
});

// 最小化。
const finalRound = MIN_DFA.rounds.length - 1;
const groupTone = new Map(MIN_DFA.groups.flatMap((group, index) => group.map((name) => [name, GROUP_TONES[index]] as [string, Tone])));
const firstGroups = MIN_DFA.rounds[0].groups;
const partitionEvent = pk('dfa', 'lexer', 'violet', '初始划分', firstGroups.map(groupName), [1, 'DFA', `按接受什么记号先分 ${firstGroups.length} 组：${firstGroups.map((group) => `{${group.join(' ')}}`).join(' ')}`, null],
  wire('等价状态的划分', 'mem', '示意', concept('初始划分', firstGroups.map((group, index) => [`第 ${index} 组`, group.join(' '), index ? `接受 ${DFA.states.find((state) => state.name === group[0])!.accept}。` : '不接受。'] as [string, string, string]), 'violet')), {
    art: { subset: partitionTable(0), side: dfaView({ upTo: DFA.states.length, groupTone, sub: '颜色是分组' }), nfa: nfaView({ lit: new Set(NFA.accepts.keys()), litTone: 'violet', sub: '接受状态决定初始分组' }) },
  });

const checkEvents: PacketEvent[] = MIN_DFA.rounds[finalRound].groups.filter((group) => group.length > 1).map((group) => {
  const index = MIN_DFA.rounds[finalRound].groups.indexOf(group);
  const sig = MIN_DFA.rounds[finalRound].signatures.get(group[0])!;
  const where = (value: number) => (value < 0 ? '都没有转移' : `都到第 ${value} 组`);
  return pk('dfa', 'lexer', 'violet', `{${group.join(' ')}}`, ['不用再分'], [1, 'DFA', `${group.join(' ')}：读 L ${where(sig[0])}，读 D ${where(sig[1])}，不用再分`, null],
    wire('同组的状态去向相同，就分不开', 'mem', '示意', concept(`第 ${index} 组`, group.map((name) => [name, MIN_DFA.rounds[finalRound].signatures.get(name)!.map((value, col) => `${DFA.symbols[col]}→${value < 0 ? '无' : `第 ${value} 组`}`).join(' ')] as [string, string]), 'violet')), {
      quick: true,
      art: { subset: partitionTable(finalRound, index), side: dfaView({ upTo: DFA.states.length, groupTone, lit: group[0], litTone: GROUP_TONES[index], sub: `检查第 ${index} 组` }) },
    });
});

const mergeEvent = pk('dfa', 'lexer', 'green', `${MIN_DFA.groups.length} 个状态`, MIN_DFA.groups.map(groupName), [1, 'DFA', `${DFA.states.length} 个状态合并成 ${MIN_DFA.groups.length} 个：${MIN_DFA.groups.map(groupName).join('、')}`, null],
  wire('每组合成一个状态', 'mem', '示意', concept('最小化结果', MIN_DFA.groups.map((group, index) => [groupName(group), MIN_DFA.accept[index] ?? '不接受'] as [string, string]), 'green')), {
    art: { side: minView(), subset: partitionTable(finalRound) },
  });

const symbols = DFA.symbols;
const tableRows = MIN_DFA.groups.map((_group, index) => ({ name: lexName(index), next: symbols.map((sym) => MIN_DFA.trans.get(index)!.get(sym) ?? null), accept: MIN_DFA.accept[index] }));
const tableEvent = pk('dfa', 'lexer', 'green', '转移表', [`${tableRows.length} × ${symbols.length} 字节`], [1, 'DFA', `写成转移表：${tableRows.length} 行 ${symbols.length} 列，一格一个字节`, tableRows.length * symbols.length],
  wire('最小 DFA 的转移表，0xFF 是没有转移', 'mem', 'text', dfaTable(tableRows, symbols)), { art: { subset: compareTable(), side: minView(undefined, '和词法器同名', true) } });

const compareEvents: PacketEvent[] = MIN_DFA.groups.map((group, index) =>
  pk('dfa', 'lexer', 'green', `${groupName(group)} = ${lexName(index)}`, [MIN_DFA.accept[index] ?? '不接受'], [1, 'DFA', `${groupName(group)} 对应词法器的 ${lexName(index)}：转移和接受的记号都相同`, null],
    wire('两张表一格一格对照', 'mem', '示意', concept(`${groupName(group)} 和 ${lexName(index)}`, symbols.map((sym) => {
      const ours = MIN_DFA.trans.get(index)!.get(sym);
      return [`读 ${sym}`, ours === undefined ? '都没有转移' : `都到 ${lexName(ours)}`] as [string, string];
    }), 'green')), { quick: index > 0, art: { subset: compareTable(index), side: minView(index, '和词法器同名', true) } }));

const nfaStateCount = NFA.count;
const finalEvents: LessonEvent[] = [tableEvent, ...compareEvents, note('lexer', '和 lexer.ts 的表相同', 'green')];

export const regex: Lesson = seal({
  id: 'regex',
  name: 'REGEX',
  title: '正则到自动机',
  group: 'front',
  layer: [1, 1],
  nodes: ['regex', 'nfa', 'dfa', 'lexer'],
  place: { regex: [140, 56], nfa: [347, 56], dfa: [553, 56], lexer: [760, 56] },
  labels: { regex: ['词法规则', '正则表达式'], nfa: ['NFA', 'Thompson 构造'], dfa: ['DFA', '子集构造'], lexer: ['词法器', '最小化后的表'] },
  panels: { nfa: [10, 146, 880, 280], subset: [10, 436, 520, 230], side: [540, 436, 350, 230] },
  initial: { nfa: rulesView(), side: treeView(0, new Map()) },
  start: ['regex'],
  legend: [['blue', '规则'], ['amber', 'Thompson 构造'], ['green', '子集构造'], ['violet', '最小化'], [null, '虚线是空转移']],
  overview: {
    full: '词法器的转移表从哪里来',
    description: `下一课的词法器用一张手写的 DFA 表。这张表可以从正则表达式自动生成，lex 和 flex 就是这么做的。这一课取标识符和数字两条规则，用 Thompson 构造得到 ${nfaStateCount} 个状态的 NFA，子集构造得到 ${DFA.states.length} 个状态的 DFA，再最小化成 ${MIN_DFA.groups.length} 个，结果和词法器里的那一部分完全相同。`,
    facts: [
      ['规则', TOKEN_RULES.map((rule) => rule.re).join('，')],
      ['NFA', `${nfaStateCount} 个状态，${NFA.edges.length} 条边`],
      ['DFA', `${DFA.states.length} 个状态`],
      ['最小化后', `${MIN_DFA.groups.length} 个状态`],
      ['独立核对', '龙书 (a|b)*abb 的例子逐集合相同'],
    ],
  },
  steps: [
    {
      title: '写出规则',
      desc: '每种记号一条正则',
      detail: '标识符是一个字母后面跟任意多个字母或数字，写成 L(L|D)*；数字是一个数字后面跟任意多个数字，写成 DD*。L 和 D 是词法器里的字符类，这样字母表只有两个符号。正则先解析成语法树：闭包优先级最高，其次是连接，选择最低。',
      facts: [['L', '字母或下划线'], ['D', '数字'], ['运算', '连接、选择 |、闭包 *']],
      events: [show('nfa'), ...ruleEvents],
    },
    {
      title: 'Thompson 构造',
      desc: '按语法树自底向上拼片段',
      detail: '每个子表达式变成一个只有一个开始、一个接受的片段。符号是两个状态加一条边；选择和闭包各加两个新状态，用空转移把子片段接起来；连接直接把前一段的接受当成后一段的开始。这样得到的 NFA 状态数不超过正则长度的两倍。',
      facts: [['符号', '2 个状态，1 条边'], ['选择、闭包', '各加 2 个状态、4 条空转移'], ['连接', '不加状态']],
      events: [...idEvents],
    },
    {
      title: '合并两条规则',
      desc: '一个开始状态，两个接受状态',
      detail: `数字的规则用同样的办法构造。最后加一个新开始状态 ${NFA.start}，用空转移连到两条规则的开始。两个接受状态分别记住自己产出 identifier 还是 numeric_constant，这样一个自动机就能同时识别两种记号。`,
      facts: [['状态', String(nfaStateCount)], ['接受 identifier', String(NFA.fragments[0].accept)], ['接受 numeric_constant', String(NFA.fragments[1].accept)]],
      events: [...numEvents, joinEvent],
    },
    {
      title: '子集构造',
      desc: 'NFA 能同时在的状态，合成 DFA 的一个状态',
      detail: `NFA 读一个字符可能有几条路，DFA 把这些可能同时在的状态打包成一个状态。从开始状态的闭包 A 出发，对每个符号先算 move，再求闭包，没见过的集合就是新的 DFA 状态。集合里有接受状态，这个 DFA 状态就接受；${DFA.states.length} 个集合全部试完就结束。`,
      facts: [['开始', `A = ${setText(startState.set)}`], ['DFA 状态', String(DFA.states.length)], ['没有转移', 'C 和 F 读 L 停机']],
      events: [show('dfa'), startEvent, ...subsetEvents],
    },
    {
      title: '最小化',
      desc: '去向相同的状态合成一个',
      detail: '先按接受什么记号分组：不接受的 A，接受标识符的 B D E，接受数字的 C F。然后检查同组的状态读同一个符号是否都去同一组，不是就拆开，直到不再变化。这里第一轮就稳定了，B D E 合成一个，C F 合成一个。',
      facts: [['算法', 'Moore 的划分细化'], ['初始分组', '按接受的记号'], ['结果', `${DFA.states.length} 个变 ${MIN_DFA.groups.length} 个`]],
      events: [show('lexer'), partitionEvent, ...checkEvents, mergeEvent],
    },
    {
      title: '放进词法器',
      desc: '和手写的那张表一样',
      detail: `最小化后的 ${MIN_DFA.groups.length} 个状态正好对应词法器里的 START、ID、NUM：转移一格一格相同，接受的记号也相同。关键字没有单独的状态，int 也停在 ID，再查关键字表。词法器里其余的状态来自运算符和空白的规则，构造方法完全一样。`,
      facts: [['A', 'START'], ['B D E', 'ID'], ['C F', 'NUM']],
      events: finalEvents,
    },
  ],
  outro: {
    title: '正则变成了一张表',
    desc: '词法器生成器做的就是这几步',
    text: `从两条正则到 ${MIN_DFA.groups.length} 行的转移表，每一步都是机械的算法。flex 也是这样生成扫描器的，只是规则更多、表更大，还会压缩表的存储。子集构造在最坏情况下状态数是指数级，但词法规则通常很小，实际得到的 DFA 并不大。`,
    facts: [['Thompson', '正则到 NFA'], ['子集构造', 'NFA 到 DFA'], ['下一课', 'LEXER']],
  },
});
