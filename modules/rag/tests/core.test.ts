/**
 * 计算核心：期望值尽量手算或用独立的实现（Float32Array、DataView、Buffer、JSON.stringify、TextEncoder）核对。
 */
import { describe, expect, it } from 'vitest';
import { bm25 } from '@explorer/llm-core/bm25';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import {
  adcDistance,
  adcTable,
  answerFacts,
  base64Decode,
  base64Encode,
  bm25Search,
  buildHnsw,
  buildIvf,
  buildPrompt,
  checkCitations,
  contextPrecision,
  contextRecall,
  cosine,
  crossScore,
  dequantizeInt8,
  docText,
  dot,
  drawLevels,
  edgesOf,
  EMBED_DIM,
  EMBEDDER,
  embed,
  embeddingsHttpRequest,
  embeddingsHttpResponse,
  embeddingsResponse,
  embedVector,
  EVAL_SET,
  exactTopK,
  f16RoundTrip,
  f16VectorBytes,
  f32FromVectorBytes,
  f32Json,
  f32VectorBytes,
  factsOf,
  faithfulness,
  filteredSearch,
  fixedChunks,
  flatSearch,
  hnswSearch,
  int8Bytes,
  ivfSearch,
  jacobiEigen,
  KB,
  kmeans,
  l2sq,
  meanRecall,
  DistanceMeter,
  normalize,
  norm,
  paragraphById,
  PARAGRAPH_VECTORS,
  PARAGRAPHS,
  pqBytes,
  pqDecode,
  pqEncode,
  pqSearch,
  quantizeInt8,
  rankedOf,
  recallAtK,
  recursiveChunks,
  relation,
  rerank,
  retrievalRecall,
  rrf,
  RRF_K,
  searchResultBlocks,
  sentences,
  splitAnswer,
  supports,
  termsOf,
  trainEmbedder,
  trainPq,
  type Vec,
} from '../src/core';

const V = PARAGRAPH_VECTORS as Vec[];
const enc = (text: string) => new TextEncoder().encode(text).length;

