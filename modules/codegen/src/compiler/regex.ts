/**
 * 正则到 DFA：Thompson 构造 NFA，子集构造得到 DFA，再按等价类最小化。
 * 字母表是符号：词法规则里 L 代表字母或下划线，D 代表数字，和词法器的字符类一一对应。
 * 连接时把前一段的接受状态和后一段的开始状态合并，编号沿用龙书第 3.7 节的顺序。
 */
import type { CharClass, TokenKind } from './lexer';

export type Re =
  | { k: 'sym'; s: string }
  | { k: 'cat'; a: Re; b: Re }
  | { k: 'alt'; a: Re; b: Re }
  | { k: 'star'; e: Re };

/** 规则里的符号对应词法器的哪个字符类。 */
export const SYMBOL_CLASS: Record<string, CharClass> = { L: 'letter', D: 'digit' };

const SPECIAL = new Set(['(', ')', '|', '*']);

/** 递归下降：选择的优先级最低，其次是连接，闭包最高。 */
export function parseRegex(text: string): Re {
  let at = 0;
  const peek = () => text[at];
  const alt = (): Re => {
    let left = cat();
    while (peek() === '|') {
      at++;
      left = { k: 'alt', a: left, b: cat() };
    }
    return left;
  };
  const cat = (): Re => {
    let left = star();
    while (at < text.length && peek() !== '|' && peek() !== ')') left = { k: 'cat', a: left, b: star() };
    return left;
  };
  const star = (): Re => {
    let base = atom();
    while (peek() === '*') {
      at++;
      base = { k: 'star', e: base };
    }
    return base;
  };
  const atom = (): Re => {
    const char = peek();
    if (char === '(') {
      at++;
      const inner = alt();
      if (peek() !== ')') throw new Error(`第 ${at} 个字符处缺少 )`);
      at++;
      return inner;
    }
    if (char === undefined || SPECIAL.has(char)) throw new Error(`第 ${at} 个字符处需要一个符号`);
    at++;
    return { k: 'sym', s: char };
  };
  const tree = alt();
  if (at !== text.length) throw new Error(`第 ${at} 个字符处多了 ${text[at]}`);
  return tree;
}

const PRECEDENCE: Record<Re['k'], number> = { alt: 0, cat: 1, star: 2, sym: 3 };

/** 打印成最少括号的写法。 */
export function fmtRe(re: Re): string {
  const wrap = (child: Re, level: number) => (PRECEDENCE[child.k] < level ? `(${fmtRe(child)})` : fmtRe(child));
  switch (re.k) {
    case 'sym': return re.s;
    case 'cat': return `${wrap(re.a, 1)}${wrap(re.b, 1)}`;
    case 'alt': return `${wrap(re.a, 0)}|${wrap(re.b, 1)}`;
    case 'star': return `${wrap(re.e, 2)}*`;
  }
}

export interface NfaEdge { from: number; to: number; /** null 是空转移。 */ sym: string | null }

/** 词法器的 ID、NUM 状态接受的记号种类，用来和最小化的结果对照。ID 还要查关键字表，这里按标识符算。 */
export const LEXER_KINDS: Record<string, TokenKind> = { ID: 'identifier', NUM: 'numeric_constant' };

export interface Fragment { start: number; accept: number }

/** 构造的一步：一个子表达式变成一个片段。 */
export interface ThompsonStep {
  re: Re;
  text: string;
  /** 这一步新建的状态和边。 */
  states: number[];
  edges: NfaEdge[];
  fragment: Fragment;
  /** 连接时被合并掉的开始状态，合并到哪个状态。 */
  merged: { into: number } | null;
  /** 属于第几条规则；合并多条规则的那一步是 -1。 */
  rule: number;
}

export interface Rule { kind: TokenKind; re: string }

export interface Nfa {
  count: number;
  start: number;
  edges: NfaEdge[];
  /** 接受状态对应的记号种类，规则在前的优先。 */
  accepts: Map<number, TokenKind>;
  symbols: string[];
  steps: ThompsonStep[];
  /** 每条规则的语法树，构造步骤里的 re 就指向其中的节点。 */
  trees: Re[];
  /** 每条规则的片段。 */
  fragments: Fragment[];
  /** 画图用的格点：列、行，行可以是小数。 */
  grid: Map<number, [number, number]>;
  rows: number;
  cols: number;
}

interface Built {
  start: number;
  accept: number;
  /** 片段里的全部状态，按结构顺序。最后统一编号就用这个顺序。 */
  order: number[];
  w: number;
  h: number;
  mid: number;
  pos: Map<number, [number, number]>;
}

/**
 * Thompson 构造。临时编号按创建先后，构造完再按“结构顺序”重新编号：
 * 选择是新开始、左支、右支、新接受；闭包是新开始、内部、新接受；连接是左段再右段。
 */
