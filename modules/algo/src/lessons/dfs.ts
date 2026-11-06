import { callRegs, intArray, registers, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim, rowAim, towerAim } from '../scene/ds';
import { cellsOf, HEAP, TEXT_RET } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, DsMark, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, RowPrim, Tone, TowerFrame, TowerPrim } from './types';

export type Arc = [from: number, to: number];

/** 三种颜色：白色还没访问，灰色在调用栈上，黑色已经完成。 */
export const WHITE = 0;
export const GRAY = 1;
export const BLACK = 2;

export interface DfsHooks {
  /** 外层循环检查 color[s]。 */
  check?(s: number, color: number): void;
  enter?(u: number, depth: number): void;
  scan?(u: number, v: number, color: number): void;
  finish?(u: number, slot: number, depth: number): void;
}

/** 按出现顺序建出边表：有向边只存一次。 */
export function outEdges(n: number, arcs: Arc[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of arcs) adj[a].push(b);
  return adj;
}

/**
 * 递归 DFS 求拓扑序：顶点完成时从 order 的末尾往前写。
 * 扫描到灰色顶点说明有环，这时 order 不是合法的拓扑序。reads 统计读 color，writes 统计写 color 和 order。
 */
export function topoSort(n: number, arcs: Arc[], hooks: DfsHooks = {}) {
  const adj = outEdges(n, arcs);
  const color: number[] = new Array(n).fill(WHITE);
  const order: number[] = new Array(n).fill(-1);
  const finished: number[] = [];
  let pos = n;
  let reads = 0;
  let writes = 0;
  let scanned = 0;
  let cyclic = false;
  let maxDepth = 0;
  const visit = (u: number, depth: number) => {
    color[u] = GRAY;
    writes++;
    maxDepth = Math.max(maxDepth, depth + 1);
    hooks.enter?.(u, depth);
    for (const v of adj[u]) {
      scanned++;
      reads++;
      const c = color[v];
      hooks.scan?.(u, v, c);
      if (c === GRAY) cyclic = true;
      else if (c === WHITE) visit(v, depth + 1);
    }
    color[u] = BLACK;
    order[--pos] = u;
    writes += 2;
    finished.push(u);
    hooks.finish?.(u, pos, depth);
  };
  for (let s = 0; s < n; s++) {
    reads++;
    hooks.check?.(s, color[s]);
    if (color[s] === WHITE) visit(s, 0);
  }
  return { order, finished, scanned, cyclic, maxDepth, reads, writes };
}

export const N = 7;
export const ARCS: Arc[] = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [2, 5], [5, 4], [6, 2]];
const POINTS: Array<[number, number]> = [[-260, 30], [-110, -70], [-110, 130], [40, 20], [210, 80], [60, 200], [-290, 200]];
const SIG = 'void dfs(int u)';
const W = 46;
const NAMES = ['白', '灰', '黑'];
const arcKey = (a: number, b: number) => `${a}>${b}`;

/** 文案从这里取值：每一步做了什么。 */
export interface DfsLog {
  dive: number[];
  firstDone: number[];
  skipped: Arc[];
  outerSkip: number[];
  restart: number[];
}

