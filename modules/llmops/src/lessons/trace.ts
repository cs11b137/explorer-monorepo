/**
 * 可观测性第一课：一次请求的 trace。客服处理「A1024 的杯盖漏水，能退吗？」：防护层先筛查（本站的检测器 + 一次 Claude Haiku 5.5 筛查），
 * 再调用 Claude Opus 5.5（第一轮要查订单）、执行 get_order、第二轮写回答，最后查一遍输出。
 *
 * 每一步都真实记成 span（core/trace.ts 的 Tracer）：span id、父子关系、OpenTelemetry GenAI 语义约定的属性（chatRequestAttrs、
 * chatResponseAttrs、toolAttrs、agentAttrs）、W3C traceparent（formatTraceparent，写进发给 Messages API 的请求头）、
 * OTLP/JSON 导出（otlpTraces、encodeOtlp、otlpHttpRequest）。token 和费用由 callModel 真实计算；
 * **耗时是模拟的**（latency.ts 的 modelTiming，固定种子的对数正态抖动 + 本站假设的参数），不是实测。
 * 模型写的话（筛查判断、两轮回复）是脚本，标 E.G.。tests/narrative.observe.test.ts 核对文案。
 *
 * 防护层自己的两个 span（guard input、guard output）和属性 xiaopu.guard.* 是本站的命名：GenAI 约定没有定义防护层的 span。
 */
import {
  agentAttrs,
  agentSpanName,
  attrOf,
  callModel,
  chatRequestAttrs,
  chatResponseAttrs,
  chatSpanName,
  detect,
  encodeJson,
  encodeOtlp,
  encodeRequest,
  EXAMPLE_API_KEY,
  exampleId,
  FLAG_SAMPLED,
  flattenTree,
  formatTraceparent,
  formatUsd,
  GENAI,
  jitter,
  leakCheck,
  messagesHttpRequest,
  modelTiming,
  ORDERS,
  ORDER_ID,
  OTLP_HTTP_PORT,
  OTLP_TRACES_PATH,
  otlpHttpRequest,
  otlpTraces,
  parseTraceparent,
  PRICE_DATE,
  replyText,
  SHOP_TOOL_DEFS,
  SPAN_KIND_CODE,
  spanTree,
  toolAttrs,
  toolSpanName,
  traceIdOf,
  Tracer,
  unixNano,
  utf8Encode,
  type ContentBlock,
  type MessagesRequest,
  type ModelCall,
  type Span,
  type ToolUseBlock,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, traceparentField, utf8Lines, wire } from '../decode/structures';
import { prob } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { MODEL, NORMAL_ASK, NORMAL_REPLY, SCREEN_MODEL, screenRequest, SYSTEM, USER_ID } from './scenario';
import type { DsCell, GraphPrim, GridPrim, Lesson, RowPrim, Tone } from './types';

// ---------- 一次请求：三次模型调用、一次工具执行 ----------

export const TRACE_SEED = 1107;
export const traceId = traceIdOf(TRACE_SEED);
const def = SHOP_TOOL_DEFS.get_order;
/** 发给模型的工具定义：共享包里 get_order 的 name、description、input_schema。 */
export const TOOLS = [{ name: def.name, description: def.description, input_schema: def.input_schema }];
export const toolUse: ToolUseBlock = { type: 'tool_use', id: exampleId('toolu', TRACE_SEED), name: 'get_order', input: { order_id: ORDER_ID } };
/** 第一轮的回复（示例）：一句话加一个工具调用。 */
export const LOOKUP = '我先查一下这个订单。';
const reply1: ContentBlock[] = [{ type: 'text', text: LOOKUP }, toolUse];
/** 客服的请求：流式（用户先看到字），带 system、metadata.user_id 和 get_order。 */
export const req1: MessagesRequest = { model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, metadata: { user_id: USER_ID }, tools: TOOLS, messages: [{ role: 'user', content: NORMAL_ASK }] };
export const order = ORDERS.find((o) => o.order_id === ORDER_ID)!;
/** get_order 在共享包的订单数据上真实查到的结果。 */
export const toolResult = encodeJson(order);
export const req2: MessagesRequest = { ...req1, messages: [...req1.messages, { role: 'assistant', content: reply1 }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult.text }] }] };
export const SCREEN_OK = '{"injection_suspected": false}';

export const detection = detect(NORMAL_ASK);
export const screen: ModelCall = callModel(screenRequest(NORMAL_ASK), SCREEN_OK, TRACE_SEED + 1);
export const chat1: ModelCall = callModel(req1, reply1, TRACE_SEED + 2);
export const chat2: ModelCall = callModel(req2, NORMAL_REPLY, TRACE_SEED + 3);
export const leak = leakCheck(replyText(chat2.message), SYSTEM);
export const CALLS = [screen, chat1, chat2] as const;

// ---------- 耗时（模拟） ----------

