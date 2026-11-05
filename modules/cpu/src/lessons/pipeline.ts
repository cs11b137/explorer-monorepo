import { concept, instructionLayer, wire } from '../decode/structures';
import { runPipeline, type CycleSnapshot, type StageName } from '../sim/pipeline';
import { assemble } from '../sim/riscv';
import { pk, probe, show } from './dsl';
import type { Lesson, LessonEvent, PacketEvent, StreamEvent } from './types';
import { gantt, hx, STAGE_NODES, stagePanels } from './views';

const SOURCE = ['addi x1, x0, 1', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4', 'addi x5, x0, 5'];
const PROGRAM = assemble(SOURCE);
const result = runPipeline(PROGRAM);
const total = result.cycles.length;
const snap = (cycle: number) => result.cycles[cycle - 1];

// 教材常用的各阶段延迟（ps），只用来算示例。
const STAGE_PS = { IF: 200, ID: 100, EX: 200, MEM: 200, WB: 100 };
const SINGLE_PS = Object.values(STAGE_PS).reduce((sum, value) => sum + value, 0);
const PIPE_PS = Math.max(...Object.values(STAGE_PS));
const singleTotal = SINGLE_PS * SOURCE.length;
const pipeTotal = PIPE_PS * total;

const ORDER: StageName[] = ['IF', 'ID', 'EX', 'MEM', 'WB'];
const TYPE = { ID: 'DECODE', EX: 'EXEC', MEM: 'MEM', WB: 'WB' } as const;
const COLOR = { ID: 'blue', EX: 'amber', MEM: 'green', WB: 'violet' } as const;

const LATCH_NOTE: Record<StageName, string> = {
  IF: '',
  ID: 'IF/ID 流水寄存器保存指令字和 PC。',
  EX: 'ID/EX 保存读到的寄存器值、立即数和控制信号。',
  MEM: 'EX/MEM 保存 ALU 结果和要写内存的数据。',
  WB: 'MEM/WB 保存要写回的值。',
};

/** 这一拍开始时，每条指令向下一级移动，都是同一个时钟沿触发的。 */
function moves(s: CycleSnapshot): PacketEvent[] {
  const list: PacketEvent[] = [];
  for (let index = ORDER.length - 1; index >= 1; index--) {
    const stage = ORDER[index];
    const view = s.stages[stage];
    if (!view) continue;
    const key = stage as 'ID' | 'EX' | 'MEM' | 'WB';
    const extra = stage === 'EX' && s.ex ? `，${hx(s.ex.a)} + ${hx(s.ex.b)} = ${hx(s.ex.result)}` : stage === 'WB' && s.wb ? `，写回 x${s.wb.rd} = ${s.wb.value}` : stage === 'MEM' ? '，这条指令不访问内存' : '';
    list.push(pk(STAGE_NODES[ORDER[index - 1]], STAGE_NODES[stage], COLOR[key], stage, [view.text], [s.cycle, TYPE[key], `${view.text} 进入 ${stage} 级${extra}`, 'reg'],
      wire(`第 ${s.cycle} 拍的时钟沿：指令进入 ${stage} 级`, 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text }), concept(`${ORDER[index - 1]}/${stage} 流水寄存器`, [['保存', LATCH_NOTE[stage]], ...(stage === 'EX' && s.ex ? [['ALU', `${hx(s.ex.a)} + ${hx(s.ex.b)} = ${hx(s.ex.result)}`] as [string, string]] : []), ...(stage === 'WB' && s.wb ? [['写回', `x${s.wb.rd} = ${s.wb.value}`] as [string, string]] : [])], COLOR[key])), { quick: true }));
  }
  return list;
}

/** 一拍的动画：面板先进入这一拍，指令同时移动，最后显示 EX 的结果。 */
function cycleEvents(cycle: number): LessonEvent[] {
  const s = snap(cycle);
  const packets = moves(s);
  const out: LessonEvent[] = [probe({ ...stagePanels(s, true), table: gantt(result, cycle) }, 250)];
  if (packets.length) {
    const stream: StreamEvent = { type: 'stream', packets, spacing: 60 };
    out.push(stream);
  }
  out.push(probe(stagePanels(s), 650));
  return out;
}

