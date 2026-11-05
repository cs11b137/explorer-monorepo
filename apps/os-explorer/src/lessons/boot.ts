import { bzImageHeader, concept, ESP_TYPE_GUID, gptEntry, gptHeader, registers, wire } from '../decode/structures';
import { note, pk, render, show, state } from './dsl';
import type { Lesson } from './types';

const LAST_LBA = 1000215215n;
const esp = gptEntry({ type: ESP_TYPE_GUID, unique: '7B1E9A24-3C5D-4F60-8A11-2D6E9C0B4F31', first: 2048n, last: 2099199n, name: 'EFI System Partition' });
const root = gptEntry({ type: '4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709', unique: 'A94D02C7-61E8-4B3A-9F22-5C7B10E8D643', first: 2099200n, last: LAST_LBA - 34n, name: 'Linux root (x86-64)' });
const header = gptHeader([esp, root], { lastLba: LAST_LBA, diskGuid: '3E8A1F52-9B47-4C06-B1D3-7A2F60C8E915' });


export const boot: Lesson = {
  id: 'boot',
  name: 'BOOT',
  title: '启动',
  group: 'process',
  layer: [1, 4],
  timeUnit: 's',
  nodes: ['cpu', 'device', 'disk', 'ram', 'proc2', 'kernel', 'app'],
  place: {
    cpu: [120, 130],
    device: [120, 430],
    disk: [430, 570],
    ram: [430, 130],
    proc2: [720, 130],
    kernel: [760, 400],
    app: [1020, 590],
  },
  labels: {
    cpu: ['CPU', '通电复位'],
    device: ['UEFI 固件', 'SPI 闪存'],
    disk: ['磁盘', 'GPT + ESP'],
    ram: ['内存', '刚完成初始化'],
    proc2: ['引导程序', 'BOOTX64.EFI'],
    kernel: ['Linux 内核', 'vmlinuz'],
    app: ['init', 'PID 1'],
  },
  deviceArt: 'firmware',
  start: ['cpu', 'device'],
  legend: [['slate', '固件阶段'], ['teal', '读取磁盘'], ['violet', '交接控制权'], ['green', '用户态'], [null, '时间仅表示量级']],
  overview: {
    full: '从通电到第一个用户进程',
    description: '按下电源后，CPU 什么都不知道，只会从一个固定地址取指令。控制权接着交给固件、引导程序、内核，最后是 PID 1。这一课走的是现代 UEFI 路径，不是教科书里的 MBR 加 16 位引导扇区。',
    facts: [
      ['平台', 'x86-64，UEFI，GPT'],
      ['首条指令', '物理地址 0xFFFFFFF0'],
      ['分区表', 'GPT，LBA 0 只是保护性 MBR'],
      ['引导程序', 'EFI 系统分区上的 PE 文件'],
      ['内核入口', 'EFI stub'],
      ['终点', 'PID 1（通常是 systemd）'],
    ],
  },
  steps: [
    {
      title: '复位取指',
      desc: 'CPU 从 0xFFFFFFF0 开始执行固件',
      detail: 'CPU 复位后处于类似实模式的状态，CS 的基址被设为 0xFFFF0000，IP 是 0xFFF0，合起来正好是 4 GiB 下方 16 字节处。这个地址由芯片组映射到存放固件的闪存，所以第一条指令来自固件。固件接着初始化内存控制器，内存才可用。',
      facts: [['CS 基址', '0xFFFF0000'], ['IP', '0xFFF0'], ['物理地址', '0xFFFFFFF0'], ['此时内存', '尚未初始化']],
      events: [
        pk('cpu', 'device', 'slate', '取首条指令', ['0xFFFFFFF0'], [0, 'MMIO', '从复位向量读取指令', 'reg'],
          wire('CPU 复位后的寄存器状态', 'regs', 'abi', registers('复位状态', [
            ['CS.base', 0xffff0000n, '段基址的特殊初值，第一次远跳转后恢复正常。'],
            ['RIP', 0xfff0n, '和 CS.base 相加得到 0xFFFFFFF0。'],
          ], 'slate'))),
        state('cpu', { 模式: '实模式' }),
        show('ram'),
        pk('device', 'ram', 'slate', '训练内存', ['初始化 DRAM'], [150000000, 'MMIO', '固件初始化内存控制器', null],
          wire('固件的早期阶段（SEC、PEI）', 'regs', '示意', concept('固件阶段', [
            ['SEC', '建立临时环境', '内存还不能用，先把 CPU 缓存当内存。'],
            ['PEI', '初始化内存', '内存训练就在这里完成，常常要花不少时间。'],
            ['DXE', '加载驱动', '枚举设备，提供启动服务和运行时服务。'],
            ['BDS', '选择启动项', '读取 NVRAM 里的启动顺序。'],
          ]))),
        state('cpu', { 模式: '64 位长模式' }),
      ],
    },
    {
      title: '读 GPT',
      desc: '固件在磁盘上定位 EFI 系统分区',
      detail: '固件自己就懂 GPT。它读 LBA 1 的分区表头，校验 CRC32，再读 LBA 2 开始的表项，找到类型 GUID 为 C12A7328-… 的分区，也就是 EFI 系统分区（ESP）。LBA 0 上的 MBR 只是保护性的占位，防止旧工具误判磁盘为空，UEFI 启动并不执行其中的代码。',
      facts: [['表头位置', 'LBA 1'], ['表项位置', 'LBA 2 起'], ['ESP 类型', 'C12A7328-F81F-11D2-…'], ['LBA 0', '保护性 MBR，不执行']],
      events: [
        show('disk'),
        pk('device', 'disk', 'teal', '读 LBA 1', ['GPT 头'], [1200000000, 'BIO', '读取 GPT 头', 512],
          wire('固件读取磁盘的第 1 个扇区', 'mem', 'abi', header), { quick: true }),
        pk('disk', 'device', 'teal', 'GPT 头', ['"EFI PART"'], [1200400000, 'BIO', 'GPT 头，CRC32 校验通过', 92],
          wire('磁盘 LBA 1 的内容。两个 CRC32 是真实算出来的', 'mem', 'abi', header)),
        pk('disk', 'device', 'teal', '分区表项', ['ESP'], [1201000000, 'BIO', '找到 EFI 系统分区', 128],
          wire('磁盘 LBA 2 起的第一个表项', 'mem', 'abi', esp)),
      ],
    },
    {
      title: '加载 EFI 程序',
      desc: '把引导程序读入内存并跳转',
      detail: '固件读 ESP 上的 FAT 文件系统，找到 NVRAM 指定的引导项，默认路径是 /EFI/BOOT/BOOTX64.EFI。它是普通的 PE 可执行文件。此时 CPU 已在 64 位长模式，固件按 Microsoft x64 调用约定，用 rcx 和 rdx 传入两个参数后跳转过去。',
      facts: [['文件格式', 'PE/COFF'], ['默认路径', '/EFI/BOOT/BOOTX64.EFI'], ['交接时的模式', '64 位长模式'], ['常见程序', 'GRUB、systemd-boot']],
      events: [
        pk('disk', 'ram', 'teal', '读 BOOTX64.EFI', ['PE 文件'], [1600000000, 'BIO', '把引导程序读入内存', 1048576],
          wire('EFI 系统分区', 'regs', '示意', concept('读取过程', [
            ['文件系统', 'FAT32', 'ESP 必须是 FAT 文件系统，固件自带驱动。'],
            ['文件', '/EFI/BOOT/BOOTX64.EFI', '大小因引导程序而异。'],
          ], 'teal'))),
        show('proc2'),
        pk('device', 'proc2', 'violet', '跳转入口', ['rcx rdx'], [1800000000, 'SW', '调用 efi_main(ImageHandle, SystemTable)', 'reg'],
          wire('UEFI 规定的 x64 入口约定', 'regs', 'abi', registers('入口参数', [
            ['rcx', 0x7a3f1098n, 'ImageHandle：代表这个已加载的程序。', { example: true }],
            ['rdx', 0x7bf5e018n, 'SystemTable：通往固件全部服务的入口。', { example: true }],
          ], 'violet'))),
      ],
    },
    {
      title: '进入内核',
      desc: 'EFI stub 接管，退出启动服务',
      detail: '引导程序把内核文件 vmlinuz 和 initramfs 读入内存。bzImage 同时也是 PE 文件，内核里的 EFI stub 就是它的入口。stub 获取内存图后调用 ExitBootServices，从这一刻起固件的启动服务全部失效，整台机器由内核掌管，只留下少量运行时服务。',
      facts: [['内核文件', 'bzImage，同时是 PE 文件'], ['入口', 'EFI stub'], ['关键调用', 'ExitBootServices'], ['之后固件', '只剩运行时服务']],
      events: [
        pk('disk', 'proc2', 'teal', '读 vmlinuz', ['bzImage'], [2300000000, 'BIO', '读取内核和 initramfs', 14680064],
          wire('内核文件的 setup 头。中间的字节本课不展示', 'mem', 'abi', bzImageHeader(0x20f, 52428800))),
        show('kernel'),
        pk('proc2', 'kernel', 'violet', '跳到 EFI stub', ['PE 入口'], [2600000000, 'SW', '引导程序把控制权交给内核', 'reg'],
          wire('仍是 UEFI 入口约定', 'regs', 'abi', registers('入口参数', [
            ['rcx', 0x7a3f1898n, 'ImageHandle。', { example: true }],
            ['rdx', 0x7bf5e018n, 'SystemTable。', { example: true }],
          ], 'violet'))),
        pk('kernel', 'device', 'violet', 'ExitBootServices', ['MapKey'], [2610000000, 'SW', '内核接管机器，固件启动服务结束', 'reg'],
          wire('UEFI 启动服务调用', 'regs', 'abi', registers('调用参数', [
            ['rcx', 0x7a3f1898n, 'ImageHandle。', { example: true }],
            ['rdx', 0x3c1an, 'MapKey：必须和最新的内存图匹配，否则调用失败。', { example: true }],
          ], 'violet'))),
        state('kernel', { 控制者: '内核' }),
      ],
    },
    {
      title: '启动 init',
      desc: '解开 initramfs，运行 PID 1',
      detail: '内核初始化调度器、内存管理和驱动，把 initramfs 解开成内存里的根文件系统，然后运行其中的 /init。它负责挂载真正的根文件系统并切换过去，最终 exec 成系统的 init（通常是 systemd）。PID 1 就此开始，系统中所有用户进程都是它的后代。',
      facts: [['初始根', 'initramfs（cpio 归档）'], ['第一个用户进程', '/init，PID 1'], ['切换根', 'switch_root'], ['最终', '/sbin/init']],
      events: [
        pk('kernel', 'ram', 'amber', '解开 initramfs', ['cpio'], [2900000000, 'MEM', '解压 initramfs 到内存根文件系统', 41943040],
          wire('内核启动阶段', 'regs', '示意', concept('initramfs', [
            ['格式', 'cpio 归档，通常经过压缩', '内核自带解包代码。'],
            ['作用', '提供挂载真实根分区所需的驱动和工具', ''],
          ], 'amber'))),
        note('kernel', '第一个用户态任务'),
        show('app'),
        pk('kernel', 'app', 'green', 'exec /init', ['PID 1'], [3400000000, 'SW', '运行第一个用户进程', 'reg'],
          wire('kernel_init 线程执行第一个用户程序', 'regs', '示意', concept('PID 1', [
            ['任务', '由内核线程 kernel_init 转变而来', '它原本是内核线程，execve 之后才有了用户地址空间。'],
            ['路径', '/init，然后切换根后 exec /sbin/init', ''],
            ['特殊之处', '不能退出', 'PID 1 退出会导致内核 panic。'],
          ], 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '一路交接控制权',
    desc: '固件 → 引导程序 → 内核 → init',
    text: '每一棒都为下一棒准备好环境，然后把自己退场。真实机器上大部分时间花在固件的内存训练和驱动初始化上。到 PID 1 启动时，下面几节课讲的内核机制都已就绪。',
    facts: [['交接次数', '3 次'], ['UEFI 接手的模式', '已是 64 位'], ['下一课', 'SYSCALL']],
  },
};
