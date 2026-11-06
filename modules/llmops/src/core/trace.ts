/**
 * 追踪：trace / span id、W3C traceparent 头、span 树、OpenTelemetry GenAI 语义约定的属性、OTLP/JSON 导出、按 trace id 的概率采样。
 *
 * 核对过的格式（出处见 README 事实表）：
 * - W3C Trace Context（2021-11-23 的 Recommendation）：`traceparent: 00-<32 位小写十六进制 trace-id>-<16 位 parent-id>-<2 位 flags>`，
 *   共 55 个字符；全 0 的 trace-id、parent-id 无效；版本 ff 无效；flags 最低位是 sampled。Level 2（2024 年的候选推荐草案）
 *   加了第二位 random-trace-id：置位时 trace-id 至少右边 7 个字节必须随机；
 * - OpenTelemetry GenAI 语义约定（状态 Development，已移到 semantic-conventions-genai 仓库）：推理 span 名
 *   `{gen_ai.operation.name} {gen_ai.request.model}`，kind CLIENT；Anthropic 的 `gen_ai.provider.name` 必须是 "anthropic"，
 *   `gen_ai.usage.input_tokens` = Anthropic 的 input_tokens + cache_read + cache_write；工具 span 名 `execute_tool {gen_ai.tool.name}`，
 *   kind INTERNAL；Agent span 名 `invoke_agent {gen_ai.agent.name}`，kind INTERNAL（进程内的框架）；
 * - OTLP 1.11.1（trace 信号 Stable）：JSON 编码时字段名用 lowerCamelCase，traceId / spanId 写成十六进制字符串（不是 base64），
 *   枚举写整数，64 位整数（时间戳 fixed64、intValue）写成十进制字符串；OTLP/HTTP 默认路径 /v1/traces、端口 4318，
 *   Content-Type application/json；SpanKind 1 INTERNAL、2 SERVER、3 CLIENT，StatusCode 0 UNSET、1 OK、2 ERROR（trace.proto）；
 * - 概率采样（ProbabilitySampler，Development）：拒绝阈值 T = (1 − p) × 2^56，随机值 R 取 trace id 最右 7 个字节，R ≥ T 才采样；
 *   tracestate 里写 `ot=th:<T 的十六进制，去掉末尾的 0>`。
 *
 * id 是固定种子生成的示例值（界面标 E.G.）。时间用毫秒（相对这次请求开始），导出时加上 EXAMPLE_EPOCH 换成 Unix 纳秒。
 */
import { EXAMPLE_EPOCH } from '@explorer/llm-core/ids';
import { encodeJson, type JsonBytes } from '@explorer/llm-core/json';
import { makeRequest, type HttpRequest } from '@explorer/llm-core/http';
import { mulberry32 } from '@explorer/llm-core/prng';
import type { Usage } from '@explorer/llm-core/anthropic';

// ---------- id ----------

