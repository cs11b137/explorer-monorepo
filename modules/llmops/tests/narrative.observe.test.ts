/**
 * 文案和计算结果对得上（可观测性组：trace、cost、monitor）。
 * 关键的数写死在这里（改了脚本、种子或参数会立刻报错），再用独立的写法核对：手算费用、JSON.stringify、正则解析 traceparent、
 * 排序后直接取第 ⌈qn⌉ 个、BigInt 手算采样阈值。文字里没法取值的说法（「最贵的也是最慢的」「出错的不进评估集」）逐条核对。
 */
import { describe, expect, it } from 'vitest';
import { costOf, countTokens, GENAI_DURATION_BUCKETS, inputBreakdown, redact } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import * as C from '../src/lessons/cost';
import * as M from '../src/lessons/monitor';
import { SIGNED_DAYS } from '../src/lessons/scenario';
import * as T from '../src/lessons/trace';
import { packetsOf } from '../src/lessons/types';

const detailOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step].detail;
const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);

describe('一次请求的 trace', () => {
  const lesson = LESSON_BY_ID.trace;

  it('三次模型调用：token 是本站分词器的计数，费用按示例单价手算', () => {
    expect([T.numbers.screenInput, T.numbers.screenOutput, T.numbers.input1, T.numbers.output1, T.numbers.input2, T.numbers.output2]).toEqual([237, 27, 560, 95, 841, 168]);
    expect(T.chat2.message.usage.input_tokens).toBe(inputBreakdown(T.req2).total);
    expect(T.chat2.message.usage.output_tokens).toBe(countTokens(T.chat2.message.content[0].type === 'text' ? T.chat2.message.content[0].text : ''));
    expect(T.screen.cost.total).toBe(237 * 100 + 27 * 500);
    expect(T.chat1.cost.total).toBe(560 * 4000 + 95 * 20000);
    expect(T.chat2.cost.total).toBe(841 * 4000 + 168 * 20000);
    expect(T.numbers.totalCostNano).toBe(10_901_200);
    expect([T.numbers.screenCost, T.numbers.cost1, T.numbers.cost2, T.numbers.totalCost]).toEqual(['$0.0000372', '$0.00414', '$0.00672', '$0.0109']);
    expect([T.numbers.stop1, T.numbers.stop2]).toEqual(['tool_use', 'end_turn']);
  });

  it('费用列：只在三次 INFER 上增加，最后等于三次调用之和', () => {
    const packets = packetsOf(lesson);
    const infer = packets.filter((p) => p.row.type === 'INFER').map((p) => p.row.cost);
    expect(infer).toEqual([37_200, 37_200 + 4_140_000, 10_901_200]);
    expect(packets[packets.length - 1].row.cost).toBe(10_901_200);
    expect(lesson.costNote).toBe('这次请求调用了三次模型：Claude Haiku 5.5 筛查 $0.0000372，Claude Opus 5.5 两轮 $0.00414 和 $0.00672，合计 $0.0109；记 span、导出 trace 不花模型的钱。');
  });

  it('span 树：7 个 span，名字和 kind 照 GenAI 约定，父子关系对', () => {
    expect(T.spans.map((s) => [s.name, s.kind])).toEqual([
      ['invoke_agent xiaopu-support', 'INTERNAL'],
      ['guard input', 'INTERNAL'],
      ['chat claude-haiku-5-5', 'CLIENT'],
      ['chat claude-opus-5-5', 'CLIENT'],
      ['execute_tool get_order', 'INTERNAL'],
      ['chat claude-opus-5-5', 'CLIENT'],
      ['guard output', 'INTERNAL'],
    ]);
    expect(new Set(T.spans.map((s) => s.traceId))).toEqual(new Set([T.traceId]));
    expect(T.screenSpan.parentSpanId).toBe(T.guardIn.spanId);
    expect(T.spans.filter((s) => s.parentSpanId === T.root.spanId)).toHaveLength(5);
    expect(T.flat.map((n) => n.depth)).toEqual([0, 1, 2, 1, 1, 1, 1]);
    // 根 7,169.5 ms，子 span 覆盖的时间之外只剩相邻两步之间的 6 个 1 ms 间隔。
    expect(T.numbers.rootMs).toBe(7169.5);
    expect(T.numbers.rootSelf).toBe(6);
    expect([T.numbers.screenMs, T.numbers.chat1Ms, T.numbers.toolMs, T.numbers.chat2Ms]).toEqual([336, 2269.6, 39.8, 4513.1]);
    expect(detailOf('trace', 4)).toContain('根 7,169.5 ms，去掉子 span 覆盖的时间，自身只剩 6 ms');
  });

  it('traceparent：55 个字符，parent-id 是 chat 1 这个 CLIENT span，flags 01', () => {
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(T.traceparent)!;
    expect(m).not.toBeNull();
    expect([m[1], m[2], m[3]]).toEqual([T.traceId, T.chatSpan1.spanId, '01']);
    expect(T.traceparent).toBe('00-582181b0baeb03bf09ce010b9a100a57-fa1a7f56f1ca8e12-01');
    expect(T.http1.headers.find((h) => h.name === 'traceparent')!.value).toBe(T.traceparent);
    expect(T.numbers.requestBytes).toBe(1074);
    expect(T.req1.stream).toBe(true);
    expect(detailOf('trace', 1)).toContain('parent id 写的是调用方当前 span 的 id，也就是 chat 1 自己，flags 01 表示 sampled');
    expect(detailOf('trace', 1)).toContain('sampled 关着时它不产生 span');
  });

  it('GenAI 属性：provider anthropic、input_tokens 没有缓存时等于 usage、工具 span 记 tool_use 的 id', () => {
    const attrs = Object.fromEntries(T.chatSpan1.attributes.map(([k, v]) => [k, v]));
    expect(attrs['gen_ai.provider.name']).toBe('anthropic');
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.usage.input_tokens']).toEqual({ int: T.chat1.message.usage.input_tokens });
    expect(T.chat1.message.usage.cache_read_input_tokens + T.chat1.message.usage.cache_creation_input_tokens).toBe(0);
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(attrs['gen_ai.response.finish_reasons']).toEqual(['tool_use']);
    expect(attrs['gen_ai.response.time_to_first_chunk']).toBe(0.4593);
    expect(T.numbers.attrCount1).toBe(12);
    expect(Object.fromEntries(T.toolSpan.attributes)['gen_ai.tool.call.id']).toBe(T.toolUse.id);
    // 非流式的筛查调用没有 time_to_first_chunk。
    expect(T.screenSpan.attributes.some(([k]) => k === 'gen_ai.response.time_to_first_chunk')).toBe(false);
    expect(detailOf('trace', 3)).toContain('这次没有用缓存，所以两个数相同（560、841）');
  });

  it('OTLP/JSON：和 JSON.stringify 逐字节相同，POST /v1/traces 到 4318', () => {
    expect(T.otlp.text).toBe(JSON.stringify(T.otlpBody));
    const span = T.otlpBody.resourceSpans[0].scopeSpans[0].spans[3];
    expect(span.kind).toBe(3);
    expect(span.parentSpanId).toBe(T.root.spanId);
    expect(span.startTimeUnixNano).toBe('1793930400341000000');
    expect([T.numbers.otlpBytes, T.numbers.otlpRequestBytes, T.numbers.spansBytes, T.numbers.resourceBytes, T.numbers.scopeBytes]).toEqual([5199, 5323, 5008, 80, 43]);
    expect(Buffer.from(T.otlpHttp.bytes).toString('utf8').startsWith('POST /v1/traces HTTP/1.1\r\nhost: otel-collector.xiaopu.example:4318\r\n')).toBe(true);
  });

  it('订单查询和输出检查', () => {
    expect(T.order.signed_at).toBe('2026-11-03');
    expect(T.leak).toMatchObject({ overlap: '质量问题', leaked: false });
    expect(T.detection.rules).toHaveLength(0);
    expect(T.numbers.detectorP).toBe('0.010');
  });
});

