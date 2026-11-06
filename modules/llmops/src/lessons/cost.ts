/**
 * 可观测性第二课：成本与延迟拆账。沿用上一课那次请求（同一份请求、同一组 span）：
 * 每个 span 的 token 和费用由 callModel 真实计算（本站分词器的计数 × 共享包的示例单价），
 * 耗时、TTFT 是 **模拟** 的（latency.ts：本站假设的固定开销和每 token 耗时，乘固定种子的对数正态抖动），只用来演示长尾和分位数。
 * 分位数用 stats.ts 的 quantile（线性插值，Hyndman–Fan 第 7 种）和 nearestRank（最近秩），直方图用 bucketCounts
 * 和 GenAI 指标建议的桶边界（GENAI_DURATION_BUCKETS）。tests/narrative.observe.test.ts 核对文案。
 */
import {
  CACHE_READ,
  encodeJson,
  EXAMPLE_TIMING,
  formatPrice,
  formatUsd,
  GENAI_DURATION_BUCKETS,
  nearestRank,
  PRICE_DATE,
  priceOf,
  quantile,
  simulateCalls,
  type ModelCall,
  type Span,
} from '../core';
import { concept, jsonBody, num, wire } from '../decode/structures';
import { pct } from './common';
import { note, pk, show, state } from './dsl';
import { MODEL, SCREEN_MODEL } from './scenario';
import { ASSUMED_MS, chat1, chat2, chatSpan1, chatSpan2, duration, root, screen, screenSpan, t1, t2, toolResult, toolSpan, toolUse, tScreen, tree } from './trace';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 每个 span 的账 ----------

interface Entry {
  key: string;
  span: Span;
  call: ModelCall | null;
  ttft: number | null;
}
/** 筛查是非流式调用，没有 TTFT；工具不是模型调用，没有 token 和费用。 */
export const ENTRIES: Entry[] = [
  { key: 'haiku', span: screenSpan, call: screen, ttft: null },
  { key: 'chat 1', span: chatSpan1, call: chat1, ttft: t1.ttft },
  { key: 'tool', span: toolSpan, call: null, ttft: null },
  { key: 'chat 2', span: chatSpan2, call: chat2, ttft: t2.ttft },
];
const costOfEntry = (e: Entry) => e.call?.cost.total ?? 0;
export const total = ENTRIES.reduce((a, e) => a + costOfEntry(e), 0);
const byCost = [...ENTRIES].sort((a, b) => costOfEntry(b) - costOfEntry(a));
const byTime = [...ENTRIES].sort((a, b) => duration(b.span) - duration(a.span));
const outputCost = ENTRIES.reduce((a, e) => a + (e.call?.cost.output ?? 0), 0);
/** 用户看到回答第一个字的时刻：第 2 轮开始的时刻 + 它的 TTFT（之前的筛查、第 1 轮、工具都要先跑完）。 */
export const firstCharAt = Math.round((chatSpan2.start + t2.ttft) * 10) / 10;

// ---------- 同一种调用重复 200 次（模拟） ----------

export const REPEAT = 200;
export const LATENCY_SEED = 2;
export const run = simulateCalls(REPEAT, MODEL, chat2.message.usage.input_tokens, chat2.message.usage.output_tokens, LATENCY_SEED);
const totals = run.timings.map((t) => t.total);
export const SMALL = 20;
const small = totals.slice(0, SMALL);
const QS = [0.5, 0.95, 0.99] as const;
export const methods = {
  linear: QS.map((q) => quantile(totals, q)),
  nearest: QS.map((q) => nearestRank(totals, q)),
  smallLinear: QS.map((q) => quantile(small, q)),
  smallNearest: QS.map((q) => nearestRank(small, q)),
  smallMax: Math.max(...small),
};
/** 桶的区间 (lo, hi]（秒）；第 0 个桶下界是 −∞，最后一个上界是 +∞。 */
const bucketRange = (i: number): [number, number] => [i === 0 ? -Infinity : GENAI_DURATION_BUCKETS[i - 1], i < GENAI_DURATION_BUCKETS.length ? GENAI_DURATION_BUCKETS[i] : Infinity];
/** 只知道桶计数时，p95 落在哪个桶：累计计数第一次达到 ⌈0.95n⌉ 的桶。 */
const bucketOfRank = (rank: number) => {
  let acc = 0;
  for (let i = 0; i < run.buckets.length; i++) {
    acc += run.buckets[i];
    if (acc >= rank) return i;
  }
  return run.buckets.length - 1;
};
export const p95Bucket = bucketRange(bucketOfRank(Math.ceil(0.95 * REPEAT)));
const shownBuckets = run.buckets.map((count, i) => ({ count, i })).filter(({ i }) => i >= 7 && i <= 11);

