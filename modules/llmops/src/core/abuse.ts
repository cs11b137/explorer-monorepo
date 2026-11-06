/**
 * 用户标识和滥用追踪：把账号变成不透明的 user_id、每个用户一个令牌桶或滑动窗口限流、记录屡次触发防护的用户并升级处置。
 *
 * - Messages API 的 `metadata.user_id`：文档说它应当是 uuid、哈希值或别的不透明标识，Anthropic 可能用它帮助发现滥用，
 *   不要放姓名、邮箱、电话；最长 512。OpenAI 的 `user` 字段已被 `safety_identifier`（最长 128，建议哈希用户名或邮箱）
 *   和 `prompt_cache_key` 取代。出处见 README 事实表。
 * - 本站用 HMAC-SHA256（密钥只在应用后端）：直接对邮箱做 SHA-256，别人拿常见邮箱逐个算一遍就能对上，加了密钥就不行。截成 32 个十六进制字符。
 * - 令牌桶来自共享包 llm-core 的 TokenBucket（原在 CONTEXT EXPLORER 的 retry 课），这里每个用户一个桶；滑动窗口记下每个请求的时间。
 *   时间是模拟时钟（秒），由调用方给。
 * - 屡犯升级是本站的示例策略（Anthropic 文档建议对反复试图绕过防护的用户调整回应、考虑限流或封禁，没有规定具体次数）。
 */
import { TokenBucket } from '@explorer/llm-core/ratelimit';
import { mulberry32 } from '@explorer/llm-core/prng';
import { hmacSha256, toHex } from '@explorer/llm-core/sha256';

/** 示例密钥（只在应用后端，不进任何请求）。 */
export const EXAMPLE_ID_SECRET = 'xiaopu-user-id-key-2026';

/** 账号 → 不透明的 user_id：HMAC-SHA256(密钥, 账号) 的前 32 个十六进制字符，前面加 `u_`。 */
export const userIdOf = (account: string, secret = EXAMPLE_ID_SECRET): string => `u_${toHex(hmacSha256(secret, account.trim().toLowerCase())).slice(0, 32)}`;

/** Messages API 文档给 metadata.user_id 的长度上限。 */
export const ANTHROPIC_USER_ID_MAX = 512;
/** OpenAI 文档给 safety_identifier 的长度上限。 */
export const OPENAI_SAFETY_ID_MAX = 128;

// ---------- 限流 ----------

export interface Admit {
  ok: boolean;
  /** 放行后（或拒绝时）桶里还剩的令牌，滑动窗口是窗口里还能放几个。 */
  remaining: number;
  /** 被拒时还要等多少秒。 */
  waitSeconds: number;
}

export interface Limiter {
  admit(user: string, now: number, cost?: number): Admit;
}

/** 每个用户一个令牌桶：容量 capacity，每秒补 refillPerSecond。新用户的桶是满的。 */
export class PerUserBuckets implements Limiter {
  readonly buckets = new Map<string, TokenBucket>();
  constructor(readonly capacity: number, readonly refillPerSecond: number) {}

  bucketOf(user: string, now: number): TokenBucket {
    let bucket = this.buckets.get(user);
    if (!bucket) this.buckets.set(user, (bucket = new TokenBucket(this.capacity, this.refillPerSecond, now)));
    return bucket;
  }

  admit(user: string, now: number, cost = 1): Admit {
    const bucket = this.bucketOf(user, now);
    if (bucket.tryTake(cost, now)) return { ok: true, remaining: bucket.available(now), waitSeconds: 0 };
    return { ok: false, remaining: bucket.available(now), waitSeconds: bucket.waitFor(cost, now) };
  }
}

/** 滑动窗口：任意 windowSeconds 秒内每个用户最多 limit 个请求（窗口是 (now − window, now]）。 */
export class SlidingWindow implements Limiter {
  readonly log = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowSeconds: number) {}

  admit(user: string, now: number, cost = 1): Admit {
    const times = (this.log.get(user) ?? []).filter((t) => t > now - this.windowSeconds);
    if (times.length + cost > this.limit) {
      this.log.set(user, times);
      const oldest = times[times.length + cost - this.limit - 1] ?? times[0];
      return { ok: false, remaining: this.limit - times.length, waitSeconds: Math.max(0, oldest + this.windowSeconds - now) };
    }
    for (let i = 0; i < cost; i++) times.push(now);
    this.log.set(user, times);
    return { ok: true, remaining: this.limit - times.length, waitSeconds: 0 };
  }
}

export interface Arrival {
  at: number;
  user: string;
}

export interface Admission extends Arrival {
  result: Admit;
}

/** 按时间顺序把一串请求交给限流器。 */
export function simulate(arrivals: readonly Arrival[], limiter: Limiter): Admission[] {
  return [...arrivals].sort((a, b) => a.at - b.at).map((arrival) => ({ ...arrival, result: limiter.admit(arrival.user, arrival.at) }));
}

/** 泊松到达：平均每秒 rate 个，持续 duration 秒，时间保留 3 位小数（固定种子）。 */
export function poissonArrivals(user: string, rate: number, duration: number, seed: number, start = 0): Arrival[] {
  const rand = mulberry32(seed);
  const out: Arrival[] = [];
  let t = start;
  for (;;) {
    t += -Math.log(1 - rand()) / rate;
    if (t >= start + duration) return out;
    out.push({ at: Math.round(t * 1000) / 1000, user });
  }
}

// ---------- 屡犯升级 ----------

export type Sanction = 'none' | 'warn' | 'throttle' | 'block';

/** 本站的示例策略：窗口内触发防护的次数达到 1、3、5 次，依次提醒、降到慢速限流、暂停服务。 */
export const EXAMPLE_ESCALATION: ReadonlyArray<[count: number, sanction: Sanction]> = [[1, 'warn'], [3, 'throttle'], [5, 'block']];

/** 记录每个用户在 windowSeconds 内触发防护的次数，按次数给出处置。 */
export class OffenderLog {
  readonly strikes = new Map<string, number[]>();
  constructor(readonly windowSeconds = 3600, readonly ladder: ReadonlyArray<[number, Sanction]> = EXAMPLE_ESCALATION) {}

  /** 记一次，返回窗口内的次数和此刻的处置。 */
  record(user: string, now: number): { count: number; sanction: Sanction } {
    const times = [...(this.strikes.get(user) ?? []).filter((t) => t > now - this.windowSeconds), now];
    this.strikes.set(user, times);
    return { count: times.length, sanction: this.sanctionFor(times.length) };
  }

  sanctionFor(count: number): Sanction {
    let out: Sanction = 'none';
    for (const [n, sanction] of this.ladder) if (count >= n) out = sanction;
    return out;
  }
}
