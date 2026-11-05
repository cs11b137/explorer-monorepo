import { concept, counterLayer, instructionLayer, registers, wire } from '../decode/structures';
import { runPipeline, type BranchResolution, type CycleSnapshot, type PipelineResult } from '../sim/pipeline';
import { COUNTER_NAMES, COUNTER_TEXT, NOT_TAKEN, OneBitPredictor, replay, TwoBitPredictor } from '../sim/predictor';
import { assemble, hex32 } from '../sim/riscv';
import { note, pk, probe, show } from './dsl';
import type { CellLike } from '../scene/widgets';
import type { Lesson, LessonEvent } from './types';
import { cell, dim, gantt, grid, hx, kv, on, stagePanel } from './views';

const LOOP = ['addi x1, x0, 0', 'addi x2, x0, 10', 'loop:', 'addi x1, x1, 1', 'bne x1, x2, loop', 'addi x3, x1, 100', 'addi x4, x1, 200'];
const NESTED = ['addi x1, x0, 0', 'addi x5, x0, 3', 'outer:', 'addi x2, x0, 0', 'addi x6, x0, 4', 'inner:', 'addi x2, x2, 1', 'bne x2, x6, inner', 'addi x1, x1, 1', 'bne x1, x5, outer'];
const PROGRAM = assemble(LOOP);
const NESTED_PROGRAM = assemble(NESTED);

const staticRun = runPipeline(PROGRAM, { predictor: NOT_TAKEN });
const predictor = new TwoBitPredictor(16);
const dynamicRun = runPipeline(PROGRAM, { predictor });

// 重放分支序列，得到每次的计数器变化；序列本身来自流水线的真实结果。
const BRANCH_PC = dynamicRun.branches[0].pc;
const replayed = replay(new TwoBitPredictor(16), dynamicRun.branches.map((b) => ({ pc: b.pc, taken: b.taken }))).outcomes;

const nestedTrace = runPipeline(NESTED_PROGRAM).branches.map((b) => ({ pc: b.pc, taken: b.taken }));
const oneBit = replay(new OneBitPredictor(16), nestedTrace);
const twoBit = replay(new TwoBitPredictor(16), nestedTrace);
const nestedStatic = runPipeline(NESTED_PROGRAM, { predictor: NOT_TAKEN });
const nestedDynamic = runPipeline(NESTED_PROGRAM, { predictor: new TwoBitPredictor(16) });
const percent = (right: number, total: number) => `${((right / total) * 100).toFixed(1)}%`;

const INDEX = (BRANCH_PC >>> 2) % 16;
const RUN_STATIC = '静态';
const RUN_DYNAMIC = '预测';

function fsmPanel(state: number | null) {
  return grid(`2 位计数器 · 表项 #${INDEX}`, [['00 SN', 56], ['01 WN', 56], ['10 WT', 56], ['11 ST', 56]], [
    COUNTER_NAMES.map((_, value): CellLike => (state === value ? on(COUNTER_TEXT[value], value >= 2 ? 'green' : 'amber') : dim(COUNTER_TEXT[value]))),
    ['猜不跳', '猜不跳', cell('猜跳', 'green'), cell('猜跳', 'green')],
  ]);
}

function historyPanel(upto: number) {
  const rows = dynamicRun.branches.slice(0, 10).map((b: BranchResolution, index): CellLike[] => {
    if (index > upto) return [String(index + 1), dim('·'), dim('·'), dim('·'), dim('·')];
    const outcome = replayed[index];
    return [
      String(index + 1),
      b.predictedTaken ? '跳' : '不跳',
      b.taken ? '跳' : '不跳',
      `${COUNTER_NAMES[outcome.counterBefore!]}→${COUNTER_NAMES[outcome.counterAfter!]}`,
      b.mispredicted ? on('错', 'red') : cell('对', 'green'),
    ];
  });
  return grid('bne 每次的预测（真实结果）', [['次', 24], ['预测', 38], ['实际', 38], ['计数器', 62], ['', 30]], rows);
}

