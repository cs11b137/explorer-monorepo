/**
 * JSON-RPC 2.0 消息（MCP 的基础协议）。字段和错误码按 MCP 规范 2026-07-28 的 schema.ts 核对：
 *   - 请求 { jsonrpc: "2.0", id, method, params? }：id 是字符串或整数，不能是 null；
 *   - 结果 { jsonrpc, id, result }：MCP 要求 result 里有 resultType（"complete" 或 "input_required"）；
 *   - 错误 { jsonrpc, id?, error: { code, message, data? } }：读不出 id 时可以不写 id；
 *   - 通知 { jsonrpc, method, params? }：没有 id，收到的一方不回复。
 * 错误码：JSON-RPC 的 -32700、-32600 ~ -32603，加上 MCP 自己定义的 -32020 ~ -32022。
 */

export const JSONRPC_VERSION = '2.0';

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResult {
  jsonrpc: '2.0';
  id: RequestId;
  result: Record<string, unknown> & { resultType: string };
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id?: RequestId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcResult | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 错误码（schema.ts 的常量名）。 */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

/** 错误码的名字（展示用）。 */
export const RPC_NAME: Record<number, string> = {
  [RPC.PARSE_ERROR]: 'Parse error',
  [RPC.INVALID_REQUEST]: 'Invalid Request',
  [RPC.METHOD_NOT_FOUND]: 'Method not found',
  [RPC.INVALID_PARAMS]: 'Invalid params',
  [RPC.INTERNAL_ERROR]: 'Internal error',
  [RPC.HEADER_MISMATCH]: 'HeaderMismatch',
  [RPC.MISSING_REQUIRED_CLIENT_CAPABILITY]: 'MissingRequiredClientCapability',
  [RPC.UNSUPPORTED_PROTOCOL_VERSION]: 'UnsupportedProtocolVersion',
};

export const rpcRequest = (id: RequestId, method: string, params?: Record<string, unknown>): JsonRpcRequest => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
export const rpcNotification = (method: string, params?: Record<string, unknown>): JsonRpcNotification => ({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
export const rpcResult = (id: RequestId, result: JsonRpcResult['result']): JsonRpcResult => ({ jsonrpc: '2.0', id, result });
export const rpcError = (id: RequestId | undefined, code: number, message: string, data?: unknown): JsonRpcError => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });

export type MessageKind = 'request' | 'notification' | 'result' | 'error';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is RequestId => typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));

/** 判断一个值是哪种 JSON-RPC 消息；不是合法消息时返回 null。 */
export function kindOf(value: unknown): MessageKind | null {
  if (!isObject(value) || value.jsonrpc !== '2.0') return null;
  if ('method' in value) {
    if (typeof value.method !== 'string') return null;
    if ('params' in value && !isObject(value.params)) return null;
    if (!('id' in value)) return 'notification';
    return isId(value.id) ? 'request' : null;
  }
  if ('result' in value) return isId(value.id) && isObject(value.result) ? 'result' : null;
  if ('error' in value) return isObject(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string' ? 'error' : null;
  return null;
}

/**
 * 解析一条消息的文字。JSON 解析失败是 -32700，结构不对是 -32600；两种情况都读不出可信的 id，错误响应不带 id。
 */
export function parseRpc(text: string): { ok: true; message: JsonRpcMessage; kind: MessageKind } | { ok: false; error: JsonRpcError } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: rpcError(undefined, RPC.PARSE_ERROR, 'Parse error') };
  }
  const kind = kindOf(value);
  if (!kind) return { ok: false, error: rpcError(isObject(value) && isId(value.id) ? value.id : undefined, RPC.INVALID_REQUEST, 'Invalid Request') };
  return { ok: true, message: value as JsonRpcMessage, kind };
}

export const isRequest = (message: JsonRpcMessage): message is JsonRpcRequest => 'method' in message && 'id' in message;
export const isNotification = (message: JsonRpcMessage): message is JsonRpcNotification => 'method' in message && !('id' in message);
export const isError = (message: JsonRpcMessage): message is JsonRpcError => 'error' in message;
export const isResult = (message: JsonRpcMessage): message is JsonRpcResult => 'result' in message;
