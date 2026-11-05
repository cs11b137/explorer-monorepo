import { cString, intArray, returnReg, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim } from '../scene/ds';
import { cellsOf, HEAP } from './common';
import { note, pk, render, state, type } from './dsl';
import type { DsMark, Lesson, LessonEvent, RowPrim, Tone } from './types';

export interface LpsHooks {
  compare?(i: number, k: number, match: boolean, lps: number[]): void;
  write?(i: number, value: number, lps: number[]): void;
  fall?(k: number, next: number): void;
}

/** 失配表：lps[i] 是 p[0..i] 最长的「既是真前缀又是后缀」的长度。 */
export function buildLps(pattern: string, hooks: LpsHooks = {}): { lps: number[]; cmp: number } {
  const lps: number[] = new Array(pattern.length).fill(0);
  let cmp = 0;
  let k = 0;
  let i = 1;
  while (i < pattern.length) {
    cmp++;
    const match = pattern[i] === pattern[k];
    hooks.compare?.(i, k, match, lps);
    if (match) {
      k++;
      lps[i] = k;
      hooks.write?.(i, k, lps);
      i++;
    } else if (k > 0) {
      const next = lps[k - 1];
      hooks.fall?.(k, next);
      k = next;
    } else {
      lps[i] = 0;
      hooks.write?.(i, 0, lps);
      i++;
    }
  }
  return { lps, cmp };
}

export interface SearchHooks {
  compare?(i: number, j: number, match: boolean): void;
  jump?(i: number, j: number, next: number): void;
  found?(at: number, i: number, j: number): void;
}

/** KMP 匹配：文本下标 i 不回退，失配时只用 lps 调整模式下标 j。 */
export function kmpSearch(text: string, pattern: string, lps: number[], hooks: SearchHooks = {}): { matches: number[]; cmp: number } {
  const matches: number[] = [];
  let cmp = 0;
  let i = 0;
  let j = 0;
  while (i < text.length) {
    cmp++;
    const match = text[i] === pattern[j];
    hooks.compare?.(i, j, match);
    if (match) {
      i++;
      j++;
      if (j === pattern.length) {
        matches.push(i - j);
        hooks.found?.(i - j, i, j);
        j = lps[j - 1];
      }
    } else if (j > 0) {
      const next = lps[j - 1];
      hooks.jump?.(i, j, next);
      j = next;
    } else {
      i++;
    }
  }
  return { matches, cmp };
}

/** 暴力匹配的比较次数，用来对比。 */
export function naiveCompares(text: string, pattern: string): number {
  let cmp = 0;
  for (let start = 0; start + pattern.length <= text.length; start++) {
    for (let j = 0; j < pattern.length; j++) {
      cmp++;
      if (text[start + j] !== pattern[j]) break;
    }
  }
  return cmp;
}

