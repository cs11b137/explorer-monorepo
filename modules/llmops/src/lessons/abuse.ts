/**
 * 第四课：用户标识与滥用追踪——请求里带不透明的用户标识，按用户限流，屡次触发防护的用户逐级处置。
 *
 * 真实计算的部分（core/abuse.ts）：HMAC-SHA256 生成 metadata.user_id（和直接 SHA-256 对比）、每用户令牌桶和滑动窗口
 * 在同一串泊松到达（固定种子）上真实运行、被拒请求的等待秒数、屡犯记录（OffenderLog）；注入尝试用 direct 课的检测器判定；
 * 放行的请求每个都经 callModel 记账（token、费用、HTTP 字节），被拒的不调用模型。后端回的 429 / 403 用共享包的 HTTP 编码。
 * 模型写的回答是脚本，标 E.G.；限流参数、升级次数是本站的示例策略。tests/narrative.test.ts 核对文案。
 */
import {
  ANTHROPIC_USER_ID_MAX,
  callModel,
  detect,
  encodeJson,
  encodeResponse,
  EXAMPLE_ESCALATION,
  formatUsd,
  makeResponse,
  OffenderLog,
  OPENAI_SAFETY_ID_MAX,
  PerUserBuckets,
  poissonArrivals,
  PRICE_DATE,
  sha256,
  simulate,
  SlidingWindow,
  TEST_SET,
  toHex,
  userIdOf,
  utf8Encode,
  type Admission,
  type MessagesRequest,
  type ModelCall,
  type Sanction,
} from '../core';
import { concept, httpHead, jsonBody, num, preview, utf8Lines, wire } from '../decode/structures';
import { note, pk, render, show, state, type } from './dsl';
import { ACCOUNT, DEMO_MARK, INJECTION_ASK, MODEL, NORMAL_ASK, NORMAL_REPLY, PARAPHRASE_ASK, supportRequest, SYSTEM, USER_ID } from './scenario';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 场景 ----------

/** 刷接口的脚本账号（示例）：把客服当免费的写作工具用。 */
export const BOT_ACCOUNT = 'bulk.writer@example.com';
export const BOT_ID = userIdOf(BOT_ACCOUNT);
export const BOT_ASK = '帮我写一篇 800 字的读后感，题目随便。';
/** 模型对跑题请求的回答（示例）：拒绝也要花输入 token。 */
export const BOT_REPLY = '抱歉，我只能回答小铺订单和售后的问题。';

/** 本站的示例限流：每个用户平均每分钟 10 个请求，两种写法。 */
export const BUCKET = { capacity: 5, refillPerSecond: 1 / 6 };
export const WINDOW = { limit: 10, windowSeconds: 60 };
export const DURATION = 60;
export const BOT_RATE = 1;
export const SEED = 3;
/** 小雨在第 5 秒问了一次（正常用户）。 */
export const XY_AT = 5;

// ---------- 真实计算 ----------

/** 不透明的标识：HMAC（密钥只在后端） vs 直接 SHA-256 vs 原文。 */
export const plainHash = toHex(sha256(ACCOUNT.trim().toLowerCase()));

/** 小雨的请求：带 metadata.user_id。 */
export const xyCall: ModelCall = callModel(supportRequest(NORMAL_ASK), NORMAL_REPLY, 330, XY_AT);

/** 同一分钟：脚本账号泊松到达，小雨一次。 */
export const botArrivals = poissonArrivals(BOT_ID, BOT_RATE, DURATION, SEED);
export const arrivals = [...botArrivals, { at: XY_AT, user: USER_ID }];
export const byBucket: Admission[] = simulate(arrivals, new PerUserBuckets(BUCKET.capacity, BUCKET.refillPerSecond));
export const byWindow: Admission[] = simulate(arrivals, new SlidingWindow(WINDOW.limit, WINDOW.windowSeconds));
const botOf = (list: Admission[]) => list.filter((a) => a.user === BOT_ID);
const okCount = (list: Admission[]) => list.filter((a) => a.result.ok).length;

