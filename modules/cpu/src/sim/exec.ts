import { decode, OPCODE, type Decoded } from './riscv';

const u32 = (value: number) => value >>> 0;

export type AluOp = 'ADD' | 'SUB' | 'SLL' | 'SLT' | 'SLTU' | 'XOR' | 'SRL' | 'SRA' | 'OR' | 'AND' | 'MUL';

/** RV32I 的 ALU：输入输出都是无符号 32 位数的 number 表示。 */
export function alu(op: AluOp, a: number, b: number): number {
  const sa = a | 0;
  const sb = b | 0;
  const shamt = b & 31;
  switch (op) {
    case 'ADD':
      return u32(sa + sb);
    case 'SUB':
      return u32(sa - sb);
    case 'SLL':
      return u32(a << shamt);
    case 'SLT':
      return sa < sb ? 1 : 0;
    case 'SLTU':
      return u32(a) < u32(b) ? 1 : 0;
    case 'XOR':
      return u32(a ^ b);
    case 'SRL':
      return u32(a >>> shamt);
    case 'SRA':
      return u32(sa >> shamt);
    case 'OR':
      return u32(a | b);
    case 'AND':
      return u32(a & b);
    case 'MUL':
      return u32(Math.imul(a, b));
  }
}

const F3_ALU: AluOp[] = ['ADD', 'SLL', 'SLT', 'SLTU', 'XOR', 'SRL', 'OR', 'AND'];

/** 由 funct3 和 funct7 选 ALU 操作。 */
export function aluControl(d: Decoded): AluOp {
  if (d.opcode === OPCODE.BRANCH) return 'SUB';
  if (d.opcode === OPCODE.OP || d.opcode === OPCODE.OPIMM) {
    if (d.opcode === OPCODE.OP && d.funct7 === 0x01) return 'MUL';
    if (d.funct3 === 0 && d.opcode === OPCODE.OP && d.funct7 === 0x20) return 'SUB';
    if (d.funct3 === 5 && d.funct7 === 0x20) return 'SRA';
    return F3_ALU[d.funct3];
  }
  return 'ADD';
}

export interface Control {
  /** 写寄存器堆。 */
  regWrite: boolean;
  /** ALU 第二操作数取立即数。 */
  aluSrc: boolean;
  /** ALU 第一操作数：寄存器、PC 或 0（lui）。 */
  aluA: 'rs1' | 'pc' | 'zero';
  memRead: boolean;
  memWrite: boolean;
  /** 写回寄存器的数据来源。 */
  wbSrc: 'alu' | 'mem' | 'pc+4' | 'none';
  branch: boolean;
  jump: boolean;
  /** 主控制器给 ALU 控制器的 2 位编码，只是教科书约定，不是 ISA 的一部分。 */
  aluOp: number;
}

/** 主控制器：只看 opcode。这就是单周期 CPU 控制单元的真值表。 */
export function controlOf(d: Decoded): Control {
  const none: Control = { regWrite: false, aluSrc: false, aluA: 'rs1', memRead: false, memWrite: false, wbSrc: 'none', branch: false, jump: false, aluOp: 0 };
  switch (d.opcode) {
    case OPCODE.OP:
      return { ...none, regWrite: true, wbSrc: 'alu', aluOp: 0b10 };
    case OPCODE.OPIMM:
      return { ...none, regWrite: true, aluSrc: true, wbSrc: 'alu', aluOp: 0b11 };
    case OPCODE.LOAD:
      return { ...none, regWrite: true, aluSrc: true, memRead: true, wbSrc: 'mem' };
    case OPCODE.STORE:
      return { ...none, aluSrc: true, memWrite: true };
    case OPCODE.BRANCH:
      return { ...none, branch: true, aluOp: 0b01 };
    case OPCODE.JAL:
      return { ...none, regWrite: true, aluSrc: true, aluA: 'pc', wbSrc: 'pc+4', jump: true };
    case OPCODE.JALR:
      return { ...none, regWrite: true, aluSrc: true, wbSrc: 'pc+4', jump: true };
    case OPCODE.LUI:
      return { ...none, regWrite: true, aluSrc: true, aluA: 'zero', wbSrc: 'alu' };
    case OPCODE.AUIPC:
      return { ...none, regWrite: true, aluSrc: true, aluA: 'pc', wbSrc: 'alu' };
    default:
      return none;
  }
}

export function branchTaken(d: Decoded, a: number, b: number): boolean {
  const sa = a | 0;
  const sb = b | 0;
  switch (d.funct3) {
    case 0:
      return sa === sb;
    case 1:
      return sa !== sb;
    case 4:
      return sa < sb;
    case 5:
      return sa >= sb;
    case 6:
      return u32(a) < u32(b);
    case 7:
      return u32(a) >= u32(b);
    default:
      throw new Error(`未知分支 funct3：${d.funct3}`);
  }
}

