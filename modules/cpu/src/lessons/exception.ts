import { concept, csrLayer, instructionLayer, mstatusText, registers, trapLayer, wire } from '../decode/structures';
import type { CellLike, KvWidget, PanelContent } from '../scene/widgets';
import { Memory } from '../sim/exec';
import { CAUSE_TEXT, MSTATUS, runPipeline, type CsrFile, type CycleSnapshot, type PipelineResult, type ReturnRecord, type StageName, type TrapRecord } from '../sim/pipeline';
import { assemble, CSR, isCsrOp, decode, UNIMP_WORD } from '../sim/riscv';
import { note, pk, probe, show } from './dsl';
import type { Lesson, LessonEvent, PacketEvent, StreamEvent } from './types';
import { cell, dim, gantt, grid, hx, kv, on, STAGE_NODES } from './views';

const HANDLER_BASE = 0x80;
/** 例一：启动代码设好 mtvec，然后遇到一条 unimp。 */
const MAIN = ['addi x5, x0, 128', 'csrw mtvec, x5', 'addi x1, x0, 1', 'unimp', 'sw x1, 256(x0)', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4'];
/** 处理程序：读原因和出事的地址，跳过这条指令再返回。 */
const HANDLER = ['csrr x10, mcause', 'csrr x11, mepc', 'addi x11, x11, 4', 'csrw mepc, x11', 'mret'];
/** 例二：较老的 lw 在 MEM 才出错，较新的 unimp 在 ID 就出错了。 */
const TWO = ['addi x1, x0, 256', 'lw x6, 2(x1)', 'unimp', 'addi x7, x0, 7'];

const handler = { base: HANDLER_BASE, words: assemble(HANDLER, HANDLER_BASE) };
const runA = runPipeline(assemble(MAIN), { exceptions: true, sections: [handler], csrs: { mstatus: MSTATUS.MIE }, memory: new Memory() });
const runB = runPipeline(assemble(TWO), { exceptions: true, sections: [handler], csrs: { mstatus: MSTATUS.MIE, mtvec: HANDLER_BASE }, memory: new Memory() });
const RUN_A = '例一';
const RUN_B = '例二';

interface Run {
  result: PipelineResult;
  label: string;
  regs: number[];
  /** 面板里要看的那个内存字。 */
  word?: number;
}
const A: Run = { result: runA, label: RUN_A, regs: [1, 10, 11], word: 256 };
const B: Run = { result: runB, label: RUN_B, regs: [1, 6, 7, 10] };

const snap = (run: Run, cycle: number) => run.result.cycles[cycle - 1];
const findCycle = (run: Run, test: (s: CycleSnapshot) => boolean) => run.result.cycles.find(test)!;

const MTVEC_WRITE = findCycle(A, (s) => s.csr?.name === 'mtvec');
const DETECT = findCycle(A, (s) => s.detected.length > 0);
const TRAP = runA.traps[0];
const READ_CAUSE = findCycle(A, (s) => s.csr?.name === 'mcause');
const READ_EPC = findCycle(A, (s) => s.csr?.name === 'mepc' && !s.csr.write);
const WRITE_EPC = findCycle(A, (s) => s.csr?.name === 'mepc' && s.csr.write);
const STALL = findCycle(A, (s) => s.stall);
const RET = runA.returns[0];
const STORE = findCycle(A, (s) => Boolean(s.mem?.write));
const LAST_A = runA.cycles.length;
const [TRAP_B1, TRAP_B2] = runB.traps;
const DETECT_B_ID = findCycle(B, (s) => s.detected.some((d) => d.stage === 'ID'));
const DETECT_B_MEM = findCycle(B, (s) => s.detected.some((d) => d.stage === 'MEM'));
const LAST_B = runB.cycles.length;

const ORDER: StageName[] = ['IF', 'ID', 'EX', 'MEM', 'WB'];
const NEXT: Record<StageName, StageName> = { IF: 'ID', ID: 'EX', EX: 'MEM', MEM: 'WB', WB: 'WB' };
const TYPE = { ID: 'DECODE', EX: 'EXEC', MEM: 'MEM', WB: 'WB' } as const;
const LATCH_NOTE: Record<StageName, string> = {
  IF: '',
  ID: 'IF/ID 流水寄存器保存指令字和 PC。',
  EX: 'ID/EX 保存寄存器值、立即数、控制信号和异常标记。',
  MEM: 'EX/MEM 保存 ALU 结果、写数据和异常标记。',
  WB: 'MEM/WB 保存写回值和异常标记。',
};

const causeText = (cause: number) => `${cause} ${CAUSE_TEXT[cause]}`;
const mstatusShort = (value: number) => `MIE=${(value & MSTATUS.MIE) >>> 3} MPIE=${(value & MSTATUS.MPIE) >>> 7}`;
/** 这一拍刚检测到的指令，在这一拍开始时还没有标记。 */
const justDetected = (s: CycleSnapshot, seq: number) => s.detected.some((d) => d.seq === seq);

// ---------- 面板 ----------

/** 一级的面板。start 是这一拍刚开始：指令已经各就各位，这一拍的结果还没出来。 */
function stagePanel(s: CycleSnapshot, stage: StageName, start: boolean): KvWidget {
  const view = s.stages[stage];
  const title = `${stage} 级`;
  if (!view) return kv(title, [['指令', dim('空泡')], ['状态', dim('—')]]);
  let status: CellLike;
  const marked = view.cause !== undefined && !(start && justDetected(s, view.seq));
  if (!start && s.flushed.some((f) => f.seq === view.seq)) status = on('冲掉', 'slate');
  else if (stage === 'WB' && s.trap && !start) status = on(`陷入 mcause=${s.trap.cause}`, 'red');
  else if (marked) status = on(`带异常 mcause=${view.cause}`, 'red');
  else if (stage === 'IF') status = `PC=${hx(view.pc)}`;
  else if (stage === 'ID') status = s.stall ? on('停顿', 'red') : dim('译码');
  else if (stage === 'EX') status = start ? dim('计算中') : s.ex ? (isCsrOp(decode(view.word).name) ? `rs1=${hx(s.ex.a)}` : `Y=${hx(s.ex.result)}`) : dim('—');
  else if (stage === 'MEM') status = s.csr ? cell(`${s.csr.write ? '写' : '读'} ${s.csr.name}`, 'violet') : s.mem ? `${s.mem.write ? '写' : '读'} [${hx(s.mem.address)}]` : dim('不访问');
  else status = s.mret && !start ? on('mret：回到 mepc', 'amber') : s.wb && !start ? `x${s.wb.rd}=${hx(s.wb.value)}` : dim(start ? '写回中' : '不写');
  return kv(title, [['指令', view.text], ['状态', status]]);
}

function csrPanel(now: CsrFile, before: CsrFile | null): KvWidget {
  const row = (key: keyof CsrFile, text: string): [string, CellLike] => [key, before && before[key] !== now[key] ? on(text, 'violet') : text];
  return kv('CSR', [
    row('mstatus', mstatusShort(now.mstatus)),
    row('mtvec', hx(now.mtvec)),
    row('mepc', hx(now.mepc)),
    row('mcause', now.mcause ? causeText(now.mcause) : '0'),
    row('mtval', hx(now.mtval)),
  ]);
}

const INITIAL_CSRS: CsrFile = { mstatus: MSTATUS.MIE | MSTATUS.MPP, mie: 0, mtvec: 0, mscratch: 0, mepc: 0, mcause: 0, mtval: 0, mip: 0 };

/** 被检查的内存字在第 cycle 拍结束时的值。 */
function memoryWord(run: Run, cycle: number): number {
  let value = 0;
  for (const s of run.result.cycles.slice(0, cycle)) if (s.mem?.write && s.mem.address === run.word) value = s.mem.value;
  return value;
}

function regsPanel(run: Run, cycle: number, highlight: boolean): KvWidget {
  const s = cycle > 0 ? snap(run, cycle) : null;
  const regs = s?.regs ?? new Array(32).fill(0);
  const rows: Array<[string, CellLike]> = run.regs.map((reg) => [`x${reg}`, highlight && s?.wb?.rd === reg ? on(hx(regs[reg]), 'green') : hx(regs[reg])]);
  if (run.word !== undefined) {
    const value = memoryWord(run, cycle);
    rows.push([`[${hx(run.word).replace(/^0x0+/, '0x')}]`, highlight && s?.mem?.write && s.mem.address === run.word ? on(hx(value), 'green') : hx(value)]);
  }
  return kv(run.word !== undefined ? '寄存器和内存' : '寄存器', rows);
}

const pcPanel = (pc: number | null) => kv('PC', [['下一拍取指', pc === null ? dim('—') : cell(hx(pc), 'blue')]]);

/** 一拍的全部面板。start 时 CSR、寄存器和 PC 还是上一拍结束时的值。 */
function frame(run: Run, cycle: number, start: boolean, table: PanelContent): Record<string, PanelContent> {
  const s = snap(run, cycle);
  const previous = cycle > 1 ? snap(run, cycle - 1) : null;
  const stages: Record<string, PanelContent> = {};
  for (const stage of ORDER) stages[STAGE_NODES[stage]] = stagePanel(s, stage, start);
  const csrNow = start ? previous?.csrs ?? INITIAL_CSRS : s.csrs;
  const csrBefore = start ? null : previous?.csrs ?? INITIAL_CSRS;
  return {
    ...stages,
    csr: csrPanel(csrNow, csrBefore),
    regs: regsPanel(run, start ? cycle - 1 : cycle, !start),
    pc: pcPanel(start ? previous?.pc ?? 0 : s.pc),
    table,
  };
}

const win = (run: Run, upTo: number, first: number, last: number) => gantt(run.result, upTo, { first, last, title: `流水线图（${run.label}）`, textWidth: 110, cellWidth: 28, maxRows: 9 });
const tableA = (cycle: number) => (cycle <= TRAP.cycle ? win(A, cycle, 1, TRAP.cycle + 1) : cycle <= WRITE_EPC.cycle ? win(A, cycle, TRAP.cycle + 1, TRAP.cycle + 11) : win(A, cycle, LAST_A - 10, LAST_A));
const tableB = (cycle: number) => win(B, cycle, 1, 11);

function trapSummary(count: number): PanelContent {
  return grid(`按程序顺序陷入（${RUN_B}）`, [['次', 26], ['指令', 104], ['发现', 70], ['陷入', 50], ['mcause', 50], ['mtval', 86]], runB.traps.map((t, index): CellLike[] => (index < count
    ? [String(index + 1), cell(t.text, 'amber'), `${t.detected.stage} 第 ${t.detected.cycle} 拍`, `第 ${t.cycle} 拍`, on(String(t.cause), 'red'), hx(t.tval)]
    : [String(index + 1), dim('·'), dim('·'), dim('·'), dim('·'), dim('·')])));
}

// ---------- 事件 ----------

/** 这一拍开始时，每条指令向下一级移动。 */
function moves(run: Run, s: CycleSnapshot): PacketEvent[] {
  const list: PacketEvent[] = [];
  for (let index = ORDER.length - 1; index >= 1; index--) {
    const stage = ORDER[index] as 'ID' | 'EX' | 'MEM' | 'WB';
    const view = s.stages[stage];
    if (!view) continue;
    const marked = view.cause !== undefined && !justDetected(s, view.seq);
    const extra = marked ? '' : stage === 'EX' && s.ex && !isCsrOp(decode(view.word).name) ? `，Y = ${hx(s.ex.result)}` : stage === 'MEM' && s.csr ? `，${s.csr.write ? '写' : '读'} ${s.csr.name}` : stage === 'MEM' && s.mem ? `，${s.mem.write ? '写' : '读'}内存 [${hx(s.mem.address)}]` : stage === 'WB' && s.wb ? `，写回 x${s.wb.rd} = ${hx(s.wb.value)}` : '';
    const info = marked ? `${view.text} 带着异常标记进入 ${stage} 级，什么也不做` : `${view.text} 进入 ${stage} 级${extra}`;
    const color = marked ? 'amber' : 'blue';
    const fields: Array<[string, string, string?]> = [['保存', LATCH_NOTE[stage]]];
    if (marked) fields.push(['异常标记', causeText(view.cause!), '控制信号已经清零，这条指令不会再改任何状态。']);
    list.push(pk(STAGE_NODES[ORDER[index - 1]], STAGE_NODES[stage], color, marked ? '带标记' : stage, [view.text], [s.cycle, TYPE[stage], info, 'reg', run.label],
      wire(`第 ${s.cycle} 拍的时钟沿：指令进入 ${stage} 级`, 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: marked ? 'amber' : 'blue' }), concept(`${ORDER[index - 1]}/${stage} 流水寄存器`, fields, color)), { quick: true }));
  }
  return list;
}

