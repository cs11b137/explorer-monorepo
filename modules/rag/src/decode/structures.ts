/**
 * 按真实格式写字节的层（LayerWriter）。每个函数返回一层，wire() 把几层拼成一个事件的解码结构。
 * 字节全部来自 core/ 的真实计算：浮点来自 IEEE 754 位模式（@explorer/llm-core/float），JSON 来自 encodeJson，HTTP 来自 encodeRequest / encodeResponse。
 *
 * httpHead、jsonBody、utf8Lines、tokenIds 和 CONTEXT EXPLORER 的同名函数写法相同，utf8Text、floatVector 和 LLM EXPLORER 的同名函数写法相同
 * （各模块的写字节层各自一份，配色和说明文字按本站改）。
 */
import { f16Bits, f16FromBits, f32Bits } from '@explorer/llm-core/float';
import { childrenOf, spanOf, type JsonBytes, type JsonSpan } from '@explorer/llm-core/json';
import type { HttpLayout } from '@explorer/llm-core/http';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { hex2, utf8Chars, utf8Decode, utf8Encode, utf8Kind } from '@explorer/llm-core/utf8';
import type { Chunk } from '../core/chunk';
import type { PqCodebook } from '../core/pq';
import type { RagPrompt } from '../core/rag';
import type { Int8Vector } from '../core/vector';
import type { Color } from '../lessons/types';
import { hex, LayerWriter, type Fidelity, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 数值的展示：最多 4 位小数，去掉末尾的 0，负号用 −；很小或很大的数用科学计数法。 */
export function num(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '−∞' : 'NaN';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 10 ** -digits || abs >= 1e6) return value.toExponential(2).replace(/-/g, '−');
  return String(+value.toFixed(digits)).replace(/-/g, '−');
}

/** 千分位。 */
export const thousands = (value: number): string => value.toLocaleString('en-US');

/** 字符串值的预览：太长时截断，换行写成 ↵。 */
export function preview(text: string, max = 28): string {
  const flat = text.replace(/\r\n/g, '␍↵').replace(/\n/g, '↵').replace(/\r/g, '␍');
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
}

// ---------- 文本 ----------

const KIND_NOTE: Record<ReturnType<typeof utf8Kind>, string> = {
  ascii: '单字节字符（0xxxxxxx），和 ASCII 相同。',
  lead2: '2 字节字符的首字节（110xxxxx）。',
  lead3: '3 字节字符的首字节（1110xxxx），常用汉字都在这里。',
  lead4: '4 字节字符的首字节（11110xxx），比如 emoji。',
  cont: '续字节（10xxxxxx），只带 6 位数据。',
  invalid: '不是合法的 UTF-8 字节。',
};

/** 一段文本的 UTF-8 字节：每个字符一个字段，多字节字符再按字节拆成子字段。 */
export function utf8Text(name: string, text: string, options: { color?: Color; summary?: string; notes?: Record<number, string> } = {}): LayerWriter {
  const chars = utf8Chars(text);
  const total = chars.reduce((sum, item) => sum + item.bytes.length, 0);
  const layer = makeLayer(`${name} · ${total} 字节`, options.color ?? 'blue', options.summary ?? `${chars.length} 个字符，UTF-8 编码`);
  let at = 0;
  chars.forEach(({ char, bytes }, index) => {
    const shown = char === ' ' ? '空格' : char === '\n' ? '换行' : char;
    const cp = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
    layer.field(`'${shown}' · +${at}`, `${cp}，${bytes.length} 字节`, () => layer.raw(bytes), {
      note: options.notes?.[index] ?? (bytes.length === 1 ? KIND_NOTE.ascii : `${bytes.map(hex2).join(' ')}：首字节说明长度，后面 ${bytes.length - 1} 个是续字节。`),
    });
    if (bytes.length > 1) bytes.forEach((byte, i) => layer.over(hex2(byte), utf8Kind(byte) === 'cont' ? '续字节' : '首字节', at + i, at + i + 1, { note: KIND_NOTE[utf8Kind(byte)] }));
    at += bytes.length;
  });
  return layer;
}

/** 一段 UTF-8 文本，每行一个字段（行尾的换行算在这一行里）。 */
export function utf8Lines(name: string, text: string, options: { color?: Color; summary?: string; notes?: Record<number, string> } = {}): LayerWriter {
  const bytes = utf8Encode(text);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'blue', options.summary ?? 'UTF-8 编码');
  text.split(/(?<=\n)/).forEach((line, index) => {
    layer.field(preview(line, 30) || '空行', `${utf8Encode(line).length} 字节`, () => layer.raw(utf8Encode(line)), { note: options.notes?.[index] });
  });
  return layer;
}