describe('向量运算', () => {
  it('点积、余弦、平方欧氏距离（手算）', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(l2sq([1, 2], [4, 6])).toBe(25);
    expect(cosine([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12);
    expect(norm(normalize([3, 4]))).toBeCloseTo(1, 6);
    expect(normalize([3, 4])).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(() => dot([1], [1, 2])).toThrow();
  });

  it('归一化之后 ‖a − b‖² = 2 − 2·a·b，点积就是余弦，三种度量的排序完全一致', () => {
    const r = relation(V[0], V[1]);
    expect(r.unit).toBe(true);
    expect(r.l2sq).toBeCloseTo(2 - 2 * r.dot, 6);
    expect(r.cosine).toBeCloseTo(r.dot, 6);
    for (const item of EVAL_SET) {
      const q = embedVector(item.question);
      const ip = flatSearch(V, q, V.length, 'ip').hits.map((hit) => hit.id);
      const cos = flatSearch(V, q, V.length, 'cosine').hits.map((hit) => hit.id);
      const l2 = flatSearch(V, q, V.length, 'l2').hits.map((hit) => hit.id);
      expect(cos).toEqual(ip);
      expect(l2).toEqual(ip);
    }
  });

  it('float32 / float16 小端字节和 Float32Array、DataView 一致', () => {
    const v = [0.1, -1.5, 3.25, 1e-3];
    const expected = [...new Uint8Array(new Float32Array(v).buffer)];
    expect(f32VectorBytes(v)).toEqual(expected);
    expect(f32FromVectorBytes(expected)).toEqual(v.map(Math.fround));
    const half = f16VectorBytes([1, -2, 0.5]);
    expect(half).toEqual([0x00, 0x3c, 0x00, 0xc0, 0x00, 0x38]);
    expect(f16RoundTrip([0.1])[0]).toBeCloseTo(0.0999755859375, 12);
  });

  it('base64 和 Node 的 Buffer 一致，能解回原来的字节；JSON 里的 fp32 写成最短的十进制', () => {
    for (const bytes of [[], [0], [1, 2], [1, 2, 3], f32VectorBytes(V[0])]) {
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
    expect(f32Json(Math.fround(0.1))).toBe(0.1);
    for (const x of V[0]) {
      expect(Math.fround(f32Json(x))).toBe(x);
      expect(String(f32Json(x)).replace(/^-?0\./, '').replace(/e.*$/, '').length).toBeLessThanOrEqual(10);
    }
  });

  it('int8 量化：缩放系数 = 最大绝对值 / 127，误差不超过半个刻度', () => {
    const v = V[3];
    const q = quantizeInt8(v);
    expect(q.scale).toBe(Math.fround(Math.max(...v.map(Math.abs)) / 127));
    expect(Math.max(...q.codes.map(Math.abs))).toBe(127);
    dequantizeInt8(q).forEach((x, i) => expect(Math.abs(x - v[i])).toBeLessThanOrEqual(q.scale / 2 + 1e-7));
    expect(int8Bytes({ codes: [-1, 127, -127], scale: 1 })).toEqual([0xff, 0x7f, 0x81]);
  });
});

describe('Jacobi 特征分解', () => {
  it('[[2, 1], [1, 2]] 的特征值是 3 和 1，特征向量单位长度、符号固定', () => {
    const e = jacobiEigen([[2, 1], [1, 2]]);
    expect(e.values[0]).toBeCloseTo(3, 12);
    expect(e.values[1]).toBeCloseTo(1, 12);
    expect(e.vectors[0][0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(e.vectors[0][1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('S·v = λ·v（对称矩阵）', () => {
    const S = [[4, 1, 2], [1, 3, 0], [2, 0, 5]];
    const e = jacobiEigen(S);
    e.vectors.forEach((v, k) => S.forEach((row, i) => expect(dot(row, v)).toBeCloseTo(e.values[k] * v[i], 10)));
  });
});

describe('嵌入模型（16 维 LSA）', () => {
  it('在全部段落上训练：段落数、词表、维度、奇异值从大到小，结果确定', () => {
    expect(EMBEDDER.docs).toBe(PARAGRAPHS.length);
    expect(EMBEDDER.docs).toBe(27);
    expect(EMBEDDER.dim).toBe(EMBED_DIM);
    expect(EMBEDDER.vocab).toHaveLength(480);
    for (let k = 1; k < EMBEDDER.sigma.length; k++) expect(EMBEDDER.sigma[k]).toBeLessThanOrEqual(EMBEDDER.sigma[k - 1]);
    const again = trainEmbedder(PARAGRAPHS.map((item) => item.text));
    expect([...again.table.get('漏水')!]).toEqual([...EMBEDDER.table.get('漏水')!]);
  });

  it('切词和 BM25 相同，权重 (1 + ln tf) · ln(N / df)，词表外的词丢掉', () => {
    const t = embed('保温杯漏水了怎么办？');
    expect(t.terms).toEqual(termsOf('保温杯漏水了怎么办？'));
    expect(t.known.map((hit) => hit.term)).toEqual(['保温', '温杯', '漏水']);
    expect(t.unknown).toEqual(['杯漏', '水了', '了怎', '怎么', '么办']);
    const leak = t.known.find((hit) => hit.term === '漏水')!;
    expect(EMBEDDER.df.get('漏水')).toBe(1);
    expect(leak.weight).toBeCloseTo(Math.log(27), 12);
  });

  it('池化是按权重的加权平均，归一化后长度为 1（fp32）', () => {
    const t = embed('退款多久能到账？');
    const total = t.known.reduce((sum, hit) => sum + hit.weight, 0);
    t.pooled.forEach((x, k) => expect(x).toBe(Math.fround(t.known.reduce((sum, hit) => sum + hit.weight * hit.vector[k], 0) / total)));
    expect(norm(t.vector)).toBeCloseTo(1, 6);
    t.vector.forEach((x) => expect(Math.fround(x)).toBe(x));
  });

  it('段落自己的嵌入就是 LSA 的文档向量方向：和它在 U 上的投影 Uᵀa 同向', () => {
    // 同一段的两个词只出现在这一段里时，它们的词向量方向完全相同（都等于 v_d / σ 乘一个系数）。
    const a = EMBEDDER.table.get('漏水')!;
    const b = EMBEDDER.table.get('渗水')!;
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it('同义的问法近、无关的远（锁住本站的数）', () => {
    const c = (x: string, y: string) => dot(embedVector(x), embedVector(y));
    expect(c('保温杯漏水了怎么办？', '杯盖渗水该怎么处理？')).toBeCloseTo(0.652, 3);
    expect(c('退款多久能到账？', '钱什么时候退回来？')).toBeCloseTo(0.714, 3);
    expect(c('保温杯漏水了怎么办？', '怎么开发票？')).toBeLessThan(0.05);
    expect(c('退款多久能到账？', '怎么开发票？')).toBeLessThan(0.05);
    // 同义的两对都明显高于任何一对无关的。
    expect(Math.min(c('保温杯漏水了怎么办？', '杯盖渗水该怎么处理？'), c('退款多久能到账？', '钱什么时候退回来？'))).toBeGreaterThan(0.6);
  });

  it('一个词都不认识时是零向量', () => {
    const t = embed('今天天气不错');
    expect(t.known).toEqual([]);
    expect(t.vector.every((x) => x === 0)).toBe(true);
  });

  it('评估问题用暴力检索，前 3 个里找到 11 / 12 个标注的相关段落', () => {
    const found = EVAL_SET.reduce((sum, item) => sum + retrievalRecall(exactTopK(V, embedVector(item.question), 3).map((i) => PARAGRAPHS[i].id), item.relevant).found.length, 0);
    expect(EVAL_SET.reduce((sum, item) => sum + item.relevant.length, 0)).toBe(12);
    expect(found).toBe(11);
  });
});

describe('切分', () => {
  const text = docText(KB[0]);
  const chars = [...text];

  it('固定长度：步长 size − overlap，最后一块到结尾，字节区间和 UTF-8 一致', () => {
    const chunks = fixedChunks(text, 50, 10);
    expect(chunks.map((c) => [c.from, c.to])).toEqual([[0, 50], [40, 90], [80, 130], [120, 170], [160, chars.length]]);
    expect(chunks.slice(1).every((c) => c.overlap === 10)).toBe(true);
    for (const c of chunks) {
      expect(c.byteFrom).toBe(enc(chars.slice(0, c.from).join('')));
      expect(c.byteTo - c.byteFrom).toBe(enc(c.text));
      expect(c.tokens).toBe(TOKENIZER.encode(c.text).length);
    }
    expect(() => fixedChunks(text, 10, 10)).toThrow();
  });

  it('句子：句末标点留在句子里，空白去掉', () => {
    const list = sentences('第一句。第二句！\n第三句');
    expect(list.map((s) => s.text)).toEqual(['第一句。', '第二句！', '第三句']);
  });

  it('递归切分：每块不超过 size，按顺序覆盖原文，重叠不超过 overlap', () => {
    for (const doc of KB) {
      const t = docText(doc);
      for (const [size, overlap] of [[40, 0], [40, 15], [80, 20]]) {
        const chunks = recursiveChunks(t, { size, overlap });
        let covered = 0;
        for (const c of chunks) {
          expect(c.to - c.from).toBeLessThanOrEqual(size);
          expect(c.overlap).toBeLessThanOrEqual(overlap);
          expect(c.from).toBeLessThanOrEqual(covered + 1);
          covered = Math.max(covered, c.to);
          expect(c.text).toBe([...t].slice(c.from, c.to).join(''));
        }
        expect(covered).toBe([...t].length);
      }
    }
  });

  it('递归切分先按段落切：段落都不超长时，一段一块', () => {
    const chunks = recursiveChunks(text, { size: 60 });
    expect(chunks.map((c) => c.text)).toEqual(KB[0].paragraphs);
  });

  it('递归切分在句号处断开长段落，并带上上一句作为重叠', () => {
    const t = '甲甲甲甲。乙乙乙乙。丙丙丙丙。丁丁丁丁。';
    const chunks = recursiveChunks(t, { size: 10, overlap: 5 });
    expect(chunks.map((c) => c.text)).toEqual(['甲甲甲甲。乙乙乙乙。', '乙乙乙乙。丙丙丙丙。', '丙丙丙丙。丁丁丁丁。']);
    expect(chunks.map((c) => c.overlap)).toEqual([0, 5, 5]);
  });
});

describe('暴力 kNN、k-means、IVF', () => {
  const q = embedVector('保温杯漏水了怎么办？');

  it('暴力搜索算 N 次距离，前 k 个按分数排好', () => {
    const meter = new DistanceMeter();
    const r = flatSearch(V, q, 3, 'ip', meter);
    expect(r.computed).toBe(V.length);
    expect(meter.total).toBe(V.length);
    expect(r.hits.map((hit) => PARAGRAPHS[hit.id].id)).toEqual(['cup#1', 'cup#2', 'cup#0']);
    expect(r.hits[0].score).toBeGreaterThanOrEqual(r.hits[1].score);
  });

  it('k-means：固定种子结果相同，每轮误差不增加，最后的分配是最近的质心', () => {
    const a = kmeans(V, 4, { seed: 3 });
    const b = kmeans(V, 4, { seed: 3 });
    expect(a.assign).toEqual(b.assign);
    for (let i = 1; i < a.iterations.length; i++) expect(a.iterations[i].inertia).toBeLessThanOrEqual(a.iterations[i - 1].inertia + 1e-9);
    expect(a.sizes.reduce((s, n) => s + n, 0)).toBe(V.length);
    expect(new Set(a.init).size).toBe(4);
  });

  it('IVF：倒排表把向量分完，nprobe = nlist 时等于暴力搜索；距离 = 质心 + 被扫的向量', () => {
    const meter = new DistanceMeter();
    const index = buildIvf(V, 4, { seed: 1, meter });
    expect(index.lists.flat().sort((x, y) => x - y)).toEqual(V.map((_, i) => i));
    const all = ivfSearch(index, V, q, 3, 4);
    expect(all.hits.map((hit) => hit.id)).toEqual(exactTopK(V, q, 3, 'l2'));
    const m2 = new DistanceMeter();
    const one = ivfSearch(index, V, q, 3, 1, m2);
    expect(one.computed.centroids).toBe(4);
    expect(m2.total).toBe(4 + one.scanned.length);
    expect(one.scanned).toEqual(index.lists[one.probed[0]]);
  });
});

describe('HNSW', () => {
  const M = 3;
  const graph = buildHnsw(V, { M, efConstruction: 8, seed: 1 });

  it('层数 ⌊−ln(U) · mL⌋，mL = 1/ln(M)，同一个种子结果相同', () => {
    expect(graph.mL).toBeCloseTo(1 / Math.log(M), 12);
    expect(graph.levels).toEqual(drawLevels(V.length, 1 / Math.log(M), 1));
    expect(graph.maxLevel).toBe(Math.max(...graph.levels));
    expect(graph.levels[graph.entry]).toBe(graph.maxLevel);
  });

  it('度数上限：第 0 层 2M，其余层 M；边都在两端节点都有的层上', () => {
    graph.neighbors.forEach((layer, l) => {
      for (const [node, list] of layer) {
        expect(list.length).toBeLessThanOrEqual(l === 0 ? 2 * M : M);
        expect(graph.levels[node]).toBeGreaterThanOrEqual(l);
        for (const other of list) expect(graph.levels[other]).toBeGreaterThanOrEqual(l);
      }
    });
    expect(edgesOf(graph, 0).length).toBeGreaterThan(V.length - 1);
  });

  it('第 0 层从入口出发能走到每个节点', () => {
    const seen = new Set([graph.entry]);
    const queue = [graph.entry];
    while (queue.length) for (const next of graph.neighbors[0].get(queue.shift()!)!) if (!seen.has(next)) (seen.add(next), queue.push(next));
    expect(seen.size).toBe(V.length);
  });

  it('ef 足够大时召回率 1；距离计数和 meter 一致', () => {
    for (const item of EVAL_SET) {
      const q = embedVector(item.question);
      const meter = new DistanceMeter();
      const r = hnswSearch(graph, V, q, 3, V.length, meter);
      expect(recallAtK(r.hits.map((hit) => hit.id), exactTopK(V, q, 3), 3)).toBe(1);
      expect(meter.total).toBe(r.computed);
      expect(r.visits.map((visit) => visit.layer)).toEqual(Array.from({ length: graph.maxLevel + 1 }, (_, i) => graph.maxLevel - i));
    }
  });

  it('插入的记录：每个节点一条，距离数之和等于建图的总数', () => {
    const meter = new DistanceMeter();
    const g = buildHnsw(V, { M, efConstruction: 8, seed: 1 }, meter);
    expect(g.inserts.map((trace) => trace.node)).toEqual(V.map((_, i) => i));
    expect(g.inserts.reduce((sum, trace) => sum + trace.distances, 0)).toBe(meter.total);
    expect(g.inserts[0].newEntry).toBe(true);
  });
});

describe('PQ', () => {
  const cb = trainPq(V, 4, 8, { seed: 1 });
  const codes = V.map((v) => pqEncode(cb, v));

  it('切 4 段，每段 4 维、8 个子质心；码是 0..7 的 uint8，64 字节变 4 字节', () => {
    expect([cb.m, cb.dsub, cb.ksub]).toEqual([4, 4, 8]);
    for (const code of codes) for (const c of code) expect(c >= 0 && c < 8 && Number.isInteger(c)).toBe(true);
    expect(pqBytes(cb)).toEqual({ raw: 64, code: 4, codebook: 4 * 8 * 4 * 4 });
  });

  it('ADC 距离 = 查询到解码向量的平方距离；表计 ksub 次、每个码计 1 次', () => {
    const q = embedVector('退款多久能到账？');
    const table = adcTable(cb, q);
    codes.forEach((code) => expect(adcDistance(table, code)).toBeCloseTo(l2sq(q, pqDecode(cb, code)), 10));
    const meter = new DistanceMeter();
    const r = pqSearch(cb, codes, q, 3, meter);
    expect(meter.by['adc-table']).toBe(8);
    expect(meter.by.adc).toBe(V.length);
    expect(r.hits).toHaveLength(3);
  });

  it('近似检索的召回率可以算出来，在 0 和 1 之间', () => {
    const pairs = EVAL_SET.map((item) => {
      const q = embedVector(item.question);
      return { found: pqSearch(cb, codes, q, 3).hits.map((hit) => hit.id), truth: exactTopK(V, q, 3) };
    });
    const r = meanRecall(pairs, 3);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThanOrEqual(1);
  });
});

describe('召回率、过滤、BM25、RRF', () => {
  it('召回率@k', () => {
    expect(recallAtK([1, 2, 3], [3, 4, 1], 3)).toBeCloseTo(2 / 3, 12);
    expect(recallAtK([1, 2], [1, 2], 2)).toBe(1);
  });

  it('前过滤拿满 k 个，后过滤可能不够', () => {
    const q = embedVector('保温杯漏水了怎么办？');
    const isRefund = (id: number) => PARAGRAPHS[id].meta.category === '退款';
    const pre = filteredSearch(V, q, 3, isRefund, 'pre');
    const post = filteredSearch(V, q, 3, isRefund, 'post');
    expect(pre.hits).toHaveLength(3);
    expect(pre.hits.every((hit) => isRefund(hit.id))).toBe(true);
    expect(pre.computed).toBe(pre.allowed.length);
    expect(post.hits.length).toBeLessThan(3);
    expect(post.computed).toBe(V.length);
  });

  it('BM25 检索的分数和共享包的 bm25 一致，只留分数 > 0 的', () => {
    const docs = PARAGRAPHS.map((p) => ({ id: p.id, text: p.text }));
    const r = bm25Search(docs, '杯盖渗水该怎么处理？', 5);
    const raw = bm25(docs, '杯盖渗水该怎么处理？');
    expect(r.ranked.map((d) => d.id)).toEqual(['cup#1', 'contact#0']);
    expect(r.ranked[0].score).toBe(raw.find((d) => d.id === 'cup#1')!.score);
  });

  it('RRF：score = Σ 1/(60 + rank)，没出现的列表不加分', () => {
    expect(RRF_K).toBe(60);
    const fused = rrf([[{ id: 'a', rank: 1, score: 9 }, { id: 'b', rank: 2, score: 5 }], [{ id: 'b', rank: 1, score: 0.9 }, { id: 'c', rank: 2, score: 0.8 }]]);
    expect(fused.map((d) => d.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 15);
    expect(fused[1].ranks).toEqual([1, null]);
    expect(fused[1].score).toBeCloseTo(1 / 61, 15);
  });

  it('混合检索：编号 SR-35 关键词一下就中，向量检索把同一篇的其他段落也带上来', () => {
    const docs = PARAGRAPHS.map((p) => ({ id: p.id, text: p.text }));
    const query = '配件 SR-35 多少钱';
    const keyword = bm25Search(docs, query, 5).ranked;
    const vector = rankedOf(flatSearch(V, embedVector(query), 5).hits, (i) => PARAGRAPHS[i].id);
    expect(keyword[0].id).toBe('cup#2');
    expect(rrf([keyword, vector])[0].id).toBe('cup#2');
  });
});

describe('重排序', () => {
  it('分数 = 0.5 × 余弦 + 0.5 × idf 覆盖率，计 1 次', () => {
    const meter = new DistanceMeter();
    const s = crossScore('保温杯漏水了怎么办？', paragraphById('cup#1').text, meter);
    expect(s.score).toBeCloseTo(0.5 * s.cosine + 0.5 * s.coverage, 12);
    expect(s.matched).toEqual(['保温', '温杯', '漏水']);
    expect(meter.total).toBe(1);
  });

  it('按分数排序，记下原名次', () => {
    const r = rerank('保温杯漏水了怎么办？', PARAGRAPHS, 3);
    expect(r.map((item) => item.item.id)).toEqual(['cup#1', 'cup#2', 'cup#0']);
    expect(r[0].before).toBe(PARAGRAPHS.findIndex((p) => p.id === 'cup#1') + 1);
  });
});

describe('拼提示、核对引用', () => {
  const passages = ['cup#1', 'aftersale#1'].map(paragraphById);
  const prompt = buildPrompt('保温杯漏水了怎么办？', passages);

  it('说明、编号的资料、问题；各部分的 token 数之和等于整段', () => {
    expect(prompt.text.split('\n')).toEqual([prompt.parts[0].text, '', `[1] ${passages[0].title}${passages[0].text}`, `[2] ${passages[1].text}`, '', '问题：保温杯漏水了怎么办？']);
    expect(prompt.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(prompt.tokens);
    expect(prompt.tokens).toBe(TOKENIZER.encode(prompt.text).length);
    expect(prompt.parts.at(-1)!.to).toBe([...prompt.text].length);
  });

  it('关键事实：数字连单位、编号', () => {
    expect(factsOf('支付宝 1–3 个工作日到账，配件 SR-35 售价 9 元。')).toEqual(['1–3 个工作日', 'SR-35', '9 元']);
  });

  it('句子和标记：句末标点后面的 [n] 归前一句', () => {
    expect(splitAnswer('先装好密封圈。[1] 不行就换货[2]。').map((s) => [s.text, s.cites])).toEqual([['先装好密封圈。', [1]], ['不行就换货。', [2]]]);
  });

  it('引用核对：对得上、事实不符、没标、编号越界', () => {
    const answer = '先取下杯盖的密封圈重新装好再试 [1]。签收后 15 天内出现质量问题可以换货，来回运费由店铺承担 [2]。签收后 30 天内可以换货 [2]。别担心。也可以看看 [3]。';
    const r = checkCitations(answer, prompt.sources);
    expect(r.sentences.map((s) => s.status)).toEqual(['supported', 'supported', 'unsupported', 'uncited', 'bad-source']);
    expect(r.sentences[2].support!.missing).toEqual(['30 天']);
    expect(supports('退款原路退回', [])).toMatchObject({ supported: false });
  });

  it('search_result 块：type、source、title、content、citations', () => {
    expect(searchResultBlocks(passages)[0]).toEqual({ type: 'search_result', source: 'kb://cup#1', title: passages[0].title, content: [{ type: 'text', text: passages[0].text }], citations: { enabled: true } });
  });
});

describe('评估', () => {
  it('context precision@K：相关的位置越靠前越高（手算）', () => {
    expect(contextPrecision(['a', 'x', 'b'], ['a', 'b']).score).toBeCloseTo((1 + 2 / 3) / 2, 12);
    expect(contextPrecision(['x', 'a', 'b'], ['a', 'b']).score).toBeCloseTo((1 / 2 + 2 / 3) / 2, 12);
    expect(contextPrecision(['x'], ['a']).score).toBe(0);
  });

  it('context recall（关键事实）、检索召回（段落）', () => {
    expect(contextRecall(['1–3 个工作日', '3–7 个工作日'], [paragraphById('refund#0').text]).score).toBe(1);
    expect(contextRecall(['1–3个工作日', '30 天'], [paragraphById('refund#0').text])).toMatchObject({ score: 0.5, missed: ['30 天'] });
    expect(retrievalRecall(['a', 'c'], ['a', 'b'])).toMatchObject({ score: 0.5, missed: ['b'] });
  });

  it('faithfulness：能从上下文推出的句子比例', () => {
    const ctx = [paragraphById('refund#0').text];
    const f = faithfulness('退款原路退回，支付宝 1–3 个工作日到账。银行卡 1 个工作日到账。', ctx);
    expect(f.statements).toHaveLength(2);
    expect(f.score).toBe(0.5);
    expect(answerFacts('支付宝 1–3 个工作日', ['1–3 个工作日', '3–7 个工作日']).score).toBe(0.5);
  });
});

describe('嵌入 API 的报文', () => {
  const body = { input: '你好', model: 'text-embedding-3-small', dimensions: 16, encoding_format: 'base64' as const };

  it('请求体和 JSON.stringify 一致，content-length 是请求体字节数，Bearer 鉴权', () => {
    const { json, layout } = embeddingsHttpRequest(body);
    expect(json.text).toBe(JSON.stringify(body));
    const head = new TextDecoder().decode(new Uint8Array(layout.bytes.slice(0, layout.body[0])));
    expect(head.startsWith('POST /v1/embeddings HTTP/1.1\r\nhost: api.openai.com\r\ncontent-type: application/json\r\nauthorization: Bearer sk-proj-')).toBe(true);
    expect(head).toContain(`content-length: ${json.bytes.length}\r\n`);
  });

  it('响应：object list、data[{object, index, embedding}]、model、usage；base64 解回原来的 float32', () => {
    const v = embedVector('你好呀') as Vec;
    const vectors = [PARAGRAPH_VECTORS[0] as Vec, v];
    const resp = embeddingsResponse(vectors, { ...body, input: ['甲', '乙'] });
    expect(Object.keys(resp)).toEqual(['object', 'data', 'model', 'usage']);
    expect(Object.keys(resp.data[0])).toEqual(['object', 'index', 'embedding']);
    expect(f32FromVectorBytes(base64Decode(resp.data[0].embedding as string))).toEqual(vectors[0]);
    expect(resp.usage.total_tokens).toBe(resp.usage.prompt_tokens);
    const float = embeddingsResponse([PARAGRAPH_VECTORS[0] as Vec], { ...body, encoding_format: 'float' });
    expect((float.data[0].embedding as number[]).map(Math.fround)).toEqual(PARAGRAPH_VECTORS[0]);
    const http = embeddingsHttpResponse(float, 'req_x');
    expect(new TextDecoder().decode(new Uint8Array(http.layout.bytes.slice(0, 17)))).toBe('HTTP/1.1 200 OK\r\n');
  });
});
