/** 编译器各阶段的独立向量：期望值来自 clang、bison、llvm-objdump 或手工推导，不用被测代码算。 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, LEXED, LINKED, LIVE, LR_RUN, LR_TABLE, MAIN, PARSED, SCALE_OBJ, SEMA, BAD_SEMA, SUM, TIGHT_ALLOC, TIGHT_POOL } from '../src/compiler';
import { dominance, liveness } from '../src/compiler/dataflow';
import { parseObject } from '../src/compiler/elf';
import { interpret } from '../src/compiler/interp';
import { fmtBody, type IrFunc } from '../src/compiler/ir';
import { lex, LexError } from '../src/compiler/lexer';
import { link } from '../src/compiler/link';
import { buildSlr, END, EXPR_GRAMMAR, fmtAction, fmtItem, makeGrammar, runLr } from '../src/compiler/lr';
import { findLoops } from '../src/compiler/opt';
import { parse, ParseError, type Expr, type Stmt, type Top } from '../src/compiler/parser';
import { check } from '../src/compiler/sema';
import { SOURCE } from '../src/compiler/source';
import { encode, fmtIns, r32, r64, type Ins } from '../src/compiler/x86';
import { sequentialize, V, I } from '../src/compiler/isel';
import { ENCODER_MATRIX } from './vectors/matrix';

const vector = (name: string) => readFileSync(join(__dirname, 'vectors', name), 'utf8');
const hexOf = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) => Array.from({ length: text.length / 2 }, (_, index) => parseInt(text.slice(index * 2, index * 2 + 2), 16));

describe('词法器对照 clang -dump-tokens', () => {
  const expected = vector('clang-tokens.txt').trim().split('\n').map((line) => {
    const match = /^(\w+) '(.*?)'\s.*Loc=<[^:]+:(\d+):(\d+)>/.exec(line);
    if (!match) throw new Error(`解析不了：${line}`);
    return { kind: match[1], text: match[2], line: Number(match[3]), col: Number(match[4]) };
  });

  it('种类、原文、行列号逐个相同（eof 的位置约定不同，只比种类）', () => {
    expect(LEXED.tokens.slice(0, -1).map(({ kind, text, line, col }) => ({ kind, text, line, col }))).toEqual(expected.slice(0, -1));
    expect(LEXED.tokens.at(-1)!.kind).toBe(expected.at(-1)!.kind);
    expect(LEXED.tokens.length).toBe(expected.length);
  });

  it('最长匹配：<= 是一个记号，< = 是两个', () => {
    expect(lex('i<=n').tokens.map((token) => token.kind)).toEqual(['identifier', 'lessequal', 'identifier', 'eof']);
    expect(lex('i< =n').tokens.map((token) => token.kind)).toEqual(['identifier', 'less', 'equal', 'identifier', 'eof']);
    expect(lex('a==b=c').tokens.map((token) => token.kind)).toEqual(['identifier', 'equalequal', 'identifier', 'equal', 'identifier', 'eof']);
  });

  it('关键字只在整词匹配时才算', () => {
    expect(lex('int intx whilex while').tokens.map((token) => token.kind)).toEqual(['int', 'identifier', 'identifier', 'while', 'eof']);
  });

  it('单独的 ! 和未知字符报错，并给出位置', () => {
    expect(() => lex('a ! b')).toThrow(LexError);
    expect(() => lex('\n  @')).toThrowError(/^2:3:/);
  });
});

/** 把我们的 AST 打印成和 clang -ast-dump 同样的前序节点表，去掉 clang 才有的隐式节点。 */
function astLines(tops: Top[]): string[] {
  const out: string[] = [];
  const expr = (e: Expr, depth: number) => {
    const pad = ' '.repeat(depth);
    switch (e.k) {
      case 'num': out.push(`${pad}IntegerLiteral ${e.value}`); break;
      case 'var': out.push(`${pad}DeclRefExpr ${e.name}`); break;
      case 'bin': out.push(`${pad}BinaryOperator ${e.op}`); expr(e.l, depth + 1); expr(e.r, depth + 1); break;
      case 'assign': out.push(`${pad}BinaryOperator =`); expr(e.target, depth + 1); expr(e.value, depth + 1); break;
      case 'neg': out.push(`${pad}UnaryOperator -`); expr(e.e, depth + 1); break;
      case 'call': out.push(`${pad}CallExpr`); out.push(`${pad} DeclRefExpr ${e.fn}`); e.args.forEach((arg) => expr(arg, depth + 1)); break;
    }
  };
  const stmt = (s: Stmt, depth: number) => {
    const pad = ' '.repeat(depth);
    switch (s.k) {
      case 'decl': out.push(`${pad}VarDecl ${s.name}`); if (s.init) expr(s.init, depth + 1); break;
      case 'expr': expr(s.e, depth); break;
      case 'while': out.push(`${pad}WhileStmt`); expr(s.cond, depth + 1); stmt(s.body, depth + 1); break;
      case 'if': out.push(`${pad}IfStmt`); expr(s.cond, depth + 1); stmt(s.then, depth + 1); if (s.else) stmt(s.else, depth + 1); break;
      case 'return': out.push(`${pad}ReturnStmt`); expr(s.value, depth + 1); break;
      case 'block': out.push(`${pad}CompoundStmt`); s.stmts.forEach((item) => stmt(item, depth + 1)); break;
    }
  };
  for (const top of tops) {
    if (top.k === 'global') out.push(`VarDecl ${top.name}`);
    else {
      out.push(`FunctionDecl ${top.name}`);
      top.params.forEach((param) => out.push(` ParmVarDecl ${param.name}`));
      if (top.body) stmt(top.body, 1);
    }
  }
  return out;
}

