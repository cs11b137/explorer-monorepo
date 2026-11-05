import type { Color } from '../lessons/types';
import { hex, LayerWriter, type Fidelity, type FieldOptions, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

// ---------- C 结构布局：x86-64 System V ABI，LP64 ----------

export type CType = 'uint8_t' | 'int' | 'uint32_t' | 'size_t' | 'ptr';

/** 大小和对齐要求。psABI 的表 3.1：标量按自身大小对齐。 */
const ABI: Record<CType, { size: number; align: number; name: string }> = {
  uint8_t: { size: 1, align: 1, name: 'uint8_t' },
  int: { size: 4, align: 4, name: 'int' },
  uint32_t: { size: 4, align: 4, name: 'uint32_t' },
  size_t: { size: 8, align: 8, name: 'size_t' },
  ptr: { size: 8, align: 8, name: '指针' },
};

export type CField = [name: string, type: CType];

export interface FieldLayout {
  name: string;
  type: CType;
  offset: number;
  size: number;
}

export interface StructLayout {
  fields: FieldLayout[];
  size: number;
  align: number;
  /** 所有填充字节的位置，包括结构尾部的填充。 */
  pads: Array<{ offset: number; size: number; before: string | null }>;
}

const alignUp = (value: number, align: number) => Math.ceil(value / align) * align;

/** 按 ABI 规则计算偏移：每个字段对齐到自身要求，结构大小对齐到最大成员的要求。 */
export function layoutOf(fields: CField[]): StructLayout {
  const out: FieldLayout[] = [];
  const pads: StructLayout['pads'] = [];
  let at = 0;
  let align = 1;
  for (const [name, type] of fields) {
    const spec = ABI[type];
    const offset = alignUp(at, spec.align);
    if (offset > at) pads.push({ offset: at, size: offset - at, before: name });
    out.push({ name, type, offset, size: spec.size });
    at = offset + spec.size;
    align = Math.max(align, spec.align);
  }
  const size = alignUp(at, align);
  if (size > at) pads.push({ offset: at, size: size - at, before: null });
  return { fields: out, size, align, pads };
}

export type CValue = number | bigint | null;

function writeScalar(layer: LayerWriter, type: CType, value: CValue): void {
  if (value === null) layer.unknown(ABI[type].size);
  else if (type === 'uint8_t') layer.u8(Number(value));
  else if (type === 'int' || type === 'uint32_t') layer.u32(Number(value));
  else layer.u64(value);
}

function showScalar(type: CType, value: CValue, shown?: string): string {
  if (shown !== undefined) return shown;
  if (value === null) return '未初始化';
  if (type === 'ptr') return BigInt(value) === 0n ? 'NULL' : hex(value);
  return String(value);
}

export interface StructOptions {
  color?: Color;
  summary?: string;
  /** 字段名前缀，用于数组元素：slot[3].key。 */
  prefix?: string;
  notes?: Record<string, string>;
  /** 显示值覆盖，例如把 0 写成「空」。 */
  shown?: Record<string, string>;
  /** 地址之类每次运行都不同的字段。默认所有非空指针都算。 */
  examples?: string[];
}

function writeStruct(layer: LayerWriter, fields: CField[], values: Record<string, CValue>, options: StructOptions): void {
  const { prefix = '', notes = {}, shown = {}, examples = [] } = options;
  const base = layer.length;
  const layout = layoutOf(fields);
  const padText = (pad: StructLayout['pads'][number]) => (pad.before ? `让 ${pad.before} 对齐到 ${ABI[fields.find(([name]) => name === pad.before)![1]].align} 字节。` : `让结构大小是最大对齐 ${layout.align} 的倍数，数组里下一个元素才能对齐。`) + '这些字节的内容不确定。';
  for (const field of layout.fields) {
    const pad = layout.pads.find((item) => item.offset + item.size === field.offset);
    if (pad) layer.field(`${prefix}填充 · +${pad.offset}`, `${pad.size} 字节`, () => layer.unknown(pad.size), { hidden: true, note: padText(pad) });
    const value = values[field.name] ?? null;
    const example = examples.includes(field.name) || (field.type === 'ptr' && value !== null && BigInt(value) !== 0n);
    layer.field(`${prefix}${field.name} · +${field.offset}`, showScalar(field.type, value, shown[field.name]), () => writeScalar(layer, field.type, value), {
      note: notes[field.name] ?? `${ABI[field.type].name}，${field.size} 字节。`,
      example,
      hidden: value === null,
    });
  }
  const tail = layout.pads.find((item) => item.before === null);
  if (tail) layer.field(`${prefix}尾部填充 · +${tail.offset}`, `${tail.size} 字节`, () => layer.unknown(tail.size), { hidden: true, note: padText(tail) });
  if (layer.length - base !== layout.size) throw new Error(`${layer.id}: 写了 ${layer.length - base} 字节，布局是 ${layout.size}`);
}

/** 一个 C 结构体的真实字节。 */
export function cStruct(name: string, fields: CField[], values: Record<string, CValue>, options: StructOptions = {}): LayerWriter {
  const layout = layoutOf(fields);
  const layer = makeLayer(`${name} · ${layout.size} 字节`, options.color ?? 'blue', options.summary ?? '');
  writeStruct(layer, fields, values, options);
  return layer;
}

/** 结构体数组：元素紧挨着放，每个元素的尾部填充也在内。 */
export function cStructArray(name: string, fields: CField[], rows: Array<Record<string, CValue>>, options: StructOptions & { elementShown?: (index: number) => Record<string, string>; elementNotes?: (index: number) => Record<string, string> } = {}): LayerWriter {
  const layout = layoutOf(fields);
  const layer = makeLayer(`${name}[${rows.length}] · ${layout.size * rows.length} 字节`, options.color ?? 'blue', options.summary ?? '');
  rows.forEach((row, index) => {
    writeStruct(layer, fields, row, { ...options, prefix: `${name}[${index}].`, shown: options.elementShown?.(index), notes: options.elementNotes?.(index) });
  });
  return layer;
}

export interface ArrayOptions {
  color?: Color;
  summary?: string;
  /** 给某几个元素写说明。 */
  notes?: Record<number, string>;
  /** 显示值覆盖，例如把 INT_MAX 写成 ∞。 */
  shown?: (value: number, index: number) => string | undefined;
}

/** int 数组：每个元素 4 字节，小端。null 表示还没写过，内容不确定。 */
export function intArray(name: string, values: Array<number | null>, options: ArrayOptions = {}): LayerWriter {
  const layer = makeLayer(`int ${name}[${values.length}] · ${values.length * 4} 字节`, options.color ?? 'blue', options.summary ?? '');
  values.forEach((value, index) => {
    const shown = value === null ? '未初始化' : (options.shown?.(value, index) ?? String(value));
    layer.field(`${name}[${index}] · +${index * 4}`, shown, () => (value === null ? layer.unknown(4) : layer.u32(value)), {
      note: options.notes?.[index],
      hidden: value === null,
    });
  });
  return layer;
}

/** int 二维数组：C 按行存放，第 r 行第 c 列的偏移是 (r × cols + c) × 4。 */
export function intMatrix(name: string, rows: number[][], options: { color?: Color; summary?: string; notes?: Record<string, string> } = {}): LayerWriter {
  const cols = rows[0].length;
  const layer = makeLayer(`int ${name}[${rows.length}][${cols}] · ${rows.length * cols * 4} 字节`, options.color ?? 'blue', options.summary ?? '按行连续存放');
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      layer.field(`${name}[${r}][${c}] · +${(r * cols + c) * 4}`, String(value), () => layer.u32(value), { note: options.notes?.[`${r},${c}`] });
    });
  });
  return layer;
}

