/**
 * 上下文工程组第二课：上下文压缩。
 * 接着上一课的对话又聊了几轮（退款、联系偏好、到账时间），输入越过压缩阈值。三种做法真实对比：
 *   - 直接截断（dropOldest + 对齐到轮次），压到和压缩一样的大小，看丢了哪些事实；
 *   - 压缩（core/budget.ts 的 compact）：旧的几轮换成一段摘要。摘要文字是示例（E.G.），压缩前后的 token 数、压缩比、
 *     保住了哪些事实都真实计算；
 *   - 工具结果清理（core/context.ts 的 clearToolResults）：只留最近几次工具结果。
 * Anthropic 服务端的 compaction（compact_20260112）和 context editing（clear_tool_uses_20250919）的字段照文档核对过。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  alignToRound,
  clearToolResults,
  compact,
  countTokens,
  dropOldest,
  encodeJson,
  exampleId,
  planBudget,
  renderRequest,
  roundStarts,
  type MessageParam,
  type MessagesRequest,
  type RenderedPrompt,
} from '../core';
import { concept, jsonBody, num, promptPieces, utf8Lines, wire } from '../decode/structures';
import { budgetRow, CITY, DOCS, factsIn, HISTORY, messageTokens, MODEL, ORDER_ID, SYSTEM, TOOL_SYSTEM_TOKENS, TOOLS, turnOf } from './agent';
import { pct } from './common';
import { note, pk, show } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 这段对话 ----------

export const WINDOW = 4000;
/** 演示用的压缩阈值（输入 token）。API 的 compact_20260112 默认是 150,000，最低 50,000。 */
export const TRIGGER = 2800;
export const MAX_TOKENS = 512;

const SEARCH_1 = exampleId('toolu', 12);
const REFUND_ID = exampleId('toolu', 13);
const SEARCH_2 = exampleId('toolu', 14);
export const REFUND_NO = 'R7731';

