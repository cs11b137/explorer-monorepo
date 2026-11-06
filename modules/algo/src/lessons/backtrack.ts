import { callRegs, intArray, returnReg, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { gridAim, rowAim, towerAim } from '../scene/ds';
import { cellsOf, STACK } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, DsCell, GridPrim, Lesson, LessonEvent, RowPrim, Tone, TowerFrame, TowerPrim } from './types';

export interface QueenHooks {
  call?(row: number): void;
  /** 试 (row, col)。conflict 是攻击它的那个皇后所在的行，没有冲突时是 null。 */
  attempt?(row: number, col: number, conflict: number | null, q: number[]): void;
  place?(row: number, col: number, q: number[]): void;
  ret?(row: number, ok: boolean, q: number[]): void;
  solved?(q: number[]): void;
}

/** (row, col) 和前面各行的皇后比较：同一列，或者行差等于列差（同一条斜线）就冲突。返回冲突的行和比较次数。 */
export function conflictOf(q: number[], row: number, col: number): { at: number | null; compares: number } {
  let compares = 0;
  for (let r = 0; r < row; r++) {
    compares++;
    if (q[r] === col || Math.abs(q[r] - col) === row - r) return { at: r, compares };
  }
  return { at: null, compares };
}

/**
 * 回溯解 N 皇后：一行放一个，第 row 行从左到右试每一列，不冲突就放下并递归下一行。
 * 下一行无路可走时返回 false，回到这一行接着试下一列。找到第一个解就停。
 * tries 统计试过的位置，compares 统计和已放皇后的比较次数。
 */
export function solveQueens(n: number, hooks: QueenHooks = {}) {
  const q: number[] = new Array(n).fill(-1);
  let tries = 0;
  let compares = 0;
  let calls = 0;
  let backtracks = 0;
  const solve = (row: number): boolean => {
    calls++;
    hooks.call?.(row);
    if (row === n) {
      hooks.solved?.(q);
      hooks.ret?.(row, true, q);
      return true;
    }
    for (let col = 0; col < n; col++) {
      tries++;
      const found = conflictOf(q, row, col);
      compares += found.compares;
      hooks.attempt?.(row, col, found.at, q);
      if (found.at !== null) continue;
      q[row] = col;
      hooks.place?.(row, col, q);
      if (solve(row + 1)) {
        hooks.ret?.(row, true, q);
        return true;
      }
      backtracks++;
    }
    hooks.ret?.(row, false, q);
    return false;
  };
  const ok = solve(0);
  return { solution: ok ? [...q] : null, tries, compares, calls, backtracks };
}

/** 不停在第一个解，数出全部解的个数和试过的位置。 */
export function countQueens(n: number): { solutions: number; tries: number } {
  const q: number[] = new Array(n).fill(-1);
  let solutions = 0;
  let tries = 0;
  const solve = (row: number) => {
    if (row === n) {
      solutions++;
      return;
    }
    for (let col = 0; col < n; col++) {
      tries++;
      if (conflictOf(q, row, col).at !== null) continue;
      q[row] = col;
      solve(row + 1);
    }
  };
  solve(0);
  return { solutions, tries };
}

export const N = 4;
const SIG = 'bool solve(int *q, int n, int row)';
const W = 50;

