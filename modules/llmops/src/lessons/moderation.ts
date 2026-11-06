/**
 * 第三课：输入输出防护——审核（有害内容分四类打分、按策略处置）和 PII 脱敏（识别、校验、替换、换回来）。
 *
 * 真实计算的部分：本站的四类审核分类器（core/moderation.ts，类别键照 OpenAI moderation 文档，分数是本站在自写小数据集上训练的逻辑回归），
 * 整段打分和按句打分（moderateSentences）、示例策略的处置（decide）、测试集上每类抓到和漏掉的条数；
 * PII 识别和校验（core/pii.ts：身份证 ISO 7064 MOD 11-2、银行卡 Luhn）、三种脱敏（类型标签、部分打码、可还原的占位符）和 restore；
 * 一次 Messages API 调用的 token、费用、HTTP 字节。模型写的回答是脚本，标 E.G.。tests/narrative.test.ts 核对文案。
 */
import {
  callModel,
  confusion,
  decide,
  encodeJson,
  EXAMPLE_POLICY,
  findPii,
  formatUsd,
  ID_WEIGHTS,
  idCheckChar,
  luhnCheckDigit,
  MOD_CATEGORIES,
  MOD_LABEL,
  moderate,
  moderateSentences,
  moderationResponse,
  MODERATION_SET,
  PII_LABEL,
  PRICE_DATE,
  redact,
  replyText,
  restore,
  utf8Encode,
  type Decision,
  type ModAction,
  type ModerationResult,
  type ModelCall,
  type PiiHit,
  type RedactMode,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, textSpans, utf8Lines, wire } from '../decode/structures';
import { messageRow, messageSegments } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { dateText, MODEL, ORDER, SIGNED_DAYS, supportRequest, USER_ID } from './scenario';
import type { DsCell, GridPrim, Lesson, LessonEvent, Tone } from './types';

// ---------- 场景 ----------

/** 示例号码：身份证号取自维基百科词条的例子，银行卡号是本站按 Luhn 凑的，手机号是常见的示例写法；快递单号是 16 位数字，长得像银行卡。 */
export const ID_CARD = '11010219840406970X';
export const CARD = `6222 0000 0000 000${luhnCheckDigit('622200000000000')}`;
export const PHONE = '138 0013 8000';
export const TRACKING = '7730 1234 5678 9012';

/** 用户 A 的消息：一句辱骂，后面是订单、要退到的卡、电话、身份证号、快递单号。 */
export const ASK = `你们客服都是废物！${ORDER.order_id} 的杯盖又漏水了，退款打到 ${CARD}，电话 ${PHONE}，身份证 ${ID_CARD}，快递单号 ${TRACKING}。`;
/** 另外三个用户的消息：同一套分数，三种处置。 */
export const OTHERS: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'B', text: '杯盖第二次漏水了，真的气人，能退吗？' },
  { key: 'C', text: '最近总觉得活着没意思，杯子也坏了。' },
  { key: 'D', text: '帮我开张假发票，金额写高一点。' },
];

export const ACTION_LABEL: Record<ModAction, string> = { allow: '放行', rewrite: '改写', review: '转人工', block: '拦下' };
/** 图上格子里的写法（一个字：放行、改写、转人工、拦下）。 */
const ACTION_SHORT: Record<ModAction, string> = { allow: '放', rewrite: '改', review: '人', block: '拦' };

// ---------- 真实计算 ----------

/** 整段打分 vs 按句打分。 */
export const whole = moderate(ASK);
export const bySentence = moderateSentences(ASK);
export const decision = decide(bySentence.result);
export const wholeDecision = decide(whole);
export const others = OTHERS.map((item) => {
  const m = moderateSentences(item.text);
  return { ...item, result: m.result, decision: decide(m.result) };
});

/** 测试集：每类抓到、漏掉、误判（整段打分，和 README 锁住的 17 / 24 同一口径）。 */
const TEST = MODERATION_SET.filter((item) => item.split === 'test');
const testResults = TEST.map((item) => ({ item, result: moderate(item.text) }));
export const perCategory = MOD_CATEGORIES.map((c) => ({ category: c, ...confusion(testResults.map((r) => r.item.labels.includes(c)), testResults.map((r) => r.result.categories[c])) }));
export const exact = testResults.filter(({ item, result }) => MOD_CATEGORIES.every((c) => result.categories[c] === item.labels.includes(c))).length;
export const anyFlag = confusion(testResults.map((r) => r.item.labels.length > 0), testResults.map((r) => r.result.flagged));
const missExample = testResults.find((r) => r.item.text.startsWith('快递员再这样'))!;

