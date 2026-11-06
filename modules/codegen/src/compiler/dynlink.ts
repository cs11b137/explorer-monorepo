/**
 * 动态链接：把目标文件链接成共享库或依赖共享库的可执行文件，写出 .dynsym、.gnu.hash、.hash、.dynstr、
 * .rela.plt、.plt、.dynamic、.got.plt，再按 glibc ld.so 的做法模拟延迟绑定。
 * 节的顺序、对齐和取值按 lld 的默认布局（x86-64，不开 IBT），由测试和 lld 9 的输出逐字节对照。
 */
import { parseObject, rdCstr, rdU32, rdU64, sectionBytes, SHT, type ObjectFile } from './elf';
import { PAGE, TYPE_NAME } from './link';

export const DT = {
  NULL: 0, NEEDED: 1, PLTRELSZ: 2, PLTGOT: 3, HASH: 4, STRTAB: 5, SYMTAB: 6, STRSZ: 10, SYMENT: 11, SONAME: 14, PLTREL: 20, DEBUG: 21, JMPREL: 23,
  GNU_HASH: 0x6ffffef5,
} as const;
export const DT_NAME: Record<number, string> = Object.fromEntries(Object.entries(DT).map(([name, value]) => [value, `DT_${name}`]));

export const R_X86_64_JUMP_SLOT = 7;
const RELA = 7;
/** x86-64 Linux 上 glibc 的动态链接器。 */
export const LD_SO = '/lib64/ld-linux-x86-64.so.2';
/** lld 默认的可执行文件起始地址。共享库从 0 开始，由加载器决定放在哪里。 */
export const EXE_BASE = 0x200000;
const EHDR = 64;
const PHDR_SIZE = 56;
/** .gnu.hash 第二个布隆位的移位量，lld 固定用 26。 */
const SHIFT2 = 26;

/** SysV ELF 哈希，.hash 用它。见 System V gABI 第 5 章。 */
export function elfHash(name: string): number {
  let h = 0;
  for (const char of name) {
    h = ((h << 4) + char.charCodeAt(0)) >>> 0;
    const g = h & 0xf0000000;
    if (g) h ^= g >>> 24;
    h = (h & ~g) >>> 0;
  }
  return h;
}

/** GNU 哈希：h = h × 33 + c，从 5381 开始，取低 32 位。glibc 的 dl_new_hash。 */
export function gnuHash(name: string): number {
  let h = 5381;
  for (const char of name) h = (Math.imul(h, 33) + char.charCodeAt(0)) >>> 0;
  return h;
}

export interface DynSym {
  index: number;
  name: string;
  nameOff: number;
  info: number;
  shndx: number;
  value: number;
  size: number;
  /** 这一项在映像里的地址。 */
  addr: number;
}

export interface OutSection {
  index: number;
  name: string;
  type: number;
  addr: number;
  align: number;
  /** NOBITS 的节没有字节，只有大小。 */
  bytes: number[];
  size: number;
}

export interface DynEntry { tag: number; value: number; addr: number }

export interface PltInsn {
  addr: number;
  bytes: number[];
  text: string;
  /** 字节分段：操作码、ModRM、位移或立即数。 */
  parts: Array<{ kind: 'opcode' | 'modrm' | 'disp' | 'imm' | 'rel' | 'nop'; from: number; to: number }>;
  /** 读内存的指令：读哪个地址。 */
  mem: number | null;
  /** 直接跳转的目标。 */
  target: number | null;
}

export interface PltEntry { name: string; addr: number; got: number; reloc: number; insns: PltInsn[] }

export interface TextPatch { sym: string; typeName: string; at: number; s: number; a: number; p: number; value: number; viaPlt: boolean; before: number[]; after: number[] }

export interface DynImage {
  kind: 'exe' | 'lib';
  name: string;
  base: number;
  phnum: number;
  sections: OutSection[];
  dynsym: DynSym[];
  dynstr: number[];
  dynamic: DynEntry[];
  /** 本映像里定义的全局符号（不一定导出）。 */
  symbols: Array<{ name: string; addr: number; size: number; section: string }>;
  plt: PltEntry[];
  plt0: PltInsn[];
  /** .got.plt 的初值，每项 8 字节。 */
  gotPlt: number[];
  patches: TextPatch[];
  needed: string[];
  interp: string | null;
}

export const sectionOf = (image: DynImage, name: string) => {
  const found = image.sections.find((section) => section.name === name);
  if (!found) throw new Error(`${image.name} 没有 ${name}`);
  return found;
};

