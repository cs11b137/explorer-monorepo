/**
 * RAG 流水线第一课：索引流水线。加载器读 12 个原始文件（front matter + Markdown），清洗出正文和元数据；切分器按段落切成 27 块；
 * 一次批量请求把 27 块送去嵌入；向量和每块的记录（文档 id、标题、状态、更新日期、段落位置、正文）写进向量库；最后试查一次。
 *
 * 原始文件的写法、清洗、切块、记录由 core/ingest.ts 真实计算；嵌入请求和响应的字节由 core/api.ts 编码（OpenAI embeddings 的字段，经核对），
 * 响应里的向量和 usage 是本站模型和分词器算的，标 E.G.。tests/narrative.pipeline.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  buildHnsw,
  DistanceMeter,
  embed,
  embeddingsHttpRequest,
  embeddingsHttpResponse,
  embeddingsResponse,
  encodeJson,
  exampleRequestId,
  flatSearch,
  ingestAll,
  OPENAI_EMBED_DIMS,
  OPENAI_EMBED_MODEL,
  PARAGRAPH_VECTORS,
  SHOP,
  type ChunkRecord,
  type EmbeddingsRequest,
} from '../core';
import { chunkBytes, concept, floatVector, httpHead, jsonBody, thousands, utf8Lines, vectorRows, wire } from '../decode/structures';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 走一遍流水线 ----------

export const INGEST = ingestAll();
export const { loaded: LOADED, chunks: CHUNKS, records: RECORDS } = INGEST;

/** 每篇文档在图上的简称（列名）。 */
export const SHORT: Record<string, string> = {
  aftersale: '售后',
  refund: '退款',
  'refund-2025': '旧退款',
  'shipping-fee': '运费',
  delivery: '配送',
  cup: '保温杯',
  kettle: '水壶',
  warranty: '保修',
  invoice: '发票',
  points: '积分',
  coupon: '优惠券',
  contact: '客服',
};

const bytesOf = (text: string): number => utf8Encode(text).length;

/** 第一篇（《售后规则》）逐行展开，其余的整篇一个字段。 */
export const FIRST = LOADED[0];
export const ARCHIVED = LOADED.find((item) => item.doc.meta.status === 'archived')!;

/** 批量嵌入：27 块一次请求，encoding_format 用 base64（官方 Python SDK 不写时自己就这么要）。 */
export const REQUEST: EmbeddingsRequest = { input: CHUNKS.map((chunk) => chunk.text), model: OPENAI_EMBED_MODEL, dimensions: PARAGRAPH_VECTORS[0].length, encoding_format: 'base64' };
export const http = embeddingsHttpRequest(REQUEST);
/** 向量按块的顺序取（ingestAll 的块和 PARAGRAPHS 一一对应，测试核对）。 */
export const VECTORS = CHUNKS.map((_, i) => PARAGRAPH_VECTORS[i]);
export const response = embeddingsResponse(VECTORS, REQUEST);
export const httpResponse = embeddingsHttpResponse(response, exampleRequestId(11));
/** 同一批向量写成 float 数组时的响应。 */
export const floatResponse = embeddingsHttpResponse(embeddingsResponse(VECTORS, { ...REQUEST, encoding_format: 'float' }), exampleRequestId(11));

/** 元数据存储：每块一条记录（JSON）。 */
export const recordsJson = encodeJson(RECORDS);

/** 换成 HNSW（pgvector 的默认 m = 16、ef_construction = 64）建索引要算几次距离：只用来对比，这一课建的是 Flat。 */
export const hnswMeter = new DistanceMeter();
buildHnsw(VECTORS, { M: 16, efConstruction: 64 }, hnswMeter);

/** 试查：嵌入组第一课的那个问题，Flat 暴力比较全部 27 个向量。 */
export const PROBE = '保温杯漏水了怎么办？';
export const probe = embed(PROBE);
export const meter = new DistanceMeter();
export const search = flatSearch(VECTORS, probe.vector, 3, 'ip', meter);
export const hitRecords: ChunkRecord[] = search.hits.map((hit) => RECORDS[hit.id]);
export const hitsJson = encodeJson(hitRecords);

// ---------- 文案用到的数 ----------

