/**
 * 按真实格式写字节的层（LayerWriter）。每个函数返回一层，wire() 把几层拼成一个事件的解码结构。
 * 字节全部来自 core/ 的真实编码：HTTP 报文来自 encodeRequest / encodeResponse，JSON 来自 encodeJson，文字是 UTF-8。
 *
 * httpHead、jsonBody、utf8Lines、concept 和 CONTEXT、AGENT EXPLORER 的同名函数写法相同（各模块的写字节层各自一份，
 * 这是系列的约定）；textSpans（一段文字按命中区间切开）、gramBytes（分类器的 n-gram 和桶）、traceparentField 是本站加的。
 */
import { childrenOf, spanOf, type JsonBytes, type JsonSpan } from '@explorer/llm-core/json';
import type { HttpLayout } from '@explorer/llm-core/http';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import { TRACEPARENT_LAYOUT, type Contribution } from '../core';
import type { Color } from '../lessons/types';
import { LayerWriter, type Fidelity, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 数值的展示：千分位用逗号，和 API 文档的写法一致。和 value.toLocaleString('en-US') 相同，只是格式器建一次（每次新建很慢）。 */
const EN_US = new Intl.NumberFormat('en-US');
export const num = (value: number): string => EN_US.format(value);

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

// ---------- 概念 ----------

/** 概念结构：只有字段，没有字节。配合 fidelity '示意'，或者给有字节的事件补一层说明。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}

// ---------- 本站加的 ----------

/** UTF-16 下标 → UTF-8 字节偏移。 */
export const byteOffset = (text: string, index: number): number => utf8Encode(text.slice(0, index)).length;

export interface Segment {
  /** UTF-16 下标 [from, to)。 */
  from: number;
  to: number;
  text: string;
  /** 命中的标签（规则 id、PII 类型）；没命中是 null。 */
  hit: string | null;
}

/** 按命中区间把文字切成首尾相接的片段：命中的片段带 hit，其余是 null。区间重叠时合并，标签用顿号连起来。 */
export function segmentsOf(text: string, spans: ReadonlyArray<{ from: number; to: number; label: string }>): Segment[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Array<{ from: number; to: number; label: string }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from < last.to) {
      last.to = Math.max(last.to, span.to);
      if (!last.label.split('、').includes(span.label)) last.label += `、${span.label}`;
    } else merged.push({ ...span });
  }
  const out: Segment[] = [];
  let at = 0;
  for (const span of merged) {
    if (span.from > at) out.push({ from: at, to: span.from, text: text.slice(at, span.from), hit: null });
    out.push({ from: span.from, to: span.to, text: text.slice(span.from, span.to), hit: span.label });
    at = span.to;
  }
  if (at < text.length) out.push({ from: at, to: text.length, text: text.slice(at), hit: null });
  return out;
}

/** 一段文字的 UTF-8 字节，按片段一个字段：命中的片段字段名写标签，其余写「其余」。 */
export function textSpans(name: string, text: string, segments: readonly Segment[], options: { color?: Color; summary?: string; notes?: Record<string, string> } = {}): LayerWriter {
  const bytes = utf8Encode(text);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, options.color ?? 'blue', options.summary ?? 'UTF-8 编码');
  for (const seg of segments) {
    const piece = utf8Encode(seg.text);
    layer.field(seg.hit ?? '其余', `${preview(seg.text, 20)} · ${piece.length} 字节`, () => layer.raw(piece), { note: seg.hit ? options.notes?.[seg.hit] : undefined });
  }
  return layer;
}

/** 分类器看到的片段：每个片段的 UTF-8 字节一个字段，值写落进哪个桶、对 logit 贡献多少。 */
export function gramBytes(name: string, contributions: readonly Contribution[], options: { color?: Color; summary?: string } = {}): LayerWriter {
  const total = contributions.reduce((acc, c) => acc + utf8Encode(c.grams[0]).length, 0);
  const layer = makeLayer(`${name} · ${total} 字节`, options.color ?? 'violet', options.summary ?? '每个片段的 UTF-8 字节过 32 位 FNV-1a，对桶数取余得到桶号');
  for (const c of contributions) {
    const gram = c.grams[0];
    const others = c.grams.length > 1 ? `（同桶还有 ${c.grams.slice(1).join('、')}）` : '';
    layer.field(gram, `桶 ${c.bucket} · ${c.amount >= 0 ? '+' : ''}${c.amount.toFixed(2)}`, () => layer.raw(utf8Encode(gram)), { note: `权重 ${c.weight.toFixed(2)} × 特征值，正数把分数往「注入」推${others}。`, mono: true });
  }
  return layer;
}

/** traceparent 头的值：55 个 ASCII 字符，按 version、trace-id、parent-id、trace-flags 切开。 */
export function traceparentField(name: string, value: string, notes: Partial<Record<(typeof TRACEPARENT_LAYOUT)[number]['name'], string>> = {}): LayerWriter {
  const bytes = utf8Encode(value);
  const layer = makeLayer(`${name} · ${bytes.length} 字节`, 'teal', 'W3C Trace Context：version-trace-id-parent-id-trace-flags，小写十六进制');
  for (const part of TRACEPARENT_LAYOUT) {
    layer.field(part.name === '-' ? '-' : part.name, value.slice(part.from, part.to), () => layer.raw(bytes.slice(part.from, part.to)), { note: notes[part.name], mono: true });
  }
  return layer;
}
