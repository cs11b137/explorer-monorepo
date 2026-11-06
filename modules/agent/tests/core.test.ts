/**
 * 计算核心：场景数据、参数校验、工具、Agent 循环。期望值手写（来自规则和文档），或用独立的写法（JSON.stringify、Buffer）核对。
 * MCP 的部分在 core.mcp.test.ts。
 */
import { describe, expect, it } from 'vitest';
import {
  addTotals,
  agentTool,
  buildRequest,
  costOf,
  createShop,
  daysBetween,
  DEFAULT_MAX_TURNS,
  formatErrors,
  grandTotals,
  handoffTool,
  inputBreakdown,
  MODELS,
  returnIdOf,
  runAgent,
  SEARCH_POLICY,
  shopToolBox,
  text,
  toolSystemTokens,
  ToolBox,
  toolUse,
  validate,
  ZERO,
  type AgentConfig,
  type ScriptStep,
} from '../src/core';
import { REACT_SCRIPT, SUPPORT, USER_ASK } from '../src/lessons/scenario';

const ctx = () => ({ shop: createShop() });

describe('场景数据', () => {
  it('签收天数按日历日算', () => {
    expect(daysBetween('2026-11-03', '2026-11-06')).toBe(3);
    expect(daysBetween('2026-10-20', '2026-11-06')).toBe(17);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(() => daysBetween('2026/11/03', '2026-11-06')).toThrow();
  });

  it('每次 createShop 是新的状态，工具改它不影响别的', () => {
    const a = createShop();
    a.returns.push({ return_id: 'x', order_id: 'A1024', reason: 'quality', note: '', refund: 1, shipping_paid_by: 'shop', status: 'pending_pickup' });
    a.orders.get('A1024')!.amount = 1;
    const b = createShop();
    expect(b.returns).toEqual([]);
    expect(b.orders.get('A1024')!.amount).toBe(129);
  });
});

describe('JSON Schema 子集', () => {
  const schema = SEARCH_POLICY.input_schema;
  it('通过的参数没有错误', () => expect(validate(schema, { query: '退货 运费' })).toEqual([]));
  it('缺必填、类型不对、范围、多余参数都报出来，带路径', () => {
    expect(validate(schema, {})).toEqual([{ path: 'query', message: '缺少必填参数' }]);
    expect(validate(schema, { query: 1 })).toEqual([{ path: 'query', message: '应为 string，实际是 integer' }]);
    expect(validate(schema, { query: '退', top_k: 9, x: 1 }).map((e) => e.path)).toEqual(['query', 'top_k', 'x']);
    expect(validate({ type: 'integer' }, 1.5)).toEqual([{ path: '', message: '应为 integer，实际是 number' }]);
    expect(validate({ type: 'number' }, 3)).toEqual([]);
    expect(validate({ type: 'array', items: { type: 'string' } }, ['a', 2])).toEqual([{ path: '[1]', message: '应为 string，实际是 integer' }]);
  });
  it('pattern 和 enum', () => {
    const create = shopToolBox(['create_return']).get('create_return')!.input_schema;
    expect(formatErrors(validate(create, { order_id: 'B1', reason: 'broken' }))).toBe('order_id：不匹配 ^A\\d{4}$；reason：只能是 "quality"、"no_reason" 之一');
  });
  it('不支持的关键字直接报错，不悄悄放行', () => expect(() => validate({ anyOf: [] }, 1)).toThrow());
});

