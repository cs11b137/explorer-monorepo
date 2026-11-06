/**
 * 接口组新增的计算核心：retry.ts（令牌桶、限流器、退避、一群客户端重试）、openai.ts 里 Responses 的流式事件和 OpenAI / OpenRouter 的错误。
 * 期望值手写自文档或手算，不从实现里取。
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@explorer/llm-core/prng';
import {
  DEFAULT_POLICY,
  encodeResponse,
  encodeResponsesStream,
  headerOf,
  MAX_RETRY_AFTER_SECONDS,
  OPENAI_ERRORS,
  openaiErrorBody,
  openaiErrorHttpResponse,
  openrouterErrorBody,
  parseMessage,
  parseStream,
  RateLimiter,
  responseObject,
  responsesErrorEvent,
  responsesFrame,
  responsesStreamEvents,
  responsesText,
  responsesUsage,
  retryTimeline,
  sdkRetries,
  simulateHerd,
  TokenBucket,
  waitBefore,
  worthRetrying,
} from '../src/core';
import { utf8Decode } from '@explorer/llm-core/utf8';

describe('令牌桶', () => {
  it('连续补充，装满为止，不是固定窗口清零', () => {
    const bucket = new TokenBucket(60, 1); // 60 个，每秒补 1 个
    expect(bucket.tryTake(60, 0)).toBe(true);
    expect(bucket.available(0)).toBe(0);
    expect(bucket.available(10)).toBeCloseTo(10, 9);
    expect(bucket.available(30)).toBeCloseTo(30, 9);
    expect(bucket.available(1000)).toBe(60);
  });

  it('不够就什么也不扣；waitFor 是缺口除以补充速度', () => {
    const bucket = new TokenBucket(10, 2);
    bucket.tryTake(10, 0);
    expect(bucket.tryTake(3, 1)).toBe(false); // 1 秒补了 2 个，不够 3 个
    expect(bucket.available(1)).toBeCloseTo(2, 9);
    expect(bucket.waitFor(3, 1)).toBeCloseTo(0.5, 9);
    expect(bucket.waitFor(11, 1)).toBe(Infinity); // 超过容量永远等不到
    expect(bucket.tryTake(3, 1.5)).toBe(true);
  });

  it('spend 可以扣成负数，之后要等补回来', () => {
    const bucket = new TokenBucket(10, 5);
    bucket.spend(15, 0);
    expect(bucket.level).toBe(-5);
    expect(bucket.waitFor(1, 0)).toBeCloseTo(1.2, 9); // (1 - (-5)) / 5
  });

  it('时间不能倒流', () => {
    const bucket = new TokenBucket(1, 1);
    bucket.available(5);
    expect(() => bucket.available(4)).toThrow();
  });
});

describe('三个限额的限流器', () => {
  it('RPM：额度用完后第 n+1 个被拒绝，retry-after 向上取整、至少 1 秒', () => {
    const limiter = new RateLimiter({ rpm: 6, itpm: 100000, otpm: 100000 });
    for (let i = 0; i < 6; i++) expect(limiter.admit(10, i * 0.1).ok).toBe(true);
    const verdict = limiter.admit(10, 0.6);
    // 6 RPM = 每 10 秒补 1 个；0.6 秒补了 0.06 个，还差 0.94 个 = 9.4 秒。
    expect(verdict).toMatchObject({ ok: false, limit: 'requests', retryAfter: 10 });
    if (!verdict.ok) expect(verdict.waitSeconds).toBeCloseTo(9.4, 9);
    // 被拒绝的请求不扣任何桶。
    const before = limiter.input.available(0.6);
    limiter.admit(10, 0.6);
    expect(limiter.input.available(0.6)).toBe(before);
  });

  it('ITPM：输入 token 不够时拒绝，缺口最大的那个桶决定 retry-after', () => {
    const limiter = new RateLimiter({ rpm: 1000, itpm: 600, otpm: 1000 }); // 输入每秒补 10 个
    expect(limiter.admit(500, 0).ok).toBe(true);
    const verdict = limiter.admit(300, 0); // 剩 100，缺 200，要等 20 秒
    expect(verdict).toMatchObject({ ok: false, limit: 'input_tokens', retryAfter: 20 });
    expect(limiter.admit(300, 20).ok).toBe(true);
  });

  it('OTPM：输出按实际生成量事后扣，欠着的时候新请求要等', () => {
    const limiter = new RateLimiter({ rpm: 1000, itpm: 100000, otpm: 120 }); // 输出每秒补 2 个
    expect(limiter.admit(1, 0).ok).toBe(true);
    limiter.recordOutput(180, 0); // 实际写了 180 个，桶欠 60
    const verdict = limiter.admit(1, 0);
    expect(verdict).toMatchObject({ ok: false, limit: 'output_tokens' });
    if (!verdict.ok) expect(verdict.waitSeconds).toBeCloseTo(30.5, 9); // (1 + 60) / 2
  });

  it('响应头用文档里的名字，reset 是 RFC 3339', () => {
    const limiter = new RateLimiter({ rpm: 6, itpm: 500, otpm: 400 });
    limiter.admit(78, 0);
    const headers = limiter.headers(0, Date.UTC(2026, 10, 6, 2, 0, 0) / 1000);
    expect(headers.map(([name]) => name)).toEqual([
      'anthropic-ratelimit-requests-limit',
      'anthropic-ratelimit-requests-remaining',
      'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-input-tokens-limit',
      'anthropic-ratelimit-input-tokens-remaining',
      'anthropic-ratelimit-input-tokens-reset',
      'anthropic-ratelimit-output-tokens-limit',
      'anthropic-ratelimit-output-tokens-remaining',
      'anthropic-ratelimit-output-tokens-reset',
    ]);
    expect(headerOf(headers, 'anthropic-ratelimit-requests-limit')).toBe('6');
    expect(headerOf(headers, 'anthropic-ratelimit-requests-remaining')).toBe('5');
    expect(headerOf(headers, 'anthropic-ratelimit-input-tokens-remaining')).toBe('422');
    // 请求桶少了 1 个，每 10 秒补 1 个，10 秒后补满。
    expect(headerOf(headers, 'anthropic-ratelimit-requests-reset')).toBe('2026-11-06T02:00:10.000Z');
    expect(headerOf(headers, 'anthropic-ratelimit-output-tokens-reset')).toBe('2026-11-06T02:00:00.000Z');
  });
});

describe('退避', () => {
  const fixed = (value: number) => () => value;

  it('没有 retry-after：min(封顶, 起步 × 2^n)，抖动 0 时就是它', () => {
    const policy = { ...DEFAULT_POLICY, jitter: 0 };
    const waits = [0, 1, 2, 3, 4, 5, 6].map((n) => waitBefore(policy, n, fixed(0.5)).ms);
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('抖动：等待落在 [(1 - jitter) × 退避, 退避]，rand 为 0 取上限，接近 1 取下限', () => {
    const policy = { ...DEFAULT_POLICY, jitter: 0.25 };
    expect(waitBefore(policy, 2, fixed(0)).ms).toBe(2000);
    expect(waitBefore(policy, 2, fixed(0.999999)).ms).toBe(1500);
    expect(waitBefore(policy, 2, fixed(0.5)).ms).toBe(1750);
    const rand = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      const ms = waitBefore(policy, 3, rand).ms;
      expect(ms).toBeGreaterThanOrEqual(3000);
      expect(ms).toBeLessThanOrEqual(4000);
    }
  });

  it('retry-after 在 0 到 60 秒之间就照它等，超过就退回自己的退避', () => {
    expect(waitBefore(DEFAULT_POLICY, 0, fixed(0), 7)).toEqual({ ms: 7000, source: 'retry-after', ceiling: 0 });
    expect(waitBefore(DEFAULT_POLICY, 0, fixed(0), 0).ms).toBe(0);
    expect(MAX_RETRY_AFTER_SECONDS).toBe(60);
    expect(waitBefore(DEFAULT_POLICY, 0, fixed(0), 61).source).toBe('backoff');
    expect(waitBefore(DEFAULT_POLICY, 0, fixed(0), -1).source).toBe('backoff');
    expect(waitBefore(DEFAULT_POLICY, 0, fixed(0), Number.NaN).source).toBe('backoff');
  });

  it('同样的种子得到同样的等待', () => {
    const run = () => retryTimeline(() => ({ status: 529 }), DEFAULT_POLICY, mulberry32(9)).map((row) => row.wait?.ms ?? null);
    expect(run()).toEqual(run());
  });
});

describe('该不该重试', () => {
  it('SDK 按状态码：408、409、429、5xx 重试，其余 4xx 不重试', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) expect(sdkRetries(status), String(status)).toBe(true);
    for (const status of [400, 401, 402, 403, 404, 413, 422]) expect(sdkRetries(status), String(status)).toBe(false);
  });

  it('月度消费上限的 429 值得重试吗：SDK 会重试，但没用', () => {
    expect(worthRetrying({ status: 429 })).toBe(true);
    expect(worthRetrying({ status: 429, hopeless: true })).toBe(false);
    expect(sdkRetries(429)).toBe(true);
  });

  it('重试循环：成功就停，不值得重试就停，用完 maxRetries 就停', () => {
    const rand = mulberry32(3);
    expect(retryTimeline(() => ({ status: 200 }), DEFAULT_POLICY, rand).map((row) => row.status)).toEqual([200]);
    expect(retryTimeline(() => ({ status: 400 }), DEFAULT_POLICY, rand)).toHaveLength(1);
    expect(retryTimeline(() => ({ status: 429, hopeless: true }), DEFAULT_POLICY, rand)).toHaveLength(1);
    const rows = retryTimeline(() => ({ status: 529 }), DEFAULT_POLICY, rand);
    expect(rows).toHaveLength(3); // 第一次加 2 次重试
    expect(rows[2].wait).toBeNull();
    expect(retryTimeline(() => ({ status: 529 }), { ...DEFAULT_POLICY, maxRetries: 0 }, rand)).toHaveLength(1);
  });

  it('时间线：每次尝试的时刻 = 上一次的时刻 + 等待', () => {
    const rows = retryTimeline((attempt) => (attempt < 3 ? { status: 429, retryAfter: attempt === 1 ? 4 : null } : { status: 200 }), DEFAULT_POLICY, mulberry32(5), 2);
    expect(rows[0].at).toBe(2);
    expect(rows[1].at).toBeCloseTo(6, 9); // 照 retry-after 等 4 秒
    expect(rows[1].wait!.source).toBe('backoff'); // 第二次没有 retry-after
    expect(rows[2].at).toBeCloseTo(6 + rows[1].wait!.ms / 1000, 9);
  });
});

describe('一群客户端同时重试', () => {
  const options = { clients: 30, capacity: 5, refillPerSecond: 4, seed: 7 };

  it('无抖动：第一轮 5 个成功，其余 25 个在 0.5 秒时同时回来', () => {
    const result = simulateHerd({ ...options, policy: { ...DEFAULT_POLICY, maxRetries: 4, jitter: 0 } });
    expect(result.perAttempt[0]).toBe(30);
    expect(result.perAttempt[1]).toBe(25); // 第一轮只有桶里的 5 个令牌够
    expect(result.peak).toBe(25);
  });

  it('抖动削峰：完全随机的峰值远低于无抖动，而且更多的客户端是同一时刻 25 个', () => {
    const peak = (jitter: number) => simulateHerd({ ...options, policy: { ...DEFAULT_POLICY, maxRetries: 4, jitter } }).peak;
    expect(peak(1)).toBeLessThan(peak(0.25));
    expect(peak(0.25)).toBeLessThan(peak(0));
  });

  it('确定性：同样的种子同样的结果；每个客户端要么成功要么放弃', () => {
    const run = () => simulateHerd({ ...options, policy: { ...DEFAULT_POLICY, maxRetries: 4, jitter: 1 } });
    expect(run()).toEqual(run());
    const result = run();
    expect(result.succeeded + result.gaveUp).toBe(30);
    expect(result.doneAt.filter((t) => t !== null)).toHaveLength(result.succeeded);
    expect(result.requests).toBe(result.perAttempt.reduce((a, b) => a + b, 0));
  });
});

// ---------- Responses 的流式事件 ----------

const message = { type: 'text' as const, text: '你好，世界' };
const response = responseObject('gpt-6-astra', [message], responsesUsage(11, 5), { id: 'resp_1', messageId: 'msg_1', created: 1 });

describe('Responses 的流式事件', () => {
  const events = responsesStreamEvents(response, ['你好', '，世', '界']);

  it('顺序照文档：created → in_progress → output_item.added → content_part.added → delta… → done 三连 → completed', () => {
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('sequence_number 从 0 开始逐个加 1', () => {
    expect(events.map((event) => event.sequence_number)).toEqual([...events.keys()]);
  });

  it('delta 事件的字段：item_id、output_index、content_index、delta、logprobs', () => {
    const delta = events[4];
    expect(Object.keys(delta)).toEqual(['type', 'item_id', 'output_index', 'content_index', 'delta', 'logprobs', 'sequence_number']);
    expect(delta).toMatchObject({ item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你好', logprobs: [] });
  });

  it('created 时 output 为空、usage 为 null、status in_progress；completed 带完整 response 和 usage', () => {
    const created = events[0].response as { status: string; output: unknown[]; usage: unknown };
    expect(created).toMatchObject({ status: 'in_progress', output: [], usage: null });
    const completed = events[10].response as typeof response;
    expect(completed.status).toBe('completed');
    expect(completed.usage).toEqual({ input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 });
    expect(completed.output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: '你好，世界' }] });
  });

  it('item 在 added 时 content 为空、status in_progress，done 时 completed 且带完整文字', () => {
    expect(events[2].item).toEqual({ id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] });
    expect(events[9].item).toMatchObject({ status: 'completed', content: [{ type: 'output_text', text: '你好，世界' }] });
    expect(events[7]).toMatchObject({ text: '你好，世界' });
  });

  it('被 max_output_tokens 截断时最后一个事件是 response.incomplete', () => {
    const cut = responseObject('gpt-6-astra', [message], responsesUsage(11, 5), { id: 'resp_1', messageId: 'msg_1', created: 1, incomplete: true });
    const last = responsesStreamEvents(cut, ['你好', '，世界']).at(-1)!;
    expect(last.type).toBe('response.incomplete');
  });

  it('片段拼不回回复文字时报错；多条输出不支持', () => {
    expect(() => responsesStreamEvents(response, ['你好'])).toThrow();
  });

  it('SSE 帧：event 行和 data 里的 type 相同，type 在最前、sequence_number 在最后', () => {
    const frame = responsesFrame(events[4]);
    expect(frame.event).toBe('response.output_text.delta');
    expect(frame.data).toBe('{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"你好","logprobs":[],"sequence_number":4}');
    const text = encodeResponsesStream(events);
    expect(text.startsWith('event: response.created\ndata: {"type":"response.created","response":{')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(true);
    expect(text).not.toContain('[DONE]');
  });

  it('SseParser 解析回来：事件数、类型、文字都对得上', () => {
    const parsed = parseStream(encodeResponsesStream(events));
    expect(parsed).toHaveLength(11);
    expect(parsed.map((item) => item.event)).toEqual(events.map((event) => event.type));
    const objects = parsed.map((item) => JSON.parse(item.data) as { type: string; delta?: string });
    expect(objects.every((object, i) => object.type === parsed[i].event)).toBe(true);
    expect(responsesText(objects)).toBe('你好，世界');
  });

  it('错误事件：type error，带 code、message、param、sequence_number', () => {
    const event = responsesErrorEvent('ERR_SOMETHING', 'Something went wrong', 1);
    expect(JSON.stringify(event)).toBe('{"type":"error","code":"ERR_SOMETHING","message":"Something went wrong","param":null,"sequence_number":1}');
  });
});

// ---------- OpenAI、OpenRouter 的错误 ----------

describe('OpenAI 的错误', () => {
  it('错误体：外层 error，里面 message、type、param、code', () => {
    const body = openaiErrorBody(OPENAI_ERRORS.slowDown);
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['message', 'type', 'param', 'code']);
    expect(body.error).toMatchObject({ type: 'rate_limit_error', code: 'slow_down', param: null });
  });

  it('文档给出的 type、code 和状态码', () => {
    expect(OPENAI_ERRORS.slowDown).toMatchObject({ status: 429, type: 'rate_limit_error', code: 'slow_down' });
    expect(OPENAI_ERRORS.overloaded).toMatchObject({ status: 503, type: 'service_unavailable_error', code: 'server_is_overloaded' });
    expect(OPENAI_ERRORS.noCredit).toMatchObject({ status: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota' });
    expect(OPENAI_ERRORS.serviceTier).toMatchObject({ status: 400, type: 'invalid_request_error', param: 'service_tier', documented: true });
    expect(OPENAI_ERRORS.serviceTier.message).toBe('Invalid `service_tier` argument: The requested service tier is not allowed for this project.');
    // 只有 service_tier 这一条的措辞是文档逐字给出的。
    expect([OPENAI_ERRORS.slowDown, OPENAI_ERRORS.overloaded, OPENAI_ERRORS.noCredit].every((error) => !error.documented)).toBe(true);
  });

  it('错误响应：x-request-id、可选 retry-after，字节解析回来一致', () => {
    const response = openaiErrorHttpResponse(OPENAI_ERRORS.overloaded, { requestId: 'req_x', retryAfter: 3 });
    expect(response.status).toBe(503);
    expect(headerOf(response.headers, 'retry-after')).toBe('3');
    expect(headerOf(response.headers, 'x-request-id')).toBe('req_x');
    expect(headerOf(openaiErrorHttpResponse(OPENAI_ERRORS.slowDown, { requestId: 'r' }).headers, 'retry-after')).toBeUndefined();
    const layout = encodeResponse(response);
    expect(utf8Decode(layout.bytes.slice(...layout.startLine))).toBe('HTTP/1.1 503 Service Unavailable\r\n');
    const parsed = parseMessage(layout.bytes);
    expect(JSON.parse(utf8Decode(parsed.body))).toEqual(openaiErrorBody(OPENAI_ERRORS.overloaded));
  });
});

describe('OpenRouter 的错误', () => {
  it('error 里 code 是数字，message，可选 metadata', () => {
    expect(JSON.stringify(openrouterErrorBody(429, 'Rate limit exceeded'))).toBe('{"error":{"code":429,"message":"Rate limit exceeded"}}');
    expect(JSON.stringify(openrouterErrorBody(403, 'x', { limit_source: 'openrouter_key_limit' }))).toBe('{"error":{"code":403,"message":"x","metadata":{"limit_source":"openrouter_key_limit"}}}');
  });
});