/** PII：识别、校验。 */
export const hits = findPii(ASK);
const hitOf = (kind: PiiHit['kind'], valid = true) => hits.find((h) => h.kind === kind && h.valid === valid)!;
export const idHit = hitOf('id_card');
export const cardHit = hitOf('bank_card');
export const trackingHit = hitOf('bank_card', false);
const idSum = [...ID_CARD.slice(0, 17)].reduce((acc, d, i) => acc + Number(d) * ID_WEIGHTS[i], 0);
const trackingDigits = TRACKING.replace(/\D/g, '');

/** 三种脱敏。 */
export const redactions = (['tag', 'mask', 'pseudonym'] as RedactMode[]).map((mode) => ({ mode, ...redact(ASK, hits, mode) }));
const pseudo = redactions[2];

/** 改写（本站的写法）：去掉触发「骚扰辱骂」的那一句，其余原样，再换成占位符。 */
export const kept = bySentence.sentences.filter((s) => s.result.category_scores.harassment < EXAMPLE_POLICY.harassment.threshold).map((s) => s.text).join('');
export const rewritten = redact(kept, findPii(kept), 'pseudonym');
export const dropped = bySentence.sentences.filter((s) => s.result.category_scores.harassment >= EXAMPLE_POLICY.harassment.threshold).map((s) => s.text);

/** 模型的回答（示例）：日期、天数取自订单数据，号码只写占位符。 */
const ph = (value: string) => Object.entries(rewritten.table).find(([, v]) => v === value)![0];
export const REPLY = `很抱歉杯盖又漏水了。订单 ${ORDER.order_id} 是 ${dateText(ORDER.signed_at!)}签收的，到今天 ${SIGNED_DAYS} 天，属于质量问题，可以退货，寄回运费由店铺承担。退款会退回原支付账户，没法改打到 ${ph(CARD)}；取件时快递员会打 ${ph(PHONE)} 联系您。`;
export const call: ModelCall = callModel(supportRequest(rewritten.text), REPLY, 320);
export const output = moderateSentences(replyText(call.message));
export const outputDecision = decide(output.result);
export const outputPii = findPii(replyText(call.message));
export const restored = restore(replyText(call.message), rewritten.table);

const maxScore = (r: ModerationResult) => Math.max(...MOD_CATEGORIES.map((c) => r.category_scores[c]));
const s2 = (v: number) => v.toFixed(2);

export const numbers = {
  askBytes: utf8Encode(ASK).length,
  wholeHarassment: s2(whole.category_scores.harassment),
  wholeAction: wholeDecision.action,
  sentences: bySentence.sentences.length,
  sentenceHarassment: s2(bySentence.result.category_scores.harassment),
  action: decision.action,
  threshold: EXAMPLE_POLICY.harassment.threshold,
  selfHarmThreshold: EXAMPLE_POLICY['self-harm'].threshold,
  others: others.map((o) => ({ key: o.key, action: o.decision.action, category: o.decision.category, score: o.decision.category ? s2(o.decision.score) : s2(maxScore(o.result)) })),
  testSize: TEST.length,
  testViolating: TEST.filter((item) => item.labels.length).length,
  testBenign: TEST.filter((item) => !item.labels.length).length,
  exact,
  anyCaught: anyFlag.tp,
  anyFalse: anyFlag.fp,
  perCategory: perCategory.map((r) => [r.category, r.tp, r.fn, r.fp]),
  missText: missExample.item.text,
  missScore: s2(missExample.result.category_scores.violence),
  piiFound: hits.length,
  piiValid: hits.filter((h) => h.valid).length,
  idSum,
  idMod: idSum % 11,
  idCheck: idCheckChar(ID_CARD.slice(0, 17)),
  cardCheck: luhnCheckDigit(CARD.replace(/\D/g, '').slice(0, -1)),
  trackingCheck: luhnCheckDigit(trackingDigits.slice(0, -1)),
  trackingLast: Number(trackingDigits.slice(-1)),
  trackingReason: trackingHit.reason,
  tag: redactions[0].text,
  mask: redactions[1].text,
  pseudo: pseudo.text,
  tableSize: Object.keys(rewritten.table).length,
  idMask: redactions[1].replacements.find((r) => r.hit.kind === 'id_card')!.replacement,
  rewrittenBytes: utf8Encode(rewritten.text).length,
  droppedBytes: utf8Encode(dropped.join('')).length,
  input: call.message.usage.input_tokens,
  output: call.message.usage.output_tokens,
  cost: formatUsd(call.cost.total),
  costNano: call.cost.total,
  outputMax: s2(maxScore(output.result)),
  outputMaxCategory: MOD_LABEL[MOD_CATEGORIES.reduce((a, b) => (output.result.category_scores[b] > output.result.category_scores[a] ? b : a))],
  outputAction: outputDecision.action,
  outputPii: outputPii.length,
  restoredCount: Object.keys(rewritten.table).filter((p) => replyText(call.message).includes(p)).length,
  requestBytes: call.http.request.bytes.length,
  responseBytes: call.http.response.bytes.length,
};
const N = numbers;
const C = Object.fromEntries(perCategory.map((r) => [r.category, r]));

