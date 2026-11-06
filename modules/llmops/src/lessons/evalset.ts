/**
 * 评估组四课（deterministic、judge、human、regression）共用的评估集和脚本。
 *
 * 场景还是小铺的客服（claude-opus-5-5）。这里只放文字和脚本：
 * - 三个调用点的评估用例：意图分类（只回一个类别名）、客服回答（带四个工具）、工单摘要（只输出 JSON）；
 * - 每条用例在提示 v1、v2 下的输出（模型写的，示例 E.G.）；
 * - 12 个开放问题的两版回答（同样是示例），给评委和人工标注用；
 * - 三名标注员的标注、评委的打分和二选一（本站自写的示例数据）。
 * 评分、通过率、区间、kappa、位置偏差、McNemar、token 和费用全部由 core/ 在课程文件里真实计算。
 */
import {
  daysBetween,
  exactMatch,
  exampleId,
  normalizeAnswer,
  ORDERS,
  POLICIES,
  regexCheck,
  schemaCheck,
  SHOP_TOOL_DEFS,
  TODAY,
  toolCallCheck,
  type ContentBlock,
  type EvalCase,
  type Grade,
  type JsonSchema,
  type MessagesRequest,
  type Rubric,
  type ToolDefinition,
  type ToolExpectation,
} from '../core';
import { dateText, MODEL, NORMAL_ASK, NORMAL_REPLY } from './scenario';

// ---------- 提示 ----------

/** 店铺规则：共享包 llm-core 的 POLICIES 原文，逐条一行。 */
export const POLICY_TEXT = POLICIES.map((doc) => doc.text).join('\n');
/** 换货的天数，取自《售后规则》第 2 条的原文。 */
export const EXCHANGE_DAYS = Number(/(\d+) 天内出现质量问题可以换货/.exec(POLICIES.find((doc) => doc.id === 'aftersale#2')!.text)![1]);

/** 客服回答的系统提示 v1。 */
export const REPLY_SYSTEM_V1 = `你是「小铺」网店的客服，只回答和订单、售后有关的问题。今天是 ${TODAY}。\n店铺规则：\n${POLICY_TEXT}\n需要订单信息时调用 get_order，用户要退货时调用 create_return，规则拿不准时用 search_policy 查。不要编造电话、链接，不要承诺规则以外的事。`;
/** v2 在末尾加的四句（回归课讲它们）。 */
export const PROMPT_V2_ADDED = ['回答尽量简短，一两句话说完。', '订单号一律写成大写，比如 A1024。', '杯盖漏水、破损、不加热都算质量问题。', '回答和某个订单有关的问题前，先用 get_order 查签收日期。'] as const;
export const REPLY_SYSTEM_V2 = `${REPLY_SYSTEM_V1}\n${PROMPT_V2_ADDED.join('')}`;

/** 交给模型的工具定义：llm-core 的 SHOP_TOOL_DEFS 去掉 title 和 hints（那是 MCP 的字段）。 */
export const TOOLS: ToolDefinition[] = Object.values(SHOP_TOOL_DEFS).map((def) => ({ name: def.name, description: def.description, input_schema: def.input_schema }));

export const ROUTER_LABELS = ['退货', '换货', '查物流', '退款进度', '其他'] as const;
export const ROUTER_SYSTEM = `把用户的话分到一个类别：${ROUTER_LABELS.join('、')}。只回答类别名。`;
export const TICKET_SYSTEM = '把下面这段客服对话整理成工单。只输出一个 JSON 对象，字段：intent（return、exchange、logistics、refund_status、other 之一）、order_id（订单号）、needs_human（要不要转人工，true 或 false）。';
export const TICKET_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['return', 'exchange', 'logistics', 'refund_status', 'other'] },
    order_id: { type: 'string', pattern: '^A\\d{4}$' },
    needs_human: { type: 'boolean' },
  },
  required: ['intent', 'order_id', 'needs_human'],
  additionalProperties: false,
};

