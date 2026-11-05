import { describe, expect, it } from 'vitest';
import { cacheAddressLayer, concept, dramAddressLayer, floatLayer, instructionLayer, registers, segTone, wire } from '../src/decode/structures';
import { decode, type Decoded } from '../src/decode/writer';
import { splitAddress } from '../src/sim/cache';
import { splitDramAddress } from '../src/sim/dram';
import { assemble } from '../src/sim/riscv';

const frameOf = (...layers: Parameters<typeof wire> extends [string, string, string, ...infer L] ? L : never) => decode(wire('测试', 'mem', 'spec', ...(layers as never[])));

const fieldBits = (frame: Decoded, prefix: string) => {
  const field = frame.fields.find((item) => item.name.startsWith(prefix));
  if (!field?.bits) throw new Error(`找不到位字段 ${prefix}`);
  return field.bits.ranges;
};
const fieldValue = (frame: Decoded, prefix: string) => frame.fields.find((item) => item.name.startsWith(prefix))!.value;

describe('指令解码到位级（黄金向量，来自 LLVM 汇编结果）', () => {
  it('add x3, x1, x2 = 0x002081b3：R 型字段和内存字节', () => {
    const frame = frameOf(instructionLayer(0x002081b3, { text: 'add x3, x1, x2' }));
    expect(frame.bytes).toEqual([0xb3, 0x81, 0x20, 0x00]);
    expect(frame.words[0]).toMatchObject({ width: 32, value: 0x002081b3 });
    expect(fieldValue(frame, 'opcode')).toBe('0110011');
    expect(fieldValue(frame, 'rd')).toBe('x3（00011）');
    expect(fieldValue(frame, 'funct3')).toBe('000');
    expect(fieldValue(frame, 'rs1')).toBe('x1（00001）');
    expect(fieldValue(frame, 'rs2')).toBe('x2（00010）');
    expect(fieldValue(frame, 'funct7')).toBe('0000000');
    expect(fieldBits(frame, 'opcode')).toEqual([[6, 0]]);
    expect(fieldBits(frame, 'rd')).toEqual([[11, 7]]);
    expect(fieldBits(frame, 'funct3')).toEqual([[14, 12]]);
    expect(fieldBits(frame, 'rs1')).toEqual([[19, 15]]);
    expect(fieldBits(frame, 'rs2')).toEqual([[24, 20]]);
    expect(fieldBits(frame, 'funct7')).toEqual([[31, 25]]);
  });

  it('sub 和 add 只差 inst[30]', () => {
    const [add, sub] = assemble(['add x3, x1, x2', 'sub x3, x1, x2']);
    expect((add ^ sub) >>> 0).toBe(1 << 30);
  });

  it('beq x5, x6, -4096 = 0x80628063：B 型四段立即数', () => {
    const frame = frameOf(instructionLayer(0x80628063, { text: 'beq' }));
    expect(fieldBits(frame, 'imm[12]')).toEqual([[31, 31]]);
    expect(fieldBits(frame, 'imm[10:5]')).toEqual([[30, 25]]);
    expect(fieldBits(frame, 'imm[4:1]')).toEqual([[11, 8]]);
    expect(fieldBits(frame, 'imm[11]')).toEqual([[7, 7]]);
    expect(fieldValue(frame, 'imm[12]')).toBe('1');
    expect(fieldValue(frame, '立即数')).toContain('-4096');
  });

  it('jal x1, 2048 = 0x001000ef：J 型只有 imm[11] 为 1，在 inst[20]', () => {
    const frame = frameOf(instructionLayer(0x001000ef, { text: 'jal' }));
    expect(fieldBits(frame, 'imm[20]')).toEqual([[31, 31]]);
    expect(fieldBits(frame, 'imm[10:1]')).toEqual([[30, 21]]);
    expect(fieldBits(frame, 'imm[11]')).toEqual([[20, 20]]);
    expect(fieldBits(frame, 'imm[19:12]')).toEqual([[19, 12]]);
    expect(fieldValue(frame, 'imm[11]')).toBe('1');
    expect(fieldValue(frame, 'imm[10:1]')).toBe('0000000000');
    expect(fieldValue(frame, '立即数')).toContain('2048');
  });

  it('sw x6, -20(x2) 的 S 型立即数', () => {
    const frame = frameOf(instructionLayer(assemble(['sw x6, -20(x2)'])[0], { text: 'sw' }));
    expect(fieldBits(frame, 'imm[11:5]')).toEqual([[31, 25]]);
    expect(fieldBits(frame, 'imm[4:0]')).toEqual([[11, 7]]);
    expect(fieldValue(frame, '立即数')).toContain('-20');
  });

  it('移位立即数：高 7 位是 funct7，不是立即数', () => {
    const frame = frameOf(instructionLayer(assemble(['srai x5, x6, 3'])[0]));
    expect(fieldValue(frame, 'funct7')).toBe('0100000');
    expect(fieldValue(frame, 'shamt')).toBe('00011');
  });

  it('每个位字段的字节范围都包住它的位', () => {
    const frame = frameOf(instructionLayer(0x80628063));
    for (const field of frame.fields) {
      if (!field.bits) continue;
      for (const [hi, lo] of field.bits.ranges) {
        expect(field.from).toBeLessThanOrEqual(lo >> 3);
        expect(field.to).toBeGreaterThanOrEqual((hi >> 3) + 1);
      }
    }
  });

  it('每种字段的颜色各不相同的部分：rs1、rs2、rd 能一眼区分', () => {
    expect(new Set([segTone('rs1'), segTone('rs2'), segTone('rd')]).size).toBe(3);
  });
});