export const TEXT = 'ABABDABABCABAB';
export const PATTERN = 'ABABC';
const W = 36;
const TEXT_CENTER = (TEXT.length - 1) / 2;

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  let lpsNow: Array<number | null> = [0, ...new Array(PATTERN.length - 1).fill(null)];
  let shift = 0;

  const textRow = (tones: Record<number, Tone> = {}, marks: DsMark[] = [], lift: number[] = []): RowPrim => ({ kind: 'row', id: 't', w: W, cells: cellsOf([...TEXT], { tones, lift }), marks });
  const patRow = (tones: Record<number, Tone> = {}, marks: DsMark[] = [], lift: number[] = [], at = shift): RowPrim => ({ kind: 'row', id: 'p', w: W, center: TEXT_CENTER - at, cells: cellsOf([...PATTERN], { tones, lift }), marks });
  const lpsRow = (tones: Record<number, Tone> = {}): RowPrim => ({ kind: 'row', id: 'l', w: 42, cells: cellsOf(lpsNow, { tones, subs: [...PATTERN].map((c, i) => `${c}${i}`) }) });
  const lpsBytes = (notes: Record<number, string> = {}) => intArray('lps', lpsNow, { color: 'violet', notes, summary: `基址 ${hex(HEAP)}（E.G.）` });
  const patBytes = () => cString('pattern', PATTERN, { color: 'teal' });
  const textBytes = () => cString('text', TEXT, { color: 'blue' });

  const built = buildLps(PATTERN, {
    compare(i, k, match) {
      ops++;
      const shown = patRow({ [i]: match ? 'green' : 'amber', [k]: match ? 'green' : 'amber' }, [{ at: i, text: 'i', color: 'blue' }, ...(k !== i ? [{ at: k, text: 'k', color: 'violet' as const }] : [])], [i]);
      bucket.push(state('prog', { i: String(i), k: String(k) }));
      bucket.push(pk('prog', 'pattern', match ? 'green' : 'amber', `p[${i}] == p[${k}] ?`, [`${PATTERN[i]} ${match ? '==' : '!='} ${PATTERN[k]}`], [ops, 'CMP', `建表：p[${i}] = ${PATTERN[i]} 和 p[${k}] = ${PATTERN[k]} 比较`, 2],
        wire('模式串', 'mem', 'abi', patBytes()), { quick: true, ds: { pattern: [shown] }, toAt: rowAim(shown, i) }));
    },
    write(i, value) {
      lpsNow[i] = value;
      const shown = lpsRow({ [i]: 'violet' });
      bucket.push(pk('prog', 'aux', 'violet', `lps[${i}] = ${value}`, [value ? `前后缀长 ${value}` : '没有相同前后缀'], [ops, 'WRITE', `p[0..${i}] 最长相同真前后缀的长度是 ${value}`, 4],
        wire('失配表', 'mem', 'abi', lpsBytes({ [i]: `p[0..${i}] = "${PATTERN.slice(0, i + 1)}"。` })), { quick: true, ds: { aux: [shown] }, toAt: rowAim(shown, i) }));
    },
  });
  const lps = built.lps;
  lpsNow = [...lps];

  let mismatches = 0;
  let firstJump = { i: 0, j: 0, next: 0 };
  bucket = steps[1];
  const matched = new Set<number>();
  const searched = kmpSearch(TEXT, PATTERN, lps, {
    compare(i, j, match) {
      ops++;
      shift = i - j;
      const textTones: Record<number, Tone> = {};
      const patTones: Record<number, Tone> = {};
      for (let index = 0; index < j; index++) {
        textTones[shift + index] = 'teal';
        patTones[index] = 'teal';
      }
      textTones[i] = match ? 'green' : 'amber';
      patTones[j] = match ? 'green' : 'amber';
      const textShown = textRow(textTones, [{ at: i, text: 'i', color: 'blue' }], [i]);
      const patShown = patRow(patTones, [{ at: j, text: 'j', color: 'violet' }], [j]);
      bucket.push(state('prog', { i: String(i), j: String(j), 比较: String(ops) }));
      bucket.push(pk('text', 'pattern', match ? 'green' : 'amber', `T[${i}] == P[${j}] ?`, [`${TEXT[i]} ${match ? '==' : '!='} ${PATTERN[j]}`], [ops, 'CMP', `text[${i}] = ${TEXT[i]}，pattern[${j}] = ${PATTERN[j]}：${match ? '相同，都前进' : j > 0 ? '不同，查失配表' : '不同，j 已经是 0，i 前进'}`, 2],
        wire('文本', 'mem', 'abi', textBytes(), patBytes()), { quick: true, ds: { text: [textShown], pattern: [patShown] }, fromAt: rowAim(textShown, i), toAt: rowAim(patShown, j) }));
    },
    jump(i, j, next) {
      mismatches++;
      if (mismatches === 1) firstJump = { i, j, next };
      if (!matched.size) bucket = steps[2];
      const newShift = i - next;
      shift = newShift;
      const shownLps = lpsRow({ [j - 1]: 'violet' });
      const patShown = patRow({}, [{ at: next, text: 'j', color: 'violet' }]);
      bucket.push(pk('aux', 'prog', 'violet', `lps[${j - 1}] = ${next}`, [`j: ${j} → ${next}`, `i 不动，仍是 ${i}`], [ops, 'READ', `已匹配的 ${j} 个字符里，有 ${next} 个前后缀重合，模式串右移 ${j - next} 格，i 不回退`, 4],
        wire('失配表', 'mem', 'abi', lpsBytes({ [j - 1]: `已匹配 "${PATTERN.slice(0, j)}"，它的前缀和后缀最多重合 ${next} 个字符。` })), { ds: { aux: [shownLps], pattern: [patShown] }, fromAt: rowAim(shownLps, j - 1) }));
    },
    found(at, i, j) {
      bucket = steps[3];
      for (let index = 0; index < j; index++) matched.add(at + index);
      const tones = Object.fromEntries([...matched].map((value) => [value, 'green'])) as Record<number, Tone>;
      const patTones = Object.fromEntries([...PATTERN].map((_, index) => [index, 'green'])) as Record<number, Tone>;
      const textShown = textRow(tones, [{ at, text: `命中 ${at}`, color: 'green' }]);
      const patShown = patRow(patTones);
      bucket.push(note('text', `在下标 ${at} 找到 ${PATTERN}`, 'green'));
      bucket.push(pk('pattern', 'prog', 'green', `命中 @${at}`, [`i = ${i}，j = ${j}`], [ops, 'RET', `j 走到模式串末尾，匹配位置 = i - j = ${at}`, 'reg'],
        wire('结果', 'regs', 'abi', returnReg('int kmp_search(const char *text, const char *pattern)', at, `匹配位置 ${at}。`)), { ds: { text: [textShown], pattern: [patShown] } }));
    },
  });
  const finalText = textRow(Object.fromEntries([...matched].map((value) => [value, 'green'])) as Record<number, Tone>);
  steps[4].push(note('prog', `比较 ${searched.cmp} 次，暴力 ${naiveCompares(TEXT, PATTERN)} 次`, 'green'));
  steps[4].push({ type: 'ds', frame: { text: [finalText], pattern: [patRow()], aux: [lpsRow()] } });
  steps[4].push(render);
  return { steps, built, searched, lps, mismatches, firstJump };
}

