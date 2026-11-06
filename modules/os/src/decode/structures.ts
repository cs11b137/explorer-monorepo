import type { Color } from '../lessons/types';
import { crc32, hex, LayerWriter, type Fidelity, type FieldOptions, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 字节范围覆盖 [lo, hi] 这些位。 */
const byteRange = (lo: number, hi: number): [number, number] => [lo >> 3, (hi >> 3) + 1];

/** 概念结构：只有字段，没有字节。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}

export type RegEntry = [reg: string, value: bigint | number, note?: string, options?: FieldOptions];

/** 寄存器组：每项 8 字节，只是展示容器，不代表它们在内存里相邻。 */
export function registers(name: string, entries: RegEntry[], color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [reg, value, note, options] of entries) {
    layer.field(reg, hex(value), () => layer.u64(value), { note, ...options });
  }
  return layer;
}

/** x86-64 系统调用约定：rax 放调用号，参数依次是 rdi rsi rdx r10 r8 r9。 */
export function syscallRegs(nr: number, name: string, args: RegEntry[]): LayerWriter {
  return registers(`系统调用 · ${name}`, [[`rax`, nr, `调用号 ${nr} = ${name}`], ...args], 'blue', `syscall(${nr})`);
}

// ---------- 地址翻译 ----------

export interface PteBits {
  pfn?: bigint | number;
  p?: boolean;
  rw?: boolean;
  us?: boolean;
  pwt?: boolean;
  pcd?: boolean;
  a?: boolean;
  d?: boolean;
  ps?: boolean;
  g?: boolean;
  nx?: boolean;
}

export function pteValue(bits: PteBits): bigint {
  let value = BigInt(bits.pfn ?? 0) << 12n;
  const flag = (on: boolean | undefined, bit: bigint) => {
    if (on) value |= 1n << bit;
  };
  flag(bits.p, 0n);
  flag(bits.rw, 1n);
  flag(bits.us, 2n);
  flag(bits.pwt, 3n);
  flag(bits.pcd, 4n);
  flag(bits.a, 5n);
  flag(bits.d, 6n);
  flag(bits.ps, 7n);
  flag(bits.g, 8n);
  flag(bits.nx, 63n);
  return value;
}

const bit = (value: bigint, index: bigint) => (value >> index) & 1n;
const yesNo = (value: bigint, on: string, off: string) => (value ? `1：${on}` : `0：${off}`);

/** 一个页表项。level 决定 PS 位和 D 位的含义：D 只在叶子项有意义。 */
export function pte(name: string, bits: PteBits, options: { level?: 'PML4E' | 'PDPTE' | 'PDE' | 'PTE'; entryAddress?: bigint; color?: Color; pfnLabel?: string } = {}): LayerWriter {
  const { level = 'PTE', entryAddress, color = 'amber', pfnLabel = '物理页框号' } = options;
  const value = pteValue(bits);
  const leaf = level === 'PTE' || bits.ps;
  const layer = makeLayer(name, color, entryAddress === undefined ? '' : `位于物理地址 ${hex(entryAddress)}`);
  layer.field('表项值', hex(value, 16), () => layer.u64(value), { note: '64 位小端。下面逐位拆开。' });
  const over = (label: string, shown: string, lo: number, hi: number, note?: string, example?: boolean) => {
    const [from, to] = byteRange(lo, hi);
    layer.over(label, shown, from, to, { note, example });
  };
  over('P · 位 0', yesNo(bit(value, 0n), '存在', '不存在，访问会触发缺页'), 0, 0);
  over('RW · 位 1', yesNo(bit(value, 1n), '可写', '只读'), 1, 1);
  over('US · 位 2', yesNo(bit(value, 2n), '用户态可访问', '仅内核'), 2, 2);
  over('A · 位 5', yesNo(bit(value, 5n), '被访问过', '未访问'), 5, 5, 'MMU 遍历时由硬件置位，内核回收时清零。');
  if (leaf) over('D · 位 6', yesNo(bit(value, 6n), '被写过', '未写过'), 6, 6, '只在叶子项有意义，写操作时由硬件置位。');
  if (level === 'PDE' || level === 'PDPTE') over('PS · 位 7', yesNo(bit(value, 7n), '这是大页，遍历到此结束', '指向下一级页表'), 7, 7);
  over(pfnLabel, hex((value >> 12n) & 0xffffffffffn), 12, 51, '位 12–51。乘以 4096 得到物理地址，实际宽度受 MAXPHYADDR 限制。', true);
  over('NX · 位 63', yesNo(bit(value, 63n), '不可执行', '可执行'), 63, 63);
  return layer;
}

/** 虚拟地址按 9/9/9/9/12 拆分。 */
export function virtualAddress(va: bigint): LayerWriter {
  const layer = makeLayer('虚拟地址 · 48 位', 'blue', hex(va));
  layer.field('VA', hex(va, 16), () => layer.u64(va), { note: '位 63–48 是符号扩展，必须和位 47 相同。' });
  const part = (name: string, lo: number, hi: number, note: string) => {
    const value = (va >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n);
    const [from, to] = byteRange(lo, hi);
    layer.over(name, hi - lo === 11 ? hex(value) : String(value), from, to, { note });
  };
  part('PML4 索引', 39, 47, '位 47–39，共 9 位，所以每级表有 512 项。');
  part('PDPT 索引', 30, 38, '位 38–30。');
  part('PD 索引', 21, 29, '位 29–21。');
  part('PT 索引', 12, 20, '位 20–12。');
  part('页内偏移', 0, 11, '位 11–0，不参与翻译，直接拼到物理页上。');
  return layer;
}

export const vaIndexes = (va: bigint) => [39n, 30n, 21n, 12n].map((shift) => (va >> shift) & 0x1ffn);

export function cr3Register(base: bigint, pcid: number, noFlush = false, label = 'CR3'): RegEntry {
  const value = (noFlush ? 1n << 63n : 0n) | base | BigInt(pcid);
  return [label, value, `顶级页表物理地址 ${hex(base)}，PCID ${pcid}${noFlush ? '，位 63 = 1 表示写入时不刷新该 PCID 的 TLB' : ''}。`];
}

/** #PF 错误码的位定义。 */
export function pfError(code: number): RegEntry[] {
  const names: Array<[number, string]> = [[0, 'P'], [1, 'W'], [2, 'U'], [3, 'RSVD'], [4, 'I'], [5, 'PK'], [6, 'SS']];
  const on = names.filter(([index]) => code & (1 << index)).map(([, name]) => name);
  const describe = [
    code & 1 ? '页存在但权限不符' : '页不存在',
    code & 2 ? '写访问' : '读访问',
    code & 4 ? '来自用户态' : '来自内核态',
  ].join('，');
  return [['err', code, `置位：${on.join(' ') || '无'}。${describe}。`]];
}

