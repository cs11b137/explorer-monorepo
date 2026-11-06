/**
 * 多 Agent 组第二课：Agent 间转交（handoff）。用户说「杯盖漏水，想退货」，分诊 Agent 先查订单，确认是退货，
 * 调用 transfer_to_returns 把整个对话转交给退货专员；之后的轮次换成退货专员的 system 和工具，历史一条不少地带过去，
 * 由退货专员查规则、建退货单、直接回答用户。
 *
 * 转交由 core/loop.ts 的 handoffTool 和 runAgent 的 agents 选项真实执行：转交工具执行成功后，循环在下一轮换成目标 Agent 的配置，
 * 请求里的 messages 是同一份历史（runAgent 不做过滤）。带过去的历史有多少 token、换了 system 和工具之后每轮固定部分变成多少、
 * 如果像 OpenAI Agents SDK 的 input_filter 那样去掉工具相关的项会剩多少，都用 inputBreakdown 真算。模型每轮写的话是脚本（E.G.）。
 * tests/narrative.multi.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  buildRequest,
  createShop,
  daysBetween,
  encodeJson,
  EXAMPLE_API_KEY,
  formatUsd,
  GET_ORDER,
  handoffTool,
  inputBreakdown,
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
  type AgentTurn,
  type MessageParam,
  type Order,
  type PolicyHit,
  type ScriptStep,
  type ToolCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { blocksOf, fixedTokens, historyRow, ledgerGrid, type BlockCell } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { numbers as orchestrateNumbers } from './orchestrate';
import { dateText, MODEL, POLICY_QUERY, USER_ASK } from './scenario';
import type { DsFrame, Lesson, LessonEvent, NodeId, RowPrim } from './types';

// ---------- 场景 ----------

/** 退货专员：查规则、建退货单。没有 get_order——订单信息在转交过来的历史里。 */
export const RETURNS: AgentConfig = { name: 'returns', model: MODEL, system: '你是「小铺」的退货专员。对话里已有的订单信息不用再查；按售后规则判断能不能退，能退就建退货单。', tools: shopToolBox(['search_policy', 'create_return']) };

export const TRANSFER = handoffTool('returns', '把对话转交给退货专员：用户要退货或退款时调用。');

/** 分诊 Agent：能查订单，还有一个转交工具。 */
export const TRIAGE: AgentConfig = { name: 'triage', model: MODEL, system: '你是「小铺」客服的分诊 Agent。先弄清用户要办什么；退货、退款转给退货专员，自己不办。', tools: new ToolBox([GET_ORDER, TRANSFER]) };

/** 脚本按轮数接着写：前两轮是分诊 Agent，转交之后的三轮是退货专员。 */
const SCRIPT: ScriptStep[] = [
  [text('先确认订单。'), toolUse('get_order', { order_id: ORDER_ID }, 1)],
  ({ lastCalls }) => {
    const order = lastCalls[0].outcome.data as Order;
    return [text(`订单 ${dateText(order.signed_at!)}签收，用户要退货，转给退货专员。`), toolUse(TRANSFER.name, {}, 2)];
  },
  [text('订单信息对话里已经有了，我查一下退货规则。'), toolUse('search_policy', { query: POLICY_QUERY }, 3)],
  ({ calls }) => {
    // 退货专员读的是转交过来的历史里那份订单结果：签收日期在分诊 Agent 第 1 轮的工具结果里。
    const order = calls[0].outcome.data as Order;
    return [text(`签收 ${daysBetween(order.signed_at!, TODAY)} 天，在 ${QUALITY_RETURN_DAYS} 天之内，杯盖漏水是质量问题，可以退款，运费由店铺承担。我来建退货单。`), toolUse('create_return', { order_id: ORDER_ID, reason: 'quality', note: '杯盖漏水' }, 4)];
  },
  ({ lastCalls }) => {
    const ticket = lastCalls[0].outcome.data as { return_id: string; refund: number };
    return [text(`我是退货专员，已经为您建好退货单 ${ticket.return_id}。快递会上门取件，寄回运费由店铺承担；商品寄回、审核通过后，${ticket.refund} 元原路退回。`)];
  },
];

