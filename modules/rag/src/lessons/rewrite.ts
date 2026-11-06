/**
 * 流水线组第四课：失败案例与查询改写。先用真实检索找出三种失败：已作废的旧版文档排第一（靠元数据前过滤修好）、
 * 答案被固定长度切分拦腰切断（靠重叠修好）、口语化又指代不清的问题检索不到（靠查询改写修好）；
 * 再演示三种改写：结合对话历史改写成独立的问题、多查询扩展加 RRF 融合、HyDE（先写一段假设的回答再拿它去检索）。
 *
 * 检索、过滤、切分、融合、召回全部由 core/ 实时计算。改写出来的查询和 HyDE 的假设回答是模型写的，本站不跑大模型，
 * 写死在下面并标 E.G.；但拿它们去检索的结果是真算的。tests/narrative.pipeline-b.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  countTokens,
  DistanceMeter,
  docText,
  embed,
  embedVector,
  filteredSearch,
  fixedChunks,
  flatSearch,
  KB,
  ORDER_ID,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  rankedOf,
  retrievalRecall,
  rrf,
  type EmbedTrace,
  type FusedDoc,
  type Hit,
  type Vec,
} from '../core';
import { chunkBytes, concept, floatVector, num, utf8Lines, utf8Text, wire } from '../decode/structures';
import type { LayerWriter } from '../decode/writer';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 失败一：已作废的旧版文档 ----------

/** 问到账时间：现行《退款说明》写银行卡 3–7 个工作日，已作废的 2025 版写 7–15 个工作日。 */
export const Q_BANK = '退到银行卡要多久？';
export const K = 3;

export const meter = new DistanceMeter();
const qBank = embed(Q_BANK);

/** 不过滤：27 个段落全部比较。 */
export const plain = flatSearch(PARAGRAPH_VECTORS, qBank.vector, K, 'ip', meter);
export const dist1 = meter.total;

const isCurrent = (i: number): boolean => PARAGRAPHS[i].meta.status === 'current';
/** 前过滤：只在现行文档里搜。 */
export const filtered = filteredSearch(PARAGRAPH_VECTORS, qBank.vector, K, isCurrent, 'pre', 'ip', meter);
export const dist2 = meter.total;

const pid = (i: number): string => PARAGRAPHS[i].id;
export const OLD = PARAGRAPHS.findIndex((p) => p.id === 'refund-2025#0');
export const NEW = PARAGRAPHS.findIndex((p) => p.id === 'refund#0');

// ---------- 失败二：答案被切在两块之间 ----------

export const CHUNK_SIZE = 32;
export const OVERLAP = 8;
/** 答案的完整说法：在原文里是连着的。 */
export const BANK_FACT = '银行卡 3–7 个工作日';

interface KbChunk {
  id: string;
  doc: string;
  index: number;
  text: string;
  current: boolean;
}

/** 整个知识库按固定长度切：每篇文档单独切（段落之间换行），块 id 写成 文档 id@序号。 */
function chunkKb(size: number, overlap: number): { chunks: KbChunk[]; vectors: Vec[] } {
  const chunks = KB.flatMap((doc) => fixedChunks(docText(doc), size, overlap).map((c): KbChunk => ({ id: `${doc.id}@${c.index}`, doc: doc.id, index: c.index, text: c.text, current: doc.meta.status === 'current' })));
  return { chunks, vectors: chunks.map((c) => embedVector(c.text)) };
}

export const cut = chunkKb(CHUNK_SIZE, 0);
export const cutSearch = filteredSearch(cut.vectors, qBank.vector, K, (i) => cut.chunks[i].current, 'pre', 'ip', meter);
export const dist3a = meter.total;
export const lap = chunkKb(CHUNK_SIZE, OVERLAP);
export const lapSearch = filteredSearch(lap.vectors, qBank.vector, K, (i) => lap.chunks[i].current, 'pre', 'ip', meter);
export const dist3b = meter.total;

const REFUND_TEXT = docText(KB.find((doc) => doc.id === 'refund')!);
export const refundCut = fixedChunks(REFUND_TEXT, CHUNK_SIZE);
export const refundLap = fixedChunks(REFUND_TEXT, CHUNK_SIZE, OVERLAP);
const flat = (text: string) => text.replace(/\s+/g, '');
/** 有没有哪一块完整地含有答案。 */
export const whole = (chunks: readonly { text: string }[]): number => chunks.findIndex((c) => flat(c.text).includes(flat(BANK_FACT)));

// ---------- 失败三：口语化、指代不清 ----------

/** 对话历史（和 CONTEXT EXPLORER 客服 Agent 的那段对话一致，助手的话是示例）。 */
export const HISTORY = [
  `用户：你好，我上周买的保温杯还没到，订单号 ${ORDER_ID}。`,
  '助手：已经发货了：顺丰承运，预计 11 月 8 日送到。',
  '用户：收到了，可是杯盖有点漏水。',
];
export const Q_VAGUE = '那个杯子怎么退货？';
/** 本课的标注：回答「漏水的杯子怎么退」要用到的段落：质量问题可退（第 3 条）和申请流程（第 4 条）。 */
export const RELEVANT = ['aftersale#2', 'aftersale#3'];