describe('工具', () => {
  const box = shopToolBox(['get_order', 'search_policy', 'create_return', 'issue_refund']);

  it('定义是 Messages API 的 name、description、input_schema', () => {
    const defs = box.definitions();
    expect(defs.map((d) => d.name)).toEqual(['get_order', 'search_policy', 'create_return', 'issue_refund']);
    expect(Object.keys(defs[0])).toEqual(['name', 'description', 'input_schema']);
    // Messages API 文档：工具名要匹配 ^[a-zA-Z0-9_-]{1,128}$。
    for (const d of defs) expect(d.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  it('get_order：查到返回订单 JSON，查不到是 is_error，参数不合格也是 is_error', () => {
    const c = ctx();
    const found = box.call('get_order', { order_id: 'A1024' }, c);
    expect(found.is_error).toBeUndefined();
    expect(JSON.parse(found.content)).toMatchObject({ order_id: 'A1024', amount: 129, signed_at: '2026-11-03' });
    expect(box.call('get_order', { order_id: 'A9999' }, c)).toMatchObject({ is_error: true, content: '找不到订单 A9999' });
    expect(box.call('get_order', { id: 'A1024' }, c)).toMatchObject({ is_error: true, content: '参数不合格：order_id：缺少必填参数；id：不认识的参数' });
    expect(box.call('nope', {}, c)).toMatchObject({ is_error: true });
  });

  it('search_policy：BM25 排序取前 2 段，《售后规则》第 3 条第一', () => {
    const out = box.call('search_policy', { query: '质量问题 退款 运费 签收' }, ctx());
    const hits = out.data as Array<{ id: string; score: number }>;
    expect(hits.map((h) => h.id)).toEqual(['aftersale#3', 'aftersale#2']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(out.content.split('\n')).toHaveLength(2);
    expect(box.call('search_policy', { query: 'xyz', top_k: 1 }, ctx()).is_error).toBe(true);
  });

  it('create_return：7 天内的质量问题可退，运费店铺出；超期、未签收、重复都拒绝', () => {
    const c = ctx();
    const ok = box.call('create_return', { order_id: 'A1024', reason: 'quality', note: '杯盖漏水' }, c);
    expect(JSON.parse(ok.content)).toEqual({ return_id: 'R20261106-001', refund: 129, shipping_paid_by: 'shop', days_since_signed: 3, status: 'pending_pickup' });
    expect(c.shop.returns).toHaveLength(1);
    expect(box.call('create_return', { order_id: 'A1024', reason: 'quality' }, c).content).toBe('订单 A1024 已经有退货单了');
    expect(box.call('create_return', { order_id: 'A1025', reason: 'quality' }, c).content).toBe('订单 A1025 签收已 17 天，超过 7 天的退货期限');
    expect(box.call('create_return', { order_id: 'A1031', reason: 'no_reason' }, c).content).toBe('订单 A1031 还没有签收，不能退货');
    expect(JSON.parse(box.call('create_return', { order_id: 'A1024', reason: 'no_reason' }, ctx()).content).shipping_paid_by).toBe('buyer');
    expect(returnIdOf('2026-11-06', 12)).toBe('R20261106-012');
  });

  it('issue_refund：没有退货单不能退，金额不能超过实付', () => {
    const c = ctx();
    expect(box.call('issue_refund', { order_id: 'A1024', amount: 129 }, c).content).toBe('订单 A1024 没有退货单，不能退款');
    box.call('create_return', { order_id: 'A1024', reason: 'quality' }, c);
    expect(box.call('issue_refund', { order_id: 'A1024', amount: 200 }, c).is_error).toBe(true);
    expect(JSON.parse(box.call('issue_refund', { order_id: 'A1024', amount: 129 }, c).content)).toEqual({ refund_id: 'F20261106-001', order_id: 'A1024', amount: 129 });
  });
});

describe('Agent 循环', () => {
  const run = runAgent(SUPPORT, USER_ASK, REACT_SCRIPT, { ctx: ctx() });

  it('四轮：前三轮 tool_use，最后 end_turn，三次工具调用', () => {
    expect(run.turns.map((t) => t.message.stop_reason)).toEqual(['tool_use', 'tool_use', 'tool_use', 'end_turn']);
    expect(run.stop).toBe('end_turn');
    expect(run.turns.map((t) => t.calls.map((c) => c.use.name))).toEqual([['get_order'], ['search_policy'], ['create_return'], []]);
    expect(run.final).toContain('R20261106-001');
  });

  it('历史每轮整份重发：第 n 轮请求有 2n − 1 条消息，user / assistant 交替', () => {
    expect(run.turns.map((t) => t.request.messages.length)).toEqual([1, 3, 5, 7]);
    expect(run.messages).toHaveLength(8);
    expect(run.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    // 第 2 轮的请求是第 1 轮请求的前缀加上两条新消息。
    expect(run.turns[1].request.messages.slice(0, 1)).toEqual(run.turns[0].request.messages);
  });

  it('tool_result 的 tool_use_id 和 tool_use 的 id 一致，结果放在下一条 user 消息里', () => {
    const t1 = run.turns[0];
    const use = t1.calls[0].use;
    expect(run.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: t1.calls[0].outcome.content }] });
    expect(use.id).toMatch(/^toolu_01[A-Za-z1-9]{22}$/);
  });

  it('输入 token = 展开后的提示 + 工具系统提示（文档给的 286），费用按示例单价', () => {
    for (const turn of run.turns) {
      expect(turn.toolSystem).toBe(286);
      expect(turn.message.usage.input_tokens).toBe(inputBreakdown(turn.request).total + 286);
      expect(turn.cost.total).toBe(costOf(turn.message.usage, 'claude-opus-5-5').total);
      expect(turn.cost.total).toBe(turn.message.usage.input_tokens * 4000 + turn.message.usage.output_tokens * 20000);
    }
    expect(MODELS['claude-opus-5-5'].toolSystemTokens).toBe(286);
  });

  it('累计账逐轮相加，单调递增；一轮比一轮读得多', () => {
    let sum = ZERO;
    for (const turn of run.turns) {
      expect(turn.before).toEqual(sum);
      sum = addTotals(sum, { turns: 1, input: turn.message.usage.input_tokens, output: turn.message.usage.output_tokens, cost: turn.cost.total });
      expect(turn.after).toEqual(sum);
    }
    expect(run.totals).toEqual(sum);
    const inputs = run.turns.map((t) => t.message.usage.input_tokens);
    for (let i = 1; i < inputs.length; i++) expect(inputs[i]).toBeGreaterThan(inputs[i - 1]);
    expect(grandTotals(run)).toEqual(run.totals);
  });

  it('请求的 HTTP 字节：POST /v1/messages，消息体是请求的紧凑 JSON', () => {
    const t = run.turns[1];
    const head = String.fromCharCode(...t.http.request.bytes.slice(0, t.http.request.body[0]));
    expect(head.startsWith('POST /v1/messages HTTP/1.1\r\n')).toBe(true);
    expect(Buffer.from(t.http.request.bytes.slice(t.http.request.body[0])).toString('utf8')).toBe(JSON.stringify(t.request));
    expect(buildRequest(SUPPORT, t.request.messages)).toEqual(t.request);
  });

  it('最大轮数：到了就停，stop 是 max_turns，最后一轮的工具结果已回填', () => {
    const loop: ScriptStep[] = Array.from({ length: 5 }, (_, i) => [toolUse('get_order', { order_id: 'A1024' }, 50 + i)]);
    const capped = runAgent(SUPPORT, '查一下 A1024', loop, { ctx: ctx(), maxTurns: 3 });
    expect(capped.stop).toBe('max_turns');
    expect(capped.turns).toHaveLength(3);
    expect(capped.messages.at(-1)!.role).toBe('user');
    expect(DEFAULT_MAX_TURNS).toBe(10);
  });

  it('max_tokens：输出超过上限时截断，stop 是 max_tokens，循环停下', () => {
    const tiny: AgentConfig = { ...SUPPORT, maxTokens: 5 };
    const cut = runAgent(tiny, '你好', [[text('这是一段很长很长的回答，肯定超过五个 token。')]], { ctx: ctx() });
    expect(cut.stop).toBe('max_tokens');
    expect(cut.turns[0].message.usage.output_tokens).toBe(5);
  });

  it('脚本不够用时报错', () => {
    expect(() => runAgent(SUPPORT, '你好', [[toolUse('get_order', { order_id: 'A1024' }, 1)]], { ctx: ctx() })).toThrow(/脚本只有 1 轮/);
  });

  it('并行调用：一轮里两个 tool_use，两个 tool_result 按顺序放在同一条 user 消息里', () => {
    const par = runAgent(SUPPORT, '查 A1024 和退货规则', [[toolUse('get_order', { order_id: 'A1024' }, 61), toolUse('search_policy', { query: '退货' }, 62)], [text('好的。')]], { ctx: ctx() });
    const results = par.messages[2].content as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(par.turns[0].calls.map((c) => c.use.id));
  });

  it('权限检查：不放行的调用不执行，结果是拒绝原因、is_error', () => {
    const c = ctx();
    const box: AgentConfig = { ...SUPPORT, tools: shopToolBox(['create_return', 'issue_refund']) };
    const denied = runAgent(box, '退款', [[toolUse('issue_refund', { order_id: 'A1024', amount: 129 }, 71)], [text('需要您确认。')]], {
      ctx: c,
      permit: (use, spec) => (spec?.hints?.destructiveHint ? { allow: false, reason: `${use.name} 需要用户确认` } : { allow: true }),
    });
    expect(denied.turns[0].calls[0]).toMatchObject({ denied: true, result: { is_error: true, content: 'issue_refund 需要用户确认' } });
    expect(c.shop.refunds).toEqual([]);
  });

  it('子 Agent：在自己的上下文里跑完，只交回最后的回答；总账含子 Agent', () => {
    const worker: AgentConfig = { name: 'worker', model: 'claude-opus-5-5', system: '你只负责查订单。', tools: shopToolBox(['get_order']) };
    const tool = agentTool('ask_worker', '交给查订单的子 Agent', worker, [[toolUse('get_order', { order_id: 'A1024' }, 81)], [text('A1024 已签收，129 元。')]]);
    const lead: AgentConfig = { name: 'lead', model: 'claude-opus-5-5', system: '你是编排者。', tools: new ToolBox([tool]) };
    const run2 = runAgent(lead, '帮我看看 A1024', [[toolUse('ask_worker', { task: '查 A1024 的签收日期和金额' }, 82)], [text('查好了。')]], { ctx: ctx() });
    expect(run2.children).toHaveLength(1);
    expect(run2.turns[0].calls[0].result.content).toBe('A1024 已签收，129 元。');
    expect(run2.children[0].messages[0]).toEqual({ role: 'user', content: '查 A1024 的签收日期和金额' });
    expect(grandTotals(run2)).toEqual(addTotals(run2.totals, run2.children[0].totals));
  });

  it('转交：调用 transfer_to_<name> 之后，下一轮换成目标 Agent 的 system 和工具，历史不变', () => {
    const refund: AgentConfig = { name: 'refund', model: 'claude-opus-5-5', system: '你负责退款。', tools: shopToolBox(['issue_refund']) };
    const front: AgentConfig = { ...SUPPORT, tools: new ToolBox([...SUPPORT.tools.specs, handoffTool('refund', '把退款交给退款 Agent')]) };
    const run3 = runAgent(front, '我要退款', [[toolUse('transfer_to_refund', {}, 91)], [text('我是退款专员。')]], { ctx: ctx(), agents: { refund } });
    expect(run3.turns.map((t) => t.agent)).toEqual(['support', 'refund']);
    expect(run3.turns[1].request.system).toBe('你负责退款。');
    expect(run3.turns[1].request.tools!.map((t) => t.name)).toEqual(['issue_refund']);
    expect(run3.turns[1].request.messages).toEqual(run3.messages.slice(0, 3));
  });

  it('工具系统提示只在有工具、tool_choice 是 auto / none 时加', () => {
    expect(toolSystemTokens({ model: 'claude-opus-5-5', max_tokens: 1, messages: [] })).toBe(0);
    expect(toolSystemTokens(buildRequest(SUPPORT, []))).toBe(286);
    expect(() => toolSystemTokens({ ...buildRequest(SUPPORT, []), tool_choice: { type: 'any' } })).toThrow();
  });
});
