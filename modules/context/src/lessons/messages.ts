/**
 * 第一课：一次 Messages API 调用。应用 → SDK → HTTPS → API → 模型，再原路返回。
 * 请求和响应的字节由 core/ 真实编码（JSON、HTTP/1.1、TLS 记录头），input_tokens 由 ChatML 模板展开后真实计数。
 * 模型写的回复（REPLY）是示例，其余数字都从下面的计算结果取，tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  API_VERSION,
  costOf,
  createMessage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  EXAMPLE_API_KEY,
  exampleId,
  EXAMPLE_EPOCH,
  formatPrice,
  formatUsd,
  httpDate,
  inputBreakdown,
  messagesHttpRequest,
  messagesHttpResponse,
  MODELS,
  PRICE_DATE,
  priceOf,
  spanOf,
  type ContentBlock,
  type MessagesRequest,
} from '../core';
import { concept, httpHead, jsonBody, promptPieces, TLS_TAG, tlsRecord, tokenIds, utf8Lines, wire } from '../decode/structures';
import { PART_TONE, promptSegments, segmentRow } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, Lesson, RowPrim, Tone } from './types';

// ---------- 这次调用 ----------

export const MODEL = 'claude-opus-5-5';
export const SYSTEM = '你是一个简洁的助手，用一句话回答。';
export const QUESTION = '什么是 token？';

/** 应用传给 SDK 的参数，也就是请求体。字段顺序就是序列化的顺序。 */
export const REQUEST: MessagesRequest = {
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  messages: [{ role: 'user', content: QUESTION }],
};

/** 模型写的回复：示例（本站不跑大模型），界面上标 E.G.。它的 token 数、字节、费用都是真实计算的。 */
export const REPLY: ContentBlock[] = [{ type: 'text', text: 'token 是模型读写文本的最小单位，一段话会先被切成一串 token。' }];

export const REQUEST_ID = exampleId('req', 1);
export const MESSAGE_ID = exampleId('msg', 1);
export const DATE = httpDate(EXAMPLE_EPOCH);

export const body = encodeJson(REQUEST);
export const httpRequest = encodeRequest(messagesHttpRequest(REQUEST));
export const breakdown = inputBreakdown(REQUEST);
export const message = createMessage(REQUEST, REPLY, { id: MESSAGE_ID });
export const responseJson = encodeJson(message);
export const httpResponse = encodeResponse(messagesHttpResponse(message, { requestId: REQUEST_ID, date: DATE }));
export const cost = costOf(message.usage, MODEL);
export const price = priceOf(MODEL);

const head = (layout: typeof httpRequest) => layout.body[0];
/** TLS 记录的总字节：5 字节记录头 + 明文 + 1 字节内容类型 + 16 字节认证标签。 */
export const tlsSize = (plaintext: number): number => 5 + plaintext + 1 + TLS_TAG;

const prompt = breakdown.prompt;
const input = message.usage.input_tokens;
const output = message.usage.output_tokens;
const replyText = (REPLY[0] as { text: string }).text;
const systemChars = [...SYSTEM].length;
const replyChars = [...replyText].length;
const keyLength = EXAMPLE_API_KEY.length;
const segments = promptSegments(prompt, ['user']);
const header = (name: string) => httpRequest.headers.find((item) => item.name === name)!;

// ---------- 图元 ----------

const REQUEST_FIELDS = ['model', 'max_tokens', 'system', 'messages'] as const;
const FIELD_TONE: Record<string, Tone> = { model: 'blue', max_tokens: 'blue', system: PART_TONE.system, messages: PART_TONE.user };

/** 请求：第一格是 HTTP 头，后面每格是请求体的一个字段，下面写字节数。 */
function requestRow(withHead: boolean, lift: string[] = []): RowPrim {
  const cells: DsCell[] = [
    withHead ? { v: 'HTTP 头', tone: 'slate', sub: `${head(httpRequest)} B`, key: 'head', lift: lift.includes('head') || undefined } : { v: '', sub: '头' },
    ...REQUEST_FIELDS.map((name): DsCell => {
      const span = spanOf(body, name);
      return { v: name, tone: FIELD_TONE[name], sub: `${span.to - span.from} B`, key: name, lift: lift.includes(name) || undefined };
    }),
  ];
  return { kind: 'row', id: 'q', w: 66, cells };
}