const resolveCycle = (run: PipelineResult, index: number): CycleSnapshot => run.cycles.filter((c) => c.branch)[index];

const staticFirst = resolveCycle(staticRun, 0);
const dynamicCycles = dynamicRun.cycles.filter((c) => c.branch);
const firstMiss = dynamicCycles[0];
const second = dynamicCycles[1];
const third = dynamicCycles[2];
const lastMiss = dynamicCycles[dynamicCycles.length - 1];

/** 分支附近的一小段流水线图。 */
const win = (run: PipelineResult, upTo: number, center: number, title: string) => gantt(run, upTo, { first: center - 4, last: center + 2, title, textWidth: 104, cellWidth: 30, maxRows: 7 });

const counterEvent = (index: number, cycle: number): LessonEvent => {
  const b = dynamicRun.branches[index];
  const outcome = replayed[index];
  return pk('sex', 'predictor', 'violet', '更新', [`${COUNTER_NAMES[outcome.counterBefore!]} → ${COUNTER_NAMES[outcome.counterAfter!]}`], [cycle, 'CTRL', `实际${b.taken ? '跳' : '不跳'}，计数器 ${COUNTER_NAMES[outcome.counterBefore!]} → ${COUNTER_NAMES[outcome.counterAfter!]}`, '8b', RUN_DYNAMIC],
    wire('EX 级把结果写回预测器', 'regs', 'model', counterLayer(b.pc, INDEX, outcome.counterBefore!, b.taken, outcome.counterAfter!)), { quick: true });
};

const flushEvents = (s: CycleSnapshot, run: string): LessonEvent[] => {
  return s.flushed.map((view, index) => pk(index === 0 ? 'sid' : 'sif', index === 0 ? 'sex' : 'sid', 'slate', '冲掉', [view.text], [s.cycle, 'FLUSH', `错误路径上的 ${view.text} 被冲掉`, 4, run],
    wire(`第 ${s.cycle} 拍结束时冲刷`, 'mem', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: 'slate' }), concept('冲刷', [['动作', '这条指令的控制信号清零', '它还没到 MEM 和 WB，没有改变任何状态，所以直接作废就行。']], 'slate')), { lost: true, quick: true }));
};

const redirectEvent = (s: CycleSnapshot, run: string): LessonEvent => pk('sex', 'pc', 'amber', '改 PC', [hx(s.branch!.taken ? s.branch!.target : s.branch!.pc + 4)], [s.cycle, 'CTRL', `${s.branch!.text} 实际${s.branch!.taken ? `跳到 ${hx(s.branch!.target)}` : '不跳'}，预测错了，改写 PC`, 'reg', run],
  wire('EX 级解析分支', 'regs', 'model', registers('PC 改写', [['PC', s.branch!.taken ? s.branch!.target : s.branch!.pc + 4]], 'amber'), concept('比较结果', [['预测', s.branch!.predictedTaken ? '跳' : '不跳'], ['实际', s.branch!.taken ? '跳' : '不跳']], 'slate')));

const stageFrame = (s: CycleSnapshot, table: ReturnType<typeof gantt>, pcValue: number) => ({
  sif: stagePanel(s, 'IF'), sid: stagePanel(s, 'ID'), sex: stagePanel(s, 'EX'),
  pc: kv('PC', [['下一拍', cell(hx(pcValue), 'blue')]]),
  table,
});

const COST_STATIC = staticRun.cycles.length;
const COST_DYNAMIC = dynamicRun.cycles.length;

