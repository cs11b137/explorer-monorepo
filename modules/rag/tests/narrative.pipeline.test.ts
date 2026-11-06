/**
 * 文案和计算结果对得上（RAG 流水线组的前三课：ingest、qa、rerank）。
 * 关键的数写死在这里，改了输入会立刻报错；文字里的说法（「都出自」「排在第 5」「从第 3 掉到第 5」「第三句没出处」）逐条用计算核对。
 * 也顺带核对这几课新加的 core 函数（core/ingest.ts、core/api.ts 的 Messages API 部分），以及 decode/structures.ts 的 vectorRows。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { decode } from '../src/decode/writer';
import { vectorRows } from '../src/decode/structures';
import {
  buildHnsw,
  countTokens,
  crossScore,
  DistanceMeter,
  docText,
  dot,
  EMBEDDER,
  f32VectorBytes,
  KB,
  loadSource,
  PARAGRAPH_VECTORS,
  PARAGRAPHS,
  sourceFile,
  supports,
  termsOf,
} from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf } from '../src/lessons/types';
import * as I from '../src/lessons/ingest';
import * as Q from '../src/lessons/qa';
import * as R from '../src/lessons/rerank';

const enc = (text: string) => new TextEncoder().encode(text).length;
const factsOf = (lesson: string, step: number) => Object.fromEntries(LESSON_BY_ID[lesson].steps[step].facts);
const stepOf = (lesson: string, step: number) => LESSON_BY_ID[lesson].steps[step];

describe('core：原始文件、加载清洗、每块一条记录', () => {
  it('loadSource(sourceFile(doc)) 还原每篇文档；正文就是 docText', () => {
    for (const doc of KB) {
      const loaded = loadSource(sourceFile(doc));
      expect(loaded.doc).toEqual(doc);
      expect(loaded.body).toBe(docText(doc));
      expect(loaded.heading).toBe(`# ${doc.title}`);
    }
  });

  it('块和记录的顺序、id、正文和 PARAGRAPHS 一一对应；字符区间切回原文就是块的正文', () => {
    expect(I.CHUNKS.map((chunk) => chunk.id)).toEqual(PARAGRAPHS.map((p) => p.id));
    expect(I.RECORDS.map((record) => record.text)).toEqual(PARAGRAPHS.map((p) => p.text));
    for (const record of I.RECORDS) {
      const body = docText(KB.find((doc) => doc.id === record.doc)!);
      expect([...body].slice(record.from, record.to).join('')).toBe(record.text);
      expect(record.status).toBe(PARAGRAPHS.find((p) => p.id === record.id)!.meta.status);
    }
    expect(I.VECTORS).toEqual(PARAGRAPH_VECTORS);
  });

  it('vectorRows：每个向量一个字段，字节就是 float32 小端', () => {
    const layer = vectorRows('v', ['a', 'b'], [PARAGRAPH_VECTORS[0], PARAGRAPH_VECTORS[1]]);
    const frame = decode({ at: 'x', view: 'mem', fidelity: 'internal', layers: [layer] });
    expect(frame.bytes.length).toBe(128);
    expect(layer.bytes.slice(0, 64)).toEqual(f32VectorBytes(PARAGRAPH_VECTORS[0]));
    expect(layer.bytes.slice(64)).toEqual(f32VectorBytes(PARAGRAPH_VECTORS[1]));
  });

  it('Messages API 请求：头是 host、content-type、anthropic-version、x-api-key、content-length，请求体就是 JSON.stringify', () => {
    expect(Q.http.json.text).toBe(JSON.stringify(Q.REQUEST));
    const head = new TextDecoder().decode(new Uint8Array(Q.http.layout.bytes.slice(0, Q.http.layout.body[0])));
    expect(head).toBe(`POST /v1/messages HTTP/1.1\r\nhost: api.anthropic.com\r\ncontent-type: application/json\r\nanthropic-version: 2026-10-21\r\nx-api-key: sk-ant-api03-${'x'.repeat(95)}\r\ncontent-length: ${Q.numbers.requestBody}\r\n\r\n`);
    expect(Object.keys(JSON.parse(Q.httpResponse.json.text))).toEqual(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']);
  });
});

describe('索引流水线', () => {
  const N = I.numbers;

  it('原始文件：12 个 4,382 字节；《售后规则》645 字节，front matter 84 个字符；清洗后 2,783 字节', () => {
    expect([N.docs, N.rawBytes, N.bodyBytes, N.firstRaw, N.firstFront, N.firstBlank]).toEqual([12, 4382, 2783, 645, 84, 6]);
    expect(N.rawBytes).toBe(KB.reduce((sum, doc) => sum + enc(sourceFile(doc)), 0));
    expect(N.bodyBytes).toBe(KB.reduce((sum, doc) => sum + enc(docText(doc)), 0));
    expect(I.FIRST.raw.split('\n').slice(0, 7).join('\n')).toHaveLength(N.firstFront);
    expect(stepOf('ingest', 0).desc).toBe('12 个文件，共 4,382 字节');
    expect(stepOf('ingest', 0).detail).toContain('《售后规则》这个文件 645 字节，front matter 占了其中 84 个字符');
    expect(stepOf('ingest', 1).detail).toContain('12 个文件从 4,382 字节变成 2,783 字节正文');
    expect(factsOf('ingest', 1).去掉).toBe('1,599 字节');
    // 只有一篇作废，就是 2025 版的退款说明，它的到账时间和现行版本不同。
    expect(KB.filter((doc) => doc.meta.status === 'archived').map((doc) => doc.id)).toEqual(['refund-2025']);
    expect(I.ARCHIVED.doc.paragraphs[0]).not.toBe(KB.find((doc) => doc.id === 'refund')!.paragraphs[0]);
  });

  it('切块：27 块 2,537 token，最长 aftersale#0 139 token；20 块不含标题', () => {
    expect([N.chunks, N.tokens, N.maxTokens, N.maxChunk, N.noTitle]).toEqual([27, 2537, 139, 'aftersale#0', 20]);
    expect(N.tokens).toBe(PARAGRAPHS.reduce((sum, p) => sum + countTokens(p.text), 0));
    expect(N.maxTokens).toBeLessThan(8192);
    expect(stepOf('ingest', 2).detail).toContain('最长的一块 aftersale#0 有 139 个 token');
    expect(stepOf('ingest', 2).detail).toContain('27 块里有 20 块的正文不含文档标题');
  });

  it('批量嵌入：一次请求 27 段，3,124 字节；base64 响应 3,924 字节，float 6,602 字节；usage 是本站 BPE', () => {
    expect(JSON.parse(I.http.json.text).input).toHaveLength(27);
    expect([N.requestBytes, N.requestBody, N.responseBytes, N.floatResponseBytes, N.promptTokens]).toEqual([3124, 2936, 3924, 6602, 2537]);
    expect(N.requestBody).toBe(enc(JSON.stringify(I.REQUEST)));
    expect(N.responseBytes).toBeLessThan(N.floatResponseBytes);
    const data = JSON.parse(I.httpResponse.json.text).data;
    expect(data.map((item: { index: number }) => item.index)).toEqual([...Array(27).keys()]);
    expect(Buffer.from(data[0].embedding, 'base64')).toEqual(Buffer.from(new Float32Array(PARAGRAPH_VECTORS[0]).buffer));
    expect(stepOf('ingest', 3).detail).toContain('响应 3,924 字节；写成 float 数组要 6,602 字节');
    // Contextual Retrieval 的数字照抄 README 事实表：35%，5.7% → 3.7%。
    expect(stepOf('ingest', 3).detail).toContain('50–100 token');
    expect(stepOf('ingest', 3).detail).toContain('35%（5.7% → 3.7%）');
  });

  it('写入：向量 1,728 字节，记录 7,300 字节（正文 2,768），记录比向量大；1536 维时 165,888 字节；HNSW 建图 833 次', () => {
    expect([N.vectorBytes, N.recordsBytes, N.textBytes, N.firstRecordBytes, N.bigVectorBytes, N.hnswBuild]).toEqual([1728, 7300, 2768, 312, 165888, 833]);
    expect(N.recordsBytes).toBe(enc(JSON.stringify(I.RECORDS)));
    expect(N.recordsBytes).toBeGreaterThan(N.vectorBytes);
    expect(N.bigVectorBytes).toBe(27 * 1536 * 4);
    const meter = new DistanceMeter();
    buildHnsw(PARAGRAPH_VECTORS, { M: 16, efConstruction: 64 }, meter);
    expect(meter.total).toBe(833);
    expect(stepOf('ingest', 4).detail).toContain('插入这 27 个向量要算 833 次距离');
    expect(stepOf('ingest', 4).detail).toContain('写成 JSON 7,300 字节，其中正文 2,768 字节');
  });

  it('试查：27 次点积，前 3 是 cup#1、cup#2、cup#0，都出自保温杯的商品页；距离列只有最后一个事件是 27', () => {
    expect(I.search.hits.map((hit) => PARAGRAPHS[hit.id].id)).toEqual(['cup#1', 'cup#2', 'cup#0']);
    expect(new Set(I.hitRecords.map((record) => record.title))).toEqual(new Set(['《商品：真空保温杯 BW-350》']));
    expect(I.search.hits.map((hit) => +hit.score.toFixed(2))).toEqual([0.79, 0.64, 0.6]);
    expect(I.search.hits[0].score).toBe(dot(I.probe.vector, PARAGRAPH_VECTORS[I.search.hits[0].id]));
    expect(stepOf('ingest', 5).detail).toContain('前 3 名是 cup#1（0.79）、cup#2（0.64）、cup#0（0.60），都出自《商品：真空保温杯 BW-350》');
    expect(packetsOf(LESSON_BY_ID.ingest).map((packet) => packet.row.dist)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 27]);
    expect(LESSON_BY_ID.ingest.distNote).toBe('建 Flat 索引只是把向量平铺存好，一次也不比较；最后试查，和 27 个向量各比一次，一共 27 次。');
  });
});

describe('一次检索增强问答', () => {
  const N = Q.numbers;

  it('检索：认识 6 个词；前 3 是 aftersale#1、#2、#0，都出自《售后规则》；cup#1 排第 5', () => {
    expect(Q.q.known.map((hit) => hit.term)).toEqual(['保温', '温杯', '漏水', '可以', '以换', '换货']);
    expect(Q.q.unknown).toEqual(['杯漏', '货吗']);
    expect(Q.PASSAGES.map((p) => p.id)).toEqual(['aftersale#1', 'aftersale#2', 'aftersale#0']);
    expect(new Set(Q.PASSAGES.map((p) => p.title))).toEqual(new Set(['《售后规则》']));
    expect(Q.PASSAGES[2].text).toContain('无理由退货');
    expect(N.sealRank).toBe(5);
    expect(Q.meter.total).toBe(27);
    expect(stepOf('qa', 1).detail).toContain('aftersale#1（0.66）、aftersale#2（0.65）、aftersale#0（0.64）');
    expect(stepOf('qa', 1).detail).toContain('cup#1 排在第 5，没进前 3');
  });

  it('提示：587 字节、545 token；资料 371、说明 125、问题 43、换行 6，各部分之和等于整段', () => {
    expect([N.promptBytes, N.promptTokens, N.sourceTokens, N.instructionTokens, N.questionTokens, N.separatorTokens]).toEqual([587, 545, 371, 125, 43, 6]);
    expect(N.sourceTokens + N.instructionTokens + N.questionTokens + N.separatorTokens).toBe(N.promptTokens);
    expect(N.promptBytes).toBe(utf8Encode(Q.prompt.text).length);
    expect(Q.prompt.text).toContain('[1] 《售后规则》第 2 条');
    expect(stepOf('qa', 2).detail).toContain('545 个 token 里资料占 371，说明 125，问题只有 43');
  });

  it('请求：940 字节；search_result 写法 1,234 字节，块的字段是 type、source、title、content、citations', () => {
    expect([N.requestBytes, N.srRequestBytes, N.responseBytes, N.answerTokens]).toEqual([940, 1234, 613, 242]);
    const blocks = Q.SR_REQUEST.messages[0].content as Array<Record<string, unknown>>;
    expect(Object.keys(blocks[0])).toEqual(['type', 'source', 'title', 'content', 'citations']);
    expect(blocks[0].source).toBe('kb://aftersale#1');
    expect(blocks.slice(0, 3).every((block) => (block.citations as { enabled: boolean }).enabled)).toBe(true);
    expect(Object.keys(Q.REQUEST)).toEqual(['model', 'max_tokens', 'messages']);
    expect(stepOf('qa', 3).detail).toContain('请求一共 940 字节');
    expect(stepOf('qa', 3).detail).toContain('这个请求是 1,234 字节');
    expect(JSON.parse(Q.httpResponse.json.text).usage).toEqual({ input_tokens: 545, output_tokens: 242 });
  });

  it('引用核对：前两句有出处，第三句标 [3] 但 [3] 不支持；它其实出自没被检索到的 aftersale#3', () => {
    expect(Q.check.sentences.map((s) => [s.status, s.cites])).toEqual([['supported', [1]], ['supported', [2]], ['unsupported', [3]]]);
    expect(Q.check.sentences.map((s) => +s.support!.coverage.toFixed(2))).toEqual([0.83, 0.57, 0.04]);
    expect(Q.PASSAGES.map((p) => p.id)).not.toContain('aftersale#3');
    expect(Q.rule4Support.supported).toBe(true);
    expect(supports(Q.check.sentences[2].text, [Q.PASSAGES[2].text]).supported).toBe(false);
    expect(stepOf('qa', 4).desc).toBe('3 句里 2 句有出处');
    expect(stepOf('qa', 4).detail).toContain('覆盖率 0.73，能通过');
    expect(stepOf('qa', 4).detail).toContain('词覆盖率只有 0.04');
    // 回答里没有密封圈：讲密封圈的 cup#1 没进提示。
    expect(Q.ANSWER).not.toContain('密封圈');
    expect(LESSON_BY_ID.qa.outro.text).toContain('讲密封圈的那段排在第 5');
    expect(packetsOf(LESSON_BY_ID.qa).map((packet) => packet.row.dist)).toEqual([0, 0, 0, 27, 27, 27, 27, 27]);
  });
});

describe('重排序', () => {
  const N = R.numbers;

  it('召回前 10，和 qa 的前 3 一致；重排后前 3 是 aftersale#1、cup#1、aftersale#2', () => {
    expect(R.beforeTop).toEqual(Q.PASSAGES.map((p) => p.id));
    expect(R.afterTop).toEqual(['aftersale#1', 'cup#1', 'aftersale#2']);
    expect(R.RERANKED.map((entry) => `${entry.item.id}:${entry.before}`)).toEqual(['aftersale#1:1', 'cup#1:5', 'aftersale#2:2', 'cup#2:6', 'aftersale#0:3', 'shipping-fee#0:4', 'cup#0:7', 'warranty#0:8', 'shipping-fee#1:9', 'kettle#0:10']);
    expect([R.riser.item.id, R.riser.before, R.riser.rank]).toEqual(['cup#1', 5, 2]);
    expect([R.faller.item.id, R.faller.before, R.faller.rank]).toEqual(['aftersale#0', 3, 5]);
    expect(stepOf('rerank', 3).detail).toContain('cup#1 从第 5 升到第 2，aftersale#0 从第 3 掉到第 5，前 3 变成 aftersale#1、cup#1、aftersale#2');
  });

  it('相关块进前 3：1 → 2；cup#1 讲密封圈', () => {
    expect(R.LEAK.relevant).toEqual(['cup#1', 'aftersale#2']);
    expect([R.recallBefore.found, R.recallAfter.found]).toEqual([['aftersale#2'], ['cup#1', 'aftersale#2']]);
    expect(PARAGRAPHS.find((p) => p.id === 'cup#1')!.text).toContain('先取下密封圈重新装好');
  });

  it('打分：0.5 × 余弦 + 0.5 × idf 覆盖率；cup#1 0.573 / 0.325，aftersale#0 0.644 / 0.066；aftersale#0 余弦更高却被反超', () => {
    const c = crossScore(Q.QUESTION, PARAGRAPHS.find((p) => p.id === 'cup#1')!.text);
    const a = crossScore(Q.QUESTION, PARAGRAPHS.find((p) => p.id === 'aftersale#0')!.text);
    expect([c.cosine, c.coverage, c.score].map((x) => +x.toFixed(3))).toEqual([0.573, 0.325, 0.449]);
    expect([a.cosine, a.coverage, a.score].map((x) => +x.toFixed(3))).toEqual([0.644, 0.066, 0.355]);
    expect(a.cosine).toBeGreaterThan(c.cosine);
    expect(c.matched).toEqual(['保温', '温杯', '漏水']);
    expect(a.matched).toEqual(['可以']);
    // 覆盖率的拆解：8 个词，2 个不在词表里按 ln 27 算，合计 20.51。
    expect(R.TERMS).toEqual([...new Set(termsOf(Q.QUESTION))]);
    expect([N.terms, N.unknownTerms]).toEqual([8, 2]);
    expect(+R.idfTotal.toFixed(2)).toBe(20.51);
    expect(c.coverage).toBeCloseTo(c.matched.reduce((sum, t) => sum + EMBEDDER.idf.get(t)!, 0) / R.idfTotal, 12);
    expect(stepOf('rerank', 2).detail).toContain('（ln 27 = 3.30）算，合计 20.51');
    expect(stepOf('rerank', 2).detail).toContain('覆盖率 6.67 / 20.51 = 0.33');
  });

  it('距离列：召回 27 + 重排 10 = 37', () => {
    expect([N.recallDist, N.rerankDist, N.total]).toEqual([27, 10, 37]);
    expect(packetsOf(LESSON_BY_ID.rerank).map((packet) => packet.row.dist)).toEqual([0, 27, 27, 37, 37, 37, 37]);
    expect(LESSON_BY_ID.rerank.distNote).toBe('召回时和 27 个向量各比一次（27 次），重排时每个候选打一次分（10 次），一共 37 次。');
  });

  it('交叉编码的 token：34 × 10 + 1,016 = 1,356；Voyage、Cohere 请求体的字段', () => {
    expect([N.queryTokens, N.docTokens, N.crossTokens]).toEqual([34, 1016, 1356]);
    expect(N.crossTokens).toBe(countTokens(Q.QUESTION) * 10 + R.CANDIDATES.reduce((sum, p) => sum + countTokens(p.text), 0));
    expect(Object.keys(R.VOYAGE_BODY)).toEqual(['query', 'documents', 'model', 'top_k']);
    expect(Object.keys(R.COHERE_BODY)).toEqual(['model', 'query', 'documents', 'top_n']);
    expect([N.voyageBytes, N.cohereBytes]).toEqual([enc(JSON.stringify(R.VOYAGE_BODY)), enc(JSON.stringify(R.COHERE_BODY))]);
    expect(stepOf('rerank', 4).detail).toContain('34 × 10 + 1,016 = 1,356 个 token');
  });
});
