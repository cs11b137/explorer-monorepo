/**
 * Streamable HTTP 传输（2026-07-28 版）。服务器只有一个 MCP 端点，只接受 POST：
 *   - 每条 JSON-RPC 消息是一个单独的 POST；Accept 头必须同时列出 application/json 和 text/event-stream；
 *   - 请求头镜像请求体里的几个字段，方便网关不解析 JSON 就能路由：MCP-Protocol-Version（= _meta 里的协议版本）、
 *     Mcp-Method（= method）、Mcp-Name（tools/call、prompts/get 是 params.name，resources/read 是 params.uri）；
 *     值不是可见 ASCII 时写成 `=?base64?…?=`。头和体对不上、或者缺了必需的头，回 400 和 -32020 HeaderMismatch；
 *   - 响应是一个 JSON 对象（application/json），或这个请求自己的 SSE 流（text/event-stream：先是相关的通知，最后是响应）；
 *   - 通知的 POST 回 202、没有消息体；没实现的方法回 404 和 -32601；版本不支持、缺 _meta、缺客户端能力都回 400；
 *   - 没有会话（不再有 Mcp-Session-Id），没有 GET 端点（GET、DELETE 回 405），流不能续传（不再有 Last-Event-ID）。
 * 授权（auth.ts）：受保护的服务器对不带令牌的请求回 401 和 WWW-Authenticate: Bearer resource_metadata="…"。
 *
 * 头名按 fetch 的习惯写成小写（HTTP 头名不区分大小写，规范的例子写 MCP-Protocol-Version、Mcp-Method）。
 */
import { headerOf, makeRequest, makeResponse, type Header, type HttpRequest, type HttpResponse } from '@explorer/llm-core/http';
import { encodeStream, parseStream } from '@explorer/llm-core/sse';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import { wwwAuthenticate } from './auth';
import { isError, isNotification, isRequest, kindOf, rpcError, RPC, type JsonRpcError, type JsonRpcMessage, type JsonRpcNotification, type JsonRpcResponse } from './jsonrpc';
import { META } from './protocol';
import type { McpServer } from './server';

export const MCP_HOST = 'mcp.xiaopu.example';
export const MCP_PATH = '/mcp';
export const MCP_ENDPOINT = `https://${MCP_HOST}${MCP_PATH}`;
export const ACCEPT = 'application/json, text/event-stream';

const SENTINEL = /^=\?base64\?.*\?=$/;

/** 一个值能不能原样放进头里：可见 ASCII、空格、制表符，首尾没有空白，也不像 base64 的写法。 */
export const headerSafe = (value: string): boolean => /^[\x20-\x7e\t]*$/.test(value) && value === value.trim() && !SENTINEL.test(value);

/** Mcp-Name / Mcp-Param-* 的值：能原样放就原样，否则 UTF-8 的 base64 包成 =?base64?…?=。 */
export function encodeHeaderValue(value: string): string {
  if (headerSafe(value)) return value;
  return `=?base64?${btoa(String.fromCharCode(...utf8Encode(value)))}?=`;
}

export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  return utf8Decode([...atob(match[1])].map((char) => char.charCodeAt(0)));
}

/** 这个方法的 Mcp-Name 取自哪个字段。 */
export function nameSource(method: string): 'name' | 'uri' | null {
  if (method === 'tools/call' || method === 'prompts/get') return 'name';
  if (method === 'resources/read') return 'uri';
  return null;
}

const metaOf = (message: JsonRpcMessage): Record<string, unknown> | undefined => {
  const params = 'params' in message ? message.params : undefined;
  const meta = params?._meta;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : undefined;
};

export interface PostOptions {
  host?: string;
  path?: string;
  /** Bearer 访问令牌。 */
  token?: string;
}

/** 客户端发出的 POST：host、content-type、accept、mcp-protocol-version、mcp-method、mcp-name、authorization，再补 content-length。 */
export function mcpPost(message: JsonRpcMessage, options: PostOptions = {}): HttpRequest {
  const headers: Header[] = [
    ['host', options.host ?? MCP_HOST],
    ['content-type', 'application/json'],
    ['accept', ACCEPT],
  ];
  const version = metaOf(message)?.[META.protocolVersion];
  if (typeof version === 'string') headers.push(['mcp-protocol-version', version]);
  if ('method' in message) {
    headers.push(['mcp-method', message.method]);
    const source = nameSource(message.method);
    const value = source ? message.params?.[source] : undefined;
    if (typeof value === 'string') headers.push(['mcp-name', encodeHeaderValue(value)]);
  }
  if (options.token) headers.push(['authorization', `Bearer ${options.token}`]);
  return makeRequest('POST', options.path ?? MCP_PATH, headers, JSON.stringify(message));
}

/**
 * 服务器检查请求头和请求体是否一致（规范的 Server Validation 一节）。返回 null 表示通过。
 * 只查规范要求的三个头：MCP-Protocol-Version、Mcp-Method、Mcp-Name（解码后再比）。
 */
export function checkHeaders(req: HttpRequest, message: JsonRpcMessage): string | null {
  const header = (name: string) => headerOf(req.headers, name);
  const version = header('mcp-protocol-version');
  if (version === undefined) return 'Header mismatch: MCP-Protocol-Version header is missing';
  const bodyVersion = metaOf(message)?.[META.protocolVersion];
  if (bodyVersion !== undefined && bodyVersion !== version) return `Header mismatch: MCP-Protocol-Version header value '${version}' does not match body value '${String(bodyVersion)}'`;
  if (!('method' in message)) return null;
  const method = header('mcp-method');
  if (method === undefined) return 'Header mismatch: Mcp-Method header is missing';
  if (method !== message.method) return `Header mismatch: Mcp-Method header value '${method}' does not match body value '${message.method}'`;
  const source = nameSource(message.method);
  if (!source) return null;
  const raw = header('mcp-name');
  if (raw === undefined) return 'Header mismatch: Mcp-Name header is missing';
  if (!/^[\x20-\x7e\t]*$/.test(raw)) return 'Header mismatch: Mcp-Name header contains invalid characters';
  const body = message.params?.[source];
  if (decodeHeaderValue(raw) !== body) return `Header mismatch: Mcp-Name header value '${raw}' does not match body value '${String(body)}'`;
  return null;
}

