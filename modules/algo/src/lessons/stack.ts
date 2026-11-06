import { cString, cStruct, intArray, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim } from '../scene/ds';
import { cellsOf, HEAP, STACK } from './common';
import { note, pk, render, state, type } from './dsl';
import type { Color, DsMark, Lesson, LessonEvent, RowPrim, Tone } from './types';

/** 定长的 int 栈。top 是下一个空位，栈顶元素是 data[top - 1]。出栈只把 top 减 1，旧值还留在数组里。 */
export class IntStack {
  data: Array<number | null>;
  top = 0;

  constructor(readonly cap: number) {
    this.data = new Array(cap).fill(null);
  }

  push(value: number): void {
    if (this.top === this.cap) throw new Error('栈满');
    this.data[this.top++] = value;
  }

  pop(): number {
    if (this.top === 0) throw new Error('栈空');
    return this.data[--this.top] as number;
  }

  peek(): number {
    if (this.top === 0) throw new Error('栈空');
    return this.data[this.top - 1] as number;
  }
}

export type Which = 'nums' | 'ops';

export interface CalcHooks {
  /** 开始处理 expr[at] 处的记号；at 等于表达式长度表示读到了结尾。 */
  token?(at: number, text: string): void;
  push?(which: Which, value: number, stack: IntStack): void;
  pop?(which: Which, value: number, stack: IntStack): void;
  /** 看运算符栈顶，决定要不要先算。 */
  peek?(top: string, incoming: string, reduce: boolean): void;
  apply?(a: number, op: string, b: number, result: number): void;
}

/** 运算符优先级。'(' 不在表里：它只等右括号。 */
export const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
const OPEN = '('.charCodeAt(0);

/** C 的整数运算：除法向 0 截断。 */
export function applyOp(a: number, op: string, b: number): number {
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return Math.trunc(a / b);
  throw new Error(`不认识的运算符 ${op}`);
}

/**
 * 双栈求中缀表达式：数字压进数字栈，运算符压进运算符栈。
 * 新运算符进栈前，先把栈顶优先级不低于它的运算符算掉；右括号把运算算到左括号为止。
 * 运算符按 ASCII 码存成 int。pushes、pops、peeks 分别统计入栈、出栈、看栈顶的次数。
 */
export function evaluate(expr: string, cap = 8, hooks: CalcHooks = {}) {
  const nums = new IntStack(cap);
  const ops = new IntStack(cap);
  let pushes = 0;
  let pops = 0;
  let peeks = 0;
  let deepest = 0;
  const of = (which: Which) => (which === 'nums' ? nums : ops);
  const push = (which: Which, value: number) => {
    of(which).push(value);
    pushes++;
    deepest = Math.max(deepest, nums.top);
    hooks.push?.(which, value, of(which));
  };
  const pop = (which: Which) => {
    const value = of(which).pop();
    pops++;
    hooks.pop?.(which, value, of(which));
    return value;
  };
  const peek = () => {
    peeks++;
    return String.fromCharCode(ops.peek());
  };
  const reduce = () => {
    const b = pop('nums');
    const a = pop('nums');
    const op = String.fromCharCode(pop('ops'));
    const result = applyOp(a, op, b);
    hooks.apply?.(a, op, b, result);
    push('nums', result);
  };
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ') {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const at = i;
      let value = 0;
      while (i < expr.length && expr[i] >= '0' && expr[i] <= '9') value = value * 10 + (expr.charCodeAt(i++) - 48);
      hooks.token?.(at, expr.slice(at, i));
      push('nums', value);
      continue;
    }
    hooks.token?.(i, c);
    if (c === '(') push('ops', OPEN);
    else if (c === ')') {
      for (;;) {
        const top = peek();
        const go = top !== '(';
        hooks.peek?.(top, c, go);
        if (!go) break;
        reduce();
      }
      pop('ops');
    } else if (c in PREC) {
      while (ops.top > 0) {
        const top = peek();
        const go = top !== '(' && PREC[top] >= PREC[c];
        hooks.peek?.(top, c, go);
        if (!go) break;
        reduce();
      }
      push('ops', c.charCodeAt(0));
    } else throw new Error(`不认识的字符 ${c}`);
    i++;
  }
  hooks.token?.(expr.length, '');
  while (ops.top > 0) reduce();
  const value = pop('nums');
  return { value, pushes, pops, peeks, deepest };
}

