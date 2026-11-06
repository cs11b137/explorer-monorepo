import { concept, instructionLayer, wire } from '../decode/structures';
import { aluControl, controlOf, SingleCycleCpu, type Control, type SingleCycleTrace } from '../sim/exec';
import { assemble, bitString, decode, hex32 } from '../sim/riscv';
import { pk, probe, show } from './dsl';
import type { CellLike } from '../scene/widgets';
import type { Lesson, LessonEvent, Step } from './types';
import { bitsPanel, cell, dim, grid, kv, on } from './views';

const SOURCE = ['addi x1, x0, 12', 'add x2, x1, x1', 'sw x2, 256(x0)', 'lw x3, 256(x0)', 'beq x2, x3, 8', 'addi x4, x0, 1', 'jal x5, 8', 'addi x6, x0, 1', 'addi x7, x0, 2'];
const PROGRAM = assemble(SOURCE);
const cpu = new SingleCycleCpu(PROGRAM);
const traces: SingleCycleTrace[] = [];
while (cpu.running) traces.push(cpu.step());
const of = (name: string) => traces.find((t) => t.d.name === name)!;

interface ClassRow {
  key: string;
  name: string;
  sample: string;
}

/** 真值表每一行都由 controlOf 算出来。 */
const CLASSES: ClassRow[] = [
  { key: 'R', name: 'R 型', sample: 'add x1, x2, x3' },
  { key: 'I', name: 'I 运算', sample: 'addi x1, x2, 1' },
  { key: 'L', name: 'load', sample: 'lw x1, 0(x2)' },
  { key: 'S', name: 'store', sample: 'sw x1, 0(x2)' },
  { key: 'B', name: '分支', sample: 'beq x1, x2, 8' },
  { key: 'J', name: 'jal', sample: 'jal x1, 8' },
];

const flag = (value: boolean, active: boolean): CellLike => (value ? (active ? on('1', 'green') : cell('1', 'green')) : active ? '0' : dim('0'));
const wbText = (c: Control) => ({ alu: 'ALU', mem: '内存', 'pc+4': 'PC+4', csr: 'CSR', none: '—' })[c.wbSrc];

function truthTable(active: string | null) {
  return grid('主控制器真值表（只看 opcode）', [['指令', 56], ['opcode', 62], ['RegWrite', 60], ['ALUSrc', 50], ['MemRead', 56], ['MemWrite', 60], ['Branch', 50], ['Jump', 40], ['写回来自', 58], ['ALUOp', 44]],
    CLASSES.map(({ key, name, sample }) => {
      const d = decode(assemble([sample])[0]);
      const c = controlOf(d);
      const hot = key === active;
      return [
        hot ? on(name, 'blue') : name,
        hot ? cell(bitString(d.opcode, 7), 'blue') : dim(bitString(d.opcode, 7)),
        flag(c.regWrite, hot), flag(c.aluSrc, hot), flag(c.memRead, hot), flag(c.memWrite, hot), flag(c.branch, hot), flag(c.jump, hot),
        hot ? cell(wbText(c), 'green') : dim(wbText(c)),
        hot ? cell(bitString(c.aluOp, 2), 'amber') : dim(bitString(c.aluOp, 2)),
      ];
    }));
}

const opcodeBits = (t: SingleCycleTrace) => bitsPanel(`opcode 决定控制信号 · ${SOURCE[t.pc / 4]}`, t.word, 32, [
  { name: 'funct7 / 立即数', hi: 31, lo: 25, tone: 'dim' },
  { name: '其余字段', hi: 24, lo: 15, tone: 'dim' },
  { name: 'funct3', hi: 14, lo: 12, tone: 'violet' },
  { name: 'rd / 立即数', hi: 11, lo: 7, tone: 'dim' },
  { name: 'opcode', hi: 6, lo: 0, tone: 'blue' },
], hex32(t.word), 13);

const signalLayer = (c: Control) => concept('这条指令的控制信号', [
  ['RegWrite', c.regWrite ? '1' : '0', '时钟沿到来时写 rd。'],
  ['ALUSrc', c.aluSrc ? '1' : '0', '1 时 ALU 的 B 口选立即数，0 时选 rs2。'],
  ['MemRead / MemWrite', `${c.memRead ? 1 : 0} / ${c.memWrite ? 1 : 0}`],
  ['Branch / Jump', `${c.branch ? 1 : 0} / ${c.jump ? 1 : 0}`],
  ['写回来自', wbText(c)],
  ['ALUOp', bitString(c.aluOp, 2), '00 加（算地址），01 减（分支比较），10 看 funct3 和 funct7，这三种是教材约定；11 是本站为 I 型运算加的。它们都不属于 ISA。'],
], 'violet');

