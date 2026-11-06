/**
 * 上下文工程组第一课：上下文预算拆账。
 * 一个真实形态的 Agent 请求（system、3 个工具、带工具时 API 加的工具系统提示、3 轮历史、3 段检索、本轮问题、max_tokens），
 * 由 core/ 的 ChatML 展开真实计数，planBudget 拆账；放不下时用 dropOldest、keepLast 真实截断，validateRequest 真实校验。
 * 窗口缩小到 WINDOW 演示（真实模型是 1M），比例关系和算法不变。模型的回复是示例（E.G.），tests/narrative.context.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  alignToRound,
  countTokens,
  dropOldest,
  encodeJson,
  errorBody,
  exampleId,
  inputBreakdown,
  keepLast,
  MODELS,
  planBudget,
  validateRequest,
  type BudgetPart,
  type MessageParam,
  type MessagesRequest,
  type RenderedPrompt,
} from '../core';
import { concept, jsonBody, num, promptPieces, utf8Lines, wire } from '../decode/structures';
import { budgetRow, CITY, DOCS, factsIn, HISTORY, messageTokens, messageTone, MODEL, ORDER_ID, QUESTION, SYSTEM, TOOL_SYSTEM_TOKENS, TOOLS, turnOf } from './agent';
import { pct } from './common';
import { note, pk, render, show } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 这次请求 ----------

/** 演示用的窗口：真实模型是 1M token，这里缩小到能看清每一格的大小，算法和比例关系一样。 */
export const WINDOW = 2400;
export const MAX_TOKENS = 512;

/** 本轮的用户消息：应用检索到的 3 段规则放在问题前面。 */
export const CURRENT: MessageParam = { role: 'user', content: [...Object.values(DOCS).map((text) => ({ type: 'text' as const, text })), { type: 'text', text: QUESTION }] };
export const MESSAGES: MessageParam[] = [...HISTORY, CURRENT];
export const REQUEST: MessagesRequest = { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages: MESSAGES };

const LAST = MESSAGES.length - 1;

/** 按来源拆账：工具定义、工具系统提示、system、历史、检索、问题、模板。各部分之和 = 展开后的 token + 工具系统提示。 */
export function partsOf(prompt: RenderedPrompt, count: number): BudgetPart[] {
  const tools = prompt.bySource.tools ?? 0;
  const system = prompt.bySource.system ?? 0;
  const last = count - 1;
  const question = prompt.bySource[`messages[${last}].content[3]`];
  const retrieval = messageTokens(prompt, last) - question;
  let history = 0;
  for (let i = 0; i < last; i++) history += messageTokens(prompt, i);
  const template = prompt.tokens - tools - system - history - retrieval - question;
  return [
    { id: 'tools', label: '工具', kind: 'tools', tokens: tools },
    { id: 'toolSystem', label: '工具提示', kind: 'tools', tokens: TOOL_SYSTEM_TOKENS },
    { id: 'system', label: 'system', kind: 'system', tokens: system },
    { id: 'history', label: '历史', kind: 'history', tokens: history },
    { id: 'retrieval', label: '检索', kind: 'retrieval', tokens: retrieval },
    { id: 'question', label: '问题', kind: 'user', tokens: question },
    { id: 'template', label: '模板', kind: 'template', tokens: template },
  ];
}

export const body = encodeJson(REQUEST);
export const full = inputBreakdown(REQUEST);
export const prompt = full.prompt;
export const parts = partsOf(prompt, MESSAGES.length);
export const plan = planBudget(WINDOW, parts, MAX_TOKENS);
const part = (id: string) => parts.find((item) => item.id === id)!.tokens;

/** 每条消息的 token 数（截断策略看到的数）。 */
export const msgTokens = MESSAGES.map((_, i) => messageTokens(prompt, i));
export const turns = MESSAGES.map(turnOf);

/** 留给消息的预算：窗口减去输出预留和不能丢的部分（工具、工具提示、system、模板）。 */
export const fixedTokens = part('tools') + part('toolSystem') + part('system') + part('template');
export const trimBudget = WINDOW - MAX_TOKENS - fixedTokens;

// ---------- 两种截断 ----------

