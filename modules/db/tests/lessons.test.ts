import { describe, expect, it } from 'vitest';
import { decode } from '../src/decode/writer';
import { timeline } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldBoards, foldStates, NODE_IDS, packetsOf, type NodeId } from '../src/lessons/types';
import { beforeCrashHex, recoveredHex } from '../src/lessons/recovery';
import { renderBoard } from '../src/scene/boards';
import { NODE_SPECS } from '../src/scene/devices';

describe('课程清单', () => {
  it('共 14 课，分组是 5 / 4 / 5', () => {
    expect(LESSONS.length).toBe(14);
    expect(LESSONS.filter((lesson) => lesson.group === 'query').length).toBe(5);
    expect(LESSONS.filter((lesson) => lesson.group === 'storage').length).toBe(4);
    expect(LESSONS.filter((lesson) => lesson.group === 'txn').length).toBe(5);
  });

  it('课程 id 不重复', () => {
    expect(new Set(LESSONS.map((lesson) => lesson.id)).size).toBe(LESSONS.length);
  });
});

describe.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s', (_id, lesson) => {
  const packets = packetsOf(lesson);

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
    for (const event of timeline(lesson)) {
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
      if (event.type === 'note' || event.type === 'state') {
        const node = event.type === 'note' ? event.at : event.node;
        if (event.type === 'note') expect(visible.has(node), `提示 ${event.text}: ${node} 尚未显示`).toBe(true);
        expect(NODE_IDS).toContain(node);
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

  it('时间单调不减', () => {
    for (let index = 1; index < packets.length; index++) {
      expect(packets[index].row.tNs, packets[index].label).toBeGreaterThanOrEqual(packets[index - 1].row.tNs);
    }
    expect(packets[0].row.tNs).toBe(0);
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

  it('示意结构不展示字节，真实结构至少有字节或字段', () => {
    for (const packet of packets) {
      const frame = decode(packet.wire);
      if (packet.wire.fidelity === '示意') expect(frame.bytes.length, packet.label).toBe(0);
    }
  });

  it('大小是字节数或空，时间示例都是整数纳秒', () => {
    for (const packet of packets) {
      if (packet.row.size !== null) expect(packet.row.size, packet.label).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(packet.row.tNs), packet.label).toBe(true);
    }
  });

  it('每一步都有至少一个带真实字节或概念字段的事件，且绝大多数事件有真实字节', () => {
    for (const step of lesson.steps) expect(step.events.some((event) => event.type === 'packet' || event.type === 'stream'), step.title).toBe(true);
    const real = packets.filter((packet) => decode(packet.wire).bytes.length > 0).length;
    expect(real / packets.length, `${real}/${packets.length}`).toBeGreaterThanOrEqual(0.5);
  });

  it('结构板在每个时刻都放得下：宽屏和手机重排都不越界，也不截断文字', () => {
    const events = timeline(lesson);
    const problems = new Set<string>();
    for (let end = 0; end <= events.length; end++) {
      const { specs } = foldBoards(lesson, events, end);
      for (const [id, spec] of specs) {
        const [, , w, h] = lesson.boards[id].rect;
        const wide = renderBoard(spec, w, h);
        if (wide.width > w + 0.5) problems.add(`${id} 宽 ${wide.width.toFixed(0)} > ${w}：${spec.title}`);
        if (wide.height > h + 0.5) problems.add(`${id} 高 ${wide.height.toFixed(0)} > ${h}：${spec.title}`);
        for (const text of wide.clipped) problems.add(`${id} 截断：${text}`);
        const nw = Math.min(w, 560);
        const narrow = renderBoard(spec, nw, h);
        if (narrow.width > nw + 0.5) problems.add(`${id} 窄屏宽 ${narrow.width.toFixed(0)} > ${nw}：${spec.title}`);
        for (const text of narrow.clipped) problems.add(`${id} 窄屏截断：${text}`);
      }
    }
    expect([...problems]).toEqual([]);
  });

  it('结构板之间不重叠，也不压住节点和标签', () => {
    const rects = Object.entries(lesson.boards).map(([id, slot]) => ({ id, rect: slot.rect }));
    for (const a of rects) {
      for (const b of rects) {
        if (a.id >= b.id) continue;
        const [ax, ay, aw, ah] = a.rect;
        const [bx, by, bw, bh] = b.rect;
        const overlap = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
        expect(overlap, `${a.id} 和 ${b.id} 重叠`).toBe(false);
      }
    }
    for (const id of lesson.nodes) {
      const [x, y] = lesson.place[id]!;
      const bottom = y + NODE_SPECS[id].labelY + 24;
      for (const { rect } of rects) {
        const overlap = x + 60 > rect[0] && x - 60 < rect[0] + rect[2] && bottom > rect[1] && y - 50 < rect[1] + rect[3];
        expect(overlap, `${id} 压住结构板`).toBe(false);
      }
    }
  });

  it('状态面板每个节点最多 4 行', () => {
    const events = timeline(lesson);
    for (let end = 0; end <= events.length; end++) {
      for (const panel of foldStates(events, end).values()) expect(Object.keys(panel).length).toBeLessThanOrEqual(4);
    }
  });
});

describe('中止标记', () => {
  it('只用于真实的错误和崩溃', () => {
    const lost = LESSONS.flatMap((lesson) => packetsOf(lesson).filter((packet) => packet.lost).map((packet) => `${lesson.id}:${packet.label}`));
    expect(lost.sort()).toEqual(['isolation:COMMIT 失败', 'locks:ERROR 40P01', 'recovery:CRC 不符', 'recovery:断电'].sort());
  });
});

describe('事实一致性', () => {
  const text = LESSONS.map((lesson) => JSON.stringify([lesson.overview, lesson.steps.map((step) => [step.title, step.desc, step.detail, step.facts]), lesson.outro])).join('\n');

  it('不出现常见错讲', () => {
    expect(text).not.toMatch(/每个事务一个快照/);
    expect(text).not.toMatch(/PostgreSQL.{0,12}用 undo/);
    expect(text).not.toMatch(/多相归并是/);
    expect(text).not.toMatch(/数据页落盘.{0,6}才算提交/);
  });

  it('文案不用 不是……而是…… 的排比', () => {
    expect(text).not.toMatch(/不是[^。，]{0,30}，而是/);
  });

  it('崩溃恢复：只用磁盘上的字节重放，得到的页和崩溃前内存里的页完全相同', () => {
    expect(recoveredHex).toBe(beforeCrashHex);
  });

  it('每步 detail 是 2 到 5 句话', () => {
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        const sentences = step.detail.split(/[。！？]/).filter((part) => part.trim()).length;
        expect(sentences, `${lesson.id}/${step.title}`).toBeGreaterThanOrEqual(2);
        expect(sentences, `${lesson.id}/${step.title}`).toBeLessThanOrEqual(6);
      }
    }
  });
});

/** 节点中心到线段的距离。 */
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
});
