/**
 * MCP（2026-07-28 版）：JSON-RPC 2.0、服务器、客户端、stdio、Streamable HTTP、授权，以及接进 Agent 循环的桥。
 * 期望值手写自规范（字段名、错误码、头名、规范里的例子），或用独立的写法（JSON.stringify、Buffer）核对。
 */
import { describe, expect, it } from 'vitest';
import {
  ACCEPT,
  asMetadataUrls,
  authorizationUrl,
  checkHeaders,
  CONFIRM_KEY,
  createShop,
  decodeHeaderValue,
  decodeState,
  directTransport,
  encodeHeaderValue,
  encodeLine,
  encodeLines,
  headerOf,
  httpTransport,
  kindOf,
  LineDecoder,
  lineSpans,
  McpClient,
  mcpPost,
  mcpToolBox,
  META,
  parseRpc,
  parseStream,
  parseWwwAuthenticate,
  prmUrls,
  PROTOCOL_VERSION,
  protectedResourceMetadata,
  readHttpResponse,
  resultOf,
  rpcNotification,
  rpcRequest,
  RPC,
  runAgent,
  serveHttp,
  shopServer,
  stdioTransport,
  text,
  toAnthropicTool,
  toolUse,
  wwwAuthenticate,
  type CallToolResult,
  type JsonRpcError,
  type JsonRpcResult,
  type McpTool,
} from '../src/core';
import { HOST_CLIENT_INFO } from '../src/core/mcp/shop-server';
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';

const meta = { [META.protocolVersion]: PROTOCOL_VERSION, [META.clientCapabilities]: {} };
const server = () => shopServer({ shop: createShop() });
const client = (s = server(), capabilities = {}) => new McpClient(directTransport(s), { info: HOST_CLIENT_INFO, capabilities });
const err = (r: unknown) => (r as JsonRpcError).error;
const res = (r: unknown) => (r as JsonRpcResult).result;

describe('JSON-RPC 2.0', () => {
  it('四种消息：请求有 id 和 method，通知没有 id，结果和错误按 id 对应', () => {
    expect(kindOf(rpcRequest(1, 'tools/list'))).toBe('request');
    expect(kindOf(rpcNotification('notifications/cancelled', { requestId: 1 }))).toBe('notification');
    expect(kindOf({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } })).toBe('result');
    expect(kindOf({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })).toBe('error');
    // MCP：id 不能是 null；params 必须是对象。
    expect(kindOf({ jsonrpc: '2.0', id: null, method: 'x' })).toBeNull();
    expect(kindOf({ jsonrpc: '2.0', id: 1, method: 'x', params: [1] })).toBeNull();
    expect(kindOf({ jsonrpc: '1.0', id: 1, method: 'x' })).toBeNull();
  });

  it('解析失败是 -32700，结构不对是 -32600，都不带 id', () => {
    expect(parseRpc('{oops')).toEqual({ ok: false, error: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } } });
    const bad = parseRpc('{"jsonrpc":"2.0","method":5}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.error.code).toBe(-32600);
  });

  it('错误码和规范一致', () => {
    expect(RPC).toEqual({ PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603, HEADER_MISMATCH: -32020, MISSING_REQUIRED_CLIENT_CAPABILITY: -32021, UNSUPPORTED_PROTOCOL_VERSION: -32022 });
  });
});

