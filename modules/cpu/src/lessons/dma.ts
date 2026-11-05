import { concept, registers, wire } from '../decode/structures';
import { runDma, runPio, type BusCycle, type TransferConfig } from '../sim/dma';
import { pk, probe, show } from './dsl';
import type { CellLike } from '../scene/widgets';
import type { Lesson, LessonEvent } from './types';
import { cell, dim, grid, hx, kv, on } from './views';

const CONFIG: TransferConfig = {
  words: 4,
  destination: 0x4000,
  source: (index) => (0xc0de0000 + index) >>> 0,
  deviceInterval: 4,
  cpuBusEvery: 3,
  setupWrites: 4,
};

const pio = runPio(CONFIG);
const dma = runDma(CONFIG);

const LONG: TransferConfig = { ...CONFIG, words: 1024 };
const pioLong = runPio(LONG);
const dmaLong = runDma(LONG);

/** 总线占用条：每拍一格。 */
function busStrip(log: BusCycle[], upto: number, title: string, first = 1, count = 26) {
  const cols: Array<[string, number]> = [];
  for (let c = first; c < first + count; c++) cols.push([c % 5 === 0 ? String(c) : '', 22]);
  const row: CellLike[] = [];
  for (let c = first; c < first + count; c++) {
    const item = log[c - 1];
    if (!item || c > upto) row.push(dim('·'));
    else if (item.owner === 'CPU') row.push(on('C', 'blue'));
    else if (item.owner === 'DMA') row.push(on('D', item.waiting ? 'red' : 'teal'));
    else row.push(dim('-'));
  }
  return grid(title, cols, [row]);
}

const dmaRegs = (src: string, dst: string, len: string, ctrl: string) => kv('DMA 控制器寄存器', [['SRC', src], ['DST', dst], ['LEN', len], ['CTRL', ctrl]]);
const memPanel = (filled: number, values: Array<number | null> = []) => grid(`内存 ${hx(CONFIG.destination)} 起`, [['偏移', 40], ['值', 86]], Array.from({ length: CONFIG.words }, (_, index): CellLike[] => [`+${index * 4}`, index < filled && values[index] !== null ? cell(hx(values[index] ?? 0), 'green') : dim('—')]));
const cpuPanel = (work: string, tone: 'green' | 'red' | 'blue', busy: string) => kv('CPU', [['在做', cell(work, tone)], ['占用', busy]]);
const devPanel = (ready: number) => kv('设备', [['待传', `${CONFIG.words - ready} 字`], ['间隔', `${CONFIG.deviceInterval} 拍`]]);

const dataValues = Array.from({ length: CONFIG.words }, (_, index) => CONFIG.source(index));

/** PIO 里挑出每个字的那两拍。 */
const pioEvents: LessonEvent[] = (() => {
  const out: LessonEvent[] = [];
  pio.log.forEach((item) => {
    const match = /(读设备数据|写内存) #(\d+)/.exec(item.action);
    if (!match) return;
    const index = Number(match[2]);
    const value = dataValues[index];
    const strip = busStrip(pio.log, item.cycle, '程序控制 I/O 的总线占用（C = CPU）');
    out.push(probe({ strip }));
    if (match[1] === '读设备数据') {
      out.push(pk('core0', 'bus', 'blue', `读设备 #${index}`, [hx(0x10000000)], [item.cycle, 'BUS', `CPU 发 lw，读设备数据寄存器，第 ${index} 个字`, 4, 'PIO'],
        wire('CPU 占用总线读 MMIO', 'regs', 'model', registers('地址', [['设备数据寄存器', 0x10000000, '地址是示例。', { example: true }]], 'blue')), { quick: true }));
      out.push(pk('device', 'bus', 'teal', `数据 #${index}`, [hx(value)], [item.cycle, 'DATA', `设备把第 ${index} 个字放上总线，CPU 读到 ${hx(value)}`, 4, 'PIO'],
        wire('设备的数据寄存器（MMIO）', 'regs', 'model', registers('读到', [['rd', value]], 'teal')), { quick: true }));
    } else {
      out.push(pk('bus', 'dram', 'amber', `写 #${index}`, [hx(CONFIG.destination + index * 4)], [item.cycle, 'BUS', `CPU 发 sw，写内存 ${hx(CONFIG.destination + index * 4)} = ${hx(value)}`, 4, 'PIO'],
        wire('CPU 执行 sw', 'regs', 'model', registers('写内存', [[hx(CONFIG.destination + index * 4), value]], 'amber')), { quick: true }));
      out.push(probe({ dram: memPanel(index + 1, dataValues), device: devPanel(index + 1) }, 350));
    }
  });
  return out;
})();

const DMA_STRIP = 'DMA 的总线占用（C = CPU，D = DMA，红色表示 CPU 同时被挡）';

