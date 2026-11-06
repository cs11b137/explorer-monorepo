/**
 * 流水线组第五课：RAG 评估。拿知识库的 8 个标注问题（kb.ts 的 EVAL_SET）跑一遍最简单的配置（不过滤、暴力搜索取前 3），
 * 先算检索指标（召回@3、MRR、context precision、context recall），再让模型回答（示例）、算生成指标
 * （faithfulness、答案覆盖的关键事实、answer relevancy），最后把本站的近似和 RAGAS 的真实定义对照。
 *
 * 检索、指标、引用核对全部由 core/ 实时计算。回答、answer relevancy 里由回答反推的问题是模型写的，写死并标 E.G.。
 * RAGAS 用大模型拆陈述、判断支持关系，本站换成标注和字面判据（core/eval.ts、rag.ts 的 supports），课里说明差别。
 * tests/narrative.pipeline-b.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  answerFacts,
  buildPrompt,
  contextPrecision,
  contextRecall,
  DistanceMeter,
  dot,
  embedVector,
  EVAL_SET,
  factsOf,
  faithfulness,
  flatSearch,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  reciprocalRank,
  retrievalRecall,
  type EvalItem,
} from '../core';
import { concept, num, promptParts, utf8Lines, wire } from '../decode/structures';
import type { LayerWriter } from '../decode/writer';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

export const K = 3;

/** 回答（模型写的，示例 E.G.）。来源编号对应各自检索到的前 3 个。有几条故意写坏，分别让某个指标露出问题。 */
export const ANSWERS: Record<string, string> = {
  leak: '杯盖漏水多半是密封圈没装好或者老化开裂，先取下密封圈重新装好再试 [1]。密封圈可以单独购买，配件编号 SR-35，售价 9 元 [2]。',
  // 照着已作废的 2025 版回答：对上下文忠实，但答错了。
  'refund-time': '退款原路退回，支付宝 3–5 个工作日到账，银行卡 7–15 个工作日 [2]。退款审核一般在 24 小时内完成 [3]。',
  'return-fee': '非质量问题退货，寄回的运费由买家承担 [1]。签收后 7 天内可以无理由退货，商品和配件要完好 [2]。',
  invoice: '下单时填写发票抬头和税号，就可以开电子普通发票 [1]。企业要开增值税专用发票，请联系客服 [2]。',
  // 答非所问：问能不能改地址，答的是运费。
  address: '订单满 99 元包邮，不满 99 元收 8 元运费，新疆、西藏另加 10 元 [3]。',
  seal: '密封圈可以单独购买，配件编号 SR-35，售价 9 元 [2]。',
  // 「两年」用汉字写数，字面判据抓不到。
  warranty: '电热水壶自签收起保修两年，保修期内的质量问题免费维修或换新 [1]。',
  // 第二句是编的。
  points: '可以，结算时 100 积分可以抵扣 1 元 [2]。每个订单最多抵扣 50 元 [2]。',
};

/** answer relevancy：RAGAS 让模型根据回答反推 3 个问题（strictness 默认 3）。这里的问题是示例（E.G.）。 */
export const REVERSE: Record<string, string[]> = {
  leak: ['杯盖漏水怎么处理？', '密封圈在哪买？', '密封圈多少钱？'],
  'refund-time': ['退款多久到账？', '退款到银行卡要几天？', '退款审核要多久？'],
  'return-fee': ['退货运费谁出？', '非质量问题退货谁付运费？', '几天内可以无理由退货？'],
  invoice: ['怎么开发票？', '企业怎么开专用发票？', '开发票要填什么？'],
  address: ['运费多少？', '不满 99 元收多少运费？', '新疆、西藏运费多少？'],
  seal: ['密封圈在哪买？', '密封圈多少钱？', '密封圈的配件编号是什么？'],
  warranty: ['热水壶保修多久？', '电热水壶保修几年？', '保修期内坏了怎么办？'],
  points: ['积分能抵钱吗？', '多少积分抵 1 元？', '积分最多抵多少？'],
};

