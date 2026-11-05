import { cacheAddressLayer, concept, registers, wire } from '../decode/structures';
import { splitAddress } from '../sim/cache';
import { Memory } from '../sim/exec';
import { DEFAULT_LATENCY, MesiSystem, type MesiEvent, type MesiState } from '../sim/mesi';
import { note, pk, probe, show } from './dsl';
import type { CellLike, PanelContent, Tone } from '../scene/widgets';
import type { Lesson, LessonEvent, Step } from './types';
import { cell, dim, grid, hx, kv, on } from './views';

const ADDRESS = 0x3000;
const INITIAL = 0x00000064;
const memory = new Memory();
memory.storeWord(ADDRESS, INITIAL);
const system = new MesiSystem(2, ADDRESS, memory);
const parts = splitAddress(ADDRESS, { sets: 64, blockBytes: 64 });

const STATE_TONE: Record<MesiState, Tone> = { M: 'amber', E: 'green', S: 'blue', I: 'slate' };
const stateCell = (state: MesiState): CellLike => on(state, STATE_TONE[state]);
const STATE_TEXT: Record<MesiState, string> = { M: '已修改：只有我有，比内存新', E: '独占：只有我有，和内存相同', S: '共享：可能多个核都有，和内存相同', I: '无效：这份不能用' };

const linePanel = (core: number, state: MesiState, value: number): PanelContent => kv(`核 ${core} 的缓存行`, [['状态', stateCell(state)], ['值', state === 'I' ? dim('作废') : String(value)]]);
const memPanel = (value: number, stale: boolean): PanelContent => kv('内存', [['地址', hx(ADDRESS)], ['值', stale ? cell(String(value), 'red') : String(value)], ['是否最新', stale ? on('已过期', 'red') : cell('最新', 'green')]]);

const rows: CellLike[][] = [];
function historyPanel(event: MesiEvent | null): PanelContent {
  if (event) {
    rows.push([
      String(event.seq),
      `核${event.core} ${event.kind === 'R' ? '读' : `写 ${event.value & 0xff}`}`,
      event.bus ?? dim('无'),
      stateCell(event.lines[0].state),
      stateCell(event.lines[1].state),
      String(event.memoryValue),
    ]);
  }
  return grid('状态变化', [['#', 20], ['操作', 76], ['总线', 56], ['核0', 30], ['核1', 30], ['内存', 40]], rows.map((row) => [...row]));
}


function framePanels(event: MesiEvent, withHistory = true): Record<string, PanelContent> {
  const memStale = event.lines.some((line) => line.state === 'M' && line.value !== event.memoryValue);
  return {
    cache: linePanel(0, event.lines[0].state, event.lines[0].value),
    cache1: linePanel(1, event.lines[1].state, event.lines[1].value),
    dram: memPanel(event.memoryValue, memStale),
    ...(withHistory ? { history: historyPanel(event) } : {}),
  };
}

const CACHE = { 0: 'cache', 1: 'cache1' } as const;
const CORE = { 0: 'core0', 1: 'core1' } as const;

const transitionLayer = (event: MesiEvent) => concept('状态转移', [
  [`核 ${event.self.core}`, `${event.self.from} → ${event.self.to}`, STATE_TEXT[event.self.to]],
  ...event.snoops.map((snoop): [string, string, string] => [`核 ${snoop.core}（嗅探）`, `${snoop.from} → ${snoop.to}`, STATE_TEXT[snoop.to]]),
  ['数据来源', event.dataFrom === 'memory' ? '内存' : event.dataFrom === 'flush' ? '另一个核冲回的数据' : '本地缓存'],
], event.kind === 'W' ? 'amber' : 'blue');

const addressLayer = () => cacheAddressLayer(ADDRESS, parts);

