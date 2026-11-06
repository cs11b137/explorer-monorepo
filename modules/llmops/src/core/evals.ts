/**
 * 评估：确定性的评分器（精确匹配、正则、JSON 解析和 JSON Schema、工具调用参数核对），把一批用例跑成报告，
 * LLM 当评委时的位置偏差（交换 A / B 顺序后结论翻转的比例）和与人工标注的一致性，改提示前后的逐用例对比（回归）。
 *
 * 被评估的「模型输出」和评委的「评分理由」是脚本示例（课程里标 E.G.）；评分器、通过率、区间、检验全部真实计算。
 * JSON Schema 校验用共享包 llm-core 的 validate（原在 AGENT EXPLORER），工具定义用 llm-core 的 SHOP_TOOL_DEFS。
 */
import { validate, type JsonSchema, type SchemaError } from '@explorer/llm-core/schema';
import { SHOP_TOOL_DEFS, type ShopToolName } from '@explorer/llm-core/shop';
import { cohenKappa, mcnemarExact, wilson, type Interval, type Kappa, type PairedTest } from './stats';

// ---------- 单个评分器 ----------

export interface Grade {
  pass: boolean;
  /** 0–1 的分数（通过 / 不通过的评分器是 1 或 0）。 */
  score: number;
  /** 一句话说明为什么过或不过。 */
  reason: string;
}

const grade = (pass: boolean, reason: string, score = pass ? 1 : 0): Grade => ({ pass, score, reason });

/** 比较前的规范化：NFKC、去掉首尾空白、连续空白并成一个。 */
export const normalizeAnswer = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');

/** 精确匹配：规范化之后逐字相等（normalize: false 时直接比较原文）。 */
export function exactMatch(actual: string, expected: string, options: { normalize?: boolean } = {}): Grade {
  const norm = options.normalize === false ? (s: string) => s : normalizeAnswer;
  const ok = norm(actual) === norm(expected);
  return grade(ok, ok ? '完全一致' : `应为「${expected}」`);
}

/** 正则：mustMatch 为 true 时要能匹配到，为 false 时不能出现（比如回答里不能出现手机号）。 */
export function regexCheck(text: string, pattern: string, options: { flags?: string; mustMatch?: boolean } = {}): Grade & { match: string | null } {
  const m = new RegExp(pattern, options.flags ?? 'u').exec(text);
  const must = options.mustMatch ?? true;
  const ok = must ? m !== null : m === null;
  return { ...grade(ok, must ? (m ? `匹配到「${m[0]}」` : `没有匹配 ${pattern}`) : m ? `不该出现「${m[0]}」` : '没有出现'), match: m ? m[0] : null };
}

/** 安全地解析 JSON：失败时给出 JSON.parse 的错误信息。 */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** 先解析 JSON，再按 schema 校验。 */
export function schemaCheck(text: string, schema: JsonSchema): Grade & { errors: SchemaError[] } {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ...grade(false, `不是合法的 JSON：${parsed.error}`), errors: [] };
  const errors = validate(schema, parsed.value);
  return { ...grade(!errors.length, errors.length ? errors.map((e) => `${e.path || '根'}：${e.message}`).join('；') : '符合 schema'), errors };
}

