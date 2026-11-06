/**
 * MCP 组第二课：tools/list 与 tools/call。客户端列出小铺服务器的四个工具（inputSchema、annotations、缓存字段 ttlMs / cacheScope），
 * 调用 get_order（content 和 structuredContent），再看两种错误：找不到工具是协议错误（-32602），参数不合格是工具错误（isError: true）。
 * 最后用 mcpToolBox 把这四个工具接进 Agent 循环：tools/list 的结果变成 Messages API 的 tools，每一轮都要多带这些定义的 token。
 *
 * MCP 消息由 McpClient 和 shopServer 真实处理；循环由 runAgent 真实执行（模型写的两轮内容是脚本，标 E.G.）。
 * 前三步不调用模型，输入列是 0；第四步起是两轮模型调用的累计。tests/narrative.mcp.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  buildRequest,
  createShop,
  directTransport,
  encodeJson,
  EXAMPLE_API_KEY,
  formatUsd,
  HOST_CLIENT_INFO,
  inputBreakdown,
  McpClient,
  mcpToolBox,
  ORDER_ID,
  PRICE_DATE,
  runAgent,
  SHOP_SERVER_INFO,
  shopServer,
  text,
  toolUse,
  validate,
  type AgentConfig,
  type AgentTurn,
  type CallToolResult,
  type JsonRpcError,
  type JsonRpcResult,
  type McpTool,
  type Order,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, wire } from '../decode/structures';
import { ledgerGrid } from './common';
import { bytesOf, rpcLayer, rpcPk, rpcRow, rpcWire } from './discover';
import { note, pk, show } from './dsl';
import { dateText, MODEL, SUPPORT, SYSTEM } from './scenario';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 真实运行 ----------

/** get_order 的输出 schema（本课给服务器加的）：有了它，tools/call 的结果多带 structuredContent。signed_at 未签收时是 null，所以不写 type。 */
export const ORDER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    order_id: { type: 'string' },
    item: { type: 'string' },
    sku: { type: 'string' },
    amount: { type: 'number', description: '实付金额，元' },
    status: { type: 'string' },
    carrier: { type: 'string' },
    signed_at: { description: '签收日期 YYYY-MM-DD，未签收时是 null' },
  },
  required: ['order_id', 'item', 'amount', 'status'],
};

export const shop = createShop();
export const server = shopServer({ shop }, { outputSchemas: { get_order: ORDER_OUTPUT_SCHEMA } });
export const client = new McpClient(directTransport(server), { info: HOST_CLIENT_INFO });

/** ① tools/list */
export const list = client.listTools();
const listResult = (list.response as JsonRpcResult).result as JsonRpcResult['result'] & { tools: McpTool[]; ttlMs: number; cacheScope: string; nextCursor?: string };
export const tools = listResult.tools;

/** ② tools/call get_order */
export const call = client.callTool('get_order', { order_id: ORDER_ID });
export const callResult = (call.response as JsonRpcResult).result as unknown as CallToolResult;

/** ③ 两种错误：不存在的工具（协议错误），参数不合格（工具错误）。 */
export const UNKNOWN_TOOL = 'get_refund_status';
export const unknown = client.callTool(UNKNOWN_TOOL, { order_id: ORDER_ID });
export const BAD_ID = '1024';
export const invalid = client.callTool('get_order', { order_id: BAD_ID });
const unknownError = (unknown.response as JsonRpcError).error;
const invalidResult = (invalid.response as JsonRpcResult).result as unknown as CallToolResult;

/** ④ 接进 Agent 循环：四个工具的定义来自 tools/list，执行走 tools/call。 */
export const QUESTION = `订单 ${ORDER_ID} 签收了吗？`;
export const AGENT: AgentConfig = { name: 'support', model: MODEL, system: SYSTEM, tools: mcpToolBox(client, tools) };
export const run = runAgent(AGENT, QUESTION, [
  [text('先查一下这个订单。'), toolUse('get_order', { order_id: ORDER_ID }, 1)],
  ({ lastCalls }) => {
    const found = JSON.parse(lastCalls[0].outcome.content) as Order;
    return [text(`签收了：您的${found.item}已在 ${dateText(found.signed_at!)}由${found.carrier}送达。`)];
  },
], { ctx: { shop }, seed: 200 });
export const [t1, t2] = run.turns as [AgentTurn, AgentTurn];
/** 循环里那次 tools/call（client.exchanges 的最后一个）。 */
export const loopCall = client.exchanges[client.exchanges.length - 1];