const le = (value: number | bigint, size: number) => {
  const big = BigInt.asUintN(size * 8, BigInt(value));
  return Array.from({ length: size }, (_, index) => Number((big >> BigInt(index * 8)) & 0xffn));
};

const alignUp = (value: number, to: number) => Math.ceil(value / to) * to;

interface Input {
  objects: Array<ArrayLike<number> | ObjectFile>;
  libs: DynImage[];
  name: string;
  soname?: string;
  /** 可执行文件的解释器路径，写进 .interp 和 PT_INTERP。 */
  interp?: string;
}

/** 链接。kind 为 lib 时导出全部全局函数；为 exe 时只把来自共享库的符号放进 .dynsym。 */
export function dynLink(kind: 'exe' | 'lib', { objects: inputs, libs, name, soname, interp }: Input): DynImage {
  const objects = inputs.map((input) => ('sections' in input ? (input as ObjectFile) : parseObject(input as ArrayLike<number>)));
  const base = kind === 'exe' ? EXE_BASE : 0;

  // 合并 .text 和 .bss，记下每个目标文件的起点。
  const text: number[] = [];
  const textBase: number[] = [];
  const bssBase: number[] = [];
  let bssSize = 0;
  for (const object of objects) {
    const section = object.sections.find((item) => item.name === '.text')!;
    while (text.length % Math.max(section.align, 1)) text.push(0x90);
    textBase.push(text.length);
    text.push(...sectionBytes(object, section));
    const bss = object.sections.find((item) => item.type === SHT.NOBITS);
    bssBase.push(bssSize);
    if (bss) bssSize += bss.size;
  }

  const defined: Array<{ name: string; object: number; section: string; value: number; size: number; info: number }> = [];
  objects.forEach((object, index) => {
    for (const sym of object.symbols) {
      if (!sym.name || !sym.shndx) continue;
      if (defined.some((item) => item.name === sym.name)) throw new Error(`符号 ${sym.name} 重复定义`);
      const section = object.sections[sym.shndx].name;
      defined.push({ name: sym.name, object: index, section, value: sym.value + (section === '.text' ? textBase[index] : bssBase[index]), size: sym.size, info: sym.info });
    }
  });

  // 引用了但本地没有定义的符号，到共享库的 .dynsym 里找。
  const imports: Array<{ name: string; info: number; lib: DynImage }> = [];
  for (const object of objects) {
    for (const rela of object.relas) {
      if (defined.some((item) => item.name === rela.symName) || imports.some((item) => item.name === rela.symName)) continue;
      const lib = libs.find((item) => item.dynsym.some((sym) => sym.name === rela.symName && sym.shndx));
      if (!lib) throw new Error(`未定义的符号 ${rela.symName}`);
      if (rela.type !== 4) throw new Error(`${rela.symName} 来自共享库，只支持经过 PLT 的调用`);
      imports.push({ name: rela.symName, info: lib.dynsym.find((sym) => sym.name === rela.symName)!.info, lib });
    }
  }
  const needed = kind === 'exe' ? [...new Set(imports.map((item) => item.lib.name))] : [];
  // .gnu.hash 要求定义的符号按桶排好，lld 的桶数是符号数除以 4，至少 1 个。
  const exportedRaw = kind === 'lib' ? defined.filter((item) => item.section === '.text') : [];
  const nbuckets = Math.max(Math.floor(exportedRaw.length / 4), 1);
  const exported = [...exportedRaw].sort((a, b) => (gnuHash(a.name) % nbuckets) - (gnuHash(b.name) % nbuckets));

  // .dynsym：第 0 项为空，未定义的在前，定义的在后（.gnu.hash 只覆盖后面这一段）。
  const dynNames = [...imports.map((item) => item.name), ...exported.map((item) => item.name)];
  const dynstrText = ['', ...dynNames, ...needed, ...(soname ? [soname] : [])];
  const strOff = new Map<string, number>();
  const dynstr: number[] = [];
  for (const item of dynstrText) {
    if (!strOff.has(item)) strOff.set(item, dynstr.length);
    for (const char of item) dynstr.push(char.charCodeAt(0));
    dynstr.push(0);
  }
  const symCount = 1 + dynNames.length;

  // 布局：只读段放文件头、程序头和动态链接用的表，代码、RELRO、可写数据各占新的一页。
  const hasPlt = imports.length > 0;
  const hasRw = hasPlt || bssSize > 0;
  const loads = 3 + (hasRw ? 1 : 0);
  const phnum = 1 + (interp ? 1 : 0) + loads + 3;
  const order: Array<{ name: string; type: number; align: number; size: number; segment: number }> = [
    ...(interp ? [{ name: '.interp', type: SHT.PROGBITS, align: 1, size: interp.length + 1, segment: 0 }] : []),
    { name: '.dynsym', type: SHT.DYNSYM, align: 8, size: symCount * 24, segment: 0 },
    { name: '.gnu.hash', type: SHT.GNU_HASH, align: 8, size: 0, segment: 0 },
    { name: '.hash', type: SHT.HASH, align: 4, size: symCount * 4 + 8 + symCount * 4, segment: 0 },
    { name: '.dynstr', type: SHT.STRTAB, align: 1, size: dynstr.length, segment: 0 },
    ...(hasPlt ? [{ name: '.rela.plt', type: SHT.RELA, align: 8, size: imports.length * 24, segment: 0 }] : []),
    { name: '.text', type: SHT.PROGBITS, align: 16, size: text.length, segment: 1 },
    ...(hasPlt ? [{ name: '.plt', type: SHT.PROGBITS, align: 16, size: 16 + imports.length * 16, segment: 1 }] : []),
    { name: '.dynamic', type: SHT.DYNAMIC, align: 8, size: 0, segment: 2 },
    ...(hasPlt ? [{ name: '.got.plt', type: SHT.PROGBITS, align: 8, size: (3 + imports.length) * 8, segment: 3 }] : []),
    ...(bssSize ? [{ name: '.bss', type: SHT.NOBITS, align: 4, size: bssSize, segment: 3 }] : []),
  ];
  // .gnu.hash 的大小：头 16 字节、布隆过滤器、桶、每个定义符号一个链值。
  const hashed = exported.length;
  // 布隆过滤器每个符号 12 位，取严格大于“位数 / 64”的 2 的幂个字（LLVM 的 NextPowerOf2）。
  let maskWords = 1;
  while (hashed && maskWords <= Math.floor((hashed * 12) / 64)) maskWords *= 2;
  order.find((item) => item.name === '.gnu.hash')!.size = 16 + maskWords * 8 + nbuckets * 4 + hashed * 4;
  const dynamicEntries = (kind === 'exe' ? needed.length + 1 + (hasPlt ? 4 : 0) : soname ? 1 : 0) + 6 + 1;
  order.find((item) => item.name === '.dynamic')!.size = dynamicEntries * 16;

  const addr = new Map<string, number>();
  let at = base + EHDR + phnum * PHDR_SIZE;
  let segment = 0;
  for (const item of order) {
    if (item.segment !== segment) {
      at = alignUp(at, PAGE);
      segment = item.segment;
    }
    at = alignUp(at, item.align);
    addr.set(item.name, at);
    at += item.size;
  }
  const A = (section: string) => addr.get(section)!;

  const symbols = defined.map((item) => ({ name: item.name, addr: A(item.section) + item.value, size: item.size, section: item.section }));
  const sectionIndex = (section: string) => order.findIndex((item) => item.name === section) + 1;

  const dynsym: DynSym[] = [{ index: 0, name: '', nameOff: 0, info: 0, shndx: 0, value: 0, size: 0, addr: A('.dynsym') }];
  imports.forEach((item) => dynsym.push({ index: dynsym.length, name: item.name, nameOff: strOff.get(item.name)!, info: item.info, shndx: 0, value: 0, size: 0, addr: 0 }));
  exported.forEach((item) => {
    const sym = symbols.find((entry) => entry.name === item.name)!;
    dynsym.push({ index: dynsym.length, name: item.name, nameOff: strOff.get(item.name)!, info: item.info, shndx: sectionIndex('.text'), value: sym.addr, size: sym.size, addr: 0 });
  });
  dynsym.forEach((sym, index) => (sym.addr = A('.dynsym') + index * 24));
  const dynsymBytes = dynsym.flatMap((sym) => [...le(sym.nameOff, 4), sym.info, 0, ...le(sym.shndx, 2), ...le(sym.value, 8), ...le(sym.size, 8)]);

  // .gnu.hash
  const bloom = Array.from({ length: maskWords }, () => 0n);
  const buckets = Array.from({ length: nbuckets }, () => 0);
  const chain: number[] = [];
  const firstHashed = symCount - hashed;
  dynsym.slice(firstHashed).forEach((sym, offset) => {
    const h = gnuHash(sym.name);
    const word = Math.floor(h / 64) % maskWords;
    bloom[word] |= (1n << BigInt(h % 64)) | (1n << BigInt((h >>> SHIFT2) % 64));
    const bucket = h % nbuckets;
    if (!buckets[bucket]) buckets[bucket] = sym.index;
    chain.push(h & ~1);
    const next = dynsym[firstHashed + offset + 1];
    if (!next || gnuHash(next.name) % nbuckets !== bucket) chain[offset] = (chain[offset] | 1) >>> 0;
  });
  const gnuHashBytes = [...le(nbuckets, 4), ...le(firstHashed, 4), ...le(maskWords, 4), ...le(SHIFT2, 4), ...bloom.flatMap((word) => le(word, 8)), ...buckets.flatMap((value) => le(value, 4)), ...chain.flatMap((value) => le(value, 4))];

  // .hash：桶数等于符号数。
  const sysBuckets = Array.from({ length: symCount }, () => 0);
  const sysChain = Array.from({ length: symCount }, () => 0);
  dynsym.slice(1).forEach((sym) => {
    const bucket = elfHash(sym.name) % symCount;
    sysChain[sym.index] = sysBuckets[bucket];
    sysBuckets[bucket] = sym.index;
  });
  const hashBytes = [...le(symCount, 4), ...le(symCount, 4), ...sysBuckets.flatMap((value) => le(value, 4)), ...sysChain.flatMap((value) => le(value, 4))];

  // .plt 和 .got.plt。
  const plt0: PltInsn[] = [];
  const plt: PltEntry[] = [];
  const gotPlt: number[] = [];
  let relaPlt: number[] = [];
  if (hasPlt) {
    const pltAt = A('.plt');
    const gotAt = A('.got.plt');
    const disp = (target: number, next: number) => le(target - next, 4);
    const ripText = (target: number, next: number) => `[rip + 0x${(target - next).toString(16)}]`;
    plt0.push(
      { addr: pltAt, bytes: [0xff, 0x35, ...disp(gotAt + 8, pltAt + 6)], text: `push qword ptr ${ripText(gotAt + 8, pltAt + 6)}`, parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'modrm', from: 1, to: 2 }, { kind: 'disp', from: 2, to: 6 }], mem: gotAt + 8, target: null },
      { addr: pltAt + 6, bytes: [0xff, 0x25, ...disp(gotAt + 16, pltAt + 12)], text: `jmp qword ptr ${ripText(gotAt + 16, pltAt + 12)}`, parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'modrm', from: 1, to: 2 }, { kind: 'disp', from: 2, to: 6 }], mem: gotAt + 16, target: null },
      { addr: pltAt + 12, bytes: [0x0f, 0x1f, 0x40, 0x00], text: 'nop dword ptr [rax]', parts: [{ kind: 'nop', from: 0, to: 4 }], mem: null, target: null },
    );
    gotPlt.push(A('.dynamic'), 0, 0);
    imports.forEach((item, index) => {
      const entry = pltAt + 16 + index * 16;
      const got = gotAt + (3 + index) * 8;
      plt.push({
        name: item.name, addr: entry, got, reloc: index,
        insns: [
          { addr: entry, bytes: [0xff, 0x25, ...disp(got, entry + 6)], text: `jmp qword ptr ${ripText(got, entry + 6)}`, parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'modrm', from: 1, to: 2 }, { kind: 'disp', from: 2, to: 6 }], mem: got, target: null },
          { addr: entry + 6, bytes: [0x68, ...le(index, 4)], text: `push ${index}`, parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'imm', from: 1, to: 5 }], mem: null, target: null },
          { addr: entry + 11, bytes: [0xe9, ...disp(pltAt, entry + 16)], text: `jmp 0x${pltAt.toString(16)}`, parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'rel', from: 1, to: 5 }], mem: null, target: pltAt },
        ],
      });
      // 延迟绑定：槽里先放 PLT 项的第二条指令，第一次调用时跳回来走解析流程。
      gotPlt.push(entry + 6);
      relaPlt = [...relaPlt, ...le(got, 8), ...le((BigInt(dynsym.findIndex((sym) => sym.name === item.name)) << 32n) | BigInt(R_X86_64_JUMP_SLOT), 8), ...le(0, 8)];
    });
  }

  // 改写 .text：数据访问 S + A − P；调用共享库函数时 L 是它的 PLT 项。
  const patches: TextPatch[] = [];
  objects.forEach((object, index) => {
    for (const rela of object.relas) {
      const local = symbols.find((item) => item.name === rela.symName);
      const entry = plt.find((item) => item.name === rela.symName);
      const s = local ? local.addr : entry!.addr;
      const atText = textBase[index] + rela.offset;
      const p = A('.text') + atText;
      const value = s + rela.addend - p;
      const before = text.slice(atText, atText + 4);
      const after = le(value, 4);
      after.forEach((byte, offset) => (text[atText + offset] = byte));
      patches.push({ sym: rela.symName, typeName: TYPE_NAME[rela.type], at: atText, s, a: rela.addend, p, value, viaPlt: !local, before, after });
    }
  });

  const dynamic: DynEntry[] = [];
  const put = (tag: number, value: number) => dynamic.push({ tag, value, addr: A('.dynamic') + dynamic.length * 16 });
  if (kind === 'exe') {
    needed.forEach((lib) => put(DT.NEEDED, strOff.get(lib)!));
    put(DT.DEBUG, 0);
    if (hasPlt) {
      put(DT.JMPREL, A('.rela.plt'));
      put(DT.PLTRELSZ, imports.length * 24);
      put(DT.PLTGOT, A('.got.plt'));
      put(DT.PLTREL, RELA);
    }
  } else if (soname) put(DT.SONAME, strOff.get(soname)!);
  put(DT.SYMTAB, A('.dynsym'));
  put(DT.SYMENT, 24);
  put(DT.STRTAB, A('.dynstr'));
  put(DT.STRSZ, dynstr.length);
  put(DT.GNU_HASH, A('.gnu.hash'));
  put(DT.HASH, A('.hash'));
  put(DT.NULL, 0);
  const dynamicBytes = dynamic.flatMap((entry) => [...le(entry.tag, 8), ...le(entry.value, 8)]);

  const content: Record<string, number[]> = {
    '.interp': interp ? [...interp].map((char) => char.charCodeAt(0)).concat(0) : [],
    '.dynsym': dynsymBytes, '.gnu.hash': gnuHashBytes, '.hash': hashBytes, '.dynstr': dynstr, '.rela.plt': relaPlt, '.text': text,
    '.plt': [...plt0.flatMap((insn) => insn.bytes), ...plt.flatMap((entry) => entry.insns.flatMap((insn) => insn.bytes))],
    '.dynamic': dynamicBytes, '.got.plt': gotPlt.flatMap((value) => le(value, 8)), '.bss': [],
  };
  const sections: OutSection[] = order.map((item, index) => {
    const bytes = content[item.name];
    if (item.type !== SHT.NOBITS && bytes.length !== item.size) throw new Error(`${item.name} 大小不符：${bytes.length} / ${item.size}`);
    return { index: index + 1, name: item.name, type: item.type, addr: A(item.name), align: item.align, bytes, size: item.size };
  });
  return { kind, name, base, phnum, sections, dynsym, dynstr, dynamic, symbols, plt, plt0, gotPlt, patches, needed, interp: interp ?? null };
}

