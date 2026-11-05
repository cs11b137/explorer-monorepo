import { intArray, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim } from '../scene/ds';
import { cellsOf, heapPoint, HEAP } from './common';
import { note, pk, render, state, type } from './dsl';
import type { DsFrame, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

export interface HeapHooks {
  placed?(index: number, a: number[]): void;
  compare?(parent: number, child: number, a: number[]): void;
  swap?(x: number, y: number, a: number[]): void;
  moved?(index: number, a: number[]): void;
}

/** 最小堆。数组就是树：下标 i 的子节点是 2i+1 和 2i+2，父节点是 (i-1)/2。 */
export class MinHeap {
  a: number[] = [];
  cmp = 0;
  swaps = 0;

  push(value: number, hooks: HeapHooks = {}): void {
    this.a.push(value);
    let index = this.a.length - 1;
    hooks.placed?.(index, this.a);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      this.cmp++;
      hooks.compare?.(parent, index, this.a);
      if (this.a[parent] <= this.a[index]) break;
      [this.a[parent], this.a[index]] = [this.a[index], this.a[parent]];
      this.swaps++;
      hooks.swap?.(parent, index, this.a);
      index = parent;
    }
  }

  pop(hooks: HeapHooks = {}): number {
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      hooks.moved?.(0, this.a);
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.a.length) {
          this.cmp++;
          hooks.compare?.(smallest, left, this.a);
          if (this.a[left] < this.a[smallest]) smallest = left;
        }
        if (right < this.a.length) {
          this.cmp++;
          hooks.compare?.(smallest, right, this.a);
          if (this.a[right] < this.a[smallest]) smallest = right;
        }
        if (smallest === index) break;
        [this.a[smallest], this.a[index]] = [this.a[index], this.a[smallest]];
        this.swaps++;
        hooks.swap?.(index, smallest, this.a);
        index = smallest;
      }
    }
    return top;
  }
}

export const BUILD = [9, 4, 7, 1, 8, 5];
export const PUSHED = 0;
const SLOTS = BUILD.length + 1;
const W = 54;