// ---------- 文案用到的数 ----------

const ms = (v: number) => num(Math.round(v));
const s = (v: number) => (v / 1000).toFixed(2);
const usd = (nano: number) => formatUsd(nano);
const micro = (nano: number) => num(+(nano / 1000).toFixed(1));

export const numbers = {
  total: usd(total),
  totalNano: total,
  per1000: `$${+((total * 1000) / 1e9).toFixed(2)}`,
  costs: ENTRIES.map((e) => usd(costOfEntry(e))),
  priciest: byCost[0].key,
  priciestShare: pct(costOfEntry(byCost[0]) / total),
  screenShare: pct(screen.cost.total / total),
  outputShare: pct(outputCost / total),
  slowest: byTime[0].key,
  slowestMs: ms(duration(byTime[0].span)),
  slowestShare: pct(duration(byTime[0].span) / duration(root)),
  rootMs: ms(duration(root)),
  rootSelf: tree[0].self,
  ttft1: ms(t1.ttft),
  ttft2: ms(t2.ttft),
  firstCharAt: ms(firstCharAt),
  screenMs: ms(tScreen.total),
  toolMs: duration(toolSpan),
  input2: chat2.message.usage.input_tokens,
  output2: chat2.message.usage.output_tokens,
  output1: chat1.message.usage.output_tokens,
  perOutputMs: EXAMPLE_TIMING[MODEL].perOutputMs,
  outputRatio: priceOf(MODEL).output / priceOf(MODEL).input,
  p50: s(run.total.p50),
  p95: s(run.total.p95),
  p99: s(run.total.p99),
  max: s(run.total.max),
  mean: s(run.total.mean),
  min: s(run.total.min),
  tailRatio: (run.total.p99 / run.total.p50).toFixed(1),
  ttftP50: ms(run.ttft.p50),
  ttftP95: ms(run.ttft.p95),
  linear: methods.linear.map(s),
  nearest: methods.nearest.map(s),
  smallLinearP99: s(methods.smallLinear[2]),
  smallNearestP99: s(methods.smallNearest[2]),
  smallMax: s(methods.smallMax),
  smallRank: Math.ceil(0.99 * SMALL),
  bigRank: Math.ceil(0.99 * REPEAT),
  buckets: run.buckets,
  bucketCount: GENAI_DURATION_BUCKETS.length,
  p95Bucket,
  modeBucket: bucketRange(run.buckets.indexOf(Math.max(...run.buckets))),
  modeCount: Math.max(...run.buckets),
  cacheRead: CACHE_READ[MODEL],
  inputPrice: formatPrice(priceOf(MODEL).input),
  outputPrice: formatPrice(priceOf(MODEL).output),
  haikuInput: formatPrice(priceOf(SCREEN_MODEL).input),
};
const N = numbers;
const sec = (v: number) => `${+v.toFixed(2)}`;

// ---------- 图元 ----------

/** 账：行是 span，列是输入、输出 token，费用（µ$，百万分之一美元）和时长（ms）。shown 之前的行留空。 */
function ledgerGrid(shown: number, lift = -1, hot: 'cost' | 'ms' | null = null): GridPrim {
  return {
    kind: 'grid',
    id: 'l',
    w: 54,
    rows: ENTRIES.map((e) => e.key),
    cols: ['输入', '输出', 'µ$', 'ms'],
    cells: ENTRIES.map((e, r): DsCell[] => {
      if (r >= shown) return [0, 1, 2, 3].map(() => ({ v: '', tone: 'empty' }));
      const u = e.call?.message.usage;
      const costHeat = costOfEntry(e) / costOfEntry(byCost[0]);
      const timeHeat = duration(e.span) / duration(byTime[0].span);
      return [
        { v: u ? num(u.input_tokens) : '—', tone: u ? 'blue' : 'dim', lift: r === lift || undefined },
        { v: u ? num(u.output_tokens) : '—', tone: u ? 'blue' : 'dim', lift: r === lift || undefined },
        { v: u ? micro(costOfEntry(e)) : '0', tone: 'amber', heat: hot === 'cost' ? costHeat : undefined, lift: r === lift || undefined },
        { v: ms(duration(e.span)), tone: 'violet', heat: hot === 'ms' ? timeHeat : undefined, lift: r === lift || undefined },
      ];
    }),
  };
}

