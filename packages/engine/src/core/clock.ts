import { reducedMotion } from './dom';

/** 动画的取消令牌。跳步或重置时把 cancelled 置真，正在进行的补间随即结束。 */
export interface Ctl {
  cancelled: boolean;
}

interface Job {
  remaining: number;
  duration: number;
  ctl: Ctl;
  onTick?: (progress: number) => void;
  resolve: () => void;
}

/** 全部动画共用的时钟：支持变速和暂停，让播放控制对每个补间同时生效。 */
class Clock {
  speed = 1;
  private paused = false;
  private jobs = new Set<Job>();
  private frame = 0;
  private last = 0;

  private loop = (now: number): void => {
    const delta = this.paused ? 0 : (now - this.last) * this.speed;
    this.last = now;
    for (const job of [...this.jobs]) {
      if (job.ctl.cancelled) {
        this.jobs.delete(job);
        job.resolve();
        continue;
      }
      job.remaining -= delta;
      const progress = job.duration > 0 ? Math.min(1, 1 - job.remaining / job.duration) : 1;
      job.onTick?.(Math.max(0, progress));
      if (job.remaining <= 0) {
        this.jobs.delete(job);
        job.resolve();
      }
    }
    this.frame = this.jobs.size ? requestAnimationFrame(this.loop) : 0;
  };

  private add(duration: number, ctl: Ctl, onTick?: (progress: number) => void): Promise<void> {
    if (ctl.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      this.jobs.add({ remaining: duration, duration, ctl, onTick, resolve });
      if (!this.frame) {
        this.last = performance.now();
        this.frame = requestAnimationFrame(this.loop);
      }
    });
  }

  wait(ms: number, ctl: Ctl): Promise<void> {
    return this.add(ms, ctl);
  }

  tween(ms: number, ctl: Ctl, onTick: (progress: number) => void): Promise<void> {
    if (reducedMotion()) {
      if (!ctl.cancelled) onTick(1);
      return Promise.resolve();
    }
    return this.add(ms, ctl, onTick);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }
}

export const clock = new Clock();
