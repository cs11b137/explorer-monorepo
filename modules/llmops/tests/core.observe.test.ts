/**
 * 计算核心（可观测性）：trace / span id、traceparent、span 树、GenAI 属性、OTLP/JSON、概率采样、模拟延迟、监控、一次模型调用的账。
 * 期望值取自 W3C Trace Context、OTLP、OpenTelemetry 规范里的例子（出处见 README 事实表），或手算。
 */
import { describe, expect, it } from 'vitest';
import {
  agentAttrs,
  agentSpanName,
  attrOf,
  callModel,
  chatRequestAttrs,
  chatResponseAttrs,
  chatSpanName,
  costOf,
  encodeOtlp,
  evaluateAlert,
  flattenTree,
  formatTraceparent,
  GENAI,
  GENAI_DURATION_BUCKETS,
  inputBreakdown,
  int,
  otlpHttpRequest,
  otlpTraces,
  parseMessage,
  parseTraceparent,
  probabilitySample,
  randomnessOf,
  rejectionThreshold,
  replyText,
  simulateCalls,
  simulateTraffic,
  spanIdOf,
  spanTree,
  tailSample,
  thValue,
  toEvalCase,
  toolAttrs,
  toolSpanName,
  traceIdOf,
  Tracer,
  unixNano,
  windows,
  type MessagesRequest,
} from '../src/core';

