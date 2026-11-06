import { intArray, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim } from '../scene/ds';
import { cellsOf, HEAP, STACK } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, DsMark, Lesson, LessonEvent, RowPrim, Tone } from './types';

export interface RadixHooks {
  pass?(exp: number, a: number[]): void;
  count?(i: number, digit: number, count: number[]): void;
  prefix?(start: number[], totals: number[]): void;
  place?(i: number, digit: number, at: number, b: Array<number | null>, start: number[]): void;
  copied?(a: number[]): void;
}

export const BASE = 10;

/**
 * LSD 基数排序：从个位开始，每一趟按当前这一位做一次计数排序。
 * 计数排序先数每个数位出现几次，再算出每个数位在输出里的起始位置，最后从左往右把元素放过去。
 * 同一个数位的元素保持原来的先后，这个稳定性让低位排好的顺序在高位相同时保留下来。
 * 统计四种操作：计数、前缀和、放置、拷回，各算一次。只处理非负整数。
 */
export function radixSort(input: number[], hooks: RadixHooks = {}) {
  const a = [...input];
  const n = a.length;
  const b: Array<number | null> = new Array(n).fill(null);
  const max = Math.max(0, ...a);
  let counts = 0;
  let sums = 0;
  let places = 0;
  let copies = 0;
  let passes = 0;
  for (let exp = 1; Math.floor(max / exp) > 0; exp *= BASE) {
    passes++;
    hooks.pass?.(exp, a);
    const count: number[] = new Array(BASE).fill(0);
    for (let i = 0; i < n; i++) {
      const digit = Math.floor(a[i] / exp) % BASE;
      count[digit]++;
      counts++;
      hooks.count?.(i, digit, count);
    }
    const totals = [...count];
    let sum = 0;
    for (let digit = 0; digit < BASE; digit++) {
      const c = count[digit];
      count[digit] = sum;
      sum += c;
      sums++;
    }
    hooks.prefix?.(count, totals);
    for (let i = 0; i < n; i++) {
      const digit = Math.floor(a[i] / exp) % BASE;
      const at = count[digit]++;
      b[at] = a[i];
      places++;
      hooks.place?.(i, digit, at, b, count);
    }
    for (let i = 0; i < n; i++) {
      a[i] = b[i] as number;
      copies++;
    }
    hooks.copied?.(a);
  }
  return { sorted: a, passes, counts, sums, places, copies, cmp: 0 };
}

export const INPUT = [170, 45, 75, 90, 802, 24, 2, 66];
const W = 54;
const CW = 40;
const PLACE = ['个位', '十位', '百位', '千位'];

