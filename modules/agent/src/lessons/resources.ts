/**
 * MCP 组第三课：resources 与 prompts。小铺服务器把三份规则文档作为资源（policy://…）、把「申请退货」作为提示模板暴露出来：
 * resources/list → resources/read（contents 里的 uri、mimeType、text）→ 不存在的资源回 -32602；prompts/list → prompts/get（参数、返回的 messages）。
 * 最后按规范的 User Interaction Model 对比三种东西由谁决定用：工具由模型决定，资源由应用决定，提示由用户决定。
 *
 * 消息由 McpClient 和 shopServer 真实处理；资源和提示变成多少 token 用本站分词器数（只代表量级）。这课不调用模型，输入列一直是 0。
 * tests/narrative.mcp.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  countTokens,
  createShop,
  directTransport,
  HOST_CLIENT_INFO,
  McpClient,
  ORDER_ID,
  RETURN_PROMPT,
  RPC_NAME,
  SHOP_SERVER_INFO,
  shopServer,
  type JsonRpcError,
  type JsonRpcResult,
  type McpPrompt,
  type McpResource,
  type PromptMessage,
  type ResourceContents,
} from '../core';
import { concept, num, preview, utf8Lines, wire } from '../decode/structures';
import { bytesOf, rpcLayer, rpcPk, rpcRow, rpcWire } from './discover';
import { note, pk, render, show, state, type } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 真实运行 ----------

export const shop = createShop();
export const server = shopServer({ shop });
export const client = new McpClient(directTransport(server), { info: HOST_CLIENT_INFO });

const resultOf = <T>(exchange: { response: unknown }): T => (exchange.response as JsonRpcResult).result as unknown as T;

/** ① resources/list */
export const listRes = client.listResources();
const listed = resultOf<{ resources: McpResource[]; ttlMs: number; cacheScope: string }>(listRes);
export const items = listed.resources;

/** ② resources/read：《售后规则》 */
export const READ_URI = items[0].uri;
export const read = client.readResource(READ_URI);
const readResult = resultOf<{ contents: ResourceContents[]; ttlMs: number; cacheScope: string }>(read);
export const contents = readResult.contents[0];

/** ③ 不存在的资源 */
export const MISSING_URI = 'policy://warranty';
export const missing = client.readResource(MISSING_URI);
const missingError = (missing.response as JsonRpcError).error;

/** ④ prompts/list、prompts/get */
export const listPr = client.listPrompts();
export const prompts = resultOf<{ prompts: McpPrompt[]; ttlMs: number }>(listPr).prompts;
export const PROMPT_ARGS = { order_id: ORDER_ID, problem: '杯盖漏水' };
export const got = client.getPrompt(RETURN_PROMPT.prompt.name, PROMPT_ARGS);
const gotResult = resultOf<{ description: string; messages: PromptMessage[] }>(got);
export const promptText = (gotResult.messages[0].content as { text: string }).text;
/** 缺必填参数（不画成事件，只核对错误码）。 */
export const noArgs = server.handle({ ...got.request, id: 99, params: { ...got.request.params, arguments: { problem: '杯盖漏水' } } }) as JsonRpcError;

// ---------- 文案用到的数 ----------

export const numbers = {
  resources: items.map((item) => item.uri),
  sizes: items.map((item) => item.size!),
  titles: items.map((item) => item.title!),
  listBytes: bytesOf(listRes.response),
  listTtl: listed.ttlMs,
  readBytes: bytesOf(read.response),
  textBytes: utf8Encode(contents.text).length,
  textChars: [...contents.text].length,
  textLines: contents.text.split('\n').length,
  textTokens: countTokens(contents.text),
  readTtl: readResult.ttlMs,
  readScope: readResult.cacheScope,
  missingCode: missingError.code,
  missingMessage: missingError.message,
  missingData: missingError.data as { uri: string },
  promptName: prompts[0].name,
  promptArgs: prompts[0].arguments!.map((arg) => `${arg.name}${arg.required ? '（必填）' : '（可选）'}`),
  promptRole: gotResult.messages[0].role,
  promptTokens: countTokens(promptText),
  promptBytes: utf8Encode(promptText).length,
  promptCacheable: 'ttlMs' in gotResult,
  promptListTtl: resultOf<{ ttlMs: number }>(listPr).ttlMs,
  noArgsCode: noArgs.error.code,
  noArgsMessage: noArgs.error.message,
};
const N = numbers;

