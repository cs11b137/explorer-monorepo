import { callRegs, intArray, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim, towerAim } from '../scene/ds';
import { cellsOf, HEAP, STACK } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, DsMark, Lesson, LessonEvent, RowPrim, Tone, TowerFrame, TowerPrim } from './types';

export interface MergeHooks {
  call?(lo: number, hi: number, depth: number): void;
  take?(k: number, from: number, compared: boolean, side: 'left' | 'right', ctx: { lo: number; mid: number; hi: number; i: number; j: number; a: number[]; t: Array<number | null> }): void;
  copied?(lo: number, hi: number, a: number[], t: Array<number | null>, depth: number): void;
}

/** 自顶向下归并排序，区间 [lo, hi)。相等时取左边的，所以稳定。cmp 比较次数，writes 元素写入次数。 */
export function mergeSort(input: number[], hooks: MergeHooks = {}) {
  const a = [...input];
  const t: Array<number | null> = new Array(a.length).fill(null);
  let cmp = 0;
  let writes = 0;
  const sort = (lo: number, hi: number, depth: number) => {
    if (hi - lo < 2) return;
    hooks.call?.(lo, hi, depth);
    const mid = lo + Math.floor((hi - lo) / 2);
    sort(lo, mid, depth + 1);
    sort(mid, hi, depth + 1);
    let i = lo;
    let j = mid;
    let k = lo;
    while (i < mid && j < hi) {
      cmp++;
      const left = a[i] <= a[j];
      const from = left ? i : j;
      t[k] = a[from];
      writes++;
      hooks.take?.(k, from, true, left ? 'left' : 'right', { lo, mid, hi, i, j, a, t });
      if (left) i++;
      else j++;
      k++;
    }
    while (i < mid) {
      t[k] = a[i];
      writes++;
      hooks.take?.(k, i, false, 'left', { lo, mid, hi, i, j, a, t });
      i++;
      k++;
    }
    while (j < hi) {
      t[k] = a[j];
      writes++;
      hooks.take?.(k, j, false, 'right', { lo, mid, hi, i, j, a, t });
      j++;
      k++;
    }
    for (let index = lo; index < hi; index++) {
      a[index] = t[index] as number;
      writes++;
    }
    hooks.copied?.(lo, hi, a, t, depth);
  };
  sort(0, a.length, 0);
  return { sorted: a, cmp, writes };
}

