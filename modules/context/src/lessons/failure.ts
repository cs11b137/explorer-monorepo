/**
 * 上下文工程组第四课：长上下文与上下文失效模式。
 * 一次带 12 段检索结果的请求，和一段被写错的订单号污染的对话。真实计算的部分：
 *   - 中段遗忘：关键的一段在展开后的提示里的 token 偏移和相对位置（core/context.ts 的 locate），换到开头、结尾时的位置；
 *   - 干扰：BM25 给 12 段打分，和问题相关的 token 占输入的比例；
 *   - 冲突：factsOf / conflictsOf 从资料里找出同一个键的不同取值；
 *   - 污染：写错的订单号在历史里被复制了几次，ungrounded 找出没有依据的值。
 * 模型会怎样失误无法真实演示，标示例，并注明研究出处（Liu et al. 2023；Hong et al. 2025）。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  bm25,
  conflictsOf,
  countOccurrences,
  countTokens,
  exampleId,
  factsOf,
  locate,
  messageText,
  renderRequest,
  ungrounded,
  type MessageParam,
  type MessagesRequest,
} from '../core';
import { concept, promptPieces, utf8Lines, wire } from '../decode/structures';
import { MODEL, ORDER_ID, SYSTEM, TOOL_SYSTEM_TOKENS, TOOLS, turnOf } from './agent';
import { pct } from './common';
import { note, pk, render, show } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 一次带 12 段检索结果的请求 ----------

export interface Chunk {
  id: string;
  name: string;
  source: string;
  text: string;
}

/** 规则库里取回的 12 段，按它们在规则库里的顺序拼进上下文（数据是示例）。 */
export const CHUNKS: Chunk[] = [
  { id: 'ship', name: '发货', source: '配送说明', text: '发货时间：江浙沪 48 小时内，偏远地区 5 天内。' },
  { id: 'cloth', name: '服装', source: '售后规则 2026 版', text: '服装类退货期限：签收后 7 天，吊牌完好。' },
  { id: 'member', name: '会员', source: '会员说明', text: '会员折扣：下单享 95 折，生日月积分翻倍。' },
  { id: 'old', name: '电器旧', source: '售后规则 2025 版', text: '电器类退货期限：签收后 7 天，包装完好。' },
  { id: 'invoice', name: '发票', source: '发票说明', text: '开票时间：确认收货后 24 小时内开电子发票。' },
  { id: 'key', name: '电器', source: '售后规则 2026 版', text: '电器类退货期限：签收后 15 天，包装完好。' },
  { id: 'freight', name: '运费', source: '运费说明', text: '退货运费：非质量问题由买家承担。' },
  { id: 'food', name: '食品', source: '售后规则 2026 版', text: '食品类退货：拆封后不支持无理由退货。' },
  { id: 'refund', name: '到账', source: '退款说明', text: '到账时间：支付宝 1–3 个工作日，银行卡 3–7 个工作日。' },
  { id: 'tradein', name: '以旧换新', source: '以旧换新', text: '旧电器折价：最高 100 元，限大家电。' },
  { id: 'price', name: '价保', source: '价保说明', text: '价保期限：签收后 7 天内降价可申请补差。' },
  { id: 'hours', name: '客服', source: '客服时间', text: '在线时间：每天 9:00–21:00。' },
];
export const chunkText = (chunk: Chunk): string => `《${chunk.source}》${chunk.text}`;
export const QUESTION = '我买的电热水壶签收 10 天了，还能退货吗？';
/** 回答这个问题真正需要的那句。 */
export const KEY_TEXT = '电器类退货期限：签收后 15 天';
export const KEY = CHUNKS.findIndex((chunk) => chunk.id === 'key');

const requestOf = (chunks: readonly Chunk[]): MessagesRequest => ({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools: TOOLS,
  messages: [{ role: 'user', content: [...chunks.map((chunk) => ({ type: 'text' as const, text: chunkText(chunk) })), { type: 'text', text: QUESTION }] }],
});

