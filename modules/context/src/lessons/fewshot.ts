/**
 * 提示组第二课：zero-shot / few-shot / CoT。同一个任务（给评论分类），三种提示写法，
 * 每一种的请求字节、输入 token、成本都由 core/ 真实计算；三段模型回复是示例（E.G.），它们的输出 token 和费用也是真实计算的。
 * 回复「是什么样」取决于真实模型，这里只演示三种写法各自改变成本的机制，tests/narrative.prompt.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  costOf,
  createMessage,
  encodeJson,
  exampleId,
  formatPrice,
  formatUsd,
  inputBreakdown,
  MODELS,
  PRICE_DATE,
  priceOf,
  spanOf,
  type ContentBlock,
  type MessagesRequest,
} from '../core';
import { concept, jsonBody, promptPieces, utf8Lines, wire } from '../decode/structures';
import { promptSegments, segmentRow } from './common';
import { note, pk, show } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

export const MODEL = 'claude-opus-5-5';
export const REVIEW = '快递很慢，但是东西不错。';
export const QUESTION = `这条评论的情感是什么？${REVIEW}`;
const BASE_SYSTEM = '你是评论分类助手。';

/** few-shot 的三个示例：每个是一问一答，答案只有类别，格式就由它们定下来。 */
export const EXAMPLES: Array<[question: string, answer: string]> = [
  ['这条评论的情感是什么？质量很好，下次还买。', '正面'],
  ['这条评论的情感是什么？用了两天就坏了。', '负面'],
  ['这条评论的情感是什么？和描述一样，没什么特别。', '中性'],
];

export type Variant = 'zero' | 'few' | 'cot';
export const VARIANTS: Variant[] = ['zero', 'few', 'cot'];
export const NAME: Record<Variant, string> = { zero: 'zero-shot', few: 'few-shot', cot: 'CoT' };

export const REQUESTS: Record<Variant, MessagesRequest> = {
  zero: { model: MODEL, max_tokens: 1024, system: BASE_SYSTEM, messages: [{ role: 'user', content: QUESTION }] },
  few: {
    model: MODEL,
    max_tokens: 1024,
    system: BASE_SYSTEM,
    messages: [...EXAMPLES.flatMap(([question, answer]) => [{ role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer }]), { role: 'user', content: QUESTION }],
  },
  cot: { model: MODEL, max_tokens: 1024, system: `${BASE_SYSTEM}先一步步分析，再在最后一行写「类别：…」。`, messages: [{ role: 'user', content: QUESTION }] },
};

/** 另一种写示例的办法：全部挤进同一条 user 消息，省掉每一轮的模板开销。只用来比较。 */
export const FEW_INLINE: MessagesRequest = {
  model: MODEL,
  max_tokens: 1024,
  system: BASE_SYSTEM,
  messages: [{ role: 'user', content: `${EXAMPLES.map(([question, answer]) => `${question}\n${answer}`).join('\n\n')}\n\n${QUESTION}` }],
};

/** 三段模型回复：示例（本站不跑大模型）。关键不是措辞，而是长度：直接问容易啰嗦，示例把格式压成一个词，CoT 把推理写出来。 */
export const REPLIES: Record<Variant, ContentBlock[]> = {
  zero: [{ type: 'text', text: '这条评论有好有坏：快递很慢是负面，东西不错是正面，整体偏中性，没有明显的倾向。' }],
  few: [{ type: 'text', text: '中性' }],
  cot: [{ type: 'text', text: '1. 「快递很慢」：对物流不满，负面。\n2. 「东西不错」：对商品满意，正面。\n3. 一负一正，没有压倒性的倾向。\n类别：中性' }],
};
const replyText = (variant: Variant) => (REPLIES[variant][0] as { text: string }).text;

const result = Object.fromEntries(
  VARIANTS.map((variant) => {
    const request = REQUESTS[variant];
    const body = encodeJson(request);
    const breakdown = inputBreakdown(request);
    const message = createMessage(request, REPLIES[variant], { id: exampleId('msg', 10 + VARIANTS.indexOf(variant)) });
    const cost = costOf(message.usage, MODEL);
    return [variant, { request, body, breakdown, message, cost, input: message.usage.input_tokens, output: message.usage.output_tokens }];
  }),
) as Record<Variant, { request: MessagesRequest; body: ReturnType<typeof encodeJson>; breakdown: ReturnType<typeof inputBreakdown>; message: ReturnType<typeof createMessage>; cost: ReturnType<typeof costOf>; input: number; output: number }>;
export { result };

