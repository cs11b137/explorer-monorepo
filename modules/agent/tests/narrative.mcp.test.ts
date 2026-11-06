/**
 * 文案和计算结果对得上（MCP 协议组）。写法照 narrative.test.ts：
 * 1. 关键的数写死在这里（字节数、错误码、token、状态码），改了服务器、客户端或编码会立刻报错；
 * 2. 能独立核对的用另一种写法再算一遍（JSON.stringify、Buffer、node:crypto），文字里的说法逐条核对。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  countTokens,
  createShop,
  directTransport,
  headerOf,
  HOST_CLIENT_INFO,
  inputBreakdown,
  LEGACY_VERSIONS,
  McpClient,
  META,
  parseStream,
  shopServer,
  validate,
  type JsonRpcError,
  type JsonRpcResult,
  type McpTool,
} from '../src/core';
import { LESSON_BY_ID } from '../src/lessons';
import { packetsOf } from '../src/lessons/types';
import * as D from '../src/lessons/discover';
import * as T from '../src/lessons/toolscall';
import * as R from '../src/lessons/resources';
import * as S from '../src/lessons/stdio';
import * as H from '../src/lessons/http';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const lessonOf = (id: string) => LESSON_BY_ID[id];
const stepOf = (id: string, step: number) => lessonOf(id).steps[step];
const factsOf = (id: string, step: number) => Object.fromEntries(lessonOf(id).steps[step].facts);

describe('MCP 组：输入列', () => {
  it('discover、resources、stdio、http 不调用模型，输入列一直是 0；toolscall 前三步是 0，接进循环后是两轮的累计', () => {
    for (const id of ['discover', 'resources', 'stdio', 'http']) {
      expect(packetsOf(lessonOf(id)).every((packet) => packet.row.tokens === 0), id).toBe(true);
    }
    const lesson = lessonOf('toolscall');
    const rows = lesson.steps.map((step) => step.events.flatMap((event) => (event.type === 'packet' ? [event.row.tokens] : [])));
    expect(rows.slice(0, 3).flat().every((tokens) => tokens === 0)).toBe(true);
    expect(rows[3]).toEqual([0, 0, 1995]);
    expect(rows[4]).toEqual([1995, 1995, 1995, 1995, 1995, 4268]);
  });
});

describe('无状态协议：版本、能力与 server/discover', () => {
  const N = D.numbers;

  it('server/discover 的请求：_meta 三个键，整条 254 字节，_meta 占 191 字节', () => {
    expect(N).toMatchObject({ discoverBytes: 254, metaBytes: 191, metaKeys: 3 });
    expect(bytes(D.discovery.request)).toBe(254);
    const meta = D.discovery.request.params!._meta as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual([META.protocolVersion, META.clientInfo, META.clientCapabilities]);
    expect(Buffer.byteLength(`"_meta":${JSON.stringify(meta)}`)).toBe(191);
    expect(meta[META.clientCapabilities]).toEqual({});
    expect(stepOf('discover', 0).detail).toContain('整条 254 字节，其中 _meta 占 191 字节');
  });

  it('DiscoverResult：supportedVersions、三种能力、instructions、ttlMs 300000（5 分钟）、public', () => {
    const result = (D.discovery.response as JsonRpcResult).result;
    expect(result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], ttlMs: 300000, cacheScope: 'public' });
    expect(Object.keys(result.capabilities as object)).toEqual(['tools', 'resources', 'prompts']);
    expect((result._meta as Record<string, unknown>)[META.serverInfo]).toMatchObject({ name: 'xiaopu-mcp' });
    expect(N).toMatchObject({ discoverResultBytes: 527, ttlMinutes: 5, instructionsChars: 51 });
    expect(stepOf('discover', 1).detail).toContain('5 分钟内新鲜');
  });

  it('缺 clientCapabilities：-32602，data.missing；补上、换 id 之后 tools/list 通过，4 个工具', () => {
    expect(D.missingResponse.error).toEqual({ code: -32602, message: 'Invalid params: missing required _meta fields', data: { missing: [META.clientCapabilities] } });
    expect(D.listed.request.id).not.toBe(D.missingRequest.id);
    expect(N.listedTools).toBe(4);
    expect(factsOf('discover', 2)['HTTP 上']).toBe('400 Bad Request');
  });

  it('版本 1900-01-01：-32022，data 照规范的例子；从 supported 里选一个，用新的 id 重发', () => {
    expect((D.wrongVersion.response as JsonRpcError).error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '1900-01-01' } });
    expect(D.chosen).toBe('2026-07-28');
    expect(D.retried.request.id).not.toBe(D.wrongVersion.request.id);
    expect((D.retried.request.params!._meta as Record<string, unknown>)[META.protocolVersion]).toBe('2026-07-28');
    expect(N.retriedTools).toBe(4);
  });

  it('服务器不记状态：被拒过的请求不影响之后的请求，一个新客户端直接调 tools/list 也行', () => {
    const fresh = new McpClient(directTransport(D.server), { info: HOST_CLIENT_INFO });
    expect(((fresh.listTools().response as JsonRpcResult).result.tools as unknown[]).length).toBe(4);
  });

  it('旧版的 initialize：161 字节，initialized 通知 54 字节；这台服务器回 -32022 并写出支持的版本', () => {
    expect(LEGACY_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(N).toMatchObject({ initializeBytes: 161, initializedBytes: 54, initializeCode: -32022, legacy: '2025-11-25', legacyCount: 4 });
    expect(bytes(D.initializeRequest)).toBe(161);
    expect(bytes({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(54);
    expect((D.initializeResponse.error.data as { supported: string[] }).supported).toEqual(['2026-07-28']);
    expect(stepOf('discover', 4).desc).toBe('旧版先握手，新版每个请求多带 191 字节');
    expect(stepOf('discover', 4).detail).toContain('（规范称 legacy）');
  });
});

describe('tools/list 与 tools/call', () => {
  const N = T.numbers;

  it('tools/list：四个工具，2,648 字节，可缓存，一页列完；只有 get_order 带 outputSchema', () => {
    expect(N).toMatchObject({ tools: ['get_order', 'search_policy', 'create_return', 'issue_refund'], listBytes: 2648, ttlMs: 300000, cacheScope: 'public', paged: false, withOutput: ['get_order'] });
    expect(bytes(T.list.response)).toBe(2648);
    expect(T.tools[3].annotations).toMatchObject({ destructiveHint: true });
  });

  it('tools/call get_order：content 的 text 和 structuredContent 是同一份订单，符合 outputSchema；不带 ttlMs', () => {
    const text = (T.callResult.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(T.callResult.structuredContent);
    expect(N).toMatchObject({ textBytes: 145, structuredBytes: 145, structuredValid: true, cacheableCall: false, resultBytes: 550 });
    expect(validate(T.ORDER_OUTPUT_SCHEMA as never, T.callResult.structuredContent)).toEqual([]);
    expect(T.callResult.isError).toBeUndefined();
  });

  it('两种错误：找不到工具是 -32602（规范例子的写法），参数不合格是 isError: true 的结果', () => {
    expect((T.unknown.response as JsonRpcError).error).toEqual({ code: -32602, message: 'Unknown tool: get_refund_status' });
    expect('result' in T.unknown.response).toBe(false);
    const invalid = (T.invalid.response as JsonRpcResult).result;
    expect(invalid).toMatchObject({ resultType: 'complete', isError: true });
    expect(N.invalidText).toBe('参数不合格：order_id：不匹配 ^A\\d{4}$');
    expect(stepOf('toolscall', 2).detail).toContain('order_id 写成 1024，不匹配 inputSchema');
  });

  it('接进循环：工具定义只有 name、description、input_schema；每轮多 1,798 = 1,510 + 286 + 2', () => {
    for (const tool of T.t1.request.tools!) expect(Object.keys(tool)).toEqual(['name', 'description', 'input_schema']);
    expect(T.t1.request.tools!.map((tool) => tool.input_schema)).toEqual(T.tools.map((tool: McpTool) => tool.inputSchema));
    expect(N).toMatchObject({ toolsTokens: 1510, toolSystem: 286, templateExtra: 2, perTurnExtra: 1798, bareInput: 197, handWritten: 1170, refundExtra: 340, defsBytes: 1650 });
    expect(N.perTurnExtra).toBe(N.toolsTokens + N.toolSystem + N.templateExtra);
    expect(T.t1.message.usage.input_tokens).toBe(N.bareInput + N.perTurnExtra);
    expect(stepOf('toolscall', 3).detail).toContain('同一个请求不带工具是 197 个 token，带上之后多出 1,798 个：定义展开 1,510 个、API 另加的工具系统提示 286 个、模板拼接工具区 2 个');
  });

  it('两轮：输入 1,995、2,273，累计 4,268，其中 84.2% 是带工具多出来的；$0.0204', () => {
    expect(N).toMatchObject({ inputs: [1995, 2273], outputs: [92, 72], totalInput: 4268, totalOutput: 164, turns: 2, cost: '$0.0204' });
    for (const turn of T.run.turns) expect(turn.message.usage.input_tokens).toBe(inputBreakdown(turn.request).total + 286);
    expect((1798 * 2) / 4268).toBeCloseTo(0.8426, 3);
    expect(stepOf('toolscall', 4).desc).toBe('2 轮累计 4,268，工具定义占 84.3%');
    expect(T.run.totals.cost).toBe(4268 * 4000 + 164 * 20000);
    expect(T.run.turns.map((turn) => turn.message.stop_reason)).toEqual(['tool_use', 'end_turn']);
  });

  it('tool_use 经 tools/call（id 5）执行，结果回到 tool_result；回答里的日期和快递来自结果', () => {
    expect(N.methods).toEqual(['tools/list', 'tools/call', 'tools/call', 'tools/call', 'tools/call']);
    expect(T.loopCall.request.id).toBe(5);
    expect(T.loopCall.request.params).toMatchObject({ name: 'get_order', arguments: { order_id: 'A1024' } });
    expect(T.t1.calls[0].result.content).toBe((T.callResult.content[0] as { text: string }).text);
    expect(T.run.final).toContain('11 月 3 日');
    expect(T.run.final).toContain('顺丰');
  });
});

describe('resources 与 prompts', () => {
  const N = R.numbers;

  it('resources/list：三个资源，size 是 UTF-8 字节数', () => {
    expect(N).toMatchObject({ resources: ['policy://aftersale', 'policy://refund', 'policy://shipping-fee'], sizes: [517, 205, 78], listBytes: 561, listTtl: 300000 });
    expect(stepOf('resources', 0).detail).toContain('《售后规则》《退款说明》《运费说明》一共 800 字节');
  });

  it('resources/read：contents[0] 的 uri、mimeType、text，517 字节、4 段，和 size 一样', () => {
    expect(Object.keys(R.contents)).toEqual(['uri', 'mimeType', 'text']);
    expect(Buffer.byteLength(R.contents.text, 'utf8')).toBe(517);
    expect(N).toMatchObject({ textBytes: 517, textLines: 4, readTtl: 300000, readScope: 'public' });
  });

  it('不存在的资源：-32602，data.uri；没有回空的 contents', () => {
    expect((R.missing.response as JsonRpcError).error).toEqual({ code: -32602, message: 'Resource not found', data: { uri: 'policy://warranty' } });
    expect('result' in R.missing.response).toBe(false);
  });

  it('prompts：参数 order_id 必填、problem 可选；get 返回 1 条 user 消息，93 字节；缺 order_id 是 -32602', () => {
    expect(N.promptArgs).toEqual(['order_id（必填）', 'problem（可选）']);
    expect(R.promptText).toBe('订单 A1024：杯盖漏水。请先查订单和售后规则，能退就帮我建退货单。');
    expect(N).toMatchObject({ promptBytes: 93, promptRole: 'user', promptCacheable: false, noArgsCode: -32602, noArgsMessage: 'Missing required arguments: order_id' });
    expect(Buffer.byteLength(R.promptText)).toBe(93);
  });

  it('放进对话的 token（本站分词器）：资源 490、提示 86', () => {
    expect(countTokens(R.contents.text)).toBe(490);
    expect(countTokens(R.promptText)).toBe(86);
    expect(factsOf('resources', 4)['放进对话']).toBe('资源 490 + 提示 86 token');
    expect(stepOf('resources', 4).detail).toContain('工具是 model-controlled');
    expect(stepOf('resources', 4).detail).toContain('资源是 application-driven');
    expect(stepOf('resources', 4).detail).toContain('提示模板是 user-controlled');
  });
});

describe('stdio 传输', () => {
  const N = S.numbers;

  it('一行一条消息：discover 255 字节 = 紧凑 JSON + 0A，0A 只有一个', () => {
    expect(N).toMatchObject({ discoverIn: 255, discoverInLf: 1, lastByte: 0x0a, discoverOut: 528 });
    expect(Buffer.from(S.lines.discoverIn).toString('utf8')).toBe(`${JSON.stringify(S.discovery.request)}\n`);
  });

  it('分块：每块 64 字节、9 块，第 5 块从第 256 字节开始，正好切在「工」的 3 个字节中间；只有最后一块吐出一行', () => {
    expect(N).toMatchObject({ chunks: 9, splitChunk: 5, splitAt: 256, splitChar: '工' });
    const out = Buffer.from(S.lines.discoverOut);
    expect(out[256] & 0xc0).toBe(0x80);
    expect(Buffer.byteLength('工')).toBe(3);
    expect(N.emitted).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('字符串里的换行写成 5C 6E；带缩进的 JSON 有 18 个换行，硬写进去碎成 19 行、回 19 个没有 id 的 -32700', () => {
    expect(S.lines.searchOut[N.escapeByte]).toBe(0x5c);
    expect(S.lines.searchOut[N.escapeByte + 1]).toBe(0x6e);
    expect(S.lines.searchOut.filter((byte) => byte === 0x0a)).toHaveLength(1);
    expect(N).toMatchObject({ escapeByte: 214, escapes: 1, searchOut: 476, prettyLines: 19, prettyRejected: true, brokenErrors: 19, brokenHaveId: false });
    expect(S.pretty.split('\n')).toHaveLength(19);
  });

  it('取消：stdin 两行（请求 + 通知），stdout 一行（迟到的结果）；服务器记下了 id 3', () => {
    expect(N).toMatchObject({ cancelId: 3, cancelInLines: 2, cancelOutLines: 1, serverCancelled: [3], cancelBytes: 111 });
    const [, second] = Buffer.from(S.lines.cancelIn).toString('utf8').trimEnd().split('\n');
    expect(JSON.parse(second)).toEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: '用户关掉了对话' } });
  });

  it('全部字节：stdin 4 行 1,008 字节，stdout 3 行 1,437 字节，最后一个 0A 之后没有剩余', () => {
    expect(N).toMatchObject({ stdinLines: 4, stdinTotal: 1008, stdoutLines: 3, stdoutTotal: 1437, buffered: 0, stderrBytes: 45 });
    expect(S.pipe.record.stdin.at(-1)).toBe(0x0a);
    expect(S.pipe.record.stdout.at(-1)).toBe(0x0a);
  });
});

describe('Streamable HTTP 传输与授权', () => {
  const N = H.numbers;

  it('POST：头依次是 host、content-type、accept、三个镜像头、content-length；200 JSON', () => {
    expect(N.headerNames).toEqual(['host', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'content-length']);
    expect(headerOf(H.first.request.headers, 'accept')).toBe('application/json, text/event-stream');
    expect(N).toMatchObject({ firstReq: 526, bodyBytes: 301, firstStatus: 200, firstType: 'application/json', firstRes: 456 });
    expect(Buffer.from(H.first.request.body).toString('utf8')).toBe(JSON.stringify(H.call.request));
  });

  it('SSE：先两条进度通知（progressToken 对上请求里的），最后是响应；761 字节，X-Accel-Buffering: no', () => {
    const events = parseStream(H.streamed.response.body).map((event) => JSON.parse(event.data));
    expect(events.map((event) => event.method ?? event.id)).toEqual(['notifications/progress', 'notifications/progress', H.search.request.id]);
    expect((H.search.request.params!._meta as Record<string, unknown>).progressToken).toBe(H.PROGRESS_TOKEN);
    expect(events[0].params.progress).toBeLessThan(events[1].params.progress);
    expect(N).toMatchObject({ sseEvents: 3, sseBytes: 761, sseSame: true, accelBuffering: 'no', sseType: 'text/event-stream' });
  });

  it('头和体对不上：400 + -32020，什么都没执行；编码照规范的五个例子', () => {
    expect(N).toMatchObject({ mismatchStatus: 400, mismatchCode: -32020, createdReturns: 0 });
    expect(N.mismatchMessage).toBe("Header mismatch: Mcp-Name header value 'get_order' does not match body value 'create_return'");
    expect(N.encoded).toEqual(['us-west1', '=?base64?SGVsbG8sIOS4lueVjA==?=', '=?base64?IHBhZGRlZCA=?=', '=?base64?bGluZTEKbGluZTI=?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=']);
    expect(Buffer.from('Hello, 世界', 'utf8').toString('base64')).toBe('SGVsbG8sIOS4lueVjA==');
    expect(N.roundTrip).toBe(true);
  });

  it('没有会话：GET 405（allow: POST）；带 Mcp-Session-Id 的请求照常 200，不回显会话 id', () => {
    expect(N).toMatchObject({ getStatus: 405, getAllow: 'POST', sessionStatus: 200, sessionEchoed: false });
    expect(headerOf(H.withSession.headers, 'mcp-session-id')).toBe(H.OLD_SESSION);
  });

  it('授权：401 的 WWW-Authenticate、元数据的两个地址、授权服务器元数据的两个地址', () => {
    expect(N.challengeStatus).toBe(401);
    expect(N.challengeHeader).toBe('Bearer resource_metadata="https://mcp.xiaopu.example/.well-known/oauth-protected-resource/mcp", scope="orders:read returns:write"');
    expect(N.prmUrls).toEqual(['https://mcp.xiaopu.example/.well-known/oauth-protected-resource/mcp', 'https://mcp.xiaopu.example/.well-known/oauth-protected-resource']);
    expect(H.prmDoc).toEqual({ resource: 'https://mcp.xiaopu.example/mcp', authorization_servers: ['https://auth.xiaopu.example'], scopes_supported: ['orders:read', 'returns:write'], bearer_methods_supported: ['header'], resource_name: '小铺售后服务' });
    expect(N.asUrls).toEqual(['https://auth.xiaopu.example/.well-known/oauth-authorization-server', 'https://auth.xiaopu.example/.well-known/openid-configuration']);
  });

  it('授权请求带 PKCE（S256）和 resource；这对 PKCE 值是 RFC 7636 附录 B 的例子（用 node:crypto 核对）；带 Bearer 重试 200', () => {
    const params = Object.fromEntries(new URL(H.authorizeUrl).searchParams);
    expect(params).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', resource: 'https://mcp.xiaopu.example/mcp', scope: 'orders:read returns:write', code_challenge: H.CODE_CHALLENGE });
    expect(N.authorizeParams).toHaveLength(8);
    expect(createHash('sha256').update(H.CODE_VERIFIER).digest('base64url')).toBe(H.CODE_CHALLENGE);
    expect(new URLSearchParams(H.tokenBody).get('resource')).toBe('https://mcp.xiaopu.example/mcp');
    expect(headerOf(H.authorized.headers, 'authorization')).toBe(`Bearer ${H.TOKEN}`);
    expect(N.finalStatus).toBe(200);
  });
});

describe('core：outputSchemas 是可选的，默认的服务器结果不变', () => {
  it('默认 shopServer 的 tools/list 没有 outputSchema、tools/call 没有 structuredContent', () => {
    const c = new McpClient(directTransport(shopServer({ shop: createShop() })), { info: HOST_CLIENT_INFO });
    const tools = ((c.listTools().response as JsonRpcResult).result.tools as McpTool[]);
    expect(tools.some((tool) => tool.outputSchema)).toBe(false);
    expect('structuredContent' in (c.callTool('get_order', { order_id: 'A1024' }).response as JsonRpcResult).result).toBe(false);
  });

  it('带 outputSchemas 时：工具出错（找不到订单）不带 structuredContent', () => {
    const c = new McpClient(directTransport(shopServer({ shop: createShop() }, { outputSchemas: { get_order: T.ORDER_OUTPUT_SCHEMA } })), { info: HOST_CLIENT_INFO });
    const result = (c.callTool('get_order', { order_id: 'A9999' }).response as JsonRpcResult).result;
    expect(result.isError).toBe(true);
    expect('structuredContent' in result).toBe(false);
  });
});
