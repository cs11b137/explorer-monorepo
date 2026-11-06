/**
 * 生产监控：一段模拟的线上流量（固定种子）、按时间窗口聚合的指标、阈值告警（连续若干个窗口超标才触发）、
 * 尾部采样（出错、慢、被防护拦下的请求一定留，其余按概率留），以及把失败的线上请求变成评估集用例（回流）。
 *
 * 流量是模拟的：每分钟的请求数、出错率、延迟都由 simulateTraffic 按参数生成，可以在某几分钟注入一次「事故」。
 * 告警规则、采样策略是本站的示例写法；trace id 的概率采样用 trace.ts 的 probabilitySample（OpenTelemetry 的阈值算法）。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import type { EvalCase } from './evals';
import { quantile } from './stats';
import { probabilitySample, traceIdOf } from './trace';

export interface RequestRecord {
  id: string;
  traceId: string;
  /** 第几秒到达（模拟时钟）。 */
  at: number;
  user: string;
  input: string;
  latencyMs: number;
  /** 费用，纳美元。 */
  cost: number;
  error: string | null;
  /** 被输入或输出防护拦下。 */
  flagged: boolean;
  /** 用户点了「没帮到我」。 */
  thumbsDown: boolean;
}

export interface TrafficOptions {
  minutes: number;
  perMinute: number;
  seed: number;
  baseLatencyMs: number;
  errorRate: number;
  /** 事故：从第 from 分钟到第 to 分钟（不含），延迟乘 latencyFactor，出错率换成 errorRate。 */
  incident?: { from: number; to: number; latencyFactor: number; errorRate: number };
  /** 每个请求的输入从这里轮流取。 */
  inputs: readonly string[];
  users: readonly string[];
  costPerRequest: number;
}

/** 生成一段模拟流量：每分钟 perMinute 个请求，均匀到达，延迟对数正态（σ 0.4），出错和差评按概率。 */
export function simulateTraffic(o: TrafficOptions): RequestRecord[] {
  const rand = mulberry32(o.seed);
  const records: RequestRecord[] = [];
  let n = 0;
  for (let minute = 0; minute < o.minutes; minute++) {
    const inIncident = o.incident && minute >= o.incident.from && minute < o.incident.to;
    for (let k = 0; k < o.perMinute; k++) {
      n++;
      const u1 = 1 - rand();
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const latency = Math.round(o.baseLatencyMs * Math.exp(0.4 * z) * (inIncident ? o.incident!.latencyFactor : 1));
      const error = rand() < (inIncident ? o.incident!.errorRate : o.errorRate) ? 'overloaded_error' : null;
      const flagged = rand() < 0.02;
      const thumbsDown = !error && rand() < 0.04;
      records.push({
        id: `req-${String(n).padStart(4, '0')}`,
        traceId: traceIdOf(o.seed * 10000 + n),
        at: minute * 60 + Math.round((k * 60) / o.perMinute),
        user: o.users[n % o.users.length],
        input: o.inputs[n % o.inputs.length],
        latencyMs: latency,
        cost: error ? 0 : o.costPerRequest,
        error,
        flagged,
        thumbsDown,
      });
    }
  }
  return records;
}

export interface WindowStat {
  /** 窗口开始的秒数。 */
  from: number;
  count: number;
  errors: number;
  errorRate: number;
  p95: number;
  cost: number;
}

/** 按 windowSeconds 切窗口，算请求数、出错率、p95 延迟（线性插值）、费用。 */
export function windows(records: readonly RequestRecord[], windowSeconds = 60): WindowStat[] {
  if (!records.length) return [];
  const last = Math.max(...records.map((r) => r.at));
  const out: WindowStat[] = [];
  for (let from = 0; from <= last; from += windowSeconds) {
    const rows = records.filter((r) => r.at >= from && r.at < from + windowSeconds);
    const errors = rows.filter((r) => r.error).length;
    out.push({ from, count: rows.length, errors, errorRate: rows.length ? errors / rows.length : 0, p95: rows.length ? quantile(rows.map((r) => r.latencyMs), 0.95) : 0, cost: rows.reduce((a, r) => a + r.cost, 0) });
  }
  return out;
}

export interface AlertRule {
  name: string;
  metric: 'errorRate' | 'p95';
  /** 超过这个值算超标。 */
  above: number;
  /** 连续这么多个窗口超标才触发（避免一次抖动就叫醒人）。 */
  forWindows: number;
}

export interface AlertEvent {
  rule: string;
  /** 触发、恢复的窗口开始时间（秒）。 */
  firedAt: number;
  resolvedAt: number | null;
  /** 触发那一刻的值。 */
  value: number;
}

/** 在窗口序列上评估一条规则：连续 forWindows 个窗口超标时触发，第一个不超标的窗口恢复。 */
export function evaluateAlert(stats: readonly WindowStat[], rule: AlertRule): AlertEvent[] {
  const events: AlertEvent[] = [];
  let streak = 0;
  let open: AlertEvent | null = null;
  for (const w of stats) {
    const value = w[rule.metric];
    if (value > rule.above) {
      streak++;
      if (!open && streak >= rule.forWindows) events.push((open = { rule: rule.name, firedAt: w.from, resolvedAt: null, value }));
    } else {
      streak = 0;
      if (open) {
        open.resolvedAt = w.from;
        open = null;
      }
    }
  }
  return events;
}

export interface TailPolicy {
  /** 其余请求按这个概率留（用 trace id 的概率采样）。 */
  baseRate: number;
  slowerThanMs: number;
}

export type KeepReason = 'error' | 'slow' | 'flagged' | 'feedback' | 'sampled' | null;

/** 尾部采样：请求结束、结果已知之后再决定留不留。出错、慢、被拦、差评一定留，其余按 trace id 的概率采样。 */
export function tailSample(record: RequestRecord, policy: TailPolicy): KeepReason {
  if (record.error) return 'error';
  if (record.latencyMs > policy.slowerThanMs) return 'slow';
  if (record.flagged) return 'flagged';
  if (record.thumbsDown) return 'feedback';
  return probabilitySample(record.traceId, policy.baseRate).sampled ? 'sampled' : null;
}

/** 把一条线上请求变成评估用例：输入原样（应当先脱敏），expected 留给人工补，标签记来源和原因。 */
export function toEvalCase(record: RequestRecord, reason: Exclude<KeepReason, null>): EvalCase<string | null> {
  return { id: `prod-${record.id}`, input: record.input, expected: null, tags: ['production', reason] };
}
