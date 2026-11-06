/**
 * 第三课：同一请求的三种写法。同一段对话（一句 system、一个问题）分别按 Claude Messages、OpenAI Responses、
 * OpenAI Chat Completions 兼容接口（Ollama、OpenRouter 都用这种）写出请求，逐字节对比请求、响应、流式结束方式和错误。
 * 三份请求都由 core/ 从第一课的同一个 MessagesRequest 转换而来，三份响应用同一个示例回复和同一组 token 数构造，
 * 所以差异全部来自「写法」，不来自内容。文案里的数字取自下面的计算结果，tests/narrative.api.test.ts 核对。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  apiError,
  chatCompletion,
  chatStream,
  chatUsage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  encodeStream,
  errorBody,
  errorHttpResponse,
  eventFrame,
  EXAMPLE_EPOCH,
  exampleId,
  finishReasonOf,
  makeResponse,
  messagesHttpRequest,
  messagesHttpResponse,
  OPENAI_ERRORS,
  openaiErrorBody,
  openrouterErrorBody,
  PROVIDERS,
  providerRequest,
  responseObject,
  responsesFrame,
  responsesStreamEvents,
  responsesUsage,
  streamEvents,
  textPieces,
  toChatCompletions,
  toResponses,
  validateRequest,
  type ChatCompletionsRequest,
  type Header,
} from '../core';
import { httpHead, jsonBody, sseBody, wire } from '../decode/structures';
import { DATE, QUESTION, REPLY, REQUEST, REQUEST_ID, SYSTEM, message as claudeMessage } from './messages';
import { note, pk, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 同一段对话的三份请求 ----------

export const OPENAI_MODEL = PROVIDERS.openai.model;
export const COMPAT_MODEL = PROVIDERS.openrouter.model;
const OLLAMA_MODEL = PROVIDERS.ollama.model;
/** OpenAI / OpenRouter 的示例密钥（长度是示例），展示时打码。 */
const OPENAI_KEY = `sk-${'x'.repeat(48)}`;
const replyText = (REPLY[0] as { text: string }).text;

export const claudeReq = REQUEST;
export const responsesReq = toResponses(REQUEST, OPENAI_MODEL);
/**
 * Chat Completions 兼容接口的请求。toChatCompletions 按 OpenAI 官方写成 max_completion_tokens；
 * Ollama 和 OpenRouter 的文档列出的是 max_tokens，所以这里改用 max_tokens（Ollama、OpenRouter 的文档都没有列 max_completion_tokens）。
 */
const compatChat = (model: string): ChatCompletionsRequest & { max_tokens: number } => {
  const { messages } = toChatCompletions(REQUEST, model);
  return { model, messages, max_tokens: REQUEST.max_tokens } as ChatCompletionsRequest & { max_tokens: number };
};
export const chatReq = compatChat(COMPAT_MODEL);
export const ollamaReq = compatChat(OLLAMA_MODEL);

export const bodies = { claude: encodeJson(claudeReq), responses: encodeJson(responsesReq), chat: encodeJson(chatReq) };

export const https = {
  claude: encodeRequest(messagesHttpRequest(claudeReq)),
  responses: encodeRequest(providerRequest(PROVIDERS.openai, 'responses', responsesReq, OPENAI_KEY)),
  openrouter: encodeRequest(providerRequest(PROVIDERS.openrouter, 'chat', chatReq, OPENAI_KEY)),
  ollama: encodeRequest(providerRequest(PROVIDERS.ollama, 'chat', ollamaReq, 'ollama')),
};

// ---------- 三份响应：同一个回复、同一组 token ----------

const claudeUsage = claudeMessage.usage;
export const input = claudeUsage.input_tokens;
export const output = claudeUsage.output_tokens;

export const responsesResp = responseObject(OPENAI_MODEL, REPLY, responsesUsage(input, output), { id: exampleId('resp', 1), messageId: exampleId('msg', 2), created: EXAMPLE_EPOCH });
export const chatResp = chatCompletion(COMPAT_MODEL, REPLY, finishReasonOf(claudeMessage.stop_reason), chatUsage(input, output), { id: exampleId('chatcmpl', 1), created: EXAMPLE_EPOCH });

export const responseJson = { claude: encodeJson(claudeMessage), responses: encodeJson(responsesResp), chat: encodeJson(chatResp) };

