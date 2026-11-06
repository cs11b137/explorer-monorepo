/**
 * MCP 组第五课：Streamable HTTP 传输与授权。每条消息一个 POST 到同一个 MCP 端点，Accept 同时列 application/json 和 text/event-stream，
 * 响应是一个 JSON 对象或这个请求自己的 SSE 流；MCP-Protocol-Version、Mcp-Method、Mcp-Name 三个头镜像请求体，对不上回 400 + -32020，
 * 不安全的值写成 =?base64?…?=；2026-07-28 版没有会话（旧版的 Mcp-Session-Id、GET 端点作为对比）；
 * 服务器开了授权以后：401 → RFC 9728 受保护资源元数据 → 授权服务器元数据 → 授权请求（PKCE、resource）→ 令牌 → 带 Bearer 重试。
 *
 * HTTP 报文由 core/mcp/http.ts 真实编码和处理（mcpPost、serveHttp、checkHeaders、encodeHeaderValue），元数据和授权请求由 core/mcp/auth.ts 生成。
 * 示例值（E.G.）：SSE 里的进度通知、授权服务器的元数据、授权码、令牌、PKCE 的 code_verifier 和 code_challenge（本站不算 SHA-256）。
 * 这课不调用模型，输入列一直是 0。tests/narrative.mcp.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  ACCEPT,
  asMetadataUrls,
  authorizationUrl,
  createShop,
  decodeHeaderValue,
  encodeHeaderValue,
  encodeJson,
  encodeRequest,
  encodeResponse,
  encodeStream,
  headerOf,
  HOST_CLIENT_INFO,
  httpTransport,
  makeRequest,
  makeResponse,
  MCP_ENDPOINT,
  MCP_HOST,
  MCP_PATH,
  McpClient,
  mcpPost,
  ORDER_ID,
  parseWwwAuthenticate,
  prmUrls,
  protectedResourceMetadata,
  PROTOCOL_VERSION,
  readHttpResponse,
  rpcNotification,
  rpcRequest,
  serveHttp,
  SHOP_SERVER_INFO,
  shopServer,
  type HttpRequest,
  type HttpResponse,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '../core';
import { concept, httpHead, jsonBody, preview, sseBody, utf8Lines, wire } from '../decode/structures';
import type { LayerWriter } from '../decode/writer';
import { note, pk, show, state } from './dsl';
import { POLICY_QUERY } from './scenario';
import type { Color, DsCell, GridPrim, Lesson, NodeId, PacketEvent, RowPrim, TraceType } from './types';

// ---------- 真实运行 ----------

export const shop = createShop();
export const server = shopServer({ shop });

/** 前四步：服务器还没开授权（比如在内网试用）。每条消息一个 POST，经 serveHttp 处理。 */
export const PROGRESS_TOKEN = 'search-1';
export const progress = [
  rpcNotification('notifications/progress', { progressToken: PROGRESS_TOKEN, progress: 1, total: 2, message: '切词' }),
  rpcNotification('notifications/progress', { progressToken: PROGRESS_TOKEN, progress: 2, total: 2, message: '打分' }),
];
const isSearch = (message: JsonRpcMessage) => 'method' in message && message.method === 'tools/call' && message.params?.name === 'search_policy';
export const transport = httpTransport(server, {}, (message) => (isSearch(message) ? { sse: true, notifications: progress } : {}));
export const client = new McpClient(transport.send, { info: HOST_CLIENT_INFO });

/** ① tools/call get_order：回一个 JSON 对象。 */
export const call = client.callTool('get_order', { order_id: ORDER_ID });
export const first = transport.exchanges[0];

/** ② tools/call search_policy，带 progressToken：服务器回这个请求自己的 SSE 流，先两条进度通知，最后是响应。 */
export const search = client.callTool('search_policy', { query: POLICY_QUERY }, { _meta: { progressToken: PROGRESS_TOKEN } });
export const streamed = transport.exchanges[1];
export const sseStream = encodeStream([...progress, search.response].map((item) => ({ data: JSON.stringify(item) })));

/** ③ 头和体对不上：体里是 create_return，Mcp-Name 头却写着 get_order（比如中间某一层改了头）。 */
export const tamperedMessage: JsonRpcRequest = rpcRequest(3, 'tools/call', { name: 'create_return', arguments: { order_id: ORDER_ID, reason: 'quality', note: '杯盖漏水' }, _meta: client.meta() });
const honest = mcpPost(tamperedMessage);
export const tampered: HttpRequest = { ...honest, headers: honest.headers.map(([name, value]) => [name, name === 'mcp-name' ? 'get_order' : value]) };
export const mismatch = serveHttp(server, tampered);
const mismatchError = (readHttpResponse(mismatch)[0] as JsonRpcError).error;
/** 规范 Value Encoding 一节的例子，用 encodeHeaderValue 逐个算。 */
export const ENCODING_EXAMPLES = ['us-west1', 'Hello, 世界', ' padded ', 'line1\nline2', '=?base64?literal?='];
export const encoded = ENCODING_EXAMPLES.map((value) => encodeHeaderValue(value));