export const INPUT = [6, 3, 8, 1, 5, 2, 7, 4];
const MIDDLE = Math.floor(INPUT.length / 2);
const W = 56;
const SIG = 'void merge_sort(int *a, int *t, int lo, int hi)';

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const frames: TowerFrame[] = [];
  let ops = 0;
  let aNow = [...INPUT];
  let tNow: Array<number | null> = new Array(INPUT.length).fill(null);
  let span: [number, number] | null = null;
  const sortedRanges: Array<[number, number]> = [];

  const towerNow = (): TowerPrim => ({ kind: 'tower', id: 'calls', frames: frames.map((frame, index) => ({ ...frame, tone: index === frames.length - 1 ? 'blue' as Tone : undefined })) });
  const aRow = (tones: Record<number, Tone> = {}, lift: number[] = [], marks: DsMark[] = []): RowPrim => {
    const base: Record<number, Tone> = {};
    aNow.forEach((_, index) => {
      if (span && (index < span[0] || index >= span[1])) base[index] = 'dim';
    });
    for (const [lo, hi] of sortedRanges) for (let index = lo; index < hi; index++) if (!span || (index >= span[0] && index < span[1])) base[index] = 'teal';
    return { kind: 'row', id: 'a', w: W, cells: cellsOf(aNow, { tones: { ...base, ...tones }, lift }), marks };
  };
  const tRow = (tones: Record<number, Tone> = {}): RowPrim => ({ kind: 'row', id: 't', w: W, cells: cellsOf(tNow, { tones }) });
  const aBytes = (notes: Record<number, string>, color: Color = 'blue') => intArray('a', aNow, { notes, color, summary: `基址 ${hex(STACK)}（E.G.）` });
  const tBytes = (notes: Record<number, string>, color: Color = 'green') => intArray('t', tNow, { notes, color, summary: `辅助数组，基址 ${hex(HEAP)}（E.G.）` });

  const ranges = (key: string): [number, number] => {
    const [x, y] = key.split('-').map(Number);
    return [x, y];
  };

  const result = mergeSort(INPUT, {
    call(lo, hi, depth) {
      if (depth === 0) bucket = steps[0];
      else if (lo === 0 && hi === MIDDLE) bucket = steps[1];
      else if (lo === MIDDLE && hi === INPUT.length) bucket = steps[3];
      frames.push({ key: `${lo}-${hi}`, text: `ms(${lo},${hi})` });
      span = [lo, hi];
      const tower = towerNow();
      bucket.push(pk('prog', 'stack', 'violet', `ms(${lo}, ${hi})`, [`中点 ${lo + Math.floor((hi - lo) / 2)}`], [ops, 'CALL', `切分 [${lo}, ${hi})，长度 ${hi - lo}，深度 ${depth}`, 'reg'],
        wire('call 之前的寄存器', 'regs', 'abi', callRegs(SIG, [['a', STACK, true], ['t', HEAP, true], ['lo', lo], ['hi', hi]], 'violet')),
        { quick: depth > 0, ds: { stack: [tower], array: [aRow()] }, toAt: towerAim(tower, frames.length - 1) }));
    },
    take(k, from, compared, side, ctx) {
      span = [ctx.lo, ctx.hi];
      aNow = [...ctx.a];
      tNow = [...ctx.t];
      if (compared) ops++;
      ops++;
      bucket = ctx.hi - ctx.lo === INPUT.length ? steps[4] : ctx.lo < MIDDLE ? steps[2] : steps[3];
      const tones: Record<number, Tone> = { [from]: 'blue' };
      if (ctx.j < ctx.hi) tones[ctx.j] = side === 'right' ? 'blue' : 'amber';
      if (ctx.i < ctx.mid) tones[ctx.i] = side === 'left' ? 'blue' : 'amber';
      const marks: DsMark[] = [];
      if (ctx.i < ctx.mid) marks.push({ at: ctx.i, text: 'i', color: 'teal' });
      if (ctx.j < ctx.hi) marks.push({ at: ctx.j, text: 'j', color: 'violet' });
      const srcRow = aRow(tones, [from], marks);
      const dst = tRow({ [k]: 'green' });
      const left = ctx.a[ctx.i];
      const right = ctx.a[ctx.j];
      const label = compared ? (side === 'left' ? `${left} ≤ ${right}，取左` : `${left} > ${right}，取右`) : '另一半取完了';
      bucket.push(pk('array', 'aux', 'green', `t[${k}] = ${ctx.a[from]}`, [label], [ops, compared ? 'CMP' : 'WRITE', compared ? `比较 a[${ctx.i}] = ${left} 和 a[${ctx.j}] = ${right}，${side === 'left' ? '取左边（相等也取左，保持稳定）' : '取右边'}，写 t[${k}]` : `另一半取完了，a[${from}] = ${ctx.a[from]} 直接写到 t[${k}]`, 4],
        wire('辅助数组，写入后', 'mem', 'abi', tBytes({ [k]: `来自 a[${from}]。` })), { quick: true, ds: { array: [srcRow], aux: [dst] }, fromAt: rowAim(srcRow, from), toAt: rowAim(dst, k) }));
    },
    copied(lo, hi, a, t, depth) {
      aNow = [...a];
      tNow = [...t];
      ops += hi - lo;
      for (let index = sortedRanges.length - 1; index >= 0; index--) {
        const [x, y] = sortedRanges[index];
        if (x >= lo && y <= hi) sortedRanges.splice(index, 1);
      }
      sortedRanges.push([lo, hi]);
      const popped = frames.pop();
      if (popped?.key !== `${lo}-${hi}`) throw new Error('调用栈不匹配');
      span = frames.length ? ranges(frames[frames.length - 1].key) : null;
      const tower = towerNow();
      const shownA = aRow();
      const cleared = tRow();
      const mid = Math.floor((lo + hi) / 2);
      bucket.push(pk('aux', 'array', 'teal', `拷回 [${lo}, ${hi})`, [a.slice(lo, hi).join(' ')], [ops, 'WRITE', `把 t[${lo}..${hi - 1}] 拷回 a，这一段已有序，然后返回`, (hi - lo) * 4],
        wire('拷回之后的 a', 'mem', 'abi', aBytes({ [lo]: `[${lo}, ${hi}) 这一段已有序。` }, 'teal')), { quick: depth > 0, ds: { array: [shownA], aux: [cleared], stack: [tower] }, fromAt: rowAim(cleared, mid), toAt: rowAim(shownA, mid) }));
    },
  });

  aNow = result.sorted;
  span = null;
  sortedRanges.length = 0;
  sortedRanges.push([0, INPUT.length]);
  const done = aRow(Object.fromEntries(result.sorted.map((_, index) => [index, 'green'])) as Record<number, Tone>);
  steps[4].push(state('prog', { 比较: String(result.cmp), 写入: String(result.writes) }));
  steps[4].push(note('array', `${result.cmp} 次比较，${result.writes} 次写入`, 'green'));
  steps[4].push({ type: 'ds', frame: { array: [done] } });
  steps[4].push(render);
  return { steps, result, ops };
}

const { steps, result } = build();
const log2 = Math.log2(INPUT.length);

