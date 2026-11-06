import { callRegs, intArray, returnReg, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim, towerAim } from '../scene/ds';
import { cellsOf, HEAP } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsMark, Lesson, LessonEvent, RowPrim, Tone, TowerPrim } from './types';

export interface SearchHooks {
  probe?(lo: number, hi: number, mid: number, value: number, count: number): void;
}

/** 在升序数组里找 target，区间是左闭右开 [lo, hi)。返回下标和比较次数，找不到时下标是 -1。 */
export function binarySearch(a: number[], target: number, hooks: SearchHooks = {}): { index: number; probes: number } {
  let lo = 0;
  let hi = a.length;
  let probes = 0;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    probes++;
    hooks.probe?.(lo, hi, mid, a[mid], probes);
    if (a[mid] === target) return { index: mid, probes };
    if (a[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return { index: -1, probes };
}

export const ARR = [3, 8, 12, 17, 21, 26, 31, 38, 44, 52, 60, 71];
export const HIT_TARGET = 44;
export const MISS_TARGET = 40;
const SIG = 'int bsearch(const int *a, int n, int target)';
const W = 46;

function build() {
  const steps: LessonEvent[][] = [[], [], [], []];
  let ops = 0;
  let first = { mid: 0, value: 0 };
  const row = (lo: number, hi: number, mid: number | null, lit: Tone = 'blue'): RowPrim => {
    const tones: Record<number, Tone> = {};
    ARR.forEach((_, index) => {
      if (index < lo || index >= hi) tones[index] = 'dim';
    });
    if (mid !== null) tones[mid] = lit;
    const marks: DsMark[] = [];
    if (lo < ARR.length) marks.push({ at: lo, text: 'lo', color: 'teal' });
    if (hi - 1 >= 0 && hi - 1 !== lo) marks.push({ at: hi - 1, text: 'hi-1', color: 'violet' });
    if (mid !== null) marks.push({ at: mid, text: 'mid', color: lit === 'green' ? 'green' : 'blue' });
    return { kind: 'row', id: 'a', w: W, cells: cellsOf(ARR, { tones, lift: mid === null ? [] : [mid] }), marks };
  };
  const tower = (active: boolean, target: number): TowerPrim => ({ kind: 'tower', id: 'calls', frames: active ? [{ key: String(target), text: `bsearch(${target})`, tone: 'blue' }] : [] });
  const bytes = (notes: Record<number, string>) => wire(`升序数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', intArray('a', ARR, { notes, summary: 'a[mid] 的地址 = 基址 + mid × 4' }));

  const search = (target: number, pick: (probe: number) => LessonEvent[]) => {
    const shownTower = tower(true, target);
    pick(0).push(pk('prog', 'stack', 'violet', `bsearch(${target})`, [`rdx=${target}`], [ops, 'CALL', `查找 ${target}，区间 [0, ${ARR.length})`, 'reg'],
      wire('call 之前的寄存器', 'regs', 'abi', callRegs(SIG, [['a', HEAP, true], ['n', ARR.length], ['target', target]], 'violet')),
      { ds: { stack: [shownTower], array: [row(0, ARR.length, null)] }, toAt: towerAim(shownTower, 0), quick: target === MISS_TARGET }));
    const result = binarySearch(ARR, target, {
      probe(lo, hi, mid, value, count) {
        ops++;
        if (target === HIT_TARGET && count === 1) first = { mid, value };
        const hit = value === target;
        const shown = row(lo, hi, mid, hit ? 'green' : 'blue');
        const list = pick(count);
        list.push(state('prog', { 目标: String(target), lo: String(lo), hi: String(hi), mid: String(mid) }));
        list.push(pk('prog', 'array', hit ? 'green' : 'blue', `a[${mid}] = ${value}`, [hit ? '相等，找到' : value < target ? `${value} < ${target}，去右半` : `${value} > ${target}，去左半`], [ops, 'CMP', `mid = ${lo} + (${hi} - ${lo}) / 2 = ${mid}；a[${mid}] = ${value}，${hit ? '命中' : value < target ? `lo 改成 ${mid + 1}` : `hi 改成 ${mid}`}`, 4],
          bytes({ [mid]: `正在比较。剩余区间 [${lo}, ${hi})，共 ${hi - lo} 个。` }), { ds: { array: [shown] }, toAt: rowAim(shown, mid), quick: count > 1 }));
      },
    });
    return result;
  };

  const hit = search(HIT_TARGET, (probe) => (probe === 0 ? steps[0] : probe === 1 ? steps[1] : steps[2]));
  steps[2].push(pk('stack', 'prog', 'green', `返回 ${hit.index}`, [`比较 ${hit.probes} 次`], [ops, 'RET', `找到 ${HIT_TARGET}，下标 ${hit.index}，比较 ${hit.probes} 次`, 'reg'],
    wire('函数返回', 'regs', 'abi', returnReg(SIG, hit.index, `下标 ${hit.index}。`)), { ds: { stack: [tower(false, HIT_TARGET)] } }));
  const miss = search(MISS_TARGET, () => steps[3]);
  const finalRow = row(0, 0, null);
  steps[3].push(pk('stack', 'prog', 'amber', '返回 -1', [`比较 ${miss.probes} 次`], [ops, 'RET', `lo == hi，区间空了：${MISS_TARGET} 不存在，比较 ${miss.probes} 次`, 'reg'],
    wire('函数返回', 'regs', 'abi', returnReg(SIG, -1, '约定：-1 表示没找到。', 'amber')), { ds: { stack: [tower(false, MISS_TARGET)], array: [{ ...finalRow, marks: [] }] } }));
  steps[3].push(note('array', `${ARR.length} 个元素，最多比较 ${Math.floor(Math.log2(ARR.length)) + 1} 次`, 'green'));
  steps[3].push(render);
  return { steps, hit, miss, first };
}

const { steps, hit, miss, first } = build();
export const searchRun = { hit, miss, first };
const initial: RowPrim = { kind: 'row', id: 'a', w: W, cells: cellsOf(ARR) };
const maxProbes = Math.floor(Math.log2(ARR.length)) + 1;

export const binarysearch: Lesson = {
  id: 'binarysearch',
  name: 'BINARY SEARCH',
  title: '二分查找',
  group: 'linear',
  layer: [1, 2],
  complexity: { best: 'O(1)，第一次就命中中点', worst: 'O(log n)，每次排除一半，直到区间为空', note: '前提是数组已排序。' },
  opsUnit: '比较次数',
  nodes: ['prog', 'array', 'stack'],
  place: { prog: [130, 470], array: [500, 230], stack: [810, 520] },
  labels: {
    prog: ['程序', 'bsearch'],
    array: ['升序数组 a', `int a[${ARR.length}]`],
    stack: ['调用栈', '一层就够'],
  },
  labelAt: { array: [220, -60], stack: [0, 76] },
  radius: { array: 56, stack: 60 },
  initial: { array: [initial], stack: [{ kind: 'tower', id: 'calls', frames: [] }] },
  start: ['prog', 'array'],
  legend: [['blue', '比较'], ['green', '命中'], ['violet', '调用'], ['amber', '没找到'], [null, '操作数：比较次数']],
  overview: {
    full: '每比较一次，排除剩下的一半',
    description: `在有序数组里找一个数，不用从头看。先看中间：小了就去右半，大了就去左半，每次都能扔掉一半。这一课在 ${ARR.length} 个 int 上真实执行两次查找，一次命中，一次不存在。变暗的格子就是已经排除的部分。`,
    facts: [
      ['前提', '数组已排序'],
      ['区间写法', '左闭右开 [lo, hi)'],
      ['中点', 'lo + (hi - lo) / 2'],
      ['最多比较', `⌊log₂ n⌋ + 1 = ${maxProbes} 次`],
      ['随机访问', '依赖数组能 O(1) 取下标'],
      ['操作数', '比较次数'],
    ],
  },
  steps: [
    {
      title: '确定区间',
      desc: `lo = 0，hi = ${ARR.length}，还没排除任何元素`,
      detail: '用左闭右开区间：lo 是第一个还没排除的下标，hi 是最后一个还没排除的下标加 1。lo 等于 hi 时区间为空，循环结束。写法统一之后，边界不容易出错。',
      facts: [['lo', '0'], ['hi', String(ARR.length)], ['目标', String(HIT_TARGET)]],
      events: [type(`./bsearch ${HIT_TARGET}`), show('stack'), ...steps[0]],
    },
    {
      title: '第一次折半',
      desc: '看中间，扔掉一半',
      detail: `中点写成 lo + (hi - lo) / 2。写成 (lo + hi) / 2 时，两个 int 相加可能溢出，这个错误在 Java 标准库里存在了多年才被发现。a[${first.mid}] = ${first.value} 比 ${HIT_TARGET} 小，所以它和它左边的元素都不可能是答案，一次比较排除了 ${first.mid + 1} 个。`,
      facts: [['mid', String(first.mid)], ['a[mid]', String(first.value)], ['排除', `${first.mid + 1} 个元素`], ['剩余', `${ARR.length - first.mid - 1} 个`]],
      events: steps[1],
    },
    {
      title: '继续折半并命中',
      desc: `一共比较 ${hit.probes} 次`,
      detail: `每次都在剩余区间上重复。这里第 ${hit.probes} 次比较命中，下标 ${hit.index}。比较次数和数组长度的对数相关，长度翻一倍只多比较一次。数组访问是 O(1) 这一点很关键，链表上这样做毫无意义。`,
      facts: [['比较次数', String(hit.probes)], ['下标', String(hit.index)], ['线性查找需要', `${hit.index + 1} 次比较`]],
      events: steps[2],
    },
    {
      title: '目标不存在',
      desc: `查 ${MISS_TARGET}：比较 ${miss.probes} 次后区间为空`,
      detail: `${MISS_TARGET} 不在数组里，区间不断缩小，直到 lo 等于 hi，共比较 ${miss.probes} 次，这也是 ${ARR.length} 个元素的最坏情况。此时 lo 正好是 ${MISS_TARGET} 应该插入的位置，标准库的 lower_bound 就是利用了这一点。`,
      facts: [['比较次数', String(miss.probes)], ['返回值', String(miss.index)], ['最坏上界', `⌊log₂ ${ARR.length}⌋ + 1 = ${maxProbes}`]],
      events: steps[3],
    },
  ],
  outro: {
    title: '排序之后才能二分',
    desc: '一次比较排除一半',
    text: '二分查找快，但要求数据有序，而且能按下标跳转。如果数据经常插入删除，维持有序数组要挪动元素，这时平衡树或哈希表更合适。如果只查不改，排好序的数组既省空间，缓存表现也好。',
    facts: [['最好', 'O(1)'], ['最坏', 'O(log n)'], ['下一课', 'BST']],
  },
};
