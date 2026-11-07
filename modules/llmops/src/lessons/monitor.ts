/**
 * 可观测性第三课（整个系列的最后一课）：生产监控与回流。
 *
 * 一段模拟的线上流量（core/monitor.ts 的 simulateTraffic，固定种子）：16 分钟、每分钟 30 个请求，第 8–11 分钟注入一次事故
 * （延迟乘 2.2、出错率 20%）。真实计算的部分：按分钟切窗口的出错率和 p95（windows）、连续 N 个窗口超标才告警（evaluateAlert）、
 * 尾部采样和按 trace id 的概率采样（tailSample、probabilitySample，阈值 T 和 tracestate 的 th 照 OpenTelemetry 的算法）、
 * 把差评和被拦的请求变成评估用例（toEvalCase），输入先做 PII 脱敏（redact），最后挑一条在当前版本上重放一次（callModel）。
 * 流量、延迟、出错、差评、被拦都是模拟的；告警阈值、采样策略是本站的示例写法。重放的回答是脚本，标 E.G.。
 *
 * 现成的 LLM 可观测性产品（Langfuse、LangSmith、Arize 等）都能接收 OTLP 的 trace——claude-api skill 的 shared/opentelemetry.md
 * 把它们列为 Claude API 导出 trace 的目的地，并说 trace 可以用来「build evals from real traffic」。各产品里「从 trace 建数据集」
 * 一类功能的名字和细节本站没有逐一核对，课程正文不写；Helicone 没有核对，不提。
 * tests/narrative.observe.test.ts 核对文案。
 */
