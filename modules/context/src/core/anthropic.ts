/**
 * Anthropic Messages API（POST /v1/messages）的纯函数模拟：请求校验、响应构造、流式事件、错误响应。
 * 字段名和结构按官方文档（核对日期 2026-11-06，来源见 README 的「核对过的 API 事实」）：
 *   - 请求：model、max_tokens、messages 必填；system 是字符串或 text 块数组；content 是字符串或内容块数组；
 *     tools 的每一项是 name、description、input_schema；cache_control 是 { type: 'ephemeral', ttl?: '5m' | '1h' }。
 *   - 响应：id、type: 'message'、role: 'assistant'、content、model、stop_reason、stop_sequence、usage。
 *   - stop_reason：end_turn、max_tokens、stop_sequence、tool_use、pause_turn、refusal。
 *   - 流式：message_start → 每个内容块 content_block_start / content_block_delta… / content_block_stop
 *     → message_delta（usage 是累计值）→ message_stop，中间可以有任意个 ping；出错时是 error 事件。
 *   - 错误：{ type: 'error', error: { type, message }, request_id }，每个响应都有 request-id 头。
 *
 * 模型说出来的话（回复内容）本站无法真实生成，由课程作为示例传入；围绕它的一切——token 数、usage、截断、
 * 停止原因、字节——都由这里真实计算。token 数是本站迷你分词器的计数，真实模型不同，只代表量级关系。
 */
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Decode } from '@explorer/llm-core/utf8';
import { cacheBlocks, cacheUsage, PromptCache, type CacheOutcome, type Ttl } from './cache';
import { makeRequest, makeResponse, type Header, type HttpRequest, type HttpResponse } from './http';
import { encodeJson } from './json';
import { encodeEvent } from './sse';
import { renderRequest, type RenderedPrompt } from './template';
import { countTokens, encodeText, truncateTokens } from './tokens';

// ---------- 请求 ----------

export interface CacheControl {
  type: 'ephemeral';
  ttl?: Ttl;
}

export interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | TextBlockParam[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlockParam = TextBlockParam | ToolUseBlockParam | ToolResultBlockParam;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlockParam[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
  strict?: boolean;
}

export type ToolChoice = { type: 'auto' | 'none'; disable_parallel_tool_use?: boolean } | { type: 'any'; disable_parallel_tool_use?: boolean } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | TextBlockParam[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  /** 自动缓存：放在最后一个可缓存块上。 */
  cache_control?: CacheControl;
  /** 2026-10-21 版本起发送任何一个都会 400，这里只用来演示校验。 */
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

// ---------- 模型 ----------

export interface ModelSpec {
  id: string;
  name: string;
  /** 上下文窗口（token）。 */
  context: number;
  /** max_tokens 上限。 */
  maxOutput: number;
  /** 最小可缓存前缀（token）。 */
  cacheMin: number;
  /** 是否支持 assistant 预填充（最后一条消息是 assistant）。 */
  prefill: boolean;
  /** 是否支持强制工具调用（tool_choice 为 any 或 tool）。 */
  forcedToolChoice: boolean;
  /** 带 tools 时 API 自动加的工具使用系统提示的 token 数（tool_choice 为 auto 或 none 时）。 */
  toolSystemTokens: number;
}

/** 文档里的模型参数（2026-11-06）。 */
export const MODELS: Record<string, ModelSpec> = {
  'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 1_000_000, maxOutput: 128_000, cacheMin: 512, prefill: false, forcedToolChoice: false, toolSystemTokens: 286 },
  'claude-sonnet-5-5': { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 1_000_000, maxOutput: 128_000, cacheMin: 512, prefill: false, forcedToolChoice: false, toolSystemTokens: 286 },
  'claude-haiku-5-5': { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context: 1_000_000, maxOutput: 128_000, cacheMin: 512, prefill: false, forcedToolChoice: true, toolSystemTokens: 286 },
};

/** 本站展示用的 API 版本头。2026-10-21 是当前最新版本，2023-06-01 仍可用。 */
export const API_VERSION = '2026-10-21';
export const API_HOST = 'api.anthropic.com';
export const MESSAGES_PATH = '/v1/messages';

// ---------- 错误 ----------

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'billing_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'timeout_error'
  | 'overloaded_error';

/** 错误类型和 HTTP 状态码（errors 文档）。 */
export const ERROR_STATUS: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

export interface ApiError {
  status: number;
  type: ErrorType;
  message: string;
  /** message 是不是文档里逐字给出的。不是的话界面标 E.G.：真实措辞可能不同。 */
  documented: boolean;
}

export const apiError = (type: ErrorType, message: string, documented = false): ApiError => ({ status: ERROR_STATUS[type], type, message, documented });

/** 错误响应体。 */
export const errorBody = (error: ApiError, requestId: string) => ({ type: 'error' as const, error: { type: error.type, message: error.message }, request_id: requestId });

/** 流里的 error 事件（HTTP 已经是 200，错误只能放在事件里），没有 request_id。 */
export const errorEvent = (error: ApiError) => ({ type: 'error' as const, error: { type: error.type, message: error.message } });

/** 文档里逐字给出的几条错误信息。 */
export const DOCUMENTED_ERRORS = {
  prefill: 'This model does not support assistant message prefill. The conversation must end with a user message.',
  forcedToolChoice: 'tool_choice: type "tool" and "any" are not supported for this model.',
  overloaded: 'Overloaded',
} as const;

/** 请求里所有带 cache_control 的块，按渲染顺序：tools → system → messages。键是 template 的 source。 */
export function breakpointsOf(req: MessagesRequest, prompt?: RenderedPrompt): Map<string, Ttl> {
  const out = new Map<string, Ttl>();
  const ttl = (control?: CacheControl) => (control ? control.ttl ?? '5m' : undefined);
  req.tools?.forEach((tool) => {
    const value = ttl(tool.cache_control);
    if (value) out.set('tools', value);
  });
  if (Array.isArray(req.system)) req.system.forEach((block, i) => {
    const value = ttl(block.cache_control);
    if (value) out.set(`system[${i}]`, value);
  });
  req.messages.forEach((message, i) => {
    if (typeof message.content === 'string') return;
    message.content.forEach((block, j) => {
      const value = ttl(block.cache_control);
      if (value) out.set(`messages[${i}].content[${j}]`, value);
    });
  });
  if (req.cache_control) {
    const rendered = prompt ?? renderRequest(req);
    const last = [...rendered.pieces].reverse().find((piece) => piece.kind === 'content' && piece.source);
    if (last?.source && !out.has(last.source)) out.set(last.source, req.cache_control.ttl ?? '5m');
  }
  return out;
}

/**
 * 校验一个请求，第一个问题就返回。规则来自文档：
 * - model、max_tokens、messages 必填；模型不存在或不可用是 404 not_found_error，信息以「model: <id>」开头；
 * - max_tokens 超过模型上限是 400；messages 为空是 400；
 * - 不支持预填充的模型，最后一条是 assistant 时 400（文档给出的原文）；
 * - 不支持强制工具调用的模型，tool_choice 为 any / tool 时 400（文档给出的原文）；
 * - API 版本 2026-10-21 起，temperature、top_p、top_k 任何一个都 400；
 * - 最多 4 个缓存断点；tool_result 必须对应上一条 assistant 消息里的 tool_use。
 * 除标了 documented 的两条，错误信息的措辞是示例。
 */
export function validateRequest(req: Partial<MessagesRequest>, version = API_VERSION): ApiError | null {
  for (const field of ['model', 'max_tokens', 'messages'] as const) {
    if (req[field] === undefined) return apiError('invalid_request_error', `${field}: Field required`);
  }
  const model = MODELS[req.model!];
  if (!model) return apiError('not_found_error', `model: ${req.model}`);
  if (!Number.isInteger(req.max_tokens) || req.max_tokens! < 0) return apiError('invalid_request_error', 'max_tokens: Input should be a valid integer');
  if (req.max_tokens! > model.maxOutput) return apiError('invalid_request_error', `max_tokens: ${req.max_tokens} > ${model.maxOutput}, which is the maximum allowed number of output tokens for ${model.id}`);
  const messages = req.messages!;
  if (!messages.length) return apiError('invalid_request_error', 'messages: at least one message is required');
  if (version >= '2026-10-21') {
    for (const field of ['temperature', 'top_p', 'top_k'] as const) {
      if (req[field] !== undefined) return apiError('invalid_request_error', `${field}: Extra inputs are not permitted`);
    }
  }
  if (messages[messages.length - 1].role === 'assistant' && !model.prefill) return apiError('invalid_request_error', DOCUMENTED_ERRORS.prefill, true);
  if (req.tool_choice && (req.tool_choice.type === 'any' || req.tool_choice.type === 'tool') && !model.forcedToolChoice) return apiError('invalid_request_error', DOCUMENTED_ERRORS.forcedToolChoice, true);
  const full = req as MessagesRequest;
  const points = breakpointsOf(full);
  if (points.size > 4) return apiError('invalid_request_error', `A maximum of 4 blocks with cache_control may be provided. Found ${points.size}.`);
  // 1 小时的缓存项必须排在 5 分钟的前面。
  const ttls = [...points.values()];
  if (ttls.some((ttl, i) => ttl === '1h' && ttls.slice(0, i).includes('5m'))) return apiError('invalid_request_error', 'cache_control: a ttl="1h" cache entry must come before any ttl="5m" entries');
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (typeof content === 'string') continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const previous = messages[i - 1];
      const ok = previous?.role === 'assistant' && Array.isArray(previous.content) && previous.content.some((item) => item.type === 'tool_use' && item.id === block.tool_use_id);
      if (!ok) return apiError('invalid_request_error', `messages.${i}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${block.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`);
    }
  }
  return null;
}

