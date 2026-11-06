/**
 * MCP 组第一课：无状态协议。2026-07-28 版没有 initialize 握手，每个请求在 params._meta 里自带协议版本、客户端能力和 clientInfo；
 * 想事先知道服务器支持什么就调 server/discover。缺必填字段回 -32602，版本不支持回 -32022（data 带 supported / requested），
 * 客户端从 supported 里选一个、用新的 id 重发。最后一步对比旧版（2025-11-25 及以前）的 initialize / notifications/initialized 握手。
 *
 * 全部消息由 core/mcp 的 McpClient 和 shopServer 真实处理（这课不经传输层，直接看 JSON-RPC 消息；stdio、HTTP 在后两课）。
 * 这课不调用模型，轨迹表的输入列一直是 0。tests/narrative.mcp.test.ts 核对文案。
 *
 * 文件后半部分导出 MCP 组各课共用的小工具（消息格子、JSON-RPC 的字节层、发包的简写）。
 */
import {
  createShop,
  directTransport,
  encodeJson,
  HOST_CLIENT_INFO,
  isError,
  isNotification,
  isRequest,
  LEGACY_VERSIONS,
  McpClient,
  META,
  PROTOCOL_VERSION,
  RPC_NAME,
  rpcNotification,
  rpcRequest,
  SHOP_SERVER_INFO,
  shopServer,
  type Exchange,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcResult,
  type ServerCapabilities,
} from '../core';
import { concept, jsonBody, num, wire, type JsonOptions } from '../decode/structures';
import type { LayerWriter } from '../decode/writer';
import { pk, show, note, state } from './dsl';
import type { Color, DsCell, GridPrim, Lesson, NodeId, PacketEvent, RowPrim, TraceType } from './types';

// ---------- MCP 组共用的小工具 ----------

/** 一条消息序列化后的字节数（紧凑 JSON，和 stdio 的一行、HTTP 的消息体相同）。 */
export const bytesOf = (message: unknown): number => encodeJson(message).bytes.length;

/** 方法名的最后一段：tools/list → list，server/discover → discover。 */
const shortMethod = (method: string): string => method.split('/').pop()!;

/** 消息格子：请求写 id（蓝），结果写 id（青），错误写错误码（琥珀），通知写「通知」（灰）。 */
export function msgCell(message: JsonRpcMessage, key: string, lift = false): DsCell {
  if (isRequest(message)) return { v: String(message.id), sub: shortMethod(message.method), tone: 'blue', key, lift: lift || undefined };
  if (isNotification(message)) return { v: '通知', sub: shortMethod(message.method), tone: 'slate', key, lift: lift || undefined };
  if (isError(message)) return { v: String(message.error.code), sub: '错误', tone: 'amber', key, lift: lift || undefined };
  return { v: String((message as JsonRpcResult).id), sub: '结果', tone: 'teal', key, lift: lift || undefined };
}

/** 一排消息格子：按收发顺序，最后一格抬起。 */
export const rpcRow = (id: string, messages: ReadonlyArray<JsonRpcMessage>, options: { w?: number; title?: string } = {}): RowPrim => ({
  kind: 'row',
  id,
  w: options.w ?? 46,
  cells: messages.map((message, index) => msgCell(message, `${id}${index}`, index === messages.length - 1)),
  title: options.title,
});

/** _meta 三个键在请求体里的路径。 */
export const META_PATH = {
  meta: 'params._meta',
  version: `params._meta.${META.protocolVersion}`,
  info: `params._meta.${META.clientInfo}`,
  caps: `params._meta.${META.clientCapabilities}`,
} as const;

export const META_NOTES: Record<string, string> = {
  [META_PATH.meta]: '每个请求都带的协议元数据。2026-07-28 版没有握手，服务器只看这个请求自己的 _meta。',
  [META_PATH.version]: '必填：这个请求用的协议版本。',
  [META_PATH.info]: '建议带：客户端的名字和版本（自报的，只用于显示和日志）。',
  [META_PATH.caps]: '必填：和这个请求有关的客户端能力。这个客户端没声明任何可选能力，所以是空对象。',
};

/** 一条 JSON-RPC 消息的字节层（format）。 */
export const rpcLayer = (name: string, message: unknown, options: JsonOptions = {}): LayerWriter => jsonBody(name, encodeJson(message), { color: 'blue', ...options });

