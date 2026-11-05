import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { crc32, decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

export type Fidelity = 'abi' | 'internal' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  abi: '真实布局：C 语言 x86-64 LP64 小端，按 System V ABI 计算',
  internal: '实现细节：glibc malloc 的内部布局，不属于 C 标准，可能随版本变化',
  示意: '示意：只讲概念，不是真实内存布局',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
