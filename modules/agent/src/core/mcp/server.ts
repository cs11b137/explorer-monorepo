/**
 * 内存里的 MCP 服务器：收一条 JSON-RPC 消息，回一条（通知不回）。按 2026-07-28 版规范处理：
 *
 * - 无状态：每个请求的 params._meta 必须有 protocolVersion 和 clientCapabilities，缺了回 -32602（HTTP 上是 400）；
 *   版本不支持回 -32022 UnsupportedProtocolVersion，data 里列出支持的版本和请求的版本。服务器不记任何连接状态。
 * - 方法：server/discover、tools/list、tools/call、resources/list、resources/read、prompts/list、prompts/get。
 *   没实现的方法、或者没声明对应能力的方法回 -32601。
 * - 结果都带 resultType；discover 和各种 list、resources/read 还带缓存提示 ttlMs、cacheScope；_meta 里写 serverInfo。
 * - tools/call：找不到工具是协议错误 -32602；工具自己的失败（参数不合格、业务规则不允许）放在结果里，isError: true，
 *   这样模型能看到错误并改正（规范的 Error Handling 一节）。
 * - 需要用户确认的工具（elicit）：客户端没声明 elicitation 能力时回 -32021 MissingRequiredClientCapability；
 *   声明了就回 InputRequiredResult（resultType: "input_required"），客户端带着 inputResponses 重发原请求（新的 id）才执行。
 *   这是规范的多轮请求（MRTR）模式，取代了旧版里服务器主动发的 elicitation/create 请求。
 * - 收到旧版的 initialize：本服务器只支持新版，按规范在错误里写出支持的版本（错误码规范没规定，这里用 -32022）。
 * - 通知 notifications/cancelled 记下被取消的请求 id，不回复。客户端发来的响应（MCP 里客户端不该发）忽略。
 */
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import type { ToolBox, ToolContext } from '../tools';
import { isNotification, isRequest, parseRpc, rpcError, rpcResult, RPC, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcResponse, type RequestId } from './jsonrpc';
import { LEGACY_VERSIONS, META, PROTOCOL_VERSION, type CacheHints, type ClientCapabilities, type Implementation, type McpPrompt, type McpResource, type McpTool, type PromptMessage, type ServerCapabilities } from './protocol';

export interface ResourceSpec {
  resource: McpResource;
  read(): string;
}

export interface PromptSpec {
  prompt: McpPrompt;
  render(args: Record<string, string>): { description?: string; messages: PromptMessage[] };
}

/** elicitation/create 的表单参数（form 模式）。 */
export interface ElicitForm {
  mode: 'form';
  message: string;
  requestedSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] };
}

export interface ServerOptions {
  info: Implementation;
  ctx: ToolContext;
  tools?: ToolBox;
  resources?: ResourceSpec[];
  prompts?: PromptSpec[];
  instructions?: string;
  /** 支持的协议版本，默认只有 2026-07-28。 */
  versions?: string[];
  /** 可缓存结果的提示，默认 { ttlMs: 300000, cacheScope: 'public' }。 */
  cache?: CacheHints;
  /** 每页最多几项（tools/list 等），默认不分页。 */
  pageSize?: number;
  /** 执行前要用户确认的工具：工具名 → 根据参数生成确认表单。 */
  elicit?: Record<string, (args: Record<string, unknown>) => ElicitForm>;
  /**
   * 带输出 schema 的工具：工具名 → outputSchema。tools/list 列出它；tools/call 成功时结果多带 structuredContent（= ToolOutcome.data），
   * 文本块里仍是序列化的 JSON（规范的向后兼容建议）。默认没有，结果只有 content。
   */
  outputSchemas?: Record<string, Record<string, unknown>>;
}

/** 确认表单在 inputRequests / inputResponses 里用的键。 */
export const CONFIRM_KEY = 'confirm';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** requestState：服务器自己的不透明串（客户端原样带回，不解析）。本站写成 base64 的 JSON。 */
export const encodeState = (value: unknown): string => btoa(String.fromCharCode(...utf8Encode(JSON.stringify(value))));
export const decodeState = (text: string): unknown => JSON.parse(utf8Decode([...atob(text)].map((char) => char.charCodeAt(0))));

export interface Handled {
  message: JsonRpcMessage;
  response: JsonRpcResponse | null;
}