export const numbers = {
  docs: LOADED.length,
  rawBytes: LOADED.reduce((sum, item) => sum + bytesOf(item.raw), 0),
  bodyBytes: LOADED.reduce((sum, item) => sum + bytesOf(item.body), 0),
  firstRaw: bytesOf(FIRST.raw),
  firstBody: bytesOf(FIRST.body),
  firstFront: FIRST.frontChars,
  firstBlank: FIRST.blankLines,
  chunks: CHUNKS.length,
  tokens: CHUNKS.reduce((sum, chunk) => sum + chunk.tokens, 0),
  maxTokens: Math.max(...CHUNKS.map((chunk) => chunk.tokens)),
  maxChunk: CHUNKS.reduce((best, chunk) => (chunk.tokens > best.tokens ? chunk : best)).id,
  noTitle: RECORDS.filter((record) => !record.text.includes(record.title)).length,
  requestBytes: http.layout.bytes.length,
  requestBody: http.json.bytes.length,
  responseBytes: httpResponse.layout.bytes.length,
  floatResponseBytes: floatResponse.layout.bytes.length,
  promptTokens: response.usage.prompt_tokens,
  dim: VECTORS[0].length,
  vectorBytes: VECTORS.length * VECTORS[0].length * 4,
  recordsBytes: recordsJson.bytes.length,
  textBytes: RECORDS.reduce((sum, record) => sum + bytesOf(record.text), 0),
  firstRecordBytes: encodeJson(RECORDS[0]).bytes.length,
  bigDims: OPENAI_EMBED_DIMS[OPENAI_EMBED_MODEL],
  bigVectorBytes: VECTORS.length * OPENAI_EMBED_DIMS[OPENAI_EMBED_MODEL] * 4,
  hnswBuild: hnswMeter.total,
  searched: search.computed,
  hitsBytes: hitsJson.bytes.length,
};
const N = numbers;

const c2 = (x: number): string => fixed(x, 2);

// ---------- 图元 ----------

/** 12 篇文档排成一排：简称，下面是清洗后正文的字节数；作废的旧版本变暗。 */
function docRow(stage: 'raw' | 'body' | 'sent'): RowPrim {
  return {
    kind: 'row',
    id: 'd',
    w: 38,
    cells: LOADED.map((item): DsCell => ({
      v: SHORT[item.doc.id],
      key: item.doc.id,
      tone: stage === 'raw' ? 'slate' : item.doc.meta.status === 'archived' ? 'dim' : PART_TONE.doc,
      sub: `${bytesOf(stage === 'raw' ? item.raw : item.body)}B`,
      lift: stage === 'sent' || undefined,
    })),
    marks: stage === 'raw' ? undefined : [{ at: LOADED.indexOf(ARCHIVED), text: 'archived', color: 'amber' }],
  };
}

const MAX_PARAS = Math.max(...LOADED.map((item) => item.doc.paragraphs.length));
const ROWS = Array.from({ length: MAX_PARAS }, (_, i) => `§${i}`);
const COLS = LOADED.map((item) => SHORT[item.doc.id]);
/** 第 r 段、第 c 篇对应的块下标（在 CHUNKS 里），没有这一段时是 −1。 */
const chunkAt = (r: number, c: number): number => CHUNKS.findIndex((chunk) => chunk.doc === LOADED[c].doc.id && chunk.index === r);

/** 块：列是文档，行是段落序号，格子写这一块的 token 数（本站 BPE）；没有这一段的格子留空。 */
function chunkGrid(sent = false): GridPrim {
  return {
    kind: 'grid',
    id: 'c',
    w: 34,
    rows: ROWS,
    cols: COLS,
    cells: ROWS.map((_, r) => COLS.map((_, c): DsCell => {
      const i = chunkAt(r, c);
      if (i < 0) return { v: '', tone: 'empty' };
      return { v: String(CHUNKS[i].tokens), tone: RECORDS[i].status === 'archived' ? 'dim' : PART_TONE.doc, heat: CHUNKS[i].tokens / N.maxTokens, lift: sent || undefined };
    })),
  };
}

/**
 * 向量：同样的格局，每格一个 16 维向量（64 字节）。stored 时格子写它在 Flat 索引里的下标；
 * scores 给出时，格子写它和查询的点积（热力），前 3 个抬高。
 */
