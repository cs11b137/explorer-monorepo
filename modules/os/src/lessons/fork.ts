import { elfHeader, programHeader, pte, registers, syscallRegs, waitStatus, wire } from '../decode/structures';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const CHILD = 2891;
const PAGE = 0x2f3c1n;

export const fork: Lesson = {
  id: 'fork',
  name: 'FORK/EXEC',
  title: '创建进程',
  group: 'process',
  layer: [4, 5],
  timeUnit: 'µs',
  nodes: ['app', 'proc2', 'kernel', 'ram', 'disk'],
  place: { app: [150, 200], proc2: [150, 500], kernel: [520, 340], ram: [850, 170], disk: [860, 510] },
  labels: {
    app: ['bash', 'PID 1204 · 父进程'],
    proc2: ['子进程', `PID ${CHILD}`],
    kernel: ['内核', 'Ring 0'],
    ram: ['内存', '页表与物理页'],
    disk: ['磁盘', '/usr/bin/ls'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['amber', '内核操作'], ['teal', '读 ELF'], ['green', '返回用户态'], [null, '时间仅表示量级']],
  overview: {
    full: 'fork 复制进程，execve 替换程序',
    description: 'Unix 把「创建进程」和「运行程序」分成两步：fork 复制出一个几乎相同的子进程，execve 再把子进程的内存换成新程序。这一课跟踪 shell 运行 ls 的全过程，并解码真实的 ELF 文件头。',
    facts: [
      ['平台', 'Linux 6.12，x86-64，glibc'],
      ['fork 实际调用', 'clone（56）'],
      ['加载程序', 'execve（59）'],
      ['等待子进程', 'wait4（61）'],
      ['文件格式', 'ELF64'],
      ['内存策略', '写时复制和按需加载'],
    ],
  },
  steps: [
    {
      title: '克隆进程',
      desc: 'glibc 的 fork 调用 clone',
      detail: '在 x86-64 上，glibc 的 fork() 并不调用 fork 系统调用，而是 clone，标志是 CLONE_CHILD_SETTID、CLONE_CHILD_CLEARTID 和 SIGCHLD。内核创建新的 task_struct，复制文件描述符表等资源。同一次调用返回两次：父进程得到子进程 PID，子进程得到 0。',
      facts: [['调用号', '56 = clone'], ['标志', '0x01200011'], ['父进程收到', `PID ${CHILD}`], ['子进程收到', '0']],
      events: [
        type('ls'),
        pk('app', 'kernel', 'blue', 'clone', ['flags=0x01200011'], [0, 'SYSCALL', 'clone(CLONE_CHILD_SETTID|CLONE_CHILD_CLEARTID|SIGCHLD)', 'reg'],
          wire('glibc fork() 发起的系统调用', 'regs', 'abi', syscallRegs(56, 'clone', [
            ['rdi', 0x01200011, 'flags：CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | SIGCHLD（17）。'],
            ['rsi', 0, '子进程栈：0 表示沿用当前栈，由写时复制隔开。'],
            ['rdx', 0, 'parent_tid：未使用。'],
            ['r10', 0x7f8e41a00a10n, 'child_tid：子进程的线程 ID 写到这里，退出时清零。', { example: true }],
            ['r8', 0, 'tls：未使用。'],
          ]))),
        show('proc2'),
        pk('kernel', 'proc2', 'green', '新任务', ['rax = 0'], [38000, 'SCHED', `创建 task，PID ${CHILD}，子进程返回 0`, 'reg'],
          wire('子进程醒来时看到的返回值', 'regs', 'abi', registers('子进程寄存器', [['rax', 0, 'fork 在子进程中返回 0，所以代码能区分自己是谁。']], 'green')), { quick: true }),
        pk('kernel', 'app', 'green', '返回 PID', [`rax = ${CHILD}`], [40000, 'SYSRET', `clone 返回 ${CHILD}`, 'reg'],
          wire('父进程收到的返回值', 'regs', 'abi', registers('父进程寄存器', [['rax', CHILD, '子进程的 PID。', { example: true }]], 'green')), { quick: true }),
      ],
    },
    {
      title: '复制地址空间',
      desc: '复制页表，把可写页标成只读',
      detail: 'fork 并不复制进程内存的内容，只复制页表，让父子两个进程指向同样的物理页。私有可写页的 PTE 在双方都被清掉 RW 位。谁先写，谁就触发缺页，内核才真正复制那一页，这就是写时复制（下面 COW 一课会细讲）。所以 fork 的开销主要取决于页表大小。',
      facts: [['复制的内容', '页表，不是数据页'], ['可写的私有页', '父子都改成只读'], ['耗时取决于', '页表规模']],
      events: [
        show('ram'),
        pk('kernel', 'ram', 'amber', '复制页表', ['RW → 0'], [62000, 'MEM', '复制页表，写保护私有可写页', 8],
          wire('父进程 PTE 在 fork 前后的对比', 'mem', 'abi',
            pte('fork 前的 PTE', { p: true, rw: true, us: true, a: true, d: true, nx: true, pfn: PAGE }),
            pte('fork 后，父子共用的 PTE', { p: true, us: true, a: true, nx: true, pfn: PAGE }, { color: 'violet' }))),
      ],
    },
    {
      title: '替换映像',
      desc: '子进程 execve，内核解析 ELF',
      detail: '子进程调用 execve("/usr/bin/ls", argv, envp)。内核读取文件开头，核对 ELF 魔数，再按程序头建立映射。这一步并不把整个程序读入内存：PT_LOAD 段只是建立映射，实际的页面要等缺页时才从磁盘读入。旧的地址空间被丢弃，但 PID 和打开的文件描述符保留。',
      facts: [['调用号', '59 = execve'], ['读取内容', '只有 ELF 头和程序头'], ['段的加载方式', '映射，按需读入'], ['保留', 'PID、未设 CLOEXEC 的 fd']],
      events: [
        pk('proc2', 'kernel', 'blue', 'execve', ['/usr/bin/ls'], [120000, 'SYSCALL', 'execve("/usr/bin/ls", argv, envp)', 'reg'],
          wire('子进程发起的系统调用', 'regs', 'abi', syscallRegs(59, 'execve', [
            ['rdi', 0x55d0c2a13f20n, 'pathname。', { example: true }],
            ['rsi', 0x55d0c2a14010n, 'argv。', { example: true }],
            ['rdx', 0x55d0c2a10c50n, 'envp。', { example: true }],
          ]))),
        show('disk'),
        pk('disk', 'kernel', 'teal', 'ELF 头', ['7F 45 4C 46'], [310000, 'BIO', '读取文件开头，核对 ELF 魔数', 64],
          wire('/usr/bin/ls 的前 64 字节', 'mem', 'abi', elfHeader({ type: 3, entry: 0x6d30n, phoff: 64n, phnum: 13, shoff: 136232n, shnum: 31, shstrndx: 30 }))),
        pk('disk', 'kernel', 'teal', '程序头', ['PT_LOAD'], [330000, 'BIO', '读取程序头，建立映射', 56],
          wire('程序头表中一个可执行的代码段', 'mem', 'abi', programHeader('程序头 · PT_LOAD', { type: 1, flags: 5, offset: 0x4000n, vaddr: 0x4000n, filesz: 0x14c31n, memsz: 0x14c31n, align: 0x1000n }))),
      ],
    },
    {
      title: '动态链接器',
      desc: '先跳到 PT_INTERP 指定的解释器',
      detail: 'ls 是动态链接的，程序头里有 PT_INTERP，指向 /lib64/ld-linux-x86-64.so.2。内核把它也映射进来，返回用户态时跳到的是链接器的入口，不是 ls 的 e_entry。链接器加载 libc 等共享库并完成重定位，然后才跳到程序入口。',
      facts: [['解释器', 'ld-linux-x86-64.so.2'], ['首个用户指令', '在链接器里'], ['程序入口', '链接器最后才跳转']],
      events: [
        pk('kernel', 'proc2', 'green', '跳到 ld.so', ['RIP = 链接器入口'], [410000, 'SYSRET', '返回用户态，从动态链接器开始执行', 56],
          wire('PT_INTERP 程序头。内容是解释器路径的字符串', 'mem', 'abi', programHeader('程序头 · PT_INTERP', { type: 3, flags: 4, offset: 0x318n, vaddr: 0x318n, filesz: 28n, memsz: 28n, align: 1n }, 'teal'))),
        note('proc2', '链接 libc，然后运行 ls'),
        state('proc2', { 程序: 'ls' }),
      ],
    },
    {
      title: '等待回收',
      desc: '父进程 wait4，取回退出状态',
      detail: 'shell 调用 wait4 进入睡眠。ls 打印结果后调用 exit_group，内核释放它的内存和文件，但保留一个僵尸项存放退出状态。内核唤醒父进程，wait4 把状态写回用户内存，僵尸才被彻底清除。这就是一直不 wait 的进程会积累僵尸的原因。',
      facts: [['父进程', 'wait4（61）'], ['子进程', 'exit_group（231）'], ['僵尸状态', '等待父进程读取'], ['退出码', '在 wstatus 的位 15:8']],
      events: [
        pk('app', 'kernel', 'blue', 'wait4', ['pid = -1'], [440000, 'SYSCALL', 'wait4(-1, &wstatus, 0, NULL)', 'reg'],
          wire('父进程等待任意子进程', 'regs', 'abi', syscallRegs(61, 'wait4', [
            ['rdi', -1, 'pid：-1 表示任意子进程。'],
            ['rsi', 0x7ffd3c21a2bcn, 'wstatus 的地址。', { example: true }],
            ['rdx', 0, 'options：阻塞等待。'],
            ['r10', 0, 'rusage：不需要。'],
          ]))),
        state('app', { 状态: '睡眠，等子进程' }),
        pk('proc2', 'kernel', 'blue', 'exit_group', ['status = 0'], [2400000, 'SYSCALL', 'exit_group(0)，子进程结束', 'reg'],
          wire('子进程退出', 'regs', 'abi', syscallRegs(231, 'exit_group', [['rdi', 0, '退出码 0。']]))),
        state('proc2', { 状态: '僵尸', 程序: null }),
        pk('kernel', 'app', 'green', '唤醒父进程', [`rax = ${CHILD}`], [2460000, 'SYSRET', `wait4 返回 ${CHILD}，写回 wstatus`, 4],
          wire('wait4 写回用户内存的状态字', 'mem', 'abi', waitStatus(0))),
        state('app', { 状态: null }),
        state('proc2', { 状态: '已回收' }),
        render,
      ],
    },
  ],
  outro: {
    title: '复制，然后替换',
    desc: `两步之间，shell 能调整子进程的环境`,
    text: `fork 和 execve 分开，让 shell 能在中间重定向文件描述符、设置管道和环境变量，而不必给 execve 加一堆参数。写时复制和按需加载让这种看似浪费的做法几乎没有代价。`,
    facts: [['写时复制', '详见 COW 一课'], ['按需加载', '详见 PAGE FAULT 一课'], ['子进程 PID', `${CHILD}（示例值）`]],
  },
};