export const EXPR = '2*(3+4)-6/2';
export const CAP = 6;
const STACK_T: CField[] = [['data', 'ptr'], ['top', 'int'], ['cap', 'int']];
const STACK_LAYOUT = layoutOf(STACK_T);
const NUMS_DATA = HEAP;
const OPS_DATA = HEAP + 0x20n;
const NUMS_AT = STACK;
const OPS_AT = STACK + BigInt(STACK_LAYOUT.size);
const W = 46;
const TW = 36;
const OPEN_AT = EXPR.indexOf('(');
const CLOSE_AT = EXPR.indexOf(')');
const chr = (code: number) => String.fromCharCode(code);

/** 一次运算：两个操作数、运算符、结果，以及触发它的记号。文案从这里取值。 */
export interface ApplyLog {
  a: number;
  op: string;
  b: number;
  result: number;
  by: string;
}

/** 先不带钩子跑一遍，拿到出栈总数：最后一次出栈取的是结果，不是操作数。 */
const plain = evaluate(EXPR, CAP);

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let stepIndex = 0;
  let ops = 0;
  let pops = 0;
  let cursor = -1;
  let token = '';
  const views = { nums: new IntStack(CAP), ops: new IntStack(CAP) };
  const done = new Set<number>();
  const applied: ApplyLog[] = [];
  const peeks: Array<{ top: string; incoming: string; reduce: boolean }> = [];
  /** 每一步结束时两个栈里的内容，从栈底到栈顶。 */
  const snaps: Array<{ nums: number[]; ops: string[] }> = [];
  let operands = 0;

  const snap = () => {
    snaps[stepIndex] = { nums: views.nums.data.slice(0, views.nums.top) as number[], ops: (views.ops.data.slice(0, views.ops.top) as number[]).map(chr) };
  };
  const exprRow = (): RowPrim => {
    const tones: Record<number, Tone> = {};
    done.forEach((index) => (tones[index] = 'dim'));
    const lift: number[] = [];
    const marks: DsMark[] = [];
    if (cursor >= 0 && cursor < EXPR.length) {
      for (let index = cursor; index < cursor + token.length; index++) {
        tones[index] = 'blue';
        lift.push(index);
      }
      marks.push({ at: cursor, text: 'i', color: 'blue' });
    }
    return { kind: 'row', id: 'e', w: TW, cells: cellsOf([...EXPR], { tones, lift }), marks };
  };
  const stackRow = (which: Which, lit?: number, tone: Tone = 'blue'): RowPrim => {
    const s = views[which];
    const tones: Record<number, Tone> = {};
    s.data.forEach((value, index) => {
      if (value !== null && index >= s.top) tones[index] = 'dim';
    });
    if (lit !== undefined) tones[lit] = tone;
    const values = s.data.map((value) => (value === null ? null : which === 'ops' ? chr(value) : value));
    const marks: DsMark[] = s.top < CAP ? [{ at: s.top, text: 'top', color: 'amber' }] : [];
    return { kind: 'row', id: which === 'nums' ? 'n' : 'o', w: W, cells: cellsOf(values, { tones, lift: lit === undefined ? [] : [lit] }), marks };
  };
  const nodeOf = (which: Which) => (which === 'nums' ? 'stack' : 'aux') as 'stack' | 'aux';
  const frameOf = (which: Which, row: RowPrim) => (which === 'nums' ? { stack: [row] } : { aux: [row] });
  const textOf = (which: Which, value: number) => (which === 'ops' ? `'${chr(value)}'` : String(value));
  const bytes = (which: Which, notes: Record<number, string>, color: Color = 'blue') => {
    const s = views[which];
    const name = which === 'nums' ? '数字栈' : '运算符栈';
    return wire(`${name}，结构在 ${hex(which === 'nums' ? NUMS_AT : OPS_AT)}（E.G.）`, 'mem', 'abi',
      cStruct('struct stack', STACK_T, { data: which === 'nums' ? NUMS_DATA : OPS_DATA, top: s.top, cap: CAP }, {
        color: 'slate', summary: name, notes: { data: `指向 ${CAP} 个 int 的数组。`, top: `下一个空位，栈里现在有 ${s.top} 个元素。`, cap: '容量。top 等于它时再 push 就越界了。' },
      }),
      intArray('data', s.data, { color, notes, shown: which === 'ops' ? (value) => `'${chr(value)}'（${value}）` : undefined, summary: '栈顶是 data[top - 1]，下标 ≥ top 的值已经出栈' }));
  };

  bucket.push(pk('prog', 'text', 'slate', `s = "${EXPR}"`, [`${EXPR.length} 个字符`], [0, 'READ', '参数 s 指向表达式，两个栈的 top 都是 0', EXPR.length + 1],
    wire(`表达式，地址 ${hex(HEAP + 0x60n)}（E.G.）`, 'mem', 'abi', cString('s', EXPR, { color: 'slate', note: '逐个字符往后读，数字可以有多位。' })), { ds: { text: [exprRow()] } }));

  const result = evaluate(EXPR, CAP, {
    token(at, text) {
      if (cursor >= 0) for (let index = cursor; index < cursor + token.length; index++) done.add(index);
      cursor = at;
      token = text;
      stepIndex = at === EXPR.length ? 4 : at < OPEN_AT ? 0 : at < CLOSE_AT ? 1 : at === CLOSE_AT ? 2 : 3;
      bucket = steps[stepIndex];
      snap();
      bucket.push(state('prog', { 记号: at === EXPR.length ? '结尾' : text, 计算: null }));
      if (at === EXPR.length) {
        bucket.push(note('text', '读完了，剩下的运算符依次算掉'));
        bucket.push({ type: 'ds', frame: { text: [exprRow()] } });
      }
    },
    push(which, value, s) {
      views[which].push(value);
      ops++;
      const index = s.top - 1;
      snap();
      if (which === 'nums' && operands === 2) {
        operands = 0;
        const last = applied[applied.length - 1];
        const shown = stackRow('nums', index, 'green');
        bucket.push(pk('prog', 'stack', 'green', `push ${value}`, [`${last.a} ${last.op} ${last.b} = ${value}`], [ops, 'WRITE', `${last.a} ${last.op} ${last.b} = ${value}，结果压回数字栈：data[${index}] = ${value}，top 变成 ${s.top}`, 4],
          bytes('nums', { [index]: '运算结果，可以参加下一次运算。' }, 'green'), { quick: true, ds: { stack: [shown] }, toAt: rowAim(shown, index) }));
        return;
      }
      const color: Color = which === 'nums' ? 'blue' : 'violet';
      const shown = stackRow(which, index, color);
      const text = textOf(which, value);
      const why = which === 'nums' ? '数字直接入栈' : value === OPEN ? '左括号直接入栈，等右括号' : '运算符先压着，等右边的操作数';
      const from = exprRow();
      bucket.push(pk('text', nodeOf(which), color, `push ${text}`, [why], [ops, 'WRITE', `${why}：data[${index}] = ${text}，top 变成 ${s.top}`, 4],
        bytes(which, { [index]: which === 'ops' ? '运算符按 ASCII 码存成 int。' : '刚压入。' }, color), { quick: cursor > 0, ds: { ...frameOf(which, shown), text: [from] }, fromAt: rowAim(from, cursor), toAt: rowAim(shown, index) }));
    },
    pop(which, value, s) {
      views[which].pop();
      ops++;
      pops++;
      const index = s.top;
      snap();
      const final = pops === plain.pops;
      if (which === 'nums' && !final) operands++;
      const role = final ? '最终结果' : which === 'ops' ? (value === OPEN ? '左括号完成任务，丢掉' : '取出运算符') : operands === 1 ? '先出来的是右操作数' : '再出来的是左操作数';
      const tone: Tone = final ? 'green' : 'amber';
      const shown = stackRow(which, index, tone);
      const text = textOf(which, value);
      bucket.push(pk(nodeOf(which), 'prog', final ? 'green' : 'amber', `pop ${text}`, [role], [ops, 'READ', `${role}：top 减到 ${s.top}，读 data[${index}] = ${text}`, 4],
        bytes(which, { [index]: '已出栈。值还在内存里，下次 push 会覆盖它。' }, final ? 'green' : 'amber'), { quick: !final, ds: frameOf(which, shown), fromAt: rowAim(shown, index) }));
    },
    peek(top, incoming, reduce) {
      ops++;
      peeks.push({ top, incoming, reduce });
      const index = views.ops.top - 1;
      const color: Color = reduce ? 'teal' : 'slate';
      const shown = stackRow('ops', index, color);
      const why = incoming === ')'
        ? reduce ? `还没到左括号，先算 '${top}'` : '碰到左括号，括号里算完了'
        : top === '(' ? '栈顶是左括号，不越过它' : reduce ? `'${top}' 优先级 ${PREC[top]} ≥ '${incoming}' 的 ${PREC[incoming]}，先算` : `'${top}' 优先级 ${PREC[top]} < '${incoming}' 的 ${PREC[incoming]}，先不算`;
      bucket.push(pk('aux', 'prog', color, `栈顶 '${top}'`, [why], [ops, 'CMP', `看栈顶 data[${index}] = '${top}'：${why}`, 4],
        bytes('ops', { [index]: '栈顶，只看不取。' }, color), { quick: true, ds: { aux: [shown] }, fromAt: rowAim(shown, index) }));
    },
    apply(a, op, b, value) {
      applied.push({ a, op, b, result: value, by: cursor === EXPR.length ? '结尾' : token });
      bucket.push(state('prog', { 计算: `${a} ${op} ${b} = ${value}` }));
    },
  });
  done.clear();
  for (let index = 0; index < EXPR.length; index++) done.add(index);
  cursor = -1;
  steps[4].push(note('stack', `${EXPR} = ${result.value}`, 'green'));
  steps[4].push({ type: 'ds', frame: { text: [exprRow()], stack: [stackRow('nums')], aux: [stackRow('ops')] } });
  steps[4].push(render);
  return { steps, result, applied, peeks, snaps, ops };
}

