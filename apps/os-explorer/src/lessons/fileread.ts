import { concept, dirEntry, ext4Inode, nvmeCqe, nvmeReadSqe, registers, syscallRegs, userBytes, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const CONTENT = 'hello, os!\n';
const INODE = 1835042;
const PAGE = 0x41d07000n;
const BLOCK = 34816;
const PART_LBA = 2099200n;
const SLBA = PART_LBA + BigInt(BLOCK) * 8n;

export const fileread: Lesson = {
  id: 'fileread',
  name: 'FILE READ',
  title: '读文件',
  group: 'io',
  layer: [3, 5],
  timeUnit: 'µs',
  nodes: ['app', 'kernel', 'k2', 'ram', 'disk', 'cpu'],
  place: { app: [130, 190], kernel: [440, 330], k2: [440, 70], ram: [760, 150], disk: [820, 510], cpu: [460, 590] },
  labels: {
    app: ['cat', 'PID 3120'],
    kernel: ['内核', 'VFS + ext4'],
    k2: ['页缓存', 'address_space'],
    ram: ['内存', '队列和页缓存页'],
    disk: ['NVMe SSD', 'ext4'],
    cpu: ['CPU', '接收 MSI-X'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['teal', '读元数据'], ['amber', '提交 I/O'], ['violet', 'DMA 与中断'], ['green', '返回数据']],
  overview: {
    full: '从路径到字节的完整路径',
    description: 'cat notes.txt 背后要走过路径解析、inode、页缓存、块层、NVMe 队列、DMA 和中断。这一课跟踪缓存全部未命中的最长路径，并解码真实的 ext4 目录项、inode 和 NVMe 命令。第二次读同一个文件时，这些几乎都省了。',
    facts: [
      ['平台', 'Linux 6.12，ext4，NVMe'],
      ['打开', 'openat（257）'],
      ['读取', 'read（0）'],
      ['缓存', '页缓存，默认使用'],
      ['数据传输', 'DMA，CPU 不参与'],
      ['完成通知', 'MSI-X 中断'],
    ],
  },
  steps: [
    {
      title: 'openat',
      desc: '解析路径，分配文件描述符',
      detail: 'glibc 的 open() 实际调用 openat，第一个参数是 AT_FDCWD，表示相对当前目录。VFS 逐段解析路径，每一段先查目录项缓存（dcache）。命中就不用碰磁盘。缺失的部分才让文件系统去读。最后分配一个 struct file，返回最小可用的文件描述符。',
      facts: [['调用号', '257 = openat'], ['dirfd', '-100 = AT_FDCWD'], ['路径缓存', 'dcache'], ['返回', '最小可用 fd']],
      events: [
        type('cat notes.txt'),
        pk('app', 'kernel', 'blue', 'openat', ['"notes.txt"'], [0, 'SYSCALL', 'openat(AT_FDCWD, "notes.txt", O_RDONLY)', 'reg'],
          wire('glibc open() 发起的系统调用', 'regs', 'abi', syscallRegs(257, 'openat', [
            ['rdi', -100, 'dirfd：AT_FDCWD，相对当前目录。'],
            ['rsi', 0x7ffd3c21a7a0n, 'pathname。', { example: true }],
            ['rdx', 0, 'flags：O_RDONLY。'],
            ['r10', 0, 'mode：只有创建文件时才用。'],
          ]))),
        state('kernel', { dcache: '未命中' }),
      ],
    },
    {
      title: '取 inode',
      desc: '读目录项和 inode 表',
      detail: 'dcache 没有这个名字，ext4 就读目录块，找到目录项，从中得到 inode 号。目录项只保存名字和 inode 号。接着按 inode 号算出 inode 表的位置，读出 256 字节的 ext4_inode。它记录大小、权限和时间，i_block 里还放着 extent 树的根，指明数据在磁盘的哪里。',
      facts: [['目录项', `inode ${INODE.toLocaleString('en-US')}`], ['inode 大小', '256 字节'], ['数据位置', 'i_block 里的 extent'], ['extent 魔数', '0xF30A']],
      events: [
        show('disk'),
        pk('disk', 'kernel', 'teal', '目录项', ['notes.txt'], [90000, 'BIO', '读目录块，找到 notes.txt', 17],
          wire('目录块里的一项', 'mem', 'abi', dirEntry(INODE, 'notes.txt', 20))),
        pk('disk', 'kernel', 'teal', 'inode', [`#${INODE}`], [180000, 'BIO', '读 inode 表，得到 ext4_inode', 256],
          wire('布局见 kernel.org 的 ext4 磁盘格式文档', 'mem', 'abi', ext4Inode({ mode: 0x81a4, size: CONTENT.length, links: 1, blocks: 8, extent: { logical: 0, length: 1, start: BLOCK } }))),
        state('kernel', { dcache: '已缓存', fd: '3' }),
      ],
    },
    {
      title: '页缓存未命中',
      desc: '先查内存，没有就准备读盘',
      detail: 'read 不会直接读磁盘。filemap_read 先按文件偏移在页缓存里查找。这个文件还没读过，所以未命中。内核分配一个新页放进页缓存，并锁住它。同时启动预读，猜测你接下来也要读后面的内容。ext4 用 extent 把文件偏移换算成物理块。',
      facts: [['调用号', '0 = read'], ['查找', 'filemap_read'], ['结果', '未命中'], ['预读', '顺序读时提前读更多']],
      events: [
        pk('app', 'kernel', 'blue', 'read', ['fd=3 count=131072'], [260000, 'SYSCALL', 'read(3, buf, 131072)', 'reg'],
          wire('cat 用较大的缓冲区读取', 'regs', 'abi', syscallRegs(0, 'read', [
            ['rdi', 3, 'fd。'],
            ['rsi', 0x7f8e41400000n, 'buf。', { example: true }],
            ['rdx', 131072, 'count：128 KiB。'],
          ]))),
        show('k2'),
        pk('kernel', 'k2', 'amber', '查页缓存', ['偏移 0'], [265000, 'MEM', 'filemap_read：查找文件偏移 0 对应的页', null],
          wire('address_space 是内核内部结构，这里只讲概念', 'regs', '示意', concept('页缓存查找', [
            ['键', '（inode，页索引 0）', '每个文件有自己的一组页。'],
            ['结果', '未命中', '这个文件还没有读过。'],
            ['接下来', '分配页并加入缓存，然后加锁等待读盘完成', ''],
          ], 'amber'))),
        state('k2', { 偏移0: '未命中' }),
      ],
    },
    {
      title: '提交 I/O',
      desc: '写 SQE，敲门铃',
      detail: '块层把请求交给 NVMe 驱动。驱动在内存里的提交队列填一个 64 字节的命令：操作码 0x02（读）、物理目标地址 PRP1，以及起始 LBA。然后往设备的门铃寄存器写入新的队尾。这次 MMIO 写就是告诉 SSD：有新命令了。进程在这之后进入睡眠，CPU 可以去做别的事。',
      facts: [['队列', '内存里的环形缓冲区'], ['命令大小', '64 字节'], ['起始 LBA', `${SLBA}（分区起点 + 块号 × 8）`], ['门铃', 'MMIO 写']],
      events: [
        show('ram'),
        pk('kernel', 'ram', 'amber', '写 SQE', ['读 8 个 LBA'], [275000, 'MEM', '在提交队列写入 NVMe 读命令', 64],
          wire('提交队列里的一项。字段见 struct nvme_rw_command', 'mem', 'abi', nvmeReadSqe({ cid: 37, nsid: 1, prp1: PAGE, slba: SLBA, blocks: 7 }))),
        pk('kernel', 'disk', 'amber', '敲门铃', ['SQ tail = 12'], [278000, 'MMIO', '写设备门铃寄存器', 4],
          wire('一次写到设备寄存器的 MMIO', 'regs', 'abi', registers('门铃', [['SQ0TDBL', 12, '新的提交队列队尾。设备据此知道有新命令。', { example: true }]], 'amber')), { locked: true }),
        state('app', { 状态: '睡眠，等 I/O' }),
      ],
    },
    {
      title: 'DMA 与中断',
      desc: '设备写内存，写 CQE，发 MSI-X',
      detail: 'SSD 自己去内存取命令，读出数据，通过 DMA 直接写到页缓存的物理页，全程不需要 CPU。完成后它在完成队列写一项，再发 MSI-X 中断。MSI-X 其实是一次发往 LAPIC 地址的内存写，不走 IO-APIC。驱动处理完成项，解锁页面，唤醒等待的进程。',
      facts: [['数据去向', '页缓存的物理页'], ['CPU 参与', '不参与传输'], ['完成通知', 'MSI-X'], ['完成项', '16 字节，带相位位']],
      events: [
        pk('disk', 'ram', 'violet', 'DMA 写数据', ['4 KiB'], [340000, 'DMA', `设备把数据写到 ${hex(PAGE)}`, 4096],
          wire('数据到达页缓存', 'mem', 'abi', userBytes('文件内容（第一页的开头）', CONTENT))),
        pk('disk', 'ram', 'violet', '写 CQE', ['status = 成功'], [342000, 'DMA', '在完成队列写入一项', 16],
          wire('完成队列里的一项。字段见 struct nvme_completion', 'mem', 'abi', nvmeCqe({ sqHead: 12, sqId: 1, cid: 37, phase: 1 }))),
        show('cpu'),
        pk('disk', 'cpu', 'violet', 'MSI-X', ['写 0xFEE00000'], [344000, 'IRQ', '设备发出 MSI-X 中断', 'reg'],
          wire('一次特殊的内存写，由 LAPIC 接收', 'regs', 'abi', registers('MSI 消息', [
            ['addr', 0xfee00000n, 'LAPIC 的地址范围，目标 CPU 编码在低位。'],
            ['data', 0x41, '中断向量，由内核分配。', { example: true }],
          ], 'violet'))),
        pk('cpu', 'kernel', 'violet', 'nvme_irq', ['处理完成项'], [347000, 'IRQ', '驱动处理完成项，解锁页面', null],
          wire('驱动的处理流程', 'regs', '示意', concept('完成处理', [
            ['判断新项', '相位位翻转', '不用设备寄存器就知道哪些是新的。'],
            ['写门铃', 'CQ head', '告诉设备可以复用这些项。'],
            ['结束请求', 'blk_mq_end_request', '解锁页面并唤醒进程。'],
          ], 'violet'))),
        state('k2', { 偏移0: '已缓存' }),
      ],
    },
    {
      title: '拷贝返回',
      desc: 'copy_to_user 把字节给进程',
      detail: '进程被唤醒，继续执行 filemap_read，这次页缓存命中。copy_to_user 把文件内容从页缓存拷贝到用户缓冲区。read 返回实际读到的字节数。文件留在页缓存中，下次任何进程再读，都不用碰磁盘。这也是 Linux 内存看起来总是被用光的原因，它们大多是可以回收的缓存。',
      facts: [['拷贝', 'copy_to_user'], ['返回值', `${CONTENT.length}（文件大小）`], ['下次读取', '直接命中缓存']],
      events: [
        pk('kernel', 'app', 'green', 'read 返回', [`rax = ${CONTENT.length}`], [420000, 'SYSRET', 'copy_to_user，read 返回', CONTENT.length],
          wire('用户缓冲区收到的内容', 'mem', 'abi', userBytes('用户缓冲区', CONTENT))),
        state('app', { 状态: null }),
        note('app', 'hello, os!', 'green'),
        render,
      ],
    },
  ],
  outro: {
    title: '缓存决定一切',
    desc: '最长的路径只走一次',
    text: '第一次读文件要几百微秒，主要花在设备上；第二次只要一次内存拷贝，不到一微秒。CPU 也几乎不等待：提交命令后就可以运行别的任务，靠中断回来收尾。写文件的路径则更复杂，要先回答一个问题：怎样保证崩溃后数据还在。',
    facts: [['第一次', '几百微秒'], ['第二次', '不到 1 微秒'], ['下一课', 'JOURNAL']],
  },
};
