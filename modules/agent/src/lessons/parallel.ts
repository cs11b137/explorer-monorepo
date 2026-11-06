/**
 * 循环组第三课：并行工具调用与结果回填。同一件事（A1024 杯盖漏水退货），模型第一轮就同时调用 get_order 和 search_policy：
 * 一条助手消息里两个 tool_use，运行时把两个都执行完，两个 tool_result 按 tool_use_id 对应、放进同一条 user 消息，
 * 三轮办完。和 react 课的串行写法（加上 disable_parallel_tool_use，一轮最多一个调用，四轮）比较轮数和累计输入。
 *
 * 两次都由 runAgent 真实执行：请求、token、工具结果、回填的消息、累计账都是算出来的；模型每轮写什么是脚本（E.G.）。
 * tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  createShop,
  encodeJson,
  formatUsd,
  ORDER_ID,
  outputTokensOf,
  runAgent,
  text,
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
import { blocksOf, historyRow, ledgerGrid, pct, type BlockCell } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { MODEL, POLICY_QUERY, REACT_SCRIPT, SUPPORT, USER_ASK } from './scenario';
import type { DsCell, DsMark, GridPrim, Lesson, LessonEvent } from './types';

// ---------- 真实运行 ----------

/** 并行的脚本：第一轮同时查订单和规则（两个 tool_use），之后和 ReAct 一样建单、回答。 */
export const PARALLEL_SCRIPT: ScriptStep[] = [
  [text('我同时查一下订单和售后规则。'), toolUse('get_order', { order_id: ORDER_ID }, 1), toolUse('search_policy', { query: POLICY_QUERY }, 2)],
  REACT_SCRIPT[2],
  REACT_SCRIPT[3],
];
export const shop = createShop();
export const run = runAgent(SUPPORT, USER_ASK, PARALLEL_SCRIPT, { ctx: { shop }, seed: 200 });
export const [t1, t2, t3] = run.turns as [AgentTurn, AgentTurn, AgentTurn];

/** 串行的对照：tool_choice 里写 disable_parallel_tool_use，一轮最多一个调用；脚本就是 react 课的四轮。 */
export const SERIAL: AgentConfig = { ...SUPPORT, toolChoice: { type: 'auto', disable_parallel_tool_use: true } };
export const serial = runAgent(SERIAL, USER_ASK, REACT_SCRIPT, { ctx: { shop: createShop() }, seed: 100 });

const [orderCall, policyCall] = t1.calls as [ToolCall, ToolCall];
const returnCall = t2.calls[0];
export const order = orderCall.outcome.data as Order;
export const hits = policyCall.outcome.data as PolicyHit[];
export const ticket = returnCall.outcome.data as { return_id: string; refund: number; days_since_signed: number };
/** 回填两个结果的那条 user 消息。 */
export const resultMessage = run.messages[2];

const afterReply = (turn: AgentTurn): MessageParam[] => [...turn.request.messages, run.messages[turn.request.messages.length]];
const afterResults = (turn: AgentTurn): MessageParam[] => run.messages.slice(0, turn.request.messages.length + 2);

function blocksAt(messages: MessageParam[]): BlockCell[] {
  const next = run.turns.find((turn) => turn.request.messages.length >= messages.length);
  const last = run.messages.length - 1;
  const extra = next ? {} : { [last]: t3.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? t3).breakdown.prompt, extra);
}
const tail = (messages: MessageParam[], n: number) => {
  const total = blocksAt(messages).length;
  return Array.from({ length: n }, (_, i) => total - n + i);
};
const history = (messages: MessageParam[], lift: number[] = [], marks?: DsMark[]) => historyRow('h', blocksAt(messages), { w: 46, lift, marks });

/** 两个 tool_result 的 tool_use_id 末四位（和两个 tool_use 的 id 一一对应）。 */
const short = (id: string) => `…${id.slice(-4)}`;
const pairMarks = (): DsMark[] => {
  const blocks = blocksAt(afterResults(t1));
  const at = (message: number, block: number) => blocks.findIndex((cell) => cell.message === message && cell.block === block);
  return [
    { at: at(2, 0), text: short(orderCall.result.tool_use_id), color: 'teal', dx: -28 },
    { at: at(2, 1), text: short(policyCall.result.tool_use_id), color: 'teal', dx: 28 },
  ];
};

