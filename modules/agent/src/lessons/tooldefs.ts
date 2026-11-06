/**
 * 循环组第二课：工具定义如何进入提示。tools 数组里每个工具的 name、description、input_schema 怎样展开成模型读到的 token，
 * 为什么每一轮都要再付一次，描述写得好坏怎样影响参数和轮数，tool_choice 四种取值。
 *
 * 全部真实计算：主运行和 react 课是同一次运行（同一个配置、同一个脚本，runAgent 重跑一遍，数字一样）；每个工具单独数 token
 * 用 llm-core 的迷你分词器（countTokens，和请求展开时的写法 toolsText 一致）；工具系统提示用文档给的 286；
 * 「多一个工具」和「坏描述」是另外两次 runAgent；坏描述导致的参数错误由 core/schema.ts 校验出来；
 * tool_choice 的 400 由 validateRequest 判断，错误信息是文档原文。模型写的内容是脚本（E.G.）。tests/narrative.test.ts 核对文案。
 */
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import {
  buildRequest,
  countTokens,
  CREATE_RETURN,
  createShop,
  encodeJson,
  encodeResponse,
  errorHttpResponse,
  exampleId,
  formatErrors,
  inputBreakdown,
  ISSUE_REFUND,
  ORDER_ID,
  runAgent,
  shopToolBox,
  text,
  toolsText,
  toolSystemTokens,
  ToolBox,
  toolUse,
  validateRequest,
  type AgentConfig,
  type AgentTurn,
  type ScriptStep,
  type SchemaError,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type ToolSpec,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { pct, PART_TONE } from './common';
import { note, pk, show, state } from './dsl';
import { MODEL, REACT_SCRIPT, SUPPORT, USER_ASK } from './scenario';
import type { DsCell, GridPrim, Lesson, LessonEvent, RowPrim } from './types';

// ---------- 真实运行 ----------

/** 主运行：和 react 课同一个配置、同一个脚本。 */
export const run = runAgent(SUPPORT, USER_ASK, REACT_SCRIPT, { ctx: { shop: createShop() }, seed: 100 });
export const [t1, t2, t3, t4] = run.turns as [AgentTurn, AgentTurn, AgentTurn, AgentTurn];
export const defs: ToolDefinition[] = SUPPORT.tools.definitions();

/** 每个工具在提示里是一行紧凑 JSON（toolsText 的写法）：单独数这一行的 token。 */
const lineTokens = (def: ToolDefinition): number => countTokens(encodeJson({ name: def.name, description: def.description, input_schema: def.input_schema }).text);
export const perTool = defs.map(lineTokens);
export const perDesc = defs.map((def) => countTokens(def.description ?? ''));
export const perSchema = defs.map((def) => countTokens(encodeJson(def.input_schema).text));

/** 多带一个 issue_refund：同一个脚本再跑一遍（脚本没用到它，它只是每轮都被带上）。 */
export const FOUR = { ...SUPPORT, tools: shopToolBox(['get_order', 'search_policy', 'create_return', 'issue_refund']) };
export const runFour = runAgent(FOUR, USER_ASK, REACT_SCRIPT, { ctx: { shop: createShop() }, seed: 100 });

/** 坏描述：create_return 的描述只剩一句，参数都没有说明；参数的约束（type、enum、required）不变，校验照旧。 */
const strip = (schema: ToolSpec['input_schema']): ToolSpec['input_schema'] => ({
  ...schema,
  properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const { description: _d, ...rest } = value;
    return [key, rest];
  })),
});
export const TERSE_RETURN: ToolSpec = { ...CREATE_RETURN, description: '建退货单。', input_schema: strip(CREATE_RETURN.input_schema) };
export const TERSE: AgentConfig = { ...SUPPORT, tools: new ToolBox([...SUPPORT.tools.specs.filter((spec) => spec.name !== 'create_return'), TERSE_RETURN]) };
const terseDef = TERSE.tools.definitions().find((def) => def.name === 'create_return')!;
const goodDef = defs.find((def) => def.name === 'create_return')!;

