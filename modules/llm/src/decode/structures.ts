/**
 * 按真实格式写字节的层（LayerWriter）。每个函数返回一层，wire() 把几层拼成一个事件的解码结构。
 * 字节全部来自 model/ 的真实计算：UTF-8 来自 utf8Encode，浮点来自 numeric.ts 的位模式，量化块来自 quantizeQ4_0。
 */
import type { Color } from '../lessons/types';
import { bf16Bits, bf16FromBits, f16Bits, f16FromBits, f32Bits, type Q4Block, type Q8Block } from '../model/numeric';
import { hex2, utf8Chars, utf8Kind } from '../model/utf8';
import { hex, LayerWriter, type Fidelity, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 数值的展示：最多 4 位小数，去掉末尾的 0；很小或很大的数用科学计数法。 */
export function num(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '−∞' : 'NaN';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 10 ** -digits || abs >= 1e6) return value.toExponential(2).replace(/-/g, '−');
  return String(+value.toFixed(digits)).replace(/-/g, '−');
}

const KIND_NOTE: Record<ReturnType<typeof utf8Kind>, string> = {
  ascii: '单字节字符（0xxxxxxx），和 ASCII 相同。',
  lead2: '2 字节字符的首字节（110xxxxx）。',
  lead3: '3 字节字符的首字节（1110xxxx），常用汉字都在这里。',
  lead4: '4 字节字符的首字节（11110xxx），比如 emoji。',
  cont: '续字节（10xxxxxx），只带 6 位数据。',
  invalid: '不是合法的 UTF-8 字节。',
};

export interface TextOptions {
  color?: Color;
  summary?: string;
  /** 给第几个字符写说明，下标按字符（码点）数。 */
  notes?: Record<number, string>;
}

/** 一段文本的 UTF-8 字节：每个字符一个字段，多字节字符再按字节拆成子字段。 */
export function utf8Text(name: string, text: string, options: TextOptions = {}): LayerWriter {
  const chars = utf8Chars(text);
  const total = chars.reduce((sum, item) => sum + item.bytes.length, 0);
  const layer = makeLayer(`${name} · ${total} 字节`, options.color ?? 'blue', options.summary ?? `${chars.length} 个字符，UTF-8 编码`);
  let at = 0;
  chars.forEach(({ char, bytes }, index) => {
    const shown = char === ' ' ? '空格' : char;
    const cp = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    layer.field(`'${shown}' · +${at}`, `${cp}，${bytes.length} 字节`, () => layer.raw(bytes), {
      note: options.notes?.[index] ?? (bytes.length === 1 ? KIND_NOTE.ascii : `${bytes.map(hex2).join(' ')}：首字节说明长度，后面 ${bytes.length - 1} 个是续字节。`),
    });
    if (bytes.length > 1) bytes.forEach((byte, i) => layer.over(`${hex2(byte)}`, utf8Kind(byte) === 'cont' ? '续字节' : '首字节', at + i, at + i + 1, { note: KIND_NOTE[utf8Kind(byte)] }));
    at += bytes.length;
  });
  return layer;
}

export interface BytesOptions {
  color?: Color;
  summary?: string;
  /** 每组字节的名字（比如 token 的展示文字），不填就逐字节列出。 */
  groups?: Array<{ name: string; bytes: number[]; note?: string }>;
}

/** 一串原始字节。按组（通常是一个 token 的字节）写字段。 */
export function rawBytes(name: string, bytes: readonly number[], options: BytesOptions = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'blue', options.summary ?? '');
  const groups: NonNullable<BytesOptions['groups']> = options.groups ?? bytes.map((byte) => ({ name: hex2(byte), bytes: [byte] }));
  let at = 0;
  for (const group of groups) {
    layer.field(`${group.name} · +${at}`, group.bytes.map(hex2).join(' '), () => layer.raw(group.bytes), { note: group.note ?? KIND_NOTE[utf8Kind(group.bytes[0])] });
    at += group.bytes.length;
  }
  if (at !== bytes.length) throw new Error(`${name}: 分组共 ${at} 字节，原文 ${bytes.length} 字节`);
  return layer;
}

