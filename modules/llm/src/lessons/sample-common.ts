/**
 * 「采样与输出」五节课（temperature、topk、constrained、streaming、lora）共用的工具。
 * 这里只放「怎么算、怎么画」，课程里的数字一律来自 model/ 的真实运行。
 */
import { floatVector } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import { MODEL } from '../model';
import { f32Bytes } from '../model/numeric';
import { forward, generate, lastLogits } from '../model/transformer';
import { mulberry32 } from '@explorer/llm-core/prng';
import { sample, type SampleOptions, type SampleTrace } from '../model/sample';
import { FlopMeter, type Vec } from '../model/tensor';
import { TOKENIZER } from '@explorer/llm-core/tokenizer';
import { lessonBounds } from '../scene/ds';
import { num, shortLabel } from './common';
import type { Color, Lesson, NodeId } from './types';

const T = TOKENIZER;

/** 信息熵，单位 bit：分布越平越大，全集中在一个 token 上是 0。 */
export function entropyBits(probs: readonly number[]): number {
  let sum = 0;
  for (const p of probs) if (p > 0) sum -= p * Math.log2(p);
  return sum;
}

/** 提示词的 token 和最后一个位置的 logits，同时统计前向的 FLOPs。 */
export function promptLogits(prompt: string): { ids: number[]; logits: Vec; flops: number } {
  const ids = T.encode(prompt);
  const meter = new FlopMeter();
  const logits = lastLogits(forward(MODEL, ids, { meter, lastLogitsOnly: true }));
  return { ids, logits, flops: meter.total };
}

export interface SampledRun {
  /** 生成的 token（不含结束符）。 */
  tokens: number[];
  /** 每一步的采样过程。 */
  traces: SampleTrace[];
  /** 每一步用到的 logits。 */
  logits: Vec[];
  /** 是不是因为抽到结束符而停下。 */
  ended: boolean;
  /** 提示词预填充的 FLOPs 和之后每步解码累计的 FLOPs。 */
  prefillFlops: number;
  decodeFlops: number;
  text: string;
}

/**
 * 从 prompt 开始逐 token 生成，每步按 options 采样。seed 为 null 表示贪心。
 * historyFrom：惩罚统计「已出现 token」时是否把提示词也算进去（Hugging Face 的做法是算）。
 */
export function sampledRun(prompt: readonly number[], options: SampleOptions | ((out: readonly number[]) => SampleOptions), seed: number | null, maxTokens: number, includePrompt = true): SampledRun {
  const rand = seed === null ? undefined : mulberry32(seed);
  const traces: SampleTrace[] = [];
  const logitsList: Vec[] = [];
  const meter = new FlopMeter();
  const prefill = new FlopMeter();
  forward(MODEL, prompt, { meter: prefill, lastLogitsOnly: true });
  const run = generate(MODEL, prompt, {
    maxTokens,
    stop: T.eos,
    meter,
    pick: (logits, _step, out) => {
      const chosen = typeof options === 'function' ? options(out) : options;
      const trace = sample(logits, includePrompt ? [...prompt, ...out] : out, chosen, rand);
      traces.push(trace);
      logitsList.push(logits);
      return trace.chosen;
    },
  });
  return {
    tokens: run.tokens,
    traces,
    logits: logitsList,
    ended: run.steps.length > run.tokens.length,
    prefillFlops: prefill.total,
    decodeFlops: meter.total - prefill.total,
    text: T.decode(run.tokens),
  };
}

/** 概率热力图用的颜色深度：以 0.0–1.0 的概率直接当热度。 */
export const heatOf = (p: number): number => Math.max(0, Math.min(1, p));

/** 整个词表的 float32 向量，每个元素标上 token 的展示文字。逐字节真实。 */
export const vocabFloats = (name: string, values: readonly number[], summary: string, color: 'blue' | 'green' | 'amber' | 'violet' = 'blue') =>
  floatVector(name, values, 'f32', { color, summary, names: (i) => `${name}[${i}]「${shortLabel(i, 8)}」`, digits: 4 });

/** 一行的列标题：候选 token 的展示文字。 */
export const colLabels = (ids: readonly number[], max = 5): string[] => ids.map((id) => shortLabel(id, max));

/**
 * 给数据节点的名称定位：放在整节课这个节点所有图元的下方。
 * 数据节点没有固定外形，名称默认会压在格子上。
 */
export function labelBelow(lesson: Lesson, nodes: NodeId[], gap = 28): Lesson {
  const bounds = lessonBounds(lesson.initial, lesson.steps.flatMap((step) => step.events) as Parameters<typeof lessonBounds>[1]);
  const labelAt: NonNullable<Lesson['labelAt']> = { ...lesson.labelAt };
  for (const id of nodes) {
    const box = bounds[id];
    if (box) labelAt[id] = [Math.round((box[0] + box[2]) / 2), Math.round(box[3]) + gap];
  }
  return { ...lesson, labelAt };
}

// ---------- llama.cpp 的候选数组 ----------

let serial = 0;

/**
 * llama.cpp 采样器里的候选数组 llama_token_data { int32 id; float logit; float p; }，每项 12 字节。
 * 字节按这个布局真实写出，但它是引擎的内部结构，不是公开格式。
 */
export function tokenDataLayer(name: string, items: ReadonlyArray<{ id: number; logit: number; p: number }>, color: Color = 'green', summary = '每项 12 字节：id、logit、p'): LayerWriter {
  const layer = new LayerWriter(`sc${serial++}`, `llama_token_data ${name}[${items.length}] · ${items.length * 12} 字节`, color, summary);
  items.forEach((item, i) => {
    const at = i * 12;
    layer.field(`${name}[${i}] · +${at}`, `「${shortLabel(item.id, 8)}」p=${num(item.p)}`, () => {
      layer.u32(item.id);
      layer.raw(f32Bytes(item.logit));
      layer.raw(f32Bytes(item.p));
    }, { note: `id ${item.id}，logit ${num(item.logit, 3)}，p ${num(item.p, 4)}。` });
    layer.over('id', item.id, at, at + 4);
    layer.over('logit', num(item.logit, 3), at + 4, at + 8);
    layer.over('p', num(item.p, 4), at + 8, at + 12);
  });
  return layer;
}