const statusPanels = (t: SingleCycleTrace) => ({
  regfile: kv('寄存器堆', [['RegWrite', t.control.regWrite ? on('1', 'green') : '0'], ['写', t.control.regWrite && t.d.rd !== 0 ? `x${t.d.rd} = ${t.writeValue}` : dim('不写')]]),
  alu: kv('ALU', [['ALU 控制', on(t.op, 'amber')], ['ALUSrc', t.control.aluSrc ? on('1', 'teal') : '0'], ['结果', hex32(t.aluResult)]]),
  dmem: kv('数据存储器', [['MemRead', t.control.memRead ? on('1', 'green') : '0'], ['MemWrite', t.control.memWrite ? on('1', 'violet') : '0']]),
  pc: kv('PC', [['选择', t.taken || t.control.jump ? on('跳转目标', 'violet') : 'PC + 4'], ['下一条', hex32(t.nextPc)]]),
  instr: opcodeBits(t),
});

const BLANK = {
  regfile: kv('寄存器堆', [['RegWrite', dim('—')], ['写', dim('—')]]),
  alu: kv('ALU', [['ALU 控制', dim('—')], ['ALUSrc', dim('—')], ['结果', dim('—')]]),
  dmem: kv('数据存储器', [['MemRead', dim('—')], ['MemWrite', dim('—')]]),
  pc: kv('PC', [['选择', dim('—')], ['下一条', dim('—')]]),
};

function eventsOf(t: SingleCycleTrace, classKey: string): LessonEvent[] {
  const c = t.control;
  const cycle = t.cycle;
  const source = SOURCE[t.pc / 4];
  const events: LessonEvent[] = [
    probe({ table: truthTable(classKey), instr: opcodeBits(t), ...BLANK }),
    pk('imem', 'control', 'blue', 'opcode', [bitString(t.d.opcode, 7)], [cycle, 'DECODE', `${source} 的 opcode ${bitString(t.d.opcode, 7)} 送入控制单元`, '7b'],
      wire('指令字低 7 位接到主控制器', 'mem', 'spec', instructionLayer(t.word, { pc: t.pc, text: source }), signalLayer(c))),
  ];
  const go = (to: 'regfile' | 'alu' | 'dmem' | 'pc', color: 'green' | 'amber' | 'violet', label: string, info: string, payload: string[]) => {
    events.push(pk('control', to, color, label, payload, [cycle, 'CTRL', info, 'sig'], wire(`控制线：${label}`, 'regs', 'model', signalLayer(c)), { quick: true }));
    events.push(probe({ [to]: statusPanels(t)[to] }));
  };
  go('alu', 'amber', 'ALU 控制', `ALUSrc=${c.aluSrc ? 1 : 0}，ALUOp=${bitString(c.aluOp, 2)}，ALU 做 ${aluControl(t.d)}`, [`ALUSrc=${c.aluSrc ? 1 : 0}`, `${aluControl(t.d)}`]);
  if (c.regWrite) go('regfile', 'green', 'RegWrite', `RegWrite=1，写回 x${t.d.rd}，来源 ${wbText(c)}`, ['RegWrite=1', `来自 ${wbText(c)}`]);
  if (c.memRead || c.memWrite) go('dmem', 'violet', c.memRead ? 'MemRead' : 'MemWrite', `${c.memRead ? 'MemRead' : 'MemWrite'}=1`, [`${c.memRead ? 'MemRead' : 'MemWrite'}=1`]);
  if (c.branch || c.jump) go('pc', 'violet', c.branch ? 'Branch' : 'Jump', `${c.branch ? 'Branch' : 'Jump'}=1，${t.taken || c.jump ? `PC 改成 ${hex32(t.nextPc)}` : 'PC 顺序加 4'}`, [c.branch ? 'Branch=1' : 'Jump=1']);
  events.push(probe(statusPanels(t)));
  return events;
}

const fact = (t: SingleCycleTrace): [string, string][] => [['指令', SOURCE[t.pc / 4]], ['opcode', bitString(t.d.opcode, 7)], ['ALU 控制', t.op], ['周期', String(t.cycle)]];

