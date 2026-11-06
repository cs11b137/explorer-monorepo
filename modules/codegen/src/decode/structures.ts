/** 把真实字节解码成检查器里的字段。字节都来自编译器的实际产物，这里只负责逐字段解释。 */
import type { Color } from '../lessons/types';
import { LayerWriter, hex, type Fidelity, type Wire } from './writer';
import type { Token } from '../compiler/lexer';
import type { PlacedLine } from '../compiler/emit';
import { REG32, REG64 } from '../compiler/x86';
import { SHT_NAME, type ObjectFile, type RelaEntry, type Section, type SymEntry } from '../compiler/elf';
import { DT_NAME, type DynEntry, type DynImage, type DynSym, type OutSection, type PltInsn } from '../compiler/dynlink';

let nextLayer = 0;

export function makeLayer(name: string, color: Color = 'blue', summary = ''): LayerWriter {
  return new LayerWriter(`layer-${nextLayer++}`, name, color, summary);
}

export function wire(at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire {
  return { at, view, fidelity, layers };
}

const hexByte = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
const showChar = (text: string) => JSON.stringify(text).slice(1, -1);

/** 概念结构：只有字段，没有字节。 */
export function concept(name: string, rows: Array<[string, string, string?]>, color: Color = 'slate'): LayerWriter {
  const layer = makeLayer(name, color);
  for (const [field, value, note] of rows) layer.field(field, value, () => {}, { note });
  return layer;
}

/** 一段 ASCII 原文：可能是源码、IR 文本或汇编文本。 */
export function textBytes(name: string, text: string, color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  layer.field('文本', text.length > 56 ? `${text.slice(0, 56)}…` : showChar(text), () => layer.ascii(text), { mono: true });
  return layer;
}

/** 词法单元：字节就是源文件里的那几个字符，其余是词法器附上的信息。 */
export function tokenRecord(token: Token, note?: string, color: Color = 'blue'): LayerWriter {
  const layer = makeLayer(`token · ${token.kind}`, color, `第 ${token.line} 行第 ${token.col} 列`);
  layer.field('原文', token.text, () => layer.ascii(token.text), { note: `源文件第 ${token.offset} 到 ${token.end - 1} 字节。`, mono: true });
  layer.field('种类', token.kind, () => {}, { note: note ?? '种类名和 clang -dump-tokens 的输出相同。' });
  layer.field('位置', `${token.line}:${token.col}`, () => {}, { note: '行列号从 1 开始。报错信息就靠它定位。' });
  return layer;
}

/** DFA 走一步：字节是当前字符，状态转移写在字段里。 */
export function dfaStep(char: string, cls: string, from: string, to: string | null, color: Color = 'amber'): LayerWriter {
  const layer = makeLayer(`DFA · ${from}`, color, to ? `→ ${to}` : '没有转移，停机');
  layer.field('读到的字符', showChar(char || 'EOF'), () => layer.ascii(char), { note: char ? `ASCII 编码 0x${char.charCodeAt(0).toString(16)}。` : '文件结束。', mono: true });
  layer.field('字符类', cls, () => {}, { note: '转移表按字符类索引，不必为每个字母单独写一列。' });
  layer.field('当前状态', from);
  layer.field('下一状态', to ?? '无', () => {}, { note: to ? '继续读下一个字符。' : '这个字符不属于当前记号，留给下一轮。这就是最长匹配。' });
  return layer;
}

/** IR 指令文本：逐段标出结果、操作码、类型和操作数。 */
export function irLine(text: string, color: Color = 'teal', summary = 'LLVM IR 文本'): LayerWriter {
  const line = text.trim();
  const layer = makeLayer('IR 指令', color, summary);
  layer.field('整行', line.length > 56 ? `${line.slice(0, 56)}…` : line, () => layer.ascii(line), { mono: true });
  const describe = (pattern: RegExp, name: string, note: string) => {
    const match = pattern.exec(line);
    if (!match) return;
    const from = match.index + match[0].indexOf(match[1]);
    layer.over(name, match[1], from, from + match[1].length, { note });
  };
  describe(/^(%[\w.]+) =/, '结果', '这条指令定义的虚拟寄存器。IR 里虚拟寄存器不限数量。');
  describe(/(?:^%[\w.]+ = )?\b(alloca|load|store|add|sub|mul|icmp|phi|call|br|ret)\b/, '操作码', OPCODE_NOTE[/\b(alloca|load|store|add|sub|mul|icmp|phi|call|br|ret)\b/.exec(line)?.[1] ?? ''] ?? '');
  describe(/\b(nsw)\b/, '标志 nsw', 'No Signed Wrap：有符号溢出的结果是 poison。C 里有符号溢出是未定义行为，前端因此可以加这个标志。');
  describe(/\b(i32|i1)\b/, '类型', 'i32 是 32 位整数，i1 是 1 位。IR 的整数不分有无符号，符号性由指令决定。');
  return layer;
}

const OPCODE_NOTE: Record<string, string> = {
  alloca: '在当前函数的栈帧里占一个槽，返回它的地址。-O0 下每个局部变量都是一个 alloca。',
  load: '从地址读值。',
  store: '把值写到地址。',
  add: '加法。IR 是三地址形式：两个输入、一个输出。',
  sub: '减法。',
  mul: '乘法。',
  icmp: '整数比较，结果是 i1。slt 表示有符号小于。',
  phi: '根据控制流从哪条边来，选一个值。它只在基本块开头出现。',
  call: '函数调用。',
  br: '跳转。基本块必须以它或 ret 结束。',
  ret: '从函数返回。',
};

export function registers(name: string, rows: Array<[reg: string, note: string]>, color: Color = 'violet', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [reg, note] of rows) {
    const number = regNumber(reg);
    layer.field(reg, `编号 ${number}`, () => layer.u8(number), { note: `${note}${note ? ' ' : ''}机器码里用这个 4 位编号表示它（高位放在 REX 里）。` });
  }
  return layer;
}