const botRequest: MessagesRequest = { model: MODEL, max_tokens: 1024, system: SYSTEM, metadata: { user_id: BOT_ID }, messages: [{ role: 'user', content: BOT_ASK }] };
/** 令牌桶放行的脚本请求：每个都真的调用一次模型（回答是示例）。 */
export const botCalls: ModelCall[] = botOf(byBucket).filter((a) => a.result.ok).map((a, i) => callModel(botRequest, BOT_REPLY, 340 + i, Math.floor(a.at)));
const perBotCall = botCalls[0].cost.total;

/** 第一个被拒的请求：后端回 429，retry-after 取等待秒数向上取整。 */
export const firstReject = botOf(byBucket).find((a) => !a.result.ok)!;
export const retryAfter = Math.ceil(firstReject.result.waitSeconds);
const body429 = encodeJson({ error: { type: 'rate_limited', message: '请求太频繁，请稍后再试。' } });
export const response429 = encodeResponse(makeResponse(429, [['content-type', 'application/json'], ['retry-after', String(retryAfter)]], body429.bytes));

/** 屡犯：脚本账号在一小时里发了几次注入，防护层每拦一次记一笔。 */
const pick = (ids: string[]) => ids.map((id) => `${DEMO_MARK}${TEST_SET.find((item) => item.id === id)!.text}`);
export const ATTEMPTS: ReadonlyArray<{ minute: number; text: string }> = [INJECTION_ASK, PARAPHRASE_ASK, ...pick(['inj-03', 'inj-06', 'inj-09'])].map((text, i) => ({ minute: [2, 7, 15, 31, 44][i], text }));
const log = new OffenderLog();
export const strikes = ATTEMPTS.map((a) => {
  const detection = detect(a.text);
  return { ...a, detection, ...(detection.flagged ? log.record(BOT_ID, a.minute * 60) : { count: 0, sanction: 'none' as Sanction }) };
});
const body403 = encodeJson({ error: { type: 'suspended', message: '这个账号因多次触发安全防护已被暂停使用，如有疑问请联系人工客服。' } });
export const response403 = encodeResponse(makeResponse(403, [['content-type', 'application/json']], body403.bytes));

const c0 = xyCall.cost.total;
const c1 = c0 + botCalls.reduce((acc, c) => acc + c.cost.total, 0);

export const SANCTION_LABEL: Record<Sanction, string> = { none: '无', warn: '提醒', throttle: '限流', block: '暂停' };

export const numbers = {
  account: ACCOUNT,
  userId: USER_ID,
  userIdLength: USER_ID.length,
  plainHashLength: plainHash.length,
  anthropicMax: ANTHROPIC_USER_ID_MAX,
  openaiMax: OPENAI_SAFETY_ID_MAX,
  xyInput: xyCall.message.usage.input_tokens,
  xyCost: formatUsd(c0),
  xyCostNano: c0,
  requestBytes: xyCall.http.request.bytes.length,
  botArrivals: botArrivals.length,
  bucketOk: okCount(botOf(byBucket)),
  bucketRejected: botOf(byBucket).length - okCount(botOf(byBucket)),
  windowOk: okCount(botOf(byWindow)),
  xyOk: byBucket.find((a) => a.user === USER_ID)!.result.ok && byWindow.find((a) => a.user === USER_ID)!.result.ok,
  perTen: [0, 10, 20, 30, 40, 50].map((from) => {
    const inRange = (a: Admission) => a.at >= from && a.at < from + 10;
    return { from, arrivals: botOf(byBucket).filter(inRange).length, bucket: okCount(botOf(byBucket).filter(inRange)), window: okCount(botOf(byWindow).filter(inRange)) };
  }),
  firstRejectAt: firstReject.at,
  waitSeconds: firstReject.result.waitSeconds,
  retryAfter,
  perCall: formatUsd(perBotCall),
  botInput: botCalls[0].message.usage.input_tokens,
  botOutput: botCalls[0].message.usage.output_tokens,
  botCost: formatUsd(c1 - c0),
  totalCost: formatUsd(c1),
  totalNano: c1,
  unlimitedCost: formatUsd(botArrivals.length * perBotCall),
  savedCost: formatUsd((botArrivals.length - botCalls.length) * perBotCall),
  attempts: strikes.length,
  flagged: strikes.filter((s) => s.detection.flagged).length,
  ladder: EXAMPLE_ESCALATION.map(([n, s]) => `${n} 次${SANCTION_LABEL[s]}`).join('、'),
  sanctions: strikes.map((s) => SANCTION_LABEL[s.sanction]),
  minutes: strikes.map((s) => s.minute),
  bytes429: response429.bytes.length,
  bytes403: response403.bytes.length,
};
const N = numbers;

