import { cacheAddressLayer, cacheLineLayer, concept, registers, wire } from '../decode/structures';
import { Cache, type AccessResult, type CacheConfig } from '../sim/cache';
import { Memory } from '../sim/exec';
import { pk, probe, show } from './dsl';
import type { Lesson, LessonEvent } from './types';
import { addressBits, cachePanel, cell, dim, hx, kv } from './views';

const CONFIG: CacheConfig = { sets: 4, ways: 2, blockBytes: 16, hitCycles: 1, missPenalty: 20, writePenalty: 10, writePolicy: 'write-back', writeMiss: 'allocate' };
const CAPACITY = CONFIG.sets * CONFIG.ways * CONFIG.blockBytes;

/** 内存内容用地址生成，每个字节都能算回来。 */
const memory = new Memory();
for (let address = 0x1000; address < 0x1100; address++) memory.store8(address, (address * 7 + 0x31) & 0xff);

const cache = new Cache(CONFIG, memory);
const ADDRS = [0x1004, 0x100c, 0x1044, 0x1000, 0x1084, 0x1044];
const log = ADDRS.map((address) => cache.read(address));
const [cold, spatial, second, again, evict, conflict] = log;
const initialLines = new Cache(CONFIG).lines;

const statsPanel = (upto: number) => {
  const done = log.slice(0, upto + 1);
  const hits = done.filter((item) => item.hit).length;
  return kv('统计', [
    ['访问', String(done.length)],
    ['命中', cell(String(hits), 'green')],
    ['未命中', cell(String(done.length - hits), 'amber')],
    ['周期', String(done[done.length - 1]?.endCycle ?? 0)],
  ]);
};

const dramPanel = (active?: AccessResult) => kv('DRAM', active && !active.hit ? [['读块', hx(active.address - active.parts.offset)], ['字节', '16 B'], ['代价', `${CONFIG.missPenalty} 周期`]] : [['读块', dim('—')], ['字节', dim('—')], ['代价', dim('—')]]);

function panels(r: AccessResult, index: number, tone: 'green' | 'amber') {
  return {
    addr: addressBits(r.address, r.parts, `地址 ${hx(r.address)}`),
    cache: cachePanel('缓存：4 组 × 2 路', r.snapshot, { set: r.set, way: r.way, tone }),
    stats: statsPanel(index),
    dram: dramPanel(r),
  };
}

const addressWire = (r: AccessResult, at: string, ...more: ReturnType<typeof concept>[]) => wire(at, 'mem', 'model', cacheAddressLayer(r.address, r.parts), ...more);

const lookup = (r: AccessResult) => concept(`第 ${r.set} 组的比较`, r.snapshot[r.set].map((line, way): [string, string, string?] => [`路 ${way}`, line.valid ? `标记 0x${line.tag.toString(16)}` : '无效', way === r.way ? (r.hit ? '标记相等且有效：命中。' : '填入了这一路。') : undefined]), r.hit ? 'green' : 'amber');

const lineLayer = (r: AccessResult) => cacheLineLayer(`第 ${r.set} 组 路 ${r.way}`, r.snapshot[r.set][r.way!], { summary: `访问结束时的内容` });

function access(r: AccessResult, index: number): LessonEvent[] {
  const events: LessonEvent[] = [
    probe({ addr: addressBits(r.address, r.parts, `地址 ${hx(r.address)}`) }),
    pk('core0', 'cache', 'blue', '读', [hx(r.address), `组 ${r.set}`], [r.startCycle, 'MEM', `lw 读 ${hx(r.address)}：标记 0x${r.parts.tag.toString(16)}，组 ${r.set}，偏移 ${r.parts.offset}`, 4],
      addressWire(r, '地址按固定位段切开', lookup(r))),
  ];
  if (r.hit) {
    events.push(
      probe(panels(r, index, 'green')),
      pk('cache', 'core0', 'green', '命中', [hx(r.value)], [r.endCycle, 'HIT', `第 ${r.set} 组路 ${r.way} 命中，返回 ${hx(r.value)}，共 ${r.cycles} 周期`, 4],
        addressWire(r, '命中：直接从这一路取数据', lineLayer(r))),
    );
    return events;
  }
  events.push(
    show('dram'),
    probe({ dram: dramPanel(r) }),
    pk('cache', 'dram', 'amber', '未命中', [`读 ${hx(r.address - r.parts.offset)}`], [r.startCycle, 'MISS', r.evicted ? `第 ${r.set} 组已满，替换标记 0x${r.evicted.tag.toString(16)}，向 DRAM 读整块` : `第 ${r.set} 组没有这个标记，向 DRAM 读整块`, 16],
      addressWire(r, '未命中：去下一级读一整块', lookup(r), concept('替换', r.evicted ? [['被替换', `标记 0x${r.evicted.tag.toString(16)}（地址 ${hx(r.evicted.address)}）`, '这一路最久没用。它没有被写过，直接丢弃。'], ['脏位', r.evicted.dirty ? '1' : '0']] : [['被替换', '无，用空的一路']], 'amber'))),
    pk('dram', 'cache', 'teal', '填充', [`16 字节`, `${CONFIG.missPenalty} 周期`], [r.endCycle - 1, 'DATA', `块 ${hx(r.address - r.parts.offset)} 填进第 ${r.set} 组路 ${r.way}`, 16],
      addressWire(r, 'DRAM 返回一整块', lineLayer(r))),
    probe(panels(r, index, 'amber')),
    pk('cache', 'core0', 'green', '返回', [hx(r.value)], [r.endCycle, 'DATA', `返回 ${hx(r.value)}，这次访问共 ${r.cycles} 周期`, 4],
      wire('把块内的 4 字节交给 CPU', 'regs', 'model', registers('读到的值', [['rd', r.value, `块内偏移 ${r.parts.offset} 开始的 4 字节，小端。`]], 'green')), { quick: true }),
  );
  return events;
}

