import { describe, expect, it } from 'vitest';
import { decode } from '../src/decode/writer';
import { timeline } from '../src/core/player';
import { LESSONS } from '../src/lessons';
import { foldProbes, foldStates, NODE_IDS, packetsOf, type Lesson, type NodeId } from '../src/lessons/types';
import { NODE_SPECS } from '../src/scene/devices';
import { panelBoxes, type PanelBox } from '../src/scene/panels';
import { panelWidgets, widgetSize, type BitsWidget, type GridWidget, type KvWidget } from '../src/scene/widgets';

describe('课程清单', () => {
  it('共 16 课，分组是 4 / 7 / 5，顺序和任务书一致', () => {
    expect(LESSONS.map((lesson) => lesson.name)).toEqual(['INTEGER', 'MULTIPLY', 'FLOAT', 'ALU', 'ENCODING', 'DATAPATH', 'CONTROL', 'PIPELINE', 'HAZARD', 'BRANCH', 'EXCEPTION', 'CACHE', 'WRITE POLICY', 'COHERENCE', 'DRAM', 'DMA']);
    expect(LESSONS.filter((lesson) => lesson.group === 'data').map((lesson) => lesson.id)).toEqual(['integer', 'multiply', 'float', 'alu']);
    expect(LESSONS.filter((lesson) => lesson.group === 'cpu').map((lesson) => lesson.id)).toEqual(['encoding', 'datapath', 'control', 'pipeline', 'hazard', 'branch', 'exception']);
    expect(LESSONS.filter((lesson) => lesson.group === 'memio').length).toBe(5);
  });

  it('每课的「下一课」指向清单里真正的下一课', () => {
    LESSONS.forEach((lesson, index) => {
      const next = lesson.outro.facts.find(([label]) => label === '下一课');
      if (index === LESSONS.length - 1) expect(next, lesson.id).toBeUndefined();
      else if (next) expect(next[1], lesson.id).toBe(LESSONS[index + 1].name);
    });
  });

  it('课程 id 不重复', () => {
    expect(new Set(LESSONS.map((lesson) => lesson.id)).size).toBe(LESSONS.length);
  });
});

/** 能显示在结构图上的矩形。 */
const deviceBox = (lesson: Lesson, id: NodeId): PanelBox => {
  const [x, y] = lesson.place[id]!;
  const spec = NODE_SPECS[id];
  return { x: x - spec.halfWidth, y: y + spec.top, width: spec.halfWidth * 2, height: spec.labelY - 14 - spec.top };
};

const labelBox = (lesson: Lesson, id: NodeId): PanelBox => {
  const [x, y] = lesson.place[id]!;
  const spec = NODE_SPECS[id];
  const [name, sub] = lesson.labels[id]!;
  const textWidth = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) < 0x2e80 ? 8 : 15), 0);
  const width = Math.max(textWidth(name), textWidth(sub));
  return { x: x - width / 2, y: y + spec.labelY - 14, width, height: sub ? 36 : 18 };
};

