/**
 * RAG 流水线第三课：重排序。上一课的问题（保温杯漏水，可以换货吗？）先用向量召回前 10 个候选，再让重排序器逐对（问题，候选）打分、
 * 重新排序，取前 3 个。讲杯盖漏水的 cup#1 从第 5 升到第 2，讲无理由退货的 aftersale#0 从第 3 掉到第 5。
 *
 * 召回、打分、名次全部由 core/ 真实计算（flatSearch、rerank.ts 的 crossScore / rerank）。本站的重排序器是一个可计算的替身：
 * 0.5 × 嵌入余弦 + 0.5 × 查询词的 idf 覆盖率；真实的是交叉编码器模型（Voyage、Cohere 的 rerank 接口，字段经核对）。
 * tests/narrative.pipeline.test.ts 核对文案。
 */
import {
  countTokens,
  DistanceMeter,
  EMBEDDER,
  embed,
  encodeJson,
  EVAL_SET,
  flatSearch,
  PARAGRAPH_VECTORS,
  PARAGRAPHS,
  RERANK_WEIGHTS,
  rerank as rerankAll,
  retrievalRecall,
  termsOf,
  type Paragraph,
} from '../core';
import { concept, floatVector, jsonBody, num, thousands, wire } from '../decode/structures';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';
import { QUESTION } from './qa';

// ---------- 召回和重排 ----------

/** 第一轮召回的候选数（top-N）和最后放进提示的个数（top-k）。 */
export const TOP_N = 10;
export const TOP_K = 3;

export const q = embed(QUESTION);
export const meter = new DistanceMeter();
export const recall = flatSearch(PARAGRAPH_VECTORS, q.vector, TOP_N, 'ip', meter);
export const CANDIDATES: Paragraph[] = recall.hits.map((hit) => PARAGRAPHS[hit.id]);
export const recallMeter = meter.total;
/** 重排：每个候选打一次分（记 rerank），全部排序。 */
export const RERANKED = rerankAll(QUESTION, CANDIDATES, TOP_N, meter);

const idOf = (p: Paragraph) => p.id;
export const beforeTop = CANDIDATES.slice(0, TOP_K).map(idOf);
export const afterTop = RERANKED.slice(0, TOP_K).map((entry) => entry.item.id);
/** 评估集里这个问题标注的相关段落。 */
export const LEAK = EVAL_SET.find((item) => item.id === 'leak')!;
export const recallBefore = retrievalRecall(beforeTop, LEAK.relevant);
export const recallAfter = retrievalRecall(afterTop, LEAK.relevant);

export const entryOf = (id: string) => RERANKED.find((entry) => entry.item.id === id)!;
/** 升得最多的和掉得最多的。 */
export const riser = RERANKED.reduce((best, entry) => (entry.before - entry.rank > best.before - best.rank ? entry : best));
export const faller = RERANKED.filter((entry) => entry.before <= TOP_K).reduce((worst, entry) => (entry.rank - entry.before > worst.rank - worst.before ? entry : worst));

// ---------- 覆盖率的拆解（riser 和 faller 各一份） ----------

export const TERMS = [...new Set(termsOf(QUESTION))];
const maxIdf = Math.log(EMBEDDER.docs);
export const idfOf = (term: string): number => EMBEDDER.idf.get(term) ?? maxIdf;
export const idfTotal = TERMS.reduce((sum, term) => sum + idfOf(term), 0);
const matchedIdf = (matched: readonly string[]) => matched.reduce((sum, term) => sum + idfOf(term), 0);

// ---------- 真实的重排序接口（请求体，字段经核对） ----------

/** Voyage：POST https://api.voyageai.com/v1/rerank。 */
export const VOYAGE_BODY = { query: QUESTION, documents: CANDIDATES.map((p) => p.text), model: 'rerank-3', top_k: TOP_K };
export const voyageJson = encodeJson(VOYAGE_BODY);
/** Cohere：POST https://api.cohere.com/v2/rerank（model 必填，这里用文档示例里的名字）。 */
export const COHERE_BODY = { model: 'rerank-v5.0-pro', query: QUESTION, documents: CANDIDATES.map((p) => p.text), top_n: TOP_K };
export const cohereJson = encodeJson(COHERE_BODY);

// ---------- 文案用到的数 ----------

