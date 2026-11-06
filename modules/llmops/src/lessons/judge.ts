/**
 * 评估组第二课：LLM 当评委。12 个开放问题各有两版回答（v1、v2，示例），共 24 条。
 * 评委模型（claude-sonnet-5-5，和被评的 claude-opus-5-5 不是同一个模型）按评分标准给每条打三项分（1–5），
 * core/evals.ts 的 rubricScore 按权重换成 0–1 的分数，再按本站的阈值分成好、可接受、差；
 * 成对比较时同一对回答交换顺序各问一次，positionBias 算翻转的比例；最后和人工裁决后的标签比，judgeAgreement 算一致数和 kappa。
 * 评估工具里的同类做法：DeepEval 的 G-Eval「uses LLM-as-a-judge with chain-of-thoughts (CoT)」，按自定义的 criteria（可选 evaluation_steps）打分，
 * 默认阈值 0.5（https://deepeval.com/docs/metrics-llm-evals，2026-11-07 核对）；课程正文不讲具体工具。
 * 评委写的分数、理由、二选一是脚本（E.G.）；每次评委调用都经 callModel，token 和费用真实计算。tests/narrative.eval.test.ts 核对文案。
 */
import {
  callModel,
  encodeJson,
  formatPrice,
  formatUsd,
  judgeAgreement,
  kappaBand,
  positionBias,
  PRICE_DATE,
  priceOf,
  rubricScore,
  unswap,
  type ModelCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, wire } from '../decode/structures';
