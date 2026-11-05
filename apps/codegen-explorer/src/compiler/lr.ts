/** LR(0) 项集和 SLR(1) 分析表生成器。输入任意文法，表是真算出来的。 */

export interface Production { lhs: string; rhs: string[] }
export interface Grammar { start: string; productions: Production[]; terminals: string[]; nonterminals: string[] }

export const END = '$';
export const AUG = "S'";

export function makeGrammar(start: string, rules: Array<[string, string[]]>): Grammar {
  const productions: Production[] = [{ lhs: AUG, rhs: [start] }, ...rules.map(([lhs, rhs]) => ({ lhs, rhs }))];
  const nonterminals = [...new Set(productions.slice(1).map((rule) => rule.lhs))];
  const seen = new Set<string>();
  for (const rule of productions) for (const symbol of rule.rhs) if (!nonterminals.includes(symbol)) seen.add(symbol);
  return { start, productions, nonterminals, terminals: [...seen, END] };
}

export interface Item { rule: number; dot: number }
export interface ItemSet { id: number; kernel: Item[]; items: Item[]; transitions: Map<string, number> }

const key = (items: Item[]) => items.map((item) => `${item.rule}.${item.dot}`).sort().join(',');

export function closure(grammar: Grammar, kernel: Item[]): Item[] {
  const items = [...kernel];
  for (let index = 0; index < items.length; index++) {
    const { rule, dot } = items[index];
    const symbol = grammar.productions[rule].rhs[dot];
    if (!symbol || !grammar.nonterminals.includes(symbol)) continue;
    grammar.productions.forEach((production, next) => {
      if (production.lhs === symbol && !items.some((item) => item.rule === next && item.dot === 0)) items.push({ rule: next, dot: 0 });
    });
  }
  return items;
}

export function itemSets(grammar: Grammar): ItemSet[] {
  const first: Item[] = [{ rule: 0, dot: 0 }];
  const sets: ItemSet[] = [{ id: 0, kernel: first, items: closure(grammar, first), transitions: new Map() }];
  const byKey = new Map([[key(first), 0]]);
  for (let index = 0; index < sets.length; index++) {
    const set = sets[index];
    const symbols: string[] = [];
    for (const { rule, dot } of set.items) {
      const symbol = grammar.productions[rule].rhs[dot];
      if (symbol && !symbols.includes(symbol)) symbols.push(symbol);
    }
    for (const symbol of symbols) {
      const kernel = set.items.filter(({ rule, dot }) => grammar.productions[rule].rhs[dot] === symbol).map(({ rule, dot }) => ({ rule, dot: dot + 1 }));
      const id = key(kernel);
      let target = byKey.get(id);
      if (target === undefined) {
        target = sets.length;
        byKey.set(id, target);
        sets.push({ id: target, kernel, items: closure(grammar, kernel), transitions: new Map() });
      }
      set.transitions.set(symbol, target);
    }
  }
  return sets;
}

export function firstSets(grammar: Grammar): Map<string, Set<string>> {
  const first = new Map<string, Set<string>>();
  for (const terminal of grammar.terminals) first.set(terminal, new Set([terminal]));
  for (const symbol of grammar.nonterminals) first.set(symbol, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const { lhs, rhs } of grammar.productions.slice(1)) {
      const target = first.get(lhs)!;
      const size = target.size;
      // 本文法没有空产生式，产生式右部第一个符号决定 FIRST。
      for (const symbol of first.get(rhs[0])!) target.add(symbol);
      if (target.size !== size) changed = true;
    }
  }
  return first;
}

export function followSets(grammar: Grammar): Map<string, Set<string>> {
  const first = firstSets(grammar);
  const follow = new Map<string, Set<string>>(grammar.nonterminals.map((symbol) => [symbol, new Set<string>()]));
  follow.get(grammar.start)!.add(END);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { lhs, rhs } of grammar.productions.slice(1)) {
      rhs.forEach((symbol, index) => {
        if (!grammar.nonterminals.includes(symbol)) return;
        const target = follow.get(symbol)!;
        const size = target.size;
        const next = rhs[index + 1];
        if (next) for (const value of first.get(next)!) target.add(value);
        else for (const value of follow.get(lhs)!) target.add(value);
        if (target.size !== size) changed = true;
      });
    }
  }
  return follow;
}

export type Action = { t: 'shift'; to: number } | { t: 'reduce'; rule: number } | { t: 'accept' };

export const fmtAction = (action: Action | undefined): string => {
  if (!action) return '';
  if (action.t === 'shift') return `s${action.to}`;
  if (action.t === 'reduce') return `r${action.rule}`;
  return 'acc';
};

export interface LrTable {
  sets: ItemSet[];
  action: Array<Map<string, Action>>;
  goto: Array<Map<string, number>>;
  conflicts: string[];
  follow: Map<string, Set<string>>;
}

