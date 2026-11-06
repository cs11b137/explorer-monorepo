/**
 * MCP 客户端（宿主应用里的连接器）：给每个请求编号、在 params._meta 里带上协议版本、clientInfo、客户端能力，
 * 经传输函数发出去，按 id 找回响应。传输可以是直接调用（directTransport）、stdio（stdio.ts）或 Streamable HTTP（http.ts）。
 *
 * 和 Agent 循环的桥（mcpToolBox）：tools/list 拿到的 Tool 写成 Messages API 的工具定义（inputSchema → input_schema），
 * 模型的 tool_use 变成 tools/call，CallToolResult 变回 tool_result（isError → is_error）。
 */
import type { ToolDefinition } from '@explorer/llm-core/anthropic';
import { ToolBox, type ToolOutcome, type ToolSpec } from '../tools';
import { isError, isResult, rpcNotification, rpcRequest, type JsonRpcError, type JsonRpcMessage, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse, type RequestId } from './jsonrpc';
import { PROTOCOL_VERSION, requestMeta, type CallToolResult, type ClientCapabilities, type Implementation, type McpTool } from './protocol';
import type { McpServer } from './server';

export type Transport = (message: JsonRpcMessage) => JsonRpcMessage[];

/** 直接调用服务器（同一进程里），没有传输层。 */
export const directTransport = (server: McpServer): Transport => (message) => {
  const response = server.handle(message);
  return response ? [response] : [];
};

export interface Exchange {
  request: JsonRpcRequest;
  /** 按 id 对上的响应。 */
  response: JsonRpcResponse;
  /** 同一次往返里收到的通知（如 notifications/progress）。 */
  notifications: JsonRpcNotification[];
}

export interface ClientOptions {
  info: Implementation;
  capabilities?: ClientCapabilities;
  version?: string;
  /** 第一个请求的 id，之后逐个加 1。 */
  firstId?: number;
}

export class McpClient {
  readonly transport: Transport;
  readonly options: ClientOptions;
  readonly exchanges: Exchange[] = [];
  private nextId: number;

  constructor(transport: Transport, options: ClientOptions) {
    this.transport = transport;
    this.options = options;
    this.nextId = options.firstId ?? 1;
  }

  /** 这个客户端此刻的 _meta（每个请求都带一份）。 */
  meta(): ReturnType<typeof requestMeta> {
    return requestMeta(this.options.info, this.options.capabilities ?? {}, this.options.version ?? PROTOCOL_VERSION);
  }

  /** 发一个请求：自动编号、补 _meta。找不到同 id 的响应时报错。 */
  request(method: string, params: Record<string, unknown> = {}, id: RequestId = this.nextId++): Exchange {
    const request = rpcRequest(id, method, { ...params, _meta: { ...this.meta(), ...((params._meta as object) ?? {}) } });
    const replies = this.transport(request);
    const response = replies.find((reply): reply is JsonRpcResponse => (isResult(reply) || isError(reply)) && reply.id === id);
    if (!response) throw new Error(`${method}（id ${id}）没有收到响应`);
    const notifications = replies.filter((reply): reply is JsonRpcNotification => 'method' in reply && !('id' in reply));
    const exchange = { request, response, notifications };
    this.exchanges.push(exchange);
    return exchange;
  }

  /** 发一个通知（不等回复）。 */
  notify(method: string, params?: Record<string, unknown>): JsonRpcNotification {
    const message = rpcNotification(method, params);
    this.transport(message);
    return message;
  }

  discover = () => this.request('server/discover');
  listTools = (cursor?: string) => this.request('tools/list', cursor ? { cursor } : {});
  callTool = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => this.request('tools/call', { name, arguments: args, ...extra });
  listResources = () => this.request('resources/list');
  readResource = (uri: string) => this.request('resources/read', { uri });
  listPrompts = () => this.request('prompts/list');
  getPrompt = (name: string, args: Record<string, string> = {}) => this.request('prompts/get', { name, arguments: args });
  /** 取消一个还在进行的请求（stdio 上用；Streamable HTTP 上是关掉那个响应流）。 */
  cancel = (requestId: RequestId, reason?: string) => this.notify('notifications/cancelled', { requestId, ...(reason ? { reason } : {}) });
}

/** 结果或错误：取结果对象，错误时抛出（课程里要展示错误时直接看 exchange.response）。 */
export function resultOf<T = Record<string, unknown>>(exchange: Exchange): T {
  if (isError(exchange.response)) throw new Error(`${exchange.request.method} 失败：${exchange.response.error.code} ${exchange.response.error.message}`);
  return exchange.response.result as unknown as T;
}

/** MCP 的 Tool → Messages API 的工具定义：name、description 照搬，inputSchema 改名 input_schema。title、annotations 不发给模型。 */
export const toAnthropicTool = (tool: McpTool): ToolDefinition => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), input_schema: tool.inputSchema });

/** tools/call 的响应 → 交给模型的 tool_result 内容：文本块的文字连起来；协议错误也作为 is_error 的结果交回（规范允许，但模型不一定能改正）。 */
export function toToolOutcome(response: JsonRpcResponse): ToolOutcome {
  if (isError(response)) {
    const error = (response as JsonRpcError).error;
    return { content: `MCP 错误 ${error.code}：${error.message}`, is_error: true, data: error };
  }
  const result = response.result as unknown as CallToolResult;
  const content = result.content.map((block) => (block.type === 'text' ? block.text : block.resource.text)).join('\n');
  return { content, ...(result.isError ? { is_error: true } : {}), data: result };
}

/** 把一个 MCP 服务器的工具接进 Agent 循环：定义来自 tools/list，执行走 tools/call。ToolBox 先在客户端按 inputSchema 校验一遍，不合格的不发出去。 */
export function mcpToolBox(client: McpClient, tools: readonly McpTool[]): ToolBox {
  const specs: ToolSpec[] = tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description ?? '',
    input_schema: { ...tool.inputSchema, type: 'object' },
    hints: tool.annotations,
    run: (input) => toToolOutcome(client.callTool(tool.name, input).response),
  }));
  return new ToolBox(specs);
}
