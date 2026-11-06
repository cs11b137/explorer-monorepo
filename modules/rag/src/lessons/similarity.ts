/**
 * 第二课：相似度。同一个问题和知识库里的真实段落向量，算点积、余弦、欧氏距离；
 * 看向量没归一化时点积怎样偏向长向量（这组例子里排序真的会变），归一化之后三种度量排序一致，再把一次点积拆到 float32 的每个字节。
 *
 * 全部由 core/ 实时计算：未归一化的向量是 embed() 的 pooled（加权平均，还没除以长度），归一化的是 PARAGRAPH_VECTORS。
 * 没有模型写的文字。tests/narrative.test.ts 核对文案。
 */
import {
  DistanceMeter,
  dot,
  cosine,
  embed,
  exactTopK,
  f32VectorBytes,
  flatSearch,
  l2,
  l2sq,
  norm,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  EVAL_SET,
  topK,
  type Metric,
} from '../core';
import { concept, floatVector, num, wire } from '../decode/structures';
import { comp, fixed, PART_TONE, vectorRow } from './common';
import { note, pk, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 问题和候选段落 ----------

const EVAL_ITEM = EVAL_SET.find((item) => item.id === 'return-fee')!;
/** 查询：评估集里的「不想要了退货，运费谁出？」，标注的相关段落是 aftersale#0 和 shipping-fee#0。 */
export const QUESTION = EVAL_ITEM.question;
export const DIMS = 16;

export const qe = embed(QUESTION);
/** 查询向量：池化后还没归一化的（长度 ≈ 0.17），和归一化后的（长度 1）。 */
export const qRaw = qe.pooled;
export const qUnit = qe.vector;

/** 全部段落的池化向量（没归一化）。 */
export const raw = PARAGRAPHS.map((item) => embed(item.text).pooled);
export const rawNorm = raw.map((v) => norm(v));
export const rawDot = raw.map((v) => dot(qRaw, v));
export const rawCos = raw.map((v) => cosine(qRaw, v));
export const rawL2 = raw.map((v) => l2(qRaw, v));
export const unitDot = PARAGRAPH_VECTORS.map((v) => dot(qUnit, v));
export const unitL2sq = PARAGRAPH_VECTORS.map((v) => l2sq(qUnit, v));

/** 未归一化时点积的名次（从近到远的段落下标）和余弦的名次。 */
export const orderByDot = topK('ip', rawDot, PARAGRAPHS.length).map((hit) => hit.id);
export const orderByCos = topK('cosine', rawCos, PARAGRAPHS.length).map((hit) => hit.id);
export const rankDot = (i: number): number => orderByDot.indexOf(i) + 1;
export const rankCos = (i: number): number => orderByCos.indexOf(i) + 1;

/** 候选：点积前 4 名和余弦前 4 名的并集，按余弦从高到低。 */
export const CAND: number[] = [...new Set([...orderByDot.slice(0, 4), ...orderByCos.slice(0, 4)])].sort((a, b) => rawCos[b] - rawCos[a]);
const idOf = (i: number): string => PARAGRAPHS[i].id;

/** 点积冠军和余弦冠军。 */
export const dotWinner = orderByDot[0];
export const cosWinner = orderByCos[0];
/** 点积前 4 里有、余弦前 4 里没有的段落（因为向量长而挤进来）。 */
export const intruder = orderByDot.slice(0, 4).find((i) => !orderByCos.slice(0, 4).includes(i))!;
/** 余弦前 4 里有、点积前 4 里没有的（被挤出去的）。 */
export const pushedOut = orderByCos.slice(0, 4).find((i) => !orderByDot.slice(0, 4).includes(i))!;

// ---------- 第 1 步：同一对向量的三个数 ----------

/** 例子：未归一化的查询和点积冠军。 */
export const pairIndex = dotWinner;
export const pair = { dot: rawDot[pairIndex], cosine: rawCos[pairIndex], l2: rawL2[pairIndex], qNorm: norm(qRaw), pNorm: rawNorm[pairIndex] };

// ---------- 第 3 步：归一化之后 ----------

const METRICS: Metric[] = ['ip', 'cosine', 'l2'];
/** 归一化的向量上，三种度量各自的全部 27 个段落的排序。 */
export const orders = Object.fromEntries(METRICS.map((metric) => [metric, flatSearch(PARAGRAPH_VECTORS, qUnit, PARAGRAPHS.length, metric).hits.map((hit) => hit.id)])) as Record<Metric, number[]>;
export const sameOrder = orders.ip.every((id, rank) => orders.cosine[rank] === id && orders.l2[rank] === id);
/** ‖a−b‖² 和 2 − 2·cos 之差的最大绝对值（float32 舍入造成）。 */
export const identityGap = Math.max(...PARAGRAPH_VECTORS.map((_, i) => Math.abs(unitL2sq[i] - (2 - 2 * unitDot[i]))));

// ---------- 第 4 步：float32 逐字节的点积累加 ----------

/** 例子：归一化的查询和余弦冠军。 */
export const accIndex = cosWinner;
export const accA = qUnit;
export const accB = PARAGRAPH_VECTORS[accIndex];
export const products = accA.map((x, i) => x * accB[i]);
/** 本站的累加：float64 里逐个加。 */
export const partial64: number[] = [];
products.reduce((sum, p) => (partial64.push(sum + p), sum + p), 0);
/** 如果每一步都舍入回 float32 再累加，得到的值。 */
export const sum32 = products.reduce((sum, p) => Math.fround(sum + Math.fround(p)), 0);
export const sum64 = partial64[partial64.length - 1];
export const sumBytes = f32VectorBytes([sum64]);
export const accGap = Math.abs(sum32 - sum64);
/** 点积累加用到的乘法和加法次数；余弦要多算两个长度。 */
export const costs = { dot: DIMS, cosine: 3 * DIMS };

// ---------- 第 5 步：向量库 ----------

export const meter = new DistanceMeter();
export const TOP = 5;
export const search = flatSearch(PARAGRAPH_VECTORS, qUnit, TOP, 'ip');
export const topIds = search.hits.map((hit) => hit.id);
export const topByCos = exactTopK(PARAGRAPH_VECTORS, qUnit, TOP, 'cosine');
export const topByL2 = exactTopK(PARAGRAPH_VECTORS, qUnit, TOP, 'l2');
/** 每步的距离计数：每步里，查询和一个段落比较一次记 1 次，同一对换几种度量算也只记一次。 */
const dist = { s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
meter.add('query', 1);
dist.s1 = meter.total;
meter.add('query', CAND.length);
dist.s2 = meter.total;
meter.add('query', CAND.length);
dist.s3 = meter.total;
meter.add('query', 1);
dist.s4 = meter.total;
meter.add('query', search.computed);
dist.s5 = meter.total;

export const numbers = {
  candidates: CAND.length,
  paragraphs: PARAGRAPHS.length,
  qNorm: pair.qNorm,
};

const N = numbers;
const bare = (q: string): string => q.replace(/？$/, '');
const id3 = (x: number): string => x.toFixed(3);

// ---------- 图元 ----------

const gridOf = (id: string, rows: string[], cols: string[], cells: DsCell[][], w = 66): GridPrim => ({ kind: 'grid', id, rows, cols, cells, w });
const cell = (v: string, tone?: DsCell['tone'], heat?: number): DsCell => ({ v, tone, heat });

const qRawRow = (): RowPrim => vectorRow('q', qRaw, { tone: PART_TONE.query, w: 27, keyPrefix: 'q', marks: [{ at: 0, text: `‖q‖ = ${num(N.qNorm, 3)}`, color: 'blue', dx: -20 }] });
const qUnitRow = (): RowPrim => vectorRow('q', qUnit, { tone: PART_TONE.query, w: 27, keyPrefix: 'q', marks: [{ at: 0, text: '‖q‖ = 1', color: 'green', dx: -20 }] });

const pairRow = (): RowPrim => vectorRow('p', raw[pairIndex], { w: 27, keyPrefix: 'p', marks: [{ at: 0, text: `${idOf(pairIndex)}  ‖p‖ = ${num(pair.pNorm, 3)}`, color: 'violet', dx: 40 }] });

const pairCells = (): RowPrim => ({
  kind: 'row',
  id: 'm',
  w: 74,
  cells: [
    { v: fixed(pair.dot, 4), sub: '点积', tone: 'blue', heat: pair.dot / pair.cosine },
    { v: fixed(pair.cosine, 4), sub: '余弦', tone: 'green', heat: pair.cosine },
    { v: fixed(pair.l2, 4), sub: '欧氏距离', tone: 'amber', heat: pair.l2 },
  ],
});

const rawGrid = (): GridPrim =>
  gridOf(
    's',
    CAND.map(idOf),
    ['长度', '点积', '余弦', '点/余名次'],
    CAND.map((i) => [
      cell(id3(rawNorm[i]), 'violet', rawNorm[i] / 0.25),
      cell(fixed(rawDot[i], 4), 'blue', rankDot(i) <= 4 ? 0.9 : 0.3),
      cell(fixed(rawCos[i], 3), 'green', rawCos[i]),
      cell(`${rankDot(i)} / ${rankCos(i)}`, rankDot(i) === rankCos(i) ? 'dim' : 'amber'),
    ]),
    62,
  );

const unitGrid = (): GridPrim =>
  gridOf(
    's',
    CAND.map(idOf),
    ['点积', '余弦', '‖a−b‖²', '2−2cos'],
    CAND.map((i) => [cell(fixed(unitDot[i], 4), 'blue', unitDot[i]), cell(fixed(rawCos[i], 4), 'green', rawCos[i]), cell(fixed(unitL2sq[i], 4), 'amber', unitL2sq[i] / 2), cell(fixed(2 - 2 * unitDot[i], 4), 'amber', (2 - 2 * unitDot[i]) / 2)]),
    66,
  );

const productRow = (): RowPrim => ({
  kind: 'row',
  id: 'prod',
  w: 27,
  cells: products.map((x, i): DsCell => ({ v: comp(x), heat: Math.abs(x) / Math.max(...products.map(Math.abs)), tone: x < 0 ? 'amber' : 'violet', key: `x${i}` })),
  title: 'a[i] × b[i]',
});

const partialRow = (): RowPrim => ({
  kind: 'row',
  id: 'sum',
  w: 27,
  cells: partial64.map((x, i): DsCell => ({ v: comp(x), heat: Math.min(1, Math.abs(x)), tone: 'green', key: `s${i}` })),
  marks: [{ at: DIMS - 1, text: `= ${fixed(sum64, 4)}`, color: 'green', dx: 30 }],
  title: '累加到第 i 维',
});

const topRow = (): RowPrim => ({
  kind: 'row',
  id: 'top',
  w: 70,
  cells: search.hits.map((hit, rank): DsCell => ({ v: fixed(hit.score, 3), sub: `${rank + 1}`, tone: PART_TONE.result, heat: hit.score, key: idOf(hit.id), lift: rank === 0 || undefined })),
  title: '点积前 5',
});

/** 前 5 个段落，在三种度量下各自排第几（归一化向量，全部 27 段里的名次）。 */
const orderGrid = (): GridPrim =>
  gridOf(
    'o',
    topIds.map(idOf),
    ['点积', '余弦', '欧氏²'],
    topIds.map((id) => METRICS.map((metric) => cell(`第 ${orders[metric].indexOf(id) + 1}`, metric === 'ip' ? 'blue' : metric === 'cosine' ? 'green' : 'amber', 0.6))),
    70,
  );

// ---------- 课程 ----------

export const similarity: Lesson = {
  id: 'similarity',
  name: 'SIMILARITY',
  title: '相似度：余弦、点积与归一化',
  group: 'embed',
  layer: [3, 5],
  layerNote: '比较的是向量，所以在「向量」这一档；最后一步在整个知识库里取最近的 5 个，落到「检索」。',
  distNote: `每步里查询和一个段落比较一次记 1 次，同一对换几种度量算只记一次；最后一步暴力扫 ${N.paragraphs} 个段落，累计 ${meter.total} 次。`,
  nodes: ['app', 'index', 'query', 'vectors', 'scores', 'results'],
  place: { app: [90, 120], index: [560, 60], query: [450, 340], vectors: [850, 560], scores: [200, 700], results: [990, 260] },
  labels: {
    app: ['应用', 'search_docs()'],
    index: ['向量库', `${N.paragraphs} 个段落的向量`],
    query: ['查询向量', `${DIMS} 个分量`],
    vectors: ['段落向量', '被比较的段落'],
    scores: ['相似度', '三种度量'],
    results: ['检索结果', '前 5 个'],
  },
  labelAt: { query: [-250, -10], vectors: [-240, -30], scores: [-330, 100], results: [-230, 10] },
  radius: { query: 60, vectors: 80, scores: 70, results: 70 },
  initial: { query: [], vectors: [], scores: [], results: [] },
  start: ['app', 'index', 'query'],
  legend: [['blue', '查询和点积'], ['violet', '段落向量'], ['green', '余弦和归一化'], ['amber', '欧氏距离和检索结果'], [null, '距离列：查询和段落比较过几次']],
  overview: {
    full: '点积、余弦和欧氏距离',
    description: `向量检索要回答的问题是「哪个向量离查询最近」，「近」有三种量法：点积、余弦、欧氏距离。这一课拿「${QUESTION}」和知识库里的真实段落向量，先在没归一化的向量上把三个数都算出来，看点积怎样偏向长向量，再归一化，看三种度量怎样排出同一个顺序，最后把一次点积拆到 float32 的每个字节。`,
    facts: [
      ['查询', `「${QUESTION}」`],
      ['未归一化时', `点积第 1 名 ${idOf(dotWinner)}，余弦第 1 名 ${idOf(cosWinner)}`],
      ['归一化后', `三种度量${sameOrder ? '的顺序完全一致' : '的顺序不同'}`],
      ['一次点积', `${DIMS} 次乘、${DIMS} 次加`],
    ],
  },
  steps: [
    {
      title: '同一对向量，三个数',
      desc: `点积 ${fixed(pair.dot, 4)}，余弦 ${fixed(pair.cosine, 4)}，欧氏距离 ${fixed(pair.l2, 4)}`,
      detail: `应用把「${bare(QUESTION)}」的查询向量交给向量库，这里先用嵌入过程中还没除以长度的版本（池化之后的向量，长度 ${num(pair.qNorm, 3)}）。它和段落 ${idOf(pairIndex)} 的向量之间有三种量法：点积把对应分量相乘再相加，余弦是点积除以两个向量的长度，欧氏距离是两点之间的直线距离。同一对向量，三个数是 ${fixed(pair.dot, 4)}、${fixed(pair.cosine, 4)}、${fixed(pair.l2, 4)}，量纲不同，点积和距离还都带着向量长度，所以不看长度，光看点积分不出相似还是不相似。`,
      facts: [['点积', `Σ a[i] × b[i] = ${fixed(pair.dot, 4)}`], ['余弦', `点积 ÷ (‖q‖ × ‖p‖) = ${fixed(pair.cosine, 4)}`], ['欧氏距离', `√Σ (a[i] − b[i])² = ${fixed(pair.l2, 4)}`], ['长度', `‖q‖ = ${num(pair.qNorm, 3)}，‖p‖ = ${num(pair.pNorm, 3)}`]],
      events: [
        type(`search_docs("${QUESTION}")`),
        pk('app', 'index', 'blue', '查询向量', [`「${QUESTION}」`, `未归一化，‖q‖ = ${num(pair.qNorm, 3)}`], [0, 'VECTOR', `查询向量（池化后、归一化前），${DIMS} 个 float32，长度 ${num(pair.qNorm, 3)}`, DIMS * 4],
          wire('查询向量：嵌入过程中，除以长度之前的值（本站模型的内部数据）', 'mem', 'internal', floatVector('q', qRaw, 'f32', { color: 'blue', summary: `长度 ${num(pair.qNorm, 4)}`, digits: 4 })),
          { ds: { query: [qRawRow()] } }),
        show('vectors', 'scores'),
        pk('index', 'scores', 'amber', '三种量法', [`点积 ${fixed(pair.dot, 4)}`, `余弦 ${fixed(pair.cosine, 4)}`, `距离 ${fixed(pair.l2, 4)}`], [dist.s1, 'VECTOR', `查询和 ${idOf(pairIndex)} 比较一次：点积 ${fixed(pair.dot, 4)}，余弦 ${fixed(pair.cosine, 4)}，欧氏距离 ${fixed(pair.l2, 4)}`, 2 * DIMS * 4],
          wire(`查询和 ${idOf(pairIndex)} 的向量，以及三个数`, 'mem', 'internal',
            floatVector('q', qRaw, 'f32', { color: 'blue', digits: 4, summary: `长度 ${num(pair.qNorm, 4)}` }),
            floatVector('p', raw[pairIndex], 'f32', { color: 'violet', digits: 4, summary: `${idOf(pairIndex)}，长度 ${num(pair.pNorm, 4)}` }),
            concept('三个数', [
              ['点积', num(pair.dot, 5), 'Σ q[i] × p[i]，同时取决于方向和长度。'],
              ['余弦', num(pair.cosine, 5), '点积除以两个长度，只看方向，范围 −1 到 1。'],
              ['欧氏距离', num(pair.l2, 5), '越小越近；两个向量都很短时，距离天然很小，同样不能单独解读。'],
            ], 'amber')),
          { ds: { vectors: [pairRow()], scores: [pairCells()] } }),
        state('index', { 度量: '点积 / 余弦 / 欧氏', 向量: '未归一化' }),
      ],
    },
    {
      title: '没归一化，点积偏向长向量',
      desc: `点积第 1 名 ${idOf(dotWinner)}，余弦第 1 名 ${idOf(cosWinner)}`,
      detail: `把候选换成点积前 4 名和余弦前 4 名合起来的 ${N.candidates} 个段落。${idOf(cosWinner)} 和查询的夹角更小，余弦 ${fixed(rawCos[cosWinner], 3)} 比 ${idOf(dotWinner)} 的 ${fixed(rawCos[dotWinner], 3)} 高；但 ${idOf(dotWinner)} 的向量长 ${fixed((rawNorm[dotWinner] / rawNorm[cosWinner] - 1) * 100, 1)}%，点积反而排第 1，两种度量的第 1 名换了人。更明显的是 ${idOf(intruder)}：它的余弦只有 ${fixed(rawCos[intruder], 3)}（第 ${rankCos(intruder)} 名），向量长 ${num(rawNorm[intruder], 3)}，点积挤进了第 ${rankDot(intruder)} 名，把 ${idOf(pushedOut)} 挤出了前 4。这个例子里前两名都是标注的相关段落，丢的不是答案，但长度占了便宜的事实不会变。`,
      facts: [['点积第 1 名', `${idOf(dotWinner)}（长 ${id3(rawNorm[dotWinner])}）`], ['余弦第 1 名', `${idOf(cosWinner)}（长 ${id3(rawNorm[cosWinner])}）`], ['挤进前 4', `${idOf(intruder)}，余弦第 ${rankCos(intruder)} 名`], ['挤出前 4', idOf(pushedOut)]],
      events: [
        pk('index', 'scores', 'amber', `${N.candidates} 个候选`, CAND.map((i) => `${idOf(i)}  点积 ${fixed(rawDot[i], 4)}  余弦 ${fixed(rawCos[i], 3)}`).slice(0, 4), [dist.s2, 'VECTOR', `查询和 ${N.candidates} 个候选各比一次，点积和余弦的第 1 名不同：${idOf(dotWinner)}、${idOf(cosWinner)}`, N.candidates * DIMS * 4],
          wire(`${N.candidates} 个候选段落的长度、点积、余弦（都是未归一化的向量）`, 'mem', 'internal',
            ...CAND.map((i) => floatVector(idOf(i), raw[i], 'f32', { color: 'violet', digits: 4, summary: `长度 ${num(rawNorm[i], 4)}，点积 ${num(rawDot[i], 4)}，余弦 ${num(rawCos[i], 4)}` })),
            concept('长度', CAND.map((i): [string, string, string] => [idOf(i), num(rawNorm[i], 4), `余弦 ${fixed(rawCos[i], 4)}，第 ${rankCos(i)} 名。`]), 'violet'),
            concept('点积', CAND.map((i): [string, string, string] => [idOf(i), num(rawDot[i], 5), `第 ${rankDot(i)} 名；点积 = 余弦 × ${num(N.qNorm, 3)} × ${num(rawNorm[i], 3)}。`]), 'blue')),
          { ds: { vectors: [], scores: [rawGrid()] } }),
        note('scores', `点积第 1：${idOf(dotWinner)}；余弦第 1：${idOf(cosWinner)}`, 'amber'),
      ],
    },
    {
      title: '归一化，三种度量一个顺序',
      desc: `长度都变成 1，三种度量的顺序${sameOrder ? '完全一致' : '不同'}`,
      detail: `向量除以自己的长度之后，查询和段落的长度都是 1，点积里的长度因子（比如 ${num(N.qNorm, 3)} × ${num(rawNorm[dotWinner], 3)}）消失了，剩下的就是余弦。单位向量之间，欧氏距离的平方 ‖a − b‖² = ‖a‖² + ‖b‖² − 2a·b = 2 − 2cos，是余弦的递减函数，距离越小余弦越大。对全部 ${N.paragraphs} 个段落，点积、余弦、欧氏距离排出的顺序${sameOrder ? '逐名相同' : '并不相同'}，‖a − b‖² 和 2 − 2cos 之间只差 float32 的舍入（最大差 ${identityGap.toExponential(1)}）。OpenAI 和 Voyage 的嵌入接口返回的向量已经归一化到长度 1，所以向量库可以只算最便宜的点积。`,
      facts: [['点积 = 余弦', '长度都是 1'], ['‖a−b‖²', '= 2 − 2cos'], ['27 段的顺序', sameOrder ? '三种度量一致' : '不一致'], ['OpenAI / Voyage', '返回的嵌入已归一化']],
      events: [
        pk('index', 'scores', 'green', '归一化后再比', [`点积 = 余弦`, `‖a−b‖² = 2 − 2cos`], [dist.s3, 'VECTOR', `${N.candidates} 个候选在单位向量上比较：点积等于余弦，距离平方等于 2 − 2cos，顺序一致`, (N.candidates + 1) * DIMS * 4],
          wire('单位向量上的三种度量', 'mem', 'format',
            floatVector('q（归一化）', qUnit, 'f32', { color: 'blue', digits: 3, summary: `长度 ${num(norm(qUnit), 6)}` }),
            ...CAND.map((i) => floatVector(idOf(i), PARAGRAPH_VECTORS[i], 'f32', { color: 'violet', digits: 3, summary: `长度 ${num(norm(PARAGRAPH_VECTORS[i]), 6)}` })),
            concept('点积、距离平方、2 − 2cos', CAND.map((i): [string, string, string] => [idOf(i), `${num(unitDot[i], 5)} / ${num(unitL2sq[i], 5)}`, `点积 / ‖a − b‖²；2 − 2 × 点积 = ${num(2 - 2 * unitDot[i], 5)}。`]), 'green')),
          { ds: { query: [qUnitRow()], vectors: [], scores: [unitGrid()] } }),
        state('index', { 度量: '点积 / 余弦 / 欧氏', 向量: '已归一化' }),
        note('scores', '三种度量，同一个顺序', 'green'),
      ],
    },
    {
      title: '点积是怎么累加出来的',
      desc: `${DIMS} 次乘法、${DIMS} 次加法，结果 ${fixed(sum64, 4)}`,
      detail: `拿查询和 ${idOf(accIndex)}（归一化后的余弦第 1 名）看一次点积的内部：每个分量各取 4 个字节的 float32，两两相乘得到 ${DIMS} 个乘积，再从第 0 维加到第 ${DIMS - 1} 维，最后的和是 ${fixed(sum64, 6)}，存回去又是 4 个字节 ${sumBytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}。本站在 float64 里累加；如果每一步都舍入回 float32，结果是 ${fixed(sum32, 6)}，差 ${accGap.toExponential(1)}，对排序没有影响。余弦还要再算两个长度，约 ${costs.cosine} 次乘法，点积只要 ${costs.dot} 次，归一化把这笔账提前算掉了。`,
      facts: [['乘法', `${DIMS} 次，每个 float32 4 字节`], ['点积', fixed(sum64, 6)], ['float32 累加', `${fixed(sum32, 6)}，差 ${accGap.toExponential(1)}`], ['余弦的代价', `约 ${costs.cosine} 次乘法，点积 ${costs.dot} 次`]],
      events: [
        pk('index', 'scores', 'violet', '逐维相乘、累加', [`${idOf(accIndex)}`, `${DIMS} 个乘积`, `和 = ${fixed(sum64, 4)}`], [dist.s4, 'VECTOR', `${DIMS} 维逐个相乘再累加，和 ${fixed(sum64, 6)} 写成 4 个字节`, 2 * DIMS * 4 + 4],
          wire(`查询和 ${idOf(accIndex)} 的点积，逐字节`, 'mem', 'format',
            floatVector('a（查询）', accA, 'f32', { color: 'blue', digits: 3, summary: '4 字节一个分量，小端' }),
            floatVector('b（段落）', accB, 'f32', { color: 'violet', digits: 3, summary: idOf(accIndex) }),
            concept('累加', products.map((x, i): [string, string, string] => [`${i} · ${num(accA[i], 3)} × ${num(accB[i], 3)}`, `${num(x, 4)} → ${num(partial64[i], 4)}`, `第 ${i} 维的乘积，和累加到 ${num(partial64[i], 6)}。`]), 'green', `${DIMS} 个乘积依次累加`),
            floatVector('点积', [sum64], 'f32', { color: 'green', bits: true, digits: 6, summary: '结果写回 float32：符号、指数、尾数' })),
          { ds: { vectors: [productRow()], scores: [partialRow()] } }),
      ],
    },
    {
      title: '向量库：扫一遍，取前 5',
      desc: `点积扫 ${N.paragraphs} 个段落，前 5 名和余弦、欧氏距离相同`,
      detail: `向量库拿归一化的查询向量，对 ${N.paragraphs} 个段落向量各算一次点积，取最大的 5 个（暴力 kNN，FAISS 里叫 IndexFlatIP）。同样的 5 个段落，用余弦排是${topIds.every((id, i) => topByCos[i] === id) ? '同一个顺序' : '不同顺序'}，用欧氏距离排也是${topIds.every((id, i) => topByL2[i] === id) ? '同一个顺序' : '不同顺序'}（IndexFlatL2 存的是平方距离，省掉开方不影响排序）。pgvector 的运算符有余弦、负内积、欧氏距离等，Chroma 默认用平方 L2；归一化过的向量用哪个都一样，选最省的点积就行。`,
      facts: [['第 1 名', `${idOf(topIds[0])}（${fixed(search.hits[0].score, 3)}）`], ['比较次数', `${search.computed} 次`], ['余弦 / 欧氏', '前 5 名同序'], ['累计', `${meter.total} 次`]],
      events: [
        show('results'),
        pk('index', 'results', 'amber', '前 5 个', search.hits.map((hit) => `${idOf(hit.id)}  ${fixed(hit.score, 3)}`), [dist.s5, 'SEARCH', `点积扫 ${search.computed} 个向量，取前 5：${topIds.map(idOf).join('、')}`, TOP * 4],
          wire('检索结果：前 5 个的分数（float32）和下标', 'mem', 'internal',
            floatVector('分数', search.hits.map((hit) => hit.score), 'f32', { color: 'amber', digits: 4, summary: '前 5 名的点积，从高到低' }),
            concept('前 5 名（点积）', search.hits.map((hit, rank): [string, string, string] => [`第 ${rank + 1} 名 · ${idOf(hit.id)}`, num(hit.score, 4), `向量库里的第 ${hit.id} 个向量；用余弦第 ${topByCos.indexOf(hit.id) + 1} 名，用欧氏距离第 ${topByL2.indexOf(hit.id) + 1} 名。`]), 'amber')),
          { ds: { results: [topRow()], scores: [orderGrid()] } }),
        note('results', `三种度量，前 ${TOP} 名一致`, 'green'),
      ],
    },
  ],
  outro: {
    title: '归一化之后，点积就够了',
    desc: `没归一化时第 1 名不同，归一化后 ${N.paragraphs} 段的顺序一致`,
    text: `点积、余弦、欧氏距离是同一件事的三种写法：向量长度不一样时，它们会给出不同的名次，点积偏向长向量；向量归一化之后，点积等于余弦，欧氏距离的平方等于 2 − 2 × 余弦，名次完全一致，向量库只需要算最便宜的点积。这一课的向量是整段知识库里的段落，段落有多长、从哪里切开，同样会影响向量和检索的结果。下一课是分块：同一篇文档按不同的长度和重叠切开，相同的问题检索到的块、相似度会怎样变化。`,
    facts: [['点积 = 余弦', '向量长度为 1 时'], ['‖a−b‖²', '= 2 − 2cos'], ['累计比较', `${meter.total} 次`], ['下一课', '分块策略与重叠']],
  },
};
