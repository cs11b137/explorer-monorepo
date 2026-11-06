/**
 * 文案和计算结果对得上（多 Agent 组：orchestrate、handoff、approval）。写法照 narrative.test.ts：
 * 1. 关键的数写死在这里，改了脚本或数据会立刻报错；
 * 2. 文字里没法直接取值的说法逐条核对（子 Agent 只拿到 task、转交后历史不变、拒绝的调用没有执行、重发用新的 id……）。
 */
import { describe, expect, it } from 'vitest';
import { buildRequest, CONFIRM_KEY, createShop, decodeState, directTransport, HOST_CLIENT_INFO, inputBreakdown, McpClient, shopServer, shopToolBox } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf } from '../src/lessons/types';
import * as O from '../src/lessons/orchestrate';
import * as H from '../src/lessons/handoff';
import * as A from '../src/lessons/approval';

const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const detail = (id: string, step: number) => LESSON_BY_ID[id].steps[step].detail;
const rowsOf = (id: string) => packetsOf(LESSON_BY_ID[id]).map((packet) => packet.row.tokens);

describe('编排者与子 Agent', () => {
  const { numbers: N, run, orderRun, policyRun, single, l1, l2, o1, p1 } = O;

  it('编排者 2 轮，两个子 Agent 各 2 轮，一共 6 次模型调用；子 Agent 都停在 end_turn', () => {
    expect(N).toMatchObject({ modelCalls: 6, leadTurns: 2, childTurns: [2, 2], childMessages: [4, 4], leadMessages: 3 });
    expect(run.children.map((child) => child.agent)).toEqual(['order_agent', 'policy_agent']);
    expect([orderRun.stop, policyRun.stop, run.stop]).toEqual(['end_turn', 'end_turn', 'end_turn']);
    // 编排者第 1 轮写了两个 tool_use：两个子 Agent 在同一轮里委派。
    expect(l1.message.content.map((block) => block.type)).toEqual(['text', 'tool_use', 'tool_use']);
  });

  it('输入 token：按发生的先后累计（编排者 1 → 订单 1、2 → 规则 1、2 → 编排者 2）', () => {
    expect(N.inputs).toEqual([1126, 805, 1079, 868, 1378, 1810]);
    expect(N.cumulative).toEqual([1126, 1931, 3010, 3878, 5256, 7066]);
    expect(N.totalInput).toBe(run.totals.input + orderRun.totals.input + policyRun.totals.input);
    for (const turn of [...run.turns, ...orderRun.turns, ...policyRun.turns]) expect(turn.message.usage.input_tokens).toBe(inputBreakdown(turn.request).total + 286);
    const rows = rowsOf('orchestrate');
    expect(rows.at(-1)).toBe(7066);
    // 每次模型响应时，输入列正好是这一轮之后的累计。
    const replies = packetsOf(LESSON_BY_ID.orchestrate).filter((packet) => packet.from === 'llm').map((packet) => packet.row.tokens);
    expect(replies).toEqual(N.cumulative);
    expect(LESSON_BY_ID.orchestrate.tokensNote).toBe('编排者和两个子 Agent 一共 6 轮模型调用，按发生的先后把每轮的 usage.input_tokens 相加，累计 7,066。');
  });

  it('子 Agent 只拿到 task：messages[0] 就是编排者 tool_use 的 input.task，看不到用户的原话', () => {
    expect(orderRun.messages[0]).toEqual({ role: 'user', content: O.ORDER_TASK });
    expect(policyRun.messages[0]).toEqual({ role: 'user', content: O.POLICY_TASK });
    expect(l1.calls[0].use.input).toEqual({ task: O.ORDER_TASK });
    expect(JSON.stringify(orderRun.messages)).not.toContain(O.ASK);
    expect(o1.request.system).toBe(O.ORDER_AGENT.system);
    expect(o1.request.tools!.map((tool) => tool.name)).toEqual(['get_order']);
    expect(p1.request.tools!.map((tool) => tool.name)).toEqual(['search_policy']);
    expect(N.childTask).toEqual([85, 71]);
    expect(detail('orchestrate', 0)).toContain('子 Agent 看不到用户的原话、编排者的 system 和历史');
  });

  it('只交回最后的回答：tool_result 是子 Agent 的 final；原始结果不进编排者的上下文', () => {
    expect(l1.calls.map((call) => call.result.content)).toEqual([orderRun.final, policyRun.final]);
    const leadText = JSON.stringify(l2.request.messages);
    expect(leadText).not.toContain('"signed_at"');
    expect(leadText).not.toContain('《退款说明》');
    expect(N.childRaw).toEqual([164, 340]);
    expect(N.summaries).toEqual([114, 205]);
    expect(N.leadResults).toBe(N.summaries[0] + N.summaries[1]);
    expect(orderRun.final).toBe('A1024：真空保温杯 BW-350，实付 129 元，顺丰，11 月 3 日签收，到今天 3 天。');
    expect(O.hits.map((hit) => hit.id)).toEqual(['refund#1', 'aftersale#3', 'shipping-fee#1']);
    expect(detail('orchestrate', 2)).toContain('它用 BM25 取了前 3 段规则（refund#1、aftersale#3、shipping-fee#1），原文 340 个 token，读完写下 205 个 token 的结论');
  });

  it('编排者第 2 轮比单 Agent 的第 2 轮少读，但总量是单 Agent 的 2.3 倍', () => {
    expect([N.leadLast, N.singleLast]).toEqual([1810, 1877]);
    expect([N.leadResults, N.singleResults]).toEqual([319, 504]);
    expect(N.leadLast).toBeLessThan(N.singleLast);
    expect(single.turns.map((turn) => turn.calls.length)).toEqual([2, 0]);
    expect(single.final).toBe(run.final);
    expect([N.totalInput, N.singleInput]).toEqual([7066, 3025]);
    expect(N.totalInput / N.singleInput).toBeCloseTo(2.336, 3);
    expect(N.ratio).toBe(2.3);
    expect(N.fixed).toEqual([1027, 690, 767]);
    expect(N.fixedAll).toBe(1027 * 2 + 690 * 2 + 767 * 2);
    expect(N.singleFixedAll).toBe(2098);
    // 「多出来的主要是固定部分」：固定部分的差额占多出来的输入的大半。
    expect((N.fixedAll - N.singleFixedAll) / N.extraInput).toBeGreaterThan(0.5);
    expect(detail('orchestrate', 4)).toContain('编排的方式是它的 2.3 倍');
  });

  it('费用：示例单价，输入 $4、输出 $20 / MTok', () => {
    expect(O.total.cost).toBe(O.total.input * 4000 + O.total.output * 20000);
    expect(N.cost).toBe('$0.05');
    expect(N.singleCost).toBe('$0.0211');
    expect(factsOf('orchestrate', 4).倍数).toBe('2.3 倍');
  });
});