export const REQUEST = requestOf(CHUNKS);
export const prompt = renderRequest(REQUEST);
export const input = prompt.tokens + TOOL_SYSTEM_TOKENS;
export const chunkTokens = CHUNKS.map((_, i) => prompt.bySource[`messages[0].content[${i}]`]);
export const docsTokens = chunkTokens.reduce((sum, value) => sum + value, 0);

/** 关键的一句在哪里：按原顺序（中间）、挪到最前、挪到最后。 */
export const where = locate(prompt, KEY_TEXT);
const moved = (to: number) => {
  const list = CHUNKS.filter((chunk) => chunk.id !== 'key');
  list.splice(to, 0, CHUNKS[KEY]);
  return locate(renderRequest(requestOf(list)), KEY_TEXT);
};
export const atFirst = moved(0);
export const atLast = moved(CHUNKS.length - 1);

// ---------- 干扰 ----------

export const scores = bm25(CHUNKS.map((chunk) => ({ id: chunk.id, text: chunkText(chunk) })), QUESTION);
export const keyScore = scores[KEY].score;
/** 和关键的一段同分的段（字面上一样像）。 */
export const ties = scores.filter((item) => item.score === keyScore).map((item) => CHUNKS.find((chunk) => chunk.id === item.id)!);
export const zero = scores.filter((item) => item.score === 0).length;
export const keyShare = chunkTokens[KEY] / input;

// ---------- 冲突 ----------

export const facts = CHUNKS.flatMap((chunk) => factsOf(chunk.text, chunk.source));
export const conflicts = conflictsOf(facts);
export const conflict = conflicts[0];
/** 解决办法之一：取版本年份最新的来源。 */
const yearOf = (source: string) => Number(/(\d{4}) 版/.exec(source)?.[1] ?? 0);
export const resolved = [...conflict.values].sort((a, b) => Math.max(...b.sources.map(yearOf)) - Math.max(...a.sources.map(yearOf)))[0];

// ---------- 污染 ----------

export const WRONG = 'A1042';
const REFUND_USE = exampleId('toolu', 15);
/** 一段对话：助手第一次回复就把订单号写错了（示例，模型的失误），之后一直沿用。 */
export const POLLUTED: MessageParam[] = [
  { role: 'user', content: `你好，订单 ${ORDER_ID} 的保温杯杯盖漏水，想退款。` },
  { role: 'assistant', content: `抱歉！我看一下订单 ${WRONG} 的情况。` },
  { role: 'user', content: '好的，麻烦快点。' },
  { role: 'assistant', content: `订单 ${WRONG} 符合质量问题退款的条件，可以全额退款 129 元，确认吗？` },
  { role: 'user', content: '确认，退吧。' },
  { role: 'assistant', content: [{ type: 'text', text: `好的，现在为订单 ${WRONG} 办理退款。` }, { type: 'tool_use', id: REFUND_USE, name: 'refund', input: { order_id: WRONG, amount: 129 } }] },
];
/** 每次请求（每条用户消息之后）上下文里有几份错的、几份对的订单号。 */
export const pollutionRequests = POLLUTED.flatMap((message, i) => (message.role === 'user' ? [i] : [])).map((i) => {
  const context = POLLUTED.slice(0, i + 1);
  const text = context.map(messageText).join('\n');
  return {
    at: i,
    input: renderRequest({ ...REQUEST, messages: context }).tokens + TOOL_SYSTEM_TOKENS,
    output: countTokens(turnOf(POLLUTED[i + 1]).text),
    wrong: countOccurrences(text, WRONG),
    right: countOccurrences(text, ORDER_ID),
  };
});
export const finalWrong = countOccurrences(POLLUTED.map(messageText).join('\n'), WRONG);
export const flagged = ungrounded(POLLUTED, /A\d{4}/);
export const pollutionTokens = pollutionRequests.reduce((sum, item) => sum + item.input + item.output, 0);

