/**
 * RV32I（以及 ALU 课用到的 M 扩展 mul、异常课用到的 Zicsr 和 mret）的编码器、解码器、汇编器和反汇编器。
 * 位序按 RISC-V 非特权规范第 2 章；CSR 地址和 mret 的编码按特权规范。
 */
export type Format = 'R' | 'I' | 'S' | 'B' | 'U' | 'J';

export interface OpInfo {
  name: string;
  format: Format;
  opcode: number;
  funct3?: number;
  funct7?: number;
}

const op = (name: string, format: Format, opcode: number, funct3?: number, funct7?: number): OpInfo => ({ name, format, opcode, funct3, funct7 });

export const OPCODE = { LUI: 0x37, AUIPC: 0x17, JAL: 0x6f, JALR: 0x67, BRANCH: 0x63, LOAD: 0x03, STORE: 0x23, OPIMM: 0x13, OP: 0x33, SYSTEM: 0x73, FENCE: 0x0f } as const;

const LIST: OpInfo[] = [
  op('lui', 'U', OPCODE.LUI),
  op('auipc', 'U', OPCODE.AUIPC),
  op('jal', 'J', OPCODE.JAL),
  op('jalr', 'I', OPCODE.JALR, 0),
  op('beq', 'B', OPCODE.BRANCH, 0),
  op('bne', 'B', OPCODE.BRANCH, 1),
  op('blt', 'B', OPCODE.BRANCH, 4),
  op('bge', 'B', OPCODE.BRANCH, 5),
  op('bltu', 'B', OPCODE.BRANCH, 6),
  op('bgeu', 'B', OPCODE.BRANCH, 7),
  op('lb', 'I', OPCODE.LOAD, 0),
  op('lh', 'I', OPCODE.LOAD, 1),
  op('lw', 'I', OPCODE.LOAD, 2),
  op('lbu', 'I', OPCODE.LOAD, 4),
  op('lhu', 'I', OPCODE.LOAD, 5),
  op('sb', 'S', OPCODE.STORE, 0),
  op('sh', 'S', OPCODE.STORE, 1),
  op('sw', 'S', OPCODE.STORE, 2),
  op('addi', 'I', OPCODE.OPIMM, 0),
  op('slti', 'I', OPCODE.OPIMM, 2),
  op('sltiu', 'I', OPCODE.OPIMM, 3),
  op('xori', 'I', OPCODE.OPIMM, 4),
  op('ori', 'I', OPCODE.OPIMM, 6),
  op('andi', 'I', OPCODE.OPIMM, 7),
  op('slli', 'I', OPCODE.OPIMM, 1, 0x00),
  op('srli', 'I', OPCODE.OPIMM, 5, 0x00),
  op('srai', 'I', OPCODE.OPIMM, 5, 0x20),
  op('add', 'R', OPCODE.OP, 0, 0x00),
  op('sub', 'R', OPCODE.OP, 0, 0x20),
  op('sll', 'R', OPCODE.OP, 1, 0x00),
  op('slt', 'R', OPCODE.OP, 2, 0x00),
  op('sltu', 'R', OPCODE.OP, 3, 0x00),
  op('xor', 'R', OPCODE.OP, 4, 0x00),
  op('srl', 'R', OPCODE.OP, 5, 0x00),
  op('sra', 'R', OPCODE.OP, 5, 0x20),
  op('or', 'R', OPCODE.OP, 6, 0x00),
  op('and', 'R', OPCODE.OP, 7, 0x00),
  op('mul', 'R', OPCODE.OP, 0, 0x01),
  op('ecall', 'I', OPCODE.SYSTEM, 0),
  op('ebreak', 'I', OPCODE.SYSTEM, 0),
  op('mret', 'I', OPCODE.SYSTEM, 0),
  op('csrrw', 'I', OPCODE.SYSTEM, 1),
  op('csrrs', 'I', OPCODE.SYSTEM, 2),
  op('csrrc', 'I', OPCODE.SYSTEM, 3),
  op('fence', 'I', OPCODE.FENCE, 0),
];

export const OPS: Record<string, OpInfo> = Object.fromEntries(LIST.map((item) => [item.name, item]));
export const INSTRUCTION_NAMES = LIST.map((item) => item.name);

const SHIFT_IMM = new Set(['slli', 'srli', 'srai']);
const CSR_OPS = new Set(['csrrw', 'csrrs', 'csrrc']);