export const oldest = dropOldest(turns, trimBudget);
export const naiveKept = MESSAGES.slice(oldest.dropped.length);
export const naiveError = validateRequest({ ...REQUEST, messages: naiveKept })!;
export const REQUEST_ID = exampleId('req', 21);
export const errorJson = encodeJson(errorBody(naiveError, REQUEST_ID));

/** 对齐到轮次：从 dropOldest 的截断点往后找第一个用户自己说的话。 */
export const alignedStart = alignToRound(MESSAGES, oldest.dropped.length);
export const aligned = MESSAGES.slice(alignedStart);
export const alignedRequest: MessagesRequest = { ...REQUEST, messages: aligned };
export const alignedPrompt = inputBreakdown(alignedRequest).prompt;
export const alignedPlan = planBudget(WINDOW, partsOf(alignedPrompt, aligned.length), MAX_TOKENS);

export const KEEP = 3;
export const recent = keepLast(KEEP)(turns, trimBudget);
export const recentStart = MESSAGES.length - recent.kept.length;
export const recentPrompt = inputBreakdown({ ...REQUEST, messages: MESSAGES.slice(recentStart) }).prompt;
export const recentPlan = planBudget(WINDOW, partsOf(recentPrompt, recent.kept.length), MAX_TOKENS);

/** 用户在最早几轮里说过的关键事实，按字面查它们还在不在。 */
export const KEY_FACTS = [ORDER_ID, CITY, '漏水'];
const textOf = (messages: readonly MessageParam[]) => messages.map((message) => turnOf(message).text).join('\n');
export const lostAligned = KEY_FACTS.filter((fact) => !factsIn(textOf(aligned), [fact]).length);
export const lostRecent = KEY_FACTS.filter((fact) => !factsIn(textOf(MESSAGES.slice(recentStart)), [fact]).length);

// ---------- 模型 ----------

/** 模型写的回复：示例。历史里已经没有订单号，它只能再问一遍。 */
export const REPLY = '可以直接退款，原路退回：支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。请告诉我订单号，我查一下金额再为您办理。';
export const input = alignedPrompt.tokens + TOOL_SYSTEM_TOKENS;
export const output = countTokens(REPLY);

// ---------- 图元 ----------

const ROLE_NAME = (message: MessageParam) => (message.role === 'assistant' ? '助手' : messageTone(message) === 'teal' ? '工具' : '用户');

/** 消息列表：每条一格。named 时格子里写角色，否则写 token 数；from 之前的格子变暗（被丢掉）。 */
function messagesRow(options: { named?: boolean; from?: number; marks?: RowPrim['marks']; lift?: number[] } = {}): RowPrim {
  const cells: DsCell[] = MESSAGES.map((message, i) => {
    const gone = options.from !== undefined && i < options.from;
    return { v: options.named ? ROLE_NAME(message) : String(msgTokens[i]), tone: gone ? 'dim' : messageTone(message), key: `m${i}`, lift: options.lift?.includes(i) || undefined };
  });
  return { kind: 'row', id: 'ms', w: 46, cells, marks: options.marks };
}

const docsRow = (): RowPrim => ({
  kind: 'row',
  id: 'dc',
  w: 56,
  cells: Object.keys(DOCS).map((key, i) => ({ v: String(prompt.bySource[`messages[${LAST}].content[${i}]`]), tone: 'amber', sub: ['售后', '退款', '运费'][i], key })),
});

// ---------- 文案用到的数 ----------

const docsText = Object.values(DOCS).join('\n');
const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);

export const numbers = {
  bodyBytes: body.bytes.length,
  rendered: prompt.tokens,
  input: plan.input,
  used: plan.used,
  over: -plan.free,
  tools: part('tools'),
  system: part('system'),
  history: part('history'),
  retrieval: part('retrieval'),
  question: part('question'),
  template: part('template'),
  fixed: fixedTokens,
  trimBudget,
  turnsBefore: oldest.before,
  droppedOldest: oldest.dropped.length,
  droppedOldestTokens: oldest.before - oldest.after,
  keptOldest: oldest.after,
  alignedStart,
  alignedDropped: sum(msgTokens.slice(0, alignedStart)),
  alignedInput: alignedPlan.input,
  alignedFree: alignedPlan.free,
  recentDropped: recent.dropped.length,
  recentInput: recentPlan.input,
  recentFree: recentPlan.free,
  input2: input,
  output,
  docsBytes: utf8Encode(docsText).length,
  toolsShare: (part('tools') + part('toolSystem')) / WINDOW,
};

