import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

/**
 * 字节的可信度，检查器顶部显示。
 * - format：公开规范定义的真实字节，换一个实现也一样。
 * - internal：某个推理引擎的内部布局，真实但不是标准，版本一变就可能不同。
 * - 示意：只讲概念，不展示字节。
 */
export type Fidelity = 'format' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  format: '真实格式：公开规范定义的字节，如 UTF-8、int32 token id、IEEE 754 fp32 / fp16 / bf16 小端、GGUF / safetensors',
  internal: '实现细节：推理引擎的内部布局（如 llama.cpp、vLLM 的 KV cache 和块表），不属于公开格式，可能随版本变化',
  示意: '示意：只讲概念，不是真实字节',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
