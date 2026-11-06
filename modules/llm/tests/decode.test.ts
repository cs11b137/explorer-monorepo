/**
 * 逐字节解码：每个写入器写出的字节和规范一致，字段范围正确。
 * 期望字节手算自规范（UTF-8、IEEE 754、ggml 的 block_q4_0 布局），不调用被测的编码函数。
 */
import { describe, expect, it } from 'vitest';
import { concept, floatMatrix, floatVector, num, q4_0Block, q8_0Block, rawBytes, tokenIds, u32Var, utf8Text, wire } from '../src/decode/structures';
import { decode, FIDELITY_TEXT } from '../src/decode/writer';
import { quantizeQ4_0, quantizeQ8_0 } from '../src/model/numeric';

describe('UTF-8 文本', () => {
  it('「大a」：汉字 3 字节，字母 1 字节；多字节字符拆出首字节和续字节', () => {
    const layer = utf8Text('t', '大a');
    expect(layer.bytes).toEqual([0xe5, 0xa4, 0xa7, 0x61]);
    expect(layer.fields.filter((field) => !field.depth).map((field) => [field.name, field.from, field.to])).toEqual([["'大' · +0", 0, 3], ["'a' · +3", 3, 4]]);
    expect(layer.fields.filter((field) => field.depth).map((field) => field.value)).toEqual(['首字节', '续字节', '续字节']);
  });

  it('按组写原始字节，组的总长必须等于原文', () => {
    const layer = rawBytes('b', [1, 2, 3], { groups: [{ name: 'x', bytes: [1, 2] }, { name: 'y', bytes: [3] }] });
    expect(layer.fields.map((field) => [field.from, field.to])).toEqual([[0, 2], [2, 3]]);
    expect(() => rawBytes('b', [1, 2, 3], { groups: [{ name: 'x', bytes: [1] }] })).toThrow();
  });
});

describe('token id', () => {
  it('int32 小端，每个 4 字节', () => {
    const layer = tokenIds('ids', [261, 0x01020304], { labels: (id) => (id === 261 ? '␣token' : '') });
    expect(layer.bytes).toEqual([0x05, 0x01, 0, 0, 0x04, 0x03, 0x02, 0x01]);
    expect(layer.fields[0].value).toBe('261（␣token）');
    expect(layer.name).toBe('int32 ids[2] · 8 字节');
  });

  it('uint32 标量', () => {
    expect(u32Var('n', 0xdeadbeef).bytes).toEqual([0xef, 0xbe, 0xad, 0xde]);
  });
});

describe('浮点', () => {
  it('fp32 / fp16 / bf16 的 1.0 和 −2.0', () => {
    expect(floatVector('x', [1, -2], 'f32').bytes).toEqual([0, 0, 0x80, 0x3f, 0, 0, 0, 0xc0]);
    expect(floatVector('x', [1, -2], 'f16').bytes).toEqual([0, 0x3c, 0, 0xc0]);
    expect(floatVector('x', [1, -2], 'bf16').bytes).toEqual([0x80, 0x3f, 0, 0xc0]);
  });

  it('显示的是存进去之后的值：0.1 存成 fp16 是 0.0999755859375', () => {
    const layer = floatVector('x', [0.1], 'f16', { digits: 10 });
    expect(layer.bytes).toEqual([0x66, 0x2e]);
    expect(layer.fields[0].value).toBe('0.0999755859');
  });

  it('按位展示：符号 1 位、指数、尾数', () => {
    const layer = floatVector('x', [-2], 'f32', { bits: true });
    expect(layer.words).toHaveLength(1);
    const bits = layer.fields.filter((field) => field.bits).map((field) => [field.name, field.value]);
    expect(bits).toEqual([['符号', '负'], ['指数', '128'], ['尾数', '0x0']]);
  });

  it('矩阵按行优先', () => {
    const layer = floatMatrix('W', [[1, 2], [3, 4]], 'f16');
    expect(layer.fields.map((field) => field.name)).toEqual(['W[0][0] · +0', 'W[0][1] · +2', 'W[1][0] · +4', 'W[1][1] · +6']);
    expect(layer.bytes.slice(4, 6)).toEqual([0x00, 0x42]);
  });
});

describe('GGUF 量化块', () => {
  const values = Array.from({ length: 32 }, (_, i) => (i - 16) / 4);

  it('block_q4_0：2 字节 d + 16 字节；低 4 位是第 j 个，高 4 位是第 j+16 个', () => {
    const [block] = quantizeQ4_0(values);
    const layer = q4_0Block('w', block);
    expect(layer.bytes).toHaveLength(18);
    // 最大绝对值是 −4（第 0 个），d = −4 / −8 = 0.5，fp16 是 0x3800。
    expect(layer.bytes.slice(0, 2)).toEqual([0x00, 0x38]);
    // 第 0 个：−4 / 0.5 + 8.5 = 0.5 → 0；第 16 个：0 / 0.5 + 8.5 → 8。字节 = 0 | 8 << 4。
    expect(layer.bytes[2]).toBe(0x80);
    expect(layer.words).toHaveLength(16);
  });

  it('block_q8_0：2 字节 d + 32 个 int8', () => {
    const [block] = quantizeQ8_0(values);
    const layer = q8_0Block('w', block);
    expect(layer.bytes).toHaveLength(34);
    // 第 0 个是 −4，d = 4 / 127，q = −127 → 0x81。
    expect(layer.bytes[2]).toBe(0x81);
  });
});

describe('解码结构', () => {
  it('多层拼接，字段偏移换算到整体', () => {
    const frame = decode(wire('x', 'mem', 'format', utf8Text('a', 'ab'), tokenIds('ids', [7])));
    expect(frame.bytes).toEqual([0x61, 0x62, 7, 0, 0, 0]);
    expect(frame.fields[frame.fields.length - 1]).toMatchObject({ from: 2, to: 6 });
  });

  it('示意结构没有字节', () => {
    expect(decode(wire('x', 'vals', '示意', concept('c', [['a', '1']]))).bytes).toEqual([]);
  });

  it('三种可信度都有说明', () => {
    expect(Object.keys(FIDELITY_TEXT).sort()).toEqual(['format', 'internal', '示意'].sort());
  });

  it('数值显示：最多 4 位小数，负号用 −，极小值用科学计数法', () => {
    expect(num(0.123456)).toBe('0.1235');
    expect(num(-1.5)).toBe('−1.5');
    expect(num(3e-7)).toBe('3.00e−7');
    expect(num(-Infinity)).toBe('−∞');
  });
});
