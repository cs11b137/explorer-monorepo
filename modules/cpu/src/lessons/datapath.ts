import { concept, instructionLayer, registers, wire } from '../decode/structures';
import { Memory, SingleCycleCpu, type SingleCycleTrace } from '../sim/exec';
import { assemble, hex32 } from '../sim/riscv';
import { pk, probe, show } from './dsl';
import type { Lesson, LessonEvent, Step } from './types';
import { cell, dim, grid, hx, kv, on, regsPanel } from './views';

const SOURCE = ['addi x1, x0, 5', 'add x2, x1, x1', 'sw x2, 256(x0)', 'lw x3, 256(x0)', 'beq x2, x3, 8', 'addi x4, x0, 99', 'lui x5, 0x12345'];
const PROGRAM = assemble(SOURCE);
const REGS = [1, 2, 3, 4, 5];
const MEM_ADDR = 256;

const cpu = new SingleCycleCpu(PROGRAM);
const snapshots: Array<{ trace: SingleCycleTrace; regs: number[]; mem: Memory }> = [];
for (let index = 0; index < 5; index++) {
  const trace = cpu.step();
  snapshots.push({ trace, regs: [...cpu.regs], mem: cpu.mem.clone() });
}

const pcPanel = (pc: number, next?: number) => kv('程序计数器', [['PC', cell(hx(pc), 'blue')], ['下一条', next === undefined ? dim('—') : hx(next)]]);
const imemPanel = (t?: SingleCycleTrace) => kv('指令存储器', t ? [['指令', cell(SOURCE[t.pc / 4], 'blue')], ['指令字', hex32(t.word)]] : [['指令', dim('—')], ['指令字', dim('—')]]);
const immPanel = (t?: SingleCycleTrace) => kv('立即数生成', t && t.d.format !== 'R' ? [['格式', `${t.d.format} 型`], ['立即数', String(t.d.imm)]] : [['格式', dim('—')], ['立即数', dim('不用')]]);
const aluPanel = (t?: SingleCycleTrace) => kv('ALU', t ? [['操作', on(t.op, 'amber')], ['A', hx(t.aluA)], ['B', hx(t.aluB)], ['Y', cell(hx(t.aluResult), 'green')], ['Y=0', t.zero ? on('1', 'green') : '0']] : [['操作', dim('—')], ['A', dim('—')], ['B', dim('—')], ['Y', dim('—')], ['Y=0', dim('—')]]);
const memPanel = (mem: Memory, hot = false) => grid('数据存储器', [['地址', 88], ['值', 88]], [[hx(MEM_ADDR), hot ? cell(hx(mem.loadWord(MEM_ADDR)), 'green') : hx(mem.loadWord(MEM_ADDR))], [hx(MEM_ADDR + 4), dim(hx(mem.loadWord(MEM_ADDR + 4)))]]);

const empty = new Memory();

