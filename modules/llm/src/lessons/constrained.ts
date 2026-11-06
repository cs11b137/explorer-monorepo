/**
 * 第十三课：约束解码。每一步用掩码只允许能继续写成合法输出的 token（model/sample.ts 的 prefixMask + choiceConstraint），
 * 对比无约束时模型写出的东西。文案里的数字全部取自下面导出的计算结果，tests/narrative.sample.test.ts 核对。
 */
import { rawBytes, tokenIds, utf8Text, wire } from '../decode/structures';
import { choiceConstraint, prefixMask, sample } from '../model/sample';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import { num, pct, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { heatOf, labelBelow, promptLogits, sampledRun, vocabFloats } from './sample-common';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

const T = TOKENIZER;

/** 已经写好的开头（真实引擎里它也是被语法强制出来的）。 */
export const PROMPT = '{"kind": ';
/** JSON Schema 里 kind 的枚举。 */
export const ENUM = ['token', 'model', 'cache'] as const;
/** 把 schema 展开成「还要写完的合法字符串」：值本身加收尾的右花括号。 */
export const LEGAL = ENUM.map((value) => `"${value}"}`);
export const SEED = 1;
export const FREE_TOKENS = 12;
/** 统计用的种子个数。 */
export const TRIALS = 30;

const { isPrefix, isComplete } = choiceConstraint(LEGAL);
const promptIds = T.encode(PROMPT);
const bytesOf = (tokens: readonly number[]) => tokens.flatMap((id) => T.bytesOf(id));
const allowedFor = (out: readonly number[]) => prefixMask(T, bytesOf(out), isPrefix, isComplete);

/** 输出是不是合法：接在提示词后面能解析成 JSON，并且 kind 在枚举里。 */
export function isValid(text: string): boolean {
  try {
    const value = JSON.parse(PROMPT + text);
    return typeof value === 'object' && value !== null && (ENUM as readonly string[]).includes(value.kind) && Object.keys(value).length === 1;
  } catch {
    return false;
  }
}

// ---------- 无约束 ----------

export const freeGreedy = sampledRun(promptIds, { temperature: 0 }, null, FREE_TOKENS, false);
export const freeSampled = [1, 2].map((seed) => sampledRun(promptIds, { temperature: 1 }, seed, FREE_TOKENS, false));
export const freeRuns = [freeGreedy, ...freeSampled];

// ---------- 有约束 ----------

export const cRun = sampledRun(promptIds, (out) => ({ temperature: 1, allowed: allowedFor(out) }), SEED, FREE_TOKENS, false);
/** 每一步的掩码：允许的 token id。 */
export const masks = cRun.traces.map((_, step) => allowedFor(cRun.tokens.slice(0, step)).flatMap((ok, id) => (ok ? [id] : [])));
/** 如果没有掩码，同一步的 logits 会怎样（用同样的 temperature）。 */
export const unmasked = cRun.logits.map((logits) => sample(logits, [], { temperature: 1 }));
/** 无约束时，合法 token 一共分到了多少概率。 */
export const allowedMass = masks.map((ids, step) => ids.reduce((sum, id) => sum + unmasked[step].probs[id], 0));
export const outputText = cRun.text;
const decodedKind = JSON.parse(PROMPT + outputText).kind as string;

// ---------- 统计：多个种子 ----------

const stats = Array.from({ length: TRIALS }, (_, i) => {
  const seed = i + 1;
  return {
    free: sampledRun(promptIds, { temperature: 1 }, seed, FREE_TOKENS, false),
    guarded: sampledRun(promptIds, (out) => ({ temperature: 1, allowed: allowedFor(out) }), seed, FREE_TOKENS, false),
  };
});
export const freeValid = stats.filter((item) => isValid(item.free.text)).length;
export const guardedValid = stats.filter((item) => isValid(item.guarded.text) && item.guarded.ended).length;
export const guardedKinds = ENUM.map((value) => stats.filter((item) => item.guarded.text === `"${value}"}`).length);
const statsFlops = stats.reduce((sum, item) => sum + item.free.decodeFlops + item.guarded.decodeFlops, 0);

const prefill = promptLogits(PROMPT).flops;
const freeOps = prefill + freeRuns.reduce((sum, run) => sum + run.decodeFlops, 0);
const guardedOps = freeOps + cRun.decodeFlops;
const finalOps = guardedOps + statsFlops;

// ---------- 图元 ----------

const showText = (text: string) => text.replace(/ /g, '␣');
const COLS = 6;

const freeGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'f',
  w: 38,
  rows: ['贪心', '种子 1', '种子 2'],
  cols: Array.from({ length: COLS }, (_, c) => String(c + 1)),
  cells: freeRuns.map((run): DsCell[] => Array.from({ length: COLS }, (_, c) => (c < run.tokens.length ? { v: shortLabel(run.tokens[c], 4), tone: 'amber' } : { v: '', tone: 'empty' }))),
});

