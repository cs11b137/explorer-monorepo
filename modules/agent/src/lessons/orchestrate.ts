/**
 * 多 Agent 组第一课：编排者与子 Agent。用户问「A1024 杯盖漏水，能退吗？退款多久到账？」，
 * 编排者不自己查，而是把两件事交给两个子 Agent：订单子 Agent 查订单和签收日期，规则子 Agent 查售后和退款规则。
 *
 * 子 Agent 由 core/loop.ts 的 agentTool 包成工具：编排者的 tool_use 只带一段 task 文字，子 Agent 从这段文字开始，
 * 在自己干净的上下文里跑完一整个循环（自己的 system、工具、messages、轮数和 token），只把最后一句结论作为 tool_result 交回。
 * 全部由 runAgent 真实执行；为了对照，同一个问题再交给一个单 Agent 跑一遍（get_order 和 search_policy 一轮并行调用），
 * 两边的账都是真算的。模型每轮写的话是脚本（E.G.）。tests/narrative.multi.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  agentTool,
  createShop,
  daysBetween,
  encodeJson,
  EXAMPLE_API_KEY,
  formatUsd,
  grandTotals,
  ORDER_ID,
  outputTokensOf,
  PRICE_DATE,
  QUALITY_RETURN_DAYS,
  runAgent,
  shopToolBox,
  text,
  TODAY,
  ToolBox,
  toolUse,
  type AgentConfig,
  type AgentRun,
  type AgentTurn,
  type MessageParam,
  type Order,
  type PolicyHit,
  type ScriptStep,
  type ToolCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { blocksOf, fixedTokens, historyRow, type BlockCell } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { dateText, MODEL } from './scenario';
import type { DsCell, DsFrame, GridPrim, Lesson, LessonEvent, NodeId, Prim } from './types';

// ---------- 场景 ----------

export const ASK = `订单 ${ORDER_ID} 的保温杯杯盖漏水，能退吗？退款多久到账？`;
export const POLICY_QUERY = '质量问题 退款 到账';

/** 订单子 Agent：只有 get_order。 */
export const ORDER_AGENT: AgentConfig = { name: 'order_agent', model: MODEL, system: '你是订单查询子 Agent。只查订单和物流，用一两句话交回结论，不回答订单以外的问题。', tools: shopToolBox(['get_order']) };
/** 规则子 Agent：只有 search_policy。 */
export const POLICY_AGENT: AgentConfig = { name: 'policy_agent', model: MODEL, system: '你是售后规则子 Agent。只查店铺规则，交回和任务相关的条款编号和要点，不编造规则。', tools: shopToolBox(['search_policy']) };

const ORDER_SCRIPT: ScriptStep[] = [
  [text(`查订单 ${ORDER_ID}。`), toolUse('get_order', { order_id: ORDER_ID }, 11)],
  ({ lastCalls }) => {
    const order = lastCalls[0].outcome.data as Order;
    return [text(`${order.order_id}：${order.item}，实付 ${order.amount} 元，${order.carrier}，${dateText(order.signed_at!)}签收，到今天 ${daysBetween(order.signed_at!, TODAY)} 天。`)];
  },
];

const POLICY_SCRIPT: ScriptStep[] = [
  [text('查质量问题退款和到账时间的规则。'), toolUse('search_policy', { query: POLICY_QUERY, top_k: 3 }, 21)],
  ({ lastCalls }) => {
    const hits = lastCalls[0].outcome.data as PolicyHit[];
    return [text(`相关条款 ${hits.map((hit) => hit.id).join('、')}。签收 ${QUALITY_RETURN_DAYS} 天内质量问题可退款，运费店铺出；退款原路退回，支付宝 1–3 个工作日，银行卡 3–7 个工作日。`)];
  },
];

export const ORDER_TASK = `查订单 ${ORDER_ID} 的商品、实付金额和签收日期，算出到今天签收了几天。`;
export const POLICY_TASK = '查质量问题退款的期限、寄回运费谁出、退款多久到账。';

/** 编排者：工具就是两个子 Agent（agentTool 包成的，参数只有 task）。 */
export const LEAD: AgentConfig = {
  name: 'lead',
  model: MODEL,
  system: '你是「小铺」客服的编排者。查询交给子 Agent，根据它们交回的结论回答用户，不自己查。',
  tools: new ToolBox([
    agentTool('ask_order', '交给订单子 Agent：查订单、物流和签收日期。task 里写清要交回什么。', ORDER_AGENT, ORDER_SCRIPT, { seed: 200 }),
    agentTool('ask_policy', '交给规则子 Agent：查售后、退款、运费规则。task 里写清要交回什么。', POLICY_AGENT, POLICY_SCRIPT, { seed: 300 }),
  ]),
};

