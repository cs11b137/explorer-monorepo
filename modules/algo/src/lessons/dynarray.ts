import { callRegs, cStruct, chunkHeader, chunkSize, intArray, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim as aim } from '../scene/ds';
import { cellsOf, HEAP, STACK } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsFrame, Lesson, LessonEvent, RowPrim } from './types';

export interface Vec {
  data: Array<number | null>;
  len: number;
  cap: number;
  /** 元素写入总数，含扩容时的拷贝。 */
  writes: number;
  copies: number;
  grows: number;
}

export interface VecHooks {
  grow?(oldCap: number, newCap: number, vec: Vec, next: Array<number | null>): void;
  copy?(index: number, vec: Vec, next: Array<number | null>): void;
  swapped?(oldCap: number, vec: Vec): void;
  write?(index: number, value: number, vec: Vec): void;
}

export const vecNew = (): Vec => ({ data: [], len: 0, cap: 0, writes: 0, copies: 0, grows: 0 });

/** vec_push：装满时容量翻倍，把旧元素逐个拷到新缓冲区，再释放旧缓冲区。 */
export function vecPush(vec: Vec, value: number, hooks: VecHooks = {}): void {
  if (vec.len === vec.cap) {
    const oldCap = vec.cap;
    const newCap = oldCap ? oldCap * 2 : 1;
    const next: Array<number | null> = new Array(newCap).fill(null);
    hooks.grow?.(oldCap, newCap, vec, next);
    for (let index = 0; index < vec.len; index++) {
      next[index] = vec.data[index];
      vec.writes++;
      vec.copies++;
      hooks.copy?.(index, vec, next);
    }
    vec.data = next;
    vec.cap = newCap;
    vec.grows++;
    hooks.swapped?.(oldCap, vec);
  }
  vec.data[vec.len] = value;
  vec.writes++;
  hooks.write?.(vec.len, value, vec);
  vec.len++;
}

const VEC: CField[] = [['data', 'ptr'], ['len', 'size_t'], ['cap', 'size_t']];
export const VALUES = [7, 3, 9, 1, 4, 8, 2, 6];
/** 第几次 push 开始下一个步骤。 */
const PHASES = [1, 3, 5];

const CENTER = 3.5;
const W = 56;

/** 每次 push 实际发生了什么。文案里的数字都从这里取。 */
export interface PushLog {
  no: number;
  copies: number;
  capBefore: number;
  capAfter: number;
  writes: number;
}

