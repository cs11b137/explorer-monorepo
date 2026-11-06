/**
 * 个人信息（PII）的识别和脱敏：手机号、邮箱、居民身份证号（带校验码）、银行卡号（带 Luhn 校验）。
 *
 * 校验算法是真实的（来源见 README 事实表）：
 * - 身份证号 18 位：17 位本体码 + 1 位校验码，ISO 7064 MOD 11-2，加权因子 7 9 10 5 8 4 2 1 6 3 7 9 10 5 8 4 2，
 *   校验码 (12 − S mod 11) mod 11，10 写成 X；出生日期（第 7–14 位）还要是真实存在的日期；
 * - 银行卡号用 Luhn（ISO/IEC 7812-1 附录 B）：从右往左每隔一位乘 2，大于 9 的减 9，总和能被 10 整除。
 * 手机号、邮箱的正则是本站写法（中国大陆 11 位手机号 1[3-9] 开头，可以带 +86 和空格、短横线分隔）。
 *
 * 只认长得像、校验也对的号码：长得像但校验不过的记为 valid: false，默认不替换（课程用它讲「校验位能大幅减少误报」）。
 * 下标一律是 UTF-16 的 [from, to)，写字节层时用 utf8 换算。
 */

export type PiiKind = 'phone' | 'email' | 'id_card' | 'bank_card';

export const PII_LABEL: Record<PiiKind, string> = { phone: '手机号', email: '邮箱', id_card: '身份证号', bank_card: '银行卡号' };

export interface PiiHit {
  kind: PiiKind;
  text: string;
  from: number;
  to: number;
  /** 校验码对不对（手机号、邮箱只看格式，总是 true）。 */
  valid: boolean;
  /** 校验不过的原因。 */
  reason?: string;
}

// ---------- 校验 ----------

export const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK = '10X98765432';

/** 身份证号前 17 位的校验码。 */
export function idCheckChar(body: string): string {
  if (!/^\d{17}$/.test(body)) throw new Error('本体码要 17 位数字');
  const s = [...body].reduce((acc, d, i) => acc + Number(d) * ID_WEIGHTS[i], 0);
  return ID_CHECK[s % 11];
}

/** 第 7–14 位是不是存在的日期（YYYYMMDD，1900 年以后）。 */
export function validBirth(yyyymmdd: string): boolean {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 18 位身份证号的检查：格式、出生日期、校验码。返回 null 表示通过，否则是原因。 */
export function idProblem(id: string): string | null {
  if (!/^\d{17}[\dXx]$/.test(id)) return '格式不对';
  if (!validBirth(id.slice(6, 14))) return '出生日期不存在';
  const expect = idCheckChar(id.slice(0, 17));
  return id[17].toUpperCase() === expect ? null : `校验码应为 ${expect}`;
}

/** Luhn 校验位：对不含校验位的数字串算出最后一位。 */
export function luhnCheckDigit(payload: string): number {
  if (!/^\d+$/.test(payload)) throw new Error('只能是数字');
  let total = 0;
  [...payload].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  });
  return (10 - (total % 10)) % 10;
}

/** 整个号码（含校验位）是否通过 Luhn。 */
export const luhnValid = (digits: string): boolean => /^\d{2,}$/.test(digits) && luhnCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1));

// ---------- 识别 ----------

const PATTERNS: Array<{ kind: PiiKind; re: RegExp }> = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { kind: 'id_card', re: /(?<![0-9])\d{17}[\dXx](?![0-9A-Za-z])/g },
  { kind: 'bank_card', re: /(?<![0-9])\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?![0-9])/g },
  { kind: 'phone', re: /(?<![0-9])(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}(?![0-9])/g },
];

const digitsOf = (text: string) => text.replace(/[^0-9Xx]/g, '');

/**
 * 找出全部 PII：按 email → 身份证 → 银行卡 → 手机号的顺序匹配，先匹配到的区间不再给后面的类型（18 位身份证不会再被当成银行卡）。
 * 银行卡去掉分隔符后要 16–19 位；不过 Luhn 的记为 valid: false。结果按位置排序。
 */
