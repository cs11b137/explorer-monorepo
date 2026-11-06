/**
 * MCP 组第四课：stdio 传输。客户端把服务器作为子进程启动，往它的 stdin 写、从它的 stdout 读：每条 JSON-RPC 消息一行，以 0A 结尾，
 * 消息里不能有内嵌的换行。逐字节看：一行怎样分帧、切成几块到达也能拼回、字符串里的换行写成 \n 两个字符、带缩进的 JSON 为什么会坏；
 * stderr 写日志，取消用 notifications/cancelled，关闭按规范：关 stdin → 等退出 → 强制结束。
 *
 * 字节由 core/mcp/stdio.ts 真实编码和切行（stdioTransport、LineDecoder、lineSpans），消息由 shopServer 真实处理。
 * 子进程的启动、stderr 的日志内容、关闭时的信号是概念（示意）。这课不调用模型，输入列一直是 0。tests/narrative.mcp.test.ts 核对文案。
 */
import { utf8Decode, utf8Encode } from '@explorer/llm-core/utf8';
import {
  createShop,
  encodeLine,
  HOST_CLIENT_INFO,
  LF,
  LineDecoder,
  lineSpans,
  McpClient,
  shopServer,
  SHOP_SERVER_INFO,
  stdioTransport,
  type JsonRpcError,
  type JsonRpcMessage,
} from '../core';
import { concept, num, stdioLines, utf8Lines, wire } from '../decode/structures';
import { rpcLayer, rpcRow } from './discover';
import { ds, note, pk, show, state } from './dsl';
import { POLICY_QUERY } from './scenario';
import type { DsCell, Lesson, RowPrim } from './types';

// ---------- 真实运行 ----------

export const shop = createShop();
export const server = shopServer({ shop });
/** 把服务器当作子进程：记下客户端写进 stdin、服务器写到 stdout 的全部字节。 */
export const pipe = stdioTransport(server);

export const client = new McpClient(pipe.send, { info: HOST_CLIENT_INFO });
const mark = () => ({ stdin: pipe.record.stdin.length, stdout: pipe.record.stdout.length });

/** ① server/discover 写进 stdin，结果从 stdout 读回。 */
const m0 = mark();
export const discovery = client.discover();
const m1 = mark();

/** ② 一条带换行的结果：search_policy 返回两段规则，用换行连起来。 */
export const search = client.callTool('search_policy', { query: POLICY_QUERY });
const m2 = mark();

/** ④ 取消：tools/call 写出去之后，客户端马上又写了 notifications/cancelled。本站的服务器同步执行，取消到达时已经做完了。 */
export const CANCEL_QUERY = '运费 谁出';
export const cancelled = client.callTool('search_policy', { query: CANCEL_QUERY });
export const cancelNote = client.cancel(cancelled.request.id, '用户关掉了对话');
const m3 = mark();

const slice = (bytes: number[], from: number, to: number) => bytes.slice(from, to);
export const lines = {
  discoverIn: slice(pipe.record.stdin, m0.stdin, m1.stdin),
  discoverOut: slice(pipe.record.stdout, m0.stdout, m1.stdout),
  searchIn: slice(pipe.record.stdin, m1.stdin, m2.stdin),
  searchOut: slice(pipe.record.stdout, m1.stdout, m2.stdout),
  cancelIn: slice(pipe.record.stdin, m2.stdin, m3.stdin),
  cancelOut: slice(pipe.record.stdout, m2.stdout, m3.stdout),
};

/** ② 管道把 stdout 的字节分块交给客户端（这里假设每块 64 字节）：找出切口落在多字节汉字中间的那一块。 */
export const CHUNK = 64;
const chunks: number[][] = [];
for (let at = 0; at < lines.discoverOut.length; at += CHUNK) chunks.push(lines.discoverOut.slice(at, at + CHUNK));
const isContinuation = (byte: number) => byte >= 0x80 && byte < 0xc0;
export const splitChunk = chunks.findIndex((_, i) => i > 0 && isContinuation(chunks[i][0]));
const splitAt = splitChunk * CHUNK;
/** 被切开的那个字：往前找到它的首字节。 */
const charStart = (() => {
  let at = splitAt;
  while (isContinuation(lines.discoverOut[at])) at--;
  return at;
})();
export const splitChar = utf8Decode(lines.discoverOut.slice(charStart, charStart + 3));
const decoder = new LineDecoder();
export const emitted = chunks.map((chunk) => decoder.push(chunk).length);

