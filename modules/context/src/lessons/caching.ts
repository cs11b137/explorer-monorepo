/**
 * 提示组第五课：Prompt Caching 在 API 层。cache_control 断点、第一次写入、第二次命中、改一个字就失效、最小可缓存长度、有效期，
 * 以及按示例单价算出的成本对比。缓存的命中、写入、过期由 core/cache.ts 的 PromptCache 真实模拟（按文档描述的规则），
 * usage 的四个字段和费用由 createMessage、costOf 真实计算；缓存键用 FNV-1a 模拟（internal）。
 * 模型的回复是示例（E.G.），tests/narrative.prompt.test.ts 核对文案。和 LLM EXPLORER 的 prefix 课呼应：那里讲引擎里的块哈希。
 */
import {
  breakpointsOf,
  cacheBlocks,
  CACHE_READ,
  CACHE_WRITE_1H,
  CACHE_WRITE_5M,
  costOf,
  createMessage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  EXAMPLE_EPOCH,
  exampleId,
  formatPrice,
  formatUsd,
  httpDate,
  inputBreakdown,
  messagesHttpRequest,
  messagesHttpResponse,
  MODELS,
  PRICE_DATE,
  priceOf,
  PromptCache,
  renderRequest,
  runCache,
  shortHash,
  spanOf,
  TTL_SECONDS,
  type ContentBlock,
  type Message,
  type MessagesRequest,
} from '../core';
import { concept, httpHead, jsonBody, promptPieces, wire } from '../decode/structures';
import { note, pk, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

export const MODEL = 'claude-opus-5-5';

/** 一段很长、每次都一样的系统提示：客服规则。要超过最小可缓存长度（512 token）才会真的被缓存。 */
export const POLICY = [
  '你是某电商平台的客服助手，只依据下面的规则回答。',
  '一、退货：签收后 7 天内可以无理由退货，商品需保持完好，退货运费由买家承担，质量问题的运费由商家承担。',
  '二、发货：下单后 48 小时内发货，节假日顺延，发货后可以在订单页查看物流。',
  '三、改地址：未发货前可以修改收货地址，已发货则需要联系快递拦截，不保证成功。',
  '四、发票：订单完成后 30 天内可以在订单页申请电子发票，抬头和税号填错需要重新开具。',
  '五、会员：积分在每月 1 号清零前 30 天提醒，可以抵扣现金，不能兑换成现金。',
  '回答要简短，先给结论，再给一句依据。',
].join('\n');
/** 改了前缀里的一个字符：7 天改成 8 天。 */
export const POLICY_EDITED = POLICY.replace('签收后 7 天', '签收后 8 天');

const system = (text: string, ttl?: '5m' | '1h') => [{ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const, ...(ttl ? { ttl } : {}) } }];
const ask = (system_: MessagesRequest['system'], question: string): MessagesRequest => ({ model: MODEL, max_tokens: 1024, system: system_, messages: [{ role: 'user', content: question }] });

export const Q1 = '签收后多久可以退货？';
export const Q2 = '发货后还能改地址吗？';
export const REQUESTS = {
  r1: ask(system(POLICY), Q1),
  r2: ask(system(POLICY), Q2),
  r3: ask(system(POLICY_EDITED), Q1),
  /** 第一次请求的原样重发，但隔了 5 分钟以上。 */
  r4: ask(system(POLICY_EDITED), Q1),
  /** 前缀只有一句话：低于最小可缓存长度，断点被静默忽略。 */
  short: ask(system('你是客服助手。'), Q1),
};
export type Key = keyof typeof REQUESTS;
/** 每次请求的时刻（秒）。r2 在 r1 之后一分钟，r4 在 r3 之后超过 5 分钟。 */
export const TIMES: Record<Key, number> = { r1: 0, r2: 60, r3: 120, r4: 120 + TTL_SECONDS['5m'] + 1, short: 130 };

/** 模型的回复：示例。 */
const REPLIES: Record<Key, ContentBlock[]> = {
  r1: [{ type: 'text', text: '签收后 7 天内可以无理由退货，商品需保持完好。' }],
  r2: [{ type: 'text', text: '未发货可以改；已发货要联系快递拦截，不保证成功。' }],
  r3: [{ type: 'text', text: '签收后 8 天内可以无理由退货，商品需保持完好。' }],
  r4: [{ type: 'text', text: '签收后 8 天内可以无理由退货，商品需保持完好。' }],
  short: [{ type: 'text', text: '请联系在线客服。' }],
};