/** 读 clang -ast-dump 的文本：按缩进算深度，跳过 DeclStmt 和隐式转换后重算。 */
function clangAstLines(): string[] {
  const out: string[] = [];
  const skipped: Array<{ depth: number }> = [];
  const lines = vector('clang-ast.txt').split('\n');
  const start = lines.findIndex((line) => /VarDecl .* total /.test(line));
  for (const raw of lines.slice(start)) {
    const match = /^([ |`-]*)(\w+)\s*(.*)$/.exec(raw);
    if (!match || !raw.trim()) continue;
    const [, prefix, kind, rest] = match;
    const depth = prefix.length / 2;
    while (skipped.length && skipped[skipped.length - 1].depth >= depth) skipped.pop();
    if (kind === 'DeclStmt' || kind === 'ImplicitCastExpr' || kind === 'ParenExpr') {
      skipped.push({ depth });
      continue;
    }
    const level = depth - skipped.length - 1;
    const pad = ' '.repeat(level);
    if (kind === 'VarDecl' || kind === 'FunctionDecl' || kind === 'ParmVarDecl') {
      const name = /\b(?:used )?([A-Za-z_]\w*) '(?:int)/.exec(rest)![1];
      out.push(`${pad}${kind} ${name}`);
    } else if (kind === 'IntegerLiteral') out.push(`${pad}${kind} ${rest.split(' ').pop()}`);
    else if (kind === 'DeclRefExpr') out.push(`${pad}${kind} ${/(?:Var|ParmVar|Function) '(\w+)'/.exec(rest)![1]}`);
    else if (kind === 'BinaryOperator') out.push(`${pad}${kind} ${/'([^']+)'$/.exec(rest)![1]}`);
    else out.push(`${pad}${kind}`);
  }
  return out;
}

describe('语法分析对照 clang -ast-dump', () => {
  it('语法树结构逐节点相同', () => {
    expect(astLines(PARSED.program.tops)).toEqual(clangAstLines());
  });

  it('优先级和左结合：s + m * n + i 的形状', () => {
    const fn = PARSED.program.tops[2] as Extract<Top, { k: 'func' }>;
    const loop = fn.body!.stmts.find((stmt) => stmt.k === 'while') as Extract<Stmt, { k: 'while' }>;
    const assign = ((loop.body as Extract<Stmt, { k: 'block' }>).stmts[0] as Extract<Stmt, { k: 'expr' }>).e as Extract<Expr, { k: 'assign' }>;
    const show = (e: Expr): string => (e.k === 'bin' ? `(${show(e.l)}${e.op}${show(e.r)})` : e.k === 'var' ? e.name : String((e as { value: number }).value));
    expect(show(assign.value)).toBe('((s+(m*n))+i)');
  });

  it('语法错误指到正确的位置', () => {
    const source = SOURCE.replace('i = i + 1;', 'i = i + 1');
    try {
      parse(source);
      throw new Error('应该报错');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).token.text).toBe('}');
      expect((error as ParseError).token.line).toBe(13);
    }
  });
});

