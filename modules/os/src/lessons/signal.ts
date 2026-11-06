import { concept, kernelSigaction, ptRegs, registers, rtSigframe, sigset, syscallRegs, ucontext, wire, type SigcontextValues } from '../decode/structures';
import { hex } from '../decode/writer';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const SERVER = 3307;
const SHELL = 1204;
const SIGUSR1 = 10;
const USR1 = { number: SIGUSR1, name: 'SIGUSR1', on: '待处理', off: '无' };
const HANDLER = 0x5626a1c4f2c0n;
const RESTORER = 0x7f12a8a42050n;
const FLAGS = 0x14000004n;
const BUF = 0x5626a2d3a2a0n;
/** read 封装里 syscall 指令之后的地址，syscall 指令本身占 2 字节。 */
const RIP_AFTER = 0x7f12a8b1c7e2n;
const SYSCALL_INSN = RIP_AFTER - 2n;
const USER_RSP = 0x7ffe5a3c1d48n;
/** get_sigframe：跳过 128 字节红区，放 XSAVE 区（按 64 字节对齐），再放 440 字节的 rt_sigframe。 */
const XSAVE_SIZE = 2700n;
const FPSTATE = (USER_RSP - 128n - XSAVE_SIZE) & ~63n;
const FRAME = ((FPSTATE - 440n) & ~15n) - 8n;
const UC = FRAME + 8n;
const INFO = FRAME + 312n;

/** 被打断时的现场：SA_RESTART 已把 ax 改回调用号，ip 退回到 syscall 指令。 */
const SAVED: SigcontextValues = { di: 5, si: BUF, dx: 4096, ax: 0, cx: RIP_AFTER, sp: USER_RSP, ip: SYSCALL_INSN, flags: 0x246n, fpstate: FPSTATE, mask: 0n };
const SAVED_NOTES = {
  ax: '0 = read 的调用号。SA_RESTART 把 -ERESTARTSYS 改回了调用号。',
  ip: `比 rcx 小 2，指向 syscall 指令本身。`,
  mask: '0：进入处理函数前没有屏蔽任何信号。',
};

