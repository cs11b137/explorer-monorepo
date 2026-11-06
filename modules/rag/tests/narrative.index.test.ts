/**
 * 文案和计算结果对得上（向量检索组：flat、ivf、hnsw、pq、hybrid）。
 * 1. 关键的数写死在这里（距离次数、召回率、名次、字节数），改了知识库、嵌入模型或种子会立刻报错，按报错改文案；
 * 2. 文字里没法直接取值的说法逐条核对：「排序相同」「漏掉的是第 1 名」「只有它含 SR-35」「两者只差 0.001」这类。
 */
import { describe, expect, it } from 'vitest';
import {
  BENCH_N,
  BENCH_TRUTH,
  BENCH_VECTORS,
  benchVectors,
  bm25Search,
  buildHnsw,
  DistanceMeter,
  dot,
  exactTopK,
  flatSearch,
  l2sq,
  norm,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  pqEncode,
  pqDecode,
  rrf,
  scanTopK,
  termsOf,
  topK,
} from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf, type Lesson } from '../src/lessons/types';
import * as F from '../src/lessons/flat';
import * as I from '../src/lessons/ivf';
import * as H from '../src/lessons/hnsw';
import * as P from '../src/lessons/pq';
import * as Y from '../src/lessons/hybrid';
import { POS, shortName } from '../src/lessons/index-common';

const id = (i: number) => PARAGRAPHS[i].id;
const ids = (hits: ReadonlyArray<{ id: number }>) => hits.map((hit) => id(hit.id));
const factsOf = (lesson: Lesson, step: number) => Object.fromEntries(lesson.steps[step].facts);
const dists = (lesson: Lesson) => packetsOf(lesson).map((packet) => packet.row.dist);
const last = (lesson: Lesson) => dists(lesson)[dists(lesson).length - 1];

describe('共用：合成数据、画法', () => {
  it('合成数据：1000 个单位向量，第 i 个来自段落 i mod 27，固定种子可复现', () => {
    expect(BENCH_VECTORS).toHaveLength(1000);
    for (const v of BENCH_VECTORS.slice(0, 54)) expect(norm(v)).toBeCloseTo(1, 6);
    expect(benchVectors()).toEqual(BENCH_VECTORS);
    // 加了噪声以后，绝大多数向量离自己的来源段落仍然最近。
    const own = BENCH_VECTORS.filter((v, i) => exactTopK(PARAGRAPH_VECTORS, v, 1)[0] === i % PARAGRAPH_VECTORS.length).length;
    expect(own).toBeGreaterThan(900);
    expect(BENCH_TRUTH.every((truth) => truth.length === 10)).toBe(true);
  });

  it('段落的简称不重复，平面上的点互不重叠', () => {
    const names = PARAGRAPHS.map((_, i) => shortName(i));
    expect(new Set(names).size).toBe(names.length);
    expect(shortName(PARAGRAPHS.findIndex((p) => p.id === 'cup#1'))).toBe('杯1');
    for (let i = 0; i < POS.length; i++) for (let j = i + 1; j < POS.length; j++) expect(Math.hypot((POS[i][0] - POS[j][0]) / 70, (POS[i][1] - POS[j][1]) / 52), `${names[i]} ${names[j]}`).toBeGreaterThanOrEqual(0.99);
  });

  it('扫描时的堆和排序取前 k 个结果相同', () => {
    for (const q of [F.q, I.q]) {
      const scores = PARAGRAPH_VECTORS.map((v) => dot(q, v));
      expect(scanTopK('ip', scores, 3).at(-1)!.heap).toEqual(topK('ip', scores, 3).map((hit) => hit.id));
    }
  });
});