/** 中断或异常时 CPU 压入的栈帧，地址从低到高排列。 */
export function interruptFrame(values: { err?: number; rip: bigint; cs: number; rflags: bigint; rsp: bigint; ss: number }): LayerWriter {
  const hasErr = values.err !== undefined;
  const layer = makeLayer(`中断栈帧 · ${hasErr ? 48 : 40} 字节`, 'violet', 'CPU 自动压栈，地址从低到高');
  if (hasErr) layer.field('错误码', hex(values.err!), () => layer.u64(values.err!), { note: '只有部分异常才有。#PF 有，外部中断没有。' });
  layer.field('RIP', hex(values.rip), () => layer.u64(values.rip), { note: '被打断的指令地址。#PF 指向出错的那条指令，所以能重新执行。', example: true });
  layer.field('CS', hex(values.cs), () => layer.u64(values.cs), { note: '低 2 位是被打断时的特权级，这里是 3。' });
  layer.field('RFLAGS', hex(values.rflags), () => layer.u64(values.rflags), { example: true });
  layer.field('RSP', hex(values.rsp), () => layer.u64(values.rsp), { note: '被打断时的用户栈指针。', example: true });
  layer.field('SS', hex(values.ss), () => layer.u64(values.ss));
  return layer;
}

/** 内核入口保存的 pt_regs，顺序来自 arch/x86/include/asm/ptrace.h。 */
export function ptRegs(values: Partial<Record<(typeof PT_REGS_ORDER)[number], bigint | number>>, notes: Partial<Record<string, string>> = {}, color: Color = 'violet'): LayerWriter {
  const layer = makeLayer('pt_regs · 168 字节', color, '内核栈顶保存的用户现场');
  for (const name of PT_REGS_ORDER) {
    const value = values[name] ?? 0;
    layer.field(name, hex(value), () => layer.u64(value), { note: notes[name] });
  }
  return layer;
}
export const PT_REGS_ORDER = ['r15', 'r14', 'r13', 'r12', 'bp', 'bx', 'r11', 'r10', 'r9', 'r8', 'ax', 'cx', 'dx', 'si', 'di', 'orig_ax', 'ip', 'cs', 'flags', 'sp', 'ss'] as const;

/** 16 字节的 64 位 IDT 门描述符。 */
export function idtGate(vector: number, handler: bigint, selector = 0x10, dpl = 0, type = 0xe): LayerWriter {
  const layer = makeLayer('IDT 门描述符 · 16 字节', 'teal', `向量 ${hex(vector)}`);
  const attr = 0x80 | (dpl << 5) | type;
  layer.field('偏移 15:0', hex(handler & 0xffffn), () => layer.u16(Number(handler & 0xffffn)), { note: '处理函数地址被拆成三段存放。', example: true });
  layer.field('段选择子', hex(selector), () => layer.u16(selector), { note: '内核代码段。' });
  layer.field('IST', '0', () => layer.u8(0), { note: '位 2:0。非 0 时切到指定的中断栈。' });
  layer.field('类型与属性', hex(attr), () => layer.u8(attr), { note: `P=1，DPL=${dpl}，类型 ${hex(type)}（${type === 0xe ? '中断门：进入时清 IF，屏蔽中断' : '陷阱门：不清 IF'}）。` });
  layer.field('偏移 31:16', hex((handler >> 16n) & 0xffffn), () => layer.u16(Number((handler >> 16n) & 0xffffn)), { example: true });
  layer.field('偏移 63:32', hex((handler >> 32n) & 0xffffffffn), () => layer.u32(Number((handler >> 32n) & 0xffffffffn)), { example: true });
  layer.field('保留', '0', () => layer.u32(0));
  return layer;
}

/** IO-APIC 重定向表项，位定义见 struct IO_APIC_route_entry。 */
export function ioapicRte(vector: number, destination: number): LayerWriter {
  const value = BigInt(vector) | (BigInt(destination) << 56n);
  const layer = makeLayer('IO-APIC 重定向表项 · 8 字节', 'amber', 'IRQ 1 对应的表项');
  layer.field('表项值', hex(value, 16), () => layer.u64(value));
  layer.over('vector · 位 7:0', hex(vector), 0, 1, { note: 'Linux 给传统 ISA 中断预留的是 0x30 + IRQ 号，而不是旧书里 PIC 时代的 0x21。', example: true });
  layer.over('delivery_mode · 位 10:8', '0：固定投递', 1, 2);
  layer.over('dest_mode · 位 11', '0：物理目标', 1, 2);
  layer.over('active_low · 位 13', '0：高电平有效', 1, 2);
  layer.over('is_level · 位 15', '0：边沿触发', 1, 2);
  layer.over('masked · 位 16', '0：未屏蔽', 2, 3);
  layer.over('destid · 位 63:56', String(destination), 7, 8, { note: '目标 CPU 的 APIC ID。' });
  return layer;
}

export function scancode(code: number, keyName: string, up = false): LayerWriter {
  const layer = makeLayer('扫描码 · 1 字节', 'amber', '第 1 套扫描码');
  layer.field('扫描码', hex(code), () => layer.u8(code), { note: `${keyName} 键${up ? '松开（按下的值加 0x80）' : '按下'}。i8042 控制器默认把键盘的码翻译成这一套。` });
  return layer;
}

/** LVT 定时器寄存器（x2APIC 下是 MSR 0x832）。 */
export function lvtTimer(vector: number): RegEntry {
  const value = BigInt(vector) | (2n << 17n);
  return ['LVT_TIMER', value, `MSR 0x832。向量 ${hex(vector)}（位 7:0），未屏蔽（位 16 = 0），模式 2 = TSC-deadline（位 18:17）。`];
}

export function schedAttr(values: { policy?: number; flags?: bigint; nice: number }): LayerWriter {
  const layer = makeLayer('struct sched_attr · 56 字节', 'violet', 'UAPI');
  layer.field('size', 56, () => layer.u32(56), { note: '结构大小。内核据此兼容不同版本。' });
  layer.field('sched_policy', `${values.policy ?? 0}（SCHED_NORMAL）`, () => layer.u32(values.policy ?? 0));
  layer.field('sched_flags', hex(values.flags ?? 0n), () => layer.u64(values.flags ?? 0n));
  layer.field('sched_nice', values.nice, () => layer.u32(values.nice), { note: 'nice 越大权重越小，虚拟时间走得越快，同样的时间片耗得越快。' });
  layer.field('sched_priority', 0, () => layer.u32(0), { note: '只用于实时策略。' });
  layer.field('sched_runtime', 0, () => layer.u64(0));
  layer.field('sched_deadline', 0, () => layer.u64(0));
  layer.field('sched_period', 0, () => layer.u64(0));
  layer.field('sched_util_min', 0, () => layer.u32(0));
  layer.field('sched_util_max', 0, () => layer.u32(0));
  return layer;
}

/** 切换内核栈时压入的被调用者保存寄存器。 */
export function inactiveTaskFrame(retAddr: bigint): LayerWriter {
  const layer = makeLayer('inactive_task_frame · 56 字节', 'violet', '由低地址到高地址');
  for (const reg of ['r15', 'r14', 'r13', 'r12', 'bx', 'bp']) {
    layer.field(reg, '被调用者保存的值', () => layer.unknown(8), { hidden: true });
  }
  layer.field('ret_addr', hex(retAddr), () => layer.u64(retAddr), { note: '栈切换后 ret 返回到这里。新任务第一次运行时是 ret_from_fork。', example: true });
  return layer;
}

