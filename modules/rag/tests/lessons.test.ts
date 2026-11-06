import { describe, expect, it } from 'vitest';
import { timeline } from '@explorer/engine/core/player';
import { decode } from '../src/decode/writer';
import { LESSONS, PLANNED } from '../src/lessons';
import { foldDs, foldStates, NODE_IDS, packetsOf, type Lesson, type NodeId } from '../src/lessons/types';
import { hasArt, NODE_SPECS } from '../src/scene/devices';
import { boundsOf, itemsOf, lessonBounds, type Box } from '../src/scene/ds';

describe('课程清单', () => {
  it('计划 14 课，分组是 3 / 5 / 6', () => {
    expect(PLANNED).toHaveLength(14);
    expect(PLANNED.filter((item) => item.group === 'embed').map((item) => item.id)).toEqual(['embedtext', 'similarity', 'chunking']);
    expect(PLANNED.filter((item) => item.group === 'index').map((item) => item.id)).toEqual(['flat', 'ivf', 'hnsw', 'pq', 'hybrid']);
    expect(PLANNED.filter((item) => item.group === 'pipeline').map((item) => item.id)).toEqual(['ingest', 'qa', 'rerank', 'rewrite', 'evaluate', 'finetune']);
  });

  it('已实现的课按计划的顺序排列，分组和计划一致', () => {
    const done = new Set(LESSONS.map((lesson) => lesson.id));
    expect(LESSONS.map((lesson) => lesson.id)).toEqual(PLANNED.filter((item) => done.has(item.id)).map((item) => item.id));
    for (const lesson of LESSONS) expect(lesson.group, lesson.id).toBe(PLANNED.find((item) => item.id === lesson.id)!.group);
  });

  it('14 课全部实现', () => {
    expect(LESSONS.map((lesson) => lesson.id)).toEqual(PLANNED.map((item) => item.id));
  });

  it('课程 id 不重复', () => {
    expect(new Set(LESSONS.map((lesson) => lesson.id)).size).toBe(LESSONS.length);
  });

  it('抽象层级区间', () => {
    const layer = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson.layer]));
    expect(layer).toMatchObject({ embedtext: [3, 3] });
  });
});

describe('节点清单', () => {
  it('设备节点都有图形，数据节点都没有；每个节点都有说明', () => {
    const devices = ['app', 'docs', 'loader', 'chunker', 'embedder', 'index', 'meta', 'bm25', 'reranker', 'llm', 'evaluator'];
    for (const id of NODE_IDS) expect(hasArt(id), id).toBe(devices.includes(id));
    expect(NODE_IDS.length).toBe(new Set(NODE_IDS).size);
  });
});

const boxOf = (lesson: Lesson, id: NodeId, all: Partial<Record<NodeId, Box>>): Box => {
  const [x, y] = lesson.place[id]!;
  const data = all[id];
  if (data && !hasArt(id)) return [x + data[0], y + data[1], x + data[2], y + data[3]];
  const r = NODE_SPECS[id].radius;
  return [x - r, y - r, x + r, y + r];
};

/** 线段和矩形是否相交。 */
function lineHitsBox(x1: number, y1: number, x2: number, y2: number, [l, t, r, b]: Box): boolean {
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    if (x > l && x < r && y > t && y < b) return true;
  }
  return false;
}