const N = numbers;
const share = (id: string) => pct(plan.rows.find((row) => row.id === id)!.share);
const REAL = MODELS[MODEL].context;

// ---------- 课程 ----------

export const budget: Lesson = {
  id: 'budget',
  name: 'BUDGET',
  title: '上下文预算拆账',
  group: 'context',
  layer: [3, 6],
  layerNote: '从 JSON 请求体里的字段，到展开后的 token，再到窗口里每一部分各占多少、放不下时丢哪些消息。',
  tokensNote: '模型读入截断后的请求（含工具系统提示）加上它写出的回复；之前的拆账和截断只是计数，模型还没读。',
  nodes: ['store', 'docs', 'app', 'messages', 'tokenizer', 'window', 'model'],
  place: { store: [210, 90], docs: [360, 280], app: [110, 380], messages: [350, 620], tokenizer: [590, 100], window: [800, 480], model: [930, 220] },
  labels: {
    store: ['检索库', '店铺规则文档'],
    docs: ['检索片段', '3 段，每格写 token 数'],
    app: ['应用', '客服 Agent'],
    messages: ['消息列表', '每格一条消息'],
    tokenizer: ['分词器', 'ChatML 展开、计数'],
    window: ['上下文窗口', `演示窗口 ${num(WINDOW)} token`],
    model: ['模型', MODELS[MODEL].name],
  },
  labelAt: { docs: [180, 25], messages: [-235, 20], window: [-40, 150] },
  radius: { docs: 60, messages: 70, window: 70 },
  initial: { docs: [], messages: [], window: [] },
  start: ['store', 'app', 'docs'],
  legend: [['teal', '工具定义和工具系统提示'], ['violet', 'system'], ['blue', '用户消息和历史'], ['green', '助手和输出预留'], ['amber', '检索片段、超出的部分'], [null, 'token 列：模型累计读入和写出的 token']],
  overview: {
    full: '窗口里每一格都要付账',
    description: `客服 Agent 的一次请求里装着 system、${TOOLS.length} 个工具、${HISTORY.length} 条历史消息、${Object.keys(DOCS).length} 段检索结果和本轮问题，还要给回答留出 max_tokens。这一课把它真实展开、逐项计数，在一个 ${num(WINDOW)} token 的演示窗口里拆账：输入 ${N.input}，加上输出预留 ${MAX_TOKENS} 就超出 ${N.over} 个。再用两种截断策略真实地丢消息，看丢掉的是什么，以及按条丢为什么会让请求变成 400。`,
    facts: [
      ['演示窗口', `${num(WINDOW)} token（真实模型 ${num(REAL)}）`],
      ['输入', `${N.input} token（含工具系统提示 ${TOOL_SYSTEM_TOKENS}）`],
      ['输出预留', `max_tokens ${MAX_TOKENS}`],
      ['超出', `${N.over} token`],
      ['截断', 'dropOldest、keepLast(3)'],
    ],
  },
  steps: [
    {
      title: '拼出一次 Agent 请求',
      desc: `system + ${TOOLS.length} 个工具 + ${MESSAGES.length} 条消息，${N.bodyBytes} 字节`,
      detail: `应用先拿本轮问题去检索库取回 ${Object.keys(DOCS).length} 段规则，放在问题前面，和前 ${HISTORY.length} 条历史一起组成 messages。历史里第一轮有一次工具往返：助手发出 get_order 的 tool_use，应用把查到的订单作为 tool_result 送回。API 不保存对话，这些东西每次都要整段再发一遍，全部占用上下文窗口。`,
      facts: [['工具', TOOLS.map((tool) => tool.name).join('、')], ['消息', `${MESSAGES.length} 条（${HISTORY.length} 条历史 + 本轮）`], ['max_tokens', String(MAX_TOKENS)], ['请求体', `${N.bodyBytes} 字节`]],
      events: [
        pk('store', 'app', 'amber', '检索 3 段', ['售后、退款、运费', `${N.docsBytes} 字节`], [0, 'RETRIEVE', `按本轮问题检索规则库，取回 ${Object.keys(DOCS).length} 段，${N.docsBytes} 字节`, N.docsBytes],
          wire('取回的规则片段', 'mem', 'format', utf8Lines('检索结果', docsText, { color: 'amber', summary: `${Object.keys(DOCS).length} 段，UTF-8`, notes: { 0: '规则文字是示例数据，字节和 token 数是真实计算的。' } })),
          { ds: { docs: [docsRow()] } }),
        show('messages'),
        pk('app', 'messages', 'blue', 'messages[]', [`${MESSAGES.length} 条消息`, `max_tokens: ${MAX_TOKENS}`], [0, 'JSON', `请求体：system、${TOOLS.length} 个工具、${MESSAGES.length} 条消息，${N.bodyBytes} 字节`, N.bodyBytes],
          wire('应用拼出的请求体', 'mem', 'format', jsonBody('请求体', body, {
            expand: MESSAGES.map((_, i) => `messages[${i}]`),
            example: MESSAGES.flatMap((message, i) => (message.role === 'assistant' ? [`messages[${i}]`] : [])),
            notes: {
              tools: `${TOOLS.length} 个工具的定义。带了 tools，API 还会在提示里自动加一段工具系统提示，它不在请求体里，但同样占窗口。`,
              'messages[1]': '助手要调用 get_order：tool_use 块（助手说的话是示例）。',
              'messages[2]': 'tool_result 必须紧跟在含对应 tool_use 的助手消息后面，靠 tool_use_id 配对。',
              [`messages[${LAST}]`]: '本轮：3 段检索结果（text 块）+ 问题。',
            },
          })),
          { ds: { messages: [messagesRow({ named: true, lift: [LAST] })] } }),
      ],
    },
    {
      title: '按来源拆账',
      desc: `输入 ${N.input} = 展开 ${N.rendered} + 工具提示 ${TOOL_SYSTEM_TOKENS}`,
      detail: `分词器按 ChatML 把请求展开成 ${N.rendered} 个 token，每个 token 归到它来自请求的哪一部分：工具定义 ${N.tools}、system ${N.system}、历史 ${N.history}、检索 ${N.retrieval}、问题 ${N.question}、模板 ${N.template}。带工具时 API 还会加一段工具系统提示，原文不公开，按文档给的 ${MODELS[MODEL].name} 计数记 ${TOOL_SYSTEM_TOKENS} 个。光是工具相关的两项就占了演示窗口的 ${pct(N.toolsShare)}，用户真正问的问题只有 ${N.question} 个。`,
      facts: [['展开后', `${N.rendered} token`], ['工具提示', `${TOOL_SYSTEM_TOKENS}（文档值）`], ['输入合计', `${N.input} token`], ['问题', `${N.question} token（${share('question')}）`]],
      events: [
        show('tokenizer'),
        pk('messages', 'tokenizer', 'violet', '展开成 token', [`${N.rendered} 个 token`, '按来源归账'], [0, 'TEMPLATE', `ChatML 展开：${N.rendered} 个 token（工具系统提示另计 ${TOOL_SYSTEM_TOKENS}）`, prompt.bytes.length],
          wire('展开后的提示（ChatML，本站演示）', 'mem', 'internal', promptPieces('ChatML 文本', prompt, { notes: { tools: '工具定义在 system 这一轮最前面（本站的写法，借自 Qwen2.5）。' } })),
          { ds: { messages: [messagesRow({ lift: [LAST] })] } }),
        show('window'),
        pk('tokenizer', 'window', 'violet', 'planBudget', [`输入 ${N.input}`, `+ 输出预留 ${MAX_TOKENS}`], [0, 'BUDGET', `planBudget：输入 ${N.input} + 输出预留 ${MAX_TOKENS} = ${N.used}，窗口 ${WINDOW}`, null],
          wire('预算表：每部分的 token 数和占窗口的比例', 'mem', '示意', concept('planBudget', [
            ...plan.rows.map((row): [string, string, string?] => [row.label, `${row.tokens} token · ${pct(row.share)}`, row.id === 'toolSystem' ? `文档给的 ${MODELS[MODEL].name} 计数（tool_choice 为 auto 或 none 时）。原文不公开，本站没有它的文字。` : row.id === 'template' ? '特殊 token、角色名、换行、块之间的空行。迷你词表里没有 user、assistant 这些词，模板开销被放大了。' : undefined]),
            ['合计', `${N.used} / ${WINDOW}`, '本站迷你分词器的计数只代表量级关系：真实模型的词表大得多，中文 token 少得多，绝对值不同。'],
          ])),
          { ds: { window: [budgetRow('bw', plan, { w: 46 })] } }),
      ],
    },
    {
      title: '加上输出预留就放不下',
      desc: `${N.input} + ${MAX_TOKENS} = ${N.used} > ${WINDOW}，超出 ${N.over}`,
      detail: `窗口要同时装下输入和这次的输出：输入本身超过窗口，API 直接返回 400（prompt is too long）；输入没超、加上 max_tokens 超了，Claude 4.5 及以后的模型照样接受，但生成撞到窗口上限就停下，stop_reason 是 model_context_window_exceeded。回答写到一半被截断比少带几条历史更糟，所以这里的应用在发送前自己拆账，把输出预留当成不能动的一项，超出的部分从历史里让出来。发送前可以用 count_tokens 接口按真实分词器数一遍。`,
      facts: [['输入超窗口', '400 prompt is too long'], ['输入 + max_tokens 超窗口', 'model_context_window_exceeded'], ['要让出', `${N.over} token`], ['消息的预算', `${N.trimBudget} token`]],
      events: [
        pk('window', 'app', 'amber', `超出 ${N.over}`, [`${N.used} > ${WINDOW}`, `消息只能用 ${N.trimBudget}`], [0, 'BUDGET', `放不下：${N.used} > ${WINDOW}，消息的预算 = ${WINDOW} − ${MAX_TOKENS} − ${N.fixed} = ${N.trimBudget}`, null],
          wire('窗口放不下时 API 怎么处理', 'mem', '示意', concept('上下文窗口的规则（Claude 文档）', [
            ['计入窗口', 'system、tools、messages、输出', '工具定义、工具结果、图片、文档都算；这次生成的输出（含思考）也算。'],
            ['输入超过窗口', '400 invalid_request_error', '所有模型都是：prompt is too long。'],
            ['输入 + max_tokens 超过窗口', '接受，可能提前停下', 'Claude 4.5 及以后：生成到窗口上限时 stop_reason 是 model_context_window_exceeded。更早的模型直接返回校验错误。'],
            ['发送前计数', 'POST /v1/messages/count_tokens', '按目标模型的分词器数输入 token。'],
            ['应用的预算', `${WINDOW} − ${MAX_TOKENS} − ${N.fixed} = ${N.trimBudget}`, '工具、工具提示、system、模板不能丢，剩下的才是消息（历史 + 检索 + 问题）能用的。'],
          ])),
          { ds: { window: [{ ...budgetRow('bw', plan, { w: 46, lift: ['output', 'free'] }), marks: [{ at: plan.rows.length, text: `超出 ${N.over}`, color: 'amber', dx: 30 }] }] } }),
        note('window', `消息要从 ${N.turnsBefore} 压到 ${N.trimBudget}`, 'amber'),
      ],
    },
    {
      title: '从最早的丢起',
      desc: `dropOldest 丢 ${N.droppedOldest} 条，请求却会 400`,
      detail: `dropOldest 从最早的消息开始，一次丢一问一答两条，直到消息的 token 数不超过 ${N.trimBudget}：丢掉 messages[0] 和 [1] 共 ${N.droppedOldestTokens} 个，剩 ${N.keptOldest} 个，放得下了。可是 [1] 里是 get_order 的 tool_use，它的 tool_result 在 [2] 里被留了下来，成了落单的工具结果，这样的请求发出去会被 400 拒绝。按条数成对地丢，碰上工具往返就会拆散配对。`,
      facts: [['丢掉', 'messages[0]、[1]'], ['剩下', `${N.keptOldest} / ${N.trimBudget} token`], ['第一条', 'tool_result（落单）'], ['校验', `${naiveError.status} ${naiveError.type}`]],
      events: [
        pk('app', 'messages', 'slate', 'dropOldest', [`预算 ${N.trimBudget}`, `丢 ${N.droppedOldest} 条`], [0, 'TRIM', `dropOldest：丢掉 messages[0–1] 共 ${N.droppedOldestTokens} token，剩 ${N.keptOldest} ≤ ${N.trimBudget}`, null],
          wire('dropOldest 的结果', 'mem', '示意', concept('TrimResult', [
            ['before', `${oldest.before} token`, '全部消息（截断策略按每条消息的文字计数）。'],
            ['dropped', oldest.dropped.map((_, i) => `messages[${i}]`).join('、'), '一问一答成对丢：用户的第一句话和助手的 tool_use。'],
            ['after', `${oldest.after} token`, `不超过预算 ${N.trimBudget}。`],
            ['剩下的第一条', 'messages[2]：tool_result', '它的 tool_use 在被丢掉的 messages[1] 里。'],
          ])),
          { ds: { messages: [messagesRow({ from: N.droppedOldest, marks: [{ at: N.droppedOldest, text: 'tool_result 落单', color: 'amber', dx: 40 }] })] } }),
        pk('messages', 'app', 'amber', '会被 400', [`${naiveError.status} ${naiveError.type}`], [0, 'ERROR', `校验不过：tool_result 找不到对应的 tool_use（${naiveError.status} ${naiveError.type}）`, errorJson.bytes.length],
          wire('这样发出去会收到的错误（措辞是示例）', 'mem', 'format', jsonBody('错误体', errorJson, {
            expand: ['error.type', 'error.message'],
            example: ['error.message', 'request_id'],
            notes: { 'error.type': '400 invalid_request_error：请求本身不合法，重试也没用。', 'error.message': '本站校验规则给出的措辞，不是 API 的原文。规则本身来自文档：每个 tool_result 都要在前一条消息里有对应的 tool_use。', request_id: '示例 id。' },
          })),
          { ds: { messages: [messagesRow({ from: N.droppedOldest, marks: [{ at: N.droppedOldest, text: `${naiveError.status}`, color: 'amber', dx: 40 }] })] } }),
      ],
    },
    {
      title: '按轮次丢，或者只留最近几条',
      desc: `对齐到轮次：输入 ${N.alignedInput}，剩 ${N.alignedFree}`,
      detail: `把截断点往后挪到下一个用户自己说的话，整轮丢掉：messages[0] 到 [${alignedStart - 1}] 共 ${N.alignedDropped} 个 token，重新拆账后输入 ${N.alignedInput}，加上输出预留还剩 ${N.alignedFree}。滑动窗口 keepLast(${KEEP}) 只看条数不看 token，丢了 ${N.recentDropped} 条，输入 ${N.recentInput}，空出 ${N.recentFree} 却没用上。两种做法都把用户最早说的订单号 ${ORDER_ID} 和城市「${CITY}」一起丢了，keepLast 连「漏水」也丢了：最早的一轮往往装着最关键的事实。`,
      facts: [['对齐到轮次', `丢 ${alignedStart} 条，剩 ${N.alignedFree}`], [`keepLast(${KEEP})`, `丢 ${N.recentDropped} 条，剩 ${N.recentFree}`], ['都丢了', lostAligned.join('、')], [`keepLast 还丢了`, lostRecent.filter((fact) => !lostAligned.includes(fact)).join('、')]],
      events: [
        pk('app', 'messages', 'slate', '整轮丢掉', [`从 messages[${alignedStart}] 开始`, `丢 ${alignedStart} 条`], [0, 'TRIM', `对齐到轮次：从 messages[${alignedStart}] 开始，丢掉第一轮 ${alignedStart} 条（${N.alignedDropped} token）`, null],
          wire('两种截断的对比', 'mem', '示意', concept('丢掉的和剩下的', [
            ['对齐到轮次', `丢 messages[0–${alignedStart - 1}]，剩 ${aligned.length} 条`, 'alignToRound：从截断点往后找第一个不是 tool_result 的用户消息，工具往返整轮丢。'],
            [`keepLast(${KEEP})`, `丢 messages[0–${recentStart - 1}]，剩 ${recent.kept.length} 条`, '只看条数：窗口再大也只留 3 条，窗口再小也不管放不放得下。'],
            ['丢掉的关键事实', `都丢了 ${lostAligned.join('、')}；keepLast 还丢了「漏水」`, '按字面查找这几个词还在不在剩下的消息里。'],
          ])),
          { ds: { messages: [messagesRow({ from: alignedStart, marks: [{ at: alignedStart, text: '从这一轮开始', color: 'blue', dx: 40 }] })] } }),
        pk('messages', 'window', 'violet', '重新拆账', [`输入 ${N.alignedInput}`, `剩 ${N.alignedFree}`], [0, 'BUDGET', `重新拆账：输入 ${N.alignedInput} + 输出预留 ${MAX_TOKENS} = ${alignedPlan.used} ≤ ${WINDOW}，剩 ${N.alignedFree}`, null],
          wire('截断后的预算表', 'mem', '示意', concept('planBudget（截断后）', [
            ...alignedPlan.rows.map((row): [string, string] => [row.label, `${row.tokens} token · ${pct(row.share)}`]),
            ['剩余', `${alignedPlan.free} token`],
            [`对比 keepLast(${KEEP})`, `输入 ${N.recentInput}，剩 ${N.recentFree}`],
          ])),
          { ds: { window: [budgetRow('bw', alignedPlan, { w: 46, lift: ['history', 'free'] })] } }),
      ],
    },
    {
      title: '模型读到截断后的请求',
      desc: `读入 ${N.input2}，写出 ${N.output} 个 token`,
      detail: `模型读入截断后的 ${N.input2} 个 token（展开后的 ${alignedPrompt.tokens} 加上工具系统提示 ${TOOL_SYSTEM_TOKENS}），检索到的退款说明还在，所以能回答到账时间。订单号只出现在被丢掉的第一轮里，它只能再问用户一遍：截断让请求放得下，代价是模型真的不知道那些内容了。下一课换一种办法：不丢，而是把旧的几轮压成一段摘要。`,
      facts: [['输入', `${N.input2} token`], ['输出', `${N.output} token（回复是示例）`], ['还在', '退款说明、漏水、裂缝'], ['不在了', lostAligned.join('、')]],
      events: [
        show('model'),
        pk('window', 'model', 'violet', `${N.input2} token`, ['截断后的请求', `剩 ${N.alignedFree}`], [N.input2, 'INFER', `模型读入 ${N.input2} token：展开 ${alignedPrompt.tokens} + 工具系统提示 ${TOOL_SYSTEM_TOKENS}`, alignedPrompt.bytes.length],
          wire('模型读到的（ChatML 展开，本站演示）', 'mem', 'internal', promptPieces('截断后的 ChatML 文本', alignedPrompt)),
          { ds: { window: [budgetRow('bw', alignedPlan, { w: 46, lift: ['retrieval'] })] } }),
        pk('model', 'app', 'green', '回复', [`「${REPLY.slice(0, 11)}…」`, `${N.output} token`], [N.input2 + N.output, 'INFER', `生成 ${N.output} 个 token：能答到账时间，但不知道订单号`, utf8Encode(REPLY).length],
          wire('模型写出的回复（示例）', 'mem', 'format', utf8Lines('回复文本', REPLY, { color: 'green', summary: `${[...REPLY].length} 个字符，${N.output} 个 token（模型写的内容是示例）`, notes: { 0: '这段话是示例：本站不跑大模型。它的字节和 token 数是真实计算的。' } })),
          { ds: { messages: [messagesRow({ from: alignedStart, marks: [{ at: 0, text: `${ORDER_ID} 在这里`, color: 'amber', dx: 30 }] })] } }),
        render,
        note('app', '订单号被截掉了，只能再问', 'amber'),
      ],
    },
  ],
  outro: {
    title: '窗口是一笔要先算清的账',
    desc: `输入 ${N.input} + 输出 ${MAX_TOKENS}，窗口 ${WINDOW}`,
    text: `一次 Agent 请求里，真正的问题只占一小格：工具定义和工具系统提示、system、模板这些固定开销先吃掉一大块，历史和检索在剩下的里面抢位置，还要给输出留足预留。放不下时最省事的是截断，但要整轮地丢，不能拆散 tool_use 和 tool_result；而且丢掉的往往是最早、最关键的事实。本站的 token 数来自迷你分词器，真实模型的词表大得多、窗口是 ${num(REAL)}，绝对值不同，但拆账的算法和取舍是一样的。下一课看另一种办法：把旧的几轮压缩成摘要。`,
    facts: [['输入', `${N.input} token`], ['截断后', `${N.input2} token`], ['丢掉的事实', lostAligned.join('、')], ['下一课', '上下文压缩']],
  },
};
