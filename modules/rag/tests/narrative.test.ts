/**
 * 文案和计算结果对得上（嵌入组）。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果（防止取错字段），关键的数写死在这里，改了输入会立刻报错；
 * 2. 文字里没法取值的说法，比如「每个汉字 3 个字节」「共同的词只有一个，还不在词表里」「第 0 维最大」。
 *
 * 每加一节课，在对应组的 narrative.<组>.test.ts 里加一个 describe（embedtext 在这里，嵌入组的其余两课也写在这里）。
 */
import { describe, expect, it } from 'vitest';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { base64Decode, dot, EMBEDDER, f32FromVectorBytes, norm, PARAGRAPHS, termsOf } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf } from '../src/lessons/types';
import { base64, cos12, cos13, cos23, cooccur, http1, http2, httpResponse1, meter, numbers, Q1, Q2, Q3, REQUEST, sharedTerms, t1, t2, t3 } from '../src/lessons/embedtext';

const lesson = LESSON_BY_ID.embedtext;
const stepOf = (step: number) => lesson.steps[step];
const factsOf = (step: number) => Object.fromEntries(lesson.steps[step].facts);
const enc = (text: string) => new TextEncoder().encode(text).length;

describe('文本变向量', () => {
  it('请求：四个字段，请求体和 JSON.stringify 一致，Bearer 鉴权，content-length 对得上', () => {
    expect(Object.keys(REQUEST)).toEqual(['input', 'model', 'dimensions', 'encoding_format']);
    expect(http1.json.text).toBe(JSON.stringify(REQUEST));
    expect(numbers.bodyBytes).toBe(enc(JSON.stringify(REQUEST)));
    expect(numbers).toMatchObject({ bodyBytes: 117, requestBytes: 304, headBytes: 187 });
    const head = new TextDecoder().decode(new Uint8Array(http1.layout.bytes.slice(0, numbers.headBytes)));
    expect(head).toBe(`POST /v1/embeddings HTTP/1.1\r\nhost: api.openai.com\r\ncontent-type: application/json\r\nauthorization: Bearer sk-proj-${'x'.repeat(48)}\r\ncontent-length: 117\r\n\r\n`);
    expect(stepOf(0).desc).toBe('input 加 3 个参数，请求共 304 字节');
    expect(stepOf(0).detail).toContain('把默认的 1536 维缩短，这里要 16 维');
  });

  it('切词：10 个字符 30 字节，8 个二元组，词表里只有 3 个；不认识的两个例子确实不在词表里', () => {
    expect(numbers.chars).toBe(10);
    expect(numbers.bytes).toBe(30);
    for (const char of Q1) expect(utf8Encode(char), char).toHaveLength(3);
    expect(t1.terms).toEqual(termsOf(Q1));
    expect([numbers.terms, numbers.known, numbers.unknown, numbers.vocab]).toEqual([8, 3, 5, 480]);
    expect(stepOf(1).desc).toBe('8 个词，认识 3 个');
    expect(stepOf(1).detail).toContain('其中只有「保温」「温杯」「漏水」在它的 480 个词的词表里，「杯漏」「水了」这样的组合在知识库里从没出现过');
    for (const term of ['杯漏', '水了']) expect(PARAGRAPHS.some((p) => termsOf(p.text).includes(term)), term).toBe(false);
  });

  it('查表和池化：嵌入表 480 × 16 × 4 字节；「漏水」只出现在一段里，idf 最大、权重最大', () => {
    expect(numbers.tableBytes).toBe(480 * 16 * 4);
    expect(factsOf(2).嵌入表).toBe('480 × 16 × 4 = 30,720 字节');
    const leak = t1.known.find((hit) => hit.term === '漏水')!;
    expect(EMBEDDER.df.get('漏水')).toBe(1);
    expect(Math.max(...t1.known.map((hit) => hit.idf))).toBe(leak.idf);
    expect(Math.max(...t1.known.map((hit) => hit.weight))).toBe(leak.weight);
    expect(factsOf(2).权重最大).toBe('漏水（3.296）');
    expect(stepOf(2).detail).toContain('「漏水」只出现在一段里，idf 最大，权重也最大');
    expect(numbers.norm).toBeCloseTo(0.1517, 4);
  });

  it('归一化：长度 1，第 0 维绝对值最大，16 × 4 = 64 字节；归一化后 l2² = 2 − 2·cos', () => {
    expect(norm(t1.vector)).toBeCloseTo(1, 6);
    const abs = t1.vector.map(Math.abs);
    expect(abs.indexOf(Math.max(...abs))).toBe(0);
    expect(factsOf(3)['第 0 维']).toBe('0.86（最大）');
    expect(numbers.vectorBytes).toBe(64);
    expect(stepOf(3).desc).toBe('除以 0.1517，16 × 4 = 64 字节');
    expect(stepOf(3).detail).toContain('平方欧氏距离等于 2 − 2 × 余弦');
  });

  it('响应：向量写成 JSON 190 字节，base64 88 个字符，解码就是 float32 小端字节；usage 是本站 BPE 的计数', () => {
    const json = JSON.parse(httpResponse1.json.text);
    expect(Object.keys(json)).toEqual(['object', 'data', 'model', 'usage']);
    expect(json.data[0].embedding.map(Math.fround)).toEqual(t1.vector);
    expect(numbers.embeddingJson).toBe(JSON.stringify(json.data[0].embedding).length);
    expect(numbers.embeddingJson).toBe(190);
    expect(numbers.base64Length).toBe(Math.ceil(64 / 3) * 4);
    expect(f32FromVectorBytes(base64Decode(base64))).toEqual(t1.vector);
    expect(base64).toBe(Buffer.from(new Float32Array(t1.vector).buffer).toString('base64'));
    expect(numbers.promptTokens).toBe(TOKENIZER.encode(Q1).length);
    expect(json.usage).toEqual({ prompt_tokens: 30, total_tokens: 30 });
    expect(numbers.responseBytes).toBe(466);
    expect(stepOf(4).detail).toContain('写成 JSON 数组要 190 字节，写成 base64 只要 88 字节');
  });

  it('比较：同义 0.65、无关 0.01 和 0.00；共同的词只有「怎么」，它不在词表里；「漏水」「渗水」只同时出现在 cup#1', () => {
    expect(dot(t1.vector, t2.vector)).toBe(cos12);
    expect([cos12, cos13, cos23].map((x) => +x.toFixed(2))).toEqual([0.65, 0.01, -0]);
    expect(sharedTerms).toEqual(['怎么']);
    expect(EMBEDDER.table.has('怎么')).toBe(false);
    expect(cooccur.map((p) => p.id)).toEqual(['cup#1']);
    expect(PARAGRAPHS.filter((p) => p.text.includes('漏水')).map((p) => p.id)).toEqual(['cup#1']);
    expect(PARAGRAPHS.filter((p) => p.text.includes('渗水')).map((p) => p.id)).toEqual(['cup#1']);
    expect(stepOf(5).desc).toBe('同义 0.65，无关 0.01');
    // 距离列：只有最后一个事件比较了向量，三对各一次。
    expect(meter.total).toBe(3);
    expect(packetsOf(lesson).map((packet) => packet.row.dist)).toEqual([0, 0, 0, 0, 0, 0, 0, 3]);
    expect(lesson.distNote).toBe('最后一步比较三个问题的向量，两两一对，一共 3 次。');
    expect(stepOf(5).detail).toContain('同义的一对 0.65，无关的两对是 0.01 和 0.00');
    expect(stepOf(5).detail).toContain('字面上共同的词只有一个「怎么」，它还不在词表里');
    expect(t3.known.map((hit) => hit.term)).toEqual(['发票']);
    expect(t2.known.map((hit) => hit.term)).toEqual(['杯盖', '渗水', '处理']);
    expect(numbers.request2Bytes).toBe(http2.layout.bytes.length);
    expect([Q2, Q3]).toEqual(['杯盖渗水该怎么处理？', '怎么开发票？']);
  });

  it('概览和总结里的数字', () => {
    expect(lesson.overview.description).toContain('变成 16 个 float32（64 字节），装进 466 字节的 HTTP 响应送回来');
    expect(lesson.outro.desc).toBe('10 个字 → 16 个数 → 64 字节');
    expect(lesson.outro.text).toContain('只在 27 段知识库上训练');
    expect(Object.fromEntries(lesson.overview.facts)['同义 / 无关']).toBe('余弦 0.65 / 0.01');
  });
});