export const signal: Lesson = {
  id: 'signal',
  name: 'SIGNAL',
  title: '信号',
  group: 'io',
  layer: [4, 5],
  timeUnit: 'µs',
  nodes: ['proc2', 'kernel', 'k2', 'app', 'ram'],
  place: { proc2: [140, 210], kernel: [500, 340], k2: [860, 150], app: [860, 540], ram: [180, 560] },
  labels: {
    proc2: ['server', `PID ${SERVER}`],
    kernel: ['内核', 'kernel/signal.c'],
    k2: ['信号状态', 'pending 与 sigqueue'],
    app: ['bash', `PID ${SHELL}`],
    ram: ['内存', '内核栈与用户栈'],
  },
  start: ['proc2', 'kernel'],
  legend: [['blue', '系统调用'], ['amber', '登记与取出'], ['violet', '信号帧'], ['green', '唤醒与返回']],
  overview: {
    full: '内核替进程插入一次函数调用',
    description: '信号是内核打断进程的软件机制。kill 只是在目标进程身上置一个位；真正的处理发生在目标下一次从内核返回用户态之前：内核把现场存到用户栈上，改写寄存器让它跳进处理函数，处理完再用 rt_sigreturn 把现场原样恢复。这一课跟踪一个阻塞在 read 上的进程收到 SIGUSR1 的全过程。',
    facts: [
      ['平台', 'Linux 6.12，x86-64，glibc'],
      ['发送', 'kill（62）'],
      ['注册', 'rt_sigaction（13）'],
      ['返回', 'rt_sigreturn（15）'],
      ['处理时机', '返回用户态之前'],
      ['现场存放', '用户栈上的 rt_sigframe'],
    ],
  },
  steps: [
    {
      title: '注册处理函数',
      desc: 'rt_sigaction 记下处理函数和标志',
      detail: 'server 启动时调用 sigaction(SIGUSR1, ...)，glibc 实际发起 rt_sigaction，并自动加上 SA_RESTORER，把返回用的跳板 __restore_rt 一起交给内核。这里设了 SA_SIGINFO，处理函数能拿到发送者的信息；还设了 SA_RESTART，被信号打断的慢速系统调用会自动重来。之后 server 阻塞在 read 上等数据。',
      facts: [['调用号', '13 = rt_sigaction'], ['SIGUSR1', String(SIGUSR1)], ['SA_RESTORER', 'glibc 自动加上'], ['SA_RESTART', '被打断的调用自动重来']],
      events: [
        pk('proc2', 'kernel', 'blue', 'rt_sigaction', ['SIGUSR1'], [0, 'SYSCALL', 'rt_sigaction(SIGUSR1, &act, NULL, 8)', 'reg'],
          wire('glibc sigaction() 发起的系统调用', 'regs', 'abi', syscallRegs(13, 'rt_sigaction', [
            ['rdi', SIGUSR1, 'signum：SIGUSR1。'],
            ['rsi', 0x7ffe5a3c1e10n, 'act。', { example: true }],
            ['rdx', 0, 'oldact：不需要旧值。'],
            ['r10', 8, 'sigsetsize：内核的信号集合是 8 字节。'],
          ]))),
        show('k2'),
        pk('kernel', 'k2', 'amber', '记下处理函数', ['sighand->action[9]'], [3000, 'MEM', '把 act 存进进程的信号处理表', 32],
          wire('act 指向的结构，按内核接口的布局', 'mem', 'abi', kernelSigaction({ handler: HANDLER, flags: FLAGS, restorer: RESTORER, mask: 0n }))),
        state('proc2', { 状态: '睡眠，在 read()' }),
      ],
    },
    {
      title: '发送',
      desc: 'kill 置 pending 位，唤醒目标',
      detail: `在 shell 里执行 kill -USR1 ${SERVER}。内核先检查权限：两个进程属于同一用户，允许发送。接着分配一个 sigqueue 记下发送者的 PID 和 UID，再把 pending 集合里位 9 置 1，信号 n 占位 n-1。普通信号不排队：这一位已经是 1 时，新的这次就被合并掉。最后设置 TIF_SIGPENDING，唤醒处在可中断睡眠的 server。`,
      facts: [['调用号', '62 = kill'], ['pending 位', '位 9（信号号 - 1）'], ['普通信号', '同一信号只记一次'], ['唤醒', '只唤醒可中断睡眠']],
      events: [
        show('app'),
        type(`kill -USR1 ${SERVER}`),
        pk('app', 'kernel', 'blue', 'kill', [`pid ${SERVER}，sig ${SIGUSR1}`], [500000, 'SYSCALL', `kill(${SERVER}, SIGUSR1)`, 'reg'],
          wire('bash 的内建 kill 发起的系统调用', 'regs', 'abi', syscallRegs(62, 'kill', [
            ['rdi', SERVER, 'pid：目标进程。', { example: true }],
            ['rsi', SIGUSR1, 'sig：SIGUSR1。'],
          ]))),
        pk('kernel', 'k2', 'amber', '置 pending 位', ['位 9'], [503000, 'MEM', '__send_signal_locked：sigqueue 入队，置位 pending', 8],
          wire('目标进程 pending 集合里的位图', 'mem', 'internal', sigset('pending.signal', 1n << 9n, USR1, '内核内部字段，位的排法和用户态的 sigset 相同。'))),
        pk('k2', 'proc2', 'green', '唤醒', ['TIF_SIGPENDING'], [505000, 'SCHED', 'signal_wake_up：唤醒可中断睡眠的 server', null],
          wire('kernel/signal.c 的 signal_wake_up_state', 'regs', 'internal', concept('唤醒', [
            ['TIF_SIGPENDING', '1', '返回用户态之前必须检查信号。'],
            ['server', '可中断睡眠 → 可运行', '不可中断睡眠，也就是 D 状态的进程，不会被唤醒。'],
            ['目标正在别的 CPU 上运行', '发 IPI', 'kick_process 让它尽快进入内核，看到这个标志。'],
          ], 'green'))),
        state('proc2', { 状态: '可运行', 待处理: 'SIGUSR1' }),
      ],
    },
    {
      title: '返回前检查',
      desc: 'read 被打断，取出信号，准备重来',
      detail: 'server 醒来时还在 pipe_read 里，发现有信号待处理，就放弃等待，返回 -ERESTARTSYS，这个错误码用户永远看不到。返回用户态之前，内核看到 TIF_SIGPENDING，调用 get_signal 取出 SIGUSR1，清掉 pending 位。处理函数设了 SA_RESTART，所以内核把 ax 改回调用号，把 ip 往回拨 2 字节，正好是 syscall 指令的长度。',
      facts: [['内部返回值', '-ERESTARTSYS（-512）'], ['检查时机', '返回用户态之前'], ['SA_RESTART', 'ip 减 2，重新执行 syscall'], ['没有 SA_RESTART', 'read 返回 -EINTR']],
      events: [
        pk('k2', 'kernel', 'amber', 'get_signal', ['取出 SIGUSR1'], [512000, 'MEM', '返回用户态前检查 TIF_SIGPENDING，取出 SIGUSR1', 8],
          wire('取出后，pending 里的位清零', 'mem', 'internal', sigset('pending.signal', 0n, USR1))),
        show('ram'),
        pk('kernel', 'ram', 'amber', '改 pt_regs', ['ip -= 2'], [514000, 'MEM', 'SA_RESTART：ax 改回调用号，ip 回退 2 字节', 168],
          wire('server 内核栈顶的 pt_regs', 'mem', 'internal', ptRegs(
            { ax: 0, orig_ax: 0, di: 5, si: BUF, dx: 4096, r11: 0x246n, cx: RIP_AFTER, ip: SYSCALL_INSN, cs: 0x33, flags: 0x246n, sp: USER_RSP, ss: 0x2b },
            {
              ax: '原来是 -ERESTARTSYS（-512），改成 orig_ax，也就是 read 的调用号 0。',
              orig_ax: '0 = read。',
              di: 'fd 5，管道的读端。',
              cx: 'syscall 之后那条指令的地址。',
              ip: '比 cx 小 2，回到 syscall 指令本身。',
            },
            'amber',
          ))),
        state('proc2', { 状态: '准备处理信号', 待处理: null }),
      ],
    },
    {
      title: '建信号帧',
      desc: '把现场存到用户栈上',
      detail: 'setup_rt_frame 从当前用户栈往下跳过 128 字节的红区，先放 FPU 和向量寄存器的 XSAVE 区，再放 rt_sigframe：最前面是返回地址 __restore_rt，然后是 ucontext，里面的 sigcontext 存着全部通用寄存器，最后是 siginfo。被打断的现场完整地保存在用户内存里，内核栈上什么也不留。处理期间 SIGUSR1 被屏蔽，同一个信号不会重入。',
      facts: [['红区', '跳过 128 字节'], ['rt_sigframe', '440 字节，另有 XSAVE 区'], ['返回地址', 'sa_restorer'], ['处理期间', '屏蔽 SIGUSR1']],
      events: [
        pk('kernel', 'ram', 'violet', '写信号帧', ['440 字节'], [520000, 'MEM', `setup_rt_frame：在 ${hex(FRAME)} 写 rt_sigframe`, 440],
          wire('布局见 arch/x86/include/asm/sigframe.h 和 uapi 头文件', 'mem', 'abi',
            ...rtSigframe({ ...SAVED, restorer: RESTORER, signo: SIGUSR1, pid: SHELL, uid: 1000 }, SAVED_NOTES))),
        state('proc2', { 状态: '准备处理信号', 屏蔽: 'SIGUSR1' }),
      ],
    },
    {
      title: '运行处理函数',
      desc: '改写寄存器，跳进处理函数',
      detail: '内核把要返回的寄存器改成调用处理函数的样子：ip 指向处理函数，sp 指向信号帧，参数按普通函数的调用约定放在 rdi、rsi、rdx，分别是信号编号、siginfo 和 ucontext 的地址。回到用户态后，server 就像被谁调用了一次 on_usr1(10, info, uc)。处理函数里只应调用异步信号安全的函数，比如 write，不能调用 printf 或 malloc，因为被打断的代码可能正持有它们的锁。',
      facts: [['rdi', `${SIGUSR1}（信号编号）`], ['rsi', 'siginfo 的地址'], ['rdx', 'ucontext 的地址'], ['只能调用', '异步信号安全的函数']],
      events: [
        pk('kernel', 'proc2', 'green', '跳到处理函数', ['ip = on_usr1'], [524000, 'SYSRET', '返回用户态，从处理函数开始执行', 'reg'],
          wire('setup_rt_frame 改写后的寄存器', 'regs', 'abi', registers('进入处理函数', [
            ['RIP', HANDLER, '处理函数 on_usr1 的地址。', { example: true }],
            ['RSP', FRAME, '指向 pretcode，就像刚被 call 指令调用，返回地址在栈顶。', { example: true }],
            ['rdi', SIGUSR1, '第 1 个参数：信号编号。'],
            ['rsi', INFO, '第 2 个参数：信号帧里 siginfo 的地址。', { example: true }],
            ['rdx', UC, '第 3 个参数：信号帧里 ucontext 的地址。', { example: true }],
            ['rax', 0, '清零。'],
          ], 'green')), { locked: true }),
        note('proc2', 'on_usr1(10, info, uc)'),
        state('proc2', { 状态: '运行处理函数', 屏蔽: 'SIGUSR1' }),
      ],
    },
    {
      title: '恢复现场',
      desc: 'rt_sigreturn 读回信号帧',
      detail: '处理函数执行 ret，弹出的返回地址是 __restore_rt。它只有两条指令：把 15 放进 rax，执行 syscall。rt_sigreturn 按 rsp 找到信号帧，从 sigcontext 恢复全部寄存器，从 uc_sigmask 恢复屏蔽字，再回到用户态。ip 正好指向 read 的 syscall 指令，于是 read 重新执行，server 继续等数据，好像什么都没发生过。',
      facts: [['调用号', '15 = rt_sigreturn'], ['__restore_rt', 'mov $15, %rax 和 syscall'], ['恢复', '寄存器和屏蔽字'], ['之后', 'read 重新执行']],
      events: [
        pk('proc2', 'kernel', 'blue', 'rt_sigreturn', ['rax = 15'], [560000, 'SYSCALL', '处理函数返回到 __restore_rt，发起 rt_sigreturn', 'reg'],
          wire('__restore_rt 发起的系统调用，没有参数', 'regs', 'abi', syscallRegs(15, 'rt_sigreturn', [
            ['rsp', UC, 'ret 弹出了返回地址，rsp 正好指向 ucontext。内核用 rsp - 8 找到信号帧。', { example: true }],
          ]))),
        pk('ram', 'kernel', 'violet', '读回现场', ['sigcontext'], [561000, 'MEM', 'restore_sigcontext：从用户栈读回寄存器和屏蔽字', 304],
          wire(`信号帧里的 ucontext，位于 ${hex(UC)}`, 'mem', 'abi', ...ucontext(SAVED, SAVED_NOTES))),
        pk('kernel', 'proc2', 'green', '回到 read', ['ip = syscall 指令'], [563000, 'SYSRET', '回到被打断的地方，read 重新执行', 'reg'],
          wire('恢复后的寄存器', 'regs', 'abi', registers('恢复', [
            ['RIP', SYSCALL_INSN, 'read 封装里的 syscall 指令。', { example: true }],
            ['RSP', USER_RSP, '回到被打断时的栈，信号帧所在的区域不再使用。', { example: true }],
            ['rax', 0, 'read 的调用号，syscall 指令马上会再次发起 read。'],
          ], 'green'))),
        state('proc2', { 状态: '睡眠，在 read()', 屏蔽: null }),
        render,
      ],
    },
  ],
  outro: {
    title: '借用户栈完成的跳转',
    desc: '内核在返回路上做了一次改道',
    text: '信号不需要目标配合，也不需要新的线程：内核只是在它返回用户态时改了一次道，现场存在用户栈上，由 rt_sigreturn 收回。SIGKILL 和 SIGSTOP 不能被捕获，也不走这条路。管道一课里写者收到的 SIGPIPE 也是信号，只是由内核发出，默认动作是终止进程。',
    facts: [['不能捕获', 'SIGKILL、SIGSTOP'], ['现场', '存在用户栈上'], ['全部学完', '回到上面选择任一课']],
  },
};