// ---------- 图元 ----------

const shortUri = (uri: string) => uri.replace('policy://', '');

/** 资源清单：每个资源的标题、字节数。 */
const resourceGrid = (lift?: string): GridPrim => ({
  kind: 'grid',
  id: 'g',
  w: 56,
  rows: items.map((item) => shortUri(item.uri)),
  cols: ['title', 'size'],
  cells: items.map((item) => [
    { v: item.title!.replace(/[《》]/g, ''), tone: 'teal', lift: item.uri === lift || undefined },
    { v: String(item.size), tone: 'slate', lift: item.uri === lift || undefined },
  ]),
});

/** 提示模板的参数。 */
const promptGrid = (filled = false): GridPrim => ({
  kind: 'grid',
  id: 'g',
  w: 56,
  rows: prompts[0].arguments!.map((arg) => arg.name),
  cols: ['必填', filled ? '用户填的' : '值'],
  cells: prompts[0].arguments!.map((arg) => [
    { v: arg.required ? '是' : '否', tone: arg.required ? 'blue' : 'slate' },
    filled ? { v: PROMPT_ARGS[arg.name as keyof typeof PROMPT_ARGS], tone: 'blue' } : { v: '', tone: 'empty' },
  ]),
});

/** 三种东西由谁决定用（规范 User Interaction Model）。 */
const whoGrid = (): GridPrim => ({
  kind: 'grid',
  id: 'g',
  w: 56,
  rows: ['tools', 'resources', 'prompts'],
  cols: ['谁决定'],
  cells: [[{ v: '模型', tone: 'green' }], [{ v: '应用', tone: 'teal' }], [{ v: '用户', tone: 'blue' }]],
});

/** 最后进入对话的东西：应用附上的资源原文、用户选的提示生成的消息（本站分词器的 token 数）。 */
const contextRow = (withPrompt: boolean): RowPrim => ({
  kind: 'row',
  id: 'm',
  w: 56,
  cells: [
    { v: String(N.textTokens), tone: 'teal', sub: '资源原文', key: 'res' },
    ...(withPrompt ? [{ v: String(N.promptTokens), tone: 'blue', sub: '提示的消息', key: 'pr' } as DsCell] : []),
  ],
});

const SEQ = [listRes.request, listRes.response, read.request, read.response, missing.request, missing.response, listPr.request, listPr.response, got.request, got.response];
const seq = (n: number): RowPrim => rpcRow('r', SEQ.slice(0, n), { w: 44 });

// ---------- 课程 ----------

