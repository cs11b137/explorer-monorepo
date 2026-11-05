/** 表驱动的词法器：DFA 转移表是数据，不是一串 if。 */

export type TokenKind =
  | 'int' | 'while' | 'if' | 'else' | 'return'
  | 'identifier' | 'numeric_constant'
  | 'semi' | 'comma' | 'l_paren' | 'r_paren' | 'l_brace' | 'r_brace'
  | 'equal' | 'equalequal' | 'exclaimequal' | 'less' | 'lessequal' | 'greater' | 'greaterequal'
  | 'plus' | 'minus' | 'star' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  /** 从 1 开始，和 clang 的行列号一致。 */
  line: number;
  col: number;
  offset: number;
  end: number;
}

export type DfaState = 'START' | 'ID' | 'NUM' | 'WS' | 'ASSIGN' | 'EQ' | 'LT' | 'LE' | 'GT' | 'GE' | 'BANG' | 'NE' | 'PUNCT';
export type CharClass = 'letter' | 'digit' | 'space' | '=' | '<' | '>' | '!' | 'punct' | 'other';

export const DFA_STATES: DfaState[] = ['START', 'ID', 'NUM', 'WS', 'ASSIGN', 'EQ', 'LT', 'LE', 'GT', 'GE', 'BANG', 'NE', 'PUNCT'];
export const CHAR_CLASSES: CharClass[] = ['letter', 'digit', 'space', '=', '<', '>', '!', 'punct', 'other'];

export const DFA: Record<DfaState, Partial<Record<CharClass, DfaState>>> = {
  START: { letter: 'ID', digit: 'NUM', space: 'WS', '=': 'ASSIGN', '<': 'LT', '>': 'GT', '!': 'BANG', punct: 'PUNCT' },
  ID: { letter: 'ID', digit: 'ID' },
  NUM: { digit: 'NUM' },
  WS: { space: 'WS' },
  ASSIGN: { '=': 'EQ' },
  EQ: {},
  LT: { '=': 'LE' },
  LE: {},
  GT: { '=': 'GE' },
  GE: {},
  BANG: { '=': 'NE' },
  NE: {},
  PUNCT: {},
};

/** BANG 单独一个 ! 不是合法记号，所以不接受；其余非 START 状态都接受。 */
export const ACCEPTING: ReadonlySet<DfaState> = new Set(DFA_STATES.filter((state) => state !== 'START' && state !== 'BANG'));

const PUNCT: Record<string, TokenKind> = {
  ';': 'semi', ',': 'comma', '(': 'l_paren', ')': 'r_paren', '{': 'l_brace', '}': 'r_brace', '+': 'plus', '-': 'minus', '*': 'star',
};

export const KEYWORDS: Record<string, TokenKind> = { int: 'int', while: 'while', if: 'if', else: 'else', return: 'return' };

export function classOf(char: string): CharClass {
  if (/[A-Za-z_]/.test(char)) return 'letter';
  if (/[0-9]/.test(char)) return 'digit';
  if (char === ' ' || char === '\n' || char === '\t' || char === '\r') return 'space';
  if (char === '=' || char === '<' || char === '>' || char === '!') return char;
  if (char in PUNCT) return 'punct';
  return 'other';
}

export interface DfaStep {
  offset: number;
  char: string;
  cls: CharClass;
  from: DfaState;
  /** null 表示没有转移，也就是 DFA 停机。 */
  to: DfaState | null;
}

export interface LexRun {
  from: number;
  to: number;
  state: DfaState;
  steps: DfaStep[];
  /** 这段是空白时为 null。 */
  token: Token | null;
}

export class LexError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`${line}:${col}: ${message}`);
  }
}

function kindOf(state: DfaState, text: string): TokenKind {
  switch (state) {
    case 'ID': return KEYWORDS[text] ?? 'identifier';
    case 'NUM': return 'numeric_constant';
    case 'ASSIGN': return 'equal';
    case 'EQ': return 'equalequal';
    case 'LT': return 'less';
    case 'LE': return 'lessequal';
    case 'GT': return 'greater';
    case 'GE': return 'greaterequal';
    case 'NE': return 'exclaimequal';
    case 'PUNCT': return PUNCT[text];
    default: throw new Error(`状态 ${state} 不产生记号`);
  }
}

/** 每次都从 START 跑到 DFA 没有转移为止，这就是最长匹配。 */
export function lex(source: string): { tokens: Token[]; runs: LexRun[] } {
  const tokens: Token[] = [];
  const runs: LexRun[] = [];
  let offset = 0;
  let line = 1;
  let lineStart = 0;
  while (offset < source.length) {
    let state: DfaState = 'START';
    let cursor = offset;
    const steps: DfaStep[] = [];
    for (;;) {
      const char = source[cursor] ?? '';
      const cls: CharClass = char ? classOf(char) : 'other';
      const to: DfaState | null = char ? (DFA[state][cls] ?? null) : null;
      steps.push({ offset: cursor, char, cls, from: state, to });
      if (!to) break;
      state = to;
      cursor++;
    }
    if (!ACCEPTING.has(state)) throw new LexError(`无法识别的字符 ${JSON.stringify(source[offset])}`, line, offset - lineStart + 1);
    const text = source.slice(offset, cursor);
    let token: Token | null = null;
    if (state !== 'WS') {
      token = { kind: kindOf(state, text), text, line, col: offset - lineStart + 1, offset, end: cursor };
      tokens.push(token);
    }
    runs.push({ from: offset, to: cursor, state, steps, token });
    for (let index = offset; index < cursor; index++) {
      if (source[index] === '\n') {
        line++;
        lineStart = index + 1;
      }
    }
    offset = cursor;
  }
  tokens.push({ kind: 'eof', text: '', line, col: offset - lineStart + 1, offset, end: offset });
  return { tokens, runs };
}
