import { cString, cStruct, layoutOf, u32Var, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { rowAim } from '../scene/ds';
import { HEAP } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, DsMark, Lesson, LessonEvent, RowPrim, Tone } from './types';

export const FNV_OFFSET = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/** FNV-1a 32 位：每个字节先异或进低位，再乘 FNV 质数，模 2³²。 */
export function fnv1a32(text: string, onByte?: (index: number, byte: number, afterXor: number, afterMul: number) => void): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index++) {
    const byte = text.charCodeAt(index) & 0xff;
    const xored = (hash ^ byte) >>> 0;
    hash = Math.imul(xored, FNV_PRIME) >>> 0;
    onByte?.(index, byte, xored, hash);
  }
  return hash >>> 0;
}

export type SlotState = 'empty' | 'full' | 'tomb';

export interface Slot {
  state: SlotState;
  key: string;
  value: number;
  hash: number;
}

export interface ProbeHooks {
  probe?(index: number, slot: Slot, step: number): void;
}

/** 开放寻址哈希表，线性探测。删除时留墓碑，查找要越过墓碑继续走。 */
export class HashTable {
  slots: Slot[];
  /** 读键字节数、探测的槽数、比较键的次数、写槽的次数。 */
  bytes = 0;
  probes = 0;
  cmp = 0;
  writes = 0;

  constructor(readonly size: number) {
    this.slots = Array.from({ length: size }, () => ({ state: 'empty' as SlotState, key: '', value: 0, hash: 0 }));
  }

  get ops(): number {
    return this.bytes + this.probes + this.cmp + this.writes;
  }

  private hash(key: string, onByte?: Parameters<typeof fnv1a32>[1]): number {
    this.bytes += key.length;
    return fnv1a32(key, onByte);
  }

  /** 返回写入的槽位和探测次数。 */
  insert(key: string, value: number, hooks: ProbeHooks = {}, onByte?: Parameters<typeof fnv1a32>[1]): { index: number; probes: number } {
    const hash = this.hash(key, onByte);
    let reuse = -1;
    for (let step = 0; step < this.size; step++) {
      const index = (hash + step) & (this.size - 1);
      const slot = this.slots[index];
      this.probes++;
      if (slot.state === 'full') this.cmp++;
      hooks.probe?.(index, slot, step);
      if (slot.state === 'tomb') {
        if (reuse < 0) reuse = index;
        continue;
      }
      if (slot.state === 'full' && (slot.hash !== hash || slot.key !== key)) continue;
      const target = slot.state === 'full' ? index : reuse >= 0 ? reuse : index;
      this.slots[target] = { state: 'full', key, value, hash };
      this.writes++;
      return { index: target, probes: step + 1 };
    }
    if (reuse >= 0) {
      this.slots[reuse] = { state: 'full', key, value, hash };
      this.writes++;
      return { index: reuse, probes: this.size };
    }
    throw new Error('表已满');
  }

  find(key: string, hooks: ProbeHooks = {}): { index: number; probes: number; hash: number } {
    const hash = this.hash(key);
    for (let step = 0; step < this.size; step++) {
      const index = (hash + step) & (this.size - 1);
      const slot = this.slots[index];
      this.probes++;
      if (slot.state === 'full') this.cmp++;
      hooks.probe?.(index, slot, step);
      if (slot.state === 'empty') return { index: -1, probes: step + 1, hash };
      if (slot.state === 'full' && slot.hash === hash && slot.key === key) return { index, probes: step + 1, hash };
    }
    return { index: -1, probes: this.size, hash };
  }

  remove(key: string, hooks: ProbeHooks = {}): boolean {
    const found = this.find(key, hooks);
    if (found.index < 0) return false;
    this.slots[found.index] = { state: 'tomb', key: '', value: 0, hash: 0 };
    this.writes++;
    return true;
  }
}

