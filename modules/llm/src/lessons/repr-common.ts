/**
 * 表示组（embed、attention、block、vision）共用的输入和工具。
 *
 * 三节课沿用同一句提示词和同一次前向，前一课算出的向量就是后一课的输入。
 * replayLayer 只用 model/ 的原语把一层重新算一遍，并在每一站记下累计 FLOPs，
 * 课程的轨迹表按站显示运算量；tests/narrative.repr.test.ts 核对它和 forward 的结果逐位相同。
 */
import { add, dot, forward, FP32, matvec, MODEL, mul, rmsnorm, rope, silu, softmax, TOKENIZER, type FlopMeter, type LayerStep, type Vec, type Weights } from '../model';
import { cellsOf } from './common';
import type { DsCell, GridPrim, RowPrim, Tone } from './types';

/** 表示组的提示词。每个词正好是 1 个 token，模型对下一个 token 很有把握。 */
export const PROMPT = 'the model writes the next';
export const PROMPT_IDS = TOKENIZER.encode(PROMPT);
export const PROMPT_LABELS = PROMPT_IDS.map((id) => TOKENIZER.label(id));
/** 一次完整前向（只算最后一个位置的 logits，生成下一个 token 只需要它）。 */
export const PROMPT_TRACE = forward(MODEL, PROMPT_IDS, { lastLogitsOnly: true });
/** 最后一个位置，也就是要预测下一个 token 的位置。 */
export const LAST = PROMPT_IDS.length - 1;

/** 重放时每一站结束后的累计 FLOPs。 */
export type Station = 'norm' | 'qkv' | 'rope' | 'score' | 'softmax' | 'mix' | 'wo' | 'resid' | 'ffnNorm' | 'gateUp' | 'act' | 'down' | 'output';

export interface LayerReplay {
  /** 每个位置的中间张量，字段和 forward 的 LayerStep 一致。 */
  steps: LayerStep[];
  /** 每一站结束时 meter.total 的值。 */
  flops: Record<Station, number>;
}

/**
 * 从空 cache 开始，把第 l 层在 xs 这些位置上重新算一遍。
 * 运算顺序和舍入和 transformer.ts 的 forwardEmbeds 完全相同，只是按「站」而不是按位置组织循环，
 * 这样每一站结束都能读出累计 FLOPs。
 */
export function replayLayer(weights: Weights, l: number, xs: readonly Vec[], meter: FlopMeter): LayerReplay {
  const { config } = weights;
  const layer = weights.layers[l];
  const { headDim, nHeads, eps } = config;
  const scale = 1 / Math.sqrt(headDim);
  const flops = {} as Record<Station, number>;
  const mark = (station: Station) => (flops[station] = meter.total);

  const norms = xs.map((x) => rmsnorm(x, layer.attn_norm, eps, FP32));
  mark('norm');
  const qkv = norms.map(({ y }) => ({
    q: matvec(layer.attn_q, y, FP32, meter, 'qkv'),
    k: matvec(layer.attn_k, y, FP32, meter, 'qkv'),
    v: matvec(layer.attn_v, y, FP32, meter, 'qkv'),
  }));
  mark('qkv');
  const roped = qkv.map(({ q, k }, pos) => ({ qRope: rope(q, pos, config, FP32), kRope: rope(k, pos, config, FP32) }));
  mark('rope');
  const scores = roped.map(({ qRope }, pos) =>
    Array.from({ length: nHeads }, (_, h) => {
      const off = h * headDim;
      const out: Vec = [];
      for (let s = 0; s <= pos; s++) {
        let sum = 0;
        for (let j = 0; j < headDim; j++) sum += qRope[off + j] * roped[s].kRope[off + j];
        out.push(FP32(sum * scale));
      }
      meter.add('score', 2 * headDim * (pos + 1));
      return out;
    }),
  );
  mark('score');
  const probs = scores.map((heads) => heads.map((row) => softmax(row, FP32)));
  mark('softmax');
  const mixed = probs.map((heads, pos) => {
    const out = new Array<number>(config.dModel).fill(0);
    heads.forEach((p, h) => {
      const off = h * headDim;
      for (let j = 0; j < headDim; j++) {
        let sum = 0;
        for (let s = 0; s <= pos; s++) sum += p[s] * qkv[s].v[off + j];
        out[off + j] = FP32(sum);
      }
      meter.add('mix', 2 * headDim * (pos + 1));
    });
    return out;
  });
  mark('mix');
  const attnOut = mixed.map((m) => matvec(layer.attn_output, m, FP32, meter, 'wo'));
  mark('wo');
  const resid = xs.map((x, i) => add(x, attnOut[i], FP32));
  mark('resid');
  const ffnNorms = resid.map((r) => rmsnorm(r, layer.ffn_norm, eps, FP32));
  mark('ffnNorm');
  const gateUp = ffnNorms.map(({ y }) => ({ gate: matvec(layer.ffn_gate, y, FP32, meter, 'ffn'), up: matvec(layer.ffn_up, y, FP32, meter, 'ffn') }));
  mark('gateUp');
  const act = gateUp.map(({ gate, up }) => mul(gate.map((z) => FP32(silu(z))), up, FP32));
  mark('act');
  const ffnOut = act.map((a) => matvec(layer.ffn_down, a, FP32, meter, 'ffn'));
  mark('down');
  const output = resid.map((r, i) => add(r, ffnOut[i], FP32));
  mark('output');

  const steps = xs.map((input, i): LayerStep => ({
    input,
    attnRms: norms[i].rms,
    attnNormed: norms[i].y,
    q: qkv[i].q,
    k: qkv[i].k,
    v: qkv[i].v,
    qRope: roped[i].qRope,
    kRope: roped[i].kRope,
    heads: scores[i].map((row, h) => ({ scores: row, probs: probs[i][h] })),
    mixed: mixed[i],
    attnOut: attnOut[i],
    resid: resid[i],
    ffnRms: ffnNorms[i].rms,
    ffnNormed: ffnNorms[i].y,
    gate: gateUp[i].gate,
    up: gateUp[i].up,
    act: act[i],
    ffnOut: ffnOut[i],
    output: output[i],
  }));
  return { steps, flops };
}

