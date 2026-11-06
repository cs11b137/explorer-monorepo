/**
 * 第三课：一次自注意力。第 0 层在「the model writes the next」5 个位置上的真实计算：
 * Q、K、V 投影 → 分成 2 个头 → 缩放点积 → 因果掩码 → softmax → 按权重加权 V → 输出投影。
 * 数字全部来自 replayLayer（和 forward 逐位相同），tests/narrative.repr.test.ts 核对。
 */
import { concept, floatMatrix, floatVector, wire } from '../decode/structures';
import { FlopMeter, MODEL } from '../model';
import { num } from './common';
import { note, pk, show, state } from './dsl';
import { argmaxOf, dimCols, fixed, LAST, PROMPT, PROMPT_IDS, PROMPT_LABELS, PROMPT_TRACE, replayLayer, vecGrid, vecRow } from './repr-common';
import type { GridPrim, Lesson, RowPrim, Tone } from './types';

const C = MODEL.config;
const D = C.dModel;
const HD = C.headDim;
const N = PROMPT_IDS.length;
const LABELS = PROMPT_LABELS;

const meter = new FlopMeter();
/** 第 0 层的重放：输入就是上一课查到的嵌入向量。 */
export const attnReplay = replayLayer(MODEL, 0, PROMPT_TRACE.positions.map((p) => p.embed), meter);
const S = attnReplay.steps;
const F = attnReplay.flops;

/** 每个位置在每个头上最关注谁。 */
export const focus = S.map((step) => step.heads.map((head) => argmaxOf(head.probs)));
const lastHeads = S[LAST].heads;
/** 第 4 位（␣next）在两个头上最关注的位置和权重。 */
export const lastFocus = lastHeads.map((head) => ({ at: argmaxOf(head.probs), p: Math.max(...head.probs) }));
const scale = 1 / Math.sqrt(HD);
/** 4 次矩阵乘（Q、K、V、输出投影）和注意力特有的两步（打分、加权求和）各花多少 FLOPs。 */
export const MATMUL_FLOPS = F.qkv + (F.wo - F.mix);
export const MIX_FLOPS = F.score - F.rope + (F.mix - F.softmax);

// ---------- 图元 ----------

const headTones: Tone[] = ['blue', 'violet'];

function inputGrid(tone?: Tone): GridPrim {
  return vecGrid('x', LABELS, dimCols(D), S.map((step) => step.attnNormed), { w: 36, tone: () => tone });
}

function outGrid(): GridPrim {
  return vecGrid('x', LABELS, dimCols(D), S.map((step) => step.attnOut), { w: 36, tone: (r) => (r === LAST ? 'green' : undefined) });
}

/** K 或 V：每行一个位置。head 给定时只上色这个头的 4 列。 */
function cacheGrid(which: 'k' | 'v', head?: number): GridPrim {
  const rows = S.map((step) => (which === 'k' ? step.kRope : step.v));
  const cols = Array.from({ length: D }, (_, i) => `${which}${i}`);
  return vecGrid(which, LABELS, cols, rows, { w: 34, tone: (_, c) => (head === undefined ? (which === 'k' ? 'teal' : 'amber') : Math.floor(c / HD) === head ? headTones[head] : 'dim') });
}

function qRow(head?: number): RowPrim {
  return vecRow('q', S[LAST].qRope, { w: 38, title: `q（${LABELS[LAST]}）`, tones: Object.fromEntries(S[LAST].qRope.map((_, i) => [i, head === undefined ? 'blue' : Math.floor(i / HD) === head ? headTones[head] : 'dim'])) });
}

type Cell = 'score' | 'mask' | 'prob';