const KEYS: Key[] = ['r1', 'r2', 'r3', 'short', 'r4'];
const cache = new PromptCache(MODELS[MODEL].cacheMin);
const date = httpDate(EXAMPLE_EPOCH);
const price = priceOf(MODEL);

export interface Run {
  request: MessagesRequest;
  body: ReturnType<typeof encodeJson>;
  http: ReturnType<typeof encodeRequest>;
  prompt: ReturnType<typeof renderRequest>;
  blocks: ReturnType<typeof cacheBlocks>;
  outcome: ReturnType<typeof runCache>;
  message: Message;
  json: ReturnType<typeof encodeJson>;
  response: ReturnType<typeof encodeResponse>;
  cost: ReturnType<typeof costOf>;
  /** 同一个请求不用缓存时的 usage 和费用。 */
  plain: Message;
  plainCost: ReturnType<typeof costOf>;
  input: number;
  output: number;
}

/** 按时间顺序依次跑，缓存状态在请求之间保留。 */
export const runs = Object.fromEntries(
  KEYS.map((key, index) => {
    const request = REQUESTS[key];
    const prompt = renderRequest(request);
    const blocks = cacheBlocks(prompt, breakpointsOf(request, prompt));
    const outcome = runCache(cache, request, TIMES[key]);
    const id = exampleId('msg', 40 + index);
    const message = createMessage(request, REPLIES[key], { id, cache: outcome });
    const plain = createMessage(request, REPLIES[key], { id });
    const json = encodeJson(message);
    const body = encodeJson(request);
    return [key, {
      request, body, http: encodeRequest(messagesHttpRequest(request)), prompt, blocks, outcome, message, json,
      response: encodeResponse(messagesHttpResponse(message, { requestId: exampleId('req', 40 + index), date })),
      cost: costOf(message.usage, MODEL), plain, plainCost: costOf(plain.usage, MODEL),
      input: prompt.tokens, output: message.usage.output_tokens,
    } satisfies Run];
  }),
) as Record<Key, Run>;

export const breakdown = inputBreakdown(REQUESTS.r1);
const R = runs;
const prefix = R.r1.blocks[0].tokens;
const usageOf = (key: Key) => R[key].message.usage;

/** 累计 token：每次请求的全部输入（读 + 写 + 未缓存）加输出，按顺序累加。 */
const upto = (last: Key) => KEYS.slice(0, KEYS.indexOf(last) + 1).reduce((sum, key) => sum + R[key].input + R[key].output, 0);
const before = (key: Key) => upto(key) - R[key].input - R[key].output;

/** 1 小时缓存的写入费用：把 r1 的写入改按 1 小时计价。 */
const write1h = costOf({ ...usageOf('r1'), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: prefix } }, MODEL);

const three: Key[] = ['r1', 'r2', 'r3'];

/** 对照：如果请求 3 没有改字（还是请求 1 的原样），它会命中缓存。 */
const alt = new PromptCache(MODELS[MODEL].cacheMin);
runCache(alt, REQUESTS.r1, TIMES.r1);
runCache(alt, REQUESTS.r2, TIMES.r2);
const altMessage = createMessage(REQUESTS.r1, REPLIES.r1, { id: exampleId('msg', 49), cache: runCache(alt, REQUESTS.r1, TIMES.r3) });
const altCost = costOf(altMessage.usage, MODEL);
const sum = (pick: (run: Run) => number) => three.reduce((total, key) => total + pick(R[key]), 0);
const fmt = formatUsd;
const readRatio = CACHE_READ[MODEL];

