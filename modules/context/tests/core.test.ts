/**
 * 计算核心：JSON、HTTP/1.1、SSE、token 计数、chat template、Messages API 模拟、OpenAI 两种写法、计费、缓存、预算。
 * 期望值尽量手写自规范（RFC 9112、WHATWG SSE、API 文档），不调用被测函数来生成期望。
 */
import { describe, expect, it } from 'vitest';
import {
  accumulate,
  apiError,
  CACHE_READ,
  CACHE_WRITE_1H,
  CACHE_WRITE_5M,
  cacheBlocks,
  chatCompletion,
  chatStream,
  chatUsage,
  childrenOf,
  chunked,
  compact,
  costOf,
  countTokens,
  createMessage,
  decodeTokens,
  dechunk,
  DOCUMENTED_ERRORS,
  dropOldest,
  encodeEvent,
  encodeEvents,
  encodeJson,
  encodeRequest,
  encodeResponse,
  encodeStream,
  encodeText,
  encodeWithSpecials,
  ERROR_STATUS,
  errorHttpResponse,
  exampleId,
  formatUsd,
  inputBreakdown,
  isRetryable,
  makeRequest,
  makeResponse,
  messagesHttpRequest,
  MODELS,
  parseMessage,
  parseStream,
  planBudget,
  PRICES,
  PromptCache,
  renderChatML,
  renderRequest,
  responseObject,
  responsesUsage,
  runCache,
  SPECIAL_ID,
  spanOf,
  SseParser,
  streamEvents,
  textPieces,
  toChatCompletions,
  toResponses,
  totalInput,
  turnsOf,
  validateRequest,
  type MessagesRequest,
} from '../src/core';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

