/**
 * 提示组第三课：结构化输出（API 层）。请求里带 JSON schema：Anthropic 用 output_config.format，OpenAI Chat Completions 用
 * response_format 的 json_schema（strict）。请求字节、响应字节、客户端校验都真实执行：schema 用本文件的 validate 真实校验，
 * 被 max_tokens 截断的输出由 createMessage 真实截断。模型写出的 JSON 内容是示例（E.G.）。
 * 和 LLM EXPLORER 的 constrained 课呼应：那里讲引擎里逐步掩码，这里讲 API 层怎么用。tests/narrative.prompt.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  childrenOf,
  createMessage,
  encodeJson,
  encodeRequest,
  encodeResponse,
  EXAMPLE_EPOCH,
  exampleId,
  httpDate,
  inputBreakdown,
  messagesHttpRequest,
  messagesHttpResponse,
  MODELS,
  PROVIDERS,
  providerRequest,
  spanOf,
  toChatCompletions,
  type ContentBlock,
  type MessagesRequest,
} from '../core';
import { concept, httpHead, jsonBody, promptPieces, utf8Lines, wire } from '../decode/structures';
import { note, pk, show, state } from './dsl';
import type { DsCell, Lesson, RowPrim } from './types';

export const MODEL = 'claude-opus-5-5';
export const SYSTEM = '从客服消息里提取订单信息。';
export const TEXT = '订单 A1024 能不能改到下周三送？特别急。';

/** 应用写的 JSON Schema。结构化输出要求每个对象都写 additionalProperties: false。 */
export const SCHEMA = {
  type: 'object',
  properties: {
    order_id: { type: 'string' },
    intent: { type: 'string', enum: ['改期', '退货', '查询'] },
    urgent: { type: 'boolean' },
  },
  required: ['order_id', 'intent', 'urgent'],
  additionalProperties: false,
} as const;

export type StructuredRequest = MessagesRequest & { output_config: { format: { type: 'json_schema'; schema: typeof SCHEMA } } };

export const REQUEST: StructuredRequest = {
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  messages: [{ role: 'user', content: TEXT }],
  output_config: { format: { type: 'json_schema', schema: SCHEMA } },
};

/** OpenAI Chat Completions 的写法：response_format 里嵌一层 json_schema，带 name 和 strict。 */
export const OPENAI_MODEL = PROVIDERS.openai.model;
export const OPENAI_REQUEST = {
  ...toChatCompletions(REQUEST, OPENAI_MODEL),
  response_format: { type: 'json_schema', json_schema: { name: 'order_info', strict: true, schema: SCHEMA } },
};
const OPENAI_KEY = `sk-proj-${'x'.repeat(48)}`;

/** 模型写出的结构化结果（示例）：服务端保证它符合 schema，内容是示例。 */
export const OUTPUT = { order_id: 'A1024', intent: '改期', urgent: true };
export const OUTPUT_TEXT = encodeJson(OUTPUT).text;
export const REPLY: ContentBlock[] = [{ type: 'text', text: OUTPUT_TEXT }];

export const ids = { req: exampleId('req', 31), msg: exampleId('msg', 31) };
const date = httpDate(EXAMPLE_EPOCH);

export const body = encodeJson(REQUEST);
export const http = encodeRequest(messagesHttpRequest(REQUEST));
export const openaiBody = encodeJson(OPENAI_REQUEST);
export const openaiHttp = encodeRequest(providerRequest(PROVIDERS.openai, 'chat', OPENAI_REQUEST, OPENAI_KEY));
export const breakdown = inputBreakdown(REQUEST);
export const message = createMessage(REQUEST, REPLY, { id: ids.msg });
export const responseJson = encodeJson(message);
export const httpResponse = encodeResponse(messagesHttpResponse(message, { requestId: ids.req, date }));
export const schemaJson = encodeJson(SCHEMA);

// ---------- 客户端校验：一个够用的 JSON Schema 校验器 ----------