const hexOf = (bytes: readonly number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

function randomHex(bytes: number, seed: number): string {
  const rand = mulberry32(seed);
  for (;;) {
    const out = Array.from({ length: bytes }, () => Math.floor(rand() * 256));
    if (out.some((b) => b !== 0)) return hexOf(out);
  }
}

/** 16 字节 trace id（32 位小写十六进制，不会全 0）。 */
export const traceIdOf = (seed: number): string => randomHex(16, seed * 2654435761 + 1);
/** 8 字节 span id（16 位小写十六进制，不会全 0）。 */
export const spanIdOf = (seed: number): string => randomHex(8, seed * 40503 + 7);

// ---------- traceparent ----------

export const FLAG_SAMPLED = 0x01;
export const FLAG_RANDOM = 0x02;

export interface TraceContext {
  traceId: string;
  /** 调用方这一侧当前 span 的 id（头里叫 parent-id）。 */
  spanId: string;
  flags: number;
}

/** 写成 traceparent 头的值。 */
export const formatTraceparent = (ctx: TraceContext): string => `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags.toString(16).padStart(2, '0')}`;

/** traceparent 的 55 个字符怎么切：每段的 [from, to)。 */
export const TRACEPARENT_LAYOUT = [
  { name: 'version', from: 0, to: 2 },
  { name: '-', from: 2, to: 3 },
  { name: 'trace-id', from: 3, to: 35 },
  { name: '-', from: 35, to: 36 },
  { name: 'parent-id', from: 36, to: 52 },
  { name: '-', from: 52, to: 53 },
  { name: 'trace-flags', from: 53, to: 55 },
] as const;

export type ParsedTraceparent = { ok: true; ctx: TraceContext; sampled: boolean; random: boolean } | { ok: false; reason: string };

/** 按 Trace Context 的规则解析版本 00 的头：长度、分隔符、小写十六进制、版本不是 ff、id 不全 0。 */
export function parseTraceparent(value: string): ParsedTraceparent {
  const v = value.trim();
  if (v.length !== 55) return { ok: false, reason: `长度应为 55，实际 ${v.length}` };
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(v);
  if (!m) return { ok: false, reason: '格式不对：要用 - 分隔的小写十六进制' };
  if (m[1] === 'ff') return { ok: false, reason: '版本 ff 无效' };
  if (m[1] !== '00') return { ok: false, reason: `本站只解析版本 00，收到 ${m[1]}` };
  if (/^0+$/.test(m[2])) return { ok: false, reason: 'trace-id 全为 0，无效' };
  if (/^0+$/.test(m[3])) return { ok: false, reason: 'parent-id 全为 0，无效' };
  const flags = parseInt(m[4], 16);
  return { ok: true, ctx: { traceId: m[2], spanId: m[3], flags }, sampled: (flags & FLAG_SAMPLED) !== 0, random: (flags & FLAG_RANDOM) !== 0 };
}

// ---------- span ----------

export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
/** trace.proto 的 SpanKind 枚举值。 */
export const SPAN_KIND_CODE: Record<SpanKind, number> = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 };
export type StatusCode = 'UNSET' | 'OK' | 'ERROR';
export const STATUS_CODE: Record<StatusCode, number> = { UNSET: 0, OK: 1, ERROR: 2 };

export type AttrValue = string | number | boolean | string[];
/** 属性按插入顺序（导出的字节顺序就是这个顺序）。整数用 { int: n } 和浮点区分。 */
export type Attr = [key: string, value: AttrValue | { int: number }];

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  /** 相对请求开始的毫秒。 */
  start: number;
  end: number;
  attributes: Attr[];
  status: { code: StatusCode; message?: string };
}

export const int = (n: number): { int: number } => {
  if (!Number.isInteger(n)) throw new Error(`${n} 不是整数`);
  return { int: n };
};

/** 一个 trace 的记录器：span id 按开始顺序用 seed + 序号生成。 */
export class Tracer {
  readonly spans: Span[] = [];
  private serial = 0;
  constructor(readonly traceId: string, readonly seed: number) {}

  start(name: string, kind: SpanKind, parent: Span | string | null, start: number, attributes: Attr[] = []): Span {
    const span: Span = {
      traceId: this.traceId,
      spanId: spanIdOf(this.seed + ++this.serial),
      parentSpanId: parent === null ? null : typeof parent === 'string' ? parent : parent.spanId,
      name,
      kind,
      start,
      end: start,
      attributes: [...attributes],
      status: { code: 'UNSET' },
    };
    this.spans.push(span);
    return span;
  }

  end(span: Span, end: number, extra: Attr[] = [], status?: Span['status']): Span {
    if (end < span.start) throw new Error('结束时间早于开始时间');
    span.end = end;
    span.attributes.push(...extra);
    if (status) span.status = status;
    return span;
  }
}

export interface SpanNode {
  span: Span;
  depth: number;
  children: SpanNode[];
  /** 自身耗时：总时长减去子 span 覆盖的时间（子 span 之间重叠的部分只算一次）。 */
  self: number;
}

/** 按 parentSpanId 搭树，兄弟按开始时间排；父 span 不在这批里的当作根。 */
export function spanTree(spans: readonly Span[]): SpanNode[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const build = (span: Span, depth: number): SpanNode => {
    const children = spans.filter((s) => s.parentSpanId === span.spanId).sort((a, b) => a.start - b.start).map((s) => build(s, depth + 1));
    let covered = 0;
    let cursor = span.start;
    for (const child of children) {
      const from = Math.max(cursor, child.span.start);
      const to = Math.min(span.end, child.span.end);
      if (to > from) covered += to - from;
      cursor = Math.max(cursor, child.span.end);
    }
    return { span, depth, children, self: span.end - span.start - covered };
  };
  return spans.filter((s) => s.parentSpanId === null || !ids.has(s.parentSpanId)).sort((a, b) => a.start - b.start).map((s) => build(s, 0));
}

