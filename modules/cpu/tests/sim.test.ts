import { describe, expect, it } from 'vitest';
import llvm from './fixtures/rv32i-llvm.json';
import unicorn from './fixtures/rv32i-unicorn.json';
import { barrelShift, boothDigits, boothMul, negateSteps, rippleAdd, rippleSub, shiftAddMul, toSigned } from '../src/sim/arith';
import { Cache, splitAddress, type CacheConfig } from '../src/sim/cache';
import { DramBankModel, splitDramAddress } from '../src/sim/dram';
import { runDma, runPio } from '../src/sim/dma';
import { alu, controlOf, Memory, SingleCycleCpu } from '../src/sim/exec';
import { addTrace, decodeFloat, encodeFloat, encodeTrace, fieldsOf } from '../src/sim/float';
import { MesiSystem } from '../src/sim/mesi';
import { CAUSE, ganttText, MSTATUS, runPipeline } from '../src/sim/pipeline';
import { COUNTER_NAMES, NOT_TAKEN, OneBitPredictor, replay, TwoBitPredictor } from '../src/sim/predictor';
import { assemble, CSR, decode, disasm, encode, fieldBits, hex32, segmentsOf } from '../src/sim/riscv';

describe('RV32I 编解码：对照 LLVM 汇编器的真实输出', () => {
  it('fixture 覆盖全部基础指令', () => {
    const names = new Set((llvm.vectors as string[][]).map(([line]) => line.split(' ')[0]));
    for (const name of 'lui auipc jal jalr beq bne blt bge bltu bgeu lb lh lw lbu lhu sb sh sw addi slti sltiu xori ori andi slli srli srai add sub sll slt sltu xor srl sra or and ecall ebreak mul'.split(' ')) {
      expect(names, name).toContain(name);
    }
    expect(llvm.vectors.length).toBeGreaterThan(500);
  });

  it.each((llvm.vectors as string[][]).map(([line, word]) => [line, word]))('%s = %s', (line, word) => {
    const expected = Number(word);
    expect(hex32(assemble([line])[0])).toBe(word);
    const d = decode(expected);
    if (line !== 'nop') expect(d.name).toBe(line.split(' ')[0]);
    expect(hex32(assemble([disasm(expected)])[0])).toBe(word);
  });

  it('各字段的位段互不重叠并铺满 32 位', () => {
    for (const [, word] of llvm.vectors as string[][]) {
      const d = decode(Number(word));
      const segs = segmentsOf(d);
      const covered = new Set<number>();
      for (const seg of segs) {
        for (let bit = seg.lo; bit <= seg.hi; bit++) {
          expect(covered.has(bit)).toBe(false);
          covered.add(bit);
        }
      }
      expect(covered.size).toBe(32);
    }
  });

  it('规范手算向量：B 型和 J 型的立即数位序', () => {
    // beq x1, x2, 8：imm=8 → imm[4:1]=0100，其余 0。0x00208463。
    expect(hex32(encode('beq', { rs1: 1, rs2: 2, imm: 8 }))).toBe('0x00208463');
    // bne x1, x2, -4：imm=-4 → imm[12]=1, imm[11]=1, imm[10:5]=111111, imm[4:1]=1110。0xfe209ee3。
    expect(hex32(encode('bne', { rs1: 1, rs2: 2, imm: -4 }))).toBe('0xfe209ee3');
    // jal x0, -4 → 0xffdff06f。
    expect(hex32(encode('jal', { rd: 0, imm: -4 }))).toBe('0xffdff06f');
    // jal x1, 2048：imm[11]=1，落在 inst[20]。0x001000ef。
    expect(hex32(encode('jal', { rd: 1, imm: 2048 }))).toBe('0x001000ef');
    expect(decode(0xfe209ee3).imm).toBe(-4);
    expect(decode(0xffdff06f).imm).toBe(-4);
    expect(decode(0x001000ef).imm).toBe(2048);
    expect(fieldBits(0x001000ef, 20, 20)).toBe(1);
  });

  it('立即数越界和奇数偏移会报错', () => {
    expect(() => encode('addi', { imm: 2048 })).toThrow();
    expect(() => encode('beq', { imm: 3 })).toThrow();
    expect(() => encode('beq', { imm: 4096 })).toThrow();
    expect(() => encode('jal', { imm: 1048576 })).toThrow();
    expect(() => encode('slli', { imm: 32 })).toThrow();
  });
});

const PROGRAMS = Object.entries(unicorn.programs as Record<string, { source: string[]; words: string[]; regs: number[]; memory: Record<string, number> }>);

function memoryOf(memory: Memory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [address, value] of memory.bytes) if (value) out[String(address)] = value;
  return out;
}

describe('执行：对照 Unicorn（QEMU 派生的 RISC-V 模拟器）的最终状态', () => {
  describe.each(PROGRAMS)('%s', (_name, program) => {
    const words = program.words.map(Number);

    it('自己的汇编器产出相同的机器码', () => {
      expect(assemble(program.source).map(hex32)).toEqual(program.words);
    });

    it('单周期 CPU 的寄存器和内存一致', () => {
      const cpu = new SingleCycleCpu(words);
      cpu.run();
      expect([...cpu.regs]).toEqual(program.regs);
      expect(memoryOf(cpu.mem)).toEqual(program.memory);
    });

    it.each([
      ['开前递', { forwarding: true }],
      ['关前递', { forwarding: false }],
      ['开前递 + 2 位预测器', { forwarding: true, predictor: new TwoBitPredictor(16) }],
    ])('流水线（%s）的寄存器和内存一致', (_label, options) => {
      const result = runPipeline(words, options);
      expect(result.regs).toEqual(program.regs);
      expect(memoryOf(result.mem)).toEqual(program.memory);
    });
  });
});

const lines = (text: string) => text.trim().split('\n').map((line) => line.trim());