/** 文案里引用一句话时去掉末尾的标点（detail 按句号、问号数句子）。 */
const quote = (text: string): string => `「${text.replace(/[。！？]$/, '')}」`;

// ---------- 图元 ----------

/** 图上的类别名：取中文名的后两个字（辱骂、违规、自伤、威胁）。 */
const SHORT = Object.fromEntries(MOD_CATEGORIES.map((c) => [c, MOD_LABEL[c].slice(-2)])) as Record<(typeof MOD_CATEGORIES)[number], string>;

function scoreGrid(cols: Array<[string, ModerationResult, Decision?]>, policy = true): GridPrim {
  const rows = [...MOD_CATEGORIES.map((c) => SHORT[c]), ...(cols.some(([, , d]) => d) ? ['处置'] : [])];
  return {
    kind: 'grid',
    id: 's',
    w: 48,
    rows,
    cols: cols.map(([name]) => name),
    cells: rows.map((_, r) => cols.map(([, result, d]): DsCell => {
      if (r === MOD_CATEGORIES.length) return d ? { v: ACTION_SHORT[d.action], tone: d.action === 'allow' ? 'green' : 'amber' } : { v: '', tone: 'empty' };
      const c = MOD_CATEGORIES[r];
      const score = result.category_scores[c];
      const over = score >= (policy ? EXAMPLE_POLICY[c].threshold : 0.5);
      return { v: String(Math.round(score * 100)), tone: over ? 'amber' : 'teal', heat: score };
    })),
  };
}

const sentenceSegs = messageSegments(ASK, bySentence.sentences.filter((s) => s.result.category_scores.harassment >= N.threshold).map((s) => ({ from: s.from, to: s.from + s.text.length, label: '辱骂' })));
const piiSegs = (h: readonly PiiHit[]) => messageSegments(ASK, h.map((x) => ({ from: x.from, to: x.to, label: x.valid ? PII_LABEL[x.kind] : '校验不过' })));
/** PII 的格子：valid 的 amber，校验不过的 teal（不替换）。 */
function piiRow(lift = false) {
  const row = messageRow('m', piiSegs(hits), { reveal: true, lift });
  row.cells = row.cells.map((cell) => (cell.sub === '校验不过' ? { ...cell, tone: 'teal' as Tone, lift: undefined } : cell));
  return row;
}
/** 脱敏后的文字：替换的部分 slate。 */
function redactedRow(text: string, replacements: ReadonlyArray<{ from: number; to: number; replacement: string; hit: PiiHit }>, mode: string) {
  const segs = messageSegments(text, replacements.map((r) => ({ from: r.from, to: r.to, label: mode })));
  return { kind: 'row' as const, id: 'm', w: 46, cells: segs.map((seg, i): DsCell => ({ v: String(utf8Encode(seg.text).length), key: `m${i}`, tone: seg.hit ? 'slate' : 'blue', sub: seg.hit ?? '…' })) };
}

const matrixGrid: GridPrim = {
  kind: 'grid',
  id: 'x',
  w: 46,
  rows: ['抓到', '漏掉', '误判'],
  cols: MOD_CATEGORIES.map((c) => SHORT[c]),
  cells: [0, 1, 2].map((r) => perCategory.map((p): DsCell => {
    const v = [p.tp, p.fn, p.fp][r];
    return { v: String(v), tone: r === 0 ? 'green' : v ? 'amber' : 'dim' };
  })),
};

// ---------- 字节层 ----------

const roundScores = (r: ModerationResult): ModerationResult => ({ ...r, category_scores: Object.fromEntries(MOD_CATEGORIES.map((c) => [c, +r.category_scores[c].toFixed(3)])) as ModerationResult['category_scores'] });
const modJson = (r: ModerationResult) => encodeJson(moderationResponse('modr-xiaopu-0001', 'xiaopu-moderation-demo', roundScores(r)));
const modWire = (r: ModerationResult, label: string, extra = '') => wire(label, 'mem', 'internal',
  jsonBody('审核结果（字段名照 OpenAI moderation，分数是本站的分类器）', modJson(r), {
    root: 'results[0]',
    expand: ['results[0].category_scores.harassment'],
    example: ['id'],
    notes: { 'results[0].flagged': '任一类别过了 0.5 就是 true。', 'results[0].category_scores.harassment': `骚扰辱骂的分数${extra}。` },
  }));
