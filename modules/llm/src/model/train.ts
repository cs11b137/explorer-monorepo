/**
 * 反向传播和优化器。迷你模型的权重由 scripts/train.ts 用这里的代码在内置语料上预训练；
 * LoRA 课也用这里的梯度做「训练一步」。
 *
 * backward 手写了每个算子的导数，tests/model.test.ts 用有限差分逐个参数核对。
 */
import { CORPUS } from '@explorer/llm-core/corpus';
import { addOuter, matTvec, sigmoid, siluGrad, type Mat, type Vec } from './tensor';
import { type BpeTokenizer } from '@explorer/llm-core/tokenizer';
import { emptyGrads, forward, initWeights, LAYER_TENSORS, makeConfig, rope, sequenceLoss, type ForwardTrace, type LayerWeights, type Weights } from './transformer';

/** RMSNorm 的反向：dx = (dx̂ − x̂ · mean(dx̂ ⊙ x̂)) / rms，其中 x̂ = x / rms，dx̂ = dy ⊙ γ。同时累加 dγ。 */
function rmsnormBack(x: Vec, rms: number, gamma: Vec, dy: Vec, dGamma: Vec): Vec {
  const n = x.length;
  const xhat = x.map((value) => value / rms);
  const dxhat = dy.map((value, i) => value * gamma[i]);
  let dotSum = 0;
  for (let i = 0; i < n; i++) {
    dGamma[i] += dy[i] * xhat[i];
    dotSum += dxhat[i] * xhat[i];
  }
  const mean = dotSum / n;
  return dxhat.map((value, i) => (value - xhat[i] * mean) / rms);
}

const addInto = (target: Vec, source: Vec) => {
  for (let i = 0; i < target.length; i++) target[i] += source[i];
};

/**
 * 反向传播：给定从位置 0 开始的完整前向（建议用 fp64 跑）和每个位置的目标 token，
 * 返回平均交叉熵对每个参数的梯度，结构和 Weights 相同。
 */