const price = priceOf(MODEL);
const fewInline = inputBreakdown(FEW_INLINE).total;
/** 累计 token：读入的输入加写出的输出，按三种写法的顺序。 */
const running = VARIANTS.reduce<number[]>((acc, variant) => [...acc, (acc[acc.length - 1] ?? 0) + result[variant].input + result[variant].output], []);
const byCost = [...VARIANTS].sort((a, b) => result[a].cost.total - result[b].cost.total);
const roles = (variant: Variant) => REQUESTS[variant].messages.map((message) => message.role);
const chars = (variant: Variant) => [...replyText(variant)].length;
const fmt = formatUsd;

export const numbers = {
  zero: { bodyBytes: result.zero.body.bytes.length, input: result.zero.input, output: result.zero.output, cost: result.zero.cost.total, messages: 1 },
  few: { bodyBytes: result.few.body.bytes.length, input: result.few.input, output: result.few.output, cost: result.few.cost.total, messages: REQUESTS.few.messages.length },
  cot: { bodyBytes: result.cot.body.bytes.length, input: result.cot.input, output: result.cot.output, cost: result.cot.cost.total, messages: 1 },
  fewInline,
  running,
  total: running[running.length - 1],
  cheapest: byCost[0],
  priciest: byCost[2],
  fewExtraInput: result.few.input - result.zero.input,
  cotExtraInput: result.cot.input - result.zero.input,
  inputPrice: price.input,
  outputPrice: price.output,
};
const N = numbers;

// ---------- 图元 ----------

const TONE = { zero: 'blue', few: 'violet', cot: 'teal' } as const;
const requestRow = (upto: number, lift?: Variant): RowPrim => ({
  kind: 'row',
  id: 'q',
  w: 70,
  cells: VARIANTS.map((variant, index): DsCell => (index < upto ? { v: NAME[variant], tone: TONE[variant], sub: `${result[variant].body.bytes.length} B`, key: variant, lift: lift === variant || undefined } : { v: '', sub: NAME[variant] })),
});

/** 格子下面的来源名要短：9 个格子挤在一排，messages[0] 这种长名字会互相压住。 */
const shortLabel = (variant: Variant, source: string): string => {
  const m = /^messages\[(\d+)\]/.exec(source);
  if (!m) return source === 'template' ? '模板' : source;
  const i = Number(m[1]);
  if (variant !== 'few') return '问题';
  return i === 6 ? '提问' : i % 2 ? `答${(i + 1) / 2}` : `问${i / 2 + 1}`;
};
const segmentsOf = (variant: Variant) => promptSegments(result[variant].breakdown.prompt, roles(variant)).map((segment) => ({ ...segment, label: shortLabel(variant, segment.source) }));
const promptRow = (variant: Variant): RowPrim => ({ ...segmentRow('p', segmentsOf(variant), { w: variant === 'few' ? 44 : 62 }) });

const outRow = (upto: number): RowPrim => ({
  kind: 'row',
  id: 'o',
  w: 66,
  cells: VARIANTS.map((variant, index): DsCell => (index < upto ? { v: String(result[variant].output), tone: 'green', sub: NAME[variant], key: variant } : { v: '', sub: NAME[variant] })),
});

const costGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 78,
  rows: VARIANTS.map((variant) => NAME[variant]),
  cols: ['输入', '输出', '费用'],
  cells: VARIANTS.map((variant): DsCell[] => [
    { v: String(result[variant].input), tone: 'blue' },
    { v: String(result[variant].output), tone: 'green' },
    { v: fmt(result[variant].cost.total), tone: variant === byCost[0] ? 'teal' : 'amber' },
  ]),
});

const costLine = (variant: Variant) => `${result[variant].input} × ${formatPrice(price.input)} + ${result[variant].output} × ${formatPrice(price.output)} = ${fmt(result[variant].cost.total)}`;

