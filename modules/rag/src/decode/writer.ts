import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

/**
 * 字节的可信度，检查器顶部显示。
 * - format：公开规范或 API 文档定义的真实字节：IEEE 754 float32 / float16 小端、UTF-8、JSON、HTTP/1.1、base64（RFC 4648）、
 *   uint8 的 PQ 码字、int32 的 token id，以及嵌入 API、Messages API 文档里的字段。
 * - internal：某个实现的内部布局，真实但会随版本变化：FAISS / hnswlib 的倒排表和邻接表在内存里怎么摆、int8 量化的缩放写法。
 * - 示意：只讲概念，不展示字节。
 */
export type Fidelity = 'format' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  format: '真实格式：公开规范或 API 文档定义的字节，如 IEEE 754 float32 / float16 小端、UTF-8、JSON、HTTP/1.1、base64、uint8 码字，以及嵌入 API 的字段',
  internal: '实现细节：某个向量库的内部布局（如 FAISS、hnswlib 的倒排表、邻接表），或本站的量化写法，真实但会随版本变化',
  示意: '示意：只讲概念，不是真实字节',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