describe('LR 表生成', () => {
  // 龙书第 4.6 节的表达式文法：12 个状态，ACTION/GOTO 表和移进归约序列都有标准答案。
  const dragon = makeGrammar('E', [
    ['E', ['E', '+', 'T']], ['E', ['T']], ['T', ['T', '*', 'F']], ['T', ['F']], ['F', ['(', 'E', ')']], ['F', ['id']],
  ]);
  const table = buildSlr(dragon);

  it('龙书文法：12 个状态，无冲突', () => {
    expect(table.sets.length).toBe(12);
    expect(table.conflicts).toEqual([]);
  });

  it('龙书文法：FOLLOW 集', () => {
    expect([...table.follow.get('E')!].sort()).toEqual(['$', ')', '+'].sort());
    expect([...table.follow.get('T')!].sort()).toEqual(['$', ')', '*', '+'].sort());
    expect([...table.follow.get('F')!].sort()).toEqual(['$', ')', '*', '+'].sort());
  });

  it('龙书文法：id * id + id 的归约序列', () => {
    const run = runLr(dragon, table, ['id', '*', 'id', '+', 'id'].map((symbol) => ({ symbol, text: symbol })));
    expect(run.accepted).toBe(true);
    const reductions = run.steps.flatMap((step) => (step.action.t === 'reduce' ? [step.action.rule] : []));
    // F→id, T→F, F→id, T→T*F, E→T, F→id, T→F, E→E+T
    expect(reductions).toEqual([6, 4, 6, 3, 2, 6, 4, 1]);
  });

  it('二义文法能查出冲突', () => {
    const ambiguous = makeGrammar('E', [['E', ['E', '+', 'E']], ['E', ['id']]]);
    expect(buildSlr(ambiguous).conflicts.length).toBeGreaterThan(0);
  });

  it('错误输入被拒绝', () => {
    const run = runLr(dragon, table, ['id', '+'].map((symbol) => ({ symbol, text: symbol })));
    expect(run.accepted).toBe(false);
  });

  /** 从 bison -v 的输出读出每个状态的核心项。bison 比我们多一个接受后的结束状态。 */
  function bisonKernels(): string[] {
    const text = vector('bison-expr.output');
    const blocks = text.split(/\nstate \d+\n/).slice(1);
    return blocks.map((block) => {
      const items = block.split('\n').map((line) => /^\s+\d+ (\S+): (.*)$/.exec(line) ?? /^\s+\d+ \s*\|?\s*(.*)$/.exec(line)).filter(Boolean);
      return items.map((match) => {
        const lhs = match![1] === '$accept' ? "S'" : match![1];
        const rhs = (match![2] ?? '').replace(/ \$end/, '').replace(/'(.)'/g, '$1').replace(/\bID\b/g, 'id').replace(/\bNUM\b/g, 'num');
        return `${lhs} → ${rhs}`.trim().replace(/\s+/g, ' ');
      }).sort().join(' ; ');
    }).filter((kernel) => kernel && !kernel.includes('$end'));
  }

  it('本站文法的状态和 bison 的 LR 自动机一一对应', () => {
    const count = Number(/^state (\d+)$/gm.exec(vector('bison-expr.output').split('\n').filter((line) => /^state \d+$/.test(line)).pop()!)![1]) + 1;
    // bison 多了 $accept: E $end . 这一个结束状态。
    expect(LR_TABLE.sets.length).toBe(count - 1);
    const ours = LR_TABLE.sets.map((set) => set.kernel.map((item) => fmtItem(EXPR_GRAMMAR, item).replace(/ · $/, ' ·').replace('·', '.')).sort().join(' ; ').replace(/\s+/g, ' ').replace(/ \. *$/, ' .'));
    const theirs = bisonKernels().map((kernel) => kernel.replace(/ \. *$/, ' .'));
    expect(new Set(ours)).toEqual(new Set(theirs.filter((kernel) => kernel !== "S' → E .")));
  });

  it('s + m * n + i 的动作序列（手工推导）', () => {
    const actions = LR_RUN.steps.map((step) => {
      if (step.action.t === 'error') return 'error';
      return step.action.t === 'reduce' ? `r${step.action.rule}` : step.action.t === 'accept' ? 'acc' : 'shift';
    });
    // 产生式编号：1 E→E+T 2 E→T 3 T→T*F 4 T→F 5 F→(E) 6 F→id 7 F→num
    expect(actions).toEqual(['shift', 'r6', 'r4', 'r2', 'shift', 'shift', 'r6', 'r4', 'shift', 'shift', 'r6', 'r3', 'r1', 'shift', 'shift', 'r6', 'r4', 'r1', 'acc']);
    expect(LR_RUN.accepted).toBe(true);
  });

  it('关键的一格：E + T 之后看到 * 要移进', () => {
    const state = LR_RUN.steps.find((step) => step.action.t === 'shift' && step.cell.symbol === '*')!.cell.state;
    expect(fmtAction(LR_TABLE.action[state].get('*'))).toMatch(/^s/);
    expect(fmtAction(LR_TABLE.action[state].get('+'))).toMatch(/^r/);
    expect(fmtAction(LR_TABLE.action[state].get(END))).toMatch(/^r/);
  });
});

