/**
 * 文案和计算结果对得上（接口组：sse、dialects、retry）。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果，关键的数写死在这里，改了输入会立刻报错；
 * 2. 文字里没法取值的说法，比如「汉字被切成三块」「[DONE] 不是 JSON」「429 带 retry-after」。
 */
import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import {
  accumulate,
  chunked,
  costOf,
  dechunk,
  formatUsd,
  headerOf,
  parseMessage,
  parseStream,
  responsesText,
  SseParser,
  type StreamEvent,
} from '../src/core';
import { message as baseMessage, messages as messagesLesson, MODEL, QUESTION, REQUEST, SYSTEM } from '../src/lessons/messages';
import * as sse from '../src/lessons/sse';
import * as dialects from '../src/lessons/dialects';
import * as retry from '../src/lessons/retry';

// 直接从各课文件取，不经过 lessons/index.ts：别的组的课写到一半时，这里不受影响（index 的登记由 lessons.test.ts 检查）。
const LESSON_BY_ID = { messages: messagesLesson, sse: sse.sse, dialects: dialects.dialects, retry: retry.retry } as const;
const factsOf = (id: keyof typeof LESSON_BY_ID, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const stepOf = (id: keyof typeof LESSON_BY_ID, step: number) => LESSON_BY_ID[id].steps[step];
const enc = (text: string) => utf8Encode(text).length;
const sentences = (text: string) => text.split(/[。！？]/).filter((part) => part.trim());

describe('课程衔接', () => {
  it('第一课的下一课是 sse，每课的下一课按 PLANNED 的顺序', () => {
    expect(Object.fromEntries(LESSON_BY_ID.messages.outro.facts).下一课).toBe('SSE 流式事件序列');
    expect(Object.fromEntries(LESSON_BY_ID.sse.outro.facts).下一课).toBe('同一请求的三种写法');
    expect(Object.fromEntries(LESSON_BY_ID.dialects.outro.facts).下一课).toBe('限流、错误与重试');
    expect(LESSON_BY_ID.sse.outro.text).toContain('下一课把同一段对话用三种写法发出去');
    expect(LESSON_BY_ID.dialects.outro.text).toContain('下一课看错误');
    expect(LESSON_BY_ID.retry.outro.text).toContain('下一组课进入「提示」');
  });

  it('三课都在 api 组，步骤数 5', () => {
    for (const id of ['sse', 'dialects', 'retry'] as const) {
      expect(LESSON_BY_ID[id].group).toBe('api');
      expect(LESSON_BY_ID[id].steps).toHaveLength(5);
    }
  });
});

describe('SSE 流式事件序列', () => {
  const N = sse.numbers;

  it('请求：只多一个 "stream":true（14 字节），其余字段不变', () => {
    expect(JSON.stringify({ ...REQUEST, stream: true })).toBe(utf8Decode(sse.body.bytes));
    expect(N.baseBody).toBe(168);
    expect(N.body).toBe(182);
    expect(N.bodyDiff).toBe(enc(',"stream":true'));
    expect(N.contentLength).toBe(182);
    expect(stepOf('sse', 0).desc).toBe('请求体 168 → 182 字节，响应不再是一个 JSON');
    expect(sse.STREAM_REQUEST.model).toBe(MODEL);
  });

  it('响应头：200，text/event-stream，chunked，没有 content-length', () => {
    const head = parseMessage([...sse.head.bytes, ...sse.httpBody.bytes]);
    expect(head.startLine).toBe('HTTP/1.1 200 OK');
    expect(headerOf(head.headers, 'content-type')).toBe('text/event-stream; charset=utf-8');
    expect(headerOf(head.headers, 'transfer-encoding')).toBe('chunked');
    expect(headerOf(head.headers, 'content-length')).toBeUndefined();
    expect(N.headBytes).toBe(199);
    expect(stepOf('sse', 1).desc).toBe('头部 199 字节，前 3 帧 579 字节');
  });

  it('帧：29 帧 = message_start、content_block_start、ping、23 个 text_delta、content_block_stop、message_delta、message_stop', () => {
    expect(sse.events.map((event) => event.type)).toEqual([
      'message_start', 'content_block_start', 'ping',
      ...Array(23).fill('content_block_delta'),
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    expect(N.frames).toBe(29);
    expect(N.deltas).toBe(23);
    expect(N.streamBytes).toBe(3570);
    expect(sse.stream.bytes).toHaveLength(3570);
    expect(utf8Decode(sse.stream.bytes.slice(0, 21))).toBe('event: message_start\n');
  });

  it('每个事件的 event 行和 data 里的 type 是同一个名字', () => {
    for (const frame of sse.frames) expect(JSON.parse(frame.data).type).toBe(frame.event);
  });

  it('message_start：input_tokens 是最终值 78，output_tokens 初值 1；message_delta 的 output_tokens 是累计值 54', () => {
    const start = sse.events[0] as Extract<StreamEvent, { type: 'message_start' }>;
    expect(start.message.usage.input_tokens).toBe(78);
    expect(start.message.usage.output_tokens).toBe(1);
    expect(start.message.content).toEqual([]);
    const delta = sse.events[sse.events.length - 2] as Extract<StreamEvent, { type: 'message_delta' }>;
    expect(delta.usage.output_tokens).toBe(54);
    expect(delta.delta.stop_reason).toBe('end_turn');
    expect(stepOf('sse', 4).desc).toBe('message_delta 给出最终用量：输出 54 token，end_turn');
  });

  it('chunked：每帧一个数据块，长度是十六进制，去掉分块后等于整条流', () => {
    expect(sse.httpBody.chunks).toHaveLength(29);
    expect(dechunk(sse.httpBody.bytes)).toEqual(sse.stream.bytes);
    const expected = sse.frameBytes.reduce((sum, bytes) => sum + bytes.length.toString(16).length + 2 + bytes.length + 2, 0) + 5;
    expect(N.httpBodyBytes).toBe(expected);
    expect(N.httpBodyBytes).toBe(chunked(sse.frameBytes).bytes.length);
    // 第一帧 message_start 的长度行：十六进制。
    const first = sse.frameBytes[0].length;
    expect(utf8Decode(sse.httpBody.bytes.slice(...sse.httpBody.chunks[0].size))).toBe(`${first.toString(16)}\r\n`);
  });

  it('text_delta：每帧最多 2 个 token，汉字不会拆开，平均每帧 119 字节、文字 3.7 字节', () => {
    expect(sse.deltas.join('')).toBe(sse.replyText);
    expect(sse.deltas.every((text) => !text.includes('�'))).toBe(true);
    expect(sse.deltas[2]).toBe('是');
    expect(enc(sse.deltas[2])).toBe(3);
    expect(N.deltaFrameAvg).toBe(119);
    expect(N.deltaTextAvg).toBe(3.7);
    // 每帧开销 = 帧字节 - 文字字节，约 115 字节。
    expect(N.frameOverhead).toBe(115);
    expect(stepOf('sse', 2).desc).toBe('23 个 text_delta，每帧最多 2 个 token');
  });

  it('累计 token：输入读完是 78，写完最后一个 delta 是 78 + 54', () => {
    expect(sse.tokensAt(0)).toBe(78);
    expect(sse.tokensAt(sse.events.length - 1)).toBe(78 + 54);
    let last = 0;
    for (let i = 0; i < sse.events.length; i++) {
      expect(sse.tokensAt(i)).toBeGreaterThanOrEqual(last);
      last = sse.tokensAt(i);
    }
  });

  it('网络块：16 次读取，15 次切在帧中间，3 次切在汉字中间，「是」的 3 个字节在 3 块里', () => {
    expect(N.reads).toBe(16);
    expect(N.midFrame).toBe(15);
    expect(N.midChar).toBe(3);
    expect(sse.reads.map((read) => read.bytes).flat()).toEqual(sse.stream.bytes); // 切得不重不漏
    const bytes = utf8Encode('是');
    expect(bytes).toHaveLength(3);
    expect(sse.charStart).toBe(sse.stream.bytes.findIndex((byte) => byte >= 0x80));
    expect(sse.stream.bytes.slice(sse.charStart, sse.charStart + 3)).toEqual(bytes);
    const holders = sse.reads.filter((read) => read.from <= sse.charStart + 2 && read.to > sse.charStart);
    expect(holders).toHaveLength(3);
    expect(holders[1].bytes).toHaveLength(1); // 中间那块只有 1 个字节
    expect(stepOf('sse', 3).desc).toBe('16 次读取，15 次切在帧中间，3 次切在汉字中间');
  });

  it('增量解析：和一次性解析逐个相同，没有半个事件被丢弃，有 3 次读取没派发任何事件', () => {
    expect(sse.parsed).toEqual(sse.wholeParse);
    expect(sse.parsed).toHaveLength(29);
    expect(sse.dropped).toBe('');
    expect(N.silent).toBe(3);
    expect(N.dispatched).toBe(29);
    // 手写的 SseParser 用法：同样的切分，每个字节一块也一样。
    const parser = new SseParser();
    const bytewise = sse.stream.bytes.flatMap((byte) => parser.push([byte]));
    expect(bytewise).toEqual(sse.wholeParse);
  });

  it('朴素做法：每块各自解码得到 5 个 U+FFFD；半截的 data 行不是合法 JSON', () => {
    expect(N.naiveBroken).toBe(5);
    expect(sse.halfLineFails).toBe(true);
    const joined = sse.reads.map((read) => new TextDecoder().decode(new Uint8Array(read.bytes))).join('');
    expect([...joined].filter((char) => char === '�')).toHaveLength(5);
    expect(joined).not.toBe(utf8Decode(sse.stream.bytes));
  });

  it('accumulate：拼回的 Message 与第一课非流式的响应完全一致，费用相同', () => {
    expect(sse.rebuilt).toEqual(baseMessage);
    expect(accumulate(sse.events)).toEqual(baseMessage);
    expect(sse.message).toEqual(baseMessage);
    const cost = costOf(baseMessage.usage, MODEL);
    expect(formatUsd(cost.total)).toBe('$0.00139');
    expect(stepOf('sse', 4).detail).toContain('$0.00139');
    expect(sse.cost.total).toBe(cost.total);
  });

  it('遇到不认识的事件类型要跳过', () => {
    const unknown = [...sse.events.slice(0, 5), { type: 'future_event', data: 1 } as unknown as StreamEvent, ...sse.events.slice(5)];
    expect(accumulate(unknown)).toEqual(baseMessage);
  });

  it('错误事件格式：HTTP 200 之后只能是 event: error（文档示例）', () => {
    expect(stepOf('sse', 4).detail).toContain('event: error');
    expect(stepOf('sse', 4).detail).toContain('最后一课再讲怎么办');
  });

  it('SSE 一课里每步 detail 的句数在 2–4 句', () => {
    for (const step of LESSON_BY_ID.sse.steps) {
      expect(sentences(step.detail).length, step.title).toBeGreaterThanOrEqual(2);
      expect(sentences(step.detail).length, step.title).toBeLessThanOrEqual(4);
    }
  });

  it('解析 chunked 的响应：头 + 分块的消息体可以还原整条流', () => {
    const response = [...sse.head.bytes.slice(0, sse.head.body[0]), ...sse.httpBody.bytes];
    const parsed = parseMessage(response);
    expect(parsed.body).toEqual(sse.stream.bytes);
    expect(parseStream(parsed.body)).toHaveLength(29);
    expect(factsOf('sse', 3).SseParser).toBe('29 个事件，丢弃 0 字节');
  });
});

describe('同一请求的三种写法', () => {
  const N = dialects.numbers;

  it('三份请求体的字节数', () => {
    expect([N.claudeBody, N.responsesBody, N.chatBody]).toEqual([168, 146, 197]);
    expect(stepOf('dialects', 0).desc).toBe('168 / 146 / 197 字节');
    expect(dialects.bodies.claude.bytes.length).toBe(enc(JSON.stringify(REQUEST)));
  });

  it('system 放哪里：Claude 顶层、Responses 的 instructions、Chat 的第一条消息', () => {
    expect(JSON.parse(utf8Decode(dialects.bodies.claude.bytes))).toEqual({ model: MODEL, max_tokens: 1024, system: SYSTEM, messages: [{ role: 'user', content: QUESTION }] });
    expect(JSON.parse(utf8Decode(dialects.bodies.responses.bytes))).toEqual({ model: 'gpt-6-astra', instructions: SYSTEM, input: QUESTION, max_output_tokens: 1024 });
    expect(JSON.parse(utf8Decode(dialects.bodies.chat.bytes))).toEqual({ model: 'anthropic/claude-opus-5.5', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: QUESTION }], max_tokens: 1024 });
    expect(Object.keys(dialects.responsesReq)).not.toContain('system');
    expect(Object.keys(dialects.chatReq)).not.toContain('system');
  });

  it('上限参数：Claude 和兼容接口 max_tokens，Responses max_output_tokens，都没有 max_completion_tokens', () => {
    expect(Object.keys(dialects.chatReq)).toContain('max_tokens');
    expect(Object.keys(dialects.chatReq)).not.toContain('max_completion_tokens');
    expect(Object.keys(dialects.responsesReq)).toContain('max_output_tokens');
    expect(stepOf('dialects', 0).detail).toContain('max_completion_tokens');
  });

  it('HTTP：鉴权头、路径、主机', () => {
    const parse = (layout: { bytes: number[] }) => parseMessage(layout.bytes);
    const claude = parse(dialects.https.claude);
    expect(claude.startLine).toBe('POST /v1/messages HTTP/1.1');
    expect(headerOf(claude.headers, 'x-api-key')).toBeTruthy();
    expect(headerOf(claude.headers, 'anthropic-version')).toBe('2026-10-21');
    expect(headerOf(claude.headers, 'authorization')).toBeUndefined();
    for (const [name, startLine, host] of [['responses', 'POST /v1/responses HTTP/1.1', 'api.openai.com'], ['openrouter', 'POST /api/v1/chat/completions HTTP/1.1', 'openrouter.ai'], ['ollama', 'POST /v1/chat/completions HTTP/1.1', 'localhost:11434']] as const) {
      const parsed = parse(dialects.https[name]);
      expect(parsed.startLine, name).toBe(startLine);
      expect(headerOf(parsed.headers, 'host'), name).toBe(host);
      expect(headerOf(parsed.headers, 'authorization'), name).toMatch(/^Bearer /);
      expect(headerOf(parsed.headers, 'anthropic-version'), name).toBeUndefined();
      expect(headerOf(parsed.headers, 'x-api-key'), name).toBeUndefined();
    }
    expect(headerOf(parse(dialects.https.ollama).headers, 'authorization')).toBe('Bearer ollama');
    expect([N.claudeHttp, N.responsesHttp, N.openrouterHttp, N.ollamaHttp]).toEqual([428, 327, 388, 321]);
    expect(stepOf('dialects', 1).desc).toBe('请求 428 / 327 / 388 / 321 字节');
    expect([N.claudeHead, N.responsesHead, N.openrouterHead, N.ollamaHead]).toEqual([260, 181, 191, 144]);
    // Ollama 的头手写一遍：请求行、host、content-type、authorization、content-length、空行。
    expect(enc('POST /v1/chat/completions HTTP/1.1\r\nhost: localhost:11434\r\ncontent-type: application/json\r\nauthorization: Bearer ollama\r\ncontent-length: 197\r\n\r\n')).toBe(144 + 0);
    // content-length 都等于各自的请求体字节数。
    for (const [name, size] of [['claude', 168], ['responses', 146], ['openrouter', 197], ['ollama', dialects.https.ollama.bytes.length - dialects.https.ollama.body[0]]] as const) {
      expect(Number(headerOf(parse(dialects.https[name]).headers, 'content-length')), name).toBe(size);
    }
  });

  it('响应：回复文字的位置、结束原因、用量字段名，同样的 token 数', () => {
    const claude = JSON.parse(utf8Decode(dialects.responseJson.claude.bytes));
    const responses = JSON.parse(utf8Decode(dialects.responseJson.responses.bytes));
    const chat = JSON.parse(utf8Decode(dialects.responseJson.chat.bytes));
    const text = sse.replyText;
    expect(claude.content[0].text).toBe(text);
    expect(responses.output[0].content[0].text).toBe(text);
    expect(chat.choices[0].message.content).toBe(text);
    expect(Array.isArray(claude.content)).toBe(true);
    expect(typeof chat.choices[0].message.content).toBe('string');
    expect([claude.stop_reason, responses.status, chat.choices[0].finish_reason]).toEqual(['end_turn', 'completed', 'stop']);
    expect(claude.usage).toMatchObject({ input_tokens: 78, output_tokens: 54 });
    expect(responses.usage).toMatchObject({ input_tokens: 78, output_tokens: 54, total_tokens: 132 });
    expect(chat.usage).toMatchObject({ prompt_tokens: 78, completion_tokens: 54, total_tokens: 132 });
    expect(chat.usage).not.toHaveProperty('input_tokens');
    expect(claude.usage).not.toHaveProperty('total_tokens');
    expect(responses.object).toBe('response');
    expect(chat.object).toBe('chat.completion');
    expect([N.claudeResp, N.responsesResp, N.chatResp]).toEqual([479, 557, 545]);
    expect(stepOf('dialects', 2).desc).toBe('479 / 557 / 545 字节');
  });

  it('三种流：帧数 29 / 31 / 27，结束方式 message_stop / response.completed / data: [DONE]', () => {
    expect([N.claudeFrames, N.responsesFrames, N.chatFrames]).toEqual([29, 31, 27]);
    expect([N.claudeStream, N.responsesStream, N.chatStream]).toEqual([3570, 7367, 6156]);
    expect(stepOf('dialects', 3).desc).toBe('29 / 31 / 27 帧，结束方式各不相同');
    expect(dialects.claudeFrames.at(-1)!.event).toBe('message_stop');
    expect(dialects.responsesFrames.at(-1)!.event).toBe('response.completed');
    expect(dialects.chatFrames.at(-1)!.data).toBe('[DONE]');
    // 只有 Chat 的流没有 event 行；Responses 的流里没有 [DONE]。
    expect(dialects.chatFrames.every((frame) => !('event' in frame))).toBe(true);
    expect(utf8Decode(dialects.streams.responses.bytes)).not.toContain('[DONE]');
    expect(utf8Decode(dialects.streams.claude.bytes)).not.toContain('[DONE]');
    expect(N.doneBytes).toBe(enc('data: [DONE]\n\n'));
    // sequence_number 从 0 开始。
    expect(JSON.parse(dialects.responsesFrames[0].data).sequence_number).toBe(0);
    expect(JSON.parse(dialects.responsesFrames.at(-1)!.data).sequence_number).toBe(30);
  });

  it('同一个 SseParser 解析三种流，拼出同一段文字；[DONE] 不能直接 JSON.parse', () => {
    const text = sse.replyText;
    const claude = accumulate(parseStream(dialects.streams.claude.bytes).map((item) => JSON.parse(item.data) as StreamEvent));
    expect(claude.content[0]).toEqual({ type: 'text', text });
    const responses = parseStream(dialects.streams.responses.bytes).map((item) => JSON.parse(item.data));
    expect(responsesText(responses)).toBe(text);
    const chatEvents = parseStream(dialects.streams.chat.bytes);
    expect(chatEvents.at(-1)!.data).toBe('[DONE]');
    expect(() => JSON.parse('[DONE]')).toThrow();
    const chat = chatEvents.slice(0, -1).map((item) => JSON.parse(item.data));
    expect(chat.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')).toBe(text);
    // include_usage：倒数第二块 choices 为空，带 usage。
    expect(chat.at(-1).choices).toEqual([]);
    expect(chat.at(-1).usage).toMatchObject({ prompt_tokens: 78, completion_tokens: 54 });
    // Responses 的 usage 到 response.completed 才有，created 时是 null。
    expect(responses[0].response.usage).toBeNull();
    expect(responses.at(-1).response.usage).toMatchObject({ input_tokens: 78, output_tokens: 54 });
  });

  it('temperature：Claude 2026-10-21 返回 400，旧版本 2023-06-01 还接受', async () => {
    const { validateRequest } = await import('../src/core');
    expect(dialects.temperatureError).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(dialects.temperatureError.message).toBe('temperature: Extra inputs are not permitted');
    expect(dialects.temperatureError.documented).toBe(false);
    expect(validateRequest(dialects.temperatureReq, '2023-06-01')).toBeNull();
    expect(validateRequest({ ...REQUEST, top_p: 0.9 })).not.toBeNull();
    expect(validateRequest({ ...REQUEST, top_k: 5 })).not.toBeNull();
    expect(stepOf('dialects', 4).detail).toContain('2026-10-21');
    expect(stepOf('dialects', 4).detail).toContain('2023-06-01');
    expect(parseMessage(dialects.temperature400.bytes).startLine).toBe('HTTP/1.1 400 Bad Request');
  });

  it('三种错误体的形状', () => {
    const claude = JSON.parse(utf8Decode(dialects.claude429.bytes));
    const openai = JSON.parse(utf8Decode(dialects.openai429.bytes));
    const openrouter = JSON.parse(utf8Decode(dialects.openrouter429.bytes));
    expect(Object.keys(claude)).toEqual(['type', 'error', 'request_id']);
    expect(Object.keys(claude.error)).toEqual(['type', 'message']);
    expect(Object.keys(openai)).toEqual(['error']);
    expect(Object.keys(openai.error)).toEqual(['message', 'type', 'param', 'code']);
    expect(Object.keys(openrouter.error)).toEqual(['code', 'message']);
    expect(typeof openrouter.error.code).toBe('number');
    expect([N.claude429, N.openai429, N.openrouter429]).toEqual([172, 150, 54]);
  });

  it('每次调用累计 token：三种写法各 2 次，每次 78 + 54', () => {
    const packets = LESSON_BY_ID.dialects.steps.flatMap((step) => step.events.filter((event) => event.type === 'packet'));
    const tokens = packets.map((packet) => (packet as { row: { tokens: number } }).row.tokens);
    expect(tokens.at(-1)).toBe(6 * 132);
    expect(N.calls).toBe(6);
    expect(tokens.filter((n) => n === 132 * 3)).toHaveLength(1); // 第 3 步最后一个响应
  });
});

describe('限流、错误与重试', () => {
  const N = retry.numbers;

  it('令牌桶：演示限额 6 / 500 / 400，8 个请求每 0.1 秒一个，放行 6 个拒绝 2 个', () => {
    expect(retry.LIMITS).toEqual({ rpm: 6, itpm: 500, otpm: 400 });
    expect(N.admitted).toBe(6);
    expect(N.rejected).toBe(2);
    expect(retry.burst.map((row) => row.result.ok)).toEqual([true, true, true, true, true, true, false, false]);
    expect(stepOf('retry', 0).desc).toBe('8 个请求，放行 6 个，拒绝 2 个');
    expect(N.limit).toBe('requests');
    // 6 RPM = 每 10 秒 1 个，0.6 秒时桶里 0.06 个，还差 0.94 个 = 9.4 秒，向上取整是 10。
    expect(N.waitSeconds).toBe(9.4);
    expect(N.retryAfter).toBe(10);
  });

  it('每个请求之后桶的余量：请求每次少 1，输入少 78，输出少 54（再加这 0.1 秒补的）', () => {
    expect(retry.burst.slice(0, 6).map((row) => row.left.requests)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(retry.burst[0].left).toEqual({ requests: 5, input: 422, output: 346 }); // 500 - 78，400 - 54
    expect(retry.burst[5].left.requests).toBe(0);
    // 被拒绝的请求不扣桶：输入余量只会涨。
    expect(retry.burst[6].left.input).toBeGreaterThanOrEqual(retry.burst[5].left.input);
    expect(retry.call).toBe(132);
  });

  it('429 响应：状态行、retry-after、anthropic-ratelimit-* 头', () => {
    const parsed = parseMessage(retry.response429.bytes);
    expect(parsed.startLine).toBe('HTTP/1.1 429 Too Many Requests');
    expect(headerOf(parsed.headers, 'retry-after')).toBe('10');
    expect(headerOf(parsed.headers, 'anthropic-ratelimit-requests-limit')).toBe('6');
    expect(headerOf(parsed.headers, 'anthropic-ratelimit-requests-remaining')).toBe('0');
    expect(headerOf(parsed.headers, 'anthropic-ratelimit-input-tokens-limit')).toBe('500');
    expect(headerOf(parsed.headers, 'anthropic-ratelimit-output-tokens-limit')).toBe('400');
    expect(headerOf(parsed.headers, 'request-id')).toBeTruthy();
    const body = JSON.parse(utf8Decode(parsed.body));
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.request_id).toBe(headerOf(parsed.headers, 'request-id'));
    expect(N.response429).toBe(844);
    // reset 是 RFC 3339：请求桶 6 个、每 10 秒补 1 个，从空到满正好 60 秒，EXAMPLE_EPOCH 是 2026-11-06 02:00:00。
    expect(headerOf(parsed.headers, 'anthropic-ratelimit-requests-reset')).toBe('2026-11-06T02:01:00.000Z');
  });

  it('retry-after 之后再发就会被放行（向上取整保证够）', () => {
    const verdict = retry.timeline[2];
    expect(verdict.status).toBe(200);
    expect(verdict.at).toBeGreaterThan(0.6 + 10);
  });

  it('状态码：400、401、413 不重试；429、500、529 重试；月度上限的 429 SDK 会重试但白等', () => {
    const byLabel = Object.fromEntries(retry.STATUSES.map((row) => [row.label, row]));
    for (const label of ['400', '401', '413']) expect(byLabel[label], label).toMatchObject({ sdk: false, worth: false });
    for (const label of ['429', '500', '529']) expect(byLabel[label], label).toMatchObject({ sdk: true, worth: true });
    expect(byLabel['429*']).toMatchObject({ sdk: true, worth: false });
  });

  it('消费上限的 429：没有 retry-after，error.details.error_code 是 enforced_spend_limit_reached', () => {
    const parsed = parseMessage(retry.responseSpend.bytes);
    expect(parsed.startLine).toBe('HTTP/1.1 429 Too Many Requests');
    expect(headerOf(parsed.headers, 'retry-after')).toBeUndefined();
    const body = JSON.parse(utf8Decode(parsed.body));
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.details).toEqual({ error_code: 'enforced_spend_limit_reached' });
    expect(factsOf('retry', 1)['429*']).toBe('月度上限：retry-after 缺失，白等');
  });

  it('400：temperature 被拒绝，没有 retry-after，没有 token', () => {
    const parsed = parseMessage(retry.response400.bytes);
    expect(parsed.startLine).toBe('HTTP/1.1 400 Bad Request');
    expect(headerOf(parsed.headers, 'retry-after')).toBeUndefined();
    expect(retry.temperatureError.message).toBe('temperature: Extra inputs are not permitted');
  });

  it('529：状态行没有原因短语，消息是文档逐字给出的 Overloaded', () => {
    expect(utf8Decode(retry.response529.bytes.slice(...retry.response529.startLine))).toBe('HTTP/1.1 529 \r\n');
    const body = JSON.parse(utf8Decode(parseMessage(retry.response529.bytes).body));
    expect(body.error).toEqual({ type: 'overloaded_error', message: 'Overloaded' });
    expect(retry.error529.documented).toBe(true);
  });

  it('时间线：429（retry-after 10）→ 等 10 秒 → 529 → 退避 997 毫秒 → 200，共 3 次尝试', () => {
    expect(retry.timeline.map((row) => row.status)).toEqual([429, 529, 200]);
    expect(retry.timeline[0].wait).toMatchObject({ ms: 10000, source: 'retry-after' });
    expect(retry.timeline[1].wait).toMatchObject({ source: 'backoff', ceiling: 1000 });
    expect(N.wait2).toBe(997);
    expect(retry.timeline[1].at).toBeCloseTo(10.6, 9);
    expect(retry.timeline[2].at).toBeCloseTo(11.597, 9);
    expect(N.doneAt).toBe(11);
    expect(N.attempts).toBe(3);
    expect(stepOf('retry', 2).desc).toBe('第 3 次尝试成功，从第一次被拒算起 11 秒');
    // 退避上限 = min(8000, 500 × 2^1)。
    expect(Math.min(8000, 500 * 2 ** 1)).toBe(1000);
    // 抖动因子在 [0.75, 1]。
    expect(N.wait2 / 1000).toBeGreaterThanOrEqual(0.75);
  });

  it('抖动：30 个客户端重试峰值 25 / 22 / 11，放弃 9 / 4 / 6（不是单调的）', () => {
    expect([N.herdNone, N.herdSdk, N.herdFull]).toEqual([25, 22, 11]);
    expect([retry.herd.none.gaveUp, retry.herd.sdk.gaveUp, retry.herd.full.gaveUp]).toEqual([9, 4, 6]);
    expect(retry.herd.none.perAttempt[0]).toBe(30);
    expect(retry.herd.none.perAttempt[1]).toBe(25);
    expect(stepOf('retry', 3).desc).toBe('30 个客户端，同一时刻重试的峰值 25 → 11');
    // 「抖动不保证每个客户端成功」：放弃数不随抖动单调下降。
    expect(retry.herd.full.gaveUp).toBeGreaterThan(retry.herd.sdk.gaveUp);
  });

  it('流中途出错：12 个事件，最后一个是 error，已写出 16 个 token，没有 message_delta', () => {
    expect(retry.partialParsed).toHaveLength(12);
    expect(retry.partialParsed.at(-1)!.event).toBe('error');
    expect(JSON.parse(retry.partialParsed.at(-1)!.data)).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(retry.partialParsed.map((item) => item.event)).not.toContain('message_delta');
    expect(retry.partialText).toBe('token 是模型读写文本');
    expect(N.partialTokens).toBe(16);
    expect(retry.partialDropped).toBe('');
    expect(retry.partialMessage.content).toEqual([{ type: 'text', text: retry.partialText }]);
    expect(stepOf('retry', 4).desc).toBe('8 个 delta 之后 event: error，已写出 16 个 token');
    expect(parseStream(retry.partialStream.bytes)).toHaveLength(12);
  });

  it('累计 token：放行 6 个 = 792，第 3 次成功再加 132，流中途出错再加 78 + 16，重发成功再加 132', () => {
    const packets = LESSON_BY_ID.retry.steps.flatMap((step) => step.events.filter((event) => event.type === 'packet')) as Array<{ label: string; row: { tokens: number } }>;
    const tokens = packets.map((packet) => packet.row.tokens);
    expect(tokens[0]).toBe(0);
    expect(Math.max(...tokens)).toBe(6 * 132 + 132 + 78 + 16 + 132);
    expect(tokens.filter((n) => n === 6 * 132)).not.toHaveLength(0);
    expect(tokens.includes(7 * 132)).toBe(true);
    expect(tokens.includes(7 * 132 + 78 + 16)).toBe(true);
  });

  it('文案：SDK 默认重试 2 次、照 retry-after；缓存读不占输入额度的说法没有出现在错的地方', () => {
    expect(stepOf('retry', 2).detail).toContain('SDK 默认重试 2 次');
    expect(stepOf('retry', 0).detail).toContain('输入桶只算未缓存的输入');
    expect(stepOf('retry', 0).detail).toContain('max_tokens 不影响它');
    expect(retry.LIMITS.rpm / 60).toBeCloseTo(0.1, 9);
    for (const step of LESSON_BY_ID.retry.steps) {
      expect(sentences(step.detail).length, step.title).toBeGreaterThanOrEqual(2);
      expect(sentences(step.detail).length, step.title).toBeLessThanOrEqual(4);
    }
  });
});