describe('暴力 kNN（Flat）', () => {
  const lesson = LESSON_BY_ID.flat;

  it('入库：27 × 16 × 4 = 1,728 字节', () => {
    expect([F.N, F.DIM, F.BYTES]).toEqual([27, 16, 1728]);
    expect(lesson.steps[0].desc).toBe('27 个向量，1,728 字节');
  });

  it('27 次点积，前 3 是 cup#1 0.79、cup#2 0.64、cup#0 0.60；分数 ≥ 0.3 的 6 个', () => {
    expect(F.ip.computed).toBe(27);
    expect(ids(F.ip.hits)).toEqual(['cup#1', 'cup#2', 'cup#0']);
    expect(F.ip.hits.map((hit) => +hit.score.toFixed(2))).toEqual([0.79, 0.64, 0.6]);
    expect(factsOf(lesson, 2)['≥ 0.3']).toBe('6 个');
    expect(lesson.steps[2].detail).toContain('杯1（cup#1，讲杯盖密封圈的那段）是 0.79');
    expect(PARAGRAPHS[14].text).toContain('密封圈');
  });

  it('堆：先放 3 个，替换 6 次，丢掉 18 个；最后 3 次替换正好是三个杯子段落', () => {
    expect(F.heapSteps.filter((s) => s.action === 'push')).toHaveLength(3);
    expect(F.replaced).toHaveLength(6);
    expect(F.skipped).toHaveLength(18);
    expect(F.replaced.slice(-3).map((s) => id(s.id))).toEqual(['cup#0', 'cup#1', 'cup#2']);
    expect(F.replaced.slice(0, 3).every((s) => !id(s.id).startsWith('cup'))).toBe(true);
    expect(lesson.steps[3].desc).toBe('替换 6 次，丢掉 18 个');
  });

  it('IndexFlatL2：再 27 次，平方距离 = 2 − 2 × 点积，顺序相同', () => {
    expect(F.sameOrder).toBe(true);
    expect(F.identityGap).toBeLessThan(1e-6);
    expect(F.afterIp).toBe(27);
    expect(F.afterL2).toBe(54);
    expect(lesson.steps[4].detail).toContain('杯1 是 0.42 = 2 − 2 × 0.79，前 3 名一个不差');
  });

  it('规模：每次 1000 次，8 个问题 8000 次，召回率 1；100 万 × 1536 × 4 字节 = 5.7 GiB', () => {
    expect(F.afterBench).toBe(54 + 8000);
    expect(F.benchRecall).toBe(1);
    expect(F.BIG_BYTES).toBe(6_144_000_000);
    expect(lesson.steps[5].detail).toContain('5.7 GiB');
    expect(dists(lesson)).toEqual([0, 0, 0, 0, 27, 27, 27, 27, 27, 27, 27, 54, 54, 8054]);
    expect(lesson.distNote).toContain('一共 8,054 次');
  });
});

describe('IVF', () => {
  const lesson = LESSON_BY_ID.ivf;

  it('k-means：4 轮，每轮 27 × 4 次；换簇 27 → 2 → 1 → 0；没有空簇', () => {
    expect(I.iterations.map((it) => it.moved)).toEqual([27, 2, 1, 0]);
    expect(I.trainDist).toBe(432);
    expect(I.buildDist).toBe(108);
    expect(I.emptySeen).toBe(false);
    expect(I.index.train.init.map(id)).toEqual(['aftersale#0', 'aftersale#2', 'contact#0', 'warranty#0']);
    expect(lesson.steps[0].detail).toContain('这次训练没有出现空簇');
  });

  it('倒排表 6、8、5、8 个；cup#1 和《售后规则》的 4 段同在 C1，别的杯子段落在 C3', () => {
    expect(I.index.lists.map((list) => list.length)).toEqual([6, 8, 5, 8]);
    const c1 = I.index.lists[1].map(id);
    expect(c1).toContain('cup#1');
    expect(c1.filter((x) => x.startsWith('aftersale#'))).toHaveLength(4);
    expect(I.index.lists[3].map(id)).toEqual(expect.arrayContaining(['cup#0', 'cup#2', 'cup#3']));
    expect(lesson.steps[1].detail).toContain('和《售后规则》的 4 段一起进了 C1');
  });

  it('nprobe = 1：4 + 8 = 12 次，漏掉 Flat 的第 1 名 cup#1，召回率 67%；nprobe = 2：20 次，100%', () => {
    expect(I.probe1.probed).toEqual([3]);
    expect([I.probe1.computed.centroids, I.probe1.computed.vectors]).toEqual([4, 8]);
    expect(ids(I.probe1.hits)).toEqual(['cup#2', 'cup#0', 'warranty#0']);
    expect(I.missed.map(id)).toEqual(['cup#1']);
    expect(I.truth[0]).toBe(I.missed[0]);
    expect(I.recall1).toBeCloseTo(2 / 3, 12);
    expect(I.probe2.probed).toEqual([3, 1]);
    expect(I.probe2.computed.vectors).toBe(16);
    expect(id(I.probe2.hits[0].id)).toBe('cup#1');
    expect(I.recall2).toBe(1);
    expect(lesson.steps[2].desc).toBe('4 + 8 = 12 次，召回率 67%');
    expect(lesson.steps[3].desc).toBe('4 + 16 = 20 次，召回率 100%');
  });

  it('评估集：nprobe 1、2、4 的平均召回率 79%、96%、100%', () => {
    expect(I.evalRecall.map((r) => Math.round(r.recall * 100))).toEqual([79, 96, 100]);
    expect(lesson.steps[3].detail).toContain('平均召回率是 79%、96%、100%');
  });

  it('规模：32 簇，建索引 384,000 次；nprobe 1、2、4、8 每次 70、117、174、324 次，召回率 89%、98%、100%、100%', () => {
    expect(I.benchBuild).toBe(384_000);
    expect(I.benchEmpty).toBe(false);
    expect(BENCH_N).toBeGreaterThanOrEqual(30 * I.BENCH_NLIST);
    expect(I.benchRuns.map((r) => Math.round(r.perQuery))).toEqual([70, 117, 174, 324]);
    expect(I.benchRuns.map((r) => Math.round(r.recall * 100))).toEqual([89, 98, 100, 100]);
    expect(I.afterBench).toBe(last(lesson));
    expect(dists(lesson).slice(0, 11)).toEqual([0, 108, 216, 324, 432, 540, 540, 544, 552, 552, 572]);
  });
});

