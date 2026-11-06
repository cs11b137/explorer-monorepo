import { describe, expect, it } from 'vitest';
import { decode } from '../src/decode/writer';
import { timeline } from '@explorer/engine/core/player';
import { LESSONS } from '../src/lessons';
import { foldStates, NODE_IDS, packetsOf, type NodeId } from '../src/lessons/types';
import { NODE_SPECS } from '../src/scene/devices';

describe('课程清单', () => {
  it('共 18 课，分组是 8 / 5 / 5', () => {
    expect(LESSONS.length).toBe(18);
    expect(LESSONS.filter((lesson) => lesson.group === 'process').length).toBe(8);
    expect(LESSONS.filter((lesson) => lesson.group === 'memory').length).toBe(5);
    expect(LESSONS.filter((lesson) => lesson.group === 'io').length).toBe(5);
  });

  it('课程顺序：同组相邻，组内按讲授顺序', () => {
    expect(LESSONS.map((lesson) => lesson.id)).toEqual([
      'boot', 'syscall', 'interrupt', 'fork', 'exec', 'contextswitch', 'scheduler', 'futex',
      'pagewalk', 'pagefault', 'cow', 'mmap', 'reclaim',
      'pathlookup', 'fileread', 'journal', 'pipe', 'signal',
    ]);
  });

  it('总结里的「下一课」指向真正的下一课', () => {
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

  it('寄存器事件的 SIZE 不会写成字节数以外的含义', () => {
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
});

describe('故障标记', () => {
  it('只用于真实故障和崩溃', () => {
    const lost = LESSONS.flatMap((lesson) => packetsOf(lesson).filter((packet) => packet.lost).map((packet) => `${lesson.id}:${packet.label}`));
    expect(lost).toEqual(['pagefault:访问中止', 'journal:断电']);
  });

  it('TLB 未命中不被当作故障', () => {
    const pagewalk = LESSONS.find((lesson) => lesson.id === 'pagewalk')!;
    expect(packetsOf(pagewalk).some((packet) => packet.lost)).toBe(false);
  });
});

describe('事实一致性', () => {
  const text = LESSONS.map((lesson) => JSON.stringify([lesson.overview, lesson.steps.map((step) => [step.title, step.desc, step.detail, step.facts]), lesson.outro])).join('\n');

  it('基础时间片按 Linux 6.12 写成 0.75 ms', () => {
    expect(text).toContain('0.75 ms');
    expect(text).not.toContain('0.70 ms');
  });

  it('系统调用号与 syscall_64.tbl 一致', () => {
    const numbers: Record<string, number> = {
      write: 1, read: 0, clone: 56, execve: 59, wait4: 61, futex: 202, openat: 257, pipe2: 293, exit_group: 231, sched_setattr: 314, fsync: 74,
      brk: 12, mmap: 9, newfstatat: 262, kill: 62, rt_sigaction: 13, rt_sigreturn: 15,
    };
    const all = LESSONS.flatMap(packetsOf).flatMap((packet) => packet.wire.layers);
    for (const layer of all) {
      const match = layer.name.match(/^系统调用 · (\w+)$/);
      if (!match) continue;
      const name = match[1];
      expect(numbers[name], name).toBeDefined();
      expect(layer.bytes[0], name).toBe(numbers[name] & 0xff);
    }
  });
});

describe('前后事件的数值一致', () => {
  const lesson = (id: string) => LESSONS.find((item) => item.id === id)!;
  const packet = (id: string, label: string) => {
    const found = packetsOf(lesson(id)).filter((item) => item.label === label);
    expect(found.length, `${id}:${label}`).toBe(1);
    return decode(found[0].wire);
  };
  const u64 = (bytes: Array<number | null>, at: number) => {
    let value = 0n;
    for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[at + index] as number);
    return value;
  };
  const value = (frame: ReturnType<typeof decode>, name: string) => frame.fields.find((field) => field.name === name)!.value;
  const aux = (stack: ReturnType<typeof decode>, name: string) => {
    const field = stack.fields.find((item) => item.name.startsWith(`AT_${name}（`))!;
    return u64(stack.bytes, field.from + 8);
  };

  it('exec：argv 和 AT_EXECFN 指向参数字符串区，rsp 按 16 字节对齐', () => {
    const strings = packet('exec', '拷贝字符串');
    const stack = packet('exec', '写初始栈');
    const regs = packet('exec', 'start_thread');
    const top = aux(stack, 'EXECFN') + 12n + 8n;
    expect(top % 4096n).toBe(0n);
    const base = top - BigInt(strings.bytes.length);
    const at = (pointer: bigint) => Number(pointer - base);
    const cstr = (offset: number) => String.fromCharCode(...(strings.bytes.slice(offset, strings.bytes.indexOf(0, offset)) as number[]));
    expect(u64(stack.bytes, 0)).toBe(2n);
    expect(cstr(at(u64(stack.bytes, 8)))).toBe('ls');
    expect(cstr(at(u64(stack.bytes, 16)))).toBe('-l');
    expect(cstr(at(u64(stack.bytes, 32)))).toBe('PATH=/usr/bin:/bin');
    expect(cstr(at(aux(stack, 'EXECFN')))).toBe('/usr/bin/ls');
    const rsp = u64(regs.bytes, 152);
    expect(rsp % 16n).toBe(0n);
    expect(value(regs, 'sp')).toBe(stack.layers[0].summary.match(/0x[0-9a-f]+/)![0]);
    expect(aux(stack, 'ENTRY') - aux(stack, 'PHDR')).toBe(0x6d30n - 64n);
    expect(u64(regs.bytes, 128)).toBe(aux(stack, 'BASE') + 0x1f540n);
  });

  it('exec：程序头表里的 PT_LOAD 与 ELF 头一致', () => {
    const header = packet('exec', 'ELF 头');
    expect(value(header, 'e_phnum')).toBe('13');
    const table = packet('exec', '程序头表');
    expect(table.layers.length).toBe(4);
    expect(table.bytes.length).toBe(4 * 56);
  });

  it('mmap：maps 里的起点就是 mmap 的返回值，也是缺页的地址', () => {
    const maps = packetsOf(lesson('mmap')).filter((item) => item.label === '插入 VMA').map((item) => decode(item.wire));
    const text = String.fromCharCode(...(maps[1].bytes as number[]));
    const start = BigInt(`0x${text.slice(0, text.indexOf('-'))}`);
    const returns = packetsOf(lesson('mmap')).filter((item) => item.label === 'mmap 返回').map((item) => decode(item.wire));
    expect(u64(returns[1].bytes, 0)).toBe(start);
    expect(u64(packet('mmap', '#PF').bytes, 0)).toBe(start);
  });

  it('pathlookup：stat 结果与目录项、inode 一致', () => {
    const dir = packet('pathlookup', '目录块');
    const inode = packet('pathlookup', 'inode');
    const stat = packet('pathlookup', 'stat 返回');
    const notes = dir.layers.at(-1)!;
    const ino = dir.bytes.slice(notes.from, notes.from + 4) as number[];
    expect(BigInt(ino[0] | (ino[1] << 8) | (ino[2] << 16) | (ino[3] << 24))).toBe(u64(stat.bytes, 8));
    expect(stat.bytes[24]! | (stat.bytes[25]! << 8)).toBe(inode.bytes[0]! | (inode.bytes[1]! << 8));
    expect(u64(stat.bytes, 48)).toBe(BigInt(inode.bytes[4]!));
    const offsets = dir.layers.map((layer) => layer.from);
    dir.layers.slice(0, -1).forEach((layer, index) => expect(layer.to).toBe(offsets[index + 1]));
  });

  it('signal：信号帧里的现场、pt_regs 和最后恢复的 RIP 一致', () => {
    const regs = packet('signal', '改 pt_regs');
    const frame = packet('signal', '写信号帧');
    const enter = packet('signal', '跳到处理函数');
    const back = packet('signal', '回到 read');
    const ret = packet('signal', 'rt_sigreturn');
    const ip = u64(regs.bytes, 128);
    expect(u64(regs.bytes, 88)).toBe(ip + 2n);
    expect(u64(frame.bytes, 48 + 128)).toBe(ip);
    expect(u64(frame.bytes, 48 + 104)).toBe(0n);
    expect(u64(back.bytes, 0)).toBe(ip);
    const rsp = u64(enter.bytes, 8);
    expect(rsp % 16n).toBe(8n);
    expect(u64(enter.bytes, 24) - rsp).toBe(312n);
    expect(u64(enter.bytes, 32) - rsp).toBe(8n);
    expect(u64(ret.bytes, 8)).toBe(rsp + 8n);
    expect(u64(frame.bytes, 48 + 184) - rsp).toBeGreaterThanOrEqual(440n);
    expect(u64(frame.bytes, 48 + 120)).toBe(u64(back.bytes, 8));
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
