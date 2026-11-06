import { alu, aluControl, branchTaken, controlOf, memLoad, memStore, Memory, type AluOp, type Control } from './exec';
import { CSR, csrName, decode, disasm, isCsrKnown, isCsrOp, isCsrReadOnly, OPCODE, type Decoded } from './riscv';
import type { DirectionPredictor } from './predictor';

const u32 = (value: number) => value >>> 0;

export type StageName = 'IF' | 'ID' | 'EX' | 'MEM' | 'WB';
export const STAGES: StageName[] = ['IF', 'ID', 'EX', 'MEM', 'WB'];

/** RISC-V 特权规范里 mcause 的异常编码。最高位是 0，表示同步异常，不是中断。 */
export const CAUSE = {
  ILLEGAL_INSTRUCTION: 2,
  BREAKPOINT: 3,
  LOAD_MISALIGNED: 4,
  STORE_MISALIGNED: 6,
  ECALL_M: 11,
} as const;

export const CAUSE_TEXT: Record<number, string> = {
  0: '指令地址未对齐',
  1: '取指访问错误',
  2: '非法指令',
  3: '断点',
  4: 'load 地址未对齐',
  5: 'load 访问错误',
  6: 'store 地址未对齐',
  7: 'store 访问错误',
  8: 'U 模式 ecall',
  9: 'S 模式 ecall',
  11: 'M 模式 ecall',
};

/** mstatus 里和陷入有关的位。这个教学核只有 M 模式，所以 MPP 恒为 11。 */
export const MSTATUS = { MIE: 1 << 3, MPIE: 1 << 7, MPP: 3 << 11 } as const;

/** 流水线里建模的可写 CSR。其余已知的 CSR 读出计数值或常数，写入被忽略。 */
export interface CsrFile {
  mstatus: number;
  mie: number;
  mtvec: number;
  mscratch: number;
  mepc: number;
  mcause: number;
  mtval: number;
  mip: number;
}

const CSR_FILE_KEYS: Array<keyof CsrFile> = ['mstatus', 'mie', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'mip'];
const csrKey = (number: number): keyof CsrFile | null => (CSR_FILE_KEYS as string[]).includes(csrName(number)) ? (csrName(number) as keyof CsrFile) : null;
/** misa：MXL = 1（32 位），带 I 和 M 两个扩展。 */
const MISA = 0x40001100;

export interface ExceptionMark {
  cause: number;
  tval: number;
  /** 在哪一级、哪一拍检测到。 */
  stage: 'ID' | 'MEM';
  cycle: number;
}

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
  /** CSR 指令在 EX 级拿到的 rs1（可能来自前递），MEM 级用它写 CSR。 */
  csrOperand: number;
  /** 取指时无法解码的指令字。 */
  undecodable: boolean;
  /** 检测到的异常。带着它的指令不再产生任何副作用，到 WB 才处理。 */
  trap: ExceptionMark | null;
}