/** 一次读或写在总线上发生的全部事情。 */
function play(event: MesiEvent): LessonEvent[] {
  const core = event.core as 0 | 1;
  const other = (core === 0 ? 1 : 0) as 0 | 1;
  const cycle = event.startCycle;
  const before = event.seq > 1 ? system.log[event.seq - 2].lines : [{ state: 'I' as MesiState, value: 0 }, { state: 'I' as MesiState, value: 0 }];
  const out: LessonEvent[] = [
    pk(CORE[core], CACHE[core], 'blue', event.kind === 'R' ? '读' : '写', event.kind === 'R' ? [hx(ADDRESS)] : [`${hx(ADDRESS)} = ${event.value}`], [cycle, 'MEM', `核 ${core} ${event.kind === 'R' ? '读' : `写 ${event.value}`}，本地状态 ${event.self.from}`, 4],
      wire(`核 ${core} 访问缓存`, 'mem', 'model', addressLayer(), transitionLayer(event))),
  ];
  if (event.silent) {
    out.push(note(CACHE[core], `${event.self.from} → ${event.self.to}，不上总线`, 'green'));
    return [...out, probe(framePanels(event))];
  }
  out.push(pk(CACHE[core], 'bus', 'violet', event.bus!, [hx(ADDRESS)], [cycle, 'BUS', `总线上发 ${event.bus}${event.bus === 'BusRd' ? '：我要读' : event.bus === 'BusRdX' ? '：我要读并独占' : '：我要写，别人作废'}`, event.bus === 'BusUpgr' ? null : 64],
    wire('总线广播，所有缓存都在嗅探', 'mem', 'model', addressLayer(), concept('总线事务', [
      ['命令', event.bus!, event.bus === 'BusUpgr' ? '只作废别人的副本，不需要数据。' : '需要这一块的数据。'],
    ], 'violet')), { locked: true }));
  const snoop = event.snoops.find((item) => item.core === other);
  if (snoop || event.bus) {
    const from = snoop?.from ?? event.lines[other].state;
    const to = snoop?.to ?? from;
    out.push(pk('bus', CACHE[other], 'amber', '嗅探', [`${from} → ${to}`], [cycle + 1, 'BUS', `核 ${other} 嗅探到 ${event.bus}：${from === to ? `状态仍是 ${to}` : `${from} → ${to}`}`, null],
      wire(`核 ${other} 的嗅探逻辑`, 'regs', 'model', transitionLayer(event)), { quick: true }));
    out.push(probe({ [CACHE[other]]: linePanel(other, to, before[other].value) }));
  }
  if (event.flushedBy !== null) {
    const owner = event.flushedBy as 0 | 1;
    out.push(pk(CACHE[owner], 'bus', 'amber', '冲回', [`${event.memoryValue}`], [cycle + 1, 'BUS', `核 ${owner} 是 M，把最新值 ${event.memoryValue} 放上总线`, 64],
      wire('脏数据冲回', 'mem', 'model', addressLayer(), registers('冲回的值', [[hx(ADDRESS), event.memoryValue, '内存和请求者同时拿到。']], 'amber'))));
  }
  if (event.bus !== 'BusUpgr') {
    out.push(pk('bus', 'dram', 'slate', event.flushedBy !== null ? '更新内存' : '读内存', [String(event.memoryValue)], [event.endCycle - 1, 'DATA', event.flushedBy !== null ? `内存更新为 ${event.memoryValue}` : `内存提供数据 ${event.memoryValue}`, 64],
      wire('内存', 'regs', 'model', registers('内存', [[hx(ADDRESS), event.memoryValue]], 'slate')), { quick: true }));
    out.push(probe({ dram: memPanel(event.memoryValue, false) }));
    out.push(pk('bus', CACHE[core], 'green', '数据', [String(event.flushedBy !== null ? event.memoryValue : event.value)], [event.endCycle, 'DATA', `核 ${core} 拿到数据，${event.self.from} → ${event.self.to}`, 64],
      wire('填入请求者的缓存', 'regs', 'model', transitionLayer(event))));
  }
  out.push(probe(framePanels(event)));
  return out;
}

const e1 = system.read(0);
const e2 = system.read(1);
const e3 = system.write(0, 101);
const e4 = system.write(0, 102);
const e5 = system.read(1);
const e6 = system.write(1, 103);
const e7 = system.read(0);

