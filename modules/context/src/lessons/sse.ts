/**
 * 第二课：SSE 流式事件序列。同一个请求加上 stream: true，服务端把回复拆成事件一帧一帧推。
 * 帧的字节来自 core/ 的 SSE 编码，HTTP chunked 分块来自 chunked()，客户端用 SseParser 增量解析（网络把字节切在帧中间、汉字中间），
 * accumulate 拼回完整的 Message。回复文字（REPLY）沿用第一课的示例，其余数字都是计算结果，tests/narrative.api.test.ts 核对文案。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import { utf8Decode } from '@explorer/llm-core/utf8';
import {
  accumulate,
  chunked,
  costOf,
  createMessage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  encodeStream,
  encodeText,
  eventFrame,
  formatUsd,
  inputBreakdown,
  messagesHttpRequest,
  parseStream,
  spanOf,
  SseParser,
  streamEvents,
  streamHttpHead,
  tokenBytes,
  type Message,
  type MessagesRequest,
  type SseEvent,
  type StreamEvent,
} from '../core';
import { concept, httpHead, jsonBody, promptPieces, sseBody, tokenIds, utf8Lines, wire } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import { DATE, MESSAGE_ID, MODEL, REPLY, REQUEST, REQUEST_ID, body as baseBody } from './messages';
import { PART_TONE } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, Lesson, RowPrim, Tone } from './types';

// ---------- 这次调用：和第一课同一个请求，多一个 stream: true ----------

export const STREAM_REQUEST: MessagesRequest = { ...REQUEST, stream: true };
export const replyText = (REPLY[0] as { text: string }).text;

export const body = encodeJson(STREAM_REQUEST);
export const httpRequest = encodeRequest(messagesHttpRequest(STREAM_REQUEST));
export const breakdown = inputBreakdown(STREAM_REQUEST);
export const message: Message = createMessage(STREAM_REQUEST, REPLY, { id: MESSAGE_ID });
export const cost = costOf(message.usage, MODEL);
export const events: StreamEvent[] = streamEvents(message);
export const frames = events.map(eventFrame);
export const stream = encodeStream(frames);
export const frameBytes = stream.spans.map((span) => stream.bytes.slice(span.from, span.to));
export const head = encodeResponse(streamHttpHead({ requestId: REQUEST_ID, date: DATE }));
/** 服务端每生成一帧就发一个 chunked 数据块。 */
export const httpBody = chunked(frameBytes);

const input = message.usage.input_tokens;
const output = message.usage.output_tokens;
const nameOf = (index: number): string => frames[index].event;
const deltaIndexes = events.flatMap((event, index) => (event.type === 'content_block_delta' ? [index] : []));
const deltaText = (index: number): string => (events[index] as Extract<StreamEvent, { type: 'content_block_delta' }>).delta.type === 'text_delta' ? ((events[index] as { delta: { text: string } }).delta.text) : '';
export const deltas = deltaIndexes.map(deltaText);
const firstDelta = deltaIndexes[0];
const lastDelta = deltaIndexes[deltaIndexes.length - 1];

// ---------- 累计 token：输入读完之后，每帧之后模型已经写出的 token 数 ----------

const replyIds = encodeText(replyText);
/** 文字写到第 n 个字节时，模型已经写出多少个 token。 */
function tokensWritten(textBytes: number): number {
  let used = 0;
  let count = 0;
  for (const id of replyIds) {
    used += tokenBytes(id).length;
    if (used > textBytes) break;
    count++;
  }
  return count;
}
const textBytesAfter = (frame: number): number => new TextEncoder().encode(deltaIndexes.filter((i) => i <= frame).map(deltaText).join('')).length;
/** 第 frame 帧到达之后的累计 token。 */
export const tokensAt = (frame: number): number => input + tokensWritten(textBytesAfter(frame));

// ---------- 网络把流切成任意的块 ----------

/** 第一个非 ASCII 字节：「是」的第一个字节。 */
export const charStart = stream.bytes.findIndex((byte) => byte >= 0x80);
const rand = mulberry32(20261106);
const cutSet = new Set<number>([charStart + 1, charStart + 2]);
for (let at = 0; ; ) {
  at += 150 + Math.floor(rand() * 250);
  if (at >= stream.bytes.length) break;
  cutSet.add(at);
}
export const cuts = [...cutSet].sort((a, b) => a - b);
export const chunks = [0, ...cuts].map((from, index, all) => ({ from, to: all[index + 1] ?? stream.bytes.length }));