export type Version = 'v1' | 'v2';
export type Site = 'router' | 'reply' | 'ticket';

export const replyRequest = (text: string, version: Version = 'v1'): MessagesRequest => ({ model: MODEL, max_tokens: 1024, system: version === 'v1' ? REPLY_SYSTEM_V1 : REPLY_SYSTEM_V2, tools: TOOLS, messages: [{ role: 'user', content: text }] });
export const routerRequest = (text: string): MessagesRequest => ({ model: MODEL, max_tokens: 16, system: ROUTER_SYSTEM, messages: [{ role: 'user', content: text }] });
export const ticketRequest = (text: string): MessagesRequest => ({ model: MODEL, max_tokens: 256, system: TICKET_SYSTEM, messages: [{ role: 'user', content: text }] });

// ---------- 订单数据里的事实 ----------

const order = (id: string) => ORDERS.find((o) => o.order_id === id)!;
export const A1025 = order('A1025');
/** A1025 签收到今天的天数（订单数据 + daysBetween）。 */
export const A1025_DAYS = daysBetween(A1025.signed_at!, TODAY);

// ---------- 12 个开放问题和两版回答（示例） ----------

export interface OpenItem {
  id: string;
  short: string;
  question: string;
  v1: string;
  v2: string;
  /** 只有前 6 个进确定性评估：正则要匹配的、不能出现的。 */
  must?: string[];
  mustNot?: string[];
}

export const OPEN: OpenItem[] = [
  { id: 'q1', short: '无理由', question: '签收 5 天了，不想要了能退吗？', v1: '可以。签收 7 天内支持无理由退货，商品和配件要完好，寄回的运费由您承担。', v2: '可以，签收 7 天内能无理由退货。', must: ['7 ?天', '运费'] },
  { id: 'q2', short: '运费', question: '退货的运费谁出？', v1: '退货运费由店铺承担。', v2: '质量问题退货，运费由店铺承担。', must: ['质量问题', '买家|您'] },
  { id: 'q3', short: '电话', question: '你们的客服电话是多少？', v1: '您可以拨打客服热线 13800138000，工作时间 9:00–18:00。', v2: '小铺暂时没有电话客服，有问题直接在这里问我就行。', mustNot: ['1[3-9]\\d{9}'] },
  { id: 'q4', short: '拆封', question: '七天无理由退货，拆封了还能退吗？', v1: '能退。七天内只要商品和配件完好就可以，寄回的运费由您承担。', v2: '七天内商品和配件完好就能退，运费您出。', must: ['7 ?天'] },
  {
    id: 'q5',
    short: '超期',
    question: `订单 A1025 是 ${dateText(A1025.signed_at!)}签收的，热水壶不加热了，能退款吗？`,
    v1: `签收已经 ${A1025_DAYS} 天，超过了 7 天的退款期限和 ${EXCHANGE_DAYS} 天的换货期限，我帮您转人工客服，看看还能怎么处理。`,
    v2: '可以退款，请把热水壶寄回来。',
    must: ['人工'],
    mustNot: ['可以退款|能退款|给您退款'],
  },
  { id: 'q6', short: '只退钱', question: '能不退货，直接退钱吗？', v1: '退款要先退货：商品寄回、审核通过后，钱原路退回。', v2: '需要先退货，寄回审核通过后原路退款。', must: ['退货|寄回'], mustNot: ['已(经)?(为您)?退款'] },
  { id: 'q7', short: '漏水', question: NORMAL_ASK, v1: NORMAL_REPLY, v2: '可以退，杯盖漏水算质量问题。' },
  { id: 'q8', short: '换货费', question: '换货的话，运费谁出？', v1: '换货的运费由店铺承担。', v2: `签收 ${EXCHANGE_DAYS} 天内的质量问题可以换货，来回运费都由店铺承担。` },
  { id: 'q9', short: '审核', question: '退款审核要多久？', v1: '审核一般 24 小时内完成，周末顺延；审核通过后原路退款。', v2: '一般 24 小时内审核完，周末顺延。' },
  { id: 'q10', short: '配送', question: '江浙沪发货几天能到？', v1: '非常感谢您的耐心咨询！我们非常重视每一位顾客的购物体验。关于您关心的配送时间，小铺默认使用顺丰快递发货，江浙沪地区一般次日就能送达，其他地区 2–4 天。如果还有任何问题，欢迎随时联系我们，祝您购物愉快！', v2: '顺丰发货，江浙沪一般次日送达。' },
  { id: 'q11', short: '划痕', question: '收到的杯子有划痕，想换一个。', v1: '直接寄回来就行，我们收到后给您换新的。', v2: '麻烦先在订单详情里拍照上传划痕的位置，客服确认是质量问题后再寄回换货。' },
  { id: 'q12', short: '催促', question: '你们到底能不能退？等半天了！', v1: '能不能退要看签收天数和原因，请提供订单号。', v2: '抱歉让您久等了。告诉我订单号，我马上查签收日期，看能不能直接给您退。' },
];

