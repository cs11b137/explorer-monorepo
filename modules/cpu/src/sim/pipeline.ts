import { alu, aluControl, branchTaken, controlOf, memLoad, memStore, Memory, type AluOp, type Control } from './exec';
import { decode, disasm, OPCODE, type Decoded } from './riscv';
import type { DirectionPredictor } from './predictor';

const u32 = (value: number) => value >>> 0;

export type StageName = 'IF' | 'ID' | 'EX' | 'MEM' | 'WB';
export const STAGES: StageName[] = ['IF', 'ID', 'EX', 'MEM', 'WB'];

interface Slot {
  seq: number;
  pc: number;
  word: number;
  d: Decoded;
  text: string;
  control: Control;
  op: AluOp;
  /** 取指时预测的下一条地址，EX 级拿它和真实去向比较。 */
  predictedNext: number;
  predictedTaken: boolean;
  rs1Value: number;
  rs2Value: number;
  aluResult: number;
  storeValue: number;
  memData: number;
}

export interface StageView {
  seq: number;
  pc: number;
  text: string;
  word: number;
}

export type ForwardSource = 'MEM' | 'WB';

export interface Forward {
  port: 'A' | 'B';
  reg: number;
  value: number;
  from: ForwardSource;
  /** 产生这个值的指令。 */
  producer: string;
}

export interface BranchResolution {
  pc: number;
  text: string;
  taken: boolean;
  target: number;
  predictedTaken: boolean;
  mispredicted: boolean;
}

export interface CycleSnapshot {
  cycle: number;
  /** 这一拍里，每一级正在处理哪条指令。null 是空泡。 */
  stages: Record<StageName, StageView | null>;
  pc: number;
  stall: boolean;
  /** 这一拍结束时被冲掉的指令。 */
  flushed: StageView[];
  forwards: Forward[];
  ex: { op: AluOp; a: number; b: number; result: number } | null;
  /** ID 级读到的寄存器值。 */
  id: { rs1: number; rs1Value: number; rs2: number; rs2Value: number } | null;
  mem: { address: number; value: number; write: boolean } | null;
  wb: { rd: number; value: number } | null;
  branch: BranchResolution | null;
  /** 这一拍 WB 写完之后的寄存器堆。 */
  regs: number[];
  /** 这一拍结束时的流水寄存器。 */
  latches: { ifid: StageView | null; idex: StageView | null; exmem: StageView | null; memwb: StageView | null };
}

export interface PipelineOptions {
  forwarding?: boolean;
  /** 不给就是静态预测不跳。给了就在 IF 级预测，并用 BTB 记住跳转目标。 */
  predictor?: DirectionPredictor;
  base?: number;
  maxCycles?: number;
  initialRegs?: Partial<Record<number, number>>;
  memory?: Memory;
}

export interface PipelineResult {
  cycles: CycleSnapshot[];
  /** 真正走到 WB 的指令数。 */
  retired: number;
  stalls: number;
  flushes: number;
  mispredicts: number;
  branches: BranchResolution[];
  regs: number[];
  mem: Memory;
  /** 动态指令列表，按取指顺序，含被冲掉的。 */
  instructions: Array<StageView & { flushed: boolean; timeline: Record<number, StageName | 'STALL-ID' | 'STALL-IF'> }>;
  cpi: number;
}

const view = (slot: Slot | null): StageView | null => (slot ? { seq: slot.seq, pc: slot.pc, text: slot.text, word: slot.word } : null);
const writes = (slot: Slot | null, reg: number) => Boolean(slot && slot.control.regWrite && slot.d.rd !== 0 && slot.d.rd === reg);

/**
 * 周期精确的经典五级流水线。
 * 寄存器堆前半拍写、后半拍读；分支和跳转在 EX 解析，错了冲掉 IF、ID 两条；
 * 开前递时只有 load-use 要停 1 拍，关前递时写后读都要等到写回。
 */
