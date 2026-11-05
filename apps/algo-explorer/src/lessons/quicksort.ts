import { callRegs, intArray, registers, returnReg, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim, towerAim } from '../scene/ds';
import { cellsOf, STACK, TEXT_RET } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsMark, Lesson, LessonEvent, RowPrim, Tone, TowerFrame, TowerPrim } from './types';

export interface QuickHooks {
  call?(lo: number, hi: number, depth: number): void;
  compare?(j: number, hi: number, less: boolean, i: number, a: number[]): void;
  swap?(x: number, y: number, a: number[], i: number, j: number, hi: number): void;
  placed?(p: number, lo: number, hi: number, a: number[]): void;
  ret?(lo: number, hi: number, depth: number): void;
}

/** 快速排序：Lomuto 划分，末元素作基准。长度不超过 1 的区间立即返回。 */
export function quickSort(input: number[], hooks: QuickHooks = {}) {
  const a = [...input];
  let cmp = 0;
  let swaps = 0;
  let maxDepth = 0;
  const exchange = (x: number, y: number, i: number, j: number, hi: number) => {
    [a[x], a[y]] = [a[y], a[x]];
    swaps++;
    hooks.swap?.(x, y, a, i, j, hi);
  };
  const sort = (lo: number, hi: number, depth: number) => {
    if (lo >= hi) return;
    maxDepth = Math.max(maxDepth, depth + 1);
    hooks.call?.(lo, hi, depth);
    const pivot = a[hi];
    let i = lo;
    for (let j = lo; j < hi; j++) {
      cmp++;
      const less = a[j] < pivot;
      hooks.compare?.(j, hi, less, i, a);
      if (less) {
        if (i !== j) exchange(i, j, i, j, hi);
        i++;
      }
    }
    if (i !== hi) exchange(i, hi, i, hi, hi);
    hooks.placed?.(i, lo, hi, a);
    sort(lo, i - 1, depth + 1);
    sort(i + 1, hi, depth + 1);
    hooks.ret?.(lo, hi, depth);
  };
  sort(0, a.length - 1, 0);
  return { sorted: a, cmp, swaps, maxDepth };
}