// ---------- 对策 ----------

/** 去掉 0 分的段和被新版本取代的旧版本，按分数从低到高排，最相关的挨着问题。 */
export const cleanedChunks = CHUNKS.map((chunk, i) => ({ chunk, score: scores[i].score, i }))
  .filter(({ chunk, score }) => score > 0 && !(conflict.values.some((value) => value !== resolved && value.sources.includes(chunk.source)) && factsOf(chunk.text, chunk.source).some((fact) => fact.key === conflict.key)))
  .sort((a, b) => a.score - b.score || a.i - b.i)
  .map(({ chunk }) => chunk);
export const cleanedRequest = requestOf(cleanedChunks);
export const cleanedPrompt = renderRequest(cleanedRequest);
export const cleanedInput = cleanedPrompt.tokens + TOOL_SYSTEM_TOKENS;
export const cleanedWhere = locate(cleanedPrompt, KEY_TEXT);

/** 清理后模型的回复（示例）。 */
export const REPLY = '可以退。按《售后规则 2026 版》，电器类签收后 15 天内、包装完好可以退货，您签收 10 天，还在期限内。';
export const output = countTokens(REPLY);

// ---------- 图元 ----------

function chunksRow(options: { list?: readonly Chunk[]; scores?: boolean; marks?: RowPrim['marks']; dim?: string[]; lift?: string[] } = {}): RowPrim {
  const list = options.list ?? CHUNKS;
  const max = Math.max(...scores.map((item) => item.score));
  const cells: DsCell[] = list.map((chunk) => {
    const i = CHUNKS.indexOf(chunk);
    return {
      v: options.scores ? scores[i].score.toFixed(1) : String(chunkTokens[i]),
      tone: options.dim?.includes(chunk.id) ? 'dim' : chunk.id === 'key' ? 'green' : 'amber',
      sub: chunk.name,
      key: chunk.id,
      heat: options.scores ? scores[i].score / max : undefined,
      lift: options.lift?.includes(chunk.id) || undefined,
    };
  });
  return { kind: 'row', id: 'ck', w: 40, cells, marks: options.marks };
}

const ID_OF = (message: MessageParam) => (messageText(message).includes(WRONG) ? WRONG : messageText(message).includes(ORDER_ID) ? ORDER_ID : '—');
function pollutedRow(upTo: number, options: { marks?: RowPrim['marks']; flag?: boolean } = {}): RowPrim {
  const cells: DsCell[] = POLLUTED.slice(0, upTo).map((message, i) => {
    const id = ID_OF(message);
    return { v: id, tone: id === WRONG ? 'amber' : message.role === 'assistant' ? 'green' : 'blue', sub: message.role === 'assistant' ? '助手' : '用户', key: `p${i}`, lift: (options.flag && id === WRONG) || undefined };
  });
  return { kind: 'row', id: 'pl', w: 52, cells, marks: options.marks };
}

const at = (id: string) => CHUNKS.findIndex((chunk) => chunk.id === id);
const share = (value: number) => pct(value);

// ---------- 文案用到的数 ----------

const afterRead = input;
const afterPollution = afterRead + pollutionTokens;

export const numbers = {
  chunks: CHUNKS.length,
  input,
  docsTokens,
  keyIndex: KEY + 1,
  keyToken: where.token,
  rendered: prompt.tokens,
  keyPosition: where.share,
  firstPosition: atFirst.share,
  lastPosition: atLast.share,
  keyTokens: chunkTokens[KEY],
  keyShare,
  keyScore,
  ties: ties.length,
  zero,
  finalWrong,
  pollutionTokens,
  cleanedChunks: cleanedChunks.length,
  cleanedInput,
  cleanedPosition: cleanedWhere.share,
  output,
};

const N = numbers;

// ---------- 课程 ----------