/** 回答（示例）：天数、到账时间来自结论，结论又来自子 Agent 的真实工具结果。单 Agent 对照用同一句回答。 */
const answerFrom = (order: Order) => {
  const days = daysBetween(order.signed_at!, TODAY);
  return [text(`可以退。订单 ${dateText(order.signed_at!)}签收，到今天 ${days} 天，在 ${QUALITY_RETURN_DAYS} 天之内；杯盖漏水是质量问题，可以退款，寄回运费由店铺承担。退款原路退回，支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。需要的话我帮您建退货单。`)];
};

const LEAD_SCRIPT: ScriptStep[] = [
  [text('拆成两件事：查订单，查规则，交给两个子 Agent。'), toolUse('ask_order', { task: ORDER_TASK }, 1), toolUse('ask_policy', { task: POLICY_TASK }, 2)],
  ({ calls }) => answerFrom(calls[0].outcome.child!.turns[0].calls[0].outcome.data as Order),
];

// ---------- 真实运行 ----------

export const shop = createShop();
export const run = runAgent(LEAD, ASK, LEAD_SCRIPT, { ctx: { shop }, seed: 100 });
export const [orderRun, policyRun] = run.children as [AgentRun, AgentRun];
export const [l1, l2] = run.turns as [AgentTurn, AgentTurn];
export const [o1, o2] = orderRun.turns as [AgentTurn, AgentTurn];
export const [p1, p2] = policyRun.turns as [AgentTurn, AgentTurn];
export const total = grandTotals(run);

/** 对照：同一个问题交给一个单 Agent（get_order 和 search_policy 在同一轮并行调用），也真实跑一遍。 */
export const SINGLE: AgentConfig = { name: 'support', model: MODEL, system: '你是「小铺」网店的客服 Agent。先用工具查订单和店铺规则再回答，查不到就说不知道。', tools: shopToolBox(['get_order', 'search_policy']) };
export const single = runAgent(SINGLE, ASK, [
  [text('查订单，再查规则。'), toolUse('get_order', { order_id: ORDER_ID }, 1), toolUse('search_policy', { query: POLICY_QUERY, top_k: 3 }, 2)],
  ({ calls }) => answerFrom(calls[0].outcome.data as Order),
], { ctx: { shop: createShop() }, seed: 400 });

/** 轨迹表的输入列：编排者和两个子 Agent 的每一轮，按发生的先后相加。 */
const ORDERED: AgentTurn[] = [l1, o1, o2, p1, p2, l2];
const cumBefore = (turn: AgentTurn): number => ORDERED.slice(0, ORDERED.indexOf(turn)).reduce((sum, t) => sum + t.message.usage.input_tokens, 0);
const cumAfter = (turn: AgentTurn): number => cumBefore(turn) + turn.message.usage.input_tokens;

// ---------- 文案用到的数 ----------

const order = o1.calls[0].outcome.data as Order;
export const hits = p1.calls[0].outcome.data as PolicyHit[];
const resultTokens = (turn: AgentTurn, index: number) => turn.breakdown.messages[index];
/** 某个内容块在一轮请求展开后的 token 数。 */
const pieceTokens = (turn: AgentTurn, source: string) => turn.breakdown.prompt.pieces.filter((piece) => piece.kind === 'content' && piece.source === source).reduce((sum, piece) => sum + piece.tokens, 0);