export const numbers = {
  searched: recall.computed,
  recallDist: recallMeter,
  rerankDist: meter.total - recallMeter,
  total: meter.total,
  queryTokens: countTokens(QUESTION),
  docTokens: CANDIDATES.reduce((sum, p) => sum + countTokens(p.text), 0),
  /** Voyage 文档的计数方式：查询 token × 文档数 + 全部文档的 token。 */
  crossTokens: countTokens(QUESTION) * TOP_N + CANDIDATES.reduce((sum, p) => sum + countTokens(p.text), 0),
  voyageBytes: voyageJson.bytes.length,
  cohereBytes: cohereJson.bytes.length,
  terms: TERMS.length,
  unknownTerms: TERMS.filter((term) => !EMBEDDER.idf.has(term)).length,
};
const N = numbers;
const c2 = (x: number): string => fixed(x, 2);
const c3 = (x: number): string => fixed(x, 3);

// ---------- 图元 ----------

/**
 * 候选（或重排后）竖着排成一列：格子写块 id（重排后名次变了的，后面写原名次），左边的小字是分数。
 * 前 top 个亮起（标注为相关的绿色），其余变暗。
 */
function rankRow(id: string, rows: Array<{ p: Paragraph; score: number; before?: number }>, top: number): RowPrim {
  return {
    kind: 'row',
    id,
    axis: 'y',
    w: 132,
    d: 30,
    cells: rows.map(({ p, score, before }, i): DsCell => ({
      v: before !== undefined && before !== i + 1 ? `${p.id} ←${before}` : p.id,
      key: p.id,
      tone: i < top ? (LEAK.relevant.includes(p.id) ? 'green' : PART_TONE.result) : 'dim',
      sub: c3(score),
      lift: (before !== undefined && before - (i + 1) >= 2) || undefined,
    })),
  };
}

const recallRow = () => rankRow('c', CANDIDATES.map((p, i) => ({ p, score: recall.hits[i].score })), TOP_K);
const rerankRow = () => rankRow('f', RERANKED.map((entry) => ({ p: entry.item, score: entry.cross.score, before: entry.before })), TOP_K);

/** 每个候选的两项分数和合计：列是召回时的名次，行是余弦、覆盖率、0.5 × 两者之和。 */
function scoreGrid(): GridPrim {
  return {
    kind: 'grid',
    id: 's',
    w: 36,
    rows: ['余弦', '覆盖', '合计'],
    cols: CANDIDATES.map((_, i) => String(i + 1)),
    cells: [
      CANDIDATES.map((p): DsCell => ({ v: c2(entryOf(p.id).cross.cosine), tone: PART_TONE.vector, heat: Math.max(0, entryOf(p.id).cross.cosine) })),
      CANDIDATES.map((p): DsCell => ({ v: c2(entryOf(p.id).cross.coverage), tone: 'blue', heat: entryOf(p.id).cross.coverage })),
      CANDIDATES.map((p): DsCell => ({ v: c2(entryOf(p.id).cross.score), tone: 'green', heat: entryOf(p.id).cross.score })),
    ],
  };
}

/** 问题切出来的词：下面是 idf；给出 matched 时，命中的词变蓝，没命中的变暗。 */
function termRow(matched?: readonly string[]): RowPrim {
  return {
    kind: 'row',
    id: 't',
    w: 44,
    cells: TERMS.map((term): DsCell => ({ v: term, key: term, sub: EMBEDDER.idf.has(term) ? num(idfOf(term), 2) : `${num(maxIdf, 2)}*`, tone: !matched ? 'slate' : matched.includes(term) ? 'blue' : 'dim', lift: matched?.includes(term) || undefined })),
  };
}

/** Voyage rerank 请求体的字段，下面是字节数。 */
function requestRow(): RowPrim {
  return {
    kind: 'row',
    id: 'v',
    w: 72,
    cells: Object.keys(VOYAGE_BODY).map((key): DsCell => {
      const value = JSON.stringify((VOYAGE_BODY as Record<string, unknown>)[key]);
      return { v: key, key, tone: key === 'documents' ? PART_TONE.doc : key === 'query' ? PART_TONE.query : 'slate', sub: `${new TextEncoder().encode(`"${key}":${value}`).length} B` };
    }),
  };
}

// ---------- 课程 ----------

const R = entryOf(riser.item.id);
const F = entryOf(faller.item.id);