/** 只有一条 JSON-RPC 消息的解码结构。 */
export const rpcWire = (at: string, message: unknown, options: JsonOptions = {}, ...extra: LayerWriter[]) => wire(at, 'mem', 'format', rpcLayer('JSON-RPC 消息', message, options), ...extra);

/** MCP 组不调用模型时的发包：轨迹的输入列是 0（README「本站约定」）。 */
export function rpcPk(from: NodeId, to: NodeId, color: Color, label: string, payload: string[], type: TraceType, info: string, message: unknown, w: ReturnType<typeof wire>, ds?: PacketEvent['ds'], tokens = 0): PacketEvent {
  return pk(from, to, color, label, payload, [tokens, type, info, bytesOf(message)], w, ds ? { ds } : {});
}

/** 请求或响应的颜色：请求蓝，结果青，错误琥珀，通知灰。 */
export const colorOf = (message: JsonRpcMessage): Color => (isRequest(message) ? 'blue' : isNotification(message) ? 'slate' : isError(message) ? 'amber' : 'teal');

const errorOf = (exchange: Exchange): JsonRpcError['error'] => (exchange.response as JsonRpcError).error;
const resultOf = (exchange: Exchange) => (exchange.response as JsonRpcResult).result;

// ---------- 真实运行 ----------

export const shop = createShop();
export const server = shopServer({ shop });
export const client = new McpClient(directTransport(server), { info: HOST_CLIENT_INFO });

/** ① server/discover：带着 _meta 问服务器支持什么。 */
export const discovery = client.discover();
const discovered = resultOf(discovery) as JsonRpcResult['result'] & { supportedVersions: string[]; capabilities: ServerCapabilities; instructions: string; ttlMs: number; cacheScope: string };

/** ② 一个手写的脚本漏了 clientCapabilities：-32602。 */
export const missingRequest = rpcRequest(2, 'tools/list', { _meta: { [META.protocolVersion]: PROTOCOL_VERSION, [META.clientInfo]: HOST_CLIENT_INFO } });
export const missingResponse = server.handle(missingRequest) as JsonRpcError;
/** 补上之后同一个方法通过（用新的 id）。 */
export const listed = client.request('tools/list', {}, 3);

/** ③ 版本不对：写了一个服务器不认识的版本（规范的例子用 1900-01-01）。 */
export const BAD_VERSION = '1900-01-01';
export const wrongVersion = client.request('tools/list', { _meta: { [META.protocolVersion]: BAD_VERSION } }, 4);
const versionError = errorOf(wrongVersion) as { code: number; message: string; data: { supported: string[]; requested: string } };
/** 从 supported 里选一个，用新的 id 重发。 */
export const chosen = versionError.data.supported[0];
export const retried = client.request('tools/list', { _meta: { [META.protocolVersion]: chosen } }, 5);

/** ④ 旧版（2025-11-25 及以前）的握手：initialize 请求，参数里是 protocolVersion、capabilities、clientInfo。打到只支持新版的服务器上。 */
export const LEGACY = LEGACY_VERSIONS[0];
export const initializeRequest = rpcRequest(6, 'initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: HOST_CLIENT_INFO });
export const initializeResponse = server.handle(initializeRequest) as JsonRpcError;
/** 旧版握手成功后客户端要发的通知（这里只算字节，不发）。 */
export const initializedNote = rpcNotification('notifications/initialized');

// ---------- 文案用到的数 ----------

const metaSpan = (message: unknown) => {
  const json = encodeJson(message);
  const span = json.spans.find((item) => item.path === META_PATH.meta)!;
  return span.to - span.from;
};
const toolsOf = (exchange: Exchange) => (resultOf(exchange).tools as unknown[]).length;

export const numbers = {
  discoverBytes: bytesOf(discovery.request),
  metaBytes: metaSpan(discovery.request),
  metaKeys: Object.keys(discovery.request.params!._meta as object).length,
  discoverResultBytes: bytesOf(discovery.response),
  supported: discovered.supportedVersions,
  capabilityKinds: Object.keys(discovered.capabilities),
  ttlMs: discovered.ttlMs,
  ttlMinutes: discovered.ttlMs / 60_000,
  cacheScope: discovered.cacheScope,
  instructionsChars: [...discovered.instructions].length,
  missingCode: missingResponse.error.code,
  missing: (missingResponse.error.data as { missing: string[] }).missing,
  missingBytes: bytesOf(missingResponse),
  listedTools: toolsOf(listed),
  versionCode: versionError.code,
  versionMessage: versionError.message,
  requested: versionError.data.requested,
  retriedTools: toolsOf(retried),
  initializeCode: initializeResponse.error.code,
  initializeBytes: bytesOf(initializeRequest),
  initializedBytes: bytesOf(initializedNote),
  handshakeBytes: bytesOf(initializeRequest) + bytesOf(initializedNote),
  legacy: LEGACY,
  legacyCount: LEGACY_VERSIONS.length,
  oldest: LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1],
};
const N = numbers;