export const numbers = {
  modelCalls: total.turns,
  leadTurns: run.totals.turns,
  childTurns: [orderRun.totals.turns, policyRun.totals.turns],
  inputs: ORDERED.map((turn) => turn.message.usage.input_tokens),
  cumulative: ORDERED.map(cumAfter),
  leadInput: run.totals.input,
  orderInput: orderRun.totals.input,
  policyInput: policyRun.totals.input,
  totalInput: total.input,
  totalOutput: total.output,
  cost: formatUsd(total.cost),
  singleTurns: single.totals.turns,
  singleInput: single.totals.input,
  singleOutput: single.totals.output,
  singleCost: formatUsd(single.totals.cost),
  ratio: +(total.input / single.totals.input).toFixed(1),
  /** 编排者第 1 轮的 tool_use：两段 task 的 token（第 1 轮输出里） */
  taskTokens: l1.message.content.slice(1).map((block) => outputTokensOf(block)),
  /** 子 Agent 第 1 轮请求里 messages[0]（task）的 token。 */
  childTask: [o1.breakdown.messages[0], p1.breakdown.messages[0]],
  /** 子 Agent 的工具结果（原始订单 JSON、三段规则原文）在子 Agent 上下文里的 token。 */
  childRaw: [resultTokens(o2, 2), resultTokens(p2, 2)],
  /** 交回编排者的结论在编排者第 2 轮请求里的 token（tool_result）。 */
  summaries: [pieceTokens(l2, 'messages[2].content[0]'), pieceTokens(l2, 'messages[2].content[1]')],
  /** 编排者第 2 轮里两段结论合计；单 Agent 第 2 轮里两个原始结果合计。 */
  leadResults: resultTokens(l2, 2),
  singleResults: resultTokens(single.turns[1], 2),
  leadLast: l2.message.usage.input_tokens,
  singleLast: single.turns[1].message.usage.input_tokens,
  childPeak: [o2.message.usage.input_tokens, p2.message.usage.input_tokens],
  leadMessages: l2.request.messages.length,
  childMessages: [orderRun.messages.length, policyRun.messages.length],
  /** 每个 Agent 每轮都重带的 system + 工具定义 + 工具系统提示。 */
  fixed: [fixedTokens(l1), fixedTokens(o1), fixedTokens(p1)],
  fixedAll: ORDERED.reduce((sum, turn) => sum + fixedTokens(turn), 0),
  singleFixedAll: single.turns.reduce((sum, turn) => sum + fixedTokens(turn), 0),
  toolSystem: l1.toolSystem,
  leadTools: l1.breakdown.tools,
  days: daysBetween(order.signed_at!, TODAY),
  hitIds: hits.map((hit) => hit.id),
  extraInput: total.input - single.totals.input,
};
const N = numbers;

// ---------- 画图 ----------

/** 一次运行在某一刻的历史画成格子：token 数取自包含它的那一轮请求；最后一条回答按输出 token 数。 */
function blocksAt(r: AgentRun, messages: MessageParam[]): BlockCell[] {
  const next = r.turns.find((turn) => turn.request.messages.length >= messages.length);
  const last = r.turns[r.turns.length - 1];
  const extra = next ? {} : { [r.messages.length - 1]: last.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? last).breakdown.prompt, extra);
}
const afterReply = (r: AgentRun, turn: AgentTurn): MessageParam[] => r.messages.slice(0, turn.request.messages.length + 1);
const afterResults = (r: AgentRun, turn: AgentTurn): MessageParam[] => r.messages.slice(0, turn.request.messages.length + 2);
const liftLast = (r: AgentRun, messages: MessageParam[], n: number) => {
  const count = blocksAt(r, messages).length;
  return Array.from({ length: n }, (_, i) => count - n + i);
};

const leadRow = (messages: MessageParam[], lift: number[] = []) => historyRow('h', blocksAt(run, messages), { w: 46, lift, title: '编排者' });
const childRows = (orderMsgs: MessageParam[] | null, policyMsgs: MessageParam[] | null, lift: { order?: number[]; policy?: number[] } = {}) => [
  { ...historyRow('co', orderMsgs ? blocksAt(orderRun, orderMsgs) : [], { w: 46, lift: lift.order, title: '订单子 Agent' }), at: [0, -50] as [number, number] },
  { ...historyRow('cp', policyMsgs ? blocksAt(policyRun, policyMsgs) : [], { w: 46, lift: lift.policy, title: '规则子 Agent' }), at: [0, 50] as [number, number] },
];

/** 账：每个 Agent 一行（输入、输出 token），然后是合计和单 Agent 的对照。没跑到的行留空。 */
function ledger(done: { order?: boolean; policy?: boolean; lead?: 1 | 2; single?: boolean }): GridPrim {
  const row = (totals: { input: number; output: number } | null, tone: DsCell['tone'], out: DsCell['tone'] = 'green'): DsCell[] =>
    totals ? [{ v: String(totals.input), tone }, { v: String(totals.output), tone: out }] : [{ v: '' }, { v: '' }];
  const leadTotals = done.lead === 2 ? run.totals : done.lead === 1 ? l1.after : null;
  const all = done.lead === 2 && done.single ? total : null;
  return {
    kind: 'grid',
    id: 'u',
    w: 48,
    rows: ['编排者', '订单', '规则', '合计', '单 Agent'],
    cols: ['输入', '输出'],
    cells: [row(leadTotals, 'blue'), row(done.order ? orderRun.totals : null, 'blue'), row(done.policy ? policyRun.totals : null, 'blue'), row(all, 'head', 'head'), row(done.single ? single.totals : null, 'violet', 'violet')],
  };
}

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const WHO: Record<string, string> = { lead: '编排者', order_agent: '订单子 Agent', policy_agent: '规则子 Agent' };
/** 名字后面接汉字时，拉丁字母结尾的名字补一个空格（「订单子 Agent 的」）。 */
const sp = (name: string): string => (/[A-Za-z]$/.test(name) ? `${name} ` : name);

