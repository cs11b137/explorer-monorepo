import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { crc32, decode, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

export type Fidelity = 'spec' | 'model' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  spec: '规范固定：位布局由 RISC-V 非特权规范或 IEEE 754 规定',
  model: '教学模型：参数是示例，数值由模拟器算出，真实芯片各不相同',
  示意: '示意：只讲概念，不是真实的位布局',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;

/** 这个站讲的是 32 位机器，十六进制按 32 位显示。 */
export const hex = (value: bigint | number, width = 0): string => `0x${BigInt.asUintN(32, BigInt(value)).toString(16).padStart(width, '0')}`;
