/**
 * 第十一课：temperature。拿模型对一个真实提示词的 logits，看 T=0 / 0.7 / 1 / 1.5 下分布怎么变，
 * 再用同一个种子抽出四段不同的续写。文案里的数字全部取自下面导出的计算结果，tests/narrative.sample.test.ts 核对。
 */
import { rawBytes, tokenIds, utf8Text, wire, floatVector } from '../decode/structures';
import { MODEL } from '../model';
import { mulberry32 } from '@explorer/llm-core/prng';
import { sample } from '../model/sample';
import { forward } from '../model/transformer';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { colLabels, entropyBits, heatOf, labelBelow, promptLogits, sampledRun, vocabFloats } from './sample-common';
import { cellsOf, num, pct, shortLabel } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

const T = TOKENIZER;

export const PROMPT = 'the tokenizer';
/** 展示用的几档 temperature。 */
export const TEMPS = [0.7, 1, 1.5] as const;
/** 固定种子：同一个种子、同样的 logits，永远抽到同一个 token。 */
export const SEED = 39;
/** 续写的 token 数。 */
export const LENGTH = 8;
/** 图里画前几名候选。 */
export const SHOWN = 6;

export const base = promptLogits(PROMPT);
const lastTrace = forward(MODEL, base.ids, { lastLogitsOnly: true }).positions.at(-1)!;

/** 每档 temperature 的一次完整采样（同一个种子，所以第一个随机数相同）。 */
export const runs = TEMPS.map((t) => sample(base.logits, [], { temperature: t }, mulberry32(SEED)));
export const greedy = sample(base.logits, [], { temperature: 0 });
const TOP = runs[1].ranked.slice(0, SHOWN).map((item) => item.id);
const LABELS = colLabels(TOP);

/** 前几名之外的所有 token（尾部）占的总概率。 */
export const tailMass = runs.map((run) => 1 - run.ranked.slice(0, SHOWN).reduce((sum, item) => sum + item.prob, 0));
export const entropies = runs.map((run) => entropyBits(run.probs));
export const topProbs = runs.map((run) => run.ranked[0].prob);
/** 第一名领先第二名的 logit 差（除以 T 之前）。 */
export const gap = base.logits[TOP[0]] - base.logits[TOP[1]];
/** 均匀分布的熵：词表大小取 log2。 */
export const maxEntropy = Math.log2(T.size);

// ---------- 续写：四种 temperature，同一个种子 ----------

const CONTINUE_T = [0, ...TEMPS] as const;
export const continuations = CONTINUE_T.map((t) => sampledRun(base.ids, { temperature: t }, t === 0 ? null : SEED, LENGTH, false));
/** 续写和贪心续写开头相同的 token 数。 */
export const sharedPrefix = continuations.map((run) => {
  let n = 0;
  while (n < run.tokens.length && n < continuations[0].tokens.length && run.tokens[n] === continuations[0].tokens[n]) n++;
  return n;
});
const decodeOps = continuations.map((_, i) => base.flops + continuations.slice(0, i + 1).reduce((sum, run) => sum + run.decodeFlops, 0));

// ---------- 图元 ----------

const logitRow = (): RowPrim => ({
  kind: 'row',
  id: 'z',
  w: 44,
  cells: cellsOf(TOP.map((id) => num(base.logits[id], 1)), { subs: LABELS, tones: { 0: 'amber' } }),
  marks: [{ at: 0, text: '最大', color: 'amber' }],
});

const scaledGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'z',
  w: 38,
  rows: TEMPS.map((t) => `T=${t}`),
  cols: LABELS,
  cells: runs.map((run): DsCell[] => TOP.map((id, c) => ({ v: num(run.scaled[id], 1), tone: c === 0 ? 'amber' : undefined }))),
});

const probGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'z',
  w: 38,
  rows: TEMPS.map((t) => `T=${t}`),
  cols: LABELS,
  cells: runs.map((run): DsCell[] => TOP.map((id) => ({ v: pct(run.probs[id]).replace('%', ''), tone: 'green', heat: heatOf(run.probs[id]) }))),
});

const chosenT1 = runs[1];
const chosenIndex = TOP.indexOf(chosenT1.chosen);
const cumulativeRow = (): RowPrim => ({
  kind: 'row',
  id: 'z',
  w: 44,
  cells: cellsOf(TOP.map((_, i) => num(chosenT1.final[i].cumulative, 2)), { subs: LABELS, tones: { [chosenIndex]: 'green' } }),
  marks: [{ at: chosenIndex, text: `u = ${num(chosenT1.u!, 3)}`, color: 'green' }],
});