/** 每一趟的记录：数位、计数、起始位置和这一趟结束后的数组。文案从这里取值。 */
export interface PassLog {
  exp: number;
  digits: number[];
  totals: number[];
  start: number[];
  after: number[];
}

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  let aNow = [...INPUT];
  let bNow: Array<number | null> = new Array(INPUT.length).fill(null);
  let countNow: number[] = new Array(BASE).fill(0);
  let exp = 1;
  let passIndex = -1;
  const logs: PassLog[] = [];
  const digitOf = (value: number) => Math.floor(value / exp) % BASE;

  const aRow = (tones: Record<number, Tone> = {}, lift: number[] = [], marks: DsMark[] = []): RowPrim => ({
    kind: 'row', id: 'a', w: W, cells: cellsOf(aNow, { tones, lift, keys: aNow, subs: aNow.map((value) => `位 ${digitOf(value)}`) }), marks,
  });
  const countRow = (tones: Record<number, Tone> = {}, lift: number[] = []): RowPrim => ({ kind: 'row', id: 'c', w: CW, cells: cellsOf(countNow, { tones, lift }) });
  /** 这一趟已经写过的 b 格子。其余格子里是上一趟留下的旧值，画成浅色。 */
  const fresh = new Set<number>();
  const bRow = (tones: Record<number, Tone> = {}, lift: number[] = []): RowPrim => {
    const base: Record<number, Tone> = {};
    bNow.forEach((value, index) => {
      if (value !== null && !fresh.has(index)) base[index] = 'dim';
    });
    return { kind: 'row', id: 'b', w: W, cells: cellsOf(bNow, { tones: { ...base, ...tones }, lift }) };
  };
  const aBytes = (notes: Record<number, string>, color: Color = 'blue') => intArray('a', aNow, { color, notes, summary: `基址 ${hex(STACK)}（E.G.）` });
  const countBytes = (notes: Record<number, string>, color: Color = 'violet', summary = '下标就是数位') => intArray('count', countNow, { color, notes, summary });
  const bBytes = (notes: Record<number, string>, color: Color = 'green') => intArray('b', bNow, { color, notes, summary: `输出数组，基址 ${hex(HEAP)}（E.G.）` });
  const stepOfPass = () => (passIndex === 0 ? 0 : passIndex + 1);

  const result = radixSort(INPUT, {
    pass(value) {
      exp = value;
      passIndex++;
      bucket = steps[stepOfPass()];
      countNow = new Array(BASE).fill(0);
      fresh.clear();
      logs.push({ exp, digits: aNow.map(digitOf), totals: [], start: [], after: [] });
      bucket.push(state('prog', { 趟: `第 ${passIndex + 1} 趟`, 数位: PLACE[passIndex], exp: String(exp) }));
      if (passIndex > 0) bucket.push({ type: 'ds', frame: { array: [aRow()], table: [countRow()], aux: [bRow({}, [])] } });
    },
    count(i, digit, count) {
      countNow = [...count];
      ops++;
      const value = aNow[i];
      const shownA = aRow({ [i]: 'blue' }, [i], [{ at: i, text: 'i', color: 'blue' }]);
      const shownC = countRow({ [digit]: 'violet' }, [digit]);
      bucket.push(pk('array', 'table', 'violet', `count[${digit}]++`, [`${value} 的${PLACE[passIndex]}是 ${digit}`], [ops, 'WRITE', `a[${i}] = ${value}，(${value} / ${exp}) % ${BASE} = ${digit}，count[${digit}] 变成 ${count[digit]}`, 4],
        wire(`count 数组，基址 ${hex(STACK + 0x40n)}（E.G.）`, 'mem', 'abi', countBytes({ [digit]: `${PLACE[passIndex]}是 ${digit} 的元素已有 ${count[digit]} 个。` })), { quick: passIndex > 0 || i > 0, ds: { array: [shownA], table: [shownC] }, fromAt: rowAim(shownA, i), toAt: rowAim(shownC, digit) }));
    },
    prefix(start, totals) {
      bucket = steps[passIndex === 0 ? 1 : stepOfPass()];
      countNow = [...start];
      ops += BASE;
      const log = logs[logs.length - 1];
      log.totals = [...totals];
      log.start = [...start];
      const shown = countRow(Object.fromEntries(totals.map((value, digit) => [digit, value ? 'teal' : 'dim'])) as Record<number, Tone>);
      bucket.push(pk('prog', 'table', 'teal', '前缀和', [`起始位置 ${start.join(' ')}`], [ops, 'WRITE', `把个数换成起始位置：count[d] = 比 d 小的数位一共有几个，依次是 ${start.join(' ')}`, BASE * 4],
        wire('count 数组', 'mem', 'abi', countBytes(Object.fromEntries(start.map((value, digit) => [digit, totals[digit] ? `数位 ${digit} 有 ${totals[digit]} 个，从 b[${value}] 开始放。` : `没有数位 ${digit}。`])), 'teal', '现在存的是每个数位的起始位置')),
        { quick: passIndex > 0, ds: { table: [shown] }, toAt: rowAim(shown, 4.5) }));
    },
    place(i, digit, at, b, start) {
      bNow = [...b];
      fresh.add(at);
      countNow = [...start];
      ops++;
      const value = aNow[i];
      const shownA = aRow({ [i]: 'green' }, [i], [{ at: i, text: 'i', color: 'blue' }]);
      const shownB = bRow({ [at]: 'green' }, [at]);
      const shownC = countRow({ [digit]: 'teal' });
      bucket.push(pk('array', 'aux', 'green', `b[${at}] = ${value}`, [`数位 ${digit}，count[${digit}] 变成 ${start[digit]}`], [ops, 'WRITE', `a[${i}] = ${value} 的数位是 ${digit}，放到 b[count[${digit}]] = b[${at}]，count[${digit}] 加 1`, 4],
        wire('输出数组', 'mem', 'abi', bBytes({ [at]: `来自 a[${i}]。` })), { quick: true, ds: { array: [shownA], aux: [shownB], table: [shownC] }, fromAt: rowAim(shownA, i), toAt: rowAim(shownB, at) }));
    },
    copied(a) {
      aNow = [...a];
      ops += a.length;
      logs[logs.length - 1].after = [...a];
      const shownA = aRow(Object.fromEntries(a.map((_, index) => [index, 'teal'])) as Record<number, Tone>);
      const shownB = bRow();
      bucket.push(pk('aux', 'array', 'teal', '拷回 a', [a.join(' ')], [ops, 'WRITE', `把 b 整个拷回 a，第 ${passIndex + 1} 趟结束：${a.join(' ')}`, a.length * 4],
        wire('拷回之后的 a', 'mem', 'abi', aBytes({ 0: `按${PLACE[passIndex]}排好了，${PLACE[passIndex]}相同的保持上一趟的顺序。` }, 'teal')), { quick: passIndex > 0, ds: { array: [shownA], aux: [shownB] }, fromAt: rowAim(shownB, (a.length - 1) / 2), toAt: rowAim(shownA, (a.length - 1) / 2) }));
    },
  });
  bucket = steps[4];
  exp = 10 ** result.passes;
  const done = aRow(Object.fromEntries(result.sorted.map((_, index) => [index, 'green'])) as Record<number, Tone>);
  steps[4].push(state('prog', { 趟: `共 ${result.passes} 趟`, 数位: null, exp: null }));
  steps[4].push(note('array', `${result.passes} 趟，比较 0 次`, 'green'));
  steps[4].push({ type: 'ds', frame: { array: [done] } });
  steps[4].push(render);
  return { steps, result, logs, ops };
}