describe('服务器：无状态，每个请求自带 _meta', () => {
  it('缺 _meta 必填字段回 -32602，data 里列出缺了哪些', () => {
    const r = server().handle(rpcRequest(1, 'tools/list', {}));
    expect(err(r)).toEqual({ code: -32602, message: 'Invalid params: missing required _meta fields', data: { missing: [META.protocolVersion, META.clientCapabilities] } });
  });

  it('版本不支持回 -32022，data 是 supported 和 requested（照规范的例子）', () => {
    const r = server().handle(rpcRequest(1, 'tools/list', { _meta: { ...meta, [META.protocolVersion]: '1900-01-01' } }));
    expect(err(r)).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '1900-01-01' } });
  });

  it('旧版的 initialize：不支持握手，错误里写出支持的版本', () => {
    const r = server().handle(rpcRequest(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } }));
    expect(err(r).data).toEqual({ supported: ['2026-07-28'], requested: '2025-11-25' });
  });

  it('server/discover：supportedVersions、capabilities、instructions、缓存提示、serverInfo', () => {
    const r = res(client().discover().response);
    expect(r).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } }, ttlMs: 300000, cacheScope: 'public' });
    expect((r._meta as Record<string, unknown>)[META.serverInfo]).toEqual({ name: 'xiaopu-mcp', version: '1.4.0', title: '小铺售后服务' });
    expect(typeof r.instructions).toBe('string');
  });

  it('客户端每个请求都带 protocolVersion、clientInfo、clientCapabilities，id 逐个加 1', () => {
    const c = client();
    c.discover();
    c.listTools();
    expect(c.exchanges.map((e) => e.request.id)).toEqual([1, 2]);
    expect(c.exchanges[1].request.params!._meta).toEqual({ [META.protocolVersion]: '2026-07-28', [META.clientInfo]: HOST_CLIENT_INFO, [META.clientCapabilities]: {} });
  });

  it('tools/list：inputSchema 驼峰、annotations 是提示、带缓存提示；可以分页', () => {
    const r = res(client().listTools().response);
    const tools = r.tools as McpTool[];
    expect(tools.map((t) => t.name)).toEqual(['get_order', 'search_policy', 'create_return', 'issue_refund']);
    expect(tools[0]).toMatchObject({ name: 'get_order', title: '查订单', inputSchema: { type: 'object', required: ['order_id'] }, annotations: { readOnlyHint: true } });
    expect(tools[3].annotations).toMatchObject({ destructiveHint: true });
    expect(r).toMatchObject({ ttlMs: 300000, cacheScope: 'public' });
    const paged = new McpClient(directTransport(shopServer({ shop: createShop() }, { pageSize: 3 })), { info: HOST_CLIENT_INFO });
    const first = res(paged.listTools().response);
    expect((first.tools as McpTool[]).length).toBe(3);
    const second = res(paged.listTools(first.nextCursor as string).response);
    expect((second.tools as McpTool[]).map((t) => t.name)).toEqual(['issue_refund']);
    expect(second.nextCursor).toBeUndefined();
    expect(err(paged.listTools('bad!').response).code).toBe(-32602);
  });

  it('tools/call：结果是 content 文本块；工具自己的失败是 isError；找不到工具是 -32602', () => {
    const c = client();
    const ok = res(c.callTool('get_order', { order_id: 'A1024' }).response) as unknown as CallToolResult;
    expect(ok.resultType).toBe('complete');
    expect(JSON.parse((ok.content[0] as { text: string }).text)).toMatchObject({ order_id: 'A1024' });
    expect(ok.isError).toBeUndefined();
    expect('ttlMs' in ok).toBe(false);
    const bad = res(c.callTool('get_order', { order_id: 'A9999' }).response);
    expect(bad).toMatchObject({ isError: true, content: [{ type: 'text', text: '找不到订单 A9999' }] });
    expect(err(c.callTool('nope', {}).response)).toEqual({ code: -32602, message: 'Unknown tool: nope' });
  });

  it('resources：list、read；不存在的资源是 -32602，data 带 uri', () => {
    const c = client();
    const list = res(c.listResources().response).resources as Array<{ uri: string; size: number }>;
    expect(list.map((r) => r.uri)).toEqual(['policy://aftersale', 'policy://refund', 'policy://shipping-fee']);
    const read = res(c.readResource('policy://aftersale').response);
    const contents = read.contents as Array<{ uri: string; mimeType: string; text: string }>;
    expect(contents[0]).toMatchObject({ uri: 'policy://aftersale', mimeType: 'text/plain' });
    expect(Buffer.byteLength(contents[0].text, 'utf8')).toBe(list[0].size);
    expect(read).toMatchObject({ ttlMs: 300000, cacheScope: 'public' });
    expect(err(c.readResource('policy://nope').response)).toEqual({ code: -32602, message: 'Resource not found', data: { uri: 'policy://nope' } });
  });

  it('prompts：list、get；缺必填参数、不认识的提示都是 -32602', () => {
    const c = client();
    expect((res(c.listPrompts().response).prompts as Array<{ name: string }>).map((p) => p.name)).toEqual(['return_request']);
    const got = res(c.getPrompt('return_request', { order_id: 'A1024', problem: '杯盖漏水' }).response);
    expect(got.messages).toEqual([{ role: 'user', content: { type: 'text', text: '订单 A1024：杯盖漏水。请先查订单和售后规则，能退就帮我建退货单。' } }]);
    expect(err(c.getPrompt('return_request').response)).toMatchObject({ code: -32602, message: 'Missing required arguments: order_id' });
    expect(err(c.getPrompt('x').response).code).toBe(-32602);
  });

  it('没实现的方法、没声明能力的方法都是 -32601', () => {
    expect(err(client().request('ping').response).code).toBe(-32601);
    const bare = shopServer({ shop: createShop() }, { prompts: undefined });
    expect(bare.capabilities().prompts).toBeUndefined();
    expect(err(client(bare).listPrompts().response).code).toBe(-32601);
  });

  it('通知不回复；notifications/cancelled 记下被取消的 id', () => {
    const s = server();
    expect(s.handle(rpcNotification('notifications/cancelled', { requestId: 7, reason: '用户取消' }))).toBeNull();
    expect([...s.cancelled]).toEqual([7]);
  });

  it('要确认的工具（MRTR）：没声明 elicitation 是 -32021；声明了先回 input_required，带 inputResponses 重发才执行', () => {
    const shop = createShop();
    shop.returns.push({ return_id: 'R20261106-001', order_id: 'A1024', reason: 'quality', note: '', refund: 129, shipping_paid_by: 'shop', status: 'pending_pickup' });
    const s = shopServer({ shop });
    expect(err(client(s).callTool('issue_refund', { order_id: 'A1024', amount: 129 }).response)).toEqual({ code: -32021, message: 'Missing required client capability', data: { requiredCapabilities: { elicitation: {} } } });
    const c = client(s, { elicitation: { form: {} } });
    const first = res(c.callTool('issue_refund', { order_id: 'A1024', amount: 129 }).response);
    expect(first.resultType).toBe('input_required');
    expect((first.inputRequests as Record<string, { method: string }>)[CONFIRM_KEY].method).toBe('elicitation/create');
    expect(decodeState(first.requestState as string)).toEqual({ tool: 'issue_refund', arguments: { order_id: 'A1024', amount: 129 } });
    expect(shop.refunds).toEqual([]);
    const declined = res(c.callTool('issue_refund', { order_id: 'A1024', amount: 129 }, { inputResponses: { [CONFIRM_KEY]: { action: 'decline' } }, requestState: first.requestState }).response);
    expect(declined.isError).toBe(true);
    const retry = c.callTool('issue_refund', { order_id: 'A1024', amount: 129 }, { inputResponses: { [CONFIRM_KEY]: { action: 'accept', content: { confirm: true } } }, requestState: first.requestState });
    expect(res(retry.response).resultType).toBe('complete');
    expect(shop.refunds).toHaveLength(1);
    // 规范：重发要用新的 id。
    expect(new Set(c.exchanges.map((e) => e.request.id)).size).toBe(c.exchanges.length);
  });
});