export const rerank: Lesson = {
  id: 'rerank',
  name: 'RERANK',
  title: '重排序',
  group: 'pipeline',
  layer: [4, 5],
  layerNote: '先在索引里粗召回一批候选，再逐个和问题放在一起重新打分：整课在索引和检索两档之间。',
  distNote: `召回时和 ${N.searched} 个向量各比一次（${N.recallDist} 次），重排时每个候选打一次分（${N.rerankDist} 次），一共 ${N.total} 次。`,
  nodes: ['app', 'index', 'results', 'reranker', 'scores', 'tokens', 'fused', 'request'],
  place: { app: [90, 140], index: [420, 110], results: [800, 150], reranker: [520, 420], scores: [200, 470], tokens: [180, 760], fused: [900, 500], request: [600, 760] },
  labels: {
    app: ['客服 Agent', 'search_docs'],
    index: ['向量库', `Flat，${PARAGRAPHS.length} 块`],
    results: ['召回', `前 ${TOP_N} 个候选`],
    reranker: ['重排序器', '本站替身'],
    scores: ['逐对打分', '余弦、覆盖率、合计'],
    tokens: ['问题的词', '下面是 idf'],
    fused: ['重排后', `取前 ${TOP_K}`],
    request: ['rerank 请求', 'Voyage 的字段'],
  },
  labelAt: { results: [150, 70], scores: [-160, 60], tokens: [-150, 40], fused: [150, 70], request: [0, 75] },
  radius: { results: 80, scores: 90, tokens: 60, fused: 80, request: 60 },
  initial: { results: [], scores: [], tokens: [], fused: [], request: [] },
  start: ['app', 'index'],
  legend: [['amber', '进入前 3 的候选'], ['green', '标注为相关的块'], ['violet', '余弦'], ['blue', '问题的词和覆盖率'], [null, '距离列：向量比较和重排打分的次数']],
  overview: {
    full: '先粗召回，再精排',
    description: `上一课的检索只取了向量最近的 ${TOP_K} 块，讲杯盖漏水的 cup#1 排在第 ${R.before}，没进提示。重排序的做法是两段式：先用便宜的向量检索召回 ${TOP_N} 个候选，再用一个更贵的打分器把问题和每个候选放在一起重新打分，取前 ${TOP_K}。这一课用本站的替身打分器真实地算一遍，看名次怎样变化，再看真实的交叉编码器为什么贵。`,
    facts: [
      ['问题', QUESTION],
      ['召回', `前 ${TOP_N} 个，${N.recallDist} 次距离计算`],
      ['重排', `${N.rerankDist} 次打分`],
      [R.item.id, `第 ${R.before} → 第 ${R.rank}`],
      ['相关块进前 3', `${recallBefore.found.length} → ${recallAfter.found.length}（共 ${LEAK.relevant.length} 个）`],
    ],
  },
  steps: [
    {
      title: `先召回 ${TOP_N} 个`,
      desc: `比较 ${N.searched} 次，取前 ${TOP_N}`,
      detail: `第一段和上一课一样是向量检索，只是多取一些：查询向量和 ${N.searched} 块各比一次，取最近的 ${TOP_N} 个作为候选。向量检索是双塔的：问题和段落各自变成向量，段落的向量在建索引时就算好了，查询时只算一次点积，所以便宜，但它看不到问题和段落之间逐词的对应。前 ${TOP_K} 名是 ${beforeTop.join('、')}，评估集给这个问题标注的相关块 ${LEAK.relevant.join('、')} 只有 ${recallBefore.found.length} 个在里面。`,
      facts: [['距离计算', `${N.recallDist} 次`], ['候选', `${TOP_N} 个`], ['前 3', beforeTop.join('、')], ['相关块', `${recallBefore.found.length} / ${LEAK.relevant.length} 在前 3`]],
      events: [
        type(`search_docs({ query: "${QUESTION}" })`),
        pk('app', 'index', 'blue', `k = ${TOP_N}`, [`「${QUESTION}」`, `${q.vector.length} 维查询向量`], [0, 'SEARCH', `查询向量送进向量库，先取 ${TOP_N} 个候选`, q.vector.length * 4],
          wire('查询向量（float32 小端）', 'mem', 'format', floatVector('query', q.vector, 'f32', { color: 'blue', summary: QUESTION, digits: 3 }))),
        show('results'),
        pk('index', 'results', 'amber', `前 ${TOP_N} 个`, beforeTop.map((id, i) => `${i + 1}. ${id}`), [N.recallDist, 'SEARCH', `和 ${N.searched} 个向量各算一次点积，取前 ${TOP_N}`, null],
          wire('召回的候选', 'mem', '示意', concept(`前 ${TOP_N} 个`, CANDIDATES.map((p, i): [string, string, string] => [`${i + 1}. ${p.id}`, c3(recall.hits[i].score), `${p.title}：${p.text.slice(0, 24)}……${LEAK.relevant.includes(p.id) ? '（标注为相关）' : ''}`]), 'amber')),
          { ds: { results: [recallRow()] } }),
        note('results', `cup#1 在第 ${R.before}`, 'amber'),
      ],
    },
    {
      title: '逐对打分',
      desc: `${TOP_N} 个候选，各打一次分`,
      detail: `重排序器把问题和每个候选放在一起打分，${TOP_N} 个候选就打 ${TOP_N} 次，距离列加 ${N.rerankDist}。真实的重排序器是交叉编码器（cross-encoder）模型：把问题和候选拼成一段输入，一起过一遍 Transformer，输出一个相关度；本站跑不了，用一个能算的替身：分数 = ${RERANK_WEIGHTS.vector} × 嵌入余弦 + ${RERANK_WEIGHTS.coverage} × 覆盖率，覆盖率是问题里的词出现在候选里的比例（按 idf 加权）。覆盖率必须把两段文字放在一起才算得出来，这是它和双塔检索的区别，权重各一半是本站选的。`,
      facts: [['打分', `${N.rerankDist} 次`], ['公式', `${RERANK_WEIGHTS.vector} × 余弦 + ${RERANK_WEIGHTS.coverage} × 覆盖率`], [R.item.id, `余弦 ${c2(R.cross.cosine)}，覆盖 ${c2(R.cross.coverage)}`], [F.item.id, `余弦 ${c2(F.cross.cosine)}，覆盖 ${c2(F.cross.coverage)}`]],
      events: [
        show('reranker'),
        pk('results', 'reranker', 'amber', `${TOP_N} 对`, [`（问题，${CANDIDATES[0].id}）`, `……（问题，${CANDIDATES[TOP_N - 1].id}）`], [N.recallDist, 'RERANK', `${TOP_N} 个候选和问题配成 ${TOP_N} 对，送进重排序器`, null],
          wire('送进重排序器的 10 对', 'mem', '示意', concept('（问题，候选）', CANDIDATES.map((p, i): [string, string, string] => [`${i + 1}. ${p.id}`, `${countTokens(QUESTION)} + ${countTokens(p.text)} token`, '交叉编码器把问题和候选拼成一段输入，一起过一遍模型（token 数是本站 BPE）。']), 'amber')),
          { ds: { results: [recallRow()] } }),
        show('scores'),
        pk('reranker', 'scores', 'green', `${TOP_N} 个分数`, [`${R.item.id}：${c2(R.cross.score)}`, `${F.item.id}：${c2(F.cross.score)}`], [N.total, 'RERANK', `每对打一次分：${RERANK_WEIGHTS.vector} × 余弦 + ${RERANK_WEIGHTS.coverage} × 覆盖率，共 ${N.rerankDist} 次`, null],
          wire('每个候选的分数（本站替身打分器）', 'mem', '示意', concept('打分', CANDIDATES.map((p): [string, string, string] => {
            const cross = entryOf(p.id).cross;
            return [p.id, c3(cross.score), `余弦 ${c3(cross.cosine)}，覆盖率 ${c3(cross.coverage)}，命中 ${cross.matched.length ? cross.matched.join('、') : '无'}。`];
          }), 'green')),
          { ds: { scores: [scoreGrid()] } }),
        state('reranker', { 打分: `${N.rerankDist} 次`, 权重: `${RERANK_WEIGHTS.vector} / ${RERANK_WEIGHTS.coverage}` }),
      ],
    },
    {
      title: '覆盖率怎么算',
      desc: `${R.item.id} ${c2(R.cross.coverage)}，${F.item.id} ${c2(F.cross.coverage)}`,
      detail: `问题切成 ${N.terms} 个词，每个词按 idf 计分量，词表外的 ${N.unknownTerms} 个按最大的 idf（ln ${EMBEDDER.docs} = ${fixed(maxIdf, 2)}）算，合计 ${num(idfTotal, 2)}。${R.item.id} 命中${R.cross.matched.map((term) => `「${term}」`).join('')}，覆盖率 ${num(matchedIdf(R.cross.matched), 2)} / ${num(idfTotal, 2)} = ${c2(R.cross.coverage)}；${F.item.id} 只命中${F.cross.matched.map((term) => `「${term}」`).join('')}，覆盖率 ${c2(F.cross.coverage)}。两者的余弦是 ${c2(R.cross.cosine)} 和 ${c2(F.cross.cosine)}，${F.item.id} 原本靠向量排在前面，但它和问题没有几个共同的词，合计就被 ${R.item.id} 反超。`,
      facts: [['词', `${N.terms} 个，idf 合计 ${num(idfTotal, 2)}`], [`${R.item.id} 命中`, R.cross.matched.join('、')], [`${F.item.id} 命中`, F.cross.matched.join('、')], ['合计', `${c2(R.cross.score)} 对 ${c2(F.cross.score)}`]],
      events: [
        show('tokens'),
        pk('reranker', 'tokens', 'blue', `${N.terms} 个词`, [`${R.item.id} 命中 ${R.cross.matched.length} 个`, `${F.item.id} 命中 ${F.cross.matched.length} 个`], [N.total, 'TOKENS', `问题切成 ${N.terms} 个词，idf 合计 ${num(idfTotal, 2)}；${R.item.id} 覆盖 ${c2(R.cross.coverage)}，${F.item.id} 覆盖 ${c2(F.cross.coverage)}`, null],
          wire('覆盖率的拆解', 'mem', '示意',
            concept('问题的词', TERMS.map((term): [string, string, string] => [term, `idf ${num(idfOf(term), 3)}`, EMBEDDER.idf.has(term) ? `${R.item.id}${R.cross.matched.includes(term) ? ' 有' : ' 没有'}，${F.item.id}${F.cross.matched.includes(term) ? ' 有' : ' 没有'}。` : '不在词表里，按最大 idf 算。']), 'blue'),
            concept(R.item.id, [['命中', R.cross.matched.join('、')], ['覆盖率', `${num(matchedIdf(R.cross.matched), 3)} / ${num(idfTotal, 3)} = ${c3(R.cross.coverage)}`], ['合计', `0.5 × ${c3(R.cross.cosine)} + 0.5 × ${c3(R.cross.coverage)} = ${c3(R.cross.score)}`]], 'green'),
            concept(F.item.id, [['命中', F.cross.matched.join('、')], ['覆盖率', `${num(matchedIdf(F.cross.matched), 3)} / ${num(idfTotal, 3)} = ${c3(F.cross.coverage)}`], ['合计', `0.5 × ${c3(F.cross.cosine)} + 0.5 × ${c3(F.cross.coverage)} = ${c3(F.cross.score)}`]], 'amber')),
          { ds: { tokens: [termRow(R.cross.matched)] } }),
        note('tokens', `${R.item.id} 命中 ${R.cross.matched.join('、')}`, 'green'),
      ],
    },
    {
      title: '按新分数排名',
      desc: `${R.item.id} 第 ${R.before} → 第 ${R.rank}`,
      detail: `按合计重新排序：${R.item.id} 从第 ${R.before} 升到第 ${R.rank}，${F.item.id} 从第 ${F.before} 掉到第 ${F.rank}，前 ${TOP_K} 变成 ${afterTop.join('、')}。标注的两个相关块 ${LEAK.relevant.join('、')} 现在都在前 ${TOP_K} 里，上一课回答里缺的「先把密封圈重新装好」有了来源。重排序器不会找回第一轮没召回的段落，所以 top-N 要比 top-k 大得多，留出让它挑的余地。`,
      facts: [...RERANKED.slice(0, 5).map((entry): [string, string] => [`第 ${entry.rank}`, `${entry.item.id}（原第 ${entry.before}）`]), ['相关块进前 3', `${recallBefore.found.length} → ${recallAfter.found.length}`]],
      events: [
        show('fused'),
        pk('reranker', 'fused', 'green', `前 ${TOP_K}`, afterTop.map((id, i) => `${i + 1}. ${id}`), [N.total, 'RERANK', `按重排分排序：${R.item.id} ${R.before}→${R.rank}，${F.item.id} ${F.before}→${F.rank}；前 ${TOP_K}：${afterTop.join('、')}`, null],
          wire('重排后的名次', 'mem', '示意', concept('名次', RERANKED.map((entry): [string, string, string] => [`${entry.rank}. ${entry.item.id}`, `${c3(entry.cross.score)}（原第 ${entry.before}）`, entry.rank < entry.before ? `升了 ${entry.before - entry.rank} 名。` : entry.rank > entry.before ? `掉了 ${entry.rank - entry.before} 名。` : '名次不变。']), 'green')),
          { ds: { fused: [rerankRow()] } }),
        note('fused', `相关块 ${recallBefore.found.length} → ${recallAfter.found.length}`, 'green'),
      ],
    },
    {
      title: '真实的交叉编码器',
      desc: `每个候选过一次模型，${thousands(N.crossTokens)} token`,
      detail: `真实系统把这一步交给交叉编码器：Voyage 的 POST /v1/rerank、Cohere 的 POST /v2/rerank 都是给一个 query、一组 documents 和要返回的个数（top_k / top_n），返回每个文档的 index 和 relevance_score。Voyage 的文档这样数一次重排的 token：问题 token × 文档数 + 全部文档的 token，因为问题要和每个候选拼在一起各过一次模型。这 ${TOP_N} 个候选按本站 BPE 算是 ${N.queryTokens} × ${TOP_N} + ${thousands(N.docTokens)} = ${thousands(N.crossTokens)} 个 token（真实模型的分词器不同）。双塔检索在查询时只嵌入问题本身（${N.queryTokens} 个 token），候选的向量早就算好了，所以重排序只能用在第一轮召回的少量候选上。`,
      facts: [['Voyage', 'POST /v1/rerank'], ['Cohere', 'POST /v2/rerank'], ['请求体', `${thousands(N.voyageBytes)} 字节（Voyage）`], ['交叉编码', `${thousands(N.crossTokens)} token`], ['双塔查询', `${N.queryTokens} token + ${N.searched} 次点积`]],
      events: [
        show('request'),
        pk('reranker', 'request', 'slate', 'POST /v1/rerank', ['query + documents', `top_k: ${TOP_K}`], [N.total, 'JSON', `换成真实的重排序接口：query、${TOP_N} 个 documents、model、top_k，请求体 ${thousands(N.voyageBytes)} 字节`, N.voyageBytes],
          wire('真实重排序接口的请求体（字段经核对）', 'mem', 'format',
            jsonBody('Voyage rerank 请求体', voyageJson, { color: 'slate', expand: ['documents[0]'], notes: { query: '问题。和每个文档拼在一起送进交叉编码器。', documents: `${TOP_N} 个候选的正文，最多 1000 个。`, model: 'Voyage 的重排序模型，交叉编码器。', top_k: `只返回前 ${TOP_K} 个；响应 data 里每项是 index 和 relevance_score，按相关度降序。` } }),
            jsonBody('Cohere rerank 请求体', cohereJson, { color: 'slate', notes: { model: 'Cohere 的重排序模型（文档示例里的名字）。', top_n: `只返回前 ${TOP_K} 个；响应 results 里每项是 index 和 relevance_score。` } })),
          { ds: { request: [requestRow()] } }),
        note('request', `交叉编码 ${thousands(N.crossTokens)} token`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '召回求全，重排求准',
    desc: `${N.recallDist} 次比较召回 ${TOP_N} 个 → ${N.rerankDist} 次打分 → 前 ${TOP_K}`,
    text: `两段式检索把成本和准确度分开：向量检索便宜，负责从全部块里召回一批大致相关的候选；重排序贵，只看召回的这一小批候选，但能看到问题和候选之间逐词的对应。这一课里 ${R.item.id} 从第 ${R.before} 升到第 ${R.rank}，标注的相关块全部进了前 ${TOP_K}；Anthropic 的 Contextual Retrieval 实验里，上下文嵌入、上下文 BM25 再加上重排序，检索失败率比基线降了 67%（5.7% → 1.9%）。本站的打分器只是替身，真实的交叉编码器会给出不同的分数。下一课看检索失败时怎么办：失败案例和查询改写。`,
    facts: [[R.item.id, `第 ${R.before} → 第 ${R.rank}`], ['相关块进前 3', `${recallBefore.found.length} → ${recallAfter.found.length}`], ['距离列', `${N.recallDist} + ${N.rerankDist} = ${N.total}`], ['下一课', '失败案例与查询改写']],
  },
};
