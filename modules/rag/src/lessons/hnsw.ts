/**
 * 向量检索组第三课：HNSW（分层可导航小世界图）。给 27 个段落抽层数，按顺序插入建图（M = 4、efConstruction = 8），
 * 细看一个节点的插入：上层贪心下降、下层用 efConstruction 个候选、启发式挑邻居；然后查询从顶层贪心下降到第 0 层，
 * ef = 3 时停在局部、漏掉 cup#1，ef = 8 找回来；最后在 1000 个合成向量上用 M = 16、efConstruction = 40 建图，比较各家默认的 ef。
 *
 * 全部由 core/ 实时计算：drawLevels、emptyHnsw、insertHnsw、hnswSearch、edgesOf。tests/narrative.index.test.ts 核对文案。
 */
import {
  BENCH_K,
  BENCH_N,
  BENCH_QUERIES,
  BENCH_TRUTH,
  BENCH_VECTORS,
  buildHnsw,
  DistanceMeter,
  drawLevels,
  edgesOf,
  embedVector,
  emptyHnsw,
  EVAL_SET,
  exactTopK,
  hnswSearch,
  insertHnsw,
  meanRecall,
  PARAGRAPH_VECTORS,
  recallAtK,
  type HnswGraph,
  type HnswSearch,
  type InsertTrace,
} from '../core';
import { concept, floatVector, num, thousands, wire } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import { i64Bytes, idOf, layerId, pid, queryNode, searchOutput, shortName, spaceGraph } from './index-common';
import type { DsCell, GraphEdge, GridPrim, Lesson, RowPrim, Tone, TowerPrim } from './types';

// ---------- 建图 ----------

export const N = PARAGRAPH_VECTORS.length;
export const DIM = PARAGRAPH_VECTORS[0].length;
export const M = 4;
export const EF_CONSTRUCTION = 8;
export const SEED = 1;
export const K = 3;
export const ML = 1 / Math.log(M);

export const levels = drawLevels(N, ML, SEED);
export const maxLevel = Math.max(...levels);
/** 每一层有几个节点（第 l 层包含所有层数 ≥ l 的节点）。 */
export const layerSizes = Array.from({ length: maxLevel + 1 }, (_, l) => levels.filter((x) => x >= l).length);

export const meter = new DistanceMeter();
export const graph: HnswGraph = emptyHnsw(levels, { M, efConstruction: EF_CONSTRUCTION, mL: ML });

/** 细看的那次插入：第一个层数 ≥ 1、插入时图里已经有一半以上节点的节点。 */
export const FOCUS = levels.findIndex((level, i) => level >= 1 && i >= N / 2);
const traces: InsertTrace[] = [];
for (let node = 0; node < FOCUS; node++) traces.push(insertHnsw(graph, PARAGRAPH_VECTORS, node, meter));
export const beforeFocus = meter.total;
export const edgesBefore = edgesOf(graph, 0);
export const focus = insertHnsw(graph, PARAGRAPH_VECTORS, FOCUS, meter);
export const afterFocus = meter.total;
export const edgesAfterFocus = edgesOf(graph, 0);
for (let node = FOCUS + 1; node < N; node++) traces.push(insertHnsw(graph, PARAGRAPH_VECTORS, node, meter));
export const afterBuild = meter.total;
export const layerEdges = Array.from({ length: maxLevel + 1 }, (_, l) => edgesOf(graph, l));

/** 细看的插入在每一层：搜索到的候选、挑中的邻居、被启发式跳过的候选。 */
export const focusLayers = focus.links.map((link) => {
  const visit = focus.visits.find((v) => v.layer === link.layer)!;
  return { layer: link.layer, candidates: visit.result, chosen: link.neighbors, skipped: visit.result.filter((c) => !link.neighbors.includes(c)), pruned: link.pruned };
});
export const greedyLayers = focus.visits.filter((v) => v.layer > focus.level);

/** 一次搜索里新算的距离：同一次搜索里每个节点只算一次，上一层算过的不再算。 */
const newIn = (visits: InsertTrace['visits']) => {
  const seen = new Set<number>();
  return visits.map((v) => {
    const fresh = v.visited.filter((x) => !seen.has(x.node));
    fresh.forEach((x) => seen.add(x.node));
    return fresh.length;
  });
};
/** 贪心下降结束时的累计距离：上面几层新算的节点数。 */
export const afterGreedy = beforeFocus + newIn(greedyLayers).reduce((sum, x) => sum + x, 0);

// ---------- 查询 ----------

const ITEM = EVAL_SET.find((item) => item.id === 'leak')!;
export const QUESTION = ITEM.question;
export const q = embedVector(QUESTION);
export const truth = exactTopK(PARAGRAPH_VECTORS, q, K);

