/**
 * 文案和计算结果对得上（流水线组后三课：rewrite、evaluate、finetune）。
 * 关键的数写死在这里，改了知识库或嵌入模型会立刻报错；文字里没法直接取值的说法（「排第一」「只差」「一个也没找到」「找不到」）逐条核对。
 */
import { describe, expect, it } from 'vitest';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { countTokens, dot, embed, embedVector, EVAL_SET, PARAGRAPHS, paragraphById, reciprocalRank, termsOf } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf, type Lesson } from '../src/lessons/types';
import * as R from '../src/lessons/rewrite';
import * as E from '../src/lessons/evaluate';
import * as F from '../src/lessons/finetune';

const stepOf = (lesson: Lesson, i: number) => lesson.steps[i];
const factsOf = (lesson: Lesson, i: number) => Object.fromEntries(lesson.steps[i].facts);
const dists = (lesson: Lesson) => packetsOf(lesson).map((p) => p.row.dist);

describe('失败案例与查询改写', () => {
  const L = LESSON_BY_ID.rewrite;

  it('旧版本排第一：已作废的 2025 版 0.998，现行版 0.997，只差 0.0009；两段只有标题和天数不同', () => {
    expect(R.plain.hits.map((h) => PARAGRAPHS[h.id].id)).toEqual(['refund-2025#0', 'refund#0', 'kettle#0']);
    expect(PARAGRAPHS[R.OLD].meta.status).toBe('archived');
    expect(R.numbers.oldScore).toBeGreaterThan(R.numbers.newScore);
    expect(R.numbers.oldScore - R.numbers.newScore).toBeCloseTo(0.0009, 4);
    expect(stepOf(L, 0).desc).toBe('已作废的 2025 版 0.998，现行版 0.997');
    expect(stepOf(L, 0).detail).toContain('现行版本只差 0.0009 排第二');
    // 两段去掉标题和数字后逐字相同。
    const strip = (t: string) => t.replace(/《[^》]*》/, '').replace(/[\d–]+/g, '#');
    expect(strip(PARAGRAPHS[R.OLD].text)).toBe(strip(PARAGRAPHS[R.NEW].text));
    expect(PARAGRAPHS[R.OLD].text).toContain('银行卡 7–15 个工作日');
    expect(PARAGRAPHS[R.NEW].text).toContain('银行卡 3–7 个工作日');
  });

  it('前过滤：26 / 27 个段落，第一名变成现行版', () => {
    expect(R.filtered.allowed).toHaveLength(26);
    expect(R.filtered.computed).toBe(26);
    expect(PARAGRAPHS[R.filtered.hits[0].id].id).toBe('refund#0');
    expect(R.filtered.hits.some((h) => h.id === R.OLD)).toBe(false);
    expect(stepOf(L, 1).desc).toBe('只搜现行文档：26 / 27 个段落');
  });

  it('答案被切开：32 字一块共 38 块，第 0 块止于「银行卡」，refund@1 只有 0.311 排第 2；重叠 8 字后 45 块，refund@1 完整，0.609', () => {
    expect([R.numbers.cutChunks, R.numbers.cutCurrent, R.numbers.lapChunks, R.numbers.lapCurrent]).toEqual([38, 36, 45, 43]);
    expect(R.refundCut[0].text.endsWith('银行卡')).toBe(true);
    expect(R.refundCut[1].text.startsWith('3–7 个工作日')).toBe(true);
    expect(R.whole(R.refundCut)).toBe(-1);
    expect(R.whole(R.refundLap)).toBe(1);
    expect(R.refundLap[1].text.startsWith('作日到账，银行卡')).toBe(true);
    const top = R.cutSearch.hits.map((h) => R.cut.chunks[h.id].id);
    expect(top[0]).toBe('refund@0');
    expect(top.indexOf('refund@1') + 1).toBe(2);
    expect(termsOf(R.cut.chunks.find((c) => c.id === 'refund@1')!.text)).not.toContain('银行');
    expect(stepOf(L, 2).detail).toContain('分数只有 0.311，排第 2；排第一的块（0.997）');
    expect(stepOf(L, 2).detail).toContain('分数升到 0.609');
  });

  it('说不清的问题：7 个词只认识「退货」，前 3 是积分、积分、运费，召回 0', () => {
    expect(R.numbers.vagueTerms).toBe(7);
    expect(R.numbers.vagueKnown).toEqual(['退货']);
    expect(R.vague.hits.map((h) => PARAGRAPHS[h.id].id)).toEqual(['points#0', 'points#1', 'shipping-fee#0']);
    expect(paragraphById('shipping-fee#0').text).toContain('非质量问题退货，寄回的运费由买家承担');
    expect(R.recall.vague.score).toBe(0);
    expect(stepOf(L, 3).detail).toContain('检索结果前两个是《会员积分》');
    expect(R.HISTORY[2]).toBe('用户：收到了，可是杯盖有点漏水。');
  });

  it('改写：认识的词 1 → 10，前 3 是 cup#1、aftersale#2、aftersale#3，召回 100%；token 是本站 BPE', () => {
    expect(R.rewritten.hits.map((h) => PARAGRAPHS[h.id].id)).toEqual(['cup#1', 'aftersale#2', 'aftersale#3']);
    expect(R.numbers.rewrittenKnown).toBe(10);
    expect(R.recall.rewritten.score).toBe(1);
    expect(R.numbers.rewritePromptTokens).toBe(TOKENIZER.encode(R.REWRITE_PROMPT).length);
    expect([R.numbers.rewritePromptTokens, R.numbers.rewriteTokens]).toEqual([298, 55]);
    expect(stepOf(L, 4).detail).toContain('查询里认识的词从 1 个变成 10 个');
  });

  it('多查询：aftersale#2 在三张列表里都出现、RRF 第一，前 3 找全；HyDE 的「30」不在词表里，前 3 也找全', () => {
    for (const s of R.subSearches) expect(s.hits.map((h) => PARAGRAPHS[h.id].id)).toContain('aftersale#2');
    expect(R.fused[0].id).toBe('aftersale#2');
    expect(R.fused[0].ranks.every((r) => r !== null)).toBe(true);
    expect(R.fused.slice(0, 3).map((d) => d.id)).toEqual(['aftersale#2', 'aftersale#1', 'aftersale#3']);
    expect(R.recall.multi.score).toBe(1);
    expect(R.HYDE).toContain('30 天');
    expect(paragraphById('aftersale#2').text).toContain('7 天内');
    expect(termsOf(R.HYDE)).toContain('30');
    expect(R.numbers.hydeWrongKnown).toBe(false);
    expect(R.hyde.hits.map((h) => PARAGRAPHS[h.id].id)).toEqual(['aftersale#2', 'aftersale#1', 'aftersale#3']);
    expect(R.recall.hyde.score).toBe(1);
    expect([R.numbers.hydeKnown, R.numbers.hydeTerms]).toEqual([24, 34]);
  });

  it('距离列：27 + 26 + 36 + 43 + 26 + 26 + 3 × 26 + 26 = 288', () => {
    expect(R.meter.total).toBe(27 + 26 + 36 + 43 + 26 + 26 + 3 * 26 + 26);
    expect(R.meter.total).toBe(288);
    expect(dists(L)).toEqual([0, 0, 27, 27, 53, 53, 53, 89, 89, 132, 132, 132, 158, 158, 158, 158, 184, 184, 184, 262, 262, 288, 288]);
    expect(L.overview.facts.find(([k]) => k === '距离计算')![1]).toBe('共 288 次');
  });
});