/**
 * 一篇文档和它的切块：整篇的 UTF-8 字节是一个字段，每一块是缩进一级的子字段（块可以互相重叠）。
 * 值写这一块的字符数和 token 数，说明里写重叠了多少字符。
 */
export function chunkBytes(name: string, text: string, chunks: readonly Chunk[], options: { color?: Color; summary?: string } = {}): LayerWriter {
  const bytes = utf8Encode(text);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'blue', options.summary ?? `${[...text].length} 个字符，切成 ${chunks.length} 块`);
  layer.field('全文', `${[...text].length} 个字符`, () => layer.raw(bytes));
  for (const chunk of chunks) {
    layer.over(`块 ${chunk.index} · +${chunk.byteFrom}`, `${chunk.to - chunk.from} 字 · ${chunk.tokens} token`, chunk.byteFrom, chunk.byteTo, {
      note: `字符 [${chunk.from}, ${chunk.to})，字节 [${chunk.byteFrom}, ${chunk.byteTo})。${chunk.overlap ? `和上一块重叠 ${chunk.overlap} 个字符。` : ''}「${preview(chunk.text, 24)}」`,
    });
  }
  return layer;
}

/** token id 数组：int32 小端，每个 4 字节（llama.cpp 的 llama_token 是 int32_t）。值写 id 和它的展示文字。 */
export function tokenIds(name: string, ids: readonly number[], options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`int32 ${name}[${ids.length}] · ${ids.length * 4} 字节`, options.color ?? 'violet', options.summary ?? '小端：低位字节在前');
  ids.forEach((id, index) => layer.field(`${name}[${index}] · +${index * 4}`, `${id}（${TOKENIZER.label(id)}）`, () => layer.u32(id), { note: `token id ${id} = ${hex(id, 8)}。` }));
  return layer;
}

// ---------- 向量 ----------

export type FloatFormat = 'f32' | 'f16';

const FLOAT_BYTES: Record<FloatFormat, number> = { f32: 4, f16: 2 };
const FLOAT_NAME: Record<FloatFormat, string> = { f32: 'float32', f16: 'float16' };

function floatBits(format: FloatFormat, value: number): { bits: number; stored: number } {
  if (format === 'f32') return { bits: f32Bits(value), stored: Math.fround(value) };
  const bits = f16Bits(value);
  return { bits, stored: f16FromBits(bits) };
}

export interface FloatOptions {
  color?: Color;
  summary?: string;
  /** 每个元素的名字，默认是 name[i]。 */
  names?: (index: number) => string;
  notes?: Record<number, string>;
  /** 把每个数登记成可按位展示的字（符号、指数、尾数）。 */
  bits?: boolean;
  /** 显示用的小数位数。 */
  digits?: number;
}

/** 浮点向量：float32 / float16，小端。显示的是存进去之后的值（含舍入）。 */
export function floatVector(name: string, values: readonly number[], format: FloatFormat = 'f32', options: FloatOptions = {}): LayerWriter {
  const size = FLOAT_BYTES[format];
  const layer = makeLayer(`${FLOAT_NAME[format]} ${name}[${values.length}] · ${values.length * size} 字节`, options.color ?? 'blue', options.summary ?? '小端：低位字节在前');
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
      layer.over('值', num(stored, options.digits ?? 6), layer.length - size, layer.length);
    } else {
      layer.field(label, num(stored, options.digits ?? 4), () => layer.raw(Array.from({ length: size }, (_, i) => (bits >>> (i * 8)) & 0xff)), { note });
    }
  });
  return layer;
}

/** int8 量化的向量：先是 float32 的缩放系数，再是每个分量一个 int8（补码）。这种摆法是本站的（internal）。 */
export function int8Vector(name: string, q: Int8Vector, options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`int8 ${name}[${q.codes.length}] + scale · ${4 + q.codes.length} 字节`, options.color ?? 'amber', options.summary ?? '值 ≈ code × scale');
  layer.field('scale · +0', num(q.scale, 6), () => layer.raw(Array.from({ length: 4 }, (_, i) => (f32Bits(q.scale) >>> (i * 8)) & 0xff)), { note: `float32 缩放系数 = 最大绝对值 / 127，位模式 ${hex(f32Bits(q.scale), 8)}。` });
  q.codes.forEach((code, index) => layer.field(`${name}[${index}] · +${4 + index}`, String(code), () => layer.u8(code & 0xff), { note: `int8 补码 ${hex2(code & 0xff)}，还原为 ${num(code * q.scale, 5)}。` }));
  return layer;
}