describe('Agent 间转交（handoff）', () => {
  const { numbers: N, run, t1, t2, t3, carried, filtered } = H;

  it('分诊 2 轮、退货专员 3 轮，同一个循环；最后的 Agent 是 returns', () => {
    expect(N.agents).toEqual(['triage', 'triage', 'returns', 'returns', 'returns']);
    expect(N.lastAgent).toBe('returns');
    expect(H.TRANSFER.name).toBe('transfer_to_returns');
    expect(t2.calls[0].use).toMatchObject({ name: 'transfer_to_returns', input: {} });
    expect(N.transferResult).toBe('{"assistant":"returns"}');
    expect(N.inputs).toEqual([959, 1233, 1848, 2301, 2683]);
    expect(N.totalInput).toBe(9024);
    expect(rowsOf('handoff').at(-1)).toBe(9024);
    expect(N.cost).toBe('$0.051');
  });

  it('转交之后 system 和工具换成退货专员的，messages 是同一份历史', () => {
    expect(t3.request.system).toBe(H.RETURNS.system);
    expect(t3.request.tools!.map((tool) => tool.name)).toEqual(['search_policy', 'create_return']);
    expect(t2.request.tools!.map((tool) => tool.name)).toEqual(['get_order', 'transfer_to_returns']);
    expect(t3.request.messages).toEqual(run.messages.slice(0, 5));
    expect(t3.request.messages.slice(0, 3)).toEqual(t2.request.messages);
    expect([N.system, N.tools, N.fixed]).toEqual([[111, 127], [475, 888], [872, 1301]]);
    expect(N.fixed[1]).toBe(127 + 888 + 286);
  });

  it('带过去的历史：5 条消息、473 token，其中订单结果 164；去掉工具项只剩 133，签收日期也没了', () => {
    expect(N.carriedMessages).toBe(5);
    expect(N.carriedTokens).toBe(t3.breakdown.messages.reduce((a, b) => a + b, 0));
    expect(N.carriedTokens).toBe(473);
    expect(N.orderResult).toBe(164);
    expect(JSON.stringify(carried)).toContain('2026-11-03');
    expect(N.filteredTokens).toBe(inputBreakdown(buildRequest(H.RETURNS, filtered)).messages.reduce((a, b) => a + b, 0));
    expect(N.filteredTokens).toBe(133);
    expect(JSON.stringify(filtered)).not.toContain('2026-11-03');
    expect(JSON.stringify(filtered)).not.toContain('tool_');
    // 上一课的订单子 Agent 只拿到 task。
    expect(N.subTask).toBe(O.numbers.childTask[0]);
    expect(detail('handoff', 2)).toContain('上一课的订单子 Agent 只拿到 85 个 token 的 task');
  });

  it('退货专员没有 get_order，签收天数从转交过来的订单结果里来；建单 R20261106-001', () => {
    expect(H.RETURNS.tools.get('get_order')).toBeUndefined();
    expect(run.turns.slice(2).flatMap((turn) => turn.calls.map((call) => call.use.name))).toEqual(['search_policy', 'create_return']);
    expect(H.ticket).toMatchObject({ return_id: 'R20261106-001', refund: 129, days_since_signed: 3 });
    expect(H.hits[0].id).toBe('aftersale#3');
    expect(run.final).toContain('R20261106-001');
    // 回答直接交给界面：最后一个事件从 peer 到 app。
    const last = packetsOf(LESSON_BY_ID.handoff).at(-1)!;
    expect([last.from, last.to]).toEqual(['peer', 'app']);
    expect(t1.agent).toBe('triage');
  });
});

