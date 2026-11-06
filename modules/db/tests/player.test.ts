import { describe, expect, it, vi } from 'vitest';
import { createPlayer, timeline, type PlayerState, type Scene } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldBoards, foldStates, packetsOf } from '../src/lessons/types';

vi.stubGlobal('performance', performance);

const lesson = LESSONS.find((item) => item.id === 'parse')!;

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

  it('后退时结构板重新计算，不残留后面的状态', () => {
    const events = timeline(lesson);
    const firstBoard = events.findIndex((event) => event.type === 'board');
    const before = foldBoards(lesson, events, firstBoard);
    expect(before.latest).toBeNull();
    const initial = lesson.boards.tokens.initial;
    expect(before.specs.get('tokens')).toBe(initial);
    const later = foldBoards(lesson, events, firstBoard + 1);
    expect(later.specs.get('tokens')).not.toBe(initial);
    const end = foldBoards(lesson, events, events.length);
    expect(end.specs.get('tree')).not.toBe(lesson.boards.tree.initial);
    // 再回到中间：结果和第一次算的一样，说明没有隐藏状态。
    expect(foldBoards(lesson, events, firstBoard + 1).specs.get('tokens')).toBe(later.specs.get('tokens'));
    expect(foldBoards(lesson, events, firstBoard).specs.get('tokens')).toBe(initial);
  });

  it('跨越结构板的每个位置，折叠结果都和从头计算一样', () => {
    for (const item of LESSONS) {
      const events = timeline(item);
      for (let end = 0; end <= events.length; end += 3) {
        const once = foldBoards(item, events, end);
        const twice = foldBoards(item, events, end);
        expect([...once.specs.keys()]).toEqual([...twice.specs.keys()]);
        for (const [id, spec] of once.specs) expect(twice.specs.get(id)).toBe(spec);
      }
    }
  });

  it('LSM 课：跳回合并之前，L0 的两个文件又回来了', () => {
    const lsm = LESSONS.find((item) => item.id === 'lsm')!;
    const events = timeline(lsm);
    const cellsOf = (end: number, row: string) => {
      const spec = foldBoards(lsm, events, end).specs.get('lsm')!;
      if (spec.kind !== 'lanes') throw new Error('lsm 结构板应该是 lanes');
      return spec.rows.find((r) => r.label === row)!.cells.filter((c) => !c.gap).map((c) => c.text);
    };
    const lastStep = events.findIndex((event) => event.step === lsm.steps.length - 1);
    expect(cellsOf(lastStep, 'L0')).toEqual(['#14', 'ann', 'cat', 'dan', 'fay', '#11', 'cat', 'eve', 'gus', 'hal']);
    expect(cellsOf(events.length, 'L0')).toEqual([]);
    expect(cellsOf(events.length, 'L1')[0]).toBe('#15');
    // 先折叠到结尾再回到合并之前，得到的是同一个结构板对象，没有残留。
    expect(foldBoards(lsm, events, lastStep).specs.get('lsm')).toBe(foldBoards(lsm, events, lastStep).specs.get('lsm'));
    expect(cellsOf(0, 'MemTable')).toEqual([]);
  });

  it('state 事件值为 null 时删除该行', () => {
    const events = [{ type: 'state', node: 'client', set: { a: '1' } }, { type: 'state', node: 'client', set: { a: null } }] as Parameters<typeof foldStates>[0];
    expect(foldStates(events, 2).get('client')?.a).toBeUndefined();
    expect(foldStates(events, 1).get('client')?.a).toBe('1');
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
