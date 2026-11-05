import { concept, interruptFrame, pfError, pte, registers, virtualAddress, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { camera, note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const VA = 0x00007f3a1c2d5678n;
const RIP = 0x55d0c29f1a44n;
const FRAME = 0x41d07n;
const PT_ENTRY = 0x1a2b66a8n;

export const pagefault: Lesson = {
  id: 'pagefault',
  name: 'PAGE FAULT',
  title: '缺页',
  group: 'memory',
  layer: [1, 4],
  timeUnit: 'µs',
  nodes: ['app', 'cpu', 'mmu', 'pt', 'kernel', 'ram'],
  place: { app: [120, 200], cpu: [400, 110], mmu: [700, 130], pt: [920, 340], kernel: [420, 430], ram: [760, 540] },
  labels: {
    app: ['用户进程', '写刚分配的内存'],
    cpu: ['CPU', '执行 mov'],
    mmu: ['MMU', '地址翻译'],
    pt: ['PT', '最后一级页表'],
    kernel: ['内核', '缺页处理'],
    ram: ['物理内存', '可用页框'],
  },
  start: ['app', 'cpu', 'mmu'],
  legend: [['blue', '访问内存'], ['slate', '翻译失败'], ['violet', '异常与返回'], ['amber', '内核处理'], ['green', '访问成功']],
  overview: {
    full: '按需分配物理内存',
    description: 'malloc 或 mmap 大块内存时，内核只记下「这段地址可用」，并不分配物理页。程序第一次碰到那一页，翻译失败，CPU 触发 #PF，内核这时才分配物理页并填好页表，然后让那条指令重新执行一次。程序完全感觉不到。',
    facts: [
      ['平台', 'Linux 6.12，x86-64'],
      ['异常向量', '14（#PF）'],
      ['出错地址', 'CR2'],
      ['错误码', '由 CPU 压栈'],
      ['合法性判断', '查 VMA'],
      ['返回后', '重新执行出错的指令'],
    ],
  },
  steps: [
    {
      title: '翻译失败',
      desc: 'PTE 的 P 位是 0',
      detail: '程序写 mmap 返回的新内存。MMU 遍历页表，走到最后一级发现这个 PTE 全是 0，P 位为 0，表示没有映射。翻译在这里中止，内存访问不会发生。注意这和 TLB 未命中不同：未命中只要硬件再查一次；P=0 必须由内核处理。',
      facts: [['访问类型', '用户态写'], ['PTE', '全 0'], ['结果', '访问中止，触发异常']],
      events: [
        pk('app', 'cpu', 'blue', 'mov [addr], 1', [hex(VA)], [0, 'SW', `写虚拟地址 ${hex(VA)}`, 'reg'],
          wire('用户程序的一条写指令', 'regs', 'abi', registers('出错指令', [['RIP', RIP, '这条指令稍后会被重新执行。', { example: true }]], 'blue')), { quick: true }),
        pk('cpu', 'mmu', 'blue', '翻译请求', ['写访问'], [1000, 'MEM', '把虚拟地址交给 MMU', 'reg'],
          wire('MMU 收到的地址', 'regs', 'abi', virtualAddress(VA)), { quick: true }),
        show('pt'),
        pk('pt', 'mmu', 'slate', 'PTE = 0', ['P = 0'], [2000, 'MEM', '最后一级 PTE 不存在', 8],
          wire('第 1 级页表里的这一项', 'mem', 'abi', pte('PTE（缺页前）', {}, { entryAddress: PT_ENTRY, color: 'slate' }))),
        show('ram'),
        pk('mmu', 'ram', 'slate', '访问中止', ['没有物理地址'], [2000, 'EXC', '翻译失败，内存访问没有发生', null],
          wire('这次访问没有到达内存', 'regs', 'abi', concept('MMU 的判断', [
            ['P 位', '0', '没有映射。'],
            ['后果', '不访问内存，转交 CPU 触发 #PF', ''],
          ], 'slate')), { lost: true }),
        note('mmu', '触发 #PF', 'amber'),
      ],
    },
    {
      title: '陷入',
      desc: '#PF：写 CR2，压入错误码',
      detail: 'CPU 把出错的虚拟地址放进 CR2，压入错误码，查 IDT 的 14 号门进入内核。错误码的低几位说明了原因：P=0 表示页不存在，W=1 表示写访问，U=1 表示来自用户态，合起来是 0x06。如果是权限问题，P 位就是 1。',
      facts: [['向量', '14'], ['CR2', hex(VA)], ['错误码', '0x06（不存在、写、用户）']],
      events: [
        show('kernel'),
        pk('cpu', 'kernel', 'violet', '#PF', ['err = 0x06'], [3000, 'EXC', `页错误：CR2=${hex(VA)}，错误码 0x06`, 'reg'],
          wire('异常发生时 CPU 提供的信息', 'regs', 'abi', registers('异常信息', [
            ['CR2', VA, '出错的虚拟地址。'],
            ...pfError(0x06),
          ], 'violet')), { locked: true }),
        pk('cpu', 'ram', 'violet', '压栈', ['48 字节'], [3000, 'MEM', '中断栈帧带错误码，共 48 字节', 48],
          wire('内核栈上的中断栈帧', 'mem', 'abi', interruptFrame({ err: 0x06, rip: RIP, cs: 0x33, rflags: 0x10246n, rsp: 0x7ffd3c21a480n, ss: 0x2b })), { quick: true }),
        state('cpu', { 特权级: 'Ring 0' }),
      ],
    },
    {
      title: '查 VMA',
      desc: '判断这个地址是否合法',
      detail: 'do_user_addr_fault 在进程的 VMA 集合（一棵 maple tree）里查 CR2。地址落在某个 VMA 内，且访问类型符合它的权限，才算合法。找不到或权限不符，内核会向进程发送 SIGSEGV，也就是常见的段错误。这里地址属于刚才 mmap 的那段匿名可写区域。',
      facts: [['数据结构', 'maple tree'], ['地址不合法', 'SIGSEGV'], ['这次结果', '合法的匿名内存']],
      events: [
        pk('kernel', 'ram', 'amber', '查 VMA', ['find_vma'], [5000, 'MEM', '在 maple tree 中查找 CR2 所在的 VMA', null],
          wire('vm_area_struct 是内核内部结构，这里只列相关字段', 'regs', '示意', concept('匹配的 VMA', [
            ['vm_start', '0x7f3a1c200000', 'mmap 返回的起始地址。'],
            ['vm_end', '0x7f3a1c400000', '大小 2 MiB。'],
            ['vm_flags', 'VM_READ | VM_WRITE', '可写，所以这次写访问合法。'],
            ['vm_file', 'NULL', '匿名内存，不对应文件。'],
          ], 'amber'))),
        note('kernel', '地址合法，继续处理', 'green'),
      ],
    },
    {
      title: '分配',
      desc: '分配一页，清零，填 PTE',
      detail: '这次是写缺页，do_anonymous_page 向伙伴系统要一页物理内存，并把它清零，避免泄露其他进程的旧数据。如果是读缺页，内核不会分配，而是映射到全局共享的零页，真正写入时再分配。最后把物理页框号和权限写进 PTE。',
      facts: [['函数', 'do_anonymous_page'], ['写缺页', '分配并清零一页'], ['读缺页', '映射共享零页，不分配'], ['清零原因', '防止信息泄露']],
      events: [
        pk('kernel', 'ram', 'amber', '分配并清零', ['4 KiB'], [9000, 'MEM', '从伙伴系统分配一页并清零', 4096],
          wire('新分配的物理页', 'regs', '示意', concept('物理页', [
            ['页框号', hex(FRAME), '示例值。'],
            ['内容', '全 0', 'clear_page 一次写满 4096 字节。'],
          ], 'amber'))),
        pk('kernel', 'pt', 'amber', '写 PTE', ['P=1 RW=1'], [12000, 'MEM', '把新页框写入 PTE', 8],
          wire('写入后的 PTE。写缺页所以 D 位已置位', 'mem', 'abi', pte('PTE（缺页后）', { p: true, rw: true, us: true, a: true, d: true, nx: true, pfn: FRAME }, { entryAddress: PT_ENTRY }))),
        state('pt', { P: '1', 页框: hex(FRAME) }),
      ],
    },
    {
      title: '重试',
      desc: 'iretq 后重新执行那条指令',
      detail: '#PF 压入的 RIP 指向出错的指令本身，而不是下一条。所以 iretq 返回后，这条写指令从头再来一次。这次翻译成功，数据写入物理页。程序完全不知道中间发生过缺页，只是这次写比平时慢了几微秒。',
      facts: [['返回指令', 'iretq'], ['RIP', '仍指向出错指令'], ['结果', '翻译成功，写入完成']],
      events: [
        pk('kernel', 'cpu', 'violet', 'iretq', ['回到同一条指令'], [14000, 'SYSRET', '从异常返回，RIP 未前进', 'reg'],
          wire('iretq 从栈帧恢复的值', 'regs', 'abi', registers('恢复', [['RIP', RIP, '和出错时相同，所以会重新执行。', { example: true }]], 'violet')), { locked: true }),
        state('cpu', { 特权级: 'Ring 3' }),
        camera(),
        pk('cpu', 'mmu', 'green', '再次翻译', [hex(VA)], [15000, 'MEM', '这次 PTE 有效', 'reg'],
          wire('同一个虚拟地址', 'regs', 'abi', virtualAddress(VA)), { quick: true }),
        pk('mmu', 'ram', 'green', '写入成功', [hex((FRAME << 12n) + 0x678n)], [16000, 'MEM', '写入物理内存', 8],
          wire('翻译结果', 'regs', 'abi', concept('物理地址', [
            ['页框基址', hex(FRAME << 12n), ''],
            ['页内偏移', '0x678', ''],
            ['物理地址', hex((FRAME << 12n) + 0x678n), ''],
          ], 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '先承诺，后兑现',
    desc: '这叫按需分页',
    text: '内核答应分配的内存可以远多于实际物理内存，因为大部分从不会被碰到。缺页是这一切的执行机制。启动程序读入代码页、写时复制、换入 swap 都走同样的入口，下面两课会看到。',
    facts: [['这是软缺页', '不需要读磁盘'], ['硬缺页', '要从磁盘读，慢得多'], ['下一课', 'COW']],
  },
};
