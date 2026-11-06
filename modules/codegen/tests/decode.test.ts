/** 结构解码器的黄金测试：字段的字节范围必须和规范的偏移一致，值必须能从字节读回。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DYN_EXE, LEXED, LIBSCALE, MAIN, RESOLVED, SUM } from '../src/compiler';
import { sectionOf } from '../src/compiler/dynlink';
import { dfaTable, dynEntry, dynSymEntry, elfHeader, gnuHashTable, gotSlot, instruction, irLine, jumpSlot, pltInsn, regNumber, registers, relaEntry, sectionHeader, symbolEntry, textBytes, tokenRecord, wire } from '../src/decode/structures';
import { decode, LayerWriter, type Byte } from '../src/decode/writer';
import { encode, fmtIns, r32 } from '../src/compiler/x86';

const object = MAIN.object;
const u16 = (b: Byte[], o: number) => (b[o] as number) | ((b[o + 1] as number) << 8);
const u32 = (b: Byte[], o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;
const u64 = (b: Byte[], o: number) => BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);

const fieldOf = (layer: LayerWriter, name: string) => {
  const found = layer.fields.find((field) => field.name.startsWith(name));
  if (!found) throw new Error(`没有字段 ${name}`);
  return found;
};

/** 字段范围必须覆盖结构的每个字节，且顶层字段首尾相接。 */
function expectContiguous(layer: LayerWriter, size: number): void {
  expect(layer.length).toBe(size);
  let at = 0;
  for (const field of layer.fields.filter((item) => !item.depth)) {
    expect(field.from, field.name).toBe(at);
    at = field.to;
  }
  expect(at).toBe(size);
}