export const mergesort: Lesson = {
  id: 'mergesort',
  name: 'MERGE SORT',
  title: '归并排序',
  group: 'strategy',
  layer: [4, 4],
  complexity: { best: 'O(n log n)，比较次数约少一半，但每层都要拷贝', worst: 'O(n log n)，不受输入顺序影响', note: '代价是 O(n) 的辅助空间。' },
  opsUnit: '比较次数 + 元素写入次数',
  nodes: ['prog', 'stack', 'array', 'aux'],
  place: { prog: [130, 510], stack: [810, 500], array: [490, 150], aux: [400, 310] },
  labels: {
    prog: ['程序', 'merge_sort'],
    stack: ['调用栈', '每层一个区间'],
    array: ['数组 a', `int a[${INPUT.length}]`],
    aux: ['辅助数组 t', `int t[${INPUT.length}]，堆上`],
  },
  labelAt: { stack: [0, 76], array: [240, -20], aux: [270, 40] },
  radius: { stack: 60, array: 56, aux: 56 },
  initial: {
    stack: [{ kind: 'tower', id: 'calls', frames: [] }],
    array: [{ kind: 'row', id: 'a', w: W, cells: cellsOf(INPUT) }],
    aux: [{ kind: 'row', id: 't', w: W, cells: cellsOf(new Array(INPUT.length).fill(null)) }],
  },
  start: ['prog', 'array', 'aux'],
  legend: [['violet', '切分'], ['green', '写到辅助数组'], ['teal', '拷回'], [null, '操作数：比较 + 写入']],
  overview: {
    full: '先切到最小，再两两合并成有序',
    description: `两段已经有序的数组，只要比较它们的开头，就能线性时间合成一段。归并排序先把数组对半切到长度为 1，再一层层合并回来。这一课真实排序 ${INPUT.length} 个 int，可以看到元素从 a 写到辅助数组 t，再拷回 a。`,
    facts: [
      ['最好', 'O(n log n)'],
      ['最坏', 'O(n log n)'],
      ['辅助空间', `O(n)，int t[${INPUT.length}]`],
      ['稳定性', '稳定，相等时取左边'],
      ['本例比较', String(result.cmp)],
      ['本例写入', String(result.writes)],
    ],
  },
  steps: [
    {
      title: '从整段开始',
      desc: `区间 [0, ${INPUT.length})，中点 ${MIDDLE}`,
      detail: '区间用左闭右开表示，中点写成 lo + (hi - lo) / 2。这里传四个参数：数组 a、辅助数组 t 和区间两端，依次放进 rdi、rsi、rdx、rcx。辅助数组只分配一次，各层共用，这样不用反复 malloc。',
      facts: [['rdi', 'a'], ['rsi', 't'], ['rdx', 'lo = 0'], ['rcx', `hi = ${INPUT.length}`]],
      events: [type(`./msort ${INPUT.join(' ')}`), show('stack'), ...steps[0]],
    },
    {
      title: '切到最小',
      desc: '一路对半切，长度 1 自然有序',
      detail: `切分本身什么也不比较，只是算出中点再递归。长度不超过 1 的区间已经有序，直接返回，图上不单独画这些调用。${INPUT.length} 个元素对半切 ${log2} 层就到底了，这就是 log n 的来源。`,
      facts: [['切分比较', '0 次'], ['层数', `log₂ ${INPUT.length} = ${log2}`], ['最小区间', '长度 1']],
      events: steps[1],
    },
    {
      title: '合并左半',
      desc: '比较两段开头，小的先写到 t',
      detail: '两段都已有序，所以最小的元素一定在某一段的开头。比较 a[i] 和 a[j]，小的写到 t，指针前进。一段取完后，另一段剩下的直接照抄，不再需要比较。这样合并两段的比较次数不超过它们的总长度减 1。',
      facts: [['合并代价', 'O(两段长度之和)'], ['相等时', '取左边，保持稳定'], ['青色', '已有序的段']],
      events: steps[2],
    },
    {
      title: '处理右半',
      desc: '同样的过程走一遍',
      detail: '左半排好后，递归处理右半。图上变暗的格子不属于当前区间，这一层不会碰它们。每层合并加起来都要写 n 次辅助数组，再拷回 n 次，所以写入次数和输入顺序无关。',
      facts: [['每层写入', `${INPUT.length} 次到 t，${INPUT.length} 次回 a`], ['层数', String(log2)], ['写入总数', String(result.writes)]],
      events: steps[3],
    },
    {
      title: '最后一趟合并',
      desc: `共 ${result.cmp} 次比较，${result.writes} 次写入`,
      detail: `最后一次合并得到完整的有序数组。代码统计到 ${result.cmp} 次比较和 ${result.writes} 次写入，写入数正好是 2 × ${INPUT.length} × ${log2}。比较次数随输入变化，但永远不超过 n log₂ n。`,
      facts: [['比较', String(result.cmp)], ['写入', String(result.writes)], ['上界', `n log₂ n = ${INPUT.length * log2}`], ['结果', result.sorted.join(' ')]],
      events: steps[4],
    },
  ],
  outro: {
    title: '稳定且可预测，代价是多一份内存',
    desc: '不怕最坏输入',
    text: '归并排序的时间不受输入顺序影响，而且是稳定的，相等的元素保持原来的先后。代价是要一块和输入一样大的辅助空间。它也很适合外部排序：数据大到放不进内存时，可以分块排好再按顺序合并。',
    facts: [['时间', '始终 O(n log n)'], ['空间', 'O(n)'], ['下一课', 'DP']],
  },
};