/** glibc x86-64 的 pthread_mutex_t，来自 sysdeps/x86/nptl/bits/struct_mutex.h。 */
export function pthreadMutex(lock: number, owner: number, nusers: number): LayerWriter {
  const layer = makeLayer('pthread_mutex_t · 40 字节', 'green', 'glibc x86-64');
  layer.field('__lock', lock, () => layer.u32(lock), { note: '这就是 futex 字。glibc 的约定：0 空闲，1 被持有且无人等待，2 被持有且可能有人等待。内核只比较它的值，不理解这些含义。' });
  layer.field('__count', 0, () => layer.u32(0), { note: '递归锁的重入次数。' });
  layer.field('__owner', owner, () => layer.u32(owner), { note: '持有者线程 ID。', example: true });
  layer.field('__nusers', nusers, () => layer.u32(nusers));
  layer.field('__kind', '0（默认类型）', () => layer.u32(0));
  layer.field('__spins', 0, () => layer.u16(0));
  layer.field('__unused', 0, () => layer.u16(0));
  layer.field('__list', '空', () => layer.zero(16), { note: '健壮锁链表，默认锁不用。' });
  return layer;
}

export function futexWord(value: number, before: number): LayerWriter {
  const layer = makeLayer('futex 字 · 4 字节', 'green', '普通用户内存');
  layer.field('值', `${before} → ${value}`, () => layer.u32(value), { note: '32 位整数，所有平台都一样。这次操作由 CPU 原子完成，不需要进入内核。' });
  return layer;
}

// ---------- 启动 ----------

export function guidBytes(guid: string): number[] {
  const [a, b, c, d, e] = guid.split('-');
  const pairs = (text: string) => text.match(/../g)!.map((pair) => parseInt(pair, 16));
  return [...pairs(a).reverse(), ...pairs(b).reverse(), ...pairs(c).reverse(), ...pairs(d), ...pairs(e)];
}

export const ESP_TYPE_GUID = 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B';
const ENTRY_COUNT = 128;

/** GPT 分区表项，128 字节。 */
export function gptEntry(values: { type: string; unique: string; first: bigint; last: bigint; name: string }): LayerWriter {
  const layer = makeLayer('GPT 分区表项 · 128 字节', 'teal', values.name);
  layer.field('分区类型 GUID', values.type, () => layer.raw(guidBytes(values.type)), { note: 'C12A7328-… 是 EFI 系统分区。前三段按小端存放，后两段按字节序存放。' });
  layer.field('分区唯一 GUID', values.unique, () => layer.raw(guidBytes(values.unique)), { example: true });
  layer.field('起始 LBA', values.first.toString(), () => layer.u64(values.first), { example: true });
  layer.field('结束 LBA', values.last.toString(), () => layer.u64(values.last), { example: true });
  layer.field('属性', '0', () => layer.u64(0));
  layer.field('分区名', values.name, () => {
    for (let index = 0; index < 36; index++) layer.u16(values.name.charCodeAt(index) || 0);
  }, { note: 'UTF-16LE，最多 36 个字符。' });
  return layer;
}

/** GPT 头，92 字节。两个 CRC32 都按真实数据计算。 */
export function gptHeader(entries: LayerWriter[], values: { lastLba: bigint; diskGuid: string }): LayerWriter {
  const array = new Uint8Array(ENTRY_COUNT * 128);
  entries.forEach((entry, index) => array.set(entry.bytes as number[], index * 128));
  const arrayCrc = crc32(array);
  const layer = makeLayer('GPT 头 · 92 字节', 'blue', 'LBA 1');
  layer.field('签名', '"EFI PART"', () => layer.ascii('EFI PART'), { mono: true });
  layer.field('版本', '1.0', () => layer.u32(0x00010000));
  layer.field('头大小', '92 字节', () => layer.u32(92));
  const crcAt = layer.length;
  layer.field('头 CRC32', '', () => layer.u32(0), { note: '计算时这个字段先当 0。下面的值是真实算出来的。' });
  layer.field('保留', '0', () => layer.u32(0));
  layer.field('本头 LBA', '1', () => layer.u64(1));
  layer.field('备份头 LBA', values.lastLba.toString(), () => layer.u64(values.lastLba), { note: '磁盘最后一个扇区还有一份备份。', example: true });
  layer.field('首个可用 LBA', '34', () => layer.u64(34));
  layer.field('末个可用 LBA', (values.lastLba - 33n).toString(), () => layer.u64(values.lastLba - 33n), { example: true });
  layer.field('磁盘 GUID', values.diskGuid, () => layer.raw(guidBytes(values.diskGuid)), { example: true });
  layer.field('表项起始 LBA', '2', () => layer.u64(2));
  layer.field('表项数量', ENTRY_COUNT, () => layer.u32(ENTRY_COUNT));
  layer.field('表项大小', '128 字节', () => layer.u32(128));
  layer.field('表项数组 CRC32', hex(arrayCrc, 8), () => layer.u32(arrayCrc), { note: '覆盖全部 128 个表项。' });
  const crc = crc32(layer.bytes as number[]);
  layer.bytes.splice(crcAt, 4, crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24);
  layer.fields.find((field) => field.name === '头 CRC32')!.value = hex(crc, 8);
  return layer;
}

/** bzImage 内核文件里的 setup 头，只展示本课用到的字段。 */
export function bzImageHeader(version: number, initSize: number): LayerWriter {
  const layer = makeLayer('bzImage setup 头（从文件 0x1F1 起）', 'violet', 'x86 启动协议');
  const base = 0x1f1;
  const seek = (offset: number) => layer.unknownTo(offset - base);
  layer.field('setup_sects @0x1F1', '27 个扇区', () => layer.u8(27), { example: true });
  seek(0x1fe);
  layer.field('boot_flag @0x1FE', '0xAA55', () => layer.u16(0xaa55), { note: '固定魔数。' });
  seek(0x202);
  layer.field('header @0x202', '"HdrS"', () => layer.ascii('HdrS'), { note: '表示这是 2.00 及以后的启动协议。', mono: true });
  layer.field('version @0x206', hex(version), () => layer.u16(version), { note: '启动协议版本。', example: true });
  seek(0x228);
  layer.field('cmd_line_ptr @0x228', '由引导程序填入', () => layer.u32(0), { note: '内核命令行的物理地址。走 EFI stub 时不需要。' });
  seek(0x260);
  layer.field('init_size @0x260', `${initSize.toLocaleString('en-US')} 字节`, () => layer.u32(initSize), { note: '解压和初始化时需要的线性内存大小。', example: true });
  return layer;
}

// ---------- ELF ----------