const RESPONSE_FIELDS = ['id', 'content', 'stop_reason', 'usage'] as const;

/** 响应：主要的四个字段，下面写字节数；stop_reason 上标出值。 */
function responseRow(): RowPrim {
  return {
    kind: 'row',
    id: 'r',
    w: 66,
    cells: RESPONSE_FIELDS.map((name): DsCell => {
      const span = spanOf(responseJson, name);
      return { v: name, tone: name === 'content' ? PART_TONE.assistant : name === 'usage' ? 'amber' : 'blue', sub: `${span.to - span.from} B`, key: name };
    }),
    marks: [{ at: 2, text: message.stop_reason, color: 'green', dx: 28 }],
  };
}

/** 用量：输入、输出两格写 token 数，第三格是按示例单价算出的合计。 */
const usageRow = (): RowPrim => ({
  kind: 'row',
  id: 'u',
  w: 74,
  cells: [
    { v: String(input), tone: 'blue', sub: '输入', key: 'in' },
    { v: String(output), tone: 'green', sub: '输出', key: 'out' },
    { v: formatUsd(cost.total), tone: 'amber', sub: '合计', key: 'cost' },
  ],
});

const promptRow = (marked: boolean): RowPrim => ({ ...segmentRow('p', segments, { w: 64 }), marks: marked ? [{ at: 1, text: `${input} token`, color: 'violet', dx: 30 }] : undefined });

// ---------- 文案用到的数 ----------

export const numbers = {
  bodyBytes: body.bytes.length,
  requestBytes: httpRequest.bytes.length,
  headBytes: head(httpRequest),
  headers: httpRequest.headers.length,
  contentLength: Number(header('content-length').value),
  tlsRequest: tlsSize(httpRequest.bytes.length),
  input,
  output,
  system: breakdown.system,
  user: breakdown.messages[0],
  template: breakdown.template,
  responseBytes: httpResponse.bytes.length,
  responseBody: responseJson.bytes.length,
  tlsResponse: tlsSize(httpResponse.bytes.length),
  systemChars,
  replyChars,
  keyLength,
};

const N = numbers;
const total = formatUsd(cost.total);

// ---------- 课程 ----------

