/**
 * 上下文工程组第三课：记忆系统的写入与召回。
 * 上一课那段会话结束时，应用请模型列出值得长期记住的事实（示例，E.G.），写进 /memories/user.md；
 * 几天后的新会话里，core/recall.ts 用 BM25 给每条记忆真实打分，取分数够高的注入 system，用户档案类的条目常驻。
 * 文件的字节、每条记忆的 token 数、每个词的分数、注入了多少 token 都真实计算；模型写的内容是示例。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  countTokens,
  encodeJson,
  planBudget,
  recall,
  renderRequest,
  termsOf,
  type MemoryEntry,
  type MessageParam,
  type MessagesRequest,
  type RenderedPrompt,
  BM25_B,
  BM25_K1,
} from '../core';
import { concept, jsonBody, num, promptPieces, utf8Lines, wire } from '../decode/structures';
import { budgetRow, CITY, factsIn, MODEL, ORDER_ID, SYSTEM, TOOL_SYSTEM_TOKENS, TOOLS } from './agent';
import { WINDOW } from './budget';
import { COMPACTED, REFUND_NO } from './compaction';
import { pct } from './common';
import { note, pk, render, show, state } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 会话结束：抽取 ----------

/** 上一段会话的最后一句回答（示例）。 */
export const FINAL_ANSWER = '超过 3 个工作日还没到账，直接回复我们的短信就行，我们会联系支付宝核查。';
/** 应用在会话结束时发的抽取指令。 */
export const EXTRACT = '会话结束了。请列出这次对话里值得长期记住的、关于这位用户的事实，每行一条；不要记寒暄和工具结果的原文。';
export const extractRequest: MessagesRequest = {
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools: TOOLS,
  messages: [...COMPACTED, { role: 'assistant', content: FINAL_ANSWER }, { role: 'user', content: EXTRACT }],
};
export const extractPrompt = renderRequest(extractRequest);
export const extractInput = extractPrompt.tokens + TOOL_SYSTEM_TOKENS;

/** 记忆条目。id 是展示用的短名；pinned 的是用户档案，每次都注入。 */
export interface Memory extends MemoryEntry {
  name: string;
  pinned?: boolean;
}

/** 以前的会话里已经记下的 4 条。 */
export const EXISTING: Memory[] = [
  { id: 'style', name: '风格', text: '回答风格：喜欢简短的回答。', pinned: true },
  { id: 'kettle', name: '水壶', text: '9 月买过电热水壶（订单 A0877），申请过退款又撤销了，最后给了好评。' },
  { id: 'shoes', name: '鞋', text: '10 月咨询过 42 码的运动鞋，没有下单。' },
  { id: 'coupon', name: '优惠券', text: '有一张满 200 减 20 的优惠券，12 月底到期。' },
];

/** 这次模型抽取出的 3 条（示例：模型写的）。 */
export const EXTRACTED: Memory[] = [
  { id: 'contact', name: '联系', text: '联系方式：只发短信，不要打电话。', pinned: true },
  { id: 'address', name: '地址', text: `收货地址：${CITY}。`, pinned: true },
  { id: 'refund', name: '退款', text: `订单 ${ORDER_ID} 的保温杯杯盖漏水，已全额退款 129 元，退款单 ${REFUND_NO}，原路退回支付宝，1–3 个工作日到账。` },
];

export const extractedText = EXTRACTED.map((item) => item.text).join('\n');
export const extractOutput = countTokens(extractedText);

// ---------- 写进存储 ----------

export const MEMORY_PATH = '/memories/user.md';
const fileOf = (items: readonly Memory[]) => items.map((item) => `- ${item.text}\n`).join('');
export const before = fileOf(EXISTING);
export const MEMORIES: Memory[] = [...EXISTING, ...EXTRACTED];
export const file = fileOf(MEMORIES);
/** 用 memory 工具时，模型会发出这样的 insert 命令（插在第 insert_line 行之后），由应用执行。 */
export const insertCommand = encodeJson({ command: 'insert', path: MEMORY_PATH, insert_line: EXISTING.length, insert_text: fileOf(EXTRACTED) });
export const memTokens = MEMORIES.map((item) => countTokens(item.text));