export interface IdsOptions {
  color?: Color;
  summary?: string;
  /** 每个 id 的展示文字，比如分词器的 label。 */
  labels?: (id: number, index: number) => string;
  notes?: Record<number, string>;
}

/** token id 数组：int32 小端，每个 4 字节。llama.cpp 的 llama_token 就是 int32_t。 */
export function tokenIds(name: string, ids: readonly number[], options: IdsOptions = {}): LayerWriter {
  const layer = makeLayer(`int32 ${name}[${ids.length}] · ${ids.length * 4} 字节`, options.color ?? 'violet', options.summary ?? '小端：低位字节在前');
  ids.forEach((id, index) => {
    const label = options.labels?.(id, index);
    layer.field(`${name}[${index}] · +${index * 4}`, label ? `${id}（${label}）` : String(id), () => layer.u32(id), { note: options.notes?.[index] ?? `token id ${id} = ${hex(id, 8)}。` });
  });
  return layer;
}

export type FloatFormat = 'f32' | 'f16' | 'bf16';

const FLOAT_BYTES: Record<FloatFormat, number> = { f32: 4, f16: 2, bf16: 2 };
const FLOAT_NAME: Record<FloatFormat, string> = { f32: 'float32', f16: 'float16', bf16: 'bfloat16' };

/** 一个数在这种格式下的位模式，以及存进去之后真正的值。 */
function floatBits(format: FloatFormat, value: number): { bits: number; stored: number } {
  if (format === 'f32') return { bits: f32Bits(value), stored: Math.fround(value) };
  if (format === 'f16') {
    const bits = f16Bits(value);
    return { bits, stored: f16FromBits(bits) };
  }
  const bits = bf16Bits(value);
  return { bits, stored: bf16FromBits(bits) };
}

export interface FloatOptions {
  color?: Color;
  summary?: string;
  /** 每个元素的名字，默认是 name[i]。 */
  names?: (index: number) => string;
  notes?: Record<number, string>;
  /** 把每个数登记成可按位展示的字（符号、指数、尾数）。数多时会很长，只在讲格式的事件里打开。 */
  bits?: boolean;
  /** 显示用的小数位数。 */
  digits?: number;
}

/** 浮点向量：fp32 / fp16 / bf16，小端。显示的是存进去之后的值（含舍入）。 */
export function floatVector(name: string, values: readonly number[], format: FloatFormat = 'f32', options: FloatOptions = {}): LayerWriter {
  const size = FLOAT_BYTES[format];
  const layer = makeLayer(`${FLOAT_NAME[format]} ${name}[${values.length}] · ${values.length * size} 字节`, options.color ?? 'blue', options.summary ?? '');
  values.forEach((value, index) => {
    const { bits, stored } = floatBits(format, value);
    const label = `${options.names?.(index) ?? `${name}[${index}]`} · +${index * size}`;
    const note = options.notes?.[index] ?? `${FLOAT_NAME[format]} 位模式 ${hex(bits, size * 2)}。`;
    if (options.bits) {
      const expBits = format === 'f16' ? 5 : 8;
      const width = size * 8;
      layer.word(label, bits, width, { note });
      layer.bitField('符号', bits >>> (width - 1) ? '负' : '正', [[width - 1, width - 1]]);
      layer.bitField('指数', String((bits >>> (width - 1 - expBits)) & ((1 << expBits) - 1)), [[width - 2, width - 1 - expBits]]);
      layer.bitField('尾数', hex(bits & ((1 << (width - 1 - expBits)) - 1)), [[width - 2 - expBits, 0]]);
      // word 的字段显示的是十六进制，这里补一个值。
      layer.over('值', num(stored, options.digits ?? 6), layer.length - size, layer.length);
    } else {
      layer.field(label, num(stored, options.digits ?? 4), () => layer.raw(Array.from({ length: size }, (_, i) => (bits >>> (i * 8)) & 0xff)), { note });
    }
  });
  return layer;
}