export const resources: Lesson = {
  id: 'resources',
  name: 'RESOURCES',
  title: 'resources 与 prompts',
  group: 'mcp',
  layer: [4, 4],
  layerNote: '这课在「工具」这一档：资源、提示模板和工具一样是服务器提供的东西，区别在于由谁决定什么时候用。',
  tokensNote: '这课只有 MCP 消息，不调用模型，所以一直是 0（资源和提示变成多少 token 写在文案里）。',
  nodes: ['app', 'client', 'server', 'catalog', 'rpc', 'messages'],
  place: { app: [180, 170], client: [180, 470], server: [900, 470], catalog: [930, 170], rpc: [540, 690], messages: [540, 210] },
  labels: {
    app: ['宿主应用', '客服后台：附资料、选模板'],
    client: ['MCP 客户端', '宿主里的连接器'],
    server: ['MCP 服务器', `${SHOP_SERVER_INFO.title}`],
    catalog: ['服务器提供的', '资源、提示模板'],
    rpc: ['MCP 消息', '请求写 id，错误写错误码'],
    messages: ['放进对话的', '本站分词器的 token 数'],
  },
  labelAt: { catalog: [0, 150], rpc: [-230, 40], messages: [0, 90] },
  radius: { catalog: 80, rpc: 70, messages: 60 },
  initial: { catalog: [], rpc: [], messages: [] },
  start: ['client', 'server'],
  legend: [['blue', '请求、用户填的'], ['teal', '结果、资源'], ['amber', '错误'], ['green', '模型决定的（工具）'], [null, '输入列：这课不调用模型，一直是 0']],
  overview: {
    full: '工具之外：资料和模板',
    description: `MCP 服务器除了工具，还能提供资源（resources：按 URI 读取的数据，比如文件、数据库表结构、一份规则文档）和提示模板（prompts：带参数的、写好的消息）。小铺的服务器有 ${items.length} 个资源（${N.resources.join('、')}）和 1 个提示模板 ${N.promptName}。这一课依次列出、读取、读一个不存在的资源，再取用提示模板；最后按规范对比：工具由模型决定什么时候调，资源由应用决定怎样放进上下文，提示模板由用户明确选用。`,
    facts: [
      ['资源', `${items.length} 个，text/plain`],
      ['提示模板', `${N.promptName}：${N.promptArgs.join('、')}`],
      ['找不到资源', `${N.missingCode}，data.uri`],
      ['谁决定', '工具：模型；资源：应用；提示：用户'],
      ['输入列', '0（不调用模型）'],
    ],
  },
  steps: [
    {
      title: 'resources/list：有哪些资料',
      desc: `${items.length} 个资源，URI 用 policy://`,
      detail: `resources/list 返回资源的清单，每个资源用一个 URI 标识（这台服务器用自定义的 policy:// 方案，规范允许自定义方案），另有 name、给人看的 title、mimeType 和以字节计的 size。清单里只有「有什么」，没有内容本身：${N.titles.join('')}一共 ${N.sizes.reduce((a, b) => a + b, 0)} 字节，要读哪份再单独请求。和 tools/list 一样，这个结果可以缓存，ttlMs ${num(N.listTtl)}。`,
      facts: [['资源', N.resources.join('、')], ['size', `${N.sizes.join('、')} 字节`], ['mimeType', 'text/plain'], ['缓存', `ttlMs ${num(N.listTtl)}`]],
      events: [
        rpcPk('client', 'server', 'blue', 'resources/list', [`id ${listRes.request.id}`], 'RPC', 'resources/list：只带 _meta', listRes.request, rpcWire('resources/list 请求', listRes.request), { rpc: [seq(1)] }),
        show('catalog', 'rpc'),
        rpcPk('server', 'client', 'teal', `${items.length} 个资源`, items.map((item) => shortUri(item.uri)), 'RPC', `结果：${items.length} 个资源的 uri、name、title、mimeType、size`, listRes.response, wire('resources/list 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', listRes.response, {
          color: 'teal',
          root: 'result',
          expand: ['result.resources[0]', 'result.resources[0].uri', 'result.resources[0].size'],
          notes: {
            'result.resources[0].uri': '资源的唯一标识。policy:// 是这台服务器自定义的 URI 方案。',
            'result.resources[0].size': `内容的字节数（UTF-8）：${N.sizes[0]}。`,
            'result.ttlMs': `可以缓存 ${N.listTtl / 60000} 分钟。`,
          },
        })), { catalog: [resourceGrid()], rpc: [seq(2)] }),
      ],
    },
    {
      title: 'resources/read：读出原文',
      desc: `${READ_URI}，${N.textBytes} 字节`,
      detail: `resources/read 只带一个参数 uri。结果的 contents 是一个数组（读一个目录这类资源时可以有好几项），每项带 uri、mimeType，文本放在 text 里；图片这类二进制内容改用 blob，值是 base64，这台服务器的资源都是文本。《售后规则》${N.textLines} 段、${N.textBytes} 字节，和清单里的 size 一样；读的结果也可以缓存，ttlMs ${num(N.readTtl)}、cacheScope ${N.readScope}。`,
      facts: [['uri', READ_URI], ['mimeType', contents.mimeType!], ['text', `${N.textBytes} 字节，${N.textLines} 段`], ['缓存', `ttlMs ${num(N.readTtl)}，${N.readScope}`]],
      events: [
        rpcPk('client', 'server', 'blue', 'resources/read', [`id ${read.request.id}`, READ_URI], 'RPC', `resources/read：uri ${READ_URI}`, read.request, rpcWire('resources/read 请求', read.request, { expand: ['params.uri'], notes: { 'params.uri': '要读哪个资源。' } }), { catalog: [resourceGrid(READ_URI)], rpc: [seq(3)] }),
        rpcPk('server', 'client', 'teal', `contents：${N.textBytes} 字节`, [contents.mimeType!, preview(contents.text, 14)], 'RPC', `结果：contents[0] 的 uri、mimeType、text（${N.textBytes} 字节）`, read.response, wire('resources/read 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', read.response, {
          color: 'teal',
          root: 'result',
          expand: ['result.contents[0]', 'result.contents[0].uri', 'result.contents[0].mimeType', 'result.contents[0].text'],
          notes: {
            'result.contents[0].mimeType': 'text/plain：文本。',
            'result.contents[0].text': `规则原文，${N.textBytes} 字节。二进制内容会改用 blob（base64）。`,
            'result.cacheScope': `${N.readScope}：内容对每个用户都一样。`,
          },
        }), utf8Lines('text 的内容', contents.text, { color: 'teal', summary: `${N.textLines} 段规则，每段一行` })), { rpc: [seq(4)] }),
        state('client', { 已读: READ_URI, 大小: `${N.textBytes} 字节` }),
      ],
    },
    {
      title: '资源不存在：-32602',
      desc: `${MISSING_URI}`,
      detail: `读一个服务器没有的 ${MISSING_URI}，服务器回 ${N.missingCode}（Invalid params），data 里带上请求的 uri。旧版规范用的是 -32002，2026-07-28 版改成 -32602，和 JSON-RPC 的「参数不对」一致，客户端仍应当认得旧的 -32002。规范还特别规定：不存在的资源不能回一个空的 contents 数组，因为空数组分不清是「资源存在但没有内容」还是「根本没有这个资源」。`,
      facts: [['错误码', `${N.missingCode} ${RPC_NAME[N.missingCode]}`], ['message', N.missingMessage], ['data', `uri ${N.missingData.uri}`], ['旧版', '-32002']],
      events: [
        rpcPk('client', 'server', 'blue', 'resources/read', [`id ${missing.request.id}`, MISSING_URI], 'RPC', `resources/read：uri ${MISSING_URI}（服务器没有）`, missing.request, rpcWire('resources/read 请求', missing.request, { expand: ['params.uri'], notes: { 'params.uri': `${MISSING_URI}：清单里没有。` } }), { rpc: [seq(5)] }),
        rpcPk('server', 'client', 'amber', `${N.missingCode} Resource not found`, [`data.uri`], 'ERROR', `${N.missingCode} Resource not found，data 带 uri`, missing.response, rpcWire('错误响应', missing.response, { color: 'amber', root: 'error', notes: { 'error.code': `${N.missingCode}：Invalid params（旧版是 -32002）。`, 'error.data': '请求的 uri，方便客户端知道是哪一个。' } }), { rpc: [seq(6)] }),
      ],
    },
    {
      title: 'prompts：用户选一个模板',
      desc: `${N.promptName}，返回 ${gotResult.messages.length} 条 ${N.promptRole} 消息`,
      detail: `客服在后台的输入框里选了「${prompts[0].title}」模板，填上订单号和问题（这里写成斜杠命令，是规范举的一种界面，协议不规定界面）。客户端先用 prompts/list 列出模板和参数：${N.promptArgs.join('、')}；再用 prompts/get 带上 name 和 arguments，服务器按模板生成 messages，这里是 ${gotResult.messages.length} 条 role 为 ${N.promptRole} 的消息，${N.promptBytes} 字节。缺了必填的 order_id 会回 ${N.noArgsCode}；prompts/get 的结果不在可缓存之列，prompts/list 可以缓存（ttlMs ${num(N.promptListTtl)}）。`,
      facts: [['参数', N.promptArgs.join('、')], ['messages', `${gotResult.messages.length} 条 ${N.promptRole}，${N.promptBytes} 字节`], ['缺参数', `${N.noArgsCode}：${N.noArgsMessage}`], ['内容由谁写', '服务器（模板）']],
      events: [
        show('app'),
        type(`/${N.promptName} ${PROMPT_ARGS.order_id} ${PROMPT_ARGS.problem}`),
        rpcPk('client', 'server', 'blue', 'prompts/list', [`id ${listPr.request.id}`], 'RPC', 'prompts/list：列出提示模板', listPr.request, rpcWire('prompts/list 请求', listPr.request), { rpc: [seq(7)] }),
        rpcPk('server', 'client', 'teal', `1 个模板`, [N.promptName, N.promptArgs.join(' ')], 'RPC', `结果：${N.promptName}，参数 ${N.promptArgs.join('、')}`, listPr.response, wire('prompts/list 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', listPr.response, { color: 'teal', root: 'result', expand: ['result.prompts[0].arguments'], notes: { 'result.prompts[0].arguments': '模板的参数：名字、说明、是否必填。' } })), { catalog: [promptGrid()], rpc: [seq(8)] }),
        rpcPk('client', 'server', 'blue', 'prompts/get', [`id ${got.request.id}`, `${PROMPT_ARGS.order_id}、${PROMPT_ARGS.problem}`], 'RPC', `prompts/get：name ${N.promptName}，arguments 是用户填的两项`, got.request, rpcWire('prompts/get 请求', got.request, { expand: ['params.name', 'params.arguments'], notes: { 'params.arguments': '用户在界面上填的值，参数值都是字符串。' } }), { catalog: [promptGrid(true)], rpc: [seq(9)] }),
        rpcPk('server', 'client', 'teal', `messages：${gotResult.messages.length} 条`, [preview(promptText, 16)], 'RPC', `结果：description 和 ${gotResult.messages.length} 条 ${N.promptRole} 消息`, got.response, wire('prompts/get 结果', 'mem', 'format', rpcLayer('JSON-RPC 结果', got.response, { color: 'teal', root: 'result', expand: ['result.messages[0]', 'result.messages[0].role', 'result.messages[0].content'], notes: { 'result.messages[0].role': `${N.promptRole}：这条消息以用户的身份放进对话。`, 'result.messages[0].content': '模板按参数生成的文字。' } })), { rpc: [seq(10)] }),
        pk('client', 'app', 'blue', '填进输入框', [preview(promptText, 16)], [0, 'CALL', `生成的消息交给宿主，填进输入框（${N.promptBytes} 字节）`, N.promptBytes], wire('生成的用户消息', 'mem', 'format', utf8Lines('text', promptText, { summary: '用户确认后作为一条 user 消息发出' }))),
        render,
      ],
    },
    {
      title: '谁来决定用：模型、应用、用户',
      desc: '工具、资源、提示模板各有主人',
      detail: `规范给三种东西写了不同的交互模型：工具是 model-controlled，由模型根据上下文自己发现、自己调用；资源是 application-driven，由宿主应用决定怎样放进上下文，可以让用户在界面上挑，也可以按启发式或模型的选择自动带上；提示模板是 user-controlled，由用户明确选用，内容却是服务器写的。这次是应用把《售后规则》原文附进对话（${N.textTokens} 个 token），用户选的模板生成了 1 条消息（${N.promptTokens} 个 token，都按本站分词器数）。规范也说明，这是设计上的分工，协议本身不规定界面怎样呈现。`,
      facts: [['tools', 'model-controlled：模型决定'], ['resources', 'application-driven：应用决定'], ['prompts', 'user-controlled：用户决定'], ['放进对话', `资源 ${N.textTokens} + 提示 ${N.promptTokens} token`]],
      events: [
        show('messages'),
        pk('app', 'messages', 'teal', '附进对话', [`资源 ${N.textTokens} token`, `提示 ${N.promptTokens} token`], [0, 'CALL', `应用把 ${READ_URI} 的原文（${N.textBytes} 字节）和用户选的提示消息（${N.promptBytes} 字节）放进对话`, N.textBytes + N.promptBytes], wire('附进对话的资源原文', 'mem', 'format', utf8Lines('资源原文', contents.text, { color: 'teal', summary: '应用决定附上它（application-driven）' }), utf8Lines('提示的消息', promptText, { summary: '用户选的模板生成的（user-controlled）' }), concept('三种东西由谁决定', [['tools', '模型', 'model-controlled：模型根据上下文自己发现、调用；规范建议有人能拒绝调用。'], ['resources', '应用', 'application-driven：宿主决定怎样放进上下文。'], ['prompts', '用户', 'user-controlled：用户明确选用，比如斜杠命令；内容由服务器定义。']])), { ds: { catalog: [whoGrid()], messages: [contextRow(true)] } }),
        note('catalog', '协议不规定界面', 'navy'),
      ],
    },
  ],
  outro: {
    title: '同一台服务器，三种东西三个主人',
    desc: `${items.length} 个资源、1 个提示模板`,
    text: `资源是按 URI 读的数据：resources/list 列清单（可缓存），resources/read 读内容（contents 里 text 或 base64 的 blob），找不到回 ${N.missingCode} 并在 data 里带 uri，不能回空数组。提示模板是服务器写好的、带参数的消息：prompts/list 列出参数，prompts/get 按参数生成 messages。和工具不同，资源由应用决定怎样放进上下文（可以参考模型的选择，但决定权在应用），提示模板由用户明确选用。这三课都没管消息怎样在线上走，下一课看第一种传输：stdio。`,
    facts: [['resources', 'list、read，-32602'], ['prompts', 'list、get'], ['谁决定', '模型、应用、用户'], ['下一课', 'stdio 传输']],
  },
};
