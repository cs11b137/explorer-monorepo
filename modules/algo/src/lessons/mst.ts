import { callRegs, cStructArray, intArray, layoutOf, returnReg, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim } from '../scene/ds';
import { cellsOf, HEAP, TEXT_RET } from './common';
import { note, pk, render, state, type } from './dsl';
import type { Color, DsMark, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';
import { UnionFind, type UfHooks } from './unionfind';

export type WeightedEdge = [u: number, v: number, w: number];

export interface KruskalHooks extends UfHooks {
  sorted?(edges: WeightedEdge[]): void;
  consider?(k: number, edge: WeightedEdge): void;
  /** 两端的根已经找到：不同就收下这条边，相同就会成环。 */
  decide?(k: number, edge: WeightedEdge, ru: number, rv: number, take: boolean, total: number, count: number): void;
}

/**
 * Kruskal 最小生成树：边按权从小到大排好，依次检查，两端不在同一个集合才收下。
 * 用并查集判断是否成环，收够 V - 1 条就停。排序用的是稳定排序，边权相同时保持输入顺序。
 */
export function kruskal(n: number, edges: WeightedEdge[], hooks: KruskalHooks = {}) {
  const sorted = [...edges].sort((a, b) => a[2] - b[2]);
  hooks.sorted?.(sorted);
  const uf = new UnionFind(n);
  const tree: WeightedEdge[] = [];
  const rejected: WeightedEdge[] = [];
  let total = 0;
  let examined = 0;
  for (let k = 0; k < sorted.length && tree.length < n - 1; k++) {
    const edge = sorted[k];
    examined++;
    hooks.consider?.(k, edge);
    const ru = uf.find(edge[0], hooks);
    const rv = uf.find(edge[1], hooks);
    const take = ru !== rv;
    if (take) {
      tree.push(edge);
      total += edge[2];
    } else rejected.push(edge);
    hooks.decide?.(k, edge, ru, rv, take, total, tree.length);
    if (take) uf.link(ru, rv, hooks);
  }
  return { tree, rejected, total, examined, sorted, uf };
}

export const N = 6;
export const EDGES: WeightedEdge[] = [[0, 1, 6], [0, 2, 4], [1, 2, 7], [1, 3, 11], [2, 3, 9], [2, 5, 12], [3, 4, 1], [3, 5, 8], [4, 5, 3]];
const POINTS: Array<[number, number]> = [[-280, 60], [-140, -60], [-130, 170], [40, 50], [200, -60], [210, 170]];
const EDGE_T: CField[] = [['u', 'int'], ['v', 'int'], ['w', 'int']];
const EDGE_SIZE = layoutOf(EDGE_T).size;
const W = 46;
const QSORT = 'void qsort(void *base, size_t n, size_t size, int (*cmp)(const void *, const void *))';
const edgeId = (u: number, v: number) => (u < v ? `${u}-${v}` : `${v}-${u}`);
const name = ([u, v]: WeightedEdge) => `${u}-${v}`;

/** 文案从这里取值：每条被检查的边是收下还是跳过，以及当时两端的根。 */
export interface EdgeLog {
  edge: WeightedEdge;
  ru: number;
  rv: number;
  take: boolean;
  reads: number;
  /** 收下时合并后集合的大小。 */
  merged: number;
}

/** 先不带钩子跑一遍，知道哪些边会被收下，好把事件分到对应的步骤里。 */
const plain = kruskal(N, EDGES);
const stepOfEdge = (k: number) => {
  const taken = plain.tree.indexOf(plain.sorted[k]);
  return taken < 0 ? 3 : taken < 2 ? 1 : taken < 4 ? 2 : 4;
};

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let examined = 0;
  const uf = new UnionFind(N);
  const live = { parent: [...uf.parent], size: [...uf.size] };
  let order: WeightedEdge[] = [...EDGES];
  const taken = new Set<string>();
  const rejected = new Set<string>();
  let current = -1;
  const logs: EdgeLog[] = [];
  let reads = 0;
  let writes = 0;
  const ops = () => examined + reads + writes;

  const rootOf = (x: number) => {
    while (live.parent[x] !== x) x = live.parent[x];
    return x;
  };
  const graph = (tones: Record<number, Tone> = {}, edgeTones: Record<string, Tone> = {}, lift: number[] = []): GraphPrim => {
    const nodes: GraphNode[] = POINTS.map(([x, y], index) => ({ id: String(index), x, y, v: String(index), sub: `根 ${rootOf(index)}`, tone: tones[index], lift: lift.includes(index) || undefined }));
    const edges: GraphEdge[] = EDGES.map(([u, v, w]) => {
      const id = edgeId(u, v);
      return { a: String(u), b: String(v), label: String(w), tone: edgeTones[id] ?? (taken.has(id) ? 'green' : rejected.has(id) ? 'dim' : undefined) };
    });
    return { kind: 'graph', id: 'g', nodes, edges, r: 23 };
  };
  const edgeRow = (lit?: Tone): RowPrim => {
    const tones: Record<number, Tone> = {};
    order.forEach(([u, v], index) => {
      const id = edgeId(u, v);
      if (taken.has(id)) tones[index] = 'green';
      else if (rejected.has(id)) tones[index] = 'dim';
    });
    if (current >= 0 && lit) tones[current] = lit;
    const marks: DsMark[] = current >= 0 ? [{ at: current, text: 'k', color: 'blue' }] : [];
    return { kind: 'row', id: 'e', w: W, cells: cellsOf(order.map(([, , w]) => w), { tones, lift: current >= 0 && lit ? [current] : [], subs: order.map(name), keys: order.map(name) }), marks };
  };
  const parentRow = (tones: Record<number, Tone> = {}, lift: number[] = []): RowPrim => ({ kind: 'row', id: 'p', w: W, cells: cellsOf(live.parent, { tones, lift }) });
  const edgeBytes = (notes: Record<number, string> = {}, color: Color = 'blue') => cStructArray('edges', EDGE_T, order.map(([u, v, w]) => ({ u, v, w })), {
    color, summary: `每条边 ${EDGE_SIZE} 字节，三个 int，没有填充`,
    elementNotes: (index) => ({ u: '一端。', v: '另一端。', w: notes[index] ?? '边权，排序的依据。' }),
  });
  const ufBytes = (notes: Record<number, string>, color: Color = 'blue') => [
    intArray('parent', live.parent, { color, notes, summary: 'parent[i] == i 表示 i 是根' }),
    intArray('size', live.size, { color: 'slate', summary: '只有根的 size 有意义' }),
  ];

  const result = kruskal(N, EDGES, {
    sorted(edges) {
      bucket.push(pk('prog', 'array', 'violet', 'qsort', [`${edges.length} 条边，按 w 升序`], [0, 'CALL', `调用 qsort 按边权排序，${edges.length} 个元素，每个 ${EDGE_SIZE} 字节`, 'reg'],
        wire('call 之前的寄存器', 'regs', 'abi', callRegs(QSORT, [['base', HEAP, true], ['n', edges.length], ['size', EDGE_SIZE], ['cmp', TEXT_RET, true]], 'violet'))));
      order = [...edges];
      const shown = edgeRow();
      bucket.push(pk('array', 'prog', 'violet', '排好了', [order.map(([, , w]) => w).join(' ')], [0, 'WRITE', `qsort 返回：边权依次是 ${order.map(([, , w]) => w).join(' ')}`, order.length * EDGE_SIZE],
        wire(`边数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', edgeBytes({ 0: '最轻的边，第一个检查。' }, 'violet')), { ds: { array: [shown] }, fromAt: rowAim(shown, 0) }));
      const firstParent = parentRow();
      bucket.push(pk('prog', 'aux', 'slate', 'parent[i] = i', [`${N} 个顶点各自一组`], [0, 'WRITE', `并查集初始化：${N} 个顶点各是一个集合，还没有边`, N * 8],
        wire(`并查集，基址 ${hex(HEAP + 0x80n)}（E.G.）`, 'mem', 'abi', ...ufBytes({ 0: '每个顶点一开始都是自己的根。' }, 'slate')), { ds: { aux: [firstParent], graph: [graph()] } }));
    },
    consider(k, edge) {
      const [u, v, w] = edge;
      bucket = steps[stepOfEdge(k)];
      current = k;
      examined++;
      logs.push({ edge, ru: -1, rv: -1, take: false, reads: 0, merged: 0 });
      const shown = edgeRow('blue');
      bucket.push(state('prog', { 边: `${u}-${v}，权 ${w}`, 已选: String(taken.size) }));
      bucket.push(pk('array', 'prog', 'blue', `edges[${k}]`, [`${u}-${v}，权 ${w}`], [ops(), 'READ', `第 ${k + 1} 轻的边：${u}-${v}，权 ${w}`, EDGE_SIZE],
        wire('边数组', 'mem', 'abi', edgeBytes({ [k]: '正在检查的边。' })), { quick: k > 0, ds: { array: [shown], graph: [graph({ [u]: 'blue', [v]: 'blue' }, { [edgeId(u, v)]: 'blue' })] }, fromAt: rowAim(shown, k) }));
    },
    read(index, parent) {
      reads++;
      logs[logs.length - 1].reads++;
      const isRoot = parent === index;
      const shown = parentRow({ [index]: isRoot ? 'green' : 'blue' }, [index]);
      bucket.push(pk('prog', 'aux', isRoot ? 'green' : 'blue', `parent[${index}] = ${parent}`, [isRoot ? '是根' : `继续找 ${parent}`], [ops(), 'READ', isRoot ? `parent[${index}] = ${index}，${index} 是根` : `parent[${index}] = ${parent}，往上走`, 4],
        wire('并查集', 'mem', 'abi', ...ufBytes({ [index]: isRoot ? '指向自己，是根。' : '指向父节点。' })), { quick: true, ds: { aux: [shown] }, toAt: rowAim(shown, index) }));
    },
    compress(index, root) {
      writes++;
      live.parent[index] = root;
      const shown = parentRow({ [index]: 'violet' }, [index]);
      bucket.push(pk('prog', 'aux', 'violet', `parent[${index}] = ${root}`, ['路径压缩'], [ops(), 'WRITE', `路径压缩：${index} 直接挂到根 ${root}`, 4],
        wire('并查集', 'mem', 'abi', ...ufBytes({ [index]: '直接指向根。' }, 'violet')), { quick: true, ds: { aux: [shown] }, toAt: rowAim(shown, index) }));
    },
    decide(_k, edge, ru, rv, take, total, count) {
      const [u, v] = edge;
      Object.assign(logs[logs.length - 1], { ru, rv, take });
      const id = edgeId(u, v);
      if (take) taken.add(id);
      else rejected.add(id);
      const shownRow = edgeRow(take ? 'green' : 'amber');
      const shownGraph = graph({ [u]: take ? 'green' : 'amber', [v]: take ? 'green' : 'amber' }, { [id]: take ? 'green' : 'amber' });
      if (!take) bucket.push(note('graph', `${u} 和 ${v} 已经连通，再加 ${u}-${v} 就成环`, 'amber'));
      bucket.push(pk('prog', 'graph', take ? 'green' : 'amber', take ? `收下 ${u}-${v}` : `跳过 ${u}-${v}`, [take ? `根 ${ru} 和 ${rv} 不同` : `根都是 ${ru}`, take ? `总权 ${total}` : '会成环'], [ops(), 'CMP', take ? `find(${u}) = ${ru}，find(${v}) = ${rv}，不同集合：收下，已选 ${count} 条，总权 ${total}` : `find(${u}) = find(${v}) = ${ru}，已经连通，加上就成环，跳过`, 'reg'],
        wire('第二次 find 返回', 'regs', 'abi', returnReg('int find(int x)', rv, `find(${v}) 的根。find(${u}) 返回的 ${ru} 已经存在别的寄存器里，两者${take ? '不等' : '相等'}。`, take ? 'green' : 'amber')), { ds: { array: [shownRow], graph: [shownGraph] }, toAt: graphAim(shownGraph, String(take ? u : v)) }));
    },
    attach(child, root) {
      writes += 2;
      live.parent[child] = root;
      live.size[root] += live.size[child];
      logs[logs.length - 1].merged = live.size[root];
      const shown = parentRow({ [child]: 'teal', [root]: 'teal' });
      bucket.push(pk('prog', 'aux', 'teal', `parent[${child}] = ${root}`, [`size[${root}] = ${live.size[root]}`], [ops(), 'WRITE', `合并两个集合：根 ${child} 挂到根 ${root} 下，大小 ${live.size[root]}`, 8],
        wire('并查集', 'mem', 'abi', ...ufBytes({ [child]: `${child} 不再是根。` }, 'teal')), { quick: true, ds: { aux: [shown], graph: [graph({}, {})] }, toAt: rowAim(shown, child) }));
    },
  });
  current = -1;
  const finalGraph = graph(Object.fromEntries(POINTS.map((_, index) => [index, 'green'])) as Record<number, Tone>);
  steps[4].push(state('prog', { 边: null, 已选: `${result.tree.length} 条` }));
  steps[4].push(note('graph', `${N - 1} 条边连通 ${N} 个顶点，总权 ${result.total}`, 'green'));
  steps[4].push({ type: 'ds', frame: { graph: [finalGraph], array: [edgeRow()], aux: [parentRow()] } });
  steps[4].push(render);
  return { steps, result, logs, ops: ops() };
}

const { steps, result, logs, ops: totalOps } = build();
export const mstRun = { result, logs, ops: totalOps };
const takenLogs = logs.filter((log) => log.take);
const rejectedLogs = logs.filter((log) => !log.take);
const skippedLater = result.sorted.slice(result.examined);
const pairs = (list: EdgeLog[]) => list.map((log) => name(log.edge)).join('、');

const initialGraph: GraphPrim = {
  kind: 'graph', id: 'g', r: 23,
  nodes: POINTS.map(([x, y], index) => ({ id: String(index), x, y, v: String(index), sub: `根 ${index}` })),
  edges: EDGES.map(([u, v, w]) => ({ a: String(u), b: String(v), label: String(w) })),
};

export const mst: Lesson = {
  id: 'mst',
  name: 'KRUSKAL',
  title: '最小生成树',
  group: 'tree',
  layer: [4, 4],
  complexity: { best: 'O(E log E)，排序占大头', worst: 'O(E log E)，并查集每次几乎是常数', note: 'E log E 和 E log V 是同一个量级，因为 E 不超过 V²。' },
  opsUnit: '检查的边 + 读写 parent 和 size 的次数',
  nodes: ['prog', 'graph', 'array', 'aux'],
  place: { prog: [100, 300], graph: [620, 120], array: [430, 490], aux: [820, 480] },
  labels: {
    prog: ['程序', 'kruskal'],
    graph: ['带权无向图', `${N} 个顶点，${EDGES.length} 条边`],
    array: ['边数组', `struct edge edges[${EDGES.length}]`],
    aux: ['并查集', `int parent[${N}]`],
  },
  labelAt: { graph: [-250, -60], array: [-200, 80], aux: [80, 100] },
  radius: { graph: 100, array: 40, aux: 40 },
  initial: {
    graph: [initialGraph],
    array: [{ kind: 'row', id: 'e', w: W, cells: cellsOf(EDGES.map(([, , w]) => w), { subs: EDGES.map(name), keys: EDGES.map(name) }) }],
    aux: [{ kind: 'row', id: 'p', w: W, cells: cellsOf(Array.from({ length: N }, (_, index) => index)) }],
  },
  start: ['prog', 'graph', 'array', 'aux'],
  legend: [['violet', '排序'], ['blue', '检查边、找根'], ['green', '收下'], ['amber', '成环，跳过'], ['teal', '合并集合'], [null, '操作数：检查边 + 读写 parent']],
  overview: {
    full: '从最轻的边开始，不成环就收下',
    description: `连通 ${N} 个顶点最少要 ${N - 1} 条边，最小生成树是总权最小的那一组。Kruskal 把所有边按权排序，从轻到重检查，两端已经连通就跳过，否则收下。判断是否连通用的正是前面并查集课的 find 和合并。这一课真实运行一遍，绿色的边就是最小生成树。`,
    facts: [
      ['提出', 'J. B. Kruskal，1956 年'],
      ['贪心规则', '不成环的最轻边'],
      ['判环', '并查集，两端同根就成环'],
      ['struct edge', `${EDGE_SIZE} 字节，三个 int`],
      ['边数', `收够 V - 1 = ${N - 1} 条就停`],
      ['时间', 'O(E log E)'],
    ],
  },
  steps: [
    {
      title: '按边权排序',
      desc: `${EDGES.length} 条边，从轻到重`,
      detail: `边存成 struct edge 数组，每条 ${EDGE_SIZE} 字节，qsort 按 w 从小到大排好，这一步是 O(E log E)。并查集初始化后每个顶点自成一组，图上每个顶点下面写着它所在集合的根。之后只要从左到右扫一遍边数组。`,
      facts: [['排序后', result.sorted.map(([, , w]) => w).join(' ')], ['struct edge', `${EDGE_SIZE} 字节`], ['集合数', String(N)]],
      events: [type('./kruskal'), ...steps[0]],
    },
    {
      title: '最轻的边先收下',
      desc: `${pairs(takenLogs.slice(0, 2))}`,
      detail: `最轻的边 ${name(takenLogs[0].edge)} 两端各自是根，不在同一个集合，收下并合并。下一条 ${name(takenLogs[1].edge)} 也一样，${takenLogs[1].edge[0]} 的根是 ${takenLogs[1].ru}，${takenLogs[1].edge[1]} 的根是 ${takenLogs[1].rv}，合并后 ${takenLogs[1].merged} 个顶点连成一组。每收下一条边，集合数就少 1。`,
      facts: [['收下', pairs(takenLogs.slice(0, 2))], ['总权', String(takenLogs[0].edge[2] + takenLogs[1].edge[2])], ['集合数', String(N - 2)]],
      events: steps[1],
    },
    {
      title: '两组各自长大',
      desc: `${pairs(takenLogs.slice(2, 4))}`,
      detail: `${pairs(takenLogs.slice(2, 4))} 连的是另一边的顶点，同样各收下。现在图上有两组：一组的根是 ${takenLogs[3].ru}，另一组的根是 ${takenLogs[1].ru}。Kruskal 不要求选出的边连在一起，中间可以是好几棵小树，最后才合成一棵。`,
      facts: [['收下', pairs(takenLogs.slice(2, 4))], ['总权', String(takenLogs.slice(0, 4).reduce((sum, log) => sum + log.edge[2], 0))], ['集合数', String(N - 4)]],
      events: steps[2],
    },
    {
      title: '成环就跳过',
      desc: `${pairs(rejectedLogs)} 两端已经连通`,
      detail: `${name(rejectedLogs[0].edge)} 的两端找到的根都是 ${rejectedLogs[0].ru}，说明它们之间已经有路，再加这条边只会成环。${name(rejectedLogs[1].edge)} 也一样，两端的根都是 ${rejectedLogs[1].ru}。比它们轻的边都已经检查过，成环的边扔掉不会让结果变差。`,
      facts: [['跳过', pairs(rejectedLogs)], ['判据', 'find(u) == find(v)'], ['集合数', String(N - 4)]],
      events: steps[3],
    },
    {
      title: '凑够 V - 1 条',
      desc: `总权 ${result.total}`,
      detail: `${name(takenLogs[4].edge)} 连接了两组，收下后 ${N} 个顶点全部连通，正好 ${N - 1} 条边，循环提前结束。${skippedLater.map(name).join(' 和 ')} 根本没被检查。代码一共检查 ${result.examined} 条边，总权 ${result.total}。`,
      facts: [['生成树', result.tree.map(name).join(' ')], ['总权', String(result.total)], ['检查的边', `${result.examined} / ${EDGES.length}`], ['总操作数', String(totalOps)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '贪心加并查集',
    desc: '排序决定顺序，并查集回答连通',
    text: '每次选不成环的最轻边，这个贪心是对的：任何把顶点分成两组的切分，跨过切分的最轻边一定能出现在某棵最小生成树里。Prim 算法换了个角度，从一个顶点出发每次加最近的顶点，用的是 Dijkstra 课里的堆。最小生成树常用在布线、聚类这类问题里。',
    facts: [['时间', 'O(E log E)'], ['判环', '并查集'], ['下一课', 'QUICK SORT']],
  },
};
