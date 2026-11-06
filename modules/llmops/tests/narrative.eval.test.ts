/**
 * 文案和计算结果对得上（评估组：deterministic、judge、human、regression），以及评估组在 core 里新加的 weightedKappa。
 * 和 narrative.test.ts 一样核对两类东西：
 * 1. 关键的数写死在这里（用例数、通过数、token、费用、kappa、区间、p 值），改了数据或脚本会立刻报错；
 * 2. 文字里没法直接取值的说法，比如「c2 末尾多一个换行照样算对」「t3 的参数完全符合 schema」「人工判差的评委全给了好」。
 */
import { describe, expect, it } from 'vitest';
import {
  binomTwoSided,
  cohenKappa,
  costOf,
  countTokens,
  exactMatch,
  POLICIES,
  SHOP_TOOL_DEFS,
  unswap,
  validate,
  weightedKappa,
  wilson,
} from '../src/core';
import { LESSON_BY_ID, PLANNED } from '../src/lessons';
import * as det from '../src/lessons/deterministic';
import {
  A1025_DAYS,
  ADJUDICATED,
  DET_CASES,
  EXCHANGE_DAYS,
  GRADES,
  JUDGE_MODEL,
  OPEN,
  OUTPUTS_V1,
  OUTPUTS_V2,
  PAIRWISE,
  RATERS,
  REPLY_KEYS,
  REPLY_SYSTEM_V1,
  REPLY_SYSTEM_V2,
  requestOf,
} from '../src/lessons/evalset';
import * as hum from '../src/lessons/human';
import * as jud from '../src/lessons/judge';
import * as reg from '../src/lessons/regression';
import { MODEL } from '../src/lessons/scenario';
import { packetsOf, type Lesson } from '../src/lessons/types';

const textOf = (id: string, outputs = OUTPUTS_V1) => outputs[id].map((b) => (b.type === 'text' ? b.text : '')).join('');
const toolOf = (id: string, outputs = OUTPUTS_V1) => outputs[id].find((b) => b.type === 'tool_use') as { name: string; input: Record<string, unknown> } | undefined;
const facts = (lesson: Lesson, step: number) => Object.fromEntries(lesson.steps[step].facts);
const lastCost = (lesson: Lesson) => packetsOf(lesson).at(-1)!.row.cost;

describe('weightedKappa（core/stats.ts，评估组新加）', () => {
  it('手算的小例子：线性 0.25、二次 2/7', () => {
    const a = ['差', '可接受', '好', '好'];
    const b = ['差', '好', '好', '差'];
    const linear = weightedKappa(a, b, GRADES, 'linear');
    // 加权不一致：(0 + 1 + 0 + 2) / 4；期望：行边际 [1, 1, 2]、列边际 [2, 0, 2] 的外积按 |i − j| 加权 = 16 / 16。
    expect(linear.observed).toBeCloseTo(0.75, 12);
    expect(linear.expected).toBeCloseTo(1, 12);
    expect(linear.kappa).toBeCloseTo(0.25, 12);
    const quad = weightedKappa(a, b, GRADES, 'quadratic');
    expect(quad.observed).toBeCloseTo(1.25, 12);
    expect(quad.expected).toBeCloseTo(28 / 16, 12);
    expect(quad.kappa).toBeCloseTo(2 / 7, 12);
    // po、pe、列联表和不加权的一样。
    expect(linear.table).toEqual(cohenKappa(a, b, GRADES).table);
  });

  it('只有两类时线性加权等于 Cohen\'s kappa（维基百科的 [[20, 5], [10, 15]] → 0.4）', () => {
    const a = [...Array(25).fill('是'), ...Array(25).fill('否')];
    const b = [...Array(20).fill('是'), ...Array(5).fill('否'), ...Array(10).fill('是'), ...Array(15).fill('否')];
    expect(weightedKappa(a, b, ['否', '是']).kappa).toBeCloseTo(0.4, 12);
    expect(cohenKappa(a, b).kappa).toBeCloseTo(0.4, 12);
  });

  it('完全一致是 1；期望不一致为 0 时记 1', () => {
    expect(weightedKappa(['好', '差'], ['好', '差'], GRADES).kappa).toBe(1);
    expect(weightedKappa(['好', '好'], ['好', '好'], GRADES).kappa).toBe(1);
  });
});

