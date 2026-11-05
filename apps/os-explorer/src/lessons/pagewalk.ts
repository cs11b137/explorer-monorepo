import { concept, cr3Register, pte, registers, vaIndexes, virtualAddress, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { note, pk, show, showIn, state } from './dsl';
import type { Lesson } from './types';

const VA = 0x00007f3a1c2d5678n;
const [I4, I3, I2, I1] = vaIndexes(VA);
const CR3 = 0x1a2b3000n;
const PDPT = 0x1a2b4000n;
const PD = 0x1a2b5000n;
const PT = 0x1a2b6000n;
const FRAME = 0x2f3c1000n;
const PA = FRAME + (VA & 0xfffn);
const pfn = (address: bigint) => address >> 12n;

export const pagewalk: Lesson = {
  id: 'pagewalk',
  name: 'PAGE WALK',
  title: '地址翻译',
  group: 'memory',
  layer: [1, 1],
  timeUnit: 'ns',
  nodes: ['app', 'cpu', 'mmu', 'pml4', 'pdpt', 'pd', 'pt', 'ram'],
  place: {
    app: [120, 430],
    cpu: [320, 230],
    mmu: [560, 370],
    pml4: [560, 90],
    pdpt: [760, 130],
    pd: [900, 280],
    pt: [900, 460],
    ram: [640, 590],
  },
  labels: {
    app: ['用户进程', '读一个变量'],
    cpu: ['CPU', '执行 mov'],
    mmu: ['MMU + TLB', '硬件遍历器'],
    pml4: ['PML4', '第 4 级'],
    pdpt: ['PDPT', '第 3 级'],
    pd: ['PD', '第 2 级'],
    pt: ['PT', '第 1 级'],
    ram: ['物理内存', hex(PA)],
  },
  start: ['app', 'cpu'],
  legend: [['blue', '翻译请求'], ['amber', '读页表项'], ['violet', '硬件置位'], ['green', '访问数据'], [null, '未命中时的最长路径']],
  overview: {
    full: '虚拟地址到物理地址的 4 级翻译',
    description: '程序看到的都是虚拟地址。每次访问内存，MMU 都要把它翻译成物理地址：先查 TLB，没有就从 CR3 开始逐级读 4 张页表。这一课跟踪一个 TLB 未命中的读操作，每一级都能打开看 64 位表项的每一位。',
    facts: [
      ['平台', 'x86-64，4 级分页'],
      ['地址宽度', '48 位虚拟地址'],
      ['拆分', '9 + 9 + 9 + 9 + 12'],
      ['页大小', '4 KiB（可有 2 MiB、1 GiB 大页）'],
      ['每级表', '512 项，每项 8 字节'],
      ['执行者', 'MMU 硬件，不经过内核'],
    ],
  },
  steps: [
    {
      title: '拆分地址',
      desc: '48 位地址按 9/9/9/9/12 切开',
      detail: `程序读 ${hex(VA)}。高 16 位只是符号扩展，低 48 位被切成 5 段：4 段各 9 位，分别是 4 级页表的索引；最后 12 位是页内偏移，翻译时原样保留。`,
      facts: [['PML4 索引', String(I4)], ['PDPT 索引', String(I3)], ['PD 索引', String(I2)], ['PT 索引', String(I1)], ['页内偏移', hex(VA & 0xfffn)]],
      events: [
        pk('app', 'cpu', 'blue', 'mov rax, [addr]', [hex(VA)], [0, 'SW', `读取虚拟地址 ${hex(VA)}`, 'reg'],
          wire('用户程序的一条读指令', 'regs', 'abi', registers('指令的操作数', [['VA', VA, '程序只知道虚拟地址。']], 'blue')), { quick: true }),
        show('mmu'),
        pk('cpu', 'mmu', 'blue', '翻译请求', [hex(VA)], [1, 'MEM', '把虚拟地址交给 MMU', 'reg'],
          wire('CPU 的地址翻译单元', 'regs', 'abi', virtualAddress(VA))),
      ],
    },
    {
      title: 'TLB 未命中',
      desc: '缓存里没有，从 CR3 开始遍历',
      detail: 'MMU 先查 TLB，这是最近翻译结果的缓存。这次没有找到，只好遍历页表。起点是 CR3，里面存着当前进程顶级页表的物理地址。TLB 未命中不是故障：全程由硬件完成，内核完全不知道。',
      facts: [['TLB 结果', '未命中'], ['是否进入内核', '否'], ['起点', 'CR3']],
      events: [
        state('mmu', { TLB: '未命中' }),
        note('mmu', 'TLB 未命中，开始遍历', 'amber'),
        pk('cpu', 'mmu', 'slate', 'CR3', [hex(CR3)], [3, 'MEM', '取顶级页表的物理地址', 'reg'],
          wire('当前进程的页表根', 'regs', 'abi', registers('控制寄存器', [cr3Register(CR3, 5)], 'slate'))),
      ],
    },
    {
      title: '逐级读表',
      desc: '读 4 次内存，每级给出下一级地址',
      detail: '每一级的索引乘以 8，加上表的基址，就是表项的物理地址。表项里的页框号指向下一张表。这 4 次都是物理内存读取，所以遍历很慢；实际硬件通常有页结构缓存，能跳过上面几级，读到的表项也多半已在 CPU 缓存里。',
      facts: [['读取次数', '最多 4 次'], ['表项大小', '8 字节'], ['权限检查', '每一级都检查 P、RW、US、NX']],
      events: [
        showIn(['mmu', 'pml4', 'pdpt', 'pd', 'pt'], 'pml4', 'pdpt', 'pd', 'pt'),
        pk('mmu', 'pml4', 'amber', '读 PML4E', [`索引 ${I4}`], [8, 'MEM', `读 ${hex(CR3 + I4 * 8n)}`, 8],
          wire('第 4 级页表', 'mem', 'abi', pte(`PML4 表项 #${I4}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PDPT) }, { level: 'PML4E', entryAddress: CR3 + I4 * 8n, pfnLabel: '下一级表的页框号' })), { quick: true }),
        pk('pml4', 'mmu', 'amber', '下一级地址', [hex(PDPT)], [14, 'MEM', `PDPT 在 ${hex(PDPT)}`, 8],
          wire('第 4 级页表', 'mem', 'abi', pte(`PML4 表项 #${I4}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PDPT) }, { level: 'PML4E', entryAddress: CR3 + I4 * 8n, pfnLabel: '下一级表的页框号' })), { quick: true }),
        pk('mmu', 'pdpt', 'amber', '读 PDPTE', [`索引 ${I3}`], [20, 'MEM', `读 ${hex(PDPT + I3 * 8n)}`, 8],
          wire('第 3 级页表', 'mem', 'abi', pte(`PDPT 表项 #${I3}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PD) }, { level: 'PDPTE', entryAddress: PDPT + I3 * 8n, pfnLabel: '下一级表的页框号' })), { quick: true }),
        pk('pdpt', 'mmu', 'amber', '下一级地址', [hex(PD)], [26, 'MEM', `PD 在 ${hex(PD)}`, 8],
          wire('第 3 级页表', 'mem', 'abi', pte(`PDPT 表项 #${I3}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PD) }, { level: 'PDPTE', entryAddress: PDPT + I3 * 8n, pfnLabel: '下一级表的页框号' })), { quick: true }),
        pk('mmu', 'pd', 'amber', '读 PDE', [`索引 ${I2}`], [32, 'MEM', `读 ${hex(PD + I2 * 8n)}`, 8],
          wire('第 2 级页表', 'mem', 'abi', pte(`PD 表项 #${I2}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PT) }, { level: 'PDE', entryAddress: PD + I2 * 8n, pfnLabel: '下一级表的页框号' })), { quick: true }),
        pk('pd', 'mmu', 'amber', '下一级地址', [hex(PT)], [38, 'MEM', `PT 在 ${hex(PT)}`, 8],
          wire('第 2 级页表。下面第二张是同样位置的 2 MiB 大页写法，用来对比', 'mem', 'abi',
            pte(`PD 表项 #${I2}`, { p: true, rw: true, us: true, a: true, pfn: pfn(PT) }, { level: 'PDE', entryAddress: PD + I2 * 8n, pfnLabel: '下一级表的页框号' }),
            pte('对比：2 MiB 大页的 PDE', { p: true, rw: true, us: true, a: true, d: true, ps: true, nx: true, pfn: 0x2f200n }, { level: 'PDE', color: 'slate', pfnLabel: '大页的页框号（低 9 位须为 0）' })), { quick: true }),
        pk('mmu', 'pt', 'amber', '读 PTE', [`索引 ${I1}`], [44, 'MEM', `读 ${hex(PT + I1 * 8n)}`, 8],
          wire('第 1 级页表', 'mem', 'abi', pte(`PT 表项 #${I1}`, { p: true, rw: true, us: true, nx: true, pfn: pfn(FRAME) }, { entryAddress: PT + I1 * 8n })), { quick: true }),
        pk('pt', 'mmu', 'amber', '页框地址', [hex(FRAME)], [50, 'MEM', `页框在 ${hex(FRAME)}`, 8],
          wire('第 1 级页表：这里 A 位还是 0', 'mem', 'abi', pte(`PT 表项 #${I1}`, { p: true, rw: true, us: true, nx: true, pfn: pfn(FRAME) }, { entryAddress: PT + I1 * 8n })), { quick: true }),
      ],
    },
    {
      title: '置位',
      desc: '硬件原子地设置 A 位',
      detail: '遍历成功后，MMU 自己把叶子项的 A（访问）位写回内存，这是一次原子写。如果这次是写操作，还会同时设置 D（脏）位。这些位不是内核设置的；内核回收内存时会来读它们，判断页面是否活跃、是否需要写回。',
      facts: [['设置者', 'MMU 硬件'], ['A 位', '读写都设置'], ['D 位', '只有写才设置，且只在叶子项']],
      events: [
        pk('mmu', 'pt', 'violet', '置 A 位', ['bit 5 = 1'], [56, 'MEM', '原子设置 PTE.A', 8],
          wire('硬件写回后的 PTE', 'mem', 'abi', pte(`PT 表项 #${I1}（写回后）`, { p: true, rw: true, us: true, a: true, nx: true, pfn: pfn(FRAME) }, { entryAddress: PT + I1 * 8n, color: 'violet' })), { locked: true }),
      ],
    },
    {
      title: '填 TLB',
      desc: '缓存结果，然后访问物理内存',
      detail: `页框号拼上页内偏移，得到物理地址 ${hex(PA)}。结果存进 TLB，下次访问同一页时不必再遍历。如果这个进程配了 PCID，切换进程后这条缓存还能保留。`,
      facts: [['物理地址', hex(PA)], ['TLB', '已缓存这一页'], ['同页再访问', '不用再读页表']],
      events: [
        state('mmu', { TLB: '已缓存', 物理页: hex(FRAME) }),
        show('ram'),
        pk('mmu', 'ram', 'green', '读数据', [hex(PA)], [62, 'MEM', `读物理地址 ${hex(PA)}`, 8],
          wire('翻译结束，访问真正的数据', 'regs', 'abi', concept('翻译结果', [
            ['页框基址', hex(FRAME), '来自 PTE 的位 12–51。'],
            ['页内偏移', hex(VA & 0xfffn), '来自虚拟地址低 12 位。'],
            ['物理地址', hex(PA), '两者相加。'],
          ], 'green'))),
        pk('ram', 'cpu', 'green', '数据返回', ['rax = 值'], [120, 'MEM', '数据送回 CPU', 8],
          wire('程序内存', 'regs', 'abi', registers('读取结果', [['rax', 0x2a, '假设这个变量的值是 42。', { example: true }]], 'green'))),
      ],
    },
  ],
  outro: {
    title: '四次读取换一个地址',
    desc: '所以 TLB 决定了内存访问的快慢',
    text: '没有 TLB 时，每次内存访问都要多读 4 次内存。TLB 让绝大多数访问根本不用遍历页表。这也是切换进程会变慢的原因之一：新进程的 TLB 要重新填，PCID 就是为了缓解这个问题。',
    facts: [['最坏情况', '4 次额外内存读取'], ['遍历者', '硬件'], ['下一课', 'PAGE FAULT']],
  },
};
