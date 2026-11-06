/**
 * 按真实格式写字节的层（LayerWriter）。每个函数返回一层，wire() 把几层拼成一个事件的解码结构。
 * 字节全部来自 core/ 的真实编码：HTTP 报文来自 encodeRequest / encodeResponse，JSON 来自 encodeJson，SSE 来自 encodeStream，
 * stdio 的行来自 encodeLine。
 *
 * httpHead、jsonBody、sseBody、utf8Lines、promptPieces、concept 和 CONTEXT EXPLORER 的同名函数写法相同（各模块的写字节层各自一份，
 * 这是系列的约定），stdioLines、rpcMessage 是本站加的。
 */
import { childrenOf, spanOf, type JsonBytes, type JsonSpan } from '@explorer/llm-core/json';
import type { HttpLayout } from '@explorer/llm-core/http';
import type { FrameSpan } from '@explorer/llm-core/sse';
import type { RenderedPrompt } from '@explorer/llm-core/template';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import type { LineSpan } from '../core/mcp/stdio';
import type { Color } from '../lessons/types';
import { LayerWriter, type Fidelity, type Wire } from './writer';

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

// ---------- JSON ----------

export interface JsonOptions {
  color?: Color;
  summary?: string;
  /** 作为顶层字段列出的是哪个值的子节点，默认是根（''）。 */
  root?: string;
  /** 另外展开成子字段（缩进一级）的路径。 */
  expand?: string[];
  notes?: Record<string, string>;
  /** 值是示例（每次都不同，或是模型写的）的路径，界面显示 E.G.。 */
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
/** 成员的键：从字节里读（MCP 的 _meta 键 io.modelcontextprotocol/… 本身带点，不能从路径切）；数组元素没有键，用路径的最后一段。 */
const keyOf = (json: JsonBytes, span: JsonSpan): string => (span.from < span.valueFrom ? (JSON.parse(utf8Decode(json.bytes.slice(span.from, span.valueFrom)).replace(/:\s*$/, '')) as string) : lastKey(span.path));

/** JSON 的字节：root 的每个直接子节点是一个字段（从键的引号到值的末尾），expand 里的路径再作为缩进一级的子字段。 */
export function jsonBody(name: string, json: JsonBytes, options: JsonOptions = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${json.bytes.length} 字节`, options.color ?? 'blue', options.summary ?? 'UTF-8 编码的 JSON');
  const rootSpan = spanOf(json, options.root ?? '');
  layer.raw(json.bytes.slice(0, rootSpan.valueFrom + 1));
  const opts = (path: string) => ({ note: options.notes?.[path], example: options.example?.includes(path) || undefined });
  let at = rootSpan.valueFrom + 1;
  for (const child of childrenOf(json, rootSpan.path)) {
    layer.raw(json.bytes.slice(at, child.from));
    layer.field(keyOf(json, child), options.shown?.[child.path] ?? valueText(json, child), () => layer.raw(json.bytes.slice(child.from, child.to)), opts(child.path));
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
  notes?: Record<number, string>;
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

// ---------- stdio ----------

/** stdio 上的一段字节流：每行（一条 JSON-RPC 消息加行尾的 0x0A）一个字段，行尾的换行是子字段。 */
export function stdioLines(name: string, bytes: readonly number[], lines: readonly LineSpan[], options: { color?: Color; summary?: string; shown?: Record<number, string>; notes?: Record<number, string> } = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'teal', options.summary ?? `${lines.length} 行，每行一条 JSON-RPC 消息，以 0A 结尾`);
  lines.forEach((line, index) => {
    layer.field(`第 ${index + 1} 行 · +${line.from}`, options.shown?.[index] ?? preview(line.text, 30), () => layer.raw(bytes.slice(line.from, line.to)), { note: options.notes?.[index] });
    const end = layer.length;
    layer.over('LF', '0A：一条消息结束', end - 1, end, { note: '换行只出现在消息之间。JSON 字符串里的换行写成 \\n 两个字符，所以紧凑 JSON 本身没有换行。' });
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
 * 特殊 token 在模型里只是一个 id，这里写它的字面文字，所以这一层是 internal。
 */
export function promptPieces(name: string, prompt: RenderedPrompt, options: { color?: Color; summary?: string; notes?: Record<string, string> } = {}): LayerWriter {
  const layer = makeLayer(`${name} · ${prompt.bytes.length} 字节`, options.color ?? 'violet', options.summary ?? `ChatML 展开，共 ${prompt.tokens} 个 token`);
  for (const piece of prompt.pieces) {
    const label = piece.kind === 'content' ? piece.source! : `${preview(piece.text, 16)}`;
    layer.field(label, `${piece.tokens} token · ${PIECE_NAME[piece.kind]}`, () => layer.raw(prompt.bytes.slice(piece.from, piece.to)), { note: options.notes?.[piece.source ?? piece.text] });
  }
  return layer;
}

// ---------- 概念 ----------

/** 概念结构：只有字段，没有字节。配合 fidelity '示意'，或者给有字节的事件补一层说明。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}
