/** ELF64 目标文件的写入和解析。布局依据 System V gABI 和 x86-64 psABI，节顺序和 LLVM MC 相同，便于和 clang 逐字节对照。 */
import type { Assembled } from './emit';

export const SHT = { NULL: 0, PROGBITS: 1, SYMTAB: 2, STRTAB: 3, RELA: 4, HASH: 5, DYNAMIC: 6, NOBITS: 8, DYNSYM: 11, GNU_HASH: 0x6ffffff6 } as const;
export const SHF = { WRITE: 1, ALLOC: 2, EXECINSTR: 4, INFO_LINK: 0x40 } as const;
export const R_TYPE = { R_X86_64_PC32: 2, R_X86_64_PLT32: 4 } as const;
export const SHT_NAME: Record<number, string> = {
  0: 'SHT_NULL', 1: 'SHT_PROGBITS', 2: 'SHT_SYMTAB', 3: 'SHT_STRTAB', 4: 'SHT_RELA', 5: 'SHT_HASH', 6: 'SHT_DYNAMIC', 8: 'SHT_NOBITS', 11: 'SHT_DYNSYM', 0x6ffffff6: 'SHT_GNU_HASH',
};

export interface Section {
  index: number;
  name: string;
  nameOff: number;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
}

export interface SymEntry { index: number; name: string; nameOff: number; info: number; other: number; shndx: number; value: number; size: number; offset: number }
export interface RelaEntry { index: number; offset: number; symIndex: number; symName: string; type: number; addend: number; fileOffset: number }

export interface ObjectFile {
  bytes: number[];
  sections: Section[];
  symbols: SymEntry[];
  relas: RelaEntry[];
  strtab: { offset: number; size: number };
  shoff: number;
}

class Buf {
  bytes: number[] = [];
  u8(value: number) { this.bytes.push(value & 0xff); }
  u16(value: number) { this.u8(value); this.u8(value >> 8); }
  u32(value: number) { for (let shift = 0; shift < 32; shift += 8) this.u8(value >>> shift); }
  u64(value: number | bigint) {
    const big = BigInt.asUintN(64, BigInt(value));
    for (let shift = 0n; shift < 64n; shift += 8n) this.u8(Number((big >> shift) & 0xffn));
  }
  align(to: number) { while (this.bytes.length % to) this.u8(0); }
}

/** 字符串表：按反转后的字典序倒排，后缀相同的共用一段。LLVM 的 StringTableBuilder 就是这样压缩的。 */
export function buildStrtab(names: string[]): { data: number[]; offset: Map<string, number> } {
  const unique = [...new Set(names.filter(Boolean))];
  const reversed = (text: string) => [...text].reverse().join('');
  unique.sort((a, b) => (reversed(a) < reversed(b) ? 1 : -1));
  const offset = new Map<string, number>();
  const data: number[] = [0];
  let previous = '';
  let previousAt = 0;
  for (const name of unique) {
    if (previous.endsWith(name)) {
      offset.set(name, previousAt + previous.length - name.length);
      continue;
    }
    previous = name;
    previousAt = data.length;
    offset.set(name, data.length);
    for (const char of name) data.push(char.charCodeAt(0));
    data.push(0);
  }
  return { data, offset };
}

export interface ObjectInput { text: Assembled[]; globals: string[]; textAlign?: number }

