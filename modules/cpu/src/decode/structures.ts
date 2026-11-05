import type { Color } from '../lessons/types';
import { fieldsOf, type FloatFields } from '../sim/float';
import { bitString, decode, hex32, segmentsOf, type BitSegment, type Decoded } from '../sim/riscv';
import { COUNTER_NAMES } from '../sim/predictor';
import { hex, LayerWriter, type Fidelity, type FieldOptions, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '') => new LayerWriter(`l${serial++}`, name, color, summary);

/** 概念结构：只有字段，没有字节。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}

export type RegEntry = [reg: string, value: number, note?: string, options?: FieldOptions];

/** 寄存器组：每项 4 字节，只是展示容器，不代表它们在内存里相邻。 */
export function registers(name: string, entries: RegEntry[], color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [reg, value, note, options] of entries) {
    layer.field(reg, hex(value, 8), () => layer.u32(value), { note, ...options });
  }
  return layer;
}

// ---------- 指令 ----------

const SEG_TONE: Record<BitSegment['kind'], Color> = { opcode: 'slate', rd: 'green', funct3: 'violet', rs1: 'blue', rs2: 'teal', funct7: 'violet', imm: 'amber' };
export const segTone = (kind: BitSegment['kind']): Color => SEG_TONE[kind];

const OPCODE_NOTE: Record<number, string> = {
  0x33: 'OP：寄存器与寄存器运算',
  0x13: 'OP-IMM：寄存器与立即数运算',
  0x03: 'LOAD：从内存读',
  0x23: 'STORE：写内存',
  0x63: 'BRANCH：条件分支',
  0x6f: 'JAL：跳转并链接',
  0x67: 'JALR：寄存器间接跳转',
  0x37: 'LUI：高 20 位立即数',
  0x17: 'AUIPC：PC 加高 20 位立即数',
};

const IMM_NOTE: Record<string, string> = {
  B: 'B 型把 imm[11] 放在 inst[7]、imm[12] 放在 inst[31]，imm[0] 不存，因为分支目标是 2 字节的倍数。这样 rs1、rs2 和 S 型位置相同，符号位总在 inst[31]。',
  J: 'J 型的 imm[19:12] 留在 U 型相同的位置，imm[11] 在 inst[20]，imm[10:1] 在 inst[30:21]，imm[0] 不存。',
  S: 'S 型把立即数切成两段，让 rs1、rs2 留在和 R 型相同的位置，解码时可以先读寄存器。',
  I: 'I 型 12 位立即数在 inst[31:20]，按 inst[31] 符号扩展到 32 位。',
  U: 'U 型的 20 位立即数就是结果的高 20 位，低 12 位补 0。',
};

function immText(d: Decoded): string {
  if (d.format === 'U') return `${hex32(d.imm)}（高 20 位 0x${(d.imm >>> 12).toString(16)}）`;
  return `${d.imm}（${hex32(d.imm)}）`;
}

/** 把一条指令解码到位级：opcode、rd、funct3、rs1、rs2、funct7、立即数的每一段。 */
export function instructionLayer(word: number, options: { pc?: number; color?: Color; text?: string } = {}): LayerWriter {
  const d = decode(word);
  const { pc, color = 'blue', text = d.name } = options;
  const layer = makeLayer(`指令 · ${text}`, color, `${d.format} 型${pc === undefined ? '' : `，PC = ${hex(pc, 8)}`}`);
  layer.word('指令字', word, 32, { note: '32 位小端存放，下面逐段拆开。' });
  for (const seg of segmentsOf(d)) {
    const value = (word >>> seg.lo) & (2 ** (seg.hi - seg.lo + 1) - 1);
    const bits = bitString(value, seg.hi - seg.lo + 1);
    let shown = bits;
    let note: string | undefined;
    if (seg.kind === 'opcode') note = OPCODE_NOTE[value];
    if (seg.kind === 'rd') shown = `x${value}（${bits}）`;
    if (seg.kind === 'rs1' || seg.kind === 'rs2') shown = `x${value}（${bits}）`;
    if (seg.kind === 'funct7' && d.opcode === 0x33 && value === 0x20) note = 'inst[30] = 1 让 ALU 做减法或算术右移。';
    if (seg.kind === 'funct7' && value === 0x01) note = '0000001 表示 M 扩展的乘除法。';
    if (seg.kind === 'imm' && seg.immHi !== undefined) note = `这几位放的是立即数的 [${seg.immHi}:${seg.immLo}] 位。`;
    layer.bitField(`${seg.name}  inst[${seg.hi}${seg.hi === seg.lo ? '' : `:${seg.lo}`}]`, shown, [[seg.hi, seg.lo]], { note, tone: SEG_TONE[seg.kind] });
  }
  if (d.format !== 'R') {
    const ranges = segmentsOf(d).filter((seg) => seg.kind === 'imm').map((seg): [number, number] => [seg.hi, seg.lo]);
    if (ranges.length) layer.bitField('立即数（还原后）', immText(d), ranges, { note: IMM_NOTE[d.format], tone: 'amber', depth: 0 });
  }
  return layer;
}

