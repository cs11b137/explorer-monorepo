import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

/**
 * 字节的可信度，检查器顶部显示。
 * - format：公开规范或 API 文档定义的真实字节：HTTP/1.1 报文、SSE、JSON、UTF-8、TLS 记录头、API 文档里的字段。
 * - internal：某一个实现的内部细节，真实但会随版本变化：chat template 的具体写法和特殊 token、SDK 的重试策略、缓存键的算法。
 * - 示意：只讲概念，不展示字节。
 */
export type Fidelity = 'format' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  format: '真实格式：公开规范或 API 文档定义的字节，如 HTTP/1.1 报文、SSE、JSON、UTF-8，以及 Messages API、Chat Completions 的字段',
  internal: '实现细节：某个实现的内部写法（如 chat template 的特殊 token、SDK 的重试策略、缓存键），真实但会随模型和版本变化',
  示意: '示意：只讲概念，不是真实字节',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
