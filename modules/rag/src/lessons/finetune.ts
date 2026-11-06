/**
 * 流水线组第六课（全课最后一课）：RAG 和微调怎么选。概念为主，能算的都算：
 * - 知识更新：改一条退款规则，RAG 只要重嵌入一段（请求、响应、向量的字节由 core/api.ts 真实编码），旧段标 archived，检索立刻用上新规则；
 *   微调要把规则写成训练样本重新训练（本站不编训练费用，链接 LLM EXPLORER 的 LoRA 课）。
 * - 可溯源：RAG 的回答带来源编号，checkCitations 能逐句核对；微调后的模型没有来源，全部是 uncited。
 * - 每次请求的上下文：RAG 的提示比只带问题多出的 token（本站 BPE 真实计数），按 CONTEXT EXPLORER 核对过的示例单价折算。
 * - 风格和格式：写在提示里每次都要带，训练进权重就不用。
 *
 * 修订后的规则、模型的回答、训练样本是示例（E.G.）。tests/narrative.pipeline-b.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  buildPrompt,
  checkCitations,
  countTokens,
  DistanceMeter,
  embed,
  embeddingsHttpRequest,
  embeddingsHttpResponse,
  embeddingsResponse,
  exampleRequestId,
  filteredSearch,
  OPENAI_EMBED_MODEL,
  PARAGRAPHS,
  PARAGRAPH_VECTORS,
  type EmbeddingsRequest,
  type Passage,
} from '../core';
import { concept, floatVector, httpHead, jsonBody, num, promptParts, thousands, utf8Lines, utf8Text, wire } from '../decode/structures';
import type { LayerWriter } from '../decode/writer';
import { fixed, PART_TONE } from './common';
import { note, pk, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim, TowerPrim } from './types';

// ---------- 改一条规则 ----------

export const OLD_ID = 'refund#0';
const OLD = PARAGRAPHS.find((p) => p.id === OLD_ID)!;
/** 修订后的《退款说明》（示例）：银行卡到账从 3–7 个工作日改成 2–5 个工作日。 */
export const NEW_TEXT = '《退款说明》：退款原路退回，支付宝 1–3 个工作日到账，银行卡 2–5 个工作日。';
export const NEW_ID = 'refund#0@2026-12';
export const QUESTION = '退到银行卡要多久？';

/** 只嵌入改了的这一段：嵌入模型不变，用的还是全站那个模型。 */
const newTrace = embed(NEW_TEXT);
export const REQUEST: EmbeddingsRequest = { input: NEW_TEXT, model: OPENAI_EMBED_MODEL, dimensions: newTrace.vector.length, encoding_format: 'float' };
export const http = embeddingsHttpRequest(REQUEST);
export const httpResponse = embeddingsHttpResponse(embeddingsResponse([newTrace.vector], REQUEST), exampleRequestId(7));

/** 入库后：原来的 27 个向量加新的一个；旧的 refund#0 标成 archived，和《退款说明（2025 版）》一样留在库里但被过滤掉。 */
export const vectors = [...PARAGRAPH_VECTORS, newTrace.vector];
export const ids = [...PARAGRAPHS.map((p) => p.id), NEW_ID];
const status = [...PARAGRAPHS.map((p) => (p.id === OLD_ID ? 'archived' : p.meta.status)), 'current'];
const textOf = (i: number): string => (i === PARAGRAPHS.length ? NEW_TEXT : PARAGRAPHS[i].text);
const isCurrent = (i: number): boolean => status[i] === 'current';

export const meter = new DistanceMeter();
const qVector = embed(QUESTION).vector;
export const check = filteredSearch(vectors, qVector, 3, isCurrent, 'pre', 'ip', meter);
export const dist1 = meter.total;

// ---------- 一次请求：RAG 和微调后的模型 ----------

/** 一次真实的请求：再检索一次，拼提示。 */
export const request = filteredSearch(vectors, qVector, 3, isCurrent, 'pre', 'ip', meter);
export const dist3 = meter.total;
const passages: Passage[] = request.hits.map((hit) => (hit.id === PARAGRAPHS.length ? { id: OLD_ID, title: OLD.title, text: NEW_TEXT } : PARAGRAPHS[hit.id]));
export const prompt = buildPrompt(QUESTION, passages);

