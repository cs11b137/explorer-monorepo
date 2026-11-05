import { concept, ptRegs, registers, syscallRegs, userBytes, wire } from '../decode/structures';
import { pk, render, note, state, show, type } from './dsl';
import type { Lesson } from './types';

const BUF = 0x7ffd3c21a4e0n;
const USER_RIP = 0x7f8e41d2b1a7n;
const RFLAGS = 0x246n;
const USER_RSP = 0x7ffd3c21a4c8n;
const LSTAR = 0xffffffff81e00080n;
const KERNEL_RSP = 0xffffc90000a43f58n;
const ENOSYS = -38n;

export const syscall: Lesson = {
  id: 'syscall',
  name: 'SYSCALL',
  title: '系统调用',
  group: 'process',
  layer: [5, 5],
  timeUnit: 'ns',
  nodes: ['app', 'cpu', 'kernel', 'ram'],
  place: { app: [170, 440], cpu: [500, 180], kernel: [810, 430], ram: [500, 520] },
  labels: {
    app: ['用户进程', 'PID 1204 · Ring 3'],
    cpu: ['CPU', '当前核心'],
    kernel: ['内核', 'Ring 0'],
    ram: ['内存', '用户页与内核栈'],
  },
  start: ['app'],
  legend: [['blue', '用户态准备'], ['violet', '特权切换'], ['amber', '内核处理'], ['green', '返回用户态'], [null, '时间仅表示量级']],
  overview: {
    full: '用户程序请求内核服务的唯一入口',
    description: '程序不能直接操作硬件，也不能读写内核内存。想写文件、开网络、要内存，都要执行 syscall 指令，让 CPU 切到内核，做完再切回来。这一课跟踪一次 write(1, "hi", 2)，看每个寄存器和每一步切换。',
    facts: [
      ['平台', 'Linux 6.12，x86-64'],
      ['入口指令', 'syscall（0F 05）'],
      ['返回指令', 'sysret（48 0F 07）'],
      ['调用号', 'rax'],
      ['参数', 'rdi rsi rdx r10 r8 r9'],
      ['返回值', 'rax，-4095 到 -1 表示错误'],
    ],
  },
  steps: [
    {
      title: '准备参数',
      desc: '把调用号和参数放进寄存器',
      detail: 'glibc 的 write() 只是个薄封装：把调用号 1 放进 rax，把文件描述符、缓冲区地址和长度依次放进 rdi、rsi、rdx。第四个参数用 r10 而不是普通函数约定的 rcx，因为 syscall 指令会覆盖 rcx。',
      facts: [['调用号', '1 = write'], ['fd', '1（标准输出）'], ['count', '2 字节']],
      events: [
        type('printf hi'),
        show('cpu'),
        pk('app', 'cpu', 'blue', '填寄存器', ['rax=1 rdi=1', 'rsi=buf rdx=2'], [0, 'SW', 'mov 系统调用号和参数到寄存器', 'reg'],
          wire('用户态，glibc 的 write() 封装', 'regs', 'abi', syscallRegs(1, 'write', [
            ['rdi', 1, 'fd：标准输出'],
            ['rsi', BUF, 'buf：用户缓冲区地址', { example: true }],
            ['rdx', 2, 'count：2 字节'],
          ]))),
      ],
    },
    {
      title: '执行 syscall',
      desc: 'CPU 从 Ring 3 跳到内核入口',
      detail: 'syscall 指令由硬件完成四件事：把下一条指令地址存进 rcx，把 RFLAGS 存进 r11，按 MSR 里的值加载 RIP 和 CS，再用 SFMASK 清掉部分标志位。它不查 IDT，不切栈，也不往内存压任何东西。',
      facts: [['新 RIP', '来自 IA32_LSTAR'], ['新 CS', '来自 IA32_STAR'], ['是否压栈', '否，栈还是用户栈']],
      events: [
        pk('app', 'cpu', 'violet', 'syscall', ['0F 05'], [38, 'SYSCALL', 'syscall 指令：Ring 3 → Ring 0', 'reg'],
          wire('CPU 执行 syscall 后，硬件更新的寄存器', 'regs', 'abi', registers('硬件自动保存', [
            ['rcx', USER_RIP, '用户态下一条指令地址。sysret 靠它返回。', { example: true }],
            ['r11', RFLAGS, '用户态的 RFLAGS。', { example: true }],
          ], 'violet')), { locked: true }),
        state('cpu', { 特权级: 'Ring 0', 栈: '仍是用户栈' }),
        show('kernel'),
        pk('cpu', 'kernel', 'violet', '进入内核', ['RIP = LSTAR'], [52, 'MSR', '跳到 entry_SYSCALL_64', 'reg'],
          wire('内核启动时写好的三个 MSR', 'regs', 'abi', registers('系统调用 MSR', [
            ['IA32_LSTAR', LSTAR, 'MSR 0xC0000082。64 位 syscall 的入口地址。', { example: true }],
            ['IA32_STAR', 0x0023001000000000n, 'MSR 0xC0000081。高位给出内核和用户的段选择子。'],
            ['IA32_FMASK', 0x257fd5n, 'MSR 0xC0000084。进入时要清除的 RFLAGS 位，其中包括 IF，所以此刻中断是关的。'],
          ], 'slate')), { locked: true }),
      ],
    },
    {
      title: '切换内核栈',
      desc: 'swapgs，再换到每个任务的内核栈',
      detail: '入口代码还在用户栈上，不能相信它。第一条是 swapgs，让 GS 指向当前 CPU 的数据；接着把用户 rsp 暂存起来，如果开着页表隔离（PTI）就切 CR3，最后才把 rsp 换成内核栈顶。不受熔断漏洞影响的 CPU 不开 PTI，也就没有那次 CR3 切换。',
      facts: [['第一条指令', 'swapgs'], ['用户 rsp', '暂存到 per-CPU 区域'], ['CR3 切换', '只在开启 PTI 时发生']],
      events: [
        pk('kernel', 'cpu', 'amber', '换栈', ['swapgs', 'rsp = 内核栈顶'], [64, 'SW', 'entry_SYSCALL_64: swapgs，切换到内核栈', 'reg'],
          wire('arch/x86/entry/entry_64.S 开头几条指令', 'regs', 'abi', registers('切换后', [
            ['rsp', KERNEL_RSP, '当前任务内核栈的栈顶。', { example: true }],
          ], 'amber')), { locked: true }),
        state('cpu', { 特权级: 'Ring 0', 栈: '内核栈' }),
      ],
    },
    {
      title: '保存现场',
      desc: '在内核栈上构造 pt_regs',
      detail: '内核把用户现场压到栈上，形成 pt_regs：硬件没存的由软件自己存。注意 ip 取自 rcx，flags 取自 r11，orig_ax 存调用号。ax 先写成 -ENOSYS，万一调用号无效，返回值就已经是对的。',
      facts: [['结构大小', '168 字节'], ['orig_ax', '1（调用号）'], ['ax 初值', '-ENOSYS（-38）']],
      events: [
        show('ram'),
        pk('kernel', 'ram', 'amber', '压栈 pt_regs', ['168 字节'], [96, 'MEM', '在内核栈上构造 pt_regs', 168],
          wire('当前任务的内核栈顶', 'mem', 'internal', ptRegs(
            { ax: ENOSYS, orig_ax: 1, di: 1, si: BUF, dx: 2, r11: RFLAGS, cx: USER_RIP, ip: USER_RIP, cs: 0x33, flags: RFLAGS, sp: USER_RSP, ss: 0x2b },
            {
              ax: '先写成 -ENOSYS，函数返回后被实际返回值覆盖。',
              orig_ax: '系统调用号。',
              cx: 'syscall 把返回地址放在 rcx，所以这里和 ip 相同。',
              r11: 'syscall 把 RFLAGS 放在 r11，所以这里和 flags 相同。',
              ip: '用户态返回地址。',
              cs: '0x33：用户 64 位代码段，低 2 位是特权级 3。',
              sp: '用户栈指针。',
            },
          ))),
      ],
    },
    {
      title: '分发返回',
      desc: '执行 sys_write，再 sysret 回用户态',
      detail: 'do_syscall_64 用调用号查 sys_call_table，调用到 sys_write。内核通过 copy_from_user 读取用户缓冲区，地址不合法也只会返回错误，不会崩溃。返回值写进 pt_regs 的 ax，再用 sysret 回到用户态；不满足条件时（比如返回地址不规范）改走较慢的 iretq。',
      facts: [['分发表', 'sys_call_table'], ['读用户内存', 'copy_from_user'], ['返回值', 'rax = 2']],
      events: [
        pk('ram', 'kernel', 'amber', '读缓冲区', ['"hi"'], [410, 'MEM', 'copy_from_user 读取 2 字节', 2],
          wire('用户缓冲区', 'mem', 'abi', userBytes('用户缓冲区', 'hi'))),
        note('kernel', 'sys_write 写入终端'),
        pk('kernel', 'cpu', 'green', 'sysret', ['48 0F 07'], [1650, 'SYSRET', 'sysret：Ring 0 → Ring 3', 'reg'],
          wire('sysret 从 rcx 和 r11 恢复用户现场', 'regs', 'abi', registers('恢复前的寄存器', [
            ['rax', 2, '返回值：写入了 2 字节。'],
            ['rcx', USER_RIP, '硬件把它加载到 RIP。', { example: true }],
            ['r11', RFLAGS, '硬件把它加载到 RFLAGS。', { example: true }],
          ], 'green')), { locked: true }),
        state('cpu', { 特权级: 'Ring 3', 栈: '用户栈' }),
        pk('cpu', 'app', 'green', '继续运行', ['rax = 2'], [1690, 'SYSRET', 'write() 返回 2', 'reg'],
          wire('回到用户态', 'regs', 'abi', concept('用户态视角', [
            ['返回值', '2', 'glibc 发现 rax 不在 -4095..-1 之间，直接返回给调用者；否则会设置 errno 并返回 -1。'],
            ['rcx 和 r11', '已被覆盖', '所以 syscall 约定里，这两个寄存器不保留。'],
          ], 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '一次特权切换',
    desc: '硬件只做最少的事，其余都由内核完成',
    text: 'syscall 只负责切特权级和跳转，换栈、保存现场、分发都是内核的代码。这让系统调用比旧的 int 0x80 更快：后者要查 IDT，还要由硬件压栈；它现在只用于 32 位 ABI。',
    facts: [['硬件做的', '存 rcx 和 r11，载入 RIP 和 CS'], ['内核做的', '换栈、存现场、分发'], ['下一课', 'FORK/EXEC']],
  },
};