export function regNumber(name: string): number {
  const index32 = REG32.indexOf(name);
  return index32 >= 0 ? index32 : REG64.indexOf(name);
}

const PART_NAME = { rex: 'REX 前缀', opcode: '操作码', modrm: 'ModRM', sib: 'SIB', disp: '位移', imm: '立即数', rel: '相对位移' } as const;

const MOD_NOTE: Record<number, string> = {
  0: '00：内存操作数，没有位移。例外：rm=101 表示 RIP 相对，后面跟 disp32。',
  1: '01：内存操作数，后面跟 8 位位移。',
  2: '10：内存操作数，后面跟 32 位位移。',
  3: '11：操作数就是寄存器，不访问内存。',
};

const le = (bytes: number[]) => bytes.reduce((sum, byte, index) => sum + byte * 2 ** (8 * index), 0);
const signed = (value: number, width: number) => (value >= 2 ** (width * 8 - 1) ? value - 2 ** (width * 8) : value);

/** 把一条指令拆成 REX、操作码、ModRM、SIB、位移、立即数。依据 Intel SDM 第 2 卷第 2 章。 */
export function instruction(line: Pick<PlacedLine, 'text' | 'enc' | 'offset' | 'jump' | 'reloc'>, color: Color = 'blue'): LayerWriter {
  const { enc } = line;
  const layer = makeLayer(line.text, color, `.text+${hex(line.offset)} · ${enc.bytes.length} 字节`);
  for (const part of enc.parts) {
    const slice = enc.bytes.slice(part.from, part.to);
    const shown = slice.map(hexByte).join(' ');
    const from = layer.length;
    if (part.kind === 'rex' && enc.rex) {
      layer.field(PART_NAME.rex, `0x${shown}`, () => layer.raw(slice), { note: '高 4 位固定是 0100。只有用到 64 位操作数或 r8–r15 时才需要。' });
      layer.over('REX.W · 位 3', enc.rex.w, from, from + 1, { note: enc.rex.w ? '1：操作数是 64 位。' : '0：操作数按默认的 32 位。' });
      layer.over('REX.R · 位 2', enc.rex.r, from, from + 1, { note: 'ModRM.reg 的第 4 位。为 1 时 reg 表示 r8–r15。' });
      layer.over('REX.X · 位 1', enc.rex.x, from, from + 1, { note: 'SIB.index 的第 4 位。' });
      layer.over('REX.B · 位 0', enc.rex.b, from, from + 1, { note: 'ModRM.rm、SIB.base 或操作码内寄存器的第 4 位。' });
    } else if (part.kind === 'modrm' && enc.modrm) {
      const { mod, reg, rm, regExt } = enc.modrm;
      const regFull = reg | ((enc.rex?.r ?? 0) << 3);
      layer.field(PART_NAME.modrm, `0x${shown}`, () => layer.raw(slice), { note: '一个字节分成 2+3+3 位，说明操作数是谁。' });
      layer.over('mod · 位 7–6', mod.toString(2).padStart(2, '0'), from, from + 1, { note: MOD_NOTE[mod] });
      layer.over('reg · 位 5–3', reg.toString(2).padStart(3, '0'), from, from + 1, { note: regExt ? `这里是操作码扩展 /${reg}，不表示寄存器。` : `寄存器编号 ${regFull}（${REG32[regFull]} / ${REG64[regFull]}）。` });
      layer.over('rm · 位 2–0', rm.toString(2).padStart(3, '0'), from, from + 1, { note: rm === 4 && mod !== 3 ? '100：后面跟 SIB 字节。' : rm === 5 && mod === 0 ? '101：RIP 相对寻址。' : mod === 3 ? `寄存器编号 ${rm | ((enc.rex?.b ?? 0) << 3)}。` : `基址寄存器编号 ${rm | ((enc.rex?.b ?? 0) << 3)}。` });
    } else if (part.kind === 'sib' && enc.sib) {
      const { scale, index, base } = enc.sib;
      const indexFull = index | ((enc.rex?.x ?? 0) << 3);
      const baseFull = base | ((enc.rex?.b ?? 0) << 3);
      layer.field(PART_NAME.sib, `0x${shown}`, () => layer.raw(slice), { note: '基址 + 变址 × 比例，同样是 2+3+3 位。' });
      layer.over('scale · 位 7–6', `×${2 ** scale}`, from, from + 1, { note: '比例因子，可以是 1、2、4、8。' });
      layer.over('index · 位 5–3', indexFull === 4 ? '无' : REG64[indexFull], from, from + 1, { note: indexFull === 4 ? 'index=100 且 REX.X=0 表示没有变址。' : `变址寄存器，编号 ${indexFull}。` });
      layer.over('base · 位 2–0', REG64[baseFull], from, from + 1, { note: `基址寄存器，编号 ${baseFull}。` });
    } else if (part.kind === 'disp') {
      const value = signed(le(slice), slice.length);
      layer.field(PART_NAME.disp, line.reloc && part.to === line.reloc.offset - line.offset + 4 ? `待填 · ${shown}` : String(value), () => layer.raw(slice), { note: line.reloc ? `还不知道 ${line.reloc.sym} 的地址，先写 0，由重定位项 ${line.reloc.type} 让链接器回填。` : `小端序的 ${slice.length * 8} 位有符号数。` });
    } else if (part.kind === 'imm') {
      layer.field(PART_NAME.imm, String(signed(le(slice), slice.length)), () => layer.raw(slice), { note: `小端序的 ${slice.length * 8} 位有符号数，取值放在指令最后。` });
    } else if (part.kind === 'rel') {
      const note = line.jump
        ? `从下一条指令算起的距离：目标 ${hex(line.jump.target)} − 下一条 ${hex(line.offset + enc.bytes.length)} = ${line.jump.rel}。`
        : `还不知道 ${line.reloc?.sym} 的地址，先写 0，由重定位项 ${line.reloc?.type} 让链接器回填。`;
      layer.field(PART_NAME.rel, line.jump ? String(line.jump.rel) : `待填 · ${shown}`, () => layer.raw(slice), { note });
    } else {
      layer.field(PART_NAME.opcode, `0x${shown}`, () => layer.raw(slice), { note: opcodeNote(line.text, slice) });
    }
  }
  return layer;
}