export const INPUT = [5, 2, 9, 1, 7, 3, 8, 4];
const WORST_INPUT = INPUT.map((_, index) => index + 1);
const WORST = quickSort(WORST_INPUT);
const W = 60;
const SIG = 'void quick_sort(int *a, int lo, int hi)';

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  const ids = INPUT.map((_, index) => index);
  const fixed = new Set<number>();
  const frames: TowerFrame[] = [];
  let range: [number, number] = [0, INPUT.length - 1];

  const towerNow = (): TowerPrim => ({ kind: 'tower', id: 'calls', frames: frames.map((frame, index) => ({ ...frame, tone: index === frames.length - 1 ? 'blue' as Tone : undefined })) });
  const rowNow = (a: number[], tones: Record<number, Tone>, lift: number[], marks: DsMark[]): RowPrim => {
    const all: Record<number, Tone> = {};
    a.forEach((_, index) => {
      if (fixed.has(index)) all[index] = 'green';
      else if (index < range[0] || index > range[1]) all[index] = 'dim';
    });
    return { kind: 'row', id: 'a', w: W, cells: cellsOf(a, { keys: ids, tones: { ...all, ...tones }, lift }), marks };
  };
  const bytes = (a: number[], notes: Record<number, string>) => wire(`数组 a，基址 ${hex(STACK)}（E.G.）`, 'mem', 'abi', intArray('a', a, { notes, summary: 'int 4 字节，小端，元素紧挨着' }));

  const result = quickSort(INPUT, {
    call(lo, hi, depth) {
      if (depth === 1) bucket = lo === 0 ? steps[2] : steps[3];
      range = [lo, hi];
      frames.push({ key: `${lo}-${hi}`, text: `qs(${lo},${hi})` });
      const tower = towerNow();
      bucket.push(pk('prog', 'stack', 'violet', `qs(${lo}, ${hi})`, [`rsi=${lo} rdx=${hi}`], [ops, 'CALL', `进入 quick_sort，区间 [${lo}, ${hi}]，深度 ${depth}`, 'reg'],
        wire('call 之前的寄存器', 'regs', 'abi', callRegs(SIG, [['a', STACK, true], ['lo', lo], ['hi', hi]], 'violet')),
        { quick: depth > 0, ds: { stack: [tower] }, toAt: towerAim(tower , frames.length - 1) }));
      if (depth === 0) bucket = steps[1];
    },
    compare(j, hi, less, i, a) {
      ops++;
      const marks: DsMark[] = [{ at: hi, text: 'pivot', color: 'amber' }, { at: j, text: 'j', color: 'blue' }];
      if (i !== j) marks.push({ at: i, text: 'i', color: 'teal' });
      const row = rowNow(a, { [hi]: 'amber', [j]: 'blue' }, [j], marks);
      bucket.push(state('prog', { pivot: String(a[hi]), i: String(i), j: String(j) }));
      bucket.push(pk('prog', 'array', 'blue', `a[${j}] < ${a[hi]} ?`, [`${a[j]} ${less ? '<' : '≥'} ${a[hi]}`], [ops, 'CMP', `a[${j}] = ${a[j]} 和基准 ${a[hi]} 比较：${less ? '更小，归到左边' : '不小，留在右边'}`, 4],
        bytes(a, { [j]: '正在和基准比较。', [hi]: '基准，放在区间末尾。' }), { quick: true, ds: { array: [row] }, toAt: rowAim(row , j) }));
    },
    swap(x, y, a, _i, j, hi) {
      ops++;
      [ids[x], ids[y]] = [ids[y], ids[x]];
      const isPivot = y === hi && j === hi;
      const marks: DsMark[] = isPivot ? [] : [{ at: hi, text: 'pivot', color: 'amber' }];
      const row = rowNow(a, isPivot ? { [x]: 'amber', [y]: 'violet' } : { [hi]: 'amber', [x]: 'violet', [y]: 'violet' }, [], marks);
      bucket.push(pk('prog', 'array', 'violet', `交换 [${x}] ↔ [${y}]`, [`${a[x]} ↔ ${a[y]}`], [ops, 'SWAP', isPivot ? `把基准放到分界点：a[${x}] ↔ a[${y}]` : `比基准小的换到左边：a[${x}] ↔ a[${y}]`, 8],
        bytes(a, { [x]: '交换后的值。', [y]: '交换后的值。' }), { quick: true, ds: { array: [row] }, toAt: rowAim(row , x) }));
    },
    placed(p, _lo, hi, a) {
      fixed.add(p);
      const row = rowNow(a, {}, [], [{ at: p, text: '到位', color: 'green' }]);
      bucket.push(state('prog', { pivot: null, i: null, j: null }));
      bucket.push(pk('stack', 'prog', 'green', `基准到位 [${p}]`, [`a[${p}] = ${a[p]}`], [ops, 'RET', `划分结束：a[${p}] = ${a[p]} 已在最终位置，左边都比它小`, 'reg'],
        wire('partition 的结果', 'regs', 'abi', returnReg('int partition(int *a, int lo, int hi)', p, `分界点下标。a[${p}] 不会再移动，hi = ${hi}。`)),
        { quick: true, ds: { array: [row] } }));
    },
    ret(lo, hi, depth) {
      const popped = frames.pop();
      if (popped?.key !== `${lo}-${hi}`) throw new Error('调用栈不匹配');
      for (let index = lo; index <= hi; index++) fixed.add(index);
      if (depth === 0) bucket = steps[4];
      const tower = towerNow();
      range = frames.length ? range : [0, INPUT.length - 1];
      bucket.push(pk('stack', 'prog', 'slate', `返回 (${lo}, ${hi})`, [`[${lo}, ${hi}] 已有序`], [ops, 'RET', `quick_sort(${lo}, ${hi}) 返回，这一段已有序`, 'reg'],
        wire('ret 弹出 8 字节返回地址', 'regs', 'abi', registers('ret 之后', [['rip', TEXT_RET, 'call 压入的返回地址，ret 把它弹回 rip。', { example: true }]], 'slate')),
        { quick: true, ds: { stack: [tower] } }));
    },
  });
  const done = rowNow(result.sorted, {}, [], []);
  steps[4].push(note('array', `${result.cmp} 次比较，${result.swaps} 次交换`, 'green'));
  steps[4].push({ type: 'ds', frame: { array: [done] } });
  steps[4].push(render);
  return { steps, result };
}

const { steps, result } = build();