const setupNames: Array<[string, number, string]> = [
  ['SRC', 0x10000000, '设备 FIFO 的地址'],
  ['DST', CONFIG.destination, '内存缓冲区地址'],
  ['LEN', CONFIG.words, '字数'],
  ['CTRL', 1, '启动位'],
];

const setupEvents: LessonEvent[] = setupNames.flatMap(([name, value, text], index): LessonEvent[] => [
  probe({ strip: busStrip(dma.log, dma.log[index].cycle, DMA_STRIP) }),
  pk('core0', 'dma', 'blue', name, [hx(value)], [dma.log[index].cycle, 'BUS', `CPU 写 DMA 的 ${name} 寄存器 = ${hx(value)}：${text}`, 4, 'DMA'],
    wire('通过 MMIO 写 DMA 控制器（寄存器布局是示例）', 'regs', 'model', registers('DMA 寄存器', [[name, value, text, { example: true }]], 'blue')), { quick: true }),
  probe({
    dma: dmaRegs(index >= 0 ? hx(setupNames[0][1]) : '—', index >= 1 ? hx(setupNames[1][1]) : '—', index >= 2 ? String(setupNames[2][1]) : '—', index >= 3 ? '运行中' : '—'),
  }, 280),
]);

const dmaWrites = dma.log.filter((item) => item.owner === 'DMA');
const firstConflict = dma.log.find((item) => item.waiting);

const stealEvents = (from: number, to: number): LessonEvent[] => dmaWrites.slice(from, to).flatMap((item, offset): LessonEvent[] => {
  const index = from + offset;
  const value = dataValues[index];
  return [
    probe({ strip: busStrip(dma.log, item.cycle - 1, DMA_STRIP) }),
    pk('device', 'dma', 'teal', `字 ${index}`, [hx(value)], [item.cycle - 1, 'DATA', `设备准备好第 ${index} 个字，向 DMA 发请求`, 4, 'DMA'],
      wire('设备到 DMA 的请求线', 'regs', 'model', registers('设备数据', [['FIFO', value]], 'teal')), { quick: true }),
    probe({ strip: busStrip(dma.log, item.cycle, DMA_STRIP) }),
    pk('dma', 'bus', 'amber', '申请总线', [item.waiting ? 'CPU 被挡' : '空闲'], [item.cycle, 'BUS', item.waiting ? `第 ${item.cycle} 拍：DMA 和 CPU 同时要总线，DMA 优先，CPU 顺延一拍` : `第 ${item.cycle} 拍：DMA 拿到总线`, null, 'DMA'],
      wire('总线仲裁', 'regs', 'model', concept('仲裁结果', [['请求者', item.waiting ? 'DMA、CPU' : 'DMA'], ['赢家', 'DMA', '固定优先级：设备的 FIFO 满了会丢数据，所以让 DMA 先走。'], ['CPU', item.waiting ? '顺延一拍' : '没有请求']], 'amber')), { quick: true, locked: true }),
    pk('bus', 'dram', 'green', '写内存', [hx(CONFIG.destination + index * 4)], [item.cycle, 'BUS', `DMA 把第 ${index} 个字写到 ${hx(CONFIG.destination + index * 4)}`, 4, 'DMA'],
      wire('总线上的一次写', 'regs', 'model', registers('写内存', [[hx(CONFIG.destination + index * 4), value]], 'green')), { quick: true }),
    probe({
      dma: dmaRegs(hx(setupNames[0][1]), hx(setupNames[1][1] + (index + 1) * 4), String(CONFIG.words - index - 1), index === CONFIG.words - 1 ? '完成' : '运行中'),
      dram: memPanel(index + 1, dataValues),
      device: devPanel(index + 1),
      core0: cpuPanel(item.waiting ? '等总线' : '算别的', item.waiting ? 'red' : 'green', `被挡 ${dma.log.slice(0, item.cycle).filter((c) => c.waiting).length} 拍`),
    }, 500),
  ];
});

