/** IEEE 754 binary32 的编码、解码和加法。全部用整数运算实现，不借助 Float32Array。 */

export const EXP_BIAS = 127;

export type FloatClass = 'zero' | 'subnormal' | 'normal' | 'infinity' | 'nan';

export interface FloatFields {
  bits: number;
  sign: number;
  /** 8 位原始阶码。 */
  exponent: number;
  /** 23 位尾数。 */
  fraction: number;
  kind: FloatClass;
  /** 真实指数：规格数是 exponent - 127，非规格数固定 -126。 */
  power: number;
  /** 含隐藏位的 24 位有效数字。 */
  significand: number;
}

export function fieldsOf(bits: number): FloatFields {
  const b = bits >>> 0;
  const sign = b >>> 31;
  const exponent = (b >>> 23) & 0xff;
  const fraction = b & 0x7fffff;
  let kind: FloatClass = 'normal';
  if (exponent === 0xff) kind = fraction ? 'nan' : 'infinity';
  else if (exponent === 0) kind = fraction ? 'subnormal' : 'zero';
  const hidden = kind === 'normal' ? 1 << 23 : 0;
  return { bits: b, sign, exponent, fraction, kind, power: exponent === 0 ? -126 : exponent - EXP_BIAS, significand: hidden | fraction };
}

export const pack = (sign: number, exponent: number, fraction: number): number => ((sign << 31) | (exponent << 23) | fraction) >>> 0;

/** 取 double 的精确分解：value = (-1)^sign × mant × 2^exp，mant 是整数。 */
function splitDouble(value: number): { sign: number; mant: bigint; exp: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const raw = view.getBigUint64(0);
  const sign = Number(raw >> 63n);
  const e = Number((raw >> 52n) & 0x7ffn);
  const f = raw & 0xfffffffffffffn;
  return e === 0 ? { sign, mant: f, exp: -1074 } : { sign, mant: f | (1n << 52n), exp: e - 1075 };
}

export interface EncodeTrace {
  input: number;
  /** 规格化之前，真实指数。 */
  power: number;
  /** 舍入前 24 位有效数字。 */
  truncated: number;
  guard: number;
  sticky: number;
  roundedUp: boolean;
  bits: number;
}

/** 把任意 double 编码成 binary32，就近舍入、平局取偶。 */
export function encodeTrace(value: number): EncodeTrace {
  if (Number.isNaN(value)) return { input: value, power: 0, truncated: 0, guard: 0, sticky: 0, roundedUp: false, bits: 0x7fc00000 };
  const { sign, mant, exp } = splitDouble(value);
  if (!Number.isFinite(value)) return { input: value, power: 0, truncated: 0, guard: 0, sticky: 0, roundedUp: false, bits: pack(sign, 0xff, 0) };
  if (mant === 0n) return { input: value, power: 0, truncated: 0, guard: 0, sticky: 0, roundedUp: false, bits: pack(sign, 0, 0) };
  const length = mant.toString(2).length;
  const power = exp + length - 1;
  // 规格数保留 24 位；太小时最多只能到 2^-149 这一位。
  const lowest = Math.max(power - 23, -149);
  const drop = lowest - exp;
  let kept: bigint;
  let guard = 0n;
  let sticky = 0n;
  if (drop <= 0) kept = mant << BigInt(-drop);
  else {
    const shift = BigInt(drop);
    kept = mant >> shift;
    guard = (mant >> (shift - 1n)) & 1n;
    sticky = mant & ((1n << (shift - 1n)) - 1n) ? 1n : 0n;
  }
  const truncated = Number(kept);
  const roundedUp = guard === 1n && (sticky === 1n || (kept & 1n) === 1n);
  if (roundedUp) kept += 1n;
  let significand = kept;
  let scale = lowest;
  if (significand >= 1n << 24n) {
    significand >>= 1n;
    scale += 1;
  }
  const trace = { input: value, power, truncated, guard: Number(guard), sticky: Number(sticky), roundedUp };
  if (significand < 1n << 23n) return { ...trace, bits: pack(sign, 0, Number(significand)) };
  const biased = scale + 23 + EXP_BIAS;
  if (biased >= 0xff) return { ...trace, bits: pack(sign, 0xff, 0) };
  return { ...trace, bits: pack(sign, biased, Number(significand & 0x7fffffn)) };
}

export const encodeFloat = (value: number): number => encodeTrace(value).bits;

/** 把 binary32 解码回 double（binary32 的每个值都能被 double 精确表示）。 */
export function decodeFloat(bits: number): number {
  const f = fieldsOf(bits);
  if (f.kind === 'nan') return NaN;
  const signed = f.sign ? -1 : 1;
  if (f.kind === 'infinity') return signed * Infinity;
  return signed * f.significand * 2 ** (f.power - 23);
}

