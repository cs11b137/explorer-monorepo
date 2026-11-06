/**
 * 循环组第四课：工具报错、最大轮数与停止。换一个办不成的请求：订单 A1025 的电热水壶，10 月 20 日签收，想无理由退货。
 *
 * 三次运行，都由 runAgent 真实执行：
 *   A. 正常上限：第一轮订单号少了 A，参数校验（core/schema.ts）不通过 → is_error；改对再查；create_return 自己算签收天数，
 *      超过 7 天 → is_error；模型据此改口，end_turn。
 *   B. max_tokens 只给 40：tool_use 写不下，createMessage 真实截断，stop_reason 是 max_tokens，循环没有工具可执行，停下。
 *   C. 一个不肯放弃的脚本：每轮都重试 create_return，运行时的 maxTurns = 3 到了就停（stop: 'max_turns'）。
 * 模型写的内容是脚本（E.G.）；错误信息、天数、stop_reason、轮数、token 都是算出来的。tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  createShop,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  encodeJson,
  NO_REASON_RETURN_DAYS,
  outputTokensOf,
  runAgent,
  text,
  TODAY,
  toolUse,
  type AgentConfig,
  type AgentRun,
  type AgentTurn,
  type MessageParam,
  type Order,
  type SchemaError,
  type ScriptStep,
  type ToolCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { blocksOf, historyRow, type BlockCell } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { dateText, MODEL, SUPPORT } from './scenario';
import type { DsCell, GridPrim, Lesson, LessonEvent } from './types';

// ---------- 真实运行 ----------

export const ASK = '10 月买的电热水壶不想要了，订单号 1025，能退吗？';
export const BAD_ID = '1025';
export const GOOD_ID = 'A1025';

type Fail = { days: number; limit: number };

/** A：订单号写错 → 改对 → 无理由退货超期 → 改口。 */
const FIRST = [text('先查一下这个订单。'), toolUse('get_order', { order_id: BAD_ID }, 21)];
export const SCRIPT_A: ScriptStep[] = [
  FIRST,
  [text(`订单号要以 A 开头，应该是 ${GOOD_ID}，我再查一次。`), toolUse('get_order', { order_id: GOOD_ID }, 22)],
  ({ lastCalls }) => {
    const order = lastCalls[0].outcome.data as Order;
    return [text(`订单 ${dateText(order.signed_at!)}签收，用户不想要了，按无理由退货建单。`), toolUse('create_return', { order_id: GOOD_ID, reason: 'no_reason' }, 23)];
  },
  ({ lastCalls }) => {
    const { days, limit } = lastCalls[0].outcome.data as Fail;
    return [text(`抱歉，订单 ${GOOD_ID} 签收已经 ${days} 天，超过了 ${limit} 天的无理由退货期限，没法退货。如果水壶有质量问题，可以拍照告诉我，我帮您转人工确认。`)];
  },
];
export const runA = runAgent(SUPPORT, ASK, SCRIPT_A, { ctx: { shop: createShop() }, seed: 400 });
export const [a1, a2, a3, a4] = runA.turns as [AgentTurn, AgentTurn, AgentTurn, AgentTurn];

/** B：同一个第一轮，max_tokens 只给 40。 */
export const TIGHT = 40;
export const TIGHT_AGENT: AgentConfig = { ...SUPPORT, maxTokens: TIGHT };
export const runB = runAgent(TIGHT_AGENT, ASK, [FIRST], { ctx: { shop: createShop() }, seed: 410 });
export const b1 = runB.turns[0];

/** C：每一轮都重试 create_return，不肯放弃；运行时最多 3 轮。 */
export const CAP = 3;
export const SCRIPT_C: ScriptStep[] = [
  [text('用户想退货，直接建单。'), toolUse('create_return', { order_id: GOOD_ID, reason: 'no_reason' }, 31)],
  [text('换成质量问题再试一次。'), toolUse('create_return', { order_id: GOOD_ID, reason: 'quality', note: '不想要了' }, 32)],
  [text('再试一次。'), toolUse('create_return', { order_id: GOOD_ID, reason: 'quality', note: '水壶有问题' }, 33)],
];
export const runC = runAgent(SUPPORT, `订单 ${GOOD_ID} 的水壶不想要了，帮我退掉。`, SCRIPT_C, { ctx: { shop: createShop() }, seed: 420, maxTurns: CAP });

