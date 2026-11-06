/**
 * 向量检索组第二课：IVF（倒排文件，FAISS 的 IndexIVFFlat）。用 k-means 把 27 个段落向量聚成 4 簇，每簇一张倒排表；
 * 查询先和 4 个质心比，只扫最近的 nprobe 簇。nprobe = 1 时这个问题最近的段落 cup#1 恰好落在另一簇，被漏掉了；nprobe = 2 找回来。
 * 最后在 1000 个合成向量上建 32 簇，比较 nprobe 1、2、4、8 的距离次数和召回率。
 *
 * 全部由 core/ 实时计算：buildIvf（kmeans）、ivfSearch、exactTopK、recallAtK、meanRecall。tests/narrative.index.test.ts 核对文案。
 */
import { f32Bits } from '@explorer/llm-core/float';
import {
  BENCH_K,
  BENCH_N,
  BENCH_QUERIES,
  BENCH_TRUTH,
  BENCH_VECTORS,
  buildIvf,
  DistanceMeter,
  embedVector,
  EVAL_SET,
  exactTopK,
  ivfSearch,
  meanRecall,
  PARAGRAPH_VECTORS,
  recallAtK,
  type IvfSearch,
} from '../core';
import { concept, floatVector, num, thousands, wire } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import { centerOf, i64Bytes, idOf, layerId, pid, queryNode, searchOutput, shortName, spaceGraph } from './index-common';
import type { DsCell, GraphEdge, GraphNode, GridPrim, Lesson, RowPrim, Tone } from './types';

// ---------- 建索引 ----------

export const N = PARAGRAPH_VECTORS.length;
export const DIM = PARAGRAPH_VECTORS[0].length;
export const NLIST = 4;
export const SEED = 7;
export const K = 3;

export const meter = new DistanceMeter();
export const index = buildIvf(PARAGRAPH_VECTORS, NLIST, { seed: SEED, meter });
export const iterations = index.train.iterations;
export const trainDist = meter.by.train;
export const buildDist = meter.by.build;
export const afterBuild = meter.total;
/** 训练过程中有没有出现空簇（某一轮没有向量分给某个质心）。 */
export const emptySeen = iterations.some((it) => Array.from({ length: NLIST }, (_, c) => c).some((c) => !it.assign.includes(c)));

// ---------- 查询 ----------

const ITEM = EVAL_SET.find((item) => item.id === 'leak')!;
export const QUESTION = ITEM.question;
export const q = embedVector(QUESTION);
/** 标准答案：暴力搜索的前 3 个（上一课的结果，不再记距离）。 */
export const truth = exactTopK(PARAGRAPH_VECTORS, q, K);

export const probe1 = ivfSearch(index, PARAGRAPH_VECTORS, q, K, 1, meter);
export const after1 = meter.total;
export const recall1 = recallAtK(probe1.hits.map((hit) => hit.id), truth, K);
export const missed = truth.filter((id) => !probe1.hits.some((hit) => hit.id === id));

export const probe2 = ivfSearch(index, PARAGRAPH_VECTORS, q, K, 2, meter);
export const after2 = meter.total;
export const recall2 = recallAtK(probe2.hits.map((hit) => hit.id), truth, K);

/** 8 个评估问题，nprobe = 1、2、4 的平均召回率@3。 */
export const NPROBES = [1, 2, 4] as const;
export const evalRecall = NPROBES.map((nprobe) => {
  const before = meter.total;
  const pairs = EVAL_SET.map((item) => {
    const v = embedVector(item.question);
    return { found: ivfSearch(index, PARAGRAPH_VECTORS, v, K, nprobe, meter).hits.map((hit) => hit.id), truth: exactTopK(PARAGRAPH_VECTORS, v, K) };
  });
  return { nprobe, recall: meanRecall(pairs, K), perQuery: (meter.total - before) / EVAL_SET.length };
});
export const afterEval = meter.total;

// ---------- 规模：1000 个合成向量，32 簇 ----------

