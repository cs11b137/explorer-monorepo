/**
 * 上下文工程组（budget、compaction、memory、failure、isolation）共用的场景：网店「小铺」的客服 Agent。
 * 它有三个工具（查订单、查规则、退款），五节课都是它在处理同一位用户的同一件事：订单 A1024 的保温杯漏水。
 * 这里只放文字和请求的形状；token 数一律由 core/ 真实计算，模型写的话在各课里标 E.G.。
 */
import { blockText, exampleId, MODELS, type BudgetPlan, type MessageParam, type PartKind, type RenderedPrompt, type ToolDefinition, type Turn } from '../core';
import type { DsCell, RowPrim, Tone } from './types';

export const MODEL = 'claude-opus-5-5';

export const SYSTEM = '你是「小铺」网店的客服 Agent。先用工具查订单和店铺规则再回答，查不到就说不知道。退款前必须让用户确认金额。';

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_order',
    description: '按订单号查询订单状态、物流和金额',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
  {
    name: 'search_docs',
    description: '检索店铺规则文档，返回最相关的几段',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'refund',
    description: '对订单发起退款，调用前必须得到用户确认',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } }, required: ['order_id', 'amount'] },
  },
];

/** 订单号和城市：最早那一轮里用户说的两件关键事实，截断时最容易丢。 */
export const ORDER_ID = 'A1024';
export const CITY = '杭州';

export const ORDER_TOOL_ID = exampleId('toolu', 11);

/** 查订单的工具结果：应用这一侧真实执行 get_order 得到的 JSON（数据是示例）。 */
export const ORDER_RESULT = '{"order_id":"A1024","item":"保温杯","status":"shipped","carrier":"顺丰","eta":"2026-11-08","amount":129}';

/** 前三轮对话：第一轮带一次工具往返（tool_use → tool_result）。助手说的话是示例。 */
export const HISTORY: MessageParam[] = [
  { role: 'user', content: `你好，我上周买的保温杯还没到，订单号 ${ORDER_ID}，收货地址在${CITY}。` },
  { role: 'assistant', content: [{ type: 'text', text: '我先查一下这个订单。' }, { type: 'tool_use', id: ORDER_TOOL_ID, name: 'get_order', input: { order_id: ORDER_ID } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: ORDER_TOOL_ID, content: ORDER_RESULT }] },
  { role: 'assistant', content: '已经发货了：顺丰承运，预计 11 月 8 日送到。' },
  { role: 'user', content: '收到了，可是杯盖有点漏水。' },
  { role: 'assistant', content: '很抱歉。质量问题可以退款或换货，麻烦先拍照上传。' },
  { role: 'user', content: '照片传好了，杯盖边缘有一道裂缝。' },
  { role: 'assistant', content: '收到照片，确认是质量问题。您想退款还是换货？' },
];

/** 店铺规则库里的几段（检索的对象）。 */
export const DOCS = {
  aftersale: '《售后规则》第 3 条：签收后 7 天内，质量问题可退款或换货，运费由店铺承担。',
  refund: '《退款说明》：退款原路退回，支付宝 1–3 个工作日到账，银行卡 3–7 个工作日。',
  shipping: '《运费说明》：非质量问题退货，寄回的运费由买家承担。',
} as const;

/** 本轮的问题。 */
export const QUESTION = '换货太麻烦了，直接退款吧，多久能到账？';

// ---------- 几课共用的计算 ----------

/** 带工具时 API 自动加的工具系统提示：文档给的 Claude 计数（原文不公开，本站拿不到文字，直接记账）。 */
export const TOOL_SYSTEM_TOKENS = MODELS[MODEL].toolSystemTokens;

/** 一条消息在截断策略眼里的样子：角色和内容的文字（内容块按模板里的写法，块之间空一行）。 */
export const turnOf = (message: MessageParam): Turn => ({
  role: message.role,
  text: typeof message.content === 'string' ? message.content : message.content.map((block) => blockText(block)).join('\n\n'),
});

/**
 * 第 i 条消息在展开后的提示里占几个 token：它的内容块，加上块之间的空行（不含角色名和特殊 token）。
 * 和 countTokens(turnOf(message).text) 一致（测试核对），所以截断策略看到的数和拆账的数是同一把尺子。
 */
export function messageTokens(prompt: RenderedPrompt, i: number): number {
  const own = (source?: string) => !!source && (source === `messages[${i}].content` || source.startsWith(`messages[${i}].content[`));
  const first = prompt.pieces.findIndex((piece) => piece.kind === 'content' && own(piece.source));
  if (first < 0) return 0;
  let last = first;
  prompt.pieces.forEach((piece, index) => {
    if (piece.kind === 'content' && own(piece.source)) last = index;
  });
  return prompt.pieces.slice(first, last + 1).reduce((sum, piece) => sum + piece.tokens, 0);
}

/** 消息在图上的颜色：用户蓝、助手绿、工具结果 teal。 */
export const messageTone = (message: MessageParam): Tone =>
  message.role === 'assistant' ? 'green' : typeof message.content !== 'string' && message.content.some((block) => block.type === 'tool_result') ? 'teal' : 'blue';

/** 预算各部分的颜色。 */
export const KIND_TONE: Record<PartKind, Tone> = { tools: 'teal', system: 'violet', history: 'blue', retrieval: 'amber', memory: 'amber', user: 'blue', output: 'green', template: 'slate' };

/** 格子下面的字要短，长了会和相邻格子的字压在一起。 */
const SHORT_LABEL: Record<string, string> = { toolSystem: '提示', system: 'sys', output: '输出' };

/** 预算表画成一排格子：每部分一格写 token 数，最后一格是剩余（或超出）。 */
export function budgetRow(id: string, plan: BudgetPlan, options: { w?: number; lift?: string[]; subs?: Record<string, string> } = {}): RowPrim {
  const cells: DsCell[] = plan.rows.map((row) => ({ v: String(row.tokens), tone: KIND_TONE[row.kind], sub: options.subs?.[row.id] ?? SHORT_LABEL[row.id] ?? row.label, key: row.id, lift: options.lift?.includes(row.id) || undefined }));
  cells.push({ v: String(Math.abs(plan.free)), tone: plan.fits ? 'dim' : 'amber', sub: plan.fits ? '剩余' : '超出', key: 'free', lift: options.lift?.includes('free') || undefined });
  return { kind: 'row', id, w: options.w ?? 50, cells };
}

/** 一段文字里包含哪些关键事实（按字面查找）。 */
export const factsIn = (text: string, facts: readonly string[]): string[] => facts.filter((fact) => text.includes(fact));