/** PQ 码：M 个 uint8，每个是对应子空间里最近的子质心编号。 */
export function pqCodes(name: string, codes: readonly number[], cb?: PqCodebook, options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`uint8 ${name}[${codes.length}] · ${codes.length} 字节`, options.color ?? 'teal', options.summary ?? (cb ? `${cb.m} 个子空间，每个 ${cb.ksub} 个子质心` : 'PQ 码'));
  codes.forEach((code, j) => layer.field(`${name}[${j}] · +${j}`, String(code), () => layer.u8(code), { note: cb ? `第 ${j} 段（维度 ${j * cb.dsub}–${(j + 1) * cb.dsub - 1}）最近的是 ${code} 号子质心。` : undefined }));
  return layer;
}

/**
 * base64 文本（RFC 4648）：每 4 个字符是一个字段，对应原来的 3 个字节，值写这 3 个字节的十六进制。
 * 这一层的字节是 base64 字符本身（ASCII），也就是 JSON 里那个字符串的内容。
 */
export function base64Text(name: string, text: string, source: readonly number[], options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${text.length} 字节`, options.color ?? 'teal', options.summary ?? `每 4 个字符编码 3 个字节，共 ${source.length} 字节`);
  for (let i = 0; i < text.length; i += 4) {
    const group = text.slice(i, i + 4);
    const raw = source.slice((i / 4) * 3, (i / 4) * 3 + 3);
    layer.field(`${group} · +${i}`, raw.map(hex2).join(' '), () => layer.ascii(group), { note: `第 ${(i / 4) * 3}–${(i / 4) * 3 + raw.length - 1} 个字节。${group.includes('=') ? '末尾的 = 是填充。' : ''}` });
  }
  return layer;
}

// ---------- HTTP 和 JSON ----------

export interface HttpHeadOptions {
  color?: Color;
  summary?: string;
  /** 打码的头：值里保留前几个字节，其余显示为 ··（字节数不变）。 */
  mask?: Record<string, number>;
  notes?: Record<string, string>;
  example?: string[];
  startNote?: string;
}

/** HTTP 报文的头部：起始行、每个头字段（含 CRLF）、结束的空行。 */
export function httpHead(name: string, layout: HttpLayout, options: HttpHeadOptions = {}): LayerWriter {
  const head = layout.bytes.slice(0, layout.body[0]);
  const layer = makeLayer(`${name} · ${head.length} 字节`, options.color ?? 'slate', options.summary ?? `${layout.headers.length} 个头字段，每行以 CRLF（0D 0A）结尾`);
  const line = String.fromCharCode(...layout.bytes.slice(layout.startLine[0], layout.startLine[1] - 2));
  layer.field(line, '起始行', () => layer.raw(layout.bytes.slice(...layout.startLine)), { note: options.startNote, mono: true });
  for (const header of layout.headers) {
    const key = header.name.toLowerCase();
    const keep = options.mask?.[key];
    const bytes = layout.bytes.slice(header.from, header.to);
    const valueAt = header.valueFrom - header.from;
    const valueLength = header.to - header.valueFrom - 2;
    const shown = keep === undefined ? header.value : `${header.value.slice(0, keep)}${'·'.repeat(Math.min(6, valueLength - keep))}`;
    layer.field(header.name, shown, () => {
      if (keep === undefined) layer.raw(bytes);
      else {
        layer.raw(bytes.slice(0, valueAt + keep));
        layer.unknown(valueLength - keep);
        layer.raw(bytes.slice(valueAt + valueLength));
      }
    }, { note: options.notes?.[key] ?? (keep !== undefined ? `密钥打码：共 ${valueLength} 个字符，只显示前 ${keep} 个。` : undefined), example: options.example?.includes(key) || undefined, hidden: keep !== undefined || undefined });
  }
  layer.field('CRLF', '空行：头部结束', () => layer.raw(layout.bytes.slice(...layout.blank)), { note: '一个单独的 CRLF。之后是消息体，长度由 content-length 给出。' });
  return layer;
}

export interface JsonOptions {
  color?: Color;
  summary?: string;
  /** 作为顶层字段列出的是哪个值的子节点，默认是根（''）。 */
  root?: string;
  /** 另外展开成子字段（缩进一级）的路径。 */
  expand?: string[];
  notes?: Record<string, string>;
  /** 值是示例的路径，界面显示 E.G.。 */
  example?: string[];
  shown?: Record<string, string>;
}

function valueText(json: JsonBytes, span: JsonSpan): string {
  const text = utf8Decode(json.bytes.slice(span.valueFrom, span.to));
  if (span.kind === 'string') return preview(JSON.parse(text) as string);
  if (span.kind === 'object') return `{…} ${span.to - span.valueFrom} 字节`;
  if (span.kind === 'array') return `[${childrenOf(json, span.path).length} 项] ${span.to - span.valueFrom} 字节`;
  return text;
}

const lastKey = (path: string) => path.replace(/^.*?([^.]+)$/, '$1');

/** JSON 的字节：root 的每个直接子节点是一个字段（从键的引号到值的末尾），expand 里的路径再作为缩进一级的子字段。 */
export function jsonBody(name: string, json: JsonBytes, options: JsonOptions = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${json.bytes.length} 字节`, options.color ?? 'blue', options.summary ?? 'UTF-8 编码的 JSON');
  const rootSpan = spanOf(json, options.root ?? '');
  layer.raw(json.bytes.slice(0, rootSpan.valueFrom + 1));
  const opts = (path: string) => ({ note: options.notes?.[path], example: options.example?.includes(path) || undefined });
  let at = rootSpan.valueFrom + 1;
  for (const child of childrenOf(json, rootSpan.path)) {
    layer.raw(json.bytes.slice(at, child.from));
    layer.field(lastKey(child.path), options.shown?.[child.path] ?? valueText(json, child), () => layer.raw(json.bytes.slice(child.from, child.to)), opts(child.path));
    at = child.to;
  }
  layer.raw(json.bytes.slice(at));
  for (const path of options.expand ?? []) {
    const span = spanOf(json, path);
    layer.over(path, options.shown?.[path] ?? valueText(json, span), span.from, span.to, opts(path));
  }
  layer.fields.sort((a, b) => a.from - b.from || b.to - a.to || (a.depth ?? 0) - (b.depth ?? 0));
  return layer;
}

