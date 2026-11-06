/**
 * 表示组（embed、attention、block、vision）的文案核对，做法和 narrative.test.ts 相同：
 * 1. 课程里的重放和 forward 逐位相同，所以文案里的数字就是模型真正算出的数字；
 * 2. 取值之后的文字是否等于手算结果；
 * 3. 没法直接取值的说法（「最看重」「旋转不改变长度」「分数不变」）在这里用计算锁住。
 * 改了提示词、语料或权重，这里会报错，提醒同时改写文案。
 */
import { describe, expect, it } from 'vitest';
import { LESSON_BY_ID, PLANNED } from '../src/lessons';
import { attnReplay, focus, lastFocus, MATMUL_FLOPS, MIX_FLOPS } from '../src/lessons/attention';
import { biggest, final, layer0, layer1, lengths, LMHEAD_FLOPS, logits, maxNegAct, maxPosAct, probs, SILU_MIN, top, TOTAL_FLOPS, unitRms } from '../src/lessons/block';
import { embedRows, f16MaxError, freqs, LLAMA_TABLE, pairLength, qkv, realScore, rowOffset, ropeK, ropeQ, shifted, shiftedAt, tableBytes } from '../src/lessons/embed';
import { fixed, LAST, PROMPT, PROMPT_IDS, PROMPT_LABELS, PROMPT_TRACE, replayLayer } from '../src/lessons/repr-common';
import { imageProbs, imageShare, imageTop, inputs, patchRun, peak, ppm, PPM_HEADER, projectedAgain, textIds, textOnly, textProbs, textTop, VISION_TEXT, withImage } from '../src/lessons/vision';
import { FlopMeter, forwardEmbeds, MODEL, NO_TOKEN, normalizePixel, SAMPLE_IMAGE, silu, TOKENIZER } from '../src/model';

const T = TOKENIZER;
const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const stepOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step];
const allText = (id: string) => {
  const lesson = LESSON_BY_ID[id];
  return [lesson.overview.description, ...lesson.steps.flatMap((step) => [step.title, step.desc, step.detail]), lesson.outro.text].join('\n');
};

describe('表示组的共同输入', () => {
  it('提示词：每个词正好 1 个 token', () => {
    expect(PROMPT).toBe('the model writes the next');
    expect(PROMPT_LABELS).toEqual(['the', '␣model', '␣writes', '␣the', '␣next']);
    expect(PROMPT_IDS).toEqual([277, 276, 334, 262, 332]);
  });

  it('逐站重放和 forward 逐位相同，FLOPs 也一样', () => {
    const meter = new FlopMeter();
    const r0 = replayLayer(MODEL, 0, PROMPT_TRACE.positions.map((p) => p.embed), meter);
    const r1 = replayLayer(MODEL, 1, r0.steps.map((step) => step.output), meter);
    expect(r0.steps).toEqual(PROMPT_TRACE.positions.map((p) => p.layers[0]));
    expect(r1.steps).toEqual(PROMPT_TRACE.positions.map((p) => p.layers[1]));
    // forward 还算了最后一个位置的 lm_head。
    expect(meter.total + 2 * MODEL.config.vocab * MODEL.config.dModel).toBe(PROMPT_TRACE.meter.total);
    // 每一站的累计 FLOPs 单调不减。
    const order = ['norm', 'qkv', 'rope', 'score', 'softmax', 'mix', 'wo', 'resid', 'ffnNorm', 'gateUp', 'act', 'down', 'output'] as const;
    order.slice(1).forEach((station, i) => expect(r0.flops[station]).toBeGreaterThanOrEqual(r0.flops[order[i]]));
  });

  it('课程按 PLANNED 的顺序衔接：outro 的「下一课」是下一节的标题', () => {
    const ids = ['bpe', 'embed', 'attention', 'block', 'vision'];
    for (const id of ids) {
      const index = PLANNED.findIndex((item) => item.id === id);
      const next = Object.fromEntries(LESSON_BY_ID[id].outro.facts).下一课;
      expect(PLANNED[index + 1].title.startsWith(next), `${id} → ${next}`).toBe(true);
    }
    for (const id of ids.slice(1)) expect(LESSON_BY_ID[id].title).toBe(PLANNED.find((item) => item.id === id)!.title);
  });

  it('数字的显示', () => {
    expect(fixed(0.00835, 2)).toBe('0.01');
    expect(fixed(-0.004, 2)).toBe('0.00');
    expect(fixed(-1.5, 1)).toBe('−1.5');
  });
});

