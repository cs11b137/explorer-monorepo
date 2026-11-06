import { describe, expect, it } from 'vitest';
import {
  AT, dirEntry, elfHeader, ESP_TYPE_GUID, execStrings, ext4Inode, ext4Superblock, gptEntry, gptHeader, guidBytes, idtGate, inactiveTaskFrame,
  initialStack, interruptFrame, ioapicRte, jbd2Commit, jbd2Descriptor, jbd2Superblock, kernelSigaction, mapsLine, modeWord, nvmeCqe, nvmeReadSqe,
  pfError, pipeBuffer, programHeader, pteValue, pthreadMutex, ptRegs, rtSigframe, schedAttr, sigset, siginfoKill, statBuf, swapHeader, swapPte,
  ucontext, vaIndexes, waitStatus, wire,
} from '../src/decode/structures';
import { crc32, decode, type Byte } from '../src/decode/writer';

const u16 = (b: Byte[], o: number) => (b[o] as number) | ((b[o + 1] as number) << 8);
const u32 = (b: Byte[], o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
const be32 = (b: Byte[], o: number) => (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0;
const u64 = (b: Byte[], o: number) => BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);
const text = (b: Byte[], o: number, n: number) => String.fromCharCode(...(b.slice(o, o + n) as number[]));

describe('地址翻译', () => {
  it('虚拟地址按 9/9/9/9/12 拆分', () => {
    expect(vaIndexes(0x00007f3a1c2d5678n)).toEqual([254n, 232n, 225n, 213n]);
  });

  it('PTE 各位落在 Intel 手册规定的位置', () => {
    expect(pteValue({ p: true })).toBe(1n);
    expect(pteValue({ rw: true })).toBe(2n);
    expect(pteValue({ us: true })).toBe(4n);
    expect(pteValue({ a: true })).toBe(0x20n);
    expect(pteValue({ d: true })).toBe(0x40n);
    expect(pteValue({ ps: true })).toBe(0x80n);
    expect(pteValue({ nx: true })).toBe(1n << 63n);
    expect(pteValue({ pfn: 0x2f3c1n })).toBe(0x2f3c1000n);
  });

  it('错误码：读未映射 0x04，写未映射 0x06，COW 0x07', () => {
    expect(pfError(0x04)[0][2]).toContain('页不存在，读访问，来自用户态');
    expect(pfError(0x06)[0][2]).toContain('页不存在，写访问');
    expect(pfError(0x07)[0][2]).toContain('页存在但权限不符，写访问');
  });

  it('swap PTE：P=0，type 在高 5 位，offset 取反后存于位 9–58', () => {
    const value = u64(swapPte(0, 83214n).bytes, 0);
    expect(value & 1n).toBe(0n);
    expect(value >> 59n).toBe(0n);
    expect((~(value >> 9n)) & ((1n << 50n) - 1n)).toBe(83214n);
    expect(u64(swapPte(3, 1n).bytes, 0) >> 59n).toBe(3n);
  });

  it('swap 头：魔数在第 4086 字节，版本在 1024', () => {
    const b = swapHeader(100).bytes;
    expect(b.length).toBe(4096);
    expect(u32(b, 1024)).toBe(1);
    expect(u32(b, 1028)).toBe(100);
    expect(text(b, 4086, 10)).toBe('SWAPSPACE2');
  });
});

describe('中断与现场', () => {
  it('IDT 门 16 字节，属性字节 0x8E，偏移能拼回原值', () => {
    const handler = 0xffffffff81c00310n;
    const b = idtGate(0x31, handler).bytes;
    expect(b.length).toBe(16);
    expect(b[5]).toBe(0x8e);
    expect(u16(b, 2)).toBe(0x10);
    const rebuilt = BigInt(u16(b, 0)) | (BigInt(u16(b, 6)) << 16n) | (BigInt(u32(b, 8)) << 32n);
    expect(rebuilt).toBe(handler);
    expect(u32(b, 12)).toBe(0);
  });

  it('pt_regs 总长 168，字段偏移与 ptrace.h 一致', () => {
    const layer = ptRegs({ orig_ax: 1, ip: 0x1234n, ss: 0x2b, r15: 7 });
    expect(layer.length).toBe(168);
    expect(u64(layer.bytes, 0)).toBe(7n);
    expect(u64(layer.bytes, 120)).toBe(1n);
    expect(u64(layer.bytes, 128)).toBe(0x1234n);
    expect(u64(layer.bytes, 160)).toBe(0x2bn);
  });

  it('中断栈帧：有错误码 48 字节，没有 40 字节，RIP 紧跟错误码', () => {
    const values = { rip: 0x10n, cs: 0x33, rflags: 0x246n, rsp: 0x20n, ss: 0x2b };
    expect(interruptFrame(values).length).toBe(40);
    const withErr = interruptFrame({ ...values, err: 6 });
    expect(withErr.length).toBe(48);
    expect(u64(withErr.bytes, 0)).toBe(6n);
    expect(u64(withErr.bytes, 8)).toBe(0x10n);
  });

  it('IO-APIC 表项：向量在低 8 位，目标在最高字节', () => {
    const b = ioapicRte(0x31, 2).bytes;
    expect(b.length).toBe(8);
    expect(b[0]).toBe(0x31);
    expect(b[7]).toBe(2);
    expect(b[2]).toBe(0);
  });

  it('inactive_task_frame 56 字节，返回地址在最后', () => {
    const b = inactiveTaskFrame(0xabcn).bytes;
    expect(b.length).toBe(56);
    expect(u64(b, 48)).toBe(0xabcn);
  });

  it('sched_attr 56 字节，nice 在偏移 16', () => {
    const b = schedAttr({ nice: 5 }).bytes;
    expect(b.length).toBe(56);
    expect(u32(b, 0)).toBe(56);
    expect(u32(b, 16)).toBe(5);
  });

  it('pthread_mutex_t 40 字节，kind 在偏移 16', () => {
    const b = pthreadMutex(2, 3002, 1).bytes;
    expect(b.length).toBe(40);
    expect(u32(b, 0)).toBe(2);
    expect(u32(b, 8)).toBe(3002);
    expect(u32(b, 12)).toBe(1);
    expect(u32(b, 16)).toBe(0);
  });
});

describe('启动', () => {
  const esp = gptEntry({ type: ESP_TYPE_GUID, unique: '7B1E9A24-3C5D-4F60-8A11-2D6E9C0B4F31', first: 2048n, last: 2099199n, name: 'EFI System Partition' });

  it('ESP 类型 GUID 的磁盘字节序', () => {
    expect(guidBytes(ESP_TYPE_GUID)).toEqual([0x28, 0x73, 0x2a, 0xc1, 0x1f, 0xf8, 0xd2, 0x11, 0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b]);
  });

  it('GPT 表项 128 字节，LBA 在偏移 32 和 40', () => {
    expect(esp.length).toBe(128);
    expect(u64(esp.bytes, 32)).toBe(2048n);
    expect(u64(esp.bytes, 40)).toBe(2099199n);
  });

  it('GPT 头 92 字节，头 CRC32 真实可验证', () => {
    const b = gptHeader([esp], { lastLba: 1000215215n, diskGuid: '3E8A1F52-9B47-4C06-B1D3-7A2F60C8E915' }).bytes as number[];
    expect(b.length).toBe(92);
    expect(text(b, 0, 8)).toBe('EFI PART');
    expect(u32(b, 8)).toBe(0x00010000);
    expect(u32(b, 12)).toBe(92);
    expect(u64(b, 72)).toBe(2n);
    const stored = u32(b, 16);
    const zeroed = [...b];
    zeroed.splice(16, 4, 0, 0, 0, 0);
    expect(crc32(zeroed)).toBe(stored);
    const array = new Uint8Array(128 * 128);
    array.set(esp.bytes as number[], 0);
    expect(u32(b, 88)).toBe(crc32(array));
  });

  it('CRC32 与标准测试向量一致', () => {
    expect(crc32([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0xcbf43926);
  });

  it('ELF 头 64 字节，程序头 56 字节，字段偏移正确', () => {
    const b = elfHeader({ type: 3, entry: 0x6d30n, phoff: 64n, phnum: 13, shoff: 1n, shnum: 31, shstrndx: 30 }).bytes;
    expect(b.length).toBe(64);
    expect(b.slice(0, 4)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(b[4]).toBe(2);
    expect(b[5]).toBe(1);
    expect(u16(b, 16)).toBe(3);
    expect(u16(b, 18)).toBe(0x3e);
    expect(u64(b, 24)).toBe(0x6d30n);
    expect(u64(b, 32)).toBe(64n);
    expect(u16(b, 52)).toBe(64);
    expect(u16(b, 54)).toBe(56);
    expect(u16(b, 56)).toBe(13);
    const ph = programHeader('x', { type: 3, flags: 4, offset: 0x318n, vaddr: 0x318n, filesz: 28n, memsz: 28n, align: 1n }).bytes;
    expect(ph.length).toBe(56);
    expect(u32(ph, 0)).toBe(3);
    expect(u64(ph, 32)).toBe(28n);
    expect(u64(ph, 48)).toBe(1n);
  });

  it('wstatus：退出码在位 15:8', () => {
    expect(u32(waitStatus(3).bytes, 0)).toBe(0x300);
  });
});

describe('execve', () => {
  it('参数字符串区：每个字符串以 0 结尾，最后 8 字节为 0', () => {
    const b = execStrings([['argv[0]', 'ls'], ['文件名', '/usr/bin/ls']]).bytes;
    expect(b.length).toBe(3 + 12 + 8);
    expect(text(b, 0, 2)).toBe('ls');
    expect(b[2]).toBe(0);
    expect(text(b, 3, 11)).toBe('/usr/bin/ls');
    expect(b.slice(14)).toEqual(Array(9).fill(0));
  });

  it('初始栈：argc、argv、NULL、envp、NULL，然后是 16 字节一项的 auxv', () => {
    const b = initialStack({ rsp: 0x1000n, argv: [0x10n, 0x20n], envp: [0x30n], auxv: [['PAGESZ', 4096], ['ENTRY', 0x6d30n], ['NULL', 0]] }).bytes;
    expect(b.length).toBe(8 * 6 + 16 * 3);
    expect(u64(b, 0)).toBe(2n);
    expect(u64(b, 8)).toBe(0x10n);
    expect(u64(b, 16)).toBe(0x20n);
    expect(u64(b, 24)).toBe(0n);
    expect(u64(b, 32)).toBe(0x30n);
    expect(u64(b, 40)).toBe(0n);
    expect([u64(b, 48), u64(b, 56)]).toEqual([6n, 4096n]);
    expect([u64(b, 64), u64(b, 72)]).toEqual([9n, 0x6d30n]);
    expect([u64(b, 80), u64(b, 88)]).toEqual([0n, 0n]);
  });

  it('auxv 类型号与 auxvec.h 一致', () => {
    expect(AT).toMatchObject({ PHDR: 3, PAGESZ: 6, BASE: 7, ENTRY: 9, RANDOM: 25, EXECFN: 31, SYSINFO_EHDR: 33, MINSIGSTKSZ: 51 });
  });
});

describe('内存映射', () => {
  it('maps 的一行：路径从第 73 列开始', () => {
    const line = mapsLine({ start: 0x7f3a1b9ff000n, end: 0x7f3a1c1ff000n, perms: 'r--p', offset: 0, major: 259, minor: 2, inode: 1835050, path: '/home/alice/words.txt' });
    const shown = text(line.bytes, 0, line.length);
    expect(shown.startsWith('7f3a1b9ff000-7f3a1c1ff000 r--p 00000000 103:02 1835050 ')).toBe(true);
    expect(shown.indexOf('/home')).toBe(73);
    expect(shown.endsWith('/home/alice/words.txt\n')).toBe(true);
  });
});

describe('路径查找', () => {
  it('目录项按 4 字节补齐，目录的 file_type 是 2', () => {
    const dot = dirEntry(1835009, '.', 12, { fileType: 2, padded: true }).bytes;
    expect(dot.length).toBe(12);
    expect(u16(dot, 4)).toBe(12);
    expect(dot[6]).toBe(1);
    expect(dot[7]).toBe(2);
    expect(dirEntry(1835042, 'notes.txt', 4028, { padded: true }).length).toBe(20);
  });

  it('i_mode：0o40750 是目录，属主 rwx', () => {
    const b = modeWord('x', 0o40750).bytes;
    expect(u16(b, 0)).toBe(0x41e8);
  });

  it('struct stat 144 字节，字段偏移与 asm/stat.h 一致', () => {
    const b = statBuf({ major: 259, minor: 2, ino: 1835042, nlink: 1, mode: 0x81a4, uid: 1000, gid: 1001, size: 11, blocks: 8, time: 1780165693 }).bytes;
    expect(b.length).toBe(144);
    expect(u64(b, 0)).toBe(0x10302n);
    expect(u64(b, 8)).toBe(1835042n);
    expect(u64(b, 16)).toBe(1n);
    expect(u32(b, 24)).toBe(0x81a4);
    expect(u32(b, 28)).toBe(1000);
    expect(u32(b, 32)).toBe(1001);
    expect(u64(b, 48)).toBe(11n);
    expect(u64(b, 56)).toBe(4096n);
    expect(u64(b, 64)).toBe(8n);
    expect(u64(b, 72)).toBe(1780165693n);
    expect(u64(b, 88)).toBe(1780165693n);
    expect(u64(b, 104)).toBe(1780165693n);
  });
});

describe('信号', () => {
  it('内核接口的 sigaction 32 字节，标志位正确', () => {
    const b = kernelSigaction({ handler: 0x1000n, flags: 0x14000004n, restorer: 0x2000n, mask: 0n }).bytes;
    expect(b.length).toBe(32);
    expect(u64(b, 0)).toBe(0x1000n);
    expect(u64(b, 8)).toBe(0x14000004n);
    expect(u64(b, 16)).toBe(0x2000n);
    expect(u64(b, 24)).toBe(0n);
  });

  it('信号集合：SIGUSR1 在位 9', () => {
    const layer = sigset('pending', 1n << 9n, { number: 10, name: 'SIGUSR1', on: '有', off: '无' });
    expect(u64(layer.bytes, 0)).toBe(0x200n);
    expect(layer.fields.find((field) => field.name.startsWith('SIGUSR1'))).toMatchObject({ from: 1, to: 2 });
  });

  it('siginfo 128 字节，si_pid 在偏移 16', () => {
    const b = siginfoKill(10, 1204, 1000).bytes;
    expect(b.length).toBe(128);
    expect(u32(b, 0)).toBe(10);
    expect(u32(b, 8)).toBe(0);
    expect(u32(b, 16)).toBe(1204);
    expect(u32(b, 20)).toBe(1000);
  });

  it('rt_sigframe 440 字节，ucontext 和 sigcontext 的偏移与内核头文件一致', () => {
    const values = { di: 5, si: 0x10n, dx: 4096, ax: 0, cx: 0x7e2n, sp: 0x7ffe0000n, ip: 0x7e0n, flags: 0x246n, fpstate: 0x7ffe1200n, mask: 0n };
    const frame = decode(wire('x', 'mem', 'abi', ...rtSigframe({ ...values, restorer: 0xabcn, signo: 10, pid: 1204, uid: 1000 })));
    const b = frame.bytes;
    expect(b.length).toBe(440);
    expect(u64(b, 0)).toBe(0xabcn);
    expect(u64(b, 8)).toBe(7n);
    expect(u32(b, 32)).toBe(2);
    const sc = 48;
    expect(u64(b, sc + 64)).toBe(5n);
    expect(u64(b, sc + 104)).toBe(0n);
    expect(u64(b, sc + 112)).toBe(0x7e2n);
    expect(u64(b, sc + 120)).toBe(0x7ffe0000n);
    expect(u64(b, sc + 128)).toBe(0x7e0n);
    expect(u64(b, sc + 136)).toBe(0x246n);
    expect(u16(b, sc + 144)).toBe(0x33);
    expect(u16(b, sc + 150)).toBe(0x2b);
    expect(u64(b, sc + 184)).toBe(0x7ffe1200n);
    expect(u64(b, 304)).toBe(0n);
    expect(u32(b, 312)).toBe(10);
    expect(u32(b, 328)).toBe(1204);
    expect(ucontext(values).reduce((sum, layer) => sum + layer.length, 0)).toBe(304);
  });
});

describe('存储', () => {
  it('ext4 inode 256 字节，关键偏移正确', () => {
    const b = ext4Inode({ mode: 0x81a4, size: 11, links: 1, blocks: 8, extent: { logical: 0, length: 1, start: 34816 } }).bytes;
    expect(b.length).toBe(256);
    expect(u16(b, 0x00)).toBe(0x81a4);
    expect(u32(b, 0x04)).toBe(11);
    expect(u16(b, 0x1a)).toBe(1);
    expect(u32(b, 0x1c)).toBe(8);
    expect(u32(b, 0x20)).toBe(0x80000);
    expect(u16(b, 0x28)).toBe(0xf30a);
    expect(u16(b, 0x2a)).toBe(1);
    expect(u16(b, 0x30 - 2)).toBe(0);
    expect(u32(b, 0x34)).toBe(0);
    expect(u16(b, 0x38)).toBe(1);
    expect(u32(b, 0x3c)).toBe(34816);
    expect(u16(b, 0x80)).toBe(32);
  });

  it('ext4 目录项：名字从偏移 8 开始', () => {
    const b = dirEntry(1835042, 'notes.txt', 20).bytes;
    expect(u32(b, 0)).toBe(1835042);
    expect(u16(b, 4)).toBe(20);
    expect(b[6]).toBe(9);
    expect(text(b, 8, 9)).toBe('notes.txt');
  });

  it('ext4 超级块：魔数在 0x38，不兼容特性在 0x60', () => {
    const b = ext4Superblock(0x46).bytes;
    expect(u16(b, 0x38)).toBe(0xef53);
    expect(u32(b, 0x60)).toBe(0x46);
  });

  it('NVMe 读命令 64 字节，完成项 16 字节', () => {
    const b = nvmeReadSqe({ cid: 37, nsid: 1, prp1: 0x41d07000n, slba: 2377728n, blocks: 7 }).bytes;
    expect(b.length).toBe(64);
    expect(b[0]).toBe(0x02);
    expect(u16(b, 2)).toBe(37);
    expect(u32(b, 4)).toBe(1);
    expect(u64(b, 24)).toBe(0x41d07000n);
    expect(u64(b, 40)).toBe(2377728n);
    expect(u16(b, 48)).toBe(7);
    const c = nvmeCqe({ sqHead: 12, sqId: 1, cid: 37, phase: 1 }).bytes;
    expect(c.length).toBe(16);
    expect(u16(c, 8)).toBe(12);
    expect(u16(c, 12)).toBe(37);
    expect(u16(c, 14)).toBe(1);
  });

  it('jbd2 全部大端，魔数 0xC03B3998', () => {
    const d = jbd2Descriptor(48213, 655362).bytes;
    expect(be32(d, 0)).toBe(0xc03b3998);
    expect(be32(d, 4)).toBe(1);
    expect(be32(d, 8)).toBe(48213);
    expect(be32(d, 12)).toBe(655362);
    expect(d.length).toBe(44);
    const c = jbd2Commit(48213, 1793847014n).bytes;
    expect(be32(c, 4)).toBe(2);
    expect(c.length).toBe(60);
    expect(be32(c, 0x30)).toBe(0);
    expect(be32(c, 0x34)).toBe(1793847014);
    const s = jbd2Superblock({ sequence: 9, start: 1842, maxlen: 262144 }).bytes;
    expect(be32(s, 4)).toBe(4);
    expect(be32(s, 0x0c)).toBe(4096);
    expect(be32(s, 0x18)).toBe(9);
    expect(be32(s, 0x1c)).toBe(1842);
  });

  it('pipe_buffer 40 字节', () => {
    const b = pipeBuffer(0xffffea0001075c00n, 1200).bytes;
    expect(b.length).toBe(40);
    expect(u32(b, 12)).toBe(1200);
    expect(u32(b, 24)).toBe(0x10);
  });
});

describe('decode', () => {
  it('多层拼接时字段偏移换算到整体坐标', () => {
    const a = pipeBuffer(1n, 2);
    const b = pipeBuffer(3n, 4);
    const frame = decode(wire('x', 'mem', 'internal', a, b));
    expect(frame.bytes.length).toBe(80);
    expect(frame.layers[1]).toMatchObject({ from: 40, to: 80 });
    const second = frame.fields.filter((field) => field.layer === b.id);
    expect(second[0]).toMatchObject({ from: 40, to: 48 });
  });
});