// ---------- 真实运行 ----------

export const shop = createShop();
export const run = runAgent(TRIAGE, USER_ASK, SCRIPT, { ctx: { shop }, seed: 100, agents: { returns: RETURNS } });
export const [t1, t2, t3, t4, t5] = run.turns as [AgentTurn, AgentTurn, AgentTurn, AgentTurn, AgentTurn];
const call = (turn: AgentTurn): ToolCall => turn.calls[0];

export const order = call(t1).outcome.data as Order;
export const hits = call(t3).outcome.data as PolicyHit[];
export const ticket = call(t4).outcome.data as { return_id: string; refund: number; days_since_signed: number };

/** 转交时带过去的历史：退货专员第一轮请求里的全部消息。 */
export const carried = t3.request.messages;
const carriedTokens = t3.breakdown.messages.reduce((a, b) => a + b, 0);

/**
 * 对照：像 OpenAI Agents SDK 的 handoff_filters.remove_all_tools 那样，把工具调用和结果都去掉，只留文字。
 * 本站的写法：用户的话 + 分诊 Agent 的两句想法并成一条助手消息（Messages API 要求 user / assistant 交替）。
 */
const textOnly = (message: MessageParam) => (typeof message.content === 'string' ? [] : message.content.filter((block) => block.type === 'text'));
export const filtered: MessageParam[] = [carried[0], { role: 'assistant', content: carried.filter((m) => m.role === 'assistant').flatMap(textOnly) }];
const filteredBreakdown = inputBreakdown(buildRequest(RETURNS, filtered));

// ---------- 文案用到的数 ----------

export const numbers = {
  turns: run.totals.turns,
  agents: run.turns.map((turn) => turn.agent),
  inputs: run.turns.map((turn) => turn.message.usage.input_tokens),
  cumulative: run.turns.map((turn) => turn.after.input),
  totalInput: run.totals.input,
  totalOutput: run.totals.output,
  cost: formatUsd(run.totals.cost),
  carriedMessages: carried.length,
  carriedTokens,
  carriedBytes: encodeJson(carried).bytes.length,
  orderResult: t3.breakdown.messages[2],
  filteredTokens: filteredBreakdown.messages.reduce((a, b) => a + b, 0),
  filteredMessages: filtered.length,
  /** 上一课的订单子 Agent 拿到的 task。 */
  subTask: orchestrateNumbers.childTask[0],
  system: [t2.breakdown.system, t3.breakdown.system],
  tools: [t2.breakdown.tools, t3.breakdown.tools],
  fixed: [fixedTokens(t2), fixedTokens(t3)],
  toolSystem: t1.toolSystem,
  transferResult: call(t2).result.content as string,
  transferOutput: outputTokensOf(t2.message.content[1]),
  messagesPerTurn: run.turns.map((turn) => turn.request.messages.length),
  days: ticket.days_since_signed,
  returnId: ticket.return_id,
  refund: ticket.refund,
  topHit: hits[0].id,
  lastAgent: run.turns[run.turns.length - 1].agent,
};
const N = numbers;

// ---------- 画图 ----------

