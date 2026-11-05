import { concept, instructionLayer, registers, wire } from '../decode/structures';
import { barrelShift, shiftAddMul } from '../sim/arith';
import { alu as run, type AluOp } from '../sim/exec';
import { assemble, bitString, hex32 } from '../sim/riscv';
import { pk, probe, show } from './dsl';
import type { Lesson } from './types';
import { bitsPanel, cell, dim, grid, hx, kv, on } from './views';

const A = 0b1100;
const B = 0b1010;
const low = (value: number) => bitString(value & 0xff, 8);

const regPanel = (title: string, value: number) => kv(title, [['十六进制', hx(value)], ['有符号', String(value | 0)], ['无符号', String(value >>> 0)]]);
const aluPanel = (op: string, a: number, b: number, y: number | null) => kv('ALU', [['操作', op === '—' ? dim('—') : on(op, 'blue')], ['A', hx(a)], ['B', hx(b)], ['Y', y === null ? dim('—') : cell(hx(y), 'green')]]);
const resultPanel = (value: number, caption: string) => bitsPanel('结果 Y', value, 32, [
  { name: '[31:16]', hi: 31, lo: 16, tone: 'slate' },
  { name: '[15:8]', hi: 15, lo: 8, tone: 'blue' },
  { name: '[7:0]', hi: 7, lo: 0, tone: 'teal' },
], caption, 12);

const [andWord] = assemble(['and x3, x1, x2']);
const [subWord] = assemble(['sub x3, x1, x2']);
const [addWord] = assemble(['add x3, x1, x2']);
const [sraWord] = assemble(['sra x3, x1, x2']);
const [mulWord] = assemble(['mul x3, x1, x2']);
const [sltWord, sltuWord] = assemble(['slt x3, x1, x2', 'sltu x3, x1, x2']);

const AND = run('AND', A, B);
const OR = run('OR', A, B);
const XOR = run('XOR', A, B);
const ADD = run('ADD', A, B);
const SUB = run('SUB', A, B);
const MINUS1 = 0xffffffff;
const SLT = run('SLT', MINUS1, 1);
const SLTU = run('SLTU', MINUS1, 1);
const SHIFT_IN = 0xf0000000;
const SHAMT = 13;
const shift = barrelShift(SHIFT_IN, SHAMT, 'SRA');
const shiftLogical = barrelShift(SHIFT_IN, SHAMT, 'SRL');
const M1 = 13;
const M2 = 11;
const mul = shiftAddMul(M1, M2);

const shiftTable = (upto: number) => grid(`桶形移位器：sra，shamt = ${SHAMT} = ${bitString(SHAMT, 5)}`, [['这层移', 44], ['开', 26], ['这层的输出', 96]], shift.stages.map((stage, index) => [
  String(stage.amount),
  index > upto ? dim('·') : stage.enabled ? on('1', 'amber') : '0',
  index > upto ? dim('·') : cell(hx(stage.value), stage.enabled ? 'amber' : undefined),
]));

const mulTable = (upto: number) => grid(`移位相加：${M1} × ${M2}`, [['拍', 26], ['乘数', 46], ['最低位', 42], ['被乘数', 46], ['积', 46]], mul.iterations.map((item, index) => [
  String(index + 1),
  index > upto ? dim('·') : bitString(item.multiplier, 4),
  index > upto ? dim('·') : item.bit ? on('1', 'amber') : '0',
  index > upto ? dim('·') : String(item.multiplicand),
  index > upto ? dim('·') : cell(String(item.product), item.bit ? 'green' : undefined),
]));

const opFields = (a: number, b: number, op: AluOp, y: number) => concept('ALU 这一拍', [
  ['操作', op],
  ['A', `${hx(a)}（${a | 0}）`],
  ['B', `${hx(b)}（${b | 0}）`],
  ['Y', `${hx(y)}（${y | 0}）`],
], 'green');

const CYCLE_MUL = 9;