/** 完整的一拍：面板进入这一拍，指令移动，面板显示这一拍的结果。between 插在两者之间。 */
function beat(run: Run, cycle: number, table: (cycle: number) => PanelContent, hold = 600, between: LessonEvent[] = []): LessonEvent[] {
  const s = snap(run, cycle);
  const packets = moves(run, s);
  const out: LessonEvent[] = [probe(frame(run, cycle, true, table(cycle)), 250)];
  if (packets.length) out.push({ type: 'stream', packets, spacing: 60 } satisfies StreamEvent);
  out.push(...between, probe(frame(run, cycle, false, table(cycle)), hold));
  return out;
}

/** 只更新面板，不画移动，用在不需要细看的拍。 */
const glance = (run: Run, cycle: number, table: (cycle: number) => PanelContent, hold = 420): LessonEvent => probe(frame(run, cycle, false, table(cycle)), hold);

function csrEvent(run: Run, s: CycleSnapshot): LessonEvent {
  const access = s.csr!;
  const view = s.stages.MEM!;
  const name = access.name as 'mtvec' | 'mepc' | 'mcause';
  if (access.write) {
    return pk('smem', 'csr', 'violet', name, [view.text, `= ${hx(access.value)}`], [s.cycle, 'MEM', `${view.text} 在 MEM 级把 ${hx(access.value)} 写进 ${name}`, 'reg', run.label],
      wire('MEM 级写 CSR', 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: 'violet' }), csrLayer(name as 'mtvec' | 'mepc', access.value, { summary: `写入前 ${hx(access.old)}` })));
  }
  return pk('csr', 'smem', 'violet', name, [`${name} = ${hx(access.old)}`], [s.cycle, 'MEM', `${view.text} 在 MEM 级读出 ${name} = ${hx(access.old)}`, 'reg', run.label],
    wire('MEM 级读 CSR', 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: 'violet' }), csrLayer(name, access.old, { summary: `读出后写进 x${access.rd}` })));
}

