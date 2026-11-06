import { intMatrix, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { gridAim } from '../scene/ds';
import { cellsOf, STACK } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

export interface LcsHooks {
  /** 算完 dp[i][j]。match 表示两个字符相同。 */
  cell?(i: number, j: number, match: boolean, dp: number[][], from: 'diag' | 'up' | 'left'): void;
  /** 回溯时走过 (i, j)。 */
  back?(i: number, j: number, taken: boolean, dp: number[][], result: string): void;
}

/** 最长公共子序列。dp[i][j] 是 x 的前 i 个字符和 y 的前 j 个字符的答案。 */
export function lcs(x: string, y: string, hooks: LcsHooks = {}) {
  const m = x.length;
  const n = y.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  let cmp = 0;
  let writes = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cmp++;
      const match = x[i - 1] === y[j - 1];
      let from: 'diag' | 'up' | 'left';
      if (match) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        from = 'diag';
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        dp[i][j] = dp[i - 1][j];
        from = 'up';
      } else {
        dp[i][j] = dp[i][j - 1];
        from = 'left';
      }
      writes++;
      hooks.cell?.(i, j, match, dp, from);
    }
  }
  let result = '';
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (x[i - 1] === y[j - 1]) {
      result = x[i - 1] + result;
      hooks.back?.(i, j, true, dp, result);
      i--;
      j--;
    } else {
      hooks.back?.(i, j, false, dp, result);
      if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
  }
  return { length: dp[m][n], text: result, dp, cmp, writes };
}

/** 不用表的递归，只用来统计调用次数，和填表做对比。 */
export function naiveLcsCalls(x: string, y: string): number {
  let calls = 0;
  const go = (i: number, j: number): number => {
    calls++;
    if (!i || !j) return 0;
    if (x[i - 1] === y[j - 1]) return go(i - 1, j - 1) + 1;
    return Math.max(go(i - 1, j), go(i, j - 1));
  };
  go(x.length, y.length);
  return calls;
}