type Schema = { type?: string; enum?: readonly unknown[]; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; items?: Schema };

/** 校验 type、enum、required、additionalProperties、嵌套的 properties 和 items，返回每一处不符合的说明。 */
export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const ok = schema.type === 'integer' ? Number.isInteger(value) : schema.type === kind;
    if (!ok) return [`${path}: 应是 ${schema.type}，实际是 ${kind}`];
  }
  if (schema.enum && !schema.enum.some((item) => item === value)) errors.push(`${path}: ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)} 里`);
  if (kind === 'object' && schema.properties) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: 缺少必填字段`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties[key]) errors.push(...validate(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: schema 里没有这个字段`);
    }
  }
  if (kind === 'array' && schema.items) (value as unknown[]).forEach((item, index) => errors.push(...validate(schema.items!, item, `${path}[${index}]`)));
  return errors;
}

export interface Check {
  name: string;
  text: string;
  stop: string;
  parsed: boolean;
  errors: string[];
  ok: boolean;
}

function check(name: string, text: string, stop: string): Check {
  let parsed = false;
  let errors: string[] = [];
  try {
    errors = validate(SCHEMA, JSON.parse(text));
    parsed = true;
  } catch {
    errors = ['JSON.parse 失败：不是合法的 JSON'];
  }
  return { name, text, stop, parsed, errors, ok: parsed && !errors.length };
}

/** 同一个请求，max_tokens 只给一半：输出被截断，stop_reason 是 max_tokens。 */
const outTokens = message.usage.output_tokens;
export const TRUNCATED_LIMIT = Math.floor(outTokens * 0.6);
export const truncated = createMessage({ ...REQUEST, max_tokens: TRUNCATED_LIMIT }, REPLY, { id: exampleId('msg', 32) });
/** 只靠提示词要求「输出 JSON」（没有 schema 约束）时模型可能写出的样子（示例）。 */
export const PROSE = `好的，结果如下：\n\`\`\`json\n${OUTPUT_TEXT}\n\`\`\``;
export const WRONG = '{"order_id":"A1024","intent":"change","urgent":"yes"}';

export const checks: Check[] = [
  check('带 schema 的响应', (message.content[0] as { text: string }).text, message.stop_reason),
  check('max_tokens 截断', (truncated.content[0] as { text: string }).text, truncated.stop_reason),
  check('只靠提示词：多了说明和围栏', PROSE, 'end_turn'),
  check('只靠提示词：值不符合', WRONG, 'end_turn'),
];

// ---------- 数字 ----------

const { output_config: _unused, ...PLAIN } = REQUEST;
export const plainBody = encodeJson(PLAIN);
const schemaBytes = spanOf(body, 'output_config').to - spanOf(body, 'output_config').valueFrom;
const textSpan = spanOf(responseJson, 'content[0].text');
const textEncoded = textSpan.to - textSpan.valueFrom;
const outputBytes = utf8Encode(OUTPUT_TEXT).length;
const input = message.usage.input_tokens;
const output = message.usage.output_tokens;

export const numbers = {
  schemaBytes,
  schemaJson: schemaJson.bytes.length,
  body: body.bytes.length,
  plainBody: plainBody.bytes.length,
  http: http.bytes.length,
  openaiBody: openaiBody.bytes.length,
  openaiHttp: openaiHttp.bytes.length,
  openaiFormat: spanOf(openaiBody, 'response_format').to - spanOf(openaiBody, 'response_format').valueFrom,
  input,
  output,
  outputBytes,
  /** content[0].text 在响应里的字节数（带引号、转义）。 */
  textEncoded,
  escapeExtra: textEncoded - outputBytes - 2,
  response: httpResponse.bytes.length,
  responseBody: responseJson.bytes.length,
  truncatedLimit: TRUNCATED_LIMIT,
  total: input + output,
  checks: checks.map((item) => ({ ok: item.ok, parsed: item.parsed, stop: item.stop })),
};
const N = numbers;
const model = MODELS[MODEL];
const PUB = 'sk-ant-api03-'.length;