export const numbers = {
  prefix,
  min: MODELS[MODEL].cacheMin,
  policyChars: [...POLICY].length,
  r1: { total: R.r1.input, write: usageOf('r1').cache_creation_input_tokens, read: usageOf('r1').cache_read_input_tokens, input: usageOf('r1').input_tokens, output: R.r1.output, cost: R.r1.cost.total, plain: R.r1.plainCost.total },
  r2: { total: R.r2.input, write: usageOf('r2').cache_creation_input_tokens, read: usageOf('r2').cache_read_input_tokens, input: usageOf('r2').input_tokens, output: R.r2.output, cost: R.r2.cost.total, plain: R.r2.plainCost.total },
  r3: { total: R.r3.input, write: usageOf('r3').cache_creation_input_tokens, read: usageOf('r3').cache_read_input_tokens, input: usageOf('r3').input_tokens, output: R.r3.output, cost: R.r3.cost.total, plain: R.r3.plainCost.total },
  r4: { total: R.r4.input, write: usageOf('r4').cache_creation_input_tokens, read: usageOf('r4').cache_read_input_tokens, input: usageOf('r4').input_tokens, expired: R.r4.outcome.expired.length, cost: R.r4.cost.total },
  short: { total: R.short.input, write: usageOf('short').cache_creation_input_tokens, read: usageOf('short').cache_read_input_tokens, tooShort: R.short.outcome.tooShort.length, prefix: R.short.blocks[0].tokens },
  costCached: sum((run) => run.cost.total),
  unchanged3: { read: altMessage.usage.cache_read_input_tokens, cost: altCost.total },
  costUnchanged: R.r1.cost.total + R.r2.cost.total + altCost.total,
  savedUnchangedPct: 0,
  costPlain: sum((run) => run.plainCost.total),
  saved: 0,
  savedPct: 0,
  write1h: write1h.write1h,
  write5m: R.r1.cost.write5m,
  read: R.r2.cost.read,
  readRatio,
  entries: cache.entries.size,
  hashChanged: R.r1.blocks[0].hash !== R.r3.blocks[0].hash,
  hashSame: R.r1.blocks[0].hash === R.r2.blocks[0].hash,
  bytes: { r1: R.r1.http.bytes.length, r2: R.r2.http.bytes.length, r3: R.r3.http.bytes.length },
  total: upto('r3'),
  totalAll: upto('r4'),
};
numbers.saved = numbers.costPlain - numbers.costCached;
numbers.savedPct = Math.round((numbers.saved / numbers.costPlain) * 100);
numbers.savedUnchangedPct = Math.round(((numbers.costPlain - numbers.costUnchanged) / numbers.costPlain) * 100);
const N = numbers;
const model = MODELS[MODEL];
const PUB = 'sk-ant-api03-'.length;
const NAME: Record<Key, string> = { r1: '请求 1', r2: '请求 2', r3: '请求 3', r4: '请求 4', short: '短前缀' };

// ---------- 图元 ----------

const requestRow = (key: Key): RowPrim => {
  const json = R[key].body;
  const span = (path: string) => spanOf(json, path).to - spanOf(json, path).from;
  return {
    kind: 'row',
    id: 'q',
    w: 66,
    cells: [
      { v: 'system', tone: 'violet', sub: `${span('system')} B`, key: 'system' },
      { v: 'messages', tone: 'blue', sub: `${span('messages')} B`, key: 'messages' },
    ],
    marks: [{ at: 0, text: 'cache_control', color: 'teal', dx: 20 }],
  };
};

/** 每个可缓存块一格：写缓存键（链式哈希）的前 4 位十六进制，下面写来源和累计 token。 */
const blockRow = (key: Key): RowPrim => {
  const run = R[key];
  const outcome = run.outcome;
  return {
    kind: 'row',
    id: 'p',
    w: 78,
    cells: run.blocks.map((block): DsCell => {
      const hit = block.index === outcome.hitAt;
      const wrote = outcome.writes.includes(block.index);
      return { v: shortHash(block.hash), tone: hit ? 'teal' : wrote ? 'amber' : 'blue', sub: `${block.source === 'system[0]' ? 'system' : '问题'} ${block.tokens}`, key: `${key}:${block.index}`, lift: hit || wrote || undefined };
    }),
    marks: [{ at: 0, text: outcome.hitAt >= 0 ? '命中' : outcome.writes.length ? '写入' : outcome.tooShort.length ? '太短，不缓存' : '未命中', color: outcome.hitAt >= 0 ? 'teal' : 'amber', dx: 24 }],
  };
};

const usageRow = (keys: Key[]): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 66,
  rows: keys.map((key) => NAME[key]),
  cols: ['写入', '读取', '未缓存', '费用'],
  cells: keys.map((key): DsCell[] => {
    const usage = usageOf(key);
    return [
      { v: String(usage.cache_creation_input_tokens), tone: usage.cache_creation_input_tokens ? 'amber' : 'dim' },
      { v: String(usage.cache_read_input_tokens), tone: usage.cache_read_input_tokens ? 'teal' : 'dim' },
      { v: String(usage.input_tokens), tone: 'blue' },
      { v: fmt(R[key].cost.total), tone: 'amber' },
    ];
  }),
});

const compareGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 78,
  rows: [...three.map((key) => NAME[key]), '合计'],
  cols: ['有缓存', '无缓存'],
  cells: [
    ...three.map((key): DsCell[] => [{ v: fmt(R[key].cost.total), tone: 'teal' }, { v: fmt(R[key].plainCost.total), tone: 'blue' }]),
    [{ v: fmt(N.costCached), tone: 'green' }, { v: fmt(N.costPlain), tone: 'amber' }],
  ],
});

/** 缓存查询的解码：每个块的来源、累计 token、哈希，和这次的结果。 */
const lookupLayer = (key: Key) => {
  const run = R[key];
  const outcome = run.outcome;
  return concept(`缓存查询（t = ${TIMES[key]} s）`, [
    ...run.blocks.map((block): [string, string, string?] => [`块 ${block.index}：${block.source}`, `${block.tokens} token · ${shortHash(block.hash)}`, block.breakpoint ? `这里有断点（${block.breakpoint}）：键 = 到这个块结尾的全部字节的哈希。` : '没有断点。']),
    ['结果', outcome.hitAt >= 0 ? `命中块 ${outcome.hitAt}，读 ${outcome.read}` : outcome.tooShort.length ? '前缀太短，不缓存' : outcome.expired.length ? `块 ${outcome.expired[0]} 的条目已过期，重新写入 ${outcome.write5m + outcome.write1h}` : `没有命中，写入 ${outcome.write5m + outcome.write1h}`, '哈希是本站模拟的（FNV-1a），真实服务的缓存键不公开。'],
  ], 'teal');
};

const usageLayers = (key: Key) => [
  jsonBody(`${NAME[key]} 的 usage`, R[key].json, {
    root: 'usage',
    expand: ['usage.cache_creation'],
    notes: {
      'usage.input_tokens': '最后一个缓存断点之后、没有参与缓存的 token。',
      'usage.cache_creation_input_tokens': '这次写入缓存的 token。',
      'usage.cache_read_input_tokens': '这次从缓存读出的 token。',
      'usage.cache_creation': '按有效期细分的写入：ephemeral_5m 和 ephemeral_1h，两项之和等于 cache_creation_input_tokens。',
    },
  }),
  concept(`费用（示例单价，${PRICE_DATE}）`, costLines(key)),
];

function costLines(key: Key): Array<[string, string, string?]> {
  const usage = usageOf(key);
  const cost = R[key].cost;
  const rows: Array<[string, string, string?]> = [];
  if (usage.input_tokens) rows.push(['未缓存输入', `${usage.input_tokens} × ${formatPrice(price.input)} = ${fmt(cost.input)}`]);
  if (usage.cache_creation_input_tokens) rows.push(['缓存写入（5 分钟）', `${usage.cache_creation_input_tokens} × ${formatPrice(price.write5m)} = ${fmt(cost.write5m)}`, `基础输入价的 ${CACHE_WRITE_5M} 倍。`]);
  if (usage.cache_read_input_tokens) rows.push(['缓存读取', `${usage.cache_read_input_tokens} × ${formatPrice(price.read)} = ${fmt(cost.read)}`, `基础输入价的 ${readRatio} 倍（Opus 5.5、Sonnet 5.5；其他模型是 0.1 倍）。`]);
  rows.push(['输出', `${usage.output_tokens} × ${formatPrice(price.output)} = ${fmt(cost.output)}`]);
  rows.push(['合计', fmt(cost.total), `不用缓存是 ${fmt(R[key].plainCost.total)}`]);
  return rows;
}

