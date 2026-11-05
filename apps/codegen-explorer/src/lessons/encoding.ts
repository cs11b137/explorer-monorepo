import { instruction, wire } from '../decode/structures';
import { SUM } from '../compiler';
import type { PlacedLine } from '../compiler/emit';
import { encode, fmtIns, r32, r64, R8, RDI, REG32, REG64 } from '../compiler/x86';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { hexBytes } from './views';

const asm = SUM.back.assembled;
const lines = asm.lines;
const total = asm.bytes.length;
const find = (text: string) => lines.find((line) => line.text.startsWith(text))!;

const PART_TONE: Record<string, Tone> = { rex: 'violet', opcode: 'blue', modrm: 'amber', sib: 'teal', disp: 'green', imm: 'green', rel: 'green' };
const PART_LABEL: Record<string, string> = { rex: 'REX', opcode: '操作码', modrm: 'ModRM', sib: 'SIB', disp: '位移', imm: '立即数', rel: '相对位移' };

function listView(active: string | null, tone: Tone = 'amber', upTo = lines.length): ArtView {
  const body: CodeLine[] = lines.map((line, index) => ({
    text: `${index < upTo ? hexBytes(line.enc.bytes).padEnd(18) : ' '.repeat(18)}${line.text}`,
    gutter: line.offset.toString(16).padStart(2, '0'),
    tone: line.text === active ? tone : undefined,
    dim: index >= upTo,
  }));
  return { kind: 'code', title: 'sum 的机器码', sub: `${total} 字节`, lines: body, size: 12, focus: Math.max(body.findIndex((line) => line.tone), 0) };
}

type Encodable = Pick<PlacedLine, 'text' | 'enc' | 'offset' | 'jump' | 'reloc'>;

function bytesView(line: Encodable): ArtView {
  return {
    kind: 'bytes',
    title: line.text,
    sub: `${line.enc.bytes.length} 字节`,
    size: 17,
    groups: line.enc.parts.map((part) => ({ label: PART_LABEL[part.kind], bytes: line.enc.bytes.slice(part.from, part.to), tone: PART_TONE[part.kind], lit: true })),
    caption: `.text+0x${line.offset.toString(16)}`,
  };
}

const bin = (value: number, width: number) => value.toString(2).padStart(width, '0');

function fieldsView(line: Encodable, extra: Array<[string, string, string, string]> = []): ArtView {
  const { enc } = line;
  const rows: Array<{ cells: string[]; tone?: Tone }> = [];
  if (enc.rex) {
    const { w, r, x, b } = enc.rex;
    rows.push({ cells: ['REX', `0100 ${w}${r}${x}${b}`, `W=${w} R=${r} X=${x} B=${b}`, w ? '64 位操作数' : r || b || x ? '用到了 r8–r15' : ''], tone: 'violet' });
  }
  const opcode = enc.parts.find((part) => part.kind === 'opcode')!;
  rows.push({ cells: ['操作码', hexBytes(enc.bytes.slice(opcode.from, opcode.to)), line.text.split(' ')[0], ''], tone: 'blue' });
  if (enc.modrm) {
    const { mod, reg, rm, regExt } = enc.modrm;
    const regFull = reg | ((enc.rex?.r ?? 0) << 3);
    const rmFull = rm | ((enc.rex?.b ?? 0) << 3);
    const names = line.text.includes('rsp') || line.text.includes('rbp') ? REG64 : REG32;
    rows.push({ cells: ['mod', bin(mod, 2), mod === 3 ? '寄存器' : mod === 0 ? '内存，无位移' : mod === 1 ? '内存 + disp8' : '内存 + disp32', ''], tone: 'amber' });
    rows.push({ cells: ['reg', bin(reg, 3), regExt ? `扩展 /${reg}` : names[regFull], regExt ? '选择运算' : ''], tone: 'amber' });
    rows.push({ cells: ['rm', bin(rm, 3), mod === 3 ? names[rmFull] : rm === 4 ? '接 SIB' : rm === 5 && mod === 0 ? 'RIP 相对' : REG64[rmFull], ''], tone: 'amber' });
  }
  if (enc.sib) {
    const { scale, index, base } = enc.sib;
    rows.push({ cells: ['scale', bin(scale, 2), `×${2 ** scale}`, ''], tone: 'teal' });
    rows.push({ cells: ['index', bin(index, 3), REG64[index | ((enc.rex?.x ?? 0) << 3)], '变址'], tone: 'teal' });
    rows.push({ cells: ['base', bin(base, 3), REG64[base | ((enc.rex?.b ?? 0) << 3)], '基址'], tone: 'teal' });
  }
  for (const [a, b, c, d] of extra) rows.push({ cells: [a, b, c, d], tone: 'green' });
  return { kind: 'table', title: '逐位拆解', sub: 'Intel SDM 第 2 卷', cols: ['字段', '位', '含义', '备注'], widths: [60, 84, 130, 200], rows, size: 12 };
}