// ---------- 确定性评估的用例 ----------

export type Expect =
  | { kind: 'label'; label: string }
  | { kind: 'regex'; must: string[]; mustNot: string[] }
  | { kind: 'tool'; tool: ToolExpectation }
  | { kind: 'ticket'; value: { intent: string; order_id: string; needs_human: boolean } };

export interface DetCase extends EvalCase<Expect> {
  site: Site;
  /** 格子里放得下的短名字。 */
  short: string;
}

export const GRADER_TAG = { label: '精确匹配', regex: '正则', tool: '工具调用', ticket: 'Schema' } as const;
const det = (id: string, site: Site, short: string, input: string, expected: Expect): DetCase => ({ id, site, short, input, expected, tags: [GRADER_TAG[expected.kind]] });

export const DET_CASES: DetCase[] = [
  det('c1', 'router', '退货', 'A1024 杯盖漏水，我要退货', { kind: 'label', label: '退货' }),
  det('c2', 'router', '换货', '杯子漏水，能换个新的吗？', { kind: 'label', label: '换货' }),
  det('c3', 'router', '物流', 'A1031 到哪了？', { kind: 'label', label: '查物流' }),
  det('c4', 'router', '退款', '退款怎么还没到账？', { kind: 'label', label: '退款进度' }),
  det('c5', 'router', '周末', '你们周末上班吗？', { kind: 'label', label: '其他' }),
  det('c6', 'router', '补发', '杯盖丢了能补发吗？', { kind: 'label', label: '其他' }),
  det('t1', 'reply', '查单', 'A1024 到哪了？', { kind: 'tool', tool: { name: 'get_order', args: { order_id: 'A1024' } } }),
  det('t2', 'reply', '小写', '我的订单 a1024 杯盖漏水，帮我退了吧', { kind: 'tool', tool: { name: 'create_return', args: { order_id: 'A1024', reason: 'quality' } } }),
  det('t3', 'reply', '原因', 'A1024 的杯盖拧紧了还是漏水，我要退货', { kind: 'tool', tool: { name: 'create_return', args: { order_id: 'A1024', reason: 'quality' } } }),
  det('t4', 'reply', '到账', '退款一般多久到账？', { kind: 'tool', tool: { name: 'search_policy' } }),
  det('t5', 'reply', '密封圈', 'A1031 的密封圈发货了吗？', { kind: 'tool', tool: { name: 'get_order', args: { order_id: 'A1031' } } }),
  det('t6', 'reply', '先查', 'A1025 的热水壶能退吗？', { kind: 'tool', tool: { name: 'get_order', args: { order_id: 'A1025' } } }),
  ...OPEN.filter((item) => item.must || item.mustNot).map((item) => det(item.id, 'reply', item.short, item.question, { kind: 'regex', must: item.must ?? [], mustNot: item.mustNot ?? [] })),
  det('k1', 'ticket', '退货', '用户：A1024 杯盖漏水，想退货。\n客服：退货单建好了，寄回运费店铺出。', { kind: 'ticket', value: { intent: 'return', order_id: 'A1024', needs_human: false } }),
  det('k2', 'ticket', '物流', '用户：A1031 的密封圈到哪了？\n客服：顺丰运输中，预计明天到。', { kind: 'ticket', value: { intent: 'logistics', order_id: 'A1031', needs_human: false } }),
  det('k3', 'ticket', '转人工', `用户：A1025 的热水壶不加热，签收 ${A1025_DAYS} 天了想退。\n客服：超过 7 天了，帮您转人工。`, { kind: 'ticket', value: { intent: 'return', order_id: 'A1025', needs_human: true } }),
  det('k4', 'ticket', '退款', '用户：A1024 的退款到哪一步了？\n客服：审核通过了，1–3 个工作日到账。', { kind: 'ticket', value: { intent: 'refund_status', order_id: 'A1024', needs_human: false } }),
];