const frameStarts = new Set(stream.spans.map((span) => span.from));
const continuation = (byte: number): boolean => byte >= 0x80 && byte < 0xc0;

export interface Read {
  from: number;
  to: number;
  bytes: number[];
  /** 这一块喂进去之后派发的事件。 */
  dispatched: SseEvent[];
  /** 这一块的结尾切在帧中间。 */
  endsMidFrame: boolean;
  /** 这一块的结尾切在一个汉字的中间。 */
  endsMidChar: boolean;
  /** 单独解码这一块得到的 U+FFFD 个数（朴素做法）。 */
  naiveBroken: number;
}

const parser = new SseParser();
export const reads: Read[] = chunks.map(({ from, to }) => {
  const bytes = stream.bytes.slice(from, to);
  const dispatched = parser.push(bytes);
  const last = to === stream.bytes.length;
  return {
    from,
    to,
    bytes,
    dispatched,
    endsMidFrame: !last && !frameStarts.has(to),
    endsMidChar: !last && continuation(stream.bytes[to]),
    naiveBroken: [...new TextDecoder().decode(new Uint8Array(bytes))].filter((char) => char === '�').length,
  };
});
export const dropped = parser.end();
export const parsed = reads.flatMap((read) => read.dispatched);
export const wholeParse = parseStream(stream.bytes);
export const rebuilt = accumulate(parsed.map((item) => JSON.parse(item.data) as StreamEvent));

export const readStats = {
  reads: reads.length,
  midFrame: reads.filter((read) => read.endsMidFrame).length,
  midChar: reads.filter((read) => read.endsMidChar).length,
  naiveBroken: reads.reduce((sum, read) => sum + read.naiveBroken, 0),
  /** 没有派发任何事件的块数。 */
  silent: reads.filter((read) => !read.dispatched.length).length,
};
/** 切在汉字中间的那几块里的第一块。 */
const charRead = reads.findIndex((read) => read.endsMidChar);

/** data 行只有半截时 JSON.parse 会失败：朴素做法按块解析 JSON 的下场。 */
export const halfLineFails = (() => {
  const line = utf8Decode(frameBytes[firstDelta].slice(0, 40));
  try {
    JSON.parse(line.slice(line.indexOf('data: ') + 6));
    return false;
  } catch {
    return true;
  }
})();

const eventOverhead = (() => {
  const total = deltaIndexes.reduce((sum, i) => sum + frameBytes[i].length, 0);
  const text = deltas.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0);
  return { frame: total / deltas.length, text: text / deltas.length, total, textTotal: text };
})();

// ---------- 自己拼的几层 ----------

let serial = 0;

/** HTTP chunked 的前 count 个数据块：长度行、数据、结尾的 CRLF。 */
function chunkedLayer(count: number): LayerWriter {
  const part = httpBody.chunks.slice(0, count);
  const used = part[part.length - 1].end[1];
  const layer = new LayerWriter(`sse-chunked-${serial++}`, `chunked 消息体 · 前 ${count} 块 ${used} 字节`, 'slate', '每块 = 十六进制长度 CRLF 数据 CRLF，最后一块长度为 0');
  part.forEach((chunk, index) => {
    const size = httpBody.bytes.slice(...chunk.data).length;
    layer.field(`块 ${index} 长度`, `${size.toString(16)}（${size} 字节）`, () => layer.raw(httpBody.bytes.slice(...chunk.size)), { note: index === 0 ? '十六进制写的数据长度，后面跟 CRLF。HTTP 头里没有 content-length，靠它知道每块多长。' : undefined });
    layer.field(`块 ${index} 数据`, `${nameOf(index)} · 一整帧`, () => layer.raw(httpBody.bytes.slice(...chunk.data)), { note: index === 0 ? '服务端每生成一帧就发一块：一帧不会拆开，也不会等凑满再发。' : undefined });
    layer.field('CRLF', '块结束', () => layer.raw(httpBody.bytes.slice(...chunk.end)));
  });
  return layer;
}