const steps: Step[] = [
  {
    title: 'I 型运算',
    desc: 'ALUSrc 打开，ALU 用立即数',
    detail: '控制单元是一张查表：输入 opcode，输出一组 0 和 1。addi 要写寄存器，第二操作数是立即数，所以 RegWrite 和 ALUSrc 为 1，存储器的两根线都是 0。具体做加法还是异或，再看 funct3。',
    facts: fact(of('addi')),
    events: [show('alu'), ...eventsOf(of('addi'), 'I')],
  },
  {
    title: 'R 型运算',
    desc: 'ALUOp = 10，让 funct 决定操作',
    detail: '主控制器不认识 add 和 sub，只知道这是 R 型，于是给 ALU 控制器 ALUOp = 10。ALU 控制器再看 funct3 和 inst[30] 决定做什么。这样分两级，主控制器只用处理 opcode，表可以小很多。',
    facts: fact(of('add')),
    events: eventsOf(of('add'), 'R'),
  },
  {
    title: 'store',
    desc: 'MemWrite = 1，RegWrite = 0',
    detail: 'store 只写内存，不写寄存器。ALU 做加法算地址，所以 ALUOp 是 00，ALU 控制器这时不看 funct3。这条指令的 funct3 决定写 1、2 还是 4 字节，由存储器接口使用。',
    facts: fact(of('sw')),
    events: [show('dmem'), ...eventsOf(of('sw'), 'S')],
  },
  {
    title: 'load',
    desc: '写回的数据来自存储器',
    detail: 'load 也用 ALU 算地址，所以和 store 一样 ALUSrc = 1、ALUOp = 00。不同的是 MemRead = 1，RegWrite = 1，寄存器的写数据选择器选存储器。这个选择器在教材里常叫 MemtoReg。',
    facts: fact(of('lw')),
    events: eventsOf(of('lw'), 'L'),
  },
  {
    title: '分支',
    desc: 'Branch = 1，ALU 做减法',
    detail: `beq 不写寄存器也不访问存储器。Branch 线和 ALU 的「结果为 0」信号相与，决定 PC 下一拍取哪个值。这次两个寄存器相等，PC 跳到 ${hex32(of('beq').nextPc)}。bne、blt 等其他条件要由 funct3 决定怎么判断。`,
    facts: fact(of('beq')),
    events: [show('pc'), ...eventsOf(of('beq'), 'B')],
  },
  {
    title: 'jal',
    desc: '无条件跳转，同时保存返回地址',
    detail: `jal 把 PC + 4 写进 rd，再跳到 PC + 立即数，这就是函数调用的基础。这里 x5 得到 ${traces.find((t) => t.d.name === 'jal')!.writeValue}。写回数据的选择器要多一路 PC + 4，教材的基本表常常略掉这一行，真实的 RV32I 实现都需要它。`,
    facts: fact(of('jal')),
    events: eventsOf(of('jal'), 'J'),
  },
];

const first = of('addi');

export const control: Lesson = {
  id: 'control',
  name: 'CONTROL',
  title: '控制单元',
  group: 'cpu',
  layer: [4, 5],
  clock: 'cycle',
  nodes: ['imem', 'control', 'regfile', 'alu', 'dmem', 'pc'],
  place: { imem: [100, 175], control: [430, 165], pc: [780, 175], regfile: [110, 350], alu: [430, 350], dmem: [760, 350] },
  labels: {
    imem: ['指令存储器', ''],
    control: ['控制单元', '查表：opcode → 信号'],
    pc: ['PC 选择器', ''],
    regfile: ['寄存器堆', ''],
    alu: ['ALU', ''],
    dmem: ['数据存储器', ''],
  },
  panels: { instr: [190, 0], pc: [660, 30], regfile: [5, 432], alu: [340, 432], dmem: [680, 432], table: [75, 528] },
  main: ['table'],
  strip: ['table', ['regfile', 'alu', 'dmem', 'pc'], 'instr'],
  initial: {
    instr: opcodeBits(first),
    ...BLANK,
    table: truthTable(null),
  },
  start: ['imem', 'control', 'regfile'],
  legend: [['blue', 'opcode'], ['amber', 'ALU 控制'], ['green', '写寄存器'], ['violet', '存储器和跳转'], [null, '信号名沿用教材，ISA 不规定']],
  overview: {
    full: '把 opcode 翻译成一组开关',
    description: '数据通路里每个选择器和写使能都要有人控制。单周期 CPU 的控制单元是一块组合逻辑：输入 opcode，输出 RegWrite、ALUSrc、MemRead 这些信号。这一课跑一段真实程序，真值表每一行都由代码算出来，看每类指令打开哪些开关。',
    facts: [
      ['输入', 'opcode（7 位）'],
      ['ALU 控制', '再看 funct3 和 inst[30]'],
      ['类型', '组合逻辑，没有状态'],
      ['信号名', 'Patterson & Hennessy 教材'],
      ['规范', 'ISA 只定义行为，不定义这些信号'],
    ],
  },
  steps,
  outro: {
    title: '指令就是开关的组合',
    desc: '加一条指令，通常只是加一行真值表',
    text: 'RISC-V 的字段位置固定，所以控制逻辑很小。流水线里这些信号不会马上用完，要跟着指令一级一级往后传，到了用它们的那一级才生效。',
    facts: [['主控制器', '只看 opcode'], ['ALU 控制器', '再看 funct'], ['下一课', 'PIPELINE']],
  },
};