describe('HNSW', () => {
  const lesson = LESSON_BY_ID.hnsw;

  it('层数：mL = 1/ln 4；4 层，每层 27 / 5 / 3 / 1 个，入口 shipping-fee#1', () => {
    expect(H.ML).toBeCloseTo(1 / Math.log(4), 15);
    expect(H.layerSizes).toEqual([27, 5, 3, 1]);
    expect(id(H.graph.entry)).toBe('shipping-fee#1');
    expect(H.levels[H.graph.entry]).toBe(3);
  });

  it('逐个插入和 buildHnsw 的结果一样，建图 532 次', () => {
    const meter = new DistanceMeter();
    const built = buildHnsw(PARAGRAPH_VECTORS, { M: 4, efConstruction: 8, seed: 1 }, meter);
    expect(meter.total).toBe(H.afterBuild);
    expect(H.afterBuild).toBe(532);
    expect(built.neighbors.map((layer) => [...layer.entries()])).toEqual(H.graph.neighbors.map((layer) => [...layer.entries()]));
    expect(H.layerEdges.map((e) => e.length)).toEqual([66, 5, 2, 0]);
  });

  it('细看 warranty#0 的插入：第 1 层，30 次；第 0 层 8 个候选只连 2 个（kettle#0、aftersale#2）', () => {
    expect(id(H.FOCUS)).toBe('warranty#0');
    expect(H.focus.level).toBe(1);
    expect(H.focus.distances).toBe(30);
    expect(H.beforeFocus).toBe(290);
    const f0 = H.focusLayers.find((x) => x.layer === 0)!;
    expect(f0.candidates).toHaveLength(8);
    expect(f0.chosen.map(id)).toEqual(['kettle#0', 'aftersale#2']);
    expect(f0.skipped).toHaveLength(6);
    // 启发式：每个被跳过的候选，都离某个已选邻居比离新节点更近。
    const v = PARAGRAPH_VECTORS;
    for (const c of f0.skipped) expect(f0.chosen.some((r) => l2sq(v[c], v[r]) < l2sq(v[c], v[H.FOCUS])), id(c)).toBe(true);
    expect(lesson.steps[1].detail).toContain('第 0 层的 8 个候选里只挑了 2 个邻居（壶0、售2）');
  });

  it('查询 ef = 3：每层新算 1、1、2、13 个，共 17 次，漏掉 cup#1；ef = 8：25 次，100%', () => {
    expect(H.smallPerLayer).toEqual([1, 1, 2, 13]);
    expect(H.small.computed).toBe(17);
    expect(ids(H.small.hits)).toEqual(['cup#2', 'cup#0', 'warranty#0']);
    expect(H.missed.map(id)).toEqual(['cup#1']);
    expect(H.recallSmall).toBeCloseTo(2 / 3, 12);
    expect(H.large.computed).toBe(25);
    expect(H.recallLarge).toBe(1);
    expect(id(H.large.hits[0].id)).toBe('cup#1');
    expect(lesson.steps[2].desc).toBe('ef = 3，17 次，漏掉 杯1');
  });

  it('评估集：ef 3、8、16 的召回率 92%、96%、100%，每次 16.8、23.9、27 次', () => {
    expect(H.evalRuns.map((r) => Math.round(r.recall * 100))).toEqual([92, 96, 100]);
    expect(H.evalRuns.map((r) => +r.perQuery.toFixed(1))).toEqual([16.8, 23.9, 27]);
  });

  it('规模：M 16、efC 40 建图 243,088 次；ef 10、16、40 每次 82、104、167 次，召回率都是 100%；每个向量 192 字节', () => {
    expect(H.benchBuild).toBe(243_088);
    expect(H.benchRuns.map((r) => Math.round(r.perQuery))).toEqual([82, 104, 167]);
    expect(H.benchRuns.every((r) => r.recall === 1)).toBe(true);
    expect(H.benchBytesPerVector).toBe(192);
    expect(lesson.steps[4].detail).toContain('是 Flat 的 3 倍');
    expect(H.afterBench).toBe(last(lesson));
  });
});

