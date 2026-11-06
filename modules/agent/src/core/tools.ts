/**
 * 工具：定义（模型看到的 name、description、input_schema）和实现（应用这一侧真正执行的函数）。
 *
 * 模型只会「请求」调用工具（tool_use 块），执行的是这里的代码：在 shop.ts 的内存数据上查订单、用 BM25 检索规则、
 * 按签收天数判断能不能退、建退货单。参数先按 input_schema 校验（schema.ts），不合格、找不到订单、超过期限都不抛异常，
 * 而是返回 is_error 的结果交回模型——这是 Messages API 文档推荐的做法，模型能看到错误并改正。
 *
 * 同一份 ToolSpec 既能写成 Messages API 的工具定义（definitions），也能写成 MCP 的 Tool（mcp/server.ts 用 annotations）。
 */
import { bm25 } from '@explorer/llm-core/bm25';
import { encodeJson } from '@explorer/llm-core/json';
import type { ToolDefinition } from '@explorer/llm-core/anthropic';
import type { AgentRun } from './loop';
import { formatErrors, validate, type JsonSchema } from './schema';
import { daysBetween, NO_REASON_RETURN_DAYS, POLICIES, QUALITY_RETURN_DAYS, SHOP_TOOL_DEFS, type ReturnReason, type ReturnTicket, type ShopState } from './shop';

/** MCP ToolAnnotations 的四个提示（规范里都是 hint，不可信的服务器给的不能当真）。 */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  shop: ShopState;
}

export interface ToolOutcome {
  /** 交回模型的文字（tool_result 的 content）。 */
  content: string;
  is_error?: boolean;
  /** 结构化的结果，课程画图用；也是 MCP 的 structuredContent。 */
  data?: unknown;
  /** 这次调用跑了一个子 Agent（loop.ts 的 agentTool）：它的整次运行。 */
  child?: AgentRun;
}