const total = log.length;
const hits = log.filter((item) => item.hit).length;
const hitRate = hits / total;
const amat = CONFIG.hitCycles + (1 - hitRate) * CONFIG.missPenalty;

export const cacheLesson: Lesson = {
  id: 'cache',
  name: 'CACHE',
  title: '组相联缓存',
  group: 'memio',
  layer: [4, 4],
  clock: 'cycle',
  nodes: ['core0', 'cache', 'dram'],
  place: { core0: [90, 180], cache: [400, 180], dram: [710, 180] },
  labels: {
    core0: ['CPU', 'lw 指令'],
    cache: ['数据缓存', `${CAPACITY} B，2 路组相联`],
    dram: ['DRAM', ''],
  },
  panels: { addr: [180, 0], stats: [10, 280], cache: [195, 275], dram: [625, 280] },
  main: ['cache'],
  strip: [['addr', 'stats', 'dram'], 'cache'],
  initial: {
    addr: addressBits(0x1004, cold.parts, `地址 ${hx(0x1004)}`),
    stats: kv('统计', [['访问', '0'], ['命中', '0'], ['未命中', '0'], ['周期', '0']]),
    cache: cachePanel('缓存：4 组 × 2 路', initialLines),
    dram: dramPanel(),
  },
  start: ['core0', 'cache'],
  legend: [['blue', '访问'], ['green', '命中和返回'], ['amber', '未命中'], ['teal', '填充'], [null, '容量和周期都是教学参数']],
  overview: {
    full: '把最近用过的内存留在 CPU 旁边',
    description: `DRAM 比 CPU 慢很多，缓存用一小块快速存储保存最近用过的块。这一课用真实的组相联缓存模拟器：${CONFIG.sets} 组、每组 ${CONFIG.ways} 路、块大小 ${CONFIG.blockBytes} 字节。地址怎么切、组和路里存了什么、谁被替换，全部实时显示在结构图上。`,
    facts: [
      ['容量', `${CONFIG.sets} × ${CONFIG.ways} × ${CONFIG.blockBytes} = ${CAPACITY} B E.G.`],
      ['地址拆分', `标记 ${cold.parts.tagBits} / 索引 ${cold.parts.indexBits} / 偏移 ${cold.parts.offsetBits}`],
      ['替换策略', 'LRU'],
      ['命中', `${CONFIG.hitCycles} 周期 E.G.`],
      ['未命中代价', `${CONFIG.missPenalty} 周期 E.G.`],
      ['真实 L1', '32 KiB，8 路，64 B 块 E.G.'],
    ],
  },
  steps: [
    {
      title: '切开地址',
      desc: '标记、组索引、块内偏移',
      detail: `块是 16 字节，低 4 位选块内字节；有 4 组，接下来 2 位选组；剩下 ${cold.parts.tagBits} 位是标记，用来分辨同一组里存的是谁。地址 ${hx(cold.address)} 拆出来是标记 0x${cold.parts.tag.toString(16)}、组 ${cold.parts.index}、偏移 ${cold.parts.offset}。这样切只需要连线，不需要计算。`,
      facts: [['偏移位', `log2(${CONFIG.blockBytes}) = ${cold.parts.offsetBits}`], ['索引位', `log2(${CONFIG.sets}) = ${cold.parts.indexBits}`], ['标记位', `32 - ${cold.parts.indexBits} - ${cold.parts.offsetBits} = ${cold.parts.tagBits}`], ['组索引', String(cold.parts.index)]],
      events: [
        pk('core0', 'cache', 'blue', '地址', [hx(cold.address)], [0, 'MEM', `CPU 发出地址 ${hx(cold.address)}`, '32b'], addressWire(cold, '地址线上的 32 位')),
        probe({ addr: addressBits(cold.address, cold.parts, `地址 ${hx(cold.address)}`) }, 900),
      ],
    },
    {
      title: '冷启动未命中',
      desc: '缓存是空的，从 DRAM 读一整块',
      detail: `第 ${cold.set} 组的两路都无效，未命中。缓存不会只读 4 字节，它把 ${hx(cold.address - cold.parts.offset)} 开始的整块 16 字节读回来，放进路 0，有效位置 1，写上标记。这次访问花了 ${cold.cycles} 周期。`,
      facts: [['结果', '未命中'], ['读入', `${CONFIG.blockBytes} 字节`], ['周期', String(cold.cycles)], ['放入', `第 ${cold.set} 组路 ${cold.way}`]],
      events: access(cold, 0),
    },
    {
      title: '空间局部性',
      desc: '同一块里的另一个地址，命中',
      detail: `${hx(spatial.address)} 和上一个地址在同一块里：组和标记都相同，只有偏移不同。这次命中，只要 ${spatial.cycles} 周期。程序顺序访问数组时，每 16 字节才未命中一次，这就是读一整块的回报。`,
      facts: [['结果', '命中'], ['组', String(spatial.set)], ['偏移', String(spatial.parts.offset)], ['周期', String(spatial.cycles)]],
      events: access(spatial, 1),
    },
    {
      title: '组相联',
      desc: '同组的不同块放进另一路',
      detail: `${hx(second.address)} 的组也是 ${second.set}，但标记是 0x${second.parts.tag.toString(16)}。直接映射的缓存只能把旧块赶走；2 路组相联可以放进路 ${second.way}，两个块同时留着。接着再读 ${hx(again.address)}，它还在路 ${again.way}，命中。查找时两路的标记要同时比较，所以路数越多，比较器越多。`,
      facts: [['新块', `路 ${second.way}`], ['再读旧块', again.hit ? '命中' : '未命中'], ['比较器', '每路一个'], ['周期累计', String(again.endCycle)]],
      events: [...access(second, 2), ...access(again, 3)],
    },
    {
      title: 'LRU 替换',
      desc: '第 3 个块进来，赶走最久没用的',
      detail: `${hx(evict.address)} 也映射到第 ${evict.set} 组，两路都满了。LRU 选最久没被访问的一路：刚才读过 ${hx(again.address)}，所以路 ${evict.way} 里的标记 0x${evict.evicted!.tag.toString(16)} 被替换。这种未命中叫冲突未命中：缓存还有空位，只是这一组放不下。接着再读被赶走的 ${hx(conflict.address)}，又${conflict.hit ? '命中' : '未命中'}了。`,
      facts: [['替换', `路 ${evict.way}，标记 0x${evict.evicted!.tag.toString(16)}`], ['原因', '这一组满了'], ['缓存里还有空位', '第 1、2、3 组都是空的'], ['再读旧块', conflict.hit ? '命中' : '未命中']],
      events: [...access(evict, 4), ...access(conflict, 5)],
    },
    {
      title: '平均访问时间',
      desc: `命中率 ${hits}/${total}`,
      detail: `平均访问时间 = 命中时间 + 未命中率 × 未命中代价 = ${CONFIG.hitCycles} + ${(1 - hitRate).toFixed(3)} × ${CONFIG.missPenalty} = ${amat.toFixed(2)} 周期。这段故意制造冲突的序列命中率很低；真实程序的 L1 命中率通常远高于这个值。未命中代价比命中时间大一两个数量级，命中率差一点，平均时间就差很多。`,
      facts: [['访问', String(total)], ['命中', String(hits)], ['模拟总周期', String(conflict.endCycle)], ['平均访问时间', `${amat.toFixed(2)} 周期`]],
      events: [
        probe({ stats: statsPanel(5), cache: cachePanel('缓存：4 组 × 2 路', conflict.snapshot) }),
        pk('cache', 'core0', 'green', 'AMAT', [`${amat.toFixed(2)} 周期`], [conflict.endCycle, 'CALC', `${total} 次访问，命中 ${hits} 次，平均 ${amat.toFixed(2)} 周期`, null],
          wire('统计结果', 'regs', 'model', concept('平均访问时间', [
            ['命中时间', `${CONFIG.hitCycles} 周期`],
            ['未命中率', `${total - hits}/${total}`],
            ['未命中代价', `${CONFIG.missPenalty} 周期`],
            ['AMAT', `${amat.toFixed(2)} 周期`, '公式用的是未命中的平均代价。这里所有未命中代价相同，且没有脏块。'],
          ], 'green'))),
      ],
    },
  ],
  outro: {
    title: '三个 C',
    desc: '冷启动、容量、冲突',
    text: '未命中有三类：第一次访问的冷启动未命中，缓存装不下的容量未命中，一组放不下的冲突未命中。增加路数能减少冲突，但比较器更多、更耗电。真实处理器还要处理写入和多核，这是后面两课的内容。',
    facts: [['索引选组', '只比较这一组'], ['标记分辨', '存的是谁'], ['下一课', 'WRITE POLICY']],
  },
};

