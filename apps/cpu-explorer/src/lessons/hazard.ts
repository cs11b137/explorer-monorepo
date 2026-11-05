import { concept, instructionLayer, registers, wire } from '../decode/structures';
import { Memory } from '../sim/exec';
import { runPipeline, type CycleSnapshot } from '../sim/pipeline';
import { assemble } from '../sim/riscv';
import { note, pk, probe, show } from './dsl';
import type { Lesson, LessonEvent } from './types';
import { cell, dim, gantt, hx, kv, on, regsPanel, stagePanels } from './views';

const SOURCE = ['addi x2, x0, 7', 'addi x5, x0, 3', 'add x1, x2, x5', 'sub x4, x1, x5', 'sw x4, 256(x0)', 'lw x6, 256(x0)', 'and x7, x6, x1'];
const PROGRAM = assemble(SOURCE);
const forwarded = runPipeline(PROGRAM, { memory: new Memory() });
const noForward = runPipeline(PROGRAM, { forwarding: false, memory: new Memory() });
const REGS = [1, 2, 4, 5, 6, 7];
const snap = (cycle: number) => forwarded.cycles[cycle - 1];

const fwdPanel = (s: CycleSnapshot | null) => {
  if (!s) return kv('前递单元', [['A 口', dim('—')], ['B 口', dim('—')], ['冒险检测', dim('—')]]);
  const port = (name: 'A' | 'B') => {
    const f = s.forwards.find((item) => item.port === name);
    return f ? on(`来自 ${f.from}：${f.value}`, f.from === 'MEM' ? 'amber' : 'violet') : dim('用寄存器堆读到的值');
  };
  return kv('前递单元', [['A 口', port('A')], ['B 口', port('B')], ['冒险检测', s.stall ? on('load-use，停 1 拍', 'red') : cell('无', 'green')]]);
};

/** 这一拍的全部面板。pending 时 EX 的结果还没出来，用在数据包飞之前。 */
const frame = (cycle: number, hold = 700, pending = false): LessonEvent => {
  const s = snap(cycle);
  return probe({ ...stagePanels(s, pending), hazard: fwdPanel(s), regs: regsPanel('寄存器堆', s.regs, REGS, s.wb ? [s.wb.rd] : []), table: gantt(forwarded, cycle) }, hold);
};

/** 一拍的完整顺序：先让面板进入这一拍，再飞这一拍的数据包，最后显示 EX 的结果。 */
const beat = (cycle: number, hold = 700, between: LessonEvent[] = []): LessonEvent[] => [frame(cycle, 350, true), ...exec(cycle), ...between, frame(cycle, hold)];

