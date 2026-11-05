import { cacheAddressLayer, cacheLineLayer, concept, wire } from '../decode/structures';
import { Cache, type AccessResult, type CacheConfig } from '../sim/cache';
import { Memory } from '../sim/exec';
import { note, pk, probe, show } from './dsl';
import type { Lesson, LessonEvent } from './types';
import { cachePanel, cell, grid, hx, on } from './views';

const BASE: Omit<CacheConfig, 'writePolicy' | 'writeMiss'> = { sets: 2, ways: 2, blockBytes: 16, hitCycles: 1, missPenalty: 20, writePenalty: 10 };
const WT: CacheConfig = { ...BASE, writePolicy: 'write-through', writeMiss: 'no-allocate' };
const WB: CacheConfig = { ...BASE, writePolicy: 'write-back', writeMiss: 'allocate' };

const fresh = () => {
  const memory = new Memory();
  for (let address = 0x2000; address < 0x2100; address += 4) memory.storeWord(address, 0x11110000 + address);
  return memory;
};

const wtMem = fresh();
const wbMem = fresh();
const wt = new Cache(WT, wtMem);
const wb = new Cache(WB, wbMem);

const ADDR = 0x2000;
const CONFLICT_A = 0x2020;
const CONFLICT_B = 0x2040;

// 先读进缓存：后面的写就是写命中。
const warmT = wt.read(ADDR);
const warmB = wb.read(ADDR);
const hit1T = wt.write(ADDR, 0xaaaa0001);
const hit1B = wb.write(ADDR, 0xaaaa0001);
const hit2T = wt.write(ADDR, 0xaaaa0002);
const hit2B = wb.write(ADDR, 0xaaaa0002);
const memAfterHitT = wtMem.loadWord(ADDR);
const memAfterHitB = wbMem.loadWord(ADDR);
// 再用同一组的两个块把脏行挤出去。
const fillT = wt.read(CONFLICT_A);
const fillB = wb.read(CONFLICT_A);
const evictT = wt.read(CONFLICT_B);
const evictB = wb.read(CONFLICT_B);
const memAfterEvictB = wbMem.loadWord(ADDR);
// 写未命中：写一个不在缓存里的块。
const MISS = 0x2010;
const missT = wt.write(MISS, 0xbbbb0001);
const missB = wb.write(MISS, 0xbbbb0001);

/** 在同一个地址上连续写 100 次，真实比较到内存的写流量。 */
function traffic(config: CacheConfig) {
  const cache = new Cache(config, fresh());
  cache.read(ADDR);
  for (let index = 0; index < 100; index++) cache.write(ADDR, index);
  cache.flush();
  const dirtyFlush = config.writePolicy === 'write-back' ? BASE.blockBytes : 0;
  return { cycles: cache.cycle + (dirtyFlush ? BASE.writePenalty : 0), bytes: cache.memWriteBytes + dirtyFlush, writes: cache.memWrites + (dirtyFlush ? 1 : 0) };
}
const tT = traffic(WT);
const tB = traffic(WB);

const memGrid = (t: number, b: number, tNew = false, bNew = false) => grid(`内存 ${hx(ADDR)} 处的值`, [['', 62], ['值', 90]], [
  ['写直达侧', tNew ? cell(hx(t), 'amber') : hx(t)],
  ['写回侧', bNew ? cell(hx(b), 'amber') : hx(b)],
]);

interface Totals {
  memWriteBytes: number;
  cycle: number;
}

const counters = (t: Totals, b: Totals) => grid('累计写内存字节 / 周期', [['', 62], ['写内存', 56], ['周期', 44]], [
  ['写直达', cell(`${t.memWriteBytes} B`, 'amber'), String(t.cycle)],
  ['写回', cell(`${b.memWriteBytes} B`, 'green'), String(b.cycle)],
]);

const running = (logT: AccessResult[], logB: AccessResult[]): [Totals, Totals] => [
  { memWriteBytes: logT.reduce((sum, item) => sum + item.memWriteBytes, 0), cycle: logT[logT.length - 1].endCycle },
  { memWriteBytes: logB.reduce((sum, item) => sum + item.memWriteBytes, 0), cycle: logB[logB.length - 1].endCycle },
];

const tPanel = (r: AccessResult, tone: 'green' | 'amber' = 'green') => cachePanel('写直达 + 不分配', r.snapshot, { set: r.set, way: r.way, tone }, { dirty: true });
const bPanel = (r: AccessResult, tone: 'green' | 'amber' = 'green') => cachePanel('写回 + 写分配', r.snapshot, { set: r.set, way: r.way, tone }, { dirty: true });

const addrLayer = (r: AccessResult) => cacheAddressLayer(r.address, r.parts);
const lineOf = (r: AccessResult, name: string) => cacheLineLayer(name, r.snapshot[r.set][r.way!], { summary: `第 ${r.set} 组 路 ${r.way}` });