/** 一个头上 q·k / √headDim，计 2·headDim FLOPs（和 forward 的 score 类一致）。 */
export function headScore(q: Vec, k: Vec, head: number, headDim: number, meter: FlopMeter): number {
  const off = head * headDim;
  meter.add('score', 2 * headDim);
  return dot(q.slice(off, off + headDim), k.slice(off, off + headDim)) / Math.sqrt(headDim);
}

/** 固定小数位的显示，负号用 −。概率、分数这类要对齐比较的数用它，不切换成科学计数法。 */
export const fixed = (value: number, digits = 2): string => {
  const text = value.toFixed(digits);
  return /^-0\.0*$/.test(text) ? text.slice(1) : text.replace('-', '−');
};

/** 向量的长度（L2 范数）。 */
export const norm2 = (v: readonly number[]): number => Math.hypot(...v);

/** 最大值的下标。 */
export const argmaxOf = (v: readonly number[]): number => v.reduce((best, value, i) => (value > v[best] ? i : best), 0);

/** 按值从大到小的前 n 个下标。 */
export const topOf = (v: readonly number[], n: number): number[] => [...v.keys()].sort((a, b) => v[b] - v[a]).slice(0, n);

// ---------- 画格子 ----------

/** 一排数：向量。 */
export function vecRow(id: string, values: readonly number[], options: { at?: [number, number]; w?: number; digits?: number; title?: string; tones?: Record<number, Tone>; rest?: Tone; subs?: string[]; lift?: number[]; heat?: number[]; marks?: RowPrim['marks'] } = {}): RowPrim {
  return {
    kind: 'row',
    id,
    at: options.at,
    w: options.w ?? 40,
    title: options.title,
    cells: cellsOf(values.map((value) => fixed(value, options.digits ?? 2)), { tones: options.tones, rest: options.rest, subs: options.subs, lift: options.lift, heat: options.heat }),
    marks: options.marks,
  };
}

/** 一张数表：每行一个向量。 */
export function vecGrid(id: string, rows: string[], cols: string[], values: readonly (readonly (number | null)[])[], options: { at?: [number, number]; w?: number; digits?: number; tone?: (r: number, c: number) => Tone | undefined; heat?: (r: number, c: number) => number | undefined; text?: (r: number, c: number) => string | undefined } = {}): GridPrim {
  return {
    kind: 'grid',
    id,
    at: options.at,
    w: options.w ?? 38,
    rows,
    cols,
    cells: values.map((row, r) => row.map((value, c): DsCell => ({
      v: options.text?.(r, c) ?? (value === null ? '' : fixed(value, options.digits ?? 2)),
      tone: options.tone?.(r, c),
      heat: options.heat?.(r, c),
    }))),
  };
}

/** 维度的列名 d0、d1……。 */
export const dimCols = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `d${from + i}`);