/** 映像里任意地址的字节。 */
function readAt(image: DynImage, address: number, size: number): number[] {
  const section = image.sections.find((item) => address >= item.addr && address + size <= item.addr + item.size && item.bytes.length);
  if (!section) throw new Error(`${image.name} 的 ${address.toString(16)} 不在任何节里`);
  return section.bytes.slice(address - section.addr, address - section.addr + size);
}
const u32At = (image: DynImage, address: number) => rdU32(readAt(image, address, 4), 0);
const u64At = (image: DynImage, address: number) => Number(rdU64(readAt(image, address, 8), 0));
const dynValue = (image: DynImage, tag: number) => image.dynamic.find((entry) => entry.tag === tag)!.value;
const cstrAt = (image: DynImage, address: number) => {
  const section = image.sections.find((item) => address >= item.addr && address < item.addr + item.size)!;
  return rdCstr(section.bytes, address - section.addr);
};

/** 加载后的状态：共享库放在哪，GOT 前三项填了什么。地址每次运行都不同，这里是示例值。 */
export interface Loaded {
  libBase: number;
  linkMap: number;
  resolver: number;
  got: number[];
}

export const EXAMPLE_LOAD = { libBase: 0x7ffff7fc3000, linkMap: 0x7ffff7ffe2e0, resolver: 0x7ffff7fe7bc0 };