export const EF_SMALL = K;
export const EF_LARGE = 8;
export const small = hnswSearch(graph, PARAGRAPH_VECTORS, q, K, EF_SMALL, meter);
export const afterSmall = meter.total;
export const recallSmall = recallAtK(small.hits.map((hit) => hit.id), truth, K);
export const missed = truth.filter((id) => !small.hits.some((hit) => hit.id === id));
export const large = hnswSearch(graph, PARAGRAPH_VECTORS, q, K, EF_LARGE, meter);
export const afterLarge = meter.total;
export const recallLarge = recallAtK(large.hits.map((hit) => hit.id), truth, K);

export const EVAL_EFS = [EF_SMALL, EF_LARGE, 16] as const;
export const evalRuns = EVAL_EFS.map((ef) => {
  const before = meter.total;
  const pairs = EVAL_SET.map((item) => {
    const v = embedVector(item.question);
    return { found: hnswSearch(graph, PARAGRAPH_VECTORS, v, K, ef, meter).hits.map((hit) => hit.id), truth: exactTopK(PARAGRAPH_VECTORS, v, K) };
  });
  return { ef, recall: meanRecall(pairs, K), perQuery: (meter.total - before) / EVAL_SET.length };
});
export const afterEval = meter.total;

// ---------- 规模 ----------

/** M = 16（hnswlib、pgvector、Qdrant 的默认值），efConstruction = 40（FAISS 的默认值）。 */
export const BENCH_M = 16;
export const BENCH_EFC = 40;
export const benchGraph = buildHnsw(BENCH_VECTORS, { M: BENCH_M, efConstruction: BENCH_EFC, seed: SEED }, meter);
export const afterBenchBuild = meter.total;
export const benchBuild = afterBenchBuild - afterEval;
/** 各家查询时 ef 的默认值：hnswlib 10、FAISS 16、pgvector 40。 */
export const BENCH_EFS = [
  { ef: 10, who: 'hnswlib' },
  { ef: 16, who: 'FAISS' },
  { ef: 40, who: 'pgvector' },
] as const;
export const benchRuns = BENCH_EFS.map(({ ef, who }) => {
  const before = meter.total;
  const pairs = BENCH_QUERIES.map((query, i) => ({ found: hnswSearch(benchGraph, BENCH_VECTORS, query, BENCH_K, ef, meter).hits.map((hit) => hit.id), truth: BENCH_TRUTH[i] }));
  return { ef, who, recall: meanRecall(pairs, BENCH_K), perQuery: (meter.total - before) / BENCH_QUERIES.length };
});
export const afterBench = meter.total;
/** FAISS 文档里 IndexHNSWFlat 每个向量的字节数：4 × d + M × 2 × 4。 */
export const benchBytesPerVector = 4 * DIM + BENCH_M * 2 * 4;

// ---------- 显示 ----------

const name = (i: number) => shortName(i);
const r2 = (x: number) => fixed(x, 2);
const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const bare = (text: string) => text.replace(/？$/, '');
/** 层的颜色：第 0 层 teal，往上 violet、green、slate。 */
const LAYER_TONE: Tone[] = ['teal', 'violet', 'green', 'slate'];
const toneOfLevel = (level: number): Tone => LAYER_TONE[Math.min(level, LAYER_TONE.length - 1)];

const edgeList = (pairs: ReadonlyArray<[number, number]>, tone?: Tone): GraphEdge[] => pairs.map(([a, b]) => ({ a: pid(a), b: pid(b), tone }));

/** 第 layer 层：这一层的节点按最高层上色，别的节点变暗；边是这一层的边。 */
function layerSpace(layer: number, options: { edges?: ReadonlyArray<[number, number]>; lift?: number[]; tones?: Record<number, Tone>; query?: boolean; only?: number[]; marks?: ReturnType<typeof spaceGraph>['marks'] } = {}) {
  const tones: Record<number, Tone> = {};
  levels.forEach((level, i) => (tones[i] = options.tones?.[i] ?? (level >= layer ? toneOfLevel(level) : 'dim')));
  return spaceGraph({ tones, lift: options.lift, edges: edgeList(options.edges ?? layerEdges[layer] ?? []), extra: options.query ? [queryNode(q)] : [], only: options.only, marks: options.marks });
}

/** 层的塔：从第 0 层往上摞，当前层高亮。 */
function layerTower(active?: number): TowerPrim {
  return {
    kind: 'tower',
    id: 'layers',
    frames: layerSizes.map((size, l) => ({ key: `L${l}`, text: `第 ${l} 层 · ${size} 个`, tone: active === undefined ? toneOfLevel(l) : l === active ? PART_TONE.result : toneOfLevel(l) })),
  };
}