const { steps, result, logs, ops: totalOps } = build();
export const radixRun = { result, logs, ops: totalOps };
const [ones, tens, hundreds] = logs;
const n = INPUT.length;
/** 第二趟里十位相同、靠个位决定先后的一对：文案用它说明稳定性。 */
const tie = (() => {
  for (let x = 0; x < tens.after.length; x++) {
    for (let y = x + 1; y < tens.after.length; y++) {
      const p = tens.after[x];
      const q = tens.after[y];
      if (Math.floor(p / 10) % 10 === Math.floor(q / 10) % 10 && p % 10 !== q % 10) return [p, q];
    }
  }
  return [0, 0];
})();
const usedDigits = (log: PassLog) => log.totals.filter((value) => value > 0).length;

export const radixsort: Lesson = {
  id: 'radixsort',
  name: 'RADIX SORT',
  title: '基数排序',
  group: 'strategy',
  layer: [3, 3],
  complexity: { best: 'O(n)，严格说是 O(d(n + k))，d 是位数，k 是基数', worst: 'O(n)，严格说是 O(d(n + k))，和输入顺序无关', note: '位数 d 和基数 k 固定时是线性的。它不做比较，所以不受比较排序 n log n 下界的限制。' },
  opsUnit: '计数 + 前缀和 + 放置 + 拷回的次数',
  nodes: ['prog', 'array', 'table', 'aux'],
  place: { prog: [110, 330], array: [520, 120], table: [800, 430], aux: [430, 510] },
  labels: {
    prog: ['程序', 'radix_sort'],
    array: ['数组 a', `int a[${n}]，格子下面是当前数位`],
    table: ['计数', `int count[${BASE}]`],
    aux: ['输出 b', `int b[${n}]`],
  },
  labelAt: { array: [250, -40], table: [60, 110], aux: [-230, 70] },
  radius: { array: 50, table: 40, aux: 50 },
  initial: {
    array: [{ kind: 'row', id: 'a', w: W, cells: cellsOf(INPUT, { keys: INPUT, subs: INPUT.map((value) => `位 ${value % BASE}`) }) }],
    table: [{ kind: 'row', id: 'c', w: CW, cells: cellsOf(new Array(BASE).fill(0)) }],
    aux: [{ kind: 'row', id: 'b', w: W, cells: cellsOf(new Array(n).fill(null)) }],
  },
  start: ['prog', 'array', 'table'],
  legend: [['violet', '计数'], ['teal', '起始位置、拷回'], ['green', '放进输出'], [null, '操作数：计数 + 前缀和 + 放置 + 拷回']],
  overview: {
    full: '不比较大小，按数位一趟趟分配',
    description: `前面的排序都靠比较两个元素，最快也要 n log n 次比较。基数排序换了个办法：从个位开始，每一趟只看一位数字，把元素按这一位分到 ${BASE} 个位置上。这一课真实排序 ${n} 个最多 ${result.passes} 位的整数，每一趟都是一次计数排序，全程没有比较过两个元素的大小。`,
    facts: [
      ['方向', 'LSD，从最低位开始'],
      ['每一趟', '计数排序，必须稳定'],
      ['趟数', `${result.passes}，等于最大值的位数`],
      ['额外空间', `int count[${BASE}] + int b[${n}]`],
      ['比较次数', String(result.cmp)],
      ['时间', 'O(d(n + k))'],
    ],
  },
  steps: [
    {
      title: '按个位计数',
      desc: '数一数每个数位出现几次',
      detail: `第一趟只看个位：(a[i] / 1) % 10。每读一个元素，就把 count 里对应数位的格子加 1，读完一遍得到 ${ones.totals.join(' ')}。这里只读元素、写计数，元素还没有移动。`,
      facts: [['个位', ones.digits.join(' ')], ['计数', ones.totals.join(' ')], ['用到的数位', `${usedDigits(ones)} 个`]],
      events: [type(`./radix ${INPUT.join(' ')}`), ...steps[0]],
    },
    {
      title: '算位置，放进 b',
      desc: '前缀和给出每个数位的起点',
      detail: `把 count 换成前缀和：数位 d 的起点等于比 d 小的数位一共有几个，得到 ${ones.start.join(' ')}。然后从左往右，把每个元素放到 b[count[d]]，再把 count[d] 加 1。同一个数位的元素按原来的先后放进去，这就是稳定性，拷回 a 后是 ${ones.after.join(' ')}。`,
      facts: [['起始位置', ones.start.join(' ')], ['第 1 趟后', ones.after.join(' ')], ['稳定', '同数位保持原顺序']],
      events: [show('aux'), ...steps[1]],
    },
    {
      title: '按十位再来一趟',
      desc: `${PLACE[1]}相同的，个位顺序保留`,
      detail: `第二趟看十位，过程完全一样。${tie[0]} 和 ${tie[1]} 的十位相同，它们的先后沿用上一趟按个位排好的顺序，所以末两位已经有序：${tens.after.join(' ')}。如果这一趟不稳定，个位的成果就会被打乱。`,
      facts: [['十位', tens.digits.join(' ')], ['计数', tens.totals.join(' ')], ['第 2 趟后', tens.after.join(' ')]],
      events: steps[2],
    },
    {
      title: '最后看百位',
      desc: `${hundreds.totals[0]} 个数的百位是 0`,
      detail: `第三趟看百位，${hundreds.totals[0]} 个数的百位是 0，它们挤在同一个位置上，靠前两趟的顺序排好先后。只有 ${hundreds.after.filter((value) => value >= 100).join(' 和 ')} 的百位不是 0，被放到最后。最大值 ${Math.max(...INPUT)} 是三位数，所以三趟就够了。`,
      facts: [['百位', hundreds.digits.join(' ')], ['计数', hundreds.totals.join(' ')], ['第 3 趟后', hundreds.after.join(' ')]],
      events: steps[3],
    },
    {
      title: '排好了',
      desc: `${result.passes} 趟，0 次比较`,
      detail: `每一趟数 ${n} 次、算 ${BASE} 个前缀和、放 ${n} 次、拷回 ${n} 次，${result.passes} 趟一共 ${totalOps} 次操作。时间是 O(d(n + k))，位数 d 和基数 k 都固定时就是线性的。缺点是要一块和输入一样大的 b，而且只适合整数、定长字符串这类能拆成数位的键。`,
      facts: [['结果', result.sorted.join(' ')], ['每趟', `${n} + ${BASE} + ${n} + ${n} = ${3 * n + BASE}`], ['总操作数', String(totalOps)], ['比较', '0 次']],
      events: steps[4],
    },
  ],
  outro: {
    title: '绕开比较的下界',
    desc: '用键的结构换速度',
    text: '只靠比较的排序，最坏至少要约 n log₂ n 次比较。基数排序不比较，直接用数位当下标，所以能做到线性。基数可以取 256，一次处理一个字节，32 位整数四趟就排完。代价是额外的内存，以及对键的格式有要求。',
    facts: [['时间', 'O(d(n + k))'], ['空间', 'O(n + k)'], ['下一课', 'DP']],
  },
};
