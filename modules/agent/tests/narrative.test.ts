/**
 * 文案和计算结果对得上（Agent 循环组）。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果（防止取错字段），关键的数写死在这里，改了脚本或数据会立刻报错；
 * 2. 文字里没法取值的说法，比如「order_id 要匹配 A 加四位数字」「《售后规则》第 3 条得分最高」「历史每轮整份重发」。
 *
 * 每加一节课，在对应组的 narrative 测试里加一个 describe（loop 组在这里，mcp 组在 narrative.mcp.test.ts，multi 组在 narrative.multi.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import { costOf, daysBetween, GET_ORDER, inputBreakdown, POLICIES, TODAY } from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf } from '../src/lessons/types';
import { hits, numbers, order, run, shop, t1, t2, t3, t4, ticket } from '../src/lessons/react';
import { REACT_SCRIPT, USER_ASK } from '../src/lessons/scenario';
// 循环组后四课（tooldefs、parallel、stopping、sdks）用到的。
import { countTokens, CREATE_RETURN, DOCUMENTED_ERRORS, encodeJson, ISSUE_REFUND, NO_REASON_RETURN_DAYS, renderRequest, toolsText, validate } from '../src/core';
import * as TD from '../src/lessons/tooldefs';
import * as PA from '../src/lessons/parallel';
import * as ST from '../src/lessons/stopping';
import * as SD from '../src/lessons/sdks';

const lesson = LESSON_BY_ID.react;
const stepOf = (step: number) => lesson.steps[step];
const factsOf = (step: number) => Object.fromEntries(lesson.steps[step].facts);

describe('ReAct：思考 → 行动 → 观察', () => {
  it('四轮模型调用、三次工具调用，停在 end_turn', () => {
    expect(numbers).toMatchObject({ turns: 4, toolCalls: 3, toolDefsCount: 3, maxTurns: 10, messagesPerTurn: [1, 3, 5, 7] });
    expect(run.turns.map((turn) => turn.message.stop_reason)).toEqual(['tool_use', 'tool_use', 'tool_use', 'end_turn']);
    expect(REACT_SCRIPT).toHaveLength(4);
    expect(lesson.overview.facts).toContainEqual(['模型调用', '4 轮，stop_reason 前三轮 tool_use、最后 end_turn']);
  });

  it('每一轮的输入 token：展开后的提示 + 工具系统提示 286；锁住四个数和累计', () => {
    expect(numbers.inputs).toEqual([1684, 1962, 2411, 2793]);
    expect(numbers.outputs).toEqual([92, 153, 223, 143]);
    expect(numbers.cumulative).toEqual([1684, 3646, 6057, 8850]);
    expect(numbers.totalInput).toBe(numbers.inputs.reduce((a, b) => a + b, 0));
    for (const turn of run.turns) expect(turn.message.usage.input_tokens).toBe(inputBreakdown(turn.request).total + 286);
    expect(lesson.tokensNote).toBe('四轮请求的 usage.input_tokens 依次是 1,684、1,962、2,411、2,793，累计 8,850。');
    expect(factsOf(0).其中工具定义).toBe('1170 + 工具系统提示 286');
  });

  it('轨迹表的输入列：请求出去时还是上一轮的累计，响应回来才加上这一轮', () => {
    const rows = packetsOf(lesson).filter((packet) => packet.from === 'agent' && packet.to === 'llm').map((packet) => packet.row.tokens);
    expect(rows).toEqual([0, 1684, 3646, 6057]);
    const replies = packetsOf(lesson).filter((packet) => packet.from === 'llm').map((packet) => packet.row.tokens);
    expect(replies).toEqual(numbers.cumulative);
    expect(packetsOf(lesson).at(-1)!.row.tokens).toBe(8850);
  });

  it('费用：输入 $4 / MTok、输出 $20 / MTok（示例单价），四轮合计 $0.0476', () => {
    const nano = run.totals.input * 4000 + run.totals.output * 20000;
    expect(run.totals.cost).toBe(nano);
    expect(nano).toBe(47_620_000);
    expect(numbers.cost).toBe('$0.0476');
    expect(costOf(t1.message.usage, 'claude-opus-5-5').total).toBe(1684 * 4000 + 92 * 20000);
    expect([numbers.inputPrice, numbers.outputPrice]).toEqual(['$4 / MTok', '$20 / MTok']);
  });

  it('每轮重复带上的固定部分：system 141 + 工具定义 1170 + 工具系统提示 286 = 1597，占输入的 72.2%', () => {
    for (const turn of run.turns) {
      expect(turn.breakdown.system).toBe(141);
      expect(turn.breakdown.tools).toBe(1170);
    }
    expect(numbers.fixed).toBe(1597);
    expect((1597 * 4) / 8850).toBeCloseTo(0.7218, 4);
    expect(numbers.fixedShare).toBe('72.2%');
    expect(stepOf(4).detail).toContain('其中每轮都重复带上的 system、工具定义和工具系统提示（1,597 个）占了输入的 72.2%');
    expect(lesson.outro.text).toContain('是最后一轮的 3.2 倍');
    expect(8850 / 2793).toBeCloseTo(3.17, 2);
    expect(numbers.growth).toBe(2793 - 1684);
  });

  it('第一轮：想法 + tool_use，用户的话 66 字节', () => {
    expect(numbers.userBytes).toBe(utf8Encode(USER_ASK).length);
    expect(numbers.userBytes).toBe(66);
    expect(t1.message.content.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(stepOf(0).detail).toContain('模型先写一句想法「先查一下这个订单」，再写一个 tool_use 块，要求调用 get_order 查订单 A1024');
    expect(stepOf(0).detail).toContain('ReAct（Yao 等，ICLR 2023）');
  });

  it('第二步：参数按 input_schema 校验；订单 11 月 3 日签收', () => {
    expect(GET_ORDER.input_schema.properties!.order_id.pattern).toBe('^A\\d{4}$');
    expect(stepOf(1).detail).toContain('order_id 要匹配 A 加四位数字');
    expect(order).toMatchObject({ order_id: 'A1024', signed_at: '2026-11-03', amount: 129 });
    expect(factsOf(1).签收).toBe('2026-11-03（11 月 3 日）');
    // tool_result 的 tool_use_id 和 tool_use 的 id 一样。
    expect(t1.calls[0].result.tool_use_id).toBe(t1.calls[0].use.id);
  });

  it('第三步：BM25 前两段是《售后规则》第 3 条、第 2 条，第 3 条得分最高', () => {
    expect(hits.map((hit) => hit.id)).toEqual(['aftersale#3', 'aftersale#2']);
    expect(numbers.topScore).toBeCloseTo(4.224, 3);
    expect(factsOf(2).最相关).toBe('aftersale#3，4.22 分');
    expect(POLICIES.find((doc) => doc.id === 'aftersale#3')!.text.startsWith('《售后规则》第 3 条')).toBe(true);
    expect([numbers.queryTerms, numbers.policyDocs]).toEqual([6, 8]);
    expect(t2.request.messages).toHaveLength(3);
  });

  it('第四步：签收 3 天，工具自己算、自己把关；退货单 R20261106-001，退 129 元', () => {
    expect(daysBetween(order.signed_at!, TODAY)).toBe(3);
    expect(ticket).toMatchObject({ return_id: 'R20261106-001', refund: 129, shipping_paid_by: 'shop', days_since_signed: 3 });
    expect(shop.returns).toHaveLength(1);
    expect(stepOf(3).detail).toContain('模型读到「签收后 7 天内，质量问题可退款或换货」');
    expect(POLICIES.some((doc) => doc.text.includes('签收后 7 天内，质量问题可退款或换货'))).toBe(true);
    expect(stepOf(3).detail).toContain('算出从 11 月 3 日到今天（11 月 6 日）是 3 天');
    expect(t3.message.content[0]).toMatchObject({ type: 'text', text: '签收 3 天，在 7 天之内，杯盖漏水是质量问题，可以退款，运费由店铺承担。我来建退货单。' });
  });

  it('第五步：最后一轮只有文字，stop_reason end_turn；回答里的单号和金额来自工具结果', () => {
    expect(t4.message.content.map((block) => block.type)).toEqual(['text']);
    expect(t4.message.stop_reason).toBe('end_turn');
    expect(run.final).toContain(ticket.return_id);
    expect(run.final).toContain(`${ticket.refund} 元`);
    expect(stepOf(4).desc).toBe('stop_reason 是 end_turn，4 轮累计 8,850');
  });

  it('模型写的内容（响应体的 content、usage）标 E.G.；请求里的密钥打码', () => {
    const response = packetsOf(lesson).find((packet) => packet.from === 'llm')!;
    const body = response.wire.layers.find((layer) => layer.name.startsWith('响应体'))!;
    expect(body.fields.filter((field) => field.example).map((field) => field.name)).toEqual(expect.arrayContaining(['id', 'content', 'usage']));
    const request = packetsOf(lesson).find((packet) => packet.to === 'llm')!;
    expect(request.wire.layers[0].fields.find((field) => field.name === 'x-api-key')!.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 工具定义如何进入提示
// ---------------------------------------------------------------------------

describe('工具定义如何进入提示', () => {
  const td = LESSON_BY_ID.tooldefs;
  const N = TD.numbers;
  const step = (i: number) => td.steps[i];

  it('主运行就是 react 课那一次：4 轮，累计 8,850', () => {
    expect(N.inputs).toEqual(numbers.inputs);
    expect(N.totalInput).toBe(8850);
    expect(TD.run.turns.map((turn) => turn.request)).toEqual(run.turns.map((turn) => turn.request));
  });

  it('每个工具单独数：281、353、511，外壳 25，合计 1,170；描述和 schema 各占多少', () => {
    expect(N.perTool).toEqual([281, 353, 511]);
    expect(N.perDesc).toEqual([78, 71, 142]);
    expect(N.perSchema).toEqual([157, 231, 321]);
    expect(N.toolDefs).toBe(1170);
    expect(N.wrapper).toBe(25);
    // 单独数的这一行就是 toolsText 里的那一行；外壳是 # Tools、<tools> 标签和换行。
    const lines = toolsText(TD.defs).split('\n');
    expect(lines.slice(2, 5).map((line) => countTokens(line))).toEqual([281, 353, 511]);
    expect(countTokens(toolsText(TD.defs))).toBe(1170);
    expect(N.toolsBytes).toBe(encodeJson(TD.defs).bytes.length);
    expect(N.toolsBytes).toBe(1275);
    expect(step(0).detail).toContain('get_order 281、search_policy 353、create_return 511，加上 <tools> 外壳 25 个，一共 1,170');
    expect(step(0).detail).toContain('^[a-zA-Z0-9_-]{1,128}$');
  });

  it('工具定义在 system 这一轮的最前面；第一轮 1,684 里工具占 1,456（86.5%），system 141、用户 57、模板 30', () => {
    const prompt = renderRequest(TD.t1.request);
    expect(prompt.pieces.find((piece) => piece.kind === 'content')!.source).toBe('tools');
    expect([N.system, N.user, N.template, N.prompt1, N.toolSystem]).toEqual([141, 57, 30, 1398, 286]);
    expect(N.toolDefs + N.system + N.user + N.template).toBe(N.prompt1);
    expect(N.prompt1 + N.toolSystem).toBe(N.input1);
    expect(N.perRoundTools).toBe(1456);
    expect(N.share1).toBe('86.5%');
    expect(step(1).detail).toContain('是 system（141）的 8.3 倍');
    expect(step(1).detail).toContain('用户真正的问题只有 57 个');
  });

  it('4 轮里工具共 5,824，占 65.8%；多挂 issue_refund 每轮多 340，累计多 1,360', () => {
    expect(N.toolsAllRounds).toBe(1456 * 4);
    expect(N.toolsShare).toBe('65.8%');
    for (const turn of TD.run.turns) expect(turn.breakdown.tools + turn.toolSystem).toBe(1456);
    expect(N.refundTokens).toBe(countTokens(encodeJson({ name: ISSUE_REFUND.name, description: ISSUE_REFUND.description, input_schema: ISSUE_REFUND.input_schema }).text));
    expect([N.refundTokens, N.refundRound, N.fourDefs, N.fourTotal, N.fourExtra]).toEqual([339, 340, 1510, 10210, 1360]);
    expect(N.fourExtra).toBe(N.refundRound * 4);
    // 脚本没用到 issue_refund：调用和主运行一样。
    expect(TD.runFour.turns.flatMap((turn) => turn.calls.map((c) => c.use.name))).toEqual(['get_order', 'search_policy', 'create_return']);
    expect(step(2).detail).toContain('多出的 1,360 正好是 340 × 4 轮');
  });

  it('坏描述：定义 511 → 282，漏了 reason 被 schema 拒绝，多一轮，累计 10,583，多 1,733', () => {
    expect(TD.TERSE_RETURN.description).toBe('建退货单。');
    // 约束没变：required、enum 和好描述一样，只少了说明。
    expect(TD.TERSE_RETURN.input_schema.required).toEqual(CREATE_RETURN.input_schema.required);
    expect(TD.TERSE_RETURN.input_schema.properties!.reason.enum).toEqual(CREATE_RETURN.input_schema.properties!.reason.enum);
    expect(Object.values(TD.TERSE_RETURN.input_schema.properties!).every((prop) => prop.description === undefined)).toBe(true);
    expect([N.goodReturn, N.terseReturn, N.terseSaved]).toEqual([511, 282, 229]);
    const bad = TD.runTerse.turns[2].calls[0];
    expect(bad.result.is_error).toBe(true);
    expect(validate(CREATE_RETURN.input_schema, bad.use.input)).toEqual([{ path: 'reason', message: '缺少必填参数' }]);
    expect(N.badMessage).toBe('reason：缺少必填参数');
    expect(TD.runTerse.turns[3].calls[0].result.is_error).toBeUndefined();
    expect([N.terseTurns, N.terseTotal, N.terseExtra]).toEqual([5, 10583, 1733]);
    expect(step(3).detail).toContain('至少写 3–4 句');
    expect(step(3).detail).toContain('定义从 511 降到 282 个 token');
  });

  it('tool_choice：any 和 tool 在 Opus 5.5 上 400（文档原文），none 和 auto 输入一样', () => {
    expect(N.choiceErrors).toEqual([null, 400, 400, null]);
    expect(TD.choices[1].error!.message).toBe(DOCUMENTED_ERRORS.forcedToolChoice);
    expect(TD.choices[2].error!.message).toBe(DOCUMENTED_ERRORS.forcedToolChoice);
    expect(N.choiceInputs).toEqual([1684, null, null, 1684]);
    expect(step(4).detail).toContain('auto（带工具时的默认）');
    expect(step(4).detail).toContain('none 不许调用（没带工具时的默认）');
  });

  it('输入列：前三步到 8,850，第四步接着记坏描述那次运行，最后一步不增加', () => {
    const rows = packetsOf(td).map((packet) => packet.row.tokens);
    expect(Math.max(...rows)).toBe(8850 + 10583);
    expect(rows.at(-1)).toBe(8850 + 10583);
    expect(td.tokensNote).toContain('4 轮累计 8,850');
  });
});

// ---------------------------------------------------------------------------
// 并行工具调用与结果回填
// ---------------------------------------------------------------------------

describe('并行工具调用与结果回填', () => {
  const pa = LESSON_BY_ID.parallel;
  const N = PA.numbers;
  const step = (i: number) => pa.steps[i];

  it('第一轮两个 tool_use，之后一个、零个；3 轮停在 end_turn', () => {
    expect(N.calls).toEqual([2, 1, 0]);
    expect(PA.t1.message.content.map((block) => block.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(PA.t1.message.stop_reason).toBe('tool_use');
    expect(PA.run.stop).toBe('end_turn');
    expect(N.t1Output).toBe(211);
    expect(N.inputs[0]).toBe(numbers.inputs[0]);
  });

  it('两个 tool_result 在同一条 user 消息里，按 tool_use_id 一一对应，结果在最前面', () => {
    const msg = PA.resultMessage;
    expect(msg.role).toBe('user');
    const blocks = msg.content as Array<{ type: string; tool_use_id?: string }>;
    expect(blocks.map((block) => block.type)).toEqual(['tool_result', 'tool_result']);
    expect(blocks.map((block) => block.tool_use_id)).toEqual(PA.t1.calls.map((c) => c.use.id));
    expect(N.resultBlocks).toBe(2);
    expect(N.resultBytes).toBe(encodeJson(msg).bytes.length);
    expect(N.messagesPerTurn).toEqual([1, 3, 5]);
    expect(step(2).detail).toContain('历史现在是 3 条消息');
  });

  it('串行对照：disable_parallel_tool_use，每轮最多一个调用，就是 react 的四轮', () => {
    expect(PA.serial.turns[0].request.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(N.serialCalls).toEqual([1, 1, 1, 0]);
    expect(N.serialInputs).toEqual(numbers.inputs);
    expect(N.serialInput).toBe(8850);
  });

  it('并行 3 轮 6,784，串行 4 轮 8,850：少 2,066（23.3%），$0.0476 → $0.0387', () => {
    expect(N.inputs).toEqual([1684, 2359, 2741]);
    expect([N.totalInput, N.saved, N.savedShare]).toEqual([6784, 2066, '23.3%']);
    expect(N.totalInput).toBe(N.inputs.reduce((a, b) => a + b, 0));
    expect([N.serialCost, N.cost]).toEqual(['$0.0476', '$0.0387']);
    expect([N.totalOutput, N.serialOutput]).toEqual([577, 611]);
    expect(step(4).detail).toContain('少 2,066（23.3%）');
    expect(pa.overview.description).toContain('累计输入从 8,850 降到 6,784');
  });

  it('建单要等前两个结果；单号和金额来自工具结果', () => {
    expect(PA.t2.calls.map((c) => c.use.name)).toEqual(['create_return']);
    expect(PA.ticket).toMatchObject({ return_id: 'R20261106-001', refund: 129, days_since_signed: 3 });
    expect(PA.run.final).toContain('R20261106-001');
    expect(PA.hits[0].id).toBe('aftersale#3');
  });

  it('输入列只记并行那次运行', () => {
    expect(packetsOf(pa).at(-1)!.row.tokens).toBe(6784);
  });
});

// ---------------------------------------------------------------------------
// 工具报错、最大轮数与停止
// ---------------------------------------------------------------------------

describe('工具报错、最大轮数与停止', () => {
  const st = LESSON_BY_ID.stopping;
  const N = ST.numbers;
  const step = (i: number) => st.steps[i];

  it('A：订单号少了 A，被 schema 拒绝；改对再查（参数说明里写着「如 A1024」）', () => {
    expect(ST.runA.turns[0].calls[0].use.input).toEqual({ order_id: '1025' });
    expect(ST.idErrors).toEqual([{ path: 'order_id', message: '不匹配 ^A\\d{4}$' }]);
    expect(N.idMessage).toBe('参数不合格：order_id：不匹配 ^A\\d{4}$');
    expect(ST.runA.turns[1].calls[0].use.input).toEqual({ order_id: 'A1025' });
    expect(ST.order).toMatchObject({ order_id: 'A1025', signed_at: '2026-10-20' });
    expect(String(GET_ORDER.input_schema.properties!.order_id.description)).toContain('如 A1024');
  });

  it('A：无理由退货 17 天 > 7 天，工具回 is_error；模型改口，end_turn，4 轮 8,181', () => {
    expect(daysBetween('2026-10-20', TODAY)).toBe(17);
    expect(ST.fail).toEqual({ days: 17, limit: NO_REASON_RETURN_DAYS });
    expect(N.failMessage).toBe('订单 A1025 签收已 17 天，超过 7 天的退货期限');
    expect(N.errorsA).toEqual([1, 0, 1, 0]);
    expect(N.stopsA).toEqual(['tool_use', 'tool_use', 'tool_use', 'end_turn']);
    expect([N.turnsA, N.totalA]).toEqual([4, 8181]);
    expect(N.inputsA).toEqual([1688, 1872, 2179, 2442]);
    expect(ST.runA.final).toContain('17 天');
    expect(ST.runA.final).toContain('7 天');
    expect(step(1).detail).toContain('从 10 月 20 日到今天（11 月 6 日）是 17 天');
  });

  it('B：max_tokens 40，想法 20 token 写完，tool_use 要 71 写不下，stop_reason max_tokens，没有执行工具', () => {
    expect(ST.b1.request.max_tokens).toBe(40);
    expect([N.textTokens, N.toolUseTokens]).toEqual([20, 71]);
    expect(N.textTokens).toBeLessThanOrEqual(40);
    expect(N.textTokens + N.toolUseTokens).toBeGreaterThan(40);
    expect(ST.b1.message.stop_reason).toBe('max_tokens');
    expect([N.stopB, N.outB, N.callsB]).toEqual(['max_tokens', 20, 0]);
    expect(N.blocksB).toEqual(['text']);
    expect(step(3).detail).toContain('本站的 createMessage 把写不下的块整块丢掉（简化）');
  });

  it('C：每轮重试都超期，3 轮到了 maxTurns，stop 是 max_turns，历史停在 user 消息', () => {
    expect([N.cap, N.turnsC, N.stopC]).toEqual([3, 3, 'max_turns']);
    expect(N.stopsC).toEqual(['tool_use', 'tool_use', 'tool_use']);
    expect(N.errorsC).toEqual([1, 1, 1]);
    expect([N.lastRoleC, N.messagesC, N.totalC]).toEqual(['user', 7, 5701]);
    expect(step(4).detail).toContain('max_turns 不是 Messages API 的 stop_reason');
  });

  it('输入列三次运行接着累计：8,181 + 1,688 + 5,701 = 15,570', () => {
    expect(N.totalB).toBe(1688);
    expect(N.grand).toBe(8181 + 1688 + 5701);
    expect(packetsOf(st).at(-1)!.row.tokens).toBe(15570);
    expect(st.tokensNote).toContain('共 15,570');
  });
});

// ---------------------------------------------------------------------------
// 手写循环 vs SDK
// ---------------------------------------------------------------------------

describe('手写循环 vs SDK', () => {
  const sd = LESSON_BY_ID.sdks;
  const N = SD.numbers;
  const step = (i: number) => sd.steps[i];

  it('同一次运行：4 轮、3 次工具调用、8,850、$0.0476，4 个请求共 10,724 字节', () => {
    expect([N.turns, N.toolCalls, N.totalInput, N.cost, N.requests]).toEqual([4, 3, 8850, '$0.0476', 4]);
    expect(N.requestBytes).toBe(SD.run.turns.reduce((sum, turn) => sum + turn.http.request.bytes.length, 0));
    expect(N.requestBytes).toBe(10724);
    expect(SD.run.turns.map((turn) => turn.http.request.bytes)).toEqual(run.turns.map((turn) => turn.http.request.bytes));
  });

  it('Claude Agent SDK 的轮数：3 轮调用工具 + 1 轮回答 = num_turns 4；工具名 mcp__xiaopu__<tool>', () => {
    expect([N.toolTurns, N.finalTurns]).toEqual([3, 1]);
    expect(N.mcpNames).toEqual(['mcp__xiaopu__get_order', 'mcp__xiaopu__search_policy', 'mcp__xiaopu__create_return']);
    expect(step(2).detail).toContain('按同一个脚本是 3 轮调用工具加 1 轮回答，num_turns 是 4');
  });

  it('上限设成 3：第 3 轮的 create_return 执行了（建了退货单），没有回答，stop 是 max_turns', () => {
    expect([N.cappedStop, N.cappedTurns, N.cappedReturns, N.cappedReturnId, N.cappedLastRole]).toEqual(['max_turns', 3, 1, 'R20261106-001', 'user']);
    expect(N.cappedInput).toBe(numbers.cumulative[2]);
  });

  it('默认上限只写核对过的：本站 10、Claude Agent SDK 不限、OpenAI 10、create_agent 9,999；代码片段都是示意', () => {
    expect(N.maxTurns).toBe(10);
    const facts = Object.fromEntries(sd.outro.facts);
    expect(facts['Claude Agent SDK']).toBe('max_turns 不限');
    expect(facts['OpenAI Agents SDK']).toBe('max_turns 10');
    expect(step(4).detail).toContain('create_agent 设的 9,999');
    expect(step(4).detail).toContain('super-step');
    for (const packet of packetsOf(sd).filter((p) => p.from === 'app')) expect(packet.wire.fidelity).toBe('示意');
  });

  it('输入列：第一步到 8,850，之后不再增加', () => {
    const rows = packetsOf(sd).map((packet) => packet.row.tokens);
    expect(Math.max(...rows)).toBe(8850);
    expect(rows.at(-1)).toBe(8850);
  });
});