// ---------- 文案用到的数 ----------

/** 不带工具时这一轮的输入（对比：接上服务器之前）。 */
const bare = inputBreakdown({ ...t1.request, tools: undefined });
/** react 课写在应用里的三个工具在同一个请求里占的 token。 */
const handWritten = inputBreakdown(buildRequest(SUPPORT, t1.request.messages)).tools;
const defsJson = encodeJson(t1.request.tools);

export const numbers = {
  tools: tools.map((tool) => tool.name),
  listBytes: bytesOf(list.response),
  ttlMs: listResult.ttlMs,
  cacheScope: listResult.cacheScope,
  paged: listResult.nextCursor !== undefined,
  withOutput: tools.filter((tool) => tool.outputSchema).map((tool) => tool.name),
  callBytes: bytesOf(call.request),
  resultBytes: bytesOf(call.response),
  textBytes: utf8Encode((callResult.content[0] as { text: string }).text).length,
  structuredBytes: bytesOf(callResult.structuredContent),
  structuredValid: validate(ORDER_OUTPUT_SCHEMA as never, callResult.structuredContent).length === 0,
  cacheableCall: 'ttlMs' in callResult,
  unknownCode: unknownError.code,
  unknownMessage: unknownError.message,
  invalidText: (invalidResult.content[0] as { text: string }).text,
  invalidIsError: invalidResult.isError === true,
  defsBytes: defsJson.bytes.length,
  toolsTokens: t1.breakdown.tools,
  toolSystem: t1.toolSystem,
  /** 同一个请求带不带这些工具，输入差多少：工具定义 + 工具系统提示 + 模板拼工具区的标记。 */
  perTurnExtra: t1.message.usage.input_tokens - bare.total,
  templateExtra: t1.breakdown.template - bare.template,
  bareInput: bare.total,
  handWritten,
  refundExtra: t1.breakdown.tools - handWritten,
  inputs: run.turns.map((turn) => turn.message.usage.input_tokens),
  outputs: run.turns.map((turn) => turn.message.usage.output_tokens),
  totalInput: run.totals.input,
  totalOutput: run.totals.output,
  cost: formatUsd(run.totals.cost),
  extraShare: ((t1.message.usage.input_tokens - bare.total) * run.totals.turns) / run.totals.input,
  turns: run.totals.turns,
  loopCallId: loopCall.request.id,
  methods: client.exchanges.map((exchange) => exchange.request.method),
};
const N = numbers;
const pct1 = (value: number) => `${+(value * 100).toFixed(1)}%`;

// ---------- 图元 ----------

const HINT = (value: boolean | undefined): DsCell => (value === undefined ? { v: '—', tone: 'dim' } : { v: value ? '是' : '否', tone: value ? 'violet' : 'slate' });

/** 四个工具和它们的 annotations（只是提示）。 */
const toolGrid = (lift?: string): GridPrim => ({
  kind: 'grid',
  id: 't',
  w: 50,
  rows: tools.map((tool) => tool.name),
  cols: ['只读', '破坏性', '外部'],
  cells: tools.map((tool) => [HINT(tool.annotations?.readOnlyHint), HINT(tool.annotations?.destructiveHint), HINT(tool.annotations?.openWorldHint)].map((cell) => ({ ...cell, lift: tool.name === lift || undefined }))),
});

/** 每轮多带的东西：四个工具各自的 token，加上 API 的工具系统提示。 */
const extraRow = (): RowPrim => ({
  kind: 'row',
  id: 'x',
  w: 50,
  cells: [
    { v: String(N.toolsTokens), tone: 'violet', sub: `${tools.length} 个工具定义`, key: 'defs' },
    { v: String(N.toolSystem), tone: 'slate', sub: '工具系统提示', key: 'sys' },
    { v: String(N.templateExtra), tone: 'slate', sub: '模板', key: 'tpl' },
  ],
});

const SEQ = [list.request, list.response, call.request, call.response, unknown.request, unknown.response, invalid.request, invalid.response, loopCall.request, loopCall.response];
const seq = (n: number): RowPrim => rpcRow('r', SEQ.slice(0, n), { w: 44 });

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };

