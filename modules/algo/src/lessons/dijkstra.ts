import { cStructArray, intArray, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim } from '../scene/ds';
import { cellsOf, HEAP } from './common';
import { note, pk, render, state, type } from './dsl';
import type { Color, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

export type WeightedEdge = [number, number, number];
export interface PqItem {
  dist: number;
  node: number;
}

export interface DijkstraHooks {
  push?(item: PqItem, heap: PqItem[]): void;
  pop?(item: PqItem, heap: PqItem[], stale: boolean, dist: number[]): void;
  relax?(u: number, v: number, weight: number, through: number, improved: boolean, dist: number[]): void;
}

export const INT_MAX = 0x7fffffff;

/** 二叉最小堆实现的优先队列，按 dist 比较。cmp 统计堆内比较次数。 */
class Pq {
  a: PqItem[] = [];
  cmp = 0;

  push(item: PqItem): void {
    this.a.push(item);
    let index = this.a.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      this.cmp++;
      if (this.a[parent].dist <= this.a[index].dist) break;
      [this.a[parent], this.a[index]] = [this.a[index], this.a[parent]];
      index = parent;
    }
  }

  pop(): PqItem {
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let best = index;
        if (left < this.a.length) {
          this.cmp++;
          if (this.a[left].dist < this.a[best].dist) best = left;
        }
        if (right < this.a.length) {
          this.cmp++;
          if (this.a[right].dist < this.a[best].dist) best = right;
        }
        if (best === index) break;
        [this.a[best], this.a[index]] = [this.a[index], this.a[best]];
        index = best;
      }
    }
    return top;
  }
}

/** Dijkstra 单源最短路。距离变短就压入新条目，旧条目留在堆里，弹出时发现过期就跳过。要求边权非负。 */
export function dijkstra(n: number, edges: WeightedEdge[], start: number, hooks: DijkstraHooks = {}) {
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [a, b, w] of edges) {
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  }
  const dist: number[] = new Array(n).fill(INT_MAX);
  const prev: number[] = new Array(n).fill(-1);
  const pq = new Pq();
  let relaxations = 0;
  let stale = 0;
  dist[start] = 0;
  const seed = { dist: 0, node: start };
  pq.push(seed);
  hooks.push?.(seed, pq.a);
  while (pq.a.length) {
    const item = pq.pop();
    const old = item.dist > dist[item.node];
    if (old) stale++;
    hooks.pop?.(item, pq.a, old, dist);
    if (old) continue;
    for (const [v, w] of adj[item.node]) {
      relaxations++;
      const through = item.dist + w;
      const improved = through < dist[v];
      if (improved) {
        dist[v] = through;
        prev[v] = item.node;
      }
      hooks.relax?.(item.node, v, w, through, improved, dist);
      if (improved) {
        const pushed = { dist: through, node: v };
        pq.push(pushed);
        hooks.push?.(pushed, pq.a);
      }
    }
  }
  return { dist, prev, relaxations, stale, heapCmp: pq.cmp };
}