describe('评估集（四课共用）', () => {
  it('22 条用例：6 分类、12 回答（6 工具 + 6 正则）、4 工单；12 个开放问题 × 两版 = 24 条回答', () => {
    expect(DET_CASES.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 't1', 't2', 't3', 't4', 't5', 't6', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'k1', 'k2', 'k3', 'k4']);
    expect(new Set(DET_CASES.map((c) => c.id)).size).toBe(22);
    expect(OPEN).toHaveLength(12);
    expect(REPLY_KEYS).toHaveLength(24);
    expect(Object.keys(OUTPUTS_V1).sort()).toEqual(DET_CASES.map((c) => c.id).sort());
  });

  it('订单数据：A1025 签收 17 天，超过 7 天退款和 15 天换货（《售后规则》第 2 条）', () => {
    expect(A1025_DAYS).toBe(17);
    expect(EXCHANGE_DAYS).toBe(15);
    expect(OPEN.find((q) => q.id === 'q5')!.question).toContain('10 月 20 日签收');
    expect(OPEN.find((q) => q.id === 'q5')!.v1).toContain('签收已经 17 天');
  });

  it('评分标准 v1 没有店铺规则，v2 附上了全部规则', () => {
    expect(REPLY_SYSTEM_V2.startsWith(REPLY_SYSTEM_V1)).toBe(true);
    for (const doc of POLICIES) expect(REPLY_SYSTEM_V1).toContain(doc.text);
  });

  it('课程顺序：deterministic → judge → human → regression，前接 bias、后接 trace', () => {
    const ids = PLANNED.map((p) => p.id);
    expect(ids.slice(ids.indexOf('bias'), ids.indexOf('trace') + 1)).toEqual(['bias', 'deterministic', 'judge', 'human', 'regression', 'trace']);
  });
});