/** 5 × 5 的分数矩阵：行是看的人（query），列是被看的（key）。 */
function scoreGrid(head: number, kind: Cell): GridPrim {
  const values = S.map((step, r) => LABELS.map((_, c) => (c > r ? null : kind === 'prob' ? step.heads[head].probs[c] : step.heads[head].scores[c])));
  return vecGrid('a', LABELS, LABELS, values, {
    w: 44,
    digits: 2,
    text: (r, c) => (c > r ? (kind === 'score' ? '' : kind === 'mask' ? '−∞' : '0') : fixed(values[r][c]!, 2)),
    tone: (r, c) => (c > r ? 'dim' : kind === 'prob' ? headTones[head] : r === LAST ? headTones[head] : undefined),
    heat: (r, c) => (kind === 'prob' && c <= r ? S[r].heads[head].probs[c] : undefined),
  });
}

function mixedRow(): RowPrim {
  return vecRow('m', S[LAST].mixed, { w: 38, title: `加权和（${LABELS[LAST]}）`, tones: Object.fromEntries(S[LAST].mixed.map((_, i) => [i, headTones[Math.floor(i / HD)]])) });
}

// ---------- 事件 ----------

const kvBytes = N * D * 4;
const probText = (head: number) => lastHeads[head].probs.map((p, s) => `${LABELS[s]} ${fixed(p, 2)}`).join('，');