/** 一次尝试：文案从这里取值。 */
export interface AttemptLog {
  row: number;
  col: number;
  conflict: number | null;
  /** 冲突的原因：同列或同斜线。 */
  why: 'col' | 'diag' | null;
  phase: number;
}

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let phase = 0;
  const bucket = () => steps[phase];
  let ops = 0;
  const qNow: Array<number | null> = new Array(N).fill(null);
  let depth = 0;
  const frames: TowerFrame[] = [];
  const attempts: AttemptLog[] = [];
  const rets: Array<{ row: number; ok: boolean; phase: number }> = [];

  const board = (tones: Record<string, Tone> = {}, trial?: [number, number, boolean]): GridPrim => {
    const cells: DsCell[][] = Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, c): DsCell => {
      const key = `${r},${c}`;
      if (trial && trial[0] === r && trial[1] === c) return { v: '后', tone: trial[2] ? 'blue' : 'amber', lift: true };
      if (r < depth && qNow[r] === c) return { v: '后', tone: tones[key] ?? 'green' };
      return { v: '' };
    }));
    return { kind: 'grid', id: 'b', rows: Array.from({ length: N }, (_, r) => `${r}`), cols: Array.from({ length: N }, (_, c) => `${c}`), cells, w: W };
  };
  const qRow = (lit?: number, tone: Tone = 'blue'): RowPrim => {
    const tones: Record<number, Tone> = {};
    qNow.forEach((value, index) => {
      if (value !== null && index >= depth) tones[index] = 'dim';
    });
    if (lit !== undefined) tones[lit] = tone;
    return { kind: 'row', id: 'q', w: 46, cells: cellsOf(qNow, { tones, lift: lit === undefined ? [] : [lit] }) };
  };
  const tower = (): TowerPrim => ({ kind: 'tower', id: 'calls', frames: frames.map((frame, index) => ({ ...frame, tone: index === frames.length - 1 ? 'blue' as Tone : undefined })) });
  const qBytes = (notes: Record<number, string>, color: Color = 'blue') => intArray('q', qNow, { color, notes, summary: `q[r] 是第 r 行皇后所在的列。只有前 ${depth} 行有效，后面是旧值` });

  const result = solveQueens(N, {
    call(row) {
      if (row === N) phase = 4;
      frames.push({ key: `${frames.length}-${row}-${ops}`, text: `solve(${row})` });
      const shown = tower();
      bucket().push(pk('prog', 'stack', 'violet', `solve(${row})`, [row === N ? `${N} 行都放好了` : `处理第 ${row} 行`], [ops, 'CALL', row === N ? `进入 solve(${row})：row 等于 n，说明 ${N} 行都放好了` : `进入 solve(${row})，在第 ${row} 行找位置`, 'reg'],
        wire('call 之前的寄存器', 'regs', 'abi', callRegs(SIG, [['q', STACK, true], ['n', N], ['row', row]], 'violet')), { quick: row > 0, ds: { stack: [shown] }, toAt: towerAim(shown, frames.length - 1) }));
      if (row === 2 && phase === 0) phase = 1;
    },
    attempt(row, col, conflict, q) {
      const found = conflictOf(q, row, col);
      ops += 1 + found.compares;
      const why = conflict === null ? null : q[conflict] === col ? 'col' : 'diag';
      attempts.push({ row, col, conflict, why, phase });
      const tones: Record<string, Tone> = conflict === null ? {} : { [`${conflict},${q[conflict]}`]: 'amber' };
      const shown = board(tones, [row, col, conflict === null]);
      const reason = conflict === null ? '和上面的皇后都不冲突' : why === 'col' ? `和第 ${conflict} 行的皇后同一列` : `和第 ${conflict} 行的皇后在同一条斜线上`;
      const reads = found.compares;
      bucket().push(state('prog', { 行: String(row), 列: String(col), 比较: String(found.compares) }));
      bucket().push(pk('prog', 'table', conflict === null ? 'blue' : 'amber', `试 (${row}, ${col})`, [reason], [ops, 'CMP', row === 0 ? `第 0 行上面没有皇后，(0, ${col}) 直接可以放` : `(${row}, ${col}) 和前 ${row} 行逐个比较，比了 ${found.compares} 次：${reason}`, reads ? reads * 4 : null],
        wire('q 数组，比较时读的是前几行', 'mem', 'abi', qBytes(conflict === null ? {} : { [conflict]: `第 ${conflict} 行的皇后在第 ${q[conflict]} 列，${why === 'col' ? '列相同' : `行差 ${row - conflict} 等于列差 ${Math.abs(q[conflict] - col)}`}。` }, conflict === null ? 'blue' : 'amber')),
        { quick: true, ds: { table: [shown] }, toAt: gridAim(shown, row, col) }));
    },
    place(row, col) {
      qNow[row] = col;
      depth = row + 1;
      ops++;
      const shownRow = qRow(row, 'green');
      bucket().push(pk('prog', 'array', 'green', `q[${row}] = ${col}`, [`第 ${row} 行放在第 ${col} 列`], [ops, 'WRITE', `(${row}, ${col}) 不冲突，记下 q[${row}] = ${col}，接着处理下一行`, 4],
        wire(`q 数组，基址 ${hex(STACK)}（E.G.）`, 'mem', 'abi', qBytes({ [row]: '刚写入。' }, 'green')), { quick: true, ds: { array: [shownRow], table: [board()] }, toAt: rowAim(shownRow, row) }));
    },
    ret(row, ok) {
      const popped = frames.pop();
      if (!popped?.text.endsWith(`(${row})`)) throw new Error('调用栈不匹配');
      rets.push({ row, ok, phase });
      if (!ok) depth = row - 1 < 0 ? 0 : row - 1;
      const shownTower = tower();
      const back = !ok && row > 0;
      bucket().push(pk('stack', 'prog', ok ? 'green' : 'slate', `返回 ${ok ? 'true' : 'false'}`, [ok ? '一路返回' : row > 0 ? `撤掉第 ${row - 1} 行的皇后` : '没有解'], [ops, 'RET', ok ? `solve(${row}) 返回 true，${row > 0 ? '上一层也直接返回' : '搜索结束'}` : `第 ${row} 行 ${N} 列都试过了，solve(${row}) 返回 false，回到第 ${row - 1} 行换下一列`, 'reg'],
        wire('函数返回', 'regs', 'abi', returnReg(SIG, ok ? 1 : 0, ok ? 'true：找到解了。' : 'false：这一行没有位置，上一行要换列。', ok ? 'green' : 'slate')),
        { quick: ok || row > 2, ds: { stack: [shownTower], ...(back ? { table: [board()], array: [qRow()] } : {}) } }));
      if (!ok && phase === 1) phase = 2;
      else if (!ok && phase === 2 && row === 1) phase = 3;
    },
    solved() {
      depth = N;
      const shown = board();
      bucket().push(note('table', `找到一个解：q = ${qNow.join(' ')}`, 'green'));
      bucket().push({ type: 'ds', frame: { table: [shown], array: [qRow()] } });
    },
  });
  steps[4].push(state('prog', { 行: null, 列: null, 比较: null }));
  steps[4].push(render);
  return { steps, result, attempts, rets, ops };
}