function eventsOf(index: number): LessonEvent[] {
  const { trace: t, regs, mem } = snapshots[index];
  const before = index ? snapshots[index - 1] : null;
  const cycle = t.cycle;
  const instr = (color: 'blue' | 'teal' | 'amber' = 'blue') => instructionLayer(t.word, { pc: t.pc, text: SOURCE[t.pc / 4], color });
  const regsBefore = before ? before.regs : new Array(32).fill(0);
  const events: LessonEvent[] = [
    probe({ pc: pcPanel(t.pc), imem: imemPanel(t), immgen: immPanel(), alu: aluPanel(), regfile: regsPanel('寄存器堆', regsBefore, REGS) }),
    pk('pc', 'imem', 'blue', '取指', [hx(t.pc)], [cycle, 'FETCH', `用 PC = ${hx(t.pc)} 读指令存储器`, 'reg'],
      wire('PC 的值送到指令存储器的地址端', 'regs', 'model', registers('程序计数器', [['PC', t.pc]], 'blue')), { quick: true }),
    pk('imem', 'regfile', 'blue', '指令', [SOURCE[t.pc / 4]], [cycle, 'DECODE', `解码 ${SOURCE[t.pc / 4]}，读源寄存器`, 4],
      wire('指令字的 rs1、rs2 字段接到寄存器堆的读地址', 'mem', 'spec', instr()), { quick: true }),
  ];
  if (t.d.format !== 'R' && t.d.format !== 'B') {
    events.push(
      pk('imem', 'immgen', 'teal', '立即数位', [`${t.d.format} 型`], [cycle, 'DECODE', `立即数 ${t.d.imm} 送入立即数生成器`, '32b'],
        wire('立即数字段', 'mem', 'spec', instr('teal')), { quick: true }),
      probe({ immgen: immPanel(t) }),
      pk('immgen', 'alu', 'teal', 'B 口', [String(t.d.imm)], [cycle, 'DATA', `ALUSrc = 1：B 口选立即数 ${t.d.imm}`, 'reg'],
        wire('符号扩展后的立即数', 'regs', 'model', registers('立即数', [['imm', t.d.imm >>> 0, '32 位，已符号扩展。']], 'teal')), { quick: true }),
    );
  }
  if (t.d.format === 'B') events.push(probe({ immgen: immPanel(t) }));
  events.push(
    pk('regfile', 'alu', 'amber', '操作数', [`A=${hx(t.aluA)}`, ...(t.control.aluSrc ? [] : [`B=${hx(t.aluB)}`])], [cycle, 'EXEC', `${t.op}：A = ${hx(t.aluA)}，B = ${hx(t.aluB)}`, 'reg'],
      wire('寄存器堆的两个读口', 'regs', 'model', registers('读到的值', [[`x${t.d.rs1}`, t.rs1Value], ...(t.d.usesRs2 ? [[`x${t.d.rs2}`, t.rs2Value] as [string, number]] : [])], 'amber'))),
    probe({ alu: aluPanel(t) }),
  );
  if (t.control.memRead || t.control.memWrite) {
    events.push(
      show('dmem'),
      pk('alu', 'dmem', 'amber', t.control.memWrite ? '写地址' : '读地址', [hx(t.aluResult)], [cycle, 'MEM', `ALU 算出地址 ${hx(t.aluResult)}`, 'reg'],
        wire('ALU 输出接到数据存储器的地址端', 'regs', 'model', registers('地址', [['Y', t.aluResult, `x${t.d.rs1} + ${t.d.imm}`]], 'amber')), { quick: true }),
    );
  }
  if (t.control.memWrite) {
    events.push(
      pk('regfile', 'dmem', 'violet', '写数据', [hx(t.rs2Value)], [cycle, 'MEM', `把 x${t.d.rs2} = ${hx(t.rs2Value)} 写到 ${hx(t.aluResult)}`, 4],
        wire('写进数据存储器的 4 个字节', 'mem', 'model', registers('写入', [[hx(t.aluResult), t.rs2Value, '低字节放在低地址。']], 'violet'))),
      probe({ dmem: memPanel(mem, true) }),
    );
  }
  if (t.control.memRead) {
    events.push(
      pk('dmem', 'regfile', 'green', '读出', [hx(t.memValue!)], [cycle, 'WB', `读到 ${hx(t.memValue!)}，写回 x${t.d.rd}`, 4],
        wire('数据存储器读出后写回', 'mem', 'model', registers('读出', [[hx(t.aluResult), t.memValue!]], 'green'))),
      probe({ regfile: regsPanel('寄存器堆', regs, REGS, [t.d.rd]), dmem: memPanel(mem, true) }),
    );
  } else if (t.control.regWrite) {
    events.push(
      pk('alu', 'regfile', 'green', '写回', [`x${t.d.rd}=${hx(t.writeValue!)}`], [cycle, 'WB', `ALU 结果写回 x${t.d.rd} = ${hx(t.writeValue!)}`, 'reg'],
        wire('写回寄存器堆', 'regs', 'model', registers('写回', [[`x${t.d.rd}`, t.writeValue!]], 'green'))),
      probe({ regfile: regsPanel('寄存器堆', regs, REGS, [t.d.rd]) }),
    );
  }
  events.push(
    pk('alu', 'pc', t.taken ? 'violet' : 'slate', t.taken ? '跳转' : 'PC+4', [hx(t.nextPc)], [cycle, 'CTRL', t.taken ? `Y = 0，分支成立，PC 改成 ${hx(t.nextPc)}` : `时钟沿到来，PC 更新为 ${hx(t.nextPc)}`, 'reg'],
      wire('拍末更新 PC', 'regs', 'model', registers('下一条', [['PC', t.nextPc]], t.taken ? 'violet' : 'slate'), concept('来源', [['选择', t.taken ? 'PC + 立即数' : 'PC + 4', t.taken ? 'beq 的 ALU 做减法，结果为 0 时走这条路。' : '顺序执行时走这条路。']], 'slate')), { quick: !t.taken }),
    probe({ pc: pcPanel(t.pc, t.nextPc) }),
  );
  return events;
}