describe('语义分析', () => {
  const errorsOf = (source: string) => check(parse(source).program).diagnostics.map((item) => item.message);

  it('符号表：名字、种类、类型、深度', () => {
    expect(SEMA.diagnostics).toEqual([]);
    expect(SEMA.symbols.map((sym) => `${sym.name}:${sym.kind}:${sym.type}:${sym.depth}`)).toEqual([
      'total:global:int:0', 'scale:func:int (int):0', 'sum:func:int (int):0', 'n:param:int:1', 'k:local:int:1', 'm:local:int:1', 'd:local:int:1', 's:local:int:1', 'i:local:int:1',
    ]);
  });

  it('和 clang 一样在第 15 行报实参过多', () => {
    expect(vector('clang-bad.txt')).toMatch(/bad\.c:15:\d+: error: too many arguments/);
    expect(BAD_SEMA.diagnostics.length).toBe(1);
    expect(BAD_SEMA.diagnostics[0].message).toContain('传了 2 个');
    const line = SOURCE.replace('scale(s) + n', 'scale(s, n) + n').slice(0, BAD_SEMA.diagnostics[0].span.from).split('\n').length;
    expect(line).toBe(15);
  });

  it('未声明、重复声明、函数当变量、调用非函数', () => {
    expect(errorsOf('int f(int a) { return b; }')[0]).toContain('没有声明');
    expect(errorsOf('int f(int a) { int a = 1; return a; }')[0]).toContain('重复声明');
    expect(errorsOf('int g(int a); int f(int a) { return g + a; }')[0]).toContain('不能当作 int');
    expect(errorsOf('int f(int a) { return a(1); }')[0]).toContain('不是函数');
  });

  it('内层作用域遮蔽外层', () => {
    const result = check(parse('int x; int f(int a) { { int x = 1; a = x; } return x; }').program);
    expect(result.diagnostics).toEqual([]);
    const refs = [...result.uses.values()].filter((sym) => sym.name === 'x').map((sym) => sym.kind);
    expect(refs).toEqual(['local', 'global']);
  });
});