describe('确定性评估：匹配、正则与 Schema', () => {
  const lesson = LESSON_BY_ID.deterministic;
  const N = det.numbers;

  it('跑一遍 22 次调用：t1 输入 2,662、输出 72 token，$0.0121；合计 $0.1618', () => {
    expect([N.firstInput, N.firstOutput]).toEqual([2662, 72]);
    expect(costOf(det.calls[6].message.usage, MODEL).total).toBe(2662 * 4000 + 72 * 20000);
    expect(N.firstCost).toBe('$0.0121');
    expect(det.runCost).toBe(det.calls.reduce((a, c) => a + c.cost.total, 0));
    expect(det.runCost).toBe(161_836_000);
    expect(N.runCost).toBe('$0.1618');
    expect(lastCost(lesson)).toBe(det.runCost);
    expect(lesson.costNote).toBe('评估运行器把 22 条用例各发给 Claude Opus 5.5 一次，共 $0.1618；评分器本身不调用模型，打分不花钱。');
    // 评分的事件都在模型调用之后，费用列不再变化。
    expect(packetsOf(lesson).filter((p) => p.row.type === 'EVAL' || p.row.type === 'STATS').every((p) => p.row.cost === det.runCost)).toBe(true);
    // 工具定义和规则让回答的请求远大于分类的请求。
    expect(N.routerInputMax).toBe(158);
    expect(N.replyInputMin).toBe(2662);
  });

  it('第一次 12 / 22（34.7%–73.1%），失败 10 条；按评分器 4/6、3/6、2/4、3/6', () => {
    expect([N.passed, N.rate]).toEqual([12, wilson(12, 22)]);
    expect(N.failed).toEqual(['c3', 'c6', 't2', 't3', 't6', 'q2', 'q3', 'q4', 'k2', 'k3']);
    expect(N.byTag).toEqual({ label: { passed: 4, total: 6 }, regex: { passed: 3, total: 6 }, ticket: { passed: 2, total: 4 }, tool: { passed: 3, total: 6 } });
    expect(facts(lesson, 5).第一次).toBe('12 / 22（34.7%–73.1%）');
  });

  it('精确匹配：c2 末尾的换行被规范化去掉；c3 只多一个句号；c6 是真错', () => {
    expect(textOf('c2')).toBe('换货\n');
    expect(exactMatch(textOf('c2'), '换货').pass).toBe(true);
    expect(exactMatch(textOf('c2'), '换货', { normalize: false }).pass).toBe(false);
    expect(textOf('c3')).toBe('查物流。');
    expect(textOf('c6')).toBe('换货');
    expect(DET_CASES.find((c) => c.id === 'c6')!.input).toBe('杯盖丢了能补发吗？');
    expect(lesson.steps[1].detail).toContain('c3 回的是「查物流」加一个句号');
    expect(lesson.steps[1].detail).toContain('c6 把「杯盖丢了能补发吗」分成「换货」，是真错');
  });

  it('正则：q1 两个都匹配；q3 编了一个手机号；q4 写的是「七天」', () => {
    expect(textOf('q1')).toMatch(/7 ?天/u);
    expect(textOf('q1')).toMatch(/运费/u);
    expect(textOf('q3')).toContain('13800138000');
    expect(POLICIES.some((p) => /电话/.test(p.text))).toBe(false);
    expect(textOf('q4')).toContain('七天');
    expect(textOf('q4')).not.toMatch(/7 ?天/u);
    expect(facts(lesson, 2).q3).toBe('不该出现「13800138000」');
  });

  it('Schema：k2 包在代码块里解析失败；k3 缺 needs_human，而这一单该转人工', () => {
    expect(textOf('k2').startsWith('```json\n')).toBe(true);
    expect(() => JSON.parse(textOf('k2'))).toThrow();
    expect(JSON.parse(textOf('k3'))).not.toHaveProperty('needs_human');
    expect(DET_CASES.find((c) => c.id === 'k3')!.expected).toMatchObject({ value: { needs_human: true } });
    expect(facts(lesson, 3).k3).toBe('needs_human：缺少必填参数');
  });

  it('工具调用：t2 订单号小写不合 schema；t3 符合 schema 但 reason 错；t6 没调用工具', () => {
    expect(toolOf('t2')!.input.order_id).toBe('a1024');
    expect(validate(SHOP_TOOL_DEFS.create_return.input_schema, toolOf('t2')!.input).map((e) => e.path)).toEqual(['order_id']);
    expect(validate(SHOP_TOOL_DEFS.create_return.input_schema, toolOf('t3')!.input)).toEqual([]);
    expect(toolOf('t3')!.input.reason).toBe('no_reason');
    expect(toolOf('t6')).toBeUndefined();
    expect(lesson.steps[4].detail).toContain('t2 把订单号写成小写的 a1024，不匹配 schema 里的 ^A\\d{4}$');
  });

  it('抽查：c3、q4 是评分器的错，改后 14 / 22（43%–80.3%），重算不花钱', () => {
    expect(N.graderErrors).toEqual(['c3', 'q4']);
    expect([N.fixedPassed, N.fixedRate]).toEqual([14, wilson(14, 22)]);
    expect(facts(lesson, 5).改后).toBe('14 / 22（43%–80.3%）');
    expect(lesson.overview.description).toContain('第一次算出通过 12 / 22，抽查失败的用例才发现，其中 2 条是评分器自己写得太死');
  });
});