/** 这一种写法的一次往返：请求体、模型读入、模型输出。 */
function round(variant: Variant, index: number, notes: { request: string; reply: string }) {
  const r = result[variant];
  const before = index ? running[index - 1] : 0;
  const prompt = r.breakdown.prompt;
  return [
    pk('app', 'request', TONE[variant], `${NAME[variant]} 请求`, [`${r.request.messages.length} 条 messages`, `${r.body.bytes.length} 字节`], [before, 'JSON', `${NAME[variant]}：请求体 ${r.body.bytes.length} 字节，${r.request.messages.length} 条 messages`, r.body.bytes.length],
      wire(`${NAME[variant]} 的请求体`, 'mem', 'format', jsonBody('请求体', r.body, { notes: { system: notes.request } })),
      { ds: { request: [requestRow(index + 1, variant)] } }),
    pk('request', 'model', 'violet', `${r.input} 个输入 token`, [`${NAME[variant]}`, `${r.input} token`], [before + r.input, 'INFER', `模型读入 ${r.input} 个输入 token（${NAME[variant]}）`, prompt.bytes.length],
      wire(`${NAME[variant]} 展开后的提示（ChatML 演示）`, 'mem', 'internal', promptPieces('ChatML 文本', prompt)),
      { ds: { prompt: [promptRow(variant)] } }),
    pk('model', 'out', 'green', `${r.output} 个输出 token`, [`「${replyText(variant).slice(0, 10).replace(/\n/g, ' ')}…」`], [running[index], 'INFER', `写出 ${r.output} 个输出 token（${chars(variant)} 个字符），${r.message.stop_reason}`, utf8Encode(replyText(variant)).length],
      wire(`${NAME[variant]} 的回复（示例）`, 'mem', 'format', utf8Lines('回复文本', replyText(variant), { color: 'green', summary: `${chars(variant)} 个字符，${r.output} 个 token（模型写的内容是示例）`, notes: { 0: notes.reply } })),
      { ds: { out: [outRow(index + 1)] } }),
  ];
}

// ---------- 课程 ----------