export interface StageView {
  seq: number;
  pc: number;
  text: string;
  word: number;
  /** 已经带上异常标记时，异常的 mcause。 */
  cause?: number;
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

/** WB 级提交一个异常：写 mepc、mcause、mtval，改 mstatus，冲掉后面所有指令，PC 改成 mtvec。 */
export interface TrapRecord {
  cycle: number;
  seq: number;
  pc: number;
  text: string;
  word: number;
  cause: number;
  tval: number;
  detected: { stage: 'ID' | 'MEM'; cycle: number };
  mtvec: number;
  /** 跳去的地址：mtvec 的 BASE。同步异常不管 MODE 是什么都跳 BASE。 */
  target: number;
  mstatusBefore: number;
  mstatusAfter: number;
  flushed: StageView[];
}

/** mret 在 WB 级提交：PC 改成 mepc，mstatus.MIE 恢复成 MPIE。 */
export interface ReturnRecord {
  cycle: number;
  seq: number;
  pc: number;
  text: string;
  mepc: number;
  mstatusBefore: number;
  mstatusAfter: number;
  flushed: StageView[];
}

/** CSR 指令在 MEM 级读写 CSR。 */
export interface CsrAccess {
  seq: number;
  pc: number;
  text: string;
  csr: number;
  name: string;
  /** 读出的旧值，写进 rd。 */
  old: number;
  value: number;
  write: boolean;
  rd: number;
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
  /** 这一拍新检测到的异常，只在打开 exceptions 时出现。 */
  detected: Array<StageView & ExceptionMark>;
  trap: TrapRecord | null;
  mret: ReturnRecord | null;
  csr: CsrAccess | null;
  /** 这一拍结束时的 CSR。 */
  csrs: CsrFile;
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
  /**
   * 打开精确异常：非法指令、ecall、ebreak 在 ID 检测，load/store 地址未对齐在 MEM 检测，
   * 检测到只打标记，到 WB 才处理。不打开时行为和以前一样：未对齐访问照常完成，无法解码的字直接报错。
   */
  exceptions?: boolean;
  /** 额外的代码段，比如放在 mtvec 处的异常处理程序。 */
  sections?: Array<{ base: number; words: number[] }>;
  /** CSR 初值。mstatus 默认 0x1800（MPP = 11，MIE = 0）。 */
  csrs?: Partial<CsrFile>;
}

export interface PipelineResult {
  cycles: CycleSnapshot[];
  /** 真正走到 WB 并提交的指令数，不含陷入的指令。 */
  retired: number;
  stalls: number;
  flushes: number;
  mispredicts: number;
  branches: BranchResolution[];
  regs: number[];
  mem: Memory;
  traps: TrapRecord[];
  returns: ReturnRecord[];
  csrs: CsrFile;
  /** 动态指令列表，按取指顺序，含被冲掉的。exception 是这条指令带上的异常。 */
  instructions: Array<StageView & { flushed: boolean; exception: ExceptionMark | null; timeline: Record<number, StageName | 'STALL-ID' | 'STALL-IF'> }>;
  cpi: number;
}

const view = (slot: Slot | null): StageView | null => (slot ? { seq: slot.seq, pc: slot.pc, text: slot.text, word: slot.word, ...(slot.trap ? { cause: slot.trap.cause } : {}) } : null);
const writes = (slot: Slot | null, reg: number) => Boolean(slot && slot.control.regWrite && slot.d.rd !== 0 && slot.d.rd === reg);
/** load 和 CSR 指令的结果要到 MEM 级结束才有，不能从 EX/MEM 前递。 */
const late = (slot: Slot) => slot.control.wbSrc === 'mem' || slot.control.wbSrc === 'csr';
const NONE: Control = { regWrite: false, aluSrc: false, aluA: 'rs1', memRead: false, memWrite: false, wbSrc: 'none', branch: false, jump: false, aluOp: 0 };

/** 无法解码的字：只留下指令字，其余字段为 0，不读写任何寄存器。 */
const undecodable = (word: number): Decoded => ({
  word: u32(word), name: '', format: 'I', opcode: word & 0x7f, rd: 0, funct3: 0, rs1: 0, rs2: 0, funct7: 0, imm: 0, usesRs1: false, usesRs2: false, writesRd: false,
});

/** ID 级能发现的异常：非法指令（无法解码、CSR 不存在、写只读 CSR）、ecall、ebreak。 */
function decodeException(slot: Slot): { cause: number; tval: number } | null {
  const { d } = slot;
  if (slot.undecodable) return { cause: CAUSE.ILLEGAL_INSTRUCTION, tval: slot.word };
  if (isCsrOp(d.name)) {
    const writesCsr = d.name === 'csrrw' || d.rs1 !== 0;
    if (!isCsrKnown(d.imm) || (writesCsr && isCsrReadOnly(d.imm))) return { cause: CAUSE.ILLEGAL_INSTRUCTION, tval: slot.word };
  }
  if (d.name === 'ecall') return { cause: CAUSE.ECALL_M, tval: 0 };
  if (d.name === 'ebreak') return { cause: CAUSE.BREAKPOINT, tval: slot.pc };
  return null;
}

/**
 * 周期精确的经典五级流水线。
 * 寄存器堆前半拍写、后半拍读；分支和跳转在 EX 解析，错了冲掉 IF、ID 两条；
 * 开前递时只有 load-use（以及 CSR 读出后紧跟使用）要停 1 拍，关前递时写后读都要等到写回。
 * CSR 指令在 MEM 级读写 CSR；异常和 mret 都在 WB 提交，冲掉后面全部 4 级。
 */
export function runPipeline(program: number[], options: PipelineOptions = {}): PipelineResult {
  const { forwarding = true, predictor, base = 0, maxCycles = 100000, initialRegs = {}, memory, exceptions = false, sections = [] } = options;
  const text = new Map<number, number>();
  program.forEach((word, index) => text.set(base + index * 4, word));
  for (const section of sections) section.words.forEach((word, index) => text.set(section.base + index * 4, word));
  const regs = new Uint32Array(32);
  for (const [reg, value] of Object.entries(initialRegs)) regs[Number(reg)] = u32(value ?? 0);
  const mem = memory ?? new Memory();
  const btb = new Map<number, number>();
  const csrs: CsrFile = { mstatus: 0, mie: 0, mtvec: 0, mscratch: 0, mepc: 0, mcause: 0, mtval: 0, mip: 0, ...options.csrs };
  csrs.mstatus = (csrs.mstatus & (MSTATUS.MIE | MSTATUS.MPIE)) | MSTATUS.MPP;

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
  let cycle = 0;
  const cycles: CycleSnapshot[] = [];
  const branches: BranchResolution[] = [];
  const traps: TrapRecord[] = [];
  const returns: ReturnRecord[] = [];
  const dynamic: PipelineResult['instructions'] = [];
  const mark = (slot: Slot | null, at: number, stage: StageName | 'STALL-ID' | 'STALL-IF') => {
    if (slot) dynamic[slot.seq].timeline[at] = stage;
  };

  function readCsr(number: number): number {
    const key = csrKey(number);
    if (key) return csrs[key];
    if (number === CSR.misa) return MISA;
    if (number === CSR.cycle || number === CSR.mcycle || number === CSR.time) return cycle;
    if (number === CSR.instret || number === CSR.minstret) return retired;
    return 0;
  }

  function writeCsr(number: number, value: number): void {
    const key = csrKey(number);
    if (!key) return;
    if (key === 'mstatus') csrs.mstatus = (value & (MSTATUS.MIE | MSTATUS.MPIE)) | MSTATUS.MPP;
    else if (key === 'mepc') csrs.mepc = u32(value & ~3);
    else csrs[key] = u32(value);
  }

  function fetch(): Slot | null {
    const word = text.get(pc);
    if (word === undefined) return null;
    let d: Decoded;
    let bad = false;
    try {
      d = decode(word);
    } catch (error) {
      if (!exceptions) throw error;
      d = undecodable(word);
      bad = true;
    }
    let control = bad ? NONE : controlOf(d);
    if (isCsrOp(d.name)) control = { ...NONE, regWrite: true, wbSrc: 'csr' };
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
      seq: seq++, pc, word, d, text: bad ? `.word 0x${u32(word).toString(16).padStart(8, '0')}` : disasm(word), control, op: aluControl(d), predictedNext, predictedTaken,
      rs1Value: 0, rs2Value: 0, aluResult: 0, storeValue: 0, memData: 0, csrOperand: 0, undecodable: bad, trap: null,
    };
    dynamic.push({ seq: slot.seq, pc, text: slot.text, word, flushed: false, exception: null, timeline: {} });
    return slot;
  }

