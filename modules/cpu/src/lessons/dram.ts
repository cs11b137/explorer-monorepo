import { concept, dramAddressLayer, dramCommandLayer, wire } from '../decode/structures';
import { DramBankModel, splitDramAddress, type DramAccess, type DramGeometry, type DramTiming } from '../sim/dram';
import { pk, probe, show } from './dsl';
import type { CellLike, GridWidget, Tone } from '../scene/widgets';
import type { Lesson, LessonEvent } from './types';
import { bitsPanel, cell, dim, grid, hx, kv, on } from './views';

/** DDR4-3200AA（22-22-22）。tRAS 32 ns 向上取整成 52 nCK。厂商数据手册的数值，这里作为示例。 */
const TIMING: DramTiming = { tRCD: 22, tCL: 22, tRP: 22, tRAS: 52, burst: 4, tCK: 0.625 };
/** 4Gb x8 芯片：16 个 bank，32K 行，1K 列。8 颗组成 64 位通道上的 4 GiB rank。 */
const GEOMETRY: DramGeometry = { rowBits: 15, bankBits: 4, columnBits: 10, byteBits: 3 };
const T_REFI_NS = 7800;
const T_RFC_NS = 260;

const address = (row: number, bank: number, column: number) => ((row * 2 ** 17) + bank * 2 ** 13 + column * 8) >>> 0;
const ROW_A = 0x1a2b;
const ROW_B = 0x0042;
const BANK = 5;

const model = new DramBankModel(TIMING, GEOMETRY);
const first = model.read(address(ROW_A, BANK, 0x10), 0);
const hit = model.read(address(ROW_A, BANK, 0x18), first.dataEnd);
const conflict = model.read(address(ROW_B, BANK, 0x20), hit.dataEnd + 4);
const ns = (nck: number) => `${(nck * TIMING.tCK).toFixed(nck * TIMING.tCK % 1 ? 2 : 1)} ns`;

const addrBits = (value: number) => {
  const parts = splitDramAddress(value, GEOMETRY);
  return bitsPanel(`物理地址 ${hx(value)}（示例映射）`, value, 32, [
    { name: `行 row = ${parts.row}`, hi: 31, lo: 17, tone: 'amber' },
    { name: 'bank', hi: 16, lo: 13, tone: 'violet' },
    { name: `列 = ${parts.column}`, hi: 12, lo: 3, tone: 'teal' },
    { name: '字节', hi: 2, lo: 0, tone: 'slate' },
  ], `行 ${parts.row}，bank ${parts.bank}，列 ${parts.column}，字节 ${parts.byte}`, 13);
};

interface BankView {
  open: number | null;
  state: string;
  tone: Tone;
}

const bankPanel = ({ open, state, tone }: BankView) => kv(`bank ${BANK}`, [['打开的行', open === null ? dim('无') : cell(String(open), 'amber')], ['行缓冲', open === null ? dim('空') : on(`第 ${open} 行`, 'amber')], ['状态', cell(state, tone)]]);

type TimelineRow = { command: string; at: number; note: string; tone: Tone };

function timeline(title: string, rows: TimelineRow[]): GridWidget {
  const cells: CellLike[][] = rows.map(({ command, at, note: text, tone }) => [on(command, tone), `${at}`, ns(at), text]);
  return grid(title, [['命令', 50], ['nCK', 44], ['时刻', 68], ['说明', 234]], cells.length ? cells : [[dim('—'), dim('—'), dim('—'), dim('—')]]);
}

const toRows = (access: DramAccess, upto = Infinity): TimelineRow[] => {
  const rows: TimelineRow[] = access.commands.map((command) => ({
    command: command.command,
    at: command.cycle,
    note: command.why,
    tone: command.command === 'PRE' ? 'slate' : command.command === 'ACT' ? 'amber' : 'teal',
  }));
  rows.push({ command: 'DATA', at: access.dataStart, note: `CL = ${TIMING.tCL}，然后 ${TIMING.burst} 个时钟传 8 拍`, tone: 'green' });
  return rows.slice(0, upto);
};

