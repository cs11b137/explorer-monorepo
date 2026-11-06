/**
 * RAG 流水线第二课：一次检索增强问答。CONTEXT EXPLORER 那个客服 Agent 处理订单 A1024 的保温杯漏水，调用 search_docs：
 * 问题嵌入成查询向量 → Flat 检索前 3 块 → 拼成带编号来源的提示 → 发给 Claude → 回答里每句标来源 → 逐句核对引用。
 *
 * 检索、提示的字节和 token 数、引用核对都由 core/ 真实计算（rag.ts 的 buildPrompt、checkCitations）。模型的回答是写死的示例（ANSWER），
 * 界面标 E.G.：本站不跑大模型；它故意让第三句引用了一条不支持它的来源，核对由 core 真算出来。tests/narrative.pipeline.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  checkCitations,
  CLAUDE_MODEL,
  countTokens,
  DistanceMeter,
  embed,
  embeddingsHttpRequest,
  encodeJson,
  EXAMPLE_ANTHROPIC_KEY,
  exampleMessageId,
  exampleRequestId,
  flatSearch,
  messageBody,
  messagesHttpRequest,
  messagesHttpResponse,
  OPENAI_EMBED_MODEL,
  ORDER_ID,
  PARAGRAPH_VECTORS,
  PARAGRAPHS,
  paragraphById,
  RAG_INSTRUCTION,
  buildPrompt,
  searchResultBlocks,
  supports,
  type MessagesRequest,
} from '../core';
import { concept, floatVector, httpHead, jsonBody, promptParts, thousands, utf8Text, wire } from '../decode/structures';
import { fixed, PART_TONE, vectorRow } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, RowPrim, TowerPrim } from './types';
import type { Lesson } from './types';

// ---------- 问题和检索 ----------

/** 客服 Agent 调用 search_docs 时的 query：用户说杯盖漏水，想知道能不能换货。 */
export const QUESTION = '保温杯漏水，可以换货吗？';
export const K = 3;

export const q = embed(QUESTION);
export const embedRequest = embeddingsHttpRequest({ input: QUESTION, model: OPENAI_EMBED_MODEL, dimensions: q.vector.length, encoding_format: 'float' });

export const meter = new DistanceMeter();
export const search = flatSearch(PARAGRAPH_VECTORS, q.vector, K, 'ip', meter);
export const PASSAGES = search.hits.map((hit) => PARAGRAPHS[hit.id]);

// ---------- 提示 ----------

export const prompt = buildPrompt(QUESTION, PASSAGES);
export const promptBytes = utf8Encode(prompt.text).length;
const partTokens = (kind: string) => prompt.parts.filter((part) => part.kind === kind).reduce((sum, part) => sum + part.tokens, 0);

/** 发给 Claude 的请求：提示整段放进一条 user 消息。 */
export const REQUEST: MessagesRequest = { model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt.text }] };
export const http = messagesHttpRequest(REQUEST);
/** 同样的资料写成 search_result 块（Claude 会返回 search_result_location 引用），问题放在后面的 text 块。 */
export const SR_REQUEST: MessagesRequest = { model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: [...searchResultBlocks(PASSAGES), { type: 'text', text: QUESTION }] }] };
export const srHttp = messagesHttpRequest(SR_REQUEST);

// ---------- 回答（示例）和引用核对 ----------

/**
 * 模型的回答：写死的示例（E.G.）。前两句照资料 [1]、[2] 说；第三句说的是《售后规则》第 4 条（拍照上传），
 * 这一条没有被检索到，模型却把它标成了 [3]。核对用 core 的 checkCitations 真算。
 */