describe('嵌入查表与 RoPE', () => {
  const C = MODEL.config;

  it('查到的行就是 forward 的嵌入；Q、K、V 和 forward 相同', () => {
    embedRows.forEach((row, i) => expect(row).toEqual(PROMPT_TRACE.positions[i].embed));
    qkv.forEach((item, i) => {
      const layer = PROMPT_TRACE.positions[i].layers[0];
      expect(item).toEqual({ q: layer.q, k: layer.k, v: layer.v, qRope: layer.qRope, kRope: layer.kRope });
    });
  });

  it('手算：偏移和字节数', () => {
    // 353 行 × 8 维 × 4 字节。
    expect(tableBytes).toEqual({ f32: 11296, f16: 5648 });
    expect(rowOffset(332)).toBe(332 * 32);
    expect(stepOf('embed', 0).detail).toContain('第 332 行从 332 × 8 × 4 = 10624 字节开始');
    expect(stepOf('embed', 1).desc).toBe('每行 32 字节，整张表 11296 字节');
    // LLaMA 2 7B：32000 × 4096 × 2 字节 = 250 MiB。
    expect(LLAMA_TABLE.bytes).toBe(250 * 1024 * 1024);
    expect(stepOf('embed', 1).detail).toContain('fp16 的嵌入表就有 250 MiB');
    // fp16 的误差：最大的数 −4.369，fp16 在 [4, 8) 的间距是 2^−8，误差不超过一半。
    expect(f16MaxError).toBeLessThanOrEqual(2 ** -9);
    expect(factsOf('embed', 1)['fp16 误差']).toBe('≤ 0.0018');
    expect(factsOf('embed', 2).FLOPs).toBe('5 × 3 × 2 × 8 × 8 = 1920');
  });

  it('RoPE：频率、转角，旋转不改变长度', () => {
    expect(C.ropeBase).toBe(10000);
    expect(freqs).toEqual([1, 0.01]);
    expect(factsOf('embed', 3)['q 转角']).toBe('4 和 0.04 弧度');
    for (let h = 0; h < C.nHeads; h++) {
      for (let pair = 0; pair < C.headDim / 2; pair++) {
        expect(pairLength(ropeQ.after, h, pair)).toBeCloseTo(pairLength(ropeQ.before, h, pair), 5);
        expect(pairLength(ropeK.after, h, pair)).toBeCloseTo(pairLength(ropeK.before, h, pair), 5);
      }
    }
    expect(stepOf('embed', 3).detail).toContain('头 0 第 0 组转前转后都是 2.353');
    // 位置 0 不转。
    expect(qkv[0].qRope).toEqual(qkv[0].q);
  });

  it('点积只看相对位置', () => {
    // 课里的真实分数就是 forward 里第 4 行第 3 列的分数。
    expect(realScore.scores).toEqual(PROMPT_TRACE.positions[LAST].layers[0].heads.map((head) => head.scores[LAST - 1]));
    // float64 下，相隔 1 的三种放法分数相同（只差舍入）。
    const base = shiftedAt(4, 3, true);
    for (const item of shifted.slice(0, 2)) {
      expect(item.m - item.n).toBe(1);
      item.scores.forEach((s, h) => expect(Math.abs(s - base.scores[h])).toBeLessThan(1e-12));
    }
    // fp32 的真实分数和 float64 的只差舍入。
    realScore.scores.forEach((s, h) => expect(s).toBeCloseTo(base.scores[h], 5));
    // 相隔 4 时分数不同。
    expect(shifted[2].m - shifted[2].n).toBe(4);
    expect(Math.abs(shifted[2].scores[0] - base.scores[0])).toBeGreaterThan(0.5);
    expect(stepOf('embed', 4).detail).toContain('放在第 9、8 位，头 0 的分数仍是 0.9952');
    expect(stepOf('embed', 4).detail).toContain('相隔 4 位，同一对 q、k 的分数就变成 1.6748');
    expect(factsOf('embed', 4)['第 4·3 位']).toBe('0.9952 / 5.5977');
  });

  it('概览和总结', () => {
    const lesson = LESSON_BY_ID.embed;
    expect(lesson.overview.description).toContain(`「${PROMPT}」的 5 个 id`);
    expect(Object.fromEntries(lesson.outro.facts).FLOPs).toBe(String(1920 + 4 * 16));
  });
});