const userWire = (text: string) => wire('用户的消息', 'mem', 'format', utf8Lines('用户的消息', text, { summary: `UTF-8 ${utf8Encode(text).length} 字节` }));
const screenJson = (text: string) => encodeJson({ stage: 'input', user_id: USER_ID, text });
const screenWire = (text: string) => wire('交给防护层', 'mem', 'internal', jsonBody('筛查请求（本站的写法）', screenJson(text), { notes: { stage: 'input：输入侧，模型还没看到。', text: '原文，号码都在里面。本站的审核在自己的后端跑；要是调用外部的审核接口，号码也会一起发出去。' } }));
const sentenceWire = wire('按句打分', 'mem', 'internal',
  textSpans('消息', ASK, messageSegments(ASK, bySentence.sentences.map((s, i) => ({ from: s.from, to: s.to, label: `第 ${i + 1} 句` })))),
  concept('每句的分数', bySentence.sentences.map((s, i): [string, string, string] => [`第 ${i + 1} 句`, `辱骂 ${s2(s.result.category_scores.harassment)}`, `违法 ${s2(s.result.category_scores.illicit)}，自伤 ${s2(s.result.category_scores['self-harm'])}，暴力 ${s2(s.result.category_scores.violence)}。`]), 'violet'));
const policyWire = wire('处置策略（本站的示例）', 'mem', '示意', concept('策略', MOD_CATEGORIES.map((c): [string, string, string] => [MOD_LABEL[c], `≥ ${EXAMPLE_POLICY[c].threshold} → ${ACTION_LABEL[EXAMPLE_POLICY[c].action]}`, c]), 'slate', '超过阈值的类别里取处置最重的'));
const reportJson = encodeJson({ test_set: N.testSize, violating: N.testViolating, exact_match: N.exact, per_category: Object.fromEntries(perCategory.map((p) => [p.category, { caught: p.tp, missed: p.fn, false_alarms: p.fp }])) });
const reportWire = wire('测试集上的审核（本站的报告）', 'mem', 'internal', jsonBody('评估报告', reportJson, { expand: ['per_category.violence'], notes: { exact_match: `${N.testSize} 条里四个类别全判对的条数。`, 'per_category.violence': `漏掉的有${quote(N.missText)}，暴力分只有 ${N.missScore}。` } }));

const piiWire = wire('找出 PII（本站的正则 + 真实的校验）', 'mem', 'internal',
  textSpans('消息', ASK, piiSegs(hits), { notes: { 身份证号: `ISO 7064 MOD 11-2：前 17 位乘加权因子求和 S = ${N.idSum}，S mod 11 = ${N.idMod}，校验码 ${N.idCheck}（10 写成 X）。`, 银行卡号: `Luhn：校验位应为 ${N.cardCheck}，和最后一位一致。`, 校验不过: `快递单号：Luhn 校验位应为 ${N.trackingCheck}，最后一位是 ${N.trackingLast}，不是银行卡号，不替换。`, 手机号: '1[3-9] 开头的 11 位，只看格式。' } }),
  concept('命中', hits.map((h): [string, string, string] => [PII_LABEL[h.kind], h.valid ? '校验通过' : (h.reason ?? ''), h.text])));