export interface AddTrace {
  a: FloatFields;
  b: FloatFields;
  /** 特殊值直接给结果，不走下面的步骤。 */
  special: boolean;
  /** 指数较大的操作数在前。 */
  big: FloatFields;
  small: FloatFields;
  shift: number;
  /** 带 3 位保护位（G、R、S）的 27 位有效数字。 */
  bigSig: number;
  smallSig: number;
  smallAligned: number;
  /** 对齐时移出去且被 S 粘住的位。 */
  lost: boolean;
  /** 符号相同相加，相反相减。 */
  subtract: boolean;
  rawSum: number;
  rawPower: number;
  normalized: number;
  normalizedPower: number;
  guard: number;
  round: number;
  sticky: number;
  roundedUp: boolean;
  bits: number;
}

const GRS = 3;

function emptyAdd(a: FloatFields, b: FloatFields, bits: number): AddTrace {
  return {
    a, b, special: true, big: a, small: b, shift: 0, bigSig: 0, smallSig: 0, smallAligned: 0, lost: false, subtract: false,
    rawSum: 0, rawPower: 0, normalized: 0, normalizedPower: 0, guard: 0, round: 0, sticky: 0, roundedUp: false, bits,
  };
}

/** 真实的浮点加法器：对阶、相加、规格化、舍入。 */
export function addTrace(aBits: number, bBits: number): AddTrace {
  const a = fieldsOf(aBits);
  const b = fieldsOf(bBits);
  if (a.kind === 'nan' || b.kind === 'nan') return emptyAdd(a, b, 0x7fc00000);
  if (a.kind === 'infinity' && b.kind === 'infinity') return emptyAdd(a, b, a.sign === b.sign ? a.bits : 0x7fc00000);
  if (a.kind === 'infinity') return emptyAdd(a, b, a.bits);
  if (b.kind === 'infinity') return emptyAdd(a, b, b.bits);
  if (a.kind === 'zero' && b.kind === 'zero') return emptyAdd(a, b, a.sign && b.sign ? 0x80000000 : 0);

  const swap = b.power > a.power || (b.power === a.power && b.significand > a.significand);
  const big = swap ? b : a;
  const small = swap ? a : b;
  const shift = big.power - small.power;
  const bigSig = big.significand * 2 ** GRS;
  const smallSig = small.significand * 2 ** GRS;
  // 对齐：右移并把移出的位或进最低位（粘滞位）。
  let smallAligned: number;
  let lost = false;
  if (shift >= 27) {
    smallAligned = smallSig ? 1 : 0;
    lost = smallSig !== 0;
  } else {
    const divisor = 2 ** shift;
    const kept = Math.floor(smallSig / divisor);
    lost = kept * divisor !== smallSig;
    smallAligned = lost ? (kept % 2 === 1 ? kept : kept + 1) : kept;
  }
  const subtract = a.sign !== b.sign;
  const raw = subtract ? bigSig - smallAligned : bigSig + smallAligned;
  const base: Omit<AddTrace, 'normalized' | 'normalizedPower' | 'guard' | 'round' | 'sticky' | 'roundedUp' | 'bits'> = {
    a, b, special: false, big, small, shift, bigSig, smallSig, smallAligned, lost, subtract, rawSum: raw, rawPower: big.power,
  };
  if (raw === 0) {
    return { ...base, normalized: 0, normalizedPower: 0, guard: 0, round: 0, sticky: 0, roundedUp: false, bits: 0 };
  }

  // 规格化：让最高有效位落在第 26 位（隐藏位 + GRS 的位置）。
  let norm = raw;
  let power = big.power;
  while (norm >= 2 ** 27) {
    norm = norm % 2 === 1 ? (norm - 1) / 2 + (((norm - 1) / 2) % 2 === 1 ? 0 : 1) : norm / 2;
    power += 1;
  }
  while (norm < 2 ** 26 && power > -126) {
    norm *= 2;
    power -= 1;
  }
  const low = norm % 8;
  const guard = (low >> 2) & 1;
  const round = (low >> 1) & 1;
  const sticky = low & 1;
  let sig = Math.floor(norm / 8);
  const roundedUp = guard === 1 && (round === 1 || sticky === 1 || sig % 2 === 1);
  if (roundedUp) sig += 1;
  if (sig >= 2 ** 24) {
    sig /= 2;
    power += 1;
  }
  const result = { ...base, normalized: norm, normalizedPower: power, guard, round, sticky, roundedUp };
  if (sig < 2 ** 23) return { ...result, bits: pack(big.sign, 0, sig) };
  const biased = power + EXP_BIAS;
  if (biased >= 0xff) return { ...result, bits: pack(big.sign, 0xff, 0) };
  return { ...result, bits: pack(big.sign, biased, sig - 2 ** 23) };
}
