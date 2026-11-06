import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

/**
 * 字节的可信度，检查器顶部显示。
 * - format：公开规范或 API 文档定义的真实字节：HTTP/1.1、JSON、UTF-8、Messages API 的字段（含 metadata.user_id）、
 *   W3C traceparent 头、OTLP/JSON 的结构和 OpenTelemetry GenAI 语义约定的属性名。
 * - internal：本站或某个实现的内部写法，真实计算但不是标准：本站的检测规则和命中区间、分类器的 n-gram 和桶号、
 *   防护层交回的判定、评估报告、限流器的状态。
 * - 示意：只讲概念，不展示字节。
 */
export type Fidelity = 'format' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  format: '真实格式：公开规范或 API 文档定义的字节，如 HTTP/1.1、JSON、UTF-8、Messages API 的字段、W3C traceparent、OTLP/JSON',
  internal: '实现细节：本站的写法（检测规则、分类器的特征桶、防护层的判定、评估报告），真实计算但不是标准，换一个实现就不同',
  示意: '示意：只讲概念，不是真实字节',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