function build() {
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let phase = 0;
  const bucket = () => steps[phase];
  let ops = 0;
  const color: number[] = new Array(N).fill(WHITE);
  const order: Array<number | null> = new Array(N).fill(null);
  const rank: number[] = new Array(N).fill(0);
  let pos = N;
  let done = 0;
  const frames: TowerFrame[] = [];
  const treeArcs = new Set<string>();
  const log: DfsLog = { dive: [], firstDone: [], skipped: [], outerSkip: [], restart: [] };

  const graph = (tones: Record<number, Tone> = {}, arcTones: Record<string, Tone> = {}, lift: number[] = []): GraphPrim => {
    const nodes: GraphNode[] = POINTS.map(([x, y], index) => ({
      id: String(index), x, y, v: String(index),
      sub: color[index] === WHITE ? '未访问' : color[index] === GRAY ? '在栈上' : `第 ${rank[index]} 个完成`,
      tone: tones[index] ?? (color[index] === GRAY ? 'amber' : color[index] === BLACK ? 'green' : undefined),
      lift: lift.includes(index) || undefined,
    }));
    const edges: GraphEdge[] = ARCS.map(([a, b]) => ({ a: String(a), b: String(b), arrow: true, tone: arcTones[arcKey(a, b)] ?? (treeArcs.has(arcKey(a, b)) ? 'teal' : undefined) }));
    return { kind: 'graph', id: 'g', nodes, edges, r: 23 };
  };
  const tower = (): TowerPrim => ({ kind: 'tower', id: 'calls', frames: frames.map((frame, index) => ({ ...frame, tone: index === frames.length - 1 ? 'blue' as Tone : undefined })) });
  const colorRow = (lit?: number, tone: Tone = 'blue'): RowPrim => {
    const tones: Record<number, Tone> = {};
    color.forEach((value, index) => {
      if (value === GRAY) tones[index] = 'amber';
      if (value === BLACK) tones[index] = 'green';
    });
    if (lit !== undefined) tones[lit] = tone;
    return { kind: 'row', id: 'c', w: W, cells: cellsOf(color, { tones, lift: lit === undefined ? [] : [lit] }) };
  };
  const orderRow = (lit?: number): RowPrim => {
    const marks: DsMark[] = pos > 0 ? [{ at: pos - 1, text: 'pos', color: 'teal' }] : [];
    return { kind: 'row', id: 'o', w: W, cells: cellsOf(order, { tones: lit === undefined ? {} : { [lit]: 'green' }, rest: undefined }), marks };
  };
  const colorBytes = (notes: Record<number, string>, tint: Color = 'amber') => intArray('color', color, { color: tint, notes, shown: (value) => `${value}（${NAMES[value]}）`, summary: '0 白：未访问，1 灰：在调用栈上，2 黑：完成' });
  const orderBytes = (notes: Record<number, string>) => intArray('order', order, { color: 'green', notes, summary: `从末尾往前写，下一个位置是 ${pos - 1}` });

  const result = topoSort(N, ARCS, {
    check(s, c) {
      if (done > 0) phase = 3;
      ops++;
      if (done > 0 && c !== WHITE) log.outerSkip.push(s);
      const shown = colorRow(s, c === WHITE ? 'blue' : 'slate');
      bucket().push(state('prog', { 外层: `s = ${s}`, 当前: null }));
      bucket().push(pk('prog', 'array', c === WHITE ? 'blue' : 'slate', `color[${s}] = ${c}`, [c === WHITE ? '白色，从这里出发' : '已完成，跳过'], [ops, 'READ', `外层循环检查顶点 ${s}：color[${s}] = ${c}，${c === WHITE ? '还没访问，调用 dfs' : '已经访问过'}`, 4],
        wire(`color 数组，基址 ${hex(HEAP)}（E.G.）`, 'mem', 'abi', colorBytes({ [s]: c === WHITE ? '白色，没人访问过它。' : '已经是黑色。' }, c === WHITE ? 'blue' : 'slate')), { quick: s > 0, ds: { array: [shown] }, toAt: rowAim(shown, s) }));
    },
    enter(u, depth) {
      if (phase === 0) log.dive.push(u);
      if (phase === 3) log.restart.push(u);
      frames.push({ key: String(u), text: `dfs(${u})` });
      const shownTower = tower();
      bucket().push(pk('prog', 'stack', 'violet', `dfs(${u})`, [`深度 ${depth}`], [ops, 'CALL', `进入 dfs(${u})，调用栈 ${frames.length} 层`, 'reg'],
        wire('call 之前的寄存器', 'regs', 'abi', callRegs(SIG, [['u', u]], 'violet')), { quick: true, ds: { stack: [shownTower] }, toAt: towerAim(shownTower, frames.length - 1) }));
      color[u] = GRAY;
      ops++;
      const shown = colorRow(u, 'amber');
      bucket().push(state('prog', { 当前: String(u), 深度: String(depth) }));
      bucket().push(pk('prog', 'array', 'amber', `color[${u}] = 1`, ['标成灰色'], [ops, 'WRITE', `顶点 ${u} 标成灰色：正在处理，还在调用栈上`, 4],
        wire('color 数组', 'mem', 'abi', colorBytes({ [u]: '灰色。扫描时再遇到灰色顶点，就说明有环。' })), { quick: true, ds: { array: [shown], graph: [graph({}, {}, [u])] }, toAt: rowAim(shown, u) }));
    },
    scan(u, v, c) {
      if (phase === 1 && frames.length === 1) phase = 2;
      ops++;
      if (c === BLACK && phase === 2) log.skipped.push([u, v]);
      else treeArcs.add(arcKey(u, v));
      const tone: Tone = c === WHITE ? 'blue' : 'slate';
      const shown = graph({ [v]: c === WHITE ? 'blue' : c === GRAY ? 'amber' : 'slate' }, { [arcKey(u, v)]: tone }, [u]);
      const why = c === WHITE ? '白色，递归进去' : c === GRAY ? '灰色，有环' : '黑色，已经排好，跳过';
      bucket().push(pk('prog', 'graph', c === WHITE ? 'blue' : 'slate', `${u} → ${v}`, [why], [ops, 'READ', `${u} 的出边 ${u} → ${v}：color[${v}] = ${c}，${why}`, 4],
        wire('color 数组', 'mem', 'abi', colorBytes({ [v]: `${NAMES[c]}色。`, [u]: '当前顶点。' }, c === WHITE ? 'blue' : 'slate')), { quick: true, ds: { graph: [shown] }, toAt: graphAim(shown, String(v)) }));
    },
    finish(u, slot) {
      if (phase === 0) phase = 1;
      if (phase === 1) log.firstDone.push(u);
      color[u] = BLACK;
      order[slot] = u;
      pos = slot;
      rank[u] = ++done;
      ops += 2;
      const shownOrder = orderRow(slot);
      bucket().push(pk('prog', 'aux', 'green', `order[${slot}] = ${u}`, [`color[${u}] = 2`], [ops, 'WRITE', `${u} 的出边都看完了：标成黑色，写到 order[${slot}]`, 8],
        wire('color 和 order 两个数组', 'mem', 'abi', colorBytes({ [u]: '黑色：完成。' }, 'green'), orderBytes({ [slot]: `第 ${done} 个完成，所以排在倒数第 ${done} 位。` })),
        { quick: true, ds: { aux: [shownOrder], array: [colorRow(u, 'green')], graph: [graph({}, {}, [u])] }, toAt: rowAim(shownOrder, slot) }));
      const popped = frames.pop();
      if (popped?.key !== String(u)) throw new Error('调用栈不匹配');
      bucket().push(pk('stack', 'prog', 'slate', `返回 ${u}`, [frames.length ? `回到 dfs(${frames[frames.length - 1].key})` : '回到外层循环'], [ops, 'RET', `dfs(${u}) 返回，${frames.length ? `回到 dfs(${frames[frames.length - 1].key}) 继续看下一条出边` : '回到外层循环'}`, 'reg'],
        wire('ret 弹出 8 字节返回地址', 'regs', 'abi', registers('ret 之后', [['rip', TEXT_RET, 'call 压入的返回地址，ret 把它弹回 rip。', { example: true }]], 'slate')), { quick: true, ds: { stack: [tower()], graph: [graph()] } }));
    },
  });
  phase = 4;
  pos = 0;
  const finalGraph = graph();
  steps[4].push(state('prog', { 外层: null, 当前: null, 深度: null }));
  steps[4].push(note('aux', `拓扑序：${result.order.join(' ')}`, 'green'));
  steps[4].push(pk('aux', 'prog', 'green', '拓扑序', [result.order.join(' ')], [ops, 'READ', `order 从前往后读：${result.order.join(' ')}，每条边都从前指向后`, N * 4],
    wire('order 数组', 'mem', 'abi', orderBytes({ 0: '没有任何边指向它，可以排第一。' })), { ds: { aux: [orderRow()], graph: [finalGraph], array: [colorRow()] } }));
  steps[4].push(render);
  return { steps, result, ops, log };
}

