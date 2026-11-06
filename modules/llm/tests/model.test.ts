/**
 * 计算核心的独立验证。期望值有三个来源，都不是被测代码算出来的：
 * 1. tests/vectors/*.json：tests/reference/vectors.py 用 numpy、Python 的 UTF-8 和 ggml 官方的 gguf-py 算出；
 * 2. 另一种算法现算（逐个合并的朴素 BPE、TextDecoder、有限差分、不带 cache 的重算）；
 * 3. 公开规范里的已知值（IEEE 754 的位模式、GPT-2 的字节映射）。
 */
import { describe, expect, it } from 'vitest';
import forwardVectors from './vectors/forward.json';
import quantVectors from './vectors/quant.json';
import utf8Vectors from './vectors/utf8.json';
import {
  applyPenalties,
  argmax,
  backward,
  bf16Bits,
  BYTE_TO_UNICODE,
  BYTES_PER_WEIGHT,
  choiceConstraint,
  cloneWeights,
  CORPUS,
  corpusStream,
  decodeStep,
  dequantizeQ4_0,
  dequantizeQ8_0,
  embedTokens,
  encodeAs,
  f16Bits,
  f16FromBits,
  f32Bytes,
  FlopMeter,
  forward,
  forwardEmbeds,
  gaussian,
  generate,
  i32Bytes,
  imageInputs,
  initWeights,
  KVCache,
  lastLogits,
  loraGrads,
  loraMerge,
  makeConfig,
  mergeEntry,
  MODEL,
  mulberry32,
  NO_TOKEN,
  numPatches,
  paramCount,
  patchEmbed,
  patchify,
  ppmBytes,
  prefixMask,
  pretokenize,
  q4_0Bytes,
  q8_0Bytes,
  quantizeQ4_0,
  quantizeQ8_0,
  rmsnorm,
  SAMPLE_IMAGE,
  sample,
  sequenceLoss,
  serializeWeights,
  sgdStep,
  softmax,
  spliceImage,
  tensorsOf,
  TOKENIZER,
  tokenizerFingerprint,
  trainFromScratch,
  utf8Decode,
  utf8Encode,
  Utf8Stream,
  VISION,
  WEIGHTS_FILE,
  type Weights,
} from '../src/model';

