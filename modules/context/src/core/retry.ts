/**
 * 限流与重试的模拟（retry 课用）：令牌桶、三个限额的限流器、指数退避加抖动、一群客户端同时重试。
 *
 * 事实（核对日期 2026-11-06，来源见 README）：
 *   - Anthropic 用令牌桶限流：容量连续补充直到上限，不是固定窗口清零；限额是 RPM、ITPM、OTPM 三个，任何一个超了就 429；
 *   - ITPM 只计未缓存的输入（input_tokens + cache_creation_input_tokens），缓存读不计；OTPM 按实际生成的 token 实时计，max_tokens 不影响；
 *   - 429 可以带 retry-after（秒），有就等这么久；不是每个 429 都带；响应头 anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}。
 * 内部细节（不是公开文档，标 internal）：SDK 的退避参数。公开文档只说「指数退避，默认重试 2 次，有 retry-after 时照它等」，
 *   本站的 0.5 秒起步、8 秒封顶、抖动按开源 SDK 的常见写法取，只是示例。
 * 时间一律是模拟时钟（秒），随机数来自固定种子的 PRNG，所以每次运行结果相同。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import type { Header } from './http';

// ---------- 令牌桶 ----------

/** 令牌桶：容量 capacity，每秒补 refillPerSecond，装满为止。 */
export class TokenBucket {
  level: number;
  private at: number;

  constructor(readonly capacity: number, readonly refillPerSecond: number, start = 0) {
    this.level = capacity;
    this.at = start;
  }

  /** 把时间推进到 now，补充令牌。 */
  private advance(now: number): void {
    if (now < this.at) throw new Error('时间不能倒流');
    this.level = Math.min(this.capacity, this.level + (now - this.at) * this.refillPerSecond);
    this.at = now;
  }

  available(now: number): number {
    this.advance(now);
    return this.level;
  }

  /** 够就扣掉并返回 true，不够什么也不动。 */
  tryTake(n: number, now: number): boolean {
    this.advance(now);
    if (this.level + 1e-9 < n) return false;
    this.level -= n;
    return true;
  }

  /** 按实际用量扣（输出 token 是生成出来才知道的），可以扣成负数，之后要等补回来。 */
  spend(n: number, now: number): void {
    this.advance(now);
    this.level -= n;
  }

  /** 还要等多少秒才有 n 个令牌；够了是 0；超过容量永远等不到（Infinity）。 */
  waitFor(n: number, now: number): number {
    this.advance(now);
    if (n > this.capacity) return Infinity;
    return Math.max(0, (n - this.level) / this.refillPerSecond);
  }

  /** 从现在到完全补满还要多少秒。 */
  untilFull(now: number): number {
    this.advance(now);
    return Math.max(0, (this.capacity - this.level) / this.refillPerSecond);
  }
}

export interface Limits {
  /** 每分钟请求数。 */
  rpm: number;
  /** 每分钟输入 token（未缓存的）。 */
  itpm: number;
  /** 每分钟输出 token。 */
  otpm: number;
}

export type LimitName = 'requests' | 'input_tokens' | 'output_tokens';

export type Admission = { ok: true } | { ok: false; limit: LimitName; waitSeconds: number; retryAfter: number };

/**
 * 三个限额的限流器。每个限额一个令牌桶，容量是每分钟的额度，每秒补 额度 / 60。
 * admit：请求到达时检查请求数和输入 token（都够才放行并扣掉）；输出 token 事后用 recordOutput 按实际生成量扣。
 * 不放行时 retryAfter 是整数秒（向上取整，至少 1）：到那时最缺的那个桶刚好够。
 */
export class RateLimiter {
  readonly requests: TokenBucket;
  readonly input: TokenBucket;
  readonly output: TokenBucket;

  constructor(readonly limits: Limits, start = 0) {
    this.requests = new TokenBucket(limits.rpm, limits.rpm / 60, start);
    this.input = new TokenBucket(limits.itpm, limits.itpm / 60, start);
    this.output = new TokenBucket(limits.otpm, limits.otpm / 60, start);
  }