describe('成本与延迟拆账', () => {
  const lesson = LESSON_BY_ID.cost;
  const sorted = [...C.run.timings.map((t) => t.total)].sort((a, b) => a - b);

  it('同一次请求：费用列只累加三次调用，最贵的 chat 2 也是最慢的', () => {
    expect(C.total).toBe(T.numbers.totalCostNano);
    const packets = packetsOf(lesson);
    expect(packets.filter((p) => p.row.type === 'INFER').map((p) => p.row.cost)).toEqual([37_200, 4_177_200, 10_901_200]);
    expect(packets[packets.length - 1].row.cost).toBe(10_901_200);
    expect([C.numbers.priciest, C.numbers.slowest]).toEqual(['chat 2', 'chat 2']);
    expect(C.numbers.priciestShare).toBe('61.7%');
    expect(6_724_000 / 10_901_200).toBeCloseTo(0.6168, 4);
    expect(C.numbers.slowestShare).toBe('62.9%');
    expect(4513.1 / 7169.5).toBeCloseTo(0.6295, 4);
    // 输出部分：(27 × 500 + 95 × 20,000 + 168 × 20,000) / 10,901,200。
    expect(C.numbers.outputShare).toBe('48.4%');
    expect((27 * 500 + 95 * 20000 + 168 * 20000) / 10_901_200).toBeCloseTo(0.48375, 4);
    expect(C.numbers.screenShare).toBe('0.3%');
    expect(C.numbers.per1000).toBe('$10.9');
    expect([C.numbers.outputRatio, C.numbers.cacheRead]).toEqual([5, 0.05]);
  });

  it('用户看到第一个字：chat 2 开始的时刻加它的 TTFT', () => {
    expect(T.chatSpan2.start).toBe(2652.4);
    expect(T.t2.ttft).toBe(395.2);
    expect(C.firstCharAt).toBe(3047.6);
    expect(C.numbers.firstCharAt).toBe('3,048');
    expect(detailOf('cost', 2)).toContain('可用户看到回答的第一个字是在请求开始后 3,048 ms');
    expect(detailOf('cost', 2)).toContain('这些时长都是本站模拟的');
  });

  it('重复 200 次（模拟）：p50 4.22、p95 7.01、p99 8.69、最大 10.97 s', () => {
    expect(C.run.timings).toHaveLength(200);
    expect([C.numbers.p50, C.numbers.p95, C.numbers.p99, C.numbers.max, C.numbers.mean]).toEqual(['4.22', '7.01', '8.69', '10.97', '4.53']);
    expect(C.numbers.tailRatio).toBe('2.1');
    // 线性插值手算：p50 = (第 100 个 + 第 101 个) / 2。
    expect(C.run.total.p50).toBeCloseTo((sorted[99] + sorted[100]) / 2, 9);
  });

  it('两种算法：最近秩取第 ⌈qn⌉ 个；20 个样本时 p99 就是最大值', () => {
    expect(C.methods.nearest).toEqual([sorted[99], sorted[189], sorted[197]]);
    expect([C.numbers.linear[0], C.numbers.nearest[0], C.numbers.linear[2], C.numbers.nearest[2]]).toEqual(['4.22', '4.21', '8.69', '8.69']);
    const small = C.run.timings.slice(0, 20).map((t) => t.total);
    expect(C.methods.smallNearest[2]).toBe(Math.max(...small));
    expect([C.numbers.smallNearestP99, C.numbers.smallLinearP99, C.numbers.smallRank]).toEqual(['10.97', '10.26', 20]);
    expect(detailOf('cost', 4)).toContain('最近秩的 p99 就是最大值 10.97 s，线性插值给出 10.26 s');
  });

  it('直方图：14 个桶边界，132 次在 2.56–5.12 s，p95 只知道在 5.12–10.24 s', () => {
    expect(GENAI_DURATION_BUCKETS).toHaveLength(14);
    expect(C.run.buckets).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 9, 132, 58, 1, 0, 0, 0]);
    expect(C.numbers.p95Bucket).toEqual([5.12, 10.24]);
    // 第 190 个（⌈0.95 × 200⌉）落在 (5.12, 10.24]。
    expect(sorted[189] / 1000).toBeGreaterThan(5.12);
    expect(sorted[189] / 1000).toBeLessThanOrEqual(10.24);
    expect(factsOf('cost', 5)['最多的桶']).toBe('2.56–5.12 s：132 次');
  });
});