// ---------- 图元 ----------

const idGrid = (lift = false): GridPrim => ({
  kind: 'grid',
  id: 'u',
  w: 52,
  rows: ['邮箱', 'SHA-256', 'HMAC'],
  cols: ['字符', '能对上'],
  cells: [
    [{ v: String(ACCOUNT.length), tone: 'amber' }, { v: '是', tone: 'amber' }],
    [{ v: String(plainHash.length), tone: 'amber' }, { v: '能', tone: 'amber' }],
    [{ v: String(USER_ID.length), tone: 'green', lift: lift || undefined }, { v: '否', tone: 'green', lift: lift || undefined }],
  ],
});

function rateGrid(stage: 0 | 1 | 2, liftFirst = false): GridPrim {
  const withWindow = stage === 2;
  return {
    kind: 'grid',
    id: 'b',
    w: 46,
    rows: N.perTen.map((r) => `${r.from}–${r.from + 10}s`),
    cols: ['到达', '桶', '窗口'],
    cells: N.perTen.map((r): DsCell[] => [
      { v: String(r.arrivals), tone: 'blue', heat: r.arrivals / 15 },
      stage ? { v: String(r.bucket), tone: 'green', heat: r.bucket / WINDOW.limit, lift: (liftFirst && r.from === 0) || undefined } : { v: '', tone: 'empty' },
      withWindow ? { v: String(r.window), tone: r.window ? 'green' : 'dim', heat: r.window / WINDOW.limit } : { v: '', tone: 'empty' },
    ]),
  };
}

function strikeRow(upTo: number): RowPrim {
  return {
    kind: 'row',
    id: 'k',
    w: 46,
    cells: strikes.map((s, i): DsCell => (i < upTo ? { v: SANCTION_LABEL[s.sanction], key: `k${i}`, tone: s.sanction === 'warn' ? 'teal' : 'amber', sub: `${s.minute} 分`, lift: i === upTo - 1 || undefined } : { v: '', key: `k${i}`, tone: 'empty', sub: `${s.minute} 分` })),
  };
}

// ---------- 字节层 ----------

const idWire = wire('生成 user_id（本站的写法）', 'mem', 'internal', utf8Lines('user_id', USER_ID, { summary: `${USER_ID.length} 个 ASCII 字符` }), concept('三种写法', [
  ['邮箱原文', ACCOUNT, `文档明确说不要放姓名、邮箱、电话：${ACCOUNT.length} 个字符的个人信息。`],
  ['SHA-256(邮箱)', `${plainHash.slice(0, 16)}…`, `${plainHash.length} 个十六进制字符。不可逆，但谁都能把一批常见邮箱逐个算一遍对上。`],
  ['HMAC-SHA256(密钥, 邮箱)', USER_ID, `取前 32 位加 u_，共 ${USER_ID.length} 个字符；密钥只在后端，外人对不上。`],
], 'slate'), concept('长度上限', [['metadata.user_id', `≤ ${ANTHROPIC_USER_ID_MAX}`, 'Messages API 文档：uuid、哈希值这类不透明的串。'], ['safety_identifier', `≤ ${OPENAI_SAFETY_ID_MAX}`, 'OpenAI：取代了原来的 user 字段，建议哈希用户名或邮箱。']]));
const KEY_MASK = { 'x-api-key': 'sk-ant-api03-'.length };
const xyRequestWire = wire('小雨的请求', 'mem', 'format',
  httpHead('请求头', xyCall.http.request, { mask: KEY_MASK, example: ['x-api-key'] }),
  jsonBody('请求体', encodeJson(xyCall.request), { expand: ['metadata.user_id'], example: ['metadata.user_id'], notes: { 'metadata.user_id': `不透明的用户标识：Anthropic 可能用它帮助发现滥用；${USER_ID.length} 个字符，上限 ${ANTHROPIC_USER_ID_MAX}。` } }));