// ---------- 输入 token 的构成 ----------

export interface InputBreakdown {
  /** 展开后的提示（ChatML，见 template.ts）。 */
  prompt: RenderedPrompt;
  /** 总输入 token：等于 prompt.tokens。 */
  total: number;
  system: number;
  tools: number;
  /** 每条消息内容的 token 数。 */
  messages: number[];
  /** 模板本身：特殊 token、角色名、换行、生成提示。 */
  template: number;
}

/** 输入 token 怎么来的：把请求按模板展开，真实编码，再按来源汇总。 */
export function inputBreakdown(req: MessagesRequest): InputBreakdown {
  const prompt = renderRequest(req);
  const sum = (test: (source: string) => boolean) => Object.entries(prompt.bySource).reduce((total, [source, n]) => total + (test(source) ? n : 0), 0);
  const messages = req.messages.map((_, i) => sum((source) => source.startsWith(`messages[${i}].`)));
  return {
    prompt,
    total: prompt.tokens,
    system: sum((source) => source.startsWith('system')),
    tools: sum((source) => source === 'tools'),
    messages,
    template: prompt.overhead,
  };
}

// ---------- 响应 ----------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal';

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  output_tokens: number;
  service_tier: 'standard';
}

export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: Usage;
}

/** 一个输出块的 token 数：文本按文本编码；工具调用按它在模板里的写法（<tool_call> 包起来的 JSON）编码。 */
export function outputTokensOf(block: ContentBlock): number {
  if (block.type === 'text') return countTokens(block.text);
  return countTokens(`<tool_call>\n${encodeJson({ name: block.name, arguments: block.input }).text}\n</tool_call>`);
}

export interface ReplyOptions {
  id: string;
  /** 缓存结果；不传就当作没有缓存。 */
  cache?: CacheOutcome;
}

/**
 * 用示例回复构造响应。真实计算的部分：
 * - 有 stop_sequences 时，文本在第一个停止序列处截断，stop_reason 是 stop_sequence，stop_sequence 是命中的那个；
 * - 输出超过 max_tokens 时按 token 截断，stop_reason 是 max_tokens，之后的块丢弃；
 * - 有 tool_use 块时 stop_reason 是 tool_use，否则是 end_turn；
 * - usage：输入 token 来自 inputBreakdown（有缓存结果时按它拆成读、写、未缓存三部分），输出 token 是各块的计数之和。
 */