/** 客户端一次读到的字节：按它压在哪些帧上拆成字段。 */
function readLayer(index: number): LayerWriter {
  const read = reads[index];
  const layer = new LayerWriter(`sse-read-${serial++}`, `第 ${index + 1} 次读取 · ${read.bytes.length} 字节`, 'amber', `位置 ${read.from}–${read.to}，不管帧的边界`);
  stream.spans.forEach((span, frame) => {
    const from = Math.max(read.from, span.from);
    const to = Math.min(read.to, span.to);
    if (from >= to) return;
    const whole = from === span.from && to === span.to;
    const where = whole ? '整帧' : from === span.from ? '前半帧' : to === span.to ? '后半帧' : '帧的中间';
    const inChar = (at: number) => at > 0 && at < stream.bytes.length && continuation(stream.bytes[at]);
    const note = inChar(to) && to === read.to ? '这一块在一个汉字（3 字节）的中间结束，剩下的字节在下一块里。' : inChar(from) && from === read.from ? '这一块从汉字的中间开始：开头的字节是上一块里那个汉字的后半。' : undefined;
    layer.field(`${nameOf(frame)} · ${where}`, `${to - from} 字节`, () => layer.raw(stream.bytes.slice(from, to)), { note });
  });
  return layer;
}

// ---------- 图元 ----------

const REQUEST_FIELDS = ['model', 'max_tokens', 'system', 'messages', 'stream'] as const;
const FIELD_TONE: Record<string, Tone> = { model: 'blue', max_tokens: 'blue', system: PART_TONE.system, messages: PART_TONE.user, stream: 'amber' };

/** 请求：HTTP 头加每个字段，stream 是新增的。 */
function requestRow(lift: string[] = []): RowPrim {
  return {
    kind: 'row',
    id: 'q',
    w: 58,
    cells: [
      { v: 'HTTP 头', tone: 'slate', sub: `${httpRequest.body[0]} B`, key: 'head', lift: lift.includes('head') || undefined },
      ...REQUEST_FIELDS.map((name): DsCell => {
        const span = spanOf(body, name);
        return { v: name, tone: FIELD_TONE[name], sub: `${span.to - span.from} B`, key: name, lift: lift.includes(name) || undefined };
      }),
    ],
  };
}

const SHORT: Record<string, string> = { message_start: 'start', content_block_start: 'block+', ping: 'ping', content_block_stop: 'block-', message_delta: 'delta*', message_stop: 'stop' };
const FRAME_TONE: Record<string, Tone> = { message_start: 'blue', content_block_start: 'violet', ping: 'dim', content_block_delta: 'green', content_block_stop: 'violet', message_delta: 'amber', message_stop: 'slate' };
const WINDOW = 7;

/** 到达的帧：只画最近 WINDOW 帧，text_delta 直接写出文字。 */
function framesRow(arrived: number): RowPrim {
  const from = Math.max(0, arrived - WINDOW);
  const cells: DsCell[] = [];
  for (let i = from; i < arrived; i++) {
    const type = events[i].type;
    cells.push({ v: type === 'content_block_delta' ? deltaText(i).replace(/ /g, '␣') : SHORT[type], tone: FRAME_TONE[type], sub: `#${i}`, key: `f${i}`, lift: i === arrived - 1 || undefined });
  }
  return { kind: 'row', id: 'e', w: 54, cells, center: (cells.length - 1) / 2 };
}

/** 客户端一次次读到的块：压在汉字中间的块标琥珀色。 */
function readsRow(upTo: number): RowPrim {
  const from = Math.max(0, upTo - WINDOW);
  const cells: DsCell[] = [];
  for (let i = from; i < upTo; i++) {
    const read = reads[i];
    cells.push({ v: `${read.bytes.length} B`, tone: read.endsMidChar ? 'amber' : read.endsMidFrame ? 'blue' : 'green', sub: `读 ${i + 1}`, key: `r${i}`, lift: i === upTo - 1 || undefined });
  }
  return { kind: 'row', id: 'e', w: 54, cells, center: (cells.length - 1) / 2 };
}