// ---------- 图元 ----------

const shortCaps = (caps: object): string => (Object.keys(caps).length ? Object.keys(caps).join('、') : '{}');

/** 客户端这个请求的 _meta：版本、clientInfo、能力。 */
function metaGrid(meta: Record<string, unknown>, tones: Partial<Record<'version' | 'info' | 'caps', DsCell['tone']>> = {}, col = '_meta'): GridPrim {
  const version = meta[META.protocolVersion];
  const info = meta[META.clientInfo] as { name: string } | undefined;
  const caps = meta[META.clientCapabilities] as object | undefined;
  return {
    kind: 'grid',
    id: 'c',
    w: 62,
    rows: ['版本', 'clientInfo', '能力'],
    cols: [col],
    cells: [
      [{ v: String(version), tone: tones.version ?? 'blue' }],
      [{ v: info ? info.name : '没写', tone: tones.info ?? 'slate' }],
      [caps ? { v: shortCaps(caps), tone: tones.caps ?? 'blue' } : { v: '缺', tone: 'amber' }],
    ],
  };
}

const metaOf = (message: { params?: Record<string, unknown> }): Record<string, unknown> => (message.params?._meta as Record<string, unknown>) ?? {};

/** server/discover 返回的东西。 */
const discoverGrid = (): GridPrim => ({
  kind: 'grid',
  id: 's',
  w: 54,
  rows: ['版本', 'tools', 'resources', 'prompts', 'ttlMs', 'cacheScope'],
  cols: ['discover'],
  cells: [
    [{ v: N.supported.join(' '), tone: 'teal' }],
    ...(['tools', 'resources', 'prompts'] as const).map((kind): DsCell[] => [{ v: discovered.capabilities[kind] ? '有' : '没有', tone: 'violet' }]),
    [{ v: String(N.ttlMs), tone: 'slate' }],
    [{ v: N.cacheScope, tone: 'slate' }],
  ],
});

/** 旧版和新版的对比。 */
const compareGrid = (): GridPrim => ({
  kind: 'grid',
  id: 's',
  w: 54,
  rows: ['版本能力', '之后请求', '进程重启'],
  cols: ['旧版', '新版'],
  cells: [
    [{ v: '握手一次', tone: 'slate' }, { v: '每次都带', tone: 'teal' }],
    [{ v: '靠会话', tone: 'slate' }, { v: '自带 _meta', tone: 'teal' }],
    [{ v: '重新握手', tone: 'slate' }, { v: '直接重发', tone: 'teal' }],
  ],
});

/** 这课的消息序列（rpc 节点）。 */
const SEQ: JsonRpcMessage[] = [
  discovery.request, discovery.response,
  missingRequest, missingResponse,
  listed.request, listed.response,
  wrongVersion.request, wrongVersion.response,
  retried.request, retried.response,
  initializeRequest, initializeResponse,
];
const seq = (n: number): RowPrim => rpcRow('r', SEQ.slice(0, n), { w: 44 });

// ---------- 字节层 ----------

const requestOpts = (notes: Record<string, string> = {}): JsonOptions => ({
  expand: [META_PATH.meta, META_PATH.version, META_PATH.info, META_PATH.caps],
  notes: { id: '请求的编号：字符串或整数，不能是 null。响应按它对回来。', method: '要调用的方法。', ...META_NOTES, ...notes },
});

const resultLayer = (exchange: Exchange, notes: Record<string, string>) => rpcLayer('JSON-RPC 结果', exchange.response, { color: 'teal', root: 'result', notes });