export function createMessage(req: MessagesRequest, reply: readonly ContentBlock[], options: ReplyOptions): Message {
  const breakdown = inputBreakdown(req);
  const content: ContentBlock[] = [];
  let stop: StopReason = reply.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  let stopSequence: string | null = null;
  let budget = req.max_tokens;
  for (const block of reply) {
    if (block.type === 'text') {
      let text = block.text;
      const hit = (req.stop_sequences ?? []).map((seq) => ({ seq, at: text.indexOf(seq) })).filter((item) => item.at >= 0).sort((a, b) => a.at - b.at)[0];
      if (hit) text = text.slice(0, hit.at);
      const cut = truncateTokens(text, budget);
      content.push({ type: 'text', text: cut.text });
      budget -= cut.tokens;
      if (cut.truncated) {
        stop = 'max_tokens';
        break;
      }
      if (hit) {
        stop = 'stop_sequence';
        stopSequence = hit.seq;
        break;
      }
    } else {
      const tokens = outputTokensOf(block);
      if (tokens > budget) {
        stop = 'max_tokens';
        break;
      }
      content.push(block);
      budget -= tokens;
    }
  }
  const output = req.max_tokens - budget;
  const cached = options.cache ? cacheUsage(options.cache) : { input_tokens: breakdown.total, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  return {
    id: options.id,
    type: 'message',
    role: 'assistant',
    content,
    model: req.model,
    stop_reason: stop,
    stop_sequence: stopSequence,
    usage: { ...cached, output_tokens: output, service_tier: 'standard' },
  };
}

/** 用一个缓存跑这次请求：展开、切块、查命中、写入，返回缓存结果（传给 createMessage）。 */
export function runCache(cache: PromptCache, req: MessagesRequest, now: number): CacheOutcome {
  const prompt = renderRequest(req);
  return cache.process(cacheBlocks(prompt, breakpointsOf(req, prompt)), prompt.tokens, now);
}

/** 全部输入 token：文档给的公式 cache_read + cache_creation + input。 */
export const totalInput = (usage: Pick<Usage, 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>): number => usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;

// ---------- 流式 ----------

export type StreamEvent =
  | { type: 'message_start'; message: Omit<Message, 'content' | 'stop_reason' | 'stop_sequence'> & { content: []; stop_reason: null; stop_sequence: null } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: '' } | { type: 'tool_use'; id: string; name: string; input: Record<string, never> } }
  | { type: 'ping' }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: StopReason; stop_sequence: string | null }; usage: { output_tokens: number } }
  | { type: 'message_stop' }
  | ReturnType<typeof errorEvent>;

export interface StreamOptions {
  /** 每个 text_delta 带几个 token。默认 2。 */
  tokensPerDelta?: number;
  /** 每个 input_json_delta 带几个字符。默认 12。 */
  charsPerJsonDelta?: number;
  /** message_start 里 output_tokens 的初值，文档示例是 1。 */
  startOutputTokens?: number;
  /** 在第一个内容块开始之后插一个 ping（文档示例就是这样）。 */
  ping?: boolean;
}

/**
 * 把一条完整的消息拆成流式事件序列。text_delta 按 token 切（切口落在汉字中间时，按字节拼回去仍是完整文字：
 * delta 的 text 是 JSON 字符串，服务端只会发完整的字符，所以这里把不完整的字节留给下一个 delta）。
 */
export function streamEvents(message: Message, options: StreamOptions = {}): StreamEvent[] {
  const per = options.tokensPerDelta ?? 2;
  const chars = options.charsPerJsonDelta ?? 12;
  const events: StreamEvent[] = [];
  const { content: _content, stop_reason: _stop, stop_sequence: _seq, usage, ...head } = message;
  events.push({ type: 'message_start', message: { ...head, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: options.startOutputTokens ?? 1 } } });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (index === 0 && (options.ping ?? true)) events.push({ type: 'ping' });
      for (const piece of textPieces(block.text, per)) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      if (index === 0 && (options.ping ?? true)) events.push({ type: 'ping' });
      const json = JSON.stringify(block.input);
      // 文档示例：第一个 input_json_delta 的 partial_json 是空串。
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } });
      for (let i = 0; i < json.length; i += chars) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + chars) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: { output_tokens: message.usage.output_tokens } });
  events.push({ type: 'message_stop' });
  return events;
}

/** 文本按 token 分段：每段 per 个 token，不完整的 UTF-8 尾巴并进下一段。 */
export function textPieces(text: string, per: number): string[] {
  const ids = encodeText(text);
  const out: string[] = [];
  let pending: number[] = [];
  for (let i = 0; i < ids.length; i += per) {
    pending.push(...ids.slice(i, i + per));
    const decoded = decodeComplete(pending);
    if (decoded.text) out.push(decoded.text);
    pending = decoded.rest;
  }
  if (pending.length) throw new Error('文本末尾有不完整的 UTF-8 字节');
  return out;
}


/** 解码 token 序列中已经收齐的字符，返回剩下不完整的 token。 */
function decodeComplete(ids: number[]): { text: string; rest: number[] } {
  for (let cut = ids.length; cut >= 0; cut--) {
    const text = utf8Decode(TOKENIZER.bytesOfAll(ids.slice(0, cut)));
    if (!text.includes('�')) return { text, rest: ids.slice(cut) };
  }
  return { text: '', rest: ids };
}

/** 事件 → SSE 帧：event 行是事件类型，data 行是紧凑 JSON。 */
export const eventFrame = (event: StreamEvent) => ({ event: event.type, data: JSON.stringify(event) });

/** 整条流的文本。 */
export const encodeEvents = (events: readonly StreamEvent[]): string => events.map((event) => encodeEvent(eventFrame(event))).join('');

