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

export type BoothOp = 'add' | 'sub' | 'none';

export interface BoothIteration {
  index: number;
  /** 这一拍看的两位：Q 的最低位和上一拍移出的 Q-1。 */
  q0: number;
  qm1: number;
  /** 10 减被乘数，01 加被乘数，00 和 11 不动。 */
  op: BoothOp;
  /** 这一拍开始时的 A。 */
  aBefore: number;
  /** 加减之后、移位之前的 A。 */
  aAfterOp: number;
  /** 做加减的门级加法器，宽度比 A 多 1 位；不动时为 null。 */
  add: AddResult | null;
  /** A : Q : Q-1 一起算术右移一位之后。 */
  a: number;
  q: number;
  qm1Out: number;
}

export interface BoothResult {
  width: number;
  multiplicand: number;
  multiplier: number;
  iterations: BoothIteration[];
  /** 积的高、低两半，各 width 位。 */
  high: number;
  low: number;
  /** 按补码读的完整积。 */
  product: number;
}

/**
 * Radix-2 Booth 乘法器：被乘数 M、累加器 A、乘数 Q 和附加位 Q-1，width 拍做完。
 * 每拍看 Q0 Q-1：10 时 A = A - M，01 时 A = A + M，然后 A : Q : Q-1 一起算术右移一位。
 * 加减器内部比 A 多 1 位符号位，被乘数是最小负数（比如 8 位的 -128）时也不会溢出；
 * A 的值只取低 width 位，就是积的高半部分。width 最大 30，保证位运算不越过 32 位。
 */
export function boothMul(multiplicand: number, multiplier: number, width = 8): BoothResult {
  if (width < 2 || width > 30) throw new Error(`Booth 乘法器的宽度越界：${width}`);
  const m = mask(width);
  const wide = width + 1;
  const mVal = (multiplicand & m) >>> 0;
  const mWide = (toSigned(mVal, width) & mask(wide)) >>> 0;
  let a = 0;
  let q = (multiplier & m) >>> 0;
  let qm1 = 0;
  const iterations: BoothIteration[] = [];
  for (let index = 0; index < width; index++) {
    const q0 = q & 1;
    const qm1In = qm1;
    const op: BoothOp = q0 === 1 && qm1In === 0 ? 'sub' : q0 === 0 && qm1In === 1 ? 'add' : 'none';
    const aBefore = a;
    const add = op === 'add' ? rippleAdd(a, mWide, 0, wide) : op === 'sub' ? rippleSub(a, mWide, wide) : null;
    const aAfterOp = add ? add.sum : a;
    // 算术右移：A 的最低位移进 Q 的最高位，Q 的最低位移进 Q-1，A 的符号位原样保留。
    const sign = (aAfterOp >>> (wide - 1)) & 1;
    qm1 = q0;
    q = ((q >>> 1) | ((aAfterOp & 1) << (width - 1))) >>> 0;
    a = ((aAfterOp >>> 1) | (sign << (wide - 1))) >>> 0;
    iterations.push({ index, q0, qm1: qm1In, op, aBefore: (aBefore & m) >>> 0, aAfterOp: (aAfterOp & m) >>> 0, add, a: (a & m) >>> 0, q, qm1Out: qm1 });
  }
  return { width, multiplicand: mVal, multiplier: (multiplier & m) >>> 0, iterations, high: (a & m) >>> 0, low: q, product: toSigned(a, wide) * 2 ** width + q };
}

/** Booth 重编码：第 i 位的数字是 Q[i-1] - Q[i]（Q[-1] = 0），取值 -1、0、1，按 2^i 加权后等于按补码读的乘数。 */
export function boothDigits(multiplier: number, width = 8): number[] {
  const digits: number[] = [];
  let previous = 0;
  for (let bit = 0; bit < width; bit++) {
    const current = (multiplier >>> bit) & 1;
    digits.push(previous - current);
    previous = current;
  }
  return digits;
}
