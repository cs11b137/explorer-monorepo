/**
 * 第四课：一层 Transformer 前向。跟着最后一个位置「␣next」的隐藏向量走完一层：
 * RMSNorm → 注意力 → 残差 → RMSNorm → SwiGLU → 残差；再走第 2 层，最后 RMSNorm + lm_head 得到 logits。
 * 两层都用 replayLayer 逐站重算（和 forward 逐位相同），tests/narrative.repr.test.ts 核对。
 */
import { floatMatrix, floatVector, wire } from '../decode/structures';
import { FlopMeter, FP32, matvec, MODEL, rmsnorm, silu, softmax, TOKENIZER } from '../model';
import { cellsOf, num, pct, shortLabel } from './common';
import { ds, note, pk, show } from './dsl';
import { argmaxOf, dimCols, fixed, LAST, norm2, PROMPT, PROMPT_IDS, PROMPT_LABELS, PROMPT_TRACE, replayLayer, topOf, vecGrid, vecRow } from './repr-common';
import type { Color, DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

const T = TOKENIZER;
const C = MODEL.config;
const D = C.dModel;
const N = PROMPT_IDS.length;
const WHO = PROMPT_LABELS[LAST];

const meter = new FlopMeter();
export const layer0 = replayLayer(MODEL, 0, PROMPT_TRACE.positions.map((p) => p.embed), meter);
export const layer1 = replayLayer(MODEL, 1, layer0.steps.map((step) => step.output), meter);
const A = layer0.steps[LAST];
const B = layer1.steps[LAST];
const F0 = layer0.flops;
const F1 = layer1.flops;
/** 最后的 RMSNorm 和 lm_head：生成下一个 token 只需要最后一个位置的 logits。 */
export const final = rmsnorm(B.output, MODEL.output_norm, C.eps);
const LMHEAD_BEFORE = meter.total;
export const logits = matvec(MODEL.output, final.y, FP32, meter, 'lmhead');
export const LMHEAD_FLOPS = meter.total - LMHEAD_BEFORE;
export const TOTAL_FLOPS = meter.total;
export const probs = softmax(logits);
export const top = topOf(logits, 5);
const BEST = top[0];

/** 隐藏向量在每一站的长度。 */
export const lengths = { embed: norm2(A.input), resid0: norm2(A.resid), out0: norm2(A.output), resid1: norm2(B.resid), out1: norm2(B.output) };
/** RMSNorm 除以 rms 之后（乘 γ 之前）的均方根，应该是 1。 */
export const unitRms = (() => {
  const unscaled = A.attnNormed.map((value, i) => value / MODEL.layers[0].attn_norm[i]);
  return Math.sqrt(unscaled.reduce((sum, value) => sum + value * value, 0) / D);
})();
/** silu 的最小值（z ≈ −1.28 处）。 */
export const SILU_MIN = Math.min(...Array.from({ length: 4001 }, (_, i) => silu(-4 + i / 500)));
/** gate 为负和为正的那些维，乘完之后 |act| 的最大值。 */
export const maxNegAct = Math.max(...A.act.filter((_, i) => A.gate[i] < 0).map(Math.abs));
export const maxPosAct = Math.max(...A.act.filter((_, i) => A.gate[i] >= 0).map(Math.abs));
/** 第 0 层注意力和 FFN 各自改动最大的维度。 */
export const biggest = (delta: readonly number[]) => argmaxOf(delta.map(Math.abs));

// ---------- 图元 ----------

function hiddenRow(values: readonly number[], title: string, changed?: readonly number[], tone: Tone = 'blue'): RowPrim {
  const at = changed ? biggest(changed) : -1;
  return vecRow('x', values, { w: 44, title, rest: tone, subs: dimCols(D), lift: at >= 0 ? [at] : [], marks: changed ? [{ at, text: `d${at} ${changed[at] >= 0 ? '+' : ''}${num(changed[at], 2)}`, color: 'green' }] : undefined });
}

function normRow(values: readonly number[], rms: number): RowPrim {
  return vecRow('n', values, { w: 44, title: `÷ ${num(rms, 3)} ⊙ γ`, rest: 'teal', subs: dimCols(D) });
}

const ROW_A: [number, number] = [26, -15];
const ROW_B: [number, number] = [-26, 15];
const ROW_C: [number, number] = [-78, 45];

function ffnRows(rows: Array<[string, readonly number[], Tone | ((value: number) => Tone)]>): RowPrim[] {
  const spots = rows.length === 2 ? [ROW_A, ROW_B] : [[78, -45] as [number, number], ROW_A, ROW_B].slice(0, rows.length);
  return rows.map(([title, values, tone], i) => {
    const tones = Object.fromEntries(values.map((value, j) => [j, typeof tone === 'function' ? tone(value) : tone]));
    return vecRow(`f${title}`, values, { at: spots[i] ?? ROW_C, w: 26, title, tones, subs: values.map((_, j) => (j % 4 === 0 ? String(j) : '')) });
  });
}

const signTone = (value: number): Tone => (value < 0 ? 'dim' : 'violet');

/** lm_head 的几行：最后的 h，加上得分最高的 3 个 token 的输出向量。 */
function headGrid(): GridPrim {
  const ids = top.slice(0, 3);
  const rows = [final.y, ...ids.map((id) => MODEL.output[id])];
  return vecGrid('w', ['h', ...ids.map((id) => shortLabel(id, 6))], dimCols(D), rows, { w: 38, tone: (r) => (r === 0 ? 'teal' : r === 1 ? 'green' : undefined) });
}

function logitRow(): RowPrim {
  const cells: DsCell[] = cellsOf(top.map((id) => fixed(logits[id], 1)), { subs: top.map((id) => shortLabel(id, 6)), tones: { 0: 'green' }, heat: top.map((id) => probs[id]) });
  return { kind: 'row', id: 'l', w: 50, cells, marks: [{ at: 0, text: pct(probs[BEST]), color: 'green' }] };
}

// ---------- 事件 ----------

const changedBy = (a: readonly number[], b: readonly number[]) => a.map((value, i) => value - b[i]);
const attnDelta = changedBy(A.resid, A.input);
const ffnDelta = changedBy(A.output, A.resid);
const vec = (name: string, values: readonly number[], color: Color, summary = '') => floatVector(name, values, 'f32', { color, summary });

export const block: Lesson = {
  id: 'block',
  name: 'TRANSFORMER BLOCK',
  title: '一层 Transformer 前向（残差、Norm、FFN）',
  group: 'repr',
  layer: [3, 5],
  layerNote: '跟着一个向量走完一层，再看两层叠起来怎样变成下一个 token 的分数。',
  opsUnit: `FLOPs：只计乘加，每次乘加算 2 次。${N} 个位置一起前向（注意力要用到所有位置的 K、V），lm_head 只算最后一个位置`,
  opsShort: 'FLOPs',
  nodes: ['hidden', 'norm', 'attn', 'ffn', 'lmhead', 'logits'],
  place: { hidden: [540, 380], norm: [540, 40], attn: [50, 180], ffn: [1040, 260], lmhead: [240, 650], logits: [880, 670] },
  labels: {
    hidden: ['残差流', `「${WHO}」这个位置的 x`],
    norm: ['RMSNorm', 'x ÷ rms ⊙ γ'],
    attn: ['注意力', '上一课的整套计算'],
    ffn: ['前馈网络', `SwiGLU：${D} → ${C.dFF} → ${D}`],
    lmhead: ['lm_head', `output.weight，${C.vocab} × ${D}`],
    logits: ['logits', '得分最高的 5 个 token'],
  },
  labelAt: { hidden: [-230, 70], norm: [210, -50], attn: [-20, 110], ffn: [-220, 120], lmhead: [-80, 150], logits: [-170, 60] },
  radius: { hidden: 90, norm: 80, attn: 80, ffn: 110, lmhead: 90, logits: 80 },
  initial: { hidden: [hiddenRow(A.input, 'x · 嵌入')], norm: [], attn: [], ffn: [], lmhead: [], logits: [] },
  start: ['hidden', 'norm'],
  legend: [['blue', '残差流 x'], ['teal', '归一化后'], ['violet', 'FFN 隐层'], ['green', '加回残差 / 最终结果'], [null, '运算量：FLOPs']],
  overview: {
    full: '一个向量怎样流过一层，又怎样变成下一个 token',
    description: `前两课得到了每个位置的向量和注意力输出。这一课跟着「${PROMPT}」最后一个位置「${WHO}」的向量，真实走完一层：RMSNorm、注意力、加回残差，再 RMSNorm、SwiGLU 前馈网络、再加回残差。迷你模型有 ${C.nLayers} 层（第 0 层和第 1 层），走完之后用 lm_head 给词表里 ${C.vocab} 个 token 各打一个分，得分最高的是「${T.label(BEST)}」。`,
    facts: [
      ['位置', `第 ${LAST} 位「${WHO}」`],
      ['结构', 'pre-norm：RMSNorm 在每个子层之前'],
      ['FFN', `SwiGLU，隐层 ${C.dFF}`],
      ['层数', String(C.nLayers)],
      ['运算量', `${TOTAL_FLOPS} FLOPs`],
    ],
  },
  steps: [
    {
      title: 'RMSNorm：先把尺度拉齐',
      desc: `rms = ${num(A.attnRms, 3)}，除完再乘 γ`,
      detail: `每个子层之前先做 RMSNorm：算出 ${D} 个数的均方根 rms = ${num(A.attnRms, 3)}，全部除以它，均方根就变成 1。再逐维乘上训练学到的 γ（attn_norm），决定每一维放大多少。LLaMA 用它代替 LayerNorm：不减均值，没有偏置，算起来更省。`,
      facts: [['rms', num(A.attnRms, 4)], ['γ', MODEL.layers[0].attn_norm.map((g) => num(g, 2)).join(' ')], ['FLOPs', '0（逐元素运算不计）']],
      events: [
        pk('hidden', 'norm', 'blue', `x（${WHO}）`, [`${D} 个 fp32`, `长度 ${num(lengths.embed, 2)}`], [F0.norm, 'NORM', `第 0 层的输入就是嵌入向量，rms = ${num(A.attnRms, 4)}`, D * 4],
          wire(`进入第 0 层的 x`, 'mem', 'format', floatVector('x', A.input, 'f32', { summary: '上一课查到的嵌入向量' })),
          { ds: { norm: [normRow(A.attnNormed, A.attnRms)] } }),
        note('norm', `均方根 = ${num(unitRms, 4)}，再乘 γ`),
      ],
    },
    {
      title: '注意力，加回残差',
      desc: `x + attn_out，长度 ${num(lengths.embed, 2)} → ${num(lengths.resid0, 2)}`,
      detail: `归一化后的向量交给注意力（上一课），${N} 个位置一起算，输出和 x 一样是 ${D} 维。注意力的输出不替换 x，而是加到 x 上，这条一路相加的通道叫残差流。改动最大的是第 ${biggest(attnDelta)} 维，${attnDelta[biggest(attnDelta)] >= 0 ? '加了' : '减了'} ${num(Math.abs(attnDelta[biggest(attnDelta)]), 2)}；每层只在原来的基础上做修改，层数很多时梯度也能顺着加法传回去。`,
      facts: [['注意力 FLOPs', String(F0.wo)], ['attn_out 长度', num(norm2(A.attnOut), 3)], ['x 长度', `${num(lengths.embed, 3)} → ${num(lengths.resid0, 3)}`]],
      events: [
        show('attn'),
        pk('norm', 'attn', 'teal', '进注意力', [`${N} 个位置`], [F0.wo, 'ATTN', `第 0 层注意力：Q K V 投影、打分、softmax、加权求和、输出投影，共 ${F0.wo} FLOPs`, N * D * 4],
          wire('归一化后的输入', 'mem', 'format', floatMatrix('x_norm', layer0.steps.map((step) => step.attnNormed), 'f32', { color: 'teal', rowNames: (r) => `x_norm[${r}]（${PROMPT_LABELS[r]}）` })),
          { ds: { attn: [vecRow('a', A.attnOut, { w: 40, title: 'attn_out', rest: 'amber', subs: dimCols(D) })] } }),
        pk('attn', 'hidden', 'green', '+ attn_out', [`长度 ${num(lengths.embed, 2)} → ${num(lengths.resid0, 2)}`], [F0.resid, 'ACT', `x + attn_out：第 ${biggest(attnDelta)} 维变化最大（${num(attnDelta[biggest(attnDelta)], 3)}）`, D * 4],
          wire('第一次加回残差', 'mem', 'format', vec('attn_out', A.attnOut, 'amber', '注意力的输出'), vec('x + attn_out', A.resid, 'green', '残差流的新值')),
          { ds: { hidden: [hiddenRow(A.resid, 'x · 注意力后', attnDelta)] } }),
      ],
    },
    {
      title: 'SwiGLU：升到 16 维',
      desc: `gate、up 各 ${C.dFF} 维，silu(gate) ⊙ up`,
      detail: `再做一次 RMSNorm（rms = ${num(A.ffnRms, 3)}），然后乘两个 ${C.dFF} × ${D} 的矩阵，得到 gate 和 up。silu(z) = z · sigmoid(z)：正数几乎原样通过，负数被压到很小（不小于 ${num(SILU_MIN, 3)}），所以 gate 像一排阀门，决定 up 的每一维放多少过去。这一位置的 gate 有 ${A.gate.filter((g) => g < 0).length} 维是负的，乘完之后这几维的绝对值都不超过 ${num(maxNegAct, 2)}，正的那些最大到 ${num(maxPosAct, 2)}。`,
      facts: [['ffn rms', num(A.ffnRms, 4)], ['gate < 0', `${A.gate.filter((g) => g < 0).length} / ${C.dFF} 维`], ['gate + up FLOPs', String(F0.gateUp - F0.ffnNorm)]],
      events: [
        pk('hidden', 'norm', 'blue', 'x（注意力后）', [`rms = ${num(A.ffnRms, 3)}`], [F0.ffnNorm, 'NORM', `第二个 RMSNorm，用 ffn_norm 的 γ，rms = ${num(A.ffnRms, 4)}`, D * 4],
          wire('进入前馈网络之前', 'mem', 'format', floatVector('x_norm', A.ffnNormed, 'f32', { color: 'teal', summary: 'RMSNorm(x) ⊙ ffn_norm' })),
          { ds: { norm: [normRow(A.ffnNormed, A.ffnRms)] } }),
        show('ffn'),
        pk('norm', 'ffn', 'violet', 'gate 和 up', [`2 × ${C.dFF} 维`], [F0.gateUp, 'MATMUL', `ffn_gate、ffn_up 各乘一次，${N} 个位置共 ${F0.gateUp - F0.ffnNorm} FLOPs`, C.dFF * 4 * 2],
          wire('两条分支', 'mem', 'format', floatVector('gate', A.gate, 'f32', { color: 'violet', summary: 'ffn_gate · x_norm' }), floatVector('up', A.up, 'f32', { color: 'blue', summary: 'ffn_up · x_norm' })),
          { ds: { ffn: ffnRows([['gate', A.gate, signTone], ['up', A.up, 'blue']]) } }),
        ds({ ffn: ffnRows([['gate', A.gate, signTone], ['silu(g)⊙up', A.act, 'violet']]) }),
        note('ffn', `${A.gate.filter((g) => g < 0).length} 维 gate 为负`, 'amber'),
      ],
    },
    {
      title: '降回 8 维，再加一次',
      desc: `一层结束，x 的长度变成 ${num(lengths.out0, 2)}`,
      detail: `ffn_down 把 ${C.dFF} 维降回 ${D} 维，结果同样加回残差流。到这里第 0 层就结束了：x 先后被注意力和前馈网络各改了一次，长度从 ${num(lengths.embed, 2)} 变成 ${num(lengths.out0, 2)}。注意力在位置之间搬运信息，前馈网络在每个位置内部加工，两者交替进行。`,
      facts: [['down FLOPs', String(F0.down - F0.act)], ['ffn_out 长度', num(norm2(A.ffnOut), 3)], ['第 0 层 FLOPs', String(F0.output)]],
      events: [
        pk('ffn', 'hidden', 'green', '+ ffn_out', [`长度 ${num(lengths.resid0, 2)} → ${num(lengths.out0, 2)}`], [F0.down, 'MATMUL', `ffn_down · act，加回残差：第 ${biggest(ffnDelta)} 维变化最大（${num(ffnDelta[biggest(ffnDelta)], 3)}）`, D * 4],
          wire('第二次加回残差', 'mem', 'format', floatVector('act', A.act, 'f32', { color: 'violet', summary: 'silu(gate) ⊙ up' }), vec('ffn_out', A.ffnOut, 'violet', 'ffn_down · act'), vec('x', A.output, 'green', '第 0 层的输出，也是第 1 层的输入')),
          { ds: { hidden: [hiddenRow(A.output, 'x · 第 0 层后', ffnDelta)], ffn: ffnRows([['silu(g)⊙up', A.act, 'violet']]).concat([vecRow('fd', A.ffnOut, { at: ROW_C, w: 30, title: 'ffn_out', rest: 'green', subs: dimCols(D) })]) } }),
      ],
    },
    {
      title: '第 1 层：同样的结构',
      desc: `换一套权重再走一遍，长度 ${num(lengths.out1, 2)}`,
      detail: `第 1 层的结构和第 0 层一模一样，只是权重不同，输入是第 0 层的输出。它的注意力里，「${WHO}」在两个头上最看重的是「${PROMPT_LABELS[argmaxOf(B.heads[0].probs)]}」和「${PROMPT_LABELS[argmaxOf(B.heads[1].probs)]}」。这一层的前馈网络改得很多，x 的长度从 ${num(lengths.resid1, 2)} 变成 ${num(lengths.out1, 2)}。`,
      facts: [['第 1 层 FLOPs', String(F1.output - F0.output)], ['两层累计', String(F1.output)], ['x 长度', `${num(lengths.out0, 2)} → ${num(lengths.out1, 2)}`]],
      events: [
        pk('hidden', 'norm', 'blue', '第 1 层', [`rms = ${num(B.attnRms, 3)}`], [F1.norm, 'NORM', `第 1 层的 RMSNorm，rms = ${num(B.attnRms, 4)}`, D * 4],
          wire('进入第 1 层的 x', 'mem', 'format', floatVector('x', B.input, 'f32', { summary: '第 0 层的输出' })),
          { ds: { norm: [normRow(B.attnNormed, B.attnRms)] } }),
        pk('norm', 'attn', 'teal', '第 1 层注意力', [`${N} 个位置`], [F1.wo, 'ATTN', `第 1 层注意力，${F1.wo - F1.norm} FLOPs`, D * 4],
          wire('第 1 层的注意力输出', 'mem', 'format', floatVector('attn_out', B.attnOut, 'f32', { color: 'amber' })),
          { quick: true, ds: { attn: [vecRow('a', B.attnOut, { w: 40, title: 'attn_out', rest: 'amber', subs: dimCols(D) })] } }),
        pk('attn', 'hidden', 'green', '+ attn_out', [`长度 → ${num(lengths.resid1, 2)}`], [F1.resid, 'ACT', '第 1 层：x + attn_out', D * 4],
          wire('第 1 层加回残差', 'mem', 'format', vec('x + attn_out', B.resid, 'green', '残差流的新值')),
          { quick: true, ds: { hidden: [hiddenRow(B.resid, 'x · 第 1 层注意力后', changedBy(B.resid, B.input))] } }),
        pk('hidden', 'norm', 'blue', 'RMSNorm', [`rms = ${num(B.ffnRms, 3)}`], [F1.ffnNorm, 'NORM', `第 1 层第二个 RMSNorm，rms = ${num(B.ffnRms, 4)}`, D * 4],
          wire('进入第 1 层前馈网络之前', 'mem', 'format', floatVector('x_norm', B.ffnNormed, 'f32', { color: 'teal' })),
          { quick: true, ds: { norm: [normRow(B.ffnNormed, B.ffnRms)] } }),
        pk('norm', 'ffn', 'violet', '第 1 层 FFN', ['gate、up、down'], [F1.down, 'MATMUL', `第 1 层前馈网络，${F1.down - F1.ffnNorm} FLOPs`, C.dFF * 4],
          wire('第 1 层前馈网络的隐层', 'mem', 'format', floatVector('act', B.act, 'f32', { color: 'violet', summary: 'silu(gate) ⊙ up' })),
          { quick: true, ds: { ffn: ffnRows([['silu(g)⊙up', B.act, 'violet']]).concat([vecRow('fd', B.ffnOut, { at: ROW_C, w: 30, title: 'ffn_out', rest: 'green', subs: dimCols(D) })]) } }),
        pk('ffn', 'hidden', 'green', '+ ffn_out', [`长度 ${num(lengths.resid1, 2)} → ${num(lengths.out1, 2)}`], [F1.output, 'ACT', `第 1 层结束，x 的长度 ${num(lengths.out1, 3)}`, D * 4],
          wire('两层之后的 x', 'mem', 'format', vec('x', B.output, 'green', '交给最后的 RMSNorm 和 lm_head')),
          { ds: { hidden: [hiddenRow(B.output, 'x · 第 1 层后', changedBy(B.output, B.resid))] } }),
      ],
    },
    {
      title: 'lm_head：变成 353 个分数',
      desc: `「${T.label(BEST)}」得分最高，概率 ${pct(probs[BEST])}`,
      detail: `最后再做一次 RMSNorm（output_norm），得到 h，然后和输出矩阵的每一行做点积：词表里 ${C.vocab} 个 token，每个得到一个分数，叫 logit。「${T.label(BEST)}」那一行和 h 的点积是 ${num(logits[BEST], 2)}，远高于第二名「${T.label(top[1])}」的 ${num(logits[top[1]], 2)}，softmax 之后它占 ${pct(probs[BEST])}。这一步只算最后一个位置，也要 ${LMHEAD_FLOPS} FLOPs，占整次前向的 ${pct(LMHEAD_FLOPS / TOTAL_FLOPS)}：迷你模型的词表比 d_model 大得多，真实模型的大头仍在各层里。`,
      facts: [['logit', `${T.label(BEST)} ${num(logits[BEST], 2)}`], ['第二名', `${T.label(top[1])} ${num(logits[top[1]], 2)}`], ['lm_head FLOPs', `2 × ${C.vocab} × ${D} = ${LMHEAD_FLOPS}`]],
      events: [
        show('lmhead'),
        pk('hidden', 'lmhead', 'teal', 'h = RMSNorm(x)', [`rms = ${num(final.rms, 3)}`], [LMHEAD_BEFORE, 'NORM', `最后的 RMSNorm（output_norm），rms = ${num(final.rms, 4)}`, D * 4],
          wire('lm_head 的输入', 'mem', 'format', floatVector('h', final.y, 'f32', { color: 'teal', summary: 'RMSNorm(x) ⊙ output_norm' })),
          { ds: { lmhead: [headGrid()] } }),
        show('logits'),
        pk('lmhead', 'logits', 'green', `${C.vocab} 个 logit`, top.slice(0, 3).map((id) => `${T.label(id)} ${num(logits[id], 2)}`), [TOTAL_FLOPS, 'LOGITS', `output · h：${C.vocab} 个分数，最高的是「${T.label(BEST)}」${num(logits[BEST], 3)}，概率 ${pct(probs[BEST])}`, C.vocab * 4],
          wire('lm_head 的输出', 'mem', 'format', floatVector('logits', logits, 'f32', { color: 'green', names: (id) => `logits[${id}]（${T.label(id)}）`, summary: `每个 token 一个分数，下标就是 token id；最高的是第 ${BEST} 个`, notes: Object.fromEntries(top.map((id, rank) => [id, `第 ${rank + 1} 名，softmax 之后 ${pct(probs[id])}。`])) })),
          { ds: { logits: [logitRow()] } }),
        note('logits', `下一个 token：${T.label(BEST)}`, 'green'),
      ],
    },
  ],
  outro: {
    title: '层层相加，最后打分',
    desc: `${C.nLayers} 层，${TOTAL_FLOPS} FLOPs，「${T.label(BEST)}」${pct(probs[BEST])}`,
    text: `真实模型把同样的一层叠很多次：LLaMA 2 7B 有 32 层，d_model 4096，SwiGLU 隐层 11008。每层的结构和这里完全相同，残差流从第一层一直加到最后一层，lm_head 只在最后用一次。拿到 logits 之后怎样选出下一个 token，是采样那几课的内容；下一课先看图像怎样变成和 token 一样的向量，进入同一条残差流。`,
    facts: [['层数', String(C.nLayers)], ['FLOPs', String(TOTAL_FLOPS)], ['下一课', '图像切 patch 变 token']],
  },
};