/** 点到线段的距离。 */
function distance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

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
      expect(step.events.some((event) => event.type === 'packet' || event.type === 'note' || event.type === 'ds'), step.title).toBe(true);
    }
    expect(lesson.overview.facts.length).toBeGreaterThan(0);
    expect(lesson.outro.text).toBeTruthy();
  });

  it('每步 detail 是 2 到 4 句', () => {
    for (const step of lesson.steps) {
      const count = step.detail.split(/[。！？]/).filter((part) => part.trim()).length;
      expect(count, step.title).toBeGreaterThanOrEqual(2);
      expect(count, step.title).toBeLessThanOrEqual(4);
    }
  });

  it('层级区间有效，写了说明和距离列的口径', () => {
    const [lo, hi] = lesson.layer;
    expect(lo).toBeGreaterThanOrEqual(1);
    expect(hi).toBeLessThanOrEqual(7);
    expect(lo).toBeLessThanOrEqual(hi);
    expect(lesson.layerNote).toMatch(/。$/);
    expect(lesson.distNote).toMatch(/。$/);
  });

  it('每个节点都有位置和名称', () => {
    for (const id of lesson.nodes) {
      expect(lesson.place[id], `${id} 没有位置`).toBeTruthy();
      expect(lesson.labels[id], `${id} 没有名称`).toBeTruthy();
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

  it('累计距离计算次数单调不减，最后大于 0', () => {
    for (let index = 1; index < packets.length; index++) {
      expect(packets[index].row.dist, packets[index].label).toBeGreaterThanOrEqual(packets[index - 1].row.dist);
    }
    expect(packets[packets.length - 1].row.dist).toBeGreaterThan(0);
  });

  it('每个事件都有解码结构和可信度，字段不越界', () => {
    for (const packet of packets) {
      expect(packet.wire.fidelity, packet.label).toBeTruthy();
      expect(packet.wire.at, packet.label).toBeTruthy();
      expect(packet.row.info, packet.label).toBeTruthy();
      const frame = decode(packet.wire);
      expect(frame.layers.length, packet.label).toBeGreaterThan(0);
      expect(frame.fields.length, packet.label).toBeGreaterThan(0);
      if (packet.wire.fidelity !== '示意') expect(frame.bytes.length, `${packet.label} 没有字节`).toBeGreaterThan(0);
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

  it('示意结构不展示字节；带字节的事件，轨迹表里的大小和解码的字节数对得上', () => {
    for (const packet of packets) {
      const frame = decode(packet.wire);
      if (packet.wire.fidelity === '示意') expect(frame.bytes.length, packet.label).toBe(0);
      // 大小是这次传递的数据量，解码结构可以多带一层上下文，但不能比它少。
      if (packet.row.size !== null && packet.wire.fidelity !== '示意') expect(frame.bytes.length, packet.label).toBeGreaterThanOrEqual(packet.row.size);
    }
  });

  it('状态面板每个节点最多 4 行，只放在设备节点上', () => {
    for (let end = 0; end <= events.length; end++) {
      for (const [node, panel] of foldStates(events, end)) {
        expect(Object.keys(panel).length).toBeLessThanOrEqual(4);
        expect(hasArt(node), `${node} 没有设备，状态面板会和数据结构重叠`).toBe(true);
      }
    }
  });

  it('结构图随事件变化：至少一半事件改变了数据结构的画面', () => {
    let changed = 0;
    let last = JSON.stringify(foldDs(lesson.initial, events, 0));
    for (let end = 1; end <= events.length; end++) {
      const now = JSON.stringify(foldDs(lesson.initial, events, end));
      if (now !== last && (events[end - 1].type === 'packet' || events[end - 1].type === 'ds')) changed++;
      last = now;
    }
    expect(changed).toBeGreaterThan(packets.length / 2);
  });

  it('前进、后退、跳步：折叠结果只取决于位置', () => {
    const forward = events.map((_, index) => JSON.stringify(foldDs(lesson.initial, events, index)));
    for (let index = events.length - 1; index >= 0; index -= 3) {
      expect(JSON.stringify(foldDs(lesson.initial, events, index))).toBe(forward[index]);
    }
  });

  it('所有帧的图元 key 不重复，范围都是有限数', () => {
    const frames = [lesson.initial, ...packets.flatMap((packet) => (packet.ds ? [packet.ds] : []))];
    for (const frame of frames) {
      for (const prims of Object.values(frame)) {
        const items = itemsOf(prims);
        expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
        const box = boundsOf(prims);
        if (box) box.forEach((value) => expect(Number.isFinite(value)).toBe(true));
      }
    }
  });
});

describe.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s 的布局', (_id, lesson) => {
  const all = lessonBounds(lesson.initial, timeline(lesson) as Parameters<typeof lessonBounds>[1]);

  it('通道不穿过其他节点', () => {
    const problems: string[] = [];
    const lanes = new Set(packetsOf(lesson).map((packet) => `${packet.from}>${packet.to}`));
    for (const key of lanes) {
      const [from, to] = key.split('>') as [NodeId, NodeId];
      const [x1, y1] = lesson.place[from]!;
      const [x2, y2] = lesson.place[to]!;
      for (const other of lesson.nodes) {
        if (other === from || other === to) continue;
        const [x, y] = lesson.place[other]!;
        if (hasArt(other)) {
          if (distance(x, y, x1, y1, x2, y2) < NODE_SPECS[other].radius * 0.8) problems.push(`${key} 穿过 ${other} 的设备`);
          else if (distance(x, y + NODE_SPECS[other].labelY + 8, x1, y1, x2, y2) < 22) problems.push(`${key} 穿过 ${other} 的标签`);
        } else {
          const items = itemsOf(lesson.initial[other]);
          for (const item of items) {
            if (item.line) continue;
            const box: Box = [x + item.x + item.box[0] * 0.7, y + item.y + item.box[1] * 0.7, x + item.x + item.box[2] * 0.7, y + item.y + item.box[3] * 0.7];
            if (lineHitsBox(x1, y1, x2, y2, box)) {
              problems.push(`${key} 穿过 ${other}`);
              break;
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('节点之间互不重叠：数据结构不压设备，也不压其他数据结构的格子', () => {
    const problems: string[] = [];
    for (const a of lesson.nodes) {
      for (const b of lesson.nodes) {
        if (a >= b) continue;
        const boxA = boxOf(lesson, a, all);
        const boxB = boxOf(lesson, b, all);
        // 斜排的数据结构外接矩形很大，只在其中至少一个是设备时按矩形判断。
        if (hasArt(a) || hasArt(b)) {
          const overlap = boxA[0] < boxB[2] && boxB[0] < boxA[2] && boxA[1] < boxB[3] && boxB[1] < boxA[3];
          if (overlap && (hasArt(a) && hasArt(b))) problems.push(`${a} 和 ${b} 重叠`);
          if (overlap && !(hasArt(a) && hasArt(b))) {
            const data = hasArt(a) ? b : a;
            const device = hasArt(a) ? a : b;
            const [dx, dy] = lesson.place[data]!;
            const deviceBox = boxOf(lesson, device, all);
            const prims = timeline(lesson).flatMap((event) => (event.type === 'packet' && event.ds?.[data] ? [event.ds[data]!] : []));
            for (const frame of [lesson.initial[data] ?? [], ...prims]) {
              const hit = itemsOf(frame).some((item) => !item.line && dx + item.x + item.box[0] < deviceBox[2] && deviceBox[0] < dx + item.x + item.box[2] && dy + item.y + item.box[1] < deviceBox[3] && deviceBox[1] < dy + item.y + item.box[3]);
              if (hit) {
                problems.push(`${data} 的格子压到设备 ${device}`);
                break;
              }
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