function detectEvent(run: Run, s: CycleSnapshot): LessonEvent {
  const found = s.detected[0];
  const inId = found.stage === 'ID';
  const why = inId
    ? ['原因', causeText(found.cause), 'unimp 就是 csrrw x0, cycle, x0。csrrw 总要写 CSR，而 cycle 的地址 0xc00 最高两位是 11，只读。'] as [string, string, string]
    : ['原因', causeText(found.cause), `地址 ${hx(found.tval)} 不是 4 的倍数。规范允许硬件自己完成未对齐访问，也允许陷入，这个核选择陷入。`] as [string, string, string];
  return pk(inId ? 'sid' : 'smem', inId ? 'sex' : 'swb', 'amber', '标记', [CAUSE_TEXT[found.cause], `mcause = ${found.cause}`],
    [s.cycle, inId ? 'DECODE' : 'MEM', inId ? `${found.text} 在 ID 级被发现是非法指令，只打标记` : `${found.text} 的地址 ${hx(found.tval)} 没有对齐，在 MEM 级被发现，只打标记`, 'reg', run.label],
    wire(`${found.stage} 级的异常检测`, 'regs', 'spec', instructionLayer(found.word, { pc: found.pc, text: found.text, color: 'amber' }), concept('异常标记', [
      why,
      ['mtval', hx(found.tval), inId ? '非法指令时记下指令字。' : '地址未对齐时记下出错的地址。'],
      ['做法', '控制信号清零，标记写进流水寄存器', '先不陷入：比它老的指令还没写回，它们也可能出异常。'],
    ], 'amber')));
}