/** 每个用例的请求（按调用点）。 */
export const requestOf = (item: DetCase, version: Version = 'v1'): MessagesRequest =>
  item.site === 'router' ? routerRequest(item.input) : item.site === 'ticket' ? ticketRequest(item.input) : replyRequest(item.input, version);

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const tool = (seed: number, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id: exampleId('toolu', seed), name, input }];
const openReply = (id: string, version: Version) => OPEN.find((item) => item.id === id)![version];

/** 提示 v1 下每条用例的输出（模型写的，示例）。 */
export const OUTPUTS_V1: Record<string, ContentBlock[]> = {
  c1: text('退货'),
  c2: text('换货\n'),
  c3: text('查物流。'),
  c4: text('退款进度'),
  c5: text('其他'),
  c6: text('换货'),
  t1: tool(901, 'get_order', { order_id: 'A1024' }),
  t2: tool(902, 'create_return', { order_id: 'a1024', reason: 'quality', note: '杯盖漏水' }),
  t3: tool(903, 'create_return', { order_id: 'A1024', reason: 'no_reason', note: '杯盖拧紧了还漏水' }),
  t4: tool(904, 'search_policy', { query: '退款 到账时间' }),
  t5: tool(905, 'get_order', { order_id: 'A1031' }),
  t6: text('可以的，签收 7 天内都能退。'),
  ...Object.fromEntries(OPEN.slice(0, 6).map((item) => [item.id, text(item.v1)])),
  k1: text('{"intent":"return","order_id":"A1024","needs_human":false}'),
  k2: text('```json\n{"intent":"logistics","order_id":"A1031","needs_human":false}\n```'),
  k3: text('{"intent":"return","order_id":"A1025"}'),
  k4: text('{"intent":"refund_status","order_id":"A1024","needs_human":false}'),
};

/** 提示 v2 下的输出：只改了客服回答的系统提示，意图分类和工单摘要的输出不变。 */
export const OUTPUTS_V2: Record<string, ContentBlock[]> = {
  ...OUTPUTS_V1,
  t2: tool(912, 'create_return', { order_id: 'A1024', reason: 'quality', note: '杯盖漏水' }),
  t3: tool(913, 'create_return', { order_id: 'A1024', reason: 'quality', note: '杯盖拧紧了还漏水' }),
  t4: text('支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。'),
  t6: tool(916, 'get_order', { order_id: 'A1025' }),
  ...Object.fromEntries(OPEN.slice(0, 6).map((item) => [item.id, text(openReply(item.id, 'v2'))])),
};

// ---------- 评委 ----------

export const JUDGE_MODEL = 'claude-sonnet-5-5';