describe('trace id 和 traceparent', () => {
  it('id：固定种子，小写十六进制，长度 32 / 16，不全为 0', () => {
    expect(traceIdOf(1)).toBe(traceIdOf(1));
    expect(traceIdOf(1)).not.toBe(traceIdOf(2));
    expect(traceIdOf(1)).toMatch(/^[0-9a-f]{32}$/);
    expect(spanIdOf(1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('W3C 的例子：00-4bf92f…-00f067aa0ba902b7-01 是 sampled，-00 不是', () => {
    const p = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(p).toEqual({ ok: true, ctx: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: 1 }, sampled: true, random: false });
    const q = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
    expect(q.ok && q.sampled).toBe(false);
    expect(formatTraceparent({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: 3 })).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03');
    expect(formatTraceparent({ traceId: traceIdOf(5), spanId: spanIdOf(5), flags: 1 })).toHaveLength(55);
  });

  it('无效的头：全 0 的 id、版本 ff、大写、长度不对', () => {
    const reason = (v: string) => {
      const p = parseTraceparent(v);
      return p.ok ? null : p.reason;
    };
    expect(reason('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBe('trace-id 全为 0，无效');
    expect(reason('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBe('parent-id 全为 0，无效');
    expect(reason('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe('版本 ff 无效');
    expect(reason('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01')).toMatch(/^格式不对/);
    expect(reason('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7')).toMatch(/^长度应为 55/);
  });
});

describe('span 和 GenAI 语义约定', () => {
  function sample() {
    const tracer = new Tracer(traceIdOf(7), 70);
    const root = tracer.start(agentSpanName('support'), 'INTERNAL', null, 0, agentAttrs('support'));
    const chat = tracer.start(chatSpanName('claude-opus-5-5'), 'CLIENT', root, 10, chatRequestAttrs('claude-opus-5-5', 1024));
    tracer.end(chat, 400, chatResponseAttrs({ id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }, 0.25));
    const tool = tracer.start(toolSpanName('get_order'), 'INTERNAL', root, 400, toolAttrs('get_order', 'toolu_1'));
    tracer.end(tool, 430);
    tracer.end(root, 500, [], { code: 'OK' });
    return tracer;
  }

  it('span 名、kind、属性名照语义约定', () => {
    const { spans } = sample();
    expect(spans.map((s) => [s.name, s.kind])).toEqual([['invoke_agent support', 'INTERNAL'], ['chat claude-opus-5-5', 'CLIENT'], ['execute_tool get_order', 'INTERNAL']]);
    const chat = spans[1];
    expect(attrOf(chat, 'gen_ai.provider.name')).toBe('anthropic');
    expect(attrOf(chat, GENAI.operation)).toBe('chat');
    // Anthropic 的 input_tokens 不含缓存，约定要求加回去：100 + 50。
    expect(attrOf(chat, 'gen_ai.usage.input_tokens')).toBe(150);
    expect(attrOf(chat, 'gen_ai.usage.cache_read.input_tokens')).toBe(50);
    expect(attrOf(chat, 'gen_ai.usage.cache_write.input_tokens')).toBeUndefined();
    expect(attrOf(chat, 'gen_ai.response.finish_reasons')).toEqual(['tool_use']);
    expect(attrOf(chat, 'gen_ai.response.time_to_first_chunk')).toBe(0.25);
    expect(attrOf(spans[2], 'gen_ai.tool.call.id')).toBe('toolu_1');
    expect(() => int(1.5)).toThrow();
  });

  it('span 树：父子、深度、自身耗时', () => {
    const tree = spanTree(sample().spans);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.span.name)).toEqual(['chat claude-opus-5-5', 'execute_tool get_order']);
    // 根 500 毫秒，子 span 覆盖 10–400 和 400–430，自身 500 − 420 = 80。
    expect(tree[0].self).toBe(80);
    expect(flattenTree(tree).map((n) => n.depth)).toEqual([0, 1, 1]);
  });

  it('OTLP/JSON：lowerCamelCase、十六进制 id、枚举是整数、64 位整数写成字符串', () => {
    const { spans } = sample();
    const body = otlpTraces({ attributes: [['service.name', 'xiaopu-support']] }, { name: 'xiaopu.support', version: '1.0.0' }, spans);
    const out = body.resourceSpans[0].scopeSpans[0].spans;
    expect(out[0]).not.toHaveProperty('parentSpanId');
    expect(out[1]).toMatchObject({ traceId: spans[1].traceId, spanId: spans[1].spanId, parentSpanId: spans[0].spanId, kind: 3, startTimeUnixNano: unixNano(10) });
    expect(out[0].status).toEqual({ code: 1 });
    expect(out[1].attributes.find((a) => a.key === 'gen_ai.request.max_tokens')!.value).toEqual({ intValue: '1024' });
    expect(out[1].attributes.find((a) => a.key === 'gen_ai.response.finish_reasons')!.value).toEqual({ arrayValue: { values: [{ stringValue: 'tool_use' }] } });
    expect(out[1].attributes.find((a) => a.key === 'gen_ai.response.time_to_first_chunk')!.value).toEqual({ doubleValue: 0.25 });
    // EXAMPLE_EPOCH 是 2026-11-06T02:00:00Z = 1793930400 秒；1.5 毫秒 = 1,500,000 纳秒。
    expect(unixNano(1.5)).toBe('1793930400001500000');
    const json = encodeOtlp(body);
    expect(json.text).toBe(JSON.stringify(body));
  });

  it('OTLP/HTTP：POST /v1/traces，Content-Type application/json，端口 4318', () => {
    const json = encodeOtlp(otlpTraces({ attributes: [] }, { name: 's' }, sample().spans));
    const req = otlpHttpRequest(json);
    expect([req.method, req.target]).toEqual(['POST', '/v1/traces']);
    expect(req.headers).toContainEqual(['content-type', 'application/json']);
    expect(req.headers[0][1]).toMatch(/:4318$/);
  });
});

describe('概率采样', () => {
  it('拒绝阈值 T = (1 − p) × 2^56；th 的写法和 OpenTelemetry 文档的例子相同', () => {
    expect(rejectionThreshold(0.5)).toBe(1n << 55n);
    expect(rejectionThreshold(0.25)).toBe(3n << 54n);
    expect(rejectionThreshold(1)).toBe(0n);
    expect(thValue(rejectionThreshold(0.5))).toBe('8');
    expect(thValue(rejectionThreshold(0.25))).toBe('c');
    expect(thValue(rejectionThreshold(0.1))).toBe('e666');
    expect(thValue(rejectionThreshold(0.01))).toBe('fd71');
    expect(thValue(rejectionThreshold(0.01), 5)).toBe('fd70a');
    expect(thValue(rejectionThreshold(0.01), 6)).toBe('fd70a4');
    expect(thValue(0n)).toBe('0');
    expect(() => rejectionThreshold(0)).toThrow();
  });

  it('R 取 trace id 最右 7 个字节，R ≥ T 才采样；概率越高采样的集合越大', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(randomnessOf(id)).toBe(0xce929d0e0e4736n);
    expect(probabilitySample(id, 1).sampled).toBe(true);
    const ids = Array.from({ length: 400 }, (_, i) => traceIdOf(1000 + i));
    const at = (p: number) => new Set(ids.filter((t) => probabilitySample(t, p).sampled));
    const tenth = at(0.1);
    const half = at(0.5);
    for (const t of tenth) expect(half.has(t)).toBe(true);
    expect(half.size / ids.length).toBeGreaterThan(0.4);
    expect(half.size / ids.length).toBeLessThan(0.6);
  });
});

describe('延迟和监控（模拟）', () => {
  it('模拟延迟：固定种子可重复；直方图按 GenAI 指标的桶边界，总数等于次数', () => {
    expect(GENAI_DURATION_BUCKETS).toHaveLength(14);
    const a = simulateCalls(200, 'claude-opus-5-5', 1000, 150, 9);
    const b = simulateCalls(200, 'claude-opus-5-5', 1000, 150, 9);
    expect(a).toEqual(b);
    expect(a.buckets.reduce((x, y) => x + y, 0)).toBe(200);
    expect(a.total.p50).toBeLessThan(a.total.p95);
    expect(a.total.p95).toBeLessThanOrEqual(a.total.p99);
    for (const t of a.timings) expect(t.total).toBeGreaterThanOrEqual(t.ttft);
  });

  it('模拟流量、窗口、告警（连续两个窗口超标才触发）', () => {
    const records = simulateTraffic({ minutes: 10, perMinute: 30, seed: 4, baseLatencyMs: 1200, errorRate: 0.01, incident: { from: 4, to: 7, latencyFactor: 3, errorRate: 0.3 }, inputs: ['q'], users: ['u1', 'u2'], costPerRequest: 4_000_000 });
    expect(records).toHaveLength(300);
    const ws = windows(records);
    expect(ws).toHaveLength(10);
    expect(ws.reduce((a, w) => a + w.count, 0)).toBe(300);
    const alerts = evaluateAlert(ws, { name: '出错率', metric: 'errorRate', above: 0.1, forWindows: 2 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].firedAt).toBe(5 * 60);
    expect(alerts[0].resolvedAt).toBe(7 * 60);
  });

  it('尾部采样和回流', () => {
    const base = { id: 'req-0001', traceId: traceIdOf(1), at: 0, user: 'u', input: '问题', latencyMs: 100, cost: 0, error: null, flagged: false, thumbsDown: false };
    const policy = { baseRate: 0.01, slowerThanMs: 5000 };
    expect(tailSample({ ...base, error: 'overloaded_error' }, policy)).toBe('error');
    expect(tailSample({ ...base, latencyMs: 9000 }, policy)).toBe('slow');
    expect(tailSample({ ...base, thumbsDown: true }, policy)).toBe('feedback');
    expect(toEvalCase(base, 'feedback')).toEqual({ id: 'prod-req-0001', input: '问题', expected: null, tags: ['production', 'feedback'] });
  });
});

describe('一次模型调用的账', () => {
  it('usage 来自本站分词器，费用按示例单价，HTTP 体就是 Message 的 JSON', () => {
    const req: MessagesRequest = { model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] };
    const call = callModel(req, '您好，有什么可以帮您？', 1);
    expect(call.message.usage.input_tokens).toBe(inputBreakdown(req).total);
    expect(call.cost).toEqual(costOf(call.message.usage, 'claude-haiku-5-5'));
    expect(call.cost.total).toBe(call.message.usage.input_tokens * 100 + call.message.usage.output_tokens * 500);
    expect(replyText(call.message)).toBe('您好，有什么可以帮您？');
    const parsed = parseMessage(call.http.response.bytes);
    expect(JSON.parse(Buffer.from(parsed.body).toString('utf8'))).toEqual(call.message);
  });
});
