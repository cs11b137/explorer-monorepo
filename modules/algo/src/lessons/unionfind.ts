import { intArray, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim } from '../scene/ds';
import { cellsOf, HEAP } from './common';
import { note, pk, render, state, type } from './dsl';
import type { Color, DsFrame, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

export interface UfHooks {
  read?(index: number, parent: number): void;
  compress?(index: number, root: number): void;
  attach?(child: number, root: number): void;
}

/** 并查集：按大小合并，查找时做路径压缩。reads 统计查根时读 parent 的次数，writes 统计写 parent 和 size 的次数。 */
export class UnionFind {
  parent: number[];
  size: number[];
  reads = 0;
  writes = 0;

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, index) => index);
    this.size = new Array(n).fill(1);
  }

  find(x: number, hooks: UfHooks = {}): number {
    let root = x;
    for (;;) {
      this.reads++;
      hooks.read?.(root, this.parent[root]);
      if (this.parent[root] === root) break;
      root = this.parent[root];
    }
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      this.writes++;
      hooks.compress?.(x, root);
      x = next;
    }
    return root;
  }

  union(a: number, b: number, hooks: UfHooks = {}): boolean {
    const ra = this.find(a, hooks);
    const rb = this.find(b, hooks);
    if (ra === rb) return false;
    this.link(ra, rb, hooks);
    return true;
  }

  /** 连接两个不同的根：小树挂到大树下，大小相同时 rb 挂到 ra 下。已经找到根的调用方（比如 Kruskal）直接用它。 */
  link(ra: number, rb: number, hooks: UfHooks = {}): void {
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.writes++;
    this.size[ra] += this.size[rb];
    this.writes++;
    hooks.attach?.(rb, ra);
  }
}

export const N = 8;
const W = 46;
export const FIRST_PAIRS: Array<[number, number]> = [[0, 1], [2, 3], [4, 5], [6, 7]];
export const SECOND_PAIRS: Array<[number, number]> = [[0, 2], [4, 6], [0, 4]];
export const QUERY = 7;
export const SAME_SET: [number, number] = [3, 5];
const pairsText = (pairs: Array<[number, number]>) => pairs.map(([a, b]) => `(${a},${b})`).join(' ');

