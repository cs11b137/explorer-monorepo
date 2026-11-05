import { describe, expect, it, vi } from 'vitest';
import { createPlayer, timeline, type PlayerState, type Scene } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldProbes, foldStates, packetsOf, type Lesson } from '../src/lessons/types';
import { panelWidgets, type KvWidget } from '../src/scene/widgets';

vi.stubGlobal('performance', performance);

const lesson = LESSONS.find((item) => item.id === 'pipeline')!;

function setup() {
  const applied: string[] = [];
  const stateEnds: number[] = [];
  let lastState: PlayerState | null = null;
  const scene: Scene = {
    run: async (event) => void applied.push(`run:${event.type}`),
    apply: (event) => void applied.push(`apply:${event.type}`),
    overview: () => void applied.push('overview'),
    snapshot: () => null,
    morph: () => undefined,
    clear: () => undefined,
    showStates: (end) => void stateEnds.push(end),
  };
  const player = createPlayer(lesson, scene, (state) => void (lastState = state), {
    wait: async () => undefined,
    transport: { pause: () => undefined, resume: () => undefined },
  });
  const settle = async () => {
    for (let index = 0; index < 400; index++) await Promise.resolve();
  };
  return { player, settle, applied, stateEnds, state: () => lastState as unknown as PlayerState };
}

describe('播放器', () => {
  it('重置后回到概览', async () => {
    const { player, settle, state, applied } = setup();
    player.reset();
    await settle();
    expect(state().started).toBe(false);
    expect(state().done).toBe(false);
    expect(applied).toContain('overview');
    expect(state().steps.every((step) => step === 'todo')).toBe(true);
  });

  it('播放到结束，所有步骤和事件都完成', async () => {
    const { player, settle, state } = setup();
    player.reset();
    player.play();
    await settle();
    expect(state().done).toBe(true);
    expect(state().playing).toBe(false);
    expect(state().steps.every((step) => step === 'done')).toBe(true);
    expect(state().packets.every((packet) => packet === 'past')).toBe(true);
    expect(state().packets.length).toBe(packetsOf(lesson).length);
  });

  it('单步一次只前进一个事件，并停止连播', async () => {
    const { player, settle, state } = setup();
    player.reset();
    player.step();
    await settle();
    expect(state().cursor).toBe(1);
    expect(state().playing).toBe(false);
    player.step();
    await settle();
    expect(state().cursor).toBe(2);
  });

  it('跳到某一步：之前的事件立即生效', async () => {
    const { player, settle, state, applied } = setup();
    player.reset();
    await settle();
    applied.length = 0;
    const events = timeline(lesson);
    const before = events.findIndex((event) => event.step === 2);
    player.jump(2);
    expect(applied.filter((item) => item.startsWith('apply:')).length).toBe(before);
    await settle();
    expect(state().activeStep).toBe(lesson.steps.length - 1);
    expect(state().done).toBe(true);
  });

  it('完成后再 play 会重新开始', async () => {
    const { player, settle, state, applied } = setup();
    player.reset();
    player.play();
    await settle();
    expect(state().done).toBe(true);
    applied.length = 0;
    player.play();
    expect(applied).toContain('overview');
    await settle();
    expect(state().done).toBe(true);
  });

  it('暂停停止连播，toggle 恢复', async () => {
    const { player, settle, state } = setup();
    player.reset();
    player.step();
    await settle();
    player.pause();
    await settle();
    expect(state().playing).toBe(false);
    const at = state().cursor;
    await settle();
    expect(state().cursor).toBe(at);
    player.toggle();
    await settle();
    expect(state().done).toBe(true);
  });

  it('后退时状态面板重新计算，不残留后面的值', () => {
    const events = [
      { type: 'state', node: 'alu', set: { 操作: 'ADD' } },
      { type: 'state', node: 'alu', set: { 操作: 'SUB' } },
    ] as Lesson['steps'][number]['events'];
    expect(foldStates(events, 0).get('alu')).toBeUndefined();
    expect(foldStates(events, 1).get('alu')?.操作).toBe('ADD');
    expect(foldStates(events, 2).get('alu')?.操作).toBe('SUB');
    expect(foldStates(events, 1).get('alu')?.操作).toBe('ADD');
  });

  it('state 事件值为 null 时删除该行', () => {
    const events = [
      { type: 'state', node: 'alu', set: { 操作: 'ADD' } },
      { type: 'state', node: 'alu', set: { 操作: null } },
    ] as Lesson['steps'][number]['events'];
    expect(foldStates(events, 2).get('alu')?.操作).toBeUndefined();
  });

  it('数值面板从事件序列折叠得到：前进、后退、跳步结果相同', () => {
    const events = timeline(lesson);
    const seen = (end: number) => JSON.stringify([...foldProbes(lesson.initial, events, end)]);
    const forward = events.map((_, index) => seen(index + 1));
    const backward = events.map((_, index) => seen(index + 1));
    expect(forward).toEqual(backward);
    expect(seen(0)).toBe(JSON.stringify([...Object.entries(lesson.initial)]));
    expect(seen(events.length)).toBe(forward[forward.length - 1]);
    const firstProbe = events.findIndex((event) => event.type === 'probe');
    expect(seen(firstProbe)).toBe(seen(0));
    expect(seen(firstProbe + 1)).not.toBe(seen(0));
  });

  it('流水线课第 5 拍的面板里，5 级各有一条不同的指令，且和模拟器一致', () => {
    const events = timeline(lesson);
    const stepFour = lesson.steps.findIndex((step) => step.title === '满负荷');
    const end = events.findLastIndex((event) => event.step === stepFour) + 1;
    const panels = foldProbes(lesson.initial, events, end);
    const text = ['sif', 'sid', 'sex', 'smem', 'swb'].map((id) => (panelWidgets(panels.get(id)!)[0] as KvWidget).rows[0][1]);
    expect(text).toEqual(['addi x5, x0, 5', 'addi x4, x0, 4', 'addi x3, x0, 3', 'addi x2, x0, 2', 'addi x1, x0, 1']);
  });

  it('probe 的 hold 决定下一帧的等待时间', async () => {
    const waits: number[] = [];
    const probeLesson: Lesson = {
      ...lesson,
      steps: [{ ...lesson.steps[0], events: [{ type: 'probe', set: {}, hold: 777 }, { type: 'probe', set: {} }] }],
    };
    const scene: Scene = { run: async () => undefined, apply: () => undefined, overview: () => undefined, snapshot: () => null, morph: () => undefined, clear: () => undefined, showStates: () => undefined };
    const player = createPlayer(probeLesson, scene, () => undefined, {
      wait: async (ms) => void waits.push(typeof ms === 'function' ? ms() : ms),
      transport: { pause: () => undefined, resume: () => undefined },
    });
    player.reset();
    player.play();
    for (let index = 0; index < 200; index++) await Promise.resolve();
    expect(waits).toContain(777);
  });

  it('dispose 之后不再通知界面', async () => {
    const { player, settle, state } = setup();
    player.reset();
    await settle();
    const before = state();
    player.dispose();
    player.play();
    await settle();
    expect(state()).toBe(before);
  });
});