/** 回答（示例）：RAG 的带来源编号；微调后的模型说同样的话，但没有来源可标。 */
export const RAG_ANSWER = '退款原路退回，银行卡 2–5 个工作日到账 [1]。';
export const TUNED_ANSWER = '退款原路退回，银行卡 2–5 个工作日到账。';
export const ragCheck = checkCitations(RAG_ANSWER, prompt.sources);
export const tunedCheck = checkCitations(TUNED_ANSWER, prompt.sources);

/** 微调用的训练样本（示例）：一问一答，规则写进答案里。 */
export const TRAIN_SAMPLE = `问题：${QUESTION}\n回答：${TUNED_ANSWER}`;

// ---------- 每次请求的成本 ----------

/** 微调后的模型只需要问题本身。 */
export const tunedTokens = countTokens(QUESTION);
export const extraTokens = prompt.tokens - tunedTokens;
/** 假设的请求量，只为把每次的差额放大来看。 */
export const REQUESTS = 1000;
/** CONTEXT EXPLORER 核对过的示例单价：Claude Opus 5.5 输入每百万 token 4 美元（2026-11-06，platform.claude.com 的价格页）。 */
export const PRICE_PER_MTOK = 4;
export const PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const extraCost = (extraTokens * REQUESTS * PRICE_PER_MTOK) / 1e6;

// ---------- 风格和格式 ----------

export const FORMAT = '回答分三行写：第一行「结论：」一句话，第二行「依据：」写规则和来源编号，第三行「下一步：」告诉用户要做什么。语气像店员，不用敬语套话。';
export const FORMAT_EXAMPLE = '示例\n问题：发票怎么开？\n结论：下单时填抬头和税号就能开电子发票。\n依据：《发票说明》[1]。\n下一步：发货后 24 小时内去邮箱查收。';
export const formatPrompt = buildPrompt(QUESTION, passages, `${prompt.parts[0].text}\n${FORMAT}\n${FORMAT_EXAMPLE}`);
export const formatTokens = formatPrompt.tokens - prompt.tokens;
/** 按格式写的回答（示例）。 */
export const FORMATTED = `结论：银行卡退款 2–5 个工作日到账。\n依据：《退款说明》[1]。\n下一步：审核通过后留意银行卡入账。`;
export const formattedCheck = checkCitations(FORMATTED, formatPrompt.sources);

// ---------- 文案用到的数 ----------

const kbText = PARAGRAPHS.map((p) => p.text).join('\n');
export const numbers = {
  paragraphs: PARAGRAPHS.length,
  newBytes: utf8Encode(NEW_TEXT).length,
  kbBytes: utf8Encode(kbText).length,
  requestBytes: http.layout.bytes.length,
  responseBytes: httpResponse.layout.bytes.length,
  vectorBytes: newTrace.vector.length * 4,
  current: check.allowed.length,
  newScore: check.hits[0].score,
  promptTokens: prompt.tokens,
  sourceTokens: prompt.parts.filter((p) => p.kind === 'source').reduce((sum, p) => sum + p.tokens, 0),
  trainTokens: countTokens(TRAIN_SAMPLE),
};
const N = numbers;
const usd = (x: number): string => `$${x.toFixed(2)}`;

// ---------- 图元 ----------

const ruleRow = (updated: boolean): RowPrim => ({
  kind: 'row',
  id: 'rule',
  w: 92,
  cells: [
    { v: '银行卡 3–7 天', sub: updated ? 'archived' : '现行', tone: updated ? 'dim' : PART_TONE.doc, key: 'old' },
    { v: '银行卡 2–5 天', sub: '修订（示例）', tone: updated ? PART_TONE.doc : 'empty', key: 'new' },
  ],
  title: '退款说明 第 1 段',
});

function promptTower(withFormat: boolean): TowerPrim {
  const parts = (withFormat ? formatPrompt : prompt).parts.filter((p) => p.kind !== 'separator');
  return {
    kind: 'tower',
    id: 'p',
    frames: parts.map((p, i) => ({
      key: p.kind === 'source' ? `s${p.n}` : p.kind,
      text: p.kind === 'instruction' ? `说明${withFormat ? '+格式' : ''} ${p.tokens}` : p.kind === 'source' ? `[${p.n}] ${p.tokens}` : `问题 ${p.tokens}`,
      tone: p.kind === 'source' ? PART_TONE.doc : p.kind === 'question' ? PART_TONE.query : i === 0 && withFormat ? 'amber' : PART_TONE.overhead,
    })),
  };
}

