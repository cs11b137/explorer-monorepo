/**
 * 评估组第一课：确定性评估。评估运行器把 22 条用例（意图分类、客服回答、工单摘要三个调用点）逐条发给模型，
 * 每次调用经 callModel 真实计算 token 和费用（输出是示例）；再用四种不调用模型的评分器打分（core/evals.ts）：
 * 精确匹配（先规范化）、正则（必须出现 / 不能出现）、JSON 解析和 Schema（llm-core 的 validate）、
 * 工具调用核对（按小铺的 input_schema 校验参数、指定参数的值）。通过率带 Wilson 区间，按评分器拆开；
 * 最后抽查失败的用例，发现两条是评分器自己写得太死，改了再算一遍。tests/narrative.eval.test.ts 核对文案。
 */
import {
  callModel,
  encodeJson,
  formatPrice,
  formatUsd,
  normalizeAnswer,
  PRICE_DATE,
  priceOf,
  regexCheck,
  runEval,
  SHOP_TOOL_DEFS,
  utf8Encode,
  type ContentBlock,
  type EvalReport,
  type Grade,
  type ModelCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, segmentsOf, utf8Lines, wire } from '../decode/structures';
import { pct } from './common';
import { note, pk, show, state } from './dsl';
import { DET_CASES, FIXED_PATTERNS, GRADER_TAG, gradeCase, OUTPUTS_V1, requestOf, stripEndPunct, type DetCase, type Expect, type GraderMode } from './evalset';
import { MODEL } from './scenario';
import type { DsCell, GridPrim, Lesson, LessonEvent, RowPrim, Tone } from './types';

// ---------- 真实计算 ----------

/** 22 条用例各调用一次模型（输出是示例），种子 700 + 序号。 */
export const calls: ModelCall[] = DET_CASES.map((item, i) => callModel(requestOf(item), OUTPUTS_V1[item.id], 700 + i));
const costs = calls.map((c) => c.cost.total);
export const runCost = costs.reduce((a, b) => a + b, 0);

const grader = (mode: GraderMode) => (out: ContentBlock[], item: { id: string }) => gradeCase(out, item as DetCase, mode);
export const strict: EvalReport<ContentBlock[], Expect> = runEval(DET_CASES, OUTPUTS_V1, grader('strict'));
export const fixed: EvalReport<ContentBlock[], Expect> = runEval(DET_CASES, OUTPUTS_V1, grader('fixed'));

const caseOf = (id: string) => DET_CASES.find((item) => item.id === id)!;
const gradeOf = (report: EvalReport<ContentBlock[], Expect>, id: string): Grade => report.rows.find((row) => row.item.id === id)!.grade;
const textOf = (id: string) => OUTPUTS_V1[id].map((b) => (b.type === 'text' ? b.text : '')).join('');
const toolOf = (id: string) => OUTPUTS_V1[id].find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }> | undefined;
const KINDS = ['label', 'regex', 'ticket', 'tool'] as const;
type Kind = (typeof KINDS)[number];
const tag = (kind: Kind) => GRADER_TAG[kind];
const failedIds = (report: EvalReport<ContentBlock[], Expect>) => report.rows.filter((row) => !row.grade.pass).map((row) => row.item.id);
/** 抽查失败的用例：strict 不过、fixed 过的就是评分器的错。 */
export const graderErrors = failedIds(strict).filter((id) => gradeOf(fixed, id).pass);

const first = calls[DET_CASES.findIndex((item) => item.id === 't1')];
const siteCount = (site: DetCase['site']) => DET_CASES.filter((item) => item.site === site).length;
const byTag = (report: EvalReport<ContentBlock[], Expect>, kind: Kind) => report.byTag[tag(kind)];

