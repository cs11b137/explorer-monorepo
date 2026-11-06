/**
 * 「小铺」的 MCP 服务器：把 tools.ts 的工具、规则库（资源）和一个售后提示模板（提示）按 MCP 暴露出去。MCP 组的课都连它。
 * 数据都是示例。
 */
import type { ToolContext } from '../tools';
import { shopToolBox } from '../tools';
import { POLICIES } from '../shop';
import type { Implementation } from './protocol';
import { McpServer, type ElicitForm, type PromptSpec, type ResourceSpec, type ServerOptions } from './server';

export const SHOP_SERVER_INFO: Implementation = { name: 'xiaopu-mcp', version: '1.4.0', title: '小铺售后服务' };
export const HOST_CLIENT_INFO: Implementation = { name: 'xiaopu-agent', version: '2.0.0' };

export const SHOP_INSTRUCTIONS = '小铺的售后工具：先用 get_order 查订单，再按规则建退货单。退款会真的打款，必须先让用户确认。';

/** 规则库按文档分成资源，URI 用自定义的 policy:// 方案。 */
export const POLICY_RESOURCES: ResourceSpec[] = (['aftersale', 'refund', 'shipping-fee'] as const).map((doc) => {
  const parts = POLICIES.filter((item) => item.id.startsWith(`${doc}#`));
  const text = parts.map((item) => item.text).join('\n');
  const title = parts[0].text.match(/^《[^》]+》/)?.[0] ?? doc;
  return { resource: { uri: `policy://${doc}`, name: doc, title, mimeType: 'text/plain', size: new TextEncoder().encode(text).length }, read: () => text };
});

/** 售后申请的提示模板：用户在界面上选它、填订单号和问题，得到一条写好的用户消息。 */
export const RETURN_PROMPT: PromptSpec = {
  prompt: {
    name: 'return_request',
    title: '申请退货',
    description: '按订单号和问题描述，生成一条售后申请',
    arguments: [
      { name: 'order_id', description: '订单号', required: true },
      { name: 'problem', description: '问题描述', required: false },
    ],
  },
  render: (args) => ({
    description: '售后申请',
    messages: [{ role: 'user', content: { type: 'text', text: `订单 ${args.order_id}${args.problem ? `：${args.problem}` : ''}。请先查订单和售后规则，能退就帮我建退货单。` } }],
  }),
};

/** 退款前要用户确认的表单（elicitation，form 模式）。 */
export const refundConfirm = (args: Record<string, unknown>): ElicitForm => ({
  mode: 'form',
  message: `确认给订单 ${String(args.order_id)} 退款 ${String(args.amount)} 元？`,
  requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: '确认退款' } }, required: ['confirm'] },
});

export function shopServer(ctx: ToolContext, options: Partial<ServerOptions> = {}): McpServer {
  return new McpServer({
    info: SHOP_SERVER_INFO,
    ctx,
    tools: shopToolBox(['get_order', 'search_policy', 'create_return', 'issue_refund']),
    resources: POLICY_RESOURCES,
    prompts: [RETURN_PROMPT],
    instructions: SHOP_INSTRUCTIONS,
    elicit: { issue_refund: refundConfirm },
    ...options,
  });
}