/** 一个有符号或无符号的小整数，用来讲补码和加法器。 */
export function intLayer(name: string, value: number, width: number, color: Color = 'blue', signedValue?: number): LayerWriter {
  const layer = makeLayer(name, color, `${width} 位`);
  layer.word(name, value, width);
  layer.bitField('符号位', (value >>> (width - 1)) & 1, [[width - 1, width - 1]], { note: `补码里这一位的权重是 -2^${width - 1}。`, tone: 'violet' });
  layer.bitField('其余位', bitString(value, width - 1), [[width - 2, 0]], { tone: color });
  if (signedValue !== undefined) layer.field('按补码读', String(signedValue));
  return layer;
}

/** 一位全加器的门级计算。 */
export function fullAdderLayer(bit: { bit: number; a: number; b: number; cin: number; p: number; g: number; sum: number; cout: number; sumAt: number; coutAt: number }): LayerWriter {
  return concept(`全加器 #${bit.bit}`, [
    ['输入', `A=${bit.a} B=${bit.b} Cin=${bit.cin}`],
    ['p = A XOR B', String(bit.p), '传播：这一位会把进位传下去。'],
    ['g = A AND B', String(bit.g), '产生：这一位自己就产生进位。'],
    ['S = p XOR Cin', String(bit.sum), `最晚第 ${bit.sumAt} 个门延迟稳定。`],
    ['Cout = g OR (p AND Cin)', String(bit.cout), `最晚第 ${bit.coutAt} 个门延迟稳定。`],
  ], 'green');
}

// ---------- 浮点 ----------

const KIND_TEXT: Record<FloatFields['kind'], string> = { zero: '零', subnormal: '次正规数', normal: '规格化数', infinity: '无穷大', nan: 'NaN' };

/** IEEE 754 binary32：符号、阶码、尾数。 */
export function floatLayer(bits: number, name: string, color: Color = 'blue', valueText?: string): LayerWriter {
  const f = fieldsOf(bits);
  const layer = makeLayer(name, color, `${KIND_TEXT[f.kind]}${valueText ? ` · ${valueText}` : ''}`);
  layer.word('binary32', bits, 32, { note: '按小端存放时最低字节在前。' });
  layer.bitField('符号 S  [31]', f.sign, [[31, 31]], { note: f.sign ? '1：负数' : '0：正数', tone: 'violet' });
  layer.bitField('阶码 E  [30:23]', `${bitString(f.exponent, 8)} = ${f.exponent}`, [[30, 23]], {
    note: f.kind === 'normal' ? `偏移 127，真实指数 ${f.exponent} - 127 = ${f.power}` : f.exponent === 0 ? '全 0：零或次正规数，真实指数固定为 -126，没有隐藏的 1。' : '全 1：无穷大或 NaN。',
    tone: 'amber',
  });
  layer.bitField('尾数 F  [22:0]', `${bitString(f.fraction, 23)} = 0x${f.fraction.toString(16)}`, [[22, 0]], {
    note: f.kind === 'normal' ? `隐藏位是 1，有效数字 1.F = 0x${f.significand.toString(16)} / 2^23。` : undefined,
    tone: 'teal',
  });
  return layer;
}

// ---------- 缓存地址 ----------

export function cacheAddressLayer(address: number, parts: { tag: number; index: number; offset: number; tagBits: number; indexBits: number; offsetBits: number }, color: Color = 'blue'): LayerWriter {
  const layer = makeLayer('地址拆分', color, `标记 ${parts.tagBits} 位 · 组索引 ${parts.indexBits} 位 · 块内偏移 ${parts.offsetBits} 位`);
  layer.word('地址', address, 32, { example: true });
  layer.bitField(`标记 tag  [31:${parts.indexBits + parts.offsetBits}]`, hex(parts.tag), [[31, parts.indexBits + parts.offsetBits]], { note: '和组内每一路存的标记比较，相等且有效才算命中。', tone: 'violet' });
  layer.bitField(`组索引 index  [${parts.indexBits + parts.offsetBits - 1}:${parts.offsetBits}]`, parts.index, [[parts.indexBits + parts.offsetBits - 1, parts.offsetBits]], { note: '选中缓存的第几组。', tone: 'amber' });
  layer.bitField(`块内偏移 offset  [${parts.offsetBits - 1}:0]`, parts.offset, [[parts.offsetBits - 1, 0]], { note: '选中块内第几个字节。', tone: 'teal' });
  return layer;
}

