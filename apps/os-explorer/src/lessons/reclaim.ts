import { concept, pfError, pte, registers, swapHeader, swapPte, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const VICTIM = 0x2f3c1n;
const SLOT = 83214n;
const VA = 0x7f3a1c2d5678n;

export const reclaim: Lesson = {
  id: 'reclaim',
  name: 'PAGE REPLACEMENT',
  title: '页面置换',
  group: 'memory',
  layer: [4, 4],
  timeUnit: 'ms',
  nodes: ['kernel', 'k2', 'app', 'mmu', 'ram', 'disk'],
  place: { kernel: [130, 170], k2: [440, 70], app: [130, 500], mmu: [420, 390], ram: [760, 180], disk: [800, 510] },
  labels: {
    kernel: ['内核', '分配路径'],
    k2: ['kswapd', '后台回收线程'],
    app: ['用户进程', '页面被换出后再次访问'],
    mmu: ['MMU', 'TLB'],
    ram: ['物理内存', '可用页不足'],
    disk: ['swap 分区', '或 zram、zswap'],
  },
  start: ['kernel', 'k2', 'ram'],
  legend: [['amber', '水位与扫描'], ['violet', '解除映射'], ['teal', '磁盘 I/O'], ['blue', '缺页'], ['green', '重新映射']],
  overview: {
    full: '内存不足时选哪些页腾出来',
    description: '物理内存总会被用满：空闲内存本来就是浪费，内核会拿它做缓存。可用页低于水位时，kswapd 开始回收。文件页如果是干净的，可以直接丢弃；匿名页没有后备文件，只能写到 swap。Linux 用的不是教科书里的纯 LRU，而是活跃和非活跃两组链表，也可选 MGLRU。',
    facts: [
      ['平台', 'Linux 6.12'],
      ['后台回收', 'kswapd'],
      ['直接回收', '分配时内存极低时才发生'],
      ['干净文件页', '直接丢弃，不写盘'],
      ['匿名页', '写入 swap'],
      ['老化算法', '活跃/非活跃链表，可选 MGLRU'],
    ],
  },
  steps: [
    {
      title: '水位过低',
      desc: '可用页低于 low 水位，唤醒 kswapd',
      detail: '每个内存区域有三条水位线：min、low、high。分配时如果可用页低于 low，内核唤醒 kswapd 在后台回收，分配本身继续进行。kswapd 一直工作到可用页回到 high。要是降到 min 以下，分配者只能自己动手做直接回收，这时程序就会明显卡顿。',
      facts: [['低于 low', '唤醒 kswapd'], ['回到 high', 'kswapd 停止'], ['低于 min', '直接回收，会卡顿']],
      events: [
        state('ram', { 可用: '低于 low' }),
        pk('kernel', 'k2', 'amber', '唤醒 kswapd', ['free < low'], [0, 'SCHED', 'wakeup_kswapd：可用页低于 low 水位', null],
          wire('zone 水位的数值由 min_free_kbytes 算出，这里是示意', 'regs', '示意', concept('水位线（页）', [
            ['high', '18,000', 'kswapd 回收到这里就停。'],
            ['low', '15,000', '低于它就唤醒 kswapd。'],
            ['min', '12,000', '低于它，分配者要自己做直接回收。'],
            ['当前可用', '14,200', '已经低于 low。'],
          ], 'amber'))),
      ],
    },
    {
      title: '老化',
      desc: '扫描链表，清 A 位看谁还在用',
      detail: 'kswapd 从非活跃链表尾部挑页面。要知道一页最近有没有被用，就看 PTE 的 A 位，这是 MMU 访问时自动设置的。内核清掉 A 位，下次再看：又变成 1 说明还在用，放回活跃链表；还是 0 就可以回收。这一课的目标是一个匿名页。',
      facts: [['候选来源', '非活跃链表'], ['A = 1', '最近用过，有机会留下'], ['A = 0', '可回收'], ['备选', 'CONFIG_LRU_GEN（MGLRU）']],
      events: [
        pk('k2', 'ram', 'amber', '检查 A 位', ['folio_referenced'], [2000000, 'MEM', '通过反向映射找到 PTE，读取并清除 A 位', 8],
          wire('被选中的页面，它的 A 位已经是 0', 'mem', 'abi', pte('候选页的 PTE', { p: true, rw: true, us: true, d: true, nx: true, pfn: VICTIM }))),
        note('k2', '最近没有被访问，回收它', 'amber'),
      ],
    },
    {
      title: '替换 PTE',
      desc: '先解除映射，换成 swap 项',
      detail: '匿名页先被加入交换缓存（add_to_swap），分配一个 swap 槽位。然后 try_to_unmap 把 PTE 换成 swap 项：P=0，其余位记下 swap 区编号和偏移，偏移按位取反后存放以缓解 L1TF。TLB 也要刷新，否则旧翻译还能继续访问这一页。先解除映射，才能安全地写盘。',
      facts: [['顺序', 'add_to_swap → try_to_unmap → pageout'], ['新 PTE', 'P = 0，存 swap 位置'], ['TLB', '必须刷新']],
      events: [
        show('mmu'),
        pk('k2', 'ram', 'violet', '写 swap PTE', ['P = 0'], [3000000, 'MEM', 'try_to_unmap：PTE 换成 swap 项', 8],
          wire('位布局来自 arch/x86/include/asm/pgtable_64.h', 'mem', 'internal', swapPte(0, SLOT))),
        pk('k2', 'mmu', 'violet', '刷新 TLB', [hex(VA & ~0xfffn)], [3000000, 'MMIO', '作废这一页的旧翻译', null],
          wire('刷新', 'regs', 'abi', registers('invlpg 的操作数', [['VA', VA & ~0xfffn, '这一页的虚拟地址。', { example: true }]], 'violet')), { locked: true }),
        state('mmu', { TLB: '已作废' }),
      ],
    },
    {
      title: '写入 swap',
      desc: '页面写盘，然后释放',
      detail: 'pageout 把这个脏页写到 swap 槽。写完成之后物理页才能释放，归还给伙伴系统。如果页面原本是干净的文件页，这一步根本不需要，直接丢弃，要用时再从文件读。很多系统用 zram 或 zswap，把页面压缩后留在内存，就不需要真正写盘了。',
      facts: [['写入', '4 KiB'], ['槽位', String(SLOT)], ['干净文件页', '不写，直接丢弃'], ['zram/zswap', '压缩留在内存']],
      events: [
        show('disk'),
        pk('ram', 'disk', 'teal', '写 swap 槽', [`槽位 ${SLOT}`], [4000000, 'BIO', 'pageout：把脏页写入 swap', 4096],
          wire('swap 区第 0 页的头部，mkswap 时写入。数据页本身是用户内容，这里不展示', 'mem', 'internal', swapHeader(4194303))),
        state('ram', { 可用: '+1 页' }),
      ],
    },
    {
      title: '换入',
      desc: '缺页，查缓存，预读，重新映射',
      detail: '进程再次访问这一页，PTE 的 P=0，触发 #PF。内核发现 PTE 不全为 0，是 swap 项。先查交换缓存，不在就从磁盘读，通常还会预读相邻的页。读完后重新建立映射，进程继续运行。这是硬缺页，要等磁盘，所以比软缺页慢几个数量级。swap 槽位可能会保留，这样页面再次被换出时如果没改过就不用写了。',
      facts: [['错误码', '0x04（用户读，不存在）'], ['查找顺序', '交换缓存，然后磁盘'], ['预读', '相邻页面一起读'], ['耗时', '毫秒级，取决于磁盘']],
      events: [
        show('app'),
        pk('app', 'mmu', 'blue', '读', [hex(VA)], [800000000, 'SW', '访问已被换出的页面', 'reg'],
          wire('用户访问', 'regs', 'abi', registers('操作数', [['VA', VA, '这一页目前不在内存。', { example: true }]], 'blue')), { quick: true }),
        pk('mmu', 'kernel', 'blue', '#PF', ['err = 0x04'], [800000000, 'EXC', '缺页：do_swap_page', 'reg'],
          wire('错误码和上一课不同：这次是读访问', 'regs', 'abi', registers('异常信息', [
            ['CR2', VA, '出错的虚拟地址。'],
            ...pfError(0x04),
          ], 'blue')), { locked: true }),
        pk('disk', 'ram', 'teal', '读 swap 槽', ['含预读'], [801000000, 'BIO', '从 swap 读回这一页和相邻页', 32768],
          wire('swapin_readahead 会把相邻页面一起读入。页面内容是用户数据', 'regs', '示意', concept('换入', [
            ['目标槽位', String(SLOT), '来自 PTE 中的 swap 项。'],
            ['预读', '最多 2^page-cluster 页', '默认 8 页，共 32 KiB。'],
          ], 'teal'))),
        pk('kernel', 'ram', 'green', '重新映射', ['P = 1'], [805000000, 'MEM', '写回有效 PTE', 8],
          wire('PTE 恢复有效，通常已是另一个页框', 'mem', 'abi', pte('PTE（换入后）', { p: true, rw: true, us: true, a: true, nx: true, pfn: 0x52e18n }))),
        state('mmu', { TLB: '重新填充' }),
        render,
      ],
    },
  ],
  outro: {
    title: '选错了就要付出代价',
    desc: '回收的核心是猜下一个要用的页',
    text: '猜错的代价是一次磁盘读取，比内存访问慢上千到上百万倍。如果一直猜错，系统就会把时间都花在换入换出上，这就是抖动。没有 swap 时匿名页无法回收，内存耗尽就只能靠 OOM killer 杀进程。',
    facts: [['抖动', '工作集大于物理内存'], ['没有 swap', '匿名页回收不了'], ['下一课', 'FILE READ']],
  },
};