export function backward(weights: Weights, trace: ForwardTrace, targets: readonly number[]): Weights {
  if (trace.start !== 0) throw new Error('backward 需要从位置 0 开始的完整前向');
  const { config } = weights;
  const { headDim, nHeads } = config;
  const T = trace.positions.length;
  const scale = 1 / Math.sqrt(headDim);
  const grads = emptyGrads(weights);

  // 输出层：d logits = (softmax − onehot) / T。
  let dx: Vec[] = trace.positions.map((p, t) => {
    let max = -Infinity;
    for (const value of p.logits) if (value > max) max = value;
    const exps = p.logits.map((value) => Math.exp(value - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const dLogits = exps.map((value) => value / sum / T);
    dLogits[targets[t]] -= 1 / T;
    addOuter(grads.output, dLogits, p.finalNormed);
    const dNormed = matTvec(weights.output, dLogits);
    return rmsnormBack(p.layers[config.nLayers - 1].output, p.finalRms, weights.output_norm, dNormed, grads.output_norm);
  });

  for (let l = config.nLayers - 1; l >= 0; l--) {
    const layer = weights.layers[l];
    const g = grads.layers[l];
    const steps = trace.positions.map((p) => p.layers[l]);
    // 前馈网络：output = resid + down(silu(gate) ⊙ up)。
    const dResid = steps.map((step, t) => {
      const dOut = dx[t];
      addOuter(g.ffn_down, dOut, step.act);
      const dAct = matTvec(layer.ffn_down, dOut);
      const dGate = dAct.map((value, i) => value * step.up[i] * siluGrad(step.gate[i]));
      const dUp = dAct.map((value, i) => value * step.gate[i] * sigmoid(step.gate[i]));
      addOuter(g.ffn_gate, dGate, step.ffnNormed);
      addOuter(g.ffn_up, dUp, step.ffnNormed);
      const dNormed = matTvec(layer.ffn_gate, dGate);
      addInto(dNormed, matTvec(layer.ffn_up, dUp));
      const back = rmsnormBack(step.resid, step.ffnRms, layer.ffn_norm, dNormed, g.ffn_norm);
      addInto(back, dOut);
      return back;
    });
    // 注意力：resid = input + Wo · mixed。
    const dQr = steps.map(() => new Array<number>(config.dModel).fill(0));
    const dKr = steps.map(() => new Array<number>(config.dModel).fill(0));
    const dV = steps.map(() => new Array<number>(config.dModel).fill(0));
    steps.forEach((step, t) => {
      addOuter(g.attn_output, dResid[t], step.mixed);
      const dMixed = matTvec(layer.attn_output, dResid[t]);
      for (let h = 0; h < nHeads; h++) {
        const off = h * headDim;
        const { probs } = step.heads[h];
        const dProbs = probs.map((_, s) => {
          let sum = 0;
          for (let j = 0; j < headDim; j++) sum += dMixed[off + j] * steps[s].v[off + j];
          return sum;
        });
        probs.forEach((p, s) => {
          for (let j = 0; j < headDim; j++) dV[s][off + j] += p * dMixed[off + j];
        });
        let weighted = 0;
        probs.forEach((p, s) => (weighted += p * dProbs[s]));
        probs.forEach((p, s) => {
          const dScore = p * (dProbs[s] - weighted) * scale;
          for (let j = 0; j < headDim; j++) {
            dQr[t][off + j] += dScore * steps[s].kRope[off + j];
            dKr[s][off + j] += dScore * step.qRope[off + j];
          }
        });
      }
    });
    dx = steps.map((step, t) => {
      // RoPE 是旋转，反向就是转回去。
      const dQ = rope(dQr[t], t, config, (value) => value, true);
      const dK = rope(dKr[t], t, config, (value) => value, true);
      addOuter(g.attn_q, dQ, step.attnNormed);
      addOuter(g.attn_k, dK, step.attnNormed);
      addOuter(g.attn_v, dV[t], step.attnNormed);
      const dNormed = matTvec(layer.attn_q, dQ);
      addInto(dNormed, matTvec(layer.attn_k, dK));
      addInto(dNormed, matTvec(layer.attn_v, dV[t]));
      const back = rmsnormBack(step.input, step.attnRms, layer.attn_norm, dNormed, g.attn_norm);
      addInto(back, dResid[t]);
      return back;
    });
  }

  trace.positions.forEach((p, t) => {
    if (p.token >= 0) addInto(grads.token_embd[p.token], dx[t]);
  });
  return grads;
}

// ---------- 参数遍历 ----------

/** 按固定顺序访问每个参数张量（向量或矩阵）。优化器和梯度检查用。 */
export function eachTensor(weights: Weights, visit: (name: string, value: Vec | Mat) => void): void {
  visit('token_embd', weights.token_embd);
  weights.layers.forEach((layer, l) => LAYER_TENSORS.forEach((key) => visit(`blk.${l}.${key}`, layer[key])));
  visit('output_norm', weights.output_norm);
  visit('output', weights.output);
}

/** 把所有参数展开成一组「行」：向量是一行，矩阵是多行。优化器逐行更新。 */
function rowsOf(weights: Weights): Vec[] {
  const rows: Vec[] = [];
  eachTensor(weights, (_name, value) => {
    if (Array.isArray(value[0])) rows.push(...(value as Mat));
    else rows.push(value as Vec);
  });
  return rows;
}

export function cloneWeights(weights: Weights): Weights {
  const copy = (value: Vec | Mat) => (Array.isArray(value[0]) ? (value as Mat).map((row) => row.slice()) : (value as Vec).slice());
  return {
    config: { ...weights.config },
    token_embd: copy(weights.token_embd) as Mat,
    layers: weights.layers.map((layer) => Object.fromEntries(LAYER_TENSORS.map((key) => [key, copy(layer[key])])) as unknown as LayerWeights),
    output_norm: copy(weights.output_norm) as Vec,
    output: copy(weights.output) as Mat,
  };
}

/** 一步 SGD：w ← w − lr · g。LoRA 课「训练一步」用最朴素的形式。 */
export function sgdStep(weights: Weights, grads: Weights, lr: number): void {
  const w = rowsOf(weights);
  const g = rowsOf(grads);
  w.forEach((row, r) => row.forEach((_, i) => (row[i] -= lr * g[r][i])));
}

/** Adam（Kingma & Ba 2014），带偏差修正。预训练用。 */
export class Adam {
  private m: Vec[];
  private v: Vec[];
  private t = 0;

  constructor(weights: Weights, readonly lr = 0.01, readonly beta1 = 0.9, readonly beta2 = 0.999, readonly eps = 1e-8) {
    this.m = rowsOf(weights).map((row) => row.map(() => 0));
    this.v = rowsOf(weights).map((row) => row.map(() => 0));
  }

  step(weights: Weights, grads: Weights, lr = this.lr): void {
    this.t++;
    const w = rowsOf(weights);
    const g = rowsOf(grads);
    const c1 = 1 - this.beta1 ** this.t;
    const c2 = 1 - this.beta2 ** this.t;
    w.forEach((row, r) => {
      const m = this.m[r];
      const v = this.v[r];
      const gr = g[r];
      for (let i = 0; i < row.length; i++) {
        m[i] = this.beta1 * m[i] + (1 - this.beta1) * gr[i];
        v[i] = this.beta2 * v[i] + (1 - this.beta2) * gr[i] * gr[i];
        row[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + this.eps);
      }
    });
  }
}

// ---------- LoRA ----------

/**
 * LoRA 的梯度：W' = W + s · B·A（B 是 out × r，A 是 r × in，s = α / r）。
 * W' 对 B·A 是线性的，所以由整矩阵的梯度 dW 就能精确得到 dA = s · Bᵀ·dW，dB = s · dW·Aᵀ。
 */
export function loraGrads(dW: Mat, A: Mat, B: Mat, s: number): { dA: Mat; dB: Mat } {
  const r = A.length;
  const dA = A.map((row, k) => row.map((_, j) => s * dW.reduce((sum, dRow, i) => sum + B[i][k] * dRow[j], 0)));
  const dB = B.map((_, i) => Array.from({ length: r }, (__, k) => s * dW[i].reduce((sum, value, j) => sum + value * A[k][j], 0)));
  return { dA, dB };
}

/** W + s · B·A，按 fp32 舍入。 */
export function loraMerge(W: Mat, A: Mat, B: Mat, s: number): Mat {
  return W.map((row, i) => row.map((value, j) => Math.fround(value + s * B[i].reduce((sum, b, k) => sum + b * A[k][j], 0))));
}

// ---------- 预训练 ----------

/** 训练数据：每篇文档编码后接一个结束符，整个语料首尾相连成一条 token 流。 */
export function corpusStream(tokenizer: BpeTokenizer, corpus: readonly string[] = CORPUS): number[] {
  return corpus.flatMap((doc) => [...tokenizer.encode(doc), tokenizer.eos]);
}

export interface TrainLog {
  step: number;
  loss: number;
}

/**
 * 在 token 流上训练：每步取一个长度为 maxSeq 的窗口（起点按步数轮转，确定），预测下一个 token。
 * 学习率前 10% 线性预热，之后余弦衰减到 10%。
 */
export function pretrain(weights: Weights, stream: readonly number[], steps: number, lr = 0.02, onLog?: (log: TrainLog) => void): TrainLog[] {
  const { maxSeq } = weights.config;
  const adam = new Adam(weights, lr);
  const logs: TrainLog[] = [];
  const windows = stream.length - maxSeq - 1;
  for (let step = 0; step < steps; step++) {
    // 黄金比例步长，让窗口起点均匀铺满整个语料。
    const at = Math.floor(((step * 0.6180339887498949) % 1) * windows);
    const input = stream.slice(at, at + maxSeq);
    const targets = stream.slice(at + 1, at + maxSeq + 1);
    const trace = forward(weights, input, { fp64: true });
    const grads = backward(weights, trace, targets);
    const warm = Math.max(1, Math.floor(steps * 0.1));
    const rate = step < warm ? (lr * (step + 1)) / warm : lr * (0.1 + 0.9 * 0.5 * (1 + Math.cos((Math.PI * (step - warm)) / (steps - warm))));
    adam.step(weights, grads, rate);
    if (step % 50 === 0 || step === steps - 1) {
      const log = { step, loss: sequenceLoss(trace, targets) };
      logs.push(log);
      onLog?.(log);
    }
  }
  return logs;
}

/** 预训练的配方。改了要重新运行 npm run train -w llm-explorer。 */
export const PRETRAIN = { seed: 20240601, steps: 3000, lr: 0.02 } as const;

/** 从固定种子开始按 PRETRAIN 训练。确定：同样的代码和语料总是得到逐位相同的权重。 */
export function trainFromScratch(tokenizer: BpeTokenizer, onLog?: (log: TrainLog) => void): { weights: Weights; logs: TrainLog[] } {
  const weights = initWeights(makeConfig(tokenizer.size), PRETRAIN.seed);
  const logs = pretrain(weights, corpusStream(tokenizer), PRETRAIN.steps, PRETRAIN.lr, onLog);
  // 训练在 float64 里做，保存前按 fp32 舍入，推理用的就是这些 fp32 值。
  eachTensor(weights, (_name, value) => {
    const rows = Array.isArray(value[0]) ? (value as Mat) : [value as Vec];
    for (const row of rows) for (let i = 0; i < row.length; i++) row[i] = Math.fround(row[i]);
  });
  return { weights, logs };
}
