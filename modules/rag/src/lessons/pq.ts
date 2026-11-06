/**
 * 向量检索组第四课：乘积量化 PQ（FAISS 的 IndexPQ）。把 16 维向量切成 4 段，每段用 k-means 训练 8 个子质心（码本），
 * 每个向量编码成 4 个 uint8（64 字节 → 4 字节）；查询时先算一张 4 × 8 的 ADC 距离表，每个码查 4 次表加起来就是近似距离。
 * 量化误差让 cup#0 和 warranty#0 换了名次；最后在 1000 个合成向量上用 M = 8、ksub = 256 比较字节、距离次数和召回率。
 *
 * 全部由 core/ 实时计算：trainPq、pqEncodeAll、adcTable、pqSearch、pqDecode、pqBytes。tests/narrative.index.test.ts 核对文案。
 */
import {
  BENCH_K,
  BENCH_N,
  BENCH_QUERIES,
  BENCH_TRUTH,
  BENCH_VECTORS,
  DistanceMeter,
  embedVector,
  EVAL_SET,
  exactTopK,
  l2sq,
  meanRecall,
  PARAGRAPH_VECTORS,
  pqBytes,
  pqDecode,
  pqEncodeAll,
  pqPackedBytes,
  pqSearch,
  recallAtK,
  trainPq,
  type PqCodebook,
} from '../core';
import { concept, floatVector, num, pqCodes, thousands, wire } from '../decode/structures';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import { idOf, searchOutput, shortName } from './index-common';
import type { Color, DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 训练和编码 ----------

export const N = PARAGRAPH_VECTORS.length;
export const DIM = PARAGRAPH_VECTORS[0].length;
export const M = 4;
export const KSUB = 8;
export const SEED = 1;
export const K = 3;

export const meter = new DistanceMeter();
export const cb: PqCodebook = trainPq(PARAGRAPH_VECTORS, M, KSUB, { seed: SEED, meter });
export const afterTrain = meter.total;
export const emptySeen = cb.train.some((result) => result.iterations.some((it) => Array.from({ length: KSUB }, (_, c) => c).some((c) => !it.assign.includes(c))));
export const codes = pqEncodeAll(cb, PARAGRAPH_VECTORS, meter);
export const afterEncode = meter.total;
export const bytes = pqBytes(cb);
export const packed = pqPackedBytes(cb);
export const NBITS = Math.log2(KSUB);
export const distinctCodes = new Set(codes.map((code) => code.join())).size;

/** 示范的向量：cup#1（讲杯盖密封圈的那段，也是这个问题的正确答案）。 */
export const SHOW = PARAGRAPH_VECTORS.findIndex((_, i) => idOf(i) === 'cup#1');
export const showCode = codes[SHOW];
export const showDecoded = pqDecode(cb, showCode);
export const showError = l2sq(PARAGRAPH_VECTORS[SHOW], showDecoded);
export const meanError = PARAGRAPH_VECTORS.reduce((sum, v, i) => sum + l2sq(v, pqDecode(cb, codes[i])), 0) / N;

// ---------- 查询 ----------

const ITEM = EVAL_SET.find((item) => item.id === 'leak')!;
export const QUESTION = ITEM.question;
export const q = embedVector(QUESTION);
export const truth = exactTopK(PARAGRAPH_VECTORS, q, K, 'l2');
export const search = pqSearch(cb, codes, q, K, meter);
export const afterSearch = meter.total;
export const trueDist = PARAGRAPH_VECTORS.map((v) => l2sq(q, v));
export const recall = recallAtK(search.hits.map((hit) => hit.id), truth, K);
/** 被挤掉的（在标准答案里、不在 PQ 结果里）和挤进来的。 */
export const pushedOut = truth.filter((id) => !search.hits.some((hit) => hit.id === id));
export const pushedIn = search.hits.map((hit) => hit.id).filter((id) => !truth.includes(id));

// ---------- 评估集：M = 4 和 M = 8 ----------

export const M_LARGE = 8;
function evalWith(book: PqCodebook, bookCodes: number[][]) {
  const before = meter.total;
  const pairs = EVAL_SET.map((item) => {
    const v = embedVector(item.question);
    return { found: pqSearch(book, bookCodes, v, K, meter).hits.map((hit) => hit.id), truth: exactTopK(PARAGRAPH_VECTORS, v, K) };
  });
  return { recall: meanRecall(pairs, K), perQuery: (meter.total - before) / EVAL_SET.length };
}
export const evalSmall = evalWith(cb, codes);
export const cb8 = trainPq(PARAGRAPH_VECTORS, M_LARGE, KSUB, { seed: SEED, meter });
export const codes8 = pqEncodeAll(cb8, PARAGRAPH_VECTORS, meter);
export const evalLarge = evalWith(cb8, codes8);
export const afterEval = meter.total;

// ---------- 规模：1000 个合成向量，M = 8、ksub = 256 ----------

export const BENCH_M = 8;
export const BENCH_KSUB = 256;
export const benchCb = trainPq(BENCH_VECTORS, BENCH_M, BENCH_KSUB, { seed: SEED, meter });
export const benchCodes = pqEncodeAll(benchCb, BENCH_VECTORS, meter);
export const afterBenchBuild = meter.total;
export const benchBuild = afterBenchBuild - afterEval;
export const benchRuns = BENCH_QUERIES.map((query) => pqSearch(benchCb, benchCodes, query, BENCH_K, meter));
export const afterBench = meter.total;
export const benchRecall = meanRecall(benchRuns.map((r, i) => ({ found: r.hits.map((hit) => hit.id), truth: BENCH_TRUTH[i] })), BENCH_K);
export const benchPerQuery = (afterBench - afterBenchBuild) / BENCH_QUERIES.length;
export const benchBytes = pqBytes(benchCb);
export const BENCH_RAW = BENCH_N * DIM * 4;
export const BENCH_CODES = BENCH_N * benchBytes.code;

// ---------- 显示 ----------

const name = (i: number) => shortName(i);
const r2 = (x: number) => fixed(x, 2);
const r3 = (x: number) => fixed(x, 3);
const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const bare = (text: string) => text.replace(/？$/, '');
const SEG_TONE: Color[] = ['violet', 'teal', 'green', 'slate'];
const segTone = (j: number): Color => SEG_TONE[j % SEG_TONE.length];
const dsub = cb.dsub;

/** 一个向量按段上色：同一段同一个颜色，热度是 |x| / 最大绝对值。 */
function segmentRow(v: readonly number[], lift?: number): RowPrim {
  const max = Math.max(...v.map(Math.abs));
  return {
    kind: 'row',
    id: 'v',
    w: 30,
    cells: v.map((x, d): DsCell => ({ v: fixed(x, 2), key: `d${d}`, tone: segTone(Math.floor(d / dsub)), heat: Math.abs(x) / max, lift: lift === Math.floor(d / dsub) || undefined })),
  };
}

/** 编码后的 4 个 uint8。 */
function codeRow(code: readonly number[], lift?: number[]): RowPrim {
  return { kind: 'row', id: 'v', w: 62, cells: code.map((c, j): DsCell => ({ v: String(c), key: `c${j}`, tone: segTone(j), sub: `第 ${j} 段`, lift: lift?.includes(j) || undefined })) };
}

/** 码本：每段一行，每个子质心一格，写它名下有几个向量。 */
function codebookGrid(lift?: number[]): GridPrim {
  return {
    kind: 'grid',
    id: 'cb',
    w: 40,
    rows: Array.from({ length: M }, (_, j) => `段${j}`),
    cols: Array.from({ length: KSUB }, (_, c) => String(c)),
    cells: cb.train.map((result, j) => result.sizes.map((size, c): DsCell => ({ v: String(size), tone: segTone(j), heat: size / Math.max(...result.sizes), lift: (lift && lift[j] === c) || undefined }))),
  };
}

/** ADC 表：table[j][c]，越小越近（热度反过来）。lift 标出某个码查到的 4 格。 */
function adcGrid(lift?: readonly number[]): GridPrim {
  const max = Math.max(...search.table.flat());
  return {
    kind: 'grid',
    id: 'cb',
    w: 40,
    rows: Array.from({ length: M }, (_, j) => `段${j}`),
    cols: Array.from({ length: KSUB }, (_, c) => String(c)),
    cells: search.table.map((row, j) => row.map((d, c): DsCell => ({ v: fixed(d, 2).replace(/^0\./, '.'), tone: lift?.[j] === c ? PART_TONE.result : 'blue', heat: 1 - d / max, lift: lift?.[j] === c || undefined }))),
  };
}

function resultRow(): RowPrim {
  return { kind: 'row', id: 'r', w: 60, cells: search.hits.map((hit): DsCell => ({ v: name(hit.id), key: `r${hit.id}`, tone: truth.includes(hit.id) ? PART_TONE.result : 'slate', sub: r2(hit.score) })) };
}

/** 真实距离和 ADC 近似距离的对照：前几名。 */
const compareIds = [...new Set([...truth, ...search.hits.map((hit) => hit.id)])].sort((a, b) => search.distances[a] - search.distances[b]);
function errorGrid(): GridPrim {
  return {
    kind: 'grid',
    id: 'e',
    w: 56,
    rows: compareIds.map((i) => name(i)),
    cols: ['真实', 'ADC'],
    cells: compareIds.map((i): DsCell[] => [{ v: r3(trueDist[i]), tone: truth.includes(i) ? PART_TONE.result : 'slate' }, { v: r3(search.distances[i]), tone: search.hits.some((hit) => hit.id === i) ? PART_TONE.result : 'slate' }]),
  };
}

function benchGrid(): GridPrim {
  const kib = (b: number) => `${+(b / 1024).toFixed(1)}K`;
  return {
    kind: 'grid',
    id: 'b',
    w: 60,
    rows: ['Flat', `PQ ${BENCH_M}×8`],
    cols: ['字节', '距离', '召回率'],
    cells: [
      [{ v: kib(BENCH_RAW), tone: 'slate' }, { v: String(BENCH_N), tone: 'slate' }, { v: '100%', tone: 'green', heat: 1 }],
      [{ v: kib(BENCH_CODES), tone: 'violet' }, { v: String(benchPerQuery), tone: PART_TONE.result }, { v: pctOf(benchRecall), tone: benchRecall >= 1 ? 'green' : 'amber', heat: benchRecall }],
    ],
  };
}

const segName = (j: number) => `第 ${j} 段（维度 ${j * dsub}–${(j + 1) * dsub - 1}）`;
const sumText = (code: readonly number[]) => code.map((c, j) => r2(search.table[j][c])).join(' + ');
const first = search.hits[0].id;

// ---------- 课程 ----------

export const pq: Lesson = {
  id: 'pq',
  name: 'PRODUCT QUANTIZATION',
  title: '乘积量化 PQ',
  group: 'index',
  layer: [3, 5],
  layerNote: '把向量本身压缩成几个字节（向量），存进索引，查询时用查表代替逐维计算（检索）。',
  distNote: `训练码本按 k-means 的口径记 ${thousands(afterTrain)} 次，编码每个向量记 ${KSUB} 次；查询时 ADC 表记 ksub 次、每个码查一次表记 1 次；最后在 ${BENCH_N} 个合成向量上训练、编码、查询，一共 ${thousands(afterBench)} 次。`,
  nodes: ['app', 'index', 'vectors', 'codes', 'results', 'scores'],
  place: { app: [100, 130], index: [430, 110], vectors: [880, 170], codes: [520, 520], results: [1080, 460], scores: [1030, 770] },
  labels: {
    app: ['应用', 'index.search(q, k)'],
    index: ['向量库', `PQ：M = ${M}，ksub = ${KSUB}`],
    vectors: ['一个向量', `${idOf(SHOW)}：${DIM} 维 → ${M} 段`],
    codes: ['码本 / ADC 表', `${M} 段 × ${KSUB} 个子质心`],
    results: ['前 k 个', '括号外是近似距离'],
    scores: ['对照', '近似和真实；PQ 和 Flat'],
  },
  labelAt: { vectors: [170, -70], codes: [0, 205], results: [0, 75], scores: [0, 120] },
  radius: { vectors: 80, codes: 170, results: 60, scores: 90 },
  initial: { vectors: [], codes: [], results: [], scores: [] },
  start: ['app', 'index'],
  legend: [['violet', '第 0 段'], ['teal', '第 1 段'], ['green', '第 2 段'], ['slate', '第 3 段'], ['amber', '查到的表项 / 结果'], [null, '距离列：累计算了几次距离']],
  overview: {
    full: '每个向量只存几个字节',
    description: `前面的索引都存原始的 float32，${DIM} 维一个向量 ${bytes.raw} 字节。乘积量化把向量切成 M 段，每段用 k-means 训练一个小码本，向量只存每段最近的子质心编号：M = ${M} 时 ${bytes.raw} 字节变成 ${bytes.code} 字节。查询不用解码，先算一张 ${M} × ${KSUB} 的距离表，每个码查 ${M} 次表加起来就是近似距离。这一课看「${bare(QUESTION)}」的近似距离怎样让两个段落换了名次，再在 ${BENCH_N} 个向量上比字节和召回率。`,
    facts: [
      ['论文', 'Jégou、Douze、Schmid，TPAMI 2011'],
      ['FAISS', 'IndexPQ(d, M, nbits)'],
      ['M', `${M} 段，每段 ${dsub} 维`],
      ['ksub', `${KSUB} 个子质心（${NBITS} 位）`],
      ['每个向量', `${bytes.raw} 字节 → ${bytes.code} 字节`],
    ],
  },
  steps: [
    {
      title: `切成 ${M} 段`,
      desc: `${DIM} 维 → ${M} × ${dsub} 维`,
      detail: `PQ 先把 ${DIM} 维的向量切成 M = ${M} 段，每段 ${dsub} 维，各段分开处理。右上角是 ${idOf(SHOW)}（${name(SHOW)}，讲杯盖密封圈的那段）的向量，四种颜色是四段。之后每一段都会被换成一个编号，所以 M 决定了压缩以后剩几个字节。`,
      facts: [['d', String(DIM)], ['M', String(M)], ['每段', `${dsub} 维`], ['原始向量', `${DIM} × 4 = ${bytes.raw} 字节`]],
      events: [
        show('vectors'),
        pk('index', 'vectors', 'violet', `${idOf(SHOW)}`, [`${DIM} 个 float32`, `切成 ${M} 段`], [0, 'VECTOR', `${idOf(SHOW)} 的 ${DIM} 维向量切成 ${M} 段，每段 ${dsub} 维`, bytes.raw],
          wire(`${idOf(SHOW)} 的向量，按段标出`, 'mem', 'format', floatVector(idOf(SHOW), PARAGRAPH_VECTORS[SHOW], 'f32', { color: 'violet', digits: 3, names: (d) => `段${Math.floor(d / dsub)}[${d % dsub}]` })),
          { ds: { vectors: [segmentRow(PARAGRAPH_VECTORS[SHOW])] } }),
        state('index', { M: String(M), ksub: String(KSUB) }),
      ],
    },
    {
      title: '每段训练一个码本',
      desc: `${M} 次 k-means，码本 ${bytes.codebook} 字节`,
      detail: `每一段单独做 k-means：${N} 个向量的这一段（${dsub} 维）聚成 ksub = ${KSUB} 类，${KSUB} 个子质心就是这一段的码本。${M} 段各跑了 ${cb.train.map((r) => r.iterations.length).join('、')} 轮，按本站的口径（${M} 次子距离合成一次完整距离）一共记 ${thousands(afterTrain)} 次距离${emptySeen ? '；训练中出现了空簇，本站保留旧的子质心，FAISS 会拆分最大的簇' : '，没有出现空簇（遇到空簇本站保留旧的子质心，FAISS 会拆分最大的簇）'}。下面的表格是每个子质心名下有几个向量，码本本身是 ${M} × ${KSUB} × ${dsub} 个 float32，${bytes.codebook} 字节，整个索引只存一份。`,
      facts: [['子质心', `每段 ${KSUB} 个`], ['轮数', cb.train.map((r) => r.iterations.length).join('、')], ['距离计算', `${thousands(afterTrain)} 次`], ['码本', `${M} × ${KSUB} × ${dsub} × 4 = ${bytes.codebook} 字节`]],
      events: [
        show('codes'),
        pk('index', 'codes', 'slate', `${M} 个码本`, cb.train.map((r, j) => `段${j}：${r.iterations.length} 轮`), [afterTrain, 'TRAIN', `${M} 段各做一次 k-means（ksub = ${KSUB}），记 ${thousands(afterTrain)} 次距离`, bytes.codebook],
          wire('码本：每段 ksub 个子质心（float32）', 'mem', 'internal', ...cb.centroids.flatMap((list, j) => list.map((c, k) => floatVector(`段${j} · 子质心 ${k}`, c, 'f32', { color: segTone(j), digits: 3, summary: `名下 ${cb.train[j].sizes[k]} 个向量` })))),
          { ds: { codes: [codebookGrid()] } }),
      ],
    },
    {
      title: `编码：${bytes.raw} 字节变 ${bytes.code} 字节`,
      desc: `${idOf(SHOW)} → [${showCode.join(', ')}]`,
      detail: `编码时每一段找最近的子质心，记下编号：${idOf(SHOW)} 变成 [${showCode.join(', ')}]，${N} 个向量从 ${thousands(N * bytes.raw)} 字节变成 ${N * bytes.code} 字节（每个向量编码要比 ${M} × ${KSUB} 次子距离，记 ${KSUB} 次）。${KSUB} 个子质心只要 ${NBITS} 位，FAISS 会把 ${M} 个编号按位紧挨着存成 ⌈${M} × ${NBITS} / 8⌉ = ${packed} 字节，本站简化成一个编号一个 uint8。压缩是有损的：把编号换回子质心拼起来，和原向量差了平方距离 ${r3(showError)}，${N} 个向量里只有 ${distinctCodes} 种不同的码，有的段落被压成了同一个码。`,
      facts: [[idOf(SHOW), `[${showCode.join(', ')}]`], ['全部向量', `${thousands(N * bytes.raw)} → ${N * bytes.code} 字节`], ['FAISS 紧挨着存', `${packed} 字节 / 向量`], ['不同的码', `${distinctCodes} 种 / ${N} 个`]],
      events: [
        pk('codes', 'vectors', 'violet', '找最近的子质心', showCode.map((c, j) => `段${j} → ${c}`), [afterEncode, 'VECTOR', `${N} 个向量逐段找最近的子质心（每个记 ${KSUB} 次）：${idOf(SHOW)} → [${showCode.join(', ')}]`, bytes.code],
          wire(`${idOf(SHOW)} 的 PQ 码：${M} 个 uint8`, 'mem', 'format', pqCodes(idOf(SHOW), showCode, cb)),
          { ds: { vectors: [codeRow(showCode)], codes: [codebookGrid(showCode)] } }),
        pk('vectors', 'index', 'violet', `${N} 个码入库`, [`${N} × ${bytes.code} = ${N * bytes.code} 字节`, `原来 ${thousands(N * bytes.raw)} 字节`], [afterEncode, 'INDEX', `${N} 个码入库：${N * bytes.code} 字节，原始向量要 ${thousands(N * bytes.raw)} 字节（码本另有 ${bytes.codebook} 字节）`, N * bytes.code],
          wire('全部 PQ 码（每个编号一个 uint8，本站的写法）', 'mem', 'internal', ...codes.map((code, i) => pqCodes(`${name(i)} ${idOf(i)}`, code, cb, { color: 'teal' }))),
          { ds: { vectors: [codeRow(showCode)] } }),
        state('index', { M: String(M), ksub: String(KSUB), 码: `${N * bytes.code} 字节`, 码本: `${bytes.codebook} 字节` }),
        note('vectors', `${bytes.raw} → ${bytes.code} 字节`, 'green'),
      ],
    },
    {
      title: 'ADC：查表算距离',
      desc: `表 ${KSUB} 次 + 查表 ${N} 次`,
      detail: `查询向量不量化（这叫非对称距离 ADC）：先把它也切成 ${M} 段，每段和这一段的 ${KSUB} 个子质心算平方距离，得到一张 ${M} × ${KSUB} 的表，计算量等于 ${KSUB} 次完整距离。之后每个码只要按编号查 ${M} 次表加起来，${idOf(first)} 的近似距离是 ${sumText(codes[first])} = ${r2(search.distances[first])}，不用碰原始向量。${N} 个码各查一次，一共 ${KSUB} + ${N} = ${afterSearch - afterEncode} 次：PQ 并没有少比，它省的是内存和每次比较的计算量（${M} 次加法代替 ${DIM} 次乘加）。`,
      facts: [['ADC 表', `${M} × ${KSUB}，记 ${KSUB} 次`], ['查表', `${N} 个码 × ${M} 次加法`], [idOf(first), `${sumText(codes[first])} = ${r2(search.distances[first])}`], ['合计', `${afterSearch - afterEncode} 次`]],
      events: [
        type(`index.search(q, k=${K})`),
        pk('app', 'index', 'blue', `search(q, k=${K})`, [QUESTION], [afterEncode, 'SEARCH', `查询「${QUESTION}」，查询向量不量化`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', q, 'f32', { color: 'blue', digits: 3, names: (d) => `段${Math.floor(d / dsub)}[${d % dsub}]` }))),
        pk('index', 'codes', 'blue', `ADC 表 ${M} × ${KSUB}`, search.table.map((row, j) => `段${j}：最近 ${r2(Math.min(...row))}`), [afterEncode + KSUB, 'SEARCH', `查询的 ${M} 段各和 ${KSUB} 个子质心算平方距离，得到 ${M} × ${KSUB} 的表（记 ${KSUB} 次）`, M * KSUB * 4],
          wire('ADC 距离表（float32）', 'mem', 'internal', ...search.table.map((row, j) => floatVector(`表 段${j}`, row, 'f32', { color: 'blue', digits: 4, names: (c) => `段${j}[${c}]` }))),
          { ds: { codes: [adcGrid()] } }),
        show('results'),
        pk('codes', 'results', 'amber', `${N} 个码查表`, search.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [afterSearch, 'SEARCH', `${N} 个码各查 ${M} 次表求和：最近的是 ${search.hits.map((hit) => `${idOf(hit.id)} ${r2(hit.score)}`).join('、')}`, N * bytes.code],
          wire(`${idOf(first)} 的码查到的 ${M} 个表项`, 'vals', '示意', concept(`${idOf(first)} = [${codes[first].join(', ')}]`, codes[first].map((c, j): [string, string, string] => [segName(j), `表[${j}][${c}] = ${num(search.table[j][c], 4)}`, `第 ${j} 段编号 ${c}。`]).concat([['合计', num(search.distances[first], 4), '这就是 ADC 近似距离。']]), 'amber')),
          { ds: { codes: [adcGrid(codes[first])], results: [resultRow()] } }),
        pk('index', 'app', 'amber', `前 ${K} 个`, search.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [afterSearch, 'CALL', `返回 ${search.hits.map((hit) => idOf(hit.id)).join('、')}（近似的平方距离）`, K * 12],
          wire('search() 的输出（ADC 近似距离）', 'mem', 'internal', ...searchOutput(search.hits, K, { metric: 'l2' }))),
      ],
    },
    {
      title: '量化误差：名次变了',
      desc: `${name(pushedOut[0])} 被 ${name(pushedIn[0])} 挤掉，召回率 ${pctOf(recall)}`,
      detail: `近似距离和真实距离有差：${idOf(pushedOut[0])} 真实是 ${r3(trueDist[pushedOut[0]])}，近似成 ${r3(search.distances[pushedOut[0]])}；${idOf(pushedIn[0])} 真实是 ${r3(trueDist[pushedIn[0]])}，近似成 ${r3(search.distances[pushedIn[0]])}，两者只差 ${r3(Math.abs(search.distances[pushedOut[0]] - search.distances[pushedIn[0]]))}，名次就换了，召回率@${K} = ${pctOf(recall)}。评估集 ${EVAL_SET.length} 个问题的平均召回率@${K}：M = ${M}（${M} 字节）是 ${pctOf(evalSmall.recall)}，M = ${M_LARGE}（${M_LARGE} 字节）是 ${pctOf(evalLarge.recall)}。M 越大码越长、误差越小，字节和召回率在这里直接交换。`,
      facts: [[idOf(pushedOut[0]), `真实 ${r3(trueDist[pushedOut[0]])} → 近似 ${r3(search.distances[pushedOut[0]])}`], [idOf(pushedIn[0]), `真实 ${r3(trueDist[pushedIn[0]])} → 近似 ${r3(search.distances[pushedIn[0]])}`], [`评估集 M = ${M}`, pctOf(evalSmall.recall)], [`评估集 M = ${M_LARGE}`, pctOf(evalLarge.recall)]],
      events: [
        show('scores'),
        pk('results', 'scores', 'amber', '和真实距离对照', compareIds.slice(0, 4).map((i) => `${name(i)} ${r2(trueDist[i])} → ${r2(search.distances[i])}`), [afterSearch, 'VECTOR', `${idOf(pushedOut[0])} 真实 ${r3(trueDist[pushedOut[0]])}、近似 ${r3(search.distances[pushedOut[0]])}，被近似 ${r3(search.distances[pushedIn[0]])} 的 ${idOf(pushedIn[0])} 挤出前 ${K}`, null],
          wire('真实平方距离和 ADC 近似距离', 'vals', '示意', concept('前几名', compareIds.map((i): [string, string, string] => [`${name(i)} ${idOf(i)}`, `${num(trueDist[i], 4)} → ${num(search.distances[i], 4)}`, `${truth.includes(i) ? `Flat 第 ${truth.indexOf(i) + 1} 名` : '不在 Flat 前 3'}；${search.hits.some((hit) => hit.id === i) ? `PQ 第 ${search.hits.findIndex((hit) => hit.id === i) + 1} 名` : '不在 PQ 前 3'}。`]), 'amber')),
          { ds: { scores: [errorGrid()] } }),
        pk('app', 'index', 'slate', `评估集 M = ${M} / ${M_LARGE}`, [`M = ${M}：${pctOf(evalSmall.recall)}`, `M = ${M_LARGE}：${pctOf(evalLarge.recall)}`], [afterEval, 'EVAL', `再训练一个 M = ${M_LARGE} 的码本；${EVAL_SET.length} 个评估问题的平均召回率@${K}：M = ${M} ${pctOf(evalSmall.recall)}，M = ${M_LARGE} ${pctOf(evalLarge.recall)}`, null],
          wire('M 和召回率', 'vals', '示意', concept('评估集', [
            [`M = ${M}`, `${M} 字节 · ${pctOf(evalSmall.recall)}`, `每次查询 ${KSUB} + ${N} = ${evalSmall.perQuery} 次。`],
            [`M = ${M_LARGE}`, `${M_LARGE} 字节 · ${pctOf(evalLarge.recall)}`, `每段 ${DIM / M_LARGE} 维，误差更小。`],
          ], 'green'))),
        note('scores', `差 ${r3(Math.abs(search.distances[pushedOut[0]] - search.distances[pushedIn[0]]))} 就换了名次`, 'amber'),
      ],
    },
    {
      title: `放大到 ${BENCH_N} 个向量`,
      desc: `${thousands(BENCH_RAW)} → ${thousands(BENCH_CODES)} 字节，召回率 ${pctOf(benchRecall)}`,
      detail: `在 ${BENCH_N} 个合成向量上用 M = ${BENCH_M}、ksub = ${BENCH_KSUB}（8 位，正好一个 uint8，和 FAISS 的存法一致）：码一共 ${thousands(BENCH_CODES)} 字节，原始向量 ${thousands(BENCH_RAW)} 字节，码本另要 ${thousands(benchBytes.codebook)} 字节。训练和编码记了 ${thousands(benchBuild)} 次距离；每次查询是 ${BENCH_KSUB} + ${BENCH_N} = ${benchPerQuery} 次，比 Flat 的 ${BENCH_N} 次还多，召回率@${BENCH_K} = ${pctOf(benchRecall)}。所以 PQ 很少单独用：FAISS 的 IndexIVFPQ 先用 IVF 只扫几簇，簇里再用 PQ 码，每个向量 ⌈M × nbits / 8⌉ + 8 字节，距离次数和内存一起降下来。`,
      facts: [['码', `${BENCH_N} × ${BENCH_M} = ${thousands(BENCH_CODES)} 字节`], ['原始', `${thousands(BENCH_RAW)} 字节`], ['码本', `${thousands(benchBytes.codebook)} 字节`], ['每次查询', `${benchPerQuery} 次 · 召回率 ${pctOf(benchRecall)}`]],
      events: [
        pk('app', 'index', 'violet', `训练 M = ${BENCH_M}，ksub = ${BENCH_KSUB}`, [`${thousands(benchBuild)} 次距离`, `码 ${thousands(BENCH_CODES)} 字节`], [afterBenchBuild, 'TRAIN', `${BENCH_N} 个合成向量训练码本（M = ${BENCH_M}，ksub = ${BENCH_KSUB}）并编码：${thousands(benchBuild)} 次距离`, null],
          wire('训练和编码的成本', 'vals', '示意', concept(`${BENCH_N} 个向量`, [
            ['码本', `${thousands(benchBytes.codebook)} 字节`, `${BENCH_M} × ${BENCH_KSUB} × ${DIM / BENCH_M} 个 float32。`],
            ['码', `${thousands(BENCH_CODES)} 字节`, `每个向量 ${BENCH_M} 个 uint8。`],
            ['原始向量', `${thousands(BENCH_RAW)} 字节`, 'Flat 要存的。'],
          ], 'violet'))),
        pk('app', 'index', 'amber', `${BENCH_QUERIES.length} 个问题`, [`每次 ${benchPerQuery} 次`, `召回率@${BENCH_K} ${pctOf(benchRecall)}`], [afterBench, 'SEARCH', `${BENCH_QUERIES.length} 个评估问题各查一次：每次 ${BENCH_KSUB} + ${BENCH_N} = ${benchPerQuery} 次，召回率@${BENCH_K} ${pctOf(benchRecall)}`, null],
          wire('PQ 和 Flat', 'vals', '示意', concept(`${BENCH_N} 个向量`, [
            ['Flat', `${thousands(BENCH_RAW)} 字节 · ${BENCH_N} 次 · 100%`, '原始 float32，逐个比。'],
            [`PQ M = ${BENCH_M}`, `${thousands(BENCH_CODES)} 字节 · ${benchPerQuery} 次 · ${pctOf(benchRecall)}`, `表 ${BENCH_KSUB} 次 + 每个码查一次。`],
          ], 'amber')),
          { ds: { scores: [benchGrid()] } }),
        note('scores', `字节少到 1/${BENCH_RAW / BENCH_CODES}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '用精度换内存',
    desc: `${bytes.raw} 字节 → ${bytes.code} 字节；召回率 ${pctOf(evalSmall.recall)}（M = ${M}）`,
    text: `PQ 把每个向量压成 M 个子质心编号，内存降到原来的几分之一到几十分之一，查询用一张 ADC 表把每次比较变成 M 次加法。它不减少比较的次数，量化误差还会让离得近的几个段落换名次，所以实际系统常把它和 IVF 合用（IndexIVFPQ），或者先用 PQ 粗排、再拿原始向量重排前几名。下一课回到「找什么」：先按元数据把作废的文档过滤掉，再把关键词检索和向量检索的排名合在一起。`,
    facts: [['M = 4', `${bytes.code} 字节 · ${pctOf(evalSmall.recall)}`], ['M = 8', `${M_LARGE} 字节 · ${pctOf(evalLarge.recall)}`], [`${BENCH_N} 个，M = ${BENCH_M}`, `${pctOf(benchRecall)}`], ['下一课', '元数据过滤与混合检索']],
  },
};