const { steps, result, attempts, rets, ops: totalOps } = build();
const all = countQueens(N);
export const queensRun = { result, attempts, rets, all, ops: totalOps };
const phaseOf = (index: number) => attempts.filter((item) => item.phase === index);
const firstRows = phaseOf(0).filter((item) => item.conflict === null);
const deadRow = phaseOf(1);
const deadRowIndex = deadRow[0].row;
const retreat = phaseOf(2);
const solution = result.solution!;
const pos = (row: number, col: number) => `(${row}, ${col})`;
const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

const emptyBoard: GridPrim = {
  kind: 'grid', id: 'b', w: W,
  rows: Array.from({ length: N }, (_, r) => `${r}`), cols: Array.from({ length: N }, (_, c) => `${c}`),
  cells: Array.from({ length: N }, () => Array.from({ length: N }, () => ({ v: '' }))),
};

export const backtrack: Lesson = {
  id: 'backtrack',
  name: 'BACKTRACKING',
  title: '回溯',
  group: 'strategy',
  layer: [7, 7],
  complexity: { best: 'O(n!)，找全部解时，搜索量只由 n 决定', worst: 'O(n!)，每行只在没被占的列里选，最多 n! 种排法', note: '这是上界。剪枝让实际走到的位置少得多，只找第一个解时还会更早停下。' },
  opsUnit: '试过的位置 + 和已放皇后的比较 + 写 q 的次数',
  nodes: ['prog', 'table', 'stack', 'array'],
  place: { prog: [120, 470], table: [540, 190], stack: [880, 330], array: [480, 560] },
  labels: {
    prog: ['程序', 'n_queens'],
    table: ['棋盘', `${N} × ${N}，行是 row，列是 col`],
    stack: ['调用栈', '每层一行'],
    array: ['皇后位置', `int q[${N}]`],
  },
  labelAt: { table: [-260, -110], stack: [0, 76], array: [-180, 60] },
  radius: { table: 80, stack: 60, array: 40 },
  initial: {
    table: [emptyBoard],
    stack: [{ kind: 'tower', id: 'calls', frames: [] }],
    array: [{ kind: 'row', id: 'q', w: 46, cells: cellsOf(new Array(N).fill(null)) }],
  },
  start: ['prog', 'table', 'array'],
  legend: [['blue', '可以放'], ['amber', '冲突'], ['green', '放下'], ['violet', '递归'], ['slate', '返回 false'], [null, '操作数：尝试 + 比较 + 写入']],
  overview: {
    full: '一步步试，走不通就退回上一步',
    description: `在 ${N} × ${N} 的棋盘上放 ${N} 个皇后，任意两个不能同行、同列或在同一条斜线上。回溯一行放一个，每一行从左往右试，冲突就换下一列，整行都不行就退回上一行换位置。这一课真实搜索第一个解，调用栈的每一层对应棋盘的一行，退回时这一层就返回 false。`,
    facts: [
      ['规则', '不同行、不同列、不同斜线'],
      ['一行一个', `所以 q[${N}] 就能表示整个棋盘`],
      ['冲突判断', '同列，或行差等于列差'],
      ['剪枝', '冲突的位置不往下走'],
      [`${N} 皇后的解`, `${all.solutions} 个`],
      ['最坏', 'O(n!)'],
    ],
  },
  steps: [
    {
      title: '一行放一个',
      desc: `${firstRows.map((item) => pos(item.row, item.col)).join('、')} 先放下`,
      detail: `第 0 行上面没有皇后，${pos(firstRows[0].row, firstRows[0].col)} 直接放下，然后递归处理下一行。第 1 行从左往右试，${phaseOf(0).filter((item) => item.row === 1 && item.conflict !== null).map((item) => pos(item.row, item.col)).join(' 和 ')} 都和上面冲突，${pos(firstRows[1].row, firstRows[1].col)} 可以。同一列冲突看 q[r] == col，同一条斜线冲突看行差是否等于列差。`,
      facts: [['已放', firstRows.map((item) => pos(item.row, item.col)).join(' ')], ['q', firstRows.map((item) => item.col).join(' ')], ['冲突判断', 'q[r] == c 或 |q[r] - c| == row - r']],
      events: [type(`./queens ${N}`), show('stack'), ...steps[0]],
    },
    {
      title: '走进死路',
      desc: `第 ${deadRowIndex} 行 ${deadRow.length} 个位置全部冲突`,
      detail: `第 ${deadRowIndex} 行的 ${deadRow.length} 个格子都被上面的皇后攻击：${deadRow.map((item) => `${pos(item.row, item.col)} ${item.why === 'col' ? '同列' : '同斜线'}`).join('，')}。这一行无论放哪里都不行，问题出在上面的选择。solve(${deadRowIndex}) 返回 false，把决定权交回第 ${deadRowIndex - 1} 行。`,
      facts: [[`第 ${deadRowIndex} 行`, deadRow.map((item) => (item.why === 'col' ? '同列' : '斜线')).join(' ')], ['返回', 'false'], ['回到', `第 ${deadRowIndex - 1} 行`]],
      events: steps[1],
    },
    {
      title: '回溯',
      desc: '退回上一行，换下一列',
      detail: `第 1 行换到 ${pos(retreat[0].row, retreat[0].col)}，再往下走，这次多走了一行，最后还是没有位置。把第 1 行剩下的列都试完，solve(1) 也返回 false，说明第 0 行放在第 ${firstRows[0].col} 列根本没有解。退回时不用清空 q，下一次写入会覆盖旧值，图上浅色的就是这些旧值。`,
      facts: [['这一步试了', `${retreat.length} 个位置`], ['结论', `第 0 行不能放在第 ${firstRows[0].col} 列`], ['q 的旧值', '留着，等覆盖']],
      events: steps[2],
    },
    {
      title: '换一列重来',
      desc: `第 0 行改放 ${pos(0, solution[0])}`,
      detail: `第 0 行改放第 ${solution[0]} 列，接下来每一行都很快找到了位置：${solution.map((col, row) => pos(row, col)).join('、')}。第 ${N} 次递归时 row 等于 n，说明 ${N} 行都放好了。`,
      facts: [['解', solution.map((col, row) => pos(row, col)).join(' ')], ['q', solution.join(' ')], ['这一步试了', `${phaseOf(3).length} 个位置`]],
      events: steps[3],
    },
    {
      title: '找到一个解',
      desc: `一共试了 ${result.tries} 个位置`,
      detail: `找到第一个解后一路返回 true。按代码统计，一共试了 ${result.tries} 个位置，比较 ${result.compares} 次，回溯 ${result.backtracks} 次。每行随便放一个要试 ${N ** N} 种摆法，每列只用一次也有 ${factorial(N)} 种，剪枝让搜索少走了很多分支。`,
      facts: [['尝试', String(result.tries)], ['比较', String(result.compares)], ['调用', `${result.calls} 次`], [`${N} 皇后共有`, `${all.solutions} 个解`]],
      events: steps[4],
    },
  ],
  outro: {
    title: '试错，但尽早放弃',
    desc: '剪枝越早，搜索越少',
    text: '回溯就是带剪枝的深度优先搜索：每一层做一个选择，发现走不通就撤销，换下一个选择。数独、排列组合、迷宫都可以这样解。剪枝判断越早、越便宜，搜索树就越小，所以实际代码常用三个布尔数组记下被占的列和两个方向的斜线，O(1) 判断冲突。',
    facts: [['最坏', 'O(n!)'], ['空间', 'O(n)，递归深度'], ['下一课', 'KMP']],
  },
};