/** ③ 字符串里的换行：结果的 text 里有一个换行，写进 stdout 时是 5C 6E 两个字节。 */
const searchText = utf8Decode(lines.searchOut);
export const escapeAt = searchText.indexOf('\\n');
const escapeByte = utf8Encode(searchText.slice(0, escapeAt)).length;

/** ③ 带缩进的 JSON（JSON.stringify 的第三个参数）有真的换行：encodeLine 拒绝它；硬写进去，服务器会把它切成好几行。 */
export const pretty = JSON.stringify(search.request, null, 2);
export const prettyRejected = (() => {
  try {
    encodeLine(pretty);
    return false;
  } catch {
    return true;
  }
})();
const brokenServer = shopServer({ shop: createShop() });
export const brokenLines = new LineDecoder().push(`${pretty}\n`);
export const brokenReplies = brokenLines.map((line) => brokenServer.handle(line) as JsonRpcError);

/** stderr：服务器的日志（内容是示例，规范不规定格式）。 */
export const STDERR_LINE = `[${SHOP_SERVER_INFO.name}] tools/call search_policy 完成\n`;

// ---------- 文案用到的数 ----------

const lfCount = (bytes: number[]) => bytes.filter((byte) => byte === LF).length;
const leftover = (bytes: number[]) => bytes.length - (lineSpans(bytes).at(-1)?.to ?? 0);

export const numbers = {
  discoverIn: lines.discoverIn.length,
  discoverOut: lines.discoverOut.length,
  discoverInLf: lfCount(lines.discoverIn),
  lastByte: lines.discoverIn[lines.discoverIn.length - 1],
  chunks: chunks.length,
  splitChunk: splitChunk + 1,
  splitAt,
  splitChar,
  emitted,
  searchOut: lines.searchOut.length,
  escapeByte,
  escapes: searchText.split('\\n').length - 1,
  prettyLines: pretty.split('\n').length,
  prettyBytes: utf8Encode(pretty).length,
  prettyRejected,
  brokenErrors: brokenReplies.filter((reply) => reply?.error?.code === -32700).length,
  brokenHaveId: brokenReplies.some((reply) => 'id' in reply),
  cancelId: cancelled.request.id,
  cancelInLines: lineSpans(lines.cancelIn).length,
  cancelOutLines: lineSpans(lines.cancelOut).length,
  cancelBytes: utf8Encode(encodeLine(cancelNote)).length,
  serverCancelled: [...server.cancelled],
  stdinTotal: pipe.record.stdin.length,
  stdoutTotal: pipe.record.stdout.length,
  stdinLines: lineSpans(pipe.record.stdin).length,
  stdoutLines: lineSpans(pipe.record.stdout).length,
  /** 两条流最后一个 0A 之后还剩的字节（流结束时有剩余，说明最后一条消息不完整）。 */
  buffered: leftover(pipe.record.stdin) + leftover(pipe.record.stdout),
  stderrBytes: utf8Encode(STDERR_LINE).length,
};
const N = numbers;

// ---------- 图元 ----------

/** 一段字节流画成格子：每行一格（字节数），后面一格 0A。 */
function streamCells(bytes: number[], prefix: string, tone: DsCell['tone'], label: (index: number) => string): DsCell[] {
  return lineSpans(bytes).flatMap((span, index): DsCell[] => [
    { v: String(span.to - span.from - 1), tone, sub: label(index), key: `${prefix}${span.from}` },
    { v: '0A', tone: 'slate', sub: 'LF', key: `${prefix}${span.from}lf` },
  ]);
}