export const pipelineLesson: Lesson = {
  id: 'pipeline',
  name: 'PIPELINE',
  title: '五级流水线',
  group: 'cpu',
  layer: [4, 4],
  clock: 'cycle',
  nodes: ['sif', 'sid', 'sex', 'smem', 'swb'],
  place: { sif: [80, 170], sid: [265, 170], sex: [450, 170], smem: [635, 170], swb: [820, 170] },
  labels: {
    sif: ['取指', ''],
    sid: ['译码', '读寄存器'],
    sex: ['执行', 'ALU'],
    smem: ['访存', ''],
    swb: ['写回', ''],
  },
  panels: { sif: [0, 30], sid: [185, 30], sex: [370, 30], smem: [555, 30], swb: [740, 30], table: [175, 285] },
  main: ['table'],
  strip: [['sif', 'sid', 'sex', 'smem', 'swb'], 'table'],
  initial: {
    ...stagePanels(null),
    table: gantt(result, 0),
  },
  start: ['sif', 'sid'],
  legend: [['blue', '进入译码'], ['amber', '进入执行'], ['green', '进入访存'], ['violet', '进入写回'], [null, '延迟数值是教材常用的示例']],
  overview: {
    full: '把一条长路径切成 5 段，同时干 5 条指令的活',
    description: '单周期 CPU 的问题是一拍太长。流水线把指令的执行切成 IF、ID、EX、MEM、WB 五段，段与段之间放流水寄存器，每拍前进一段。一条指令花的时间没有变短，但每拍都能完成一条。这一课用周期精确的模拟器跑 5 条互不依赖的指令。',
    facts: [
      ['级数', '5：IF ID EX MEM WB'],
      ['程序', `${SOURCE.length} 条无依赖的 addi`],
      ['总周期', `${total} = ${SOURCE.length} + 4`],
      ['CPI（这段程序）', `${total} / ${SOURCE.length} = ${result.cpi.toFixed(1)}`],
      ['稳定时 CPI', '接近 1'],
    ],
  },
  steps: [
    {
      title: '切成五段',
      desc: '第 1 拍：第一条指令进入 IF',
      detail: `每段只做一件事：IF 取指，ID 译码并读寄存器，EX 用 ALU 计算，MEM 访问数据存储器，WB 写回寄存器。时钟周期由最慢的一段决定。用教材的示例延迟，最慢一段 ${PIPE_PS} ps，所以周期从单周期的 ${SINGLE_PS} ps 缩短到 ${PIPE_PS} ps。`,
      facts: [['IF ID EX MEM WB', Object.values(STAGE_PS).join(' / ') + ' ps E.G.'], ['单周期', `${SINGLE_PS} ps E.G.`], ['流水线', `${PIPE_PS} ps E.G.`]],
      events: [
        probe({ ...stagePanels(snap(1)), table: gantt(result, 1) }, 700),
      ],
    },
    {
      title: '流水寄存器',
      desc: '第 2 拍：两条指令同时在流水线里',
      detail: '第 2 拍，第一条指令进入 ID，第二条开始 IF。各段的结果不能直接连到下一段，否则一拍之内信号会一路穿透。每两段之间有一组流水寄存器，时钟沿到来时才把结果交给下一段。打开事件可以看到每组寄存器存了什么。',
      facts: [['IF/ID', '指令字、PC'], ['ID/EX', '寄存器值、立即数、控制信号'], ['EX/MEM', 'ALU 结果、写数据'], ['MEM/WB', '写回值']],
      events: cycleEvents(2),
    },
    {
      title: '填满流水线',
      desc: '第 3、4 拍：一拍进一条',
      detail: '每拍新取一条指令，已有的指令各自前进一段。这几拍还没有指令走到 WB，看起来什么也没有完成，这段启动代价只在开始时付一次。这段程序没有依赖，所有指令可以连续进入。',
      facts: [['第 3 拍在流水线里', '3 条'], ['第 4 拍在流水线里', '4 条'], ['已完成', '0 条']],
      events: [show('sex'), ...cycleEvents(3), show('smem'), ...cycleEvents(4)],
    },
    {
      title: '满负荷',
      desc: '第 5 拍：5 条指令各占一段，第一条完成',
      detail: `第 5 拍每一段都有活干，第一条指令写回 x1。从这一拍开始，每拍都有一条指令完成。注意每条指令仍然要花 5 拍，提升的是吞吐量，单条指令的延迟甚至略有增加，因为每段都要等满一个完整的周期。`,
      facts: [['第 5 拍写回', `x${snap(5).wb?.rd} = ${snap(5).wb?.value}`], ['指令延迟', '5 拍'], ['吞吐量', '每拍 1 条']],
      events: [show('swb'), ...cycleEvents(5)],
    },
    {
      title: '排空',
      desc: '第 6–9 拍：后面没有指令了',
      detail: `最后 ${total - 5} 拍后面没有新指令进来，流水线逐段变空，每拍写回一条。总共 ${total} 拍，CPI = ${total} / ${SOURCE.length} = ${result.cpi.toFixed(1)}。程序越长，这 4 拍的启动开销占比越小，CPI 就越接近 1。按示例延迟算总时间：单周期 ${singleTotal} ps，流水线 ${pipeTotal} ps。`,
      facts: [['总周期', String(total)], ['CPI', result.cpi.toFixed(1)], ['单周期总时间', `${singleTotal} ps E.G.`], ['流水线总时间', `${pipeTotal} ps E.G.`]],
      events: [...cycleEvents(6), ...cycleEvents(7), ...cycleEvents(8), ...cycleEvents(9)],
    },
  ],
  outro: {
    title: '吞吐量换来的麻烦',
    desc: '指令重叠执行，就会互相影响',
    text: `这 5 条指令互不依赖，才能这么顺利。真实程序里下一条指令经常要用上一条的结果，而上一条要到第 5 段才写回。下一课看硬件怎样解决这个问题。`,
    facts: [['理想 CPI', '1'], ['这段程序', result.cpi.toFixed(1)], ['下一课', 'HAZARD']],
  },
};