function flushEvents(run: Run, record: TrapRecord | ReturnRecord): LessonEvent[] {
  const s = snap(run, record.cycle);
  return record.flushed.map((view) => {
    const stage = ORDER.find((name) => s.stages[name]?.seq === view.seq)!;
    return pk(STAGE_NODES[stage], STAGE_NODES[NEXT[stage]], 'slate', '冲掉', [view.text], [record.cycle, 'FLUSH', `${view.text} 在 ${stage} 级被冲掉`, 4, run.label],
      wire(`第 ${record.cycle} 拍结束时冲刷`, 'mem', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: 'slate' }), concept('冲刷', [
        ['动作', '控制信号清零', stage === 'MEM' ? '它本来这一拍要访存。提交点先处理，所以它什么也没写成。' : '它还没改过任何状态，直接作废。'],
      ], 'slate')), { lost: true, quick: true });
  });
}

function trapEvents(run: Run, t: TrapRecord): LessonEvent[] {
  return [
    pk('swb', 'csr', 'amber', '陷入', [`mepc = ${hx(t.pc)}`, `mcause = ${t.cause}`, `mtval = ${hx(t.tval)}`], [t.cycle, 'CTRL', `${t.text} 在 WB 提交异常：写 mepc、mcause、mtval，关中断`, 'reg', run.label],
      wire('提交点：WB 级', 'regs', 'spec', csrLayer('mepc', t.pc), csrLayer('mcause', t.cause), csrLayer('mtval', t.tval), csrLayer('mstatus', t.mstatusAfter, { summary: `陷入前 ${mstatusText(t.mstatusBefore)}` }), trapLayer(t))),
    ...flushEvents(run, t),
    pk('csr', 'pc', 'amber', 'mtvec', [hx(t.target)], [t.cycle, 'CTRL', `PC 改成 mtvec 的 BASE：${hx(t.target)}`, 'reg', run.label],
      wire('跳到处理程序', 'regs', 'spec', csrLayer('mtvec', t.mtvec), registers('PC 改写', [['PC', t.target, '下一拍从这里取指。']], 'amber'))),
  ];
}

