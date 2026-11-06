/**
 * stdio 传输：客户端把服务器作为子进程启动，往它的 stdin 写消息，从 stdout 读消息。规范（2026-07-28 的 stdio 一页）：
 *   - 每条消息是一个 JSON-RPC 请求、通知或响应，UTF-8；
 *   - 消息之间用换行分隔，消息里**不能有内嵌的换行**；
 *   - stdout 上只能有合法的 MCP 消息，日志写到 stderr；
 *   - 服务器不在 stdout 上发请求；客户端取消请求要发 notifications/cancelled。
 *
 * JSON.stringify 的紧凑写法本来就不含换行（字符串里的换行写成 \n 两个字符），所以一行一条消息就够了；
 * 带缩进的 JSON 有换行，不能直接写进 stdio——encodeLine 会拒绝。LineDecoder 按字节找 0x0A，切口落在汉字中间也没关系。
 */
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import type { JsonRpcMessage } from './jsonrpc';
import type { McpServer } from './server';

export const LF = 0x0a;

/** 一条消息写成 stdio 上的一行：紧凑 JSON + 换行。传入文字时检查里面没有换行。 */
export function encodeLine(message: JsonRpcMessage | string): string {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  if (/[\n\r]/.test(text)) throw new Error('stdio 的一条消息里不能有换行');
  return `${text}\n`;
}

export const encodeLines = (messages: readonly (JsonRpcMessage | string)[]): string => messages.map((message) => encodeLine(message)).join('');

/** 一行在字节流里的位置（含行尾的 0x0A）。 */
export interface LineSpan {
  from: number;
  to: number;
  text: string;
}

/** 整段 stdio 字节流：每行的字节区间。 */
export function lineSpans(bytes: readonly number[]): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== LF) continue;
    out.push({ from: start, to: i + 1, text: utf8Decode(bytes.slice(start, i)) });
    start = i + 1;
  }
  return out;
}

/** 增量切行：收到的字节可以在任何位置断开，凑满一行才吐出来。空行跳过。 */
export class LineDecoder {
  private pending: number[] = [];

  push(chunk: readonly number[] | string): string[] {
    const bytes = typeof chunk === 'string' ? utf8Encode(chunk) : chunk;
    const out: string[] = [];
    for (const byte of bytes) {
      if (byte !== LF) {
        this.pending.push(byte);
        continue;
      }
      const line = utf8Decode(this.pending).replace(/\r$/, '');
      this.pending = [];
      if (line) out.push(line);
    }
    return out;
  }

  /** 还没凑满一行的字节数（流结束时有剩余说明最后一条消息不完整）。 */
  get buffered(): number {
    return this.pending.length;
  }
}

/** 一次 stdio 往返的记录：客户端写进 stdin 的字节、服务器写到 stdout 的字节。 */
export interface StdioRecord {
  stdin: number[];
  stdout: number[];
}

/**
 * 把一个内存里的服务器当作子进程：客户端写的每条消息编码成一行字节进 stdin，服务器逐行解析、处理，回复编码成一行写 stdout，
 * 客户端再从 stdout 的字节里切行、解析。返回传输函数（给 McpClient 用）和累积的字节记录。
 */
export function stdioTransport(server: McpServer): { send: (message: JsonRpcMessage) => JsonRpcMessage[]; record: StdioRecord } {
  const record: StdioRecord = { stdin: [], stdout: [] };
  const serverIn = new LineDecoder();
  const clientIn = new LineDecoder();
  return {
    record,
    send(message) {
      const line = utf8Encode(encodeLine(message));
      record.stdin.push(...line);
      const replies: string[] = [];
      for (const text of serverIn.push(line)) {
        const response = server.handle(text);
        if (response) replies.push(encodeLine(response));
      }
      const out = utf8Encode(replies.join(''));
      record.stdout.push(...out);
      return clientIn.push(out).map((text) => JSON.parse(text) as JsonRpcMessage);
    },
  };
}