describe('stdio', () => {
  it('一条消息一行：紧凑 JSON 加 LF；字符串里的换行写成 \\n，不是真的换行', () => {
    const message = rpcRequest(1, 'tools/call', { name: 'get_order', arguments: { order_id: 'A1024' }, _meta: meta });
    expect(encodeLine(message)).toBe(`${JSON.stringify(message)}\n`);
    const withNewline = rpcRequest(2, 'x', { note: '第一行\n第二行', _meta: meta });
    expect(encodeLine(withNewline).split('\n')).toHaveLength(2);
    expect(() => encodeLine('{"a":\n1}')).toThrow();
  });

  it('按字节切行：切口落在汉字中间也能拼回', () => {
    const lines = encodeLines([rpcNotification('a', { t: '漏水' }), rpcNotification('b')]);
    const bytes = utf8Encode(lines);
    const decoder = new LineDecoder();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 5) out.push(...decoder.push(bytes.slice(i, i + 5)));
    expect(out.map((line) => JSON.parse(line).method)).toEqual(['a', 'b']);
    expect(decoder.buffered).toBe(0);
    expect(lineSpans(bytes).map((span) => bytes[span.to - 1])).toEqual([0x0a, 0x0a]);
  });

  it('当作子进程：stdin、stdout 的字节都是一行行 JSON-RPC', () => {
    const t = stdioTransport(server());
    const c = new McpClient(t.send, { info: HOST_CLIENT_INFO });
    c.discover();
    c.callTool('get_order', { order_id: 'A1024' });
    const stdin = lineSpans(t.record.stdin).map((line) => JSON.parse(line.text));
    const stdout = lineSpans(t.record.stdout).map((line) => JSON.parse(line.text));
    expect(stdin.map((m) => m.method)).toEqual(['server/discover', 'tools/call']);
    expect(stdout.map((m) => m.id)).toEqual([1, 2]);
    expect(utf8Decode(t.record.stdout).endsWith('\n')).toBe(true);
  });
});