const jsonResponse = (json: { bytes: number[] }, idHeader: Header): ReturnType<typeof makeResponse> => makeResponse(200, [['date', DATE], ['content-type', 'application/json'], idHeader], json.bytes);
export const responseHttp = {
  claude: encodeResponse(messagesHttpResponse(claudeMessage, { requestId: REQUEST_ID, date: DATE })),
  responses: encodeResponse(jsonResponse(responseJson.responses, ['x-request-id', REQUEST_ID])),
  chat: encodeResponse(jsonResponse(responseJson.chat, ['x-request-id', REQUEST_ID])),
};

// ---------- 三种流 ----------

const pieces = textPieces(replyText, 2);
export const claudeEvents = streamEvents(claudeMessage);
export const claudeFrames = claudeEvents.map(eventFrame);
export const responsesEvents = responsesStreamEvents(responsesResp, pieces);
export const responsesFrames = responsesEvents.map(responsesFrame);
const chatText = chatStream(COMPAT_MODEL, pieces, 'stop', chatUsage(input, output), { id: chatResp.id, created: EXAMPLE_EPOCH });
/** Chat Completions 的流只有 data 行，最后一行是 data: [DONE]。 */
export const chatFrames = chatText.split('\n\n').filter(Boolean).map((block) => ({ data: block.slice('data: '.length) }));
export const streams = { claude: encodeStream(claudeFrames), responses: encodeStream(responsesFrames), chat: encodeStream(chatFrames) };

// ---------- 错误 ----------

export const temperatureReq = { ...REQUEST, temperature: 0.7 };
export const temperatureError = validateRequest(temperatureReq)!;
export const temperatureHttp = encodeRequest(messagesHttpRequest(temperatureReq));
export const temperature400 = encodeResponse(errorHttpResponse(temperatureError, { requestId: REQUEST_ID }));
export const claude429 = encodeJson(errorBody(apiError('rate_limit_error', 'This request would exceed the rate limit for your organization.'), REQUEST_ID));
export const openai429 = encodeJson(openaiErrorBody(OPENAI_ERRORS.slowDown));
export const openrouter429 = encodeJson(openrouterErrorBody(429, 'Rate limit exceeded'));

// ---------- 累计 token：三种写法各调用一次（非流式 3 次、流式 3 次），每次读入输入、写出输出 ----------

const call = input + output;

// ---------- 图元 ----------

const NAMES = ['Claude', 'Responses', 'Chat'] as const;
const KEYS = ['claude', 'responses', 'chat'] as const;
const TONE = { claude: 'violet', responses: 'blue', chat: 'green' } as const;

const sizeRow = (id: string, sizes: number[], upTo: number, sub: string[] = [], lift = upTo - 1): RowPrim => ({
  kind: 'row',
  id,
  w: 78,
  cells: sizes.slice(0, upTo).map((size, i): DsCell => ({ v: NAMES[i], tone: TONE[KEYS[i]], sub: sub[i] ?? `${size} B`, key: KEYS[i], lift: i === lift || undefined })),
  center: 1,
});

const usageGrid = (upTo: number): GridPrim => {
  const names = [['input_tokens', 'output_tokens'], ['input_tokens', 'output_tokens'], ['prompt_tokens', 'completion_tokens']];
  return {
    kind: 'grid',
    id: 'u',
    w: 68,
    rows: NAMES.slice(0, upTo) as unknown as string[],
    cols: ['输入', '输出'],
    cells: names.slice(0, upTo).map((pair, r): DsCell[] => pair.map((name, c): DsCell => ({ v: name, tone: TONE[KEYS[r]], sub: String(c ? output : input) }))),
  };
};

const framesRow = (counts: number[], upTo: number): RowPrim => ({
  kind: 'row',
  id: 'e',
  w: 78,
  cells: counts.slice(0, upTo).map((count, i): DsCell => ({ v: NAMES[i], tone: TONE[KEYS[i]], sub: `${count} 帧`, key: KEYS[i], lift: i === upTo - 1 || undefined })),
  center: 1,
});

// ---------- 文案用到的数 ----------