/** 每一拍进入 EX 的指令走一次，发生前递时再画前递。 */
function exec(cycle: number): LessonEvent[] {
  const s = snap(cycle);
  const out: LessonEvent[] = [];
  const view = s.stages.EX;
  for (const f of s.forwards) {
    const source = f.from === 'MEM' ? 'smem' : 'swb';
    out.push(pk(source, 'hazard', f.from === 'MEM' ? 'amber' : 'violet', `x${f.reg}`, [`= ${f.value}`], [cycle, 'FWD', `${f.from} 级把 x${f.reg} = ${f.value} 前递给 ${f.port} 口（来自 ${f.producer}）`, 'reg'],
      wire(`${f.from === 'MEM' ? 'EX/MEM' : 'MEM/WB'} 流水寄存器 → 前递选择器`, 'regs', 'model', registers('前递的值', [[`x${f.reg}`, f.value, f.from === 'MEM' ? `由 ${f.producer} 产生，还没写回寄存器堆。` : `由 ${f.producer} 产生。这一拍才写回，当前指令在 ID 级读寄存器时还读不到。`]], f.from === 'MEM' ? 'amber' : 'violet'), concept('比较条件', [
        ['条件', `${f.from === 'MEM' ? 'EX/MEM' : 'MEM/WB'}.RegWrite 且 rd = rs${f.port === 'A' ? 1 : 2} ≠ x0`, 'EX/MEM 优先于 MEM/WB，因为它更新。'],
      ], 'slate')), { quick: true }));
  }
  if (s.forwards.length) {
    const toStore = view?.text.startsWith('sw');
    out.push(pk('hazard', 'sex', 'amber', '选择器', s.forwards.map((f) => `${f.port} = ${f.value}`), [cycle, 'FWD', toStore ? '前递选择器把值接到 store 的写数据通路' : '前递选择器把值接到 ALU 输入', 'reg'],
      wire('EX 级输入选择器', 'regs', 'model', toStore
        ? registers('写数据通路', [[`x${s.forwards[0].reg}`, s.forwards[0].value, 'store 的 ALU 用立即数算地址，前递的值要写进内存。']], 'amber')
        : registers('ALU 输入', [['A', s.ex!.a], ['B', s.ex!.b]], 'amber')), { quick: true }));
  }
  if (view && s.ex) {
    out.push(pk('sid', 'sex', 'blue', 'EX', [view.text, `Y = ${s.ex.result}`], [cycle, 'EXEC', `${view.text}：${s.ex.op} ${hx(s.ex.a)}, ${hx(s.ex.b)} = ${hx(s.ex.result)}`, 'reg'],
      wire(`第 ${cycle} 拍的 EX 级`, 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text }), registers('ALU', [['A', s.ex.a], ['B', s.ex.b], ['Y', s.ex.result]], 'blue')), { quick: !s.forwards.length }));
  }
  return out;
}

const stallCycle = forwarded.cycles.find((item) => item.stall)!.cycle;
const ADD_EX = forwarded.cycles.find((item) => item.stages.EX?.text.startsWith('add x'))!.cycle;
const SUB_EX = forwarded.cycles.find((item) => item.stages.EX?.text.startsWith('sub'))!.cycle;
const SW_EX = forwarded.cycles.find((item) => item.stages.EX?.text.startsWith('sw'))!.cycle;
const LW_EX = forwarded.cycles.find((item) => item.stages.EX?.text.startsWith('lw'))!.cycle;
const AND_EX = forwarded.cycles.find((item) => item.stages.EX?.text.startsWith('and'))!.cycle;

const initial = {
  ...stagePanels(null),
  hazard: fwdPanel(null),
  regs: regsPanel('寄存器堆', new Array(32).fill(0), REGS),
  table: gantt(forwarded, 0),
};