function requestWire(turn: AgentTurn, notes: Record<string, string>) {
  return wire(`第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'], notes: { 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_API_KEY.length} 个字符，这里打码）。` } }),
    jsonBody('请求体', encodeJson(turn.request), {
      notes: {
        system: '系统提示：每一轮都原样带上。',
        tools: `来自 tools/list 的 ${tools.length} 个工具：name、description 照搬，inputSchema 改名 input_schema；title、annotations、outputSchema 不发给模型。展开后 ${N.toolsTokens} 个 token，API 另加工具系统提示 ${N.toolSystem} 个。`,
        messages: `到目前为止的 ${turn.request.messages.length} 条消息。`,
        ...notes,
      },
    }));
}

function responseWire(turn: AgentTurn, notes: Record<string, string>) {
  const blocks = turn.message.content.map((_, i) => `content[${i}]`);
  return wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), { expand: blocks, example: ['id', 'content', ...blocks, 'usage'], notes: { 'usage': `输入 ${num(turn.message.usage.input_tokens)}（含工具系统提示 ${N.toolSystem}）、输出 ${turn.message.usage.output_tokens}（示例）。`, ...notes } }));
}

const callNotes = {
  'params.name': '要调用的工具名，和 tools/list 里的 name 一样。',
  'params.arguments': '参数，服务器按这个工具的 inputSchema 校验。',
  'params._meta': '每个请求都带的协议元数据（上一课）。',
};

const hintNote = 'annotations 只是提示：没写的取默认值（readOnlyHint 默认 false、destructiveHint 默认 true、openWorldHint 默认 true），不可信的服务器给的不能当真。';

// ---------- 课程 ----------

const thought = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');
const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;