export interface LineFields {
  valid: boolean;
  dirty: boolean;
  tag: number;
  data: number[];
}

/** 一条缓存行：有效位、脏位、标记和块里的真实字节。 */
export function cacheLineLayer(name: string, line: LineFields, options: { color?: Color; summary?: string; note?: string } = {}): LayerWriter {
  const { color = 'green', summary = '', note } = options;
  const layer = makeLayer(name, color, summary);
  layer.field('V 有效位', line.valid ? 1 : 0, () => layer.u8(line.valid ? 1 : 0), { note });
  layer.field('D 脏位', line.dirty ? 1 : 0, () => layer.u8(line.dirty ? 1 : 0));
  layer.field('标记', hex(line.tag), () => layer.u32(line.tag));
  layer.field(`数据块 ${line.data.length} 字节`, line.data.map((byte) => byte.toString(16).padStart(2, '0')).join(' '), () => layer.raw(line.data), { mono: true, example: true });
  return layer;
}

// ---------- DRAM ----------

export function dramAddressLayer(address: number, parts: { row: number; bank: number; column: number; byte: number }, g: { rowBits: number; bankBits: number; columnBits: number; byteBits: number }): LayerWriter {
  const layer = makeLayer('地址映射', 'blue', '示例映射：真实控制器常把高位哈希进 bank，减少行冲突');
  layer.word('物理地址', address, 32, { example: true });
  const low = g.byteBits + g.columnBits;
  const mid = low + g.bankBits;
  layer.bitField(`行 row  [${mid + g.rowBits - 1}:${mid}]`, parts.row, [[mid + g.rowBits - 1, mid]], { note: 'ACT 命令把这一行读进行缓冲。', tone: 'amber' });
  layer.bitField(`bank  [${mid - 1}:${low}]`, parts.bank, [[mid - 1, low]], { note: '每个 bank 有自己的行缓冲，能同时开着不同的行。', tone: 'violet' });
  layer.bitField(`列 column  [${low - 1}:${g.byteBits}]`, parts.column, [[low - 1, g.byteBits]], { note: 'RD 命令从行缓冲里选列。', tone: 'teal' });
  layer.bitField(`字节  [${g.byteBits - 1}:0]`, parts.byte, [[g.byteBits - 1, 0]], { note: '64 位通道一次传 8 字节，低 3 位不上 DRAM 地址线。', tone: 'slate' });
  return layer;
}

/** DDR4 命令引脚电平（低有效）。CS_n 总为低。ACT 时 RAS_n/CAS_n/WE_n 复用为行地址 A16..A14。 */
const DDR4_PINS: Record<'ACT' | 'RD' | 'PRE', { pins: string; note: string }> = {
  ACT: { pins: 'CS_n=L ACT_n=L', note: 'ACT_n 为低时，RAS_n/CAS_n/WE_n 改作行地址 A16、A15、A14。' },
  RD: { pins: 'CS_n=L ACT_n=H RAS_n=H CAS_n=L WE_n=H', note: 'A10 为低，不自动预充电。' },
  PRE: { pins: 'CS_n=L ACT_n=H RAS_n=L CAS_n=H WE_n=L', note: 'A10 为低，只关这一个 bank。' },
};

export function dramCommandLayer(command: 'ACT' | 'RD' | 'PRE', bank: number, row: number, column: number | undefined, why: string): LayerWriter {
  const { pins, note } = DDR4_PINS[command];
  return concept(`DDR4 命令 · ${command}`, [
    ['引脚电平', pins, note],
    ['bank', String(bank)],
    [command === 'RD' ? '列' : '行', String(command === 'RD' ? column ?? 0 : row)],
    ['等待原因', why],
  ], 'amber');
}

// ---------- 预测器 ----------

export function counterLayer(pc: number, index: number, before: number, taken: boolean, after: number): LayerWriter {
  const layer = makeLayer(`预测表项 #${index}`, 'violet', `PC ${hex(pc, 8)} 的低位做索引`);
  layer.word('2 位计数器（更新后）', after, 8);
  layer.bitField('高位 = 预测方向', `${(after >> 1) & 1}：${after >> 1 ? '预测跳' : '预测不跳'}`, [[1, 1]], { tone: 'amber' });
  layer.bitField('低位 = 把握强弱', after & 1, [[0, 0]], { tone: 'teal' });
  layer.field('状态变化', `${COUNTER_NAMES[before]} → ${COUNTER_NAMES[after]}`, undefined, { note: taken ? '实际跳了：计数器加 1，到 3 不再加。' : '实际没跳：计数器减 1，到 0 不再减。' });
  return layer;
}

export { hex };
