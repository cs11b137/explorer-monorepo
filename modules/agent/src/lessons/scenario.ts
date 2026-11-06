/**
 * 各课共用的场景：网店「小铺」的客服 Agent 处理订单 A1024 的杯盖漏水（和 CONTEXT EXPLORER 上下文工程组是同一件事）。
 * 这里只放文字、配置和脚本；token、费用、工具结果一律由 core/ 真实计算，模型写的话（脚本）在课程里标 E.G.。
 *
 * 后面的课可以直接用 SUPPORT（客服 Agent 的配置）和 USER_ASK，也可以照 REACT_SCRIPT 的写法写自己的脚本：
 * 脚本的一步可以是函数，拿到上一轮的工具结果再决定写什么，这样文字里的日期、单号、金额都来自真实执行的结果。
 */
import { daysBetween, TODAY, DEFAULT_MODEL, ORDER_ID, shopToolBox, text, toolUse, type AgentConfig, type Order, type ScriptStep } from '../core';

export const MODEL = DEFAULT_MODEL;

export const SYSTEM = '你是「小铺」网店的客服 Agent。先用工具查订单和店铺规则再回答，查不到就说不知道。符合规则的，帮用户建退货单。';

/** 用户的请求。 */
export const USER_ASK = `我上周买的保温杯杯盖漏水，订单 ${ORDER_ID}，想退货。`;

/** 客服 Agent：三个工具（查订单、查规则、建退货单）。 */
export const SUPPORT: AgentConfig = { name: 'support', model: MODEL, system: SYSTEM, tools: shopToolBox(['get_order', 'search_policy', 'create_return']) };

/** search_policy 的查询词（模型写的，示例）。 */
export const POLICY_QUERY = '质量问题 退款 运费 签收';

/** 「11 月 3 日」这种写法。 */
export const dateText = (iso: string): string => {
  const [, month, day] = iso.split('-').map(Number);
  return `${month} 月 ${day} 日`;
};

/**
 * ReAct 课的脚本：四轮。每轮先写一句「想法」（text），再写一个行动（tool_use）；最后一轮只写回答。
 * 第 2、3、4 轮是函数：日期、天数、退货单号、金额都从上一轮的工具结果里取。
 */
export const REACT_SCRIPT: ScriptStep[] = [
  [text('先查一下这个订单。'), toolUse('get_order', { order_id: ORDER_ID }, 1)],
  ({ lastCalls }) => {
    const order = lastCalls[0].outcome.data as Order;
    return [text(`订单 ${dateText(order.signed_at!)}签收，我再查一下售后规则。`), toolUse('search_policy', { query: POLICY_QUERY }, 2)];
  },
  ({ calls }) => {
    // 签收天数：模型从历史里的订单结果读出签收日期，按今天算。这里用同一份结果真实计算。
    const order = calls.find((call) => call.use.name === 'get_order')!.outcome.data as Order;
    const days = daysBetween(order.signed_at!, TODAY);
    return [text(`签收 ${days} 天，在 7 天之内，杯盖漏水是质量问题，可以退款，运费由店铺承担。我来建退货单。`), toolUse('create_return', { order_id: ORDER_ID, reason: 'quality', note: '杯盖漏水' }, 3)];
  },
  ({ lastCalls }) => {
    const ticket = lastCalls[0].outcome.data as { return_id: string; refund: number };
    return [text(`已经为您建好退货单 ${ticket.return_id}。快递会上门取件，寄回运费由店铺承担；商品寄回、审核通过后，${ticket.refund} 元原路退回。`)];
  },
];