export const attention: Lesson = {
  id: 'attention',
  name: 'SELF-ATTENTION',
  title: '一次自注意力（QKV、因果掩码、softmax）',
  group: 'repr',
  layer: [3, 4],
  layerNote: '输入是每个位置的向量，输出是按注意力权重混合之后的向量。',
  opsUnit: 'FLOPs：只计乘加，每次乘加算 2 次（投影的矩阵乘、q·k 点积、按权重加权 V）。softmax、掩码按惯例不计',
  opsShort: 'FLOPs',
  nodes: ['hidden', 'gpu', 'kv', 'attn'],
  place: { hidden: [200, 330], gpu: [560, 80], kv: [940, 300], attn: [600, 560] },
  labels: {
    hidden: ['输入向量', 'RMSNorm 之后，每行一个位置'],
    gpu: ['GPU', '第 0 层的注意力'],
    kv: ['K 和 V', '每个位置一行，会写进 KV cache'],
    attn: ['注意力', '分数、掩码和权重'],
  },
  labelAt: { hidden: [-150, 150], kv: [150, 150], attn: [-250, 90] },
  radius: { hidden: 100, kv: 100, attn: 100 },
  initial: { hidden: [inputGrid()], kv: [], attn: [] },
  start: ['hidden', 'gpu'],
  legend: [['blue', '头 0'], ['violet', '头 1'], ['teal', 'K'], ['amber', 'V'], [null, '运算量：FLOPs']],
  overview: {
    full: '每个 token 怎样去看它前面的 token',
    description: `注意力让每个位置从前面的位置收集信息。这一课真实运行迷你模型第 0 层的注意力：「${PROMPT}」的 ${N} 个向量各自投影出 Q、K、V，分成 ${C.nHeads} 个头，每个头用 q·k 打分，因果掩码挡住后面的位置，softmax 变成权重，再按权重把 V 加起来。你会看到最后一个 token「${LABELS[LAST]}」在两个头上看的是不同的词。`,
    facts: [
      ['输入', `${N} 个位置 × ${D} 维`],
      ['头', `${C.nHeads} 个 × ${HD} 维`],
      ['缩放', `1 / √${HD} = ${scale}`],
      ['掩码', '因果：只看自己和前面'],
      ['运算量', `${F.wo} FLOPs`],
    ],
  },
  steps: [
    {
      title: 'Q、K、V：三次投影',
      desc: `${N} 个位置各乘 3 个 ${D}×${D} 矩阵`,
      detail: `每个位置的向量分别乘 attn_q、attn_k、attn_v，得到 3 个 ${D} 维向量：q 是「我要找什么」，k 是「我这里有什么」，v 是「被看中时交出去的内容」。Q、K 接着按位置做 RoPE（上一课）。K、V 算出来就不再变，推理引擎把它们存进 KV cache，后面的 token 直接读。`,
      facts: [['投影', `3 × ${N} 次 ${D}×${D} 乘法`], ['FLOPs', String(F.qkv)], ['K + V', `${N} × ${D} × 2 个 fp32 = ${kvBytes * 2} 字节`]],
      events: [
        pk('hidden', 'gpu', 'blue', `${N} 个向量`, [`${N} × ${D} 个 fp32`], [0, 'NORM', `${N} 个位置的输入，已经过 RMSNorm`, N * D * 4],
          wire('注意力的输入', 'mem', 'format', floatMatrix('x_norm', S.map((step) => step.attnNormed), 'f32', { rowNames: (r) => `x[${r}]（${LABELS[r]}）`, summary: 'RMSNorm(x) ⊙ attn_norm，每行一个位置' })),
          { ds: { hidden: [inputGrid('blue')] } }),
        state('gpu', { 层: '0', 阶段: 'Q K V 投影', FLOPs: String(F.qkv) }),
        show('kv'),
        pk('gpu', 'kv', 'teal', 'K 和 V', [`K：${N} × ${D}`, `V：${N} × ${D}`], [F.qkv, 'MATMUL', `${N} 个位置的 K（已做 RoPE）和 V，共 ${kvBytes * 2} 字节`, kvBytes * 2],
          wire('这一层的 K、V', 'mem', 'format',
            floatMatrix('k', S.map((step) => step.kRope), 'f32', { color: 'teal', rowNames: (r) => `k[${r}]（${LABELS[r]}）`, summary: 'attn_k · x，再按位置旋转' }),
            floatMatrix('v', S.map((step) => step.v), 'f32', { color: 'amber', rowNames: (r) => `v[${r}]（${LABELS[r]}）`, summary: 'attn_v · x，不做 RoPE' })),
          { ds: { kv: [cacheGrid('k')], hidden: [inputGrid()] } }),
        show('attn'),
        pk('gpu', 'attn', 'blue', `q（${LABELS[LAST]}）`, [`${D} 个 fp32`], [F.qkv, 'MATMUL', `最后一个位置「${LABELS[LAST]}」的 q（已做 RoPE）`, D * 4],
          wire(`第 ${LAST} 位的 q`, 'mem', 'format', floatVector(`q[${LAST}]`, S[LAST].qRope, 'f32', { summary: 'attn_q · x，再按位置旋转' })),
          { ds: { attn: [qRow()] } }),
      ],
    },
    {
      title: '分成两个头，打分',
      desc: `每头 ${HD} 维，分数 = q·k / √${HD}`,
      detail: `${D} 维切成 ${C.nHeads} 段，每段 ${HD} 维是一个头，各自独立打分。第 i 行第 j 列是第 i 个位置的 q 和第 j 个位置的 k 的点积，再乘 1/√${HD} = ${scale}，免得维数大了分数跟着变大、softmax 变得过尖。每个位置只和自己及前面的位置打分，所以只有下三角有数。`,
      facts: [['头 0', `第 0–${HD - 1} 维`], ['头 1', `第 ${HD}–${D - 1} 维`], ['打分 FLOPs', String(F.score - F.rope)]],
      events: [
        state('gpu', { 层: '0', 阶段: 'q·k / √d', FLOPs: String(F.score) }),
        pk('kv', 'attn', 'blue', '头 0 打分', lastHeads[0].scores.map((s, j) => `${LABELS[j]} ${fixed(s, 2)}`), [F.score, 'ATTN', `头 0：「${LABELS[LAST]}」对前面 ${N} 个位置的分数 ${lastHeads[0].scores.map((s) => num(s, 3)).join('、')}`, N * 4],
          wire(`头 0 第 ${LAST} 行的分数`, 'mem', 'format', floatVector('scores', lastHeads[0].scores, 'f32', { names: (j) => `q[${LAST}]·k[${j}]（${LABELS[j]}）`, summary: `只有 ${N} 个：后面没有位置了` })),
          { ds: { kv: [cacheGrid('k', 0)], attn: [scoreGrid(0, 'score')] } }),
        note('attn', '只算下三角'),
      ],
    },
    {
      title: '因果掩码和 softmax',
      desc: '后面的位置记为 −∞，每行变成和为 1 的权重',
      detail: `生成时后面的 token 还不存在，所以训练和推理都把上三角当成 −∞，softmax 之后正好是 0。softmax 把每一行变成和为 1 的权重：「${LABELS[0]}」只能看自己，权重是 1；「${LABELS[LAST]}」在头 0 上最看重「${LABELS[lastFocus[0].at]}」（${num(lastFocus[0].p, 2)}），在头 1 上最看重「${LABELS[lastFocus[1].at]}」（${num(lastFocus[1].p, 2)}）。两个头学会了看不同的东西，这就是多头的用处。`,
      facts: [[`头 0 · ${LABELS[LAST]}`, `${LABELS[lastFocus[0].at]} ${num(lastFocus[0].p, 3)}`], [`头 1 · ${LABELS[LAST]}`, `${LABELS[lastFocus[1].at]} ${num(lastFocus[1].p, 3)}`], ['每行之和', '1']],
      events: [
        pk('gpu', 'attn', 'slate', '因果掩码', ['上三角 = −∞'], [F.score, 'ATTN', `第 i 行只保留第 0..i 列，其余 ${N * (N - 1) / 2} 格是 −∞`, null],
          wire('因果掩码', 'mem', '示意', maskConcept()),
          { ds: { attn: [scoreGrid(0, 'mask')] } }),
        pk('gpu', 'attn', 'blue', '头 0 softmax', lastHeads[0].probs.map((p, j) => `${LABELS[j]} ${fixed(p, 2)}`), [F.softmax, 'ATTN', `头 0 第 ${LAST} 行：${probText(0)}`, N * 4],
          wire(`头 0 第 ${LAST} 行的权重`, 'mem', 'format', floatVector('probs', lastHeads[0].probs, 'f32', { names: (j) => `p[${LAST}][${j}]（${LABELS[j]}）`, summary: 'exp(分数 − 最大值) / 求和，和为 1' })),
          { ds: { attn: [scoreGrid(0, 'prob')] } }),
        pk('gpu', 'attn', 'violet', '头 1 softmax', lastHeads[1].probs.map((p, j) => `${LABELS[j]} ${fixed(p, 2)}`), [F.softmax, 'ATTN', `头 1 第 ${LAST} 行：${probText(1)}`, N * 4],
          wire(`头 1 第 ${LAST} 行的权重`, 'mem', 'format', floatVector('probs', lastHeads[1].probs, 'f32', { color: 'violet', names: (j) => `p[${LAST}][${j}]（${LABELS[j]}）`, summary: '另一个头的分数不同，权重也不同' })),
          { ds: { attn: [scoreGrid(1, 'prob')], kv: [cacheGrid('k', 1)] } }),
        note('attn', `头 1：${LABELS[LAST]} → ${LABELS[lastFocus[1].at]}`, 'navy'),
      ],
    },
    {
      title: '按权重把 V 加起来',
      desc: `每个头得到 ${HD} 维，拼回 ${D} 维`,
      detail: `每个头用自己的权重，把各个位置的 v 在自己那 ${HD} 维上加权求和，权重大的位置贡献多。「${LABELS[LAST]}」在头 1 上的 ${HD} 维主要来自「${LABELS[lastFocus[1].at]}」的 v，它占了 ${num(lastFocus[1].p * 100, 1)}% 的权重。两个头的结果首尾相接，又是一个 ${D} 维向量。`,
      facts: [['加权 FLOPs', String(F.mix - F.softmax)], ['头 0', S[LAST].mixed.slice(0, HD).map((x) => num(x, 2)).join(' ')], ['头 1', S[LAST].mixed.slice(HD).map((x) => num(x, 2)).join(' ')]],
      events: [
        state('gpu', { 层: '0', 阶段: '加权求和', FLOPs: String(F.mix) }),
        pk('gpu', 'kv', 'amber', '读 V', [`V：${N} × ${D}`], [F.softmax, 'KV', `读出 ${N} 个位置的 v`, kvBytes],
          wire('这一层的 V', 'mem', 'format', floatMatrix('v', S.map((step) => step.v), 'f32', { color: 'amber', rowNames: (r) => `v[${r}]（${LABELS[r]}）` })),
          { ds: { kv: [cacheGrid('v')] } }),
        pk('kv', 'attn', 'amber', '加权求和', [`头 0：${S[LAST].mixed.slice(0, HD).map((x) => num(x, 2)).join(' ')}`, `头 1：${S[LAST].mixed.slice(HD).map((x) => num(x, 2)).join(' ')}`], [F.mix, 'ATTN', `「${LABELS[LAST]}」：Σ p[j] · v[j]，两个头各 ${HD} 维，拼成 ${D} 维`, D * 4],
          wire(`第 ${LAST} 位的加权和`, 'mem', 'format', floatVector('mixed', S[LAST].mixed, 'f32', { color: 'amber', names: (i) => `头 ${Math.floor(i / HD)}[${i % HD}]`, summary: '两个头的结果拼在一起' })),
          { ds: { attn: [mixedRow()] } }),
      ],
    },
    {
      title: '输出投影',
      desc: `再乘一个 ${D}×${D} 矩阵，交给残差流`,
      detail: `拼起来的向量再乘 attn_output，让两个头的结果混在一起，得到注意力的输出。整层注意力 ${N} 个位置一共 ${F.wo} FLOPs，其中 4 次矩阵乘占 ${MATMUL_FLOPS}，打分和加权求和只占 ${MIX_FLOPS}：上下文短的时候，算力主要花在矩阵乘上。下一课把这个输出加回残差流，再经过前馈网络。`,
      facts: [['输出投影 FLOPs', String(F.wo - F.mix)], ['这一层注意力', `${F.wo} FLOPs`], ['输出', `${N} × ${D}`]],
      events: [
        state('gpu', { 层: '0', 阶段: '输出投影', FLOPs: String(F.wo) }),
        pk('attn', 'gpu', 'amber', '加权和', [`${N} × ${D}`], [F.mix, 'ATTN', `${N} 个位置的加权和送去做输出投影`, N * D * 4],
          wire('各位置的加权和', 'mem', 'format', floatMatrix('mixed', S.map((step) => step.mixed), 'f32', { color: 'amber', rowNames: (r) => `mixed[${r}]（${LABELS[r]}）` }))),
        pk('gpu', 'hidden', 'green', 'attn_out', [`${N} × ${D} 个 fp32`], [F.wo, 'MATMUL', `attn_output · mixed：${N} 个位置的注意力输出`, N * D * 4],
          wire('注意力的输出', 'mem', 'format', floatMatrix('attn_out', S.map((step) => step.attnOut), 'f32', { color: 'green', rowNames: (r) => `out[${r}]（${LABELS[r]}）`, summary: '下一课加回残差流' })),
          { ds: { hidden: [outGrid()] } }),
        note('hidden', '下一课：加回残差流', 'green'),
      ],
    },
  ],
  outro: {
    title: '每个位置都看了一遍前面',
    desc: `${N} 个位置，${C.nHeads} 个头，${F.wo} FLOPs`,
    text: `真实模型的做法相同，只是头更多、更宽：LLaMA 2 7B 每层 32 个头，每头 128 维。打分和加权求和的运算量和上下文长度成正比，上下文越长，每生成一个 token 要看的位置越多；这也是 KV cache 要存下 K、V 的原因。推理引擎常用 FlashAttention 分块计算 softmax，不把整张分数矩阵写进显存，结果在数学上相同。`,
    facts: [['FLOPs', String(F.wo)], ['K、V', `${kvBytes * 2} 字节`], ['下一课', '一层 Transformer 前向']],
  },
};

/** 掩码的概念结构：每一行保留哪几格、挡住哪几格。 */
function maskConcept() {
  return concept('causal_mask', LABELS.map((label, r): [string, string, string] => [`第 ${r} 行（${label}）`, r === N - 1 ? `保留 0..${r}` : `保留 0..${r}，挡住 ${N - 1 - r} 格`, '被挡住的分数记为 −∞，softmax 之后是 0。']), 'slate', '没有字节：掩码通常在核函数里按下标判断，不单独存一张表');
}