export const N = 6;
export const START = 0;
/** 课程用的 6 顶点带权图，下标从 0 开始。 */
export const EDGES: WeightedEdge[] = [[0, 1, 7], [0, 2, 9], [0, 5, 14], [1, 2, 10], [1, 3, 15], [2, 3, 11], [2, 5, 2], [3, 4, 6], [4, 5, 9]];
const POINTS: Array<[number, number]> = [[-270, 80], [-130, 180], [-90, 30], [80, 150], [230, 20], [20, -80]];
const ITEM: CField[] = [['dist', 'int'], ['node', 'int']];
const ITEM_SIZE = layoutOf(ITEM).size;
const edgeId = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const inf = (value: number) => (value === INT_MAX ? '∞' : String(value));

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  let ops = 0;
  let popCount = 0;
  let sawStale = false;
  const distNow: number[] = new Array(N).fill(INT_MAX);
  const prevNow: number[] = new Array(N).fill(-1);
  const settled = new Set<number>();
  let heapNow: PqItem[] = [];
  const CAP = 8;
  /** 文案从这里取值：第一次松弛的结果、每个顶点距离的变化、第一个过期条目。 */
  const firstRelax: Array<{ v: number; value: number }> = [];
  const history = new Map<number, Array<{ value: number; via: number; base: number; weight: number }>>();
  let firstStale: PqItem | null = null;

  const graph = (tones: Record<number, Tone> = {}, edgeTones: Record<string, Tone> = {}, lift: number[] = []): GraphPrim => {
    const nodes: GraphNode[] = POINTS.map(([x, y], index) => ({
      id: String(index), x, y, v: String(index), sub: `d = ${inf(distNow[index])}`,
      tone: tones[index] ?? (settled.has(index) ? 'green' : undefined),
      lift: lift.includes(index) || undefined,
    }));
    const tree = new Set(prevNow.flatMap((parent, index) => (parent >= 0 ? [edgeId(parent, index)] : [])));
    const edges: GraphEdge[] = EDGES.map(([a, b, w]) => ({ a: String(a), b: String(b), label: String(w), tone: edgeTones[edgeId(a, b)] ?? (tree.has(edgeId(a, b)) ? 'green' : undefined) }));
    return { kind: 'graph', id: 'g', nodes, edges, r: 23 };
  };
  const pqRow = (lit?: number): RowPrim => {
    const values: Array<string | null> = new Array(CAP).fill(null);
    heapNow.forEach((item, index) => (values[index] = `${item.dist}·${item.node}`));
    return { kind: 'row', id: 'q', w: 52, center: 3.5, cells: cellsOf(values, { tones: lit === undefined ? {} : { [lit]: 'violet' } }) };
  };
  const dRow = (lit?: number, tone: Tone = 'green'): RowPrim => ({ kind: 'row', id: 'd', w: 48, cells: cellsOf(distNow.map(inf), { tones: lit === undefined ? {} : { [lit]: tone } }) });
  const distBytes = (notes: Record<number, string>, color: Color = 'green') => intArray('dist', distNow, { color, notes, shown: (value) => (value === INT_MAX ? 'INT_MAX（∞）' : undefined), summary: 'INT_MAX 表示还没有路径' });
  const pqBytes = (notes: Record<string, string> = {}) => cStructArray('pq', ITEM, heapNow.length ? heapNow.map((item) => ({ dist: item.dist, node: item.node })) : [{ dist: null, node: null }], {
    color: 'violet', summary: `当前 ${heapNow.length} 个条目，每个 8 字节，没有填充`,
    elementNotes: (index) => ({ dist: notes[index] ?? '优先级：到这个顶点的距离。', node: '顶点编号。' }),
  });

  const result = dijkstra(N, EDGES, START, {
    push(item, heap) {
      heapNow = [...heap];
      ops++;
      if (item.node === START && item.dist === 0) {
        distNow[START] = 0;
        const shownDist = dRow(START);
        bucket.push(pk('prog', 'aux', 'green', `dist[${START}] = 0`, ['起点'], [ops - 1, 'WRITE', '起点距离是 0，其余都是 INT_MAX', 4],
          wire(`dist 数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', distBytes({ [START]: '起点。' })), { ds: { aux: [shownDist], graph: [graph({ [START]: 'teal' })] }, toAt: rowAim(shownDist, START) }));
      }
      const at = heap.findIndex((entry) => entry === item);
      const shown = pqRow(at);
      bucket.push(pk('prog', 'queue', 'violet', `push (${item.dist}, ${item.node})`, [`顶点 ${item.node}，距离 ${item.dist}`], [ops, 'WRITE', `压入 (dist=${item.dist}, node=${item.node})，上浮到 pq[${at}]`, 8],
        wire('优先队列的数组', 'mem', 'abi', pqBytes({ [at]: '刚压入。' })), { quick: true, ds: { queue: [shown] }, toAt: rowAim(shown, at) }));
    },
    pop(item, heap, stale, dist) {
      heapNow = [...heap];
      popCount++;
      ops++;
      if (stale) {
        sawStale = true;
        firstStale ??= item;
      }
      bucket = steps[popCount === 1 ? 1 : !sawStale ? 2 : stale && bucket !== steps[4] ? 3 : 4];
      const shown = pqRow();
      if (!stale) settled.add(item.node);
      const g = graph(stale ? { [item.node]: 'slate' } : { [item.node]: 'amber' }, {}, [item.node]);
      bucket.push(state('prog', { 当前: String(item.node), 距离: String(item.dist), 堆内: String(heap.length) }));
      if (stale) bucket.push(note('queue', `${item.dist} > dist[${item.node}] = ${dist[item.node]}，过期`, 'amber'));
      bucket.push(pk('queue', 'prog', stale ? 'slate' : 'amber', `pop (${item.dist}, ${item.node})`, [stale ? `已有更短的 ${dist[item.node]}，跳过` : '堆里距离最小'], [ops, 'READ', stale ? `弹出 (${item.dist}, ${item.node})：dist[${item.node}] 已经是 ${dist[item.node]}，这个条目过期，跳过` : `弹出 (${item.dist}, ${item.node})：距离最小，顶点 ${item.node} 的最短路确定了`, 8],
        wire('优先队列的数组，弹出之后', 'mem', 'abi', pqBytes()), { quick: popCount > 1, ds: { queue: [shown], graph: [g] } }));
    },
    relax(u, v, weight, through, improved, dist) {
      ops++;
      distNow[v] = dist[v];
      if (improved) {
        prevNow[v] = u;
        history.set(v, [...(history.get(v) ?? []), { value: through, via: u, base: dist[u], weight }]);
        if (popCount === 1) firstRelax.push({ v, value: through });
      }
      const key = edgeId(u, v);
      const shownGraph = graph({ [u]: 'amber', [v]: improved ? 'blue' : 'slate' }, { [key]: improved ? 'blue' : 'slate' }, [u]);
      const shownDist = dRow(v, improved ? 'green' : 'slate');
      const old = improved ? '更短，更新' : `不比 ${inf(dist[v])} 短`;
      bucket.push(pk('prog', 'graph', improved ? 'blue' : 'slate', `${u} → ${v}`, [`${dist[u]} + ${weight} = ${through}`, old], [ops, 'CMP', `松弛 ${u}→${v}：${dist[u]} + ${weight} = ${through}，${old}`, 4],
        wire('dist 数组', 'mem', 'abi', distBytes({ [v]: improved ? `更新成 ${through}。` : `${through} 不更短，不改。`, [u]: '当前顶点。' }, improved ? 'green' : 'slate')), { quick: true, ds: { graph: [shownGraph], aux: [shownDist] }, toAt: graphAim(shownGraph, String(v)) }));
    },
  });
  const finalGraph = graph();
  steps[4].push({ type: 'ds', frame: { graph: [finalGraph], aux: [dRow()], queue: [pqRow()] } });
  steps[4].push(render);
  return { steps, result, ops, firstRelax, history, firstStale: firstStale! as PqItem };
}

const { steps, result, ops: totalOps, firstRelax, history, firstStale } = build();
export const dijkstraRun = { result, firstRelax, history, firstStale };
const staleUpdates = history.get(firstStale.node)!;
const [olderEntry, betterEntry] = staleUpdates;
const improvedTwice = [...history].filter(([, list]) => list.length > 1).sort(([a], [b]) => b - a);

const initialGraph: GraphPrim = {
  kind: 'graph', id: 'g', r: 23,
  nodes: POINTS.map(([x, y], index) => ({ id: String(index), x, y, v: String(index), sub: 'd = ∞' })),
  edges: EDGES.map(([a, b, w]) => ({ a: String(a), b: String(b), label: String(w) })),
};

export const dijkstraLesson: Lesson = {
  id: 'dijkstra',
  name: 'DIJKSTRA',
  title: '最短路径',
  group: 'tree',
  layer: [4, 4],
  complexity: { best: 'O((V + E) log V)，这里的 n 对应顶点数和边数', worst: 'O((V + E) log V)，每条边最多压堆一次', note: '要求边权非负。这是二叉堆版本的上界。' },
  opsUnit: '堆操作 + 松弛次数',
  nodes: ['prog', 'graph', 'queue', 'aux'],
  place: { prog: [100, 300], graph: [620, 130], queue: [420, 490], aux: [810, 480] },
  labels: {
    prog: ['程序', `dijkstra(g, ${START})`],
    graph: ['带权无向图', `${N} 个顶点，${EDGES.length} 条边`],
    queue: ['优先队列', '二叉堆，元素写作 距离·顶点'],
    aux: ['距离表', `int dist[${N}]`],
  },
  labelAt: { graph: [-240, -40], queue: [-190, 70], aux: [100, 100] },
  radius: { graph: 100, queue: 40, aux: 40 },
  initial: {
    graph: [initialGraph],
    queue: [{ kind: 'row', id: 'q', w: 52, center: 3.5, cells: cellsOf(new Array(8).fill(null)) }],
    aux: [{ kind: 'row', id: 'd', w: 48, cells: cellsOf(new Array(N).fill('∞')) }],
  },
  start: ['prog', 'graph', 'queue', 'aux'],
  legend: [['amber', '弹出'], ['blue', '松弛成功'], ['violet', '压入堆'], ['green', '写距离'], ['slate', '无效'], [null, '操作数：堆操作 + 松弛']],
  overview: {
    full: '总是先确定当前最近的顶点',
    description: `边有长短时，BFS 的「一圈一圈」就不对了。Dijkstra 每次从未确定的顶点里选距离最小的，它的距离不可能再变短，因为其他路径都要先经过更远的顶点。这一课用二叉堆真实跑一张 ${N} 个顶点的图，绿色的边组成最短路径树。`,
    facts: [
      ['提出', 'E. W. Dijkstra，1959 年发表'],
      ['前提', '边权非负'],
      ['优先队列', '二叉堆，不做 decrease-key'],
      ['struct pq_item', `${ITEM_SIZE} 字节，两个 int`],
      ['时间', 'O((V + E) log V)'],
      ['∞ 的真实值', `INT_MAX = ${hex(INT_MAX)}`],
    ],
  },
  steps: [
    {
      title: '初始化',
      desc: '起点距离 0，其余 ∞',
      detail: `∞ 在内存里是 INT_MAX，也就是 ${hex(INT_MAX)}。起点作为第一个条目压入优先队列，条目是一个 ${ITEM_SIZE} 字节的结构：距离和顶点编号。堆按距离排序，最小的在 pq[0]。`,
      facts: [[`dist[${START}]`, String(result.dist[START])], ['其余', 'INT_MAX'], ['堆', `(0, ${START})`]],
      events: [type(`./dijkstra ${START}`), ...steps[0]],
    },
    {
      title: '弹出起点，松弛',
      desc: `用起点的边更新 ${firstRelax.length} 个邻居`,
      detail: `松弛就是检查「经过当前顶点走这条边，是否比已知的路更短」。起点的 ${firstRelax.length} 个邻居都从 ∞ 变成了具体的数字。距离变短就压入一个新条目，所以堆里同一个顶点可能有多个条目。`,
      facts: [['当前', String(START)], ...firstRelax.map(({ v, value }): [string, string] => [`dist[${v}]`, result.dist[v] === value ? String(value) : `暂时 ${value}`])],
      events: steps[1],
    },
    {
      title: '贪心地选最近的',
      desc: '弹出的顶点，最短路就确定了',
      detail: `每次弹出堆里距离最小的条目。因为边权非负，从别的路绕过来不会更短，所以这个顶点的距离已是最终值，图上标成绿色。经过 ${betterEntry.via} 再走到 ${firstStale.node} 只要 ${betterEntry.base} + ${betterEntry.weight} = ${betterEntry.value}，比之前记录的 ${olderEntry.value} 短，dist[${firstStale.node}] 被改小。`,
      facts: [...improvedTwice.map(([v, list]): [string, string] => [`顶点 ${v}`, list.map((item) => item.value).join(' → ')]), ['绿色的边', '最短路径树']],
      events: steps[2],
    },
    {
      title: '跳过过期条目',
      desc: `旧的 (${firstStale.dist}, ${firstStale.node}) 还在堆里`,
      detail: `距离改小时，这个实现没有去堆里修改旧条目，而是压一个新的。旧条目 (${firstStale.dist}, ${firstStale.node}) 迟早会被弹出，这时它的距离大于 dist[${firstStale.node}]，直接丢掉。这种做法简单，堆会稍大一些。本例一共跳过了 ${result.stale} 个过期条目。`,
      facts: [['过期判断', 'item.dist > dist[node]'], ['过期条目数', String(result.stale)], ['做法', '不需要 decrease-key']],
      events: steps[3],
    },
    {
      title: '完成',
      desc: `最短距离 ${result.dist.join(' ')}`,
      detail: `堆空了，所有可达顶点的距离都确定了，结果是 ${result.dist.join('、')}。代码统计到松弛 ${result.relaxations} 次，等于边数的 2 倍，因为每个顶点只展开一次，而无向边存了两个方向。如果有负权边，「弹出即最终」这个前提就不成立，要改用 Bellman-Ford。`,
      facts: [['距离', result.dist.join(' ')], ['松弛', String(result.relaxations)], ['过期条目', String(result.stale)], ['总操作数', String(totalOps)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '贪心成立是因为没有负边',
    desc: '堆把「找最近」从 O(V) 降到 O(log V)',
    text: '不用堆时，每次在数组里找最小要 O(V)，总共 O(V²)，稠密图上反而合适。二叉堆版本是 O((V + E) log V)，适合稀疏图。prev 数组记下每个顶点从谁过来，沿着它倒推就能还原完整路径。',
    facts: [['前提', '边权非负'], ['堆版本', 'O((V + E) log V)'], ['下一课', 'KRUSKAL']],
  },
};
