/**
 * 推理组（prefill、kvcache、prefix、batching、quant）的文案核对。
 * 和 narrative.test.ts 一样核对两类东西：取值之后的文字是否等于手算结果；文字里没法取值的定性说法是否成立。
 * 改了提示词、模型或调度配置，这里会报错，提醒同时改写文案。
 */
import { describe, expect, it } from 'vitest';
import { LESSON_BY_ID } from '../src/lessons';
import * as B from '../src/lessons/batching';
import * as K from '../src/lessons/kvcache';
import * as P from '../src/lessons/prefill';
import * as X from '../src/lessons/prefix';
import * as Q from '../src/lessons/quant';
import { PROMPT_IDS } from '../src/lessons/infer-common';
import { H100, LLAMA3_8B, paramsOf, ridgePoint } from '../src/engine/roofline';
import { MODEL, TOKENIZER } from '../src/model';
import { argmax, FlopMeter } from '../src/model/tensor';
import { forward, generate, KVCache, lastLogits } from '../src/model/transformer';
import { dequantizeQ4_0, f16FromBits, q4_0Bytes, q8_0Bytes, QK } from '../src/model/numeric';

const T = TOKENIZER;
const C = MODEL.config;
const stepOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step];
const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const allText = (id: string) => {
  const l = LESSON_BY_ID[id];
  return [l.overview.description, ...l.steps.flatMap((s) => [s.title, s.desc, s.detail]), l.outro.text].join('\n');
};

describe('预填充与解码', () => {
  it('手算结果', () => {
    // 每个位置每层：QKV 3 × 2 × 64 + O 2 × 64 + FFN 3 × 2 × 128 = 1280，2 层 2560；8 个位置 20480。
    // 注意力：每层每个位置 4 × 2 头 × 4 维 × (p+1)，8 个位置 Σ(p+1) = 36，2 层 2304。输出层只算最后一个：2 × 353 × 8 = 5648。
    expect(P.prefillFlops).toBe(20480 + 2304 + 5648);
    expect(stepOf('prefill', 0).desc).toBe('8 个位置一次前向，28432 FLOPs');
    expect(P.prefillBy).toMatchObject({ ffn: 12288, lmhead: 5648, score: 1152, mix: 1152 });
    // 读权重：层矩阵 1280 + γ 32 + 输出层 2824 + final γ 8 + 8 行嵌入 64 = 4208 个 × 2 字节。
    expect(P.prefillBytes).toBe(4208 * 2);
    expect(P.decodeBytes).toBe((4208 - 56) * 2);
    expect(P.lmHeadSaved).toBe(7 * 5648);
    expect(stepOf('prefill', 1).detail).toContain('省下 39536 FLOPs');
    expect(T.label(P.firstToken)).toBe('␣the');
    expect(P.decodes.map((d) => d.flops)).toEqual([8784, 8848, 8912]);
  });

  it('文案的说法成立', () => {
    // 「FFN 是最大的一块」
    const by = P.prefillBy as Record<string, number>;
    expect(Math.max(...Object.values(by))).toBe(by.ffn);
    // 「每步比上一步多 64 FLOPs」：注意力多看一行，4 × 2 头 × 4 维 × 2 层。
    for (let i = 1; i < P.decodes.length; i++) expect(P.decodes[i].flops - P.decodes[i - 1].flops).toBe(4 * C.nHeads * C.headDim * C.nLayers);
    expect(stepOf('prefill', 2).detail).toContain('每步比上一步多 64 FLOPs');
    // 「两段读的权重几乎一样多」
    expect(P.prefillBytes / P.decodeBytes).toBeLessThan(1.02);
    // 「预填充受算力限制、解码受带宽限制」的迷你版：强度差几倍，只看层差得更多，输出层两边都是 1。
    expect(P.intensity.prefill / P.intensity.decode).toBeGreaterThan(3);
    expect(P.intensity.prefillLayers / P.intensity.decodeLayers).toBeGreaterThan(P.intensity.prefill / P.intensity.decode);
    expect(P.intensity.lmHead).toBe(1);
    expect(stepOf('prefill', 3).desc).toBe('预填充 3.38，解码 1.06 FLOPs / 字节');
  });

  it('外推到 Llama 3 8B @ H100', () => {
    expect(P.real.params.total).toBe(8_030_261_248);
    expect(P.real.prefill.roof.bound).toBe('compute');
    expect(P.real.decode.roof.bound).toBe('memory');
    expect(P.real.prefill.roof.intensity).toBeGreaterThan(ridgePoint(H100));
    expect(P.real.decode.roof.intensity).toBeLessThan(2);
    expect(stepOf('prefill', 4).desc).toBe('Llama 3 8B：预填充 14.4 ms，解码每 token 4.48 ms');
    expect(stepOf('prefill', 4).detail).toContain('每秒最多约 223 个 token');
    expect(Object.fromEntries(stepOf('prefill', 4).facts).拐点).toBe('295 FLOPs / 字节');
    // 规格表里 BF16 写的是含稀疏的 1979 TFLOPS，稠密是它的一半（约 989）。
    expect(H100).toMatchObject({ flops: 989e12, bandwidth: 3.35e12 });
  });

  it('衔接', () => {
    expect(Object.fromEntries(LESSON_BY_ID.prefill.outro.facts).下一课).toBe('KV cache 增长与上下文窗口上限');
  });
});

