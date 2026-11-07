/**
 * 评估组第三课：人工评估与一致性。三名标注员（甲、乙、丙）独立给上一课的 24 条回答标好、可接受、差（本站自写的示例数据）。
 * core/stats.ts 真实计算：两两的 Cohen's kappa（po、pe、列联表）、有序标签的线性加权 kappa、百分位 bootstrap 区间、
 * Landis–Koch 分档（只是惯例）；分歧按多数裁决，三人各不相同的交给组长。
 * 最后用裁决后的标签校准评委：把店铺规则写进评分标准（v2）再请评委评一遍，每次调用经 callModel 计费，一致性用 judgeAgreement 重算。
 * tests/narrative.eval.test.ts 核对文案。
 */
import {
  bootstrap,
  callModel,
  cohenKappa,
  encodeJson,
  formatUsd,
  judgeAgreement,
  kappaBand,
  kappaOfTable,
  rubricScore,
  weightedKappa,
  type ModelCall,
} from '../core';
import { concept, httpHead, jsonBody, num, wire } from '../decode/structures';
import { note, pk, show } from './dsl';
import {
  adjudicate,
  ADJUDICATED,
  ADJUDICATOR,
  GRADE_SHORT,
  GRADES,
  JUDGE_MODEL,
  judgeReply,
  judgeRequest,
  judgeScores,
  labelOfScore,
  OPEN,
  RATER_NAMES,
  RATERS,
  REPLY_KEYS,
  RUBRIC,
  RUBRIC_V2_ADDED,
  tripleScores,
  type GradeLabel,
} from './evalset';
import { judgeLabels } from './judge';
import type { DsCell, GridPrim, Lesson, Tone } from './types';

// ---------- 真实计算 ----------

type Rater = (typeof RATER_NAMES)[number];
const PAIRS: Array<[Rater, Rater]> = [['甲', '乙'], ['甲', '丙'], ['乙', '丙']];
/**
 * bootstrap 的统计量：重抽的这批样本的 κ。和 cohenKappa(重抽的甲, 重抽的乙, GRADES).kappa 逐位相同，
 * 只是先把标签换成 GRADES 里的下标、直接数列联表（2000 次 × 3 对，省掉每次的查表和数组分配）。
 */
const resampledKappa = (a: Rater, b: Rater) => {
  const ca = RATERS[a].map((l) => GRADES.indexOf(l));
  const cb = RATERS[b].map((l) => GRADES.indexOf(l));
  return (idx: readonly number[]) => {
    const table = GRADES.map(() => GRADES.map(() => 0));
    for (const i of idx) table[ca[i]][cb[i]]++;
    return kappaOfTable(table, idx.length).kappa;
  };
};
export const kappas = PAIRS.map(([a, b]) => ({
  pair: `${a}${b}`,
  plain: cohenKappa(RATERS[a], RATERS[b], GRADES),
  weighted: weightedKappa(RATERS[a], RATERS[b], GRADES, 'linear'),
  ci: bootstrap(REPLY_KEYS.length, resampledKappa(a, b), { iterations: 2000, seed: 1 }),
}));
const AB = kappas[0];
export const how = REPLY_KEYS.map((_, i) => adjudicate(i).how);
const howCount = (h: string) => how.filter((x) => x === h).length;
/** 两人以上标「差」的回答，以及每个人标「差」的条数。 */
const badCount = (r: Rater) => RATERS[r].filter((l) => l === '差').length;
/** 只差一档 / 差两档的不一致（加权 kappa 的区别就在这里）。 */
const gap = (a: Rater, b: Rater, d: number) => REPLY_KEYS.filter((_, i) => Math.abs(GRADES.indexOf(RATERS[a][i]) - GRADES.indexOf(RATERS[b][i])) === d);