function resultRow(search: HnswSearch): RowPrim {
  return { kind: 'row', id: 'r', w: 60, cells: search.hits.map((hit): DsCell => ({ v: name(hit.id), key: `r${hit.id}`, tone: truth.includes(hit.id) ? PART_TONE.result : 'slate', sub: r2(hit.score) })) };
}

function recallRow(values: Array<[string, number]>): RowPrim {
  return { kind: 'row', id: 'rc', w: 64, cells: values.map(([label, value]): DsCell => ({ v: pctOf(value), key: label, tone: value >= 1 ? 'green' : 'amber', sub: label, heat: value })) };
}

function benchGrid(): GridPrim {
  return {
    kind: 'grid',
    id: 'b',
    w: 50,
    rows: [...benchRuns.map((run) => `ef ${run.ef}`), 'Flat'],
    cols: ['距离', '召回率'],
    cells: [
      ...benchRuns.map((run): DsCell[] => [{ v: String(Math.round(run.perQuery)), tone: PART_TONE.result }, { v: pctOf(run.recall), tone: run.recall >= 1 ? 'green' : 'amber', heat: run.recall }]),
      [{ v: String(BENCH_N), tone: 'slate' }, { v: '100%', tone: 'green', heat: 1 }],
    ],
  };
}

// ---------- 字节 ----------

/** 一个节点的邻接表：每层先是邻居个数，再是邻居 id（int64）。摆法是本站的示意，hnswlib、FAISS 各有自己的布局（internal）。 */
function adjacencyLayer(node: number, g: HnswGraph = graph): LayerWriter {
  const layer = new LayerWriter(layerId(), `${name(node)} ${idOf(node)} 的邻接表`, 'teal', `最高第 ${g.levels[node]} 层，每层：个数（int32）+ 邻居 id（int64）`);
  for (let l = g.levels[node]; l >= 0; l--) {
    const list = g.neighbors[l].get(node) ?? [];
    layer.field(`第 ${l} 层 · 个数`, String(list.length), () => layer.u32(list.length), { note: `上限：${l === 0 ? `第 0 层 2M = ${g.Mmax0}` : `M = ${g.M}`}。` });
    list.forEach((other, i) => layer.field(`第 ${l} 层 · [${i}]`, `${other}（${name(other)}）`, () => layer.raw(i64Bytes(other)), { note: `${idOf(other)}。` }));
  }
  return layer;
}

const visitConcept = (title: string, visits: HnswSearch['visits']) =>
  concept(title, visits.map((v): [string, string, string] => [`第 ${v.layer} 层`, `算了 ${v.visited.length} 个 → ${v.result.slice(0, 3).map((i) => name(i)).join('、')}${v.result.length > 3 ? '…' : ''}`, `从 ${v.entry.map((i) => name(i)).join('、')} 出发：${v.visited.map((x) => `${name(x.node)} ${r2(x.dist)}`).join('，')}。`]), 'violet');

export const smallPerLayer = newIn(small.visits);
export const largePerLayer = newIn(large.visits);

const layerOf = (search: HnswSearch, layer: number) => search.visits.find((v) => v.layer === layer)!;
const bottomSmall = layerOf(small, 0);
/** 第 0 层的画法：没走到的变暗，走过的保留层的颜色，结果 amber。 */
const walked = (visit: HnswSearch['visits'][number], search: HnswSearch): Record<number, Tone> => {
  const seen = new Set(visit.visited.map((x) => x.node));
  return { ...Object.fromEntries(levels.map((_, i) => [i, seen.has(i) ? toneOfLevel(levels[i]) : 'dim'])), ...Object.fromEntries(search.hits.map((hit) => [hit.id, PART_TONE.result])) };
};

// ---------- 课程 ----------

const f = focusLayers;
const f0 = f.find((x) => x.layer === 0)!;
const upper = levels.flatMap((level, i) => (level >= 1 ? [i] : []));