export const RUBRIC: Rubric = {
  criteria: [
    { id: 'resolve', text: '解决问题：直接回应用户的问题，给出下一步', weight: 2 },
    { id: 'accurate', text: '信息准确：说法准确，不编造', weight: 2 },
    { id: 'tone', text: '语气：礼貌、不推诿', weight: 1 },
  ],
  scale: [1, 5],
};
/** 评分标准 v2（人工评估课改的）：给出店铺规则作参照、规则里没有的信息算编造、篇幅长不加分。 */
export const RUBRIC_V2_ADDED = ['判断信息准确时以下面的店铺规则为准；规则里没有的电话、链接、承诺算编造，accurate 记 1 分。', '篇幅长不加分，客套话不算解决问题。'] as const;

export const rubricLines = (version: Version): string =>
  [...RUBRIC.criteria.map((c) => `${c.id}（权重 ${c.weight}）${c.text}`), ...(version === 'v2' ? [...RUBRIC_V2_ADDED, `<rules>\n${POLICY_TEXT}\n</rules>`] : [])].join('\n');

/** 评委的提示：照 Anthropic 文档的写法，评分标准放在 <rubric>，回答放在 <answer>，要求给出具体的分数。 */
export const judgeRequest = (question: string, answer: string, version: Version = 'v1'): MessagesRequest => ({
  model: JUDGE_MODEL,
  max_tokens: 512,
  messages: [{ role: 'user', content: `给网店客服的回答打分。每项 1–5 分。\n<rubric>\n${rubricLines(version)}\n</rubric>\n<question>${question}</question>\n<answer>${answer}</answer>\n只输出 JSON：{"resolve": 分数, "accurate": 分数, "tone": 分数, "reason": "一句话理由"}` }],
});

export const pairRequest = (question: string, a: string, b: string): MessagesRequest => ({
  model: JUDGE_MODEL,
  max_tokens: 64,
  messages: [{ role: 'user', content: `比较两个网店客服的回答，哪个更好（解决问题、信息准确、语气）。\n<question>${question}</question>\n<answer_a>${a}</answer_a>\n<answer_b>${b}</answer_b>\n只输出 JSON：{"winner": "A"、"B" 或 "tie"}` }],
});

export type Triple = [resolve: number, accurate: number, tone: number];
/** 24 条回答（q1 v1、q1 v2、q2 v1……）的键。 */
export const REPLY_KEYS = OPEN.flatMap((item) => [`${item.id}v1`, `${item.id}v2`]);

/** 评委按评分标准 v1 打的分和理由（示例）。 */
export const JUDGE_V1: Record<string, [Triple, string]> = {
  q1v1: [[5, 5, 4], '说清了 7 天无理由和运费由买家承担。'],
  q1v2: [[4, 5, 4], '回答正确，简洁。'],
  q2v1: [[5, 4, 4], '直接回答了运费由谁承担。'],
  q2v2: [[3, 4, 4], '只说了质量问题的情况。'],
  q3v1: [[5, 4, 4], '给出了电话和工作时间，解决了问题。'],
  q3v2: [[4, 5, 4], '说明没有电话客服，并给出替代渠道。'],
  q4v1: [[5, 5, 4], '说明拆封不影响，条件和运费都讲了。'],
  q4v2: [[5, 5, 3], '信息完整，语气略生硬。'],
  q5v1: [[4, 5, 4], '说明超期原因并转人工。'],
  q5v2: [[5, 4, 3], '直接答应退款并说明寄回。'],
  q6v1: [[5, 5, 4], '说清了先退货后退款的顺序。'],
  q6v2: [[5, 5, 4], '流程说明清楚。'],
  q7v1: [[5, 5, 5], '核对了签收天数，说明运费并提出建退货单。'],
  q7v2: [[3, 4, 4], '结论对，但没有下一步。'],
  q8v1: [[3, 4, 4], '没说换货的条件。'],
  q8v2: [[5, 5, 4], '条件和运费都说清了。'],
  q9v1: [[5, 5, 4], '时间和顺延规则都有。'],
  q9v2: [[4, 5, 4], '简洁，少了退款去向。'],
  q10v1: [[5, 5, 5], '信息完整，语气热情周到。'],
  q10v2: [[4, 5, 3], '信息正确，略显简短。'],
  q11v1: [[5, 4, 4], '给出了换货办法。'],
  q11v2: [[5, 5, 4], '步骤清楚。'],
  q12v1: [[3, 4, 2], '要了订单号，但语气冷淡。'],
  q12v2: [[5, 5, 5], '先致歉，再给出下一步。'],
};