function build() {
  const heap = new MinHeap();
  BUILD.forEach((value) => heap.push(value));
  const initialValues = [...heap.a];
  const initialCmp = heap.cmp;
  heap.cmp = 0;
  heap.swaps = 0;
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => heap.cmp + heap.swaps;
  // 每个值一个身份，交换时节点和格子跟着移动。这组值互不相同，用值本身就够。
  const views = (a: number[], tones: Record<number, Tone> = {}, lift: number[] = []): { tree: GraphPrim; row: RowPrim; frame: DsFrame } => {
    const nodes: GraphNode[] = a.map((value, index) => ({ id: String(value), ...heapPoint(index), v: String(value), sub: `[${index}]`, tone: tones[index], lift: lift.includes(index) || undefined }));
    const edges: GraphEdge[] = a.slice(1).map((value, offset) => ({ a: String(a[Math.floor(offset / 2)]), b: String(value), tone: tones[offset + 1] && tones[Math.floor(offset / 2)] ? tones[offset + 1] : undefined }));
    const tree: GraphPrim = { kind: 'graph', id: 'h', nodes, edges, r: 24 };
    const row: RowPrim = { kind: 'row', id: 'a', w: W, center: (SLOTS - 1) / 2, cells: cellsOf([...a, ...new Array(Math.max(0, SLOTS - a.length)).fill(null)], { keys: [...a, ...new Array(Math.max(0, SLOTS - a.length)).fill(0).map((_, i) => `x${i}`)], tones, lift }) };
    return { tree, row, frame: { tree: [tree], array: [row] } };
  };
  const bytes = (a: number[], notes: Record<number, string>) => wire(`堆数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', intArray('h', a, { notes, summary: `当前 ${a.length} 个元素` }));

  // 数组就是树
  const start = views(initialValues, { 0: 'green' });
  bucket.push(pk('prog', 'array', 'green', '读 h[0]', [`最小值 = ${initialValues[0]}`], [0, 'READ', `堆顶 h[0] = ${initialValues[0]} 就是最小值，读它只要一次访问`, 4],
    bytes(initialValues, { 0: '堆顶。父节点总不大于子节点，所以最小值一定在这里。', 1: '子节点下标 2×0+1。', 2: '子节点下标 2×0+2。' }), { ds: start.frame, toAt: rowAim(start.row, 0) }));

  // push 到尾部
  bucket = steps[1];
  const hooks: HeapHooks = {
    placed(index, a) {
      const shown = views(a, { [index]: 'blue' }, [index]);
      bucket.push(pk('prog', 'array', 'blue', `h[${index}] = ${a[index]}`, ['先放到数组末尾'], [ops(), 'WRITE', `push(${a[index]})：写到下标 ${index}，这是树最底层下一个空位`, 4],
        bytes(a, { [index]: '新元素。树的形状仍然完全，但堆序可能被破坏。' }), { ds: shown.frame, toAt: rowAim(shown.row, index) }));
      bucket = steps[2];
    },
    compare(parent, child, a) {
      const shown = views(a, { [parent]: 'amber', [child]: 'blue' }, [child]);
      const ok = a[parent] <= a[child];
      bucket.push(state('prog', { 子: `h[${child}] = ${a[child]}`, 父: `h[${parent}] = ${a[parent]}` }));
      bucket.push(pk('prog', 'tree', ok ? 'green' : 'blue', `${a[child]} < ${a[parent]} ?`, [ok ? '不小于父节点，停止' : '比父节点小，上浮'], [ops(), 'CMP', `子 h[${child}] = ${a[child]} 和父 h[${parent}] = ${a[parent]} 比较`, 8],
        bytes(a, { [parent]: `父节点，下标 (${child}-1)/2 = ${parent}。`, [child]: '子节点。' }), { quick: true, ds: shown.frame, toAt: graphAim(shown.tree, String(a[child])) }));
    },
    swap(parent, child, a) {
      const shown = views(a, { [parent]: 'violet', [child]: 'violet' });
      bucket.push(pk('prog', 'array', 'violet', `交换 [${parent}] ↔ [${child}]`, [`${a[parent]} ↔ ${a[child]}`], [ops(), 'SWAP', `h[${parent}] ↔ h[${child}]，小的往上走一层`, 8],
        bytes(a, { [parent]: '交换后。', [child]: '交换后。' }), { quick: true, ds: shown.frame, toAt: rowAim(shown.row, parent) }));
    },
  };
  heap.push(PUSHED, hooks);
  const pushCmp = heap.cmp;
  const pushSwaps = heap.swaps;
  const pushed = [...heap.a];
  steps[2].push(state('prog', { 子: null, 父: null }));

  // pop
  bucket = steps[3];
  const beforePop = { cmp: heap.cmp, swaps: heap.swaps };
  const top = pushed[0];
  const take = views(pushed, { 0: 'green' }, [0]);
  bucket.push(pk('array', 'prog', 'green', `pop → ${top}`, ['取走堆顶'], [ops(), 'READ', `取出 h[0] = ${top}`, 4],
    bytes(pushed, { 0: '要返回的最小值。' }), { ds: take.frame, fromAt: rowAim(take.row, 0) }));
  const popped = heap.pop({
    moved(index, a) {
      const shown = views(a, { [index]: 'amber' }, [index]);
      bucket.push(pk('prog', 'array', 'amber', `h[0] = ${a[index]}`, ['末尾元素补到堆顶'], [ops(), 'WRITE', `把最后一个元素 ${a[index]} 搬到堆顶，长度减 1，树的形状保持完全`, 4],
        bytes(a, { 0: '刚搬上来，大概率比子节点大。' }), { ds: shown.frame, toAt: rowAim(shown.row, 0) }));
      bucket = steps[4];
    },
    compare(current, child, a) {
      const shown = views(a, { [current]: 'amber', [child]: 'blue' }, [child]);
      bucket.push(pk('prog', 'tree', 'blue', `${a[child]} < ${a[current]} ?`, ['找更小的子节点'], [ops(), 'CMP', `h[${child}] = ${a[child]} 和 h[${current}] = ${a[current]} 比较`, 8],
        bytes(a, { [current]: '目前较小的那个。', [child]: '正在比较。' }), { quick: true, ds: shown.frame, toAt: graphAim(shown.tree, String(a[child])) }));
    },
    swap(index, smallest, a) {
      const shown = views(a, { [index]: 'violet', [smallest]: 'violet' });
      bucket.push(pk('prog', 'array', 'violet', `交换 [${index}] ↔ [${smallest}]`, [`${a[index]} ↔ ${a[smallest]}`], [ops(), 'SWAP', `h[${index}] ↔ h[${smallest}]，大的往下沉一层`, 8],
        bytes(a, { [index]: '交换后。', [smallest]: '交换后。' }), { quick: true, ds: shown.frame, toAt: rowAim(shown.row, smallest) }));
    },
  });
  const done = views(heap.a);
  steps[4].push(note('tree', `堆序恢复，新的堆顶是 ${heap.a[0]}`, 'green'));
  steps[4].push({ type: 'ds', frame: done.frame });
  steps[4].push(render);
  return { steps, heap, initialValues, initialCmp, pushCmp, pushSwaps, pushed, popped, popCmp: heap.cmp - beforePop.cmp, popSwaps: heap.swaps - beforePop.swaps };
}

const { steps, heap: finalHeap, initialValues, pushCmp, pushSwaps, pushed, popped, popCmp, popSwaps } = build();
export const heapRun = { initialValues, pushed, popped, pushCmp, pushSwaps, popCmp, popSwaps };

function initialFrame(): DsFrame {
  const nodes: GraphNode[] = initialValues.map((value, index) => ({ id: String(value), ...heapPoint(index), v: String(value), sub: `[${index}]` }));
  const edges: GraphEdge[] = initialValues.slice(1).map((value, offset) => ({ a: String(initialValues[Math.floor(offset / 2)]), b: String(value) }));
  return {
    tree: [{ kind: 'graph', id: 'h', nodes, edges, r: 24 }],
    array: [{ kind: 'row', id: 'a', w: W, center: (SLOTS - 1) / 2, cells: cellsOf([...initialValues, null], { keys: [...initialValues, 'x0'] }) }],
  };
}

export const heap: Lesson = {
  id: 'heap',
  name: 'BINARY HEAP',
  title: '二叉堆',
  group: 'tree',
  layer: [1, 2],
  complexity: { best: 'O(1)，push 的元素不比父节点小，读堆顶也是 O(1)', worst: 'O(log n)，push 上浮或 pop 下沉走完整棵树的高度', note: 'pop 总要下沉，平均和最坏都是 O(log n)。' },
  opsUnit: '比较次数 + 交换次数',
  nodes: ['prog', 'tree', 'array'],
  place: { prog: [110, 420], tree: [560, 70], array: [610, 450] },
  labels: {
    prog: ['程序', 'push / pop'],
    tree: ['逻辑上的树', '不占额外内存，靠下标算'],
    array: ['真实内存', `int h[${pushed.length}]`],
  },
  labelAt: { tree: [-340, -10], array: [-210, 70] },
  radius: { array: 56, tree: 80 },
  initial: initialFrame(),
  start: ['prog', 'tree', 'array'],
  legend: [['blue', '比较'], ['violet', '交换'], ['amber', '补到堆顶'], ['green', '取最小值'], [null, '操作数：比较 + 交换']],
  overview: {
    full: '用数组存的完全二叉树，堆顶总是最小',
    description: '二叉堆的树只存在于下标运算里，内存中就是一个普通数组，不需要任何指针。父节点不大于子节点，所以最小值永远在下标 0。这一课真实执行一次 push 和一次 pop，上面是树的样子，下面是同一份数据的内存布局，两者同时变化。',
    facts: [
      ['发明', 'J. W. J. Williams，1964 年'],
      ['左子节点', '2i + 1'],
      ['右子节点', '2i + 2'],
      ['父节点', '⌊(i - 1) / 2⌋'],
      ['读最小值', 'O(1)'],
      ['push / pop', '最坏 O(log n)'],
    ],
  },
  steps: [
    {
      title: '数组就是树',
      desc: '下标运算代替指针',
      detail: `依次 push ${BUILD.join('、')} 后，数组是 ${initialValues.join(' ')}。下标 0 是根，下标 i 的子节点在 2i+1 和 2i+2。树从上到下、从左到右填满，所以数组中间没有空洞，也不用存指针。`,
      facts: [['数组', initialValues.join(' ')], ['堆序', '父节点 ≤ 子节点'], ['指针', '0 个']],
      events: [type('./heap'), ...steps[0]],
    },
    {
      title: 'push：放到末尾',
      desc: '先保形状，再修顺序',
      detail: '新元素写到数组末尾，也就是树最底层的下一个空位。这样树的形状仍然完全，只是新元素可能比父节点小，破坏了堆序。接下来只需要修这一条从新元素到根的路径。',
      facts: [['push', String(PUSHED)], ['写入下标', String(initialValues.length)], ['父节点下标', String(Math.floor((initialValues.length - 1) / 2))]],
      events: steps[1],
    },
    {
      title: '上浮',
      desc: '比父节点小就交换',
      detail: `新元素和父节点比较，更小就交换，再和新的父节点比较。${PUSHED} 比路径上所有元素都小，一路走到了根，这里比较 ${pushCmp} 次，交换 ${pushSwaps} 次。树高是 log n，所以最坏情况也只走 log n 层。`,
      facts: [['比较', String(pushCmp)], ['交换', String(pushSwaps)], ['结果', pushed.join(' ')]],
      events: steps[2],
    },
    {
      title: 'pop：补到堆顶',
      desc: '取走最小值，末尾元素补上',
      detail: `h[0] = ${popped} 就是要返回的值。堆顶空了，直接把最后一个元素搬上来，这样数组仍然连续、树仍然完全。如果把子节点逐层提上来，最底层就可能留下空洞，数组不再对应完全二叉树。`,
      facts: [['返回', String(popped)], ['搬上来的值', String(pushed[pushed.length - 1])], ['长度', `${pushed.length} → ${pushed.length - 1}`]],
      events: steps[3],
    },
    {
      title: '下沉',
      desc: '和较小的子节点交换',
      detail: `每层要比较两次，找出父节点和两个子节点中最小的。必须和较小的那个交换，否则新的父节点会比另一个子节点大。这次 pop 比较 ${popCmp} 次，交换 ${popSwaps} 次，最终数组是 ${finalHeap.a.join(' ')}。`,
      facts: [['比较', String(popCmp)], ['交换', String(popSwaps)], ['结果', finalHeap.a.join(' ')], ['下一个堆顶', String(finalHeap.a[0])]],
      events: steps[4],
    },
  ],
  outro: {
    title: '部分有序就够了',
    desc: '只保证堆顶最小，所以维护便宜',
    text: '堆只维护父子之间的顺序，兄弟之间没有要求，这比完全排序省很多工作。一个一个 push 建堆是 O(n log n)；Floyd 的方法从最底层开始下沉，只要 O(n)。优先队列通常就是用二叉堆实现的，后面的 Dijkstra 课会用到它。',
    facts: [['读堆顶', 'O(1)'], ['push / pop', 'O(log n)'], ['下一课', 'AVL TREE']],
  },
};