export const hnsw: Lesson = {
  id: 'hnsw',
  name: 'HNSW INDEX',
  title: 'HNSW：分层图的插入与查询',
  group: 'index',
  layer: [3, 5],
  layerNote: '把向量连成一张分层的图（索引），查询沿着边从顶层一路走到最近的点（检索）。',
  distNote: `建图时每个新节点和它在图里碰到的节点比，${N} 个节点一共 ${afterBuild} 次；查询只算走过的节点；最后在 ${BENCH_N} 个合成向量上建图再查，一共 ${thousands(afterBench)} 次。`,
  nodes: ['app', 'index', 'space', 'vectors', 'results', 'scores'],
  place: { app: [100, 130], index: [430, 110], vectors: [880, 170], space: [480, 570], results: [1010, 450], scores: [1070, 730] },
  labels: {
    app: ['应用', 'index.search(q, k)'],
    index: ['向量库', `HNSW：M = ${M}`],
    vectors: ['分层', '越往上节点越少'],
    space: ['向量空间', `当前层的节点和边（平面示意）`],
    results: ['前 k 个', '括号外是平方距离'],
    scores: ['召回率@3', '和 Flat 的结果比'],
  },
  labelAt: { vectors: [0, 80], space: [0, 245], results: [0, 75], scores: [0, 150] },
  radius: { vectors: 90, space: 200, results: 60, scores: 70 },
  initial: { vectors: [], space: [spaceGraph({ rest: 'dim' })], results: [], scores: [] },
  start: ['app', 'index', 'space'],
  legend: [['teal', '只在第 0 层'], ['violet', '到第 1 层'], ['green', '到第 2 层'], ['slate', '到第 3 层'], ['amber', '新节点的邻居 / 检索结果'], [null, '距离列：累计算了几次距离']],
  overview: {
    full: '沿着图一路走到最近的点',
    description: `HNSW 不分簇，而是把向量连成一张图：每个点连着几个近邻，查询从一个入口出发，每一步走到离查询更近的邻居。为了走得快，图分成几层，越往上点越少、边越长，像高速公路。这一课用 M = ${M} 把 ${N} 个段落建成 ${maxLevel + 1} 层（${afterBuild} 次距离），查询「${bare(QUESTION)}」在 ef = ${EF_SMALL} 时只算 ${small.computed} 次却漏掉了 ${idOf(missed[0])}，ef = ${EF_LARGE} 时 ${large.computed} 次找全；到 ${BENCH_N} 个向量时每次只要 ${Math.round(benchRuns[0].perQuery)} 次左右。`,
    facts: [
      ['论文', 'Malkov、Yashunin，arXiv 1603.09320'],
      ['M', `${M}（每层新连的边数）`],
      ['efConstruction', String(EF_CONSTRUCTION)],
      ['层数', `${maxLevel + 1} 层：${layerSizes.slice().reverse().join(' / ')} 个`],
      ['查询', `ef = ${EF_SMALL}：${small.computed} 次；ef = ${EF_LARGE}：${large.computed} 次`],
    ],
  },
  steps: [
    {
      title: '给每个节点抽层数',
      desc: `${maxLevel + 1} 层，每层 ${layerSizes.join(' / ')} 个`,
      detail: `每个节点入库前先抽一个最高层 l = ⌊−ln(U) × mL⌋，U 是 0 到 1 之间的均匀随机数，mL = 1 / ln(M) = ${num(ML, 3)}，这是论文建议的取值，hnswlib 和 FAISS 也这样取。层数越高概率越小，大约每往上一层只剩 1/M：${N} 个段落里 ${layerSizes[1]} 个到了第 1 层，${layerSizes[2] ?? 0} 个到了第 2 层，${idOf(levels.indexOf(maxLevel))} 一个到了第 ${maxLevel} 层，它会成为全图的入口。每个节点出现在 0 到 l 的每一层里，所以第 0 层有全部 ${N} 个。`,
      facts: [['mL', `1 / ln ${M} = ${num(ML, 3)}`], ...layerSizes.map((size, l): [string, string] => [`第 ${l} 层`, `${size} 个${l > 0 ? `：${levels.flatMap((x, i) => (x >= l ? [name(i)] : [])).join('、')}` : ''}`]).reverse().slice(0, 3)],
      events: [
        show('vectors'),
        pk('index', 'vectors', 'slate', '抽层数', layerSizes.map((size, l) => `第 ${l} 层：${size} 个`).reverse(), [0, 'INDEX', `${N} 个节点各抽一个最高层 ⌊−ln(U) × ${num(ML, 3)}⌋：${layerSizes.map((size, l) => `第 ${l} 层 ${size} 个`).join('，')}`, null],
          wire('每个节点的最高层', 'vals', '示意', concept('层数', upper.map((i): [string, string, string] => [`${name(i)} ${idOf(i)}`, `第 ${levels[i]} 层`, `出现在第 0 到第 ${levels[i]} 层。`]).concat([['其余', `${N - upper.length} 个 · 第 0 层`, '只在最底层。']]), 'slate')),
          { ds: { vectors: [layerTower()], space: [spaceGraph({ tones: Object.fromEntries(levels.map((level, i) => [i, toneOfLevel(level)])), lift: upper })] } }),
        state('index', { M: String(M), efC: String(EF_CONSTRUCTION), 层: String(maxLevel + 1) }),
      ],
    },
    {
      title: `插入 ${name(FOCUS)}：先下降，再挑邻居`,
      desc: `这一个插入算了 ${focus.distances} 次距离`,
      detail: `节点按入库顺序一个个插入，前 ${FOCUS} 个已经连好（${beforeFocus} 次距离）。${name(FOCUS)}（${idOf(FOCUS)}）抽到第 ${focus.level} 层：从入口出发，在第 ${focus.maxLevel} 到第 ${focus.level + 1} 层每层只留 1 个最近的点（贪心下降），到第 ${focus.level} 层以下改成留 efConstruction = ${EF_CONSTRUCTION} 个候选。第 0 层的 ${f0.candidates.length} 个候选里只挑了 ${f0.chosen.length} 个邻居（${f0.chosen.map((i) => name(i)).join('、')}）：论文的启发式只在候选离新节点比离已选的每个邻居都近时才选它，让边指向不同的方向，${f0.skipped.length} 个候选被跳过。`,
      facts: [['最高层', `第 ${focus.level} 层`], ['下降', greedyLayers.map((v) => `第 ${v.layer} 层 ${v.visited.length} 个`).join('，')], ...f.map((x): [string, string] => [`第 ${x.layer} 层邻居`, `${x.chosen.map((i) => name(i)).join('、')}（候选 ${x.candidates.length} 个）`]), ['距离计算', `${focus.distances} 次`]],
      events: [
        pk('index', 'space', 'teal', `先插入 ${FOCUS} 个`, [`${edgesBefore.length} 条边`, `${beforeFocus} 次距离`], [beforeFocus, 'INDEX', `按入库顺序插入前 ${FOCUS} 个节点：第 0 层 ${edgesBefore.length} 条边，${beforeFocus} 次距离`, null],
          wire('前面的插入', 'vals', '示意', concept('每次插入算了几次距离', traces.slice(0, FOCUS).map((t): [string, string, string] => [`${t.node} · ${name(t.node)}`, `${t.distances} 次`, t.links.map((l) => `第 ${l.layer} 层连 ${l.neighbors.map((i) => name(i)).join('、') || '—'}`).join('；') || '第一个节点，直接成为入口。']), 'teal')),
          { ds: { space: [layerSpace(0, { edges: edgesBefore, tones: Object.fromEntries(levels.map((_, i) => [i, i < FOCUS ? 'teal' : 'dim'])) })] } }),
        pk('index', 'space', 'amber', `${name(FOCUS)} 贪心下降`, greedyLayers.map((v) => `第 ${v.layer} 层 → ${name(v.result[0])}`), [afterGreedy, 'INDEX', `${idOf(FOCUS)} 抽到第 ${focus.level} 层：从入口 ${name(focus.entry)} 出发，第 ${greedyLayers.map((v) => v.layer).join('、')} 层各留 1 个最近的`, null],
          wire('上层：ef = 1 的贪心下降', 'vals', '示意', visitConcept('每层的搜索', greedyLayers)),
          { ds: { vectors: [layerTower(greedyLayers[greedyLayers.length - 1]?.layer)], space: [layerSpace(greedyLayers[greedyLayers.length - 1]?.layer ?? 1, { edges: [], lift: [FOCUS, ...greedyLayers.map((v) => v.result[0])], tones: { [FOCUS]: PART_TONE.result } })] } }),
        pk('index', 'space', 'amber', `挑邻居`, f.map((x) => `第 ${x.layer} 层：${x.chosen.map((i) => name(i)).join('、')}`), [afterFocus, 'INDEX', `第 ${f.map((x) => x.layer).join('、')} 层用 ${EF_CONSTRUCTION} 个候选搜索，启发式挑出 ${f.map((x) => x.chosen.length).join('、')} 个邻居，连双向边；这次插入共 ${focus.distances} 次距离`, 8 * f0.chosen.length],
          wire(`${name(FOCUS)} 连好以后的邻接表（本站的写法）`, 'mem', 'internal', adjacencyLayer(FOCUS)),
          { ds: { vectors: [layerTower(0)], space: [layerSpace(0, { edges: edgesAfterFocus, lift: [FOCUS, ...f0.candidates], tones: { ...Object.fromEntries(levels.map((_, i) => [i, 'dim'])), ...Object.fromEntries(f0.skipped.map((i) => [i, 'teal' as Tone])), ...Object.fromEntries(f0.chosen.map((i) => [i, PART_TONE.result])), [FOCUS]: 'blue' } })] } }),
        note('space', `${f0.candidates.length} 个候选只连 ${f0.chosen.length} 个`, 'amber'),
        pk('index', 'space', 'teal', `插完 ${N} 个`, layerEdges.map((e, l) => `第 ${l} 层 ${e.length} 条边`), [afterBuild, 'INDEX', `剩下的 ${N - FOCUS - 1} 个节点依次插入：建图一共 ${afterBuild} 次距离，各层 ${layerEdges.map((e) => e.length).join(' / ')} 条边`, null],
          wire('建好的图', 'vals', '示意', concept('每层的边', layerEdges.map((e, l): [string, string, string] => [`第 ${l} 层`, `${layerSizes[l]} 个节点 · ${e.length} 条边`, l === 0 ? `度数上限 2M = ${2 * M}。` : `度数上限 M = ${M}。`]), 'teal')),
          { ds: { vectors: [layerTower()], space: [layerSpace(0)] } }),
        state('index', { M: String(M), efC: String(EF_CONSTRUCTION), 层: String(maxLevel + 1), 入口: name(graph.entry) }),
      ],
    },
    {
      title: `查询：从第 ${maxLevel} 层往下走`,
      desc: `ef = ${EF_SMALL}，${small.computed} 次，漏掉 ${name(missed[0])}`,
      detail: `查询「${bare(QUESTION)}」从入口 ${name(graph.entry)} 出发，上面几层节点少、边长，每层只留 1 个最近的点，${small.visits.filter((v) => v.layer > 0).map((v) => `第 ${v.layer} 层新算 ${smallPerLayer[small.visits.indexOf(v)]} 个`).join('，')}，落到 ${name(bottomSmall.entry[0])}。第 0 层用 ef = ${EF_SMALL} 个候选做最佳优先搜索，新算 ${smallPerLayer[smallPerLayer.length - 1]} 个就停了：下一个要展开的候选已经比结果里最远的那个还远。一共 ${small.computed} 次距离，Flat 要 ${N} 次，但结果 ${small.hits.map((hit) => name(hit.id)).join('、')} 漏掉了真正最近的 ${idOf(missed[0])}，召回率@${K} = ${pctOf(recallSmall)}。`,
      facts: [...small.visits.map((v, i): [string, string] => [`第 ${v.layer} 层`, `新算 ${smallPerLayer[i]} 个 → ${v.result.slice(0, 3).map((x) => name(x)).join('、')}`]), ['合计', `${small.computed} 次`]],
      events: [
        type(`index.hnsw.efSearch = ${EF_SMALL}; index.search(q, k=${K})`),
        pk('app', 'index', 'blue', `search(q, k=${K})`, [`ef = ${EF_SMALL}`], [afterBuild, 'SEARCH', `查询「${QUESTION}」，ef = ${EF_SMALL}`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', q, 'f32', { color: 'blue', digits: 3 })),
          { ds: { space: [layerSpace(maxLevel, { query: true, edges: [] })] } }),
        ...small.visits.filter((v) => v.layer > 0).map((v) => {
          const i = small.visits.indexOf(v);
          const done = afterBuild + smallPerLayer.slice(0, i + 1).reduce((s, x) => s + x, 0);
          return pk('index', 'space', 'violet', `第 ${v.layer} 层`, [`新算 ${smallPerLayer[i]} 个`, `→ ${name(v.result[0])}`], [done, 'SEARCH', `第 ${v.layer} 层：从 ${name(v.entry[0])} 出发，看了 ${v.visited.map((x) => name(x.node)).join('、')}（新算 ${smallPerLayer[i]} 个），最近的是 ${name(v.result[0])}（${r2(v.visited.find((x) => x.node === v.result[0])!.dist)}）`, null],
            wire(`第 ${v.layer} 层的贪心搜索`, 'vals', '示意', visitConcept('ef = 1', [v])),
            { ds: { vectors: [layerTower(v.layer)], space: [layerSpace(v.layer, { query: true, lift: v.visited.map((x) => x.node), tones: { [v.result[0]]: PART_TONE.result } })] } });
        }),
        show('results'),
        pk('index', 'space', 'amber', `第 0 层，ef = ${EF_SMALL}`, [`新算 ${smallPerLayer[smallPerLayer.length - 1]} 个`, small.hits.map((hit) => name(hit.id)).join('、')], [afterSmall, 'SEARCH', `第 0 层从 ${name(bottomSmall.entry[0])} 出发，ef = ${EF_SMALL}：新算 ${smallPerLayer[smallPerLayer.length - 1]} 个后停下，结果 ${small.hits.map((hit) => idOf(hit.id)).join('、')}`, null],
          wire('第 0 层的最佳优先搜索', 'vals', '示意', visitConcept(`ef = ${EF_SMALL}`, [bottomSmall])),
          { ds: { vectors: [layerTower(0)], results: [resultRow(small)], space: [layerSpace(0, { query: true, lift: bottomSmall.visited.map((x) => x.node), tones: walked(bottomSmall, small), marks: [{ at: pid(missed[0]), text: `${name(missed[0])} 最近，没走到`, color: 'amber' }] })] } }),
        show('scores'),
        pk('index', 'app', 'amber', `前 ${K} 个`, small.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [afterSmall, 'CALL', `返回 ${small.hits.map((hit) => idOf(hit.id)).join('、')}，召回率@${K} = ${pctOf(recallSmall)}`, K * 12],
          wire('search() 的输出（平方距离）', 'mem', 'internal', ...searchOutput(small.hits, K, { metric: 'l2' })),
          { ds: { scores: [recallRow([[`ef ${EF_SMALL}`, recallSmall]])] } }),
        note('space', `ef = ${EF_SMALL} 太小，停在局部`, 'amber'),
      ],
    },
    {
      title: `ef = ${EF_LARGE}：多留几个候选`,
      desc: `${large.computed} 次，召回率 ${pctOf(recallLarge)}`,
      detail: `ef 是第 0 层候选表的大小，也是查询时唯一要调的旋钮：候选表大，搜索就不会太早停下。ef = ${EF_LARGE} 时第 0 层新算 ${largePerLayer[largePerLayer.length - 1]} 个，一共 ${large.computed} 次，${idOf(missed[0])} 回到第 1 名，召回率@${K} = ${pctOf(recallLarge)}。评估集 ${EVAL_SET.length} 个问题在 ef = ${evalRuns.map((r) => r.ef).join('、')} 时平均召回率是 ${evalRuns.map((r) => pctOf(r.recall)).join('、')}，每次平均算 ${evalRuns.map((r) => num(r.perQuery, 1)).join('、')} 次；只有 ${N} 个点时 ef 一大就几乎走遍全图，HNSW 的好处要在点多的时候才显出来。`,
      facts: [['第 0 层', `新算 ${largePerLayer[largePerLayer.length - 1]} 个`], ['合计', `${large.computed} 次`], ...evalRuns.map((r): [string, string] => [`评估集 ef ${r.ef}`, `${pctOf(r.recall)}，每次 ${num(r.perQuery, 1)} 次`])],
      events: [
        type(`index.hnsw.efSearch = ${EF_LARGE}; index.search(q, k=${K})`),
        pk('index', 'space', 'amber', `第 0 层，ef = ${EF_LARGE}`, [`新算 ${largePerLayer[largePerLayer.length - 1]} 个`, large.hits.map((hit) => name(hit.id)).join('、')], [afterLarge, 'SEARCH', `ef = ${EF_LARGE}：上面几层一样，第 0 层新算 ${largePerLayer[largePerLayer.length - 1]} 个，一共 ${large.computed} 次，结果 ${large.hits.map((hit) => idOf(hit.id)).join('、')}`, null],
          wire('第 0 层的最佳优先搜索', 'vals', '示意', visitConcept(`ef = ${EF_LARGE}`, [layerOf(large, 0)])),
          { ds: { results: [resultRow(large)], scores: [recallRow([[`ef ${EF_SMALL}`, recallSmall], [`ef ${EF_LARGE}`, recallLarge]])], space: [layerSpace(0, { query: true, lift: layerOf(large, 0).visited.map((x) => x.node), tones: walked(layerOf(large, 0), large) })] } }),
        pk('app', 'index', 'slate', `评估集 × ef ${EVAL_EFS.join('/')}`, evalRuns.map((r) => `ef ${r.ef}：${pctOf(r.recall)}`), [afterEval, 'EVAL', `${EVAL_SET.length} 个评估问题分别用 ef ${EVAL_EFS.join('、')} 查：平均召回率@${K} ${evalRuns.map((r) => pctOf(r.recall)).join('、')}，每次 ${evalRuns.map((r) => num(r.perQuery, 1)).join('、')} 次`, null],
          wire('ef 和召回率', 'vals', '示意', concept('评估集', evalRuns.map((r): [string, string, string] => [`ef = ${r.ef}`, `${pctOf(r.recall)} · ${num(r.perQuery, 1)} 次`, `${EVAL_SET.length} 个问题的平均；标准答案是 Flat 的前 ${K} 个。`]), 'green')),
          { ds: { scores: [recallRow(evalRuns.map((r) => [`ef ${r.ef}`, r.recall]))] } }),
        note('scores', 'ef 越大越准，也越慢', 'green'),
      ],
    },
    {
      title: `放大到 ${BENCH_N} 个向量`,
      desc: `ef = ${benchRuns[0].ef} 每次 ${Math.round(benchRuns[0].perQuery)} 次，召回率 ${pctOf(benchRuns[0].recall)}`,
      detail: `在 ${BENCH_N} 个合成向量上用 M = ${BENCH_M}、efConstruction = ${BENCH_EFC} 建图，花了 ${thousands(benchBuild)} 次距离，内存按 FAISS 文档每个向量 4 × d + M × 2 × 4 = ${benchBytesPerVector} 字节，是 Flat 的 ${benchBytesPerVector / (4 * DIM)} 倍。查询时 ef = ${benchRuns.map((r) => r.ef).join('、')} 平均算 ${benchRuns.map((r) => Math.round(r.perQuery)).join('、')} 次，召回率@${BENCH_K} 都是 ${benchRuns.every((r) => r.recall === benchRuns[0].recall) ? pctOf(benchRuns[0].recall) : benchRuns.map((r) => pctOf(r.recall)).join('、')}，Flat 是 ${BENCH_N} 次。各家默认值不同：hnswlib M 16、ef_construction 200、ef 10；FAISS 的 efConstruction 40、efSearch 16，M 由 IndexHNSWFlat 的构造参数给；pgvector m 16、ef_construction 64、hnsw.ef_search 40；Qdrant m 16、ef_construct 100，查询的 ef 默认等于 ef_construct。`,
      facts: [['建图', `${thousands(benchBuild)} 次距离`], ...benchRuns.map((r): [string, string] => [`ef ${r.ef}（${r.who}）`, `${Math.round(r.perQuery)} 次 · ${pctOf(r.recall)}`]), ['每个向量', `${benchBytesPerVector} 字节（Flat ${4 * DIM}）`]],
      events: [
        pk('app', 'index', 'violet', `建图 M = ${BENCH_M}`, [`efConstruction = ${BENCH_EFC}`, `${thousands(benchBuild)} 次距离`], [afterBenchBuild, 'INDEX', `${BENCH_N} 个合成向量插入 HNSW（M = ${BENCH_M}，efConstruction = ${BENCH_EFC}，${benchGraph.maxLevel + 1} 层）：${thousands(benchBuild)} 次距离`, null],
          wire('建图的成本', 'vals', '示意', concept(`${BENCH_N} 个向量`, [
            ['层数', `${benchGraph.maxLevel + 1} 层`, `第 1 层以上 ${benchGraph.levels.filter((x) => x >= 1).length} 个节点。`],
            ['距离计算', `${thousands(benchBuild)} 次`, `平均每插入一个 ${num(benchBuild / BENCH_N, 1)} 次。`],
            ['每个向量', `${benchBytesPerVector} 字节`, `FAISS 文档：4 × d + M × 2 × 4，d = ${DIM}，M = ${BENCH_M}。`],
          ], 'violet'))),
        pk('app', 'index', 'amber', `${BENCH_QUERIES.length} 个问题 × ef`, benchRuns.map((r) => `ef ${r.ef}：${Math.round(r.perQuery)} 次 · ${pctOf(r.recall)}`), [afterBench, 'SEARCH', `${BENCH_QUERIES.length} 个评估问题分别用 ef ${BENCH_EFS.map((r) => r.ef).join('、')} 查：每次 ${benchRuns.map((r) => Math.round(r.perQuery)).join('、')} 次，召回率@${BENCH_K} ${benchRuns.map((r) => pctOf(r.recall)).join('、')}`, null],
          wire('各家默认的 ef', 'vals', '示意', concept(`M = ${BENCH_M}，efConstruction = ${BENCH_EFC}`, [
            ...benchRuns.map((r): [string, string, string] => [`ef = ${r.ef}（${r.who} 默认）`, `${num(r.perQuery, 1)} 次 · ${pctOf(r.recall)}`, `${BENCH_QUERIES.length} 个问题的平均。`]),
            ['Flat', `${BENCH_N} 次 · 100%`, '标准答案。'],
          ], 'amber')),
          { ds: { scores: [benchGrid()] } }),
        note('scores', `Flat 要 ${BENCH_N} 次`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '建图贵，查询便宜',
    desc: `${N} 次 → ${small.computed} 次；${BENCH_N} 次 → ${Math.round(benchRuns[0].perQuery)} 次`,
    text: `HNSW 把向量连成分层的近邻图，查询从顶层的长边快速靠近，再在第 0 层用 ef 个候选细找，论文的实验里距离次数大致随 log N 增长；Qdrant、Chroma（单机）的向量索引就是它，FAISS、pgvector 也都提供。代价在别处：建图要算很多次距离（这一课 ${BENCH_N} 个向量花了 ${thousands(benchBuild)} 次），每个向量还要多存 2M 个邻居 id；ef 太小会停在局部、漏掉最近的点。下一课的 PQ 换一个方向省：不减少比较的次数，而是把每个向量压到几个字节，让内存和每次比较都变便宜。`,
    facts: [['ef = 3', `${small.computed} 次 · ${pctOf(recallSmall)}`], ['ef = 8', `${large.computed} 次 · ${pctOf(recallLarge)}`], [`${BENCH_N} 个，ef ${benchRuns[0].ef}`, `${Math.round(benchRuns[0].perQuery)} 次 · ${pctOf(benchRuns[0].recall)}`], ['下一课', '乘积量化 PQ']],
  },
};
