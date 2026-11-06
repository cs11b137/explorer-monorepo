/**
 * 评估组第四课：回归测试。客服回答的系统提示 v1 末尾加了四句成了 v2，同一个评估集（第 ⑦ 课的 22 条用例、改过的评分器）再跑一遍：
 * 每次调用经 callModel 真实计算 token 和费用（输出是示例），core/evals.ts 的 compareRuns 逐用例对齐两次运行，
 * 列出变好、变坏的用例，用精确 McNemar 检验（core/stats.ts 的 mcnemarExact、binomTwoSided）；改前的结果沿用第 ⑦ 课那次运行。
 * tests/narrative.eval.test.ts 核对文案。
 */
import {
  binomTwoSided,
  callModel,
  compareRuns,
  encodeJson,
  formatUsd,
  runEval,
  type ContentBlock,
  type ModelCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { pct } from './common';
import { note, pk, show, state } from './dsl';
import { A1025_DAYS, DET_CASES, gradeCase, OUTPUTS_V2, PROMPT_V2_ADDED, REPLY_SYSTEM_V1, requestOf, type DetCase } from './evalset';
import { calls as v1Calls, fixed as baseline } from './deterministic';
import { MODEL } from './scenario';
import type { DsCell, GridPrim, Lesson, TowerPrim } from './types';

// ---------- 真实计算 ----------

/** 用 v2 的提示把 22 条用例再跑一遍（输出是示例），种子 950 + 序号。 */
export const v2Calls: ModelCall[] = DET_CASES.map((item, i) => callModel(requestOf(item, 'v2'), OUTPUTS_V2[item.id], 950 + i));
export const v2Report = runEval(DET_CASES, OUTPUTS_V2, (out: ContentBlock[], item) => gradeCase(out, item as DetCase, 'fixed'));
const passMap = (report: typeof baseline) => Object.fromEntries(report.rows.map((row) => [row.item.id, row.grade.pass]));
export const diff = compareRuns(passMap(baseline), passMap(v2Report));
const runCost = v2Calls.reduce((a, c) => a + c.cost.total, 0);

const idx = (id: string) => DET_CASES.findIndex((item) => item.id === id);
const caseOf = (id: string) => DET_CASES[idx(id)];
const gradeV1 = (id: string) => baseline.rows[idx(id)].grade;
const gradeV2 = (id: string) => v2Report.rows[idx(id)].grade;
const said = (blocks: readonly ContentBlock[]) => blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
const t2 = idx('t2');
const shown = v2Calls[t2];
const D = diff.test.b + diff.test.c;
/** 不一致的用例有 D 条时，最不平衡的几种分法的 p 值：说明多少条才够。 */
const splits = Array.from({ length: Math.floor(D / 2) + 1 }, (_, k) => ({ k, p: binomTwoSided(k, D, 0.5) }));
const bothPass = DET_CASES.filter((item) => gradeV1(item.id).pass && gradeV2(item.id).pass).length;
const bothFail = DET_CASES.length - bothPass - D;
/** 第 ⑦ 课那次运行的费用（这一课不再付）。 */
const baselineCost = v1Calls.reduce((a, c) => a + c.cost.total, 0);

export const numbers = {
  cases: DET_CASES.length,
  added: PROMPT_V2_ADDED.length,
  v1Input: v1Calls[t2].message.usage.input_tokens,
  v2Input: shown.message.usage.input_tokens,
  deltaInput: shown.message.usage.input_tokens - v1Calls[t2].message.usage.input_tokens,
  shownCost: formatUsd(shown.cost.total),
  shownBytes: shown.http.request.bytes.length,
  runCost: formatUsd(runCost),
  runCostNano: runCost,
  baselineCost: formatUsd(baselineCost),
  before: diff.before.passed,
  after: diff.after.passed,
  beforeRate: diff.before.rate,
  afterRate: diff.after.rate,
  improved: diff.improved,
  regressed: diff.regressed,
  b: diff.test.b,
  c: diff.test.c,
  ties: diff.test.ties,
  p: diff.test.p,
  bothPass,
  bothFail,
  discordant: D,
  splits,
  noise: Math.round(100 / Math.sqrt(DET_CASES.length)),
};
const N = numbers;
const range = (r: { lo: number; hi: number }) => `${pct(r.lo)}–${pct(r.hi)}`;
const sig = splits.filter((s) => s.p < 0.05);

// ---------- 图元 ----------

const KINDS = ['label', 'regex', 'ticket', 'tool'] as const;
const ROW_NAME = { label: '精确', regex: '正则', ticket: 'Schema', tool: '工具' } as const;
const casesOf = (kind: (typeof KINDS)[number]) => DET_CASES.filter((item) => item.expected.kind === kind);
const COLS = Math.max(...KINDS.map((kind) => casesOf(kind).length));

/**
 * 评估集：stage 0 只画改前的结果，1 画改后，2 按两次对比上色：都过 green、都不过 dim、变好 teal、变坏 amber。
 */
function resultsGrid(stage: 0 | 1 | 2, lift: readonly string[] = []): GridPrim {
  return {
    kind: 'grid',
    id: 'g',
    w: 46,
    rows: KINDS.map((kind) => ROW_NAME[kind]),
    cols: Array.from({ length: COLS }, (_, i) => String(i + 1)),
    cells: KINDS.map((kind) => Array.from({ length: COLS }, (_, i): DsCell => {
      const item = casesOf(kind)[i];
      if (!item) return { v: '', tone: 'empty' };
      const a = gradeV1(item.id).pass;
      const b = gradeV2(item.id).pass;
      const lifted = lift.includes(item.id) || undefined;
      if (stage === 0) return { v: item.id, tone: a ? 'green' : 'slate', lift: lifted };
      if (stage === 1) return { v: item.id, tone: b ? 'green' : 'slate', lift: lifted };
      const tone = a && b ? 'green' : !a && !b ? 'dim' : b ? 'teal' : 'amber';
      return { v: a === b ? item.id : `${item.id}${b ? '↑' : '↓'}`, tone, lift: lifted };
    })),
  };
}

/** McNemar 的 2 × 2 表：行是改前，列是改后；只有两个不一致的格子参与检验。 */
function pairTable(hot = false): GridPrim {
  return {
    kind: 'grid',
    id: 'm',
    w: 50,
    rows: ['前过', '前不过'],
    cols: ['后过', '后不过'],
    cells: [
      [{ v: String(N.bothPass), tone: hot ? 'dim' : 'green' }, { v: String(N.b), tone: 'amber', lift: hot || undefined }],
      [{ v: String(N.c), tone: 'teal', lift: hot || undefined }, { v: String(N.bothFail), tone: hot ? 'dim' : 'slate' }],
    ],
  };
}

/** 系统提示的组成：v1 的三部分，v2 再摞上四句（格子里写简称）。 */
const ADDED_SHORT = ['简短', '订单号大写', '质量问题', '先查订单'];
function promptTower(v2: boolean): TowerPrim {
  const base = [
    { key: 'p0', text: 'system · 角色', tone: 'blue' as const },
    { key: 'p1', text: `规则 · ${REPLY_SYSTEM_V1.split('\n').length - 2} 条`, tone: 'blue' as const },
    { key: 'p2', text: '工具 · 何时调用', tone: 'blue' as const },
  ];
  const added = ADDED_SHORT.slice(0, PROMPT_V2_ADDED.length).map((text, i) => ({ key: `a${i}`, text: `v2 · ${text}`, tone: 'amber' as const }));
  return { kind: 'tower', id: 't', frames: v2 ? [...base, ...added] : base };
}

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const reqWire = wire('改后的请求（用例 t2）', 'mem', 'format',
  httpHead('请求头', shown.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
  jsonBody('请求体', encodeJson(shown.request), { notes: { system: `系统提示 v2：v1 末尾多了 ${N.added} 句，这一条请求的输入从 ${num(N.v1Input)} 变成 ${num(N.v2Input)} token。`, messages: '同一个用例、同一句话。' } }),
  utf8Lines('v2 新加的四句', PROMPT_V2_ADDED.join('\n'), { color: 'amber', summary: '拼在 v1 的系统提示后面' }));
const resWire = wire('改后的响应（用例 t2）', 'mem', 'format',
  httpHead('响应头', shown.http.response, { example: ['request-id', 'date'] }),
  jsonBody('响应体', encodeJson(shown.message), { expand: ['usage.input_tokens'], example: ['id', 'content', 'usage', 'usage.input_tokens'], notes: { content: '这次订单号写成了大写的 A1024（示例）。' } }));
const restWire = wire('其余用例', 'mem', '示意', concept(`其余 ${N.cases - 1} 条（v2 的输入 token，费用）`, DET_CASES.filter((_, i) => i !== t2).map((item): [string, string, string] => [item.id, `${num(v2Calls[idx(item.id)].message.usage.input_tokens)} token`, formatUsd(v2Calls[idx(item.id)].cost.total)])));
const rateJson = encodeJson({ before: { passed: N.before, of: N.cases, wilson95: [+N.beforeRate.lo.toFixed(3), +N.beforeRate.hi.toFixed(3)] }, after: { passed: N.after, of: N.cases, wilson95: [+N.afterRate.lo.toFixed(3), +N.afterRate.hi.toFixed(3)] } });
const diffJson = encodeJson({ improved: N.improved, regressed: N.regressed, both_pass: N.bothPass, both_fail: N.bothFail });
const testJson = encodeJson({ test: 'mcnemar_exact', b: N.b, c: N.c, ties: N.ties, p: +N.p.toFixed(4) });
const caseConcept = (ids: readonly string[], title: string) => concept(title, ids.map((id): [string, string, string] => [`${id}（${caseOf(id).short}）`, preview(said(OUTPUTS_V2[id]) || JSON.stringify((OUTPUTS_V2[id][0] as { input?: unknown }).input ?? ''), 24), `${gradeV1(id).pass ? '改前过' : `改前：${gradeV1(id).reason}`}；改后：${gradeV2(id).reason}`]), ids === diff.regressed ? 'amber' : 'teal');

// ---------- 事件 ----------

const C = N.runCostNano;
const ids = (xs: readonly string[]) => xs.join('、');

export const regression: Lesson = {
  id: 'regression',
  name: 'REGRESSION',
  title: '回归测试：改提示前后',
  group: 'eval',
  layer: [5, 5],
  layerNote: '回归测试是离线评估的一种用法：同一个评估集、同一套评分器，在改动前后各跑一遍，逐条比较。',
  costNote: `改后的提示把 ${N.cases} 条用例再发给 Claude Opus 5.5 一遍，${N.runCost}；改前的结果沿用第 ⑦ 课那次运行（当时花了 ${N.baselineCost}），评分和检验不花钱。`,
  nodes: ['harness', 'llm', 'request', 'results', 'matrix'],
  place: { harness: [500, 320], llm: [890, 110], request: [150, 170], results: [180, 620], matrix: [850, 640] },
  labels: {
    harness: ['评估运行器', '两次运行逐条对齐'],
    llm: ['模型', MODEL],
    request: ['系统提示', 'v1 + 新加的四句'],
    results: ['评估集', `${N.cases} 条，按评分器分行`],
    matrix: ['改前 × 改后', '只看不一致的两格'],
  },
  labelAt: { request: [0, 125], results: [0, 135], matrix: [0, 110] },
  radius: { request: 80, results: 80, matrix: 70 },
  initial: { request: [], results: [], matrix: [] },
  start: ['harness', 'llm'],
  legend: [['green', '过'], ['teal', '变好'], ['amber', '变坏、新加的提示'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '改了提示，通过率涨了一条，可有三条变坏了',
    description: `客服的系统提示加了 ${N.added} 句（回答简短、订单号大写、什么算质量问题、先查订单），同一个评估集再跑一遍（${N.runCost}）。通过数从 ${N.before} 涨到 ${N.after}，看起来变好了；逐条对齐才看到 ${N.improved.length} 条变好、${N.regressed.length} 条变坏，其中一条是答应了已经超期的退款。精确 McNemar 只看这 ${N.discordant} 条不一致的用例，p = ${N.p.toFixed(2)}：${N.cases} 条用例分不出两版谁好，能看清的是哪几条坏了。`,
    facts: [
      ['改动', `系统提示末尾加 ${N.added} 句`],
      ['通过', `${N.before} → ${N.after} / ${N.cases}`],
      ['变好 / 变坏', `${N.improved.length} / ${N.regressed.length}`],
      ['McNemar', `b = ${N.b}，c = ${N.c}，p = ${N.p.toFixed(2)}`],
    ],
  },
  steps: [
    {
      title: '改提示：末尾加了四句',
      desc: `带工具的请求每条多 ${N.deltaInput} token，t2 写对了订单号`,
      detail: `第 ⑦ 课的评估暴露了几个问题：订单号写成小写、漏水没算质量问题、没查订单就答应退货，于是在客服的系统提示末尾加了 ${N.added} 句：${PROMPT_V2_ADDED.map((t) => `「${t.replace(/[。]$/, '')}」`).join('')}。只改提示、不改模型，用例、评分器（第 ⑦ 课改过的版本）都不动，改前的结果直接用上次那次运行。提示变长，带工具的每条请求输入多了 ${N.deltaInput} token（t2 从 ${num(N.v1Input)} 到 ${num(N.v2Input)}），以后每一次真实的客服调用都要多付这部分。`,
      facts: [['新加', `${N.added} 句`], ['t2 的输入', `${num(N.v1Input)} → ${num(N.v2Input)} token`], ['不变', '模型、用例、评分器'], ['改前的结果', `沿用第 ⑦ 课（${N.before} / ${N.cases}）`]],
      events: [
        show('request', 'results'),
        pk('harness', 'request', 'amber', '系统提示 v2', [`+ ${N.added} 句`], [0, 'CALL', `系统提示 v1 末尾加 ${N.added} 句`, null], wire('改动', 'mem', '示意', concept('新加的四句', PROMPT_V2_ADDED.map((t, i): [string, string] => [`+${i + 1}`, t]), 'amber')), { ds: { request: [promptTower(true)], results: [resultsGrid(0)] } }),
        pk('harness', 'llm', 'blue', 'POST /v1/messages', ['t2，提示 v2', `${num(N.shownBytes)} 字节`], [0, 'HTTP', `t2：同一句话，系统提示换成 v2`, N.shownBytes], reqWire, { ds: { results: [resultsGrid(0, ['t2'])] } }),
        pk('llm', 'harness', 'green', 'tool_use', ['order_id: A1024'], [shown.cost.total, 'INFER', `t2：输入 ${num(N.v2Input)} token，${N.shownCost}；订单号写成了大写`, shown.http.response.bytes.length], resWire),
        note('request', `每条多 ${N.deltaInput} token`, 'amber'),
      ],
    },
    {
      title: '同一个评估集再跑一遍',
      desc: `${N.before} → ${N.after} / ${N.cases}，花 ${N.runCost}`,
      detail: `其余 ${N.cases - 1} 条照样发出，${N.cases} 条一共 ${N.runCost}：每改一次提示，就要把整个评估集再付一遍。通过数从 ${N.before} 涨到 ${N.after}，可两个 Wilson 95% 区间 ${range(N.beforeRate)} 和 ${range(N.afterRate)} 几乎完全重叠。Anthropic 的评估检查清单（claude-api skill）给了一个粗略的估计：两次通过率之差的 95% 区间，半宽大约是 1 / √(用例数 × 重复次数)，${N.cases} 条各跑一次约 ${N.noise} 个百分点，比这次 ${(100 * (N.after - N.before) / N.cases).toFixed(1)} 个百分点的变化大得多。`,
      facts: [['改前', `${N.before} / ${N.cases}（${range(N.beforeRate)}）`], ['改后', `${N.after} / ${N.cases}（${range(N.afterRate)}）`], ['噪声', `约 ±${N.noise} 个百分点`], ['再跑一遍', N.runCost]],
      events: [
        pk('harness', 'llm', 'blue', `其余 ${N.cases - 1} 条`, ['提示 v2'], [shown.cost.total, 'HTTP', `其余 ${N.cases - 1} 条用例逐条发出`, null], restWire),
        pk('llm', 'harness', 'green', `${N.cases - 1} 个响应`, [`合计 ${N.runCost}`], [C, 'INFER', `${N.cases} 条都跑完，累计 ${N.runCost}`, null], restWire, { ds: { results: [resultsGrid(1)] } }),
        state('harness', { 改前: `${N.before} / ${N.cases}`, 改后: `${N.after} / ${N.cases}`, 费用: N.runCost }),
        pk('harness', 'results', 'teal', '通过率', [`${N.before} → ${N.after}`], [C, 'STATS', `通过 ${N.before} → ${N.after}；Wilson ${range(N.beforeRate)} 和 ${range(N.afterRate)}`, rateJson.bytes.length], wire('两次的通过率（本站的写法）', 'mem', 'internal', jsonBody('通过率', rateJson, { notes: { before: '第 ⑦ 课改过评分器之后的结果。', after: '提示 v2 的这次运行。' } }))),
        note('harness', `${N.before} → ${N.after}，区间几乎重叠`),
      ],
    },
    {
      title: '逐条对齐：谁变好，谁变坏',
      desc: `变好 ${N.improved.length}、变坏 ${N.regressed.length}、没变 ${N.ties}`,
      detail: `把两次运行按用例 id 对齐，${N.cases} 条分成四类：都过 ${N.bothPass}、都不过 ${N.bothFail}、变好 ${N.improved.length}（${ids(N.improved)}）、变坏 ${N.regressed.length}（${ids(N.regressed)}）。通过数只涨了 ${N.after - N.before} 条，底下其实有 ${N.discordant} 条换了结果，只看通过率，这 ${N.regressed.length} 条变坏的就被变好的抵掉了。意图分类和工单摘要的提示没改，它们的输出和上次一样；真实的模型每次输出可能不同，没改的地方也会有几条来回翻，所以评估集最好每条跑几次。`,
      facts: [['都过', `${N.bothPass} 条`], ['都不过', `${N.bothFail} 条`], ['变好', ids(N.improved)], ['变坏', ids(N.regressed)]],
      events: [
        show('matrix'),
        pk('harness', 'results', 'amber', '逐条对齐', [`↑ ${N.improved.length}`, `↓ ${N.regressed.length}`], [C, 'EVAL', `变好 ${ids(N.improved)}；变坏 ${ids(N.regressed)}`, diffJson.bytes.length], wire('逐用例对比（本站的写法）', 'mem', 'internal', jsonBody('对比', diffJson, { notes: { improved: '改前不过、改后过。', regressed: '改前过、改后不过。' } })), { ds: { results: [resultsGrid(2)] } }),
        pk('harness', 'matrix', 'teal', '2 × 2 表', [`b = ${N.b}`, `c = ${N.c}`], [C, 'STATS', `前过后过 ${N.bothPass}、前过后不过 ${N.b}、前不过后过 ${N.c}、都不过 ${N.bothFail}`, diffJson.bytes.length], wire('2 × 2 表（本站的写法）', 'mem', 'internal', jsonBody('对比', diffJson)), { ds: { matrix: [pairTable()] } }),
        note('results', `只看通过率：+${N.after - N.before}`, 'amber'),
      ],
    },
    {
      title: '精确 McNemar：只看不一致的',
      desc: `b = ${N.b}、c = ${N.c}，p = ${N.p.toFixed(2)}`,
      detail: `两次运行用的是同一批用例，是配对的数据，不能把两个通过率当成两组独立的样本来比。McNemar 检验只看结果不一致的用例：没有差别时，${N.discordant} 条里变坏的条数服从 B(${N.discordant}, 0.5)，这里 b = ${N.b}、c = ${N.c}，精确的双侧 p = ${N.p.toFixed(2)}（不一致的格子很少时，维基百科说传统做法是用精确的二项检验）。${N.discordant} 条不一致里，要 ${sig.map((s) => `${s.k} 比 ${N.discordant - s.k}`).join('、')} 这么悬殊 p 才小于 0.05（${N.discordant - 1} 比 1 时 p = ${splits[1].p.toFixed(3)}），这个评估集太小，判断不了 v2 整体是不是更好。`,
      facts: [['b（变坏）', String(N.b)], ['c（变好）', String(N.c)], ['p', N.p.toFixed(2)], ['p < 0.05 需要', sig.map((s) => `${s.k} 比 ${N.discordant - s.k}`).join('、')]],
      events: [
        pk('harness', 'matrix', 'teal', '精确 McNemar', [`p = ${N.p.toFixed(2)}`], [C, 'STATS', `b = ${N.b}、c = ${N.c}，B(${N.discordant}, 0.5) 下双侧 p = ${N.p.toFixed(2)}`, testJson.bytes.length], wire('McNemar（本站的写法）', 'mem', 'internal', jsonBody('检验', testJson, { notes: { b: '改前过、改后不过。', c: '改前不过、改后过。', ties: '两次结果相同的用例：不参与检验。', p: `精确二项检验的双侧 p（把概率不大于观测值的结果加起来）。` } }), concept(`${N.discordant} 条不一致时的 p`, splits.map((s): [string, string] => [`${s.k} 比 ${N.discordant - s.k}`, s.p.toFixed(4)]))), { ds: { matrix: [pairTable(true)] } }),
        note('matrix', `p = ${N.p.toFixed(2)}：分不出好坏`),
      ],
    },
    {
      title: '变坏的三条，逐条看',
      desc: `${ids(N.regressed)}：一条违规、一条漏说、一条是评分器的错`,
      detail: `统计分不出好坏，变坏的用例却每条都要看：q5 问已经签收 ${A1025_DAYS} 天的热水壶能不能退款，v2 为了简短直接答应「可以退款」，违反售后规则，这种用例应该列为必须通过，一条不过就不能上线。q1 也是被「一两句话说完」砍掉了运费由谁出；t4 的回答其实对，是评分器只认调用 search_policy 这一种做法，检查清单说评分器该看结果而不是路径，要改的是评分器。所以 v2 不能直接上线：保留订单号大写、质量问题、先查订单这三句，把「简短」改成不能省略期限和运费，再跑一遍。`,
      facts: [['q5', '答应超期退款：违规'], ['q1', '砍掉了运费由谁出'], ['t4', '评分器只认一条路径'], ['结论', '改提示，再跑一遍']],
      events: [
        pk('harness', 'results', 'amber', '变坏的用例', N.regressed.map((id) => `${id}↓`), [C, 'CHECK', `逐条看变坏的 ${ids(N.regressed)}`, null], wire('变坏的用例', 'mem', '示意', caseConcept(N.regressed, '变坏'), caseConcept(N.improved, '变好')), { ds: { results: [resultsGrid(2, N.regressed)] } }),
        state('harness', { 结论: '不上线' }),
        note('results', 'q5 违规：必须通过的用例', 'amber'),
      ],
    },
  ],
  outro: {
    title: '回归要逐条看，不能只看通过率',
    desc: `${N.before} → ${N.after} 的背后：${N.improved.length} 条变好、${N.regressed.length} 条变坏`,
    text: `改提示之后，同一个评估集、同一套评分器再跑一遍（这一课 ${N.runCost}），按用例对齐，才看得到哪几条变好、哪几条变坏。通过率涨了 ${N.after - N.before} 条，可变坏的 ${N.regressed.length} 条里有一条违反售后规则；配对的数据用 McNemar 只看不一致的用例，${N.cases} 条用例下 p = ${N.p.toFixed(2)}，统计上分不出谁好。本站的评估集小、每条只跑一次、输出是脚本，真实的回归要更多用例、每条多跑几次，再把高风险的用例设成必须通过。评估组到这里结束，下一课进入可观测性：一次线上请求的 trace，失败的请求怎样被记下来、变成新的评估用例。`,
    facts: [['变好', ids(N.improved)], ['变坏', ids(N.regressed)], ['McNemar', `p = ${N.p.toFixed(2)}`], ['下一课', '一次请求的 trace']],
  },
};