function opcodeNote(text: string, opcode: number[]): string {
  const first = opcode[0];
  if (first >= 0x50 && first <= 0x57) return `0x50 + 寄存器编号的低 3 位。push 把寄存器编号直接写进了操作码。`;
  if (first >= 0x58 && first <= 0x5f) return '0x58 + 寄存器编号的低 3 位。';
  if (first === 0xc3) return 'ret：从栈顶弹出返回地址并跳过去。';
  if (first === 0xe8) return 'call rel32：先把下一条指令的地址压栈，再跳转。';
  if (first === 0xeb) return 'jmp rel8：短跳转。';
  if (first === 0xe9) return 'jmp rel32。';
  if (first >= 0x70 && first <= 0x7f) return `Jcc rel8：低 4 位是条件码。0xD 表示 ge（SF = OF）。`;
  if (first === 0x8d) return 'lea：只算地址，不访问内存，也不改标志位。';
  if (first === 0x89) return 'mov r/m, r：方向位为 0，reg 字段是源操作数。';
  if (first === 0x8b) return 'mov r, r/m：reg 字段是目标操作数。';
  if (first === 0x6b) return 'imul r, r/m, imm8：三操作数形式，目标可以和源不同。';
  if (first === 0x83) return '算术指令的 imm8 形式。具体哪种运算由 ModRM.reg 决定。';
  if (first === 0x01) return 'add r/m, r。';
  if (first === 0x31) return 'xor r/m, r。';
  if (first === 0x39) return 'cmp r/m, r：做减法只改标志位。';
  return `${text} 的操作码。`;
}