export function elfHeader(values: { type: number; entry: bigint; phoff: bigint; phnum: number; shoff: bigint; shnum: number; shstrndx: number }): LayerWriter {
  const layer = makeLayer('ELF64 文件头 · 64 字节', 'teal', '可执行文件的第一块内容');
  layer.field('魔数', '7F 45 4C 46（"\\x7fELF"）', () => layer.raw([0x7f, 0x45, 0x4c, 0x46]));
  layer.field('EI_CLASS', '2：64 位', () => layer.u8(2));
  layer.field('EI_DATA', '1：小端', () => layer.u8(1));
  layer.field('EI_VERSION', '1', () => layer.u8(1));
  layer.field('EI_OSABI', '0：System V', () => layer.u8(0));
  layer.field('填充', '8 字节 0', () => layer.zero(8));
  layer.field('e_type', values.type === 3 ? '3：ET_DYN（位置无关）' : '2：ET_EXEC', () => layer.u16(values.type), { note: '现代发行版的可执行文件默认是 PIE，所以显示为 ET_DYN。' });
  layer.field('e_machine', '0x3E：x86-64', () => layer.u16(0x3e));
  layer.field('e_version', '1', () => layer.u32(1));
  layer.field('e_entry', hex(values.entry), () => layer.u64(values.entry), { note: '程序入口的偏移。动态链接程序会先跳到解释器，不会直接到这里。', example: true });
  layer.field('e_phoff', `${values.phoff} 字节`, () => layer.u64(values.phoff), { note: '程序头表的位置，紧跟在文件头后面。' });
  layer.field('e_shoff', values.shoff.toString(), () => layer.u64(values.shoff), { example: true });
  layer.field('e_flags', '0', () => layer.u32(0));
  layer.field('e_ehsize', '64 字节', () => layer.u16(64));
  layer.field('e_phentsize', '56 字节', () => layer.u16(56));
  layer.field('e_phnum', values.phnum, () => layer.u16(values.phnum), { example: true });
  layer.field('e_shentsize', '64 字节', () => layer.u16(64));
  layer.field('e_shnum', values.shnum, () => layer.u16(values.shnum), { example: true });
  layer.field('e_shstrndx', values.shstrndx, () => layer.u16(values.shstrndx), { example: true });
  return layer;
}

const PH_TYPE: Record<number, string> = { 1: 'PT_LOAD：映射到内存', 3: 'PT_INTERP：解释器路径' };

export function programHeader(name: string, values: { type: number; flags: number; offset: bigint; vaddr: bigint; filesz: bigint; memsz: bigint; align: bigint }, color: Color = 'green'): LayerWriter {
  const layer = makeLayer(`${name} · 56 字节`, color, PH_TYPE[values.type]);
  const flagsText = [values.flags & 4 ? 'R' : '', values.flags & 2 ? 'W' : '', values.flags & 1 ? 'X' : ''].join('');
  layer.field('p_type', `${values.type}：${PH_TYPE[values.type]}`, () => layer.u32(values.type));
  layer.field('p_flags', `${values.flags}：${flagsText}`, () => layer.u32(values.flags));
  layer.field('p_offset', hex(values.offset), () => layer.u64(values.offset), { example: true });
  layer.field('p_vaddr', hex(values.vaddr), () => layer.u64(values.vaddr), { example: true });
  layer.field('p_paddr', hex(values.vaddr), () => layer.u64(values.vaddr), { note: 'Linux 不使用，通常等于 p_vaddr。' });
  layer.field('p_filesz', values.filesz.toString(), () => layer.u64(values.filesz), { example: true });
  layer.field('p_memsz', values.memsz.toString(), () => layer.u64(values.memsz), { note: '比 p_filesz 大的部分是 .bss，用零填充。', example: true });
  layer.field('p_align', hex(values.align), () => layer.u64(values.align));
  return layer;
}

export function waitStatus(code: number): LayerWriter {
  const value = code << 8;
  const layer = makeLayer('wstatus · 4 字节', 'green', 'wait4 写回用户内存');
  layer.field('wstatus', hex(value), () => layer.u32(value));
  layer.over('退出码 · 位 15:8', String(code), 1, 2, { note: 'WEXITSTATUS 取这 8 位。' });
  layer.over('信号 · 位 6:0', '0：正常退出', 0, 1, { note: 'WIFEXITED 为真时这里是 0。' });
  return layer;
}

// ---------- execve ----------

/** execve 拷到新栈最顶端的字符串，地址从低到高。每个字符串以 0 结尾，最后 8 字节留空。 */
export function execStrings(strings: Array<[label: string, text: string, note?: string]>): LayerWriter {
  const total = strings.reduce((sum, [, text]) => sum + text.length + 1, 0) + 8;
  const layer = makeLayer(`参数字符串区 · ${total} 字节`, 'amber', '新栈的最顶端，地址从低到高');
  for (const [label, text, note] of strings) layer.field(label, `"${text}"`, () => layer.ascii(text).u8(0), { note, mono: true });
  layer.field('栈顶 8 字节', 'NULL', () => layer.u64(0), { note: 'bprm->p 从栈顶减 8 开始往下拷，这 8 字节始终是 0。' });
  return layer;
}

/** 辅助向量的类型号，来自 include/uapi/linux/auxvec.h 和 arch/x86/include/uapi/asm/auxvec.h。 */
export const AT = {
  NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, FLAGS: 8, ENTRY: 9, UID: 11, EUID: 12, GID: 13, EGID: 14,
  PLATFORM: 15, HWCAP: 16, CLKTCK: 17, SECURE: 23, RANDOM: 25, HWCAP2: 26, RSEQ_FEATURE_SIZE: 27, RSEQ_ALIGN: 28,
  EXECFN: 31, SYSINFO_EHDR: 33, MINSIGSTKSZ: 51,
} as const;

export type AuxEntry = [type: keyof typeof AT, value: bigint | number, note?: string, options?: FieldOptions];

/** 新程序的初始栈，从 rsp 往高地址：argc、argv、envp、auxv。布局由 System V x86-64 ABI 规定。 */
export function initialStack(values: { rsp: bigint; argv: bigint[]; envp: bigint[]; auxv: AuxEntry[] }): LayerWriter {
  const total = 8 * (1 + values.argv.length + 1 + values.envp.length + 1) + 16 * values.auxv.length;
  const layer = makeLayer(`初始栈 · ${total} 字节`, 'violet', `从 rsp = ${hex(values.rsp)} 往高地址`);
  layer.field('argc', values.argv.length, () => layer.u64(values.argv.length), { note: 'rsp 指向这里。' });
  values.argv.forEach((pointer, index) => layer.field(`argv[${index}]`, hex(pointer), () => layer.u64(pointer), { note: '指向栈顶的参数字符串。', example: true }));
  layer.field('argv 结尾', 'NULL', () => layer.u64(0));
  values.envp.forEach((pointer, index) => layer.field(`envp[${index}]`, hex(pointer), () => layer.u64(pointer), { note: index === 0 ? '这里只列两个环境变量，实际通常有几十个。' : undefined, example: true }));
  layer.field('envp 结尾', 'NULL', () => layer.u64(0));
  for (const [type, value, note, options] of values.auxv) {
    const shown = typeof value === 'bigint' ? hex(value) : String(value);
    layer.field(`AT_${type}（${AT[type]}）`, shown, () => layer.u64(AT[type]).u64(value), { note, ...options });
  }
  return layer;
}

// ---------- 内存映射 ----------

