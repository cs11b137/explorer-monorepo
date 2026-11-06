import { concept, mapsLine, pfError, pte, registers, syscallRegs, userBytes, virtualAddress, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { camera, note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const HEAP = 0x55d0c3a2e000n;
const BRK = HEAP + 0x21000n;
const ANON = 0x7f3a1c1ff000n;
const ANON_SIZE = 1052672n;
const FILE = ANON - 0x800000n;
const FILE_INODE = 1835050;
const CACHE = 0x3b2e4n;
const RIP = 0x55d0c29f2b18n;

export const mmap: Lesson = {
  id: 'mmap',
  name: 'MMAP',
  title: '内存映射',
  group: 'memory',
  layer: [4, 6],
  timeUnit: 'µs',
  nodes: ['app', 'kernel', 'k2', 'mmu', 'ram', 'disk'],
  place: { app: [130, 200], kernel: [470, 330], k2: [470, 70], mmu: [150, 540], ram: [800, 520], disk: [860, 200] },
  labels: {
    app: ['用户进程', 'glibc malloc'],
    kernel: ['内核', 'mm/mmap.c'],
    k2: ['VMA 集合', 'maple tree'],
    mmu: ['MMU', '地址翻译'],
    ram: ['物理内存', '页缓存'],
    disk: ['NVMe SSD', 'words.txt'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用与访问'], ['amber', '修改 VMA'], ['violet', '缺页'], ['teal', '读文件'], ['green', '返回与映射']],
  overview: {
    full: '先分地址，后给内存',
    description: '进程要内存有两条路：brk 推高堆顶，mmap 另开一段映射。两者都只在 VMA 集合里记一笔，不分配物理页。映射还可以对着文件，访问内存就等于读文件。真正的页面要等第一次访问触发缺页时才到位。这一课先看 malloc 的两种来源，再跟踪一个文件映射的首次读取。',
    facts: [
      ['平台', 'Linux 6.12，x86-64，glibc'],
      ['扩堆', 'brk（12）'],
      ['映射', 'mmap（9）'],
      ['malloc 阈值', '128 KiB，超过就用 mmap'],
      ['VMA 集合', 'maple tree'],
      ['物理页', '首次访问时才分配'],
    ],
  },
  steps: [
    {
      title: '扩堆',
      desc: 'brk 只移动堆顶',
      detail: '程序第一次 malloc(1000)，glibc 发现堆还是空的，就调用 brk 把堆顶推高 132 KiB：请求的大小加上 128 KiB 的余量，再按页取整，这样后面的小块分配不用每次都进内核。内核只是把 [heap] 这个 VMA 的 vm_end 往上挪，一页物理内存都不分配。堆的起点在程序末尾之后，开启 ASLR 时还会再随机偏移一段。',
      facts: [['调用号', '12 = brk'], ['推高', '0x21000（132 KiB）'], ['内核做的', '改 vm_end'], ['物理页', '0']],
      events: [
        pk('app', 'kernel', 'blue', 'brk', ['+132 KiB'], [0, 'SYSCALL', `brk(${hex(BRK)})`, 'reg'],
          wire('glibc 的 sbrk 发起的调用', 'regs', 'abi', syscallRegs(12, 'brk', [
            ['rdi', BRK, '新的堆顶 = 旧堆顶 + 0x21000。', { example: true }],
          ]))),
        show('k2'),
        pk('kernel', 'k2', 'amber', '扩展 [heap]', ['vm_end 上移'], [3000, 'MEM', 'do_brk_flags：扩展堆的 VMA', null],
          wire('vm_area_struct 是内核内部结构，这里只列相关字段', 'regs', '示意', concept('[heap] 的 VMA', [
            ['vm_start', hex(HEAP), '堆的起点，随机化过。'],
            ['vm_end', `${hex(HEAP)} → ${hex(BRK)}`, '只改了这一个数。'],
            ['vm_flags', 'VM_READ | VM_WRITE', '可读写，不可执行。'],
            ['物理页', '0', '还没有任何页表项。'],
          ], 'amber'))),
        pk('kernel', 'app', 'green', 'brk 返回', [`rax = ${hex(BRK)}`], [4000, 'SYSRET', 'brk 返回新的堆顶', 'reg'],
          wire('brk 的返回值和其他调用不同', 'regs', 'abi', registers('返回值', [
            ['rax', BRK, '成功时返回新堆顶。失败时返回旧堆顶，而不是负的错误码，glibc 靠比较两者判断成败。', { example: true }],
          ], 'green'))),
        state('k2', { '[heap]': '132 KiB，0 页' }),
      ],
    },
    {
      title: '匿名映射',
      desc: '大块内存直接 mmap',
      detail: 'malloc(1 MiB) 超过了 128 KiB 的阈值，glibc 不再从堆里切，而是直接 mmap 一段匿名内存，free 时整段还给内核。这样大块内存不会在堆中间留下难以归还的空洞。内核从 mmap_base 往下找一段足够大的空隙，在 maple tree 里插入新的 VMA，返回起点。和 brk 一样，此刻只有地址，没有物理页。',
      facts: [['调用号', '9 = mmap'], ['阈值', '128 KiB，会随使用动态调高'], ['flags', 'MAP_PRIVATE | MAP_ANONYMOUS'], ['物理页', '0']],
      events: [
        pk('app', 'kernel', 'blue', 'mmap', ['1 MiB 匿名'], [50000, 'SYSCALL', `mmap(NULL, ${ANON_SIZE}, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)`, 'reg'],
          wire('glibc 的 malloc 发起的调用', 'regs', 'abi', syscallRegs(9, 'mmap', [
            ['rdi', 0, 'addr：NULL，让内核挑地址。'],
            ['rsi', ANON_SIZE, 'length：1 MiB 加上 malloc 的块头，按页向上取整。'],
            ['rdx', 3, 'prot：PROT_READ（1）| PROT_WRITE（2）。'],
            ['r10', 0x22, 'flags：MAP_PRIVATE（0x02）| MAP_ANONYMOUS（0x20）。'],
            ['r8', -1, 'fd：匿名映射不对应文件，传 -1。'],
            ['r9', 0, 'offset。'],
          ]))),
        pk('kernel', 'k2', 'amber', '插入 VMA', ['匿名'], [53000, 'MEM', '在 mmap_base 下方找空隙，插入新 VMA', null],
          wire('vm_area_struct 是内核内部结构，这里只列相关字段', 'regs', '示意', concept('新的 VMA', [
            ['vm_start', hex(ANON), '从高地址往低地址分配。'],
            ['vm_end', hex(ANON + ANON_SIZE), '大小 1 MiB + 4 KiB。'],
            ['vm_flags', 'VM_READ | VM_WRITE', ''],
            ['vm_file', 'NULL', '匿名内存，缺页时分配清零的页。'],
          ], 'amber'))),
        pk('kernel', 'app', 'green', 'mmap 返回', [`rax = ${hex(ANON)}`], [55000, 'SYSRET', 'mmap 返回映射的起点', 'reg'],
          wire('malloc 返回给程序的地址要再加 16', 'regs', 'abi', registers('返回值', [
            ['rax', ANON, '映射起点。前 16 字节是 malloc 的块头，程序拿到的是这里加 16。', { example: true }],
          ], 'green'))),
        note('app', '第一次写入时才缺页，见 PAGE FAULT'),
        state('k2', { '[heap]': '132 KiB，0 页', 匿名: '1 MiB，0 页' }),
      ],
    },
    {
      title: '映射文件',
      desc: 'VMA 记下文件和偏移',
      detail: '程序打开 words.txt 得到 fd 3，再把它的前 8 MiB 映射进来，只读、私有。这次 VMA 的 vm_file 指向这个文件，vm_pgoff 记下文件偏移，vm_ops 换成文件系统提供的缺页函数。内核同样一个字节都不读。之后访问这段内存就等于读文件：不用 read 系统调用，也省掉一次从页缓存到用户缓冲区的拷贝。',
      facts: [['fd', '3'], ['prot', 'PROT_READ'], ['flags', 'MAP_PRIVATE'], ['读入数据', '0 字节']],
      events: [
        pk('app', 'kernel', 'blue', 'mmap', ['words.txt，8 MiB'], [120000, 'SYSCALL', 'mmap(NULL, 8388608, PROT_READ, MAP_PRIVATE, 3, 0)', 'reg'],
          wire('映射文件的调用', 'regs', 'abi', syscallRegs(9, 'mmap', [
            ['rdi', 0, 'addr：NULL。'],
            ['rsi', 8388608, 'length：8 MiB。'],
            ['rdx', 1, 'prot：PROT_READ。'],
            ['r10', 0x02, 'flags：MAP_PRIVATE。写入不会影响文件，而是触发写时复制。'],
            ['r8', 3, 'fd：words.txt。'],
            ['r9', 0, 'offset：从文件开头映射，必须按页对齐。'],
          ]))),
        pk('kernel', 'k2', 'amber', '插入 VMA', ['vm_file = words.txt'], [124000, 'MEM', '插入一个文件映射的 VMA', null],
          wire('之后 /proc/self/maps 里多出的这一行', 'mem', 'abi', mapsLine({ start: FILE, end: FILE + 0x800000n, perms: 'r--p', offset: 0, major: 259, minor: 2, inode: FILE_INODE, path: '/home/alice/words.txt' }))),
        pk('kernel', 'app', 'green', 'mmap 返回', [`rax = ${hex(FILE)}`], [126000, 'SYSRET', 'mmap 返回映射的起点', 'reg'],
          wire('紧挨在上一段匿名映射的下面', 'regs', 'abi', registers('返回值', [
            ['rax', FILE, '映射起点。', { example: true }],
          ], 'green'))),
        state('k2', { '[heap]': '132 KiB，0 页', 匿名: '1 MiB，0 页', 文件: '8 MiB，0 页' }),
      ],
    },
    {
      title: '首次访问',
      desc: '读文件映射，触发缺页',
      detail: '程序读映射区的第一个字节。PTE 不存在，CPU 触发 #PF，错误码 0x04：页不存在、读访问、来自用户态。内核按 CR2 找到 VMA，发现它带有 vm_file，于是不走匿名页的路径，而是调用 vm_ops 里的 fault 函数，对 ext4 来说就是 filemap_fault。如果地址不在任何 VMA 里，结果就是 SIGSEGV。',
      facts: [['错误码', '0x04（不存在、读、用户）'], ['查找 VMA', '先用每个 VMA 的锁，不锁整个 mm'], ['文件映射', '调用 filemap_fault'], ['找不到 VMA', 'SIGSEGV']],
      events: [
        show('mmu'),
        pk('app', 'mmu', 'blue', '读', [hex(FILE)], [400000, 'MEM', '读文件映射的第一个字节', 'reg'],
          wire('MMU 收到的地址', 'regs', 'abi', virtualAddress(FILE)), { quick: true }),
        pk('mmu', 'kernel', 'violet', '#PF', ['err = 0x04'], [401000, 'EXC', `缺页：CR2=${hex(FILE)}，错误码 0x04`, 'reg'],
          wire('异常发生时 CPU 提供的信息', 'regs', 'abi', registers('异常信息', [
            ['CR2', FILE, '出错的虚拟地址。'],
            ...pfError(0x04),
          ], 'violet')), { locked: true }),
        pk('kernel', 'k2', 'amber', '查 VMA', ['命中文件映射'], [402000, 'MEM', 'lock_vma_under_rcu：找到 CR2 所在的 VMA', null],
          wire('vm_area_struct 是内核内部结构，这里只列相关字段', 'regs', '示意', concept('匹配的 VMA', [
            ['vm_start', hex(FILE), ''],
            ['vm_flags', 'VM_READ | VM_MAYWRITE', '读访问合法。'],
            ['vm_file', 'words.txt', '文件映射。'],
            ['vm_pgoff', '0', 'CR2 对应文件的第 0 页。'],
            ['vm_ops->fault', 'filemap_fault', '缺页时调用它。'],
          ], 'amber'))),
      ],
    },
    {
      title: '按需建页',
      desc: '读入页缓存，再填 PTE',
      detail: 'filemap_fault 在页缓存里找文件第 0 页，没有找到，就发起同步预读，把这附近的 128 KiB 一起读进来，进程睡眠等待磁盘。读完后，内核把页缓存里的这一页直接填进 PTE，不复制。PTE 是只读的：私有映射将来要写时，会先复制一份。预读进来的相邻页已在缓存中，下次访问附近地址时，fault-around 一次缺页就能映射多达 16 页。',
      facts: [['处理函数', 'filemap_fault'], ['预读', '128 KiB，围绕出错位置'], ['PTE', '只读，指向页缓存页'], ['fault-around', '一次最多映射 16 页']],
      events: [
        show('ram'),
        show('disk'),
        pk('disk', 'ram', 'teal', 'DMA 预读', ['32 页'], [470000, 'DMA', '同步预读：读入第 0 页附近的 128 KiB', 131072],
          wire('数据到达页缓存', 'mem', 'abi', userBytes('文件第 0 页的开头', 'aardvark\nabacus\nabandon\n'))),
        pk('kernel', 'ram', 'green', '写 PTE', ['P=1 RW=0'], [476000, 'MEM', '把页缓存页填进 PTE，只读', 8],
          wire('文件映射的读缺页：没有 D 位，也没有 RW 位', 'mem', 'abi', pte('PTE（缺页后）', { p: true, us: true, a: true, nx: true, pfn: CACHE }))),
        state('k2', { '[heap]': '132 KiB，0 页', 匿名: '1 MiB，0 页', 文件: '8 MiB，1 页' }),
        pk('kernel', 'app', 'violet', 'iretq', ['重新执行读'], [478000, 'SYSRET', '从异常返回，RIP 未前进', 'reg'],
          wire('iretq 从栈帧恢复的值', 'regs', 'abi', registers('恢复', [['RIP', RIP, '仍指向那条读指令，所以会重新执行。', { example: true }]], 'violet')), { locked: true }),
        camera(),
        pk('mmu', 'ram', 'green', '读取成功', [hex(CACHE << 12n)], [479000, 'MEM', '翻译成功，读到页缓存里的数据', 1],
          wire('翻译结果', 'regs', 'abi', concept('物理地址', [
            ['页框基址', hex(CACHE << 12n), '页缓存里的那一页，和 read 读到的是同一页。'],
            ['页内偏移', '0x0', ''],
            ['读到的字节', '0x61（"a"）', ''],
          ], 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '地址先行，内存随后',
    desc: 'brk 和 mmap 只是记账',
    text: '进程申请的地址空间可以远大于它真正用到的内存，差额就靠缺页按需补上。文件映射还把读文件变成了访问内存：多个进程映射同一个文件时，共用页缓存里的同一份物理页，共享库就是这样只在内存里存一份的。',
    facts: [['brk', '只适合连续增长的堆'], ['mmap', '大块内存、文件、共享库'], ['下一课', 'PAGE REPLACEMENT']],
  },
};
