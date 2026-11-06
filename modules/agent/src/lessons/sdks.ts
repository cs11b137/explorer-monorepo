/**
 * 循环组第五课：手写循环 vs SDK。还是 react 课那件事（A1024 杯盖漏水退货，4 轮、3 次工具调用），
 * 看同一个循环放进 Anthropic SDK 的 tool runner、Claude Agent SDK、OpenAI Agents SDK、LangChain 的 create_agent 时，
 * 哪一步由谁来做、默认最多转几圈、超了怎么报。
 *
 * 数字全部来自 runAgent：react 的那次运行（4 轮、累计输入、费用、HTTP 字节），以及同一个脚本把上限设成 3 时的那次运行
 * （stop 是 max_turns，退货单已经建了，用户却没得到回答）。各 SDK 的类名、参数名和默认值只写 README「核对过的事实」里有的；
 * 代码片段是示意（fidelity 示意），不是能直接运行的完整程序。tests/narrative.test.ts 核对文案。
 */
import {
  createShop,
  DEFAULT_MAX_TURNS,
  encodeJson,
  formatUsd,
  runAgent,
  outputTokensOf,
  type AgentTurn,
  type MessageParam,
  type ToolCall,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, wire } from '../decode/structures';
import { blocksOf, historyRow, ledgerGrid, type BlockCell } from './common';
import { note, pk, show, state } from './dsl';
import { MODEL, REACT_SCRIPT, SUPPORT, SYSTEM, USER_ASK } from './scenario';
import type { DsCell, GridPrim, Lesson, LessonEvent } from './types';

// ---------- 真实运行 ----------

export const shop = createShop();
export const run = runAgent(SUPPORT, USER_ASK, REACT_SCRIPT, { ctx: { shop }, seed: 100 });
/** 同一个脚本，上限设成 3：第 3 轮的工具照样执行（退货单建了），但没有第 4 轮去写回答。 */
export const CAP = 3;
export const capShop = createShop();
export const capped = runAgent(SUPPORT, USER_ASK, REACT_SCRIPT, { ctx: { shop: capShop }, seed: 100, maxTurns: CAP });

/** Claude Agent SDK 里自定义工具的名字：mcp__<server>__<tool>。server 的名字是示例。 */
export const SERVER = 'xiaopu';
export const mcpName = (tool: string): string => `mcp__${SERVER}__${tool}`;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const toolTurns = run.turns.filter((turn) => turn.calls.length).length;

export const numbers = {
  turns: run.totals.turns,
  toolTurns,
  finalTurns: run.turns.length - toolTurns,
  toolCalls: sum(run.turns.map((turn) => turn.calls.length)),
  totalInput: run.totals.input,
  totalOutput: run.totals.output,
  cost: formatUsd(run.totals.cost),
  requests: run.turns.length,
  requestBytes: sum(run.turns.map((turn) => turn.http.request.bytes.length)),
  responseBytes: sum(run.turns.map((turn) => turn.http.response.bytes.length)),
  maxTurns: DEFAULT_MAX_TURNS,
  cap: CAP,
  cappedStop: capped.stop,
  cappedTurns: capped.totals.turns,
  cappedInput: capped.totals.input,
  cappedReturns: capShop.returns.length,
  cappedReturnId: capShop.returns[0]?.return_id ?? '',
  cappedLastRole: capped.messages[capped.messages.length - 1].role,
  mcpNames: SUPPORT.tools.specs.map((spec) => mcpName(spec.name)),
  stop: run.stop,
};
const N = numbers;

// ---------- 图元：五种写法的对照 ----------

const ROWS = ['手写 runAgent', 'tool runner', 'Claude Agent SDK', 'OpenAI Agents', 'LangChain'];
/** 默认上限（核对过的默认值；tool runner 的 max_iterations 是可选的，默认值没核对，写 —）和这次用到的数。 */
const LIMITS: Array<[string, string]> = [
  [String(DEFAULT_MAX_TURNS), String(N.turns)],
  ['—', String(N.requests)],
  ['不限', String(N.turns)],
  ['10', String(N.turns)],
  ['9999', '—'],
];
const compareGrid = (k: number): GridPrim => ({
  kind: 'grid',
  id: 'cmp',
  w: 60,
  rows: ROWS.slice(0, k),
  cols: ['默认上限', '这次'],
  cells: LIMITS.slice(0, k).map(([limit, used], r): DsCell[] => [
    { v: limit, tone: limit === '—' ? 'dim' : 'violet', lift: r === k - 1 || undefined },
    { v: used, tone: used === '—' ? 'dim' : 'blue', lift: r === k - 1 || undefined },
  ]),
});

