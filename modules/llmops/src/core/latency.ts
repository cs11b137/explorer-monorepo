/**
 * 延迟的模拟和拆账。**延迟是模拟的**（本站不调用真实模型）：每个环节的耗时 = 固定开销 + 按 token 的耗时，再乘一个
 * 对数正态的抖动（中位数 1，固定种子），用来演示长尾和分位数；参数是本站假设的量级，不是任何模型的实测值（README「已知简化」）。
 * 费用不是模拟的：token 数是本站分词器的真实计数，单价来自共享包 llm-core 的 pricing（示例单价，PRICE_DATE）。
 *
 * OpenTelemetry GenAI 指标 gen_ai.client.inference.duration、gen_ai.client.inference.time_to_first_chunk 的单位是秒，
 * 建议的显式桶边界是 GENAI_DURATION_BUCKETS（核对过，见 README）。
 */
import { costOf, type Cost } from '@explorer/llm-core/pricing';
import { gaussian, mulberry32 } from '@explorer/llm-core/prng';
import { bucketCounts, percentiles, type Percentiles } from './stats';

/** gen_ai.client.inference.duration 等指标建议的桶边界（秒）。 */
export const GENAI_DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92] as const;

/** 对数正态的抖动：exp(σZ)，中位数 1。 */
export function jitter(seed: number, sigma: number): () => number {
  const z = gaussian(mulberry32(seed));
  return () => Math.exp(sigma * z());
}

/** 本站假设的模型延迟参数（毫秒）：首个 token 前的固定开销、每个输入 token 的预填充耗时、每个输出 token 的间隔。 */
export interface ModelTiming {
  baseMs: number;
  perInputMs: number;
  perOutputMs: number;
  sigma: number;
}

/** 示例参数：只用来画出「输入越长首 token 越慢、输出越长总时长越长、少数请求特别慢」这几个形状。 */
export const EXAMPLE_TIMING: Record<string, ModelTiming> = {
  'claude-opus-5-5': { baseMs: 420, perInputMs: 0.06, perOutputMs: 22, sigma: 0.35 },
  'claude-sonnet-5-5': { baseMs: 300, perInputMs: 0.04, perOutputMs: 14, sigma: 0.35 },
  'claude-haiku-5-5': { baseMs: 180, perInputMs: 0.02, perOutputMs: 6, sigma: 0.3 },
};

export interface CallTiming {
  /** 首个输出块到达（TTFT / time to first chunk），毫秒。 */
  ttft: number;
  /** 整个调用的时长，毫秒。 */
  total: number;
}

/** 一次模型调用的模拟耗时：ttft = (base + 输入 × perInput) × 抖动，total = ttft + 输出 × perOutput × 抖动。四舍五入到 0.1 毫秒。 */
export function modelTiming(model: string, inputTokens: number, outputTokens: number, rand: () => number, timing: ModelTiming = EXAMPLE_TIMING[model]): CallTiming {
  if (!timing) throw new Error(`没有 ${model} 的示例延迟参数`);
  const r = (v: number) => Math.round(v * 10) / 10;
  const ttft = r((timing.baseMs + inputTokens * timing.perInputMs) * rand());
  return { ttft, total: r(ttft + outputTokens * timing.perOutputMs * rand()) };
}

export interface LatencyRun {
  timings: CallTiming[];
  ttft: Percentiles;
  total: Percentiles;
  /** total 按 GENAI_DURATION_BUCKETS（秒）分桶。 */
  buckets: number[];
}

/** 同一种请求重复 n 次的模拟（固定种子）：每次的 ttft、total，以及分位数和直方图。 */
export function simulateCalls(n: number, model: string, inputTokens: number, outputTokens: number, seed: number): LatencyRun {
  const rand = jitter(seed, EXAMPLE_TIMING[model].sigma);
  const timings = Array.from({ length: n }, () => modelTiming(model, inputTokens, outputTokens, rand));
  return {
    timings,
    ttft: percentiles(timings.map((t) => t.ttft)),
    total: percentiles(timings.map((t) => t.total)),
    buckets: bucketCounts(timings.map((t) => t.total / 1000), GENAI_DURATION_BUCKETS),
  };
}

/** 一次调用的费用（纳美元），只算未缓存的输入和输出。 */
export const callCost = (model: string, inputTokens: number, outputTokens: number): Cost => costOf({ input_tokens: inputTokens, output_tokens: outputTokens }, model);