function ev(line: Encodable, label: string, why: string, extra: Array<[string, string, string, string]> = [], quick = false, inList = true): PacketEvent {
  const tone: Tone = 'amber';
  return pk('regalloc', 'encoder', 'amber', label, [hexBytes(line.enc.bytes)], [6, 'ENCODE', `${line.text} → ${hexBytes(line.enc.bytes)}：${why}`, line.enc.bytes.length],
    wire(inList ? `sum+0x${line.offset.toString(16)}` : '对照：同一个编码器的输出', 'mem', 'spec', instruction(line as PlacedLine, 'blue')), {
      quick,
      art: { bytes: bytesView(line), fields: fieldsView(line, extra), ...(inList ? { list: listView(line.text, tone) } : {}) },
    });
}

const movZero = { m: 'mov', d: r32(RDI), s: { imm: 0 } } as const;
const compareMov: Encodable = { text: fmtIns(movZero), enc: encode(movZero), offset: 0, jump: null, reloc: null };
const addR8 = { m: 'add', d: r64(R8), s: r64(RDI) } as const;
const compareRex: Encodable = { text: fmtIns(addR8), enc: encode(addR8), offset: 0, jump: null, reloc: null };

const movRbp = find('mov rbp');
const movEdx = find('mov edx');
const movEbx = find('mov ebx');
const lea = find('lea esi');
const leaDisp = find('lea r8d');
const imul = find('imul');
const sub = find('sub rsp');
const xor = find('xor edi');
const jge = find('jge');
const jmp = find('jmp');
const store = find('mov dword ptr');
const call = find('call');