export function findPii(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  const taken = (from: number, to: number) => hits.some((h) => from < h.to && h.from < to);
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const from = m.index!;
      const to = from + m[0].length;
      if (taken(from, to)) continue;
      if (kind === 'id_card') {
        const problem = idProblem(m[0]);
        hits.push({ kind, text: m[0], from, to, valid: problem === null, ...(problem ? { reason: problem } : {}) });
      } else if (kind === 'bank_card') {
        const digits = digitsOf(m[0]);
        if (digits.length < 16 || digits.length > 19) continue;
        const ok = luhnValid(digits);
        hits.push({ kind, text: m[0], from, to, valid: ok, ...(ok ? {} : { reason: 'Luhn 校验不通过' }) });
      } else hits.push({ kind, text: m[0], from, to, valid: true });
    }
  }
  return hits.sort((a, b) => a.from - b.from);
}

// ---------- 脱敏 ----------

export type RedactMode = 'tag' | 'mask' | 'pseudonym';

export interface Redaction {
  text: string;
  /** 每处替换：原来的命中、换成了什么、在新文字里的区间。 */
  replacements: Array<{ hit: PiiHit; replacement: string; from: number; to: number }>;
  /** pseudonym 模式的对照表：占位符 → 原文。只留在应用这一侧，不发给模型。 */
  table: Record<string, string>;
}

/** 部分打码：手机号留前 3 后 4，银行卡留后 4，身份证留前 6 后 4，邮箱留首字母和域名。 */
export function maskOf(hit: PiiHit): string {
  const t = hit.text;
  if (hit.kind === 'email') {
    const at = t.indexOf('@');
    return `${t[0]}***${t.slice(at)}`;
  }
  const d = digitsOf(t);
  if (hit.kind === 'phone') {
    const local = d.length > 11 ? d.slice(-11) : d;
    return `${local.slice(0, 3)}****${local.slice(-4)}`;
  }
  if (hit.kind === 'id_card') return `${d.slice(0, 6)}********${d.slice(-4)}`;
  return `**** ${d.slice(-4)}`;
}

/**
 * 替换文字里的 PII（默认只替换 valid 的）：
 * - tag：换成类型名，如「[手机号]」；
 * - mask：部分打码；
 * - pseudonym：换成编号占位符「<手机号_1>」，同一个值同一个编号，对照表留在应用这一侧，模型回答后再用 restore 换回来。
 */
export function redact(text: string, hits: readonly PiiHit[] = findPii(text), mode: RedactMode = 'tag', options: { includeInvalid?: boolean } = {}): Redaction {
  const chosen = hits.filter((h) => h.valid || options.includeInvalid).sort((a, b) => a.from - b.from);
  const table: Record<string, string> = {};
  const counters: Partial<Record<PiiKind, number>> = {};
  const byValue = new Map<string, string>();
  let out = '';
  let at = 0;
  const replacements: Redaction['replacements'] = [];
  for (const hit of chosen) {
    out += text.slice(at, hit.from);
    let replacement: string;
    if (mode === 'tag') replacement = `[${PII_LABEL[hit.kind]}]`;
    else if (mode === 'mask') replacement = maskOf(hit);
    else {
      const key = `${hit.kind}:${hit.text}`;
      if (!byValue.has(key)) {
        counters[hit.kind] = (counters[hit.kind] ?? 0) + 1;
        const placeholder = `<${PII_LABEL[hit.kind]}_${counters[hit.kind]}>`;
        byValue.set(key, placeholder);
        table[placeholder] = hit.text;
      }
      replacement = byValue.get(key)!;
    }
    replacements.push({ hit, replacement, from: out.length, to: out.length + replacement.length });
    out += replacement;
    at = hit.to;
  }
  out += text.slice(at);
  return { text: out, replacements, table };
}

/** 把 pseudonym 占位符换回原文。 */
export function restore(text: string, table: Record<string, string>): string {
  let out = text;
  for (const [placeholder, value] of Object.entries(table)) out = out.split(placeholder).join(value);
  return out;
}