const SLOT: CField[] = [['key', 'ptr'], ['value', 'int'], ['hash', 'uint32_t'], ['state', 'uint8_t']];
const STATE_CODE: Record<SlotState, number> = { empty: 0, full: 1, tomb: 2 };
export const SIZE = 8;
const INDEX_BITS = Math.log2(SIZE);
const MASK = SIZE - 1;
const SLOT_LAYOUT = layoutOf(SLOT);
const SLOT_PAD = SLOT_LAYOUT.pads.reduce((total, pad) => total + pad.size, 0);
/** 这些键落在哪一格完全由 FNV-1a 决定。步骤文案引用的冲突关系由 tests/narrative.test.ts 核对。 */
export const KEYS = { first: 'apple', direct: ['pear', 'plum'], collide: 'fig', noise: 'kiwi', wrap: 'mango', missing: 'lime' };

function build() {
  const table = new HashTable(SIZE);
  const steps: LessonEvent[][] = [[], [], [], [], [], []];
  let bucket = steps[0];
  const keyAddr = (key: string) => HEAP + BigInt(([...key].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 64) * 16);
  const rack = (lit: Record<number, Tone> = {}, lift: number[] = [], marks: DsMark[] = []): RowPrim => {
    const cells: DsCell[] = table.slots.map((slot, index) => ({
      v: slot.state === 'full' ? `${slot.key}: ${slot.value}` : slot.state === 'tomb' ? '墓碑' : '',
      tone: lit[index] ?? (slot.state === 'tomb' ? 'dim' : undefined),
      lift: lift.includes(index) || undefined,
    }));
    return { kind: 'row', id: 't', axis: 'y', w: 156, d: 36, cells, marks };
  };
  const slotBytes = (index: number) => {
    const slot = table.slots[index];
    return cStruct(`slot[${index}]`, SLOT, { key: slot.state === 'full' ? keyAddr(slot.key) : 0n, value: slot.value, hash: slot.hash, state: STATE_CODE[slot.state] }, {
      summary: `偏移 ${index} × 24 = ${index * 24}`,
      color: slot.state === 'full' ? 'blue' : 'slate',
      shown: { state: `${STATE_CODE[slot.state]}（${{ empty: '空', full: '已占用', tomb: '墓碑' }[slot.state]}）`, hash: hex(slot.hash, 8) },
      notes: { key: '指向键字符串。', value: 'int，4 字节。', hash: '缓存完整哈希值，比较键之前先比它，扩容时也不用重算。', state: 'uint8_t，1 字节。0 空，1 已占用，2 墓碑。' },
    });
  };

  const insertOne = (key: string, value: number, quick: boolean, detailBytes = false) => {
    const before = table.ops;
    let hash = 0;
    const byteEvents: LessonEvent[] = [];
    const result = table.insert(key, value, {
      probe(index, slot, step) {
        hash = fnv1a32(key);
        const home = hash & MASK;
        if (step === 0) {
          bucket.push(...byteEvents);
          bucket.push(state('hasher', { 键: key, h: hex(hash, 8), 下标: `h & ${MASK} = ${home}` }));
          bucket.push(pk('hasher', 'prog', 'violet', `h = ${hex(hash, 8)}`, [`h & ${MASK} = ${home}`], [before + key.length, 'HASH', `"${key}" 的 FNV-1a = ${hex(hash, 8)}，起始槽 ${home}`, 4],
            wire('哈希函数的结果', 'mem', 'abi', u32Var('h', hash, { note: `表大小是 ${SIZE}，取低 ${INDEX_BITS} 位：h & ${MASK} = ${home}。` })), { quick }));
        }
        const occupied = slot.state === 'full';
        const shown = rack({ [index]: occupied ? 'amber' : 'teal' }, [index], [{ at: index, text: step ? `探测 ${step}` : '起始', color: occupied ? 'amber' : 'teal' }]);
        bucket.push(pk('prog', 'table', occupied ? 'amber' : 'teal', `读 slot[${index}]`, occupied ? [`已被 "${slot.key}" 占用`] : ['空槽'], [table.ops, 'READ', occupied ? `slot[${index}] 是 "${slot.key}"，键不同，往后走一格` : `slot[${index}] 是空的，可以写入`, 24],
          wire(`槽数组，slot[${index}]`, 'mem', 'abi', slotBytes(index)), { quick, ds: { table: [shown] }, toAt: rowAim(shown, index) }));
      },
    }, detailBytes ? (index, byte, xored, after) => {
      byteEvents.push(pk('prog', 'hasher', 'violet', `'${key[index]}' = ${hex(byte, 2)}`, [`^ → ${hex(xored, 8)}`, `× → ${hex(after, 8)}`], [before + index + 1, 'HASH', `h ^= ${hex(byte, 2)} 得 ${hex(xored, 8)}；h *= 0x01000193 得 ${hex(after, 8)}`, 1],
        wire('键字符串和哈希状态', 'mem', 'abi', cString('key', key, { summary: `正在读第 ${index} 个字节` }), u32Var('h', after, { note: `这是处理完 '${key[index]}' 之后的值。` })), { quick: index > 0, ds: {} }));
      byteEvents.push(state('hasher', { 键: key.slice(0, index + 1), h: hex(after, 8) }));
    } : undefined);
    const shown = rack({ [result.index]: 'green' });
    bucket.push(pk('prog', 'table', 'green', `写 slot[${result.index}]`, [`${key}: ${value}`], [table.ops, 'WRITE', `写入 "${key}" = ${value}，探测 ${result.probes} 次`, 24],
      wire(`槽数组，slot[${result.index}]`, 'mem', 'abi', slotBytes(result.index)), { quick, ds: { table: [shown] }, toAt: rowAim(shown, result.index) }));
    return result;
  };

  const hashEvent = (key: string, label: string) => {
    const hash = fnv1a32(key);
    bucket.push(state('hasher', { 键: key, h: hex(hash, 8), 下标: `h & ${MASK} = ${hash & MASK}` }));
    bucket.push(pk('hasher', 'prog', 'violet', `h = ${hex(hash, 8)}`, [`起始槽 ${hash & MASK}`], [table.ops + key.length, 'HASH', `${label} "${key}"：起始槽 ${hash & MASK}`, 4],
      wire('哈希函数的结果', 'mem', 'abi', u32Var('h', hash)), { quick: true }));
  };
  const probeEvents = (key: string): ProbeHooks => ({
    probe(index, slot, step) {
      const tone: Tone = slot.state === 'full' ? (slot.key === key ? 'green' : 'amber') : slot.state === 'tomb' ? 'slate' : 'teal';
      const color = tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : tone === 'teal' ? 'teal' : 'slate';
      const shown = rack({ [index]: tone }, [index], [{ at: index, text: `第 ${step + 1} 次`, color }]);
      const text = slot.state === 'empty' ? '空槽：键不存在，停止' : slot.state === 'tomb' ? '墓碑：不能停，继续往后' : slot.key === key ? '键相同，找到了' : `"${slot.key}"：键不同，继续往后`;
      bucket.push(pk('prog', 'table', color, `读 slot[${index}]`, [text], [table.ops, slot.state === 'full' ? 'CMP' : 'READ', `slot[${index}] → ${text}`, 24],
        wire(`槽数组，slot[${index}]`, 'mem', 'abi', slotBytes(index)), { quick: true, ds: { table: [shown] }, toAt: rowAim(shown, index) }));
    },
  });
  const lookup = (key: string, label: string) => {
    hashEvent(key, label);
    return table.find(key, probeEvents(key));
  };

  // 第一个键：逐字节演示 FNV-1a
  const apple = insertOne(KEYS.first, 1, false, true);

  bucket = steps[1];
  const pear = insertOne(KEYS.direct[0], 2, true);
  const plum = insertOne(KEYS.direct[1], 3, true);

  bucket = steps[2];
  const fig = insertOne(KEYS.collide, 4, false);

  bucket = steps[3];
  insertOne(KEYS.noise, 5, true);
  const mango = insertOne(KEYS.wrap, 6, true);
  const load = table.slots.filter((slot) => slot.state === 'full').length;

  bucket = steps[4];
  const hit = lookup(KEYS.wrap, '查找');
  const miss = lookup(KEYS.missing, '查找');
  bucket.push({ type: 'ds', frame: { table: [rack()] } });

  bucket = steps[5];
  hashEvent(KEYS.collide, '删除');
  table.remove(KEYS.collide, probeEvents(KEYS.collide));
  const tombIndex = fig.index;
  const tombShown = rack({ [tombIndex]: 'slate' });
  bucket.push(pk('prog', 'table', 'slate', `删除 ${KEYS.collide}`, [`slot[${tombIndex}].state = 2`], [table.ops, 'WRITE', `把 slot[${tombIndex}] 标成墓碑，不能直接清空`, 1],
    wire(`槽数组，slot[${tombIndex}]`, 'mem', 'abi', slotBytes(tombIndex)), { ds: { table: [tombShown] }, toAt: rowAim(tombShown, tombIndex) }));
  const again = lookup(KEYS.wrap, '再查');
  bucket.push(note('table', `越过墓碑，仍然 ${again.probes} 次探测找到`, 'green'));
  bucket.push({ type: 'ds', frame: { table: [rack()] } });
  bucket.push(render);

  return { steps, table, apple, pear, plum, fig, mango, hit, miss, again, load };
}