// ---------- 图元 ----------

const schemaRow = (): RowPrim => ({
  kind: 'row',
  id: 's',
  w: 68,
  cells: [
    { v: 'order_id', tone: 'teal', sub: 'string', key: 'order_id' },
    { v: 'intent', tone: 'teal', sub: 'enum × 3', key: 'intent' },
    { v: 'urgent', tone: 'teal', sub: 'boolean', key: 'urgent' },
  ],
});

const requestRow = (json: ReturnType<typeof encodeJson>, lift: string[] = []): RowPrim => ({
  kind: 'row',
  id: 'q',
  w: 62,
  cells: childrenOf(json, '').map((child): DsCell => {
    const key = child.path;
    return { v: key.length > 12 ? key.replace('max_completion_tokens', 'max_comp…').replace('response_format', 'response…') : key, tone: key === 'output_config' || key === 'response_format' ? 'teal' : key === 'system' ? 'violet' : 'blue', sub: `${child.to - child.from} B`, key, lift: lift.includes(key) || undefined };
  }),
});

const responseRow = (): RowPrim => ({
  kind: 'row',
  id: 'r',
  w: 66,
  cells: ['content', 'stop_reason', 'usage'].map((name): DsCell => ({ v: name, tone: name === 'content' ? 'green' : name === 'usage' ? 'amber' : 'blue', sub: `${spanOf(responseJson, name).to - spanOf(responseJson, name).from} B`, key: name })),
  marks: [{ at: 1, text: message.stop_reason, color: 'green', dx: 26 }],
});

const outRow = (): RowPrim => ({
  kind: 'row',
  id: 'o',
  w: 64,
  cells: checks.map((item, index): DsCell => ({ v: item.ok ? '通过' : '失败', tone: item.ok ? 'green' : 'amber', sub: ['schema', '截断', '围栏', '值错'][index], key: `c${index}` })),
});

const checkLines = (): Array<[string, string, string?]> => checks.map((item): [string, string, string?] => [item.name, item.ok ? '通过' : item.errors[0], `stop_reason: ${item.stop}`]);

// ---------- 课程 ----------