/** 坏描述的脚本：前两轮和 ReAct 一样；第三轮把「质量问题」写进 note、漏了 reason；看到错误后补上再调；最后回答。 */
export const TERSE_SCRIPT: ScriptStep[] = [
  REACT_SCRIPT[0],
  REACT_SCRIPT[1],
  [text('杯盖漏水，签收没超过 7 天，我来建退货单。'), toolUse('create_return', { order_id: ORDER_ID, note: '杯盖漏水，质量问题' }, 13)],
  ({ lastCalls }) => [text(`校验没过（${lastCalls[0].outcome.content.replace(/^参数不合格：/, '')}），补上 reason: quality 再调一次。`), toolUse('create_return', { order_id: ORDER_ID, reason: 'quality', note: '杯盖漏水' }, 14)],
  REACT_SCRIPT[3],
];
export const runTerse = runAgent(TERSE, USER_ASK, TERSE_SCRIPT, { ctx: { shop: createShop() }, seed: 300 });
const [, , b3, b4, b5] = runTerse.turns as AgentTurn[];
const badCall: ToolCall = b3.calls[0];
const fixCall: ToolCall = b4.calls[0];
export const badErrors = badCall.outcome.data as SchemaError[];

/** tool_choice 四种取值：同一个第一轮请求，只改 tool_choice。 */
const CHOICES: Array<[string, ToolChoice]> = [
  ['auto', { type: 'auto' }],
  ['any', { type: 'any' }],
  ['tool', { type: 'tool', name: 'get_order' }],
  ['none', { type: 'none' }],
];
export const choices = CHOICES.map(([label, choice]) => {
  const request = buildRequest({ ...SUPPORT, toolChoice: choice }, [{ role: 'user', content: USER_ASK }]);
  const error = validateRequest(request);
  const input = error ? null : inputBreakdown(request).total + toolSystemTokens(request);
  return { label, choice, request, error, input };
});
const anyChoice = choices[1];
const anyHttp = encodeResponse(errorHttpResponse(anyChoice.error!, { requestId: exampleId('req', 411) }));
const anyJson = encodeJson(anyChoice.request);

// ---------- 文案用到的数 ----------

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const toolsBytes = encodeJson(defs).bytes.length;
const perRoundTools = t1.breakdown.tools + t1.toolSystem;

export const numbers = {
  turns: run.totals.turns,
  inputs: run.turns.map((turn) => turn.message.usage.input_tokens),
  totalInput: run.totals.input,
  toolCount: defs.length,
  perTool,
  perDesc,
  perSchema,
  perToolSum: sum(perTool),
  wrapper: t1.breakdown.tools - sum(perTool),
  toolDefs: t1.breakdown.tools,
  toolSystem: t1.toolSystem,
  toolsBytes,
  perToolBytes: defs.map((def) => encodeJson(def).bytes.length),
  system: t1.breakdown.system,
  user: t1.breakdown.messages[0],
  template: t1.breakdown.template,
  prompt1: t1.breakdown.total,
  input1: t1.message.usage.input_tokens,
  share1: pct(perRoundTools / t1.message.usage.input_tokens),
  perRoundTools,
  toolsAllRounds: perRoundTools * run.totals.turns,
  toolsShare: pct((perRoundTools * run.totals.turns) / run.totals.input),
  refundTokens: lineTokens(ISSUE_REFUND),
  fourDefs: runFour.turns[0].breakdown.tools,
  fourTotal: runFour.totals.input,
  fourExtra: runFour.totals.input - run.totals.input,
  refundRound: runFour.turns[0].breakdown.tools - t1.breakdown.tools,
  goodReturn: lineTokens(goodDef),
  terseReturn: lineTokens(terseDef),
  terseSaved: lineTokens(goodDef) - lineTokens(terseDef),
  terseTurns: runTerse.totals.turns,
  terseTotal: runTerse.totals.input,
  terseExtra: runTerse.totals.input - run.totals.input,
  badMessage: formatErrors(badErrors),
  choiceInputs: choices.map((item) => item.input),
  choiceErrors: choices.map((item) => item.error?.status ?? null),
};
const N = numbers;

// ---------- 图元 ----------