export const numbers = {
  cases: DET_CASES.length,
  router: siteCount('router'),
  reply: siteCount('reply'),
  ticket: siteCount('ticket'),
  graders: KINDS.length,
  runCost: formatUsd(runCost),
  runCostNano: runCost,
  firstCost: formatUsd(first.cost.total),
  firstInput: first.message.usage.input_tokens,
  firstOutput: first.message.usage.output_tokens,
  firstBytes: first.http.request.bytes.length,
  replyInputMin: Math.min(...calls.filter((_, i) => DET_CASES[i].site === 'reply').map((c) => c.message.usage.input_tokens)),
  routerInputMax: Math.max(...calls.filter((_, i) => DET_CASES[i].site === 'router').map((c) => c.message.usage.input_tokens)),
  inputPrice: formatPrice(priceOf(MODEL).input),
  outputPrice: formatPrice(priceOf(MODEL).output),
  passed: strict.passed,
  rate: strict.rate,
  failed: failedIds(strict),
  fixedPassed: fixed.passed,
  fixedRate: fixed.rate,
  graderErrors,
  byTag: Object.fromEntries(KINDS.map((kind) => [kind, byTag(strict, kind)])) as Record<Kind, { passed: number; total: number }>,
  fixedByTag: Object.fromEntries(KINDS.map((kind) => [kind, byTag(fixed, kind)])) as Record<Kind, { passed: number; total: number }>,
};
const N = numbers;
const range = (r: { lo: number; hi: number }) => `${pct(r.lo)}–${pct(r.hi)}`;

// ---------- 图元 ----------

const ROW_NAME: Record<Kind, string> = { label: '精确', regex: '正则', ticket: 'Schema', tool: '工具' };
const casesOf = (kind: Kind) => DET_CASES.filter((item) => item.expected.kind === kind);
const COLS = Math.max(...KINDS.map((kind) => casesOf(kind).length));

/** 评估集：每行一种评分器，格子是用例的 id；评过的 green（过）或 amber（不过）。 */
function resultsGrid(done: readonly Kind[], lift: readonly string[] = [], report = strict): GridPrim {
  return {
    kind: 'grid',
    id: 'g',
    w: 46,
    rows: KINDS.map((kind) => ROW_NAME[kind]),
    cols: Array.from({ length: COLS }, (_, i) => String(i + 1)),
    cells: KINDS.map((kind) => Array.from({ length: COLS }, (_, i): DsCell => {
      const item = casesOf(kind)[i];
      if (!item) return { v: '', tone: 'empty' };
      const tone: Tone = done.includes(kind) ? (gradeOf(report, item.id).pass ? 'green' : 'amber') : 'blue';
      return { v: item.id, tone, lift: lift.includes(item.id) || undefined };
    })),
  };
}

/** 一条输出切成格子：v 是格子里的字，sub 是下面的小字。 */
const outRow = (cells: Array<[v: string, sub: string, tone: Tone, lift?: boolean]>): RowPrim => ({
  kind: 'row',
  id: 'o',
  w: 66,
  cells: cells.map(([v, sub, tone, lift], i) => ({ v, sub, tone, key: `o${i}`, lift: lift || undefined })),
});

/** 文字按正则命中切段：格子写 UTF-8 字节数，命中的段写标签。 */
function textRow(text: string, hits: Array<{ from: number; to: number; label: string; tone: Tone }>): RowPrim {
  const segs = segmentsOf(text, hits.map((h) => ({ from: h.from, to: h.to, label: h.label }))).flatMap((seg) => {
    if (seg.hit) return [seg];
    // 没命中的部分按句号、逗号再切开，格子短一些。
    const out: typeof seg[] = [];
    let at = seg.from;
    for (const m of seg.text.matchAll(/[，。？！]/gu)) {
      const end = seg.from + m.index! + 1;
      if (end - at <= 1) continue;
      out.push({ from: at, to: end, text: text.slice(at, end), hit: null });
      at = end;
    }
    if (at < seg.to) out.push({ from: at, to: seg.to, text: text.slice(at, seg.to), hit: null });
    return out;
  });
  return outRow(segs.map((seg) => {
    const hit = hits.find((h) => h.label === seg.hit);
    return [String(utf8Encode(seg.text).length), hit ? hit.label : '…', hit ? hit.tone : 'slate', !!hit];
  }));
}

const spanOf = (text: string, pattern: string) => {
  const m = new RegExp(pattern, 'u').exec(text);
  return m ? { from: m.index, to: m.index + m[0].length } : null;
};