const wired = (at: string, r: AccessResult, name: string, ...more: ReturnType<typeof concept>[]) => wire(at, 'mem', 'model', addrLayer(r), ...(r.way === null ? [] : [lineOf(r, name)]), ...more);

const writeHit: LessonEvent[] = [
  probe({ cache: tPanel(warmT), cache1: bPanel(warmB) }),
  pk('core0', 'cache', 'blue', 'sw', [hx(hit1T.value)], [hit1T.startCycle, 'MEM', `写直达侧：写 ${hx(ADDR)} = ${hx(hit1T.value)}，命中`, 4, 'A'], wired('CPU 写，缓存命中', hit1T, '写之后的行')),
  probe({ cache: tPanel(hit1T) }),
  pk('cache', 'dram', 'amber', '写穿', [`${hit1T.memWriteBytes} 字节`], [hit1T.endCycle, 'BUS', `写直达：同时写内存 ${hit1T.memWriteBytes} 字节，多花 ${BASE.writePenalty} 周期`, hit1T.memWriteBytes, 'A'],
    wired('缓存和内存一起更新', hit1T, '写之后的行', concept('写直达', [['内存', hx(memAfterHitT), '内存永远是最新的。'], ['D 位', '不需要']], 'amber'))),
  probe({ mem: memGrid(hit1T.value, memAfterHitB, true), stats: counters(...running([warmT, hit1T], [warmB])) }),
  pk('core0', 'cache1', 'blue', 'sw', [hx(hit1B.value)], [hit1B.startCycle, 'MEM', `写回侧：写 ${hx(ADDR)} = ${hx(hit1B.value)}，命中`, 4, 'B'], wired('CPU 写，缓存命中', hit1B, '写之后的行')),
  probe({ cache1: bPanel(hit1B) }),
  note('cache1', '只置 D 位，不碰内存', 'green'),
];

const repeated: LessonEvent[] = [
  pk('core0', 'cache', 'blue', 'sw', [hx(hit2T.value)], [hit2T.startCycle, 'MEM', `写直达侧：再写一次 ${hx(hit2T.value)}`, 4, 'A'], wired('再写同一地址', hit2T, '写之后的行'), { quick: true }),
  probe({ cache: tPanel(hit2T) }),
  pk('cache', 'dram', 'amber', '写穿', [`${hit2T.memWriteBytes} 字节`], [hit2T.endCycle, 'BUS', '写直达：又写一次内存', hit2T.memWriteBytes, 'A'], wired('每次写都到内存', hit2T, '写之后的行'), { quick: true }),
  probe({ mem: memGrid(hit2T.value, memAfterHitB, true), stats: counters(...running([warmT, hit1T, hit2T], [warmB, hit1B])) }),
  pk('core0', 'cache1', 'blue', 'sw', [hx(hit2B.value)], [hit2B.startCycle, 'MEM', '写回侧：再写一次，只改缓存', 4, 'B'], wired('只改缓存', hit2B, '写之后的行'), { quick: true }),
  probe({ cache1: bPanel(hit2B), mem: memGrid(memAfterHitT, memAfterHitB, false, false), stats: counters(...running([warmT, hit1T, hit2T], [warmB, hit1B, hit2B])) }),
];

const eviction: LessonEvent[] = [
  probe({ cache: tPanel(fillT), cache1: bPanel(fillB) }, 600),
  pk('core0', 'cache1', 'blue', 'lw', [hx(CONFLICT_B)], [evictB.startCycle, 'MEM', `写回侧：读 ${hx(CONFLICT_B)}，同一组已满，要替换`, 4, 'B'], wired('读未命中', evictB, '替换后的行')),
  pk('cache1', 'dram', 'amber', '写回', [`脏块 ${hx(evictB.evicted!.address)}`, `${BASE.blockBytes} 字节`], [evictB.startCycle, 'BUS', `被替换的行是脏的：把 ${hx(evictB.evicted!.address)} 的 ${BASE.blockBytes} 字节写回内存`, BASE.blockBytes, 'B'],
    wired('替换时才写回', evictB, '替换后的行', concept('被替换的行', [['地址', hx(evictB.evicted!.address)], ['脏位', evictB.evicted!.dirty ? '1' : '0', 'D = 1 才需要写回，干净的行直接丢弃。'], ['写回后内存', hx(memAfterEvictB)]], 'amber'))),
  probe({ cache1: bPanel(evictB, 'amber'), cache: tPanel(evictT, 'amber'), mem: memGrid(memAfterHitT, memAfterEvictB, false, true), stats: counters(...running([warmT, hit1T, hit2T, fillT, evictT], [warmB, hit1B, hit2B, fillB, evictB])) }),
];