/** 特权规范里的 CSR 地址。地址 [11:10] = 11 的是只读寄存器，写它就是非法指令。 */
export const CSR = {
  mstatus: 0x300, misa: 0x301, mie: 0x304, mtvec: 0x305, mscratch: 0x340, mepc: 0x341, mcause: 0x342, mtval: 0x343, mip: 0x344,
  mcycle: 0xb00, minstret: 0xb02, cycle: 0xc00, time: 0xc01, instret: 0xc02, mhartid: 0xf14,
} as const;
export type CsrName = keyof typeof CSR;
const CSR_BY_NUMBER = new Map<number, CsrName>(Object.entries(CSR).map(([name, number]) => [number, name as CsrName]));
export const csrName = (number: number): string => CSR_BY_NUMBER.get(number) ?? `0x${number.toString(16)}`;
export const isCsrKnown = (number: number): boolean => CSR_BY_NUMBER.has(number);
/** 地址最高两位是 11 的 CSR 只读。 */
export const isCsrReadOnly = (number: number): boolean => ((number >>> 10) & 3) === 3;
export const isCsrOp = (name: string): boolean => CSR_OPS.has(name);

export const MRET_WORD = 0x30200073;
/** unimp 是 csrrw x0, cycle, x0：写只读的 cycle，所以一定是非法指令。LLVM 把它当作一条独立的指令。 */
export const UNIMP_WORD = 0xc0001073;
const u32 = (value: number) => value >>> 0;

function checkReg(reg: number): number {
  if (!Number.isInteger(reg) || reg < 0 || reg > 31) throw new Error(`寄存器编号越界：${reg}`);
  return reg;
}

function checkRange(value: number, lo: number, hi: number, what: string): void {
  if (!Number.isInteger(value) || value < lo || value > hi) throw new Error(`${what} 越界：${value}，范围 ${lo}..${hi}`);
}

export interface Operands {
  rd?: number;
  rs1?: number;
  rs2?: number;
  /** I/S/B/J 是有符号立即数本身；U 是写进 [31:12] 的 20 位值；移位指令是 shamt；CSR 指令是 12 位 CSR 地址。 */
  imm?: number;
}

