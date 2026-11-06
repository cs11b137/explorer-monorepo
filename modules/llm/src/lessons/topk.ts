/**
 * 第十二课：Top-K / Top-P / 重复惩罚。按 sample() 的顺序（惩罚 → 掩码 → temperature → softmax → top-k → top-p → 重新归一化 → 抽样），
 * 在同一步上逐站展示候选集合怎样被截断；再用整段生成对比有没有重复惩罚。
 * 文案里的数字全部取自下面导出的计算结果，tests/narrative.sample.test.ts 核对。
 */
import { rawBytes, tokenIds, utf8Text, wire } from '../decode/structures';
import { TOKENIZER } from '../model/tokenizer';
import { cellsOf, num, pct, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import { colLabels, heatOf, labelBelow, sampledRun, tokenDataLayer, vocabFloats } from './sample-common';
import type { DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

const T = TOKENIZER;

export const PROMPT = 'a longer prompt cost';
export const PENALTY = 1.1;
export const OPTIONS = { temperature: 1.2, topK: 4, topP: 0.8 } as const;
export const SEED = 29;
/** 续写的 token 数上限。 */
export const LENGTH = 20;
/** 单步演示取第几步：贪心复读时第二次要写「 more」的那一步。 */
export const STEP = 4;

const promptIds = T.encode(PROMPT);
/** 不加惩罚的贪心：会复读。 */
export const plain = sampledRun(promptIds, { temperature: 0 }, null, LENGTH);
/** 不加惩罚、同样的 temperature / top-k / top-p / 种子。 */
export const free = sampledRun(promptIds, OPTIONS, SEED, LENGTH);
/** 加了重复惩罚。 */
export const guarded = sampledRun(promptIds, { ...OPTIONS, repetitionPenalty: PENALTY }, SEED, LENGTH);

/** 位置 i 的 token 是否让一个 3 元组第二次出现：复读的标志。 */
export function repeatedAt(tokens: readonly number[]): boolean[] {
  const seen = new Set<string>();
  return tokens.map((_, i) => {
    if (i < 2) return false;
    const key = tokens.slice(i - 2, i + 1).join(',');
    const hit = seen.has(key);
    seen.add(key);
    return hit;
  });
}
export const repeatCount = (tokens: readonly number[]) => repeatedAt(tokens).filter(Boolean).length;

// ---------- 单步演示 ----------

const trace = guarded.traces[STEP];
/** 此刻已经出现过的 token：提示词加已经生成的。 */
export const history = [...promptIds, ...guarded.tokens.slice(0, STEP)];
const historySet = new Set(history);
const COLS = 5;
/** 按原始 logit 从大到小的前几名。 */
export const rawTop = [...trace.raw.keys()].sort((a, b) => trace.raw[b] - trace.raw[a]).slice(0, COLS);
/** 惩罚之后按 logit 从大到小的前几名。 */
export const penalizedTop = [...trace.penalized.keys()].sort((a, b) => trace.penalized[b] - trace.penalized[a]).slice(0, COLS);
/** 惩罚、temperature 之后按概率从大到小的前几名。 */
const probTop = trace.ranked.slice(0, COLS);
export const tailMass = 1 - trace.ranked.slice(0, OPTIONS.topK).reduce((sum, item) => sum + item.prob, 0);
/** top-k 留下的候选，在重新归一化后的累计概率（top-p 就是在这上面累加）。 */
export const keptCumulative = (() => {
  const total = trace.afterTopK.reduce((sum, item) => sum + item.prob, 0);
  let sum = 0;
  return trace.afterTopK.map((item) => (sum += item.prob / total));
})();
export const keptByK = trace.afterTopK.length;
export const keptByP = trace.afterTopP.length;
const chosenFinal = trace.final.findIndex((item) => item.id === trace.chosen);

/** 贪心输出里第一次出现复读的位置（从 1 数起）。 */
export const loopStart = repeatedAt(plain.tokens).indexOf(true) + 1;

const plainOps = plain.prefillFlops + plain.decodeFlops;
const freeOps = plainOps + free.decodeFlops;
const guardedOps = freeOps + guarded.decodeFlops;

// ---------- 图元 ----------

const wrapGrid = (id: string, tokens: readonly number[], marks: readonly boolean[], tone: Tone, per = 6): GridPrim => {
  const rows = Math.ceil(LENGTH / per);
  return {
    kind: 'grid',
    id,
    w: 36,
    rows: Array.from({ length: rows }, (_, r) => `${r * per + 1}`),
    cols: Array.from({ length: per }, (_, c) => String(c + 1)),
    cells: Array.from({ length: rows }, (_, r): DsCell[] =>
      Array.from({ length: per }, (_, c) => {
        const i = r * per + c + (r === 0 ? 0 : 0);
        return i < tokens.length ? { v: shortLabel(tokens[i], 4), tone: marks[i] ? 'amber' : tone } : { v: '', tone: 'empty' };
      }),
    ),
  };
};

const historyRow = (): RowPrim => {
  const candidates = new Set(rawTop);
  return {
    kind: 'row',
    id: 'h',
    w: 24,
    bare: true,
    cells: cellsOf(history.map((id) => shortLabel(id, 3)), { tones: Object.fromEntries(history.flatMap((id, i) => (candidates.has(id) ? [[i, 'amber']] : []))) }),
    marks: [{ at: history.length - 1, text: '已出现的 token', color: 'amber' }],
  };
};

const penaltyGrid = (done: boolean): GridPrim => ({
  kind: 'grid',
  id: 'p',
  w: 42,
  rows: done ? ['原始', '惩罚后'] : ['原始'],
  cols: colLabels(rawTop),
  cells: [
    rawTop.map((id) => ({ v: num(trace.raw[id], 1) })),
    ...(done ? [rawTop.map((id): DsCell => ({ v: num(trace.penalized[id], 1), tone: historySet.has(id) ? 'amber' : undefined }))] : []),
  ],
});

const probRow = (): RowPrim => {
  const shown = trace.ranked.slice(0, 6);
  return {
    kind: 'row',
    id: 'q',
    w: 42,
    cells: [
      ...shown.map((item): DsCell => ({ v: pct(item.prob).replace('%', ''), tone: 'green', heat: heatOf(item.prob), sub: shortLabel(item.id, 5) })),
      { v: pct(1 - shown.reduce((sum, item) => sum + item.prob, 0)).replace('%', ''), tone: 'dim', sub: '其余' },
    ],
    marks: [{ at: 6, text: `尾部 ${pct(1 - shown.reduce((sum, item) => sum + item.prob, 0))}`, color: 'amber' }],
  };
};

const cutGrid = (stage: 0 | 1 | 2): GridPrim => ({
  kind: 'grid',
  id: 'c',
  w: 42,
  rows: ['softmax', `top-k=${OPTIONS.topK}`, `top-p=${OPTIONS.topP}`].slice(0, stage + 1),
  cols: colLabels(probTop.map((item) => item.id)),
  cells: [0, 1, 2].slice(0, stage + 1).map((row) =>
    probTop.map((item, c): DsCell => {
      if (row === 0) return { v: pct(item.prob).replace('%', ''), tone: 'green', heat: heatOf(item.prob) };
      const limit = row === 1 ? keptByK : keptByP;
      return c < limit ? { v: pct(item.prob).replace('%', ''), tone: 'green', heat: heatOf(item.prob) } : { v: pct(item.prob).replace('%', ''), tone: 'dim' };
    }),
  ),
});

const finalRow = (): RowPrim => ({
  kind: 'row',
  id: 'f',
  w: 56,
  cells: trace.final.map((item, i): DsCell => ({ v: num(item.cumulative, 2), tone: i === chosenFinal ? 'green' : undefined, sub: `${shortLabel(item.id, 5)} ${pct(item.p)}` })),
  marks: [{ at: chosenFinal, text: `u = ${num(trace.u!, 3)}`, color: 'green' }],
});

const outFree = () => wrapGrid('o', free.tokens, repeatedAt(free.tokens), 'blue');
const outGuarded = () => wrapGrid('o', guarded.tokens, repeatedAt(guarded.tokens), 'green');

const textOf = (text: string) => text.replace(/ /g, '␣');
const bytesOf = (tokens: readonly number[]) => tokens.flatMap((id) => T.bytesOf(id));
const runWire = (title: string, run: { tokens: number[]; text: string }, color: 'blue' | 'green' | 'amber') =>
  wire(title, 'mem', 'format', rawBytes('生成的字节', bytesOf(run.tokens), { color, groups: run.tokens.map((id) => ({ name: T.label(id), bytes: T.bytesOf(id) })) }), utf8Text('文本', run.text, { color: 'slate' }));

const ranks = (ids: readonly number[], id: number) => ids.indexOf(id) + 1;
const moreId = plain.tokens[STEP];
const topLabel = (ids: readonly number[], i: number) => T.label(ids[i]);

export const topk: Lesson = labelBelow(
  {
    id: 'topk',
    name: 'TOP-K / TOP-P',
    title: 'Top-K / Top-P / 重复惩罚',
    group: 'sample',
    layer: [5, 6],
    layerNote: '采样器是推理引擎的一部分：它在 logits 上依次施加惩罚和截断，再抽出 token。',
    opsUnit: 'FLOPs：提示词预填充一次，之后每个生成的 token 一次解码；惩罚、截断、抽样都是逐元素运算，不计入',
    opsShort: 'FLOPs',
    nodes: ['sampler', 'out', 'tokens', 'logits'],
    place: { sampler: [150, 330], out: [640, 90], tokens: [190, 90], logits: [650, 420], client: [250, 90] },
    labels: {
      sampler: ['采样器', '惩罚 → T → top-k → top-p'],
      out: ['生成的 token', `前 ${LENGTH} 个，每行 6 个`],
      tokens: ['已出现的 token', '提示词加已生成的部分'],
      logits: ['候选', '每一站之后剩下谁'],
    },
    radius: { out: 60, tokens: 50, logits: 50 },
    initial: { out: [], tokens: [], logits: [] },
    start: ['sampler', 'out'],
    legend: [['amber', '已出现 / 重复'], ['green', '留下的候选'], [null, '灰色：被截断'], [null, '运算量：前向的 FLOPs']],
    overview: {
      full: '先压低复读，再把概率尾巴切掉',
      description: `只用 temperature，每一步仍有机会抽到概率很小的 token；贪心又容易一遍遍重复同一句。这一课读真实的迷你模型，提示词是「${PROMPT}」。先看贪心怎样复读，再停在其中一步，按采样器的顺序逐站演示：重复惩罚压低出现过的 token，temperature 和 softmax 得到概率，top-k 与 top-p 切掉尾巴，剩下的重新归一化后抽样。`,
      facts: [
        ['提示词', `「${PROMPT}」`],
        ['重复惩罚', `${PENALTY}（Hugging Face 的 repetition_penalty）`],
        ['temperature', String(OPTIONS.temperature)],
        ['top-k / top-p', `${OPTIONS.topK} / ${OPTIONS.topP}`],
        ['随机种子', `mulberry32(${SEED})`],
        ['运算量', 'FLOPs（前向）'],
      ],
    },
    steps: [
      {
        title: '不加惩罚：复读',
        desc: `贪心写了 ${plain.tokens.length} 个 token，其中 ${repeatCount(plain.tokens)} 个在重复`,
        detail: `贪心每步取概率最大的 token。「${PROMPT}」之后它写出「${textOf(plain.text.slice(0, 22))}…」，到第 ${loopStart} 个 token 开始出现重复的片段，之后同一段话一遍遍地重复。刚写过的词，在新的上下文里又成了概率最大的那个，下一圈的上下文又和上一圈几乎一样，于是越写越像。上下文里已有的内容本身就是最强的线索，模型很容易顺着再写一遍。`,
        facts: [['生成', `${plain.tokens.length} 个 token`], ['重复的 token', `${repeatCount(plain.tokens)} 个（3 个 token 的片段第二次出现）`], ['文本', `「${textOf(plain.text)}」`]],
        events: [
          type(`generate("${PROMPT}", temperature=0)`),
          pk('sampler', 'out', 'blue', '贪心', [`「${textOf(plain.text.slice(0, 16))}…」`], [plainOps, 'SAMPLE', `T=0，${plain.tokens.length} 个 token，其中 ${repeatCount(plain.tokens)} 个是复读`, bytesOf(plain.tokens).length],
            runWire('不加惩罚的贪心输出', plain, 'blue'), { ds: { out: [wrapGrid('o', plain.tokens, repeatedAt(plain.tokens), 'blue')] } }),
          note('out', '橙色：重复出现的片段', 'amber'),
        ],
      },
      {
        title: '重复惩罚压低出现过的 token',
        desc: `「${T.label(moreId)}」的 logit 从 ${num(trace.raw[moreId], 1)} 降到 ${num(trace.penalized[moreId], 1)}`,
        detail: `回到第 ${STEP + 1} 个 token：上下文已经有「${textOf(T.decode(guarded.tokens.slice(0, STEP)))}」，贪心会再选一次「${T.label(moreId)}」。重复惩罚对每个已出现的 token 修改 logit：正数除以 ${PENALTY}，负数乘以 ${PENALTY}，两种情况都让它变得更不可能。「${T.label(moreId)}」被压到第 ${ranks(penalizedTop, moreId)} 名，「${topLabel(penalizedTop, 0)}」升到第 1。OpenAI 一类的 API 用的是另一种形式：出现过就减一个固定值（presence_penalty），每出现一次再减一份（frequency_penalty）。`,
        facts: [['已出现', `${historySet.size} 种 token`], [`「${T.label(moreId)}」`, `${num(trace.raw[moreId], 2)} → ${num(trace.penalized[moreId], 2)}`], ['新的第一名', T.label(penalizedTop[0])]],
        events: [
          show('tokens', 'logits'),
          pk('out', 'tokens', 'amber', '上下文', [`${history.length} 个 token`], [plainOps, 'IDS', `提示词 ${promptIds.length} 个加已生成的 ${STEP} 个，共 ${historySet.size} 种不同的 token`, history.length * 4],
            wire('采样器拿到的已出现 token', 'mem', 'format', tokenIds('history', history, { color: 'amber', labels: (id) => T.label(id) })), { ds: { tokens: [historyRow()] } }),
          pk('tokens', 'sampler', 'amber', '查历史', [`${historySet.size} 种`], [plainOps, 'LOOKUP', '惩罚只看出现过没有，不看它在哪儿', historySet.size * 4],
            wire('出现过的 token（去重）', 'mem', 'format', tokenIds('seen', [...historySet], { color: 'amber', labels: (id) => T.label(id) }))),
          pk('logits', 'sampler', 'blue', '原始 logits', [`${T.size} 个`], [plainOps, 'LOGITS', `第 ${STEP + 1} 步的 logits：第一名「${topLabel(rawTop, 0)}」${num(trace.raw[rawTop[0]], 2)}`, T.size * 4],
            wire('原始 logits', 'mem', 'format', vocabFloats('logits', trace.raw, `${T.size} 个 fp32`, 'blue')), { ds: { logits: [penaltyGrid(false)] } }),
          pk('sampler', 'logits', 'amber', `惩罚 ×${PENALTY}`, [`「${T.label(moreId)}」${num(trace.raw[moreId], 1)} → ${num(trace.penalized[moreId], 1)}`], [plainOps, 'ACT', `repetition_penalty=${PENALTY}：出现过的 token 正 logit ÷ ${PENALTY}，负 logit × ${PENALTY}`, T.size * 4],
            wire('惩罚之后的 logits', 'mem', 'format', vocabFloats('penalized', trace.penalized, '出现过的 token 被压低', 'amber')), { ds: { logits: [penaltyGrid(true)] } }),
        ],
      },
      {
        title: 'temperature 和 softmax',
        desc: `前 ${OPTIONS.topK} 名之外还有 ${pct(tailMass)} 的尾巴`,
        detail: `这一版采样器没有约束掩码，惩罚之后直接除以 temperature=${OPTIONS.temperature} 再做 softmax，得到 ${T.size} 个概率。第一名「${T.label(probTop[0].id)}」${pct(probTop[0].prob)}，第二名「${T.label(probTop[1].id)}」${pct(probTop[1].prob)}。概率排在 ${OPTIONS.topK} 名以后的 ${T.size - OPTIONS.topK} 个 token，加起来还有 ${pct(tailMass)}，如果直接抽，每一步都有这么大的概率抽到它们之一，而这些几乎都是和上下文不搭的 token。`,
        facts: probTop.slice(0, 3).map((item, i): [string, string] => [`第 ${i + 1} 名`, `${T.label(item.id)} ${pct(item.prob)}`]).concat([['尾部', `${T.size - OPTIONS.topK} 个，合计 ${pct(tailMass)}`]]),
        events: [
          pk('sampler', 'logits', 'green', `÷ ${OPTIONS.temperature}，softmax`, [`第一名 ${pct(probTop[0].prob)}`], [plainOps, 'ACT', `T=${OPTIONS.temperature}；第一名「${T.label(probTop[0].id)}」${pct(probTop[0].prob)}，${OPTIONS.topK} 名以后的尾巴合计 ${pct(tailMass)}`, T.size * 4],
            wire('概率分布', 'mem', 'format', vocabFloats('probs', trace.probs, `${T.size} 个概率，和为 1`, 'green')), { ds: { logits: [probRow()] } }),
          note('logits', '格子里是百分比，右边是被截断前的尾巴', 'green'),
        ],
      },
      {
        title: 'top-k 与 top-p 切掉尾巴',
        desc: `top-k=${OPTIONS.topK} 留 ${keptByK} 个，top-p=${OPTIONS.topP} 再留 ${keptByP} 个`,
        detail: `top-k 最简单：只留概率最高的 ${OPTIONS.topK} 个，其余丢掉。top-p（核采样）看累计概率：在 top-k 留下的候选里，把概率重新除以它们的和，从大到小累加，前 ${keptByP - 1} 个累计到 ${pct(keptCumulative[keptByP - 2])}，不到 ${OPTIONS.topP}，加上第 ${keptByP} 个到 ${pct(keptCumulative[keptByP - 1])}，超过了，到此为止，所以留 ${keptByP} 个。top-k 的数量固定，top-p 的数量随分布变化：分布尖时只留一两个，分布平时多留几个。`,
        facts: [['top-k', `${trace.ranked.length} → ${keptByK} 个`], ['top-p 累计', keptCumulative.map((value) => num(value, 3)).join(' → ')], ['top-p', `${keptByK} → ${keptByP} 个`]],
        events: [
          pk('sampler', 'logits', 'green', `top-k=${OPTIONS.topK}`, [`留 ${keptByK} 个`], [plainOps, 'SAMPLE', `按概率排序，只留前 ${OPTIONS.topK} 个：${trace.afterTopK.map((item) => T.label(item.id)).join('、')}`, keptByK * 12],
            wire('top-k 之后的候选数组', 'mem', 'internal', tokenDataLayer('candidates', trace.afterTopK.map((item) => ({ id: item.id, logit: item.logit, p: item.prob })), 'green')), { ds: { logits: [cutGrid(1)] } }),
          pk('sampler', 'logits', 'green', `top-p=${OPTIONS.topP}`, [`留 ${keptByP} 个`], [plainOps, 'SAMPLE', `重新归一化后累计 ${keptCumulative.map((value) => num(value, 3)).join('、')}，到第 ${keptByP} 个超过 ${OPTIONS.topP}，停`, keptByP * 12],
            wire('top-p 之后的候选数组', 'mem', 'internal', tokenDataLayer('candidates', trace.afterTopP.map((item) => ({ id: item.id, logit: item.logit, p: item.prob })), 'green')), { ds: { logits: [cutGrid(2)] } }),
        ],
      },
      {
        title: '重新归一化，抽样',
        desc: `u = ${num(trace.u!, 3)}，选中「${T.label(trace.chosen)}」`,
        detail: `留下的 ${keptByP} 个候选概率之和不是 1，所以先除以它们的和，重新归一化成 ${trace.final.map((item) => pct(item.p)).join('、')}。再抽 u = ${num(trace.u!, 3)}，选第一个累计概率超过 u 的，是「${T.label(trace.chosen)}」。被丢掉的 ${T.size - keptByP} 个 token 这一步不可能被选中，所以截断是用一点多样性换稳定。`,
        facts: [['留下', trace.final.map((item) => T.label(item.id)).join(' ')], ['归一化后', trace.final.map((item) => pct(item.p)).join(' ')], ['选中', T.label(trace.chosen)]],
        events: [
          pk('sampler', 'out', 'green', `选中 ${T.label(trace.chosen)}`, [`u=${num(trace.u!, 3)}`], [plainOps, 'SAMPLE', `${trace.final.map((item) => `${T.label(item.id)} ${pct(item.p)}`).join('，')}；u=${num(trace.u!, 4)} → 「${T.label(trace.chosen)}」`, 4],
            wire('选中的 token id', 'mem', 'format', tokenIds('next_token', [trace.chosen], { color: 'green', labels: (id) => T.label(id), summary: 'int32 小端' })), { ds: { logits: [finalRow()] } }),
        ],
      },
      {
        title: '有惩罚和没惩罚',
        desc: `没有惩罚复读 ${repeatCount(free.tokens)} 处，有惩罚 ${repeatCount(guarded.tokens)} 处`,
        detail: `把整套流程跑满 ${LENGTH} 个 token，两次的 temperature、top-k、top-p 和种子完全一样，只差重复惩罚。没有惩罚的一次又写出「${textOf(free.text.slice(0, 40))}…」，有 ${repeatCount(free.tokens)} 个 token 在重复；有惩罚的一次是「${textOf(guarded.text)}」，没有重复。惩罚太大也会出问题：连必须重复的词（人名、代码里的变量）都被压低，所以实际用的值都不大，常见的取值在 1.05 到 1.2 左右。`,
        facts: [['没有惩罚', `重复 ${repeatCount(free.tokens)} 个`], ['有惩罚', `重复 ${repeatCount(guarded.tokens)} 个`], ['惩罚值', String(PENALTY)]],
        events: [
          pk('sampler', 'out', 'blue', '没有惩罚', [`重复 ${repeatCount(free.tokens)} 个`], [freeOps, 'SAMPLE', `T=${OPTIONS.temperature}，top-k=${OPTIONS.topK}，top-p=${OPTIONS.topP}，种子 ${SEED}，无惩罚：${repeatCount(free.tokens)} 个复读`, bytesOf(free.tokens).length],
            runWire('没有重复惩罚的输出', free, 'blue'), { ds: { out: [outFree()] } }),
          pk('sampler', 'out', 'green', `惩罚 ${PENALTY}`, [`重复 ${repeatCount(guarded.tokens)} 个`], [guardedOps, 'SAMPLE', `同样的参数加 repetition_penalty=${PENALTY}：${repeatCount(guarded.tokens)} 个复读`, bytesOf(guarded.tokens).length],
            runWire('有重复惩罚的输出', guarded, 'green'), { ds: { out: [outGuarded()] } }),
          state('sampler', { 惩罚: String(PENALTY), T: String(OPTIONS.temperature), 'top-k': String(OPTIONS.topK), 'top-p': String(OPTIONS.topP) }),
          render,
        ],
      },
    ],
    outro: {
      title: '采样是一串可以调的旋钮',
      desc: '惩罚、temperature、top-k、top-p 依次作用在 logits 上',
      text: `常见 API 把这些旋钮直接暴露出来：temperature、top_p、frequency_penalty 和 presence_penalty，也有的提供 top_k 和 repetition_penalty。顺序会影响结果，Hugging Face 先 temperature 后 top-k、top-p，而 llama.cpp 默认把 temperature 放在最后，本站按前者。所有这些旋钮都只改变「在哪些 token 里抽」，不保证抽出来的东西合法。下一课让掩码出场：每一步只允许合法的 token，输出才能严格符合格式。`,
      facts: [['顺序', '惩罚 → 掩码 → T → top-k → top-p'], ['复读', `${repeatCount(free.tokens)} → ${repeatCount(guarded.tokens)} 处`], ['下一课', '约束解码']],
    },
  },
  ['out', 'tokens', 'logits'],
);