const writeMiss: LessonEvent[] = [
  pk('core0', 'cache', 'blue', 'sw 未命中', [hx(MISS)], [missT.startCycle, 'MISS', `写直达 + 不分配：${hx(MISS)} 不在缓存，只写内存`, 4, 'A'], wire('写未命中', 'mem', 'model', addrLayer(missT))),
  pk('cache', 'dram', 'amber', '只写内存', [`${missT.memWriteBytes} 字节`], [missT.endCycle, 'BUS', `不分配：写内存 ${missT.memWriteBytes} 字节，缓存不变，共 ${missT.cycles} 周期`, missT.memWriteBytes, 'A'],
    wire('不分配', 'mem', 'model', addrLayer(missT), concept('写未命中策略', [['不分配', '缓存不变'], ['下次读这个块', '还是未命中']], 'amber'))),
  probe({ cache: tPanel(missT), stats: counters(...running([warmT, hit1T, hit2T, fillT, evictT, missT], [warmB, hit1B, hit2B, fillB, evictB])) }),
  pk('core0', 'cache1', 'blue', 'sw 未命中', [hx(MISS)], [missB.startCycle, 'MISS', `写回 + 写分配：${hx(MISS)} 不在缓存，先把块读进来`, 4, 'B'], wired('写未命中', missB, '写之后的行')),
  pk('dram', 'cache1', 'teal', '读块', [`${missB.memReadBytes} 字节`], [missB.endCycle, 'DATA', `写分配：读入 ${missB.memReadBytes} 字节，改其中 4 字节并置脏，共 ${missB.cycles} 周期`, missB.memReadBytes, 'B'], wired('先读块再改', missB, '写之后的行')),
  probe({ cache1: bPanel(missB, 'amber'), stats: counters(...running([warmT, hit1T, hit2T, fillT, evictT, missT], [warmB, hit1B, hit2B, fillB, evictB, missB])) }),
];

