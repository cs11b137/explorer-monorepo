import { concept, pfError, pte, registers, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { camera, note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const SHARED = 0x2f3c1n;
const COPY = 0x41d07n;
const VA = 0x7f3a1c2d5000n;

export const cow: Lesson = {
  id: 'cow',
  name: 'COW',
  title: '写时复制',
  group: 'memory',
  layer: [4, 4],
  timeUnit: 'µs',
  nodes: ['app', 'proc2', 'cpu', 'cpu2', 'mmu', 'kernel', 'ram'],
  place: { app: [120, 150], proc2: [120, 500], cpu: [800, 110], cpu2: [370, 590], mmu: [400, 280], kernel: [650, 430], ram: [930, 370] },
  labels: {
    app: ['父进程', '暂时没有写'],
    proc2: ['子进程', '即将写入'],
    cpu: ['CPU 0', '运行子进程的另一线程'],
    cpu2: ['CPU 1', '运行子进程'],
    mmu: ['MMU', '翻译与权限检查'],
    kernel: ['内核', 'do_wp_page'],
    ram: ['物理内存', `共享页 ${hex(SHARED)}`],
  },
  start: ['app', 'proc2', 'kernel', 'ram'],
  legend: [['slate', '共享状态'], ['green', '正常访问'], ['violet', '写保护异常'], ['amber', '复制'], ['teal', 'TLB 刷新']],
  overview: {
    full: 'Copy-on-Write，真正要写时才复制',
    description: 'fork 之后，父子进程共用同样的物理页，双方的 PTE 都是只读。读取畅通无阻。谁先写，谁就触发 #PF，内核这时才复制一页。页表里并没有所谓的 COW 位，内核靠「VMA 允许写而 PTE 只读」这个矛盾来判断。',
    facts: [
      ['平台', 'Linux 6.12，x86-64'],
      ['触发', '写只读页，错误码 0x07'],
      ['判断依据', 'VMA 可写 + PTE 只读'],
      ['COW 位', '不存在'],
      ['处理函数', 'do_wp_page'],
      ['独占时', '直接复用，不复制'],
    ],
  },
  steps: [
    {
      title: 'fork 后共享',
      desc: '父子的 PTE 指向同一页，都是只读',
      detail: 'fork 时内核把这个私有可写页的 PTE 复制给子进程，并清掉双方的 RW 位，同时增加物理页的引用计数。此刻两个进程读到的数据一模一样，物理内存只有一份。RW 位被清掉，但 VMA 仍然标记为可写，这个差异就是后面判断 COW 的依据。',
      facts: [['物理页', '1 份'], ['RW 位', '双方都是 0'], ['VMA', '仍可写'], ['引用计数', '2']],
      events: [
        pk('kernel', 'ram', 'slate', '共享 PTE', ['RW = 0'], [0, 'MEM', 'copy_page_range：父子 PTE 都写保护', 8],
          wire('父子两个 PTE，内容完全相同', 'mem', 'abi',
            pte('父进程 PTE', { p: true, us: true, a: true, nx: true, pfn: SHARED }),
            pte('子进程 PTE', { p: true, us: true, a: true, nx: true, pfn: SHARED }, { color: 'violet' }))),
        state('ram', { 引用: '2', 权限: '只读共享' }),
      ],
    },
    {
      title: '读正常',
      desc: '读访问不受影响',
      detail: '只读 PTE 完全满足读操作，所以无论父进程还是子进程读这一页，都不会有任何异常，MMU 也不需要内核介入。如果一个进程 fork 之后马上 exec，或者只读取数据，就完全没有复制的开销。这正是写时复制划算的原因。',
      facts: [['读访问', '不触发缺页'], ['fork 后立刻 exec', '不发生复制']],
      events: [
        show('mmu'),
        pk('proc2', 'mmu', 'green', '读', [hex(VA + 0x678n)], [40000, 'MEM', '子进程读共享页', 8],
          wire('读操作的翻译', 'regs', 'abi', concept('MMU 检查', [
            ['P', '1', '页存在。'],
            ['权限', '读访问不要求 RW 位', '检查通过。'],
          ], 'green')), { quick: true }),
        pk('mmu', 'ram', 'green', '读共享页', [hex(SHARED << 12n)], [41000, 'MEM', '直接访问共享物理页', 8],
          wire('物理地址', 'regs', 'abi', concept('翻译结果', [['页框', hex(SHARED), '父子进程共用。']], 'green')), { quick: true }),
      ],
    },
    {
      title: '写触发',
      desc: '写只读页，错误码 0x07',
      detail: '子进程写这一页。PTE 存在但 RW=0，所以 MMU 触发 #PF。错误码是 0x07：P=1（页存在，是权限问题）、W=1（写访问）、U=1（用户态）。P=1 正是和上一课缺页的区别。内核查 VMA，发现它允许写，于是知道这不是非法访问，而是该做写时复制了。',
      facts: [['错误码', '0x07 = P | W | U'], ['VMA', '可写'], ['结论', '写时复制，不是段错误']],
      events: [
        show('cpu2'),
        pk('proc2', 'cpu2', 'blue', '写', [hex(VA + 0x678n)], [80000, 'SW', '子进程执行写指令', 'reg'],
          wire('写访问的地址', 'regs', 'abi', registers('操作数', [['VA', VA + 0x678n, '这一页目前只读。', { example: true }]], 'blue')), { quick: true }),
        pk('cpu2', 'kernel', 'violet', '#PF', ['err = 0x07'], [81000, 'EXC', `写保护错误：CR2=${hex(VA + 0x678n)}，错误码 0x07`, 'reg'],
          wire('这次错误码的 P 位是 1', 'regs', 'abi', registers('异常信息', [
            ['CR2', VA + 0x678n, '出错的虚拟地址。'],
            ...pfError(0x07),
          ], 'violet')), { locked: true }),
        note('kernel', 'VMA 可写，PTE 只读：COW', 'amber'),
      ],
    },
    {
      title: '判断并复制',
      desc: '独占就复用，否则复制',
      detail: 'do_wp_page 先看这个物理页是否只被当前进程使用。如果父进程已退出或早已写过，页就是独占的，直接把 PTE 改成可写，不用复制，这叫复用。这里父进程还在共享，所以 wp_page_copy 分配一个新页，复制 4096 字节，然后把旧页的引用计数减一。',
      facts: [['独占时', 'wp_can_reuse_anon_folio，直接复用'], ['共享时', 'wp_page_copy'], ['复制大小', '4096 字节'], ['旧页', '引用计数减 1']],
      events: [
        pk('kernel', 'ram', 'amber', '复制页面', ['4 KiB'], [84000, 'MEM', 'wp_page_copy：分配新页并复制内容', 4096],
          wire('folio 结构随版本变化，这里只讲概念', 'regs', '示意', concept('复制', [
            ['旧页', hex(SHARED), '引用计数从 2 变 1，父进程继续使用。'],
            ['新页', hex(COPY), '内容和旧页相同，归子进程所有。'],
          ], 'amber'))),
        state('ram', { 引用: '各 1', 权限: '子进程独占新页' }),
      ],
    },
    {
      title: '刷新 TLB',
      desc: '更新 PTE，必要时发 IPI',
      detail: '子进程的 PTE 改成新页框、RW=1。旧翻译可能还留在 TLB 里，必须作废。本 CPU 用 invlpg。如果这个进程还有其他线程运行在别的 CPU 上，还要发 IPI 让它们也刷新，这叫 TLB shootdown，是多核上的一大开销。父进程属于另一个地址空间，不受影响。之后父进程再写这一页时，会发现自己已是独占，直接复用。',
      facts: [['本 CPU', 'invlpg'], ['其他 CPU', 'IPI，向量 0xFC'], ['只影响', '同一地址空间的线程'], ['父进程再写', '复用，不再复制']],
      events: [
        pk('kernel', 'ram', 'amber', '写新 PTE', ['RW = 1'], [88000, 'MEM', '子进程 PTE 指向新页，改为可写', 8],
          wire('更新后的子进程 PTE', 'mem', 'abi', pte('子进程 PTE（复制后）', { p: true, rw: true, us: true, a: true, d: true, nx: true, pfn: COPY }, { color: 'violet' }))),
        show('cpu'),
        pk('cpu2', 'cpu', 'teal', 'TLB shootdown', ['IPI 0xFC'], [90000, 'IPI', '通知同一地址空间的其他 CPU 刷新 TLB', 'reg'],
          wire('smp_call_function 发送的处理器间中断', 'regs', 'abi', registers('IPI', [
            ['vector', 0xfc, 'CALL_FUNCTION_VECTOR。只有一个目标时用 CALL_FUNCTION_SINGLE_VECTOR（0xFB）。'],
          ], 'teal')), { locked: true }),
        camera(),
        pk('cpu2', 'proc2', 'green', 'iretq', ['重新执行写'], [96000, 'SYSRET', '返回后写操作成功', 'reg'],
          wire('从异常返回', 'regs', 'abi', concept('结果', [
            ['写操作', '落到新页', hex(COPY)],
            ['父进程', '看不到这次修改', '仍使用旧页。'],
          ], 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '不写就不复制',
    desc: '把成本推迟到真正需要的时候',
    text: 'fork 后立刻 exec 的进程几乎不产生复制。代价是每个首次写入都多一次缺页，多线程时还要加上 TLB shootdown。Redis 等程序做 fork 快照时，这个开销就会直接体现为延迟。',
    facts: [['省下的', '不必要的页面复制'], ['付出的', '首次写时的缺页'], ['下一课', 'PAGE REPLACEMENT']],
  },
};