function build() {
  const vec = vecNew();
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let address = 0n;
  let nextAddress = HEAP;
  let pendingAddress = 0n;
  const mallocOf = (cap: number) => {
    const at = nextAddress;
    nextAddress += BigInt(chunkSize(cap * 4));
    return at;
  };
  const shortAddr = (value: bigint) => (value ? `…${value.toString(16).slice(-3)}` : 'NULL');
  const header = (lit?: number, addr = address): RowPrim => ({
    kind: 'row', id: 'vec', w: 64, cells: cellsOf([shortAddr(addr), vec.len, vec.cap], { subs: ['data', 'len', 'cap'], tones: lit === undefined ? {} : { [lit]: 'violet' } }),
  });
  const row = (id: string, values: Array<number | null>, tones: Record<number, 'blue' | 'green' | 'amber' | 'violet'> = {}, lift: number[] = []): RowPrim => ({
    kind: 'row', id, w: W, center: CENTER, cells: cellsOf(values, { tones, lift }),
  });
  const vecBytes = (addr: bigint) => cStruct('struct vec', VEC, { data: addr, len: vec.len, cap: vec.cap }, { summary: `v 在栈上，地址 ${hex(STACK)}`, notes: { data: '指向堆上的缓冲区。', len: '已用元素个数。', cap: '缓冲区能放多少个元素。' } });
  const frame = (patch: DsFrame) => patch;

  const log: PushLog[] = [];
  VALUES.forEach((value, pushIndex) => {
    const phase = PHASES.indexOf(pushIndex);
    if (phase >= 0) bucket = steps[phase + 1];
    const before = { copies: vec.copies, cap: vec.cap, writes: vec.writes };
    vecPush(vec, value, {
      grow(oldCap, newCap, current, next) {
        const bytes = newCap * 4;
        pendingAddress = mallocOf(newCap);
        const reason = oldCap ? `len == cap == ${oldCap}，装满了` : '还没有缓冲区';
        bucket.push(note('prog', reason, 'amber'));
        bucket.push(pk('prog', 'alloc', 'violet', `malloc(${bytes})`, [`容量 ${oldCap} → ${newCap}`], [current.writes, 'ALLOC', `申请 ${newCap} 个 int，共 ${bytes} 字节`, 'reg'],
          wire('进入 malloc 时的寄存器', 'regs', 'abi', callRegs('void *malloc(size_t size)', [['size', bytes]], 'violet'))));
        bucket.push(pk('alloc', 'prog', 'violet', '新地址', [hex(pendingAddress)], [current.writes, 'ALLOC', `返回 ${hex(pendingAddress)}，内容未初始化`, chunkSize(bytes)],
          wire('堆上新块的块头和用户区', 'mem', 'internal', chunkHeader(bytes), intArray('p', next, { color: 'blue', summary: `用户区地址 ${hex(pendingAddress)}（E.G.）` })),
          { ds: frame({ aux: [row('new', next)] }) }));
      },
      copy(index, current, next) {
        const tones = Object.fromEntries(next.map((_, i) => [i, 'green'])) as Record<number, 'green'>;
        for (let i = index + 1; i < next.length; i++) delete tones[i];
        const srcFrame = row('old', current.data, { [index]: 'amber' }, [index]);
        const dstFrame = row('new', next, tones);
        const srcAim = aim(row('old', current.data, {}, [index]), index);
        const dstAim = aim(dstFrame, index);
        bucket.push(pk('array', 'aux', 'green', `拷贝 [${index}]`, [`${next[index]}`], [current.writes, 'WRITE', `p[${index}] = data[${index}] = ${next[index]}`, 4],
          wire('新缓冲区，写入后的内容', 'mem', 'abi', intArray('p', next, { color: 'green', summary: `地址 ${hex(pendingAddress)}（E.G.）`, notes: { [index]: '刚从旧缓冲区拷过来。这就是扩容贵的原因。' } })),
          { quick: true, ds: frame({ array: [srcFrame], aux: [dstFrame] }), fromAt: srcAim, toAt: dstAim }));
      },
      swapped(oldCap, current) {
        const old = address;
        address = pendingAddress;
        if (old) {
          bucket.push(pk('prog', 'alloc', 'slate', `free(旧)`, [hex(old)], [current.writes, 'FREE', `释放旧缓冲区，${oldCap * 4} 字节还给分配器`, 'reg'],
            wire('进入 free 时的寄存器', 'regs', 'abi', callRegs('void free(void *ptr)', [['ptr', old, true]], 'slate')),
            { ds: frame({ array: [row('old', current.data)], aux: [] }) }));
        } else {
          bucket.push(pk('prog', 'stack', 'blue', '更新 v', [`data = ${shortAddr(address)}`, `cap = ${current.cap}`], [current.writes, 'WRITE', `v.data = ${hex(address)}，v.cap = ${current.cap}`, 16],
            wire('栈上的 struct vec', 'mem', 'abi', vecBytes(address)),
            { ds: frame({ array: [row('old', current.data)], aux: [], stack: [header(2)] }) }));
          return;
        }
        bucket.push(pk('prog', 'stack', 'blue', '更新 v', [`data = ${shortAddr(address)}`, `cap = ${current.cap}`], [current.writes, 'WRITE', `v.data = ${hex(address)}，v.cap = ${current.cap}`, 16],
          wire('栈上的 struct vec', 'mem', 'abi', vecBytes(address)),
          { ds: frame({ stack: [header(2)] }), quick: true }));
      },
      write(index, written, current) {
        const values = [...current.data];
        const shown = row('old', values, { [index]: 'blue' }, [index]);
        const expensive = current.len > 0 && current.len === current.cap / 2;
        bucket.push(state('prog', { len: String(current.len + 1), cap: String(current.cap), 写入: String(current.writes) }));
        bucket.push(pk('prog', 'array', 'blue', `data[${index}] = ${written}`, [expensive ? '扩容后写入' : '有空位，直接写'], [current.writes, 'WRITE', `写第 ${pushIndex + 1} 个元素：data[${index}] = ${written}`, 4],
          wire('堆上的 int 缓冲区', 'mem', 'abi', intArray('data', values, { summary: `地址 ${hex(address)}（E.G.）`, notes: { [index]: '偏移 = 下标 × sizeof(int) = 下标 × 4。' } })),
          { ds: frame({ array: [shown], stack: [{ ...header(1), cells: cellsOf([shortAddr(address), current.len + 1, current.cap], { subs: ['data', 'len', 'cap'], tones: { 1: 'blue' } }) }] }), toAt: aim(shown, index) }));
      },
    });
    log.push({ no: pushIndex + 1, copies: vec.copies - before.copies, capBefore: before.cap, capAfter: vec.cap, writes: vec.writes - before.writes });
  });

  const final = row('old', vec.data, Object.fromEntries(vec.data.map((_, i) => [i, 'green'])) as Record<number, 'green'>);
  steps[4].push(pk('prog', 'stack', 'green', 'v.len', [`${vec.len} 次 push`, `${vec.writes} 次写入`], [vec.writes, 'READ', `结算：${vec.len} 次 push，共写 ${vec.writes} 个元素，平均 ${(vec.writes / vec.len).toFixed(3)} 次`, 24],
    wire('全部 push 之后的 struct vec', 'mem', 'abi', vecBytes(address)),
    { ds: { array: [final], stack: [header()] } }));
  steps[4].push(render);
  return { vec, steps, log };
}