const stdinRow = (bytes: number[], labels: string[]): RowPrim => ({ kind: 'row', id: 'in', at: [50, -80], w: 46, cells: streamCells(bytes, 'i', 'blue', (i) => labels[i] ?? ''), title: 'stdin' });
const stdoutRow = (bytes: number[], labels: string[]): RowPrim => ({ kind: 'row', id: 'out', at: [-50, 80], w: 46, cells: streamCells(bytes, 'o', 'teal', (i) => labels[i] ?? ''), title: 'stdout' });

/** stdout 分块到达：每块一格，切在汉字中间的那块标琥珀。 */
const chunkRow = (): RowPrim => ({
  kind: 'row',
  id: 'out',
  at: [-50, 80],
  w: 46,
  cells: chunks.map((chunk, i): DsCell => ({ v: String(chunk.length), tone: i === splitChunk ? 'amber' : 'teal', sub: emitted[i] ? '凑满一行' : `第 ${i + 1} 块`, key: `c${i}`, lift: i === splitChunk || undefined })),
  title: 'stdout',
});

/** 带缩进的 JSON 被切成的行：每行一格，全是 -32700。 */
const brokenRow = (): RowPrim => ({
  kind: 'row',
  id: 'in',
  at: [50, -80],
  w: 46,
  cells: brokenLines.slice(0, 6).map((line, i): DsCell => ({ v: String(utf8Encode(line).length), tone: 'amber', sub: `第 ${i + 1} 行`, key: `b${i}` })).concat(brokenLines.length > 6 ? [{ v: `+${brokenLines.length - 6}`, tone: 'amber', sub: '还有', key: 'bmore' }] : []),
  title: 'stdin',
});

const stderrRow = (): RowPrim => ({ kind: 'row', id: 'err', at: [-260, 190], w: 46, cells: [{ v: String(N.stderrBytes - 1), tone: 'violet', sub: '日志', key: 'e0' }, { v: '0A', tone: 'slate', sub: 'LF', key: 'e0lf' }], title: 'stderr' });

const IN_LABELS = ['discover', 'tools/call', 'tools/call', 'cancelled'];
const OUT_LABELS = ['结果', '结果', '结果'];
const allIn = () => stdinRow(pipe.record.stdin, IN_LABELS);
const allOut = () => stdoutRow(pipe.record.stdout, OUT_LABELS);

const SEQ: JsonRpcMessage[] = [discovery.request, discovery.response, search.request, search.response, cancelled.request, cancelNote, cancelled.response];
const seq = (n: number): RowPrim => rpcRow('r', SEQ.slice(0, n), { w: 44 });

// ---------- 字节层 ----------

const stdinWire = (name: string, bytes: number[], notes: Record<number, string> = {}) => wire(name, 'mem', 'format', stdioLines('stdin', bytes, lineSpans(bytes), { color: 'blue', notes }));
const stdoutWire = (name: string, bytes: number[], notes: Record<number, string> = {}) => wire(name, 'mem', 'format', stdioLines('stdout', bytes, lineSpans(bytes), { color: 'teal', notes }));

// ---------- 课程 ----------