const xyResponseWire = wire('模型的响应', 'mem', 'format', httpHead('响应头', xyCall.http.response, { example: ['request-id', 'date'] }), jsonBody('响应体', encodeJson(xyCall.message), { example: ['id', 'content', 'usage'] }));

const admitJson = (list: Admission[], label: string) => encodeJson({ limiter: label, user_id: BOT_ID, arrivals: botOf(list).length, admitted: okCount(botOf(list)), rejected: botOf(list).length - okCount(botOf(list)) });
const bucketJson = admitJson(byBucket, `token_bucket(capacity=${BUCKET.capacity}, refill=1/6s)`);
const windowJson = admitJson(byWindow, `sliding_window(limit=${WINDOW.limit}, window=${WINDOW.windowSeconds}s)`);
const limiterWire = (json: typeof bucketJson, label: string, notes: Record<string, string>) => wire(label, 'mem', 'internal', jsonBody('限流结果（本站的写法）', json, { notes }));
const botRequestWire = wire('放行的请求之一', 'mem', 'format', httpHead('请求头', botCalls[0].http.request, { mask: KEY_MASK, example: ['x-api-key'] }), jsonBody('请求体', encodeJson(botCalls[0].request), { example: ['metadata.user_id'], notes: { messages: '跑题的请求：把客服当写作工具。' } }));
const botResponseWire = wire('其中一个响应', 'mem', 'format', httpHead('响应头', botCalls[0].http.response, { example: ['request-id', 'date'] }), jsonBody('响应体', encodeJson(botCalls[0].message), { expand: ['usage.input_tokens'], example: ['id', 'content', 'usage', 'usage.input_tokens'], notes: { content: '拒绝（示例）：拒绝也要付输入 token 的钱。' } }));
const wire429 = wire('后端回的 429（本站后端的写法）', 'mem', 'internal',
  httpHead('响应头', response429, { startNote: '429 Too Many Requests（RFC 6585）：在给定时间里请求太多。', notes: { 'retry-after': `等多少秒再来：令牌桶算出的 ${N.waitSeconds.toFixed(3)} 秒向上取整。` } }),
  jsonBody('响应体', body429, { notes: { error: '本站的写法。' } }));
const wire403 = wire('暂停之后（本站后端的写法）', 'mem', 'internal', httpHead('响应头', response403, { startNote: '403 Forbidden：账号被暂停，重试没用。' }), jsonBody('响应体', body403, { notes: { error: '本站的写法：不说触发了什么规则。' } }));
const strikeJson = (i: number) => encodeJson({ user_id: BOT_ID, minute: strikes[i].minute, flagged_by: strikes[i].detection.by, strikes_in_hour: strikes[i].count, sanction: strikes[i].sanction });
const strikeWire = (i: number) => wire(`第 ${i + 1} 次触发`, 'mem', 'internal', jsonBody('屡犯记录（本站的写法）', strikeJson(i), { notes: { strikes_in_hour: '最近一小时里被防护层拦下的次数。', sanction: `本站的示例阶梯：${N.ladder}。` } }));

// ---------- 事件 ----------

const strikeEvents = strikes.map((s, i) =>
  pk('guard', 'limiter', 'amber', `第 ${i + 1} 次`, [`${s.minute} 分`, SANCTION_LABEL[s.sanction]], [c1, 'LIMIT', `第 ${s.minute} 分钟${i ? '又' : ''}被拦下（${s.detection.by}），一小时内第 ${s.count} 次：${SANCTION_LABEL[s.sanction]}`, strikeJson(i).bytes.length], strikeWire(i), { ds: { buckets: [strikeRow(i + 1)] } }));