const allowedRow = (step: number): RowPrim => ({
  kind: 'row',
  id: 'a',
  w: 44,
  cells: masks[step].slice(0, 6).map((id): DsCell => ({ v: shortLabel(id, 4), tone: 'green' })),
  marks: [{ at: 0, text: `允许 ${masks[step].length} / ${T.size}`, color: 'green' }],
});

const maskedRow = (step: number): RowPrim => {
  const trace = cRun.traces[step];
  return {
    kind: 'row',
    id: 'm',
    w: 48,
    cells: trace.final.slice(0, 4).map((item): DsCell => ({ v: pct(item.p).replace('%', ''), tone: 'green', heat: heatOf(item.p), sub: shortLabel(item.id, 5) })),
    marks: [{ at: trace.final.findIndex((item) => item.id === trace.chosen), text: '选中', color: 'green' }],
  };
};

const stepsGrid = (done: number): GridPrim => ({
  kind: 'grid',
  id: 's',
  w: 34,
  rows: cRun.traces.map((_, i) => `第 ${i + 1} 步`),
  cols: ['允许', '无约束', '选中'],
  cells: cRun.traces.map((trace, i): DsCell[] =>
    i < done
      ? [
          { v: String(masks[i].length), tone: 'green' },
          { v: shortLabel(unmasked[i].ranked[0].id, 4), tone: masks[i].includes(unmasked[i].ranked[0].id) ? undefined : 'amber' },
          { v: shortLabel(trace.chosen, 4), tone: 'green' },
        ]
      : [{ v: '', tone: 'empty' }, { v: '', tone: 'empty' }, { v: '', tone: 'empty' }],
  ),
});

const resultRow = (done: number): RowPrim => ({
  kind: 'row',
  id: 'r',
  w: 44,
  cells: cRun.traces.map((trace, i): DsCell => (i < done ? { v: shortLabel(trace.chosen, 4), tone: trace.chosen === T.eos ? 'blue' : 'green' } : { v: '', tone: 'empty' })),
});

const kindGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'k',
  w: 44,
  rows: ['无约束', '有约束'],
  cols: ['合法', '总数'],
  cells: [[{ v: String(freeValid), tone: 'amber' }, { v: String(TRIALS) }], [{ v: String(guardedValid), tone: 'green' }, { v: String(TRIALS) }]],
});

/** 无约束时的第一名，在多少步里是被掩码禁止的。 */
export const illegalTop = cRun.traces.filter((_, i) => !masks[i].includes(unmasked[i].ranked[0].id)).length;
const step0 = 0;
const step1 = 1;
const freeTop = (step: number) => unmasked[step].ranked[0];
const idsText = (ids: readonly number[], n = 6) => ids.slice(0, n).map((id) => T.label(id)).join('、');
const requestJson = JSON.stringify({ response_format: { type: 'json_schema', json_schema: { name: 'item', strict: true, schema: { type: 'object', properties: { kind: { type: 'string', enum: [...ENUM] } }, required: ['kind'], additionalProperties: false } } } });
const lastStep = cRun.traces.length - 1;