/** 一次请求在三个节点上的三个事件：请求到缓存、缓存到模型、模型到用量。 */
function round(key: Key, grid: Key[], labels: { lookup: string; read: string }, notes: Record<string, string> = {}) {
  const run = R[key];
  const usage = usageOf(key);
  const start = before(key);
  return [
    pk('request', 'cache', 'teal', '查缓存', [`t = ${TIMES[key]} s`, `${run.http.bytes.length} 字节`], [start, 'CACHE', labels.lookup, run.http.bytes.length],
      wire(`${NAME[key]}：请求和缓存查询`, 'mem', 'internal',
        httpHead('请求头', run.http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
        jsonBody('请求体', run.body, { expand: ['system[0].text', 'system[0].cache_control', 'messages[0].content'], notes: { 'system[0].cache_control': '缓存断点：缓存到这个块结尾为止的全部前缀。ephemeral 是目前唯一的类型，默认有效期 5 分钟，可选 ttl: "1h"。', ...notes } }),
        lookupLayer(key)),
      { ds: { request: [requestRow(key)], prompt: [blockRow(key)] } }),
    pk('cache', 'model', 'violet', `${run.input} 个输入 token`, [`读 ${usage.cache_read_input_tokens}`, `写 ${usage.cache_creation_input_tokens}`, `未缓存 ${usage.input_tokens}`], [start + run.input, 'INFER', labels.read, run.prompt.bytes.length],
      wire('模型读到的文本（ChatML 演示）', 'mem', 'internal', promptPieces('ChatML 文本', run.prompt, { notes: { 'system[0]': '这一段是缓存的前缀：每次请求都一样才能命中。' } }))),
    pk('model', 'usage', 'amber', 'usage', [`输入 ${run.input}`, `输出 ${run.output}`, fmt(run.cost.total)], [start + run.input + run.output, 'CALL', `usage：写 ${usage.cache_creation_input_tokens}、读 ${usage.cache_read_input_tokens}、未缓存 ${usage.input_tokens}，输出 ${run.output}，${fmt(run.cost.total)}`, spanOf(run.json, 'usage').to - spanOf(run.json, 'usage').valueFrom],
      wire(`${NAME[key]} 的 usage 和费用`, 'mem', 'format', ...usageLayers(key)),
      { ds: { usage: [usageRow(grid)] } }),
  ];
}

// ---------- 课程 ----------

export const caching: Lesson = {
  id: 'caching',
  name: 'CACHING',
  title: 'Prompt Caching 在 API 层（缓存断点、命中计费）',
  group: 'prompt',
  layer: [3, 5],
  layerNote: 'cache_control 是 JSON 里的字段，命中的是展开后的前缀，账单体现在 usage 的三个 token 字段里。',
  tokensNote: '每次请求的全部输入（缓存读、写和未缓存）加输出，依次累加。',
  nodes: ['app', 'request', 'cache', 'model', 'prompt', 'usage'],
  place: { app: [90, 270], request: [400, 80], cache: [520, 330], model: [880, 270], prompt: [830, 590], usage: [350, 600] },
  labels: {
    app: ['应用', '每次带同样的 system'],
    request: ['请求', 'system 末尾有 cache_control'],
    cache: ['提示缓存', '按前缀哈希存取'],
    model: ['模型', model.name],
    prompt: ['可缓存块', '哈希、来源、累计 token'],
    usage: ['用量和费用', `示例单价，${PRICE_DATE}`],
  },
  labelAt: { request: [-210, 20], prompt: [20, 100], usage: [-250, 140] },
  radius: { request: 60, prompt: 60, usage: 60 },
  initial: { request: [], prompt: [], usage: [] },
  start: ['app', 'request'],
  legend: [['violet', '被缓存的 system'], ['blue', '问题和未缓存的输入'], ['amber', '写入缓存'], ['teal', '命中缓存'], [null, 'token 列：每次请求的全部输入加输出，依次累加']],
  overview: {
    full: '同一段前缀，只算一次',
    description: `客服助手每次请求都带同一段 ${N.policyChars} 个字符的规则，展开后前缀有 ${prefix} 个 token。在 system 末尾加一个 cache_control 断点：第一次请求把前缀写入缓存，按基础输入价的 ${CACHE_WRITE_5M} 倍计费；5 分钟内的第二次请求命中，同样的 ${prefix} 个 token 只收 ${readRatio} 倍；前缀里改一个字符，哈希对不上，整段重新写入。三次请求按示例单价算下来，有缓存 ${fmt(N.costCached)}，没有缓存 ${fmt(N.costPlain)}。`,
    facts: [
      ['断点', 'cache_control: { type: "ephemeral" }'],
      ['前缀', `${prefix} token（最小可缓存 ${N.min}）`],
      ['倍率', `写 ${CACHE_WRITE_5M}（5 分钟）/ ${CACHE_WRITE_1H}（1 小时），读 ${readRatio}（Opus 5.5）`],
      ['三次请求', `有缓存 ${fmt(N.costCached)}，无缓存 ${fmt(N.costPlain)}`],
    ],
  },
  steps: [
    {
      title: '在 system 末尾放一个断点',
      desc: `前缀 ${prefix} token，断点在 system 的最后一块`,
      detail: `缓存是前缀匹配：键由断点之前全部字节决定，渲染顺序是 tools、system、messages，所以把断点放在稳定内容的末尾，变化的问题放在断点之后。system 要写成文本块数组，才能在块上加 cache_control；ephemeral 是目前唯一的类型，默认有效期 5 分钟，可以改成 ttl: "1h"。前缀至少要有 ${N.min} 个 token（Opus 5.5），短了不会报错，只是静默不缓存。`,
      facts: [['断点位置', 'system[0]'], ['前缀', `${prefix} token（≥ ${N.min}）`], ['有效期', '默认 5 分钟，可选 1 小时'], ['请求', `${N.bytes.r1} 字节`]],
      events: [
        pk('app', 'request', 'violet', '请求 1', ['system 带 cache_control', `${N.bytes.r1} 字节`], [0, 'HTTP', `请求 1：system 是文本块数组，末尾块带 cache_control，请求 ${N.bytes.r1} 字节`, N.bytes.r1],
          wire('请求 1：system 带断点', 'mem', 'format',
            httpHead('请求头', R.r1.http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
            jsonBody('请求体', R.r1.body, { expand: ['system[0].type', 'system[0].text', 'system[0].cache_control', 'messages[0].content'], notes: { system: 'system 写成文本块数组，才能给块加 cache_control。', 'system[0].cache_control': '缓存断点：缓存到这个块结尾为止的全部前缀（tools 在前，system 在后）。' } })),
          { ds: { request: [requestRow('r1')] } }),
        state('app', { 断点: 'system[0]', 前缀: `${prefix} token` }),
      ],
    },
    {
      title: '第一次：写入缓存',
      desc: `写入 ${N.r1.write}，按 ${CACHE_WRITE_5M} 倍计费`,
      detail: `缓存里什么都没有，前缀 ${N.r1.write} 个 token 没有命中，于是写入，usage 里记作 cache_creation_input_tokens；断点之后的问题 ${N.r1.input} 个是未缓存的 input_tokens，三项之和 ${N.r1.total} 就是全部输入。写入比普通输入贵：5 分钟的写入是基础价的 ${CACHE_WRITE_5M} 倍（${fmt(N.write5m)}），第一次调用比不用缓存多花 ${fmt(N.r1.cost - N.r1.plain)}，它是为后面的命中预付的。`,
      facts: [['cache_creation', `${N.r1.write} token（5 分钟）`], ['input_tokens', `${N.r1.input}（断点之后）`], ['全部输入', `${N.r1.write} + 0 + ${N.r1.input} = ${N.r1.total}`], ['费用', `${fmt(N.r1.cost)}（无缓存 ${fmt(N.r1.plain)}）`]],
      events: [
        show('cache', 'model', 'prompt', 'usage'),
        ...round('r1', ['r1'], { lookup: `t = 0：缓存是空的，没有命中，前缀 ${N.r1.write} token 写入`, read: `模型读入 ${R.r1.input} 个输入 token：缓存写入 ${N.r1.write}，未缓存 ${N.r1.input}` }),
        state('cache', { 条目: `${cache.entries.size}`, 前缀: `${prefix} token`, 有效期: '5 分钟' }),
      ],
    },
    {
      title: '第二次：命中，只收 0.05 倍',
      desc: `一分钟后，读 ${N.r2.read} token，${fmt(N.r2.cost)}`,
      detail: `请求 2 的前缀和第一次逐字节相同，哈希对上，命中的 ${N.r2.read} 个 token 记作 cache_read_input_tokens，只收基础输入价的 ${readRatio} 倍（${fmt(N.read)}，Opus 5.5 和 Sonnet 5.5 是 ${readRatio}，其他模型 0.1 倍）。问题不一样，${N.r2.input} 个 token 照常按未缓存的输入计费。这一次 ${fmt(N.r2.cost)}，比不用缓存的 ${fmt(N.r2.plain)} 便宜得多；命中还会刷新有效期，从这次请求开始重新算 5 分钟。`,
      facts: [['cache_read', `${N.r2.read} token`], ['input_tokens', `${N.r2.input}（问题）`], ['读取单价', `${formatPrice(price.read)}（输入价 ${formatPrice(price.input)} 的 ${readRatio} 倍）`], ['费用', `${fmt(N.r2.cost)}（无缓存 ${fmt(N.r2.plain)}）`]],
      events: [
        ...round('r2', ['r1', 'r2'], { lookup: `t = 60：前缀的哈希和缓存里的一致，命中 ${N.r2.read} token`, read: `模型读入 ${R.r2.input} 个输入 token：缓存读取 ${N.r2.read}，未缓存 ${N.r2.input}` }),
        state('cache', { 命中: `${N.r2.read} token`, 有效期: '从 t=60 重新算' }),
      ],
    },
    {
      title: '改了前缀一个字，全部失效',
      desc: `7 天改成 8 天，哈希变了，重新写入 ${N.r3.write}`,
      detail: `请求 3 只把规则里的「7 天」改成「8 天」，字节少了一个，但缓存键是到断点为止全部字节的哈希，对不上就没有命中，${N.r3.write} 个 token 全部重新写入，比第二次贵得多，还多出一个缓存条目（原来的条目在到期前仍然留着）。所以要把会变的东西放在断点后面：时间戳、请求 id、随机顺序的 JSON 键、变化的工具集，放进前缀就会让缓存悄悄失效。判断有没有命中，看 usage 里的 cache_read_input_tokens。`,
      facts: [['改动', '「7 天」→「8 天」，1 个字符'], ['前缀哈希', `${shortHash(R.r1.blocks[0].hash)} → ${shortHash(R.r3.blocks[0].hash)}`], ['cache_read', `${N.r3.read} token`], ['费用', `${fmt(N.r3.cost)}（无缓存 ${fmt(N.r3.plain)}）`]],
      events: [
        ...round('r3', ['r1', 'r2', 'r3'], { lookup: `t = 120：前缀少了一个字符，哈希 ${shortHash(R.r3.blocks[0].hash)} 不在缓存里，没有命中，重新写入 ${N.r3.write}`, read: `模型读入 ${R.r3.input} 个输入 token：缓存写入 ${N.r3.write}，读取 0` }),
        state('cache', { 条目: `${N.entries}`, 命中: '0', 有效期: '新条目 5 分钟' }),
      ],
    },
    {
      title: '不缓存的两种情况',
      desc: `前缀不足 ${N.min} token，或隔了 5 分钟`,
      detail: `前缀只有 ${N.short.prefix} 个 token，低于 ${N.min}，断点被静默忽略，不报错也不收写入费，usage 里读写都是 0，只能从这里发现没缓存上。另一种：请求 3 之后隔了 5 分钟以上才重发（t = ${TIMES.r4} s），条目已过期，要重新写入 ${N.r4.write}；有效期从写入或最近一次读取的那次请求开始算，在过期前每读一次就刷新一次。想要更长的间隔可以用 1 小时的有效期，写入是基础价的 ${CACHE_WRITE_1H} 倍，请求 1 的写入就要 ${fmt(N.write1h)}（5 分钟是 ${fmt(N.write5m)}）。`,
      facts: [['太短', `前缀 ${N.short.prefix} < ${N.min}，读写都是 0`], ['过期', `t = ${TIMES.r4} s，写入 ${N.r4.write}`], ['5 分钟写入', `${fmt(N.write5m)}（${CACHE_WRITE_5M} 倍）`], ['1 小时写入', `${fmt(N.write1h)}（${CACHE_WRITE_1H} 倍）`]],
      events: [
        pk('app', 'cache', 'amber', '短前缀', [`前缀 ${N.short.prefix} token`, `< ${N.min}`], [N.total, 'CACHE', `t = ${TIMES.short}：前缀 ${N.short.prefix} token 不足 ${N.min}，断点被忽略，读写都是 0`, R.short.http.bytes.length],
          wire('短前缀的请求和缓存查询', 'mem', 'internal',
            httpHead('请求头', R.short.http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
            jsonBody('请求体', R.short.body, { expand: ['system[0].text', 'system[0].cache_control'] }),
            lookupLayer('short')),
          { ds: { prompt: [blockRow('short')] } }),
        pk('app', 'cache', 'amber', '隔了 5 分钟', [`t = ${TIMES.r4} s`, '条目已过期'], [N.total + R.short.input + R.short.output, 'CACHE', `t = ${TIMES.r4}：距请求 3 超过 ${TTL_SECONDS['5m']} 秒，条目过期，重新写入 ${N.r4.write}`, R.r4.http.bytes.length],
          wire('请求 3 原样重发，但已过期', 'mem', 'internal',
            httpHead('请求头', R.r4.http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
            jsonBody('请求体', R.r4.body, { expand: ['system[0].cache_control'] }),
            lookupLayer('r4')),
          { ds: { prompt: [blockRow('r4')] } }),
        state('cache', { 命中: '0', 有效期: '已过期' }),
      ],
    },
    {
      title: '三次请求的账单',
      desc: `有缓存 ${fmt(N.costCached)}，无缓存 ${fmt(N.costPlain)}`,
      detail: `把请求 1、2、3 加起来：有缓存 ${fmt(N.r1.cost)} + ${fmt(N.r2.cost)} + ${fmt(N.r3.cost)} = ${fmt(N.costCached)}，不用缓存每次都按 ${formatPrice(price.input)} 计输入，是 ${fmt(N.costPlain)}，只省了 ${N.savedPct}%，因为请求 3 改了一个字，又付了一次写入。如果它没改，会像请求 2 一样命中，三次合计 ${fmt(N.costUnchanged)}，省 ${N.savedUnchangedPct}%。写入多收 ${CACHE_WRITE_5M - 1} 倍，读取只收 ${readRatio} 倍，同一段前缀在有效期内只要再用一次就回本。这和 LLM EXPLORER 里的前缀缓存是同一个道理，只是这里由 API 按前缀字节计费。`,
      facts: [['请求 1', `${fmt(N.r1.cost)}（写入）`], ['请求 2', `${fmt(N.r2.cost)}（命中）`], ['请求 3', `${fmt(N.r3.cost)}（改了一字，重写）`], ['合计', `${fmt(N.costCached)} / ${fmt(N.costPlain)}`]],
      events: [
        pk('model', 'usage', 'amber', '三次账单', [`有缓存 ${fmt(N.costCached)}`, `无缓存 ${fmt(N.costPlain)}`], [N.totalAll, 'CALL', `三次请求：有缓存 ${fmt(N.costCached)}，不用缓存 ${fmt(N.costPlain)}`, three.reduce((total, key) => total + spanOf(R[key].json, 'usage').to - spanOf(R[key].json, 'usage').valueFrom, 0)],
          wire('三次请求的费用对比（示例单价）', 'mem', 'format',
            ...three.map((key) => jsonBody(`${NAME[key]} 的 usage`, R[key].json, { root: 'usage' })),
            concept(`费用（示例单价，${PRICE_DATE}）`, [
              ...three.map((key): [string, string, string?] => [NAME[key], `${fmt(R[key].cost.total)}（无缓存 ${fmt(R[key].plainCost.total)}）`]),
              ['合计', `${fmt(N.costCached)}（无缓存 ${fmt(N.costPlain)}）`, '价格会变，以 Anthropic 定价页为准。'],
            ])),
          { ds: { usage: [compareGrid()] } }),
        note('usage', `三次请求 ${fmt(N.costCached)}，不缓存 ${fmt(N.costPlain)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '缓存按前缀字节算账',
    desc: `前缀 ${prefix} token，读取只收 ${readRatio} 倍`,
    text: `Prompt Caching 的全部规则都从「前缀匹配」推出来：断点放在稳定内容的末尾，变化的内容放在后面；前缀里任何一个字节变了，后面全部失效；太短不缓存，过期要重写，读取会刷新有效期。账单上写入是 ${CACHE_WRITE_5M} 倍（1 小时 ${CACHE_WRITE_1H} 倍），读取是 ${readRatio} 倍（Opus 5.5），所以前缀要稳定、要被反复用才划算。本站的缓存键是模拟的，token 数来自迷你分词器，真实数字不同，倍率和规则来自 Anthropic 文档。下一课进入上下文工程：窗口里的 token 要怎么分配、放不下了怎么办，先从预算拆账开始。`,
    facts: [['前缀', `${prefix} token`], ['读 / 写', `${readRatio} / ${CACHE_WRITE_5M} 倍`], ['三次请求', `${fmt(N.costCached)} / ${fmt(N.costPlain)}`], ['下一课', '上下文预算拆账']],
  },
};

