/**
 * 迷你 decoder-only Transformer，结构和 LLaMA 一致，只是尺寸小到能逐个数字展示：
 * 词表 = 分词器词表，d_model = 8，2 个头（每头 4 维），2 层，SwiGLU 前馈隐层 16，
 * RMSNorm（pre-norm），RoPE（相邻两维一组旋转，和 Meta 原版 LLaMA、llama.cpp 的 LLAMA 一致），因果注意力。
 *
 * 张量名沿用 GGUF 的命名（token_embd、blk.N.attn_q……），量化课可以直接对应到真实文件。
 *
 * forward 一次处理一段连续位置，并把每层的 K、V 追加到 KVCache：
 * - 不带 cache 的完整前向 = 从空 cache 开始处理整个序列；
 * - 预填充（prefill）= 同一个函数处理整段提示词；
 * - 增量解码 = 每次只处理 1 个新 token，attention 读 cache 里之前的 K、V。
 * 三者对每个 (位置, 被看的位置) 做的运算完全相同，所以结果逐位一致（tests/model.test.ts 核对）。
 */
import { gaussian, mulberry32 } from './prng';
import { add, argmax, FP32, FP64, FlopMeter, matvec, mul, rmsnorm, silu, softmax, zerosMat, type Mat, type Round, type Vec } from './tensor';

export interface ModelConfig {
  /** 词表大小，等于分词器的 size。 */
  vocab: number;
  dModel: number;
  nHeads: number;
  /** 每个头的维数，dModel / nHeads。 */
  headDim: number;
  nLayers: number;
  /** SwiGLU 前馈网络的隐层宽度。 */
  dFF: number;
  /** 上下文窗口：最多能放多少个位置。KV cache 满了就不能再生成。 */
  maxSeq: number;
  /** RoPE 的底数 θ，LLaMA 用 10000。 */
  ropeBase: number;
  /** RMSNorm 的 ε。 */
  eps: number;
}

export interface LayerWeights {
  attn_norm: Vec;
  attn_q: Mat;
  attn_k: Mat;
  attn_v: Mat;
  attn_output: Mat;
  ffn_norm: Vec;
  /** SwiGLU 的门控分支，dFF × dModel。 */
  ffn_gate: Mat;
  /** SwiGLU 的线性分支，dFF × dModel。 */
  ffn_up: Mat;
  /** 降回 dModel，dModel × dFF。 */
  ffn_down: Mat;
}

export interface Weights {
  config: ModelConfig;
  /** 嵌入表，vocab × dModel，第 i 行就是 token i 的向量。 */
  token_embd: Mat;
  layers: LayerWeights[];
  output_norm: Vec;
  /** 输出层（LM head），vocab × dModel。 */
  output: Mat;
}

export const LAYER_TENSORS = ['attn_norm', 'attn_q', 'attn_k', 'attn_v', 'attn_output', 'ffn_norm', 'ffn_gate', 'ffn_up', 'ffn_down'] as const;

export function makeConfig(vocab: number): ModelConfig {
  return { vocab, dModel: 8, nHeads: 2, headDim: 4, nLayers: 2, dFF: 16, maxSeq: 32, ropeBase: 10000, eps: 1e-5 };
}

/** 固定种子的初始化：矩阵 ~ N(0, 1/fan_in)，norm 的 γ 全是 1。所有值按 fp32 舍入。 */
export function initWeights(config: ModelConfig, seed = 20240601): Weights {
  const normal = gaussian(mulberry32(seed));
  const mat = (rows: number, cols: number, scale = 1 / Math.sqrt(cols)): Mat => Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.fround(normal() * scale)));
  const ones = (n: number) => new Array<number>(n).fill(1);
  const { vocab, dModel: d, dFF, nLayers } = config;
  return {
    config,
    token_embd: mat(vocab, d, 1),
    layers: Array.from({ length: nLayers }, () => ({
      attn_norm: ones(d),
      attn_q: mat(d, d),
      attn_k: mat(d, d),
      attn_v: mat(d, d),
      attn_output: mat(d, d),
      ffn_norm: ones(d),
      ffn_gate: mat(dFF, d),
      ffn_up: mat(dFF, d),
      ffn_down: mat(d, dFF),
    })),
    output_norm: ones(d),
    output: mat(vocab, d),
  };
}