export const discover: Lesson = {
  id: 'discover',
  name: 'DISCOVER',
  title: '无状态协议：版本、能力与 server/discover',
  group: 'mcp',
  layer: [2, 3],
  layerNote: '这课在「JSON-RPC」和「能力」两档：看一条条请求、结果和错误码，以及版本和能力怎样随每个请求声明。',
  tokensNote: '这课只有客户端和服务器之间的 JSON-RPC 消息，不调用模型，所以一直是 0。',
  nodes: ['client', 'server', 'caps', 'catalog', 'rpc'],
  place: { client: [230, 200], server: [830, 200], caps: [210, 480], catalog: [840, 490], rpc: [590, 720] },
  labels: {
    client: ['MCP 客户端', `${HOST_CLIENT_INFO.name} ${HOST_CLIENT_INFO.version}`],
    server: ['MCP 服务器', `${SHOP_SERVER_INFO.title}（${SHOP_SERVER_INFO.name}）`],
    caps: ['这个请求声明的', '版本、clientInfo、能力'],
    catalog: ['服务器报上的', 'server/discover 的结果'],
    rpc: ['消息', '请求写 id，错误写错误码'],
  },
  labelAt: { caps: [0, 150], catalog: [0, 170], rpc: [-240, 40] },
  radius: { caps: 80, catalog: 80, rpc: 70 },
  initial: { rpc: [], caps: [], catalog: [] },
  start: ['client', 'server'],
  legend: [['blue', '请求'], ['teal', '结果'], ['amber', '错误'], ['violet', '服务器的能力'], [null, '输入列：这课不调用模型，一直是 0']],
  overview: {
    full: '没有握手：每个请求自己说清楚版本和能力',
    description: `MCP（Model Context Protocol）是 Agent 连接外部工具和数据的协议，消息格式是 JSON-RPC 2.0。最新正式版 ${PROTOCOL_VERSION} 把协议做成了无状态的：没有 initialize 握手，每个请求都在 params._meta 里带上协议版本和客户端能力，服务器一个请求一个请求地独立处理。这一课的客户端先用 server/discover 问服务器支持什么，再故意漏掉字段、写错版本，看服务器回什么错误；最后对比旧版的握手。`,
    facts: [
      ['协议版本', `${PROTOCOL_VERSION}（最新正式版）`],
      ['每个请求带', 'protocolVersion、clientCapabilities（必填），clientInfo（建议）'],
      ['错误码', `${N.missingCode} 缺字段，${N.versionCode} 版本不支持`],
      ['消息', `${SEQ.length} 条`],
      ['输入列', '0（不调用模型）'],
    ],
  },
  steps: [
    {
      title: '每个请求自带版本和能力',
      desc: `server/discover，${N.discoverBytes} 字节`,
      detail: `客户端发出的每个请求，params 里都有一个 _meta 对象，带 ${N.metaKeys} 个保留键：protocolVersion（必填）、clientCapabilities（必填）和 clientInfo（建议带）。这个客户端没有声明任何可选能力，clientCapabilities 是空对象 {}。第一个请求是 server/discover，除了 _meta 没有别的参数，整条 ${N.discoverBytes} 字节，其中 _meta 占 ${N.metaBytes} 字节。`,
      facts: [['方法', 'server/discover'], ['id', String(discovery.request.id)], ['_meta', `${N.metaBytes} 字节，${N.metaKeys} 个键`], ['整条', `${N.discoverBytes} 字节`]],
      events: [
        rpcPk('client', 'server', 'blue', 'server/discover', [`id ${discovery.request.id}`, `_meta：${N.metaKeys} 个键`], 'DISCOVER', `server/discover：_meta 带协议版本 ${PROTOCOL_VERSION}、clientInfo、clientCapabilities`, discovery.request, rpcWire('server/discover 请求', discovery.request, requestOpts()), { caps: [metaGrid(metaOf(discovery.request))], rpc: [seq(1)] }),
        show('caps', 'rpc'),
      ],
    },
    {
      title: 'server/discover：服务器报上自己',
      desc: `${N.capabilityKinds.length} 种能力，ttlMs ${num(N.ttlMs)}`,
      detail: `服务器必须实现 server/discover，客户端可以不调，直接发别的请求、版本不对时再按错误处理。结果里有 supportedVersions、capabilities（这台服务器声明了 ${N.capabilityKinds.join('、')}）、写给模型看的 instructions，_meta 里是 serverInfo；所有结果都有 resultType，这里是 complete。ttlMs ${num(N.ttlMs)} 是说客户端可以把这份结果当作 ${N.ttlMinutes} 分钟内新鲜，cacheScope 是 ${N.cacheScope}，表示里面没有某个用户自己的数据，共享的网关也可以缓存。`,
      facts: [['supportedVersions', N.supported.join('、')], ['capabilities', N.capabilityKinds.join('、')], ['缓存', `ttlMs ${num(N.ttlMs)}，${N.cacheScope}`], ['大小', `${N.discoverResultBytes} 字节`]],
      events: [
        show('catalog'),
        rpcPk('server', 'client', 'teal', 'DiscoverResult', [`版本 ${N.supported.join(' ')}`, N.capabilityKinds.join(' · ')], 'DISCOVER', `结果：supportedVersions、${N.capabilityKinds.length} 种能力、instructions，ttlMs ${N.ttlMs}`, discovery.response, wire('server/discover 结果', 'mem', 'format', resultLayer(discovery, {
          'result.resultType': 'complete：普通的结果。另一种是 input_required（服务器还要客户端补充信息）。',
          'result.supportedVersions': '服务器支持的协议版本。客户端之后的请求从里面选一个。',
          'result.capabilities': `服务器的能力：${N.capabilityKinds.join('、')}。listChanged 是 false：列表变了也不会发通知。`,
          'result.instructions': `写给模型看的使用说明（${N.instructionsChars} 个字）。`,
          'result.ttlMs': `${N.ttlMinutes} 分钟内可以直接用缓存，不必再问。`,
          'result.cacheScope': 'public：不含某个用户的私有数据，网关和代理也可以缓存。',
          'result._meta': 'serverInfo：服务器自报的名字和版本，只用于显示和日志，不能据此做安全判断。',
        })), { catalog: [discoverGrid()], rpc: [seq(2)] }),
        state('server', { 状态: '不记任何连接状态', 支持: N.supported.join(' ') }),
      ],
    },
    {
      title: '缺了必填字段：-32602',
      desc: `漏写 clientCapabilities`,
      detail: `假如客户端（比如一段手写的脚本）发 tools/list 时漏了 clientCapabilities，服务器回 ${N.missingCode}（Invalid params），data.missing 列出缺的键；规范要求这样的请求一律拒绝，走 HTTP 时状态码是 400。服务器不会去「回忆」这个客户端之前声明过什么，因为协议规定它不能依靠同一连接上之前的请求。补上字段、换一个新 id 重发，同一个 tools/list 就通过了，返回 ${N.listedTools} 个工具。`,
      facts: [['错误码', `${N.missingCode} ${RPC_NAME[N.missingCode]}`], ['data.missing', N.missing.map((key) => key.replace('io.modelcontextprotocol/', '')).join('、')], ['HTTP 上', '400 Bad Request'], ['补上之后', `id ${listed.request.id}，${N.listedTools} 个工具`]],
      events: [
        rpcPk('client', 'server', 'blue', 'tools/list（缺字段）', [`id ${missingRequest.id}`, '没有 clientCapabilities'], 'RPC', `tools/list 的 _meta 只有 protocolVersion 和 clientInfo，缺 clientCapabilities`, missingRequest, rpcWire('缺字段的请求', missingRequest, { expand: [META_PATH.meta], notes: { [META_PATH.meta]: '只有两个键：少了必填的 io.modelcontextprotocol/clientCapabilities。' } }), { caps: [metaGrid(metaOf(missingRequest))], rpc: [seq(3)] }),
        rpcPk('server', 'client', 'amber', `${N.missingCode} Invalid params`, ['data.missing', 'clientCapabilities'], 'ERROR', `${N.missingCode}：缺 _meta 的必填字段，data.missing 列出缺了哪个`, missingResponse, rpcWire('错误响应', missingResponse, { color: 'amber', root: 'error', notes: { 'error.code': `${N.missingCode}：Invalid params。`, 'error.data': '缺了哪些键（本站的写法：data.missing）。' } }), { rpc: [seq(4)] }),
        rpcPk('client', 'server', 'blue', 'tools/list', [`id ${listed.request.id}`, '_meta 补齐'], 'RPC', `补上 clientCapabilities，用新的 id ${listed.request.id} 重发`, listed.request, rpcWire('补齐后的请求', listed.request, requestOpts()), { caps: [metaGrid(metaOf(listed.request))], rpc: [seq(5)] }),
        rpcPk('server', 'client', 'teal', `${N.listedTools} 个工具`, ['tools/list 结果'], 'RPC', `通过：tools/list 返回 ${N.listedTools} 个工具（下一课细看）`, listed.response, wire('tools/list 结果', 'mem', 'format', resultLayer(listed, { 'result.tools': `${N.listedTools} 个工具的定义，下一课细看。` })), { rpc: [seq(6)] }),
      ],
    },
    {
      title: '版本不对：-32022，换一个重发',
      desc: `requested ${N.requested}，supported ${N.supported.join('、')}`,
      detail: `这次 _meta 里写的版本是 ${N.requested}（规范举例用的值），服务器不支持，回 ${N.versionCode} ${N.versionMessage}，data 里写着 supported 和 requested。没有协商握手：客户端从 supported 里选 ${chosen}，用新的 id ${retried.request.id} 把同一个请求重发一次，就拿到了 ${N.retriedTools} 个工具。也可以像第一步那样先调 server/discover，一开始就选对版本。`,
      facts: [['错误码', `${N.versionCode} ${RPC_NAME[N.versionCode]}`], ['requested', N.requested], ['supported', N.supported.join('、')], ['重发', `id ${retried.request.id}，版本 ${chosen}`]],
      events: [
        rpcPk('client', 'server', 'blue', `tools/list（${N.requested}）`, [`id ${wrongVersion.request.id}`, `版本 ${N.requested}`], 'RPC', `_meta 里的版本写成 ${N.requested}`, wrongVersion.request, rpcWire('版本不对的请求', wrongVersion.request, requestOpts({ [META_PATH.version]: `${N.requested}：服务器不认识的版本（规范的例子）。` })), { caps: [metaGrid(metaOf(wrongVersion.request), { version: 'amber' })], rpc: [seq(7)] }),
        rpcPk('server', 'client', 'amber', `${N.versionCode} 版本不支持`, [`supported ${N.supported.join(' ')}`, `requested ${N.requested}`], 'ERROR', `${N.versionCode} Unsupported protocol version：data 带 supported 和 requested`, wrongVersion.response, rpcWire('UnsupportedProtocolVersionError', wrongVersion.response, { color: 'amber', root: 'error', expand: ['error.data.supported', 'error.data.requested'], notes: { 'error.code': `${N.versionCode}：UnsupportedProtocolVersion，MCP 规范自己的错误码（-32020 ~ -32099 归规范）。`, 'error.data.supported': '服务器支持的版本，客户端从里面选一个重发。', 'error.data.requested': '请求里写的版本。' } }), { rpc: [seq(8)] }),
        rpcPk('client', 'server', 'blue', `tools/list（${chosen}）`, [`id ${retried.request.id}`, `版本 ${chosen}`], 'RPC', `从 supported 里选 ${chosen}，新的 id ${retried.request.id} 重发`, retried.request, rpcWire('重发的请求', retried.request, requestOpts({ [META_PATH.version]: `${chosen}：从 supported 里选的。` })), { caps: [metaGrid(metaOf(retried.request))], rpc: [seq(9)] }),
        rpcPk('server', 'client', 'teal', `${N.retriedTools} 个工具`, ['tools/list 结果'], 'RPC', `版本对了，返回 ${N.retriedTools} 个工具`, retried.response, wire('tools/list 结果', 'mem', 'format', resultLayer(retried, {})), { rpc: [seq(10)] }),
      ],
    },
    {
      title: '对比旧版：initialize 握手',
      desc: `旧版先握手，新版每个请求多带 ${N.metaBytes} 字节`,
      detail: `${N.legacy} 及以前的旧版（规范称 legacy）要先握手：客户端发 initialize 报上版本、能力和 clientInfo，服务器回自己的版本和能力，客户端再发 notifications/initialized，之后的请求不再带能力和 clientInfo，全靠这个会话记着。这台服务器只支持新版，收到 initialize 回 ${N.initializeCode}，错误里写出支持的版本（规范建议写出版本，错误码由实现决定）。规范 Statelessness 一节说，处理一个请求需要的信息都在请求自己里面，服务器不应要求客户端复用同一条连接或同一个进程；stdio 一页也写着，服务器进程意外退出后，客户端重启它、把没回来的请求重发就行。`,
      facts: [['旧版握手', `initialize ${N.initializeBytes} 字节 + initialized ${N.initializedBytes} 字节`], ['新版', `每个请求的 _meta ${N.metaBytes} 字节`], ['这台服务器', `initialize 回 ${N.initializeCode}`], ['旧版本', `${N.legacy} 到 ${N.oldest}，共 ${N.legacyCount} 个`]],
      events: [
        rpcPk('client', 'server', 'slate', 'initialize（旧版）', [`id ${initializeRequest.id}`, `protocolVersion ${N.legacy}`], 'RPC', `旧版客户端的第一条消息：initialize，版本 ${N.legacy}`, initializeRequest, rpcWire('旧版的 initialize 请求', initializeRequest, {
          color: 'slate',
          expand: ['params.protocolVersion', 'params.capabilities', 'params.clientInfo'],
          notes: { method: `initialize：旧版（${N.legacy} 及以前）连接上的第一条消息。`, 'params.protocolVersion': '旧版在握手时协商版本，之后的请求不再带。', 'params.capabilities': '旧版在握手时声明一次能力，整个会话都按它。', 'params.clientInfo': '旧版的 clientInfo 也只在握手时给一次。' },
        }, concept('旧版握手之后（只作对比，本站不实现）', [
          ['initialize 的结果', 'protocolVersion、capabilities、serverInfo', '服务器回自己的版本和能力；版本不同意时回另一个它支持的版本。'],
          ['notifications/initialized', `${N.initializedBytes} 字节`, '客户端确认握手完成，之后才发正常请求。'],
          ['之后的请求', '不带版本和能力', '服务器按这条连接（HTTP 上是 Mcp-Session-Id 会话）记住的握手结果处理。'],
        ])), { caps: [{ ...metaGrid({ [META.protocolVersion]: N.legacy, [META.clientInfo]: HOST_CLIENT_INFO, [META.clientCapabilities]: {} }, { version: 'slate', caps: 'slate' }, 'params') }], rpc: [seq(11)] }),
        rpcPk('server', 'client', 'amber', `${N.initializeCode}：只支持 ${N.supported.join(' ')}`, ['不支持握手'], 'ERROR', `服务器只支持新版：initialize 回 ${N.initializeCode}，错误里写出支持的版本`, initializeResponse, rpcWire('对 initialize 的错误', initializeResponse, { color: 'amber', root: 'error', expand: ['error.data.supported'], notes: { 'error.code': `${N.initializeCode}：规范只要求在错误里写出支持的版本，错误码由实现决定，本站用 ${N.initializeCode}。`, 'error.message': '旧版客户端没有「升级」的办法，这句话可能是它唯一能显示给用户的诊断。' } }), { catalog: [compareGrid()], rpc: [seq(12)] }),
        note('server', '每个请求独立处理', 'green'),
      ],
    },
  ],
  outro: {
    title: '请求自己说清楚，服务器不必记得',
    desc: `${SEQ.length} 条消息，${N.missingCode} 和 ${N.versionCode} 两种错误`,
    text: `${PROTOCOL_VERSION} 版的 MCP 没有握手：每个请求在 _meta 里带上协议版本和客户端能力（这课的客户端每次 ${N.metaBytes} 字节），服务器逐个请求独立处理，缺字段回 ${N.missingCode}，版本不支持回 ${N.versionCode} 并列出 supported，客户端选一个、换个 id 重发。server/discover 是可选的「先问一句」，结果可以按 ttlMs 缓存。旧版的 initialize 握手和会话只作为对比出现，这台服务器不支持。下一课看服务器最常用的两个方法：tools/list 和 tools/call。`,
    facts: [['必填的 _meta', 'protocolVersion、clientCapabilities'], ['缺字段', `${N.missingCode}`], ['版本不支持', `${N.versionCode}（data.supported、data.requested）`], ['下一课', 'tools/list 与 tools/call']],
  },
};
