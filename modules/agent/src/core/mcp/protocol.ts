/**
 * MCP 的版本、_meta 保留键和数据类型。按 https://modelcontextprotocol.io/specification/2026-07-28 （核对日期 2026-11-06，
 * 当时的最新正式版；还有一个 draft）和它的 schema.ts 写，字段名照抄。
 *
 * 2026-07-28 版最大的变化：协议变成无状态的。没有 initialize / notifications/initialized 握手，也没有会话；
 * 每个请求都在 params._meta 里自带协议版本和客户端能力（可选再带 clientInfo），服务器逐个请求独立处理。
 * 想事先知道服务器支持什么，就调 server/discover（服务器必须实现，客户端可以不调）。
 */

export const PROTOCOL_VERSION = '2026-07-28';
/** 用 initialize 握手的旧版本（规范里称 legacy）。本站的服务器只实现新版，收到旧版请求按规范回错误。 */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** _meta 里的保留键。 */
export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  logLevel: 'io.modelcontextprotocol/logLevel',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
} as const;

export interface Implementation {
  name: string;
  version: string;
  title?: string;
  description?: string;
}

export interface ClientCapabilities {
  elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
  /** 2026-07-28 起已弃用（deprecated），仍可用。 */
  sampling?: Record<string, unknown>;
  /** 2026-07-28 起已弃用（deprecated），仍可用。 */
  roots?: Record<string, never>;
  experimental?: Record<string, Record<string, unknown>>;
  extensions?: Record<string, Record<string, unknown>>;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  completions?: Record<string, unknown>;
  /** 已弃用。 */
  logging?: Record<string, unknown>;
  experimental?: Record<string, Record<string, unknown>>;
  extensions?: Record<string, Record<string, unknown>>;
}

/** 每个请求的 params._meta：protocolVersion 和 clientCapabilities 必填，clientInfo 建议每次都带。 */
export interface RequestMeta {
  'io.modelcontextprotocol/protocolVersion': string;
  'io.modelcontextprotocol/clientCapabilities': ClientCapabilities;
  'io.modelcontextprotocol/clientInfo'?: Implementation;
  [key: string]: unknown;
}

export const requestMeta = (clientInfo: Implementation | undefined, capabilities: ClientCapabilities = {}, version = PROTOCOL_VERSION): RequestMeta => ({
  [META.protocolVersion]: version,
  ...(clientInfo ? { [META.clientInfo]: clientInfo } : {}),
  [META.clientCapabilities]: capabilities,
});

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface EmbeddedResource {
  type: 'resource';
  resource: ResourceContents;
}

export type McpContent = TextContent | EmbeddedResource;

export interface CallToolResult {
  resultType: 'complete';
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: McpContent;
}

/** 可缓存的结果（discover、各种 list、resources/read）必须带 ttlMs 和 cacheScope。 */
export interface CacheHints {
  ttlMs: number;
  cacheScope: 'public' | 'private';
}