function forest(uf: UnionFind, tones: Record<number, Tone>, lift: number[], marks: Array<[number, string, Color]>): GraphPrim {
  const children = new Map<number, number[]>();
  uf.parent.forEach((parent, index) => {
    if (parent === index) return;
    children.set(parent, [...(children.get(parent) ?? []), index]);
  });
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let leaf = 0;
  const DX = 74;
  const DY = 76;
  const place = (index: number, depth: number): number => {
    const kids = children.get(index) ?? [];
    let x: number;
    if (!kids.length) x = leaf++ * DX;
    else {
      const xs = kids.map((kid) => place(kid, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    nodes.push({ id: String(index), x: x - ((N - 1) * DX) / 2, y: depth * DY, v: String(index), tone: tones[index], lift: lift.includes(index) || undefined });
    for (const kid of kids) edges.push({ a: String(kid), b: String(index), arrow: true, tone: tones[kid] && tones[index] ? tones[kid] : undefined });
    return x;
  };
  uf.parent.forEach((parent, index) => {
    if (parent === index) place(index, 0);
  });
  return { kind: 'graph', id: 'f', nodes, edges, r: 21, marks: marks.map(([at, text, color]) => ({ at: String(at), text, color })) };
}

function build() {
  const uf = new UnionFind(N);
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => uf.reads + uf.writes;
  const view = (tones: Record<number, Tone> = {}, lift: number[] = [], marks: Array<[number, string, Color]> = []): { tree: GraphPrim; row: RowPrim; size: RowPrim; frame: DsFrame } => {
    const tree = forest(uf, tones, lift, marks);
    const row: RowPrim = { kind: 'row', id: 'p', w: W, cells: cellsOf(uf.parent, { tones, lift }) };
    const size: RowPrim = { kind: 'row', id: 's', w: W, cells: cellsOf(uf.size, { tones: Object.fromEntries(Object.entries(tones).filter(([key]) => uf.parent[Number(key)] === Number(key))) as Record<number, Tone> }) };
    return { tree, row, size, frame: { tree: [tree], array: [row], aux: [size] } };
  };
  const parentBytes = (notes: Record<number, string>, color: Color = 'blue') => wire(`parent 数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', intArray('parent', uf.parent, { notes, color, summary: 'parent[i] == i 表示 i 是根' }));

  const hooks: UfHooks = {
    read(index, parent) {
      const shown = view({ [index]: parent === index ? 'green' : 'blue' }, [index]);
      bucket.push(pk('prog', 'array', parent === index ? 'green' : 'blue', `parent[${index}] = ${parent}`, [parent === index ? '指向自己，是根' : `继续找 ${parent}`], [ops(), 'READ', parent === index ? `parent[${index}] = ${index}，${index} 是根` : `parent[${index}] = ${parent}，往上走`, 4],
        parentBytes({ [index]: parent === index ? '指向自己，所以是根。' : '指向父节点。' }), { quick: true, ds: shown.frame, toAt: rowAim(shown.row, index) }));
    },
    compress(index, root) {
      const shown = view({ [index]: 'violet', [root]: 'green' }, [index]);
      bucket.push(pk('prog', 'array', 'violet', `parent[${index}] = ${root}`, ['直接指向根'], [ops(), 'WRITE', `路径压缩：${index} 直接挂到根 ${root}`, 4],
        parentBytes({ [index]: '路径压缩后直接指向根，下次一步到位。' }, 'violet'), { ds: shown.frame, toAt: rowAim(shown.row, index) }));
    },
    attach(child, root) {
      const shown = view({ [child]: 'teal', [root]: 'teal' });
      bucket.push(state('prog', { 合并: `${child} → ${root}`, 大小: String(uf.size[root]) }));
      bucket.push(pk('prog', 'array', 'teal', `parent[${child}] = ${root}`, [`size[${root}] = ${uf.size[root]}`], [ops(), 'WRITE', `小树根 ${child} 挂到大树根 ${root}，合并后大小 ${uf.size[root]}`, 8],
        wire('parent 和 size 两个数组', 'mem', 'abi', intArray('parent', uf.parent, { color: 'teal', notes: { [child]: `${child} 不再是根。` } }), intArray('size', uf.size, { color: 'slate', notes: { [root]: '只有根的 size 有意义。' } })),
        { quick: true, ds: shown.frame, toAt: graphAim(shown.tree, String(root)) }));
    },
  };

  const first = view();
  bucket.push(pk('prog', 'array', 'slate', 'parent[i] = i', [`${N} 棵单节点树`], [0, 'WRITE', `初始化：parent[i] = i，size[i] = 1，共 ${N} 个集合`, N * 4],
    parentBytes({ 0: '每个元素一开始都是自己的根。' }, 'slate'), { ds: first.frame }));

  bucket = steps[1];
  FIRST_PAIRS.forEach(([a, b]) => uf.union(a, b, hooks));
  const afterPairs = [...uf.parent];
  bucket = steps[2];
  SECOND_PAIRS.forEach(([a, b]) => uf.union(a, b, hooks));
  const beforeFind = [...uf.parent];
  const beforeReads = uf.reads;

  bucket = steps[3];
  const beforeWrites = uf.writes;
  const path: number[] = [];
  const root = uf.find(QUERY, { ...hooks, read(index, parent) {
    path.push(index);
    hooks.read!(index, parent);
  } });
  const findReads = uf.reads - beforeReads;
  const findWrites = uf.writes - beforeWrites;
  const afterFind = [...uf.parent];
  bucket.push(state('prog', { 合并: null, 大小: null }));

  bucket = steps[4];
  const again = uf.reads;
  uf.find(QUERY, hooks);
  const secondReads = uf.reads - again;
  const rootA = uf.find(SAME_SET[0], hooks);
  const rootB = uf.find(SAME_SET[1], hooks);
  const shownFinal = view({ [rootA]: 'green' });
  bucket.push(note('tree', `find(${SAME_SET[0]}) = ${rootA}，find(${SAME_SET[1]}) = ${rootB}：${rootA === rootB ? '同一个集合' : '不同集合'}`, 'green'));
  bucket.push({ type: 'ds', frame: shownFinal.frame });
  bucket.push(render);

  return { steps, uf, afterPairs, beforeFind, afterFind, root, findReads, findWrites, secondReads, path, rootA, rootB };
}

const { steps, uf, afterPairs, beforeFind, afterFind, root, findReads, findWrites, secondReads, path, rootA, rootB } = build();
export const ufRun = { afterPairs, beforeFind, afterFind, root, findReads, findWrites, secondReads, path, rootA, rootB };
const setsIn = (parent: number[]) => parent.filter((value, index) => value === index).length;

function initialFrame(): DsFrame {
  const fresh = new UnionFind(N);
  return {
    tree: [forest(fresh, {}, [], [])],
    array: [{ kind: 'row', id: 'p', w: W, cells: cellsOf(fresh.parent) }],
    aux: [{ kind: 'row', id: 's', w: W, cells: cellsOf(fresh.size) }],
  };
}

export const unionfind: Lesson = {
  id: 'unionfind',
  name: 'UNION-FIND',
  title: '并查集',
  group: 'tree',
  layer: [1, 2],
  complexity: { best: 'O(1)，元素就是根或直接挂在根下', worst: 'O(log n)，按大小合并时单次查找的上限', note: '加上路径压缩后，一连串操作的摊还代价是 α(n)，实际可以当常数。' },
  opsUnit: '读 parent 次数 + 写 parent 和 size 次数',
  nodes: ['prog', 'tree', 'array', 'aux'],
  place: { prog: [110, 300], tree: [570, 70], array: [640, 390], aux: [540, 480] },
  labels: {
    prog: ['程序', 'find / union'],
    tree: ['森林', '箭头指向父节点'],
    array: ['parent', `int parent[${N}]`],
    aux: ['size', `int size[${N}]`],
  },
  labelAt: { tree: [-300, -66], array: [170, -70], aux: [-200, 70] },
  radius: { array: 50, tree: 60 },
  initial: initialFrame(),
  start: ['prog', 'tree', 'array', 'aux'],
  legend: [['blue', '向上找根'], ['teal', '合并'], ['violet', '路径压缩'], ['green', '根'], [null, '操作数：读 + 写']],
  overview: {
    full: '回答两个元素是否在同一个集合',
    description: `有一堆元素，不断把它们合并成组，随时要问「这两个在不在同一组」。并查集用一个 parent 数组表示森林：每个元素指向父节点，根指向自己。同一组就是同一个根。这一课真实执行 ${FIRST_PAIRS.length + SECOND_PAIRS.length} 次合并和路径压缩，上方的森林就是 parent 数组画出来的样子。`,
    facts: [
      ['表示', `int parent[${N}]，int size[${N}]`],
      ['同组判定', '两个元素的根相同'],
      ['合并策略', '小树挂到大树'],
      ['查找优化', '路径压缩'],
      ['摊还代价', 'α(n)，Tarjan 1975 年证明'],
      ['常见用途', 'Kruskal 最小生成树'],
    ],
  },
  steps: [
    {
      title: '各自为根',
      desc: `${N} 个元素，${N} 个集合`,
      detail: `初始时每个元素的 parent 都是自己，表示 ${N} 棵只有一个节点的树。整个结构只有两个 int 数组，没有指针，元素用下标表示。上面的森林和下面的数组是同一份数据的两种画法。`,
      facts: [['parent[i]', 'i'], ['size[i]', '1'], ['集合数', String(N)]],
      events: [type('./uf'), ...steps[0]],
    },
    {
      title: '两两合并',
      desc: 'union 先找两个根，再连起来',
      detail: `union(a, b) 分别找到 a 和 b 的根，把一个根的 parent 改成另一个根。只改一个 int，就把两棵树并成了一棵。${FIRST_PAIRS.length} 次合并之后 parent 是 ${afterPairs.join(' ')}。大小相同时这里让第二个根挂到第一个根下。`,
      facts: [['合并', pairsText(FIRST_PAIRS)], ['parent', afterPairs.join(' ')], ['集合数', String(setsIn(afterPairs))]],
      events: steps[1],
    },
    {
      title: '小树挂大树',
      desc: '按大小合并，树不会太高',
      detail: `合并时总把小树的根挂到大树的根下。一个节点每变深一层，所在的树至少翻倍，所以深度不超过 log₂ n，单次查找最坏 O(log n)。如果不这样做，连续的合并可能把树叠成一条长链。${SECOND_PAIRS.length} 次合并后 parent 是 ${beforeFind.join(' ')}。`,
      facts: [['合并', pairsText(SECOND_PAIRS)], ['parent', beforeFind.join(' ')], [`size[${root}]`, String(uf.size[root])]],
      events: steps[2],
    },
    {
      title: '路径压缩',
      desc: `find(${QUERY}) 把路过的节点直接挂到根`,
      detail: `find(${QUERY}) 顺着 ${path.join(' → ')} 走到根，读了 ${findReads} 次 parent。既然已经知道了根，就顺手把路上的节点直接指向它。parent 从 ${beforeFind.join(' ')} 变成 ${afterFind.join(' ')}，树矮了，以后查这些节点更快。`,
      facts: [['根', String(root)], ['读 parent', `${findReads} 次`], ['写 parent', `${findWrites} 次`], ['压缩后', afterFind.join(' ')]],
      events: steps[3],
    },
    {
      title: '再查一次',
      desc: `第二次 find(${QUERY}) 只读 ${secondReads} 次`,
      detail: `同一个查询这次只要读 ${secondReads} 次 parent，因为 ${QUERY} 已经直接挂在根下。判断 ${SAME_SET[0]} 和 ${SAME_SET[1]} 是否同组，只需要比较它们的根，这两次查找也顺手压缩了路径。两种优化一起用时，m 次操作的总代价是 O(m α(n))，α 增长极慢，实际可以当作常数。`,
      facts: [['第一次', `读 ${findReads} 次`], ['第二次', `读 ${secondReads} 次`], ['总操作数', String(uf.reads + uf.writes)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '两个数组解决连通性',
    desc: '只回答同组与否，所以能做到极快',
    text: '并查集不支持拆分集合，也不能列出路径，只能回答连通问题，正因如此才能这么快。它常用在 Kruskal 最小生成树、判断无向图的环和图像连通区域标记里，后面的最小生成树课就会用到它。',
    facts: [['单次最坏', 'O(log n)'], ['摊还', 'α(n)'], ['下一课', 'BFS']],
  },
};