import { pct } from './common';
import { note, pk, show, state } from './dsl';
import {
  ADJUDICATED,
  GOOD_AT,
  GRADE_SHORT,
  GRADES,
  JUDGE_MODEL,
  JUDGE_V1,
  judgeReply,
  judgeRequest,
  labelOfScore,
  OK_AT,
  OPEN,
  pairRequest,
  PAIRWISE,
  REPLY_KEYS,
  RUBRIC,
  tripleScores,
  type GradeLabel,
} from './evalset';
import { MODEL } from './scenario';
import type { DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

// ---------- 真实计算 ----------

const itemOf = (key: string) => OPEN.find((item) => item.id === key.replace(/v[12]$/, ''))!;
const answerOf = (key: string) => itemOf(key)[key.endsWith('v1') ? 'v1' : 'v2'];

/** 24 条回答各请评委打一次分（分数和理由是示例），种子 800 + 序号。 */
export const pointCalls: ModelCall[] = REPLY_KEYS.map((key, i) => callModel(judgeRequest(itemOf(key).question, answerOf(key)), judgeReply(JUDGE_V1[key]), 800 + i));
export const scores = REPLY_KEYS.map((key) => rubricScore(RUBRIC, tripleScores(JUDGE_V1[key][0])));
export const judgeLabels: GradeLabel[] = scores.map(labelOfScore);

/** 成对比较：每对回答按原顺序、交换顺序各问一次，种子 840 起。 */
export const pairCalls = PAIRWISE.map((p, i) => {
  const item = itemOf(p.id);
  return {
    original: callModel(pairRequest(item.question, item.v1, item.v2), JSON.stringify({ winner: p.original }), 840 + 2 * i),
    swapped: callModel(pairRequest(item.question, item.v2, item.v1), JSON.stringify({ winner: p.swapped }), 841 + 2 * i),
  };
});
export const bias = positionBias(PAIRWISE);
/** 两种顺序结论一致才算数：原顺序的 A 是 v1。 */
export const decided = PAIRWISE.map((p) => (p.original === unswap(p.swapped) ? (p.original === 'A' ? 'v1' : p.original === 'B' ? 'v2' : '平') : '未定'));

export const agreement = judgeAgreement(judgeLabels, ADJUDICATED, GRADES);
export const disagreements = REPLY_KEYS.filter((_, i) => judgeLabels[i] !== ADJUDICATED[i]);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pointCost = sum(pointCalls.map((c) => c.cost.total));
const pairCost = sum(pairCalls.map((c) => c.original.cost.total + c.swapped.cost.total));

const SHOW = REPLY_KEYS.indexOf('q7v1');
const shown = pointCalls[SHOW];
const PAIR = PAIRWISE.findIndex((p) => p.id === 'q10');
const pairShown = pairCalls[PAIR];
const count = (labels: readonly string[], label: GradeLabel) => labels.filter((l) => l === label).length;
const flips = PAIRWISE.filter((p) => p.original !== unswap(p.swapped)).map((p) => p.id);
const humanBad = REPLY_KEYS.filter((_, i) => ADJUDICATED[i] === '差');

export const numbers = {
  replies: REPLY_KEYS.length,
  questions: OPEN.length,
  criteria: RUBRIC.criteria.map((c) => `${c.id} ×${c.weight}`).join('、'),
  showKey: REPLY_KEYS[SHOW],
  showScore: scores[SHOW].toFixed(2),
  showInput: shown.message.usage.input_tokens,
  showOutput: shown.message.usage.output_tokens,
  showCost: formatUsd(shown.cost.total),
  showBytes: shown.http.request.bytes.length,
  good: count(judgeLabels, '好'),
  ok: count(judgeLabels, '可接受'),
  bad: count(judgeLabels, '差'),
  pointCost: formatUsd(pointCost),
  pointCostNano: pointCost,
  pairCalls: pairCalls.length * 2,
  pairCost: formatUsd(pairCost),
  totalCost: formatUsd(pointCost + pairCost),
  totalNano: pointCost + pairCost,
  flipped: bias.flipped,
  flips,
  flipRate: bias.flipRate,
  samePosition: bias.samePosition,
  firstPosition: bias.firstPosition,
  v1Wins: decided.filter((d) => d === 'v1').length,
  v2Wins: decided.filter((d) => d === 'v2').length,
  undecided: decided.filter((d) => d === '未定').length,
  agree: agreement.agree,
  kappa: agreement.kappa.toFixed(2),
  band: kappaBand(agreement.kappa),
  disagreements,
  humanBad,
  humanBadJudged: humanBad.map((key) => judgeLabels[REPLY_KEYS.indexOf(key)]),
  judgeInput: formatPrice(priceOf(JUDGE_MODEL).input),
  judgeOutput: formatPrice(priceOf(JUDGE_MODEL).output),
};
const N = numbers;
const range = (r: { lo: number; hi: number }) => `${pct(r.lo)}–${pct(r.hi)}`;

// ---------- 图元 ----------

const LABEL_TONE: Record<GradeLabel, Tone> = { 好: 'green', 可接受: 'teal', 差: 'amber' };
const POS: Record<string, string> = { A: 'A', B: 'B', tie: '平' };
const COLS = ['v1', 'v2', '原', '换', '判'];

/**
 * 一张表：每行一个问题。前两列是评委给 v1、v2 的三档，后三列是成对比较：原顺序选的位置、交换后选的位置、换回之后的结论（翻转的写「?」）。
 * labels 为 null 的格子还没评；pairs 是已经问完的对数，lift 里的问题抬起。
 */
function resultsGrid(labels: readonly (GradeLabel | null)[], pairs = 0, lift: readonly string[] = [], liftKeys: readonly string[] = [], onlyOriginal: string | null = null): GridPrim {
  return {
    kind: 'grid',
    id: 'r',
    w: 40,
    rows: OPEN.map((item) => item.id),
    cols: COLS,
    cells: OPEN.map((item, q): DsCell[] => {
      const label = (v: 'v1' | 'v2'): DsCell => {
        const key = `${item.id}${v}`;
        const l = labels[REPLY_KEYS.indexOf(key)];
        return l ? { v: GRADE_SHORT[l], tone: LABEL_TONE[l], lift: liftKeys.includes(key) || undefined } : { v: '', tone: 'empty' };
      };
      const p = PAIRWISE[q];
      const asked = q < pairs || lift.includes(item.id);
      const flip = decided[q] === '未定';
      const pair = (v: string, last = false): DsCell => (asked ? { v, tone: flip ? 'amber' : last ? 'green' : 'slate', lift: lift.includes(item.id) || undefined } : { v: '', tone: 'empty' });
      if (onlyOriginal === item.id) return [label('v1'), label('v2'), { v: POS[p.original], tone: 'slate', lift: true }, { v: '', tone: 'empty' }, { v: '', tone: 'empty' }];
      return [label('v1'), label('v2'), pair(POS[p.original]), pair(POS[p.swapped]), pair(flip ? '?' : decided[q], true)];
    }),
  };
}

/** 一条回答的三项分数和加权结果。 */
function scoreRow(key: string): RowPrim {
  const [triple] = JUDGE_V1[key];
  const score = rubricScore(RUBRIC, tripleScores(triple));
  return {
    kind: 'row',
    id: 's',
    w: 64,
    cells: [
      ...RUBRIC.criteria.map((c, i): DsCell => ({ v: String(triple[i]), sub: c.id, tone: 'teal', heat: (triple[i] - 1) / 4, key: `s${i}` })),
      { v: score.toFixed(2), sub: labelOfScore(score), tone: LABEL_TONE[labelOfScore(score)], key: 's3', lift: true },
    ],
  };
}

const SHOW_ORDER: GradeLabel[] = ['好', '可接受', '差'];
/** 评委 × 人工的 3 × 3 表：对角线是一致。 */
function agreeGrid(): GridPrim {
  const idx = (g: GradeLabel) => GRADES.indexOf(g);
  return {
    kind: 'grid',
    id: 'a',
    w: 46,
    rows: SHOW_ORDER.map((g) => `评${GRADE_SHORT[g]}`),
    cols: SHOW_ORDER.map((g) => `人${GRADE_SHORT[g]}`),
    cells: SHOW_ORDER.map((r) => SHOW_ORDER.map((c): DsCell => {
      const v = agreement.table[idx(r)][idx(c)];
      return { v: String(v), tone: v === 0 ? 'dim' : r === c ? 'green' : 'amber', heat: v / REPLY_KEYS.length };
    })),
  };
}

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const callWire = (title: string, call: ModelCall, notes: Record<string, string>) => [
  wire(title, 'mem', 'format',
    httpHead('请求头', call.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
    jsonBody('请求体', encodeJson(call.request), { notes: { model: `评委用 ${JUDGE_MODEL}：和被评的 ${MODEL} 不是同一个模型。`, ...notes } })),
  wire(`${title}：响应`, 'mem', 'format',
    httpHead('响应头', call.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(call.message), { expand: ['usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content', 'usage', 'usage.input_tokens', 'usage.output_tokens'], notes: { content: '评委写的 JSON（示例）：分数和理由不是真实生成的。', 'usage.output_tokens': '本站分词器的计数；文档建议评委开 thinking 先推理再打分，那部分 token 本站没有模拟。' } })),
] as const;
const [pointReq, pointRes] = callWire(`评委打分（${N.showKey}）`, shown, { messages: '一条 user 消息：评分标准放在 <rubric>，问题和回答各放一个标签，最后要求只输出 JSON。', max_tokens: '只要几十个 token 的 JSON。' });
const [pairReqO, pairResO] = callWire('成对比较（q10，原顺序）', pairShown.original, { messages: 'v1 放在 <answer_a>，v2 放在 <answer_b>。' });
const [pairReqS, pairResS] = callWire('成对比较（q10，交换后）', pairShown.swapped, { messages: '交换：v2 放在 <answer_a>，v1 放在 <answer_b>。' });

const rubricConcept = (key: string) => {
  const [triple, reason] = JUDGE_V1[key];
  const score = rubricScore(RUBRIC, tripleScores(triple));
  return concept('按评分标准换算（本站的写法）', [
    ...RUBRIC.criteria.map((c, i): [string, string, string] => [`${c.id} ×${c.weight}`, `${triple[i]} 分 → ${((triple[i] - 1) / 4).toFixed(2)}`, c.text]),
    ['加权', score.toFixed(3), `Σ 权重 × (分数 − 1) / 4，除以权重和 ${RUBRIC.criteria.reduce((a, c) => a + c.weight, 0)}。`],
    ['三档', labelOfScore(score), `≥ ${GOOD_AT} 好，≥ ${OK_AT} 可接受，其余差（本站的阈值）。`],
    ['理由', reason, '评委写的（示例）。'],
  ], 'teal');
};
const scoreJson = (key: string) => {
  const score = rubricScore(RUBRIC, tripleScores(JUDGE_V1[key][0]));
  return encodeJson({ reply: key, scores: tripleScores(JUDGE_V1[key][0]), weighted: +score.toFixed(3), label: labelOfScore(score) });
};
const restPoint = wire('其余回答', 'mem', '示意', concept(`其余 ${N.replies - 1} 条（三项分 → 加权 → 三档）`, REPLY_KEYS.filter((k) => k !== N.showKey).map((key): [string, string, string] => [key, `${JUDGE_V1[key][0].join(' / ')} → ${rubricScore(RUBRIC, tripleScores(JUDGE_V1[key][0])).toFixed(2)}`, labelOfScore(rubricScore(RUBRIC, tripleScores(JUDGE_V1[key][0])))])));
const restPair = wire('其余成对比较', 'mem', '示意', concept(`其余 ${PAIRWISE.length - 1} 对，各问两次`, PAIRWISE.filter((p) => p.id !== 'q10').map((p): [string, string, string] => [p.id, `${POS[p.original]} / ${POS[p.swapped]}`, decided[PAIRWISE.indexOf(p)] === '未定' ? '翻转：换回之后结论不同' : `一致：${decided[PAIRWISE.indexOf(p)]}`])));
const biasJson = encodeJson({ pairs: bias.n, consistent: bias.consistent, flipped: bias.flipped, flip_rate: +bias.flipRate.estimate.toFixed(3), wilson95: [+bias.flipRate.lo.toFixed(3), +bias.flipRate.hi.toFixed(3)], same_position: bias.samePosition, first_position: bias.firstPosition });
const humanJson = encodeJson({ source: 'adjudicated', labels: ADJUDICATED.map((l) => GRADE_SHORT[l]).join('') });
const agreeJson = encodeJson({ n: REPLY_KEYS.length, agree: agreement.agree, po: +agreement.po.toFixed(3), pe: +agreement.pe.toFixed(3), kappa: +agreement.kappa.toFixed(3), disagree: disagreements });

// ---------- 事件 ----------

const P = N.pointCostNano;
const T = N.totalNano;
const showLabel = judgeLabels[SHOW];
const quote = (text: string): string => `「${text.replace(/[。！？]$/, '')}」`;

export const judge: Lesson = {
  id: 'judge',
  name: 'LLM-AS-JUDGE',
  title: 'LLM 当评委：评分标准与位置偏差',
  group: 'eval',
  layer: [5, 5],
  layerNote: '评委是离线评估里的一个评分器，只是它自己也是一次模型调用，所以整课都在「评估」这一档。',
  costNote: `每次评委调用都是一次 Claude Sonnet 5.5 调用：逐条打分 ${N.replies} 次 ${N.pointCost}，成对比较 ${N.pairCalls} 次 ${N.pairCost}，合计 ${N.totalCost}；被评的回答是现成的，这一课不再调用客服模型。`,
  nodes: ['harness', 'judge', 'raters', 'scores', 'results', 'matrix'],
  place: { harness: [560, 290], judge: [920, 110], raters: [140, 110], scores: [890, 430], results: [240, 560], matrix: [850, 730] },
  labels: {
    harness: ['评估运行器', '把回答交给评委'],
    judge: ['评委', JUDGE_MODEL],
    raters: ['人工标注', '裁决后的标签'],
    scores: ['评分标准', '三项分数和加权'],
    results: ['评委的结论', '左：三档；右：成对比较'],
    matrix: ['评委 × 人工', '对角线是一致'],
  },
  labelAt: { scores: [0, 95], results: [0, 215], matrix: [0, 125] },
  radius: { scores: 70, results: 110, matrix: 70 },
  initial: { scores: [], results: [], matrix: [] },
  start: ['harness', 'judge'],
  legend: [['green', '好、一致'], ['teal', '可接受、分数'], ['amber', '差、翻转、不一致'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '请另一个模型按评分标准打分：怎样写标准，怎样知道它靠不靠谱',
    description: `正则查不了「有没有帮到用户」「语气好不好」，常见的办法是请另一个模型当评委。这一课让 ${JUDGE_MODEL} 给 ${N.questions} 个问题的两版回答（共 ${N.replies} 条，示例）按三项标准打分，再两两比较。交换两个回答的顺序，${N.flipped} / ${PAIRWISE.length} 对的结论变了；和人工裁决的标签比，只有 ${N.agree} / ${N.replies} 一致，人工判差的 ${N.humanBad.length} 条评委全给了「好」。评委的分数和理由是脚本，翻转比例、一致性和费用是真算的。`,
    facts: [
      ['评委', `${JUDGE_MODEL}（被评的是 ${MODEL}）`],
      ['评分标准', N.criteria],
      ['位置偏差', `${N.flipped} / ${PAIRWISE.length} 对翻转`],
      ['费用', `${N.totalCost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '评分标准：把「好」拆成几项',
      desc: `${N.showKey} 三项分加权得 ${N.showScore}，算「${showLabel}」`,
      detail: `评委的提示照 Anthropic 文档的建议写：评分标准要具体，要求给出明确的分数（每项 1–5 分）而不是一段评语，评分标准放在 <rubric>，回答放在 <answer>。本站的标准有三项：${N.criteria}，每项分数线性换到 0–1 再按权重平均，≥ ${GOOD_AT} 算好、≥ ${OK_AT} 算可接受，阈值是本站定的。评委用 ${JUDGE_MODEL}，不用被评的 ${MODEL} 自己：文档的示例代码注释说，最好用另一个模型来评；这一次输入 ${num(N.showInput)}、输出 ${N.showOutput} token，${N.showCost}。`,
      facts: [['问题', preview(itemOf(N.showKey).question, 16)], ['三项分', JUDGE_V1[N.showKey][0].join(' / ')], ['加权', `${N.showScore} → ${showLabel}`], ['一次', N.showCost]],
      events: [
        show('scores', 'results'),
        state('harness', { 回答: `${N.replies} 条`, 评委: '0 次' }),
        pk('harness', 'judge', 'blue', 'POST /v1/messages', [`${N.showKey} 打分`, `${num(N.showBytes)} 字节`], [0, 'HTTP', `${N.showKey}：评分标准 + 问题 + 回答`, N.showBytes], pointReq, { ds: { results: [resultsGrid(REPLY_KEYS.map(() => null), 0, [], [N.showKey])] } }),
        pk('judge', 'harness', 'teal', '三项分（示例）', [JUDGE_V1[N.showKey][0].join(' / ')], [shown.cost.total, 'JUDGE', `输入 ${num(N.showInput)}、输出 ${N.showOutput} token，${N.showCost}`, shown.http.response.bytes.length], pointRes),
        pk('harness', 'scores', 'teal', '按标准换算', [`${N.showScore} → ${showLabel}`], [shown.cost.total, 'STATS', `加权得 ${N.showScore}，≥ ${GOOD_AT}，算「${showLabel}」`, scoreJson(N.showKey).bytes.length], wire('换算', 'mem', 'internal', jsonBody('换算结果（本站的写法）', scoreJson(N.showKey), { notes: { scores: '评委给的三项分（示例）。', weighted: 'rubricScore 算的加权分，0–1。', label: '按本站的阈值分成三档。' } }), rubricConcept(N.showKey)), { ds: { scores: [scoreRow(N.showKey)] } }),
        note('scores', `${N.showScore} → ${showLabel}`, 'green'),
      ],
    },
    {
      title: `${N.replies} 条全评一遍`,
      desc: `好 ${N.good}、可接受 ${N.ok}、差 ${N.bad}，花 ${N.pointCost}`,
      detail: `其余 ${N.replies - 1} 条照同样的提示逐条请评委打分，一共 ${N.replies} 次调用、${N.pointCost}：评委也是一次模型调用，评估集越大、改得越勤，这笔钱越多。评委给出好 ${N.good} 条、可接受 ${N.ok} 条、差 ${N.bad} 条，一条差都没有。只看这张表看不出评委靠不靠谱，文档的说法是先测试它可不可靠，再大规模用。`,
      facts: [['好', `${N.good} 条`], ['可接受', `${N.ok} 条`], ['差', `${N.bad} 条`], ['逐条打分', `${N.replies} 次，${N.pointCost}`]],
      events: [
        pk('harness', 'judge', 'blue', `其余 ${N.replies - 1} 条`, ['同样的提示'], [shown.cost.total, 'HTTP', `其余 ${N.replies - 1} 条回答逐条请评委打分`, null], restPoint, { ds: { results: [resultsGrid(REPLY_KEYS.map((k) => (k === N.showKey ? showLabel : null)))] } }),
        pk('judge', 'harness', 'teal', `${N.replies - 1} 个分数`, [`合计 ${N.pointCost}`], [P, 'JUDGE', `${N.replies} 条都打完分，累计 ${N.pointCost}`, null], restPoint, { ds: { results: [resultsGrid(judgeLabels)], scores: [scoreRow(REPLY_KEYS[REPLY_KEYS.length - 1])] } }),
        state('harness', { 评委: `${N.replies} 次`, 费用: N.pointCost }),
        note('results', `差：${N.bad} 条`, 'amber'),
      ],
    },
    {
      title: '成对比较：交换顺序再问一次',
      desc: `q10 两次都选了 A 位：选的是位置，不是回答`,
      detail: `另一种用法是把两版回答放在一起让评委二选一，Anthropic 的评估检查清单专门提醒，成对比较时评委会偏向某个位置。所以同一对回答问两次：原顺序 v1 在 A 位，交换后 v2 在 A 位，再把结论换回回答本身。q10 两次都选 A：第一次选的是 v1，第二次选的是 v2，评委看的是位置而不是内容。`,
      facts: [['原顺序', 'A = v1，选 A'], ['交换后', 'A = v2，选 A'], ['结论', '翻转，这一对不算数'], ['每对', '问两次，花两次的钱']],
      events: [
        pk('harness', 'judge', 'blue', 'q10 原顺序', ['A = v1', 'B = v2'], [P, 'HTTP', 'q10：v1 放 A 位、v2 放 B 位', pairShown.original.http.request.bytes.length], pairReqO, { ds: { results: [resultsGrid(judgeLabels, 0, [], ['q10v1', 'q10v2'])] } }),
        pk('judge', 'harness', 'teal', '选 A（示例）', ['= v1'], [P + pairShown.original.cost.total, 'JUDGE', `原顺序选 A，也就是 v1，${formatUsd(pairShown.original.cost.total)}`, pairShown.original.http.response.bytes.length], pairResO, { ds: { results: [resultsGrid(judgeLabels, 0, [], [], 'q10')] } }),
        pk('harness', 'judge', 'blue', 'q10 交换后', ['A = v2', 'B = v1'], [P + pairShown.original.cost.total, 'HTTP', 'q10：交换，v2 放 A 位', pairShown.swapped.http.request.bytes.length], pairReqS),
        pk('judge', 'harness', 'amber', '又选 A（示例）', ['= v2'], [P + pairShown.original.cost.total + pairShown.swapped.cost.total, 'JUDGE', '交换后还是选 A，这次是 v2：结论翻转', pairShown.swapped.http.response.bytes.length], pairResS, { ds: { results: [resultsGrid(judgeLabels, 0, ['q10'])] } }),
        note('results', 'q10 两次都选 A', 'amber'),
      ],
    },
    {
      title: '位置偏差有多大',
      desc: `${N.flipped} / ${PAIRWISE.length} 对翻转，区间 ${range(N.flipRate)}`,
      detail: `${PAIRWISE.length} 对全部问完（${N.pairCalls} 次调用、${N.pairCost}），${N.flipped} 对交换后结论翻转，比例 ${pct(N.flipRate.estimate)}，Wilson 95% 区间 ${range(N.flipRate)}；其中 ${N.samePosition} 对两次都选同一个位置（${N.firstPosition} 对都选 A 位），翻转的大多是人工看来两版差不多的那几对。Anthropic 的评估检查清单（claude-api skill）建议每条用例随机安排 A、B，或者两种顺序都评；本站只把两次一致的算数：v1 胜 ${N.v1Wins} 对、v2 胜 ${N.v2Wins} 对，${N.undecided} 对未定。${PAIRWISE.length} 对样本太少，这个比例只说明偏差存在，说不准它有多大。`,
      facts: [['翻转', `${N.flipped} / ${PAIRWISE.length}（${pct(N.flipRate.estimate)}）`], ['两次同一位置', `${N.samePosition} 对，${N.firstPosition} 对是 A 位`], ['只算一致的', `v1 胜 ${N.v1Wins}、v2 胜 ${N.v2Wins}、未定 ${N.undecided}`], ['成对比较', `${N.pairCalls} 次，${N.pairCost}`]],
      events: [
        pk('harness', 'judge', 'blue', `其余 ${PAIRWISE.length - 1} 对`, ['各问两次'], [P + pairShown.original.cost.total + pairShown.swapped.cost.total, 'HTTP', `其余 ${PAIRWISE.length - 1} 对，原顺序、交换后各问一次`, null], restPair),
        pk('judge', 'harness', 'teal', `${(PAIRWISE.length - 1) * 2} 个结论`, [`累计 ${N.totalCost}`], [T, 'JUDGE', `${N.pairCalls} 次成对比较都问完，累计 ${N.totalCost}`, null], restPair, { ds: { results: [resultsGrid(judgeLabels, PAIRWISE.length)] } }),
        pk('harness', 'results', 'amber', '位置偏差', [`${N.flipped} / ${PAIRWISE.length} 翻转`], [T, 'STATS', `翻转 ${N.flipped} / ${PAIRWISE.length}，Wilson 95% ${range(N.flipRate)}`, biasJson.bytes.length], wire('位置偏差（本站的写法）', 'mem', 'internal', jsonBody('统计', biasJson, { notes: { flipped: `换回之后两次结论不同：${N.flips.join('、')}。`, same_position: '两次都选同一个位置：位置偏差最直接的证据。', wilson95: '翻转比例的 Wilson 95% 区间。' } })), { ds: { results: [resultsGrid(judgeLabels, PAIRWISE.length, N.flips)] } }),
        state('harness', { 评委: `${N.replies + N.pairCalls} 次`, 费用: N.totalCost }),
        note('results', `翻转 ${pct(N.flipRate.estimate)}`, 'amber'),
      ],
    },
    {
      title: '评委要和人对过才能用',
      desc: `一致 ${N.agree} / ${N.replies}，κ = ${N.kappa}：人判差的评委全给了好`,
      detail: `拿评委的三档和人工裁决后的标签（下一课讲这些标签怎么来）逐条比：${N.agree} / ${N.replies} 一致，Cohen's kappa ${N.kappa}，按常用的分档只是「${N.band}」。不一致的 ${N.disagreements.length} 条里，人工判差的 ${N.humanBad.join('、')} 评委全给了「好」：运费说成一律店铺出、编了一个电话、答应了超期的退款、跳过拍照就让寄回，都是说法不对，可评委手里没有店铺规则，只能看回答像不像那么回事；q10v1 一长串客套话也拿了「好」。检查清单建议先在几十条人工标过的用例上量一致率，清楚的用例上远低于约 90% 就该先改评委的提示，提醒评委篇幅长不加分，也别让评委知道哪条是基线。`,
      facts: [['一致', `${N.agree} / ${N.replies}`], ['κ', `${N.kappa}（${N.band}）`], ['人判差的', `${N.humanBad.length} 条，评委都判好`], ['原因', '评委没有店铺规则作参照']],
      events: [
        show('raters', 'matrix'),
        pk('raters', 'harness', 'blue', '人工标签', [`${N.replies} 条，裁决后`], [T, 'LABEL', `人工裁决后的 ${N.replies} 个标签（下一课讲怎么来的）`, humanJson.bytes.length], wire('人工标签（本站的写法）', 'mem', 'internal', jsonBody('标签', humanJson, { notes: { labels: `按 q1 v1、q1 v2、q2 v1……的顺序，好、可（可接受）、差各一个字。` } }))),
        pk('harness', 'matrix', 'teal', '评委 × 人工', [`一致 ${N.agree} / ${N.replies}`, `κ = ${N.kappa}`], [T, 'STATS', `一致 ${N.agree} / ${N.replies}，κ = ${N.kappa}（${N.band}）`, agreeJson.bytes.length], wire('一致性（本站的写法）', 'mem', 'internal', jsonBody('统计', agreeJson, { notes: { po: '观测一致率。', pe: '按评委和人工各自的标签分布，碰巧一致的概率。', kappa: 'κ = (po − pe) / (1 − pe)。', disagree: '评委和人工不一致的回答。' } }), concept('人判差、评委判好', N.humanBad.map((key): [string, string, string] => [key, quote(answerOf(key)), `评委的理由（示例）：${JUDGE_V1[key][1]}`]), 'amber')), { ds: { matrix: [agreeGrid()], results: [resultsGrid(judgeLabels, PAIRWISE.length, [], N.disagreements)] } }),
        note('matrix', `κ = ${N.kappa}，${N.band}`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '评委也是要被评估的评分器',
    desc: `${N.replies + N.pairCalls} 次评委调用，${N.totalCost}`,
    text: `LLM 评委能评正则评不了的东西，但它本身是一个会出错的评分器：要有具体的评分标准和明确的分数，要用和被评的不同的模型，成对比较要两种顺序都问（本站 ${N.flipped} / ${PAIRWISE.length} 对翻转），最后必须和人工标注对一遍（本站 κ 只有 ${N.kappa}）。这一课的毛病出在评分标准：没给评委店铺规则，它就分不清说得好听和说得对。评委的分数和理由是脚本，样本只有 ${N.replies} 条，区间很宽；评委调用本身也要花钱，这一课 ${N.totalCost}。下一课看人工标签怎么来：几个人标同一批，彼此又有多一致。`,
    facts: [['位置偏差', `${N.flipped} / ${PAIRWISE.length} 翻转`], ['和人工', `${N.agree} / ${N.replies}，κ = ${N.kappa}`], ['费用', N.totalCost], ['下一课', '人工评估与一致性']],
  },
};