/** 一个张量的 GGUF 名字、形状（按 GGUF 的习惯，最内维在前）和按行展开的值。 */
export interface NamedTensor {
  name: string;
  /** [列数, 行数]，向量是 [长度]。和 GGUF 的 ne[] 一致。 */
  shape: number[];
  data: number[];
}

/** 全部张量，按 llama.cpp 写 GGUF 的顺序。 */
export function tensorsOf(weights: Weights): NamedTensor[] {
  const flat = (value: Vec | Mat): NamedTensor['data'] => (Array.isArray(value[0]) ? (value as Mat).flat() : (value as Vec));
  const shape = (value: Vec | Mat) => (Array.isArray(value[0]) ? [(value as Mat)[0].length, value.length] : [value.length]);
  const out: NamedTensor[] = [{ name: 'token_embd.weight', shape: shape(weights.token_embd), data: flat(weights.token_embd) }];
  weights.layers.forEach((layer, index) => {
    for (const key of LAYER_TENSORS) out.push({ name: `blk.${index}.${key}.weight`, shape: shape(layer[key]), data: flat(layer[key]) });
  });
  out.push({ name: 'output_norm.weight', shape: shape(weights.output_norm), data: flat(weights.output_norm) });
  out.push({ name: 'output.weight', shape: shape(weights.output), data: flat(weights.output) });
  return out;
}

/** 参数总数。 */
export const paramCount = (weights: Weights): number => tensorsOf(weights).reduce((sum, tensor) => sum + tensor.data.length, 0);

// ---------- RoPE ----------

/** 第 i 组（两维）的旋转频率 θ^(−2i/headDim)。 */
export const ropeFreq = (config: ModelConfig, pair: number): number => config.ropeBase ** ((-2 * pair) / config.headDim);

/** 把向量按头切开，每头里第 (2i, 2i+1) 两维按 pos·freq(i) 旋转。 */
export function rope(x: Vec, pos: number, config: ModelConfig, round: Round = FP32, inverse = false): Vec {
  const out = x.slice();
  for (let h = 0; h < config.nHeads; h++) {
    for (let i = 0; i < config.headDim / 2; i++) {
      const angle = (inverse ? -pos : pos) * ropeFreq(config, i);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const a = h * config.headDim + 2 * i;
      out[a] = round(x[a] * cos - x[a + 1] * sin);
      out[a + 1] = round(x[a] * sin + x[a + 1] * cos);
    }
  }
  return out;
}

// ---------- KV cache ----------

/** 每层每个位置的 K（已经过 RoPE）和 V，形状 [层][位置][dModel]。 */
export class KVCache {
  k: Vec[][];
  v: Vec[][];

  constructor(readonly config: ModelConfig) {
    this.k = Array.from({ length: config.nLayers }, () => []);
    this.v = Array.from({ length: config.nLayers }, () => []);
  }

  /** 已经缓存了多少个位置。 */
  get length(): number {
    return this.k[0].length;
  }

  /** 还能放多少个位置。 */
  get free(): number {
    return this.config.maxSeq - this.length;
  }

  clone(): KVCache {
    const copy = new KVCache(this.config);
    copy.k = this.k.map((layer) => layer.map((row) => row.slice()));
    copy.v = this.v.map((layer) => layer.map((row) => row.slice()));
    return copy;
  }

  /** 只保留前 n 个位置。前缀缓存复用一段公共前缀时用。 */
  truncate(n: number): void {
    this.k = this.k.map((layer) => layer.slice(0, n));
    this.v = this.v.map((layer) => layer.slice(0, n));
  }

  /** 每个位置占多少个数：2（K 和 V）× 层数 × dModel。乘上每个数的字节数就是显存账。 */
  static valuesPerToken(config: ModelConfig): number {
    return 2 * config.nLayers * config.dModel;
  }
}