/**
 * 把事件流拼回完整的消息（SDK 的 finalMessage 做的事）：
 * text_delta 追加到文本，input_json_delta 拼成字符串、在 content_block_stop 时解析成对象，
 * message_delta 更新 stop_reason 和 usage（usage 是累计值，直接覆盖）。遇到不认识的事件类型跳过。
 */
export function accumulate(events: readonly StreamEvent[]): Message {
  let message: Message | null = null;
  const json = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'message_start') message = { ...event.message, content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { ...event.message.usage } };
    if (!message) continue;
    if (event.type === 'content_block_start') {
      message.content[event.index] = event.content_block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, input: {} };
      json.set(event.index, '');
    }
    if (event.type === 'content_block_delta') {
      const block = message.content[event.index];
      if (event.delta.type === 'text_delta' && block.type === 'text') block.text += event.delta.text;
      if (event.delta.type === 'input_json_delta') json.set(event.index, (json.get(event.index) ?? '') + event.delta.partial_json);
    }
    if (event.type === 'content_block_stop') {
      const block = message.content[event.index];
      if (block.type === 'tool_use') block.input = JSON.parse(json.get(event.index) || '{}');
    }
    if (event.type === 'message_delta') {
      message.stop_reason = event.delta.stop_reason;
      message.stop_sequence = event.delta.stop_sequence;
      message.usage.output_tokens = event.usage.output_tokens;
    }
  }
  if (!message) throw new Error('流里没有 message_start');
  return message;
}

// ---------- HTTP ----------

/** 请求头里 x-api-key 的示例值：前缀是真实的形状，其余每次都不同，界面打码。 */
export const EXAMPLE_API_KEY = `sk-ant-api03-${'x'.repeat(95)}`;

export interface RequestOptions {
  apiKey?: string;
  version?: string;
  /** 额外的头，比如 anthropic-beta。 */
  extra?: Header[];
}

/** SDK 发出的 HTTP 请求：host、content-type、anthropic-version、x-api-key，再由 makeRequest 补 content-length。头名小写（fetch 的写法）。 */
export function messagesHttpRequest(req: MessagesRequest, options: RequestOptions = {}): HttpRequest {
  return makeRequest('POST', MESSAGES_PATH, [
    ['host', API_HOST],
    ['content-type', 'application/json'],
    ['anthropic-version', options.version ?? API_VERSION],
    ['x-api-key', options.apiKey ?? EXAMPLE_API_KEY],
    ...(options.extra ?? []),
  ], encodeJson(req).bytes);
}

export interface ResponseOptions {
  requestId: string;
  /** date 头，IMF-fixdate。 */
  date?: string;
  extra?: Header[];
}

/** 非流式的 200 响应：content-type、request-id，消息体是 Message 的紧凑 JSON。 */
export function messagesHttpResponse(message: Message, options: ResponseOptions): HttpResponse {
  return makeResponse(200, [
    ...(options.date ? [['date', options.date] as Header] : []),
    ['content-type', 'application/json'],
    ['request-id', options.requestId],
    ...(options.extra ?? []),
  ], encodeJson(message).bytes);
}

/** 流式的 200 响应头：content-type 是 text/event-stream，消息体按 chunked 分块（见 http.ts 的 chunked）。 */
export function streamHttpHead(options: ResponseOptions): HttpResponse {
  return makeResponse(200, [
    ...(options.date ? [['date', options.date] as Header] : []),
    ['content-type', 'text/event-stream; charset=utf-8'],
    ['cache-control', 'no-cache'],
    ['request-id', options.requestId],
    ['transfer-encoding', 'chunked'],
    ...(options.extra ?? []),
  ]);
}

export interface ErrorResponseOptions {
  requestId: string;
  /** 429、529 时可以带 retry-after（秒）。文档：不是每个 429 都带，月度消费上限的 429 不带。 */
  retryAfter?: number;
  extra?: Header[];
}

/** 错误响应：状态码、content-type、request-id、可选的 retry-after，消息体是错误 JSON。 */
export function errorHttpResponse(error: ApiError, options: ErrorResponseOptions): HttpResponse {
  return makeResponse(error.status, [
    ['content-type', 'application/json'],
    ['request-id', options.requestId],
    ...(options.retryAfter !== undefined ? [['retry-after', String(options.retryAfter)] as Header] : []),
    ...(options.extra ?? []),
  ], encodeJson(errorBody(error, options.requestId)).bytes);
}

/** 会重试的错误：429、5xx（含 529）。SDK 默认重试 2 次，指数退避，有 retry-after 时照它等。 */
export const isRetryable = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;