const { steps, result, applied, peeks, snaps, ops: totalOps } = build();
export const calcRun = { result, applied, peeks, snaps, totalOps };
const [inParens, byMinus, ...atEnd] = applied;
const peekOf = (incoming: string) => peeks.filter((item) => item.incoming === incoming);
const list = (values: Array<number | string>) => values.join(' ') || '空';

export const stack: Lesson = {
  id: 'stack',
  name: 'STACK',
  title: '栈',
  group: 'linear',
  layer: [1, 1],
  complexity: { best: 'O(1)，push 和 pop 只动栈顶', worst: 'O(1)，容量固定，不需要扩容', note: '整个表达式求值是 O(n)，每个记号最多入栈出栈各一次。' },
  opsUnit: '入栈 + 出栈 + 看栈顶的次数',
  nodes: ['prog', 'text', 'stack', 'aux'],
  place: { prog: [110, 330], text: [480, 110], stack: [430, 500], aux: [850, 370] },
  labels: {
    prog: ['程序', 'eval'],
    text: ['表达式', `char s[${EXPR.length + 1}]`],
    stack: ['数字栈', `int data[${CAP}] + top`],
    aux: ['运算符栈', `int data[${CAP}] + top`],
  },
  labelAt: { text: [190, -50], stack: [-210, 60], aux: [0, 92] },
  radius: { text: 40, stack: 50, aux: 50 },
  initial: {
    text: [{ kind: 'row', id: 'e', w: TW, cells: cellsOf([...EXPR]) }],
    stack: [{ kind: 'row', id: 'n', w: W, cells: cellsOf(new Array(CAP).fill(null)), marks: [{ at: 0, text: 'top', color: 'amber' }] }],
    aux: [{ kind: 'row', id: 'o', w: W, cells: cellsOf(new Array(CAP).fill(null)), marks: [{ at: 0, text: 'top', color: 'amber' }] }],
  },
  start: ['prog', 'text', 'stack', 'aux'],
  legend: [['blue', '数字入栈'], ['violet', '运算符入栈'], ['teal', '看栈顶，要先算'], ['amber', '出栈'], ['green', '结果入栈'], [null, '操作数：入栈 + 出栈 + 看栈顶']],
  overview: {
    full: '后进先出，只在一头操作',
    description: `栈只有一个开口，最后放进去的最先拿出来。函数调用、撤销操作、括号匹配都靠它。这一课用两个栈真实计算 ${EXPR}：数字进数字栈，运算符进运算符栈。两个栈都是定长数组加一个 top 下标，出栈后的旧值还留在内存里，图上画成浅色。`,
    facts: [
      ['操作', 'push、pop、看栈顶'],
      ['每次操作', 'O(1)'],
      ['struct stack', `${STACK_LAYOUT.size} 字节，没有填充`],
      ['表达式', EXPR],
      ['思路来源', 'Dijkstra 的调度场算法，1961 年'],
      ['求值', 'O(n)'],
    ],
  },
  steps: [
    {
      title: '两个栈',
      desc: '数字和运算符分开放',
      detail: `push 把值写到 data[top]，再把 top 加 1；pop 先把 top 减 1，再读 data[top]。struct stack 一共 ${STACK_LAYOUT.size} 字节：data 指针在 +${STACK_LAYOUT.fields[0].offset}，top 在 +${STACK_LAYOUT.fields[1].offset}，cap 在 +${STACK_LAYOUT.fields[2].offset}。表达式从左往右读，数字进数字栈，运算符进运算符栈。`,
      facts: [['push', 'data[top++] = x'], ['pop', 'x = data[--top]'], ['数字栈', list(snaps[0].nums)], ['运算符栈', list(snaps[0].ops)]],
      events: [type(`./eval "${EXPR}"`), ...steps[0]],
    },
    {
      title: '括号先压着',
      desc: `读到 ${EXPR.slice(OPEN_AT, CLOSE_AT)}，全部入栈`,
      detail: `左括号直接入栈，它挡住了外面的运算符。'${peekOf('+')[0].incoming}' 进栈前看了一眼栈顶，是左括号，就不往下算。这时 '*' 还压在括号下面，要等括号里的结果出来。`,
      facts: [['数字栈', list(snaps[1].nums)], ['运算符栈', list(snaps[1].ops)], ['看栈顶', `${peekOf('+').length} 次`]],
      events: steps[1],
    },
    {
      title: '右括号：算到左括号',
      desc: `${inParens.a} ${inParens.op} ${inParens.b} = ${inParens.result}，括号消失`,
      detail: `右括号不入栈，它让程序反复看运算符栈顶，不是左括号就取出来算。这里弹出 ${inParens.b} 和 ${inParens.a}，再弹出 '${inParens.op}'，算出 ${inParens.result} 压回数字栈。最后左括号出栈丢掉，括号里的式子就变成了一个数。`,
      facts: [['计算', `${inParens.a} ${inParens.op} ${inParens.b} = ${inParens.result}`], ['看栈顶', `${peekOf(')').length} 次`], ['数字栈', list(snaps[2].nums)], ['运算符栈', list(snaps[2].ops)]],
      events: steps[2],
    },
    {
      title: '优先级决定先算谁',
      desc: `'-' 先算掉 '${byMinus.op}'，'/' 压着等`,
      detail: `'-' 进栈前看到栈顶的 '${byMinus.op}' 优先级更高，${byMinus.a} ${byMinus.op} ${byMinus.b} 的两个操作数都已就位，先算出 ${byMinus.result}。'/' 进栈前看到的是 '-'，优先级比自己低，'-' 的右操作数还没算出来，只能等。所以运算符栈里从下往上，优先级越来越高。`,
      facts: [['计算', `${byMinus.a} ${byMinus.op} ${byMinus.b} = ${byMinus.result}`], ['数字栈', list(snaps[3].nums)], ['运算符栈', list(snaps[3].ops)]],
      events: steps[3],
    },
    {
      title: '读完收尾',
      desc: `结果是 ${result.value}`,
      detail: `表达式读完后，从栈顶开始把剩下的运算符依次算掉：${atEnd.map((item) => `${item.a} ${item.op} ${item.b} = ${item.result}`).join('，然后 ')}。先弹出的是右操作数，减法和除法不能弄反。每个记号最多入栈出栈各一次，整个求值是 O(n)。`,
      facts: [['结果', String(result.value)], ['入栈', `${result.pushes} 次`], ['出栈', `${result.pops} 次`], ['看栈顶', `${result.peeks} 次`]],
      events: steps[4],
    },
  ],
  outro: {
    title: '后进先出正好对上括号',
    desc: '最后打开的括号最先关上',
    text: '括号的嵌套就是后进先出，所以栈天然适合处理它。函数调用也是同样的道理，后面几课里的递归都靠调用栈实现。栈满时再 push 会越界，真实代码要检查 top < cap，或者像动态数组那样扩容。',
    facts: [['push / pop', 'O(1)'], ['表达式求值', 'O(n)'], ['下一课', 'RING QUEUE']],
  },
};