const steps: Step[] = [
  {
    title: 'addi',
    desc: '第 1 拍：寄存器加立即数',
    detail: `单周期 CPU 在一个时钟周期里走完全部路径。PC 先读出指令，解码后读 x0，立即数生成器给出 5，ALU 相加，时钟沿到来时结果写进 x1，PC 同时变成下一条。这些部件全是组合逻辑，真正记住状态的只有 PC、寄存器堆和存储器。`,
    facts: [['指令', SOURCE[0]], ['周期', '1'], ['写回', `x1 = ${snapshots[0].regs[1]}`]],
    events: [...eventsOf(0).slice(0, 1), ...eventsOf(0).slice(1)],
  },
  {
    title: 'add',
    desc: '第 2 拍：两个寄存器相加',
    detail: `R 型指令不走立即数生成器，ALU 的 B 口选寄存器。上一拍写进 x1 的 5 现在能读到了，因为单周期 CPU 每拍只有一条指令，不存在「还没写完」的问题。下一组课程的流水线会失去这个便利。`,
    facts: [['指令', SOURCE[1]], ['周期', '2'], ['写回', `x2 = ${snapshots[1].regs[2]}`]],
    events: eventsOf(1),
  },
  {
    title: 'sw',
    desc: '第 3 拍：ALU 算地址，写内存',
    detail: `store 的 ALU 用来算地址：x0 + 256。寄存器堆的第二个读口把 x2 送到存储器的写数据端。这条指令没有目标寄存器，所以这一拍寄存器堆不变。`,
    facts: [['指令', SOURCE[2]], ['地址', hx(MEM_ADDR)], ['写入', hx(snapshots[2].mem.loadWord(MEM_ADDR))]],
    events: eventsOf(2),
  },
  {
    title: 'lw',
    desc: '第 4 拍：路径最长的指令',
    detail: `load 要走完所有部件：取指、读寄存器、算地址、读存储器、写回。单周期 CPU 的时钟周期必须容得下这条最长路径，其他指令再短也要等这么久。这正是后面要改成流水线的原因。`,
    facts: [['指令', SOURCE[3]], ['读到', hx(snapshots[3].regs[3])], ['路径', '5 个阶段全用到']],
    events: eventsOf(3),
  },
  {
    title: 'beq',
    desc: '第 5 拍：比较后改 PC',
    detail: `分支指令让 ALU 做减法，结果为 0 表示相等。x2 和 x3 都是 ${snapshots[4].trace.rs1Value}，所以分支成立，PC 改成 PC + 8，跳过下一条 addi。分支不写寄存器也不访问内存。`,
    facts: [['指令', SOURCE[4]], ['A - B', hx(snapshots[4].trace.aluResult)], ['下一条', hx(snapshots[4].trace.nextPc)]],
    events: eventsOf(4),
  },
];

export const datapath: Lesson = {
  id: 'datapath',
  name: 'DATAPATH',
  title: '单周期数据通路',
  group: 'cpu',
  layer: [4, 5],
  clock: 'cycle',
  nodes: ['pc', 'imem', 'immgen', 'regfile', 'alu', 'dmem'],
  place: { pc: [90, 150], imem: [340, 150], immgen: [610, 150], regfile: [190, 410], alu: [530, 420], dmem: [800, 280] },
  labels: {
    pc: ['PC', '程序计数器'],
    imem: ['指令存储器', ''],
    immgen: ['立即数生成', ''],
    regfile: ['寄存器堆', '两读一写'],
    alu: ['ALU', ''],
    dmem: ['数据存储器', ''],
  },
  panels: { pc: [10, 30], imem: [250, 20], immgen: [550, 30], regfile: [90, 505], alu: [440, 500], dmem: [710, 370] },
  main: ['regfile', 'alu'],
  strip: [['pc', 'imem', 'immgen'], ['regfile', 'alu', 'dmem']],
  initial: {
    pc: pcPanel(0),
    imem: imemPanel(),
    immgen: immPanel(),
    regfile: regsPanel('寄存器堆', new Array(32).fill(0), REGS),
    alu: aluPanel(),
    dmem: memPanel(empty),
  },
  start: ['pc', 'imem', 'regfile', 'alu', 'immgen'],
  legend: [['blue', '取指与解码'], ['teal', '立即数'], ['amber', '计算'], ['violet', '写内存或跳转'], ['green', '写回']],
  overview: {
    full: '一拍之内，一条指令走完所有部件',
    description: '数据通路是指令经过的那些部件和连线。单周期实现最容易理解：每个时钟周期执行一条完整的指令。这一课用真实的 RV32I 解释器跑 5 条指令，你能看到 PC、指令、寄存器、ALU 的操作数和结果、存储器内容在每一拍怎样变化。',
    facts: [
      ['程序', `${SOURCE.length} 条 RV32I 指令`],
      ['每拍', '恰好一条指令'],
      ['CPI', '1'],
      ['时钟周期', '由最慢的 lw 决定'],
      ['核对', '最终状态和 Unicorn 模拟器一致'],
    ],
  },
  steps,
  outro: {
    title: 'CPI 是 1，但周期很长',
    desc: '最慢的指令拖累了所有指令',
    text: '单周期 CPU 简单，但时钟周期要迁就 lw 这条最长路径。下一步先看控制单元怎样给这些部件发信号，再把这条长路径切成 5 段，变成流水线。',
    facts: [['周期数', String(cpu.cycle)], ['最终 x3', hx(cpu.regs[3])], ['下一课', 'CONTROL']],
  },
};