describe('流水线时序：对照手算的经典流水线图', () => {
  it('没有冒险时，N 条指令用 N+4 拍', () => {
    const result = runPipeline(assemble(['addi x1, x0, 1', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4', 'addi x5, x0, 5']));
    expect(result.cycles.length).toBe(9);
    expect(result.retired).toBe(5);
    expect(ganttText(result)).toEqual(lines(`
      addi x1, x0, 1: IF ID EX MEM WB
      addi x2, x0, 2: . IF ID EX MEM WB
      addi x3, x0, 3: . . IF ID EX MEM WB
      addi x4, x0, 4: . . . IF ID EX MEM WB
      addi x5, x0, 5: . . . . IF ID EX MEM WB`));
  });

  it('前递：紧邻的读后写不停顿，来源分别是 MEM 和 WB', () => {
    const result = runPipeline(assemble(['addi x1, x0, 5', 'add x2, x1, x1', 'add x3, x1, x2']));
    expect(result.stalls).toBe(0);
    expect(result.cycles.length).toBe(7);
    const ex2 = result.cycles[3];
    expect(ex2.forwards.map((f) => [f.port, f.from, f.value])).toEqual([['A', 'MEM', 5], ['B', 'MEM', 5]]);
    const ex3 = result.cycles[4];
    expect(ex3.forwards.map((f) => [f.port, f.from, f.value])).toEqual([['A', 'WB', 5], ['B', 'MEM', 10]]);
    expect(result.regs[3]).toBe(15);
  });

  it('load-use 必须停 1 拍，停顿后从 WB 前递', () => {
    const result = runPipeline(assemble(['lw x1, 256(x0)', 'add x2, x1, x1']), { memory: (() => { const m = new Memory(); m.storeWord(256, 21); return m; })() });
    expect(result.stalls).toBe(1);
    expect(ganttText(result)).toEqual(lines(`
      lw x1, 256(x0): IF ID EX MEM WB
      add x2, x1, x1: . IF s ID EX MEM WB`));
    expect(result.cycles[4].forwards.map((f) => f.from)).toEqual(['WB', 'WB']);
    expect(result.regs[2]).toBe(42);
  });

  it('关前递：紧邻依赖停 2 拍（前半拍写、后半拍读）', () => {
    const result = runPipeline(assemble(['addi x1, x0, 5', 'add x2, x1, x1']), { forwarding: false });
    expect(result.stalls).toBe(2);
    expect(result.cycles.length).toBe(8);
    expect(result.regs[2]).toBe(10);
  });

  it('隔两条的依赖靠寄存器堆内部转发，不需要停也不需要前递', () => {
    const result = runPipeline(assemble(['addi x1, x0, 5', 'nop', 'nop', 'add x2, x1, x1']), { forwarding: false });
    expect(result.stalls).toBe(0);
    expect(result.regs[2]).toBe(10);
  });

  it('写 x0 不产生前递', () => {
    const result = runPipeline(assemble(['addi x0, x0, 5', 'add x2, x0, x0']));
    expect(result.cycles.flatMap((c) => c.forwards)).toEqual([]);
    expect(result.regs[2]).toBe(0);
  });

  it('跳转的分支在 EX 解析，冲掉 2 条，代价 2 拍', () => {
    const result = runPipeline(assemble(['beq x0, x0, 12', 'addi x1, x0, 1', 'addi x2, x0, 2', 'addi x3, x0, 3']));
    expect(result.flushes).toBe(2);
    expect(result.mispredicts).toBe(1);
    expect(result.regs.slice(1, 4)).toEqual([0, 0, 3]);
    expect(ganttText(result)).toEqual(lines(`
      beq x0, x0, 12: IF ID EX MEM WB
      addi x1, x0, 1 !: . IF ID
      addi x2, x0, 2 !: . . IF
      addi x3, x0, 3: . . . IF ID EX MEM WB`));
  });

  it('不跳的分支在静态预测下没有代价', () => {
    const result = runPipeline(assemble(['bne x0, x0, 12', 'addi x1, x0, 1']));
    expect(result.flushes).toBe(0);
    expect(result.cycles.length).toBe(6);
  });
});

describe('课程程序的关键时序', () => {
  it('HAZARD 程序：共 12 拍，第 8 拍 load-use，停完从 WB 前递 x6', () => {
    const result = runPipeline(assemble(['addi x2, x0, 7', 'addi x5, x0, 3', 'add x1, x2, x5', 'sub x4, x1, x5', 'sw x4, 256(x0)', 'lw x6, 256(x0)', 'and x7, x6, x1']));
    expect(result.cycles.length).toBe(12);
    expect(result.stalls).toBe(1);
    expect(result.cycles[7].stall).toBe(true);
    // add 的 EX 在第 5 拍：x5 来自 MEM（上一条），x2 来自 WB（上上条）。
    expect(result.cycles[4].stages.EX?.text).toBe('add x1, x2, x5');
    expect(result.cycles[4].forwards.map((f) => [f.port, f.reg, f.from, f.value])).toEqual([['A', 2, 'WB', 7], ['B', 5, 'MEM', 3]]);
    expect(result.cycles[9].stages.EX?.text).toBe('and x7, x6, x1');
    expect(result.cycles[9].forwards.map((f) => [f.port, f.reg, f.from])).toEqual([['A', 6, 'WB']]);
    expect(runPipeline(assemble(['addi x2, x0, 7', 'addi x5, x0, 3', 'add x1, x2, x5', 'sub x4, x1, x5', 'sw x4, 256(x0)', 'lw x6, 256(x0)', 'and x7, x6, x1']), { forwarding: false }).cycles.length).toBeGreaterThan(12);
  });

  it('BRANCH 程序：静态错 9 次且每次冲 2 条，2 位错 2 次', () => {
    const source = ['addi x1, x0, 0', 'addi x2, x0, 10', 'loop:', 'addi x1, x1, 1', 'bne x1, x2, loop', 'addi x3, x1, 100', 'addi x4, x1, 200'];
    const fixed = runPipeline(assemble(source), { predictor: NOT_TAKEN });
    expect(fixed.mispredicts).toBe(9);
    expect(fixed.flushes).toBe(18);
    const dynamic = runPipeline(assemble(source), { predictor: new TwoBitPredictor(16) });
    expect(dynamic.mispredicts).toBe(2);
    expect(dynamic.branches.map((b) => b.mispredicted)).toEqual([true, false, false, false, false, false, false, false, false, true]);
  });
});

describe('2 位分支预测器', () => {
  it('状态转移符合 2 位饱和计数器', () => {
    const p = new TwoBitPredictor(4, 0);
    const seq: string[] = [];
    for (const taken of [true, true, true, true, false, true, false, false, false, false]) {
      p.update(0, taken);
      seq.push(COUNTER_NAMES[p.counter(0)]);
    }
    expect(seq).toEqual(['WN', 'WT', 'ST', 'ST', 'WT', 'ST', 'WT', 'WN', 'SN', 'SN']);
  });

  it('内层循环 T T T N 重复时：1 位每轮错 2 次，2 位只错 1 次', () => {
    const pattern = Array.from({ length: 12 }, (_, i) => ({ pc: 0x10, taken: i % 4 !== 3 }));
    const warm = (p: OneBitPredictor | TwoBitPredictor) => {
      for (const item of pattern.slice(0, 4)) p.update(item.pc, item.taken);
      return replay(p, pattern.slice(4));
    };
    expect(warm(new OneBitPredictor(4)).correct).toBe(4);
    expect(warm(new TwoBitPredictor(4)).correct).toBe(6);
  });

  it('流水线里预测对了就没有冲刷', () => {
    const program = assemble(['addi x1, x0, 0', 'addi x2, x0, 10', 'loop:', 'addi x1, x1, 1', 'bne x1, x2, loop', 'addi x3, x1, 100']);
    const staticRun = runPipeline(program, { predictor: NOT_TAKEN });
    const dynamicRun = runPipeline(program, { predictor: new TwoBitPredictor(16) });
    // 静态预测不跳：跳了 9 次，每次错。
    expect(staticRun.mispredicts).toBe(9);
    // 动态：第 1 次 BTB 没有目标，最后一次退出循环。
    expect(dynamicRun.mispredicts).toBe(2);
    expect(dynamicRun.cycles.length).toBeLessThan(staticRun.cycles.length);
    expect(dynamicRun.regs[3]).toBe(110);
    // 每次预测错付 2 拍：总周期差等于 2 × 错误次数差。
    expect(staticRun.cycles.length - dynamicRun.cycles.length).toBe(2 * (staticRun.mispredicts - dynamicRun.mispredicts));
  });
});

describe('门级加法器和 ALU', () => {
  it('随机向量与 JS 整数运算一致', () => {
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 2000; i++) {
      const a = next();
      const b = next();
      expect(rippleAdd(a, b, 0, 32).sum).toBe((a + b) >>> 0);
      expect(rippleSub(a, b, 32).sum).toBe((a - b) >>> 0);
      expect(alu('ADD', a, b)).toBe((a + b) >>> 0);
      expect(alu('MUL', a, b)).toBe(Number((BigInt(a) * BigInt(b)) & 0xffffffffn));
      expect(shiftAddMul(a, b & 0xffff).product).toBe(Number((BigInt(a) * BigInt(b & 0xffff)) & 0xffffffffn));
      const shamt = b & 31;
      expect(barrelShift(a, shamt, 'SLL').result).toBe((a << shamt) >>> 0);
      expect(barrelShift(a, shamt, 'SRL').result).toBe(a >>> shamt);
      expect(barrelShift(a, shamt, 'SRA').result).toBe((a >> shamt) >>> 0);
    }
  });

  it('8 位补码手算向量', () => {
    expect(negateSteps(3)).toEqual({ original: 0b00000011, inverted: 0b11111100, negated: 0b11111101 });
    expect(toSigned(0b11111101, 8)).toBe(-3);
    const sum = rippleAdd(100, 50, 0, 8);
    expect(sum.sum).toBe(150);
    expect(toSigned(sum.sum, 8)).toBe(-106);
    expect(sum.overflow).toBe(true);
    expect(sum.carryOut).toBe(0);
    const diff = rippleSub(5, 3, 8);
    expect(diff.sum).toBe(2);
    expect(diff.carryOut).toBe(1);
    expect(diff.overflow).toBe(false);
  });

  it('全加器每一位的和进位符合真值表', () => {
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        for (const c of [0, 1]) {
          const r = rippleAdd(a, b, c, 1);
          const total = a + b + c;
          expect(r.bits[0].sum).toBe(total & 1);
          expect(r.bits[0].cout).toBe(total >> 1);
        }
      }
    }
  });

  it('n 位行波进位的最长路径是 2n+1 个门延迟', () => {
    expect(rippleAdd(0, 0, 0, 8).bits[7].coutAt).toBe(17);
    expect(rippleAdd(0, 0, 0, 8).bits[0].coutAt).toBe(3);
    expect(rippleAdd(0, 0, 0, 8).bits[0].sumAt).toBe(2);
    expect(rippleAdd(0, 0, 0, 32).bits[31].coutAt).toBe(65);
  });

  it('SLT 和 SLTU 对同一组位给出不同答案', () => {
    expect(alu('SLT', 0xffffffff, 1)).toBe(1);
    expect(alu('SLTU', 0xffffffff, 1)).toBe(0);
  });
});