/** 字符数组：C 字符串末尾有一个 0 字节。 */
export function cString(name: string, text: string, options: { color?: Color; summary?: string; note?: string } = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${text.length + 1} 字节`, options.color ?? 'blue', options.summary ?? '');
  layer.field(`"${text}"`, `${text.length} 个字符`, () => layer.ascii(text), { note: options.note });
  layer.field('结束符', "'\\0'", () => layer.u8(0), { note: 'C 字符串靠这个 0 字节标记结尾，strlen 要一路数到它。' });
  return layer;
}

/** 一个 uint32_t 变量。 */
export function u32Var(name: string, value: number, options: { color?: Color; summary?: string; note?: string } = {}): LayerWriter {
  const layer = makeLayer(`uint32_t ${name} · 4 字节`, options.color ?? 'violet', options.summary ?? '小端：低位字节在前');
  layer.field(name, hex(value >>> 0, 8), () => layer.u32(value >>> 0), { note: options.note });
  return layer;
}

/** 概念结构：只有字段，没有字节。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}

// ---------- 寄存器 ----------

export type RegEntry = [reg: string, value: bigint | number, note?: string, options?: FieldOptions];

/** 寄存器组：每项 8 字节，只是展示容器，不代表它们在内存里相邻。 */
export function registers(name: string, entries: RegEntry[], color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [reg, value, note, options] of entries) {
    layer.field(reg, hex(value), () => layer.u64(value), { note, ...options });
  }
  return layer;
}

/** System V AMD64 调用约定：前 6 个整数或指针参数依次放在这些寄存器里。 */
export const ARG_REGS = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'] as const;

export function callRegs(signature: string, args: Array<[name: string, value: bigint | number, example?: boolean]>, color: Color = 'blue'): LayerWriter {
  const entries = args.map(([name, value, example], index): RegEntry => {
    const shown = typeof value === 'bigint' && value > 0xffffn ? hex(value) : String(value);
    return [ARG_REGS[index], value, `第 ${index + 1} 个参数 ${name} = ${shown}。`, { example: example ?? false }];
  });
  return registers(`调用 · ${signature}`, entries, color, 'System V 调用约定');
}

export function returnReg(signature: string, value: bigint | number, note: string, color: Color = 'green'): LayerWriter {
  return registers(`返回 · ${signature}`, [['rax', value, note]], color, '整数返回值放在 rax');
}

// ---------- glibc malloc ----------

/** glibc malloc.c 的 request2size：请求大小加 8 字节头，向上取整到 16 的倍数，最小 32。 */
export function chunkSize(request: number): number {
  const SIZE_SZ = 8;
  const MASK = 15;
  const MINSIZE = 32;
  return request + SIZE_SZ + MASK < MINSIZE ? MINSIZE : (request + SIZE_SZ + MASK) & ~MASK;
}

/** malloc 返回地址之前的 8 字节：mchunk_size。低 3 位是标志，所以这里能看到 0x21、0x31 这样的奇数。 */
export function chunkHeader(request: number, color: Color = 'violet'): LayerWriter {
  const size = chunkSize(request);
  const value = size | 1;
  const layer = makeLayer('malloc 块头 · glibc', color, '位于返回地址之前 8 字节');
  layer.field('mchunk_size', hex(value), () => layer.u64(value), {
    note: `请求 ${request} 字节，实际占用 ${size} 字节（含 8 字节头，向上取整到 16 的倍数，最小 32）。`,
  });
  layer.over('块大小', `${size} 字节`, 0, 8);
  layer.over('PREV_INUSE · 位 0', '1：前一块正在使用', 0, 1);
  return layer;
}