const { vec, steps, log } = build();
export const pushLog = log;
const firstPush = log[0];
const doubling = log.slice(PHASES[0], PHASES[1]);
const [cheapPush, growPush] = log.slice(PHASES[1], PHASES[2]);
const quiet = log.slice(PHASES[2]);
const sum = (items: number[]) => items.reduce((total, item) => total + item, 0);
const VEC_SIZE = layoutOf(VEC).size;
const emptyHeader: RowPrim = { kind: 'row', id: 'vec', w: 64, cells: cellsOf(['NULL', 0, 0], { subs: ['data', 'len', 'cap'] }) };

export const dynarray: Lesson = {
  id: 'dynarray',
  name: 'DYNAMIC ARRAY',
  title: '动态数组',
  group: 'linear',
  layer: [1, 3],
  complexity: { best: `O(1)，有空位时一次写入`, worst: `O(n)，装满时要拷贝全部元素`, note: `连续 n 次 push 的摊还代价是每次 O(1)。` },
  opsUnit: '元素写入次数，含扩容拷贝',
  nodes: ['prog', 'stack', 'array', 'aux', 'alloc'],
  place: { prog: [130, 520], stack: [780, 520], array: [520, 170], aux: [420, 320], alloc: [880, 180] },
  labels: {
    prog: ['程序', 'vec_push(&v, x)'],
    stack: ['struct vec v', `栈上，${VEC_SIZE} 字节`],
    array: ['数组 data', '堆上的 int 缓冲区'],
    aux: ['新缓冲区 p', '扩容时才有'],
    alloc: ['分配器', 'glibc malloc'],
  },
  labelAt: { stack: [0, 96], array: [215, -30], aux: [260, 30] },
  radius: { stack: 58, array: 40, aux: 40 },
  initial: { stack: [emptyHeader], array: [], aux: [] },
  start: ['prog', 'stack', 'array'],
  legend: [['blue', '写入元素'], ['violet', '申请内存'], ['green', '扩容拷贝'], ['slate', '释放'], [null, '操作数：元素写入次数']],
  overview: {
    full: '容量不够时自动翻倍的数组',
    description: `C 的数组大小一旦定下就不能变。动态数组用一个结构体记住缓冲区地址、已用长度和容量，装满时申请一块两倍大的新缓冲区，把旧元素拷过去。这一课真实执行 ${VALUES.length} 次 vec_push，你会看到为什么偶尔很贵的操作，平均下来仍然便宜。`,
    facts: [
      ['平台', 'C，x86-64 LP64，小端'],
      ['struct vec', `${VEC_SIZE} 字节：指针 + 两个 size_t`],
      ['扩容策略', `容量 × 2，从 ${firstPush.capAfter} 开始`],
      ['单次最坏', 'O(n)，拷贝全部元素'],
      ['摊还代价', '每次 O(1)'],
      ['操作数', '元素写入次数'],
    ],
  },
  steps: [
    {
      title: '第一次 push',
      desc: '没有缓冲区，先向分配器要',
      detail: `结构体刚清零时 data 是 NULL，len 和 cap 都是 0。len 等于 cap 就说明没有空位，于是申请 ${firstPush.capAfter} 个 int 的空间。malloc 只保证返回的地址对齐，不保证内容，所以新内存在检查器里显示为不确定的字节。`,
      facts: [['请求', `malloc(${firstPush.capAfter * 4})`], ['glibc 实际占用', `${chunkSize(firstPush.capAfter * 4)} 字节，这是它的最小块`], ['写入次数', String(firstPush.writes)]],
      events: [type(`./vec ${VALUES.join(' ')}`), show('alloc', 'aux'), ...steps[0]],
    },
    {
      title: '装满就翻倍',
      desc: `容量 ${[firstPush.capAfter, ...doubling.map((item) => item.capAfter)].join(' → ')}，旧元素全部拷贝`,
      detail: `每次装满都要做三件事：申请两倍大的新块，把旧元素逐个拷过去，释放旧块。拷贝不可省略，因为旧块后面的内存可能已经被别人占用，数组又必须连续。容量是 ${doubling.map((item) => item.capBefore).join(' 和 ')} 时各拷了 ${doubling.map((item) => item.copies).join(' 和 ')} 个元素。`,
      facts: [['本步写入', `${doubling.length} 次 push + ${sum(doubling.map((item) => item.copies))} 次拷贝`], ['为什么要拷贝', '数组必须连续'], ['旧指针', 'free 后不能再用']],
      events: steps[1],
    },
    {
      title: '拷贝越来越长',
      desc: `第 ${growPush.no} 次 push 拷贝 ${growPush.copies} 个元素`,
      detail: `容量到 ${cheapPush.capBefore} 之后，第 ${cheapPush.no} 次 push 有空位，只写 ${cheapPush.writes} 次。第 ${growPush.no} 次又装满了，这回要拷 ${growPush.copies} 个元素。元素越多，单次扩容越贵，这就是最坏情况 O(n) 的来源。`,
      facts: [[`第 ${cheapPush.no} 次 push`, `${cheapPush.writes} 次写入`], [`第 ${growPush.no} 次 push`, `${growPush.copies} 次拷贝 + ${growPush.writes - growPush.copies} 次写入`], ['新容量', String(growPush.capAfter)]],
      events: steps[2],
    },
    {
      title: '便宜的 push',
      desc: '有空位时只写一次',
      detail: `容量翻倍后留出了等量的空位，接下来几次 push 不需要拷贝，也不碰分配器。写入位置靠 data + len × 4 直接算出来，所以和数组多长无关，这是 O(1) 的来源。`,
      facts: [[`第 ${quiet[0].no}–${quiet[quiet.length - 1].no} 次 push`, `每次 ${quiet[0].writes} 次写入`], ['分配器调用', `${quiet.filter((item) => item.capAfter !== item.capBefore).length} 次`], ['元素偏移', '下标 × 4 字节']],
      events: steps[3],
    },
    {
      title: '摊还结算',
      desc: `${vec.len} 次 push，共 ${vec.writes} 次写入`,
      detail: `这段代码实际统计到 ${vec.writes} 次写入：${vec.len} 次是新元素，${vec.copies} 次是拷贝。拷贝数是 ${log.filter((item) => item.copies).map((item) => item.copies).join(' + ')} 这样的等比数列，总和小于最终元素数，所以平均每次 push 的写入少于 3 次。这种把偶发高代价摊到每次操作上的算法，叫摊还分析。`,
      facts: [['新元素写入', String(vec.len)], ['拷贝写入', String(vec.copies)], ['平均每次', `${(vec.writes / vec.len).toFixed(3)} 次写入`], ['上界', '每次少于 3 次']],
      events: steps[4],
    },
  ],
  outro: {
    title: '偶尔很贵，平均便宜',
    desc: '翻倍让拷贝总量保持线性',
    text: '如果每次只多加固定的几格，拷贝总量会变成 O(n²)。按比例增长才能把摊还代价压到 O(1)。libstdc++ 的 vector 也按翻倍增长：它的 _M_check_len 把增量取为至少当前大小。真实代码还常用 realloc，它有时能原地扩大，省掉拷贝。',
    facts: [['关键', '按比例增长'], ['代价', '最多浪费约一半空间'], ['下一课', 'LINKED LIST']],
  },
};
