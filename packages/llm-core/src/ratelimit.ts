/**
 * 原在 CONTEXT EXPLORER 的 src/core/retry.ts（那里转导出，接口不变；LLMOPS EXPLORER 的每用户限流也用）。
 *
 * 令牌桶：容量连续补充直到上限，时间是调用方给的模拟时钟（秒）。
 */
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