/** 树按深度优先展开成一列（画瀑布图用）。 */
export const flattenTree = (nodes: readonly SpanNode[]): SpanNode[] => nodes.flatMap((n) => [n, ...flattenTree(n.children)]);

// ---------- GenAI 语义约定 ----------

/** 属性名（OpenTelemetry GenAI 语义约定，Development）。 */
export const GENAI = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  maxTokens: 'gen_ai.request.max_tokens',
  responseId: 'gen_ai.response.id',
  responseModel: 'gen_ai.response.model',
  finishReasons: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  cacheWrite: 'gen_ai.usage.cache_write.input_tokens',
  ttfc: 'gen_ai.response.time_to_first_chunk',
  conversation: 'gen_ai.conversation.id',
  agentName: 'gen_ai.agent.name',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  toolType: 'gen_ai.tool.type',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  errorType: 'error.type',
} as const;

/** 推理 span 的名字：`{gen_ai.operation.name} {gen_ai.request.model}`。 */
export const chatSpanName = (model: string, operation = 'chat'): string => `${operation} ${model}`;

/** 发请求时就知道的属性（provider 应当在创建 span 时给出）。 */
export const chatRequestAttrs = (model: string, maxTokens: number, server = 'api.anthropic.com'): Attr[] => [
  [GENAI.operation, 'chat'],
  [GENAI.provider, 'anthropic'],
  [GENAI.requestModel, model],
  [GENAI.maxTokens, int(maxTokens)],
  [GENAI.serverAddress, server],
  [GENAI.serverPort, int(443)],
];

/**
 * 响应回来后补的属性。input_tokens 按约定把 Anthropic 分开报的缓存读写加回去；缓存读写只在非 0 时写。
 * finish_reasons 写 Anthropic 原样的 stop_reason（约定没有给 Anthropic 的映射表，本站不改写）。
 */
export function chatResponseAttrs(message: { id: string; model: string; stop_reason: string; usage: Pick<Usage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'> }, ttfcSeconds?: number): Attr[] {
  const u = message.usage;
  const attrs: Attr[] = [
    [GENAI.responseId, message.id],
    [GENAI.responseModel, message.model],
    [GENAI.finishReasons, [message.stop_reason]],
    [GENAI.inputTokens, int(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)],
    [GENAI.outputTokens, int(u.output_tokens)],
  ];
  if (u.cache_read_input_tokens) attrs.push([GENAI.cacheRead, int(u.cache_read_input_tokens)]);
  if (u.cache_creation_input_tokens) attrs.push([GENAI.cacheWrite, int(u.cache_creation_input_tokens)]);
  if (ttfcSeconds !== undefined) attrs.push([GENAI.ttfc, ttfcSeconds]);
  return attrs;
}

/** 工具 span 的名字和属性：`execute_tool {gen_ai.tool.name}`。 */
export const toolSpanName = (tool: string): string => `execute_tool ${tool}`;
export const toolAttrs = (tool: string, callId: string): Attr[] => [[GENAI.operation, 'execute_tool'], [GENAI.toolName, tool], [GENAI.toolCallId, callId], [GENAI.toolType, 'function']];

/** Agent span：`invoke_agent {gen_ai.agent.name}`。 */
export const agentSpanName = (agent: string): string => `invoke_agent ${agent}`;
export const agentAttrs = (agent: string, provider = 'anthropic'): Attr[] => [[GENAI.operation, 'invoke_agent'], [GENAI.provider, provider], [GENAI.agentName, agent]];

/** 属性的值（找不到返回 undefined；整数返回数字）。 */
export function attrOf(span: Span, key: string): AttrValue | undefined {
  const found = span.attributes.find(([k]) => k === key);
  if (!found) return undefined;
  const v = found[1];
  return typeof v === 'object' && !Array.isArray(v) ? v.int : v;
}

// ---------- OTLP/JSON ----------

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { arrayValue: { values: AnyValue[] } };

/** AnyValue：字符串、布尔、整数（int64 写成十进制字符串）、浮点、数组。 */
export function anyValue(value: AttrValue | { int: number }): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => anyValue(v)) } };
  if (typeof value === 'object') return { intValue: String(value.int) };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { doubleValue: value };
}