export function thompson(rules: Rule[]): Nfa {
  let next = 0;
  const edges: NfaEdge[] = [];
  const steps: ThompsonStep[] = [];
  const fresh = () => next++;
  const add = (from: number, to: number, sym: string | null, list: NfaEdge[]) => {
    const edge = { from, to, sym };
    edges.push(edge);
    list.push(edge);
    return edge;
  };
  const shift = (pos: Map<number, [number, number]>, dx: number, dy: number, into: Map<number, [number, number]>) => {
    for (const [state, [x, y]] of pos) into.set(state, [x + dx, y + dy]);
  };

  const build = (re: Re, rule: number): Built => {
    const made: NfaEdge[] = [];
    let result: Built;
    let merged: { into: number } | null = null;
    let fresh2: number[] = [];
    if (re.k === 'sym') {
      const start = fresh();
      const accept = fresh();
      fresh2 = [start, accept];
      add(start, accept, re.s, made);
      result = { start, accept, order: [start, accept], w: 1, h: 1, mid: 0.5, pos: new Map([[start, [0, 0.5]], [accept, [1, 0.5]]]) };
    } else if (re.k === 'cat') {
      const a = build(re.a, rule);
      const b = build(re.b, rule);
      // 右段的开始状态没有入边，把它的出边都挪到左段的接受状态上，然后删掉它。
      for (const edge of edges) if (edge.from === b.start) edge.from = a.accept;
      merged = { into: a.accept };
      const mid = Math.max(a.mid, b.mid);
      const pos = new Map<number, [number, number]>();
      shift(a.pos, 0, mid - a.mid, pos);
      const bPos = new Map(b.pos);
      bPos.delete(b.start);
      shift(bPos, a.w, mid - b.mid, pos);
      const removed = b.start;
      for (const step of steps) {
        step.states = step.states.map((state) => (state === removed ? a.accept : state));
        if (step.fragment.start === removed) step.fragment = { ...step.fragment, start: a.accept };
      }
      result = {
        start: a.start, accept: b.accept, order: [...a.order, ...b.order.filter((state) => state !== removed)],
        w: a.w + b.w, h: Math.max(mid - a.mid + a.h, mid - b.mid + b.h), mid, pos,
      };
    } else if (re.k === 'alt') {
      const a = build(re.a, rule);
      const b = build(re.b, rule);
      const start = fresh();
      const accept = fresh();
      fresh2 = [start, accept];
      add(start, a.start, null, made);
      add(start, b.start, null, made);
      add(a.accept, accept, null, made);
      add(b.accept, accept, null, made);
      const inner = Math.max(a.w, b.w);
      const h = a.h + b.h;
      const pos = new Map<number, [number, number]>([[start, [0, h / 2]], [accept, [inner + 2, h / 2]]]);
      shift(a.pos, 1, 0, pos);
      shift(b.pos, 1, a.h, pos);
      result = { start, accept, order: [start, ...a.order, ...b.order, accept], w: inner + 2, h, mid: h / 2, pos };
    } else {
      const e = build(re.e, rule);
      const start = fresh();
      const accept = fresh();
      fresh2 = [start, accept];
      add(start, e.start, null, made);
      add(start, accept, null, made);
      add(e.accept, e.start, null, made);
      add(e.accept, accept, null, made);
      // 上下各留半行，给回边和跳过的边绕行。
      const pos = new Map<number, [number, number]>([[start, [0, e.mid + 0.5]], [accept, [e.w + 2, e.mid + 0.5]]]);
      shift(e.pos, 1, 0.5, pos);
      result = { start, accept, order: [start, ...e.order, accept], w: e.w + 2, h: e.h + 1, mid: e.mid + 0.5, pos };
    }
    steps.push({ re, text: fmtRe(re), states: fresh2, edges: made, fragment: { start: result.start, accept: result.accept }, merged, rule });
    return result;
  };

  const trees = rules.map((rule) => parseRegex(rule.re));
  const built = trees.map((tree, index) => build(tree, index));
  let start: number;
  let order: number[];
  const grid = new Map<number, [number, number]>();
  let cols: number;
  let rows: number;
  if (built.length === 1) {
    start = built[0].start;
    order = built[0].order;
    shift(built[0].pos, 0, 0, grid);
    cols = built[0].w + 1;
    rows = built[0].h;
  } else {
    // 多条规则：新开始状态用空转移连到每条规则，接受状态各自保留，记住属于哪种记号。
    start = fresh();
    const made: NfaEdge[] = [];
    built.forEach((item) => add(start, item.start, null, made));
    rows = built.reduce((sum, item) => sum + item.h, 0);
    let top = 0;
    built.forEach((item) => {
      shift(item.pos, 1, top, grid);
      top += item.h;
    });
    grid.set(start, [0, rows / 2]);
    cols = Math.max(...built.map((item) => item.w)) + 2;
    order = [start, ...built.flatMap((item) => item.order)];
    steps.push({ re: { k: 'sym', s: '' }, text: rules.map((rule) => rule.re).join(' | '), states: [start], edges: made, fragment: { start, accept: -1 }, merged: null, rule: -1 });
  }

  // 重新编号。
  const renumber = new Map(order.map((old, index) => [old, index]));
  const map = (state: number) => renumber.get(state)!;
  const finalEdges = edges.map((edge) => ({ from: map(edge.from), to: map(edge.to), sym: edge.sym }));
  const edgeIndex = new Map(edges.map((edge, index) => [edge, index]));
  const accepts = new Map<number, TokenKind>();
  built.forEach((item, index) => accepts.set(map(item.accept), rules[index].kind));
  const symbols = [...new Set(edges.flatMap((edge) => (edge.sym ? [edge.sym] : [])))];
  const finalGrid = new Map([...grid].map(([state, at]) => [map(state), at] as [number, [number, number]]));
  return {
    count: order.length,
    start: map(start),
    edges: finalEdges,
    accepts,
    symbols,
    steps: steps.map((step) => ({
      ...step,
      states: step.states.map(map),
      edges: step.edges.map((edge) => finalEdges[edgeIndex.get(edge)!]),
      fragment: { start: map(step.fragment.start), accept: step.fragment.accept < 0 ? -1 : map(step.fragment.accept) },
      merged: step.merged ? { into: map(step.merged.into) } : null,
    })),
    fragments: built.map((item) => ({ start: map(item.start), accept: map(item.accept) })),
    trees,
    grid: finalGrid,
    rows,
    cols,
  };
}