export const X = 'ABCBD';
export const Y = 'BDCAB';
const M = X.length;
const COLS = Y.length + 1;
const TABLE_BYTES = (M + 1) * COLS * 4;
const TABLE_TYPE = `int dp[${M + 1}][${COLS}]`;
const ANSWER_CELL = `dp[${M}][${Y.length}]`;
/** 第几行开始下一个步骤。 */
const ROW_PHASES = { first: 1, middleEnd: M - 2 };
const NAIVE = naiveLcsCalls(X, Y);
const W = 50;

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  const empty = (): number[][] => Array.from({ length: X.length + 1 }, () => new Array(Y.length + 1).fill(0));
  const filled = Array.from({ length: X.length + 1 }, (_, r) => new Array(Y.length + 1).fill(r === 0));
  filled.forEach((row) => (row[0] = true));
  let values = empty();
  const path = new Set<string>();

  const grid = (tones: Record<string, Tone> = {}, lift: string[] = []): GridPrim => {
    const cells: DsCell[][] = values.map((row, r) => row.map((value, c) => {
      const key = `${r},${c}`;
      return { v: filled[r][c] ? String(value) : '', tone: tones[key] ?? (path.has(key) ? 'green' : r === 0 || c === 0 ? 'slate' : undefined), lift: lift.includes(key) || undefined };
    }));
    return { kind: 'grid', id: 'dp', rows: ['∅', ...X], cols: ['∅', ...Y], cells, w: W };
  };
  const answerRow = (text: string, lit?: number): RowPrim => ({ kind: 'row', id: 'r', w: 48, center: 1.5, cells: cellsOf([...text].concat(new Array(Math.max(0, 4 - text.length)).fill('')), { tones: lit === undefined ? {} : { [lit]: 'green' } }) });
  const bytes = (notes: Record<string, string>) => wire(`dp 表，基址 ${hex(STACK)}（E.G.）`, 'mem', 'abi', intMatrix('dp', values, { notes }));

  const first = grid();
  bucket.push(pk('prog', 'table', 'slate', 'dp[0][*] = dp[*][0] = 0', ['空串的答案是 0'], [ops, 'WRITE', `第 0 行和第 0 列写 0：一边是空串时，公共子序列长度只能是 0`, (X.length + Y.length + 1) * 4],
    bytes({ '0,0': '空串对空串。' }), { ds: { table: [first] }, toAt: gridAim(first, 0, 0) }));

  const result = lcs(X, Y, {
    cell(i, j, match, dp, from) {
      bucket = steps[i === ROW_PHASES.first ? 1 : i <= ROW_PHASES.middleEnd ? 2 : 3];
      values = dp.map((row) => [...row]);
      filled[i][j] = true;
      ops += 2;
      const dep = from === 'diag' ? `${i - 1},${j - 1}` : from === 'up' ? `${i - 1},${j}` : `${i},${j - 1}`;
      const shown = grid({ [`${i},${j}`]: match ? 'green' : 'blue', [dep]: 'amber' }, [`${i},${j}`]);
      const left = X[i - 1];
      const right = Y[j - 1];
      const how = match ? `相同，dp[${i - 1}][${j - 1}] + 1 = ${dp[i][j]}` : `不同，取 max(上 ${dp[i - 1][j]}, 左 ${dp[i][j - 1]}) = ${dp[i][j]}`;
      bucket.push(state('prog', { i: String(i), j: String(j), 比较: `${left} / ${right}` }));
      bucket.push(pk('prog', 'table', match ? 'green' : 'blue', `dp[${i}][${j}] = ${dp[i][j]}`, [`${left} ${match ? '==' : '!='} ${right}`], [ops, 'CMP', `X[${i - 1}] = ${left}，Y[${j - 1}] = ${right}：${how}`, 4],
        bytes({ [`${i},${j}`]: how, [dep]: '依赖的格子。' }), { quick: true, ds: { table: [shown] }, toAt: gridAim(shown, i, j) }));
    },
    back(i, j, taken, _dp, text) {
      bucket = steps[4];
      path.add(`${i},${j}`);
      const shown = grid({ [`${i},${j}`]: taken ? 'green' : 'amber' }, [`${i},${j}`]);
      const answer = answerRow(text, taken ? 0 : undefined);
      bucket.push(state('prog', { i: String(i), j: String(j), 结果: text || '（空）' }));
      bucket.push(pk('table', 'prog', taken ? 'green' : 'amber', taken ? `取 ${X[i - 1]}` : `dp[${i}][${j}]`, [taken ? `结果：${text}` : '往值相同的方向退'], [ops, 'READ', taken ? `X[${i - 1}] == Y[${j - 1}] = ${X[i - 1]}，这个字符属于答案，走对角线` : `X[${i - 1}] != Y[${j - 1}]，往上或往左退到值相同的格子`, 4],
        bytes({ [`${i},${j}`]: '回溯经过这里。' }), { quick: true, ds: { table: [shown], array: [answer] }, fromAt: gridAim(shown, i, j) }));
    },
  });
  values = result.dp;
  const finalGrid = grid();
  const finalAnswer = answerRow(result.text);
  steps[4].push(note('array', `长度 ${result.length}：${result.text}`, 'green'));
  steps[4].push({ type: 'ds', frame: { table: [finalGrid], array: [finalAnswer] } });
  steps[4].push(render);
  return { steps, result, ops };
}

const { steps, result } = build();
export const lcsRun = result;

const initialGrid: GridPrim = {
  kind: 'grid', id: 'dp', rows: ['∅', ...X], cols: ['∅', ...Y], w: W,
  cells: Array.from({ length: X.length + 1 }, () => Array.from({ length: Y.length + 1 }, () => ({ v: '' }))),
};

