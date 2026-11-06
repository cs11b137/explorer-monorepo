/**
 * 第五课：图像切 patch 变 token（ViT 的 patch embedding）。
 * 一张 8×8 的 RGB 小图 → 切成 4 个 4×4 patch → 每个展平成 48 个数 → 线性投影成 d_model 维
 * → 插到文本嵌入前面，同一个 Transformer 照常前向。
 * 数字全部来自 model/vision.ts 和 forwardEmbeds 的真实计算，tests/narrative.repr.test.ts 核对。
 */
import { floatMatrix, floatVector, rawBytes, tokenIds, wire } from '../decode/structures';
import { embedTokens, FlopMeter, forward, FP32, matvec, forwardEmbeds, imageInputs, MODEL, normalizePixel, numPatches, PALETTE, patchDim, patchEmbed, ppmBytes, SAMPLE_IMAGE, softmax, spliceImage, TOKENIZER, VISION } from '../model';
import { cellsOf, num, pct, shortLabel } from './common';
import { note, pk, show } from './dsl';
import { argmaxOf, dimCols, fixed, topOf, vecGrid } from './repr-common';
import type { DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

const T = TOKENIZER;
const IMG = SAMPLE_IMAGE;
const V = VISION.config;
const D = MODEL.config.dModel;
const P = V.patch;
const NP = numPatches(V);
const PD = patchDim(V);

/** 和图像一起送进模型的文字。 */
export const VISION_TEXT = 'the model reads the';
export const textIds = T.encode(VISION_TEXT);
const TEXT_LABELS = textIds.map((id) => T.label(id));

/** PPM 文件：ASCII 头加上原始 RGB 字节。 */
export const ppm = ppmBytes(IMG);
export const PPM_HEADER = ppm.length - IMG.data.length;

export const patchRun = patchEmbed(VISION, IMG);
/** 这一课累计的 FLOPs。投影逐个 patch 重算一遍，好在每个 patch 之后读出累计值；tests 核对它和 patchEmbed 逐位相同。 */
const meter = new FlopMeter();
export const projectedAgain = patchRun.patches.map((patch) => ({ value: matvec(VISION.patch_embd, patch.values, FP32, meter, 'other'), flops: meter.total }));
const PATCH_FLOPS = meter.total;
/** 图像向量放在最前面（位置 0..3），文字跟在后面。 */
export const inputs = spliceImage(embedTokens(MODEL, textIds), 0, imageInputs(patchRun));
export const withImage = forwardEmbeds(MODEL, inputs, { meter, lastLogitsOnly: true });
const IMAGE_FLOPS = meter.total;
/** 对照：同样的文字，不带图像。 */
export const textOnly = forward(MODEL, textIds, { meter, lastLogitsOnly: true });
const TOTAL_FLOPS = meter.total;

const lastOf = (trace: typeof withImage) => trace.positions[trace.positions.length - 1];
export const imageProbs = softmax(lastOf(withImage).logits);
export const textProbs = softmax(lastOf(textOnly).logits);
export const imageTop = topOf(imageProbs, 3);
export const textTop = topOf(textProbs, 3);
const SEQ = inputs.length;
const SEQ_LABELS = [...Array.from({ length: NP }, (_, i) => `图${i}`), ...TEXT_LABELS];
/** 最后一个文字 token 在每层每个头上分给图像位置的权重之和，以及最看重的位置。 */
export const imageShare = lastOf(withImage).layers.map((layer) => layer.heads.map((head) => ({ share: head.probs.slice(0, NP).reduce((sum, p) => sum + p, 0), at: argmaxOf(head.probs), p: Math.max(...head.probs) })));
/** 分给图像最多的那个头。 */
export const peak = imageShare.flatMap((heads, layer) => heads.map((item, head) => ({ layer, head, ...item }))).reduce((best, item) => (item.share > best.share ? item : best));

// ---------- 像素 ----------

const KEY_NAME: Record<string, string> = { S: '天', Y: '日', W: '云', G: '草', R: '花', D: '茎' };
const KEY_TONE: Record<string, Tone> = { S: 'blue', Y: 'amber', W: 'slate', G: 'green', R: 'violet', D: 'teal' };
/** 每个像素属于调色板里的哪一种。 */
const keyOf = (x: number, y: number): string => {
  const at = (y * IMG.width + x) * IMG.channels;
  const rgb = IMG.data.slice(at, at + 3);
  return Object.keys(PALETTE).find((key) => PALETTE[key].every((value, c) => value === rgb[c]))!;
};
const patchOf = (x: number, y: number) => Math.floor(y / P) * (IMG.width / P) + Math.floor(x / P);

function pixelGrid(focus?: number): GridPrim {
  const rows = Array.from({ length: IMG.height }, (_, y) => String(y));
  const cols = Array.from({ length: IMG.width }, (_, x) => String(x));
  const cells = rows.map((_, y) => cols.map((__, x): DsCell => {
    const key = keyOf(x, y);
    const dim = focus !== undefined && patchOf(x, y) !== focus;
    return { v: KEY_NAME[key], tone: dim ? 'dim' : KEY_TONE[key], lift: focus !== undefined && !dim ? true : undefined };
  }));
  return { kind: 'grid', id: 'px', w: 28, rows, cols, cells };
}

/** 一个 patch 展平前的样子：4 行像素，每行 4 个像素 × RGB。 */
function flatGrid(patch: number): GridPrim {
  const values = patchRun.patches[patch].values;
  const perRow = P * IMG.channels;
  const rows = Array.from({ length: P }, (_, y) => `y${y}`);
  const cols = Array.from({ length: perRow }, (_, i) => `${'RGB'[i % 3]}${Math.floor(i / 3)}`);
  const grid = rows.map((_, y) => values.slice(y * perRow, (y + 1) * perRow));
  return vecGrid('fl', rows, cols, grid, { w: 30, tone: (_, c) => (['amber', 'green', 'blue'] as Tone[])[c % 3] });
}

function patchGrid(count: number): GridPrim {
  const rows = Array.from({ length: NP }, (_, i) => `图${i}`);
  const values = patchRun.vectors.map((vec, i) => (i < count ? vec : vec.map(() => null)));
  return vecGrid('pv', rows, dimCols(D), values, { w: 36, tone: (r) => (r === count - 1 ? 'amber' : undefined) });
}

function seqRow(lift: number[] = []): RowPrim {
  const tones = Object.fromEntries(SEQ_LABELS.map((_, i) => [i, i < NP ? 'amber' : 'blue'])) as Record<number, Tone>;
  return { kind: 'row', id: 'seq', w: 46, cells: cellsOf(SEQ_LABELS, { tones, lift, subs: SEQ_LABELS.map((_, i) => String(i)) }) };
}

function idRow(): RowPrim {
  return { kind: 'row', id: 'ids', w: 52, cells: cellsOf(textIds, { subs: textIds.map((id) => shortLabel(id, 6)), rest: 'blue' }) };
}

function logitRow(probs: number[], ids: number[], tone: Tone): RowPrim {
  return { kind: 'row', id: 'lg', w: 54, cells: cellsOf(ids.map((id) => pct(probs[id])), { subs: ids.map((id) => shortLabel(id, 6)), tones: { 0: tone }, heat: ids.map((id) => probs[id]) }) };
}

// ---------- 事件 ----------

const firstSky = { x: 0, y: 0, byte: IMG.data[0] };
const firstPatch = patchRun.patches[0];
const label = (id: number) => T.label(id);
const ppmText = String.fromCharCode(...ppm.slice(0, PPM_HEADER)).replace(/\n/g, '\\n');

export const vision: Lesson = {
  id: 'vision',
  name: 'VISION PATCHES',
  title: '图像切 patch 变 token（多模态理解：ViT patch embedding）',
  group: 'repr',
  layer: [1, 3],
  layerNote: '从图像的像素字节出发，得到和文字 token 同样维数的向量。',
  opsUnit: 'FLOPs：只计乘加，每次乘加算 2 次。包括 patch 投影和之后整条序列的前向',
  opsShort: 'FLOPs',
  nodes: ['image', 'vit', 'embed', 'tokens', 'hidden', 'logits'],
  place: { image: [190, 250], vit: [560, 80], embed: [930, 250], tokens: [170, 640], hidden: [620, 560], logits: [1060, 720] },
  labels: {
    image: ['输入图像', `${IMG.width}×${IMG.height} RGB，天空、太阳、云、草地和一朵花`],
    vit: ['视觉投影', `patch ${P}×${P}，${PD} → ${D}`],
    embed: ['patch 向量', `${NP} 个，每个 ${D} 维`],
    tokens: ['文字 token', `「${VISION_TEXT}」`],
    hidden: ['输入序列', `${NP} 个图像位置 + ${textIds.length} 个文字位置`],
    logits: ['下一个 token', '概率最高的 3 个'],
  },
  labelAt: { image: [-60, 150], embed: [130, 140], tokens: [-160, 50], hidden: [-260, 30], logits: [-170, 50] },
  radius: { image: 110, embed: 100, tokens: 60, hidden: 80, logits: 60 },
  initial: { image: [pixelGrid()], embed: [], tokens: [], hidden: [], logits: [] },
  start: ['image', 'vit'],
  legend: [['amber', '图像位置'], ['blue', '文字位置'], ['green', '预测'], [null, '运算量：FLOPs']],
  overview: {
    full: '图像怎样变成模型能读的 token',
    description: `多模态模型读图，第一步是把图像也变成一串向量。这一课真实运行 ViT 式的 patch embedding：一张 ${IMG.width}×${IMG.height} 的小图切成 ${NP} 块，每块 ${P}×${P} 像素展平成 ${PD} 个数，乘一个 ${D}×${PD} 的矩阵，变成和文字 token 一样的 ${D} 维向量。把它们放在「${VISION_TEXT}」前面，同一个 Transformer 照常前向。投影权重没有训练，你会看到图像确实改变了输出，但这个改变没有意义。`,
    facts: [
      ['图像', `${IMG.width}×${IMG.height}×${IMG.channels}，${IMG.data.length} 字节`],
      ['patch', `${P}×${P}，共 ${NP} 个`],
      ['每个 patch', `${PD} 个数 → ${D} 维`],
      ['序列', `${NP} + ${textIds.length} = ${SEQ} 个位置`],
      ['运算量', 'FLOPs（乘加算 2 次）'],
    ],
  },
  steps: [
    {
      title: '图像就是一串字节',
      desc: `${IMG.width}×${IMG.height} 像素 × ${IMG.channels} 通道 = ${IMG.data.length} 字节`,
      detail: `每个像素是红、绿、蓝 3 个字节，取值 0–255，按行从左到右排列。存成最简单的 PPM 文件，就是 ${PPM_HEADER} 字节的文字头「${ppmText}」加上这 ${IMG.data.length} 个字节。PNG、JPEG 解码之后也是这样一张像素表，模型只从这里开始。`,
      facts: [['文件', `PPM（P6），${ppm.length} 字节`], ['像素', `${IMG.width * IMG.height} 个 × 3 字节`], ['左上角', `天空 (${IMG.data.slice(0, 3).join(', ')})`]],
      events: [
        pk('image', 'vit', 'blue', 'PPM 文件', [`${ppm.length} 字节`, `${IMG.width}×${IMG.height} RGB`], [0, 'TEXT', `读入图像：${PPM_HEADER} 字节文件头 + ${IMG.data.length} 字节像素`, ppm.length],
          wire('一张 8×8 的 PPM 图像', 'mem', 'format', rawBytes('image.ppm', ppm, {
            groups: [
              { name: `文件头「${ppmText}」`, bytes: ppm.slice(0, PPM_HEADER), note: 'P6 表示二进制 RGB；然后是宽、高和每个通道的最大值，用空白分隔。' },
              ...Array.from({ length: IMG.height }, (_, y) => ({ name: `第 ${y} 行像素`, bytes: ppm.slice(PPM_HEADER + y * IMG.width * 3, PPM_HEADER + (y + 1) * IMG.width * 3), note: `${IMG.width} 个像素，每个 R G B 各 1 字节。` })),
            ],
          })),
          { ds: { image: [pixelGrid()] } }),
        note('image', '每个像素 3 个字节'),
      ],
    },
    {
      title: `切成 ${NP} 个 patch`,
      desc: `每块 ${P}×${P} 像素，按行编号`,
      detail: `ViT 把图像切成互不重叠的方块，每一块就当作一个 token。这里每块 ${P}×${P} 像素，${IMG.width}×${IMG.height} 的图切成 ${IMG.width / P}×${IMG.height / P} = ${NP} 块，按从左到右、从上到下编号。ViT 原论文的标题就是「一张图值 16×16 个词」：224×224 的图按 16×16 切，得到 ${(224 / 16) ** 2} 个 patch。`,
      facts: [['patch', `${P}×${P} 像素`], ['个数', `${IMG.width / P} × ${IMG.height / P} = ${NP}`], ['每块字节', `${P}×${P}×3 = ${PD}`]],
      events: patchRun.patches.map((patch) =>
        pk('image', 'vit', 'amber', `图${patch.index}`, [`第 ${patch.row} 行第 ${patch.col} 列`, `${patch.bytes.length} 字节`], [0, 'TEXT', `patch ${patch.index}：左上角在像素 (${patch.col * P}, ${patch.row * P})，${patch.bytes.length} 个字节`, patch.bytes.length],
          wire(`patch ${patch.index} 的字节`, 'mem', 'internal', rawBytes(`patch[${patch.index}]`, patch.bytes, {
            color: 'amber',
            summary: '按 patch 内行优先、每个像素 R G B 依次排列；PyTorch 卷积的权重按通道优先，展平顺序不同',
            groups: Array.from({ length: P }, (_, y) => ({ name: `第 ${y} 行`, bytes: patch.bytes.slice(y * P * 3, (y + 1) * P * 3), note: `原图第 ${patch.row * P + y} 行的第 ${patch.col * P}–${patch.col * P + P - 1} 个像素。` })),
          })),
          { quick: patch.index > 0, ds: { image: [pixelGrid(patch.index)] } })),
    },
    {
      title: '展平，再归一化',
      desc: `${P}×${P}×3 = ${PD} 个数，映射到 [−1, 1]`,
      detail: `一个 patch 的 ${P} 行像素首尾相接，就是 ${PD} 个字节排成一行。每个字节先除以 255，再减 0.5、除以 0.5，落到 −1 到 1 之间：天空的红色通道 ${firstSky.byte} 变成 ${num(normalizePixel(firstSky.byte), 4)}。这样输入以 0 为中心、范围固定，训练更稳定。`,
      facts: [['公式', '(x / 255 − 0.5) / 0.5'], [`${firstSky.byte}`, num(normalizePixel(firstSky.byte), 4)], ['255 / 0', '1 / −1']],
      events: [
        pk('vit', 'image', 'amber', '展平 图0', [`${PD} 个 fp32`], [0, 'ACT', `patch 0 展平、归一化：${PD} 个数，第一个是 ${num(firstPatch.values[0], 4)}`, PD * 4],
          wire('patch 0 展平后的输入', 'mem', 'format', floatVector('x', firstPatch.values, 'f32', { color: 'amber', names: (i) => `x[${i}]（${'RGB'[i % 3]}，像素 ${Math.floor(i / 3)}）`, summary: `${PD} 个 fp32，就是投影矩阵要乘的向量` })),
          { ds: { image: [flatGrid(0)] } }),
        note('image', `${P} 行 × ${P * 3} 个 = ${PD} 个数`, 'amber'),
      ],
    },
    {
      title: `线性投影成 ${D} 维`,
      desc: `${D}×${PD} 矩阵，加偏置和位置嵌入`,
      detail: `每个 patch 的 ${PD} 个数乘一个 ${D} × ${PD} 的矩阵，加上偏置，再加上这个 patch 位置的位置嵌入，得到 ${D} 维向量，和文字 token 的嵌入一样长。${NP} 个 patch 共 ${NP} × 2 × ${D} × ${PD} = ${PATCH_FLOPS} FLOPs。ViT-B/16 的这一步是 768 个数投影到 768 维；本站的投影权重来自固定种子，没有训练过。`,
      facts: [['投影', `${D} × ${PD}`], ['FLOPs', String(PATCH_FLOPS)], ['训练', '没有（固定种子）']],
      events: [
        show('embed'),
        ...patchRun.vectors.map((vec, i) =>
          pk('vit', 'embed', 'amber', `图${i} → ${D} 维`, vec.slice(0, 4).map((x) => fixed(x, 3)).concat(['…']), [projectedAgain[i].flops, 'MATMUL', `patch ${i}：W · x + b + pos[${i}] = [${vec.map((x) => fixed(x, 2)).join(', ')}]`, D * 4],
            wire(`patch ${i} 的向量`, 'mem', 'format', floatVector(`patch_vec[${i}]`, vec, 'f32', { color: 'amber', summary: `W · x = ${patchRun.projected[i].map((x) => fixed(x, 2)).join(' ')}，再加偏置和位置嵌入` })),
            { quick: i > 0, ds: { embed: [patchGrid(i + 1)] } })),
      ],
    },
    {
      title: '和文字拼成一条序列',
      desc: `${NP} 个图像向量 + ${textIds.length} 个 token = ${SEQ} 个位置`,
      detail: `文字照常分词、查嵌入表，得到 ${textIds.length} 个 ${D} 维向量。把 ${NP} 个图像向量放在最前面，序列就有 ${SEQ} 个位置；对模型来说它们只是位置 0–${NP - 1} 上的向量，RoPE 和因果掩码都照常作用。LLaVA 这类模型在提示词里放一个 <image> 占位符，再把它换成这些向量。`,
      facts: [['图像位置', `0–${NP - 1}`], ['文字位置', `${NP}–${SEQ - 1}`], ['输入', `${SEQ} × ${D} 个 fp32`]],
      events: [
        show('tokens', 'hidden'),
        pk('tokens', 'hidden', 'blue', `${textIds.length} 个 token`, [`「${VISION_TEXT}」`], [PATCH_FLOPS, 'LOOKUP', `文字 ${textIds.length} 个 token：${TEXT_LABELS.join(' ')}，各查嵌入表一行`, textIds.length * 4],
          wire('文字部分', 'mem', 'format', tokenIds('input_ids', textIds, { labels: (id) => label(id) })),
          { ds: { tokens: [idRow()], hidden: [{ ...seqRow(), cells: seqRow().cells.map((cell, i) => (i < NP ? { ...cell, v: '' } : cell)) }] } }),
        pk('embed', 'hidden', 'amber', '插到最前面', [`${SEQ} 个位置`], [PATCH_FLOPS, 'LOOKUP', `${NP} 个图像向量 + ${textIds.length} 个文字向量，共 ${SEQ} 个位置`, SEQ * D * 4],
          wire('整条输入序列', 'mem', 'format', floatMatrix('inputs', inputs.map((item) => item.embed), 'f32', { rowNames: (r) => `x[${r}]（${SEQ_LABELS[r]}）`, summary: '图像位置的 token 记为 −1（不是文字）' })),
          { ds: { hidden: [seqRow()] } }),
      ],
    },
    {
      title: '模型照常前向',
      desc: `预测从「${label(textTop[0])}」变成「${label(imageTop[0])}」`,
      detail: `${SEQ} 个位置走完 ${MODEL.config.nLayers} 层，算法和纯文字完全相同。最后一个 token「${TEXT_LABELS[TEXT_LABELS.length - 1]}」在第 ${peak.layer} 层头 ${peak.head} 上把 ${pct(peak.share)} 的注意力放在图像位置，预测从「${label(textTop[0])}」${pct(textProbs[textTop[0]])} 变成「${label(imageTop[0])}」${pct(imageProbs[imageTop[0]])}。投影没有训练，这个变化没有意义：多模态模型要在大量图文配对数据上训练投影，图像向量才会带上「天空」「花」这样的意思。`,
      facts: [['带图', `${label(imageTop[0])} ${pct(imageProbs[imageTop[0]])}`], ['只有文字', `${label(textTop[0])} ${pct(textProbs[textTop[0]])}`], ['前向 FLOPs', String(IMAGE_FLOPS - PATCH_FLOPS)]],
      events: [
        show('logits'),
        pk('hidden', 'logits', 'green', '带图前向', imageTop.map((id) => `${label(id)} ${pct(imageProbs[id])}`), [IMAGE_FLOPS, 'LOGITS', `${SEQ} 个位置前向，最后一个位置：${imageTop.map((id) => `${label(id)} ${pct(imageProbs[id])}`).join('，')}`, MODEL.config.vocab * 4],
          wire('带图时的 logits', 'mem', 'format', floatVector('logits', lastOf(withImage).logits, 'f32', { color: 'green', names: (id) => `logits[${id}]（${label(id)}）`, notes: Object.fromEntries(imageTop.map((id, rank) => [id, `第 ${rank + 1} 名，${pct(imageProbs[id])}。`])) })),
          { ds: { logits: [logitRow(imageProbs, imageTop, 'green')], hidden: [seqRow(Array.from({ length: NP }, (_, i) => i))] } }),
        note('hidden', `第 ${peak.layer} 层头 ${peak.head}：${pct(peak.share)} 看图像`, 'amber'),
        pk('tokens', 'logits', 'blue', '对照：只有文字', textTop.map((id) => `${label(id)} ${pct(textProbs[id])}`), [TOTAL_FLOPS, 'LOGITS', `同样的文字不带图：${textTop.map((id) => `${label(id)} ${pct(textProbs[id])}`).join('，')}`, MODEL.config.vocab * 4],
          wire('不带图时的 logits', 'mem', 'format', floatVector('logits', lastOf(textOnly).logits, 'f32', { color: 'blue', names: (id) => `logits[${id}]（${label(id)}）`, notes: Object.fromEntries(textTop.map((id, rank) => [id, `第 ${rank + 1} 名，${pct(textProbs[id])}。`])) })),
          { ds: { logits: [logitRow(textProbs, textTop, 'blue')] } }),
      ],
    },
  ],
  outro: {
    title: '图像也是一串向量',
    desc: `${NP} 个 patch 和 ${textIds.length} 个 token 走同一个模型`,
    text: `真实模型的图像大得多：一张 336×336 的图按 14×14 切，就有 ${(336 / 14) ** 2} 个 patch，一张图就占几百个位置，所以带图的请求更费上下文。Fuyu 正是把 patch 直接线性投影后送进解码器；LLaVA 一类模型先用一个完整的视觉编码器（CLIP 的 ViT）处理 patch，再用投影层接到语言模型上。不管哪种，进了语言模型之后就和文字 token 一样走预填充和解码，这是下一组课的内容。`,
    facts: [['patch 投影', `${PATCH_FLOPS} FLOPs`], ['FLOPs', String(TOTAL_FLOPS)], ['下一课', '预填充与解码']],
  },
};