describe('RAG 评估', () => {
  const L = LESSON_BY_ID.evaluate;

  it('检索：11 / 12，召回@3 平均 0.9375，MRR 0.875；密封圈、积分的相关段落排第 2；只漏 aftersale#2', () => {
    expect([E.numbers.found, E.numbers.relevant, E.numbers.facts]).toEqual([11, 12, 14]);
    expect(E.avg.recall).toBe(0.9375);
    expect(E.avg.mrr).toBe(0.875);
    expect(E.rows.filter((r) => r.rr.rank !== 1).map((r) => [r.item.id, r.rr.rank])).toEqual([['seal', 2], ['points', 2]]);
    expect(E.rows.flatMap((r) => r.recall.missed)).toEqual(['aftersale#2']);
    expect(E.dist1).toBe(8 * 27);
    expect(stepOf(L, 0).detail).toContain('「密封圈」「积分」两题的相关段落都排在第 2');
    // MRR 的独立实现。
    for (const r of E.rows) {
      const first = r.retrieved.findIndex((id) => r.item.relevant.includes(id));
      expect(reciprocalRank(r.retrieved, r.item.relevant).score).toBe(first < 0 ? 0 : 1 / (first + 1));
    }
  });

  it('context precision：到账 (1 + 2/3) / 2 = 0.833，旧版排第 2；context recall：漏水 0.5，缺「换货」', () => {
    const refund = E.rows[E.I.refund];
    expect(refund.retrieved).toEqual(['refund#0', 'refund-2025#0', 'refund#1']);
    expect(refund.cp.score).toBeCloseTo((1 + 2 / 3) / 2, 10);
    expect(E.avg.cp).toBeCloseTo(0.8542, 4);
    expect(E.rows[E.I.leak].cr.missed).toEqual(['换货']);
    expect(paragraphById('aftersale#2').text).toContain('换货');
    expect(E.avg.cr).toBe(0.9375);
    expect(stepOf(L, 1).desc).toBe('context precision 0.85，context recall 0.94');
  });

  it('faithfulness：12 / 13 句，积分的第二句缺「50 元」；到账忠于旧版、关键事实 0', () => {
    expect([E.numbers.supported, E.numbers.answerSentences]).toEqual([12, 13]);
    const points = E.gen[E.I.points].faith;
    expect(points.score).toBe(0.5);
    expect(points.statements[1].support.missing).toEqual(['50 元']);
    expect(PARAGRAPHS.some((p) => p.text.includes('50 元'))).toBe(false);
    const refund = E.gen[E.I.refund];
    expect(refund.faith.score).toBe(1);
    expect(refund.facts.score).toBe(0);
    expect(E.ANSWERS['refund-time']).toContain('银行卡 7–15 个工作日');
    expect(E.avg.faith).toBe(0.9375);
    expect(E.avg.facts).toBe(0.5625);
    expect(E.numbers.promptTokens).toBe(E.gen.reduce((s, g) => s + TOKENIZER.encode(g.prompt.text).length, 0));
    expect(E.numbers.promptTokens).toBe(4192);
    expect(stepOf(L, 2).detail).toContain('和参考答案的 2 个关键事实一比，一个也没对上');
  });

  it('answer relevancy：改地址 0.27，其余至少 0.81；24 次余弦记进距离列', () => {
    const scores = E.relevancy.map((r) => r.score);
    expect(scores[E.I.address]).toBeCloseTo(0.2656, 4);
    expect(Math.min(...scores.filter((_, i) => i !== E.I.address))).toBeCloseTo(0.8118, 4);
    expect(E.relevancy[E.I.address].cosines[0]).toBeCloseTo(dot(embedVector(EVAL_SET[E.I.address].question), embedVector('运费多少？')), 12);
    expect(E.gen[E.I.address].faith.score).toBe(1);
    expect(E.meter.total).toBe(216 + 24);
    expect(dists(L)).toEqual([0, 216, 216, 216, 216, 216, 216, 216, 216, 216, 240, 240, 240, 240]);
    expect(stepOf(L, 3).desc).toBe('改地址 0.27，其余至少 0.81');
  });

  it('字面判据的漏判：「两年」不是关键事实，词覆盖率 0.92，被判为支持；参考答案是「一年」', () => {
    const s = E.gen[E.I.warranty].faith.statements[0];
    expect(s.support.facts).toEqual([]);
    expect(s.support.supported).toBe(true);
    expect(s.support.coverage).toBeCloseTo(0.92, 2);
    expect(paragraphById('warranty#0').text).toContain('保修一年');
    expect(E.gen[E.I.warranty].facts.score).toBe(0);
    expect(stepOf(L, 4).detail).toContain('词覆盖率 0.92，被判为支持');
  });
});