const bytesOf = (text: string) => utf8Encode(text).length;
export const numbers = {
  input,
  output,
  claudeBody: bodies.claude.bytes.length,
  responsesBody: bodies.responses.bytes.length,
  chatBody: bodies.chat.bytes.length,
  claudeHttp: https.claude.bytes.length,
  responsesHttp: https.responses.bytes.length,
  openrouterHttp: https.openrouter.bytes.length,
  ollamaHttp: https.ollama.bytes.length,
  claudeHead: https.claude.body[0],
  responsesHead: https.responses.body[0],
  openrouterHead: https.openrouter.body[0],
  ollamaHead: https.ollama.body[0],
  claudeResp: responseJson.claude.bytes.length,
  responsesResp: responseJson.responses.bytes.length,
  chatResp: responseJson.chat.bytes.length,
  claudeFrames: claudeFrames.length,
  responsesFrames: responsesFrames.length,
  chatFrames: chatFrames.length,
  claudeStream: streams.claude.bytes.length,
  responsesStream: streams.responses.bytes.length,
  chatStream: streams.chat.bytes.length,
  doneBytes: bytesOf('data: [DONE]\n\n'),
  error400: temperature400.bytes.length - temperature400.body[0],
  claude429: claude429.bytes.length,
  openai429: openai429.bytes.length,
  openrouter429: openrouter429.bytes.length,
  calls: 6,
};
const N = numbers;

// ---------- 课程 ----------