/** 字节可寻址、小端的稀疏内存。没写过的字节读出 0。 */
export class Memory {
  bytes = new Map<number, number>();

  load8(address: number): number {
    return this.bytes.get(u32(address)) ?? 0;
  }

  store8(address: number, value: number): void {
    this.bytes.set(u32(address), value & 0xff);
  }

  loadWord(address: number): number {
    return u32(this.load8(address) | (this.load8(address + 1) << 8) | (this.load8(address + 2) << 16) | (this.load8(address + 3) << 24));
  }

  storeWord(address: number, value: number): void {
    for (let index = 0; index < 4; index++) this.store8(address + index, value >>> (index * 8));
  }

  clone(): Memory {
    const copy = new Memory();
    copy.bytes = new Map(this.bytes);
    return copy;
  }
}

/** 按 funct3 做真实的 load，含符号扩展。 */
export function memLoad(mem: Memory, d: Decoded, address: number): number {
  switch (d.funct3) {
    case 0:
      return u32((mem.load8(address) << 24) >> 24);
    case 1:
      return u32(((mem.load8(address) | (mem.load8(address + 1) << 8)) << 16) >> 16);
    case 2:
      return mem.loadWord(address);
    case 4:
      return mem.load8(address);
    case 5:
      return mem.load8(address) | (mem.load8(address + 1) << 8);
    default:
      throw new Error(`未知 load funct3：${d.funct3}`);
  }
}

export function memStore(mem: Memory, d: Decoded, address: number, value: number): void {
  const count = d.funct3 === 0 ? 1 : d.funct3 === 1 ? 2 : 4;
  for (let index = 0; index < count; index++) mem.store8(address + index, value >>> (index * 8));
}

export interface SingleCycleTrace {
  cycle: number;
  pc: number;
  word: number;
  d: Decoded;
  control: Control;
  op: AluOp;
  rs1Value: number;
  rs2Value: number;
  aluA: number;
  aluB: number;
  aluResult: number;
  zero: boolean;
  taken: boolean;
  memAddress: number | null;
  memValue: number | null;
  writeValue: number | null;
  nextPc: number;
}

/** 单周期 CPU：一拍做完一条指令。 */
export class SingleCycleCpu {
  regs = new Uint32Array(32);
  mem = new Memory();
  pc = 0;
  cycle = 0;
  private text = new Map<number, number>();

  constructor(program: number[], base = 0) {
    program.forEach((word, index) => this.text.set(base + index * 4, word));
    this.pc = base;
  }

  get running(): boolean {
    return this.text.has(this.pc);
  }

  step(): SingleCycleTrace {
    const pc = this.pc;
    const word = this.text.get(pc);
    if (word === undefined) throw new Error(`PC ${pc} 处没有指令`);
    const d = decode(word);
    const control = controlOf(d);
    const op = aluControl(d);
    const rs1Value = d.usesRs1 ? this.regs[d.rs1] : 0;
    const rs2Value = d.usesRs2 ? this.regs[d.rs2] : 0;
    const aluA = control.aluA === 'pc' ? pc : control.aluA === 'zero' ? 0 : rs1Value;
    const aluB = control.aluSrc ? u32(d.imm) : rs2Value;
    const aluResult = alu(op, aluA, aluB);
    const taken = control.branch && branchTaken(d, rs1Value, rs2Value);
    let nextPc = u32(pc + 4);
    if (taken) nextPc = u32(pc + d.imm);
    if (control.jump) nextPc = d.name === 'jalr' ? u32(aluResult & ~1) : aluResult;
    let memValue: number | null = null;
    let memAddress: number | null = null;
    if (control.memRead) {
      memAddress = aluResult;
      memValue = memLoad(this.mem, d, aluResult);
    }
    if (control.memWrite) {
      memAddress = aluResult;
      memValue = rs2Value;
      memStore(this.mem, d, aluResult, rs2Value);
    }
    let writeValue: number | null = null;
    if (control.regWrite) {
      writeValue = control.wbSrc === 'mem' ? memValue! : control.wbSrc === 'pc+4' ? u32(pc + 4) : aluResult;
      if (d.rd !== 0) this.regs[d.rd] = writeValue;
    }
    this.pc = nextPc;
    this.cycle += 1;
    return { cycle: this.cycle, pc, word, d, control, op, rs1Value, rs2Value, aluA, aluB, aluResult, zero: aluResult === 0, taken, memAddress, memValue, writeValue, nextPc };
  }

  run(limit = 100000): void {
    let guard = 0;
    while (this.running && guard++ < limit) this.step();
  }
}