const { steps, built, searched, lps, mismatches, firstJump } = build();
export const kmpRun = { built, searched, lps, mismatches, firstJump };
const naive = naiveCompares(TEXT, PATTERN);
/** 例子用失配表里最长的那一项。 */
const exampleAt = lps.indexOf(Math.max(...lps));
const exampleText = PATTERN.slice(0, exampleAt + 1);
const exampleEdge = PATTERN.slice(0, lps[exampleAt]);
const matchedText = PATTERN.slice(0, firstJump.j);
const sharedText = PATTERN.slice(0, firstJump.next);

export const kmp: Lesson = {
  id: 'kmp',
  name: 'KMP',
  title: '字符串匹配',
  group: 'strategy',
  layer: [3, 3],
  complexity: { best: 'O(n + m)，建表 m、扫描 n 都要走一遍', worst: 'O(n + m)，文本下标从不回退，比较最多约 2n 次', note: 'n 是文本长度，m 是模式长度。' },
  opsUnit: '字符比较次数',
  nodes: ['prog', 'text', 'pattern', 'aux'],
  place: { prog: [120, 500], text: [530, 180], pattern: [460, 222], aux: [840, 470] },
  labels: {
    prog: ['程序', 'kmp_search'],
    text: ['文本', `char text[${TEXT.length + 1}]`],
    pattern: ['模式串', `char pattern[${PATTERN.length + 1}]`],
    aux: ['失配表 lps', `int lps[${PATTERN.length}]`],
  },
  labelAt: { text: [150, -46], pattern: [130, 200], aux: [0, 84] },
  radius: { text: 40, pattern: 40, aux: 50 },
  initial: {
    text: [{ kind: 'row', id: 't', w: W, cells: cellsOf([...TEXT]) }],
    pattern: [{ kind: 'row', id: 'p', w: W, center: TEXT_CENTER, cells: cellsOf([...PATTERN]) }],
    aux: [{ kind: 'row', id: 'l', w: 42, cells: cellsOf([0, null, null, null, null], { subs: [...PATTERN].map((c, i) => `${c}${i}`) }) }],
  },
  start: ['prog', 'text', 'pattern', 'aux'],
  legend: [['green', '字符相同'], ['amber', '字符不同'], ['violet', '失配表'], [null, '操作数：字符比较']],
  overview: {
    full: '失配时文本指针不回头',
    description: `暴力匹配失配后，要把文本指针退回去重新比。KMP 发现，已经匹配过的字符其实告诉了我们下一次该从哪里继续，文本指针完全不用回退。这一课真实构建失配表，再在 ${TEXT.length} 个字符的文本里找 ${PATTERN}，模式串滑动的每一格都是失配表算出来的。`,
    facts: [
      ['作者', 'Knuth、Morris、Pratt，1977 年'],
      ['建表', 'O(m)'],
      ['扫描', 'O(n)'],
      ['文本指针', '只进不退'],
      ['失配表', `${lps.join(' ')}`],
      ['操作数', '字符比较次数'],
    ],
  },
  steps: [
    {
      title: '构建失配表',
      desc: '模式串自己和自己比',
      detail: `lps[i] 是 p[0..i] 最长的既是真前缀又是后缀的长度。比如 ${exampleText} 的前缀 ${exampleEdge} 和后缀 ${exampleEdge} 相同，所以 lps[${exampleAt}] = ${lps[exampleAt]}。建表用模式串自己匹配自己，比较 ${built.cmp} 次，结果是 ${lps.join(' ')}。这个表只和模式串有关，和文本无关。`,
      facts: [['模式串', PATTERN], ['lps', lps.join(' ')], ['比较', `${built.cmp} 次`]],
      events: [type(`./kmp ${TEXT} ${PATTERN}`), ...steps[0]],
    },
    {
      title: '开始匹配',
      desc: 'i 和 j 一起前进',
      detail: `字符相同时 i 和 j 同时加 1。一共相同了 ${firstJump.j} 个字符，比到第 ${firstJump.j + 1} 个时不同。暴力做法这时要把 i 退回 ${firstJump.i - firstJump.j + 1} 重新开始，但前面比过的内容我们已经知道了，没必要再比一遍。`,
      facts: [['已匹配', matchedText], ['失配字符', `${TEXT[firstJump.i]} 和 ${PATTERN[firstJump.j]}`], ['i', String(firstJump.i)]],
      events: steps[1],
    },
    {
      title: '失配跳转',
      desc: 'i 不动，j 按表跳',
      detail: `已匹配的 ${matchedText} 的后缀 ${sharedText} 同时也是模式串的前缀，所以这 ${firstJump.next} 个字符不用重比，j 直接跳到 lps[${firstJump.j - 1}] = ${firstJump.next}，模式串整体右移 ${firstJump.j - firstJump.next} 格。如果跳完还是不同，就继续按表跳，j 为 0 时才让 i 前进。这次匹配一共跳了 ${mismatches} 次。`,
      facts: [['j', `${firstJump.j} → ${firstJump.next}`], ['模式串右移', `${firstJump.j - firstJump.next} 格`], ['跳转总数', String(mismatches)]],
      events: steps[2],
    },
    {
      title: '找到匹配',
      desc: `在下标 ${searched.matches[0]} 命中`,
      detail: `j 走到模式串末尾，说明完整匹配，位置是 i - j = ${searched.matches[0]}。代码随后让 j = lps[j-1] 继续扫描，这样能找到相互重叠的匹配。文本扫完后，这个例子只有 ${searched.matches.length} 处匹配。`,
      facts: [['位置', searched.matches.join(', ')], ['继续时 j', `lps[${PATTERN.length - 1}] = ${lps[PATTERN.length - 1]}`], ['扫描比较', `${searched.cmp} 次`]],
      events: steps[3],
    },
    {
      title: '比暴力省多少',
      desc: `${searched.cmp} 次比较，暴力 ${naive} 次`,
      detail: `同样的输入，KMP 扫描比较 ${searched.cmp} 次，暴力匹配比较 ${naive} 次。短文本差距不大，但暴力的最坏情况是 O(nm)，比如在全是 A 的文本里找 AAAB。KMP 的 i 只增不减，每次失配 j 至少减小一些，所以比较总数最多约 2n。`,
      facts: [['KMP 扫描', `${searched.cmp} 次`], ['暴力', `${naive} 次`], ['建表', `${built.cmp} 次`], ['最坏', 'O(n + m)，暴力 O(nm)']],
      events: steps[4],
    },
  ],
  outro: {
    title: '已知的信息不要丢',
    desc: '失配时也知道前面比过什么',
    text: 'KMP 的核心是把比较过程中得到的信息保存在失配表里。它不需要回退，所以很适合处理读一次就过去的数据流。实际的文本搜索工具常用别的算法，在平均情况下跳得更快，但 KMP 的最坏情况有保证。',
    facts: [['时间', 'O(n + m)'], ['额外空间', 'O(m)'], ['下一步', '全部 14 课到此结束']],
  },
};
