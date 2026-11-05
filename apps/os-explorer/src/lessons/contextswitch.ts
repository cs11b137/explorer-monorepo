import { concept, cr3Register, inactiveTaskFrame, ptRegs, registers, syscallRegs, wire } from '../decode/structures';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const RET_FROM = 0xffffffff81133a20n;

export const contextswitch: Lesson = {
  id: 'contextswitch',
  name: 'CONTEXT SWITCH',
  title: '上下文切换',
  group: 'process',
  layer: [4, 4],
  timeUnit: 'µs',
  nodes: ['app', 'proc2', 'kernel', 'k2', 'cpu', 'mmu'],
  place: { app: [130, 220], proc2: [130, 510], kernel: [470, 350], k2: [470, 90], cpu: [820, 200], mmu: [820, 500] },
  labels: {
    app: ['进程 A', '即将阻塞'],
    proc2: ['进程 B', '等待运行'],
    kernel: ['内核', 'schedule()'],
    k2: ['调度器', 'CPU 0 运行队列'],
    cpu: ['CPU', 'rsp 指向内核栈'],
    mmu: ['MMU', 'CR3 与 TLB'],
  },
  start: ['app', 'proc2', 'kernel'],
  legend: [['blue', '进入内核'], ['amber', '调度决定'], ['violet', '切换状态'], ['green', '回到用户态'], [null, '时间仅表示量级']],
  overview: {
    full: '让一个 CPU 从一个任务换到另一个任务',
    description: 'CPU 只有一套寄存器。要轮流运行多个任务，就得保存当前任务的状态，再恢复下一个任务的状态。Linux 不用 x86 的硬件任务切换，全部由软件完成，核心只有两件事：换页表，换内核栈。',
    facts: [
      ['平台', 'Linux 6.12，x86-64'],
      ['入口', 'schedule() → context_switch()'],
      ['换地址空间', '写 CR3（线程之间不用）'],
      ['换栈', '__switch_to_asm'],
      ['硬件任务切换', '不使用'],
      ['FPU', '返回用户态前才恢复'],
    ],
  },
  steps: [
    {
      title: '进入内核',
      desc: '进程 A 陷入内核，现场已保存',
      detail: '切换只会发生在内核里。进程 A 调用 read() 读一个没有数据的管道，必须等待。此时它的用户态寄存器已按系统调用那一课的流程保存在自己内核栈顶的 pt_regs 中。每个任务都有自己的内核栈，这是切换的基础。',
      facts: [['切换发生在', '内核态'], ['用户现场', '已在 pt_regs'], ['每个任务', '有独立的内核栈']],
      events: [
        pk('app', 'kernel', 'blue', 'read', ['fd=3，无数据'], [0, 'SYSCALL', 'read(3, buf, 4096)，数据未就绪', 'reg'],
          wire('进程 A 发起的调用', 'regs', 'abi', syscallRegs(0, 'read', [
            ['rdi', 3, 'fd。'],
            ['rsi', 0x7ffc01a2b000n, 'buf。', { example: true }],
            ['rdx', 4096, 'count。'],
          ]))),
        state('app', { 状态: '睡眠' }),
      ],
    },
    {
      title: '选择下一个',
      desc: '调度器选出进程 B',
      detail: '进程 A 把自己标记为睡眠，加入等待队列，然后调用 schedule()。调度器从当前 CPU 的运行队列选出下一个任务 B（如何选见下一课）。接着进入 context_switch()，真正的切换从这里开始。',
      facts: [['函数', 'schedule() → __schedule()'], ['决定', 'pick_next_task'], ['运行队列', '每个 CPU 一个']],
      events: [
        show('k2'),
        pk('kernel', 'k2', 'amber', 'pick_next_task', ['选下一个任务'], [12000, 'SCHED', '当前任务睡眠，请调度器选择', null],
          wire('调度器内部', 'regs', '示意', concept('调度决定', [
            ['prev', '进程 A', '状态已设为可中断睡眠，从运行队列移除。'],
            ['next', '进程 B', '当前最合适的可运行任务。'],
          ], 'amber'))),
        pk('k2', 'kernel', 'amber', 'next = B', ['context_switch'], [18000, 'SCHED', '选中进程 B，开始切换', null],
          wire('task_struct 太大且随版本变化，这里只列相关概念', 'regs', '示意', concept('切换要动的东西', [
            ['mm', '地址空间', 'A 和 B 属于不同进程，要换页表。同进程的线程共用 mm，不用换。'],
            ['thread.sp', '保存的内核栈指针', '__switch_to_asm 用它交换栈。'],
            ['thread.fsbase', 'TLS 基址', '返回用户态前要恢复。'],
          ], 'slate'))),
      ],
    },
    {
      title: '切换地址空间',
      desc: '写 CR3，PCID 让 TLB 得以保留',
      detail: 'switch_mm 把 CR3 写成 B 的顶级页表。早年这一步会清空 TLB，代价很大。有了 PCID，TLB 条目带上地址空间标记，位 63 置 1 可以要求不刷新，切回来时旧条目还能用。内核线程没有用户地址空间，会借用上一个任务的页表，从而跳过这一步。',
      facts: [['操作', 'mov cr3'], ['PCID', '12 位，标记 TLB 条目'], ['位 63', '1 = 不刷新'], ['同进程线程', '跳过此步']],
      events: [
        show('mmu'),
        pk('kernel', 'mmu', 'violet', '写 CR3', ['PCID=7'], [22000, 'MSR', 'switch_mm：切换到进程 B 的页表', 'reg'],
          wire('切换前后的 CR3', 'regs', 'abi', registers('控制寄存器', [
            cr3Register(0x1a2b3000n, 5, false, 'CR3旧'),
            cr3Register(0x3c5d7000n, 7, true, 'CR3新'),
          ], 'violet')), { locked: true }),
        state('mmu', { 地址空间: '进程 B', TLB: 'A 的条目保留' }),
      ],
    },
    {
      title: '切换内核栈',
      desc: '__switch_to_asm 交换 rsp',
      detail: '这是切换的核心，只有十几条汇编。先把被调用者保存的寄存器压到 A 的内核栈，把 rsp 存进 A 的 task，再从 B 的 task 取出 rsp，弹出 B 当年压入的寄存器。执行 ret 时已经身处 B 的栈上，于是返回到 B 上次调用 schedule() 的地方。',
      facts: [['压入', 'rbp rbx r12–r15'], ['关键两条', 'mov rsp 存，mov rsp 取'], ['之后', 'jmp __switch_to'], ['新任务首次运行', '返回到 ret_from_fork']],
      events: [
        show('cpu'),
        pk('kernel', 'cpu', 'violet', '__switch_to_asm', ['换 rsp'], [24000, 'SCHED', '保存 A 的 rsp，加载 B 的 rsp', 56],
          wire('B 的内核栈顶，上次切走时压入的帧', 'mem', 'internal', inactiveTaskFrame(RET_FROM)), { locked: true }),
        note('cpu', '现在运行在 B 的内核栈上', 'green'),
        state('cpu', { 内核栈: '进程 B' }),
      ],
    },
    {
      title: '恢复返回',
      desc: '恢复 TLS，回到进程 B 的用户态',
      detail: '__switch_to 处理剩下的状态：加载 B 的 FS 基址（线程局部存储），更新 TSS 里的内核栈顶。FPU 和向量寄存器不在此时恢复，只是打上 TIF_NEED_FPU_LOAD 标记，等真要返回用户态时才恢复。B 沿自己的内核路径返回，从 pt_regs 恢复用户现场。',
      facts: [['FS 基址', '立即恢复'], ['FPU', '返回用户态前恢复'], ['用户现场', '从 B 的 pt_regs 恢复']],
      events: [
        pk('kernel', 'proc2', 'green', '回到用户态', ['B 继续运行'], [31000, 'SYSRET', '进程 B 的 read 返回', 168],
          wire('进程 B 内核栈顶的 pt_regs', 'mem', 'internal', ptRegs(
            { ax: 512, orig_ax: 0, di: 5, si: 0x7ffc77c10000n, dx: 4096, r11: 0x246n, cx: 0x7f12a8c4b1a7n, ip: 0x7f12a8c4b1a7n, cs: 0x33, flags: 0x246n, sp: 0x7ffc77c0f8a8n, ss: 0x2b },
            { ax: 'B 上次的 read 返回 512 字节。', ip: 'B 被切走前的用户态地址。', orig_ax: '系统调用号 0 = read。' },
            'green',
          ))),
        state('app', { 状态: '睡眠，在等待队列' }),
        state('proc2', { 状态: '运行中' }),
        render,
      ],
    },
  ],
  outro: {
    title: '换页表，换栈',
    desc: '其余状态都跟着栈走',
    text: '切换本身只要 1–2 微秒。但真正的代价往往是间接的：TLB 和 CPU 缓存里都是上一个任务的内容，新任务刚开始会变慢。这也是操作系统尽量让任务留在原来那个 CPU 上的原因。',
    facts: [['直接开销', '微秒级'], ['间接开销', 'TLB 和缓存变冷'], ['下一课', 'SCHEDULER']],
  },
};