// 按顺序展开，rows 也按同样的顺序累积。
const steps: Step[] = [
  {
    title: '独占',
    desc: '只有一个核读：I → E',
    detail: `所有缓存都盯着总线，这种做法叫嗅探。核 0 读未命中，发 BusRd。没有别的核应答「我也有」，于是这一行进入 E（独占）：只有我有，且和内存相同。E 的价值在于之后想写时不用再通知任何人。`,
    facts: [['操作', '核 0 读'], ['总线', e1.bus!], ['核 0', `${e1.self.from} → ${e1.self.to}`], ['内存', String(e1.memoryValue)]],
    events: [show('bus', 'dram'), ...play(e1)],
  },
  {
    title: '共享',
    desc: '第二个核也读：E → S',
    detail: '核 1 也读这一块，发 BusRd。核 0 嗅探到了，告诉总线「我也有」，自己从 E 降到 S；核 1 的这一行也进入 S。S 表示可能有多份副本，而且都和内存相同，所以任何一个核都可以直接读，但不能直接写。',
    facts: [['操作', '核 1 读'], ['核 1', `${e2.self.from} → ${e2.self.to}`], ['核 0', `${e2.snoops[0].from} → ${e2.snoops[0].to}`], ['副本数', '2']],
    events: play(e2),
  },
  {
    title: '写失效',
    desc: '写之前先让别人作废',
    detail: `核 0 要写，但手里是 S，别的核可能也有。它发 BusUpgr，核 1 嗅探到后把自己的副本标成 I，然后核 0 进入 M 并写入 ${e3.value}。这时内存还是旧的 ${e3.memoryValue}，整个系统只有核 0 这一份是最新的。这叫写失效，MESI 就靠它保证同一时刻只有一个写者。`,
    facts: [['总线', e3.bus!], ['核 0', `${e3.self.from} → ${e3.self.to}`], ['核 1', `${e3.snoops[0].from} → ${e3.snoops[0].to}`], ['内存', `${e3.memoryValue}（已过期）`]],
    events: play(e3),
  },
  {
    title: 'M 状态写',
    desc: '已经独占，不用上总线',
    detail: `核 0 再写 ${e4.value}。它已经是 M，确信没有别的副本，直接改缓存，总线上什么也没有，只花 ${DEFAULT_LATENCY.hit} 周期。E 变 M 也一样不上总线，这就是多一个 E 状态的好处：单核私有的数据不会产生多余的总线流量。`,
    facts: [['总线', '无'], ['核 0', `${e4.self.from} → ${e4.self.to}`], ['周期', String(e4.endCycle - e4.startCycle + 1)], ['内存', `仍是 ${e4.memoryValue}`]],
    events: play(e4),
  },
  {
    title: '冲回',
    desc: '别人要读脏数据：M → S',
    detail: `核 1 读，自己是 I，发 BusRd。内存里的值已经过期，不能用。核 0 嗅探到后，把 ${e5.memoryValue} 放上总线，内存和核 1 同时拿到，核 0 从 M 降到 S。这个模型里这次访问要 ${e5.endCycle - e5.startCycle + 1} 周期（E.G.），比普通的内存读还慢。`,
    facts: [['总线', e5.bus!], ['冲回者', `核 ${e5.flushedBy}`], ['核 0', `${e5.snoops[0].from} → ${e5.snoops[0].to}`], ['核 1 读到', String(e5.value)], ['内存更新为', String(e5.memoryValue)]],
    events: play(e5),
  },
  {
    title: '来回争抢',
    desc: '两个核轮流写同一行，代价很高',
    detail: `核 1 写 ${e6.value}（BusUpgr，让核 0 作废），接着核 0 读又要从核 1 那里冲回。两个核如果轮流写同一个缓存行，这一行就在它们之间来回搬。两个无关的变量碰巧落在同一行也一样，这叫伪共享，是多线程程序常见的性能陷阱。`,
    facts: [['核 1 写', `${e6.self.from} → ${e6.self.to}`], ['核 0 再读', `${e7.self.from} → ${e7.self.to}`], ['冲回者', `核 ${e7.flushedBy}`], ['总周期', `${e7.endCycle} E.G.`]],
    events: [...play(e6), ...play(e7)],
  },
];

const pad = () => ({ cache: linePanel(0, 'I', 0), cache1: linePanel(1, 'I', 0), dram: memPanel(INITIAL, false) });

export const coherence: Lesson = {
  id: 'coherence',
  name: 'COHERENCE',
  title: 'MESI 缓存一致性',
  group: 'memio',
  layer: [4, 5],
  clock: 'cycle',
  nodes: ['core0', 'core1', 'cache', 'cache1', 'bus', 'dram'],
  place: { core0: [130, 90], core1: [670, 90], cache: [130, 290], cache1: [670, 290], bus: [400, 400], dram: [150, 530] },
  labels: {
    core0: ['核 0', ''],
    core1: ['核 1', ''],
    cache: ['核 0 的缓存', ''],
    cache1: ['核 1 的缓存', ''],
    bus: ['总线', '所有缓存都在嗅探'],
    dram: ['内存', ''],
  },
  panels: { cache: [210, 190], cache1: [460, 190], dram: [245, 495], history: [540, 465] },
  main: ['history'],
  strip: [['cache', 'cache1', 'dram'], 'history'],
  initial: { ...pad(), history: grid('状态变化', [['#', 20], ['操作', 76], ['总线', 56], ['核0', 30], ['核1', 30], ['内存', 40]], [[dim('—'), dim('—'), dim('—'), stateCell('I'), stateCell('I'), String(INITIAL)]]) },
  start: ['core0', 'core1', 'cache', 'cache1'],
  legend: [['blue', '核的访问'], ['violet', '总线请求'], ['amber', '嗅探和冲回'], ['green', '拿到数据'], [null, '周期是示例，只缓存一个地址']],
  overview: {
    full: '多个核各有缓存，怎么保证读到最新值',
    description: '每个核都有自己的缓存，写回缓存又让内存暂时过期。如果不加协调，核 1 可能读到核 0 早就改掉的旧值。MESI 给每个缓存行 4 种状态，再让所有缓存监听总线。这一课用真实的状态机跑一串读写，结构图上每一步都能看到两边的状态和内存的值。',
    facts: [
      ['M', '已修改：唯一副本，比内存新'],
      ['E', '独占：唯一副本，和内存相同'],
      ['S', '共享：可能多份，和内存相同'],
      ['I', '无效'],
      ['规则', '同一时刻一个写者，或多个读者'],
      ['做法', '总线嗅探 + 写失效'],
    ],
  },
  steps,
  outro: {
    title: '一个写者，或多个读者',
    desc: '硬件保证，软件看不见',
    text: '一致性协议让所有核对同一地址的写顺序达成一致，程序不用自己刷缓存。核数多了以后，总线广播扛不住，服务器芯片改用目录来记录谁有副本，状态机的思想相同。',
    facts: [['写之前', '先让别人作废'], ['M 被读', '冲回内存，降为 S'], ['下一课', 'DRAM']],
  },
};

