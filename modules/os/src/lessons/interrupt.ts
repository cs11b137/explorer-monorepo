import { concept, idtGate, interruptFrame, ioapicRte, registers, scancode, wire } from '../decode/structures';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const VECTOR = 0x31;
const HANDLER = 0xffffffff81c00310n;

export const interrupt: Lesson = {
  id: 'interrupt',
  name: 'INTERRUPT',
  title: '中断',
  group: 'process',
  layer: [1, 3],
  timeUnit: 'µs',
  nodes: ['device', 'apic', 'cpu', 'ram', 'kernel', 'k2', 'app'],
  place: {
    device: [120, 470],
    apic: [330, 280],
    cpu: [560, 110],
    ram: [790, 80],
    kernel: [600, 400],
    k2: [860, 310],
    app: [900, 560],
  },
  labels: {
    device: ['键盘', 'i8042 控制器'],
    apic: ['IO-APIC + LAPIC', '中断路由'],
    cpu: ['CPU', '正在运行别的进程'],
    ram: ['内存', 'IDT 与内核栈'],
    kernel: ['中断处理程序', 'Ring 0'],
    k2: ['tty 层', '行规程'],
    app: ['shell', '阻塞在 read()'],
  },
  start: ['device', 'apic'],
  legend: [['amber', '设备信号'], ['violet', 'CPU 响应'], ['teal', '查表与压栈'], ['green', '处理与返回'], [null, '以 PS/2 键盘为例']],
  overview: {
    full: '硬件打断 CPU 的正式通道',
    description: '外设随时可能需要服务，CPU 不可能一直轮询。设备发出中断后，控制器把它投递给某个 CPU，CPU 在指令边界处停下，查 IDT 跳到处理程序。这一课用 PS/2 键盘的 i8042 控制器为例，USB 键盘走的是 xHCI 和 MSI，路径不同。',
    facts: [
      ['平台', 'x86-64，x2APIC'],
      ['路由', 'IO-APIC → LAPIC'],
      ['查表', 'IDT，每项 16 字节'],
      ['自动压栈', 'SS RSP RFLAGS CS RIP'],
      ['示例向量', '0x31（0x30 + IRQ 1）'],
      ['结束信号', 'EOI'],
    ],
  },
  steps: [
    {
      title: '按键',
      desc: '键盘控制器发出 IRQ 1',
      detail: '按下 A 键，键盘把扫描码交给 i8042 控制器，控制器把它放进输出缓冲区，并拉高 IRQ 1 线。这时扫描码还留在控制器里，要等处理程序来读。现在的 USB 键盘不走这条路：由 xHCI 控制器把数据 DMA 到内存，再发 MSI 中断。',
      facts: [['扫描码', '0x1E（A 按下）'], ['中断线', 'IRQ 1'], ['USB 键盘', 'xHCI + MSI，路径不同']],
      events: [
        pk('device', 'apic', 'amber', 'IRQ 1', ['扫描码 0x1E'], [0, 'IRQ', 'i8042 拉高 IRQ 1', null],
          wire('i8042 输出缓冲区里的内容', 'mem', 'abi', scancode(0x1e, 'A'))),
      ],
    },
    {
      title: '路由',
      desc: 'IO-APIC 按表投递到目标 CPU',
      detail: 'IO-APIC 为每条中断线保存一张重定向表项，指明投递到哪个 CPU、用哪个向量。它把中断发给目标 CPU 的 LAPIC。如果 CPU 此刻关了中断（IF=0），中断就在 LAPIC 里等待。旧书里的 8259 PIC 和向量 0x21 已经不是今天的路径。',
      facts: [['表项大小', '8 字节'], ['目标', '某个 CPU 的 LAPIC'], ['向量', '0x31（示例）'], ['IF=0 时', '暂存，等开中断']],
      events: [
        show('cpu'),
        pk('apic', 'cpu', 'amber', '向量 0x31', ['投递到 CPU 0'], [2000, 'IRQ', 'LAPIC 向 CPU 投递向量 0x31', null],
          wire('IO-APIC 中 IRQ 1 的重定向表项', 'mem', 'internal', ioapicRte(VECTOR, 0))),
      ],
    },
    {
      title: '查 IDT',
      desc: 'CPU 压栈，关中断，跳到处理程序',
      detail: 'CPU 执行完当前指令，从 IDTR 找到 IDT，取出 0x31 号门描述符。因为特权级要从 3 变到 0，硬件先从 TSS 取内核栈地址，切过去，再压入 SS、RSP、RFLAGS、CS、RIP 共 40 字节。中断门会清 IF，所以处理程序开始时不会被同级中断打断。外部中断没有错误码。',
      facts: [['门类型', '0xE 中断门'], ['压栈大小', '40 字节'], ['切栈', '特权级变化时从 TSS 取'], ['IF', '进入时被清零']],
      events: [
        show('ram'),
        pk('cpu', 'ram', 'teal', '读门描述符', ['IDT[0x31]'], [3000, 'MEM', '读取 16 字节 IDT 门', 16],
          wire('IDTR 指向的内存表', 'mem', 'abi', idtGate(VECTOR, HANDLER)), { quick: true }),
        pk('cpu', 'ram', 'teal', '压栈', ['40 字节'], [3000, 'MEM', '在内核栈上压入中断栈帧', 40],
          wire('硬件压入的栈帧', 'mem', 'abi', interruptFrame({ rip: 0x7f8e41d2b1a7n, cs: 0x33, rflags: 0x246n, rsp: 0x7ffd3c21a4c8n, ss: 0x2b })), { quick: true }),
        state('cpu', { 特权级: 'Ring 0', IF: '0' }),
        show('kernel'),
        pk('cpu', 'kernel', 'violet', '跳到处理程序', ['common_interrupt'], [4000, 'IRQ', '进入中断处理程序', null],
          wire('门描述符给出的入口', 'regs', 'abi', registers('跳转', [['RIP', HANDLER, '由门描述符中的三段偏移拼成。', { example: true }]], 'violet')), { locked: true }),
      ],
    },
    {
      title: '处理',
      desc: '读端口 0x60，发送 EOI',
      detail: '处理程序从 I/O 端口 0x60 读出扫描码，交给输入子系统，然后写 EOI 告诉 LAPIC 这个中断处理完了。写 EOI 之前，优先级相同或更低的中断不会被投递。处理程序要尽量短，耗时的工作留给软中断或工作队列去做。',
      facts: [['读取', 'in al, 0x60'], ['EOI', 'x2APIC 的 MSR 0x80B'], ['xAPIC 写法', '内存映射 0xFEE000B0'], ['耗时工作', '推迟执行']],
      events: [
        pk('kernel', 'device', 'green', 'in 0x60', ['取走扫描码'], [8000, 'MMIO', '从 i8042 数据端口读取扫描码', 1],
          wire('I/O 端口读取结果', 'mem', 'abi', scancode(0x1e, 'A'))),
        pk('kernel', 'apic', 'green', 'EOI', ['wrmsr 0x80B'], [12000, 'MSR', '通知 LAPIC 中断已处理', 'reg'],
          wire('x2APIC 下写 EOI 的方式', 'regs', 'abi', registers('wrmsr', [
            ['ecx', 0x80b, 'x2APIC 的 EOI MSR，等于 0x800 + (0xB0 >> 4)。'],
            ['eax', 0, '写入的值必须是 0。'],
          ], 'green')), { locked: true }),
      ],
    },
    {
      title: '唤醒读者',
      desc: 'tty 唤醒 shell，IRET 返回',
      detail: '扫描码被翻译成字符，送进 tty 的缓冲区，tty 唤醒阻塞在 read() 上的 shell，把它放回运行队列。处理程序用 iretq 恢复被打断的进程。shell 要等调度器选中它才真正运行。图形终端的路径更长，会经过 evdev、显示服务器和 pty。',
      facts: [['唤醒', '放回运行队列，不是立即运行'], ['返回指令', 'iretq'], ['图形终端', '多经 evdev、合成器和 pty']],
      events: [
        show('k2'),
        pk('kernel', 'k2', 'green', '字符 a', ['0x1E → "a"'], [20000, 'SW', '扫描码转字符，送入 tty 缓冲区', 1],
          wire('输入子系统的转换结果', 'regs', '示意', concept('按键事件', [
            ['扫描码', '0x1E', '硬件给出的物理位置。'],
            ['键码', 'KEY_A（30）', '内核统一的键码。'],
            ['字符', 'a', '由 tty 的键盘映射决定。'],
          ], 'green'))),
        show('app'),
        pk('k2', 'app', 'green', '唤醒', ['read 返回 1'], [26000, 'SCHED', 'try_to_wake_up：shell 进入运行队列', null],
          wire('被唤醒的进程', 'regs', '示意', concept('状态变化', [
            ['之前', '可中断睡眠', '在 tty 的等待队列上。'],
            ['之后', '可运行', '等调度器选中。'],
          ], 'green'))),
        note('kernel', 'iretq 回到被打断的进程'),
        state('cpu', { 特权级: 'Ring 3', IF: '1' }),
        render,
      ],
    },
  ],
  outro: {
    title: '异步，但可控',
    desc: '硬件完成切换，内核尽快处理完',
    text: '从按键到 CPU 响应只要几微秒，而进程自己完全感觉不到被打断过。关键是硬件压栈和 iretq 精确地恢复了现场。调度一课会看到定时器中断如何成为抢占的起点。',
    facts: [['硬件做的', '路由、压栈、切栈'], ['内核做的', '读设备、发 EOI、唤醒'], ['下一课', 'FORK/EXEC']],
  },
};