describe('KV cache 与上下文窗口', () => {
  it('手算结果', () => {
    expect(K.perToken).toBe(2 * 2 * 2 * 4 * 2);
    expect(K.perToken).toBe(KVCache.valuesPerToken(C) * 2);
    expect(K.windowBytes).toBe(2048);
    expect(factsOf('kvcache', 0).迷你模型).toBe('2 × 2 × 2 × 4 × 2 = 64 字节');
    expect(K.llama.perToken).toBe(131072);
    expect(K.llama.context8k).toBe(1024 ** 3);
    expect(K.llama.context128k).toBe(16 * 1024 ** 3);
    expect(K.llama.noGqa).toBe(4 * 131072);
    expect(stepOf('kvcache', 4).desc).toBe('每 token 128 KiB，128K 上下文 16 GiB');
  });

  it('一直解码到窗口放满，再多一步就报错', () => {
    expect(K.steps[K.steps.length - 1].pos).toBe(C.maxSeq - 1);
    expect(K.generated).toHaveLength(C.maxSeq - PROMPT_IDS.length + 1);
    expect(K.overflowError).toContain('超出上下文窗口');
    expect(T.decode(K.generated)).toBe(' the keys and values, so the model does not read the');
    expect(stepOf('kvcache', 1).detail).toContain('cache 里已经存着「the cache keeps the keys and values, so the model」');
  });

  it('带 cache 和不带 cache：输出相同，FLOPs 差几倍，差距随长度变大', () => {
    expect(K.withCache.tokens).toEqual(K.noCache.tokens);
    expect(stepOf('kvcache', 2).desc).toBe(`同样生成 24 个 token：${K.withCache.meter.total} 对 ${K.noCache.meter.total} FLOPs`);
    expect(stepOf('kvcache', 2).detail).toContain('是 6.8 倍');
    const ratio = (n: number) => generate(MODEL, PROMPT_IDS, { maxTokens: n, noCache: true }).meter.total / generate(MODEL, PROMPT_IDS, { maxTokens: n }).meter.total;
    expect(ratio(8)).toBeLessThan(ratio(16));
    expect(ratio(16)).toBeLessThan(ratio(24));
  });

  it('「比 fp16 权重本身还大」「不用 GQA 放不进 80 GB」', () => {
    expect(K.llama.context128k).toBeGreaterThan(K.llama.weights);
    expect(K.llama.noGqaFits).toBe(false);
    expect(K.llama.weights + K.llama.context128k).toBeLessThan(H100.memory);
    expect(stepOf('kvcache', 4).detail).toContain('放不进 80 GB');
  });
});

