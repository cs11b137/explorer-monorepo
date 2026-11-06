/**
 * 同一个请求的另外两种写法：OpenAI Chat Completions、OpenAI Responses，以及 OpenAI 兼容接口（Ollama、OpenRouter）。
 * 字段名按官方文档（核对日期 2026-11-06，来源见 README）：
 *
 * Chat Completions（POST /v1/chat/completions）
 *   - 请求：model、messages 必填；system 是 messages 里 role: system 的一条；
 *     工具定义嵌在 function 里：{ type: 'function', function: { name, description, parameters } }；
 *     max_tokens 已弃用，改用 max_completion_tokens；流式用 stream 和 stream_options.include_usage。
 *   - 响应：id、object: 'chat.completion'、created、model、choices[{ index, message{ role, content, refusal, annotations }, logprobs, finish_reason }]、
 *     usage{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details{ cached_tokens }, completion_tokens_details{ reasoning_tokens } }、service_tier。
 *   - finish_reason：stop、length、tool_calls、content_filter（function_call 已弃用）。
 *   - 工具调用：message.tool_calls[{ id, type: 'function', function: { name, arguments(JSON 字符串) } }]；结果用 role: tool 的消息，带 tool_call_id。
 *   - 流式：只有 data 行，object 是 chat.completion.chunk，内容在 choices[].delta；include_usage 时 [DONE] 之前多一个 choices 为空、带 usage 的块；
 *     最后一行是 data: [DONE]。
 *
 * Responses（POST /v1/responses）
 *   - 请求：model、input（字符串或条目数组）、instructions（相当于 system）、max_output_tokens；工具是扁平的 { type: 'function', name, description, parameters }。
 *   - 响应：id（resp_…）、object: 'response'、created_at、status、model、output[…]、usage{ input_tokens, input_tokens_details{ cached_tokens }, output_tokens, output_tokens_details{ reasoning_tokens }, total_tokens }。
 *   - output 里的消息：{ type: 'message', id, status, role: 'assistant', content: [{ type: 'output_text', text, annotations }] }；
 *     工具调用是 { type: 'function_call', call_id, name, arguments }，结果作为输入条目 { type: 'function_call_output', call_id, output }。
 *   - 流式是带类型的事件：response.created、response.output_text.delta、response.completed 等。
 *
 * 只模拟本站课程用到的字段；真实响应还有更多字段（比如 Responses 对象会回显 instructions、tools）。
 */
import type { ContentBlock, MessagesRequest, ToolDefinition } from './anthropic';
import { makeRequest, makeResponse, type Header, type HttpRequest, type HttpResponse } from './http';
import { encodeJson } from './json';
import { encodeEvent } from './sse';

// ---------- Chat Completions ----------

export type ChatMessage =
  | { role: 'system' | 'developer'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens?: number;
  tools?: ChatTool[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

const textOf = (content: MessagesRequest['messages'][number]['content']): string =>
  typeof content === 'string' ? content : content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n');

const toolResultText = (content: string | Array<{ text: string }> | undefined): string => (typeof content === 'string' ? content : (content ?? []).map((item) => item.text).join('\n'));

/** Messages API 的工具定义 → Chat Completions 的写法（嵌在 function 里，input_schema 改名 parameters）。 */
export const chatTool = (tool: ToolDefinition): ChatTool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } });

/**
 * Messages API 请求 → Chat Completions 请求。
 * system 变成第一条 role: system 消息；assistant 的 tool_use 变成 tool_calls（arguments 是 JSON 字符串）；
 * user 里的 tool_result 变成 role: tool 的消息；max_tokens 写成 max_completion_tokens。
 */
export function toChatCompletions(req: MessagesRequest, model = req.model): ChatCompletionsRequest {
  const messages: ChatMessage[] = [];
  const system = typeof req.system === 'string' ? req.system : req.system?.map((block) => block.text).join('\n');
  if (system) messages.push({ role: 'system', content: system });
  for (const message of req.messages) {
    if (message.role === 'assistant') {
      const calls = typeof message.content === 'string' ? [] : message.content.flatMap((block) => (block.type === 'tool_use' ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) } }] : []));
      const text = textOf(message.content);
      messages.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    if (typeof message.content !== 'string') {
      for (const block of message.content) if (block.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
    }
    const text = textOf(message.content);
    if (text) messages.push({ role: 'user', content: text });
  }
  return {
    model,
    messages,
    max_completion_tokens: req.max_tokens,
    tools: req.tools?.map(chatTool),
    stream: req.stream,
    stream_options: req.stream ? { include_usage: true } : undefined,
  };
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string | null; refusal: null; annotations: []; tool_calls?: ChatToolCall[] }; logprobs: null; finish_reason: FinishReason }>;
  usage: ChatUsage;
  service_tier: 'default';
}