/** 浮点矩阵，行优先：第 r 行第 c 列的偏移是 (r × 列数 + c) × 每个数的字节数。 */
export function floatMatrix(name: string, rows: readonly (readonly number[])[], format: FloatFormat = 'f32', options: { color?: Color; summary?: string; rowNames?: (r: number) => string; digits?: number } = {}): LayerWriter {
  const cols = rows[0].length;
  const size = FLOAT_BYTES[format];
  const layer = makeLayer(`${FLOAT_NAME[format]} ${name}[${rows.length}][${cols}] · ${rows.length * cols * size} 字节`, options.color ?? 'blue', options.summary ?? '行优先，连续存放');
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const { bits, stored } = floatBits(format, value);
      layer.field(`${options.rowNames?.(r) ?? `${name}[${r}]`}[${c}] · +${(r * cols + c) * size}`, num(stored, options.digits ?? 4), () => layer.raw(Array.from({ length: size }, (_, i) => (bits >>> (i * 8)) & 0xff)));
    });
  });
  return layer;
}

/** GGUF 的一块 Q8_0：d（fp16）+ 32 个 int8，34 字节。 */
export function q8_0Block(name: string, block: Q8Block, options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`block_q8_0 ${name} · 34 字节`, options.color ?? 'amber', options.summary ?? '32 个权重共用一个缩放因子');
  const d = f16FromBits(block.d);
  layer.field('d · +0', num(d, 6), () => layer.u16(block.d), { note: `fp16 缩放因子，位模式 ${hex(block.d, 4)}。原值 ≈ q × d。` });
  block.qs.forEach((q, j) => layer.field(`qs[${j}] · +${2 + j}`, String(q), () => layer.u8(q & 0xff), { note: `int8，还原为 ${num(q * d, 5)}。` }));
  return layer;
}

/** GGUF 的一块 Q4_0：d（fp16）+ 16 字节，每字节低 4 位是第 j 个值，高 4 位是第 j+16 个值，18 字节。 */
export function q4_0Block(name: string, block: Q4Block, options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`block_q4_0 ${name} · 18 字节`, options.color ?? 'amber', options.summary ?? '32 个权重共用一个缩放因子，每个只占 4 位');
  const d = f16FromBits(block.d);
  layer.field('d · +0', num(d, 6), () => layer.u16(block.d), { note: `fp16 缩放因子，位模式 ${hex(block.d, 4)}。原值 ≈ (q − 8) × d。` });
  block.qs.forEach((byte, j) => {
    const lo = block.q[j];
    const hi = block.q[j + 16];
    layer.word(`qs[${j}] · +${2 + j}`, byte, 8, { note: `低 4 位是第 ${j} 个权重，高 4 位是第 ${j + 16} 个。` });
    layer.bitField(`w[${j + 16}]`, `${hi} → ${num((hi - 8) * d, 4)}`, [[7, 4]]);
    layer.bitField(`w[${j}]`, `${lo} → ${num((lo - 8) * d, 4)}`, [[3, 0]]);
  });
  return layer;
}

/** int32 / uint32 标量。 */
export function u32Var(name: string, value: number, options: { color?: Color; summary?: string; note?: string; shown?: string } = {}): LayerWriter {
  const layer = makeLayer(`uint32 ${name} · 4 字节`, options.color ?? 'violet', options.summary ?? '小端：低位字节在前');
  layer.field(name, options.shown ?? String(value), () => layer.u32(value >>> 0), { note: options.note });
  return layer;
}

/** 概念结构：只有字段，没有字节。配合 fidelity '示意'。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}