const hiddenRow = (): RowPrim => ({ kind: 'row', id: 'h', w: 34, cells: cellsOf(lastTrace.finalNormed.map((value) => num(value, 2)), { rest: 'violet' }), marks: [{ at: 3, text: '最后位置的向量', color: 'violet' }] });

const outGrid = (done: number): GridPrim => ({
  kind: 'grid',
  id: 'o',
  w: 32,
  rows: CONTINUE_T.map((t) => `T=${t}`),
  cols: Array.from({ length: LENGTH }, (_, i) => String(i + 1)),
  cells: continuations.map((run, r): DsCell[] =>
    Array.from({ length: LENGTH }, (_, c) => (r < done && c < run.tokens.length ? { v: shortLabel(run.tokens[c], 4), tone: r === 0 ? 'blue' : 'green' } : { v: '', tone: 'empty' })),
  ),
});

const fmtT = (t: number) => (t === 0 ? 'T=0（贪心）' : `T=${t}`);
const topLabel = (i: number) => T.label(TOP[i]);

export const temperature: Lesson = labelBelow(
  {
    id: 'temperature',
    name: 'TEMPERATURE',
    title: 'logits → temperature → softmax',
    group: 'sample',
    layer: [5, 6],
    layerNote: '模型层的输出是 logits，推理引擎里的采样器负责把它变成下一个 token。',
    opsUnit: 'FLOPs：提示词预填充一次，之后每个续写 token 一次解码；除以 T、softmax、抽样都是逐元素运算，不计入',
    opsShort: 'FLOPs',
    nodes: ['client', 'lmhead', 'logits', 'sampler', 'out'],
    place: { client: [110, 100], lmhead: [330, 100], logits: [700, 170], sampler: [330, 360], out: [700, 480] },
    labels: {
      client: ['应用', 'generate(prompt, temperature, seed)'],
      lmhead: ['输出层', '隐藏向量 × 输出矩阵'],
      logits: ['logits 与概率', `${T.size} 个 token，各一个分数`],
      sampler: ['采样器', '÷ T → softmax → 抽样'],
      out: ['续写', `同一个种子，${LENGTH} 个 token`],
    },
    radius: { lmhead: 50, logits: 50, out: 50 },
    initial: { logits: [], lmhead: [], out: [] },
    start: ['client', 'sampler', 'lmhead'],
    legend: [['amber', '最大的 logit / 最大的一档'], ['green', '概率（越深越大）'], ['violet', '隐藏向量'], [null, '运算量：前向的 FLOPs']],
    overview: {
      full: '同一组 logits，换一个 T，分布就不一样',
      description: `模型每一步的输出是 ${T.size} 个 logit，每个 token 一个分数。这一课用真实的迷你模型读「${PROMPT}」，拿到最后一个位置的 logits，再看采样器怎样先除以 temperature、再做 softmax：T 越小分布越尖，T 越大越平。最后用同一个种子 ${SEED}，在 T=0、${TEMPS.join('、')} 下各续写 ${LENGTH} 个 token，看它们从哪里开始分叉。`,
      facts: [
        ['提示词', `「${PROMPT}」，${base.ids.length} 个 token`],
        ['候选', `${T.size} 个 token`],
        ['T 的取值', `0（贪心）、${TEMPS.join('、')}`],
        ['随机种子', `mulberry32(${SEED})`],
        ['续写', `每档 ${LENGTH} 个 token`],
        ['运算量', 'FLOPs（前向）'],
      ],
    },
    steps: [
      {
        title: '模型给出 logits',
        desc: `${T.size} 个分数，最大的是「${topLabel(0)}」`,
        detail: `模型读完提示词，最后一个位置的隐藏向量乘输出矩阵，得到 ${T.size} 个 logit，每个 token 一个。logit 是没有归一化的分数，可以是任意实数，越大表示模型越倾向这个 token，但它们的和不是 1，也不是概率。最大的是「${topLabel(0)}」（${num(base.logits[TOP[0]], 1)}），其次是「${topLabel(1)}」（${num(base.logits[TOP[1]], 1)}）。`,
        facts: [['提示词', base.ids.map((id) => T.label(id)).join(' ')], ['logits', `${T.size} 个 fp32`], ['最大', `${topLabel(0)} ${num(base.logits[TOP[0]], 2)}`], ['前向', `${base.flops} FLOPs`]],
        events: [
          type(`generate("${PROMPT}", temperature=…, seed=${SEED})`),
          show('logits', 'out'),
          pk('client', 'lmhead', 'blue', '前向', [`${base.ids.length} 个 token`], [base.flops, 'MATMUL', `读完 ${base.ids.length} 个提示词 token，取最后一个位置的 ${lastTrace.finalNormed.length} 维隐藏向量`, lastTrace.finalNormed.length * 4],
            wire('最后一个位置、经过最终 RMSNorm 的隐藏向量', 'mem', 'format', floatVector('finalNormed', lastTrace.finalNormed, 'f32', { color: 'violet', summary: '交给输出层的向量' })),
            { ds: { lmhead: [hiddenRow()] } }),
          pk('lmhead', 'logits', 'amber', 'logits', [`${T.size} 个分数`], [base.flops, 'LOGITS', `输出矩阵 ${T.size}×${lastTrace.finalNormed.length} 乘隐藏向量，得到 ${T.size} 个 logit；最大的是「${topLabel(0)}」${num(base.logits[TOP[0]], 2)}`, T.size * 4],
            wire('logits：每个词表项一个 fp32', 'mem', 'format', vocabFloats('logits', base.logits, `${T.size} 个 fp32，按 token id 排列`, 'amber')),
            { ds: { logits: [logitRow()] } }),
        ],
      },
      {
        title: '除以 temperature',
        desc: `T 越小，第一名领先越多`,
        detail: `采样器先把每个 logit 除以 T。第一名「${topLabel(0)}」比第二名「${topLabel(1)}」高 ${num(gap, 2)}，除以 0.7 变成 ${num(gap / 0.7, 2)}，除以 1.5 只剩 ${num(gap / 1.5, 2)}。除以小于 1 的数会把差距拉大，除以大于 1 的数会把差距压小；T=1 不改变任何东西。`,
        facts: [['原始差距', num(gap, 2)], ...TEMPS.map((t): [string, string] => [`T=${t}`, `差距 ${num(gap / t, 2)}`])],
        events: [
          ...TEMPS.map((t, i) =>
            pk('logits', 'sampler', 'amber', `÷ ${t}`, [`T=${t}`], [base.flops, 'ACT', `${T.size} 个 logit 全部除以 ${t}；第一名领先 ${num(gap / t, 2)}`, T.size * 4],
              wire(`logits ÷ ${t}`, 'mem', 'format', vocabFloats(`logits÷${t}`, runs[i].scaled, `每个 logit 除以 ${t}，再按 fp32 存`, 'amber')),
              { ds: { logits: [{ ...scaledGrid(), cells: scaledGrid().cells.map((row, r) => (r <= i ? row : row.map(() => ({ v: '', tone: 'empty' as const })))) }] } }),
          ),
          note('logits', '除以 T 只改变差距，不改变排名', 'amber'),
        ],
      },
      {
        title: 'softmax 变成概率',
        desc: `第一名的概率：${TEMPS.map((t, i) => `T=${t} 为 ${pct(topProbs[i])}`).join('，')}`,
        detail: `softmax 对每个分数取指数再除以总和，得到 ${T.size} 个加起来等于 1 的概率。分数拉得开，第一名几乎独占概率；分数压得近，概率就摊开。熵衡量这种分散程度：T=${TEMPS[0]} 时是 ${num(entropies[0], 2)} bit，T=${TEMPS[1]} 时是 ${num(entropies[1], 2)} bit，T=${TEMPS[2]} 时是 ${num(entropies[2], 2)} bit，全词表均匀分布则是 ${num(maxEntropy, 2)} bit。`,
        facts: [...TEMPS.map((t, i): [string, string] => [`T=${t}`, `第一名 ${pct(topProbs[i])}，熵 ${num(entropies[i], 2)} bit`]), ['前 6 名之外', `T=1 占 ${pct(tailMass[1])}，T=1.5 占 ${pct(tailMass[2])}`]],
        events: [
          ...TEMPS.map((t, i) =>
            pk('sampler', 'logits', 'green', 'softmax', [`T=${t}`, `第一名 ${pct(topProbs[i])}`], [base.flops, 'ACT', `T=${t}：第一名「${topLabel(0)}」${pct(topProbs[i])}，熵 ${num(entropies[i], 2)} bit`, T.size * 4],
              wire(`T=${t} 的概率分布`, 'mem', 'format', vocabFloats(`probs(T=${t})`, runs[i].probs, `${T.size} 个概率，和为 1`, 'green')),
              { ds: { logits: [{ ...probGrid(), cells: probGrid().cells.map((row, r) => (r <= i ? row : row.map(() => ({ v: '', tone: 'empty' as const })))) }] } }),
          ),
          note('logits', '格子里是百分比，越深概率越大', 'green'),
        ],
      },
      {
        title: '抽样：用随机数选一个',
        desc: `u = ${num(chosenT1.u!, 3)}，落在「${T.label(chosenT1.chosen)}」`,
        detail: `T>0 时采样器把概率从大到小排好，算出累计概率，再抽一个 [0, 1) 的随机数 u，选第一个累计概率超过 u 的 token。这里种子是 ${SEED}，T=1 时 u = ${num(chosenT1.u!, 3)}，落在「${T.label(chosenT1.chosen)}」的区间里。T=0 不抽签：实现里直接取 logit 最大的「${T.label(greedy.chosen)}」，这叫贪心解码，同样的输入永远得到同样的输出。`,
        facts: [['种子', String(SEED)], ['u', num(chosenT1.u!, 4)], ['T=1 选中', T.label(chosenT1.chosen)], ['T=0 选中', `${T.label(greedy.chosen)}（不抽签）`]],
        events: [
          pk('sampler', 'out', 'green', `选中 ${T.label(chosenT1.chosen)}`, [`u=${num(chosenT1.u!, 3)}`, `id ${chosenT1.chosen}`], [base.flops, 'SAMPLE', `T=1：累计概率第一次超过 u=${num(chosenT1.u!, 4)} 的是「${T.label(chosenT1.chosen)}」；T=0 则直接取最大的「${T.label(greedy.chosen)}」`, 4],
            wire('采样器的输出：下一个 token 的 id', 'mem', 'format', tokenIds('next_token', [chosenT1.chosen], { color: 'green', labels: (id) => T.label(id), summary: 'int32 小端' })),
            { ds: { logits: [cumulativeRow()] } }),
        ],
      },
      {
        title: '同一个种子，四种续写',
        desc: `T 越高，越早偏离贪心的结果`,
        detail: `把上面的过程重复 ${LENGTH} 次，每次把选中的 token 接回输入。种子都是 ${SEED}，各档只有 T 不同。和贪心结果开头相同的 token 数：T=0.7 是 ${sharedPrefix[1]}，T=1 是 ${sharedPrefix[2]}，T=1.5 是 ${sharedPrefix[3]}。T 越高越容易在某一步抽到排名靠后的 token，后面的内容跟着改变，这是随机采样可以写出不同内容的原因，也是它会写出怪东西的原因。`,
        facts: continuations.map((run, i): [string, string] => [fmtT(CONTINUE_T[i]), `「${run.text.replace(/ /g, '␣')}」`]),
        events: [
          ...continuations.map((run, i) =>
            pk('sampler', 'out', i === 0 ? 'blue' : 'green', fmtT(CONTINUE_T[i]), [`「${run.text.replace(/ /g, '␣')}」`], [decodeOps[i], 'SAMPLE', `${fmtT(CONTINUE_T[i])}：${run.tokens.length} 个 token，与贪心结果开头 ${sharedPrefix[i]} 个相同`, run.tokens.reduce((sum, id) => sum + T.bytesOf(id).length, 0)],
              wire(`${fmtT(CONTINUE_T[i])} 的续写`, 'mem', 'format',
                rawBytes('生成的字节', run.tokens.flatMap((id) => T.bytesOf(id)), { color: i === 0 ? 'blue' : 'green', groups: run.tokens.map((id) => ({ name: T.label(id), bytes: T.bytesOf(id) })) }),
                utf8Text('文本', run.text, { color: 'slate' })),
              { ds: { out: [outGrid(i + 1)] } }),
          ),
          state('sampler', { 种子: String(SEED), T: '0 / 0.7 / 1 / 1.5' }),
          render,
        ],
      },
    ],
    outro: {
      title: '温度调的是分布，不是模型',
      desc: `T 越高，越敢选排名靠后的 token`,
      text: `模型的参数没变，变的只是采样器怎样看这 ${T.size} 个分数。真实 API 里的 temperature 就是这一步：事实问答、代码、结构化输出常用低 T，写故事、起名字常用高 T。T=0 在真实服务里也不一定每次逐字相同：并行求和的顺序、批次组合不同，logits 的末几位会有微小差异，两个分数接近时结果就可能翻转。但 T 调高之后，概率尾部那些离谱的 token 也会被抽中，下一课用 Top-K 和 Top-P 把尾部切掉。`,
      facts: [['T=0', '贪心，取最大'], ['T 越大', '分布越平，熵越大'], ['下一课', 'Top-K / Top-P / 重复惩罚']],
    },
  },
  ['logits', 'out', 'lmhead'],
);