function answerRow(which: 'rag' | 'tuned' | 'format'): RowPrim {
  const result = which === 'rag' ? ragCheck : which === 'tuned' ? tunedCheck : formattedCheck;
  const label = { supported: '有出处', unsupported: '对不上', uncited: '无出处', 'bad-source': '编号越界' } as const;
  return {
    kind: 'row',
    id: 'a',
    w: 100,
    cells: result.sentences.map((s, i): DsCell => ({ v: `${s.text.slice(0, 8)}…`, sub: label[s.status], tone: s.status === 'supported' ? 'green' : 'amber', key: `${which}${i}` })),
    marks: [{ at: 0, text: which === 'rag' ? 'RAG' : which === 'tuned' ? '微调' : '按格式', color: which === 'tuned' ? 'amber' : 'green' }],
  };
}

const COMPARE: Array<[string, string, string]> = [
  ['知识更新', `重嵌入 1 段`, '重新训练'],
  ['可溯源', '[1] 可核对', '无出处'],
  ['每次请求', `+${extraTokens} token`, '+0'],
  ['风格格式', `+${formatTokens} token`, '训练进权重'],
];
function compareGrid(upto: number): GridPrim {
  return {
    kind: 'grid',
    id: 'cmp',
    w: 84,
    rows: COMPARE.map(([row]) => row),
    cols: ['RAG', '微调'],
    cells: COMPARE.map(([, rag, tuned], i): DsCell[] => {
      if (i >= upto) return [{ v: '', tone: 'empty' }, { v: '', tone: 'empty' }];
      const ragWins = i < 3;
      return [{ v: rag, tone: ragWins ? 'green' : 'amber', heat: ragWins ? 0.8 : 0.3 }, { v: tuned, tone: ragWins ? 'amber' : 'green', heat: ragWins ? 0.3 : 0.8 }];
    }),
  };
}

function exampleLines(name: string, text: string, summary: string): LayerWriter {
  const layer = utf8Lines(name, text, { color: 'green', summary });
  layer.fields.forEach((field) => (field.example = true));
  return layer;
}

// ---------- 课程 ----------