/** 评分标准 v2 下评委再评一遍（分数是示例），种子 870 + 序号。 */
const itemOf = (key: string) => OPEN.find((item) => item.id === key.replace(/v[12]$/, ''))!;
export const rejudge: ModelCall[] = REPLY_KEYS.map((key, i) => callModel(judgeRequest(itemOf(key).question, itemOf(key)[key.endsWith('v1') ? 'v1' : 'v2'], 'v2'), judgeReply(judgeScores('v2')[key]), 870 + i));
export const v2Labels: GradeLabel[] = REPLY_KEYS.map((key) => labelOfScore(rubricScore(RUBRIC, tripleScores(judgeScores('v2')[key][0]))));
export const before = judgeAgreement(judgeLabels, ADJUDICATED, GRADES);
export const after = judgeAgreement(v2Labels, ADJUDICATED, GRADES);
const rejudgeCost = rejudge.reduce((a, c) => a + c.cost.total, 0);
const firstV2 = rejudge[REPLY_KEYS.indexOf('q5v2')];
const v1Input = callModel(judgeRequest(itemOf('q5v2').question, itemOf('q5v2').v2, 'v1'), judgeReply(judgeScores('v1').q5v2), 0).message.usage.input_tokens;
const stillOff = REPLY_KEYS.filter((_, i) => v2Labels[i] !== ADJUDICATED[i]);
const k2 = (x: number) => x.toFixed(2);

export const numbers = {
  raters: RATER_NAMES.length,
  items: REPLY_KEYS.length,
  abPo: AB.plain.po,
  abPe: AB.plain.pe,
  abKappa: k2(AB.plain.kappa),
  abAgree: Math.round(AB.plain.po * REPLY_KEYS.length),
  kappas: kappas.map((k) => ({ pair: k.pair, plain: k2(k.plain.kappa), weighted: k2(k.weighted.kappa), band: kappaBand(k.plain.kappa), lo: k2(k.ci.lo), hi: k2(k.ci.hi) })),
  meanKappa: k2(kappas.reduce((a, k) => a + k.plain.kappa, 0) / kappas.length),
  bcOneStep: gap('乙', '丙', 1).length,
  bcTwoStep: gap('乙', '丙', 2),
  unanimous: howCount('unanimous'),
  majority: howCount('majority'),
  adjudicated: REPLY_KEYS.filter((_, i) => how[i] === 'adjudicator'),
  badBy: Object.fromEntries(RATER_NAMES.map((r) => [r, badCount(r)])) as Record<Rater, number>,
  iterations: AB.ci.iterations,
  seed: AB.ci.seed,
  beforeAgree: before.agree,
  beforeKappa: k2(before.kappa),
  afterAgree: after.agree,
  afterKappa: k2(after.kappa),
  afterBand: kappaBand(after.kappa),
  stillOff,
  rejudgeCost: formatUsd(rejudgeCost),
  rejudgeNano: rejudgeCost,
  v1Input,
  v2Input: firstV2.message.usage.input_tokens,
};
const N = numbers;

// ---------- 图元 ----------

const TONE: Record<GradeLabel, Tone> = { 好: 'green', 可接受: 'teal', 差: 'amber' };
/**
 * 24 条回答：行是 12 个问题，列是 v1、v2。upto 是已经交上来的标注员人数，格子里依次写他们的标签（一个字）；
 * final 为 true 时写裁决后的标签。三人一致 green，二比一 teal，三人各不相同 amber。
 */
function labelGrid(upto: number, final = false, lift: readonly string[] = []): GridPrim {
  return {
    kind: 'grid',
    id: 'h',
    w: 58,
    rows: OPEN.map((item) => item.id),
    cols: ['v1', 'v2'],
    cells: OPEN.map((item) => ['v1', 'v2'].map((v): DsCell => {
      const i = REPLY_KEYS.indexOf(`${item.id}${v}`);
      if (!upto) return { v: '', tone: 'empty' };
      const votes = RATER_NAMES.slice(0, upto).map((r) => GRADE_SHORT[RATERS[r][i]]).join('');
      const lifted = lift.includes(REPLY_KEYS[i]) || undefined;
      if (final) return { v: GRADE_SHORT[ADJUDICATED[i]], tone: TONE[ADJUDICATED[i]], lift: lifted };
      if (upto < RATER_NAMES.length) return { v: votes, tone: 'blue', lift: lifted };
      return { v: votes, tone: how[i] === 'unanimous' ? 'green' : how[i] === 'majority' ? 'teal' : 'amber', lift: lifted };
    })),
  };
}