describe('LLM 当评委：评分标准与位置偏差', () => {
  const lesson = LESSON_BY_ID.judge;
  const N = jud.numbers;

  it('评委是 Sonnet 5.5，不是被评的 Opus 5.5；q7 v1 输入 577、输出 94 token，$0.00209', () => {
    expect(JUDGE_MODEL).toBe('claude-sonnet-5-5');
    expect(JUDGE_MODEL).not.toBe(MODEL);
    expect([N.showInput, N.showOutput]).toEqual([577, 94]);
    expect(costOf(jud.pointCalls[REPLY_KEYS.indexOf('q7v1')].message.usage, JUDGE_MODEL).total).toBe(577 * 2000 + 94 * 10000);
    expect(N.showCost).toBe('$0.00209');
    expect([N.judgeInput, N.judgeOutput]).toEqual(['$2 / MTok', '$10 / MTok']);
  });

  it('评分标准：三项按 2、2、1 加权，q7 v1 满分 1.00；24 条里好 20、可接受 4、差 0', () => {
    expect(N.criteria).toBe('resolve ×2、accurate ×2、tone ×1');
    expect(N.showScore).toBe('1.00');
    expect(jud.scores[REPLY_KEYS.indexOf('q12v1')]).toBeCloseTo((2 * 2 + 2 * 3 + 1 * 1) / 4 / 5, 12);
    expect([N.good, N.ok, N.bad]).toEqual([20, 4, 0]);
  });

  it('费用：逐条打分 24 次 $0.0401，成对比较 24 次 $0.0216，合计 $0.0616', () => {
    expect(N.pointCostNano).toBe(40_078_000);
    expect(N.totalNano).toBe(61_638_000);
    expect([N.pointCost, N.pairCost, N.totalCost]).toEqual(['$0.0401', '$0.0216', '$0.0616']);
    expect(lastCost(lesson)).toBe(N.totalNano);
    expect(packetsOf(lesson).filter((p) => p.row.type === 'JUDGE')).toHaveLength(5);
  });

  it('位置偏差：q10 两次都选 A；12 对里翻转 5 对（19.3%–68%），4 对两次同一位置、3 对是 A 位', () => {
    expect(PAIRWISE.find((p) => p.id === 'q10')).toMatchObject({ original: 'A', swapped: 'A' });
    expect(N.flips).toEqual(['q4', 'q6', 'q9', 'q10', 'q12']);
    expect([N.flipped, N.samePosition, N.firstPosition]).toEqual([5, 4, 3]);
    expect(N.flipRate).toEqual(wilson(5, 12));
    expect(facts(lesson, 3).翻转).toBe('5 / 12（41.7%）');
    expect(lesson.steps[3].desc).toBe('5 / 12 对翻转，区间 19.3%–68%');
    // 只算一致的：v1 胜 q1、q5、q7，v2 胜 q2、q3、q8、q11。
    expect([N.v1Wins, N.v2Wins, N.undecided]).toEqual([3, 4, 5]);
    expect(PAIRWISE.filter((p) => p.original === unswap(p.swapped) && p.original === 'A').map((p) => p.id)).toEqual(['q1', 'q5', 'q7']);
  });

  it('「翻转的大多是人工看来两版差不多的那几对」：5 对里 3 对人工给两版同一档', () => {
    const same = N.flips.filter((id) => ADJUDICATED[REPLY_KEYS.indexOf(`${id}v1`)] === ADJUDICATED[REPLY_KEYS.indexOf(`${id}v2`)]);
    expect(same).toEqual(['q4', 'q6', 'q9']);
  });

  it('和人工：一致 18 / 24，κ 0.47（中等）；人判差的 4 条评委都判好，q10 v1 的客套话也拿了好', () => {
    expect([N.agree, N.kappa, N.band]).toEqual([18, '0.47', '中等']);
    expect(jud.agreement.kappa).toBeCloseTo((jud.agreement.po - jud.agreement.pe) / (1 - jud.agreement.pe), 12);
    expect(N.humanBad).toEqual(['q2v1', 'q3v1', 'q5v2', 'q11v1']);
    expect(N.humanBadJudged).toEqual(['好', '好', '好', '好']);
    expect(jud.judgeLabels[REPLY_KEYS.indexOf('q10v1')]).toBe('好');
    expect(ADJUDICATED[REPLY_KEYS.indexOf('q10v1')]).toBe('可接受');
    expect(N.disagreements).toEqual(['q1v2', 'q2v1', 'q3v1', 'q5v2', 'q10v1', 'q11v1']);
    expect(OPEN.find((q) => q.id === 'q10')!.v1.length).toBeGreaterThan(3 * OPEN.find((q) => q.id === 'q10')!.v2.length);
  });

  it('评委写的 JSON 由本站分词器计数', () => {
    const call = jud.pointCalls[0];
    expect(call.message.usage.output_tokens).toBe(countTokens((call.message.content[0] as { text: string }).text));
  });
});