const FLAG_NAMES: Array<[number, string]> = [[1, 'WRITE'], [2, 'ALLOC'], [4, 'EXECINSTR'], [0x40, 'INFO_LINK']];
export const sectionFlags = (flags: number) => FLAG_NAMES.filter(([bit]) => flags & bit).map(([, name]) => name).join(' | ') || '无';

const rd = (bytes: number[], at: number, size: number) => bytes.slice(at, at + size);
const u = (slice: number[]) => le(slice);

/** Elf64_Ehdr：共 64 字节。 */
export function elfHeader(object: ObjectFile, color: Color = 'blue'): LayerWriter {
  const b = object.bytes;
  const layer = makeLayer('Elf64_Ehdr · 64 字节', color, 'ELF 文件头');
  const put = (name: string, value: string | number, offset: number, size: number, note?: string, depth?: number) => layer.field(name, value, () => layer.raw(rd(b, offset, size)), { note, depth });
  put('e_ident[0..3]', '7F "ELF"', 0, 4, '魔数，操作系统和工具靠它认出这是 ELF。');
  put('EI_CLASS', '2 (ELFCLASS64)', 4, 1, '64 位文件格式。');
  put('EI_DATA', '1 (小端)', 5, 1);
  put('EI_VERSION', '1', 6, 1);
  put('EI_OSABI', '0 (System V)', 7, 1);
  put('EI_ABIVERSION + 填充', '全 0', 8, 8);
  put('e_type', `${u(rd(b, 16, 2))} (ET_REL)`, 16, 2, '可重定位文件，也就是 .o。可执行文件是 ET_EXEC 或 ET_DYN。');
  put('e_machine', `${hex(u(rd(b, 18, 2)))} (EM_X86_64)`, 18, 2);
  put('e_version', u(rd(b, 20, 4)), 20, 4);
  put('e_entry', u(rd(b, 24, 8)), 24, 8, '入口地址。.o 不能直接运行，所以是 0。');
  put('e_phoff', u(rd(b, 32, 8)), 32, 8, '程序头表偏移。.o 没有程序头。');
  put('e_shoff', hex(u(rd(b, 40, 8))), 40, 8, '节头表在文件里的偏移。');
  put('e_flags', u(rd(b, 48, 4)), 48, 4);
  put('e_ehsize', u(rd(b, 52, 2)), 52, 2, '文件头本身的大小。');
  put('e_phentsize', u(rd(b, 54, 2)), 54, 2);
  put('e_phnum', u(rd(b, 56, 2)), 56, 2);
  put('e_shentsize', u(rd(b, 58, 2)), 58, 2, '每个节头 64 字节。');
  put('e_shnum', u(rd(b, 60, 2)), 60, 2, '一共几个节，包括第 0 个空节。');
  put('e_shstrndx', u(rd(b, 62, 2)), 62, 2, '节名字符串表是第几个节。');
  return layer;
}