/** ④ 旧版客户端的习惯：GET 打开 SSE 流（2025-11-25 及以前）→ 405；请求里带着 Mcp-Session-Id → 忽略，也不回会话 id。 */
export const legacyGet = makeRequest('GET', MCP_PATH, [['host', MCP_HOST], ['accept', 'text/event-stream']]);
export const legacyGetResponse = serveHttp(server, legacyGet);
export const OLD_SESSION = '1868a90c-old-session';
const listMessage = rpcRequest(4, 'tools/list', { _meta: client.meta() });
const listPost = mcpPost(listMessage);
export const withSession: HttpRequest = { ...listPost, headers: [...listPost.headers.slice(0, -1), ['mcp-session-id', OLD_SESSION], listPost.headers[listPost.headers.length - 1]] };
export const withSessionResponse = serveHttp(server, withSession);

/** ⑤ 服务器开了授权：不带令牌回 401，WWW-Authenticate 指向受保护资源元数据。 */
export const AUTH_ISSUER = 'https://auth.xiaopu.example';
export const SCOPES = ['orders:read', 'returns:write'];
export const PRM_URL = prmUrls(MCP_ENDPOINT)[0];
/** 授权服务器发的访问令牌（示例）。 */
export const TOKEN = 'xp_at_4f9c1e7b2d6a';
const guard = { token: TOKEN, resourceMetadata: PRM_URL, scope: SCOPES.join(' ') };
const protectedMessage = rpcRequest(5, 'tools/call', { name: 'get_order', arguments: { order_id: ORDER_ID }, _meta: client.meta() });
export const unauthorized = mcpPost(protectedMessage);
export const challenge = serveHttp(server, unauthorized, guard);
export const parsedChallenge = parseWwwAuthenticate(headerOf(challenge.headers, 'www-authenticate')!);

/** 客户端按 resource_metadata 取元数据文档（RFC 9728）。 */
export const prmDoc = protectedResourceMetadata(MCP_ENDPOINT, [AUTH_ISSUER], { scopes: SCOPES, name: SHOP_SERVER_INFO.title });
const prmPath = new URL(parsedChallenge.params.resource_metadata).pathname;
export const prmGet = makeRequest('GET', prmPath, [['host', MCP_HOST], ['accept', 'application/json']]);
export const prmResponse = makeResponse(200, [['content-type', 'application/json']], JSON.stringify(prmDoc));

/** 再按 MCP 规定的顺序找授权服务器的元数据（RFC 8414）；文档内容是示例。 */
export const asUrls = asMetadataUrls(prmDoc.authorization_servers[0]);
export const asDoc = {
  issuer: AUTH_ISSUER,
  authorization_endpoint: `${AUTH_ISSUER}/authorize`,
  token_endpoint: `${AUTH_ISSUER}/token`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};
const asUrl = new URL(asUrls[0]);
export const asGet = makeRequest('GET', asUrl.pathname, [['host', asUrl.host], ['accept', 'application/json']]);
export const asResponse = makeResponse(200, [['content-type', 'application/json']], JSON.stringify(asDoc));

/** ⑥ 授权请求（经浏览器）、回调、换令牌、带 Bearer 重试。PKCE 的一对值取自 RFC 7636 附录 B 的例子（code_challenge = BASE64URL(SHA-256(code_verifier))），本站不算 SHA-256，测试里用 node:crypto 核对。 */
export const CLIENT_ID = 'https://agent.xiaopu.example/client.json';
export const REDIRECT = 'http://127.0.0.1:8765/callback';
export const STATE = 'st-81f0';
export const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
export const authorizeUrl = authorizationUrl({ authorizationEndpoint: asDoc.authorization_endpoint, clientId: CLIENT_ID, redirectUri: REDIRECT, scope: parsedChallenge.params.scope, state: STATE, codeChallenge: CODE_CHALLENGE, resource: prmDoc.resource });
export const CODE = 'ac_5b2e9f';
export const callbackUrl = `${REDIRECT}?${new URLSearchParams({ code: CODE, state: STATE, iss: AUTH_ISSUER }).toString()}`;
const tokenUrl = new URL(asDoc.token_endpoint);
export const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: CODE, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: CODE_VERIFIER, resource: prmDoc.resource }).toString();
export const tokenPost = makeRequest('POST', tokenUrl.pathname, [['host', tokenUrl.host], ['content-type', 'application/x-www-form-urlencoded'], ['accept', 'application/json']], tokenBody);
export const tokenDoc = { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' ') };
export const tokenResponse = makeResponse(200, [['content-type', 'application/json'], ['cache-control', 'no-store']], JSON.stringify(tokenDoc));
export const authorized = mcpPost(rpcRequest(6, 'tools/call', { name: 'get_order', arguments: { order_id: ORDER_ID }, _meta: client.meta() }), { token: TOKEN });
export const authorizedResponse = serveHttp(server, authorized, guard);

// ---------- 文案用到的数 ----------