// ---------- 前向 ----------

/** 一个头在一个位置上的注意力。 */
export interface HeadTrace {
  /** 缩放后的分数 q·k / √headDim，下标是被看的位置 0..pos；之后的位置被因果掩码挡住，不在这里。 */
  scores: Vec;
  /** softmax 之后的权重，和为 1。 */
  probs: Vec;
}

/** 一层在一个位置上的全部中间张量。 */
export interface LayerStep {
  /** 进入这一层的残差流。 */
  input: Vec;
  attnRms: number;
  /** RMSNorm(input) ⊙ γ。 */
  attnNormed: Vec;
  /** 投影之后、RoPE 之前。 */
  q: Vec;
  k: Vec;
  v: Vec;
  /** RoPE 之后。kRope 和 v 会写进 KV cache。 */
  qRope: Vec;
  kRope: Vec;
  heads: HeadTrace[];
  /** 各头的加权和拼起来，dModel 维。 */
  mixed: Vec;
  /** attn_output · mixed。 */
  attnOut: Vec;
  /** input + attnOut。 */
  resid: Vec;
  ffnRms: number;
  ffnNormed: Vec;
  gate: Vec;
  up: Vec;
  /** silu(gate) ⊙ up。 */
  act: Vec;
  ffnOut: Vec;
  /** resid + ffnOut，也是下一层的 input。 */
  output: Vec;
}

/** 一个位置从嵌入到 logits 的全过程。 */
export interface PositionTrace {
  pos: number;
  /** 这个位置的 token id；图像 patch 等非文本输入是 NO_TOKEN（−1）。 */
  token: number;
  /** 查表得到的嵌入向量。 */
  embed: Vec;
  layers: LayerStep[];
  finalRms: number;
  finalNormed: Vec;
  /** 每个词表项的分数，vocab 维。 */
  logits: Vec;
}

export interface ForwardTrace {
  /** 这次处理的第一个位置。 */
  start: number;
  positions: PositionTrace[];
  /** 这次前向花的 FLOPs，按类。 */
  meter: FlopMeter;
}

export interface ForwardOptions {
  /** 传入就在它上面继续（增量解码），并把新位置的 K、V 追加进去。默认用一个空 cache。 */
  cache?: KVCache;
  /** 累加 FLOPs 的计数器，可以跨多次调用共用。默认每次新建。 */
  meter?: FlopMeter;
  /** 用 float64 计算、不做 fp32 舍入。训练和梯度检查用。 */
  fp64?: boolean;
  /** 除了最后一个位置，其他位置不算 logits（预填充时真实引擎就是这样省掉 LM head 的）。 */
  lastLogitsOnly?: boolean;
}

/** 不是文本 token 的输入位置（比如图像 patch）在 PositionTrace.token 里记成它。 */
export const NO_TOKEN = -1;

/** 一个输入位置：文本 token 查表得到 embed；图像 patch 由 vision.ts 投影得到 embed，token 是 NO_TOKEN。 */
export interface InputVector {
  token: number;
  embed: Vec;
}

/** 文本 token 查嵌入表。 */
export function embedTokens(weights: Weights, tokens: readonly number[]): InputVector[] {
  return tokens.map((token) => {
    const row = weights.token_embd[token];
    if (!row) throw new Error(`token ${token} 不在词表里`);
    return { token, embed: row.slice() };
  });
}

/** 前向：处理 tokens，位置从 cache.length 开始。 */
export function forward(weights: Weights, tokens: readonly number[], options: ForwardOptions = {}): ForwardTrace {
  return forwardEmbeds(weights, embedTokens(weights, tokens), options);
}

/**
 * 前向的通用形式：输入是已经得到的向量序列，可以是文本嵌入和图像 patch 向量混排（多模态）。
 * forward 就是先查嵌入表再调它。
 */