export function load(exe: DynImage, at = EXAMPLE_LOAD): Loaded {
  // 只填 GOT[1] 和 GOT[2]；函数槽保持链接器写的初值，等第一次调用时再解析，这就是延迟绑定。
  const got = [...exe.gotPlt];
  got[1] = at.linkMap;
  got[2] = at.resolver;
  return { ...at, got };
}

export interface ObjectProbe {
  object: string;
  bloomWord: bigint;
  bits: [number, number];
  pass: boolean;
  nbuckets: number;
  /** 哈希对桶数取余，得到第几个桶；桶里存的是链上第一个符号的下标。 */
  bucketIndex: number;
  bucket: number | null;
  /** 沿哈希链比过的符号。 */
  tried: Array<{ index: number; chain: number; name: string; match: boolean }>;
  found: DynSym | null;
}

export interface Resolution {
  relocIndex: number;
  rela: { addr: number; offset: number; symIndex: number; type: number; addend: number };
  sym: DynSym;
  name: string;
  hash: number;
  probes: ObjectProbe[];
  lib: DynImage;
  value: number;
  address: number;
}

/** 在一个映像的 .gnu.hash 里查名字：先看布隆过滤器，再按桶找链，链上比哈希、比名字。所有数据从字节里读。 */
export function lookup(image: DynImage, name: string): ObjectProbe {
  const table = dynValue(image, DT.GNU_HASH);
  const nbuckets = u32At(image, table);
  const symOffset = u32At(image, table + 4);
  const maskWords = u32At(image, table + 8);
  const shift = u32At(image, table + 12);
  const h = gnuHash(name);
  const word = BigInt(u64At(image, table + 16 + 8 * (Math.floor(h / 64) % maskWords)));
  const bits: [number, number] = [h % 64, (h >>> shift) % 64];
  const pass = Boolean((word >> BigInt(bits[0])) & (word >> BigInt(bits[1])) & 1n);
  const probe: ObjectProbe = { object: image.name, bloomWord: word, bits, pass, nbuckets, bucketIndex: h % nbuckets, bucket: null, tried: [], found: null };
  if (!pass) return probe;
  const buckets = table + 16 + 8 * maskWords;
  const chains = buckets + 4 * nbuckets;
  const first = u32At(image, buckets + 4 * (h % nbuckets));
  probe.bucket = first;
  if (!first) return probe;
  const symtab = dynValue(image, DT.SYMTAB);
  const strtab = dynValue(image, DT.STRTAB);
  for (let index = first; ; index++) {
    const value = u32At(image, chains + 4 * (index - symOffset));
    const sym = image.dynsym[index];
    const symName = cstrAt(image, strtab + u32At(image, symtab + index * 24));
    const match = ((value ^ h) >>> 1) === 0 && symName === name && sym.shndx !== 0;
    probe.tried.push({ index, chain: value, name: symName, match });
    if (match) {
      probe.found = sym;
      break;
    }
    if (value & 1) break;
  }
  return probe;
}