// ---------- 字节层 ----------

/** 代码片段：每行一个字段，示意（不是完整程序）。 */
const snippet = (name: string, lines: Array<[string, string?]>, summary: string) =>
  concept(name, lines.map(([code, noteText], i): [string, string, string?] => [String(i + 1).padStart(2, '0'), code, noteText]), 'slate', summary);

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const requestWire = (turn: AgentTurn, title: string) =>
  wire(title, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
    jsonBody('请求体', encodeJson(turn.request), { notes: { tools: '工具定义（name、description、input_schema）。', messages: `第 ${turn.index} 轮：${turn.request.messages.length} 条消息。` } }));
const responseWire = (turn: AgentTurn) =>
  wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), { example: ['id', 'content', 'usage'], notes: { stop_reason: `${turn.message.stop_reason}：循环据此决定继续还是停。` } }));
const callWire = (c: ToolCall) => wire(`tool_use：${c.use.name}`, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'] }));
const resultWire = (c: ToolCall) => wire(`tool_result：${c.use.name}`, 'mem', 'format', jsonBody('tool_result 块', encodeJson(c.result)));

/** 历史里每块的 token 数：取自包含它的那一轮请求；最后一条回答按输出 token 数。 */
function blocksAt(messages: MessageParam[]): BlockCell[] {
  const next = run.turns.find((turn) => turn.request.messages.length >= messages.length);
  const last = run.turns[run.turns.length - 1];
  const extra = next ? {} : { [run.messages.length - 1]: last.message.content.map((block) => outputTokensOf(block)) };
  return blocksOf(messages, (next ?? last).breakdown.prompt, extra);
}
const history = (messages: MessageParam[], lift: number[] = []) => historyRow('h', blocksAt(messages), { w: 40, lift });
const lastOf = (messages: MessageParam[], n: number) => {
  const total = blocksAt(messages).length;
  return Array.from({ length: n }, (_, i) => total - n + i);
};

/** 手写循环：一轮的请求、响应、工具执行、回填，全部是运行时自己的代码。 */
function handLoop(): LessonEvent[] {
  return run.turns.flatMap((turn): LessonEvent[] => {
    const sent = turn.request.messages;
    const reply = run.messages.slice(0, sent.length + 1);
    const filled = run.messages.slice(0, sent.length + 2);
    return [
      pk('agent', 'llm', 'blue', `第 ${turn.index} 轮`, [`${sent.length} 条消息`], [turn.before.input, 'HTTP', `你的代码：组装第 ${turn.index} 轮请求，POST /v1/messages`, turn.http.request.bytes.length], requestWire(turn, `第 ${turn.index} 轮请求`), { quick: true, ds: { messages: [history(sent)] } }),
      pk('llm', 'agent', 'green', turn.message.stop_reason, [`输入 ${num(turn.message.usage.input_tokens)}`], [turn.after.input, 'INFER', `你的代码：读 stop_reason ${turn.message.stop_reason}，记账`, turn.http.response.bytes.length], responseWire(turn), { quick: true, ds: { messages: [history(reply, lastOf(reply, turn.message.content.length))], usage: [ledgerGrid('u', run.turns.slice(0, turn.index), { total: turn.index === run.turns.length })] } }),
      ...turn.calls.flatMap((c): LessonEvent[] => [
        pk('agent', 'tools', 'amber', c.use.name, [preview(JSON.stringify(c.use.input), 18)], [turn.after.input, 'TOOL', `你的代码：校验参数，执行 ${c.use.name}`, encodeJson(c.use).bytes.length], callWire(c), { quick: true, ds: { messages: [history(reply, lastOf(reply, 1))] } }),
        pk('tools', 'agent', 'teal', 'tool_result', [preview(c.outcome.content, 16)], [turn.after.input, 'RESULT', '你的代码：按 tool_use_id 回填，放进下一条 user 消息', encodeJson(c.result).bytes.length], resultWire(c), { quick: true, ds: { messages: [history(filled, lastOf(filled, 1))] } }),
      ]),
    ];
  });
}

const t1 = run.turns[0];
const tLast = run.turns[run.turns.length - 1];
const firstCall = t1.calls[0];

// ---------- 课程 ----------

export const sdks: Lesson = {
  id: 'sdks',
  name: 'SDKS',
  title: '手写循环 vs SDK',
  group: 'loop',
  layer: [4, 6],
  layerNote: '这课从「工具」跨到「编排」：同一个循环，换成不同的 SDK 之后，谁执行工具、谁数轮数、谁决定停下都变了。',
  tokensNote: `第一步是和 react 课同一次运行（${N.turns} 轮，累计 ${num(N.totalInput)}）；后面几步讲的是同一个循环换一种写法，不再调用模型，这一列不变。`,
  nodes: ['app', 'agent', 'llm', 'tools', 'usage', 'turns', 'messages'],
  place: { app: [90, 150], agent: [520, 300], llm: [860, 90], tools: [800, 500], usage: [90, 520], turns: [1110, 340], messages: [480, 730] },
  labels: {
    app: ['你的代码', '调用循环、拿结果'],
    agent: ['循环', '手写或 SDK'],
    llm: ['模型', MODEL],
    tools: ['工具', '查订单、查规则、建单'],
    usage: ['账', '每轮的输入、输出 token'],
    turns: ['五种写法', '默认上限和这次用了几轮'],
    messages: ['消息历史', '每格一个内容块的 token'],
  },
  labelAt: { usage: [0, 150], turns: [0, 150], messages: [-250, 40] },
  radius: { usage: 70, turns: 80, messages: 70 },
  initial: { usage: [], turns: [], messages: [] },
  start: ['app', 'agent', 'llm'],
  legend: [['blue', '请求'], ['green', '响应'], ['amber', '工具调用'], ['violet', '默认上限'], [null, '输入列：模型累计读入的 token']],
  overview: {
    full: '循环谁来写：自己、tool runner，还是 Agent 框架',
    description: `前四课的循环都是本站自己写的 runAgent：组装请求、看 stop_reason、执行工具、回填、记账、数轮数。真实项目里这几步常常交给 SDK：Anthropic SDK 的 tool runner 只替你转圈，Claude Agent SDK 连工具和权限都带好了，OpenAI Agents SDK 和 LangChain 的 create_agent 各有自己的 Agent 和运行器。不管谁来写，线上都还是一次次模型调用（tool runner 发的就是这 ${N.requests} 个 POST /v1/messages，Agent 框架还会带上自己的 system 和工具），差别在谁执行哪一步、默认最多转几圈、超了怎么报错。`,
    facts: [
      ['同一件事', `${N.turns} 轮、${N.toolCalls} 次工具调用，累计 ${num(N.totalInput)}`],
      ['手写', `runAgent，默认最多 ${N.maxTurns} 轮`],
      ['SDK', 'tool runner、Claude Agent SDK、OpenAI Agents SDK、LangChain'],
      ['默认上限', '不限、10、9,999（数的东西不同）'],
    ],
  },
  steps: [
    {
      title: '手写循环：每一步都是你的代码',
      desc: `${N.turns} 轮、${N.toolCalls} 次工具调用，全部自己做`,
      detail: `react 课的循环就是手写的：你的代码组装请求、调用 Messages API、读 stop_reason，是 tool_use 就校验参数、执行工具、按 tool_use_id 回填，再发下一轮，直到 end_turn。这次 ${N.turns} 轮，${N.requests} 个请求一共 ${num(N.requestBytes)} 字节，累计输入 ${num(N.totalInput)}，按示例单价 ${N.cost}。轮数上限、出错怎么回、要不要人确认，都得自己写，好处是每一步都看得见、改得了。`,
      facts: [['轮数', `${N.turns} / ${N.maxTurns}`], ['请求', `${N.requests} 个，${num(N.requestBytes)} 字节`], ['累计输入', `${num(N.totalInput)} token`], ['费用', N.cost]],
      events: [
        pk('app', 'agent', 'blue', 'runAgent(...)', [preview(USER_ASK, 16)], [0, 'CALL', '你的代码调用本站的 runAgent：配置、用户的话、脚本、选项', null], wire('手写循环（示意）', 'mem', '示意', snippet('loop.ts 的 runAgent（简化）', [
          ['for (turn = 1; ; turn++) {', `最多 ${N.maxTurns} 轮（本站默认）。`],
          ['  request = buildRequest(config, messages)', '历史整份带上：API 是无状态的。'],
          ['  message = POST /v1/messages', '读 usage，记账。'],
          ['  if (stop_reason !== "tool_use") break', 'end_turn、max_tokens……都停。'],
          ['  results = tool_use 逐个执行', '先按 input_schema 校验，出错写成 is_error。'],
          ['  messages.push({ role: "user", content: results })', '全部 tool_result 放进同一条 user 消息。'],
          ['  if (turn >= maxTurns) break', '停在 max_turns。'],
          ['}'],
        ], '每一步都是你写的'))),
        show('tools', 'usage', 'messages'),
        ...handLoop(),
        show('turns'),
        pk('agent', 'turns', 'violet', `${N.turns} 轮`, [`上限 ${N.maxTurns}`, `stop: ${N.stop}`], [run.totals.input, 'STOP', `stop_reason end_turn：循环停下，${N.turns} / ${N.maxTurns} 轮`, null], wire('手写循环的账', 'mem', '示意', concept('runAgent 的结果', [['turns', String(N.turns)], ['stop', N.stop], ['累计输入', num(N.totalInput)], ['费用', N.cost, '示例单价。']])), { ds: { turns: [compareGrid(1)] } }),
        state('agent', { 写法: '手写', 轮次: `${N.turns} / ${N.maxTurns}` }),
      ],
    },
    {
      title: 'Anthropic SDK 的 tool runner：只替你转圈',
      desc: `同样 ${N.requests} 次 POST /v1/messages`,
      detail: `tool runner 是 Anthropic SDK 里的 beta 辅助函数：TypeScript 用 betaTool() 或 betaZodTool() 定义工具（名字、描述、schema 加一个 run 函数），交给 client.beta.messages.toolRunner()，await 它拿到最后一条消息。发请求、看 stop_reason、调用你的 run、回填结果这几步由 SDK 做，线上还是这 ${N.requests} 个 Messages API 请求，工具只有你给的那几个。上限是可选的 max_iterations，每一轮之间还能插进去检查或改写结果。`,
      facts: [['你写', '工具的 run 函数'], ['SDK 做', '请求、判断、执行、回填'], ['请求', `${N.requests} 次 /v1/messages`], ['上限', 'max_iterations（可选）']],
      events: [
        pk('app', 'agent', 'blue', 'toolRunner(...)', ['tools: [getOrder, …]'], [run.totals.input, 'CALL', '你的代码把工具交给 tool runner，await 拿最后一条消息', null], wire('tool runner（示意）', 'mem', '示意', snippet('TypeScript，示意', [
          ['const getOrder = betaTool({', '@anthropic-ai/sdk/helpers/beta/json-schema'],
          [`  name: "get_order", description, inputSchema,`, '和 react 课的定义一样：JSON Schema 原样给。'],
          ['  run: async (input) => JSON.stringify(orders.get(input.order_id)),', '你只写执行的部分。'],
          ['});'],
          ['const final = await client.beta.messages.toolRunner({', 'SDK 跑循环，直到不再有 tool_use。'],
          [`  model: "${MODEL}", max_tokens: 1024, system, tools: [getOrder, searchPolicy, createReturn],`],
          ['  messages: [{ role: "user", content: ask }],'],
          ['});'],
        ], 'Anthropic SDK 的 beta 辅助函数')), { ds: { turns: [compareGrid(2)] } }),
        pk('agent', 'llm', 'blue', `${N.requests} 次请求`, [`${num(N.requestBytes)} 字节`], [run.totals.input, 'HTTP', `SDK 发出的还是 ${N.requests} 个 POST /v1/messages，第一个和手写的一样`, t1.http.request.bytes.length], requestWire(t1, '第 1 轮请求（和手写的相同）')),
        pk('agent', 'tools', 'amber', 'run(input)', [firstCall.use.name], [run.totals.input, 'TOOL', 'SDK 调用你给的 run 函数，结果由 SDK 回填', encodeJson(firstCall.use).bytes.length], callWire(firstCall)),
        pk('agent', 'app', 'green', '最后一条消息', [preview(run.final, 14)], [run.totals.input, 'CALL', `await runner 拿到第 ${tLast.index} 轮的消息，stop_reason end_turn`, tLast.http.response.bytes.length], responseWire(tLast)),
        state('agent', { 写法: 'tool runner', 轮次: `${N.requests} 次请求` }),
      ],
    },
    {
      title: 'Claude Agent SDK：连工具和权限都带好',
      desc: `num_turns ${N.turns}；max_turns=${N.cap} 时 error_max_turns`,
      detail: `Claude Agent SDK 把 Claude Code 的循环做成了库：query(prompt, options) 一边跑一边吐出消息，循环结束时的 ResultMessage 带 num_turns、total_cost_usd 和 subtype。自定义工具用 @tool 定义、create_sdk_mcp_server 包成进程内的 MCP 服务器，模型看到的名字变成 ${N.mcpNames[0]} 这样，另外还有 Read、Bash 这些内置工具和 allowed_tools 一类的权限设置。它的一轮也是一次模型输出加上执行工具，按同一个脚本是 ${N.toolTurns} 轮调用工具加 ${N.finalTurns} 轮回答，num_turns 是 ${N.turns}；max_turns 默认不限，设成 ${N.cap} 时第 ${N.cap} 轮的工具照样执行（退货单 ${N.cappedReturnId} 已经建了），却没有第 ${N.cap + 1} 轮写回答，结果是 error_max_turns。`,
      facts: [['入口', 'query(prompt, options)'], ['工具名', N.mcpNames[0]], ['num_turns', `${N.turns}`], ['max_turns', `默认不限；${N.cap} → error_max_turns`]],
      events: [
        pk('app', 'agent', 'blue', 'query(prompt, options)', ['ClaudeAgentOptions'], [run.totals.input, 'CALL', '你的代码调用 query，异步地一条条收消息', null], wire('Claude Agent SDK（示意）', 'mem', '示意', snippet('Python，示意', [
          ['@tool("get_order", "按订单号查询订单……", {"order_id": str})', 'claude_agent_sdk 的 @tool：名字、描述、参数、处理函数。'],
          ['async def get_order(args): return {"content": [{"type": "text", "text": ...}]}'],
          [`server = create_sdk_mcp_server(name="${SERVER}", version="1.0.0", tools=[get_order, ...])`, '进程内的 MCP 服务器。'],
          [`options = ClaudeAgentOptions(mcp_servers={"${SERVER}": server},`],
          [`    allowed_tools=["${N.mcpNames[0]}", ...], max_turns=${N.maxTurns})`, 'max_turns 不写就是不限。'],
          ['async for message in query(prompt=ask, options=options):', '一路收到 AssistantMessage、UserMessage……'],
          ['    if isinstance(message, ResultMessage): print(message.subtype)', 'success / error_max_turns / error_max_budget_usd……'],
        ], 'claude-agent-sdk')), { ds: { turns: [compareGrid(3)] } }),
        pk('agent', 'tools', 'amber', N.mcpNames[0], ['进程内 MCP'], [run.totals.input, 'TOOL', `SDK 执行工具：名字是 mcp__<server>__<tool>`, encodeJson(firstCall.use).bytes.length], wire('工具名', 'mem', '示意', concept('自定义工具在 SDK 里的名字', SUPPORT.tools.specs.map((spec, i): [string, string] => [spec.name, N.mcpNames[i]])))),
        pk('agent', 'app', 'green', 'ResultMessage', ['subtype: success', `num_turns: ${N.turns}`], [run.totals.input, 'CALL', `ResultMessage：success，num_turns ${N.turns}（${N.toolTurns} 轮调用工具 + ${N.finalTurns} 轮回答）`, null], wire('ResultMessage（示意）', 'mem', '示意', concept('同一件事在 SDK 里的结果', [['subtype', 'success'], ['num_turns', String(N.turns), `${N.toolTurns} 轮有工具调用，加 ${N.finalTurns} 轮只写回答。`], ['total_cost_usd', N.cost, '本站示例单价算的；SDK 按自己的计费算。']]))),
        pk('agent', 'app', 'amber', 'error_max_turns', [`max_turns=${N.cap}`, `建了 ${N.cappedReturnId}`], [run.totals.input, 'STOP', `max_turns=${N.cap}：第 ${N.cap} 轮的工具执行了，没有回答（runAgent 同样停在 ${N.cappedStop}）`, null], wire('上限设成 3', 'mem', '示意', concept(`runAgent 的 maxTurns = ${N.cap}`, [['stop', N.cappedStop, `${N.cappedTurns} 轮，累计输入 ${num(N.cappedInput)}。`], ['退货单', N.cappedReturnId, '第 3 轮的 create_return 已经执行。'], ['最后一条消息', N.cappedLastRole, '工具结果回填了，模型没机会读它。'], ['SDK 里', 'error_max_turns', 'ResultMessage 没有 result 字段。']])), { lost: true }),
        state('agent', { 写法: 'Claude Agent SDK', 轮次: `num_turns ${N.turns}` }),
      ],
    },
    {
      title: 'OpenAI Agents SDK：Runner 跑循环，默认 10 轮',
      desc: `max_turns 默认 10，数的是模型调用`,
      detail: `OpenAI Agents SDK（openai-agents）用 Agent(name, instructions, tools) 定义 Agent，@function_tool 把普通函数变成工具，Runner.run_sync(agent, 输入) 跑完整个循环：模型要调用工具就执行、回填、再调用模型，直到给出最终输出，从 result.final_output 取。它的一轮就是一次模型调用，max_turns 默认 10，超了抛 MaxTurnsExceeded。按同一个脚本，这件事用 ${N.turns} 次模型调用，离 10 还有余量；但换一个反复重试的模型，第 11 次调用前就会抛异常。`,
      facts: [['入口', 'Runner.run_sync(agent, input)'], ['工具', '@function_tool'], ['max_turns', '默认 10，超了 MaxTurnsExceeded'], ['这次', `${N.turns} 次模型调用`]],
      events: [
        pk('app', 'agent', 'blue', 'Runner.run_sync(...)', ['Agent(name, instructions, tools)'], [run.totals.input, 'CALL', '你的代码把 Agent 交给 Runner', null], wire('OpenAI Agents SDK（示意）', 'mem', '示意', snippet('Python，示意', [
          ['from agents import Agent, Runner, function_tool', 'pip install openai-agents'],
          ['@function_tool'],
          ['def get_order(order_id: str) -> str: ...', '函数签名和文档字符串变成工具定义。'],
          ['agent = Agent(name="support", instructions=SYSTEM, tools=[get_order, search_policy, create_return])'],
          ['result = Runner.run_sync(agent, ask)', 'max_turns 不写就是 10。'],
          ['print(result.final_output)'],
        ], 'openai-agents')), { ds: { turns: [compareGrid(4)] } }),
        pk('agent', 'llm', 'blue', `${N.turns} 次模型调用`, ['≤ max_turns 10'], [run.totals.input, 'CALL', `Runner 调用模型、执行工具、回填，${N.turns} 次模型调用后得到最终输出`, null], wire('Runner 的循环', 'mem', '示意', concept('Runner 每一轮', [['调用模型', `${N.turns} 次`, '一轮就是一次模型调用。'], ['有工具调用', '执行、回填、再来', `这次 ${N.toolCalls} 次。`], ['没有工具调用', '结束', '得到 final_output。'], ['超过 max_turns', 'MaxTurnsExceeded', '默认 10。']]))),
        pk('agent', 'app', 'green', 'final_output', [preview(run.final, 14)], [run.totals.input, 'CALL', 'result.final_output：最后的回答', null], wire('result', 'mem', '示意', concept('RunResult', [['final_output', preview(run.final, 24)], ['last_agent', 'support', '转交之后会是接手的 Agent。']]))),
        state('agent', { 写法: 'OpenAI Agents', 轮次: `${N.turns} / 10` }),
      ],
    },
    {
      title: 'LangChain：create_agent 返回一张图',
      desc: 'recursion_limit 9,999，数的是图的步数',
      detail: `LangChain v1 的 create_agent(model, tools, system_prompt) 返回一个 LangGraph 编译好的图，「模型在循环里调用工具，直到任务完成」，用 agent.invoke({"messages": [...]}) 运行。它的上限是 LangGraph 的 recursion_limit，数的是图执行了多少个 super-step（一步里并行的节点算一步），不是模型调用次数，所以 create_agent 设的 9,999 不能和 max_turns 的 10 直接比，超了抛 GraphRecursionError。这几种写法的默认上限有 10、不限、9,999，差别很大：自己写也好、用 SDK 也好，都要知道这个数是多少、数的是什么。`,
      facts: [['入口', 'create_agent(...).invoke(...)'], ['返回', 'CompiledStateGraph'], ['上限', 'recursion_limit 9,999（super-step）'], ['超了', 'GraphRecursionError']],
      events: [
        pk('app', 'agent', 'blue', 'create_agent(...)', ['.invoke({"messages": …})'], [run.totals.input, 'CALL', '你的代码建图、调用 invoke', null], wire('LangChain create_agent（示意）', 'mem', '示意', snippet('Python，示意', [
          ['from langchain.agents import create_agent'],
          ['from langchain.tools import tool'],
          ['@tool'],
          ['def get_order(order_id: str) -> str: ...', '文档字符串就是描述。'],
          [`agent = create_agent(model="anthropic:${MODEL}", tools=[get_order, ...], system_prompt=SYSTEM)`, '返回 CompiledStateGraph。'],
          ['result = agent.invoke({"messages": [{"role": "user", "content": ask}]})', 'recursion_limit 放在 config 的顶层键里。'],
        ], 'langchain v1')), { ds: { turns: [compareGrid(5)] } }),
        pk('agent', 'turns', 'violet', '五种上限', ['10 · 不限 · 10 · 9,999'], [run.totals.input, 'STOP', '五种写法的默认上限：数的东西不一样', null], wire('谁执行哪一步', 'mem', '示意', concept('同一个循环', [
          ['手写 runAgent', `上限 ${N.maxTurns} 轮`, '每一步都是你的代码；停在 stop: max_turns。'],
          ['tool runner', 'max_iterations（可选）', 'SDK 跑循环，工具只有你给的。'],
          ['Claude Agent SDK', 'max_turns 默认不限', '内置工具 + 你的 MCP 工具；error_max_turns。'],
          ['OpenAI Agents SDK', 'max_turns 默认 10', '一轮一次模型调用；MaxTurnsExceeded。'],
          ['LangChain create_agent', 'recursion_limit 9,999', '数 super-step；GraphRecursionError。'],
        ]), concept('system 提示', [['SYSTEM', preview(SYSTEM, 30), '各种写法里都是同一段（instructions、system_prompt……）。']]))),
        state('agent', { 写法: 'LangChain', 轮次: 'super-step' }),
        note('turns', '上限数的东西不同'),
      ],
    },
  ],
  outro: {
    title: '循环还是那个循环，换的是谁来写',
    desc: `${N.turns} 轮、${N.toolCalls} 次工具调用、${N.cost}`,
    text: `不管手写还是用 SDK，循环都是那几步：发请求、看停止原因、执行工具、回填、再发，线上还是一次次模型调用，token 和费用也一样算。SDK 省掉的是样板代码，同时替你做了一些决定：默认最多转几圈（不限、10、9,999）、数的是模型调用还是图的步数、超了是返回一个错误结果还是抛异常、工具名会不会被改写。选哪一种之前，先把这几个默认值查清楚。循环组到这里结束，下一组看工具从哪里来：MCP 协议。`,
    facts: [['手写', `${N.maxTurns} 轮（本站）`], ['Claude Agent SDK', 'max_turns 不限'], ['OpenAI Agents SDK', 'max_turns 10'], ['下一组', 'MCP 协议']],
  },
};
