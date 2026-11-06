/**
 * 第一课：ReAct——想一步、做一步、看结果。客服 Agent 处理订单 A1024 的杯盖漏水退货：
 * 查订单 → 查售后规则 → 建退货单 → 回答，一共四轮模型调用、三次工具执行。
 *
 * 循环由 core/loop.ts 的 runAgent 真实执行：每轮的请求带上整段历史、按 ChatML 展开数 token（加上文档给的工具系统提示 286 个）、
 * 工具在内存数据上真实执行（订单查询、BM25 检索规则、按签收天数判断能不能退、建单），tool_result 按 id 回填，stop_reason 决定停不停。
 * 模型每轮写的文字和工具调用是脚本（lessons/scenario.ts），标 E.G.。tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  createShop,
  DEFAULT_MAX_TURNS,
  encodeJson,
  EXAMPLE_API_KEY,
  formatPrice,
  formatUsd,
  outputTokensOf,
  POLICIES,
  PRICE_DATE,
  priceOf,
  QUALITY_RETURN_DAYS,
  runAgent,
  termsOf,
  TODAY,
  type AgentTurn,
  type MessageParam,
  type Order,
  type PolicyHit,
  type ToolCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { blocksOf, fixedTokens, historyRow, ledgerGrid, pct, type BlockCell } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { dateText, MODEL, POLICY_QUERY, REACT_SCRIPT, SUPPORT, USER_ASK } from './scenario';
import type { Lesson, LessonEvent } from './types';

// ---------- 真实运行一次 ----------

export const shop = createShop();
export const run = runAgent(SUPPORT, USER_ASK, REACT_SCRIPT, { ctx: { shop }, seed: 100 });
export const [t1, t2, t3, t4] = run.turns as [AgentTurn, AgentTurn, AgentTurn, AgentTurn];
const call = (turn: AgentTurn): ToolCall => turn.calls[0];

export const order = call(t1).outcome.data as Order;
export const hits = call(t2).outcome.data as PolicyHit[];
export const ticket = (call(t3).outcome.data as { return_id: string; refund: number; shipping_paid_by: string; days_since_signed: number });
export const days = ticket.days_since_signed;

/** 第 k 轮的回复刚到、工具还没执行时的历史：这一轮的请求消息 + 这条助手消息。 */
const afterReply = (turn: AgentTurn): MessageParam[] => [...turn.request.messages, run.messages[turn.request.messages.length]];
/** 第 k 轮工具结果回填之后的历史：就是下一轮请求里的消息。 */
const afterResults = (turn: AgentTurn): MessageParam[] => run.messages.slice(0, turn.request.messages.length + 2);

/** 历史里每块的 token 数：取自包含它的那一轮请求的展开结果；最后一条回答不在任何请求里，按输出 token 数。 */
function blocksAt(messages: MessageParam[]): BlockCell[] {
  const next = run.turns.find((turn) => turn.request.messages.length >= messages.length);
  const lastAnswer = run.messages.length - 1;
  const extra = next ? {} : { [lastAnswer]: t4.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? t4).breakdown.prompt, extra);
}
const history = (messages: MessageParam[], lift: number[] = []) => historyRow('h', blocksAt(messages), { w: 46, lift });
const liftLast = (messages: MessageParam[], n: number) => {
  const total = blocksAt(messages).length;
  return Array.from({ length: n }, (_, i) => total - n + i);
};

// ---------- 文案用到的数 ----------

const fixed = fixedTokens(t1);
const toolDefsBytes = (() => {
  const span = encodeJson(t1.request).spans.find((item) => item.path === 'tools')!;
  return span.to - span.from;
})();