/** _dl_runtime_resolve 的工作：按 PLT 压栈的序号找到重定位项和符号名，按加载顺序查找，回填 GOT。 */
export function resolve(exe: DynImage, libs: DynImage[], loaded: Loaded, relocIndex: number): Resolution {
  const jmprel = dynValue(exe, DT.JMPREL);
  const addr = jmprel + relocIndex * 24;
  const info = rdU64(readAt(exe, addr + 8, 8), 0);
  const rela = { addr, offset: u64At(exe, addr), symIndex: Number(info >> 32n), type: Number(info & 0xffffffffn), addend: Number(BigInt.asIntN(64, rdU64(readAt(exe, addr + 16, 8), 0))) };
  if (rela.type !== R_X86_64_JUMP_SLOT) throw new Error(`不是 JUMP_SLOT：${rela.type}`);
  const sym = exe.dynsym[rela.symIndex];
  const name = cstrAt(exe, dynValue(exe, DT.STRTAB) + sym.nameOff);
  const probes: ObjectProbe[] = [];
  // 查找顺序：可执行文件自己在最前，然后是 DT_NEEDED 里的库。
  for (const image of [exe, ...libs]) {
    const probe = lookup(image, name);
    probes.push(probe);
    if (probe.found) {
      const value = probe.found.value;
      const address = (image === exe ? 0 : loaded.libBase) + value;
      return { relocIndex, rela, sym, name, hash: gnuHash(name), probes, lib: image, value, address };
    }
  }
  throw new Error(`找不到符号 ${name}`);
}