/** /proc/<pid>/maps 的一行，格式见 fs/proc/task_mmu.c 的 show_map_vma。 */
export function mapsLine(values: { start: bigint; end: bigint; perms: string; offset: number; major: number; minor: number; inode: number; path: string }): LayerWriter {
  const range = `${values.start.toString(16)}-${values.end.toString(16)}`;
  const parts: Array<[name: string, text: string, shown: string, note?: string]> = [
    ['起止地址', range, range, '左闭右开，按页对齐。'],
    ['权限', ` ${values.perms}`, values.perms, '最后一位 p 表示私有映射，s 表示共享映射。'],
    ['文件偏移', ` ${values.offset.toString(16).padStart(8, '0')}`, hex(values.offset), '对应 VMA 的 vm_pgoff 乘以 4096。'],
    ['设备', ` ${values.major.toString(16).padStart(2, '0')}:${values.minor.toString(16).padStart(2, '0')}`, `${values.major}:${values.minor}`, '主次设备号按十六进制打印，259 打印成 103。'],
    ['inode', ` ${values.inode} `, values.inode.toLocaleString('en-US')],
  ];
  const prefix = parts.reduce((sum, [, text]) => sum + text.length, 0);
  const pad = Math.max(0, 72 - prefix) + 1;
  const length = prefix + pad + values.path.length + 1;
  const layer = makeLayer(`maps 的一行 · ${length} 字节`, 'teal', 'ASCII 文本');
  for (const [name, text, shown, note] of parts) layer.field(name, shown, () => layer.ascii(text), { note, example: name !== '权限' && name !== '设备' });
  layer.field('对齐空格', `${pad} 个`, () => layer.ascii(' '.repeat(pad)), { note: '前面的部分补齐到 72 列，再加一个空格。' });
  layer.field('路径', values.path, () => layer.ascii(values.path), { mono: true });
  layer.field('换行', '\\n', () => layer.u8(0x0a));
  return layer;
}

// ---------- 交换 ----------

/** 被换出页面的 PTE：P=0，其余位存放 swap 位置。offset 取反存放（缓解 L1TF）。 */
export function swapPte(type: number, offset: bigint): LayerWriter {
  const inverted = ~offset & ((1n << 50n) - 1n);
  const value = (BigInt(type) << 59n) | (inverted << 9n);
  const layer = makeLayer('swap PTE · 8 字节', 'amber', 'P = 0，硬件视为无效');
  layer.field('表项值', hex(value, 16), () => layer.u64(value));
  layer.over('P · 位 0', '0：不存在，访问时触发缺页', 0, 1);
  layer.over('offset · 位 58:9', `${offset}（按位取反后存放）`, 1, 8, { note: '取反是为了缓解 L1TF：让无效 PTE 的高位不指向真实内存。', example: true });
  layer.over('type · 位 63:59', `${type}：第 ${type} 个 swap 区`, 7, 8);
  return layer;
}

/** swap 区第一页的头，来自 include/linux/swap.h 的 swap_header。 */
export function swapHeader(lastPage: number): LayerWriter {
  const layer = makeLayer('swap 头 · 第 0 页 4096 字节', 'teal', 'mkswap 写入');
  layer.field('启动区', '1024 字节，未使用', () => layer.zero(1024), { note: '留给可能存在的引导扇区。' });
  layer.field('version', '1', () => layer.u32(1));
  layer.field('last_page', lastPage.toLocaleString('en-US'), () => layer.u32(lastPage), { example: true });
  layer.field('nr_badpages', '0', () => layer.u32(0));
  layer.field('sws_uuid', '16 字节', () => layer.unknown(16), { hidden: true });
  layer.field('sws_volume', '16 字节', () => layer.zero(16));
  layer.field('中间部分', '未使用', () => layer.padTo(4086));
  layer.field('magic', '"SWAPSPACE2"', () => layer.ascii('SWAPSPACE2'), { note: '位于这一页的最后 10 字节。', mono: true });
  return layer;
}

// ---------- ext4 ----------

const FILE_TYPE: Record<number, string> = { 1: '1：普通文件', 2: '2：目录' };

/** ext4 目录项。padded 时按 4 字节补齐，和它在目录块里实际占的位置一致。 */
export function dirEntry(inode: number, name: string, recLen: number, options: { fileType?: 1 | 2; padded?: boolean; recNote?: string; color?: Color } = {}): LayerWriter {
  const { fileType = 1, padded = false, recNote = '到下一个目录项的距离。', color = 'green' } = options;
  const size = padded ? (8 + name.length + 3) & ~3 : 8 + name.length;
  const layer = makeLayer(`ext4_dir_entry_2 · ${size} 字节`, color, `目录项：${name}`);
  layer.field('inode', inode.toLocaleString('en-US'), () => layer.u32(inode), { note: '目录项只存名字和 inode 号。文件的其他信息都在 inode 里。', example: true });
  layer.field('rec_len', `${recLen} 字节`, () => layer.u16(recLen), { note: recNote });
  layer.field('name_len', name.length, () => layer.u8(name.length));
  layer.field('file_type', FILE_TYPE[fileType], () => layer.u8(fileType));
  layer.field('name', `"${name}"`, () => layer.ascii(name), { mono: true });
  if (size > layer.length) layer.field('填充', `${size - layer.length} 字节`, () => layer.padTo(size), { note: '目录项按 4 字节对齐。' });
  return layer;
}

const offsetTag = (offset: number) => `@0x${offset.toString(16).toUpperCase().padStart(2, '0')}`;
const rwx = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
const MODE_TYPE: Record<number, string> = { 4: '4：目录', 8: '8：普通文件' };

/** inode 的 i_mode，16 位：高 4 位是文件类型，低 12 位是权限。位定义见 include/uapi/linux/stat.h。 */
export function modeWord(name: string, mode: number, notes: { owner?: string; group?: string; other?: string } = {}, summary = ''): LayerWriter {
  const layer = makeLayer(`${name} · 2 字节`, 'amber', summary);
  layer.field('i_mode', `${hex(mode)}（八进制 ${mode.toString(8)}）`, () => layer.u16(mode), { note: '小端存放。下面逐段拆开。' });
  layer.over('类型 · 位 15:12', MODE_TYPE[mode >> 12] ?? String(mode >> 12), 1, 2);
  layer.over('特殊位 · 位 11:9', (mode >> 9) & 7 ? String((mode >> 9) & 7) : '0：无 setuid、setgid、sticky', 1, 2);
  layer.over('属主 · 位 8:6', rwx((mode >> 6) & 7), 0, 2, { note: notes.owner });
  layer.over('同组 · 位 5:3', rwx((mode >> 3) & 7), 0, 1, { note: notes.group });
  layer.over('其他人 · 位 2:0', rwx(mode & 7), 0, 1, { note: notes.other });
  return layer;
}