/** 屏幕上已经显示的文字：最近 8 个 delta。 */
function textRow(arrived: number): RowPrim {
  const shown = deltaIndexes.filter((i) => i < arrived);
  const last = shown.slice(-8);
  return { kind: 'row', id: 'o', w: 50, bare: true, cells: last.map((i): DsCell => ({ v: deltaText(i).replace(/ /g, '␣'), tone: 'green', key: `t${i}`, sub: `#${i}` })), center: (last.length - 1) / 2 };
}

// ---------- 文案用到的数 ----------

export const numbers = {
  baseBody: baseBody.bytes.length,
  body: body.bytes.length,
  bodyDiff: body.bytes.length - baseBody.bytes.length,
  request: httpRequest.bytes.length,
  contentLength: httpRequest.bytes.length - httpRequest.body[0],
  headBytes: head.bytes.length,
  frames: frames.length,
  deltas: deltas.length,
  streamBytes: stream.bytes.length,
  httpBodyBytes: httpBody.bytes.length,
  input,
  output,
  firstFrames: frameBytes.slice(0, 3).reduce((sum, bytes) => sum + bytes.length, 0),
  frameOverhead: Math.round(eventOverhead.frame - eventOverhead.text),
  deltaFrameAvg: Math.round(eventOverhead.frame),
  deltaTextAvg: +eventOverhead.text.toFixed(1),
  ...readStats,
  dispatched: parsed.length,
};
const N = numbers;
const total = formatUsd(cost.total);

// ---------- 课程 ----------