describe('乘积量化 PQ', () => {
  const lesson = LESSON_BY_ID.pq;

  it('码本：4 段 × 8 个子质心 × 4 维，512 字节；训练记 1,242 次，没有空簇', () => {
    expect(P.bytes).toEqual({ raw: 64, code: 4, codebook: 512 });
    expect(P.afterTrain).toBe(1242);
    expect(P.emptySeen).toBe(false);
    expect(P.cb.train.map((r) => r.iterations.length)).toEqual([5, 7, 5, 6]);
  });

  it('编码：cup#1 → [2, 3, 6, 6]，每个记 8 次；FAISS 按位存是 2 字节；27 个只有 23 种码', () => {
    expect(P.showCode).toEqual([2, 3, 6, 6]);
    expect(P.showCode).toEqual(pqEncode(P.cb, PARAGRAPH_VECTORS[P.SHOW]));
    expect(P.afterEncode - P.afterTrain).toBe(27 * 8);
    expect(P.packed).toBe(Math.ceil((4 * 3) / 8));
    expect(P.distinctCodes).toBe(23);
    expect(+P.showError.toFixed(3)).toBe(0.167);
    expect(P.showError).toBeCloseTo(l2sq(PARAGRAPH_VECTORS[P.SHOW], pqDecode(P.cb, P.showCode)), 12);
  });

  it('ADC：表 8 次 + 查表 27 次；cup#1 的近似距离就是 4 个表项之和', () => {
    expect(P.afterSearch - P.afterEncode).toBe(35);
    const sum = P.showCode.reduce((s, c, j) => s + P.search.table[j][c], 0);
    expect(P.search.distances[P.SHOW]).toBe(sum);
    expect(lesson.steps[3].detail).toContain('cup#1 的近似距离是 0.13 + 0.04 + 0.06 + 0.07 = 0.30');
  });

  it('量化误差：cup#0（真实 0.807）被 warranty#0（真实 1.110）挤掉，近似距离只差 0.001', () => {
    expect(ids(P.search.hits)).toEqual(['cup#1', 'cup#2', 'warranty#0']);
    expect(P.pushedOut.map(id)).toEqual(['cup#0']);
    expect(P.pushedIn.map(id)).toEqual(['warranty#0']);
    expect(P.trueDist[P.pushedOut[0]]).toBeLessThan(P.trueDist[P.pushedIn[0]]);
    expect(P.search.distances[P.pushedOut[0]]).toBeGreaterThan(P.search.distances[P.pushedIn[0]]);
    expect(+Math.abs(P.search.distances[P.pushedOut[0]] - P.search.distances[P.pushedIn[0]]).toFixed(3)).toBe(0.001);
    expect(lesson.steps[4].detail).toContain('cup#0 真实是 0.807，近似成 1.055；warranty#0 真实是 1.110，近似成 1.054');
    expect(Math.round(P.evalSmall.recall * 100)).toBe(75);
    expect(Math.round(P.evalLarge.recall * 100)).toBe(88);
  });

  it('规模：M 8、ksub 256；码 8,000 字节、码本 16,384 字节；每次 1256 次，比 Flat 多；召回率 94%', () => {
    expect(P.BENCH_CODES).toBe(8000);
    expect(P.benchBytes.codebook).toBe(16384);
    expect(P.benchPerQuery).toBe(256 + 1000);
    expect(P.benchPerQuery).toBeGreaterThan(BENCH_N);
    expect(Math.round(P.benchRecall * 100)).toBe(94);
    expect(P.afterBench).toBe(last(lesson));
  });
});