function requestWire(turn: AgentTurn, expand: string[], notes: Record<string, string>) {
  return wire(`${sp(WHO[turn.agent])}第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'], notes: { 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_API_KEY.length} 个字符，这里打码）。` } }),
    jsonBody('请求体', encodeJson(turn.request), {
      expand,
      notes: {
        system: `${sp(WHO[turn.agent])}自己的 system，${turn.breakdown.system} 个 token。`,
        tools: `${turn.request.tools!.map((tool) => tool.name).join('、')}：展开后 ${turn.breakdown.tools} 个 token，另加工具系统提示 ${turn.toolSystem}。`,
        messages: `${sp(WHO[turn.agent])}自己的消息历史，${turn.request.messages.length} 条。`,
        ...notes,
      },
    }));
}

function responseWire(turn: AgentTurn, notes: Record<string, string>) {
  const blocks = turn.message.content.map((_, i) => `content[${i}]`);
  return wire(`${sp(WHO[turn.agent])}第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), {
      expand: [...blocks, 'usage.input_tokens', 'usage.output_tokens'],
      example: ['id', 'content', ...blocks, 'usage', 'usage.input_tokens', 'usage.output_tokens'],
      notes: {
        stop_reason: turn.message.stop_reason === 'tool_use' ? 'tool_use：要调用工具，循环继续。' : 'end_turn：说完了，这个 Agent 的循环停下。',
        'usage.input_tokens': `本站分词器的计数加上工具系统提示 ${turn.toolSystem}（示例）。`,
        ...notes,
      },
    }));
}

const AT: Record<string, NodeId> = { lead: 'agent', order_agent: 'subagent', policy_agent: 'subagent2' };

/** 一轮模型调用：请求出去、响应回来。输入列按整课的先后顺序累计。 */
function roundTrip(r: AgentRun, turn: AgentTurn, label: string, payload: string[], requestNotes: Record<string, string>, responseNotes: Record<string, string>, ds: (reply: MessageParam[]) => DsFrame): LessonEvent[] {
  const at = AT[turn.agent];
  const n = turn.request.messages.length;
  const expand = n === 1 ? ['messages[0]'] : [`messages[${n - 1}]`];
  const reply = afterReply(r, turn);
  return [
    pk(at, 'llm', 'blue', `${sp(WHO[turn.agent])}第 ${turn.index} 轮`, [`${n} 条消息`, `${num(turn.http.request.bytes.length)} 字节`], [cumBefore(turn), 'HTTP', `${sp(WHO[turn.agent])}的第 ${turn.index} 轮请求：自己的 system、${turn.request.tools!.length} 个工具、${n} 条消息`, turn.http.request.bytes.length], requestWire(turn, expand, requestNotes)),
    pk('llm', at, 'green', label, payload, [cumAfter(turn), 'INFER', `stop_reason ${turn.message.stop_reason}：输入 ${num(turn.message.usage.input_tokens)}、输出 ${turn.message.usage.output_tokens} token`, turn.http.response.bytes.length], responseWire(turn, responseNotes), { ds: ds(reply) }),
  ];
}

const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;
const firstText = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');
const callOf = (turn: AgentTurn, index = 0): ToolCall => turn.calls[index];

const orderJson = encodeJson(order);
const hitsJson = encodeJson(hits.map((hit) => ({ id: hit.id, score: +hit.score.toFixed(3) })));
const delegateWire = (c: ToolCall, child: AgentRun, who: string) =>
  wire(`交给${who}`, 'mem', 'format',
    jsonBody('编排者的 tool_use 块', encodeJson(c.use), { example: ['id', 'input'], expand: ['input.task'], notes: { name: `agentTool 包成的工具：执行它就是跑一个${who}。`, 'input.task': '交给子 Agent 的全部东西就是这段文字（示例）。' } }),
    jsonBody(`${sp(who)}的 messages[0]`, encodeJson(child.messages[0]), { notes: { content: 'task 原样成为子 Agent 的第一条 user 消息；它看不到用户的原话和编排者的历史。' } }));
const returnWire = (c: ToolCall, who: string, raw: number) =>
  wire(`${sp(who)}交回`, 'mem', 'format',
    jsonBody('交回编排者的 tool_result 块', encodeJson(c.result), { example: ['content'], notes: { tool_use_id: `对回编排者的 tool_use：${c.use.id}。`, content: `子 Agent 最后一条回答的文字（示例）。它读过的原始工具结果（${raw} token）留在它自己的上下文里。` } }),
    concept(`${sp(who)}的这次运行`, [['轮数', `${c.outcome.child!.totals.turns}`], ['stop', c.outcome.child!.stop], ['输入', num(c.outcome.child!.totals.input), '两轮 usage.input_tokens 之和。'], ['输出', num(c.outcome.child!.totals.output)]]));

// ---------- 事件 ----------

const leadAfterReply = afterReply(run, l1);
const oCall = callOf(l1, 0);
const pCall = callOf(l1, 1);

function childSteps(r: AgentRun, at: NodeId, store: NodeId, t1: AgentTurn, t2: AgentTurn, delegate: ToolCall, who: string, rows: (m: MessageParam[] | null, lift?: number[]) => Prim[], query: { label: string; payload: string[]; info: string; size: number; wire: ReturnType<typeof wire> }, back: { label: string; payload: string[]; info: string; size: number; wire: ReturnType<typeof wire> }, leadAfter: MessageParam[], ledgerDone: Parameters<typeof ledger>[0]): LessonEvent[] {
  const c = callOf(t1);
  const first = [r.messages[0]];
  return [
    pk('agent', at, 'amber', `交给${who}`, [preview(String(delegate.use.input.task), 16)], [cumBefore(t1), 'DELEGATE', `执行 ${delegate.use.name}：task 成为${sp(who)}的第一条 user 消息`, encodeJson(delegate.use).bytes.length], delegateWire(delegate, r, who), { ds: { tasks: rows(first) } }),
    ...roundTrip(r, t1, `tool_use: ${c.use.name}`, [`想法：${preview(firstText(t1), 10)}`, c.use.name], { 'messages[0]': '只有 task 这一条。' }, { 'content[1]': `行动（示例）：调用 ${c.use.name}。` }, (reply) => ({ tasks: rows(reply, liftLast(r, reply, t1.message.content.length)) })),
    pk(at, store, 'amber', query.label, query.payload, [cumAfter(t1), 'TOOL', query.info, query.size], query.wire),
    pk(store, at, 'teal', back.label, back.payload, [cumAfter(t1), 'RESULT', back.info, back.size], back.wire, { ds: { tasks: rows(afterResults(r, t1), liftLast(r, afterResults(r, t1), 1)) } }),
    ...roundTrip(r, t2, 'end_turn：结论', [preview(r.final, 14)], {}, { 'content[0]': '结论（示例）：日期、金额、条款编号都来自工具结果。' }, (reply) => ({ tasks: rows(reply, liftLast(r, reply, 1)) })),
    state(at, { 轮次: `${r.totals.turns}`, stop_reason: r.stop, 输入: `${num(r.totals.input)} token` }),
    pk(at, 'agent', 'teal', `${sp(who)}的结论`, [preview(r.final, 14), `${outputTokensOf(t2.message.content[0])} token`], [cumAfter(t2), 'RESULT', `只有最后的回答作为 ${delegate.use.name} 的 tool_result 交回`, encodeJson(delegate.result).bytes.length], returnWire(delegate, who, resultTokens(t2, 2)), { ds: { messages: [leadRow(leadAfter, liftLast(run, leadAfter, 1))], usage: [ledger(ledgerDone)] } }),
  ];
}

const orderRows = (m: MessageParam[] | null, lift?: number[]) => childRows(m, null, { order: lift });
const policyRows = (m: MessageParam[] | null, lift?: number[]) => childRows(orderRun.messages, m, { policy: lift });

/** 编排者此刻的历史：第 1 轮的回复，加上已经交回的 tool_result（第 2 轮请求里的 user 消息逐块出现）。 */
const leadWith = (results: number): MessageParam[] => {
  const user = run.messages[2] as { role: 'user'; content: unknown[] };
  return results === 0 ? leadAfterReply : [...leadAfterReply, { ...user, content: user.content.slice(0, results) } as MessageParam];
};

const answer = run.final;

export const orchestrate: Lesson = {
  id: 'orchestrate',
  name: 'ORCHESTRATE',
  title: '编排者与子 Agent',
  group: 'multi',
  layer: [5, 6],
  layerNote: '这课在「循环」和「编排」两档：编排者和每个子 Agent 各跑一个循环，编排者决定把哪件事交给谁、怎样汇总。',
  tokensNote: `编排者和两个子 Agent 一共 ${N.modelCalls} 轮模型调用，按发生的先后把每轮的 usage.input_tokens 相加，累计 ${num(N.totalInput)}。`,
  nodes: ['app', 'agent', 'llm', 'subagent', 'subagent2', 'db', 'policy', 'messages', 'tasks', 'usage'],
  place: { app: [90, 150], llm: [560, 90], agent: [330, 390], subagent: [820, 330], subagent2: [680, 600], db: [1090, 330], policy: [1020, 620], usage: [80, 610], messages: [490, 880], tasks: [930, 850] },
  labels: {
    app: ['应用界面', '客服对话框'],
    agent: ['编排者', '拆任务、汇总结论'],
    llm: ['模型', MODEL],
    subagent: ['订单子 Agent', '只有 get_order'],
    subagent2: ['规则子 Agent', '只有 search_policy'],
    db: ['订单库', '订单记录'],
    policy: ['规则库', 'BM25 检索'],
    messages: ['编排者的上下文', '每格一个内容块的 token'],
    tasks: ['子 Agent 的上下文', '各自从 task 开始'],
    usage: ['账', '每个 Agent 的 token'],
  },
  labelAt: { messages: [-270, 40], tasks: [200, 150], usage: [0, 150] },
  radius: { messages: 70, tasks: 90, usage: 80 },
  initial: { messages: [], tasks: [], usage: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '用户的话、子任务'], ['green', '模型写的想法、结论和回答'], ['amber', '委派和工具调用'], ['teal', '工具结果和交回的结论'], [null, '输入列：三个 Agent 累计读入的 token']],
  overview: {
    full: '编排者把任务拆给子 Agent，只收结论',
    description: `一个 Agent 也能把事分出去：编排者（orchestrator）的工具不是查订单、查规则，而是两个子 Agent。它把「查订单」「查规则」写成两段 task 交出去，每个子 Agent 在自己干净的上下文里跑完一个循环，只交回一两句结论，编排者据此回答用户。这一课把消息怎样流动、谁看到了什么、一共花了多少 token 逐轮算出来，再和一个单 Agent 做同一件事对照：${N.modelCalls} 轮模型调用累计输入 ${num(N.totalInput)}，单 Agent ${N.singleTurns} 轮 ${num(N.singleInput)}。`,
    facts: [
      ['任务', 'A1024 杯盖漏水：能退吗、多久到账'],
      ['编排者的工具', 'ask_order、ask_policy（子 Agent）'],
      ['模型调用', `编排者 ${N.leadTurns} 轮 + 子 Agent 各 2 轮 = ${N.modelCalls} 轮`],
      ['累计输入', `${num(N.totalInput)} token（单 Agent ${num(N.singleInput)}）`],
      ['费用', `${N.cost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '编排者拆任务：工具就是子 Agent',
      desc: `一轮写出两个 tool_use，各带一段 task`,
      detail: `编排者的两个工具 ask_order、ask_policy 是 agentTool 包成的子 Agent，参数只有一个 task 字符串，定义展开后 ${N.leadTools} 个 token。第 1 轮输入 ${num(N.inputs[0])} 个 token，模型写下${quote(firstText(l1))}，在同一轮里写了两个 tool_use，把两段 task 分别交给订单子 Agent 和规则子 Agent。task 是编排者交出去的全部东西：子 Agent 看不到用户的原话、编排者的 system 和历史，Claude Agent SDK 的文档也是这样说的（父 Agent 传给子 Agent 的只有 Agent 工具的 prompt 字符串）。`,
      facts: [['输入', `${num(N.inputs[0])} token`], ['输出', `${l1.message.usage.output_tokens} token，含两段 task`], ['工具', 'ask_order、ask_policy'], ['stop_reason', 'tool_use']],
      events: [
        type('A1024 杯盖漏水，能退吗'),
        pk('app', 'agent', 'blue', '用户的问题', [preview(ASK, 18)], [0, 'CALL', '用户的话交给编排者，作为它的第一条 user 消息', utf8Encode(ASK).length], wire('用户的话', 'mem', 'format', utf8Lines('content', ASK, { summary: `UTF-8 ${utf8Encode(ASK).length} 字节，只进编排者的 messages[0]` })), { ds: { messages: [leadRow([run.messages[0]])] } }),
        show('messages', 'usage'),
        ...roundTrip(run, l1, 'tool_use × 2', ['ask_order(task)', 'ask_policy(task)'], { 'messages[0]': '用户的问题。' }, { 'content[1]': `交给订单子 Agent 的 task（示例）。`, 'content[2]': '交给规则子 Agent 的 task（示例）。' }, (reply) => ({ messages: [leadRow(reply, liftLast(run, reply, 3))], usage: [ledger({ lead: 1 })] })),
        note('agent', '两个 tool_use，交给两个子 Agent'),
      ],
    },
    {
      title: '订单子 Agent：从 task 开始的新循环',
      desc: `自己的 system、1 个工具、${N.childMessages[0]} 条消息`,
      detail: `执行 ask_order 就是跑一个新的循环：子 Agent 的 messages 只有 task 这一条（${N.childTask[0]} 个 token），配上它自己的 system 和 get_order，第 1 轮输入 ${num(N.inputs[1])}。它查到订单，原始的订单 JSON（${N.childRaw[0]} 个 token）只留在它自己的上下文里，第 2 轮写下结论${quote(orderRun.final)}，stop_reason 是 end_turn。这句结论就是 ask_order 的 tool_result，编排者的历史里多了它，别的什么都没多。`,
      facts: [['子 Agent 轮数', `${N.childTurns[0]}`], ['子 Agent 输入', `${num(N.orderInput)} token`], ['原始订单 JSON', `${N.childRaw[0]} token，留在子 Agent 里`], ['交回', `${N.summaries[0]} token 的结论`]],
      events: [
        show('subagent', 'db', 'tasks'),
        ...childSteps(orderRun, 'subagent', 'db', o1, o2, oCall, '订单子 Agent', orderRows,
          { label: `查订单 ${ORDER_ID}`, payload: ['orders.get("A1024")'], info: '子 Agent 的运行时执行 get_order，在内存订单表里查', size: utf8Encode(ORDER_ID).length, wire: wire('查询的键', 'mem', 'internal', utf8Lines('order_id', ORDER_ID, { summary: '本站的订单表是内存里的 Map' })) },
          { label: '订单记录', payload: [order.item, `签收 ${order.signed_at}`], info: `订单 JSON 装进 tool_result，回到子 Agent 的历史`, size: orderJson.bytes.length, wire: wire('订单记录（本站的示例数据）', 'mem', 'internal', jsonBody('order', orderJson, { notes: { signed_at: '签收日期：子 Agent 用它算天数。' } })) },
          leadWith(1), { lead: 1, order: true }),
      ],
    },
    {
      title: '规则子 Agent：同样只交回结论',
      desc: `三段规则原文留在它自己的上下文里`,
      detail: `ask_policy 的 task 成为规则子 Agent 的第一条消息，它用 BM25 取了前 ${hits.length} 段规则（${N.hitIds.join('、')}），原文 ${N.childRaw[1]} 个 token，读完写下 ${N.summaries[1]} 个 token 的结论。两个子 Agent 的上下文互不相通，各自最大的一轮输入是 ${num(N.childPeak[0])} 和 ${num(N.childPeak[1])}。Claude Agent SDK 的子 Agent 可以并发执行，本站的循环按 tool_use 的顺序一个个跑，结果相同。`,
      facts: [['子 Agent 轮数', `${N.childTurns[1]}`], ['子 Agent 输入', `${num(N.policyInput)} token`], ['三段规则原文', `${N.childRaw[1]} token，留在子 Agent 里`], ['交回', `${N.summaries[1]} token 的结论`]],
      events: [
        show('subagent2', 'policy'),
        ...childSteps(policyRun, 'subagent2', 'policy', p1, p2, pCall, '规则子 Agent', policyRows,
          { label: 'BM25 检索', payload: [`query: ${POLICY_QUERY}`, 'top_k: 3'], info: `子 Agent 的运行时执行 search_policy，给规则打分`, size: utf8Encode(POLICY_QUERY).length, wire: wire('查询词', 'mem', 'format', utf8Lines('query', POLICY_QUERY)) },
          { label: `前 ${hits.length} 段`, payload: hits.map((hit) => `${hit.id} ${hit.score.toFixed(2)}`), info: `${hits[0].id} 得分最高，三段原文交回子 Agent`, size: hitsJson.bytes.length, wire: wire('BM25 的前三段（本站的检索结果）', 'mem', 'internal', jsonBody('hits', hitsJson), concept('分数从高到低', hits.map((hit): [string, string, string] => [hit.id, hit.score.toFixed(3), hit.text]))) },
          leadWith(2), { lead: 1, order: true, policy: true }),
      ],
    },
    {
      title: '编排者汇总，回答用户',
      desc: `第 2 轮只读两段结论：${N.leadResults} token`,
      detail: `编排者第 2 轮的请求有 ${N.leadMessages} 条消息，两个 tool_result 放在同一条 user 消息里，合起来只有 ${N.leadResults} 个 token；单 Agent 做同一件事时，这个位置是原始的订单 JSON 和三段规则，${N.singleResults} 个 token。所以编排者这一轮输入 ${num(N.leadLast)}，比单 Agent 的第 2 轮（${num(N.singleLast)}）少。它据此写出回答，stop_reason 是 end_turn，回答直接交给用户，子 Agent 不和用户说话。`,
      facts: [['输入', `${num(N.leadLast)} token`], ['两段结论', `${N.leadResults} token`], ['单 Agent 的原始结果', `${N.singleResults} token`], ['stop_reason', 'end_turn']],
      events: [
        ...roundTrip(run, l2, 'end_turn：回答', [preview(answer, 16)], { 'messages[2]': '两个子 Agent 的结论，同一条 user 消息里的两个 tool_result。' }, { 'content[0]': '回答（示例）：天数、到账时间来自两段结论。' }, (reply) => ({ messages: [leadRow(reply, liftLast(run, reply, 1))], usage: [ledger({ lead: 2, order: true, policy: true })] })),
        pk('agent', 'app', 'green', '回答', [preview(answer, 18)], [cumAfter(l2), 'STOP', '编排者 stop_reason 是 end_turn，回答交给界面', utf8Encode(answer).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', answer, { summary: '编排者最后一条助手消息的 text 块（示例）' }))),
        render,
      ],
    },
    {
      title: '总账：上下文变小，总量变多',
      desc: `${N.modelCalls} 轮累计 ${num(N.totalInput)}，单 Agent ${num(N.singleInput)}`,
      detail: `三个 Agent ${N.modelCalls} 轮累计输入 ${num(N.totalInput)}、输出 ${num(N.totalOutput)} token，按示例单价 ${N.cost}；单 Agent 同样查完只要 ${N.singleTurns} 轮、${num(N.singleInput)} 个输入 token（${N.singleCost}），编排的方式是它的 ${N.ratio} 倍。多出来的主要是每个 Agent 每轮都要重带的 system、工具定义和工具系统提示：${N.modelCalls} 轮共 ${num(N.fixedAll)} 个，单 Agent 只有 ${num(N.singleFixedAll)}。CONTEXT EXPLORER 的上下文隔离课算过同一笔账，编排换来的是每个上下文都小而专一、子任务可以并发，不是省 token。`,
      facts: [['多 Agent', `${N.modelCalls} 轮，${num(N.totalInput)} token，${N.cost}`], ['单 Agent', `${N.singleTurns} 轮，${num(N.singleInput)} token，${N.singleCost}`], ['倍数', `${N.ratio} 倍`], ['固定部分', `${num(N.fixedAll)} 对 ${num(N.singleFixedAll)}`]],
      events: [
        pk('agent', 'usage', 'slate', '记总账', [`${N.modelCalls} 轮`, `输入 ${num(N.totalInput)}`], [cumAfter(l2), 'TOKENS', `grandTotals：编排者加上两个子 Agent；另跑一遍单 Agent 对照`, null], wire('总账', 'mem', '示意', concept('grandTotals(run)', [
          ['编排者', `${N.leadTurns} 轮，输入 ${num(N.leadInput)}`, `每轮固定部分 ${N.fixed[0]}（system + 两个子 Agent 工具 + 工具系统提示 ${N.toolSystem}）。`],
          ['订单子 Agent', `${N.childTurns[0]} 轮，输入 ${num(N.orderInput)}`, `每轮固定部分 ${N.fixed[1]}。`],
          ['规则子 Agent', `${N.childTurns[1]} 轮，输入 ${num(N.policyInput)}`, `每轮固定部分 ${N.fixed[2]}。`],
          ['合计', `${N.modelCalls} 轮，输入 ${num(N.totalInput)}，输出 ${num(N.totalOutput)}`, `示例单价，${PRICE_DATE}：${N.cost}。`],
          ['单 Agent 对照', `${N.singleTurns} 轮，输入 ${num(N.singleInput)}，输出 ${num(N.singleOutput)}`, `get_order 和 search_policy 在同一轮里并行调用：${N.singleCost}。`],
        ])), { ds: { usage: [ledger({ lead: 2, order: true, policy: true, single: true })] } }),
        note('usage', `多 Agent 是单 Agent 的 ${N.ratio} 倍`, 'amber'),
        note('messages', `编排者最后一轮 ${num(N.leadLast)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '编排者只收结论，账要合起来算',
    desc: `${N.modelCalls} 轮、${num(N.totalInput)} token、${N.cost}`,
    text: `子 Agent 是一个被包成工具的循环：编排者写一段 task 交出去，子 Agent 在干净的上下文里查完，只把结论交回，原始的订单 JSON 和规则原文都不进编排者的上下文。控制权始终在编排者手里，回答用户的也是它；Claude Agent SDK 经 Agent 工具（旧名 Task）调用子 Agent，OpenAI Agents SDK 的同类写法是 agent.as_tool()。代价是每个 Agent 每轮都要重带自己的 system 和工具定义：这次 ${N.modelCalls} 轮累计输入 ${num(N.totalInput)}，是单 Agent 的 ${N.ratio} 倍；子任务越大、原始资料越多，隔离省下的才越可能超过这份固定开销。本站的 token 数是迷你分词器的计数，只代表量级关系。下一课看另一种协作：不是派活再收结论，而是把整个对话转交给另一个 Agent。`,
    facts: [['模型调用', `${N.modelCalls} 轮（编排者 ${N.leadTurns}）`], ['累计输入', `${num(N.totalInput)} token`], ['单 Agent', `${num(N.singleInput)} token`], ['下一课', 'Agent 间转交（handoff）']],
  },
};
