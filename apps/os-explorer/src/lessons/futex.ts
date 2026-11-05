import { concept, futexWord, pthreadMutex, syscallRegs, wire } from '../decode/structures';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const UADDR = 0x55d0c2a140a0n;

export const futex: Lesson = {
  id: 'futex',
  name: 'FUTEX',
  title: '互斥锁',
  group: 'process',
  layer: [4, 6],
  timeUnit: 'µs',
  nodes: ['app', 'proc2', 'ram', 'kernel', 'k2'],
  place: { app: [130, 150], proc2: [130, 520], ram: [480, 90], kernel: [500, 330], k2: [850, 530] },
  labels: {
    app: ['线程 A', 'TID 3001 · CPU 0'],
    proc2: ['线程 B', 'TID 3002 · CPU 1'],
    ram: ['共享内存', 'pthread_mutex_t'],
    kernel: ['内核', 'sys_futex'],
    k2: ['futex 哈希桶', '等待队列'],
  },
  start: ['app', 'ram'],
  legend: [['green', '用户态原子操作'], ['blue', '系统调用'], ['violet', '内核队列'], ['amber', '唤醒'], [null, '0/1/2 是 glibc 的约定']],
  overview: {
    full: 'Fast Userspace Mutex，无竞争时不进内核',
    description: 'pthread 互斥锁的核心是用户内存里的一个 32 位整数。抢锁只用一条原子指令，只有真的要等时才进入内核睡眠。内核根本不知道「锁」的存在，它只负责「如果这个地址的值还是 X，就让我睡」和「叫醒睡在这个地址上的线程」。',
    facts: [
      ['平台', 'glibc，x86-64'],
      ['锁字', '32 位整数'],
      ['快速路径', 'lock cmpxchg，无系统调用'],
      ['慢速路径', 'futex（202）'],
      ['glibc 约定', '0 空闲，1 持有，2 可能有人等'],
      ['排队顺序', '不保证先到先得'],
    ],
  },
  steps: [
    {
      title: '快速路径',
      desc: 'lock cmpxchg 把 0 换成 1',
      detail: '线程 A 调用 pthread_mutex_lock。glibc 对 __lock 字段执行一条 lock cmpxchg，如果值是 0 就原子地换成 1。成功就直接返回，全程不进内核，只花几十纳秒。绝大多数加锁都走这条路。lock 前缀保证多核之间不会同时成功。',
      facts: [['指令', 'lock cmpxchg'], ['期望值', '0'], ['写入值', '1'], ['系统调用', '无']],
      events: [
        pk('app', 'ram', 'green', 'lock cmpxchg', ['0 → 1'], [0, 'MEM', '原子地把锁字从 0 改成 1：成功', 4],
          wire('互斥锁在内存里的完整布局', 'mem', 'abi', pthreadMutex(1, 3001, 1)), { locked: true }),
        state('ram', { 锁字: '1', 持有者: 'A' }),
      ],
    },
    {
      title: '竞争',
      desc: 'B 抢锁失败，把锁字设为 2',
      detail: '线程 B 在另一个 CPU 上也来抢锁，cmpxchg 失败，因为值已经是 1。B 进入 __lll_lock_wait，用 xchg 把锁字原子地设成 2，表示「可能有人在等」。如果 xchg 返回 0，说明锁刚好被释放，B 就直接拿到了。这里返回的是 1，所以 B 只能去睡。',
      facts: [['cmpxchg 结果', '失败，当前值 1'], ['接着执行', 'xchg 写入 2'], ['写 2 的含义', '解锁者要负责唤醒']],
      events: [
        show('proc2'),
        pk('proc2', 'ram', 'green', 'lock cmpxchg', ['期望 0，实际 1'], [120000, 'MEM', '抢锁失败：当前值是 1', 4],
          wire('B 看到的锁字', 'mem', 'abi', futexWord(1, 1)), { locked: true, quick: true }),
        pk('proc2', 'ram', 'green', 'xchg', ['1 → 2'], [121000, 'MEM', '__lll_lock_wait：把锁字设为 2，旧值 1', 4],
          wire('标记为「可能有等待者」', 'mem', 'abi', futexWord(2, 1)), { locked: true, quick: true }),
        state('ram', { 锁字: '2', 持有者: 'A' }),
      ],
    },
    {
      title: '睡眠',
      desc: 'FUTEX_WAIT 在桶锁内复查值',
      detail: 'B 调用 futex(uaddr, FUTEX_WAIT_PRIVATE, 2)。内核用地址哈希到一个桶，持有桶锁，再读一次锁字。只有值仍是 2 才入队睡觉；否则立刻返回 EAGAIN。这次复查发生在桶锁内，是整个机制的关键：它堵住了「检查之后、入睡之前被解锁」的漏洞，避免丢失唤醒。',
      facts: [['调用号', '202 = futex'], ['操作', '0x80 = FUTEX_WAIT_PRIVATE'], ['期望值', '2'], ['值变了', '返回 EAGAIN']],
      events: [
        show('kernel'),
        pk('proc2', 'kernel', 'blue', 'FUTEX_WAIT', ['val = 2'], [125000, 'SYSCALL', 'futex(uaddr, FUTEX_WAIT_PRIVATE, 2, NULL)', 'reg'],
          wire('进入慢速路径', 'regs', 'abi', syscallRegs(202, 'futex', [
            ['rdi', UADDR, 'uaddr：锁字的用户地址。', { example: true }],
            ['rsi', 0x80, 'op：FUTEX_WAIT（0）| FUTEX_PRIVATE_FLAG（0x80）。'],
            ['rdx', 2, 'val：只有锁字等于 2 才睡。'],
            ['r10', 0, 'timeout：无限等待。'],
          ]))),
        pk('ram', 'kernel', 'violet', '复查锁字', ['= 2，可以睡'], [127000, 'MEM', '持桶锁时再次读取锁字', 4],
          wire('内核读取的值', 'mem', 'abi', futexWord(2, 2))),
        show('k2'),
        pk('kernel', 'k2', 'violet', '入队', ['B 进入桶'], [129000, 'SCHED', '把 B 加入哈希桶的等待队列并睡眠', null],
          wire('futex_q 是内核内部结构，这里只讲概念', 'regs', '示意', concept('哈希桶', [
            ['键', '地址空间 + 虚拟地址', 'FUTEX_PRIVATE 时可以用这个更快的键。'],
            ['等待者', '线程 B', '状态变为可中断睡眠。'],
            ['桶锁', '已释放', '和复查、入队是同一个临界区。'],
          ], 'violet'))),
        state('k2', { 等待者: 'B' }),
        state('proc2', { 状态: '睡眠' }),
      ],
    },
    {
      title: '解锁',
      desc: 'A 交换为 0，旧值为 2 则唤醒',
      detail: 'A 解锁时用原子操作把锁字换成 0，并查看旧值。旧值是 1 就到此结束，没有系统调用。这次旧值是 2，说明可能有人在等，于是调用 FUTEX_WAKE。内核找到桶里的 B，把它放回运行队列。解锁和唤醒之间，别的线程仍可能抢先拿到锁。',
      facts: [['操作', 'xchg 写入 0'], ['旧值 1', '不进内核'], ['旧值 2', '调用 FUTEX_WAKE'], ['唤醒数量', '1 个']],
      events: [
        pk('app', 'ram', 'green', 'xchg', ['2 → 0'], [840000, 'MEM', '解锁：写入 0，旧值是 2', 4],
          wire('互斥锁现在是空闲的', 'mem', 'abi', pthreadMutex(0, 0, 0)), { locked: true }),
        state('ram', { 锁字: '0', 持有者: '无' }),
        pk('app', 'kernel', 'blue', 'FUTEX_WAKE', ['val = 1'], [843000, 'SYSCALL', 'futex(uaddr, FUTEX_WAKE_PRIVATE, 1)', 'reg'],
          wire('唤醒一个等待者', 'regs', 'abi', syscallRegs(202, 'futex', [
            ['rdi', UADDR, 'uaddr。', { example: true }],
            ['rsi', 0x81, 'op：FUTEX_WAKE（1）| FUTEX_PRIVATE_FLAG（0x80）。'],
            ['rdx', 1, '最多唤醒 1 个线程。'],
          ]))),
        pk('k2', 'proc2', 'amber', '唤醒 B', ['放回运行队列'], [846000, 'SCHED', '从哈希桶取出 B 并唤醒', null],
          wire('内核内部', 'regs', '示意', concept('唤醒', [
            ['线程 B', '可运行', '要等调度器选中才真正运行。'],
            ['队列', '空', ''],
          ], 'amber'))),
        state('k2', { 等待者: '无' }),
        state('proc2', { 状态: '可运行' }),
      ],
    },
    {
      title: '重试',
      desc: 'B 醒来后再次抢锁',
      detail: '唤醒并不等于拿到锁。B 从 futex 返回后回到 glibc 的循环，再次 xchg 写入 2。旧值是 0，说明抢到了。由于写的是 2，将来 B 解锁时会多一次 FUTEX_WAKE，即使已经没人在等。这种多余的系统调用换来了逻辑的简单，是可以接受的代价。',
      facts: [['操作', 'xchg 写入 2'], ['旧值', '0，抢到了'], ['副作用', '解锁时可能多调一次 WAKE']],
      events: [
        pk('proc2', 'ram', 'green', 'xchg', ['0 → 2'], [870000, 'MEM', '再次抢锁：旧值 0，成功', 4],
          wire('B 现在持有锁', 'mem', 'abi', pthreadMutex(2, 3002, 1)), { locked: true }),
        state('ram', { 锁字: '2', 持有者: 'B' }),
        note('proc2', '拿到锁了', 'green'),
        render,
      ],
    },
  ],
  outro: {
    title: '内核只管睡和醒',
    desc: '锁的逻辑全在用户态',
    text: '无竞争时一次加锁只要一条原子指令，这就是 futex 名字里 fast 的由来。内核不知道锁是什么，甚至不知道 0、1、2 的含义，只比较一个整数。这种分工让同一套机制还能实现条件变量、信号量和读写锁。',
    facts: [['无竞争开销', '几十纳秒'], ['有竞争开销', '系统调用加上下文切换'], ['下一课', 'PAGE WALK']],
  },
};