export const fewshot: Lesson = {
  id: 'fewshot',
  name: 'FEWSHOT',
  title: 'zero-shot / few-shot / CoT 对比',
  group: 'prompt',
  layer: [4, 5],
  layerNote: '提示的写法改变 messages 的内容，也就改变了展开后的 token 和账单。',
  tokensNote: '三次请求各自读入的输入 token 加写出的输出 token，依次累加。',
  nodes: ['app', 'request', 'prompt', 'model', 'out', 'usage'],
  place: { app: [90, 190], request: [450, 90], prompt: [540, 380], model: [880, 230], out: [880, 580], usage: [250, 590] },
  labels: {
    app: ['应用', '同一个任务'],
    request: ['请求', '三种写法的请求体'],
    prompt: ['展开后的输入', '按来源分段的 token 数'],
    model: ['模型', MODELS[MODEL].name],
    out: ['输出 token', '回复是示例（E.G.）'],
    usage: ['成本对比', `示例单价，${PRICE_DATE}`],
  },
  labelAt: { request: [-210, 20], prompt: [-215, -5], out: [-30, 100], usage: [-250, 95] },
  radius: { request: 60, prompt: 60, out: 56, usage: 60 },
  initial: { request: [], prompt: [], out: [], usage: [] },
  start: ['app', 'request'],
  legend: [['blue', 'zero-shot'], ['violet', 'few-shot'], ['teal', 'CoT'], ['green', '模型的回复（E.G.）'], [null, 'token 列：三次请求依次累计的输入加输出']],
  overview: {
    full: '同一个任务，三种写法，三种账单',
    description: `任务是给评论「${REVIEW}」分类。zero-shot 只写指令和问题，输入 ${N.zero.input} 个 token；few-shot 再带 3 组示例，输入涨到 ${N.few.input} 个；CoT 让模型先分析再作答，输入只多 ${N.cotExtraInput} 个，但输出会长出一大截。三种写法的请求字节、输入 token、成本都是真实计算的，模型写的回复是示例，所以这一课比较的是「机制」：示例花输入 token 换格式，CoT 花输出 token 换推理步骤，输出每个 token 的单价是输入的 ${price.output / price.input} 倍。`,
    facts: [
      ['任务', `给评论分类：${REVIEW}`],
      ['模型', `${MODEL}（${MODELS[MODEL].name}）`],
      ['输入 token', `zero ${N.zero.input}、few ${N.few.input}、CoT ${N.cot.input}`],
      ['输出 token', `zero ${N.zero.output}、few ${N.few.output}、CoT ${N.cot.output}`],
      ['费用', `${fmt(N.zero.cost)} / ${fmt(N.few.cost)} / ${fmt(N.cot.cost)}（示例单价）`],
    ],
  },
  steps: [
    {
      title: '同一个任务，三种写法',
      desc: '直接问、给示例、让它先分析',
      detail: `任务不变：判断「${REVIEW}」是正面、负面还是中性。zero-shot 只给指令和问题，模型靠自己对任务的理解作答；few-shot 在问题前放几组问答当示例，让模型照着学格式和判断尺度；CoT（chain of thought）在指令里要求它先写出分析，再给结论。三种写法只改了请求里的文字，没有改任何 API 参数。`,
      facts: [['zero-shot', '指令 + 问题'], ['few-shot', `指令 + ${EXAMPLES.length} 组示例问答 + 问题`], ['CoT', '指令里加「先一步步分析」'], ['评论', `${[...REVIEW].length} 个字符`]],
      events: [
        pk('app', 'request', 'blue', '三种写法', ['zero-shot', 'few-shot', 'CoT'], [0, 'CALL', `同一个评论，准备三种请求：${NAME.zero}、${NAME.few}、${NAME.cot}`, utf8Encode(REVIEW).length],
          wire('要分类的评论', 'mem', 'format',
            utf8Lines('评论', REVIEW, { summary: `${[...REVIEW].length} 个字符：三种写法共用` }),
            concept('三种写法', [
              ['zero-shot', '只有指令和问题', '最短；模型的回答格式靠它自己决定。'],
              ['few-shot', `加 ${EXAMPLES.length} 组问答示例`, '示例定下输出格式和判断尺度。'],
              ['CoT', '要求先分析再作答', '推理写在输出里，输出 token 变多。'],
            ])),
          { ds: { request: [requestRow(0)] } }),
        show('model'),
      ],
    },
    {
      title: 'zero-shot：最短的输入',
      desc: `输入 ${N.zero.input} + 输出 ${N.zero.output} token，${fmt(N.zero.cost)}`,
      detail: `请求只有一句 system 和一个问题，输入 ${N.zero.input} 个 token（其中模板 ${result.zero.breakdown.template} 个）。没有示例限制格式，示例回复写成了一小段话：${chars('zero')} 个字符、${N.zero.output} 个输出 token。输入便宜、输出贵，所以 zero-shot 的成本里输出占了 ${Math.round((result.zero.cost.output / result.zero.cost.total) * 100)}%。`,
      facts: [['输入', `${N.zero.input} token`], ['输出', `${N.zero.output} token（E.G.）`], ['计算', costLine('zero')], ['累计 token', String(running[0])]],
      events: [
        show('prompt', 'out'),
        ...round('zero', 0, { request: 'system：定下角色，没有格式要求。', reply: '没有示例限定格式，这段回复啰嗦（示例）：真实模型的回答方式不固定。' }),
      ],
    },
    {
      title: 'few-shot：用输入 token 换格式',
      desc: `输入涨到 ${N.few.input}，输出只剩 ${N.few.output}`,
      detail: `3 组示例写成 3 轮 user / assistant 对话放在问题前，输入比 zero-shot 多了 ${N.fewExtraInput} 个 token，其中每一轮都要付一份模板开销，合计模板 ${result.few.breakdown.template} 个。示例的回答都只有一个词，模型照着写，示例回复只剩 ${N.few.output} 个输出 token，格式也稳定得可以直接拿去解析。把示例挤进同一条 user 消息可以省掉部分模板开销（本站计数是 ${fewInline} 个 token，比分轮写少 ${N.few.input - fewInline} 个），代价是示例和提问混在一起。`,
      facts: [['输入', `${N.few.input} token（比 zero 多 ${N.fewExtraInput}）`], ['输出', `${N.few.output} token（E.G.）`], ['计算', costLine('few')], ['示例写进一条消息', `${fewInline} token`]],
      events: [
        ...round('few', 1, { request: 'system 不变，示例放在 messages 里：3 组 user / assistant。', reply: '只有一个词（示例）：示例把格式压成了类别名。' }),
      ],
    },
    {
      title: 'CoT：用输出 token 换推理步骤',
      desc: `输入只多 ${N.cotExtraInput}，输出涨到 ${N.cot.output}`,
      detail: `CoT 只在 system 里多了一句「先一步步分析」，输入比 zero-shot 多 ${N.cotExtraInput} 个 token，几乎没变。变的是输出：模型把分析一条条写出来，再给结论，${chars('cot')} 个字符、${N.cot.output} 个输出 token。每个输出 token 的单价是输入的 ${price.output / price.input} 倍，这些推理步骤就是 CoT 的价格，换来的是更难的题（多步计算、需要权衡的判断）答得更准。`,
      facts: [['输入', `${N.cot.input} token（比 zero 多 ${N.cotExtraInput}）`], ['输出', `${N.cot.output} token（E.G.）`], ['计算', costLine('cot')], ['输出单价', `${formatPrice(price.output)}，是输入的 ${price.output / price.input} 倍`]],
      events: [
        ...round('cot', 2, { request: 'system 里加了一句：先一步步分析，再在最后一行写类别。', reply: '推理步骤写在输出里（示例），最后一行是结论。' }),
      ],
    },
    {
      title: '三份账单',
      desc: `${NAME[N.cheapest]} 最省，${NAME[N.priciest]} 最贵`,
      detail: `按示例单价（${PRICE_DATE}），输入 $${price.input / 1000} / MTok、输出 $${price.output / 1000} / MTok：zero-shot ${fmt(N.zero.cost)}，few-shot ${fmt(N.few.cost)}，CoT ${fmt(N.cot.cost)}。示例多了输入、少了输出，CoT 反过来，哪个划算取决于输入和输出的比例，不是「示例总是更贵」。真正要比的是准确率和每次调用的稳定性：示例换来稳定的格式，CoT 换来更难题目上的正确率，这两样 token 数算不出来，要用自己的评测集量。`,
      facts: [['zero-shot', fmt(N.zero.cost)], ['few-shot', fmt(N.few.cost)], ['CoT', fmt(N.cot.cost)], ['累计 token', `${N.total}`]],
      events: [
        show('usage'),
        pk('out', 'usage', 'amber', '三份账单', [`zero ${fmt(N.zero.cost)}`, `few ${fmt(N.few.cost)}`, `CoT ${fmt(N.cot.cost)}`], [N.total, 'CALL', `按示例单价算账：zero ${fmt(N.zero.cost)}，few ${fmt(N.few.cost)}，CoT ${fmt(N.cot.cost)}`, VARIANTS.reduce((sum, variant) => sum + spanOf(encodeJson(result[variant].message), 'usage').to - spanOf(encodeJson(result[variant].message), 'usage').valueFrom, 0)],
          wire('三次响应的 usage，和按示例单价算出的费用', 'mem', 'format',
            ...VARIANTS.map((variant) => jsonBody(`${NAME[variant]} 的 usage`, encodeJson(result[variant].message), { root: 'usage', color: TONE[variant] })),
            concept(`费用（示例单价，${PRICE_DATE}）`, VARIANTS.map((variant): [string, string, string?] => [NAME[variant], costLine(variant)]))),
          { ds: { usage: [costGrid()] } }),
        note('usage', `${NAME[N.cheapest]} 最省：${fmt(result[N.cheapest].cost.total)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '提示的写法就是账单的写法',
    desc: `累计 ${N.total} 个 token`,
    text: `zero-shot、few-shot、CoT 没有改 API，只改了 messages 里的文字，却把 token 挪到了不同的地方：示例花在输入上，推理步骤花在输出上，而输出每个 token 比输入贵 ${price.output / price.input} 倍。这一课用的回复是示例，所以比较的是机制：到底哪种更准、更稳，只能拿真实模型和自己的数据去量。写好的示例还有一个好处，它们每次都一样，正适合放进前缀被缓存（Prompt Caching 那一课会算）。本站的 token 数来自迷你分词器，中文切得比真实模型碎，三种写法的相对关系可信，绝对值不要照搬。下一课把「让模型输出稳定的格式」再往前推一步：直接在 API 里带上 JSON schema，保证输出可以解析。`,
    facts: [['zero / few / CoT 输入', `${N.zero.input} / ${N.few.input} / ${N.cot.input}`], ['输出', `${N.zero.output} / ${N.few.output} / ${N.cot.output}`], ['最省', NAME[N.cheapest]], ['下一课', '结构化输出（API 层）']],
  },
};