const ORDER: GradeLabel[] = ['好', '可接受', '差'];
/** 两人的 3 × 3 列联表：行是第一个人，列是第二个人。 */
function pairTable(a: Rater, b: Rater): GridPrim {
  const t = cohenKappa(RATERS[a], RATERS[b], GRADES).table;
  const at = (g: GradeLabel) => GRADES.indexOf(g);
  return {
    kind: 'grid',
    id: 't',
    w: 46,
    rows: ORDER.map((g) => `${a}${GRADE_SHORT[g]}`),
    cols: ORDER.map((g) => `${b}${GRADE_SHORT[g]}`),
    cells: ORDER.map((r) => ORDER.map((c): DsCell => {
      const v = t[at(r)][at(c)];
      const d = Math.abs(at(r) - at(c));
      return { v: String(v), tone: v === 0 ? 'dim' : d === 0 ? 'green' : d === 1 ? 'teal' : 'amber', heat: v / REPLY_KEYS.length };
    })),
  };
}

/** 三对标注员的 κ：行是不加权、加权、区间下限、上限。 */
function kappaGrid(rows: number): GridPrim {
  const all: Array<[string, (k: (typeof kappas)[number]) => number]> = [['κ', (k) => k.plain.kappa], ['加权', (k) => k.weighted.kappa], ['下限', (k) => k.ci.lo], ['上限', (k) => k.ci.hi]];
  return {
    kind: 'grid',
    id: 'k',
    w: 50,
    rows: all.slice(0, rows).map(([name]) => name),
    cols: kappas.map((k) => k.pair),
    cells: all.slice(0, rows).map(([, f], r) => kappas.map((k): DsCell => ({ v: k2(f(k)), tone: r === 1 ? 'teal' : r >= 2 ? 'slate' : 'green', heat: Math.max(0, f(k)) }))),
  };
}

/** 评委 × 人工的 3 × 3 表。 */
function judgeTable(labels: readonly GradeLabel[]): GridPrim {
  const t = judgeAgreement(labels, ADJUDICATED, GRADES).table;
  const at = (g: GradeLabel) => GRADES.indexOf(g);
  return {
    kind: 'grid',
    id: 't',
    w: 46,
    rows: ORDER.map((g) => `评${GRADE_SHORT[g]}`),
    cols: ORDER.map((g) => `人${GRADE_SHORT[g]}`),
    cells: ORDER.map((r) => ORDER.map((c): DsCell => {
      const v = t[at(r)][at(c)];
      return { v: String(v), tone: v === 0 ? 'dim' : r === c ? 'green' : 'amber', heat: v / REPLY_KEYS.length };
    })),
  };
}

// ---------- 字节层 ----------