const addrWire = (access: DramAccess, at: string, ...more: ReturnType<typeof concept>[]) => wire(at, 'regs', 'model', dramAddressLayer(access.address, access.parts, GEOMETRY), ...more);

function commandEvents(access: DramAccess, title: string, states: BankView[]): LessonEvent[] {
  const out: LessonEvent[] = [];
  const rows = toRows(access);
  access.commands.forEach((command, index) => {
    const rowNumber = command.command === 'PRE' ? command.row : access.parts.row;
    const color = command.command === 'PRE' ? 'slate' : command.command === 'ACT' ? 'amber' : 'teal';
    out.push(pk('memctrl', 'bank', color, command.command, [command.command === 'RD' ? `列 ${command.column}` : `行 ${rowNumber}`], [command.cycle, 'CMD', `${command.command}：${command.why}`, null],
      addrWire(access, `第 ${command.cycle} 个时钟（${ns(command.cycle)}）的命令`, dramCommandLayer(command.command, command.bank, rowNumber, command.column, command.why))));
    out.push(probe({ timing: timeline(title, rows.slice(0, index + 1)), bank: bankPanel(states[index]) }));
  });
  out.push(pk('bank', 'memctrl', 'green', '数据', [`${TIMING.burst} 个时钟`, '8 × 8 字节'], [access.dataStart, 'DATA', `第 ${access.dataStart} 个时钟开始传数据，距请求 ${access.latency} 个时钟（${ns(access.latency)}）`, 64],
    addrWire(access, '数据总线上的一次突发', concept('突发传输', [
      ['BL', '8', '一次固定传 8 拍。'],
      ['每拍', '8 字节（64 位通道）'],
      ['合计', '64 字节，正好一个常见的缓存块大小'],
      ['占用', `${TIMING.burst} 个时钟，上下沿都传`],
    ], 'green'))));
  out.push(probe({ timing: timeline(title, rows) }));
  return out;
}

const REFRESH_PERCENT = (T_RFC_NS / T_REFI_NS) * 100;