const reqBytes = (req: HttpRequest) => encodeRequest(req).bytes.length;
const resBytes = (res: HttpResponse) => encodeResponse(res).bytes.length;
const header = (msg: HttpRequest | HttpResponse, name: string) => headerOf(msg.headers, name);

export const numbers = {
  firstReq: reqBytes(first.request),
  firstRes: resBytes(first.response),
  firstStatus: first.response.status,
  firstType: header(first.response, 'content-type'),
  headerNames: first.request.headers.map(([name]) => name),
  mcpName: header(first.request, 'mcp-name'),
  bodyBytes: first.request.body.length,
  sseStatus: streamed.response.status,
  sseType: header(streamed.response, 'content-type'),
  sseEvents: readHttpResponse(streamed.response).length,
  sseBytes: streamed.response.body.length,
  sseSame: JSON.stringify(sseStream.bytes) === JSON.stringify(streamed.response.body),
  accelBuffering: header(streamed.response, 'x-accel-buffering'),
  mismatchStatus: mismatch.status,
  mismatchCode: mismatchError.code,
  mismatchMessage: mismatchError.message,
  createdReturns: shop.returns.length,
  encoded,
  roundTrip: encoded.map((value) => decodeHeaderValue(value)).every((value, i) => value === ENCODING_EXAMPLES[i]),
  getStatus: legacyGetResponse.status,
  getAllow: header(legacyGetResponse, 'allow'),
  sessionStatus: withSessionResponse.status,
  sessionEchoed: header(withSessionResponse, 'mcp-session-id') !== undefined,
  challengeStatus: challenge.status,
  challengeHeader: header(challenge, 'www-authenticate')!,
  prmUrl: PRM_URL,
  prmUrls: prmUrls(MCP_ENDPOINT),
  prmBytes: prmResponse.body.length,
  asUrls,
  asTried: 1,
  authorizeParams: [...new URL(authorizeUrl).searchParams.keys()],
  authorizeBytes: utf8Encode(authorizeUrl).length,
  tokenReq: reqBytes(tokenPost),
  finalStatus: authorizedResponse.status,
  finalReq: reqBytes(authorized),
  authBytes: utf8Encode(`Bearer ${TOKEN}`).length,
  exchanges: transport.exchanges.length,
};
const N = numbers;

// ---------- 图元 ----------

/** 这个请求的三个镜像头和请求体里对应的值。 */
function mirrorGrid(req: HttpRequest, message: JsonRpcRequest | null, hot: 'name' | 'auth' | null = null): GridPrim {
  const bodyVersion = message ? String((message.params?._meta as Record<string, unknown>)?.['io.modelcontextprotocol/protocolVersion'] ?? '—') : '—';
  const bodyName = message ? String(message.params?.name ?? message.params?.uri ?? '—') : '—';
  const auth = header(req, 'authorization');
  const cell = (v: string | undefined, tone: DsCell['tone']): DsCell => ({ v: v ?? '没有', tone: v === undefined ? 'dim' : tone });
  return {
    kind: 'grid',
    id: 'h',
    w: 60,
    rows: ['版本', 'method', 'name', '令牌'],
    cols: ['头', '体'],
    cells: [
      [cell(header(req, 'mcp-protocol-version'), 'slate'), { v: bodyVersion, tone: 'blue' }],
      [cell(header(req, 'mcp-method') ?? (message ? undefined : req.method), 'slate'), { v: message?.method ?? '—', tone: 'blue' }],
      [cell(header(req, 'mcp-name'), hot === 'name' ? 'amber' : 'slate'), { v: bodyName, tone: hot === 'name' ? 'amber' : 'blue' }],
      [cell(auth ? 'Bearer' : undefined, hot === 'auth' ? 'amber' : 'violet'), { v: '—', tone: 'dim' }],
    ],
  };
}

/** 每次往返的状态码，按顺序。 */
interface StatusMark { status: number; sub: string; tone: DsCell['tone'] }
const statusRow = (marks: StatusMark[]): RowPrim => ({ kind: 'row', id: 's', w: 44, cells: marks.map((mark, i): DsCell => ({ v: String(mark.status), sub: mark.sub, tone: mark.tone, key: `s${i}`, lift: i === marks.length - 1 || undefined })) });
const STATUS: StatusMark[] = [
  { status: first.response.status, sub: 'JSON', tone: 'teal' },
  { status: streamed.response.status, sub: 'SSE', tone: 'teal' },
  { status: mismatch.status, sub: '-32020', tone: 'amber' },
  { status: legacyGetResponse.status, sub: 'GET', tone: 'amber' },
  { status: withSessionResponse.status, sub: '无会话', tone: 'teal' },
  { status: challenge.status, sub: '要令牌', tone: 'amber' },
  { status: prmResponse.status, sub: '元数据', tone: 'violet' },
  { status: asResponse.status, sub: '授权', tone: 'violet' },
  { status: tokenResponse.status, sub: '令牌', tone: 'violet' },
  { status: authorizedResponse.status, sub: 'Bearer', tone: 'teal' },
];
const statuses = (n: number) => statusRow(STATUS.slice(0, n));