/** 测试自己的随机源，和被测代码的 PRNG 无关。 */
function lcg(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

const randomText = (rand: (n: number) => number, length: number) => {
  const pool = ['a', 'b', ' ', 'e', 't', 'o', 'k', 'n', '。', '，', '的', '模', '型', '读', '大', '1', '2', 'é', '🙂', '\n', 'token', ' the', '中文'];
  return Array.from({ length }, () => pool[rand(pool.length)]).join('');
};

const toHex = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('UTF-8', () => {
  it('编码和 Python 的 str.encode 一致', () => {
    for (const { text, bytes } of utf8Vectors.encode) expect(utf8Encode(text)).toEqual(bytes);
  });

  it('非法序列的替换规则和 Python 的 errors=replace 一致', () => {
    for (const { bytes, text } of utf8Vectors.decode) expect(utf8Decode(bytes)).toBe(text);
  });

  it('随机字节：和浏览器的 TextDecoder 一致', () => {
    const rand = lcg(7);
    const decoder = new TextDecoder();
    for (let round = 0; round < 500; round++) {
      const bytes = Array.from({ length: 1 + rand(12) }, () => (rand(3) ? 0x80 + rand(0x80) : rand(0x80)));
      expect(utf8Decode(bytes), toHex(bytes)).toBe(decoder.decode(new Uint8Array(bytes)));
    }
  });

  it('流式解码：在任意位置切开，拼起来都等于原文，不会提前吐出半个字', () => {
    const text = '大模型读 token 🙂';
    const bytes = utf8Encode(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const stream = new Utf8Stream();
      const first = stream.push(bytes.slice(0, cut));
      expect(first).not.toContain('�');
      expect(first + stream.push(bytes.slice(cut)) + stream.flush()).toBe(text);
    }
  });
});

describe('BPE 分词器', () => {
  const T = TOKENIZER;

  it('词表 = 256 个字节 + 合并规则 + 结束符', () => {
    expect(T.size).toBe(256 + T.merges.length + 1);
    expect(T.eos).toBe(T.size - 1);
    expect(T.merges.length).toBe(96);
    T.merges.forEach((merge, rank) => {
      expect(merge.rank).toBe(rank);
      expect(merge.id).toBe(256 + rank);
    });
  });

  it('训练时每一步选的对，出现次数单调不增', () => {
    T.merges.slice(1).forEach((merge, i) => expect(merge.count).toBeLessThanOrEqual(T.merges[i].count));
  });

  it('预分词拼起来等于原文', () => {
    const rand = lcg(11);
    for (let round = 0; round < 300; round++) {
      const text = randomText(rand, 1 + rand(20));
      expect(pretokenize(text).join('')).toBe(text);
    }
  });

  /** 独立的朴素实现：每次只合并最左边那个 rank 最小的对。 */
  function naiveEncode(text: string): number[] {
    return pretokenize(text).flatMap((chunk) => {
      const ids = utf8Encode(chunk);
      for (;;) {
        let best = -1;
        let bestRank = Infinity;
        for (let i = 0; i + 1 < ids.length; i++) {
          const rank = T.merges.findIndex((merge) => merge.pair[0] === ids[i] && merge.pair[1] === ids[i + 1]);
          if (rank >= 0 && rank < bestRank) {
            bestRank = rank;
            best = i;
          }
        }
        if (best < 0) return ids;
        ids.splice(best, 2, T.merges[bestRank].id);
      }
    });
  }

  it('encode、encodeTrace 和朴素实现结果相同，解码还原原文', () => {
    const rand = lcg(3);
    const texts = [...CORPUS, ...Array.from({ length: 200 }, () => randomText(rand, 1 + rand(16)))];
    for (const text of texts) {
      const ids = T.encode(text);
      expect(T.encodeTrace(text).ids, text).toEqual(ids);
      expect(naiveEncode(text), text).toEqual(ids);
      expect(T.decode(ids), text).toBe(text);
    }
  });

  it('encodeTrace 用上的 rank 严格递增，查表次数单调增加', () => {
    const trace = T.encodeTrace(CORPUS.join(' '));
    trace.steps.slice(1).forEach((step, i) => {
      expect(step.merge.rank).toBeGreaterThan(trace.steps[i].merge.rank);
      expect(step.lookups).toBeGreaterThan(trace.steps[i].lookups);
    });
    expect(trace.lookups).toBeGreaterThan(trace.steps[trace.steps.length - 1].lookups);
  });

  it('GPT-2 字节映射：和 tokenizer.json 里常见的写法一致', () => {
    expect(BYTE_TO_UNICODE[0x20]).toBe('Ġ');
    expect(BYTE_TO_UNICODE[0x0a]).toBe('Ċ');
    expect(BYTE_TO_UNICODE[0x21]).toBe('!');
    expect(BYTE_TO_UNICODE[0xad]).toBe('Ń');
    expect(BYTE_TO_UNICODE[0xe6]).toBe('æ');
    expect(new Set(BYTE_TO_UNICODE).size).toBe(256);
    expect(mergeEntry(T, T.merges[0])).toBe('Ġ t');
  });

  it('展示文字：空格写成 ␣，半个字符写成十六进制，结束符有名字', () => {
    expect(T.label(T.encode(' token')[0])).toBe('␣token');
    expect(T.label(0xe5)).toBe('E5');
    expect(T.label(T.eos)).toBe('<|end|>');
    expect(T.decode([T.eos])).toBe('');
  });
});

describe('随机数', () => {
  it('同一个种子得到同一个序列，范围在 [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('正态分布的均值和方差', () => {
    const normal = gaussian(mulberry32(1));
    const xs = Array.from({ length: 20000 }, normal);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});

describe('张量运算', () => {
  it('softmax：和为 1，被掩码的位置是 0', () => {
    const probs = softmax([1, 2, -Infinity, 3], (x) => x);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(probs[2]).toBe(0);
    expect(argmax(probs)).toBe(3);
  });

  it('RMSNorm：输出的均方根等于 1（γ 全为 1 时）', () => {
    const { y } = rmsnorm([3, -4, 0, 12], [1, 1, 1, 1], 0, (x) => x);
    expect(Math.sqrt(y.reduce((a, b) => a + b * b, 0) / y.length)).toBeCloseTo(1, 12);
  });

  it('argmax 并列时取下标小的', () => {
    expect(argmax([1, 5, 5, 2])).toBe(1);
  });
});

describe('迷你 Transformer', () => {
  const W = MODEL;
  const { config } = W;

  it('结构：d_model 8，2 头，2 层，FFN 16，上下文 32', () => {
    expect(config).toMatchObject({ vocab: TOKENIZER.size, dModel: 8, nHeads: 2, headDim: 4, nLayers: 2, dFF: 16, maxSeq: 32 });
    const per = 2 * 8 + 4 * 8 * 8 + 3 * 16 * 8;
    expect(paramCount(W)).toBe(2 * config.vocab * 8 + 2 * per + 8);
    expect(tensorsOf(W).map((tensor) => tensor.name).slice(0, 4)).toEqual(['token_embd.weight', 'blk.0.attn_norm.weight', 'blk.0.attn_q.weight', 'blk.0.attn_k.weight']);
    expect(tensorsOf(W)[0].shape).toEqual([8, config.vocab]);
  });

  it('logits 和 numpy 的独立实现一致', () => {
    expect(forwardVectors.tokenizer).toBe(tokenizerFingerprint(TOKENIZER));
    for (const { tokens, logits } of forwardVectors.cases) {
      const trace = forward(W, tokens);
      trace.positions.forEach((p, t) => {
        p.logits.forEach((value, i) => expect(Math.abs(value - logits[t][i]), `位置 ${t} token ${i}`).toBeLessThan(2e-4 * Math.max(1, Math.abs(logits[t][i]))));
      });
    }
  });

  it('KV cache：逐个 token 解码和一次完整前向逐位相同', () => {
    const tokens = corpusStream(TOKENIZER).slice(40, 40 + config.maxSeq);
    const full = forward(W, tokens);
    const cache = new KVCache(config);
    tokens.forEach((token, t) => {
      const step = decodeStep(W, cache, token);
      expect(step.logits).toEqual(full.positions[t].logits);
      expect(step.layers[1].heads[0].probs).toEqual(full.positions[t].layers[1].heads[0].probs);
    });
    expect(cache.length).toBe(config.maxSeq);
    expect(cache.free).toBe(0);
  });

  it('预填充可以分段：任意切分都和完整前向相同', () => {
    const tokens = TOKENIZER.encode('the model reads the tokens and');
    const full = forward(W, tokens);
    for (const cut of [1, 3, tokens.length - 1]) {
      const cache = new KVCache(config);
      forward(W, tokens.slice(0, cut), { cache });
      const rest = forward(W, tokens.slice(cut), { cache });
      expect(lastLogits(rest)).toEqual(lastLogits(full));
    }
  });

  it('前缀缓存：复制并截断 cache 后续算，结果不变', () => {
    const tokens = TOKENIZER.encode('the model writes text');
    const cache = new KVCache(config);
    forward(W, tokens, { cache });
    const reused = cache.clone();
    reused.truncate(3);
    const again = forward(W, tokens.slice(3), { cache: reused });
    expect(lastLogits(again)).toEqual(lastLogits(forward(W, tokens)));
    expect(cache.length).toBe(tokens.length);
  });

  it('超出上下文窗口会报错', () => {
    expect(() => forward(W, new Array(config.maxSeq + 1).fill(1))).toThrow('上下文窗口');
  });

  it('FLOPs：每步 = 2 × 矩阵参数 + 注意力点积，和公式一致', () => {
    const tokens = TOKENIZER.encode('a token is');
    const cache = new KVCache(config);
    forward(W, tokens, { cache });
    const meter = new FlopMeter();
    decodeStep(W, cache, tokens[0], meter);
    const { dModel: d, dFF, nLayers, nHeads, headDim, vocab } = config;
    const n = tokens.length + 1;
    const matmul = 2 * nLayers * (4 * d * d + 3 * d * dFF) + 2 * d * vocab;
    const attention = nLayers * nHeads * 2 * (2 * headDim * n);
    expect(meter.total).toBe(matmul + attention);
    expect(meter.by.lmhead).toBe(2 * d * vocab);
    expect(KVCache.valuesPerToken(config)).toBe(2 * nLayers * d);
  });

  it('生成：带 cache 和不带 cache 选出同样的 token，不带 cache 的 FLOPs 多得多', () => {
    const prompt = TOKENIZER.encode('大模型');
    const fast = generate(W, prompt, { maxTokens: 10, stop: TOKENIZER.eos });
    const slow = generate(W, prompt, { maxTokens: 10, stop: TOKENIZER.eos, noCache: true });
    expect(slow.tokens).toEqual(fast.tokens);
    expect(slow.meter.total).toBeGreaterThan(fast.meter.total * 2);
  });

  it('预训练让模型记住了语料：贪心续写「大模型」得到语料里的句子', () => {
    const prompt = TOKENIZER.encode('大模型');
    const { tokens } = generate(W, prompt, { maxTokens: 20, stop: TOKENIZER.eos });
    expect(TOKENIZER.decode(tokens)).toBe('一次生成一个 token。');
  });

  it('预训练权重可以复现：重新训练一遍，逐字节相同', () => {
    expect(WEIGHTS_FILE.tokenizer).toBe(tokenizerFingerprint(TOKENIZER));
    const { weights, logs } = trainFromScratch(TOKENIZER);
    const again = serializeWeights(weights, TOKENIZER, { ...WEIGHTS_FILE.train, logs });
    expect(again.data).toBe(WEIGHTS_FILE.data);
    expect(logs).toEqual(WEIGHTS_FILE.train.logs);
    expect(logs[logs.length - 1].loss).toBeLessThan(logs[0].loss / 5);
  }, 30_000);
});

describe('反向传播', () => {
  const small = initWeights(makeConfig(TOKENIZER.size), 7);
  const tokens = [5, 77, 260, 300, 12, 9];
  const targets = [77, 260, 300, 12, 9, 88];
  const loss = (w: Weights) => sequenceLoss(forward(w, tokens, { fp64: true }), targets);
  const grads = backward(small, forward(small, tokens, { fp64: true }), targets);

  const probes: Array<[string, (w: Weights) => number[], number]> = [
    ['token_embd[77]', (w) => w.token_embd[77], 3],
    ['blk.0.attn_q[2]', (w) => w.layers[0].attn_q[2], 5],
    ['blk.0.attn_k[6]', (w) => w.layers[0].attn_k[6], 1],
    ['blk.1.attn_v[3]', (w) => w.layers[1].attn_v[3], 7],
    ['blk.1.attn_output[0]', (w) => w.layers[1].attn_output[0], 2],
    ['blk.0.ffn_gate[9]', (w) => w.layers[0].ffn_gate[9], 4],
    ['blk.1.ffn_up[3]', (w) => w.layers[1].ffn_up[3], 0],
    ['blk.0.ffn_down[5]', (w) => w.layers[0].ffn_down[5], 11],
    ['blk.0.attn_norm', (w) => w.layers[0].attn_norm, 2],
    ['blk.1.ffn_norm', (w) => w.layers[1].ffn_norm, 6],
    ['output_norm', (w) => w.output_norm, 1],
    ['output[88]', (w) => w.output[88], 4],
  ];

  it.each(probes)('%s：和有限差分一致', (_name, pick, index) => {
    const row = pick(small);
    const original = row[index];
    const eps = 1e-5;
    row[index] = original + eps;
    const plus = loss(small);
    row[index] = original - eps;
    const minus = loss(small);
    row[index] = original;
    const numeric = (plus - minus) / (2 * eps);
    const analytic = pick(grads)[index];
    expect(Math.abs(numeric - analytic) / Math.max(1e-8, Math.abs(numeric) + Math.abs(analytic))).toBeLessThan(1e-6);
  });

  it('SGD 一小步之后损失下降', () => {
    const w = cloneWeights(small);
    const before = loss(w);
    sgdStep(w, backward(w, forward(w, tokens, { fp64: true }), targets), 0.05);
    expect(loss(w)).toBeLessThan(before);
  });

  it('LoRA：由整矩阵梯度推出的 dA、dB 和有限差分一致', () => {
    const rand = mulberry32(5);
    const r = 2;
    const s = 2;
    const A = Array.from({ length: r }, () => Array.from({ length: 8 }, () => rand() - 0.5));
    const B = Array.from({ length: 8 }, () => Array.from({ length: r }, () => rand() - 0.5));
    const base = cloneWeights(small);
    const withLora = () => {
      const w = cloneWeights(base);
      w.layers[1].attn_q = base.layers[1].attn_q.map((row, i) => row.map((value, j) => value + s * B[i].reduce((sum, b, k) => sum + b * A[k][j], 0)));
      return w;
    };
    const merged = withLora();
    const dW = backward(merged, forward(merged, tokens, { fp64: true }), targets).layers[1].attn_q;
    const { dA, dB } = loraGrads(dW, A, B, s);
    const check = (M: number[][], G: number[][], i: number, j: number) => {
      const original = M[i][j];
      M[i][j] = original + 1e-5;
      const plus = loss(withLora());
      M[i][j] = original - 1e-5;
      const minus = loss(withLora());
      M[i][j] = original;
      expect(Math.abs((plus - minus) / 2e-5 - G[i][j])).toBeLessThan(1e-7);
    };
    check(A, dA, 1, 3);
    check(B, dB, 5, 0);
    expect(loraMerge(base.layers[1].attn_q, A, B, s)[2][3]).toBe(Math.fround(merged.layers[1].attn_q[2][3]));
  });
});

describe('采样', () => {
  const logits = [2, 1, 0.5, -1, 3, -Infinity];

  it('贪心：直接取最大，不用随机数', () => {
    const trace = sample(logits, [], { temperature: 0 });
    expect(trace.chosen).toBe(4);
    expect(trace.u).toBeNull();
  });

  it('temperature：logits 除以 T，T 越大分布越平', () => {
    const cold = sample(logits, [], { temperature: 0.5 }, mulberry32(1));
    const hot = sample(logits, [], { temperature: 2 }, mulberry32(1));
    expect(cold.scaled[0]).toBe(4);
    expect(hot.scaled[0]).toBe(1);
    expect(cold.ranked[0].prob).toBeGreaterThan(hot.ranked[0].prob);
    expect(cold.probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('top-k 和 top-p 留下的候选', () => {
    const k = sample(logits, [], { topK: 2 }, mulberry32(1));
    expect(k.afterTopK.map((item) => item.id)).toEqual([4, 0]);
    const probs = softmax(logits, (x) => x);
    const p = sample(logits, [], { topP: 0.9 }, mulberry32(1));
    // 按概率从高到低累加，第一次 ≥ 0.9 时停下。
    const order = [4, 0, 1, 2, 3];
    let sum = 0;
    const expected: number[] = [];
    for (const id of order) {
      expected.push(id);
      sum += probs[id];
      if (sum >= 0.9) break;
    }
    expect(p.afterTopP.map((item) => item.id)).toEqual(expected);
    expect(p.final.reduce((a, item) => a + item.p, 0)).toBeCloseTo(1, 12);
  });

  it('重复惩罚：正 logit 除以惩罚，负 logit 乘以惩罚；presence / frequency 按次数减', () => {
    const out = applyPenalties([2, -1, 0.5], [0, 1, 1], { repetitionPenalty: 2, presencePenalty: 0.1, frequencyPenalty: 0.2 });
    expect(out[0]).toBeCloseTo(2 / 2 - 0.1 - 0.2, 12);
    expect(out[1]).toBeCloseTo(-1 * 2 - 0.1 - 0.4, 12);
    expect(out[2]).toBe(0.5);
  });

  it('同一个种子抽到同一个 token；抽很多次，频率接近概率', () => {
    expect(sample(logits, [], {}, mulberry32(9)).chosen).toBe(sample(logits, [], {}, mulberry32(9)).chosen);
    const rand = mulberry32(2024);
    const counts = new Array(logits.length).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) counts[sample(logits, [], {}, rand).chosen]++;
    const probs = softmax(logits, (x) => x);
    counts.forEach((count, id) => expect(Math.abs(count / n - probs[id])).toBeLessThan(0.012));
  });

  it('约束掩码：只允许能继续写成候选之一的 token，完整时才允许结束符', () => {
    const { isPrefix, isComplete } = choiceConstraint(['yes', 'no']);
    const allowed = prefixMask(TOKENIZER, [], isPrefix, isComplete);
    expect(allowed[TOKENIZER.eos]).toBe(false);
    expect(allowed['y'.charCodeAt(0)]).toBe(true);
    expect(allowed['x'.charCodeAt(0)]).toBe(false);
    const done = prefixMask(TOKENIZER, utf8Encode('no'), isPrefix, isComplete);
    expect(done[TOKENIZER.eos]).toBe(true);
    expect(done.filter(Boolean).length).toBe(1);
    const trace = sample(lastLogits(forward(MODEL, TOKENIZER.encode('the'))), [], { allowed }, mulberry32(3));
    expect(['y', 'n']).toContain(TOKENIZER.decode([trace.chosen])[0]);
    expect(() => sample([1, 2], [], { allowed: [false, false] })).toThrow();
  });
});

describe('数值格式', () => {
  const inputs = quantVectors.inputs;

  it('fp32：IEEE 754 的已知位模式，小端', () => {
    expect(f32Bytes(1)).toEqual([0x00, 0x00, 0x80, 0x3f]);
    expect(f32Bytes(-2)).toEqual([0x00, 0x00, 0x00, 0xc0]);
    expect(i32Bytes(261)).toEqual([0x05, 0x01, 0, 0]);
  });

  it('fp16：边界值和 numpy 一致（溢出、次正规数、平局取偶）', () => {
    expect(quantVectors.specials.map(f16Bits)).toEqual(quantVectors.f16_specials);
    expect(f16FromBits(0x3c00)).toBe(1);
    expect(f16FromBits(0x7bff)).toBe(65504);
    expect(f16FromBits(0x0001)).toBe(2 ** -24);
    expect(f16Bits(-0)).toBe(0x8000);
    expect(bf16Bits(-0)).toBe(0x8000);
  });

  it('bf16：边界值和 gguf-py 一致', () => {
    expect(quantVectors.specials.map(bf16Bits)).toEqual(quantVectors.bf16_specials);
  });

  it('整组编码和 numpy / gguf-py 逐字节相同', () => {
    expect(toHex(encodeAs('f16', inputs))).toBe(quantVectors.f16);
    expect(toHex(encodeAs('bf16', inputs))).toBe(quantVectors.bf16);
    expect(toHex(encodeAs('q8_0', inputs))).toBe(quantVectors.q8_0);
    expect(toHex(encodeAs('q4_0', inputs))).toBe(quantVectors.q4_0);
  });

  it('反量化和 gguf-py 一致', () => {
    // JSON 导入会把 -0 变成 0，比较前把两边的 -0 都规整成 +0（x + 0）。
    const plain = (values: number[]) => values.map((value) => value + 0);
    expect(plain(dequantizeQ8_0(quantizeQ8_0(inputs)))).toEqual(plain(quantVectors.q8_0_dequant));
    expect(plain(dequantizeQ4_0(quantizeQ4_0(inputs)))).toEqual(plain(quantVectors.q4_0_dequant));
  });

  it('块大小：Q8_0 34 字节，Q4_0 18 字节，每 32 个权重', () => {
    const [q8] = quantizeQ8_0(inputs.slice(0, 32));
    const [q4] = quantizeQ4_0(inputs.slice(0, 32));
    expect(q8_0Bytes(q8)).toHaveLength(34);
    expect(q4_0Bytes(q4)).toHaveLength(18);
    expect(BYTES_PER_WEIGHT.q4_0 * 32).toBe(18);
    expect(() => quantizeQ4_0([1, 2, 3])).toThrow();
  });
});

describe('图像 patch', () => {
  it('示例图 8×8 RGB，切成 4 个 4×4 的 patch，拼回去等于原图', () => {
    expect(SAMPLE_IMAGE.data).toHaveLength(8 * 8 * 3);
    const patches = patchify(SAMPLE_IMAGE, 4);
    expect(patches).toHaveLength(numPatches(VISION.config));
    for (const patch of patches) {
      expect(patch.bytes).toHaveLength(48);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const at = ((patch.row * 4 + y) * 8 + patch.col * 4 + x) * 3;
          expect(patch.bytes.slice((y * 4 + x) * 3, (y * 4 + x) * 3 + 3)).toEqual(SAMPLE_IMAGE.data.slice(at, at + 3));
        }
      }
      patch.values.forEach((value) => expect(Math.abs(value)).toBeLessThanOrEqual(1));
    }
  });

  it('投影成 d_model 维向量，FLOPs = patch 数 × 2 × d × 48', () => {
    const trace = patchEmbed(VISION, SAMPLE_IMAGE);
    expect(trace.vectors).toHaveLength(4);
    trace.vectors.forEach((vec) => expect(vec).toHaveLength(MODEL.config.dModel));
    expect(trace.meter.total).toBe(4 * 2 * 8 * 48);
  });

  it('图像向量插进文本序列，同一个 Transformer 能处理', () => {
    const text = embedTokens(MODEL, TOKENIZER.encode('the model reads'));
    const inputs = spliceImage(text, 1, imageInputs(patchEmbed(VISION, SAMPLE_IMAGE)));
    const trace = forwardEmbeds(MODEL, inputs);
    expect(trace.positions.map((p) => p.token).filter((token) => token === NO_TOKEN)).toHaveLength(4);
    expect(trace.positions[1].token).toBe(NO_TOKEN);
    lastLogits(trace).forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });

  it('PPM 文件：P6 头加原始像素', () => {
    const bytes = ppmBytes(SAMPLE_IMAGE);
    expect(String.fromCharCode(...bytes.slice(0, 11))).toBe('P6\n8 8\n255\n');
    expect(bytes).toHaveLength(11 + 192);
  });
});
