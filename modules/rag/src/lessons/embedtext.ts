/**
 * 第一课：文本变向量。应用把一个问题发给嵌入 API，嵌入模型把它切成词、查表、加权平均、归一化，得到 16 维 float32 向量，
 * 原路返回；再嵌入两个问题（一个同义、一个无关），比较三个向量两两的余弦。
 *
 * 向量由 core/embed.ts 的 16 维 LSA 真实计算，请求和响应的字节由 core/api.ts 真实编码（OpenAI embeddings 的字段，经核对）；
 * 响应里的数和 usage 是本站模型和分词器算的，真实服务会给出不同的值，标 E.G.。tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  base64Encode,
  DistanceMeter,
  dot,
  EMBEDDER,
  embed,
  embeddingsHttpRequest,
  embeddingsHttpResponse,
  embeddingsResponse,
  EXAMPLE_OPENAI_KEY,
  exampleRequestId,
  f32VectorBytes,
  norm,
  OPENAI_EMBED_DIMS,
  OPENAI_EMBED_MODEL,
  PARAGRAPHS,
  spanOf,
  tableBytes,
  termsOf,
  type EmbeddingsRequest,
} from '../core';
import { base64Text, concept, floatVector, httpHead, jsonBody, num, utf8Text, wire } from '../decode/structures';
import { cellsOf, comp, fixed, PART_TONE, similarityGrid, vectorRow } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 三个问题 ----------

/** 用户的问题。 */
export const Q1 = '保温杯漏水了怎么办？';
/** 同义的问法：和 Q1 没有共同的有效词。 */
export const Q2 = '杯盖渗水该怎么处理？';
/** 无关的问题。 */
export const Q3 = '怎么开发票？';

export const MODEL = OPENAI_EMBED_MODEL;
export const DIMS = EMBEDDER.dim;

export const t1 = embed(Q1);
export const t2 = embed(Q2);
export const t3 = embed(Q3);

/** 第一次请求：一个字符串。dimensions 让 text-embedding-3 输出 16 维（和本站模型一致）。 */
export const REQUEST: EmbeddingsRequest = { input: Q1, model: MODEL, dimensions: DIMS, encoding_format: 'float' };
/** 第二次请求：两个字符串一起嵌入。 */
export const REQUEST2: EmbeddingsRequest = { input: [Q2, Q3], model: MODEL, dimensions: DIMS, encoding_format: 'float' };

export const REQUEST_ID = exampleRequestId(1);
export const http1 = embeddingsHttpRequest(REQUEST);
export const response1 = embeddingsResponse([t1.vector], REQUEST);
export const httpResponse1 = embeddingsHttpResponse(response1, REQUEST_ID);
export const http2 = embeddingsHttpRequest(REQUEST2);
export const response2 = embeddingsResponse([t2.vector, t3.vector], REQUEST2);
export const httpResponse2 = embeddingsHttpResponse(response2, exampleRequestId(2));

/** 向量的 float32 字节，以及 encoding_format 为 base64 时的字符串。 */
export const vectorBytes = f32VectorBytes(t1.vector);
export const base64 = base64Encode(vectorBytes);

/** 三对余弦（向量已归一化，点积就是余弦）。每比较一对，距离计数加 1。 */
export const meter = new DistanceMeter();
const compare = (a: readonly number[], b: readonly number[]): number => {
  meter.add('query');
  return dot(a, b);
};
export const cos12 = compare(t1.vector, t2.vector);
export const cos13 = compare(t1.vector, t3.vector);
export const cos23 = compare(t2.vector, t3.vector);

/** Q1、Q2 字面上共同的词（汉字二元组）。 */
export const sharedTerms = termsOf(Q1).filter((term, i, all) => all.indexOf(term) === i && termsOf(Q2).includes(term));

/** 「漏水」和「渗水」同时出现的段落：嵌入模型从这里学到它们意思相近。 */
export const cooccur = PARAGRAPHS.filter((item) => item.text.includes('漏水') && item.text.includes('渗水'));

const head = (layout: { body: [number, number] }) => layout.body[0];
const strongest = t1.known.reduce((best, hit) => (hit.weight > best.weight ? hit : best));
const embeddingSpan = spanOf(httpResponse1.json, 'data[0].embedding');

// ---------- 文案用到的数 ----------