/** 本站假设的非模型环节耗时（毫秒）：本地检测器、输出检查、相邻两步之间的间隔；工具的基准耗时再乘一次抖动。 */
export const ASSUMED_MS = { detector: 2, check: 2, gap: 1, toolBase: 40 };
const rand = jitter(TRACE_SEED, 0.35);
export const tScreen = modelTiming(SCREEN_MODEL, screen.message.usage.input_tokens, screen.message.usage.output_tokens, rand);
export const t1 = modelTiming(MODEL, chat1.message.usage.input_tokens, chat1.message.usage.output_tokens, rand);
export const toolMs = Math.round(ASSUMED_MS.toolBase * rand() * 10) / 10;
export const t2 = modelTiming(MODEL, chat2.message.usage.input_tokens, chat2.message.usage.output_tokens, rand);

// ---------- span ----------

const r1 = (v: number) => Math.round(v * 10) / 10;
const seconds = (ms: number) => +(ms / 1000).toFixed(4);
const G = ASSUMED_MS.gap;
export const AGENT = 'xiaopu-support';
const tracer = new Tracer(traceId, TRACE_SEED);
export const root = tracer.start(agentSpanName(AGENT), 'INTERNAL', null, 0, agentAttrs(AGENT));
export const guardIn = tracer.start('guard input', 'INTERNAL', root, G);
export const screenSpan = tracer.start(chatSpanName(SCREEN_MODEL), 'CLIENT', guardIn, G + ASSUMED_MS.detector, chatRequestAttrs(SCREEN_MODEL, screen.request.max_tokens));
tracer.end(screenSpan, r1(screenSpan.start + tScreen.total), chatResponseAttrs(screen.message));
tracer.end(guardIn, r1(screenSpan.end + G), [['xiaopu.guard.rule_hits', { int: detection.rules.length }], ['xiaopu.guard.p', +detection.prediction.p.toFixed(3)], ['xiaopu.guard.flagged', false]]);
export const chatSpan1 = tracer.start(chatSpanName(MODEL), 'CLIENT', root, r1(guardIn.end + G), chatRequestAttrs(MODEL, req1.max_tokens));
tracer.end(chatSpan1, r1(chatSpan1.start + t1.total), chatResponseAttrs(chat1.message, seconds(t1.ttft)));
export const toolSpan = tracer.start(toolSpanName('get_order'), 'INTERNAL', root, r1(chatSpan1.end + G), toolAttrs('get_order', toolUse.id));
tracer.end(toolSpan, r1(toolSpan.start + toolMs));
export const chatSpan2 = tracer.start(chatSpanName(MODEL), 'CLIENT', root, r1(toolSpan.end + G), chatRequestAttrs(MODEL, req2.max_tokens));
tracer.end(chatSpan2, r1(chatSpan2.start + t2.total), chatResponseAttrs(chat2.message, seconds(t2.ttft)));
export const guardOut = tracer.start('guard output', 'INTERNAL', root, r1(chatSpan2.end + G));
tracer.end(guardOut, r1(guardOut.start + ASSUMED_MS.check), [['xiaopu.guard.leaked', leak.leaked]]);
tracer.end(root, r1(guardOut.end + G), [], { code: 'OK' });

export const spans: readonly Span[] = tracer.spans;
export const tree = spanTree(spans);
export const flat = flattenTree(tree);
export const duration = (span: Span) => r1(span.end - span.start);

/** 发给 Messages API 的 traceparent：parent-id 是这次调用自己的 CLIENT span（chat 那个），sampled 置位。 */
export const traceparent = formatTraceparent({ traceId, spanId: chatSpan1.spanId, flags: FLAG_SAMPLED });
export const parsed = parseTraceparent(traceparent);
export const http1 = encodeRequest(messagesHttpRequest(req1, { extra: [['traceparent', traceparent]] }));
export const RESOURCE = { attributes: [['service.name', 'xiaopu-support'] as [string, string]] };
export const SCOPE = { name: 'xiaopu.support', version: '1.0.0' };
export const otlpBody = otlpTraces(RESOURCE, SCOPE, spans);
export const otlp = encodeOtlp(otlpBody);
export const otlpHttp = encodeRequest(otlpHttpRequest(otlp));

// ---------- 文案用到的数 ----------

const usage = (c: ModelCall) => c.message.usage;
const totalCost = CALLS.reduce((a, c) => a + c.cost.total, 0);
const jsonPath = (path: string) => otlp.spans.find((s) => s.path === path)!;
const pathBytes = (path: string) => jsonPath(path).to - jsonPath(path).valueFrom;
const SPANS_PATH = 'resourceSpans[0].scopeSpans[0].spans';
const spanIndex = (span: Span) => spans.indexOf(span);