/** 上一课之后又聊的三轮，外加本轮的问题。助手说的话是示例，工具结果来自规则库和退款接口（数据是示例）。 */
export const MORE: MessageParam[] = [
  { role: 'user', content: '那就退款吧。' },
  { role: 'assistant', content: [{ type: 'text', text: '好的，我先查一下退款规则。' }, { type: 'tool_use', id: SEARCH_1, name: 'search_docs', input: { query: '质量问题 退款' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: SEARCH_1, content: `${DOCS.aftersale}\n${DOCS.refund}\n${DOCS.shipping}` }] },
  { role: 'assistant', content: '质量问题可以全额退款 129 元，运费由店铺承担。确认退款 129 元吗？' },
  { role: 'user', content: '确认。另外以后别打电话，发短信就行。' },
  { role: 'assistant', content: [{ type: 'tool_use', id: REFUND_ID, name: 'refund', input: { order_id: ORDER_ID, amount: 129 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: REFUND_ID, content: `{"refund_id":"${REFUND_NO}","status":"processing","amount":129}` }] },
  { role: 'assistant', content: `退款已提交，单号 ${REFUND_NO}，129 元原路退回。以后只用短信联系您。` },
  { role: 'user', content: '退到支付宝要多久？' },
  { role: 'assistant', content: [{ type: 'tool_use', id: SEARCH_2, name: 'search_docs', input: { query: '退款 到账 支付宝' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: SEARCH_2, content: DOCS.refund }] },
  { role: 'assistant', content: '支付宝 1–3 个工作日到账。' },
  { role: 'user', content: '要是 3 天还没到账，我该找谁？' },
];

export const MESSAGES: MessageParam[] = [...HISTORY, ...MORE];
export const REQUEST: MessagesRequest = { model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages: MESSAGES };

/** 这段对话里值得记住的事实：订单号、城市、金额、退款单号、联系偏好。按字面查它们还在不在。 */
export const KEY_FACTS = [ORDER_ID, CITY, '129', REFUND_NO, '短信'];

const inputOf = (prompt: RenderedPrompt) => prompt.tokens + TOOL_SYSTEM_TOKENS;
const textOf = (messages: readonly MessageParam[]) => messages.map((message) => turnOf(message).text).join('\n');

export const prompt = renderRequest(REQUEST);
export const input = inputOf(prompt);
export const msgTokens = MESSAGES.map((_, i) => messageTokens(prompt, i));

/** 轮次：用户的一句话 + 之后的工具往返 + 助手的回答。最后一轮只有本轮的问题。 */
export const starts = roundStarts(MESSAGES);
export const rounds = starts.map((from, k) => ({ from, to: starts[k + 1] ?? MESSAGES.length }));
export const roundTokens = rounds.map(({ from, to }) => msgTokens.slice(from, to).reduce((sum, value) => sum + value, 0));
const hasTool = (from: number, to: number) => MESSAGES.slice(from, to).some((message) => typeof message.content !== 'string' && message.content.some((block) => block.type === 'tool_result'));

/** 拆账：工具、工具提示、system、历史、本轮、模板。 */
function partsOf(rendered: RenderedPrompt, messages: readonly MessageParam[]) {
  const tools = rendered.bySource.tools ?? 0;
  const system = rendered.bySource.system ?? 0;
  const last = messages.length - 1;
  let history = 0;
  for (let i = 0; i < last; i++) history += messageTokens(rendered, i);
  const current = messageTokens(rendered, last);
  return [
    { id: 'tools', label: '工具', kind: 'tools' as const, tokens: tools },
    { id: 'toolSystem', label: '工具提示', kind: 'tools' as const, tokens: TOOL_SYSTEM_TOKENS },
    { id: 'system', label: 'system', kind: 'system' as const, tokens: system },
    { id: 'history', label: '历史', kind: 'history' as const, tokens: history },
    { id: 'current', label: '本轮', kind: 'user' as const, tokens: current },
    { id: 'template', label: '模板', kind: 'template' as const, tokens: rendered.tokens - tools - system - history - current },
  ];
}

export const plan = planBudget(WINDOW, partsOf(prompt, MESSAGES), MAX_TOKENS);

// ---------- 之前的请求：每一轮都把整段历史再发一遍 ----------

/**
 * 这段对话里模型已经处理过的请求：每条用户消息（自己说的话或送回的工具结果）之后都是一次请求，
 * 读入到这里为止的全部内容（加上工具系统提示），写出下一条助手消息。
 */
export const earlier = MESSAGES.flatMap((message, i) => (message.role === 'user' && i < MESSAGES.length - 1 ? [i] : [])).map((i) => ({
  at: i,
  input: inputOf(renderRequest({ ...REQUEST, messages: MESSAGES.slice(0, i + 1) })),
  output: countTokens(turnOf(MESSAGES[i + 1]).text),
}));
export const processedBefore = earlier.reduce((sum, item) => sum + item.input + item.output, 0);

// ---------- 压缩 ----------

/** 保留最近的一整轮和本轮，之前的都压进摘要。 */
export const keepFrom = starts[starts.length - 2];
export const KEEP_RECENT = MESSAGES.length - keepFrom;

/** 模型写的摘要：示例。它的 token 数、保住了哪些事实是真实计算的。 */
export const SUMMARY = `之前的对话摘要：用户在${CITY}，订单 ${ORDER_ID}（保温杯，129 元，顺丰已送达）杯盖漏水、有裂缝，确认是质量问题。用户选择退款并确认了金额，退款单 ${REFUND_NO} 已提交，129 元原路退回。用户要求以后只用短信联系，不要打电话。`;

/** 压缩器发给模型的指令（应用自己写的摘要提示）。 */
export const INSTRUCTION = '请把以上对话压缩成一段摘要，供后续对话接着用。保留订单号、金额、退款单号、用户的偏好和尚未解决的问题，省略寒暄和工具结果的原文。';

export const old = MESSAGES.slice(0, keepFrom);
export const summarizeRequest: MessagesRequest = { ...REQUEST, messages: [...old, { role: 'user', content: INSTRUCTION }] };
export const summarizePrompt = renderRequest(summarizeRequest);
export const summarizeInput = inputOf(summarizePrompt);
export const summaryTokens = countTokens(SUMMARY);

export const compacted = compact(MESSAGES.map(turnOf), KEEP_RECENT, () => SUMMARY);
/** 换上摘要后的请求：摘要作为一条用户消息放在最前面，后面接着保留的消息（相邻的两条用户消息会被合并成一轮）。 */
export const COMPACTED: MessageParam[] = [{ role: 'user', content: SUMMARY }, ...MESSAGES.slice(keepFrom)];
export const compactedPrompt = renderRequest({ ...REQUEST, messages: COMPACTED });
export const compactedInput = inputOf(compactedPrompt);
export const compactedPlan = planBudget(WINDOW, partsOf(compactedPrompt, COMPACTED), MAX_TOKENS);
export const keptFacts = factsIn(textOf(COMPACTED), KEY_FACTS);

// ---------- 直接截断，压到同样大小 ----------

/** 截断的目标：和压缩后一样大的输入。消息能用的 = 目标 − 工具、工具提示、system、模板。 */
const fixed = plan.rows.filter((row) => ['tools', 'toolSystem', 'system', 'template'].includes(row.id)).reduce((sum, row) => sum + row.tokens, 0);
export const truncBudget = compactedInput - fixed;
export const truncated = dropOldest(MESSAGES.map(turnOf), truncBudget);
export const truncFrom = alignToRound(MESSAGES, truncated.dropped.length);
export const truncInput = inputOf(renderRequest({ ...REQUEST, messages: MESSAGES.slice(truncFrom) }));
export const truncKept = factsIn(textOf(MESSAGES.slice(truncFrom)), KEY_FACTS);
export const truncLost = KEY_FACTS.filter((fact) => !truncKept.includes(fact));

// ---------- 工具结果清理 ----------

export const CLEAR_KEEP = 2;
/** 占位文字：本站的写法。API 只说会换成「表明结果已被移除的占位文字」，没有给出原文。 */
export const PLACEHOLDER = '[旧的工具结果已清除]';
export const cleared = clearToolResults(MESSAGES, { keep: CLEAR_KEEP, placeholder: PLACEHOLDER });
export const clearedInput = inputOf(renderRequest({ ...REQUEST, messages: cleared.messages }));
export const clearedKept = factsIn(textOf(cleared.messages), KEY_FACTS);

/** 服务端做法的请求参数和响应字段（字段照文档；数值是本站的计数）。 */
export const compactEdit = encodeJson({ context_management: { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150000 } }] } });
export const compactionBlock = encodeJson({ type: 'compaction', content: SUMMARY });
export const clearEdit = encodeJson({ context_management: { edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 100000 }, keep: { type: 'tool_uses', value: 3 } }] } });
export const appliedEdits = encodeJson({ context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: cleared.cleared.length, cleared_input_tokens: input - clearedInput }] } });

