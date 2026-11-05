import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { crc32, decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

export type Fidelity = 'spec' | 'text' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  spec: '真实字节：布局由 Intel SDM、System V ABI 或 ELF 规范固定',
  text: '真实字节：这段文本或记录的原样内容，由本站的编译器算出',
  示意: '示意：只讲概念，不是真实内存布局',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