// ---------- 相似度（similarity） ----------

import { cosine, dot as dotProduct, EVAL_SET, f32VectorBytes, l2sq as sqDistance, norm as vecNorm, PARAGRAPH_VECTORS, embed as embedText, docById, docText, fixedChunks, paragraphChunks, sentences, recursiveChunks } from '../src/core';
import * as sim from '../src/lessons/similarity';
import * as chk from '../src/lessons/chunking';

describe('相似度', () => {
  const lessonSim = LESSON_BY_ID.similarity;
  const step = (n: number) => lessonSim.steps[n];
  const ids = (list: number[]) => list.map((i) => PARAGRAPHS[i].id);
  const rawOf = (id: string) => PARAGRAPHS.findIndex((p) => p.id === id);

  it('查询是评估集里的「不想要了退货，运费谁出？」，标注的相关段落是 aftersale#0 和 shipping-fee#0', () => {
    const item = EVAL_SET.find((e) => e.id === 'return-fee')!;
    expect(sim.QUESTION).toBe('不想要了退货，运费谁出？');
    expect(item.relevant).toEqual(['aftersale#0', 'shipping-fee#0']);
    // 未归一化的向量就是 embed 的池化结果，长度 0.175；归一化后长度 1。
    expect(vecNorm(sim.qRaw)).toBeCloseTo(0.1746, 4);
    expect(vecNorm(sim.qUnit)).toBeCloseTo(1, 6);
    sim.qUnit.forEach((x, i) => expect(x).toBeCloseTo(sim.qRaw[i] / vecNorm(sim.qRaw), 6));
  });

  it('第 1 步：同一对向量三个数，手算核对，点积 = 余弦 × 两个长度', () => {
    const p = sim.raw[rawOf('aftersale#0')];
    let manualDot = 0;
    let manualL2 = 0;
    for (let i = 0; i < 16; i++) {
      manualDot += sim.qRaw[i] * p[i];
      manualL2 += (sim.qRaw[i] - p[i]) ** 2;
    }
    expect(sim.pair.dot).toBeCloseTo(manualDot, 12);
    expect(sim.pair.l2).toBeCloseTo(Math.sqrt(manualL2), 12);
    expect(sim.pair.cosine).toBeCloseTo(manualDot / (vecNorm(sim.qRaw) * vecNorm(p)), 12);
    expect(sim.pair.dot).toBeCloseTo(sim.pair.cosine * sim.pair.qNorm * sim.pair.pNorm, 12);
    expect(PARAGRAPHS[sim.pairIndex].id).toBe('aftersale#0');
    expect(step(0).desc).toBe('点积 0.0216，余弦 0.8954，欧氏距离 0.0798');
    expect(step(0).detail).toContain('长度 0.175');
    expect(Object.fromEntries(step(0).facts).长度).toBe('‖q‖ = 0.175，‖p‖ = 0.138');
  });

  it('第 2 步：点积第 1 名 aftersale#0、余弦第 1 名 shipping-fee#0，points#1 凭长度挤进点积前 4', () => {
    // 独立排序：不用 topK，直接按值排。
    const order = (key: (i: number) => number) => PARAGRAPHS.map((_, i) => i).sort((a, b) => key(b) - key(a));
    const byDot = order((i) => dotProduct(sim.qRaw, sim.raw[i]));
    const byCos = order((i) => cosine(sim.qRaw, sim.raw[i]));
    expect(ids(byDot.slice(0, 5))).toEqual(['aftersale#0', 'shipping-fee#0', 'aftersale#1', 'points#1', 'aftersale#2']);
    expect(ids(byCos.slice(0, 5))).toEqual(['shipping-fee#0', 'aftersale#0', 'aftersale#1', 'aftersale#2', 'points#0']);
    expect(byCos.indexOf(rawOf('points#1')) + 1).toBe(6);
    expect(PARAGRAPHS[sim.dotWinner].id).toBe('aftersale#0');
    expect(PARAGRAPHS[sim.cosWinner].id).toBe('shipping-fee#0');
    expect(PARAGRAPHS[sim.intruder].id).toBe('points#1');
    expect(PARAGRAPHS[sim.pushedOut].id).toBe('aftersale#2');
    // 文字：aftersale#0 比 shipping-fee#0 长 6.4%，余弦低 0.906 → 0.895；两个第 1 名都是标注的相关段落。
    expect((vecNorm(sim.raw[rawOf('aftersale#0')]) / vecNorm(sim.raw[rawOf('shipping-fee#0')]) - 1) * 100).toBeCloseTo(6.4, 1);
    expect(cosine(sim.qRaw, sim.raw[rawOf('shipping-fee#0')])).toBeGreaterThan(cosine(sim.qRaw, sim.raw[rawOf('aftersale#0')]));
    expect(EVAL_SET.find((e) => e.id === 'return-fee')!.relevant).toEqual(expect.arrayContaining(['aftersale#0', 'shipping-fee#0']));
    expect(vecNorm(sim.raw[rawOf('points#1')])).toBeCloseTo(0.215, 3);
    expect(cosine(sim.qRaw, sim.raw[rawOf('points#1')])).toBeCloseTo(0.491, 3);
    expect(sim.CAND).toHaveLength(5);
    expect(step(1).desc).toBe('点积第 1 名 aftersale#0，余弦第 1 名 shipping-fee#0');
    expect(step(1).detail).toContain('余弦 0.906 比 aftersale#0 的 0.895 高');
    expect(step(1).detail).toContain('向量长 6.4%');
    expect(step(1).detail).toContain('points#1：它的余弦只有 0.491（第 6 名），向量长 0.215，点积挤进了第 4 名，把 aftersale#2 挤出了前 4');
    expect(step(1).detail).toContain('前两名都是标注的相关段落');
  });

  it('第 3 步：归一化后点积 = 余弦，‖a−b‖² = 2 − 2cos，27 段的顺序逐名相同', () => {
    PARAGRAPH_VECTORS.forEach((v) => expect(vecNorm(v)).toBeCloseTo(1, 6));
    PARAGRAPH_VECTORS.forEach((v, i) => {
      expect(dotProduct(sim.qUnit, v)).toBeCloseTo(cosine(sim.qRaw, sim.raw[i]), 6);
      expect(sqDistance(sim.qUnit, v)).toBeCloseTo(2 - 2 * dotProduct(sim.qUnit, v), 6);
    });
    const order = (key: (i: number) => number) => PARAGRAPH_VECTORS.map((_, i) => i).sort((a, b) => key(b) - key(a));
    const byDot = order((i) => dotProduct(sim.qUnit, PARAGRAPH_VECTORS[i]));
    const byCos = order((i) => cosine(sim.qUnit, PARAGRAPH_VECTORS[i]));
    const byL2 = order((i) => -sqDistance(sim.qUnit, PARAGRAPH_VECTORS[i]));
    expect(byCos).toEqual(byDot);
    expect(byL2).toEqual(byDot);
    expect(sim.sameOrder).toBe(true);
    expect(sim.identityGap).toBeLessThan(1e-6);
    expect(step(2).desc).toBe('长度都变成 1，三种度量的顺序完全一致');
    expect(step(2).detail).toContain('点积、余弦、欧氏距离排出的顺序逐名相同');
    expect(step(2).detail).toContain('OpenAI 和 Voyage 的嵌入接口返回的向量已经归一化到长度 1');
  });

  it('第 4 步：16 个乘积逐个累加，结果写成 float32 小端字节；float32 累加差约 8e-8', () => {
    const a = new Float32Array(sim.accA);
    const b = new Float32Array(sim.accB);
    let sum = 0;
    const partial: number[] = [];
    for (let i = 0; i < 16; i++) partial.push((sum += a[i] * b[i]));
    expect(sim.partial64).toEqual(partial);
    expect(sim.sum64).toBeCloseTo(dotProduct(sim.qUnit, PARAGRAPH_VECTORS[sim.cosWinner]), 12);
    expect(PARAGRAPHS[sim.accIndex].id).toBe('shipping-fee#0');
    expect(sim.sum64).toBeCloseTo(0.906261, 6);
    expect(sim.sumBytes).toEqual([...Buffer.from(new Float32Array([sim.sum64]).buffer)]);
    expect(sim.sumBytes.map((x) => x.toString(16).padStart(2, '0')).join(' ')).toBe('b3 00 68 3f');
    expect(f32VectorBytes(sim.accA)).toHaveLength(64);
    // 每步都舍入回 float32 的累加。
    const s32 = new Float32Array(1);
    for (let i = 0; i < 16; i++) s32[0] = s32[0] + Math.fround(a[i] * b[i]);
    expect(sim.sum32).toBe(s32[0]);
    expect(sim.accGap).toBeLessThan(1e-6);
    expect(sim.accGap).toBeCloseTo(8.1e-8, 9);
    expect(sim.costs).toEqual({ dot: 16, cosine: 48 });
    expect(step(3).desc).toBe('16 次乘法、16 次加法，结果 0.9063');
    expect(step(3).detail).toContain('存回去又是 4 个字节 b3 00 68 3f');
    expect(step(3).detail).toContain('结果是 0.906261，差 8.1e-8');
    expect(step(3).detail).toContain('约 48 次乘法，点积只要 16 次');
  });

  it('第 5 步：点积扫 27 段，前 5 名是 shipping-fee#0 开头，余弦、欧氏距离同序；距离列 0、1、6、11、12、39', () => {
    expect(PARAGRAPHS).toHaveLength(27);
    expect(ids(sim.topIds)).toEqual(['shipping-fee#0', 'aftersale#0', 'aftersale#1', 'aftersale#2', 'points#0']);
    expect(sim.topByCos).toEqual(sim.topIds);
    expect(sim.topByL2).toEqual(sim.topIds);
    expect(sim.search.computed).toBe(27);
    expect(sim.meter.total).toBe(39);
    expect(packetsOf(lessonSim).map((packet) => packet.row.dist)).toEqual([0, 1, 6, 11, 12, 39]);
    expect(lessonSim.distNote).toBe('每步里查询和一个段落比较一次记 1 次，同一对换几种度量算只记一次；最后一步暴力扫 27 个段落，累计 39 次。');
    expect(step(4).detail).toContain('对 27 个段落向量各算一次点积，取最大的 5 个');
    expect(step(4).detail).toContain('用余弦排是同一个顺序，用欧氏距离排也是同一个顺序');
    expect(Object.fromEntries(step(4).facts)['第 1 名']).toBe('shipping-fee#0（0.906）');
    expect(lessonSim.outro.desc).toBe('没归一化时第 1 名不同，归一化后 27 段的顺序一致');
  });
});