function returnEvents(run: Run, r: ReturnRecord): LessonEvent[] {
  const view = snap(run, r.cycle).stages.WB!;
  return [
    pk('swb', 'csr', 'amber', 'mret', ['读 mepc', hx(r.mepc)], [r.cycle, 'CTRL', 'mret 在 WB 提交：MIE 恢复，PC 取 mepc', 'reg', run.label],
      wire('提交点：mret', 'regs', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text, color: 'amber' }), csrLayer('mstatus', r.mstatusAfter, { summary: `返回前 ${mstatusText(r.mstatusBefore)}` }), concept('mret 的硬件动作', [
        ['PC ← mepc', hx(r.mepc)],
        ['mstatus', `${mstatusText(r.mstatusBefore)} → ${mstatusText(r.mstatusAfter)}`, 'MIE 取回 MPIE，MPIE 置 1，特权级回到 MPP。'],
      ], 'amber'))),
    ...flushEvents(run, r),
    pk('csr', 'pc', 'amber', 'mepc', [hx(r.mepc)], [r.cycle, 'CTRL', `PC 改成 mepc：${hx(r.mepc)}`, 'reg', run.label],
      wire('回到被打断的地方', 'regs', 'spec', csrLayer('mepc', r.mepc), registers('PC 改写', [['PC', r.mepc, '下一拍从这里取指。']], 'amber'))),
  ];
}