export const aluLesson: Lesson = {
  id: 'alu',
  name: 'ALU',
  title: '算术逻辑单元',
  group: 'data',
  layer: [3, 4],
  clock: 'cycle',
  nodes: ['rega', 'regb', 'alu', 'regy', 'shifter', 'multiplier'],
  place: { rega: [235, 130], regb: [560, 130], alu: [395, 320], regy: [395, 505], shifter: [70, 300], multiplier: [725, 300] },
  labels: {
    rega: ['操作数 A', 'rs1'],
    regb: ['操作数 B', 'rs2'],
    alu: ['ALU', '含结果选择器'],
    regy: ['结果 Y', '写回 rd'],
    shifter: ['桶形移位器', '5 层选择器'],
    multiplier: ['乘法器', 'M 扩展'],
  },
  panels: { rega: [150, 0], regb: [480, 0], alu: [490, 360], regy: [195, 590], shifter: [0, 395], multiplier: [630, 395] },
  main: ['alu', 'shifter', 'multiplier'],
  strip: [['rega', 'regb', 'alu'], 'shifter', 'multiplier', 'regy'],
  initial: {
    rega: regPanel('操作数 A', 0),
    regb: regPanel('操作数 B', 0),
    alu: aluPanel('—', 0, 0, null),
    regy: resultPanel(0, '等待运算'),
    shifter: shiftTable(-1),
    multiplier: mulTable(-1),
  },
  start: ['rega', 'regb', 'alu', 'regy'],
  legend: [['blue', '操作数'], ['green', '结果'], ['amber', '移位和迭代'], ['violet', '控制'], [null, '乘法器的周期是迭代式的示例']],
  overview: {
    full: 'CPU 里做计算的那块组合逻辑',
    description: 'ALU 把两个 32 位输入按控制信号算成一个结果。逻辑运算逐位独立，加减共用一条进位链，比较是减法再看符号，移位靠 5 层选择器一拍完成。乘法不在 RV32I 里，属于 M 扩展；这里用最容易看懂的移位相加讲原理。',
    facts: [
      ['RV32I 的操作', 'add sub sll slt sltu xor srl sra or and'],
      ['选择依据', 'funct3 和 inst[30]'],
      ['组合逻辑', '当拍出结果，不存状态'],
      ['移位范围', '只看 B 的低 5 位'],
      ['乘法', 'M 扩展的 mul，取低 32 位'],
    ],
  },
  steps: [
    {
      title: '逻辑运算',
      desc: 'AND、OR、XOR 每一位各算各的',
      detail: `逻辑运算没有进位，32 位就是 32 个独立的门，所以比加法快得多。A = ${low(A)}，B = ${low(B)}：AND 得 ${low(AND)}，OR 得 ${low(OR)}，XOR 得 ${low(XOR)}。程序用 AND 清掉不要的位，用 OR 置位，用 XOR 翻转。`,
      facts: [['AND', low(AND)], ['OR', low(OR)], ['XOR', low(XOR)], ['选择', 'funct3 = 111 / 110 / 100']],
      events: [
        probe({ rega: regPanel('操作数 A', A), regb: regPanel('操作数 B', B), alu: aluPanel('AND', A, B, null) }),
        pk('rega', 'alu', 'blue', 'A', [hx(A)], [1, 'DATA', `A = ${hx(A)} 送入 ALU`, 'reg'],
          wire('寄存器堆的读口 1', 'regs', 'model', registers('rs1', [['x1', A]], 'blue')), { quick: true }),
        pk('regb', 'alu', 'blue', 'B', [hx(B)], [1, 'DATA', `B = ${hx(B)} 送入 ALU`, 'reg'],
          wire('寄存器堆的读口 2', 'regs', 'model', registers('rs2', [['x2', B]], 'blue')), { quick: true }),
        probe({ alu: aluPanel('AND', A, B, AND) }),
        pk('alu', 'regy', 'green', 'AND', [low(AND)], [1, 'EXEC', `and：${low(A)} AND ${low(B)} = ${low(AND)}`, 'reg'],
          wire('and x3, x1, x2', 'regs', 'spec', instructionLayer(andWord, { text: 'and x3, x1, x2' }), registers('结果', [['x3', AND]], 'green'))),
        probe({ regy: resultPanel(AND, `and = ${hx(AND)}`), alu: aluPanel('OR', A, B, OR) }, 500),
        pk('alu', 'regy', 'green', 'OR', [low(OR)], [2, 'EXEC', `or：${low(A)} OR ${low(B)} = ${low(OR)}`, 'reg'],
          wire('or', 'regs', 'model', opFields(A, B, 'OR', OR), registers('结果', [['x3', OR]], 'green')), { quick: true }),
        probe({ regy: resultPanel(OR, `or = ${hx(OR)}`), alu: aluPanel('XOR', A, B, XOR) }, 500),
        pk('alu', 'regy', 'green', 'XOR', [low(XOR)], [3, 'EXEC', `xor：${low(A)} XOR ${low(B)} = ${low(XOR)}`, 'reg'],
          wire('xor', 'regs', 'model', opFields(A, B, 'XOR', XOR), registers('结果', [['x3', XOR]], 'green')), { quick: true }),
        probe({ regy: resultPanel(XOR, `xor = ${hx(XOR)}`) }),
      ],
    },
    {
      title: '加与减',
      desc: 'add 和 sub 只差 inst[30]',
      detail: `加法和减法共用上一课的加法器。add 和 sub 的 funct3 都是 000，靠 funct7 区分：sub 的 inst[30] = 1，这一位让 B 取反、进位入置 1。A + B = ${ADD}，A - B = ${SUB}。打开检查器可以看到两条指令只差这一位。`,
      facts: [['add funct7', '0000000'], ['sub funct7', '0100000'], ['A + B', String(ADD)], ['A - B', String(SUB)]],
      events: [
        probe({ alu: aluPanel('ADD', A, B, ADD) }),
        pk('alu', 'regy', 'green', 'ADD', [String(ADD)], [4, 'EXEC', `add：${A} + ${B} = ${ADD}`, 'reg'],
          wire('add x3, x1, x2', 'regs', 'spec', instructionLayer(addWord, { text: 'add x3, x1, x2' }), registers('结果', [['x3', ADD]], 'green'))),
        probe({ regy: resultPanel(ADD, `add = ${ADD}`), alu: aluPanel('SUB', A, B, SUB) }, 500),
        pk('alu', 'regy', 'green', 'SUB', [String(SUB)], [5, 'EXEC', `sub：${A} - ${B} = ${SUB}，inst[30] = 1`, 'reg'],
          wire('sub x3, x1, x2', 'regs', 'spec', instructionLayer(subWord, { text: 'sub x3, x1, x2' }), registers('结果', [['x3', SUB]], 'green'))),
        probe({ regy: resultPanel(SUB, `sub = ${SUB}`) }),
      ],
    },
    {
      title: '比较',
      desc: 'slt 和 sltu 对同一组位给出不同答案',
      detail: `全 1 的位串，有符号读是 -1，无符号读是 4294967295。slt 把它当 -1，-1 < 1，结果 ${SLT}；sltu 把它当很大的正数，结果 ${SLTU}。两者都做减法，只是判断规则不同。RISC-V 没有标志寄存器，比较结果直接写进一个通用寄存器。`,
      facts: [['A', hx(MINUS1)], ['B', '1'], ['slt', String(SLT)], ['sltu', String(SLTU)]],
      events: [
        probe({ rega: regPanel('操作数 A', MINUS1), regb: regPanel('操作数 B', 1), alu: aluPanel('SLT', MINUS1, 1, SLT) }),
        pk('rega', 'alu', 'blue', 'A', [hx(MINUS1)], [6, 'DATA', `A = ${hx(MINUS1)}`, 'reg'],
          wire('读口 1', 'regs', 'model', registers('rs1', [['x1', MINUS1, '有符号是 -1，无符号是 4294967295。']], 'blue')), { quick: true }),
        pk('alu', 'regy', 'green', 'SLT', [`= ${SLT}`], [6, 'EXEC', `slt：-1 < 1，结果 ${SLT}`, 'reg'],
          wire('slt x3, x1, x2', 'regs', 'spec', instructionLayer(sltWord, { text: 'slt x3, x1, x2' }), registers('结果', [['x3', SLT]], 'green'))),
        probe({ regy: resultPanel(SLT, `slt = ${SLT}`), alu: aluPanel('SLTU', MINUS1, 1, SLTU) }, 500),
        pk('alu', 'regy', 'green', 'SLTU', [`= ${SLTU}`], [7, 'EXEC', `sltu：4294967295 < 1 不成立，结果 ${SLTU}`, 'reg'],
          wire('sltu x3, x1, x2', 'regs', 'spec', instructionLayer(sltuWord, { text: 'sltu x3, x1, x2' }), registers('结果', [['x3', SLTU]], 'green'))),
        probe({ regy: resultPanel(SLTU, `sltu = ${SLTU}`) }),
      ],
    },
    {
      title: '桶形移位',
      desc: '5 层选择器，一拍移任意位',
      detail: `一位一位移要 31 拍，桶形移位器一拍搞定：5 层多路选择器，shamt 的第 k 位决定这一层是否移 2^k 位。shamt = ${SHAMT} = ${bitString(SHAMT, 5)}，所以移 1、移 4、移 8 这三层打开，1 + 4 + 8 = ${SHAMT}。算术右移用符号位填高位，结果 ${hx(shift.result)}；逻辑右移填 0，结果是 ${hx(shiftLogical.result)}。`,
      facts: [['输入', hx(SHIFT_IN)], ['shamt', `${SHAMT} = ${bitString(SHAMT, 5)}`], ['sra', hx(shift.result)], ['srl', hx(shiftLogical.result)], ['层数', '5 = log2(32)']],
      events: [
        show('shifter'),
        probe({ rega: regPanel('操作数 A', SHIFT_IN), regb: regPanel('操作数 B', SHAMT), shifter: shiftTable(-1) }),
        pk('rega', 'shifter', 'blue', '被移位', [hx(SHIFT_IN)], [8, 'DATA', `被移位的值 ${hx(SHIFT_IN)}`, 'reg'],
          wire('读口 1', 'regs', 'model', registers('rs1', [['x1', SHIFT_IN]], 'blue')), { quick: true }),
        pk('regb', 'shifter', 'blue', 'shamt', [`${SHAMT}`], [8, 'DATA', `移位量取 B 的低 5 位 = ${SHAMT}`, 'reg'],
          wire('读口 2', 'regs', 'model', registers('rs2', [['x2', SHAMT, 'sra 只用低 5 位。']], 'blue')), { quick: true }),
        ...shift.stages.map((_, index) => probe({ shifter: shiftTable(index) }, 320)),
        pk('shifter', 'alu', 'amber', 'sra', [hx(shift.result)], [8, 'EXEC', `sra：${hx(SHIFT_IN)} >> ${SHAMT} = ${hx(shift.result)}`, 'reg'],
          wire('sra x3, x1, x2', 'regs', 'spec', instructionLayer(sraWord, { text: 'sra x3, x1, x2' }), concept('各层输出', shift.stages.map((stage): [string, string, string?] => [`移 ${stage.amount}`, hex32(stage.value), stage.enabled ? '这一层打开。' : '这一层直通。']), 'amber'))),
        pk('alu', 'regy', 'green', '结果', [hx(shift.result)], [8, 'WB', '选择器选中移位器的输出', 'reg'],
          wire('结果', 'regs', 'model', registers('结果', [['x3', shift.result]], 'green')), { quick: true }),
        probe({ regy: resultPanel(shift.result, `sra = ${hx(shift.result)}`), alu: aluPanel('SRA', SHIFT_IN, SHAMT, shift.result) }),
      ],
    },
    {
      title: '乘法',
      desc: '看乘数最低位，决定加不加',
      detail: `乘法就是列竖式：看乘数的每一位，是 1 就把被乘数加到积上，然后被乘数左移，乘数右移。${M1} × ${M2} 用了 ${mul.iterations.length} 拍，乘数变 0 就结束。mul 属于 M 扩展，取积的低 32 位。真实的高性能乘法器用 Booth 编码和华莱士树同时加多个部分积，几拍就出结果，这里的周期只是这个迭代模型算出来的。`,
      facts: [['被乘数', String(M1)], ['乘数', `${M2} = ${bitString(M2, 4)}`], ['迭代次数', String(mul.iterations.length)], ['积', String(mul.product)], ['指令', 'mul（M 扩展）']],
      events: [
        show('multiplier'),
        probe({ rega: regPanel('操作数 A', M1), regb: regPanel('操作数 B', M2) }),
        pk('rega', 'multiplier', 'blue', '被乘数', [String(M1)], [CYCLE_MUL, 'DATA', `被乘数 ${M1}`, 'reg'],
          wire('mul x3, x1, x2', 'regs', 'spec', instructionLayer(mulWord, { text: 'mul x3, x1, x2' }), registers('操作数', [['x1', M1], ['x2', M2]], 'blue')), { quick: true }),
        pk('regb', 'multiplier', 'blue', '乘数', [String(M2)], [CYCLE_MUL, 'DATA', `乘数 ${M2}`, 'reg'],
          wire('读口 2', 'regs', 'model', registers('rs2', [['x2', M2]], 'blue')), { quick: true }),
        ...mul.iterations.map((_, index) => probe({ multiplier: mulTable(index) }, 480)),
        pk('multiplier', 'alu', 'amber', '积', [String(mul.product)], [CYCLE_MUL + mul.iterations.length - 1, 'EXEC', `${mul.iterations.length} 拍后得到积 ${mul.product}`, 'reg'],
          wire('乘法器输出', 'regs', 'model', concept('迭代过程', mul.iterations.map((item): [string, string, string?] => [`第 ${item.index + 1} 拍`, `积 = ${item.product}`, item.bit ? `最低位 1，加上 ${item.multiplicand}。` : '最低位 0，不加。']), 'amber'))),
        pk('alu', 'regy', 'green', '结果', [String(mul.product)], [CYCLE_MUL + mul.iterations.length, 'WB', `积 ${mul.product} 写回 x3`, 'reg'],
          wire('结果', 'regs', 'model', registers('结果', [['x3', mul.product]], 'green')), { quick: true }),
        probe({ regy: resultPanel(mul.product, `mul = ${mul.product}`), alu: aluPanel('MUL', M1, M2, mul.product) }),
      ],
    },
  ],
  outro: {
    title: '一块组合逻辑',
    desc: '控制信号决定它这一拍做什么',
    text: 'ALU 把各种运算都做好，再用一个选择器挑出需要的结果。下一组课程会讲指令怎样变成这些控制信号。',
    facts: [['选择依据', 'funct3、inst[30]'], ['移位', '一拍完成'], ['下一课', 'ENCODING']],
  },
};
