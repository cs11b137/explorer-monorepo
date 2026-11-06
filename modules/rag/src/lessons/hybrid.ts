/**
 * 向量检索组第五课：元数据过滤与混合检索。知识库里还留着一篇已作废的《退款说明（2025 版）》（status = archived），
 * 问「退款多久能到账？」时它和现行版本几乎一样近：后过滤先取前 3 再筛，只剩 2 个；前过滤先筛再搜，拿满 3 个。
 * 然后在现行的 26 个段落上做混合检索：精确编号 SR-35 是 BM25 赢，换了说法的「钱什么时候退回来」是向量赢，RRF（k = 60）把两份排名合起来。
 *
 * 全部由 core/ 实时计算：filteredSearch、flatSearch、bm25Search、rankedOf、rrf。tests/narrative.index.test.ts 核对文案。
 */
import {
  BM25_B,
  BM25_K1,
  bm25Search,
  DistanceMeter,
  embed,
  EVAL_SET,
  filteredSearch,
  flatSearch,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  rankedOf,
  RRF_K,
  rrf,
  type FusedDoc,
  type RankedDoc,
} from '../core';
import { concept, floatVector, num, wire } from '../decode/structures';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import { idOf, searchOutput, shortName } from './index-common';
import type { DsCell, Lesson, RowPrim, Tone } from './types';

// ---------- 元数据过滤 ----------

export const N = PARAGRAPHS.length;
export const DIM = PARAGRAPH_VECTORS[0].length;
export const K = 3;
const isCurrent = (i: number) => PARAGRAPHS[i].meta.status === 'current';
export const ARCHIVED = PARAGRAPHS.flatMap((p, i) => (p.meta.status === 'archived' ? [i] : []));

const REFUND = EVAL_SET.find((item) => item.id === 'refund-time')!;
export const Q_REFUND = REFUND.question;
export const qRefund = embed(Q_REFUND).vector;

export const meter = new DistanceMeter();
export const post = filteredSearch(PARAGRAPH_VECTORS, qRefund, K, isCurrent, 'post', 'ip', meter);
export const afterPost = meter.total;
export const pre = filteredSearch(PARAGRAPH_VECTORS, qRefund, K, isCurrent, 'pre', 'ip', meter);
export const afterPre = meter.total;
export const dropped = post.beforeFilter.filter((hit) => !isCurrent(hit.id)).map((hit) => hit.id);

// ---------- 混合检索（在现行段落上，前过滤之后） ----------

export const CURRENT = pre.allowed;
const docs = CURRENT.map((i) => ({ id: PARAGRAPHS[i].id, text: PARAGRAPHS[i].text }));
const indexOfId = (id: string) => PARAGRAPHS.findIndex((p) => p.id === id);
export const TOP = 5;

function hybrid(question: string) {
  const e = embed(question);
  const keyword = bm25Search(docs, question, TOP);
  const vector = flatSearch(PARAGRAPH_VECTORS, e.vector, TOP, 'ip', meter, CURRENT);
  const vectorRanked = rankedOf(vector.hits, (i) => PARAGRAPHS[i].id);
  return { question, embed: e, keyword, vector, vectorRanked, fused: rrf([keyword.ranked, vectorRanked]), qdrant: rrf([keyword.ranked, vectorRanked], 1), after: meter.total };
}

/** BM25 赢：问的是配件编号 SR-35。 */
export const Q_CODE = 'SR-35 保修吗？';
export const code = hybrid(Q_CODE);
/** 向量赢：「钱什么时候退回来」和《退款说明》几乎没有共同的词。 */
export const Q_SYN = '钱什么时候退回来？';
export const syn = hybrid(Q_SYN);
export const afterAll = meter.total;

// ---------- 显示 ----------

const name = (i: number) => shortName(i);
const nameId = (id: string) => shortName(indexOfId(id));
const r2 = (x: number) => fixed(x, 2);
const r3 = (x: number) => fixed(x, 3);
const bare = (text: string) => text.replace(/？$/, '');
const rankIn = (list: readonly RankedDoc[], id: string) => list.find((doc) => doc.id === id)?.rank ?? null;