/** 格子里放得下的短名字。 */
export const SHORT: Record<string, string> = { leak: '漏水', 'refund-time': '到账', 'return-fee': '退货', invoice: '发票', address: '改地址', seal: '密封圈', warranty: '保修', points: '积分' };
const PSHORT: Record<string, string> = { aftersale: '售后', refund: '退款', 'refund-2025': '旧退款', 'shipping-fee': '运费', delivery: '配送', cup: '杯', kettle: '水壶', warranty: '保修', invoice: '发票', points: '积分', coupon: '券', contact: '客服' };
const pshort = (id: string): string => {
  const [doc, n] = id.split('#');
  return `${PSHORT[doc]}#${n}`;
};

// ---------- 检索 ----------

export const meter = new DistanceMeter();

export interface Row {
  item: EvalItem;
  retrieved: string[];
  contexts: string[];
  recall: ReturnType<typeof retrievalRecall>;
  rr: ReturnType<typeof reciprocalRank>;
  cp: ReturnType<typeof contextPrecision>;
  cr: ReturnType<typeof contextRecall>;
}

export const rows: Row[] = EVAL_SET.map((item) => {
  const hits = flatSearch(PARAGRAPH_VECTORS, embedVector(item.question), K, 'ip', meter).hits;
  const retrieved = hits.map((hit) => PARAGRAPHS[hit.id].id);
  const contexts = hits.map((hit) => PARAGRAPHS[hit.id].text);
  return { item, retrieved, contexts, recall: retrievalRecall(retrieved, item.relevant), rr: reciprocalRank(retrieved, item.relevant), cp: contextPrecision(retrieved, item.relevant), cr: contextRecall(item.facts, contexts) };
});
export const dist1 = meter.total;

// ---------- 生成 ----------

export const gen = rows.map((row) => {
  const prompt = buildPrompt(row.item.question, row.retrieved.map((id) => PARAGRAPHS.find((p) => p.id === id)!));
  const answer = ANSWERS[row.item.id];
  return { prompt, answer, faith: faithfulness(answer, row.contexts), facts: answerFacts(answer, row.item.facts) };
});

/** answer relevancy 的近似：原问题和 3 个反推问题的嵌入余弦的平均（每个余弦记 1 次距离）。 */
export const relevancy = rows.map((row) => {
  const q = embedVector(row.item.question);
  const cosines = REVERSE[row.item.id].map((text) => {
    meter.add('query');
    return dot(q, embedVector(text));
  });
  return { cosines, score: cosines.reduce((sum, x) => sum + x, 0) / cosines.length };
});
export const dist4 = meter.total;

// ---------- 汇总 ----------

const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
export const avg = {
  recall: mean(rows.map((r) => r.recall.score)),
  mrr: mean(rows.map((r) => r.rr.score)),
  cp: mean(rows.map((r) => r.cp.score)),
  cr: mean(rows.map((r) => r.cr.score)),
  faith: mean(gen.map((g) => g.faith.score)),
  facts: mean(gen.map((g) => g.facts.score)),
  relevancy: mean(relevancy.map((r) => r.score)),
};

const idx = (id: string) => rows.findIndex((r) => r.item.id === id);
export const I = { leak: idx('leak'), refund: idx('refund-time'), address: idx('address'), seal: idx('seal'), warranty: idx('warranty'), points: idx('points') };

export const numbers = {
  questions: rows.length,
  relevant: rows.reduce((sum, r) => sum + r.item.relevant.length, 0),
  found: rows.reduce((sum, r) => sum + r.recall.found.length, 0),
  facts: rows.reduce((sum, r) => sum + r.item.facts.length, 0),
  paragraphs: PARAGRAPHS.length,
  promptTokens: gen.reduce((sum, g) => sum + g.prompt.tokens, 0),
  answerSentences: gen.reduce((sum, g) => sum + g.faith.statements.length, 0),
  supported: gen.reduce((sum, g) => sum + g.faith.statements.filter((s) => s.support.supported).length, 0),
  reverse: Object.values(REVERSE).reduce((sum, list) => sum + list.length, 0),
};
const N = numbers;

const f2 = (x: number): string => fixed(x, 2);
const bare = (q: string): string => q.replace(/？$/, '');
const warrantyStatement = gen[I.warranty].faith.statements[0];
const pointsBad = gen[I.points].faith.statements[1];
const relLow = relevancy[I.address];
const relOthers = relevancy.filter((_, i) => i !== I.address).map((r) => r.score);

// ---------- 图元 ----------