export const numbers = {
  spanCount: spans.length,
  traceIdChars: traceId.length,
  spanIdChars: chatSpan1.spanId.length,
  traceparentChars: traceparent.length,
  traceparent,
  flags: traceparent.slice(-2),
  sampled: parsed.ok && parsed.sampled,
  screenInput: usage(screen).input_tokens,
  screenOutput: usage(screen).output_tokens,
  screenCost: formatUsd(screen.cost.total),
  input1: usage(chat1).input_tokens,
  output1: usage(chat1).output_tokens,
  cost1: formatUsd(chat1.cost.total),
  input2: usage(chat2).input_tokens,
  output2: usage(chat2).output_tokens,
  cost2: formatUsd(chat2.cost.total),
  stop1: chat1.message.stop_reason,
  stop2: chat2.message.stop_reason,
  totalCostNano: totalCost,
  totalCost: formatUsd(totalCost),
  detectorP: prob(detection.prediction.p),
  ruleHits: detection.rules.length,
  rootMs: duration(root),
  rootSelf: r1(tree[0].self),
  screenMs: duration(screenSpan),
  chat1Ms: duration(chatSpan1),
  chat2Ms: duration(chatSpan2),
  toolMs: duration(toolSpan),
  ttft1: seconds(t1.ttft),
  ttft2: seconds(t2.ttft),
  requestBytes: http1.bytes.length,
  otlpBytes: otlp.bytes.length,
  otlpRequestBytes: otlpHttp.bytes.length,
  spansBytes: pathBytes(SPANS_PATH),
  resourceBytes: pathBytes('resourceSpans[0].resource'),
  scopeBytes: pathBytes('resourceSpans[0].scopeSpans[0].scope'),
  attrCount1: chatSpan1.attributes.length,
  toolResultBytes: toolResult.bytes.length,
  overlap: leak.overlap,
  startNano: unixNano(chatSpan1.start),
};
const N = numbers;

// ---------- 图元 ----------

/** span 树的布局：根在上，直接子 span 排一行，筛查调用挂在 guard input 下面。 */
const TREE_AT: Record<string, [number, number]> = {};
{
  const kids = tree[0].children;
  TREE_AT[root.spanId] = [0, -92];
  kids.forEach((kid, i) => {
    TREE_AT[kid.span.spanId] = [(i - (kids.length - 1) / 2) * 92, 0];
    kid.children.forEach((grand) => (TREE_AT[grand.span.spanId] = [TREE_AT[kid.span.spanId][0], 92]));
  });
}
const SHORT: Record<string, string> = { [root.spanId]: 'agent', [guardIn.spanId]: 'guard', [screenSpan.spanId]: 'haiku', [chatSpan1.spanId]: 'chat 1', [toolSpan.spanId]: 'tool', [chatSpan2.spanId]: 'chat 2', [guardOut.spanId]: 'output' };
const toneOf = (span: Span): Tone => (span === root ? 'slate' : span.kind === 'CLIENT' ? 'green' : span === toolSpan ? 'blue' : 'teal');

/** 画出前 k 个 span（按开始顺序）；done 里的已经结束，写上时长。 */
function spanGraph(k: number, done: readonly Span[], lift: readonly Span[] = []): GraphPrim {
  const shown = spans.slice(0, k);
  return {
    kind: 'graph',
    id: 'g',
    r: 24,
    nodes: shown.map((span) => ({ id: span.spanId, x: TREE_AT[span.spanId][0], y: TREE_AT[span.spanId][1], v: SHORT[span.spanId], sub: done.includes(span) ? `${num(duration(span))} ms` : '进行中', tone: done.includes(span) ? toneOf(span) : 'dim', lift: lift.includes(span) || undefined })),
    edges: shown.filter((span) => span.parentSpanId).map((span) => ({ a: span.parentSpanId!, b: span.spanId, arrow: true })),
  };
}

const TP_PARTS = [['00', 'version', 'slate'], [traceId.slice(0, 4), 'trace-id', 'blue'], [chatSpan1.spanId.slice(0, 4), 'parent-id', 'green'], [N.flags, 'flags', 'amber']] as const;
const traceparentRow = (lift = false): RowPrim => ({
  kind: 'row',
  id: 'tp',
  w: 60,
  cells: TP_PARTS.map(([v, sub, tone], i): DsCell => ({ v: i === 1 || i === 2 ? `${v}…` : v, sub, tone, key: `tp${i}`, lift: (lift && i === 2) || undefined })),
});
const otlpRow: RowPrim = {
  kind: 'row',
  id: 'tp',
  w: 60,
  cells: [
    { v: String(N.resourceBytes), sub: 'resource', tone: 'slate', key: 'tp0' },
    { v: String(N.scopeBytes), sub: 'scope', tone: 'slate', key: 'tp1' },
    { v: num(N.spansBytes), sub: `${N.spanCount} spans`, tone: 'blue', key: 'tp2', lift: true },
    { v: num(N.otlpBytes), sub: '合计', tone: 'teal', key: 'tp3' },
  ],
};

/** 两个 chat span 的 GenAI 属性并排成一张表：行是属性名的最后一段，列是 chat 1、chat 2；还没看到的列留空，lift 的行抬起。 */
const ATTR_ROWS: Array<[string, string]> = [[GENAI.inputTokens, 'input'], [GENAI.outputTokens, 'output'], [GENAI.finishReasons, 'finish'], [GENAI.ttfc, 'ttfc s']];
function attrGrid(upto: number, lift: string[] = []): GridPrim {
  const cols = [chatSpan1, chatSpan2];
  return {
    kind: 'grid',
    id: 'a',
    w: 60,
    rows: ATTR_ROWS.map(([, name]) => name),
    cols: ['chat 1', 'chat 2'],
    cells: ATTR_ROWS.map(([key, name], r) => cols.map((span, c): DsCell => {
      if (c >= upto) return { v: '', tone: 'empty' };
      const v = attrOf(span, key)!;
      return { v: Array.isArray(v) ? String(v[0]) : String(v), tone: r < 2 ? 'blue' : 'green', lift: (c === upto - 1 && lift.includes(name)) || undefined };
    })),
  };
}