export const toolscall: Lesson = {
  id: 'toolscall',
  name: 'TOOLS CALL',
  title: 'tools/list 与 tools/call',
  group: 'mcp',
  layer: [2, 4],
  layerNote: '这课从「JSON-RPC」到「工具」：tools/list、tools/call 的请求和结果，两种错误怎样区分，以及这些工具怎样变成模型的一次工具调用。',
  tokensNote: `前三步只有 MCP 消息，是 0；接进循环后两轮的 usage.input_tokens 依次是 ${N.inputs.map(num).join('、')}，累计 ${num(N.totalInput)}。`,
  nodes: ['server', 'client', 'agent', 'llm', 'catalog', 'rpc', 'toolset', 'usage'],
  place: { server: [190, 140], client: [190, 430], agent: [600, 430], llm: [960, 430], catalog: [600, 130], rpc: [250, 720], toolset: [700, 690], usage: [1010, 690] },
  labels: {
    server: ['MCP 服务器', `${SHOP_SERVER_INFO.title}，${tools.length} 个工具`],
    client: ['MCP 客户端', '宿主里的连接器'],
    agent: ['Agent 运行时', '循环：请求 → 工具 → 回填'],
    llm: ['模型', MODEL],
    catalog: ['tools/list 的结果', 'annotations（提示）'],
    rpc: ['MCP 消息', '请求写 id，错误写错误码'],
    toolset: ['每轮多带的 token', '工具定义、工具系统提示、模板'],
    usage: ['账', '每轮的输入、输出 token'],
  },
  labelAt: { catalog: [0, 150], rpc: [-230, 40], toolset: [-60, 130], usage: [0, 130] },
  radius: { catalog: 80, rpc: 70, toolset: 80, usage: 70 },
  initial: { catalog: [], rpc: [], toolset: [], usage: [] },
  start: ['server', 'client'],
  legend: [['blue', '请求'], ['teal', '结果'], ['amber', '错误、tool_use'], ['violet', '工具定义'], ['green', '模型写的（E.G.）'], [null, '输入列：接进循环后模型累计读入的 token']],
  overview: {
    full: '列出工具、调用工具，再把它们交给模型',
    description: `MCP 服务器最常用的两个方法：tools/list 列出它有哪些工具（名字、说明、参数的 JSON Schema、行为提示），tools/call 按名字和参数执行一个。这一课先直接调这两个方法，看结果里的 content、structuredContent、isError，分清「协议错误」和「工具错误」；再用 mcpToolBox 把 ${tools.length} 个工具接进 Agent 循环：模型看到的工具定义来自 tools/list，它写的 tool_use 变成 tools/call。代价是这 ${tools.length} 个定义每一轮都要重新发给模型，每轮多 ${num(N.perTurnExtra)} 个输入 token。`,
    facts: [
      ['工具', N.tools.join('、')],
      ['tools/list', `${num(N.listBytes)} 字节，ttlMs ${num(N.ttlMs)}，${N.cacheScope}`],
      ['两种错误', `${N.unknownCode}（找不到工具）、isError（参数不合格）`],
      ['接进循环', `${N.turns} 轮，累计输入 ${num(N.totalInput)} token`],
      ['每轮多带', `${num(N.perTurnExtra)} token`],
    ],
  },
  steps: [
    {
      title: 'tools/list：服务器有哪些工具',
      desc: `${tools.length} 个工具，${num(N.listBytes)} 字节`,
      detail: `tools/list 的结果是一个 tools 数组，每个工具有 name、给人看的 title、description、参数的 inputSchema（JSON Schema），以及 annotations：只读、破坏性、是否接触外部世界这类行为提示。${N.withOutput.join('、')} 还带了 outputSchema，说明它的结果长什么样。这是可缓存的结果，ttlMs ${num(N.ttlMs)}、cacheScope ${N.cacheScope}；${N.paged ? '结果分了页，带 nextCursor' : '工具不多，一页列完，没有 nextCursor'}，规范还建议工具按固定顺序列出，方便客户端缓存、也提高模型提示缓存的命中率。`,
      facts: [['工具', `${tools.length} 个`], ['带 outputSchema', N.withOutput.join('、')], ['缓存', `ttlMs ${num(N.ttlMs)}，${N.cacheScope}`], ['大小', `${num(N.listBytes)} 字节`]],
      events: [
        rpcPk('client', 'server', 'blue', 'tools/list', [`id ${list.request.id}`], 'RPC', 'tools/list：除了 _meta 没有参数（不带 cursor，从第一页开始）', list.request, rpcWire('tools/list 请求', list.request, { notes: { 'params._meta': '每个请求都带的协议元数据（上一课）。' } }), { rpc: [seq(1)] }),
        show('catalog', 'rpc'),
        rpcPk('server', 'client', 'violet', `${tools.length} 个工具`, tools.map((tool) => tool.name).slice(0, 3).concat('…'), 'RPC', `结果：${tools.length} 个 Tool，ttlMs ${N.ttlMs}、cacheScope ${N.cacheScope}`, list.response, wire('tools/list 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', list.response, {
          color: 'violet',
          root: 'result',
          expand: ['result.tools[0]', 'result.tools[0].inputSchema', 'result.tools[0].outputSchema', 'result.tools[0].annotations', 'result.tools[3].annotations'],
          notes: {
            'result.tools': `${tools.length} 个工具的定义，顺序固定。`,
            'result.tools[0].inputSchema': '参数的 JSON Schema：order_id 必填，要匹配 ^A\\d{4}$。',
            'result.tools[0].outputSchema': '结果的 JSON Schema：有了它，tools/call 的结果要带符合它的 structuredContent。',
            'result.tools[0].annotations': hintNote,
            'result.tools[3].annotations': 'issue_refund：destructiveHint true，会真的打款。',
            'result.ttlMs': `${N.ttlMs / 60000} 分钟内可以直接用缓存。`,
            'result.cacheScope': 'public：每个用户看到的工具都一样，共享的网关也可以缓存。',
          },
        })), { catalog: [toolGrid()], rpc: [seq(2)] }),
      ],
    },
    {
      title: 'tools/call：content 和 structuredContent',
      desc: `get_order(${ORDER_ID})，结果 ${N.resultBytes} 字节`,
      detail: `tools/call 的参数只有两项：工具名 name 和参数 arguments。结果的 content 是一组内容块（这里是一个 text 块，装着订单的 JSON 文字）；因为 get_order 声明了 outputSchema，结果还带 structuredContent，是同一份订单的 JSON 对象（${N.structuredBytes} 字节），程序可以直接按 schema 读，规范建议同时在 text 块里放序列化后的 JSON，照顾不认识 structuredContent 的客户端。没有 isError 就是成功；tools/call 不在规范列出的可缓存方法里，所以不带 ttlMs。`,
      facts: [['参数', `name get_order，arguments.order_id ${ORDER_ID}`], ['content', `1 个 text 块，${N.textBytes} 字节`], ['structuredContent', `${N.structuredBytes} 字节，符合 outputSchema`], ['缓存字段', '没有（tools/call 不可缓存）']],
      events: [
        rpcPk('client', 'server', 'blue', `tools/call get_order`, [`id ${call.request.id}`, `order_id ${ORDER_ID}`], 'RPC', `tools/call：name get_order，arguments { order_id: ${ORDER_ID} }`, call.request, rpcWire('tools/call 请求', call.request, { expand: ['params.name', 'params.arguments', 'params._meta'], notes: callNotes }), { catalog: [toolGrid('get_order')], rpc: [seq(3)] }),
        rpcPk('server', 'client', 'teal', 'CallToolResult', [`content：订单 JSON`, `structuredContent`], 'RPC', `结果：content 一个 text 块（${N.textBytes} 字节）+ structuredContent（${N.structuredBytes} 字节）`, call.response, wire('tools/call 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', call.response, {
          color: 'teal',
          root: 'result',
          expand: ['result.content[0]', 'result.structuredContent'],
          notes: {
            'result.content': '非结构化的结果：内容块数组，可以是 text、image、audio、resource_link、resource。',
            'result.content[0]': '订单的 JSON 文字：给不认识 structuredContent 的客户端（规范的向后兼容建议）。',
            'result.structuredContent': '结构化的结果：符合 outputSchema 的 JSON 值，程序可以直接读字段。',
          },
        })), { rpc: [seq(4)] }),
      ],
    },
    {
      title: '两种错误：协议错误和工具错误',
      desc: `${N.unknownCode} 对 isError: true`,
      detail: `调用一个不存在的工具 ${UNKNOWN_TOOL}，是请求本身有问题，服务器回 JSON-RPC 错误 ${N.unknownCode}「${N.unknownMessage}」，规范把找不到工具、请求结构不对、服务器内部错误归为协议错误，模型不太能据此改正。参数不合格（order_id 写成 ${BAD_ID}，不匹配 inputSchema）却不是协议错误：结果照常返回，isError 是 true，content 写明哪里不对。规范说客户端应当把这类工具错误交给模型，让它改参数重试；协议错误可以交，也可以不交。`,
      facts: [['协议错误', `${N.unknownCode}：${N.unknownMessage}`], ['工具错误', `isError: true，「${preview(N.invalidText, 22)}」`], ['交给模型', '工具错误应当交，协议错误可以交'], ['还有', 'API 失败、业务规则不允许也算工具错误']],
      events: [
        rpcPk('client', 'server', 'blue', `tools/call ${UNKNOWN_TOOL}`, [`id ${unknown.request.id}`, '没有这个工具'], 'RPC', `调用服务器没有的工具 ${UNKNOWN_TOOL}`, unknown.request, rpcWire('tools/call 请求', unknown.request, { expand: ['params.name'], notes: { 'params.name': `${UNKNOWN_TOOL}：tools/list 里没有它。` } }), { rpc: [seq(5)] }),
        rpcPk('server', 'client', 'amber', `${N.unknownCode} Unknown tool`, [N.unknownMessage], 'ERROR', `协议错误：${N.unknownCode} ${N.unknownMessage}`, unknown.response, rpcWire('JSON-RPC 错误', unknown.response, { color: 'amber', root: 'error', notes: { 'error.code': `${N.unknownCode}：Invalid params。找不到工具是协议错误，没有 result。` } }), { rpc: [seq(6)] }),
        rpcPk('client', 'server', 'blue', `tools/call get_order`, [`id ${invalid.request.id}`, `order_id ${BAD_ID}`], 'RPC', `order_id 写成 ${BAD_ID}，不匹配 ^A\\d{4}$`, invalid.request, rpcWire('tools/call 请求', invalid.request, { expand: ['params.arguments'], notes: { 'params.arguments': `order_id ${BAD_ID}：少了开头的 A。` } }), { catalog: [toolGrid('get_order')], rpc: [seq(7)] }),
        rpcPk('server', 'client', 'amber', 'isError: true', [preview(N.invalidText, 18)], 'RESULT', `工具错误：结果照常返回，isError true，content 说明哪里不对`, invalid.response, rpcWire('tools/call 结果（工具错误）', invalid.response, { color: 'amber', root: 'result', expand: ['result.content[0]'], notes: { 'result.content[0]': '错误说明：模型读到它，可以把参数改对再调一次。', 'result.isError': 'true：工具执行失败，但这是一个正常的结果，不是 JSON-RPC 错误。' } }), { rpc: [seq(8)] }),
      ],
    },
    {
      title: '接进循环：每轮多带的工具定义',
      desc: `每轮多 ${num(N.perTurnExtra)} token`,
      detail: `mcpToolBox 把 tools/list 的 ${tools.length} 个 Tool 改写成 Messages API 的工具定义：name、description 照搬，inputSchema 改名 input_schema，title、annotations、outputSchema 不发给模型。同一个请求不带工具是 ${num(N.bareInput)} 个 token，带上之后多出 ${num(N.perTurnExtra)} 个：定义展开 ${num(N.toolsTokens)} 个、API 另加的工具系统提示 ${N.toolSystem} 个、模板拼接工具区 ${N.templateExtra} 个；react 课写在应用里的三个工具是 ${num(N.handWritten)} 个，接上服务器后 issue_refund 也进来了，又多 ${N.refundExtra} 个。第一轮输入 ${num(N.inputs[0])} 个 token，模型写下${quote(thought(t1))}，调用 get_order。`,
      facts: [['工具定义', `${tools.length} 个，${num(N.toolsTokens)} token（${num(N.defsBytes)} 字节）`], ['工具系统提示', `${N.toolSystem} token`], ['不带工具时', `${num(N.bareInput)} token`], ['第一轮输入', `${num(N.inputs[0])} token`]],
      events: [
        show('agent', 'llm', 'toolset', 'usage'),
        pk('client', 'agent', 'violet', `${tools.length} 个工具定义`, ['inputSchema → input_schema'], [0, 'CALL', `tools/list 的结果改写成 Messages API 的 tools：${tools.length} 个，${N.defsBytes} 字节`, N.defsBytes], wire('交给运行时的工具定义', 'mem', 'format', jsonBody('tools', defsJson, { color: 'violet', expand: ['[0].input_schema'], notes: { '[0].input_schema': '就是 tools/list 里的 inputSchema，只改了名字。' } }), concept('没发给模型的字段', [['title', tools.map((tool) => tool.title).join('、'), '给人看的名字。'], ['annotations', '只读、破坏性等提示', '给宿主做权限判断用。'], ['outputSchema', N.withOutput.join('、'), '客户端校验 structuredContent 用。']])), { ds: { toolset: [extraRow()] } }),
        pk('agent', 'llm', 'blue', '第 1 轮请求', [`${tools.length} 个工具 + 1 条消息`, `${num(t1.http.request.bytes.length)} 字节`], [t1.before.input, 'HTTP', `POST /v1/messages：system、${tools.length} 个 MCP 工具、1 条消息`, t1.http.request.bytes.length], requestWire(t1, { 'messages[0]': `用户的问题：${QUESTION}` })),
        pk('llm', 'agent', 'amber', 'tool_use: get_order', [`想法：${preview(thought(t1), 10)}`, `get_order(${ORDER_ID})`], [t1.after.input, 'INFER', `stop_reason tool_use：输入 ${num(N.inputs[0])}、输出 ${N.outputs[0]} token`, t1.http.response.bytes.length], responseWire(t1, { 'content[1]': '行动（示例）：调用 get_order。' }), { ds: { usage: [ledgerGrid('u', [t1])] } }),
        note('toolset', `每轮 +${num(N.perTurnExtra)}`, 'amber'),
      ],
    },
    {
      title: 'tool_use 变成 tools/call，结果回到 tool_result',
      desc: `${N.turns} 轮累计 ${num(N.totalInput)}，工具定义占 ${pct1(N.extraShare)}`,
      detail: `运行时把 tool_use 交给 mcpToolBox：客户端先按 inputSchema 校验参数，再发 tools/call（id ${N.loopCallId}），把结果的 text 块装进 tool_result，isError 就对应 is_error。第二轮带着结果再问一次，输入 ${num(N.inputs[1])} 个 token，模型只写回答，stop_reason 是 end_turn。两轮累计输入 ${num(N.totalInput)} 个 token，其中 ${pct1(N.extraShare)} 是每轮因为带工具多出来的部分；按示例单价合计 ${N.cost}（${PRICE_DATE}）。`,
      facts: [['tools/call', `id ${N.loopCallId}，get_order`], ['第二轮输入', `${num(N.inputs[1])} token`], ['累计输入', `${num(N.totalInput)} token`], ['费用', N.cost]],
      events: [
        pk('agent', 'client', 'amber', 'tool_use → tools/call', [`get_order(${ORDER_ID})`], [t1.after.input, 'TOOL', '运行时把 tool_use 交给 MCP 客户端：先按 inputSchema 校验，再发 tools/call', encodeJson(t1.calls[0].use).bytes.length], wire('tool_use 块', 'mem', 'format', jsonBody('tool_use', encodeJson(t1.calls[0].use), { color: 'amber', example: ['id', 'input'], notes: { name: '工具名原样变成 tools/call 的 params.name。', input: '参数原样变成 params.arguments。' } }))),
        rpcPk('client', 'server', 'blue', 'tools/call get_order', [`id ${loopCall.request.id}`], 'RPC', `tools/call（id ${loopCall.request.id}）：name 和 arguments 来自模型的 tool_use`, loopCall.request, rpcWire('tools/call 请求', loopCall.request, { expand: ['params.name', 'params.arguments'], notes: callNotes }), { rpc: [seq(9)] }, t1.after.input),
        rpcPk('server', 'client', 'teal', 'CallToolResult', ['订单 JSON'], 'RPC', '结果：content 的 text 块 + structuredContent', loopCall.response, rpcWire('tools/call 结果', loopCall.response, { color: 'teal', root: 'result' }), { rpc: [seq(10)] }, t1.after.input),
        pk('client', 'agent', 'teal', 'tool_result', [`${encodeJson(t1.calls[0].result).bytes.length} 字节`], [t1.after.input, 'RESULT', 'text 块的文字装进 tool_result，tool_use_id 对回去', encodeJson(t1.calls[0].result).bytes.length], wire('tool_result 块', 'mem', 'format', jsonBody('tool_result', encodeJson(t1.calls[0].result), { color: 'teal', notes: { tool_use_id: `和 tool_use 的 id 一样：${t1.calls[0].use.id}。`, content: 'CallToolResult 里 text 块的文字（structuredContent 不进提示）。' } }))),
        pk('agent', 'llm', 'blue', '第 2 轮请求', [`${t2.request.messages.length} 条消息`], [t2.before.input, 'HTTP', `POST /v1/messages：${tools.length} 个工具再发一次，${t2.request.messages.length} 条消息`, t2.http.request.bytes.length], requestWire(t2, { [`messages[${t2.request.messages.length - 1}]`]: 'tool_result，作为 user 消息。' })),
        pk('llm', 'agent', 'green', 'end_turn：回答', [preview(run.final, 16)], [t2.after.input, 'INFER', `stop_reason end_turn：输入 ${num(N.inputs[1])}、输出 ${N.outputs[1]} token`, t2.http.response.bytes.length], responseWire(t2, { 'content[0]': '回答（示例）：日期和快递来自工具结果。' }), { ds: { usage: [ledgerGrid('u', run.turns, { total: true })] } }),
        note('usage', `累计输入 ${num(N.totalInput)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '工具从服务器来，token 每轮都要付',
    desc: `${tools.length} 个工具，每轮多 ${num(N.perTurnExtra)} token`,
    text: `tools/list 告诉客户端有哪些工具和它们的参数 schema，结果可以按 ttlMs 缓存；tools/call 执行一个，结果是 content 内容块，声明了 outputSchema 的工具还带 structuredContent。找不到工具是协议错误（${N.unknownCode}），参数不合格、业务不允许是工具错误（isError: true），后者应当交给模型去改正。接进循环后，${tools.length} 个工具的定义每一轮都要重新发给模型，这次每轮多 ${num(N.perTurnExtra)} 个输入 token（本站分词器的计数加文档给的工具系统提示 ${N.toolSystem}，只代表量级），工具越多越贵。下一课看服务器的另外两样东西：资源和提示模板。`,
    facts: [['tools/list', `${tools.length} 个工具，可缓存`], ['tools/call', 'content、structuredContent、isError'], ['每轮多带', `${num(N.perTurnExtra)} token`], ['下一课', 'resources 与 prompts']],
  },
};
