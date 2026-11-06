/**
 * 「采样与输出」五节课（temperature、topk、constrained、streaming、lora）的文案核对。
 * 做法同 narrative.test.ts：文案里的数字取自计算结果，这里再用独立的手算核对一遍；
 * 文字里没法取值的定性说法（「T=1.5 时第一名掉到 0.35 以下」「不加惩罚会复读」）用断言锁住，
 * 改了提示词、种子或语料后这里会报错，提醒同时改文案。
 */
import { describe, expect, it } from 'vitest';
import { decode } from '../src/decode/writer';
import { LESSON_BY_ID, PLANNED } from '../src/lessons';
import * as C from '../src/lessons/constrained';
import * as L from '../src/lessons/lora';
import * as S from '../src/lessons/streaming';
import * as K from '../src/lessons/topk';
import * as TP from '../src/lessons/temperature';
import { entropyBits, sampledRun } from '../src/lessons/sample-common';
import { packetsOf } from '../src/lessons/types';
import { Adam, cloneWeights, emptyGrads, forward, generate, MODEL, mulberry32, TOKENIZER as T, utf8Decode, utf8Encode } from '../src/model';

const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const stepOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step];
const labels = (ids: readonly number[]) => ids.map((id) => T.label(id));

/** 独立实现的 softmax（float64），用来核对采样器。 */
function softmax64(values: readonly number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

describe('每节课的下一课和计划一致', () => {
  it('outro 里的「下一课」是 PLANNED 里的下一节', () => {
    for (const id of ['temperature', 'topk', 'constrained', 'streaming']) {
      const index = PLANNED.findIndex((item) => item.id === id);
      const next = Object.fromEntries(LESSON_BY_ID[id].outro.facts).下一课 as string;
      expect(PLANNED[index + 1].title.startsWith(next), `${id} → ${next}`).toBe(true);
    }
    expect(Object.fromEntries(LESSON_BY_ID.lora.outro.facts).下一课).toMatch(/本站完/);
  });
});

describe('temperature', () => {
  const { base, runs, greedy, continuations } = TP;

  it('logits 来自真实前向，和提示词逐 token 解码一致', () => {
    expect(labels(base.ids)).toEqual(['the', '␣token', 'iz', 'er']);
    expect(base.logits).toHaveLength(T.size);
    expect(base.logits).toEqual(forward(MODEL, base.ids).positions.at(-1)!.logits);
    expect(labels([TP.base.logits.indexOf(Math.max(...base.logits))])).toEqual(['␣rea']);
  });

  it('除以 T：手算的 logit、概率和采样器一致', () => {
    TP.TEMPS.forEach((t, i) => {
      const scaled = base.logits.map((v) => v / t);
      const probs = softmax64(scaled);
      runs[i].probs.forEach((p, id) => expect(p).toBeCloseTo(probs[id], 12));
      expect(runs[i].scaled[0]).toBeCloseTo(scaled[0], 12);
    });
    // T=1 不改变 logits。
    expect(runs[1].scaled).toEqual(base.logits);
    expect(stepOf('temperature', 1).desc).toBe('T 越小，第一名领先越多');
    expect(factsOf('temperature', 1)['T=0.7']).toBe(`差距 ${(TP.gap / 0.7).toFixed(2)}`);
  });

  it('文案：T 越大第一名概率越低，T=1.5 掉到 0.35 以下，T=0.7 在 0.5 以上；熵递增', () => {
    expect(TP.topProbs[0]).toBeGreaterThan(0.5);
    expect(TP.topProbs[1]).toBeGreaterThan(TP.topProbs[2]);
    expect(TP.topProbs[0]).toBeGreaterThan(TP.topProbs[1]);
    expect(TP.topProbs[2]).toBeLessThan(0.35);
    expect(TP.entropies[0]).toBeLessThan(TP.entropies[1]);
    expect(TP.entropies[1]).toBeLessThan(TP.entropies[2]);
    TP.entropies.forEach((h, i) => expect(h).toBeCloseTo(entropyBits(softmax64(base.logits.map((v) => v / TP.TEMPS[i]))), 10));
    expect(TP.maxEntropy).toBeCloseTo(Math.log2(353), 10);
    // 前 6 名之外的尾巴随 T 变大。
    expect(TP.tailMass[0]).toBeLessThan(TP.tailMass[1]);
    expect(TP.tailMass[1]).toBeLessThan(TP.tailMass[2]);
    expect(stepOf('temperature', 2).desc).toBe('第一名的概率：T=0.7 为 53.8%，T=1 为 44.4%，T=1.5 为 33.6%');
  });

  it('T=0 是贪心（不用随机数）；T=1 的抽样与种子对应', () => {
    expect(greedy.u).toBeNull();
    expect(greedy.chosen).toBe(base.logits.indexOf(Math.max(...base.logits)));
    expect(runs[1].u).toBe(mulberry32(TP.SEED)());
    expect(runs[1].chosen).toBe(continuations[2].tokens[0]);
    expect(stepOf('temperature', 3).desc).toContain('u = 0.075');
  });

  it('续写：贪心等于 generate 的 argmax；T 越高越早偏离贪心', () => {
    const plain = generate(MODEL, base.ids, { maxTokens: TP.LENGTH, stop: T.eos });
    expect(continuations[0].tokens).toEqual(plain.tokens);
    expect(continuations[0].text).toBe(' reads bytes, merg');
    expect(TP.sharedPrefix).toEqual([8, 8, 4, 2]);
    expect(new Set(continuations.map((run) => run.text)).size).toBe(3);
    // 同一个种子再跑一遍，结果相同。
    expect(sampledRun(base.ids, { temperature: 1 }, TP.SEED, TP.LENGTH, false).tokens).toEqual(continuations[2].tokens);
    expect(stepOf('temperature', 4).detail).toContain('T=0.7 是 8，T=1 是 4，T=1.5 是 2');
  });

  it('运算量：预填充 + 解码，来自 FlopMeter', () => {
    const packets = packetsOf(LESSON_BY_ID.temperature);
    expect(packets[0].row.ops).toBe(base.flops);
    expect(packets.at(-1)!.row.ops).toBe(base.flops + continuations.reduce((sum, run) => sum + run.decodeFlops, 0));
  });
});

describe('topk', () => {
  const trace = K.guarded.traces[K.STEP];
  const more = K.plain.tokens[K.STEP];

  it('不加惩罚的贪心会复读，加了惩罚不复读', () => {
    expect(K.plain.text).toBe(' more tokens, and more tokens output, and more tokens output, and more tokens output');
    expect(K.repeatCount(K.plain.tokens)).toBe(10);
    expect(K.repeatCount(K.free.tokens)).toBeGreaterThanOrEqual(5);
    expect(K.repeatCount(K.guarded.tokens)).toBe(0);
    expect(stepOf('topk', 0).desc).toBe('贪心写了 20 个 token，其中 10 个在重复');
    expect(stepOf('topk', 5).desc).toBe(`没有惩罚复读 ${K.repeatCount(K.free.tokens)} 处，有惩罚 0 处`);
    // 复读的判据：3 个 token 的片段第二次出现。
    expect(K.repeatedAt([1, 2, 3, 1, 2, 3]).filter(Boolean)).toHaveLength(1);
  });

  it('单步演示的前提：前 4 个 token 与贪心相同，第 5 个贪心会再写「 more」', () => {
    expect(K.guarded.tokens.slice(0, K.STEP)).toEqual(K.plain.tokens.slice(0, K.STEP));
    expect(T.label(more)).toBe('␣more');
    expect(K.history).toContain(more);
    expect(K.rawTop[0]).toBe(more);
  });

  it('重复惩罚：出现过的正 logit 除以 1.1，负的乘以 1.1，其余不变', () => {
    const seen = new Set(K.history);
    trace.raw.forEach((value, id) => {
      const expected = !seen.has(id) ? value : value > 0 ? value / K.PENALTY : value * K.PENALTY;
      expect(trace.penalized[id]).toBeCloseTo(expected, 12);
    });
    expect(trace.penalized[more]).toBeCloseTo(trace.raw[more] / 1.1, 12);
    // 惩罚让「 more」从第 1 名掉到第 2 名，「 v」升到第 1 名。
    expect(K.penalizedTop.indexOf(more)).toBe(1);
    expect(T.label(K.penalizedTop[0])).toBe('␣v');
    expect(stepOf('topk', 1).desc).toBe('「␣more」的 logit 从 21 降到 19.1');
  });

  it('temperature、softmax、top-k、top-p 逐站手算', () => {
    const scaled = trace.penalized.map((v) => v / K.OPTIONS.temperature);
    const probs = softmax64(scaled);
    trace.probs.forEach((p, id) => expect(p).toBeCloseTo(probs[id], 12));
    const order = [...probs.keys()].sort((a, b) => probs[b] - probs[a] || a - b);
    expect(trace.afterTopK.map((c) => c.id)).toEqual(order.slice(0, 4));
    // top-p：在 top-k 的 4 个里重新归一化，从大到小累加到第一次 ≥ 0.8。
    const kept = order.slice(0, 4).map((id) => probs[id]);
    const total = kept.reduce((a, b) => a + b, 0);
    let sum = 0;
    const cumulative = kept.map((p) => (sum += p / total));
    expect(K.keptCumulative).toEqual(cumulative);
    expect(cumulative[1]).toBeLessThan(0.8);
    expect(cumulative[2]).toBeGreaterThanOrEqual(0.8);
    expect(K.keptByK).toBe(4);
    expect(K.keptByP).toBe(3);
    expect(trace.final.reduce((a, c) => a + c.p, 0)).toBeCloseTo(1, 12);
    expect(trace.final.map((c) => c.id)).toContain(trace.chosen);
    // 前 4 名之外的尾巴约 4%。
    expect(K.tailMass).toBeGreaterThan(0.03);
    expect(K.tailMass).toBeLessThan(0.05);
    expect(stepOf('topk', 2).desc).toBe('前 4 名之外还有 4% 的尾巴');
    expect(stepOf('topk', 3).desc).toBe('top-k=4 留 4 个，top-p=0.8 再留 3 个');
  });

  it('抽样：同一个种子得到同一个结果', () => {
    expect(sampledRun(T.encode(K.PROMPT), { ...K.OPTIONS, repetitionPenalty: K.PENALTY }, K.SEED, K.LENGTH).tokens).toEqual(K.guarded.tokens);
    expect(K.guarded.traces.at(-1)!.chosen === T.eos).toBe(K.guarded.ended);
  });
});

describe('constrained', () => {
  const run = C.cRun;
  const legal = C.LEGAL;

  it('无约束的输出都不是合法 JSON，有约束的全部合法', () => {
    expect(C.freeRuns).toHaveLength(3);
    for (const free of C.freeRuns) expect(C.isValid(free.text), free.text).toBe(false);
    expect(() => JSON.parse(C.PROMPT + C.freeGreedy.text)).toThrow();
    expect(C.freeValid).toBe(0);
    expect(C.guardedValid).toBe(C.TRIALS);
    expect(stepOf('constrained', 0).desc).toBe('3 次生成，合法的有 0 次');
    expect(stepOf('constrained', 4).desc).toBe('30 个种子，无约束合法 0 次，有约束合法 30 次');
  });

  it('有约束的生成：逐 token 是 " to ken " }，最后写出结束符', () => {
    expect(run.text).toBe('"token"}');
    expect(labels(run.tokens)).toEqual(['"', 'to', 'ken', '"', '}']);
    expect(run.ended).toBe(true);
    expect(run.traces).toHaveLength(6);
    expect(run.traces.at(-1)!.chosen).toBe(T.eos);
    expect(JSON.parse(C.PROMPT + run.text)).toEqual({ kind: 'token' });
    expect(legal).toEqual(['"token"}', '"model"}', '"cache"}']);
  });

  it('掩码逐步手算：接上之后仍是某个合法写法的开头；结束符只在写完时允许', () => {
    const sofar: number[] = [];
    run.traces.forEach((trace, step) => {
      const text = utf8Decode(sofar.flatMap((id) => T.bytesOf(id)));
      const expected = [...T.vocab.keys()].filter((id) => {
        if (id === T.eos) return legal.includes(text);
        const next = text + utf8Decode(T.bytesOf(id));
        return !utf8Decode(T.bytesOf(id)).includes('�') && legal.some((item) => item.startsWith(next));
      });
      expect(C.masks[step]).toEqual(expected);
      expect(C.masks[step]).toContain(trace.chosen);
      // 被禁止的 token，掩码后的概率恰好是 0。
      trace.probs.forEach((p, id) => {
        if (!C.masks[step].includes(id)) expect(p).toBe(0);
      });
      sofar.push(trace.chosen);
    });
    expect(C.masks.map((ids) => ids.length)).toEqual([1, 4, 3, 1, 1, 1]);
    expect(C.masks.at(-1)).toEqual([T.eos]);
    expect(factsOf('constrained', 2).允许).toBe(C.masks[1].map((id) => T.label(id)).join('、'));
    expect(stepOf('constrained', 1).desc).toBe('第一步只有 1 个合法 token');
  });

  it('文案：无约束的第一名每一步都是非法的；合法 token 在无约束时几乎没有概率', () => {
    expect(C.illegalTop).toBe(6);
    const raw0 = C.cRun.traces[0].raw;
    expect(T.label(raw0.indexOf(Math.max(...raw0)))).toBe('pt');
    expect(C.allowedMass[1]).toBeLessThan(1e-6);
    expect(stepOf('constrained', 2).desc).toBe('第 2 步 4 个合法，无约束的第一名「␣token」被禁止');
  });

  it('掩码后的概率：「to」比「t」大，两者之和为 1', () => {
    const final = run.traces[1].final;
    expect(labels(final.map((c) => c.id))).toEqual(['to', 't', 'c', 'm'].slice(0, final.length));
    expect(final[0].p).toBeGreaterThan(0.75);
    expect(final[0].p + final[1].p).toBeCloseTo(1, 4);
    expect(stepOf('constrained', 2).detail).toContain('「to」78.2%、「t」21.8%');
  });

  it('JSON schema 请求的字节能解析', () => {
    const body = utf8Encode(JSON.stringify({ response_format: { type: 'json_schema' } }));
    expect(body.length).toBeGreaterThan(0);
    const packet = packetsOf(LESSON_BY_ID.constrained)[1];
    const text = utf8Decode(decode(packet.wire).bytes.filter((b): b is number => b !== null));
    expect(JSON.parse(text).response_format.json_schema.schema.properties.kind.enum).toEqual(['token', 'model', 'cache']);
  });
});

describe('streaming', () => {
  const bytesOf = (ids: readonly number[]) => ids.flatMap((id) => T.bytesOf(id));

  it('生成路径：一个汉字的 3 个字节分在 3 个 token 里，最后是结束符', () => {
    expect(labels(S.run.tokens)).toEqual(['E5', '90', '91', 'E9', '87', '8F', '。']);
    expect(S.run.ended).toBe(true);
    expect(S.run.text).toBe('向量。');
    expect(S.charSpans).toEqual([{ char: '向', tokens: 3 }, { char: '量', tokens: 3 }, { char: '。', tokens: 1 }]);
    expect(stepOf('streaming', 1).desc).toBe('7 个 token 加结束符，一共 8 步');
  });

  it('流式解码：和 TextDecoder 一致，单独解码有 6 个乱码', () => {
    const bytes = bytesOf(S.run.tokens);
    expect(S.streamed).toBe('向量。');
    expect(S.streamed).toBe(new TextDecoder().decode(new Uint8Array(bytes)));
    // 对照浏览器自带的流式解码器。
    const decoder = new TextDecoder();
    const pieces = S.run.tokens.map((id) => decoder.decode(new Uint8Array(T.bytesOf(id)), { stream: true }));
    expect(pieces).toEqual(S.parts.map((part) => part.out));
    expect(S.parts.map((part) => part.pending.length)).toEqual([1, 2, 0, 1, 2, 0, 0]);
    expect(S.brokenNaive).toBe(6);
    expect(S.parts.slice(0, 3).map((part) => part.naive)).toEqual(['�', '�', '�']);
    expect(stepOf('streaming', 2).desc).toBe('单独解码有 6 个 token 是乱码，流式解码一个也没有');
    expect(factsOf('streaming', 2)['「读」']).toBe('E8 AF | BB');
  });

  it('SSE 帧：字节是 data: + JSON + 空行，内容拼起来是生成的文字', () => {
    expect(S.frames).toHaveLength(6);
    let text = '';
    S.frames.forEach((frame, i) => {
      const raw = utf8Decode(S.frameBytes(frame));
      expect(raw.startsWith('data: ')).toBe(true);
      expect(raw.endsWith('\n\n')).toBe(true);
      if (frame.data === '[DONE]') return;
      const json = JSON.parse(frame.data);
      expect(json.object).toBe('chat.completion.chunk');
      if (i === 0) expect(json.choices[0].delta).toEqual({ role: 'assistant', content: '' });
      text += json.choices[0].delta.content ?? '';
    });
    expect(text).toBe('向量。');
    expect(JSON.parse(S.frames.at(-2)!.data).choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    expect(S.frames.at(-1)!.data).toBe('[DONE]');
    // 事件里的字节和 frameBytes 一致。
    const frame = packetsOf(LESSON_BY_ID.streaming).find((p) => p.label === '「向」')!;
    expect(decode(frame.wire).bytes).toEqual(S.frameBytes(S.frames[1]));
  });

  it('三种停法：结束符 8 步、stop 序列 7 步、max_tokens 4 步卡在汉字中间', () => {
    expect(S.byEos).toMatchObject({ steps: 8, finish: 'stop', text: '向量。', cause: 'eos' });
    expect(S.byStop).toMatchObject({ steps: 7, finish: 'stop', text: '向量', cause: 'stop' });
    expect(S.byLength).toMatchObject({ steps: 4, finish: 'length', text: '向', cause: 'max_tokens' });
    expect(S.byLength.pending).toEqual([0xe9]);
    expect(S.flushed).toBe('�');
    // stop 序列本身不推给客户端；其余推出的文字相同。
    expect(S.byStop.deltas.join('')).toBe('向量');
    expect(stepOf('streaming', 4).desc).toBe('结束符和 stop 序列都是 "stop"，max_tokens 是 "length"');
  });

  it('贪心生成与 generate 一致', () => {
    expect(S.run.tokens).toEqual(generate(MODEL, T.encode(S.PROMPT), { maxTokens: S.MAX_TOKENS, stop: T.eos }).tokens);
  });
});

describe('lora', () => {
  const lossAt = (w: typeof MODEL) => L.lossOf(w);

  it('损失：比均匀瞎猜还大；SGD 一步下降，再走一步会反弹', () => {
    expect(labels(L.inputs)).toEqual(['the', '␣model', '␣is', '␣s', 'm', 'a', 'l', 'l', '.']);
    expect(L.targets.at(-1)).toBe(T.eos);
    expect(L.uniformLoss).toBeCloseTo(Math.log(353), 12);
    expect(L.baseLoss).toBeGreaterThan(L.uniformLoss);
    expect(L.baseLoss).toBeCloseTo(10.913, 2);
    expect(L.steppedLoss).toBeLessThan(L.baseLoss);
    expect(L.secondLoss).toBeGreaterThan(L.steppedLoss);
    expect(stepOf('lora', 0).desc).toBe('平均损失 10.91 nat，比瞎猜的 5.87 还差');
    expect(stepOf('lora', 2).desc).toBe('w ← w − 0.05·g，损失 10.91 → 5.84');
    // 损失就是各位置 −log p(目标) 的平均。
    expect(L.baseLosses.reduce((a, b) => a + b, 0) / L.baseLosses.length).toBeCloseTo(L.baseLoss, 12);
  });

  it('梯度用有限差分核对；SGD 就是 w − lr·g', () => {
    const w = cloneWeights(MODEL);
    const h = 1e-5;
    const probe = (delta: number) => {
      const next = cloneWeights(MODEL);
      next.output_norm[0] += delta;
      return lossAt(next);
    };
    expect((probe(h) - probe(-h)) / (2 * h)).toBeCloseTo(L.grads.output_norm[0], 6);
    expect(L.stepped.output_norm[0]).toBeCloseTo(w.output_norm[0] - L.SGD_LR * L.grads.output_norm[0], 12);
    expect(L.totalGradNorm).toBeGreaterThan(0);
    expect(L.gradTop[0].norm).toBeGreaterThanOrEqual(L.gradTop[1].norm);
  });

  it('原权重全程没被改：MODEL 的损失仍是最初的值', () => {
    expect(lossAt(MODEL)).toBe(L.baseLoss);
    expect(L.merged).not.toBe(MODEL);
  });

  it('参数量：手算 544 / 6968，占 7.81%；7B 级矩阵 0.39%', () => {
    // 每层：4 个 8×8 矩阵各 r(8+8)=32；3 个 16×8 / 8×16 矩阵各 r(8+16)=48。
    expect(L.loraCount).toBe(2 * (4 * 32 + 3 * 48));
    expect(L.loraCount).toBe(544);
    expect(L.paramTotal).toBe(6968);
    expect(L.adaptedFull).toBe(2 * (4 * 64 + 3 * 128));
    expect(L.loraCount / L.paramTotal).toBeLessThan(0.08);
    expect(L.loraCount / L.paramTotal).toBeGreaterThan(0.078);
    expect(L.BIG.lora / L.BIG.full).toBeCloseTo(0.0039, 4);
    expect(L.BIG.lora).toBe(65536);
    expect(L.loraTrainBytes).toBeLessThan(L.fullTrainBytes);
    expect(L.BIG7B_GB).toBe(112);
    expect(stepOf('lora', 3).desc).toBe('可训练参数 6968 → 544 个');
    expect(factsOf('lora', 3).可训练).toBe('544 / 6968 = 7.81%');
  });

  it('B 初始为 0，所以一开始和原模型完全一样；训练 20 步损失降到 0.1 以下', () => {
    expect(L.initialLoss).toBeCloseTo(L.baseLoss, 12);
    expect(L.curve).toHaveLength(L.LORA_STEPS + 1);
    expect(L.curve[5]).toBeLessThan(L.curve[0]);
    expect(L.finalLoss).toBeLessThan(0.1);
    expect(L.curve[L.LORA_STEPS]).toBe(L.finalLoss);
    expect(stepOf('lora', 4).desc).toBe('损失 10.91 → 0.08');
  });

  it('合并：W + s·B·A 手算一致，低秩，其余张量不变；合并后的损失等于训练时的损失', () => {
    const a = L.adapters[0];
    const W = MODEL.layers[a.layer].attn_q;
    const merged = L.merged.layers[a.layer].attn_q;
    for (const [i, j] of [[0, 0], [3, 5], [7, 7]]) {
      const delta = L.SCALE * (a.B[i][0] * a.A[0][j] + a.B[i][1] * a.A[1][j]);
      expect(merged[i][j]).toBe(Math.fround(W[i][j] + delta));
    }
    expect(L.mergeDemo.merged).toBe(merged[0][0]);
    // ΔW 的秩不超过 2：任意 3×3 子式为 0。
    const dW = W.map((row, i) => row.map((_, j) => L.SCALE * (a.B[i][0] * a.A[0][j] + a.B[i][1] * a.A[1][j])));
    const det3 = (r: number[], c: number[]) => {
      const m = r.map((i) => c.map((j) => dW[i][j]));
      return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    };
    expect(Math.abs(det3([0, 1, 2], [0, 1, 2]))).toBeLessThan(1e-9);
    expect(Math.abs(det3([2, 4, 6], [1, 3, 7]))).toBeLessThan(1e-9);
    expect(L.merged.token_embd).toEqual(MODEL.token_embd);
    expect(L.merged.output).toEqual(MODEL.output);
    expect(L.merged.layers[0].attn_norm).toEqual(MODEL.layers[0].attn_norm);
    expect(lossAt(L.merged)).toBe(L.finalLoss);
  });

  it('微调的效果与副作用：学会了这句话，别的提示词的续写也变了', () => {
    expect(L.answers.before).toBe(' is th the tokens.');
    expect(L.answers.after).toBe(' is small.');
    expect(L.answers.otherBefore).toBe(' reads bytes, merges the bytes');
    expect(L.answers.otherAfter).not.toBe(L.answers.otherBefore);
  });

  it('LoRA 用的 Adam 公式和 model/train.ts 的 Adam 一致', () => {
    const w = cloneWeights(MODEL);
    const g = emptyGrads(w);
    g.layers[0].attn_q = g.layers[0].attn_q.map((row, i) => row.map((_, j) => Math.sin(i * 8 + j)));
    const adam = new Adam(w, 0.03);
    adam.step(w, g);
    adam.step(w, g);
    const P = MODEL.layers[0].attn_q.map((row) => row.slice());
    const m = P.map((row) => row.map(() => 0));
    const v = P.map((row) => row.map(() => 0));
    L.adamMatrix(P, g.layers[0].attn_q, m, v, 1, 0.03);
    L.adamMatrix(P, g.layers[0].attn_q, m, v, 2, 0.03);
    P.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(w.layers[0].attn_q[i][j], 12)));
  });

  it('运算量：前向来自 FlopMeter，训练一步按 3 倍前向估算，LoRA 不合并时多出 x·Aᵀ·Bᵀ', () => {
    expect(L.FWD).toBeGreaterThan(0);
    expect(L.LORA_EXTRA).toBe(L.adapters.reduce((sum, a) => sum + 9 * 2 * 2 * (a.A[0].length + a.B.length), 0));
    const packets = packetsOf(LESSON_BY_ID.lora);
    expect(packets[0].row.ops).toBe(L.FWD);
    expect(packets[1].row.ops).toBe(3 * L.FWD);
  });
});
