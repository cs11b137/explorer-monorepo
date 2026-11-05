import { cStruct, intArray, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { ringAim } from '../scene/ds';
import { cellsOf, HEAP, STACK } from './common';
import { note, pk, render, state, type } from './dsl';
import type { DsMark, Lesson, LessonEvent, RingPrim, RowPrim, Tone } from './types';

/** 环形队列。head 和 tail 只增不减，下标用 x & (cap - 1) 算出来，所以容量必须是 2 的幂。 */
export class Ring {
  buf: Array<number | null>;
  head = 0;
  tail = 0;
  reads = 0;
  writes = 0;

  constructor(readonly cap: number) {
    if (cap <= 0 || (cap & (cap - 1)) !== 0) throw new Error('容量必须是 2 的幂');
    this.buf = new Array(cap).fill(null);
  }

  get count(): number {
    return (this.tail - this.head) >>> 0;
  }

  index(at: number): number {
    return at & (this.cap - 1);
  }

  enqueue(value: number): boolean {
    if (this.count === this.cap) return false;
    this.buf[this.index(this.tail)] = value;
    this.writes++;
    this.tail = (this.tail + 1) >>> 0;
    return true;
  }

  dequeue(): number | null {
    if (this.count === 0) return null;
    const value = this.buf[this.index(this.head)];
    this.reads++;
    this.head = (this.head + 1) >>> 0;
    return value;
  }
}

const RING: CField[] = [['buf', 'ptr'], ['cap', 'uint32_t'], ['head', 'uint32_t'], ['tail', 'uint32_t']];
export const CAP = 8;
export const FIRST_BATCH = [11, 22, 33, 44, 55, 66];
export const DEQUEUES = 3;
export const SECOND_BATCH = [77, 88, 99, 100, 110];
export const REJECTED = 120;
const RING_LAYOUT = layoutOf(RING);
const TAIL_PAD = RING_LAYOUT.pads[0].size;
const MASK = CAP - 1;

function build() {
  const ring = new Ring(CAP);
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => ring.reads + ring.writes;
  const prim = (lit: Record<number, Tone> = {}, lift: number[] = []): RingPrim => {
    const tones: Record<number, Tone> = {};
    for (let index = 0; index < CAP; index++) {
      if (ring.buf[index] !== null) tones[index] = 'dim';
    }
    for (let at = ring.head; at !== ring.tail; at = (at + 1) >>> 0) delete tones[ring.index(at)];
    const marks: DsMark[] = [{ at: ring.index(ring.head), text: 'head', color: 'amber' }, { at: ring.index(ring.tail), text: 'tail', color: 'teal' }];
    return { kind: 'ring', id: 'r', cells: cellsOf(ring.buf, { tones: { ...tones, ...lit }, lift }), marks };
  };
  const header = (lit?: number): RowPrim => ({
    kind: 'row', id: 'hdr', w: 58, cells: cellsOf([ring.head, ring.tail, ring.count], { subs: ['head', 'tail', 'count'], tones: lit === undefined ? {} : { [lit]: 'violet' } }),
  });
  const bytes = (notes: Record<number, string>, color: 'blue' | 'teal' | 'amber' = 'blue') => wire(`环形缓冲区，地址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi',
    cStruct('struct ring', RING, { buf: HEAP, cap: CAP, head: ring.head, tail: ring.tail }, { color: 'slate', summary: `地址 ${hex(STACK)}（E.G.）`, notes: { cap: '容量，必须是 2 的幂。', head: '下一个要读的位置，只增不减。', tail: '下一个要写的位置，只增不减。' } }),
    intArray('buf', ring.buf, { color, notes, summary: `下标 = 计数器 & ${CAP - 1}` }));

  const enqueue = (value: number, quick = true) => {
    const at = ring.index(ring.tail);
    const raw = ring.tail;
    if (!ring.enqueue(value)) throw new Error('队列已满');
    const shown = prim({ [at]: 'blue' }, [at]);
    bucket.push(state('prog', { head: String(ring.head), tail: String(ring.tail), 元素数: String(ring.count) }));
    bucket.push(pk('prog', 'queue', 'blue', `入队 ${value}`, [`buf[${raw} & ${CAP - 1}] = buf[${at}]`], [ops(), 'WRITE', `写 buf[${at}] = ${value}，tail 变成 ${ring.tail}`, 4],
      bytes({ [at]: '刚写入。' }), { quick, ds: { queue: [shown], stack: [header(1)] }, toAt: ringAim(shown, at) }));
  };
  const dequeue = (quick = true) => {
    const at = ring.index(ring.head);
    const raw = ring.head;
    const value = ring.dequeue();
    const shown = prim({ [at]: 'amber' }, [at]);
    bucket.push(state('prog', { head: String(ring.head), tail: String(ring.tail), 元素数: String(ring.count) }));
    bucket.push(pk('queue', 'prog', 'amber', `出队 ${value}`, [`buf[${raw} & ${CAP - 1}] = buf[${at}]`], [ops(), 'READ', `读 buf[${at}] = ${value}，head 变成 ${ring.head}。值还留在内存里`, 4],
      bytes({ [at]: '已经出队。这 4 个字节没有被清零，只是不再算队列的一部分。' }, 'amber'), { quick, ds: { queue: [shown], stack: [header(0)] }, fromAt: ringAim(shown, at) }));
  };

  // 初始化
  const first = prim();
  bucket.push(pk('prog', 'stack', 'violet', 'ring_init', ['head = tail = 0'], [0, 'WRITE', `cap = ${CAP}，head 和 tail 都是 0，队列为空`, 24],
    bytes({}), { ds: { queue: [first], stack: [header()] } }));

  // 入队
  bucket = steps[1];
  FIRST_BATCH.forEach((value, index) => enqueue(value, index > 0));
  const afterEnqueue = { head: ring.head, tail: ring.tail };

  // 出队
  bucket = steps[2];
  const out: Array<number | null> = [];
  for (let index = 0; index < DEQUEUES; index++) {
    out.push(ring.buf[ring.index(ring.head)]);
    dequeue(index > 0);
  }

  // 回绕
  bucket = steps[3];
  SECOND_BATCH.forEach((value, index) => enqueue(value, index > 0));
  const wrapped = { head: ring.head, tail: ring.tail };

  // 满
  bucket = steps[4];
  bucket.push(note('queue', `tail - head = ${ring.count}，队列已满`, 'amber'));
  const rejected = prim();
  const accepted = ring.enqueue(REJECTED);
  bucket.push(pk('prog', 'queue', 'amber', `入队 ${REJECTED}`, ['满了，返回 false'], [ops(), 'CMP', `tail - head == cap，入队失败，没有覆盖旧数据`, null],
    bytes({ [ring.index(ring.tail)]: 'tail 和 head 指向同一格。靠 tail - head 的差值才能分清是满还是空。' }), { lost: true, toAt: ringAim(rejected, ring.index(ring.tail)), ds: { queue: [rejected] } }));
  dequeue();
  bucket.push(render);
  return { steps, ring, afterEnqueue, wrapped, out, accepted };
}

const { steps, afterEnqueue, wrapped, out, accepted } = build();
export const ringRun = { wrapped, accepted };

export const ringqueue: Lesson = {
  id: 'ringqueue',
  name: 'RING QUEUE',
  title: '环形队列',
  group: 'linear',
  layer: [1, 1],
  complexity: { best: 'O(1)，入队只写一格', worst: 'O(1)，出队只读一格', note: '不移动元素，也不分配内存，代价是容量固定。' },
  opsUnit: '缓冲区元素的读写次数',
  nodes: ['prog', 'queue', 'stack'],
  place: { prog: [140, 470], queue: [550, 250], stack: [660, 530] },
  labels: {
    prog: ['程序', 'enqueue / dequeue'],
    queue: ['环形缓冲区', `int buf[${CAP}]`],
    stack: ['struct ring', `${RING_LAYOUT.size} 字节，尾部填充 ${TAIL_PAD} 字节`],
  },
  labelAt: { queue: [0, 6], stack: [-190, 22] },
  radius: { queue: 110, stack: 70 },
  initial: { queue: [{ kind: 'ring', id: 'r', cells: cellsOf(new Array(CAP).fill(null)), marks: [{ at: 0, text: 'head', color: 'amber' }, { at: 0, text: 'tail', color: 'teal' }] }], stack: [{ kind: 'row', id: 'hdr', w: 58, cells: cellsOf([0, 0, 0], { subs: ['head', 'tail', 'count'] }) }] },
  start: ['prog', 'queue', 'stack'],
  legend: [['blue', '入队'], ['amber', '出队'], ['violet', '初始化'], [null, '操作数：元素读写次数']],
  overview: {
    full: '首尾相接的定长数组，两端都是 O(1)',
    description: `用普通数组做队列，每次出队都要挪动所有元素，或者让空位越来越靠后。环形队列让下标走到末尾后回到开头，读写位置追着跑，元素完全不用动。这一课真实执行入队、出队、回绕和队满，图上的环就是 ${CAP} 格 int 数组。`,
    facts: [
      ['struct ring', `${RING_LAYOUT.size} 字节，含尾部填充`],
      ['容量', `${CAP}，必须是 2 的幂`],
      ['下标', '计数器 & (cap - 1)'],
      ['判满', 'tail - head == cap'],
      ['判空', 'tail == head'],
      ['入队出队', '都是 O(1)'],
    ],
  },
  steps: [
    {
      title: '初始化',
      desc: 'head 和 tail 都从 0 开始',
      detail: `head 是下一个要读的位置，tail 是下一个要写的位置，两者相等表示队列为空。struct ring 里指针占 ${RING_LAYOUT.fields[0].size} 字节，三个 uint32_t 占 ${RING_LAYOUT.fields.slice(1).reduce((total, field) => total + field.size, 0)} 字节，为了让结构大小是 ${RING_LAYOUT.align} 的倍数，尾部还有 ${TAIL_PAD} 字节填充。`,
      facts: [['head', String(new Ring(CAP).head)], ['tail', String(new Ring(CAP).tail)], ['结构大小', `${RING_LAYOUT.size} 字节`]],
      events: [type('./ring'), ...steps[0]],
    },
    {
      title: '入队',
      desc: '写到 tail 的位置，tail 加 1',
      detail: `连续写入 ${FIRST_BATCH.length} 个值后，head = ${afterEnqueue.head}，tail = ${afterEnqueue.tail}。下标用 tail & ${MASK} 算出来，这个按位与只在容量是 2 的幂时才等于取模，所以容量规定成 ${CAP}。每次入队只写一格，和队列里有多少元素无关。`,
      facts: [['head', String(afterEnqueue.head)], ['tail', String(afterEnqueue.tail)], ['元素数', String(afterEnqueue.tail - afterEnqueue.head)]],
      events: steps[1],
    },
    {
      title: '出队',
      desc: '读 head 的位置，head 加 1',
      detail: `先进先出，依次读到 ${out.join('、')}。出队只把 head 往前挪，数组里的值原样留着，图上变暗的格子就是这种「内存还在，但已不属于队列」的状态。检查器里能看到这些字节没有变。`,
      facts: [['读到', out.join(', ')], ['是否清零', '否'], ['移动元素', '0 个']],
      events: steps[2],
    },
    {
      title: '下标回绕',
      desc: `tail 超过 ${MASK} 后，下标回到 0`,
      detail: `继续入队 ${SECOND_BATCH.length} 个值，tail 涨到 ${wrapped.tail}，但下标是 ${wrapped.tail} & ${MASK} = ${wrapped.tail & MASK}，写入位置绕回了数组开头。head 和 tail 本身只增不减。uint32_t 溢出时按模 2³² 回绕，tail - head 仍然等于元素数，所以判满判空不受影响。`,
      facts: [['head', String(wrapped.head)], ['tail', String(wrapped.tail)], ['元素数', String(wrapped.tail - wrapped.head)]],
      events: steps[3],
    },
    {
      title: '队满',
      desc: 'tail 追上 head，入队失败',
      detail: `这时 head 和 tail 的下标都是 ${wrapped.head & MASK}，只看下标分不清是满还是空，所以要用计数器的差值来判断。这个实现选择拒绝写入并返回 false；有些日志类的缓冲区会选择覆盖最旧的数据，要看业务能否容忍丢失。`,
      facts: [['tail - head', String(CAP)], [`入队 ${REJECTED}`, '被拒绝，返回 false'], ['腾出空位', '先出队一个']],
      events: steps[4],
    },
  ],
  outro: {
    title: '定长换来常数时间',
    desc: '元素不动，只有两个计数器在走',
    text: '环形队列不分配内存，也不移动元素，所以时间完全可预测，常用在缓冲区这类场景。它的限制是容量固定，放不下时要由调用者决定等待、丢弃还是覆盖。',
    facts: [['时间', '入队出队都是 O(1)'], ['限制', '容量固定'], ['下一课', 'HASH TABLE']],
  },
};