describe('Booth 乘法器', () => {
  const bin = (value: number) => value.toString(2).padStart(8, '0');

  it('7 × (-6) 手算：每拍的 Q0 Q-1、动作和移位后的 A、Q', () => {
    const result = boothMul(7, -6 & 0xff);
    expect(result.iterations.map((item) => [`${item.q0}${item.qm1}`, item.op, bin(item.a), bin(item.q), item.qm1Out])).toEqual([
      ['00', 'none', '00000000', '01111101', 0],
      ['10', 'sub', '11111100', '10111110', 1],
      ['01', 'add', '00000001', '11011111', 0],
      ['10', 'sub', '11111101', '01101111', 1],
      ['11', 'none', '11111110', '10110111', 1],
      ['11', 'none', '11111111', '01011011', 1],
      ['11', 'none', '11111111', '10101101', 1],
      ['11', 'none', '11111111', '11010110', 1],
    ]);
    expect(result.iterations[1].aAfterOp).toBe(0b11111001);
    expect(result.iterations[2].aAfterOp).toBe(0b00000011);
    expect(result.high).toBe(0xff);
    expect(result.low).toBe(0xd6);
    expect(result.product).toBe(-42);
    // 同样的位当无符号数做移位相加：低 8 位相同，高 8 位不同。
    expect(shiftAddMul(7, 250).product).toBe(0x06d6);
  });

  it('重编码：-6 = -2 + 4 - 8', () => {
    expect(boothDigits(-6 & 0xff)).toEqual([0, -1, 1, -1, 0, 0, 0, 0]);
    for (let q = 0; q < 256; q++) expect(boothDigits(q).reduce((sum, digit, bit) => sum + digit * 2 ** bit, 0)).toBe(toSigned(q, 8));
  });

  it('8 位穷举：包括被乘数是 -128 的情形', () => {
    for (let m = 0; m < 256; m++) {
      for (let q = 0; q < 256; q++) {
        const result = boothMul(m, q);
        const expected = toSigned(m, 8) * toSigned(q, 8);
        expect(result.product).toBe(expected + 0);
        expect(result.high * 256 + result.low).toBe(expected & 0xffff);
      }
    }
  });

  it('16 位和 30 位随机向量与 BigInt 一致', () => {
    let seed = 777;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (const width of [16, 30]) {
      const m = 2 ** width - 1;
      for (let i = 0; i < 500; i++) {
        const a = next() & m;
        const b = next() & m;
        const result = boothMul(a, b, width);
        const exact = BigInt(toSigned(a, width)) * BigInt(toSigned(b, width));
        if (width <= 16) expect(BigInt(result.product)).toBe(exact);
        expect(BigInt(result.low)).toBe(BigInt.asUintN(width, exact));
        expect(BigInt(result.high)).toBe(BigInt.asUintN(width, exact >> BigInt(width)));
      }
    }
  });

  it('加减次数等于乘数里 1 串的边界数', () => {
    expect(boothMul(7, -6 & 0xff).iterations.filter((item) => item.op !== 'none').length).toBe(3);
    expect(boothMul(7, 0b01111110).iterations.filter((item) => item.op !== 'none').length).toBe(2);
    expect(() => boothMul(1, 1, 31)).toThrow();
  });
});