export const chatUsage = (prompt: number, completion: number, cached = 0): ChatUsage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached },
  completion_tokens_details: { reasoning_tokens: 0 },
});

/** Messages API 的 stop_reason → finish_reason。 */
export const finishReasonOf = (stop: string): FinishReason => (stop === 'max_tokens' ? 'length' : stop === 'tool_use' ? 'tool_calls' : stop === 'refusal' ? 'content_filter' : 'stop');

/** 用同一份回复内容构造 Chat Completions 的响应。 */
export function chatCompletion(model: string, content: readonly ContentBlock[], finish: FinishReason, usage: ChatUsage, options: { id: string; created: number }): ChatCompletion {
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const calls: ChatToolCall[] = content.flatMap((block) => (block.type === 'tool_use' ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) } }] : []));
  return {
    id: options.id,
    object: 'chat.completion',
    created: options.created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, refusal: null, annotations: [], ...(calls.length ? { tool_calls: calls } : {}) }, logprobs: null, finish_reason: finish }],
    usage,
    service_tier: 'default',
  };
}

/** Chat Completions 的流：只有 data 行；第一块带 role，中间每块一段 content，最后一块 finish_reason，include_usage 时再加一块 usage，然后 data: [DONE]。 */
export function chatStream(model: string, pieces: readonly string[], finish: FinishReason, usage: ChatUsage | null, options: { id: string; created: number }): string {
  const chunk = (delta: Record<string, unknown>, finishReason: FinishReason | null) => ({ id: options.id, object: 'chat.completion.chunk', created: options.created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }] });
  const frames = [chunk({ role: 'assistant', content: '' }, null), ...pieces.map((piece) => chunk({ content: piece }, null)), chunk({}, finish)];
  let text = frames.map((frame) => encodeEvent({ data: JSON.stringify(frame) })).join('');
  if (usage) text += encodeEvent({ data: JSON.stringify({ id: options.id, object: 'chat.completion.chunk', created: options.created, model, choices: [], usage }) });
  return `${text}${encodeEvent({ data: '[DONE]' })}`;
}

// ---------- Responses ----------

export type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: string | ResponsesInputItem[];
  max_output_tokens?: number;
  tools?: ResponsesTool[];
  stream?: boolean;
}

/** Messages API 请求 → Responses 请求：system 变成 instructions；只有一条用户文本时 input 写成字符串。 */
export function toResponses(req: MessagesRequest, model = req.model): ResponsesRequest {
  const items: ResponsesInputItem[] = [];
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      items.push({ role: message.role, content: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') items.push({ role: message.role, content: block.text });
      if (block.type === 'tool_use') items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      if (block.type === 'tool_result') items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolResultText(block.content) });
    }
  }
  const single = items.length === 1 && 'role' in items[0] && items[0].role === 'user' ? items[0].content : null;
  return {
    model,
    instructions: typeof req.system === 'string' ? req.system : req.system?.map((block) => block.text).join('\n'),
    input: single ?? items,
    max_output_tokens: req.max_tokens,
    tools: req.tools?.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema })),
    stream: req.stream,
  };
}

export type ResponseOutputItem =
  | { type: 'message'; id: string; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }> }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string; status: 'completed' };

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete';
  model: string;
  output: ResponseOutputItem[];
  usage: ResponsesUsage;
}

export const responsesUsage = (input: number, output: number, cached = 0): ResponsesUsage => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
});