// ---------- 字节层 ----------

const TOKEN_MASK = { authorization: 'Bearer '.length };
const MIRROR_NOTES = {
  host: 'MCP 服务器的主机（示例域名）。',
  accept: '必须同时列出 application/json 和 text/event-stream：服务器可以任选一种回。',
  'mcp-protocol-version': '必须等于请求体 _meta 里的协议版本。',
  'mcp-method': '镜像请求体的 method。',
  'mcp-name': 'tools/call、prompts/get 镜像 params.name，resources/read 镜像 params.uri。',
  'content-length': '请求体的字节数。',
};

function postWire(at: string, req: HttpRequest, notes: Record<string, string> = {}, bodyNotes: Record<string, string> = {}, extra: LayerWriter[] = []) {
  const auth = header(req, 'authorization') !== undefined;
  return wire(at, 'mem', 'format',
    httpHead('请求头', encodeRequest(req), { mask: auth ? TOKEN_MASK : undefined, example: auth ? ['authorization'] : [], notes: { ...MIRROR_NOTES, ...(auth ? { authorization: '访问令牌（示例，打码）：每个请求都要带，不能放进查询串。' } : {}), ...notes } }),
    jsonBody('请求体', encodeJson(JSON.parse(new TextDecoder().decode(new Uint8Array(req.body)))), { notes: bodyNotes }),
    ...extra);
}

function jsonResWire(at: string, res: HttpResponse, notes: Record<string, string> = {}, bodyNotes: Record<string, string> = {}, example: string[] = [], bodyExample: string[] = []) {
  const layers: LayerWriter[] = [httpHead('响应头', encodeResponse(res), { notes, example })];
  if (res.body.length) layers.push(jsonBody('响应体', encodeJson(JSON.parse(new TextDecoder().decode(new Uint8Array(res.body)))), { color: 'teal', notes: bodyNotes, example: bodyExample }));
  return wire(at, 'mem', 'format', ...layers);
}

const getWire = (at: string, req: HttpRequest, notes: Record<string, string> = {}) => wire(at, 'mem', 'format', httpHead('请求头', encodeRequest(req), { notes }));

/** MCP 服务器、授权服务器之外的一次 HTTP（浏览器里的跳转等）：只有 URL。 */
const urlWire = (at: string, name: string, url: string, summary: string, extra: LayerWriter[] = []) => wire(at, 'mem', 'format', utf8Lines(name, url, { summary }), ...extra);

const hp = (from: NodeId, to: NodeId, color: Color, label: string, payload: string[], type: TraceType, info: string, size: number, w: ReturnType<typeof wire>, ds?: PacketEvent['ds']): PacketEvent => pk(from, to, color, label, payload, [0, type, info, size], w, ds ? { ds } : {});

// ---------- 课程 ----------