export const encoding: Lesson = seal({
  id: 'encoding',
  name: 'ENCODING',
  title: 'x86-64 机器码',
  group: 'back',
  layer: [6, 6],
  nodes: ['regalloc', 'encoder', 'object'],
  place: { regalloc: [140, 56], encoder: [450, 56], object: [760, 56] },
  labels: { regalloc: ['汇编指令', '寄存器已确定'], encoder: ['编码器', '指令变字节'], object: ['.text', `${total} 字节`] },
  panels: { list: [10, 146, 370, 520], bytes: [390, 146, 500, 150], fields: [390, 306, 500, 360] },
  initial: { list: listView(null, 'amber', 0), bytes: bytesView(find('push rbp')), fields: fieldsView(find('push rbp')) },
  start: ['regalloc', 'encoder'],
  legend: [['amber', '编码一条指令'], ['green', '写入 .text'], [null, '字节和 clang 汇编出的完全相同']],
  overview: {
    full: '汇编指令变成 CPU 真正读的字节',
    description: 'x86-64 的指令长短不一，从 1 字节到 15 字节。一条指令由几个可选部分拼成：前缀、操作码、ModRM、SIB、位移、立即数。这一课把 sum 的每条指令拆开来看。这些字节都由本站的编码器算出，和 clang 汇编同一段文本得到的字节完全相同。',
    facts: [
      ['总大小', `${total} 字节，${lines.length} 条指令`],
      ['最短', `${Math.min(...lines.map((line) => line.enc.bytes.length))} 字节`],
      ['最长', `${Math.max(...lines.map((line) => line.enc.bytes.length))} 字节`],
      ['依据', 'Intel SDM 第 2 卷'],
      ['独立核对', 'clang 汇编 + llvm-objdump'],
    ],
  },
  steps: [
    {
      title: '最短的指令',
      desc: 'ret 只要 1 个字节',
      detail: '常用的指令被设计得很短。ret 就是 C3，没有操作数要说明。push 把寄存器编号直接写进操作码的低 3 位：0x50 加 rbp 的编号 5 就是 55，加 rbx 的编号 3 就是 53。一个函数开头经常是 55，看机器码时一眼就能认出来。',
      facts: [['ret', 'C3'], ['push rbp', '55 = 0x50 + 5'], ['push rbx', '53 = 0x50 + 3']],
      events: [ev(find('ret'), 'ret', '一个字节的操作码'), ev(find('push rbp'), 'push rbp', '寄存器编号写在操作码里', [], true), ev(find('push rbx'), 'push rbx', '同上，编号换成 3', [], true)],
    },
    {
      title: 'REX 前缀',
      desc: '要 64 位或 r8–r15，就多一个字节',
      detail: 'x86-64 从 32 位扩展而来，默认操作数还是 32 位，寄存器编号也只留了 3 位。REX 补上差的部分：W 表示 64 位，R、X、B 分别给三个寄存器字段补第 4 位。mov rbp, rsp 要 64 位，所以有 48。mov edx, r8d 用到了 r8，所以有 44。其他大多数指令没有它，这就是偏爱 32 位操作的一个好处。',
      facts: [['48', 'W=1，64 位'], ['44', 'R=1，reg 是 r8–r15'], ['固定高位', '0100']],
      events: [ev(movRbp, 'mov rbp, rsp', 'REX.W=1 表示 64 位'), ev(movEdx, 'mov edx, r8d', 'REX.R=1，reg 字段是 r8d', [], true), ev(compareRex, '对照', '目标是 r8，REX.B 和 W 同时为 1', [], true, false)],
    },
    {
      title: 'ModRM',
      desc: '一个字节说清两个操作数',
      detail: `mov ebx, edi 编码成 89 FB。89 表示 mov r/m, r。FB 拆成 11 111 011：mod=11 表示 r/m 是寄存器，reg=111 是 edi（编号 7），rm=011 是 ebx（编号 3）。方向是由操作码决定的：89 从 reg 到 rm，8B 反过来。两个操作数都是寄存器时，两种写法都合法，汇编器通常选 89。`,
      facts: [['mod', '11，寄存器'], ['reg', '111，edi'], ['rm', '011，ebx']],
      events: [ev(movEbx, 'mov ebx, edi', 'ModRM = 11 111 011')],
    },
    {
      title: 'SIB',
      desc: '基址加变址，再多一个字节',
      detail: 'lea esi, [rdi + rcx] 的 ModRM 里 rm=100，意思是后面跟 SIB。SIB 同样分成 2+3+3 位：比例、变址、基址。0F 就是 00 001 111，比例 1，变址 rcx，基址 rdi。lea r8d, [rdx + 1] 只有基址没有变址，不用 SIB，但 mod=01 表示后面有 8 位位移。',
      facts: [['SIB', hexBytes(lea.enc.bytes.slice(-1))], ['lea 不访问内存', '只把地址算出来'], ['rsp 和 r12', '当基址时必须带 SIB']],
      events: [ev(lea, 'lea + SIB', 'rm=100 表示接 SIB'), ev(leaDisp, 'lea + disp8', 'mod=01，后面 1 字节位移', [['位移', hexBytes(leaDisp.enc.bytes.slice(-1)), '+1', '有符号 8 位']], true)],
    },
    {
      title: '立即数',
      desc: '小常数只占 1 字节',
      detail: `imul ecx, ebx, 6 用 6B，立即数只有 1 字节。如果常数超过 -128 到 127，就得换成 69，占 4 字节。xor edi, edi 和 ${compareMov.text} 效果相同，但前者 2 字节，后者 ${compareMov.enc.bytes.length} 字节，所以编译器总用 xor 清零。这些选择省下的字节能让更多代码放进指令缓存。`,
      facts: [['imm8', 'imul 用 6B'], ['xor 清零', '2 字节'], ['mov 清零', `${compareMov.enc.bytes.length} 字节`]],
      events: [ev(imul, 'imul 带常数', '三操作数形式，imm8', [['立即数', hexBytes(imul.enc.bytes.slice(-1)), '6', '在指令最后']]), ev(sub, 'sub rsp, 8', '83 /5：reg 字段是操作码扩展', [['立即数', hexBytes(sub.enc.bytes.slice(-1)), '8', '']], true), ev(xor, 'xor edi, edi', '2 字节清零', [], true), ev(compareMov, '对照 mov', '同样清零，长 3 字节', [], true, false)],
    },
    {
      title: '跳转和空位',
      desc: '有的地址现在算得出，有的算不出',
      detail: `jge 的目标就在同一个函数里，距离是 ${jge.jump!.rel}，能直接写进 1 字节。汇编器先假设都能用短跳转，放不下才加长。jmp 往回跳，位移是负数 ${jmp.jump!.rel}。但 total 和 scale 的地址要到链接才知道，所以这里先写 0，留下一张重定位项。下一课就来填这两处空位。`,
      facts: [['jge', `rel8 = ${jge.jump!.rel}`], ['jmp', `rel8 = ${jmp.jump!.rel}`], ['待填', `${asm.relocs.length} 处`]],
      events: [
        ev(jge, 'jge', '从下一条指令算起的距离', [['rel8', hexBytes(jge.enc.bytes.slice(-1)), `+${jge.jump!.rel}`, `目标 0x${jge.jump!.target.toString(16)}`]]),
        ev(jmp, 'jmp', '负数，往回跳', [['rel8', hexBytes(jmp.enc.bytes.slice(-1)), String(jmp.jump!.rel), `目标 0x${jmp.jump!.target.toString(16)}`]], true),
        ev(store, 'mov [rip + total]', '待填', [['disp32', '00 00 00 00', '待填', store.reloc!.type]], true),
        ev(call, 'call scale', 'rel32 先写 0', [['rel32', '00 00 00 00', '待填', call.reloc!.type]], true),
        show('object'),
        pk('encoder', 'object', 'green', '.text', [`${total} 字节`], [6, 'ENCODE', `全部 ${lines.length} 条指令写入 .text，共 ${total} 字节，${asm.relocs.length} 处待填`, total],
          wire('完整的 .text 节', 'mem', 'spec', ...lines.slice(0, 6).map((line) => instruction(line, 'blue'))), { art: { list: listView(null) } }),
        note('object', '和 clang 逐字节相同', 'green'),
      ],
    },
  ],
  outro: {
    title: '程序变成了字节',
    desc: '只差把两处地址填上',
    text: `sum 现在是 ${total} 字节的机器码。把同样的汇编文本交给 clang，得到的 .text 逐字节相同；另有一张覆盖各种操作数组合的指令表也做了同样的对照。真实指令集比这复杂得多，还有 VEX、EVEX 等更长的前缀，但基本结构一样。`,
    facts: [['前缀', '只有需要时才出现'], ['小端序', '多字节数低位在前'], ['下一课', 'LINK']],
  },
});