// ---------- 分块（chunking） ----------

describe('分块', () => {
  const lessonChk = LESSON_BY_ID.chunking;
  const step = (n: number) => lessonChk.steps[n];
  const text = docText(docById('cup')!);
  const chars = [...text];
  const slice = (from: number, to: number) => chars.slice(from, to).join('');
  const spans = (chunks: Array<{ from: number; to: number }>) => chunks.map((c) => [c.from, c.to]);
  const question = '保温杯漏水了怎么办？';
  const answer = '先取下密封圈重新装好再试。';

  it('文档 180 个字符 466 字节；答案句在第 89 到 102 个字符', () => {
    expect(text).toBe(docById('cup')!.paragraphs.join('\n'));
    expect(chars).toHaveLength(180);
    expect(Buffer.byteLength(text)).toBe(466);
    expect(chk.TEXT_TOKENS).toBe(TOKENIZER.encode(text).length);
    expect(slice(89, 102)).toBe(answer);
    expect([chk.ANSWER_FROM, chk.ANSWER_TO, chk.ANSWER_LEN]).toEqual([89, 102, 13]);
    expect(chk.QUESTION).toBe(question);
    expect(lessonChk.overview.description).toContain('（180 个字符、466 字节）');
    expect(lessonChk.overview.description).toContain('在第 89 到 102 个字符');
  });

  it('第 1 步：固定 48 个字，窗口 [0,48) [48,96) [96,144) [144,180)，去首尾换行后长 47、48、47、36；切点 96 在答案中间', () => {
    const windows = [[0, 48], [48, 96], [96, 144], [144, 180]];
    windows.forEach(([a, b], i) => expect(chk.A.chunks[i].text).toBe(slice(a, b).trim()));
    expect(spans(chk.A.chunks)).toEqual([[0, 47], [48, 96], [96, 143], [144, 180]]);
    expect(chk.A.chunks.map((c) => c.to - c.from)).toEqual([47, 48, 47, 36]);
    expect(chk.A.chunks.map((c) => c.overlap)).toEqual([0, 0, 0, 0]);
    expect(chk.A.chunks.some((c) => c.text.includes(answer))).toBe(false);
    expect(chk.numbers.cut).toBe(96);
    expect(89 < 96 && 96 < 102).toBe(true);
    expect(step(0).desc).toBe('4 块，切点在第 48、96、144 个字符');
    expect(step(0).detail).toContain('长度是 47、48、47、36');
    expect(step(0).detail).toContain('第 96 个字符处有一个切点，正好落在它中间');
    expect(chk.A.tokens).toBe(chk.A.chunks.reduce((s, c) => s + TOKENIZER.encode(c.text).length, 0));
  });

  it('第 2 步：块 1 最相似 0.799，只带走答案的前 7 个字「先取下密封圈重」，剩下「新装好再试。」在块 2', () => {
    const q = embedText(question);
    const sims = chk.A.chunks.map((c) => cosine(q.pooled, embedText(c.text).pooled));
    chk.A.sims.forEach((s, i) => expect(s).toBeCloseTo(sims[i], 6));
    expect(chk.A.sims.map((s) => +s.toFixed(3))).toEqual([0.602, 0.799, 0.758, 0.337]);
    expect(chk.A.top).toBe(1);
    expect(chk.A.inTop).toBe(7);
    expect(chk.A.chunks[1].text.endsWith('先取下密封圈重')).toBe(true);
    expect(chk.A.chunks[2].text.startsWith('新装好再试。')).toBe(true);
    expect(chk.A.whole).toEqual([]);
    expect(chk.A.outcome).toBe('cut');
    expect(step(1).desc).toBe('块 1 最相似（0.799），但只带走答案的 7 个字');
    expect(step(1).detail).toContain('结尾是「先取下密封圈重」，剩下的「新装好再试」在块 2 里');
    expect(step(1).detail).toContain('相似度 0.799');
  });

  it('第 3 步：重叠 10，窗口步长 38，5 块；块 2 [76,124) 整句装下答案，首位 0.900，相似度 0.799 → 0.900', () => {
    expect(spans(chk.B.chunks)).toEqual([[0, 47], [38, 86], [76, 124], [114, 162], [152, 180]]);
    expect(chk.B.chunks.map((c) => c.overlap).slice(2)).toEqual([10, 10, 10]);
    expect(chk.B.whole).toEqual([2]);
    expect(chk.B.chunks[2].text.includes(answer)).toBe(true);
    expect(chk.B.top).toBe(2);
    expect(chk.B.outcome).toBe('hit');
    expect(chk.B.sims.map((s) => +s.toFixed(3))).toEqual([0.602, 0.84, 0.9, 0.592, 0.307]);
    expect(step(2).desc).toBe('5 块，块 2 最相似（0.900），带着完整的答案');
    expect(step(2).detail).toContain('步长从 48 变成 38');
    expect(step(2).detail).toContain('整句落在块 2（第 76 到 124 个字符）里面');
    expect(step(2).detail).toContain('相似度从 0.799 升到 0.900');
    expect(Object.fromEntries(step(2).facts).块数).toBe('4 → 5');
  });

  it('第 4 步：按句 5 块，首位只有 13 个字的「保温杯的杯盖带硅胶密封圈。」0.873，答案句 0.762 在隔壁；按段落 4 块首位含整句；递归 48/10 首位 0.939 不含答案', () => {
    expect(chk.SENT.chunks.map((c) => c.text)).toEqual(sentences(text).map((c) => c.text));
    expect(chk.SENT.chunks).toHaveLength(5);
    expect(chk.SENT.chunks[1].text).toBe('保温杯的杯盖带硅胶密封圈。');
    expect(chk.SENT.top).toBe(1);
    expect(chk.SENT.topSim).toBeCloseTo(0.873, 3);
    expect(chk.SENT.chunks[2].text).toBe(`杯盖漏水、渗水，多半是密封圈没装好或者老化开裂，${answer}`);
    expect(chk.SENT.sims[2]).toBeCloseTo(0.762, 3);
    expect(chk.SENT.sims[1]).toBeGreaterThan(chk.SENT.sims[2]);
    expect([chk.SENT.shortest, chk.SENT.longest]).toEqual([13, 51]);
    expect(chk.PARA.chunks.map((c) => c.text)).toEqual(paragraphChunks(text).map((c) => c.text));
    expect(chk.PARA.chunks).toHaveLength(4);
    expect([chk.PARA.top, chk.PARA.outcome]).toEqual([1, 'hit']);
    expect(chk.PARA.topSim).toBeCloseTo(0.789, 3);
    expect(chk.REC.chunks.map((c) => c.text)).toEqual(recursiveChunks(text, { size: 48, overlap: 10 }).map((c) => c.text));
    expect(chk.REC.chunks).toHaveLength(5);
    expect([chk.REC.top, chk.REC.whole, chk.REC.outcome]).toEqual([1, [2], 'miss']);
    expect(chk.REC.topSim).toBeCloseTo(0.939, 3);
    expect(step(3).desc).toBe('句 0.873（首位没有答案），段落 0.789（首位有完整答案）');
    expect(step(3).detail).toContain('首位是「保温杯的杯盖带硅胶密封圈」，只有 13 个字，相似度 0.873 反而比答案那句高');
    expect(step(3).detail).toContain('答案就在块 1 里，首位相似度 0.789');
    expect(step(3).detail).toContain('首位是块 1（0.939），答案在块 2 里，没被切断，但排第 1 的不是它');
  });

  it('第 5 步：重叠 0 / 5 / 10 / 12 / 15 / 20 的块数、字符、token、向量字节；重叠 ≥ 12 才保证装下，15 时整句还在但首位换人', () => {
    const rows = chk.OVERLAPS.map((ov) => fixedChunks(text, 48, ov));
    expect(chk.OVERLAPS).toEqual([0, 5, 10, 12, 15, 20]);
    expect(rows.map((r) => r.length)).toEqual([4, 5, 5, 5, 5, 6]);
    expect(rows.map((r) => r.reduce((s, c) => s + c.to - c.from, 0))).toEqual([178, 199, 219, 227, 238, 279]);
    expect(chk.SWEEP.map((r) => r.chars)).toEqual([178, 199, 219, 227, 238, 279]);
    expect(chk.SWEEP.map((r) => r.tokens)).toEqual([420, 465, 516, 542, 559, 658]);
    expect(chk.SWEEP.map((r) => r.bytes)).toEqual([464, 511, 567, 593, 620, 727]);
    expect(chk.SWEEP.map((r) => r.chunks.length * 64)).toEqual([256, 320, 320, 320, 320, 384]);
    expect(chk.SWEEP.map((r) => r.outcome)).toEqual(['cut', 'hit', 'hit', 'hit', 'miss', 'miss']);
    expect(chk.SWEEP[4].top).toBe(1);
    expect(chk.SWEEP[4].whole.length).toBeGreaterThan(0);
    expect(chk.SWEEP[4].topSim).toBeCloseTo(0.876, 3);
    // 保证：窗口 48、重叠 ≥ 答案长 − 1 = 12 时，不管答案在哪个位置，都有一个窗口整句装下；重叠 11 能找到装不下的位置。
    const holds = (ov: number, pad: number) => fixedChunks(`${'甲'.repeat(pad)}${answer}${'乙'.repeat(60)}`, 48, ov).some((c) => c.text.includes(answer));
    for (let pad = 0; pad < 120; pad++) expect(holds(12, pad), `重叠 12，前面 ${pad} 个字`).toBe(true);
    expect(Array.from({ length: 120 }, (_, pad) => holds(11, pad)).includes(false)).toBe(true);
    expect(chk.GUARANTEE).toBe(12);
    // 估算 48 / 38 = 1.26，实际 219 / 178 = 1.23。
    expect(48 / 38).toBeCloseTo(1.263, 3);
    expect(219 / 178).toBeCloseTo(1.23, 2);
    expect(step(4).desc).toBe('重叠 10：多 1 块、多存 23%；重叠 20：多存 56.7%');
    expect(step(4).detail).toContain('把块数从 4 变成 5，块里的字符多 23%（178 → 219），要嵌入的 token 从 420 变成 516，每块 64 字节的向量从 256 变成 320 字节');
    expect(step(4).detail).toContain('48 / (48 − 10) = 1.26 倍');
    expect(step(4).detail).toContain('重叠至少 12 个字才保证有一块整句装下它，到 15 个字时整句还在块里，但排第 1 的变成了块 1');
  });

  it('距离列：每种切法每个块比较一次，累计 0、0、0、4、4、9、9、23、23、44', () => {
    expect(chk.meter.total).toBe(44);
    expect(chk.dist).toEqual([0, 4, 9, 23, 44]);
    expect(packetsOf(lessonChk).map((packet) => packet.row.dist)).toEqual([0, 0, 0, 4, 4, 9, 9, 23, 23, 44]);
    expect(lessonChk.distNote).toBe('每种切法里，问题的向量和每个块的向量比较一次记 1 次，块越多次数越多，累计 44 次。');
    expect(4 + 5 + (5 + 4 + 5) + (5 + 5 + 5 + 6)).toBe(44);
    expect(lessonChk.outro.desc).toBe('答案 13 个字，重叠至少 12 才保证整句装下');
    expect(Object.fromEntries(lessonChk.outro.facts)['固定 48 / 10']).toBe('5 块，首位有完整答案，多存 23%');
  });
});