describe('元数据过滤与混合检索', () => {
  const lesson = LESSON_BY_ID.hybrid;
  const current = PARAGRAPHS.flatMap((p, i) => (p.meta.status === 'current' ? [i] : []));

  it('后过滤：前 3 里的 refund-2025#0（archived）被扔掉，只剩 2 个；它和 refund#0 只差到账天数', () => {
    expect(ids(Y.post.beforeFilter)).toEqual(['refund#0', 'refund-2025#0', 'refund#1']);
    expect(ids(Y.post.hits)).toEqual(['refund#0', 'refund#1']);
    expect(Y.post.computed).toBe(27);
    expect(Y.dropped.map(id)).toEqual(['refund-2025#0']);
    expect(Y.post.beforeFilter.map((hit) => +hit.score.toFixed(3))).toEqual([0.975, 0.974, 0.2]);
    const strip = (t: string) => t.replace(/（2025 版）/, '').replace(/[0-9–]/g, '');
    expect(strip(PARAGRAPHS[Y.dropped[0]].text)).toBe(strip(PARAGRAPHS.find((p) => p.id === 'refund#0')!.text));
  });

  it('前过滤：26 个候选、26 次，拿满 3 个', () => {
    expect(Y.pre.allowed).toEqual(current);
    expect(Y.pre.computed).toBe(26);
    expect(ids(Y.pre.hits)).toEqual(['refund#0', 'refund#1', 'aftersale#2']);
  });

  it('BM25 赢：只有 cup#2 含「sr」「35」，BM25 第 1；向量第 1 是 cup#0（BW-350 商品页），cup#2 第 2', () => {
    const withCode = PARAGRAPHS.filter((p) => termsOf(p.text).includes('sr') && termsOf(p.text).includes('35'));
    expect(withCode.map((p) => p.id)).toEqual(['cup#2']);
    expect(PARAGRAPHS.find((p) => p.id === 'cup#0')!.text).toContain('BW-350');
    expect(Y.code.keyword.ranked[0].id).toBe('cup#2');
    expect(Y.code.vectorRanked.slice(0, 2).map((d) => d.id)).toEqual(['cup#0', 'cup#2']);
    expect(+Y.code.keyword.ranked[0].score.toFixed(2)).toBe(5.77);
  });

  it('向量赢：BM25 只命中「退回」，3 个段落里最短的 points#1 分最高；查询向量就是「退回」的方向，第 1 是 refund#0', () => {
    const hits = Y.syn.keyword.scored.filter((d) => d.score > 0);
    expect(hits.map((d) => d.id).sort()).toEqual(['points#1', 'refund#0', 'refund#2']);
    for (const d of hits) expect(d.hits.map((h) => h.term)).toEqual(['退回']);
    const shortest = hits.reduce((a, b) => (a.length < b.length ? a : b));
    expect(shortest.id).toBe('points#1');
    expect(Y.syn.keyword.ranked.map((d) => d.id).slice(0, 2)).toEqual(['points#1', 'refund#0']);
    expect(Y.syn.embed.known.map((h) => h.term)).toEqual(['退回']);
    expect(Y.syn.vectorRanked[0].id).toBe('refund#0');
  });

  it('RRF k = 60：cup#2 第 1，cup#0 掉到第 3；points#1 和 refund#0 是 1+2 对 2+1，分数完全相同；Qdrant 写法前 3 名不变', () => {
    expect(Y.code.fused.slice(0, 3).map((d) => d.id)).toEqual(['cup#2', 'warranty#0', 'cup#0']);
    expect(Y.code.fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 15);
    expect(Y.syn.fused.slice(0, 2).map((d) => d.ranks)).toEqual([[1, 2], [2, 1]]);
    expect(Y.syn.fused[0].score).toBe(Y.syn.fused[1].score);
    expect(Y.qdrantSame).toBe(true);
    // Qdrant：k = 2、名次从 0 起，1/(2 + r0) = 1/(1 + r1)。
    expect(rrf([[{ id: 'a', rank: 1, score: 0 }]], 1)[0].score).toBe(1 / 2);
    expect(lesson.steps[4].detail).toContain('分数完全相同（0.0325）');
  });

  it('距离：27 + 26 + 26 + 26 = 105，BM25 和 RRF 不加', () => {
    expect(dists(lesson)).toEqual([0, 27, 27, 27, 27, 53, 53, 53, 79, 79, 79, 105, 105, 105, 105]);
    expect(Y.afterAll).toBe(105);
    // BM25 直接在 26 个现行段落上算，和全库的 BM25 不同（N 和 avgdl 变了）。
    const all = bm25Search(PARAGRAPHS.map((p) => ({ id: p.id, text: p.text })), Y.Q_CODE, 3).ranked;
    expect(all[0].id).toBe('cup#2');
    expect(flatSearch(PARAGRAPH_VECTORS, Y.code.embed.vector, 1, 'ip', undefined, current).hits.map((hit) => id(hit.id))).toEqual(['cup#0']);
  });
});