export function forwardEmbeds(weights: Weights, inputs: readonly InputVector[], options: ForwardOptions = {}): ForwardTrace {
  const { config } = weights;
  const cache = options.cache ?? new KVCache(config);
  const meter = options.meter ?? new FlopMeter();
  const round = options.fp64 ? FP64 : FP32;
  const start = cache.length;
  if (start + inputs.length > config.maxSeq) throw new Error(`超出上下文窗口：${start} + ${inputs.length} > ${config.maxSeq}`);
  const { headDim, nHeads, eps } = config;
  const scale = 1 / Math.sqrt(headDim);

  const positions: PositionTrace[] = inputs.map((input, i) => {
    if (input.embed.length !== config.dModel) throw new Error(`第 ${i} 个输入是 ${input.embed.length} 维，模型要 ${config.dModel} 维`);
    return { pos: start + i, token: input.token, embed: input.embed.map(round), layers: [], finalRms: 0, finalNormed: [], logits: [] };
  });
  let xs = positions.map((p) => p.embed);

  weights.layers.forEach((layer, l) => {
    // 先把这一段所有位置的 Q、K、V 算出来，K、V 依次追加进 cache。
    const steps = xs.map((x, i): LayerStep => {
      const { y: attnNormed, rms: attnRms } = rmsnorm(x, layer.attn_norm, eps, round);
      const q = matvec(layer.attn_q, attnNormed, round, meter, 'qkv');
      const k = matvec(layer.attn_k, attnNormed, round, meter, 'qkv');
      const v = matvec(layer.attn_v, attnNormed, round, meter, 'qkv');
      const pos = start + i;
      const qRope = rope(q, pos, config, round);
      const kRope = rope(k, pos, config, round);
      cache.k[l].push(kRope);
      cache.v[l].push(v);
      return { input: x, attnRms, attnNormed, q, k, v, qRope, kRope } as LayerStep;
    });
    // 再逐个位置做因果注意力：位置 pos 只看 cache 里 0..pos。
    xs = steps.map((step, i) => {
      const pos = start + i;
      const mixed = new Array<number>(config.dModel).fill(0);
      step.heads = [];
      for (let h = 0; h < nHeads; h++) {
        const off = h * headDim;
        const scores: Vec = [];
        for (let s = 0; s <= pos; s++) {
          let sum = 0;
          for (let j = 0; j < headDim; j++) sum += step.qRope[off + j] * cache.k[l][s][off + j];
          scores.push(round(sum * scale));
        }
        meter.add('score', 2 * headDim * (pos + 1));
        const probs = softmax(scores, round);
        for (let j = 0; j < headDim; j++) {
          let sum = 0;
          for (let s = 0; s <= pos; s++) sum += probs[s] * cache.v[l][s][off + j];
          mixed[off + j] = round(sum);
        }
        meter.add('mix', 2 * headDim * (pos + 1));
        step.heads.push({ scores, probs });
      }
      step.mixed = mixed;
      step.attnOut = matvec(layer.attn_output, mixed, round, meter, 'wo');
      step.resid = add(step.input, step.attnOut, round);
      const ffn = rmsnorm(step.resid, layer.ffn_norm, eps, round);
      step.ffnRms = ffn.rms;
      step.ffnNormed = ffn.y;
      step.gate = matvec(layer.ffn_gate, ffn.y, round, meter, 'ffn');
      step.up = matvec(layer.ffn_up, ffn.y, round, meter, 'ffn');
      step.act = mul(step.gate.map((z) => round(silu(z))), step.up, round);
      step.ffnOut = matvec(layer.ffn_down, step.act, round, meter, 'ffn');
      step.output = add(step.resid, step.ffnOut, round);
      positions[i].layers.push(step);
      return step.output;
    });
  });

  positions.forEach((p, i) => {
    const final = rmsnorm(xs[i], weights.output_norm, eps, round);
    p.finalRms = final.rms;
    p.finalNormed = final.y;
    if (!options.lastLogitsOnly || i === positions.length - 1) p.logits = matvec(weights.output, final.y, round, meter, 'lmhead');
  });
  return { start, positions, meter };
}