const { steps, table, apple, pear, plum, fig, mango, hit, miss, again, load } = build();
export const hashRun = { apple, pear, plum, fig, mango, hit, miss, again };
const hashOf = (key: string) => fnv1a32(key);
const homeOf = (key: string) => hashOf(key) & MASK;
/** 探测经过的槽，按 (h + step) & mask 算出来。 */
const wrapPath = Array.from({ length: mango.probes }, (_, step) => (hashOf(KEYS.wrap) + step) & MASK);

export const hashtable: Lesson = {
  id: 'hashtable',
  name: 'HASH TABLE',
  title: '哈希表',
  group: 'linear',
  layer: [1, 3],
  complexity: { best: 'O(1)，起始槽就命中或就是空槽', worst: 'O(n)，所有键挤成一段，要探测整张表', note: '负载因子不高、哈希均匀时，平均接近 O(1)。' },
  opsUnit: '读键字节 + 探测槽 + 比较键 + 写槽',
  nodes: ['prog', 'hasher', 'table'],
  place: { prog: [140, 470], hasher: [420, 130], table: [670, 300] },
  labels: {
    prog: ['程序', 'insert / find / remove'],
    hasher: ['哈希函数', 'FNV-1a 32 位'],
    table: ['哈希槽', `struct slot[${SIZE}]，每个 ${SLOT_LAYOUT.size} 字节`],
  },
  labelAt: { table: [80, 190] },
  radius: { table: 90 },
  initial: { table: [{ kind: 'row', id: 't', axis: 'y', w: 156, d: 36, cells: Array.from({ length: SIZE }, () => ({ v: '' })) }] },
  start: ['prog', 'table'],
  legend: [['violet', '计算哈希'], ['teal', '空槽'], ['amber', '冲突'], ['green', '写入或命中'], ['slate', '墓碑'], [null, '操作数含读键字节']],
  overview: {
    full: '把键算成下标，直接跳到那一格',
    description: '哈希表用哈希函数把键变成数组下标，理想情况下一步到位。两个键落到同一格时就是冲突；开放寻址的做法是往后找下一个空位。这一课的哈希值全部由真实的 FNV-1a 算出，冲突也是这些键自己撞出来的，没有人为安排下标。',
    facts: [
      ['哈希函数', 'FNV-1a 32 位'],
      ['偏移基准', '0x811c9dc5'],
      ['FNV 质数', '0x01000193'],
      ['冲突处理', '线性探测'],
      ['struct slot', `${SLOT_LAYOUT.size} 字节，含 ${SLOT_PAD} 字节填充`],
      ['表大小', `${SIZE} 个槽`],
    ],
  },
  steps: [
    {
      title: '计算哈希',
      desc: `"${KEYS.first}" 算出下标 ${apple.index}`,
      detail: `从偏移基准开始，每个字节先异或进低位，再乘 FNV 质数，结果只留 32 位。先异或后乘是 FNV-1a 和 FNV-1 唯一的区别。表大小是 2 的幂，所以用 h & ${MASK} 取低 ${INDEX_BITS} 位当下标，不必做除法。`,
      facts: [[`"${KEYS.first}"`, hex(hashOf(KEYS.first), 8)], ['下标', String(apple.index)], ['读取字节', String(KEYS.first.length)]],
      events: [type('./hash'), show('hasher'), ...steps[0]],
    },
    {
      title: '直接落位',
      desc: '起始槽是空的，一次写入',
      detail: `"${KEYS.direct[0]}" 落在 ${pear.index}，"${KEYS.direct[1]}" 落在 ${plum.index}，分别探测 ${pear.probes} 次和 ${plum.probes} 次。这是哈希表 O(1) 的来源：不管表里有多少键，只要没有冲突，就只碰一个槽。比较键字符串本身才要花时间，所以结构里缓存了完整哈希值，可以先比它。`,
      facts: [[`"${KEYS.direct[0]}"`, `${hex(hashOf(KEYS.direct[0]), 8)} → ${pear.index}`], [`"${KEYS.direct[1]}"`, `${hex(hashOf(KEYS.direct[1]), 8)} → ${plum.index}`], ['探测次数', `${pear.probes} 次，${plum.probes} 次`]],
      events: steps[1],
    },
    {
      title: '发生冲突',
      desc: `"${KEYS.collide}" 也算到 ${homeOf(KEYS.collide)}，往后走 ${fig.probes - 1} 格`,
      detail: `"${KEYS.collide}" 的低 ${INDEX_BITS} 位和 "${KEYS.direct[0]}" 相同，起始槽已被占用，这就是冲突。线性探测的做法是看下一格，这里 slot[${fig.index}] 是空的，于是写进去，探测 ${fig.probes} 次。冲突的键不一定相同，所以每一格都要比较键。`,
      facts: [[`"${KEYS.collide}"`, hex(hashOf(KEYS.collide), 8)], ['起始槽', String(homeOf(KEYS.collide))], ['最终槽', String(fig.index)], ['探测次数', String(fig.probes)]],
      events: steps[2],
    },
    {
      title: '聚集与回绕',
      desc: `"${KEYS.wrap}" 探测 ${mango.probes} 次，绕回开头`,
      detail: `"${KEYS.wrap}" 也算到 ${wrapPath[0]}，这时 ${wrapPath.slice(0, -1).join('、')} 都被占了，只好走到末尾再绕回 ${wrapPath[wrapPath.length - 1]}，一共探测 ${mango.probes} 次，下标计算一直是 (h + step) & ${MASK}。占用的格子连成一片后，后来的键更容易撞上并让这一片变长，这就是线性探测的聚集问题。开放寻址表通常要控制负载因子，太满时扩容。`,
      facts: [[`"${KEYS.wrap}"`, hex(hashOf(KEYS.wrap), 8)], ['探测次数', String(mango.probes)], ['当前负载', `${load} / ${SIZE} = ${Math.round((load / SIZE) * 100)}%`]],
      events: steps[3],
    },
    {
      title: '查找',
      desc: '走和插入一样的路线，遇空槽停',
      detail: `查找沿着和插入相同的路线走：找 "${KEYS.wrap}" 用 ${hit.probes} 次探测命中。查一个不存在的 "${KEYS.missing}"，它的起始槽 ${miss.hash & MASK} 是空的，${miss.probes} 次就能确定不存在，因为如果它存在，当初插入时一定会占这一格。`,
      facts: [[`"${KEYS.wrap}"`, `${hit.probes} 次探测，命中`], [`"${KEYS.missing}"`, `${miss.probes} 次探测，不存在`], ['停止条件', '命中或遇到空槽']],
      events: steps[4],
    },
    {
      title: '删除留墓碑',
      desc: '不能清空，否则切断探测路线',
      detail: `如果把 "${KEYS.collide}" 的槽直接清空，再找 "${KEYS.wrap}" 走到这里就会误以为不存在。所以删除只把状态改成墓碑，查找遇到墓碑继续走，这次仍然 ${again.probes} 次探测命中。插入可以复用墓碑，但墓碑多了查找会变慢，最终要靠重建整张表来清理。`,
      facts: [[`slot[${fig.index}].state`, `${STATE_CODE.tomb}（墓碑）`], [`"${KEYS.wrap}"`, `${again.probes} 次探测，命中`], ['总操作数', String(table.ops)]],
      events: steps[5],
    },
  ],
  outro: {
    title: '平均很快，最坏很慢',
    desc: '好的哈希函数和不太满的表是前提',
    text: 'FNV-1a 简单快速，但不防恶意构造的冲突，面对不可信输入时要用带密钥的哈希函数。开放寻址把数据放在一块连续内存里，缓存表现好，代价是对负载因子敏感。常见的另一种做法是拉链法，每个槽挂一条链表。',
    facts: [['平均', '接近 O(1)'], ['最坏', 'O(n)'], ['下一课', 'BINARY SEARCH']],
  },
};
