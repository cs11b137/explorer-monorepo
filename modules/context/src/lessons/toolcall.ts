/**
 * 提示组第四课：函数调用的一个往返。tools 定义 → 模型回 tool_use（stop_reason: tool_use）→ 应用真正执行工具 →
 * 回传 tool_result → 模型给最终回答。两次请求、两次响应的字节由 core/ 真实编码，工具由本文件里的函数真实执行，
 * token 数按 ChatML 展开真实计数，再加上文档给出的「带工具时自动加的系统提示」286 个 token（Opus 5.5）。
 * 模型的两次回复（要调哪个工具、最终回答）是示例（E.G.），tests/narrative.prompt.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  costOf,
  createMessage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  EXAMPLE_EPOCH,
  exampleId,
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
  validateRequest,
  type ContentBlock,
  type Message,
  type MessagesRequest,
  type ToolDefinition,
  type ToolUseBlock,
} from '../core';
import { concept, httpHead, jsonBody, promptPieces, utf8Lines, wire } from '../decode/structures';
import { PART_TONE, promptSegments } from './common';
import { note, pk, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

export const MODEL = 'claude-opus-5-5';
export const SYSTEM = '你是客服助手，简洁回答。';
export const QUESTION = '订单 A1024 到哪了？';

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_order_status',
    description: '查询订单的物流状态。',
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'string', description: '订单号，例如 A1024' } },
      required: ['order_id'],
    },
  },
];

/** 应用这一侧真正执行的工具：查一张小表。模型只会「请求」调用，执行的是这段代码。 */
const ORDERS: Record<string, { status: string; carrier: string; eta: string }> = {
  A1024: { status: '运输中', carrier: '顺丰', eta: '明天送达' },
};
export function runTool(name: string, input: Record<string, unknown>): { content: string; is_error?: boolean } {
  if (name !== 'get_order_status') return { content: `未知的工具 ${name}`, is_error: true };
  const order = ORDERS[String(input.order_id)];
  if (!order) return { content: `找不到订单 ${String(input.order_id)}`, is_error: true };
  return { content: encodeJson(order).text };
}

export const REQUEST_1: MessagesRequest = { model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: [{ role: 'user', content: QUESTION }] };

/** 模型第一次回复（示例）：先说一句，再请求调用工具。 */
export const TOOL_USE: ToolUseBlock = { type: 'tool_use', id: exampleId('toolu', 1), name: 'get_order_status', input: { order_id: 'A1024' } };
export const REPLY_1: ContentBlock[] = [{ type: 'text', text: '我来查一下这个订单。' }, TOOL_USE];
export const REPLY_2: ContentBlock[] = [{ type: 'text', text: '订单 A1024 正在运输中，由顺丰承运，预计明天送达。' }];

const EXTRA = MODELS[MODEL].toolSystemTokens;
/** 官方文档：带 tools 时 API 自动加一段系统提示，计入 input_tokens。本站的模板展开不含它，所以这里加上。 */
function billed(message: Message): Message {
  return { ...message, usage: { ...message.usage, input_tokens: message.usage.input_tokens + EXTRA } };
}

const toolResult = runTool(TOOL_USE.name, TOOL_USE.input);
export const REQUEST_2: MessagesRequest = {
  ...REQUEST_1,
  messages: [
    { role: 'user', content: QUESTION },
    { role: 'assistant', content: REPLY_1 },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_USE.id, content: toolResult.content }] },
  ],
};

const ids = { req1: exampleId('req', 21), req2: exampleId('req', 22), msg1: exampleId('msg', 21), msg2: exampleId('msg', 22) };
export { ids };
const date = httpDate(EXAMPLE_EPOCH);