export function buildSlr(grammar: Grammar): LrTable {
  const sets = itemSets(grammar);
  const follow = followSets(grammar);
  const conflicts: string[] = [];
  const action: LrTable['action'] = sets.map(() => new Map());
  const gotoTable: LrTable['goto'] = sets.map(() => new Map());
  const put = (state: number, symbol: string, next: Action) => {
    const existing = action[state].get(symbol);
    if (existing && fmtAction(existing) !== fmtAction(next)) conflicts.push(`状态 ${state} 遇到 ${symbol}：${fmtAction(existing)} / ${fmtAction(next)}`);
    else action[state].set(symbol, next);
  };
  for (const set of sets) {
    for (const [symbol, to] of set.transitions) {
      if (grammar.nonterminals.includes(symbol)) gotoTable[set.id].set(symbol, to);
      else put(set.id, symbol, { t: 'shift', to });
    }
    for (const { rule, dot } of set.items) {
      const production = grammar.productions[rule];
      if (dot < production.rhs.length) continue;
      if (rule === 0) put(set.id, END, { t: 'accept' });
      else for (const symbol of follow.get(production.lhs)!) put(set.id, symbol, { t: 'reduce', rule });
    }
  }
  return { sets, action, goto: gotoTable, conflicts, follow };
}

export interface LrStep {
  stack: Array<{ state: number; symbol: string }>;
  input: string[];
  action: Action | { t: 'error' };
  /** 查的是 ACTION 表哪一格。 */
  cell: { state: number; symbol: string };
  /** 归约后查 GOTO 的那一格。 */
  gotoCell: { state: number; symbol: string; to: number } | null;
  /** 归约时构造的树节点。 */
  node: LrNode | null;
  /** 这一步移进的词法单元在输入里的下标。 */
  tokenIndex: number;
}

export interface LrNode { id: number; label: string; children: LrNode[]; token?: number }

export function runLr(grammar: Grammar, table: LrTable, input: Array<{ symbol: string; text: string }>): { steps: LrStep[]; accepted: boolean; root: LrNode | null } {
  const tokens = [...input, { symbol: END, text: END }];
  const stack: Array<{ state: number; symbol: string }> = [{ state: 0, symbol: END }];
  const nodes: LrNode[] = [];
  const steps: LrStep[] = [];
  let at = 0;
  let nextId = 0;
  for (;;) {
    const state = stack[stack.length - 1].state;
    const symbol = tokens[at].symbol;
    const action = table.action[state].get(symbol);
    const snapshot = stack.map((item) => ({ ...item }));
    const rest = tokens.slice(at).map((token) => token.text);
    if (!action) {
      steps.push({ stack: snapshot, input: rest, action: { t: 'error' }, cell: { state, symbol }, gotoCell: null, node: null, tokenIndex: at });
      return { steps, accepted: false, root: null };
    }
    if (action.t === 'accept') {
      steps.push({ stack: snapshot, input: rest, action, cell: { state, symbol }, gotoCell: null, node: null, tokenIndex: at });
      return { steps, accepted: true, root: nodes[nodes.length - 1] };
    }
    if (action.t === 'shift') {
      const leaf: LrNode = { id: nextId++, label: tokens[at].text, children: [], token: at };
      nodes.push(leaf);
      steps.push({ stack: snapshot, input: rest, action, cell: { state, symbol }, gotoCell: null, node: leaf, tokenIndex: at });
      stack.push({ state: action.to, symbol });
      at++;
      continue;
    }
    const production = grammar.productions[action.rule];
    const count = production.rhs.length;
    const children = nodes.splice(nodes.length - count, count);
    stack.splice(stack.length - count, count);
    const exposed = stack[stack.length - 1].state;
    const to = table.goto[exposed].get(production.lhs)!;
    const made: LrNode = { id: nextId++, label: production.lhs, children };
    nodes.push(made);
    steps.push({ stack: snapshot, input: rest, action, cell: { state, symbol }, gotoCell: { state: exposed, symbol: production.lhs, to }, node: made, tokenIndex: at });
    stack.push({ state: to, symbol: production.lhs });
  }
}

/** 本站用的表达式文法。id 和 num 就是词法器产出的标识符和数字。 */
export const EXPR_GRAMMAR = makeGrammar('E', [
  ['E', ['E', '+', 'T']],
  ['E', ['T']],
  ['T', ['T', '*', 'F']],
  ['T', ['F']],
  ['F', ['(', 'E', ')']],
  ['F', ['id']],
  ['F', ['num']],
]);

export const fmtProduction = (production: Production) => `${production.lhs} → ${production.rhs.join(' ')}`;

export function fmtItem(grammar: Grammar, item: Item): string {
  const production = grammar.productions[item.rule];
  const rhs = [...production.rhs];
  rhs.splice(item.dot, 0, '·');
  return `${production.lhs} → ${rhs.join(' ')}`;
}