export class McpServer {
  readonly options: ServerOptions;
  readonly versions: string[];
  /** 处理过的每条消息和回复，按顺序。 */
  readonly log: Handled[] = [];
  /** 收到过取消通知的请求 id。 */
  readonly cancelled = new Set<RequestId>();

  constructor(options: ServerOptions) {
    this.options = options;
    this.versions = options.versions ?? [PROTOCOL_VERSION];
  }

  capabilities(): ServerCapabilities {
    const { tools, resources, prompts } = this.options;
    return {
      ...(tools ? { tools: { listChanged: false } } : {}),
      ...(resources ? { resources: { subscribe: false, listChanged: false } } : {}),
      ...(prompts ? { prompts: { listChanged: false } } : {}),
    };
  }

  /** 列出的工具：ToolSpec 写成 MCP 的 Tool（inputSchema 驼峰、annotations 是提示）。 */
  tools(): McpTool[] {
    return (this.options.tools?.specs ?? []).map((spec) => ({
      name: spec.name,
      ...(spec.title ? { title: spec.title } : {}),
      description: spec.description,
      inputSchema: spec.input_schema,
      ...(this.options.outputSchemas?.[spec.name] ? { outputSchema: this.options.outputSchemas[spec.name] } : {}),
      ...(spec.hints ? { annotations: { ...spec.hints } } : {}),
    }));
  }

  /** 处理一条消息（对象或一行 JSON 文字）。请求返回响应，通知和客户端发来的响应返回 null。 */
  handle(input: JsonRpcMessage | string): JsonRpcResponse | null {
    let message: JsonRpcMessage;
    if (typeof input === 'string') {
      const parsed = parseRpc(input);
      if (!parsed.ok) return this.record(null, parsed.error);
      message = parsed.message;
    } else message = input;
    if (isNotification(message)) {
      if (message.method === 'notifications/cancelled' && isObject(message.params) && (typeof message.params.requestId === 'string' || typeof message.params.requestId === 'number')) this.cancelled.add(message.params.requestId);
      return this.record(message, null);
    }
    if (!isRequest(message)) return this.record(message, null);
    return this.record(message, this.request(message));
  }

  private record(message: JsonRpcMessage | null, response: JsonRpcResponse | null): JsonRpcResponse | null {
    if (message) this.log.push({ message, response });
    return response;
  }

