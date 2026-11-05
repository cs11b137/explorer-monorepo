import type { Color } from '../types';

export interface FieldOptions {
  note?: string;
  /** 示例值：每次运行可能不同。 */
  example?: boolean;
  depth?: number;
  /** 字节不展示或尚不确定，hex 里显示为 ··。 */
  hidden?: boolean;
  heading?: boolean;
  mono?: boolean;
  /** 位级字段：所属的字和占用的位段（可以不连续，比如 B 型立即数）。 */
  bits?: { word: number; ranges: Array<[hi: number, lo: number]> };
  /** 在位视图里的颜色，默认用层的颜色。 */
  tone?: Color;
}

/** 一个按位展示的字。 */
export interface BitWord {
  name: string;
  width: number;
  value: number;
  from: number;
  to: number;
}

export interface Field extends FieldOptions {
  layer: string;
  name: string;
  value: string;
  from: number;
  to: number;
}

export type Byte = number | null;

/** 按真实布局写字节。每个字段记录自己的字节范围，供检查器做悬停联动。 */
export class LayerWriter {
  bytes: Byte[] = [];
  fields: Field[] = [];
  words: BitWord[] = [];

  constructor(
    readonly id: string,
    public name: string,
    readonly color: Color = 'blue',
    public summary = '',
    /** 这一层第一个字节在页面或文件里的真实偏移，用于分段 hex 的地址列。 */
    public addr = 0,
  ) {}

  get length(): number {
    return this.bytes.length;
  }

  /** 把 write 写入的字节归到一个字段。write 不写字节时，字段没有字节范围。 */
  field(name: string, value: string | number, write: () => void = () => {}, options: FieldOptions = {}): this {
    const from = this.length;
    write();
    this.fields.push({ layer: this.id, name, value: String(value), from, to: this.length, ...options });
    return this;
  }

  /** 给已写好的字节范围再加一个说明字段，用于拆解位域。 */
  over(name: string, value: string | number, from: number, to: number, options: FieldOptions = {}): this {
    this.fields.push({ layer: this.id, name, value: String(value), from, to, depth: 1, ...options });
    return this;
  }

  /** 写入一个小端的字，并把它登记成可以按位展示。width 不超过 32。 */
  word(name: string, value: number, width: number, options: FieldOptions = {}): this {
    const from = this.length;
    const count = Math.ceil(width / 8);
    for (let index = 0; index < count; index++) this.bytes.push((value >>> (index * 8)) & 0xff);
    this.words.push({ name, width, value: value >>> 0, from, to: this.length });
    const shown = `0x${(value >>> 0).toString(16).padStart(count * 2, '0')}`;
    this.fields.push({ layer: this.id, name, value: shown, from, to: this.length, ...options });
    return this;
  }

  /** 给最近写入的字加一个位级字段。字节范围取覆盖这些位的最小范围。 */
  bitField(name: string, value: string | number, ranges: Array<[number, number]>, options: FieldOptions = {}): this {
    const word = this.words[this.words.length - 1];
    if (!word) throw new Error(`${this.id}: 位字段之前要先写字`);
    for (const [hi, lo] of ranges) {
      if (hi >= word.width || lo < 0 || lo > hi) throw new Error(`${name}: 位段 ${hi}:${lo} 超出字宽 ${word.width}`);
    }
    const lowest = Math.min(...ranges.map(([, lo]) => lo));
    const highest = Math.max(...ranges.map(([hi]) => hi));
    this.fields.push({
      layer: this.id, name, value: String(value), from: word.from + (lowest >> 3), to: word.from + (highest >> 3) + 1, depth: 1,
      bits: { word: this.words.length - 1, ranges }, ...options,
    });
    return this;
  }

  raw(data: ArrayLike<number>): this {
    for (let index = 0; index < data.length; index++) this.bytes.push(data[index] & 0xff);
    return this;
  }

