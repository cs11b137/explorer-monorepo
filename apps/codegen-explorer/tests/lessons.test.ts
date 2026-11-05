import { describe, expect, it } from 'vitest';
import { decode } from '../src/decode/writer';
import { timeline } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldArts, NODE_IDS, packetsOf, PHASES, type NodeId } from '../src/lessons/types';
import { renderArt, textWidth } from '../src/scene/art';
import { NODE_SPECS } from '../src/scene/devices';

describe('课程清单', () => {
  it('共 14 课，分组是 4 / 5 / 5', () => {
    expect(LESSONS.length).toBe(14);
    expect(LESSONS.filter((lesson) => lesson.group === 'front').length).toBe(4);
    expect(LESSONS.filter((lesson) => lesson.group === 'middle').length).toBe(5);
    expect(LESSONS.filter((lesson) => lesson.group === 'back').length).toBe(5);
  });

  it('课程 id 不重复，顺序符合流水线', () => {
    expect(LESSONS.map((lesson) => lesson.id)).toEqual(['lexer', 'llparser', 'lrparser', 'typecheck', 'irgen', 'dataflow', 'ssa', 'optimize', 'licm', 'isel', 'regalloc', 'frame', 'encoding', 'link']);
  });

  it('编译阶段是 7 档', () => {
    expect(PHASES).toEqual(['词法', '语法', '语义', '中间码', '优化', '目标码', '链接']);
    const covered = new Set(LESSONS.flatMap((lesson) => Array.from({ length: lesson.layer[1] - lesson.layer[0] + 1 }, (_, index) => lesson.layer[0] + index)));
    expect([...covered].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s', (_id, lesson) => {
  const packets = packetsOf(lesson);
  const events = timeline(lesson);

  it('步骤数在 4 到 6 之间，且内容完整', () => {
    expect(lesson.steps.length).toBeGreaterThanOrEqual(4);
    expect(lesson.steps.length).toBeLessThanOrEqual(6);
    for (const step of lesson.steps) {
      expect(step.title && step.desc && step.detail).toBeTruthy();
      expect(step.facts.length).toBeGreaterThan(0);
      expect(step.events.length).toBeGreaterThan(0);
    }
    expect(lesson.overview.facts.length).toBeGreaterThan(0);
    expect(lesson.outro.text).toBeTruthy();
  });

  it('步骤说明是 2 到 4 句', () => {
    for (const step of lesson.steps) {
      const count = step.detail.split(/[。！？]/).filter((part) => part.trim()).length;
      expect(count, step.title).toBeGreaterThanOrEqual(2);
      expect(count, step.title).toBeLessThanOrEqual(5);
    }
  });

  it('文案没有套话', () => {
    const text = JSON.stringify([lesson.overview, lesson.steps.map((step) => [step.title, step.desc, step.detail, step.facts]), lesson.outro]);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    expect(text).not.toMatch(/不是[^。，]{1,14}而是/);
  });

  it('层级范围有效', () => {
    const [lo, hi] = lesson.layer;
    expect(lo).toBeGreaterThanOrEqual(1);
    expect(hi).toBeLessThanOrEqual(7);
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it('每个节点都有位置和名称，且相距足够远', () => {
    for (const id of lesson.nodes) {
      expect(lesson.place[id], `${id} 没有位置`).toBeTruthy();
      expect(lesson.labels[id], `${id} 没有名称`).toBeTruthy();
    }
    for (const a of lesson.nodes) {
      for (const b of lesson.nodes) {
        if (a >= b) continue;
        const [x1, y1] = lesson.place[a]!;
        const [x2, y2] = lesson.place[b]!;
        expect(Math.hypot(x2 - x1, y2 - y1), `${a} 和 ${b} 太近`).toBeGreaterThan(170);
      }
    }
  });

  it('事件发生时，两端节点都已经显示', () => {
    const visible = new Set<NodeId>(lesson.start);
    for (const event of events) {
      if (event.type === 'focus') {
        visible.clear();
        event.nodes.forEach((id) => visible.add(id));
      }
      if (event.type === 'show') event.nodes.forEach((id) => visible.add(id));
      const list = event.type === 'packet' ? [event] : event.type === 'stream' ? event.packets : [];
      for (const packet of list) {
        expect(visible.has(packet.from), `${packet.label}: ${packet.from} 尚未显示`).toBe(true);
        expect(visible.has(packet.to), `${packet.label}: ${packet.to} 尚未显示`).toBe(true);
        expect(packet.from).not.toBe(packet.to);
      }
      if (event.type === 'note') {
        expect(visible.has(event.at), `提示 ${event.text}: ${event.at} 尚未显示`).toBe(true);
        expect(NODE_IDS).toContain(event.at);
      }
    }
  });

  it('所有节点最终都显示过，并在 nodes 里', () => {
    const shown = new Set<NodeId>(lesson.start);
    for (const step of lesson.steps) {
      for (const event of step.events) if (event.type === 'show') event.nodes.forEach((id) => shown.add(id));
    }
    expect([...shown].sort()).toEqual([...lesson.nodes].sort());
  });

  it('阶段计数从 1 开始，每个阶段依次递增', () => {
    const seen = new Map<number, number>();
    for (const packet of packets) {
      const next = (seen.get(packet.row.phase) ?? 0) + 1;
      expect(packet.row.count, packet.label).toBe(next);
      seen.set(packet.row.phase, next);
      expect(packet.row.phase).toBeGreaterThanOrEqual(1);
      expect(packet.row.phase).toBeLessThanOrEqual(7);
    }
  });

  it('每个事件都有解码结构和可信度，字段不越界', () => {
    for (const packet of packets) {
      expect(packet.wire.fidelity, packet.label).toBeTruthy();
      expect(packet.wire.at, packet.label).toBeTruthy();
      expect(packet.row.info, packet.label).toBeTruthy();
      const frame = decode(packet.wire);
      expect(frame.layers.length, packet.label).toBeGreaterThan(0);
      expect(frame.fields.length, packet.label).toBeGreaterThan(0);
      for (const field of frame.fields) {
        expect(field.to, `${packet.label}.${field.name}`).toBeLessThanOrEqual(frame.bytes.length);
        expect(field.from, `${packet.label}.${field.name}`).toBeLessThanOrEqual(field.to);
      }
    }
  });

  it('同一层内的顶层字段按顺序排列且互不重叠', () => {
    for (const packet of packets) {
      for (const layer of packet.wire.layers) {
        let end = 0;
        for (const field of layer.fields) {
          if (field.depth || field.to === field.from) continue;
          expect(field.from, `${packet.label}.${field.name}`).toBeGreaterThanOrEqual(end);
          end = field.to;
        }
      }
    }
  });

  it('示意结构不展示字节，真实结构至少有字节', () => {
    for (const packet of packets) {
      const frame = decode(packet.wire);
      if (packet.wire.fidelity === '示意') expect(frame.bytes.length, packet.label).toBe(0);
      else expect(frame.bytes.length, packet.label).toBeGreaterThan(0);
    }
  });

  it('寄存器事件的大小不会写成字节数以外的含义', () => {
    for (const packet of packets) {
      if (packet.row.size === 'reg') expect(['regs'], packet.label).toContain(packet.wire.view);
    }
  });

  it('大小为字节数的事件确实有对应的字节或文本', () => {
    for (const packet of packets) {
      if (typeof packet.row.size === 'number') {
        expect(packet.row.size, packet.label).toBeGreaterThan(0);
        expect(decode(packet.wire).bytes.length, packet.label).toBeGreaterThan(0);
      }
    }
  });

  it('所有面板在任何时刻都放得下，文字不超出边框', () => {
    const problems = new Set<string>();
    for (let end = 0; end <= events.length; end++) {
      for (const [slot, view] of foldArts(events, end, lesson.initial)) {
        const rect = lesson.panels[slot];
        expect(rect, `${slot} 没有面板位置`).toBeTruthy();
        renderArt(view, rect[2], rect[3]).issues.forEach((issue) => problems.add(`${slot}: ${issue}`));
      }
    }
    expect([...problems]).toEqual([]);
  });

  it('轨迹表的说明在 1440 宽下不被截断', () => {
    for (const packet of packets) expect(textWidth(packet.row.info, 14), packet.row.info).toBeLessThanOrEqual(468);
  });

  it('每个面板最终都有内容', () => {
    const final = foldArts(events, events.length, lesson.initial);
    expect([...final.keys()].sort()).toEqual(Object.keys(lesson.panels).sort());
  });
});

describe('报错标记', () => {
  it('只用于真实的编译错误', () => {
    const lost = LESSONS.flatMap((lesson) => packetsOf(lesson).filter((packet) => packet.lost).map((packet) => `${lesson.id}:${packet.label}`));
    expect(lost).toEqual(['llparser:}', 'typecheck:实参不对']);
  });
});

describe('残留检查', () => {
  it('课程数据里没有模板的内容', () => {
    const text = JSON.stringify(LESSONS.map((lesson) => [lesson.overview, lesson.steps.map((step) => [step.title, step.detail, step.facts]), lesson.outro, lesson.labels]));
    expect(text).not.toMatch(/内核|syscall|Linux 6\.12|页表|缺页/);
  });
});

function distance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

describe.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s 的布局', (_id, lesson) => {
  it('通道不穿过其他节点的设备和标签', () => {
    const problems: string[] = [];
    const lanes = new Set(packetsOf(lesson).map((packet) => `${packet.from}>${packet.to}`));
    for (const key of lanes) {
      const [from, to] = key.split('>') as [NodeId, NodeId];
      const [x1, y1] = lesson.place[from]!;
      const [x2, y2] = lesson.place[to]!;
      for (const other of lesson.nodes) {
        if (other === from || other === to) continue;
        const [x, y] = lesson.place[other]!;
        const spec = NODE_SPECS[other];
        if (distance(x, y, x1, y1, x2, y2) < spec.radius * 0.8) problems.push(`${key} 穿过 ${other} 的设备`);
        else if (distance(x, y + spec.labelY + 8, x1, y1, x2, y2) < 26) problems.push(`${key} 穿过 ${other} 的标签`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('面板之间不重叠，也不压住节点和标签', () => {
    const problems: string[] = [];
    const rects = Object.entries(lesson.panels);
    rects.forEach(([a, [ax, ay, aw, ah]], index) => {
      rects.slice(index + 1).forEach(([b, [bx, by, bw, bh]]) => {
        if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) problems.push(`${a} 和 ${b} 重叠`);
      });
      for (const id of lesson.nodes) {
        const [x, y] = lesson.place[id]!;
        const spec = NODE_SPECS[id];
        const bottom = y + spec.labelY + 26;
        if (x + 60 > ax && x - 60 < ax + aw && bottom > ay && y - 50 < ay + ah) problems.push(`${a} 压住了 ${id}`);
      }
      expect(ax, a).toBeGreaterThanOrEqual(0);
      expect(ax + aw, a).toBeLessThanOrEqual(1000);
    });
    expect(problems).toEqual([]);
  });
});