const overlap = (a: PanelBox, b: PanelBox) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function segmentHitsBox(x1: number, y1: number, x2: number, y2: number, box: PanelBox, pad = 0): boolean {
  const left = box.x - pad;
  const right = box.x + box.width + pad;
  const top = box.y - pad;
  const bottom = box.y + box.height + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - left], [dx, right - x1], [-dy, y1 - top], [dy, bottom - y1]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

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

  it('每步的说明是 2 到 4 句', () => {
    for (const step of lesson.steps) {
      const count = step.detail.split(/[。！？]/).filter((part) => part.trim()).length;
      expect(count, step.title).toBeGreaterThanOrEqual(2);
      expect(count, `${lesson.id} ${step.title}：${count} 句`).toBeLessThanOrEqual(4);
    }
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
      if (event.type === 'note') expect(visible.has(event.at), `提示 ${event.text}: ${event.at} 尚未显示`).toBe(true);
    }
  });

  it('所有节点最终都显示过，并在 nodes 里', () => {
    const shown = new Set<NodeId>(lesson.start);
    for (const step of lesson.steps) {
      for (const event of step.events) if (event.type === 'show') event.nodes.forEach((id) => shown.add(id));
    }
    expect([...shown].sort()).toEqual([...lesson.nodes].sort());
    for (const id of lesson.nodes) expect(NODE_IDS).toContain(id);
  });

  it('周期单调不减', () => {
    // 同一课可以有两次独立运行（比如静态预测和 2 位预测），每次运行内部单调。
    const last = new Map<string | undefined, number>();
    for (const packet of packets) {
      const previous = last.get(packet.row.run) ?? 0;
      expect(packet.row.cycle, `${packet.label}（${packet.row.info}）`).toBeGreaterThanOrEqual(previous);
      last.set(packet.row.run, packet.row.cycle);
    }
  });

  it('时序图的车道最多 7 条，能放进面板', () => {
    expect(new Set(packets.flatMap((packet) => [packet.from, packet.to])).size).toBeLessThanOrEqual(7);
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
        if (field.bits) expect(frame.words[field.bits.word], `${packet.label}.${field.name}`).toBeTruthy();
      }
    }
  });

  it('同一层内的顶层字段按顺序排列且互不重叠', () => {
    for (const packet of packets) {
      for (const layer of packet.wire.layers) {
        let end = 0;
        for (const field of layer.fields) {
          if (field.depth || field.to === field.from || field.bits) continue;
          expect(field.from, `${packet.label}.${field.name}`).toBeGreaterThanOrEqual(end);
          end = field.to;
        }
      }
    }
  });

  it('示意结构不展示字节', () => {
    for (const packet of packets) {
      const frame = decode(packet.wire);
      if (packet.wire.fidelity === '示意') expect(frame.bytes.length, packet.label).toBe(0);
    }
  });

  it('寄存器事件的大小不会写成字节数以外的含义', () => {
    for (const packet of packets) {
      if (packet.row.size === 'reg') expect(['regs'], packet.label).toContain(packet.wire.view);
    }
  });

  it('状态面板每个节点最多 4 行', () => {
    const events = timeline(lesson);
    for (let end = 0; end <= events.length; end++) {
      for (const panel of foldStates(events, end).values()) expect(Object.keys(panel).length).toBeLessThanOrEqual(4);
    }
  });

  it('每块面板都有初始内容和位置，播放过程中不会消失', () => {
    const events = timeline(lesson);
    for (const id of Object.keys(lesson.panels)) expect(lesson.initial[id], `${id} 没有初始内容`).toBeTruthy();
    for (const id of Object.keys(lesson.initial)) expect(lesson.panels[id], `${id} 没有位置`).toBeTruthy();
    for (const event of events) {
      if (event.type !== 'probe') continue;
      for (const id of Object.keys(event.set)) expect(lesson.panels[id], `${id} 没有位置`).toBeTruthy();
    }
    const end = foldProbes(lesson.initial, events, events.length);
    expect([...end.keys()].sort()).toEqual(Object.keys(lesson.panels).sort());
  });

  it('面板内容的宽度和列数一致', () => {
    const events = timeline(lesson);
    const all = [...Object.values(lesson.initial), ...events.flatMap((event) => (event.type === 'probe' ? Object.values(event.set) : []))];
    for (const content of all) {
      if (!content) continue;
      for (const widget of panelWidgets(content)) {
        expect(widgetSize(widget).width).toBeGreaterThan(0);
        if (widget.kind === 'grid') {
          for (const row of widget.rows) {
            const span = row.reduce((sum, cell) => sum + (typeof cell === 'string' ? 1 : cell.span ?? 1), 0);
            expect(span, widget.title).toBe(widget.cols.length);
          }
        }
        if (widget.kind === 'bits') {
          const bits = new Set<number>();
          for (const seg of widget.segs) for (let bit = seg.lo; bit <= seg.hi; bit++) bits.add(bit);
          expect(bits.size, widget.title).toBe(widget.width);
        }
      }
    }
  });

  it('播放过程中至少有一块面板的值发生了变化', () => {
    const events = timeline(lesson);
    const before = JSON.stringify([...foldProbes(lesson.initial, events, 0)]);
    const after = JSON.stringify([...foldProbes(lesson.initial, events, events.length)]);
    expect(after).not.toBe(before);
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
  const lanes = new Set(packetsOf(lesson).map((packet) => `${packet.from}>${packet.to}`));
  const boxes = panelBoxes(lesson);

  it('通道不穿过其他节点的设备和标签', () => {
    const problems: string[] = [];
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

  it('通道不穿过数值面板', () => {
    const problems: string[] = [];
    for (const key of lanes) {
      const [from, to] = key.split('>') as [NodeId, NodeId];
      const [x1, y1] = lesson.place[from]!;
      const [x2, y2] = lesson.place[to]!;
      const length = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / length;
      const uy = (y2 - y1) / length;
      const sx = x1 + ux * NODE_SPECS[from].radius;
      const sy = y1 + uy * NODE_SPECS[from].radius;
      const ex = x2 - ux * NODE_SPECS[to].radius;
      const ey = y2 - uy * NODE_SPECS[to].radius;
      for (const [id, box] of boxes) if (segmentHitsBox(sx, sy, ex, ey, box, 4)) problems.push(`${key} 穿过面板 ${id}`);
    }
    expect(problems).toEqual([]);
  });

  it('宽屏时整个场景放得下，文字不会缩得太小', () => {
    let right = -Infinity;
    let left = Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const grow = (box: PanelBox) => {
      left = Math.min(left, box.x);
      right = Math.max(right, box.x + box.width);
      top = Math.min(top, box.y);
      bottom = Math.max(bottom, box.y + box.height);
    };
    for (const box of boxes.values()) grow(box);
    for (const id of lesson.nodes) {
      grow(deviceBox(lesson, id));
      grow(labelBox(lesson, id));
    }
    // 1440 宽时结构图面板约 831 × 691（缩放前），顶部留 54 给视图切换。
    const scale = Math.min(831 / (right - left + 32), 637 / (bottom - top + 32));
    expect(scale, `${lesson.id} 宽 ${right - left} 高 ${bottom - top}`).toBeGreaterThanOrEqual(0.85);
  });

  it('面板之间、面板和设备、标签都不重叠', () => {
    const problems: string[] = [];
    const entries = [...boxes];
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        if (overlap(entries[a][1], entries[b][1])) problems.push(`面板 ${entries[a][0]} 和 ${entries[b][0]} 重叠`);
      }
      for (const id of lesson.nodes) {
        if (overlap(entries[a][1], deviceBox(lesson, id))) problems.push(`面板 ${entries[a][0]} 盖住设备 ${id}`);
        if (overlap(entries[a][1], labelBox(lesson, id))) problems.push(`面板 ${entries[a][0]} 盖住 ${id} 的标签`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('设备和标签互不重叠', () => {
    const problems: string[] = [];
    for (const a of lesson.nodes) {
      for (const b of lesson.nodes) {
        if (a >= b) continue;
        if (overlap(deviceBox(lesson, a), deviceBox(lesson, b))) problems.push(`设备 ${a} 和 ${b} 重叠`);
        if (overlap(labelBox(lesson, a), deviceBox(lesson, b))) problems.push(`${a} 的标签和设备 ${b} 重叠`);
        if (overlap(labelBox(lesson, b), deviceBox(lesson, a))) problems.push(`${b} 的标签和设备 ${a} 重叠`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('面板和轨迹同属一拍', () => {
  /** 某个事件发生之前，最近一次面板里这一级的指令。 */
  function stageText(lesson: Lesson, index: number, panel: string): string {
    const events = timeline(lesson);
    const content = foldProbes(lesson.initial, events, index).get(panel)!;
    const value = (panelWidgets(content)[0] as KvWidget).rows[0][1];
    return typeof value === 'string' ? value : value.t;
  }
  const byId = (id: string) => LESSONS.find((lesson) => lesson.id === id)!;

  it('HAZARD：每条 FWD 之前，MEM 或 WB 面板里的指令就是产生这个值的指令', () => {
    const lesson = byId('hazard');
    let checked = 0;
    timeline(lesson).forEach((event, index) => {
      if (event.type !== 'packet' || event.row.type !== 'FWD') return;
      const match = /^(MEM|WB) 级把 x\d+ = -?\d+ 前递给 [AB] 口（来自 (.+)）$/.exec(event.row.info);
      if (!match) return;
      expect(stageText(lesson, index, match[1] === 'MEM' ? 'smem' : 'swb'), event.row.info).toBe(match[2]);
      checked++;
    });
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('HAZARD：每条 FWD 之前，前递单元已经显示这一拍的来源', () => {
    const lesson = byId('hazard');
    timeline(lesson).forEach((event, index) => {
      if (event.type !== 'packet' || event.row.type !== 'FWD') return;
      const match = /^(MEM|WB) 级把 x\d+ = (-?\d+) 前递给 ([AB]) 口/.exec(event.row.info);
      if (!match) return;
      const panel = panelWidgets(foldProbes(lesson.initial, timeline(lesson), index).get('hazard')!)[0] as KvWidget;
      const row = panel.rows.find(([key]) => key === `${match[3]} 口`)!;
      expect(typeof row[1] === 'string' ? row[1] : row[1].t, event.row.info).toBe(`来自 ${match[1]}：${match[2]}`);
    });
  });

  it('HAZARD：每条 EXEC 之前，EX 面板就是这条指令，结果还没显示', () => {
    const lesson = byId('hazard');
    let checked = 0;
    timeline(lesson).forEach((event, index) => {
      if (event.type !== 'packet' || event.row.type !== 'EXEC') return;
      const text = event.row.info.split('：')[0];
      expect(stageText(lesson, index, 'sex'), event.row.info).toBe(text);
      const panel = panelWidgets(foldProbes(lesson.initial, timeline(lesson), index).get('sex')!)[0] as KvWidget;
      expect(JSON.stringify(panel.rows[1][1]), event.row.info).toContain('计算中');
      checked++;
    });
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('PIPELINE：指令进入某一级时，那一级的面板就是这条指令', () => {
    const lesson = byId('pipeline');
    const panelOf: Record<string, string> = { ID: 'sid', EX: 'sex', MEM: 'smem', WB: 'swb' };
    let checked = 0;
    timeline(lesson).forEach((event, index) => {
      if (event.type !== 'stream') return;
      for (const packet of event.packets) {
        const match = /^(.+) 进入 (ID|EX|MEM|WB) 级/.exec(packet.row.info)!;
        expect(stageText(lesson, index, panelOf[match[2]]), packet.row.info).toBe(match[1]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(16);
  });

  it('BRANCH：冲刷和改 PC 时，面板里就是这一拍的指令', () => {
    const lesson = byId('branch');
    let flushes = 0;
    timeline(lesson).forEach((event, index) => {
      if (event.type !== 'packet') return;
      if (event.row.type === 'FLUSH') {
        const text = /错误路径上的 (.+) 被冲掉/.exec(event.row.info)![1];
        expect(stageText(lesson, index, event.from), event.row.info).toBe(text);
        flushes++;
      }
      if (event.label === '改 PC') expect(stageText(lesson, index, 'sex'), event.row.info).toBe(event.row.info.split(' 实际')[0]);
    });
    expect(flushes).toBe(6);
  });

  it('BRANCH：第 2 步查表时，IF 面板是预测运行里的 bne', () => {
    const lesson = byId('branch');
    const events = timeline(lesson);
    const index = events.findIndex((event) => event.type === 'packet' && event.label === '预测');
    expect(stageText(lesson, index, 'sif')).toBe('bne x1, x2, -4');
  });

  it('COHERENCE：嗅探到达后，那个核的面板立刻是新状态', () => {
    const lesson = byId('coherence');
    const events = timeline(lesson);
    events.forEach((event, index) => {
      if (event.type !== 'packet' || event.label !== '嗅探') return;
      const to = event.payload[0].split(' → ')[1];
      const panel = panelWidgets(foldProbes(lesson.initial, events, index + 2).get(event.to)!)[0] as KvWidget;
      expect(JSON.stringify(panel.rows[0][1]), event.row.info).toContain(`"t":"${to}"`);
    });
  });

  const STAGE_PANEL: Record<string, string> = { IF: 'sif', ID: 'sid', EX: 'sex', MEM: 'smem', WB: 'swb' };
  /** 某个事件之前，最近一次面板里某一行的文字。 */
  function rowText(lesson: Lesson, index: number, panel: string, key: string): string {
    const widget = panelWidgets(foldProbes(lesson.initial, timeline(lesson), index).get(panel)!)[0] as KvWidget;
    const value = widget.rows.find(([name]) => name === key)![1];
    return typeof value === 'string' ? value : value.t;
  }

  it('EXCEPTION：冲刷、标记、陷入和 CSR 读写时，那一级的面板就是这条指令', () => {
    const lesson = byId('exception');
    const counts = { flush: 0, mark: 0, trap: 0, csr: 0, move: 0 };
    timeline(lesson).forEach((event, index) => {
      const list = event.type === 'packet' ? [event] : event.type === 'stream' ? event.packets : [];
      for (const packet of list) {
        const { info } = packet.row;
        if (packet.row.type === 'FLUSH') {
          const [, text, stage] = /^(.+) 在 (IF|ID|EX|MEM) 级被冲掉$/.exec(info)!;
          expect(packet.from, info).toBe(STAGE_PANEL[stage]);
          expect(stageText(lesson, index, packet.from), info).toBe(text);
          counts.flush++;
        } else if (packet.label === '标记') {
          const text = info.split(/ 在 ID 级| 的地址/)[0];
          expect(stageText(lesson, index, packet.from), info).toBe(text);
          counts.mark++;
        } else if (packet.label === '陷入') {
          expect(stageText(lesson, index, 'swb'), info).toBe(info.split(' 在 WB')[0]);
          expect(rowText(lesson, index, 'swb', '状态'), info).toMatch(/^带异常 mcause=\d+$/);
          counts.trap++;
        } else if (packet.from === 'csr' && packet.to === 'smem' || packet.to === 'csr' && packet.from === 'smem') {
          expect(stageText(lesson, index, 'smem'), info).toBe(info.split(' 在 MEM')[0]);
          counts.csr++;
        } else if (event.type === 'stream') {
          const [, text, stage] = /^(.+?) (?:带着异常标记)?进入 (ID|EX|MEM|WB) 级/.exec(info)!;
          expect(stageText(lesson, index, STAGE_PANEL[stage]), info).toBe(text);
          counts.move++;
        }
      }
    });
    expect(counts).toEqual({ flush: 7, mark: 3, trap: 3, csr: 4, move: 15 });
  });

  it('EXCEPTION：陷入后 CSR 面板显示新的 mcause，mret 后 MIE 恢复', () => {
    const lesson = byId('exception');
    const events = timeline(lesson);
    const trap = events.findIndex((event) => event.type === 'packet' && event.label === '陷入');
    const mret = events.findIndex((event) => event.type === 'packet' && event.label === 'mret');
    expect(rowText(lesson, trap, 'csr', 'mcause')).toBe('0');
    expect(rowText(lesson, mret, 'csr', 'mcause')).toBe('2 非法指令');
    expect(rowText(lesson, mret, 'csr', 'mstatus')).toBe('MIE=0 MPIE=1');
    expect(rowText(lesson, events.length, 'csr', 'mcause')).toBe('2 非法指令');
    const lastA = events.findIndex((event) => event.step === lesson.steps.length - 1);
    expect(rowText(lesson, lastA, 'csr', 'mstatus')).toBe('MIE=1 MPIE=1');
    expect(rowText(lesson, lastA, 'regs', '[0x100]')).toBe('0x00000001');
  });

  it('MULTIPLY：每次加减之前，加减器面板已经是这一拍的结果，积寄存器最后是 -42', () => {
    const lesson = byId('multiply');
    const events = timeline(lesson);
    let checked = 0;
    events.forEach((event, index) => {
      if (event.type !== 'packet' || event.row.type !== 'CALC') return;
      const result = /= (-?\d+)，写回 A$/.exec(event.row.info)![1];
      expect(rowText(lesson, index, 'adder', '结果'), event.row.info).toMatch(new RegExp(`= ${result}$`));
      checked++;
    });
    expect(checked).toBe(3);
    const regy = panelWidgets(foldProbes(lesson.initial, events, events.length).get('regy')!)[0] as BitsWidget;
    expect(Math.floor(regy.value / 2)).toBe(0xffd6);
    const table = panelWidgets(foldProbes(lesson.initial, events, events.length).get('table')!)[0] as GridWidget;
    expect(table.rows.filter((row) => row[3] !== undefined && (typeof row[3] === 'string' || row[3].t !== '·')).length).toBe(9);
  });
});

describe('窄面板的读数区', () => {
  it.each(LESSONS.map((lesson) => [lesson.id, lesson] as const))('%s：主面板和排版只引用存在的面板', (_id, lesson) => {
    expect(lesson.main.length).toBeGreaterThan(0);
    for (const id of lesson.main) expect(lesson.panels[id], id).toBeTruthy();
    for (const id of lesson.strip.flat()) expect(lesson.panels[id], id).toBeTruthy();
    expect(new Set(lesson.strip.flat()).size).toBe(lesson.strip.flat().length);
    for (const id of lesson.main) expect(lesson.strip.flat()).toContain(id);
  });
});

describe('冲刷标记', () => {
  it('只用于被冲掉的错误路径指令', () => {
    const lost = LESSONS.flatMap((lesson) => packetsOf(lesson).filter((packet) => packet.lost).map((packet) => `${lesson.id}:${packet.label}:${packet.row.type}`));
    expect(lost.length).toBeGreaterThan(0);
    for (const item of lost) expect(item).toMatch(/^(branch|exception):冲掉:FLUSH$/);
  });

  it('缓存未命中不被当作被冲掉', () => {
    const cache = LESSONS.find((lesson) => lesson.id === 'cache')!;
    expect(packetsOf(cache).some((packet) => packet.lost)).toBe(false);
  });
});

describe('事实一致性', () => {
  const text = LESSONS.map((lesson) => JSON.stringify([lesson.overview, lesson.steps.map((step) => [step.title, step.desc, step.detail, step.facts]), lesson.outro])).join('\n');
  // 包括面板、事件卡片和检查器里的全部文字。
  const everything = JSON.stringify(LESSONS);

  it('关键事实', () => {
    expect(text).toContain('0xbdcccccd');
    expect(text).toContain('0x3f800000');
    expect(text).not.toMatch(/不是[^。]{0,30}而是/);
  });

  it('真实处理器的数值都标了 E.G.', () => {
    const facts = LESSONS.flatMap((lesson) => [...lesson.overview.facts, ...lesson.steps.flatMap((step) => step.facts)]);
    for (const [label, value] of facts) {
      if (/真实 (L1|CPU)/.test(label) && /\d/.test(value)) expect(value, label).toContain('E.G.');
    }
  });

  it('文本里的字符都能显示：Iosevka 子集之外的符号只能是中文', () => {
    const allowed = new Set([...' ·×Δ–—‘’“”…‹›₂←↑→↓≠≤≥✕']);
    const strange = new Set<string>();
    for (const char of everything) {
      const code = char.charCodeAt(0);
      if (code < 127) continue;
      if (allowed.has(char)) continue;
      if (code >= 0x3000 && code <= 0x9fff) continue;
      if (code >= 0xff00 && code <= 0xffef) continue;
      strange.add(char);
    }
    expect([...strange]).toEqual([]);
  });
});