/** 精确匹配：输出逐字画出来，规范化去掉的字符 slate，多出来的 amber。 */
function labelRow(id: string): RowPrim {
  const raw = textOf(id);
  const norm = normalizeAnswer(raw);
  const expected = (caseOf(id).expected as Extract<Expect, { kind: 'label' }>).label;
  return outRow([...raw].map((ch, i): [string, string, Tone, boolean] => {
    if (/\s/u.test(ch)) return [ch === '\n' ? '↵' : '␣', '规范化去掉', 'slate', false];
    const inNorm = i < [...raw].length && norm.includes(ch);
    const extra = !expected.includes(ch);
    return [ch, `${utf8Encode(ch).length} B`, extra ? 'amber' : inNorm ? 'green' : 'slate', extra];
  }));
}

/** 工具调用：工具名一格，参数每个一格。 */
function toolRow(id: string): RowPrim {
  const call = toolOf(id);
  if (!call) return outRow([['无', 'tool_use', 'amber', true], ...textRow(textOf(id), []).cells.map((c): [string, string, Tone] => [c.v, 'text', 'slate'])]);
  const g = gradeOf(strict, id) as Grade & { problems: string[] };
  const bad = (key: string) => g.problems.some((p) => p.startsWith(key));
  return outRow([
    [SHOP_TOOL_DEFS[call.name as keyof typeof SHOP_TOOL_DEFS].title, 'name', 'teal'],
    ...Object.entries(call.input).map(([key, value]): [string, string, Tone, boolean] => [preview(String(value), 8), key, bad(key) ? 'amber' : 'green', bad(key)]),
  ]);
}

