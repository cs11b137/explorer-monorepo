/**
 * 第二课：嵌入查表与 RoPE。token id 是嵌入表的行号；查到的向量没有位置，
 * 位置由 RoPE 在注意力里加上：按位置把 Q、K 的每两维转一个角度，点积里只剩下相对位置。
 * 数字全部来自 MODEL 的嵌入表和第 0 层的真实计算，tests/narrative.repr.test.ts 核对。
 */
import { concept, floatMatrix, floatVector, tokenIds, wire } from '../decode/structures';
import { dot, f16Round, FlopMeter, FP32, FP64, matvec, MODEL, rmsnorm, rope, ropeFreq, TOKENIZER } from '../model';
import { cellsOf, num, shortLabel } from './common';
import { note, pk, show, state } from './dsl';
import { dimCols, headScore, LAST, PROMPT, PROMPT_IDS, PROMPT_LABELS, vecGrid, vecRow } from './repr-common';
import type { GridPrim, Lesson, RowPrim } from './types';

const T = TOKENIZER;
const C = MODEL.config;
const D = C.dModel;
const E = MODEL.token_embd;

/** 查到的 5 行。 */
export const embedRows = PROMPT_IDS.map((id) => E[id]);
/** 嵌入表的字节数：fp32 和 fp16 两种存法。 */
export const tableBytes = { f32: E.length * D * 4, f16: E.length * D * 2 };
/** 每一行在 token_embd 里的字节偏移。 */
export const rowOffset = (id: number): number => id * D * 4;

const NEXT = PROMPT_IDS[LAST];
const nextRow = embedRows[LAST];
/** ␣next 这一行存成 fp16 之后的值和最大误差。 */
export const nextF16 = nextRow.map(f16Round);
export const f16MaxError = Math.max(...nextRow.map((value, i) => Math.abs(value - nextF16[i])));
/** LLaMA 2 7B 的嵌入表：32000 个 token × 4096 维，fp16。 */
export const LLAMA_TABLE = { vocab: 32000, dModel: 4096, bytes: 32000 * 4096 * 2 };

// ---------- 第 0 层的 Q、K 投影和 RoPE ----------

/** 这一课累计的 FLOPs：Q、K、V 投影，再加上下面算的几次点积。 */
const meter = new FlopMeter();
const L0 = MODEL.layers[0];
/** 第 0 层：RMSNorm 之后乘 attn_q、attn_k、attn_v，再按位置旋转 Q、K。和 forward 的运算完全相同。 */
export const qkv = embedRows.map((x, pos) => {
  const { y } = rmsnorm(x, L0.attn_norm, C.eps);
  const q = matvec(L0.attn_q, y, FP32, meter, 'qkv');
  const k = matvec(L0.attn_k, y, FP32, meter, 'qkv');
  const v = matvec(L0.attn_v, y, FP32, meter, 'qkv');
  return { q, k, v, qRope: rope(q, pos, C), kRope: rope(k, pos, C) };
});
const QKV_FLOPS = meter.total;
/** 看的人在第 4 位（␣next），被看的在第 3 位（␣the）。 */
const QP = LAST;
const KP = LAST - 1;
export const ropeQ = { before: qkv[QP].q, after: qkv[QP].qRope };
export const ropeK = { before: qkv[KP].k, after: qkv[KP].kRope };
/** 两组的频率：第 0 组每个位置转 1 弧度，第 1 组转 0.01 弧度。 */
export const freqs = Array.from({ length: C.headDim / 2 }, (_, i) => ropeFreq(C, i));
/** 每个头第 pair 组两维的长度。 */
export const pairLength = (v: readonly number[], head: number, pair: number): number => Math.hypot(v[head * C.headDim + 2 * pair], v[head * C.headDim + 2 * pair + 1]);