export const stdio: Lesson = {
  id: 'stdio',
  name: 'STDIO',
  title: 'stdio 传输',
  group: 'mcp',
  layer: [1, 2],
  layerNote: '这课在最底下两档：「传输」看 stdin、stdout 上的一个个字节怎样分出一条条消息，「JSON-RPC」看这些消息本身。',
  tokensNote: '这课只看子进程的标准输入输出，不调用模型，所以一直是 0。',
  nodes: ['client', 'server', 'wire', 'rpc'],
  place: { client: [200, 200], server: [860, 200], wire: [500, 560], rpc: [940, 600] },
  labels: {
    client: ['MCP 客户端', '父进程：写 stdin、读 stdout'],
    server: ['MCP 服务器', `子进程：${SHOP_SERVER_INFO.name}`],
    wire: ['标准流上的字节', '每格一行的字节数，0A 是换行'],
    rpc: ['JSON-RPC 消息', '请求写 id，通知写「通知」'],
  },
  labelAt: { wire: [-240, 275], rpc: [0, 140] },
  radius: { wire: 110, rpc: 70 },
  initial: { wire: [], rpc: [] },
  start: ['client', 'server'],
  legend: [['blue', 'stdin：客户端写'], ['teal', 'stdout：服务器写'], ['violet', 'stderr：日志'], ['amber', '切口、出错'], ['slate', '0A 换行、通知'], [null, '输入列：这课不调用模型，一直是 0']],
  overview: {
    full: '一行一条消息：子进程的标准输入输出',
    description: `stdio 是 MCP 在本机最常用的传输：客户端（宿主应用）把服务器作为子进程启动，往它的标准输入（stdin）写消息、从它的标准输出（stdout）读消息。规则只有几条：每条 JSON-RPC 消息占一行，行以换行符 0A 结尾，消息里不能有内嵌的换行；stdout 上只能有 MCP 消息，日志写到标准错误（stderr）。这一课逐字节看这些规则，再看取消请求和关闭子进程的做法。`,
    facts: [
      ['分帧', '每行一条消息，0A 结尾'],
      ['stdin', `${N.stdinLines} 行，${num(N.stdinTotal)} 字节`],
      ['stdout', `${N.stdoutLines} 行，${num(N.stdoutTotal)} 字节`],
      ['取消', 'notifications/cancelled'],
      ['输入列', '0（不调用模型）'],
    ],
  },
  steps: [
    {
      title: '启动子进程，往 stdin 写一行',
      desc: `server/discover：${N.discoverIn} 字节，最后一个是 0A`,
      detail: `宿主按配置里的命令把服务器作为子进程启动，两边之间就是这个进程的 stdin 和 stdout 两条字节流，没有 HTTP 头，版本和能力都在每条消息的 _meta 里。客户端把 server/discover 写成紧凑的 JSON，再加一个换行符，一共 ${N.discoverIn} 字节，其中 0A 只有 ${N.discoverInLf} 个，就是最后一个字节。服务器那边按 0A 切出这一行、解析、处理。`,
      facts: [['消息', 'server/discover'], ['这一行', `${N.discoverIn} 字节`], ['0A', `${N.discoverInLf} 个，在末尾`], ['头', '没有（全在 _meta 里）']],
      events: [
        pk('client', 'server', 'slate', '启动子进程', ['stdin · stdout · stderr'], [0, 'STDIO', '宿主按配置的命令启动服务器进程，接上它的三条标准流', null], wire('启动子进程', 'mem', '示意', concept('子进程的三条流', [['stdin', '客户端 → 服务器', '只能写合法的 MCP 消息（请求和通知），客户端不写响应。'], ['stdout', '服务器 → 客户端', '只能有合法的 MCP 消息：响应和通知，服务器不在上面发请求。'], ['stderr', '服务器的日志', 'UTF-8 文字，客户端可以收集、转发或忽略。']]))),
        show('wire', 'rpc'),
        pk('client', 'server', 'blue', 'stdin：discover', [`${N.discoverIn} 字节`, '…7D 0A'], [0, 'STDIO', `server/discover 写成一行：紧凑 JSON + 0A，${N.discoverIn} 字节`, N.discoverIn], stdinWire('stdin 的一行', lines.discoverIn, { 0: '一条 JSON-RPC 请求：紧凑写法，里面没有换行。' }), { ds: { wire: [stdinRow(lines.discoverIn, IN_LABELS)], rpc: [seq(1)] } }),
        state('server', { 进程: '运行中', 读: 'stdin，按 0A 切行' }),
      ],
    },
    {
      title: 'stdout 回一行，按 0A 切开',
      desc: `${N.discoverOut} 字节，分 ${N.chunks} 块到达`,
      detail: `服务器把结果也写成一行，${N.discoverOut} 字节，从 stdout 送回。管道不保证一次交付一整行：假设每次交付 ${CHUNK} 字节，这一行要分 ${N.chunks} 块，第 ${N.splitChunk} 块的切口正好落在「${N.splitChar}」的 3 个 UTF-8 字节中间。客户端的 LineDecoder 按字节找 0A，前 ${N.chunks - 1} 块只是攒着，读到最后一块里的 0A 才吐出完整的一行，再解码、解析，汉字不会被切坏。`,
      facts: [['这一行', `${N.discoverOut} 字节`], ['分块', `每块 ${CHUNK} 字节，${N.chunks} 块（假设）`], ['切口', `第 ${N.splitChunk} 块的开头，「${N.splitChar}」中间`], ['吐出', '读到 0A 之后，一次一行']],
      events: [
        pk('server', 'client', 'teal', `stdout：${N.chunks} 块`, [`每块 ${CHUNK} 字节`, `切在「${N.splitChar}」中间`], [0, 'STDIO', `结果写成一行 ${N.discoverOut} 字节，分 ${N.chunks} 块到达；第 ${N.splitChunk} 块从「${N.splitChar}」中间开始`, N.discoverOut], wire('stdout 的一行', 'mem', 'format', stdioLines('stdout', lines.discoverOut, lineSpans(lines.discoverOut), { color: 'teal', notes: { 0: `一条 JSON-RPC 结果，${N.discoverOut} 字节。第 ${N.splitAt} 字节（从 0 数）是「${N.splitChar}」的后续字节，第 ${N.splitChunk} 块从这里开始。` } }), rpcLayer('LineDecoder 拼回、解析出的结果', discovery.response, { color: 'teal', root: 'result', notes: { 'result.instructions': `「${N.splitChar}」就在这段文字里：它的字节在两块之间断开，拼回一整行之后才解码。` } })), { ds: { wire: [stdinRow(lines.discoverIn, IN_LABELS), chunkRow()] } }),
        ds({ wire: [stdinRow(lines.discoverIn, IN_LABELS), stdoutRow(lines.discoverOut, OUT_LABELS)], rpc: [seq(2)] }),
      ],
    },
    {
      title: '消息里不能有内嵌的换行',
      desc: `\\n 写成 5C 6E；带缩进的 JSON 碎成 ${N.prettyLines} 行`,
      detail: `search_policy 的结果把两段规则用换行连起来，但写进 stdout 时，JSON 字符串里的换行是转义后的「\\n」两个字符（5C 6E，在这一行的第 ${N.escapeByte} 字节），不是 0A，所以整条结果仍是一行（${N.searchOut} 字节）。带缩进的 JSON 就不一样了：同一个请求用 JSON.stringify(…, null, 2) 写出来有 ${N.prettyLines - 1} 个真的换行，encodeLine 直接拒绝。要是硬写进 stdin，服务器会把它切成 ${N.prettyLines} 行，每行都不是完整的 JSON，回 ${N.brokenErrors} 个 -32700，而且错误里没有 id，客户端对不上是哪个请求。`,
      facts: [['转义', `\\n = 5C 6E，第 ${N.escapeByte} 字节`], ['结果这一行', `${N.searchOut} 字节`], ['带缩进的请求', `${N.prettyLines} 行，${N.prettyBytes} 字节`], ['服务器回', `${N.brokenErrors} 个 -32700，没有 id`]],
      events: [
        pk('client', 'server', 'blue', 'stdin：tools/call', ['search_policy'], [0, 'STDIO', `tools/call search_policy 写成一行，${lines.searchIn.length} 字节`, lines.searchIn.length], stdinWire('stdin 的一行', lines.searchIn), { ds: { wire: [stdinRow(slice(pipe.record.stdin, 0, m2.stdin), IN_LABELS), stdoutRow(lines.discoverOut, OUT_LABELS)], rpc: [seq(3)] } }),
        pk('server', 'client', 'teal', 'stdout：结果', ['text 里有 \\n', `${N.searchOut} 字节`], [0, 'STDIO', `结果一行 ${N.searchOut} 字节：text 里的换行写成 5C 6E，不是 0A`, N.searchOut], stdoutWire('stdout 的一行', lines.searchOut, { 0: `第 ${N.escapeByte} 字节起是 5C 6E（反斜杠和 n）：JSON 字符串里转义后的换行。整行只有末尾一个 0A。` }), { ds: { wire: [stdinRow(slice(pipe.record.stdin, 0, m2.stdin), IN_LABELS), stdoutRow(slice(pipe.record.stdout, 0, m2.stdout), OUT_LABELS)], rpc: [seq(4)] } }),
        pk('client', 'server', 'amber', '带缩进的 JSON', [`${N.prettyLines} 行`, 'encodeLine 拒绝'], [0, 'ERROR', `同一个请求带缩进写出：${N.prettyLines - 1} 个真换行，服务器会切成 ${N.prettyLines} 行，回 ${N.brokenErrors} 个 -32700`, N.prettyBytes + 1], wire('硬写进 stdin 的字节（反例）', 'mem', 'format', utf8Lines('带缩进的 JSON', `${pretty}\n`, { color: 'amber', summary: `${N.prettyLines} 行：每个换行都会被当成一条消息的结尾` }), concept('服务器看到的', [['切出的行', `${N.prettyLines} 行`, '第一行只有「{」。'], ['每行的结果', '-32700 Parse error', 'JSON 解析失败，读不出 id，错误响应不带 id。'], ['客户端', '对不上请求', '它在等 id 的响应，收到的是一串没有 id 的错误。']])), { ds: { wire: [brokenRow(), stdoutRow(slice(pipe.record.stdout, 0, m2.stdout), OUT_LABELS)] } }),
      ],
    },
    {
      title: 'stderr 写日志，取消用 notifications/cancelled',
      desc: `取消 id ${N.cancelId}：stdin 两行，stdout 仍回一行`,
      detail: `日志不能写 stdout（那里只能有 MCP 消息），要写 stderr，客户端可以收集、转发或忽略，也不应把 stderr 有输出当成出错。stdio 上所有请求共用一条通道，没有「关掉这个请求的流」这回事，取消一个请求要发通知 notifications/cancelled，写明 requestId ${N.cancelId}，通知不需要回复。这台服务器同步执行，取消到的时候 id ${N.cancelId} 已经做完、结果已经写出，这正是规范说的竞态：服务器可以忽略这次取消，客户端应当忽略随后到达的那个响应。`,
      facts: [['stderr', `日志一行 ${N.stderrBytes} 字节（示例）`], ['取消通知', `requestId ${N.cancelId}，${N.cancelBytes} 字节`], ['stdin / stdout', `${N.cancelInLines} 行 / ${N.cancelOutLines} 行`], ['迟到的响应', '客户端忽略']],
      events: [
        pk('server', 'client', 'violet', 'stderr：日志', ['不进 stdout'], [0, 'STDIO', `服务器的日志写到 stderr，${N.stderrBytes} 字节（内容是示例）`, N.stderrBytes], wire('stderr 的一行（示例）', 'mem', 'format', utf8Lines('stderr', STDERR_LINE, { color: 'violet', summary: 'UTF-8 文字，格式由服务器自己定' })), { ds: { wire: [allInUntil(m2.stdin), stdoutRow(slice(pipe.record.stdout, 0, m2.stdout), OUT_LABELS), stderrRow()] } }),
        pk('client', 'server', 'blue', 'tools/call + cancelled', [`id ${N.cancelId}`, `取消 id ${N.cancelId}`], [0, 'NOTIFY', `stdin 连写两行：tools/call（id ${N.cancelId}）和 notifications/cancelled`, lines.cancelIn.length], stdinWire('stdin 的两行', lines.cancelIn, { 0: `请求 id ${N.cancelId}。`, 1: `通知：没有 id，params.requestId 是 ${N.cancelId}，reason 可选。` }), { ds: { wire: [allIn(), stdoutRow(slice(pipe.record.stdout, 0, m2.stdout), OUT_LABELS), stderrRow()], rpc: [seq(6)] } }),
        pk('server', 'client', 'teal', '迟到的结果', [`id ${N.cancelId}`, '客户端忽略'], [0, 'STDIO', `取消到达时 id ${N.cancelId} 已经做完：stdout 上仍有它的结果，客户端忽略`, lines.cancelOut.length], stdoutWire('stdout 的一行', lines.cancelOut, { 0: `id ${N.cancelId} 的结果。通知没有回复，所以只有这一行。` }), { ds: { wire: [allIn(), allOut(), stderrRow()], rpc: [seq(7)] } }),
        state('server', { 进程: '运行中', 已取消: N.serverCancelled.join('、') }),
      ],
    },
    {
      title: '关闭：关 stdin，等它退出',
      desc: `stdin ${num(N.stdinTotal)} 字节、stdout ${num(N.stdoutTotal)} 字节`,
      detail: `要结束时，客户端先关掉子进程的 stdin，服务器读到流结束（EOF）就应当尽快退出，这是规范说的主要、也是唯一可移植的优雅退出信号；这时两条流都以 0A 结尾，最后一个 0A 之后剩下 ${N.buffered} 字节，没有半条消息。等一段合理的时间还不退出，再强制结束：POSIX 上一般先 SIGTERM 再 SIGKILL，Windows 上用 TerminateProcess 或 Job Object。要是服务器意外退出，客户端重启它，把没收到响应的请求重发就行，因为协议是无状态的。`,
      facts: [['stdin', `${N.stdinLines} 行，${num(N.stdinTotal)} 字节`], ['stdout', `${N.stdoutLines} 行，${num(N.stdoutTotal)} 字节`], ['0A 之后剩下', `${N.buffered} 字节`], ['强制结束', 'SIGTERM → SIGKILL（POSIX）']],
      events: [
        pk('client', 'server', 'slate', '关闭 stdin', ['EOF'], [0, 'STDIO', '客户端关掉 stdin：服务器读到 EOF，应当尽快退出', null], wire('关闭', 'mem', '示意', concept('关闭的顺序（规范的 Shutdown 一节）', [['1', '关闭 stdin', '服务器读到 EOF 就退出，这是主要的优雅退出信号。'], ['2', '等它退出', '等一段合理的时间。'], ['3', '强制结束', 'POSIX 一般先 SIGTERM 再 SIGKILL；Windows 用 TerminateProcess 或 Job Object。']])), { ds: { wire: [allIn(), allOut()] } }),
        state('server', { 进程: '已退出', 已取消: N.serverCancelled.join('、') }),
        note('wire', `0A 之后剩下 ${N.buffered} 字节`, 'green'),
      ],
    },
  ],
  outro: {
    title: '一行一条，换行只在消息之间',
    desc: `${N.stdinLines + N.stdoutLines} 行，${num(N.stdinTotal + N.stdoutTotal)} 字节`,
    text: `stdio 的分帧就是换行：每条 JSON-RPC 消息写成紧凑 JSON 占一行，0A 只出现在消息之间，字符串里的换行转义成 5C 6E；带缩进的 JSON 会被切碎。接收方按字节找 0A，块的切口落在汉字中间也不要紧。stdout 只放 MCP 消息，日志走 stderr；取消发 notifications/cancelled，但请求可能已经做完；关闭时先关 stdin、等退出，再强制结束。stdio 只能连本机的进程，下一课看连远程服务器的 Streamable HTTP，以及它的授权。`,
    facts: [['分帧', '0A'], ['日志', 'stderr'], ['取消', 'notifications/cancelled'], ['下一课', 'Streamable HTTP 传输与授权']],
  },
};

function allInUntil(end: number): RowPrim {
  return stdinRow(slice(pipe.record.stdin, 0, end), IN_LABELS);
}