const toolGrid = (lift: number | null = null, extra?: { name: string; desc: number; schema: number; line: number }): GridPrim => {
  const rows = defs.map((def, i) => ({ name: def.name, desc: perDesc[i], schema: perSchema[i], line: perTool[i] }));
  if (extra) rows.push(extra);
  return {
    kind: 'grid',
    id: 'ts',
    w: 56,
    rows: rows.map((row) => row.name),
    cols: ['描述', 'schema', '整行'],
    cells: rows.map((row, r): DsCell[] => [
      { v: String(row.desc), tone: PART_TONE.setup, lift: r === lift || undefined },
      { v: String(row.schema), tone: PART_TONE.setup, lift: r === lift || undefined },
      { v: String(row.line), tone: 'head', lift: r === lift || undefined },
    ]),
  };
};

/** 第一轮输入的构成：工具系统提示、工具定义、system、用户的话、模板。 */
const promptRow = (lift: number[] = []): RowPrim => ({
  kind: 'row',
  id: 'pr',
  w: 52,
  cells: [
    { v: String(N.toolSystem), sub: '工具系统提示', tone: PART_TONE.setup, key: 'ts' },
    { v: String(N.toolDefs), sub: 'tools', tone: PART_TONE.setup, key: 'td' },
    { v: String(N.system), sub: 'system', tone: PART_TONE.setup, key: 'sy' },
    { v: String(N.user), sub: '用户', tone: PART_TONE.user, key: 'us' },
    { v: String(N.template), sub: '模板', tone: PART_TONE.overhead, key: 'tp' },
  ].map((cell, i) => ({ ...cell, lift: lift.includes(i) || undefined })),
});

/** 每轮的输入，和其中工具（定义 + 工具系统提示）占的部分。 */
const roundsGrid = (k: number, total = false): GridPrim => {
  const turns = run.turns.slice(0, k);
  const rows = turns.map((turn): [number, number] => [turn.message.usage.input_tokens, turn.breakdown.tools + turn.toolSystem]);
  const labels = turns.map((turn) => `第 ${turn.index} 轮`);
  if (total) {
    rows.push([sum(rows.map((row) => row[0])), sum(rows.map((row) => row[1]))]);
    labels.push('合计');
  }
  return {
    kind: 'grid',
    id: 'rd',
    w: 58,
    rows: labels,
    cols: ['输入', '工具'],
    cells: rows.map((row, r): DsCell[] => [
      { v: String(row[0]), tone: r === turns.length ? 'head' : 'blue' },
      { v: String(row[1]), tone: r === turns.length ? 'head' : PART_TONE.setup },
    ]),
  };
};

/** 好描述、坏描述、多一个工具：三次运行的账。 */
const compareGrid = (rows: Array<'good' | 'terse' | 'four'>): GridPrim => {
  const data = {
    good: { label: '好描述', defs: N.goodReturn, turns: run.totals.turns, total: run.totals.input },
    terse: { label: '坏描述', defs: N.terseReturn, turns: runTerse.totals.turns, total: runTerse.totals.input },
    four: { label: '+ 退款工具', defs: N.refundTokens, turns: runFour.totals.turns, total: runFour.totals.input },
  };
  return {
    kind: 'grid',
    id: 'rd',
    w: 58,
    rows: rows.map((key) => data[key].label),
    cols: ['定义', '轮数', '累计'],
    cells: rows.map((key): DsCell[] => [
      { v: String(data[key].defs), tone: PART_TONE.setup },
      { v: String(data[key].turns), tone: key === 'terse' ? 'amber' : 'blue' },
      { v: String(data[key].total), tone: key === 'good' ? 'green' : 'amber' },
    ]),
  };
};

const choiceGrid = (k: number): GridPrim => ({
  kind: 'grid',
  id: 'tc',
  w: 58,
  rows: choices.slice(0, k).map((item) => item.label),
  cols: ['状态', '输入'],
  cells: choices.slice(0, k).map((item): DsCell[] => [
    { v: item.error ? String(item.error.status) : '200', tone: item.error ? 'amber' : 'green' },
    { v: item.input === null ? '—' : String(item.input), tone: item.input === null ? 'dim' : 'blue' },
  ]),
});

// ---------- 字节层 ----------

const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };

function requestWire(turn: AgentTurn, notes: Record<string, string> = {}) {
  return wire(`第 ${turn.index} 轮请求`, 'mem', 'format',
    httpHead('请求头', turn.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
    jsonBody('请求体', encodeJson(turn.request), {
      expand: turn.request.tools!.map((_, i) => `tools[${i}]`),
      notes: {
        tools: `${N.toolCount} 个工具的定义，${num(N.toolsBytes)} 字节。每一轮都原样带上：API 是无状态的，模型不记得上一轮见过哪些工具。`,
        ...Object.fromEntries(turn.request.tools!.map((def, i) => [`tools[${i}]`, `${def.name}：展开后一行 ${perTool[i]} 个 token（本站分词器）。`])),
        ...notes,
      },
    }));
}

function responseWire(turn: AgentTurn) {
  return wire(`第 ${turn.index} 轮响应`, 'mem', 'format',
    httpHead('响应头', turn.http.response, { example: ['request-id', 'date'] }),
    jsonBody('响应体', encodeJson(turn.message), {
      expand: ['usage.input_tokens'],
      example: ['id', 'content', 'usage', 'usage.input_tokens', 'usage.output_tokens'],
      notes: { 'usage.input_tokens': `本站分词器数出的 ${num(turn.breakdown.total)}，加上工具系统提示 ${N.toolSystem}，其中工具定义 ${N.toolDefs}（示例）。` },
    }));
}

const roundTrip = (turn: AgentTurn, after: Partial<Record<'usage' | 'prompt', ReturnType<typeof roundsGrid>[] | RowPrim[]>>): LessonEvent[] => [
  pk('agent', 'llm', 'violet', `第 ${turn.index} 轮请求`, [`tools ×${N.toolCount}`, `${turn.request.messages.length} 条消息`], [turn.before.input, 'HTTP', `第 ${turn.index} 轮：${N.toolCount} 个工具的定义又带了一遍`, turn.http.request.bytes.length], requestWire(turn)),
  pk('llm', 'agent', 'green', `输入 ${num(turn.message.usage.input_tokens)}`, [`其中工具 ${num(perRoundTools)}`, `stop_reason ${turn.message.stop_reason}`], [turn.after.input, 'INFER', `输入 ${num(turn.message.usage.input_tokens)}，其中工具定义 ${num(N.toolDefs)} + 工具系统提示 ${N.toolSystem}`, turn.http.response.bytes.length], responseWire(turn), { ds: after as never }),
];

/** 模型读到的工具定义：toolsText 的每一行，值是这一行的 token 数（本站的写法，internal）。 */
const toolsTextWire = () => {
  const textValue = toolsText(defs);
  const lines = textValue.split('\n');
  const notes: Record<number, string> = { 0: '标题行（本站写法）。', 1: '借自 Qwen2.5 模板的 <tools> 标签。' };
  defs.forEach((def, i) => (notes[i + 2] = `${def.name}：${perTool[i]} 个 token，其中描述 ${perDesc[i]}、input_schema ${perSchema[i]}。`));
  notes[lines.length - 1] = '收尾标签。';
  return wire('展开后的工具定义（本站写法）', 'mem', 'internal', utf8Lines('tools', textValue, { notes, summary: `按本站的 ChatML 模板展开：整段 ${N.toolDefs} 个 token` }));
};

const callWire = (c: ToolCall, label: string, noteText: string) =>
  wire(label, 'mem', 'format', jsonBody('tool_use 块', encodeJson(c.use), { example: ['id', 'input'], notes: { input: noteText } }));

// ---------- 课程 ----------

const quote = (value: string): string => `「${value.replace(/[。！？]$/, '')}」`;
const terseThought = b4.message.content[0].type === 'text' ? b4.message.content[0].text : '';

export const tooldefs: Lesson = {
  id: 'tooldefs',
  name: 'TOOL DEFS',
  title: '工具定义如何进入提示',
  group: 'loop',
  layer: [4, 5],
  layerNote: '这课在「工具」和「循环」两档：工具定义是一次调用的说明书，而循环让这份说明书每一轮都要重发、重付一次。',
  tokensNote: `前三步是和 react 课同一次运行（4 轮累计 ${num(N.totalInput)}）；第四步接着记坏描述那次运行（${N.terseTurns} 轮，累计 ${num(N.terseTotal)}）；最后一步的请求被拒或只做计算，不再增加。`,
  nodes: ['tools', 'agent', 'llm', 'toolset', 'prompt', 'usage', 'request'],
  place: { tools: [110, 170], agent: [520, 300], llm: [900, 110], toolset: [110, 560], prompt: [910, 390], usage: [600, 680], request: [1090, 730] },
  labels: {
    tools: ['工具执行端', '定义和实现在这里'],
    agent: ['Agent 运行时', '组装请求'],
    llm: ['模型', MODEL],
    toolset: ['工具定义', '每个工具的 token'],
    prompt: ['第一轮输入', '各部分的 token'],
    usage: ['账', '每轮输入里工具占多少'],
    request: ['tool_choice', '四种取值'],
  },
  labelAt: { toolset: [0, 130], prompt: [0, 90], usage: [0, 150], request: [0, 110] },
  radius: { toolset: 80, prompt: 80, usage: 80, request: 70 },
  initial: { toolset: [], prompt: [], usage: [], request: [] },
  start: ['tools', 'agent', 'llm'],
  legend: [['violet', '工具定义和 system'], ['blue', '用户的话、每轮输入'], ['amber', '出错的调用'], [null, '输入列：模型累计读入的 token']],
  overview: {
    full: '工具定义也是提示的一部分，每轮都要付',
    description: `模型「知道」有哪些工具，只是因为请求的 tools 数组把每个工具的名字、描述和参数的 JSON Schema 写了进去，展开后和 system、对话一样是 token。客服 Agent 的 ${N.toolCount} 个工具展开后 ${num(N.toolDefs)} 个 token，API 还会再加一段文档给的 ${N.toolSystem} 个 token 的工具系统提示；循环每一轮都重发，4 轮里光工具就占了累计输入的 ${N.toolsShare}。描述写得短能省 token，但模型更容易填错参数，多出来的一轮比省下的贵。`,
    facts: [
      ['工具', 'get_order、search_policy、create_return'],
      ['展开后', `${num(N.toolDefs)} token + 工具系统提示 ${N.toolSystem}`],
      ['每轮重发', `${N.turns} 轮共 ${num(N.toolsAllRounds)} token，占 ${N.toolsShare}`],
      ['tool_choice', 'auto、any、tool、none'],
    ],
  },
  steps: [
    {
      title: '一个工具定义：名字、描述、参数',
      desc: `${N.toolCount} 个工具，${num(N.toolsBytes)} 字节的 JSON`,
      detail: `每个工具定义有三部分：name（要匹配 ^[a-zA-Z0-9_-]{1,128}$）、description（写给模型看的说明）、input_schema（参数的 JSON Schema，就是描述 JSON 长什么样的 JSON）。本站把每个工具展开成提示里的一行 JSON 再数 token：get_order ${perTool[0]}、search_policy ${perTool[1]}、create_return ${perTool[2]}，加上 <tools> 外壳 ${N.wrapper} 个，一共 ${num(N.toolDefs)}。描述和 schema 占了大头，create_return 的描述写清了期限和运费，所以最长。`,
      facts: [['get_order', `${perTool[0]} token`], ['search_policy', `${perTool[1]} token`], ['create_return', `${perTool[2]} token`], ['合计', `${num(N.toolDefs)}（含外壳 ${N.wrapper}）`]],
      events: [
        pk('tools', 'agent', 'violet', 'tools 定义', defs.map((def) => def.name), [0, 'JSON', `ToolBox.definitions()：${N.toolCount} 个工具的 name、description、input_schema`, N.toolsBytes], wire('tools 数组', 'mem', 'format', jsonBody('tools', encodeJson(defs), { expand: defs.map((_, i) => `[${i}].description`), notes: Object.fromEntries(defs.map((def, i) => [`[${i}]`, `${def.name}：${N.perToolBytes[i]} 字节。`])) }))),
        show('toolset'),
        pk('agent', 'toolset', 'violet', '数 token', [`${N.toolCount} 行`, `${num(N.toolDefs)} token`], [0, 'TOKENS', `每个工具展开成一行 JSON：${perTool.join('、')} 个 token，外壳 ${N.wrapper}`, utf8Encode(toolsText(defs)).length], toolsTextWire(), { ds: { toolset: [toolGrid()] } }),
        note('toolset', `create_return 最长：${perTool[2]}`),
      ],
    },
    {
      title: '展开进提示：比 system 还长',
      desc: `第一轮输入 ${num(N.input1)}，工具占 ${N.share1}`,
      detail: `运行时把 tools 和 system、用户的话一起发出去，本站的模板把工具定义放在 system 这一轮的最前面，和文档里缓存的渲染顺序（tools → system → messages）一致。展开后工具定义 ${num(N.toolDefs)} 个 token，是 system（${N.system}）的 ${(N.toolDefs / N.system).toFixed(1)} 倍；API 另外加的工具系统提示原文不公开，用文档给的 ${N.toolSystem}，和本站的迷你分词器不是同一把尺子。第一轮输入 ${num(N.input1)}，工具相关的 ${num(perRoundTools)} 个占 ${N.share1}，用户真正的问题只有 ${N.user} 个。`,
      facts: [['工具定义', `${num(N.toolDefs)} token`], ['工具系统提示', `${N.toolSystem}（文档的数）`], ['system', `${N.system} token`], ['用户的话', `${N.user} token`]],
      events: [
        show('prompt'),
        ...roundTrip(t1, { prompt: [promptRow([0, 1])] }),
        state('agent', { 轮次: `1 / ${N.turns}`, 工具: `${num(perRoundTools)} token` }),
        note('prompt', `工具占 ${N.share1}`),
      ],
    },
    {
      title: '每一轮都重发一次',
      desc: `${N.turns} 轮里工具共 ${num(N.toolsAllRounds)} token`,
      detail: `API 是无状态的，第二、三、四轮的请求照样把 ${N.toolCount} 个工具的定义原样带上，每轮 ${num(perRoundTools)} 个 token，${N.turns} 轮一共 ${num(N.toolsAllRounds)}，占累计输入 ${num(N.totalInput)} 的 ${N.toolsShare}。再多挂一个这次用不上的 issue_refund（${N.refundTokens} 个 token），同一个脚本重跑一遍，每轮的工具定义从 ${num(N.toolDefs)} 涨到 ${num(N.fourDefs)}，累计输入涨到 ${num(N.fourTotal)}，多出的 ${num(N.fourExtra)} 正好是 ${N.refundRound} × ${N.turns} 轮。工具挂得越多，每一轮都越贵，哪怕模型一次都不调用它。`,
      facts: [['每轮工具', `${num(perRoundTools)} token`], ['4 轮合计', `${num(N.toolsAllRounds)}（${N.toolsShare}）`], ['issue_refund', `${N.refundTokens} token`], ['多挂一个', `+${num(N.fourExtra)}`]],
      events: [
        show('usage'),
        ...roundTrip(t2, { usage: [roundsGrid(2)] }),
        ...roundTrip(t3, { usage: [roundsGrid(3)] }),
        ...roundTrip(t4, { usage: [roundsGrid(4, true)] }),
        state('agent', { 轮次: `${N.turns} / ${N.turns}`, 工具: `${num(N.toolsAllRounds)} token` }),
        pk('tools', 'toolset', 'violet', '+ issue_refund', [`${N.refundTokens} token`, `×${N.turns} 轮`], [run.totals.input, 'TOKENS', `多挂 issue_refund 重跑：累计 ${num(N.fourTotal)}，多 ${num(N.fourExtra)} = ${N.refundRound} × ${N.turns}`, encodeJson(ISSUE_REFUND.input_schema).bytes.length], wire('多挂一个工具', 'mem', 'internal', jsonBody('issue_refund 的定义', encodeJson({ name: ISSUE_REFUND.name, description: ISSUE_REFUND.description, input_schema: ISSUE_REFUND.input_schema }), { notes: { description: '会真的打款的工具。这一次的对话用不上它，但定义每一轮都在。' } }), concept('同一个脚本的两次运行', [['3 个工具', num(run.totals.input), '累计输入。'], ['4 个工具', num(N.fourTotal), `每轮工具定义 ${num(N.fourDefs)}。`], ['差', num(N.fourExtra), `每轮多 ${N.refundRound}（这一行 ${N.refundTokens}，加上和上一行之间的换行）× ${N.turns} 轮。`]])), { ds: { toolset: [toolGrid(3, { name: 'issue_refund', desc: countTokens(ISSUE_REFUND.description), schema: countTokens(encodeJson(ISSUE_REFUND.input_schema).text), line: N.refundTokens })] } }),
        note('usage', `工具占 ${N.toolsShare}`),
      ],
    },
    {
      title: '描述写短了：省的不如赔的多',
      desc: `坏描述 ${N.terseTurns} 轮，多读 ${num(N.terseExtra)}`,
      detail: `文档说描述是工具表现最重要的因素，建议每个工具至少写 3–4 句：做什么、什么时候用、每个参数什么意思、有什么限制。把 create_return 的描述砍成一句、参数说明全删掉，定义从 ${N.goodReturn} 降到 ${N.terseReturn} 个 token；示例里模型把「质量问题」写进了 note、漏了必填的 reason，工具端按 input_schema 校验，回了 is_error：「${N.badMessage}」。模型看到后补上 reason 再调一次，多出一轮，累计输入 ${num(N.terseTotal)}，比好描述多 ${num(N.terseExtra)}。`,
      facts: [['好描述', `${N.goodReturn} token`], ['坏描述', `${N.terseReturn} token`], ['校验', N.badMessage], ['累计', `${num(N.totalInput)} → ${num(N.terseTotal)}`]],
      events: [
        pk('tools', 'agent', 'violet', '坏描述', [terseDef.description!, '参数没有说明'], [run.totals.input, 'JSON', `create_return 的定义只剩一句：${N.goodReturn} → ${N.terseReturn} token`, encodeJson(terseDef).bytes.length], wire('坏描述的 create_return', 'mem', 'format', jsonBody('工具定义', encodeJson(terseDef), { expand: ['input_schema.properties'], notes: { description: `原来是：${goodDef.description}`, 'input_schema.properties': '约束（pattern、enum、required）都还在，只是没有一个字说明它们是什么。' } })), { ds: { toolset: [toolGrid(2)] } }),
        pk('llm', 'agent', 'amber', 'tool_use: create_return', ['note: 杯盖漏水，质量问题', '没有 reason'], [run.totals.input + b3.after.input, 'INFER', `坏描述那次运行的第 3 轮：输入 ${num(b3.message.usage.input_tokens)}，参数漏了 reason`, encodeJson(badCall.use).bytes.length], callWire(badCall, '坏描述下的 tool_use（示例）', '模型把原因写进了 note，漏了 reason（示例）。')),
        pk('agent', 'tools', 'amber', '校验参数', ['required: reason'], [run.totals.input + b3.after.input, 'TOOL', `schema.ts 校验：${N.badMessage}`, encodeJson(badCall.use.input).bytes.length], wire('参数校验', 'mem', 'internal', jsonBody('input', encodeJson(badCall.use.input)), concept('validate 的结果', badErrors.map((error): [string, string] => [error.path, error.message])))),
        pk('tools', 'agent', 'amber', 'is_error', [N.badMessage], [run.totals.input + b3.after.input, 'RESULT', `tool_result is_error：${badCall.outcome.content}`, encodeJson(badCall.result).bytes.length], wire('tool_result（出错）', 'mem', 'format', jsonBody('tool_result 块', encodeJson(badCall.result), { notes: { is_error: '工具没有执行，错误交回模型，让它改了再调。' } })), { lost: true }),
        pk('llm', 'agent', 'green', '补上 reason', [`reason: ${String(fixCall.use.input.reason)}`], [run.totals.input + b4.after.input, 'INFER', `第 4 轮：${quote(terseThought)}，重新调用`, encodeJson(fixCall.use).bytes.length], callWire(fixCall, '改正后的 tool_use（示例）', '这次带上了 reason，校验通过，建了退货单。')),
        pk('agent', 'usage', 'amber', '两种描述的账', [`${run.totals.turns} 轮 vs ${N.terseTurns} 轮`, `+${num(N.terseExtra)}`], [run.totals.input + b5.after.input, 'TOKENS', `好描述 ${run.totals.turns} 轮 ${num(run.totals.input)}，坏描述 ${N.terseTurns} 轮 ${num(N.terseTotal)}`, null], wire('两次运行的账', 'mem', '示意', concept('累计输入', [['好描述', num(run.totals.input), `${run.totals.turns} 轮，每轮 create_return ${N.goodReturn} token。`], ['坏描述', num(N.terseTotal), `${N.terseTurns} 轮，每轮省 ${N.terseSaved} token，但多了一轮。`], ['差', `+${num(N.terseExtra)}`]])), { ds: { usage: [compareGrid(['good', 'terse', 'four'])] } }),
        note('usage', `坏描述多 ${num(N.terseExtra)}`, 'amber'),
      ],
    },
    {
      title: 'tool_choice：让不让、逼不逼模型调用',
      desc: `any 和 tool 在 ${MODEL} 上是 ${N.choiceErrors[1]}`,
      detail: `tool_choice 有四种：auto（带工具时的默认）让模型自己决定，any 要求必须调用某个工具，tool 指定调用哪一个，none 不许调用（没带工具时的默认）。Claude Opus 5.5 不支持 any 和 tool，请求直接回 ${N.choiceErrors[1]}，文档建议改用 auto、在提示里点名要用的工具，参数格式交给工具定义上的 strict: true 保证。none 也不省钱：定义照样发、照样计费，第一轮输入和 auto 一样是 ${num(N.choiceInputs[3]!)}。`,
      facts: [['auto', `${num(N.choiceInputs[0]!)} token`], ['any', `${N.choiceErrors[1]}`], ['tool', `${N.choiceErrors[2]}`], ['none', `${num(N.choiceInputs[3]!)} token`]],
      events: [
        show('request'),
        pk('agent', 'llm', 'violet', 'tool_choice: any', ['必须调用工具'], [run.totals.input + runTerse.totals.input, 'HTTP', `同一个第一轮请求，tool_choice 改成 any`, anyJson.bytes.length], wire('请求体（tool_choice: any）', 'mem', 'format', jsonBody('请求体', anyJson, { expand: ['tool_choice'], notes: { tool_choice: '要求模型必须调用一个工具（不指定哪个）。' } })), { ds: { request: [choiceGrid(1)] } }),
        pk('llm', 'agent', 'amber', `${anyChoice.error!.status} ${anyChoice.error!.type}`, [preview(anyChoice.error!.message)], [run.totals.input + runTerse.totals.input, 'ERROR', `validateRequest：${anyChoice.error!.message}`, anyHttp.bytes.length], wire('400 响应', 'mem', 'format', httpHead('响应头', anyHttp, { example: ['request-id'] }), jsonBody('响应体', encodeJson(JSON.parse(utf8Decode(anyHttp.bytes.slice(anyHttp.body[0])))), { root: 'error', notes: { message: '文档给出的原文。请求没有被模型读到，不计输入 token。' } })), { ds: { request: [choiceGrid(3)] } }),
        pk('agent', 'request', 'violet', 'tool_choice: none', ['不许调用', `输入 ${num(N.choiceInputs[3]!)}`], [run.totals.input + runTerse.totals.input, 'TOKENS', `none：定义照样带上，输入 ${num(N.choiceInputs[3]!)}，和 auto 相同`, null], wire('四种 tool_choice', 'mem', '示意', concept('同一个第一轮请求', choices.map((item): [string, string, string] => [item.label, item.error ? `${item.error.status}` : `${num(item.input!)} token`, item.error ? item.error.message : `${num(inputBreakdown(item.request).total)} + 工具系统提示 ${toolSystemTokens(item.request)}。`]))), { ds: { request: [choiceGrid(4)] } }),
        state('agent', { 轮次: null, 工具: null, tool_choice: 'auto', any: `${N.choiceErrors[1]}`, tool: `${N.choiceErrors[2]}` }),
        note('request', 'auto 之外只剩 none'),
      ],
    },
  ],
  outro: {
    title: '工具定义是每轮都付的固定成本',
    desc: `${num(perRoundTools)} token × ${N.turns} 轮 = ${N.toolsShare}`,
    text: `模型看到的工具就是 tools 里那几段 JSON：名字、描述和参数的 schema 展开成 token，排在 system 前面，再加上 API 自带的工具系统提示（文档给的 ${N.toolSystem}）。循环每一轮都重发，所以这是一笔每轮都付的固定成本：这次 ${N.turns} 轮里占了 ${N.toolsShare}，多挂一个用不上的工具就多付 ${num(N.fourExtra)}。但别为省 token 把描述写短，参数填错多一轮比省下的贵得多。本站的 token 数是迷你分词器的计数，只代表量级关系。下一课看模型一轮里同时调用两个工具时，结果怎样回填。`,
    facts: [['工具定义', `${num(N.toolDefs)} token / 轮`], ['工具系统提示', `${N.toolSystem} / 轮`], ['坏描述', `+${num(N.terseExtra)}`], ['下一课', '并行工具调用与结果回填']],
  },
};