// ---------- 提示 ----------

const PART_NAME = { instruction: '说明', source: '资料', question: '问题', separator: '分隔' } as const;

/** 拼好的 RAG 提示：每部分（说明、每条资料、问题、分隔的换行）一个字段，值是 token 数。 */
export function promptParts(name: string, prompt: RagPrompt, options: { color?: Color; summary?: string; notes?: Record<string, string> } = {}): LayerWriter {
  const bytes = utf8Encode(prompt.text);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'violet', options.summary ?? `共 ${prompt.tokens} 个 token（本站 BPE）`);
  for (const part of prompt.parts) {
    const label = part.kind === 'source' ? `[${part.n}] ${preview(part.text.replace(/^\[\d+\]\s*/, ''), 14)}` : part.kind === 'separator' ? preview(part.text) : preview(part.text, 16);
    layer.field(label, `${part.tokens} token · ${PART_NAME[part.kind]}`, () => layer.raw(utf8Encode(part.text)), { note: options.notes?.[part.kind === 'source' ? `[${part.n}]` : part.kind] });
  }
  return layer;
}

/**
 * 一批向量连续存放（float32 小端，一个接一个，没有分隔）：每个向量一个字段，值写它的标签。
 * 这是 FAISS IndexFlat 一类「平铺」存储的样子（internal）；ingest 课写入向量库时用。
 */
export function vectorRows(name: string, labels: readonly string[], vectors: readonly (readonly number[])[], options: { color?: Color; summary?: string; notes?: Record<number, string> } = {}): LayerWriter {
  const dim = vectors[0]?.length ?? 0;
  const layer = makeLayer(`float32 ${name}[${vectors.length}][${dim}] · ${vectors.length * dim * 4} 字节`, options.color ?? 'violet', options.summary ?? `${vectors.length} 个向量，每个 ${dim} × 4 = ${dim * 4} 字节，小端`);
  vectors.forEach((v, i) => {
    const bytes = v.flatMap((x) => { const bits = f32Bits(x); return [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]; });
    layer.field(`${labels[i]} · +${i * dim * 4}`, `${dim} 个 float32`, () => layer.raw(bytes), { note: options.notes?.[i] ?? `前 3 维：${v.slice(0, 3).map((x) => num(x, 3)).join('、')}……` });
  });
  return layer;
}

// ---------- 概念 ----------

/** 概念结构：只有字段，没有字节。配合 fidelity '示意'。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}