/** 只走空转移能到达的全部状态。 */
export function closure(nfa: Nfa, states: Iterable<number>): number[] {
  const seen = new Set(states);
  const stack = [...seen];
  while (stack.length) {
    const state = stack.pop()!;
    for (const edge of nfa.edges) {
      if (edge.from === state && edge.sym === null && !seen.has(edge.to)) {
        seen.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function move(nfa: Nfa, states: number[], sym: string): number[] {
  const out = new Set<number>();
  for (const edge of nfa.edges) if (edge.sym === sym && states.includes(edge.from)) out.add(edge.to);
  return [...out].sort((a, b) => a - b);
}

export interface DfaState {
  name: string;
  set: number[];
  /** 接受时产出的记号种类，按规则顺序取第一个。 */
  accept: TokenKind | null;
  /** 接受状态里的 NFA 状态，对单条规则就是它的接受状态。 */
  acceptBy: number | null;
}

export interface SubsetStep {
  from: string;
  sym: string;
  move: number[];
  closure: number[];
  /** 空集表示没有转移。 */
  to: string | null;
  fresh: boolean;
}

export interface Dfa {
  states: DfaState[];
  start: string;
  trans: Map<string, Map<string, string>>;
  symbols: string[];
  steps: SubsetStep[];
}

const NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 子集构造：每个 DFA 状态是一组 NFA 状态。按发现顺序编号 A、B、C。 */
export function subset(nfa: Nfa, rules: Rule[] = []): Dfa {
  const rank = (kind: TokenKind) => rules.findIndex((rule) => rule.kind === kind);
  const make = (set: number[], index: number): DfaState => {
    const accepting = set.filter((state) => nfa.accepts.has(state)).sort((a, b) => rank(nfa.accepts.get(a)!) - rank(nfa.accepts.get(b)!));
    return { name: NAMES[index], set, accept: accepting.length ? nfa.accepts.get(accepting[0])! : null, acceptBy: accepting[0] ?? null };
  };
  const states = [make(closure(nfa, [nfa.start]), 0)];
  const trans = new Map<string, Map<string, string>>();
  const steps: SubsetStep[] = [];
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const row = new Map<string, string>();
    trans.set(state.name, row);
    for (const sym of nfa.symbols) {
      const moved = move(nfa, state.set, sym);
      if (!moved.length) {
        steps.push({ from: state.name, sym, move: [], closure: [], to: null, fresh: false });
        continue;
      }
      const set = closure(nfa, moved);
      let target = states.find((item) => item.set.join() === set.join());
      const isNew = !target;
      if (!target) {
        target = make(set, states.length);
        states.push(target);
      }
      row.set(sym, target.name);
      steps.push({ from: state.name, sym, move: moved, closure: set, to: target.name, fresh: isNew });
    }
  }
  return { states, start: states[0].name, trans, symbols: nfa.symbols, steps };
}

export interface MinRound {
  /** 这一轮开始时的划分。 */
  groups: string[][];
  /** 每个状态的签名：每个符号到第几组，-1 是没有转移。 */
  signatures: Map<string, number[]>;
  split: boolean;
}

export interface MinDfa {
  groups: string[][];
  start: number;
  trans: Map<number, Map<string, number>>;
  accept: Array<TokenKind | null>;
  rounds: MinRound[];
}

/**
 * 最小化：先按“接受什么记号”分组，再反复按转移去向细分，直到不再变化（Moore 的划分细化）。
 * 没有转移就是停机，不补死状态，所以签名里用 -1 表示。
 */
export function minimize(dfa: Dfa): MinDfa {
  const keyOf = (state: DfaState) => state.accept ?? '';
  const initial = new Map<string, string[]>();
  for (const state of dfa.states) initial.set(keyOf(state), [...(initial.get(keyOf(state)) ?? []), state.name]);
  let groups = [...initial.values()];
  const rounds: MinRound[] = [];
  for (;;) {
    const groupOf = new Map(groups.flatMap((group, index) => group.map((name) => [name, index] as [string, number])));
    const signatures = new Map(dfa.states.map((state) => [state.name, dfa.symbols.map((sym) => {
      const to = dfa.trans.get(state.name)!.get(sym);
      return to ? groupOf.get(to)! : -1;
    })]));
    const next: string[][] = [];
    for (const group of groups) {
      const bySig = new Map<string, string[]>();
      for (const name of group) {
        const key = signatures.get(name)!.join();
        bySig.set(key, [...(bySig.get(key) ?? []), name]);
      }
      next.push(...bySig.values());
    }
    const split = next.length !== groups.length;
    rounds.push({ groups, signatures, split });
    if (!split) break;
    groups = next;
  }
  const groupOf = new Map(groups.flatMap((group, index) => group.map((name) => [name, index] as [string, number])));
  const trans = new Map<number, Map<string, number>>();
  groups.forEach((group, index) => {
    const row = new Map<string, number>();
    for (const [sym, to] of dfa.trans.get(group[0])!) row.set(sym, groupOf.get(to)!);
    trans.set(index, row);
  });
  const accept = groups.map((group) => dfa.states.find((state) => state.name === group[0])!.accept);
  return { groups, start: groupOf.get(dfa.start)!, trans, accept, rounds };
}

/** 按最长匹配用 DFA 跑一段输入，返回停下的位置和接受的种类。 */
export function runDfa(dfa: MinDfa, input: string[]): { length: number; kind: TokenKind | null; path: number[] } {
  let state = dfa.start;
  const path = [state];
  let best = { length: 0, kind: dfa.accept[state] };
  for (let index = 0; index < input.length; index++) {
    const to = dfa.trans.get(state)!.get(input[index]);
    if (to === undefined) break;
    state = to;
    path.push(state);
    if (dfa.accept[state]) best = { length: index + 1, kind: dfa.accept[state] };
  }
  return { ...best, path };
}

/** 词法器里标识符和数字的两条规则。 */
export const TOKEN_RULES: Rule[] = [
  { kind: 'identifier', re: 'L(L|D)*' },
  { kind: 'numeric_constant', re: 'DD*' },
];

/**
 * 把最小化的 DFA 和词法器手写的转移表对齐：从开始状态出发，沿同一个字符类走，
 * 两边要么都有转移、要么都没有，接受的记号种类也要一致。对得上就返回状态的对应关系。
 */
export function matchLexer(min: MinDfa, table: Record<string, Partial<Record<CharClass, string>>>, kinds: Record<string, TokenKind>, start = 'START'): Map<number, string> | null {
  const mapping = new Map<number, string>([[min.start, start]]);
  const queue = [min.start];
  while (queue.length) {
    const state = queue.shift()!;
    const lexState = mapping.get(state)!;
    if ((kinds[lexState] ?? null) !== min.accept[state]) return null;
    for (const [sym, cls] of Object.entries(SYMBOL_CLASS)) {
      const ours = min.trans.get(state)!.get(sym);
      const theirs = table[lexState][cls];
      if ((ours === undefined) !== (theirs === undefined)) return null;
      if (ours === undefined || theirs === undefined) continue;
      if (mapping.has(ours)) {
        if (mapping.get(ours) !== theirs) return null;
        continue;
      }
      if ([...mapping.values()].includes(theirs)) return null;
      mapping.set(ours, theirs);
      queue.push(ours);
    }
  }
  return mapping.size === min.groups.length ? mapping : null;
}

/** 字符类对应规则里的哪个符号，不在字母表里时是 null。 */
export const symbolOf = (cls: CharClass): string | null => Object.entries(SYMBOL_CLASS).find(([, value]) => value === cls)?.[0] ?? null;