describe('字段写入器', () => {
  it('小端序写入', () => {
    const layer = new LayerWriter('t', 'x').u16(0x1234).u32(0xdeadbeef).u64(0x0102030405060708n);
    expect(layer.bytes.slice(0, 2)).toEqual([0x34, 0x12]);
    expect(layer.bytes.slice(2, 6)).toEqual([0xef, 0xbe, 0xad, 0xde]);
    expect(layer.bytes.slice(6)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('多层结构合并后偏移要换算', () => {
    const a = textBytes('a', 'abc');
    const b = textBytes('b', 'de');
    const frame = decode(wire('x', 'mem', 'text', a, b));
    expect(frame.bytes.length).toBe(5);
    expect(frame.layers.map((layer) => [layer.from, layer.to])).toEqual([[0, 3], [3, 5]]);
    expect(frame.fields[1].from).toBe(3);
  });
});

describe('Elf64_Ehdr', () => {
  const layer = elfHeader(object);

  it('64 字节，字段首尾相接', () => expectContiguous(layer, 64));

  it('字节就是文件的前 64 字节', () => {
    expect(layer.bytes).toEqual(object.bytes.slice(0, 64));
  });

  it('偏移符合 gABI：e_type 16，e_machine 18，e_shoff 40，e_shnum 60，e_shstrndx 62', () => {
    expect(fieldOf(layer, 'e_type').from).toBe(16);
    expect(fieldOf(layer, 'e_machine').from).toBe(18);
    expect(fieldOf(layer, 'e_shoff').from).toBe(40);
    expect(fieldOf(layer, 'e_ehsize').from).toBe(52);
    expect(fieldOf(layer, 'e_shnum').from).toBe(60);
    expect(fieldOf(layer, 'e_shstrndx').from).toBe(62);
  });

  it('取值：ET_REL、EM_X86_64、小端、64 位', () => {
    expect(layer.bytes.slice(0, 4)).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(layer.bytes[4]).toBe(2);
    expect(layer.bytes[5]).toBe(1);
    expect(u16(layer.bytes, 16)).toBe(1);
    expect(u16(layer.bytes, 18)).toBe(0x3e);
    expect(u64(layer.bytes, 40)).toBe(BigInt(object.shoff));
    expect(u16(layer.bytes, 52)).toBe(64);
    expect(u16(layer.bytes, 58)).toBe(64);
    expect(u16(layer.bytes, 60)).toBe(object.sections.length);
  });
});

describe('Elf64_Shdr', () => {
  it('每个节头 64 字节，字段首尾相接', () => {
    for (const section of object.sections) expectContiguous(sectionHeader(object, section), 64);
  });

  it('偏移符合 gABI：sh_type 4，sh_flags 8，sh_offset 24，sh_size 32，sh_link 40，sh_info 44，sh_entsize 56', () => {
    const text = object.sections.find((section) => section.name === '.text')!;
    const layer = sectionHeader(object, text);
    expect(u32(layer.bytes, 4)).toBe(1);
    expect(u64(layer.bytes, 8)).toBe(6n);
    expect(u64(layer.bytes, 24)).toBe(BigInt(text.offset));
    expect(u64(layer.bytes, 32)).toBe(BigInt(text.size));
    expect(fieldOf(layer, 'sh_link').from).toBe(40);
    expect(fieldOf(layer, 'sh_info').from).toBe(44);
    expect(fieldOf(layer, 'sh_entsize').from).toBe(56);
  });

  it('.rela.text 指向符号表和 .text，表项 24 字节', () => {
    const rela = object.sections.find((section) => section.name === '.rela.text')!;
    const layer = sectionHeader(object, rela);
    expect(u32(layer.bytes, 4)).toBe(4);
    expect(object.sections[u32(layer.bytes, 40)].name).toBe('.symtab');
    expect(object.sections[u32(layer.bytes, 44)].name).toBe('.text');
    expect(u64(layer.bytes, 56)).toBe(24n);
  });
});

describe('Elf64_Sym', () => {
  it('24 字节，字段首尾相接', () => {
    for (const sym of object.symbols) expectContiguous(symbolEntry(object, sym), 24);
  });

  it('sum：GLOBAL FUNC，定义在 .text，大小是函数长度', () => {
    const sym = object.symbols.find((item) => item.name === 'sum')!;
    const layer = symbolEntry(object, sym);
    expect(layer.bytes[4]).toBe(0x12);
    expect(u16(layer.bytes, 6)).toBe(object.sections.findIndex((section) => section.name === '.text'));
    expect(u64(layer.bytes, 16)).toBe(BigInt(SUM.back.assembled.bytes.length));
  });

  it('scale：未定义，st_shndx 是 0', () => {
    const sym = object.symbols.find((item) => item.name === 'scale')!;
    expect(u16(symbolEntry(object, sym).bytes, 6)).toBe(0);
    expect(fieldOf(symbolEntry(object, sym), 'st_shndx').value).toContain('SHN_UNDEF');
  });
});

describe('Elf64_Rela', () => {
  const [total, scale] = object.relas;

  it('24 字节，字段首尾相接', () => {
    for (const rela of object.relas) expectContiguous(relaEntry(object, rela), 24);
  });

  it('r_info 的低 32 位是类型，高 32 位是符号下标', () => {
    const layer = relaEntry(object, total);
    expect(u32(layer.bytes, 8)).toBe(2);
    expect(u32(layer.bytes, 12)).toBe(object.symbols.findIndex((sym) => sym.name === 'total'));
    expect(u32(relaEntry(object, scale).bytes, 8)).toBe(4);
  });

  it('r_addend 是 -4，补码写入', () => {
    expect(BigInt.asIntN(64, u64(relaEntry(object, total).bytes, 16))).toBe(-4n);
  });
});

describe('指令解码', () => {
  const lines = SUM.back.assembled.lines;
  const find = (text: string) => lines.find((line) => line.text === text)!;

  it('每条指令的字段拼起来正好是它的字节', () => {
    for (const line of lines) {
      const layer = instruction(line);
      expect(layer.bytes, line.text).toEqual(line.enc.bytes);
      expectContiguous(layer, line.enc.bytes.length);
    }
  });

  it('mov rbp, rsp：REX.W=1，mod=11，reg=rsp，rm=rbp', () => {
    const layer = instruction(find('mov rbp, rsp'));
    expect(layer.bytes).toEqual([0x48, 0x89, 0xe5]);
    expect(fieldOf(layer, 'REX.W').value).toBe('1');
    expect(fieldOf(layer, 'mod').value).toBe('11');
    expect(fieldOf(layer, 'reg').value).toBe('100');
    expect(fieldOf(layer, 'rm').value).toBe('101');
  });

  it('lea esi, [rdi + rcx]：rm=100 接 SIB，基址 rdi，变址 rcx', () => {
    const layer = instruction(find('lea esi, [rdi + rcx]'));
    expect(layer.bytes).toEqual([0x8d, 0x34, 0x0f]);
    expect(fieldOf(layer, 'rm').value).toBe('100');
    expect(fieldOf(layer, 'base').value).toBe('rdi');
    expect(fieldOf(layer, 'index').value).toBe('rcx');
    expect(fieldOf(layer, 'scale').value).toBe('×1');
  });

  it('lea r8d, [rdx + 1]：REX.R=1，mod=01，位移 1', () => {
    const layer = instruction(find('lea r8d, [rdx + 1]'));
    expect(layer.bytes).toEqual([0x44, 0x8d, 0x42, 0x01]);
    expect(fieldOf(layer, 'REX.R').value).toBe('1');
    expect(fieldOf(layer, 'mod').value).toBe('01');
    expect(fieldOf(layer, '位移').value).toBe('1');
  });

  it('jge 的 rel8 按下一条指令算；jmp 是负数', () => {
    const jge = lines.find((line) => line.ins.m === 'jcc')!;
    const jmp = lines.find((line) => line.ins.m === 'jmp')!;
    expect(fieldOf(instruction(jge), '相对位移').value).toBe(String(jge.jump!.rel));
    expect(jge.jump!.target).toBe(jge.offset + jge.enc.bytes.length + jge.jump!.rel);
    expect(jmp.jump!.rel).toBeLessThan(0);
  });

  it('call 和 RIP 相对访问的 4 字节先是 0，并说明要等重定位', () => {
    const call = lines.find((line) => line.ins.m === 'call')!;
    expect(call.enc.bytes).toEqual([0xe8, 0, 0, 0, 0]);
    expect(fieldOf(instruction(call), '相对位移').value).toContain('待填');
    const store = lines.find((line) => line.text.startsWith('mov dword ptr'))!;
    expect(store.enc.bytes).toEqual([0x89, 0x3d, 0, 0, 0, 0]);
    expect(fieldOf(instruction(store), '位移').value).toContain('待填');
  });

  it('寄存器编号符合 Intel SDM 表 3-1', () => {
    expect(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r15d'].map(regNumber)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 15]);
    expect(registers('r', [['edi', '']]).bytes).toEqual([7]);
  });

  it('对照输入也能解码', () => {
    const ins = { m: 'mov', d: { base: 5, disp: -4 }, s: r32(7) } as const;
    const layer = instruction({ text: fmtIns(ins), enc: encode(ins), offset: 0, jump: null, reloc: null });
    expect(layer.bytes).toEqual([0x89, 0x7d, 0xfc]);
    expect(fieldOf(layer, '位移').value).toBe('-4');
  });
});

describe('文本结构', () => {
  it('token 的字节就是源文件里的字符', () => {
    const source = readFileSync(join(__dirname, 'vectors', 'clang-tokens.txt'), 'utf8');
    expect(source).toContain("identifier 'total'");
    const token = LEXED.tokens[1];
    const layer = tokenRecord(token);
    expect(String.fromCharCode(...(layer.bytes as number[]))).toBe('total');
    expect(fieldOf(layer, '种类').value).toBe('identifier');
  });

  it('IR 行：结果、操作码、类型的范围都落在文本内并且内容正确', () => {
    const text = '%mul1 = mul nsw i32 %n, 6';
    const layer = irLine(text);
    const slice = (name: string) => {
      const field = fieldOf(layer, name);
      return String.fromCharCode(...(layer.bytes.slice(field.from, field.to) as number[]));
    };
    expect(slice('结果')).toBe('%mul1');
    expect(slice('操作码')).toBe('mul');
    expect(slice('标志')).toBe('nsw');
    expect(slice('类型')).toBe('i32');
  });
});

describe('动态链接的结构', () => {
  const section = (image: typeof DYN_EXE, name: string) => sectionOf(image, name);
  const slice = (image: typeof DYN_EXE, name: string, addr: number, size: number) => {
    const found = section(image, name);
    return found.bytes.slice(addr - found.addr, addr - found.addr + size);
  };

  it('Elf64_Sym（.dynsym）：24 字节，字节就是节里的那一项', () => {
    for (const image of [DYN_EXE, LIBSCALE]) {
      for (const sym of image.dynsym) {
        const layer = dynSymEntry(image, sym);
        expectContiguous(layer, 24);
        expect(layer.bytes).toEqual(slice(image, '.dynsym', sym.addr, 24));
      }
    }
    const scale = LIBSCALE.dynsym[1];
    expect(fieldOf(dynSymEntry(LIBSCALE, scale), 'st_shndx').value).toBe('5 (.text)');
    expect(fieldOf(dynSymEntry(DYN_EXE, DYN_EXE.dynsym[1]), 'st_shndx').value).toContain('SHN_UNDEF');
  });

  it('Elf64_Rela（.rela.plt）：r_offset 是 GOT[3] 的地址，类型 7，符号 1', () => {
    const layer = jumpSlot(DYN_EXE, 0);
    expectContiguous(layer, 24);
    expect(u64(layer.bytes, 0)).toBe(0x203018n);
    expect(u32(layer.bytes, 8)).toBe(7);
    expect(u32(layer.bytes, 12)).toBe(1);
    expect(fieldOf(layer, 'r_info · 符号').value).toBe('1 (scale)');
  });

  it('Elf64_Dyn：16 字节，标签在前，值在后', () => {
    for (const entry of DYN_EXE.dynamic) {
      const layer = dynEntry(entry, DYN_EXE);
      expectContiguous(layer, 16);
      expect(u64(layer.bytes, 0)).toBe(BigInt(entry.tag));
      expect(u64(layer.bytes, 8)).toBe(BigInt(entry.value));
    }
    expect(fieldOf(dynEntry(DYN_EXE.dynamic[0], DYN_EXE), 'd_tag').value).toContain('DT_NEEDED');
  });

  it('PLT 的每条指令：字段拼起来正好是它的字节，ModRM 拆出 /6 和 /4', () => {
    for (const insn of [...DYN_EXE.plt0, ...DYN_EXE.plt[0].insns]) {
      const layer = pltInsn(insn);
      expectContiguous(layer, insn.bytes.length);
      expect(layer.bytes).toEqual(insn.bytes);
    }
    const [push, jmp] = DYN_EXE.plt0;
    expect(fieldOf(pltInsn(push), 'reg').value).toBe('110');
    expect(fieldOf(pltInsn(jmp), 'reg').value).toBe('100');
    expect(fieldOf(pltInsn(push), '位移').value).toBe('0x1fc2');
    expect(fieldOf(pltInsn(DYN_EXE.plt[0].insns[2]), '相对位移').value).toBe('-0x20');
  });

  it('GOT 槽：8 字节小端，加载后的值标成示例值', () => {
    const layer = gotSlot(3, 0x203018, RESOLVED.address, '', true);
    expectContiguous(layer, 8);
    expect(u64(layer.bytes, 0)).toBe(BigInt(RESOLVED.address));
    expect(fieldOf(layer, 'GOT[3]').example).toBe(true);
  });

  it('.gnu.hash：整节字节，头 16 字节、布隆字、桶、链', () => {
    for (const image of [DYN_EXE, LIBSCALE]) {
      const layer = gnuHashTable(image);
      expectContiguous(layer, section(image, '.gnu.hash').size);
      expect(layer.bytes).toEqual(section(image, '.gnu.hash').bytes);
    }
    expect(fieldOf(gnuHashTable(LIBSCALE), 'chain[0]').value).toBe('0x1057f68d');
    expect(fieldOf(gnuHashTable(DYN_EXE), 'symoffset').value).toBe('2');
  });

  it('最小 DFA 的转移表：一格一个字节，0xFF 是没有转移', () => {
    const layer = dfaTable([{ name: 'START', next: [1, 2], accept: null }, { name: 'ID', next: [1, 1], accept: 'identifier' }, { name: 'NUM', next: [null, 2], accept: 'numeric_constant' }], ['L', 'D']);
    expectContiguous(layer, 6);
    expect(layer.bytes).toEqual([1, 2, 1, 1, 0xff, 2]);
  });
});