export const dramLesson: Lesson = {
  id: 'dram',
  name: 'DRAM',
  title: '行列访问时序',
  group: 'memio',
  layer: [3, 4],
  clock: 'nck',
  nodes: ['core0', 'memctrl', 'bank'],
  place: { core0: [90, 200], memctrl: [380, 200], bank: [690, 200] },
  labels: {
    core0: ['缓存未命中', '要读一块'],
    memctrl: ['内存控制器', '排命令、算时序'],
    bank: ['DRAM bank', '行、列和行缓冲'],
  },
  panels: { addr: [170, 0], bank: [620, 295], timing: [0, 300] },
  main: ['timing'],
  strip: ['addr', 'timing', 'bank'],
  initial: {
    addr: addrBits(first.address),
    bank: bankPanel({ open: null, state: '已预充电', tone: 'slate' }),
    timing: timeline('命令时序', []),
  },
  start: ['core0', 'memctrl'],
  legend: [['amber', '激活行 ACT'], ['teal', '读列 RD'], ['slate', '预充电 PRE'], ['green', '数据'], [null, '时序是 DDR4-3200AA 的示例，模型已简化']],
  overview: {
    full: '同一块内存，访问快慢差 3 倍',
    description: 'DRAM 用电容存位，排成行和列。读之前要把整行读进行缓冲，这一步很慢；行已经在缓冲里时就快得多。这一课按真实的时序约束安排命令，看行未打开、行命中、行冲突三种情况各要多少个时钟。',
    facts: [
      ['示例器件', 'DDR4-3200AA，4Gb x8 E.G.'],
      ['tCK', `${TIMING.tCK} ns E.G.`],
      ['CL-tRCD-tRP', `${TIMING.tCL}-${TIMING.tRCD}-${TIMING.tRP} E.G.`],
      ['tRAS', `${TIMING.tRAS} nCK（32 ns）E.G.`],
      ['组织', '16 bank，32K 行，1K 列'],
      ['模型简化', '只有一个 rank，不含 tRRD、tFAW、写时序'],
    ],
  },
  steps: [
    {
      title: '地址怎么切',
      desc: '行、bank、列',
      detail: `内存控制器把物理地址切成 3 段：行 ${first.parts.row}、bank ${first.parts.bank}、列 ${first.parts.column}。64 位通道一次传 8 字节，低 3 位不上地址线。这里的位段划分是示例，真实控制器常把地址高位哈希进 bank 编号，让冲突更少；它们的映射关系通常不公开。`,
      facts: [['行', `${GEOMETRY.rowBits} 位`], ['bank', `${GEOMETRY.bankBits} 位`], ['列', `${GEOMETRY.columnBits} 位`], ['字节', `${GEOMETRY.byteBits} 位`], ['合计', '4 GiB E.G.']],
      events: [
        pk('core0', 'memctrl', 'blue', '读请求', [hx(first.address)], [0, 'MEM', `缓存未命中，读 ${hx(first.address)}`, 64],
          addrWire(first, '内存控制器收到的物理地址')),
        probe({ addr: addrBits(first.address) }, 800),
      ],
    },
    {
      title: '激活行',
      desc: 'ACT：把整行读到行缓冲',
      detail: `DRAM 的电容很小，读的时候要先预充电位线，再打开这一行的晶体管，让感应放大器慢慢分辨出 0 和 1，这需要 tRCD = ${TIMING.tRCD} 个时钟（${ns(TIMING.tRCD)}）。读取会破坏电容里的电荷，所以感应放大器还要把值写回去，tRAS 就是保证写回完成的最短时间。`,
      facts: [['命令', 'ACT'], ['tRCD', `${TIMING.tRCD} nCK = ${ns(TIMING.tRCD)} E.G.`], ['读取', '会破坏电荷，要写回'], ['tRAS', `${TIMING.tRAS} nCK E.G.`]],
      events: [
        show('bank'),
        ...commandEvents(first, '第 1 次：行未打开', [
          { open: ROW_A, state: 'ACT：感应中', tone: 'amber' },
          { open: ROW_A, state: '行已打开', tone: 'green' },
        ]).slice(0, 2),
      ],
    },
    {
      title: '读列',
      desc: 'RD：从行缓冲里选列，等 CL',
      detail: `行缓冲里已经是这一行的全部内容。RD 命令给出列地址，再过 CL = ${TIMING.tCL} 个时钟，数据开始出现在总线上，一次突发 8 拍。行未打开时，从请求到第一笔数据共 ${first.latency} 个时钟，约 ${ns(first.latency)}。CPU 这时已经过了上百个周期。`,
      facts: [['CL', `${TIMING.tCL} nCK = ${ns(TIMING.tCL)} E.G.`], ['总延迟', `${first.latency} nCK = ${ns(first.latency)}`], ['突发', '8 拍，64 字节'], ['占总线', `${TIMING.burst} 个时钟`]],
      events: commandEvents(first, '第 1 次：行未打开', [
        { open: ROW_A, state: 'ACT：感应中', tone: 'amber' },
        { open: ROW_A, state: '行已打开', tone: 'green' },
      ]).slice(2),
    },
    {
      title: '行命中',
      desc: '同一行：只要 CL',
      detail: `下一个请求落在同一行的另一列。行还开着，不用 ACT，直接 RD，只要 ${hit.latency} 个时钟（${ns(hit.latency)}），是第一次的 1/${(first.latency / hit.latency).toFixed(0)}。所以顺序访问内存很快，连续的地址大多落在同一行。这种保持行打开的做法叫开页策略。`,
      facts: [['结果', '行命中'], ['延迟', `${hit.latency} nCK = ${ns(hit.latency)}`], ['省掉', 'ACT 和 tRCD'], ['策略', '开页']],
      events: [
        probe({ addr: addrBits(hit.address) }),
        pk('core0', 'memctrl', 'blue', '读请求', [hx(hit.address)], [hit.requestAt, 'MEM', `读 ${hx(hit.address)}：还是第 ${hit.parts.row} 行`, 64], addrWire(hit, '同一行的另一列')),
        ...commandEvents(hit, '第 2 次：行命中', [{ open: ROW_A, state: '行已打开', tone: 'green' }]),
      ],
    },
    {
      title: '行冲突',
      desc: '要另一行：先关旧行',
      detail: `这次要第 ${conflict.parts.row} 行，可行缓冲里是第 ${ROW_A} 行，这叫行冲突。必须先 PRE 关掉旧行，让位线回到中间电压，等 tRP = ${TIMING.tRP} 个时钟，再 ACT、tRCD、RD、CL。总共 ${conflict.latency} 个时钟（${ns(conflict.latency)}），是行命中的 ${(conflict.latency / hit.latency).toFixed(0)} 倍。随机访问内存慢，主要就慢在这里。`,
      facts: [['结果', '行冲突'], ['tRP + tRCD + CL', `${TIMING.tRP} + ${TIMING.tRCD} + ${TIMING.tCL}`], ['延迟', `${conflict.latency} nCK = ${ns(conflict.latency)}`], ['PRE 发出', `第 ${conflict.commands[0].cycle} 个时钟`]],
      events: [
        probe({ addr: addrBits(conflict.address) }),
        pk('core0', 'memctrl', 'blue', '读请求', [hx(conflict.address)], [conflict.requestAt, 'MEM', `读 ${hx(conflict.address)}：第 ${conflict.parts.row} 行，和打开的行不同`, 64], addrWire(conflict, '同一 bank 的另一行')),
        ...commandEvents(conflict, '第 3 次：行冲突', [
          { open: null, state: 'PRE：预充电中', tone: 'slate' },
          { open: ROW_B, state: 'ACT：感应中', tone: 'amber' },
          { open: ROW_B, state: '行已打开', tone: 'green' },
        ]),
      ],
    },
    {
      title: '刷新',
      desc: '电容会漏电，要定期重写',
      detail: `DRAM 的 D 是动态的意思：电容会漏电，所以控制器大约每 ${T_REFI_NS / 1000} 微秒发一次 REF，让芯片内部刷新若干行。刷新期间这个 rank 不能访问，要等 tRFC，4Gb 器件约 ${T_RFC_NS} ns（E.G.）。算下来约 ${REFRESH_PERCENT.toFixed(1)}% 的时间花在刷新上，容量越大这个比例越高。`,
      facts: [['tREFI', `${T_REFI_NS / 1000} 微秒 E.G.`], ['tRFC', `${T_RFC_NS} ns E.G.`], ['占用', `${REFRESH_PERCENT.toFixed(1)}%`], ['温度', '超过 85 摄氏度要加倍刷新']],
      events: [
        pk('memctrl', 'bank', 'slate', 'REF', ['刷新'], [conflict.dataEnd + 1, 'CMD', `刷新：约每 ${T_REFI_NS / 1000} 微秒一次，每次占用 ${T_RFC_NS} ns（E.G.）`, null],
          wire('定期刷新', 'regs', 'model', concept('DDR4 命令 · REF', [
            ['引脚电平', 'CS_n=L ACT_n=H RAS_n=L CAS_n=L WE_n=H'],
            ['前提', '所有 bank 已预充电'],
            ['tREFI', `${T_REFI_NS} ns`],
            ['tRFC', `${T_RFC_NS} ns`, '4Gb 器件的数据手册值。'],
            ['时间占比', `${T_RFC_NS} / ${T_REFI_NS} = ${REFRESH_PERCENT.toFixed(1)}%`],
          ], 'slate'))),
        probe({ bank: bankPanel({ open: null, state: 'REF：刷新中', tone: 'slate' }) }),
      ],
    },
  ],
  outro: {
    title: '行缓冲是 DRAM 的缓存',
    desc: '局部性又一次决定了速度',
    text: `同样读 64 字节：行命中 ${ns(hit.latency)}，行未打开 ${ns(first.latency)}，行冲突 ${ns(conflict.latency)}。这还只是到第一笔数据的时间，再加上控制器排队，就是 CPU 看到的几十到上百纳秒。`,
    facts: [['行命中', ns(hit.latency)], ['行未打开', ns(first.latency)], ['行冲突', ns(conflict.latency)], ['下一课', 'DMA']],
  },
};