// ---------- 新会话：召回 ----------

export const QUESTION = '上次那个保温杯的退款到账了吗？我等了三天了。';
export const K = 3;
export const MIN_SCORE = 2;
export const result = recall(MEMORIES, QUESTION, { k: K, min: MIN_SCORE });
export const queryTerms = [...new Set(termsOf(QUESTION))];
const scoreOf = (id: string) => result.ranked.find((item) => item.id === id)!;
export const recalled = result.picked.map((item) => MEMORIES.find((memory) => memory.id === item.id)!);
export const pinned = MEMORIES.filter((item) => item.pinned);
/** 注入的：常驻的档案 + 召回的，按存储里的顺序。 */
export const injected = MEMORIES.filter((item) => item.pinned || recalled.includes(item));
export const missedPinned = pinned.filter((item) => scoreOf(item.id).score === 0);

const block = (items: readonly Memory[]) => `<memory>\n以下是之前会话里记下的用户信息，可能过时，以工具查到的为准：\n${fileOf(items)}</memory>`;
export const MEMORY_BLOCK = block(injected);
export const ALL_BLOCK = block(MEMORIES);

const requestWith = (memoryText: string): MessagesRequest => ({
  model: MODEL,
  max_tokens: 512,
  system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: memoryText }],
  tools: TOOLS,
  messages: [{ role: 'user', content: QUESTION } satisfies MessageParam],
});
export const REQUEST = requestWith(MEMORY_BLOCK);
export const prompt = renderRequest(REQUEST);
export const allPrompt = renderRequest(requestWith(ALL_BLOCK));
export const memoryTokens = prompt.bySource['system[1]'];
export const allTokens = allPrompt.bySource['system[1]'];

function partsOf(rendered: RenderedPrompt) {
  const tools = rendered.bySource.tools;
  const system = rendered.bySource['system[0]'];
  const memory = rendered.bySource['system[1]'];
  const question = rendered.bySource['messages[0].content'];
  return [
    { id: 'tools', label: '工具', kind: 'tools' as const, tokens: tools },
    { id: 'toolSystem', label: '工具提示', kind: 'tools' as const, tokens: TOOL_SYSTEM_TOKENS },
    { id: 'system', label: 'system', kind: 'system' as const, tokens: system },
    { id: 'memory', label: '记忆', kind: 'memory' as const, tokens: memory },
    { id: 'question', label: '问题', kind: 'user' as const, tokens: question },
    { id: 'template', label: '模板', kind: 'template' as const, tokens: rendered.tokens - tools - system - memory - question },
  ];
}
export const plan = planBudget(WINDOW, partsOf(prompt), REQUEST.max_tokens);
export const allPlan = planBudget(WINDOW, partsOf(allPrompt), REQUEST.max_tokens);
export const input = prompt.tokens + TOOL_SYSTEM_TOKENS;

/** 模型的回复（示例）。它用到的退款单号、金额、短信都来自注入的记忆。 */
export const REPLY = `退款单 ${REFUND_NO} 的 129 元是原路退回支付宝的，一般 1–3 个工作日到账，今天是第三天。我先帮您查一下进度，有结果用短信通知您。`;
export const output = countTokens(REPLY);
export const USED_FACTS = [REFUND_NO, '129', '短信'];
export const usedFromMemory = factsIn(REPLY, USED_FACTS).filter((fact) => MEMORY_BLOCK.includes(fact) && !QUESTION.includes(fact));

// ---------- 图元 ----------