export function writeObject({ text, globals, textAlign = 16 }: ObjectInput): ObjectFile {
  const code: number[] = [];
  const funcAt = new Map<string, { offset: number; size: number }>();
  const relocs: Assembled['relocs'] = [];
  for (const fn of text) {
    while (code.length % 16) code.push(0x90);
    const base = code.length;
    funcAt.set(fn.name, { offset: base, size: fn.bytes.length });
    code.push(...fn.bytes);
    relocs.push(...fn.relocs.map((reloc) => ({ ...reloc, offset: reloc.offset + base })));
  }
  const hasRela = relocs.length > 0;
  const hasBss = globals.length > 0;

  // 符号顺序：汇编文本里第一次出现的顺序，定义的在前，未定义的在后。
  const firstSeen: string[] = [];
  const see = (name: string) => {
    if (!firstSeen.includes(name)) firstSeen.push(name);
  };
  for (const fn of text) {
    see(fn.name);
    fn.relocs.forEach((reloc) => see(reloc.sym));
  }
  globals.forEach(see);
  const isDefined = (name: string) => funcAt.has(name) || globals.includes(name);
  const symbolNames = [...firstSeen.filter(isDefined), ...firstSeen.filter((name) => !isDefined(name))];

  const sectionNames = ['.strtab', '.text', ...(hasRela ? ['.rela.text'] : []), ...(hasBss ? ['.bss'] : []), '.note.GNU-stack', '.symtab'];
  const { data: strtabData, offset: strOff } = buildStrtab([...sectionNames, ...symbolNames]);
  const indexOf = (name: string) => sectionNames.indexOf(name) + 1;
  const bssIndex = hasBss ? indexOf('.bss') : 0;

  const file = new Buf();
  file.bytes.length = 0;
  for (let index = 0; index < 64; index++) file.u8(0);
  // .text 按对齐放在文件头之后。
  file.align(textAlign);
  const textOffset = file.bytes.length;
  file.bytes.push(...code);
  const bssAlign = 4;
  let bssOffset = file.bytes.length;
  if (hasBss) {
    while (bssOffset % bssAlign) bssOffset++;
    while (file.bytes.length < bssOffset) file.u8(0);
  }
  const noteOffset = file.bytes.length;
  file.align(8);
  const symtabOffset = file.bytes.length;

  const symbols: SymEntry[] = [{ index: 0, name: '', nameOff: 0, info: 0, other: 0, shndx: 0, value: 0, size: 0, offset: symtabOffset }];
  symbolNames.forEach((name, position) => {
    const index = position + 1;
    const func = funcAt.get(name);
    const globalIndex = globals.indexOf(name);
    let entry: SymEntry;
    if (func) entry = { index, name, nameOff: strOff.get(name)!, info: 0x12, other: 0, shndx: indexOf('.text'), value: func.offset, size: func.size, offset: 0 };
    else if (globalIndex >= 0) entry = { index, name, nameOff: strOff.get(name)!, info: 0x11, other: 0, shndx: bssIndex, value: globalIndex * 4, size: 4, offset: 0 };
    else entry = { index, name, nameOff: strOff.get(name)!, info: 0x10, other: 0, shndx: 0, value: 0, size: 0, offset: 0 };
    entry.offset = symtabOffset + index * 24;
    symbols.push(entry);
  });
  for (const sym of symbols) {
    file.u32(sym.nameOff);
    file.u8(sym.info);
    file.u8(sym.other);
    file.u16(sym.shndx);
    file.u64(sym.value);
    file.u64(sym.size);
  }
  const relaOffset = file.bytes.length;
  const relas: RelaEntry[] = relocs.map((reloc, index) => {
    const symIndex = symbolNames.indexOf(reloc.sym) + 1;
    const type = R_TYPE[reloc.type];
    file.u64(reloc.offset);
    file.u64((BigInt(symIndex) << 32n) | BigInt(type));
    file.u64(BigInt(reloc.addend));
    return { index, offset: reloc.offset, symIndex, symName: reloc.sym, type, addend: reloc.addend, fileOffset: relaOffset + index * 24 };
  });
  const strtabOffset = file.bytes.length;
  file.bytes.push(...strtabData);
  file.align(8);
  const shoff = file.bytes.length;

  const make = (name: string, type: number, flags: number, offset: number, size: number, link: number, info: number, align: number, entsize: number): Section => ({
    index: indexOf(name), name, nameOff: strOff.get(name)!, type, flags, addr: 0, offset, size, link, info, align, entsize,
  });
  const symtabIndex = indexOf('.symtab');
  const sections: Section[] = [
    { index: 0, name: '', nameOff: 0, type: 0, flags: 0, addr: 0, offset: 0, size: 0, link: 0, info: 0, align: 0, entsize: 0 },
    make('.strtab', SHT.STRTAB, 0, strtabOffset, strtabData.length, 0, 0, 1, 0),
    make('.text', SHT.PROGBITS, SHF.ALLOC | SHF.EXECINSTR, textOffset, code.length, 0, 0, textAlign, 0),
  ];
  if (hasRela) sections.push(make('.rela.text', SHT.RELA, SHF.INFO_LINK, relaOffset, relas.length * 24, symtabIndex, indexOf('.text'), 8, 24));
  if (hasBss) sections.push(make('.bss', SHT.NOBITS, SHF.WRITE | SHF.ALLOC, bssOffset, globals.length * 4, 0, 0, 4, 0));
  sections.push(make('.note.GNU-stack', SHT.PROGBITS, 0, noteOffset, 0, 0, 0, 1, 0));
  sections.push(make('.symtab', SHT.SYMTAB, 0, symtabOffset, symbols.length * 24, indexOf('.strtab'), 1, 8, 24));
  for (const section of sections) {
    file.u32(section.nameOff);
    file.u32(section.type);
    file.u64(section.flags);
    file.u64(section.addr);
    file.u64(section.offset);
    file.u64(section.size);
    file.u32(section.link);
    file.u32(section.info);
    file.u64(section.align);
    file.u64(section.entsize);
  }
  // 现在才知道 shoff 和节数，回填文件头。
  const head = new Buf();
  head.bytes.push(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  head.u16(1);
  head.u16(0x3e);
  head.u32(1);
  head.u64(0);
  head.u64(0);
  head.u64(shoff);
  head.u32(0);
  head.u16(64);
  head.u16(0);
  head.u16(0);
  head.u16(64);
  head.u16(sections.length);
  head.u16(indexOf('.strtab'));
  head.bytes.forEach((byte, index) => (file.bytes[index] = byte));
  return { bytes: file.bytes, sections, symbols, relas, strtab: { offset: strtabOffset, size: strtabData.length }, shoff };
}

export const rdU16 = (b: ArrayLike<number>, o: number) => b[o] | (b[o + 1] << 8);
export const rdU32 = (b: ArrayLike<number>, o: number) => (rdU16(b, o) | (rdU16(b, o + 2) << 16)) >>> 0;
export const rdU64 = (b: ArrayLike<number>, o: number) => BigInt(rdU32(b, o)) | (BigInt(rdU32(b, o + 4)) << 32n);
export const rdCstr = (b: ArrayLike<number>, o: number) => {
  let text = '';
  for (let at = o; b[at]; at++) text += String.fromCharCode(b[at]);
  return text;
};

/** 从原始字节解析目标文件。链接器和测试都走这里，不依赖写入器的中间结构。 */
export function parseObject(bytes: ArrayLike<number>): ObjectFile {
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new Error('不是 ELF 文件');
  const shoff = Number(rdU64(bytes, 40));
  const count = rdU16(bytes, 60);
  const stringIndex = rdU16(bytes, 62);
  const strOffset = Number(rdU64(bytes, shoff + stringIndex * 64 + 24));
  const sections: Section[] = [];
  for (let index = 0; index < count; index++) {
    const at = shoff + index * 64;
    const nameOff = rdU32(bytes, at);
    sections.push({
      index, name: rdCstr(bytes, strOffset + nameOff), nameOff,
      type: rdU32(bytes, at + 4), flags: Number(rdU64(bytes, at + 8)), addr: Number(rdU64(bytes, at + 16)),
      offset: Number(rdU64(bytes, at + 24)), size: Number(rdU64(bytes, at + 32)), link: rdU32(bytes, at + 40), info: rdU32(bytes, at + 44),
      align: Number(rdU64(bytes, at + 48)), entsize: Number(rdU64(bytes, at + 56)),
    });
  }
  const symtab = sections.find((section) => section.type === SHT.SYMTAB)!;
  const symStrings = sections[symtab.link];
  const symbols: SymEntry[] = [];
  for (let index = 0; index < symtab.size / 24; index++) {
    const at = symtab.offset + index * 24;
    const nameOff = rdU32(bytes, at);
    symbols.push({
      index, name: nameOff ? rdCstr(bytes, symStrings.offset + nameOff) : '', nameOff, info: bytes[at + 4], other: bytes[at + 5], shndx: rdU16(bytes, at + 6),
      value: Number(rdU64(bytes, at + 8)), size: Number(rdU64(bytes, at + 16)), offset: at,
    });
  }
  const relaSection = sections.find((section) => section.type === SHT.RELA);
  const relas: RelaEntry[] = [];
  if (relaSection) {
    for (let index = 0; index < relaSection.size / 24; index++) {
      const at = relaSection.offset + index * 24;
      const info = rdU64(bytes, at + 8);
      const symIndex = Number(info >> 32n);
      relas.push({
        index, offset: Number(rdU64(bytes, at)), symIndex, symName: symbols[symIndex].name, type: Number(info & 0xffffffffn),
        addend: Number(BigInt.asIntN(64, rdU64(bytes, at + 16))), fileOffset: at,
      });
    }
  }
  const strSection = sections[stringIndex];
  return { bytes: Array.from(bytes as ArrayLike<number>), sections, symbols, relas, strtab: { offset: strSection.offset, size: strSection.size }, shoff };
}

export const sectionBytes = (object: ObjectFile, section: Section) => (section.type === SHT.NOBITS ? [] : object.bytes.slice(section.offset, section.offset + section.size));