function blocksAt(messages: MessageParam[]): BlockCell[] {
  const next = run.turns.find((turn) => turn.request.messages.length >= messages.length);
  const extra = next ? {} : { [run.messages.length - 1]: t5.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? t5).breakdown.prompt, extra);
}
const afterReply = (turn: AgentTurn): MessageParam[] => run.messages.slice(0, turn.request.messages.length + 1);
const afterResults = (turn: AgentTurn): MessageParam[] => run.messages.slice(0, turn.request.messages.length + 2);
const liftLast = (messages: MessageParam[], n: number) => {
  const count = blocksAt(messages).length;
  return Array.from({ length: n }, (_, i) => count - n + i);
};
/** 转交前的格子标成分诊 Agent 写的，之后的是退货专员；转交那一格画一个标记。 */
const handoffAt = blocksAt(carried).length;
const history = (messages: MessageParam[], lift: number[] = []): RowPrim => {
  const blocks = blocksAt(messages);
  return historyRow('h', blocks, { w: 40, lift, marks: blocks.length > handoffAt ? [{ at: handoffAt, text: '转交之后', color: 'amber' }] : undefined });
};

/** 每轮重带的固定部分：当前 Agent 的 system、工具定义、工具系统提示。 */
const toolset = (turn: AgentTurn, lift = false): RowPrim => ({
  kind: 'row',
  id: 'ts',
  w: 56,
  title: turn.agent === 'triage' ? '分诊 Agent' : '退货专员',
  cells: [
    { v: String(turn.breakdown.system), tone: 'violet', sub: 'system', key: `${turn.agent}:s`, lift: lift || undefined },
    { v: String(turn.breakdown.tools), tone: 'violet', sub: `${turn.request.tools!.length} 个工具`, key: `${turn.agent}:t`, lift: lift || undefined },
    { v: String(turn.toolSystem), tone: 'slate', sub: '工具提示', key: 'sys' },
  ],
});

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const WHO: Record<string, string> = { triage: '分诊 Agent', returns: '退货专员' };
const AT: Record<string, NodeId> = { triage: 'agent', returns: 'peer' };
/** 名字以拉丁字母结尾时，后面接汉字补一个空格。 */
const sp = (name: string): string => (/[A-Za-z]$/.test(name) ? `${name} ` : name);

function requestWire(turn: AgentTurn, expand: string[], notes: Record<string, string>) {
  return wire(`${sp(WHO[turn.agent])}第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'], notes: { 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_API_KEY.length} 个字符，这里打码）。` } }),
    jsonBody('请求体', encodeJson(turn.request), {
      expand,
      notes: {
        system: `${sp(WHO[turn.agent])}的 system，${turn.breakdown.system} 个 token。`,
        tools: `${turn.request.tools!.map((tool) => tool.name).join('、')}：展开后 ${turn.breakdown.tools} 个 token，另加工具系统提示 ${turn.toolSystem}。`,
        messages: `同一份对话历史，${turn.request.messages.length} 条消息。`,
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
        stop_reason: turn.message.stop_reason === 'tool_use' ? 'tool_use：要调用工具，循环继续。' : 'end_turn：说完了，循环停下。',
        'usage.input_tokens': `本站分词器的计数加上工具系统提示 ${turn.toolSystem}（示例）。`,
        ...notes,
      },
    }));
}

function roundTrip(turn: AgentTurn, label: string, payload: string[], requestNotes: Record<string, string>, responseNotes: Record<string, string>, extra: DsFrame = {}): LessonEvent[] {
  const at = AT[turn.agent];
  const n = turn.request.messages.length;
  const expand = n === 1 ? ['messages[0]'] : [`messages[${n - 2}]`, `messages[${n - 1}]`];
  const reply = afterReply(turn);
  return [
    pk(at, 'llm', 'blue', `${sp(WHO[turn.agent])}第 ${turn.index} 轮`, [`${n} 条消息`, `${num(turn.http.request.bytes.length)} 字节`], [turn.before.input, 'HTTP', `${sp(WHO[turn.agent])}的请求：自己的 system、${turn.request.tools!.length} 个工具、${n} 条消息`, turn.http.request.bytes.length], requestWire(turn, expand, requestNotes), { ds: { toolset: [toolset(turn, turn === t3)] } }),
    pk('llm', at, 'green', label, payload, [turn.after.input, 'INFER', `stop_reason ${turn.message.stop_reason}：输入 ${num(turn.message.usage.input_tokens)}、输出 ${turn.message.usage.output_tokens} token`, turn.http.response.bytes.length], responseWire(turn, responseNotes), { ds: { messages: [history(reply, liftLast(reply, turn.message.content.length))], usage: [ledgerGrid('u', run.turns.slice(0, turn.index), { w: 50 })], ...extra } }),
  ];
}