export interface ToolSpec {
  name: string;
  /** MCP 的 title（给人看的名字）。 */
  title?: string;
  description: string;
  input_schema: JsonSchema & { type: 'object' };
  hints?: ToolHints;
  /** 转交工具（loop.ts 的 handoffTool）：调用成功后循环换成这个名字的 Agent。 */
  handoff?: string;
  run(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome;
}

const json = (value: unknown): string => encodeJson(value).text;
const fail = (content: string, data?: unknown): ToolOutcome => ({ content, is_error: true, data });

// ---------- 小铺的工具 ----------

export const GET_ORDER: ToolSpec = {
  ...SHOP_TOOL_DEFS.get_order,
  run(input, { shop }) {
    const order = shop.orders.get(String(input.order_id));
    if (!order) return fail(`找不到订单 ${String(input.order_id)}`);
    return { content: json(order), data: order };
  },
};

export interface PolicyHit {
  id: string;
  text: string;
  score: number;
}

export const SEARCH_POLICY: ToolSpec = {
  ...SHOP_TOOL_DEFS.search_policy,
  run(input) {
    // bm25 按原顺序返回每段的分数：这里按分数从高到低排（同分保持原顺序），取前 k 段。
    const k = typeof input.top_k === 'number' ? input.top_k : 2;
    const hits: PolicyHit[] = bm25(POLICIES.map((doc) => ({ id: doc.id, text: doc.text })), String(input.query))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((hit) => ({ id: hit.id, text: hit.text, score: hit.score }));
    if (!hits.length) return fail(`规则库里没有和「${String(input.query)}」相关的内容`, hits);
    return { content: hits.map((hit) => `[${hit.id}] ${hit.text}`).join('\n'), data: hits };
  },
};

/** 退货单号：R + 日期 + 三位序号，按建单顺序。 */
export const returnIdOf = (today: string, seq: number): string => `R${today.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;

export const CREATE_RETURN: ToolSpec = {
  ...SHOP_TOOL_DEFS.create_return,
  run(input, { shop }) {
    const order = shop.orders.get(String(input.order_id));
    if (!order) return fail(`找不到订单 ${String(input.order_id)}`);
    if (order.status !== 'delivered' || !order.signed_at) return fail(`订单 ${order.order_id} 还没有签收，不能退货`);
    if (shop.returns.some((ticket) => ticket.order_id === order.order_id)) return fail(`订单 ${order.order_id} 已经有退货单了`);
    const reason = input.reason as ReturnReason;
    const days = daysBetween(order.signed_at, shop.today);
    const limit = reason === 'quality' ? QUALITY_RETURN_DAYS : NO_REASON_RETURN_DAYS;
    if (days > limit) return fail(`订单 ${order.order_id} 签收已 ${days} 天，超过 ${limit} 天的退货期限`, { days, limit });
    const ticket: ReturnTicket = {
      return_id: returnIdOf(shop.today, shop.returns.length + 1),
      order_id: order.order_id,
      reason,
      note: typeof input.note === 'string' ? input.note : '',
      refund: order.amount,
      shipping_paid_by: reason === 'quality' ? 'shop' : 'buyer',
      status: 'pending_pickup',
    };
    shop.returns.push(ticket);
    const result = { return_id: ticket.return_id, refund: ticket.refund, shipping_paid_by: ticket.shipping_paid_by, days_since_signed: days, status: ticket.status };
    return { content: json(result), data: { ...result, ticket } };
  },
};

export const ISSUE_REFUND: ToolSpec = {
  ...SHOP_TOOL_DEFS.issue_refund,
  run(input, { shop }) {
    const order = shop.orders.get(String(input.order_id));
    if (!order) return fail(`找不到订单 ${String(input.order_id)}`);
    if (!shop.returns.some((ticket) => ticket.order_id === order.order_id)) return fail(`订单 ${order.order_id} 没有退货单，不能退款`);
    const amount = Number(input.amount);
    if (amount > order.amount) return fail(`退款金额 ${amount} 超过实付金额 ${order.amount}`);
    const record = { refund_id: `F${shop.today.replace(/-/g, '')}-${String(shop.refunds.length + 1).padStart(3, '0')}`, order_id: order.order_id, amount };
    shop.refunds.push(record);
    return { content: json(record), data: record };
  },
};

export const SHOP_TOOLS: readonly ToolSpec[] = [GET_ORDER, SEARCH_POLICY, CREATE_RETURN, ISSUE_REFUND];

// ---------- 工具箱 ----------

/** 一组工具：给模型的定义，和按名字执行。 */
export class ToolBox {
  readonly specs: readonly ToolSpec[];
  constructor(specs: readonly ToolSpec[]) {
    if (new Set(specs.map((spec) => spec.name)).size !== specs.length) throw new Error('工具名重复');
    this.specs = specs;
  }

  /** Messages API 请求里的 tools：name、description、input_schema，顺序和 specs 一致。 */
  definitions(): ToolDefinition[] {
    return this.specs.map((spec) => ({ name: spec.name, description: spec.description, input_schema: spec.input_schema }));
  }

  get(name: string): ToolSpec | undefined {
    return this.specs.find((spec) => spec.name === name);
  }

  /** 执行一次调用：不认识的工具、参数不合格、实现抛出的异常都写成 is_error 的结果，不向外抛。 */
  call(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
    const spec = this.get(name);
    if (!spec) return fail(`没有名为 ${name} 的工具`);
    const errors = validate(spec.input_schema, input);
    if (errors.length) return fail(`参数不合格：${formatErrors(errors)}`, errors);
    try {
      return spec.run(input, ctx);
    } catch (error) {
      return fail(`工具执行出错：${(error as Error).message}`);
    }
  }
}

/** 小铺的工具箱：按名字挑几个（默认前三个，不含退款）。 */
export const shopToolBox = (names: readonly string[] = ['get_order', 'search_policy', 'create_return']): ToolBox =>
  new ToolBox(names.map((name) => {
    const spec = SHOP_TOOLS.find((item) => item.name === name);
    if (!spec) throw new Error(`没有工具 ${name}`);
    return spec;
  }));