  admit(inputTokens: number, now: number): Admission {
    const waits: Array<[LimitName, number]> = [
      ['requests', this.requests.waitFor(1, now)],
      ['input_tokens', this.input.waitFor(inputTokens, now)],
      // 输出桶被欠着（负数）时，要等回到正数才放行。
      ['output_tokens', this.output.waitFor(1, now)],
    ];
    const worst = waits.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (worst[1] > 0) return { ok: false, limit: worst[0], waitSeconds: worst[1], retryAfter: Math.max(1, Math.ceil(worst[1] - 1e-9)) };
    this.requests.tryTake(1, now);
    this.input.tryTake(inputTokens, now);
    return { ok: true };
  }

  recordOutput(outputTokens: number, now: number): void {
    this.output.spend(outputTokens, now);
  }

  /** anthropic-ratelimit-* 响应头（文档列出的名字）。reset 是 RFC 3339 时间：这个桶完全补满的时刻。 */
  headers(now: number, epoch: number): Header[] {
    const rfc3339 = (seconds: number) => new Date((epoch + now + seconds) * 1000).toISOString();
    const row = (name: string, bucket: TokenBucket): Header[] => [
      [`anthropic-ratelimit-${name}-limit`, String(bucket.capacity)],
      [`anthropic-ratelimit-${name}-remaining`, String(Math.max(0, Math.floor(bucket.available(now))))],
      [`anthropic-ratelimit-${name}-reset`, rfc3339(bucket.untilFull(now))],
    ];
    return [...row('requests', this.requests), ...row('input-tokens', this.input), ...row('output-tokens', this.output)];
  }
}

// ---------- 退避 ----------

export interface RetryPolicy {
  /** 最多重试几次（第一次尝试不算）。SDK 默认 2。 */
  maxRetries: number;
  /** 第一次重试前等多久（毫秒）。 */
  baseMs: number;
  /** 退避的上限（毫秒）。 */
  capMs: number;
  /** 抖动比例：等待时间在 [(1 - jitter) × 退避, 退避] 里随机。0 是没有抖动，1 是完全随机（full jitter）。 */
  jitter: number;
}

/** 本站示例用的策略（internal）：2 次重试，0.5 秒起步，翻倍，8 秒封顶，抖动 25%。 */
export const DEFAULT_POLICY: RetryPolicy = { maxRetries: 2, baseMs: 500, capMs: 8000, jitter: 0.25 };

/** retry-after 的合理上限（秒）：超过这个值不照它等（SDK 的做法，internal）。 */
export const MAX_RETRY_AFTER_SECONDS = 60;

export interface Wait {
  ms: number;
  /** 这次等多久是照 retry-after，还是自己算的退避。 */
  source: 'retry-after' | 'backoff';
  /** 抖动之前的退避（毫秒），retry-after 时为 0。 */
  ceiling: number;
}

/**
 * 第 attempt 次重试（从 0 数）前等多久。有合理的 retry-after（0 到 60 秒）就照它等；
 * 否则退避 = min(上限, 起步 × 2^attempt)，再乘以抖动因子 1 - jitter × rand()。
 */
export function waitBefore(policy: RetryPolicy, attempt: number, rand: () => number, retryAfter?: number | null): Wait {
  if (retryAfter !== undefined && retryAfter !== null && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
    return { ms: retryAfter * 1000, source: 'retry-after', ceiling: 0 };
  }
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return { ms: Math.round(ceiling * (1 - policy.jitter * rand())), source: 'backoff', ceiling };
}

/** 服务端对一次尝试的回答。 */
export interface Attempt {
  status: number;
  retryAfter?: number | null;
  /** 这个错误重试也没用（比如月度消费上限的 429）。 */
  hopeless?: boolean;
}

/** SDK 会重试吗：408、409、429、5xx（见 anthropic.ts 的 isRetryable）。月度消费上限的 429 它也会重试，只是不会成功。 */
export const sdkRetries = (status: number): boolean => status === 408 || status === 409 || status === 429 || status >= 500;

