/** 门级行波进位加法器、桶形移位器和移位相加乘法器。 */

export interface FullAdderBit {
  bit: number;
  a: number;
  b: number;
  cin: number;
  /** 传播 p = a XOR b，产生 g = a AND b。 */
  p: number;
  g: number;
  sum: number;
  cout: number;
  /** 从输入稳定算起，这一位的和和进位最晚在第几个门延迟后稳定。 */
  sumAt: number;
  coutAt: number;
}

export interface AddResult {
  width: number;
  a: number;
  b: number;
  cin: number;
  bits: FullAdderBit[];
  sum: number;
  carryOut: number;
  /** 最高位进位入和进位出不同，有符号溢出。 */
  overflow: boolean;
  negative: boolean;
  zero: boolean;
  /** 最长路径的门延迟数。 */
  delay: number;
}

const mask = (width: number) => (width === 32 ? 0xffffffff : 2 ** width - 1);

/**
 * 逐位算全加器：sum = p XOR c，cout = g OR (p AND c)。
 * 每个门算 1 个延迟，到达时间取最坏路径，和具体数值无关。
 */
export function rippleAdd(a: number, b: number, cin = 0, width = 8): AddResult {
  const bits: FullAdderBit[] = [];
  let carry = cin & 1;
  let carryAt = 0;
  let sum = 0;
  for (let bit = 0; bit < width; bit++) {
    const x = (a >>> bit) & 1;
    const y = (b >>> bit) & 1;
    const p = x ^ y;
    const g = x & y;
    const s = p ^ carry;
    const cout = g | (p & carry);
    // p、g 各过 1 个门；sum 再过 1 个异或；cout 过与门再过或门。
    const sumAt = Math.max(1, carryAt) + 1;
    const coutAt = Math.max(1, Math.max(1, carryAt) + 1) + 1;
    bits.push({ bit, a: x, b: y, cin: carry, p, g, sum: s, cout, sumAt, coutAt });
    sum = bit === 31 ? (sum + s * 2 ** 31) : sum | (s << bit);
    carry = cout;
    carryAt = coutAt;
  }
  const top = bits[width - 1];
  sum = sum >>> 0;
  return {
    width, a: (a & mask(width)) >>> 0, b: (b & mask(width)) >>> 0, cin: cin & 1, bits, sum,
    carryOut: top.cout,
    overflow: top.cin !== top.cout,
    negative: top.sum === 1,
    zero: sum === 0,
    delay: Math.max(top.sumAt, top.coutAt),
  };
}

/** 减法 = 加上按位取反再加 1。 */
export function rippleSub(a: number, b: number, width = 8): AddResult {
  return rippleAdd(a, ~b & mask(width), 1, width);
}

/** 把宽度为 width 的位串按补码读成有符号数。 */
export function toSigned(value: number, width: number): number {
  const v = value & mask(width);
  if (width === 32) return v | 0;
  return v >= 2 ** (width - 1) ? v - 2 ** width : v;
}

/** 补码的计算过程：取绝对值的二进制，按位取反，再加 1。 */
export function negateSteps(value: number, width = 8): { original: number; inverted: number; negated: number } {
  const m = mask(width);
  const original = value & m;
  const inverted = ~original & m;
  return { original, inverted, negated: rippleAdd(inverted, 1, 0, width).sum };
}

export type ShiftKind = 'SLL' | 'SRL' | 'SRA';

export interface ShiftStage {
  /** 这一层移动的位数：1、2、4、8 或 16。 */
  amount: number;
  /** shamt 的对应位。 */
  enabled: boolean;
  value: number;
}

/** 5 层多路选择器组成的桶形移位器。第 k 层由 shamt 的第 k 位决定是否移 2^k 位。 */
export function barrelShift(value: number, shamt: number, kind: ShiftKind): { stages: ShiftStage[]; result: number } {
  let current = value >>> 0;
  const stages: ShiftStage[] = [];
  for (let level = 0; level < 5; level++) {
    const amount = 1 << level;
    const enabled = ((shamt >>> level) & 1) === 1;
    if (enabled) {
      if (kind === 'SLL') current = (current << amount) >>> 0;
      if (kind === 'SRL') current = current >>> amount;
      if (kind === 'SRA') current = ((current | 0) >> amount) >>> 0;
    }
    stages.push({ amount, enabled, value: current });
  }
  return { stages, result: current };
}

export interface MulIteration {
  index: number;
  /** 这一轮看的乘数最低位。 */
  bit: number;
  multiplicand: number;
  multiplier: number;
  /** 加之后的积。 */
  product: number;
}

/** 迭代式移位相加：每拍看乘数最低位，为 1 就把被乘数加到积上；被乘数左移，乘数右移。乘数变 0 就提前结束。 */
export function shiftAddMul(a: number, b: number): { iterations: MulIteration[]; product: number } {
  let product = 0;
  let multiplicand = a >>> 0;
  let multiplier = b >>> 0;
  const iterations: MulIteration[] = [];
  let index = 0;
  while (multiplier !== 0 && index < 32) {
    const bit = multiplier & 1;
    if (bit) product = (product + multiplicand) >>> 0;
    iterations.push({ index, bit, multiplicand, multiplier, product });
    multiplicand = (multiplicand << 1) >>> 0;
    multiplier = multiplier >>> 1;
    index++;
  }
  return { iterations, product };
}