/** 增量解码一步：只处理一个新 token，读写同一个 cache。 */
export function decodeStep(weights: Weights, cache: KVCache, token: number, meter?: FlopMeter): PositionTrace {
  return forward(weights, [token], { cache, meter }).positions[0];
}

/** 最后一个位置的 logits。 */
export const lastLogits = (trace: ForwardTrace): Vec => trace.positions[trace.positions.length - 1].logits;

export interface GenerateStep {
  /** 这一步输入的 token（第一步是提示词的最后一个）。 */
  input: number;
  /** 这一步选出的 token。 */
  token: number;
  logits: Vec;
  /** 到这一步为止累计的 FLOPs。 */
  flops: number;
  /** 这一步之后 cache 里有多少个位置（不用 cache 时是这一步重算的位置数）。 */
  positions: number;
}

export interface GenerateOptions {
  /** 最多生成多少个 token。 */
  maxTokens: number;
  /** 从 logits 里选下一个 token，默认贪心（取最大）。 */
  pick?: (logits: Vec, step: number, sofar: number[]) => number;
  /** 不用 KV cache：每一步把整个序列从头算一遍。结果相同，FLOPs 多得多。 */
  noCache?: boolean;
  /** 遇到这个 token 就停（不含在输出里），通常是分词器的 eos。 */
  stop?: number;
  meter?: FlopMeter;
}

/** 自回归生成：预填充提示词，然后一次一个 token。 */
export function generate(weights: Weights, prompt: readonly number[], options: GenerateOptions): { tokens: number[]; steps: GenerateStep[]; cache: KVCache; meter: FlopMeter } {
  const meter = options.meter ?? new FlopMeter();
  const pick = options.pick ?? ((logits: Vec) => argmax(logits));
  const cache = new KVCache(weights.config);
  const out: number[] = [];
  const steps: GenerateStep[] = [];
  let logits = options.noCache ? lastLogits(forward(weights, prompt, { meter, lastLogitsOnly: true })) : lastLogits(forward(weights, prompt, { cache, meter, lastLogitsOnly: true }));
  let input = prompt[prompt.length - 1];
  for (let step = 0; step < options.maxTokens; step++) {
    const token = pick(logits, step, out);
    steps.push({ input, token, logits, flops: meter.total, positions: options.noCache ? prompt.length + out.length : cache.length });
    if (token === options.stop) break;
    out.push(token);
    if (prompt.length + out.length >= weights.config.maxSeq || step === options.maxTokens - 1) break;
    input = token;
    logits = options.noCache ? lastLogits(forward(weights, [...prompt, ...out], { meter, lastLogitsOnly: true })) : decodeStep(weights, cache, token, meter).logits;
  }
  return { tokens: out, steps, cache, meter };
}

/** 交叉熵：−log softmax(logits)[target]，单位是 nat。 */
export function crossEntropy(logits: Vec, target: number): number {
  let max = -Infinity;
  for (const value of logits) if (value > max) max = value;
  let sum = 0;
  for (const value of logits) sum += Math.exp(value - max);
  return Math.log(sum) + max - logits[target];
}

/** 整段序列的平均交叉熵：位置 t 预测 targets[t]。 */
export function sequenceLoss(trace: ForwardTrace, targets: readonly number[]): number {
  let sum = 0;
  trace.positions.forEach((p, t) => (sum += crossEntropy(p.logits, targets[t])));
  return sum / trace.positions.length;
}

export const emptyGrads = (weights: Weights): Weights => ({
  config: weights.config,
  token_embd: zerosMat(weights.token_embd.length, weights.config.dModel),
  layers: weights.layers.map((layer) => Object.fromEntries(LAYER_TENSORS.map((key) => [key, Array.isArray(layer[key][0]) ? zerosMat((layer[key] as Mat).length, (layer[key] as Mat)[0].length) : new Array<number>((layer[key] as Vec).length).fill(0)])) as unknown as LayerWeights),
  output_norm: new Array<number>(weights.config.dModel).fill(0),
  output: zerosMat(weights.output.length, weights.config.dModel),
});
