/**
 * 文案和计算结果对得上。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果（防止取错字段）；
 * 2. 文字里没法取值的说法，比如「rank 很靠前」「跨过了字符边界」「一条规则都没用上」。
 *    这些说法依赖输入和语料。改了课程的输入、语料或合并数，这里会报错，提醒同时改写文案。
 *
 * 每加一节课，在这里加一个 describe。
 */
import { describe, expect, it } from 'vitest';
import { LESSON_BY_ID } from '../src/lessons';
import { bpeRun, corpusStats, crossBoundary, INPUT, nonAsciiMerges, widestCross } from '../src/lessons/bpe';
import { CORPUS } from '@explorer/llm-core/corpus';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Encode } from '@explorer/llm-core/utf8';

const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const stepOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step];

describe('BPE 分词', () => {
  const T = TOKENIZER;
  const labels = bpeRun.ids.map((id) => T.label(id));

  it('手算结果', () => {
    // 「大模型读」4 个汉字 × 3 字节 + 「␣token」6 个字节。
    expect(stepOf('bpe', 0).desc).toBe('10 个字符，18 个字节');
    expect(factsOf('bpe', 0).汉字).toBe('4 个 × 3 字节');
    expect(stepOf('bpe', 1).desc).toBe('切成 2 块，块之间不合并');
    expect(factsOf('bpe', 1).块).toBe('「大模型读」 「␣token」');
    expect(factsOf('bpe', 1)['rank 0']).toBe('Ġ t');
    expect(stepOf('bpe', 2).desc).toBe('5 条规则，「␣token」合成 1 个 token');
    expect(factsOf('bpe', 2).用上的规则).toBe('#0 #1 #2 #4 #5');
    expect(stepOf('bpe', 3).desc).toBe('6 条规则，4 个汉字还剩 6 个 token');
    expect(factsOf('bpe', 3)['「读」']).toBe('E8 AF | BB');
    expect(stepOf('bpe', 4).desc).toBe('7 个 int32，共 28 字节');
    expect(factsOf('bpe', 4)['token id']).toBe('[229, 164, 167, 283, 325, 187, 261]');
    expect(factsOf('bpe', 4).查表).toBe('126 次');
    expect(factsOf('bpe', 4).还原).toBe('和原文逐字节相同');
    expect(labels).toEqual(['E5', 'A4', 'A7', '模型', 'E8 AF', 'BB', '␣token']);
  });

  it('查表次数：每轮扫描所有相邻对，最后一轮扫完没有规则', () => {
    // 手算：18 个字节分成 12 + 6 两块，第一轮扫 11 + 5 = 16 对。
    expect(bpeRun.steps[0].lookups).toBe(16);
    // 最后一轮：剩下 6 + 1 个 token，扫 5 + 0 = 5 对。
    expect(bpeRun.lookups - bpeRun.steps[bpeRun.steps.length - 1].lookups).toBe(5);
    expect(stepOf('bpe', 4).detail).toContain('剩下的 5 个相邻对');
  });

  it('文案的说法成立', () => {
    // 「每个汉字占 3 个字节：第一个字节以 1110 开头」
    for (const char of '大模型读') {
      const bytes = utf8Encode(char);
      expect(bytes).toHaveLength(3);
      expect(bytes[0] >> 4).toBe(0b1110);
    }
    // 「␣t 这样的规则 rank 很靠前」：英文用上的第一条就是 rank 0。
    expect(stepOf('bpe', 2).detail).toContain('「␣t」');
    expect(bpeRun.steps[0].merge.rank).toBe(0);
    // 「模型在语料里出现了 7 次」：既是合并时的计数，也是语料里真实的出现次数。
    const modelCount = CORPUS.join('\n').split('模型').length - 1;
    expect(stepOf('bpe', 3).detail).toContain(`出现了 ${modelCount} 次`);
    expect(modelCount).toBe(7);
    // 「5 条规则把它的 6 个字节合成 1 个 token」
    expect(stepOf('bpe', 3).detail).toContain('5 条规则把它的 6 个字节合成 1 个 token');
    // 「中途合出的 E6 A8 A1 E5 跨过了字符边界」：模 的 3 个字节加上 型 的第一个字节。
    expect(crossBoundary.map((step) => T.label(step.merge.id))).toEqual(['A1 E5', 'A8 A1 E5', 'E6 A8 A1 E5']);
    expect(stepOf('bpe', 3).detail).toContain('中途合出的「E6 A8 A1 E5」跨过了字符边界');
    expect(T.bytesOf(widestCross.merge.id)).toEqual([...utf8Encode('模'), utf8Encode('型')[0]]);
    // 「读只合并了前两个字节，大一条规则都没用上」
    expect(T.bytesOf(bpeRun.ids[4])).toEqual(utf8Encode('读').slice(0, 2));
    expect(bpeRun.ids.slice(0, 3)).toEqual(utf8Encode('大'));
    expect(bpeRun.steps.every((step) => step.at.every((hit) => !(hit.chunk === 0 && hit.index < 3)))).toBe(true);
    // 「新 token 参与的规则总是学得更晚，所以用上的 rank 一路递增」
    bpeRun.steps.slice(1).forEach((step, i) => expect(step.merge.rank).toBeGreaterThan(bpeRun.steps[i].merge.rank));
  });

  it('中文更费 token：统计数字', () => {
    expect(corpusStats.en).toMatchObject({ chars: 803, tokens: 314 });
    expect(corpusStats.zh).toMatchObject({ chars: 118, tokens: 141 });
    expect(nonAsciiMerges).toBe(22);
    expect(factsOf('bpe', 5).英文语料).toBe('2.56 字 / token');
    expect(factsOf('bpe', 5).中文语料).toBe('0.84 字 / token');
    expect(factsOf('bpe', 5).中文规则).toBe('22 / 96 条');
    // 「这份语料英文多」
    expect(corpusStats.en.chars).toBeGreaterThan(corpusStats.zh.chars * 3);
    // 中文行每个 token 不到 1 个字，英文行超过 2 个。
    expect(corpusStats.zh.chars / corpusStats.zh.tokens).toBeLessThan(1);
    expect(corpusStats.en.chars / corpusStats.en.tokens).toBeGreaterThan(2);
  });

  it('概览和总结里的数字', () => {
    const lesson = LESSON_BY_ID.bpe;
    expect(lesson.overview.description).toContain(`「${INPUT}」`);
    expect(lesson.overview.description).toContain(`${CORPUS.length} 篇`);
    expect(Object.fromEntries(lesson.overview.facts).词表).toBe(`256 个字节 + 96 条合并 + 1 个结束符 = ${T.size}`);
    expect(T.size).toBe(353);
    expect(lesson.outro.desc).toBe(`「${INPUT}」变成 7 个 id`);
  });
});