function vectorGrid(scores?: readonly number[], stored = false): GridPrim {
  const top = search.hits.map((hit) => hit.id);
  return {
    kind: 'grid',
    id: 'v',
    w: 34,
    rows: ROWS,
    cols: COLS,
    cells: ROWS.map((_, r) => COLS.map((_, c): DsCell => {
      const i = chunkAt(r, c);
      if (i < 0) return { v: '', tone: 'empty' };
      if (!scores) return { v: stored ? `#${i}` : '64B', tone: PART_TONE.vector, heat: 0.45 };
      return { v: c2(scores[i]), tone: top.includes(i) ? 'green' : PART_TONE.vector, heat: Math.max(0, scores[i]), lift: top.includes(i) || undefined };
    })),
  };
}

/** 试查的前 3 个：块 id，下面是余弦。 */
function hitRow(): RowPrim {
  return {
    kind: 'row',
    id: 'h',
    w: 74,
    cells: search.hits.map((hit, i): DsCell => ({ v: RECORDS[hit.id].id, key: RECORDS[hit.id].id, tone: i === 0 ? 'green' : PART_TONE.result, sub: c2(hit.score) })),
  };
}

const RECORD_NOTES: Record<string, string> = {
  '[0]': '一块一条记录。',
  '[0].id': '块 id：文档 id # 段落序号。向量库按它把向量和记录对上，引用时也报它。',
  '[0].doc': '文档 id：要删掉或更新一篇文档时，按它找到这篇的全部块。',
  '[0].title': '文档标题：拼提示时写在资料前面，回答里引用给用户看。',
  '[0].status': '现行还是作废：检索时按它过滤。',
  '[0].updated': '更新日期：判断新旧、按时间过滤。',
  '[0].para': '段落序号。',
  '[0].from': '块在清洗后正文里的起点（字符）。',
  '[0].to': '终点（不含）。和 from 一起能在原文里高亮这一块。',
  '[0].text': '块的正文：检索到之后拼进提示的就是它。',
};

// ---------- 课程 ----------