/** Elf64_Shdr：共 64 字节。字节从文件的节头表里原样取出。 */
export function sectionHeader(object: ObjectFile, section: Section, color: Color = 'teal'): LayerWriter {
  const b = object.bytes;
  const at = object.shoff + section.index * 64;
  const layer = makeLayer(`节头 #${section.index} · ${section.name || '空'}`, color, `文件偏移 ${hex(at)}`);
  const put = (name: string, value: string | number, offset: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(rd(b, at + offset, size)), { note });
  put('sh_name', `${section.nameOff} → "${section.name}"`, 0, 4, '节名在字符串表里的偏移。');
  put('sh_type', `${section.type} (${SHT_NAME[section.type]})`, 4, 4, section.type === 8 ? 'NOBITS：运行时占内存，文件里不占空间。' : undefined);
  put('sh_flags', `${hex(section.flags)} (${sectionFlags(section.flags)})`, 8, 8);
  put('sh_addr', hex(section.addr), 16, 8, '.o 还没定址，所以是 0。');
  put('sh_offset', hex(section.offset), 24, 8, '内容在文件里的位置。');
  put('sh_size', hex(section.size), 32, 8);
  put('sh_link', section.link, 40, 4, section.type === 4 ? '符号表是第几个节。' : section.type === 2 ? '符号名字符串表是第几个节。' : undefined);
  put('sh_info', section.info, 44, 4, section.type === 4 ? '这些重定位作用于第几个节。' : section.type === 2 ? '第一个非局部符号的下标。' : undefined);
  put('sh_addralign', section.align, 48, 8);
  put('sh_entsize', section.entsize, 56, 8, section.entsize ? '表项大小。' : undefined);
  return layer;
}

const BIND: Record<number, string> = { 0: 'LOCAL', 1: 'GLOBAL', 2: 'WEAK' };
const TYPE: Record<number, string> = { 0: 'NOTYPE', 1: 'OBJECT', 2: 'FUNC', 3: 'SECTION', 4: 'FILE' };

/** Elf64_Sym：共 24 字节。 */
export function symbolEntry(object: ObjectFile, sym: SymEntry, color: Color = 'amber'): LayerWriter {
  const b = object.bytes;
  const at = sym.offset;
  const layer = makeLayer(`Elf64_Sym #${sym.index} · ${sym.name || '空'}`, color, `文件偏移 ${hex(at)}`);
  const put = (name: string, value: string | number, offset: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(rd(b, at + offset, size)), { note });
  put('st_name', `${sym.nameOff} → "${sym.name}"`, 0, 4, '符号名在字符串表里的偏移。');
  put('st_info', `${hex(sym.info)} (${BIND[sym.info >> 4]} ${TYPE[sym.info & 15]})`, 4, 1, '高 4 位是绑定，低 4 位是类型。');
  put('st_other', sym.other, 5, 1, '可见性，0 是 DEFAULT。');
  const section = object.sections[sym.shndx];
  put('st_shndx', sym.shndx ? `${sym.shndx} (${section?.name ?? ''})` : '0 (SHN_UNDEF)', 6, 2, sym.shndx ? '定义在第几个节。' : '这个目标文件没有定义它，要由链接器到别处找。');
  put('st_value', hex(sym.value), 8, 8, '在所属节里的偏移。');
  put('st_size', sym.size, 16, 8);
  return layer;
}