/** 一对 q、k 在第 m、n 位时两个头的分数，以及算完之后的累计 FLOPs。 */
export interface PlacedScore {
  m: number;
  n: number;
  scores: number[];
  flops: number;
}
const placed = (m: number, n: number, q: number[], k: number[], round: (x: number) => number): PlacedScore => {
  const scores = Array.from({ length: C.nHeads }, (_, h) => round(headScore(q, k, h, C.headDim, meter)));
  return { m, n, scores, flops: meter.total };
};
/** 模型里真实的分数：fp32 的 q_rope[4]·k_rope[3] / √4。 */
export const realScore = placed(QP, KP, ropeQ.after, ropeK.after, FP32);
/** 同一对 q、k 换到别的位置重新旋转（float64，只看 RoPE 本身）。前两个和真实分数相隔一样，最后一个相隔更远。 */
export const shiftedAt = (m: number, n: number, meterless = false): PlacedScore => {
  if (meterless) {
    const q = rope(ropeQ.before, m, C, FP64);
    const k = rope(ropeK.before, n, C, FP64);
    return { m, n, scores: Array.from({ length: C.nHeads }, (_, h) => dot(q.slice(h * C.headDim, (h + 1) * C.headDim), k.slice(h * C.headDim, (h + 1) * C.headDim)) / Math.sqrt(C.headDim)), flops: 0 };
  }
  return placed(m, n, rope(ropeQ.before, m, C, FP64), rope(ropeK.before, n, C, FP64), (x) => x);
};
export const shifted: PlacedScore[] = [shiftedAt(QP + 5, KP + 5), shiftedAt(QP + 16, KP + 16), shiftedAt(QP, 0)];
/** 文案、格子里按顺序出现的分数。 */
const SCORES = [realScore, ...shifted];

// ---------- 图元 ----------

const ROW_HEADS = PROMPT_IDS.map(String);

function tokenRow(lift?: number): RowPrim {
  return { kind: 'row', id: 't', w: 52, cells: cellsOf(PROMPT_IDS, { subs: PROMPT_IDS.map((id) => shortLabel(id, 7)), lift: lift === undefined ? [] : [lift], tones: lift === undefined ? {} : { [lift]: 'blue' } }) };
}

/** 嵌入表里查到的行，前 filled 行有值。 */
function tableGrid(filled: number, extra?: { row: string; values: number[] }): GridPrim {
  const values: Array<Array<number | null>> = embedRows.map((row, r) => (r < filled ? row : row.map(() => null)));
  const rows = [...ROW_HEADS];
  if (extra) {
    values.push(extra.values);
    rows.push(extra.row);
  }
  return vecGrid('e', rows, dimCols(D), values, { w: 40, tone: (r) => (r === filled - 1 && !extra ? 'blue' : extra && r === values.length - 1 ? 'amber' : extra && r === LAST ? 'blue' : undefined) });
}

const ROW_A: [number, number] = [34, -20];
const ROW_B: [number, number] = [-34, 20];

function qkRows(q: number[], k: number[], tone?: 'amber', marks = false): RowPrim[] {
  const subs = dimCols(D);
  return [
    vecRow('q', q, { at: ROW_A, w: 40, title: `q（第 ${QP} 位）`, rest: tone, subs, marks: marks ? freqs.map((f, i) => ({ at: 2 * i, text: `组 ${i} 转 ${num(QP * f, 2)}`, color: 'amber' as const })) : undefined }),
    vecRow('k', k, { at: ROW_B, w: 40, title: `k（第 ${KP} 位）`, rest: tone, subs }),
  ];
}

function scoreGrid(count: number): GridPrim {
  const list = SCORES.slice(0, count);
  return vecGrid('s', list.map((item) => `${item.m}·${item.n}`), ['头 0', '头 1'], list.map((item) => item.scores), { w: 52, digits: 4, tone: (r) => (list[r].m - list[r].n === QP - KP ? 'green' : 'violet') });
}

// ---------- 事件 ----------

