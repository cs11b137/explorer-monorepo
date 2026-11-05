import { clock, type Ctl } from './clock';
import type { EventLike, KnownEvent, LessonLike, Stamped } from '../types';

export type TimelineState = 'future' | 'past' | 'current';

export interface PlayerState<E = any> {
  playing: boolean;
  running: boolean;
  started: boolean;
  done: boolean;
  activeStep: number;
  event: Stamped<E> | null;
  steps: Array<'todo' | 'active' | 'done'>;
  /** 每个 packet 的显示状态。stream 里的每个 packet 单独占一项。 */
  packets: TimelineState[];
  notes: TimelineState[];
  cursor: number;
}

export interface Scene<E = any> {
  run(event: E, ctl: Ctl): Promise<void>;
  apply(event: E): void;
  overview(): void;
  snapshot(): unknown;
  morph(snapshot: unknown, ctl: Ctl): void;
  clear(): void;
  showStates(end: number): void;
}

export interface PlayerOptions {
  mode?: 'network' | 'sequence';
  wait?: (ms: number | (() => number), ctl: Ctl) => Promise<void>;
  transport?: { pause(): void; resume(): void };
  /** 改写两个事件之间的等待。返回 undefined 时用默认节奏。跨步骤的等待不经过这里。 */
  gap?(current: any, next: any, pace: Pace, mode: 'network' | 'sequence'): number | undefined;
  /** 课程播完后不再把最后一个事件标为当前。 */
  clearCurrentOnDone?: boolean;
}

export interface Pace {
  event: number;
  step: number;
  quick: number;
}

const PACE = {
  network: { event: 450, step: 1100, quick: 120 },
  sequence: { event: 260, step: 650, quick: 80 },
} as const;

const DRAW = { packet: 620, quick: 320, stagger: 160, note: 700 };

const isPacket = (event: EventLike) => event.type === 'packet' || event.type === 'stream';

/** 时序视图不走场景动画，用这段时长代替箭头绘制。 */
function sequenceDuration(raw: EventLike): number {
  const event = raw as KnownEvent;
  if (event.type === 'packet') return event.quick ? DRAW.quick : DRAW.packet;
  if (event.type === 'stream') return (event.packets.length - 1) * DRAW.stagger + DRAW.packet;
  if (event.type === 'note') return DRAW.note;
  return 0;
}

export function timeline<E extends EventLike>(lesson: { start: readonly string[]; steps: Array<{ events: E[] }> }): Array<Stamped<E>> {
  return [
    { type: 'focus', nodes: lesson.start, step: 0 } as unknown as Stamped<E>,
    ...lesson.steps.flatMap((step, index) => step.events.map((event) => ({ ...event, step: index }) as Stamped<E>)),
  ];
}