export const quicksort: Lesson = {
  id: 'quicksort',
  name: 'QUICK SORT',
  title: '快速排序',
  group: 'strategy',
  layer: [4, 5],
  complexity: { best: 'O(n log n)，每次划分都接近对半', worst: 'O(n²)，每次划分都只分出一个元素', note: '末元素作基准时，已排好序的输入正是最坏情况。' },
  opsUnit: '比较次数 + 交换次数',
  nodes: ['prog', 'stack', 'array'],
  place: { prog: [140, 500], stack: [800, 530], array: [490, 220] },
  labels: {
    prog: ['程序', 'quick_sort'],
    stack: ['调用栈', '每层一个区间'],
    array: ['数组 a', `int a[${INPUT.length}]，原地排序`],
  },
  labelAt: { stack: [0, 76], array: [190, -70] },
  radius: { stack: 60, array: 56 },
  initial: { stack: [{ kind: 'tower', id: 'calls', frames: [] }], array: [{ kind: 'row', id: 'a', w: W, cells: cellsOf(INPUT, { keys: INPUT.map((_, index) => index) }) }] },
  start: ['prog', 'array'],
  legend: [['blue', '比较'], ['violet', '交换或调用'], ['green', '基准到位'], ['slate', '返回'], [null, '操作数：比较 + 交换']],
  overview: {
    full: '选一个基准，小的放左边，大的放右边',
    description: `快速排序先选一个基准，把数组分成比它小和不比它小的两段，基准就落在最终位置上。然后对两段分别重复同样的事。这一课真实排序 ${INPUT.length} 个 int，每次比较和交换都是代码跑出来的，调用栈显示当前处理的区间。`,
    facts: [
      ['发明', 'C. A. R. Hoare，1961 年发表'],
      ['本课划分', 'Lomuto，末元素作基准'],
      ['平均比较', '约 1.39 n log₂ n'],
      ['最好', 'O(n log n)'],
      ['最坏', 'O(n²)'],
      ['额外空间', '只有调用栈'],
    ],
  },
  steps: [
    {
      title: '进入函数',
      desc: '三个参数放进寄存器',
      detail: `按 System V 调用约定，前三个整数或指针参数依次放在 rdi、rsi、rdx。a 退化成指向首元素的指针，函数改的就是原数组。这里只处理长度大于 1 的区间，更短的已经有序，调用后立刻返回，图上不再单独画出。`,
      facts: [['rdi', 'a 的地址'], ['rsi', 'lo = 0'], ['rdx', `hi = ${INPUT.length - 1}`]],
      events: [type(`./qsort ${INPUT.join(' ')}`), show('stack'), ...steps[0]],
    },
    {
      title: '第一轮划分',
      desc: `基准 ${INPUT[INPUT.length - 1]}，把小的换到左边`,
      detail: 'j 从左到右扫描，i 标记「小于基准」那段的末尾之后。遇到比基准小的元素就和 a[i] 交换，i 前进一格。扫描结束后把基准换到 i 的位置，它左边都更小，右边都不小，所以它再也不用动。',
      facts: [['比较次数', `${INPUT.length - 1}，区间长度减 1`], ['不变量', 'a[lo..i-1] 都小于基准'], ['稳定性', '不稳定，相等元素可能换序']],
      events: steps[1],
    },
    {
      title: '递归左段',
      desc: '对基准左边重复同样的事',
      detail: '调用栈多了一层，变暗的格子表示这一层不会碰到。每次递归要处理的区间都比上一层短，所以一定会结束。绿色的格子已经在最终位置上。',
      facts: [['调用栈', '每层压入返回地址和局部变量'], ['绿色', '已到最终位置'], ['变暗', '不在当前区间']],
      events: steps[2],
    },
    {
      title: '递归右段',
      desc: '左段排好后处理右段',
      detail: '左段返回后，调用栈回到第一层，接着处理基准右边。两段互不相干，因为划分已经保证左边的元素都比右边小，这也是后面不需要合并步骤的原因。',
      facts: [['合并步骤', '不需要'], ['本例最深', `${result.maxDepth} 层`], ['最坏深度', 'n - 1 层']],
      events: steps[3],
    },
    {
      title: '排序完成',
      desc: `共 ${result.cmp} 次比较，${result.swaps} 次交换`,
      detail: `这组输入实际发生了 ${result.cmp} 次比较和 ${result.swaps} 次交换。同一份代码排已经有序的 1 到 ${WORST_INPUT.length}，每次都只分出一个元素，比较次数涨到 ${WORST.cmp}，也就是 n(n-1)/2，这就是最坏情况 O(n²)。`,
      facts: [['本例比较', String(result.cmp)], ['本例交换', String(result.swaps)], ['有序输入比较', String(WORST.cmp)], ['结果', result.sorted.join(' ')]],
      events: steps[4],
    },
  ],
  outro: {
    title: '基准决定快慢',
    desc: '划分越均匀，递归越浅',
    text: 'Lomuto 写法简单，适合教学；Hoare 原始的划分交换次数更少。真实的库会用更好的基准选法，并在递归过深时改用别的算法，避开最坏情况。C 标准没有规定 qsort 必须用快速排序，它只规定了接口。',
    facts: [['优点', '原地、缓存友好'], ['缺点', '最坏 O(n²)，不稳定'], ['下一课', 'MERGE SORT']],
  },
};