/** 用同一份回复内容构造 Responses 的响应。max_tokens 截断时 status 是 incomplete。 */
export function responseObject(model: string, content: readonly ContentBlock[], usage: ResponsesUsage, options: { id: string; messageId: string; created: number; incomplete?: boolean }): ResponseObject {
  const output: ResponseOutputItem[] = [];
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  if (text) output.push({ type: 'message', id: options.messageId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const block of content) if (block.type === 'tool_use') output.push({ type: 'function_call', id: `fc_${block.id.slice(-24)}`, call_id: block.id, name: block.name, arguments: JSON.stringify(block.input), status: 'completed' });
  return { id: options.id, object: 'response', created_at: options.created, status: options.incomplete ? 'incomplete' : 'completed', model, output, usage };
}

// ---------- 服务商 ----------

export type Dialect = 'anthropic' | 'chat' | 'responses';

export interface Provider {
  id: 'anthropic' | 'openai' | 'ollama' | 'openrouter';
  name: string;
  host: string;
  /** 每种写法的路径。 */
  paths: Partial<Record<Dialect, string>>;
  /** 鉴权头的写法。 */
  auth: (key: string) => Header[];
  /** 模型 id 的写法示例。 */
  model: string;
  note: string;
}

/** 四家的地址和鉴权（2026-11-06 核对）。 */
export const PROVIDERS: Record<Provider['id'], Provider> = {
  anthropic: { id: 'anthropic', name: 'Anthropic', host: 'api.anthropic.com', paths: { anthropic: '/v1/messages' }, auth: (key) => [['x-api-key', key]], model: 'claude-opus-5-5', note: '另需 anthropic-version 头' },
  openai: { id: 'openai', name: 'OpenAI', host: 'api.openai.com', paths: { chat: '/v1/chat/completions', responses: '/v1/responses' }, auth: (key) => [['authorization', `Bearer ${key}`]], model: 'gpt-6-astra', note: 'Chat Completions 和 Responses 两种写法' },
  ollama: { id: 'ollama', name: 'Ollama', host: 'localhost:11434', paths: { chat: '/v1/chat/completions', responses: '/v1/responses' }, auth: (key) => [['authorization', `Bearer ${key}`]], model: 'qwen3', note: '本地服务要求带一个 key，但不检查它' },
  openrouter: { id: 'openrouter', name: 'OpenRouter', host: 'openrouter.ai', paths: { chat: '/api/v1/chat/completions', responses: '/api/v1/responses' }, auth: (key) => [['authorization', `Bearer ${key}`]], model: 'anthropic/claude-opus-5.5', note: '模型 id 带组织前缀；可选 HTTP-Referer、X-OpenRouter-Title 头' },
};

/** 某家、某种写法的 HTTP 请求。 */
export function providerRequest(provider: Provider, dialect: Dialect, body: unknown, key: string, extra: Header[] = []): HttpRequest {
  const path = provider.paths[dialect];
  if (!path) throw new Error(`${provider.name} 没有 ${dialect} 写法`);
  return makeRequest('POST', path, [['host', provider.host], ['content-type', 'application/json'], ...provider.auth(key), ...extra], encodeJson(body).bytes);
}

// ---------- Responses 的流式事件（dialects 课，2026-11-06 对照 OpenAI API 参考核对） ----------
//
// 文档（responses/methods/create 的 Streaming 示例、responses/streaming-events）给出的流：
//   - 每个事件两行：`event: <类型>` 和 `data: <JSON>`，空行结束；JSON 里的 `type` 和 event 行相同；
//   - 每个事件都有 `sequence_number`，文档的流示例从 0 开始，逐个加 1；
//   - 文字回复的顺序：response.created → response.in_progress → response.output_item.added（message，content 为空，status in_progress）
//     → response.content_part.added（part 是 output_text，text 为空）→ 若干 response.output_text.delta（item_id、output_index、content_index、delta、logprobs）
//     → response.output_text.done（完整 text）→ response.content_part.done → response.output_item.done（status completed）→ response.completed（完整 response，usage 此时才有）；
//   - 文档示例流到 response.completed 为止，没有 `data: [DONE]`（那是 Chat Completions 的结束方式）；
//   - 出错时是 type 为 error 的事件：{ type, code, message, param, sequence_number }。
// 只实现文字回复；真实的 response 对象还有 instructions、tools 等许多回显字段，这里和 ResponseObject 一样只带用到的。

export type ResponsesStreamEvent = { type: string; sequence_number: number } & Record<string, unknown>;

/** 把一个完整的 Responses 响应（只含一条 message）拆成流式事件。deltas 是按顺序的文字片段，拼起来必须等于回复文字。 */
export function responsesStreamEvents(response: ResponseObject, deltas: readonly string[]): ResponsesStreamEvent[] {
  const item = response.output[0];
  if (response.output.length !== 1 || item.type !== 'message') throw new Error('只支持一条 message 的文字回复');
  const text = item.content[0].text;
  if (deltas.join('') !== text) throw new Error('片段拼起来不等于回复文字');
  const events: Array<Record<string, unknown> & { type: string }> = [];
  const running = { ...response, status: 'in_progress' as const, output: [], usage: null };
  events.push({ type: 'response.created', response: running });
  events.push({ type: 'response.in_progress', response: running });
  events.push({ type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
  events.push({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
  for (const delta of deltas) events.push({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta, logprobs: [] });
  events.push({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] });
  events.push({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [], logprobs: [] } });
  events.push({ type: 'response.output_item.done', output_index: 0, item: { id: item.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] } });
  events.push({ type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response });
  return events.map((event, index) => ({ ...event, sequence_number: index }));
}

/** 事件 → SSE 帧：event 行是事件类型，data 是紧凑 JSON，type 在最前、sequence_number 在最后（文档示例的顺序）。 */
export function responsesFrame(event: ResponsesStreamEvent): { event: string; data: string } {
  const { type, sequence_number, ...rest } = event;
  return { event: type, data: JSON.stringify({ type, ...rest, sequence_number }) };
}

/** Responses 流的文本：每个事件 event 行 + data 行。 */
export const encodeResponsesStream = (events: readonly ResponsesStreamEvent[]): string => events.map((event) => encodeEvent(responsesFrame(event))).join('');

/** 客户端把 Responses 流拼回文字：认 response.output_text.delta，其余事件（包括不认识的）跳过。 */
export function responsesText(events: ReadonlyArray<{ type: string; delta?: unknown }>): string {
  return events.filter((event) => event.type === 'response.output_text.delta').map((event) => String(event.delta)).join('');
}

/** Responses 流里的错误事件。 */
export const responsesErrorEvent = (code: string | null, message: string, sequence: number, param: string | null = null): ResponsesStreamEvent => ({ type: 'error', code, message, param, sequence_number: sequence });

// ---------- OpenAI 的错误（dialects、retry 课） ----------
//
// 文档（guides/error-codes、guides/rate-limits）逐条给出：429 rate_limit_error，其中 code slow_down 表示请求速率涨得太快；
// 429 的 credit_balance_exhausted、organization_spend_limit_exceeded 等重试也没用；503 service_unavailable_error，code server_is_overloaded；
// 400 的 invalid_request_error 带 error.param。错误体里有 message、type、param、code 四个字段（文档分别提到），外层是 error 对象。
// 文档只逐字给出 service_tier 那一条的 message，其余措辞是示例（documented 为 false）。
// 响应头：x-request-id；限流时可有 Retry-After（秒）和 x-ratelimit-{limit,remaining,reset}-{requests,tokens}（reset 是 6m0s 这样的时长）。

export interface OpenAiError {
  status: number;
  type: string;
  code: string | null;
  param: string | null;
  message: string;
  documented: boolean;
}

export const openaiError = (status: number, type: string, code: string | null, message: string, param: string | null = null, documented = false): OpenAiError => ({ status, type, code, param, message, documented });

export const OPENAI_ERRORS = {
  /** 请求速率涨得太快，文档给了 type 和 code，措辞是示例。 */
  slowDown: openaiError(429, 'rate_limit_error', 'slow_down', 'Your request rate increased too quickly. Please slow down and retry.'),
  /** 模型暂时过载。 */
  overloaded: openaiError(503, 'service_unavailable_error', 'server_is_overloaded', 'The requested model is temporarily overloaded. Please retry your request.'),
  /** 预付额度用完：重试没用。 */
  noCredit: openaiError(429, 'insufficient_quota', 'credit_balance_exhausted', 'You have no prepaid credits remaining. Please add credits and try again.'),
  /** 文档逐字给出的一条。 */
  serviceTier: openaiError(400, 'invalid_request_error', null, 'Invalid `service_tier` argument: The requested service tier is not allowed for this project.', 'service_tier', true),
} as const;

export const openaiErrorBody = (error: OpenAiError) => ({ error: { message: error.message, type: error.type, param: error.param, code: error.code } });

/** OpenAI 的错误响应：content-type、x-request-id，可选 retry-after。 */
export function openaiErrorHttpResponse(error: OpenAiError, options: { requestId: string; retryAfter?: number }): HttpResponse {
  return makeResponse(error.status, [
    ['content-type', 'application/json'],
    ['x-request-id', options.requestId],
    ...(options.retryAfter !== undefined ? [['retry-after', String(options.retryAfter)] as Header] : []),
  ], encodeJson(openaiErrorBody(error)).bytes);
}

// ---------- OpenRouter 的错误 ----------
//
// 文档（api/reference/errors-and-debugging）：{ error: { code: number, message, metadata? } }，HTTP 状态码和 error.code 相同；
// 状态码 400、401、402、403、408、429、502、503；429、503 可带 Retry-After；
// 流开始之后（HTTP 已经 200）的错误：Chat Completions 是带顶层 error 的块，finish_reason 为 error；Responses 是 response.failed 事件。

export const openrouterErrorBody = (code: number, message: string, metadata?: Record<string, unknown>) => ({ error: { code, message, ...(metadata ? { metadata } : {}) } });
