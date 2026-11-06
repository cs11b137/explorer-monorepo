/**
 * 嵌入 API 的请求和响应（OpenAI embeddings 的写法，字段经核对，见 README 的「核对过的事实」）：
 *
 *   POST https://api.openai.com/v1/embeddings
 *   请求：input（字符串或字符串数组）、model、encoding_format（"float" 默认 | "base64"）、dimensions（text-embedding-3 及以后才支持）、user
 *   响应：{ object: "list", data: [{ object: "embedding", index, embedding }], model, usage: { prompt_tokens, total_tokens } }
 *
 * encoding_format 为 base64 时，embedding 是 float32 字节的 base64 字符串（官方 Python SDK 用 numpy.frombuffer(..., "float32") 解码，
 * 即本机字节序，x86 / ARM 上是小端）；不写 encoding_format 时，官方 SDK 自己在请求里带上 base64，收到后再解码成浮点数。
 *
 * 本站的说明：请求和响应的字段、字节都是真实格式；但 embedding 里的数是本站 16 维 LSA 模型算出来的（真实的 text-embedding-3-small
 * 默认 1536 维，用 dimensions 才能缩到 16 维，数值也完全不同），usage 的 token 数是本站 BPE 的计数，都标 E.G.。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import { encodeJson, type JsonBytes } from '@explorer/llm-core/json';
import { encodeRequest, encodeResponse, makeRequest, makeResponse, type HttpLayout } from '@explorer/llm-core/http';
import { countTokens } from './chunk';
import type { SearchResultBlock } from './rag';
import { base64Encode, f32Json, f32VectorBytes, type Vec } from './vector';

export const OPENAI_HOST = 'api.openai.com';
export const EMBEDDINGS_PATH = '/v1/embeddings';
/** 示例模型：默认 1536 维，支持 dimensions 参数。 */
export const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBED_DIMS: Record<string, number> = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072 };
/** 示例密钥：`sk-proj-` 加 48 个 x（长度是示例），展示时打码。 */
export const EXAMPLE_OPENAI_KEY = `sk-proj-${'x'.repeat(48)}`;

export interface EmbeddingsRequest {
  input: string | string[];
  model: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
}

export interface EmbeddingItem {
  object: 'embedding';
  index: number;
  /** float 时是数组，base64 时是 float32 小端字节的 base64。 */
  embedding: number[] | string;
}

export interface EmbeddingsResponse {
  object: 'list';
  data: EmbeddingItem[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/** 应用发出的 HTTP 请求：host、content-type、authorization（Bearer 密钥）、content-length。 */
export function embeddingsHttpRequest(body: EmbeddingsRequest, apiKey = EXAMPLE_OPENAI_KEY): { json: JsonBytes; layout: HttpLayout } {
  const json = encodeJson(body);
  const req = makeRequest('POST', EMBEDDINGS_PATH, [['host', OPENAI_HOST], ['content-type', 'application/json'], ['authorization', `Bearer ${apiKey}`]], json.bytes);
  return { json, layout: encodeRequest(req) };
}

/** 输入的 token 数（本站 BPE；真实服务按自己的分词器数）。 */
export const promptTokensOf = (input: string | readonly string[]): number => (typeof input === 'string' ? [input] : input).reduce((sum, text) => sum + countTokens(text), 0);

/** 用本站算出的向量拼一个响应。float 时每个数写成 fp32 的最短十进制写法，base64 时写 float32 小端字节的 base64。 */
export function embeddingsResponse(vectors: readonly Vec[], request: EmbeddingsRequest): EmbeddingsResponse {
  const format = request.encoding_format ?? 'float';
  const tokens = promptTokensOf(request.input);
  return {
    object: 'list',
    data: vectors.map((v, index) => ({ object: 'embedding', index, embedding: format === 'base64' ? base64Encode(f32VectorBytes(v)) : v.map(f32Json) })),
    model: request.model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

/** 示例 request id：`req_` 加 32 位十六进制（固定种子）。 */
export function exampleRequestId(seed: number): string {
  const rand = mulberry32(seed);
  return `req_${Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('')}`;
}

/** 200 响应：content-type、x-request-id、content-length。 */
export function embeddingsHttpResponse(response: EmbeddingsResponse, requestId: string): { json: JsonBytes; layout: HttpLayout } {
  const json = encodeJson(response);
  return { json, layout: encodeResponse(makeResponse(200, [['content-type', 'application/json'], ['x-request-id', requestId]], json.bytes)) };
}

// ---------- Claude Messages API（检索增强问答的生成一步） ----------

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const MESSAGES_PATH = '/v1/messages';
/** anthropic-version 头：最新的 2026-10-21（和 CONTEXT EXPLORER 一致，见 README 的「核对过的事实」）。 */
export const ANTHROPIC_VERSION = '2026-10-21';
export const CLAUDE_MODEL = 'claude-opus-5-5';
/** 示例密钥：`sk-ant-api03-` 加 95 个 x（和 CONTEXT EXPLORER 一致），展示时打码。 */
export const EXAMPLE_ANTHROPIC_KEY = `sk-ant-api03-${'x'.repeat(95)}`;

/** user 消息里的一个内容块：普通文字，或 search_result（字段见 rag.ts）。 */
export type UserBlock = { type: 'text'; text: string } | SearchResultBlock;

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string | UserBlock[] }>;
}

/** 应用发出的 Messages API 请求：host、content-type、anthropic-version、x-api-key、content-length（头名小写）。 */
export function messagesHttpRequest(body: MessagesRequest, apiKey = EXAMPLE_ANTHROPIC_KEY): { json: JsonBytes; layout: HttpLayout } {
  const json = encodeJson(body);
  const req = makeRequest('POST', MESSAGES_PATH, [['host', ANTHROPIC_HOST], ['content-type', 'application/json'], ['anthropic-version', ANTHROPIC_VERSION], ['x-api-key', apiKey]], json.bytes);
  return { json, layout: encodeRequest(req) };
}

/** 非流式响应体（Message 对象，字段顺序和文档一致）。回答是示例，usage 是本站 BPE 的计数，课程里标 E.G.。 */
export interface MessageBody {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

/** 用一段回答拼一个 Message：input_tokens 是提示的 token 数，output_tokens 是回答的 token 数（都是本站 BPE）。 */
export const messageBody = (answer: string, inputTokens: number, id: string): MessageBody => ({
  id,
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: answer }],
  model: CLAUDE_MODEL,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: inputTokens, output_tokens: countTokens(answer) },
});

/** 示例 message id：`msg_` 加 24 个字母数字（固定种子）。 */
export function exampleMessageId(seed: number): string {
  const rand = mulberry32(seed);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return `msg_${Array.from({ length: 24 }, () => chars[Math.floor(rand() * chars.length)]).join('')}`;
}

/** Messages 的 200 响应：content-type、request-id、content-length。 */
export function messagesHttpResponse(body: MessageBody, requestId: string): { json: JsonBytes; layout: HttpLayout } {
  const json = encodeJson(body);
  return { json, layout: encodeResponse(makeResponse(200, [['content-type', 'application/json'], ['request-id', requestId]], json.bytes)) };
}