describe('人工评估与一致性', () => {
  const lesson = LESSON_BY_ID.human;
  const N = hum.numbers;

  it('三人标注：差分别 4、4、6 条；一致 15、二比一 7、三人各不相同 2（q1 v2、q10 v1）', () => {
    expect(N.badBy).toEqual({ 甲: 4, 乙: 4, 丙: 6 });
    expect([N.unanimous, N.majority]).toEqual([15, 7]);
    expect(N.adjudicated).toEqual(['q1v2', 'q10v1']);
    for (const key of N.adjudicated) expect(new Set((['甲', '乙', '丙'] as const).map((r) => RATERS[r][REPLY_KEYS.indexOf(key)])).size).toBe(3);
  });

  it('甲乙：一致 17 / 24，pe 0.472，κ 0.45（手算边际）', () => {
    const a = RATERS.甲;
    const b = RATERS.乙;
    expect(a.filter((x, i) => x === b[i])).toHaveLength(17);
    const share = (xs: readonly string[], g: string) => xs.filter((x) => x === g).length / 24;
    const pe = GRADES.reduce((s, g) => s + share(a, g) * share(b, g), 0);
    expect(N.abPe).toBeCloseTo(pe, 12);
    expect(N.abPe).toBeCloseTo(0.472, 3);
    expect(hum.kappas[0].plain.kappa).toBeCloseTo((17 / 24 - pe) / (1 - pe), 12);
    expect(N.abKappa).toBe('0.45');
    expect(lesson.steps[1].detail).toContain('一致率 70.8%');
  });

  it('三对 κ 0.45、0.66、0.42（中等、相当、中等），线性加权 0.61、0.70、0.55；乙丙只有 q10 v1 差两档', () => {
    expect(N.kappas.map((k) => [k.pair, k.plain, k.band, k.weighted])).toEqual([['甲乙', '0.45', '中等', '0.61'], ['甲丙', '0.66', '相当', '0.70'], ['乙丙', '0.42', '中等', '0.55']]);
    expect(N.bcTwoStep).toEqual(['q10v1']);
    expect(N.bcOneStep).toBe(7);
    expect(N.meanKappa).toBe('0.51');
    expect(lesson.steps[2].detail).toContain('乙丙的 8 条分歧里只有 q10v1 差了两档');
  });

  it('bootstrap 2,000 次、种子 1：甲乙 0.12–0.73，从「轻微」跨到「相当」', () => {
    expect(N.kappas.map((k) => `${k.lo}–${k.hi}`)).toEqual(['0.12–0.73', '0.34–0.87', '0.16–0.68']);
    expect([N.iterations, N.seed]).toEqual([2000, 1]);
    expect(hum.kappas[0].ci.lo).toBeLessThanOrEqual(0.2);
    expect(hum.kappas[0].ci.hi).toBeGreaterThan(0.6);
    expect(hum.kappas[0].ci.hi).toBeLessThanOrEqual(0.8);
  });

  it('裁决后的标签就是上一课评委对比用的人工标签', () => {
    expect(ADJUDICATED).toHaveLength(24);
    expect(jud.agreement.agree).toBe(hum.before.agree);
  });

  it('评分标准 v2：一致 18 → 23，κ 0.47 → 0.92；剩下的 q1 v2 正是组长裁决的那条', () => {
    expect([N.beforeAgree, N.afterAgree, N.beforeKappa, N.afterKappa]).toEqual([18, 23, '0.47', '0.92']);
    expect(N.stillOff).toEqual(['q1v2']);
    expect(N.adjudicated).toContain(N.stillOff[0]);
    expect([N.v1Input, N.v2Input]).toEqual([488, 1494]);
    expect(N.rejudgeNano).toBe(hum.rejudge.reduce((a, c) => a + c.cost.total, 0));
    expect(N.rejudgeCost).toBe('$0.0894');
  });

  it('前五步不调用模型：费用列是 0', () => {
    const packets = packetsOf(lesson);
    const firstJudge = packets.findIndex((p) => p.row.type === 'JUDGE');
    expect(packets.slice(0, firstJudge).every((p) => p.row.cost === 0)).toBe(true);
    expect(lastCost(lesson)).toBe(N.rejudgeNano);
  });
});

