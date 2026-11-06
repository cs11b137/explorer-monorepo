/**
 * 原在 CONTEXT EXPLORER 的 src/core/sse.ts（那里转导出，接口不变；AGENT EXPLORER 也用）。核对过的事实见 modules/context/README.md。
 *
 * Server-Sent Events（WHATWG HTML 标准 §9.2「Server-sent events」的 event stream 格式）。
 *
 * 编码：每个事件是若干行 `字段: 值`，以一个空行结束；data 里有换行时拆成多行 data。
 * 解析：严格按标准的「解释事件流」算法——
 *   - 字节流先按 UTF-8 解码（流式：一个汉字被拆在两个 TCP 块里也能拼回来），开头的 BOM 去掉；
 *   - 行尾可以是 CRLF、LF 或单独的 CR；
 *   - 空行派发事件；以冒号开头的行是注释，忽略；
 *   - 第一个冒号前是字段名，冒号后如果紧跟一个空格，去掉这一个空格；没有冒号时整行是字段名、值为空；
 *   - event 设事件类型，data 追加到数据缓冲并补一个换行，id 设最近的事件 id（含 NULL 时忽略），retry 只认纯数字；
 *   - 派发时数据缓冲为空就什么也不派发；去掉末尾那个换行；事件类型为空时是 message；
 *   - 流结束时没有以空行结尾的半个事件丢弃。
 * Anthropic 和 OpenAI 的流式响应都是这个格式（OpenAI Chat Completions 只用 data 行，并以 data: [DONE] 结束）。
 */
import { utf8Encode, Utf8Stream } from './utf8';

export interface SseEvent {
  /** 事件类型，没有 event 字段时是 message。 */
  event: string;
  data: string;
  /** 派发时的「最近事件 id」，从没出现过 id 字段时是空串。 */
  lastEventId: string;
}

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** 一个事件的文本。data 里的换行拆成多行 data。 */
export function encodeEvent(frame: SseFrame): string {
  let text = '';
  if (frame.event !== undefined) text += `event: ${frame.event}\n`;
  if (frame.id !== undefined) text += `id: ${frame.id}\n`;
  if (frame.retry !== undefined) text += `retry: ${frame.retry}\n`;
  for (const line of frame.data.split('\n')) text += `data: ${line}\n`;
  return `${text}\n`;
}

/** 注释行：以冒号开头，客户端忽略。常用来保持连接（心跳）。 */
export const encodeComment = (text: string): string => `: ${text}\n\n`;

/** 一个事件在整条流里的字节区间，逐字节解码时用。 */
export interface FrameSpan {
  from: number;
  to: number;
  /** 每一行（含行尾 LF）的区间和字段名。 */
  lines: Array<{ field: string; from: number; to: number }>;
}

/** 把若干事件拼成一条流，并记下每个事件的字节区间。 */
export function encodeStream(frames: readonly (SseFrame | { comment: string })[]): { text: string; bytes: number[]; spans: FrameSpan[] } {
  const bytes: number[] = [];
  const spans: FrameSpan[] = [];
  let text = '';
  for (const frame of frames) {
    const piece = 'comment' in frame ? encodeComment(frame.comment) : encodeEvent(frame);
    const from = bytes.length;
    const lines: FrameSpan['lines'] = [];
    for (const line of piece.split(/(?<=\n)/)) {
      const lineFrom = bytes.length;
      bytes.push(...utf8Encode(line));
      const field = line === '\n' ? '' : line.startsWith(':') ? ':' : line.slice(0, line.indexOf(':'));
      lines.push({ field, from: lineFrom, to: bytes.length });
    }
    text += piece;
    spans.push({ from, to: bytes.length, lines });
  }
  return { text, bytes, spans };
}

/** 增量解析器：push 任意切分的字节块，返回这一块里派发出来的事件。 */
export class SseParser {
  private readonly utf8 = new Utf8Stream();
  private line = '';
  /** 上一块以 CR 结尾：如果下一块以 LF 开头，这个 LF 属于同一个 CRLF。 */
  private lastWasCR = false;
  private started = false;
  private eventType = '';
  private dataBuffer = '';
  lastEventId = '';
  /** retry 字段设定的重连等待（毫秒），没设过是 null。 */
  reconnectionTime: number | null = null;
  /** 统计：读过的行数、忽略的注释行数。 */
  lines = 0;
  comments = 0;

  push(chunk: readonly number[] | string): SseEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.utf8.push(chunk);
    if (!this.started && text.length) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const out: SseEvent[] = [];
    for (const char of text) {
      if (this.lastWasCR) {
        this.lastWasCR = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        this.lastWasCR = char === '\r';
        const event = this.processLine(this.line);
        this.line = '';
        if (event) out.push(event);
      } else {
        this.line += char;
      }
    }
    return out;
  }

  /** 流结束。没有以空行结尾的半个事件按标准丢弃，所以这里永远不派发。返回被丢弃的数据。 */
  end(): string {
    this.utf8.flush();
    const dropped = this.dataBuffer + this.line;
    this.line = '';
    this.dataBuffer = '';
    this.eventType = '';
    return dropped;
  }

  private processLine(line: string): SseEvent | null {
    this.lines++;
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) {
      this.comments++;
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventType = value;
    else if (field === 'data') this.dataBuffer += `${value}\n`;
    else if (field === 'id') {
      if (!value.includes('\0')) this.lastEventId = value;
    } else if (field === 'retry') {
      if (/^[0-9]+$/.test(value)) this.reconnectionTime = Number(value);
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataBuffer === '') {
      this.eventType = '';
      return null;
    }
    const data = this.dataBuffer.endsWith('\n') ? this.dataBuffer.slice(0, -1) : this.dataBuffer;
    const event: SseEvent = { event: this.eventType || 'message', data, lastEventId: this.lastEventId };
    this.dataBuffer = '';
    this.eventType = '';
    return event;
  }
}

/** 一次性解析整条流。 */
export function parseStream(bytes: readonly number[] | string): SseEvent[] {
  const parser = new SseParser();
  const events = parser.push(bytes);
  parser.end();
  return events;
}