const toolUseWire = (c: ToolCall, noteText: string) =>
  wire(`tool_use：${c.use.name}`, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'], notes: { id: '这次调用的 id（示例）。', name: '要执行的工具。', input: noteText } }));
const toolResultWire = (c: ToolCall, noteText: string) =>
  wire(`tool_result：${c.use.name}`, 'mem', 'format', jsonBody('tool_result 块', encodeJson(c.result), { notes: { tool_use_id: `和 tool_use 的 id 一样：${c.use.id}。`, content: noteText } }));

/** 一次工具执行：运行时 → 工具端 → 数据 → 工具端 → 运行时。 */
function toolRound(turn: AgentTurn, store: NodeId, query: { label: string; payload: string[]; info: string; size: number; wire: ReturnType<typeof wire> }, back: { label: string; payload: string[]; info: string; size: number; wire: ReturnType<typeof wire> }, useNote: string, resultNote: string): LessonEvent[] {
  const at = AT[turn.agent];
  const c = call(turn);
  const after = afterResults(turn);
  return [
    pk(at, 'tools', 'amber', c.use.name, [preview(JSON.stringify(c.use.input), 18)], [turn.after.input, 'TOOL', `校验参数，执行 ${c.use.name}`, encodeJson(c.use).bytes.length], toolUseWire(c, useNote)),
    pk('tools', store, 'amber', query.label, query.payload, [turn.after.input, 'TOOL', query.info, query.size], query.wire),
    pk(store, 'tools', 'teal', back.label, back.payload, [turn.after.input, 'TOOL', back.info, back.size], back.wire),
    pk('tools', at, 'teal', 'tool_result', [preview(c.result.content as string, 16)], [turn.after.input, 'RESULT', `结果装进 tool_result，放进新的 user 消息`, encodeJson(c.result).bytes.length], toolResultWire(c, resultNote), { ds: { messages: [history(after, liftLast(after, 1))] } }),
  ];
}

const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;
const thought = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');

const orderJson = encodeJson(order);
const hitsJson = encodeJson(hits.map((hit) => ({ id: hit.id, score: +hit.score.toFixed(3) })));
const ticketJson = encodeJson(shop.returns[0]);
const carriedJson = encodeJson(carried);
const final = run.final;
const c2 = call(t2);

export const handoff: Lesson = {
  id: 'handoff',
  name: 'HANDOFF',
  title: 'Agent 间转交（handoff）',
  group: 'multi',
  layer: [5, 6],
  layerNote: '这课在「循环」和「编排」两档：还是同一个循环、同一份历史，转交只是在两轮之间换掉 system 和工具，也就换了说话的 Agent。',
  tokensNote: `分诊 Agent 2 轮、退货专员 3 轮，同一个循环的 usage.input_tokens 依次是 ${N.inputs.map(num).join('、')}，累计 ${num(N.totalInput)}。`,
  nodes: ['app', 'agent', 'llm', 'peer', 'tools', 'db', 'policy', 'messages', 'toolset', 'usage'],
  place: { app: [90, 150], llm: [600, 90], agent: [330, 390], peer: [880, 390], tools: [600, 590], db: [1090, 600], policy: [1090, 830], toolset: [1110, 150], usage: [70, 670], messages: [540, 950] },
  labels: {
    app: ['应用界面', '客服对话框'],
    agent: ['分诊 Agent', '查订单、决定转给谁'],
    llm: ['模型', MODEL],
    peer: ['退货专员', '接手：查规则、建退货单'],
    tools: ['工具执行端', '参数校验、执行'],
    db: ['订单库', '订单和退货单'],
    policy: ['规则库', 'BM25 检索'],
    messages: ['消息历史', '转交前后是同一份'],
    toolset: ['当前 Agent', '每轮重带的固定部分'],
    usage: ['账', '每轮的输入、输出 token'],
  },
  labelAt: { messages: [-320, 30], toolset: [0, 80], usage: [0, 160] },
  radius: { messages: 70, toolset: 70, usage: 80 },
  initial: { messages: [], toolset: [], usage: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '用户的话'], ['green', '模型写的想法和回答'], ['amber', 'tool_use 和转交'], ['teal', 'tool_result'], ['violet', 'system 和工具定义'], [null, '输入列：模型累计读入的 token']],
  overview: {
    full: '把整个对话交给另一个 Agent',
    description: `上一课的子 Agent 只拿到一段 task，干完把结论交回，控制权一直在编排者手里。转交（handoff）不一样：分诊 Agent 调用一个叫 transfer_to_returns 的工具，循环从下一轮起换成退货专员的 system 和工具，${N.carriedMessages} 条消息的历史原样带过去（${N.carriedTokens} 个 token），之后由退货专员查规则、建退货单、直接回答用户，分诊 Agent 不再出场。这一课 ${N.turns} 轮模型调用累计输入 ${num(N.totalInput)} 个 token。`,
    facts: [
      ['任务', 'A1024 杯盖漏水，退货'],
      ['转交工具', TRANSFER.name],
      ['模型调用', `分诊 2 轮 + 退货专员 3 轮`],
      ['带过去的历史', `${N.carriedMessages} 条消息，${N.carriedTokens} token`],
      ['费用', `${N.cost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '分诊 Agent 先查订单',
      desc: `工具：get_order 和 ${TRANSFER.name}`,
      detail: `分诊 Agent 有两个工具：查订单的 get_order，和一个转交工具 ${TRANSFER.name}（参数为空，名字的写法和 OpenAI Agents SDK 的默认工具名 transfer_to_<agent_name> 一致）。第 1 轮输入 ${num(N.inputs[0])} 个 token，模型写下${quote(thought(t1))}，调用 get_order。订单 JSON 作为 tool_result 回到历史里，后面会跟着整段对话一起转交出去。`,
      facts: [['输入', `${num(N.inputs[0])} token`], ['工具定义', `${N.tools[0]} token`], ['签收', `${order.signed_at}（${dateText(order.signed_at!)}）`], ['历史', `${N.messagesPerTurn[1]} 条消息`]],
      events: [
        type('A1024 杯盖漏水，想退货'),
        pk('app', 'agent', 'blue', '用户的请求', [preview(USER_ASK, 18)], [0, 'CALL', '用户的话交给分诊 Agent', utf8Encode(USER_ASK).length], wire('用户的话', 'mem', 'format', utf8Lines('content', USER_ASK, { summary: `UTF-8 ${utf8Encode(USER_ASK).length} 字节，成为 messages[0]` })), { ds: { messages: [history([run.messages[0]])] } }),
        show('messages', 'toolset', 'usage'),
        ...roundTrip(t1, 'tool_use: get_order', [`想法：${preview(thought(t1), 10)}`, 'get_order(A1024)'], { 'messages[0]': '用户的请求。' }, { 'content[1]': '行动（示例）：查订单 A1024。' }),
        state('agent', { 状态: '当前 Agent', 轮次: '1', stop_reason: 'tool_use' }),
        show('tools', 'db'),
        ...toolRound(t1, 'db',
          { label: `查订单 ${ORDER_ID}`, payload: ['orders.get("A1024")'], info: '在内存订单表里按订单号查', size: utf8Encode(ORDER_ID).length, wire: wire('查询的键', 'mem', 'internal', utf8Lines('order_id', ORDER_ID, { summary: '本站的订单表是内存里的 Map' })) },
          { label: '订单记录', payload: [order.item, `签收 ${order.signed_at}`], info: `查到：${order.item}，${order.signed_at} 签收`, size: orderJson.bytes.length, wire: wire('订单记录（本站的示例数据）', 'mem', 'internal', jsonBody('order', orderJson, { notes: { signed_at: '签收日期：退货专员后面要用它算天数。' } })) },
          'order_id 要匹配 ^A\\d{4}$。', '订单 JSON，模型下一轮会读到它。'),
      ],
    },
    {
      title: `调用 ${TRANSFER.name}：控制权转移`,
      desc: `工具结果是 ${N.transferResult}`,
      detail: `第 2 轮输入 ${num(N.inputs[1])}，模型读到签收日期，写下${quote(thought(t2))}，然后调用 ${TRANSFER.name}。这个工具不查任何东西，运行时执行它只回一句 ${N.transferResult}，真正的效果在循环里：从下一轮起，请求换成退货专员的 system 和工具。这和调用子 Agent 不一样，没有谁在等结果，分诊 Agent 这一轮之后就不再说话了。`,
      facts: [['输入', `${num(N.inputs[1])} token`], ['转交调用', `${N.transferOutput} 个输出 token`], ['工具结果', N.transferResult], ['接手', '退货专员']],
      events: [
        ...roundTrip(t2, `tool_use: ${TRANSFER.name}`, [`想法：${preview(thought(t2), 10)}`, `${TRANSFER.name}()`], { 'messages[2]': '订单查询的结果。' }, { 'content[1]': `转交（示例）：调用 ${TRANSFER.name}，参数为空。` }),
        pk('agent', 'tools', 'amber', TRANSFER.name, ['input: {}'], [t2.after.input, 'TOOL', `执行转交工具：不查数据，只记下要换成谁`, encodeJson(c2.use).bytes.length], toolUseWire(c2, '转交工具没有参数（OpenAI Agents SDK 可以用 input_type 让模型顺带填几个字段）。')),
        pk('tools', 'agent', 'teal', 'tool_result', [N.transferResult], [t2.after.input, 'RESULT', `结果 ${N.transferResult} 回填，tool_use 和 tool_result 仍然成对`, encodeJson(c2.result).bytes.length], toolResultWire(c2, '告诉模型接下来由谁接手；循环据此换配置。'), { ds: { messages: [history(carried, liftLast(carried, 1))] } }),
        state('agent', { 状态: '已转交', 轮次: '2', stop_reason: 'tool_use' }),
      ],
    },
    {
      title: '退货专员接手：历史整份带过去',
      desc: `${N.carriedMessages} 条消息、${N.carriedTokens} token`,
      detail: `第 3 轮由退货专员发请求：system 和工具都换成它自己的，每轮固定部分从 ${num(N.fixed[0])} 变成 ${num(N.fixed[1])}；messages 还是同一份，${N.carriedMessages} 条消息，${N.carriedTokens} 个 token，其中订单结果 ${N.orderResult} 个。上一课的订单子 Agent 只拿到 ${N.subTask} 个 token 的 task，接手的 Agent 默认却能看到完整历史（OpenAI Agents SDK 也是这样），所以它没有 get_order 也知道签收日期。要是像 SDK 的 input_filter（例如 remove_all_tools）那样去掉工具调用和结果，只剩 ${N.filteredTokens} 个 token，签收日期也跟着没了。`,
      facts: [['带过去', `${N.carriedMessages} 条消息，${N.carriedTokens} token`], ['固定部分', `${num(N.fixed[0])} → ${num(N.fixed[1])}`], ['去掉工具项', `${N.filteredTokens} token`], ['输入', `${num(N.inputs[2])} token`]],
      events: [
        show('peer'),
        pk('agent', 'peer', 'amber', '转交', [`${N.carriedMessages} 条消息`, `${N.carriedTokens} token`], [t2.after.input, 'HANDOFF', `循环换成退货专员：system、工具换掉，历史 ${N.carriedMessages} 条原样带上`, carriedJson.bytes.length], wire('带过去的历史', 'mem', 'format',
          jsonBody('messages', carriedJson, { expand: carried.map((_, i) => `[${i}]`), notes: { '[2]': `订单查询的结果：${N.orderResult} 个 token，退货专员要用它。`, '[4]': `转交工具的结果：${N.transferResult}。` } }),
          concept('换掉的和不变的', [
            ['system', `${N.system[0]} → ${N.system[1]} token`, '换成退货专员的。'],
            ['tools', `${N.tools[0]} → ${N.tools[1]} token`, `get_order、${TRANSFER.name} → search_policy、create_return。`],
            ['messages', `${N.carriedMessages} 条，${N.carriedTokens} token`, 'runAgent 不过滤：历史一条不少。'],
            ['去掉工具项时', `${N.filteredMessages} 条，${N.filteredTokens} token`, '只留用户的话和两句想法（本站把它们并成一条助手消息）：订单 JSON 没了。'],
          ], 'amber')), { ds: { messages: [history(carried)] } }),
        ...roundTrip(t3, 'tool_use: search_policy', [`想法：${preview(thought(t3), 10)}`, 'search_policy'], { system: '换成退货专员的 system。', tools: '换成 search_policy、create_return。' }, { 'content[1]': `行动（示例）：查询词「${POLICY_QUERY}」。` }),
        state('agent', { 状态: null, 轮次: null, stop_reason: null }),
        note('agent', '已转交，不再说话'),
        state('peer', { 状态: '当前 Agent', 轮次: '3', stop_reason: 'tool_use' }),
      ],
    },
    {
      title: '退货专员查规则、建退货单',
      desc: `签收 ${N.days} 天，建单 ${N.returnId}`,
      detail: `退货专员用 BM25 查到 ${N.topHit}（《售后规则》第 3 条），第 4 轮输入 ${num(N.inputs[3])}，从转交过来的订单结果里读出签收日期，写下${quote(thought(t4).split('。')[0])}，调用 create_return。create_return 自己再算一遍天数，没超过 ${QUALITY_RETURN_DAYS} 天，建好退货单 ${N.returnId}。这两轮的工具都是退货专员自己的，分诊 Agent 的 get_order 已经不在请求里了。`,
      facts: [['输入', `${num(N.inputs[3])} token`], ['最相关', N.topHit], ['签收天数', `${N.days} 天（工具算的）`], ['退货单', N.returnId]],
      events: [
        show('policy'),
        ...toolRound(t3, 'policy',
          { label: 'BM25 检索', payload: [`query: ${POLICY_QUERY}`], info: '给规则打分，取前 2 段', size: utf8Encode(POLICY_QUERY).length, wire: wire('查询词', 'mem', 'format', utf8Lines('query', POLICY_QUERY)) },
          { label: `前 ${hits.length} 段`, payload: hits.map((hit) => `${hit.id} ${hit.score.toFixed(2)}`), info: `${N.topHit} 得分最高`, size: hitsJson.bytes.length, wire: wire('BM25 的前两段（本站的检索结果）', 'mem', 'internal', jsonBody('hits', hitsJson)) },
          '查询词（示例）；top_k 不写，默认 2。', '两段规则原文。'),
        ...roundTrip(t4, 'tool_use: create_return', [`想法：${preview(thought(t4), 10)}`, 'create_return'], {}, { 'content[1]': '行动（示例）：reason 是 quality。' }),
        ...toolRound(t4, 'db',
          { label: `建单 ${N.returnId}`, payload: [`签收 ${N.days} 天 ≤ ${QUALITY_RETURN_DAYS}`], info: `${order.signed_at} 到 ${TODAY} 是 ${N.days} 天，写入退货单`, size: ticketJson.bytes.length, wire: wire('写入的退货单（本站的示例数据）', 'mem', 'internal', jsonBody('ticket', ticketJson)) },
          { label: '建单成功', payload: [N.returnId], info: `退货单 ${N.returnId} 写入订单库`, size: utf8Encode(N.returnId).length, wire: wire('退货单号', 'mem', 'internal', utf8Lines('return_id', N.returnId, { summary: 'R + 日期 + 序号（本站的写法）' })) },
          'reason 只能是 quality 或 no_reason。', '退货单号、应退金额、签收天数。'),
        state('peer', { 状态: '当前 Agent', 轮次: '4', stop_reason: 'tool_use' }),
      ],
    },
    {
      title: '退货专员直接回答用户',
      desc: `最后说话的是退货专员（${N.lastAgent}）`,
      detail: `第 5 轮输入 ${num(N.inputs[4])}，退货专员写出回答，stop_reason 是 end_turn，回答直接交给用户，不经过分诊 Agent。用户下一句话应当接着交给退货专员：OpenAI Agents SDK 的 result.last_agent 就是最后运行的 Agent，文档说转交之后通常用它处理下一轮。${N.turns} 轮累计输入 ${num(N.totalInput)}、输出 ${num(N.totalOutput)} token，按示例单价 ${N.cost}。`,
      facts: [['输入', `${num(N.inputs[4])} token`], ['累计输入', `${num(N.totalInput)} token`], ['回答的是', '退货专员'], ['费用', N.cost]],
      events: [
        ...roundTrip(t5, 'end_turn：回答', [preview(final, 16)], {}, { 'content[0]': '回答（示例）：退货单号和金额来自工具结果。' }, { usage: [ledgerGrid('u', run.turns, { w: 50, total: true })] }),
        pk('peer', 'app', 'green', '回答', [preview(final, 18)], [t5.after.input, 'STOP', '退货专员 stop_reason 是 end_turn，回答直接交给界面', utf8Encode(final).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', final, { summary: '退货专员最后一条助手消息的 text 块（示例）' }), concept('这次运行', [['轮数', `${N.turns}`, `分诊 Agent ${N.agents.filter((a) => a === 'triage').length} 轮，退货专员 ${N.agents.filter((a) => a === 'returns').length} 轮。`], ['最后的 Agent', N.lastAgent, '下一轮用户输入交给它。'], ['累计输入', num(N.totalInput)], ['费用', N.cost, `示例单价（${PRICE_DATE}）。`]]))),
        state('peer', { 状态: '当前 Agent', 轮次: '5', stop_reason: 'end_turn' }),
        render,
        note('messages', `历史 ${run.messages.length} 条，从头到尾一份`, 'green'),
      ],
    },
  ],
  outro: {
    title: '转交换的是说话的人，不是历史',
    desc: `${N.turns} 轮、带过去 ${N.carriedTokens} token、${N.cost}`,
    text: `子 Agent 和转交是两种分工：子 Agent 是被调用的工具，拿一段 task、交回结论，编排者始终在场、负责回答；转交是让出控制权，接手的 Agent 换上自己的 system 和工具，带着整段历史接着和用户说话。转交的历史默认整份带过去，这次 ${N.carriedMessages} 条消息 ${N.carriedTokens} 个 token，接手的 Agent 因此不用重查订单；过滤能省 token，但也可能把它需要的东西一起删掉。不管是派活还是转交，真正去执行工具的都是运行时：下一课看运行时怎样在执行前把关，哪些工具自动放行，哪些要用户点头。`,
    facts: [['模型调用', `${N.turns} 轮（2 + 3）`], ['带过去的历史', `${N.carriedTokens} token`], ['累计输入', `${num(N.totalInput)} token`], ['下一课', '工具权限与人工确认']],
  },
};