describe('Zicsr 和 mret：对照 RISC-V 特权规范手算', () => {
  it('编码', () => {
    // csrw mtvec, x5 = csrrw x0, 0x305, x5：csr[31:20]=0x305，rs1=5，funct3=001，opcode=1110011。
    expect(hex32(assemble(['csrw mtvec, x5'])[0])).toBe('0x30529073');
    expect(hex32(assemble(['csrr x10, mcause'])[0])).toBe('0x34202573');
    expect(hex32(assemble(['csrr x11, mepc'])[0])).toBe('0x341025f3');
    expect(hex32(assemble(['csrw mepc, x11'])[0])).toBe('0x34159073');
    expect(hex32(assemble(['csrrc x1, mstatus, x2'])[0])).toBe('0x300130f3');
    expect(hex32(assemble(['csrrs x1, 0x343, x0'])[0])).toBe('0x343020f3');
    expect(hex32(assemble(['mret'])[0])).toBe('0x30200073');
    // unimp 是 csrrw x0, cycle, x0。
    expect(hex32(assemble(['unimp'])[0])).toBe('0xc0001073');
    expect(hex32(assemble(['csrrw x0, cycle, x0'])[0])).toBe('0xc0001073');
    expect(() => assemble(['csrrw x1, 4096, x0'])).toThrow();
  });

  it('解码和反汇编来回一致', () => {
    for (const line of ['csrw mtvec, x5', 'csrr x10, mcause', 'csrrc x1, mstatus, x2', 'csrrs x3, mscratch, x2', 'csrrw x4, mtval, x7', 'mret', 'unimp', 'ecall', 'ebreak']) {
      const [word] = assemble([line]);
      expect(disasm(word), line).toBe(line);
      expect(assemble([disasm(word)])[0]).toBe(word);
      const covered = new Set<number>();
      for (const seg of segmentsOf(decode(word))) for (let bit = seg.lo; bit <= seg.hi; bit++) covered.add(bit);
      expect(covered.size, line).toBe(32);
    }
    const unimp = decode(0xc0001073);
    expect([unimp.name, unimp.imm, unimp.rd, unimp.rs1, unimp.usesRs1]).toEqual(['csrrw', CSR.cycle, 0, 0, true]);
    const read = decode(0x34202573);
    expect([read.name, read.imm, read.rd, read.writesRd]).toEqual(['csrrs', CSR.mcause, 10, true]);
    expect(decode(0x30200073).usesRs1).toBe(false);
  });
});

const HANDLER = ['csrr x10, mcause', 'csrr x11, mepc', 'addi x11, x11, 4', 'csrw mepc, x11', 'mret'];
const withHandler = (source: string[], extra: Parameters<typeof runPipeline>[1] = {}) => runPipeline(assemble(source), {
  exceptions: true,
  sections: [{ base: 0x80, words: assemble(HANDLER, 0x80) }],
  csrs: { mtvec: 0x80, mstatus: MSTATUS.MIE },
  memory: new Memory(),
  ...extra,
});