export const writepolicy: Lesson = {
  id: 'writepolicy',
  name: 'WRITE POLICY',
  title: '写策略',
  group: 'memio',
  layer: [4, 4],
  clock: 'cycle',
  nodes: ['core0', 'cache', 'cache1', 'dram'],
  place: { core0: [90, 290], cache: [370, 170], cache1: [370, 420], dram: [720, 290] },
  labels: {
    core0: ['CPU', '写同一串地址'],
    cache: ['缓存 A', '写直达 + 不分配'],
    cache1: ['缓存 B', '写回 + 写分配'],
    dram: ['DRAM', ''],
  },
  panels: { cache: [175, 0], cache1: [175, 505], mem: [610, 380], stats: [610, 490] },
  main: ['cache', 'cache1'],
  strip: ['cache', 'cache1', ['mem', 'stats']],
  initial: {
    cache: cachePanel('写直达 + 不分配', new Cache(WT).lines, {}, { dirty: true }),
    cache1: cachePanel('写回 + 写分配', new Cache(WB).lines, {}, { dirty: true }),
    mem: memGrid(fresh().loadWord(ADDR), fresh().loadWord(ADDR)),
    stats: grid('累计写内存字节 / 周期', [['', 62], ['写内存', 56], ['周期', 44]], [['写直达', '0 B', '0'], ['写回', '0 B', '0']]),
  },
  start: ['core0', 'cache', 'cache1'],
  legend: [['blue', 'CPU 写'], ['amber', '写内存'], ['teal', '读块'], ['green', '只改缓存'], [null, 'A、B 两块缓存各自计周期，参数是示例']],
  overview: {
    full: '写的时候，内存要不要马上更新',
    description: '读只是复制数据，写才会让缓存和内存不一样。这一课用同一串访问驱动两块缓存：一块写直达，每次写都到内存；一块写回，先只改缓存，被替换时才写回。缓存的脏位、内存的值和总线上的字节数都是模拟器实际算出来的。',
    facts: [
      ['缓存', `${BASE.sets} 组 × ${BASE.ways} 路 × ${BASE.blockBytes} B E.G.`],
      ['写内存代价', `${BASE.writePenalty} 周期 E.G.`],
      ['读块代价', `${BASE.missPenalty} 周期 E.G.`],
      ['连写 100 次 · 写直达', `${tT.bytes} B`],
      ['连写 100 次 · 写回', `${tB.bytes} B`],
    ],
  },
  steps: [
    {
      title: '写命中',
      desc: '两种策略的第一次写',
      detail: '两块缓存都已经读入这个块，这次写都命中。写直达同时更新缓存和内存，内存永远是最新的，代价是每次都要占总线。写回只改缓存，把这一行的脏位 D 置 1，表示「内存里的是旧的」。',
      facts: [['写直达周期', String(hit1T.cycles)], ['写回周期', String(hit1B.cycles)], ['写回侧内存', `仍是 ${hx(memAfterHitB)}`], ['写直达侧内存', `已是 ${hx(hit1T.value)}`]],
      events: [show('dram'), ...writeHit],
    },
    {
      title: '连续写',
      desc: '写回把多次写合并成一次',
      detail: `循环里的计数器会反复写同一个地址。写直达每次都写内存；写回一直只改缓存，无论写多少次，将来也只写回一次。到这里写直达已经写了 ${[hit1T, hit2T].reduce((sum, item) => sum + item.memWriteBytes, 0)} 字节，写回 0 字节。`,
      facts: [['写直达累计', `${hit1T.memWriteBytes + hit2T.memWriteBytes} B`], ['写回累计', `${hit1B.memWriteBytes + hit2B.memWriteBytes} B`], ['写回侧内存', hx(memAfterHitB)], ['缓存里的最新值', hx(hit2B.value)]],
      events: repeated,
    },
    {
      title: '替换时写回',
      desc: '脏行被赶走时才写内存',
      detail: `再读同一组的另外两个块，把脏行挤出去。写回缓存发现被替换的行 D = 1，必须把整块 ${BASE.blockBytes} 字节写回内存，这次读未命中花了 ${evictB.cycles} 周期（读块 ${BASE.missPenalty} + 写回 ${BASE.writePenalty} + 命中 ${BASE.hitCycles}）。写直达的行永远是干净的，只要 ${evictT.cycles} 周期。`,
      facts: [['被替换', hx(evictB.evicted!.address)], ['写回字节', `${BASE.blockBytes} B`], ['写回后内存', hx(memAfterEvictB)], ['写回侧这次', `${evictB.cycles} 周期`], ['写直达这次', `${evictT.cycles} 周期`]],
      events: eviction,
    },
    {
      title: '写未命中',
      desc: '要不要把块读进来',
      detail: `写一个不在缓存里的地址有两种做法。不分配：直接写内存，缓存不变，这里花 ${missT.cycles} 周期。写分配：先把整块读进来再改，这里花 ${missB.cycles} 周期，好处是之后对这一块的读写都能命中。通常写回搭配写分配，写直达搭配不分配。`,
      facts: [['不分配', `${missT.cycles} 周期，写 ${missT.memWriteBytes} B`], ['写分配', `${missB.cycles} 周期，读 ${missB.memReadBytes} B`], ['常见组合', '写回 + 写分配'], ['写入后 D 位', missB.snapshot[missB.set][missB.way!].dirty ? '1' : '0']],
      events: writeMiss,
    },
    {
      title: '谁更划算',
      desc: '在同一地址连写 100 次',
      detail: `跑一遍真实对比：同一地址写 100 次再全部写回。写直达写了 ${tT.writes} 次共 ${tT.bytes} 字节，总 ${tT.cycles} 周期；写回只写 ${tB.writes} 次共 ${tB.bytes} 字节，总 ${tB.cycles} 周期。真实 CPU 的写直达缓存后面通常有写缓冲，CPU 把数据放进缓冲就继续走，不用等内存，这里的模型没有写缓冲。`,
      facts: [['写直达', `${tT.bytes} B，${tT.cycles} 周期`], ['写回', `${tB.bytes} B，${tB.cycles} 周期`], ['字节比', `${(tT.bytes / tB.bytes).toFixed(0)} 倍`], ['模型没有', '写缓冲']],
      events: [
        probe({ stats: grid('同一地址连写 100 次（含最后写回）', [['', 62], ['写内存', 56], ['周期', 50]], [
          ['写直达', cell(`${tT.bytes} B`, 'amber'), String(tT.cycles)],
          ['写回', on(`${tB.bytes} B`, 'green'), String(tB.cycles)],
        ]) }, 500),
        pk('cache1', 'dram', 'green', '只写一次', [`${tB.bytes} 字节`], [missB.endCycle + 1, 'CALC', `连写 100 次：写回写内存 ${tB.bytes} B，写直达 ${tT.bytes} B`, tB.bytes, 'B'],
          wire('100 次写的流量对比', 'regs', 'model', concept('对比', [
            ['写直达', `${tT.writes} 次，${tT.bytes} B，${tT.cycles} 周期`],
            ['写回', `${tB.writes} 次，${tB.bytes} B，${tB.cycles} 周期`, '包括最后那次写回的 ' + BASE.writePenalty + ' 周期。'],
          ], 'green'))),
      ],
    },
  ],
  outro: {
    title: '写回省流量，写直达省事',
    desc: '代价是缓存和内存暂时不一致',
    text: '写回让缓存里的数据比内存新，一核的时候没关系；可一旦有第二个核或 DMA 也要读这块内存，它们读到的就可能是旧值。这正是下一课要解决的问题。',
    facts: [['D 位', '只有写回需要'], ['不一致窗口', '从写入到写回'], ['下一课', 'COHERENCE']],
  },
};

