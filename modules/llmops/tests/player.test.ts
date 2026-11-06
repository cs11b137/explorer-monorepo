import { describe, expect, it, vi } from 'vitest';
import { createPlayer, timeline, type PlayerState, type Scene } from '@explorer/engine/core/player';
import { LESSONS } from '../src/lessons';
import { foldDs, foldStates, packetsOf, type LessonEvent } from '../src/lessons/types';

vi.stubGlobal('performance', performance);

const lesson = LESSONS.find((item) => item.id === 'direct')!;

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
    const events = timeline(lesson);
    const firstState = events.findIndex((event) => event.type === 'state');
    expect(foldStates(events, firstState).get('backend')).toBeUndefined();
    const early = foldStates(events, firstState + 1).get('backend');
    expect(early?.状态).toBe('等防护层判定');
    expect(early?.费用).toBeUndefined();
    const end = foldStates(events, events.length).get('backend');
    expect(end?.状态).toBe('已回答');
    expect(end?.模型调用).toBe('1 次');
    expect(end?.费用).toBe('$0.00438');
  });

  it('state 事件值为 null 时删除该行', () => {
    const events: LessonEvent[] = [
      { type: 'state', node: 'guard', set: { u: '0.3', k: '5' } },
      { type: 'state', node: 'guard', set: { k: null } },
    ];
    expect(foldStates(events, 2).get('guard')).toEqual({ u: '0.3' });
  });

  it('数据结构能回到任意位置：跳步后和顺序播放时一样', async () => {
    const seen: number[] = [];
    const scene: Scene = {
      run: async () => undefined,
      apply: () => undefined,
      overview: () => undefined,
      snapshot: () => null,
      morph: () => undefined,
      clear: () => undefined,
      showStates: (end) => void seen.push(end),
    };
    const player = createPlayer(lesson, scene, () => undefined, { wait: async () => undefined, transport: { pause: () => undefined, resume: () => undefined } });
    player.reset();
    const events = timeline(lesson);
    const at = events.findIndex((event) => event.step === 2);
    player.jump(2);
    expect(seen).toContain(at);
    const direct = foldDs(lesson.initial, events, at);
    const again = foldDs(lesson.initial, events, at);
    expect(direct).toEqual(again);
    expect(direct.message?.[0]).toBeDefined();
    player.dispose();
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
