import { concept, elfHeader, makeLayer, relaEntry, sectionFlags, sectionHeader, symbolEntry, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { LINKED, MAIN, SCALE_OBJ, SUM } from '../compiler';
import { SHT_NAME, type Section } from '../compiler/elf';
import type { ArtView, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';

const object = MAIN.object;
const sections = object.sections;
const sec = (name: string) => sections.find((item) => item.name === name)!;
const text = sec('.text');
const rela = sec('.rela.text');
const symtab = sec('.symtab');
const strtab = sec('.strtab');
const lines = SUM.back.assembled.lines;
const SIZE = object.shoff + sections.length * 64;

function layoutView(lit?: string): ArtView {
  const rows: Array<{ label: string; from: number; to: number; tone: Tone; note?: string; key: string }> = [
    { key: 'ehdr', label: 'ELF 文件头', from: 0, to: 64, tone: 'blue', note: 'Elf64_Ehdr' },
    { key: '.text', label: '.text', from: text.offset, to: text.offset + text.size, tone: 'green', note: '机器码' },
    { key: '.symtab', label: '.symtab', from: symtab.offset, to: symtab.offset + symtab.size, tone: 'amber', note: `${symtab.size / 24} 项` },
    { key: '.rela.text', label: '.rela.text', from: rela.offset, to: rela.offset + rela.size, tone: 'violet', note: `${rela.size / 24} 项` },
    { key: '.strtab', label: '.strtab', from: strtab.offset, to: strtab.offset + strtab.size, tone: 'slate', note: '名字' },
    { key: 'shdr', label: '节头表', from: object.shoff, to: SIZE, tone: 'teal', note: `${sections.length} 项` },
  ];
  return { kind: 'layout', title: 'sum.o 的布局', sub: `${SIZE} 字节`, total: SIZE, rows: rows.map((row) => ({ ...row, lit: row.key === lit, dim: Boolean(lit) && row.key !== lit })) };
}

const sectionTable = (lit?: number): ArtView => ({
  kind: 'table',
  title: '节头表',
  sub: `${sections.length} 项`,
  cols: ['#', '名字', '类型', '偏移', '大小', '标志'],
  widths: [20, 110, 62, 42, 42, 54],
  rows: sections.map((section) => ({
    cells: [String(section.index), section.name || '（空）', SHT_NAME[section.type].replace('SHT_', ''), hex(section.offset).replace('0x', ''), hex(section.size).replace('0x', ''), flagsShort(section)],
    tone: section.index === lit ? 'teal' as Tone : undefined,
  })),
  size: 11.5,
});

const flagsShort = (section: Section) => (section.flags & 4 ? 'AX' : section.flags & 1 ? 'WA' : section.flags & 0x40 ? 'I' : '');

const symbolTable = (lit?: number): ArtView => ({
  kind: 'table',
  title: '符号表',
  sub: `${object.symbols.length} 项`,
  cols: ['#', '名字', '绑定和类型', '节', '值', '大小'],
  widths: [20, 60, 124, 56, 44, 44],
  rows: object.symbols.map((sym) => ({
    cells: [String(sym.index), sym.name || '（空）', sym.index ? `GLOBAL ${['NOTYPE', 'OBJECT', 'FUNC'][sym.info & 15]}` : '', sym.shndx ? sections[sym.shndx].name : sym.index ? '未定义' : '', hex(sym.value).replace('0x', ''), String(sym.size)],
    tone: sym.index === lit ? 'amber' as Tone : undefined,
    tones: [null, null, null, sym.index && !sym.shndx ? 'amber' as Tone : null, null, null],
  })),
  size: 11.5,
});

const typeName = (type: number) => (type === 2 ? 'R_X86_64_PC32' : 'R_X86_64_PLT32');

const relaTable = (lit?: number): ArtView => ({
  kind: 'table',
  title: '重定位项',
  sub: `${object.relas.length} 项`,
  cols: ['偏移', '类型', '符号', '加数'],
  widths: [44, 156, 62, 44],
  rows: object.relas.map((item) => ({ cells: [hex(item.offset).replace('0x', ''), typeName(item.type), item.symName, String(item.addend)], tone: item.index === lit ? 'violet' as Tone : undefined })),
  size: 11.5,
});

/** .text 全部字节。重定位的空位高亮。 */
function textBytesView(patched: number[] | null, litAt: number | null, sub: string): ArtView {
  const data = patched ?? lines.flatMap((line) => line.enc.bytes);
  const groups: Array<{ label: string; bytes: number[]; tone: Tone; lit?: boolean; dim?: boolean }> = [];
  for (const line of lines) {
    const { offset } = line;
    const size = line.enc.bytes.length;
    const reloc = object.relas.find((item) => item.offset >= offset && item.offset < offset + size);
    if (!reloc) {
      groups.push({ label: '', bytes: data.slice(offset, offset + size), tone: 'slate', dim: true });
      continue;
    }
    groups.push({ label: '', bytes: data.slice(offset, reloc.offset), tone: 'slate', dim: true });
    groups.push({ label: reloc.symName, bytes: data.slice(reloc.offset, reloc.offset + 4), tone: litAt === reloc.offset ? 'green' : 'violet', lit: litAt === reloc.offset });
  }
  return { kind: 'bytes', title: '.text 的内容', sub, size: 11.5, groups };
}

const headerBytes = (lit: boolean): ArtView => ({
  kind: 'bytes',
  title: 'ELF 文件头的字节',
  sub: '前 64 字节',
  size: 11.5,
  groups: [
    { label: '魔数', bytes: object.bytes.slice(0, 4), tone: 'blue', lit },
    { label: '类别 字节序 版本 ABI', bytes: object.bytes.slice(4, 8), tone: 'teal' },
    { label: '填充', bytes: object.bytes.slice(8, 16), tone: 'slate', dim: true },
    { label: 'e_type', bytes: object.bytes.slice(16, 18), tone: 'amber' },
    { label: 'e_machine', bytes: object.bytes.slice(18, 20), tone: 'amber' },
    { label: 'e_version', bytes: object.bytes.slice(20, 24), tone: 'slate' },
    { label: 'e_entry', bytes: object.bytes.slice(24, 32), tone: 'slate' },
    { label: 'e_phoff', bytes: object.bytes.slice(32, 40), tone: 'slate' },
    { label: 'e_shoff', bytes: object.bytes.slice(40, 48), tone: 'violet' },
    { label: 'flags', bytes: object.bytes.slice(48, 52), tone: 'slate' },
    { label: '大小和数量', bytes: object.bytes.slice(52, 64), tone: 'green' },
  ],
});

const sectionEvent = (name: string, why: string, quick = true): PacketEvent => {
  const section = sec(name);
  const key = name;
  return pk('object', 'linker', 'blue', name, [`${SHT_NAME[section.type].replace('SHT_', '')} · ${section.size} 字节`], [7, 'ELF', `${name}：${why}（标志 ${sectionFlags(section.flags)}）`, 64],
    wire('节头表里的一项', 'mem', 'spec', sectionHeader(object, section)), { quick, art: { layout: layoutView(key), table: sectionTable(section.index) } });
};

const symbolEvents: PacketEvent[] = object.symbols.slice(1).map((sym) =>
  pk('object', 'linker', 'amber', sym.name, [sym.shndx ? `定义在 ${sections[sym.shndx].name}` : '未定义'], [7, 'ELF', `符号 ${sym.name}：${sym.shndx ? `定义在 ${sections[sym.shndx].name}，偏移 ${hex(sym.value)}，大小 ${sym.size}` : '这里只是用到，定义在别的目标文件'}`, 24],
    wire('符号表里的一项', 'mem', 'spec', symbolEntry(object, sym)), { quick: sym.index > 1, art: { layout: layoutView('.symtab'), table: symbolTable(sym.index) } }));

const relaEvents: PacketEvent[] = object.relas.map((item) => {
  return pk('object', 'linker', 'violet', item.symName, [typeName(item.type)], [7, 'RELOC', `.text+${hex(item.offset)} 要改写：${typeName(item.type)} ${item.symName} ${item.addend}`, 24],
    wire('重定位表里的一项', 'mem', 'spec', relaEntry(object, item)), {
      art: { layout: layoutView('.rela.text'), table: relaTable(item.index), bytes: textBytesView(null, item.offset, `${object.relas.length} 处空位`) },
    });
});

const finalTable = (lit?: string): ArtView => ({
  kind: 'table',
  title: '定址后的符号',
  sub: '输入 sum.o 和 scale.o',
  cols: ['符号', '所在', '地址', '大小'],
  widths: [70, 90, 90, 56],
  rows: LINKED.symbols.map((sym) => ({ cells: [sym.name, sym.section, hex(sym.address), String(sym.size)], tone: sym.name === lit ? 'green' as Tone : undefined })),
  size: 12,
});

const imageLayout = (): ArtView => ({
  kind: 'layout',
  title: '合并后的地址空间',
  sub: `.text 从 ${hex(LINKED.textAddress)} 开始`,
  total: LINKED.bssAddress + LINKED.bssSize - LINKED.textAddress,
  rows: [
    { label: 'sum（来自 sum.o）', from: 0, to: text.size, tone: 'green', note: hex(LINKED.textAddress) },
    { label: 'scale（来自 scale.o）', from: LINKED.objectBase[1], to: LINKED.text.length, tone: 'blue', note: hex(LINKED.textAddress + LINKED.objectBase[1]) },
    { label: '.bss（total）', from: LINKED.bssAddress - LINKED.textAddress, to: LINKED.bssAddress - LINKED.textAddress + LINKED.bssSize, tone: 'amber', note: hex(LINKED.bssAddress) },
  ],
});

const patchTable = (count: number, lit?: number): ArtView => ({
  kind: 'table',
  title: '重定位计算',
  sub: 'S + A − P',
  cols: ['符号', 'S', 'A', 'P', '结果'],
  widths: [52, 72, 28, 72, 62],
  rows: LINKED.patches.slice(0, count).map((patch, index) => ({
    cells: [patch.rela.symName, hex(patch.s), String(patch.a), hex(patch.p), hex(patch.value)],
    tone: index === lit ? 'green' as Tone : undefined,
  })),
  size: 11.5,
});

const scaleSym = SCALE_OBJ.object.symbols.find((sym) => sym.name === 'scale')!;

const mergeEvents: PacketEvent[] = [
  pk('object', 'linker', 'blue', 'scale.o', ['提供 scale'], [7, 'LINK', `读入第二个目标文件 scale.o：scale 定义在 .text，大小 ${scaleSym.size} 字节`, 24],
    wire('scale.o 里 scale 的符号项', 'mem', 'spec', symbolEntry(SCALE_OBJ.object, scaleSym, 'blue')), { art: { table: finalTable('scale'), layout: imageLayout() } }),
  pk('linker', 'image', 'green', '定址', [`.text ${hex(LINKED.textAddress)}`, `.bss ${hex(LINKED.bssAddress)}`], [7, 'LINK', `.text 在 ${hex(LINKED.textAddress)}，scale 在 ${hex(LINKED.textAddress + LINKED.objectBase[1])}，.bss 在 ${hex(LINKED.bssAddress)}`, null],
    wire('地址由本站的链接器决定', 'mem', '示意', concept('地址分配', LINKED.symbols.map((sym) => [sym.name, hex(sym.address), `${sym.section}，大小 ${sym.size}`]), 'green')), { art: { table: finalTable() } }),
];

const patchEvents: PacketEvent[] = LINKED.patches.map((patch, index) => {
  const layer = makeLayer(`${patch.typeName} · ${patch.rela.symName}`, 'green', `.text+${hex(patch.at)}`);
  layer.field('改写后的 4 字节', hex(patch.value), () => layer.raw(patch.after), { note: `小端序的 ${patch.value}。CPU 执行时：下一条指令地址 + 这个值 = 符号地址。` });
  layer.field('S 符号地址', hex(patch.s), () => {}, { note: patch.rela.symName });
  layer.field('A 加数', patch.a, () => {}, { note: 'RIP 指向这 4 字节之后，所以减 4。' });
  layer.field('P 被改写位置的地址', hex(patch.p), () => {}, { note: `${hex(LINKED.textAddress)} + ${hex(patch.at)}。` });
  layer.field('改写前', patch.before.map((byte) => byte.toString(16).padStart(2, '0')).join(' '), () => {});
  const patched = [...lines.flatMap((line) => line.enc.bytes)];
  LINKED.patches.slice(0, index + 1).forEach((item) => item.after.forEach((byte, offset) => (patched[item.at + offset] = byte)));
  return pk('linker', 'image', 'green', `填 ${patch.rela.symName}`, [`${hex(patch.s)} ${patch.a} − ${hex(patch.p)}`, `= ${hex(patch.value)}`], [7, 'RELOC', `${patch.typeName}：${hex(patch.s)} + (${patch.a}) − ${hex(patch.p)} = ${hex(patch.value)}`, 4],
    wire('链接器改写 .text 的 4 字节', 'mem', 'spec', layer), {
      art: { bytes: textBytesView(patched, patch.at, `已填 ${index + 1} 处`), table: patchTable(index + 1, index) },
    });
});

export const link: Lesson = seal({
  id: 'link',
  name: 'LINK',
  title: 'ELF 与重定位',
  group: 'back',
  layer: [7, 7],
  nodes: ['object', 'linker', 'image'],
  place: { object: [140, 56], linker: [450, 56], image: [760, 56] },
  labels: { object: ['目标文件', 'sum.o'], linker: ['链接器', '合并和打补丁'], image: ['可执行映像', '地址都定了'] },
  panels: { layout: [10, 146, 430, 300], table: [450, 146, 440, 300], bytes: [10, 456, 880, 210] },
  initial: { layout: layoutView(), table: sectionTable(), bytes: textBytesView(null, null, `${text.size} 字节，${object.relas.length} 处空位`) },
  start: ['object'],
  legend: [['blue', 'ELF 结构'], ['amber', '符号'], ['violet', '重定位项'], ['green', '链接结果']],
  overview: {
    full: '目标文件是什么，链接器做了什么',
    description: `编译器一次只看一个文件，所以 sum.o 里还留着 scale 和 total 的空位。ELF 目标文件除了机器码，还带着符号表和重定位表，告诉链接器哪里要填什么。这一课逐字节解码 sum.o，它和 clang 汇编出的文件完全相同，然后真的链接上 scale.o。`,
    facts: [
      ['文件大小', `${SIZE} 字节`],
      ['节', `${sections.length} 个，含一个空节`],
      ['符号', `${object.symbols.length} 项`],
      ['重定位', `${object.relas.length} 项：PC32、PLT32`],
      ['独立核对', 'clang 输出逐字节相同，llvm-objdump 读回'],
    ],
  },
  steps: [
    {
      title: 'ELF 文件头',
      desc: '开头 64 字节说明整个文件',
      detail: `魔数 7F 45 4C 46 就是 7F 加上 ELF 三个字母，工具靠它认出文件。接着是 64 位、小端、类型 ET_REL（可重定位）、机器 x86-64。e_shoff 说节头表在 ${hex(object.shoff)}，顺着它就能找到其余的一切。.o 没有入口地址，也没有程序头。`,
      facts: [['e_type', '1（ET_REL）'], ['e_machine', '0x3E（x86-64）'], ['e_shoff', hex(object.shoff)]],
      events: [
        show('linker'),
        pk('object', 'linker', 'blue', '文件头', ['7F 45 4C 46'], [7, 'ELF', `读文件头：ET_REL，EM_X86_64，节头表在 ${hex(object.shoff)}，共 ${sections.length} 个节`, 64],
          wire('sum.o 的前 64 字节', 'mem', 'spec', elfHeader(object)), { art: { layout: layoutView('ehdr'), bytes: headerBytes(true) } }),
      ],
    },
    {
      title: '节',
      desc: '代码、数据、符号各放各的',
      detail: `节头表每项 64 字节，记录每个节的名字、类型、位置和大小。.text 放机器码，标志 AX 表示要加载且可执行。.bss 是未初始化数据，total 就在这里，它在文件里不占空间，运行时才分配 4 字节清零的内存。.rela.text 的 sh_info 指向 .text，说明这些重定位作用于它。`,
      facts: [['.text', `${text.size} 字节`], ['.bss', '文件里不占空间'], ['.note.GNU-stack', '声明不需要可执行栈']],
      events: [sectionEvent('.text', '机器码', false), sectionEvent('.bss', '未初始化全局变量，不占文件空间'), sectionEvent('.rela.text', '.text 的重定位表'), sectionEvent('.symtab', '符号表')],
    },
    {
      title: '符号表',
      desc: '我提供什么，我还缺什么',
      detail: `符号表是目标文件的对外接口。sum 和 total 定义在这里，别的文件可以用；scale 的 st_shndx 是 0，表示未定义，这个文件只是用到它。第 0 项规定为空，其余都是 GLOBAL，所以 sh_info 是 1。每项 24 字节，名字存在字符串表里，这里只留偏移。`,
      facts: [['定义的', 'sum total'], ['缺的', 'scale'], ['表项大小', '24 字节']],
      events: symbolEvents,
    },
    {
      title: '重定位项',
      desc: '告诉链接器哪里要改、怎么改',
      detail: `每个 Elf64_Rela 24 字节：改哪里、用什么公式、哪个符号、加多少。两项的加数都是 -4，因为 x86 算 RIP 相对地址时，RIP 已经指向这 4 字节之后。call 用 PLT32，访问数据用 PC32：如果 scale 来自共享库，PLT32 让链接器可以经过 PLT 中转。`,
      facts: [['PC32', 'S + A − P'], ['PLT32', 'L + A − P'], ['加数', '都是 -4']],
      events: relaEvents,
    },
    {
      title: '合并定址',
      desc: '多个文件拼成一块，地址才确定',
      detail: `链接器把所有 .text 接起来，scale 按 16 字节对齐，所以 sum 后面有几个填充字节。.bss 放在下一页，这样可以设成可读写、不可执行。到这一步每个符号都有了最终地址，空位需要的 S 也就有了。这些地址是本站链接器的选择，真实链接器还要加上 crt 和库。`,
      facts: [['.text', hex(LINKED.textAddress)], ['scale', hex(LINKED.textAddress + LINKED.objectBase[1])], ['total', hex(LINKED.bssAddress)]],
      events: [show('image'), ...mergeEvents],
    },
    {
      title: '打补丁',
      desc: '算出来，写回去',
      detail: `对 total：S 是 ${hex(LINKED.patches[0].s)}，A 是 -4，P 是 ${hex(LINKED.patches[0].p)}，结果 ${hex(LINKED.patches[0].value)}。对 scale：结果 ${hex(LINKED.patches[1].value)}，CPU 执行 call 时用下一条指令地址加上它，正好落到 ${hex(LINKED.patches[1].s)}。llvm-objdump 读这个映像，显示的正是 call 到 <scale>。`,
      facts: [['total 的位移', hex(LINKED.patches[0].value)], ['scale 的位移', hex(LINKED.patches[1].value)], ['独立核对', 'llvm-objdump 反汇编映像']],
      events: [...patchEvents, note('image', '地址都填好了', 'green')],
    },
  ],
  outro: {
    title: '从源码到机器码，走完了',
    desc: `${SIZE} 字节的 sum.o 和一个填好地址的映像`,
    text: '同一段 C 程序经过词法、语法、语义、IR、优化、指令选择、寄存器分配、编码和链接，变成了 CPU 能执行的字节。本站的映像没有 _start 和 C 运行库，本机也没有 ELF 链接器，所以它只用 llvm-objdump 核对过地址，没有运行。这段机器码本身则用同一调用约定在 Rosetta 下跑过，结果和 C 源码一致。',
    facts: [['全程', '14 个阶段，同一段程序'], ['真实链接器', 'ld、lld、mold'], ['下一课', 'DYNLINK']],
  },
});