export const finetune: Lesson = {
  id: 'finetune',
  name: 'RAG VS FINE-TUNING',
  title: 'RAG 和微调怎么选',
  group: 'pipeline',
  layer: [1, 7],
  layerNote: '从改一份文档开始，经过嵌入、入库、检索、拼提示，到回答和引用，整条流水线都走一遍，和把知识训练进模型对比。',
  distNote: `RAG 每次检索都在 ${N.current} 个现行段落里暴力搜索：改完规则验证一次，正式请求一次，一共 ${meter.total} 次；微调后的模型不检索，记 0。`,
  nodes: ['docs', 'embedder', 'index', 'text', 'app', 'prompt', 'llm', 'answer', 'scores'],
  place: { docs: [110, 130], embedder: [450, 90], index: [800, 120], text: [250, 440], app: [960, 380], prompt: [560, 380], llm: [770, 600], answer: [1140, 720], scores: [330, 720] },
  labels: {
    docs: ['文档库', '《退款说明》改了'],
    embedder: ['嵌入模型', '模型不变'],
    index: ['向量库', `${PARAGRAPHS.length + 1} 个向量`],
    text: ['规则', '新旧两版'],
    app: ['客服 Agent', '问到账时间'],
    prompt: ['提示', '每部分的 token'],
    llm: ['大模型', '回答（示例）'],
    answer: ['回答', '有没有出处'],
    scores: ['对比', 'RAG / 微调'],
  },
  labelAt: { text: [0, 80], prompt: [60, 95], answer: [0, 100], scores: [-260, -60] },
  radius: { text: 70, prompt: 80, answer: 70, scores: 100 },
  initial: { text: [ruleRow(false)], prompt: [], answer: [], scores: [] },
  start: ['docs', 'embedder', 'index', 'text'],
  legend: [['teal', '文档和资料'], ['green', '有出处、占优'], ['amber', '要付出的代价'], ['slate', '提示里的说明'], [null, '距离列：累计比较过几次向量']],
  overview: {
    full: '知识放进检索库，还是训练进模型',
    description: `让模型知道「小铺」的规则有两条路：检索增强（RAG）在每次回答前把相关段落找出来放进提示，模型本身不变；微调（fine-tuning）拿问答样本继续训练，把规则写进权重。这一课改一条退款规则，看两条路各要做什么，再比较能不能溯源、每次请求多带多少 token、风格和格式该放在哪。全课最后一课，结尾把整门课串起来。`,
    facts: [
      ['改一条规则', `RAG 重嵌入 1 / ${N.paragraphs} 段，${N.newBytes} 字节`],
      ['每次请求', `RAG 多 ${extraTokens} token（本站 BPE）`],
      ['溯源', `RAG ${ragCheck.supported} / ${ragCheck.total} 句有出处，微调 0`],
      ['微调', 'LLM EXPLORER：训练一步与 LoRA 微调'],
    ],
  },
  steps: [
    {
      title: '改一条规则：RAG 只重嵌入一段',
      desc: `1 / ${N.paragraphs} 段，请求 ${N.requestBytes} 字节`,
      detail: `店里把银行卡退款从 3–7 个工作日改成 2–5 个工作日（示例）。RAG 这边嵌入模型不用动，只把改了的这一段（${N.newBytes} 字节）发给嵌入接口，请求 ${N.requestBytes} 字节，响应 ${N.responseBytes} 字节，拿回一个 ${N.vectorBytes} 字节的向量入库；整个知识库 ${N.paragraphs} 段共 ${thousands(N.kbBytes)} 字节，其余 ${N.paragraphs - 1} 段都不用重算。旧段标成 archived 留在库里，前过滤之后再问「${QUESTION.replace(/？$/, '')}」，第一名就是新规则（${fixed(N.newScore, 3)}）。`,
      facts: [['重嵌入', `1 段，${N.newBytes} 字节`], ['请求 / 响应', `${N.requestBytes} / ${N.responseBytes} 字节`], ['整个知识库', `${N.paragraphs} 段，${thousands(N.kbBytes)} 字节`], ['验证', `第一名 ${fixed(N.newScore, 3)}，比较 ${check.computed} 次`]],
      events: [
        pk('docs', 'text', 'teal', '修订一段', ['3–7 → 2–5 个工作日'], [0, 'LOAD', `《退款说明》第 1 段修订（示例），${N.newBytes} 字节；旧版本标 archived`, N.newBytes],
          wire('修订后的段落（示例）', 'mem', 'format', utf8Text('新段落', NEW_TEXT, { color: 'teal', summary: `${[...NEW_TEXT].length} 个字符，修订内容是示例` }))),
        pk('docs', 'embedder', 'blue', 'POST /v1/embeddings', [`input：改了的 1 段`, `${N.requestBytes} 字节`], [0, 'HTTP', `只嵌入改了的一段：请求 ${N.requestBytes} 字节`, N.requestBytes],
          wire('嵌入请求', 'mem', 'format',
            httpHead('请求头', http.layout, { mask: { authorization: 'Bearer sk-proj-'.length }, example: ['authorization'] }),
            jsonBody('请求体', http.json, { notes: { input: '只有修订的这一段，其余段落的向量不变。' } }))),
        pk('embedder', 'index', 'violet', '新向量入库', [`${N.vectorBytes} 字节`, `${OLD_ID} 标 archived`], [0, 'INDEX', `新向量 ${N.vectorBytes} 字节入库，旧段改 status = archived（向量库共 ${vectors.length} 个向量）`, N.vectorBytes],
          wire('入库的新向量', 'mem', 'format', floatVector(NEW_ID, newTrace.vector, 'f32', { color: 'violet', summary: '本站 16 维模型的值', digits: 3 })),
          { ds: { text: [ruleRow(true)] } }),
        show('app', 'scores'),
        state('index', { 向量: `${vectors.length} 个`, 现行: `${N.current} 个` }),
        pk('app', 'index', 'amber', '验证检索', [`「${QUESTION}」`, `第一名 ${ids[check.hits[0].id]}`], [dist1, 'SEARCH', `前过滤后在 ${check.computed} 个现行段落里搜，第一名是新段落（${num(N.newScore, 4)}）`, null],
          wire('验证：新规则排第一', 'mem', '示意', concept('前 3 个', check.hits.map((hit, rank): [string, string, string] => [`${rank + 1} · ${ids[hit.id]}`, num(hit.score, 4), `「${textOf(hit.id)}」`]), 'amber')),
          { ds: { scores: [compareGrid(1)] } }),
        note('text', '旧版留着，标 archived', 'navy'),
      ],
    },
    {
      title: '同样的修改，微调要重新训练',
      desc: '写成样本、训练、评估、上线',
      detail: `微调把知识写进权重，规则变了，就要把新规则写成问答样本（示例），连同原来的样本重新训练，再评估、再上线；LLM EXPLORER 的「训练一步与 LoRA 微调」一课演示了训练一步到底改了哪些数。训练之后，模型是不是每次都答「2–5 个工作日」、会不会混进旧的「3–7」，只能靠上一课那样的评估去测，权重里没有哪一处能直接查看或改正这条规则。训练的费用和时长取决于平台和数据量，本站不编数字。`,
      facts: [['训练样本', `${N.trainTokens} token（示例，本站 BPE）`], ['步骤', '样本 → 训练 → 评估 → 上线'], ['参考', 'LLM EXPLORER：LoRA 微调']],
      events: [
        show('llm'),
        pk('text', 'llm', 'green', '训练样本', [`问题：${QUESTION}`, `回答：${TUNED_ANSWER}`], [dist1, 'TRAIN', `把新规则写成一问一答的训练样本（示例），${N.trainTokens} 个 token；要和其余样本一起重新训练`, utf8Encode(TRAIN_SAMPLE).length],
          wire('训练样本（示例）', 'mem', 'format', exampleLines('样本', TRAIN_SAMPLE, '一问一答，示例'))),
        state('llm', { 权重: '要重新训练', 知识: '在权重里' }),
        note('llm', '改规则 = 再训练一次', 'amber'),
      ],
    },
    {
      title: '回答能不能溯源',
      desc: `RAG ${ragCheck.supported} / ${ragCheck.total} 句有出处，微调 0`,
      detail: `同一个问题再走一遍：RAG 检索（比较 ${request.computed} 次），把 3 段资料拼进提示，共 ${N.promptTokens} 个 token，模型照着回答并标出 [1]（示例），引用核对能把这句话和第 1 段资料逐字对上。微调后的模型只收到问题，说出同样的话，可这句话没有来源可标，核对结果是 uncited：用户和客服都没法知道它依据的是哪一版规则。要求「每句话都有出处」的场景，比如售后、合规，更适合检索。`,
      facts: [['RAG 提示', `${N.promptTokens} token`], ['RAG 的回答', ragCheck.sentences.map((s) => s.status).join('、')], ['微调的回答', tunedCheck.sentences.map((s) => s.status).join('、')]],
      events: [
        type(`search_docs("${QUESTION}")`),
        pk('app', 'index', 'amber', '检索', [`前过滤，取前 3`], [dist3, 'SEARCH', `正式请求：在 ${request.computed} 个现行段落里搜，取前 3`, null],
          wire('检索结果', 'mem', '示意', concept('前 3 个', request.hits.map((hit, rank): [string, string, string] => [`${rank + 1} · ${ids[hit.id]}`, num(hit.score, 4), `「${textOf(hit.id)}」`]), 'amber'))),
        show('prompt'),
        pk('index', 'prompt', 'teal', '拼提示', [`3 段资料`, `${N.promptTokens} token`], [dist3, 'PROMPT', `说明、3 段资料、问题，共 ${N.promptTokens} 个 token（本站 BPE），资料占 ${N.sourceTokens}`, utf8Encode(prompt.text).length],
          wire('RAG 的提示', 'mem', 'format', promptParts('提示', prompt)),
          { ds: { prompt: [promptTower(false)] } }),
        show('answer'),
        pk('prompt', 'llm', 'slate', `${N.promptTokens} token`, ['说明 + 资料 + 问题'], [dist3, 'INFER', `模型读 ${N.promptTokens} 个 token 的提示，回答并标出来源（示例）`, utf8Encode(prompt.text).length],
          wire('RAG 的提示', 'mem', 'format', promptParts('提示', prompt))),
        pk('llm', 'answer', 'green', 'RAG 的回答', [RAG_ANSWER], [dist3, 'CITE', `回答（示例）标了 [1]，核对：${ragCheck.sentences.map((s) => s.status).join('、')}，词覆盖率 ${num(ragCheck.sentences[0].support!.coverage, 2)}`, utf8Encode(RAG_ANSWER).length],
          wire('RAG 的回答（示例）', 'mem', 'format', exampleLines('回答', RAG_ANSWER, '模型写的，示例；引用核对是真算的')),
          { ds: { answer: [answerRow('rag')] } }),
        pk('app', 'llm', 'blue', '只发问题', [QUESTION, `${tunedTokens} token`], [dist3, 'CALL', `微调后的模型：只发问题，${tunedTokens} 个 token，不检索`, utf8Encode(QUESTION).length],
          wire('发给微调模型的问题', 'mem', 'format', utf8Text('问题', QUESTION))),
        pk('llm', 'answer', 'green', '微调的回答', [TUNED_ANSWER], [dist3, 'CITE', `同样的话（示例），没有来源编号，核对：${tunedCheck.sentences.map((s) => s.status).join('、')}`, utf8Encode(TUNED_ANSWER).length],
          wire('微调后的回答（示例）', 'mem', 'format', exampleLines('回答', TUNED_ANSWER, '模型写的，示例；没有来源可核对')),
          { ds: { answer: [answerRow('tuned')], scores: [compareGrid(2)] } }),
      ],
    },
    {
      title: '每次请求多带多少 token',
      desc: `RAG ${N.promptTokens}，微调 ${tunedTokens}`,
      detail: `RAG 的代价是每次请求都要检索，还要把资料带进提示：这次 ${N.promptTokens} 个 token，微调后的模型只要问题本身的 ${tunedTokens} 个，差 ${extraTokens} 个。假设一天 ${thousands(REQUESTS)} 次请求，就是 ${thousands(extraTokens * REQUESTS)} 个 token，按 CONTEXT EXPLORER 用的示例单价（Opus 5.5 输入每百万 token ${PRICE_PER_MTOK} 美元，2026-11-06）约 ${usd(extraCost)}。token 数是本站迷你 BPE 的计数，真实分词器给出的数不同，只看量级；微调省下的是每次的上下文，付出的是训练和每次改规则都要重来。`,
      facts: [['RAG 提示', `${N.promptTokens} token`], ['微调', `${tunedTokens} token`], [`${thousands(REQUESTS)} 次`, `多 ${thousands(extraTokens * REQUESTS)} token，约 ${usd(extraCost)}`], ['单价来源', PRICE_SOURCE]],
      events: [
        pk('prompt', 'llm', 'slate', `多 ${extraTokens} token`, [`RAG ${N.promptTokens}`, `微调 ${tunedTokens}`], [dist3, 'TOKENS', `每次请求多 ${extraTokens} 个 token；${thousands(REQUESTS)} 次多 ${thousands(extraTokens * REQUESTS)} 个，按示例单价约 ${usd(extraCost)}`, null],
          wire('每次请求的上下文', 'mem', '示意', concept('token（本站 BPE）', [
            ...prompt.parts.filter((p) => p.kind !== 'separator').map((p): [string, string, string] => [p.kind === 'source' ? `资料 [${p.n}]` : p.kind === 'instruction' ? '说明' : '问题', `${p.tokens} token`, p.kind === 'source' ? '检索到的段落，每次都不同。' : p.kind === 'instruction' ? '每次都一样。' : '用户的问题。']),
            ['微调后', `${tunedTokens} token`, '只有问题本身。'],
            [`× ${thousands(REQUESTS)} 次`, `${thousands(extraTokens * REQUESTS)} token`, `示例单价 ${PRICE_PER_MTOK} 美元 / 百万 token（Opus 5.5 输入，${PRICE_SOURCE}，2026-11-06），约 ${usd(extraCost)}。`],
          ], 'slate')),
          { ds: { scores: [compareGrid(3)] } }),
      ],
    },
    {
      title: '风格和格式交给微调',
      desc: `格式要求每次多 ${formatTokens} token`,
      detail: `如果店里要求每个回答都按「结论、依据、下一步」三行写，语气像店员，用提示来做，就要每次带上格式说明和一个示例，多 ${formatTokens} 个 token，模型还不一定每次都照做。这类「怎么说」的要求不随规则变化，正适合微调：训练进权重以后，提示里不用再写。按格式写的回答（示例）三行里，只有带 [1] 的「依据」能核对，结论那一句没标来源，依然是 uncited。`,
      facts: [['格式说明 + 示例', `${formatTokens} token`], ['带格式的提示', `${formatPrompt.tokens} token`], ['三行的核对', formattedCheck.sentences.map((s) => s.status).join('、')]],
      events: [
        pk('app', 'prompt', 'amber', '加格式要求', ['结论 / 依据 / 下一步', `+${formatTokens} token`], [dist3, 'PROMPT', `说明里加上格式要求和一个示例，提示从 ${N.promptTokens} 变成 ${formatPrompt.tokens} 个 token`, utf8Encode(formatPrompt.text).length],
          wire('带格式要求的提示', 'mem', 'format', promptParts('提示', formatPrompt, { notes: { instruction: `原来的说明加上格式要求和一个示例，多 ${formatTokens} 个 token。` } })),
          { ds: { prompt: [promptTower(true)] } }),
        pk('llm', 'answer', 'green', '三行回答', FORMATTED.split('\n'), [dist3, 'CITE', `按格式写的回答（示例），核对：${formattedCheck.sentences.map((s) => s.status).join('、')}`, utf8Encode(FORMATTED).length],
          wire('按格式写的回答（示例）', 'mem', 'format', exampleLines('回答', FORMATTED, '模型写的，示例')),
          { ds: { answer: [answerRow('format')], scores: [compareGrid(4)] } }),
        note('prompt', '每次都要带', 'amber'),
      ],
    },
    {
      title: '怎么选',
      desc: '微调管怎么说，RAG 管说什么',
      detail: `会变的、要溯源的知识放进检索库：改一段重嵌入一段，回答带出处，代价是每次多 ${extraTokens} 个 token 和一次检索。稳定的风格、格式、任务做法训练进模型：每次请求更短，但改一次就要重新训练，回答也没有出处。两条路常常一起用，微调过的模型照样可以接检索；另一种情况是知识库很小，Anthropic 的文章建议小于 20 万 token 时直接整个放进提示，连检索都不用。`,
      facts: [['RAG', '会变的知识、要出处'], ['微调', '风格、格式、任务做法'], ['一起用', '微调的模型也能接检索'], ['知识库很小', '< 20 万 token 直接放进提示']],
      events: [
        pk('answer', 'app', 'green', '选型', ['会变的知识 → RAG', '怎么说 → 微调'], [dist3, 'CALL', `对比汇总：知识更新、溯源、每次请求、风格格式`, null],
          wire('怎么选', 'mem', '示意', concept('对比', COMPARE.map(([row, rag, tuned]): [string, string, string] => [row, `RAG ${rag} · 微调 ${tuned}`, ''] ), 'green'),
            concept('另一条路', [['知识库很小', '< 200,000 token', 'Anthropic 的 Contextual Retrieval 一文（2024-09-19）：知识库小于 20 万 token 时直接全部放进提示。']], 'slate')),
          { ds: { scores: [compareGrid(4)] } }),
        note('scores', '两条路常常一起用', 'green'),
      ],
    },
  ],
  outro: {
    title: '问题找到答案的整条路',
    desc: `${PARAGRAPHS.length} 段文字 → 16 维向量 → 带出处的回答`,
    text: `整门课走完了一个问题找到答案的路：文字变成向量，余弦衡量远近；向量库用 Flat、IVF、HNSW、PQ 在很多向量里快速找最近的几个；关键词和向量用 RRF 合并，元数据过滤挡掉过时的文档；检索结果拼进提示，模型带着来源编号回答，再重排序、改写查询、用标注的问题评估。RAG 解决「模型不知道」，微调解决「模型不会这样说」，两者可以叠加。下一门课是 AGENT EXPLORER，换到调用 search_docs 的那一侧：Agent 怎样决定调用哪个工具、拿到结果之后做什么。`,
    facts: [['嵌入', '文字 → 16 维向量'], ['检索', 'Flat、IVF、HNSW、PQ、混合'], ['流水线', '入库、问答、重排、改写、评估'], ['下一门课', 'AGENT EXPLORER']],
  },
};
