/** 极简静态链接器：合并节、定址、解析符号、按 psABI 的公式打补丁。 */
import { parseObject, sectionBytes, SHF, SHT, type ObjectFile, type RelaEntry } from './elf';

export const TEXT_BASE = 0x401000;
export const PAGE = 0x1000;

export interface LinkedSymbol { name: string; address: number; object: number; section: string; size: number }

export interface Patch {
  object: number;
  rela: RelaEntry;
  typeName: string;
  /** S：符号地址。 */
  s: number;
  a: number;
  /** P：被改写位置的地址。 */
  p: number;
  value: number;
  /** 被改写位置在合并后 .text 里的偏移。 */
  at: number;
  before: number[];
  after: number[];
}

export interface Linked {
  textAddress: number;
  text: number[];
  bssAddress: number;
  bssSize: number;
  symbols: LinkedSymbol[];
  patches: Patch[];
  objectBase: number[];
  image: number[];
}

export const TYPE_NAME: Record<number, string> = { 2: 'R_X86_64_PC32', 4: 'R_X86_64_PLT32', 7: 'R_X86_64_JUMP_SLOT' };

export function link(inputs: Array<ArrayLike<number> | ObjectFile>): Linked {
  const objects = inputs.map((input) => ('sections' in input ? (input as ObjectFile) : parseObject(input as ArrayLike<number>)));
  const text: number[] = [];
  const objectBase: number[] = [];
  const bssBase: number[] = [];
  let bssSize = 0;
  for (const object of objects) {
    const section = object.sections.find((item) => item.name === '.text')!;
    while (text.length % Math.max(section.align, 1)) text.push(0x90);
    objectBase.push(text.length);
    text.push(...sectionBytes(object, section));
    const bss = object.sections.find((item) => item.type === SHT.NOBITS && item.flags & SHF.ALLOC);
    bssBase.push(bssSize);
    if (bss) bssSize += bss.size;
  }
  const textAddress = TEXT_BASE;
  // .bss 放在 .text 之后的下一页，这样读写权限和代码段分开。
  const bssAddress = Math.ceil((textAddress + text.length) / PAGE) * PAGE + (text.length % PAGE === 0 ? PAGE : 0);
  const symbols: LinkedSymbol[] = [];
  objects.forEach((object, index) => {
    for (const sym of object.symbols) {
      if (!sym.name || !sym.shndx) continue;
      if (symbols.some((item) => item.name === sym.name)) throw new Error(`符号 ${sym.name} 重复定义`);
      const section = object.sections[sym.shndx];
      const address = section.name === '.text' ? textAddress + objectBase[index] + sym.value : bssAddress + bssBase[index] + sym.value;
      symbols.push({ name: sym.name, address, object: index, section: section.name, size: sym.size });
    }
  });
  const patches: Patch[] = [];
  objects.forEach((object, index) => {
    for (const rela of object.relas) {
      const target = symbols.find((item) => item.name === rela.symName);
      if (!target) throw new Error(`未定义的符号 ${rela.symName}`);
      const at = objectBase[index] + rela.offset;
      const p = textAddress + at;
      // PC32：S + A − P。PLT32：L + A − P，静态链接时符号不可抢占，L 就是 S 本身。
      const value = target.address + rela.addend - p;
      const before = text.slice(at, at + 4);
      const after = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
      after.forEach((byte, offset) => (text[at + offset] = byte));
      patches.push({ object: index, rela, typeName: TYPE_NAME[rela.type], s: target.address, a: rela.addend, p, value, at, before, after });
    }
  });
  return { textAddress, text, bssAddress, bssSize, symbols, patches, objectBase, image: writeImage(textAddress, text, bssAddress, bssSize, symbols) };
}

/** 写一个 ET_EXEC 映像，只为让 llvm-objdump 能独立核对地址。没有 _start，不能直接运行。 */
function writeImage(textAddress: number, text: number[], bssAddress: number, bssSize: number, symbols: LinkedSymbol[]): number[] {
  const out: number[] = [];
  const u16 = (value: number) => out.push(value & 0xff, (value >> 8) & 0xff);
  const u32 = (value: number) => { for (let shift = 0; shift < 32; shift += 8) out.push((value >>> shift) & 0xff); };
  const u64 = (value: number) => { u32(value); u32(Math.floor(value / 2 ** 32)); };
  const shstr = '\0.text\0.bss\0.symtab\0.strtab\0.shstrtab\0';
  const strParts = ['', ...symbols.map((sym) => sym.name)];
  const strtab = strParts.join('\0') + '\0';
  let nameAt = 0;
  const symNameOff = strParts.map((name) => {
    const at = nameAt;
    nameAt += name.length + 1;
    return at;
  });
  const textOff = PAGE;
  const symtabOff = textOff + text.length + ((8 - ((textOff + text.length) % 8)) % 8);
  const symtabSize = (symbols.length + 1) * 24;
  const strtabOff = symtabOff + symtabSize;
  const shstrOff = strtabOff + strtab.length;
  const shoff = shstrOff + shstr.length + ((8 - ((shstrOff + shstr.length) % 8)) % 8);
  out.push(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  u16(2); u16(0x3e); u32(1); u64(textAddress); u64(64); u64(shoff); u32(0); u16(64); u16(56); u16(2); u16(64); u16(6); u16(5);
  // PT_LOAD：代码，R+X。
  u32(1); u32(5); u64(textOff); u64(textAddress); u64(textAddress); u64(text.length); u64(text.length); u64(PAGE);
  // PT_LOAD：.bss，R+W，文件里不占空间。
  u32(1); u32(6); u64(0); u64(bssAddress); u64(bssAddress); u64(0); u64(bssSize); u64(PAGE);
  while (out.length < textOff) out.push(0);
  out.push(...text);
  while (out.length < symtabOff) out.push(0);
  for (let index = 0; index < 24; index++) out.push(0);
  symbols.forEach((sym, index) => {
    u32(symNameOff[index + 1]);
    out.push(sym.section === '.text' ? 0x12 : 0x11, 0);
    u16(sym.section === '.text' ? 1 : 2);
    u64(sym.address);
    u64(sym.size);
  });
  for (const char of strtab) out.push(char.charCodeAt(0));
  for (const char of shstr) out.push(char.charCodeAt(0));
  while (out.length < shoff) out.push(0);
  const header = (name: number, type: number, flags: number, addr: number, offset: number, size: number, link2: number, info: number, align: number, ent: number) => {
    u32(name); u32(type); u64(flags); u64(addr); u64(offset); u64(size); u32(link2); u32(info); u64(align); u64(ent);
  };
  header(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  header(1, 1, 6, textAddress, textOff, text.length, 0, 0, 16, 0);
  header(7, 8, 3, bssAddress, symtabOff, bssSize, 0, 0, 4, 0);
  header(12, 2, 0, 0, symtabOff, symtabSize, 4, 1, 8, 24);
  header(20, 3, 0, 0, strtabOff, strtab.length, 0, 0, 1, 0);
  header(28, 3, 0, 0, shstrOff, shstr.length, 0, 0, 1, 0);
  return out;
}