const search = (text: string, k = K) => filteredSearch(PARAGRAPH_VECTORS, embedVector(text), k, isCurrent, 'pre', 'ip', meter);
const idsOf = (hits: readonly Hit[]): string[] => hits.map((hit) => pid(hit.id));

const qVague = embed(Q_VAGUE);
export const vague = search(Q_VAGUE);
export const dist4 = meter.total;

// ---------- 改写（模型写的，E.G.） ----------

export const REWRITE_INSTRUCTION = '根据对话历史，把用户最后一句改写成一个能单独看懂的检索查询，只输出查询。';
export const REWRITE_PROMPT = [REWRITE_INSTRUCTION, '', ...HISTORY, `用户：${Q_VAGUE}`].join('\n');
/** 改写结果：示例（E.G.）。把「那个杯子」换成保温杯、补上「杯盖漏水」「质量问题」。 */
export const REWRITTEN = '杯盖漏水的保温杯，质量问题怎么申请退货？';
const qRewritten = embed(REWRITTEN);
export const rewritten = search(REWRITTEN);
export const dist5 = meter.total;

/** 多查询扩展：模型从三个角度各写一个子问题（示例，E.G.），每个取前 5，RRF 融合。 */
export const SUBQUERIES = ['保温杯杯盖漏水算质量问题吗？', '质量问题退货运费谁出？', '申请售后要先做什么？'];
export const MULTI_K = 5;
export const subSearches = SUBQUERIES.map((q) => search(q, MULTI_K));
export const fused: FusedDoc[] = rrf(subSearches.map((s) => rankedOf(s.hits, pid)));
export const dist6a = meter.total;

/** HyDE：模型先写一段「假设的回答」（示例，E.G.），故意带一个编错的数：规则是 7 天，这里写成 30 天。 */
export const HYDE = '杯盖漏水属于质量问题，签收后 30 天内都可以退货，先拍照上传，客服确认后寄回，运费由店铺承担。';
const qHyde = embed(HYDE);
export const hyde = search(HYDE);
export const dist6b = meter.total;

export const recall = {
  vague: retrievalRecall(idsOf(vague.hits), RELEVANT),
  rewritten: retrievalRecall(idsOf(rewritten.hits), RELEVANT),
  multi: retrievalRecall(fused.slice(0, K).map((d) => d.id), RELEVANT),
  hyde: retrievalRecall(idsOf(hyde.hits), RELEVANT),
};

// ---------- 文案用到的数 ----------

const termsKnown = (t: EmbedTrace) => t.known.map((hit) => hit.term);
export const numbers = {
  paragraphs: PARAGRAPHS.length,
  current: filtered.allowed.length,
  oldScore: plain.scores[OLD],
  newScore: plain.scores[NEW],
  cutChunks: cut.chunks.length,
  cutCurrent: cutSearch.allowed.length,
  lapChunks: lap.chunks.length,
  lapCurrent: lapSearch.allowed.length,
  vagueTerms: qVague.terms.length,
  vagueKnown: termsKnown(qVague),
  rewrittenKnown: qRewritten.known.length,
  rewritePromptTokens: countTokens(REWRITE_PROMPT),
  rewriteTokens: countTokens(REWRITTEN),
  hydeTerms: qHyde.terms.length,
  hydeKnown: qHyde.known.length,
  /** 假设回答里编错的数在不在词表里。 */
  hydeWrongKnown: qHyde.known.some((hit) => hit.term === '30'),
};
const N = numbers;

const bare = (q: string): string => q.replace(/？$/, '');
const s3 = (x: number): string => fixed(x, 3);
const pctOf = (r: { score: number }) => `${Math.round(r.score * 100)}%`;