  private request(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params ?? {};
    if (req.method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcError(req.id, RPC.UNSUPPORTED_PROTOCOL_VERSION, `This server only supports protocol version ${this.versions.join(', ')} (no initialize handshake)`, { supported: this.versions, requested });
    }
    const meta = isObject(params._meta) ? params._meta : null;
    const missing = [META.protocolVersion, META.clientCapabilities].filter((key) => !meta || meta[key] === undefined);
    if (missing.length || typeof meta![META.protocolVersion] !== 'string' || !isObject(meta![META.clientCapabilities])) return rpcError(req.id, RPC.INVALID_PARAMS, 'Invalid params: missing required _meta fields', { missing });
    const version = meta![META.protocolVersion] as string;
    if (!this.versions.includes(version)) return rpcError(req.id, RPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: this.versions, requested: version });
    const caps = meta![META.clientCapabilities] as ClientCapabilities;
    try {
      return this.dispatch(req, params, caps);
    } catch (error) {
      return rpcError(req.id, RPC.INTERNAL_ERROR, `Internal error: ${(error as Error).message}`);
    }
  }

  private complete(id: RequestId, body: Record<string, unknown>, cacheable: boolean): JsonRpcResponse {
    const cache = cacheable ? this.options.cache ?? { ttlMs: 300_000, cacheScope: 'public' as const } : null;
    return rpcResult(id, { resultType: 'complete', ...body, ...(cache ?? {}), _meta: { [META.serverInfo]: this.options.info } });
  }

  /** 分页：cursor 是本服务器自己的不透明串（这里是 base64 的下标）。 */
  private page<T>(id: RequestId, items: T[], params: Record<string, unknown>): { items: T[]; nextCursor?: string } | JsonRpcResponse {
    const size = this.options.pageSize ?? Infinity;
    let start = 0;
    if (params.cursor !== undefined) {
      let at = NaN;
      try {
        if (typeof params.cursor === 'string') at = Number(atob(params.cursor));
      } catch {
        // 不是合法的 base64：当作无效的 cursor。
      }
      if (!Number.isInteger(at) || at < 0 || at > items.length) return rpcError(id, RPC.INVALID_PARAMS, 'Invalid cursor');
      start = at;
    }
    const end = Math.min(items.length, start + size);
    return { items: items.slice(start, end), ...(end < items.length ? { nextCursor: btoa(String(end)) } : {}) };
  }

  private dispatch(req: JsonRpcRequest, params: Record<string, unknown>, caps: ClientCapabilities): JsonRpcResponse {
    const { id } = req;
    const notFound = () => rpcError(id, RPC.METHOD_NOT_FOUND, 'Method not found', { method: req.method });
    const { tools, resources, prompts } = this.options;
    switch (req.method) {
      case 'server/discover':
        return this.complete(id, { supportedVersions: this.versions, capabilities: this.capabilities(), ...(this.options.instructions ? { instructions: this.options.instructions } : {}) }, true);
      case 'tools/list': {
        if (!tools) return notFound();
        const page = this.page(id, this.tools(), params);
        if ('jsonrpc' in page) return page;
        return this.complete(id, { tools: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }, true);
      }
      case 'tools/call': {
        if (!tools) return notFound();
        if (typeof params.name !== 'string') return rpcError(id, RPC.INVALID_PARAMS, 'Invalid params: name is required');
        if (!tools.get(params.name)) return rpcError(id, RPC.INVALID_PARAMS, `Unknown tool: ${params.name}`);
        const args = isObject(params.arguments) ? params.arguments : {};
        const form = this.options.elicit?.[params.name];
        if (form) {
          if (!caps.elicitation) return rpcError(id, RPC.MISSING_REQUIRED_CLIENT_CAPABILITY, 'Missing required client capability', { requiredCapabilities: { elicitation: {} } });
          const answer = isObject(params.inputResponses) ? params.inputResponses[CONFIRM_KEY] : undefined;
          if (!isObject(answer)) return rpcResult(id, { resultType: 'input_required', inputRequests: { [CONFIRM_KEY]: { method: 'elicitation/create', params: form(args) } }, requestState: encodeState({ tool: params.name, arguments: args }) });
          if (answer.action !== 'accept') return this.complete(id, { content: [{ type: 'text', text: `用户没有确认（${String(answer.action)}），没有执行 ${params.name}` }], isError: true }, false);
        }
        const outcome = tools.call(params.name, args, this.options.ctx);
        const structured = !outcome.is_error && this.options.outputSchemas?.[params.name] !== undefined && outcome.data !== undefined;
        return this.complete(id, { content: [{ type: 'text', text: outcome.content }], ...(structured ? { structuredContent: outcome.data } : {}), ...(outcome.is_error ? { isError: true } : {}) }, false);
      }
      case 'resources/list': {
        if (!resources) return notFound();
        const page = this.page(id, resources.map((spec) => spec.resource), params);
        if ('jsonrpc' in page) return page;
        return this.complete(id, { resources: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }, true);
      }
      case 'resources/read': {
        if (!resources) return notFound();
        const spec = resources.find((item) => item.resource.uri === params.uri);
        if (!spec) return rpcError(id, RPC.INVALID_PARAMS, 'Resource not found', { uri: params.uri });
        return this.complete(id, { contents: [{ uri: spec.resource.uri, ...(spec.resource.mimeType ? { mimeType: spec.resource.mimeType } : {}), text: spec.read() }] }, true);
      }
      case 'prompts/list': {
        if (!prompts) return notFound();
        const page = this.page(id, prompts.map((spec) => spec.prompt), params);
        if ('jsonrpc' in page) return page;
        return this.complete(id, { prompts: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }, true);
      }
      case 'prompts/get': {
        if (!prompts) return notFound();
        const spec = prompts.find((item) => item.prompt.name === params.name);
        if (!spec) return rpcError(id, RPC.INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`);
        const args = isObject(params.arguments) ? (params.arguments as Record<string, string>) : {};
        const missing = (spec.prompt.arguments ?? []).filter((arg) => arg.required && typeof args[arg.name] !== 'string').map((arg) => arg.name);
        if (missing.length) return rpcError(id, RPC.INVALID_PARAMS, `Missing required arguments: ${missing.join(', ')}`);
        return this.complete(id, { ...spec.render(args) }, false);
      }
      default:
        return notFound();
    }
  }
}

/** 旧版本号（legacy）是否认得：dual-era 服务器才需要，本站的服务器不实现旧版，只用于展示。 */
export const isLegacyVersion = (version: string): boolean => (LEGACY_VERSIONS as readonly string[]).includes(version);