/** 从 clang 的 .ll 取函数体，去掉我们不生成的属性和元数据。 */
function clangBody(text: string, from = 0): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line, index) => index >= from && line.startsWith('define'));
  const end = lines.findIndex((line, index) => index > start && line === '}');
  return lines.slice(start + 1, end).map((line) => line.replace(/\s+; preds =.*$/, '').replace(/, !llvm\.loop !\d+/, '').replace(/, !tbaa !\d+/, '').replace(/ #\d+$/, ''));
}

describe('IR 生成对照 clang -O0', () => {
  it('sum 的函数体逐行相同', () => {
    expect(fmtBody(SUM.o0)).toEqual(clangBody(vector('clang-o0.ll')));
  });

  const programs = JSON.parse(vector('programs-o0.json')) as Record<string, string>;
  for (const [name, ir] of Object.entries(programs)) {
    it(`${name}.c 的函数体逐行相同`, () => {
      const source = readFileSync(join(__dirname, 'vectors', 'programs', `${name}.c`), 'utf8');
      expect(fmtBody(compile(source).funcs[0].o0)).toEqual(clangBody(ir));
    });
  }
});

describe('活跃分析', () => {
  it('虎书第 10 章的例子（手工结果）', () => {
    // 1: a=0; 2: b=a+1; 3: c=c+b; 4: a=b*2; 5: if a<N goto 2; 6: return c
    const result = liveness([
      { name: '1', use: [], def: ['a'], succ: ['2'] },
      { name: '2', use: ['a'], def: ['b'], succ: ['3'] },
      { name: '3', use: ['c', 'b'], def: ['c'], succ: ['4'] },
      { name: '4', use: ['b'], def: ['a'], succ: ['5'] },
      { name: '5', use: ['a'], def: [], succ: ['2', '6'] },
      { name: '6', use: ['c'], def: [], succ: [] },
    ]);
    const table = Object.fromEntries(result.rows.map((row) => [row.name, [row.in.join(''), row.out.join('')]]));
    expect(table).toEqual({ 1: ['c', 'ac'], 2: ['ac', 'bc'], 3: ['bc', 'bc'], 4: ['bc', 'ac'], 5: ['ac', 'ac'], 6: ['c', ''] });
  });

  it('sum 的结果（手工推导）', () => {
    const table = Object.fromEntries(LIVE.rows.map((row) => [row.name, { in: row.in.join(' '), out: row.out.join(' ') }]));
    expect(table).toEqual({
      entry: { in: '', out: 'i m n s' },
      'while.cond': { in: 'i m n s', out: 'i m n s' },
      'while.body': { in: 'i m n s', out: 'i m n s' },
      'while.end': { in: 'n s', out: '' },
    });
  });
});

describe('支配关系和 SSA', () => {
  const dom = dominance(SUM.ssa.fn);

  it('直接支配者和支配边界（手工推导）', () => {
    expect(dom.idom.get('entry')).toBe(null);
    expect(dom.idom.get('while.cond')).toBe('entry');
    expect(dom.idom.get('while.body')).toBe('while.cond');
    expect(dom.idom.get('while.end')).toBe('while.cond');
    expect(dom.frontier.get('while.body')).toEqual(['while.cond']);
    expect(dom.frontier.get('while.cond')).toEqual(['while.cond']);
    expect(dom.frontier.get('entry')).toEqual([]);
  });

  const sroa = vector('clang-sroa.ll');
  it('SSA 结果和 clang 第一次 SROA 的输出逐行相同', () => {
    expect(fmtBody(SUM.ssa.fn)).toEqual(clangBody(sroa));
  });

  it('优化结果和 clang 第二次 SROA 的输出相同（只差 clang 多推导的 nuw）', () => {
    const second = sroa.split('\n').findIndex((line, index) => index > 3 && line.startsWith('; *** IR Dump After SROAPass'));
    const body = clangBody(sroa, second).map((line) => line.replace('nuw nsw', 'nsw'));
    expect(fmtBody(SUM.dce.fn)).toEqual(body);
  });
});

describe('优化和循环', () => {
  it('常量：%mul = 6，%add = 7，其余不是常量', () => {
    const constants = [...SUM.sccp.values].filter(([, value]) => typeof value === 'number');
    expect(constants).toEqual([['mul', 6], ['add', 7]]);
  });

  it('循环：回边、循环块、前置块', () => {
    expect(findLoops(SUM.dce.fn)).toEqual([{ header: 'while.cond', latch: 'while.body', blocks: ['while.cond', 'while.body'] }]);
    expect(SUM.licm.loops[0].preheader).toBe('entry');
    expect(SUM.licm.createdPreheader).toBe(false);
    expect(SUM.licm.hoisted).toEqual(['mul1']);
  });

  it('clang 也把这条乘法提到了循环外的前置块', () => {
    const text = vector('clang-licm.ll');
    const preheaderDump = text.slice(text.indexOf('; Preheader:\nwhile.body.lr.ph'));
    expect(preheaderDump.split('; Loop:')[0]).toContain('%mul1 = mul nsw i32 %n, 6');
  });

  it('clang -O1 最后把循环整个算成了闭式解', () => {
    expect(vector('clang-o1.ll')).not.toContain('while.body:');
  });

  it('条件恒定时分支被折叠，走不到的块被删掉', () => {
    const result = compile('int f(int a) { int x = 1; if (x) { a = a + 1; } else { a = a + 2; } return a; }').funcs[0];
    expect(result.dce.fn.blocks.map((block) => block.name)).not.toContain('if.else');
    expect(fmtBody(result.dce.fn).join('\n')).not.toContain('add nsw i32 %a, 2');
  });

  it('nsw 溢出不折叠', () => {
    const result = compile('int f(int a) { int x = 2147483647; int y = x + 1; return y + a; }').funcs[0];
    expect(fmtBody(result.dce.fn).join('\n')).toContain('2147483647, 1');
  });

  it('外提不改变结果，乘法从 100 次变成 1 次', () => {
    const sumRef = (n: number) => {
      let s = 0;
      for (let i = 0; i < n; i++) s = s + 6 * n + i;
      return s;
    };
    const run = (fn: IrFunc, n: number) => interpret(fn, [n], MAIN.module, { scale: (value) => value * 2 });
    for (const n of [-3, 0, 1, 2, 7, 100]) {
      const expected = sumRef(n) * 2 + n;
      for (const fn of [SUM.o0, SUM.ssa.fn, SUM.sccp.fn, SUM.dce.fn, SUM.licm.fn]) expect(run(fn, n).value).toBe(expected);
    }
    expect(run(SUM.dce.fn, 100).counts.get('mul1')).toBe(100);
    expect(run(SUM.licm.fn, 100).counts.get('mul1')).toBe(1);
  });
});

describe('寄存器分配', () => {
  const { analysis, allocation, lowered } = SUM.back;

  it('重叠的区间不共用寄存器', () => {
    const list = analysis.intervals.filter((item) => allocation.assign.has(item.v));
    for (const a of list) {
      for (const b of list) {
        if (a.v >= b.v) continue;
        if (a.start <= b.end && b.start <= a.end) expect(allocation.assign.get(a.v), `${a.v} 和 ${b.v}`).not.toBe(allocation.assign.get(b.v));
      }
    }
  });

  it('跨 call 的值只放被调用者保存寄存器', () => {
    const crossing = analysis.intervals.filter((item) => item.crossesCall).map((item) => item.v);
    expect(crossing).toEqual(['n']);
    expect(allocation.assign.get('n')).toBe(3);
    expect(lowered.frame.callee).toEqual([3]);
  });

  it('分配结果（手工核对）', () => {
    const names = ['eax', 'ecx', 'edx', 'ebx', '', '', 'esi', 'edi', 'r8d'];
    expect(Object.fromEntries([...allocation.assign].map(([key, reg]) => [key, names[reg]]))).toEqual({
      n: 'ebx', mul1: 'ecx', 's.0': 'edi', 'i.0': 'edx', add2: 'esi', add3: 'esi', add4: 'r8d', call: 'eax', add5: 'eax',
    });
    expect(allocation.spilled).toEqual([]);
  });

  it('寄存器不够时踢结束最晚的', () => {
    expect(TIGHT_POOL.length).toBe(4);
    expect(TIGHT_ALLOC.spilled).toEqual(['n', 's.0']);
  });

  it('并行复制：交换用临时寄存器打破环', () => {
    let next = 0;
    const out = sequentialize([{ d: 'a', s: V('b') }, { d: 'b', s: V('a') }], () => `t${next++}`);
    const state: Record<string, string> = { a: 'A', b: 'B' };
    for (const copy of out) state[copy.d] = copy.s.k === 'v' ? state[copy.s.name] : '';
    expect([state.a, state.b]).toEqual(['B', 'A']);
    expect(sequentialize([{ d: 'a', s: I(1) }, { d: 'b', s: V('a') }], () => 't').map((copy) => copy.d)).toEqual(['b', 'a']);
  });

  it('call 之前 rsp 对齐到 16', () => {
    const { lowered: fn } = SUM.back;
    let rsp = 8;
    for (const line of fn.lines) {
      if (line.ins.m === 'push') rsp += 8;
      if (line.ins.m === 'sub') rsp += ('imm' in line.ins.s ? line.ins.s.imm : 0);
      if (line.ins.m === 'call') expect(rsp % 16).toBe(0);
    }
  });
});

describe('栈帧的说法对照 clang', () => {
  const o0 = vector('clang-o0.s');

  it('-O0：6 个 4 字节变量，帧 32 字节，n 在 rbp-4', () => {
    expect(o0).toMatch(/sub\s+rsp, 32/);
    expect(o0).toMatch(/mov\s+dword ptr \[rbp - 4\], edi/);
    expect(o0).toMatch(/mov\s+dword ptr \[rbp - 24\], 0/);
    expect(o0).not.toMatch(/push\s+rbx/);
    const slots = SUM.o0.blocks[0].insts.filter((inst) => inst.op === 'alloca').map((inst) => (inst as { dst: string }).dst);
    expect(slots).toEqual(['n.addr', 'k', 'm', 'd', 's', 'i']);
  });

  it('-O2 省掉了帧指针，但同样用 ebx 保存 n', () => {
    const o2 = vector('clang-o2.s');
    const body = o2.slice(o2.indexOf('sum:'));
    expect(body).not.toMatch(/push\s+rbp/);
    expect(body).toMatch(/push\s+rbx/);
    expect(body).toMatch(/mov\s+ebx, edi/);
    expect(body).toMatch(/add\s+eax, ebx/);
  });

  it('sum(5) = 325，total = 160，和真实运行一致', () => {
    const runs = JSON.parse(vector('runs.json')) as Record<string, Record<string, string>>;
    expect(runs.sum.reference).toContain('5 325 160');
  });
});

describe('x86-64 编码器对照 clang', () => {
  const answers = JSON.parse(vector('clang-encoder.json')) as Array<{ text: string; hex: string }>;

  it(`${ENCODER_MATRIX.length} 条指令的字节全部相同`, () => {
    expect(answers.length).toBe(ENCODER_MATRIX.length);
    const wrong = ENCODER_MATRIX.flatMap((ins, index) => {
      const got = hexOf(encode(ins).bytes);
      const text = fmtIns(ins);
      return text === answers[index].text && got === answers[index].hex ? [] : [`${text}: ${got} / clang ${answers[index].hex}`];
    });
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('Intel SDM 的手工例子', () => {
    const cases: Array<[Ins, string]> = [
      [{ m: 'ret' }, 'c3'],
      [{ m: 'push', r: r64(5) }, '55'],
      [{ m: 'push', r: r64(12) }, '4154'],
      [{ m: 'mov', d: r64(5), s: r64(4) }, '4889e5'],
      [{ m: 'mov', d: r32(3), s: r32(7) }, '89fb'],
      [{ m: 'lea', d: r32(6), s: { base: 7, index: 1 } }, '8d340f'],
      [{ m: 'imul', d: r32(1), s: r32(3), imm: 6 }, '6bcb06'],
      [{ m: 'sub', d: r64(4), s: { imm: 8 } }, '4883ec08'],
      [{ m: 'mov', d: { base: 5, disp: -4 }, s: r32(7) }, '897dfc'],
      [{ m: 'mov', d: { base: 4 }, s: r32(0) }, '890424'],
      [{ m: 'mov', d: { base: 13 }, s: r32(0) }, '41894500'],
    ];
    for (const [ins, expected] of cases) expect(hexOf(encode(ins).bytes), fmtIns(ins)).toBe(expected);
  });

  it('放宽：超过 127 字节的跳转用 rel32', () => {
    const body = Array.from({ length: 80 }, (_, index) => `t = t + ${index * 1000 + 1000};`).join('\n');
    const result = compile(`int f(int a) { int t = 0; while (t < a) { ${body} } return t; }`).assembled[0];
    const jumps = result.lines.filter((line) => line.ins.m === 'jmp' || line.ins.m === 'jcc');
    expect(jumps.every((line) => line.enc.relSize === 4)).toBe(true);
    expect(result.relaxRounds).toBeGreaterThan(1);
  });
});

describe('目标文件对照 clang', () => {
  const assembled = JSON.parse(vector('clang-assembled.json')) as { asm: string; object: string; scaleAsm: string; scaleObject: string };

  it('向量不过期：汇编文本和生成向量时相同', () => {
    expect(MAIN.asm).toBe(assembled.asm);
    expect(SCALE_OBJ.asm).toBe(assembled.scaleAsm);
  });

  it('sum.o 和 clang 汇编出的文件逐字节相同', () => {
    expect(hexOf(MAIN.object.bytes)).toBe(assembled.object);
  });

  it('scale.o 也逐字节相同（没有 .bss 和重定位的情况）', () => {
    expect(hexOf(SCALE_OBJ.object.bytes)).toBe(assembled.scaleObject);
  });

  it('解析 clang 的文件，得到的结构和我们写的一样', () => {
    const parsed = parseObject(unhex(assembled.object));
    expect(parsed.sections.map((section) => section.name)).toEqual(['', '.strtab', '.text', '.rela.text', '.bss', '.note.GNU-stack', '.symtab']);
    expect(parsed.symbols.map((sym) => sym.name)).toEqual(['', 'sum', 'total', 'scale']);
    expect(parsed.relas.map((rela) => [rela.offset, rela.symName, rela.type, rela.addend])).toEqual([[0x28, 'total', 2, -4], [0x2d, 'scale', 4, -4]]);
    expect(parsed.sections).toEqual(MAIN.object.sections);
  });

  it('llvm-objdump 读出同样的重定位', () => {
    const text = vector('objdump-sum.txt');
    expect(text).toContain('file format elf64-x86-64');
    expect(text).toMatch(/28:\s+R_X86_64_PC32\s+total-0x4/);
    expect(text).toMatch(/2d:\s+R_X86_64_PLT32\s+scale-0x4/);
  });
});

describe('链接', () => {
  it('手工计算：total 和 scale 的位移', () => {
    const [total, scale] = LINKED.patches;
    // total：S=0x402000，A=-4，P=0x401000+0x28，结果 0xfd4。
    expect([total.s, total.a, total.p, total.value]).toEqual([0x402000, -4, 0x401028, 0xfd4]);
    expect(total.after).toEqual([0xd4, 0x0f, 0, 0]);
    // scale：S=0x401040，A=-4，P=0x40102d，结果 0xf。
    expect([scale.s, scale.a, scale.p, scale.value]).toEqual([0x401040, -4, 0x40102d, 0xf]);
  });

  it('链接 clang 自己产生的目标文件，结果相同', () => {
    const assembled = JSON.parse(vector('clang-assembled.json')) as { object: string; scaleObject: string };
    const result = link([unhex(assembled.object), unhex(assembled.scaleObject)]);
    expect(result.text).toEqual(LINKED.text);
  });

  it('llvm-objdump 反汇编映像：call 到 scale，mov 到 total', () => {
    const text = vector('objdump-image.txt');
    expect(text).toMatch(/callq\s+0x401040 <scale>/);
    expect(text).toMatch(/# 0x402000 <total>/);
    expect(text).toMatch(/0000000000401040 <scale>:/);
  });

  it('未定义的符号报错', () => {
    expect(() => link([MAIN.object])).toThrow(/未定义的符号 scale/);
  });
});

describe('真实运行（Rosetta，向量由 npm run vectors 生成）', () => {
  const runs = JSON.parse(vector('runs.json')) as Record<string, Record<string, string>>;
  for (const [name, stages] of Object.entries(runs)) {
    it(`${name}：每个阶段的 IR 和最终机器码，结果都和 C 源码相同`, () => {
      expect(stages.reference.length).toBeGreaterThan(0);
      for (const stage of ['o0', 'ssa', 'sccp', 'dce', 'licm', 'machine']) expect(stages[stage], stage).toBe(stages.reference);
    });
  }

  it('sum 的参考结果和手算一致', () => {
    const lines = runs.sum.reference.trim().split('\n').map((line) => line.split(' ').map(Number));
    for (const [n, result, total] of lines) {
      let s = 0;
      for (let i = 0; i < n; i++) s = s + 6 * n + i;
      expect([result, total]).toEqual([s * 2 + n, s]);
    }
  });
});

const hasClang = (() => {
  try {
    execFileSync('clang', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasClang)('现场再跑一次 clang', () => {
  it('当前的汇编文本由 clang 汇编，字节和我们的相同', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-live-'));
    writeFileSync(join(dir, 'sum.s'), MAIN.asm);
    execFileSync('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'sum.s', '-o', 'sum.o'], { cwd: dir });
    expect(readFileSync(join(dir, 'sum.o')).toString('hex')).toBe(hexOf(MAIN.object.bytes));
  });
});