export const structured: Lesson = {
  id: 'structured',
  name: 'STRUCTURED',
  title: '结构化输出（API 层）',
  group: 'prompt',
  layer: [3, 5],
  layerNote: 'schema 写在请求的 JSON 字段里，结果是响应里 text 块中的 JSON 字符串，客户端还要再校验。',
  tokensNote: '模型读入的输入 token 加写出的输出 token（JSON 结果）。',
  nodes: ['app', 'schema', 'request', 'model', 'response', 'out'],
  place: { app: [100, 300], schema: [430, 80], request: [450, 400], model: [880, 270], response: [880, 570], out: [450, 640] },
  labels: {
    app: ['应用', '写 schema、校验结果'],
    schema: ['JSON Schema', '字段、类型、枚举'],
    request: ['请求', '两种写法的请求体'],
    model: ['模型', model.name],
    response: ['响应', 'text 块里是 JSON 字符串'],
    out: ['客户端校验', 'JSON.parse + schema'],
  },
  labelAt: { schema: [-210, 20], request: [-10, 125], response: [-200, 30], out: [-215, 30] },
  radius: { schema: 60, request: 60, response: 60, out: 60 },
  initial: { schema: [], request: [], response: [], out: [] },
  start: ['app', 'schema'],
  legend: [['teal', 'schema 和约束'], ['blue', '请求字段'], ['green', '模型的输出（E.G.）'], ['amber', '校验失败'], [null, 'token 列：模型读入的输入加写出的输出']],
  overview: {
    full: '让 API 保证输出可以解析',
    description: `只在提示里写「请输出 JSON」，模型可能给你带说明的文字、被围栏包着的代码块，或者字段不对的 JSON。结构化输出把 schema 放进请求：Anthropic 写在 output_config.format（${N.schemaBytes} 字节的 schema 让请求体长到 ${N.body} 字节），OpenAI Chat Completions 写在 response_format 的 json_schema，服务端按它约束生成，响应里 text 块的内容就是符合 schema 的 JSON 字符串。客户端仍然要 JSON.parse 并校验：被 max_tokens 截断、被拒绝时输出不保证合法。`,
    facts: [
      ['任务', `从「${TEXT}」提取订单号、意图、是否紧急`],
      ['Anthropic', `output_config.format：type json_schema + schema，${N.http} 字节的请求`],
      ['OpenAI', `response_format.json_schema：name + strict + schema，${N.openaiHttp} 字节的请求`],
      ['token', `输入 ${input}，输出 ${output}（本站迷你分词器）`],
    ],
  },
  steps: [
    {
      title: '先写 JSON Schema',
      desc: `3 个字段，${N.schemaJson} 字节`,
      detail: `schema 规定了结果是个对象：order_id 是字符串，intent 只能是「改期、退货、查询」三选一，urgent 是布尔值，三个都必填。结构化输出要求每个对象都写 additionalProperties: false，写成别的值会返回 400；枚举、必填这类约束可以直接写。递归的 schema 和数值、字符串长度这类约束目前不支持，SDK 的辅助函数会把它们去掉，改到客户端校验。`,
      facts: [['order_id', 'string'], ['intent', 'enum：改期、退货、查询'], ['urgent', 'boolean'], ['additionalProperties', 'false（必须）']],
      events: [
        pk('app', 'schema', 'teal', 'JSON Schema', ['3 个字段', '全部必填'], [0, 'JSON', `schema：order_id、intent（枚举）、urgent，${N.schemaJson} 字节`, N.schemaJson],
          wire('应用写的 JSON Schema', 'mem', 'format', jsonBody('schema', schemaJson, {
            color: 'teal',
            expand: ['properties.order_id', 'properties.intent', 'properties.urgent', 'properties.intent.enum'],
            notes: {
              properties: '每个字段的类型。',
              'properties.intent.enum': '枚举：服务端保证只会写出这三个值之一。',
              required: '必填字段列表。',
              additionalProperties: '必须是 false：不许出现 schema 里没有的字段。',
            },
          })),
          { ds: { schema: [schemaRow()] } }),
      ],
    },
    {
      title: 'Anthropic：output_config.format',
      desc: `schema 占 ${N.schemaBytes} 字节，请求 ${N.http} 字节`,
      detail: `schema 放进请求的 output_config.format，type 是 json_schema，schema 就是上面那份；其余字段和普通请求一样，所以只是多了一个顶层字段，请求体从不带它时的 ${N.plainBody} 字节涨到 ${N.body} 字节。旧的 output_format 参数已弃用，不带 beta 头会 400。同一个请求里还可以同时给 tools：output_config 管模型「说」什么，工具上的 strict: true 管它「调用函数」时的参数。`,
      facts: [['位置', 'output_config.format'], ['type', 'json_schema'], ['schema', `${N.schemaBytes} 字节（含外层）`], ['请求', `${N.http} 字节（体 ${N.body}）`]],
      events: [
        show('request'),
        pk('app', 'request', 'teal', 'output_config', ['format: json_schema', `${N.http} 字节`], [0, 'HTTP', `Anthropic 的写法：output_config.format 带 schema，请求 ${N.http} 字节`, N.http],
          wire('请求：多了 output_config', 'mem', 'format',
            httpHead('请求头', http, { mask: { 'x-api-key': PUB }, example: ['x-api-key'] }),
            jsonBody('请求体', body, {
              expand: ['output_config.format', 'output_config.format.type', 'output_config.format.schema'],
              notes: {
                output_config: '输出配置。结构化输出放在它的 format 里（effort 等也在这里）。',
                'output_config.format': '输出格式：type 是 json_schema，再加 schema。',
                'output_config.format.schema': '上一步写的 JSON Schema，原样放进来。',
              },
            })),
          { ds: { request: [requestRow(body, ['output_config'])] } }),
      ],
    },
    {
      title: 'OpenAI：response_format',
      desc: `嵌一层 json_schema，请求 ${N.openaiHttp} 字节`,
      detail: `Chat Completions 写在 response_format：type 是 json_schema，再嵌一层 json_schema 对象，里面有 name、strict 和 schema；strict 为 true 时模型保证严格照 schema 输出（默认是 false），schema 要用它支持的那一子集。Responses 接口把同一份东西放在 text.format 里，层数少一层。拿到的结果也在 choices[0].message.content，同样是 JSON 字符串；模型拒绝时会有单独的 refusal 字段，不遵守 schema。`,
      facts: [['位置', 'response_format.json_schema'], ['字段', 'name、strict: true、schema'], ['Responses', 'text.format（type、name、strict、schema）'], ['请求', `${N.openaiHttp} 字节（体 ${N.openaiBody}）`]],
      events: [
        pk('app', 'request', 'teal', 'response_format', ['json_schema', 'strict: true'], [0, 'HTTP', `OpenAI 的写法：response_format.json_schema（strict），请求 ${N.openaiHttp} 字节`, N.openaiHttp],
          wire('OpenAI Chat Completions 的请求', 'mem', 'format',
            httpHead('请求头', openaiHttp, { mask: { authorization: 'Bearer sk-proj-'.length }, example: ['authorization'] }),
            jsonBody('请求体', openaiBody, {
              expand: ['response_format.type', 'response_format.json_schema', 'response_format.json_schema.name', 'response_format.json_schema.strict', 'response_format.json_schema.schema'],
              example: ['model'],
              notes: {
                response_format: '输出格式。type 是 json_schema 时再带 json_schema 对象。',
                'response_format.json_schema.name': 'schema 的名字（必填，字母数字、下划线、短横线，最长 64）。',
                'response_format.json_schema.strict': 'true：模型严格照 schema 输出；默认 false。',
                'response_format.json_schema.schema': '同一份 JSON Schema。',
              },
            })),
          { ds: { request: [requestRow(openaiBody, ['response_format'])] } }),
      ],
    },
    {
      title: '服务端按 schema 约束生成',
      desc: `输入 ${input} + 输出 ${output} token，响应 ${N.response} 字节`,
      detail: `服务端把 schema 编译成语法，生成每个 token 时只放行符合语法的候选，和 LLM EXPLORER「结构化输出」那一课里逐步掩码是同一个原理，只是这里由 API 替你做。模型的输出 ${output} 个 token（示例内容），放在 content 的 text 块里，是一个字符串：整段 JSON 的引号被转义，响应里它占 ${N.textEncoded} 字节，比原文 ${N.outputBytes} 字节多出 ${N.escapeExtra} 字节转义。本站的 token 数不含 schema，文档没有说明 schema 是否、怎样计入 input_tokens，以真实 usage 为准。`,
      facts: [['input_tokens', `${input}（不含 schema）`], ['output_tokens', `${output}（E.G.）`], ['stop_reason', message.stop_reason], ['text', `${N.outputBytes} 字节，转义后 ${N.textEncoded}`]],
      events: [
        show('model', 'response'),
        pk('request', 'model', 'violet', '读入并约束', [`${input} 个输入 token`, '按 schema 生成'], [input, 'INFER', `模型读入 ${input} 个输入 token，生成被限制在 schema 允许的范围内`, breakdown.prompt.bytes.length],
          wire('模型读到的文本（ChatML 演示）', 'mem', 'internal', promptPieces('ChatML 文本', breakdown.prompt))),
        state('model', { 约束: 'schema 语法', 输入: `${input} token` }),
        pk('model', 'response', 'green', 'JSON 结果', [OUTPUT_TEXT.slice(0, 24) + '…', `${output} 个输出 token`], [N.total, 'INFER', `写出 ${output} 个输出 token：符合 schema 的 JSON 字符串（示例内容）`, N.response],
          wire('响应（内容是示例）', 'mem', 'format',
            httpHead('响应头', httpResponse, { example: ['request-id', 'date'] }),
            jsonBody('响应体', responseJson, {
              expand: ['content[0].type', 'content[0].text', 'usage.output_tokens'],
              example: ['id', 'content', 'content[0].text'],
              notes: { 'content[0].text': '模型写出的 JSON，放在一个字符串里：引号被转义成 \\"。要自己 JSON.parse，SDK 的 parse() 辅助函数会替你做。', stop_reason: 'end_turn：正常写完。max_tokens 或 refusal 时输出可能不符合 schema。' },
            })),
          { ds: { response: [responseRow()] } }),
      ],
    },
    {
      title: '客户端还是要校验',
      desc: `4 种结果，只有 ${checks.filter((item) => item.ok).length} 种能直接用`,
      detail: `带 schema 的响应：JSON.parse 成功、字段全部符合，可以直接用。两种情况输出不保证合法：stop_reason 是 max_tokens 时（上面把 max_tokens 压到 ${TRUNCATED_LIMIT}，JSON 在半路截断），和 stop_reason 是 refusal 时。所以要先看 stop_reason，再 parse，再校验一次；只靠提示词要求 JSON 就没有任何保证，模型可能加说明和围栏，或者写出不在枚举里的值。`,
      facts: [['带 schema', `${checks[0].ok ? '通过' : '失败'}：${checks[0].stop}`], ['max_tokens 截断', `${checks[1].parsed ? '可解析' : '解析失败'}：${checks[1].stop}`], ['提示词里要 JSON', '有围栏：解析失败'], ['提示词里要 JSON', `值不符：${checks[3].errors.length} 处错误`]],
      events: [
        show('out'),
        pk('response', 'out', 'amber', '解析并校验', ['先看 stop_reason', 'JSON.parse', '再校验'], [N.total, 'CALL', `客户端校验：带 schema 的响应通过；max_tokens 截断、提示词里要 JSON 的两种写法没通过`, utf8Encode(OUTPUT_TEXT).length],
          wire('四种输出和校验结果', 'mem', 'format',
            utf8Lines('带 schema 的输出', checks[0].text, { color: 'green', summary: `${outputBytes} 字节，JSON.parse 成功，符合 schema`, notes: { 0: '这一段是示例内容，结构由服务端保证。' } }),
            concept('校验结果', checkLines(), 'amber')),
          { ds: { out: [outRow()] } }),
        note('out', 'stop_reason、解析、校验，一个都不能省', 'green'),
        state('app', { 校验: '4 项中通过 1 项' }),
      ],
    },
  ],
  outro: {
    title: 'schema 是请求的一部分，校验是客户端的责任',
    desc: `输入 ${input}，输出 ${output}，${N.http} 字节的请求`,
    text: `结构化输出把「保证格式」从提示词里挪到了 API：schema 随请求发出，服务端按它约束生成，所以不再需要「请务必只输出 JSON」这类提示，也不用写重试和修复的代码。它不能替你做的是语义对不对（「改期」还是「退货」是模型判断的）、被截断或拒绝时怎么办、业务上的取值范围。这里模型写的 JSON 是示例，请求和响应字节、token、校验结果是真实执行的。下一课往里再加一层：让模型调用函数，输入是工具的 JSON Schema，输出是 tool_use 块，要往返两次。`,
    facts: [['schema', `${N.schemaJson} 字节`], ['请求', `${N.http}（Anthropic）/ ${N.openaiHttp}（OpenAI）字节`], ['token', `${input} + ${output}`], ['下一课', '函数调用的一个往返']],
  },
};