// ---------- 图元 ----------

/** 按轮画：每格一轮，写 token 数。from 之前的轮变暗；summary 时第一格换成摘要。 */
function roundsRow(options: { from?: number; summary?: boolean; marks?: RowPrim['marks']; lift?: number[] } = {}): RowPrim {
  const cells: DsCell[] = [];
  if (options.summary) cells.push({ v: String(summaryTokens), tone: 'amber', sub: '摘要', key: 'sum', lift: true });
  rounds.forEach(({ from, to }, k) => {
    if (options.summary && from < keepFrom) return;
    const gone = options.from !== undefined && from < options.from;
    cells.push({ v: String(roundTokens[k]), tone: gone ? 'dim' : k === rounds.length - 1 ? 'blue' : hasTool(from, to) ? 'teal' : 'blue', sub: k === rounds.length - 1 ? '本轮' : `第${k + 1}轮`, key: `r${k}`, lift: options.lift?.includes(k) || undefined });
  });
  return { kind: 'row', id: 'rd', w: 52, cells, marks: options.marks };
}

const roundOf = (message: number) => rounds.findIndex(({ from, to }) => message >= from && message < to);

// ---------- 文案用到的数 ----------

const oldTokens = msgTokens.slice(0, keepFrom).reduce((sum, value) => sum + value, 0);
/** 最近三个完整轮次平均每轮多少 token，照这个速度窗口还能再装几轮。 */
const recentRounds = roundTokens.slice(-4, -1);
export const perRound = Math.round(recentRounds.reduce((sum, value) => sum + value, 0) / recentRounds.length);
export const roundsLeft = Math.floor(plan.free / perRound);
/** 历史里工具结果占多少 token。 */
export const toolResultTokens = MESSAGES.slice(0, -1).reduce((sum, message, i) => sum + (typeof message.content !== 'string' && message.content.some((block) => block.type === 'tool_result') ? msgTokens[i] : 0), 0);

export const numbers = {
  messages: MESSAGES.length,
  rounds: rounds.length,
  input,
  used: plan.used,
  free: plan.free,
  requests: earlier.length,
  processedBefore,
  keepFrom,
  oldMessages: keepFrom,
  oldTokens,
  summarizeInput,
  summaryTokens,
  ratio: compacted.ratio,
  historyBefore: compacted.before,
  historyAfter: compacted.after,
  compactedInput,
  saved: input - compactedInput,
  savedShare: (input - compactedInput) / input,
  truncFrom,
  truncInput,
  clearedCount: cleared.cleared.length,
  clearedInput,
  clearedSaved: input - clearedInput,
  perRound,
  roundsLeft,
  toolResults: cleared.cleared.length + CLEAR_KEEP,
  toolResultTokens,
};