const call = (turn: AgentTurn): ToolCall => turn.calls[0];
export const idErrors = call(a1).outcome.data as SchemaError[];
export const order = call(a2).outcome.data as Order;
export const fail = call(a3).outcome.data as Fail;

// ---------- 记账：三次运行接着累计 ----------

const offsetB = runA.totals.input;
const offsetC = runA.totals.input + runB.totals.input;
const at = (run: AgentRun, turn: AgentTurn, when: 'before' | 'after'): number => (run === runA ? 0 : run === runB ? offsetB : offsetC) + turn[when].input;

// ---------- 文案用到的数 ----------

export const numbers = {
  turnsA: runA.totals.turns,
  stopA: runA.stop,
  stopsA: runA.turns.map((turn) => turn.message.stop_reason),
  errorsA: runA.turns.map((turn) => turn.calls.filter((c) => c.result.is_error).length),
  inputsA: runA.turns.map((turn) => turn.message.usage.input_tokens),
  totalA: runA.totals.input,
  idMessage: call(a1).outcome.content,
  days: fail.days,
  limit: fail.limit,
  failMessage: call(a3).outcome.content,
  signed: dateText(order.signed_at!),
  tight: TIGHT,
  stopB: runB.stop,
  outB: b1.message.usage.output_tokens,
  blocksB: b1.message.content.map((block) => block.type),
  callsB: b1.calls.length,
  toolUseTokens: outputTokensOf(FIRST[1]),
  textTokens: outputTokensOf(FIRST[0]),
  totalB: runB.totals.input,
  cap: CAP,
  stopC: runC.stop,
  turnsC: runC.totals.turns,
  stopsC: runC.turns.map((turn) => turn.message.stop_reason),
  errorsC: runC.turns.map((turn) => turn.calls.filter((c) => c.result.is_error).length),
  totalC: runC.totals.input,
  messagesC: runC.messages.length,
  lastRoleC: runC.messages[runC.messages.length - 1].role,
  grand: runA.totals.input + runB.totals.input + runC.totals.input,
  maxTokens: DEFAULT_MAX_TOKENS,
  maxTurns: DEFAULT_MAX_TURNS,
};
const N = numbers;

// ---------- 图元 ----------

function blocksAt(run: AgentRun, messages: MessageParam[]): BlockCell[] {
  const next = run.turns.find((turn) => turn.request.messages.length >= messages.length);
  const last = run.turns[run.turns.length - 1];
  const extra = next ? {} : { [messages.length - 1]: last.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? last).breakdown.prompt, extra);
}
const afterReply = (run: AgentRun, turn: AgentTurn): MessageParam[] => [...turn.request.messages, run.messages[turn.request.messages.length]];
const afterResults = (run: AgentRun, turn: AgentTurn): MessageParam[] => run.messages.slice(0, turn.request.messages.length + 2);
const tail = (blocks: BlockCell[], n: number) => Array.from({ length: n }, (_, i) => blocks.length - n + i);
const history = (run: AgentRun, messages: MessageParam[], lift = 0) => {
  const blocks = blocksAt(run, messages);
  return historyRow('h', blocks, { w: 46, lift: tail(blocks, lift) });
};

