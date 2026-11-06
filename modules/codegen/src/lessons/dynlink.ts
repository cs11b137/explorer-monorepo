import { dynEntries, dynSymEntry, gnuHashTable, gotSlot, instruction, jumpSlot, makeLayer, pltInsn, textBytes, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { DYN_EXE, LIBSCALE, LOADED, RESOLVED, SCALE_OBJ, SUM } from '../compiler';
import { DT, DT_NAME, sectionOf, type PltInsn, type TextPatch } from '../compiler/dynlink';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { hexBytes } from './views';

const exe = DYN_EXE;
const lib = LIBSCALE;
const text = sectionOf(exe, '.text');
const plt = sectionOf(exe, '.plt');
const gotPlt = sectionOf(exe, '.got.plt');
const dynamic = sectionOf(exe, '.dynamic');
const entry = exe.plt[0];
const [pltPush, pltJmp, pltNop] = exe.plt0;
const [slotJmp, slotPush, slotBack] = entry.insns;
const scaleSym = lib.dynsym.find((sym) => sym.name === 'scale')!;
const importSym = exe.dynsym.find((sym) => sym.name === 'scale')!;
const [totalPatch, callPatch] = [exe.patches.find((item) => item.sym === 'total')!, exe.patches.find((item) => item.sym === 'scale')!];
const scaleAddr = RESOLVED.address;
const gotAddr = (index: number) => gotPlt.addr + index * 8;

const sumLines = SUM.back.assembled.lines;
const callLine = sumLines.find((line) => line.ins.m === 'call')!;
const shownSum = sumLines.slice(sumLines.indexOf(callLine) - 1, sumLines.indexOf(callLine) + 2);
const callInsn: PltInsn = {
  addr: text.addr + callLine.offset, bytes: text.bytes.slice(callLine.offset, callLine.offset + 5), text: `call 0x${entry.addr.toString(16)}`,
  parts: [{ kind: 'opcode', from: 0, to: 1 }, { kind: 'rel', from: 1, to: 5 }], mem: null, target: entry.addr,
};
const scaleLines = SCALE_OBJ.funcs[0].back.assembled.lines;

// ---------- 代码面板 ----------

/** 代码里用到的地址写成 GOT[n]，读者不用自己算。 */
const SHORT: Record<string, string> = {
  [pltPush.text]: 'push [rip + 0x' + (gotAddr(1) - pltPush.addr - 6).toString(16) + ']',
  [pltJmp.text]: 'jmp [rip + 0x' + (gotAddr(2) - pltJmp.addr - 6).toString(16) + ']',
  [pltNop.text]: 'nop',
  [slotJmp.text]: 'jmp [rip + 0x' + (entry.got - slotJmp.addr - 6).toString(16) + ']',
};
const NOTE: Record<number, string> = { [pltPush.addr]: 'GOT[1]', [pltJmp.addr]: 'GOT[2]', [slotJmp.addr]: 'GOT[3]', [callInsn.addr]: 'scale@plt' };

interface CodeOpts { patched?: boolean; plt?: boolean; loaded?: boolean; lit?: number; tone?: Tone; sub?: string }

function codeView(opts: CodeOpts): ArtView {
  const lines: CodeLine[] = [];
  const row = (addr: number, bytes: number[], asm: string, gutter = addr.toString(16)) => {
    lines.push({ text: `${hexBytes(bytes).padEnd(18)}${asm}`, gutter, tone: addr === opts.lit ? opts.tone ?? 'amber' : undefined, note: opts.patched ? NOTE[addr] : undefined });
  };
  lines.push({ text: 'sum:', head: true });
  for (const line of shownSum) {
    const bytes = opts.patched ? text.bytes.slice(line.offset, line.offset + line.enc.bytes.length) : line.enc.bytes;
    row(text.addr + line.offset, bytes, line.ins.m === 'call' ? (opts.patched ? callInsn.text : 'call scale') : line.text.replace('dword ptr ', ''), opts.patched ? undefined : `+${line.offset.toString(16)}`);
  }
  if (opts.plt) {
    lines.push({ text: '.plt:', head: true });
    for (const insn of exe.plt0) row(insn.addr, insn.bytes, SHORT[insn.text] ?? insn.text);
    lines.push({ text: 'scale@plt:', head: true });
    for (const insn of entry.insns) row(insn.addr, insn.bytes, SHORT[insn.text] ?? insn.text);
  }
  if (opts.loaded) {
    lines.push({ text: 'libscale.so 里的 scale:', head: true });
    for (const line of scaleLines) row(LOADED.libBase + scaleSym.value + line.offset, line.enc.bytes, line.text);
  }
  return { kind: 'code', title: opts.loaded ? '进程里的代码' : 'a.out 的代码', sub: opts.sub ?? (opts.patched ? '链接后的地址' : 'sum.o，还没定址'), lines, size: 11.5 };
}

// ---------- GOT 面板 ----------

const GOT_MEANING = ['_DYNAMIC', '留给 ld.so', '留给 ld.so', 'scale@plt+6'];

function gotView(values: number[], meaning: string[], lit?: number, tone: Tone = 'amber', sub = '.got.plt'): ArtView {
  return {
    kind: 'table',
    title: 'GOT',
    sub,
    cols: ['槽', '地址', '内容', '含义'],
    widths: [52, 62, 100, 126],
    rows: values.map((value, index) => ({ cells: [`GOT[${index}]`, gotAddr(index).toString(16), value.toString(16), meaning[index]], tone: index === lit ? tone : undefined })),
    size: 11.5,
  };
}

const linkedGot = exe.gotPlt;
const loadedMeaning = ['_DYNAMIC', 'link_map', '_dl_runtime_resolve', 'scale@plt+6'];
const resolvedGot = LOADED.got.map((value, index) => (index === 3 + entry.reloc ? scaleAddr : value));
const resolvedMeaning = ['_DYNAMIC', 'link_map', '_dl_runtime_resolve', 'scale'];

// ---------- 右侧面板 ----------

const SECTION_NOTE: Record<string, string> = {
  '.interp': 'ld.so 的路径', '.dynsym': '动态符号', '.gnu.hash': '查找用的哈希', '.hash': '旧式哈希', '.dynstr': '名字', '.rela.plt': '要回填的槽', '.text': 'sum',
  '.plt': '跳板', '.dynamic': '给 ld.so 的目录', '.got.plt': '地址槽', '.bss': 'total',
};
const SECTION_TONE: Record<string, Tone> = {
  '.interp': 'teal', '.dynsym': 'amber', '.gnu.hash': 'teal', '.hash': 'teal', '.dynstr': 'slate', '.rela.plt': 'violet', '.text': 'green', '.plt': 'blue', '.dynamic': 'blue', '.got.plt': 'amber', '.bss': 'slate',
};
const lastSection = exe.sections[exe.sections.length - 1];

function layoutView(lit?: string): ArtView {
  const rows = [
    { key: 'head', label: '文件头和程序头', from: 0, to: exe.sections[0].addr - exe.base, tone: 'slate' as Tone, note: `${exe.phnum} 个程序头` },
    ...exe.sections.map((section) => ({ key: section.name, label: section.name, from: section.addr - exe.base, to: section.addr - exe.base + section.size, tone: SECTION_TONE[section.name], note: SECTION_NOTE[section.name] })),
  ];
  return {
    kind: 'layout', title: 'a.out 的布局', sub: `从 ${hex(exe.base)} 开始`, total: lastSection.addr + lastSection.size - exe.base,
    rows: rows.map(({ key, ...row }) => ({ ...row, lit: key === lit, dim: Boolean(lit) && key !== lit })),
  };
}

const libSymTable = (lit?: number): ArtView => ({
  kind: 'table', title: 'libscale.so 的 .dynsym', sub: `${lib.dynsym.length} 项`,
  cols: ['#', '名字', '类型', '节', '值', '大小'], widths: [24, 70, 90, 70, 70, 50],
  rows: lib.dynsym.map((sym) => ({
    cells: [String(sym.index), sym.name || '（空）', sym.index ? 'GLOBAL FUNC' : '', sym.shndx ? lib.sections[sym.shndx - 1].name : sym.index ? '未定义' : '', hex(sym.value), String(sym.size)],
    tone: sym.index === lit ? 'amber' as Tone : undefined,
  })),
  size: 12,
});

const exeTables = (lit: 'rela' | 'sym' | null): ArtView => ({
  kind: 'table', title: '给 ld.so 的表', sub: '.rela.plt 和 .dynsym',
  cols: ['表', '项', '内容'], widths: [80, 44, 330],
  rows: [
    { cells: ['.rela.plt', '[0]', `r_offset ${hex(gotAddr(3))}，JUMP_SLOT，符号 ${importSym.index}`], tone: lit === 'rela' ? 'violet' as Tone : undefined },
    { cells: ['.dynsym', '[0]', '（空）'] },
    { cells: ['.dynsym', `[${importSym.index}]`, `scale，GLOBAL FUNC，未定义`], tone: lit === 'sym' ? 'amber' as Tone : undefined },
    { cells: ['.dynstr', `+${importSym.nameOff}`, '"scale"'], tone: lit === 'sym' ? 'amber' as Tone : undefined },
    { cells: ['.dynstr', `+${exe.dynamic.find((item) => item.tag === DT.NEEDED)!.value}`, '"libscale.so"'] },
  ],
  size: 12,
});

const DYN_NOTE: Record<number, string> = {
  [DT.NEEDED]: '依赖 libscale.so', [DT.DEBUG]: '留给调试器', [DT.JMPREL]: '.rela.plt 的地址', [DT.PLTRELSZ]: '.rela.plt 的大小', [DT.PLTGOT]: '.got.plt 的地址', [DT.PLTREL]: '用 RELA 格式',
  [DT.SYMTAB]: '.dynsym 的地址', [DT.SYMENT]: '每项 24 字节', [DT.STRTAB]: '.dynstr 的地址', [DT.STRSZ]: '.dynstr 的大小', [DT.GNU_HASH]: '.gnu.hash 的地址', [DT.HASH]: '.hash 的地址', [DT.NULL]: '表到此结束',
};
const KEY_TAGS = [DT.NEEDED, DT.JMPREL, DT.PLTGOT, DT.SYMTAB, DT.STRTAB, DT.GNU_HASH];

const dynamicTable = (lit = KEY_TAGS as number[]): ArtView => ({
  kind: 'table', title: 'a.out 的 .dynamic', sub: `${exe.dynamic.length} 项，每项 16 字节`,
  cols: ['标签', '值', '含义'], widths: [130, 90, 230],
  rows: exe.dynamic.map((item) => ({ cells: [DT_NAME[item.tag], item.tag === DT.NEEDED ? '"libscale.so"' : hex(item.value), DYN_NOTE[item.tag]], tone: lit.includes(item.tag) ? 'blue' as Tone : undefined })),
  size: 11.5,
});

const spaceTable = (lit?: number): ArtView => ({
  kind: 'table', title: '进程的地址空间', sub: '共享库的地址每次运行都不同',
  cols: ['映像', '起始地址', '说明'], widths: [100, 110, 240],
  rows: [
    { cells: ['a.out', hex(exe.base), '地址在链接时定好'] },
    { cells: ['libscale.so', hex(LOADED.libBase), `scale 在 ${hex(LOADED.libBase)} + ${hex(scaleSym.value)}`], tone: lit === 1 ? 'teal' as Tone : undefined },
    { cells: ['ld.so', '…', `_dl_runtime_resolve 在 ${hex(LOADED.resolver)}`], tone: lit === 2 ? 'blue' as Tone : undefined },
  ],
  size: 12,
});

const [exeProbe, libProbe] = RESOLVED.probes;
const tried = libProbe.tried[libProbe.tried.length - 1];
const bitsText = (bits: [number, number]) => `第 ${bits[0]}、${bits[1]} 位`;
/** 查找的每一步，都从 .gnu.hash、.dynsym、.dynstr 的字节里读出来。 */
const LOOKUP_ROWS: Array<{ cells: string[]; tone: Tone }> = [
  { cells: ['a.out', `布隆字 ${hex(exeProbe.bloomWord)}，${bitsText(exeProbe.bits)}`, '不全是 1，跳过'], tone: 'slate' },
  { cells: ['libscale.so', `布隆字 ${hex(libProbe.bloomWord)}，${bitsText(libProbe.bits)}`, '都是 1'], tone: 'teal' },
  { cells: ['', `桶：哈希 mod ${libProbe.nbuckets} = ${libProbe.bucketIndex}`, `buckets[${libProbe.bucketIndex}] = ${libProbe.bucket}`], tone: 'teal' },
  { cells: ['', `链：#${tried.index} 的值 ${hex(tried.chain)}`, '高 31 位相同'], tone: 'teal' },
  { cells: ['', `名字：.dynstr+${libProbe.found!.nameOff}`, `"${tried.name}" 相同`], tone: 'teal' },
  { cells: ['', `st_value`, hex(RESOLVED.value)], tone: 'green' },
  { cells: ['地址', `基址 ${hex(LOADED.libBase)} + ${hex(RESOLVED.value)}`, hex(scaleAddr)], tone: 'green' },
];

const lookupTable = (count: number, lit: number[] = []): ArtView => ({
  kind: 'table', title: `查找 "${RESOLVED.name}"`, sub: `GNU 哈希 ${hex(RESOLVED.hash)}`,
  cols: ['模块', '检查', '结果'], widths: [84, 230, 152],
  rows: LOOKUP_ROWS.slice(0, count).map((row, index) => ({ cells: row.cells, tone: lit.includes(index) ? row.tone : undefined })),
  size: 11.5,
});

// ---------- 事件 ----------

function patchLayer(patch: TextPatch) {
  const layer = makeLayer(`${patch.typeName} · ${patch.sym}`, 'green', `.text+${hex(patch.at)}`);
  layer.addr = patch.p;
  layer.field('改写后的 4 字节', hex(patch.value), () => layer.raw(patch.after), { note: `小端序的 ${patch.value}。CPU 执行时：下一条指令地址 + 这个值 = 目标。` });
  layer.field(patch.viaPlt ? 'L 符号的 PLT 项' : 'S 符号地址', hex(patch.s), () => {}, { note: patch.viaPlt ? 'scale 在共享库里，链接时不知道它在哪，只能先跳到自己生成的 PLT 项。' : `${patch.sym} 定义在 a.out 自己的 .bss 里，地址已经确定。` });
  layer.field('A 加数', patch.a, () => {}, { note: 'RIP 指向这 4 字节之后，所以减 4。' });
  layer.field('P 被改写位置的地址', hex(patch.p), () => {});
  layer.field('改写前', hexBytes(patch.before), () => {});
  return layer;
}

const linkEvents: PacketEvent[] = [
  pk('linker', 'image', 'teal', 'libscale.so', ['scale 在这里'], [7, 'LINK', `libscale.so 的 .dynsym[${scaleSym.index}] 是 scale，在库的 .text，偏移 ${hex(scaleSym.value)}`, 24],
    wire('lld 读到的共享库符号', 'mem', 'spec', dynSymEntry(lib, scaleSym, 'teal')), { art: { table: libSymTable(scaleSym.index), code: codeView({}) } }),
  pk('linker', 'image', 'blue', 'DT_NEEDED', ['libscale.so'], [7, 'ELF', 'a.out 的 .dynamic 记下 DT_NEEDED libscale.so，运行时由 ld.so 去找', 16],
    wire('a.out 的 .dynamic 第一项', 'mem', 'spec', ...dynEntries(exe, [DT.NEEDED], { [DT.NEEDED]: `.dynstr 里的偏移，指向 "libscale.so"。只记名字，不记路径。` })), { art: { table: layoutView('.dynamic') } }),
  pk('linker', 'image', 'green', 'call → PLT', [`L + A − P = ${hex(callPatch.value)}`], [7, 'RELOC', `PLT32：L ${hex(callPatch.s)} + (${callPatch.a}) − P ${hex(callPatch.p)} = ${hex(callPatch.value)}，call 改指 scale@plt`, 4],
    wire('链接器改写 call 的 4 字节', 'mem', 'spec', patchLayer(callPatch)), { art: { code: codeView({ patched: true, plt: true, lit: callInsn.addr, tone: 'green' }), table: layoutView('.plt') } }),
  pk('linker', 'image', 'green', 'total', [`S + A − P = ${hex(totalPatch.value)}`], [7, 'RELOC', `PC32：total 在本文件的 .bss，S ${hex(totalPatch.s)}，结果 ${hex(totalPatch.value)}`, 4],
    wire('数据访问照常静态重定位', 'mem', 'spec', patchLayer(totalPatch)), { quick: true, art: { code: codeView({ patched: true, plt: true, lit: totalPatch.p - 2, tone: 'green' }), table: layoutView('.bss') } }),
];

const insnEvent = (insn: PltInsn, label: string, info: string, notes: Parameters<typeof pltInsn>[1], quick = false): PacketEvent =>
  pk('linker', 'image', 'blue', label, [hexBytes(insn.bytes)], [7, 'PLT', info, insn.bytes.length],
    wire(`.plt 里 ${hex(insn.addr)} 的指令`, 'mem', 'spec', pltInsn(insn, notes)), { quick, art: { code: codeView({ patched: true, plt: true, lit: insn.addr, tone: 'blue' }), table: layoutView('.plt') } });

const pltEvents: PacketEvent[] = [
  insnEvent(slotJmp, 'jmp [GOT[3]]', `scale@plt 第一条：间接跳到 GOT[3] 里的地址，GOT[3] 在 ${hex(entry.got)}`, { disp: `下一条指令 ${hex(slotJmp.addr + 6)} + 这个位移 = ${hex(entry.got)}，也就是 GOT[3]。` }),
  insnEvent(slotPush, 'push 0', `第二条：把 scale 的重定位序号 ${entry.reloc} 压栈`, { imm: '.rela.plt 里的第几项。ld.so 靠它知道要解析哪个符号、回填哪个槽。' }, true),
  insnEvent(slotBack, 'jmp .plt', `第三条：跳回 PLT0，所有函数共用这段`, { rel: `目标 ${hex(plt.addr)} − 下一条 ${hex(slotBack.addr + 5)}，是负数。` }, true),
  insnEvent(pltPush, 'push [GOT[1]]', 'PLT0 第一条：把 GOT[1] 压栈，加载时那里会放 link_map', { disp: `下一条指令 ${hex(pltPush.addr + 6)} + 这个位移 = ${hex(gotAddr(1))}，也就是 GOT[1]。` }),
  insnEvent(pltJmp, 'jmp [GOT[2]]', 'PLT0 第二条：跳到 GOT[2] 里的地址，加载时那里会放解析函数', { disp: `下一条指令 ${hex(pltJmp.addr + 6)} + 这个位移 = ${hex(gotAddr(2))}，也就是 GOT[2]。` }, true),
  insnEvent(pltNop, 'nop', 'PLT0 最后 4 字节是 nop，把 PLT0 补齐到 16 字节', { nop: '0F 1F /0 是官方推荐的多字节 nop，只用来填充。' }, true),
];

const gotEvents: PacketEvent[] = [
  pk('linker', 'image', 'amber', 'GOT[0]', [hex(linkedGot[0])], [7, 'GOT', `GOT[0] = ${hex(linkedGot[0])}：.dynamic 的地址，约定如此`, 8],
    wire('.got.plt 第 0 项', 'mem', 'spec', gotSlot(0, gotAddr(0), linkedGot[0], 'psABI 规定 GOT 第一项放 _DYNAMIC，也就是 .dynamic 的地址。')), { art: { got: gotView(linkedGot, GOT_MEANING, 0), table: layoutView('.got.plt') } }),
  pk('linker', 'image', 'amber', 'GOT[1] GOT[2]', ['全 0'], [7, 'GOT', 'GOT[1] 和 GOT[2] 先写 0，留给 ld.so 加载时填', 16],
    wire('.got.plt 第 1、2 项', 'mem', 'spec', gotSlot(1, gotAddr(1), 0, '加载时由 ld.so 填成这个模块的 link_map。'), gotSlot(2, gotAddr(2), 0, '加载时由 ld.so 填成解析函数的地址。')), { quick: true, art: { got: gotView(linkedGot, GOT_MEANING, 1) } }),
  pk('linker', 'image', 'amber', 'GOT[3]', [hex(linkedGot[3])], [7, 'GOT', `GOT[3] = ${hex(linkedGot[3])}：先指回 scale@plt 的第二条指令`, 8],
    wire('.got.plt 第 3 项：scale 的槽', 'mem', 'spec', gotSlot(3, gotAddr(3), linkedGot[3], `scale@plt + 6，也就是 push ${entry.reloc} 那条指令。第一次调用时 jmp [GOT[3]] 等于往下走一条。`)), { art: { got: gotView(linkedGot, GOT_MEANING, 3), code: codeView({ patched: true, plt: true, lit: slotPush.addr }) } }),
  pk('linker', 'image', 'violet', '.rela.plt[0]', ['JUMP_SLOT scale'], [7, 'ELF', `.rela.plt[0]：运行时回填 ${hex(gotAddr(3))}，类型 JUMP_SLOT，符号 ${importSym.index}`, 24],
    wire('a.out 的 .rela.plt', 'mem', 'spec', jumpSlot(exe, 0)), { art: { table: exeTables('rela') } }),
  pk('linker', 'image', 'amber', '.dynsym[1]', ['scale 未定义'], [7, 'ELF', `.dynsym[${importSym.index}]：scale，GLOBAL FUNC，未定义，名字在 .dynstr+${importSym.nameOff}`, 24],
    wire('a.out 的 .dynsym', 'mem', 'spec', dynSymEntry(exe, importSym), textBytes('.dynstr 里的名字', 'scale\0', 'slate', `.dynstr+${importSym.nameOff}`)), { quick: true, art: { table: exeTables('sym') } }),
];

const interp = sectionOf(exe, '.interp');
const loadEvents = [
  pk('image', 'ldso', 'teal', '.interp', [exe.interp!], [7, 'ELF', `PT_INTERP 指向 ${exe.interp}，程序启动时先运行它`, interp.size],
    wire(`a.out 的 .interp（${hex(interp.addr)}）`, 'mem', 'spec', textBytes('.interp', `${exe.interp}\0`, 'teal', `${interp.size} 字节`)), { art: { table: layoutView('.interp') } }),
  pk('image', 'ldso', 'blue', '.dynamic', ['NEEDED JMPREL PLTGOT'], [7, 'ELF', `ld.so 读 a.out 的 .dynamic（${hex(dynamic.addr)}），找到依赖和各张表`, KEY_TAGS.length * 16],
    wire('ld.so 用到的 .dynamic 项', 'mem', 'spec', ...dynEntries(exe, KEY_TAGS, Object.fromEntries(KEY_TAGS.map((tag) => [tag, DYN_NOTE[tag]])))), { art: { table: dynamicTable() } }),
  pk('ldso', 'shlib', 'teal', '映射', [hex(LOADED.libBase)], [7, 'LINK', `按 DT_NEEDED 找到 libscale.so，映射到 ${hex(LOADED.libBase)}`, 8],
    wire('共享库的加载基址', 'mem', 'spec', (() => {
      const layer = makeLayer('link_map · l_addr', 'teal', 'libscale.so');
      layer.field('l_addr', hex(LOADED.libBase), () => layer.u64(LOADED.libBase), { note: '库里所有地址都要加上这个基址。开了地址随机化，每次运行都不一样。', example: true });
      return layer;
    })(), ...dynEntries(lib, [DT.SONAME], { [DT.SONAME]: '库自己的名字，和 a.out 里 DT_NEEDED 写的一样。' }, 'teal')), { art: { table: spaceTable(1), code: codeView({ patched: true, plt: true, loaded: true }) } }),
  pk('ldso', 'got', 'amber', 'GOT[1] GOT[2]', ['link_map', '_dl_runtime_resolve'], [7, 'GOT', `填 GOT[1] = link_map，GOT[2] = _dl_runtime_resolve`, 16],
    wire('加载时写入的两个槽', 'mem', 'spec', gotSlot(1, gotAddr(1), LOADED.linkMap, 'a.out 的 link_map：解析函数靠它找到 a.out 的各张表。', true), gotSlot(2, gotAddr(2), LOADED.resolver, 'ld.so 里 _dl_runtime_resolve 的地址。', true)), {
      art: { got: gotView(LOADED.got, loadedMeaning, 2), table: spaceTable(2) },
    }),
];

const firstCall: PacketEvent[] = [
  pk('image', 'got', 'amber', 'call scale@plt', ['jmp [GOT[3]]'], [7, 'CALL', `call 到 ${hex(entry.addr)}，jmp 读 GOT[3]（${hex(entry.got)}）`, 11],
    wire('第一次调用走过的两条指令', 'mem', 'spec', pltInsn(callInsn, { rel: `下一条指令 ${hex(callInsn.addr + 5)} + ${hex(callPatch.value)} = ${hex(entry.addr)}，也就是 scale@plt。` }), pltInsn(slotJmp, { disp: `读 ${hex(entry.got)} 处的 8 字节，跳到那个地址。` })), {
      art: { code: codeView({ patched: true, plt: true, loaded: true, lit: slotJmp.addr, sub: '第一次调用' }), got: gotView(LOADED.got, loadedMeaning, 3) },
    }),
  pk('got', 'image', 'amber', hex(LOADED.got[3]), ['回到 PLT'], [7, 'GOT', `GOT[3] 还是 ${hex(LOADED.got[3])}：跳回 scale@plt 的 push`, 8],
    wire('GOT[3] 此时的内容', 'mem', 'spec', gotSlot(3, entry.got, LOADED.got[3], '还是链接器写的初值，所以这次间接跳转只是落到下一条指令。')), { art: { code: codeView({ patched: true, plt: true, loaded: true, lit: slotPush.addr, sub: '第一次调用' }) } }),
  pk('image', 'got', 'blue', 'push 0；PLT0', ['push [GOT[1]]'], [7, 'CALL', `压入序号 ${entry.reloc}，跳到 PLT0，再压入 GOT[1]`, 16],
    wire('解析前压栈的两个参数', 'mem', 'spec', pltInsn(slotPush), pltInsn(slotBack), pltInsn(pltPush)), {
      art: { code: codeView({ patched: true, plt: true, loaded: true, lit: pltPush.addr, sub: '压栈：序号和 link_map' }), got: gotView(LOADED.got, loadedMeaning, 1) },
    }),
  pk('got', 'ldso', 'blue', '_dl_runtime_resolve', [hex(LOADED.resolver)], [7, 'CALL', `jmp [GOT[2]]：进入 ld.so 的 _dl_runtime_resolve`, 14],
    wire('跳进动态链接器', 'mem', 'spec', pltInsn(pltJmp), gotSlot(2, gotAddr(2), LOADED.resolver, '加载时填好的解析函数地址。', true)), {
      art: { code: codeView({ patched: true, plt: true, loaded: true, lit: pltJmp.addr, sub: '进入解析函数' }), got: gotView(LOADED.got, loadedMeaning, 2) },
    }),
  pk('image', 'ldso', 'violet', `.rela.plt[${RESOLVED.relocIndex}]`, [`回填 ${hex(RESOLVED.rela.offset)}`], [7, 'RELOC', `序号 ${RESOLVED.relocIndex} → .rela.plt[${RESOLVED.relocIndex}]：回填 ${hex(RESOLVED.rela.offset)}，符号 ${RESOLVED.rela.symIndex}`, 24],
    wire('按序号取重定位项', 'mem', 'spec', jumpSlot(exe, RESOLVED.relocIndex)), { art: { table: exeTables('rela') } }),
  pk('image', 'ldso', 'amber', `"${RESOLVED.name}"`, [`.dynsym[${RESOLVED.sym.index}]`], [7, 'SYM', `.dynsym[${RESOLVED.sym.index}] 的名字在 .dynstr+${RESOLVED.sym.nameOff}：${RESOLVED.name}`, 24],
    wire('按符号下标取名字', 'mem', 'spec', dynSymEntry(exe, RESOLVED.sym)), { quick: true, art: { table: exeTables('sym') } }),
  pk('ldso', 'image', 'slate', '查 a.out', ['布隆过滤器是 0'], [7, 'SYM', `先查 a.out：布隆字是 0，第 ${exeProbe.bits[0]}、${exeProbe.bits[1]} 位都不是 1，跳过`, sectionOf(exe, '.gnu.hash').size],
    wire('a.out 的 .gnu.hash', 'mem', 'spec', gnuHashTable(exe, 'slate')), { art: { table: lookupTable(1, [0]) } }),
  pk('ldso', 'shlib', 'teal', '查 libscale.so', [`桶 ${libProbe.bucket}`], [7, 'SYM', `再查 libscale.so：两个布隆位都是 1，桶指向 #${libProbe.bucket}，哈希和名字都对上`, sectionOf(lib, '.gnu.hash').size],
    wire('libscale.so 的 .gnu.hash', 'mem', 'spec', gnuHashTable(lib)), { art: { table: lookupTable(5, [1, 2, 3, 4]) } }),
  pk('shlib', 'ldso', 'green', hex(scaleAddr), [`${hex(LOADED.libBase)} + ${hex(RESOLVED.value)}`], [7, 'SYM', `scale 的值 ${hex(RESOLVED.value)} 加上基址，地址是 ${hex(scaleAddr)}`, 24],
    wire('找到的符号', 'mem', 'spec', dynSymEntry(lib, RESOLVED.probes[1].found!, 'green')), { art: { table: lookupTable(7, [5, 6]) } }),
  pk('ldso', 'got', 'green', `GOT[3] = ${hex(scaleAddr)}`, ['回填'], [7, 'GOT', `回填 GOT[3]（${hex(RESOLVED.rela.offset)}）= ${hex(scaleAddr)}`, 8],
    wire('JUMP_SLOT 的计算就是 S', 'mem', 'spec', gotSlot(3, entry.got, scaleAddr, '从此这个槽里就是 scale 的真实地址。', true, 'green')), { art: { got: gotView(resolvedGot, resolvedMeaning, 3, 'green') } }),
  pk('ldso', 'shlib', 'green', 'jmp scale', [hex(scaleAddr)], [7, 'CALL', `跳到 ${hex(scaleAddr)} 执行 scale，返回时直接回到 sum`, scaleLines.reduce((sum, line) => sum + line.enc.bytes.length, 0)],
    wire('libscale.so 里 scale 的机器码', 'mem', 'spec', ...scaleLines.map((line) => instruction(line, 'green'))), { art: { code: codeView({ patched: true, plt: true, loaded: true, lit: LOADED.libBase + scaleSym.value, tone: 'green', sub: '第一次调用' }) } }),
];

const secondCall: PacketEvent[] = [
  pk('image', 'got', 'green', 'call scale@plt', ['jmp [GOT[3]]'], [7, 'CALL', `第二次调用：同样的 call 和 jmp，GOT[3] 已经是 ${hex(scaleAddr)}`, 11],
    wire('同样两条指令', 'mem', 'spec', pltInsn(callInsn), pltInsn(slotJmp)), { art: { code: codeView({ patched: true, plt: true, loaded: true, lit: slotJmp.addr, tone: 'green', sub: '第二次调用' }), got: gotView(resolvedGot, resolvedMeaning, 3, 'green') } }),
  pk('got', 'shlib', 'green', hex(scaleAddr), ['直接到 scale'], [7, 'CALL', `直接跳到 scale，不再经过 ld.so`, 8],
    wire('GOT[3] 此时的内容', 'mem', 'spec', gotSlot(3, entry.got, scaleAddr, '解析过一次，以后每次调用只多一条间接跳转。', true, 'green')), {
      art: { code: codeView({ patched: true, plt: true, loaded: true, lit: LOADED.libBase + scaleSym.value, tone: 'green', sub: '第二次调用' }) },
    }),
];

const sectionCount = exe.sections.length;

export const dynlink: Lesson = seal({
  id: 'dynlink',
  name: 'DYNLINK',
  title: '动态链接',
  group: 'back',
  layer: [7, 7],
  nodes: ['linker', 'image', 'got', 'ldso', 'shlib'],
  place: { linker: [100, 56], image: [320, 56], got: [600, 56], ldso: [460, 180], shlib: [740, 180] },
  labels: { linker: ['链接器', 'lld'], image: ['a.out', '.text 和 .plt'], got: ['.got.plt', '函数地址的槽'], ldso: ['ld.so', '动态链接器'], shlib: ['libscale.so', '共享库'] },
  panels: { code: [10, 146, 380, 330], got: [10, 486, 380, 180], table: [400, 276, 490, 390] },
  initial: { code: codeView({}), table: layoutView() },
  start: ['linker', 'image'],
  legend: [['blue', 'PLT 和 .dynamic'], ['amber', 'GOT 和符号'], ['violet', '重定位项'], ['teal', '共享库'], ['green', '解析结果']],
  overview: {
    full: '调用共享库里的函数时发生了什么',
    description: `上一课 scale 和 sum 链接在一起，地址在链接时就定了。如果 scale 在共享库 libscale.so 里，库每次加载的位置都不同，链接器只能留一个跳板 PLT 和一个地址槽 GOT，第一次调用时再由 ld.so 查出地址填进去。这一课的 ${sectionCount} 个节都由本站的链接器生成，和 lld 链接出的文件逐字节相同。`,
    facts: [
      ['可执行文件', `a.out，${sectionCount} 个节`],
      ['共享库', `libscale.so，scale 在偏移 ${hex(scaleSym.value)}`],
      ['PLT', `${plt.size} 字节：PLT0 加 1 项`],
      ['GOT', `${gotPlt.size / 8} 个槽`],
      ['独立核对', 'lld 9 链接同样的输入，llvm-objdump 读回'],
    ],
  },
  steps: [
    {
      title: '链接时',
      desc: '只知道 scale 在哪个库里',
      detail: `lld 在 libscale.so 的动态符号表里找到 scale，于是在 a.out 里记下依赖这个库。库被加载到哪里要运行时才知道，所以 call 的 PLT32 重定位用 L + A − P 计算，L 是链接器自己生成的 PLT 项 ${hex(entry.addr)}。total 定义在 a.out 自己的 .bss 里，照常用 S + A − P。`,
      facts: [['call 的位移', hex(callPatch.value)], ['scale@plt', hex(entry.addr)], ['total 的位移', hex(totalPatch.value)]],
      events: [show('linker'), ...linkEvents],
    },
    {
      title: 'PLT',
      desc: '每个外部函数一段 16 字节的跳板',
      detail: `scale@plt 只有三条指令：间接跳到 GOT[3] 里的地址，压入重定位序号，跳回 PLT0。PLT0 是所有函数共用的一段，把 GOT[1] 压栈后跳到 GOT[2]。这些位移都是 RIP 相对的，代码本身不用改，只有 GOT 里的数据会变。`,
      facts: [['scale@plt', `${hex(entry.addr)}，16 字节`], ['PLT0', `${hex(plt.addr)}，16 字节`], ['FF 25', 'jmp [rip + disp32]']],
      events: pltEvents,
    },
    {
      title: 'GOT 和给加载器的表',
      desc: '数据可以改，代码不用改',
      detail: `.got.plt 前三项是约定：GOT[0] 放 .dynamic 的地址，GOT[1] 和 GOT[2] 留给 ld.so。scale 的槽 GOT[3] 先指回 scale@plt 的第二条指令。.rela.plt 里的 JUMP_SLOT 项告诉 ld.so：这个槽要填符号 scale 的地址。`,
      facts: [['GOT[3] 初值', hex(linkedGot[3])], ['JUMP_SLOT', `回填 ${hex(gotAddr(3))}`], ['.dynsym[1]', 'scale，未定义']],
      events: gotEvents,
    },
    {
      title: '加载',
      desc: 'ld.so 先映射库，再填 GOT 的前几项',
      detail: `a.out 的 PT_INTERP 指向 ld.so，程序启动时最先运行的是它。ld.so 读 .dynamic，按 DT_NEEDED 找到并映射 libscale.so，然后在 GOT[1]、GOT[2] 填上 link_map 和 _dl_runtime_resolve 的地址。scale 的槽暂时不动：默认是延迟绑定，用到才解析。`,
      facts: [['库基址', `${hex(LOADED.libBase)}（示例）`], ['GOT[2]', '_dl_runtime_resolve'], ['GOT[3]', '还没动']],
      events: [show('ldso', 'shlib', 'got'), ...loadEvents, note('got', 'GOT[3] 还指回 PLT')],
    },
    {
      title: '第一次调用',
      desc: '绕一圈，由 ld.so 查出地址',
      detail: `call 到 scale@plt，间接跳转读到的是 PLT 自己的下一条，于是压入序号 ${entry.reloc}，经 PLT0 进入 _dl_runtime_resolve。它按序号找到 .rela.plt[0]，取出符号名 scale，先查 a.out，再查 libscale.so：GNU 哈希的布隆过滤器能很快排除不相关的模块。找到后把地址写进 GOT[3]，再跳过去执行。`,
      facts: [['GNU 哈希', hex(RESOLVED.hash)], ['找到', `libscale.so #${libProbe.found!.index}`], ['回填', `${hex(gotAddr(3))} = ${hex(scaleAddr)}`]],
      events: firstCall,
    },
    {
      title: '第二次调用',
      desc: '一条间接跳转直达',
      detail: `同样的 call 和 jmp，GOT[3] 里已经是 scale 的地址，直接跳过去。延迟绑定让程序启动时不用解析它从不调用的函数。设置 LD_BIND_NOW 或链接时加 -z now，ld.so 会在启动时就填好所有槽，再配合 RELRO 把 GOT 设成只读。`,
      facts: [['额外开销', '一次间接跳转'], ['立即绑定', '-z now'], ['加固', 'RELRO']],
      events: [...secondCall, note('shlib', '不再经过 ld.so', 'green')],
    },
  ],
  outro: {
    title: '多一层间接，换来共享',
    desc: '代码不变，地址放在可写的表里',
    text: '共享库的代码在所有进程里只有一份，每个进程的 GOT 各填各的地址。代价是每次调用多一次间接跳转，第一次还要查一遍符号。真实的 ld.so 还要处理符号版本、预链接和 IFUNC，但跳板和地址槽的分工就是这一课看到的样子。',
    facts: [['全部课程', '16 课'], ['真实加载器', 'glibc ld.so、musl'], ['回顾', '可以从 REGEX 重新看']],
  },
});