describe('JSON：和 JSON.stringify 逐字节相同，记下每个值的字节区间', () => {
  const value = { model: 'm', n: 1.5, ok: true, none: null, list: [1, '二', { a: [] }], empty: {}, text: '引号"和\n换行', skip: undefined };

  it('紧凑写法和缩进写法都和 JSON.stringify 一致', () => {
    expect(encodeJson(value).text).toBe(JSON.stringify(value));
    expect(encodeJson(value, 2).text).toBe(JSON.stringify(value, null, 2));
    expect(encodeJson(value).bytes).toEqual(utf8Encode(JSON.stringify(value)));
  });

  it('每个区间取出来的字节，解析后就是那个值', () => {
    const json = encodeJson(value);
    for (const span of json.spans) {
      const parsed = JSON.parse(utf8Decode(json.bytes.slice(span.valueFrom, span.to)));
      const expected = span.path === '' ? value : span.path.split(/\.|(?=\[)/).reduce<unknown>((node, key) => (key.startsWith('[') ? (node as unknown[])[Number(key.slice(1, -1))] : (node as Record<string, unknown>)[key]), value);
      expect(parsed, span.path).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  });

  it('成员的区间从键的引号开始；中文按 UTF-8 计字节', () => {
    const json = encodeJson({ a: '二' });
    // {"a":"二"}：键从第 1 个字节开始，值从第 5 个字节开始，"二" 是 1 + 3 + 1 = 5 个字节。
    expect(spanOf(json, 'a')).toMatchObject({ from: 1, valueFrom: 5, to: 10, kind: 'string' });
    expect(childrenOf(json, '').map((span) => span.path)).toEqual(['a']);
    expect(() => spanOf(json, 'b')).toThrow();
  });
});

describe('HTTP/1.1 报文', () => {
  it('请求：请求行、头、空行、消息体，CRLF 行尾，content-length 是真实字节数（{"a":"二"} 是 8 + 3 = 11 字节）', () => {
    const layout = encodeRequest(makeRequest('POST', '/v1/messages', [['host', 'api.anthropic.com']], '{"a":"二"}'));
    expect(layout.bytes).toEqual([...ascii('POST /v1/messages HTTP/1.1\r\nhost: api.anthropic.com\r\ncontent-length: 11\r\n\r\n'), ...utf8Encode('{"a":"二"}')]);
    expect(layout.startLine).toEqual([0, 28]);
    expect(layout.headers.map((header) => [header.name, header.value, header.to - header.from])).toEqual([['host', 'api.anthropic.com', 25], ['content-length', '11', 20]]);
    expect(layout.body[1] - layout.body[0]).toBe(11);
  });

  it('响应：状态行带原因短语；529 没有登记的短语，状态码后面仍有一个空格', () => {
    expect(utf8Decode(encodeResponse(makeResponse(200, [], '')).bytes)).toBe('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n');
    expect(utf8Decode(encodeResponse(makeResponse(429, [])).bytes).split('\r\n')[0]).toBe('HTTP/1.1 429 Too Many Requests');
    expect(utf8Decode(encodeResponse(makeResponse(529, [])).bytes).split('\r\n')[0]).toBe('HTTP/1.1 529 ');
  });

  it('编码后再解析，头和消息体不变；头名不区分大小写', () => {
    const req = makeRequest('POST', '/x', [['Host', 'h'], ['X-Api-Key', 'k']], '你好');
    const parsed = parseMessage(encodeRequest(req).bytes);
    expect(parsed.startLine).toBe('POST /x HTTP/1.1');
    expect(parsed.headers).toEqual(req.headers);
    expect(utf8Decode(parsed.body)).toBe('你好');
  });

  it('chunked：Wikipedia 的例子「Wiki」「pedia」', () => {
    const encoded = chunked([ascii('Wiki'), ascii('pedia')]);
    expect(utf8Decode(encoded.bytes)).toBe('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n');
    expect(encoded.chunks[1].data).toEqual([12, 17]);
    expect(utf8Decode(dechunk(encoded.bytes))).toBe('Wikipedia');
    const res = makeResponse(200, [['transfer-encoding', 'chunked']], encoded.bytes);
    expect(res.headers.some(([name]) => name === 'content-length')).toBe(false);
    expect(utf8Decode(parseMessage(encodeResponse(res).bytes).body)).toBe('Wikipedia');
  });

  it('头字段里不能有换行（防止头注入）', () => {
    expect(() => encodeRequest(makeRequest('GET', '/', [['x', 'a\r\nb: c']]))).toThrow();
  });
});

describe('SSE：按 WHATWG 的解析算法', () => {
  it('编码：data 里的换行拆成多行 data，以空行结束', () => {
    expect(encodeEvent({ event: 'ping', data: '{"type":"ping"}' })).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(encodeEvent({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n');
  });

  it('标准里的例子：多行 data 用换行拼接', () => {
    expect(parseStream('data: YHOO\ndata: +2\ndata: 10\n\n')).toEqual([{ event: 'message', data: 'YHOO\n+2\n10', lastEventId: '' }]);
  });

  it('标准里的例子：注释、id、只有字段名的 id 清空、末尾没有空行的事件丢弃', () => {
    const events = parseStream(': test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n');
    expect(events).toEqual([
      { event: 'message', data: 'first event', lastEventId: '1' },
      { event: 'message', data: 'second event', lastEventId: '' },
    ]);
  });

  it('标准里的例子：只有字段名的 data 是空串；两个空 data 拼成一个换行', () => {
    expect(parseStream('data\n\ndata\ndata\n\ndata:').map((event) => event.data)).toEqual(['', '\n']);
  });

  it('冒号后只去掉一个空格；CRLF、LF、CR 都是行尾；开头的 BOM 去掉', () => {
    expect(parseStream('data:test\n\ndata: test\n\n').map((event) => event.data)).toEqual(['test', 'test']);
    expect(parseStream('event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r').map((event) => `${event.event}=${event.data}`)).toEqual(['a=1', 'b=2']);
    expect(parseStream('﻿data: x\n\n')[0].data).toBe('x');
  });

  it('retry 只认纯数字；id 里有 NULL 时忽略；没有 data 的事件不派发', () => {
    const parser = new SseParser();
    expect(parser.push('retry: 3000\nid: a\0b\nevent: x\n\nretry: 1e3\n\n')).toEqual([]);
    expect(parser.reconnectionTime).toBe(3000);
    expect(parser.lastEventId).toBe('');
  });

  it('任意切分字节流（切在 CRLF 中间、汉字中间），解析结果都一样', () => {
    const text = 'event: content_block_delta\r\ndata: {"text":"汉字"}\r\n\r\n: 心跳\r\n\r\nevent: message_stop\r\ndata: {}\r\n\r\n';
    const bytes = utf8Encode(text);
    const whole = parseStream(bytes);
    expect(whole.map((event) => event.event)).toEqual(['content_block_delta', 'message_stop']);
    for (let cut = 1; cut < bytes.length; cut++) {
      const parser = new SseParser();
      const events = [...parser.push(bytes.slice(0, cut)), ...parser.push(bytes.slice(cut))];
      expect(events, `切在 ${cut}`).toEqual(whole);
    }
  });

  it('encodeStream 记下每个事件、每一行的字节区间', () => {
    const stream = encodeStream([{ event: 'a', data: '1' }, { comment: 'hi' }]);
    expect(stream.text).toBe('event: a\ndata: 1\n\n: hi\n\n');
    expect(stream.spans[0]).toMatchObject({ from: 0, to: 18 });
    expect(stream.spans[0].lines.map((line) => line.field)).toEqual(['event', 'data', '']);
    expect(stream.spans[1].lines[0].field).toBe(':');
  });
});

describe('token 计数和特殊 token', () => {
  it('特殊 token 只在模板编码里生效，普通文本里的同样字符按字节编码', () => {
    expect(encodeWithSpecials('<|im_start|>')).toEqual([SPECIAL_ID['<|im_start|>']]);
    expect(SPECIAL_ID['<|im_end|>']).toBe(354);
    expect(encodeText('<|im_start|>').length).toBeGreaterThan(1);
    expect(encodeText('<|im_start|>')).not.toContain(SPECIAL_ID['<|im_start|>']);
    expect(decodeTokens(encodeWithSpecials('<|im_start|>user\n你好<|im_end|>'))).toBe('<|im_start|>user\n你好<|im_end|>');
    expect(countTokens('')).toBe(0);
  });

  it('按 token 分段时不会切出半个汉字', () => {
    const text = '模型读 token，模型写 token。';
    for (const per of [1, 2, 3]) {
      const pieces = textPieces(text, per);
      expect(pieces.join('')).toBe(text);
      expect(pieces.every((piece) => !piece.includes('�'))).toBe(true);
    }
  });
});

describe('ChatML 模板', () => {
  it('和 Hugging Face 文档里 add_generation_prompt 的例子同样的写法', () => {
    const prompt = renderChatML([
      { role: 'user', parts: [{ text: 'Hi there!', source: 'a' }] },
      { role: 'assistant', parts: [{ text: 'Nice to meet you!', source: 'b' }] },
      { role: 'user', parts: [{ text: 'Can I ask a question?', source: 'c' }] },
    ]);
    expect(prompt.text).toBe('<|im_start|>user\nHi there!<|im_end|>\n<|im_start|>assistant\nNice to meet you!<|im_end|>\n<|im_start|>user\nCan I ask a question?<|im_end|>\n<|im_start|>assistant\n');
    expect(renderChatML([{ role: 'user', parts: [{ text: 'x', source: 'a' }] }], { generationPrompt: false }).text).toBe('<|im_start|>user\nx<|im_end|>\n');
  });

  it('每个 token 都归到一段：各段之和等于总数，内容加开销等于总数', () => {
    const prompt = renderRequest({ system: '你是助手。', messages: [{ role: 'user', content: '什么是 token？' }, { role: 'assistant', content: 'token 是单位。' }, { role: 'user', content: '再说一遍' }] });
    expect(prompt.ids).toEqual(encodeWithSpecials(prompt.text));
    expect(prompt.pieces.reduce((sum, piece) => sum + piece.tokens, 0)).toBe(prompt.tokens);
    expect(Object.values(prompt.bySource).reduce((a, b) => a + b, 0) + prompt.overhead).toBe(prompt.tokens);
    expect(prompt.bySource.system).toBe(countTokens('你是助手。'));
    expect(prompt.pieces.filter((piece) => piece.kind === 'special')).toHaveLength(8);
  });

  it('相邻的同角色消息合并成一轮；工具定义排在 system 前面', () => {
    const turns = turnsOf({ system: 's', tools: [{ name: 't', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'a' }, { role: 'user', content: [{ type: 'text', text: 'b' }] }] });
    expect(turns.map((turn) => turn.role)).toEqual(['system', 'user']);
    expect(turns[0].parts.map((part) => part.source)).toEqual(['tools', 'system']);
    expect(turns[1].parts.map((part) => part.source)).toEqual(['messages[0].content', 'messages[1].content[0]']);
  });
});

const BASE: MessagesRequest = { model: 'claude-opus-5-5', max_tokens: 1024, system: '你是助手。', messages: [{ role: 'user', content: '什么是 token？' }] };

describe('Messages API：请求校验', () => {
  it('合法的请求通过', () => {
    expect(validateRequest(BASE)).toBeNull();
  });

  it('缺必填字段、模型不存在、max_tokens 超上限、messages 为空', () => {
    expect(validateRequest({ model: 'claude-opus-5-5', messages: [] })).toMatchObject({ status: 400, type: 'invalid_request_error', message: 'max_tokens: Field required' });
    expect(validateRequest({ ...BASE, model: 'claude-x' })).toMatchObject({ status: 404, type: 'not_found_error', message: 'model: claude-x' });
    expect(validateRequest({ ...BASE, max_tokens: 128_001 })?.status).toBe(400);
    expect(validateRequest({ ...BASE, max_tokens: 128_000 })).toBeNull();
    expect(validateRequest({ ...BASE, messages: [] })?.status).toBe(400);
  });

  it('文档原文的两条：不支持预填充、不支持强制工具调用', () => {
    const prefill = validateRequest({ ...BASE, messages: [...BASE.messages, { role: 'assistant', content: '{' }] });
    expect(prefill).toMatchObject({ status: 400, message: 'This model does not support assistant message prefill. The conversation must end with a user message.', documented: true });
    expect(validateRequest({ ...BASE, tool_choice: { type: 'any' } })).toMatchObject({ message: 'tool_choice: type "tool" and "any" are not supported for this model.', documented: true });
    expect(validateRequest({ ...BASE, model: 'claude-haiku-5-5', tool_choice: { type: 'any' } })).toBeNull();
    expect(validateRequest({ ...BASE, tool_choice: { type: 'auto' } })).toBeNull();
  });

  it('2026-10-21 起 temperature、top_p、top_k 一律 400，2023-06-01 不检查', () => {
    expect(validateRequest({ ...BASE, temperature: 1 })?.status).toBe(400);
    expect(validateRequest({ ...BASE, top_k: 5 }, '2026-10-21')?.status).toBe(400);
    expect(validateRequest({ ...BASE, temperature: 1 }, '2023-06-01')).toBeNull();
  });

  it('tool_result 必须对应上一条 assistant 消息里的 tool_use', () => {
    const ok: MessagesRequest = { ...BASE, messages: [
      { role: 'user', content: '天气？' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'w', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴' }] },
    ] };
    expect(validateRequest(ok)).toBeNull();
    const bad = { ...ok, messages: [ok.messages[0], ok.messages[1], { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'toolu_2', content: '晴' }] }] };
    expect(validateRequest(bad)?.status).toBe(400);
  });

  it('最多 4 个缓存断点；1 小时的要排在 5 分钟的前面', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => ({ type: 'text' as const, text: `第 ${i} 段`, cache_control: { type: 'ephemeral' as const } }));
    expect(validateRequest({ ...BASE, system: blocks })?.status).toBe(400);
    expect(validateRequest({ ...BASE, system: blocks.slice(0, 4) })).toBeNull();
    const mixed = [{ ...blocks[0] }, { ...blocks[1], cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }];
    expect(validateRequest({ ...BASE, system: mixed })?.status).toBe(400);
    expect(validateRequest({ ...BASE, system: [mixed[1], mixed[0]] })).toBeNull();
  });
});

describe('Messages API：响应和 usage', () => {
  it('输入 token 等于模板展开后的计数，各部分之和等于总数', () => {
    const breakdown = inputBreakdown(BASE);
    expect(breakdown.total).toBe(encodeWithSpecials('<|im_start|>system\n你是助手。<|im_end|>\n<|im_start|>user\n什么是 token？<|im_end|>\n<|im_start|>assistant\n').length);
    expect(breakdown.system + breakdown.tools + breakdown.messages[0] + breakdown.template).toBe(breakdown.total);
    const message = createMessage(BASE, [{ type: 'text', text: '是单位。' }], { id: 'msg_x' });
    expect(Object.keys(message)).toEqual(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']);
    expect(message.usage).toMatchObject({ input_tokens: breakdown.total, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: countTokens('是单位。') });
    expect(message.stop_reason).toBe('end_turn');
    expect(message.stop_sequence).toBeNull();
  });

  it('超过 max_tokens 按 token 截断，stop_reason 是 max_tokens', () => {
    const text = 'the model reads the tokens and the model writes the next token.';
    const message = createMessage({ ...BASE, max_tokens: 3 }, [{ type: 'text', text }], { id: 'm' });
    expect(message.stop_reason).toBe('max_tokens');
    expect(message.usage.output_tokens).toBe(3);
    expect(text.startsWith((message.content[0] as { text: string }).text)).toBe(true);
  });

  it('遇到停止序列就停，stop_sequence 是命中的那个', () => {
    const message = createMessage({ ...BASE, stop_sequences: ['END', '。'] }, [{ type: 'text', text: '第一句。第二句END' }], { id: 'm' });
    expect(message).toMatchObject({ stop_reason: 'stop_sequence', stop_sequence: '。', content: [{ type: 'text', text: '第一句' }] });
  });

  it('有 tool_use 块时 stop_reason 是 tool_use', () => {
    const message = createMessage(BASE, [{ type: 'text', text: '查一下。' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }], { id: 'm' });
    expect(message.stop_reason).toBe('tool_use');
  });

  it('错误响应：形状、状态码、request-id 头、可选的 retry-after', () => {
    expect(ERROR_STATUS).toMatchObject({ invalid_request_error: 400, authentication_error: 401, not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529 });
    const res = errorHttpResponse(apiError('rate_limit_error', 'slow down'), { requestId: 'req_1', retryAfter: 12 });
    expect(res.status).toBe(429);
    expect(res.headers).toContainEqual(['retry-after', '12']);
    expect(res.headers).toContainEqual(['request-id', 'req_1']);
    expect(JSON.parse(utf8Decode(res.body))).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' }, request_id: 'req_1' });
    expect(DOCUMENTED_ERRORS.overloaded).toBe('Overloaded');
    expect([429, 500, 529, 408].every(isRetryable)).toBe(true);
    expect([400, 401, 404, 413].some(isRetryable)).toBe(false);
  });

  it('HTTP 请求带 host、content-type、anthropic-version、x-api-key 和 content-length', () => {
    const req = messagesHttpRequest(BASE, { apiKey: 'k' });
    expect(req.headers.map(([name]) => name)).toEqual(['host', 'content-type', 'anthropic-version', 'x-api-key', 'content-length']);
    expect(req.headers).toContainEqual(['anthropic-version', '2026-10-21']);
    expect(Number(req.headers.at(-1)![1])).toBe(utf8Encode(JSON.stringify(BASE)).length);
  });

  it('示例 id 的形状', () => {
    expect(exampleId('msg', 1)).toMatch(/^msg_01[A-Za-z0-9]{22}$/);
    expect(exampleId('req', 1)).toMatch(/^req_011C[A-Za-z0-9]{20}$/);
    expect(exampleId('toolu', 2)).toMatch(/^toolu_01[A-Za-z0-9]{22}$/);
    expect(exampleId('msg', 1)).toBe(exampleId('msg', 1));
  });
});

describe('Messages API：流式事件', () => {
  const message = createMessage(BASE, [{ type: 'text', text: '模型读 token，模型写 token。' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'San Francisco, CA' } }], { id: 'msg_1' });
  const events = streamEvents(message);

  it('顺序：message_start、每个块 start / delta / stop、message_delta、message_stop，第一个块之后有 ping', () => {
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('message_start');
    expect(types.slice(1, 3)).toEqual(['content_block_start', 'ping']);
    expect(types.slice(-2)).toEqual(['message_delta', 'message_stop']);
    const start = events[0] as Extract<typeof events[number], { type: 'message_start' }>;
    expect(start.message).toMatchObject({ content: [], stop_reason: null, stop_sequence: null });
    expect(start.message.usage.output_tokens).toBe(1);
  });

  it('text_delta 拼起来是全文；input_json_delta 第一个是空串，拼起来能解析', () => {
    const text = events.flatMap((event) => (event.type === 'content_block_delta' && event.delta.type === 'text_delta' ? [event.delta.text] : [])).join('');
    expect(text).toBe('模型读 token，模型写 token。');
    const json = events.flatMap((event) => (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' ? [event.delta.partial_json] : []));
    expect(json[0]).toBe('');
    expect(JSON.parse(json.join(''))).toEqual({ location: 'San Francisco, CA' });
  });

  it('编码成 SSE 再解析、再拼回，得到同一条消息（SDK 的 finalMessage）', () => {
    const text = encodeEvents(events);
    expect(text.startsWith('event: message_start\ndata: {"type":"message_start"')).toBe(true);
    const parsed = parseStream(utf8Encode(text));
    expect(parsed.every((event) => JSON.parse(event.data).type === event.event)).toBe(true);
    expect(accumulate(parsed.map((event) => JSON.parse(event.data)))).toEqual(message);
  });
});

describe('OpenAI：Chat Completions 和 Responses', () => {
  const req: MessagesRequest = {
    model: 'claude-opus-5-5', max_tokens: 100, system: 'S',
    tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: '天气？' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }] },
    ],
  };

  it('Chat Completions：system 是第一条消息，工具嵌在 function 里，调用的 arguments 是 JSON 字符串，结果是 role: tool', () => {
    const cc = toChatCompletions(req, 'gpt-6-astra');
    expect(cc.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: '天气？' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    ]);
    expect(cc.tools![0]).toEqual({ type: 'function', function: { name: 'get_weather', description: 'd', parameters: req.tools![0].input_schema } });
    expect(cc.max_completion_tokens).toBe(100);
  });

  it('Chat Completions 的响应和流：usage 三个数，流以 data: [DONE] 结束，usage 块的 choices 为空', () => {
    const usage = chatUsage(10, 5);
    expect(usage.total_tokens).toBe(15);
    const completion = chatCompletion('gpt-6-astra', [{ type: 'text', text: 'hi' }], 'stop', usage, { id: 'chatcmpl-1', created: 1 });
    expect(completion.object).toBe('chat.completion');
    expect(completion.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: 'hi', refusal: null, annotations: [] }, logprobs: null, finish_reason: 'stop' });
    const stream = chatStream('gpt-6-astra', ['h', 'i'], 'stop', usage, { id: 'chatcmpl-1', created: 1 });
    expect(stream.endsWith('data: [DONE]\n\n')).toBe(true);
    const events = parseStream(stream);
    expect(events.every((event) => event.event === 'message')).toBe(true);
    const chunks = events.slice(0, -1).map((event) => JSON.parse(event.data));
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage });
  });

  it('Responses：system 变成 instructions，工具是扁平的，调用和结果是 function_call / function_call_output 条目', () => {
    const r = toResponses(req, 'gpt-6-astra');
    expect(r.instructions).toBe('S');
    expect(r.tools![0]).toEqual({ type: 'function', name: 'get_weather', description: 'd', parameters: req.tools![0].input_schema });
    expect(r.input).toEqual([
      { role: 'user', content: '天气？' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴' },
    ]);
    expect(toResponses(BASE).input).toBe('什么是 token？');
    const response = responseObject('gpt-6-astra', [{ type: 'text', text: 'hi' }], responsesUsage(10, 5), { id: 'resp_1', messageId: 'msg_1', created: 1 });
    expect(response).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  });
});

