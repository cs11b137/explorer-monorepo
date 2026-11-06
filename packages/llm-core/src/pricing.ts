/**
 * 原在 CONTEXT EXPLORER 的 src/core/pricing.ts（那里转导出，接口不变；AGENT EXPLORER 也用）。核对过的事实见 modules/context/README.md。
 *
 * 计费。单价是示例：取自 Anthropic 定价页（https://platform.claude.com/docs/en/about-claude/pricing），
 * 查询日期 2026-11-06。价格会变，展示时一律注明「示例单价」和这个日期。
 *
 * 金额用整数「纳美元」（1e-9 美元）计算，避免浮点误差：
 * 单价以「毫美元 / 百万 token」存（$4 / MTok = 4000），一个 token 的费用恰好是这个整数个纳美元。
 *
 * 提示缓存的倍率（同一页「Prompt caching」一节）：
 *   - 5 分钟缓存写入 1.25 倍基础输入价，1 小时缓存写入 2 倍；
 *   - 缓存读取（命中和刷新）0.1 倍，Claude Opus 5.5 和 Claude Sonnet 5.5 是 0.05 倍，Claude Fable 5.1 是 0.025 倍。
 */
export const PRICE_DATE = '2026-11-06';
export const PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

/** 每百万 token 的价格，单位毫美元。 */
export interface Price {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
}

/** 示例单价（2026-11-06）。Haiku 5.5 取「提示不超过 100,000 token」那一档。 */
export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4000, write5m: 5000, write1h: 8000, read: 200, output: 20000 },
  'claude-sonnet-5-5': { input: 2000, write5m: 2500, write1h: 4000, read: 100, output: 10000 },
  'claude-haiku-5-5': { input: 100, write5m: 125, write1h: 200, read: 10, output: 500 },
};

export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
/** 缓存读取倍率，按模型。 */
export const CACHE_READ: Record<string, number> = { 'claude-opus-5-5': 0.05, 'claude-sonnet-5-5': 0.05, 'claude-haiku-5-5': 0.1 };

/** 计费需要的 usage 字段，和 Messages API 的 usage 同名。 */
export interface BillableUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  /** 没有 cache_creation 细分时，全部按 5 分钟写入计。 */
  cache_creation_input_tokens?: number;
}

/** 各项费用，单位纳美元。 */
export interface Cost {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
  total: number;
}

export function priceOf(model: string): Price {
  const price = PRICES[model];
  if (!price) throw new Error(`没有 ${model} 的示例单价`);
  return price;
}

export function costOf(usage: BillableUsage, model: string): Cost {
  const price = priceOf(model);
  const w5 = usage.cache_creation?.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0;
  const w1 = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cost = {
    input: usage.input_tokens * price.input,
    write5m: w5 * price.write5m,
    write1h: w1 * price.write1h,
    read: (usage.cache_read_input_tokens ?? 0) * price.read,
    output: usage.output_tokens * price.output,
  };
  return { ...cost, total: cost.input + cost.write5m + cost.write1h + cost.read + cost.output };
}

/** 纳美元 → 美元的文字。小于 1 美分时用科学计数法太难读，改用「$0.000123」这种固定小数，保留 3 位有效数字。 */
export function formatUsd(nano: number): string {
  const usd = nano / 1e9;
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${+usd.toFixed(4)}`;
  const digits = Math.max(0, 2 - Math.floor(Math.log10(usd)));
  return `$${usd.toFixed(digits)}`;
}

/** 单价的文字：「$4 / MTok」。 */
export const formatPrice = (milli: number): string => `$${+(milli / 1000).toFixed(3)} / MTok`;