export const constrained: Lesson = labelBelow(
  {
    id: 'constrained',
    name: 'CONSTRAINED DECODING',
    title: '约束解码',
    group: 'sample',
    layer: [5, 7],
    layerNote: 'API 的 JSON schema 要求在推理引擎的采样器里，用逐步掩码来保证。',
    opsUnit: 'FLOPs：提示词预填充一次，之后每个生成的 token 一次解码；掩码判断和抽样是逐元素运算，不计入',
    opsShort: 'FLOPs',
    nodes: ['client', 'sampler', 'vocab', 'logits', 'out'],
    place: { client: [110, 110], sampler: [350, 340], vocab: [620, 90], logits: [700, 300], out: [780, 575] },
    labels: {
      client: ['应用', 'response_format = JSON schema'],
      sampler: ['采样器', '按语法逐步生成掩码'],
      vocab: ['允许的 token', '这一步合法的有哪些'],
      logits: ['掩码后的概率', '非法的 logit 变成 −∞'],
      out: ['输出', '无约束 / 有约束'],
    },
    radius: { vocab: 50, logits: 50, out: 50 },
    initial: { vocab: [], logits: [], out: [] },
    start: ['client', 'sampler', 'out'],
    legend: [['green', '合法 / 允许'], ['amber', '非法 / 无约束时的输出'], [null, '运算量：前向的 FLOPs']],
    overview: {
      full: '让模型只能写出合法的输出',
      description: `让模型输出 JSON，光在提示词里要求是不够的：它可能多写、少写、写错。这一课用迷你模型演示结构化输出背后的办法：每生成一个 token 之前，先算出这一步哪些 token 还能把输出写成合法的，把其余的 logit 设为 −∞，再采样。提示词是「${PROMPT}」，要求后面写的是 ${ENUM.map((value) => `"${value}"`).join('、')} 三个枚举值之一。`,
      facts: [
        ['提示词', `「${PROMPT}」`],
        ['合法写法', LEGAL.map((item) => `「${item}」`).join(' ')],
        ['词表', `${T.size} 个 token`],
        ['掩码', 'prefixMask：接上后仍是合法前缀'],
        ['随机种子', `mulberry32(${SEED})`],
        ['运算量', 'FLOPs（前向）'],
      ],
    },
    steps: [
      {
        title: '无约束：写出来的不是 JSON',
        desc: `${freeRuns.length} 次生成，合法的有 ${freeRuns.filter((run) => isValid(run.text)).length} 次`,
        detail: `先让模型自由续写「${PROMPT}」。贪心的结果是「${showText(freeGreedy.text)}」，另外两个种子（T=1）写出「${showText(freeSampled[0].text)}」和「${showText(freeSampled[1].text)}」，没有一个能接在提示词后面解析成 JSON。迷你模型没有学过 JSON，但大模型同样会偶尔漏掉引号、多写一句解释或者写出不在枚举里的值，所以程序没法直接信任它的输出。`,
        facts: freeRuns.map((run, i): [string, string] => [i === 0 ? '贪心' : `种子 ${i}`, `「${showText(run.text)}」`]),
        events: [
          type(`complete('${PROMPT}')`),
          pk('sampler', 'out', 'amber', '无约束', freeRuns.map((run) => `「${showText(run.text).slice(0, 14)}」`), [freeOps, 'SAMPLE', `${freeRuns.length} 次无约束生成，各 ${FREE_TOKENS} 个 token，都不是合法 JSON`, bytesOf(freeGreedy.tokens).length],
            wire('无约束的贪心输出', 'mem', 'format',
              rawBytes('生成的字节', bytesOf(freeGreedy.tokens), { color: 'amber', groups: freeGreedy.tokens.map((id) => ({ name: T.label(id), bytes: T.bytesOf(id) })) }),
              utf8Text('文本', utf8Decode(bytesOf(freeGreedy.tokens)), { color: 'slate' })),
            { ds: { out: [freeGrid()] } }),
          note('out', '没有一行是合法的 JSON', 'amber'),
        ],
      },
      {
        title: '把格式变成「下一步能写什么」',
        desc: `第一步只有 ${masks[step0].length} 个合法 token`,
        detail: `请求里带的 JSON schema 会被引擎编译成一个状态机（语法），它能回答：已经写了这些字节，下一个字节还有哪些写法？本站把 schema 手工展开成 ${LEGAL.length} 个合法写法，${LEGAL.map((item) => `「${item}」`).join('、')}，判断规则是「接上这个 token 的字节之后，还是某个合法写法的开头」。第一步只有「${T.label(masks[step0][0])}」满足，${T.size} 个 token 里其余 ${T.size - masks[step0].length} 个都被禁止，包括模型最想写的「${T.label(freeTop(step0).id)}」。`,
        facts: [['合法写法', LEGAL.join('  ')], ['第一步允许', `${masks[step0].length} / ${T.size}`], ['无约束第一名', `${T.label(freeTop(step0).id)}（被禁止）`]],
        events: [
          show('vocab', 'logits'),
          pk('client', 'sampler', 'blue', 'response_format', ['JSON schema', `kind ∈ {${ENUM.join(', ')}}`], [freeOps, 'HTTP', `请求带 JSON schema：kind 只能是 ${ENUM.join('、')}`, utf8Encode(requestJson).length],
            wire('请求里的 response_format（OpenAI 的写法）', 'mem', 'format', utf8Text('request', requestJson, { color: 'blue', summary: 'strict: true 表示严格按 schema 约束解码' }))),
          pk('sampler', 'vocab', 'green', '算掩码', [`已写 0 个字节`, `允许 ${masks[step0].length} 个`], [freeOps, 'LOOKUP', `逐个检查 ${T.size} 个 token：接上之后还是合法写法的开头吗？只有「${T.label(masks[step0][0])}」是`, T.size],
            wire('第 1 步的掩码，每个 token 一个字节（1 = 允许）', 'mem', 'internal',
              rawBytes('mask', Array.from({ length: T.size }, (_, id) => (masks[step0].includes(id) ? 1 : 0)), { color: 'green', summary: `${T.size} 个 token，只有 id ${masks[step0][0]} 是 1`, groups: Array.from({ length: T.size }, (_, id) => ({ name: `${id}「${shortLabel(id, 6)}」`, bytes: [masks[step0].includes(id) ? 1 : 0], note: masks[step0].includes(id) ? '允许' : '禁止：logit 置为 −∞' })) })),
            { ds: { vocab: [allowedRow(step0)] } }),
        ],
      },
      {
        title: '掩码：非法的 logit 变成 −∞',
        desc: `第 2 步 ${masks[step1].length} 个合法，无约束的第一名「${T.label(freeTop(step1).id)}」被禁止`,
        detail: `写完「"」，下一步合法的 token 只剩 ${masks[step1].length} 个：${idsText(masks[step1])}，因为每个合法写法在引号后都是 token / model / cache 的开头。模型最想写的是「${T.label(freeTop(step1).id)}」，它带前导空格，接上之后不再是任何合法写法的开头，所以被禁止。采样器把禁止的 logit 设为 −∞，softmax 之后它们的概率恰好是 0，剩下的重新分配：${cRun.traces[step1].final.slice(0, 2).map((item) => `「${T.label(item.id)}」${pct(item.p)}`).join('、')}。`,
        facts: [['允许', idsText(masks[step1])], ['无约束第一名', `${T.label(freeTop(step1).id)} ${pct(freeTop(step1).prob)}`], ['合法 token 的原概率', `合计 ${num(allowedMass[step1], 2)}`]],
        events: [
          pk('sampler', 'vocab', 'green', '算掩码', [`已写 ${bytesOf(cRun.tokens.slice(0, step1)).length} 个字节`, `允许 ${masks[step1].length} 个`], [freeOps, 'LOOKUP', `已写「${showText(utf8Decode(bytesOf(cRun.tokens.slice(0, step1))))}」，允许：${idsText(masks[step1])}`, T.size],
            wire('第 2 步的掩码', 'mem', 'internal',
              rawBytes('mask', Array.from({ length: T.size }, (_, id) => (masks[step1].includes(id) ? 1 : 0)), { color: 'green', summary: `${T.size} 个 token，${masks[step1].length} 个是 1`, groups: Array.from({ length: T.size }, (_, id) => ({ name: `${id}「${shortLabel(id, 6)}」`, bytes: [masks[step1].includes(id) ? 1 : 0], note: masks[step1].includes(id) ? '允许' : '禁止：logit 置为 −∞' })) })),
            { ds: { vocab: [allowedRow(step1)] } }),
          pk('sampler', 'logits', 'green', 'logit 加掩码', [`非法的置 −∞`], [freeOps, 'ACT', `masked[id] = allowed ? logit : −∞；softmax 后 ${idsText(cRun.traces[step1].final.map((item) => item.id), 2)} 分到 ${cRun.traces[step1].final.slice(0, 2).map((item) => pct(item.p)).join('、')}`, T.size * 4],
            wire('掩码后的概率（非法的是 0）', 'mem', 'format', vocabFloats('probs', cRun.traces[step1].probs, `${T.size} 个概率，被禁止的恰好是 0`, 'green')),
            { ds: { logits: [maskedRow(step1)] } }),
        ],
      },
      {
        title: `逐步写完，${cRun.traces.length} 步后停下`,
        desc: `写出「${showText(outputText)}」，结束符只在写完之后才允许`,
        detail: `每一步都重新算一次掩码。「ken」写完以后，下一步只有「"」合法，再下一步只有「}」，这两步没有选择余地。到这里输出「${showText(outputText)}」已经是完整的合法写法，结束符才第一次被允许，而且是唯一被允许的 token，于是采样器写出它，生成结束。如果没有掩码，模型最想写的第一名在这 ${cRun.traces.length} 步里有 ${illegalTop} 步是非法的。`,
        facts: [['输出', `「${showText(outputText)}」`], ['每步允许', masks.map((ids) => ids.length).join(' → ')], ['结束符', `第 ${lastStep + 1} 步才允许`]],
        events: [
          pk('sampler', 'out', 'green', '逐步生成', [`「${showText(outputText)}」`, `${cRun.traces.length} 步`], [guardedOps, 'SAMPLE', `${cRun.traces.map((trace) => T.label(trace.chosen)).join(' → ')}；每步允许 ${masks.map((ids) => ids.length).join('、')} 个`, cRun.tokens.length * 4 + 4],
            wire('每一步选中的 token id（最后一个是结束符）', 'mem', 'format', tokenIds('ids', [...cRun.tokens, T.eos], { color: 'green', labels: (id) => T.label(id), summary: '约束解码生成的 token 序列' })),
            { ds: { logits: [stepsGrid(cRun.traces.length)], out: [resultRow(cRun.traces.length)] } }),
          note('out', '最后的结束符也要经过掩码', 'green'),
        ],
      },
      {
        title: '结构化输出就是这个',
        desc: `${TRIALS} 个种子，无约束合法 ${freeValid} 次，有约束合法 ${guardedValid} 次`,
        detail: `换 ${TRIALS} 个种子各生成一次：无约束合法 ${freeValid} 次，有约束合法 ${guardedValid} 次，选出的值分别是 ${ENUM.map((value, i) => `${value} ${guardedKinds[i]} 次`).join('、')}。真实 API 里的 JSON schema 或 structured output 做的是同一件事：把 schema 编译成语法，每步算掩码再采样，llama.cpp 用 GBNF 语法，vLLM 等引擎可以接 outlines、xgrammar 这类库。掩码保证形式合法，不保证内容正确；而且把模型不想写的 token 强行排除后，它得到的是在合法集合里重新分配的概率。`,
        facts: [['无约束', `${freeValid} / ${TRIALS} 合法`], ['有约束', `${guardedValid} / ${TRIALS} 合法`], ['选出的值', ENUM.map((value, i) => `${value} ${guardedKinds[i]}`).join('  ')]],
        events: [
          pk('sampler', 'client', 'green', '合法的 JSON', [`{"kind": ${LEGAL[0].slice(0, -1)}}`], [finalOps, 'HTTP', `${TRIALS} 次生成全部合法，值是 ${decodedKind}；无约束合法 ${freeValid} 次`, utf8Encode(PROMPT + outputText).length],
            wire('返回给应用的 JSON', 'mem', 'format', utf8Text('content', PROMPT + outputText, { color: 'green', summary: '解析成功，kind 在枚举里' })),
            { ds: { logits: [kindGrid()] } }),
          state('sampler', { 约束: LEGAL.length + ' 种写法', 无约束合法: `${freeValid}/${TRIALS}`, 有约束合法: `${guardedValid}/${TRIALS}` }),
          render,
        ],
      },
    ],
    outro: {
      title: '格式靠掩码，不靠祈祷',
      desc: '逐步限制下一个 token，输出必然合法',
      text: `这一课的约束只是三个枚举串，真实引擎要处理任意嵌套的 JSON、正则、语法，做法是把规则编译成状态机，每一步根据当前状态直接查出允许的 token（词表有十万量级，所以掩码通常预先算好再缓存）。代价是：模型被迫在它不太想写的 token 里选，内容的质量不被保证。下一课看另一件和输出有关的事：token 怎样一个个流出来，什么时候停，为什么半个汉字不能直接显示。`,
      facts: [['合法率', `${freeValid} → ${guardedValid} / ${TRIALS}`], ['原理', '非法 token 的 logit = −∞'], ['下一课', '停止条件与流式输出']],
    },
  },
  ['vocab', 'logits', 'out'],
);
