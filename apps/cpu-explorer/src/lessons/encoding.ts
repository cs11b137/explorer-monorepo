import { instructionLayer, wire } from '../decode/structures';
import type { BitSeg, BitsWidget } from '../scene/widgets';
import { assemble, bitString, decode, disasm, hex32, segmentsOf, type Format } from '../sim/riscv';
import { pk, probe, show, type as typeCommand } from './dsl';
import type { Lesson, Step } from './types';
import { bitsPanel, cell, dim, hx, instructionBits, kv } from './views';

const bytesOf = (word: number) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join(' ');

const fieldsPanel = (word: number) => {
  const d = decode(word);
  return kv(`解码结果 · ${d.format} 型`, [
    ['opcode', bitString(d.opcode, 7)],
    ['rd', d.format === 'S' || d.format === 'B' ? dim('无') : `x${d.rd}`],
    ['funct3', d.format === 'U' || d.format === 'J' ? dim('无') : bitString(d.funct3, 3)],
    ['rs1', d.format === 'U' || d.format === 'J' ? dim('无') : `x${d.rs1}`],
    ['rs2', d.format === 'R' || d.format === 'S' || d.format === 'B' ? `x${d.rs2}` : dim('无')],
    ['funct7', d.format === 'R' ? bitString(d.funct7, 7) : dim('无')],
  ]);
};

/** 把散落的立即数片段重新排回立即数自己的位序。 */
function immPanel(word: number): BitsWidget {
  const d = decode(word);
  const pieces = segmentsOf(d).filter((seg) => seg.kind === 'imm' && seg.immHi !== undefined);
  const width = d.format === 'B' ? 13 : d.format === 'J' ? 21 : 12;
  if (d.format === 'U') {
    return bitsPanel('立即数：直接作为高 20 位', (d.imm >>> 12) >>> 0, 20, [{ name: 'imm[31:12]', hi: 19, lo: 0, tone: 'amber' }], `结果 = ${hex32(d.imm)}，低 12 位补 0`, 14);
  }
  const tones = ['amber', 'teal', 'violet', 'green'] as const;
  const value = d.imm & (2 ** width - 1);
  const segs: BitSeg[] = pieces.map((seg, index) => ({ name: `inst[${seg.hi}${seg.hi === seg.lo ? '' : `:${seg.lo}`}]`, short: seg.hi === seg.lo ? String(seg.hi) : undefined, hi: seg.immHi!, lo: seg.immLo!, tone: tones[index % tones.length] }));
  if (d.format === 'B' || d.format === 'J') segs.push({ name: '恒0', short: '0', hi: 0, lo: 0, tone: 'slate' });
  return bitsPanel(`立即数还原：${d.format === 'B' ? '13' : d.format === 'J' ? '21' : '12'} 位`, value, width, segs.sort((a, b) => b.hi - a.hi), `按符号扩展后 = ${d.imm}`, width > 14 ? 14 : 19);
}

const INITIAL_IMM = bitsPanel('立即数还原', 0, 12, [{ name: '等待指令', hi: 11, lo: 0, tone: 'dim' }], '—', 19);

interface Item {
  source: string;
  format: Format;
  title: string;
  desc: string;
  detail: string;
}

const ITEMS: Item[] = [
  {
    source: 'add x3, x1, x2', format: 'R', title: 'R 型', desc: '两个源寄存器，一个目标寄存器',
    detail: 'R 型用来做寄存器之间的运算。opcode 0110011 说明这是 OP 类，funct3 和 funct7 选具体操作。add 的 funct7 全 0；把 inst[30] 改成 1 就是 sub。低字节先存，所以内存里第一个字节是 opcode 所在的 b3。',
  },
  {
    source: 'lw x5, 16(x2)', format: 'I', title: 'I 型', desc: '12 位立即数放在最高位',
    detail: 'I 型把 rs2 和 funct7 的位置合起来放 12 位有符号立即数，范围 -2048 到 2047。立即数的符号位永远在 inst[31]，硬件不用看指令类型就能开始符号扩展。addi、jalr 和所有 load 都是这种格式。',
  },
  {
    source: 'sw x6, -20(x2)', format: 'S', title: 'S 型', desc: '立即数切成两段，让开 rs2',
    detail: 'store 要读两个寄存器，没有 rd，却还要 12 位偏移。S 型把立即数切开：高 7 位放 inst[31:25]，低 5 位放原来 rd 的位置。这样 rs1 和 rs2 永远在同样的位置，解码还没结束就能读寄存器。',
  },
  {
    source: 'beq x1, x2, -8', format: 'B', title: 'B 型', desc: '最容易弄错的位序',
    detail: '分支目标一定是 2 字节的倍数，所以 imm[0] 不存，多出一位表示范围，到正负 4 KiB。位序和 S 型几乎相同，只是 inst[7] 这一位改放 imm[11]，imm[12] 放到 inst[31]。还原时要按 imm[12|11|10:5|4:1] 排回去，下面的面板就是这一步。',
  },
  {
    source: 'lui x7, 0x12345', format: 'U', title: 'U 型', desc: '20 位立即数做高位',
    detail: 'lui 把 20 位立即数放到 rd 的高 20 位，低 12 位补 0。再配一条 addi，就能拼出任意 32 位常数。要注意 addi 的立即数是符号扩展的，低 12 位最高位为 1 时，lui 那边要多加 1 补偿。auipc 用同样的格式，把立即数加到 PC 上。',
  },
  {
    source: 'jal x1, 2048', format: 'J', title: 'J 型', desc: '21 位偏移，再次打散',
    detail: 'jal 要跳得更远：21 位偏移，范围正负 1 MiB。为了和 U 型共用硬件，imm[19:12] 留在 inst[19:12] 不动，imm[11] 放在 inst[20]，imm[10:1] 放在 inst[30:21]。偏移 2048 只有 imm[11] 是 1，所以立即数字段里只有 inst[20] 是 1。',
  },
];