function fetchEvent(run: Run, cycle: number): LessonEvent {
  const view = snap(run, cycle).stages.IF!;
  return pk('pc', 'sif', 'blue', '取指', [hx(view.pc)], [cycle, 'FETCH', `从 ${hx(view.pc)} 取指：${view.text}`, 4, run.label],
    wire('取指', 'mem', 'spec', instructionLayer(view.word, { pc: view.pc, text: view.text })), { quick: true });
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
const UNIMP_TEXT = runA.instructions.find((item) => item.word === UNIMP_WORD)!.text;

export const exception: Lesson = {
  id: 'exception',
  name: 'EXCEPTION',
  title: '异常与陷入',
  group: 'cpu',
  layer: [4, 5],
  clock: 'cycle',
  nodes: ['sif', 'sid', 'sex', 'smem', 'swb', 'csr', 'pc'],
  place: { sif: [70, 150], sid: [255, 150], sex: [440, 150], smem: [625, 150], swb: [810, 150], csr: [620, 360], pc: [150, 380] },
  labels: {
    sif: ['IF', ''],
    sid: ['ID', '检测非法指令'],
    sex: ['EX', ''],
    smem: ['MEM', '读写 CSR、检测未对齐'],
    swb: ['WB', '提交点'],
    csr: ['CSR', '控制状态寄存器'],
    pc: ['PC', '下一拍取指的地址'],
  },
  panels: { sif: [0, 15], sid: [175, 15], sex: [360, 15], smem: [545, 15], swb: [730, 15], regs: [230, 238], csr: [700, 300], pc: [0, 462], table: [180, 465] },
  main: ['table'],
  strip: [['sif', 'sid', 'sex', 'smem', 'swb'], 'table', ['csr', 'regs', 'pc']],
  initial: {
    ...Object.fromEntries(ORDER.map((stage) => [STAGE_NODES[stage], kv(`${stage} 级`, [['指令', dim('空泡')], ['状态', dim('—')]])])),
    csr: csrPanel(INITIAL_CSRS, null),
    regs: regsPanel(A, 0, false),
    pc: pcPanel(null),
    table: tableA(0),
  },
  start: ['sif', 'sid', 'sex', 'smem', 'swb', 'csr'],
  legend: [['amber', '异常标记和陷入'], ['violet', 'CSR 读写'], ['slate', '被冲掉'], ['blue', '指令前进'], [null, '两次独立运行各自计周期']],
  overview: {
    full: '指令出错时，硬件停在准确的位置',
    description: `流水线里同时有 5 条指令，其中一条出错时，必须让它前面的全部完成、后面的一条也不生效，这叫精确异常。这一课在周期精确的流水线上跑真实的 RISC-V 程序：异常在 ID 或 MEM 级被发现后只打标记，跟着指令走到 WB 才陷入，硬件写 mepc、mcause、mtval，冲掉后面的指令，跳到 mtvec，处理完再用 mret 返回。`,
    facts: [
      ['提交点', 'WB 级'],
      ['陷入时写', 'mepc mcause mtval mstatus'],
      ['入口', 'mtvec（0x305）'],
      ['返回', 'mret'],
      ['例一', `unimp，${LAST_A} 拍`],
      ['例二', `两个异常，${LAST_B} 拍`],
    ],
  },
  steps: [
    {
      title: '陷入入口',
      desc: 'csrw 把处理程序的地址写进 mtvec',
      detail: `异常发生后跳到哪里，由 CSR（控制状态寄存器）mtvec 决定。程序先用 csrw mtvec, x5 写入处理程序的地址 ${hx(HANDLER_BASE)}；CSR 有自己的 12 位地址空间，mtvec 的地址是 0x${CSR.mtvec.toString(16)}。这条流水线在 MEM 级读写 CSR，所以第 ${MTVEC_WRITE.cycle} 拍才真正写进去。`,
      facts: [['mtvec 地址', `0x${CSR.mtvec.toString(16)}`], ['写入值', hx(HANDLER_BASE)], ['MODE', '00 直接模式'], ['CSR 读写', 'MEM 级']],
      events: [
        ...range(1, MTVEC_WRITE.cycle - 1).map((cycle) => glance(A, cycle, tableA, 450)),
        probe(frame(A, MTVEC_WRITE.cycle, true, tableA(MTVEC_WRITE.cycle)), 400),
        csrEvent(A, MTVEC_WRITE),
        probe({ csr: csrPanel(MTVEC_WRITE.csrs, snap(A, MTVEC_WRITE.cycle - 1).csrs) }, 600),
      ],
    },
    {
      title: '先打标记',
      desc: `第 ${DETECT.cycle} 拍：ID 级发现 ${UNIMP_TEXT} 非法，但不马上处理`,
      detail: `unimp 就是 csrrw x0, cycle, x0：cycle 的地址 0xc00 最高两位是 11，表示只读，写它就是非法指令。第 ${DETECT.cycle} 拍 ID 级发现了它，却不马上陷入，只把原因记进流水寄存器，并把这条指令的控制信号清零。比它老的 csrw 和 addi 还没写回，要等它们做完，异常才是「精确」的。`,
      facts: [['检测位置', `ID 级，第 ${DETECT.cycle} 拍`], ['mcause', causeText(TRAP.cause)], ['mtval', hx(TRAP.tval)], ['控制信号', '清零，不再改任何状态']],
      events: [
        detectEvent(A, DETECT),
        probe(frame(A, DETECT.cycle, false, tableA(DETECT.cycle)), 700),
        note('sid', '非法指令：先记下', 'amber'),
        ...beat(A, DETECT.cycle + 1, tableA, 700),
        ...beat(A, DETECT.cycle + 2, tableA, 700),
        note('swb', '比它老的 addi 照常写回', 'green'),
      ],
    },
    {
      title: '提交点',
      desc: `第 ${TRAP.cycle} 拍：在 WB 陷入，冲掉后面 ${TRAP.flushed.length} 条`,
      detail: `第 ${TRAP.cycle} 拍 unimp 到了 WB，比它老的指令都已提交，比它新的 ${TRAP.flushed.length} 条还在流水线里。硬件在这一拍把它的 PC 存进 mepc、原因写进 mcause、指令字写进 mtval，清掉 mstatus.MIE，同时冲掉 MEM、EX、ID、IF 四级。MEM 里的 sw 本来这一拍要写内存，被冲掉后内存没有变；下一拍 PC 改成 mtvec 里的 ${hx(TRAP.target)}。`,
      facts: [['mepc', hx(TRAP.pc)], ['mcause', causeText(TRAP.cause)], ['mtval', hx(TRAP.tval)], ['冲掉', `${TRAP.flushed.length} 条`], ['新 PC', hx(TRAP.target)]],
      events: [
        show('pc'),
        ...beat(A, TRAP.cycle, tableA, 600, trapEvents(A, TRAP)),
        note('smem', 'sw 没有写成', 'amber'),
      ],
    },
    {
      title: '处理程序',
      desc: '读 mcause 和 mepc，跳过出错的指令',
      detail: `处理程序用 csrr 读出 mcause 和 mepc，按原因决定怎么办；这里只是把 mepc 加 4，跳过这条非法指令。CSR 的值和 load 一样要到 MEM 级才读出，所以紧跟着用 x11 的 addi 在第 ${STALL.cycle} 拍停了 1 拍。真实的处理程序还要先保存用到的寄存器，返回前再恢复。`,
      facts: [['x10 = mcause', String(runA.regs[10])], ['x11 = mepc', hx(READ_EPC.csr!.old)], ['写回 mepc', hx(WRITE_EPC.csr!.value)], ['停顿', '1 拍']],
      events: [
        probe(frame(A, TRAP.cycle + 1, true, tableA(TRAP.cycle + 1)), 300),
        fetchEvent(A, TRAP.cycle + 1),
        probe(frame(A, TRAP.cycle + 1, false, tableA(TRAP.cycle + 1)), 500),
        ...range(TRAP.cycle + 2, READ_CAUSE.cycle - 1).map((cycle) => glance(A, cycle, tableA)),
        probe(frame(A, READ_CAUSE.cycle, true, tableA(READ_CAUSE.cycle)), 300),
        csrEvent(A, READ_CAUSE),
        probe(frame(A, READ_CAUSE.cycle, false, tableA(READ_CAUSE.cycle)), 600),
        note('sid', 'x11 要等 CSR 读出', 'amber'),
        probe(frame(A, READ_EPC.cycle, true, tableA(READ_EPC.cycle)), 300),
        csrEvent(A, READ_EPC),
        probe(frame(A, READ_EPC.cycle, false, tableA(READ_EPC.cycle)), 600),
        ...range(READ_EPC.cycle + 1, WRITE_EPC.cycle - 1).map((cycle) => glance(A, cycle, tableA)),
        probe(frame(A, WRITE_EPC.cycle, true, tableA(WRITE_EPC.cycle)), 300),
        csrEvent(A, WRITE_EPC),
        probe(frame(A, WRITE_EPC.cycle, false, tableA(WRITE_EPC.cycle)), 700),
      ],
    },
    {
      title: 'mret',
      desc: `回到 ${hx(RET.mepc)}，sw 这才写内存`,
      detail: `mret 也在 WB 提交：PC 改成 mepc 里的 ${hx(RET.mepc)}，MIE 恢复成陷入前的 1。被冲掉的 sw 和三条 addi 重新取指、重新执行，sw 到第 ${STORE.cycle} 拍才真正写内存。从程序看，unimp 之前的指令全部完成、之后的一条也没开始，这就是精确异常。`,
      facts: [['返回地址', hx(RET.mepc)], ['mstatus.MIE', `${(RET.mstatusBefore & MSTATUS.MIE) >>> 3} → ${(RET.mstatusAfter & MSTATUS.MIE) >>> 3}`], ['总周期', String(LAST_A)], ['提交的指令', `${runA.retired} 条`]],
      events: [
        ...range(WRITE_EPC.cycle + 1, RET.cycle - 1).map((cycle) => glance(A, cycle, tableA)),
        probe(frame(A, RET.cycle, true, tableA(RET.cycle)), 300),
        ...returnEvents(A, RET),
        probe(frame(A, RET.cycle, false, tableA(RET.cycle)), 600),
        probe(frame(A, RET.cycle + 1, true, tableA(RET.cycle + 1)), 300),
        fetchEvent(A, RET.cycle + 1),
        probe(frame(A, RET.cycle + 1, false, tableA(RET.cycle + 1)), 500),
        ...range(RET.cycle + 2, STORE.cycle).map((cycle) => glance(A, cycle, tableA)),
        note('smem', 'sw 这次写进内存', 'green'),
        ...range(STORE.cycle + 1, LAST_A).map((cycle) => glance(A, cycle, tableA, 300)),
        note('swb', `全部完成，共 ${LAST_A} 拍`, 'green'),
      ],
    },
    {
      title: '先来后到',
      desc: '后面的指令先出错，也要等前面的',
      detail: `换一段程序：lw x6, 2(x1) 的地址 ${hx(TRAP_B1.tval)} 不是 4 的倍数，第 ${DETECT_B_MEM.cycle} 拍在 MEM 级才发现；紧跟的 unimp 第 ${DETECT_B_ID.cycle} 拍在 ID 级就发现了。按时间 unimp 先出错，但标记都要等到 WB，lw 先到，所以先陷入的是 lw，mcause = ${TRAP_B1.cause}，mtval 是出错的地址。unimp 被冲掉，它的标记也作废，返回后重新执行时才第二次陷入。`,
      facts: [['先发现', `unimp，第 ${DETECT_B_ID.cycle} 拍 ID`], ['先陷入', `lw，第 ${TRAP_B1.cycle} 拍 WB`], ['第 1 次 mcause', causeText(TRAP_B1.cause)], ['第 2 次 mcause', causeText(TRAP_B2.cause)], ['未对齐访问', '规范允许陷入或由硬件完成']],
      events: [
        probe(frame(B, DETECT_B_ID.cycle, true, tableB(DETECT_B_ID.cycle)), 500),
        detectEvent(B, DETECT_B_ID),
        probe(frame(B, DETECT_B_ID.cycle, false, tableB(DETECT_B_ID.cycle)), 600),
        probe(frame(B, DETECT_B_MEM.cycle, true, tableB(DETECT_B_MEM.cycle)), 300),
        detectEvent(B, DETECT_B_MEM),
        probe(frame(B, DETECT_B_MEM.cycle, false, tableB(DETECT_B_MEM.cycle)), 700),
        ...beat(B, TRAP_B1.cycle, tableB, 900, trapEvents(B, TRAP_B1)),
        note('swb', '先陷入的是较老的 lw', 'amber'),
        probe(frame(B, TRAP_B2.cycle, true, trapSummary(1)), 600),
        ...trapEvents(B, TRAP_B2),
        probe(frame(B, TRAP_B2.cycle, false, trapSummary(2)), 900),
        probe(frame(B, LAST_B, false, trapSummary(2)), 800),
      ],
    },
  ],
  outro: {
    title: '只在一个点上收账',
    desc: '标记跟着指令走，到 WB 按顺序处理',
    text: '精确异常靠两件事：检测到的异常只打标记，跟着指令走到提交点；提交点按程序顺序处理，同时冲掉后面的指令。分支预测错时的冲刷用的也是同一套办法，只是冲得更少。处理器部分到这里结束，下一组课程看指令访问内存时发生的事。',
    facts: [['提交点', 'WB'], ['陷入时写', 'mepc mcause mtval'], ['返回', 'mret'], ['下一课', 'CACHE']],
  },
};