/** Elf64_Rela：共 24 字节。 */
export function relaEntry(object: ObjectFile, rela: RelaEntry, color: Color = 'violet'): LayerWriter {
  const b = object.bytes;
  const at = rela.fileOffset;
  const typeName = rela.type === 2 ? 'R_X86_64_PC32' : rela.type === 4 ? 'R_X86_64_PLT32' : `类型 ${rela.type}`;
  const layer = makeLayer(`Elf64_Rela #${rela.index} · ${rela.symName}`, color, `文件偏移 ${hex(at)}`);
  const put = (name: string, value: string | number, offset: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(rd(b, at + offset, size)), { note });
  put('r_offset', hex(rela.offset), 0, 8, '要改写的位置，相对 .text 开头。');
  put('r_info · 类型', `${rela.type} (${typeName})`, 8, 4, rela.type === 2 ? '计算方式 S + A − P，结果是 32 位相对地址。' : '计算方式 L + A − P。L 是符号的 PLT 项；静态链接到确定的函数时链接器可以直接用函数地址。');
  put('r_info · 符号', `${rela.symIndex} (${rela.symName})`, 12, 4, '高 32 位是符号表下标。');
  put('r_addend', rela.addend, 16, 8, '加数 A。写成 −4 是因为 CPU 算 RIP 相对地址时，RIP 已经指向这 4 字节之后。');
  return layer;
}

const sliceAt = (section: OutSection, address: number, size: number) => section.bytes.slice(address - section.addr, address - section.addr + size);

/** 动态符号表的一项：Elf64_Sym，24 字节。字节取自链接结果的 .dynsym。 */
export function dynSymEntry(image: DynImage, sym: DynSym, color: Color = 'amber'): LayerWriter {
  const section = image.sections.find((item) => item.name === '.dynsym')!;
  const b = sliceAt(section, sym.addr, 24);
  const layer = makeLayer(`${image.name} · .dynsym #${sym.index} · ${sym.name || '空'}`, color, `地址 ${hex(sym.addr)}`);
  layer.addr = sym.addr;
  const put = (name: string, value: string | number, offset: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(b.slice(offset, offset + size)), { note });
  put('st_name', `${sym.nameOff} → "${sym.name}"`, 0, 4, '名字在 .dynstr 里的偏移。动态符号表有自己的字符串表，运行时只加载这一份，.symtab 可以整个删掉。');
  put('st_info', `${hex(sym.info)} (${BIND[sym.info >> 4]} ${TYPE[sym.info & 15]})`, 4, 1, '高 4 位是绑定，低 4 位是类型。');
  put('st_other', 0, 5, 1, '可见性 DEFAULT：别的模块可以引用它。');
  put('st_shndx', sym.shndx ? `${sym.shndx} (${image.sections[sym.shndx - 1]?.name ?? ''})` : '0 (SHN_UNDEF)', 6, 2, sym.shndx ? '定义在这个模块的第几个节。' : '这个模块里没有定义，运行时由 ld.so 到别的模块里找。');
  put('st_value', hex(sym.value), 8, 8, sym.shndx ? (image.kind === 'lib' ? '相对库的加载地址。库放在哪里，就要加上那个基址。' : '链接后的地址。') : '未定义，所以是 0。');
  put('st_size', sym.size, 16, 8);
  return layer;
}