/** 存储里的条目：每格一条，写 token 数或分数。 */
function memoryRow(options: { only?: readonly Memory[]; scores?: boolean; picked?: boolean; marks?: RowPrim['marks'] } = {}): RowPrim {
  const list = options.only ?? MEMORIES;
  const max = Math.max(...result.ranked.map((item) => item.score));
  const cells: DsCell[] = list.map((item) => {
    const scored = scoreOf(item.id);
    const isIn = injected.includes(item);
    const tone = options.picked ? (isIn ? 'amber' : 'dim') : EXTRACTED.includes(item) ? 'amber' : 'slate';
    return {
      v: options.scores ? scored.score.toFixed(1) : String(countTokens(item.text)),
      tone,
      sub: item.name,
      key: item.id,
      heat: options.scores ? scored.score / max : undefined,
      lift: (options.picked && isIn) || undefined,
    };
  });
  return { kind: 'row', id: 'mm', w: 50, cells, marks: options.marks };
}

const at = (id: string) => MEMORIES.findIndex((item) => item.id === id);
const nameOf = (id: string) => MEMORIES.find((item) => item.id === id)!.name;

// ---------- 文案用到的数 ----------

const top = result.ranked[0];
const second = result.ranked[1];
const hitText = (hits: typeof top.hits) => hits.map((hit) => `${hit.term}×${hit.tf}`).join('、');

export const numbers = {
  extractInput,
  extractOutput,
  fileBytes: utf8Encode(file).length,
  entries: MEMORIES.length,
  terms: queryTerms.length,
  topScore: top.score,
  secondScore: second.score,
  zero: result.ranked.filter((item) => item.score === 0).length,
  memoryTokens,
  allTokens,
  savedShare: 1 - memoryTokens / allTokens,
  input,
  output,
  afterExtract: extractInput + extractOutput,
};

const N = numbers;
const fmt = (value: number) => value.toFixed(2);
const reasonText = { 'no-overlap': '没有共同的词', 'below-min': `低于阈值 ${MIN_SCORE}`, 'below-k': `排在第 ${K} 名之后` } as const;

// ---------- 课程 ----------