/**
 * JSON-RPC 错误对应的 HTTP 状态码：规范写明的是缺 _meta（-32602）、版本不支持（-32022）、缺客户端能力（-32021）、
 * 头不一致（-32020）回 400，没实现的方法（-32601）回 404。别的错误（找不到工具、找不到资源）规范没规定，本站回 200。
 */
export function statusOf(error: JsonRpcError): number {
  const { code, data } = error.error;
  if (code === RPC.METHOD_NOT_FOUND) return 404;
  if (code === RPC.HEADER_MISMATCH || code === RPC.UNSUPPORTED_PROTOCOL_VERSION || code === RPC.MISSING_REQUIRED_CLIENT_CAPABILITY || code === RPC.PARSE_ERROR || code === RPC.INVALID_REQUEST) return 400;
  if (code === RPC.INVALID_PARAMS && typeof data === 'object' && data !== null && 'missing' in data) return 400;
  return 200;
}

export interface ServeOptions {
  /** 受保护的服务器：只认这个 Bearer 令牌；不带或不对时回 401。 */
  token?: string;
  /** 401 里 WWW-Authenticate 的 resource_metadata 和 scope。 */
  resourceMetadata?: string;
  scope?: string;
  /** 用 SSE 回复（否则一个 JSON 对象）。 */
  sse?: boolean;
  /** SSE 回复里排在最终响应前面的通知（如 notifications/progress）。 */
  notifications?: JsonRpcNotification[];
}

const jsonResponse = (status: number, body: unknown, extra: Header[] = []): HttpResponse => makeResponse(status, [['content-type', 'application/json'], ...extra], JSON.stringify(body));

/** 服务器处理一个 HTTP 请求：方法、授权、解析、头校验、交给 McpServer，再按 JSON 或 SSE 写回。 */
export function serveHttp(server: McpServer, req: HttpRequest, options: ServeOptions = {}): HttpResponse {
  if (req.method !== 'POST') return makeResponse(405, [['allow', 'POST']]);
  if (options.token !== undefined) {
    const auth = headerOf(req.headers, 'authorization');
    if (auth !== `Bearer ${options.token}`) {
      const challenge = wwwAuthenticate({ resourceMetadata: options.resourceMetadata ?? '', scope: options.scope, error: auth ? 'invalid_token' : undefined });
      return makeResponse(401, [['www-authenticate', challenge]]);
    }
  }
  const text = utf8Decode(req.body);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return jsonResponse(400, rpcError(undefined, RPC.PARSE_ERROR, 'Parse error'));
  }
  if (!kindOf(value)) return jsonResponse(400, rpcError(undefined, RPC.INVALID_REQUEST, 'Invalid Request'));
  const message = value as JsonRpcMessage;
  if (isNotification(message)) {
    server.handle(message);
    return makeResponse(202, []);
  }
  if (!isRequest(message)) return jsonResponse(400, rpcError(undefined, RPC.INVALID_REQUEST, 'Clients must not send JSON-RPC responses'));
  const mismatch = checkHeaders(req, message);
  if (mismatch) return jsonResponse(400, rpcError(message.id, RPC.HEADER_MISMATCH, mismatch));
  const response = server.handle(message)!;
  const status = isError(response) ? statusOf(response) : 200;
  if (!options.sse || status !== 200) return jsonResponse(status, response);
  const frames = [...(options.notifications ?? []), response].map((item) => ({ data: JSON.stringify(item) }));
  return makeResponse(200, [['content-type', 'text/event-stream'], ['cache-control', 'no-cache'], ['x-accel-buffering', 'no']], encodeStream(frames).bytes);
}

/** 客户端读响应：202 没有消息；JSON 是一条；SSE 是每个事件的 data 一条（通知在前，响应在最后）。 */
export function readHttpResponse(res: HttpResponse): JsonRpcMessage[] {
  if (res.status === 202 || !res.body.length) return [];
  const type = headerOf(res.headers, 'content-type') ?? '';
  if (type.startsWith('text/event-stream')) return parseStream(res.body).map((event) => JSON.parse(event.data) as JsonRpcMessage);
  return [JSON.parse(utf8Decode(res.body)) as JsonRpcMessage];
}

export interface HttpExchange {
  request: HttpRequest;
  response: HttpResponse;
}

/** 走 HTTP 的传输：每条消息一个 POST，经 serveHttp 处理，记下每次的请求和响应。 */
export function httpTransport(server: McpServer, post: PostOptions = {}, serve: ServeOptions | ((message: JsonRpcMessage) => ServeOptions) = {}): { send: (message: JsonRpcMessage) => JsonRpcMessage[]; exchanges: HttpExchange[] } {
  const exchanges: HttpExchange[] = [];
  return {
    exchanges,
    send(message) {
      const request = mcpPost(message, post);
      const response = serveHttp(server, request, typeof serve === 'function' ? serve(message) : serve);
      exchanges.push({ request, response });
      return readHttpResponse(response);
    },
  };
}

export type { JsonRpcResponse };