export const numbers = {
  chars: [...Q1].length,
  bytes: utf8Encode(Q1).length,
  terms: t1.terms.length,
  known: t1.known.length,
  unknown: t1.unknown.length,
  vocab: EMBEDDER.vocab.length,
  paragraphs: EMBEDDER.docs,
  tableBytes: tableBytes(),
  norm: t1.norm,
  bodyBytes: http1.json.bytes.length,
  requestBytes: http1.layout.bytes.length,
  headBytes: head(http1.layout),
  responseBytes: httpResponse1.layout.bytes.length,
  responseBody: httpResponse1.json.bytes.length,
  embeddingJson: embeddingSpan.to - embeddingSpan.valueFrom,
  base64Length: base64.length,
  vectorBytes: vectorBytes.length,
  promptTokens: response1.usage.prompt_tokens,
  request2Bytes: http2.layout.bytes.length,
  response2Bytes: httpResponse2.layout.bytes.length,
  defaultDims: OPENAI_EMBED_DIMS[MODEL],
};

const N = numbers;
/** 文案里引用问题时去掉末尾的问号（detail 按句号、问号数句子）。 */
const bare = (q: string): string => q.replace(/？$/, '');

/** 余弦的显示：两位小数。 */
export const c2 = (x: number): string => fixed(x, 2);

// ---------- 图元 ----------

const REQUEST_FIELDS = ['input', 'model', 'dimensions', 'encoding_format'] as const;

function requestRow(lift: string[] = []): RowPrim {
  return {
    kind: 'row',
    id: 'q',
    w: 64,
    cells: REQUEST_FIELDS.map((name): DsCell => {
      const span = spanOf(http1.json, name);
      return { v: name === 'encoding_format' ? 'format' : name === 'dimensions' ? 'dims' : name, tone: name === 'input' ? PART_TONE.query : 'slate', sub: `${span.to - span.from} B`, key: name, lift: lift.includes(name) || undefined };
    }),
  };
}

/** 切出来的词：认识的蓝色，不认识的变暗。 */
function termRow(marked: boolean): RowPrim {
  const knownSet = new Set(t1.known.map((hit) => hit.term));
  return {
    kind: 'row',
    id: 't',
    w: 48,
    cells: cellsOf(t1.terms, { tones: Object.fromEntries(t1.terms.map((term, i) => [i, knownSet.has(term) ? PART_TONE.query : 'dim'])), keys: t1.terms.map((term, i) => `${term}${i}`), subs: t1.terms.map((term) => (knownSet.has(term) ? num(t1.known.find((hit) => hit.term === term)!.weight, 2) : '—')) }),
    marks: marked ? [{ at: t1.terms.indexOf(strongest.term), text: `权重最大`, color: 'blue', dx: 26 }] : undefined,
  };
}

const RESPONSE_FIELDS = ['object', 'data', 'model', 'usage'] as const;

function responseRow(): RowPrim {
  return {
    kind: 'row',
    id: 'r',
    w: 64,
    cells: RESPONSE_FIELDS.map((name): DsCell => {
      const span = spanOf(httpResponse1.json, name);
      return { v: name, tone: name === 'data' ? PART_TONE.vector : name === 'usage' ? PART_TONE.result : 'slate', sub: `${span.to - span.from} B`, key: name };
    }),
  };
}

const pooledRow = (): RowPrim => vectorRow('v', t1.pooled, { keyPrefix: 'd', w: 27, marks: [{ at: 0, text: `‖v‖ = ${num(t1.norm, 3)}`, color: 'violet', dx: -20 }] });
const unitRow = (): RowPrim => vectorRow('v', t1.vector, { keyPrefix: 'd', w: 27, marks: [{ at: 0, text: '‖v‖ = 1', color: 'green', dx: -20 }] });

const scoreGrid = () => similarityGrid('s', ['问1', '问2', '问3'], [[1, cos12, cos13], [cos12, 1, cos23], [cos13, cos23, 1]], { w: 54 });

// ---------- 课程 ----------

