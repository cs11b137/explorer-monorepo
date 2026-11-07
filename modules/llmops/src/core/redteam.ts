/**
 * 红队测试和偏见检测共用的工具：确定性的「变形」（插空格、全角、零宽字符、拆字换行），按类别统计攻击成功率；
 * 成对提示（只换一个属性，比如姓名）和配对比较（符号检验、bootstrap 区间）。
 *
 * 变形只用来检查规范化和检测器的鲁棒性，是公开讨论过的常见绕过手法，不是真实攻击载荷。
 * 「模型有没有照做」是脚本示例（课程标 E.G.）；被不被拦、成功率、区间、检验真实计算。
 */
import { bootstrap, mean, signTest, wilson, type BootstrapResult, type Interval, type PairedTest } from './stats';

// ---------- 变形 ----------

export type Mutation = 'none' | 'spaced' | 'fullwidth' | 'zero-width' | 'newline';

export const MUTATION_LABEL: Record<Mutation, string> = { none: '原样', spaced: '字间加空格', fullwidth: 'ASCII 换全角', 'zero-width': '插零宽空格', newline: '每 4 个字换行' };

/** 对一段文字做一种变形。fullwidth 只换 ASCII 可见字符（U+0021–U+007E → U+FF01–U+FF5E）。 */
export function mutate(text: string, mutation: Mutation): string {
  const chars = [...text];
  switch (mutation) {
    case 'none':
      return text;
    case 'spaced':
      return chars.join(' ');
    case 'fullwidth':
      return chars.map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c)).join('');
    case 'zero-width':
      return chars.join('\u200B');
    case 'newline':
      return chars.map((c, i) => (i > 0 && i % 4 === 0 ? `\n${c}` : c)).join('');
  }
}

// ---------- 攻击成功率 ----------

export interface AttackCase {
  id: string;
  category: string;
  text: string;
}

export interface AttackOutcome {
  case: AttackCase;
  /** 被防护拦下。 */
  blocked: boolean;
  /** 没被拦、而且模型照做了（示例）。 */
  succeeded: boolean;
}

export interface AttackReport {
  outcomes: AttackOutcome[];
  attempts: number;
  successes: number;
  /** 攻击成功率 ASR = 成功 / 尝试，带 Wilson 95% 区间。 */
  asr: Interval;
  blockRate: Interval;
  byCategory: Record<string, { attempts: number; successes: number; blocked: number }>;
}

/** 跑一组攻击用例：defense 决定拦不拦，complied 决定没拦住时模型照不照做（示例）。 */
export function runAttacks(cases: readonly AttackCase[], defense: (text: string) => boolean, complied: (item: AttackCase) => boolean): AttackReport {
  const outcomes = cases.map((item) => {
    const blocked = defense(item.text);
    return { case: item, blocked, succeeded: !blocked && complied(item) };
  });
  const byCategory: AttackReport['byCategory'] = {};
  for (const o of outcomes) {
    const slot = (byCategory[o.case.category] ??= { attempts: 0, successes: 0, blocked: 0 });
    slot.attempts++;
    if (o.succeeded) slot.successes++;
    if (o.blocked) slot.blocked++;
  }
  const successes = outcomes.filter((o) => o.succeeded).length;
  const blocked = outcomes.filter((o) => o.blocked).length;
  return { outcomes, attempts: cases.length, successes, asr: wilson(successes, cases.length), blockRate: wilson(blocked, cases.length), byCategory };
}

// ---------- 成对提示 ----------

/** 把模板里的 {slot} 换成值；缺值抛错。 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`缺少 ${key}`);
    return values[key];
  });
}

/** 同一组模板、只换一个属性：返回每个模板在属性取 a、取 b 时的两条提示。 */
export function pairedPrompts(templates: readonly string[], slot: string, a: string, b: string, shared: Readonly<Record<string, string>> = {}): Array<{ template: string; a: string; b: string }> {
  return templates.map((template) => ({ template, a: fill(template, { ...shared, [slot]: a }), b: fill(template, { ...shared, [slot]: b }) }));
}

export interface PairedComparison {
  diffs: number[];
  meanDiff: number;
  /** 符号检验：b 是 a 组更高的对数，c 是 b 组更高的对数。 */
  sign: PairedTest;
  /** 平均差的 bootstrap 95% 区间。 */
  ci: BootstrapResult;
  /** 二元结果（比如批不批退款）不一致的对数。 */
  flips: number;
}

/** mean(idx.map((i) => values[i]))，同样从 0 开始按顺序加，只是不建中间数组（bootstrap 里要算几千遍）。 */
const meanAt = (values: readonly number[], idx: readonly number[]): number => {
  let total = 0;
  for (const i of idx) total += values[i];
  return idx.length ? total / idx.length : 0;
};

/** 配对比较两组分数（同一模板的两个变体一一对应）：差值 a − b、符号检验、平均差的 bootstrap 区间。 */
export function comparePaired(a: readonly number[], b: readonly number[], options: { seed?: number; iterations?: number } = {}): PairedComparison {
  if (a.length !== b.length) throw new Error('两组长度不同');
  const diffs = a.map((x, i) => x - b[i]);
  return {
    diffs,
    meanDiff: mean(diffs),
    sign: signTest(diffs),
    ci: bootstrap(diffs.length, (idx) => meanAt(diffs, idx), { seed: options.seed ?? 3, iterations: options.iterations ?? 2000 }),
    flips: diffs.filter((d) => d !== 0).length,
  };
}
