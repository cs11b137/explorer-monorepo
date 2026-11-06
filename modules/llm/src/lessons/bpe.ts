/**
 * 第一课：BPE 分词。真实执行 TOKENIZER.encodeTrace(INPUT)，每条用上的合并规则就是一个事件。
 * 文案里的数字全部取自 bpeRun 和下面的统计，tests/narrative.test.ts 核对。
 */
import { rawBytes, tokenIds, utf8Text, wire } from '../decode/structures';
import { CORPUS } from '@explorer/llm-core/corpus';
import { mergeEntry, TOKENIZER, type MergeApplication } from '@explorer/llm-core/tokenizer';
import { hex2, utf8Chars, utf8Encode } from '@explorer/llm-core/utf8';
import { cellsOf, shortLabel } from './common';
import { note, pk, show, state, type, render } from './dsl';
import type { DsCell, DsFrame, GridPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

const T = TOKENIZER;

/** 用户输入。改了它，narrative 测试会提示哪些说法不再成立。 */
export const INPUT = '大模型读 token';
export const bpeRun = T.encodeTrace(INPUT);

const BYTES = bpeRun.bytes.flat();
const CHARS = utf8Chars(INPUT);
/** 每个字节属于第几块。 */
const CHUNK_OF = bpeRun.bytes.flatMap((ids, chunk) => ids.map(() => chunk));
/** 每块第一个字节的下标。 */
const CHUNK_START = bpeRun.bytes.map((_, chunk) => CHUNK_OF.indexOf(chunk));
const HAN = /\p{Script=Han}/u;
/** 中文块和英文块。预分词把连续汉字切成一块。 */
const ZH = bpeRun.chunks.findIndex((chunk) => HAN.test(chunk));
const EN = bpeRun.chunks.findIndex((chunk) => !HAN.test(chunk));

/** 每个字节下面的小字：字符的第一个字节写字符本身，续字节不写。 */
const SUBS: string[] = CHARS.flatMap(({ char, bytes }) => bytes.map((_, i) => (i === 0 ? (char === ' ' ? '␣' : char) : '')));

/** 一组 token 对应的字节区间。 */
interface Span {
  chunk: number;
  id: number;
  from: number;
  to: number;
}

function spansOf(tokens: number[][]): Span[] {
  const out: Span[] = [];
  tokens.forEach((ids, chunk) => {
    let at = CHUNK_START[chunk];
    for (const id of ids) {
      const length = T.bytesOf(id).length;
      out.push({ chunk, id, from: at, to: at + length });
      at += length;
    }
  });
  return out;
}

/** 多字节 token 按块轮流上色，单字节 token 不上色：看颜色就知道哪些字节已经合在一起。 */
const CHUNK_TONES: Tone[][] = [['violet', 'amber'], ['blue', 'teal']];

function byteRow(tokens: number[][], hit?: Span): RowPrim {
  const tones: Record<number, Tone> = {};
  const counters = [0, 0];
  for (const span of spansOf(tokens)) {
    if (span.to - span.from < 2) continue;
    const palette = CHUNK_TONES[span.chunk === ZH ? 0 : 1];
    const tone = palette[counters[span.chunk]++ % 2];
    for (let i = span.from; i < span.to; i++) tones[i] = tone;
  }
  const lift = hit ? Array.from({ length: hit.to - hit.from }, (_, i) => hit.from + i) : [];
  return {
    kind: 'row',
    id: 'b',
    w: 34,
    cells: cellsOf(BYTES.map(hex2), { tones, lift, subs: SUBS }),
    marks: hit ? [{ at: hit.from, text: T.label(hit.id), color: hit.chunk === ZH ? 'violet' : 'blue' }] : undefined,
  };
}

const RULE_SUBS = ['左', '右', '合并成'];

function ruleRow(step?: MergeApplication): RowPrim {
  const values = step ? [shortLabel(step.merge.pair[0]), shortLabel(step.merge.pair[1]), shortLabel(step.merge.id)] : ['', '', ''];
  return { kind: 'row', id: 'r', w: 62, cells: cellsOf(values, { subs: step ? ['左', '右', `#${step.merge.rank}`] : RULE_SUBS, tones: step ? { 2: 'green' } : {} }) };
}

function idsRow(tones: Record<number, Tone> = {}, marks: RowPrim['marks'] = []): RowPrim {
  return { kind: 'row', id: 'i', w: 48, cells: cellsOf(bpeRun.ids, { subs: bpeRun.ids.map((id) => shortLabel(id, 6)), tones }), marks };
}

// ---------- 统计：文案里「中文更费 token」的依据 ----------

/** 语料里中文行和英文行各自的字符数、字节数、token 数。 */
export const corpusStats = (() => {
  const zero = () => ({ chars: 0, bytes: 0, tokens: 0, docs: 0 });
  const out = { en: zero(), zh: zero() };
  for (const doc of CORPUS) {
    const bucket = HAN.test(doc) ? out.zh : out.en;
    bucket.chars += [...doc].length;
    bucket.bytes += utf8Encode(doc).length;
    bucket.tokens += T.encode(doc).length;
    bucket.docs++;
  }
  return out;
})();

/** 合并表里有多少条规则合出的 token 含非 ASCII 字节（也就是在合并中文的字节）。 */
export const nonAsciiMerges = T.merges.filter((merge) => T.bytesOf(merge.id).some((byte) => byte >= 0x80)).length;

const zhIds = bpeRun.tokens[ZH];
const enIds = bpeRun.tokens[EN];
const zhChars = [...bpeRun.chunks[ZH]].length;
const enChars = [...bpeRun.chunks[EN]].length;
const ratio = (a: number, b: number) => (a / b).toFixed(2);

/** 每个字符第一个字节的下标，再加上末尾。 */
const CHAR_STARTS = new Set(CHARS.reduce<number[]>((list, item) => [...list, list[list.length - 1] + item.bytes.length], [0]));
/** 每个字节属于第几个字符。 */
const CHAR_OF = CHARS.flatMap((item, index) => item.bytes.map(() => index));

/** 跨字符边界的合并：合出的 token 含有两个字符的字节，并且至少一头切在字符中间。 */
export const crossBoundary = bpeRun.steps.filter((step) => {
  const span = spansOf(step.after).find((item) => item.id === step.merge.id)!;
  const twoChars = CHAR_OF[span.from] !== CHAR_OF[span.to - 1];
  return twoChars && (!CHAR_STARTS.has(span.from) || !CHAR_STARTS.has(span.to));
});
/** 其中最长的一个，文案里举它做例子。 */
export const widestCross = crossBoundary.reduce((best, step) => (T.bytesOf(step.merge.id).length > T.bytesOf(best.merge.id).length ? step : best));

// ---------- 事件 ----------

const mergeSteps = bpeRun.steps;
const enSteps = mergeSteps.filter((step) => step.at.every((hit) => hit.chunk === EN));
const zhSteps = mergeSteps.filter((step) => step.at.every((hit) => hit.chunk === ZH));
if (enSteps.length + zhSteps.length !== mergeSteps.length) throw new Error('bpe：有规则同时在两块里用上，需要改写步骤划分');
/** 合并开始前最后一轮扫描（发现没有规则）之前的查表数。 */
const lastMergeLookups = mergeSteps[mergeSteps.length - 1].lookups;
const finalScan = bpeRun.lookups - lastMergeLookups;

const merges = T.merges.length;
const firstMerges = T.merges.slice(0, 3);
const mergesJson = `[${firstMerges.map((merge) => JSON.stringify(mergeEntry(T, merge))).join(',')}`;

function mergeEvent(step: MergeApplication): LessonEvent[] {
  const span = spansOf(step.after).find((item) => item.id === step.merge.id && step.at.some((hit) => hit.chunk === item.chunk))!;
  const [a, b] = step.merge.pair;
  const entry = JSON.stringify(mergeEntry(T, step.merge));
  const ids = step.after.flat();
  const frame: DsFrame = { text: [byteRow(step.after, span)], vocab: [ruleRow(step)] };
  return [
    state('tokenizer', { 规则: `#${step.merge.rank}`, token: String(ids.length), 查表: String(step.lookups) }),
    pk('vocab', 'text', span.chunk === ZH ? 'violet' : 'blue', `#${step.merge.rank} 合并`, [`${T.label(a)} + ${T.label(b)}`, `→ ${T.label(step.merge.id)}`],
      [step.lookups, 'MERGE', `规则 #${step.merge.rank}：${T.label(a)} + ${T.label(b)} → token ${step.merge.id}「${T.label(step.merge.id)}」，训练语料里出现 ${step.merge.count} 次`, ids.length * 4],
      wire('合并规则和合并后的 token 序列', 'mem', 'format',
        utf8Text(`merges[${step.merge.rank}]`, entry, { color: 'green', summary: 'tokenizer.json 里的写法：GPT-2 字节映射，Ġ 是空格' }),
        tokenIds('ids', ids, { labels: (id) => T.label(id), summary: `合并后 ${ids.length} 个 token` })),
      { ds: frame }),
  ];
}

const finalSpans = spansOf(bpeRun.tokens);
const daSpan = finalSpans.filter((span) => span.from < CHARS[0].bytes.length);
const duIndex = CHARS.findIndex((item) => item.char === '读');
const duFrom = CHARS.slice(0, duIndex).reduce((sum, item) => sum + item.bytes.length, 0);
const duSpans = finalSpans.filter((span) => span.from >= duFrom && span.to <= duFrom + 3);
const modelToken = finalSpans.find((span) => T.label(span.id) === '模型')!;

const zhTokenIndex = (index: number) => index < zhIds.length;
const zhTone: Record<number, Tone> = Object.fromEntries(bpeRun.ids.map((_, i) => [i, zhTokenIndex(i) ? 'amber' : 'green']));

const statsGrid: GridPrim = {
  kind: 'grid',
  id: 's',
  w: 52,
  rows: ['英文', '中文'],
  cols: ['字', 'tok', '字/tok'],
  cells: [corpusStats.en, corpusStats.zh].map((item, r): DsCell[] => [
    { v: String(item.chars) },
    { v: String(item.tokens) },
    { v: ratio(item.chars, item.tokens), tone: r === 0 ? 'green' : 'amber' },
  ]),
};

const zhDoc = CORPUS.find((doc) => HAN.test(doc))!;
const zhDocIds = T.encode(zhDoc);

export const bpe: Lesson = {
  id: 'bpe',
  name: 'BPE TOKENIZER',
  title: 'BPE 分词',
  group: 'repr',
  layer: [1, 2],
  layerNote: '从 UTF-8 字节出发，按合并规则得到 token id。',
  opsUnit: '合并表查询次数：每一轮把所有相邻的 token 对拿去合并表里查一次 rank',
  opsShort: '次查表',
  nodes: ['client', 'tokenizer', 'text', 'vocab', 'tokens'],
  place: { client: [620, 60], tokenizer: [880, 320], text: [330, 300], vocab: [900, 80], tokens: [620, 580] },
  labels: {
    client: ['应用', 'encode(text)'],
    tokenizer: ['分词器', `字节级 BPE，${T.size} 个 token`],
    text: ['字节序列', '颜色相同的字节已合成一个 token'],
    vocab: ['合并表', `${merges} 条规则，按 rank 排序`],
    tokens: ['token id', 'int32 数组，交给模型'],
  },
  labelAt: { text: [-200, 20], vocab: [0, 112], tokens: [-190, 40] },
  radius: { text: 60, vocab: 50, tokens: 50 },
  initial: { text: [], vocab: [], tokens: [] },
  start: ['client', 'tokenizer', 'text'],
  legend: [['blue', '英文的合并'], ['violet', '中文的合并'], ['green', '合并出的新 token'], [null, '运算量：合并表查询次数']],
  overview: {
    full: '文本怎样变成模型能读的数字',
    description: `模型不认识文字，只认识 token id。这一课真实运行一个字节级 BPE 分词器：它在内置的 ${CORPUS.length} 篇中英文小语料上学了 ${merges} 条合并规则，现在把「${INPUT}」先变成 UTF-8 字节，再按规则一条条合并，最后得到 ${bpeRun.ids.length} 个 token id。你会看到同样多的字符，中文为什么要用掉更多 token。`,
    facts: [
      ['分词器', '字节级 BPE（GPT-2 / tiktoken 一类）'],
      ['词表', `256 个字节 + ${merges} 条合并 + 1 个结束符 = ${T.size}`],
      ['输入', `「${INPUT}」，${CHARS.length} 个字符`],
      ['字节', `${BYTES.length} 个（UTF-8）`],
      ['输出', `${bpeRun.ids.length} 个 token`],
      ['运算量', '合并表查询次数'],
    ],
  },
  steps: [
    {
      title: '文本变成字节',
      desc: `${CHARS.length} 个字符，${BYTES.length} 个字节`,
      detail: `分词器先把文本按 UTF-8 编码。英文字母和空格各占 1 个字节，每个汉字占 3 个字节：第一个字节以 1110 开头，说明后面还有 2 个续字节。字节级 BPE 的起点就是这 ${BYTES.length} 个字节，每个字节先当作一个 token，id 就是字节值 0–255，所以任何文本都能编码。`,
      facts: [['汉字', `${zhChars} 个 × 3 字节`], ['英文', `${enChars} 个字符 × 1 字节`], ['初始 token', `${BYTES.length} 个`]],
      events: [
        type(`encode("${INPUT}")`),
        pk('client', 'tokenizer', 'blue', 'encode()', [`"${INPUT}"`], [0, 'TEXT', `传入 ${CHARS.length} 个字符`, BYTES.length],
          wire('传给分词器的文本', 'mem', 'format', utf8Text('text', INPUT, { summary: `${CHARS.length} 个字符，UTF-8 编码` }))),
        pk('tokenizer', 'text', 'blue', 'UTF-8 字节', [`${BYTES.length} 个字节`, '每个字节一个 token'], [0, 'IDS', `${BYTES.length} 个字节，每个先当作一个 token，id = 字节值`, BYTES.length * 4],
          wire('初始 token 序列：id 就是字节值', 'mem', 'format', tokenIds('ids', BYTES, { labels: (id) => hex2(id), summary: '合并之前，token id 就是字节值' })),
          { ds: { text: [byteRow(bpeRun.bytes)] } }),
        note('text', '一个汉字 = 3 个字节', 'amber'),
      ],
    },
    {
      title: '预分词：切成块',
      desc: `切成 ${bpeRun.chunks.length} 块，块之间不合并`,
      detail: `合并之前先按空格、字母、汉字、标点切块，规则只在块内生效，这样「␣token」不会和前面的汉字粘在一起。本站把连续汉字单独成块，前导空格归下一个词，这也是 GPT-2 的做法。合并表按学到的先后排序，rank 越小越先用。`,
      facts: [['块', bpeRun.chunks.map((chunk) => `「${chunk.replace(/ /g, '␣')}」`).join(' ')], ['合并表', `${merges} 条规则`], ['rank 0', mergeEntry(T, T.merges[0])]],
      events: [
        pk('tokenizer', 'text', 'slate', '预分词', bpeRun.chunks.map((chunk) => `「${chunk.replace(/ /g, '␣')}」`), [0, 'TEXT', `切成 ${bpeRun.chunks.length} 块：${bpeRun.chunks.map((chunk) => `「${chunk}」`).join('、')}`, BYTES.length],
          wire('按块分组的字节', 'mem', 'format', rawBytes('chunks', BYTES, { groups: bpeRun.chunks.map((chunk, i) => ({ name: `块 ${i}「${chunk.replace(/ /g, '␣')}」`, bytes: bpeRun.bytes[i], note: `${bpeRun.bytes[i].length} 个字节，只在这一块里找可合并的相邻对。` })) })),
          { ds: { text: [{ ...byteRow(bpeRun.bytes), marks: bpeRun.chunks.map((_, i) => ({ at: CHUNK_START[i], text: `块 ${i}`, color: i === ZH ? 'violet' : 'blue' })) }] } }),
        show('vocab'),
        pk('tokenizer', 'vocab', 'green', '读合并表', [`${merges} 条规则`], [0, 'LOOKUP', `合并表有 ${merges} 条规则，按 rank 排序；开头几条是 ${firstMerges.map((merge) => mergeEntry(T, merge)).join('、')}`, utf8Encode(mergesJson).length],
          wire('tokenizer.json 里 merges 数组的开头', 'mem', 'format', utf8Text('merges', mergesJson, { color: 'green', summary: 'GPT-2 字节映射：Ġ 是空格 0x20' })),
          { ds: { vocab: [ruleRow()] } }),
      ],
    },
    {
      title: '英文：合并成整词',
      desc: `${enSteps.length} 条规则，「${bpeRun.chunks[EN].replace(/ /g, '␣')}」合成 1 个 token`,
      detail: `每一轮把所有相邻对拿去合并表里查 rank，用 rank 最小的那条，把它的所有出现都合并。英文在语料里出现得多，「${T.label(enSteps[0].merge.id)}」这样的规则 rank 很靠前，${enSteps.length} 轮之后「${bpeRun.chunks[EN].replace(/ /g, '␣')}」的 ${bpeRun.bytes[EN].length} 个字节变成了 1 个 token。新 token 参与的规则总是学得更晚，所以用上的 rank 一路递增。`,
      facts: [['用上的规则', enSteps.map((step) => `#${step.merge.rank}`).join(' ')], ['字节', `${bpeRun.bytes[EN].length} → ${enIds.length} 个 token`], ['累计查表', String(enSteps[enSteps.length - 1].lookups)]],
      events: [show('tokens'), ...enSteps.flatMap(mergeEvent)],
    },
    {
      title: '中文：只合出一部分',
      desc: `${zhSteps.length} 条规则，${zhChars} 个汉字还剩 ${zhIds.length} 个 token`,
      detail: `「模型」在语料里出现了 ${zhSteps.find((step) => step.merge.id === modelToken.id)!.merge.count} 次，${zhSteps.filter((step) => step.merge.rank <= T.merges.findIndex((merge) => merge.id === modelToken.id)).length} 条规则把它的 ${modelToken.to - modelToken.from} 个字节合成 1 个 token；中途合出的「${T.label(widestCross.merge.id)}」跨过了字符边界，BPE 只看字节，不在乎一个字是否完整。「读」只合并了前两个字节，「大」一条规则都没用上，仍是 ${daSpan.length} 个单字节 token。`,
      facts: [['用上的规则', zhSteps.map((step) => `#${step.merge.rank}`).join(' ')], ['「大」', `${daSpan.length} 个 token`], ['「读」', duSpans.map((span) => T.label(span.id)).join(' | ')], ['「模型」', '1 个 token']],
      events: zhSteps.flatMap(mergeEvent),
    },
    {
      title: '得到 token id',
      desc: `${bpeRun.ids.length} 个 int32，共 ${bpeRun.ids.length * 4} 字节`,
      detail: `再扫一轮，剩下的 ${finalScan} 个相邻对都不在合并表里，合并结束，整个过程查了 ${bpeRun.lookups} 次表。encode 返回的就是这串 id，llama.cpp 把它存成 int32 数组交给模型。解码时把每个 id 的字节拼回去，再按 UTF-8 解码，就得到原文。`,
      facts: [['token id', `[${bpeRun.ids.join(', ')}]`], ['查表', `${bpeRun.lookups} 次`], ['还原', T.decode(bpeRun.ids) === INPUT ? '和原文逐字节相同' : '不一致']],
      events: [
        state('tokenizer', { 规则: '无', token: String(bpeRun.ids.length), 查表: String(bpeRun.lookups) }),
        pk('tokenizer', 'tokens', 'green', 'input_ids', [`${bpeRun.ids.length} 个 token`], [bpeRun.lookups, 'IDS', `最后一轮查 ${finalScan} 对，没有可用规则；输出 [${bpeRun.ids.join(', ')}]`, bpeRun.ids.length * 4],
          wire('encode 的返回值', 'mem', 'format', tokenIds('input_ids', bpeRun.ids, { labels: (id) => T.label(id), summary: 'llama_token 是 int32_t，小端' })),
          { ds: { text: [byteRow(bpeRun.tokens)], tokens: [idsRow()] } }),
        pk('tokenizer', 'client', 'green', `${bpeRun.ids.length} 个 id`, [`[${bpeRun.ids.join(', ')}]`], [bpeRun.lookups, 'IDS', `返回 ${bpeRun.ids.length} 个 token id`, bpeRun.ids.length * 4],
          wire('返回给应用的 token id', 'mem', 'format', tokenIds('ids', bpeRun.ids, { labels: (id) => T.label(id) })),
          { ds: { vocab: [ruleRow()] } }),
        render,
      ],
    },
    {
      title: '中文为什么更费 token',
      desc: `${zhChars} 个汉字 ${zhIds.length} 个 token，${enChars} 个英文字符 ${enIds.length} 个`,
      detail: `UTF-8 让每个汉字从 3 个字节起步，合并要先把这 3 个字节凑齐才可能变成 1 个 token。这份语料英文多，${merges} 条规则里只有 ${nonAsciiMerges} 条在合并中文字节，所以英文平均每个 token ${ratio(corpusStats.en.chars, corpusStats.en.tokens)} 个字符，中文行只有 ${ratio(corpusStats.zh.chars, corpusStats.zh.tokens)} 个。按 token 计费、按 token 算上下文长度时，同样的内容写成中文会更贵、更快占满窗口。`,
      facts: [['英文语料', `${ratio(corpusStats.en.chars, corpusStats.en.tokens)} 字 / token`], ['中文语料', `${ratio(corpusStats.zh.chars, corpusStats.zh.tokens)} 字 / token`], ['中文规则', `${nonAsciiMerges} / ${merges} 条`]],
      events: [
        pk('tokenizer', 'tokens', 'amber', '数一数', [`中文 ${zhChars} 字 → ${zhIds.length} 个`, `英文 ${enChars} 字 → ${enIds.length} 个`], [bpeRun.lookups, 'IDS', `「${bpeRun.chunks[ZH]}」${zhChars} 个字用了 ${zhIds.length} 个 token，「${bpeRun.chunks[EN]}」${enChars} 个字符用了 ${enIds.length} 个`, zhIds.length * 4],
          wire('中文部分：字节和 token', 'mem', 'format', utf8Text(bpeRun.chunks[ZH], bpeRun.chunks[ZH], { color: 'amber' }), tokenIds('ids', zhIds, { color: 'amber', labels: (id) => T.label(id) })),
          { ds: { tokens: [idsRow(zhTone, [{ at: 0, text: `中文 ${zhIds.length} 个`, color: 'amber' }, { at: zhIds.length, text: `英文 ${enIds.length} 个`, color: 'green', dx: 38 }])] } }),
        pk('vocab', 'tokenizer', 'amber', '语料统计', [`英文 ${ratio(corpusStats.en.chars, corpusStats.en.tokens)} 字/token`, `中文 ${ratio(corpusStats.zh.chars, corpusStats.zh.tokens)} 字/token`], [bpeRun.lookups, 'IDS', `训练语料：英文 ${corpusStats.en.chars} 字 ${corpusStats.en.tokens} 个 token，中文 ${corpusStats.zh.chars} 字 ${corpusStats.zh.tokens} 个 token`, zhDocIds.length * 4],
          wire('一行中文语料编码后的样子', 'mem', 'format', tokenIds('ids', zhDocIds, { color: 'amber', labels: (id) => T.label(id), summary: `「${zhDoc}」${[...zhDoc].length} 个字符 → ${zhDocIds.length} 个 token` })),
          { ds: { vocab: [statsGrid] } }),
        note('vocab', `${nonAsciiMerges} / ${merges} 条规则合并中文字节`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '模型看到的是数字',
    desc: `「${INPUT}」变成 ${bpeRun.ids.length} 个 id`,
    text: `真实的分词器原理相同，只是规模大得多：GPT-2 有 50000 条合并规则，cl100k 和 Llama 3 的词表都在十万量级，训练语料里的中文也多得多，很多常用汉字能合成 1 个 token。但「每个汉字从 3 个字节起步」不会变，罕见字仍会被拆成多个 token，所以同样的意思写成中文，往往要多用一些 token。`,
    facts: [['输出', `${bpeRun.ids.length} 个 token`], ['查表', `${bpeRun.lookups} 次`], ['下一课', '嵌入查表与 RoPE']],
  },
};