const label = (id: number) => T.label(id);
const lookups = PROMPT_IDS.map((id, i) =>
  pk('weights', 'embed', 'blue', `第 ${id} 行`, [`${label(id)} → token_embd[${id}]`, `偏移 ${rowOffset(id)} 字节`], [0, 'LOOKUP', `「${label(id)}」的 id 是 ${id}，取嵌入表第 ${id} 行，从第 ${rowOffset(id)} 个字节开始读 ${D * 4} 字节`, D * 4],
    wire(`token_embd 第 ${id} 行`, 'mem', 'format', floatVector(`token_embd[${id}]`, embedRows[i], 'f32', { summary: `行优先存放，第 ${id} 行从 ${id} × ${D} × 4 = ${rowOffset(id)} 字节开始` })),
    { quick: i > 0, ds: { tokens: [tokenRow(i)], embed: [tableGrid(i + 1)] } }),
);

const pairNames = (i: number) => `头${Math.floor(i / C.headDim)}[${i % C.headDim}]`;

export const embed: Lesson = {
  id: 'embed',
  name: 'EMBEDDING & ROPE',
  title: '嵌入查表与 RoPE',
  group: 'repr',
  layer: [2, 3],
  layerNote: '从 token id 查到向量，再给注意力用的向量加上位置。',
  opsUnit: 'FLOPs：只计乘加，每次乘加算 2 次。查表只是读内存，不算浮点运算',
  opsShort: 'FLOPs',
  nodes: ['tokens', 'weights', 'embed', 'gpu', 'attn'],
  place: { tokens: [180, 90], weights: [160, 520], embed: [540, 310], gpu: [940, 100], attn: [980, 560] },
  labels: {
    tokens: ['token id', '上一步分词的结果'],
    weights: ['权重文件', 'token_embd.weight'],
    embed: ['嵌入表', `${E.length} 行 × ${D} 维，查到的行`],
    gpu: ['GPU', 'Q、K 投影和 RoPE'],
    attn: ['Q 和 K', '第 0 层第 0、1 头'],
  },
  labelAt: { tokens: [-170, 50], embed: [-250, 60], attn: [-190, 110] },
  radius: { tokens: 60, embed: 110, attn: 80 },
  initial: { tokens: [tokenRow()], embed: [tableGrid(0)], attn: [] },
  start: ['tokens', 'weights', 'embed'],
  legend: [['blue', '嵌入向量'], ['amber', 'RoPE 旋转后'], ['green', '相对位置相同的分数'], [null, '运算量：FLOPs']],
  overview: {
    full: 'token id 怎样变成向量，位置又藏在哪里',
    description: `模型拿到的是一串 id。这一课真实运行迷你模型的第一步：把「${PROMPT}」的 ${PROMPT_IDS.length} 个 id 当作行号，从嵌入表里各取一行 ${D} 维向量。查到的向量不带位置，同一个 token 放在哪里都一样；位置要等到注意力里，由 RoPE 把 Q、K 按位置旋转一个角度补上。你会看到旋转之后，分数只和两个 token 相隔多远有关。`,
    facts: [
      ['输入', `「${PROMPT}」，${PROMPT_IDS.length} 个 token`],
      ['嵌入表', `${E.length} × ${D}，fp32 共 ${tableBytes.f32} 字节`],
      ['RoPE', `相邻两维一组，底数 ${C.ropeBase}`],
      ['注意力头', `${C.nHeads} 个 × ${C.headDim} 维，每头 ${C.headDim / 2} 组`],
      ['运算量', 'FLOPs（乘加算 2 次）'],
    ],
  },
  steps: [
    {
      title: 'token id 就是行号',
      desc: `${PROMPT_IDS.length} 个 id，各取嵌入表的一行`,
      detail: `嵌入表是一个 ${E.length} × ${D} 的矩阵，词表里每个 token 占一行。查表不做浮点运算，只是按 id 算出偏移、读出 ${D} 个数：第 ${NEXT} 行从 ${NEXT} × ${D} × 4 = ${rowOffset(NEXT)} 字节开始。表里的数是训练时学出来的，和模型的其他权重一起更新。`,
      facts: [['id', `[${PROMPT_IDS.join(', ')}]`], ['每行', `${D} 个 fp32，${D * 4} 字节`], ['查表', '0 FLOPs']],
      events: [
        pk('tokens', 'embed', 'violet', 'input_ids', [`[${PROMPT_IDS.join(', ')}]`], [0, 'IDS', `${PROMPT_IDS.length} 个 token id：${PROMPT_LABELS.join(' ')}`, PROMPT_IDS.length * 4],
          wire('模型的输入', 'mem', 'format', tokenIds('input_ids', PROMPT_IDS, { labels: (id) => label(id), summary: '每个 id 是嵌入表的行号' }))),
        ...lookups,
      ],
    },
    {
      title: '一行是 8 个 fp32',
      desc: `每行 ${D * 4} 字节，整张表 ${tableBytes.f32} 字节`,
      detail: `每个数是 IEEE 754 的 fp32，4 个字节，小端存放：1 位符号、8 位指数、23 位尾数。整张表 ${E.length} × ${D} × 4 = ${tableBytes.f32} 字节；存成 fp16 只要一半，这一行最大的误差是 ${num(f16MaxError, 4)}。LLaMA 2 7B 的词表是 ${LLAMA_TABLE.vocab}、每行 ${LLAMA_TABLE.dModel} 维，fp16 的嵌入表就有 ${LLAMA_TABLE.bytes / 1024 / 1024} MiB。`,
      facts: [['fp32', `${tableBytes.f32} 字节`], ['fp16', `${tableBytes.f16} 字节`], ['fp16 误差', `≤ ${num(f16MaxError, 4)}`]],
      events: [
        show('gpu'),
        pk('embed', 'gpu', 'blue', `「${label(NEXT)}」的向量`, [`${D} 个 fp32`, `${D * 4} 字节`], [0, 'LOOKUP', `「${label(NEXT)}」这一行：${nextRow.map((value) => num(value, 3)).join(', ')}`, D * 4],
          wire(`token_embd 第 ${NEXT} 行，按位展开`, 'mem', 'format', floatVector(`token_embd[${NEXT}]`, nextRow, 'f32', { bits: true, summary: 'IEEE 754 binary32，小端：最低字节在前' })),
          { ds: { embed: [tableGrid(PROMPT_IDS.length)] } }),
        pk('weights', 'embed', 'amber', '换成 fp16', [`${D} 个 fp16`, `${D * 2} 字节`], [0, 'LOOKUP', `同一行存成 fp16：${D * 2} 字节，最大误差 ${num(f16MaxError, 4)}；整张表 ${tableBytes.f16} 字节`, D * 2],
          wire(`token_embd 第 ${NEXT} 行的 fp16 版本`, 'mem', 'format', floatVector(`token_embd[${NEXT}]`, nextRow, 'f16', { bits: true, summary: 'IEEE 754 binary16：1 位符号、5 位指数、10 位尾数，就近舍入' })),
          { ds: { embed: [tableGrid(PROMPT_IDS.length, { row: 'fp16', values: nextF16 })] } }),
        note('embed', `整张表 ${tableBytes.f32} 字节`),
      ],
    },
    {
      title: '投影出 Q 和 K',
      desc: `${PROMPT_IDS.length} 个位置各乘 3 个 ${D}×${D} 矩阵`,
      detail: `向量先做一次 RMSNorm，再分别乘 attn_q、attn_k、attn_v 三个矩阵，得到每个位置的 Q、K、V（下一课细讲）。到这里为止向量都不知道自己在第几位：同一个 token 不管出现在哪里，查到的都是同一行。RoPE 要在 Q、K 上补上位置。`,
      facts: [['矩阵', `3 个 ${D} × ${D}`], ['FLOPs', `${PROMPT_IDS.length} × 3 × 2 × ${D} × ${D} = ${QKV_FLOPS}`], ['位置信息', '还没有']],
      events: [
        pk('embed', 'gpu', 'blue', `${PROMPT_IDS.length} 个向量`, [`${PROMPT_IDS.length} × ${D} 个 fp32`], [0, 'MATMUL', `${PROMPT_IDS.length} 个嵌入向量送进第 0 层`, PROMPT_IDS.length * D * 4],
          wire('第 0 层的输入', 'mem', 'format', floatMatrix('x', embedRows, 'f32', { rowNames: (r) => `x[${r}]（${PROMPT_LABELS[r]}）`, summary: '每行一个位置，就是查到的嵌入向量' })),
          { ds: { embed: [tableGrid(PROMPT_IDS.length)] } }),
        state('gpu', { 层: '0', 阶段: 'Q K V 投影', FLOPs: String(QKV_FLOPS) }),
        show('attn'),
        pk('gpu', 'attn', 'blue', 'q 和 k', [`q：第 ${QP} 位「${PROMPT_LABELS[QP]}」`, `k：第 ${KP} 位「${PROMPT_LABELS[KP]}」`], [QKV_FLOPS, 'MATMUL', `${PROMPT_IDS.length} 个位置的 Q、K、V 都算好了；这里取第 ${QP} 位的 q 和第 ${KP} 位的 k`, D * 4 * 2],
          wire('RoPE 之前的 q 和 k', 'mem', 'format',
            floatVector(`q[${QP}]`, ropeQ.before, 'f32', { names: (i) => `q[${QP}].${pairNames(i)}`, summary: `attn_q · RMSNorm(x[${QP}])` }),
            floatVector(`k[${KP}]`, ropeK.before, 'f32', { color: 'teal', names: (i) => `k[${KP}].${pairNames(i)}`, summary: `attn_k · RMSNorm(x[${KP}])` })),
          { ds: { attn: qkRows(ropeQ.before, ropeK.before) } }),
      ],
    },
    {
      title: 'RoPE：按位置转一个角度',
      desc: `每头 ${C.headDim / 2} 组，每组两维一起旋转`,
      detail: `每个头的 ${C.headDim} 维两两一组，看成平面上的一个点，在第 m 个位置就转 m·θ 弧度，θ 是这一组的频率。第 0 组的 θ 是 ${freqs[0]}，第 1 组是 ${C.ropeBase}^(−2/${C.headDim}) = ${freqs[1]}，所以第 ${QP} 位的 q 第 0 组转了 ${QP * freqs[0]} 弧度，第 1 组只转 ${num(QP * freqs[1], 2)} 弧度。旋转不改变长度，头 0 第 0 组转前转后都是 ${num(pairLength(ropeQ.before, 0, 0), 4)}。`,
      facts: [['频率', freqs.map((f) => String(f)).join('、')], [`q 转角`, `${QP} 和 ${num(QP * freqs[1], 2)} 弧度`], [`k 转角`, `${KP} 和 ${num(KP * freqs[1], 2)} 弧度`]],
      events: [
        state('gpu', { 层: '0', 阶段: 'RoPE', FLOPs: String(QKV_FLOPS) }),
        pk('gpu', 'attn', 'amber', `q 转 ${QP}·θ`, freqs.map((f, i) => `组 ${i}：${num(QP * f, 2)} 弧度`), [QKV_FLOPS, 'ACT', `第 ${QP} 位的 q：每头两组分别转 ${freqs.map((f) => num(QP * f, 2)).join('、')} 弧度`, D * 4],
          wire('RoPE 之后的 q', 'mem', 'format', floatVector(`q_rope[${QP}]`, ropeQ.after, 'f32', { color: 'amber', names: (i) => `q[${QP}].${pairNames(i)}`, summary: '(x, y) → (x·cos − y·sin, x·sin + y·cos)' })),
          { ds: { attn: [{ ...qkRows(ropeQ.after, ropeK.before, 'amber', true)[0] }, qkRows(ropeQ.after, ropeK.before)[1]] } }),
        pk('gpu', 'attn', 'amber', `k 转 ${KP}·θ`, freqs.map((f, i) => `组 ${i}：${num(KP * f, 2)} 弧度`), [QKV_FLOPS, 'ACT', `第 ${KP} 位的 k：每头两组分别转 ${freqs.map((f) => num(KP * f, 2)).join('、')} 弧度`, D * 4],
          wire('RoPE 之后的 k', 'mem', 'format', floatVector(`k_rope[${KP}]`, ropeK.after, 'f32', { color: 'amber', names: (i) => `k[${KP}].${pairNames(i)}`, summary: 'K 转完之后写进 KV cache，以后不再转' })),
          { ds: { attn: qkRows(ropeQ.after, ropeK.after, 'amber') } }),
        note('attn', '旋转不改变长度', 'amber'),
      ],
    },
    {
      title: '点积只看相对位置',
      desc: `相隔 ${QP - KP} 位，挪到哪里分数都一样`,
      detail: `一组两维的点积等于两段长度相乘、再乘以夹角的余弦。q 转了 m·θ，k 转了 n·θ，夹角里只多出 (m − n)·θ，所以两个 token 一起往后挪，分数不变：放在第 ${shifted[0].m}、${shifted[0].n} 位，头 0 的分数仍是 ${num(shifted[0].scores[0], 4)}。换成相隔 ${shifted[2].m - shifted[2].n} 位，同一对 q、k 的分数就变成 ${num(shifted[2].scores[0], 4)}。`,
      facts: [realScore, shifted[1], shifted[2]].map((item): [string, string] => [`第 ${item.m}·${item.n} 位`, item.scores.map((s) => num(s, 4)).join(' / ')]),
      events: [
        state('gpu', { 层: '0', 阶段: 'q·k / √d', FLOPs: String(realScore.flops) }),
        pk('attn', 'gpu', 'green', `q·k，相隔 ${QP - KP}`, realScore.scores.map((s, h) => `头 ${h}：${num(s, 4)}`), [realScore.flops, 'ATTN', `第 ${QP} 位看第 ${KP} 位：两个头的分数 ${realScore.scores.map((s) => num(s, 4)).join('、')}（已除以 √${C.headDim}）`, C.nHeads * 4],
          wire('模型里真实算出的分数', 'mem', 'format', floatVector('score', realScore.scores, 'f32', { color: 'green', names: (h) => `头 ${h}：q[${QP}]·k[${KP}] / √${C.headDim}`, summary: '下一课里它是分数矩阵的一格' })),
          { ds: { attn: [scoreGrid(1)] } }),
        ...shifted.map((item, i) =>
          pk('gpu', 'attn', item.m - item.n === QP - KP ? 'green' : 'violet', `挪到 ${item.m}·${item.n}`, item.scores.map((s, h) => `头 ${h}：${num(s, 4)}`), [item.flops, 'ATTN', `同一对 q、k 放在第 ${item.m} 和第 ${item.n} 位（相隔 ${item.m - item.n}）：${item.scores.map((s) => num(s, 4)).join('、')}`, null],
            wire('换个位置重新旋转再点积', 'mem', '示意', concept('scores', item.scores.map((s, h): [string, string, string] => [`头 ${h}`, num(s, 6), `q 转 ${item.m}·θ，k 转 ${item.n}·θ，float64 计算`]))),
            { ds: { attn: [scoreGrid(i + 2)] } })),
        note('attn', '只差 (m − n)·θ', 'green'),
      ],
    },
  ],
  outro: {
    title: '位置藏在角度里',
    desc: `${PROMPT_IDS.length} 行嵌入 + 按位置旋转的 Q、K`,
    text: `真实模型的嵌入表大得多，但查表的方式完全一样：id 乘以每行字节数就是偏移。LLaMA 2 每个头 128 维，两两一组共 64 组，底数 10000，频率从 1 一直降到接近 1/10000：转得快的组分辨近处，转得慢的组分辨远处；Llama 3 把底数调到 500000，让慢的组转得更慢，好照顾更长的上下文。RoPE 只转 Q、K，不转 V，也不改嵌入本身。`,
    facts: [['嵌入', `${PROMPT_IDS.length} × ${D}`], ['FLOPs', String(meter.total)], ['下一课', '一次自注意力']],
  },
};