const labelsJson = (r: Rater) => encodeJson({ rater: r, scale: GRADES.join('<'), labels: RATERS[r].map((l) => GRADE_SHORT[l]).join('') });
const labelWire = (r: Rater) => wire(`标注员${r}的标签`, 'mem', 'internal', jsonBody('标注结果（本站的写法）', labelsJson(r), { notes: { rater: '三人互相看不到对方的标签。', scale: '三档，有顺序：差 < 可接受 < 好。', labels: `按 q1 v1、q1 v2、q2 v1……的顺序，一条一个字（可 = 可接受）；${r}标了 ${badCount(r)} 条差。` } }));
const kappaJson = (k: (typeof kappas)[number]) => encodeJson({ pair: k.pair, n: REPLY_KEYS.length, po: +k.plain.po.toFixed(3), pe: +k.plain.pe.toFixed(3), kappa: +k.plain.kappa.toFixed(3), weighted_linear: +k.weighted.kappa.toFixed(3) });
const abJson = kappaJson(AB);
const allJson = encodeJson(kappas.map((k) => ({ pair: k.pair, kappa: +k.plain.kappa.toFixed(3), weighted: +k.weighted.kappa.toFixed(3), band: kappaBand(k.plain.kappa) })));
const ciJson = encodeJson(kappas.map((k) => ({ pair: k.pair, kappa: +k.plain.kappa.toFixed(3), ci95: [+k.ci.lo.toFixed(3), +k.ci.hi.toFixed(3)] })));
const adjJson = encodeJson({ unanimous: N.unanimous, majority: N.majority, adjudicator: N.adjudicated, labels: ADJUDICATED.map((l) => GRADE_SHORT[l]).join('') });
const afterJson = encodeJson({ rubric: 'v2', n: REPLY_KEYS.length, agree: after.agree, kappa: +after.kappa.toFixed(3), before: { agree: before.agree, kappa: +before.kappa.toFixed(3) }, disagree: stillOff });

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const reqWire = wire('评委再评（q5 v2，评分标准 v2）', 'mem', 'format',
  httpHead('请求头', firstV2.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
  jsonBody('请求体', encodeJson(firstV2.request), { notes: { messages: `评分标准 v2：多了两条要求和 <rules> 里的店铺规则，输入从 ${num(N.v1Input)} 涨到 ${num(N.v2Input)} token。` } }));
const resWire = wire('评委再评：响应', 'mem', 'format',
  httpHead('响应头', firstV2.http.response, { example: ['request-id', 'date'] }),
  jsonBody('响应体', encodeJson(firstV2.message), { example: ['id', 'content', 'usage'], notes: { content: '评委写的 JSON（示例）：这次 accurate 给了 1 分。' } }));

// ---------- 事件 ----------

const R = N.rejudgeNano;
const labelPk = (r: Rater, upto: number) =>
  pk('raters', 'harness', 'blue', `${r}的标签`, [`${REPLY_KEYS.length} 条`, `差 ${badCount(r)} 条`], [0, 'LABEL', `标注员${r}独立标完 ${REPLY_KEYS.length} 条，差 ${badCount(r)} 条`, labelsJson(r).bytes.length], labelWire(r), { ds: { results: [labelGrid(upto)] } });

export const human: Lesson = {
  id: 'human',
  name: 'HUMAN EVAL',
  title: '人工评估与一致性',
  group: 'eval',
  layer: [5, 7],
  layerNote: '标注员是「用户」这一档的人：他们按人的标准判断回答好不好，算出的一致性和裁决后的标签又回到「评估」，用来校准评委。',
  costNote: `前五步是人工标注和统计，不调用模型，是 $0；最后用改过的评分标准请 Claude Sonnet 5.5 把 ${N.items} 条再评一遍，${N.rejudgeCost}。`,
  nodes: ['raters', 'harness', 'judge', 'results', 'matrix', 'scores'],
  place: { raters: [140, 120], harness: [610, 240], judge: [940, 90], results: [210, 620], matrix: [900, 450], scores: [880, 750] },
  labels: {
    raters: ['人工标注', `${N.raters} 名标注员`],
    harness: ['评估运行器', '收标签、算一致性'],
    judge: ['评委', JUDGE_MODEL],
    results: ['24 条回答的标签', '行：问题；列：v1、v2'],
    matrix: ['列联表', '对角线是一致'],
    scores: ['三对标注员的 κ', '列：哪两个人'],
  },
  labelAt: { results: [0, 215], matrix: [0, 120], scores: [0, 125] },
  radius: { results: 110, matrix: 70, scores: 70 },
  initial: { results: [], matrix: [], scores: [] },
  start: ['raters', 'harness'],
  legend: [['blue', '人工的标签'], ['green', '一致'], ['teal', '差一档、二比一'], ['amber', '差两档、三人各不相同'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '人工标签是评估的基准，可人和人之间也不完全一致',
    description: `评委要和人对过才能用，可人工标签本身靠得住吗？这一课让 ${N.raters} 名标注员独立给 ${N.items} 条回答标好、可接受、差（本站自写的示例数据），用 Cohen's kappa 量两两的一致性：最好的一对 ${N.kappas[1].plain}，最差的 ${N.kappas[2].plain}，${N.items} 条样本的 bootstrap 区间很宽，甲乙的从「${kappaBand(AB.ci.lo)}」跨到「${kappaBand(AB.ci.hi)}」。分歧按多数裁决，三人各不相同的 ${N.adjudicated.length} 条由组长定、写进标注指南。最后把店铺规则写进评委的评分标准再评一遍，评委和人工的一致从 ${N.beforeAgree} 条升到 ${N.afterAgree} 条。`,
    facts: [
      ['标注', `${N.raters} 人 × ${N.items} 条，三档`],
      ['κ', N.kappas.map((k) => `${k.pair} ${k.plain}`).join('，')],
      ['裁决', `一致 ${N.unanimous}、多数 ${N.majority}、组长 ${N.adjudicated.length}`],
      ['费用', `前五步 $0，再评一遍 ${N.rejudgeCost}`],
    ],
  },
  steps: [
    {
      title: '三个人独立标同一批',
      desc: `${N.raters} 人各标 ${N.items} 条，互相看不到`,
      detail: `上一课的 ${N.items} 条回答交给 ${N.raters} 名标注员，每人独立地给每条标好、可接受、差，标完之前互相看不到对方的标签。三档有顺序，标注指南写了每一档的意思（好：问题解决了、说法和店铺规则一致），可人的尺度还是不同：${RATER_NAMES.map((r) => `${r}标了 ${N.badBy[r]} 条差`).join('、')}。Anthropic 的文档说人工评分最灵活、质量最高，但慢而贵，能不用就不用；这一课的标签是本站自写的示例，人工这一步不调用模型，费用列是 $0。`,
      facts: [['标注员', `${N.raters} 人，互相看不到`], ['样本', `${N.items} 条回答`], ['标签', '好、可接受、差（有顺序）'], ['费用', '$0：不调用模型']],
      events: [
        show('results'),
        labelPk('甲', 1),
        labelPk('乙', 2),
        labelPk('丙', 3),
        note('results', `一致 ${N.unanimous} 条`, 'green'),
      ],
    },
    {
      title: '一致率不够，要扣掉碰巧一致',
      desc: `甲乙一致 ${N.abAgree} / ${N.items}，κ = ${N.abKappa}`,
      detail: `甲和乙有 ${N.abAgree} / ${N.items} 条标得一样，一致率 ${(N.abPo * 100).toFixed(1)}%，听起来不低；可两人都爱标「好」，按各自的标签分布随便标，碰巧一致的概率 pe 就有 ${N.abPe.toFixed(3)}。Cohen's kappa 把这部分扣掉：κ = (po − pe) / (1 − pe) = ${N.abKappa}。列联表的对角线是一致的，离对角线越远分歧越大。`,
      facts: [['po', `${N.abAgree} / ${N.items} = ${N.abPo.toFixed(3)}`], ['pe', N.abPe.toFixed(3)], ['κ', N.abKappa], ['公式', 'κ = (po − pe) / (1 − pe)']],
      events: [
        show('matrix'),
        pk('harness', 'matrix', 'teal', '甲 × 乙', [`po ${N.abPo.toFixed(3)}`, `κ ${N.abKappa}`], [0, 'STATS', `甲乙：po ${N.abPo.toFixed(3)}、pe ${N.abPe.toFixed(3)}、κ ${N.abKappa}`, abJson.bytes.length], wire('甲乙的一致性（本站的写法）', 'mem', 'internal', jsonBody('统计', abJson, { notes: { po: '观测一致率：两人标得一样的比例。', pe: '偶然一致率：Σ 甲标某一档的比例 × 乙标同一档的比例。', kappa: 'κ = (po − pe) / (1 − pe)；1 是完全一致，0 是和碰巧一样。', weighted_linear: '下一步讲。' } })), { ds: { matrix: [pairTable('甲', '乙')], results: [labelGrid(3, false, REPLY_KEYS.filter((_, i) => RATERS.甲[i] !== RATERS.乙[i]))] } }),
        note('matrix', `κ = ${N.abKappa}`),
      ],
    },
    {
      title: '三对都算，标签有序就加权',
      desc: `κ ${N.kappas.map((k) => k.plain).join('、')}；加权后 ${N.kappas.map((k) => k.weighted).join('、')}`,
      detail: `三对标注员的 κ 分别是 ${N.kappas.map((k) => `${k.pair} ${k.plain}`).join('、')}，按 Landis 和 Koch 的分档是${N.kappas.map((k) => `「${k.band}」`).join('')}，维基百科特意说明这个分档并非公认、也没有依据。三档有顺序，好和差的分歧比好和可接受的严重，线性加权 kappa 把差两档的不一致按两倍算：乙丙的 ${N.bcOneStep + N.bcTwoStep.length} 条分歧里只有 ${N.bcTwoStep.join('、')} 差了两档，加权后从 ${N.kappas[2].plain} 升到 ${N.kappas[2].weighted}。三个人标全部样本时，Fleiss' kappa 要求每条的标注员随机抽取，不适合这种设计，本站就报三对的 κ（平均 ${N.meanKappa}）。`,
      facts: N.kappas.map((k): [string, string] => [k.pair, `κ ${k.plain}（${k.band}），加权 ${k.weighted}`]).concat([['加权', '线性：差两档按两倍算']]),
      events: [
        show('scores'),
        pk('harness', 'scores', 'teal', '三对 κ', N.kappas.map((k) => `${k.pair} ${k.plain}`), [0, 'STATS', `三对 κ：${N.kappas.map((k) => `${k.pair} ${k.plain}`).join('、')}`, allJson.bytes.length], wire('三对标注员（本站的写法）', 'mem', 'internal', jsonBody('统计', allJson), concept('分档（Landis–Koch 1977，只是惯例）', [['< 0', '没有一致'], ['0–0.20', '轻微'], ['0.21–0.40', '一般'], ['0.41–0.60', '中等'], ['0.61–0.80', '相当'], ['0.81–1', '几乎完全']])), { ds: { scores: [kappaGrid(1)] } }),
        pk('harness', 'matrix', 'teal', '乙 × 丙', [`κ ${N.kappas[2].plain}`, `加权 ${N.kappas[2].weighted}`], [0, 'STATS', `乙丙：不加权 ${N.kappas[2].plain}，线性加权 ${N.kappas[2].weighted}`, kappaJson(kappas[2]).bytes.length], wire('乙丙的一致性（本站的写法）', 'mem', 'internal', jsonBody('统计', kappaJson(kappas[2]), { notes: { weighted_linear: `κw = 1 − Σ wᵢⱼ Oᵢⱼ / Σ wᵢⱼ Eᵢⱼ，wᵢⱼ = |i − j|：差一档权重 1，差两档权重 2。` } })), { ds: { matrix: [pairTable('乙', '丙')], scores: [kappaGrid(2)], results: [labelGrid(3, false, N.bcTwoStep)] } }),
        note('matrix', `差两档：${N.bcTwoStep.join('、')}`, 'amber'),
      ],
    },
    {
      title: '24 条算出来的 κ，区间很宽',
      desc: `甲乙 ${N.kappas[0].plain}，95% 区间 ${N.kappas[0].lo}–${N.kappas[0].hi}`,
      detail: `κ 也是从样本估出来的，${N.items} 条太少：对 ${N.items} 条回答有放回地重抽 ${num(N.iterations)} 次、每次重算 κ（固定种子 ${N.seed}），取 2.5% 和 97.5% 分位数，甲乙的 95% 区间是 ${N.kappas[0].lo}–${N.kappas[0].hi}。这个区间从「${kappaBand(AB.ci.lo)}」跨到「${kappaBand(AB.ci.hi)}」，分档在区间面前没什么意义，三对的区间也大段重叠，说不出哪两个人更一致。要把一致性量准，得标更多样本，或者先改标注指南、再标一批。`,
      facts: N.kappas.map((k): [string, string] => [k.pair, `${k.plain}（${k.lo}–${k.hi}）`]).concat([['bootstrap', `${num(N.iterations)} 次，种子 ${N.seed}`]]),
      events: [
        pk('harness', 'scores', 'teal', 'bootstrap', [`${num(N.iterations)} 次重抽`], [0, 'STATS', `重抽 ${num(N.iterations)} 次：甲乙 ${N.kappas[0].lo}–${N.kappas[0].hi}`, ciJson.bytes.length], wire('κ 的区间（本站的写法）', 'mem', 'internal', jsonBody('统计', ciJson, { summary: `百分位 bootstrap：重抽 ${num(N.iterations)} 次，种子 ${N.seed}` })), { ds: { scores: [kappaGrid(4)] } }),
        note('scores', `甲乙：${N.kappas[0].lo}–${N.kappas[0].hi}`, 'amber'),
      ],
    },
    {
      title: '分歧怎么裁决',
      desc: `一致 ${N.unanimous}、二比一 ${N.majority}、三人各不相同 ${N.adjudicated.length}`,
      detail: `${N.items} 条里三人一致的 ${N.unanimous} 条直接采用，二比一的 ${N.majority} 条取多数，三人各不相同的 ${N.adjudicated.join('、')} 交给组长按标注指南裁决。组长的理由要写回指南：${N.adjudicated.map((k) => `「${ADJUDICATOR[k].rule}」`).join('，')}，下一批再遇到同类回答，三个人就有共同的尺子。多数票也不一定对，如果某个标注员总是偏严或偏松（丙标了 ${N.badBy.丙} 条差，乙只有 ${N.badBy.乙} 条），该做的是对齐尺度，而不是一直靠投票。`,
      facts: [['三人一致', `${N.unanimous} 条`], ['二比一', `${N.majority} 条，取多数`], ['组长裁决', N.adjudicated.join('、')], ['结果', '裁决后的标签（上一课用的就是它）']],
      events: [
        pk('harness', 'results', 'blue', '裁决', [`组长 ${N.adjudicated.length} 条`], [0, 'LABEL', `取多数；${N.adjudicated.join('、')} 三人各不相同，由组长裁决`, adjJson.bytes.length], wire('裁决（本站的写法）', 'mem', 'internal', jsonBody('裁决结果', adjJson, { notes: { adjudicator: '三人各不相同，组长按标注指南定。', labels: '裁决后的 24 个标签：上一课拿评委和它比。' } }), concept('写回标注指南', N.adjudicated.map((k): [string, string, string] => [k, ADJUDICATOR[k].label, ADJUDICATOR[k].rule]))), { ds: { results: [labelGrid(3, true, N.adjudicated)] } }),
        note('results', `组长裁决 ${N.adjudicated.join('、')}`),
      ],
    },
    {
      title: '用人工标签校准评委',
      desc: `评分标准加上店铺规则，一致 ${N.beforeAgree} → ${N.afterAgree}`,
      detail: `上一课评委和人工不一致，多半是因为它没有店铺规则作参照，于是评分标准 v2 加了两条：${RUBRIC_V2_ADDED.map((t) => `「${t.replace(/[。]$/, '')}」`).join('、')}，并把店铺规则附在后面。再评一遍 ${N.items} 条（${N.rejudgeCost}，每次输入从 ${num(N.v1Input)} 涨到约 ${num(N.v2Input)} token），和人工一致的从 ${N.beforeAgree} 条升到 ${N.afterAgree} 条，κ 从 ${N.beforeKappa} 升到 ${N.afterKappa}；剩下的 ${N.stillOff.join('、')} 正是人工三人各不相同、由组长裁决的那一条。改评分标准时看过的就是这 ${N.items} 条，所以 ${N.afterAgree} / ${N.items} 偏乐观，要在一批没看过的新样本上再验一次。`,
      facts: [['评分标准 v2', '加店铺规则、篇幅不加分'], ['一致', `${N.beforeAgree} → ${N.afterAgree} / ${N.items}`], ['κ', `${N.beforeKappa} → ${N.afterKappa}`], ['再评一遍', N.rejudgeCost]],
      events: [
        show('judge'),
        pk('harness', 'judge', 'blue', '评分标准 v2', ['q5 v2', `${num(N.v2Input)} token`], [0, 'HTTP', `评分标准 v2 再评：q5 v2（答应了超期退款）`, firstV2.http.request.bytes.length], reqWire),
        pk('judge', 'harness', 'teal', '再评（示例）', [judgeScores('v2').q5v2[0].join(' / ')], [firstV2.cost.total, 'JUDGE', `q5 v2：accurate 1 分，这次判「${v2Labels[REPLY_KEYS.indexOf('q5v2')]}」，${formatUsd(firstV2.cost.total)}`, firstV2.http.response.bytes.length], resWire),
        pk('judge', 'harness', 'teal', `其余 ${N.items - 1} 条`, [`累计 ${N.rejudgeCost}`], [R, 'JUDGE', `${N.items} 条都按 v2 评完，累计 ${N.rejudgeCost}`, null], wire('其余回答', 'mem', '示意', concept(`评分标准 v2 下分数变了的回答`, REPLY_KEYS.filter((_, i) => v2Labels[i] !== judgeLabels[i]).map((key): [string, string, string] => [key, `${judgeLabels[REPLY_KEYS.indexOf(key)]} → ${v2Labels[REPLY_KEYS.indexOf(key)]}`, `理由（示例）：${judgeScores('v2')[key][1]}`])))),
        pk('harness', 'matrix', 'green', '评委 × 人工', [`一致 ${N.afterAgree} / ${N.items}`, `κ ${N.afterKappa}`], [R, 'STATS', `一致 ${N.beforeAgree} → ${N.afterAgree} / ${N.items}，κ ${N.beforeKappa} → ${N.afterKappa}`, afterJson.bytes.length], wire('校准后的一致性（本站的写法）', 'mem', 'internal', jsonBody('统计', afterJson, { notes: { before: '评分标准 v1（上一课）。', disagree: '剩下的分歧：人工自己也三人各不相同。' } })), { ds: { matrix: [judgeTable(v2Labels)], results: [labelGrid(3, true, N.stillOff)] } }),
        note('matrix', `κ ${N.beforeKappa} → ${N.afterKappa}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '人工标签是尺子，尺子也要校',
    desc: `三对 κ ${N.kappas.map((k) => k.plain).join('、')}；评委校准后 ${N.afterAgree} / ${N.items}`,
    text: `人工评估质量最高，但人和人也不完全一致：先用 kappa 扣掉碰巧一致，有序的标签用加权 kappa，再用 bootstrap 看看区间有多宽（本站 ${N.items} 条，区间跨过好几个分档）。分歧按多数裁决，三人各不相同的交给组长并写回标注指南。裁决后的标签是校准评委的尺子：把店铺规则写进评分标准，评委和人工的一致从 ${N.beforeAgree} 条升到 ${N.afterAgree} 条，但这是在同一批样本上调出来的，要换一批新样本复核。下一课回到确定性的评估集：改了客服的提示之后，怎样判断它到底变好了没有。`,
    facts: [['κ（三对）', N.kappas.map((k) => k.plain).join('、')], ['裁决', `组长 ${N.adjudicated.length} 条`], ['评委校准', `κ ${N.beforeKappa} → ${N.afterKappa}`], ['下一课', '回归测试：改提示前后']],
  },
};