describe('回归测试：改提示前后', () => {
  const lesson = LESSON_BY_ID.regression;
  const N = reg.numbers;

  it('v2 只改回答的系统提示：带工具的请求每条多 190 token，分类和工单的请求不变', () => {
    expect(N.added).toBe(4);
    for (const item of DET_CASES) {
      const a = requestOf(item, 'v1');
      const b = requestOf(item, 'v2');
      const delta = countTokens(JSON.stringify(b)) === countTokens(JSON.stringify(a)) ? 0 : 1;
      expect(delta).toBe(item.site === 'reply' ? 1 : 0);
    }
    expect(det.calls.every((c, i) => reg.v2Calls[i].message.usage.input_tokens - c.message.usage.input_tokens === (DET_CASES[i].site === 'reply' ? 190 : 0))).toBe(true);
    expect([N.v1Input, N.v2Input, N.deltaInput]).toEqual([2688, 2878, 190]);
  });

  it('再跑一遍 $0.1678；改前沿用第 ⑦ 课（$0.1618，不计入这一课）', () => {
    expect(N.runCostNano).toBe(167_816_000);
    expect([N.runCost, N.baselineCost]).toEqual(['$0.1678', '$0.1618']);
    expect(lastCost(lesson)).toBe(N.runCostNano);
  });

  it('通过 14 → 15；变好 t2、t3、t6、q3，变坏 t4、q1、q5；都过 11、都不过 4', () => {
    expect([N.before, N.after]).toEqual([14, 15]);
    expect(N.improved).toEqual(['t2', 't3', 't6', 'q3']);
    expect(N.regressed).toEqual(['t4', 'q1', 'q5']);
    expect([N.bothPass, N.bothFail, N.ties]).toEqual([11, 4, 15]);
    expect(N.beforeRate).toEqual(wilson(14, 22));
    expect(N.afterRate).toEqual(wilson(15, 22));
  });

  it('McNemar：b = 3、c = 4，p = 1；7 条不一致只有 0 比 7 才 < 0.05（p = 1/64），6 比 1 时 0.125', () => {
    expect([N.b, N.c, N.p]).toEqual([3, 4, 1]);
    expect(N.splits.map((s) => s.p)).toEqual([binomTwoSided(0, 7), binomTwoSided(1, 7), binomTwoSided(2, 7), binomTwoSided(3, 7)]);
    expect(N.splits[0].p).toBeCloseTo(2 / 128, 12);
    expect(N.splits[1].p).toBeCloseTo(16 / 128, 12);
    expect(N.splits.filter((s) => s.p < 0.05).map((s) => s.k)).toEqual([0]);
    expect(N.noise).toBe(21);
    expect(lesson.steps[3].detail).toContain('要 0 比 7 这么悬殊 p 才小于 0.05（6 比 1 时 p = 0.125）');
  });

  it('变坏的三条：q5 答应了超期退款；q1 砍掉了运费；t4 的回答对，是评分器只认 search_policy', () => {
    expect(textOf('q5', OUTPUTS_V2)).toContain('可以退款');
    expect(A1025_DAYS).toBeGreaterThan(EXCHANGE_DAYS);
    expect(textOf('q1', OUTPUTS_V2)).not.toContain('运费');
    expect(textOf('q1')).toContain('运费');
    const refund = POLICIES.find((p) => p.id === 'refund#1')!.text;
    for (const part of textOf('t4', OUTPUTS_V2).replace(/。$/, '').split('，')) expect(refund.replace('到账', '')).toContain(part.replace('到账', ''));
    expect(toolOf('t4', OUTPUTS_V2)).toBeUndefined();
    expect(lesson.steps[4].detail).toContain('已经签收 17 天的热水壶');
  });
});