/** .rela.plt 的一项：Elf64_Rela，24 字节，类型 R_X86_64_JUMP_SLOT。 */
export function jumpSlot(image: DynImage, index: number, color: Color = 'violet'): LayerWriter {
  const section = image.sections.find((item) => item.name === '.rela.plt')!;
  const at = section.addr + index * 24;
  const b = sliceAt(section, at, 24);
  const symIndex = le(b.slice(12, 16));
  const layer = makeLayer(`Elf64_Rela · .rela.plt[${index}]`, color, `地址 ${hex(at)}`);
  layer.addr = at;
  const put = (name: string, value: string | number, from: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(b.slice(from, from + size)), { note });
  put('r_offset', hex(le(b.slice(0, 8))), 0, 8, '要回填的位置：一个 GOT 槽的运行时地址。动态重定位写的是地址，不是相对节的偏移。');
  put('r_info · 类型', `${le(b.slice(8, 12))} (R_X86_64_JUMP_SLOT)`, 8, 4, '计算方式就是 S：把符号的地址原样写进 8 字节的槽。');
  put('r_info · 符号', `${symIndex} (${image.dynsym[symIndex]?.name})`, 12, 4, '下标指向 .dynsym，不是 .symtab。');
  put('r_addend', signed(le(b.slice(16, 24)), 8), 16, 8, 'JUMP_SLOT 用不到加数。');
  return layer;
}

/** .dynamic 的一项：Elf64_Dyn，16 字节，标签加数值。 */
export function dynEntry(entry: DynEntry, image: DynImage, note?: string, color: Color = 'blue'): LayerWriter {
  const section = image.sections.find((item) => item.name === '.dynamic')!;
  const b = sliceAt(section, entry.addr, 16);
  const layer = makeLayer(`Elf64_Dyn · ${DT_NAME[entry.tag] ?? entry.tag}`, color, `地址 ${hex(entry.addr)}`);
  layer.addr = entry.addr;
  layer.field('d_tag', `${hex(entry.tag)} (${DT_NAME[entry.tag] ?? '?'})`, () => layer.raw(b.slice(0, 8)), { note: '这一项说的是什么。' });
  layer.field('d_val / d_ptr', hex(entry.value), () => layer.raw(b.slice(8, 16)), { note });
  return layer;
}

/** .dynamic 里挑出的几项：一项一层，字节都是原样。 */
export function dynEntries(image: DynImage, tags: number[], notes: Record<number, string> = {}, color: Color = 'blue'): LayerWriter[] {
  return image.dynamic.filter((entry) => tags.includes(entry.tag)).map((entry) => dynEntry(entry, image, notes[entry.tag], color));
}

type PltPart = PltInsn['parts'][number]['kind'];
const PLT_PART: Record<PltPart, string> = { opcode: '操作码', modrm: 'ModRM', disp: '位移', imm: '立即数', rel: '相对位移', nop: '多字节 nop' };

/** PLT 里的一条指令。notes 按字节分段给出说明。 */
export function pltInsn(insn: PltInsn, notes: Partial<Record<PltPart, string>> = {}, color: Color = 'blue'): LayerWriter {
  const layer = makeLayer(insn.text, color, `${hex(insn.addr)} · ${insn.bytes.length} 字节`);
  layer.addr = insn.addr;
  for (const part of insn.parts) {
    const slice = insn.bytes.slice(part.from, part.to);
    const from = layer.length;
    const shown = slice.map(hexByte).join(' ');
    if (part.kind === 'modrm') {
      const byte = slice[0];
      const ext = (byte >> 3) & 7;
      layer.field('ModRM', `0x${shown}`, () => layer.raw(slice), { note: notes.modrm ?? 'mod=00、rm=101 表示 RIP 相对寻址，后面跟 4 字节位移。' });
      layer.over('mod · 位 7–6', (byte >> 6).toString(2).padStart(2, '0'), from, from + 1);
      layer.over('reg · 位 5–3', ext.toString(2).padStart(3, '0'), from, from + 1, { note: `操作码扩展 /${ext}：${ext === 6 ? 'FF /6 是 push' : 'FF /4 是间接 jmp'}。` });
      layer.over('rm · 位 2–0', (byte & 7).toString(2).padStart(3, '0'), from, from + 1, { note: '101：RIP 相对。' });
    } else if (part.kind === 'disp' || part.kind === 'rel' || part.kind === 'imm') {
      const value = signed(le(slice), slice.length);
      layer.field(PLT_PART[part.kind], part.kind === 'imm' ? String(value) : `${value < 0 ? '-' : ''}0x${Math.abs(value).toString(16)}`, () => layer.raw(slice), { note: notes[part.kind] });
    } else {
      layer.field(PLT_PART[part.kind], `0x${shown}`, () => layer.raw(slice), { note: notes[part.kind] });
    }
  }
  return layer;
}