describe('前缀缓存', () => {
  it('手算结果', () => {
    expect(X.ids.A).toHaveLength(22);
    expect(T.encode(X.SYSTEM)).toHaveLength(18);
    expect(X.runA.keys).toHaveLength(5);
    expect(X.runA.hits).toHaveLength(0);
    expect(X.runB.hits).toHaveLength(4);
    expect(X.runB.reused).toBe(16);
    expect(X.runB.computed).toBe(6);
    expect(X.runC.hits).toHaveLength(0);
    expect(Math.round(X.savedShare * 100)).toBe(64);
    expect(stepOf('prefix', 2).desc).toBe('复用 16 个位置，只算 6 个');
  });

  it('复用前缀的结果和完整重算逐位相同', () => {
    expect(lastLogits(X.runB.trace)).toEqual(lastLogits(forward(MODEL, X.ids.B, { lastLogitsOnly: true })));
    const meter = new FlopMeter();
    forward(MODEL, X.ids.B, { meter, lastLogitsOnly: true });
    expect(meter.total).toBe(X.fullB);
  });

  it('「系统提示的最后 2 个 token 和问题分在同一块里」', () => {
    const sys = T.encode(X.SYSTEM);
    expect(sys.length - X.runB.reused).toBe(2);
    expect(X.ids.B.slice(0, sys.length)).toEqual(sys);
    expect(X.runB.keys[X.runB.missAt].tokens.slice(0, 2)).toEqual(sys.slice(16));
    expect(stepOf('prefix', 2).detail).toContain('系统提示的最后 2 个 token');
  });

  it('C：只换第一个 token，后面相同；同一块 token 相同但哈希不同；第 0 层 K 相同、第 1 层 K 不同', () => {
    expect(X.ids.C[0]).not.toBe(X.ids.B[0]);
    expect(X.ids.C.slice(1)).toEqual(X.ids.B.slice(1));
    expect(X.sameTokensBlock).toBe(1);
    expect(X.runC.keys[1].tokens).toEqual(X.runB.keys[1].tokens);
    expect(X.runC.keys[1].hash).not.toBe(X.runB.keys[1].hash);
    expect(X.kDiffers).toBe(true);
    // 「从第 1 层起」：第 0 层的 K、V 只取决于 token 和位置，B 和 C 在这里相同。
    const pos = X.sameTokensBlock * X.BLOCK;
    expect(X.runC.cache.k[0][pos]).toEqual(X.runB.cache.k[0][pos]);
    expect(X.runC.cache.v[0][pos]).toEqual(X.runB.cache.v[0][pos]);
  });

  it('API 的计费说法', () => {
    const text = stepOf('prefix', 4).detail;
    expect(text).toContain('读缓存约为基础输入价的 0.1 倍（Opus 5.5、Sonnet 5.5 更低，是 0.05 倍），写缓存约 1.25 倍');
    expect(text).toContain('默认保留 5 分钟');
  });
});

describe('连续批处理与 PagedAttention', () => {
  it('每个请求的输出和单独生成相同', () => {
    for (const seq of B.continuous.seqs) expect(seq.output).toEqual(generate(MODEL, seq.request.prompt, { maxTokens: B.MAX_TOKENS, stop: T.eos }).tokens);
    expect(T.decode(B.continuous.seqs[0].output)).toBe(' text.');
    expect(B.continuous.seqs[0].finishReason).toBe('eos');
  });

  it('手算结果', () => {
    expect(B.perToken).toBe(64);
    expect(B.blockBytes).toBe(256);
    expect(B.firstFinish.index).toBe(3);
    expect(B.finishedFirst).toBe('R0');
    expect(B.lateAdmit.index).toBe(4);
    expect(B.lateId).toBe('R3');
    expect(B.peak.index).toBe(11);
    expect(B.peak.usedBlocks).toBe(12);
    // 峰值：3 个请求 13 + 14 + 15 = 42 个位置。预留 3 × 32 = 96，空 54 × 64 = 3456；分页 12 块 48 个位置，空 6 × 64 = 384。
    expect(B.peakReserved).toEqual({ reserved: 96, used: 42 });
    expect(B.waste).toEqual({ reserved: 54 * 64, paged: 6 * 64 });
    expect(B.reserveFits).toBe(2);
    expect(B.log).toHaveLength(15);
    expect(B.staticRun.log).toHaveLength(24);
    expect(stepOf('batching', 5).desc).toBe('15 轮对 24 轮');
  });

  it('文案的说法成立', () => {
    // 「R3 的块表物理上不连续」
    const table = B.peak.seqs.find((s) => s.id === 'R3')!.blockTable;
    expect(table.some((b, i) => i > 0 && b !== table[i - 1] + 1)).toBe(true);
    // 「浪费只出现在每个请求的最后一块里」
    for (const s of B.peak.seqs.filter((x) => x.status === 'running')) expect(s.blockTable.length).toBe(Math.ceil(s.length / 4));
    // 「按最大长度预留，池子只放得下 2 个请求」「分页 3 个还剩 4 块」
    expect(B.CONFIG.numBlocks * 4).toBeLessThan(3 * C.maxSeq);
    expect(B.CONFIG.numBlocks - B.peak.usedBlocks).toBe(4);
    // 「两种做法算的 FLOPs 完全一样」
    expect(B.staticRun.meter.total).toBe(B.continuous.meter.total);
    // 「拼成一批只读一遍权重」
    expect(B.batchRead.separate).toBe(3 * (4208 - 56) * 2);
    expect(B.batchRead.batched).toBe((4208 - 56 + 16) * 2);
    // 「R3 的预填充和 R1、R2 的解码拼在同一批里」
    expect(B.lateAdmit.prefill.map((p) => p.id)).toEqual(['R3']);
    expect(B.lateAdmit.decode).toEqual(['R1', 'R2']);
  });
});