export const numbers = {
  turns: run.totals.turns,
  toolCalls: run.turns.reduce((sum, turn) => sum + turn.calls.length, 0),
  toolDefsCount: SUPPORT.tools.specs.length,
  maxTurns: DEFAULT_MAX_TURNS,
  inputs: run.turns.map((turn) => turn.message.usage.input_tokens),
  outputs: run.turns.map((turn) => turn.message.usage.output_tokens),
  cumulative: run.turns.map((turn) => turn.after.input),
  totalInput: run.totals.input,
  totalOutput: run.totals.output,
  cost: formatUsd(run.totals.cost),
  costs: run.turns.map((turn) => formatUsd(turn.cost.total)),
  toolSystem: t1.toolSystem,
  toolDefs: t1.breakdown.tools,
  toolDefsBytes,
  system: t1.breakdown.system,
  fixed,
  fixedShare: pct((fixed * run.totals.turns) / run.totals.input),
  messagesPerTurn: run.turns.map((turn) => turn.request.messages.length),
  requestBytes: run.turns.map((turn) => turn.http.request.bytes.length),
  responseBytes: run.turns.map((turn) => turn.http.response.bytes.length),
  userBytes: utf8Encode(USER_ASK).length,
  days,
  signed: dateText(order.signed_at!),
  returnId: ticket.return_id,
  refund: ticket.refund,
  topHit: hits[0].id,
  topScore: hits[0].score,
  hits: hits.length,
  policyDocs: POLICIES.length,
  queryTerms: termsOf(POLICY_QUERY).length,
  growth: t4.message.usage.input_tokens - t1.message.usage.input_tokens,
  inputPrice: formatPrice(priceOf(MODEL).input),
  outputPrice: formatPrice(priceOf(MODEL).output),
};
const N = numbers;

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };

function requestWire(turn: AgentTurn, expand: string[], notes: Record<string, string>) {
  return wire(`第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'], notes: { 'x-api-key': `API 密钥（示例长度 ${EXAMPLE_API_KEY.length} 个字符，这里打码）。`, 'content-length': `请求体 ${num(turn.http.request.bytes.length - turn.http.request.body[0])} 字节。` } }),
    jsonBody('请求体', encodeJson(turn.request), {
      expand,
      notes: {
        system: '系统提示：每一轮都原样带上。',
        tools: `三个工具的定义（name、description、input_schema），每一轮都原样带上：展开后 ${N.toolDefs} 个 token（本站分词器），另外 API 还会自动加一段工具系统提示（文档给的数：${N.toolSystem} 个 token）。`,
        messages: `到目前为止的全部消息，共 ${turn.request.messages.length} 条。API 是无状态的，历史每一轮都要整份重发。`,
        ...notes,
      },
    }));
}

function responseWire(turn: AgentTurn, notes: Record<string, string>) {
  const json = encodeJson(turn.message);
  const blocks = turn.message.content.map((_, i) => `content[${i}]`);
  return wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'], notes: { 'request-id': '这次请求的 id（示例）。' } }),
    jsonBody('响应体', json, {
      expand: [...blocks, 'usage.input_tokens', 'usage.output_tokens'],
      example: ['id', 'content', ...blocks, 'usage', 'usage.input_tokens', 'usage.output_tokens'],
      notes: {
        stop_reason: turn.message.stop_reason === 'tool_use' ? 'tool_use：模型要调用工具，等工具结果回来再接着写。循环因此继续。' : 'end_turn：模型说完了。循环到此停下。',
        'usage.input_tokens': `本站分词器的计数加上工具系统提示 ${N.toolSystem}（示例）。`,
        'usage.output_tokens': '本站分词器数出的输出 token（示例）。',
        ...notes,
      },
    }));
}

const toolUseWire = (c: ToolCall, note: string) =>
  wire(`tool_use：${c.use.name}`, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'], notes: { id: '这次调用的 id（示例），结果要用它对回来。', name: '要执行的工具。', input: note } }));

const toolResultWire = (c: ToolCall, note: string) =>
  wire(`tool_result：${c.use.name}`, 'mem', 'format', jsonBody('tool_result 块', encodeJson(c.result), { notes: { tool_use_id: `和 tool_use 的 id 一样：${c.use.id}。`, content: note } }));

// ---------- 事件 ----------

/** 一轮模型调用：请求出去（累计数还没变），响应回来（累计数加上这一轮的输入）。 */
function roundTrip(turn: AgentTurn, label: string, payload: string[], requestNotes: Record<string, string>, responseNotes: Record<string, string>, before: MessageParam[]): LessonEvent[] {
  const expand = turn.index === 1 ? ['messages[0]'] : [`messages[${turn.request.messages.length - 2}]`, `messages[${turn.request.messages.length - 1}]`];
  const reply = afterReply(turn);
  return [
    pk('agent', 'llm', 'blue', `第 ${turn.index} 轮请求`, [`${turn.request.messages.length} 条消息`, `${num(turn.http.request.bytes.length)} 字节`], [turn.before.input, 'HTTP', `POST /v1/messages：system、${N.toolDefsCount} 个工具、${turn.request.messages.length} 条消息`, turn.http.request.bytes.length], requestWire(turn, expand, requestNotes), { ds: { messages: [history(before)] } }),
    pk('llm', 'agent', 'green', label, payload, [turn.after.input, 'INFER', `stop_reason ${turn.message.stop_reason}：输入 ${num(turn.message.usage.input_tokens)}、输出 ${turn.message.usage.output_tokens} token`, turn.http.response.bytes.length], responseWire(turn, responseNotes), { ds: { messages: [history(reply, liftLast(reply, turn.message.content.length))], usage: [ledgerGrid('u', run.turns.slice(0, turn.index))] } }),
    state('agent', { 轮次: `${turn.index} / ${N.maxTurns}`, stop_reason: turn.message.stop_reason }),
  ];
}

function resultBack(turn: AgentTurn, label: string, payload: string[], info: string, noteText: string): LessonEvent {
  const c = call(turn);
  const after = afterResults(turn);
  return pk('tools', 'agent', 'teal', label, payload, [turn.after.input, 'RESULT', info, encodeJson(c.result).bytes.length], toolResultWire(c, noteText), { ds: { messages: [history(after, liftLast(after, 1))] } });
}

const u1 = afterReply(t1);
const c1 = call(t1);
const c2 = call(t2);
const c3 = call(t3);
const orderJson = encodeJson(order);
const hitsJson = encodeJson(hits.map((hit) => ({ id: hit.id, score: +hit.score.toFixed(3) })));
const ticketJson = encodeJson(shop.returns[0]);
const final = run.final;
/** 文案里引用模型写的话时去掉末尾的句号（detail 按句号数句子）。 */
const quote = (text: string): string => `「${text.replace(/[。！？]$/, '')}」`;
const thought = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');

export const react: Lesson = {
  id: 'react',
  name: 'REACT',
  title: 'ReAct：思考 → 行动 → 观察',
  group: 'loop',
  layer: [4, 5],
  layerNote: '这课在「工具」和「循环」两档：模型决定调用哪个工具，运行时执行工具、回填结果，再决定要不要继续下一轮。',
  tokensNote: `四轮请求的 usage.input_tokens 依次是 ${N.inputs.map(num).join('、')}，累计 ${num(N.totalInput)}。`,
  nodes: ['app', 'agent', 'llm', 'tools', 'db', 'policy', 'messages', 'usage'],
  place: { app: [90, 150], agent: [520, 300], llm: [840, 90], tools: [800, 500], db: [1050, 360], policy: [1050, 620], messages: [480, 730], usage: [90, 520] },
  labels: {
    app: ['应用界面', '客服对话框'],
    agent: ['Agent 运行时', '循环：请求 → 工具 → 回填'],
    llm: ['模型', `${MODEL}`],
    tools: ['工具执行端', '查订单、查规则、建单'],
    db: ['订单库', '订单和退货单'],
    policy: ['规则库', `${N.policyDocs} 段规则，BM25`],
    messages: ['消息历史', '每格一个内容块的 token'],
    usage: ['账', '每轮的输入、输出 token'],
  },
  labelAt: { messages: [-250, 40], usage: [0, 150] },
  radius: { messages: 70, usage: 70 },
  initial: { messages: [], usage: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '用户的话'], ['green', '模型写的想法和回答'], ['amber', '行动：tool_use'], ['teal', '观察：tool_result'], [null, '输入列：模型累计读入的 token']],
  overview: {
    full: '一个 Agent 怎样一步步把事办完',
    description: `Agent 就是一个循环：模型看着到目前为止的全部对话，写一句想法、决定调用哪个工具；运行时真的去执行，把结果交回；模型看了结果再决定下一步，直到它说「好了」。这一课的客服 Agent 收到「${USER_ASK.replace(/。$/, '')}」，用 ${N.turns} 轮模型调用、${N.toolCalls} 次工具调用查订单、查规则、建好退货单。每一轮都要把整段历史重新发一次，所以输入 token 一轮比一轮多，${N.turns} 轮累计 ${num(N.totalInput)} 个。`,
    facts: [
      ['任务', '订单 A1024 杯盖漏水，退货'],
      ['工具', 'get_order、search_policy、create_return'],
      ['模型调用', `${N.turns} 轮，stop_reason 前三轮 tool_use、最后 end_turn`],
      ['累计输入', `${num(N.totalInput)} token`],
      ['费用', `${N.cost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: '第一轮：想一步，做一步',
      desc: `请求带 system、3 个工具、1 条用户消息`,
      detail: `运行时把用户的话放进 messages，连同 system 和三个工具的定义一起发给模型，这一轮输入 ${num(N.inputs[0])} 个 token。模型先写一句想法${quote(thought(t1))}，再写一个 tool_use 块，要求调用 get_order 查订单 A1024，stop_reason 是 tool_use。这就是 ReAct（Yao 等，ICLR 2023）的做法：推理和行动交替出现，每一步的想法决定下一个行动。`,
      facts: [['输入', `${num(N.inputs[0])} token`], ['其中工具定义', `${N.toolDefs} + 工具系统提示 ${N.toolSystem}`], ['输出', `${N.outputs[0]} token`], ['stop_reason', 'tool_use']],
      events: [
        type('A1024 杯盖漏水，想退货'),
        pk('app', 'agent', 'blue', '用户的请求', [preview(USER_ASK, 18)], [0, 'CALL', `用户的话交给运行时，作为第一条 user 消息`, N.userBytes], wire('用户的话', 'mem', 'format', utf8Lines('content', USER_ASK, { summary: `UTF-8 ${N.userBytes} 字节，成为 messages[0] 的 content` })), { ds: { messages: [history([run.messages[0]])] } }),
        show('messages', 'usage'),
        ...roundTrip(t1, 'tool_use: get_order', [`想法：${preview(thought(t1), 12)}`, 'get_order(A1024)'], { 'messages[0]': '用户的请求。' }, { 'content[0]': '想法（示例）：模型先说明它要做什么。', 'content[1]': '行动（示例）：调用 get_order，参数 order_id 是 A1024。' }, [run.messages[0]]),
      ],
    },
    {
      title: '执行工具，回填观察',
      desc: `get_order 在订单库里查到 A1024`,
      detail: `模型只会请求调用，执行的是运行时：它按 input_schema 检查参数（order_id 要匹配 A 加四位数字），再去订单库里查。查到的订单写成 JSON，装进一个 tool_result 块，tool_use_id 和刚才的 tool_use 一样，放进一条新的 user 消息。现在历史有 ${N.messagesPerTurn[1]} 条消息：用户的话、模型的想法和调用、工具的结果。`,
      facts: [['参数', 'order_id: A1024，校验通过'], ['签收', `${order.signed_at}（${N.signed}）`], ['实付', `${order.amount} 元`], ['历史', `${N.messagesPerTurn[1]} 条消息`]],
      events: [
        show('tools', 'db'),
        pk('agent', 'tools', 'amber', 'get_order', ['order_id: A1024'], [t1.after.input, 'TOOL', '运行时按 input_schema 校验参数，执行 get_order', encodeJson(c1.use).bytes.length], toolUseWire(c1, 'order_id 要匹配 ^A\\d{4}$，校验通过。'), { ds: { messages: [history(u1, liftLast(u1, 1))] } }),
        pk('tools', 'db', 'amber', '查订单 A1024', ['orders.get("A1024")'], [t1.after.input, 'TOOL', '在内存订单表里按订单号查', utf8Encode('A1024').length], wire('查询的键', 'mem', 'internal', utf8Lines('order_id', 'A1024', { summary: '本站的订单表是内存里的 Map，按订单号取' }))),
        pk('db', 'tools', 'teal', '订单记录', [`${order.item}`, `签收 ${order.signed_at}`], [t1.after.input, 'TOOL', `查到：${order.item}，${order.amount} 元，${order.signed_at} 签收`, orderJson.bytes.length], wire('订单记录（本站的示例数据）', 'mem', 'internal', jsonBody('order', orderJson, { notes: { signed_at: '签收日期：退货期限从这天算起。', amount: '实付金额，元。' } }))),
        resultBack(t1, 'tool_result', ['订单 JSON', `${encodeJson(c1.result).bytes.length} 字节`], '订单 JSON 装进 tool_result，放进新的 user 消息', '订单记录的 JSON 文字，模型下一轮会读到它。'),
        note('messages', `历史 ${N.messagesPerTurn[1]} 条消息`),
      ],
    },
    {
      title: '第二轮：带着历史再问一次',
      desc: `输入涨到 ${num(N.inputs[1])}，模型去查规则`,
      detail: `第二轮的请求把 ${N.messagesPerTurn[1]} 条消息整份重发，输入涨到 ${num(N.inputs[1])} 个 token，累计 ${num(N.cumulative[1])}。模型读到签收日期，写下${quote(thought(t2))}，调用 search_policy。规则库用 BM25 打分，${N.topHit}（《售后规则》第 3 条）得分最高，和第二名一起作为 tool_result 交回。`,
      facts: [['输入', `${num(N.inputs[1])} token`], ['累计', `${num(N.cumulative[1])} token`], ['查询', POLICY_QUERY], ['最相关', `${N.topHit}，${N.topScore.toFixed(2)} 分`]],
      events: [
        ...roundTrip(t2, 'tool_use: search_policy', [`想法：${preview(thought(t2), 12)}`, 'search_policy'], { [`messages[${t2.request.messages.length - 1}]`]: '上一轮的工具结果，作为 user 消息。' }, { 'content[1]': `行动（示例）：查询词「${POLICY_QUERY}」。` }, afterResults(t1)),
        show('policy'),
        pk('agent', 'tools', 'amber', 'search_policy', [`query: ${POLICY_QUERY}`], [t2.after.input, 'TOOL', '校验参数，执行 search_policy', encodeJson(c2.use).bytes.length], toolUseWire(c2, `查询词（示例），至少 2 个字符；top_k 不写，默认 2。`), { ds: { messages: [history(afterReply(t2), liftLast(afterReply(t2), 1))] } }),
        pk('tools', 'policy', 'amber', 'BM25 检索', [`${N.queryTerms} 个词`], [t2.after.input, 'TOOL', `查询切成 ${N.queryTerms} 个词，给 ${N.policyDocs} 段规则打分`, utf8Encode(POLICY_QUERY).length], wire('查询词', 'mem', 'format', utf8Lines('query', POLICY_QUERY), concept('切出来的词', termsOf(POLICY_QUERY).map((term, i): [string, string] => [`${i}`, term]), 'blue', '汉字按相邻两个字切（和 RAG EXPLORER 的 BM25 同一套）'))),
        pk('policy', 'tools', 'teal', `前 ${N.hits} 段`, hits.map((hit) => `${hit.id} ${hit.score.toFixed(2)}`), [t2.after.input, 'TOOL', `${N.topHit} 得分 ${N.topScore.toFixed(2)}，最高`, hitsJson.bytes.length], wire('BM25 的前两段（本站的检索结果）', 'mem', 'internal', jsonBody('hits', hitsJson, { expand: ['[0].score'] }), concept('分数从高到低', hits.map((hit): [string, string, string] => [hit.id, hit.score.toFixed(3), hit.text])))),
        resultBack(t2, 'tool_result', ['两段规则原文'], '两段规则的原文装进 tool_result', '两段规则的原文，每段前面写着它的编号。'),
      ],
    },
    {
      title: '第三轮：判断能退，建退货单',
      desc: `签收 ${N.days} 天，在 ${QUALITY_RETURN_DAYS} 天之内`,
      detail: `第三轮输入 ${num(N.inputs[2])} 个 token。模型读到「签收后 ${QUALITY_RETURN_DAYS} 天内，质量问题可退款或换货」，算出从 ${N.signed}到今天（${dateText(TODAY)}）是 ${N.days} 天，调用 create_return。真正把关的是工具：它自己再算一遍签收天数，超过 ${QUALITY_RETURN_DAYS} 天会返回 is_error 的结果，这次没超，就在订单库里建了退货单 ${N.returnId}。`,
      facts: [['输入', `${num(N.inputs[2])} token`], ['签收天数', `${N.days} 天（工具算的）`], ['退货单', N.returnId], ['应退', `${N.refund} 元，运费店铺出`]],
      events: [
        ...roundTrip(t3, 'tool_use: create_return', [`想法：${preview(thought(t3), 12)}`, 'create_return'], {}, { 'content[1]': '行动（示例）：reason 是 quality，质量问题。' }, afterResults(t2)),
        pk('agent', 'tools', 'amber', 'create_return', ['reason: quality', 'note: 杯盖漏水'], [t3.after.input, 'TOOL', '校验参数，执行 create_return', encodeJson(c3.use).bytes.length], toolUseWire(c3, 'reason 只能是 quality 或 no_reason，note 最多 100 个字符。'), { ds: { messages: [history(afterReply(t3), liftLast(afterReply(t3), 1))] } }),
        pk('tools', 'db', 'amber', `建单 ${N.returnId}`, [`签收 ${N.days} 天 ≤ ${QUALITY_RETURN_DAYS}`], [t3.after.input, 'TOOL', `${order.signed_at} 到 ${TODAY} 是 ${N.days} 天，没超过 ${QUALITY_RETURN_DAYS} 天，写入退货单`, ticketJson.bytes.length], wire('写入的退货单（本站的示例数据）', 'mem', 'internal', jsonBody('ticket', ticketJson, { notes: { return_id: '退货单号：R + 日期 + 序号（本站的写法）。', shipping_paid_by: 'shop：质量问题，运费由店铺承担。' } }), concept('工具自己的判断', [['签收日期', order.signed_at!], ['今天', TODAY], ['天数', `${N.days}`, '按日历日相减。'], ['期限', `${QUALITY_RETURN_DAYS} 天`, '《售后规则》第 3 条。']]))),
        resultBack(t3, 'tool_result', [N.returnId, `退 ${N.refund} 元`], `退货单 ${N.returnId} 建好，结果交回`, '退货单号、应退金额、运费谁出、签收天数。'),
      ],
    },
    {
      title: '第四轮：回答，循环停下',
      desc: `stop_reason 是 end_turn，${N.turns} 轮累计 ${num(N.totalInput)}`,
      detail: `第四轮输入 ${num(N.inputs[3])} 个 token，比第一轮多 ${num(N.growth)}，多出来的就是一轮轮累积的想法、调用和结果。这次模型只写文字、不再调用工具，stop_reason 是 end_turn，运行时据此停下循环，把回答交给界面。${N.turns} 轮累计输入 ${num(N.totalInput)}、输出 ${num(N.totalOutput)} token，按示例单价是 ${N.cost}，其中每轮都重复带上的 system、工具定义和工具系统提示（${num(N.fixed)} 个）占了输入的 ${N.fixedShare}。`,
      facts: [['输入', `${num(N.inputs[3])} token`], ['累计输入', `${num(N.totalInput)} token`], ['累计输出', `${num(N.totalOutput)} token`], ['费用', `${N.cost}`]],
      events: [
        ...roundTrip(t4, 'end_turn：回答', [preview(final, 16)], {}, { 'content[0]': '回答（示例）：退货单号和金额来自工具结果。' }, afterResults(t3)),
        pk('agent', 'app', 'green', '回答', [preview(final, 18)], [t4.after.input, 'STOP', `stop_reason 是 end_turn，循环停下，回答交给界面`, utf8Encode(final).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', final, { summary: '最后一条助手消息的 text 块（示例）' }), concept('循环的账', [['轮数', `${N.turns} / ${N.maxTurns}`, '本站默认最多 10 轮，没用完。'], ['累计输入', num(N.totalInput), '四轮 usage.input_tokens 之和。'], ['累计输出', num(N.totalOutput)], ['费用', N.cost, `示例单价：输入 ${N.inputPrice}，输出 ${N.outputPrice}（${PRICE_DATE}）。`]])), { ds: { usage: [ledgerGrid('u', run.turns, { total: true })] } }),
        state('agent', { 轮次: `${N.turns} / ${N.maxTurns}`, stop_reason: 'end_turn', 状态: '停下' }),
        render,
        note('usage', `累计输入 ${num(N.totalInput)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '循环是运行时的，决定是模型的',
    desc: `${N.turns} 轮、${N.toolCalls} 次工具调用、${N.cost}`,
    text: `Agent 循环本身很短：发请求、看 stop_reason、是 tool_use 就执行工具并回填结果、再发请求，直到 end_turn。模型负责「想」和「决定调用什么」，运行时负责真正执行、校验参数、记账和停下。代价是历史每轮都要整份重发：这次 ${N.turns} 轮累计输入 ${num(N.totalInput)} 个 token，是最后一轮的 ${(N.totalInput / N.inputs[3]).toFixed(1)} 倍。本站的 token 数是迷你分词器的计数（工具系统提示用文档给的 ${N.toolSystem}），只代表量级关系。下一课看工具定义怎样变成模型看到的 token。`,
    facts: [['模型调用', `${N.turns} 轮`], ['工具调用', `${N.toolCalls} 次`], ['累计输入', `${num(N.totalInput)} token`], ['下一课', '工具定义如何进入提示']],
  },
};