export function runPipeline(program: number[], options: PipelineOptions = {}): PipelineResult {
  const { forwarding = true, predictor, base = 0, maxCycles = 100000, initialRegs = {}, memory } = options;
  const text = new Map<number, number>();
  program.forEach((word, index) => text.set(base + index * 4, word));
  const regs = new Uint32Array(32);
  for (const [reg, value] of Object.entries(initialRegs)) regs[Number(reg)] = u32(value ?? 0);
  const mem = memory ?? new Memory();
  const btb = new Map<number, number>();

  let pc = base;
  let ifid: Slot | null = null;
  let idex: Slot | null = null;
  let exmem: Slot | null = null;
  let memwb: Slot | null = null;
  let heldFetch: Slot | null = null;
  let seq = 0;
  let retired = 0;
  let stalls = 0;
  let flushes = 0;
  let mispredicts = 0;
  const cycles: CycleSnapshot[] = [];
  const branches: BranchResolution[] = [];
  const dynamic: PipelineResult['instructions'] = [];
  const mark = (slot: Slot | null, cycle: number, stage: StageName | 'STALL-ID' | 'STALL-IF') => {
    if (slot) dynamic[slot.seq].timeline[cycle] = stage;
  };

  function fetch(): Slot | null {
    const word = text.get(pc);
    if (word === undefined) return null;
    const d = decode(word);
    const control = controlOf(d);
    let predictedTaken = false;
    let predictedNext = u32(pc + 4);
    if (predictor && (control.branch || d.name === 'jal')) {
      const target = btb.get(pc);
      const direction = control.branch ? predictor.predict(pc) : true;
      if (target !== undefined && direction) {
        predictedTaken = true;
        predictedNext = target;
      }
    }
    const slot: Slot = {
      seq: seq++, pc, word, d, text: disasm(word), control, op: aluControl(d), predictedNext, predictedTaken,
      rs1Value: 0, rs2Value: 0, aluResult: 0, storeValue: 0, memData: 0,
    };
    dynamic.push({ seq: slot.seq, pc, text: slot.text, word, flushed: false, timeline: {} });
    return slot;
  }

  const done = () => !ifid && !idex && !exmem && !memwb && !heldFetch && !text.has(pc);

  for (let cycle = 1; !done(); cycle++) {
    if (cycle > maxCycles) throw new Error('流水线超过最大周期数');
    const stageWb = memwb;
    const stageMem = exmem;
    const stageEx = idex;
    const stageId = ifid;

    // WB：前半拍写寄存器。
    let wbInfo: CycleSnapshot['wb'] = null;
    if (stageWb) {
      retired++;
      if (stageWb.control.regWrite && stageWb.d.rd !== 0) {
        const value = stageWb.control.wbSrc === 'mem' ? stageWb.memData : stageWb.aluResult;
        regs[stageWb.d.rd] = value;
        wbInfo = { rd: stageWb.d.rd, value };
      }
    }
    const wbValue = stageWb ? (stageWb.control.wbSrc === 'mem' ? stageWb.memData : stageWb.aluResult) : 0;

    // MEM
    let memInfo: CycleSnapshot['mem'] = null;
    if (stageMem) {
      if (stageMem.control.memRead) {
        stageMem.memData = memLoad(mem, stageMem.d, stageMem.aluResult);
        memInfo = { address: stageMem.aluResult, value: stageMem.memData, write: false };
      } else if (stageMem.control.memWrite) {
        memStore(mem, stageMem.d, stageMem.aluResult, stageMem.storeValue);
        memInfo = { address: stageMem.aluResult, value: stageMem.storeValue, write: true };
      }
    }

    // EX：前递选择，优先取较新的 EX/MEM。
    const forwards: Forward[] = [];
    let exInfo: CycleSnapshot['ex'] = null;
    let redirect: number | null = null;
    let branchInfo: BranchResolution | null = null;
    if (stageEx) {
      const pick = (reg: number, read: number, port: 'A' | 'B', used: boolean): number => {
        if (!forwarding || !used || reg === 0) return read;
        if (writes(stageMem, reg) && stageMem!.control.wbSrc !== 'mem') {
          forwards.push({ port, reg, value: stageMem!.aluResult, from: 'MEM', producer: stageMem!.text });
          return stageMem!.aluResult;
        }
        if (writes(stageWb, reg)) {
          forwards.push({ port, reg, value: wbValue, from: 'WB', producer: stageWb!.text });
          return wbValue;
        }
        return read;
      };
      const { d, control } = stageEx;
      const rs1 = pick(d.rs1, stageEx.rs1Value, 'A', d.usesRs1);
      const rs2 = pick(d.rs2, stageEx.rs2Value, 'B', d.usesRs2);
      const a = control.aluA === 'pc' ? stageEx.pc : control.aluA === 'zero' ? 0 : rs1;
      const b = control.aluSrc ? u32(d.imm) : rs2;
      const result = alu(stageEx.op, a, b);
      stageEx.storeValue = rs2;
      stageEx.aluResult = control.jump ? u32(stageEx.pc + 4) : result;
      exInfo = { op: stageEx.op, a, b, result };
      if (control.branch || control.jump) {
        const taken = control.jump || branchTaken(d, rs1, rs2);
        const target = d.name === 'jalr' ? u32(result & ~1) : d.name === 'jal' ? result : u32(stageEx.pc + d.imm);
        const actualNext = taken ? target : u32(stageEx.pc + 4);
        const mispredicted = actualNext !== stageEx.predictedNext;
        if (control.branch) predictor?.update(stageEx.pc, taken);
        if (taken && d.opcode !== OPCODE.JALR) btb.set(stageEx.pc, target);
        branchInfo = { pc: stageEx.pc, text: stageEx.text, taken, target, predictedTaken: stageEx.predictedTaken, mispredicted };
        branches.push(branchInfo);
        if (mispredicted) {
          redirect = actualNext;
          mispredicts++;
        }
      }
    }

    // ID：冒险检测。寄存器堆在 WB 之后才读，所以同拍写回能被读到。
    let stall = false;
    let idInfo: CycleSnapshot['id'] = null;
    if (stageId) {
      const { d } = stageId;
      const needs = (reg: number) => (d.usesRs1 && d.rs1 === reg) || (d.usesRs2 && d.rs2 === reg);
      if (forwarding) stall = Boolean(stageEx && stageEx.control.memRead && stageEx.d.rd !== 0 && needs(stageEx.d.rd));
      else stall = Boolean((stageEx && stageEx.control.regWrite && stageEx.d.rd !== 0 && needs(stageEx.d.rd)) || (stageMem && stageMem.control.regWrite && stageMem.d.rd !== 0 && needs(stageMem.d.rd)));
      // 被 EX 的跳转冲掉时，这条指令根本不需要等。
      if (redirect !== null) stall = false;
      if (!stall) {
        stageId.rs1Value = d.usesRs1 ? regs[d.rs1] : 0;
        stageId.rs2Value = d.usesRs2 ? regs[d.rs2] : 0;
        idInfo = { rs1: d.rs1, rs1Value: stageId.rs1Value, rs2: d.rs2, rs2Value: stageId.rs2Value };
      }
    }

    // IF：停顿时 PC 不变，同一条指令再取一次。
    const stageIf: Slot | null = heldFetch ?? fetch();
    heldFetch = null;

    mark(stageIf, cycle, stall ? 'STALL-IF' : 'IF');
    mark(stageId, cycle, stall ? 'STALL-ID' : 'ID');
    mark(stageEx, cycle, 'EX');
    mark(stageMem, cycle, 'MEM');
    mark(stageWb, cycle, 'WB');

    const stages = { IF: view(stageIf), ID: view(stageId), EX: view(stageEx), MEM: view(stageMem), WB: view(stageWb) };
    const flushed: StageView[] = [];

    // 拍末更新流水寄存器。
    memwb = stageMem;
    exmem = stageEx;
    if (redirect !== null) {
      for (const slot of [stageId, stageIf]) {
        if (slot) {
          flushed.push(view(slot)!);
          dynamic[slot.seq].flushed = true;
          flushes++;
        }
      }
      idex = null;
      ifid = null;
      pc = redirect;
    } else if (stall) {
      stalls++;
      idex = null;
      heldFetch = stageIf;
      // ifid 保持不变
    } else {
      idex = stageId;
      ifid = stageIf;
      if (stageIf) pc = stageIf.predictedNext;
    }

    cycles.push({
      cycle,
      stages,
      pc,
      stall,
      flushed,
      forwards,
      ex: exInfo,
      id: idInfo,
      mem: memInfo,
      wb: wbInfo,
      branch: branchInfo,
      regs: [...regs],
      latches: { ifid: view(ifid), idex: view(idex), exmem: view(exmem), memwb: view(memwb) },
    });
  }

  return {
    cycles,
    retired,
    stalls,
    flushes,
    mispredicts,
    branches,
    regs: [...regs],
    mem,
    instructions: dynamic,
    cpi: retired ? cycles.length / retired : 0,
  };
}

/** 把结果变成每条指令一行的文本，方便测试和经典流水线图对照。 */
export function ganttText(result: PipelineResult): string[] {
  const total = result.cycles.length;
  return result.instructions.map((item) => {
    const cells: string[] = [];
    for (let cycle = 1; cycle <= total; cycle++) {
      const stage = item.timeline[cycle];
      if (!stage) cells.push('.');
      else if (stage === 'STALL-ID' || stage === 'STALL-IF') cells.push('s');
      else cells.push(stage);
    }
    return `${item.text}${item.flushed ? ' !' : ''}: ${cells.join(' ').replace(/( \.)+$/, '')}`;
  });
}
