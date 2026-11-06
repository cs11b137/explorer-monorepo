/**
 * 计算核心的统一入口。课程从这里取：
 *   import { runAgent, shopToolBox, createShop, McpClient, shopServer, encodeJson, ... } from '../core';
 *
 * 本模块自己的：
 * - shop.ts：场景数据（「小铺」的订单、规则库、可变的店铺状态）
 * - schema.ts：工具参数用的 JSON Schema 子集校验器
 * - tools.ts：工具的定义和实现、工具箱
 * - loop.ts：Agent 循环引擎、记账、子 Agent 工具、转交工具
 * - mcp/：JSON-RPC 2.0、MCP 协议类型、服务器、客户端、stdio、Streamable HTTP、授权、小铺的 MCP 服务器
 *
 * 共享包 @explorer/llm-core 的 Messages API、计费、token、JSON、HTTP、SSE、示例 id 一并转导出，课程不用分两处导入。
 * 接口说明见 modules/agent/README.md。
 */
export * from './shop';
export * from './schema';
export * from './tools';
export * from './loop';
export * from './mcp/jsonrpc';
export * from './mcp/protocol';
export * from './mcp/server';
export * from './mcp/client';
export * from './mcp/stdio';
export * from './mcp/http';
export * from './mcp/auth';
export * from './mcp/shop-server';

export * from '@explorer/llm-core/anthropic';
export * from '@explorer/llm-core/pricing';
export * from '@explorer/llm-core/ids';
export * from '@explorer/llm-core/json';
export * from '@explorer/llm-core/http';
export * from '@explorer/llm-core/sse';
export * from '@explorer/llm-core/template';
export { countTokens, encodeText, tokenLabel } from '@explorer/llm-core/tokens';
export { bm25, termsOf } from '@explorer/llm-core/bm25';