const redactWire = (i: number, label: string, fidelity: 'internal' = 'internal') => wire(label, 'mem', fidelity, utf8Lines('脱敏后的文字', redactions[i].text, { summary: `替换 ${redactions[i].replacements.length} 处，快递单号校验不过、原样保留` }),
  ...(i === 2 ? [concept('对照表（只留在后端）', Object.entries(redactions[i].table).map(([k, v]): [string, string, string] => [k, v, '模型回答后用 restore 换回来。']))] : []));

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const requestWire = wire('发给模型的请求', 'mem', 'format',
  httpHead('请求头', call.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
  jsonBody('请求体', encodeJson(call.request), { expand: ['messages[0].content'], example: ['metadata.user_id'], notes: { 'messages[0].content': `改写后的消息：去掉了辱骂的那一句，号码都换成了占位符，快递单号原样。` } }));
const responseWire = wire('模型的响应', 'mem', 'format',
  httpHead('响应头', call.http.response, { example: ['request-id', 'date'] }),
  jsonBody('响应体', encodeJson(call.message), { expand: ['usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content', 'usage', 'usage.input_tokens', 'usage.output_tokens'], notes: { content: '回答（示例）：号码只写占位符，日期和天数取自订单数据。' } }));
const outputJson = encodeJson({ stage: 'output', max_score: +maxScore(output.result).toFixed(3), action: outputDecision.action, pii_hits: outputPii.length });
const outputWire = wire('输出侧检查（本站的写法）', 'mem', 'internal', jsonBody('检查结果', outputJson, { notes: { max_score: '四类、各句里的最高分。', pii_hits: '回答里没有号码，只有占位符；检查要在换回来之前做。' } }));

// ---------- 事件 ----------

const others3: LessonEvent[] = others.map((o, i) =>
  pk('backend', 'guard', 'blue', `用户 ${o.key}`, [preview(o.text, 12), ACTION_LABEL[o.decision.action]], [0, 'SCORE', `用户 ${o.key}：${o.decision.category ? `${MOD_LABEL[o.decision.category]} ${s2(o.decision.score)}` : `最高 ${s2(maxScore(o.result))}`}，${ACTION_LABEL[o.decision.action]}`, screenJson(o.text).bytes.length], screenWire(o.text), {
    ds: { scores: [scoreGrid([['A', bySentence.result, decision], ...others.slice(0, i + 1).map((x): [string, ModerationResult, Decision] => [x.key, x.result, x.decision])])] },
  }));

export const moderation: Lesson = {
  id: 'moderation',
  name: 'MODERATION',
  title: '输入输出防护：审核与脱敏',
  group: 'safety',
  layer: [1, 3],
  layerNote: '这课从「模型调用」到「防护」：防护层在用户的话进模型之前审核、脱敏、改写，回答出来后再审一遍、把占位符换回来。',
  costNote: `只有改写后的那一次 Claude Opus 5.5 调用花了钱：${N.cost}；审核和脱敏在本站的后端跑，不调用模型。`,
  nodes: ['app', 'backend', 'guard', 'llm', 'message', 'scores', 'matrix'],
  place: { app: [90, 150], backend: [500, 250], llm: [930, 80], guard: [500, 590], message: [130, 470], scores: [890, 440], matrix: [840, 800] },
  labels: {
    app: ['应用界面', '客服对话框'],
    backend: ['客服后端', '先审核脱敏，再调用模型'],
    guard: ['防护层', '审核 + PII'],
    llm: ['模型', MODEL],
    message: ['用户 A 的消息', '每格一段的 UTF-8 字节'],
    scores: ['审核分数 ×100', '四类，按示例策略处置'],
    matrix: ['测试集上的审核', `${N.testSize} 条，每类抓到几条`],
  },
  labelAt: { message: [0, 125], scores: [0, 150], matrix: [0, 120] },
  radius: { message: 70, scores: 70, matrix: 70 },
  initial: { message: [], scores: [], matrix: [] },
  start: ['app', 'backend', 'llm'],
  legend: [['blue', '用户的消息'], ['amber', '过了阈值、要处置、PII'], ['green', '放行、模型写的回答'], ['teal', '没过阈值、校验不过'], ['slate', '脱敏后的占位'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '用户的话有害、或者带着手机号身份证号时，进模型前后各查一遍',
    description: `防护层除了挡注入，还要管两件事：话本身有没有害（审核），话里有没有不该交给模型的个人信息（脱敏）。这一课用本站的四类审核分类器（类别名照 OpenAI moderation）给消息打分，按示例策略放行、改写、转人工或拦下；用正则加真实的校验位找出手机号、身份证号、银行卡号，换成占位符，模型回答后再换回来。回答出来同样审一遍。审核分类器只在 ${MODERATION_SET.length} 条自写样本上训练，测试集 ${N.testSize} 条里有 ${N.testViolating - N.anyCaught} 条违规没认出来，课里如实写出。`,
    facts: [
      ['审核', '4 类，按句打分'],
      ['处置', '放行 / 改写 / 转人工 / 拦下'],
      ['PII', `找到 ${N.piiFound} 处，替换 ${N.piiValid} 处`],
      ['费用', `${N.cost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '整段打分，辱骂被稀释了',
      desc: `整段 ${N.wholeHarassment}，按句 ${N.sentenceHarassment}`,
      detail: `用户 A 开口先骂了一句，后面跟着订单、退款卡号、电话、身份证号和快递单号。防护层的审核给四个类别各打一个分（类别键 harassment、illicit、self-harm、violence 取自 OpenAI moderation 文档，分数是本站在自写样本上训练的分类器算的），整段打分时「骚扰辱骂」只有 ${N.wholeHarassment}，因为一长串号码把那一句的分量摊薄了。按句切开、每类取各句的最高分，第 1 句是 ${N.sentenceHarassment}，过了阈值 ${N.threshold}。`,
      facts: [['消息', `${N.askBytes} 字节，${N.sentences} 句`], ['整段', `辱骂 ${N.wholeHarassment}，${ACTION_LABEL[N.wholeAction]}`], ['按句', `辱骂 ${N.sentenceHarassment}`], ['费用', '$0']],
      events: [
        type(preview(ASK, 22)),
        show('message'),
        pk('app', 'backend', 'blue', '用户 A 的消息', [preview(ASK, 14), `${N.askBytes} 字节`], [0, 'CALL', '用户 A 的消息交给客服后端', N.askBytes], userWire(ASK), { ds: { message: [messageRow('m', messageSegments(ASK, []))] } }),
        show('guard', 'scores'),
        pk('backend', 'guard', 'blue', '送去审核', ['输入侧', `${N.askBytes} 字节`], [0, 'SCREEN', '先过防护层：审核、找 PII', screenJson(ASK).bytes.length], screenWire(ASK), { ds: { message: [messageRow('m', messageSegments(ASK, []), { lift: true })] } }),
        pk('guard', 'scores', 'violet', '整段打分', [`辱骂 ${N.wholeHarassment}`], [0, 'SCORE', `整段：辱骂 ${N.wholeHarassment}，没过 ${N.threshold}`, modJson(whole).bytes.length], modWire(whole, '整段打分', '：被一长串号码摊薄了'), { ds: { scores: [scoreGrid([['整段', whole]])] } }),
        note('scores', `整段：辱骂只有 ${N.wholeHarassment}`, 'amber'),
        pk('guard', 'scores', 'violet', '按句打分', [`${N.sentences} 句`, `辱骂 ${N.sentenceHarassment}`], [0, 'SCORE', `按句：第 1 句辱骂 ${N.sentenceHarassment}`, N.askBytes], sentenceWire, { ds: { scores: [scoreGrid([['整段', whole], ['按句', bySentence.result]])], message: [messageRow('m', sentenceSegs, { reveal: true })] } }),
        state('guard', { 辱骂: N.sentenceHarassment }),
      ],
    },
    {
      title: '同一套分数，四种处置',
      desc: `A 改写、B 放行、C 转人工、D 拦下`,
      detail: `分数只是概率，怎么处置是策略（本站的示例）：辱骂不拦，用户确实有问题要解决，去掉骂人的话再交给模型（改写）；违法违规和暴力威胁直接拦下；流露轻生念头的转人工，阈值放低到 ${N.selfHarmThreshold}，因为漏掉一个的代价远大于多转一个。用户 C 的自伤分 ${N.others[1].score}、D 的违法分 ${N.others[2].score}，B 虽然在生气，最高分只有 ${N.others[0].score}，放行。在 ${N.testSize} 条测试样本上，${N.testViolating} 条违规认出 ${N.anyCaught} 条、正常的没有误判，没见过的说法常常认不出，比如${quote(N.missText)}暴力分只有 ${N.missScore}，所以审核要配合人工复核和真实数据上的评估。`,
      facts: [['A', ACTION_LABEL[N.action]], ['C 自伤', `${N.others[1].score} ≥ ${N.selfHarmThreshold}，转人工`], ['测试集', `违规 ${N.anyCaught} / ${N.testViolating}，误判 ${N.anyFalse}`], ['依据', '本站的示例策略']],
      events: [
        pk('guard', 'backend', 'amber', '处置：改写', [`辱骂 ${N.sentenceHarassment}`], [0, 'REWRITE', `A：辱骂 ${N.sentenceHarassment} ≥ ${N.threshold}，按策略改写（不拦）`, null], policyWire, { ds: { scores: [scoreGrid([['A', bySentence.result, decision]])] } }),
        ...others3,
        show('matrix'),
        pk('guard', 'matrix', 'teal', `测试集 ${N.testSize} 条`, [`违规认出 ${N.anyCaught} / ${N.testViolating}`], [0, 'EVAL', `${N.testSize} 条测试样本：四类全判对 ${N.exact} 条`, reportJson.bytes.length], reportWire, { ds: { matrix: [matrixGrid] } }),
        note('matrix', `暴力漏掉 ${C.violence.fn} 条`, 'amber'),
      ],
    },
    {
      title: '找出 PII：校验位挡掉误报',
      desc: `长得像的 ${N.piiFound} 处，校验通过 ${N.piiValid} 处`,
      detail: `PII（个人身份信息）先用正则找长得像的：手机号、身份证号、银行卡号，A 的消息里找到 ${N.piiFound} 处。身份证号的最后一位是校验码：前 17 位乘上加权因子求和得 ${N.idSum}，除以 11 余 ${N.idMod}，对应的校验码是 ${N.idCheck}，和号码一致；银行卡号用 Luhn 校验，校验位应为 ${N.cardCheck}，也一致。快递单号同样是 16 位数字，Luhn 算出的校验位是 ${N.trackingCheck}、实际是 ${N.trackingLast}，所以不是银行卡号，不替换，模型查物流还用得上它。`,
      facts: [['身份证号', `S = ${N.idSum}，余 ${N.idMod} → ${N.idCheck}`], ['银行卡号', `Luhn 校验位 ${N.cardCheck}`], ['快递单号', `应为 ${N.trackingCheck}、实为 ${N.trackingLast}`], ['替换', `${N.piiValid} / ${N.piiFound} 处`]],
      events: [
        pk('guard', 'message', 'amber', '找 PII', [`${N.piiFound} 处长得像`, `${N.piiValid} 处校验通过`], [0, 'CHECK', `正则找到 ${N.piiFound} 处，校验通过 ${N.piiValid} 处（快递单号 Luhn 不过）`, N.askBytes], piiWire, { ds: { message: [piiRow()] } }),
        state('guard', { 辱骂: N.sentenceHarassment, PII: `${N.piiValid} 处` }),
        note('message', '快递单号：Luhn 不过，不是卡号'),
      ],
    },
    {
      title: '三种脱敏：标签、打码、占位符',
      desc: `占位符可以换回来，对照表只留在后端`,
      detail: `类型标签把号码整个换成「[手机号]」，最干净，但模型和后面的人都分不清是哪一个；部分打码保留首尾，比如身份证号成了 ${N.idMask}，人工客服核对时还用得上。占位符是「<手机号_1>」这样的编号，同一个号码同一个编号，对照表留在后端、不发给模型，模型照样能说「我们会打 <手机号_1> 联系您」，回答回来再换成原文。这一课选占位符：模型需要知道「有一张卡、有一个电话」，但不需要知道号码本身。`,
      facts: [['标签', '[手机号]'], ['打码', N.idMask], ['占位符', `<手机号_1>，对照表 ${N.tableSize} 项`], ['对照表', '只在后端']],
      events: [
        pk('guard', 'message', 'slate', '类型标签', ['[手机号]'], [0, 'REWRITE', `tag：替换 ${N.piiValid} 处`, utf8Encode(redactions[0].text).length], redactWire(0, '类型标签'), { ds: { message: [redactedRow(redactions[0].text, redactions[0].replacements, '标签')] } }),
        pk('guard', 'message', 'slate', '部分打码', [N.idMask], [0, 'REWRITE', `mask：手机号留前 3 后 4，身份证号留前 6 后 4`, utf8Encode(redactions[1].text).length], redactWire(1, '部分打码'), { ds: { message: [redactedRow(redactions[1].text, redactions[1].replacements, '打码')] } }),
        pk('guard', 'message', 'slate', '占位符', ['<手机号_1>'], [0, 'REWRITE', `pseudonym：同值同号，对照表留在后端`, utf8Encode(pseudo.text).length], redactWire(2, '可还原的占位符'), { ds: { message: [redactedRow(pseudo.text, pseudo.replacements, '占位')] } }),
        state('backend', { 对照表: `${N.tableSize} 项` }),
      ],
    },
    {
      title: '改写之后才交给模型',
      desc: `去掉辱骂那一句，号码换成占位符，${N.cost}`,
      detail: `按策略改写：去掉触发「骚扰辱骂」的那一句（${N.droppedBytes} 字节，原话留在日志里），其余的号码换成占位符，发给模型的消息只剩 ${N.rewrittenBytes} 字节。这是本站的写法，也可以让小模型把整段改写成语气平和的工单，代价是多一次调用。模型（示例）回答时只写占位符：退款退回原支付账户、取件时打电话联系，日期和天数取自订单数据，这次调用输入 ${num(N.input)}、输出 ${num(N.output)} token，${N.cost}。`,
      facts: [['去掉', `${N.droppedBytes} 字节（第 1 句）`], ['发给模型', `${N.rewrittenBytes} 字节`], ['token', `输入 ${num(N.input)}、输出 ${num(N.output)}`], ['费用', N.cost]],
      events: [
        pk('guard', 'backend', 'slate', '改写后的消息', [preview(rewritten.text, 12), `${N.rewrittenBytes} 字节`], [0, 'REWRITE', `去掉第 1 句、换成占位符：${N.rewrittenBytes} 字节`, N.rewrittenBytes], wire('改写后的消息', 'mem', 'internal', utf8Lines('text', rewritten.text, { summary: '去掉辱骂的那一句，号码换成占位符' })), { ds: { message: [redactedRow(rewritten.text, rewritten.replacements, '占位')] } }),
        pk('backend', 'llm', 'blue', 'POST /v1/messages', [`${num(N.requestBytes)} 字节`], [0, 'HTTP', 'system、metadata.user_id、改写后的消息', N.requestBytes], requestWire),
        pk('llm', 'backend', 'green', '回答', [preview(REPLY, 12), `${N.output} token`], [N.costNano, 'INFER', `输入 ${num(N.input)}、输出 ${num(N.output)} token，${N.cost}`, N.responseBytes], responseWire, { ds: { message: [messageRow('m', messageSegments(REPLY, []), { tone: 'green' })] } }),
        state('backend', { 对照表: `${N.tableSize} 项`, 模型调用: '1 次', 费用: N.cost }),
      ],
    },
    {
      title: '输出侧：再审一遍，再换回来',
      desc: `回答最高分 ${N.outputMax}，没有号码，换回 ${N.restoredCount} 处`,
      detail: `回答回来先过同一个审核，各句四类里最高的是「${N.outputMaxCategory}」${N.outputMax}，离阈值 ${N.threshold} 不远但没到，放行（输出侧同样会误判）；再找一遍 PII，找到 ${N.outputPii} 处，因为回答里只有占位符，这一步要在换回来之前做，否则查到的全是用户自己的号码。最后后端按对照表把 ${N.restoredCount} 个占位符换回原文交给界面，卡号、电话、身份证号从头到尾没有离开过后端。`,
      facts: [['输出审核', `最高 ${N.outputMax}，${ACTION_LABEL[N.outputAction]}`], ['输出 PII', `${N.outputPii} 处`], ['换回', `${N.restoredCount} 个占位符`], ['费用', N.cost]],
      events: [
        pk('backend', 'guard', 'teal', '检查输出', ['审核 + PII'], [N.costNano, 'CHECK', '回答交给防护层：审核、找号码', utf8Encode(REPLY).length], wire('回答', 'mem', 'format', utf8Lines('text', REPLY, { summary: '模型的回答（示例），只有占位符' }))),
        pk('guard', 'scores', 'violet', '输出审核', [`最高 ${N.outputMax}`], [N.costNano, 'SCORE', `回答：四类最高 ${N.outputMax}，放行`, modJson(output.result).bytes.length], modWire(output.result, '输出侧审核'), { ds: { scores: [scoreGrid([['回答', output.result, outputDecision]])] } }),
        pk('guard', 'backend', 'teal', '通过', [`PII ${N.outputPii} 处`], [N.costNano, 'PASS', `回答里没有号码（${N.outputPii} 处），放行`, outputJson.bytes.length], outputWire),
        pk('backend', 'app', 'green', '换回来的回答', [preview(restored, 14)], [N.costNano, 'CALL', `按对照表换回 ${N.restoredCount} 个占位符，交给界面`, utf8Encode(restored).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', restored, { summary: '占位符换回了原文' })), { ds: { message: [messageRow('m', messageSegments(restored, []), { tone: 'green' })] } }),
        render,
        note('backend', `一次调用 ${N.cost}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '审核给分数，策略定处置，号码不出后端',
    desc: `按句打分、四种处置、占位符换进换出`,
    text: `审核分类器只给分数，拦截、改写、转人工还是放行由策略决定，阈值按漏掉的代价各设各的；整段打分会被长消息稀释，按句打分更稳。PII 先用正则找、再用校验位筛，占位符让模型照常工作而号码留在后端，回答回来先审核、先查号码，再换回原文。本站的审核分类器只是几十条样本训练的玩具，测试集上 ${N.testViolating} 条违规漏了 ${N.testViolating - N.anyCaught} 条，真实上线要用专门的审核模型和自己的数据评估。下一课看同一个用户反复来：用不透明的 user_id 认出他、给他限流、屡犯升级。`,
    facts: [['审核', `按句：辱骂 ${N.sentenceHarassment}`], ['测试集', `违规认出 ${N.anyCaught} / ${N.testViolating}`], ['PII', `替换 ${N.piiValid}、放过 ${N.piiFound - N.piiValid}`], ['下一课', '用户标识与滥用追踪']],
  },
};
