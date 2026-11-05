import { concept, lvtTimer, registers, schedAttr, wire } from '../decode/structures';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

export const scheduler: Lesson = {
  id: 'scheduler',
  name: 'SCHEDULER',
  title: '调度',
  group: 'process',
  layer: [4, 4],
  timeUnit: 'µs',
  nodes: ['apic', 'cpu', 'kernel', 'k2', 'app', 'proc2'],
  place: { apic: [130, 130], cpu: [430, 130], kernel: [430, 420], k2: [760, 250], app: [130, 500], proc2: [810, 540] },
  labels: {
    apic: ['LAPIC', '本地定时器'],
    cpu: ['CPU 0', '正在运行 A'],
    kernel: ['内核', '定时器中断'],
    k2: ['运行队列', 'EEVDF · CPU 0'],
    app: ['进程 A', 'nice 0 → 5'],
    proc2: ['进程 B', 'nice 0'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['amber', '定时器'], ['violet', '调度记账'], ['green', '切换任务'], [null, '虚拟时间为示意值']],
  overview: {
    full: '决定下一个由谁运行',
    description: 'Linux 6.6 起，普通任务由 EEVDF 调度：每个任务都有虚拟截止时间，调度器从「不欠时间」的任务里，选截止时间最早的那个。这一课跟踪定时器中断如何记账、如何请求重调度，以及切换为什么不在中断里立刻发生。',
    facts: [
      ['平台', 'Linux 6.12'],
      ['算法', 'EEVDF，取代了 CFS 的挑选逻辑'],
      ['合格条件', '滞后量 lag ≥ 0'],
      ['挑选规则', '虚拟截止时间最早'],
      ['基础时间片', '0.75 ms × (1 + log₂ CPU 数)'],
      ['定时器', 'LAPIC TSC-deadline'],
    ],
  },
  steps: [
    {
      title: '设置优先级',
      desc: 'nice 决定虚拟时间走多快',
      detail: '进程 A 把自己的 nice 调到 5。nice 不直接决定时间片长短，而是换算成权重：权重越低，虚拟时间走得越快，同样的实际时间会更快耗完它的份额。sched_setattr 是这一设置的完整接口，nice() 和 setpriority() 是简化版。',
      facts: [['调用号', '314 = sched_setattr'], ['nice 范围', '-20 到 19'], ['nice 0 的权重', '1024'], ['nice 5 的权重', '335']],
      events: [
        pk('app', 'kernel', 'blue', 'sched_setattr', ['nice = 5'], [0, 'SYSCALL', 'sched_setattr(0, &attr, 0)', 56],
          wire('传入内核的结构。内核按 size 字段兼容不同版本', 'mem', 'abi', schedAttr({ nice: 5 }))),
        show('k2'),
        state('k2', { A: 'nice 5，权重 335', B: 'nice 0，权重 1024' }),
      ],
    },
    {
      title: '定时器到期',
      desc: 'LAPIC 在预设时刻发出中断',
      detail: '现代内核不再固定周期计时，而是把下一次到期的 TSC 值写进 IA32_TSC_DEADLINE。TSC 走到那个值时，LAPIC 用向量 0xEC 打断 CPU。进程 A 正在用户态运行，它感觉不到，CPU 按中断那一课的流程进入内核。',
      facts: [['向量', '0xEC（LOCAL_TIMER_VECTOR）'], ['到期寄存器', 'IA32_TSC_DEADLINE（MSR 0x6E0）'], ['模式', 'TSC-deadline']],
      events: [
        show('apic', 'cpu'),
        pk('apic', 'cpu', 'amber', '定时器中断', ['向量 0xEC'], [4000000, 'IRQ', 'TSC 到达 deadline，LAPIC 发出中断', 'reg'],
          wire('LAPIC 定时器的配置', 'regs', 'abi', registers('定时器寄存器', [
            lvtTimer(0xec),
            ['TSC_DEADLINE', 0x2f4a81c3d90n, 'MSR 0x6E0。到达这个 TSC 值时触发。', { example: true }],
          ], 'amber'))),
        pk('cpu', 'kernel', 'amber', '进入内核', ['sysvec_apic_timer'], [4000004, 'IRQ', '进入定时器中断处理', null],
          wire('处理路径', 'regs', '示意', concept('调用链', [
            ['入口', 'sysvec_apic_timer_interrupt', ''],
            ['高精度定时器', 'hrtimer_interrupt', ''],
            ['调度节拍', 'sched_tick → task_tick_fair', '由它进入 CFS/EEVDF 的记账代码。'],
          ], 'amber'))),
        state('cpu', { 正在运行: 'A，在中断中' }),
      ],
    },
    {
      title: '记账',
      desc: '更新进程 A 的 vruntime',
      detail: 'update_curr 算出 A 实际跑了多久，再按权重折算成虚拟时间：增量等于实际时间 × 1024 ÷ 权重。A 的权重是 335，所以虚拟时间走得约为实际时间的 3 倍。这些数字都在内核内部的 sched_entity 里，版本之间会变化，这里只讲概念。',
      facts: [['函数', 'update_curr'], ['公式', 'Δv = Δt × 1024 ÷ weight'], ['A 的倍率', '约 3.06 倍']],
      events: [
        pk('kernel', 'k2', 'violet', 'update_curr', ['vruntime +='], [4000010, 'SCHED', '按权重累计 A 的虚拟时间', null],
          wire('sched_entity 的字段随版本变化，下面是示意值', 'regs', '示意', concept('进程 A 的调度实体', [
            ['实际运行', '+1.0 ms', '这次距上次记账的时间。'],
            ['权重', '335', 'nice 5。'],
            ['虚拟时间增量', '+3.06 ms', '1.0 × 1024 ÷ 335。'],
          ], 'violet'))),
        state('k2', { A: 'v=12.1，截止 12.0', B: 'v=10.2，截止 13.2' }),
      ],
    },
    {
      title: '判断耗尽',
      desc: 'vruntime 越过截止时间',
      detail: 'update_deadline 发现 A 的虚拟时间已经超过截止时间，说明这一片用完了。它给 A 重新计算截止时间：当前虚拟时间加上时间片按权重折算的值。基础时间片是 0.75 毫秒，再乘以 1 + log₂(CPU 数)，CPU 数按最多 8 个算，所以 8 核及以上是 3 毫秒。',
      facts: [['基础时间片', '0.75 ms（Linux 6.12）'], ['8 核时', '0.75 × (1 + 3) = 3 ms'], ['新截止时间', 'vruntime + slice ÷ 权重比']],
      events: [
        note('k2', 'A 的这一片用完了', 'amber'),
        pk('k2', 'kernel', 'violet', 'update_deadline', ['A 用完时间片'], [4000014, 'SCHED', 'vruntime ≥ deadline，重算截止时间', null],
          wire('kernel/sched/fair.c 的 update_deadline', 'regs', '示意', concept('判断', [
            ['条件', 'vruntime - deadline >= 0', '否则这片还没用完，什么也不做。'],
            ['时间片', '3 ms', '8 核默认值：0.75 ms × 4。'],
            ['新截止时间', 'v + 3 × 1024 ÷ 335 ≈ v + 9.2', '权重低的任务截止时间离得更远，所以排得更靠后。'],
          ], 'violet'))),
        state('k2', { A: 'v=12.1，截止 21.3', B: 'v=10.2，截止 13.2' }),
      ],
    },
    {
      title: '设标志',
      desc: '只请求重调度，此刻并不切换',
      detail: '这是常被讲错的一点。中断处理程序不会立刻切换任务，只是调用 resched_curr 给当前任务设置 TIF_NEED_RESCHED 标志，然后继续把中断处理完。这个标志会在几个安全点被检查，最常见的就是中断返回前。',
      facts: [['函数', 'resched_curr'], ['标志', 'TIF_NEED_RESCHED'], ['此时是否切换', '否'], ['切换时机', '中断或系统调用返回前']],
      events: [
        pk('kernel', 'cpu', 'violet', '设 NEED_RESCHED', ['只打标记'], [4000016, 'SCHED', 'resched_curr：标记当前任务需要重调度', null],
          wire('线程标志位', 'regs', 'internal', concept('thread_info.flags', [
            ['TIF_NEED_RESCHED', '1', '只是一个标志位，表示「尽快重新调度」。'],
            ['切换发生了吗', '没有', '中断处理程序会继续执行到结束。'],
          ], 'violet'))),
        state('cpu', { 正在运行: 'A，待重调度' }),
      ],
    },
    {
      title: '抢占',
      desc: '中断返回前选合格且截止最早的任务',
      detail: '中断返回前，内核检查标志，发现需要重调度，于是调用 schedule。EEVDF 先筛出合格的任务（lag ≥ 0，即没有多用份额的），再从中选虚拟截止时间最早的。B 的截止时间更早，被选中。接下来就是上一课讲的上下文切换。',
      facts: [['检查点', '中断返回到用户态前'], ['挑选', 'pick_eevdf'], ['结果', '切到进程 B']],
      events: [
        pk('kernel', 'k2', 'green', 'pick_eevdf', ['选合格且最早'], [4000030, 'SCHED', '从合格任务中选虚拟截止时间最早的', null],
          wire('挑选规则，数值为示意', 'regs', '示意', concept('候选任务', [
            ['进程 A', '截止 21.3，lag < 0', '多用了份额，暂时不合格。'],
            ['进程 B', '截止 13.2，lag ≥ 0', '合格且截止最早，被选中。'],
          ], 'green'))),
        show('proc2'),
        pk('k2', 'proc2', 'green', '切到 B', ['context_switch'], [4000040, 'SCHED', '上下文切换到进程 B', null],
          wire('接下来的过程见 CONTEXT SWITCH 一课', 'regs', '示意', concept('结果', [
            ['next', '进程 B', ''],
            ['进程 A', '回到运行队列', '仍然可运行，等下次被选中。'],
          ], 'green'))),
        state('cpu', { 正在运行: 'B' }),
        render,
      ],
    },
  ],
  outro: {
    title: '公平来自虚拟时间',
    desc: '权重决定份额，截止时间决定次序',
    text: 'EEVDF 把「拿多少」和「谁先拿」分开：滞后量保证长期公平，虚拟截止时间让短时间片的任务更早得到响应。这比 CFS 靠启发式调整延迟的做法更有依据。关键是：定时器只负责记账和打标记，切换留到安全点才发生。',
    facts: [['长期公平', '靠 lag'], ['短期响应', '靠虚拟截止时间'], ['下一课', 'FUTEX']],
  },
};