describe('浮点解码', () => {
  it('-0.1 = 0xBDCCCCCD 的符号、阶码、尾数', () => {
    const frame = frameOf(floatLayer(0xbdcccccd, '-0.1'));
    expect(frame.bytes).toEqual([0xcd, 0xcc, 0xcc, 0xbd]);
    expect(fieldBits(frame, '符号')).toEqual([[31, 31]]);
    expect(fieldBits(frame, '阶码')).toEqual([[30, 23]]);
    expect(fieldBits(frame, '尾数')).toEqual([[22, 0]]);
    expect(fieldValue(frame, '符号')).toBe('1');
    expect(fieldValue(frame, '阶码')).toBe('01111011 = 123');
    expect(fieldValue(frame, '尾数')).toBe('10011001100110011001101 = 0x4ccccd');
  });

  it('1.0 = 0x3F800000', () => {
    const frame = frameOf(floatLayer(0x3f800000, '1.0'));
    expect(fieldValue(frame, '阶码')).toBe('01111111 = 127');
    expect(frame.fields.find((item) => item.name.startsWith('阶码'))?.note).toContain('127 = 0');
  });
});

describe('缓存地址解码', () => {
  it('0x1234：4 组 16 字节块', () => {
    const parts = splitAddress(0x1234, { sets: 4, blockBytes: 16 });
    const frame = frameOf(cacheAddressLayer(0x1234, parts));
    expect(frame.bytes).toEqual([0x34, 0x12, 0, 0]);
    expect(fieldBits(frame, '标记')).toEqual([[31, 6]]);
    expect(fieldBits(frame, '组索引')).toEqual([[5, 4]]);
    expect(fieldBits(frame, '块内偏移')).toEqual([[3, 0]]);
    expect(fieldValue(frame, '标记')).toBe('0x48');
    expect(fieldValue(frame, '组索引')).toBe('3');
    expect(fieldValue(frame, '块内偏移')).toBe('4');
  });
});

describe('DRAM 地址解码', () => {
  it('行 / bank / 列 / 字节铺满 32 位', () => {
    const geometry = { rowBits: 15, bankBits: 4, columnBits: 10, byteBits: 3 };
    const address = 0x34560128;
    const frame = frameOf(dramAddressLayer(address, splitDramAddress(address, geometry), geometry));
    expect(fieldBits(frame, '行')).toEqual([[31, 17]]);
    expect(fieldBits(frame, 'bank')).toEqual([[16, 13]]);
    expect(fieldBits(frame, '列')).toEqual([[12, 3]]);
    expect(fieldBits(frame, '字节')).toEqual([[2, 0]]);
  });
});

describe('寄存器和概念层', () => {
  it('寄存器每项 4 字节，小端', () => {
    const frame = frameOf(registers('r', [['x1', 0x12345678]]));
    expect(frame.bytes).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(frame.fields[0].value).toBe('0x12345678');
  });

  it('概念层没有字节', () => {
    expect(frameOf(concept('c', [['a', '1']])).bytes).toEqual([]);
  });

  it('多层拼接时，字的编号和字段偏移都换算到整体坐标', () => {
    const frame = frameOf(instructionLayer(0x002081b3), floatLayer(0x3f800000, 'f'));
    expect(frame.words.length).toBe(2);
    expect(frame.words[1].from).toBe(4);
    const sign = frame.fields.find((item) => item.name.startsWith('符号'))!;
    expect(sign.bits?.word).toBe(1);
    expect(sign.from).toBe(7);
  });
});
