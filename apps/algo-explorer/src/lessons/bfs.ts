import { intArray, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim } from '../scene/ds';
import { cellsOf, HEAP } from './common';
import { note, pk, render, state, type } from './dsl';
import type { Color, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

export type Edge = [number, number];

export interface BfsHooks {
  visit?(u: number, level: number, queue: number[], head: number): void;
  scan?(u: number, v: number, seen: boolean, scanned: number): void;
  enqueue?(u: number, v: number, dist: number[], queue: number[], head: number): void;
}

/** 按边的出现顺序建邻接表：每条无向边让两端各多一个邻居。 */
export function adjacency(n: number, edges: Edge[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return adj;
}

/** 广度优先搜索。dist[v] = -1 表示还没发现。返回距离、访问顺序和扫描的边数。 */
export function bfs(n: number, edges: Edge[], start: number, hooks: BfsHooks = {}) {
  const adj = adjacency(n, edges);
  const dist: number[] = new Array(n).fill(-1);
  const queue: number[] = [];
  let head = 0;
  let scanned = 0;
  dist[start] = 0;
  queue.push(start);
  while (head < queue.length) {
    const u = queue[head++];
    hooks.visit?.(u, dist[u], queue, head);
    for (const v of adj[u]) {
      scanned++;
      const seen = dist[v] >= 0;
      hooks.scan?.(u, v, seen, scanned);
      if (seen) continue;
      dist[v] = dist[u] + 1;
      queue.push(v);
      hooks.enqueue?.(u, v, dist, queue, head);
    }
  }
  return { dist, order: queue, scanned };
}

export const N = 7;
export const START = 0;
export const EDGES: Edge[] = [[0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 5], [5, 6]];
const POINTS: Array<[number, number]> = [[-260, 70], [-130, -50], [-130, 150], [10, 30], [30, 190], [170, 100], [290, 10]];
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

export interface LevelLog {
  popped: number[];
  found: number[];
  back: { u: number; v: number } | null;
  cross: { u: number; v: number; by: number; dist: number } | null;
}

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  const dist: number[] = new Array(N).fill(-1);
  let queue: number[] = [];
  let head = 0;
  const used = new Set<string>();

  const graph = (tones: Record<number, Tone> = {}, edgeTones: Record<string, Tone> = {}, lift: number[] = [], marks: Array<[number, string, Color]> = []): GraphPrim => {
    const nodes: GraphNode[] = POINTS.map(([x, y], index) => ({
      id: String(index), x, y, v: String(index),
      sub: dist[index] < 0 ? '未发现' : `距离 ${dist[index]}`,
      tone: tones[index] ?? (dist[index] < 0 ? undefined : queue.indexOf(index) < head ? 'slate' : 'teal'),
      lift: lift.includes(index) || undefined,
    }));
    const edges: GraphEdge[] = EDGES.map(([a, b]) => ({ a: String(a), b: String(b), tone: edgeTones[edgeKey(a, b)] ?? (used.has(edgeKey(a, b)) ? 'slate' : undefined) }));
    return { kind: 'graph', id: 'g', nodes, edges, r: 23, marks: marks.map(([at, text, color]) => ({ at: String(at), text, color })) };
  };
  const qRow = (lit?: number, tone: Tone = 'blue'): RowPrim => {
    const values: Array<number | null> = new Array(N).fill(null);
    queue.forEach((value, index) => (values[index] = value));
    const tones: Record<number, Tone> = {};
    for (let index = 0; index < head; index++) tones[index] = 'dim';
    if (lit !== undefined) tones[lit] = tone;
    return { kind: 'row', id: 'q', w: 46, cells: cellsOf(values, { tones }), marks: [{ at: Math.min(head, N - 1), text: 'head', color: 'amber' }, ...(queue.length < N ? [{ at: queue.length, text: 'tail', color: 'teal' as Color }] : [])] };
  };
  const dRow = (lit?: number): RowPrim => ({ kind: 'row', id: 'd', w: 46, cells: cellsOf(dist, { tones: lit === undefined ? {} : { [lit]: 'green' } }) });
  const qBytes = (notes: Record<number, string> = {}, color: Color = 'blue') => intArray('queue', [...queue, ...new Array(N - queue.length).fill(null)], { notes, color, summary: `已出队 ${head} 个，下一个读 queue[${head}]` });
  const dBytes = (notes: Record<number, string> = {}, color: Color = 'green') => intArray('dist', dist, { notes, color, summary: '-1 表示还没发现' });

  dist[START] = 0;
  queue = [START];
  const firstQueue = qRow(0, 'teal');
  ops++;
  bucket.push(pk('prog', 'aux', 'green', `dist[${START}] = 0`, ['起点距离是 0'], [ops, 'WRITE', `起点 ${START} 的距离记为 0，其余都是 -1`, 4],
    wire(`dist 数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', dBytes({ [START]: '起点。' })), { ds: { aux: [dRow(START)], graph: [graph({ [START]: 'teal' })] }, toAt: rowAim(dRow(START), START) }));
  ops++;
  bucket.push(pk('prog', 'queue', 'teal', `入队 ${START}`, [`queue[0] = ${START}`], [ops, 'WRITE', '起点入队，队列里只有它', 4],
    wire(`队列数组，基址 ${hex(HEAP + 0x30n)}（E.G.）`, 'mem', 'abi', qBytes({ 0: '第一个元素。' }, 'teal')), { ds: { queue: [firstQueue] }, toAt: rowAim(firstQueue, 0) }));

  /** 每一层出队和发现了哪些顶点，以及扫描到已发现顶点的情况。文案从这里取值。 */
  const levels = new Map<number, LevelLog>();
  const levelOf = (level: number) => {
    if (!levels.has(level)) levels.set(level, { popped: [], found: [], back: null, cross: null });
    return levels.get(level)!;
  };
  const foundBy = new Map<number, number>();
  const levelStep = [1, 2, 3, 3, 3];
  const levelIndex = (level: number) => levelStep[Math.min(level, levelStep.length - 1)];

  const result = bfs(N, EDGES, START, {
    visit(u, level, q, h) {
      queue = [...q];
      head = h;
      bucket = steps[levelIndex(level)];
      levelOf(level).popped.push(u);
      ops++;
      const shown = qRow(h - 1, 'amber');
      bucket.push(state('prog', { 当前: String(u), 层: String(level), 操作数: String(ops) }));
      bucket.push(pk('queue', 'prog', 'amber', `出队 ${u}`, [`距离 ${level}`], [ops, 'READ', `读 queue[${h - 1}] = ${u}，它的距离是 ${level}`, 4],
        wire('队列数组', 'mem', 'abi', qBytes({ [h - 1]: '刚出队。值还在内存里，只是 head 走过去了。' }, 'amber')), { quick: true, ds: { queue: [shown], graph: [graph({ [u]: 'amber' }, {}, [u])] }, fromAt: rowAim(shown, h - 1) }));
    },
    scan(u, v, seen) {
      ops++;
      if (seen) {
        const log = levelOf(dist[u]);
        if (!log.back && dist[v] < dist[u]) log.back = { u, v };
        if (!log.cross && dist[v] === dist[u] + 1) log.cross = { u, v, by: foundBy.get(v)!, dist: dist[v] };
      }
      const key = edgeKey(u, v);
      const shown = graph({ [u]: 'amber', [v]: seen ? 'slate' : 'blue' }, { [key]: seen ? 'slate' : 'blue' }, [u]);
      bucket.push(pk('prog', 'graph', seen ? 'slate' : 'blue', `看邻居 ${v}`, [seen ? `已发现，距离 ${dist[v]}` : '还没发现'], [ops, 'CMP', `${u} 的邻居 ${v}：dist[${v}] = ${dist[v]}，${seen ? '已发现，跳过' : '第一次遇到'}`, 4],
        wire('dist 数组', 'mem', 'abi', dBytes({ [v]: seen ? '已发现。BFS 第一次发现时距离就是最短的，不用改。' : '-1，还没发现。' }, seen ? 'slate' : 'blue')), { quick: true, ds: { graph: [shown] }, toAt: graphAim(shown, String(v)) }));
    },
    enqueue(u, v, d, q, h) {
      queue = [...q];
      head = h;
      dist[v] = d[v];
      used.add(edgeKey(u, v));
      foundBy.set(v, u);
      levelOf(d[u]).found.push(v);
      ops++;
      const dShown = dRow(v);
      const gShown = graph({ [u]: 'amber', [v]: 'teal' }, { [edgeKey(u, v)]: 'green' }, [u]);
      bucket.push(pk('prog', 'aux', 'green', `dist[${v}] = ${d[v]}`, [`${d[u]} + 1`], [ops, 'WRITE', `dist[${v}] = dist[${u}] + 1 = ${d[v]}`, 4],
        wire('dist 数组', 'mem', 'abi', dBytes({ [v]: `从 ${u} 走一步到达。` })), { quick: true, ds: { aux: [dShown], graph: [gShown] }, toAt: rowAim(dShown, v) }));
      ops++;
      const qShown = qRow(q.length - 1, 'teal');
      bucket.push(pk('prog', 'queue', 'teal', `入队 ${v}`, [`queue[${q.length - 1}] = ${v}`], [ops, 'WRITE', `把 ${v} 放到队尾，等当前这一层处理完才轮到它`, 4],
        wire('队列数组', 'mem', 'abi', qBytes({ [q.length - 1]: '新进队的元素。' }, 'teal')), { quick: true, ds: { queue: [qShown] }, toAt: rowAim(qShown, q.length - 1) }));
    },
  });
  head = result.order.length;
  queue = [...result.order];
  const finalGraph = graph(Object.fromEntries(result.order.map((v) => [v, 'green'])) as Record<number, Tone>);
  const finalQueue = qRow();
  steps[4].push(note('queue', 'head == tail，队列空了', 'green'));
  steps[4].push(pk('prog', 'aux', 'green', '距离表', [result.dist.join(' ')], [ops, 'READ', `搜索结束：距离依次是 ${result.dist.join(' ')}，操作 ${ops} 次，其中扫描边 ${result.scanned} 次`, N * 4],
    wire('dist 数组', 'mem', 'abi', dBytes({})), { ds: { graph: [finalGraph], queue: [finalQueue], aux: [dRow()] } }));
  steps[4].push(render);
  return { steps, result, ops, levels, levelOf };
}

const { steps, result, ops: totalOps, levelOf } = build();
export const bfsRun = { result, levelOf };
const level0 = levelOf(0);
const level1 = levelOf(1);
const farLevels = [...new Set(result.dist)].filter((value) => value >= 2).sort((a, b) => a - b);
const farVertices = result.order.filter((vertex) => result.dist[vertex] > 2);

const initialGraph: GraphPrim = {
  kind: 'graph', id: 'g', r: 23,
  nodes: POINTS.map(([x, y], index) => ({ id: String(index), x, y, v: String(index), sub: '未发现' })),
  edges: EDGES.map(([a, b]) => ({ a: String(a), b: String(b) })),
};

export const bfsLesson: Lesson = {
  id: 'bfs',
  name: 'BFS',
  title: '广度优先',
  group: 'tree',
  layer: [3, 3],
  complexity: { best: 'O(V + E)，这里 n 指顶点数加边数', worst: 'O(V + E)，每个顶点入队一次，每条边看两次', note: '起点所在的连通部分很小时会提前结束，但数组初始化仍要 O(V)。' },
  opsUnit: '出入队 + 写距离 + 扫描边',
  nodes: ['prog', 'graph', 'queue', 'aux'],
  place: { prog: [100, 300], graph: [610, 90], queue: [430, 480], aux: [790, 460] },
  labels: {
    prog: ['程序', `bfs(g, ${START})`],
    graph: ['无向图', `${N} 个顶点，${EDGES.length} 条边`],
    queue: ['队列', `int queue[${N}]`],
    aux: ['距离表', `int dist[${N}]`],
  },
  labelAt: { graph: [240, 170], queue: [-180, 60], aux: [100, 110] },
  radius: { graph: 100, queue: 40, aux: 40 },
  initial: {
    graph: [initialGraph],
    queue: [{ kind: 'row', id: 'q', w: 46, cells: cellsOf(new Array(N).fill(null)) }],
    aux: [{ kind: 'row', id: 'd', w: 46, cells: cellsOf(new Array(N).fill(-1)) }],
  },
  start: ['prog', 'graph', 'queue', 'aux'],
  legend: [['amber', '出队'], ['blue', '扫描邻居'], ['green', '写距离'], ['teal', '入队'], [null, '操作数：含扫描边']],
  overview: {
    full: '从起点一圈一圈往外走',
    description: `BFS 先访问离起点一步的所有顶点，再访问两步的，以此类推。一个先进先出的队列保证了这个顺序。在每条边长度相同的图上，第一次走到某个顶点的路径就是最短路径。这一课真实搜索一张 ${N} 个顶点的无向图，队列和距离表的每次读写都对应实际内存。`,
    facts: [
      ['时间', 'O(V + E)'],
      ['队列', '先进先出，按层展开'],
      ['邻接表', '每条无向边存两次'],
      ['最短路', '只适用于边长相同的图'],
      ['本例扫描', `${result.scanned} 次，等于 2E`],
      ['起点', String(START)],
    ],
  },
  steps: [
    {
      title: '起点入队',
      desc: '距离记 0，其他都未发现',
      detail: `dist 数组同时起到两个作用：记录距离，以及用 -1 标记「还没发现」。起点入队后循环开始。队列用定长数组加 head 下标实现，每个顶点最多入队一次，所以 ${N} 个位置一定够用。`,
      facts: [[`dist[${START}]`, String(result.dist[START])], ['其余 dist', '-1'], ['队列', `[${START}]`]],
      events: [type(`./bfs ${START}`), ...steps[0]],
    },
    {
      title: '第 0 层',
      desc: `处理起点，发现距离 ${result.dist[level0.found[0]]} 的顶点`,
      detail: `取出 ${level0.popped[0]}，依次看它的邻居。邻居的 dist 是 -1，说明第一次遇到，就把距离写成 ${result.dist[level0.found[0]]} 并放到队尾。标记必须在入队时做，不能等出队时才做，否则同一个顶点可能被多次入队。`,
      facts: [['出队', level0.popped.join(', ')], ['发现', level0.found.join(', ')], ['队列', `[${level0.found.join(', ')}]`]],
      events: steps[1],
    },
    {
      title: '第 1 层',
      desc: `处理 ${level1.popped.join(' 和 ')}，发现距离 ${result.dist[level1.found[0]]} 的顶点`,
      detail: `队列保证距离 1 的顶点全部处理完，才会轮到距离 2 的。处理 ${level1.back!.u} 时还会看到回头路 ${level1.back!.v}，它已发现，直接跳过。${level1.cross!.u} 也能到 ${level1.cross!.v}，但 ${level1.cross!.v} 已被 ${level1.cross!.by} 发现，距离都是 ${level1.cross!.dist}，不需要更新。`,
      facts: [['出队', level1.popped.join(', ')], ['发现', level1.found.join(', ')], ['跳过', '已发现的顶点']],
      events: steps[2],
    },
    {
      title: '继续外扩',
      desc: `距离 ${farLevels.join('、')} 依次展开`,
      detail: '同样的循环继续：出队，看邻居，发现新顶点就写距离并入队。队列里相邻元素的距离最多差 1，所以出队顺序就是距离从小到大的顺序。这个性质让第一次发现时的距离一定最短。',
      facts: [...farVertices.map((vertex): [string, string] => [`顶点 ${vertex}`, `距离 ${result.dist[vertex]}`]), ['访问顺序', result.order.join(' ')]],
      events: steps[3],
    },
    {
      title: '队列为空',
      desc: `共扫描 ${result.scanned} 次边`,
      detail: `head 追上 tail，搜索结束。代码统计到扫描边 ${result.scanned} 次，正好是边数的 2 倍，因为无向边存了两个方向。每个顶点入队出队各一次，每条边看两次，总代价是 O(V + E)，和图的存储大小成正比。`,
      facts: [['距离', result.dist.join(' ')], ['扫描边', String(result.scanned)], ['总操作数', String(totalOps)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '队列决定了遍历的形状',
    desc: '换成栈就是深度优先',
    text: '把队列换成栈，同样的循环就变成深度优先搜索的一种写法，会先一头扎到底。BFS 的最短路只适用于所有边长度相同的情况；边长不同时要用下一课的 Dijkstra。',
    facts: [['时间', 'O(V + E)'], ['空间', 'O(V)'], ['下一课', 'DIJKSTRA']],
  },
};