export const dialects: Lesson = {
  id: 'dialects',
  name: 'DIALECTS',
  title: '同一请求的三种写法',
  group: 'api',
  layer: [2, 3],
  layerNote: '同一段对话在 HTTP 头、JSON 字段、SSE 事件上的写法差异，都落在 HTTP 和 JSON 这两层。',
  tokensNote: '三种写法各调用一次（非流式 3 次，流式 3 次），每次累计读入的输入和写出的输出 token。',
  nodes: ['sdk', 'gateway', 'request', 'response', 'events', 'usage'],
  place: { sdk: [110, 110], gateway: [760, 110], request: [190, 340], response: [740, 360], events: [760, 600], usage: [230, 590] },
  labels: {
    sdk: ['SDK', '三种客户端'],
    gateway: ['服务端', 'Anthropic / OpenAI / 兼容'],
    request: ['请求体', 'Claude / Responses / Chat'],
    response: ['响应体', '同一个回复'],
    events: ['流式事件', '帧数'],
    usage: ['用量字段名', '同样的 token，不同的名字'],
  },
  labelAt: { request: [-210, 30], response: [230, 24], events: [190, 20], usage: [0, 150] },
  radius: { request: 56, response: 56, events: 56, usage: 60 },
  initial: { request: [], response: [], events: [], usage: [] },
  start: ['sdk', 'request'],
  legend: [['violet', 'Claude Messages'], ['blue', 'OpenAI Responses'], ['green', 'Chat Completions（Ollama、OpenRouter）'], ['amber', '错误'], [null, 'token 列：三种写法各调用 2 次，每次读入加写出']],
  overview: {
    full: '同一段话，三种写法',
    description: `一句 system 加一个问题「${QUESTION}」，分别写成 Claude Messages（${N.claudeBody} 字节）、OpenAI Responses（${N.responsesBody} 字节）和 Chat Completions 兼容接口（${N.chatBody} 字节），发给三个地址，收到的都是同一个回复。这一课逐字节对比：system 放哪里、content 是字符串还是块数组、usage 字段叫什么、流式怎么结束、出错的 JSON 长什么样，以及 Claude 2026-10-21 版删掉 temperature 之后，同一个参数在三边的不同下场。`,
    facts: [
      ['Claude', 'POST api.anthropic.com/v1/messages'],
      ['Responses', 'POST api.openai.com/v1/responses'],
      ['Chat 兼容', 'OpenRouter、Ollama 的 /chat/completions'],
      ['请求体', `${N.claudeBody} / ${N.responsesBody} / ${N.chatBody} 字节`],
      ['token', `输入 ${input}，输出 ${output}（三边相同）`],
    ],
  },
  steps: [
    {
      title: '三份请求体：system 放哪里',
      desc: `${N.claudeBody} / ${N.responsesBody} / ${N.chatBody} 字节`,
      detail: `同一段对话，Claude 把 system 放在顶层字段，messages 里只有 user 消息；Responses 把它改叫 instructions，用户的话放进 input，只有一条用户文本时 input 可以直接是字符串；Chat Completions 没有 system 字段，system 是 messages 里 role 为 system 的第一条。上限参数的名字也不统一：Claude 和 Ollama、OpenRouter 的 Chat Completions 写 max_tokens，Responses 写 max_output_tokens，OpenAI 官方的 Chat Completions 已经改叫 max_completion_tokens。`,
      facts: [['Claude', `system 顶层，${N.claudeBody} 字节`], ['Responses', `instructions + input，${N.responsesBody} 字节`], ['Chat', `messages[0] 是 system，${N.chatBody} 字节`], ['上限', 'max_tokens / max_output_tokens / max_tokens']],
      events: [
        pk('sdk', 'request', 'violet', 'Claude Messages', [`system: 「${SYSTEM.slice(0, 6)}…」`, `messages: 1 条`], [0, 'JSON', `Claude 请求体 ${N.claudeBody} 字节：system 是顶层字段`, N.claudeBody],
          wire('Claude Messages 的请求体', 'mem', 'format', jsonBody('请求体', bodies.claude, {
            expand: ['messages[0].role', 'messages[0].content'],
            notes: { system: 'system 是顶层字段，不是一条消息。', max_tokens: '必填。', messages: '只有 user / assistant 两种 role。' },
          })),
          { ds: { request: [sizeRow('q', [N.claudeBody], 1)] } }),
        pk('sdk', 'request', 'blue', 'Responses', ['instructions', 'input: 字符串'], [0, 'JSON', `Responses 请求体 ${N.responsesBody} 字节：instructions + input`, N.responsesBody],
          wire('OpenAI Responses 的请求体', 'mem', 'format', jsonBody('请求体', bodies.responses, {
            notes: { instructions: '相当于 system 提示，顶层字符串。', input: '字符串或条目数组；只有一条用户文本时可以直接写成字符串，等价于 [{ role: "user", content: … }]。', max_output_tokens: '输出 token 上限，Responses 里的名字。' },
          })),
          { ds: { request: [sizeRow('q', [N.claudeBody, N.responsesBody], 2)] } }),
        pk('sdk', 'request', 'green', 'Chat Completions', ['messages[0]: system', 'messages[1]: user'], [0, 'JSON', `Chat 请求体 ${N.chatBody} 字节：system 是第一条消息`, N.chatBody],
          wire('Chat Completions 兼容接口的请求体', 'mem', 'format', jsonBody('请求体', bodies.chat, {
            expand: ['messages[0].role', 'messages[0].content', 'messages[1].role', 'messages[1].content'],
            notes: { messages: 'system 是 role 为 system 的第一条消息；每条的 content 在这里是字符串（也可以是内容块数组，如图片）。', max_tokens: 'Ollama 和 OpenRouter 的文档列的是 max_tokens；OpenAI 官方的 Chat Completions 已弃用它，改叫 max_completion_tokens。', model: 'OpenRouter 的模型 id 带组织前缀。' },
            example: ['model'],
          })),
          { ds: { request: [sizeRow('q', [N.claudeBody, N.responsesBody, N.chatBody], 3)] } }),
        show('gateway'),
      ],
    },
    {
      title: '四个地址，两种鉴权',
      desc: `请求 ${N.claudeHttp} / ${N.responsesHttp} / ${N.openrouterHttp} / ${N.ollamaHttp} 字节`,
      detail: `Claude 的鉴权是 x-api-key 头，并且必须带 anthropic-version；OpenAI、OpenRouter、Ollama 都是 authorization: Bearer <key>，没有版本头。Chat Completions 兼容接口只是换主机和路径：OpenRouter 在 openrouter.ai/api/v1/chat/completions，本地的 Ollama 在 localhost:11434/v1/chat/completions，它要求带一个 key 但不检查。四个请求的头部分别是 ${N.claudeHead} / ${N.responsesHead} / ${N.openrouterHead} / ${N.ollamaHead} 字节，Claude 多的是版本头，key 的长度各家也不同。`,
      facts: [['Claude', 'x-api-key + anthropic-version'], ['OpenAI', 'authorization: Bearer'], ['OpenRouter', 'openrouter.ai/api/v1/…'], ['Ollama', 'localhost:11434/v1/…，key 被忽略']],
      events: [
        pk('sdk', 'gateway', 'violet', 'Claude', ['POST /v1/messages', 'x-api-key'], [0, 'HTTP', `api.anthropic.com：${N.claudeHttp} 字节，x-api-key + anthropic-version`, N.claudeHttp],
          wire('Claude 的 HTTP 请求', 'mem', 'format', httpHead('请求头', https.claude, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'], notes: { 'anthropic-version': '必填的版本头。', 'x-api-key': '鉴权用的自定义头。' } }), jsonBody('请求体', bodies.claude))),
        pk('sdk', 'gateway', 'blue', 'Responses', ['POST /v1/responses', 'Bearer'], [0, 'HTTP', `api.openai.com：${N.responsesHttp} 字节，authorization: Bearer`, N.responsesHttp],
          wire('OpenAI Responses 的 HTTP 请求', 'mem', 'format', httpHead('请求头', https.responses, { mask: { authorization: 'Bearer sk-'.length }, example: ['authorization'], notes: { authorization: 'Bearer 令牌；没有版本头。' } }), jsonBody('请求体', bodies.responses))),
        pk('sdk', 'gateway', 'green', 'OpenRouter', ['POST /api/v1/chat/completions', 'Bearer'], [0, 'HTTP', `openrouter.ai：${N.openrouterHttp} 字节，路径带 /api 前缀`, N.openrouterHttp],
          wire('OpenRouter 的 HTTP 请求（Chat Completions 写法）', 'mem', 'format', httpHead('请求头', https.openrouter, { mask: { authorization: 'Bearer sk-'.length }, example: ['authorization'], notes: { host: 'OpenRouter 把请求转给后面的模型服务商。' } }), jsonBody('请求体', bodies.chat))),
        pk('sdk', 'gateway', 'green', 'Ollama', ['POST /v1/chat/completions', 'localhost:11434'], [0, 'HTTP', `localhost:11434：${N.ollamaHttp} 字节，key 写什么都行`, N.ollamaHttp],
          wire('本地 Ollama 的 HTTP 请求（同一种写法，换主机）', 'mem', 'format', httpHead('请求头', https.ollama, { notes: { host: '本地服务，默认端口 11434。', authorization: '客户端库要求有 key，Ollama 忽略它，所以这里直接写 ollama。' } }), jsonBody('请求体', encodeJson(ollamaReq)))),
      ],
    },
    {
      title: '同一个回复，三个响应',
      desc: `${N.claudeResp} / ${N.responsesResp} / ${N.chatResp} 字节`,
      detail: `回复文字在 Claude 的 content[0].text，在 Responses 的 output[0].content[0].text，在 Chat 的 choices[0].message.content：前两个是块数组，Chat 是字符串。结束原因分别是 stop_reason（${claudeMessage.stop_reason}）、status（${responsesResp.status}，被截断时是 incomplete）和 finish_reason（${chatResp.choices[0].finish_reason}）。用量也是三套名字，最容易混的是：Claude 和 Responses 都叫 input_tokens，含义不同，Claude 的只算最后一个缓存断点之后的部分，Responses 的包含缓存命中的部分，Chat 的 prompt_tokens 也包含。`,
      facts: [['文字', 'content[0].text / output[0].content[0].text / choices[0].message.content'], ['结束', 'stop_reason / status / finish_reason'], ['用量', `input_tokens ${input}、prompt_tokens ${input}`], ['缓存', 'Claude 另列 cache_*，OpenAI 在 *_details.cached_tokens']],
      events: [
        show('response', 'usage'),
        pk('gateway', 'sdk', 'violet', 'Claude 响应', [`stop_reason: ${claudeMessage.stop_reason}`, `input_tokens: ${input}`], [call, 'JSON', `Claude 响应 ${N.claudeResp} 字节：content 块数组，stop_reason ${claudeMessage.stop_reason}`, N.claudeResp],
          wire('Claude 的响应', 'mem', 'format', httpHead('响应头', responseHttp.claude, { example: ['request-id', 'date'] }), jsonBody('响应体', responseJson.claude, {
            expand: ['content[0].text', 'usage.input_tokens', 'usage.output_tokens'],
            example: ['id', 'content', 'content[0].text'],
            notes: { 'usage.input_tokens': `Claude 的 input_tokens 不含缓存读写，全部输入 = input_tokens + cache_creation + cache_read（这次没有缓存，等于 ${input}）。`, stop_reason: '结束原因是顶层字段。' },
          })),
          { ds: { response: [sizeRow('r', [N.claudeResp], 1)], usage: [usageGrid(1)] } }),
        pk('gateway', 'sdk', 'blue', 'Responses 响应', [`status: ${responsesResp.status}`, `input_tokens: ${input}`], [call * 2, 'JSON', `Responses 响应 ${N.responsesResp} 字节：object: response，output 数组`, N.responsesResp],
          wire('OpenAI Responses 的响应', 'mem', 'format', httpHead('响应头', responseHttp.responses, { example: ['x-request-id', 'date'] }), jsonBody('响应体', responseJson.responses, {
            expand: ['output[0].content', 'usage.input_tokens', 'usage.output_tokens', 'usage.input_tokens_details'],
            example: ['id', 'output', 'output[0].content', 'created_at'],
            notes: { status: '没有 stop_reason：正常结束是 completed，被 max_output_tokens 截断是 incomplete。', 'usage.input_tokens': '名字和 Claude 一样，含义不同：缓存命中的部分包含在里面，明细在 input_tokens_details.cached_tokens。', output: '输出是条目数组：message、function_call 等并列。' },
          })),
          { ds: { response: [sizeRow('r', [N.claudeResp, N.responsesResp], 2)], usage: [usageGrid(2)] } }),
        pk('gateway', 'sdk', 'green', 'Chat 响应', [`finish_reason: ${chatResp.choices[0].finish_reason}`, `prompt_tokens: ${input}`], [call * 3, 'JSON', `Chat 响应 ${N.chatResp} 字节：choices 数组，message.content 是字符串`, N.chatResp],
          wire('Chat Completions 的响应', 'mem', 'format', httpHead('响应头', responseHttp.chat, { example: ['x-request-id', 'date'] }), jsonBody('响应体', responseJson.chat, {
            expand: ['choices[0].message.content', 'choices[0].finish_reason', 'usage.prompt_tokens', 'usage.completion_tokens', 'usage.total_tokens'],
            example: ['id', 'choices', 'choices[0].message.content', 'created'],
            notes: { choices: '数组，n > 1 时有多个候选；每个有 index、message、finish_reason。', 'choices[0].finish_reason': 'stop 自然结束，length 被截断，tool_calls 要调用工具，content_filter 被过滤。', 'usage.prompt_tokens': '含缓存命中的部分（prompt_tokens_details.cached_tokens 是明细）。', 'usage.total_tokens': 'Chat 和 Responses 直接给出合计，Claude 的 usage 没有这个字段。' },
          })),
          { ds: { response: [sizeRow('r', [N.claudeResp, N.responsesResp, N.chatResp], 3)], usage: [usageGrid(3)] } }),
        state('gateway', { 次数: '3 次非流式' }),
      ],
    },
    {
      title: '流式：怎样算结束',
      desc: `${N.claudeFrames} / ${N.responsesFrames} / ${N.chatFrames} 帧，结束方式各不相同`,
      detail: `三种流都是 SSE，同一个 SseParser 都能解析，区别在事件的样子和结束的方式。Claude 每帧有 event 行，最后是 message_stop；Responses 每帧也有 event 行，事件多得多（每个内容块要先 added 再 done），带 sequence_number，最后是 response.completed，文档示例里没有 [DONE]；Chat Completions 只有 data 行，要加 stream_options.include_usage 才会在最后多一个 choices 为空的用量块，最后一行是 data: [DONE]，它不是 JSON，直接 JSON.parse 会抛错。`,
      facts: [['Claude', `${N.claudeFrames} 帧，${N.claudeStream} 字节，message_stop 结束`], ['Responses', `${N.responsesFrames} 帧，${N.responsesStream} 字节，response.completed 结束`], ['Chat', `${N.chatFrames} 帧，${N.chatStream} 字节，data: [DONE] 结束`], ['[DONE]', `${N.doneBytes} 字节，不是 JSON`]],
      events: [
        show('events'),
        pk('gateway', 'sdk', 'violet', 'Claude 流', [`${N.claudeFrames} 帧`, 'message_stop'], [call * 4, 'SSE', `Claude 流 ${N.claudeFrames} 帧、${N.claudeStream} 字节：以 message_stop 结束`, N.claudeStream],
          wire('Claude 的整条流', 'mem', 'format', sseBody('整条流', streams.claude, { notes: { 0: 'message_start', [claudeFrames.length - 1]: 'message_stop：流结束的标志，之后服务端关闭响应。' } })),
          { ds: { events: [framesRow([N.claudeFrames], 1)] } }),
        pk('gateway', 'sdk', 'blue', 'Responses 流', [`${N.responsesFrames} 帧`, 'response.completed'], [call * 5, 'SSE', `Responses 流 ${N.responsesFrames} 帧、${N.responsesStream} 字节：以 response.completed 结束`, N.responsesStream],
          wire('Responses 的整条流', 'mem', 'format', sseBody('整条流', streams.responses, { notes: { 0: 'response.created：此时 output 为空、usage 为 null，sequence_number 从 0 开始。', [responsesFrames.length - 1]: 'response.completed：带完整的 response，usage 到这里才有。这就是结尾，没有 [DONE]。' } })),
          { ds: { events: [framesRow([N.claudeFrames, N.responsesFrames], 2)] } }),
        pk('gateway', 'sdk', 'green', 'Chat 流', [`${N.chatFrames} 行 data`, 'data: [DONE]'], [call * 6, 'SSE', `Chat 流 ${N.chatFrames} 帧、${N.chatStream} 字节：最后一行是 data: [DONE]`, N.chatStream],
          wire('Chat Completions 的整条流', 'mem', 'format', sseBody('整条流', streams.chat, { notes: { 0: '第一块的 delta 带 role: assistant；没有 event 行，事件类型是默认的 message。', [chatFrames.length - 2]: 'include_usage 时多出来的一块：choices 是空数组，usage 在这里。', [chatFrames.length - 1]: '[DONE] 不是 JSON，是约定的结束标记，客户端必须先判断它再 JSON.parse。' } })),
          { ds: { events: [framesRow([N.claudeFrames, N.responsesFrames, N.chatFrames], 3)] } }),
      ],
    },
    {
      title: '同一个参数，不同的下场',
      desc: `Claude 带 temperature 返回 400，其余的文档里都有这个参数`,
      detail: `Claude 的 API 版本 2026-10-21 起，请求里带 temperature、top_p、top_k 任何一个都返回 400（老版本 2023-06-01 仍可用）；Responses、Chat Completions 以及 OpenRouter、Ollama 的文档里都还有 temperature。出错时的 JSON 也是三种样子：Claude 是 type: error 加 error 对象和 request_id，OpenAI 是 error 对象里的 message、type、param、code，OpenRouter 是 error 里的数字 code 加 message，HTTP 状态码和它相同。换服务商时，参数和错误处理都要跟着改，只换 base_url 往往不够。`,
      facts: [['Claude 2026-10-21', 'temperature / top_p / top_k → 400'], ['其余', '文档列有 temperature'], ['Claude 错误', 'type + error{type,message} + request_id'], ['OpenAI 错误', 'error{message,type,param,code}'], ['OpenRouter 错误', 'error{code:number,message}']],
      events: [
        pk('sdk', 'gateway', 'amber', '带 temperature', ['temperature: 0.7', `anthropic-version: 2026-10-21`], [call * 6, 'HTTP', `Claude 请求多一个 "temperature":0.7，anthropic-version 是 2026-10-21`, temperatureHttp.bytes.length],
          wire('带 temperature 的 Claude 请求', 'mem', 'format', httpHead('请求头', temperatureHttp, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'] }), jsonBody('请求体', encodeJson(temperatureReq), { notes: { temperature: '2026-10-21 版起，带这个字段（或 top_p、top_k）一律 400。' } }))),
        pk('gateway', 'sdk', 'amber', 'HTTP 400', ['invalid_request_error', temperatureError.message], [call * 6, 'ERROR', `400 invalid_request_error：${temperatureError.message}`, N.error400],
          wire('Claude 的 400 响应', 'mem', 'format', httpHead('响应头', temperature400, { startNote: '请求在到达模型之前就被拒绝，不会产生任何 token。', example: ['request-id'] }), jsonBody('响应体', encodeJson(errorBody(temperatureError, REQUEST_ID)), { expand: ['error.type', 'error.message'], example: ['request_id', 'error.message'], notes: { 'error.message': '这条措辞是示例，文档只逐字给出少数几条错误信息。', request_id: '与响应头 request-id 相同。' } }))),
        pk('gateway', 'sdk', 'amber', 'Claude 的 429', ['rate_limit_error'], [call * 6, 'ERROR', `Claude 错误体 ${N.claude429} 字节：type: error + error 对象 + request_id`, N.claude429],
          wire('Claude 的错误体', 'mem', 'format', jsonBody('响应体', claude429, { expand: ['error.type', 'error.message'], example: ['request_id', 'error.message'] }))),
        pk('gateway', 'sdk', 'amber', 'OpenAI 的 429', ['rate_limit_error', 'slow_down'], [call * 6, 'ERROR', `OpenAI 错误体 ${N.openai429} 字节：只有 error 对象，四个字段`, N.openai429],
          wire('OpenAI 的错误体', 'mem', 'format', jsonBody('响应体', encodeJson(openaiErrorBody(OPENAI_ERRORS.slowDown)), { expand: ['error.message', 'error.type', 'error.param', 'error.code'], example: ['error.message'], notes: { 'error.code': 'slow_down：请求速率涨得太快；type 和 code 是文档给出的，message 的措辞是示例。', 'error.param': '指出是哪个参数的问题，没有就是 null。' } }))),
        pk('gateway', 'sdk', 'amber', 'OpenRouter 的 429', ['code: 429'], [call * 6, 'ERROR', `OpenRouter 错误体 ${N.openrouter429} 字节：code 是数字，和 HTTP 状态码相同`, N.openrouter429],
          wire('OpenRouter 的错误体', 'mem', 'format', jsonBody('响应体', openrouter429, { expand: ['error.code', 'error.message'], example: ['error.message'], notes: { 'error.code': '数字，与 HTTP 状态码相同。' } }))),
        note('gateway', '换服务商：字段、结束方式、错误体都要改', 'amber'),
      ],
    },
  ],
  outro: {
    title: '兼容的是形状，不是全部行为',
    desc: `三份请求、三份响应、三种流`,
    text: `三种写法承载的是同一件事：一段对话进去，一个回复和一组 token 数出来。差别在细节：system 放顶层、instructions 还是第一条消息；content 是字符串还是块数组；input_tokens 含不含缓存；流是 message_stop、response.completed 还是 data: [DONE]；错误体是哪种 JSON。所谓「OpenAI 兼容」只保证请求和响应的主要形状相同，Ollama 不支持 tool_choice，上下文长度要另外设置，Claude 新版本也不再接受 temperature。写应用时把这些差异收进一层适配代码，别散在业务里。下一课看错误：限流、过载、校验失败各返回什么，该不该重试，怎样退避。`,
    facts: [['请求体', `${N.claudeBody} / ${N.responsesBody} / ${N.chatBody}`], ['响应体', `${N.claudeResp} / ${N.responsesResp} / ${N.chatResp}`], ['token', `${input} + ${output}`], ['下一课', '限流、错误与重试']],
  },
};

// ---------- 第 2、5 步的画面：事件逐个改变数据结构 ----------

const httpSubs = [`${N.claudeHttp} B`, `${N.responsesHttp} B`, `${N.openrouterHttp} B`];
dialects.steps[1].events.forEach((event, k) => {
  if (event.type !== 'packet') return;
  const lift = Math.min(k, 2);
  const subs = [...httpSubs.slice(0, Math.min(k + 1, 3))];
  if (k === 3) subs[2] = `${N.ollamaHttp} B`;
  event.ds = { request: [sizeRow('q', [N.claudeBody, N.responsesBody, N.chatBody], 3, subs, lift)] };
});

const errorCells: Array<[string, number]> = [['400', N.error400], ['Claude', N.claude429], ['OpenAI', N.openai429], ['OpenRouter', N.openrouter429]];
const errorRow = (count: number): RowPrim => ({
  kind: 'row',
  id: 'r',
  w: 74,
  cells: errorCells.slice(0, count).map(([name, size], i): DsCell => ({ v: name, tone: 'amber', sub: `${size} B`, key: `x${i}`, lift: i === count - 1 || undefined })),
  center: 1.5,
});
dialects.steps[4].events.forEach((event, k) => {
  if (event.type === 'packet') event.ds = { response: [errorRow(k)] };
});