function hitRow(id: string, hits: ReadonlyArray<{ id: number; score: number }>, options: { k?: number; good?: string[]; bad?: number[]; tone?: Tone } = {}): RowPrim {
  const k = options.k ?? hits.length;
  return {
    kind: 'row',
    id,
    w: 60,
    cells: Array.from({ length: k }, (_, r): DsCell => {
      const hit = hits[r];
      if (!hit) return { v: '', sub: '空' };
      const tone: Tone = options.bad?.includes(hit.id) ? 'dim' : options.good?.includes(idOf(hit.id)) ? PART_TONE.result : options.tone ?? 'slate';
      return { v: name(hit.id), key: `${id}${hit.id}`, tone, sub: r2(hit.score) };
    }),
  };
}

function rankedRow(id: string, list: readonly RankedDoc[], good: string, tone: Tone, digits = 2): RowPrim {
  return { kind: 'row', id, w: 60, cells: list.slice(0, K).map((doc): DsCell => ({ v: nameId(doc.id), key: `${id}${doc.id}`, tone: doc.id === good ? PART_TONE.result : tone, sub: fixed(doc.score, digits) })) };
}

function fusedRow(list: readonly FusedDoc[], good: string): RowPrim {
  return { kind: 'row', id: 'f', w: 64, cells: list.slice(0, K).map((doc): DsCell => ({ v: nameId(doc.id), key: `f${doc.id}`, tone: doc.id === good ? PART_TONE.result : 'violet', sub: doc.ranks.map((r) => (r === null ? '—' : String(r))).join('+') })) };
}

const rrfLine = (doc: FusedDoc, k = RRF_K) => doc.ranks.map((r) => (r === null ? '0' : `1/(${k}+${r})`)).join(' + ');

const fusedConcept = (h: typeof code, title: string) =>
  concept(title, h.fused.slice(0, 4).map((doc): [string, string, string] => [`${doc.rank} · ${nameId(doc.id)} ${doc.id}`, num(doc.score, 4), `BM25 第 ${doc.ranks[0] ?? '—'}、向量第 ${doc.ranks[1] ?? '—'}：${rrfLine(doc)}。`]), 'violet');

const keywordConcept = (h: typeof code) =>
  concept(`BM25（k1 = ${BM25_K1}，b = ${BM25_B}）`, h.keyword.ranked.slice(0, K).map((doc): [string, string, string] => {
    const scored = h.keyword.scored.find((item) => item.id === doc.id)!;
    return [`${doc.rank} · ${nameId(doc.id)} ${doc.id}`, num(doc.score, 3), `命中 ${scored.hits.map((hit) => `「${hit.term}」${num(hit.part, 2)}`).join('、')}。`];
  }), 'teal');

/** 例子里「正确」的段落。 */
export const GOOD_CODE = 'cup#2';
export const GOOD_SYN = 'refund#0';
const codeKwFirst = code.keyword.ranked[0].id;
const codeVecFirst = code.vectorRanked[0].id;
const synKwFirst = syn.keyword.ranked[0].id;
const synVecFirst = syn.vectorRanked[0].id;
const synHits = syn.keyword.scored.filter((d) => d.score > 0);
const synTerm = synHits[0].hits[0].term;
const synTie = syn.fused[0].score === syn.fused[1].score;
const top3 = (list: readonly FusedDoc[]) => list.slice(0, K).map((d) => d.id).join();
/** Qdrant 的写法（k = 1、名次从 1 起）和 k = 60 的前 3 名是否一致。 */
export const qdrantSame = top3(code.qdrant) === top3(code.fused) && top3(syn.qdrant) === top3(syn.fused);

// ---------- 课程 ----------