/** 工单 JSON：解析不了时按代码块切开；能解析时每个字段一格，缺的字段画成空格。 */
function ticketRow(id: string): RowPrim {
  const raw = textOf(id);
  const expected = (caseOf(id).expected as Extract<Expect, { kind: 'ticket' }>).value;
  if (raw.startsWith('```')) {
    const lines = raw.split('\n');
    return outRow([[lines[0], `${utf8Encode(lines[0]).length} B`, 'amber', true], ['{…}', `${utf8Encode(lines.slice(1, -1).join('\n')).length} B`, 'slate'], [lines[lines.length - 1], `${utf8Encode(lines[lines.length - 1]).length} B`, 'amber', true]]);
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  return outRow(Object.keys(expected).map((key): [string, string, Tone, boolean] => (key in value ? [preview(String(value[key]), 8), key, 'green', false] : ['缺', key, 'amber', true])));
}

const tally = (report: EvalReport<ContentBlock[], Expect>, kind: Kind) => report.byTag[tag(kind)];
function matrixGrid(withFixed: boolean): GridPrim {
  const rows = [...KINDS.map((kind) => [ROW_NAME[kind], tally(strict, kind), tally(fixed, kind)] as const), ['合计', { passed: strict.passed, total: strict.total }, { passed: fixed.passed, total: fixed.total }] as const];
  return {
    kind: 'grid',
    id: 'm',
    w: 46,
    rows: rows.map(([name]) => name),
    cols: ['过', '总数', '改后'],
    cells: rows.map(([name, s, f]): DsCell[] => [
      { v: String(s.passed), tone: name === '合计' ? 'teal' : 'green' },
      { v: String(s.total), tone: 'slate' },
      withFixed ? { v: String(f.passed), tone: f.passed > s.passed ? 'teal' : 'dim' } : { v: '', tone: 'empty' },
    ]),
  };
}

// ---------- 字节层 ----------

const gradeJson = (id: string, report = strict, mode: GraderMode = 'strict') => {
  const g = gradeOf(report, id);
  return encodeJson({ case: id, grader: tag(caseOf(id).expected.kind), mode, pass: g.pass, reason: g.reason });
};
const gradeWire = (id: string, title: string, extra: ReturnType<typeof concept>[] = [], report = strict, mode: GraderMode = 'strict') => {
  const item = caseOf(id);
  const out = OUTPUTS_V1[id];
  const outLayer = out[0].type === 'tool_use'
    ? jsonBody('模型的输出：tool_use 块', encodeJson(out[0]), { example: ['id', 'input'], notes: { id: '每次都不同的示例 id。', input: '模型给的参数（示例）。' } })
    : utf8Lines('模型的输出', textOf(id), { color: 'green', summary: '模型写的（示例）' });
  return wire(title, 'mem', 'internal',
    jsonBody('评分结果（本站的写法）', gradeJson(id, report, mode), { notes: { grader: `${tag(item.expected.kind)}：不调用模型，同样的输入永远给同样的结果。`, pass: gradeOf(report, id).pass ? 'true：过。' : 'false：不过。', reason: '评分器给的一句话原因。' } }),
    outLayer, ...extra);
};
const expectConcept = (id: string) => {
  const item = caseOf(id);
  return concept('用例', [['id', id], ['输入', preview(item.input, 24)], ['期望', preview(JSON.stringify(item.expected), 40)]], 'blue');
};

const requestWire = wire('发给模型的请求（用例 t1）', 'mem', 'format',
  httpHead('请求头', first.http.request, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'] }),
  jsonBody('请求体', encodeJson(first.request), { notes: { system: '客服的系统提示 v1：店铺规则逐条写进去，再交代什么时候调用哪个工具。', tools: `小铺的 ${first.request.tools!.length} 个工具：name、description、input_schema（取自共享包的 SHOP_TOOL_DEFS）。`, messages: '用例的输入就是用户的这句话。' } }));
const responseWire = wire('模型的响应（用例 t1）', 'mem', 'format',
  httpHead('响应头', first.http.response, { example: ['request-id', 'date'] }),
  jsonBody('响应体', encodeJson(first.message), { expand: ['usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content', 'usage', 'usage.input_tokens', 'usage.output_tokens'], notes: { content: '一个 tool_use 块（示例）：评分器要检查的就是它。', stop_reason: 'tool_use：模型要调用工具。', 'usage.input_tokens': '本站分词器的计数：系统提示、工具定义、工具使用的系统提示都算在内。' } }));
const restRows = DET_CASES.map((item, i): [string, string, string] => [item.id, `${num(calls[i].message.usage.input_tokens)} + ${calls[i].message.usage.output_tokens} token`, formatUsd(calls[i].cost.total)]).filter(([id]) => id !== 't1');
const restWire = wire('其余用例', 'mem', '示意', concept(`其余 ${N.cases - 1} 条（输入 + 输出 token，费用）`, restRows));
const reportJson = encodeJson({ cases: N.cases, passed: N.passed, rate: +N.rate.estimate.toFixed(3), wilson95: [+N.rate.lo.toFixed(3), +N.rate.hi.toFixed(3)], by_grader: Object.fromEntries(KINDS.map((kind) => [tag(kind), [N.byTag[kind].passed, N.byTag[kind].total]])) });
const fixedJson = encodeJson({ cases: N.cases, passed: N.fixedPassed, rate: +N.fixedRate.estimate.toFixed(3), wilson95: [+N.fixedRate.lo.toFixed(3), +N.fixedRate.hi.toFixed(3)], grader_errors: N.graderErrors });

// ---------- 事件 ----------

const C = N.runCostNano;
const evalPk = (id: string, title: string, lift: string[], row: RowPrim, done: Kind[], extra: ReturnType<typeof concept>[] = []): LessonEvent => {
  const g = gradeOf(strict, id);
  return pk('harness', 'message', g.pass ? 'green' : 'amber', `${id} ${g.pass ? '过' : '不过'}`, [preview(g.reason, 16)], [C, 'EVAL', `${id}（${caseOf(id).short}）：${g.reason}`, gradeJson(id).bytes.length], gradeWire(id, title, [expectConcept(id), ...extra]), { ds: { message: [row], results: [resultsGrid(done, lift)] } });
};

// 正则的命中区间。
const q1Text = textOf('q1');
const q1Hits = (['7 ?天', '运费'] as const).map((p, i) => ({ ...spanOf(q1Text, p)!, label: i ? '运费' : '7 天', tone: 'teal' as Tone }));
const q3Text = textOf('q3');
const q3Phone = regexCheck(q3Text, '1[3-9]\\d{9}', { mustMatch: false });
const q4Text = textOf('q4');
const q4Fixed = spanOf(q4Text, FIXED_PATTERNS['7 ?天'])!;

const k2 = gradeOf(strict, 'k2');
const k3 = gradeOf(strict, 'k3');
const firstLine = (s: string) => s.split('\n')[0];

export const deterministic: Lesson = {
  id: 'deterministic',
  name: 'DETERMINISTIC',
  title: '确定性评估：匹配、正则与 Schema',
  group: 'eval',
  layer: [2, 5],
  layerNote: '评分器检查的是应用从模型拿到的东西（一个类别名、一段回答、一个工具调用、一段 JSON），在评估运行器里离线跑，所以从「应用」到「评估」。',
  costNote: `评估运行器把 ${N.cases} 条用例各发给 Claude Opus 5.5 一次，共 ${N.runCost}；评分器本身不调用模型，打分不花钱。`,
  nodes: ['harness', 'llm', 'results', 'message', 'matrix'],
  place: { harness: [500, 330], llm: [890, 120], results: [170, 330], message: [210, 680], matrix: [830, 650] },
  labels: {
    harness: ['评估运行器', '逐条发出、逐条打分'],
    llm: ['模型', MODEL],
    results: ['评估集', `${N.cases} 条，按评分器分行`],
    message: ['正在检查的输出', '格子：字、参数或字节数'],
    matrix: ['通过数', '按评分器拆开'],
  },
  labelAt: { results: [0, 135], message: [0, 110], matrix: [0, 150] },
  radius: { results: 80, message: 70, matrix: 70 },
  initial: { results: [], message: [], matrix: [] },
  start: ['harness', 'llm'],
  legend: [['blue', '用例'], ['green', '过、模型的输出'], ['amber', '不过、出问题的部分'], ['teal', '命中、汇总'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '不调用模型的评分器：能写成规则的「对」，就用代码检查',
    description: `一个 AI 功能答得好不好，第一步是把「对」写成能用代码检查的条件。这一课的评估集有 ${N.cases} 条本站自写的用例，覆盖客服的三个调用点：意图分类、带工具的回答、工单 JSON。评估运行器把它们逐条发给模型（共 ${N.runCost}），再用四种不调用模型的评分器打分：精确匹配、正则、JSON Schema、工具调用核对。第一次算出通过 ${N.passed} / ${N.cases}，抽查失败的用例才发现，其中 ${N.graderErrors.length} 条是评分器自己写得太死。`,
    facts: [
      ['评估集', `${N.cases} 条（${N.router} 分类、${N.reply} 回答、${N.ticket} 工单）`],
      ['评分器', '精确匹配、正则、Schema、工具调用'],
      ['通过', `${N.passed} / ${N.cases} → 改评分器后 ${N.fixedPassed} / ${N.cases}`],
      ['费用', `${N.runCost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '评估集：把「对」写成条件',
      desc: `${N.cases} 条用例逐条发给模型，共 ${N.runCost}`,
      detail: `评估集的每条用例是一个输入加一个期望：分类该是哪个类别、回答里必须有什么不能有什么、该调用哪个工具带什么参数、工单 JSON 每个字段该是什么。评估运行器把 ${N.cases} 条用例逐条发给客服用的模型，带工具的回答每次输入约 ${num(N.replyInputMin)} token（店铺规则和 ${first.request.tools!.length} 个工具定义都在里面），按示例单价跑一遍是 ${N.runCost}，改一次提示就要再付一遍。Anthropic 的文档把评分方法排了序：能用代码评的先用代码，最快、最可靠、最好扩展，缺点是只能检查写得出规则的东西。`,
      facts: [['用例', `${N.cases} 条，本站自写`], ['t1 一次', `${num(N.firstInput)} + ${N.firstOutput} token，${N.firstCost}`], ['跑一遍', N.runCost], ['评分器', `${N.graders} 种，不调用模型`]],
      events: [
        show('results', 'message'),
        state('harness', { 用例: `${N.cases} 条`, 已跑: '0 条' }),
        pk('harness', 'llm', 'blue', 'POST /v1/messages', ['t1 查单', `${num(N.firstBytes)} 字节`], [0, 'HTTP', 't1：系统提示 v1、4 个工具、用户的一句话', N.firstBytes], requestWire, { ds: { results: [resultsGrid([], ['t1'])] } }),
        pk('llm', 'harness', 'green', 'tool_use', ['get_order', `${N.firstOutput} token`], [first.cost.total, 'INFER', `t1：输入 ${num(N.firstInput)}、输出 ${N.firstOutput} token，${N.firstCost}`, first.http.response.bytes.length], responseWire, { ds: { message: [toolRow('t1')] } }),
        pk('harness', 'llm', 'blue', `其余 ${N.cases - 1} 条`, ['同样的写法'], [first.cost.total, 'HTTP', `其余 ${N.cases - 1} 条用例逐条发出（分类、回答、工单三种请求）`, null], restWire, { ds: { results: [resultsGrid([], DET_CASES.filter((item) => item.id !== 't1').map((item) => item.id))] } }),
        pk('llm', 'harness', 'green', `${N.cases - 1} 个响应`, [`合计 ${N.runCost}`], [C, 'INFER', `${N.cases} 条都跑完，累计 ${N.runCost}`, null], restWire, { ds: { results: [resultsGrid([])] } }),
        state('harness', { 已跑: `${N.cases} 条`, 费用: N.runCost }),
        note('harness', `跑一遍 ${N.runCost}`),
      ],
    },
    {
      title: '精确匹配：先规范化，再逐字比',
      desc: `分类 ${N.byTag.label.passed} / ${N.byTag.label.total}：多一个句号也算错`,
      detail: `意图分类只该回一个类别名，最适合精确匹配：本站先做 NFKC、去掉首尾空白、合并空白，再逐字比较，所以 c2 末尾多一个换行照样算对。Anthropic 文档的精确匹配例子也是先去空白、统一大小写再比，并说它适合答案是固定类别的任务。c6 把「杯盖丢了能补发吗」分成${quote(textOf('c6'))}，是真错；c3 回的是「${stripEndPunct(textOf('c3'))}」加一个句号，只多了这一个字符，也被判不过。`,
      facts: [['规范化', 'NFKC、去首尾空白、合并空白'], ['c2', '末尾的换行被去掉，过'], ['c3', `「${textOf('c3')}」，不过`], ['c6', `应为「其他」，不过`]],
      events: [
        evalPk('c2', '精确匹配：c2', ['c2'], labelRow('c2'), ['label']),
        evalPk('c3', '精确匹配：c3', ['c3'], labelRow('c3'), ['label']),
        evalPk('c6', '精确匹配：c6', ['c6'], labelRow('c6'), ['label']),
        note('message', `c3 只多了一个「。」`, 'amber'),
      ],
    },
    {
      title: '正则：必须出现、不能出现',
      desc: `回答 ${N.byTag.regex.passed} / ${N.byTag.regex.total}：编出来的电话被抓到`,
      detail: `开放的回答没有唯一的标准答案，但可以规定必须提到什么、不能出现什么：q1 问签收 5 天能不能退，回答里要有「7 天」和「运费」，两个都匹配到了。q3 问客服电话，规则里根本没有电话，回答却写了一个手机号，「不能出现手机号」这条正则把它抓了出来。q4 的回答写的是「七天」而不是「7 天」，意思完全对，正则却不认。`,
      facts: [['q1', '「7 天」「运费」都有，过'], ['q3', `不该出现「${q3Phone.match}」`], ['q4', '写成「七天」，正则不认'], ['正则', `本站写的，${N.byTag.regex.total} 条各有自己的条件`]],
      events: [
        evalPk('q1', '正则：q1', ['q1'], textRow(q1Text, q1Hits), ['label', 'regex']),
        evalPk('q3', '正则：q3', ['q3'], textRow(q3Text, [{ ...spanOf(q3Text, '1[3-9]\\d{9}')!, label: '手机号', tone: 'amber' }]), ['label', 'regex']),
        evalPk('q4', '正则：q4', ['q4'], textRow(q4Text, [{ ...q4Fixed, label: '七天', tone: 'amber' }]), ['label', 'regex']),
        note('message', '「七天」不匹配 7 ?天', 'amber'),
      ],
    },
    {
      title: 'JSON 和 Schema：先能解析，再看字段',
      desc: `工单 ${N.byTag.ticket.passed} / ${N.byTag.ticket.total}：代码块包裹、缺字段`,
      detail: `工单摘要只许输出一个 JSON 对象，评分器先 JSON.parse，再按 schema 校验字段名、类型、枚举值、订单号的格式，都过了再逐个比对字段的值。k2 把 JSON 包在 Markdown 代码块里，第一个字符就解析失败，这是真失败：后端的 JSON.parse 同样会失败；k3 漏了 needs_human，这一单恰恰该转人工。这个调用只在提示里要求 JSON，Anthropic 的结构化输出（output_config.format）能保证输出可解析、符合 schema（拒答和撞到 max_tokens 时除外），但字段的值对不对仍然要比对。`,
      facts: [['k1', '符合 schema，字段值都对'], ['k2', `包在 ${firstLine(textOf('k2'))} 代码块里，解析失败`], ['k3', k3.reason], ['结构化输出', '保证格式，不保证值对']],
      events: [
        evalPk('k1', 'Schema：k1', ['k1'], ticketRow('k1'), ['label', 'regex', 'ticket']),
        evalPk('k2', 'Schema：k2', ['k2'], ticketRow('k2'), ['label', 'regex', 'ticket'], [concept('JSON.parse 的错误', [['错误', firstLine(k2.reason).replace('不是合法的 JSON：', '')]], 'amber')]),
        evalPk('k3', 'Schema：k3', ['k3'], ticketRow('k3'), ['label', 'regex', 'ticket']),
        note('message', 'k3 缺 needs_human', 'amber'),
      ],
    },
    {
      title: '工具调用：工具名、参数格式、参数值',
      desc: `工具 ${N.byTag.tool.passed} / ${N.byTag.tool.total}：格式对的参数也可能是错的`,
      detail: `带工具的用例检查三件事：调没调用、调的是不是那个工具、参数按小铺的 input_schema 校验之后，指定参数的值对不对。t2 把订单号写成小写的 ${String(toolOf('t2')!.input.order_id)}，不匹配 schema 里的 ^A\\d{4}$；t3 的参数完全符合 schema，但杯盖漏水是质量问题，reason 却是 ${String(toolOf('t3')!.input.reason)}；t6 问 A1025 能不能退，模型没查订单就答应了。工具定义加 strict: true 能保证参数符合 schema，可 t3 这种「格式对、值错」的问题只有核对期望值才看得出来。`,
      facts: [['t2', `order_id 是 ${String(toolOf('t2')!.input.order_id)}，不合 schema`], ['t3', `reason 是 ${String(toolOf('t3')!.input.reason)}，应为 quality`], ['t6', '没有调用工具'], ['strict: true', '保证格式，不保证选对']],
      events: [
        evalPk('t2', '工具调用：t2', ['t2'], toolRow('t2'), ['label', 'regex', 'ticket', 'tool']),
        evalPk('t3', '工具调用：t3', ['t3'], toolRow('t3'), ['label', 'regex', 'ticket', 'tool']),
        evalPk('t6', '工具调用：t6', ['t6'], toolRow('t6'), ['label', 'regex', 'ticket', 'tool']),
        note('message', 't6 没查订单就答应了', 'amber'),
      ],
    },
    {
      title: '汇总，再抽查评分器自己',
      desc: `${N.passed} / ${N.cases} → ${N.fixedPassed} / ${N.cases}，区间都很宽`,
      detail: `${N.cases} 条全部评完，通过 ${N.passed} 条，通过率 ${pct(N.rate.estimate)}，Wilson 95% 区间 ${range(N.rate)}：样本这么少，区间宽到几乎说明不了什么，按评分器拆开看哪里出问题更有用。抽查 ${N.failed.length} 条失败的用例，c3 多一个句号、q4 写成「七天」都是评分器写得太死，占了 ${N.graderErrors.length} / ${N.failed.length}；把精确匹配改成先去掉末尾的句号、正则改成 [7七] ?天 之后，通过 ${N.fixedPassed} 条（${pct(N.fixedRate.estimate)}，${range(N.fixedRate)}）。评分器不调用模型，改了重算一遍不花钱，可语气好不好、有没有真正帮到用户，正则写不出来。`,
      facts: [['第一次', `${N.passed} / ${N.cases}（${range(N.rate)}）`], ['评分器的错', N.graderErrors.join('、')], ['改后', `${N.fixedPassed} / ${N.cases}（${range(N.fixedRate)}）`], ['重算', '$0：评分器不调用模型']],
      events: [
        show('matrix'),
        pk('harness', 'matrix', 'teal', '汇总', [`${N.passed} / ${N.cases}`, pct(N.rate.estimate)], [C, 'STATS', `通过 ${N.passed} / ${N.cases}，Wilson 95% ${range(N.rate)}`, reportJson.bytes.length], wire('评估报告（本站的写法）', 'mem', 'internal', jsonBody('评估报告', reportJson, { expand: ['wilson95'], notes: { wilson95: 'Wilson 得分区间：小样本时比「通过率 ± 1.96 × 标准误」靠谱。', by_grader: '按评分器拆开：[过, 总数]。' } })), { ds: { matrix: [matrixGrid(false)], results: [resultsGrid(KINDS)] } }),
        note('matrix', `${pct(N.rate.estimate)}，区间 ${range(N.rate)}`),
        pk('harness', 'results', 'amber', '抽查失败', [`${N.failed.length} 条`], [C, 'CHECK', `逐条看 ${N.failed.length} 条失败的输出：${N.graderErrors.join('、')} 其实是对的`, null], wire('抽查', 'mem', '示意', concept('失败的用例', N.failed.map((id): [string, string, string] => [id, graderErrors.includes(id) ? '评分器的错' : '真失败', gradeOf(strict, id).reason]), 'amber')), { ds: { results: [resultsGrid(KINDS, N.graderErrors)] } }),
        pk('harness', 'matrix', 'teal', '改评分器重算', [`${N.fixedPassed} / ${N.cases}`], [C, 'STATS', `去掉末尾句号、正则认「七天」：通过 ${N.fixedPassed} / ${N.cases}，${range(N.fixedRate)}`, fixedJson.bytes.length], wire('改评分器后的报告', 'mem', 'internal', jsonBody('评估报告', fixedJson, { notes: { grader_errors: '这两条在原来的评分器下不过、改后过：错在评分器，不在模型。' } }), concept('改了什么', [['精确匹配', `「${textOf('c3')}」→「${stripEndPunct(normalizeAnswer(textOf('c3')))}」`, '规范化之后再去掉末尾的句号。'], ['正则', `7 ?天 → ${FIXED_PATTERNS['7 ?天']}`, '「七天」也算。']])), { ds: { matrix: [matrixGrid(true)], results: [resultsGrid(KINDS, [], fixed)] } }),
        note('harness', `重算 $0，仍是 ${N.runCost}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '能写成规则的，先用代码评',
    desc: `${N.cases} 条用例、${N.graders} 种评分器，跑一遍 ${N.runCost}`,
    text: `确定性评分器便宜、快、结果可复现：精确匹配管固定类别，正则管必须有和不能有，Schema 管结构，工具调用核对管调用了什么、参数对不对。它们的弱点也清楚：只认写进去的说法（c3 的句号、q4 的「七天」），格式对不等于值对（t3）。所以评分器本身也要被检查，抽查失败的用例是最便宜的办法。本站只有 ${N.cases} 条自写用例，通过率的区间宽达 ${range(N.fixedRate)}；回答有没有帮到用户、语气好不好，正则管不了，下一课请另一个模型当评委。`,
    facts: [['第一次', `${N.passed} / ${N.cases}`], ['评分器的错', `${N.graderErrors.length} 条`], ['改后', `${N.fixedPassed} / ${N.cases}`], ['下一课', 'LLM 当评委']],
  },
};

/** 文案里引用一句话时去掉末尾的标点（detail 按句号数句子）。 */
function quote(text: string): string {
  return `「${text.replace(/[。！？]$/, '')}」`;
}