export const abuse: Lesson = {
  id: 'abuse',
  name: 'ABUSE',
  title: '用户标识与滥用追踪',
  group: 'safety',
  layer: [1, 3],
  layerNote: '这课从「模型调用」到「防护」：请求里带不透明的 user_id，应用按它给每个用户限流，防护层拦下的次数记在同一个 id 上；被限流、被暂停时用户看到什么，是应用这一层决定的。',
  costNote: `小雨的一次调用（${N.xyCost}），加上令牌桶放行的 ${N.bucketOk} 个脚本请求，每个 ${N.perCall}；被拒的 ${N.bucketRejected} 个和被暂停后的请求不调用模型。`,
  nodes: ['app', 'backend', 'llm', 'limiter', 'guard', 'request', 'buckets'],
  place: { app: [90, 150], backend: [500, 250], llm: [960, 80], limiter: [520, 600], guard: [980, 470], request: [140, 450], buckets: [210, 750] },
  labels: {
    app: ['应用界面', '小雨和一个脚本账号'],
    backend: ['客服后端', '生成 user_id、问限流器'],
    llm: ['模型', MODEL],
    limiter: ['限流器', '按 user_id，屡犯记录'],
    guard: ['防护层', 'direct 课的检测器'],
    request: ['user_id 的三种写法', '字符数、外人能不能对上'],
    buckets: ['脚本账号', '每 10 秒的放行，屡犯的处置'],
  },
  labelAt: { request: [0, 110], buckets: [0, 150] },
  radius: { request: 70, buckets: 70 },
  initial: { request: [], buckets: [] },
  start: ['app', 'backend', 'llm'],
  legend: [['blue', '请求、到达'], ['green', '放行、模型写的回答'], ['amber', '拒绝、拦下、处置'], ['teal', '提醒'], [null, '费用列：累计的模型调用费用']],
  overview: {
    full: '同一个人反复来时，怎样认出他、给他限流、逐级处置',
    description: `防护层一次只看一条消息，滥用却是一串请求：一个脚本账号一分钟发了 ${N.botArrivals} 个跑题的请求，同一个账号一小时里试了 ${N.attempts} 次注入。这一课先用 HMAC 把账号变成不透明的 metadata.user_id，再按它给每个用户一个令牌桶（和滑动窗口对比，同一串请求真的跑一遍），被拒的请求回 429、不进模型；被防护层拦下的次数也记在这个 id 上，按本站的示例阶梯提醒、限流、暂停。`,
    facts: [
      ['user_id', `HMAC，${N.userIdLength} 个字符`],
      ['限流', `令牌桶放行 ${N.bucketOk} / ${N.botArrivals}`],
      ['屡犯', N.ladder],
      ['费用', `${N.totalCost}（示例单价，${PRICE_DATE}）`],
    ],
  },
  steps: [
    {
      title: 'user_id：认得出，但不知道是谁',
      desc: `HMAC 后 ${N.userIdLength} 个字符，放进 metadata.user_id`,
      detail: `限流和追踪都要按用户算，所以请求里要带一个用户标识：Messages API 的 metadata.user_id 文档要求是 uuid、哈希值这类不透明的串，不要放姓名、邮箱、电话，最长 ${N.anthropicMax}，Anthropic 可能用它帮助发现滥用；OpenAI 对应的字段是 safety_identifier（最长 ${N.openaiMax}，原来的 user 字段已被取代）。直接对邮箱做 SHA-256 也不可逆，可谁都能拿一批常见邮箱逐个算一遍对上，所以本站用只在后端的密钥做 HMAC-SHA256，取前 32 个十六进制字符，加上前缀 u_ 共 ${N.userIdLength} 个字符。小雨这次问的是正常问题，请求照常发出，${N.xyCost}。`,
      facts: [['邮箱', `${N.account.length} 个字符，不能放`], ['SHA-256', `${N.plainHashLength} 位，能被对上`], ['HMAC', `${N.userIdLength} 个字符 ≤ ${N.anthropicMax}`], ['费用', N.xyCost]],
      events: [
        type(NORMAL_ASK),
        pk('app', 'backend', 'blue', '小雨的消息', [preview(NORMAL_ASK, 14)], [0, 'CALL', '小雨（chen.xiaoyu）的消息交给后端', utf8Encode(NORMAL_ASK).length], wire('用户的消息', 'mem', 'format', utf8Lines('用户的消息', NORMAL_ASK))),
        show('request'),
        pk('backend', 'request', 'slate', '生成 user_id', ['HMAC-SHA256', `${N.userIdLength} 个字符`], [0, 'CALL', `账号 → u_ + HMAC 前 32 位：${N.userIdLength} 个字符`, N.userIdLength], idWire, { ds: { request: [idGrid()] } }),
        pk('backend', 'llm', 'blue', 'POST /v1/messages', [`${num(N.requestBytes)} 字节`, 'metadata.user_id'], [0, 'HTTP', 'system、metadata.user_id、小雨的问题', N.requestBytes], xyRequestWire, { ds: { request: [idGrid(true)] } }),
        pk('llm', 'backend', 'green', '回答', [preview(NORMAL_REPLY, 12)], [c0, 'INFER', `输入 ${num(N.xyInput)} token，${N.xyCost}`, xyCall.http.response.bytes.length], xyResponseWire),
        state('backend', { user_id: `${USER_ID.slice(0, 8)}…` }),
      ],
    },
    {
      title: '每个用户一个令牌桶',
      desc: `一分钟 ${N.botArrivals} 个请求，放行 ${N.bucketOk} 个`,
      detail: `同一分钟里，一个脚本账号把客服当免费的写作工具，平均每秒发 ${BOT_RATE} 个跑题的请求（泊松到达，固定种子），一共 ${N.botArrivals} 个。限流器按 user_id 给每个用户一个令牌桶（本站的示例：容量 ${BUCKET.capacity}，每 6 秒补 1 个，平均每分钟 10 个）：前 10 秒放行 ${N.perTen[0].bucket} 个（满桶的 ${BUCKET.capacity} 个加上补的），之后每 10 秒只放一两个，一分钟放行 ${N.bucketOk} 个、拒绝 ${N.bucketRejected} 个。小雨在第 ${XY_AT} 秒的请求用的是自己的桶，照常放行；放行的脚本请求每个都要调用模型，就算回答是拒绝也要付输入 token 的钱（每个 ${N.perCall}）。`,
      facts: [['到达', `${N.botArrivals} 个`], ['放行', `${N.bucketOk} 个`], ['小雨', N.xyOk ? '放行（自己的桶）' : '被拒'], [`这 ${N.bucketOk} 次调用`, N.botCost]],
      events: [
        type(BOT_ASK),
        show('limiter', 'buckets'),
        pk('app', 'backend', 'blue', `${N.botArrivals} 个请求`, ['脚本账号', '一分钟'], [c0, 'CALL', `脚本账号一分钟发来 ${N.botArrivals} 个请求`, utf8Encode(BOT_ASK).length], wire('其中一个请求', 'mem', 'format', utf8Lines('用户的消息', BOT_ASK, { summary: `同样的话发了 ${N.botArrivals} 次` })), { ds: { buckets: [rateGrid(0)] } }),
        pk('backend', 'limiter', 'blue', '逐个问限流器', [`user_id ${BOT_ID.slice(0, 8)}…`], [c0, 'LIMIT', `按 user_id 查令牌桶：${N.botArrivals} 个请求逐个判定`, null], wire('问限流器', 'mem', '示意', concept('每个请求', [['user_id', BOT_ID, '按它找到这个用户的桶，新用户满桶。'], ['cost', '1', '每个请求取 1 个令牌。']]))),
        pk('limiter', 'buckets', 'green', '令牌桶', [`放行 ${N.bucketOk}`, `拒绝 ${N.bucketRejected}`], [c0, 'LIMIT', `令牌桶：放行 ${N.bucketOk}、拒绝 ${N.bucketRejected}；小雨的桶是满的`, bucketJson.bytes.length], limiterWire(bucketJson, '令牌桶', { admitted: `开头 ${BUCKET.capacity} 个令牌用完后，每 6 秒补 1 个。` }), { ds: { buckets: [rateGrid(1)] } }),
        state('limiter', { 脚本账号: `放行 ${N.bucketOk} / ${N.botArrivals}`, 小雨: '放行 1 / 1' }),
        pk('backend', 'llm', 'blue', `${N.bucketOk} 次调用`, ['放行的才调用'], [c0, 'HTTP', `放行的 ${N.bucketOk} 个请求各发一次 Messages API`, botCalls[0].http.request.bytes.length], botRequestWire),
        pk('llm', 'backend', 'green', `${N.bucketOk} 个回答`, [preview(BOT_REPLY, 10), `每个 ${N.perCall}`], [c1, 'INFER', `${N.bucketOk} 次调用，每次输入 ${N.botInput}、输出 ${N.botOutput} token，共 ${N.botCost}`, botCalls[0].http.response.bytes.length], botResponseWire),
      ],
    },
    {
      title: '滑动窗口：同样的速率，不同的形状',
      desc: `窗口放行 ${N.windowOk} 个，全挤在前 10 秒`,
      detail: `换成滑动窗口（任意 ${WINDOW.windowSeconds} 秒里最多 ${WINDOW.limit} 个），平均速率一样是每分钟 10 个，同一串请求的结果却不同：前 10 秒放行 ${N.perTen[0].window} 个就满了，之后 50 秒一个都不放，一分钟共 ${N.windowOk} 个。令牌桶允许 ${BUCKET.capacity} 个的突发，之后按补充的速度匀速放行，一分钟 ${N.bucketOk} 个；窗口对「任意一段时间」的上限卡得更死，但被拒的人要等最早那个请求滑出窗口。选哪种取决于想控制什么：控制瞬时压力用小容量的桶，控制一段时间的总量用窗口。`,
      facts: [['令牌桶', `${N.bucketOk} 个，匀速`], ['滑动窗口', `${N.windowOk} 个，前 10 秒用完`], ['平均速率', '都是每分钟 10 个'], ['参数', '本站的示例']],
      events: [
        pk('limiter', 'buckets', 'green', '滑动窗口', [`放行 ${N.windowOk}`], [c1, 'LIMIT', `同一串请求换成滑动窗口：放行 ${N.windowOk}，前 10 秒就用完`, windowJson.bytes.length], limiterWire(windowJson, '滑动窗口', { admitted: `窗口 (now − ${WINDOW.windowSeconds}, now] 里最多 ${WINDOW.limit} 个。` }), { ds: { buckets: [rateGrid(2)] } }),
        note('buckets', `桶 ${N.bucketOk} 个 vs 窗口 ${N.windowOk} 个`),
      ],
    },
    {
      title: '被拒的请求：429，不进模型',
      desc: `retry-after: ${N.retryAfter}，被拒的 ${N.bucketRejected} 个都是 $0`,
      detail: `第一个被拒的请求在第 ${N.firstRejectAt} 秒，桶里的令牌还差一点，要等 ${N.waitSeconds.toFixed(2)} 秒，后端回 429 Too Many Requests 和 retry-after: ${N.retryAfter}（RFC 6585 的写法，客户端怎样按它退避重试见 CONTEXT EXPLORER 的「限流、错误与重试」课，那里是 API 对你的组织限流，这里是你的后端对你的用户限流）。被拒的请求根本不调用模型，所以费用列不动：这一分钟要是不限流，${N.botArrivals} 个请求要花 ${N.unlimitedCost}，限流省下了 ${N.savedCost}，OWASP 把这类风险列为 LLM10:2025 无限制消耗。`,
      facts: [['状态码', '429 Too Many Requests'], ['retry-after', `${N.retryAfter} 秒`], ['不限流', N.unlimitedCost], ['省下', N.savedCost]],
      events: [
        pk('limiter', 'backend', 'amber', '拒绝', [`第 ${N.firstRejectAt} 秒`, `等 ${N.waitSeconds.toFixed(2)} 秒`], [c1, 'LIMIT', `第 ${N.firstRejectAt} 秒的请求：桶空了，要等 ${N.waitSeconds.toFixed(2)} 秒`, null], wire('限流器的回答', 'mem', '示意', concept('结果', [['ok', 'false', '不放行。'], ['waitSeconds', N.waitSeconds.toFixed(3), '令牌补到 1 个还要多久。']])), { ds: { buckets: [rateGrid(2, true)] } }),
        pk('backend', 'app', 'amber', '429', [`retry-after: ${N.retryAfter}`], [c1, 'LIMIT', `回 429 和 retry-after: ${N.retryAfter}，不调用模型`, N.bytes429], wire429),
        state('backend', { 被拒: `${N.bucketRejected} 个` }),
        note('app', `限流省下 ${N.savedCost}`, 'green'),
      ],
    },
    {
      title: '屡次触发防护：逐级处置',
      desc: `一小时 ${N.attempts} 次注入：${N.sanctions.join('、')}`,
      detail: `同一个账号接着试注入，${N.attempts} 次都被 direct 课的检测器拦下，每拦一次就在它的 user_id 上记一笔，按最近一小时的次数处置（本站的示例阶梯：${N.ladder}）。Anthropic 文档建议对反复试图绕过防护的用户调整回应、考虑限流或封禁，但没有规定次数，阈值要按自己的误拦率定：检测器会误伤正常用户，第一次只提醒，攒够次数才升级。第 ${N.minutes[4]} 分钟第 ${N.attempts} 次之后账号被暂停，之后的请求直接回 403，不再调用模型。`,
      facts: [['尝试', `${N.attempts} 次，拦下 ${N.flagged}`], ['阶梯', N.ladder], ['最后', N.sanctions[N.sanctions.length - 1]], ['依据', 'Anthropic 文档 + 本站示例']],
      events: [
        show('guard'),
        pk('backend', 'guard', 'blue', '注入尝试', [preview(ATTEMPTS[0].text, 12)], [c1, 'SCREEN', `第 ${ATTEMPTS[0].minute} 分钟：脚本账号发来注入，交给防护层`, utf8Encode(ATTEMPTS[0].text).length], wire('用户的消息', 'mem', 'format', utf8Lines('用户的消息', ATTEMPTS[0].text, { summary: '演示用的注入文本' })), { ds: { buckets: [strikeRow(0)] } }),
        ...strikeEvents,
        state('limiter', { 脚本账号: '暂停', 小雨: '正常' }),
        pk('backend', 'app', 'amber', '403', ['账号已暂停'], [c1, 'LIMIT', `暂停之后的请求：回 403，不调用模型`, N.bytes403], wire403),
        render,
        note('limiter', `${N.attempts} 次 → 暂停`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '按人算账：标识、限流、升级',
    desc: `令牌桶放行 ${N.bucketOk} / ${N.botArrivals}，${N.attempts} 次触发后暂停`,
    text: `单条消息的检查挡不住一串请求，滥用要按人算：请求里带 HMAC 生成的不透明 user_id，Anthropic 可能用它帮助发现滥用，自己的后端用它限流和记账。令牌桶和滑动窗口平均速率相同，形状不同，同一串请求放行 ${N.bucketOk} 和 ${N.windowOk} 个；被拒的回 429、不进模型，这一分钟省下 ${N.savedCost}。屡次触发防护的账号逐级提醒、限流、暂停，阶梯和限额都是本站的示例，要按自己的流量和误拦率定。安全组接下来换个角度：主动去攻击自己的防护，用攻击成功率衡量它挡得住多少。`,
    facts: [['user_id', `${N.userIdLength} 个字符`], ['令牌桶 / 窗口', `${N.bucketOk} / ${N.windowOk}`], ['省下', N.savedCost], ['下一课', '红队测试与攻击成功率']],
  },
};