const pRow = (values: Array<[string, number]>, id = 'p', lift = -1): RowPrim => ({
  kind: 'row',
  id,
  w: 58,
  cells: values.map(([label, v], i): DsCell => ({ v: sec(v / 1000), sub: label, key: `${id}${i}`, tone: i === 0 ? 'blue' : i === values.length - 1 ? 'amber' : 'violet', lift: i === lift || undefined })),
});
const bucketRow: RowPrim = {
  kind: 'row',
  id: 'p',
  w: 58,
  cells: shownBuckets.map(({ count, i }, k): DsCell => ({ v: String(count), sub: `≤ ${GENAI_DURATION_BUCKETS[i]}`, key: `p${k}`, tone: 'teal', heat: count / N.modeCount, lift: (bucketRange(i)[1] === p95Bucket[1]) || undefined })),
};

// ---------- 字节层 ----------

function accountWire(e: Entry) {
  const c = e.call!;
  const price = priceOf(c.request.model);
  return wire(`${e.key} 的账`, 'mem', 'format',
    jsonBody('响应里的 usage', encodeJson(c.message.usage), { example: ['input_tokens', 'output_tokens'], notes: { input_tokens: '本站分词器的计数（示例）。没有缓存读写。', output_tokens: '回复的 token 数（示例）。' } }),
    concept('费用（纳美元，整数）', [
      ['输入', `${num(c.message.usage.input_tokens)} × ${num(price.input)} = ${num(c.cost.input)}`, `示例单价 ${formatPrice(price.input)}（${PRICE_DATE}）：一个 token ${num(price.input)} 纳美元。`],
      ['输出', `${num(c.message.usage.output_tokens)} × ${num(price.output)} = ${num(c.cost.output)}`, `示例单价 ${formatPrice(price.output)}。`],
      ['合计', `${num(c.cost.total)}（${usd(c.cost.total)}）`, '费用列累加的就是这个数。'],
      ['时长', `${ms(duration(e.span))} ms${e.ttft !== null ? `，TTFT ${ms(e.ttft)} ms` : ''}`, '模拟的：本站假设的固定开销和每 token 耗时，乘固定种子的抖动。'],
    ], 'amber'));
}

const percentileWire = wire(`重复 ${REPEAT} 次（模拟）`, 'mem', '示意', concept('第 2 轮的总时长（秒）', [
  ['p50', N.p50, '一半的调用比它快。'],
  ['p95', N.p95, `${REPEAT} 次里最慢的 5% 从这里开始。`],
  ['p99', N.p99, `是 p50 的 ${N.tailRatio} 倍。`],
  ['最大', N.max, `最快 ${N.min}，平均 ${N.mean}。`],
  ['TTFT', `p50 ${N.ttftP50} ms、p95 ${N.ttftP95} ms`, '首个输出块到达。'],
], 'violet', `固定种子 ${LATENCY_SEED} 的模拟：输入 ${N.input2}、输出 ${N.output2} token 的同一种调用，不是实测`));

const methodWire = wire('两种分位数算法', 'mem', '示意', concept('线性插值 vs 最近秩（秒）', [
  [`n = ${REPEAT}，p50`, `${N.linear[0]} / ${N.nearest[0]}`, '线性插值：在相邻两个观测值之间按比例取（NumPy、R 的默认）。'],
  [`n = ${REPEAT}，p95`, `${N.linear[1]} / ${N.nearest[1]}`, '最近秩：取排序后第 ⌈q·n⌉ 个，一定是某次真实观测。'],
  [`n = ${REPEAT}，p99`, `${N.linear[2]} / ${N.nearest[2]}`, `最近秩取第 ${N.bigRank} 个。`],
  [`n = ${SMALL}，p99`, `${N.smallLinearP99} / ${N.smallNearestP99}`, `⌈0.99 × ${SMALL}⌉ = ${N.smallRank}：最近秩就是最大值 ${N.smallMax}。`],
], 'violet'));