export const embedtext: Lesson = {
  id: 'embedtext',
  name: 'EMBEDDINGS',
  title: '文本变向量',
  group: 'embed',
  layer: [3, 3],
  layerNote: '整课都在「向量」这一档：一段文字变成一个定长的向量，再比较向量之间的远近。',
  distNote: `最后一步比较三个问题的向量，两两一对，一共 ${meter.total} 次。`,
  nodes: ['app', 'embedder', 'request', 'tokens', 'vectors', 'response', 'scores'],
  place: { app: [90, 180], embedder: [520, 50], request: [390, 420], tokens: [930, 200], vectors: [830, 480], response: [470, 690], scores: [70, 700] },
  labels: {
    app: ['应用', 'embeddings.create()'],
    embedder: ['嵌入模型', `本站 ${DIMS} 维 LSA`],
    request: ['请求', 'JSON 请求体的字段'],
    tokens: ['切出来的词', '下面是池化权重'],
    vectors: ['向量', `${DIMS} 个分量`],
    response: ['响应', 'JSON 响应体的字段'],
    scores: ['相似度', '两两的余弦'],
  },
  labelAt: { request: [-190, 10], tokens: [70, -125], vectors: [-240, -30], response: [0, 110], scores: [0, 120] },
  radius: { request: 60, tokens: 70, vectors: 80, response: 60, scores: 70 },
  initial: { request: [], tokens: [], vectors: [], response: [], scores: [] },
  start: ['app', 'embedder', 'request'],
  legend: [['blue', '问题和认识的词'], ['violet', '向量'], ['green', '归一化和相似度'], ['slate', 'HTTP 和 JSON 的开销'], [null, '距离列：比较过几次向量']],
  overview: {
    full: '一句话怎样变成一串数',
    description: `检索增强的第一步，是把文字变成向量：意思相近的文字，向量也相近。这一课把问题「${Q1}」发给嵌入 API，看嵌入模型怎样把它切成词、查表、加权平均、归一化，变成 ${DIMS} 个 float32（${N.vectorBytes} 字节），装进 ${N.responseBytes} 字节的 HTTP 响应送回来；再嵌入一个同义的问法和一个无关的问题，比一比三个向量有多近。`,
    facts: [
      ['接口', `POST https://api.openai.com/v1/embeddings`],
      ['模型', `${MODEL}（默认 ${N.defaultDims} 维）`],
      ['本站模型', `${DIMS} 维 LSA，在 ${N.paragraphs} 段知识库上训练`],
      ['向量', `${DIMS} × 4 = ${N.vectorBytes} 字节 float32`],
      ['同义 / 无关', `余弦 ${c2(cos12)} / ${c2(cos13)}`],
    ],
  },
  steps: [
    {
      title: '应用请求嵌入',
      desc: `input 加 3 个参数，请求共 ${N.requestBytes} 字节`,
      detail: `嵌入接口只做一件事：给一段文字，还一个向量。input 是要嵌入的文字（也可以是字符串数组，一次嵌入好几段），model 选模型，text-embedding-3 系列可以用 dimensions 把默认的 ${N.defaultDims} 维缩短，这里要 ${DIMS} 维，正好和本站模型一样。encoding_format 是 float 时向量写成 JSON 数组，是 base64 时写成 float32 字节的 base64 字符串。`,
      facts: [['input', `「${Q1}」${N.chars} 个字符`], ['dimensions', String(DIMS)], ['请求体', `${N.bodyBytes} 字节`], ['请求', `${N.requestBytes} 字节`]],
      events: [
        type('embeddings.create({…})'),
        pk('app', 'embedder', 'blue', 'POST /v1/embeddings', [`input: ${Q1}`, `dimensions: ${DIMS}`], [0, 'HTTP', `嵌入请求：input ${N.chars} 个字符，model ${MODEL}，dimensions ${DIMS}`, N.requestBytes],
          wire('应用发出的 HTTP 请求', 'mem', 'format',
            httpHead('请求头', http1.layout, {
              mask: { authorization: 'Bearer sk-proj-'.length },
              startNote: '方法、路径、协议版本。',
              notes: {
                host: '嵌入接口的主机。',
                authorization: `Bearer 加 API 密钥（示例长度 ${EXAMPLE_OPENAI_KEY.length} 个字符，这里打码）。`,
                'content-length': `请求体的字节数：${N.bodyBytes}。`,
              },
              example: ['authorization'],
            }),
            jsonBody('请求体', http1.json, {
              notes: {
                input: '要嵌入的文字。可以是一个字符串，也可以是字符串数组；每段最多 8192 个 token，一次最多 2048 段。',
                model: `嵌入模型。text-embedding-3-small 默认 ${N.defaultDims} 维，text-embedding-3-large 默认 ${OPENAI_EMBED_DIMS['text-embedding-3-large']} 维。`,
                dimensions: '输出的维数，text-embedding-3 及以后的模型才支持。由服务端缩短；自己截断向量时要重新归一化。',
                encoding_format: 'float（默认）返回数组；base64 返回 float32 字节的 base64，更短。',
              },
            })),
          { ds: { request: [requestRow(['input'])] } }),
      ],
    },
    {
      title: '切成词',
      desc: `${N.terms} 个词，认识 ${N.known} 个`,
      detail: `模型先把文字切成它认识的单位。本站的嵌入模型和 BM25 用同一套切法：汉字按相邻两个字切成二元组，「${bare(Q1)}」切出 ${N.terms} 个词，其中只有${t1.known.map((hit) => `「${hit.term}」`).join('')}在它的 ${N.vocab} 个词的词表里，「${t1.unknown[0]}」「${t1.unknown[1]}」这样的组合在知识库里从没出现过，直接丢掉。真实的嵌入模型用子词分词器，词表外的说法也能拆开来懂，这是本站的小模型做不到的。`,
      facts: [['词', `${N.terms} 个汉字二元组`], ['认识', t1.known.map((hit) => hit.term).join('、')], ['不认识', `${N.unknown} 个，丢掉`], ['词表', `${N.vocab} 个词`]],
      events: [
        show('tokens'),
        state('embedder', { 词表: `${N.vocab} 个词`, 维度: String(DIMS) }),
        pk('embedder', 'tokens', 'blue', `${N.terms} 个词`, t1.terms.slice(0, 4).map((term) => (t1.unknown.includes(term) ? `${term}（不认识）` : term)), [0, 'TOKENS', `UTF-8 ${N.bytes} 字节，切成 ${N.terms} 个二元组，词表里有 ${N.known} 个`, N.bytes],
          wire('嵌入模型读到的文字和切出来的词', 'mem', 'format',
            utf8Text('input', Q1, { summary: `${N.chars} 个字符，每个汉字和全角问号 3 个字节` }),
            concept('切出来的词', t1.terms.map((term, i): [string, string, string] => {
              const hit = t1.known.find((item) => item.term === term);
              return [`${i} · ${term}`, hit ? `权重 ${num(hit.weight, 3)}` : '不在词表里', hit ? `idf = ln(${N.paragraphs} / ${EMBEDDER.df.get(term)}) = ${num(hit.idf, 3)}，出现 ${hit.tf} 次，权重 (1 + ln tf) × idf。` : '知识库里没有这个二元组，模型不认识，丢掉。'];
            }), 'blue')),
          { ds: { tokens: [termRow(false)] } }),
        note('tokens', `${N.unknown} 个词不认识`, 'amber'),
      ],
    },
    {
      title: '查表，加权平均',
      desc: `${N.known} 个词向量按权重平均`,
      detail: `每个认识的词在嵌入表里有一个 ${DIMS} 维向量，嵌入表一共 ${N.vocab} × ${DIMS} 个 float32（${N.tableBytes.toLocaleString('en-US')} 字节），是训练时从「哪些词常在同一段里出现」学出来的。把查到的 ${N.known} 个向量按权重加权平均（池化），得到这段文字的向量；「${strongest.term}」只出现在一段里，idf 最大，权重也最大，所以结果偏向它。真实模型用 Transformer 让每个词看到上下文再池化，参数多几个数量级，但「文字进、定长向量出」是一样的。`,
      facts: [['嵌入表', `${N.vocab} × ${DIMS} × 4 = ${N.tableBytes.toLocaleString('en-US')} 字节`], ['权重最大', `${strongest.term}（${num(strongest.weight, 3)}）`], ['池化后的长度', num(t1.norm, 4)]],
      events: [
        show('vectors'),
        pk('tokens', 'vectors', 'violet', '查表、池化', t1.known.map((hit) => `${hit.term} × ${num(hit.weight, 2)}`), [0, 'EMBED', `查出 ${N.known} 个词向量，按权重加权平均，得到长度 ${num(t1.norm, 4)} 的 ${DIMS} 维向量`, (N.known + 1) * DIMS * 4],
          wire('嵌入表里查出的词向量，和加权平均的结果（本站模型的内部数据）', 'mem', 'internal',
            ...t1.known.map((hit) => floatVector(hit.term, hit.vector, 'f32', { color: 'blue', summary: `权重 ${num(hit.weight, 3)}`, digits: 3 })),
            floatVector('pooled', t1.pooled, 'f32', { color: 'violet', summary: `Σ 权重 × 词向量 / Σ 权重，长度 ${num(t1.norm, 4)}`, digits: 3 })),
          { ds: { tokens: [termRow(true)], vectors: [pooledRow()] } }),
        state('embedder', { 词表: `${N.vocab} 个词`, 维度: String(DIMS), 池化: `${N.known} 个词` }),
      ],
    },
    {
      title: '归一化，写成 float32',
      desc: `除以 ${num(t1.norm, 4)}，${DIMS} × 4 = ${N.vectorBytes} 字节`,
      detail: `最后把向量除以它自己的长度，长度变成 1。归一化之后，两个向量的点积就等于余弦，平方欧氏距离等于 2 − 2 × 余弦，三种度量排出的顺序一样，向量库可以只算最便宜的点积。每个分量存成 IEEE 754 float32，小端，${DIMS} 个分量一共 ${N.vectorBytes} 字节。`,
      facts: [['长度', '1'], ['第 0 维', `${comp(t1.vector[0])}（最大）`], ['float32', `${N.vectorBytes} 字节`]],
      events: [
        pk('embedder', 'vectors', 'green', '归一化', [`÷ ${num(t1.norm, 4)}`, `${N.vectorBytes} 字节 float32`], [0, 'VECTOR', `除以长度 ${num(t1.norm, 4)}，得到单位向量，${DIMS} 个 float32 共 ${N.vectorBytes} 字节`, N.vectorBytes],
          wire('归一化后的嵌入：float32 小端', 'mem', 'format', floatVector('embedding', t1.vector, 'f32', { bits: true, color: 'violet', summary: `长度 ${num(norm(t1.vector), 6)}，每个数 4 字节，小端`, notes: { 0: `第 0 维最大：${num(t1.vector[0], 6)}。` } })),
          { ds: { vectors: [unitRow()] } }),
        state('embedder', { 词表: null, 维度: String(DIMS), 池化: null, 长度: '1' }),
      ],
    },
    {
      title: '响应回到应用',
      desc: `向量装进 ${N.responseBytes} 字节的响应`,
      detail: `响应的 data 是数组，每个元素是一个 embedding 对象，index 对应 input 里的第几段；usage.prompt_tokens 是输入的 token 数，嵌入没有输出，total_tokens 和它相等。${DIMS} 个数写成 JSON 数组要 ${N.embeddingJson} 字节，写成 base64 只要 ${N.base64Length} 字节，所以官方 Python SDK 不写 encoding_format 时会自己要 base64 再解码。这里的数是本站模型算的，真实的 ${MODEL} 会给出完全不同的值，usage 也按它自己的分词器数。`,
      facts: [['data[0].embedding', `${DIMS} 个数，JSON ${N.embeddingJson} 字节`], ['base64', `${N.base64Length} 个字符`], ['usage', `prompt_tokens ${N.promptTokens}（本站 BPE）`], ['响应', `${N.responseBytes} 字节`]],
      events: [
        show('response'),
        pk('embedder', 'app', 'green', 'HTTP 200', [`data[0].embedding: ${DIMS} 个数`, `usage: ${N.promptTokens} token`], [0, 'HTTP', `200 OK，响应体 ${N.responseBody} 字节，向量 JSON ${N.embeddingJson} 字节（base64 只要 ${N.base64Length} 字节）`, N.responseBytes],
          wire('应用收到的 HTTP 响应', 'mem', 'format',
            httpHead('响应头', httpResponse1.layout, { startNote: '状态行。', notes: { 'x-request-id': '这次请求的 id（示例），出问题时报给服务方。' }, example: ['x-request-id'] }),
            jsonBody('响应体', httpResponse1.json, {
              expand: ['data[0].index', 'data[0].embedding', 'usage.prompt_tokens'],
              example: ['data', 'data[0].embedding', 'usage', 'usage.prompt_tokens'],
              notes: {
                object: '固定是 list。',
                data: '每段输入一个 embedding 对象，按 index 对应。',
                'data[0].embedding': `${DIMS} 个 float32 写成的十进制数（本站模型的值，示例）。`,
                model: '实际用的模型。',
                usage: '输入的 token 数。嵌入没有输出 token，total_tokens 等于 prompt_tokens。',
                'usage.prompt_tokens': `本站 BPE 的计数（示例），真实服务按 ${MODEL} 的分词器数。`,
              },
            }),
            base64Text('同一个向量，encoding_format 为 base64 时', base64, vectorBytes, { summary: `${N.vectorBytes} 字节 → ${N.base64Length} 个字符，解码后就是上面 float32 小端的字节` })),
          { ds: { response: [responseRow()] } }),
        render,
      ],
    },
    {
      title: '比一比三个问题',
      desc: `同义 ${c2(cos12)}，无关 ${c2(cos13)}`,
      detail: `应用再嵌入两个问题：「${bare(Q2)}」和「${bare(Q1)}」说的是同一件事，字面上共同的词只有一个「${sharedTerms[0]}」，它还不在词表里；「${bare(Q3)}」和它们无关。应用拿到三个向量，自己算两两的点积（向量库做的也是这件事）：同义的一对 ${c2(cos12)}，无关的两对是 ${c2(cos13)} 和 ${c2(cos23)}。嵌入模型训练用的 ${N.paragraphs} 段文字里，「漏水」和「渗水」都只出现在讲杯盖密封圈的那一段里，所以两个词的向量方向一样，这正是向量检索能找到「换了说法」的问题的原因。`,
      facts: [['问1 · 问2', c2(cos12)], ['问1 · 问3', c2(cos13)], ['问2 · 问3', c2(cos23)], ['共同的词', sharedTerms.map((term) => `「${term}」`).join('')]],
      events: [
        pk('app', 'embedder', 'blue', '再嵌入两个', [`「${Q2}」`, `「${Q3}」`], [0, 'HTTP', `input 是两个字符串的数组，一次嵌入两个问题`, N.request2Bytes],
          wire('第二次请求：input 是数组', 'mem', 'format',
            httpHead('请求头', http2.layout, { mask: { authorization: 'Bearer sk-proj-'.length }, example: ['authorization'] }),
            jsonBody('请求体', http2.json, { expand: ['input[0]', 'input[1]'], notes: { input: '数组里的每一段各得到一个向量，响应里的 index 和这里的下标对应。' } })),
          { ds: { request: [requestRow(['input'])] } }),
        pk('embedder', 'app', 'green', '两个向量', [`data[0]：问2`, `data[1]：问3`], [0, 'HTTP', `200 OK，data 里两个 embedding，index 0、1 对应 input 的顺序`, N.response2Bytes],
          wire('第二次响应：data 里两个 embedding', 'mem', 'format',
            httpHead('响应头', httpResponse2.layout, { example: ['x-request-id'] }),
            jsonBody('响应体', httpResponse2.json, { expand: ['data[0].index', 'data[1].index'], example: ['data', 'usage'], notes: { data: '按 index 对应 input 的下标。向量的数是本站模型的值（示例）。' } }))),
        show('scores'),
        pk('app', 'scores', 'green', '两两点积', [`问1 · 问2 = ${c2(cos12)}`, `问1 · 问3 = ${c2(cos13)}`], [meter.total, 'VECTOR', `三个单位向量两两点积：${c2(cos12)}、${c2(cos13)}、${c2(cos23)}`, 3 * N.vectorBytes],
          wire('三个问题的向量（float32），和两两的点积', 'mem', 'format',
            floatVector('问1', t1.vector, 'f32', { color: 'blue', summary: Q1, digits: 3 }),
            floatVector('问2', t2.vector, 'f32', { color: 'blue', summary: Q2, digits: 3 }),
            floatVector('问3', t3.vector, 'f32', { color: 'slate', summary: Q3, digits: 3 }),
            concept('点积（= 余弦）', [
              ['问1 · 问2', num(cos12, 4), '同义的问法：共同的有效词一个都没有，向量却很近。'],
              ['问1 · 问3', num(cos13, 4), '无关：几乎垂直。'],
              ['问2 · 问3', num(cos23, 4), '无关：几乎垂直。'],
            ], 'green')),
          { ds: { scores: [scoreGrid()] } }),
        note('scores', `同义 ${c2(cos12)}，无关 ${c2(cos13)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '意思相近，向量就相近',
    desc: `${N.chars} 个字 → ${DIMS} 个数 → ${N.vectorBytes} 字节`,
    text: `嵌入把任意长度的文字压成一个定长、长度为 1 的向量，比较两段文字就变成算一次点积。本站的 ${DIMS} 维 LSA 只在 ${N.paragraphs} 段知识库上训练，靠「哪些词常在一起出现」学到意思；OpenAI text-embedding-3、Voyage 这样的真实模型在海量语料上训练，维数是上千，词表外的说法也懂，但机制相同：切分、编码、池化、归一化。下一课细看相似度：点积、余弦和欧氏距离什么时候一样、什么时候不一样。`,
    facts: [['向量', `${DIMS} 维 float32，${N.vectorBytes} 字节`], ['同义', c2(cos12)], ['无关', c2(cos13)], ['下一课', '相似度：余弦、点积与归一化']],
  },
};