import {
  callModel,
  encodeJson,
  evaluateAlert,
  formatUsd,
  OTLP_HTTP_PORT,
  probabilitySample,
  redact,
  rejectionThreshold,
  replyText,
  simulateTraffic,
  tailSample,
  thValue,
  toEvalCase,
  userIdOf,
  utf8Encode,
  windows,
  type AlertRule,
  type KeepReason,
  type RequestRecord,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { pct } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { NORMAL_ASK, SIGNED_DAYS, supportRequest } from './scenario';
import { numbers as traceNumbers, root } from './trace';
import type { DsCell, GridPrim, Lesson } from './types';

// ---------- 模拟的线上流量 ----------

/** 线上会问的几种问题（轮流取）。第 4 条带一个示例手机号，回流前要脱敏。 */
export const INPUTS = [NORMAL_ASK, 'A1025 的电热水壶退款几天到账？', 'A1031 的密封圈到哪了？', '收货电话改成 13800138000 可以吗？', '杯子和图片颜色不一样，能换吗？'] as const;
const INPUT_LABEL = ['A1024 漏水', 'A1025 退款', 'A1031 物流', '改电话', '颜色不符'];
/** 三个示例账号，发给 API 的是不透明的 user_id。 */
export const USERS = ['lin@example.com', 'zhou@example.com', 'wu@example.com'].map((account) => userIdOf(account));
export const TRAFFIC = {
  minutes: 16,
  perMinute: 30,
  seed: 1,
  /** 基准延迟取上一课那次请求的总时长（模拟），四舍五入到毫秒。 */
  baseLatencyMs: Math.round(root.end - root.start),
  errorRate: 0.01,
  incident: { from: 8, to: 12, latencyFactor: 2.2, errorRate: 0.2 },
  inputs: INPUTS,
  users: USERS,
  /** 每个成功的请求按上一课那次请求的费用记（三次模型调用）。 */
  costPerRequest: traceNumbers.totalCostNano,
};
export const records: RequestRecord[] = simulateTraffic(TRAFFIC);
export const stats = windows(records);

// ---------- 告警 ----------

export const ERROR_RULE: AlertRule = { name: '出错率', metric: 'errorRate', above: 0.05, forWindows: 2 };
export const P95_RULE: AlertRule = { name: 'p95 延迟', metric: 'p95', above: 20_000, forWindows: 2 };
export const errorAlerts = evaluateAlert(stats, ERROR_RULE);
export const p95Alerts = evaluateAlert(stats, P95_RULE);
/** 只要一个窗口超标就叫人：会多出一次误报。 */
export const twitchy = evaluateAlert(stats, { ...ERROR_RULE, forWindows: 1 });
export const falseAlarms = twitchy.filter((a) => !errorAlerts.some((b) => a.firedAt <= b.firedAt && (a.resolvedAt ?? Infinity) >= b.firedAt));

// ---------- 采样 ----------

export const HEAD_RATE = 0.1;
export const TAIL_POLICY = { baseRate: HEAD_RATE, slowerThanMs: P95_RULE.above };
export const th = thValue(rejectionThreshold(HEAD_RATE));
export const TRACESTATE = `ot=th:${th}`;
export const head = records.filter((r) => probabilitySample(r.traceId, HEAD_RATE).sampled);
export const tail = records.map((r) => ({ record: r, reason: tailSample(r, TAIL_POLICY) }));
const kept = tail.filter((t) => t.reason !== null);
const countReason = (reason: KeepReason) => tail.filter((t) => t.reason === reason).length;
const CLASSES: Array<[string, (r: RequestRecord) => boolean]> = [
  ['出错', (r) => r.error !== null],
  ['慢', (r) => !r.error && r.latencyMs > TAIL_POLICY.slowerThanMs],
  ['被拦', (r) => r.flagged],
  ['差评', (r) => r.thumbsDown],
];
const tally = (list: readonly RequestRecord[]) => CLASSES.map(([, test]) => list.filter(test).length);
export const sampling = { all: tally(records), head: tally(head), tail: tally(kept.map((t) => t.record)) };

// ---------- 回流 ----------

/** 差评和被拦的请求变成评估用例（出错的是容量问题，交给告警，不进评估集）；输入先脱敏，同一个问题只留一条。 */
export const reflowed = kept.map((t) => t.record).filter((r) => !r.error && (r.thumbsDown || r.flagged));
export const candidates = reflowed.map((r) => {
  const c = toEvalCase(r, r.flagged ? 'flagged' : 'feedback');
  return { ...c, input: redact(c.input).text };
});
export const groups = INPUTS.map((text, i) => {
  const inputs = redact(text).text;
  const mine = candidates.filter((c) => c.input === inputs);
  return { i, label: INPUT_LABEL[i], input: inputs, feedback: mine.filter((c) => c.tags!.includes('feedback')).length, flagged: mine.filter((c) => c.tags!.includes('flagged')).length, first: mine[0] };
}).filter((g) => g.first);
export const cases = groups.map((g) => g.first!);
export const redaction = redact(INPUTS[3]);
const topGroup = [...groups].sort((a, b) => b.feedback - a.feedback || a.i - b.i)[0];

/** 重放差评最多的那一条：在当前版本上再跑一次，看问题能不能复现（回答是示例）。 */
export const REPLAY_REPLIES: Record<string, string> = {
  [INPUTS[0]]: `可以退。订单 A1024 签收 ${SIGNED_DAYS} 天，杯盖漏水属于质量问题，寄回运费由店铺承担。`,
  [INPUTS[1]]: '退款审核通过后原路退回，支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。',
  [INPUTS[2]]: '订单 A1031 已经发货，用的是顺丰，还没有签收。',
  [redact(INPUTS[3]).text]: '订单发货前可以改收货电话，请在订单详情里修改。',
  [INPUTS[4]]: '颜色和图片不一样不算质量问题，签收 7 天内可以无理由退货，寄回运费由您承担。',
};
export const replayCase = topGroup.first!;
export const replay = callModel(supportRequest(replayCase.input), REPLAY_REPLIES[replayCase.input], 1300);

// ---------- 文案用到的数 ----------

const minuteOf = (seconds: number | null) => (seconds === null ? null : seconds / 60);
const s1 = (ms: number) => (ms / 1000).toFixed(1);
const incidentStats = stats.slice(TRAFFIC.incident.from, TRAFFIC.incident.to);

export const numbers = {
  requests: records.length,
  minutes: TRAFFIC.minutes,
  perMinute: TRAFFIC.perMinute,
  baseLatency: num(TRAFFIC.baseLatencyMs),
  incidentFrom: TRAFFIC.incident.from,
  incidentTo: TRAFFIC.incident.to - 1,
  incidentFactor: TRAFFIC.incident.latencyFactor,
  incidentErrorRate: pct(TRAFFIC.incident.errorRate),
  baseErrorRate: pct(TRAFFIC.errorRate),
  errors: records.filter((r) => r.error).length,
  calmP95Max: s1(Math.max(...stats.slice(0, TRAFFIC.incident.from).map((w) => w.p95))),
  incidentP95Max: s1(Math.max(...incidentStats.map((w) => w.p95))),
  incidentErrorsMax: Math.max(...incidentStats.map((w) => w.errors)),
  costPerMinute: formatUsd(Math.round(stats.slice(0, TRAFFIC.incident.from).reduce((a, w) => a + w.cost, 0) / TRAFFIC.incident.from)),
  errorFired: minuteOf(errorAlerts[0].firedAt),
  errorResolved: minuteOf(errorAlerts[0].resolvedAt),
  errorFiredValue: pct(errorAlerts[0].value),
  p95Fired: minuteOf(p95Alerts[0].firedAt),
  p95Resolved: minuteOf(p95Alerts[0].resolvedAt),
  p95FiredValue: s1(p95Alerts[0].value),
  errorAlertCount: errorAlerts.length,
  twitchyCount: twitchy.length,
  falseMinute: minuteOf(falseAlarms[0]?.firedAt ?? null),
  falseErrors: falseAlarms[0] ? stats[falseAlarms[0].firedAt / 60].errors : 0,
  falseRate: falseAlarms[0] ? pct(falseAlarms[0].value) : '',
  errorThreshold: pct(ERROR_RULE.above),
  p95Threshold: String(P95_RULE.above / 1000),
  headRate: pct(HEAD_RATE),
  th,
  tracestate: TRACESTATE,
  headKept: head.length,
  tailKept: kept.length,
  tailSampled: countReason('sampled'),
  sampling,
  reflowed: reflowed.length,
  feedbackCount: reflowed.filter((r) => r.thumbsDown).length,
  flaggedCount: reflowed.filter((r) => r.flagged).length,
  cases: cases.length,
  redacted: redaction.text,
  replayLabel: topGroup.label,
  replayFeedback: topGroup.feedback,
  replayId: replayCase.id,
  replayInput: replay.message.usage.input_tokens,
  replayOutput: replay.message.usage.output_tokens,
  replayCost: formatUsd(replay.cost.total),
  replayCostNano: replay.cost.total,
};
const N = numbers;

// ---------- 图元 ----------

/** 每分钟一列：出错数和 p95（秒），16 分钟分成上下两段（0–7、8–15），每段的格子比一整排大一倍多。upto 之后的列留空；超标的格子 amber，事故窗口按 p95 加热度。 */
function metricsGrid(upto: number, lift = -1): GridPrim[] {
  const maxP95 = Math.max(...stats.map((w) => w.p95));
  const half = stats.length / 2;
  const W = 58;
  return [0, 1].map((part): GridPrim => {
    const idx = stats.map((_, i) => i).filter((i) => Math.floor(i / half) === part);
    return {
      kind: 'grid',
      id: part ? 'w2' : 'w',
      at: [0, (part - 0.5) * 3.3 * W],
      w: W,
      rows: ['错误', 'p95'],
      cols: idx.map((i) => String(i)),
      cells: [
        idx.map((i): DsCell => (i >= upto ? { v: '', tone: 'empty' } : { v: String(stats[i].errors), tone: stats[i].errorRate > ERROR_RULE.above ? 'amber' : stats[i].errors ? 'slate' : 'dim', lift: i === lift || undefined })),
        idx.map((i): DsCell => (i >= upto ? { v: '', tone: 'empty' } : { v: String(Math.round(stats[i].p95 / 1000)), tone: stats[i].p95 > P95_RULE.above ? 'amber' : 'violet', heat: stats[i].p95 / maxP95, lift: i === lift || undefined })),
      ],
    };
  });
}

/** 采样对比：行是四类值得看的请求，列是全部、头部 10%、尾部采样留下的。 */
function samplingGrid(cols: number): GridPrim {
  const all = [sampling.all, sampling.head, sampling.tail];
  return {
    kind: 'grid',
    id: 's',
    w: 46,
    rows: CLASSES.map(([name]) => name),
    cols: ['全部', '头部', '尾部'],
    cells: CLASSES.map((_, r) => all.map((col, c): DsCell => (c >= cols ? { v: '', tone: 'empty' } : { v: String(col[r]), tone: c === 0 ? 'slate' : col[r] === all[0][r] ? 'green' : 'amber' }))),
  };
}

/** 回流的评估集：行是问题，列是差评、被拦的条数。 */
function datasetGrid(lift = -1, done = false): GridPrim {
  return {
    kind: 'grid',
    id: 'd',
    w: 46,
    rows: groups.map((g) => g.label),
    cols: ['差评', '被拦', '用例'],
    cells: groups.map((g, r): DsCell[] => [
      { v: String(g.feedback), tone: g.feedback ? 'amber' : 'dim', lift: r === lift || undefined },
      { v: String(g.flagged), tone: g.flagged ? 'amber' : 'dim', lift: r === lift || undefined },
      { v: done && r === lift ? '复现' : '1', tone: done && r === lift ? 'green' : 'teal', lift: r === lift || undefined },
    ]),
  };
}

// ---------- 字节层 ----------

const recordJson = (r: RequestRecord) => encodeJson({ id: r.id, trace_id: r.traceId, at: r.at, user: r.user, latency_ms: r.latencyMs, error: r.error, flagged: r.flagged, thumbs_down: r.thumbsDown });
const recordWire = (r: RequestRecord, label: string) => wire(label, 'mem', 'internal', jsonBody('请求记录（本站的写法）', recordJson(r), {
  example: ['id', 'trace_id', 'user'],
  notes: { trace_id: '这个请求的 trace id：从指标点回 trace 靠它。', latency_ms: '模拟的延迟。', error: r.error ? 'overloaded_error：Messages API 过载时的错误类型（模拟）。' : '没有出错。', thumbs_down: '用户点了「没帮到我」。' },
}));
const windowJson = (from: number, to: number) => encodeJson(stats.slice(from, to).map((w) => ({ minute: w.from / 60, count: w.count, errors: w.errors, p95_ms: Math.round(w.p95) })));
const windowWire = (from: number, to: number, label: string) => wire(label, 'mem', 'internal', jsonBody('每分钟的指标（本站的写法）', windowJson(from, to), { summary: `每个窗口 60 秒：请求数、出错数、p95（线性插值，毫秒）` }));
const alertJson = encodeJson({ rule: ERROR_RULE, fired_at_minute: N.errorFired, resolved_at_minute: N.errorResolved, value: +errorAlerts[0].value.toFixed(3) });
const alertWire = wire('告警（本站的写法）', 'mem', 'internal', jsonBody('告警事件', alertJson, { expand: ['rule.forWindows'], notes: { 'rule.forWindows': `连续 ${ERROR_RULE.forWindows} 个窗口超标才触发。`, fired_at_minute: '触发的那个窗口。', resolved_at_minute: '第一个不超标的窗口：恢复。' } }));
const tracestateWire = wire('头部采样：tracestate', 'mem', 'format',
  utf8Lines('tracestate 的 ot 项', TRACESTATE, { summary: `OpenTelemetry 概率采样：th 是拒绝阈值 T 的十六进制，去掉末尾的 0（${N.headRate} → ${th}）` }),
  concept('决定（本站的 probabilitySample）', [['R', 'trace id 最右 7 个字节', 'trace id 本身是随机的，所以同一个 trace 在哪里算都一样。'], ['T', `(1 − ${HEAD_RATE}) × 2^56`, `R ≥ T 才采样，${N.requests} 个请求留下 ${N.headKept} 个。`], ['什么时候定', '请求一开始', '还不知道它会不会出错、慢不慢。']], 'teal'));
const samplingJson = encodeJson({ policy: { keep: ['error', `slower_than_ms > ${TAIL_POLICY.slowerThanMs}`, 'flagged', 'thumbs_down'], others: HEAD_RATE }, kept: N.tailKept, by_reason: { error: countReason('error'), slow: countReason('slow'), flagged: countReason('flagged'), feedback: countReason('feedback'), sampled: countReason('sampled') } });
const tailWire = wire('尾部采样（本站的策略）', 'mem', 'internal', jsonBody('采样结果', samplingJson, { expand: ['by_reason.error', 'by_reason.sampled'], notes: { policy: '请求结束、结果已知以后再决定：出错、慢、被拦、差评一定留，其余按 trace id 的概率留。', 'by_reason.sampled': `其余的请求按 ${N.headRate} 留下的。` } }));
const casesJson = encodeJson(cases);
const caseWire = wire('回流的评估用例', 'mem', 'internal', jsonBody('评估集（本站的写法）', casesJson, {
  notes: Object.fromEntries(cases.map((c, i) => [`[${i}]`, `${c.id}：${c.tags!.join('、')}；expected 是 null，等人工补。`])),
  summary: `${N.cases} 条，id 是 prod-<请求 id>，标签记来源和原因`,
}));

const replayRequestWire = wire('重放的请求', 'mem', 'format', httpHead('请求头', replay.http.request, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'] }), jsonBody('请求体', encodeJson(replay.request), { example: ['metadata'], notes: { messages: `回流用例的输入（已脱敏）：「${replayCase.input}」。` } }));
const replayResponseWire = wire('重放的响应', 'mem', 'format', httpHead('响应头', replay.http.response, { example: ['request-id', 'date'] }), jsonBody('响应体', encodeJson(replay.message), {
  expand: ['usage.input_tokens', 'usage.output_tokens'],
  example: ['id', 'content', 'usage', 'usage.input_tokens', 'usage.output_tokens'],
  notes: { content: '回答（示例）。对不对要由人工补的 expected 来判。' },
}));

// ---------- 事件 ----------

const C = N.replayCostNano;
const firstFeedback = records.find((r) => r.thumbsDown && !r.error)!;

export const monitor: Lesson = {
  id: 'monitor',
  name: 'MONITOR',
  title: '生产监控与回流',
  group: 'observe',
  layer: [4, 7],
  layerNote: '这课从「追踪」到「用户」：线上的 trace 汇成指标、触发告警、被采样留下，用户的差评和被拦的请求再回流成评估用例。',
  costNote: `流量是模拟的，它的费用只记在每分钟的指标里（约 ${N.costPerMinute} / 分钟）；费用列只有最后重放一条回流用例的那一次 Claude Opus 5.5 调用：${N.replayCost}。`,
  nodes: ['app', 'backend', 'collector', 'observe', 'alert', 'harness', 'llm', 'metrics', 'matrix', 'dataset'],
  place: { app: [90, 130], backend: [440, 130], collector: [800, 130], observe: [860, 420], alert: [1140, 290], harness: [520, 880], llm: [900, 860], metrics: [470, 510], matrix: [1120, 650], dataset: [130, 820] },
  labels: {
    app: ['应用界面', '用户提问、点差评'],
    backend: ['客服后端', '每个请求一棵 trace'],
    collector: ['OTel Collector', `OTLP/HTTP :${OTLP_HTTP_PORT}，采样`],
    observe: ['可观测性后端', '指标、trace、告警规则'],
    alert: ['告警', '通知值班的人'],
    harness: ['评估运行器', '回流用例先重放'],
    llm: ['模型', 'claude-opus-5-5'],
    metrics: ['每分钟的指标', '错误数、p95（秒）'],
    matrix: ['采样留下了什么', '全部 / 头部 / 尾部'],
    dataset: ['回流的评估集', '按问题去重'],
  },
  labelAt: { metrics: [-30, 205], matrix: [0, 120], dataset: [0, 130] },
  radius: { metrics: 80, matrix: 70, dataset: 70 },
  initial: { metrics: [], matrix: [], dataset: [] },
  start: ['app', 'backend', 'collector', 'observe'],
  legend: [['violet', 'p95 延迟'], ['amber', '超标、漏掉的'], ['green', '全部留下'], ['teal', '采样、回流的用例'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '一段线上流量：指标、告警、采样，和把出问题的请求变成评估用例',
    description: `前两课看的是一次请求，这一课看一段模拟的线上流量：${N.minutes} 分钟、${N.requests} 个请求，第 ${N.incidentFrom}–${N.incidentTo} 分钟出了一次事故。按分钟算出错率和 p95，规则要求连续 ${ERROR_RULE.forWindows} 个窗口超标才告警；trace 太多存不下，比较按 trace id 的头部采样和等请求结束再决定的尾部采样各留下了什么。最后把用户点了差评、被防护层拦下的请求脱敏后变成评估用例，接回评估组的回归测试。流量、延迟、出错和差评都是模拟的。`,
    facts: [
      ['流量', `${N.requests} 个请求（模拟）`],
      ['告警', `出错率 > ${N.errorThreshold}，连续 ${ERROR_RULE.forWindows} 分钟`],
      ['采样', `头部 ${N.headKept} 个，尾部 ${N.tailKept} 个`],
      ['回流', `${N.cases} 条评估用例`],
    ],
  },
  steps: [
    {
      title: '从 trace 到指标',
      desc: `${N.requests} 个请求，按分钟算错误数和 p95`,
      detail: `线上每个请求都像上一课那样产生一棵 trace，后端再把它们按 60 秒一个窗口汇总成指标：请求数、出错数、p95 延迟、花了多少钱。本站模拟了 ${N.minutes} 分钟、每分钟 ${N.perMinute} 个请求，延迟以上一课那次请求的 ${N.baseLatency} ms 为中位数随机波动，出错率 ${N.baseErrorRate}。前 ${N.incidentFrom} 分钟一切正常：p95 最高 ${N.calmP95Max} s，每分钟大约花 ${N.costPerMinute}。`,
      facts: [['窗口', '60 秒'], ['请求', `每分钟 ${N.perMinute} 个（模拟）`], ['平时的 p95', `最高 ${N.calmP95Max} s`], ['费用', `约 ${N.costPerMinute} / 分钟`]],
      events: [
        type(NORMAL_ASK),
        pk('app', 'backend', 'blue', '线上流量', [`${N.requests} 个请求`, `${N.minutes} 分钟`], [0, 'CALL', `模拟流量：每分钟 ${N.perMinute} 个请求`, utf8Encode(NORMAL_ASK).length], recordWire(records[0], '第 1 个请求'), { ds: { metrics: metricsGrid(0) } }),
        pk('backend', 'collector', 'teal', 'POST /v1/traces', ['每个请求一棵 trace'], [0, 'EXPORT', '每个请求的 trace 导出到 Collector', recordJson(records[0]).bytes.length], recordWire(records[0], '一个请求的摘要'), { ds: { metrics: metricsGrid(0) } }),
        show('metrics'),
        pk('observe', 'metrics', 'violet', '按分钟汇总', [`前 ${N.incidentFrom} 分钟`, `p95 ≤ ${N.calmP95Max} s`], [0, 'STATS', `第 0–${N.incidentFrom - 1} 分钟：p95 最高 ${N.calmP95Max} s`, windowJson(0, TRAFFIC.incident.from).bytes.length], windowWire(0, TRAFFIC.incident.from, '前几分钟的指标'), { ds: { metrics: metricsGrid(TRAFFIC.incident.from) } }),
        state('observe', { 窗口: `${N.incidentFrom} 个`, 状态: '正常' }),
      ],
    },
    {
      title: '告警：连续超标才叫人',
      desc: `第 ${N.errorFired} 分钟触发，第 ${N.errorResolved} 分钟恢复`,
      detail: `第 ${N.incidentFrom} 分钟起延迟变成 ${N.incidentFactor} 倍、出错率升到 ${N.incidentErrorRate}（模拟的事故），p95 最高到 ${N.incidentP95Max} s。本站的告警规则是出错率超过 ${N.errorThreshold}、并且连续 ${ERROR_RULE.forWindows} 个窗口超标才触发，所以在第 ${N.errorFired} 分钟叫人，第 ${N.errorResolved} 分钟恢复；p95 超过 ${N.p95Threshold} s 的规则也在第 ${N.p95Fired} 分钟触发。如果一个窗口超标就叫，第 ${N.falseMinute} 分钟只出了 ${N.falseErrors} 个错（${N.falseRate}）也会把人叫醒：晚一分钟换来少一次误报。`,
      facts: [['触发', `第 ${N.errorFired} 分钟，${N.errorFiredValue}`], ['恢复', `第 ${N.errorResolved} 分钟`], ['p95 规则', `> ${N.p95Threshold} s，第 ${N.p95Fired} 分钟触发`], ['只看 1 个窗口', `${N.twitchyCount} 次，多 ${N.twitchyCount - N.errorAlertCount} 次误报`]],
      events: [
        pk('observe', 'metrics', 'amber', '事故', [`p95 ${N.incidentP95Max} s`, `错误 ${N.incidentErrorsMax} 个`], [0, 'STATS', `第 ${N.incidentFrom}–${N.incidentTo} 分钟：出错率升到 ${N.incidentErrorRate} 左右，p95 最高 ${N.incidentP95Max} s`, windowJson(TRAFFIC.incident.from, N.minutes).bytes.length], windowWire(TRAFFIC.incident.from, N.minutes, '之后的指标'), { ds: { metrics: metricsGrid(N.minutes, N.errorFired!) } }),
        show('alert'),
        pk('observe', 'alert', 'amber', '出错率告警', [`第 ${N.errorFired} 分钟`, N.errorFiredValue], [0, 'ALERT', `出错率连续 ${ERROR_RULE.forWindows} 个窗口超过 ${N.errorThreshold}：第 ${N.errorFired} 分钟触发，第 ${N.errorResolved} 分钟恢复`, alertJson.bytes.length], alertWire, { ds: { metrics: metricsGrid(N.minutes, N.errorFired!) } }),
        state('alert', { 出错率: `第 ${N.errorFired}–${N.errorResolved} 分钟`, p95: `第 ${N.p95Fired}–${N.p95Resolved} 分钟` }),
        note('metrics', `第 ${N.falseMinute} 分钟：${N.falseErrors} 个错，不告警`),
      ],
    },
    {
      title: '采样：头部还是尾部',
      desc: `头部 ${N.headRate} 留 ${N.headKept} 个，尾部留 ${N.tailKept} 个`,
      detail: `trace 全存太贵，要采样。头部采样在请求一开始就按 trace id 决定，OpenTelemetry 的概率采样把 ${N.headRate} 换成拒绝阈值，写进 tracestate 是 ${TRACESTATE}，还会通过 traceparent 的 sampled 位传给下游：${N.requests} 个请求留下 ${N.headKept} 个，可 ${N.sampling.all[0]} 个出错的只留下 ${N.sampling.head[0]} 个、${N.sampling.all[3]} 个差评只留下 ${N.sampling.head[3]} 个。尾部采样看过整个 trace 的 span 再决定（做这件事的组件要存下大量数据，比如 Collector 的尾部采样处理器）：出错、慢、被拦、差评全留，其余按 ${N.headRate} 留，一共 ${N.tailKept} 个，值得看的一个不漏。`,
      facts: [['tracestate', TRACESTATE], ['头部', `${N.headKept} 个，出错的留 ${N.sampling.head[0]} / ${N.sampling.all[0]}`], ['尾部', `${N.tailKept} 个，出错的全留`], ['尾部的代价', '要先存下整个 trace']],
      events: [
        show('matrix'),
        pk('collector', 'observe', 'teal', '头部采样', [TRACESTATE, `留 ${N.headKept} 个`], [0, 'SAMPLE', `按 trace id 留 ${N.headRate}：${N.headKept} 个，出错的只留 ${N.sampling.head[0]} 个`, utf8Encode(TRACESTATE).length], tracestateWire, { ds: { matrix: [samplingGrid(2)] } }),
        pk('collector', 'observe', 'teal', '尾部采样', [`留 ${N.tailKept} 个`], [0, 'SAMPLE', `请求结束后再决定：出错、慢、被拦、差评全留，共 ${N.tailKept} 个`, samplingJson.bytes.length], tailWire, { ds: { matrix: [samplingGrid(3)] } }),
        note('matrix', '值得看的，尾部一个不漏', 'green'),
      ],
    },
    {
      title: '回流：出问题的请求变成用例',
      desc: `${N.reflowed} 个请求，按问题去重成 ${N.cases} 条`,
      detail: `尾部采样留下的请求里，${N.feedbackCount} 个是用户点了差评、${N.flaggedCount} 个被防护层拦下：前者可能是答错了，后者可能是误拦，都该进评估集；出错的是容量问题，交给告警，不进评估集。线上的输入可能带着个人信息，进评估集之前先脱敏，比如带手机号的那句变成「${N.redacted.replace(/[。！？]$/, '')}」。同一个问题的多条记录只留一条，${N.reflowed} 个请求去重后是 ${N.cases} 条用例，expected 留空，等人工按评估组讲的办法补上（模拟的差评是随机的，真实的会集中在答得不好的问题上）。`,
      facts: [['差评', `${N.feedbackCount} 个`], ['被拦', `${N.flaggedCount} 个`], ['去重后', `${N.cases} 条用例`], ['脱敏', '手机号 → [手机号]']],
      events: [
        show('dataset'),
        pk('app', 'backend', 'amber', '没帮到我', [preview(firstFeedback.input, 12)], [0, 'CALL', `用户点了差评：${firstFeedback.id}`, recordJson(firstFeedback).bytes.length], recordWire(firstFeedback, '一个差评的请求')),
        pk('observe', 'dataset', 'teal', '回流', [`${N.reflowed} 个请求`, `${N.cases} 条用例`], [0, 'EVAL', `差评 ${N.feedbackCount} 个、被拦 ${N.flaggedCount} 个，脱敏、去重后 ${N.cases} 条用例`, casesJson.bytes.length], caseWire, { ds: { dataset: [datasetGrid()] } }),
        note('dataset', `「改电话」已脱敏`),
      ],
    },
    {
      title: '重放，再交给回归测试',
      desc: `差评最多的「${N.replayLabel}」在当前版本上跑一次`,
      detail: `用例进评估集之前，先在当前版本上重放一次，确认问题还能复现：差评最多的「${N.replayLabel}」（${N.replayFeedback} 个差评）发给模型，输入 ${N.replayInput}、输出 ${N.replayOutput} token，花 ${N.replayCost}。回答（示例）对不对，要由人工补的 expected 和评估组的评分器来判。补好以后这些用例就留在评估集里，下次改提示时和其他用例一起跑一遍回归测试，看线上出过的问题有没有再犯。`,
      facts: [['重放', N.replayId], ['token', `${N.replayInput} / ${N.replayOutput}`], ['费用', N.replayCost], ['之后', '人工补 expected，进回归测试']],
      events: [
        show('harness', 'llm'),
        pk('dataset', 'harness', 'teal', N.replayId, [preview(replayCase.input, 12)], [0, 'EVAL', `重放差评最多的用例：${N.replayId}`, utf8Encode(replayCase.input).length], wire('回流用例的输入', 'mem', 'format', utf8Lines('input', replayCase.input, { summary: '已脱敏的用户问题' })), { ds: { dataset: [datasetGrid(groups.indexOf(topGroup))] } }),
        pk('harness', 'llm', 'blue', 'POST /v1/messages', [`${num(replay.http.request.bytes.length)} 字节`], [0, 'HTTP', '在当前版本上重放', replay.http.request.bytes.length], replayRequestWire),
        pk('llm', 'harness', 'green', '回答', [preview(replyText(replay.message), 12), `${N.replayOutput} token`], [C, 'INFER', `重放：输入 ${N.replayInput}、输出 ${N.replayOutput} token，${N.replayCost}`, replay.http.response.bytes.length], replayResponseWire, { ds: { dataset: [datasetGrid(groups.indexOf(topGroup), true)] } }),
        pk('harness', 'dataset', 'teal', '进评估集', ['等人工补 expected'], [C, 'EVAL', '用例留在评估集里，下次改提示时跑回归', casesJson.bytes.length], caseWire, { ds: { dataset: [datasetGrid(groups.indexOf(topGroup), true)] } }),
        state('harness', { 用例: `${N.cases} 条`, 重放: N.replayCost }),
        render,
      ],
    },
  ],
  outro: {
    title: '看得见，才改得动',
    desc: `${N.requests} 个请求，${N.errorAlertCount} 次告警，${N.cases} 条回流用例`,
    text: `监控把一棵棵 trace 汇成指标，告警规则用「连续几个窗口」挡掉一次抖动，采样决定哪些 trace 留下：头部采样便宜但会漏掉出错的请求，尾部采样留得准但要先存下整个 trace 才能决定。出问题的请求脱敏、去重后回到评估集，下一次改提示就要先过它们。这门课到这里结束，整个系列也是：同一个 A1024 杯盖漏水的问题，LLM 讲模型怎样一个个 token 写出回答，CONTEXT 讲回答之前上下文怎样拼起来，RAG 讲怎样查到售后规则，AGENT 讲怎样调用工具查订单、建退货单，LLMOPS 讲上线以后怎样挡住滥用、判断好坏、看清线上发生了什么。`,
    facts: [['告警', `第 ${N.errorFired}–${N.errorResolved} 分钟`], ['尾部采样', `${N.tailKept} 个`], ['回流', `${N.cases} 条用例`], ['系列', 'LLM → CONTEXT → RAG → AGENT → LLMOPS']],
  },
};