// ---------- 字节层 ----------

/** 一个 span 的 OTLP/JSON（只有这一个 span），用来看属性的写法。 */
const spanJson = (span: Span) => encodeJson(otlpTraces(RESOURCE, SCOPE, [span]).resourceSpans[0].scopeSpans[0].spans[0]);
const spanNotes = (span: Span): Record<string, string> => ({
  traceId: '16 字节的 trace id，写成 32 位小写十六进制（OTLP/JSON 不用 base64）。整个请求的 span 共用它。',
  spanId: '8 字节的 span id（示例）。',
  parentSpanId: span.parentSpanId ? `父 span 的 id：${SHORT[span.parentSpanId]}。树就靠它连起来。` : '',
  kind: `SpanKind 写整数：${span.kind} = ${SPAN_KIND_CODE[span.kind]}。`,
  startTimeUnixNano: 'Unix 纳秒，64 位整数写成十进制字符串（OTLP/JSON 的规定）。耗时是模拟的。',
  attributes: '属性按写入的顺序；整数是 intValue（字符串），小数是 doubleValue。',
});
function spanWire(span: Span, label: string, fidelity: 'format' = 'format') {
  const json = spanJson(span);
  const attrs = (json.spans.filter((s) => /^attributes\[\d+\]$/.test(s.path)) ?? []).map((s) => s.path);
  return wire(label, 'mem', fidelity, jsonBody(`span：${span.name}`, json, {
    expand: attrs,
    example: ['traceId', 'spanId', 'parentSpanId', 'startTimeUnixNano', 'endTimeUnixNano'],
    notes: spanNotes(span),
    summary: 'OTLP/JSON 里的一个 Span（trace.proto 的字段，lowerCamelCase）',
  }));
}

const messageWire = wire('用户的消息', 'mem', 'format', utf8Lines('用户的消息', NORMAL_ASK, { summary: `UTF-8 ${utf8Encode(NORMAL_ASK).length} 字节` }));
const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };

function callRequestWire(c: ModelCall, label: string, notes: Record<string, string>, http = c.http.request, headNotes: Record<string, string> = {}) {
  return wire(label, 'mem', 'format',
    httpHead('请求头', http, { mask: KEY_MASK, example: ['x-api-key', 'traceparent'], notes: { 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_API_KEY.length} 个字符，这里打码）。`, ...headNotes } }),
    jsonBody('请求体', encodeJson(c.request), { example: ['metadata'], notes }));
}
function messageJsonWire(c: ModelCall, label: string, notes: Record<string, string>, streamed: boolean) {
  const blocks = c.message.content.map((_, i) => `content[${i}]`);
  return wire(label, 'mem', 'format', ...(streamed ? [] : [httpHead('响应头', c.http.response, { example: ['request-id', 'date'] })]), jsonBody(streamed ? '响应（流式事件累积成的 Message）' : '响应体', encodeJson(c.message), {
    expand: [...blocks, 'usage.input_tokens', 'usage.output_tokens'],
    example: ['id', 'content', ...blocks, 'usage', 'usage.input_tokens', 'usage.output_tokens'],
    summary: streamed ? '流式时这些字段分散在 message_start、content_block_delta、message_delta 事件里，累积后就是这个对象' : 'UTF-8 编码的 JSON',
    notes: { 'usage.input_tokens': '本站分词器的计数（示例）。', ...notes },
  }));
}

const tpWire = wire('traceparent 头', 'mem', 'format',
  traceparentField('traceparent', traceparent, {
    version: '版本 00。ff 无效。',
    'trace-id': '和这个请求里所有 span 相同的 trace id（示例）。',
    'parent-id': `调用方当前 span 的 id：chat 1 这个 CLIENT span（${chatSpan1.spanId}）。对方的 span 会挂在它下面。`,
    'trace-flags': `${N.flags}：最低位 sampled 置位，表示调用方记录了这个 trace。`,
  }),
  concept('解析（本站的 parseTraceparent）', [['长度', `${N.traceparentChars} 个字符`, '版本 00 必须正好这么长。'], ['sampled', String(N.sampled), 'Claude API 的 OpenTelemetry 导出（beta）读这个头；sampled 关着时不产生 span。'], ['random', String(parsed.ok && parsed.random), 'Level 2 的 random-trace-id 位，这里没有置位。']], 'teal'));

const otlpWire = wire('导出到 Collector', 'mem', 'format',
  httpHead('请求头', otlpHttp, { notes: { host: `Collector 的地址（示例），OTLP/HTTP 默认端口 ${OTLP_HTTP_PORT}。`, 'content-type': 'OTLP/HTTP 的 JSON 编码；另一种是 application/x-protobuf。' }, startNote: `traces 的默认路径是 ${OTLP_TRACES_PATH}。` }),
  jsonBody('ExportTraceServiceRequest', otlp, {
    root: SPANS_PATH,
    expand: [`${SPANS_PATH}[${spanIndex(chatSpan1)}].parentSpanId`, `${SPANS_PATH}[${spanIndex(chatSpan1)}].kind`, `${SPANS_PATH}[${spanIndex(chatSpan1)}].startTimeUnixNano`, `${SPANS_PATH}[${spanIndex(chatSpan1)}].attributes`],
    example: spans.map((_, i) => `${SPANS_PATH}[${i}]`),
    summary: `resourceSpans → scopeSpans → spans；这里列出 ${N.spanCount} 个 span，展开 chat 1`,
    notes: Object.fromEntries(spans.map((span, i) => [`${SPANS_PATH}[${i}]`, `${span.name}：${num(duration(span))} ms（模拟）。`])),
  }));

// ---------- 事件 ----------

const doneUpTo = (...list: Span[]) => list;
const cost0 = 0;
const cost1 = screen.cost.total;
const cost2 = cost1 + chat1.cost.total;
const cost3 = cost2 + chat2.cost.total;

const screenReqWire = callRequestWire(screen, '筛查请求（Claude Haiku 5.5）', { messages: '用户的问题包在 <content> 里，要模型只回答 JSON。' });
const screenResWire = messageJsonWire(screen, '筛查的响应', { content: '判断（示例）：不是注入。' }, false);

const req1Wire = callRequestWire(chat1, '第 1 轮请求（带 traceparent）', {
  stream: 'true：流式，用户先看到字；GenAI 约定的 time_to_first_chunk 就是给流式请求的。',
  tools: 'get_order 的定义（共享包里的 name、description、input_schema）。',
  metadata: '不透明的 user_id（HMAC，安全组讲过）。',
}, http1, { traceparent: `W3C Trace Context：00-<trace-id>-<parent-id>-<flags>，${N.traceparentChars} 个字符。` });
const res1Wire = messageJsonWire(chat1, '第 1 轮响应', { 'content[1]': `tool_use：要查 ${ORDER_ID}；它的 id 会写进 execute_tool span 的 gen_ai.tool.call.id。`, stop_reason: 'tool_use：等工具结果回来再接着写。' }, true);
const toolWire = wire('get_order 的结果', 'mem', 'format', jsonBody('tool_result 的内容', toolResult, { notes: { signed_at: '签收日期，第二轮的回答从它算出天数。' } }));
const req2Wire = callRequestWire(chat2, '第 2 轮请求', { messages: '三条：用户的问题、第 1 轮的回复（含 tool_use）、tool_result。' }, chat2.http.request);
const res2Wire = messageJsonWire(chat2, '第 2 轮响应', { content: '回答（示例）：日期和天数取自订单数据。' }, true);

export const trace: Lesson = {
  id: 'trace',
  name: 'TRACE',
  title: '一次请求的 trace',
  group: 'observe',
  layer: [1, 4],
  layerNote: '这课从「模型调用」到「追踪」：一次请求经过应用、防护层和模型，每一步记成一个 span，traceparent 把模型调用接进同一个 trace。',
  costNote: `这次请求调用了三次模型：Claude Haiku 5.5 筛查 ${N.screenCost}，Claude Opus 5.5 两轮 ${N.cost1} 和 ${N.cost2}，合计 ${N.totalCost}；记 span、导出 trace 不花模型的钱。`,
  nodes: ['app', 'backend', 'guard', 'llm', 'tools', 'collector', 'observe', 'spans', 'request', 'response'],
  place: { app: [90, 120], backend: [460, 120], llm: [900, 120], guard: [900, 400], tools: [1150, 420], collector: [900, 720], observe: [1180, 760], spans: [510, 540], request: [290, 330], response: [190, 830] },
  labels: {
    app: ['应用界面', '客服对话框'],
    backend: ['客服后端', '记 span、调用模型'],
    guard: ['防护层', '检测器 + Haiku 筛查'],
    llm: ['模型', MODEL],
    tools: ['工具执行端', 'get_order'],
    collector: ['OTel Collector', `OTLP/HTTP :${OTLP_HTTP_PORT}`],
    observe: ['可观测性后端', '存 trace、查询'],
    spans: ['span 树', '时长是模拟的'],
    request: ['发出去的字节', 'traceparent / OTLP'],
    response: ['chat span 的属性', 'GenAI 语义约定'],
  },
  labelAt: { spans: [0, 160], request: [-60, 110], response: [0, 150] },
  radius: { spans: 90, request: 60, response: 70 },
  initial: { spans: [], request: [], response: [] },
  start: ['app', 'backend', 'llm'],
  legend: [['blue', '用户的消息、工具'], ['green', '模型调用的 span'], ['teal', '防护层的 span、导出'], ['amber', 'sampled 标志'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '一个客服请求经过的每一步，怎样记成一棵 span 树并导出',
    description: `用户问「${NORMAL_ASK}」，客服后端要经过防护层筛查、两轮模型调用和一次查订单才答完。这一课把每一步记成一个 span：一共 ${N.spanCount} 个，共用一个 trace id，靠 parentSpanId 连成树。模型调用的 span 按 OpenTelemetry GenAI 语义约定写属性，发给 Messages API 的请求带上 W3C traceparent，最后整棵树编码成 OTLP/JSON 发给 Collector。token 和费用是真实计算的，耗时是固定种子的模拟。`,
    facts: [
      ['span', `${N.spanCount} 个，根是 invoke_agent`],
      ['traceparent', `${N.traceparentChars} 个字符`],
      ['导出', `OTLP/JSON ${num(N.otlpBytes)} 字节`],
      ['费用', `${N.totalCost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '一次请求，一个 trace',
      desc: `根 span 先开，trace id ${N.traceIdChars} 位十六进制`,
      detail: `trace 是一次请求经过的所有步骤，每一步是一个 span：有自己的 id、开始结束时间和属性，并记下父 span 是谁。后端收到问题先开根 span（invoke_agent ${AGENT}，GenAI 约定里 Agent 的 span 名），生成 ${N.traceIdChars} 位十六进制的 trace id，之后所有 span 都共用它。防护层先跑本站的检测器（规则命中 ${N.ruleHits} 条、p = ${N.detectorP}），再请 Claude Haiku 5.5 筛查一次，这次调用是 guard input 下面的子 span。`,
      facts: [['trace id', `${N.traceIdChars} 位十六进制（示例）`], ['检测器', `p = ${N.detectorP}`], ['筛查', `输入 ${N.screenInput}、输出 ${N.screenOutput} token`], ['费用', N.screenCost]],
      events: [
        type(NORMAL_ASK),
        pk('app', 'backend', 'blue', '用户的消息', [preview(NORMAL_ASK, 14)], [cost0, 'CALL', '问题交给客服后端', utf8Encode(NORMAL_ASK).length], messageWire, { ds: { spans: [spanGraph(1, [])] } }),
        state('backend', { trace: `${traceId.slice(0, 8)}…`, span: '1 个' }),
        show('guard', 'spans'),
        pk('backend', 'guard', 'teal', '开始筛查', ['guard input'], [cost0, 'SPAN', '开 guard input span，消息交给防护层', utf8Encode(NORMAL_ASK).length], messageWire, { ds: { spans: [spanGraph(2, [])] } }),
        pk('guard', 'llm', 'blue', 'POST /v1/messages', [SCREEN_MODEL, `${num(screen.http.request.bytes.length)} 字节`], [cost0, 'HTTP', `Haiku 筛查：开 ${screenSpan.name} span`, screen.http.request.bytes.length], screenReqWire, { ds: { spans: [spanGraph(3, [], [screenSpan])] } }),
        pk('llm', 'guard', 'green', '不是注入', [preview(SCREEN_OK, 14)], [cost1, 'INFER', `筛查回答：输入 ${N.screenInput}、输出 ${N.screenOutput} token，${N.screenCost}`, screen.http.response.bytes.length], screenResWire, { ds: { spans: [spanGraph(3, doneUpTo(screenSpan))] } }),
        pk('guard', 'backend', 'teal', '放行', [`${num(duration(guardIn))} ms`], [cost1, 'SPAN', `guard input 结束：${num(duration(guardIn))} ms`, spanJson(guardIn).bytes.length], spanWire(guardIn, 'guard input 的 span（本站命名）'), { ds: { spans: [spanGraph(3, doneUpTo(screenSpan, guardIn))] } }),
      ],
    },
    {
      title: 'traceparent：把 trace 带进模型调用',
      desc: `${N.traceparentChars} 个字符：版本、trace id、parent id、flags`,
      detail: `后端开 chat ${MODEL} 这个 CLIENT span，发请求时在头里加上 traceparent：00-trace id-parent id-flags，${N.traceparentChars} 个字符，是 W3C Trace Context 定的格式。parent id 写的是调用方当前 span 的 id，也就是 chat 1 自己，flags ${N.flags} 表示 sampled（调用方记录了这个 trace）。组织配置了 Claude API 的 OpenTelemetry 导出（beta）时，API 读这个头，把服务端的 span 挂在 chat 1 下面；sampled 关着时它不产生 span。`,
      facts: [['traceparent', `${N.traceparentChars} 个字符`], ['parent-id', 'chat 1 的 span id'], ['flags', `${N.flags}（sampled）`], ['请求', `${num(N.requestBytes)} 字节`]],
      events: [
        show('request'),
        pk('backend', 'llm', 'blue', 'POST /v1/messages', ['traceparent', `${num(N.requestBytes)} 字节`], [cost1, 'HTTP', `第 1 轮：开 chat 1 span，请求头带 traceparent`, N.requestBytes], req1Wire, { ds: { spans: [spanGraph(4, doneUpTo(screenSpan, guardIn), [chatSpan1])], request: [traceparentRow()] } }),
        pk('backend', 'llm', 'amber', 'traceparent', [`${traceparent.slice(0, 8)}…`, `${N.traceparentChars} 字符`], [cost1, 'HTTP', `traceparent：${traceparent}`, N.traceparentChars], tpWire, { ds: { request: [traceparentRow(true)] }, quick: true }),
        note('request', `parent-id = chat 1，flags ${N.flags}`, 'amber'),
        pk('llm', 'backend', 'green', 'tool_use', ['get_order', `${N.output1} token`], [cost2, 'INFER', `第 1 轮：stop_reason ${N.stop1}，输入 ${num(N.input1)}、输出 ${N.output1} token，${N.cost1}`, encodeJson(chat1.message).bytes.length], res1Wire, { ds: { spans: [spanGraph(4, doneUpTo(screenSpan, guardIn, chatSpan1))] } }),
      ],
    },
    {
      title: '工具也是一个 span',
      desc: `execute_tool get_order，然后第 2 轮写回答`,
      detail: `模型要查订单，后端开 execute_tool get_order 这个 span（kind INTERNAL），属性里的 gen_ai.tool.call.id 就是 tool_use 块的 id，日后能把这次工具执行和模型的那次请求对上。工具在共享包的订单数据上真实执行，查到 ${ORDER_ID} 是 ${order.signed_at} 签收的。结果回填后开第 2 个 chat span，模型写出回答，stop_reason 是 ${N.stop2}。`,
      facts: [['工具 span', 'execute_tool get_order'], ['call.id', 'tool_use 块的 id（示例）'], ['第 2 轮', `输入 ${num(N.input2)}、输出 ${N.output2} token`], ['费用', N.cost2]],
      events: [
        show('tools'),
        pk('backend', 'tools', 'blue', 'get_order', [`order_id: ${ORDER_ID}`], [cost2, 'TOOL', `开 execute_tool get_order span，查 ${ORDER_ID}`, encodeJson(toolUse.input).bytes.length], wire('工具调用', 'mem', 'format', jsonBody('tool_use 块', encodeJson(toolUse), { example: ['id'], notes: { id: '这次调用的 id（示例），也写进 gen_ai.tool.call.id。' } })), { ds: { spans: [spanGraph(5, doneUpTo(screenSpan, guardIn, chatSpan1), [toolSpan])] } }),
        pk('tools', 'backend', 'teal', '订单', [`签收 ${order.signed_at}`], [cost2, 'SPAN', `get_order 返回，execute_tool 结束：${num(N.toolMs)} ms`, N.toolResultBytes], toolWire, { ds: { spans: [spanGraph(5, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan))] } }),
        pk('backend', 'llm', 'blue', 'POST /v1/messages', ['3 条消息', `${num(chat2.http.request.bytes.length)} 字节`], [cost2, 'HTTP', '第 2 轮：开 chat 2 span，带上工具结果', chat2.http.request.bytes.length], req2Wire, { ds: { spans: [spanGraph(6, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan), [chatSpan2])] } }),
        pk('llm', 'backend', 'green', '回答', [preview(NORMAL_REPLY, 12), `${N.output2} token`], [cost3, 'INFER', `第 2 轮：stop_reason ${N.stop2}，输入 ${num(N.input2)}、输出 ${N.output2} token，${N.cost2}`, encodeJson(chat2.message).bytes.length], res2Wire, { ds: { spans: [spanGraph(6, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan, chatSpan2))] } }),
      ],
    },
    {
      title: 'GenAI 语义约定：span 上记什么',
      desc: `chat span 有 ${N.attrCount1} 个属性，provider 必须是 anthropic`,
      detail: `chat span 的属性按 OpenTelemetry GenAI 语义约定写（这套约定已搬到单独的 semantic-conventions-genai 仓库，状态还是 Development）：operation 是 chat，provider 是 anthropic，还有模型名、response.id、finish_reasons、输入输出 token 和流式的 time_to_first_chunk。Anthropic 的 usage.input_tokens 不含缓存读写，约定要求把两者加回去再写进 gen_ai.usage.input_tokens；这次没有用缓存，所以两个数相同（${N.input1}、${N.input2}）。提示词和回答原文在约定里是 Opt-In，默认不进 span。`,
      facts: [['chat 1', `${N.input1} / ${N.output1} token，${N.stop1}`], ['chat 2', `${N.input2} / ${N.output2} token，${N.stop2}`], ['ttfc', `${N.ttft1} s、${N.ttft2} s（模拟）`], ['约定状态', 'Development']],
      events: [
        show('response'),
        pk('backend', 'spans', 'green', 'chat 1 的属性', [`${N.attrCount1} 个`], [cost3, 'SPAN', `chat 1：operation chat、provider anthropic、输入 ${N.input1}、输出 ${N.output1}`, spanJson(chatSpan1).bytes.length], spanWire(chatSpan1, 'chat 1 的 span'), { ds: { response: [attrGrid(1, ['finish'])], spans: [spanGraph(6, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan, chatSpan2), [chatSpan1])] } }),
        note('response', `finish_reasons = ["${N.stop1}"]`),
        pk('backend', 'spans', 'green', 'chat 2 的属性', [`输入 ${N.input2}`], [cost3, 'SPAN', `chat 2：输入 ${N.input2}、输出 ${N.output2}，time_to_first_chunk ${N.ttft2} s`, spanJson(chatSpan2).bytes.length], spanWire(chatSpan2, 'chat 2 的 span'), { ds: { response: [attrGrid(2, ['input', 'ttfc s'])], spans: [spanGraph(6, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan, chatSpan2), [chatSpan2])] } }),
        note('response', '没有缓存：input 就是 usage.input_tokens', 'green'),
      ],
    },
    {
      title: '查完输出，整棵树合上',
      desc: `根 span ${num(N.rootMs)} ms，自身只有 ${N.rootSelf} ms`,
      detail: `回答交给界面之前，防护层再查一遍有没有泄露系统提示（guard output），最长相同片段是「${N.overlap}」，通过。最后根 span 结束，${N.spanCount} 个 span 按 parentSpanId 连成一棵树：根 ${num(N.rootMs)} ms，去掉子 span 覆盖的时间，自身只剩 ${N.rootSelf} ms，时间几乎全在两轮模型调用上。这些耗时是本站按固定种子模拟的，下一课专门拆账。`,
      facts: [['span', `${N.spanCount} 个`], ['根', `${num(N.rootMs)} ms（模拟）`], ['chat 2', `${num(N.chat2Ms)} ms`], ['get_order', `${num(N.toolMs)} ms`]],
      events: [
        pk('backend', 'guard', 'teal', '检查输出', ['guard output'], [cost3, 'CHECK', '开 guard output span，查系统提示泄露', utf8Encode(NORMAL_REPLY).length], wire('回答', 'mem', 'format', utf8Lines('text', NORMAL_REPLY, { summary: '模型的回答（示例）' })), { ds: { spans: [spanGraph(7, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan, chatSpan2), [guardOut])] } }),
        pk('guard', 'backend', 'teal', '没有泄露', [`最长相同 ${[...N.overlap].length} 字`], [cost3, 'SPAN', `guard output 结束：最长相同片段「${N.overlap}」`, spanJson(guardOut).bytes.length], spanWire(guardOut, 'guard output 的 span（本站命名）'), { ds: { spans: [spanGraph(7, doneUpTo(screenSpan, guardIn, chatSpan1, toolSpan, chatSpan2, guardOut))] } }),
        pk('backend', 'app', 'green', '回答', [preview(NORMAL_REPLY, 14)], [cost3, 'SPAN', `回答交给界面，根 span 结束：${num(N.rootMs)} ms`, utf8Encode(NORMAL_REPLY).length], spanWire(root, '根 span'), { ds: { spans: [spanGraph(7, [...spans])] } }),
        render,
        state('backend', { trace: `${traceId.slice(0, 8)}…`, span: `${N.spanCount} 个`, 费用: N.totalCost }),
      ],
    },
    {
      title: '导出：OTLP/JSON 发给 Collector',
      desc: `POST ${OTLP_TRACES_PATH}，${num(N.otlpRequestBytes)} 字节`,
      detail: `整棵树编码成 OTLP/JSON：resourceSpans → scopeSpans → spans，字段名 lowerCamelCase，id 写十六进制，kind 写整数（CLIENT 是 ${SPAN_KIND_CODE.CLIENT}），纳秒时间戳和整数属性写成十进制字符串。后端用 POST ${OTLP_TRACES_PATH} 发给 Collector 的 ${OTLP_HTTP_PORT} 端口，请求一共 ${num(N.otlpRequestBytes)} 字节，其中 ${N.spanCount} 个 span 占 ${num(N.spansBytes)} 字节。Collector 做批处理、采样，再转发给存 trace 的后端，在那里能按 trace id 查出这棵树。`,
      facts: [['路径', `POST ${OTLP_TRACES_PATH}`], ['端口', `${OTLP_HTTP_PORT}（gRPC 是 4317）`], ['spans', `${num(N.spansBytes)} 字节`], ['请求', `${num(N.otlpRequestBytes)} 字节`]],
      events: [
        show('collector', 'observe'),
        pk('backend', 'collector', 'teal', `POST ${OTLP_TRACES_PATH}`, [`${N.spanCount} 个 span`, `${num(N.otlpRequestBytes)} 字节`], [cost3, 'EXPORT', `OTLP/JSON：${N.spanCount} 个 span，${num(N.otlpBytes)} 字节`, N.otlpRequestBytes], otlpWire, { ds: { request: [otlpRow] } }),
        pk('collector', 'observe', 'teal', '转发', [`trace ${traceId.slice(0, 8)}…`], [cost3, 'EXPORT', 'Collector 批处理后转发给后端', null], wire('Collector 转发', 'mem', '示意', concept('Collector 做什么（示意）', [['接收', `OTLP/HTTP :${OTLP_HTTP_PORT}`, '也可以收 gRPC（4317）。'], ['处理', '批处理、采样', '尾部采样要看过整个 trace 才决定，第 ⑬ 课讲。'], ['转发', '存 trace 的后端', '本站不指定产品。']]))),
        note('observe', `按 trace id 查出 ${N.spanCount} 个 span`, 'green'),
      ],
    },
  ],
  outro: {
    title: '一次请求，一棵树',
    desc: `${N.spanCount} 个 span，三次模型调用，${N.totalCost}`,
    text: `trace 把一次请求拆成看得见的步骤：每个 span 记下谁调用了谁、花了多久、用了多少 token，模型调用的属性照 GenAI 语义约定写，后端不用猜字段名。traceparent 是跨进程的那根线：只要请求头里带着它，模型服务那一侧的 span 也能接进同一棵树。注意这套约定还是 Development，属性名可能再变（推理耗时的指标就改过名字）。下一课用这棵树拆账：哪个 span 最贵、哪个最慢、分位数怎么算。`,
    facts: [['span', `${N.spanCount} 个`], ['traceparent', `${N.traceparentChars} 个字符`], ['OTLP/JSON', `${num(N.otlpBytes)} 字节`], ['下一课', '成本与延迟拆账']],
  },
};