export const ingest: Lesson = {
  id: 'ingest',
  name: 'INGEST',
  title: '索引流水线：从文档到向量库',
  group: 'pipeline',
  layer: [1, 4],
  layerNote: '从原始文档开始，经过清洗、切块、嵌入，写进向量库：文档、分块、向量、索引四档在这一课里走一遍。',
  distNote: `建 Flat 索引只是把向量平铺存好，一次也不比较；最后试查，和 ${N.searched} 个向量各比一次，一共 ${meter.total} 次。`,
  nodes: ['docs', 'loader', 'text', 'chunker', 'chunks', 'embedder', 'vectors', 'index', 'app', 'results'],
  place: { docs: [70, 120], loader: [420, 120], text: [640, 70], chunker: [960, 190], chunks: [700, 370], embedder: [120, 390], vectors: [450, 665], index: [880, 615], app: [1060, 500], results: [1090, 750] },
  labels: {
    docs: ['文档库', `${N.docs} 个原始文件`],
    loader: ['加载器', '读文件、清洗'],
    text: ['文件和正文', '下面是字节数'],
    chunker: ['切分器', '按段落切'],
    chunks: ['块', '格子里是 token 数'],
    embedder: ['嵌入 API', 'embeddings.create()'],
    vectors: ['向量', `每块 ${N.dim} 维`],
    index: ['向量库', 'Flat + 元数据'],
    app: ['应用', '试查一次'],
    results: ['试查结果', '前 3 块'],
  },
  labelAt: { text: [170, -70], chunks: [-210, 120], vectors: [-210, 120], results: [0, 70] },
  radius: { text: 70, chunks: 90, vectors: 90, results: 50 },
  initial: { text: [], chunks: [], vectors: [], results: [] },
  start: ['docs', 'loader'],
  legend: [['teal', '文档和块'], ['violet', '向量'], ['green', '试查命中'], ['slate', 'HTTP、JSON 和元数据'], [null, '距离列：比较过几次向量']],
  overview: {
    full: '文档怎样变成可以检索的向量',
    description: `检索之前，先要把知识库搬进向量库。这一课把「${SHOP}」的 ${N.docs} 个原始文件走一遍索引流水线：加载器读文件、去掉格式、抽出元数据，切分器切成 ${N.chunks} 块，一次批量请求换回 ${N.chunks} 个向量（${thousands(N.vectorBytes)} 字节），连同每块的记录（${thousands(N.recordsBytes)} 字节）写进向量库，最后用一个问题试查。`,
    facts: [
      ['原始文件', `${N.docs} 个，${thousands(N.rawBytes)} 字节`],
      ['清洗后', `${thousands(N.bodyBytes)} 字节正文`],
      ['块', `${N.chunks} 块，${thousands(N.tokens)} token（本站 BPE）`],
      ['向量', `${N.chunks} × ${N.dim} × 4 = ${thousands(N.vectorBytes)} 字节`],
      ['记录', `${thousands(N.recordsBytes)} 字节 JSON（元数据 + 正文）`],
    ],
  },
  steps: [
    {
      title: '读原始文件',
      desc: `${N.docs} 个文件，共 ${thousands(N.rawBytes)} 字节`,
      detail: `文档库里每篇文档是一个 Markdown 文件：开头两行 --- 之间是 front matter（id、标题、分类、更新日期、状态），然后是一行 # 标题，段落之间空一行。这是本站的示例格式，真实的加载器面对的是 HTML、PDF、Word，要拆的东西更多，目标却一样：拿到干净的正文和能拿来过滤的元数据。《售后规则》这个文件 ${N.firstRaw} 字节，front matter 占了其中 ${N.firstFront} 个字符。`,
      facts: [['文件', `${N.docs} 个`], ['总字节', thousands(N.rawBytes)], ['《售后规则》', `${N.firstRaw} 字节`], ['作废的旧版', ARCHIVED.doc.title]],
      events: [
        show('text'),
        state('docs', { 文件: `${N.docs} 个`, 字节: thousands(N.rawBytes) }),
        pk('docs', 'loader', 'teal', `${N.docs} 个文件`, [`${FIRST.doc.id}.md：${N.firstRaw} 字节`, `共 ${thousands(N.rawBytes)} 字节`], [0, 'LOAD', `读 ${N.docs} 个原始文件，共 ${thousands(N.rawBytes)} 字节（front matter + Markdown）`, N.rawBytes],
          wire('文档库里的原始文件（UTF-8）', 'mem', 'format',
            utf8Lines(`${FIRST.doc.id}.md`, FIRST.raw, {
              color: 'teal',
              summary: '本站的示例格式：front matter + Markdown',
              notes: { 0: 'front matter 开始。', 1: '文档 id：块 id 从它来。', 4: '更新日期：判断新旧、按时间过滤。', 5: '状态：current 现行，archived 作废。', 6: 'front matter 结束。', 8: '标题行：标题已经在元数据里，清洗时去掉。' },
            }),
            ...LOADED.slice(1).map((item) => chunkBytes(`${item.doc.id}.md`, item.raw, [], { color: 'teal', summary: `${item.doc.title}，${item.doc.meta.status}` }))),
          { ds: { text: [docRow('raw')] } }),
        note('loader', `${FIRST.doc.id}.md：${N.firstRaw} 字节`),
      ],
    },
    {
      title: '清洗，抽出元数据',
      desc: `正文剩 ${thousands(N.bodyBytes)} 字节`,
      detail: `加载器把 front matter 解析成元数据，去掉标题行和空行，段落之间只留一个换行，${N.docs} 个文件从 ${thousands(N.rawBytes)} 字节变成 ${thousands(N.bodyBytes)} 字节正文。作废的${ARCHIVED.doc.title}照样进库，状态记成 archived：它的到账时间和现行版本冲突，要在检索时按状态过滤掉。元数据不参与算相似度，但过滤、引用、更新全靠它。`,
      facts: [['正文', `${thousands(N.bodyBytes)} 字节`], ['去掉', `${thousands(N.rawBytes - N.bodyBytes)} 字节`], ['元数据', '分类、更新日期、状态'], ['作废的', `${ARCHIVED.doc.id}：archived`]],
      events: [
        pk('loader', 'text', 'teal', '正文 + 元数据', [`正文 ${thousands(N.bodyBytes)} 字节`, `${ARCHIVED.doc.id}：archived`], [0, 'LOAD', `去掉 front matter、标题行和空行，${N.docs} 篇正文共 ${thousands(N.bodyBytes)} 字节`, N.bodyBytes],
          wire('清洗后的正文，和抽出来的元数据', 'mem', 'format',
            utf8Lines(`${FIRST.doc.id} 正文`, FIRST.body, { color: 'teal', summary: `${N.firstBody} 字节：段落之间一个换行` }),
            ...LOADED.slice(1).map((item) => chunkBytes(`${item.doc.id} 正文`, item.body, [], { color: 'teal', summary: `${item.doc.meta.category} · ${item.doc.meta.updated} · ${item.doc.meta.status}` })),
            jsonBody(`${FIRST.doc.id} 的元数据`, encodeJson(FIRST.doc.meta), { color: 'slate', notes: { category: '分类：按售后、退款……过滤。', updated: '更新日期。', status: '现行还是作废。' } })),
          { ds: { text: [docRow('body')] } }),
        state('loader', { 文件: `${N.docs} 个`, 正文: `${thousands(N.bodyBytes)} B`, 作废: '1 篇' }),
      ],
    },
    {
      title: '切成块',
      desc: `${N.chunks} 块，${thousands(N.tokens)} token`,
      detail: `这里按段落切，一段一块，${N.docs} 篇切出 ${N.chunks} 块：店铺规则一段讲一件事，段落就是天然的边界（固定长度、递归切分和重叠见分块那一课）。最长的一块 ${N.maxChunk} 有 ${N.maxTokens} 个 token，这是本站迷你 BPE 的计数，只代表量级，离嵌入接口每段 8192 token 的上限很远。切开以后，${N.chunks} 块里有 ${N.noTitle} 块的正文不含文档标题，单看一块不知道它出自哪篇，所以记录里要带上标题。`,
      facts: [['块', String(N.chunks)], ['token', `${thousands(N.tokens)}（本站 BPE）`], ['最长', `${N.maxChunk}，${N.maxTokens} token`], ['不含标题', `${N.noTitle} 块`]],
      events: [
        show('chunker'),
        pk('text', 'chunker', 'teal', '按段落切', [`${N.docs} 篇正文`, '一段一块'], [0, 'CHUNK', `${N.docs} 篇正文按换行切成 ${N.chunks} 块`, N.bodyBytes],
          wire('每篇正文和切出来的块（块是正文里的字节区间）', 'mem', 'format', ...LOADED.map((item) => chunkBytes(item.doc.id, item.body, CHUNKS.filter((chunk) => chunk.doc === item.doc.id), { color: 'teal' }))),
          { ds: { text: [docRow('sent')] } }),
        show('chunks'),
        pk('chunker', 'chunks', 'teal', `${N.chunks} 块`, [`共 ${thousands(N.tokens)} token`, `最长 ${N.maxChunk}：${N.maxTokens}`], [0, 'TOKENS', `每块记下字符区间和 token 数，共 ${thousands(N.tokens)} 个 token（本站 BPE）`, null],
          wire('每块的位置和 token 数', 'mem', '示意', concept('块', CHUNKS.map((chunk, i): [string, string, string] => [chunk.id, `${chunk.tokens} token`, `字符 [${chunk.from}, ${chunk.to})，${RECORDS[i].text.includes(RECORDS[i].title) ? '含标题' : '不含标题'}。`]), 'teal')),
          { ds: { chunks: [chunkGrid()] } }),
      ],
    },
    {
      title: '批量嵌入',
      desc: `${N.chunks} 块一次请求，${thousands(N.requestBytes)} 字节`,
      detail: `${N.chunks} 块放进一个 input 数组，一次请求嵌入完（一次最多 2048 段、合计 300,000 token），响应里 data[i] 按 index 和 input 的下标对应。encoding_format 选 base64，响应 ${thousands(N.responseBytes)} 字节；写成 float 数组要 ${thousands(N.floatResponseBytes)} 字节，批量越大差得越多。Anthropic 的 Contextual Retrieval 在这一步之前先让大模型给每块写 50–100 token 的上下文、拼在块前面再嵌入，文中报告检索失败率降了 35%（5.7% → 3.7%），代价是每块多一次模型调用。`,
      facts: [['input', `${N.chunks} 段`], ['请求', `${thousands(N.requestBytes)} 字节`], ['响应（base64）', `${thousands(N.responseBytes)} 字节`], ['响应（float）', `${thousands(N.floatResponseBytes)} 字节`], ['usage', `${thousands(N.promptTokens)} token（本站 BPE）`]],
      events: [
        show('embedder'),
        pk('chunks', 'embedder', 'blue', 'POST /v1/embeddings', [`input: ${N.chunks} 段`, 'encoding_format: base64'], [0, 'HTTP', `批量嵌入：input 是 ${N.chunks} 段的数组，请求体 ${thousands(N.requestBody)} 字节`, N.requestBytes],
          wire('批量嵌入请求', 'mem', 'format',
            httpHead('请求头', http.layout, { mask: { authorization: 'Bearer sk-proj-'.length }, example: ['authorization'], notes: { 'content-length': `请求体 ${thousands(N.requestBody)} 字节，几乎全是 ${N.chunks} 段正文。` } }),
            jsonBody('请求体', http.json, { expand: ['input[0]', 'input[1]'], notes: { input: `${N.chunks} 段正文，一段一个字符串；响应的 data[i].index 对应这里的下标。`, dimensions: `缩到 ${N.dim} 维，和本站模型一致（${OPENAI_EMBED_MODEL} 默认 ${N.bigDims} 维）。`, encoding_format: 'base64：每个向量写成 float32 小端字节的 base64，比十进制数组短。' } })),
          { ds: { chunks: [chunkGrid(true)] } }),
        show('vectors'),
        pk('embedder', 'vectors', 'violet', 'HTTP 200', [`data: ${N.chunks} 个 embedding`, `usage: ${thousands(N.promptTokens)} token`], [0, 'HTTP', `200 OK，${N.chunks} 个向量（base64），响应 ${thousands(N.responseBytes)} 字节；float 写法要 ${thousands(N.floatResponseBytes)} 字节`, N.responseBytes],
          wire('批量嵌入的响应', 'mem', 'format',
            httpHead('响应头', httpResponse.layout, { notes: { 'x-request-id': '这次请求的 id（示例）。' }, example: ['x-request-id'] }),
            jsonBody('响应体', httpResponse.json, {
              expand: ['data[0].embedding', 'usage.prompt_tokens'],
              example: ['data', 'data[0].embedding', 'usage', 'usage.prompt_tokens'],
              notes: { data: `${N.chunks} 个 embedding 对象，按 index 对应 input。向量是本站模型的值（示例）。`, 'data[0].embedding': '64 字节 float32 的 base64。', 'usage.prompt_tokens': '本站 BPE 的计数（示例），真实服务按自己的分词器数。' },
            })),
          { ds: { vectors: [vectorGrid()] } }),
        state('embedder', { 请求: '1 次', 输入: `${N.chunks} 段`, 维度: String(N.dim) }),
      ],
    },
    {
      title: '写进向量库',
      desc: `向量 ${thousands(N.vectorBytes)} 字节，记录 ${thousands(N.recordsBytes)} 字节`,
      detail: `向量库存两样东西：${N.chunks} 个向量平铺成一个 float32 数组（${N.chunks} × ${N.dim} × 4 = ${thousands(N.vectorBytes)} 字节），和按块 id 对上的 ${N.chunks} 条记录：文档 id、标题、状态、更新日期、段落序号、字符区间和正文，写成 JSON ${thousands(N.recordsBytes)} 字节，其中正文 ${thousands(N.textBytes)} 字节。本站的向量只有 ${N.dim} 维，所以记录比向量还大；换成 ${OPENAI_EMBED_MODEL} 默认的 ${N.bigDims} 维，向量就有 ${thousands(N.bigVectorBytes)} 字节。这里建的是 Flat 索引，写入不用比较任何向量；换成 HNSW（参数取 pgvector 的默认 m = 16、ef_construction = 64），本站的实现插入这 ${N.chunks} 个向量要算 ${N.hnswBuild} 次距离，换来查询时少比较。`,
      facts: [['向量', `${thousands(N.vectorBytes)} 字节 float32`], ['记录', `${thousands(N.recordsBytes)} 字节 JSON`], ['一条记录', `${N.firstRecordBytes} 字节`], [`${N.bigDims} 维时`, `${thousands(N.bigVectorBytes)} 字节`], ['HNSW 建图', `${N.hnswBuild} 次距离`]],
      events: [
        show('index'),
        pk('vectors', 'index', 'violet', '写入', [`向量 ${thousands(N.vectorBytes)} 字节`, `记录 ${thousands(N.recordsBytes)} 字节`], [0, 'INDEX', `Flat 索引：${N.chunks} 个向量平铺存放，记录按块 id 对上；写入不比较向量`, N.vectorBytes + N.recordsBytes],
          wire('向量库里存的两样东西（平铺的摆法是 Flat 索引的内部布局）', 'mem', 'internal',
            vectorRows('vectors', RECORDS.map((record) => record.id), VECTORS, { summary: `第 i 个向量从 i × ${N.dim * 4} 字节开始，按下标就能找到；下标 i 对应第 i 条记录` }),
            jsonBody('记录（元数据存储）', recordsJson, { color: 'slate', expand: ['[0].id', '[0].doc', '[0].title', '[0].status', '[0].updated', '[0].para', '[0].from', '[0].to', '[0].text'], notes: RECORD_NOTES })),
          { ds: { vectors: [vectorGrid(undefined, true)] } }),
        state('index', { 索引: 'Flat', 向量: `${N.chunks} × ${N.dim * 4} B`, 记录: `${thousands(N.recordsBytes)} B` }),
      ],
    },
    {
      title: '试查一次',
      desc: `比较 ${N.searched} 次，第一名 ${hitRecords[0].id}`,
      detail: `入库之后用一个问题试查：应用把「${PROBE.replace(/？$/, '')}」嵌入成查询向量，Flat 索引和 ${N.searched} 个向量各算一次点积，取最大的 3 个。前 3 名是 ${hitRecords.map((record, i) => `${record.id}（${c2(search.hits[i].score)}）`).join('、')}，都出自${hitRecords[0].title}。向量库返回的是记录而不只是下标：标题、状态和正文跟着结果一起回来，下一课拼提示、标来源就用它们。`,
      facts: [['查询', PROBE], ['距离计算', `${meter.total} 次`], ...hitRecords.map((record, i): [string, string] => [`第 ${i + 1}`, `${record.id} · ${c2(search.hits[i].score)}`])],
      events: [
        show('app'),
        type(`search(query, k=3)`),
        pk('app', 'index', 'blue', '查询向量', [`「${PROBE}」`, `${N.dim} 维 float32`], [0, 'SEARCH', `查询向量 ${N.dim} 维，${N.dim * 4} 字节，k = 3`, N.dim * 4],
          wire('查询向量（float32 小端）', 'mem', 'format', floatVector('query', probe.vector, 'f32', { color: 'blue', summary: PROBE, digits: 3 }))),
        show('results'),
        pk('index', 'results', 'amber', `前 3 块`, hitRecords.map((record, i) => `${record.id} ${c2(search.hits[i].score)}`), [meter.total, 'SEARCH', `和 ${N.searched} 个向量各算一次点积，取前 3 个，连同记录返回`, N.hitsBytes],
          wire('返回的前 3 条记录', 'mem', 'format', jsonBody('结果', hitsJson, { color: 'amber', notes: Object.fromEntries(hitRecords.map((_, i) => [`[${i}]`, `第 ${i + 1} 名，点积 ${c2(search.hits[i].score)}。`])) })),
          { ds: { results: [hitRow()], vectors: [vectorGrid(search.scores)] } }),
        note('results', `${hitRecords[0].id}：${c2(search.hits[0].score)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '向量库里有什么',
    desc: `${N.docs} 个文件 → ${N.chunks} 块 → ${thousands(N.vectorBytes)} 字节向量`,
    text: `索引流水线是离线做的：加载、清洗、切块、嵌入、写入，文档改了就对改动的那篇重做一遍（按记录里的文档 id 找到它的全部块）。向量库里除了向量，还有每块的记录：标题和正文用来拼提示、标来源，状态和日期用来过滤。下一课把这些块用起来：一次完整的检索增强问答，从检索到拼提示、生成，再到核对引用。`,
    facts: [['块', String(N.chunks)], ['向量', `${thousands(N.vectorBytes)} 字节`], ['记录', `${thousands(N.recordsBytes)} 字节`], ['下一课', '一次检索增强问答']],
  },
};