export const messages: Lesson = {
  id: 'messages',
  name: 'MESSAGES',
  title: '一次 Messages API 调用',
  group: 'api',
  layer: [1, 5],
  layerNote: '从 TLS 记录、HTTP 报文、JSON 字段，一直到消息被模板展开成模型读到的 token。',
  tokensNote: '模型读入的输入 token 加上它写出的输出 token。',
  nodes: ['app', 'sdk', 'net', 'gateway', 'model', 'request', 'prompt', 'response', 'usage'],
  place: { app: [90, 200], sdk: [350, 60], net: [590, 200], gateway: [800, 70], model: [800, 400], request: [410, 400], prompt: [650, 610], response: [380, 650], usage: [100, 520] },
  labels: {
    app: ['应用', 'messages.create()'],
    sdk: ['SDK', '序列化、加头、发请求'],
    net: ['网络', 'HTTPS（TLS 1.3）'],
    gateway: ['API', `POST ${'/v1/messages'}`],
    model: ['模型', MODELS[MODEL].name],
    request: ['请求', '头 + JSON 请求体'],
    prompt: ['模型读到的', '按来源分段的 token 数'],
    response: ['响应', 'JSON 响应体的主要字段'],
    usage: ['用量和费用', `示例单价，${PRICE_DATE}`],
  },
  labelAt: { request: [-215, 20], prompt: [235, 30], response: [-200, 30], usage: [-200, -6] },
  radius: { request: 60, prompt: 60, response: 60, usage: 56 },
  initial: { request: [], prompt: [], response: [], usage: [] },
  start: ['app', 'sdk', 'request'],
  legend: [['blue', '请求和用户消息'], ['violet', 'system 和展开后的提示'], ['green', '模型的回复'], ['slate', 'HTTP 头、TLS 和模板开销'], [null, 'token 列：模型累计读入和写出的 token']],
  overview: {
    full: '一次调用到底带了什么',
    description: `应用只写了一行 messages.create：一句 ${systemChars} 个字符的 system，加一个问题「${QUESTION}」。这一课把它变成真实的字节：${N.bodyBytes} 字节的 JSON 请求体、${N.requestBytes} 字节的 HTTP 请求、加密后 ${N.tlsRequest} 字节的 TLS 记录；再看 API 把它展开成模型读到的 ${input} 个 token，回复变成 ${N.responseBytes} 字节的响应，最后按示例单价算出这次调用花了多少钱。`,
    facts: [
      ['接口', 'POST https://api.anthropic.com/v1/messages'],
      ['模型', `${MODEL}（${MODELS[MODEL].name}）`],
      ['版本头', `anthropic-version: ${API_VERSION}`],
      ['请求', `${N.requestBytes} 字节（头 ${N.headBytes} + 体 ${N.bodyBytes}）`],
      ['token', `输入 ${input}，输出 ${output}（本站迷你分词器）`],
      ['费用', `${total}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '应用调用 SDK',
      desc: `4 个参数，序列化成 ${N.bodyBytes} 字节 JSON`,
      detail: `model、max_tokens、messages 是必填的三个字段，system 可选，它不是一条消息，而是单独的顶层字段。messages 里每条都有 role 和 content，这里只有一条 user 消息；API 不保存对话，下一轮要把整段历史再发一遍。SDK 把参数按原样序列化成紧凑 JSON，中文按 UTF-8 编码，每个汉字 3 个字节。`,
      facts: [['必填', 'model、max_tokens、messages'], ['system', `${systemChars} 个字符，${spanOf(body, 'system').to - spanOf(body, 'system').valueFrom} 字节（含引号）`], ['请求体', `${N.bodyBytes} 字节`]],
      events: [
        type('messages.create({…})'),
        pk('app', 'sdk', 'blue', 'messages.create()', [`model: ${MODEL}`, `max_tokens: ${REQUEST.max_tokens}`], [0, 'CALL', `调用 messages.create：system ${systemChars} 个字符，1 条 user 消息`, N.bodyBytes],
          wire('SDK 收到的参数，序列化成 JSON 请求体', 'mem', 'format', jsonBody('请求体', body, {
            expand: ['messages[0].role', 'messages[0].content'],
            notes: {
              model: '模型 id。写错或者没有权限都返回 404 not_found_error，信息以「model: <id>」开头。',
              max_tokens: `最多生成多少个 token，到了就停（stop_reason 是 max_tokens）。${MODELS[MODEL].name} 的上限是 ${MODELS[MODEL].maxOutput.toLocaleString('en-US')}。`,
              system: 'system 提示是顶层字段，不放在 messages 里。可以是字符串，也可以是 text 块的数组（要加缓存断点时用数组）。',
              messages: '对话历史。API 是无状态的：每次都要带上全部历史。',
              'messages[0].content': 'content 可以是字符串，也可以是内容块数组（text、image、tool_use、tool_result……）。字符串等价于一个 text 块。',
            },
          })),
          { ds: { request: [requestRow(false, [...REQUEST_FIELDS])] } }),
      ],
    },
    {
      title: 'SDK 拼出 HTTP 请求',
      desc: `${N.headers} 个头 + 空行 + 请求体，共 ${N.requestBytes} 字节`,
      detail: `请求行是 POST /v1/messages HTTP/1.1，后面每个头一行，以 CRLF 结尾，一个空行之后才是请求体。x-api-key 是密钥（示例长度 ${keyLength} 个字符，这里打码），anthropic-version 选定 API 版本，${API_VERSION} 是当前最新的版本。content-length 是 SDK 数出来的请求体字节数 ${N.contentLength}，服务端按它知道请求体到哪里结束。`,
      facts: [['请求行', 'POST /v1/messages HTTP/1.1'], ['版本头', API_VERSION], ['content-length', String(N.contentLength)], ['头部', `${N.headBytes} 字节`]],
      events: [
        state('sdk', { 方法: 'POST', 头: `${N.headers} 个`, 请求体: `${N.bodyBytes} B` }),
        pk('sdk', 'request', 'blue', 'HTTP 请求', [`POST /v1/messages`, `${N.requestBytes} 字节`], [0, 'HTTP', `HTTP/1.1 请求：头 ${N.headBytes} 字节，content-length: ${N.contentLength}`, N.requestBytes],
          wire('SDK 发出的 HTTP/1.1 请求', 'mem', 'format',
            httpHead('请求头', httpRequest, {
              mask: { 'x-api-key': 'sk-ant-api03-'.length },
              startNote: '方法、请求目标、协议版本，空格分隔。',
              notes: {
                host: '目标主机。HTTP/1.1 必须带 host 头。',
                'content-type': '请求体是 JSON。',
                'anthropic-version': `API 版本（必填）。${API_VERSION} 起发送 temperature、top_p、top_k 都会 400；老的 2023-06-01 仍然可用。SDK 会自动带上。`,
                'x-api-key': `API 密钥，形如 sk-ant-api03-…，共 ${keyLength} 个字符（示例长度）。只能放在服务端，泄露了谁都能用你的额度。`,
                'content-length': `请求体的字节数，由 SDK 真实计算：${N.contentLength}。`,
              },
              example: ['x-api-key'],
            }),
            jsonBody('请求体', body)),
          { ds: { request: [requestRow(true, ['head'])] } }),
      ],
    },
    {
      title: 'HTTPS 送到 API',
      desc: `加密成 ${N.tlsRequest} 字节，API 解密、校验`,
      detail: `HTTPS 就是在 TLS 里跑 HTTP：整段请求连同密钥被加密成一条 TLS 记录，路上只看得到 5 字节的记录头和 ${N.tlsRequest - 5} 字节密文。API 解密后要核对 x-api-key（不对是 401 authentication_error）、校验字段（不对是 400 invalid_request_error），每个响应都会带上一个 request-id 头，出错时报给支持的就是它。`,
      facts: [['TLS 记录', `${N.tlsRequest} 字节 = 5 + ${N.requestBytes} + 1 + ${TLS_TAG}`], ['request-id', REQUEST_ID], ['校验', '通过']],
      events: [
        show('net'),
        state('sdk', { 方法: null, 头: null, 请求体: null }),
        pk('sdk', 'net', 'slate', 'TLS 记录', [`${N.tlsRequest} 字节密文`], [0, 'TLS', `明文 ${N.requestBytes} 字节加密成一条 ${N.tlsRequest} 字节的 TLS 记录`, N.tlsRequest],
          wire('路上能看到的字节', 'mem', 'format', tlsRecord('TLS 1.3 记录', N.requestBytes))),
        show('gateway'),
        pk('net', 'gateway', 'slate', '解密、校验', ['x-api-key ✓', `max_tokens ≤ ${MODELS[MODEL].maxOutput / 1000}K ✓`], [0, 'HTTP', `API 解出 ${N.requestBytes} 字节的请求，校验通过，request-id ${REQUEST_ID}`, N.headBytes],
          wire('API 先读头部，再校验请求体', 'mem', 'format', httpHead('请求头', httpRequest, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'] }),
            concept('校验结果', [
              ['x-api-key', '有效', '缺失或无效：401 authentication_error。'],
              ['anthropic-version', API_VERSION, '必填的版本头。'],
              ['model', `${MODEL} 存在`, '不存在或无权使用：404 not_found_error。'],
              ['max_tokens', `${REQUEST.max_tokens} ≤ ${MODELS[MODEL].maxOutput}`, '超过模型上限：400 invalid_request_error。'],
              ['messages', '1 条，最后一条是 user', '这个模型不支持预填充：最后一条是 assistant 会 400。'],
            ]))),
        state('gateway', { 'request-id': REQUEST_ID.slice(0, 12) + '…', 校验: '通过' }),
      ],
    },
    {
      title: '模型读到的是 token',
      desc: `input_tokens = ${N.system} + ${N.user} + ${N.template} = ${input}`,
      detail: `模型读不到 JSON，API 先按聊天模板把 system 和消息拼成一段文本，再切成 token。本站用公开的 ChatML 模板演示：system ${N.system} 个、问题 ${N.user} 个，模板本身的特殊 token、角色名和换行又占 ${N.template} 个，合起来就是 usage 里的 input_tokens。迷你词表里没有 system、assistant 这些词，所以模板开销被放大了；Claude 的模板不公开，带工具时还会自动加一段工具系统提示（${MODELS[MODEL].name} 是 ${MODELS[MODEL].toolSystemTokens} 个 token）。`,
      facts: [['system', `${N.system} token`], ['问题', `${N.user} token`], ['模板', `${N.template} token`], ['input_tokens', String(input)]],
      events: [
        show('model', 'prompt'),
        pk('gateway', 'model', 'violet', '展开成 token', [`${input} 个 token`, 'system + user + 模板'], [input, 'TEMPLATE', `ChatML 展开：system ${N.system} + user ${N.user} + 模板 ${N.template} = ${input} 个输入 token`, prompt.bytes.length],
          wire('模型实际读到的文本（ChatML 展开，本站演示用）', 'mem', 'internal',
            promptPieces('ChatML 文本', prompt, { notes: { '<|im_start|>': '特殊 token：在模型里只是一个 id，不是这 12 个字符。用户输入里写这几个字符不会变成它。' } }),
            tokenIds('input_ids', prompt.ids, { summary: `${input} 个 token id，特殊 token 是 353、354` })),
          { ds: { prompt: [promptRow(true)] } }),
        state('model', { 输入: `${input} token`, 窗口: `${MODELS[MODEL].context / 1e6}M` }),
      ],
    },
    {
      title: '生成回复，原路返回',
      desc: `${output} 个输出 token，响应 ${N.responseBytes} 字节`,
      detail: `模型一个 token 一个 token 地写，写完 ${replyChars} 个字符（${output} 个 token）自然停下，所以 stop_reason 是 end_turn。API 把回复包成 JSON：id 以 msg_ 开头，content 是内容块数组，usage 记下 ${input} 个输入和 ${output} 个输出 token，响应头里的 request-id 和刚才分配的一致。回复同样经过 TLS 加密，${N.responseBytes} 字节的响应在路上是 ${N.tlsResponse} 字节。`,
      facts: [['stop_reason', message.stop_reason], ['output_tokens', String(output)], ['响应体', `${N.responseBody} 字节`], ['TLS 记录', `${N.tlsResponse} 字节`]],
      events: [
        pk('model', 'gateway', 'green', `${output} 个 token`, [`「${replyText.slice(0, 12)}…」`], [input + output, 'INFER', `生成 ${output} 个 token（${replyChars} 个字符）后停下：end_turn`, utf8Encode(replyText).length],
          wire('模型写出的回复（示例）', 'mem', 'format', utf8Lines('回复文本', replyText, { color: 'green', summary: `${replyChars} 个字符，${output} 个 token（模型写的内容是示例）`, notes: { 0: '这段话是示例：本站不跑大模型。它的字节和 token 数是真实计算的。' } }))),
        show('response'),
        pk('gateway', 'net', 'slate', 'TLS 记录', [`${N.tlsResponse} 字节密文`], [input + output, 'TLS', `${N.responseBytes} 字节的响应加密成 ${N.tlsResponse} 字节`, N.tlsResponse],
          wire('路上能看到的字节', 'mem', 'format', tlsRecord('TLS 1.3 记录', N.responseBytes))),
        pk('net', 'sdk', 'green', 'HTTP 200', ['200 OK', `request-id ${REQUEST_ID.slice(0, 10)}…`], [input + output, 'HTTP', `HTTP/1.1 200 OK，响应体 ${N.responseBody} 字节`, N.responseBytes],
          wire('SDK 收到的 HTTP 响应', 'mem', 'format',
            httpHead('响应头', httpResponse, {
              startNote: '状态行：协议版本、状态码、原因短语。',
              notes: { 'request-id': '每个响应都带的请求 id，出错时也出现在错误 JSON 的 request_id 字段里。找支持时报这个。', date: '服务端的时间（示例）。' },
              example: ['request-id', 'date'],
            }),
            jsonBody('响应体', responseJson, {
              expand: ['content[0].type', 'content[0].text', 'usage.input_tokens', 'usage.output_tokens'],
              example: ['id', 'content', 'content[0].text'],
              notes: {
                id: '消息 id，以 msg_ 开头，每次都不同（示例）。',
                content: '内容块数组。这次只有一个 text 块；要调用工具时会出现 tool_use 块。',
                stop_reason: 'end_turn 自然结束；max_tokens 到了上限被截断；stop_sequence 遇到停止序列；tool_use 要调用工具；refusal 拒绝。',
                usage: 'input_tokens 是最后一个缓存断点之后的输入，加上缓存读写两项才是全部输入；这次没有用缓存，两项都是 0。',
                'usage.input_tokens': `= system ${N.system} + 问题 ${N.user} + 模板 ${N.template}（本站计数）。`,
                'content[0].text': '模型写的话（示例）。',
              },
            })),
          { ds: { response: [responseRow()] } }),
      ],
    },
    {
      title: 'SDK 交回应用，算一下钱',
      desc: `输入 ${input} + 输出 ${output} token，${total}`,
      detail: `SDK 把 JSON 解析成对象交给应用，应用读 content[0].text 显示，读 usage 记账。按示例单价，输入每百万 token ${formatPrice(price.input).replace(' / MTok', '')}、输出 ${formatPrice(price.output).replace(' / MTok', '')}，这次是 ${formatUsd(cost.input)} + ${formatUsd(cost.output)} = ${total}。输出单价是输入的 ${price.output / price.input} 倍，所以同样多的 token，写出来的比读进去的贵。`,
      facts: [['输入', `${input} × ${formatPrice(price.input)} = ${formatUsd(cost.input)}`], ['输出', `${output} × ${formatPrice(price.output)} = ${formatUsd(cost.output)}`], ['合计', total], ['单价日期', PRICE_DATE]],
      events: [
        show('usage'),
        pk('sdk', 'app', 'green', 'Message', [`text: 「${replyText.slice(0, 10)}…」`, `usage: ${input} / ${output}`], [input + output, 'CALL', `返回 Message：stop_reason ${message.stop_reason}，usage 输入 ${input}、输出 ${output}，示例费用 ${total}`, spanOf(responseJson, 'usage').to - spanOf(responseJson, 'usage').valueFrom],
          wire('应用读到的 usage，和按示例单价算出的费用', 'mem', 'format',
            jsonBody('usage', responseJson, { root: 'usage', notes: { 'usage.cache_creation_input_tokens': '写入缓存的 token（这次没有缓存断点，是 0）。', 'usage.cache_read_input_tokens': '从缓存读出的 token（0）。', 'usage.service_tier': '服务等级。' } }),
            concept(`费用（示例单价，${PRICE_DATE}）`, [
              ['输入', `${input} × ${formatPrice(price.input)} = ${formatUsd(cost.input)}`],
              ['输出', `${output} × ${formatPrice(price.output)} = ${formatUsd(cost.output)}`],
              ['合计', total, '价格会变，以 Anthropic 定价页为准。'],
            ])),
          { ds: { usage: [usageRow()] } }),
        render,
        note('usage', `这次调用 ${total}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '一次调用就是一个 HTTP 请求',
    desc: `${N.requestBytes} 字节进，${N.responseBytes} 字节出`,
    text: `SDK 做的事并不神秘：把参数序列化成 JSON，加上 x-api-key 和 anthropic-version，发一个 POST，再把 JSON 响应解析回来。真正决定花多少钱、模型看到什么的，是 messages 里的内容：它们按模板展开成 token，按 token 计费，也按 token 占用上下文窗口。本站的 token 数来自迷你分词器，真实模型的词表大得多，绝对值不同，但「哪部分占得多、写比读贵」的关系是一样的。下一课把这次调用改成流式，看 SSE 事件怎样一块块到达。`,
    facts: [['请求', `${N.requestBytes} 字节`], ['响应', `${N.responseBytes} 字节`], ['token', `${input} + ${output}`], ['下一课', 'SSE 流式事件序列']],
  },
};