export const memory: Lesson = {
  id: 'memory',
  name: 'MEMORY',
  title: '记忆系统写入与召回',
  group: 'context',
  layer: [5, 7],
  layerNote: '记忆存在应用这一侧（文件或数据库），召回后作为提示的一部分注入上下文，跨越了一次次独立的会话。',
  tokensNote: '会话结束时抽取记忆的那次调用（读入整段会话、写出几条事实），加上新会话里带着记忆的那次请求。',
  nodes: ['app', 'model', 'memory', 'docs', 'window'],
  place: { app: [110, 330], model: [560, 100], memory: [300, 620], docs: [690, 570], window: [880, 300] },
  labels: {
    app: ['应用', '客服 Agent'],
    model: ['模型', 'Claude Opus 5.5'],
    memory: ['记忆存储', MEMORY_PATH],
    docs: ['记忆条目', '每格一条：token 数或分数'],
    window: ['上下文窗口', `新会话，演示窗口 ${num(WINDOW)}`],
  },
  labelAt: { docs: [60, 120], window: [140, -100] },
  radius: { docs: 70, window: 70 },
  initial: { docs: [], window: [] },
  start: ['app', 'model'],
  legend: [['amber', '这次抽取的记忆、注入的记忆'], ['slate', '以前存下的记忆'], ['violet', 'system'], ['blue', '用户的问题'], [null, 'token 列：模型累计读入和写出的 token']],
  overview: {
    full: '对话结束了，事实还在',
    description: `压缩只在一段会话里有效。上一课的会话结束时，应用请模型列出值得长期记住的事实，写进 ${MEMORY_PATH}；几天后用户开了新会话问「${QUESTION}」，应用用 BM25 给 ${N.entries} 条记忆逐条打分，把相关的和常驻的档案注入 system。这一课真实计算文件的字节、每条记忆的 token 数、每个词的分数，以及注入了多少 token、没召回的为什么没召回；模型写的记忆和回复是示例。`,
    facts: [
      ['存储', `${MEMORY_PATH}，${N.entries} 条`],
      ['打分', `BM25（k1 = ${BM25_K1}，b = ${BM25_B}）`],
      ['召回', `分数 ≥ ${MIN_SCORE} 的前 ${K} 条 + 常驻档案`],
      ['注入', `${N.memoryTokens} token（全部注入要 ${N.allTokens}）`],
      ['Anthropic', 'memory 工具 memory_20250818'],
    ],
  },
  steps: [
    {
      title: '会话结束，抽取要记住的事实',
      desc: `读 ${N.extractInput}，写出 ${EXTRACTED.length} 条事实`,
      detail: `会话结束时，应用把这段会话（压缩后的摘要、最近一轮和最后的回答）连同一条抽取指令发给模型：只记关于这位用户、以后还用得上的事实，不记寒暄和工具结果原文。模型读入 ${N.extractInput} 个 token，写出 ${EXTRACTED.length} 条共 ${N.extractOutput} 个 token：联系方式、收货地址、这次退款的结果。抽取是一次额外的调用，记什么由模型判断，所以写进去的内容可能有错，要标明它可能过时。`,
      facts: [['读入', `${N.extractInput} token`], ['写出', `${N.extractOutput} token（内容是示例）`], ['抽到', EXTRACTED.map((item) => item.name).join('、')], ['不记', '寒暄、工具结果原文']],
      events: [
        pk('app', 'model', 'violet', '抽取记忆', [`读 ${N.extractInput} token`, '会话 + 抽取指令'], [N.extractInput, 'MEMORY', `会话结束：把压缩后的会话 + 抽取指令发给模型，读入 ${N.extractInput} token`, utf8Encode(EXTRACT).length],
          wire('抽取请求：最后一条是应用的抽取指令', 'mem', 'internal',
            utf8Lines('抽取指令', EXTRACT, { color: 'blue', summary: `${countTokens(EXTRACT)} 个 token` }),
            promptPieces('抽取请求（ChatML 展开，本站演示）', extractPrompt)),
          { ds: {} }),
        show('docs'),
        pk('model', 'app', 'amber', `${EXTRACTED.length} 条事实`, EXTRACTED.map((item) => item.name), [N.afterExtract, 'MEMORY', `模型写出 ${EXTRACTED.length} 条要记住的事实，${N.extractOutput} token`, utf8Encode(extractedText).length],
          wire('模型写出的事实（示例）', 'mem', 'format', utf8Lines('抽取结果', extractedText, { color: 'amber', summary: `${EXTRACTED.length} 行，${N.extractOutput} 个 token（模型写的内容是示例）`, notes: { 0: '这几行是示例：本站不跑大模型。字节和 token 数是真实计算的。' } })),
          { ds: { docs: [memoryRow({ only: EXTRACTED })] } }),
      ],
    },
    {
      title: '写进外部存储',
      desc: `${MEMORY_PATH}：${N.entries} 条，${N.fileBytes} 字节`,
      detail: `应用把 ${EXTRACTED.length} 条事实追加到 ${MEMORY_PATH} 的末尾，和以前会话记下的 ${EXISTING.length} 条放在一起，每行一条，共 ${N.fileBytes} 字节。记忆存在对话之外：不占任何一次请求的窗口，会话结束、进程重启都还在。Anthropic 的 memory 工具（memory_20250818）是同一个思路：模型发出 view、create、str_replace、insert、delete、rename 命令，由应用对自己的存储执行。`,
      facts: [['文件', MEMORY_PATH], ['条目', `${EXISTING.length} 条旧的 + ${EXTRACTED.length} 条新的`], ['大小', `${N.fileBytes} 字节`], ['写法', `insert，插在第 ${EXISTING.length} 行之后`]],
      events: [
        show('memory'),
        pk('app', 'memory', 'amber', 'insert', [MEMORY_PATH, `+${EXTRACTED.length} 行`], [N.afterExtract, 'MEMORY', `追加 ${EXTRACTED.length} 条到 ${MEMORY_PATH}：共 ${N.entries} 条，${N.fileBytes} 字节`, N.fileBytes],
          wire('写入后的记忆文件', 'mem', 'format',
            utf8Lines(MEMORY_PATH, file, { color: 'amber', summary: `${N.entries} 行，UTF-8`, notes: { [EXISTING.length]: `从这一行起是这次抽取的 ${EXTRACTED.length} 条（示例内容）。` } }),
            jsonBody('等价的 memory 工具命令（insert）', insertCommand, {
              example: ['insert_text'],
              notes: {
                command: 'memory 工具的命令之一：view、create、str_replace、insert、delete、rename。工具在应用这一侧执行，存哪里由应用决定。',
                path: '路径都以 /memories 开头。应用必须校验，拒绝 ../ 这类跳出目录的路径。',
                insert_line: `插在第 ${EXISTING.length} 行之后（0 表示插在最前面）。`,
                insert_text: '要插入的文字（这里是模型抽取的示例内容）。',
              },
            })),
          { ds: { docs: [memoryRow()] } }),
        state('memory', { 文件: 'user.md', 条目: `${N.entries} 条`, 大小: `${N.fileBytes} B` }),
      ],
    },
    {
      title: '新会话：给每条记忆打分',
      desc: `「退款」那条 ${fmt(N.topScore)} 分，${N.zero} 条是 0 分`,
      detail: `几天后用户开了新会话，问上次那个保温杯的退款到账没有。应用把问题切成 ${N.terms} 个词（汉字按相邻两个字切），用 BM25 给 ${N.entries} 条记忆打分：命中的词越稀有、在这条记忆里出现得越多分数越高，记忆越长分数越被摊薄。「${nameOf('refund')}」那条命中 ${hitText(scoreOf('refund').hits)}，得 ${fmt(N.topScore)} 分；「${nameOf(second.id)}」只命中 ${hitText(second.hits)}，得 ${fmt(N.secondScore)}；其余 ${N.zero} 条和问题没有共同的词，都是 0 分。`,
      facts: [['问题', `${N.terms} 个词`], ['最高', `${nameOf('refund')} ${fmt(N.topScore)}`], ['第二', `${nameOf(second.id)} ${fmt(N.secondScore)}`], ['0 分', `${N.zero} 条`]],
      events: [
        pk('app', 'memory', 'blue', '按问题召回', [`「${QUESTION.slice(0, 10)}…」`, `${N.terms} 个词`], [N.afterExtract, 'MEMORY', `新会话的问题切成 ${N.terms} 个词，查 ${MEMORY_PATH} 的 ${N.entries} 条记忆`, utf8Encode(QUESTION).length],
          wire('问题切成的词（二元组）', 'mem', '示意', concept('termsOf(问题)', [
            ['问题', QUESTION],
            ['词', queryTerms.join(' ')],
            ['切法', '汉字按相邻两个字切，英文和数字按词', '中文没有空格，不用词典也能切；代价是会切出「了吗」「天了」这类没意义的词，好在它们在记忆里很少出现。'],
          ])),
          { ds: { docs: [memoryRow({ scores: true })] } }),
        pk('memory', 'docs', 'amber', 'BM25', [`最高 ${fmt(N.topScore)}`, `${N.zero} 条 0 分`], [N.afterExtract, 'MEMORY', `BM25 打分：${result.ranked.map((item) => `${nameOf(item.id)} ${fmt(item.score)}`).join('，')}`, null],
          wire('每条记忆的分数', 'mem', '示意', concept(`BM25（k1 = ${BM25_K1}，b = ${BM25_B}）`, [
            ...result.ranked.map((item): [string, string, string] => [nameOf(item.id), fmt(item.score), item.hits.length ? item.hits.map((hit) => `「${hit.term}」tf ${hit.tf} · idf ${fmt(hit.idf)} · ${fmt(hit.part)}`).join('；') : '没有命中任何词。']),
            ['公式', 'Σ idf · tf · (k1 + 1) / (tf + k1 · (1 − b + b · |D| / avgdl))', 'idf = ln(1 + (N − n + 0.5) / (n + 0.5))。出自 Robertson、Zaragoza 2009 的 BM25 综述；k1、b 是常用的默认值。'],
          ])),
          { ds: { docs: [memoryRow({ scores: true, marks: [{ at: at('refund'), text: `${fmt(N.topScore)} 分`, color: 'amber', dx: 30 }] })] } }),
      ],
    },
    {
      title: '召回、常驻、注入',
      desc: `注入 ${N.memoryTokens} token，全部注入要 ${N.allTokens}`,
      detail: `阈值 ${MIN_SCORE} 分、最多 ${K} 条：只召回了「退款」，「${nameOf(second.id)}」${reasonText['below-min']}。「联系方式：只发短信」得了 0 分，可它恰恰是这次回复必须遵守的：关键词召回只看字面，用户偏好这类和问题无关、却每次都要用的条目，应该做成常驻的档案，每次都注入。最后注入 ${injected.length} 条，占 ${N.memoryTokens} token；把 ${N.entries} 条全塞进去要 ${N.allTokens}，按相关性挑能省 ${pct(N.savedShare)}，记忆越多省得越多。`,
      facts: [['召回', recalled.map((item) => item.name).join('、')], ['常驻', pinned.map((item) => item.name).join('、')], ['没注入', MEMORIES.filter((item) => !injected.includes(item)).map((item) => item.name).join('、')], ['注入', `${N.memoryTokens} / 全部 ${N.allTokens} token`]],
      events: [
        pk('docs', 'app', 'amber', `召回 ${recalled.length} 条`, [`+ 常驻 ${pinned.length} 条`, `注入 ${injected.length} 条`], [N.afterExtract, 'RETRIEVE', `召回 ${recalled.map((item) => item.name).join('、')}，加上常驻的 ${pinned.map((item) => item.name).join('、')}，共 ${injected.length} 条`, utf8Encode(MEMORY_BLOCK).length],
          wire('注入 system 的记忆块', 'mem', 'format',
            utf8Lines('system[1]', MEMORY_BLOCK, { color: 'amber', summary: `${injected.length} 条，${N.memoryTokens} 个 token（标签和说明行是本站的写法）`, notes: { 1: '提醒模型：记忆可能过时，和工具查到的冲突时以工具为准。' } }),
            concept('没注入的和原因', result.skipped.filter(({ entry }) => !injected.some((item) => item.id === entry.id)).map(({ entry, reason }): [string, string, string] => [nameOf(entry.id), `${fmt(entry.score)} 分`, reasonText[reason]]))),
          { ds: { docs: [memoryRow({ scores: true, picked: true, marks: [{ at: at('contact'), text: '0 分，但常驻', color: 'violet', dx: 30 }] })] } }),
        show('window'),
        pk('app', 'window', 'violet', '拆账', [`记忆 ${N.memoryTokens}`, `全部要 ${N.allTokens}`], [N.afterExtract, 'BUDGET', `新会话的请求：记忆 ${N.memoryTokens} token（全部注入 ${N.allTokens}），输入 ${N.input}`, null],
          wire('新会话的预算表', 'mem', '示意', concept('planBudget', [
            ...plan.rows.map((row): [string, string] => [row.label, `${row.tokens} token · ${pct(row.share)}`]),
            ['剩余', `${plan.free} token`],
            ['全部注入时', `记忆 ${N.allTokens}，剩 ${allPlan.free}`],
          ])),
          { ds: { window: [budgetRow('mw', plan, { w: 46, lift: ['memory'] })] } }),
      ],
    },
    {
      title: '带着记忆回答',
      desc: `读入 ${N.input}，写出 ${N.output} 个 token`,
      detail: `模型读入 ${N.input} 个 token，回复里的退款单号、金额、用短信通知，都来自注入的记忆，用户没有再说一遍。这是「推」的做法：应用替模型挑好记忆放进上下文。用 Anthropic 的 memory 工具则是「拉」：API 会在系统提示里加一段说明，让模型开始任务前先 view 记忆目录，读哪些文件由模型自己决定，代价是多几次工具往返。`,
      facts: [['输入', `${N.input} token`], ['输出', `${N.output} token（回复是示例）`], ['来自记忆', usedFromMemory.join('、')], ['memory 工具', '模型先 view /memories']],
      events: [
        show('model'),
        pk('window', 'model', 'violet', `${N.input} token`, ['system + 记忆 + 问题'], [N.afterExtract + N.input, 'INFER', `模型读入 ${N.input} token：展开 ${prompt.tokens} + 工具系统提示 ${TOOL_SYSTEM_TOKENS}`, prompt.bytes.length],
          wire('模型读到的（ChatML 展开，本站演示）', 'mem', 'internal', promptPieces('新会话的 ChatML 文本', prompt, { notes: { 'system[1]': '注入的记忆块：system 的第二个 text 块。' } })),
          { ds: { window: [budgetRow('mw', plan, { w: 46, lift: ['memory', 'question'] })] } }),
        pk('model', 'app', 'green', '回复', [`「${REPLY.slice(0, 12)}…」`, `${N.output} token`], [N.afterExtract + N.input + N.output, 'INFER', `生成 ${N.output} 个 token：用到记忆里的 ${usedFromMemory.join('、')}`, utf8Encode(REPLY).length],
          wire('模型写出的回复（示例）', 'mem', 'format',
            utf8Lines('回复文本', REPLY, { color: 'green', summary: `${[...REPLY].length} 个字符，${N.output} 个 token（模型写的内容是示例）`, notes: { 0: '这段话是示例。它用到的事实来自注入的记忆，这一点按字面核对过。' } }),
            concept('memory 工具（memory_20250818）', [
              ['类型', '{ type: memory_20250818, name: memory }', '整个配置就这一项，不用写 input_schema。'],
              ['执行', '客户端', '模型只请求文件操作，应用对自己的存储执行，结果作为 tool_result 送回。'],
              ['系统提示', 'API 自动加一段', '要求模型开始前先 view 记忆目录，并随时记下进度。'],
              ['安全', '校验路径', '拒绝 /memories/../../ 这类路径；敏感信息写入前可以先过滤。'],
            ])),
          { ds: { docs: [memoryRow({ scores: true, picked: true, marks: usedFromMemory.length ? [{ at: at('refund'), text: '用上：单号、金额', color: 'green', dx: 30 }, { at: at('refund'), text: '用上：短信（常驻）', color: 'green', dx: 30 }] : [] })] } }),
        render,
        note('app', '没再问一遍', 'green'),
      ],
    },
  ],
  outro: {
    title: '记忆是存在窗口外面的上下文',
    desc: `${N.entries} 条记忆，注入 ${N.memoryTokens} token`,
    text: `记忆系统做两件事：会话结束时把值得留下的事实写到对话之外，新会话开始时挑出相关的放回窗口。写入要靠模型判断，可能记错，所以注入时要说明它可能过时；召回按相关性挑，能省下窗口，但关键词打分只看字面，和问题无关却必须遵守的偏好要常驻。记忆、检索到的文档、工具结果一旦进了窗口，就和别的内容一起争夺模型的注意力。下一课看窗口里的内容多了、错了、互相矛盾时，会出什么问题。`,
    facts: [['写入', `${EXTRACTED.length} 条（示例）`], ['召回', `${recalled.length} 条 + 常驻 ${pinned.length} 条`], ['注入', `${N.memoryTokens} token`], ['下一课', '长上下文与上下文失效模式']],
  },
};
