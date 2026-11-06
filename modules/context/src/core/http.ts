/**
 * HTTP/1.1 报文（RFC 9112）：请求行或状态行、头字段、空行、消息体，行尾一律 CRLF。
 * Content-Length 按消息体的真实字节数计算（RFC 9110 §8.6），chunked 分块按 RFC 9112 §7.1 编码。
 *
 * 真实的 SDK 可能走 HTTP/2（语义相同，分帧不同，头名一律小写）。本站统一按 HTTP/1.1 展示，因为它的字节是可读的文本。
 */
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';

export type Header = [name: string, value: string];

export interface HttpRequest {
  method: string;
  /** 请求目标，比如 /v1/messages。 */
  target: string;
  headers: Header[];
  body: number[];
}

export interface HttpResponse {
  status: number;
  /** 原因短语可以为空（RFC 9112 §4），客户端必须忽略它。 */
  reason: string;
  headers: Header[];
  body: number[];
}

/** 一行头字段在报文里的区间，含行尾的 CRLF。 */
export interface HeaderSpan {
  name: string;
  value: string;
  from: number;
  /** 值开始的字节（冒号和一个空格之后）。 */
  valueFrom: number;
  to: number;
}

/** 报文的字节和各部分的区间。区间都是 [from, to)。 */
export interface HttpLayout {
  bytes: number[];
  startLine: [number, number];
  headers: HeaderSpan[];
  /** 头部结束的空行（CRLF）。 */
  blank: [number, number];
  body: [number, number];
}

/** RFC 9110 / RFC 6585 的原因短语。529 不是标准状态码，没有登记的短语。 */
export const REASONS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  529: '',
};

const CRLF = '\r\n';
const toBytes = (body: number[] | string): number[] => (typeof body === 'string' ? utf8Encode(body) : body.slice());

/** 头字段名不区分大小写（RFC 9110 §5.1）。 */
export const headerOf = (headers: readonly Header[], name: string): string | undefined => headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** 拼一个请求。body 非空时在最后补上 content-length。 */
export function makeRequest(method: string, target: string, headers: Header[], body: number[] | string = []): HttpRequest {
  const bytes = toBytes(body);
  const all: Header[] = headers.filter(([name]) => name.toLowerCase() !== 'content-length');
  if (bytes.length || method === 'POST') all.push(['content-length', String(bytes.length)]);
  return { method, target, headers: all, body: bytes };
}

/** 拼一个响应。没有 transfer-encoding 时补上 content-length。 */
export function makeResponse(status: number, headers: Header[], body: number[] | string = []): HttpResponse {
  const bytes = toBytes(body);
  const all: Header[] = headers.filter(([name]) => name.toLowerCase() !== 'content-length');
  if (!headerOf(all, 'transfer-encoding')) all.push(['content-length', String(bytes.length)]);
  return { status, reason: REASONS[status] ?? '', headers: all, body: bytes };
}

function layout(startLine: string, headers: readonly Header[], body: readonly number[]): HttpLayout {
  const bytes: number[] = [];
  const push = (text: string) => bytes.push(...utf8Encode(text));
  push(startLine + CRLF);
  const start: [number, number] = [0, bytes.length];
  const spans: HeaderSpan[] = [];
  for (const [name, value] of headers) {
    if (/[\r\n]/.test(name + value)) throw new Error(`头字段里不能有换行：${name}`);
    const from = bytes.length;
    push(`${name}: `);
    const valueFrom = bytes.length;
    push(value + CRLF);
    spans.push({ name, value, from, valueFrom, to: bytes.length });
  }
  const blankFrom = bytes.length;
  push(CRLF);
  const bodyFrom = bytes.length;
  bytes.push(...body);
  return { bytes, startLine: start, headers: spans, blank: [blankFrom, bodyFrom], body: [bodyFrom, bytes.length] };
}