export const branch: Lesson = {
  id: 'branch',
  name: 'BRANCH',
  title: '分支预测',
  group: 'cpu',
  layer: [4, 5],
  clock: 'cycle',
  nodes: ['pc', 'sif', 'sid', 'sex', 'predictor'],
  place: { pc: [80, 420], sif: [290, 130], sid: [500, 130], sex: [710, 130], predictor: [430, 370] },
  labels: {
    pc: ['PC', ''],
    sif: ['IF', '这里预测'],
    sid: ['ID', ''],
    sex: ['EX', '这里才知道答案'],
    predictor: ['预测器', '16 项 2 位计数器 + BTB'],
  },
  panels: { pc: [160, 430], sif: [205, 0], sid: [415, 0], sex: [625, 0], predictor: [385, 470], history: [640, 285], table: [10, 495] },
  main: ['table'],
  strip: [['sif', 'sid', 'sex', 'pc'], 'table', 'history', 'predictor'],
  initial: {
    pc: kv('PC', [['下一拍', dim('—')]]),
    sif: stagePanel(null, 'IF'),
    sid: stagePanel(null, 'ID'),
    sex: stagePanel(null, 'EX'),
    predictor: fsmPanel(1),
    history: historyPanel(-1),
    table: win(staticRun, 0, staticFirst.cycle, '流水线图'),
  },
  start: ['pc', 'sif', 'sid', 'sex'],
  legend: [['amber', '解析与改 PC'], ['slate', '被冲掉'], ['violet', '更新预测器'], ['green', '预测正确'], [null, '两次独立运行各自计周期']],
  overview: {
    full: '分支的结果要等到 EX 才知道，在此之前先猜',
    description: '取指每拍都要给出下一个 PC，可分支要到 EX 才算出结果，中间已经取了两条指令。这一课在周期精确的流水线上跑一个真实的循环：先看静态预测每次跳转都要付的代价，再加上 2 位饱和计数器和 BTB，看错误次数和总周期怎样变化。',
    facts: [
      ['程序', '循环 10 次的 bne'],
      ['错一次', '冲掉 2 条，罚 2 拍'],
      ['静态猜不跳', `错 ${staticRun.mispredicts} 次，${COST_STATIC} 拍`],
      ['2 位计数器', `错 ${dynamicRun.mispredicts} 次，${COST_DYNAMIC} 拍`],
      ['真实 CPU', '惩罚约 15–20 拍 E.G.'],
    ],
  },
  steps: [
    {
      title: '控制冒险',
      desc: `第 ${staticFirst.cycle} 拍：猜错了，冲掉两条`,
      detail: `静态预测总猜不跳，所以 bne 后面的指令照常取。第 ${staticFirst.cycle} 拍 bne 在 EX 级算出要跳，这时 ID 和 IF 里已经是错误路径上的指令。它们还没写任何状态，把控制信号清零就能作废，代价是 2 拍。这段循环跳 ${staticRun.mispredicts} 次，每次都错。`,
      facts: [['解析位置', 'EX 级'], ['冲掉', `${staticFirst.flushed.length} 条`], ['错误次数', String(staticRun.mispredicts)], ['总周期', String(COST_STATIC)]],
      events: [
        probe(stageFrame(staticRun.cycles[staticFirst.cycle - 2], win(staticRun, staticFirst.cycle - 1, staticFirst.cycle, '静态预测：总猜不跳'), staticRun.cycles[staticFirst.cycle - 2].pc), 800),
        pk('sif', 'sid', 'blue', '取指', [staticFirst.stages.ID?.text ?? ''], [staticFirst.cycle - 1, 'FETCH', '猜不跳，顺序取指', 4, RUN_STATIC],
          wire('顺序取指', 'mem', 'spec', instructionLayer(staticFirst.stages.ID!.word, { pc: staticFirst.stages.ID!.pc, text: staticFirst.stages.ID!.text })), { quick: true }),
        probe(stageFrame(staticFirst, win(staticRun, staticFirst.cycle, staticFirst.cycle, '静态预测：总猜不跳'), staticFirst.pc), 800),
        redirectEvent(staticFirst, RUN_STATIC),
        ...flushEvents(staticFirst, RUN_STATIC),
        probe({ table: win(staticRun, staticFirst.cycle + 4, staticFirst.cycle, '静态预测：总猜不跳') }, 900),
      ],
    },
    {
      title: '2 位计数器',
      desc: '错一次不改主意',
      detail: '给每个分支一个 2 位计数器：跳了加 1，没跳减 1，到头不再变；高位决定猜跳还是不跳。从强状态出发要连错两次才会改变方向，循环结束时偶然的一次不跳不会动摇下一轮的判断。计数器用 PC 的低位做索引，不同分支可能撞到同一项。',
      facts: [['状态', 'SN WN WT ST'], ['初值', 'WN（01）E.G.'], ['跳了', '加 1，到 ST 不再加'], ['没跳', '减 1，到 SN 不再减']],
      events: [
        show('predictor'),
        probe({ ...stageFrame(dynamicRun.cycles[firstMiss.cycle - 3], win(dynamicRun, firstMiss.cycle - 2, firstMiss.cycle, '2 位预测器'), dynamicRun.cycles[firstMiss.cycle - 3].pc), predictor: fsmPanel(1), history: historyPanel(-1) }, 1000),
        pk('predictor', 'sif', 'violet', '预测', [`#${INDEX} = WN`, '猜不跳'], [firstMiss.cycle - 2, 'CTRL', `IF 级查表：表项 #${INDEX} 是 WN，猜不跳`, '8b', RUN_DYNAMIC],
          wire('用 PC 低位查预测表', 'regs', 'model', counterLayer(BRANCH_PC, INDEX, 1, true, 1), concept('索引', [['PC', hex32(BRANCH_PC)], ['表项', `(PC >> 2) mod 16 = ${INDEX}`]], 'slate'))),
      ],
    },
    {
      title: '学习',
      desc: '前两次分支把计数器推到猜跳',
      detail: `第一次遇到 bne，BTB 里还没有目标，只能顺序取指，错了罚 2 拍。这次计数器从 WN 到 WT，BTB 记下目标。下一次取到它时预测器猜跳，IF 级直接转向目标地址，EX 验证正确，一拍也不罚。`,
      facts: [['第 1 次', `${COUNTER_NAMES[replayed[0].counterBefore!]} → ${COUNTER_NAMES[replayed[0].counterAfter!]}，错`], ['第 2 次', `${COUNTER_NAMES[replayed[1].counterBefore!]} → ${COUNTER_NAMES[replayed[1].counterAfter!]}，${second.branch!.mispredicted ? '错' : '对'}`], ['BTB', '记录分支的目标地址']],
      events: [
        probe({ ...stageFrame(firstMiss, win(dynamicRun, firstMiss.cycle, firstMiss.cycle, '2 位预测器'), firstMiss.pc), history: historyPanel(0), predictor: fsmPanel(replayed[0].counterAfter!) }, 800),
        redirectEvent(firstMiss, RUN_DYNAMIC),
        ...flushEvents(firstMiss, RUN_DYNAMIC),
        counterEvent(0, firstMiss.cycle),
        probe({ ...stageFrame(second, win(dynamicRun, second.cycle, second.cycle, '2 位预测器'), second.pc), history: historyPanel(1), predictor: fsmPanel(replayed[1].counterAfter!) }, 900),
        counterEvent(1, second.cycle),
        note('sex', second.branch!.mispredicted ? '这次还错' : '预测正确，不罚', 'green'),
        probe({ ...stageFrame(third, win(dynamicRun, third.cycle, third.cycle, '2 位预测器'), third.pc), history: historyPanel(2), predictor: fsmPanel(replayed[2].counterAfter!) }, 900),
        counterEvent(2, third.cycle),
      ],
    },
    {
      title: '退出循环',
      desc: '只错最后一次，计数器还是猜跳',
      detail: `中间几次都猜对。第 10 次 x1 等于 10，bne 不跳，预测错，罚 2 拍。计数器从 ST 掉到 WT，还是猜跳，所以下次再进这个循环时第一次就能猜对。如果只有 1 位，这一次会把方向直接改成不跳，下一轮第一次也要错。`,
      facts: [['总分支', String(dynamicRun.branches.length)], ['错误', String(dynamicRun.mispredicts)], ['最后状态', COUNTER_NAMES[replayed[replayed.length - 1].counterAfter!]], ['总周期', String(COST_DYNAMIC)]],
      events: [
        ...dynamicRun.branches.slice(3, -1).map((_, offset) => probe({ history: historyPanel(3 + offset), predictor: fsmPanel(replayed[3 + offset].counterAfter!) }, 260)),
        probe({ ...stageFrame(lastMiss, win(dynamicRun, lastMiss.cycle, lastMiss.cycle, '2 位预测器'), lastMiss.pc), history: historyPanel(9), predictor: fsmPanel(replayed[replayed.length - 1].counterAfter!) }, 900),
        redirectEvent(lastMiss, RUN_DYNAMIC),
        ...flushEvents(lastMiss, RUN_DYNAMIC),
        counterEvent(dynamicRun.branches.length - 1, lastMiss.cycle),
        probe({ table: win(dynamicRun, lastMiss.cycle + 4, lastMiss.cycle, '2 位预测器') }, 600),
      ],
    },
    {
      title: '值不值',
      desc: '用嵌套循环比一比 1 位和 2 位',
      detail: `把内层 4 次、外层 3 次的嵌套循环的真实分支序列喂给两种预测器：1 位对 ${oneBit.correct}/${oneBit.total}，2 位对 ${twoBit.correct}/${twoBit.total}。1 位在内层循环每次进出都错两次，2 位只错退出那次。跑进流水线，静态 ${nestedStatic.cycles.length} 拍，2 位 ${nestedDynamic.cycles.length} 拍。真实 CPU 的流水线深得多，错一次要丢 15–20 拍（E.G.），所以会用更复杂的预测器，比如看全局历史的 TAGE。`,
      facts: [['1 位', `${percent(oneBit.correct, oneBit.total)} 正确`], ['2 位', `${percent(twoBit.correct, twoBit.total)} 正确`], ['静态总周期', String(nestedStatic.cycles.length)], ['2 位总周期', String(nestedDynamic.cycles.length)]],
      events: [
        probe({ table: grid('嵌套循环（内 4 × 外 3）的真实分支序列', [['预测器', 100], ['正确/总数', 80], ['正确率', 70], ['流水线总周期', 96]], [
          ['静态猜不跳', `${replay(NOT_TAKEN, nestedTrace).correct}/${nestedTrace.length}`, percent(replay(NOT_TAKEN, nestedTrace).correct, nestedTrace.length), String(nestedStatic.cycles.length)],
          ['1 位', `${oneBit.correct}/${oneBit.total}`, percent(oneBit.correct, oneBit.total), dim('—')],
          [on('2 位', 'green'), `${twoBit.correct}/${twoBit.total}`, cell(percent(twoBit.correct, twoBit.total), 'green'), cell(String(nestedDynamic.cycles.length), 'green')],
        ]) }, 800),
        pk('sex', 'predictor', 'green', '统计', [`2 位 ${percent(twoBit.correct, twoBit.total)}`], [lastMiss.cycle + 1, 'CALC', `嵌套循环：1 位 ${oneBit.correct}/${oneBit.total}，2 位 ${twoBit.correct}/${twoBit.total}`, null, RUN_DYNAMIC],
          wire('真实分支序列的重放', 'regs', 'model', concept('结果', [
            ['序列长度', String(nestedTrace.length)],
            ['1 位正确', `${oneBit.correct}（${percent(oneBit.correct, oneBit.total)}）`],
            ['2 位正确', `${twoBit.correct}（${percent(twoBit.correct, twoBit.total)}）`],
            ['静态总周期', String(nestedStatic.cycles.length)],
            ['2 位总周期', String(nestedDynamic.cycles.length)],
          ], 'green'))),
      ],
    },
  ],
  outro: {
    title: '猜对了不要钱',
    desc: '猜错的代价随流水线深度增长',
    text: '猜错的指令还没写任何状态，所以回退很便宜；这也是可以大胆预测的前提。处理器部分到这里结束，下一组课程看指令访问内存时发生的事。',
    facts: [['静态', `${COST_STATIC} 拍`], ['2 位', `${COST_DYNAMIC} 拍`], ['下一课', 'CACHE']],
  },
};