const METRICS = ['召回', 'RR', 'CP', 'CR', '忠实', '事实', '相关'] as const;
type MetricName = (typeof METRICS)[number];

const valueOf = (i: number, metric: MetricName): number => {
  switch (metric) {
    case '召回': return rows[i].recall.score;
    case 'RR': return rows[i].rr.score;
    case 'CP': return rows[i].cp.score;
    case 'CR': return rows[i].cr.score;
    case '忠实': return gen[i].faith.score;
    case '事实': return gen[i].facts.score;
    case '相关': return relevancy[i].score;
  }
};

/** 指标表：每行一个问题，列逐步填上；不满分的格子标 amber。 */
function scoreGrid(upto: number, lift: Array<[number, MetricName]> = []): GridPrim {
  return {
    kind: 'grid',
    id: 's',
    w: 46,
    rows: rows.map((r) => SHORT[r.item.id]),
    cols: [...METRICS],
    cells: rows.map((_, i) => METRICS.map((metric, c): DsCell => {
      if (c >= upto) return { v: '', tone: 'empty' };
      const value = valueOf(i, metric);
      const low = metric === '相关' ? value < 0.5 : value < 1;
      return { v: f2(value), tone: low ? 'amber' : 'green', heat: Math.max(0, value), lift: lift.some(([r, m]) => r === i && m === metric) || undefined };
    })),
  };
}

/** 一个问题检索到的前 3 个：标注相关的 teal，不相关的变暗，已作废的 amber。 */
function resultRow(i: number, marks?: RowPrim['marks']): RowPrim {
  const r = rows[i];
  return {
    kind: 'row',
    id: 'r',
    w: 76,
    cells: r.retrieved.map((id): DsCell => ({ v: pshort(id), sub: r.item.relevant.includes(id) ? '相关' : '不相关', tone: id === 'refund-2025#0' ? 'amber' : r.item.relevant.includes(id) ? PART_TONE.doc : 'dim', key: `${r.item.id}${id}` })),
    marks,
  };
}

/** 评估集：每个问题标了几个相关段落、几个关键事实。 */
function truthRow(lift: number[] = []): RowPrim {
  return {
    kind: 'row',
    id: 't',
    w: 48,
    cells: rows.map((r, i): DsCell => ({ v: SHORT[r.item.id], sub: `${r.item.relevant.length} 段`, tone: PART_TONE.query, key: r.item.id, lift: lift.includes(i) || undefined })),
  };
}

/** 一个回答的每一句：被支持 green，不被支持 amber。 */
function answerRow(i: number, marks?: RowPrim['marks']): RowPrim {
  return {
    kind: 'row',
    id: 'a',
    w: 96,
    cells: gen[i].faith.statements.map((s, k): DsCell => ({ v: `${s.text.slice(0, 7)}…`, sub: s.support.supported ? '支持' : `缺 ${s.support.missing.join('、')}`, tone: s.support.supported ? 'green' : 'amber', key: `${rows[i].item.id}${k}` })),
    marks,
  };
}

function reverseRow(i: number, marks?: RowPrim['marks']): RowPrim {
  return {
    kind: 'row',
    id: 'a',
    w: 96,
    cells: REVERSE[rows[i].item.id].map((text, k): DsCell => ({ v: text.replace(/？$/, '').slice(0, 7), sub: `余弦 ${f2(relevancy[i].cosines[k])}`, tone: relevancy[i].cosines[k] < 0.5 ? 'amber' : 'green', key: `rev${i}-${k}` })),
    marks,
  };
}

// ---------- 字节 ----------

function exampleLines(name: string, text: string, summary: string): LayerWriter {
  const layer = utf8Lines(name, text, { color: 'green', summary });
  layer.fields.forEach((field) => (field.example = true));
  return layer;
}

const metricConcept = (title: string, metric: MetricName, explain: (i: number) => string) =>
  concept(title, rows.map((r, i): [string, string, string] => [`${SHORT[r.item.id]} · ${r.item.id}`, num(valueOf(i, metric), 3), explain(i)]), 'green');

// ---------- 课程 ----------

const refundRow = rows[I.refund];
const sealRow = rows[I.seal];
const leakRow = rows[I.leak];

