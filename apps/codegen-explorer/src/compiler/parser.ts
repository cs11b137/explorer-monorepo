/** 递归下降解析器：一条语法规则对应一个函数，并把调用过程记录下来。 */
import { lex, type Token, type TokenKind } from './lexer';

export interface Span { from: number; to: number }

interface Base { id: number; span: Span }
export type BinOp = '+' | '-' | '*' | '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Expr =
  | (Base & { k: 'num'; value: number })
  | (Base & { k: 'var'; name: string })
  | (Base & { k: 'bin'; op: BinOp; l: Expr; r: Expr })
  | (Base & { k: 'neg'; e: Expr })
  | (Base & { k: 'assign'; target: Extract<Expr, { k: 'var' }>; value: Expr })
  | (Base & { k: 'call'; fn: string; args: Expr[] });

export type Stmt =
  | (Base & { k: 'decl'; name: string; init: Expr | null })
  | (Base & { k: 'expr'; e: Expr })
  | (Base & { k: 'while'; cond: Expr; body: Stmt })
  | (Base & { k: 'if'; cond: Expr; then: Stmt; else: Stmt | null })
  | (Base & { k: 'return'; value: Expr })
  | (Base & { k: 'block'; stmts: Stmt[] });

export interface Param { id: number; name: string; span: Span }

export type Top =
  | (Base & { k: 'global'; name: string })
  | (Base & { k: 'func'; name: string; params: Param[]; body: Extract<Stmt, { k: 'block' }> | null });

export interface Program { tops: Top[]; tokens: Token[] }

export type Rule = 'program' | 'decl' | 'block' | 'stmt' | 'assign' | 'equality' | 'relational' | 'additive' | 'term' | 'unary' | 'primary';

export type ParseEvent =
  | { kind: 'enter'; rule: Rule; tok: number }
  | { kind: 'exit'; rule: Rule; tok: number }
  | { kind: 'match'; tok: number; stack: Rule[] }
  | { kind: 'node'; id: number };

export class ParseError extends Error {
  constructor(message: string, readonly token: Token) {
    super(`${token.line}:${token.col}: ${message}`);
  }
}

export function parse(source: string): { program: Program; events: ParseEvent[] } {
  const { tokens } = lex(source);
  const events: ParseEvent[] = [];
  const stack: Rule[] = [];
  let at = 0;
  let nextId = 1;

  const peek = (ahead = 0) => tokens[Math.min(at + ahead, tokens.length - 1)];
  const check = (kind: TokenKind) => peek().kind === kind;

  function match(kind: TokenKind): Token {
    const token = peek();
    if (token.kind !== kind) throw new ParseError(`这里应该是 ${kind}，实际是 ${token.kind === 'eof' ? '文件结尾' : `“${token.text}”`}`, token);
    events.push({ kind: 'match', tok: at, stack: [...stack] });
    at++;
    return token;
  }

  function accept(kind: TokenKind): Token | null {
    return check(kind) ? match(kind) : null;
  }

  function rule<T>(name: Rule, body: () => T): T {
    stack.push(name);
    events.push({ kind: 'enter', rule: name, tok: at });
    const result = body();
    events.push({ kind: 'exit', rule: name, tok: at });
    stack.pop();
    return result;
  }

  function node<T extends object>(from: number, fields: T): T & Base {
    const id = nextId++;
    events.push({ kind: 'node', id });
    return { id, span: { from, to: tokens[at - 1].end }, ...fields };
  }

  const start = () => peek().offset;

  function program(): Program {
    return rule('program', () => {
      const tops: Top[] = [];
      while (!check('eof')) tops.push(decl());
      return { tops, tokens };
    });
  }

  function decl(): Top {
    return rule('decl', () => {
      const from = start();
      match('int');
      const name = match('identifier').text;
      if (!accept('l_paren')) {
        match('semi');
        return node(from, { k: 'global' as const, name });
      }
      const params: Param[] = [];
      if (!check('r_paren')) {
        do {
          const paramFrom = start();
          match('int');
          const paramName = match('identifier').text;
          params.push(node(paramFrom, { name: paramName }));
        } while (accept('comma'));
      }
      match('r_paren');
      if (accept('semi')) return node(from, { k: 'func' as const, name, params, body: null });
      const body = block();
      return node(from, { k: 'func' as const, name, params, body });
    });
  }

  function block(): Extract<Stmt, { k: 'block' }> {
    return rule('block', () => {
      const from = start();
      match('l_brace');
      const stmts: Stmt[] = [];
      while (!check('r_brace')) stmts.push(stmt());
      match('r_brace');
      return node(from, { k: 'block' as const, stmts });
    });
  }

  function stmt(): Stmt {
    return rule('stmt', () => {
      const from = start();
      if (check('l_brace')) return block();
      if (accept('int')) {
        const name = match('identifier').text;
        const init = accept('equal') ? assign() : null;
        match('semi');
        return node(from, { k: 'decl' as const, name, init });
      }
      if (accept('while')) {
        match('l_paren');
        const cond = assign();
        match('r_paren');
        const body = stmt();
        return node(from, { k: 'while' as const, cond, body });
      }
      if (accept('if')) {
        match('l_paren');
        const cond = assign();
        match('r_paren');
        const then = stmt();
        const otherwise = accept('else') ? stmt() : null;
        return node(from, { k: 'if' as const, cond, then, else: otherwise });
      }
      if (accept('return')) {
        const value = assign();
        match('semi');
        return node(from, { k: 'return' as const, value });
      }
      const e = assign();
      match('semi');
      return node(from, { k: 'expr' as const, e });
    });
  }

  function assign(): Expr {
    return rule('assign', () => {
      const from = start();
      const left = equality();
      if (!check('equal')) return left;
      if (left.k !== 'var') throw new ParseError('赋值号左边必须是变量', peek());
      match('equal');
      const value = assign();
      return node(from, { k: 'assign' as const, target: left, value });
    });
  }

  function binaryLevel(name: Rule, next: () => Expr, ops: Partial<Record<TokenKind, BinOp>>): Expr {
    return rule(name, () => {
      const from = start();
      let left = next();
      for (;;) {
        const op = ops[peek().kind];
        if (!op) return left;
        match(peek().kind);
        const right = next();
        left = node(from, { k: 'bin' as const, op, l: left, r: right });
      }
    });
  }

  const equality = () => binaryLevel('equality', relational, { equalequal: '==', exclaimequal: '!=' });
  const relational = () => binaryLevel('relational', additive, { less: '<', lessequal: '<=', greater: '>', greaterequal: '>=' });
  const additive = () => binaryLevel('additive', term, { plus: '+', minus: '-' });
  const term = () => binaryLevel('term', unary, { star: '*' });

  function unary(): Expr {
    return rule('unary', () => {
      const from = start();
      if (accept('minus')) {
        const e = unary();
        return node(from, { k: 'neg' as const, e });
      }
      return primary();
    });
  }

  function primary(): Expr {
    return rule('primary', () => {
      const from = start();
      if (accept('l_paren')) {
        const e = assign();
        match('r_paren');
        return e;
      }
      const number = accept('numeric_constant');
      if (number) return node(from, { k: 'num' as const, value: Number(number.text) });
      const name = match('identifier').text;
      if (!accept('l_paren')) return node(from, { k: 'var' as const, name });
      const args: Expr[] = [];
      if (!check('r_paren')) {
        do args.push(assign());
        while (accept('comma'));
      }
      match('r_paren');
      return node(from, { k: 'call' as const, fn: name, args });
    });
  }

  return { program: program(), events };
}
