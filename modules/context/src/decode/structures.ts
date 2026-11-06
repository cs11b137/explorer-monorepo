/**
 * 按真实格式写字节的层（LayerWriter）。每个函数返回一层，wire() 把几层拼成一个事件的解码结构。
 * 字节全部来自 core/ 的真实编码：HTTP 报文来自 encodeRequest / encodeResponse，JSON 来自 encodeJson，SSE 来自 encodeStream。
 */
import { hex2, utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import type { HttpLayout } from '../core/http';
import { childrenOf, spanOf, type JsonBytes, type JsonSpan } from '../core/json';
import type { FrameSpan } from '../core/sse';
import type { RenderedPrompt } from '../core/template';
import { tokenLabel } from '../core/tokens';
import type { Color } from '../lessons/types';
import { hex, LayerWriter, type Fidelity, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 数值的展示：千分位用逗号，和 API 文档的写法一致。 */
export const num = (value: number): string => value.toLocaleString('en-US');

/** 字符串值的预览：太长时截断，换行写成 ↵。 */
export function preview(text: string, max = 28): string {
  const flat = text.replace(/\r\n/g, '␍↵').replace(/\n/g, '↵').replace(/\r/g, '␍');
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
}

// ---------- HTTP ----------

export interface HttpHeadOptions {
  color?: Color;
  summary?: string;
  /** 打码的头：值里保留前几个字节，其余显示为 ··（字节数不变）。 */
  mask?: Record<string, number>;
  /** 每个头的说明，键是头名（小写）。 */
  notes?: Record<string, string>;
  /** 值是示例（每次都不同）的头，界面显示 E.G.。 */
  example?: string[];
  /** 起始行的说明。 */
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
    layer.field(`${header.name}`, shown, () => {
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

// ---------- JSON ----------

export interface JsonOptions {
  color?: Color;
  summary?: string;
  /** 作为顶层字段列出的是哪个值的子节点，默认是根（''）。 */
  root?: string;
  /** 另外展开成子字段（缩进一级）的路径。 */
  expand?: string[];
  /** 每个路径的说明。 */
  notes?: Record<string, string>;
  /** 值是示例（每次都不同，或是模型写的）的路径，界面显示 E.G.。 */
  example?: string[];
  /** 自定义值的显示。 */
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

/**
 * JSON 的字节：root 的每个直接子节点是一个字段（从键的引号到值的末尾），
 * expand 里的路径再作为缩进一级的子字段列出。没有被任何字段覆盖的字节（大括号、逗号）照样在 hex 里。
 */
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
  // 子字段要排在父字段后面才能正确缩进：按起点排序，同起点时长的在前。
  layer.fields.sort((a, b) => a.from - b.from || b.to - a.to || (a.depth ?? 0) - (b.depth ?? 0));
  return layer;
}

// ---------- SSE ----------

export interface SseOptions {
  color?: Color;
  summary?: string;
  /** 每个事件的说明，按事件下标。 */
  notes?: Record<number, string>;
  /** 每个事件字段的显示值，按事件下标。 */
  shown?: Record<number, string>;
}

/** 一段 SSE 流：每个事件一个字段，事件里的每一行（event、data、空行）是子字段。 */
export function sseBody(name: string, stream: { bytes: number[]; spans: FrameSpan[] }, options: SseOptions = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${stream.bytes.length} 字节`, options.color ?? 'teal', options.summary ?? 'text/event-stream：每个事件以一个空行结束');
  stream.spans.forEach((frame, index) => {
    const eventLine = frame.lines.find((item) => item.field === 'event');
    const label = eventLine ? utf8Decode(stream.bytes.slice(eventLine.from + 7, eventLine.to - 1)) : frame.lines[0].field === ':' ? '注释' : 'data';
    layer.field(`${label} · +${frame.from}`, options.shown?.[index] ?? `${frame.to - frame.from} 字节`, () => layer.raw(stream.bytes.slice(frame.from, frame.to)), { note: options.notes?.[index] });
    for (const line of frame.lines) {
      const from = layer.length - (frame.to - line.from);
      const to = layer.length - (frame.to - line.to);
      layer.over(line.field ? `${line.field}:` : '空行', line.field ? preview(utf8Decode(stream.bytes.slice(line.from, line.to - 1)), 34) : 'LF：事件结束', from, to);
    }
  });
  return layer;
}

// ---------- 文本和 token ----------

/** 一段 UTF-8 文本，每行一个字段（行尾的换行算在这一行里）。 */
export function utf8Lines(name: string, text: string, options: { color?: Color; summary?: string; notes?: Record<number, string> } = {}): LayerWriter {
  const bytes = utf8Encode(text);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'blue', options.summary ?? 'UTF-8 编码');
  text.split(/(?<=\n)/).forEach((line, index) => {
    layer.field(preview(line, 30) || '空行', `${utf8Encode(line).length} 字节`, () => layer.raw(utf8Encode(line)), { note: options.notes?.[index] });
  });
  return layer;
}

const PIECE_NAME: Record<string, string> = { special: '特殊 token', header: '角色', content: '内容', separator: '分隔', prompt: '生成提示' };

/**
 * 展开后的提示：每一段（特殊 token、角色名、内容、分隔）一个字段，值是这一段的 token 数。
 * 字节是这段文本的 UTF-8；特殊 token 在模型里只是一个 id，这里写它的字面文字，所以这一层是 internal。
 */
export function promptPieces(name: string, prompt: RenderedPrompt, options: { color?: Color; summary?: string; notes?: Record<string, string> } = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${prompt.bytes.length} 字节`, options.color ?? 'violet', options.summary ?? `ChatML 展开，共 ${prompt.tokens} 个 token`);
  for (const piece of prompt.pieces) {
    const label = piece.kind === 'content' ? piece.source! : `${preview(piece.text, 16)}`;
    layer.field(label, `${piece.tokens} token · ${PIECE_NAME[piece.kind]}`, () => layer.raw(prompt.bytes.slice(piece.from, piece.to)), { note: options.notes?.[piece.source ?? piece.text] });
  }
  return layer;
}

/** token id 数组：int32 小端，每个 4 字节（llama.cpp 的 llama_token 是 int32_t）。 */
export function tokenIds(name: string, ids: readonly number[], options: { color?: Color; summary?: string } = {}): LayerWriter {
  const layer = makeLayer(`int32 ${name}[${ids.length}] · ${ids.length * 4} 字节`, options.color ?? 'violet', options.summary ?? '小端：低位字节在前');
  ids.forEach((id, index) => layer.field(`${name}[${index}] · +${index * 4}`, `${id}（${tokenLabel(id)}）`, () => layer.u32(id), { note: `token id ${id} = ${hex(id, 8)}。` }));
  return layer;
}

// ---------- TLS ----------

/** AEAD 认证标签的字节数（TLS 1.3 常用的 AES-GCM、ChaCha20-Poly1305 都是 16）。 */
export const TLS_TAG = 16;

/**
 * TLS 1.3 的一条应用数据记录（RFC 8446 §5.2）：类型 0x17、legacy_record_version 0x0303、2 字节长度，后面是密文。
 * 密文长度 = 明文 + 1 字节真实类型 + 16 字节认证标签（不加填充时）。密文内容每次都不同，显示为 ··。
 * 一条记录的明文最多 2^14 = 16384 字节，更长的报文要分成几条记录。
 */
export function tlsRecord(name: string, plaintext: number, options: { color?: Color; summary?: string } = {}): LayerWriter {
  const length = plaintext + 1 + TLS_TAG;
  if (plaintext > 16384) throw new Error('一条 TLS 记录的明文最多 16384 字节');
  const layer = makeLayer(`${name} · ${5 + length} 字节`, options.color ?? 'slate', options.summary ?? `明文 ${plaintext} 字节，加密后 ${length} 字节`);
  layer.field('type', '0x17 application_data', () => layer.u8(0x17), { note: 'TLS 1.3 加密后的记录对外一律写成 application_data，真实类型藏在密文里。' });
  layer.field('legacy_record_version', '0x0303', () => layer.be16(0x0303), { note: 'TLS 1.3 为了兼容中间设备固定写 0x0303（TLS 1.2 的编号）。' });
  layer.field('length', `${length}`, () => layer.be16(length), { note: `大端：${hex2(length >> 8)} ${hex2(length & 0xff)} = ${length} = 明文 ${plaintext} + 内容类型 1 + 认证标签 ${TLS_TAG}。` });
  layer.field('encrypted_record', `${length} 字节密文`, () => layer.unknown(length), { hidden: true, example: true, note: '密文：HTTP 报文、x-api-key 都在里面，路上的设备看不到。' });
  return layer;
}

/** 概念结构：只有字段，没有字节。配合 fidelity '示意'。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}