export const BENCH_NLIST = 32;
export const benchIndex = buildIvf(BENCH_VECTORS, BENCH_NLIST, { seed: SEED, meter });
export const afterBenchBuild = meter.total;
export const benchBuild = afterBenchBuild - afterEval;
export const benchEmpty = benchIndex.train.iterations.some((it) => Array.from({ length: BENCH_NLIST }, (_, c) => c).some((c) => !it.assign.includes(c)));
export const BENCH_PROBES = [1, 2, 4, 8] as const;
export const benchRuns = BENCH_PROBES.map((nprobe) => {
  const before = meter.total;
  const pairs = BENCH_QUERIES.map((query, i) => ({ found: ivfSearch(benchIndex, BENCH_VECTORS, query, BENCH_K, nprobe, meter).hits.map((hit) => hit.id), truth: BENCH_TRUTH[i] }));
  return { nprobe, recall: meanRecall(pairs, BENCH_K), perQuery: (meter.total - before) / BENCH_QUERIES.length };
});
export const afterBench = meter.total;

// ---------- 显示 ----------

const name = (i: number) => shortName(i);
const bare = (text: string) => text.replace(/？$/, '');
const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const r2 = (x: number) => fixed(x, 2);
/** 每簇一个颜色（amber 留给检索结果，blue 留给查询）。 */
const CLUSTER_TONE: Tone[] = ['violet', 'green', 'slate', 'teal'];
const cname = (c: number) => `C${c}`;

const listOf = (c: number) => index.lists[c];
const probedFirst = probe1.probed[0];
const probedSecond = probe2.probed[1];
const missedId = missed[0];
const missedList = index.listOf[missedId];

/** 某一轮的空间：节点按所属的簇上色，质心画在成员的平均位置，成员连到质心。 */
function clusterSpace(assign: readonly number[], options: { lift?: number[]; hits?: number[]; dim?: number[]; query?: boolean; centroids?: boolean; marks?: GraphNodeMark[] } = {}) {
  const tones: Record<number, Tone> = {};
  assign.forEach((c, i) => (tones[i] = options.hits?.includes(i) ? PART_TONE.result : options.dim?.includes(c) ? 'dim' : CLUSTER_TONE[c]));
  const extra: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  if (options.centroids !== false) {
    for (let c = 0; c < NLIST; c++) {
      const members = assign.flatMap((a, i) => (a === c ? [i] : []));
      const [x, y] = centerOf(members);
      extra.push({ id: `c${c}`, x, y: y - 6, v: cname(c), tone: options.dim?.includes(c) ? 'dim' : CLUSTER_TONE[c], lift: true });
      for (const i of members) edges.push({ a: `c${c}`, b: pid(i), tone: options.dim?.includes(c) ? 'dim' : CLUSTER_TONE[c] });
    }
  }
  if (options.query) extra.push(queryNode(q));
  return spaceGraph({ tones, lift: options.lift, extra, edges, marks: options.marks });
}
type GraphNodeMark = NonNullable<ReturnType<typeof spaceGraph>['marks']>[number];

/** 初始化：4 个被抽中的段落就是初始质心。 */
function initSpace() {
  return spaceGraph({ tones: Object.fromEntries(index.train.init.map((i, c) => [i, CLUSTER_TONE[c]])), rest: 'dim', lift: index.train.init, marks: index.train.init.map((i, c) => ({ at: pid(i), text: cname(c), color: CLUSTER_TONE[c] === 'slate' ? 'slate' : (CLUSTER_TONE[c] as 'violet' | 'green' | 'teal') })) });
}

const WIDE = Math.max(...index.lists.map((list) => list.length));

/** 倒排表：每簇一行，格子是段落简称。scanned 的行抬起来。 */
function listsGrid(options: { probed?: number[]; hits?: number[]; missed?: number } = {}): GridPrim {
  return {
    kind: 'grid',
    id: 'lists',
    w: 44,
    rows: index.lists.map((_, c) => cname(c)),
    cols: Array.from({ length: WIDE }, (_, i) => String(i)),
    cells: index.lists.map((list, c) =>
      Array.from({ length: WIDE }, (_, i): DsCell => {
        const id = list[i];
        if (id === undefined) return { v: '' };
        const probed = !options.probed || options.probed.includes(c);
        const tone: Tone = options.hits?.includes(id) ? PART_TONE.result : id === options.missed ? 'blue' : probed ? CLUSTER_TONE[c] : 'dim';
        return { v: name(id), key: `l${id}`, tone, lift: (options.probed?.includes(c) && probed) || undefined };
      })),
  };
}