export interface ToolCallLike {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExpectation {
  name: ShopToolName;
  /** 必须等于这些值的参数（其余参数只按 schema 校验）。 */
  args?: Record<string, unknown>;
}

/** 工具调用核对：工具名对不对、参数按小铺的 input_schema 校验、指定的参数值对不对。 */
export function toolCallCheck(call: ToolCallLike | null, expect: ToolExpectation): Grade & { problems: string[] } {
  if (!call) return { ...grade(false, `应当调用 ${expect.name}，但没有调用工具`), problems: ['没有工具调用'] };
  const problems: string[] = [];
  if (call.name !== expect.name) problems.push(`调用了 ${call.name}，应为 ${expect.name}`);
  else {
    for (const e of validate(SHOP_TOOL_DEFS[expect.name].input_schema, call.input)) problems.push(`${e.path || '参数'}：${e.message}`);
    for (const [key, value] of Object.entries(expect.args ?? {})) {
      if (JSON.stringify(call.input[key]) !== JSON.stringify(value)) problems.push(`${key} 应为 ${JSON.stringify(value)}，实际是 ${JSON.stringify(call.input[key])}`);
    }
  }
  return { ...grade(!problems.length, problems.length ? problems.join('；') : '工具和参数都对'), problems };
}

// ---------- 评估集和报告 ----------

export interface EvalCase<E = unknown> {
  id: string;
  input: string;
  expected: E;
  tags?: string[];
}

export type Grader<O, E> = (output: O, item: EvalCase<E>) => Grade;

export interface EvalRow<O, E> {
  item: EvalCase<E>;
  output: O;
  grade: Grade;
}

export interface EvalReport<O, E> {
  rows: Array<EvalRow<O, E>>;
  passed: number;
  total: number;
  /** 通过率和它的 Wilson 95% 区间。 */
  rate: Interval;
  /** 按标签分的通过数 / 总数。 */
  byTag: Record<string, { passed: number; total: number }>;
}

/** 把一批用例和模型输出交给评分器，算通过率（Wilson 区间）和按标签的分组。outputs 按 id 取。 */
export function runEval<O, E>(cases: ReadonlyArray<EvalCase<E>>, outputs: Readonly<Record<string, O>>, grader: Grader<O, E>): EvalReport<O, E> {
  const rows = cases.map((item) => {
    if (!(item.id in outputs)) throw new Error(`没有用例 ${item.id} 的输出`);
    return { item, output: outputs[item.id], grade: grader(outputs[item.id], item) };
  });
  const passed = rows.filter((row) => row.grade.pass).length;
  const byTag: EvalReport<O, E>['byTag'] = {};
  for (const row of rows) for (const tag of row.item.tags ?? []) {
    const slot = (byTag[tag] ??= { passed: 0, total: 0 });
    slot.total++;
    if (row.grade.pass) slot.passed++;
  }
  return { rows, passed, total: rows.length, rate: wilson(passed, rows.length), byTag };
}

// ---------- 回归 ----------

export interface Regression {
  before: { passed: number; rate: Interval };
  after: { passed: number; rate: Interval };
  /** 改后变好（不过 → 过）、变坏（过 → 不过）的用例 id。 */
  improved: string[];
  regressed: string[];
  /** 精确 McNemar：b 是变坏的个数，c 是变好的个数。 */
  test: PairedTest;
}

/** 同一个评估集上的两次运行逐用例对比（用例按 id 对齐，顺序以 before 为准）。 */
export function compareRuns(before: Readonly<Record<string, boolean>>, after: Readonly<Record<string, boolean>>): Regression {
  const ids = Object.keys(before);
  for (const id of ids) if (!(id in after)) throw new Error(`第二次运行缺少用例 ${id}`);
  const a = ids.map((id) => before[id]);
  const b = ids.map((id) => after[id]);
  const count = (xs: boolean[]) => xs.filter(Boolean).length;
  return {
    before: { passed: count(a), rate: wilson(count(a), ids.length) },
    after: { passed: count(b), rate: wilson(count(b), ids.length) },
    improved: ids.filter((id) => !before[id] && after[id]),
    regressed: ids.filter((id) => before[id] && !after[id]),
    test: mcnemarExact(a, b),
  };
}

// ---------- LLM 当评委 ----------

export type Preference = 'A' | 'B' | 'tie';

export interface PairwiseVerdict {
  id: string;
  /** 原顺序（回答甲放在 A 位、乙放在 B 位）时评委选谁。 */
  original: Preference;
  /** 交换顺序（乙放 A 位、甲放 B 位）时评委选谁，写的仍是位置。 */
  swapped: Preference;
}

/** 把交换顺序后的位置换回回答本身：swapped 里的 A 是乙。 */
export const unswap = (p: Preference): Preference => (p === 'A' ? 'B' : p === 'B' ? 'A' : 'tie');

export interface PositionBias {
  n: number;
  /** 两种顺序结论一致（换回后相同）的个数。 */
  consistent: number;
  /** 交换后结论翻转的个数和比例（Wilson 区间）。 */
  flipped: number;
  flipRate: Interval;
  /** 两次都选同一个位置（都选 A 位或都选 B 位）的个数：位置偏差的直接证据。 */
  samePosition: number;
  /** 其中都选 A 位（第一个位置）的个数。 */
  firstPosition: number;
}

/** 位置偏差：同一对回答交换顺序各评一次，结论（换回后）不同就是翻转；两次都选同一个位置说明评委看的是位置而不是内容。 */
export function positionBias(verdicts: readonly PairwiseVerdict[]): PositionBias {
  let consistent = 0;
  let samePosition = 0;
  let firstPosition = 0;
  for (const v of verdicts) {
    if (v.original === unswap(v.swapped)) consistent++;
    if (v.original !== 'tie' && v.original === v.swapped) {
      samePosition++;
      if (v.original === 'A') firstPosition++;
    }
  }
  const flipped = verdicts.length - consistent;
  return { n: verdicts.length, consistent, flipped, flipRate: wilson(flipped, verdicts.length), samePosition, firstPosition };
}

export interface Rubric {
  /** 每一项的 id、说明和权重（权重之和不必是 1，算分时归一化）。 */
  criteria: ReadonlyArray<{ id: string; text: string; weight: number }>;
  /** 每一项的打分范围，比如 [1, 5]。 */
  scale: [number, number];
}

/** 按评分标准加权：每项分数先线性映射到 0–1，再按权重平均。缺项抛错。 */
export function rubricScore(rubric: Rubric, scores: Readonly<Record<string, number>>): number {
  const [lo, hi] = rubric.scale;
  const totalWeight = rubric.criteria.reduce((acc, c) => acc + c.weight, 0);
  return rubric.criteria.reduce((acc, c) => {
    const s = scores[c.id];
    if (s === undefined) throw new Error(`缺少 ${c.id} 的分数`);
    if (s < lo || s > hi) throw new Error(`${c.id} 的分数 ${s} 超出 ${lo}–${hi}`);
    return acc + ((s - lo) / (hi - lo)) * c.weight;
  }, 0) / totalWeight;
}

/** 评委和人工标注的一致性：逐条一致率和 Cohen's kappa。 */
export function judgeAgreement(judge: readonly string[], human: readonly string[], labels?: readonly string[]): Kappa & { agree: number } {
  const k = cohenKappa(judge, human, labels);
  return { ...k, agree: judge.filter((label, i) => label === human[i]).length };
}