describe('一次自注意力', () => {
  const C = MODEL.config;
  const S = attnReplay.steps;
  const F = attnReplay.flops;

  it('重放和 forward 的第 0 层相同', () => {
    expect(S).toEqual(PROMPT_TRACE.positions.map((p) => p.layers[0]));
  });

  it('因果：第 i 个位置只和 0..i 打分，每行权重和为 1', () => {
    S.forEach((step, pos) => {
      for (const head of step.heads) {
        expect(head.scores).toHaveLength(pos + 1);
        expect(head.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      }
    });
    // 「the 只能看自己，权重是 1」
    expect(S[0].heads.map((head) => head.probs)).toEqual([[1], [1]]);
    expect(stepOf('attention', 2).desc).toContain('−∞');
  });

  it('「␣next 在头 0 上最看重 ␣writes，在头 1 上最看重 ␣the」', () => {
    expect(lastFocus.map((item) => PROMPT_LABELS[item.at])).toEqual(['␣writes', '␣the']);
    expect(focus[LAST]).toEqual([2, 3]);
    expect(lastFocus.map((item) => fixed(item.p, 3))).toEqual(['0.747', '0.747']);
    expect(stepOf('attention', 2).detail).toContain('「␣next」在头 0 上最看重「␣writes」（0.75），在头 1 上最看重「␣the」（0.75）');
    // 「两个头看的不同」
    expect(lastFocus[0].at).not.toBe(lastFocus[1].at);
    // 「头 1 的 4 维主要来自 ␣the 的 v，它占了 74.7%」
    expect(stepOf('attention', 3).detail).toContain('主要来自「␣the」的 v，它占了 74.7% 的权重');
  });

  it('缩放和 FLOPs', () => {
    expect(1 / Math.sqrt(C.headDim)).toBe(0.5);
    // 手算：投影 5 × 3 × 2 × 8 × 8；打分、加权各 2 头 × 2 × 4 × (1+2+3+4+5)；输出投影 5 × 2 × 8 × 8。
    expect(F.qkv).toBe(1920);
    expect(F.score - F.rope).toBe(2 * 2 * 4 * 15);
    expect(F.mix - F.softmax).toBe(240);
    expect(F.wo - F.mix).toBe(640);
    expect(F.wo).toBe(3040);
    expect(MATMUL_FLOPS).toBe(2560);
    expect(MIX_FLOPS).toBe(480);
    expect(stepOf('attention', 4).detail).toContain('其中 4 次矩阵乘占 2560，打分和加权求和只占 480');
    expect(PROMPT_TRACE.meter.by.qkv / 2).toBe(F.qkv);
  });
});

describe('一层 Transformer 前向', () => {
  const C = MODEL.config;
  const A = layer0.steps[LAST];
  const B = layer1.steps[LAST];

  it('重放、最后的 RMSNorm 和 logits 都和 forward 相同', () => {
    expect(layer0.steps).toEqual(PROMPT_TRACE.positions.map((p) => p.layers[0]));
    expect(layer1.steps).toEqual(PROMPT_TRACE.positions.map((p) => p.layers[1]));
    const last = PROMPT_TRACE.positions[LAST];
    expect(final.y).toEqual(last.finalNormed);
    expect(logits).toEqual(last.logits);
    expect(TOTAL_FLOPS).toBe(PROMPT_TRACE.meter.total);
    expect(TOTAL_FLOPS).toBe(19408);
    expect(LMHEAD_FLOPS).toBe(2 * 353 * 8);
  });

  it('RMSNorm：除以 rms 之后均方根是 1', () => {
    expect(unitRms).toBeCloseTo(1, 5);
    expect(stepOf('block', 0).desc).toBe('rms = 1.874，除完再乘 γ');
  });

  it('残差流的长度和改动', () => {
    expect([lengths.embed, lengths.resid0, lengths.out0, lengths.resid1, lengths.out1].map((x) => fixed(x, 2))).toEqual(['5.30', '5.56', '6.13', '5.17', '21.53']);
    const attnDelta = A.resid.map((value, i) => value - A.input[i]);
    expect(biggest(attnDelta)).toBe(5);
    expect(stepOf('block', 1).detail).toContain('改动最大的是第 5 维，加了 0.76');
    // 残差：x + attn_out，逐位相同。
    expect(A.resid).toEqual(A.input.map((value, i) => Math.fround(value + A.attnOut[i])));
    expect(stepOf('block', 3).desc).toBe('一层结束，x 的长度变成 6.13');
    expect(stepOf('block', 4).detail).toContain('x 的长度从 5.17 变成 21.53');
  });

  it('SwiGLU 的说法', () => {
    expect(SILU_MIN).toBeCloseTo(-0.2785, 3);
    expect(silu(5)).toBeGreaterThan(4.9);
    expect(A.gate.filter((g) => g < 0)).toHaveLength(8);
    expect(maxNegAct).toBeLessThan(0.17);
    expect(maxPosAct).toBeGreaterThan(1);
    expect(stepOf('block', 2).detail).toContain('gate 有 8 维是负的，乘完之后这几维的绝对值都不超过 0.17，正的那些最大到 1.05');
    expect(A.act).toEqual(A.gate.map((g, i) => Math.fround(Math.fround(silu(g)) * A.up[i])));
  });

  it('第 1 层的注意力和 lm_head', () => {
    expect(B.heads.map((head) => PROMPT_LABELS[head.probs.indexOf(Math.max(...head.probs))])).toEqual(['the', '␣model']);
    expect(stepOf('block', 4).detail).toContain('最看重的是「the」和「␣model」');
    expect(top.slice(0, 2).map((id) => T.label(id))).toEqual(['␣token', '文']);
    expect(probs[top[0]]).toBeGreaterThan(0.998);
    expect(stepOf('block', 5).desc).toBe('「␣token」得分最高，概率 99.8%');
    expect(stepOf('block', 5).detail).toContain('是 22.95，远高于第二名「文」的 16.1');
    expect(stepOf('block', 5).detail).toContain('占整次前向的 29.1%');
    // 「生成下一个 token 只需要最后一个位置的 logits」：forward 也只算了它。
    expect(PROMPT_TRACE.positions.slice(0, LAST).every((p) => p.logits.length === 0)).toBe(true);
    expect(logits).toHaveLength(C.vocab);
  });
});

describe('图像切 patch 变 token', () => {
  const V = MODEL.config;

  it('字节：PPM 文件头和像素', () => {
    expect(SAMPLE_IMAGE.data).toHaveLength(192);
    expect(PPM_HEADER).toBe(11);
    expect(String.fromCharCode(...ppm.slice(0, PPM_HEADER))).toBe('P6\n8 8\n255\n');
    expect(ppm.slice(PPM_HEADER)).toEqual(SAMPLE_IMAGE.data);
    expect(factsOf('vision', 0).左上角).toBe('天空 (135, 196, 235)');
  });

  it('patch：4 块，每块 48 字节，拼起来就是原图', () => {
    expect(patchRun.patches).toHaveLength(4);
    const rebuilt = new Array<number>(192).fill(-1);
    for (const patch of patchRun.patches) {
      expect(patch.bytes).toHaveLength(48);
      patch.bytes.forEach((byte, i) => {
        const pixel = Math.floor(i / 3);
        const x = patch.col * 4 + (pixel % 4);
        const y = patch.row * 4 + Math.floor(pixel / 4);
        rebuilt[(y * 8 + x) * 3 + (i % 3)] = byte;
      });
    }
    expect(rebuilt).toEqual(SAMPLE_IMAGE.data);
    // ViT 论文：224 / 16 = 14，14 × 14 = 196；ViT-B/16 每个 patch 16 × 16 × 3 = 768 个数。
    expect(stepOf('vision', 1).detail).toContain('得到 196 个 patch');
    expect(16 * 16 * 3).toBe(768);
  });

  it('归一化', () => {
    expect(normalizePixel(255)).toBe(1);
    expect(normalizePixel(0)).toBe(-1);
    expect(fixed(normalizePixel(135), 4)).toBe('0.0588');
    expect(stepOf('vision', 2).detail).toContain('天空的红色通道 135 变成 0.0588');
  });

  it('投影：逐个 patch 重算和 patchEmbed 相同', () => {
    projectedAgain.forEach((item, i) => expect(item.value).toEqual(patchRun.projected[i]));
    expect(projectedAgain.map((item) => item.flops)).toEqual([768, 1536, 2304, 3072]);
    expect(stepOf('vision', 3).detail).toContain('4 × 2 × 8 × 48 = 3072 FLOPs');
    patchRun.vectors.forEach((vec) => expect(vec).toHaveLength(V.dModel));
  });

  it('序列：图像在前，文字在后，照常前向', () => {
    expect(VISION_TEXT).toBe('the model reads the');
    expect(textIds.map((id) => T.label(id))).toEqual(['the', '␣model', '␣rea', 'ds', '␣the']);
    expect(inputs.map((item) => item.token)).toEqual([NO_TOKEN, NO_TOKEN, NO_TOKEN, NO_TOKEN, ...textIds]);
    expect(withImage.positions.map((p) => p.pos)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // 带图前向的 FLOPs：9 个位置走完 2 层，加最后一个位置的 lm_head。
    const again = forwardEmbeds(MODEL, inputs, { lastLogitsOnly: true });
    expect(again.positions.at(-1)!.logits).toEqual(withImage.positions.at(-1)!.logits);
    expect(again.meter.total).toBe(31568);
    expect(factsOf('vision', 5)['前向 FLOPs']).toBe('31568');
    // 文字部分的嵌入和不带图时一样，但位置往后挪了 4 个。
    expect(withImage.positions[4].embed).toEqual(textOnly.positions[0].embed);
  });

  it('图像改变了输出', () => {
    expect(T.label(textTop[0])).toBe('␣text');
    expect(T.label(imageTop[0])).toBe('␣l');
    expect(stepOf('vision', 5).desc).toBe('预测从「␣text」变成「␣l」');
    expect(stepOf('vision', 5).detail).toContain('预测从「␣text」35.3% 变成「␣l」31.6%');
    expect(textProbs[textTop[0]]).toBeGreaterThan(imageProbs[textTop[0]]);
    // 「第 1 层头 1 把 98.7% 的注意力放在图像位置」，而且是所有头里最多的。
    expect(peak).toMatchObject({ layer: 1, head: 1 });
    expect(fixed(peak.share * 100, 1)).toBe('98.7');
    for (const heads of imageShare) for (const item of heads) expect(item.share).toBeLessThanOrEqual(peak.share);
    expect(stepOf('vision', 5).detail).toContain('在第 1 层头 1 上把 98.7% 的注意力放在图像位置');
  });

  it('总结里的算术', () => {
    expect((336 / 14) ** 2).toBe(576);
    expect(LESSON_BY_ID.vision.outro.text).toContain('就有 576 个 patch');
  });
});

describe('表示组文案里没有残留的占位符', () => {
  it.each(['embed', 'attention', 'block', 'vision'])('%s', (id) => {
    const text = allText(id);
    expect(text).not.toMatch(/undefined|NaN|\$\{|e−\d/);
  });
});
