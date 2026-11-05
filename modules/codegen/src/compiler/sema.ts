/** 语义分析：作用域、符号表和类型检查。类型只有 int 和函数，比较结果只能作条件。 */
import type { Expr, Program, Span, Stmt } from './parser';

export type SymbolKind = 'global' | 'func' | 'param' | 'local';

export interface Sym {
  name: string;
  kind: SymbolKind;
  /** 'int' 或 'int (int, int)' 这样的函数类型。 */
  type: string;
  arity: number;
  scope: number;
  depth: number;
  span: Span;
}

export interface Diagnostic { message: string; span: Span }

export type SemaEvent =
  | { kind: 'scope-in'; scope: number; depth: number }
  | { kind: 'scope-out'; scope: number }
  | { kind: 'declare'; sym: Sym }
  | { kind: 'lookup'; name: string; sym: Sym | null; span: Span }
  | { kind: 'type'; id: number; type: string; span: Span; rule: string }
  | { kind: 'error'; diag: Diagnostic };

export interface SemaResult {
  symbols: Sym[];
  /** 变量或函数引用的节点 id → 符号。 */
  uses: Map<number, Sym>;
  types: Map<number, string>;
  diagnostics: Diagnostic[];
  events: SemaEvent[];
}

const isRelational = (e: Expr) => e.k === 'bin' && ['<', '<=', '>', '>=', '==', '!='].includes(e.op);

export function check(program: Program): SemaResult {
  const symbols: Sym[] = [];
  const uses = new Map<number, Sym>();
  const types = new Map<number, string>();
  const diagnostics: Diagnostic[] = [];
  const events: SemaEvent[] = [];
  const scopes: Array<Map<string, Sym>> = [];
  const scopeIds: number[] = [];
  let nextScope = 0;

  const error = (message: string, span: Span) => {
    const diag = { message, span };
    diagnostics.push(diag);
    events.push({ kind: 'error', diag });
  };

  function open(): void {
    const scope = nextScope++;
    scopes.push(new Map());
    scopeIds.push(scope);
    events.push({ kind: 'scope-in', scope, depth: scopes.length - 1 });
  }

  function close(): void {
    scopes.pop();
    events.push({ kind: 'scope-out', scope: scopeIds.pop()! });
  }

  function declare(name: string, kind: SymbolKind, type: string, arity: number, span: Span): Sym {
    const here = scopes[scopes.length - 1];
    const existing = here.get(name);
    // 函数可以先声明再定义，签名相同就不算重复。
    if (existing && !(existing.kind === 'func' && kind === 'func' && existing.type === type)) error(`“${name}”在同一作用域里重复声明`, span);
    if (existing && existing.kind === 'func' && kind === 'func') return existing;
    const sym: Sym = { name, kind, type, arity, scope: scopeIds[scopeIds.length - 1], depth: scopes.length - 1, span };
    here.set(name, sym);
    symbols.push(sym);
    events.push({ kind: 'declare', sym });
    return sym;
  }

  function lookup(name: string, span: Span): Sym | null {
    for (let index = scopes.length - 1; index >= 0; index--) {
      const sym = scopes[index].get(name);
      if (sym) {
        events.push({ kind: 'lookup', name, sym, span });
        return sym;
      }
    }
    events.push({ kind: 'lookup', name, sym: null, span });
    error(`使用了没有声明的“${name}”`, span);
    return null;
  }

  const setType = (e: { id: number; span: Span }, type: string, rule: string) => {
    types.set(e.id, type);
    events.push({ kind: 'type', id: e.id, type, span: e.span, rule });
    return type;
  };

  /** 要求子表达式是 int。比较结果在本子集里只能作条件。 */
  function intValue(e: Expr): void {
    if (expr(e) !== 'int') error('这里需要 int，比较结果只能写在 if 或 while 的条件里', e.span);
  }

  function expr(e: Expr): string {
    switch (e.k) {
      case 'num':
        return setType(e, 'int', '整数字面量的类型是 int');
      case 'var': {
        const sym = lookup(e.name, e.span);
        if (!sym) return setType(e, 'int', '未声明，按 int 继续检查');
        uses.set(e.id, sym);
        if (sym.kind === 'func') error(`函数“${e.name}”不能当作 int 使用`, e.span);
        return setType(e, 'int', `${e.name} 声明为 int`);
      }
      case 'neg':
        intValue(e.e);
        return setType(e, 'int', '取负的结果是 int');
      case 'bin':
        intValue(e.l);
        intValue(e.r);
        if (isRelational(e)) return setType(e, 'bool', '比较的结果只能作条件');
        return setType(e, 'int', `int ${e.op} int 得到 int`);
      case 'assign': {
        const sym = lookup(e.target.name, e.target.span);
        if (sym) {
          uses.set(e.target.id, sym);
          if (sym.kind === 'func') error(`不能给函数“${sym.name}”赋值`, e.target.span);
        }
        setType(e.target, 'int', '赋值目标必须是 int 变量');
        intValue(e.value);
        return setType(e, 'int', '赋值表达式的类型是左边的类型');
      }
      case 'call': {
        const sym = lookup(e.fn, e.span);
        if (sym) {
          uses.set(e.id, sym);
          if (sym.kind !== 'func') error(`“${e.fn}”不是函数，不能调用`, e.span);
          else if (sym.arity !== e.args.length) error(`调用 ${e.fn} 传了 ${e.args.length} 个实参，声明要 ${sym.arity} 个`, e.span);
        }
        e.args.forEach(intValue);
        return setType(e, 'int', `${e.fn} 返回 int`);
      }
    }
  }

  function condition(e: Expr): void {
    expr(e);
  }

  function stmt(s: Stmt): void {
    switch (s.k) {
      case 'decl':
        // C 的规则：声明点在初值之前，初值里可以看到变量自己。这里先声明再查初值。
        declare(s.name, 'local', 'int', 0, s.span);
        if (s.init) intValue(s.init);
        return;
      case 'expr':
        expr(s.e);
        return;
      case 'while':
        condition(s.cond);
        stmt(s.body);
        return;
      case 'if':
        condition(s.cond);
        stmt(s.then);
        if (s.else) stmt(s.else);
        return;
      case 'return':
        intValue(s.value);
        return;
      case 'block':
        open();
        s.stmts.forEach(stmt);
        close();
        return;
    }
  }

  open();
  for (const top of program.tops) {
    if (top.k === 'global') {
      declare(top.name, 'global', 'int', 0, top.span);
      continue;
    }
    const type = `int (${top.params.map(() => 'int').join(', ')})`;
    declare(top.name, 'func', type, top.params.length, top.span);
    if (!top.body) continue;
    open();
    top.params.forEach((param) => declare(param.name, 'param', 'int', 0, param.span));
    top.body.stmts.forEach(stmt);
    const last = top.body.stmts[top.body.stmts.length - 1];
    if (!last || last.k !== 'return') error(`函数“${top.name}”必须以 return 结束`, top.span);
    close();
  }
  close();
  return { symbols, uses, types, diagnostics, events };
}
