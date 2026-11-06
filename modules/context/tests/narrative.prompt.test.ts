/**
 * 文案和计算结果对得上（提示组：template、fewshot、structured、toolcall、caching）。
 * 课程文案里的数字尽量从计算结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于独立算出的结果（防止取错字段），关键的数写死在这里，改了输入会立刻报错；
 * 2. 文字里没法取值的说法，比如「特殊 token 的字面文字按普通字节编码」「读取是 0.05 倍」「tool_use_id 对不上会 400」。
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  CACHE_READ,
  CACHE_WRITE_1H,
  CACHE_WRITE_5M,
  encodeSafely,
  costOf,
  DOCUMENTED_ERRORS,
  encodeText,
  encodeWithSpecials,
  formatUsd,
  inputBreakdown,
  isSpecial,
  MODELS,
  PRICES,
  validateRequest,
} from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import * as caching from '../src/lessons/caching';
import * as fewshot from '../src/lessons/fewshot';
import * as structured from '../src/lessons/structured';
import * as template from '../src/lessons/template';
import * as toolcall from '../src/lessons/toolcall';

const enc = (text: string) => utf8Encode(text).length;
const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);

describe('template：system、角色和约束如何经 chat template 变成 token 序列', () => {
  const N = template.numbers;
  const lesson = LESSON_BY_ID.template;

  it('展开后的文本就是 ChatML：每轮 <|im_start|>角色↵内容<|im_end|>↵，末尾是生成提示', () => {
    const expected = [
      `<|im_start|>system\n${template.SYSTEM}<|im_end|>\n`,
      '<|im_start|>user\n什么是 token？<|im_end|>\n',
      `<|im_start|>assistant\n${template.ASSISTANT_TURN}<|im_end|>\n`,
      '<|im_start|>user\n一句话说说为什么要切开？<|im_end|>\n',
      '<|im_start|>assistant\n',
    ].join('');
    expect(template.prompt.text).toBe(expected);
    expect(N.textBytes).toBe(enc(expected));
    expect(N.textBytes).toBe(291);
    expect(lesson.steps[1].desc).toBe('4 轮 + 生成提示，291 字节');
  });

  it('input = 整段编码的长度 = 各来源之和 + 模板；每个 token 都有归属', () => {
    expect(N.input).toBe(encodeWithSpecials(template.prompt.text).length);
    expect([N.input, N.system, ...N.messages, N.template]).toEqual([158, 37, 13, 30, 30, 48]);
    expect(N.system + N.messages.reduce((a, b) => a + b, 0) + N.template).toBe(N.input);
    expect(template.segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(N.input);
    expect(template.turnStats.reduce((sum, stat) => sum + stat.total, 0) + N.generation).toBe(N.input);
    expect(lesson.steps[2].desc).toBe('158 个 token = 内容 110 + 模板 48');
    expect(lesson.steps[3].desc).toBe('48 个 token（30%）不是你写的');
  });

  it('特殊 token：每轮 2 个，加生成提示 1 个，共 9 个；id 是 353、354', () => {
    expect(N.specials).toBe(2 * 4 + 1);
    expect(template.prompt.ids.filter((id) => id === 353)).toHaveLength(5);
    expect(template.prompt.ids.filter((id) => id === 354)).toHaveLength(4);
    expect(lesson.overview.facts.find(([key]) => key === '特殊 token')![1]).toBe('9 个：每轮 2 个，加生成提示 1 个');
  });

  it('「迷你词表里没有 system、assistant 这些词，要拆成好几个 token」，所以模板开销比真实模型大', () => {
    for (const word of ['system', 'user', 'assistant']) expect(encodeText(word).length, word).toBeGreaterThan(1);
    expect(template.turnStats.map((stat) => stat.overhead)).toEqual([10, 7, 13, 7]);
    expect(N.generation).toBe(11);
    expect(lesson.steps[3].detail).toContain('system 轮 10 个，user 轮 7 个，assistant 轮 13 个，末尾的生成提示 11 个');
  });

  it('安全编码和 renderChatML 在没有伪造时完全一致', () => {
    expect(encodeSafely(template.prompt).ids).toEqual(template.prompt.ids);
    // 伪造的输入：template 用的 safeIds 就是 core 按段编码的结果。
    expect(template.safeIds).toEqual(encodeSafely(template.naive).ids);
  });

  it('伪造边界：用户文字里的特殊 token 字面文字，按普通文本编码不是特殊 token，拼成字符串再编码就是', () => {
    const f = N.forged;
    expect(encodeText(template.FORGED).some(isSpecial)).toBe(false);
    expect(encodeWithSpecials(template.FORGED).filter(isSpecial)).toHaveLength(3);
    expect([f.plain, f.parsed, f.plainSpecial, f.parsedSpecial]).toEqual([79, 55, 0, 3]);
    // 安全：只有模板的 2 + 2 + 1 = 5 个；拼字符串：再多出用户写的 3 个。
    expect([f.safeSpecial, f.naiveSpecial]).toEqual([5, 8]);
    expect(f.naiveSpecial - f.safeSpecial).toBe(3);
    expect(f.naiveSpecial).toBe(template.naive.ids.filter(isSpecial).length);
    expect([f.safeTotal, f.naiveTotal]).toEqual([144, 120]);
    // 特殊 token 把好几个字节压成 1 个，所以被伪造时 token 更少。
    expect(f.naiveTotal).toBeLessThan(f.safeTotal);
    expect(lesson.steps[4].desc).toBe('特殊 token 5 个，不是 8 个');
    expect(lesson.steps[4].detail).toContain('（上面是 8 个）');
    expect(lesson.steps[4].detail).toContain('（5 个）');
    expect(factsOf('template', 4).累计输入).toBe(`${158 + 144} token`);
  });

  it('第 5 步最后一个事件的累计 token = 两个请求的输入之和', () => {
    const rows = lesson.steps.flatMap((step) => step.events.flatMap((event) => (event.type === 'packet' ? [event.row.tokens] : [])));
    expect(rows[rows.length - 1]).toBe(158 + 144);
  });
});

describe('fewshot：zero-shot / few-shot / CoT 对比', () => {
  const N = fewshot.numbers;
  const lesson = LESSON_BY_ID.fewshot;
  const price = PRICES['claude-opus-5-5'];

  it('输入 token：和独立展开的结果一致', () => {
    for (const variant of fewshot.VARIANTS) expect(fewshot.result[variant].input).toBe(inputBreakdown(fewshot.REQUESTS[variant]).total);
    expect([N.zero.input, N.few.input, N.cot.input]).toEqual([112, 355, 167]);
    expect(N.fewExtraInput).toBe(243);
    expect(N.cotExtraInput).toBe(55);
    expect(N.fewInline).toBe(304);
    expect(lesson.steps[1].desc).toBe('输入 112 + 输出 103 token，$0.00251');
    expect(lesson.steps[2].desc).toBe('输入涨到 355，输出只剩 5');
    expect(lesson.steps[3].desc).toBe('输入只多 55，输出涨到 143');
  });

  it('few-shot：示例是 3 组问答，请求有 7 条 messages，每一轮都付模板开销；示例写进一条消息更省', () => {
    expect(fewshot.REQUESTS.few.messages).toHaveLength(1 + fewshot.EXAMPLES.length * 2);
    expect(N.few.messages).toBe(7);
    expect(N.fewInline).toBeLessThan(N.few.input);
    expect(fewshot.result.few.breakdown.template).toBeGreaterThan(fewshot.result.zero.breakdown.template);
    expect(lesson.steps[2].detail).toContain(`比分轮写少 ${355 - 304} 个`);
  });

  it('输出 token：示例回复按文本真实计数；few 最短、CoT 最长', () => {
    for (const variant of fewshot.VARIANTS) expect(fewshot.result[variant].output).toBe(encodeText((fewshot.REPLIES[variant][0] as { text: string }).text).length);
    expect([N.zero.output, N.few.output, N.cot.output]).toEqual([103, 5, 143]);
    expect(N.few.output).toBeLessThan(N.zero.output);
    expect(N.zero.output).toBeLessThan(N.cot.output);
    // CoT 的输入只比 zero 多一句话，输出多得多：「用输出 token 换推理步骤」。
    expect(N.cot.output - N.zero.output).toBeGreaterThan(N.cotExtraInput / 2);
    // few-shot 的输入多得多，输出更短：「用输入 token 换格式」。
    expect(N.fewExtraInput).toBeGreaterThan(N.zero.output - N.few.output);
  });

  it('成本：输入 $4、输出 $20（每百万 token），输出单价是输入的 5 倍', () => {
    expect(N.zero.cost).toBe(112 * 4000 + 103 * 20000);
    expect(N.few.cost).toBe(355 * 4000 + 5 * 20000);
    expect(N.cot.cost).toBe(167 * 4000 + 143 * 20000);
    expect(price.output / price.input).toBe(5);
    expect([formatUsd(N.zero.cost), formatUsd(N.few.cost), formatUsd(N.cot.cost)]).toEqual(['$0.00251', '$0.00152', '$0.00353']);
    expect(N.cheapest).toBe('few');
    expect(N.priciest).toBe('cot');
    expect(lesson.steps[4].desc).toBe('few-shot 最省，CoT 最贵');
    expect(lesson.steps[4].detail).toContain('zero-shot $0.00251，few-shot $0.00152，CoT $0.00353');
    // 文案里「不是示例总是更贵」：这里 few-shot 的输入多了 243 个，总成本反而最低。
    expect(N.few.cost).toBeLessThan(N.zero.cost);
  });

  it('累计 token 是三次「输入 + 输出」的和', () => {
    expect(N.running).toEqual([215, 575, 885]);
    expect(N.total).toBe(112 + 103 + 355 + 5 + 167 + 143);
    expect(lesson.outro.desc).toBe('累计 885 个 token');
  });
});

describe('structured：结构化输出（API 层）', () => {
  const N = structured.numbers;
  const lesson = LESSON_BY_ID.structured;

  it('请求字节：Anthropic 的 output_config.format 把 schema 放进请求体', () => {
    expect(N.body).toBe(enc(JSON.stringify(structured.REQUEST)));
    expect(N.plainBody).toBe(193);
    expect(N.body).toBe(476);
    expect(N.http).toBe(736);
    expect(N.schemaJson).toBe(enc(JSON.stringify(structured.SCHEMA)));
    expect(N.schemaJson).toBe(223);
    // output_config 的值是 {"format":{"type":"json_schema","schema":…}}，比 schema 多 34 个字节，加上键和逗号就是体积的增量。
    expect(N.schemaBytes).toBe(enc(JSON.stringify(structured.REQUEST.output_config)));
    expect(N.schemaBytes).toBe(N.schemaJson + enc('{"format":{"type":"json_schema","schema":}}'));
    expect(N.body - N.plainBody).toBe(enc(',"output_config":') + N.schemaBytes);
    expect(lesson.steps[1].desc).toBe('schema 占 266 字节，请求 736 字节');
    expect(lesson.steps[1].detail).toContain('193 字节涨到 476 字节');
  });

  it('OpenAI 的写法：response_format 里嵌一层 json_schema，带 name 和 strict', () => {
    const format = structured.OPENAI_REQUEST.response_format;
    expect(Object.keys(format)).toEqual(['type', 'json_schema']);
    expect(Object.keys(format.json_schema)).toEqual(['name', 'strict', 'schema']);
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema).toBe(structured.SCHEMA);
    expect(N.openaiHttp).toBe(736);
    expect(lesson.steps[2].desc).toBe('嵌一层 json_schema，请求 736 字节');
    // 每个对象都 additionalProperties: false，所有字段都必填（Anthropic 文档要求前者，OpenAI 文档示例都这样写）。
    expect(structured.SCHEMA.additionalProperties).toBe(false);
    expect([...structured.SCHEMA.required].sort()).toEqual(Object.keys(structured.SCHEMA.properties).sort());
  });

  it('响应：text 块里是 JSON 字符串，引号被转义，所以比原文多 10 字节', () => {
    expect(structured.message.content).toEqual([{ type: 'text', text: '{"order_id":"A1024","intent":"改期","urgent":true}' }]);
    expect(N.outputBytes).toBe(enc('{"order_id":"A1024","intent":"改期","urgent":true}'));
    expect(N.outputBytes).toBe(52);
    // 5 对引号（order_id、A1024、intent、改期、urgent 各一对）每个引号多一个反斜杠 = 10。
    expect(N.escapeExtra).toBe(10);
    expect(N.textEncoded).toBe(2 + 52 + 10);
    expect(N.response).toBe(609);
    expect([N.input, N.output]).toEqual([115, 49]);
    expect(lesson.steps[3].desc).toBe('输入 115 + 输出 49 token，响应 609 字节');
    expect(lesson.steps[3].detail).toContain('占 64 字节，比原文 52 字节多出 10 字节转义');
  });

  it('客户端校验：带 schema 的通过；max_tokens 截断解析失败；围栏解析失败；值不符校验失败', () => {
    const [ok, cut, fence, wrong] = structured.checks;
    expect([ok.ok, cut.ok, fence.ok, wrong.ok]).toEqual([true, false, false, false]);
    expect(cut.stop).toBe('max_tokens');
    expect(cut.parsed).toBe(false);
    expect(() => JSON.parse(cut.text)).toThrow();
    expect(() => JSON.parse(fence.text)).toThrow();
    expect(fence.text).toContain('```json');
    expect(wrong.parsed).toBe(true);
    expect(wrong.errors).toHaveLength(2);
    expect(structured.truncated.stop_reason).toBe('max_tokens');
    expect(structured.truncated.usage.output_tokens).toBe(structured.TRUNCATED_LIMIT);
    expect(structured.TRUNCATED_LIMIT).toBe(29);
    expect(lesson.steps[4].desc).toBe('4 种结果，只有 1 种能直接用');
    expect(lesson.steps[4].detail).toContain('压到 29');
  });

  it('validate：type、enum、required、additionalProperties', () => {
    const schema = structured.SCHEMA;
    expect(structured.validate(schema, { order_id: 'A1', intent: '退货', urgent: false })).toEqual([]);
    expect(structured.validate(schema, { order_id: 'A1', intent: '换货', urgent: false })).toHaveLength(1);
    expect(structured.validate(schema, { order_id: 'A1', intent: '退货' })).toEqual(['$.urgent: 缺少必填字段']);
    expect(structured.validate(schema, { order_id: 'A1', intent: '退货', urgent: false, extra: 1 })).toEqual(['$.extra: schema 里没有这个字段']);
    expect(structured.validate(schema, { order_id: 1, intent: '退货', urgent: false })).toEqual(['$.order_id: 应是 string，实际是 number']);
    expect(structured.validate(schema, [])).toEqual(['$: 应是 object，实际是 array']);
  });

  it('token 累计：输入 + 输出', () => {
    expect(N.total).toBe(164);
    expect(structured.message.usage.input_tokens).toBe(inputBreakdown(structured.REQUEST).total);
    // 本站的 token 数不含 schema（文案里这样说）。
    expect(inputBreakdown({ ...structured.REQUEST, output_config: undefined } as never).total).toBe(N.input);
    expect(lesson.steps[3].detail).toContain('本站的 token 数不含 schema');
  });
});

describe('toolcall：函数调用的一个往返', () => {
  const N = toolcall.numbers;
  const lesson = LESSON_BY_ID.toolcall;
  const model = MODELS['claude-opus-5-5'];

  it('工具系统提示：Opus 5.5 是 286 个 token，计入 input_tokens', () => {
    expect(model.toolSystemTokens).toBe(286);
    expect(N.toolSystem).toBe(286);
    expect(toolcall.breakdown1.total).toBe(301);
    expect(toolcall.message1.usage.input_tokens).toBe(301 + 286);
    expect(toolcall.message2.usage.input_tokens).toBe(509 + 286);
    expect([N.input1, N.input2]).toEqual([587, 795]);
    expect(lesson.steps[1].desc).toBe('stop_reason 是 tool_use，输入 587 个 token');
    expect(factsOf('toolcall', 1).input_tokens).toBe('301 + 286 = 587');
    expect(factsOf('toolcall', 3).input_tokens).toBe('509 + 286 = 795');
  });

  it('工具定义占 token：展开后 tools 在 system 那一轮最前面', () => {
    expect(N.toolsTokens).toBe(214);
    expect(toolcall.breakdown1.prompt.text).toContain('# Tools\n<tools>');
    expect(toolcall.breakdown1.prompt.text.indexOf('# Tools')).toBeLessThan(toolcall.breakdown1.prompt.text.indexOf(toolcall.SYSTEM));
    expect([N.toolsTokens, N.systemTokens, N.userTokens, N.template1]).toEqual([214, 32, 25, 30]);
    expect(N.toolsTokens + N.systemTokens + N.userTokens + N.template1).toBe(301);
  });

  it('第一次响应：tool_use，stop_reason 是 tool_use；id 以 toolu_ 开头', () => {
    expect(toolcall.message1.stop_reason).toBe('tool_use');
    expect(toolcall.message1.content.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(toolcall.TOOL_USE.id).toMatch(/^toolu_01/);
    expect(N.out1).toBe(101);
    expect(N.resp1).toBe(691);
    expect(toolcall.message2.stop_reason).toBe('end_turn');
    expect(N.out2).toBe(62);
  });

  it('工具是真执行的：按 name 找函数、用 input 作参数；找不到订单时是 is_error', () => {
    expect(toolcall.runTool('get_order_status', { order_id: 'A1024' })).toEqual({ content: '{"status":"运输中","carrier":"顺丰","eta":"明天送达"}' });
    expect(N.result).toBe('{"status":"运输中","carrier":"顺丰","eta":"明天送达"}');
    expect(toolcall.runTool('get_order_status', { order_id: 'B9' }).is_error).toBe(true);
    expect(toolcall.runTool('nope', {}).is_error).toBe(true);
    expect(lesson.steps[2].desc).toBe(`真的执行 get_order_status，得到 ${N.result.length} 个字符的结果`);
  });

  it('第二次请求：tool_result 的 tool_use_id 对应上一条 assistant 里的 tool_use；对不上是 400', () => {
    expect(validateRequest(toolcall.REQUEST_2)).toBeNull();
    const result = (toolcall.REQUEST_2.messages[2].content as Array<{ tool_use_id: string }>)[0];
    expect(result.tool_use_id).toBe(toolcall.TOOL_USE.id);
    expect(toolcall.mismatch?.status).toBe(400);
    expect(toolcall.mismatch?.message).toContain('unexpected `tool_use_id`');
    expect(toolcall.REQUEST_2.messages).toHaveLength(3);
    expect(N.http1).toBe(647);
    expect(N.http2).toBe(1034);
    expect(lesson.steps[3].desc).toBe('第二次请求 1034 字节，输入 795 个 token');
    expect(lesson.steps[3].detail).toContain('比第一次多了 208');
  });

  it('Opus 5.5 不支持强制调用：tool_choice 为 any / tool 返回 400', () => {
    expect(model.forcedToolChoice).toBe(false);
    expect(validateRequest({ ...toolcall.REQUEST_1, tool_choice: { type: 'any' } })?.message).toBe(DOCUMENTED_ERRORS.forcedToolChoice);
    expect(validateRequest({ ...toolcall.REQUEST_1, tool_choice: { type: 'auto' } })).toBeNull();
    expect(lesson.steps[0].detail).toContain('tool_choice 为 any 或 tool 会返回 400');
  });

  it('费用：两次输入 + 两次输出，按示例单价', () => {
    expect(N.cost1).toBe(587 * 4000 + 101 * 20000);
    expect(N.cost2).toBe(795 * 4000 + 62 * 20000);
    expect(N.costAll).toBe(N.cost1 + N.cost2);
    expect(formatUsd(N.costAll)).toBe('$0.00879');
    expect(lesson.steps[5].desc).toBe('输入 587 + 795，输出 101 + 62，$0.00879');
    // 累计：587 + 101 + 795 + 62。
    expect(N.total).toBe(1545);
    expect(costOf(toolcall.message1.usage, 'claude-opus-5-5').total).toBe(N.cost1);
  });

  it('请求体里 tools 的字节数', () => {
    // 字段的字节区间从键的引号到值的末尾："tools": 加上数组。
    expect(N.toolsBytes).toBe(enc('"tools":') + enc(JSON.stringify(toolcall.TOOLS)));
    expect(N.toolsBytes).toBe(226);
    expect(lesson.steps[0].desc).toBe('tools 占 226 字节，整个请求 647 字节');
  });
});

describe('caching：Prompt Caching 在 API 层', () => {
  const N = caching.numbers;
  const lesson = LESSON_BY_ID.caching;
  const price = PRICES['claude-opus-5-5'];

  it('倍率：写 1.25 / 2，读 0.05（Opus 5.5）', () => {
    expect(CACHE_WRITE_5M).toBe(1.25);
    expect(CACHE_WRITE_1H).toBe(2);
    expect(CACHE_READ['claude-opus-5-5']).toBe(0.05);
    expect(CACHE_READ['claude-sonnet-5-5']).toBe(0.05);
    expect(CACHE_READ['claude-haiku-5-5']).toBe(0.1);
    expect(price.write5m / price.input).toBe(1.25);
    expect(price.write1h / price.input).toBe(2);
    expect(price.read / price.input).toBe(0.05);
    expect(lesson.steps[2].title).toBe('第二次：命中，只收 0.05 倍');
  });

  it('前缀 674 token，超过最小可缓存长度 512', () => {
    expect(N.prefix).toBe(674);
    expect(N.min).toBe(512);
    expect(MODELS['claude-opus-5-5'].cacheMin).toBe(512);
    expect(N.prefix).toBeGreaterThan(N.min);
    expect(lesson.steps[0].desc).toBe('前缀 674 token，断点在 system 的最后一块');
  });

  it('第一次：写入 674，没有读；全部输入 = 写 + 读 + 未缓存', () => {
    expect(N.r1).toMatchObject({ write: 674, read: 0, input: 50, total: 724 });
    expect(N.r1.write + N.r1.read + N.r1.input).toBe(N.r1.total);
    expect(N.r1.total).toBe(inputBreakdown(caching.REQUESTS.r1).total);
    expect(N.r1.cost).toBe(50 * 4000 + 674 * 5000 + 62 * 20000);
    expect(lesson.steps[1].desc).toBe('写入 674，按 1.25 倍计费');
  });

  it('第二次：前缀逐字节相同，命中 674 个 token，只收 0.05 倍', () => {
    expect(caching.REQUESTS.r1.system).toEqual(caching.REQUESTS.r2.system);
    expect(N.hashSame).toBe(true);
    expect(N.r2).toMatchObject({ write: 0, read: 674, input: 50, total: 724 });
    expect(N.r2.cost).toBe(50 * 4000 + 674 * 200 + 64 * 20000);
    expect(N.read).toBe(674 * 200);
    expect(formatUsd(N.r2.cost)).toBe('$0.00161');
    expect(lesson.steps[2].desc).toBe('一分钟后，读 674 token，$0.00161');
    // 命中比不用缓存便宜得多：输入部分只有 1/20。
    expect(N.r2.cost).toBeLessThan(N.r2.plain / 2);
  });

  it('改了前缀一个字符：哈希变了，没有命中，重新写入全部 674', () => {
    expect(caching.POLICY_EDITED).not.toBe(caching.POLICY);
    expect(caching.POLICY.length).toBe(caching.POLICY_EDITED.length);
    const diff = [...caching.POLICY].filter((char, index) => char !== caching.POLICY_EDITED[index]);
    expect(diff).toEqual(['7']);
    expect(N.hashChanged).toBe(true);
    expect(N.r3).toMatchObject({ write: 674, read: 0, input: 50 });
    // 旧的条目还在：现在缓存里有 2 个条目。
    expect(N.entries).toBe(2);
    expect(lesson.steps[3].desc).toBe('7 天改成 8 天，哈希变了，重新写入 674');
  });

  it('太短不缓存：前缀 27 token < 512，读写都是 0，不报错；过期要重写', () => {
    expect(N.short).toMatchObject({ prefix: 27, write: 0, read: 0, tooShort: 1, total: 77 });
    expect(N.short.prefix).toBeLessThan(N.min);
    // 请求 4 在请求 3 之后 5 分钟又 1 秒：过期，重写。
    expect(caching.TIMES.r4 - caching.TIMES.r3).toBe(301);
    expect(N.r4).toMatchObject({ expired: 1, write: 674, read: 0 });
    expect(lesson.steps[4].detail).toContain('（t = 421 s）');
    expect(lesson.steps[4].detail).toContain('写入是基础价的 2 倍');
    expect(N.write1h).toBe(674 * 8000);
    expect(N.write5m).toBe(674 * 5000);
    expect(formatUsd(N.write1h)).toBe('$0.00539');
    expect(formatUsd(N.write5m)).toBe('$0.00337');
  });

  it('三次请求的账单：有缓存 vs 无缓存，真实合计', () => {
    expect(N.costCached).toBe(N.r1.cost + N.r2.cost + N.r3.cost);
    expect(N.costPlain).toBe(N.r1.plain + N.r2.plain + N.r3.plain);
    expect(N.costCached).toBe(4810000 + 1614800 + 4810000);
    expect(N.costPlain).toBe(4136000 + 4176000 + 4136000);
    expect([formatUsd(N.costCached), formatUsd(N.costPlain)]).toEqual(['$0.0112', '$0.0124']);
    expect(N.savedPct).toBe(10);
    // 请求 3 如果没改字，就是命中：三次合计 36% 的节省。
    expect(N.unchanged3.read).toBe(674);
    expect(N.savedUnchangedPct).toBe(36);
    expect(lesson.steps[5].detail).toContain('只省了 10%');
    expect(lesson.steps[5].detail).toContain('省 36%');
    expect(lesson.steps[5].desc).toBe('有缓存 $0.0112，无缓存 $0.0124');
  });

  it('「写一次、读一次就回本」：1.25 + 0.05 < 2 × 1', () => {
    expect(CACHE_WRITE_5M + CACHE_READ['claude-opus-5-5']).toBeLessThan(2);
    expect(lesson.steps[5].detail).toContain('只要再用一次就回本');
  });

  it('累计 token：五次请求的输入 + 输出', () => {
    expect(N.total).toBe(724 + 62 + 724 + 64 + 724 + 62);
    expect(N.totalAll).toBe(N.total + 77 + caching.runs.short.output + 724 + caching.runs.r4.output);
  });
});