/** 段落和块的短名字（格子里放得下）。 */
const SHORT: Record<string, string> = { aftersale: '售后', refund: '退款', 'refund-2025': '旧退款', 'shipping-fee': '运费', delivery: '配送', cup: '保温杯', kettle: '水壶', warranty: '保修', invoice: '发票', points: '积分', coupon: '优惠券', contact: '客服' };
export const shortOf = (id: string): string => {
  const [doc, rest] = id.split(/(?=[#@])/);
  return `${SHORT[doc] ?? doc}${rest}`;
};

// ---------- 图元 ----------

/** 查询切出来的词：认识的蓝色，不认识的变暗。 */
function termRow(trace: EmbedTrace, key: string, max = 8): RowPrim {
  const known = new Set(trace.known.map((hit) => hit.term));
  const terms = trace.terms.slice(0, max);
  return {
    kind: 'row',
    id: 'q',
    w: 40,
    cells: terms.map((term, i): DsCell => ({ v: term, tone: known.has(term) ? PART_TONE.query : 'dim', key: `${key}${i}` })),
  };
}

const queryList = (labels: string[], key: string): RowPrim => ({
  kind: 'row',
  id: 'q',
  w: 78,
  cells: labels.map((v, i): DsCell => ({ v, tone: PART_TONE.query, key: `${key}${i}`, sub: key === 'm' ? `子问题 ${i + 1}` : '假设回答' })),
});

/** 检索结果：已作废的变暗，标注相关的抬高。 */
function resultRow(entries: Array<{ id: string; score: string; archived?: boolean }>, marks?: RowPrim['marks'], relevant: readonly string[] = []): RowPrim {
  return {
    kind: 'row',
    id: 'r',
    w: 80,
    cells: entries.map((e): DsCell => ({ v: shortOf(e.id), sub: e.score, tone: e.archived ? 'dim' : PART_TONE.result, key: e.id, lift: relevant.includes(e.id) || undefined })),
    marks,
  };
}

const hitsRow = (hits: readonly Hit[], ids: (i: number) => string, archived: (i: number) => boolean, marks?: RowPrim['marks'], relevant: readonly string[] = []): RowPrim =>
  resultRow(hits.map((hit) => ({ id: ids(hit.id), score: s3(hit.score), archived: archived(hit.id) })), marks, relevant);

/** 《退款说明》切成的块。 */
function chunkRow(chunks: ReturnType<typeof fixedChunks>, key: string, marks?: RowPrim['marks']): RowPrim {
  const at = whole(chunks);
  return {
    kind: 'row',
    id: 'c',
    w: 62,
    cells: chunks.map((c, i): DsCell => ({ v: `块 ${i}`, sub: `${c.to - c.from} 字`, tone: i === at ? 'green' : PART_TONE.doc, key: `${key}${i}` })),
    marks,
    title: `《退款说明》${CHUNK_SIZE} 字一块${key === 'o' ? `，重叠 ${OVERLAP}` : ''}`,
  };
}

const ROWS = ['原问题', '改写', '多查询', 'HyDE'] as const;
function recallGrid(upto: number): GridPrim {
  const list = [recall.vague, recall.rewritten, recall.multi, recall.hyde];
  return {
    kind: 'grid',
    id: 's',
    w: 60,
    rows: [...ROWS],
    cols: ['找到', '召回'],
    cells: list.map((r, i): DsCell[] => (i < upto ? [{ v: `${r.found.length} / ${RELEVANT.length}`, tone: 'green', heat: r.score }, { v: pctOf(r), tone: r.score === 1 ? 'green' : 'amber', heat: r.score }] : [{ v: '', tone: 'empty' }, { v: '', tone: 'empty' }])),
  };
}

// ---------- 字节 ----------

/** 模型写的文字：每行一个字段，标 E.G.。 */
function exampleLines(name: string, text: string, summary: string): LayerWriter {
  const layer = utf8Lines(name, text, { color: 'green', summary });
  layer.fields.forEach((field) => (field.example = true));
  return layer;
}

const hitsConcept = (title: string, hits: readonly Hit[], ids: (i: number) => string, text: (i: number) => string, extra: (i: number) => string = () => '') =>
  concept(title, hits.map((hit, rank): [string, string, string] => [`${rank + 1} · ${ids(hit.id)}`, num(hit.score, 4), `${extra(hit.id)}「${text(hit.id)}」`]), 'amber');

const paraText = (i: number) => PARAGRAPHS[i].text;
const archivedNote = (i: number) => (isCurrent(i) ? '' : '已作废（status: archived）。');

// ---------- 课程 ----------

const oldP = PARAGRAPHS[OLD];
const cutTop = cutSearch.hits[0];
const cutNext = cutSearch.hits.find((hit) => cut.chunks[hit.id].id === 'refund@1')!;
const lapNext = lapSearch.hits.find((hit) => lap.chunks[hit.id].id === 'refund@1')!;
const cutRank = cutSearch.hits.indexOf(cutNext) + 1;

export const rewrite: Lesson = {
  id: 'rewrite',
  name: 'QUERY REWRITE',
  title: '失败案例与查询改写',
  group: 'pipeline',
  layer: [2, 6],
  layerNote: '失败出在不同的档：旧版本是文档的元数据，答案被切开是分块，问题说不清是查询；改写查询要让大模型读对话历史，用到「提示」这一档。',
  distNote: `每次检索都是暴力搜索：不过滤比 ${N.paragraphs} 个段落，前过滤比 ${N.current} 个，按块检索比 ${N.cutCurrent} 和 ${N.lapCurrent} 个块，多查询三个子问题各比一遍，一共 ${meter.total} 次。`,
  nodes: ['app', 'llm', 'query', 'index', 'meta', 'results', 'chunker', 'chunks', 'scores'],
  place: { app: [100, 130], llm: [100, 560], query: [500, 350], index: [720, 120], meta: [1060, 120], results: [730, 390], chunker: [1120, 500], chunks: [930, 700], scores: [380, 700] },
  labels: {
    app: ['客服 Agent', 'search_docs'],
    llm: ['大模型', '改写查询（示例）'],
    query: ['查询', '切出来的词'],
    index: ['向量库', '暴力搜索，取前 3'],
    meta: ['元数据过滤', '前过滤'],
    results: ['检索结果', '前 3 个和分数'],
    chunker: ['切分器', '固定长度'],
    chunks: ['块', '《退款说明》'],
    scores: ['召回', `标注的 ${RELEVANT.length} 段找到几段`],
  },
  labelAt: { query: [-40, 80], results: [0, 95], chunks: [0, 95], scores: [-290, 70] },
  radius: { query: 70, results: 70, chunks: 70, scores: 70 },
  initial: { query: [], results: [], chunks: [], scores: [] },
  start: ['app', 'index'],
  legend: [['blue', '查询和认识的词'], ['amber', '检索结果'], ['teal', '块'], ['green', '模型写的（示例）和召回'], [null, '距离列：累计比较过几次向量']],
  overview: {
    full: '检索没找到，答案就不会对',
    description: `检索增强的回答最多和检索结果一样好。这一课用真实的检索找出三种常见失败：已作废的旧版《退款说明》排在第一，答案被固定长度的切分拦腰切断，用户一句「${bare(Q_VAGUE)}」检索不到该找的段落；再看三种查询改写怎样把它找回来：结合对话历史改写、拆成多个子问题再融合、先写一段假设的回答（HyDE）再拿它去检索。`,
    facts: [
      ['旧版本', `${s3(N.oldScore)} 对 ${s3(N.newScore)}，排第一`],
      ['口语化', `${N.vagueTerms} 个词只认识 ${N.vagueKnown.length} 个，召回 ${pctOf(recall.vague)}`],
      ['改写后', `召回 ${pctOf(recall.rewritten)}`],
      ['HyDE', 'Gao 等，ACL 2023'],
      ['距离计算', `共 ${meter.total} 次`],
    ],
  },
  steps: [
    {
      title: '旧版本排在第一',
      desc: `已作废的 2025 版 ${s3(N.oldScore)}，现行版 ${s3(N.newScore)}`,
      detail: `用户问「${bare(Q_BANK)}」，向量库把 ${N.paragraphs} 个段落全比一遍，排第一的是已作废的《退款说明（2025 版）》，现行版本只差 ${num(N.oldScore - N.newScore, 4)} 排第二。两段除了标题里的「2025 版」，只有到账天数不一样，向量分不出新旧。模型读到「银行卡 7–15 个工作日」和「3–7 个工作日」两种说法，很可能答错。`,
      facts: [['第 1', `${shortOf(pid(plain.hits[0].id))}（已作废）${s3(plain.hits[0].score)}`], ['第 2', `${shortOf(pid(plain.hits[1].id))} ${s3(plain.hits[1].score)}`], ['比较', `${plain.computed} 次`]],
      events: [
        type(`search_docs("${Q_BANK}")`),
        show('query'),
        pk('app', 'query', 'blue', '嵌入问题', [Q_BANK, `${qBank.known.length} 个词认识`], [0, 'EMBED', `「${Q_BANK}」切成 ${qBank.terms.length} 个词，认识 ${qBank.known.map((h) => h.term).join('、')}，嵌入成 16 维向量`, utf8Encode(Q_BANK).length],
          wire('检索查询', 'mem', 'format', utf8Text('query', Q_BANK, { summary: `${[...Q_BANK].length} 个字符` }), floatVector('查询向量', qBank.vector, 'f32', { color: 'blue', summary: '归一化后的 16 维 float32', digits: 3 })),
          { ds: { query: [termRow(qBank, 'b')] } }),
        pk('query', 'index', 'blue', '查询向量', [`${qBank.vector.length} 维`, `取前 ${K}`], [0, 'VECTOR', `查询向量送进向量库，k = ${K}，不带过滤条件`, qBank.vector.length * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', qBank.vector, 'f32', { color: 'blue', digits: 3 }))),
        show('results'),
        pk('index', 'results', 'amber', `前 ${K} 个`, idsOf(plain.hits).map((id, i) => `${shortOf(id)} ${s3(plain.hits[i].score)}`), [dist1, 'SEARCH', `暴力搜索 ${plain.computed} 个段落：第一是已作废的 ${oldP.id}（${num(N.oldScore, 4)}），现行的 refund#0 第二（${num(N.newScore, 4)}）`, null],
          wire('检索结果（向量库内部的排序）', 'mem', '示意', hitsConcept('前 3 个', plain.hits, pid, paraText, archivedNote)),
          { ds: { results: [hitsRow(plain.hits, pid, (i) => !isCurrent(i), [{ at: 0, text: '已作废', color: 'amber' }])] } }),
        note('results', '新旧两版只差到账天数', 'amber'),
      ],
    },
    {
      title: '按元数据前过滤',
      desc: `只搜现行文档：${N.current} / ${N.paragraphs} 个段落`,
      detail: `每篇文档都带元数据，旧版本的 status 是 archived，它没有被删掉，所以照样能被检索到。前过滤先按 status = current 筛掉它，再在剩下的 ${N.current} 个段落里做向量搜索，第一名变成现行的《退款说明》。过时的规则、别的商品、别的地区，这类「意思对但不该用」的段落都只能靠元数据挡住，向量相似度管不了。`,
      facts: [['条件', 'status = current'], ['候选', `${N.current} 个段落`], ['第 1', `${shortOf(pid(filtered.hits[0].id))} ${s3(filtered.hits[0].score)}`]],
      events: [
        show('meta'),
        state('meta', { 条件: 'status = current', 通过: `${N.current} / ${N.paragraphs}` }),
        pk('meta', 'index', 'slate', '候选 id', [`${N.current} 个段落`, `去掉 ${oldP.id}`], [dist1, 'FILTER', `按 status = current 前过滤，剩 ${N.current} 个段落，已作废的 ${oldP.id} 不进候选`, null],
          wire('元数据过滤', 'mem', '示意', concept('条件和候选', [['条件', 'status = current', '只要现行版本。'], ['通过', `${N.current} 个`, '向量搜索只在这些段落里做。'], ['挡掉', oldP.id, `《退款说明（2025 版）》，更新于 ${oldP.meta.updated}，status = archived。`]], 'slate'))),
        pk('index', 'results', 'amber', `前 ${K} 个`, idsOf(filtered.hits).map((id, i) => `${shortOf(id)} ${s3(filtered.hits[i].score)}`), [dist2, 'SEARCH', `在 ${filtered.computed} 个现行段落里暴力搜索，第一是 refund#0（${num(filtered.hits[0].score, 4)}）`, null],
          wire('过滤后的检索结果', 'mem', '示意', hitsConcept('前 3 个', filtered.hits, pid, paraText)),
          { ds: { results: [hitsRow(filtered.hits, pid, () => false, [{ at: 0, text: '现行版', color: 'green' }])] } }),
      ],
    },
    {
      title: '答案被切在两块之间',
      desc: `第一块停在「银行卡」，天数在下一块`,
      detail: `换成按 ${CHUNK_SIZE} 个字一块的固定长度切分，知识库变成 ${N.cutChunks} 块，《退款说明》的第一块正好在「银行卡」后面断开，「3–7 个工作日」落到下一块的开头。下一块没有「银行卡」这个词，分数只有 ${s3(cutNext.score)}，排第 ${cutRank}；排第一的块（${s3(cutTop.score)}）有问题里的词，却没有答案。改成相邻两块重叠 ${OVERLAP} 个字，下一块从「作日到账，银行卡」开始，完整地含有「${BANK_FACT}」，分数升到 ${s3(lapNext.score)}。`,
      facts: [['不重叠', `${N.cutChunks} 块，答案被切开`], [`重叠 ${OVERLAP} 字`, `${N.lapChunks} 块，refund@1 完整`], ['refund@1', `${s3(cutNext.score)} → ${s3(lapNext.score)}`]],
      events: [
        show('chunker', 'chunks'),
        state('chunker', { 长度: `${CHUNK_SIZE} 字`, 重叠: '0' }),
        pk('chunker', 'chunks', 'teal', `${refundCut.length} 块`, refundCut.slice(0, 2).map((c) => c.text.slice(-8)), [dist2, 'CHUNK', `《退款说明》${[...REFUND_TEXT].length} 个字按 ${CHUNK_SIZE} 字切成 ${refundCut.length} 块，第 0 块在「银行卡」后断开`, utf8Encode(REFUND_TEXT).length],
          wire('《退款说明》按固定长度切分', 'mem', 'format', chunkBytes('退款说明', REFUND_TEXT, refundCut)),
          { ds: { chunks: [chunkRow(refundCut, 'c', [{ at: 0, text: '在「银行卡」后断开', color: 'amber' }])] } }),
        pk('chunker', 'index', 'teal', `${N.cutChunks} 块入库`, [`现行 ${N.cutCurrent} 块`], [dist2, 'INDEX', `整个知识库切成 ${N.cutChunks} 块，各自嵌入后入库（重建索引不比较向量）`, N.cutChunks * 64],
          wire('入库的块', 'mem', '示意', concept('块', [['块数', String(N.cutChunks), `每篇文档单独按 ${CHUNK_SIZE} 字切。`], ['现行', String(N.cutCurrent), '过滤条件仍然是 status = current。']], 'teal'))),
        pk('index', 'results', 'amber', `前 ${K} 块`, cutSearch.hits.map((hit) => `${shortOf(cut.chunks[hit.id].id)} ${s3(hit.score)}`), [dist3a, 'SEARCH', `在 ${cutSearch.computed} 个现行块里搜：第一块止于「银行卡」，含「3–7 个工作日」的 refund@1 只有 ${num(cutNext.score, 4)}`, null],
          wire('按块检索的结果', 'mem', '示意', hitsConcept('前 3 块', cutSearch.hits, (i) => cut.chunks[i].id, (i) => cut.chunks[i].text)),
          { ds: { results: [hitsRow(cutSearch.hits, (i) => cut.chunks[i].id, () => false, [{ at: 0, text: '没有天数', color: 'amber' }])] } }),
        state('chunker', { 长度: `${CHUNK_SIZE} 字`, 重叠: `${OVERLAP} 字` }),
        pk('chunker', 'chunks', 'teal', `重叠 ${OVERLAP} 字`, [`${refundLap.length} 块`, refundLap[1].text.slice(0, 12)], [dist3a, 'CHUNK', `步长 ${CHUNK_SIZE - OVERLAP} 字，${refundLap.length} 块；第 1 块完整含有「${BANK_FACT}」`, utf8Encode(REFUND_TEXT).length],
          wire('重叠切分', 'mem', 'format', chunkBytes('退款说明', REFUND_TEXT, refundLap)),
          { ds: { chunks: [chunkRow(refundLap, 'o', [{ at: whole(refundLap), text: '答案完整', color: 'green' }])] } }),
        pk('index', 'results', 'amber', `前 ${K} 块`, lapSearch.hits.map((hit) => `${shortOf(lap.chunks[hit.id].id)} ${s3(hit.score)}`), [dist3b, 'SEARCH', `重建后 ${N.lapChunks} 块，在 ${lapSearch.computed} 个现行块里搜，refund@1 升到 ${num(lapNext.score, 4)}`, null],
          wire('重叠切分后的检索结果', 'mem', '示意', hitsConcept('前 3 块', lapSearch.hits, (i) => lap.chunks[i].id, (i) => lap.chunks[i].text)),
          { ds: { results: [hitsRow(lapSearch.hits, (i) => lap.chunks[i].id, () => false, [{ at: lapSearch.hits.indexOf(lapNext), text: '答案完整', color: 'green' }])] } }),
      ],
    },
    {
      title: '说不清的问题',
      desc: `${N.vagueTerms} 个词只认识「${N.vagueKnown.join('')}」`,
      detail: `下面回到按段落切的知识库。聊了几轮之后，用户问「${bare(Q_VAGUE)}」：哪个杯子、为什么退，都在前面的对话里，问题本身没说。${N.vagueTerms} 个词里嵌入模型只认识「${N.vagueKnown.join('')}」，检索结果前两个是《会员积分》，第三个是「非质量问题退货，寄回的运费由买家承担」，正好和这位用户的情况相反，标注的 ${RELEVANT.length} 个相关段落一个也没找到。真实的嵌入模型认识更多词，但「那个」指什么，它同样不知道。`,
      facts: [['认识的词', N.vagueKnown.join('、')], ['前 3', idsOf(vague.hits).map(shortOf).join('、')], ['召回', pctOf(recall.vague)]],
      events: [
        type(`search_docs("${Q_VAGUE}")`),
        state('chunker', { 长度: '按段落', 重叠: null }),
        pk('app', 'query', 'blue', '嵌入问题', [Q_VAGUE, `认识 ${N.vagueKnown.length} 个词`], [dist3b, 'EMBED', `「${Q_VAGUE}」切成 ${N.vagueTerms} 个词，词表里只有「${N.vagueKnown.join('')}」`, utf8Encode(Q_VAGUE).length],
          wire('口语化的问题', 'mem', 'format', utf8Text('query', Q_VAGUE), floatVector('查询向量', qVague.vector, 'f32', { color: 'blue', summary: `只由「${N.vagueKnown.join('')}」一个词决定`, digits: 3 })),
          { ds: { query: [termRow(qVague, 'v')] } }),
        pk('query', 'index', 'blue', '查询向量', ['status = current'], [dist3b, 'VECTOR', '查询向量送进向量库，仍然只搜现行段落', qVague.vector.length * 4], wire('查询向量', 'mem', 'format', floatVector('q', qVague.vector, 'f32', { color: 'blue', digits: 3 }))),
        pk('index', 'results', 'amber', `前 ${K} 个`, idsOf(vague.hits).map((id, i) => `${shortOf(id)} ${s3(vague.hits[i].score)}`), [dist4, 'SEARCH', `暴力搜索 ${vague.computed} 个段落，前 3 个都不是标注的相关段落（召回 ${pctOf(recall.vague)}）`, null],
          wire('检索结果', 'mem', '示意', hitsConcept('前 3 个', vague.hits, pid, paraText)),
          { ds: { results: [hitsRow(vague.hits, pid, () => false, [{ at: 2, text: '运费买家出？', color: 'amber' }], RELEVANT)] } }),
        note('results', `召回 ${pctOf(recall.vague)}`, 'amber'),
      ],
    },
    {
      title: '结合对话历史改写',
      desc: `改写后找到 ${recall.rewritten.found.length} / ${RELEVANT.length}`,
      detail: `检索之前先让大模型读一遍对话历史，把最后一句改写成能单独看懂的查询：「${bare(REWRITTEN)}」（模型写的，示例）。改写只多一次模型调用，提示 ${N.rewritePromptTokens} 个 token（本站 BPE），输出 ${N.rewriteTokens} 个；查询里认识的词从 ${N.vagueKnown.length} 个变成 ${N.rewrittenKnown} 个。拿它去检索，前 3 个是 ${idsOf(rewritten.hits).join('、')}，标注的两段都找到了。`,
      facts: [['改写（E.G.）', REWRITTEN], ['认识的词', `${N.vagueKnown.length} → ${N.rewrittenKnown} 个`], ['召回', `${pctOf(recall.vague)} → ${pctOf(recall.rewritten)}`]],
      events: [
        show('llm'),
        pk('app', 'llm', 'slate', '改写请求', ['对话历史 3 句', `「${Q_VAGUE}」`], [dist4, 'PROMPT', `改写提示：说明、对话历史和最后一句，共 ${N.rewritePromptTokens} 个 token（本站 BPE）`, utf8Encode(REWRITE_PROMPT).length],
          wire('改写提示', 'mem', 'format', utf8Lines('提示', REWRITE_PROMPT, { color: 'slate', summary: `${N.rewritePromptTokens} 个 token（本站 BPE）`, notes: { 0: '改写的说明：只输出查询，方便程序直接拿去检索。' } }))),
        pk('llm', 'query', 'green', '改写后的查询', [REWRITTEN], [dist4, 'INFER', `模型写出改写后的查询（示例），${N.rewriteTokens} 个 token；切成 ${qRewritten.terms.length} 个词，认识 ${N.rewrittenKnown} 个`, utf8Encode(REWRITTEN).length],
          wire('改写结果（模型写的，示例）', 'mem', 'format', exampleLines('改写', REWRITTEN, '模型的输出，示例')),
          { ds: { query: [termRow(qRewritten, 'w')] } }),
        pk('query', 'index', 'blue', '查询向量', ['status = current'], [dist4, 'VECTOR', '改写后的查询嵌入成向量，送进向量库', qRewritten.vector.length * 4], wire('查询向量', 'mem', 'format', floatVector('q', qRewritten.vector, 'f32', { color: 'blue', digits: 3 }))),
        pk('index', 'results', 'amber', `前 ${K} 个`, idsOf(rewritten.hits).map((id, i) => `${shortOf(id)} ${s3(rewritten.hits[i].score)}`), [dist5, 'SEARCH', `暴力搜索 ${rewritten.computed} 个段落，标注的 ${RELEVANT.join('、')} 都在前 3`, null],
          wire('改写后的检索结果', 'mem', '示意', hitsConcept('前 3 个', rewritten.hits, pid, paraText)),
          { ds: { results: [hitsRow(rewritten.hits, pid, () => false, undefined, RELEVANT)] } }),
        show('scores'),
        pk('results', 'scores', 'green', '算召回', [`原问题 ${pctOf(recall.vague)}`, `改写 ${pctOf(recall.rewritten)}`], [dist5, 'EVAL', `标注的 ${RELEVANT.length} 段：原问题找到 ${recall.vague.found.length} 段，改写后找到 ${recall.rewritten.found.length} 段`, null],
          wire('召回', 'mem', '示意', concept('找到的标注段落', [['原问题', pctOf(recall.vague), '一段也没找到。'], ['改写', pctOf(recall.rewritten), recall.rewritten.found.join('、')]], 'green')),
          { ds: { scores: [recallGrid(2)] } }),
      ],
    },
    {
      title: '多查询扩展和 HyDE',
      desc: `两种改写都找到 ${recall.multi.found.length} / ${RELEVANT.length}`,
      detail: `多查询扩展让模型从三个角度各写一个子问题（示例），每个取前 ${MULTI_K} 个，用 RRF 合并：《售后规则》第 3 条在三张列表里都出现，排到第一，融合后的前 3 个找全了两段，代价是检索三次。HyDE 反过来，先让模型写一段假设的回答（示例），拿这段回答的向量去检索，因为回答和文档长得更像。这段回答把 7 天编成了 30 天，可检索只用它的向量（「30」不在词表里，直接丢掉），进提示的是检索到的真实段落，前 3 个同样找全了两段。`,
      facts: [['多查询', `${SUBQUERIES.length} 个子问题，RRF 第一 ${fused[0].id}`], ['HyDE', `${N.hydeKnown} / ${N.hydeTerms} 个词认识`], ['召回', `多查询 ${pctOf(recall.multi)}，HyDE ${pctOf(recall.hyde)}`], ['出处', 'HyDE：Gao 等，ACL 2023']],
      events: [
        pk('llm', 'query', 'green', `${SUBQUERIES.length} 个子问题`, SUBQUERIES, [dist5, 'INFER', `模型从原问题和对话历史写出 ${SUBQUERIES.length} 个子问题（示例）`, utf8Encode(SUBQUERIES.join('\n')).length],
          wire('多查询扩展（模型写的，示例）', 'mem', 'format', exampleLines('子问题', SUBQUERIES.join('\n'), `${SUBQUERIES.length} 个，每行一个`)),
          { ds: { query: [queryList(SUBQUERIES.map((q) => q.slice(0, 6)), 'm')] } }),
        pk('index', 'results', 'amber', 'RRF 融合', fused.slice(0, K).map((d) => `${shortOf(d.id)} ${num(d.score, 4)}`), [dist6a, 'FUSE', `${SUBQUERIES.length} 个子问题各搜 ${subSearches[0].computed} 个段落取前 ${MULTI_K}，RRF（k = 60）合并，${fused[0].id} 在三张列表里都出现`, null],
          wire('三张列表和 RRF', 'mem', '示意',
            ...subSearches.map((s, i) => hitsConcept(`子问题 ${i + 1}：${SUBQUERIES[i]}`, s.hits, pid, paraText)),
            concept('RRF 融合（score = Σ 1 / (60 + 名次)）', fused.slice(0, MULTI_K).map((d): [string, string, string] => [`${d.rank} · ${d.id}`, num(d.score, 4), `三张列表里的名次：${d.ranks.map((r) => r ?? '—').join(' / ')}`]), 'amber'),
            concept('常见做法', [['LangChain MultiQueryRetriever', '默认写 3 个查询', '每个查询各检索一次，结果取去重的并集，不打分融合。'], ['RAG-Fusion', '多个查询 + RRF', '和这里一样按 1 / (60 + 名次) 合并排序。']], 'slate')),
          { ds: { results: [resultRow(fused.slice(0, K).map((d) => ({ id: d.id, score: num(d.score, 4) })), [{ at: 0, text: '三张列表都有', color: 'green' }], RELEVANT)] } }),
        pk('llm', 'query', 'green', '假设的回答', [`${HYDE.slice(0, 14)}…`, '30 天是编的'], [dist6a, 'INFER', `HyDE：模型先写一段假设的回答（示例），${countTokens(HYDE)} 个 token，其中「30 天」是编错的`, utf8Encode(HYDE).length],
          wire('HyDE 的假设回答（模型写的，示例）', 'mem', 'format', exampleLines('假设回答', HYDE, `${N.hydeTerms} 个词，嵌入模型认识 ${N.hydeKnown} 个`)),
          { ds: { query: [termRow(qHyde, 'h')] } }),
        pk('index', 'results', 'amber', `前 ${K} 个`, idsOf(hyde.hits).map((id, i) => `${shortOf(id)} ${s3(hyde.hits[i].score)}`), [dist6b, 'SEARCH', `用假设回答的向量搜 ${hyde.computed} 个段落，标注的两段都在前 3`, null],
          wire('HyDE 的检索结果', 'mem', '示意', hitsConcept('前 3 个', hyde.hits, pid, paraText)),
          { ds: { results: [hitsRow(hyde.hits, pid, () => false, undefined, RELEVANT)] } }),
        pk('results', 'scores', 'green', '算召回', [`多查询 ${pctOf(recall.multi)}`, `HyDE ${pctOf(recall.hyde)}`], [dist6b, 'EVAL', `四种查询的召回：${pctOf(recall.vague)}、${pctOf(recall.rewritten)}、${pctOf(recall.multi)}、${pctOf(recall.hyde)}`, null],
          wire('召回', 'mem', '示意', concept('找到的标注段落', ROWS.map((row, i): [string, string, string] => {
            const r = [recall.vague, recall.rewritten, recall.multi, recall.hyde][i];
            return [row, pctOf(r), r.found.join('、') || '没有'];
          }), 'green')),
          { ds: { scores: [recallGrid(4)] } }),
        note('scores', '多一次模型调用，换回召回', 'green'),
      ],
    },
  ],
  outro: {
    title: '先查检索，再怪模型',
    desc: `召回 ${pctOf(recall.vague)} → ${pctOf(recall.rewritten)}`,
    text: `回答错了，先看检索结果：旧版本混进来要靠元数据过滤，答案被切开要调切分和重叠，问题说不清要改写查询。三种改写都要在检索前多调一次模型：结合历史改写最便宜，多查询扩展多检索几次换来更稳的排序，HyDE 用一段可能编错的回答当查询，编错的内容不进提示。改写出来的查询是示例，检索结果是真算的；真实系统里改写也可能跑偏，所以要有评估。下一课用 ${KB.length} 篇文档上的 8 个标注问题，给检索和回答打分。`,
    facts: [['旧版本', '前过滤 status = current'], ['被切开', `重叠 ${OVERLAP} 字`], ['说不清', '改写 / 多查询 / HyDE'], ['下一课', 'RAG 评估']],
  },
};