export function createPlayer<E extends EventLike>(lesson: LessonLike<E>, scene: Scene<any>, onState: (state: PlayerState<E>) => void, options: PlayerOptions = {}) {
  const events = timeline(lesson);
  const lastOfStep = lesson.steps.map((_, index) => events.findLastIndex((event) => event.step === index));
  const wait = options.wait ?? ((ms, ctl) => clock.wait(typeof ms === 'function' ? ms() : ms, ctl));
  const transport = options.transport ?? clock;
  let mode = options.mode ?? 'network';
  let cursor = 0;
  let running = -1;
  let playing = false;
  let runCtl: Ctl & { finish?: boolean } = { cancelled: false };
  let gapCtl: Ctl | null = null;
  let disposed = false;
  let queued = false;

  function state(): PlayerState<E> {
    const done = cursor >= events.length && running === -1;
    const started = cursor > 0 || running !== -1;
    const head = running !== -1 ? running : cursor - 1;
    const activeStep = head >= 0 ? events[head].step : 0;
    const current = !(options.clearCurrentOnDone && done) && head >= 0 && isPacket(events[head]) ? head : -1;
    const stateAt = (index: number): TimelineState => (index === current ? 'current' : index < cursor ? 'past' : 'future');
    return {
      playing,
      running: running !== -1,
      started,
      done,
      activeStep,
      event: head >= 0 ? events[head] : null,
      steps: lesson.steps.map((_, index) =>
        index === activeStep && started && !done ? 'active' : lastOfStep[index] < cursor ? 'done' : 'todo',
      ),
      packets: (events as unknown as KnownEvent[]).flatMap((event, index) => {
        if (event.type === 'packet') return [stateAt(index)];
        if (event.type === 'stream') return event.packets.map(() => stateAt(index));
        return [];
      }),
      notes: events.flatMap((event, index) =>
        event.type === 'note' ? [index < cursor || index === running ? ('past' as const) : ('future' as const)] : [],
      ),
      cursor,
    };
  }

  function emit(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) onState(state());
    });
  }

  function jumpScene(): void {
    const before = scene.snapshot();
    if (cursor === 0) scene.overview();
    else events.slice(0, cursor).forEach((event) => scene.apply(event));
    scene.showStates(cursor);
    scene.morph(before, runCtl);
  }

  function gapAfter(index: number): number {
    const next = events[index + 1];
    const pace = PACE[mode];
    if (next.step !== events[index].step) return pace.step;
    const custom = options.gap?.(events[index], next, pace, mode);
    if (custom !== undefined) return custom;
    const current = events[index] as unknown as { quick?: boolean };
    return (next as unknown as { quick?: boolean }).quick && current.quick ? pace.quick : pace.event;
  }

  async function advance(): Promise<void> {
    if (running !== -1) return;
    if (cursor >= events.length) {
      playing = false;
      emit();
      return;
    }
    const index = cursor;
    const ctl = runCtl;
    running = index;
    emit();
    if (mode === 'sequence') {
      scene.apply(events[index]);
      scene.showStates(index + 1);
      await wait(sequenceDuration(events[index]), ctl);
    } else {
      await scene.run(events[index], ctl);
      if (!ctl.cancelled) scene.showStates(index + 1);
    }
    if (ctl !== runCtl) return;
    if (ctl.finish) {
      runCtl = { cancelled: false };
      scene.clear();
      scene.apply(events[index]);
      scene.showStates(index + 1);
    }
    running = -1;
    cursor = index + 1;
    if (cursor >= events.length) playing = false;
    emit();
    if (!playing) return;
    const gap: Ctl = (gapCtl = { cancelled: false });
    await wait(() => gapAfter(index), gap);
    if (gapCtl === gap) gapCtl = null;
    if (!gap.cancelled && playing) void advance();
  }

  function interrupt(): void {
    runCtl.cancelled = true;
    runCtl = { cancelled: false };
    if (gapCtl) gapCtl.cancelled = true;
    gapCtl = null;
    running = -1;
    scene.clear();
    transport.resume();
  }

  function reset(): void {
    interrupt();
    playing = false;
    cursor = 0;
    jumpScene();
    emit();
  }

  function play(): void {
    if (cursor >= events.length && running === -1) reset();
    playing = true;
    transport.resume();
    emit();
    if (running === -1 && !gapCtl) void advance();
  }

  function pause(): void {
    playing = false;
    transport.pause();
    emit();
  }

  return {
    reset,
    play,
    pause,
    toggle: () => (playing ? pause() : play()),
    step(): void {
      playing = false;
      if (gapCtl) gapCtl.cancelled = true;
      gapCtl = null;
      transport.resume();
      emit();
      if (running === -1) void advance();
    },
    jump(step: number): void {
      interrupt();
      cursor = events.findIndex((event) => event.step === step);
      jumpScene();
      play();
    },
    setMode(next: 'network' | 'sequence'): void {
      if (next === mode) return;
      mode = next;
      // 切到时序视图时，正在进行的场景动画立刻结束。
      if (next === 'sequence' && running !== -1) {
        runCtl.finish = true;
        runCtl.cancelled = true;
      }
    },
    dispose(): void {
      interrupt();
      playing = false;
      disposed = true;
    },
    state,
  };
}

export type Player = ReturnType<typeof createPlayer>;