export const dmaLesson: Lesson = {
  id: 'dma',
  name: 'DMA',
  title: '总线与 DMA',
  group: 'memio',
  layer: [3, 4],
  clock: 'cycle',
  nodes: ['core0', 'bus', 'dram', 'device', 'dma'],
  place: { core0: [120, 235], dram: [700, 275], bus: [410, 365], device: [700, 470], dma: [130, 470] },
  labels: {
    core0: ['CPU', ''],
    dram: ['内存', ''],
    bus: ['系统总线', '每拍只有一个主设备'],
    device: ['网卡', '示例设备'],
    dma: ['DMA 控制器', ''],
  },
  panels: { strip: [145, 0], core0: [10, 100], dram: [625, 90], device: [620, 555], dma: [30, 555] },
  main: ['strip'],
  strip: ['strip', ['core0', 'dma', 'device', 'dram']],
  initial: {
    strip: busStrip(pio.log, 0, '总线占用'),
    core0: cpuPanel('空闲', 'blue', '—'),
    dram: memPanel(0),
    device: devPanel(0),
    dma: dmaRegs('—', '—', '—', '—'),
  },
  start: ['core0', 'bus', 'dram', 'device'],
  legend: [['blue', 'CPU 操作'], ['teal', '设备数据'], ['amber', '仲裁'], ['green', '写内存'], [null, 'PIO、DMA 两次运行各自计周期']],
  overview: {
    full: '让设备自己把数据搬进内存',
    description: '网卡收到数据后要放进内存。可以让 CPU 一个字一个字地搬，也可以让 DMA 控制器代劳。这一课用周期级的总线模型跑同一次传输：每拍谁占总线、CPU 有没有被挡住、内存什么时候写入，都由仲裁规则算出来。',
    facts: [
      ['传输量', `${CONFIG.words} 个字 E.G.`],
      ['设备速度', `每 ${CONFIG.deviceInterval} 拍一个字 E.G.`],
      ['PIO', `${pio.totalCycles} 拍，CPU 全程占用`],
      ['DMA', `${dma.totalCycles} 拍，CPU 只忙 ${dma.cpuTransferCycles} 拍`],
      ['仲裁', 'DMA 优先'],
    ],
  },
  steps: [
    {
      title: '程序控制 I/O',
      desc: 'CPU 亲自搬每一个字',
      detail: `最直接的办法：CPU 反复读设备的状态寄存器，准备好了就读数据、写内存。${CONFIG.words} 个字花了 ${pio.totalCycles} 拍，CPU 一拍也没闲着，其中大部分在轮询。设备越慢，浪费越多。`,
      facts: [['总周期', String(pio.totalCycles)], ['CPU 占用', `${pio.cpuTransferCycles} 拍`], ['轮询', `${pio.log.filter((c) => c.action.startsWith('轮询')).length} 拍`], ['能做别的', '0 拍']],
      events: [
        probe({ strip: busStrip(pio.log, 0, '程序控制 I/O 的总线占用（C = CPU）'), core0: cpuPanel('轮询和搬数据', 'red', '100%') }),
        ...pioEvents,
      ],
    },
    {
      title: '编程 DMA',
      desc: '写 4 个寄存器，然后走人',
      detail: `换成 DMA：CPU 把来源、目标、长度写进 DMA 控制器的寄存器，最后写启动位，一共 ${CONFIG.setupWrites} 拍。这些寄存器映射在地址空间里，CPU 用普通的 sw 写它们，叫内存映射 I/O。写完 CPU 就去干别的了。这里的寄存器布局是示例，每种 DMA 控制器都不一样。`,
      facts: [['编程', `${CONFIG.setupWrites} 次 MMIO 写`], ['SRC', hx(setupNames[0][1])], ['DST', hx(setupNames[1][1])], ['LEN', String(setupNames[2][1])]],
      events: [
        show('dma'),
        probe({ dram: memPanel(0), device: devPanel(0), strip: busStrip(dma.log, 0, DMA_STRIP), core0: cpuPanel('编程 DMA', 'blue', `${CONFIG.setupWrites} 拍`) }),
        ...setupEvents,
      ],
    },
    {
      title: '周期窃取',
      desc: 'DMA 一次只借一拍总线',
      detail: `设备每 ${CONFIG.deviceInterval} 拍准备好一个字，DMA 就申请一拍总线写内存。其他时候总线归 CPU 用，CPU 的缓存命中时甚至不需要总线。一个字一个字地穿插进去，这种方式叫周期窃取。`,
      facts: [['第一次写', `第 ${dmaWrites[0].cycle} 拍`], ['每字占用', '1 拍总线'], ['CPU', '继续执行'], ['方式', '周期窃取']],
      events: stealEvents(0, 2),
    },
    {
      title: '仲裁',
      desc: '两个主设备同时要总线',
      detail: firstConflict
        ? `第 ${firstConflict.cycle} 拍 DMA 和 CPU 同时要总线。仲裁器让 DMA 先走，因为设备的 FIFO 满了就会丢数据，而 CPU 晚一拍没有严重后果。CPU 这次访问顺延一拍。整次传输 CPU 被挡了 ${dma.cpuBusWaits} 拍。`
        : `这次传输 DMA 和 CPU 没有撞上。仲裁器的规则是 DMA 优先，因为设备的 FIFO 满了就会丢数据。`,
      facts: [['被挡', `${dma.cpuBusWaits} 拍`], ['优先级', 'DMA > CPU'], ['DMA 占总线', `${dma.dmaBusCycles} 拍`], ['总周期', String(dma.totalCycles)]],
      events: stealEvents(2, CONFIG.words),
    },
    {
      title: '中断通知',
      desc: '搬完了，告诉 CPU',
      detail: `最后一个字写完，DMA 把 LEN 减到 0，在第 ${dma.interruptAt} 拍发中断。CPU 只在开头和结尾各参与一次。还有一个容易忽略的问题：DMA 直接写内存，CPU 缓存里可能还有这块地址的旧数据。要么由硬件嗅探保持一致，要么驱动程序在读之前先让缓存行作废。`,
      facts: [['中断', `第 ${dma.interruptAt} 拍`], ['CPU 可用', `${dma.cpuFreeCycles} / ${dma.totalCycles} 拍`], ['缓存一致性', '硬件嗅探或软件作废'], ['内存', '4 个字都已写入']],
      events: [
        pk('dma', 'core0', 'violet', '中断', ['传输完成'], [dma.interruptAt!, 'IRQ', `DMA 发中断：${CONFIG.words} 个字搬完`, 'sig', 'DMA'],
          wire('中断线', 'regs', 'model', concept('中断', [
            ['来源', 'DMA 控制器'],
            ['含义', '传输完成，缓冲区可以读了'],
            ['接下来', 'CPU 进入中断处理程序，读状态寄存器并清除中断'],
          ], 'violet'))),
        probe({ core0: cpuPanel('处理中断', 'blue', `被挡 ${dma.cpuBusWaits} 拍`), dma: dmaRegs(hx(setupNames[0][1]), hx(setupNames[1][1] + CONFIG.words * 4), '0', '完成') }),
      ],
    },
    {
      title: '算一算',
      desc: `传 ${LONG.words} 个字的对比`,
      detail: `把传输量放大到 ${LONG.words} 个字再跑一遍模型：程序控制 I/O 要 ${pioLong.totalCycles} 拍，CPU 全部占用；DMA 要 ${dmaLong.totalCycles} 拍，CPU 只花 ${dmaLong.cpuTransferCycles} 拍编程，被挡 ${dmaLong.cpuBusWaits} 拍，其余都能干别的。真实设备通常成批突发传输，并用描述符环一次提交多段缓冲区，比这个模型高效得多。`,
      facts: [['PIO 总周期', String(pioLong.totalCycles)], ['DMA 总周期', String(dmaLong.totalCycles)], ['CPU 可用', `${((dmaLong.cpuFreeCycles / dmaLong.totalCycles) * 100).toFixed(1)}%`], ['真实设备', '描述符环和突发传输']],
      events: [
        probe({ strip: grid(`传 ${LONG.words} 个字（模型算出）`, [['', 110], ['总周期', 70], ['CPU 占用', 80], ['CPU 被挡', 80], ['CPU 可用', 80]], [
          ['程序控制 I/O', String(pioLong.totalCycles), cell(`${pioLong.cpuTransferCycles} 拍`, 'red'), '0 拍', cell('0%', 'red')],
          [on('DMA', 'teal'), String(dmaLong.totalCycles), cell(`${dmaLong.cpuTransferCycles} 拍`, 'green'), `${dmaLong.cpuBusWaits} 拍`, cell(`${((dmaLong.cpuFreeCycles / dmaLong.totalCycles) * 100).toFixed(1)}%`, 'green')],
        ]) }, 800),
        pk('core0', 'bus', 'green', '对比', [`CPU 可用 ${((dmaLong.cpuFreeCycles / dmaLong.totalCycles) * 100).toFixed(0)}%`], [dma.interruptAt! + 1, 'CALC', `传 ${LONG.words} 个字：PIO ${pioLong.totalCycles} 拍，DMA ${dmaLong.totalCycles} 拍`, null, 'DMA'],
          wire('模型结果', 'regs', 'model', concept('对比', [
            ['PIO 总周期', String(pioLong.totalCycles)],
            ['DMA 总周期', String(dmaLong.totalCycles)],
            ['DMA 时 CPU 占用', `${dmaLong.cpuTransferCycles} 拍`],
            ['DMA 时 CPU 被挡', `${dmaLong.cpuBusWaits} 拍`],
          ], 'green'))),
      ],
    },
  ],
  outro: {
    title: 'CPU 只负责发号施令',
    desc: '总线、仲裁和中断把它们连在一起',
    text: '从补码的一位进位，到一条指令的 5 个阶段，再到缓存、内存和设备，这 14 课走完了一台计算机的主要部件。每一层都在用更简单的东西搭出更好用的抽象。',
    facts: [['CPU 参与', '开始和结束'], ['全部课程', '14 课'], ['回顾', '可以从 INTEGER 重新看']],
  },
};