/** x86-64 的 struct stat，144 字节，布局见 arch/x86/include/uapi/asm/stat.h。 */
export function statBuf(values: { major: number; minor: number; ino: number; nlink: number; mode: number; uid: number; gid: number; size: number; blocks: number; time: number }): LayerWriter {
  const dev = (values.minor & 0xff) | (values.major << 8) | ((values.minor & ~0xff) << 12);
  const layer = makeLayer('struct stat · 144 字节', 'green', 'x86-64 布局');
  layer.field('st_dev @0x00', `${hex(dev)}（${values.major}:${values.minor}）`, () => layer.u64(dev), { note: '主设备号在位 19:8，次设备号的低 8 位在位 7:0。259 是 NVMe 分区的主设备号。', example: true });
  layer.field('st_ino @0x08', values.ino.toLocaleString('en-US'), () => layer.u64(values.ino), { note: '和目录项里的 inode 号相同。', example: true });
  layer.field('st_nlink @0x10', values.nlink, () => layer.u64(values.nlink), { note: 'x86-64 上 st_nlink 是 8 字节，排在 st_mode 前面，和 32 位布局不同。' });
  layer.field('st_mode @0x18', `${hex(values.mode)}（${MODE_TYPE[values.mode >> 12]?.slice(2) ?? '其他'}，权限 ${(values.mode & 0o777).toString(8)}）`, () => layer.u32(values.mode), { note: 'test -f 只看高 4 位是不是普通文件。' });
  layer.field('st_uid @0x1C', values.uid, () => layer.u32(values.uid), { example: true });
  layer.field('st_gid @0x20', values.gid, () => layer.u32(values.gid), { example: true });
  layer.field('__pad0 @0x24', '0', () => layer.u32(0));
  layer.field('st_rdev @0x28', '0', () => layer.u64(0), { note: '只有设备文件才用。' });
  layer.field('st_size @0x30', `${values.size} 字节`, () => layer.u64(values.size));
  layer.field('st_blksize @0x38', '4096', () => layer.u64(4096), { note: '推荐的 I/O 大小。' });
  layer.field('st_blocks @0x40', `${values.blocks}（以 512 字节计）`, () => layer.u64(values.blocks));
  for (const [name, at] of [['st_atime', 0x48], ['st_mtime', 0x58], ['st_ctime', 0x68]] as const) {
    layer.field(`${name} ${offsetTag(at)}`, String(values.time), () => layer.u64(values.time), { note: name === 'st_atime' ? '秒数。stat 只读元数据，不会更新访问时间。' : undefined, example: true });
    layer.field(`${name}_nsec ${offsetTag(at + 8)}`, '纳秒部分', () => layer.unknown(8), { hidden: true });
  }
  layer.field('__unused @0x78', '24 字节', () => layer.zero(24));
  return layer;
}

export interface InodeValues {
  mode: number;
  size: number;
  links: number;
  blocks: number;
  extent: { logical: number; length: number; start: number };
}

/** ext4 inode，256 字节，偏移来自 kernel.org 的 ext4 磁盘布局文档。 */
export function ext4Inode(values: InodeValues): LayerWriter {
  const layer = makeLayer('ext4_inode · 256 字节', 'blue', '磁盘上的文件元数据');
  const stamp = 0x6a1b2c3d;
  layer.field('i_mode @0x00', `${hex(values.mode)}（普通文件，权限 644）`, () => layer.u16(values.mode));
  layer.field('i_uid @0x02', '1000', () => layer.u16(1000), { example: true });
  layer.field('i_size_lo @0x04', `${values.size} 字节`, () => layer.u32(values.size));
  layer.field('i_atime @0x08', String(stamp), () => layer.u32(stamp), { example: true });
  layer.field('i_ctime @0x0C', String(stamp), () => layer.u32(stamp), { example: true });
  layer.field('i_mtime @0x10', String(stamp), () => layer.u32(stamp), { example: true });
  layer.field('i_dtime @0x14', '0', () => layer.u32(0), { note: '文件被删除的时间。' });
  layer.field('i_gid @0x18', '1000', () => layer.u16(1000), { example: true });
  layer.field('i_links_count @0x1A', values.links, () => layer.u16(values.links));
  layer.field('i_blocks_lo @0x1C', `${values.blocks}（以 512 字节计）`, () => layer.u32(values.blocks));
  layer.field('i_flags @0x20', '0x80000：EXTENTS_FL', () => layer.u32(0x80000), { note: '文件用 extent 树记录数据位置。' });
  layer.field('i_osd1 @0x24', '版本号', () => layer.u32(1), { example: true });
  layer.field('extent 头 @0x28', '魔数 0xF30A，1 项，深度 0', () => layer.u16(0xf30a).u16(1).u16(4).u16(0).u32(0), { note: '12 字节：magic、entries、max（i_block 里最多放 4 项）、depth、generation。深度 0 表示下面直接是数据块范围。' });
  layer.field('extent @0x34', `逻辑块 ${values.extent.logical} → 物理块 ${values.extent.start.toLocaleString('en-US')}，共 ${values.extent.length} 块`, () => {
    layer.u32(values.extent.logical).u16(values.extent.length).u16(0).u32(values.extent.start);
  }, { note: '12 字节：ee_block、ee_len、ee_start_hi、ee_start_lo。ee_len 大于 32768 表示这段未初始化。', example: true });
  layer.field('i_block 其余部分 @0x40', '未使用的 extent 槽', () => layer.padTo(0x64));
  layer.field('i_generation @0x64', '用于 NFS', () => layer.unknown(4), { hidden: true });
  layer.field('i_file_acl_lo @0x68', '0', () => layer.u32(0));
  layer.field('i_size_high @0x6C', '0', () => layer.u32(0), { note: '大小的高 32 位。' });
  layer.field('i_obso_faddr 与 osd2 @0x70', '含校验和低位', () => layer.unknown(16), { hidden: true });
  layer.field('i_extra_isize @0x80', '32 字节', () => layer.u16(32), { note: '超出经典 128 字节部分的长度。' });
  layer.field('校验和高位等 @0x82', '校验和与时间戳的纳秒部分', () => layer.unknown(14), { hidden: true });
  layer.field('i_crtime @0x90', String(stamp), () => layer.u32(stamp), { note: '创建时间。', example: true });
  layer.field('其余 @0x94', '额外时间、项目 ID 和内联扩展属性', () => layer.unknown(256 - 0x94), { hidden: true });
  return layer;
}

// ---------- NVMe ----------

/** NVMe 读命令，64 字节，字段见 struct nvme_rw_command。 */
export function nvmeReadSqe(values: { cid: number; nsid: number; prp1: bigint; slba: bigint; blocks: number }): LayerWriter {
  const layer = makeLayer('NVMe 提交队列项 · 64 字节', 'amber', '读命令');
  layer.field('opcode', '0x02：读', () => layer.u8(0x02));
  layer.field('flags', '0', () => layer.u8(0));
  layer.field('command_id', values.cid, () => layer.u16(values.cid), { note: '完成项里会带回同一个 ID，用来配对。', example: true });
  layer.field('nsid', values.nsid, () => layer.u32(values.nsid));
  layer.field('保留', '8 字节', () => layer.zero(8));
  layer.field('metadata', '0', () => layer.u64(0));
  layer.field('PRP1', hex(values.prp1), () => layer.u64(values.prp1), { note: '数据要写入的物理地址，也就是页缓存里的那一页。', example: true });
  layer.field('PRP2', '0', () => layer.u64(0), { note: '数据跨页时才用。' });
  layer.field('SLBA', values.slba.toString(), () => layer.u64(values.slba), { note: '起始逻辑块号。', example: true });
  layer.field('length', `${values.blocks}（从 0 开始计，表示 ${values.blocks + 1} 块）`, () => layer.u16(values.blocks));
  layer.field('control 等', '0', () => layer.zero(14));
  return layer;
}

