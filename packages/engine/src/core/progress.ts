const KEY = {
  progress: 'explorer:progress',
  theme: 'explorer:theme',
  view: 'explorer:view',
  speed: 'explorer:speed',
};

/** 每站用自己的前缀，同一域名下几个站的进度互不影响。必须在读取进度之前调用。 */
export function configureProgress(prefix: string): void {
  KEY.progress = `${prefix}:progress`;
  KEY.theme = `${prefix}:theme`;
  KEY.view = `${prefix}:view`;
  KEY.speed = `${prefix}:speed`;
  progress = loadProgress();
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下存储可能不可用；此时只是不保留进度。
  }
}

interface LessonProgress {
  seen: number[];
  done: boolean;
}

export type LessonStatus = 'new' | 'progress' | 'done';

function loadProgress(): Record<string, LessonProgress> {
  try {
    const parsed = JSON.parse(read(KEY.progress) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let progress: Record<string, LessonProgress> = {};

/** 记录观看进度。返回值表示是否有变化，有变化时界面才需要刷新。 */
export function recordProgress(id: string, stepCount: number, state: { started: boolean; done: boolean; activeStep: number }): boolean {
  const entry = (progress[id] ??= { seen: [], done: false });
  let changed = false;
  if (state.started && !state.done && !entry.seen.includes(state.activeStep)) {
    entry.seen.push(state.activeStep);
    changed = true;
  }
  if (state.done && !entry.done) {
    entry.done = true;
    entry.seen = Array.from({ length: stepCount }, (_, index) => index);
    changed = true;
  }
  if (changed) write(KEY.progress, JSON.stringify(progress));
  return changed;
}

/** 看完所有步骤但没播完时停在 (n-1)/n，只有播放完成才算 100%。 */
export function lessonFraction(id: string, stepCount: number): number {
  const entry = progress[id];
  if (!entry) return 0;
  if (entry.done) return 1;
  return Math.min(entry.seen.length, stepCount - 1) / stepCount;
}

export function lessonStatus(id: string): LessonStatus {
  const entry = progress[id];
  if (entry?.done) return 'done';
  return entry?.seen.length ? 'progress' : 'new';
}

export const loadTheme = () => read(KEY.theme);
export const saveTheme = (theme: string) => write(KEY.theme, theme);
export const loadView = () => read(KEY.view);
export const saveView = (view: string) => write(KEY.view, view);
export const loadSpeed = () => Number(read(KEY.speed));
export const saveSpeed = (speed: number) => write(KEY.speed, String(speed));