describe('生产监控与回流', () => {
  const lesson = LESSON_BY_ID.monitor;

  it('模拟流量：16 分钟 × 30 = 480 个请求，基准延迟取上一课的请求', () => {
    expect(M.records).toHaveLength(480);
    expect(M.TRAFFIC.baseLatencyMs).toBe(7170);
    expect(M.stats).toHaveLength(16);
    expect(M.numbers.errors).toBe(30);
    expect([M.numbers.calmP95Max, M.numbers.incidentP95Max]).toEqual(['14.8', '31.6']);
    expect(M.stats.map((w) => w.errors)).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 8, 6, 4, 8, 0, 1, 0, 0]);
    expect(M.numbers.costPerMinute).toBe('$0.3229');
  });

  it('告警：连续 2 个窗口才触发（第 9 分钟），只看 1 个窗口会在第 6 分钟误报', () => {
    expect(M.errorAlerts).toEqual([{ rule: '出错率', firedAt: 540, resolvedAt: 720, value: 6 / 30 }]);
    expect(M.p95Alerts.map((a) => [a.firedAt, a.resolvedAt])).toEqual([[540, 720]]);
    expect(M.twitchy.map((a) => a.firedAt)).toEqual([360, 480]);
    expect(M.falseAlarms.map((a) => a.firedAt)).toEqual([360]);
    expect(2 / 30).toBeGreaterThan(0.05);
    expect(detailOf('monitor', 1)).toContain('第 6 分钟只出了 2 个错（6.7%）也会把人叫醒');
    expect(factsOf('monitor', 1)['只看 1 个窗口']).toBe('2 次，多 1 次误报');
  });

  it('采样：头部 10%（th e666）留 46 个、出错的只留 5 个；尾部留 122 个、出错的全留', () => {
    expect(M.TRACESTATE).toBe('ot=th:e666');
    // 手算：T = (1 − 0.1) × 2^56，R 是 trace id 最右 14 位十六进制，R ≥ T 才留。
    const t = (9n << 56n) / 10n;
    const manual = M.records.filter((r) => BigInt(`0x${r.traceId.slice(-14)}`) >= t).length;
    expect(Math.abs(manual - M.head.length)).toBeLessThanOrEqual(0);
    expect(M.numbers.headKept).toBe(46);
    expect(M.numbers.tailKept).toBe(122);
    expect(M.sampling).toEqual({ all: [30, 25, 4, 28], head: [5, 2, 1, 2], tail: [30, 25, 4, 28] });
    expect(detailOf('monitor', 2)).toContain('30 个出错的只留下 5 个、28 个差评只留下 2 个');
  });

  it('回流：差评 28 + 被拦 4 = 32 个请求，出错的不进评估集，脱敏、去重后 5 条', () => {
    expect([M.numbers.feedbackCount, M.numbers.flaggedCount, M.numbers.reflowed, M.numbers.cases]).toEqual([28, 4, 32, 5]);
    expect(M.reflowed.every((r) => r.error === null)).toBe(true);
    expect(M.cases.every((c) => c.expected === null && c.id.startsWith('prod-req-') && c.tags![0] === 'production')).toBe(true);
    expect(M.cases.some((c) => c.input.includes('13800138000'))).toBe(false);
    expect(redact('收货电话改成 13800138000 可以吗？').text).toBe('收货电话改成 [手机号] 可以吗？');
    expect(M.groups.map((g) => [g.label, g.feedback, g.flagged])).toEqual([['A1024 漏水', 5, 1], ['A1025 退款', 6, 1], ['A1031 物流', 4, 1], ['改电话', 6, 1], ['颜色不符', 7, 0]]);
    expect(detailOf('monitor', 3)).toContain('出错的是容量问题，交给告警，不进评估集');
  });

  it('重放差评最多的一条：只有这一次调用花钱', () => {
    expect([M.numbers.replayLabel, M.numbers.replayFeedback, M.numbers.replayId]).toEqual(['颜色不符', 7, 'prod-req-0029']);
    expect([M.numbers.replayInput, M.numbers.replayOutput]).toEqual([262, 101]);
    expect(M.replay.cost).toEqual(costOf(M.replay.message.usage, 'claude-opus-5-5'));
    expect(M.replay.cost.total).toBe(262 * 4000 + 101 * 20000);
    const packets = packetsOf(lesson);
    const first = packets.findIndex((p) => p.row.type === 'INFER');
    expect(packets.slice(0, first).every((p) => p.row.cost === 0)).toBe(true);
    expect(packets.slice(first).every((p) => p.row.cost === 3_068_000)).toBe(true);
    expect(M.REPLAY_REPLIES['A1024 的杯盖漏水，能退吗？']).toContain(`签收 ${SIGNED_DAYS} 天`);
  });

  it('最后一课的结尾收束整个系列', () => {
    expect(lesson.outro.text).toContain('整个系列也是');
    for (const name of ['LLM 讲', 'CONTEXT 讲', 'RAG 讲', 'AGENT 讲', 'LLMOPS 讲']) expect(lesson.outro.text).toContain(name);
    expect(LESSON_BY_ID.trace.outro.text).toContain('下一课用这棵树拆账');
    expect(LESSON_BY_ID.cost.outro.text).toContain('下一课把视角从一次请求换成一段线上流量');
  });
});