export const body1 = encodeJson(REQUEST_1);
export const body2 = encodeJson(REQUEST_2);
export const http1 = encodeRequest(messagesHttpRequest(REQUEST_1));
export const http2 = encodeRequest(messagesHttpRequest(REQUEST_2));
export const breakdown1 = inputBreakdown(REQUEST_1);
export const breakdown2 = inputBreakdown(REQUEST_2);
export const message1 = billed(createMessage(REQUEST_1, REPLY_1, { id: ids.msg1 }));
export const message2 = billed(createMessage(REQUEST_2, REPLY_2, { id: ids.msg2 }));
export const json1 = encodeJson(message1);
export const json2 = encodeJson(message2);
export const resp1 = encodeResponse(messagesHttpResponse(message1, { requestId: ids.req1, date }));
export const resp2 = encodeResponse(messagesHttpResponse(message2, { requestId: ids.req2, date }));
export const cost1 = costOf(message1.usage, MODEL);
export const cost2 = costOf(message2.usage, MODEL);
export const price = priceOf(MODEL);
/** 如果 tool_use_id 对不上，第二次请求会被拒绝。 */
export const mismatch = validateRequest({ ...REQUEST_2, messages: [REQUEST_2.messages[0], REQUEST_2.messages[1], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wrong', content: toolResult.content }] }] });

const toolsSpan = spanOf(body1, 'tools');
const toolsBytes = toolsSpan.to - toolsSpan.from;
const arguments_ = encodeJson(TOOL_USE.input);
const input1 = message1.usage.input_tokens;
const input2 = message2.usage.input_tokens;
const out1 = message1.usage.output_tokens;
const out2 = message2.usage.output_tokens;
const run = [input1, input1 + out1, input1 + out1 + input2, input1 + out1 + input2 + out2];

export const numbers = {
  body1: body1.bytes.length,
  body2: body2.bytes.length,
  http1: http1.bytes.length,
  http2: http2.bytes.length,
  resp1: resp1.bytes.length,
  resp2: resp2.bytes.length,
  toolsBytes,
  toolsTokens: breakdown1.tools,
  systemTokens: breakdown1.system,
  userTokens: breakdown1.messages[0],
  template1: breakdown1.template,
  toolSystem: EXTRA,
  template2: breakdown2.template,
  messages2: breakdown2.messages,
  templated1: breakdown1.total,
  templated2: breakdown2.total,
  input1,
  input2,
  out1,
  out2,
  total: run[3],
  stop1: message1.stop_reason,
  stop2: message2.stop_reason,
  cost1: cost1.total,
  cost2: cost2.total,
  costAll: cost1.total + cost2.total,
  result: toolResult.content,
  argumentsBytes: arguments_.bytes.length,
};
const N = numbers;
const model = MODELS[MODEL];
const fmt = formatUsd;
const PUB = 'sk-ant-api03-'.length;

// ---------- 图元 ----------

const sizeOf = (json: ReturnType<typeof encodeJson>, path: string) => {
  const span = spanOf(json, path);
  return span.to - span.from;
};

const requestRow = (round: 1 | 2): RowPrim => {
  const json = round === 1 ? body1 : body2;
  return {
    kind: 'row',
    id: 'q',
    w: 66,
    cells: [
      { v: 'tools', tone: PART_TONE.tools, sub: `${sizeOf(json, 'tools')} B`, key: 'tools' },
      { v: 'system', tone: PART_TONE.system, sub: `${sizeOf(json, 'system')} B`, key: 'system' },
      { v: 'messages', tone: PART_TONE.user, sub: `${sizeOf(json, 'messages')} B`, key: 'messages' },
    ],
  };
};

const responseRow = (round: 1 | 2): RowPrim => {
  const json = round === 1 ? json1 : json2;
  const message = round === 1 ? message1 : message2;
  return {
    kind: 'row',
    id: 'r',
    w: 66,
    cells: [
      { v: 'content', tone: PART_TONE.assistant, sub: `${sizeOf(json, 'content')} B`, key: 'content' },
      { v: 'stop_reason', tone: 'blue', sub: `${sizeOf(json, 'stop_reason')} B`, key: 'stop_reason' },
      { v: 'usage', tone: 'amber', sub: `${sizeOf(json, 'usage')} B`, key: 'usage' },
    ],
    marks: [{ at: 1, text: message.stop_reason, color: round === 1 ? 'teal' : 'green', dx: 26 }],
  };
};

/** 展开后的输入：tools、API 自动加的工具系统提示、system、消息、模板。 */
const promptRow = (round: 1 | 2): RowPrim => {
  const b = round === 1 ? breakdown1 : breakdown2;
  const segments = promptSegments(b.prompt, round === 1 ? ['user'] : ['user', 'assistant', 'user']);
  const cells: DsCell[] = [];
  const short: Record<string, string> = { 'messages[0]': round === 1 ? '问题' : '问题', 'messages[1]': 'tool_use', 'messages[2]': '结果', template: '模板' };
  for (const segment of segments) {
    cells.push({ v: String(segment.tokens), tone: segment.tone, sub: short[segment.source] ?? segment.label, key: segment.source });
    if (segment.source === 'tools') cells.push({ v: String(EXTRA), tone: 'teal', sub: '工具提示', key: 'toolsys' });
  }
  return { kind: 'row', id: 'p', w: 56, cells };
};

const toolsRow = (): RowPrim => ({
  kind: 'row',
  id: 't',
  w: 66,
  cells: [
    { v: 'A1024', tone: 'teal', sub: 'order_id', key: 'in' },
    { v: '运输中', tone: 'teal', sub: '结果', key: 'out' },
  ],
});

const usageGrid = (rows: 1 | 2): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 78,
  rows: ['请求 1', '请求 2'].slice(0, rows),
  cols: ['输入', '输出', '费用'],
  cells: ([
    [{ v: String(input1), tone: 'blue' }, { v: String(out1), tone: 'green' }, { v: fmt(cost1.total), tone: 'amber' }],
    [{ v: String(input2), tone: 'blue' }, { v: String(out2), tone: 'green' }, { v: fmt(cost2.total), tone: 'amber' }],
  ] as DsCell[][]).slice(0, rows),
});

const requestLayers = (http: typeof http1, body: typeof body1, options: { expand?: string[]; notes?: Record<string, string> } = {}) => [
  httpHead('请求头', http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
  jsonBody('请求体', body, { expand: options.expand, notes: options.notes }),
];

// ---------- 课程 ----------

export const toolcall: Lesson = {
  id: 'toolcall',
  name: 'TOOLCALL',
  title: '函数调用的一个往返',
  group: 'prompt',
  layer: [3, 5],
  layerNote: '工具定义和 tool_use / tool_result 是 JSON 里的内容块，也是模板里占 token 的文字。',
  tokensNote: '两次请求各自读入的输入（含工具定义和工具系统提示）加两次写出的输出，依次累加。',
  nodes: ['app', 'request', 'model', 'response', 'tools', 'prompt', 'usage'],
  place: { app: [100, 280], request: [430, 90], model: [880, 280], response: [540, 580], tools: [110, 600], prompt: [870, 590], usage: [560, 330] },
  labels: {
    app: ['应用', '调用 SDK、执行工具'],
    request: ['请求', 'tools + system + messages'],
    model: ['模型', model.name],
    response: ['响应', 'content、stop_reason、usage'],
    tools: ['工具执行端', 'get_order_status'],
    prompt: ['模型读到的输入', '按来源分段的 token 数'],
    usage: ['两次账单', `示例单价，${PRICE_DATE}`],
  },
  labelAt: { request: [-210, 20], response: [-210, 30], prompt: [20, 120], usage: [-250, 70] },
  radius: { request: 60, response: 60, prompt: 60, usage: 56 },
  initial: { request: [], response: [], prompt: [], usage: [] },
  start: ['app', 'request'],
  legend: [['teal', '工具定义和工具结果'], ['violet', 'system'], ['blue', '用户消息'], ['green', '模型的回复（E.G.）'], ['slate', '模板和 HTTP 头'], [null, 'token 列：两次请求累计的输入加输出']],
  overview: {
    full: '一次函数调用，要请求两次',
    description: `模型自己不会查订单：它只能「请求」调用你定义的工具。第一次请求带上 tools 定义（${N.toolsBytes} 字节），模型回一个 tool_use 块，stop_reason 是 tool_use；应用真正执行函数，把结果放进 tool_result，连同整段历史再请求一次，模型才给出最终回答。两次请求共 ${N.http1} 和 ${N.http2} 字节，输入 token 是 ${input1} 和 ${input2}，其中每次都含 API 自动加的 ${EXTRA} 个 token 的工具系统提示。`,
    facts: [
      ['接口', 'POST https://api.anthropic.com/v1/messages，调用两次'],
      ['模型', `${MODEL}（${model.name}）`],
      ['请求', `${N.http1} 字节，然后 ${N.http2} 字节`],
      ['token', `输入 ${input1} + ${input2}，输出 ${out1} + ${out2}`],
      ['费用', `${fmt(N.costAll)}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '请求里带上工具定义',
      desc: `tools 占 ${N.toolsBytes} 字节，整个请求 ${N.http1} 字节`,
      detail: `tools 是顶层字段，每个工具有 name、description 和 JSON Schema 写的 input_schema；模型靠名字和描述判断什么时候该用它。这个请求没有设 tool_choice，默认是 auto，由模型自己决定调不调用（${model.name} 不支持强制调用，tool_choice 为 any 或 tool 会返回 400）。工具定义和 system、messages 一样，要展开成 token 计入 input_tokens。`,
      facts: [['tools', `${N.toolsBytes} 字节`], ['工具', `${TOOLS[0].name}：参数 order_id`], ['tool_choice', '默认 auto'], ['请求', `${N.http1} 字节（体 ${N.body1}）`]],
      events: [
        state('app', { 问: QUESTION }),
        pk('app', 'request', 'teal', '请求 1', ['tools: 1 个', `${N.http1} 字节`], [0, 'HTTP', `第一次请求：tools ${N.toolsBytes} 字节，请求体 ${N.body1} 字节，整个请求 ${N.http1} 字节`, N.http1],
          wire('第一次请求：带 tools', 'mem', 'format', ...requestLayers(http1, body1, {
            expand: ['tools[0].name', 'tools[0].description', 'tools[0].input_schema'],
            notes: {
              tools: '工具定义数组。每项 name、description、input_schema（JSON Schema）。',
              'tools[0].description': '模型靠它判断什么时候用这个工具，写清楚能做什么。',
              'tools[0].input_schema': '参数的 JSON Schema：模型生成的 input 要符合它。',
            },
          })),
          { ds: { request: [requestRow(1)] } }),
      ],
    },
    {
      title: '模型回 tool_use，停下等结果',
      desc: `stop_reason 是 ${message1.stop_reason}，输入 ${input1} 个 token`,
      detail: `API 把 tools、system、消息展开成 ${N.templated1} 个 token（工具定义 ${N.toolsTokens}），再加 ${EXTRA} 个 token 的工具系统提示，input_tokens 是 ${input1}。示例回复先写了一句话，再给出一个 tool_use 块：id 以 toolu_ 开头，name 是要调用的函数，input 是按 schema 填好的参数。stop_reason 是 tool_use，意思是模型在等你的结果，而不是说完了。`,
      facts: [['input_tokens', `${N.templated1} + ${EXTRA} = ${input1}`], ['stop_reason', message1.stop_reason], ['output_tokens', `${out1}（E.G.）`], ['响应', `${N.resp1} 字节`]],
      events: [
        show('model', 'prompt'),
        pk('request', 'model', 'violet', '展开成 token', [`${input1} 个输入 token`, `含工具系统提示 ${EXTRA}`], [input1, 'TEMPLATE', `输入 ${input1} 个 token：工具 ${N.toolsTokens}、system ${N.systemTokens}、问题 ${N.userTokens}、模板 ${N.template1}，加工具系统提示 ${EXTRA}`, breakdown1.prompt.bytes.length],
          wire('模型读到的文本（ChatML 演示）', 'mem', 'internal', promptPieces('ChatML 文本', breakdown1.prompt, { notes: { tools: '工具定义放在 system 那一轮最前面（本站的写法，借自 Qwen2.5）。' } })),
          { ds: { prompt: [promptRow(1)] } }),
        show('response'),
        pk('model', 'response', 'teal', 'tool_use', [`${TOOL_USE.name}`, JSON.stringify(TOOL_USE.input)], [input1 + out1, 'TOOL', `模型请求调用 ${TOOL_USE.name}(${JSON.stringify(TOOL_USE.input)})，写出 ${out1} 个输出 token，停下`, N.resp1],
          wire('第一次响应（内容是示例）', 'mem', 'format',
            httpHead('响应头', resp1, { example: ['request-id', 'date'] }),
            jsonBody('响应体', json1, {
              expand: ['content[1].type', 'content[1].name', 'content[1].input'],
              example: ['id', 'content', 'content[1].id', 'content[1].input'],
              notes: {
                content: '两个内容块：一句文字，一个 tool_use。',
                stop_reason: 'tool_use：模型调用了工具，等应用把结果回传。',
                'content[1].input': '模型按 input_schema 生成的参数（示例）。',
                'usage.input_tokens': `展开后 ${N.templated1} 个，加上工具系统提示 ${EXTRA} 个。`,
              },
            })),
          { ds: { response: [responseRow(1)] } }),
      ],
    },
    {
      title: '应用执行工具',
      desc: `真的执行 ${TOOL_USE.name}，得到 ${N.result.length} 个字符的结果`,
      detail: `模型只是写出了「我想调用这个函数」，真正执行的是你的代码：SDK 把响应交给应用，应用按 name 找到函数，用 input 作参数运行，这里是查一张小表。执行可能失败（找不到订单、超时），失败时回传 is_error 为 true 的 tool_result，模型会据此换个办法或者向用户解释。模型生成的参数要当作不可信输入校验，别直接拼进 SQL 或命令行。`,
      facts: [['函数', `${TOOL_USE.name}(${JSON.stringify(TOOL_USE.input)})`], ['结果', N.result], ['执行方', '应用（不是模型，也不是 API）'], ['失败', 'tool_result 带 is_error: true']],
      events: [
        show('tools'),
        pk('response', 'app', 'teal', '收到 tool_use', [`stop_reason: ${message1.stop_reason}`], [input1 + out1, 'CALL', `SDK 交回 Message：stop_reason ${message1.stop_reason}，要执行 ${TOOL_USE.name}`, spanOf(json1, 'content').to - spanOf(json1, 'content').valueFrom],
          wire('应用读到的 content', 'mem', 'format', jsonBody('响应体', json1, { root: 'content', example: ['content', 'content[1].id', 'content[1].input'] }))),
        pk('app', 'tools', 'teal', '执行函数', [TOOL_USE.name, JSON.stringify(TOOL_USE.input)], [input1 + out1, 'TOOL', `执行 ${TOOL_USE.name}(${JSON.stringify(TOOL_USE.input)})`, N.argumentsBytes],
          wire('函数的参数', 'mem', 'format', jsonBody('input', arguments_, { color: 'teal', example: ['order_id'] })),
          { ds: { tools: [toolsRow()] } }),
        pk('tools', 'app', 'teal', '工具结果', [N.result], [input1 + out1, 'TOOL', `工具返回 ${utf8Encode(N.result).length} 字节的结果：${N.result}`, utf8Encode(N.result).length],
          wire('工具返回的文本', 'mem', 'format', utf8Lines('结果', N.result, { color: 'teal', summary: '应用把它放进 tool_result 的 content', notes: { 0: '字符串或 text 块数组都可以。模型读到的就是这段文字。' } })),
          { ds: { tools: [toolsRow()] } }),
      ],
    },
    {
      title: '回传 tool_result，再请求一次',
      desc: `第二次请求 ${N.http2} 字节，输入 ${input2} 个 token`,
      detail: `第二次请求要把前面的全部带上：tools 和 system 原样重发，messages 变成三条：最初的提问、模型刚才那条 assistant（含 tool_use 块）、一条新的 user，里面是 tool_result，tool_use_id 必须和 tool_use 的 id 一一对应，对不上会 400。API 无状态，所以输入 token 是 ${input2}，比第一次多了 ${input2 - input1}；工具定义和 ${EXTRA} 个工具系统提示每次请求都要付一遍。`,
      facts: [['tool_use_id', `${TOOL_USE.id.slice(0, 14)}…（E.G.）`], ['请求', `${N.http2} 字节（第一次 ${N.http1}）`], ['input_tokens', `${N.templated2} + ${EXTRA} = ${input2}`], ['累计 token', String(run[2])]],
      events: [
        pk('app', 'request', 'teal', '请求 2', ['assistant: tool_use', 'user: tool_result'], [input1 + out1, 'HTTP', `第二次请求 ${N.http2} 字节：带上 tool_use 和 tool_result，tool_use_id 对应`, N.http2],
          wire('第二次请求：带 tool_result', 'mem', 'format', ...requestLayers(http2, body2, {
            expand: ['messages[1].content[1].id', 'messages[2].content[0].type', 'messages[2].content[0].tool_use_id', 'messages[2].content[0].content'],
            notes: {
              'messages[1].content[1].id': '模型生成的 tool_use id（示例）。',
              'messages[2].content[0].tool_use_id': '必须等于上一条 assistant 里 tool_use 的 id。',
              'messages[2].content[0].content': '工具结果：字符串，或 text 块数组。',
            },
          })),
          { ds: { request: [requestRow(2)] } }),
        pk('request', 'model', 'violet', '展开成 token', [`${input2} 个输入 token`], [run[2], 'TEMPLATE', `输入 ${input2} 个 token：比第一次多 ${input2 - input1}，多出来的是 tool_use 和 tool_result`, breakdown2.prompt.bytes.length],
          wire('模型读到的文本（ChatML 演示）', 'mem', 'internal', promptPieces('ChatML 文本', breakdown2.prompt, { notes: { 'messages[1].content[1]': 'tool_use 块在模板里写成 <tool_call> 包起来的 JSON（本站的写法，借自 Qwen2.5）。', 'messages[2].content[0]': 'tool_result 写成 <tool_response>。' } })),
          { ds: { prompt: [promptRow(2)] } }),
      ],
    },
    {
      title: '模型给出最终回答',
      desc: `stop_reason 是 ${message2.stop_reason}，输出 ${out2} 个 token`,
      detail: `模型读到工具结果后，这次直接写文字回答，写完自然停下，stop_reason 是 ${message2.stop_reason}，一次函数调用才算结束。如果它觉得信息还不够，也可以再回一个 tool_use，应用就重复「执行、回传」，这就是常说的 agent 循环；真正的代码要给循环设一个最大轮数。最终回答是示例，${out2} 个输出 token 和响应字节是真实计算的。`,
      facts: [['stop_reason', message2.stop_reason], ['output_tokens', `${out2}（E.G.）`], ['响应', `${N.resp2} 字节`], ['累计 token', String(run[3])]],
      events: [
        pk('model', 'response', 'green', '最终回答', [`「${(REPLY_2[0] as { text: string }).text.slice(0, 12)}…」`], [run[3], 'INFER', `写出 ${out2} 个输出 token，自然停下：${message2.stop_reason}`, N.resp2],
          wire('第二次响应（内容是示例）', 'mem', 'format',
            httpHead('响应头', resp2, { example: ['request-id', 'date'] }),
            jsonBody('响应体', json2, { expand: ['content[0].text', 'usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content', 'content[0].text'], notes: { stop_reason: 'end_turn：说完了。', 'usage.input_tokens': `展开后 ${N.templated2} 个，加上工具系统提示 ${EXTRA} 个。` } })),
          { ds: { response: [responseRow(2)] } }),
        pk('response', 'app', 'green', 'Message', [`stop_reason: ${message2.stop_reason}`], [run[3], 'CALL', `SDK 交回最终的 Message：${message2.stop_reason}`, sizeOf(json2, 'content')],
          wire('应用读到的 content', 'mem', 'format', jsonBody('响应体', json2, { root: 'content', example: ['content', 'content[0].text'] }))),
        state('app', { 问: null, 答: `运输中，顺丰，明天` }),
      ],
    },
    {
      title: '两次请求，两张账单',
      desc: `输入 ${input1} + ${input2}，输出 ${out1} + ${out2}，${fmt(N.costAll)}`,
      detail: `一次函数调用要付两次输入：第一次 ${input1} 个 token，第二次 ${input2} 个。按示例单价，输入 ${formatPrice(price.input)}、输出 ${formatPrice(price.output)}：${fmt(cost1.total)} + ${fmt(cost2.total)} = ${fmt(N.costAll)}。每多一轮往返，前面所有内容（包括 ${N.toolsTokens} 个 token 的工具定义和 ${EXTRA} 个 token 的工具系统提示）都要再读一遍，这正是下一课提示缓存要省的东西。`,
      facts: [['请求 1', `${input1} × ${formatPrice(price.input)} + ${out1} × ${formatPrice(price.output)} = ${fmt(cost1.total)}`], ['请求 2', `${input2} × ${formatPrice(price.input)} + ${out2} × ${formatPrice(price.output)} = ${fmt(cost2.total)}`], ['合计', fmt(N.costAll)], ['单价日期', PRICE_DATE]],
      events: [
        show('usage'),
        pk('response', 'usage', 'amber', '两次用量', [`${input1} / ${out1}`, `${input2} / ${out2}`], [N.total, 'CALL', `两次用量：输入 ${input1} + ${input2}，输出 ${out1} + ${out2}，示例费用 ${fmt(N.costAll)}`, sizeOf(json1, 'usage') + sizeOf(json2, 'usage')],
          wire('两次响应的 usage，和按示例单价算出的费用', 'mem', 'format',
            jsonBody('请求 1 的 usage', json1, { root: 'usage', color: 'teal' }),
            jsonBody('请求 2 的 usage', json2, { root: 'usage', color: 'green' }),
            concept(`费用（示例单价，${PRICE_DATE}）`, [
              ['请求 1', fmt(cost1.total)],
              ['请求 2', fmt(cost2.total)],
              ['合计', fmt(N.costAll), '价格会变，以 Anthropic 定价页为准。'],
            ])),
          { ds: { usage: [usageGrid(2)] } }),
        note('usage', `一次函数调用 ${fmt(N.costAll)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '函数调用是一来一回的两次请求',
    desc: `${input1} + ${input2} 个输入 token，${fmt(N.costAll)}`,
    text: `工具调用没有新协议：tools 是请求里的一个字段，tool_use 和 tool_result 是内容块，stop_reason 为 tool_use 的响应后面必须跟一个带 tool_result 的请求。工具定义和自动加的工具系统提示（${model.name} 是 ${EXTRA} 个 token）算输入 token，每次往返都要重发、重算。这里的工具参数和最终回答是示例，字节、token、费用是真实计算的；本站的 token 数来自迷你分词器，真实数字不同。下一课看怎样让这些每次都一样的前缀只算一次：Prompt Caching。`,
    facts: [['请求', `${N.http1} → ${N.http2} 字节`], ['输入 token', `${input1} → ${input2}`], ['停止原因', `${message1.stop_reason} → ${message2.stop_reason}`], ['下一课', 'Prompt Caching 在 API 层']],
  },
};