export const sse: Lesson = {
  id: 'sse',
  name: 'SSE',
  title: 'SSE 流式事件序列',
  group: 'api',
  layer: [1, 4],
  layerNote: '从 TCP 读到的字节、HTTP chunked 分块、SSE 帧，到 JSON 事件和拼回来的消息。',
  tokensNote: '模型读入的输入 token，加上到这一帧为止它已经写出的输出 token。',
  nodes: ['app', 'sdk', 'gateway', 'model', 'request', 'events', 'out'],
  place: { app: [90, 170], sdk: [370, 60], gateway: [770, 60], model: [790, 380], request: [260, 500], events: [520, 300], out: [150, 680] },
  labels: {
    app: ['应用', 'messages.stream()'],
    sdk: ['SDK', 'SseParser + accumulate'],
    gateway: ['API', 'stream: true'],
    model: ['模型', '边生成边推'],
    request: ['请求', '多了 stream 字段'],
    events: ['SSE 帧', '最近到达的几帧'],
    out: ['屏幕上的文字', '每个 delta 一格'],
  },
  labelAt: { request: [-30, 70], events: [60, -105], out: [-140, 60] },
  radius: { request: 56, events: 50, out: 50 },
  initial: { request: [], events: [], out: [] },
  start: ['app', 'sdk', 'request'],
  legend: [['blue', '请求、message_start'], ['green', 'text_delta 和读取'], ['amber', 'stream、message_delta、切在汉字中间'], ['violet', '内容块的开始和结束'], [null, 'token 列：模型读入的输入加已写出的输出']],
  overview: {
    full: '同一个请求，边生成边收',
    description: `这一课把第一课的请求加上 "stream": true。服务端不再返回一个 JSON，而是把回复拆成 ${N.frames} 个 SSE 事件一帧一帧推：message_start、content_block_start、ping、${N.deltas} 个 content_block_delta、content_block_stop、message_delta、message_stop，共 ${N.streamBytes} 字节。看每一帧的真实字节，看网络把它们切成 ${N.reads} 块（切在帧中间、汉字中间）时客户端的 SseParser 怎样拼对，最后 accumulate 把事件拼回和非流式一模一样的 Message。`,
    facts: [
      ['接口', 'POST /v1/messages，"stream": true'],
      ['响应', 'text/event-stream，transfer-encoding: chunked'],
      ['帧数', `${N.frames} 帧（${N.deltas} 个 text_delta）`],
      ['字节', `流 ${N.streamBytes}，加 chunked 分块 ${N.httpBodyBytes}`],
      ['token', `输入 ${input}，输出 ${output}（本站迷你分词器）`],
    ],
  },
  steps: [
    {
      title: '同一个请求，多一个 stream: true',
      desc: `请求体 ${N.baseBody} → ${N.body} 字节，响应不再是一个 JSON`,
      detail: `在请求体里加一个 "stream": true，其余字段原样不动，请求体从 ${N.baseBody} 字节变成 ${N.body} 字节，content-length 跟着变成 ${N.contentLength}。服务端不等整段回复写完，而是每生成一点就推一次。推送用的格式是 SSE（server-sent events）：每个事件是几行文字，以一个空行结束。`,
      facts: [['新增字段', `"stream":true，${N.bodyDiff} 字节（含逗号）`], ['请求体', `${N.body} 字节`], ['content-length', String(N.contentLength)]],
      events: [
        type('messages.stream({…})'),
        pk('app', 'sdk', 'blue', 'messages.stream()', ['stream: true', `max_tokens: ${REQUEST.max_tokens}`], [0, 'CALL', `调用 messages.stream：和第一课同一个请求，多了 stream: true`, N.body],
          wire('SDK 收到的参数，序列化成 JSON 请求体', 'mem', 'format', jsonBody('请求体', body, {
            notes: { stream: `true 表示用 SSE 流式返回。字段顺序就是序列化顺序，所以它排在最后；整个请求体比第一课多 ${N.bodyDiff} 字节。` },
          })),
          { ds: { request: [requestRow(['stream'])] } }),
        show('gateway'),
        pk('sdk', 'gateway', 'blue', 'HTTP 请求', ['POST /v1/messages', `${N.request} 字节`], [0, 'HTTP', `HTTP/1.1 请求：content-length: ${N.contentLength}，请求体里 stream: true`, N.request],
          wire('SDK 发出的 HTTP/1.1 请求', 'mem', 'format',
            httpHead('请求头', httpRequest, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'], notes: { 'content-length': `请求体的字节数 ${N.contentLength}，比第一课的 ${N.baseBody} 多 ${N.bodyDiff}。` } }),
            jsonBody('请求体', body)),
          { ds: { request: [requestRow(['head'])] } }),
      ],
    },
    {
      title: '200 先到，然后是第一批帧',
      desc: `头部 ${N.headBytes} 字节，前 3 帧 ${N.firstFrames} 字节`,
      detail: `API 校验通过、模型读完 ${input} 个输入 token 开始生成，响应头立刻发出：状态码 200 在这时就定下了，content-type 是 text/event-stream，没有 content-length，改用 transfer-encoding: chunked。第一帧 message_start 带着一个 content 为空的 Message，input_tokens 已经是最终值 ${input}，output_tokens 只是初值 1；接着 content_block_start 宣布第 0 个内容块开始，之后可以夹任意个 ping。每个事件的 event 行和 data 里的 type 是同一个名字，每一帧被 HTTP 包成一个 chunked 数据块。`,
      facts: [['状态', '200（此后出错只能写进流里）'], ['前 3 帧', `${nameOf(0)}、${nameOf(1)}、${nameOf(2)}`], ['input_tokens', `${input}（message_start 里已是最终值）`], ['output_tokens 初值', '1']],
      events: [
        show('model', 'events'),
        pk('gateway', 'model', 'violet', '展开成 token', [`${input} 个 token`], [input, 'TEMPLATE', `ChatML 展开：输入 ${input} 个 token，模型开始生成`, breakdown.prompt.bytes.length],
          wire('模型读到的文本（和第一课相同，本站演示用）', 'mem', 'internal', promptPieces('ChatML 文本', breakdown.prompt), tokenIds('input_ids', breakdown.prompt.ids, { summary: `${input} 个 token id：stream 不改变模型读到的内容` })),
          { ds: { events: [] } }),
        state('model', { 输入: `${input} token`, 输出: '生成中' }),
        pk('gateway', 'sdk', 'slate', 'HTTP 200', ['text/event-stream', 'chunked'], [input, 'HTTP', `HTTP/1.1 200：text/event-stream，没有 content-length，transfer-encoding: chunked`, head.bytes.length],
          wire('响应头：先于第一帧发出', 'mem', 'format', httpHead('响应头', head, {
            startNote: '状态码在这里就是 200 了；之后如果出错，只能在流里发 error 事件。',
            example: ['request-id', 'date'],
            notes: { 'content-type': 'text/event-stream：SSE 的 MIME 类型。', 'cache-control': '不要缓存这个响应。', 'transfer-encoding': '总长度还不知道，所以分块发送，每块自带长度。' },
          }))),
        pk('gateway', 'sdk', 'blue', 'SSE 帧 0–2', [nameOf(0), nameOf(1), nameOf(2)], [tokensAt(2), 'SSE', `前 3 帧共 ${N.firstFrames} 字节：message_start、content_block_start、ping`, N.firstFrames],
          wire('一帧一个 chunked 数据块', 'mem', 'format',
            chunkedLayer(3),
            sseBody('SSE 帧', encodeStream(frames.slice(0, 3)), {
              notes: {
                0: `message_start：content 为空的 Message。usage.input_tokens = ${input} 已经是最终值，output_tokens = 1 只是初值，最终值在 message_delta 里。`,
                1: 'content_block_start：第 0 个内容块开始，类型 text，text 为空。',
                2: 'ping：保持连接用的空事件，可以出现任意次，客户端直接忽略。',
              },
            })),
          { ds: { events: [framesRow(3)] } }),
        state('model', { 输入: null, 输出: null }),
      ],
    },
    {
      title: '文字一小块一小块到',
      desc: `${N.deltas} 个 text_delta，每帧最多 2 个 token`,
      detail: `每个 content_block_delta 带一小段文字（text_delta），这一课按每帧 2 个 token 切，共 ${N.deltas} 帧；切法只是演示参数。delta 里的 text 永远是完整的字符：「${deltas[2]}」的 3 个 UTF-8 字节在同一帧里，JSON 里直接是原样的 UTF-8。每一帧平均 ${N.deltaFrameAvg} 字节，其中文字只有 ${N.deltaTextAvg} 字节，其余是 event 行、data: 前缀、JSON 的 type 和 index、空行这些固定开销，流式比一次性返回更费字节。`,
      facts: [['text_delta 帧数', String(N.deltas)], ['每帧平均', `${N.deltaFrameAvg} 字节，文字 ${N.deltaTextAvg} 字节`], ['累计输出', `${output} token`], ['流总长', `${N.streamBytes} 字节`]],
      events: [
        show('out'),
        pk('model', 'gateway', 'green', `${deltas.slice(0, 6).join('').length} 个字符`, deltas.slice(0, 6).map((text) => `「${text}」`).slice(0, 3), [tokensAt(firstDelta + 5), 'INFER', `生成前 6 个 delta：${deltas.slice(0, 6).map((text) => `「${text}」`).join(' ')}`, new TextEncoder().encode(deltas.slice(0, 6).join('')).length],
          wire('模型写出的文字（示例）', 'mem', 'format', utf8Lines('文字', deltas.slice(0, 6).join(''), { color: 'green', summary: '回复是示例（本站不跑大模型），字节和 token 数是真实计算的' }))),
        pk('gateway', 'sdk', 'green', 'text_delta ×6', deltas.slice(0, 3).map((text) => `「${text}」`), [tokensAt(firstDelta + 5), 'SSE', `${frames.slice(firstDelta, firstDelta + 6).length} 帧 text_delta，${frameBytes.slice(firstDelta, firstDelta + 6).reduce((sum, bytes) => sum + bytes.length, 0)} 字节`, frameBytes.slice(firstDelta, firstDelta + 6).reduce((sum, bytes) => sum + bytes.length, 0)],
          wire('前 6 个 content_block_delta', 'mem', 'format', sseBody('SSE 帧', encodeStream(frames.slice(firstDelta, firstDelta + 6)), {
            notes: { 2: `「${deltas[2]}」是 3 个 UTF-8 字节，整个汉字在一帧里：服务端只发完整的字符。` },
          })),
          { ds: { events: [framesRow(firstDelta + 6)], out: [textRow(firstDelta + 6)] } }),
        pk('gateway', 'sdk', 'green', 'text_delta …', deltas.slice(-3).map((text) => `「${text}」`), [tokensAt(lastDelta), 'SSE', `其余 ${N.deltas - 6} 帧 text_delta，每帧平均 ${N.deltaFrameAvg} 字节`, frameBytes.slice(firstDelta + 6, lastDelta + 1).reduce((sum, bytes) => sum + bytes.length, 0)],
          wire('其余的 content_block_delta', 'mem', 'format', sseBody('SSE 帧', encodeStream(frames.slice(firstDelta + 6, lastDelta + 1)))),
          { ds: { events: [framesRow(lastDelta + 1)], out: [textRow(lastDelta + 1)] } }),
      ],
    },
    {
      title: '网络随便切，解析器照样拼对',
      desc: `${N.reads} 次读取，${N.midFrame} 次切在帧中间，${N.midChar} 次切在汉字中间`,
      detail: `TLS 记录和 TCP 读取的边界与 SSE 帧的边界毫无关系，客户端读到的字节可能是半帧：这 ${N.streamBytes} 字节被读成了 ${N.reads} 块，${N.midFrame} 块的结尾切在帧中间，还有 ${N.midChar} 块的结尾切在汉字中间，「${deltas[2]}」的 3 个字节就被切进了 3 块里。SseParser 把字节喂给流式 UTF-8 解码，没收齐的字节先扣着，一行行拼，遇到空行才派发事件，所以不管怎么切，派发的 ${N.dispatched} 个事件和一次性解析完全相同。如果每块各自解码，就会得到 ${N.naiveBroken} 个乱码字符（U+FFFD），半截的 data 行也解析不了 JSON。`,
      facts: [['读取次数', `${N.reads}（${N.silent} 次没有派发事件）`], ['切在帧中间', String(N.midFrame)], ['切在汉字中间', String(N.midChar)], ['朴素逐块解码', `${N.naiveBroken} 个 U+FFFD`], ['SseParser', `${N.dispatched} 个事件，丢弃 ${dropped.length} 字节`]],
      events: [
        pk('gateway', 'sdk', 'amber', `读 ${charRead}`, [`${reads[charRead - 1].bytes.length} 字节`, '结尾在帧中间'], [tokensAt(lastDelta), 'SSE', `第 ${charRead} 次读取 ${reads[charRead - 1].bytes.length} 字节，结尾切在帧中间，已经派发 ${reads[charRead - 1].dispatched.length} 个事件`, reads[charRead - 1].bytes.length],
          wire('客户端读到的字节：压在几个帧上', 'mem', 'format', readLayer(charRead - 1)),
          { ds: { events: [readsRow(charRead)] } }),
        pk('gateway', 'sdk', 'amber', `读 ${charRead + 1}`, [`${reads[charRead].bytes.length} 字节`, '汉字只来了第 1 字节'], [tokensAt(lastDelta), 'SSE', `第 ${charRead + 1} 次读取：结尾切在「${deltas[2]}」的第 1 个字节后，解析器把这个字节扣着`, reads[charRead].bytes.length],
          wire('这一块的结尾是汉字的第 1 个字节', 'mem', 'format', readLayer(charRead)),
          { ds: { events: [readsRow(charRead + 1)] } }),
        pk('gateway', 'sdk', 'amber', `读 ${charRead + 2}`, [`${reads[charRead + 1].bytes.length} 字节`, '汉字的第 2 字节'], [tokensAt(lastDelta), 'SSE', `第 ${charRead + 2} 次读取只有 ${reads[charRead + 1].bytes.length} 字节：「${deltas[2]}」的第 2 个字节，仍然凑不成字`, reads[charRead + 1].bytes.length],
          wire('只有 1 个字节的一块', 'mem', 'format', readLayer(charRead + 1)),
          { ds: { events: [readsRow(charRead + 2)] } }),
        pk('sdk', 'events', 'green', `${N.dispatched} 个事件`, [`${N.reads} 次读取`, `丢弃 ${dropped.length} 字节`], [tokensAt(lastDelta), 'SSE', `SseParser 逐块解析：共派发 ${N.dispatched} 个事件，和一次性解析逐个相同`, N.streamBytes],
          wire('解析结果', 'mem', '示意', concept('解析结果', [
            ['读取次数', String(N.reads), '喂进 push() 的块数。'],
            ['派发事件', String(N.dispatched), `和 parseStream 一次性解析的结果逐个相同（${wholeParse.length} 个）。`],
            ['汉字中间', String(N.midChar), '没收齐的字节留在 UTF-8 解码器里，下一块到了才吐出完整的字。'],
            ['end() 丢弃', `${dropped.length} 字节`, '流结束时没有以空行结尾的半个事件按标准丢弃；这里没有。'],
          ], 'amber')),
          { ds: { events: [readsRow(reads.length)] } }),
      ],
    },
    {
      title: '拼回完整的 Message',
      desc: `message_delta 给出最终用量：输出 ${output} token，${message.stop_reason}`,
      detail: `最后一个内容块以 content_block_stop 收尾，message_delta 给出 stop_reason（${message.stop_reason}）和最终的 usage.output_tokens = ${output}，文档强调这里的用量是累计值，直接覆盖 message_start 里的初值 1，message_stop 之后流结束。accumulate 按顺序把 text_delta 接起来，再用 message_delta 更新 stop_reason 和 usage，得到的 Message 与第一课非流式的响应完全一致，费用同样是 ${total}。遇到不认识的事件类型要跳过：文档说会新增事件类型，ping 就是这样被忽略的。如果 HTTP 已经 200 之后才出错，错误只能作为 event: error 发在流里，最后一课再讲怎么办。`,
      facts: [['stop_reason', message.stop_reason], ['output_tokens', `${output}（累计值）`], ['拼回的 Message', '与非流式响应相同'], ['费用', `${total}（示例单价）`]],
      events: [
        show('events'),
        pk('gateway', 'sdk', 'amber', 'message_delta', [`stop_reason: ${message.stop_reason}`, `output_tokens: ${output}`], [input + output, 'SSE', `message_delta 带最终用量，message_stop 结束：最后 3 帧共 ${frameBytes.slice(-3).reduce((sum, bytes) => sum + bytes.length, 0)} 字节`, frameBytes.slice(-3).reduce((sum, bytes) => sum + bytes.length, 0)],
          wire('流的最后 3 帧', 'mem', 'format', sseBody('SSE 帧', encodeStream(frames.slice(-3)), {
            notes: {
              0: 'content_block_stop：第 0 个内容块结束。',
              1: `message_delta：stop_reason 和 stop_sequence 在这里才知道；usage.output_tokens = ${output} 是累计值，覆盖 message_start 里的初值 1。`,
              2: 'message_stop：流结束，之后服务端关闭这个响应。',
            },
          })),
          { ds: { events: [framesRow(frames.length)] } }),
        pk('sdk', 'app', 'green', 'Message', [`text: 「${replyText.slice(0, 10)}…」`, `usage: ${input} / ${output}`], [input + output, 'CALL', `accumulate 拼回 Message：stop_reason ${message.stop_reason}，usage 输入 ${input}、输出 ${output}，示例费用 ${total}`, encodeJson(rebuilt).bytes.length],
          wire('SDK 交给应用的 Message（finalMessage）', 'mem', 'format', jsonBody('Message', encodeJson(rebuilt), { root: 'usage', summary: '与非流式响应的 usage 逐字段相同' })),
          { ds: { out: [textRow(frames.length)] } }),
        render,
        note('out', `流式和非流式拼出的 Message 完全相同`, 'green'),
      ],
    },
  ],
  outro: {
    title: '流式只是换了一种送达方式',
    desc: `${N.frames} 帧、${N.streamBytes} 字节，拼回同一个 Message`,
    text: `stream: true 没有改变模型读到什么、写出什么，也没有改变账单；它改变的是字节怎样送达：一个 JSON 变成 ${N.frames} 个 SSE 帧，每帧自带 event 和 data，开销比文字本身还大，换来的是第一个字不用等整段写完。客户端要做的事也因此变多：增量解析（读到的块可能是半帧、半个汉字）、拼回消息、容忍不认识的事件。Anthropic 用 message_start 到 message_stop 的事件序列，OpenAI 的两种接口用的是别的事件和别的结束方式。下一课把同一段对话用三种写法发出去，逐字节对比它们的差异。`,
    facts: [['帧', `${N.frames}`], ['流', `${N.streamBytes} 字节`], ['token', `${input} + ${output}`], ['下一课', '同一请求的三种写法']],
  },
};