describe('Streamable HTTP', () => {
  const call = rpcRequest(3, 'tools/call', { name: 'get_order', arguments: { order_id: 'A1024' }, _meta: meta });

  it('POST 的头：accept 两种类型，MCP-Protocol-Version、Mcp-Method、Mcp-Name 镜像请求体', () => {
    const req = mcpPost(call, { token: 'tok' });
    expect(req.method).toBe('POST');
    expect(req.target).toBe('/mcp');
    expect(req.headers.map(([name]) => name)).toEqual(['host', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'authorization', 'content-length']);
    expect(headerOf(req.headers, 'accept')).toBe(ACCEPT);
    expect(ACCEPT).toBe('application/json, text/event-stream');
    expect(headerOf(req.headers, 'mcp-protocol-version')).toBe('2026-07-28');
    expect(headerOf(req.headers, 'mcp-name')).toBe('get_order');
    expect(Buffer.from(req.body).toString('utf8')).toBe(JSON.stringify(call));
    const read = mcpPost(rpcRequest(4, 'resources/read', { uri: 'policy://aftersale', _meta: meta }));
    expect(headerOf(read.headers, 'mcp-name')).toBe('policy://aftersale');
    expect(headerOf(mcpPost(rpcRequest(5, 'tools/list', { _meta: meta })).headers, 'mcp-name')).toBeUndefined();
  });

  it('头的值不安全时写成 =?base64?…?=（规范 Value Encoding 一节的例子）', () => {
    expect(encodeHeaderValue('us-west1')).toBe('us-west1');
    expect(encodeHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=');
    expect(encodeHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=');
    expect(encodeHeaderValue('line1\nline2')).toBe('=?base64?bGluZTEKbGluZTI=?=');
    expect(encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界');
  });

  it('服务器：JSON 回复 200；通知 202 没有消息体；GET 405', () => {
    const s = server();
    const ok = serveHttp(s, mcpPost(call));
    expect(ok.status).toBe(200);
    expect(headerOf(ok.headers, 'content-type')).toBe('application/json');
    expect(readHttpResponse(ok)[0]).toMatchObject({ id: 3, result: { resultType: 'complete' } });
    const note = serveHttp(s, mcpPost(rpcNotification('notifications/cancelled', { requestId: 3 })));
    expect([note.status, note.body.length]).toEqual([202, 0]);
    expect(serveHttp(s, { ...mcpPost(call), method: 'GET' }).status).toBe(405);
  });

  it('头和体对不上、缺头：400 和 -32020 HeaderMismatch', () => {
    const s = server();
    const req = mcpPost(call);
    const wrong = { ...req, headers: req.headers.map(([n, v]) => [n, n === 'mcp-name' ? 'search_policy' : v] as [string, string]) };
    const r = serveHttp(s, wrong);
    expect(r.status).toBe(400);
    expect(readHttpResponse(r)[0]).toMatchObject({ id: 3, error: { code: -32020 } });
    expect(checkHeaders({ ...req, headers: req.headers.filter(([n]) => n !== 'mcp-protocol-version') }, call)).toMatch(/MCP-Protocol-Version header is missing/);
    expect(checkHeaders(req, call)).toBeNull();
  });

  it('状态码：缺 _meta、版本不支持 400；没实现的方法 404；找不到工具 200', () => {
    const s = server();
    expect(serveHttp(s, mcpPost(rpcRequest(1, 'tools/list', { _meta: { ...meta, [META.protocolVersion]: '1900-01-01' } }))).status).toBe(400);
    const noMeta = mcpPost(rpcRequest(1, 'tools/list', {}));
    noMeta.headers.splice(3, 0, ['mcp-protocol-version', '2026-07-28']);
    expect(serveHttp(s, noMeta).status).toBe(400);
    expect(serveHttp(s, mcpPost(rpcRequest(1, 'ping', { _meta: meta }))).status).toBe(404);
    expect(serveHttp(s, mcpPost(rpcRequest(1, 'tools/call', { name: 'nope', _meta: meta }))).status).toBe(200);
  });

  it('SSE 回复：content-type text/event-stream，先通知后响应，每个事件一行 data', () => {
    const progress = rpcNotification('notifications/progress', { progressToken: 'p1', progress: 1, total: 2 });
    const r = serveHttp(server(), mcpPost(call), { sse: true, notifications: [progress] });
    expect(headerOf(r.headers, 'content-type')).toBe('text/event-stream');
    expect(headerOf(r.headers, 'x-accel-buffering')).toBe('no');
    const events = parseStream(r.body);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].data)).toEqual(progress);
    expect(readHttpResponse(r).map((m) => ('id' in m ? m.id : 'method' in m ? m.method : null))).toEqual(['notifications/progress', 3]);
  });

  it('受保护的服务器：不带令牌 401，WWW-Authenticate 指向元数据；带对的令牌放行', () => {
    const s = server();
    const metadata = 'https://mcp.xiaopu.example/.well-known/oauth-protected-resource/mcp';
    const r = serveHttp(s, mcpPost(call), { token: 'tok', resourceMetadata: metadata, scope: 'orders:read' });
    expect(r.status).toBe(401);
    const challenge = parseWwwAuthenticate(headerOf(r.headers, 'www-authenticate')!);
    expect(challenge).toEqual({ scheme: 'Bearer', params: { resource_metadata: metadata, scope: 'orders:read' } });
    expect(parseWwwAuthenticate(headerOf(serveHttp(s, mcpPost(call, { token: 'bad' }), { token: 'tok', resourceMetadata: metadata }).headers, 'www-authenticate')!).params.error).toBe('invalid_token');
    expect(serveHttp(s, mcpPost(call, { token: 'tok' }), { token: 'tok' }).status).toBe(200);
  });

  it('经 HTTP 的客户端：每条消息一个 POST，记下请求和响应', () => {
    const t = httpTransport(server());
    const c = new McpClient(t.send, { info: HOST_CLIENT_INFO });
    c.discover();
    c.listTools();
    expect(t.exchanges.map((e) => headerOf(e.request.headers, 'mcp-method'))).toEqual(['server/discover', 'tools/list']);
    expect(t.exchanges.every((e) => e.response.status === 200)).toBe(true);
    expect(headerOf(t.exchanges[0].response.headers, 'mcp-session-id')).toBeUndefined();
  });
});