export const lcsLesson: Lesson = {
  id: 'lcs',
  name: 'DP',
  title: '动态规划',
  group: 'strategy',
  layer: [5, 5],
  complexity: { best: 'O(n²)，严格说是 O(mn)，每一格都要算', worst: 'O(n²)，严格说是 O(mn)，和字符串内容无关', note: `不记表的递归会重复计算，最坏是指数级。` },
  opsUnit: '字符比较次数 + 写表次数',
  nodes: ['prog', 'table', 'array'],
  place: { prog: [120, 500], table: [540, 280], array: [840, 520] },
  labels: {
    prog: ['程序', 'lcs(X, Y)'],
    table: ['DP 表', `${TABLE_TYPE}，按行存放`],
    array: ['答案', '回溯得到'],
  },
  labelAt: { table: [190, -170], array: [0, 76] },
  radius: { table: 80, array: 40 },
  initial: { table: [initialGrid], array: [{ kind: 'row', id: 'r', w: 48, center: 1.5, cells: cellsOf(['', '', '', '']) }] },
  start: ['prog', 'table'],
  legend: [['blue', '不同，取上或左'], ['green', '相同，对角线加 1'], ['amber', '回溯'], ['slate', '边界'], [null, '操作数：比较 + 写表']],
  overview: {
    full: '把大问题的答案，写在小问题的表格上',
    description: `求两个字符串最长公共子序列的长度。如果直接递归，同一个子问题会被算很多遍。动态规划把每个子问题的答案写进表格，后面直接查。这一课真实填写 X = ${X}、Y = ${Y} 的表格，格子里的数字都是算出来的，琥珀色的格子是这一格依赖的答案。`,
    facts: [
      ['问题', '最长公共子序列（LCS）'],
      ['状态', 'dp[i][j]：X 前 i 个和 Y 前 j 个的答案'],
      ['表格', `${TABLE_TYPE}，${TABLE_BYTES} 字节`],
      ['时间', 'O(mn)'],
      ['空间', 'O(mn)，只要长度可降到一行'],
      ['子序列', '顺序保持，不要求连续'],
    ],
  },
  steps: [
    {
      title: '定义子问题',
      desc: '第 0 行和第 0 列都是 0',
      detail: `dp[i][j] 表示 X 的前 i 个字符和 Y 的前 j 个字符的 LCS 长度，所以答案在右下角。一边是空串时长度只能是 0，这就是边界。C 的二维数组按行连续存放，dp[i][j] 的偏移是 (i × ${COLS} + j) × 4。`,
      facts: [['表大小', `${X.length + 1} × ${Y.length + 1}`], ['边界', '空串，长度 0'], ['答案位置', ANSWER_CELL]],
      events: [type(`./lcs ${X} ${Y}`), show('array'), ...steps[0]],
    },
    {
      title: '填第 1 行',
      desc: `X 只取 ${X[0]}，逐列比较`,
      detail: `两个字符相同时，它们可以同时放进答案，所以 dp[i][j] = dp[i-1][j-1] + 1。不同时，至少有一个用不上，答案取「去掉 X 这个字符」和「去掉 Y 这个字符」中较大的。第 1 行只有 ${X[0]}，只在遇到 Y 里的 ${X[0]} 时才会变成 1。`,
      facts: [['相同', 'dp[i-1][j-1] + 1'], ['不同', 'max(上, 左)'], ['填写顺序', '从左到右，从上到下']],
      events: steps[1],
    },
    {
      title: '继续填写',
      desc: '每一格只看左、上、左上',
      detail: '填写顺序保证了这一格依赖的三个格子已经算好，所以每格只要 O(1)。一共 m × n 格，总时间就是 O(mn)。琥珀色标出的是这一格实际用到的格子。',
      facts: [['每格代价', 'O(1)'], ['依赖', '左、上、左上'], ['存放方式', '按行连续']],
      events: steps[2],
    },
    {
      title: '填到右下角',
      desc: `答案 ${ANSWER_CELL} = ${result.length}`,
      detail: `最后两行填完，右下角就是答案 ${result.length}。代码统计到 ${result.cmp} 次字符比较，正好是 ${M} × ${Y.length}。同样的两个字符串，用不记表的递归要调用 ${NAIVE} 次，字符串变长时差距会迅速变成指数级。`,
      facts: [['答案', String(result.length)], ['填表比较', String(result.cmp)], ['纯递归调用', `${NAIVE} 次`]],
      events: steps[3],
    },
    {
      title: '回溯找答案',
      desc: `从右下角退回去，得到 ${result.text}`,
      detail: `表里只存长度，子序列本身要倒着找。字符相同就把它记下，走对角线；不同就往值相同的方向退。这次得到 ${result.text}。答案可能不止一个，退的方向不同，结果可能不同，但长度一定是 ${result.length}。`,
      facts: [['LCS', result.text], ['长度', String(result.length)], ['回溯代价', 'O(m + n)']],
      events: steps[4],
    },
  ],
  outro: {
    title: '用空间换掉重复计算',
    desc: '子问题重叠时，表格就有价值',
    text: '能用动态规划的问题要有两个特点：大问题的最优解由小问题的最优解组成，而且小问题会反复出现。写之前先定义清楚表格的每一格代表什么，这比写循环更重要。diff 这类工具的思路就和 LCS 有关。',
    facts: [['时间', 'O(mn)'], ['纯递归', '指数级'], ['下一课', 'BACKTRACKING']],
  },
};