describe('量化', () => {
  it('块格式', () => {
    expect(q8_0Bytes(Q.q8)).toHaveLength(34);
    expect(q4_0Bytes(Q.q4)).toHaveLength(18);
    expect(Q.WEIGHT_COUNT).toBe(1280);
    expect(Q.BLOCKS).toBe(40);
    expect(Q.sizes).toEqual({ f16: 2560, q8_0: 1360, q4_0: 720 });
    // 低 4 位是第 j 个，高 4 位是第 j + 16 个。
    expect(Q.q4.qs[0] & 0xf).toBe(Q.q4.q[0]);
    expect(Q.q4.qs[0] >> 4).toBe(Q.q4.q[16]);
  });

  it('文案的说法成立', () => {
    // 「w[19] 正好落在 q = 0、还原得一模一样」
    expect(Q.extremeIndex).toBe(19);
    expect(Q.q4.q[Q.extremeIndex]).toBe(0);
    expect(dequantizeQ4_0([Q.q4])[Q.extremeIndex]).toBe(Q.blockValues[Q.extremeIndex]);
    expect(Q.q8.qs[Q.extremeIndex]).toBe(-127);
    // 「Q8_0 的最大误差不到 d 的一半」
    expect(Q.blockError.q8.max).toBeLessThan(f16FromBits(Q.q8.d) / 2);
    expect(stepOf('quant', 2).detail).toContain(`是 Q8_0 的 ${Math.round(Q.blockError.q4.max / Q.blockError.q8.max)} 倍`);
    expect(Q.blockValues).toHaveLength(QK);
    expect(Q.modelError.q4.relative).toBeGreaterThan(Q.modelError.q8.relative * 10);
  });

  it('量化后再跑：Q8_0 不变，Q4_0 在第 4 个 token 分叉，第一个 token 不变', () => {
    expect(Q.divergeAt('q8_0')).toBe(-1);
    expect(Q.runs.q8_0.tokens).toEqual(Q.runs.f16.tokens);
    expect(Q.divergeAt('q4_0')).toBe(4);
    expect(argmax(Q.runs.q4_0.logits)).toBe(argmax(Q.runs.f16.logits));
    expect(argmax(Q.runs.q8_0.logits)).toBe(argmax(Q.runs.f16.logits));
    expect(Q.logitDiff('q4_0')).toBeGreaterThan(Q.logitDiff('q8_0'));
    expect(stepOf('quant', 4).desc).toBe('Q8_0 输出不变，Q4_0 从第 4 个 token 起分叉');
    // fp16 的基准和原始 fp32 权重的贪心输出相同。
    expect(Q.runs.f16.tokens).toEqual(generate(MODEL, PROMPT_IDS, { maxTokens: C.maxSeq - PROMPT_IDS.length, stop: T.eos }).tokens);
  });

  it('外推到 Llama 3 8B 的体积', () => {
    expect(Q.llama.total).toBe(paramsOf(LLAMA3_8B).total);
    expect(LESSON_BY_ID.quant.outro.text).toContain('fp16 下约 16.06 GB，Q8_0 约 8.53 GB，Q4_0 约 4.52 GB');
  });
});

describe('推理组：结构和衔接', () => {
  const ids = ['prefill', 'kvcache', 'prefix', 'batching', 'quant'];
  const next = ['KV cache 增长与上下文窗口上限', '前缀缓存（Prompt Caching 原理）', '连续批处理与 PagedAttention', '量化（fp16 → int4，对应 GGUF / Ollama）', 'logits → temperature → softmax'];

  it('outro 的下一课按 PLANNED 顺序', () => {
    ids.forEach((id, i) => expect(Object.fromEntries(LESSON_BY_ID[id].outro.facts).下一课, id).toBe(next[i]));
  });

  it('文案里没有漏掉的模板占位、NaN 或 undefined', () => {
    for (const id of ids) {
      const text = allText(id);
      expect(text, id).not.toMatch(/\$\{|NaN|undefined|Infinity/);
    }
  });

  it('真实系统的事实：vLLM 默认块大小 16、Llama 3 8B 配置', () => {
    expect(LESSON_BY_ID.prefix.overview.facts.find(([k]) => k === '块大小')![1]).toContain('vLLM 默认 16');
    expect(LLAMA3_8B).toMatchObject({ layers: 32, heads: 32, kvHeads: 8, headDim: 128, dModel: 4096, ffn: 14336, vocab: 128256, context: 8192 });
  });
});