/** .got.plt 的一个槽：8 字节地址。example 为真时是加载后才有的值，每次运行都可能不同。 */
export function gotSlot(index: number, addr: number, value: number, note: string, example = false, color: Color = 'amber'): LayerWriter {
  const layer = makeLayer(`GOT[${index}]`, color, `地址 ${hex(addr)}`);
  layer.addr = addr;
  layer.field(`GOT[${index}]`, hex(value), () => layer.u64(value), { note, example });
  return layer;
}

/** .gnu.hash 整节：头 16 字节、布隆过滤器、桶、哈希链。 */
export function gnuHashTable(image: DynImage, color: Color = 'teal'): LayerWriter {
  const section = image.sections.find((item) => item.name === '.gnu.hash')!;
  const b = section.bytes;
  const u = (at: number) => le(b.slice(at, at + 4));
  const nbuckets = u(0);
  const maskWords = u(8);
  const layer = makeLayer(`${image.name} · .gnu.hash`, color, `${section.size} 字节`);
  layer.addr = section.addr;
  const put = (name: string, value: string | number, from: number, size: number, note?: string) => layer.field(name, value, () => layer.raw(b.slice(from, from + size)), { note });
  put('nbuckets', nbuckets, 0, 4, '桶数。名字的哈希对它取余，决定从哪个桶查。');
  put('symoffset', u(4), 4, 4, '.dynsym 里从这一项开始的符号才进哈希表，前面是未定义的符号，查找时不用看。');
  put('bloom_size', maskWords, 8, 4, '布隆过滤器有几个 64 位字。');
  put('bloom_shift', u(12), 12, 4, '第二个布隆位取哈希右移这么多位。');
  for (let word = 0; word < maskWords; word++) put(`bloom[${word}]`, hex(le(b.slice(16 + word * 8, 24 + word * 8))), 16 + word * 8, 8, '每个定义的符号在这里置 2 位。查找时两位里有一位是 0，名字就一定不在这个模块里。');
  const buckets = 16 + maskWords * 8;
  for (let bucket = 0; bucket < nbuckets; bucket++) put(`buckets[${bucket}]`, u(buckets + bucket * 4), buckets + bucket * 4, 4, '这个桶的第一个符号在 .dynsym 里的下标，0 表示空桶。');
  for (let at = buckets + nbuckets * 4, index = 0; at < b.length; at += 4, index++) put(`chain[${index}]`, hex(u(at)), at, 4, '符号名哈希值的高 31 位，最低位是 1 表示链到此为止。');
  return layer;
}

/** 最小化后的 DFA 转移表：每个状态一行，每个字符类一个字节，取值是下一状态的编号，0xFF 表示没有转移。 */
export function dfaTable(rows: Array<{ name: string; next: Array<number | null>; accept: string | null }>, symbols: string[], color: Color = 'green'): LayerWriter {
  const layer = makeLayer('转移表', color, `${rows.length} 行 × ${symbols.length} 列`);
  rows.forEach((row, index) => {
    const shown = row.next.map((to, col) => `${symbols[col]}→${to === null ? '无' : rows[to].name}`).join(' ');
    layer.field(`第 ${index} 行 · ${row.name}`, shown, () => layer.raw(row.next.map((to) => (to === null ? 0xff : to))), { note: row.accept ? `接受，产出 ${row.accept}。` : '不接受：停在这里说明还没读到完整的记号。' });
  });
  return layer;
}