/** 评分标准 v2 下分数变了的回答（其余和 v1 相同，示例）。 */
export const JUDGE_V2_CHANGED: Record<string, [Triple, string]> = {
  q2v1: [[2, 1, 4], '规则写明非质量问题由买家出运费，回答说成一律店铺承担。'],
  q3v1: [[2, 1, 4], '规则里没有电话客服，号码是编造的。'],
  q5v2: [[1, 1, 3], '签收已超过 7 天和换货期限，不能直接答应退款。'],
  q10v1: [[3, 5, 2], '有用的只有一句，客套话太多。'],
  q11v1: [[2, 1, 4], '规则要求先拍照上传、确认质量问题后再寄回。'],
};

export const judgeScores = (version: Version): Record<string, [Triple, string]> => (version === 'v1' ? JUDGE_V1 : { ...JUDGE_V1, ...JUDGE_V2_CHANGED });
export const judgeReply = ([[resolve, accurate, tone], reason]: [Triple, string]): string => JSON.stringify({ resolve, accurate, tone, reason });

/** 成对比较：原顺序 v1 放 A 位、v2 放 B 位；交换后 v2 在 A 位（评委写的是位置，示例）。 */
export const PAIRWISE: Array<{ id: string; original: 'A' | 'B' | 'tie'; swapped: 'A' | 'B' | 'tie' }> = [
  { id: 'q1', original: 'A', swapped: 'B' },
  { id: 'q2', original: 'B', swapped: 'A' },
  { id: 'q3', original: 'B', swapped: 'A' },
  { id: 'q4', original: 'A', swapped: 'A' },
  { id: 'q5', original: 'A', swapped: 'B' },
  { id: 'q6', original: 'A', swapped: 'A' },
  { id: 'q7', original: 'A', swapped: 'B' },
  { id: 'q8', original: 'B', swapped: 'A' },
  { id: 'q9', original: 'tie', swapped: 'A' },
  { id: 'q10', original: 'A', swapped: 'A' },
  { id: 'q11', original: 'B', swapped: 'A' },
  { id: 'q12', original: 'B', swapped: 'B' },
];

// ---------- 人工标注 ----------

/** 三档标签，按顺序（加权 kappa 用）。 */
export const GRADES = ['差', '可接受', '好'] as const;
export type GradeLabel = (typeof GRADES)[number];
export const GRADE_SHORT: Record<GradeLabel, string> = { 差: '差', 可接受: '可', 好: '好' };
const L: Record<string, GradeLabel> = { 好: '好', 可: '可接受', 差: '差' };
const labels = (s: string): GradeLabel[] => [...s.replace(/\s/g, '')].map((c) => L[c]);

/** 三名标注员（甲、乙、丙）独立标的 24 条，顺序同 REPLY_KEYS（本站自写的示例数据）。 */
export const RATERS: Record<'甲' | '乙' | '丙', GradeLabel[]> = {
  //        q1  q2  q3  q4  q5  q6  q7  q8  q9  q10 q11 q12
  甲: labels('好好 差可 差好 好好 好差 好好 好可 可好 好可 可好 差好 可好'),
  乙: labels('好可 可可 差好 好好 好差 好好 好好 好好 好好 好好 差好 差好'),
  丙: labels('好差 差可 差好 好可 好差 好可 好可 可好 好好 差好 差好 可好'),
};
export const RATER_NAMES = ['甲', '乙', '丙'] as const;