/** 每次运行停在哪一轮、为什么停：行名是停下的原因，格子是轮数、出错次数、累计输入。 */
const STOP_TONE: Record<string, DsCell['tone']> = { end_turn: 'green', max_tokens: 'amber', max_turns: 'amber' };
const stopGrid = (runs: AgentRun[]): GridPrim => ({
  kind: 'grid',
  id: 'st',
  w: 60,
  rows: runs.map((run) => run.stop),
  cols: ['轮数', '出错', '输入'],
  cells: runs.map((run): DsCell[] => [
    { v: String(run.totals.turns), tone: STOP_TONE[run.stop] },
    { v: String(run.turns.reduce((sum, turn) => sum + turn.calls.filter((c) => c.result.is_error).length, 0)), tone: 'amber' },
    { v: String(run.totals.input), tone: 'blue' },
  ]),
});

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const requestWire = (turn: AgentTurn, notes: Record<string, string> = {}) =>
  wire(`第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
    jsonBody('请求体', encodeJson(turn.request), { expand: [`messages[${turn.request.messages.length - 1}]`], notes: { max_tokens: `这一轮最多写 ${turn.request.max_tokens} 个输出 token。`, ...notes } }));
const responseWire = (turn: AgentTurn, notes: Record<string, string>) => {
  const blocks = turn.message.content.map((_, i) => `content[${i}]`);
  return wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), { expand: [...blocks, 'usage.output_tokens'], example: ['id', 'content', ...blocks, 'usage', 'usage.input_tokens', 'usage.output_tokens'], notes }));
};
const resultWire = (c: ToolCall, noteText: string, extra?: ReturnType<typeof concept>) =>
  wire(`tool_result：${c.use.name}`, 'mem', 'format', ...[jsonBody('tool_result 块', encodeJson(c.result), { notes: { is_error: 'true：这次调用失败了，content 写的是原因。', content: noteText } }), ...(extra ? [extra] : [])]);

const thought = (turn: AgentTurn): string => (turn.message.content[0].type === 'text' ? turn.message.content[0].text : '');
const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;

/** 一轮：请求、响应；有工具调用就执行并回填。 */
function turnEvents(run: AgentRun, turn: AgentTurn, label: string, payload: string[], responseNotes: Record<string, string>, toolNote: string, resultLabel: string[]): LessonEvent[] {
  const events: LessonEvent[] = [
    pk('agent', 'llm', 'blue', `第 ${turn.index} 轮请求`, [`${turn.request.messages.length} 条消息`, `max_tokens ${turn.request.max_tokens}`], [at(run, turn, 'before'), 'HTTP', `POST /v1/messages：${turn.request.messages.length} 条消息`, turn.http.request.bytes.length], requestWire(turn), { ds: { messages: [history(run, turn.request.messages)] } }),
    pk('llm', 'agent', turn.message.stop_reason === 'end_turn' ? 'green' : 'amber', label, payload, [at(run, turn, 'after'), 'INFER', `stop_reason ${turn.message.stop_reason}：输入 ${num(turn.message.usage.input_tokens)}、输出 ${turn.message.usage.output_tokens}`, turn.http.response.bytes.length], responseWire(turn, responseNotes), { ds: { messages: [history(run, afterReply(run, turn), turn.message.content.length)] } }),
  ];
  for (const c of turn.calls) {
    events.push(pk('agent', 'tools', 'amber', c.use.name, Object.entries(c.use.input).map(([key, value]) => `${key}: ${String(value)}`), [at(run, turn, 'after'), 'TOOL', `校验参数，执行 ${c.use.name}`, encodeJson(c.use).bytes.length], wire(`tool_use：${c.use.name}`, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'], notes: { input: toolNote } }))));
    events.push(pk('tools', 'agent', c.result.is_error ? 'amber' : 'teal', c.result.is_error ? 'is_error' : 'tool_result', resultLabel, [at(run, turn, 'after'), c.result.is_error ? 'ERROR' : 'RESULT', c.result.is_error ? `is_error：${c.outcome.content}` : `结果交回：${preview(c.outcome.content, 30)}`, encodeJson(c.result).bytes.length], resultWire(c, c.result.is_error ? '错误原因：模型下一轮会读到它。' : '订单记录的 JSON。'), { lost: c.result.is_error || undefined, ds: { messages: [history(run, afterResults(run, turn), 1)] } }));
  }
  return events;
}

const STOP_REASONS: Array<[string, string, string]> = [
  ['end_turn', '模型说完了', '循环停下，回答交给用户。'],
  ['tool_use', '模型要调用工具', '执行全部 tool_use，回填结果，继续。'],
  ['max_tokens', '写到了 max_tokens', '内容不完整；截断的 tool_use 不能执行，加大 max_tokens 重试。'],
  ['stop_sequence', '碰到了 stop_sequences 里的串', '按应用的约定处理。'],
  ['pause_turn', '服务器端工具的循环到了上限', '只在用服务器端工具（如网页搜索）时出现，原样发回让它接着跑。'],
  ['refusal', '模型拒绝了', '不要执行这一轮的任何工具。'],
  ['model_context_window_exceeded', '写满了上下文窗口', '内容不完整。'],
];

export const stopping: Lesson = {
  id: 'stopping',
  name: 'STOPPING',
  title: '工具报错、最大轮数与停止',
  group: 'loop',
  layer: [4, 5],
  layerNote: '这课在「工具」和「循环」两档：工具报错是一次调用的事，什么时候停下是整个循环的事。',
  tokensNote: `三次运行接着累计：正常的一次 ${N.turnsA} 轮 ${num(N.totalA)}，max_tokens 截断的一次 1 轮 ${num(N.totalB)}，到最大轮数停下的一次 ${N.turnsC} 轮 ${num(N.totalC)}，共 ${num(N.grand)}。`,
  nodes: ['app', 'agent', 'llm', 'tools', 'db', 'messages', 'turns'],
  place: { app: [90, 150], agent: [520, 300], llm: [840, 90], tools: [820, 500], db: [1070, 420], messages: [500, 740], turns: [100, 470] },
  labels: {
    app: ['应用界面', '客服对话框'],
    agent: ['Agent 运行时', '执行、回填、判断停止'],
    llm: ['模型', MODEL],
    tools: ['工具执行端', '先校验参数，再按规则办'],
    db: ['订单库', '订单和退货单'],
    messages: ['消息历史', '每格一个内容块的 token'],
    turns: ['停止', '每次运行停在哪、为什么'],
  },
  labelAt: { messages: [-250, 40], turns: [0, 130] },
  radius: { messages: 70, turns: 80 },
  initial: { messages: [], turns: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '用户的话'], ['green', '模型写的文字'], ['amber', '行动和出错的结果'], ['teal', '正常的结果'], [null, '输入列：三次运行接着累计的输入 token']],
  overview: {
    full: '出错了怎么办，什么时候必须停',
    description: `不是每次都办得成。用户要退一个 ${N.signed}签收的电热水壶，订单号还少写了一个 A。工具不会抛异常，而是回一个 is_error 的 tool_result：参数不合 schema、超过退货期限，都写成一句话交回模型，模型据此改参数重试或者改口。循环自己也要会停：模型说完了（end_turn）停，输出写到 max_tokens 被截断停，模型一直调用工具停不下来时，运行时的最大轮数替它停。`,
    facts: [
      ['订单', `${GOOD_ID}，${N.signed}签收，${N.days} 天`],
      ['工具报错', `${N.errorsA.reduce((a, b) => a + b, 0)} 次 is_error，模型改口`],
      ['max_tokens', `给 ${N.tight}，tool_use 写不下`],
      ['最大轮数', `${N.cap} 轮到了，stop 是 max_turns`],
    ],
  },
  steps: [
    {
      title: '参数不合 schema：改了再调',
      desc: `order_id 是 ${BAD_ID}，不匹配 ^A\\d{4}$`,
      detail: `用户写的订单号是 ${BAD_ID}，模型照抄进了 get_order 的参数。工具端先按 input_schema 校验，order_id 要匹配 ^A\\d{4}$，不通过就不执行，回一个 is_error 的 tool_result：「${N.idMessage}」。这是工具错误，不是程序异常，循环照常继续：第二轮模型读到这句话，又看到参数说明里的「如 A1024」，改成 ${GOOD_ID} 再查一次，查到了。`,
      facts: [['参数', `order_id: ${BAD_ID}`], ['校验', idErrors.map((error) => `${error.path}：${error.message}`).join('；')], ['重试', `order_id: ${GOOD_ID}`], ['签收', `${order.signed_at}`]],
      events: [
        type(ASK),
        pk('app', 'agent', 'blue', '用户的请求', [preview(ASK, 18)], [0, 'CALL', '用户的话交给运行时', utf8Encode(ASK).length], wire('用户的话', 'mem', 'format', utf8Lines('content', ASK)), { ds: { messages: [history(runA, [runA.messages[0]])] } }),
        show('messages', 'tools'),
        ...turnEvents(runA, a1, 'tool_use: get_order', [`order_id: ${BAD_ID}`], { 'content[1]': `照抄用户的 ${BAD_ID}（示例）。` }, `${BAD_ID} 不匹配 ^A\\d{4}$。`, ['参数不合格']),
        state('agent', { 轮次: `1 / ${N.maxTurns}`, stop_reason: 'tool_use', is_error: '1' }),
        show('db'),
        ...turnEvents(runA, a2, 'tool_use: get_order', [`order_id: ${GOOD_ID}`], { 'content[0]': `${quote(thought(a2))}（示例）。` }, '这次匹配了。', [order.item, `签收 ${order.signed_at}`]),
        state('agent', { 轮次: `2 / ${N.maxTurns}`, is_error: null }),
      ],
    },
    {
      title: '业务规则不允许：工具说了算',
      desc: `签收 ${N.days} 天，超过 ${N.limit} 天`,
      detail: `第三轮模型按无理由退货调用 create_return，参数这次是合格的。工具自己用订单库里的签收日期算出从 ${N.signed}到今天（${dateText(TODAY)}）是 ${N.days} 天，超过无理由退货的 ${NO_REASON_RETURN_DAYS} 天，没有建单，回了 is_error：「${N.failMessage}」。能不能退由工具按规则判断，不靠模型自觉，模型算错了也建不出单。`,
      facts: [['签收', `${N.signed}`], ['天数', `${N.days} 天（工具算的）`], ['期限', `${N.limit} 天`], ['结果', 'is_error，没有建单']],
      events: [
        ...turnEvents(runA, a3, 'tool_use: create_return', ['reason: no_reason'], { 'content[1]': '按无理由退货建单（示例）。' }, 'reason 是 no_reason，参数合格。', [`${N.days} 天 > ${N.limit} 天`]),
        state('agent', { 轮次: `3 / ${N.maxTurns}`, is_error: '1' }),
        note('tools', `${N.days} 天 > ${N.limit} 天`, 'amber'),
      ],
    },
    {
      title: '模型据此改口，end_turn',
      desc: `${N.turnsA} 轮，${N.errorsA.reduce((a, b) => a + b, 0)} 次出错，没有建单`,
      detail: `第四轮模型读到工具的错误，不再调用工具，直接告诉用户超过期限、退不了，stop_reason 是 end_turn，循环停下。回答里的 ${N.days} 天和 ${N.limit} 天都来自工具结果，不是模型自己算的。文档建议工具失败时照样回 tool_result 并标 is_error，而不是让循环崩掉：两次出错都变成了模型能读懂的一句话，这次 ${N.turnsA} 轮累计输入 ${num(N.totalA)}。`,
      facts: [['stop_reason', 'end_turn'], ['轮数', `${N.turnsA} / ${N.maxTurns}`], ['is_error', `${N.errorsA.reduce((a, b) => a + b, 0)} 次`], ['累计输入', `${num(N.totalA)} token`]],
      events: [
        show('turns'),
        ...turnEvents(runA, a4, 'end_turn：回答', [preview(runA.final, 16)], { stop_reason: 'end_turn：模型说完了，循环停下。', 'content[0]': '回答（示例）：天数和期限来自工具结果。' }, '', []),
        pk('agent', 'app', 'green', '回答', [preview(runA.final, 18)], [a4.after.input, 'STOP', 'stop_reason 是 end_turn，循环停下，回答交给界面', utf8Encode(runA.final).length], wire('交给界面的回答', 'mem', 'format', utf8Lines('text', runA.final)), { ds: { turns: [stopGrid([runA])] } }),
        render,
        state('agent', { 轮次: `${N.turnsA} / ${N.maxTurns}`, stop_reason: 'end_turn', is_error: null }),
      ],
    },
    {
      title: 'max_tokens 太小：tool_use 被截掉',
      desc: `max_tokens ${N.tight}，stop_reason max_tokens`,
      detail: `把 max_tokens 从 ${N.maxTokens} 改成 ${N.tight} 再跑第一轮：想法写完用了 ${N.textTokens} 个 token，后面的 tool_use 要 ${N.toolUseTokens} 个，写不下，stop_reason 是 max_tokens，这一轮的输出停在 ${N.outB} 个。循环只在 tool_use 时继续，这次没有可执行的调用，运行时停下，用户什么也没得到。文档说截断的回复里最后可能是一个不完整的 tool_use 块，不能执行，要加大 max_tokens 重试；本站的 createMessage 把写不下的块整块丢掉（简化）。`,
      facts: [['max_tokens', `${N.tight}`], ['输出', `${N.outB} token`], ['content', N.blocksB.join('、')], ['执行的工具', `${N.callsB} 个`]],
      events: [
        state('agent', { 轮次: `1 / ${N.maxTurns}`, max_tokens: `${N.tight}`, stop_reason: null }),
        pk('agent', 'llm', 'blue', `max_tokens: ${N.tight}`, ['同一个第一轮'], [offsetB, 'HTTP', `同一个第一轮请求，max_tokens 改成 ${N.tight}`, b1.http.request.bytes.length], requestWire(b1, { max_tokens: `只给 ${N.tight} 个输出 token。` }), { ds: { messages: [history(runB, b1.request.messages)] } }),
        pk('llm', 'agent', 'amber', 'stop_reason: max_tokens', [`输出 ${N.outB} token`, 'tool_use 没写完'], [offsetB + b1.after.input, 'INFER', `max_tokens 截断：输出 ${N.outB} 个 token，content 只剩 ${N.blocksB.join('、')}`, b1.http.response.bytes.length], responseWire(b1, { stop_reason: 'max_tokens：写到上限被截断。', 'content[0]': `想法写完了（${N.textTokens} token），后面的 tool_use（要 ${N.toolUseTokens} token）放不下。` }), { ds: { messages: [history(runB, runB.messages, 1)] } }),
        pk('agent', 'turns', 'amber', '停下', ['没有 tool_use', `stop: ${N.stopB}`], [offsetB + b1.after.input, 'STOP', `stop_reason 不是 tool_use，没有工具可执行，循环停下（stop: ${N.stopB}）`, null], wire('停止判断', 'mem', '示意', concept('runAgent 的判断', [['stop_reason', N.stopB, '不是 tool_use：不执行工具，停下。'], ['content', N.blocksB.join('、'), '截断的 tool_use 不能执行。'], ['该怎么办', `max_tokens 改回 ${N.maxTokens} 重试`, '文档：加大 max_tokens 重新请求。']])), { ds: { turns: [stopGrid([runA, runB])] } }),
        state('agent', { stop_reason: N.stopB }),
      ],
    },
    {
      title: '停不下来：运行时的最大轮数',
      desc: `${N.cap} 轮到了，stop 是 max_turns`,
      detail: `换一个不肯放弃的脚本：模型每一轮都重试 create_return，换个 reason 还是超期，${N.turnsC} 轮全是 is_error，stop_reason 一直是 tool_use，照这样模型自己不会停。运行时的最大轮数（这里设成 ${N.cap}，本站默认 ${N.maxTurns}）到了就停，stop 记成 max_turns，最后一轮的结果已经回填却没人读，历史停在一条 ${N.lastRoleC} 消息上。max_turns 不是 Messages API 的 stop_reason，是运行时自己的上限，应用要告诉用户「没办成」，而不是把半截的想法当回答。`,
      facts: [['maxTurns', `${N.cap}`], ['is_error', N.errorsC.join('、')], ['stop', N.stopC], ['累计输入', `${num(N.totalC)} token`]],
      events: [
        state('agent', { 轮次: `0 / ${N.cap}`, max_tokens: null, stop_reason: null }),
        ...runC.turns.flatMap((turn) => [
          ...turnEvents(runC, turn, `第 ${turn.index} 次重试`, [`reason: ${String(call(turn).use.input.reason)}`], { 'content[1]': '又一次 create_return（示例）。' }, `第 ${turn.index} 次 create_return（示例）。`, [`${N.days} 天 > ${N.limit} 天`]),
          state('agent', { 轮次: `${turn.index} / ${N.cap}`, stop_reason: turn.message.stop_reason }),
        ]),
        pk('agent', 'turns', 'amber', 'max_turns', [`${N.turnsC} / ${N.cap} 轮`, '模型还想继续'], [offsetC + runC.totals.input, 'STOP', `到了 maxTurns = ${N.cap}，运行时停下（stop: ${N.stopC}）`, null], wire('stop_reason 和循环的停止', 'mem', '示意', concept('runAgent 的判断', [['轮数', `${N.turnsC} / ${N.cap}`, `第 ${N.cap} 轮的 stop_reason 还是 tool_use。`], ['stop', N.stopC, '运行时自己的上限，不是 API 的 stop_reason。'], ['最后一条消息', N.lastRoleC, '工具结果回填了，但没有下一轮去读它。']]), concept('stop_reason 的取值（文档）', STOP_REASONS)), { ds: { turns: [stopGrid([runA, runB, runC])] } }),
        state('agent', { 轮次: `${N.cap} / ${N.cap}`, stop_reason: 'tool_use', 停下: N.stopC }),
        note('turns', `三种停法`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '错误交给模型，停止交给运行时',
    desc: `end_turn、max_tokens、max_turns 各一次`,
    text: `工具出错不该让循环崩掉：参数不合 schema、违反业务规则，都写成 is_error 的 tool_result 交回模型，它能改参数重试，也能据此改口。停不停有两种来源：stop_reason 是模型这一轮为什么停（end_turn 说完了、tool_use 要调用工具、max_tokens 被截断……），最大轮数是运行时给整个循环设的上限，防止模型一直调用工具。截断和到上限都意味着没办完，应用要区别对待。下一课看同一个循环放进 Anthropic SDK、Claude Agent SDK、OpenAI Agents SDK 和 LangChain 时，哪一步由谁来做。`,
    facts: [['正常', `${N.turnsA} 轮，end_turn`], ['截断', `max_tokens ${N.tight}`], ['上限', `${N.cap} 轮，max_turns`], ['下一课', '手写循环 vs SDK']],
  },
};