describe('精确异常：对照手算的流水线图', () => {
  it('EXCEPTION 例一：ID 发现非法指令，WB 陷入并冲掉 4 条，mret 回到下一条', () => {
    const result = withHandler(['addi x5, x0, 128', 'csrw mtvec, x5', 'addi x1, x0, 1', 'unimp', 'sw x1, 256(x0)', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4'], { csrs: { mstatus: MSTATUS.MIE } });
    expect(ganttText(result)).toEqual(lines(`
      addi x5, x0, 128: IF ID EX MEM WB
      csrw mtvec, x5: . IF ID EX MEM WB
      addi x1, x0, 1: . . IF ID EX MEM WB
      unimp #: . . . IF ID EX MEM WB
      sw x1, 256(x0) !: . . . . IF ID EX MEM
      addi x2, x0, 2 !: . . . . . IF ID EX
      addi x3, x0, 3 !: . . . . . . IF ID
      addi x4, x0, 4 !: . . . . . . . IF
      csrr x10, mcause: . . . . . . . . IF ID EX MEM WB
      csrr x11, mepc: . . . . . . . . . IF ID EX MEM WB
      addi x11, x11, 4: . . . . . . . . . . IF s ID EX MEM WB
      csrw mepc, x11: . . . . . . . . . . . s IF ID EX MEM WB
      mret: . . . . . . . . . . . . . IF ID EX MEM WB
      sw x1, 256(x0): . . . . . . . . . . . . . . . . . . IF ID EX MEM WB
      addi x2, x0, 2: . . . . . . . . . . . . . . . . . . . IF ID EX MEM WB
      addi x3, x0, 3: . . . . . . . . . . . . . . . . . . . . IF ID EX MEM WB
      addi x4, x0, 4: . . . . . . . . . . . . . . . . . . . . . IF ID EX MEM WB`));
    expect(result.cycles[4].csr).toMatchObject({ name: 'mtvec', write: true, old: 0, value: 0x80 });
    expect(result.cycles[4].detected.map((d) => [d.text, d.stage, d.cause, hex32(d.tval)])).toEqual([['unimp', 'ID', 2, '0xc0001073']]);
    const [trap] = result.traps;
    expect(trap).toMatchObject({ cycle: 8, pc: 0x0c, cause: CAUSE.ILLEGAL_INSTRUCTION, tval: 0xc0001073, target: 0x80, mstatusBefore: 0x1808, mstatusAfter: 0x1880, detected: { stage: 'ID', cycle: 5 } });
    expect(trap.flushed.map((f) => f.text)).toEqual(['sw x1, 256(x0)', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4']);
    // 陷入那一拍 MEM 里的 sw 没有写内存；返回后第 22 拍才写。
    expect(result.cycles[7].mem).toBeNull();
    expect(result.cycles.filter((c) => c.mem?.write).map((c) => c.cycle)).toEqual([22]);
    expect(result.cycles[7].csrs).toMatchObject({ mepc: 0x0c, mcause: 2, mtval: 0xc0001073 });
    expect(result.returns).toMatchObject([{ cycle: 18, mepc: 0x10, mstatusBefore: 0x1880, mstatusAfter: 0x1888, flushed: [] }]);
    expect(result.regs.slice(1, 6)).toEqual([1, 2, 3, 4, 128]);
    expect(result.regs[10]).toBe(2);
    expect(result.regs[11]).toBe(0x10);
    expect(result.mem.loadWord(256)).toBe(1);
    // 陷入的 unimp 不算提交：8 + 5 + 4 = 17 条动态指令，冲掉 4 条，陷入 1 条。
    expect(result.retired).toBe(12);
    expect(result.stalls).toBe(1);
    expect(result.cycles.length).toBe(26);
  });

  it('EXCEPTION 例二：较新的 unimp 先被发现，较老的 lw 先陷入', () => {
    const result = withHandler(['addi x1, x0, 256', 'lw x6, 2(x1)', 'unimp', 'addi x7, x0, 7']);
    expect(result.traps.map((t) => [t.cycle, t.text, t.cause, hex32(t.tval), hex32(t.pc), t.detected.stage, t.detected.cycle])).toEqual([
      [6, 'lw x6, 2(x1)', CAUSE.LOAD_MISALIGNED, '0x00000102', '0x00000004', 'MEM', 5],
      [21, 'unimp', CAUSE.ILLEGAL_INSTRUCTION, '0xc0001073', '0x00000008', 'ID', 18],
    ]);
    // unimp 第 4 拍就被发现，比 lw 的第 5 拍早，但它被 lw 的陷入冲掉，标记作废。
    expect(result.cycles[3].detected.map((d) => d.text)).toEqual(['unimp']);
    expect(result.traps[0].flushed.map((f) => f.text)).toEqual(['unimp', 'addi x7, x0, 7']);
    expect(result.regs[6]).toBe(0);
    expect(result.regs[7]).toBe(7);
    expect(result.regs[10]).toBe(2);
    expect(result.cycles.length).toBe(36);
  });

  it('不打开异常时行为不变：未对齐访问照常完成，unimp 当作 csrrw 执行', () => {
    const memory = new Memory();
    memory.storeWord(256, 0x44332211);
    memory.storeWord(260, 0x88776655);
    const result = runPipeline(assemble(['addi x1, x0, 256', 'lw x6, 2(x1)', 'unimp']), { memory });
    expect(result.traps).toEqual([]);
    expect(hex32(result.regs[6])).toBe('0x66554433');
    expect(result.retired).toBe(3);
  });

  it('store 未对齐：不写内存，mcause 6，mtval 是地址', () => {
    const result = withHandler(['addi x1, x0, 5', 'sw x1, 257(x0)', 'addi x2, x0, 9']);
    expect(result.traps.map((t) => [t.cause, t.tval, t.pc])).toEqual([[CAUSE.STORE_MISALIGNED, 257, 4]]);
    expect([...result.mem.bytes.values()].every((byte) => byte === 0)).toBe(true);
    expect(result.regs[2]).toBe(9);
  });

  it('ecall 和 ebreak：mcause 11 和 3，ebreak 的 mtval 是自己的地址', () => {
    const result = withHandler(['addi x1, x0, 1', 'ecall', 'ebreak', 'addi x2, x0, 2']);
    expect(result.traps.map((t) => [t.text, t.cause, t.tval, t.pc])).toEqual([['ecall', CAUSE.ECALL_M, 0, 4], ['ebreak', CAUSE.BREAKPOINT, 8, 8]]);
    expect(result.regs[2]).toBe(2);
  });

  it('写只读 CSR、访问不存在的 CSR 是非法指令；只读 CSR 可以读', () => {
    const result = withHandler(['csrr x1, cycle', 'csrw cycle, x1', 'csrr x2, 0x7c0', 'csrrs x3, instret, x0', 'csrr x4, misa']);
    expect(result.traps.map((t) => [t.text, t.cause])).toEqual([['csrw cycle, x1', 2], ['csrr x2, 0x7c0', 2]]);
    // cycle 在 MEM 级读：第 1 条指令第 4 拍到 MEM。
    expect(result.regs[1]).toBe(4);
    expect(result.regs[2]).toBe(0);
    expect(hex32(result.regs[4])).toBe('0x40001100');
  });

  it('csrrs 置位、csrrc 清位，读出的是旧值；读出后紧跟使用停 1 拍', () => {
    const result = runPipeline(assemble(['addi x1, x0, 8', 'csrw mscratch, x1', 'addi x2, x0, 3', 'csrrs x3, mscratch, x2', 'csrrc x4, mscratch, x1', 'csrr x5, mscratch', 'add x6, x5, x5']));
    expect(result.regs.slice(3, 7)).toEqual([8, 11, 3, 6]);
    expect(result.csrs.mscratch).toBe(3);
    expect(result.stalls).toBe(1);
  });

  it('无法解码的字也是非法指令，mtval 是指令字', () => {
    const result = withHandler(['addi x1, x0, 1'], { sections: [{ base: 0x80, words: assemble(HANDLER, 0x80) }, { base: 4, words: [0xffffffff] }] });
    expect(result.traps.map((t) => [t.text, t.cause, hex32(t.tval)])).toEqual([['.word 0xffffffff', 2, '0xffffffff']]);
    expect(() => runPipeline([0xffffffff])).toThrow();
  });
});

describe('控制单元真值表：对照教科书（Patterson & Hennessy RISC-V 版）', () => {
  const row = (line: string) => {
    const c = controlOf(decode(assemble([line])[0]));
    return { ALUSrc: c.aluSrc, RegWrite: c.regWrite, MemRead: c.memRead, MemWrite: c.memWrite, Branch: c.branch, ALUOp: c.aluOp, wb: c.wbSrc };
  };
  it('R 型、load、store、beq 四行', () => {
    expect(row('add x1, x2, x3')).toEqual({ ALUSrc: false, RegWrite: true, MemRead: false, MemWrite: false, Branch: false, ALUOp: 0b10, wb: 'alu' });
    expect(row('lw x1, 0(x2)')).toEqual({ ALUSrc: true, RegWrite: true, MemRead: true, MemWrite: false, Branch: false, ALUOp: 0b00, wb: 'mem' });
    expect(row('sw x1, 0(x2)')).toEqual({ ALUSrc: true, RegWrite: false, MemRead: false, MemWrite: true, Branch: false, ALUOp: 0b00, wb: 'none' });
    expect(row('beq x1, x2, 8')).toEqual({ ALUSrc: false, RegWrite: false, MemRead: false, MemWrite: false, Branch: true, ALUOp: 0b01, wb: 'none' });
  });
});

/** Float32Array 由 JS 引擎按 IEEE 754 实现，作为独立对照。 */
const f32 = new Float32Array(1);
const u32view = new Uint32Array(f32.buffer);
const bitsOf = (value: number) => {
  f32[0] = value;
  return u32view[0];
};
const fromBits = (bits: number) => {
  u32view[0] = bits;
  return f32[0];
};

describe('IEEE 754 binary32', () => {
  it('规范已知值', () => {
    expect(encodeFloat(1.0)).toBe(0x3f800000);
    expect(encodeFloat(-1.0)).toBe(0xbf800000);
    expect(encodeFloat(-0.1)).toBe(0xbdcccccd);
    expect(encodeFloat(0.1)).toBe(0x3dcccccd);
    expect(encodeFloat(0.2)).toBe(0x3e4ccccd);
    expect(encodeFloat(0.5)).toBe(0x3f000000);
    expect(encodeFloat(2.0)).toBe(0x40000000);
    expect(encodeFloat(16777216)).toBe(0x4b800000);
    expect(encodeFloat(Infinity)).toBe(0x7f800000);
    expect(encodeFloat(-Infinity)).toBe(0xff800000);
    expect(encodeFloat(0)).toBe(0);
    expect(encodeFloat(-0)).toBe(0x80000000);
    expect(encodeFloat(1.401298464324817e-45)).toBe(1);
    expect(encodeFloat(1.1754943508222875e-38)).toBe(0x00800000);
    expect(encodeFloat(3.4028234663852886e38)).toBe(0x7f7fffff);
    expect(encodeFloat(1e40)).toBe(0x7f800000);
    expect(fieldsOf(0x7fc00000).kind).toBe('nan');
    expect(fieldsOf(0x00000001).kind).toBe('subnormal');
    expect(fieldsOf(0x3f800000)).toMatchObject({ sign: 0, exponent: 127, fraction: 0, power: 0, kind: 'normal' });
    expect(fieldsOf(0xbdcccccd)).toMatchObject({ sign: 1, exponent: 123, fraction: 0x4ccccd, power: -4 });
  });

  it('0.1 舍入时向上进位', () => {
    const trace = encodeTrace(0.1);
    expect(trace.roundedUp).toBe(true);
    expect(trace.truncated).toBe(0xcccccc);
  });

  it('编码和解码与 Float32Array 一致（随机向量）', () => {
    let seed = 777;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 20000; i++) {
      const bits = next();
      if (((bits >>> 23) & 0xff) === 0xff) continue;
      expect(decodeFloat(bits)).toBe(fromBits(bits));
      expect(encodeFloat(fromBits(bits))).toBe(bits);
      const wide = (next() / 2 ** 32 - 0.5) * 2 ** (next() % 300 - 150);
      expect(encodeFloat(wide)).toBe(bitsOf(wide));
    }
  });

  it('加法与 Float32Array 一致（随机、次正规、抵消、溢出）', () => {
    let seed = 4242;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const check = (a: number, b: number) => {
      const expected = bitsOf(fromBits(a) + fromBits(b));
      const got = addTrace(a, b).bits;
      if (Number.isNaN(fromBits(a) + fromBits(b))) expect(fieldsOf(got).kind).toBe('nan');
      else expect(got, `${hex32(a)} + ${hex32(b)}`).toBe(expected);
    };
    for (let i = 0; i < 30000; i++) {
      const a = next();
      let b = next();
      if (i % 4 === 1) b = ((a & 0x7f800000) | (b & 0x807fffff)) >>> 0;
      if (i % 4 === 2) b = (a ^ 0x80000000 ^ (b & 0x3f)) >>> 0;
      if (i % 4 === 3) b = (b & 0x807fffff) >>> 0;
      check(a, b);
    }
    for (const [a, b] of [[0x7f800000, 0xff800000], [0x7f7fffff, 0x7f7fffff], [0, 0x80000000], [0x80000000, 0x80000000], [1, 1], [0x3f800000, 0xbf800000]]) check(a, b);
  });

  it('0.1f + 0.2f 的真实结果', () => {
    expect(addTrace(0x3dcccccd, 0x3e4ccccd).bits).toBe(bitsOf(fromBits(0x3dcccccd) + fromBits(0x3e4ccccd)));
    // 2^24 + 1 在 binary32 里加不进去。
    expect(addTrace(encodeFloat(16777216), encodeFloat(1)).bits).toBe(encodeFloat(16777216));
  });
});

const CONFIG: CacheConfig = { sets: 4, ways: 2, blockBytes: 16, hitCycles: 1, missPenalty: 20, writePenalty: 10, writePolicy: 'write-back', writeMiss: 'allocate' };

describe('组相联缓存', () => {
  it('地址拆分：4 组 16 字节块 → 4 位偏移、2 位索引、26 位标记', () => {
    expect(splitAddress(0x1234, CONFIG)).toEqual({ tag: 0x48, index: 3, offset: 4, tagBits: 26, indexBits: 2, offsetBits: 4 });
    expect(splitAddress(0xffffffff, CONFIG)).toEqual({ tag: 0x3ffffff, index: 3, offset: 15, tagBits: 26, indexBits: 2, offsetBits: 4 });
  });

  it('手算序列：冷启动未命中、空间局部性、同组两路、LRU 替换', () => {
    const cache = new Cache({ ...CONFIG });
    const r1 = cache.read(0x1004);
    expect(r1).toMatchObject({ hit: false, set: 0, way: 0, memReadBytes: 16, cycles: 21, startCycle: 1, endCycle: 21 });
    expect(cache.read(0x100c)).toMatchObject({ hit: true, way: 0, cycles: 1, endCycle: 22 });
    expect(cache.read(0x1044)).toMatchObject({ hit: false, set: 0, way: 1 });
    expect(cache.read(0x1000)).toMatchObject({ hit: true, way: 0 });
    // 第 3 个不同标记进第 0 组：way1（0x1044）最久没用，被替换。
    const r5 = cache.read(0x1084);
    expect(r5).toMatchObject({ hit: false, way: 1, evicted: { tag: 0x41, dirty: false, address: 0x1040 } });
    expect(cache.hits).toBe(2);
    expect(cache.misses).toBe(3);
  });

  it('写回：写命中只置脏，替换时才写一块回内存', () => {
    const cache = new Cache({ ...CONFIG });
    cache.write(0x1000, 0xaabbccdd);
    expect(cache.memory.loadWord(0x1000)).toBe(0);
    expect(cache.lines[0][0].dirty).toBe(true);
    cache.read(0x1040);
    const r = cache.read(0x1080);
    expect(r).toMatchObject({ evicted: { dirty: true, address: 0x1000 }, memWriteBytes: 16, cycles: 31 });
    expect(cache.memory.loadWord(0x1000)).toBe(0xaabbccdd);
  });

  it('写直达：每次写都到内存；不分配时写未命中不进缓存', () => {
    const cache = new Cache({ ...CONFIG, writePolicy: 'write-through', writeMiss: 'no-allocate' });
    const w = cache.write(0x1000, 7);
    expect(w).toMatchObject({ hit: false, way: null, memWriteBytes: 4, memReadBytes: 0, cycles: 11 });
    expect(cache.lines[0][0].valid).toBe(false);
    expect(cache.memory.loadWord(0x1000)).toBe(7);
  });

  it('随机访问：缓存读到的永远等于扁平内存里最后写的值', () => {
    for (const writePolicy of ['write-back', 'write-through'] as const) {
      for (const writeMiss of ['allocate', 'no-allocate'] as const) {
        const cache = new Cache({ ...CONFIG, writePolicy, writeMiss });
        const shadow = new Map<number, number>();
        let seed = 99;
        const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
        for (let i = 0; i < 5000; i++) {
          const address = ((next() >>> 10) % 64) * 4 + 0x1000;
          if (next() % 2) {
            const value = next();
            cache.write(address, value);
            shadow.set(address, value);
          } else {
            expect(cache.read(address).value).toBe(shadow.get(address) ?? 0);
          }
        }
        cache.flush();
        for (const [address, value] of shadow) expect(cache.memory.loadWord(address)).toBe(value);
      }
    }
  });
});

describe('MESI', () => {
  it('转移表：逐条对照协议定义', () => {
    const s = new MesiSystem(2, 0x80);
    s.memory.storeWord(0x80, 1);
    let e = s.read(0);
    expect([e.bus, e.self.from, e.self.to, e.dataFrom]).toEqual(['BusRd', 'I', 'E', 'memory']);
    e = s.read(1);
    expect([e.bus, e.self.to, e.snoops]).toEqual(['BusRd', 'S', [{ core: 0, from: 'E', to: 'S' }]]);
    e = s.write(0, 2);
    expect([e.bus, e.self.from, e.self.to, e.snoops]).toEqual(['BusUpgr', 'S', 'M', [{ core: 1, from: 'S', to: 'I' }]]);
    expect(e.memoryValue).toBe(1);
    e = s.write(0, 3);
    expect([e.silent, e.bus, e.self.to]).toEqual([true, null, 'M']);
    e = s.read(1);
    expect([e.bus, e.flushedBy, e.dataFrom, e.value, e.memoryValue, e.self.to]).toEqual(['BusRd', 0, 'flush', 3, 3, 'S']);
    expect(e.snoops).toEqual([{ core: 0, from: 'M', to: 'S' }]);
    e = s.write(1, 4);
    expect(e.bus).toBe('BusUpgr');
    e = s.write(0, 5);
    expect([e.bus, e.flushedBy, e.self.from, e.self.to]).toEqual(['BusRdX', 1, 'I', 'M']);
    expect(e.snoops).toEqual([{ core: 1, from: 'M', to: 'I' }]);
    expect(e.memoryValue).toBe(4);
  });

  it('E 到 M 不上总线', () => {
    const s = new MesiSystem(2, 0x80);
    s.read(0);
    const e = s.write(0, 9);
    expect([e.silent, e.bus, e.self.from, e.self.to]).toEqual([true, null, 'E', 'M']);
  });

  it('不变量：随机读写下单写者、多读者，读到的永远是最新值', () => {
    const s = new MesiSystem(4, 0x80);
    let latest = 0;
    let seed = 31337;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 20000; i++) {
      const core = next() % 4;
      if (next() % 2) {
        latest = next();
        s.write(core, latest);
      } else {
        expect(s.read(core).value).toBe(latest);
      }
      const states = s.lines.map((line) => line.state);
      const owners = states.filter((state) => state === 'M' || state === 'E').length;
      expect(owners).toBeLessThanOrEqual(1);
      if (owners === 1) expect(states.filter((state) => state === 'S').length).toBe(0);
      expect(s.latest()).toBe(latest);
    }
  });
});

describe('DRAM 时序', () => {
  // DDR4-3200AA：tCK 0.625 ns，CL-tRCD-tRP = 22-22-22，tRAS 32 ns = 52 nCK（厂商数据手册）。
  const timing = { tRCD: 22, tCL: 22, tRP: 22, tRAS: 52, burst: 4, tCK: 0.625 };
  const geometry = { rowBits: 15, bankBits: 4, columnBits: 10, byteBits: 3 };
  const address = (row: number, bank: number, column: number) => ((row * 2 ** 17) + bank * 2 ** 13 + column * 8) >>> 0;

  it('地址拆分', () => {
    expect(splitDramAddress(address(0x1234, 5, 0x2a) + 3, geometry)).toEqual({ row: 0x1234, bank: 5, column: 0x2a, byte: 3 });
  });

  it('行未打开：tRCD + CL = 44 时钟，27.5 ns', () => {
    const m = new DramBankModel(timing, geometry);
    const r = m.read(address(7, 0, 1), 0);
    expect(r.outcome).toBe('row-closed');
    expect(r.commands.map((c) => [c.command, c.cycle])).toEqual([['ACT', 0], ['RD', 22]]);
    expect(r.latency).toBe(44);
    expect(r.latency * timing.tCK).toBe(27.5);
    expect(r.dataEnd).toBe(48);
  });

  it('行命中：只要 CL = 22 时钟', () => {
    const m = new DramBankModel(timing, geometry);
    m.read(address(7, 0, 1), 0);
    const r = m.read(address(7, 0, 2), 48);
    expect(r.outcome).toBe('row-hit');
    expect(r.latency).toBe(22);
  });

  it('行冲突：等够 tRAS 后 PRE、tRP、ACT、tRCD、RD、CL', () => {
    const m = new DramBankModel(timing, geometry);
    m.read(address(7, 0, 1), 0);
    const late = m.read(address(9, 0, 1), 100);
    expect(late.outcome).toBe('row-conflict');
    expect(late.commands.map((c) => [c.command, c.cycle])).toEqual([['PRE', 100], ['ACT', 122], ['RD', 144]]);
    expect(late.latency).toBe(66);
    const m2 = new DramBankModel(timing, geometry);
    m2.read(address(7, 0, 1), 0);
    const early = m2.read(address(9, 0, 1), 30);
    expect(early.commands[0]).toMatchObject({ command: 'PRE', cycle: 52 });
  });

  it('不同 bank 互不影响', () => {
    const m = new DramBankModel(timing, geometry);
    m.read(address(7, 0, 1), 0);
    expect(m.read(address(9, 1, 1), 4).outcome).toBe('row-closed');
    expect(m.read(address(7, 0, 2), 50).outcome).toBe('row-hit');
  });
});

describe('总线和 DMA', () => {
  const config = { words: 4, destination: 0x100, source: (i: number) => 0xa0 + i, deviceInterval: 4, cpuBusEvery: 3, setupWrites: 3 };

  it('两种方式搬来的数据相同', () => {
    const pio = runPio(config);
    const dma = runDma(config);
    for (let i = 0; i < 4; i++) {
      expect(pio.memory.loadWord(0x100 + i * 4)).toBe(0xa0 + i);
      expect(dma.memory.loadWord(0x100 + i * 4)).toBe(0xa0 + i);
    }
  });

  it('PIO 手算：CPU 每个周期都在忙', () => {
    const pio = runPio(config);
    expect(pio.cpuFreeCycles).toBe(0);
    expect(pio.cpuTransferCycles).toBe(pio.totalCycles);
    expect(pio.log.filter((c) => c.action.startsWith('读设备')).length).toBe(4);
    expect(pio.log.filter((c) => c.action.startsWith('写内存')).length).toBe(4);
  });

  it('DMA 手算：3 次编程，之后每 4 拍偷 1 拍', () => {
    const dma = runDma({ ...config, cpuBusEvery: 1000 });
    expect(dma.log.slice(0, 3).every((c) => c.owner === 'CPU')).toBe(true);
    expect(dma.log.filter((c) => c.owner === 'DMA').map((c) => c.cycle)).toEqual([7, 11, 15, 19]);
    expect(dma.totalCycles).toBe(19);
    expect(dma.interruptAt).toBe(20);
    expect(dma.dmaBusCycles).toBe(4);
  });

  it('每个周期只有一个主设备占总线，DMA 优先', () => {
    const dma = runDma({ ...config, deviceInterval: 3, cpuBusEvery: 3 });
    const conflicts = dma.log.filter((c) => c.waiting);
    expect(conflicts.length).toBeGreaterThan(0);
    for (const item of conflicts) expect(item.owner).toBe('DMA');
    expect(dma.cpuBusWaits).toBe(conflicts.length);
  });
});