/** 值得重试吗：SDK 会重试的，去掉重试也没用的。 */
export const worthRetrying = (attempt: Attempt): boolean => sdkRetries(attempt.status) && !attempt.hopeless;

export interface TimelineRow {
  /** 第几次尝试，从 1 数。 */
  attempt: number;
  /** 发出这次尝试的时刻（秒）。 */
  at: number;
  status: number;
  /** 失败后要等多久再发下一次；成功或不再重试时为 null。 */
  wait: Wait | null;
}

/**
 * 客户端的重试循环：按 server 的回答决定重试还是放弃。server(attempt, at) 返回这次尝试的结果。
 * 放弃的情况：成功、不值得重试、用完了 maxRetries。
 */
export function retryTimeline(server: (attempt: number, at: number) => Attempt, policy: RetryPolicy, rand: () => number, start = 0): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let at = start;
  for (let attempt = 1; ; attempt++) {
    const result = server(attempt, at);
    const retry = result.status >= 400 && worthRetrying(result) && attempt - 1 < policy.maxRetries;
    const wait = retry ? waitBefore(policy, attempt - 1, rand, result.retryAfter) : null;
    rows.push({ attempt, at, status: result.status, wait });
    if (!wait) return rows;
    at += wait.ms / 1000;
  }
}

// ---------- 一群客户端同时重试 ----------

export interface HerdOptions {
  clients: number;
  policy: RetryPolicy;
  /** 服务端令牌桶：容量和每秒补充量，每个请求扣 1。 */
  capacity: number;
  refillPerSecond: number;
  seed: number;
}

export interface HerdResult {
  /** 每个客户端成功的时刻（秒），放弃了是 null。 */
  doneAt: Array<number | null>;
  succeeded: number;
  gaveUp: number;
  /** 发出的请求总数（含重试）。 */
  requests: number;
  /** 重试请求里，任意一个 100 毫秒窗口最多同时到了多少个（第一轮的齐射不算）。 */
  peak: number;
  /** 每一轮（第 n 次尝试）发出了多少请求。 */
  perAttempt: number[];
}

/**
 * 所有客户端在 t=0 同时发请求，被拒的按 policy 退避后重发（服务端不给 retry-after，只剩退避）。
 * 按时间顺序处理，同一时刻按客户端编号。
 */
export function simulateHerd(options: HerdOptions): HerdResult {
  const rand = mulberry32(options.seed);
  const bucket = new TokenBucket(options.capacity, options.refillPerSecond);
  const next: Array<{ id: number; at: number; attempt: number }> = Array.from({ length: options.clients }, (_, id) => ({ id, at: 0, attempt: 1 }));
  const doneAt: Array<number | null> = Array(options.clients).fill(null);
  const arrivals: number[] = [];
  const retries: number[] = [];
  const perAttempt: number[] = [];
  let gaveUp = 0;
  while (next.length) {
    next.sort((a, b) => a.at - b.at || a.id - b.id);
    const job = next.shift()!;
    arrivals.push(job.at);
    if (job.attempt > 1) retries.push(job.at);
    perAttempt[job.attempt - 1] = (perAttempt[job.attempt - 1] ?? 0) + 1;
    if (bucket.tryTake(1, job.at)) {
      doneAt[job.id] = job.at;
      continue;
    }
    if (job.attempt - 1 >= options.policy.maxRetries) {
      gaveUp++;
      continue;
    }
    const wait = waitBefore(options.policy, job.attempt - 1, rand, null);
    next.push({ id: job.id, at: job.at + wait.ms / 1000, attempt: job.attempt + 1 });
  }
  let peak = 0;
  for (const from of retries) peak = Math.max(peak, retries.filter((t) => t >= from && t < from + 0.1).length);
  return { doneAt, succeeded: doneAt.filter((t) => t !== null).length, gaveUp, requests: arrivals.length, peak, perAttempt };
}