  const done = () => !ifid && !idex && !exmem && !memwb && !heldFetch && !text.has(pc);
  const resultOf = (slot: Slot) => (late(slot) ? slot.memData : slot.aluResult);

  for (cycle = 1; !done(); cycle++) {
    if (cycle > maxCycles) throw new Error('流水线超过最大周期数');
    const stageWb = memwb;
    const stageMem = exmem;
    const stageEx = idex;
    const stageId = ifid;
    const detected: CycleSnapshot['detected'] = [];
    /** 检测到异常：记下原因，控制信号清零，这条指令从此不再改任何状态。 */
    const raise = (slot: Slot, stage: 'ID' | 'MEM', found: { cause: number; tval: number }) => {
      slot.trap = { cause: found.cause, tval: u32(found.tval), stage, cycle };
      slot.control = NONE;
      dynamic[slot.seq].exception = slot.trap;
      detected.push({ ...view(slot)!, ...slot.trap });
    };

    // WB 是提交点：带异常标记的指令在这里陷入，mret 在这里返回，两者都冲掉后面的全部指令。
    // 寄存器堆前半拍写。
    let wbInfo: CycleSnapshot['wb'] = null;
    let trapInfo: TrapRecord | null = null;
    let mretInfo: ReturnRecord | null = null;
    let commitTarget: number | null = null;
    if (stageWb?.trap) {
      const before = csrs.mstatus;
      csrs.mepc = u32(stageWb.pc);
      csrs.mcause = stageWb.trap.cause;
      csrs.mtval = stageWb.trap.tval;
      // 陷入时关中断：MPIE 记住原来的 MIE，MIE 清零；MPP 记下原来的特权级，这里一直是 M。
      csrs.mstatus = (before & MSTATUS.MIE ? MSTATUS.MPIE : 0) | MSTATUS.MPP;
      commitTarget = u32(csrs.mtvec & ~3);
      trapInfo = {
        cycle, seq: stageWb.seq, pc: stageWb.pc, text: stageWb.text, word: stageWb.word, cause: stageWb.trap.cause, tval: stageWb.trap.tval,
        detected: { stage: stageWb.trap.stage, cycle: stageWb.trap.cycle }, mtvec: csrs.mtvec, target: commitTarget, mstatusBefore: before, mstatusAfter: csrs.mstatus, flushed: [],
      };
      traps.push(trapInfo);
    } else if (stageWb) {
      retired++;
      if (stageWb.control.regWrite && stageWb.d.rd !== 0) {
        const value = resultOf(stageWb);
        regs[stageWb.d.rd] = value;
        wbInfo = { rd: stageWb.d.rd, value };
      }
      if (stageWb.d.name === 'mret') {
        const before = csrs.mstatus;
        // MIE 恢复成 MPIE，MPIE 置 1，特权级回到 MPP。
        csrs.mstatus = (before & MSTATUS.MPIE ? MSTATUS.MIE : 0) | MSTATUS.MPIE | MSTATUS.MPP;
        commitTarget = csrs.mepc;
        mretInfo = { cycle, seq: stageWb.seq, pc: stageWb.pc, text: stageWb.text, mepc: csrs.mepc, mstatusBefore: before, mstatusAfter: csrs.mstatus, flushed: [] };
        returns.push(mretInfo);
      }
    }
    const wbValue = stageWb ? resultOf(stageWb) : 0;
    const committing = commitTarget !== null;

    // MEM。提交点要冲刷时，后面的指令都不能再改状态。
    let memInfo: CycleSnapshot['mem'] = null;
    let csrInfo: CsrAccess | null = null;
    if (stageMem && !committing) {
      const access = stageMem.control.memRead || stageMem.control.memWrite;
      const size = 1 << (stageMem.d.funct3 & 3);
      if (access && exceptions && stageMem.aluResult % size !== 0) {
        raise(stageMem, 'MEM', { cause: stageMem.control.memRead ? CAUSE.LOAD_MISALIGNED : CAUSE.STORE_MISALIGNED, tval: stageMem.aluResult });
      } else if (stageMem.control.memRead) {
        stageMem.memData = memLoad(mem, stageMem.d, stageMem.aluResult);
        memInfo = { address: stageMem.aluResult, value: stageMem.memData, write: false };
      } else if (stageMem.control.memWrite) {
        memStore(mem, stageMem.d, stageMem.aluResult, stageMem.storeValue);
        memInfo = { address: stageMem.aluResult, value: stageMem.storeValue, write: true };
      } else if (isCsrOp(stageMem.d.name) && !stageMem.trap) {
        // CSR 在 MEM 级按程序顺序读写：比它老的异常已经在 WB 提交，比它新的指令还没开始改状态。
        const { d } = stageMem;
        const old = readCsr(d.imm);
        const operand = stageMem.csrOperand;
        const value = u32(d.name === 'csrrw' ? operand : d.name === 'csrrs' ? old | operand : old & ~operand);
        const write = d.name === 'csrrw' || d.rs1 !== 0;
        if (write) writeCsr(d.imm, value);
        stageMem.memData = old;
        csrInfo = { seq: stageMem.seq, pc: stageMem.pc, text: stageMem.text, csr: d.imm, name: csrName(d.imm), old, value, write, rd: d.rd };
      }
    }

    // EX：前递选择，优先取较新的 EX/MEM。
    const forwards: Forward[] = [];
    let exInfo: CycleSnapshot['ex'] = null;
    let redirect: number | null = null;
    let branchInfo: BranchResolution | null = null;
    if (stageEx && !committing) {
      const pick = (reg: number, read: number, port: 'A' | 'B', used: boolean): number => {
        if (!forwarding || !used || reg === 0) return read;
        if (writes(stageMem, reg) && !late(stageMem!)) {
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
      stageEx.csrOperand = rs1;
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
    if (stageId && !committing) {
      const { d } = stageId;
      const needs = (reg: number) => (d.usesRs1 && d.rs1 === reg) || (d.usesRs2 && d.rs2 === reg);
      if (forwarding) stall = Boolean(stageEx && late(stageEx) && stageEx.control.regWrite && stageEx.d.rd !== 0 && needs(stageEx.d.rd));
      else stall = Boolean((stageEx && stageEx.control.regWrite && stageEx.d.rd !== 0 && needs(stageEx.d.rd)) || (stageMem && stageMem.control.regWrite && stageMem.d.rd !== 0 && needs(stageMem.d.rd)));
      // 被 EX 的跳转冲掉时，这条指令根本不需要等。
      if (redirect !== null) stall = false;
      if (!stall) {
        stageId.rs1Value = d.usesRs1 ? regs[d.rs1] : 0;
        stageId.rs2Value = d.usesRs2 ? regs[d.rs2] : 0;
        idInfo = { rs1: d.rs1, rs1Value: stageId.rs1Value, rs2: d.rs2, rs2Value: stageId.rs2Value };
        // 译码时发现的异常只打标记，指令照常往后走，到 WB 再处理。
        const found = exceptions && redirect === null ? decodeException(stageId) : null;
        if (found) raise(stageId, 'ID', found);
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
    if (commitTarget !== null) {
      // 提交点冲刷：MEM、EX、ID、IF 里的指令都比提交的这条新，全部作废。
      for (const slot of [stageMem, stageEx, stageId, stageIf]) {
        if (slot) {
          flushed.push(view(slot)!);
          dynamic[slot.seq].flushed = true;
          flushes++;
        }
      }
      (trapInfo ?? mretInfo)!.flushed = flushed;
      memwb = null;
      exmem = null;
      idex = null;
      ifid = null;
      pc = commitTarget;
    } else if (redirect !== null) {
      memwb = stageMem;
      exmem = stageEx;
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
      memwb = stageMem;
      exmem = stageEx;
      stalls++;
      idex = null;
      heldFetch = stageIf;
      // ifid 保持不变
    } else {
      memwb = stageMem;
      exmem = stageEx;
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
      detected,
      trap: trapInfo,
      mret: mretInfo,
      csr: csrInfo,
      csrs: { ...csrs },
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
    traps,
    returns,
    csrs: { ...csrs },
    instructions: dynamic,
    cpi: retired ? cycles.length / retired : 0,
  };
}

/** 把结果变成每条指令一行的文本，方便测试和经典流水线图对照。! 是被冲掉，# 是带着异常走到了 WB。 */
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
    const tags = `${item.flushed ? ' !' : ''}${item.exception && !item.flushed ? ' #' : ''}`;
    return `${item.text}${tags}: ${cells.join(' ').replace(/( \.)+$/, '')}`;
  });
}