export function nvmeCqe(values: { sqHead: number; sqId: number; cid: number; phase: number }): LayerWriter {
  const status = values.phase;
  const layer = makeLayer('NVMe 完成队列项 · 16 字节', 'green', '设备写回内存');
  layer.field('result', '0', () => layer.u64(0));
  layer.field('sq_head', values.sqHead, () => layer.u16(values.sqHead), { note: '提交队列消费到哪里了。', example: true });
  layer.field('sq_id', values.sqId, () => layer.u16(values.sqId), { example: true });
  layer.field('command_id', values.cid, () => layer.u16(values.cid), { note: '对应提交时的 ID。', example: true });
  layer.field('status', `${hex(status)}：成功，相位位 ${values.phase}`, () => layer.u16(status), { note: '位 0 是相位标记，驱动靠它判断这一项是不是新写入的。其余位 0 表示成功。' });
  return layer;
}

// ---------- jbd2 ----------

const JBD2_MAGIC = 0xc03b3998;

function jbd2Common(layer: LayerWriter, type: number, typeName: string, sequence: number): void {
  layer.field('h_magic', hex(JBD2_MAGIC), () => layer.be32(JBD2_MAGIC), { note: '大端存放。jbd2 的所有字段都是大端。' });
  layer.field('h_blocktype', `${type}：${typeName}`, () => layer.be32(type));
  layer.field('h_sequence', sequence, () => layer.be32(sequence), { note: '事务序号。恢复时只接受连续的序号。', example: true });
}

export function jbd2Descriptor(sequence: number, blocknr: number): LayerWriter {
  const layer = makeLayer('jbd2 描述符块（前 44 字节）', 'teal', '说明后面的日志块对应哪个磁盘块');
  jbd2Common(layer, 1, '描述符块', sequence);
  layer.field('t_blocknr', blocknr.toLocaleString('en-US'), () => layer.be32(blocknr), { note: '这份元数据最终要写回的磁盘块号。', example: true });
  layer.field('t_flags', '0x0：后面还有标签', () => layer.be32(0), { note: '标志位：1 转义，2 UUID 相同，8 最后一个标签。第一个标签不带 SAME_UUID，所以后面跟 16 字节 UUID。' });
  layer.field('t_blocknr_high', '0', () => layer.be32(0));
  layer.field('t_checksum', 'crc32c(uuid + seq + block)', () => layer.unknown(4), { hidden: true });
  layer.field('UUID', '16 字节', () => layer.unknown(16), { hidden: true });
  return layer;
}

export function jbd2Commit(sequence: number, seconds: bigint): LayerWriter {
  const layer = makeLayer('jbd2 提交块（前 60 字节）', 'green', '写稳它，事务才算提交');
  jbd2Common(layer, 2, '提交块', sequence);
  layer.field('h_chksum_type', '0', () => layer.u8(0), { note: '开启 CSUM_V3 时这里是 0，校验和放在块尾。' });
  layer.field('h_chksum_size', '0', () => layer.u8(0));
  layer.field('h_padding', '2 字节', () => layer.zero(2));
  layer.field('h_chksum', '32 字节', () => layer.zero(32), { note: '只有旧的 COMPAT_CHECKSUM 才使用。' });
  layer.field('h_commit_sec', seconds.toString(), () => layer.be64(seconds), { example: true });
  layer.field('h_commit_nsec', '0', () => layer.be32(0), { example: true });
  return layer;
}

export function jbd2Superblock(values: { sequence: number; start: number; maxlen: number }): LayerWriter {
  const layer = makeLayer('jbd2 超级块（前 44 字节）', 'violet', '日志区的第一块');
  jbd2Common(layer, 4, '超级块 v2', values.sequence);
  layer.field('s_blocksize', '4096', () => layer.be32(4096));
  layer.field('s_maxlen', values.maxlen.toLocaleString('en-US'), () => layer.be32(values.maxlen), { example: true });
  layer.field('s_first', '1', () => layer.be32(1), { note: '第一个日志块的位置。' });
  layer.field('s_sequence', values.sequence, () => layer.be32(values.sequence), { note: '日志中第一个事务的序号。', example: true });
  layer.field('s_start', values.start, () => layer.be32(values.start), { note: '日志起点。0 通常表示日志为空，但判断是否要恢复，还要看 ext4 超级块的 RECOVER 标志。', example: true });
  layer.field('s_errno', '0', () => layer.be32(0));
  layer.field('s_feature_compat', '0', () => layer.be32(0));
  return layer;
}

/** ext4 超级块开头到 s_feature_incompat。只展示本课相关字段，其余字节不展示。 */
export function ext4Superblock(incompat: number): LayerWriter {
  const layer = makeLayer('ext4 超级块（从分区偏移 1024 起）', 'blue', '文件系统总信息');
  layer.field('前面的字段', '块数、inode 数等', () => layer.unknown(0x38), { hidden: true });
  layer.field('s_magic @0x38', '0xEF53', () => layer.u16(0xef53), { note: '小端。ext4 的结构用小端，只有日志用大端。' });
  layer.field('中间字段', '状态、挂载次数等', () => layer.unknownTo(0x60), { hidden: true });
  const recover = incompat & 4 ? '已置位：上次没有干净卸载，需要回放日志' : '未置位';
  layer.field('s_feature_incompat @0x60', hex(incompat), () => layer.u32(incompat));
  layer.over('RECOVER · 位 2', recover, 0x60, 0x61);
  return layer;
}

// ---------- 管道 ----------

export function pipeFds(read: number, write: number): LayerWriter {
  const layer = makeLayer('pipefd · 8 字节', 'green', 'int[2]，由 pipe2 写回');
  layer.field('pipefd[0]', `${read}：读端`, () => layer.u32(read), { example: true });
  layer.field('pipefd[1]', `${write}：写端`, () => layer.u32(write), { example: true });
  return layer;
}

/** 环形缓冲区的一个槽。存的是页描述符，不是字节本身。 */
export function pipeBuffer(page: bigint, length: number): LayerWriter {
  const layer = makeLayer('pipe_buffer · 40 字节', 'violet', '环形缓冲区的一个槽');
  layer.field('page', hex(page), () => layer.u64(page), { note: '指向存数据的那一页。槽里不存数据本身。', example: true });
  layer.field('offset', '0', () => layer.u32(0));
  layer.field('len', `${length} 字节`, () => layer.u32(length));
  layer.field('ops', hex(0xffffffff82241d40n), () => layer.u64(0xffffffff82241d40n), { example: true });
  layer.field('flags', '0x10：CAN_MERGE', () => layer.u32(0x10), { note: '后续的小写入可以追加到这一页。' });
  layer.field('填充', '4 字节', () => layer.zero(4), { note: '让下一个字段按 8 字节对齐。' });
  layer.field('private', '0', () => layer.u64(0));
  return layer;
}

export function userBytes(name: string, text: string, color: Color = 'green'): LayerWriter {
  const layer = makeLayer(`${name} · ${text.length} 字节`, color, '普通用户内存');
  layer.field('内容', JSON.stringify(text), () => layer.ascii(text), { mono: true });
  return layer;
}

// ---------- 信号 ----------