const keyValues = (attrs: readonly Attr[]) => attrs.map(([key, value]) => ({ key, value: anyValue(value) }));

/** 毫秒（相对请求开始）→ Unix 纳秒的十进制字符串。 */
export const unixNano = (ms: number, epochSeconds = EXAMPLE_EPOCH): string => (BigInt(epochSeconds) * 1_000_000_000n + BigInt(Math.round(ms * 1e6))).toString();

export interface Resource {
  attributes: Attr[];
}

export interface Scope {
  name: string;
  version?: string;
}

/** ExportTraceServiceRequest 的 JSON 形状：resourceSpans → scopeSpans → spans。字段顺序照 trace.proto 的字段号。 */
export function otlpTraces(resource: Resource, scope: Scope, spans: readonly Span[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues(resource.attributes) },
        scopeSpans: [
          {
            scope: { name: scope.name, ...(scope.version ? { version: scope.version } : {}) },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: SPAN_KIND_CODE[s.kind],
              startTimeUnixNano: unixNano(s.start),
              endTimeUnixNano: unixNano(s.end),
              attributes: keyValues(s.attributes),
              status: { ...(s.status.message ? { message: s.status.message } : {}), code: STATUS_CODE[s.status.code] },
            })),
          },
        ],
      },
    ],
  };
}

/** OTLP/JSON 的字节（紧凑 JSON，带每个值的字节区间）。 */
export const encodeOtlp = (body: ReturnType<typeof otlpTraces>): JsonBytes => encodeJson(body);

export const OTLP_HTTP_PORT = 4318;
export const OTLP_GRPC_PORT = 4317;
export const OTLP_TRACES_PATH = '/v1/traces';

/** 发到 Collector 的 OTLP/HTTP 请求：POST /v1/traces，Content-Type application/json。 */
export const otlpHttpRequest = (body: JsonBytes, host = `otel-collector.xiaopu.example:${OTLP_HTTP_PORT}`): HttpRequest =>
  makeRequest('POST', OTLP_TRACES_PATH, [['host', host], ['content-type', 'application/json']], body.bytes);

// ---------- 概率采样 ----------

const TWO_56 = 1n << 56n;

/** 拒绝阈值 T = (1 − p) × 2^56（p 是 0–1 的采样概率，按 p 的双精度值精确换算后向下取整）。 */
export function rejectionThreshold(p: number): bigint {
  if (!(p > 0 && p <= 1)) throw new Error('采样概率要在 (0, 1] 之间');
  // p 是有限的二进制小数：p = m / 2^k，(1 − p) × 2^56 = (2^k − m) × 2^56 / 2^k。
  let k = 0n;
  let m = p;
  while (!Number.isInteger(m)) {
    m *= 2;
    k++;
  }
  const scale = 1n << k;
  return ((scale - BigInt(m)) * TWO_56) / scale;
}

/** tracestate 里的 th 值：T 写成 14 位十六进制，四舍五入到 precision 位，去掉末尾的 0（T = 0 写成 0）。 */
export function thValue(threshold: bigint, precision = 4): string {
  if (threshold === 0n) return '0';
  const digits = threshold.toString(16).padStart(14, '0');
  if (precision >= 14) return digits.replace(/0+$/, '');
  let head = BigInt(`0x${digits.slice(0, precision)}`);
  if (parseInt(digits[precision], 16) >= 8) head += 1n;
  return head.toString(16).padStart(precision, '0').replace(/0+$/, '') || '0';
}

/** 随机值 R：trace id 最右 7 个字节（56 位）。 */
export const randomnessOf = (traceId: string): bigint => BigInt(`0x${traceId.slice(-14)}`);

/** 概率采样的决定：R ≥ T 才采样。 */
export function probabilitySample(traceId: string, p: number): { sampled: boolean; r: bigint; t: bigint; th: string } {
  const t = rejectionThreshold(p);
  const r = randomnessOf(traceId);
  return { sampled: r >= t, r, t, th: thValue(t) };
}