describe('计费', () => {
  it('示例单价符合定价页的倍率：5 分钟写 1.25 倍、1 小时写 2 倍、读按模型 0.05 或 0.1 倍', () => {
    for (const [model, price] of Object.entries(PRICES)) {
      expect(price.write5m, model).toBe(price.input * CACHE_WRITE_5M);
      expect(price.write1h, model).toBe(price.input * CACHE_WRITE_1H);
      expect(price.read, model).toBeCloseTo(price.input * CACHE_READ[model], 9);
    }
    expect(PRICES['claude-opus-5-5']).toEqual({ input: 4000, write5m: 5000, write1h: 8000, read: 200, output: 20000 });
  });

  it('100 万输入 token 在 Opus 5.5 上是 $4，费用是整数纳美元', () => {
    expect(costOf({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-opus-5-5').total).toBe(4e9);
    const cost = costOf({ input_tokens: 78, output_tokens: 54, cache_read_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 } }, 'claude-opus-5-5');
    expect(cost).toEqual({ input: 78 * 4000, write5m: 3 * 5000, write1h: 2 * 8000, read: 10 * 200, output: 54 * 20000, total: 78 * 4000 + 15000 + 16000 + 2000 + 54 * 20000 });
    expect(formatUsd(1_392_000)).toBe('$0.00139');
    expect(formatUsd(4e9)).toBe('$4');
    expect(formatUsd(25_000_000)).toBe('$0.025');
  });
});

describe('Prompt Caching', () => {
  // 一段够长的 system（超过 Opus 5.5 的最小可缓存长度 512），放一个 5 分钟断点。
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i} 条规则：回答要简洁，先给结论。`).join('\n');
  const req = (question: string, system = long, ttl?: '1h'): MessagesRequest => ({ ...BASE, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } }], messages: [{ role: 'user', content: question }] });

  it('第一次写入，第二次命中；读、写、未缓存三项之和是全部输入', () => {
    const cache = new PromptCache(MODELS['claude-opus-5-5'].cacheMin);
    const first = runCache(cache, req('问题一'), 0);
    const total1 = renderRequest(req('问题一')).tokens;
    expect(first.read).toBe(0);
    expect(first.write5m).toBeGreaterThan(512);
    expect(first.read + first.write5m + first.write1h + first.input).toBe(total1);
    const second = runCache(cache, req('另一个问题'), 60);
    expect(second.read).toBe(first.write5m);
    expect(second.write5m).toBe(0);
    const message = createMessage(req('另一个问题'), [{ type: 'text', text: '好' }], { id: 'm', cache: second });
    expect(totalInput(message.usage)).toBe(renderRequest(req('另一个问题')).tokens);
    expect(message.usage.cache_read_input_tokens).toBe(second.read);
  });

  it('前缀改一个字就不命中；过期之后不命中；读取会刷新有效期', () => {
    const cache = new PromptCache(512);
    runCache(cache, req('q'), 0);
    expect(runCache(cache, req('q', long.replace('第 0 条', '第 O 条')), 10).read).toBe(0);
    expect(runCache(cache, req('q'), 290).read).toBeGreaterThan(0);
    // 290 秒时的读取把有效期刷新到 590 秒。
    expect(runCache(cache, req('q'), 580).read).toBeGreaterThan(0);
    expect(runCache(cache, req('q'), 580 + 300).read).toBe(0);
  });

  it('1 小时 TTL 记在 ephemeral_1h 里；前缀不到最小长度时静默不写', () => {
    const cache = new PromptCache(512);
    const hour = runCache(cache, req('q', long, '1h'), 0);
    expect(hour.write1h).toBeGreaterThan(0);
    expect(hour.write5m).toBe(0);
    expect(runCache(cache, req('q', long, '1h'), 3000).read).toBe(hour.write1h);
    const short = runCache(new PromptCache(512), req('q', '很短的 system'), 0);
    expect(short).toMatchObject({ read: 0, write5m: 0, write1h: 0 });
    expect(short.tooShort).toHaveLength(1);
  });

  it('每个断点向前最多看 20 个块', () => {
    const blocks = (n: number, at: number): MessagesRequest => ({ ...BASE, system: Array.from({ length: n }, (_, i) => ({ type: 'text' as const, text: `${long}\n块 ${i}`, ...(i === at ? { cache_control: { type: 'ephemeral' as const } } : {}) })) });
    const cache = new PromptCache(512);
    runCache(cache, blocks(30, 2), 0);
    expect(runCache(cache, blocks(30, 21), 1).read).toBeGreaterThan(0);
    const fresh = new PromptCache(512);
    runCache(fresh, blocks(30, 2), 0);
    expect(runCache(fresh, blocks(30, 22), 1).read).toBe(0);
  });

  it('块的前缀哈希：同样的字节同样的哈希，断点必须落在内容块上', () => {
    const a = cacheBlocks(renderRequest(req('q')), new Map([['system[0]', '5m']]));
    const b = cacheBlocks(renderRequest(req('q')), new Map([['system[0]', '5m']]));
    expect(a.map((block) => block.hash)).toEqual(b.map((block) => block.hash));
    expect(() => cacheBlocks(renderRequest(req('q')), new Map([['tools', '5m']]))).toThrow();
  });
});

describe('上下文预算', () => {
  it('拆账：各部分加输出预留，超窗口时 fits 为 false', () => {
    const plan = planBudget(100, [{ id: 's', label: 'system', kind: 'system', tokens: 30 }, { id: 'h', label: '历史', kind: 'history', tokens: 50 }], 30);
    expect(plan).toMatchObject({ input: 80, used: 110, free: -10, fits: false });
    expect(plan.rows.map((row) => row.end)).toEqual([30, 80, 110]);
  });

  it('从最早的一问一答开始丢，最后一条永远保留', () => {
    const turns = [
      { role: 'user' as const, text: 'the model reads the tokens' },
      { role: 'assistant' as const, text: 'the model writes the next token' },
      { role: 'user' as const, text: 'a token is a piece of text' },
    ];
    const result = dropOldest(turns, countTokens(turns[2].text));
    expect(result.kept).toEqual([turns[2]]);
    expect(result.dropped).toHaveLength(2);
    expect(dropOldest(turns, 0).kept).toEqual([turns[2]]);
  });

  it('压缩：旧的几轮换成一条摘要，压缩比按真实 token 数算', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `the model reads the tokens and the model writes the next token. ${i}` }));
    const result = compact(turns, 2, () => '摘要：用户问了分词。');
    expect(result.kept).toHaveLength(3);
    expect(result.summaryTokens).toBe(countTokens('摘要：用户问了分词。'));
    expect(result.ratio).toBeCloseTo(turns.slice(0, 4).reduce((sum, turn) => sum + countTokens(turn.text), 0) / result.summaryTokens, 9);
    expect(result.after).toBeLessThan(result.before);
  });
});
