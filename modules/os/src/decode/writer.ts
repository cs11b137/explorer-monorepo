import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { crc32, decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

export type Fidelity = 'abi' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  abi: '稳定接口：布局由 ABI 或规范固定',
  internal: '内核内部结构：布局随版本变化，以 Linux 6.12 为准',
  示意: '示意：只讲概念，不是真实内存布局',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