export const ANSWER = '可以换货：签收后 15 天内出现质量问题都可以换货，来回运费由店铺承担 [1]。签收后 7 天内，质量问题也可以直接退款 [2]。申请前要先在订单详情里拍照上传漏水的部位，客服确认后再寄回 [3]。';
export const check = checkCitations(ANSWER, prompt.sources);
export const message = messageBody(ANSWER, prompt.tokens, exampleMessageId(7));
export const httpResponse = messagesHttpResponse(message, exampleRequestId(7));
/** 第三句真正的出处：《售后规则》第 4 条（没被检索到）。 */
export const RULE4 = paragraphById('aftersale#3');
export const rule4Support = supports(check.sentences[2].text, [RULE4.text]);
/** 讲密封圈的那段（漏水最直接的处理办法）排在第几。 */
export const sealRank = flatSearch(PARAGRAPH_VECTORS, q.vector, PARAGRAPH_VECTORS.length).hits.findIndex((hit) => PARAGRAPHS[hit.id].id === 'cup#1') + 1;

// ---------- 文案用到的数 ----------

export const numbers = {
  embedRequestBytes: embedRequest.layout.bytes.length,
  searched: search.computed,
  promptChars: [...prompt.text].length,
  promptBytes,
  promptTokens: prompt.tokens,
  instructionTokens: partTokens('instruction'),
  sourceTokens: partTokens('source'),
  questionTokens: partTokens('question'),
  separatorTokens: partTokens('separator'),
  requestBytes: http.layout.bytes.length,
  requestBody: http.json.bytes.length,
  srRequestBytes: srHttp.layout.bytes.length,
  srRequestBody: srHttp.json.bytes.length,
  responseBytes: httpResponse.layout.bytes.length,
  answerTokens: countTokens(ANSWER),
  supported: check.supported,
  total: check.total,
  sealRank,
};
const N = numbers;
const c2 = (x: number): string => fixed(x, 2);
const bare = (text: string): string => text.replace(/[？。]$/, '');
const STATUS_TEXT = { supported: '有出处', unsupported: '没出处', uncited: '没标', 'bad-source': '编号不对' } as const;

// ---------- 图元 ----------

const queryRow = (): RowPrim => vectorRow('q', q.vector, { tone: PART_TONE.query, keyPrefix: 'q', w: 24 });

function resultRow(): RowPrim {
  return {
    kind: 'row',
    id: 'r',
    w: 78,
    cells: PASSAGES.map((passage, i): DsCell => ({ v: passage.id, key: passage.id, tone: PART_TONE.result, sub: c2(search.hits[i].score) })),
  };
}

function promptTower(): TowerPrim {
  return {
    kind: 'tower',
    id: 'p',
    frames: [
      { key: 'q', text: `问题 · ${N.questionTokens} token`, tone: PART_TONE.query },
      ...[...prompt.sources].reverse().map((source) => ({ key: `s${source.n}`, text: `[${source.n}] ${source.id} · ${prompt.parts.find((part) => part.n === source.n)!.tokens} token`, tone: PART_TONE.doc })),
      { key: 'i', text: `说明 · ${N.instructionTokens} token`, tone: PART_TONE.overhead },
    ],
  };
}

/** 回答的每一句：标的来源编号；checked 后写核对结果（有出处绿色，没出处琥珀色）。 */
function answerRow(checked: boolean): RowPrim {
  return {
    kind: 'row',
    id: 'a',
    w: 78,
    cells: check.sentences.map((sentence, i): DsCell => ({
      v: `句${i + 1} [${sentence.cites.join(',')}]`,
      key: `a${i}`,
      tone: !checked ? PART_TONE.answer : sentence.status === 'supported' ? 'green' : 'amber',
      sub: checked ? STATUS_TEXT[sentence.status] : 'E.G.',
      lift: (checked && sentence.status !== 'supported') || undefined,
    })),
  };
}

// ---------- 课程 ----------