// ---------- 文案用到的数 ----------

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const numbers = {
  turns: run.totals.turns,
  serialTurns: serial.totals.turns,
  calls: run.turns.map((turn) => turn.calls.length),
  serialCalls: serial.turns.map((turn) => turn.calls.length),
  toolCalls: sum(run.turns.map((turn) => turn.calls.length)),
  inputs: run.turns.map((turn) => turn.message.usage.input_tokens),
  outputs: run.turns.map((turn) => turn.message.usage.output_tokens),
  serialInputs: serial.turns.map((turn) => turn.message.usage.input_tokens),
  totalInput: run.totals.input,
  totalOutput: run.totals.output,
  serialInput: serial.totals.input,
  serialOutput: serial.totals.output,
  saved: serial.totals.input - run.totals.input,
  savedShare: pct((serial.totals.input - run.totals.input) / serial.totals.input),
  cost: formatUsd(run.totals.cost),
  serialCost: formatUsd(serial.totals.cost),
  messagesPerTurn: run.turns.map((turn) => turn.request.messages.length),
  resultBlocks: Array.isArray(resultMessage.content) ? resultMessage.content.length : 0,
  resultBytes: encodeJson(resultMessage).bytes.length,
  orderId: orderCall.use.id,
  policyId: policyCall.use.id,
  topHit: hits[0].id,
  returnId: ticket.return_id,
  refund: ticket.refund,
  days: ticket.days_since_signed,
  t1Output: t1.message.usage.output_tokens,
};
const N = numbers;

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };

const requestWire = (turn: AgentTurn, expand: string[], notes: Record<string, string>) =>
  wire(`第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
    jsonBody('请求体', encodeJson(turn.request), { expand, notes: { messages: `到目前为止的全部消息，共 ${turn.request.messages.length} 条。`, ...notes } }));

const responseWire = (turn: AgentTurn, notes: Record<string, string>) => {
  const blocks = turn.message.content.map((_, i) => `content[${i}]`);
  return wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), {
      expand: [...blocks, 'usage.output_tokens'],
      example: ['id', 'content', ...blocks, 'usage', 'usage.input_tokens', 'usage.output_tokens'],
      notes: { stop_reason: turn.message.stop_reason === 'tool_use' ? 'tool_use：这条消息里有工具调用（不管几个），等全部结果回来。' : 'end_turn：说完了，循环停下。', ...notes },
    }));
};

const useWire = (c: ToolCall, noteText: string) =>
  wire(`tool_use：${c.use.name}`, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'], notes: { id: `这次调用的 id（示例）：${c.use.id}。`, input: noteText } }));

function roundTrip(turn: AgentTurn, label: string, payload: string[], requestNotes: Record<string, string>, responseNotes: Record<string, string>, before: MessageParam[]): LessonEvent[] {
  const expand = turn.index === 1 ? ['messages[0]'] : [`messages[${turn.request.messages.length - 1}]`];
  const reply = afterReply(turn);
  return [
    pk('agent', 'llm', 'blue', `第 ${turn.index} 轮请求`, [`${turn.request.messages.length} 条消息`, `${num(turn.http.request.bytes.length)} 字节`], [turn.before.input, 'HTTP', `POST /v1/messages：${turn.request.messages.length} 条消息`, turn.http.request.bytes.length], requestWire(turn, expand, requestNotes), { ds: { messages: [history(before)] } }),
    pk('llm', 'agent', 'green', label, payload, [turn.after.input, 'INFER', `stop_reason ${turn.message.stop_reason}：${turn.calls.length} 个 tool_use，输入 ${num(turn.message.usage.input_tokens)}、输出 ${turn.message.usage.output_tokens}`, turn.http.response.bytes.length], responseWire(turn, responseNotes), { ds: { messages: [history(reply, tail(reply, turn.message.content.length))], usage: [ledgerGrid('u', run.turns.slice(0, turn.index))] } }),
    state('agent', { 轮次: `${turn.index}`, 'tool_use': `${turn.calls.length} 个`, stop_reason: turn.message.stop_reason }),
  ];
}

const compareGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 58,
  rows: ['并行', '串行'],
  cols: ['轮数', '输入', '输出'],
  cells: [
    [{ v: String(N.turns), tone: 'green' }, { v: String(N.totalInput), tone: 'green' }, { v: String(N.totalOutput), tone: 'green' }],
    [{ v: String(N.serialTurns), tone: 'amber' }, { v: String(N.serialInput), tone: 'amber' }, { v: String(N.serialOutput), tone: 'amber' }],
  ] as DsCell[][],
});

// ---------- 事件 ----------

const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;
const thought = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');
const orderJson = encodeJson(order);
const hitsJson = encodeJson(hits.map((hit) => ({ id: hit.id, score: +hit.score.toFixed(3) })));
const resultJson = encodeJson(resultMessage);
const filled = afterResults(t1);
const serialRequestJson = encodeJson(serial.turns[0].request);

export const parallel: Lesson = {
  id: 'parallel',
  name: 'PARALLEL',
  title: '并行工具调用与结果回填',
  group: 'loop',
  layer: [4, 5],
  layerNote: '这课在「工具」和「循环」两档：一轮里的几个调用怎样执行、怎样按 id 回填，决定了循环要转几圈。',
  tokensNote: `并行那次运行 ${N.turns} 轮的 usage.input_tokens 依次是 ${N.inputs.map(num).join('、')}，累计 ${num(N.totalInput)}；最后一步的串行对照只在账里比较，不计入这一列。`,
  nodes: ['app', 'agent', 'llm', 'tools', 'db', 'policy', 'messages', 'usage'],
  place: { app: [90, 150], agent: [520, 300], llm: [840, 90], tools: [800, 500], db: [1050, 360], policy: [1050, 620], messages: [480, 730], usage: [90, 520] },
  labels: {
    app: ['应用界面', '客服对话框'],
    agent: ['Agent 运行时', '执行、按 id 回填'],
    llm: ['模型', MODEL],
    tools: ['工具执行端', '两个调用都执行'],
    db: ['订单库', '订单和退货单'],
    policy: ['规则库', 'BM25'],
    messages: ['消息历史', '每格一个内容块的 token'],
    usage: ['账', '每轮的输入、输出 token'],
  },
  labelAt: { messages: [-250, 40], usage: [0, 150] },
  radius: { messages: 70, usage: 70 },
  initial: { messages: [], usage: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '用户的话'], ['green', '模型写的文字'], ['amber', '行动：tool_use'], ['teal', '观察：tool_result'], [null, '输入列：模型累计读入的 token']],
  overview: {
    full: '一轮里调用两个工具，少转一圈',
    description: `查订单和查规则互不依赖，没必要一轮一个。Messages API 默认允许并行工具调用：模型在一条消息里写两个 tool_use，运行时都执行完，再把两个 tool_result 放进同一条 user 消息交回。这一课的客服 Agent 第一轮就同时查订单和规则，${N.turns} 轮办完；同一件事一轮只调一个要 ${N.serialTurns} 轮。少一轮就少重发一次整段历史，累计输入从 ${num(N.serialInput)} 降到 ${num(N.totalInput)}，少了 ${N.savedShare}。`,
    facts: [
      ['第一轮', 'get_order 和 search_policy 一起调用'],
      ['回填', `${N.resultBlocks} 个 tool_result 在同一条 user 消息里`],
      ['轮数', `${N.turns} 轮（串行 ${N.serialTurns} 轮）`],
      ['累计输入', `${num(N.totalInput)}（串行 ${num(N.serialInput)}）`],
    ],
  },
  steps: [
    {
      title: '一条消息里两个 tool_use',
      desc: `第一轮输出 ${N.t1Output} token：一句话加两个调用`,
      detail: `第一轮的请求和 react 课一模一样，输入 ${num(N.inputs[0])} 个 token。模型写了一句${quote(thought(t1))}，接着在同一条消息里写了两个 tool_use：get_order 查订单，search_policy 查售后规则，两个调用各有自己的 id。stop_reason 仍然只有一个 tool_use，它的意思是「这条消息里有工具调用」，运行时要把里面的调用全部执行完再回来。`,
      facts: [['输入', `${num(N.inputs[0])} token`], ['输出', `${N.t1Output} token`], ['tool_use', `${N.calls[0]} 个`], ['stop_reason', 'tool_use']],
      events: [
        type('A1024 杯盖漏水，想退货'),
        pk('app', 'agent', 'blue', '用户的请求', [preview(USER_ASK, 18)], [0, 'CALL', '用户的话交给运行时，作为第一条 user 消息', utf8Encode(USER_ASK).length], wire('用户的话', 'mem', 'format', utf8Lines('content', USER_ASK)), { ds: { messages: [history([run.messages[0]])] } }),
        show('messages', 'usage'),
        ...roundTrip(t1, '两个 tool_use', ['get_order(A1024)', `search_policy`], { 'messages[0]': '用户的请求。' }, { 'content[1]': `第一个调用（示例），id ${orderCall.use.id}。`, 'content[2]': `第二个调用（示例），id ${policyCall.use.id}。它不需要等第一个的结果。` }, [run.messages[0]]),
        note('messages', `一条消息，${N.calls[0]} 个调用`),
      ],
    },
    {
      title: '运行时把两个都执行完',
      desc: '查订单、查规则，各得一个结果',
      detail: `运行时取出消息里全部的 tool_use，逐个按 input_schema 校验后执行：get_order 在订单库里查到 ${order.signed_at} 签收的保温杯，search_policy 用 BM25 在规则库里取出 ${N.topHit} 等两段。API 不规定执行顺序，结果靠 tool_use_id 对回去，所以互不依赖的调用可以并发执行；本站的循环是同步的，按出现顺序逐个执行，结果和并发一样。每个结果装进一个 tool_result 块，tool_use_id 抄自对应的调用。`,
      facts: [['get_order', `签收 ${order.signed_at}`], ['search_policy', `${hits.length} 段，${N.topHit} 最高`], ['执行顺序', 'API 不规定，按 id 对应'], ['结果块', `${N.resultBlocks} 个`]],
      events: [
        show('tools', 'db', 'policy'),
        pk('agent', 'tools', 'amber', 'get_order', ['order_id: A1024'], [t1.after.input, 'TOOL', '第一个 tool_use：校验参数，执行 get_order', encodeJson(orderCall.use).bytes.length], useWire(orderCall, '订单号，匹配 ^A\\d{4}$。'), { ds: { messages: [history(afterReply(t1), [1])] } }),
        pk('tools', 'db', 'amber', '查订单', ['orders.get("A1024")'], [t1.after.input, 'TOOL', '在内存订单表里按订单号查', utf8Encode(ORDER_ID).length], wire('查询的键', 'mem', 'internal', utf8Lines('order_id', ORDER_ID))),
        pk('db', 'tools', 'teal', '订单记录', [order.item, `签收 ${order.signed_at}`], [t1.after.input, 'TOOL', `查到：${order.item}，${order.signed_at} 签收`, orderJson.bytes.length], wire('订单记录（本站的示例数据）', 'mem', 'internal', jsonBody('order', orderJson))),
        pk('agent', 'tools', 'amber', 'search_policy', [`query: ${POLICY_QUERY}`], [t1.after.input, 'TOOL', '第二个 tool_use：不等第一个的结果，直接执行', encodeJson(policyCall.use).bytes.length], useWire(policyCall, '查询词（示例）。'), { ds: { messages: [history(afterReply(t1), [2])] } }),
        pk('tools', 'policy', 'amber', 'BM25 检索', [POLICY_QUERY], [t1.after.input, 'TOOL', `给规则库打分，取前 ${hits.length} 段`, utf8Encode(POLICY_QUERY).length], wire('查询词', 'mem', 'format', utf8Lines('query', POLICY_QUERY))),
        pk('policy', 'tools', 'teal', `前 ${hits.length} 段`, hits.map((hit) => `${hit.id} ${hit.score.toFixed(2)}`), [t1.after.input, 'TOOL', `${N.topHit} 得分 ${hits[0].score.toFixed(2)}，最高`, hitsJson.bytes.length], wire('BM25 的前两段（本站的检索结果）', 'mem', 'internal', jsonBody('hits', hitsJson))),
        state('agent', { 'tool_use': `${N.calls[0]} 个，已执行 ${N.calls[0]}` }),
      ],
    },
    {
      title: '两个结果放进同一条 user 消息',
      desc: `${N.resultBlocks} 个 tool_result，${num(N.resultBytes)} 字节`,
      detail: `两个 tool_result 放进紧跟在后面的同一条 user 消息里，各带自己的 tool_use_id，排在消息的最前面；文档要求含 tool_result 的消息里结果在前、文字在后，反过来会回 400。拆成两条 user 消息各放一个，文档说会让模型以后越来越少做并行调用。历史现在是 ${N.messagesPerTurn[1]} 条消息：用户的话、一条带两个调用的助手消息、一条带两个结果的 user 消息。`,
      facts: [['消息', `1 条 user，${N.resultBlocks} 个 tool_result`], ['对应', `${short(N.orderId)}、${short(N.policyId)}`], ['顺序', 'tool_result 在前，文字在后'], ['历史', `${N.messagesPerTurn[1]} 条消息`]],
      events: [
        pk('tools', 'agent', 'teal', `${N.resultBlocks} 个 tool_result`, [`${short(N.orderId)}、${short(N.policyId)}`, `${num(N.resultBytes)} 字节`], [t1.after.input, 'RESULT', `两个结果按 tool_use_id 放进同一条 user 消息`, N.resultBytes], wire('回填的 user 消息', 'mem', 'format', jsonBody('user 消息', resultJson, { expand: ['content[0]', 'content[0].tool_use_id', 'content[1]', 'content[1].tool_use_id'], notes: { role: '还是 user：工具结果由应用这一侧交回。', 'content[0].tool_use_id': `对应第一个调用 get_order。`, 'content[1].tool_use_id': `对应第二个调用 search_policy。`, content: '两个结果都在这一条消息里，而且排在最前面（没有文字）。' } }), concept('不能这样写（文档）', [['先写文字再放结果', '400', '含 tool_result 的 user 消息里，结果必须在最前面。'], ['拆成两条 user 消息', '别这样', '文档：模型以后会越来越少做并行调用。'], ['少回一个结果', '不行', '每个 tool_use 都要有对应的 tool_result，失败的也要回 is_error。']])), { ds: { messages: [history(filled, tail(filled, N.resultBlocks), pairMarks())] } }),
        note('messages', `历史 ${N.messagesPerTurn[1]} 条消息`),
      ],
    },
    {
      title: '三轮办完',
      desc: `建退货单 ${N.returnId}，stop_reason end_turn`,
      detail: `第二轮带着 ${N.messagesPerTurn[1]} 条消息再问一次，输入 ${num(N.inputs[1])} 个 token：订单和规则都已经在历史里，模型直接判断签收 ${N.days} 天、在 7 天之内，调用 create_return。建单要用前两个结果，必须等它们回来，这一步没法并行。第三轮输入 ${num(N.inputs[2])}，模型只写回答，stop_reason 是 end_turn，循环在第 ${N.turns} 轮停下。`,
      facts: [['第二轮输入', `${num(N.inputs[1])} token`], ['退货单', N.returnId], ['第三轮输入', `${num(N.inputs[2])} token`], ['累计输入', `${num(N.totalInput)} token`]],
      events: [
        ...roundTrip(t2, 'tool_use: create_return', [`想法：${preview(thought(t2), 12)}`, 'create_return'], {}, { 'content[1]': '建单依赖前两个结果，只能在这一轮调用。' }, filled),
        pk('agent', 'tools', 'amber', 'create_return', ['reason: quality'], [t2.after.input, 'TOOL', '校验参数，执行 create_return', encodeJson(returnCall.use).bytes.length], useWire(returnCall, 'reason 是 quality（示例）。'), { ds: { messages: [history(afterReply(t2), tail(afterReply(t2), 1))] } }),
        pk('tools', 'agent', 'teal', N.returnId, [`退 ${N.refund} 元`], [t2.after.input, 'RESULT', `退货单 ${N.returnId} 建好，结果交回`, encodeJson(returnCall.result).bytes.length], wire('tool_result：create_return', 'mem', 'format', jsonBody('tool_result 块', encodeJson(returnCall.result))), { ds: { messages: [history(afterResults(t2), tail(afterResults(t2), 1))] } }),
        ...roundTrip(t3, 'end_turn：回答', [preview(run.final, 16)], {}, { 'content[0]': '回答（示例）：单号和金额来自工具结果。' }, afterResults(t2)),
        pk('agent', 'app', 'green', '回答', [preview(run.final, 18)], [t3.after.input, 'STOP', 'stop_reason 是 end_turn，循环停下，回答交给界面', utf8Encode(run.final).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', run.final)), { ds: { usage: [ledgerGrid('u', run.turns, { total: true })] } }),
        render,
      ],
    },
    {
      title: '和一轮一个比：少一轮，少读 ' + N.savedShare,
      desc: `${N.serialTurns} 轮 ${num(N.serialInput)} → ${N.turns} 轮 ${num(N.totalInput)}`,
      detail: `在 tool_choice 里写 disable_parallel_tool_use: true，auto 时模型一轮最多调用一个工具，就是 react 课的写法：同一件事 ${N.serialTurns} 轮，累计输入 ${num(N.serialInput)}。并行版少了一轮，也就少重发一次整段历史，累计输入 ${num(N.totalInput)}，少 ${num(N.saved)}（${N.savedShare}），按示例单价从 ${N.serialCost} 降到 ${N.cost}。省下的只是互不依赖的那一步，有先后依赖的调用（先查到订单才能建单）还是得一轮一轮来。`,
      facts: [['串行', `${N.serialTurns} 轮，${num(N.serialInput)} token`], ['并行', `${N.turns} 轮，${num(N.totalInput)} token`], ['少读', `${num(N.saved)}（${N.savedShare}）`], ['费用', `${N.serialCost} → ${N.cost}`]],
      events: [
        pk('agent', 'usage', 'amber', 'disable_parallel_tool_use', [`${N.serialTurns} 轮`, `${num(N.serialInput)} token`], [run.totals.input, 'TOKENS', `串行对照（disable_parallel_tool_use）：${N.serialTurns} 轮，累计 ${num(N.serialInput)}`, serialRequestJson.bytes.length], wire('串行对照的第一轮请求', 'mem', 'format', jsonBody('请求体', serialRequestJson, { expand: ['tool_choice', 'tool_choice.disable_parallel_tool_use'], notes: { 'tool_choice.disable_parallel_tool_use': 'auto 时一轮最多一个 tool_use（any / tool 时恰好一个）。' } }), concept('两次运行', [['并行', `${N.turns} 轮`, `每轮调用 ${N.calls.join('、')} 个；累计 ${num(N.totalInput)}。`], ['串行', `${N.serialTurns} 轮`, `每轮调用 ${N.serialCalls.join('、')} 个；累计 ${num(N.serialInput)}。`], ['差', `${num(N.saved)}`, `${N.savedShare}；输出 ${N.serialOutput} → ${N.totalOutput}。`]])), { ds: { usage: [compareGrid()] } }),
        state('agent', { 轮次: `${N.turns}（串行 ${N.serialTurns}）`, 'tool_use': null, stop_reason: 'end_turn' }),
        note('usage', `少读 ${num(N.saved)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '能一起做的，一轮做完',
    desc: `${N.turns} 轮、${N.toolCalls} 次工具调用、${N.cost}`,
    text: `并行工具调用不需要新的协议：一条助手消息里多写几个 tool_use，一条 user 消息里按 tool_use_id 回填同样多的 tool_result，结果排在最前面。运行时要做的是把一轮里的调用全部执行完，失败的也回一个 is_error 的结果，不能漏。这次少了一轮，累计输入少了 ${N.savedShare}；但只有互不依赖的调用才能放在一起。下一课看工具出错、模型改口，以及循环在什么情况下必须停下。`,
    facts: [['模型调用', `${N.turns} 轮`], ['工具调用', `${N.toolCalls} 次`], ['累计输入', `${num(N.totalInput)} token`], ['下一课', '工具报错、最大轮数与停止']],
  },
};