describe('授权', () => {
  it('Protected Resource Metadata 的位置：先插路径，再根上（RFC 9728）', () => {
    expect(prmUrls('https://mcp.xiaopu.example/mcp')).toEqual(['https://mcp.xiaopu.example/.well-known/oauth-protected-resource/mcp', 'https://mcp.xiaopu.example/.well-known/oauth-protected-resource']);
    expect(prmUrls('https://mcp.xiaopu.example')).toEqual(['https://mcp.xiaopu.example/.well-known/oauth-protected-resource']);
  });

  it('授权服务器元数据的顺序：有路径三个，没路径两个', () => {
    expect(asMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ]);
    expect(asMetadataUrls('https://auth.example.com')).toEqual(['https://auth.example.com/.well-known/oauth-authorization-server', 'https://auth.example.com/.well-known/openid-configuration']);
  });

  it('元数据文档：resource、authorization_servers（至少一个）', () => {
    expect(protectedResourceMetadata('https://mcp.xiaopu.example/mcp', ['https://auth.xiaopu.example'], { scopes: ['orders:read'] })).toEqual({ resource: 'https://mcp.xiaopu.example/mcp', authorization_servers: ['https://auth.xiaopu.example'], scopes_supported: ['orders:read'], bearer_methods_supported: ['header'] });
    expect(() => protectedResourceMetadata('https://x', [])).toThrow();
    expect(wwwAuthenticate({ resourceMetadata: 'https://x/m', scope: 'a b' })).toBe('Bearer resource_metadata="https://x/m", scope="a b"');
  });

  it('授权请求带 PKCE（S256）和 resource（RFC 8707）', () => {
    const url = new URL(authorizationUrl({ authorizationEndpoint: 'https://auth.xiaopu.example/authorize', clientId: 'https://agent.xiaopu.example/client.json', redirectUri: 'http://127.0.0.1:8765/callback', scope: 'orders:read', state: 's1', codeChallenge: 'c1', resource: 'https://mcp.xiaopu.example/mcp' }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', resource: 'https://mcp.xiaopu.example/mcp' });
  });
});

describe('接进 Agent 循环', () => {
  it('Tool → Messages API 的工具定义：inputSchema 改名 input_schema，title、annotations 不发给模型', () => {
    const tools = res(client().listTools().response).tools as McpTool[];
    const def = toAnthropicTool(tools[0]);
    expect(Object.keys(def)).toEqual(['name', 'description', 'input_schema']);
    expect(def.input_schema).toEqual(tools[0].inputSchema);
  });

  it('模型的 tool_use 经 MCP 的 tools/call 执行，结果回到 tool_result', () => {
    const shop = createShop();
    const c = new McpClient(directTransport(shopServer({ shop })), { info: HOST_CLIENT_INFO });
    const tools = resultOf<{ tools: McpTool[] }>(c.listTools()).tools.filter((t) => t.name !== 'issue_refund');
    const agent = { name: 'mcp-agent', model: 'claude-opus-5-5', system: '你是客服。', tools: mcpToolBox(c, tools) };
    const run = runAgent(agent, '查 A1024', [[toolUse('get_order', { order_id: 'A1024' }, 1)], [text('查到了。')]], { ctx: { shop } });
    expect(c.exchanges.map((e) => e.request.method)).toEqual(['tools/list', 'tools/call']);
    expect(JSON.parse(run.turns[0].calls[0].result.content as string)).toMatchObject({ order_id: 'A1024' });
    expect(run.turns[0].request.tools!.map((t) => t.name)).toEqual(['get_order', 'search_policy', 'create_return']);
  });
});