export const qa: Lesson = {
  id: 'qa',
  name: 'RAG Q&A',
  title: '一次检索增强问答（检索 → 拼提示 → 生成 → 引用）',
  group: 'pipeline',
  layer: [3, 7],
  layerNote: '问题先变成向量、在索引里检索，检索到的块拼进提示，模型据此写出回答：从向量一直走到回答。',
  distNote: `检索时查询向量和 ${N.searched} 个块的向量各比一次，一共 ${meter.total} 次；拼提示、生成、核对引用都不比较向量。`,
  nodes: ['app', 'embedder', 'query', 'index', 'results', 'prompt', 'llm', 'answer'],
  place: { app: [100, 700], embedder: [110, 150], query: [480, 90], index: [960, 200], results: [900, 480], prompt: [680, 430], llm: [250, 390], answer: [640, 730] },
  labels: {
    app: ['客服 Agent', `订单 ${ORDER_ID}`],
    embedder: ['嵌入 API', 'embeddings.create()'],
    query: ['查询向量', `${q.vector.length} 维`],
    index: ['向量库', `Flat，${PARAGRAPHS.length} 块`],
    results: ['检索结果', `前 ${K} 块`],
    prompt: ['提示', '每部分的 token 数'],
    llm: ['Claude', CLAUDE_MODEL],
    answer: ['回答', '每句标的来源'],
  },
  labelAt: { query: [-140, 50], results: [0, 75], prompt: [0, 95], answer: [200, 10] },
  radius: { query: 60, results: 60, prompt: 80, answer: 60 },
  initial: { query: [], results: [], prompt: [], answer: [] },
  start: ['app', 'embedder'],
  legend: [['blue', '问题和查询'], ['teal', '资料'], ['amber', '检索结果、没出处的句子'], ['green', '回答和有出处的句子'], ['slate', '说明和协议开销'], [null, '距离列：比较过几次向量']],
  overview: {
    full: '检索、拼提示、生成、核对引用',
    description: `CONTEXT EXPLORER 里那个客服 Agent 在处理订单 ${ORDER_ID}：用户说保温杯漏水。Agent 调用 search_docs 查「${QUESTION}」，背后是一次完整的检索增强问答：问题嵌入成向量，在向量库里找最近的 ${K} 块，拼成 ${N.promptTokens} 个 token 的提示交给 Claude，回答的每句话标出来源编号，最后逐句核对这些编号是不是真的对得上。`,
    facts: [
      ['问题', QUESTION],
      ['检索', `Flat，前 ${K} 块，${meter.total} 次距离计算`],
      ['提示', `${N.promptBytes} 字节，${N.promptTokens} token（本站 BPE）`],
      ['请求', `${N.requestBytes} 字节（search_result 写法 ${thousands(N.srRequestBytes)}）`],
      ['引用核对', `${N.total} 句里 ${N.supported} 句有出处`],
    ],
  },
  steps: [
    {
      title: '问题变成查询向量',
      desc: `嵌入请求 ${N.embedRequestBytes} 字节，${q.vector.length} 维`,
      detail: `Agent 调用 search_docs，参数 query 是「${bare(QUESTION)}」。工具这一侧先把它发给嵌入 API，用的必须是建索引时同一个模型、同一个维数，否则查询向量和库里的向量不在同一个空间里，比较没有意义。本站模型认识这句话里的${q.known.map((hit) => `「${hit.term}」`).join('')}，其余 ${q.unknown.length} 个二元组不在词表里。`,
      facts: [['query', QUESTION], ['认识的词', q.known.map((hit) => hit.term).join('、')], ['请求', `${N.embedRequestBytes} 字节`], ['向量', `${q.vector.length} 维 float32`]],
      events: [
        type(`search_docs({ query })`),
        pk('app', 'embedder', 'blue', 'POST /v1/embeddings', [`input: ${QUESTION}`, `dimensions: ${q.vector.length}`], [0, 'HTTP', `嵌入查询：input「${QUESTION}」，模型和建索引时相同`, N.embedRequestBytes],
          wire('嵌入查询的请求', 'mem', 'format',
            httpHead('请求头', embedRequest.layout, { mask: { authorization: 'Bearer sk-proj-'.length }, example: ['authorization'] }),
            jsonBody('请求体', embedRequest.json, { notes: { input: 'search_docs 的 query 参数。', model: '和建索引时同一个模型。', dimensions: '和库里的向量同一个维数。' } }))),
        show('query'),
        pk('embedder', 'query', 'blue', '查询向量', q.known.map((hit) => hit.term), [0, 'EMBED', `认识 ${q.known.length} 个词，加权平均、归一化，得到 ${q.vector.length} 维查询向量`, q.vector.length * 4],
          wire('查询向量（float32 小端）', 'mem', 'format', floatVector('query', q.vector, 'f32', { color: 'blue', summary: QUESTION, digits: 3 })),
          { ds: { query: [queryRow()] } }),
      ],
    },
    {
      title: `检索前 ${K} 块`,
      desc: `比较 ${N.searched} 次，取最大的 ${K} 个`,
      detail: `Flat 索引拿查询向量和 ${N.searched} 块的向量各算一次点积，取最大的 ${K} 个：${PASSAGES.map((passage, i) => `${passage.id}（${c2(search.hits[i].score)}）`).join('、')}，都是《售后规则》里讲换货、退货的条款。讲杯盖漏水怎么处理的 cup#1 排在第 ${N.sealRank}，没进前 ${K}。第 3 名 ${PASSAGES[2].id} 讲的是无理由退货，和漏水关系不大，但向量离得近，照样进了结果。`,
      facts: [['距离计算', `${meter.total} 次`], ...PASSAGES.map((passage, i): [string, string] => [`第 ${i + 1}`, `${passage.id} · ${c2(search.hits[i].score)}`]), ['cup#1', `第 ${N.sealRank}`]],
      events: [
        show('index'),
        pk('query', 'index', 'blue', `k = ${K}`, [`${q.vector.length} 维查询向量`, `和 ${N.searched} 个向量比`], [0, 'SEARCH', `查询向量送进向量库，k = ${K}`, q.vector.length * 4],
          wire('查询向量', 'mem', 'format', floatVector('query', q.vector, 'f32', { color: 'blue', summary: `k = ${K}`, digits: 3 })),
          { ds: { query: [queryRow()] } }),
        show('results'),
        pk('index', 'results', 'amber', `前 ${K} 块`, PASSAGES.map((passage, i) => `${passage.id} ${c2(search.hits[i].score)}`), [meter.total, 'SEARCH', `和 ${N.searched} 个向量各算一次点积，取前 ${K}：${PASSAGES.map((passage) => passage.id).join('、')}`, encodeJson(PASSAGES.map(({ id, title, text }) => ({ id, title, text }))).bytes.length],
          wire('检索结果：块 id、标题、正文', 'mem', 'format', jsonBody('结果', encodeJson(PASSAGES.map(({ id, title, text }) => ({ id, title, text }))), { color: 'amber', notes: Object.fromEntries(PASSAGES.map((_, i) => [`[${i}]`, `第 ${i + 1} 名，点积 ${c2(search.hits[i].score)}。`])) })),
          { ds: { results: [resultRow()] } }),
        note('results', `cup#1 排第 ${N.sealRank}`, 'amber'),
      ],
    },
    {
      title: '拼成提示',
      desc: `${N.promptBytes} 字节，${N.promptTokens} token`,
      detail: `core 的 buildPrompt 按固定的格式拼：一段说明（只根据资料回答、句末标来源编号、资料里没有就说不知道），${K} 条资料各占一行、前面写 [1] [2] [3]，最后是问题。${N.promptTokens} 个 token 里资料占 ${N.sourceTokens}，说明 ${N.instructionTokens}，问题只有 ${N.questionTokens}（本站迷你 BPE 的计数，只代表量级）。编号是后面核对引用的钥匙：模型写 [2]，就能找回第 2 条资料原文去对。`,
      facts: [['说明', `${N.instructionTokens} token`], ['资料', `${N.sourceTokens} token，${K} 条`], ['问题', `${N.questionTokens} token`], ['合计', `${N.promptTokens} token，${N.promptBytes} 字节`]],
      events: [
        show('prompt'),
        pk('results', 'prompt', 'teal', 'buildPrompt', [`[1]–[${K}] ${K} 条资料`, `${N.promptTokens} token`], [meter.total, 'PROMPT', `说明 ${N.instructionTokens} + 资料 ${N.sourceTokens} + 问题 ${N.questionTokens} + 换行 ${N.separatorTokens} = ${N.promptTokens} token（本站 BPE）`, N.promptBytes],
          wire('拼好的提示（UTF-8）', 'mem', 'format', promptParts('提示', prompt, { notes: { instruction: `说明：${RAG_INSTRUCTION}`, '[1]': `${PASSAGES[0].id}：段落以标题开头，不再补标题。`, '[3]': `${PASSAGES[2].id}：无理由退货，和问题关系不大。`, question: '用户的问题放在最后。' } })),
          { ds: { prompt: [promptTower()] } }),
      ],
    },
    {
      title: '交给 Claude 生成',
      desc: `请求 ${N.requestBytes} 字节，回答 ${N.total} 句（示例）`,
      detail: `提示整段放进一条 user 消息，POST 到 Messages API，model、max_tokens、messages 三个字段必填，请求一共 ${N.requestBytes} 字节。Claude 也接受另一种写法：每条资料写成一个 search_result 内容块（type、source、title、content 必填，citations 默认关闭、要开就全部开），回答会自动带上 search_result_location 引用，指明引的是第几个结果的哪几个块，这个请求是 ${thousands(N.srRequestBytes)} 字节。下面的回答是写死的示例（本站不跑大模型），${N.total} 句各标了一个编号。`,
      facts: [['请求', `${N.requestBytes} 字节`], ['search_result 写法', `${thousands(N.srRequestBytes)} 字节`], ['回答', `${N.answerTokens} token（示例，本站 BPE）`], ['响应', `${N.responseBytes} 字节`]],
      events: [
        show('llm'),
        pk('prompt', 'llm', 'violet', 'POST /v1/messages', [`messages[0].content: ${N.promptTokens} token`, `max_tokens: ${REQUEST.max_tokens}`], [meter.total, 'HTTP', `Messages API 请求：提示放进一条 user 消息，请求 ${N.requestBytes} 字节`, N.requestBytes],
          wire('发给 Claude 的请求', 'mem', 'format',
            httpHead('请求头', http.layout, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'], notes: { 'anthropic-version': 'API 版本头，必填。', 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_ANTHROPIC_KEY.length} 个字符，这里打码）。` } }),
            jsonBody('请求体', http.json, { expand: ['messages[0].content'], notes: { model: '模型 id。', max_tokens: '回答最多多少 token，必填。', messages: '一条 user 消息，内容就是拼好的提示。' } }),
            jsonBody('另一种写法：search_result 块', srHttp.json, { color: 'teal', root: 'messages[0].content', expand: ['messages[0].content[0].source', 'messages[0].content[0].title', 'messages[0].content[0].citations'], summary: `同样的资料写成 ${K} 个 search_result 块，请求体 ${N.srRequestBody} 字节`, notes: { 'messages[0].content[0].source': '任何稳定的字符串，这里用 kb://块 id；引用里原样带回。', 'messages[0].content[0].title': '标题，引用里原样带回。', 'messages[0].content[0].citations': '默认关闭；同一个请求里的 search_result 要么都开、要么都关。' } })),
          { ds: { prompt: [promptTower()] } }),
        show('answer'),
        pk('llm', 'answer', 'green', '回答（示例）', check.sentences.map((sentence, i) => `句${i + 1} [${sentence.cites.join(',')}]`), [meter.total, 'INFER', `回答 ${N.total} 句，每句末尾标来源编号（内容是示例）`, N.responseBytes],
          wire('Claude 的响应（回答是示例）', 'mem', 'format',
            httpHead('响应头', httpResponse.layout, { notes: { 'request-id': '这次请求的 id（示例）。' }, example: ['request-id'] }),
            jsonBody('响应体', httpResponse.json, { expand: ['content[0].text', 'usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content', 'content[0].text', 'usage', 'usage.input_tokens', 'usage.output_tokens'], notes: { 'content[0].text': '回答原文：写死的示例，本站不跑大模型。', 'usage.input_tokens': '提示的 token 数（本站 BPE，示例）。', 'usage.output_tokens': '回答的 token 数（本站 BPE，示例）。', stop_reason: 'end_turn：自然写完。' } })),
          { ds: { answer: [answerRow(false)] } }),
        state('llm', { 输入: `${N.promptTokens} token`, 输出: `${N.answerTokens} token` }),
      ],
    },
    {
      title: '核对引用',
      desc: `${N.total} 句里 ${N.supported} 句有出处`,
      detail: `core 的 checkCitations 把回答按句切开，抽出每句的 [n]，再看第 n 条资料是否支持这句话：句子里的数字和编号要一字不差地出现在资料里，句子的词至少有一半在资料里出现过。前两句通过；第三句说要先拍照上传，这其实是《售后规则》第 4 条（${RULE4.id}，拿它来核对，覆盖率 ${c2(rule4Support.coverage)}，能通过），可它没被检索到，[3] 讲的是无理由退货，词覆盖率只有 ${c2(check.sentences[2].support!.coverage)}。说得对不等于有出处：这句要么删掉，要么把第 4 条检索进来，这个判据是本站的字面近似，真实系统常让另一个大模型来判断。`,
      facts: check.sentences.map((sentence, i): [string, string] => [`句${i + 1} [${sentence.cites.join(',')}]`, `${STATUS_TEXT[sentence.status]}（覆盖 ${c2(sentence.support!.coverage)}）`]),
      events: [
        pk('answer', 'app', 'green', '核对引用', check.sentences.map((sentence, i) => `句${i + 1}：${STATUS_TEXT[sentence.status]}`), [meter.total, 'CITE', `逐句核对：${N.supported} 句有出处，句3 标的 [3] 不支持它`, utf8Encode(ANSWER).length],
          wire('回答的每一句和核对结果', 'mem', 'format',
            utf8Text('回答（示例）', ANSWER, { color: 'green', summary: `${[...ANSWER].length} 个字符，模型写的示例` }),
            ...check.sentences.map((sentence, i) => concept(`句${i + 1} → [${sentence.cites.join(',')}]`, [
              ['句子', sentence.text],
              ['关键事实', sentence.support!.facts.join('、') || '（没有数字或编号）', '数字连单位、字母数字编号，要一字不差地出现在来源里。'],
              ['词覆盖率', c2(sentence.support!.coverage), `句子的汉字二元组有多大比例出现在来源里，至少 0.5。`],
              ['结论', STATUS_TEXT[sentence.status], sentence.status === 'supported' ? '来源支持这句话。' : `来源 [${sentence.cites.join(',')}] 里没有这件事；它出自 ${RULE4.id}，没被检索到。`],
            ], sentence.status === 'supported' ? 'green' : 'amber'))),
          { ds: { answer: [answerRow(true)] } }),
        render,
        note('answer', `句3 没出处`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '检索决定了回答能说什么',
    desc: `${meter.total} 次比较 → ${N.promptTokens} token 提示 → ${N.supported}/${N.total} 句有出处`,
    text: `一次检索增强问答就是这四步：把问题变成向量、找最近的几块、拼成带编号的提示、让模型照着回答并标出来源。模型说什么，取决于提示里放了什么：讲密封圈的那段排在第 ${N.sealRank}，回答里就没有「先把密封圈重新装好」这条最直接的办法；第 4 条没被检索到，回答里出自它的那句就找不到出处。下一课的重排序，用一个更贵、更准的打分器把前十个候选重新排一遍，让这类段落进到前 ${K}。`,
    facts: [['检索', `${meter.total} 次距离计算`], ['提示', `${N.promptTokens} token`], ['有出处', `${N.supported} / ${N.total} 句`], ['下一课', '重排序']],
  },
};