/** 三人各不相同时，由组长按标注指南裁决（示例）。 */
export const ADJUDICATOR: Record<string, { label: GradeLabel; rule: string }> = {
  q1v2: { label: '可接受', rule: '结论对、漏了运费这类条件：可接受' },
  q10v1: { label: '可接受', rule: '信息对、客套话多：可接受，篇幅不加分也不判差' },
};

/** 裁决：三人里有两人以上相同就取多数，三人各不相同的交给组长（ADJUDICATOR）。 */
export function adjudicate(i: number): { label: GradeLabel; how: 'unanimous' | 'majority' | 'adjudicator' } {
  const votes = RATER_NAMES.map((name) => RATERS[name][i]);
  const counts = GRADES.map((g) => votes.filter((v) => v === g).length);
  const top = Math.max(...counts);
  if (top === 3) return { label: votes[0], how: 'unanimous' };
  if (top === 2) return { label: GRADES[counts.indexOf(2)], how: 'majority' };
  return { label: ADJUDICATOR[REPLY_KEYS[i]].label, how: 'adjudicator' };
}
export const ADJUDICATED: GradeLabel[] = REPLY_KEYS.map((_, i) => adjudicate(i).label);

/** 评委的加权分换成三档：≥ 0.75 好，≥ 0.5 可接受，其余差（本站定的阈值）。 */
export const GOOD_AT = 0.75;
export const OK_AT = 0.5;
export const labelOfScore = (score: number): GradeLabel => (score >= GOOD_AT ? '好' : score >= OK_AT ? '可接受' : '差');
export const tripleScores = ([resolve, accurate, tone]: Triple) => ({ resolve, accurate, tone });

// ---------- 评分（确定性评估课和回归课共用） ----------

/** strict 是第一次写的评分器；fixed 是抽查失败用例后改过的：精确匹配前去掉末尾的句号，正则把「七天」也算上。 */
export type GraderMode = 'strict' | 'fixed';
/** fixed 模式下改过的正则（键是原来的写法）。 */
export const FIXED_PATTERNS: Record<string, string> = { '7 ?天': '[7七] ?天' };
export const stripEndPunct = (s: string): string => s.replace(/[。.！!]+$/u, '');

export function gradeCase(blocks: readonly ContentBlock[], item: DetCase, mode: GraderMode = 'strict'): Grade {
  const e = item.expected;
  const said = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const call = blocks.find((b) => b.type === 'tool_use');
  switch (e.kind) {
    case 'label':
      return exactMatch(mode === 'fixed' ? stripEndPunct(normalizeAnswer(said)) : said, e.label);
    case 'regex': {
      // 先查不能出现的（违反规则的说法更要紧），再查必须出现的。
      for (const p of e.mustNot) {
        const g = regexCheck(said, p, { mustMatch: false });
        if (!g.pass) return g;
      }
      for (const p of e.must) {
        const g = regexCheck(said, mode === 'fixed' ? (FIXED_PATTERNS[p] ?? p) : p);
        if (!g.pass) return g;
      }
      return { pass: true, score: 1, reason: '该有的都有，不该有的没有' };
    }
    case 'tool':
      return toolCallCheck(call && call.type === 'tool_use' ? { name: call.name, input: call.input } : null, e.tool);
    case 'ticket': {
      const s = schemaCheck(said, TICKET_SCHEMA);
      if (!s.pass) return s;
      const v = JSON.parse(said) as Record<string, unknown>;
      const intent = exactMatch(String(v.intent), e.value.intent);
      if (!intent.pass) return { ...intent, reason: `intent ${intent.reason}` };
      if (v.order_id !== e.value.order_id) return { pass: false, score: 0, reason: `order_id 应为 ${e.value.order_id}` };
      if (v.needs_human !== e.value.needs_human) return { pass: false, score: 0, reason: `needs_human 应为 ${e.value.needs_human}` };
      return { pass: true, score: 1, reason: '符合 schema，字段值都对' };
    }
  }
}
