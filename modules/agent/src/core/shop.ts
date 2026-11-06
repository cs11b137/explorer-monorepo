/**
 * 场景数据：网店「小铺」。和 CONTEXT EXPLORER 上下文工程组、RAG EXPLORER 是同一家店（订单 A1024、杯盖漏水的保温杯、
 * 《售后规则》第 3 条），这门课讲那个客服 Agent 怎样一轮轮调用工具、经由 MCP 连上服务器、和别的 Agent 协作。
 *
 * 全部是内存里的示例数据，不是真实店铺。工具（tools.ts）在这份数据上真实执行：查订单、按 BM25 检索规则、算签收天数、建退货单。
 * `createShop()` 每次返回一份新的可变状态，工具改的是它，不会影响别的课。
 */

export const SHOP = '小铺';

/** 课程里的「今天」：和 CONTEXT EXPLORER 的示例时刻（EXAMPLE_EPOCH）同一天。 */
export const TODAY = '2026-11-06';

export type OrderStatus = 'paid' | 'shipped' | 'delivered';

export interface Order {
  order_id: string;
  item: string;
  sku: string;
  /** 实付金额，元（整数）。 */
  amount: number;
  status: OrderStatus;
  carrier: string;
  /** 签收日期 YYYY-MM-DD；没签收时是 null。 */
  signed_at: string | null;
}

export const ORDERS: readonly Order[] = [
  { order_id: 'A1024', item: '真空保温杯 BW-350', sku: 'BW-350', amount: 129, status: 'delivered', carrier: '顺丰', signed_at: '2026-11-03' },
  { order_id: 'A1025', item: '电热水壶 KT-15', sku: 'KT-15', amount: 199, status: 'delivered', carrier: '顺丰', signed_at: '2026-10-20' },
  { order_id: 'A1031', item: '保温杯密封圈 SR-35', sku: 'SR-35', amount: 12, status: 'shipped', carrier: '顺丰', signed_at: null },
];

export const ORDER_ID = 'A1024';

/** 规则库的一段：检索的单位。 */
export interface PolicyDoc {
  id: string;
  text: string;
}

/** 规则库（《售后规则》《退款说明》《运费说明》的原文和 RAG EXPLORER 的知识库一致）。search_policy 在这里做 BM25 检索。 */
export const POLICIES: readonly PolicyDoc[] = [
  { id: 'aftersale#1', text: '《售后规则》第 1 条：签收后 7 天内可以无理由退货，商品和配件要完好，非质量问题寄回的运费由买家承担。' },
  { id: 'aftersale#2', text: '《售后规则》第 2 条：签收后 15 天内出现质量问题可以换货，换货来回的运费都由店铺承担。' },
  { id: 'aftersale#3', text: '《售后规则》第 3 条：签收后 7 天内，质量问题可退款或换货，运费由店铺承担。' },
  { id: 'aftersale#4', text: '《售后规则》第 4 条：申请售后要先在订单详情里拍照上传问题部位，客服确认是质量问题后再寄回。' },
  { id: 'refund#1', text: '《退款说明》：退款原路退回，支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。' },
  { id: 'refund#2', text: '退款申请审核通过后才会打款，审核一般在 24 小时内完成，周末顺延。' },
  { id: 'shipping-fee#1', text: '《运费说明》：非质量问题退货，寄回的运费由买家承担。' },
  { id: 'delivery#1', text: '默认用顺丰快递发货，江浙沪一般次日送达，其他地区 2–4 天送达。' },
];

/** 质量问题可以退款的天数（《售后规则》第 3 条）。create_return 按它判断。 */
export const QUALITY_RETURN_DAYS = 7;
/** 无理由退货的天数（第 1 条）。 */
export const NO_REASON_RETURN_DAYS = 7;

export type ReturnReason = 'quality' | 'no_reason';

export interface ReturnTicket {
  return_id: string;
  order_id: string;
  reason: ReturnReason;
  note: string;
  /** 应退金额，元。 */
  refund: number;
  /** 寄回运费谁出。 */
  shipping_paid_by: 'shop' | 'buyer';
  status: 'pending_pickup';
}

export interface RefundRecord {
  refund_id: string;
  order_id: string;
  amount: number;
}

/** 一份可变的店铺状态：工具在它上面执行。 */
export interface ShopState {
  today: string;
  orders: Map<string, Order>;
  returns: ReturnTicket[];
  refunds: RefundRecord[];
}

export function createShop(today = TODAY): ShopState {
  return { today, orders: new Map(ORDERS.map((order) => [order.order_id, { ...order }])), returns: [], refunds: [] };
}

/** 两个 YYYY-MM-DD 之间隔了几天（按 UTC 日历日）。 */
export function daysBetween(from: string, to: string): number {
  const day = (text: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) throw new Error(`日期格式不对：${text}`);
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
  };
  return day(to) - day(from);
}