const words = assemble(ITEMS.map((item) => item.source));

const steps: Step[] = ITEMS.map((item, index) => {
  const word = words[index];
  const d = decode(word);
  const pc = index * 4;
  const step = index + 1;
  return {
    title: item.title,
    desc: item.desc,
    detail: item.detail,
    facts: [['指令', item.source], ['指令字', hex32(word)], ['内存字节', bytesOf(word)], ...(d.format === 'R' ? [] : [['立即数', d.format === 'U' ? hex32(d.imm) : String(d.imm)] as [string, string]])],
    events: [
      typeCommand(item.source),
      pk('asm', 'imem', 'blue', '汇编', [hex32(word), bytesOf(word)], [step, 'ENC', `${item.source} 编码成 ${hex32(word)}`, 4],
        wire('汇编器写进指令存储器', 'mem', 'spec', instructionLayer(word, { pc, text: item.source }))),
      probe({ imem: kv('指令存储器', [['地址', hx(pc)], ['指令字', cell(hex32(word), 'blue')], ['字节', bytesOf(word)]]), asm: kv('汇编器', [['源码', item.source], ['格式', cell(`${item.format} 型`, 'blue')]]) }),
      ...(index === 0 ? [show('decoder')] : []),
      pk('imem', 'decoder', 'teal', '取指', [hex32(word)], [step, 'FETCH', `从地址 ${hx(pc)} 取出指令字`, 4],
        wire('指令存储器 → 解码器', 'mem', 'spec', instructionLayer(word, { pc, text: item.source, color: 'teal' })), { quick: true }),
      probe({ word: instructionBits(word, `指令字 ${hex32(word)} · ${item.source}`, 15, `${d.format} 型 · 解码回 ${disasm(word)}`), decoder: fieldsPanel(word) }),
      ...(d.format === 'R'
        ? []
        : [
            ...(index === 1 ? [show('immgen')] : []),
            pk('decoder', 'immgen', 'amber', '立即数', [d.format === 'U' ? hex32(d.imm) : String(d.imm)], [step, 'DECODE', `按 ${d.format} 型还原立即数 = ${d.format === 'U' ? hex32(d.imm) : d.imm}`, '32b'],
              wire(`${d.format} 型立即数`, 'mem', 'spec', instructionLayer(word, { pc, text: item.source, color: 'amber' }))),
            probe({ immgen: immPanel(word) }),
          ]),
    ],
  };
});

export const encoding: Lesson = {
  id: 'encoding',
  name: 'ENCODING',
  title: '指令编码',
  group: 'cpu',
  layer: [5, 6],
  clock: 'step',
  nodes: ['asm', 'imem', 'decoder', 'immgen'],
  place: { asm: [100, 230], imem: [370, 230], decoder: [660, 230], immgen: [660, 480] },
  labels: {
    asm: ['汇编器', '文本变成位'],
    imem: ['指令存储器', '小端存放'],
    decoder: ['解码器', '按格式拆字段'],
    immgen: ['立即数生成', '还原并符号扩展'],
  },
  panels: { word: [195, 30], asm: [10, 325], imem: [270, 325], decoder: [440, 320], immgen: [225, 480] },
  main: ['word'],
  strip: ['word', ['asm', 'imem', 'decoder'], 'immgen'],
  initial: {
    word: instructionBits(0x00000013, '指令字 0x00000013 · nop', 15, 'I 型 · 解码回 addi x0, x0, 0'),
    asm: kv('汇编器', [['源码', dim('—')], ['格式', dim('—')]]),
    imem: kv('指令存储器', [['地址', dim('—')], ['指令字', dim('—')], ['字节', dim('—')]]),
    decoder: fieldsPanel(0x00000013),
    immgen: INITIAL_IMM,
  },
  start: ['asm', 'imem'],
  legend: [['blue', '编码'], ['teal', '取指'], ['amber', '立即数'], [null, '编码结果已和 LLVM 汇编器比对']],
  overview: {
    full: '一条指令就是 32 个有固定含义的位',
    description: 'CPU 不认识文字，只认识位。RV32I 的每条指令都是 32 位，按 6 种格式排列字段。这一课用真实的编码器把 6 条汇编指令逐位编码出来，再解码回去。B 型和 J 型的立即数被打散过，是最容易弄错的地方。打开检查器可以把鼠标放在每一位上。',
    facts: [
      ['指令长度', '32 位，4 字节对齐'],
      ['格式', 'R I S B U J'],
      ['指令数', 'RV32I 基础 40 条'],
      ['寄存器', '32 个，x0 恒为 0'],
      ['字节序', '小端'],
      ['依据', 'RISC-V 非特权规范'],
    ],
  },
  steps,
  outro: {
    title: '位序服务于硬件',
    desc: 'rs1、rs2、rd 永远在同样的位置',
    text: '六种格式看起来杂乱，其实只有一个目的：寄存器字段的位置固定，符号位固定在 inst[31]。解码器可以先读寄存器、先做符号扩展，等知道指令类型再决定要不要用。代价就是 S、B、J 型的立即数被切碎。',
    facts: [['符号位', '总在 inst[31]'], ['B 偏移范围', '正负 4 KiB'], ['J 偏移范围', '正负 1 MiB'], ['下一课', 'DATAPATH']],
  },
};