describe('工具权限与人工确认', () => {
  const { numbers: N, run, t2, t3 } = A;

  it('四轮，检查四次：两次放行、一次拒绝、一次确认', () => {
    expect(N.turns).toBe(4);
    expect(N.verdicts).toEqual(['get_order:allow', 'read_reviews:allow', 'update_refund_account:deny', 'issue_refund:confirm']);
    expect([N.allowed, N.confirmed, N.denied]).toEqual([2, 1, 1]);
    expect(N.inputs).toEqual([1712, 2435, 2702, 2937]);
    expect(N.totalInput).toBe(9786);
    expect(rowsOf('approval').at(-1)).toBe(9786);
    expect(N.cost).toBe('$0.0519');
  });

  it('注入文本明确标为演示，进了 tool_result；改账户的调用被拒绝，没有执行', () => {
    const injected = A.REVIEWS.filter((review) => review.injected);
    expect(injected).toHaveLength(1);
    expect(injected[0].text.startsWith('【演示用的注入文本】')).toBe(true);
    expect(run.turns[0].calls[1].result.content).toContain('【演示用的注入文本】');
    expect(N.reviewTokens).toBe(363);
    expect(t2.calls[0]).toMatchObject({ denied: true, result: { is_error: true } });
    expect(N.denyReason).toBe('update_refund_account 不在客服 Agent 的白名单里，没有执行。');
    expect(A.accounts.size).toBe(0);
    expect(N.accountAfter).toBeNull();
    // 「没有检查的话会直接执行」：同一个调用在草稿账户表上真实跑过。
    expect(N.wouldRun).toBe(true);
    expect(A.scratch.get('A1024')).toBe(A.DEMO_ACCOUNT);
    // 工具定义确实在请求里：拦它的是权限检查，不是工具清单。
    expect(t2.request.tools!.map((tool) => tool.name)).toContain('update_refund_account');
  });

  it('规则：不在白名单拒绝；只读放行；其余要确认', () => {
    const box = A.SUPPORT_AGENT.tools;
    const use = (name: string) => ({ type: 'tool_use' as const, id: 'x', name, input: {} });
    expect(A.verdictOf(use('get_order'), box.get('get_order'))).toBe('allow');
    expect(A.verdictOf(use('read_reviews'), box.get('read_reviews'))).toBe('allow');
    expect(A.verdictOf(use('issue_refund'), box.get('issue_refund'))).toBe('confirm');
    expect(A.verdictOf(use('update_refund_account'), box.get('update_refund_account'))).toBe('deny');
    expect(A.verdictOf(use('no_such_tool'), undefined)).toBe('deny');
    expect(box.get('issue_refund')!.hints).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('MCP 确认：先回 input_required（id 1），带 inputResponses 和 requestState 用新的 id 2 重发才退款', () => {
    expect(N.rpcIds).toEqual([1, 2]);
    expect([N.askType, N.askMethod, N.doneType]).toEqual(['input_required', 'elicitation/create', 'complete']);
    expect(N.askMessage).toBe('确认给订单 A1024 退款 129 元？');
    expect(N.requestState).toEqual({ tool: 'issue_refund', arguments: { order_id: 'A1024', amount: 129 } });
    expect(N.refundsWhileAsking).toBe(0);
    expect([N.refundId, N.refundAmount, N.refunds]).toEqual(['F20261106-001', 129, 1]);
    const resend = A.confirmEx.request.params as Record<string, unknown>;
    expect(resend.inputResponses).toEqual({ [CONFIRM_KEY]: { action: 'accept', content: { confirm: true } } });
    expect(resend.requestState).toBe((A.askEx.response as unknown as { result: { requestState: string } }).result.requestState);
    expect(decodeState(resend.requestState as string)).toEqual(N.requestState);
    expect(t3.calls[0].result.content).toContain('F20261106-001');
    expect(detail('approval', 3)).toContain('id 换成 2，规范要求重发用新的 id');
  });

  it('「要是用户点了拒绝，服务器回 isError 的结果，钱一分不动」', () => {
    const shop = createShop();
    shopToolBox(['create_return']).call('create_return', { order_id: 'A1024', reason: 'quality' }, { shop });
    const client = new McpClient(directTransport(shopServer({ shop })), { info: HOST_CLIENT_INFO, capabilities: { elicitation: { form: {} } } });
    const first = client.callTool('issue_refund', { order_id: 'A1024', amount: 129 });
    const state = (first.response as unknown as { result: { requestState: string } }).result.requestState;
    const declined = client.callTool('issue_refund', { order_id: 'A1024', amount: 129 }, { inputResponses: { [CONFIRM_KEY]: { action: 'decline' } }, requestState: state });
    expect((declined.response as unknown as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(shop.refunds).toEqual([]);
  });

  it('回答里的数来自结果：退款 129 元、2 条提到漏水', () => {
    expect(N.leaks).toBe(2);
    expect(run.final).toContain('已经按原路退款 129 元，退款单 F20261106-001');
    expect(run.final).toContain('评价里有 2 条提到杯盖漏水');
    expect(LESSON_BY_ID.approval.outro.text).toContain('下一门课 LLMOPS EXPLORER');
    expect(LESSON_BY_ID.approval.outro.facts).toContainEqual(['下一门课', 'LLMOPS EXPLORER']);
  });
});