  unknown(count: number): this {
    for (let index = 0; index < count; index++) this.bytes.push(null);
    return this;
  }

  zero(count: number): this {
    for (let index = 0; index < count; index++) this.bytes.push(0);
    return this;
  }

  u8(value: number): this {
    return this.raw([value]);
  }

  u16(value: number): this {
    return this.raw([value, value >>> 8]);
  }

  u32(value: number): this {
    return this.raw([value, value >>> 8, value >>> 16, value >>> 24]);
  }

  u64(value: bigint | number): this {
    const big = BigInt.asUintN(64, BigInt(value));
    for (let shift = 0n; shift < 64n; shift += 8n) this.bytes.push(Number((big >> shift) & 0xffn));
    return this;
  }

  be16(value: number): this {
    return this.raw([value >>> 8, value]);
  }

  be32(value: number): this {
    return this.raw([value >>> 24, value >>> 16, value >>> 8, value]);
  }

  be64(value: bigint | number): this {
    const big = BigInt.asUintN(64, BigInt(value));
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.bytes.push(Number((big >> shift) & 0xffn));
    return this;
  }

  ascii(text: string): this {
    for (const char of text) this.bytes.push(char.charCodeAt(0) & 0xff);
    return this;
  }

  /** 按偏移补零到指定位置，防止结构布局写错而不自知。 */
  padTo(offset: number): this {
    if (this.length > offset) throw new Error(`${this.id}: 已写到 ${this.length}，超过目标偏移 ${offset}`);
    return this.zero(offset - this.length);
  }

  /** 和 padTo 一样对齐到偏移，但把中间的字节标成不展示。 */
  unknownTo(offset: number): this {
    if (this.length > offset) throw new Error(`${this.id}: 已写到 ${this.length}，超过目标偏移 ${offset}`);
    return this.unknown(offset - this.length);
  }
}

export interface Wire<F extends string = string> {
  /** 这个事件发生的位置，显示在检查器顶部。 */
  at: string;
  /** mem 按连续字节显示 hex；regs、vals 逐行显示，因为这些值不是相邻内存。 */
  view: 'mem' | 'regs' | 'vals';
  fidelity: F;
  layers: LayerWriter[];
}

export interface DecodedLayer {
  id: string;
  name: string;
  color: Color;
  summary: string;
  from: number;
  to: number;
  addr: number;
}

export interface Decoded<F extends string = string> {
  at: string;
  view: Wire['view'];
  fidelity: F;
  bytes: Byte[];
  fields: Field[];
  layers: DecodedLayer[];
  words: Array<BitWord & { layer: string; color: Color }>;
}

/** 把多层结构拼成一块连续字节，并把字段偏移换算到整体坐标。 */
export function decode<F extends string>(wire: Wire<F>): Decoded<F> {
  const bytes: Byte[] = [];
  const fields: Field[] = [];
  const layers: DecodedLayer[] = [];
  const words: Decoded['words'] = [];
  for (const layer of wire.layers) {
    const base = bytes.length;
    const wordBase = words.length;
    bytes.push(...layer.bytes);
    for (const word of layer.words) words.push({ ...word, from: word.from + base, to: word.to + base, layer: layer.id, color: layer.color });
    for (const field of layer.fields) {
      fields.push({ ...field, from: field.from + base, to: field.to + base, ...(field.bits ? { bits: { ...field.bits, word: field.bits.word + wordBase } } : {}) });
    }
    layers.push({ id: layer.id, name: layer.name, color: layer.color, summary: layer.summary, from: base, to: bytes.length, addr: layer.addr });
  }
  return { at: wire.at, view: wire.view, fidelity: wire.fidelity, bytes, fields, layers, words };
}

export const hex = (value: bigint | number, width = 0): string => `0x${BigInt.asUintN(64, BigInt(value)).toString(16).padStart(width, '0')}`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** IEEE CRC32，GPT 头和表项校验都用它。 */
export function crc32(data: Iterable<number>): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