const { steps, result, ops: totalOps, log } = build();
export const dfsRun = { result, log, ops: totalOps };
const lastDone = log.firstDone[0];
const indexIn = (vertex: number) => result.order.indexOf(vertex);
const allForward = ARCS.every(([a, b]) => indexIn(a) < indexIn(b));

const initialGraph: GraphPrim = {
  kind: 'graph', id: 'g', r: 23,
  nodes: POINTS.map(([x, y], index) => ({ id: String(index), x, y, v: String(index), sub: '未访问' })),
  edges: ARCS.map(([a, b]) => ({ a: String(a), b: String(b), arrow: true })),
};

export const dfsLesson: Lesson = {
  id: 'dfs',
  name: 'DFS',
  title: '深度优先',
  group: 'tree',
  layer: [3, 3],
  complexity: { best: 'O(V + E)，每个顶点进出一次', worst: 'O(V + E)，每条出边只看一次', note: '有向边只存一次，所以扫描次数等于边数。递归深度最坏是 V。' },
  opsUnit: '读写 color 和 order 的次数',
  nodes: ['prog', 'graph', 'stack', 'array', 'aux'],
  place: { prog: [100, 370], stack: [130, 100], graph: [630, 110], array: [430, 510], aux: [830, 500] },
  labels: {
    prog: ['程序', 'topo_sort'],
    graph: ['有向图', `${N} 个顶点，${ARCS.length} 条边`],
    stack: ['调用栈', '每层一个 dfs(u)'],
    array: ['颜色', `int color[${N}]`],
    aux: ['拓扑序', `int order[${N}]`],
  },
  labelAt: { graph: [290, -40], stack: [0, 76], array: [-200, 70], aux: [100, 110] },
  radius: { graph: 100, stack: 60, array: 40, aux: 40 },
  initial: {
    graph: [initialGraph],
    stack: [{ kind: 'tower', id: 'calls', frames: [] }],
    array: [{ kind: 'row', id: 'c', w: W, cells: cellsOf(new Array(N).fill(WHITE)) }],
    aux: [{ kind: 'row', id: 'o', w: W, cells: cellsOf(new Array(N).fill(null)), marks: [{ at: N - 1, text: 'pos', color: 'teal' }] }],
  },
  start: ['prog', 'graph', 'array', 'aux'],
  legend: [['violet', '递归调用'], ['amber', '标成灰色'], ['blue', '看出边'], ['green', '完成，写入 order'], ['slate', '返回或跳过'], [null, '操作数：读写 color 和 order']],
  overview: {
    full: '先走到底，回头时记下顺序',
    description: `深度优先搜索每到一个顶点，就沿着第一条没走过的边继续深入，走不下去再回头。回头的顺序正好给出拓扑排序：把有向无环图的顶点排成一列，让每条边都从前指向后，比如安排有先后依赖的课程。这一课在一张 ${N} 个顶点、${ARCS.length} 条边的有向图上真实运行，调用栈就是递归的现场。`,
    facts: [
      ['时间', 'O(V + E)'],
      ['三种颜色', '白：未访问，灰：在栈上，黑：完成'],
      ['拓扑序', '按完成时间倒过来排'],
      ['判环', '扫描到灰色顶点'],
      ['本例扫描', `${result.scanned} 次，等于 E`],
      ['最深', `${result.maxDepth} 层递归`],
    ],
  },
  steps: [
    {
      title: '一头扎到底',
      desc: `dfs(${log.dive.join(') → dfs(')})`,
      detail: `从 ${log.dive[0]} 出发，每到一个顶点先标成灰色，然后看它的第一条出边，目标是白色就立刻递归进去。调用栈一直长到 ${log.dive.length} 层，到 ${log.dive[log.dive.length - 1]} 才停下，因为它没有出边。BFS 用队列一层层往外扩，DFS 靠调用栈一条路走到底。`,
      facts: [['路径', log.dive.join(' → ')], ['调用栈', `${log.dive.length} 层`], ['灰色', '正在处理，还在栈上']],
      events: [type('./topo'), show('stack'), ...steps[0]],
    },
    {
      title: '完成就记下来',
      desc: `${log.firstDone.join('、')} 依次完成，从 order 末尾往前写`,
      detail: `一个顶点的出边全部看完，它就完成了：标成黑色，写到 order 里从末尾往前数的下一个空位。${lastDone} 没有出边，最先完成，放在最后一格。一个顶点完成时，从它出发能到的顶点都已经完成，排在它后面，所以它的出边都指向后面。`,
      facts: [['完成顺序', log.firstDone.join(' → ')], ['写入位置', `order[${N - 1}] 往前`], ['黑色', '完成，不会再进']],
      events: steps[1],
    },
    {
      title: '已完成的不再进',
      desc: `${log.skipped.map(([a, b]) => `${a} → ${b}`).join('、')} 指向黑色顶点`,
      detail: `回到 ${log.dive[0]} 之后看下一条出边，进入新的分支。${log.skipped.map(([a, b]) => `${a} → ${b}`).join(' 和 ')} 指向的顶点已经是黑色，它们和后面的顶点都已排好，直接跳过。dfs(${log.dive[0]}) 返回时，从 ${log.dive[0]} 能到的顶点全部完成。`,
      facts: [['跳过的边', log.skipped.map(([a, b]) => `${a} → ${b}`).join('，')], ['每条边', '只看一次'], ['调用栈', '回到外层循环']],
      events: steps[2],
    },
    {
      title: '外层循环',
      desc: `${log.restart[0]} 没有入边，要从外面进入`,
      detail: `只从 ${log.dive[0]} 出发，${log.restart[0]} 永远不会被访问，因为没有边指向它。所以外层循环按编号检查每个顶点，${log.outerSkip.join('、')} 已经是黑色，跳过，${log.restart[0]} 是白色，从它再开始一次。它的出边指向黑色顶点，${log.restart[0]} 马上完成，写进 order[0]。`,
      facts: [['跳过', log.outerSkip.join(', ')], ['重新出发', String(log.restart[0])], ['order[0]', String(result.order[0])]],
      events: steps[3],
    },
    {
      title: '拓扑序',
      desc: result.order.join(' '),
      detail: `order 从前往后读就是拓扑序，${allForward ? '本例每条边都从前面的顶点指向后面的' : '但这张图有环'}。如果扫描时碰到灰色顶点，说明这条边指回了调用栈上的祖先，图里有环，就不存在拓扑序。本例扫描 ${result.scanned} 次边，正好等于边数，每个顶点进出各一次，总代价 O(V + E)。`,
      facts: [['拓扑序', result.order.join(' ')], ['完成顺序', result.finished.join(' ')], ['扫描边', String(result.scanned)], ['总操作数', String(totalOps)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '回头的顺序就是依赖的顺序',
    desc: '递归替你记住了来路',
    text: '递归写法简洁，但图很大时调用栈可能溢出，这时改用显式的栈模拟同样的过程。DFS 还能找强连通分量、桥和割点，它们都要用到顶点什么时候进入、什么时候完成。构建工具安排编译顺序，用的就是拓扑排序。',
    facts: [['时间', 'O(V + E)'], ['空间', 'O(V)'], ['下一课', 'DIJKSTRA']],
  },
};