export const http: Lesson = {
  id: 'http',
  name: 'HTTP',
  title: 'Streamable HTTP 传输与授权',
  group: 'mcp',
  layer: [1, 3],
  layerNote: '这课在下面三档：「传输」看 HTTP 报文和 SSE 流，「JSON-RPC」看请求体里的消息和 -32020，「能力」看版本头和 OAuth 授权。',
  tokensNote: '这课只有 HTTP 往返，不调用模型，所以一直是 0。',
  nodes: ['client', 'server', 'authz', 'request', 'response'],
  place: { client: [180, 330], server: [900, 330], authz: [540, 110], request: [210, 640], response: [720, 660] },
  labels: {
    client: ['MCP 客户端', 'Streamable HTTP'],
    server: ['MCP 服务器', `POST ${MCP_HOST}${MCP_PATH}`],
    authz: ['授权服务器', AUTH_ISSUER.replace('https://', '')],
    request: ['镜像头和请求体', '对不上就拒绝'],
    response: ['每次往返的状态码', '按顺序'],
  },
  labelAt: { request: [0, 150], response: [-200, 50] },
  radius: { request: 80, response: 70 },
  initial: { request: [], response: [] },
  start: ['client', 'server'],
  legend: [['blue', 'MCP 请求'], ['teal', '成功的响应'], ['amber', '拒绝、出错'], ['violet', '授权：元数据、令牌'], ['slate', '头'], [null, '输入列：这课不调用模型，一直是 0']],
  overview: {
    full: '每条消息一个 POST，没有会话',
    description: `Streamable HTTP 是连接远程 MCP 服务器的传输：服务器只有一个端点（这里是 ${MCP_ENDPOINT}），客户端的每条消息都是一个单独的 POST，响应是一个 JSON 对象，或者只属于这个请求的一条 SSE 流。${PROTOCOL_VERSION} 版要求把协议版本、方法名、工具名镜像到 HTTP 头里，让网关不解析 JSON 也能路由，对不上就拒绝；同时去掉了会话。最后两步服务器开启授权：客户端从 401 出发，找到授权服务器，拿到令牌再重试。`,
    facts: [
      ['端点', `POST ${MCP_PATH}`],
      ['Accept', ACCEPT],
      ['镜像头', 'MCP-Protocol-Version、Mcp-Method、Mcp-Name'],
      ['授权', 'OAuth 2.1，RFC 9728 元数据，Bearer'],
      ['输入列', '0（不调用模型）'],
    ],
  },
  steps: [
    {
      title: '每条消息一个 POST',
      desc: `tools/call：请求 ${N.firstReq} 字节，回 ${N.firstStatus} JSON`,
      detail: `客户端把 tools/call 放进 POST ${MCP_PATH} 的请求体，Accept 同时列出 application/json 和 text/event-stream，表示两种回法都接得住。请求头还要镜像请求体里的三个值：MCP-Protocol-Version 等于 _meta 里的版本，Mcp-Method 是 method，Mcp-Name 是工具名 ${N.mcpName}；规范说这样负载均衡、网关、监控这类中间层不解析请求体也能路由和查看（头名不区分大小写，本站写成小写）。这次服务器回 ${N.firstStatus}，content-type 是 ${N.firstType}，响应体就是那条 JSON-RPC 结果。`,
      facts: [['请求', `${N.firstReq} 字节，体 ${N.bodyBytes} 字节`], ['镜像头', `版本 ${PROTOCOL_VERSION}，tools/call，${N.mcpName}`], ['响应', `${N.firstStatus}，${N.firstType}`], ['响应大小', `${N.firstRes} 字节`]],
      events: [
        hp('client', 'server', 'blue', 'POST tools/call', [`Mcp-Name: ${N.mcpName}`, `${N.firstReq} 字节`], 'HTTP', `POST ${MCP_PATH}：tools/call get_order，三个镜像头 + Accept 两种类型`, N.firstReq, postWire('POST /mcp', first.request, {}, { 'params': 'name、arguments 和 _meta：头里的三个值都从这里来。' }), { request: [mirrorGrid(first.request, call.request)], response: [] }),
        show('request', 'response'),
        hp('server', 'client', 'teal', `${N.firstStatus} application/json`, ['一条 JSON-RPC 结果'], 'HTTP', `${N.firstStatus}：content-type ${N.firstType}，响应体是 tools/call 的结果`, N.firstRes, jsonResWire('200 JSON', first.response, { 'content-type': 'application/json：一个 JSON 对象，就是这条 JSON-RPC 响应。' }), { response: [statuses(1)] }),
      ],
    },
    {
      title: '或者回这个请求自己的 SSE 流',
      desc: `${N.sseEvents} 个事件：${progress.length} 条进度通知 + 结果`,
      detail: `这次 tools/call search_policy 在 _meta 里带了 progressToken，服务器选择用 SSE 回复：content-type 是 text/event-stream，流里先是 ${progress.length} 条 notifications/progress，最后一个事件是响应本身，之后流就结束，整条流 ${N.sseBytes} 字节。这条流只属于这一个请求，不会混进别的请求的消息；服务器还带了 X-Accel-Buffering: no，让 nginx 这类反向代理别攒着不发。要取消这个请求，客户端关掉这条流就行，HTTP 上不发 notifications/cancelled。`,
      facts: [['content-type', N.sseType!], ['事件', `${N.sseEvents} 个（进度 ${progress.length} + 结果 1）`], ['流', `${N.sseBytes} 字节`], ['取消', '关掉这条流']],
      events: [
        hp('client', 'server', 'blue', 'POST tools/call', [`progressToken ${PROGRESS_TOKEN}`], 'HTTP', `POST：tools/call search_policy，_meta 带 progressToken`, reqBytes(streamed.request), postWire('POST /mcp', streamed.request, {}, { params: '_meta 里多了 progressToken：客户端想收进度通知。' }), { request: [mirrorGrid(streamed.request, search.request)] }),
        hp('server', 'client', 'teal', `${N.sseStatus} text/event-stream`, progress.map((item) => `进度 ${String(item.params!.progress)}/${String(item.params!.total)}`).concat('结果'), 'SSE', `${N.sseStatus}：SSE 流 ${N.sseEvents} 个事件，进度通知在前，结果在最后`, resBytes(streamed.response), wire('200 SSE', 'mem', 'format', httpHead('响应头', encodeResponse(streamed.response), { notes: { 'content-type': 'text/event-stream：这个请求自己的 SSE 流。', 'cache-control': 'no-cache：别缓存流。', 'x-accel-buffering': 'no：让 nginx 这类反向代理不要缓冲，事件马上送到。' } }), sseBody('SSE 流', sseStream, { notes: { 0: '进度通知（示例）：progressToken 对上请求里的那个。', 1: '第二条进度通知（示例），progress 必须一次比一次大。', 2: '最后一个事件是 JSON-RPC 响应，之后流结束。' } })), { response: [statuses(2)] }),
      ],
    },
    {
      title: '头和体对不上：400 + -32020',
      desc: `Mcp-Name 写 get_order，体里是 create_return`,
      detail: `假设中间某一层把 Mcp-Name 改成了 get_order，请求体里却是 create_return：网关可能按头把它当成只读查询放行或计数，服务器却按体去建退货单，规范正是为了防这种两边各信一份的漏洞，要求处理请求体的服务器逐个核对头和体。这台服务器回 ${N.mismatchStatus} 和 ${N.mismatchCode} HeaderMismatch，什么都没执行，退货单还是 ${N.createdReturns} 张。头里放不下的值（非 ASCII、控制字符、首尾空格）要写成 =?base64?…?=，比如「Hello, 世界」写成 ${N.encoded[1]}，服务器先解码再比较。`,
      facts: [['状态码', `${N.mismatchStatus}`], ['错误码', `${N.mismatchCode} HeaderMismatch`], ['执行了吗', `没有，退货单 ${N.createdReturns} 张`], ['编码', `Hello, 世界 → ${N.encoded[1]}`]],
      events: [
        hp('client', 'server', 'amber', 'POST（头被改了）', ['Mcp-Name: get_order', '体：create_return'], 'HTTP', 'Mcp-Name 头是 get_order，请求体的 params.name 是 create_return', reqBytes(tampered), postWire('头和体对不上的 POST', tampered, { 'mcp-name': 'get_order：和请求体的 params.name（create_return）不一样。' }, {}, [concept('Value Encoding（规范的五个例子，encodeHeaderValue 逐个算）', ENCODING_EXAMPLES.map((value, i): [string, string, string] => [JSON.stringify(value), encoded[i], i === 0 ? '可见 ASCII，原样放。' : i === 4 ? '本身像编码的写法，也要编码，免得混淆。' : '放不进头，UTF-8 再 base64。']))]), { request: [mirrorGrid(tampered, tamperedMessage, 'name')] }),
        hp('server', 'client', 'amber', `${N.mismatchStatus} -32020`, ['HeaderMismatch', '没有执行'], 'ERROR', `${N.mismatchStatus}：${preview(N.mismatchMessage, 60)}`, resBytes(mismatch), jsonResWire('400 HeaderMismatch', mismatch, {}, { error: `${N.mismatchCode}：HeaderMismatch，规范给的错误码（-32020 ~ -32099 归规范）。` }), { response: [statuses(3)] }),
        state('server', { 退货单: `${N.createdReturns} 张`, 校验: '头 = 体' }),
      ],
    },
    {
      title: '没有会话，也没有 GET',
      desc: `GET 回 ${N.getStatus}；Mcp-Session-Id 被忽略`,
      detail: `${PROTOCOL_VERSION} 版的 Streamable HTTP 没有会话：旧版（2025-03-26 到 2025-11-25）里服务器可以在 initialize 的响应头里发一个 Mcp-Session-Id，之后每个请求都带着它，用 DELETE 结束，会话过期回 404、客户端重新握手；旧版还能用 GET 打开一条收服务器消息的 SSE 流，用 Last-Event-ID 续传。现在这些都没有了：一个照旧习惯发 GET 的客户端收到 ${N.getStatus}（allow: ${N.getAllow}），请求里带着旧的 Mcp-Session-Id 也只是被忽略，照常回 ${N.sessionStatus}，响应里没有会话 id。每个 POST 自带版本、能力和令牌，服务器不需要记得之前的连接；想跨请求记东西，要用显式的 id（比如工具参数里的句柄）。`,
      facts: [['GET', `${N.getStatus}，allow: ${N.getAllow}`], ['Mcp-Session-Id', `忽略，回 ${N.sessionStatus}`], ['续传', '没有（不再有 Last-Event-ID）'], ['跨请求的状态', '显式的 id']],
      events: [
        hp('client', 'server', 'slate', 'GET /mcp（旧习惯）', ['accept: text/event-stream'], 'HTTP', '旧版客户端用 GET 打开 SSE 流，等服务器主动发消息', reqBytes(legacyGet), getWire('GET /mcp', legacyGet, { accept: '旧版（2025-11-25 及以前）用 GET 打开一条收服务器消息的 SSE 流。' }), { request: [mirrorGrid(legacyGet, null)] }),
        hp('server', 'client', 'amber', `${N.getStatus} Method Not Allowed`, [`allow: ${N.getAllow}`], 'HTTP', `${N.getStatus}：MCP 端点只接受 POST`, resBytes(legacyGetResponse), jsonResWire('405', legacyGetResponse, { allow: 'POST：只接受 POST。' }), { response: [statuses(4)] }),
        hp('client', 'server', 'blue', 'POST + Mcp-Session-Id', [`mcp-session-id: ${preview(OLD_SESSION, 12)}`], 'HTTP', `tools/list 的 POST 带着旧的 mcp-session-id: ${OLD_SESSION}`, reqBytes(withSession), postWire('带旧会话头的 POST', withSession, { 'mcp-session-id': '旧版的会话头（示例值）。新版的服务器忽略它，也不发、不回显会话 id。' }), { request: [mirrorGrid(withSession, listMessage)] }),
        hp('server', 'client', 'teal', `${N.sessionStatus}，没有会话 id`, ['tools/list 结果'], 'HTTP', `${N.sessionStatus}：照常回 tools/list 的结果，响应头里没有 mcp-session-id`, resBytes(withSessionResponse), jsonResWire('200 JSON', withSessionResponse, { 'content-type': '响应头里没有 mcp-session-id。' }), { response: [statuses(5)] }),
      ],
    },
    {
      title: '开了授权：401 → 元数据 → 授权服务器',
      desc: 'WWW-Authenticate 指向受保护资源元数据',
      detail: `服务器放到公网后开了授权：它是 OAuth 2.1 的资源服务器，不带令牌的 POST 回 ${N.challengeStatus}，WWW-Authenticate 里的 resource_metadata 指向受保护资源元数据（RFC 9728），scope 写明这次要的权限。客户端去取这份文档，里面的 authorization_servers 列出授权服务器 ${AUTH_ISSUER}；要是头里没有 resource_metadata，就先试 ${N.prmUrls[0].replace('https://' + MCP_HOST, '')}、再试根上的 ${N.prmUrls[1].replace('https://' + MCP_HOST, '')}。再按规定的顺序取授权服务器的元数据（RFC 8414 的地址先试），从里面拿到授权端点、令牌端点和支持的 PKCE 方法。`,
      facts: [['401', 'WWW-Authenticate: Bearer resource_metadata, scope'], ['元数据', `${N.prmBytes} 字节，authorization_servers 1 个`], ['scope', SCOPES.join(' ')], ['授权服务器元数据', `先试 ${preview(N.asUrls[0].replace(AUTH_ISSUER, ''), 40)}`]],
      events: [
        show('authz'),
        hp('client', 'server', 'blue', 'POST（没有令牌）', ['tools/call get_order'], 'HTTP', 'POST tools/call，没有 Authorization 头', reqBytes(unauthorized), postWire('没有令牌的 POST', unauthorized), { request: [mirrorGrid(unauthorized, protectedMessage, 'auth')] }),
        hp('server', 'client', 'amber', `${N.challengeStatus} Unauthorized`, ['WWW-Authenticate', 'resource_metadata'], 'AUTH', `${N.challengeStatus}：WWW-Authenticate: ${preview(N.challengeHeader, 50)}`, resBytes(challenge), jsonResWire('401', challenge, { 'www-authenticate': `Bearer：resource_metadata 指向元数据文档，scope 是这次需要的权限（${SCOPES.join(' ')}）。` }), { response: [statuses(6)] }),
        hp('client', 'server', 'violet', 'GET 元数据', [prmPath], 'AUTH', `按 resource_metadata 取受保护资源元数据：GET ${prmPath}`, reqBytes(prmGet), getWire('GET 受保护资源元数据', prmGet, { host: 'MCP 服务器自己提供这份文档。' })),
        hp('server', 'client', 'violet', `${prmResponse.status} 元数据`, [`authorization_servers`, AUTH_ISSUER.replace('https://', '')], 'AUTH', `RFC 9728 元数据：resource、authorization_servers、scopes_supported`, resBytes(prmResponse), jsonResWire('受保护资源元数据', prmResponse, {}, { resource: 'MCP 服务器的规范 URI：之后的 resource 参数就填它。', authorization_servers: 'MCP 要求至少一个。', scopes_supported: '支持的权限。', bearer_methods_supported: 'header：令牌放在 Authorization 头里。', resource_name: '给人看的名字。' }), { response: [statuses(7)] }),
        hp('client', 'authz', 'violet', 'GET 授权服务器元数据', [asUrl.pathname], 'AUTH', `GET ${asUrls[0]}（规定顺序里的第 1 个）`, reqBytes(asGet), wire('GET 授权服务器元数据', 'mem', 'format', httpHead('请求头', encodeRequest(asGet)), concept('要依次试的地址（asMetadataUrls）', asUrls.map((url, i): [string, string, string] => [`${i + 1}`, url, i === 0 ? 'RFC 8414（OAuth 2.0 授权服务器元数据）。' : 'OpenID Connect Discovery。'])))),
        hp('authz', 'client', 'violet', `${asResponse.status} 元数据（示例）`, ['authorize · token', 'S256'], 'AUTH', '授权服务器元数据（示例）：授权端点、令牌端点、code_challenge_methods_supported', resBytes(asResponse), jsonResWire('授权服务器元数据（示例）', asResponse, {}, { issuer: '必须和用来拼地址的 issuer 一模一样，否则不能用。', code_challenge_methods_supported: 'S256：支持 PKCE。RFC 8414 说省略这一项表示不支持 PKCE。' }, [], ['issuer', 'authorization_endpoint', 'token_endpoint', 'response_types_supported', 'code_challenge_methods_supported']), { response: [statuses(8)] }),
      ],
    },
    {
      title: '拿到令牌，带 Bearer 重试',
      desc: `授权请求带 PKCE 和 resource，重试回 ${N.finalStatus}`,
      detail: `客户端在浏览器里打开授权地址，参数有 response_type=code、client_id（这里是一个元数据文档的 URL）、redirect_uri、scope、state、PKCE 的 code_challenge 和 code_challenge_method=S256，以及 resource，即 MCP 服务器的规范 URI（RFC 8707）；code_challenge 是 code_verifier 的 SHA-256 再 base64url，这里的一对值取自 RFC 7636 附录 B 的例子，本站不算 SHA-256。用户同意后，浏览器带着 code、state、iss 回到 redirect_uri，客户端核对 iss 后，用 code 和 code_verifier（再带一次 resource）去令牌端点换访问令牌。之后每个 POST 都带 Authorization: Bearer 令牌（不能放进查询串），同一个 tools/call 这次回 ${N.finalStatus}。`,
      facts: [['授权请求参数', `${N.authorizeParams.length} 个，含 resource`], ['PKCE', 'S256（RFC 7636 的例子）'], ['令牌', 'Bearer，示例值'], ['重试', `${N.finalStatus}，请求 ${N.finalReq} 字节`]],
      events: [
        hp('client', 'authz', 'violet', '授权请求（浏览器）', ['code_challenge · S256', 'resource'], 'AUTH', `浏览器打开授权地址：${N.authorizeParams.length} 个参数，含 PKCE 和 resource`, N.authorizeBytes, urlWire('授权请求', '授权地址', authorizeUrl, `${N.authorizeParams.length} 个参数：${N.authorizeParams.join('、')}`, [concept('参数', [...new URL(authorizeUrl).searchParams.entries()].map(([key, value]): [string, string, string?] => [key, preview(value, 40), key === 'code_challenge' ? 'code_verifier 的 SHA-256 再 base64url。这对值取自 RFC 7636 附录 B 的例子，本站不算。' : key === 'resource' ? 'MCP 服务器的规范 URI（RFC 8707）：令牌只给这台服务器用。' : key === 'client_id' ? 'Client ID 元数据文档的地址（示例）。' : undefined]))])),
        hp('authz', 'client', 'violet', '回调：code', ['code · state · iss'], 'AUTH', `用户同意后跳回 redirect_uri：带 code、state、iss（示例值）`, utf8Encode(callbackUrl).length, urlWire('回调', '回调地址（示例）', callbackUrl, 'code、state、iss 都是示例值')),
        hp('client', 'authz', 'violet', 'POST /token', ['code + code_verifier', 'resource'], 'AUTH', `用 code 和 code_verifier 换令牌，再带一次 resource`, N.tokenReq, wire('令牌请求', 'mem', 'format', httpHead('请求头', encodeRequest(tokenPost)), utf8Lines('请求体（示例值）', tokenBody, { summary: 'application/x-www-form-urlencoded' }))),
        hp('authz', 'client', 'violet', '访问令牌', ['token_type Bearer', `expires_in ${tokenDoc.expires_in}`], 'AUTH', '令牌响应（示例）：access_token、token_type、expires_in、scope', resBytes(tokenResponse), jsonResWire('令牌响应（示例）', tokenResponse, {}, { access_token: '访问令牌（示例）。' }, [], ['access_token', 'expires_in']), { response: [statuses(9)] }),
        hp('client', 'server', 'blue', 'POST + Bearer', ['Authorization: Bearer ···'], 'HTTP', `同一个 tools/call，带上 Authorization: Bearer 令牌（${N.authBytes} 字节的值）`, N.finalReq, postWire('带令牌的 POST', authorized), { request: [mirrorGrid(authorized, JSON.parse(new TextDecoder().decode(new Uint8Array(authorized.body))) as JsonRpcRequest)] }),
        hp('server', 'client', 'teal', `${N.finalStatus} application/json`, ['tools/call 结果'], 'HTTP', `令牌对了：${N.finalStatus}，照常回 tools/call 的结果`, resBytes(authorizedResponse), jsonResWire('200 JSON', authorizedResponse), { response: [statuses(10)] }),
        note('server', '令牌每个请求都带', 'green'),
      ],
    },
  ],
  outro: {
    title: '一个端点、每条消息一个 POST',
    desc: `出现过的状态码：${[...new Set(STATUS.map((item) => item.status))].join('、')}`,
    text: `Streamable HTTP 只有一个只收 POST 的端点：每条消息一个 POST，Accept 两种类型都列，响应是一个 JSON 对象或这个请求自己的 SSE 流，取消就是关掉那条流。三个镜像头让中间层不解析 JSON 也能路由，对不上回 400 和 ${N.mismatchCode}，放不下的值用 =?base64?…?= 编码。${PROTOCOL_VERSION} 版没有会话、没有 GET、不能续传，这些是旧版的写法。开了授权的服务器从 401 开始，经 RFC 9728 的元数据找到授权服务器，带 PKCE 和 resource 换来令牌，之后每个请求带 Bearer。MCP 组到这里讲完；下一组看几个 Agent 怎样分工：编排者与子 Agent。`,
    facts: [['端点', `POST ${MCP_PATH}`], ['头不一致', `400 + ${N.mismatchCode}`], ['会话', '没有'], ['下一课', '编排者与子 Agent']],
  },
};
