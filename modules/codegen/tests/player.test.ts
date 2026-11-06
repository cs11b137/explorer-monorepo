import { describe, expect, it, vi } from 'vitest';
import { createPlayer, timeline, type PlayerState, type Scene } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldArts, focusSlot, packetsOf, type LessonEvent } from '../src/lessons/types';
import { renderArt, type ArtView } from '../src/scene/art';

vi.stubGlobal('performance', performance);

const lesson = LESSONS.find((item) => item.id === 'lexer')!;

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
  // 假时钟下全是微任务，等一个宏任务就能全部跑完。
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
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

describe('产物面板的折叠语义', () => {
  it.each(LESSONS.map((item) => [item.id, item] as const))('%s：前进、后退、跳步都重算出同样的状态', (_id, item) => {
    const events = timeline(item);
    // 一路走过去记下每一刻的画面，再乱序重算，必须相同。
    const render = (end: number) => JSON.stringify([...foldArts(events, end, item.initial)].map(([slot, view]) => [slot, renderArt(view, item.panels[slot][2], item.panels[slot][3]).svg]));
    const forward = events.map((_, end) => render(end));
    const shuffled = events.map((_, end) => (end * 7 + 3) % events.length);
    for (const end of shuffled) expect(render(end)).toBe(forward[end]);
    for (let end = events.length - 1; end >= 0; end--) expect(render(end)).toBe(forward[end]);
  });

  it('后退时不残留后面的内容', () => {
    const events = timeline(lesson);
    const firstToken = events.findIndex((event) => event.type === 'packet' && event.art && 'toks' in event.art);
    expect(foldArts(events, firstToken, lesson.initial).has('toks')).toBe(false);
    expect(foldArts(events, firstToken + 1, lesson.initial).has('toks')).toBe(true);
    expect(foldArts(events, firstToken, lesson.initial).has('toks')).toBe(false);
  });

  it('动态链接课：GOT[3] 在解析之后才是 scale，跳回去又变回 PLT 的地址', () => {
    const dyn = LESSONS.find((item) => item.id === 'dynlink')!;
    const events = timeline(dyn);
    const gotRow = (end: number) => {
      const view = foldArts(events, end, dyn.initial).get('got');
      return view && view.kind === 'table' ? view.rows[3].cells.slice(2) : null;
    };
    const written = events.findIndex((event) => event.type === 'packet' && event.row.info.startsWith('回填 GOT[3]'));
    expect(written).toBeGreaterThan(0);
    expect(gotRow(written)).toEqual(['201056', 'scale@plt+6']);
    expect(gotRow(written + 1)).toEqual(['7ffff7fc4000', 'scale']);
    expect(gotRow(events.findIndex((event) => event.step === 2))).toBeNull();
    expect(gotRow(written)).toEqual(['201056', 'scale@plt+6']);
  });

  it('正则课：子集表逐行长出来，最小化之后换成对照表', () => {
    const re = LESSONS.find((item) => item.id === 'regex')!;
    const events = timeline(re);
    const titles = events.map((_, end) => foldArts(events, end + 1, re.initial).get('subset')?.title ?? null);
    expect(titles[0]).toBeNull();
    expect(titles).toContain('子集构造');
    expect(titles.at(-1)).toBe('和词法器的转移表对照');
    const rows = events.map((_, end) => {
      const view = foldArts(events, end + 1, re.initial).get('subset');
      return view?.title === '子集构造' && view.kind === 'table' ? view.rows.length : 0;
    });
    expect(Math.max(...rows)).toBe(6);
    expect(rows.filter(Boolean)).toEqual([...rows.filter(Boolean)].sort((a, b) => a - b));
  });

  it('值为 null 时删除面板', () => {
    const view: ArtView = { kind: 'code', title: 't', lines: [] };
    const events: LessonEvent[] = [{ type: 'art', set: { a: view } }, { type: 'art', set: { a: null } }];
    expect(foldArts(events, 1, {}).has('a')).toBe(true);
    expect(foldArts(events, 2, {}).has('a')).toBe(false);
  });

  it('窄屏相机对准第一个键的面板，没有更新时用默认值', () => {
    const view: ArtView = { kind: 'code', title: 't', lines: [] };
    const events: LessonEvent[] = [{ type: 'art', set: { b: view, a: view } }];
    expect(focusSlot(events, 0, 'x')).toBe('x');
    expect(focusSlot(events, 1, 'x')).toBe('b');
  });
});