/** 请求的字节：`POST /v1/messages HTTP/1.1`、头、空行、消息体。 */
export const encodeRequest = (req: HttpRequest): HttpLayout => layout(`${req.method} ${req.target} HTTP/1.1`, req.headers, req.body);

/** 响应的字节：`HTTP/1.1 200 OK`、头、空行、消息体。原因短语为空时状态码后面仍有一个空格。 */
export const encodeResponse = (res: HttpResponse): HttpLayout => layout(`HTTP/1.1 ${res.status} ${res.reason}`, res.headers, res.body);

export interface ParsedMessage {
  startLine: string;
  headers: Header[];
  body: number[];
}

/**
 * 解析一段完整的报文（只认 CRLF 行尾）。有 content-length 就按它截消息体，有 chunked 就拼回分块。
 * 用来核对：编码之后再解析，得到的头和消息体与原来一致。
 */
export function parseMessage(bytes: readonly number[]): ParsedMessage {
  let at = 0;
  const line = (): string => {
    for (let i = at; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
        const text = utf8Decode(bytes.slice(at, i));
        at = i + 2;
        return text;
      }
    }
    throw new Error('报文不完整：找不到 CRLF');
  };
  const startLine = line();
  const headers: Header[] = [];
  for (let text = line(); text !== ''; text = line()) {
    const colon = text.indexOf(':');
    if (colon <= 0) throw new Error(`头字段格式不对：${text}`);
    headers.push([text.slice(0, colon), text.slice(colon + 1).trim()]);
  }
  const rest = bytes.slice(at);
  const length = headerOf(headers, 'content-length');
  if (length !== undefined) {
    const n = Number(length);
    if (rest.length < n) throw new Error(`消息体只有 ${rest.length} 字节，content-length 是 ${n}`);
    return { startLine, headers, body: rest.slice(0, n) };
  }
  if (headerOf(headers, 'transfer-encoding')?.toLowerCase() === 'chunked') return { startLine, headers, body: dechunk(rest) };
  return { startLine, headers, body: rest };
}

/** 一个分块在 chunked 消息体里的区间。 */
export interface ChunkSpan {
  /** 分块长度那一行（十六进制 + CRLF）。 */
  size: [number, number];
  data: [number, number];
  /** 数据后面的 CRLF。 */
  end: [number, number];
}

/** chunked 编码：每块是「十六进制长度 CRLF 数据 CRLF」，最后是长度为 0 的块和一个空行。 */
export function chunked(pieces: ReadonlyArray<readonly number[]>): { bytes: number[]; chunks: ChunkSpan[]; last: [number, number] } {
  const bytes: number[] = [];
  const chunks: ChunkSpan[] = [];
  for (const piece of pieces) {
    if (!piece.length) continue;
    const from = bytes.length;
    bytes.push(...utf8Encode(piece.length.toString(16) + CRLF));
    const dataFrom = bytes.length;
    bytes.push(...piece);
    const dataTo = bytes.length;
    bytes.push(0x0d, 0x0a);
    chunks.push({ size: [from, dataFrom], data: [dataFrom, dataTo], end: [dataTo, bytes.length] });
  }
  const lastFrom = bytes.length;
  bytes.push(...utf8Encode(`0${CRLF}${CRLF}`));
  return { bytes, chunks, last: [lastFrom, bytes.length] };
}

/** chunked 解码。 */
export function dechunk(bytes: readonly number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (;;) {
    let end = at;
    while (end + 1 < bytes.length && !(bytes[end] === 0x0d && bytes[end + 1] === 0x0a)) end++;
    if (end + 1 >= bytes.length) throw new Error('chunked 消息体不完整');
    const size = parseInt(utf8Decode(bytes.slice(at, end)).split(';')[0], 16);
    if (!Number.isFinite(size)) throw new Error('分块长度不是十六进制');
    at = end + 2;
    if (size === 0) return out;
    out.push(...bytes.slice(at, at + size));
    at += size + 2;
  }
}