describe('RAG 和微调怎么选', () => {
  const L = LESSON_BY_ID.finetune;

  it('改一条规则：重嵌入 1 / 27 段 110 字节，请求 384、响应 470，向量 64 字节；知识库 2,794 字节', () => {
    expect(F.numbers).toMatchObject({ newBytes: 110, requestBytes: 384, responseBytes: 470, vectorBytes: 64, kbBytes: 2794, paragraphs: 27 });
    expect(F.numbers.newBytes).toBe(new TextEncoder().encode(F.NEW_TEXT).length);
    expect(F.http.json.text).toBe(JSON.stringify(F.REQUEST));
    expect(F.vectors).toHaveLength(28);
    expect(F.ids[F.check.hits[0].id]).toBe(F.NEW_ID);
    expect(F.check.computed).toBe(26);
    expect(F.numbers.newScore).toBeCloseTo(0.9964, 4);
    expect(stepOf(L, 0).detail).toContain('其余 26 段都不用重算');
    expect(stepOf(L, 0).detail).toContain('第一名就是新规则（0.996）');
    // 嵌入模型没有动：新段落的向量就是全站模型的结果。
    expect(F.vectors[27]).toEqual(embed(F.NEW_TEXT).vector);
  });

  it('溯源：RAG 的回答 supported，微调的回答 uncited；格式化的三行是 uncited、supported、uncited', () => {
    expect(F.ragCheck.sentences.map((s) => s.status)).toEqual(['supported']);
    expect(F.tunedCheck.sentences.map((s) => s.status)).toEqual(['uncited']);
    expect(F.formattedCheck.sentences.map((s) => s.status)).toEqual(['uncited', 'supported', 'uncited']);
    expect(F.prompt.sources[0].text).toBe(F.NEW_TEXT);
  });

  it('每次请求：RAG 505 token，微调 27，差 478；1,000 次 478,000 token，按 $4 / MTok 约 $1.91', () => {
    expect(F.prompt.tokens).toBe(TOKENIZER.encode(F.prompt.text).length);
    expect([F.prompt.tokens, F.tunedTokens, F.extraTokens]).toEqual([505, 27, 478]);
    expect(F.tunedTokens).toBe(countTokens(F.QUESTION));
    expect(F.extraCost).toBeCloseTo(1.912, 6);
    expect(stepOf(L, 3).detail).toContain('就是 478,000 个 token');
    expect(stepOf(L, 3).detail).toContain('约 $1.91');
    expect(factsOf(L, 3)['单价来源']).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
  });

  it('格式要求每次多 349 token；距离列只有两次检索，各 26 次', () => {
    expect(F.formatTokens).toBe(349);
    expect(F.formatPrompt.tokens).toBe(854);
    expect(F.meter.total).toBe(52);
    expect(dists(L)).toEqual([0, 0, 0, 26, 26, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52]);
    expect(utf8Encode(F.TRAIN_SAMPLE).length).toBeGreaterThan(0);
  });

  it('全课最后一课：outro 收束整门课，引到下一门课 AGENT EXPLORER（不是链接）', () => {
    expect(L.outro.text).toContain('下一门课是 AGENT EXPLORER');
    expect(L.outro.text).not.toMatch(/https?:/);
    expect(Object.fromEntries(L.outro.facts)['下一门课']).toBe('AGENT EXPLORER');
  });
});
