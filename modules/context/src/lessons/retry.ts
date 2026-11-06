/**
 * 第四课：限流、错误与重试。令牌桶限流器（RPM / 输入 TPM / 输出 TPM）真实模拟一次突发请求，429、529、400 的响应字节真实编码，
 * 客户端的指数退避加抖动用固定种子的 PRNG 计算，一群客户端同时重试用同一个令牌桶模拟，流式中途的 error 事件用 SseParser 真实解析。
 * 限额是演示用的小数目（真实的 Start 档见 README 的事实表），服务端「过载」「中途断流」是脚本写好的情形；围绕它们的字节、等待时间、桶余量都是计算结果。
 * 文案里的数字取自下面导出的计算结果，tests/narrative.api.test.ts 核对。
 */
import { mulberry32 } from '@explorer/llm-core/prng';
import {
  accumulate,
  apiError,
  DEFAULT_POLICY,
  DOCUMENTED_ERRORS,
  encodeJson,
  encodeResponse,
  encodeStream,
  errorBody,
  errorEvent,
  errorHttpResponse,
  EXAMPLE_EPOCH,
  eventFrame,
  exampleId,
  messagesHttpResponse,
  RateLimiter,
  retryTimeline,
  sdkRetries,
  simulateHerd,
  SseParser,
  validateRequest,
  waitBefore,
  worthRetrying,
  makeResponse,
  type Admission,
  type Header,
  type StreamEvent,
  type TimelineRow,
} from '../core';
import { concept, httpHead, jsonBody, sseBody, wire } from '../decode/structures';
import { DATE, REPLY, REQUEST, httpRequest as baseHttp, message } from './messages';
import { deltas, events as sseEvents, frames as sseFrames, tokensAt } from './sse';
import { note, pk, render, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

const input = message.usage.input_tokens;
const output = message.usage.output_tokens;
/** 一次完整调用：读入输入，写出输出。 */
export const call = input + output;
const replyText = (REPLY[0] as { text: string }).text;

// ---------- 1. 令牌桶：突发请求 ----------

/** 演示用的小限额：每分钟 6 个请求、500 个输入 token、400 个输出 token。真实的 Start 档 Sonnet 5.5 是 4,000 / 2,000,000 / 400,000。 */
export const LIMITS = { rpm: 6, itpm: 500, otpm: 400 };
export const limiter = new RateLimiter(LIMITS, 0);

export interface BurstRow {
  index: number;
  /** 到达时刻（秒）。 */
  at: number;
  result: Admission;
  /** 处理完这个请求之后三个桶的余量（取整）。 */
  left: { requests: number; input: number; output: number };
  /** 这一刻的 anthropic-ratelimit-* 响应头。 */
  headers: Header[];
}

/** 8 个请求，每 0.1 秒一个。放行的立刻按实际输出量扣输出桶（简化：不模拟生成耗时）。 */
export const burst: BurstRow[] = Array.from({ length: 8 }, (_, i) => {
  const at = i * 0.1;
  const result = limiter.admit(input, at);
  if (result.ok) limiter.recordOutput(output, at);
  return { index: i + 1, at, result, left: { requests: Math.floor(limiter.requests.available(at)), input: Math.floor(limiter.input.available(at)), output: Math.floor(limiter.output.available(at)) }, headers: limiter.headers(at, EXAMPLE_EPOCH) };
});
export const admitted = burst.filter((row) => row.result.ok);
export const rejected = burst.filter((row) => !row.result.ok);
const firstReject = rejected[0];
export const reject = firstReject.result as Extract<Admission, { ok: false }>;
const REJECT_AT = firstReject.at;

const MESSAGE_429 = `This request would exceed the rate limit for your organization (${LIMITS.rpm} requests per minute).`;
export const error429 = apiError('rate_limit_error', MESSAGE_429);
const REQUEST_ID_429 = exampleId('req', 21);
/** 突发里第一个被拒绝的请求收到的响应：带 retry-after 和 anthropic-ratelimit-* 头。 */
export const response429 = encodeResponse(errorHttpResponse(error429, { requestId: REQUEST_ID_429, retryAfter: reject.retryAfter, extra: [['date', DATE], ...firstReject.headers] }));
const body429 = encodeJson(errorBody(error429, REQUEST_ID_429));

// ---------- 2. 哪些错该重试 ----------

export const temperatureError = validateRequest({ ...REQUEST, temperature: 0.7 })!;
const REQUEST_ID_400 = exampleId('req', 22);
export const response400 = encodeResponse(errorHttpResponse(temperatureError, { requestId: REQUEST_ID_400, extra: [['date', DATE]] }));

/** 月度消费上限的 429：文档给出的结构（details.error_code），没有 retry-after。措辞是文档示例，日期按本站示例日期改。 */
const SPEND_MESSAGE = "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-12-01 at 00:00 UTC.";
const REQUEST_ID_SPEND = exampleId('req', 23);
export const spendJson = encodeJson({ type: 'error', error: { type: 'rate_limit_error', message: SPEND_MESSAGE, details: { error_code: 'enforced_spend_limit_reached' } }, request_id: REQUEST_ID_SPEND });
export const responseSpend = encodeResponse(makeResponse(429, [['date', DATE], ['content-type', 'application/json'], ['request-id', REQUEST_ID_SPEND]], spendJson.bytes));

export interface StatusRow {
  status: number;
  label: string;
  /** SDK 会重试（按状态码）。 */
  sdk: boolean;
  /** 值得重试（去掉重试也没用的）。 */
  worth: boolean;
}
export const STATUSES: StatusRow[] = [
  { status: 400, label: '400', hopeless: false },
  { status: 401, label: '401', hopeless: false },
  { status: 413, label: '413', hopeless: false },
  { status: 429, label: '429', hopeless: false },
  { status: 429, label: '429*', hopeless: true },
  { status: 500, label: '500', hopeless: false },
  { status: 529, label: '529', hopeless: false },
].map(({ status, label, hopeless }) => ({ status, label, sdk: sdkRetries(status), worth: worthRetrying({ status, hopeless }) }));

// ---------- 3. 退避：429 → 529 → 200 ----------

const rand = mulberry32(20261106);
/** 脚本：第 1 次是上面那个被限流的请求；第 2 次服务端过载（脚本写好的 529，没有 retry-after）；第 3 次限流器放行。 */
export const timeline: TimelineRow[] = retryTimeline((attempt, at) => {
  if (attempt === 1) return { status: 429, retryAfter: reject.retryAfter };
  if (attempt === 2) return { status: 529 };
  const verdict = limiter.admit(input, at);
  if (verdict.ok) {
    limiter.recordOutput(output, at);
    return { status: 200 };
  }
  return { status: 429, retryAfter: verdict.retryAfter };
}, DEFAULT_POLICY, rand, REJECT_AT);

const wait1 = timeline[0].wait!;
const wait2 = timeline[1].wait!;
const REQUEST_ID_529 = exampleId('req', 24);
export const error529 = apiError('overloaded_error', DOCUMENTED_ERRORS.overloaded, true);
export const response529 = encodeResponse(errorHttpResponse(error529, { requestId: REQUEST_ID_529, extra: [['date', DATE]] }));
const final = timeline[timeline.length - 1];
export const response200 = encodeResponse(messagesHttpResponse(message, { requestId: exampleId('req', 25), date: DATE }));

// ---------- 4. 抖动：一群客户端同时重试 ----------

export const HERD = { clients: 30, capacity: 5, refillPerSecond: 4, seed: 7 };
const herdPolicy = (jitter: number) => ({ ...DEFAULT_POLICY, maxRetries: 4, jitter });
export const herd = {
  none: simulateHerd({ ...HERD, policy: herdPolicy(0) }),
  sdk: simulateHerd({ ...HERD, policy: herdPolicy(DEFAULT_POLICY.jitter) }),
  full: simulateHerd({ ...HERD, policy: herdPolicy(1) }),
};

// ---------- 5. 流式中途的 error 事件 ----------

/** 脚本：第 8 个 text_delta 之后服务端过载，HTTP 已经是 200，只能发 error 事件。 */
export const CUT_DELTAS = 8;
const firstDelta = sseEvents.findIndex((event) => event.type === 'content_block_delta');
export const partialEvents: StreamEvent[] = [...sseEvents.slice(0, firstDelta + CUT_DELTAS), errorEvent(error529) as StreamEvent];
export const partialFrames = partialEvents.map(eventFrame);
export const partialStream = encodeStream(partialFrames);
export const partialParser = new SseParser();
export const partialParsed = partialParser.push(partialStream.bytes);
export const partialDropped = partialParser.end();
export const partialText = deltas.slice(0, CUT_DELTAS).join('');
export const partialMessage = accumulate(partialEvents.slice(0, -1));
/** 出错那一刻模型已经读入输入、写出的 token。 */
export const partialTokens = tokensAt(firstDelta + CUT_DELTAS - 1) - input;
const errorFrame = partialFrames.length - 1;
const retryWait = waitBefore(DEFAULT_POLICY, 0, rand, null);

// ---------- 累计 token ----------
// 第 1 步放行的请求各读入输入、写出输出；第 3 步第 3 次尝试成功再来一次完整调用；
// 第 5 步出错的那次读入了输入、写出一部分输出，重发成功再来一次完整调用。
const t1 = admitted.length * call;
const t3 = t1 + call;
const t5a = t3 + input + partialTokens;
const t5b = t5a + call;

// ---------- 图元 ----------

const secs = (value: number) => `${+value.toFixed(1)}s`;

function bucketGrid(row: BurstRow | null): GridPrim {
  const left = row?.left ?? { requests: LIMITS.rpm, input: LIMITS.itpm, output: LIMITS.otpm };
  const heat = (remaining: number, limit: number) => 1 - remaining / limit;
  return {
    kind: 'grid',
    id: 'u',
    w: 70,
    rows: ['请求', '输入', '输出'],
    cols: ['限额', '剩余'],
    cells: [
      [{ v: String(LIMITS.rpm), tone: 'slate' }, { v: String(left.requests), tone: 'amber', heat: heat(left.requests, LIMITS.rpm) }],
      [{ v: String(LIMITS.itpm), tone: 'slate' }, { v: String(left.input), tone: 'amber', heat: heat(left.input, LIMITS.itpm) }],
      [{ v: String(LIMITS.otpm), tone: 'slate' }, { v: String(left.output), tone: 'amber', heat: heat(left.output, LIMITS.otpm) }],
    ],
  };
}

const STATUS_TONE = (row: StatusRow): Tone => (row.worth ? 'green' : 'amber');

function statusRow(upTo = STATUSES.length): RowPrim {
  return {
    kind: 'row',
    id: 's',
    w: 52,
    cells: STATUSES.slice(0, upTo).map((row, i): DsCell => ({ v: row.label, tone: STATUS_TONE(row), sub: row.worth ? '重试' : row.sdk ? '白等' : '不重试', key: `s${i}`, lift: i === upTo - 1 || undefined })),
  };
}

/** 尝试的时间线：每次尝试一格，写状态码；每次等待一格，写等多久。 */
function timelineRow(upTo: number): RowPrim {
  const cells: DsCell[] = [];
  timeline.slice(0, upTo).forEach((item, i) => {
    cells.push({ v: String(item.status), tone: item.status === 200 ? 'green' : 'amber', sub: `#${item.attempt} ${secs(item.at - REJECT_AT)}`, key: `a${i}` });
    if (item.wait && i < upTo - 1) cells.push({ v: secs(item.wait.ms / 1000), tone: 'dim', sub: item.wait.source === 'retry-after' ? 'retry-after' : '退避', key: `w${i}` });
  });
  return { kind: 'row', id: 'e', w: 62, cells, center: (cells.length - 1) / 2 };
}

function herdRow(upTo: number): RowPrim {
  const options = [['无抖动', herd.none], ['抖动 25%', herd.sdk], ['完全随机', herd.full]] as const;
  return { kind: 'row', id: 'e', w: 74, cells: options.slice(0, upTo).map(([name, result], i): DsCell => ({ v: String(result.peak), tone: i === 0 ? 'amber' : 'green', sub: name, key: `h${i}`, lift: i === upTo - 1 || undefined })), center: 1 };
}

const textCells = (count: number): RowPrim => {
  const shown = deltas.slice(0, count).slice(-8);
  const start = Math.max(0, count - 8);
  return { kind: 'row', id: 'o', w: 48, bare: true, cells: shown.map((text, i): DsCell => ({ v: text.replace(/ /g, '␣'), tone: 'green', key: `t${start + i}`, sub: `#${start + i}` })), center: (shown.length - 1) / 2 };
};

// ---------- 文案用到的数 ----------

export const numbers = {
  input,
  output,
  call,
  limits: LIMITS,
  admitted: admitted.length,
  rejected: rejected.length,
  retryAfter: reject.retryAfter,
  waitSeconds: +reject.waitSeconds.toFixed(1),
  limit: reject.limit,
  response429: response429.bytes.length,
  body429: body429.bytes.length,
  response400: response400.bytes.length,
  responseSpend: responseSpend.bytes.length,
  response529: response529.bytes.length,
  attempts: timeline.length,
  wait1: wait1.ms,
  wait2: wait2.ms,
  wait2Ceiling: wait2.ceiling,
  doneAt: +(final.at - REJECT_AT).toFixed(1),
  herdNone: herd.none.peak,
  herdSdk: herd.sdk.peak,
  herdFull: herd.full.peak,
  partialFrames: partialFrames.length,
  partialBytes: partialStream.bytes.length,
  partialTokens,
  retryWait: retryWait.ms,
};
const N = numbers;

// ---------- 课程 ----------

export const retry: Lesson = {
  id: 'retry',
  name: 'RETRY',
  title: '限流、错误与重试',
  group: 'api',
  layer: [2, 4],
  layerNote: '限流发生在 API 入口，体现为 HTTP 状态码和响应头；重试是 SDK 在 HTTP 之上做的事；流中途的错误又落回 SSE 事件，最后由应用决定怎么处理。',
  tokensNote: '放行并处理的请求累计读入的输入加写出的输出 token；被拒绝的请求没有到达模型，不计。',
  nodes: ['sdk', 'gateway', 'rate', 'usage', 'response', 'events', 'out'],
  place: { sdk: [110, 150], gateway: [560, 150], rate: [940, 310], usage: [820, 590], response: [520, 400], events: [480, 650], out: [130, 700] },
  labels: {
    sdk: ['SDK', '退避 + 抖动'],
    gateway: ['API', '返回状态码'],
    rate: ['限流器', '令牌桶 RPM / ITPM / OTPM'],
    usage: ['桶的余量', '演示用的小限额'],
    response: ['状态码', '重试 / 不重试'],
    events: ['尝试', '时间线'],
    out: ['已收到的文字', '流中途断了'],
  },
  labelAt: { usage: [10, 120], response: [-190, 30], events: [-170, 30], out: [-140, 30] },
  radius: { usage: 60, response: 56, events: 56, out: 50 },
  initial: { usage: [], response: [], events: [], out: [] },
  start: ['sdk', 'gateway', 'usage'],
  legend: [['amber', '被拒绝、桶的消耗'], ['green', '值得重试、成功'], ['slate', '限额、响应头'], [null, 'token 列：放行并处理的请求的输入加输出']],
  overview: {
    full: '被拒绝之后怎么办',
    description: `模型调用会失败：每分钟请求数、输入 token、输出 token 三个令牌桶任何一个空了就是 429，服务过载是 529，请求写错是 400。这一课先用演示用的小限额（每分钟 ${LIMITS.rpm} 个请求）发一波 ${burst.length} 个请求，看 ${N.rejected} 个被拒绝时收到的真实响应字节；再区分哪些错该重试、哪些重试也没用；然后看 SDK 怎样按 retry-after 和指数退避等待，为什么要加抖动（${HERD.clients} 个客户端同时重试的模拟），最后看流式响应中途出错时重试为什么更难。`,
    facts: [
      ['限流', 'RPM / ITPM / OTPM，令牌桶'],
      ['SDK 默认', '重试 2 次，指数退避，照 retry-after'],
      ['演示限额', `${LIMITS.rpm} RPM / ${LIMITS.itpm} ITPM / ${LIMITS.otpm} OTPM`],
      ['真实 Start 档', 'Sonnet 5.5：4,000 / 2,000,000 / 400,000'],
    ],
  },
  steps: [
    {
      title: '令牌桶空了：429 和 retry-after',
      desc: `${burst.length} 个请求，放行 ${N.admitted} 个，拒绝 ${N.rejected} 个`,
      detail: `限流用的是令牌桶：每个限额一个桶，桶里的量随时间连续补充直到上限，不是每分钟清零一次。演示限额是每分钟 ${LIMITS.rpm} 个请求，等于每 ${60 / LIMITS.rpm} 秒补 1 个；${burst.length} 个请求在 ${((burst.length - 1) * 0.1).toFixed(1)} 秒内到达，前 ${N.admitted} 个把请求桶用空，第 ${firstReject.index} 个收到 429，retry-after: ${N.retryAfter} 是还要等的秒数（向上取整）。输入桶只算未缓存的输入，输出桶按模型实际写出的 token 扣，max_tokens 不影响它。`,
      facts: [['放行', `${N.admitted} 个（桶里剩 ${admitted[admitted.length - 1].left.requests}）`], ['第一个被拒绝', `第 ${firstReject.index} 个，缺的是${reject.limit === 'requests' ? '请求' : reject.limit === 'input_tokens' ? '输入' : '输出'}桶`], ['retry-after', `${N.retryAfter} 秒（还要等 ${N.waitSeconds} 秒，向上取整）`], ['响应', `${N.response429} 字节`]],
      events: [
        pk('sdk', 'gateway', 'blue', `${burst.length} 个请求`, [`间隔 0.1 s`, `每个 ${baseHttp.bytes.length} 字节`], [0, 'HTTP', `${burst.length} 个请求在 ${((burst.length - 1) * 0.1).toFixed(1)} 秒内到达，每个 ${baseHttp.bytes.length} 字节（输入 ${input} token）`, baseHttp.bytes.length],
          wire('其中一个请求（和第一课相同）', 'mem', 'format', httpHead('请求头', baseHttp, { mask: { 'x-api-key': 'sk-ant-api03-'.length }, example: ['x-api-key'] }), jsonBody('请求体', encodeJson(REQUEST)))),
        show('rate'),
        pk('gateway', 'rate', 'violet', '检查三个桶', [`请求 ${LIMITS.rpm}/min`, `输入 ${LIMITS.itpm}/min`, `输出 ${LIMITS.otpm}/min`], [t1, 'HTTP', `限流器逐个检查：放行 ${N.admitted} 个（共 ${t1} token 到达模型），第 ${firstReject.index} 个起拒绝`, 0],
          wire('每个请求到达时三个桶的余量', 'mem', '示意', concept(`${burst.length} 个请求（演示限额 ${LIMITS.rpm} / ${LIMITS.itpm} / ${LIMITS.otpm}）`, burst.map((row): [string, string, string?] => [
            `第 ${row.index} 个 · t=${secs(row.at)}`,
            row.result.ok ? `放行，剩 ${row.left.requests} / ${row.left.input} / ${row.left.output}` : `拒绝：${row.result.limit}，要等 ${+row.result.waitSeconds.toFixed(1)} 秒`,
            row.index === 1 ? '三个数依次是请求、输入 token、输出 token 的余量。输出桶按实际生成量事后扣（这里简化为立刻扣）。' : undefined,
          ]), 'amber')),
          { ds: { usage: [bucketGrid(admitted[admitted.length - 1])] } }),
        state('rate', { 请求: `${admitted[admitted.length - 1].left.requests} / ${LIMITS.rpm}`, 输入: `${admitted[admitted.length - 1].left.input} / ${LIMITS.itpm}`, 输出: `${admitted[admitted.length - 1].left.output} / ${LIMITS.otpm}` }),
        pk('gateway', 'sdk', 'amber', 'HTTP 429', [`retry-after: ${N.retryAfter}`, 'rate_limit_error'], [t1, 'ERROR', `429 rate_limit_error，retry-after: ${N.retryAfter}；响应头带三个桶的余量`, N.response429],
          wire('被拒绝的请求收到的响应', 'mem', 'format', httpHead('响应头', response429, {
            startNote: '429 Too Many Requests（RFC 6585）。',
            example: ['request-id', 'date', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-output-tokens-reset'],
            notes: {
              'retry-after': `还要等的秒数。早于这个时间重试一定失败。不是每个 429 都带这个头。`,
              'anthropic-ratelimit-requests-remaining': '请求桶当前的余量。',
              'anthropic-ratelimit-requests-reset': 'RFC 3339 时间：这个桶完全补满的时刻。',
              'anthropic-ratelimit-input-tokens-remaining': '真实响应里 token 余量四舍五入到千，这里的限额太小，所以不取整。',
            },
          }), jsonBody('响应体', body429, { expand: ['error.type', 'error.message'], example: ['request_id', 'error.message'], notes: { 'error.message': '措辞是示例：文档只说 429 会描述超出了哪个限额。' } })),
          { lost: true }),
      ],
    },
    {
      title: '哪些错该重试',
      desc: `4xx 多半是你的错，429、5xx 是暂时的，但有例外`,
      detail: `400、401、404、413 这类是请求本身的问题，原样重发只会得到同样的错误，应当修好再发。408、409、429 和 5xx（含 529）是暂时的，SDK 按状态码自动重试。例外是 429 里的月度消费上限：它不带 retry-after，要到下个月才恢复，响应体里 error.details.error_code 是 enforced_spend_limit_reached，SDK 照样会重试（只是白等），所以要靠这个字段识别。400 里也有一类特殊的：2026-10-21 版本带 temperature，立刻 400，不会产生 token。`,
      facts: [['不重试', '400、401、404、413'], ['重试', '408、409、429、5xx'], ['429*', '月度上限：retry-after 缺失，白等'], ['400 响应', `${N.response400} 字节，没有 token`]],
      events: [
        show('response'),
        pk('gateway', 'sdk', 'amber', 'HTTP 400', ['invalid_request_error', 'temperature'], [t1, 'ERROR', `400：${temperatureError.message}。请求写错了，重发一万次也一样`, N.response400],
          wire('请求本身有问题：400', 'mem', 'format', httpHead('响应头', response400, { example: ['request-id', 'date'], startNote: '400 Bad Request：重试没用，要改请求。' }), jsonBody('响应体', encodeJson(errorBody(temperatureError, REQUEST_ID_400)), { expand: ['error.type', 'error.message'], example: ['request_id', 'error.message'], notes: { 'error.message': '措辞是示例。' } })),
          { lost: true, ds: { response: [statusRow(3)] } }),
        pk('gateway', 'sdk', 'amber', 'HTTP 429*', ['没有 retry-after', 'enforced_spend_limit_reached'], [t1, 'ERROR', `429，但是月度消费上限：没有 retry-after，到下个月才恢复`, N.responseSpend],
          wire('消费上限的 429：看起来像限流', 'mem', 'format', httpHead('响应头', responseSpend, { example: ['request-id', 'date'], notes: { 'content-type': '注意：没有 retry-after 头。' } }), jsonBody('响应体', spendJson, { expand: ['error.type', 'error.message', 'error.details.error_code'], example: ['request_id', 'error.message'], notes: { 'error.details.error_code': '区分「限流」和「花光了额度」的字段：enforced_spend_limit_reached。' , 'error.message': '结构取自文档示例，日期按本站示例日期改写。' } })),
          { lost: true, ds: { response: [statusRow(STATUSES.length)] } }),
        note('response', 'SDK 看状态码，应用还要看 error 里的字段', 'amber'),
      ],
    },
    {
      title: '等多久：retry-after 优先，否则指数退避',
      desc: `第 ${N.attempts} 次尝试成功，从第一次被拒算起 ${N.doneAt} 秒`,
      detail: `SDK 默认重试 2 次。第 1 次被拒时 429 带着 retry-after: ${N.retryAfter}，就照它等 ${N.retryAfter} 秒；第 2 次尝试撞上服务过载（529，脚本里写好的），没有 retry-after，只能自己退避：起步 ${DEFAULT_POLICY.baseMs} 毫秒，每次翻倍，这是第 2 次重试，上限 ${wait2.ceiling} 毫秒，再乘一个随机的抖动因子（固定种子），最后等了 ${N.wait2} 毫秒。第 3 次尝试限流器放行，总共 ${N.attempts} 次尝试、${timeline.length - 1} 次重试，刚好用完 maxRetries。`,
      facts: [['第 1 次', `429 → 照 retry-after 等 ${N.retryAfter} 秒`], ['第 2 次', `529 → 退避 ${N.wait2} 毫秒（上限 ${wait2.ceiling}）`], ['第 3 次', '200'], ['策略', `重试 ${DEFAULT_POLICY.maxRetries} 次，${DEFAULT_POLICY.baseMs} ms 起步，封顶 ${DEFAULT_POLICY.capMs} ms，抖动 ${DEFAULT_POLICY.jitter * 100}%`]],
      events: [
        show('events'),
        pk('sdk', 'gateway', 'slate', `等 ${N.retryAfter} s`, [`retry-after: ${N.retryAfter}`, '第 1 次重试'], [t1, 'RETRY', `照 retry-after 等 ${N.retryAfter} 秒后重发（第 1 次重试）`, baseHttp.bytes.length],
          wire('SDK 的等待规则', 'mem', '示意', concept('第 1 次重试前', [
            ['状态', '429', '可重试。'],
            ['retry-after', `${N.retryAfter} 秒`, '有，而且在合理范围内（本站取 0–60 秒），就照它等，不自己算。'],
            ['等待', `${wait1.ms / 1000} 秒`, '来源：retry-after。'],
          ], 'slate')),
          { ds: { events: [timelineRow(1)] } }),
        pk('gateway', 'sdk', 'amber', 'HTTP 529', ['overloaded_error', '没有 retry-after'], [t1, 'ERROR', `第 2 次尝试：529 overloaded_error（脚本：服务过载），响应 ${N.response529} 字节`, N.response529],
          wire('过载：529', 'mem', 'format', httpHead('响应头', response529, { startNote: '529 不是标准状态码，没有登记的原因短语，所以状态码后面是空的。', example: ['request-id', 'date'] }), jsonBody('响应体', encodeJson(errorBody(error529, REQUEST_ID_529)), { expand: ['error.type', 'error.message'], example: ['request_id'], notes: { 'error.message': 'Overloaded：文档逐字给出的信息。' } })),
          { lost: true, ds: { events: [timelineRow(2)] } }),
        pk('sdk', 'gateway', 'slate', `等 ${N.wait2} ms`, ['指数退避 + 抖动', `第 2 次重试`], [t1, 'RETRY', `没有 retry-after：退避 min(${DEFAULT_POLICY.capMs}, ${DEFAULT_POLICY.baseMs}×2^1) = ${wait2.ceiling} 毫秒，乘抖动因子后等 ${N.wait2} 毫秒`, baseHttp.bytes.length],
          wire('SDK 的退避公式（实现细节）', 'mem', '示意', concept('第 2 次重试前', [
            ['状态', '529', '可重试，但没有 retry-after。'],
            ['上限', `${wait2.ceiling} ms`, `min(封顶 ${DEFAULT_POLICY.capMs}, 起步 ${DEFAULT_POLICY.baseMs} × 2^1)。`],
            ['抖动因子', `${+(wait2.ms / wait2.ceiling).toFixed(3)}`, `1 - ${DEFAULT_POLICY.jitter} × rand()，rand 来自固定种子，每次运行相同。`],
            ['等待', `${wait2.ms} ms`, '起步、封顶和抖动比例是常见的 SDK 取值，不是公开文档的承诺（文档只说指数退避、默认重试 2 次、有 retry-after 时照它）。'],
          ], 'slate')),
          { ds: { events: [timelineRow(2)] } }),
        pk('gateway', 'sdk', 'green', 'HTTP 200', [`第 ${N.attempts} 次尝试`, `${call} token`], [t3, 'HTTP', `第 ${N.attempts} 次尝试成功：限流器放行，处理 ${call} token，距第一次被拒 ${N.doneAt} 秒`, response200.bytes.length],
          wire('第三次尝试：成功', 'mem', 'format', httpHead('响应头', response200, { example: ['request-id', 'date'] }), jsonBody('响应体', encodeJson(message), { expand: ['usage.input_tokens', 'usage.output_tokens'], example: ['id', 'content'] })),
          { ds: { events: [timelineRow(3)] } }),
      ],
    },
    {
      title: '抖动：别让大家同时回来',
      desc: `${HERD.clients} 个客户端，同一时刻重试的峰值 ${N.herdNone} → ${N.herdFull}`,
      detail: `如果 ${HERD.clients} 个客户端在同一时刻被拒绝，又都按同样的退避等同样的时间，它们会在同一时刻一起回来，把服务再冲垮一次。模拟的服务端是容量 ${HERD.capacity}、每秒补 ${HERD.refillPerSecond} 个的令牌桶：没有抖动时，重试请求在同一个 100 毫秒里最多到了 ${N.herdNone} 个；SDK 式的 ${DEFAULT_POLICY.jitter * 100}% 抖动降到 ${N.herdSdk}；完全随机降到 ${N.herdFull}。抖动削的是峰值，不保证每个客户端都成功：放弃的客户端数分别是 ${herd.none.gaveUp}、${herd.sdk.gaveUp}、${herd.full.gaveUp}。OpenAI 的文档同样建议没有 Retry-After 时用带抖动的指数退避。`,
      facts: [['无抖动', `峰值 ${N.herdNone}，共 ${herd.none.requests} 个请求，放弃 ${herd.none.gaveUp}`], [`抖动 ${DEFAULT_POLICY.jitter * 100}%`, `峰值 ${N.herdSdk}，共 ${herd.sdk.requests} 个请求，放弃 ${herd.sdk.gaveUp}`], ['完全随机', `峰值 ${N.herdFull}，共 ${herd.full.requests} 个请求，放弃 ${herd.full.gaveUp}`], ['模拟', `${HERD.clients} 个客户端，桶 ${HERD.capacity}，每秒补 ${HERD.refillPerSecond}，最多重试 4 次`]],
      events: [
        pk('sdk', 'gateway', 'amber', '无抖动', [`${HERD.clients} 个客户端`, `峰值 ${N.herdNone}`], [t3, 'RETRY', `无抖动：第一轮 ${herd.none.perAttempt[0]} 个请求，重试的峰值 ${N.herdNone} 个/100 ms，共 ${herd.none.requests} 个请求，${herd.none.gaveUp} 个放弃`, 0],
          wire('没有抖动', 'mem', '示意', concept('无抖动（抖动 0%）', herdFields(herd.none), 'amber')),
          { ds: { events: [herdRow(1)] } }),
        pk('sdk', 'gateway', 'green', '抖动 25%', [`峰值 ${N.herdSdk}`], [t3, 'RETRY', `抖动 25%：重试的峰值 ${N.herdSdk} 个/100 ms，共 ${herd.sdk.requests} 个请求，${herd.sdk.gaveUp} 个放弃`, 0],
          wire('SDK 式的抖动', 'mem', '示意', concept('抖动 25%', herdFields(herd.sdk), 'green')),
          { ds: { events: [herdRow(2)] } }),
        pk('sdk', 'gateway', 'green', '完全随机', [`峰值 ${N.herdFull}`], [t3, 'RETRY', `完全随机：重试的峰值 ${N.herdFull} 个/100 ms，共 ${herd.full.requests} 个请求，${herd.full.gaveUp} 个放弃`, 0],
          wire('完全随机的抖动', 'mem', '示意', concept('抖动 100%', herdFields(herd.full), 'green')),
          { ds: { events: [herdRow(3)] } }),
      ],
    },
    {
      title: '流到一半出错：状态码已经是 200',
      desc: `${CUT_DELTAS} 个 delta 之后 event: error，已写出 ${N.partialTokens} 个 token`,
      detail: `流式响应的 HTTP 状态码在第一个字节之前就发出了，是 200；之后才出的错（比如过载）只能写成流里的 event: error，这时按状态码重试的那套标准机制不适用。这一次模型写了 ${CUT_DELTAS} 个 delta、${N.partialTokens} 个 token（「${partialText}」）就断了：SseParser 照常解析出 ${partialParsed.length} 个事件，最后一个是 error，已经收到的文字还在，但这条消息不完整，没有 message_delta，也没有 stop_reason。能做的只有重发整个请求，让模型把 ${input} 个输入 token 再读一遍；要不要保留半截文字，由应用决定。`,
      facts: [['状态码', '200（已发出）'], ['错误', 'event: error，overloaded_error'], ['已收到', `${CUT_DELTAS} 个 delta，${N.partialTokens} token`], ['stop_reason', '没有']],
      events: [
        show('out'),
        pk('gateway', 'sdk', 'blue', `${CUT_DELTAS} 个 delta`, [`「${partialText}」`], [t5a, 'SSE', `流式响应：200，已推送 ${CUT_DELTAS} 个 text_delta（${N.partialTokens} token）`, partialStream.bytes.length - frameSize(errorFrame)],
          wire('出错之前的流', 'mem', 'format', sseBody('已推送的帧', encodeStream(partialFrames.slice(0, -1)))),
          { ds: { out: [textCells(CUT_DELTAS)] } }),
        pk('gateway', 'sdk', 'amber', 'event: error', ['overloaded_error', 'Overloaded'], [t5a, 'ERROR', `流里的 error 事件：overloaded_error，HTTP 状态码早已是 200`, frameSize(errorFrame)],
          wire('流里的错误', 'mem', 'format', sseBody('error 帧', encodeStream(partialFrames.slice(-1)), { notes: { 0: '文档的示例：HTTP 200 之后出现的 overloaded_error，对应非流式时的 529。error 事件的 data 里没有 request_id。' } })),
          { lost: true }),
        pk('sdk', 'out', 'amber', '半截的回复', [`「${partialText}」`, '没有 stop_reason'], [t5a, 'ERROR', `SDK 抛出异常；已收到「${partialText}」，${partialMessage.content.length} 个内容块，没有 message_delta`, new TextEncoder().encode(partialText).length],
          wire('已经收到的文字', 'mem', '示意', concept('半截的消息', [
            ['已收到', `「${partialText}」`, '这些 text_delta 已经拼出来了。'],
            ['缺的', 'content_block_stop、message_delta、message_stop', '所以没有 stop_reason，也没有最终的 usage。'],
            ['输入 token', `${input}`, '模型已经读入；重发时要再读一遍。'],
          ], 'amber')),
          { ds: { out: [textCells(CUT_DELTAS)] } }),
        pk('sdk', 'gateway', 'slate', `等 ${N.retryWait} ms`, ['重发整个请求'], [t5a, 'RETRY', `应用重发整个请求：退避 ${retryWait.ceiling} 毫秒上限，抖动后等 ${N.retryWait} 毫秒`, baseHttp.bytes.length],
          wire('重发', 'mem', '示意', concept('重发', [
            ['等待', `${N.retryWait} ms`, `第 1 次重试：min(${DEFAULT_POLICY.capMs}, ${DEFAULT_POLICY.baseMs}×2^0) = ${retryWait.ceiling} ms 再乘抖动因子。`],
            ['内容', '整个请求从头来', '流不能断点续传：服务端不保存对话，也不记得上次写到哪。'],
          ], 'slate'))),
        pk('gateway', 'sdk', 'green', '完整的流', [`${sseFrames.length} 帧`, `${call} token`], [t5b, 'SSE', `重发成功：${sseFrames.length} 帧的完整流，处理 ${call} token`, encodeStream(sseFrames).bytes.length],
          wire('这次完整的流', 'mem', 'format', sseBody('SSE 帧', encodeStream(sseFrames))),
          { ds: { out: [textCells(deltas.length)] } }),
        render,
        note('out', `${replyText.length} 个字符，两次尝试共 ${t5b - t3} token`, 'green'),
      ],
    },
  ],
  outro: {
    title: '失败是常态，要有预案',
    desc: `${N.admitted} 个放行，${N.rejected} 个被拒，重试 ${timeline.length - 1} 次`,
    text: `接口组的四课到这里：一次调用是一个 HTTP 请求，流式是一串 SSE 帧，各家写法不同，而且随时可能失败。限流是令牌桶，三个限额各管各的，缓存读不占输入额度；重试要区分错误类型，有 retry-after 就照它等，没有就指数退避加抖动，并限制次数；流到一半出错时状态码已经是 200，只能重发整个请求。这些都发生在模型之外。下一组课进入「提示」：消息怎样经 chat template 变成模型读到的 token 序列。`,
    facts: [['限额', `${LIMITS.rpm} / ${LIMITS.itpm} / ${LIMITS.otpm}（演示）`], ['重试', `${timeline.length - 1} 次，${N.doneAt} 秒`], ['抖动峰值', `${N.herdNone} → ${N.herdFull}`], ['下一课', 'chat template：system、角色和约束变成 token']],
  },
};

function frameSize(index: number): number {
  const span = partialStream.spans[index];
  return span.to - span.from;
}

function herdFields(result: ReturnType<typeof simulateHerd>): Array<[string, string, string?]> {
  return [
    ['第一轮', `${result.perAttempt[0]} 个请求`, `${HERD.clients} 个客户端同时发。服务端令牌桶：容量 ${HERD.capacity}，每秒补 ${HERD.refillPerSecond}。`],
    ['各轮请求数', result.perAttempt.join(' / '), '第 n 轮 = 第 n 次尝试发出的请求数。'],
    ['重试峰值', `${result.peak} 个 / 100 ms`, '第一轮的齐射不算，只数重试。'],
    ['成功 / 放弃', `${result.succeeded} / ${result.gaveUp}`, '最多重试 4 次。'],
    ['请求总数', String(result.requests), '含所有重试。'],
  ];
}