/** 按规范把操作数拼成 32 位指令字。B/J 的立即数位序在这里打散。 */
export function encode(name: string, { rd = 0, rs1 = 0, rs2 = 0, imm = 0 }: Operands = {}): number {
  const info = OPS[name];
  if (!info) throw new Error(`未知指令：${name}`);
  checkReg(rd);
  checkReg(rs1);
  checkReg(rs2);
  const { opcode, funct3 = 0, funct7 = 0 } = info;
  if (name === 'ecall') return 0x00000073;
  if (name === 'ebreak') return 0x00100073;
  if (name === 'mret') return MRET_WORD;
  if (CSR_OPS.has(name)) {
    checkRange(imm, 0, 4095, 'CSR 地址');
    return u32((imm << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
  }
  switch (info.format) {
    case 'R':
      return u32((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    case 'I': {
      if (SHIFT_IMM.has(name)) {
        checkRange(imm, 0, 31, 'shamt');
        return u32((funct7 << 25) | (imm << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
      }
      checkRange(imm, -2048, 2047, 'I 型立即数');
      return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
    }
    case 'S': {
      checkRange(imm, -2048, 2047, 'S 型立即数');
      const v = imm & 0xfff;
      return u32((((v >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((v & 0x1f) << 7) | opcode);
    }
    case 'B': {
      checkRange(imm, -4096, 4094, 'B 型立即数');
      if (imm % 2) throw new Error(`B 型立即数必须是偶数：${imm}`);
      const v = imm & 0x1fff;
      const bit12 = (v >> 12) & 1;
      const bit11 = (v >> 11) & 1;
      const hi = (v >> 5) & 0x3f;
      const lo = (v >> 1) & 0xf;
      return u32((bit12 << 31) | (hi << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (lo << 8) | (bit11 << 7) | opcode);
    }
    case 'U':
      checkRange(imm, 0, 0xfffff, 'U 型立即数');
      return u32((imm << 12) | (rd << 7) | opcode);
    case 'J': {
      checkRange(imm, -1048576, 1048574, 'J 型立即数');
      if (imm % 2) throw new Error(`J 型立即数必须是偶数：${imm}`);
      const v = imm & 0x1fffff;
      const bit20 = (v >> 20) & 1;
      const hi = (v >> 12) & 0xff;
      const bit11 = (v >> 11) & 1;
      const lo = (v >> 1) & 0x3ff;
      return u32((bit20 << 31) | (lo << 21) | (bit11 << 20) | (hi << 12) | (rd << 7) | opcode);
    }
  }
}

const bits = (word: number, hi: number, lo: number) => (word >>> lo) & (2 ** (hi - lo + 1) - 1);
const signExtend = (value: number, width: number) => (value << (32 - width)) >> (32 - width);

export interface Decoded {
  word: number;
  name: string;
  format: Format;
  opcode: number;
  rd: number;
  funct3: number;
  rs1: number;
  rs2: number;
  funct7: number;
  /** 符号扩展后的立即数。U 型是已经左移 12 位的 32 位值；CSR 指令是无符号的 CSR 地址。 */
  imm: number;
  /** 这条指令是否真的用到 rs1 / rs2 / rd。 */
  usesRs1: boolean;
  usesRs2: boolean;
  writesRd: boolean;
}

export function decode(word: number): Decoded {
  const w = u32(word);
  const opcode = bits(w, 6, 0);
  const rd = bits(w, 11, 7);
  const funct3 = bits(w, 14, 12);
  const rs1 = bits(w, 19, 15);
  const rs2 = bits(w, 24, 20);
  const funct7 = bits(w, 31, 25);
  let name = '';
  let format: Format = 'I';
  const find = (test: (item: OpInfo) => boolean) => LIST.find(test);
  switch (opcode) {
    case OPCODE.LUI:
      name = 'lui';
      format = 'U';
      break;
    case OPCODE.AUIPC:
      name = 'auipc';
      format = 'U';
      break;
    case OPCODE.JAL:
      name = 'jal';
      format = 'J';
      break;
    case OPCODE.JALR:
      name = 'jalr';
      break;
    case OPCODE.BRANCH:
      name = find((item) => item.opcode === opcode && item.funct3 === funct3)?.name ?? '';
      format = 'B';
      break;
    case OPCODE.LOAD:
      name = find((item) => item.opcode === opcode && item.funct3 === funct3)?.name ?? '';
      break;
    case OPCODE.STORE:
      name = find((item) => item.opcode === opcode && item.funct3 === funct3)?.name ?? '';
      format = 'S';
      break;
    case OPCODE.OPIMM:
      if (funct3 === 1 || funct3 === 5) name = find((item) => item.opcode === opcode && item.funct3 === funct3 && item.funct7 === funct7)?.name ?? '';
      else name = find((item) => item.opcode === opcode && item.funct3 === funct3)?.name ?? '';
      break;
    case OPCODE.OP:
      name = find((item) => item.opcode === opcode && item.funct3 === funct3 && item.funct7 === funct7)?.name ?? '';
      format = 'R';
      break;
    case OPCODE.SYSTEM:
      if (w === 0x00000073) name = 'ecall';
      if (w === 0x00100073) name = 'ebreak';
      if (w === MRET_WORD) name = 'mret';
      if (funct3 >= 1 && funct3 <= 3) name = find((item) => item.opcode === opcode && item.funct3 === funct3)?.name ?? '';
      break;
    case OPCODE.FENCE:
      name = 'fence';
      break;
  }
  if (!name) throw new Error(`无法解码：0x${w.toString(16).padStart(8, '0')}`);
  let imm = 0;
  switch (format) {
    case 'I':
      imm = SHIFT_IMM.has(name) ? rs2 : CSR_OPS.has(name) ? bits(w, 31, 20) : signExtend(bits(w, 31, 20), 12);
      break;
    case 'S':
      imm = signExtend((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
      break;
    case 'B':
      imm = signExtend((bits(w, 31, 31) << 12) | (bits(w, 7, 7) << 11) | (bits(w, 30, 25) << 5) | (bits(w, 11, 8) << 1), 13);
      break;
    case 'U':
      imm = (w & 0xfffff000) | 0;
      break;
    case 'J':
      imm = signExtend((bits(w, 31, 31) << 20) | (bits(w, 19, 12) << 12) | (bits(w, 20, 20) << 11) | (bits(w, 30, 21) << 1), 21);
      break;
  }
  // ecall、ebreak、mret 和 fence 不读写通用寄存器；CSR 指令读 rs1、写 rd。
  const system = (opcode === OPCODE.SYSTEM && !CSR_OPS.has(name)) || opcode === OPCODE.FENCE;
  return {
    word: w,
    name,
    format,
    opcode,
    rd,
    funct3,
    rs1,
    rs2,
    funct7,
    imm,
    usesRs1: !system && format !== 'U' && format !== 'J',
    usesRs2: format === 'R' || format === 'S' || format === 'B',
    writesRd: !system && format !== 'S' && format !== 'B' && rd !== 0,
  };
}

export interface BitSegment {
  name: string;
  hi: number;
  lo: number;
  kind: 'opcode' | 'rd' | 'funct3' | 'rs1' | 'rs2' | 'funct7' | 'imm' | 'csr';
  /** 立即数片段对应立即数的哪几位，比如 inst[30:25] 是 imm[10:5]。 */
  immHi?: number;
  immLo?: number;
}

const seg = (name: string, hi: number, lo: number, kind: BitSegment['kind'], immHi?: number, immLo?: number): BitSegment => ({ name, hi, lo, kind, immHi, immLo });

const OPCODE_SEG = seg('opcode', 6, 0, 'opcode');
const RD_SEG = seg('rd', 11, 7, 'rd');
const F3_SEG = seg('funct3', 14, 12, 'funct3');
const RS1_SEG = seg('rs1', 19, 15, 'rs1');
const RS2_SEG = seg('rs2', 24, 20, 'rs2');

/** 每种格式的位域，从高位到低位，即规范里画的顺序。 */
export const FORMAT_SEGMENTS: Record<Format, BitSegment[]> = {
  R: [seg('funct7', 31, 25, 'funct7'), RS2_SEG, RS1_SEG, F3_SEG, RD_SEG, OPCODE_SEG],
  I: [seg('imm[11:0]', 31, 20, 'imm', 11, 0), RS1_SEG, F3_SEG, RD_SEG, OPCODE_SEG],
  S: [seg('imm[11:5]', 31, 25, 'imm', 11, 5), RS2_SEG, RS1_SEG, F3_SEG, seg('imm[4:0]', 11, 7, 'imm', 4, 0), OPCODE_SEG],
  B: [seg('imm[12]', 31, 31, 'imm', 12, 12), seg('imm[10:5]', 30, 25, 'imm', 10, 5), RS2_SEG, RS1_SEG, F3_SEG, seg('imm[4:1]', 11, 8, 'imm', 4, 1), seg('imm[11]', 7, 7, 'imm', 11, 11), OPCODE_SEG],
  U: [seg('imm[31:12]', 31, 12, 'imm', 31, 12), RD_SEG, OPCODE_SEG],
  J: [seg('imm[20]', 31, 31, 'imm', 20, 20), seg('imm[10:1]', 30, 21, 'imm', 10, 1), seg('imm[11]', 20, 20, 'imm', 11, 11), seg('imm[19:12]', 19, 12, 'imm', 19, 12), RD_SEG, OPCODE_SEG],
};

/**
 * 移位立即数指令的 I 型里，高 7 位其实是 funct7，低 5 位才是 shamt。
 * CSR 指令的高 12 位是 CSR 地址；ecall、ebreak、mret 的高 12 位是区分它们的 funct12。
 */
export function segmentsOf(d: Decoded): BitSegment[] {
  if (SHIFT_IMM.has(d.name)) return [seg('funct7', 31, 25, 'funct7'), seg('shamt', 24, 20, 'imm', 4, 0), RS1_SEG, F3_SEG, RD_SEG, OPCODE_SEG];
  if (CSR_OPS.has(d.name)) return [seg('csr', 31, 20, 'csr'), RS1_SEG, F3_SEG, RD_SEG, OPCODE_SEG];
  if (d.opcode === OPCODE.SYSTEM) return [seg('funct12', 31, 20, 'funct7'), RS1_SEG, F3_SEG, RD_SEG, OPCODE_SEG];
  return FORMAT_SEGMENTS[d.format];
}

export const fieldBits = (word: number, hi: number, lo: number): number => bits(u32(word), hi, lo);
export const bitString = (value: number, width: number): string => (value >>> 0).toString(2).padStart(width, '0').slice(-width);
export const hex32 = (value: number): string => `0x${u32(value).toString(16).padStart(8, '0')}`;

const reg = (index: number) => `x${index}`;

/** 反汇编成和 LLVM 接受的写法相同的文本。 */
export function disasm(word: number): string {
  const d = decode(word);
  switch (d.format) {
    case 'R':
      return `${d.name} ${reg(d.rd)}, ${reg(d.rs1)}, ${reg(d.rs2)}`;
    case 'S':
      return `${d.name} ${reg(d.rs2)}, ${d.imm}(${reg(d.rs1)})`;
    case 'B':
      return `${d.name} ${reg(d.rs1)}, ${reg(d.rs2)}, ${d.imm}`;
    case 'U':
      return `${d.name} ${reg(d.rd)}, 0x${(d.imm >>> 12).toString(16)}`;
    case 'J':
      return `${d.name} ${reg(d.rd)}, ${d.imm}`;
    case 'I':
      if (d.name === 'ecall' || d.name === 'ebreak' || d.name === 'mret') return d.name;
      if (d.word === UNIMP_WORD) return 'unimp';
      // 和 LLVM 一样用 csrr、csrw 这两个别名，其余写全。
      if (d.name === 'csrrs' && d.rs1 === 0) return `csrr ${reg(d.rd)}, ${csrName(d.imm)}`;
      if (d.name === 'csrrw' && d.rd === 0) return `csrw ${csrName(d.imm)}, ${reg(d.rs1)}`;
      if (CSR_OPS.has(d.name)) return `${d.name} ${reg(d.rd)}, ${csrName(d.imm)}, ${reg(d.rs1)}`;
      if (d.name === 'fence') return 'fence';
      if (d.opcode === OPCODE.LOAD || d.opcode === OPCODE.JALR) return `${d.name} ${reg(d.rd)}, ${d.imm}(${reg(d.rs1)})`;
      return `${d.name} ${reg(d.rd)}, ${reg(d.rs1)}, ${d.imm}`;
  }
}

function parseReg(token: string): number {
  const match = /^x(\d+)$/.exec(token.trim());
  if (!match) throw new Error(`不是寄存器：${token}`);
  return checkReg(Number(match[1]));
}

function parseNumber(token: string): number {
  const text = token.trim();
  const value = Number(text);
  if (Number.isNaN(value)) throw new Error(`不是数字：${token}`);
  return value;
}

/** 一个够课程用的两遍汇编器。支持标签、nop、unimp、csrr、csrw，分支和跳转的操作数可以是标签或相对偏移，CSR 可以写名字或地址。 */
export function assemble(source: string[], base = 0): number[] {
  const labels = new Map<string, number>();
  const lines: string[] = [];
  for (const raw of source) {
    let line = raw.split('#')[0].trim();
    const label = /^([A-Za-z_.][\w.]*):\s*(.*)$/.exec(line);
    if (label) {
      labels.set(label[1], base + lines.length * 4);
      line = label[2].trim();
    }
    if (line) lines.push(line);
  }
  return lines.map((line, index) => {
    const pc = base + index * 4;
    const space = line.search(/\s/);
    const name = space < 0 ? line : line.slice(0, space);
    const args = space < 0 ? [] : line.slice(space + 1).split(',').map((item) => item.trim());
    if (name === 'nop') return encode('addi');
    if (name === 'unimp') return UNIMP_WORD;
    const csr = (token: string) => {
      const text = token.trim();
      if (Object.prototype.hasOwnProperty.call(CSR, text)) return CSR[text as CsrName];
      return parseNumber(text);
    };
    if (name === 'csrr') return encode('csrrs', { rd: parseReg(args[0]), imm: csr(args[1]) });
    if (name === 'csrw') return encode('csrrw', { imm: csr(args[0]), rs1: parseReg(args[1]) });
    if (CSR_OPS.has(name)) return encode(name, { rd: parseReg(args[0]), imm: csr(args[1]), rs1: parseReg(args[2]) });
    const info = OPS[name];
    if (!info) throw new Error(`未知指令：${line}`);
    const target = (token: string) => (labels.has(token) ? labels.get(token)! - pc : parseNumber(token));
    const mem = (token: string) => {
      const match = /^(-?\w+)\((x\d+)\)$/.exec(token);
      if (!match) throw new Error(`不是内存操作数：${token}`);
      return { imm: parseNumber(match[1]), rs1: parseReg(match[2]) };
    };
    switch (info.format) {
      case 'R':
        return encode(name, { rd: parseReg(args[0]), rs1: parseReg(args[1]), rs2: parseReg(args[2]) });
      case 'S': {
        const { imm, rs1 } = mem(args[1]);
        return encode(name, { rs2: parseReg(args[0]), rs1, imm });
      }
      case 'B':
        return encode(name, { rs1: parseReg(args[0]), rs2: parseReg(args[1]), imm: target(args[2]) });
      case 'U':
        return encode(name, { rd: parseReg(args[0]), imm: parseNumber(args[1]) });
      case 'J':
        return encode(name, { rd: parseReg(args[0]), imm: target(args[1]) });
      case 'I': {
        if (name === 'ecall' || name === 'ebreak' || name === 'mret' || name === 'fence') return encode(name);
        if (info.opcode === OPCODE.LOAD || (name === 'jalr' && args[1].includes('('))) {
          const { imm, rs1 } = mem(args[1]);
          return encode(name, { rd: parseReg(args[0]), rs1, imm });
        }
        return encode(name, { rd: parseReg(args[0]), rs1: parseReg(args[1]), imm: parseNumber(args[2]) });
      }
    }
  });
}