function resultRow(search: IvfSearch, mark?: string): RowPrim {
  return {
    kind: 'row',
    id: 'r',
    w: 60,
    cells: search.hits.map((hit): DsCell => ({ v: name(hit.id), key: `r${hit.id}`, tone: truth.includes(hit.id) ? PART_TONE.result : 'slate', sub: r2(hit.score) })),
    marks: mark ? [{ at: 0, text: mark, color: 'amber' }] : undefined,
  };
}

function recallRow(values: Array<[string, number]>): RowPrim {
  return { kind: 'row', id: 'rc', w: 64, cells: values.map(([label, value]): DsCell => ({ v: pctOf(value), key: label, tone: value >= 1 ? 'green' : 'amber', sub: label, heat: value })) };
}

function benchGrid(): GridPrim {
  return {
    kind: 'grid',
    id: 'b',
    w: 50,
    rows: [...benchRuns.map((run) => `nprobe ${run.nprobe}`), 'Flat'],
    cols: ['距离', '召回率'],
    cells: [
      ...benchRuns.map((run): DsCell[] => [{ v: String(Math.round(run.perQuery)), tone: PART_TONE.result }, { v: pctOf(run.recall), tone: run.recall >= 1 ? 'green' : 'amber', heat: run.recall }]),
      [{ v: String(BENCH_N), tone: 'slate' }, { v: '100%', tone: 'green', heat: 1 }],
    ],
  };
}

// ---------- 字节 ----------

/** 质心（粗量化器里的 nlist 个向量）。 */
const centroidLayers = (centroids: readonly number[][], color: 'violet' | 'teal' = 'violet') => centroids.map((c, i) => floatVector(cname(i), c, 'f32', { color, digits: 3 }));

/** 一张倒排表：先是 n 个 int64 id，再是 n 个向量（IndexIVFFlat 每个向量 4 × d + 8 字节；摆法是本站按 FAISS 的 ArrayInvertedLists 写的示意）。 */
function listLayer(c: number): LayerWriter {
  const list = listOf(c);
  const layer = new LayerWriter(layerId(), `倒排表 ${cname(c)} · ${list.length} 个 · ${list.length * (DIM * 4 + 8)} 字节`, CLUSTER_TONE[c] === 'slate' ? 'slate' : (CLUSTER_TONE[c] as 'violet' | 'green' | 'teal'), 'ids（int64）在前，向量（float32）在后');
  list.forEach((id, i) => layer.field(`ids[${i}] · +${i * 8}`, `${id}（${name(id)}）`, () => layer.raw(i64Bytes(id)), { note: `${idOf(id)}。FAISS 要存 id，因为倒排表打乱了入库顺序。` }));
  list.forEach((id, i) => layer.field(`codes[${i}] · +${list.length * 8 + i * DIM * 4}`, `${name(id)} 的 ${DIM} 个 float32`, () => layer.raw(PARAGRAPH_VECTORS[id].flatMap((x) => Array.from({ length: 4 }, (_, b) => (f32Bits(x) >>> (b * 8)) & 0xff))), { note: `${idOf(id)} 的原始向量，IVFFlat 不压缩。` }));
  return layer;
}

const LIST_BYTES = N * (DIM * 4 + 8);
const CENTROID_BYTES = NLIST * DIM * 4;

const centroidConcept = (search: IvfSearch, nprobe: number) =>
  concept('查询到每个质心的平方距离', search.centroidDist.map((d, c): [string, string, string] => [cname(c), num(d, 4), search.probed.includes(c) ? `第 ${search.probed.indexOf(c) + 1} 近，探查这一簇（${listOf(c).length} 个向量）。` : `不在最近的 ${nprobe} 簇里，整簇跳过。`]), 'violet');

// ---------- 课程 ----------

const it = iterations;
const lastIt = it[it.length - 1];