const N = numbers;
const ratioText = (value: number) => `${value.toFixed(1)} 倍`;
const afterCompact = N.processedBefore + N.summarizeInput + N.summaryTokens;

// ---------- 课程 ----------

export const compaction: Lesson = {
  id: 'compaction',
  name: 'COMPACTION',
  title: '上下文压缩',
  group: 'context',
  layer: [4, 6],
  layerNote: '在消息层面把旧的几轮换成摘要或清掉工具结果，再看展开后的 token 和窗口的账怎样变化。',
  tokensNote: '这段对话之前每次请求的读入和写出（每轮都把整段历史再读一遍），加上压缩时写摘要的那次调用和压缩后的请求。',
  nodes: ['app', 'messages', 'window', 'compactor', 'model'],
  place: { app: [110, 330], messages: [380, 600], window: [800, 520], compactor: [560, 110], model: [930, 180] },
  labels: {
    app: ['应用', '客服 Agent'],
    messages: ['对话历史', '每格一轮，写 token 数'],
    window: ['上下文窗口', `演示窗口 ${num(WINDOW)}，阈值 ${num(TRIGGER)}`],
    compactor: ['压缩器', '旧的几轮换成摘要'],
    model: ['模型', 'Claude Opus 5.5'],
  },
  labelAt: { messages: [-215, 30], window: [170, -125] },
  radius: { messages: 70, window: 70 },
  initial: { messages: [], window: [] },
  start: ['app', 'messages'],
  legend: [['blue', '用户自己说的话'], ['teal', '带工具往返的轮次'], ['amber', '摘要、超过阈值'], ['slate', '模板开销'], [null, 'token 列：这段对话里模型累计读入和写出的 token']],
  overview: {
    full: '旧的几轮，换成一段摘要',
    description: `上一课的对话又聊了几轮：确认退款、要求只发短信、问到账时间。现在一共 ${N.messages} 条消息、${N.rounds} 轮，请求的输入涨到 ${N.input} token，越过了 ${num(TRIGGER)} 的压缩阈值。这一课用三种办法把它压小：直接截断、写摘要替换旧的几轮、只清掉旧的工具结果。三种办法的 token 数、节省比例、保住了哪些事实都真实计算，摘要的文字是示例。`,
    facts: [
      ['对话', `${N.messages} 条消息，${N.rounds} 轮`],
      ['输入', `${N.input} token（阈值 ${num(TRIGGER)}）`],
      ['压缩后', `${N.compactedInput} token，省 ${pct(N.savedShare)}`],
      ['清工具结果', `${N.clearedInput} token`],
      ['服务端', 'compact_20260112、clear_tool_uses_20250919（beta）'],
    ],
  },
  steps: [
    {
      title: '长对话越过阈值',
      desc: `${N.rounds} 轮，输入 ${N.input} > 阈值 ${num(TRIGGER)}`,
      detail: `API 不保存对话，每次请求都把整段历史再发一遍：这段对话到现在已经发了 ${N.requests} 次请求，模型累计读写了 ${num(N.processedBefore)} 个 token，每次都比上一次长。本轮的输入是 ${N.input}，加上输出预留 ${MAX_TOKENS}，离 ${num(WINDOW)} 的窗口还剩 ${N.free}，但已经越过 ${num(TRIGGER)} 的阈值：最近三轮平均每轮 ${perRound} token，照这样再聊 ${roundsLeft} 轮就放不下了。所以压缩要趁还放得下的时候做，而不是等到报错。`,
      facts: [['之前的请求', `${N.requests} 次`], ['累计读写', `${num(N.processedBefore)} token`], ['本轮输入', `${N.input} token`], ['窗口剩余', `${N.free} token`]],
      events: [
        pk('app', 'messages', 'blue', `第 ${N.rounds} 轮`, [`${N.messages} 条消息`, `输入 ${N.input}`], [N.processedBefore, 'BUDGET', `第 ${N.rounds} 轮：输入 ${N.input}，越过阈值 ${TRIGGER}；之前 ${N.requests} 次请求累计读写 ${N.processedBefore} token`, null],
          wire('每次请求读入多少（每轮都把整段历史再发一遍）', 'mem', '示意', concept('之前的请求', [
            ...earlier.map((item, k): [string, string, string?] => [`请求 ${k + 1}`, `读 ${item.input} · 写 ${item.output}`, k === 0 ? '读入 = 到这条用户消息为止的全部内容（展开后）+ 工具系统提示；写出 = 下一条助手消息。' : undefined]),
            ['合计', `${num(N.processedBefore)} token`, '历史越长，每次请求重复读的越多：总量随轮数大致按平方增长。'],
          ])),
          { ds: { messages: [roundsRow({ lift: [rounds.length - 1] })] } }),
        show('window'),
        pk('messages', 'window', 'violet', '拆账', [`输入 ${N.input}`, `阈值 ${TRIGGER}`], [N.processedBefore, 'BUDGET', `planBudget：输入 ${N.input} + 输出预留 ${MAX_TOKENS} = ${N.used}，窗口 ${WINDOW}，剩 ${N.free}`, null],
          wire('本轮的预算表', 'mem', '示意', concept('planBudget', [
            ...plan.rows.map((row): [string, string] => [row.label, `${row.tokens} token · ${pct(row.share)}`]),
            ['剩余', `${plan.free} token`],
            ['阈值', `输入 ${TRIGGER}`, '演示用的阈值。服务端压缩 compact_20260112 的 trigger 默认是 150,000 输入 token，最低 50,000。'],
          ])),
          { ds: { window: [budgetRow('cw', plan, { w: 46, lift: ['history'] })] } }),
        note('window', `输入 ${N.input} > 阈值 ${TRIGGER}`, 'amber'),
      ],
    },
    {
      title: '直接截断会丢什么',
      desc: `截到 ${N.truncInput}，${truncLost.length} 个关键事实${truncKept.length ? `丢了 ${truncLost.length}` : '全丢了'}`,
      detail: `先看最省事的办法：用上一课的 dropOldest 加上对齐到轮次，把输入压到和压缩后差不多的 ${N.compactedInput} 以内，结果是从第 ${roundOf(truncFrom) + 1} 轮开始保留，输入 ${N.truncInput}。按字面查 ${KEY_FACTS.length} 个关键事实：${truncKept.length ? `丢了 ${truncLost.join('、')}，只剩 ${truncKept.join('、')}` : `${truncLost.join('、')} 全丢了`}。订单号是第一句话说的，退款单号和「只发短信」是对话中途才定下来的，一截就都没了，下一轮模型可能又打电话。`,
      facts: [['保留', `第 ${roundOf(truncFrom) + 1} 轮起`], ['输入', `${N.truncInput} token`], ['丢了', truncLost.join('、')], ['还在', truncKept.join('、') || '一个都没有']],
      events: [
        pk('app', 'messages', 'slate', '截断', [`预算 ${truncBudget}`, `从第 ${roundOf(truncFrom) + 1} 轮开始`], [N.processedBefore, 'TRIM', `截断到第 ${roundOf(truncFrom) + 1} 轮起：输入 ${N.truncInput}，丢了 ${truncLost.join('、')}`, null],
          wire('截断的结果', 'mem', '示意', concept('dropOldest + alignToRound', [
            ['目标', `输入 ≤ ${N.compactedInput}`, '和压缩后的输入一样大，好比较。'],
            ['消息预算', `${N.compactedInput} − ${fixed} = ${truncBudget}`, '减去工具、工具提示、system、模板。'],
            ['保留', `messages[${truncFrom}] 起`, '对齐到轮次，不拆散工具往返。'],
            ...KEY_FACTS.map((fact): [string, string] => [fact, truncKept.includes(fact) ? '还在' : '丢了']),
          ])),
          { ds: { messages: [roundsRow({ from: truncFrom, marks: [{ at: roundOf(truncFrom), text: `丢了 ${truncLost.length} 个事实`, color: 'amber', dx: 40 }] })] } }),
      ],
    },
    {
      title: '压缩器请模型写摘要',
      desc: `读 ${N.summarizeInput}，写出 ${N.summaryTokens} token 的摘要`,
      detail: `压缩器把前 ${rounds.length - 2} 轮（messages[0] 到 [${keepFrom - 1}]，${N.oldTokens} token）连同一条指令发给模型：保留订单号、金额、退款单号、用户偏好和没解决的问题，省掉寒暄和工具结果原文。模型读入 ${N.summarizeInput} 个 token，写出 ${N.summaryTokens} 个 token 的摘要，被压缩的部分缩小到 1/${N.ratio.toFixed(1)}。压缩本身也要花一次调用的钱，换来之后每一轮都少读这么多。`,
      facts: [['被压缩', `${N.oldMessages} 条，${N.oldTokens} token`], ['摘要', `${N.summaryTokens} token（文字是示例）`], ['压缩比', ratioText(N.ratio)], ['这次调用', `读 ${N.summarizeInput}，写 ${N.summaryTokens}`]],
      events: [
        show('compactor'),
        pk('app', 'compactor', 'amber', `前 ${rounds.length - 2} 轮`, [`${N.oldMessages} 条消息`, `${N.oldTokens} token`], [N.processedBefore, 'COMPACT', `把 messages[0–${keepFrom - 1}]（${N.oldTokens} token）交给压缩器，保留最近一轮和本轮`, null],
          wire('压缩器收到的：旧的几轮和保留的部分', 'mem', '示意', concept('compact(turns, keepRecent, summarize)', [
            ['turns', `${N.messages} 条`],
            ['keepRecent', `${KEEP_RECENT} 条（最近一轮 + 本轮）`, '保留的部分从轮次开头切，不拆散工具往返。'],
            ['被压缩', `messages[0–${keepFrom - 1}]，${N.oldTokens} token`],
            ['summarize', '请模型写摘要', '摘要文字由模型写，本站用示例；它的 token 数真实计算。'],
          ])),
          { ds: { messages: [roundsRow({ lift: rounds.slice(0, -2).map((_, k) => k) })] } }),
        show('model'),
        pk('compactor', 'model', 'violet', '写摘要', [`读 ${N.summarizeInput} token`, '旧的几轮 + 指令'], [N.processedBefore + N.summarizeInput, 'INFER', `模型读入 ${N.summarizeInput} token：旧的 ${N.oldMessages} 条消息 + 摘要指令（+ 工具系统提示 ${TOOL_SYSTEM_TOKENS}）`, utf8Encode(INSTRUCTION).length],
          wire('写摘要的请求：最后一条是压缩器的指令', 'mem', 'format',
            utf8Lines('摘要指令（messages 的最后一条）', INSTRUCTION, { color: 'blue', summary: `${countTokens(INSTRUCTION)} 个 token；前面是原样的 ${N.oldMessages} 条旧消息` }),
            jsonBody('服务端做法：compact_20260112（beta）', compactEdit, {
              root: 'context_management',
              expand: ['context_management.edits[0].type', 'context_management.edits[0].trigger'],
              notes: {
                edits: '不想自己写压缩器，可以让 API 做：带上 beta 头 compact-2026-01-12，在 context_management.edits 里加这一项。',
                'context_management.edits[0].trigger': '输入 token 到这个数就压缩，默认 150,000，最低 50,000。还可以用 instructions 换掉默认的摘要提示、用 pause_after_compaction 在写完摘要后暂停。',
              },
            })),
          { ds: { messages: [roundsRow({ lift: rounds.slice(0, -2).map((_, k) => k) })] } }),
        pk('model', 'compactor', 'amber', '摘要', [`${N.summaryTokens} token`, `压缩比 ${ratioText(N.ratio)}`], [afterCompact, 'COMPACT', `生成 ${N.summaryTokens} token 的摘要：${N.oldTokens} → ${N.summaryTokens}，${ratioText(N.ratio)}`, utf8Encode(SUMMARY).length],
          wire('模型写的摘要（示例）', 'mem', 'format', utf8Lines('摘要', SUMMARY, { color: 'amber', summary: `${[...SUMMARY].length} 个字符，${N.summaryTokens} 个 token（模型写的内容是示例）`, notes: { 0: '摘要的文字是示例。它保住了哪些事实、占多少 token，是对这段文字真实计算的。' } })),
          { ds: { messages: [roundsRow({ from: keepFrom, marks: [{ at: 0, text: `${N.summaryTokens} token 的摘要`, color: 'amber', dx: 30 }] })] } }),
      ],
    },
    {
      title: '换上摘要',
      desc: `输入 ${N.input} → ${N.compactedInput}，省 ${pct(N.savedShare)}`,
      detail: `摘要作为一条用户消息放在最前面，后面原样接着最近一轮和本轮：历史从 ${N.historyBefore} 变成 ${N.historyAfter}，整个输入从 ${N.input} 降到 ${N.compactedInput}，回到阈值以下。按字面查，${KEY_FACTS.length} 个关键事实都还在：${keptFacts.join('、')}。交给服务端压缩（compact_20260112）时，摘要以响应里的一个 compaction 块回来，下次把整个响应原样追加回去，API 会忽略这个块之前的所有内容。`,
      facts: [['历史', `${N.historyBefore} → ${N.historyAfter}`], ['输入', `${N.input} → ${N.compactedInput}`], ['节省', `${N.saved} token（${pct(N.savedShare)}）`], ['保住的事实', `${keptFacts.length} / ${KEY_FACTS.length}`]],
      events: [
        pk('compactor', 'messages', 'amber', '换上摘要', [`历史 ${N.historyBefore} → ${N.historyAfter}`, `${keptFacts.length} 个事实都在`], [afterCompact, 'COMPACT', `摘要替换 messages[0–${keepFrom - 1}]：历史 ${N.historyBefore} → ${N.historyAfter}，关键事实 ${keptFacts.length}/${KEY_FACTS.length}`, utf8Encode(SUMMARY).length],
          wire('服务端压缩时，响应里的 compaction 块（字段照文档，内容是示例）', 'mem', 'format', jsonBody('compaction 块', compactionBlock, {
            example: ['content'],
            notes: {
              type: 'compact_20260112 触发时，响应里会有这个块。要把 response.content 整个追加回 messages，只取文字会丢掉它。',
              content: '摘要。下一次请求时，API 自动忽略这个块之前的所有内容块，从摘要接着对话。',
            },
          })),
          { ds: { messages: [roundsRow({ summary: true })] } }),
        pk('messages', 'window', 'violet', '重新拆账', [`输入 ${N.compactedInput}`, `剩 ${compactedPlan.free}`], [afterCompact, 'BUDGET', `压缩后：输入 ${N.compactedInput} + 输出预留 ${MAX_TOKENS} = ${compactedPlan.used}，剩 ${compactedPlan.free}`, null],
          wire('压缩后的预算表', 'mem', '示意', concept('planBudget（压缩后）', [
            ...compactedPlan.rows.map((row): [string, string] => [row.label, `${row.tokens} token · ${pct(row.share)}`]),
            ['剩余', `${compactedPlan.free} token`],
            ['节省', `${N.saved} token（${pct(N.savedShare)}）`],
          ])),
          { ds: { window: [budgetRow('cw', compactedPlan, { w: 46, lift: ['history', 'free'] })] } }),
        pk('window', 'model', 'violet', `${N.compactedInput} token`, ['摘要 + 最近一轮 + 本轮'], [afterCompact + N.compactedInput, 'INFER', `模型读入压缩后的 ${N.compactedInput} token（比压缩前少读 ${N.saved}）`, compactedPrompt.bytes.length],
          wire('模型读到的（ChatML 展开，本站演示）', 'mem', 'internal', promptPieces('压缩后的 ChatML 文本', compactedPrompt, { notes: { 'messages[0].content': '摘要（示例文字）。它和本轮之前的用户消息相邻，按 Messages API 的规则合并成同一轮。' } })),
          { ds: { window: [budgetRow('cw', compactedPlan, { w: 46, lift: ['history'] })] } }),
      ],
    },
    {
      title: '另一种：只清旧的工具结果',
      desc: `留最近 ${CLEAR_KEEP} 次，清掉 ${N.clearedCount} 次，省 ${N.clearedSaved}`,
      detail: `这段历史里 ${N.toolResults} 次工具结果占了 ${N.toolResultTokens} token（${pct(N.toolResultTokens / N.historyBefore)}），而且清掉了还能再查一次。clearToolResults 只留最近 ${CLEAR_KEEP} 次工具结果，更早的 ${N.clearedCount} 次（${cleared.cleared.map((item) => item.name).join('、')}）换成占位文字，tool_use 和配对关系不动：输入从 ${N.input} 降到 ${N.clearedInput}，省 ${N.clearedSaved}，${clearedKept.length} 个关键事实一个不少。它省得比摘要少，但不需要额外调用模型，也不会把话说错；Anthropic 的 context editing（clear_tool_uses_20250919）是同样的做法，在服务端发生，客户端的历史保持原样。`,
      facts: [['清掉', cleared.cleared.map((item) => item.name).join('、')], ['输入', `${N.input} → ${N.clearedInput}`], ['保住的事实', `${clearedKept.length} / ${KEY_FACTS.length}`], ['对比摘要', `省 ${N.clearedSaved} 对 ${N.saved}`]],
      events: [
        pk('app', 'messages', 'teal', '清工具结果', [`keep ${CLEAR_KEEP}`, `清掉 ${N.clearedCount} 次`], [afterCompact + N.compactedInput, 'COMPACT', `clearToolResults：留最近 ${CLEAR_KEEP} 次，清掉 ${cleared.cleared.map((item) => item.name).join('、')}，输入 ${N.input} → ${N.clearedInput}`, null],
          wire('被清掉的工具结果', 'mem', '示意', concept('clearToolResults(messages, { keep, placeholder })', [
            ...cleared.cleared.map((item): [string, string, string] => [`messages[${item.message}]`, `${item.name}：${countTokens(item.text)} token → 占位`, `原文：${item.text.slice(0, 40)}${item.text.length > 40 ? '…' : ''}`]),
            ['占位文字', PLACEHOLDER, '本站的写法。API 只说会换成表明结果已被移除的占位文字，没有给出原文。'],
            ['不动的', 'tool_use 块、用户和助手说的话', '配对关系还在，请求仍然合法。'],
          ])),
          { ds: { messages: [roundsRow({ lift: cleared.cleared.map((item) => roundOf(item.message)), marks: cleared.cleared.map((item, k) => ({ at: roundOf(item.message), text: k ? '清掉' : `清掉 ${item.name}`, color: 'teal' as const, dx: 20 })).filter((mark, k, all) => all.findIndex((other) => other.at === mark.at) === k) })] } }),
        pk('messages', 'window', 'teal', `${N.clearedInput} token`, [`省 ${N.clearedSaved}`, `事实 ${clearedKept.length}/${KEY_FACTS.length}`], [afterCompact + N.compactedInput, 'BUDGET', `清理后：输入 ${N.clearedInput}，省 ${N.clearedSaved}（压缩省 ${N.saved}）`, appliedEdits.bytes.length],
          wire('服务端做法：context editing（字段照文档，数值是本站计数）', 'mem', 'format',
            jsonBody('请求参数（beta 头 context-management-2025-06-27）', clearEdit, {
              root: 'context_management',
              expand: ['context_management.edits[0].trigger', 'context_management.edits[0].keep'],
              notes: { edits: 'clear_tool_uses_20250919：输入超过 trigger（默认 100,000 token）时，从最早的开始清工具结果，留最近 keep 次（默认 3）。clear_at_least 保证每次至少清掉多少，exclude_tools 列出永远不清的工具。' },
            }),
            jsonBody('响应里的 applied_edits', appliedEdits, {
              root: 'context_management',
              expand: ['context_management.applied_edits[0].cleared_tool_uses', 'context_management.applied_edits[0].cleared_input_tokens'],
              notes: { applied_edits: `这次清了几次、省了多少 token。这里填的是本站按 keep ${CLEAR_KEEP} 算出的数。清理会让缓存的前缀失效，所以文档建议用 clear_at_least 一次多清一些。` },
            })),
          { ds: { window: [budgetRow('cw', planBudget(WINDOW, partsOf(renderRequest({ ...REQUEST, messages: cleared.messages }), cleared.messages), MAX_TOKENS), { w: 46, lift: ['history'] })] } }),
      ],
    },
  ],
  outro: {
    title: '压缩是有损的，清理是可逆的',
    desc: `${N.input} → 摘要 ${N.compactedInput} / 清理 ${N.clearedInput}`,
    text: `长对话迟早放不下。直接截断最省事，但会丢掉中途才出现的约定；写摘要能把旧的几轮压到 1/${N.ratio.toFixed(1)}，关键事实靠摘要保住，代价是一次额外调用，而且摘要写错了就一直错下去；清掉旧的工具结果省得少，却不丢用户说过的话，需要时再调一次工具就行。长期跑的 Agent 常把它们叠起来用。可是压缩只在一段对话之内有效，用户明天开一个新会话，这些都不在了。下一课看记忆：把值得长期保存的事实写到对话之外，新会话开始时再按相关性取回来。`,
    facts: [['截断', `${N.truncInput}，丢 ${truncLost.length} 个事实`], ['摘要', `${N.compactedInput}，${ratioText(N.ratio)}`], ['清理', `${N.clearedInput}，不丢事实`], ['下一课', '记忆系统写入与召回']],
  },
};
