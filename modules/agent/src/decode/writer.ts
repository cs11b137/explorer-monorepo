import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

/**
 * 字节的可信度，检查器顶部显示。
 * - format：公开规范或 API 文档定义的真实字节：HTTP/1.1 报文、SSE、JSON、UTF-8、JSON-RPC 2.0、MCP 规范的消息和头，
 *   以及 Messages API 文档里的字段（tool_use、tool_result、stop_reason、usage）。
 * - internal：某一个实现的内部细节，真实但会随版本变化：chat template 怎样把工具和消息展开成 token、
 *   Agent 运行时内部的记账和状态、SDK 内部怎么驱动循环。
 * - 示意：只讲概念，不展示字节。
 */
export type Fidelity = 'format' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  format: '真实格式：公开规范或 API 文档定义的字节，如 HTTP/1.1、SSE、JSON、JSON-RPC 2.0、MCP 规范的消息和头，以及 Messages API 的字段',
  internal: '实现细节：某个实现的内部写法（如 chat template 怎样展开工具和消息、运行时内部的记账），真实但会随版本变化',
  示意: '示意：只讲概念，不是真实字节',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