export const hazard: Lesson = {
  id: 'hazard',
  name: 'HAZARD',
  title: '数据冒险与前递',
  group: 'cpu',
  layer: [4, 4],
  clock: 'cycle',
  nodes: ['sif', 'sid', 'sex', 'smem', 'swb', 'hazard'],
  place: { sif: [70, 150], sid: [255, 150], sex: [440, 150], smem: [625, 150], swb: [810, 150], hazard: [530, 330] },
  labels: {
    sif: ['IF', ''],
    sid: ['ID', '读寄存器、检测冒险'],
    sex: ['EX', ''],
    smem: ['MEM', ''],
    swb: ['WB', ''],
    hazard: ['前递单元', ''],
  },
  panels: { sif: [0, 15], sid: [175, 15], sex: [360, 15], smem: [545, 15], swb: [730, 15], hazard: [640, 298], regs: [190, 260], table: [85, 432] },
  main: ['table'],
  strip: [['sif', 'sid', 'sex', 'smem', 'swb'], 'table', 'hazard', 'regs'],
  initial,
  start: ['sid', 'sex', 'smem', 'swb', 'hazard'],
  legend: [['blue', '进入 EX'], ['amber', '从 MEM 前递'], ['violet', '从 WB 前递'], ['slate', '停顿'], [null, '红色格子是停顿的拍']],
  overview: {
    full: '下一条要用的值，上一条还没写回',
    description: `流水线里 add 在第 ${ADD_EX + 2} 拍才写回 x1，紧跟着的 sub 第 ${SUB_EX - 1} 拍就要读它。硬件有两个办法：把还在路上的结果直接接到 ALU 输入（前递），或者让后面的指令等一等（停顿）。这一课的流水线图、前递来源和寄存器内容全部由模拟器一拍一拍算出。`,
    facts: [
      ['程序', `${SOURCE.length} 条指令`],
      ['开前递', `${forwarded.cycles.length} 拍，停 ${forwarded.stalls} 拍`],
      ['关前递', `${noForward.cycles.length} 拍，停 ${noForward.stalls} 拍`],
      ['前递来源', 'EX/MEM、MEM/WB'],
      ['必须停顿', 'load 后紧跟使用'],
    ],
  },
  steps: [
    {
      title: '依赖',
      desc: '写后读：后面的指令要用前面的结果',
      detail: `这段程序里 add 用 x2 和 x5，sub 用 x1，sw 用 x4，全是前一两条才算出来的。如果什么都不做，ID 级读到的是旧值。这种依赖叫写后读（RAW，read after write）。五级流水线按顺序写回，只有这一种数据冒险，写后写和读后写不会出问题。`,
      facts: [['add 需要', 'x2、x5'], ['sub 需要', 'x1、x5'], ['and 需要', 'x6、x1'], ['第 3 拍 EX', snap(3).stages.EX?.text ?? '—']],
      events: [
        frame(1, 500), frame(2, 500),
        ...beat(3, 500),
        ...beat(4, 600),
      ],
    },
    {
      title: '不前递的代价',
      desc: `多等 ${noForward.cycles.length - forwarded.cycles.length} 拍`,
      detail: `不用前递也能跑对：让后面的指令在 ID 级等到写回。寄存器堆前半拍写、后半拍读，所以紧邻的依赖要等 2 拍，隔一条要等 1 拍。模拟器跑出来：关前递共 ${noForward.cycles.length} 拍，停了 ${noForward.stalls} 拍；开前递只要 ${forwarded.cycles.length} 拍，停 ${forwarded.stalls} 拍。两种方式写回的结果完全相同。`,
      facts: [['关前递', `${noForward.cycles.length} 拍`], ['开前递', `${forwarded.cycles.length} 拍`], ['CPI', `${noForward.cpi.toFixed(2)} → ${forwarded.cpi.toFixed(2)}`], ['结果', '一样']],
      events: [
        probe({ table: gantt(noForward, noForward.cycles.length, { title: '对比：关前递的流水线图', textWidth: 96, cellWidth: 26 }) }, 1800),
        note('sid', `关前递要停 ${noForward.stalls} 拍`, 'amber'),
        probe({ table: gantt(forwarded, 4) }),
      ],
    },
    {
      title: '从 MEM 和 WB 前递',
      desc: `第 ${ADD_EX} 拍：add 的两个操作数都走前递`,
      detail: `第 ${ADD_EX} 拍 add 在 EX 级。x5 由上一条算出，还在 EX/MEM 流水寄存器里；x2 由上上一条算出，在 MEM/WB 里。前递单元比较 rd 和 rs1、rs2，相等就把对应的值接到 ALU 输入。同一个寄存器两处都有时选较新的 EX/MEM。`,
      facts: [['A 口', snap(ADD_EX).forwards.find((f) => f.port === 'A')?.from ?? '—'], ['B 口', snap(ADD_EX).forwards.find((f) => f.port === 'B')?.from ?? '—'], ['结果', `x1 = ${snap(ADD_EX).ex!.result}`], ['跳过', 'x0 永远不前递']],
      events: [
        show('sif'),
        ...beat(ADD_EX, 1000),
      ],
    },
    {
      title: '连续前递',
      desc: '一连串依赖都不用等',
      detail: `sub 用 add 的结果，sw 又用 sub 的结果，每条都在上一条刚出 ALU 时拿到值，一拍也不用停。store 的写数据也要前递：sw 的 rs2 是 x4，在第 ${SW_EX} 拍从 EX/MEM 拿到，随后在 MEM 级写进内存。`,
      facts: [['sub', `第 ${SUB_EX} 拍，x4 = ${snap(SUB_EX).ex!.result}`], ['sw', `第 ${SW_EX} 拍前递 x4`], ['写内存', `第 ${SW_EX + 1} 拍`], ['停顿', '0 拍']],
      events: [
        ...beat(SUB_EX, 900),
        ...beat(SW_EX, 900),
      ],
    },
    {
      title: 'load-use',
      desc: `第 ${stallCycle} 拍：前递也救不了，只能停 1 拍`,
      detail: `lw 要到 MEM 级结束才拿到数据，而紧跟的 and 在下一拍开始就要进 ALU。时间上倒流了，前递也来不及。ID 级的冒险检测发现 load 的 rd 等于自己的 rs1，就停 1 拍：PC 和 IF/ID 不更新，往 EX 塞一个空泡。编译器会尽量把无关的指令排到这个位置。`,
      facts: [['停顿发生', `第 ${stallCycle} 拍`], ['检测位置', 'ID 级'], ['条件', 'EX 是 load 且 rd = rs1 或 rs2'], ['做法', '保持 PC、IF/ID，EX 进空泡']],
      events: [
        ...beat(LW_EX, 800, [
        pk('sid', 'sex', 'slate', '空泡', ['and 要等 lw'], [stallCycle, 'STALL', `冒险检测：${snap(stallCycle).stages.EX?.text} 的 rd 等于 and 的 rs1，停 1 拍`, null],
          wire('冒险检测单元', 'regs', 'model', concept('load-use 判断', [
            ['ID/EX.MemRead', '1', '现在 EX 级是 load。'],
            ['ID/EX.rd', 'x6'],
            ['IF/ID.rs1', 'x6', '相等，所以要停。'],
            ['动作', 'PC 和 IF/ID 保持，控制信号清零', '清零的控制信号就是空泡，它会像一条什么也不做的指令一样往后走。'],
          ], 'slate'))),
        ]),
        frame(stallCycle + 1, 1000),
      ],
    },
    {
      title: '停完再前递',
      desc: `第 ${AND_EX} 拍：lw 的数据从 WB 前递`,
      detail: `停 1 拍之后，lw 到了 WB，数据已经在 MEM/WB 里，可以前递给 and。x1 早就写回了，直接用 ID 级读到的值。最后整段程序 ${forwarded.cycles.length} 拍完成，CPI = ${forwarded.cpi.toFixed(2)}，其中有 4 拍是流水线的启动开销，1 拍是这次停顿。`,
      facts: [['A 口', '从 WB 前递 x6'], ['总周期', String(forwarded.cycles.length)], ['CPI', forwarded.cpi.toFixed(2)], ['最终 x7', hx(forwarded.regs[7])]],
      events: [
        ...beat(AND_EX, 900),
        ...forwarded.cycles.slice(AND_EX).map((item) => frame(item.cycle, 600)),
        note('swb', `全部写回，共 ${forwarded.cycles.length} 拍`, 'green'),
      ],
    },
  ],
  outro: {
    title: '前递解决大部分，停顿兜底',
    desc: '只有 load-use 必须等',
    text: '前递把绝大多数依赖的代价降到 0，只留下 load-use 这 1 拍。编译器还可以调整指令顺序，避开这一拍。流水线里还有另一种冒险：分支要到 EX 才知道往哪走，下一课看怎样猜。',
    facts: [['写后读', '前递'], ['load-use', '停 1 拍'], ['下一课', 'BRANCH']],
  },
};