/** rt_sigaction 的内核接口结构（x86-64），32 字节。glibc 把用户态的 struct sigaction 转成这个布局。 */
export function kernelSigaction(values: { handler: bigint; flags: bigint; restorer: bigint; mask: bigint }): LayerWriter {
  const flag = (index: bigint) => bit(values.flags, index);
  const layer = makeLayer('struct sigaction · 32 字节', 'blue', '内核接口的布局');
  layer.field('sa_handler', hex(values.handler), () => layer.u64(values.handler), { note: '处理函数的地址。', example: true });
  layer.field('sa_flags', hex(values.flags), () => layer.u64(values.flags));
  layer.over('SA_SIGINFO · 位 2', yesNo(flag(2n), '处理函数收到 siginfo 和 ucontext', '只收到信号编号'), 8, 9);
  layer.over('SA_RESTORER · 位 26', yesNo(flag(26n), 'sa_restorer 有效', '无'), 11, 12, { note: 'glibc 自动加上，用户不用写。' });
  layer.over('SA_RESTART · 位 28', yesNo(flag(28n), '被打断的系统调用自动重来', '被打断的系统调用返回 EINTR'), 11, 12);
  layer.field('sa_restorer', hex(values.restorer), () => layer.u64(values.restorer), { note: 'glibc 的 __restore_rt。处理函数返回时跳到这里。', example: true });
  layer.field('sa_mask', hex(values.mask), () => layer.u64(values.mask), { note: '处理期间额外屏蔽的信号。正在处理的信号本身默认也会被屏蔽。' });
  return layer;
}

/** 信号集合，64 位：信号 n 在位 n-1。 */
export function sigset(name: string, value: bigint, sig: { number: number; name: string; on: string; off: string }, note?: string, color: Color = 'amber'): LayerWriter {
  const index = sig.number - 1;
  const layer = makeLayer(`${name} · 8 字节`, color, '信号 n 占位 n-1');
  layer.field(name, hex(value, 16), () => layer.u64(value), { note });
  layer.over(`${sig.name} · 位 ${index}`, yesNo(bit(value, BigInt(index)), sig.on, sig.off), index >> 3, (index >> 3) + 1);
  return layer;
}

export interface SigcontextValues {
  di: bigint | number;
  si: bigint | number;
  dx: bigint | number;
  ax: bigint | number;
  cx: bigint;
  sp: bigint;
  ip: bigint;
  flags: bigint;
  fpstate: bigint;
  mask: bigint;
}

export type SigcontextNotes = { ax?: string; ip?: string; mask?: string };

/** struct ucontext（asm-generic/ucontext.h），304 字节，拆成三层：头、sigcontext、uc_sigmask。 */
export function ucontext(values: SigcontextValues, notes: SigcontextNotes = {}): LayerWriter[] {
  const head = makeLayer('ucontext 头 · 40 字节', 'violet', 'uc_flags、uc_link、uc_stack');
  head.field('uc_flags', '0x7', () => head.u64(7), { note: 'UC_FP_XSTATE | UC_SIGCONTEXT_SS | UC_STRICT_RESTORE_SS：FPU 状态按 XSAVE 格式保存，ss 也已保存。' });
  head.field('uc_link', 'NULL', () => head.u64(0));
  head.field('uc_stack.ss_sp', 'NULL', () => head.u64(0), { note: '没有用 sigaltstack 设置备用信号栈。' });
  head.field('uc_stack.ss_flags', '2：SS_DISABLE', () => head.u32(2).zero(4), { note: '4 字节，后面补 4 字节对齐。' });
  head.field('uc_stack.ss_size', '0', () => head.u64(0));

  const sc = makeLayer('sigcontext · 256 字节', 'violet', 'uc_mcontext，被打断时的寄存器');
  sc.field('r8–r15', '被打断时的值', () => sc.unknown(64), { hidden: true });
  sc.field('di', hex(values.di), () => sc.u64(values.di));
  sc.field('si', hex(values.si), () => sc.u64(values.si), { example: true });
  sc.field('bp、bx', '被打断时的值', () => sc.unknown(16), { hidden: true });
  sc.field('dx', hex(values.dx), () => sc.u64(values.dx));
  sc.field('ax', hex(values.ax), () => sc.u64(values.ax), { note: notes.ax });
  sc.field('cx', hex(values.cx), () => sc.u64(values.cx), { note: 'syscall 指令把返回地址存在 rcx。', example: true });
  sc.field('sp', hex(values.sp), () => sc.u64(values.sp), { note: '被打断时的用户栈指针。', example: true });
  sc.field('ip', hex(values.ip), () => sc.u64(values.ip), { note: notes.ip, example: true });
  sc.field('flags', hex(values.flags), () => sc.u64(values.flags), { example: true });
  sc.field('cs', '0x33', () => sc.u16(0x33));
  sc.field('gs、fs', '0', () => sc.u16(0).u16(0), { note: '64 位下不保存这两个段寄存器，FS 基址另有保存。' });
  sc.field('ss', '0x2b', () => sc.u16(0x2b));
  sc.field('err、trapno', '上一次异常留下的值', () => sc.unknown(16), { hidden: true });
  sc.field('oldmask', hex(values.mask), () => sc.u64(values.mask), { note: '旧的屏蔽字，和 uc_sigmask 相同。' });
  sc.field('cr2', '上一次缺页的地址', () => sc.unknown(8), { hidden: true });
  sc.field('fpstate', hex(values.fpstate), () => sc.u64(values.fpstate), { note: '指向信号帧上方的 XSAVE 区，FPU 和向量寄存器存在那里。', example: true });
  sc.field('reserved1', '64 字节', () => sc.zero(64));

  const mask = makeLayer('uc_sigmask · 8 字节', 'violet', '进入处理函数前的屏蔽字');
  mask.field('uc_sigmask', hex(values.mask, 16), () => mask.u64(values.mask), { note: notes.mask });
  return [head, sc, mask];
}

/** kill 产生的 siginfo，128 字节。kill 用 _kill 这一组字段：发送者的 PID 和 UID。 */
export function siginfoKill(signo: number, pid: number, uid: number): LayerWriter {
  const layer = makeLayer('siginfo · 128 字节', 'teal', 'SI_USER：由 kill 发送');
  layer.field('si_signo', signo, () => layer.u32(signo));
  layer.field('si_errno', '0', () => layer.u32(0));
  layer.field('si_code', '0：SI_USER', () => layer.u32(0), { note: '不大于 0 表示来自用户进程。正数表示由内核产生，比如缺页引起的 SIGSEGV。' });
  layer.field('填充', '4 字节', () => layer.zero(4), { note: '后面的联合体按 8 字节对齐。' });
  layer.field('si_pid', pid, () => layer.u32(pid), { note: '发送者的 PID。', example: true });
  layer.field('si_uid', uid, () => layer.u32(uid), { note: '发送者的真实 UID。', example: true });
  layer.field('联合体其余部分', '0', () => layer.padTo(128));
  return layer;
}

/** 64 位进程的 rt_sigframe（arch/x86/include/asm/sigframe.h）：返回地址、ucontext、siginfo，共 440 字节。 */
export function rtSigframe(values: SigcontextValues & { restorer: bigint; signo: number; pid: number; uid: number }, notes: SigcontextNotes = {}): LayerWriter[] {
  const ret = makeLayer('pretcode · 8 字节', 'green', '信号帧的第一项');
  ret.field('pretcode', hex(values.restorer), () => ret.u64(values.restorer), { note: '取自 sa_restorer。处理函数执行 ret 时跳到这里。', example: true });
  return [ret, ...ucontext(values, notes), siginfoKill(values.signo, values.pid, values.uid)];
}
