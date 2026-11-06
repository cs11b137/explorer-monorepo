import { concept, cr3Register, elfHeader, execStrings, initialStack, programHeader, ptRegs, registers, syscallRegs, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const PID = 2891;
/** ls 是 PIE，加载基址由 ASLR 随机挑选。 */
const BASE = 0x55d0c29e0000n;
const ENTRY = BASE + 0x6d30n;
const INTERP = 0x7f8e41f3c000n;
const INTERP_ENTRY = INTERP + 0x1f540n;
const STACK_TOP = 0x7ffd3c21c000n;
const RSP = 0x7ffd3c219f30n;
const RANDOM = 0x7ffd3c21a0d9n;
const PLATFORM = 0x7ffd3c21a0e9n;

/** 字符串从栈顶往下拷：文件名在最上面，然后是 envp，最后是 argv。这里按地址从低到高列出。 */
const STRINGS: Array<[label: string, text: string, note?: string]> = [
  ['argv[0]', 'ls', '最后拷贝，所以地址最低。'],
  ['argv[1]', '-l'],
  ['envp[0]', 'PATH=/usr/bin:/bin', '这里只列两个环境变量。'],
  ['envp[1]', 'LANG=C.UTF-8'],
  ['文件名', '/usr/bin/ls', '最先拷贝，紧挨栈顶。AT_EXECFN 指向这里。'],
];
const STRINGS_SIZE = STRINGS.reduce((sum, [, text]) => sum + text.length + 1, 0);
const ADDRESS = (() => {
  let at = STACK_TOP - 8n - BigInt(STRINGS_SIZE);
  return STRINGS.map(([, text]) => {
    const here = at;
    at += BigInt(text.length + 1);
    return here;
  });
})();

/** 四个 PT_LOAD 在程序头表里是连续的第 2 到 5 项。 */
const LOADS = [
  { flags: 4, offset: 0x0n, vaddr: 0x0n, filesz: 0x3640n, memsz: 0x3640n },
  { flags: 5, offset: 0x4000n, vaddr: 0x4000n, filesz: 0x14c31n, memsz: 0x14c31n },
  { flags: 4, offset: 0x19000n, vaddr: 0x19000n, filesz: 0x71b8n, memsz: 0x71b8n },
  { flags: 6, offset: 0x20fd0n, vaddr: 0x21fd0n, filesz: 0x1298n, memsz: 0x2588n },
];
const range = (from: bigint, to: bigint) => `${hex(BASE + from)}–${hex(BASE + to)}`;

export const exec: Lesson = {
  id: 'exec',
  name: 'EXEC',
  title: '加载程序',
  group: 'process',
  layer: [4, 5],
  timeUnit: 'µs',
  nodes: ['app', 'kernel', 'disk', 'ram', 'cpu'],
  place: { app: [140, 190], kernel: [500, 330], ram: [860, 160], disk: [860, 520], cpu: [190, 540] },
  labels: {
    app: [`进程 ${PID}`, 'bash 刚 fork 出的子进程'],
    kernel: ['内核', 'fs/exec.c + binfmt_elf'],
    ram: ['内存', '新的地址空间'],
    disk: ['磁盘', '/usr/bin/ls'],
    cpu: ['CPU', 'CR3 与寄存器'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['amber', '建立新映像'], ['teal', '读 ELF'], ['violet', '切换'], ['green', '新程序开始']],
  overview: {
    full: 'execve 把进程换成另一个程序',
    description: 'execve 不创建新进程，而是把当前进程的内存整个换掉：读 ELF 头和程序头，丢弃旧地址空间，按 PT_LOAD 建立新映射，在栈顶摆好参数和辅助向量，最后跳到新程序的入口。这一课接着 FORK/EXEC，看子进程从 bash 变成 ls -l 的每一步。',
    facts: [
      ['平台', 'Linux 6.12，x86-64，glibc'],
      ['调用号', 'execve（59）'],
      ['格式处理器', 'load_elf_binary'],
      ['不归路', 'begin_new_exec'],
      ['段的加载方式', '映射，按需读入'],
      ['首条用户指令', '在 ld.so 里'],
    ],
  },
  steps: [
    {
      title: '拷贝参数',
      desc: 'execve 先把参数字符串拷到新栈',
      detail: '子进程调用 execve("/usr/bin/ls", argv, envp)。内核先打开文件，检查执行权限，再新建一个空的 mm_struct，在用户空间顶端放一个临时的栈 VMA。argv 和 envp 的字符串必须现在就从旧地址空间拷过来，因为旧地址空间马上就要被丢掉。到此为止任何一步失败，execve 都会正常返回错误，旧程序继续运行。',
      facts: [['调用号', '59 = execve'], ['新地址空间', '空的 mm_struct'], ['参数字符串', '拷到新栈的顶端'], ['此时失败', '返回错误，旧程序不受影响']],
      events: [
        type('ls -l'),
        state('app', { 程序: 'bash（副本）' }),
        pk('app', 'kernel', 'blue', 'execve', ['/usr/bin/ls'], [0, 'SYSCALL', 'execve("/usr/bin/ls", argv, envp)', 'reg'],
          wire('子进程发起的系统调用', 'regs', 'abi', syscallRegs(59, 'execve', [
            ['rdi', 0x55d0c2a13f20n, 'pathname。', { example: true }],
            ['rsi', 0x55d0c2a14010n, 'argv：指针数组，以 NULL 结尾。', { example: true }],
            ['rdx', 0x55d0c2a10c50n, 'envp：同样以 NULL 结尾。', { example: true }],
          ]))),
        show('ram'),
        pk('kernel', 'ram', 'amber', '拷贝字符串', ['argv + envp'], [14000, 'MEM', 'copy_strings：文件名、envp、argv 依次拷到新栈顶', STRINGS_SIZE + 8],
          wire(`新栈最顶端，${hex(STACK_TOP)} 以下`, 'mem', 'abi', execStrings(STRINGS))),
        state('ram', { 新栈: '只有参数字符串' }),
      ],
    },
    {
      title: '识别格式',
      desc: '读 ELF 头和程序头表',
      detail: '内核读入文件开头 256 字节，交给各个格式处理器逐个辨认。以 #! 开头的交给 binfmt_script，ELF 文件交给 load_elf_binary。它核对魔数、文件类型和机器类型，再按 e_phoff 和 e_phnum 读出整张程序头表。ls 有 13 个程序头，其中 4 个 PT_LOAD 是要映射的段，PT_INTERP 指定动态链接器。',
      facts: [['读入', '文件开头 256 字节'], ['脚本', '#! 开头，交给 binfmt_script'], ['程序头表', '13 × 56 = 728 字节'], ['PT_LOAD', '4 个']],
      events: [
        show('disk'),
        pk('disk', 'kernel', 'teal', 'ELF 头', ['7F 45 4C 46'], [160000, 'BIO', '读文件开头，核对 ELF 魔数', 64],
          wire('/usr/bin/ls 的前 64 字节', 'mem', 'abi', elfHeader({ type: 3, entry: 0x6d30n, phoff: 64n, phnum: 13, shoff: 136232n, shnum: 31, shstrndx: 30 }))),
        pk('disk', 'kernel', 'teal', '程序头表', ['13 项'], [162000, 'MEM', '程序头表在同一页里，直接从页缓存读出', 728],
          wire('整张表 728 字节，这里是连续的第 2 到 5 项', 'mem', 'abi',
            ...LOADS.map((load, index) => programHeader(`程序头[${index + 2}] · PT_LOAD`, { type: 1, align: 0x1000n, ...load }, index === 1 ? 'teal' : 'green')))),
      ],
    },
    {
      title: '丢弃旧映像',
      desc: '过了不归路，换上新的地址空间',
      detail: 'begin_new_exec 是不归路：从这里开始再出错，内核只能杀死进程，因为旧程序已经回不去了。它先让同一进程的其他线程退出，再由 exec_mmap 装上新的 mm_struct，把 CR3 指向新的顶级页表。旧地址空间的引用归零，页表和私有页一起释放。设了 CLOEXEC 的文件描述符被关闭，自定义的信号处理函数恢复成默认，PID 不变。',
      facts: [['函数', 'begin_new_exec'], ['之后再失败', '进程被 SIGKILL'], ['其他线程', '先被终止'], ['信号处理函数', '恢复默认，忽略的仍忽略']],
      events: [
        show('cpu'),
        pk('kernel', 'cpu', 'violet', '换页表', ['CR3 = 新 PML4'], [175000, 'MSR', 'exec_mmap：装上新的 mm，切换 CR3', 'reg'],
          wire('新地址空间的顶级页表', 'regs', 'abi', registers('控制寄存器', [cr3Register(0x2e7a1000n, 6, false)], 'violet')), { locked: true }),
        pk('kernel', 'ram', 'amber', '释放旧 mm', ['mmput'], [181000, 'MEM', '旧地址空间引用归零，释放页表和私有页', null],
          wire('mm_struct 是内核内部结构，这里只讲概念', 'regs', '示意', concept('旧映像的去留', [
            ['丢弃', '旧的 VMA、页表和私有页', 'bash 的代码和堆都不见了。'],
            ['关闭', '设了 CLOEXEC 的 fd', '其余 fd 原样保留，这是重定向能生效的原因。'],
            ['重置', '信号处理函数', '处理函数的代码已经不存在，只能恢复默认。'],
            ['保留', 'PID、当前目录、资源限制', '父进程看到的还是同一个子进程。'],
          ], 'amber'))),
        state('app', { 程序: '旧映像已丢弃' }),
      ],
    },
    {
      title: '映射段',
      desc: '按 PT_LOAD 建立映射，不读数据',
      detail: 'ls 是位置无关的 ET_DYN，内核先随机挑一个加载基址，再对每个 PT_LOAD 调用 vm_mmap，把文件的对应部分映射到基址加 p_vaddr 处，权限取自 p_flags。此时一页数据都没有读，VMA 只记下文件和偏移，第一次访问才缺页读入。数据段的 p_memsz 比 p_filesz 大，多出的 .bss 用匿名页补上。PT_INTERP 指定的 ld.so 也照此映射。',
      facts: [['加载基址', `${hex(BASE)}（随机）`], ['映射方式', 'vm_mmap，按需读入'], ['.bss', '匿名页，初值为 0'], ['解释器', 'ld-linux-x86-64.so.2']],
      events: [
        pk('kernel', 'ram', 'amber', '映射段', ['4 个 PT_LOAD'], [196000, 'MEM', 'elf_load：按 p_flags 为每个段建立 VMA', null],
          wire('结果和 /proc/2891/maps 里看到的一致', 'regs', 'abi', concept('新的 VMA', [
            ['r--', range(0x0n, 0x4000n), '文件偏移 0。ELF 头和只读元数据。'],
            ['r-x', range(0x4000n, 0x19000n), '文件偏移 0x4000。代码段，只有它可执行。'],
            ['r--', range(0x19000n, 0x21000n), '文件偏移 0x19000。只读常量。'],
            ['rw-', range(0x21000n, 0x24000n), '文件偏移 0x20000。已初始化的全局变量，私有映射，写时复制。'],
            ['rw- .bss', range(0x24000n, 0x25000n), '匿名映射。p_memsz 超出 p_filesz 的部分。'],
            ['ld.so', `${hex(INTERP)} 起`, '解释器按同样的方法映射，基址同样随机。'],
          ], 'amber'))),
        state('ram', { 新栈: '只有参数字符串', VMA: '代码、数据、.bss、ld.so' }),
      ],
    },
    {
      title: '建栈',
      desc: '在栈顶放 argc、argv、envp 和 auxv',
      detail: 'setup_arg_pages 把临时栈挪到随机化后的位置，PT_GNU_STACK 决定它不可执行。create_elf_tables 再往下写入 16 字节随机数和平台名，然后从低到高摆好 argc、argv 指针、envp 指针和辅助向量 auxv。新程序的 rsp 就指向 argc。auxv 是内核留给链接器的信息：程序头在哪、入口在哪、页多大，以及 vDSO 和那 16 字节随机数的地址。',
      facts: [['rsp 指向', 'argc'], ['auxv 每项', '16 字节：类型 + 值'], ['本例 auxv', '23 项，以 AT_NULL 结尾'], ['栈', '不可执行']],
      events: [
        pk('kernel', 'ram', 'amber', '写初始栈', ['argc = 2'], [205000, 'MEM', 'create_elf_tables：写 argc、argv、envp 和 auxv', 424],
          wire('布局由 System V x86-64 ABI 规定', 'mem', 'abi', initialStack({
            rsp: RSP,
            argv: [ADDRESS[0], ADDRESS[1]],
            envp: [ADDRESS[2], ADDRESS[3]],
            auxv: [
              ['SYSINFO_EHDR', 0x7ffd3c3f5000n, 'vDSO 的地址。clock_gettime 等调用靠它不用进内核。', { example: true }],
              ['MINSIGSTKSZ', 3632, '信号帧至少要多大，取决于 CPU 的 XSAVE 区大小。', { example: true }],
              ['HWCAP', 0xbfebfbffn, 'CPU 特性位。', { example: true }],
              ['PAGESZ', 4096, '页大小。'],
              ['CLKTCK', 100, 'times() 的时钟频率。'],
              ['PHDR', BASE + 0x40n, '程序头表在内存里的位置：加载基址 + e_phoff。', { example: true }],
              ['PHENT', 56, '每个程序头的大小。'],
              ['PHNUM', 13, '程序头的个数。'],
              ['BASE', INTERP, 'ld.so 的加载基址。', { example: true }],
              ['FLAGS', 0],
              ['ENTRY', ENTRY, 'ls 的入口：加载基址 + e_entry。ld.so 最后跳到这里。', { example: true }],
              ['UID', 1000, '', { example: true }],
              ['EUID', 1000, '', { example: true }],
              ['GID', 1000, '', { example: true }],
              ['EGID', 1000, '', { example: true }],
              ['SECURE', 0, '1 表示 setuid 之类的情形，ld.so 会忽略 LD_PRELOAD 等变量。'],
              ['RANDOM', RANDOM, '指向 16 字节随机数。glibc 用它生成栈保护的金丝雀值。', { example: true }],
              ['HWCAP2', 0x2n, '更多 CPU 特性位，位 1 表示可以在用户态读写 FS 和 GS 基址。', { example: true }],
              ['EXECFN', ADDRESS[4], '指向栈顶的 "/usr/bin/ls"。', { example: true }],
              ['PLATFORM', PLATFORM, '指向字符串 "x86_64"。', { example: true }],
              ['RSEQ_FEATURE_SIZE', 28, 'rseq 结构里内核支持的部分有多大。'],
              ['RSEQ_ALIGN', 32],
              ['NULL', 0, '辅助向量到此结束。'],
            ],
          }))),
        state('ram', { 新栈: 'argc、argv、envp、auxv', VMA: '代码、数据、.bss、ld.so' }),
      ],
    },
    {
      title: '跳到入口',
      desc: '改写 pt_regs，iretq 进入 ld.so',
      detail: 'start_thread 改写内核栈上的 pt_regs：RIP 设为 ld.so 的入口，RSP 设为刚才的栈顶，通用寄存器全部清零。execve 成功后不会回到调用它的地方，因为那段代码已经没有了。由于 rcx 和 RIP 不同，返回走 iretq 而不是 sysret。ld.so 读 auxv，加载 libc 并完成重定位，最后跳到 AT_ENTRY，ls 的 main 才开始运行。',
      facts: [['新 RIP', 'ld.so 的入口'], ['新 RSP', hex(RSP)], ['返回方式', 'iretq'], ['ls 的入口', 'ld.so 最后跳转']],
      events: [
        pk('kernel', 'cpu', 'violet', 'start_thread', ['RIP = ld.so 入口'], [214000, 'SYSRET', 'iretq：从 ld.so 的入口开始执行', 168],
          wire('当前任务内核栈顶的 pt_regs，iretq 从这里恢复', 'mem', 'internal', ptRegs(
            { ip: INTERP_ENTRY, cs: 0x33, flags: 0x200n, sp: RSP, ss: 0x2b, orig_ax: 59 },
            {
              ax: '通用寄存器全部清零，rdx 为 0 表示没有要注册的退出函数。',
              cx: '0，和 ip 不同，所以不能用 sysret。',
              orig_ax: '仍是 execve 的调用号。',
              ip: 'ld.so 的入口，不是 ls 的 e_entry。',
              flags: '0x200：只有 IF 位，中断打开。',
              sp: '指向 argc。',
            },
            'green',
          )), { locked: true }),
        state('cpu', { 特权级: 'Ring 3', CR3: '新页表' }),
        pk('cpu', 'app', 'green', '运行 ls', ['_start'], [720000, 'SW', 'ld.so 完成链接，跳到 AT_ENTRY', null],
          wire('ld.so 读 auxv 之后做的事', 'regs', '示意', concept('动态链接', [
            ['AT_PHDR', '找到 PT_DYNAMIC', '从中得知需要 libc.so.6 等共享库。'],
            ['加载共享库', 'mmap 并重定位', '这一步占了启动时间的大头。'],
            ['AT_RANDOM', '设置栈金丝雀', '函数返回前检查它，防止栈溢出攻击。'],
            ['AT_ENTRY', hex(ENTRY), '最后跳到这里，也就是 ls 的 _start。'],
          ], 'green'))),
        state('app', { 程序: 'ls' }),
        note('app', 'ls -l 开始运行', 'green'),
        render,
      ],
    },
  ],
  outro: {
    title: '换掉一切，只留身份',
    desc: '同一个进程，换了一个程序',
    text: 'execve 之后，代码、数据、堆和栈全是新的，PID、打开的文件和当前目录却留了下来，shell 正是靠这一点在 fork 和 exec 之间设置重定向。真正的加载被推迟到缺页时进行，所以哪怕程序有几百 MiB，execve 本身也只要几百微秒。',
    facts: [['换掉的', '地址空间和信号处理函数'], ['留下的', 'PID、fd、当前目录'], ['下一课', 'CONTEXT SWITCH']],
  },
};