const bucketJson = encodeJson({ name: 'gen_ai.client.inference.duration', unit: 's', explicitBounds: [...GENAI_DURATION_BUCKETS], bucketCounts: run.buckets.map(String), count: String(REPEAT) });
const bucketWire = wire('直方图（OTLP 的显式桶）', 'mem', 'internal', jsonBody('直方图数据点（本站的简化写法）', bucketJson, {
  notes: {
    name: 'GenAI 约定的客户端推理耗时指标，单位秒。',
    explicitBounds: `约定建议的 ${N.bucketCount} 个桶边界，每个是上一个的 2 倍。`,
    bucketCounts: `比边界多一个：第 i 个桶是 (bᵢ₋₁, bᵢ]，上界包含在桶里。uint64 在 OTLP/JSON 里写成字符串。`,
  },
  summary: '只有名字、单位、边界和计数这几个字段，不是完整的 ExportMetricsServiceRequest',
}));

// ---------- 事件 ----------

const [eScreen, e1, , e2] = ENTRIES;
const c1 = screen.cost.total;
const c2 = c1 + chat1.cost.total;
const c3 = c2 + chat2.cost.total;

export const cost: Lesson = {
  id: 'cost',
  name: 'COST',
  title: '成本与延迟拆账',
  group: 'observe',
  layer: [1, 6],
  layerNote: '这课从「模型调用」到「监控」：费用来自每次调用的 usage，时长来自 span，分位数和直方图是监控指标的写法。',
  costNote: `重放上一课那次请求的三次模型调用：Claude Haiku 5.5 筛查 ${N.costs[0]}，Claude Opus 5.5 两轮 ${N.costs[1]} 和 ${N.costs[3]}，合计 ${N.total}；重复 ${REPEAT} 次只模拟耗时，没有记费用。`,
  nodes: ['backend', 'guard', 'llm', 'tools', 'observe', 'ledger', 'latency'],
  place: { backend: [470, 130], guard: [130, 380], llm: [880, 130], tools: [880, 430], observe: [520, 420], ledger: [250, 690], latency: [830, 720] },
  labels: {
    backend: ['客服后端', '同一次请求，再跑一遍'],
    guard: ['防护层', 'Haiku 筛查'],
    llm: ['模型', MODEL],
    tools: ['工具执行端', 'get_order'],
    observe: ['可观测性后端', '按 span 汇总'],
    ledger: ['每个 span 的账', 'token、µ$、ms'],
    latency: ['延迟分布', '模拟，单位秒'],
  },
  labelAt: { ledger: [0, 150], latency: [0, 105] },
  radius: { ledger: 90, latency: 70 },
  initial: { ledger: [], latency: [] },
  start: ['backend', 'guard', 'llm', 'tools'],
  legend: [['blue', 'token'], ['amber', '费用、最慢的尾部'], ['violet', '时长（模拟）'], ['teal', '直方图的桶'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '一次请求的钱花在哪、时间花在哪，分位数和直方图怎么读',
    description: `上一课那次请求一共花了 ${N.total}，其中 ${N.priciest} 一个 span 就占 ${N.priciestShare}，它也是最慢的，占了整个请求 ${N.slowestShare} 的时间。费用是 token × 示例单价，逐个 span 算得清；时长每次都不一样，要看分布：本站把第 2 轮这种调用模拟重复 ${REPEAT} 次，p99 是 p50 的 ${N.tailRatio} 倍。最后看分位数的两种算法，和只存直方图桶时会丢掉什么。所有时长都是固定种子的模拟，不是实测。`,
    facts: [
      ['一次请求', `${N.total}（示例单价，${PRICE_DATE}）`],
      ['最贵、最慢', N.priciest],
      ['p50 / p99', `${N.p50} s / ${N.p99} s（模拟）`],
      ['直方图', `${N.bucketCount} 个桶边界`],
    ],
  },
  steps: [
    {
      title: '逐个 span 记账',
      desc: `三次模型调用，合计 ${N.total}`,
      detail: `把上一课的请求再跑一遍，每个 span 结束时记下 token、费用和时长：费用 = 输入 token × 输入单价 + 输出 token × 输出单价，全部用整数纳美元算，表里写成 µ$（百万分之一美元）。Claude Opus 5.5 的示例单价是输入 ${N.inputPrice}、输出 ${N.outputPrice}，Claude Haiku 5.5 输入只要 ${N.haikuInput}。get_order 不调用模型，只有时长。`,
      facts: [['haiku', N.costs[0]], ['chat 1', N.costs[1]], ['chat 2', N.costs[3]], ['合计', N.total]],
      events: [
        show('ledger'),
        pk('llm', 'guard', 'green', 'haiku', [`${screen.message.usage.input_tokens} / ${screen.message.usage.output_tokens} token`], [c1, 'INFER', `筛查：输入 ${screen.message.usage.input_tokens}、输出 ${screen.message.usage.output_tokens} token，${N.costs[0]}`, encodeJson(screen.message.usage).bytes.length], accountWire(eScreen), { ds: { ledger: [ledgerGrid(1, 0)] } }),
        pk('llm', 'backend', 'green', 'chat 1', [`${chat1.message.usage.input_tokens} / ${N.output1} token`], [c2, 'INFER', `第 1 轮：输入 ${chat1.message.usage.input_tokens}、输出 ${N.output1} token，${N.costs[1]}`, encodeJson(chat1.message.usage).bytes.length], accountWire(e1), { ds: { ledger: [ledgerGrid(2, 1)] } }),
        pk('tools', 'backend', 'teal', 'get_order', [`${N.toolMs} ms`], [c2, 'TOOL', `get_order：不调用模型，${N.toolMs} ms（模拟）`, toolResult.bytes.length], wire('工具的账', 'mem', 'format', jsonBody('tool_result 的内容', toolResult, { summary: `${toolUse.name} 在订单数据上执行，没有 token 和费用` })), { ds: { ledger: [ledgerGrid(3, 2)] } }),
        pk('llm', 'backend', 'green', 'chat 2', [`${N.input2} / ${N.output2} token`], [c3, 'INFER', `第 2 轮：输入 ${N.input2}、输出 ${N.output2} token，${N.costs[3]}`, encodeJson(chat2.message.usage).bytes.length], accountWire(e2), { ds: { ledger: [ledgerGrid(4, 3)] } }),
        state('backend', { 模型调用: '3 次', 费用: N.total }),
      ],
    },
    {
      title: '最贵、最慢的环节',
      desc: `${N.priciest} 占费用 ${N.priciestShare}、时间 ${N.slowestShare}`,
      detail: `按费用排，${N.priciest} 占 ${N.priciestShare}：它的输入最长（带着第 1 轮的回复和工具结果），输出也最多，而 Opus 的输出单价是输入的 ${N.outputRatio} 倍，三次调用里输出部分合起来占 ${N.outputShare}。Haiku 筛查只占 ${N.screenShare}，把检查交给小模型几乎不增加费用。两轮的 system、工具定义和问题是相同的前缀，用提示缓存可以让重复的部分按缓存读计价（Opus 是基础输入价的 ${N.cacheRead} 倍，CONTEXT 的缓存课讲过）。`,
      facts: [['最贵', `${N.priciest}，${N.priciestShare}`], ['输出部分', N.outputShare], ['Haiku 筛查', N.screenShare], ['缓存读', `基础价 × ${N.cacheRead}`]],
      events: [
        show('observe'),
        pk('backend', 'observe', 'amber', '按费用排', [`${N.priciest} ${N.priciestShare}`], [c3, 'STATS', `按费用排：${N.priciest} 占 ${N.priciestShare}，输出部分占 ${N.outputShare}`, null], wire('费用排序', 'mem', '示意', concept('费用（纳美元）', ENTRIES.map((e): [string, string, string] => [e.key, num(costOfEntry(e)), pct(costOfEntry(e) / total)]), 'amber')), { ds: { ledger: [ledgerGrid(4, ENTRIES.indexOf(byCost[0]), 'cost')] } }),
        note('ledger', `${N.priciest}：${N.priciestShare}`, 'amber'),
      ],
    },
    {
      title: '时间花在哪：TTFT 和总时长',
      desc: `用户等了 ${N.firstCharAt} ms 才看到第一个字`,
      detail: `按时长排，${N.slowest} 用了 ${N.slowestMs} ms，占整个请求 ${N.rootMs} ms 的 ${N.slowestShare}；它的 TTFT（首个输出块到达的时间）只有 ${N.ttft2} ms，剩下的时间都在一个个吐出 ${N.output2} 个输出 token。可用户看到回答的第一个字是在请求开始后 ${N.firstCharAt} ms：前面的筛查、第 1 轮和查订单都得先跑完，单看某个 span 的 TTFT 会低估用户的等待。这些时长都是本站模拟的（Opus 假设每个输出 token ${N.perOutputMs} ms），只说明形状，不代表实测。`,
      facts: [['chat 2', `${N.slowestMs} ms（${N.slowestShare}）`], ['chat 2 的 TTFT', `${N.ttft2} ms`], ['第一个字', `${N.firstCharAt} ms`], ['get_order', `${N.toolMs} ms`]],
      events: [
        pk('backend', 'observe', 'violet', '按时长排', [`${N.slowest} ${N.slowestMs} ms`], [c3, 'STATS', `按时长排：${N.slowest} ${N.slowestMs} ms，占 ${N.slowestShare}`, null], wire('时长排序', 'mem', '示意', concept('时长（毫秒，模拟）', [
          ...ENTRIES.map((e): [string, string, string] => [e.key, ms(duration(e.span)), e.ttft !== null ? `TTFT ${ms(e.ttft)} ms。` : e.call ? '非流式调用，没有 TTFT。' : '不是模型调用。']),
          ['第一个字', `${N.firstCharAt} ms`, `chat 2 开始于 ${ms(chatSpan2.start)} ms，再加它的 TTFT。`],
          ['本站假设', `本地检测 ${ASSUMED_MS.detector} ms、工具基准 ${ASSUMED_MS.toolBase} ms`, '乘固定种子的对数正态抖动。'],
        ], 'violet')), { ds: { ledger: [ledgerGrid(4, ENTRIES.indexOf(byTime[0]), 'ms')] } }),
        note('observe', `第一个字：${N.firstCharAt} ms`),
      ],
    },
    {
      title: '一次不算数：看分位数',
      desc: `重复 ${REPEAT} 次：p50 ${N.p50} s，p99 ${N.p99} s`,
      detail: `同样的输入、同样长的回答，每次耗时都不一样，所以延迟要看分布：本站把第 2 轮这种调用模拟了 ${REPEAT} 次（固定种子 ${LATENCY_SEED}）。p50 是 ${N.p50} s，p95 是 ${N.p95} s，p99 是 ${N.p99} s，最慢的一次 ${N.max} s：平均数 ${N.mean} s 看不出这条长尾。告警和服务目标通常盯 p95、p99，因为慢的那几个请求才是用户抱怨的。`,
      facts: [['p50', `${N.p50} s`], ['p95', `${N.p95} s`], ['p99', `${N.p99} s`], ['平均', `${N.mean} s`]],
      events: [
        show('latency'),
        pk('observe', 'latency', 'violet', `${REPEAT} 次`, [`p99 ${N.p99} s`], [c3, 'STATS', `模拟 ${REPEAT} 次：p50 ${N.p50}、p95 ${N.p95}、p99 ${N.p99} s`, null], percentileWire, { ds: { latency: [pRow([['p50', run.total.p50], ['p95', run.total.p95], ['p99', run.total.p99], ['max', run.total.max]], 'p', 2)] } }),
        note('latency', `p99 是 p50 的 ${N.tailRatio} 倍`, 'amber'),
      ],
    },
    {
      title: '分位数的两种算法',
      desc: `${SMALL} 个样本时，最近秩的 p99 就是最大值`,
      detail: `分位数有不止一种算法：线性插值在相邻两个观测值之间按比例取（NumPy、R 的默认），最近秩取排序后第 ⌈q·n⌉ 个，结果一定是某次真实观测。${REPEAT} 个样本时两者很接近：p50 是 ${N.linear[0]} s 和 ${N.nearest[0]} s，p99 都约 ${N.linear[2]} s。只有前 ${SMALL} 个样本时，⌈0.99 × ${SMALL}⌉ = ${N.smallRank}，最近秩的 p99 就是最大值 ${N.smallNearestP99} s，线性插值给出 ${N.smallLinearP99} s：样本少时 p99 只是在描述最慢的那一两次。`,
      facts: [[`p99（n = ${REPEAT}）`, `${N.linear[2]} / ${N.nearest[2]} s`], [`p99（n = ${SMALL}）`, `${N.smallLinearP99} / ${N.smallNearestP99} s`], ['最近秩', '第 ⌈q·n⌉ 个'], ['线性插值', 'Hyndman–Fan 第 7 种']],
      events: [
        pk('observe', 'latency', 'violet', '两种算法', [`n = ${SMALL}`, `p99 ${N.smallLinearP99} / ${N.smallNearestP99}`], [c3, 'STATS', `前 ${SMALL} 个样本：线性插值 p99 ${N.smallLinearP99} s，最近秩 ${N.smallNearestP99} s（最大值）`, null], methodWire, { ds: { latency: [pRow([['p50', methods.smallLinear[0]], ['p95', methods.smallLinear[1]], ['p99', methods.smallLinear[2]], ['最近秩', methods.smallNearest[2]]], 'p', 3)] } }),
        note('latency', `n = ${SMALL}：最近秩 p99 = 最大值`),
      ],
    },
    {
      title: '直方图：只存桶，丢了精度',
      desc: `p95 只知道在 ${N.p95Bucket[0]}–${N.p95Bucket[1]} s 之间`,
      detail: `线上不会把每次耗时都存下来，而是按指标 gen_ai.client.inference.duration（单位秒）累计直方图：GenAI 约定建议 ${N.bucketCount} 个桶边界，从 0.01 s 起每个翻一倍。这 ${REPEAT} 次里有 ${N.modeCount} 次落在 ${N.modeBucket[0]}–${N.modeBucket[1]} s 这个桶。只有桶计数时，p95 只能确定在 ${N.p95Bucket[0]}–${N.p95Bucket[1]} s 之间，后端在桶里插值给出的数是估计，桶越宽误差越大。`,
      facts: [['指标', 'gen_ai.client.inference.duration'], ['桶边界', `${N.bucketCount} 个，0.01–81.92 s`], ['最多的桶', `${N.modeBucket[0]}–${N.modeBucket[1]} s：${N.modeCount} 次`], ['p95 所在的桶', `${N.p95Bucket[0]}–${N.p95Bucket[1]} s`]],
      events: [
        pk('observe', 'latency', 'teal', '按桶计数', [`${N.bucketCount} 个边界`], [c3, 'STATS', `按 GenAI 指标的桶边界计数：${N.modeBucket[0]}–${N.modeBucket[1]} s 有 ${N.modeCount} 次`, bucketJson.bytes.length], bucketWire, { ds: { latency: [bucketRow] } }),
        note('latency', `p95 在 ${N.p95Bucket[0]}–${N.p95Bucket[1]} s`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '钱按 token 算，时间按分布看',
    desc: `一次请求 ${N.total}，一千次约 ${N.per1000}`,
    text: `费用能逐个 span 精确算：token × 单价，这次请求 ${N.total}，照这样一千次约 ${N.per1000}，大头在输出最多的那一轮；想省钱先看输出长度和能不能缓存，小模型做筛查几乎不花钱。时间不能只看一次：单个 span 的 TTFT 会低估用户的等待，分位数要说清用的哪种算法和多少样本，只存直方图桶时 p95 只是个区间。本课的时长全是模拟的，只演示形状。下一课把视角从一次请求换成一段线上流量：指标、告警、采样，和把出问题的请求变成评估用例。`,
    facts: [['一次请求', N.total], ['最贵、最慢', N.priciest], ['p99 / p50', `${N.tailRatio} 倍（模拟）`], ['下一课', '生产监控与回流']],
  },
};