export const hybridLesson: Lesson = {
  id: 'hybrid',
  name: 'FILTER + HYBRID',
  title: '元数据过滤与混合检索（BM25 + 向量，RRF）',
  group: 'index',
  layer: [4, 5],
  layerNote: '索引里除了向量还有元数据和倒排表：先按条件过滤，再把关键词和向量两路检索的排名合起来。',
  distNote: `后过滤搜全部 ${N} 个、前过滤只搜 ${CURRENT.length} 个，两个混合检索的问题各搜 ${CURRENT.length} 个；BM25 和 RRF 不算向量距离，一共 ${afterAll} 次。`,
  nodes: ['app', 'meta', 'index', 'bm25', 'results', 'keywords', 'fused'],
  place: { app: [100, 130], meta: [440, 110], index: [440, 420], bm25: [440, 720], results: [860, 360], keywords: [860, 660], fused: [1160, 520] },
  labels: {
    app: ['应用', 'search(q, k, filter)'],
    meta: ['元数据过滤', 'status = current'],
    index: ['向量库', `Flat，${DIM} 维`],
    bm25: ['关键词索引', 'BM25'],
    results: ['向量的前 k 个', '下面是点积'],
    keywords: ['BM25 的前 k 个', '下面是 BM25 分数'],
    fused: ['RRF 融合', '下面是两路的名次'],
  },
  labelAt: { results: [0, 75], keywords: [0, 75], fused: [0, 75] },
  radius: { results: 60, keywords: 60, fused: 60 },
  initial: { results: [], keywords: [], fused: [] },
  start: ['app', 'meta', 'index'],
  legend: [['amber', '该找到的段落'], ['slate', '其他结果'], ['teal', 'BM25'], ['violet', 'RRF'], [null, '距离列：累计算了几次距离']],
  overview: {
    full: '先筛条件，再把两路排名合起来',
    description: `向量检索只看意思近不近，不知道一段文字是不是已经作废、属于哪一类。知识库里还留着《退款说明（2025 版）》，问「${bare(Q_REFUND)}」时它的点积 ${r3(post.beforeFilter[1].score)}，和现行版本的 ${r3(post.beforeFilter[0].score)} 几乎一样：后过滤会让结果不够 k 个，前过滤才能拿满。接着在现行的 ${CURRENT.length} 个段落上比较 BM25 和向量：精确编号 BM25 更准，换了说法向量更准，RRF 只看名次就能把两份排名合起来。`,
    facts: [
      ['过滤条件', 'status = current'],
      ['后过滤', `${post.hits.length} / ${K} 个`],
      ['前过滤', `${pre.hits.length} / ${K} 个`],
      ['RRF', `Σ 1 / (k + 名次)，k = ${RRF_K}`],
      ['Qdrant', 'k = 2，名次从 0 起'],
    ],
  },
  steps: [
    {
      title: '后过滤：结果不够 k 个',
      desc: `前 ${K} 个里筛掉 ${dropped.length} 个，只剩 ${post.hits.length} 个`,
      detail: `后过滤先做向量检索，再把不符合条件的结果扔掉。「${bare(Q_REFUND)}」的前 ${K} 个里，${idOf(dropped[0])} 是 ${PARAGRAPHS[dropped[0]].meta.updated.slice(0, 4)} 年作废的旧版（status = archived），点积 ${r3(post.beforeFilter.find((hit) => hit.id === dropped[0])!.score)}，和现行的 ${idOf(post.beforeFilter[0].id)}（${r3(post.beforeFilter[0].score)}）几乎一样，因为两段只差到账天数。按 status = current 筛掉它，k = ${K} 只剩 ${post.hits.length} 个，搜了全部 ${post.computed} 个向量。pgvector 的文档也提醒：近似索引加过滤条件时是先扫索引再过滤，可能返回不足 k 条。`,
      facts: [['向量检索', `${post.computed} 次距离`], ['过滤前', post.beforeFilter.map((hit) => name(hit.id)).join('、')], ['筛掉', `${idOf(dropped[0])}（archived）`], ['剩下', `${post.hits.length} 个`]],
      events: [
        type(`index.search(q, k=${K}); filter(status == "current")`),
        pk('app', 'index', 'blue', `search(q, k=${K})`, [Q_REFUND], [0, 'SEARCH', `「${Q_REFUND}」先做向量检索，k = ${K}，过滤放到后面`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', qRefund, 'f32', { color: 'blue', digits: 3 }))),
        show('results'),
        pk('index', 'results', 'amber', `前 ${K} 个`, post.beforeFilter.map((hit) => `${name(hit.id)} ${r3(hit.score)}`), [afterPost, 'SEARCH', `搜全部 ${post.computed} 个：${post.beforeFilter.map((hit) => `${idOf(hit.id)} ${r3(hit.score)}`).join('、')}`, K * 12],
          wire('过滤之前的前 k 个', 'mem', 'internal', ...searchOutput(post.beforeFilter, K)),
          { ds: { results: [hitRow('r', post.beforeFilter, { good: ['refund#0', 'refund#1'] })] } }),
        pk('results', 'meta', 'slate', '按 status 筛', post.beforeFilter.map((hit) => `${name(hit.id)}：${PARAGRAPHS[hit.id].meta.status}`), [afterPost, 'FILTER', `后过滤：${idOf(dropped[0])} 的 status 是 archived，扔掉，只剩 ${post.hits.length} 个`, null],
          wire('每个结果的元数据', 'vals', '示意', concept('meta', post.beforeFilter.map((hit): [string, string, string] => [`${name(hit.id)} ${idOf(hit.id)}`, `${PARAGRAPHS[hit.id].meta.status} · ${PARAGRAPHS[hit.id].meta.updated}`, isCurrent(hit.id) ? '保留。' : `${PARAGRAPHS[hit.id].title}已作废，扔掉。`]), 'slate')),
          { ds: { results: [hitRow('r', post.hits, { k: K, good: ['refund#0', 'refund#1'] })] } }),
        note('results', `只剩 ${post.hits.length} 个`, 'amber'),
      ],
    },
    {
      title: '前过滤：先筛再搜',
      desc: `只搜 ${pre.computed} 个，拿满 ${pre.hits.length} 个`,
      detail: `前过滤反过来：先按元数据挑出 ${pre.allowed.length} 个现行段落，只在它们里面做向量检索，算 ${pre.computed} 次距离，前 ${K} 个是 ${pre.hits.map((hit) => idOf(hit.id)).join('、')}，一个不少。前过滤要求索引能只在候选里搜：Flat 直接只算候选，IVF、HNSW 这类近似索引要专门支持，各家做法不同：Qdrant 的可过滤 HNSW 在图里搜索时就应用过滤，Pinecone 支持按元数据的等于、比较、in 等条件过滤。小库直接用 Flat 先筛再搜最简单，也最准。`,
      facts: [['候选', `${pre.allowed.length} 个现行段落`], ['距离计算', `${pre.computed} 次`], ['结果', pre.hits.map((hit) => name(hit.id)).join('、')], ['第 3 名', `${idOf(pre.hits[2].id)} ${r2(pre.hits[2].score)}`]],
      events: [
        pk('app', 'meta', 'slate', 'filter 在前', [`status = current`, `${pre.allowed.length} / ${N} 个`], [afterPost, 'FILTER', `前过滤：先按 status = current 挑出 ${pre.allowed.length} 个段落（作废的 ${ARCHIVED.map((i) => idOf(i)).join('、')} 不在里面）`, null],
          wire('过滤条件', 'vals', '示意', concept('filter', [['status', 'current', `${N} 个段落里 ${pre.allowed.length} 个符合。`], ['排除', ARCHIVED.map((i) => idOf(i)).join('、'), '已作废的旧版本。']], 'slate')),
          { ds: { results: [] } }),
        pk('meta', 'index', 'slate', `${pre.allowed.length} 个候选`, [`排除 ${ARCHIVED.map((i) => name(i)).join('、')}`], [afterPost, 'FILTER', `把 ${pre.allowed.length} 个候选的 id 交给向量库`, null],
          wire('候选', 'vals', '示意', concept('候选的段落', pre.allowed.map((i): [string, string, string] => [`${i} · ${name(i)}`, idOf(i), `${PARAGRAPHS[i].meta.category} · ${PARAGRAPHS[i].meta.updated}`]), 'slate'))),
        pk('index', 'results', 'amber', `前 ${K} 个`, pre.hits.map((hit) => `${name(hit.id)} ${r2(hit.score)}`), [afterPre, 'SEARCH', `只在 ${pre.computed} 个候选里搜：${pre.hits.map((hit) => `${idOf(hit.id)} ${r2(hit.score)}`).join('、')}`, K * 12],
          wire('前过滤之后的前 k 个', 'mem', 'internal', ...searchOutput(pre.hits, K)),
          { ds: { results: [hitRow('r', pre.hits, { good: ['refund#0', 'refund#1'] })] } }),
        state('index', { 候选: `${pre.allowed.length} 个`, 过滤: '前过滤' }),
        note('results', `拿满 ${K} 个`, 'green'),
      ],
    },
    {
      title: 'BM25 赢：精确的编号',
      desc: `「${bare(Q_CODE)}」BM25 第 1 是 ${nameId(codeKwFirst)}`,
      detail: `从这里开始只在 ${CURRENT.length} 个现行段落里检索。「${bare(Q_CODE)}」问的是配件 SR-35，BM25 按字面打分（k1 = ${BM25_K1}，b = ${BM25_B}），只有 ${GOOD_CODE} 含「sr」「35」两个词，它以 ${r2(code.keyword.ranked[0].score)} 分排第 1。向量检索的第 1 名却是 ${codeVecFirst}（${nameId(codeVecFirst)}，保温杯 BW-350 的商品页，点积 ${r2(code.vectorRanked[0].score)}），${GOOD_CODE} 排第 ${rankIn(code.vectorRanked, GOOD_CODE)}（${r2(code.vectorRanked.find((d) => d.id === GOOD_CODE)!.score)}）：向量像是只记住了「这是保温杯商品这一类」，分不清是哪个编号。型号、订单号、错误码这类查询，字面匹配更可靠。`,
      facts: [['BM25 第 1', `${codeKwFirst} ${r2(code.keyword.ranked[0].score)}`], ['向量第 1', `${codeVecFirst} ${r2(code.vectorRanked[0].score)}`], [`向量里的 ${GOOD_CODE}`, `第 ${rankIn(code.vectorRanked, GOOD_CODE)} 名`], ['距离计算', `${CURRENT.length} 次（BM25 不算）`]],
      events: [
        type(`hybrid("${Q_CODE}")`),
        show('bm25'),
        pk('app', 'bm25', 'teal', 'BM25', [Q_CODE], [afterPre, 'KEYWORD', `「${Q_CODE}」切成 ${code.embed.terms.join('、')}，BM25 只在字面命中的段落上给分`, null],
          wire('BM25 的打分', 'vals', '示意', keywordConcept(code))),
        show('keywords'),
        pk('bm25', 'keywords', 'teal', `BM25 前 ${K}`, code.keyword.ranked.slice(0, K).map((d) => `${nameId(d.id)} ${r2(d.score)}`), [afterPre, 'KEYWORD', `BM25：${code.keyword.ranked.slice(0, K).map((d) => `${d.id} ${r2(d.score)}`).join('、')}`, null],
          wire('BM25 的前 k 个', 'vals', '示意', keywordConcept(code)),
          { ds: { keywords: [rankedRow('k', code.keyword.ranked, GOOD_CODE, 'teal')], results: [] } }),
        pk('app', 'index', 'blue', '向量检索', [Q_CODE], [code.after, 'SEARCH', `同一个问题做向量检索（${CURRENT.length} 个候选）：${code.vectorRanked.slice(0, K).map((d) => `${d.id} ${r2(d.score)}`).join('、')}`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', code.embed.vector, 'f32', { color: 'blue', digits: 3 })),
          { ds: { results: [rankedRow('r', code.vectorRanked, GOOD_CODE, 'slate')] } }),
        note('keywords', `只有 ${nameId(GOOD_CODE)} 含 SR-35`, 'green'),
      ],
    },
    {
      title: '向量赢：换了说法',
      desc: `「${bare(Q_SYN)}」向量第 1 是 ${nameId(synVecFirst)}`,
      detail: `「${bare(Q_SYN)}」和《退款说明》几乎没有共同的词，BM25 只能抓住「${synTerm}」：${synHits.length} 个段落含这个词，积分退回的 ${synKwFirst} 最短，分数反而最高（${r2(syn.keyword.ranked[0].score)}），${GOOD_SYN} 排第 ${rankIn(syn.keyword.ranked, GOOD_SYN)}。向量检索的第 1 名是 ${synVecFirst}（${r2(syn.vectorRanked[0].score)}），查询向量其实就是「退回」这一个词的向量，嵌入模型从这个词和哪些词常在一段里出现学到了它的方向，最近的是《退款说明》这段。同义改写、口语化的问法，向量更可靠。`,
      facts: [['BM25 第 1', `${synKwFirst} ${r2(syn.keyword.ranked[0].score)}`], [`BM25 里的 ${GOOD_SYN}`, `第 ${rankIn(syn.keyword.ranked, GOOD_SYN)} 名 ${r2(syn.keyword.ranked.find((d) => d.id === GOOD_SYN)!.score)}`], ['向量第 1', `${synVecFirst} ${r2(syn.vectorRanked[0].score)}`], ['距离计算', `${CURRENT.length} 次`]],
      events: [
        type(`hybrid("${Q_SYN}")`),
        pk('app', 'bm25', 'teal', 'BM25', [Q_SYN], [code.after, 'KEYWORD', `「${Q_SYN}」只有「${synTerm}」在知识库里出现过`, null],
          wire('BM25 的打分', 'vals', '示意', keywordConcept(syn))),
        pk('bm25', 'keywords', 'teal', `BM25 前 ${K}`, syn.keyword.ranked.slice(0, K).map((d) => `${nameId(d.id)} ${r2(d.score)}`), [code.after, 'KEYWORD', `BM25：${syn.keyword.ranked.slice(0, K).map((d) => `${d.id} ${r2(d.score)}`).join('、')}`, null],
          wire('BM25 的前 k 个', 'vals', '示意', keywordConcept(syn)),
          { ds: { keywords: [rankedRow('k', syn.keyword.ranked, GOOD_SYN, 'teal')], results: [] } }),
        pk('app', 'index', 'blue', '向量检索', [Q_SYN], [syn.after, 'SEARCH', `向量检索（${CURRENT.length} 个候选）：${syn.vectorRanked.slice(0, K).map((d) => `${d.id} ${r2(d.score)}`).join('、')}`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', syn.embed.vector, 'f32', { color: 'blue', digits: 3 })),
          { ds: { results: [rankedRow('r', syn.vectorRanked, GOOD_SYN, 'slate')] } }),
        note('results', `${nameId(GOOD_SYN)} 排第 1`, 'green'),
      ],
    },
    {
      title: `RRF：只看名次合并`,
      desc: `k = ${RRF_K}，${nameId(code.fused[0].id)} 两路都靠前，排第 1`,
      detail: `BM25 分数和点积的量纲不同，没法直接相加；RRF（Cormack 等，SIGIR 2009）只看名次，每份排名给 1 / (k + 名次)，k = ${RRF_K} 是论文用的值，Elasticsearch、OpenSearch 默认也是 ${RRF_K}。「${bare(Q_CODE)}」融合后 ${code.fused[0].id} 第 1（${rrfLine(code.fused[0])} = ${num(code.fused[0].score, 4)}），只在向量里排第 1 的 ${codeVecFirst} 掉到第 ${code.fused.find((d) => d.id === codeVecFirst)!.rank}；「${bare(Q_SYN)}」的 ${syn.fused[0].id} 和 ${syn.fused[1].id} 一个是 1 + 2、一个是 2 + 1，${synTie ? `分数完全相同（${num(syn.fused[0].score, 4)}），本站按先出现的排，换个实现可能相反` : `分数是 ${num(syn.fused[0].score, 4)} 和 ${num(syn.fused[1].score, 4)}`}。Qdrant 的默认 k = 2、名次从 0 起，相当于这里的 k = 1：第 1 名得 ${num(1 / 2, 2)}、第 2 名得 ${num(1 / 3, 2)}，头几名的差距被拉大${qdrantSame ? '，这两个例子的前 3 名没变' : '，这两个例子的名次变了'}。`,
      facts: [['k', `${RRF_K}（论文、Elasticsearch、OpenSearch）`], [`${Q_CODE}`, code.fused.slice(0, K).map((d) => d.id).join('、')], [`${Q_SYN}`, syn.fused.slice(0, K).map((d) => d.id).join('、')], ['Qdrant', 'k = 2，名次从 0 起']],
      events: [
        show('fused'),
        pk('keywords', 'fused', 'violet', 'BM25 的名次', syn.keyword.ranked.slice(0, K).map((d) => `${d.rank}：${nameId(d.id)}`), [syn.after, 'FUSE', `「${Q_SYN}」：BM25 的名次进入 RRF`, null],
          wire('RRF 的输入：BM25', 'vals', '示意', keywordConcept(syn))),
        pk('results', 'fused', 'violet', '向量的名次', syn.vectorRanked.slice(0, K).map((d) => `${d.rank}：${nameId(d.id)}`), [syn.after, 'FUSE', `RRF（k = ${RRF_K}）：${syn.fused.slice(0, K).map((d) => `${d.id} ${num(d.score, 4)}`).join('、')}`, null],
          wire(`RRF：「${Q_SYN}」`, 'vals', '示意', fusedConcept(syn, `k = ${RRF_K}`)),
          { ds: { fused: [fusedRow(syn.fused, GOOD_SYN)] } }),
        pk('fused', 'app', 'violet', `「${bare(Q_CODE)}」融合`, code.fused.slice(0, K).map((d) => `${nameId(d.id)} ${d.ranks.map((r) => r ?? '—').join('+')}`), [syn.after, 'FUSE', `「${Q_CODE}」RRF：${code.fused.slice(0, K).map((d) => `${d.id} ${num(d.score, 4)}`).join('、')}；Qdrant 的写法（k = 2、名次从 0 起）：${code.qdrant.slice(0, K).map((d) => `${d.id} ${num(d.score, 3)}`).join('、')}`, null],
          wire(`RRF：「${Q_CODE}」`, 'vals', '示意', fusedConcept(code, `k = ${RRF_K}`), concept('Qdrant 的默认（k = 2，名次从 0 起）', code.qdrant.slice(0, K).map((doc): [string, string, string] => [`${doc.rank} · ${doc.id}`, num(doc.score, 4), doc.ranks.map((r) => (r === null ? '0' : `1/(2+${r - 1})`)).join(' + ') + '。']), 'slate')),
          { ds: { fused: [fusedRow(code.fused, GOOD_CODE)], keywords: [rankedRow('k', code.keyword.ranked, GOOD_CODE, 'teal')], results: [rankedRow('r', code.vectorRanked, GOOD_CODE, 'slate')] } }),
        note('fused', `${nameId(GOOD_CODE)} 两路都靠前，排第 1`, 'green'),
      ],
    },
  ],
  outro: {
    title: '过滤管「能不能用」，融合管「谁更相关」',
    desc: `后过滤 ${post.hits.length} 个 → 前过滤 ${pre.hits.length} 个；RRF k = ${RRF_K}`,
    text: `元数据过滤把作废、越权、过期的内容挡在外面：后过滤实现简单，但会让结果不够 k 个；前过滤拿得满，近似索引要专门支持。BM25 擅长精确的编号和术语，向量擅长换了说法的问题，RRF 只看名次就能把两份排名合在一起，不用操心分数的量纲；Anthropic 的 Contextual Retrieval 实验里，给块加上上下文的嵌入检索失败率是 3.7%，再加上同样加了上下文的 BM25，降到 2.9%。下一组课把检索放回完整的 RAG 流水线：从文档切块入库，到拼提示、生成带引用的回答。`,
    facts: [['后过滤', `${post.hits.length} / ${K} 个`], ['前过滤', `${pre.hits.length} / ${K} 个，${pre.computed} 次距离`], ['RRF', `Σ 1 / (${RRF_K} + 名次)`], ['下一课', '索引流水线：从文档到向量库']],
  },
};

export { hybridLesson as hybrid };