export const failure: Lesson = {
  id: 'failure',
  name: 'FAILURE',
  title: '长上下文与上下文失效模式（中段遗忘、污染、冲突）',
  group: 'context',
  layer: [5, 6],
  layerNote: '问题出在窗口里装了什么、按什么顺序装：位置、比例、矛盾、错误的复制都是在展开后的提示上算出来的。',
  tokensNote: '模型读入带 12 段检索结果的请求，被污染的那段对话里每次请求的读入和写出，以及清理后的请求和回复。',
  nodes: ['app', 'store', 'docs', 'model', 'messages', 'tools'],
  place: { app: [330, 110], store: [110, 330], docs: [420, 430], model: [850, 150], messages: [770, 640], tools: [1000, 430] },
  labels: {
    app: ['应用', '客服 Agent'],
    store: ['检索库', '店铺规则文档'],
    docs: ['检索到的段落', '每格写 token 数或分数'],
    model: ['模型', 'Claude Opus 5.5'],
    messages: ['另一段对话', '每格一条，写提到的订单号'],
    tools: ['工具执行端', 'refund'],
  },
  labelAt: { docs: [-150, 150], messages: [-220, 40] },
  radius: { docs: 70, messages: 66 },
  initial: { docs: [], messages: [] },
  start: ['app', 'store', 'docs'],
  legend: [['amber', '检索片段、被复制的错误值'], ['green', '关键的那一段、助手的话'], ['blue', '用户的话'], [null, 'token 列：模型累计读入和写出的 token']],
  overview: {
    full: '装得下，不等于用得好',
    description: `窗口装得下，模型也不一定用得好。这一课看四种常见的失效：关键的一段埋在 ${N.chunks} 段检索结果的中间；无关的段落稀释了真正有用的那 ${N.keyTokens} 个 token；新旧两版规则互相矛盾；一个写错的订单号进了历史，被一轮轮复制下去。位置、比例、冲突项、复制次数都在展开后的提示上真实计算；模型会怎样失误无法真实演示，标为示例并注明研究出处。`,
    facts: [
      ['检索结果', `${N.chunks} 段，${N.docsTokens} token`],
      ['关键的一段', `第 ${N.keyIndex} 段，位于 ${share(N.keyPosition)}`],
      ['相关的比例', share(N.keyShare)],
      ['冲突', `${conflict.key}：${conflict.values.map((value) => value.value).join(' / ')}`],
      ['污染', `错的订单号复制了 ${N.finalWrong} 次`],
    ],
  },
  steps: [
    {
      title: '中段遗忘：关键的一段在中间',
      desc: `第 ${N.keyIndex} 段，从第 ${N.keyToken} 个 token 开始，位于 ${share(N.keyPosition)}`,
      detail: `用户问「电热水壶签收 10 天还能退吗」，检索库取回 ${N.chunks} 段，按规则库里的顺序拼在问题前面，真正有答案的「${KEY_TEXT}」是第 ${N.keyIndex} 段，从展开后第 ${N.keyToken} 个 token 开始，在整个提示 ${N.rendered} 个 token 的 ${share(N.keyPosition)} 处。Liu 等人 2023 年的「Lost in the Middle」在多文档问答和键值检索上测得：相关信息在输入的开头或结尾时模型表现最好，在中间时明显下降。挪到最前它在 ${share(N.firstPosition)}，挪到紧挨问题的最后在 ${share(N.lastPosition)}，位置是可以算、也可以改的。`,
      facts: [['关键的一段', `第 ${N.keyIndex} / ${N.chunks} 段`], ['起点', `第 ${N.keyToken} 个 token（共 ${N.rendered}）`], ['挪到最前', share(N.firstPosition)], ['挪到最后', share(N.lastPosition)]],
      events: [
        pk('store', 'docs', 'amber', `取回 ${N.chunks} 段`, [`${N.docsTokens} token`, '按规则库顺序'], [0, 'RETRIEVE', `检索库取回 ${N.chunks} 段，共 ${N.docsTokens} token，按规则库里的顺序拼接`, utf8Encode(CHUNKS.map(chunkText).join('\n')).length],
          wire('取回的 12 段（数据是示例）', 'mem', 'format', utf8Lines('检索结果', CHUNKS.map(chunkText).join('\n'), { color: 'amber', summary: `${N.chunks} 段，UTF-8`, notes: { [KEY]: '有答案的就是这一段。' } })),
          { ds: { docs: [chunksRow()] } }),
        show('model'),
        pk('docs', 'model', 'violet', `${N.input} token`, [`关键的一段在 ${share(N.keyPosition)}`], [N.input, 'INFER', `模型读入 ${N.input} token；「${KEY_TEXT}」从第 ${N.keyToken} 个 token 开始，位于 ${share(N.keyPosition)}`, prompt.bytes.length],
          wire('模型读到的（ChatML 展开，本站演示）', 'mem', 'internal',
            promptPieces('ChatML 文本', prompt, { notes: { [`messages[0].content[${KEY}]`]: `关键的一段：字节偏移 ${where.byte}，第 ${where.token} 个 token。` } }),
            concept('同一段放在不同位置', [
              ['原顺序（第 6 段）', `第 ${where.token} 个 token · ${share(where.share)}`, '位置按展开后的提示算；工具系统提示的位置不公开，不计在内。'],
              ['挪到最前', `第 ${atFirst.token} 个 token · ${share(atFirst.share)}`, '前面还有工具定义和 system，所以「最前」也不是 0%。'],
              ['挪到最后', `第 ${atLast.token} 个 token · ${share(atLast.share)}`, '紧挨着问题。'],
              ['研究', 'Liu et al. 2023，Lost in the Middle', '多文档问答、键值检索：相关信息在开头或结尾时表现最好，在中间时明显下降（arXiv 2307.03172，TACL）。模型这一次会不会答错，本站无法真实演示。'],
            ])),
          { ds: { docs: [chunksRow({ lift: ['key'], marks: [{ at: KEY, text: `第 ${N.keyToken} 个 token · ${share(N.keyPosition)}`, color: 'green', dx: 40 }] })] } }),
      ],
    },
    {
      title: '干扰：无关的段落稀释了有用的',
      desc: `有用的 ${N.keyTokens} token 只占 ${share(N.keyShare)}`,
      detail: `${N.chunks} 段里只有一段回答了问题，它的 ${N.keyTokens} 个 token 只占输入的 ${share(N.keyShare)}。用 BM25 按问题给 ${N.chunks} 段打分，${N.zero} 段是 0 分，可关键的一段只有 ${N.keyScore.toFixed(2)} 分，和「${ties.filter((chunk) => chunk.id !== 'key').map((chunk) => chunk.name).join('」「')}」两段同分：问题说的是「电热水壶」，规则写的是「电器类」，字面上分不出服装和电器。Chroma 的 Hong 等人 2025 年的报告（Context Rot）发现，哪怕只加一个干扰项表现就会下降，加到四个更糟；输入越长，表现也越差。`,
      facts: [['相关的', `1 段，${N.keyTokens} token（${share(N.keyShare)}）`], ['0 分', `${N.zero} 段`], ['同分', ties.map((chunk) => chunk.name).join('、')], ['研究', 'Hong et al. 2025，Context Rot']],
      events: [
        pk('app', 'docs', 'amber', 'BM25 打分', [`${N.zero} 段 0 分`, `${N.ties} 段同分 ${N.keyScore.toFixed(2)}`], [N.input, 'RETRIEVE', `按问题打分：${N.zero} 段 0 分，「电器」和 ${ties.length - 1} 段干扰项同为 ${N.keyScore.toFixed(2)} 分`, null],
          wire('每段的分数', 'mem', '示意', concept('BM25（问题 vs 每段）', [
            ...CHUNKS.map((chunk, i): [string, string, string?] => [chunk.name, scores[i].score.toFixed(2), scores[i].hits.length ? scores[i].hits.map((hit) => `「${hit.term}」×${hit.tf}`).join(' ') : undefined]),
            ['研究', 'Hong, Troynikov, Huber 2025（Chroma）', '一个干扰项就会降低表现，四个更糟；在简单任务上，输入越长表现也越差。'],
          ])),
          { ds: { docs: [chunksRow({ scores: true, lift: ties.map((chunk) => chunk.id), marks: [{ at: KEY, text: `同分 ${N.keyScore.toFixed(2)}`, color: 'green', dx: 40 }] })] } }),
        note('docs', `有用的只占 ${share(N.keyShare)}`, 'amber'),
      ],
    },
    {
      title: '冲突：两版规则互相矛盾',
      desc: `${conflict.key}：${conflict.values.map((value) => value.value.split('，')[0]).join(' 对 ')}`,
      detail: `把每段里「键：值」形式的条目抽出来，按键分组：「${conflict.key}」出现了两个不同的值，「${conflict.values[0].value}」来自《${conflict.values[0].sources.join('》《')}》，「${conflict.values[1].value}」来自《${conflict.values[1].sources.join('》《')}》。用户签收 10 天，按旧版不能退，按新版能退，两段同时在上下文里，模型按哪一段回答都说得通（这里不演示模型的选择）。冲突要在放进上下文之前解决：按版本取新的，或者把来源和日期一起标出来，让模型能分辨。`,
      facts: [['冲突的键', conflict.key], ['旧版', conflict.values.find((value) => value !== resolved)!.value], ['新版', resolved.value], ['取', `《${resolved.sources.join('》《')}》`]],
      events: [
        pk('docs', 'app', 'amber', '发现冲突', [conflict.key, `${conflict.values.length} 个取值`], [N.input, 'RETRIEVE', `factsOf + conflictsOf：${facts.length} 个条目里，「${conflict.key}」有 ${conflict.values.length} 个不同的值`, utf8Encode([CHUNKS[at('old')], CHUNKS[KEY]].map(chunkText).join('\n')).length],
          wire('互相矛盾的两段', 'mem', 'format',
            utf8Lines('两段原文', [CHUNKS[at('old')], CHUNKS[KEY]].map(chunkText).join('\n'), { color: 'amber', summary: '同一个键，两个值' }),
            concept('conflictsOf(factsOf(…))', [
              ['抽出的条目', `${facts.length} 个`, '每段里「键：值」形式的一行算一个条目。'],
              ...conflict.values.map((value): [string, string, string] => [conflict.key, value.value, `来源：${value.sources.join('、')}`]),
              ['按版本取新的', resolved.value, '这条规则是本课应用自己定的；规则库没有版本信息时，只能把来源都标出来，或者问人。'],
            ])),
          { ds: { docs: [chunksRow({ lift: ['old', 'key'], marks: [{ at: at('old'), text: '7 天', color: 'amber', dx: 30 }, { at: KEY, text: '15 天', color: 'green', dx: 30 }] })] } }),
      ],
    },
    {
      title: '污染：错的订单号被一轮轮复制',
      desc: `${WRONG} 进了历史，复制到 ${N.finalWrong} 份`,
      detail: `另一段对话里，用户说的是 ${ORDER_ID}，助手第一次回复就写成了 ${WRONG}（示例：模型的失误）。这句话从此留在历史里，每次请求都被模型再读一遍，它跟着自己写过的话往下说：到第三次请求时上下文里已经有 ${pollutionRequests[pollutionRequests.length - 1].wrong} 份 ${WRONG}，对的 ${ORDER_ID} 只有 ${pollutionRequests[pollutionRequests.length - 1].right} 份，最后 refund 的参数也成了 ${WRONG}。错误一旦进了上下文，就会被当成事实反复引用：它在历史里越来越多，对的那一份始终只有一份。`,
      facts: pollutionRequests.map((item, k): [string, string] => [`请求 ${k + 1}`, `${WRONG} ×${item.wrong}，${ORDER_ID} ×${item.right}`]).concat([['refund 参数', WRONG]]),
      events: [
        show('messages'),
        ...pollutionRequests.map((item, k) => pk(k ? 'messages' : 'app', 'model', 'violet', `请求 ${k + 1}`, [`${WRONG} ×${item.wrong}`, `${ORDER_ID} ×${item.right}`], [afterRead + pollutionRequests.slice(0, k).reduce((sum, other) => sum + other.input + other.output, 0) + item.input, 'INFER', `请求 ${k + 1}：读入 ${item.input} token，上下文里 ${WRONG} ×${item.wrong}、${ORDER_ID} ×${item.right}`, utf8Encode(POLLUTED.slice(0, item.at + 1).map(messageText).join('\n')).length],
          wire(`请求 ${k + 1} 的历史`, 'mem', 'format', utf8Lines('历史里的文字', POLLUTED.slice(0, item.at + 1).map(messageText).join('\n'), { color: 'blue', summary: `${item.at + 1} 条消息（助手说的话是示例）`, notes: k ? { 1: `${WRONG}：助手第一次就写错了，之后一直沿用。` } : {} })),
          { ds: { messages: [pollutedRow(item.at + 1, { marks: item.wrong ? [{ at: 1, text: `${WRONG} ×${item.wrong}`, color: 'amber', dx: 30 }] : undefined })] } })),
        show('tools'),
        pk('model', 'tools', 'amber', `refund(${WRONG})`, [`order_id: ${WRONG}`, 'amount: 129'], [afterPollution, 'TOOL', `助手调用 refund，参数里的订单号是 ${WRONG}：错误一路传到了工具`, utf8Encode(JSON.stringify({ order_id: WRONG, amount: 129 })).length],
          wire('refund 的 tool_use（示例）', 'mem', 'format', utf8Lines('input', JSON.stringify({ order_id: WRONG, amount: 129 }), { color: 'amber', summary: '模型写的参数（示例）' })),
          { ds: { messages: [pollutedRow(POLLUTED.length, { flag: true, marks: [{ at: POLLUTED.length - 1, text: `refund(${WRONG})`, color: 'amber', dx: 30 }] })] } }),
      ],
    },
    {
      title: '对策：核对来源、清理、重排',
      desc: `${N.chunks} 段 → ${N.cleanedChunks} 段，关键的一段移到 ${share(N.cleanedPosition)}`,
      detail: `污染要在动手之前拦住：ungrounded 找出助手说过、却从没在用户消息或工具结果里出现的值，${flagged.map((item) => item.value).join('、')} 被标出，refund 先不执行，回头和用户核对。检索结果去掉 0 分的段和被新版取代的旧版，从 ${N.chunks} 段剩 ${N.cleanedChunks} 段，按分数从低到高排，最相关的挨着问题：输入从 ${N.input} 降到 ${N.cleanedInput}，关键的一段移到 ${share(N.cleanedPosition)}。窗口里少一点、准一点，模型读到的就更像它该读的。`,
      facts: [['没有依据的值', flagged.map((item) => `${item.value}（${item.messages.length} 条助手消息）`).join('、')], ['检索结果', `${N.chunks} → ${N.cleanedChunks} 段`], ['输入', `${N.input} → ${N.cleanedInput}`], ['关键的一段', `${share(N.keyPosition)} → ${share(N.cleanedPosition)}`]],
      events: [
        pk('app', 'messages', 'amber', '核对来源', [`${WRONG} 没有依据`, 'refund 暂缓'], [afterPollution, 'TOOL', `ungrounded：${flagged.map((item) => item.value).join('、')} 只出现在助手消息里，拦下 refund`, null],
          wire('ungrounded(messages, /A\\d{4}/)', 'mem', '示意', concept('助手说过、却没有依据的值', [
            ...flagged.map((item): [string, string, string] => [item.value, `messages[${item.messages.join('], [')}]`, '用户说的和工具返回的都没有它：是模型自己写出来的。']),
            [ORDER_ID, '用户消息里有', '有依据。'],
            ['做法', '先核对，再动手', '涉及退款这类不可逆的操作，参数要能在用户输入或工具结果里找到出处。'],
          ])),
          { ds: { messages: [pollutedRow(POLLUTED.length, { flag: true, marks: [{ at: 1, text: '没有依据', color: 'amber', dx: 30 }] })] } }),
        pk('app', 'docs', 'green', '清理、重排', [`${N.chunks} → ${N.cleanedChunks} 段`, `关键的在 ${share(N.cleanedPosition)}`], [afterPollution, 'RETRIEVE', `去掉 ${N.zero} 段 0 分和 1 段旧版，剩 ${N.cleanedChunks} 段，按分数从低到高排`, null],
          wire('清理后的检索结果', 'mem', '示意', concept('清理和重排', [
            ['去掉', `${N.zero} 段 0 分 + 旧版「${conflict.key}」`],
            ['剩下', cleanedChunks.map((chunk) => chunk.name).join('、')],
            ['顺序', '分数从低到高', '最相关的放在最后，挨着问题。'],
            ['关键的一段', `第 ${cleanedWhere.token} 个 token · ${share(cleanedWhere.share)}`],
          ])),
          { ds: { docs: [chunksRow({ list: cleanedChunks, lift: ['key'], marks: [{ at: cleanedChunks.length - 1, text: share(N.cleanedPosition), color: 'green', dx: 30 }] })] } }),
        pk('docs', 'model', 'violet', `${N.cleanedInput} token`, [`${N.cleanedChunks} 段 + 问题`], [afterPollution + N.cleanedInput, 'INFER', `模型读入清理后的 ${N.cleanedInput} token（原来 ${N.input}）`, cleanedPrompt.bytes.length],
          wire('清理后的提示（ChatML 展开，本站演示）', 'mem', 'internal', promptPieces('ChatML 文本', cleanedPrompt)),
          { ds: { docs: [chunksRow({ list: cleanedChunks, lift: ['key'] })] } }),
        pk('model', 'app', 'green', '回复', [`「${REPLY.slice(0, 10)}…」`, `${N.output} token`], [afterPollution + N.cleanedInput + N.output, 'INFER', `生成 ${N.output} 个 token：按新版规则回答`, utf8Encode(REPLY).length],
          wire('模型写出的回复（示例）', 'mem', 'format', utf8Lines('回复文本', REPLY, { color: 'green', summary: `${[...REPLY].length} 个字符，${N.output} 个 token（模型写的内容是示例）` })),
          { ds: { docs: [chunksRow({ list: cleanedChunks, marks: [{ at: cleanedChunks.length - 1, text: '按这一段回答', color: 'green', dx: 30 }] })] } }),
        render,
      ],
    },
  ],
  outro: {
    title: '窗口里的每一段都在争夺注意力',
    desc: `${N.input} → ${N.cleanedInput} token，关键的一段 ${share(N.keyPosition)} → ${share(N.cleanedPosition)}`,
    text: `长上下文的问题不只是放不放得下。关键信息埋在中间、被一堆字面相似的段落包围、和另一段资料互相矛盾、或者被一个早先写错的值带偏，模型都可能答错。这些模型行为本站没法真实演示，但它们的前提都能在提示上算出来：关键的一段在第几个 token、占多大比例、哪两段冲突、错的值被复制了几次。所以上下文工程的大半功夫在放进去之前：过滤、去重、解决冲突、核对出处、把要紧的放在显眼的位置。下一课看最后一招：把子任务放进单独的上下文，以及怎样防住混进上下文的恶意指令。`,
    facts: [['中段', `${share(N.keyPosition)} → ${share(N.cleanedPosition)}`], ['干扰', `相关的只占 ${share(N.keyShare)}`], ['冲突', conflict.key], ['下一课', '上下文隔离与上下文安全']],
  },
};