export const ivf: Lesson = {
  id: 'ivf',
  name: 'IVF INDEX',
  title: 'IVF：聚类与倒排',
  group: 'index',
  layer: [3, 5],
  layerNote: '先在向量上训练质心、建倒排表（索引），查询时只扫最近的几簇（检索）。',
  distNote: `训练 k-means ${thousands(trainDist)} 次、入库分簇 ${buildDist} 次；每次查询是 ${NLIST} 个质心加上被扫的向量；最后在 ${BENCH_N} 个合成向量上建 ${BENCH_NLIST} 簇再查，一共 ${thousands(afterBench)} 次。`,
  nodes: ['app', 'index', 'space', 'vectors', 'results', 'scores'],
  place: { app: [100, 130], index: [430, 120], vectors: [900, 210], space: [480, 570], results: [1010, 450], scores: [1070, 730] },
  labels: {
    app: ['应用', 'index.search(q, k)'],
    index: ['向量库', `IVF：${NLIST} 簇`],
    vectors: ['倒排表', '每簇一张，存 id 和向量'],
    space: ['向量空间', `${N} 个段落和 ${NLIST} 个质心（平面示意）`],
    results: ['前 k 个', '括号外是平方距离'],
    scores: ['召回率@3', '和 Flat 的结果比'],
  },
  labelAt: { vectors: [-280, 60], space: [0, 245], results: [0, 75], scores: [0, 150] },
  radius: { vectors: 160, space: 200, results: 60, scores: 70 },
  initial: { vectors: [], space: [spaceGraph({ rest: 'dim' })], results: [], scores: [] },
  start: ['app', 'index', 'space'],
  legend: [['violet', '簇 C0'], ['green', '簇 C1'], ['slate', '簇 C2'], ['teal', '簇 C3'], ['amber', '检索结果'], [null, '距离列：累计算了几次距离']],
  overview: {
    full: '先找簇，再在簇里找',
    description: `暴力搜索每次要比 N 次。IVF 先用 k-means 把向量分成 nlist 簇，每簇一张倒排表；查询先和 nlist 个质心比，只扫最近的 nprobe 簇。这一课把 ${N} 个段落分成 ${NLIST} 簇：「${bare(QUESTION)}」在 nprobe = 1 时只算 ${probe1.computed.centroids + probe1.computed.vectors} 次距离，却漏掉了最该找到的 ${idOf(missedId)}；nprobe = 2 算 ${probe2.computed.centroids + probe2.computed.vectors} 次，找回来了。到 ${BENCH_N} 个向量时，nprobe = 1 每次只算 ${Math.round(benchRuns[0].perQuery)} 次。`,
    facts: [
      ['FAISS', 'IndexIVFFlat(quantizer, d, nlist)'],
      ['nlist', `${NLIST} 簇（${BENCH_N} 个向量时 ${BENCH_NLIST}）`],
      ['nprobe', 'FAISS 默认 1'],
      ['每次查询', 'nlist + 被扫的向量数'],
      ['代价', '召回率 < 1'],
    ],
  },
  steps: [
    {
      title: `k-means 训练 ${NLIST} 个质心`,
      desc: `${it.length} 轮，${thousands(trainDist)} 次距离`,
      detail: `IVF 要先训练：用 k-means 把向量分成 nlist = ${NLIST} 簇。按固定种子随机抽 ${NLIST} 个段落当初始质心，然后反复做两件事：每个向量分给最近的质心（${N} × ${NLIST} = ${N * NLIST} 次距离），每个质心挪到它名下向量的平均位置。第 ${it.length} 轮没有向量换簇，停下，一共 ${it.length} × ${N * NLIST} = ${thousands(trainDist)} 次距离。${emptySeen ? '训练中出现了空簇，本站保留旧质心（FAISS 会拆分最大的簇）' : '这次训练没有出现空簇；遇到空簇时本站保留旧质心，FAISS 会拆分最大的簇'}。`,
      facts: [['nlist', String(NLIST)], ['初始质心', index.train.init.map((i) => name(i)).join('、')], ['轮数', `${it.length}（换簇 ${it.map((x) => x.moved).join(' → ')}）`], ['误差平方和', `${r2(it[0].inertia)} → ${r2(lastIt.inertia)}`]],
      events: [
        pk('index', 'space', 'slate', `抽 ${NLIST} 个初始质心`, index.train.init.map((i, c) => `${cname(c)} = ${name(i)}`), [0, 'TRAIN', `固定种子 ${SEED} 抽 ${NLIST} 个段落当初始质心：${index.train.init.map((i) => idOf(i)).join('、')}`, CENTROID_BYTES],
          wire('初始质心：抽中的段落向量', 'mem', 'internal', ...centroidLayers(index.train.init.map((i) => PARAGRAPH_VECTORS[i]))),
          { ds: { space: [initSpace()] } }),
        ...it.map((round, n) =>
          pk('index', 'space', CLUSTER_TONE[n % NLIST] === 'slate' ? 'violet' : 'violet', `第 ${n + 1} 轮`, [`换簇 ${round.moved} 个`, `误差 ${r2(round.inertia)}`], [(n + 1) * N * NLIST, 'TRAIN', `第 ${n + 1} 轮：${N} × ${NLIST} 次距离，${round.moved} 个向量换簇，各簇 ${Array.from({ length: NLIST }, (_, c) => round.assign.filter((a) => a === c).length).join(' / ')} 个`, CENTROID_BYTES],
            wire(`第 ${n + 1} 轮之后的质心`, 'mem', 'internal', ...centroidLayers(round.centroids)),
            { ds: { space: [clusterSpace(round.assign)] } })),
        state('index', { nlist: String(NLIST), 训练: `${it.length} 轮` }),
        note('space', `第 ${it.length} 轮没人换簇，停`, 'green'),
      ],
    },
    {
      title: '倒排表：每个向量进最近的簇',
      desc: `${N} × ${NLIST} 次距离，${NLIST} 张表`,
      detail: `训练好的质心存进粗量化器（一个小的 Flat 索引），然后每个向量再和 ${NLIST} 个质心比一次，放进最近那一簇的倒排表，又是 ${buildDist} 次距离。各簇分到 ${index.lists.map((list) => list.length).join('、')} 个向量；${idOf(missedId)}（${name(missedId)}，讲杯盖密封圈的那段）没有和别的杯子段落分在一起，和《售后规则》的 4 段一起进了 ${cname(missedList)}。FAISS 的 IndexIVFFlat 每个向量存原始的 ${DIM * 4} 字节再加 8 字节 id，因为倒排表打乱了入库顺序。`,
      facts: [['各簇', index.lists.map((list, c) => `${cname(c)} ${list.length}`).join('、')], ['质心', `${NLIST} × ${DIM * 4} = ${CENTROID_BYTES} 字节`], ['倒排表', `${N} × (${DIM * 4} + 8) = ${thousands(LIST_BYTES)} 字节`], [idOf(missedId), `在 ${cname(missedList)}`]],
      events: [
        show('vectors'),
        pk('index', 'vectors', 'violet', `${N} 个向量分簇`, index.lists.map((list, c) => `${cname(c)}：${list.length} 个`), [afterBuild, 'INDEX', `每个向量和 ${NLIST} 个质心比一次（${buildDist} 次），放进最近那簇的倒排表`, LIST_BYTES + CENTROID_BYTES],
          wire('IndexIVFFlat：质心和倒排表（FAISS 的内部布局，本站示意）', 'mem', 'internal', ...centroidLayers(index.centroids), ...index.lists.map((_, c) => listLayer(c))),
          { ds: { vectors: [listsGrid()], space: [clusterSpace(index.listOf)] } }),
        state('index', { nlist: String(NLIST), 训练: `${it.length} 轮`, 内存: `${thousands(LIST_BYTES + CENTROID_BYTES)} 字节` }),
        note('vectors', `${name(missedId)} 进了 ${cname(missedList)}`, 'amber'),
      ],
    },
    {
      title: 'nprobe = 1：漏掉了正确答案',
      desc: `${probe1.computed.centroids} + ${probe1.computed.vectors} = ${probe1.computed.centroids + probe1.computed.vectors} 次，召回率 ${pctOf(recall1)}`,
      detail: `查询「${bare(QUESTION)}」先和 ${NLIST} 个质心比（${probe1.computed.centroids} 次），离 ${cname(probedFirst)} 最近，nprobe = 1 只扫这一簇的 ${probe1.computed.vectors} 个向量，一共 ${probe1.computed.centroids + probe1.computed.vectors} 次，Flat 要 ${N} 次。可最近的 ${idOf(missedId)} 在 ${cname(missedList)} 里，根本没被看到，结果变成 ${probe1.hits.map((hit) => name(hit.id)).join('、')}，和 Flat 的前 ${K} 个只重合 ${Math.round(recall1 * K)} 个，召回率@${K} = ${pctOf(recall1)}。查询离 ${cname(probedFirst)} 的质心近，不代表它最近的向量都在 ${cname(probedFirst)} 里：落在簇边界附近的向量就会这样被漏掉。`,
      facts: [['质心', `${probe1.computed.centroids} 次，最近 ${cname(probedFirst)}`], ['扫描', `${cname(probedFirst)} 的 ${probe1.computed.vectors} 个`], ['结果', probe1.hits.map((hit) => name(hit.id)).join('、')], ['漏掉', `${idOf(missedId)}（在 ${cname(missedList)}）`]],
      events: [
        type(`index.nprobe = 1; index.search(q, k=${K})`),
        pk('app', 'index', 'blue', 'search(q, k=3)', ['nprobe = 1'], [afterBuild, 'SEARCH', `查询「${QUESTION}」，nprobe = 1`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', q, 'f32', { color: 'blue', digits: 3 })),
          { ds: { space: [clusterSpace(index.listOf, { query: true })] } }),
        pk('index', 'space', 'blue', `比 ${NLIST} 个质心`, probe1.centroidDist.map((d, c) => `${cname(c)} ${r2(d)}`), [afterBuild + probe1.computed.centroids, 'SEARCH', `查询和 ${NLIST} 个质心比：最近的是 ${cname(probedFirst)}（${r2(probe1.centroidDist[probedFirst])}）`, NLIST * 4],
          wire('查询到质心的距离', 'vals', '示意', centroidConcept(probe1, 1)),
          { ds: { space: [clusterSpace(index.listOf, { query: true, dim: [0, 1, 2, 3].filter((c) => c !== probedFirst) })] } }),
        show('results'),
        pk('index', 'vectors', 'amber', `扫 ${cname(probedFirst)}：${probe1.computed.vectors} 个`, probe1.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [after1, 'SEARCH', `只扫 ${cname(probedFirst)} 的 ${probe1.computed.vectors} 个向量：前 ${K} 个是 ${probe1.hits.map((hit) => idOf(hit.id)).join('、')}`, probe1.computed.vectors * (DIM * 4 + 8)],
          wire(`被扫的倒排表 ${cname(probedFirst)}`, 'mem', 'internal', listLayer(probedFirst)),
          { ds: { vectors: [listsGrid({ probed: [probedFirst], hits: probe1.hits.map((hit) => hit.id), missed: missedId })], results: [resultRow(probe1)] } }),
        show('scores'),
        pk('index', 'app', 'amber', `前 ${K} 个`, probe1.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [after1, 'CALL', `返回 ${probe1.hits.map((hit) => idOf(hit.id)).join('、')}；Flat 的第 1 名 ${idOf(missedId)} 不在里面`, K * 12],
          wire('search() 的输出（平方距离）', 'mem', 'internal', ...searchOutput(probe1.hits, K, { metric: 'l2' })),
          { ds: { scores: [recallRow([['nprobe 1', recall1]])], space: [clusterSpace(index.listOf, { query: true, hits: probe1.hits.map((hit) => hit.id), dim: [0, 1, 2, 3].filter((c) => c !== probedFirst), lift: [missedId], marks: [{ at: pid(missedId), text: `${name(missedId)} 最近，在 ${cname(missedList)}`, color: 'amber' }] })] } }),
        note('space', `只扫了 ${cname(probedFirst)}`, 'amber'),
      ],
    },
    {
      title: 'nprobe = 2：多扫一簇',
      desc: `${probe2.computed.centroids} + ${probe2.computed.vectors} = ${probe2.computed.centroids + probe2.computed.vectors} 次，召回率 ${pctOf(recall2)}`,
      detail: `把 nprobe 调到 2，多扫第二近的 ${cname(probedSecond)}：质心还是 ${NLIST} 次，向量 ${probe2.computed.vectors} 次，一共 ${probe2.computed.centroids + probe2.computed.vectors} 次，${idOf(missedId)} 回到第 1 名，召回率@${K} = ${pctOf(recall2)}。换成评估集的 ${EVAL_SET.length} 个问题，nprobe = ${evalRecall.map((r) => r.nprobe).join('、')} 的平均召回率是 ${evalRecall.map((r) => pctOf(r.recall)).join('、')}，每次查询平均算 ${evalRecall.map((r) => num(r.perQuery, 1)).join('、')} 次距离。nprobe 是查询时的旋钮，不用重建索引：调大召回率上去，距离次数也跟着上去，nprobe = nlist 时就退化成暴力搜索。`,
      facts: [['扫描', `${cname(probedFirst)} + ${cname(probedSecond)}，${probe2.computed.vectors} 个`], ['结果', probe2.hits.map((hit) => name(hit.id)).join('、')], ...evalRecall.map((r): [string, string] => [`评估集 nprobe ${r.nprobe}`, `${pctOf(r.recall)}，每次 ${num(r.perQuery, 1)} 次`])],
      events: [
        type(`index.nprobe = 2; index.search(q, k=${K})`),
        pk('index', 'vectors', 'amber', `扫 ${cname(probedFirst)} + ${cname(probedSecond)}`, probe2.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [after2, 'SEARCH', `nprobe = 2：${NLIST} 个质心 + ${probe2.computed.vectors} 个向量，${idOf(missedId)} 回到第 1 名`, probe2.computed.vectors * (DIM * 4 + 8)],
          wire(`被扫的两张倒排表 ${cname(probedFirst)}、${cname(probedSecond)}`, 'mem', 'internal', listLayer(probedFirst), listLayer(probedSecond)),
          { ds: { vectors: [listsGrid({ probed: probe2.probed, hits: probe2.hits.map((hit) => hit.id) })], results: [resultRow(probe2)], scores: [recallRow([['nprobe 1', recall1], ['nprobe 2', recall2]])], space: [clusterSpace(index.listOf, { query: true, hits: probe2.hits.map((hit) => hit.id), dim: [0, 1, 2, 3].filter((c) => !probe2.probed.includes(c)) })] } }),
        pk('app', 'index', 'slate', `评估集 × nprobe ${NPROBES.join('/')}`, evalRecall.map((r) => `nprobe ${r.nprobe}：${pctOf(r.recall)}`), [afterEval, 'EVAL', `${EVAL_SET.length} 个评估问题分别用 nprobe ${NPROBES.join('、')} 查，平均召回率@${K}：${evalRecall.map((r) => pctOf(r.recall)).join('、')}`, null],
          wire('评估集上的平均召回率', 'vals', '示意', concept('nprobe 和召回率', evalRecall.map((r): [string, string, string] => [`nprobe = ${r.nprobe}`, `${pctOf(r.recall)} · 每次 ${num(r.perQuery, 1)} 次`, `${EVAL_SET.length} 个问题，召回率@${K} 取平均；标准答案是 Flat 的前 ${K} 个。`]), 'green')),
          { ds: { scores: [recallRow(evalRecall.map((r) => [`nprobe ${r.nprobe}`, r.recall]))] } }),
        note('scores', '多扫几簇，召回率上去', 'green'),
      ],
    },
    {
      title: `放大到 ${BENCH_N} 个向量`,
      desc: `nprobe = 1 每次 ${Math.round(benchRuns[0].perQuery)} 次，召回率 ${pctOf(benchRuns[0].recall)}`,
      detail: `在上一课的 ${BENCH_N} 个合成向量上建 ${BENCH_NLIST} 簇（约 √N；FAISS 的选型指南建议 4√N 到 16√N，训练向量至少 30 × nlist 个，${BENCH_N} 个刚好够 ${BENCH_NLIST} 簇），训练加分簇花了 ${thousands(benchBuild)} 次距离。之后每次查询，nprobe = ${benchRuns.map((r) => r.nprobe).join('、')} 平均算 ${benchRuns.map((r) => Math.round(r.perQuery)).join('、')} 次，召回率@${BENCH_K} 是 ${benchRuns.map((r) => pctOf(r.recall)).join('、')}，Flat 是 ${BENCH_N} 次、100%。FAISS 的 nprobe 默认是 1，pgvector 的 ivfflat.probes 也默认 1，建议 lists 先取行数 / 1000（100 万行以上取 √行数）、probes 取 √lists，再按召回率调。`,
      facts: [['建索引', `${thousands(benchBuild)} 次距离`], ...benchRuns.map((r): [string, string] => [`nprobe ${r.nprobe}`, `${Math.round(r.perQuery)} 次 · ${pctOf(r.recall)}`]), ['Flat', `${BENCH_N} 次 · 100%`]],
      events: [
        pk('app', 'index', 'violet', `建 ${BENCH_NLIST} 簇`, [`${BENCH_N} 个向量`, `${thousands(benchBuild)} 次距离`], [afterBenchBuild, 'TRAIN', `${BENCH_N} 个合成向量上训练 ${BENCH_NLIST} 个质心（${benchIndex.train.iterations.length} 轮）并分簇：${thousands(benchBuild)} 次距离${benchEmpty ? '，训练中出现了空簇' : ''}`, null],
          wire('建索引的成本', 'vals', '示意', concept('k-means 和分簇', [
            ['训练', `${benchIndex.train.iterations.length} 轮 × ${BENCH_N} × ${BENCH_NLIST}`, '每轮每个向量和每个质心比一次。'],
            ['分簇', `${BENCH_N} × ${BENCH_NLIST}`, '入库时每个向量再找一次最近的质心。'],
            ['最小 / 最大的簇', `${Math.min(...benchIndex.train.sizes)} / ${Math.max(...benchIndex.train.sizes)} 个`, '簇的大小不均匀：扫到大簇的查询更贵。'],
          ], 'violet'))),
        show('scores'),
        pk('app', 'index', 'amber', `${BENCH_QUERIES.length} 个问题 × nprobe`, benchRuns.map((r) => `nprobe ${r.nprobe}：${Math.round(r.perQuery)} 次 · ${pctOf(r.recall)}`), [afterBench, 'SEARCH', `${BENCH_QUERIES.length} 个评估问题分别用 nprobe ${BENCH_PROBES.join('、')} 查：每次 ${benchRuns.map((r) => Math.round(r.perQuery)).join('、')} 次，召回率@${BENCH_K} ${benchRuns.map((r) => pctOf(r.recall)).join('、')}`, null],
          wire('nprobe、距离次数和召回率', 'vals', '示意', concept(`${BENCH_N} 个向量，${BENCH_NLIST} 簇`, [
            ...benchRuns.map((r): [string, string, string] => [`nprobe = ${r.nprobe}`, `${num(r.perQuery, 1)} 次 · ${pctOf(r.recall)}`, `${BENCH_NLIST} 个质心 + 平均扫 ${num(r.perQuery - BENCH_NLIST, 1)} 个向量。`]),
            ['Flat', `${BENCH_N} 次 · 100%`, '上一课的标准答案。'],
          ], 'amber')),
          { ds: { scores: [benchGrid()] } }),
        note('scores', `Flat 要 ${BENCH_N} 次`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '用一点召回率换少得多的距离',
    desc: `${N} 次 → ${probe1.computed.centroids + probe1.computed.vectors} 次；${BENCH_N} 次 → ${Math.round(benchRuns[0].perQuery)} 次`,
    text: `IVF 先训练、再查询：k-means 把向量空间切成 nlist 块，查询只扫最近的 nprobe 块，距离次数从 N 降到 nlist 加上被扫的那部分。代价是落在簇边界附近的向量可能被漏掉，就像这一课的 ${idOf(missedId)}；nprobe 越大越准也越慢，要拿评估集去调。下一课的 HNSW 换了一种思路：不分簇，而是把向量连成一张分层的图，沿着边一路走向查询。`,
    facts: [['nprobe = 1', `${pctOf(recall1)}（这个问题）`], ['nprobe = 2', pctOf(recall2)], [`${BENCH_N} 个，nprobe 1`, `${Math.round(benchRuns[0].perQuery)} 次 · ${pctOf(benchRuns[0].recall)}`], ['下一课', 'HNSW：分层图的插入与查询']],
  },
};