export const evaluate: Lesson = {
  id: 'evaluate',
  name: 'EVALUATION',
  title: 'RAG 评估',
  group: 'pipeline',
  layer: [5, 7],
  layerNote: '检索指标看「检索」这一档的输出，生成指标看「回答」：拿检索结果、提示和回答一起打分。',
  distNote: `${N.questions} 个问题各暴力搜索 ${N.paragraphs} 个段落（${dist1} 次），answer relevancy 再比较 ${N.reverse} 对问题向量，一共 ${meter.total} 次。`,
  nodes: ['truth', 'index', 'results', 'llm', 'answer', 'evaluator', 'scores'],
  place: { truth: [230, 150], index: [600, 100], results: [600, 360], llm: [1050, 110], answer: [1050, 430], evaluator: [1070, 720], scores: [500, 680] },
  labels: {
    truth: ['标注', `${N.questions} 个问题`],
    index: ['向量库', '暴力搜索，取前 3'],
    results: ['检索结果', '当前这题的前 3'],
    llm: ['大模型', '回答（示例）'],
    answer: ['回答', '当前这题（示例）'],
    evaluator: ['评估器', '本站的近似'],
    scores: ['指标', '每行一个问题'],
  },
  labelAt: { truth: [0, 110], results: [-170, 50], answer: [30, 110], scores: [-330, -150] },
  radius: { truth: 70, results: 70, answer: 70, scores: 120 },
  initial: { truth: [truthRow()], results: [], answer: [], scores: [] },
  start: ['truth', 'index'],
  legend: [['teal', '标注相关的段落'], ['green', '满分和被支持'], ['amber', '露出问题的地方'], [null, '距离列：累计比较过几次向量']],
  overview: {
    full: '给检索和回答分别打分',
    description: `改了切分、换了嵌入模型、加了改写，到底变好了没有，要靠一组标注好的问题来量。这一课拿知识库的 ${N.questions} 个评估问题（共标注 ${N.relevant} 个相关段落、${N.facts} 个关键事实）跑一遍最简单的配置，算检索指标和生成指标，看每个指标各自能抓到哪一类问题，再把本站的近似算法和 RAGAS 用大模型打分的真实定义对照。`,
    facts: [
      ['评估集', `${N.questions} 个问题，${N.relevant} 个相关段落`],
      ['召回@3', `${N.found} / ${N.relevant}`],
      ['MRR', f2(avg.mrr)],
      ['faithfulness', f2(avg.faith)],
      ['RAGAS', 'Es 等，EACL 2024 系统演示'],
    ],
  },
  steps: [
    {
      title: '跑一遍检索',
      desc: `${N.questions} 个问题，找到 ${N.found} / ${N.relevant} 个相关段落`,
      detail: `评估集的每个问题都标好了哪些段落能回答它，以及参考答案里必须有的关键事实。被评估的是最简单的配置：不过滤，暴力搜索取前 ${K} 个，${N.questions} 个问题共比较 ${dist1} 次。召回@3 是标注的相关段落有几成出现在前 3 里，平均 ${f2(avg.recall)}；MRR 是第一个相关段落名次的倒数的平均，${f2(avg.mrr)}，「${SHORT.seal}」「${SHORT.points}」两题的相关段落都排在第 2。唯一漏掉的是「${bare(leakRow.item.question)}」要用的 ${leakRow.recall.missed[0]}（换货规则）。`,
      facts: [['召回@3', `平均 ${f2(avg.recall)}（${N.found} / ${N.relevant}）`], ['MRR', f2(avg.mrr)], ['漏掉', leakRow.recall.missed.join('、')], ['比较', `${dist1} 次`]],
      events: [
        pk('truth', 'index', 'blue', `${N.questions} 个问题`, rows.slice(0, 3).map((r) => r.item.question), [0, 'CALL', `评估集的 ${N.questions} 个问题依次送去检索，每个取前 ${K}`, utf8Encode(rows.map((r) => r.item.question).join('\n')).length],
          wire('评估问题', 'mem', 'format', utf8Lines('问题', rows.map((r) => r.item.question).join('\n'), { summary: `${N.questions} 个问题，每行一个` }))),
        show('results'),
        pk('index', 'results', 'amber', `${N.questions} × 前 ${K}`, rows.slice(0, 3).map((r) => `${SHORT[r.item.id]}：${r.retrieved.map(pshort).join(' ')}`), [dist1, 'SEARCH', `${N.questions} 次暴力搜索，每次 ${N.paragraphs} 个段落；标注的 ${N.relevant} 个相关段落找到 ${N.found} 个`, null],
          wire('每个问题的前 3 个', 'mem', '示意', concept('检索结果', rows.map((r): [string, string, string] => [`${SHORT[r.item.id]}`, r.retrieved.join('、'), `标注相关：${r.item.relevant.join('、')}。召回 ${num(r.recall.score, 2)}，第一个相关段落排第 ${r.rr.rank ?? '—'}。`]), 'amber')),
          { ds: { results: [resultRow(I.leak, [{ at: 2, text: `没找到 ${leakRow.recall.missed[0]}`, color: 'amber' }])], truth: [truthRow([I.leak])] } }),
        show('evaluator', 'scores'),
        pk('results', 'evaluator', 'amber', '对照标注', ['召回@3', 'MRR'], [dist1, 'EVAL', `召回@3 平均 ${num(avg.recall, 4)}，MRR ${num(avg.mrr, 4)}`, null],
          wire('召回和倒数名次', 'mem', '示意', metricConcept('召回@3', '召回', (i) => `找到 ${rows[i].recall.found.length} / ${rows[i].item.relevant.length}。`), metricConcept('倒数名次', 'RR', (i) => (rows[i].rr.rank ? `第一个相关段落排第 ${rows[i].rr.rank}。` : '前 3 里没有相关段落。')))),
        pk('evaluator', 'scores', 'green', '两列指标', [`召回 ${f2(avg.recall)}`, `MRR ${f2(avg.mrr)}`], [dist1, 'EVAL', '每个问题的召回@3 和倒数名次写进指标表', null],
          wire('指标表', 'mem', '示意', concept('平均', [['召回@3', num(avg.recall, 4), `${N.found} / ${N.relevant} 个相关段落。`], ['MRR', num(avg.mrr, 4), '倒数名次的平均。']], 'green')),
          { ds: { scores: [scoreGrid(2, [[I.leak, '召回']])] } }),
      ],
    },
    {
      title: '排得准不准，找得全不全',
      desc: `context precision ${f2(avg.cp)}，context recall ${f2(avg.cr)}`,
      detail: `context precision 看相关段落是不是排在前面：按 RAGAS 文档的公式，对每个相关段落所在的名次 k 取前 k 个的准确率再平均，本站用标注判断相关，RAGAS 让大模型判断。「${SHORT['refund-time']}」只有 ${f2(refundRow.cp.score)}，因为第 2 名是已作废的旧版《退款说明》，上一课的失败在这里变成了一个数。context recall 看参考答案的关键事实有几个出现在检索到的文字里，「${SHORT.leak}」只有 ${f2(leakRow.cr.score)}：「${leakRow.cr.missed[0]}」在没检索到的那一段里，后面的回答不可能答全。`,
      facts: [['context precision', `平均 ${f2(avg.cp)}`], ['到账', `${f2(refundRow.cp.score)}（旧版排第 2）`], ['密封圈 / 积分', `${f2(sealRow.cp.score)}`], ['context recall', `平均 ${f2(avg.cr)}，漏水 ${f2(leakRow.cr.score)}`]],
      events: [
        pk('results', 'evaluator', 'amber', '逐个名次', [`到账：${refundRow.retrieved.map(pshort).join(' ')}`, `准确率 ${refundRow.cp.precisions.map(f2).join(' ')}`], [dist1, 'EVAL', `context precision：「${SHORT['refund-time']}」的相关段落在第 1、3 名，(1 + ${num(refundRow.cp.precisions[2], 3)}) / 2 = ${num(refundRow.cp.score, 3)}`, null],
          wire('context precision 和 context recall', 'mem', '示意',
            metricConcept('context precision = Σ(precision@k × v_k) / 相关个数', 'CP', (i) => `v_k：${rows[i].cp.marks.map((m) => (m ? 1 : 0)).join(' ')}；precision@k：${rows[i].cp.precisions.map((p) => num(p, 2)).join(' ')}。`),
            metricConcept('context recall（关键事实出现在检索结果里的比例）', 'CR', (i) => (rows[i].cr.missed.length ? `缺「${rows[i].cr.missed.join('、')}」。` : `「${rows[i].item.facts.join('、')}」都在。`))),
          { ds: { results: [resultRow(I.refund, [{ at: 1, text: '已作废', color: 'amber' }])], truth: [truthRow([I.refund])] } }),
        pk('evaluator', 'scores', 'green', '再加两列', [`CP ${f2(avg.cp)}`, `CR ${f2(avg.cr)}`], [dist1, 'EVAL', `context precision 平均 ${num(avg.cp, 4)}，context recall 平均 ${num(avg.cr, 4)}`, null],
          wire('指标表', 'mem', '示意', concept('平均', [['context precision', num(avg.cp, 4), '相关段落越靠前越高。'], ['context recall', num(avg.cr, 4), '关键事实按字面找。']], 'green')),
          { ds: { scores: [scoreGrid(4, [[I.refund, 'CP'], [I.leak, 'CR']])] } }),
        note('results', '旧版排第 2，CP 降到 ' + f2(refundRow.cp.score), 'amber'),
      ],
    },
    {
      title: '生成回答，核对 faithfulness',
      desc: `${N.supported} / ${N.answerSentences} 句被支持`,
      detail: `每个问题拼成提示让模型回答（回答是示例），${N.questions} 段提示共 ${N.promptTokens} 个 token。faithfulness 把回答拆成句子，看每句能不能从检索到的文字推出：「${SHORT.points}」的第二句「${pointsBad.text.replace(/。$/, '')}」里的「${pointsBad.support.missing[0]}」哪里都找不到，得 ${f2(gen[I.points].faith.score)}。可「${SHORT['refund-time']}」照着旧版写了「银行卡 7–15 个工作日」，旧版就在上下文里，所以 faithfulness 是满分，和参考答案的 ${rows[I.refund].item.facts.length} 个关键事实一比，一个也没对上。faithfulness 只管回答是否忠于上下文，上下文本身错了，它看不出来。`,
      facts: [['faithfulness', `平均 ${f2(avg.faith)}`], ['积分', `${f2(gen[I.points].faith.score)}（编了「${pointsBad.support.missing[0]}」）`], ['到账', `忠实 ${f2(gen[I.refund].faith.score)}，事实 ${f2(gen[I.refund].facts.score)}`], ['关键事实', `平均 ${f2(avg.facts)}`]],
      events: [
        show('llm'),
        pk('results', 'llm', 'slate', `${N.questions} 段提示`, [`共 ${N.promptTokens} token`, `积分：${gen[I.points].prompt.tokens} token`], [dist1, 'PROMPT', `每个问题拼成提示：说明、3 条资料、问题；${N.questions} 段共 ${N.promptTokens} 个 token（本站 BPE）`, utf8Encode(gen[I.points].prompt.text).length],
          wire(`「${rows[I.points].item.question}」的提示`, 'mem', 'format', promptParts('提示', gen[I.points].prompt))),
        show('answer'),
        pk('llm', 'answer', 'green', `${N.questions} 个回答`, [`积分：${ANSWERS.points.slice(0, 12)}…`, `到账：${ANSWERS['refund-time'].slice(0, 12)}…`], [dist1, 'INFER', `模型写出 ${N.questions} 个回答（示例），共 ${N.answerSentences} 句`, utf8Encode(Object.values(ANSWERS).join('\n')).length],
          wire('回答（模型写的，示例）', 'mem', 'format', exampleLines('回答', rows.map((r) => ANSWERS[r.item.id]).join('\n'), `${N.questions} 个回答，每行一个`)),
          { ds: { answer: [answerRow(I.points, [{ at: 1, text: `「${pointsBad.support.missing[0]}」是编的`, color: 'amber' }])] } }),
        pk('answer', 'evaluator', 'green', '逐句核对', [`${N.supported} / ${N.answerSentences} 句被支持`], [dist1, 'CITE', `每句的关键事实（${factsOf(pointsBad.text).join('、')}……）在检索结果里找，词覆盖率 ≥ 0.5 才算支持；${N.supported} / ${N.answerSentences} 句通过`, null],
          wire('faithfulness 和关键事实', 'mem', '示意',
            metricConcept('faithfulness = 被支持的句子 / 全部句子', '忠实', (i) => gen[i].faith.statements.map((s) => `${s.support.supported ? '支持' : '不支持'}：${s.text}`).join(' ')),
            metricConcept('关键事实（回答里出现了参考答案的几个事实）', '事实', (i) => `参考：${rows[i].item.facts.join('、')}；对上：${gen[i].facts.found.join('、') || '没有'}。`))),
        pk('evaluator', 'scores', 'green', '再加两列', [`忠实 ${f2(avg.faith)}`, `事实 ${f2(avg.facts)}`], [dist1, 'EVAL', `faithfulness 平均 ${num(avg.faith, 4)}，关键事实平均 ${num(avg.facts, 4)}`, null],
          wire('指标表', 'mem', '示意', concept('平均', [['faithfulness', num(avg.faith, 4), '对上下文忠实。'], ['关键事实', num(avg.facts, 4), '和参考答案比。']], 'green')),
          { ds: { scores: [scoreGrid(6, [[I.points, '忠实'], [I.refund, '事实']])] } }),
      ],
    },
    {
      title: '答非所问：answer relevancy',
      desc: `改地址 ${f2(relLow.score)}，其余至少 ${f2(Math.min(...relOthers))}`,
      detail: `answer relevancy 不看对错，只看回答是不是在回答这个问题：RAGAS 让大模型根据回答反推 3 个问题，算它们和原问题嵌入余弦的平均。「${bare(rows[I.address].item.question)}」的回答讲的是包邮和运费（示例），句句有出处，faithfulness 满分，可反推出来的都是「${bare(REVERSE.address[0])}」这类问题，和原问题的余弦平均只有 ${f2(relLow.score)}。其余 ${relOthers.length} 题都在 ${f2(Math.min(...relOthers))} 以上；${N.reverse} 个反推问题是示例，余弦用本站的嵌入模型真算，共比较 ${N.reverse} 次。`,
      facts: [['改地址', f2(relLow.score)], ['其余最低', f2(Math.min(...relOthers))], ['平均', f2(avg.relevancy)], ['反推问题', `每题 3 个，共 ${N.reverse} 个（示例）`]],
      events: [
        pk('answer', 'evaluator', 'green', '反推问题', REVERSE.address, [dist4, 'EVAL', `每个回答反推 3 个问题（示例），和原问题比余弦：${N.reverse} 次；改地址平均 ${num(relLow.score, 3)}`, utf8Encode(Object.values(REVERSE).flat().join('\n')).length],
          wire('反推的问题（模型写的，示例）和余弦', 'mem', 'format',
            exampleLines('反推的问题', Object.values(REVERSE).flat().join('\n'), `${N.reverse} 个，每个回答 3 个`),
          ),
          { ds: { answer: [reverseRow(I.address, [{ at: 0, text: `平均 ${f2(relLow.score)}`, color: 'amber' }])] } }),
        pk('evaluator', 'scores', 'green', '最后一列', [`相关 ${f2(avg.relevancy)}`], [dist4, 'EVAL', `answer relevancy 平均 ${num(avg.relevancy, 4)}，改地址 ${num(relLow.score, 4)}`, null],
          wire('answer relevancy', 'mem', '示意', metricConcept('answer relevancy = 反推问题和原问题余弦的平均', '相关', (i) => REVERSE[rows[i].item.id].map((q, k) => `${q} ${num(relevancy[i].cosines[k], 2)}`).join('；'))),
          { ds: { scores: [scoreGrid(7, [[I.address, '相关']])] } }),
        note('answer', '有出处，但答非所问', 'amber'),
      ],
    },
    {
      title: '和 RAGAS 的差别',
      desc: `「保修两年」被判为支持`,
      detail: `RAGAS 的 faithfulness 让大模型把回答拆成一条条陈述，再逐条判断能不能从上下文推出；本站没有大模型，按句拆，靠「关键事实一字不差、词覆盖率 ≥ 0.5」判断。这个字面判据只认阿拉伯数字和编号，「${SHORT.warranty}」的回答把一年写成「两年」，汉字的数抓不出来，词覆盖率 ${f2(warrantyStatement.support.coverage)}，被判为支持，faithfulness 满分，只有关键事实那一列（${f2(gen[I.warranty].facts.score)}）露出了错。不含数字的句子判得偏宽，是本站近似最大的缺口；真实评估要么用大模型裁判，要么像这里一样多看几个指标交叉验证。`,
      facts: [['保修', `忠实 ${f2(gen[I.warranty].faith.score)}，事实 ${f2(gen[I.warranty].facts.score)}`], ['覆盖率', f2(warrantyStatement.support.coverage)], ['RAGAS', '大模型拆陈述、逐条判断'], ['本站', '关键事实 + 词覆盖率 ≥ 0.5']],
      events: [
        state('evaluator', { 拆分: '按句', 判断: '字面' }),
        pk('evaluator', 'answer', 'amber', '漏判', [`「${warrantyStatement.text.slice(0, 12)}…」`, `覆盖率 ${f2(warrantyStatement.support.coverage)}`], [dist4, 'CITE', `「${warrantyStatement.text}」没有阿拉伯数字，只看词覆盖率 ${num(warrantyStatement.support.coverage, 3)} ≥ 0.5，判为支持`, null],
          wire('本站的判据和 RAGAS', 'mem', '示意',
            concept('本站', [['拆分', '按句（。！？）', '回答里的 [n] 标记先去掉。'], ['关键事实', factsOf(warrantyStatement.text).length ? factsOf(warrantyStatement.text).join('、') : '没有', '只认阿拉伯数字连单位、字母数字编号；「两年」不算。'], ['词覆盖率', num(warrantyStatement.support.coverage, 3), '句子的汉字二元组有几成出现在上下文里，≥ 0.5 算支持。']], 'amber'),
            concept('RAGAS（文档的定义）', [['faithfulness', '被支持的陈述 / 陈述总数', '大模型把回答拆成陈述，再逐条判断能否从检索到的上下文推出。'], ['answer relevancy', '反推问题余弦的平均', '大模型根据回答写 3 个问题（strictness 默认 3），和原问题比嵌入余弦；不评价事实对错。'], ['context precision', 'Σ(precision@k × v_k) / 相关个数', '每一块是否相关由大模型对照参考答案判断（也有按 id 比较的非大模型版本）。'], ['context recall', '能归因的参考陈述 / 参考陈述总数', '大模型把参考答案拆成陈述，逐条看能否归因到检索结果。']], 'slate')),
          { ds: { answer: [answerRow(I.warranty, [{ at: 0, text: '「两年」漏判', color: 'amber' }])] } }),
        pk('evaluator', 'scores', 'green', '汇总', [`召回 ${f2(avg.recall)}  CP ${f2(avg.cp)}`, `忠实 ${f2(avg.faith)}  事实 ${f2(avg.facts)}`], [dist4, 'EVAL', `七个指标的平均：${METRICS.map((m) => `${m} ${f2(mean(rows.map((_, i) => valueOf(i, m))))}`).join('，')}`, null],
          wire('汇总', 'mem', '示意', concept('每个指标抓到的问题', [['召回 / CR', `${SHORT.leak}`, '相关段落没检索到，回答必然缺「换货」。'], ['CP', SHORT['refund-time'], '已作废的旧版排在第 2。'], ['忠实', SHORT.points, '回答编了一个上下文里没有的数。'], ['事实', `${SHORT['refund-time']}、${SHORT.warranty}`, '忠于错误的上下文；汉字的数漏判。'], ['相关', SHORT.address, '句句有出处，但答非所问。']], 'green')),
          { ds: { scores: [scoreGrid(7, [[I.warranty, '事实']])] } }),
      ],
    },
  ],
  outro: {
    title: '一个指标只照亮一种失败',
    desc: `${METRICS.length} 个指标，${N.questions} 个问题`,
    text: `检索指标（召回、MRR、context precision、context recall）告诉你该找的找到没有、排得靠不靠前；生成指标（faithfulness、关键事实、answer relevancy）告诉你回答有没有编、对不对、是不是在答这个问题。这一课 ${N.questions} 个问题里，每个故意写坏的回答都只被一两个指标抓到，多数指标的平均分却不低，所以要逐题看、多个指标一起看。本站用标注和字面判据代替 RAGAS 的大模型裁判，可以逐位复现，但不含数字的句子判得偏宽。下一课回到起点：知识该放进检索库，还是训练进模型。`,
    facts: [['检索', `召回 ${f2(avg.recall)}，MRR ${f2(avg.mrr)}`], ['生成', `忠实 ${f2(avg.faith)}，事实 ${f2(avg.facts)}`], ['近似', '标注 + 字面判据'], ['下一课', 'RAG 和微调怎么选']],
  },
};
