# Agent Explorer

用交互动画讲一个 Agent 怎样调用工具把事办完：模型和运行时怎样一轮轮交替（Agent 循环），工具从哪里来、怎样通过 MCP 连上（MCP 协议），几个 Agent 怎样分工、谁说了算（多 Agent）。循环本身、工具执行、token 数、费用、JSON-RPC 消息、stdio 的字节、HTTP 报文全部由 `src/core/` 真实计算；模型「每一轮说什么、调用什么」无法真实生成（本站不跑大模型），作为脚本写死并标 E.G.，但围绕它的一切——消息历史怎样累积、工具结果怎样回填、stop_reason 怎样决定停不停、每轮读了多少 token——都真实执行。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。和 LLM、CONTEXT、RAG EXPLORER 是同一系列、同一套约定；场景还是网店「小铺」的客服 Agent 处理订单 A1024 的杯盖漏水（CONTEXT EXPLORER 讲它的上下文，RAG EXPLORER 讲它的 `search_docs` 背后的检索，这门课讲它的循环、协议和协作）。

## 开发

本模块由主站统一提供服务，地址是 `/modules/agent/`。启动和构建在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test                 # 本模块的单元测试
python scripts/subset-fonts.py <woff2 目录>  # 按本站字符重新裁剪 Iosevka（需要 fonttools、brotli），字体源见脚本开头
```

端到端测试在仓库根目录：`npx playwright test --project=agent`。

## 结构

- `src/core/`：计算核心，纯 TypeScript，确定性（示例 id 来自固定种子）。接口见下文。
- `src/lessons/`：每节课一个文件。`index.ts` 的 `PLANNED` 是 13 节课的顺序和分组，`LESSONS` 按同样的顺序列出全部 13 课；`types.ts` 是节点、事件和图元的类型；`dsl.ts` 是写事件的简写；`common.ts` 是画消息历史和账的小工具；`scenario.ts` 是各课共用的场景（客服 Agent 的配置、用户的请求、ReAct 课的脚本）。
- `src/decode/`：可信度（`writer.ts`）和按真实格式写字节的层（`structures.ts`）。
- `src/scene/`：`devices.ts` 是设备节点的图形，`ds.ts`、`plugin.ts` 和 llm、context、rag 逐字相同（数据结构图元的几何和帧间动画）。
- `tests/`：`core.test.ts` 核对场景数据、参数校验、工具和 Agent 循环；`core.mcp.test.ts` 核对 JSON-RPC、MCP 服务器和客户端、stdio、Streamable HTTP、授权和接进循环的桥（期望值手写自规范，或用 `JSON.stringify`、`Buffer` 这类独立写法核对）；`decode.test.ts` 核对写字节的层；`lessons.test.ts` 检查每节课的结构和布局；`narrative.test.ts` 核对 react 课的文案和计算结果；`player.test.ts` 检查播放器。
- `e2e/app.spec.ts`：端到端测试，课程清单取自源码。
- Messages API、token 计数、ChatML 模板、计费、SSE、JSON、HTTP、BM25、示例 id 不在本模块，在共享包 `packages/llm-core`（`@explorer/llm-core`），见下文「共享包」。

## 本站约定

**抽象层级（顶栏 7 档，从下到上）**：传输、JSON-RPC、能力、工具、循环、编排、用户。

| 档 | 讲什么 | 哪些课在这一档 |
|---|---|---|
| 1 传输 | 字节怎样在线上走：stdio 的一行行 JSON、HTTP 报文、SSE 事件 | stdio、http |
| 2 JSON-RPC | 一条条消息：请求、响应、通知，id 和错误码 | discover、toolscall、stdio、http |
| 3 能力 | 双方声明支持什么：协议版本、客户端能力、服务器能力、授权 | discover、http |
| 4 工具 | 一次工具调用：定义、参数校验、执行、结果 | react、tooldefs、parallel、toolscall、resources |
| 5 循环 | 一轮轮调用模型和工具，直到停下 | react、parallel、stopping、sdks |
| 6 编排 | 几个 Agent 怎样分工：子 Agent、转交 | orchestrate、handoff |
| 7 用户 | 用户看到、确认、拒绝的东西 | approval |

前三档是 MCP 自己的分层（规范把传输、基础协议、能力协商分开讲），后四档是 Agent 系统的分层：工具是一次调用，循环是一个 Agent，编排是几个 Agent，用户在最上面拍板。名称和任务说明里的建议相同。这是本站的教学约定，不是业界标准分层。每节课用 `layer: [lo, hi]` 标出跨了哪几档，`layerNote` 写一句为什么（以句号结尾）。

**输入列（轨迹表第二列，`Row.tokens`）**：到这个事件为止，这一课里模型**累计读入的输入 token**——每一轮 `usage.input_tokens` 之和（含工具系统提示），由 `runAgent` 记账，取 `turn.after.input`（发请求的事件取 `turn.before.input`：模型还没读到）。必须单调不减（测试检查），不能手写。每节课用 `tokensNote` 写一句这课具体累计了什么（以句号结尾），会拼进表头提示。字节数放在最后一列「大小」（`Row.size`）。

选它而不选「累计模型调用轮数」或「累计 token（输入 + 输出）」，是因为 Agent 的成本主要在这里，而且它能精确核对：

- API 是无状态的，每一轮都要把整段历史重新发一次，所以第 n 轮读的是前面所有轮的想法、调用和结果之和，累计输入大约随轮数平方增长。react 课 4 轮，单轮输入从 1,684 涨到 2,793，累计 8,850，是最后一轮的 3.2 倍——只数轮数（4）看不出后面的轮比前面的贵；
- 输出 token 在 Agent 循环里很少（tool_use 的 JSON、一两句想法），react 课 4 轮一共 611，和输入混在一起会被淹没，费用和输出数在「账」和文案里单独讲；
- 它是整数，等于每轮 `inputBreakdown(request).total + 286`，测试逐轮核对。

代价是 MCP 组有的课整课不调用模型（只看协议），这一列一直是 0（测试只要求 loop、multi 两组最后大于 0）。写 MCP 课时建议在最后一步把 `tools/list` 的结果接进一次模型调用（`mcpToolBox`），让这一列体现「接上服务器之后，工具定义每轮都要付钱」。

MCP 组这一列的读法：discover、resources、stdio、http 四课只有客户端和服务器之间的消息，整课是 0，表示「这一步没有模型读任何东西」，不是「协议消息不花钱」——协议消息的开销看最后一列字节数；toolscall 课前三步是 0，第四步起是接进循环后两轮 `usage.input_tokens` 的累计（1,995、4,268）。

**token 数的口径**：和 CONTEXT EXPLORER 相同，是迷你 BPE 分词器（96 条合并规则）按 ChatML 展开后的真实计数，只代表量级关系，真实模型的分词器不同（中文、`system` 这类词合并得多得多），课程文案里要说明。唯一的例外是带工具时 API 自动加的工具系统提示：用文档给的数（Claude Opus 5.5 是 286，`MODELS[model].toolSystemTokens`），因为它的原文不公开，本站数不了。

**可信度（检查器顶部，`Fidelity`）**：
- `format`：公开规范或 API 文档定义的真实字节：HTTP/1.1、SSE、JSON、UTF-8、JSON-RPC 2.0、MCP 规范的消息、`_meta` 键和头，以及 Messages API 的字段（tool_use、tool_result、stop_reason、usage）。stdio 上的一行行 JSON、MCP 的 POST 和响应都是 format。
- `internal`：某一个实现的内部细节，真实但会随版本变化：ChatML 怎样展开工具和消息（`promptPieces`）、本站订单表和规则库在内存里的样子、BM25 的打分结果、运行时内部的记账。
- `示意`：只讲概念，没有字节（`concept()` 层）。

**示例值（E.G.）**：每次都不同的值（msg / toolu / req id、date、密钥）和模型写的内容（每轮的 text、tool_use 的 input、usage），字段加 `example: true`。脚本里写的话是示例，但其中的日期、天数、单号、金额都从工具的真实结果里取（脚本的一步可以是函数，见 `scenario.ts`）。密钥打码写成未知字节（`LayerWriter.unknown`），hex 里显示 `··`。

**价格**：一律是示例，用共享包 `pricing.ts` 的 `PRICES` 和 `PRICE_DATE`（2026-11-06，和 CONTEXT EXPLORER 相同），日期要出现在课程里。

**配色**（`common.ts` 的 `PART_TONE`，全站统一）：用户的话 blue，模型写的文字（想法、回答）green，行动（tool_use）amber，观察（tool_result）teal，system 和工具定义 violet，协议和模板的开销（HTTP 头、JSON-RPC 外壳、ChatML 标记）slate。出错的 tool_result 也用 amber，格子下面写「出错」。

## 课程规划（`PLANNED`，13 课）

| 组 | id | 标题 | 要点 |
|---|---|---|---|
| loop | `react` | ReAct：思考 → 行动 → 观察 | 4 轮、3 次工具调用，历史每轮整份重发 |
| loop | `tooldefs` | 工具定义如何进入提示 | tools 的 JSON Schema 怎样展开成 token（`inputBreakdown(...).tools`、`promptPieces`），工具系统提示 286；工具多了每轮都贵 |
| loop | `parallel` | 并行工具调用与结果回填 | 一轮里两个 tool_use，tool_result 按 tool_use_id 对应、全部放进同一条 user 消息、排在文字前面；`disable_parallel_tool_use` |
| loop | `stopping` | 工具报错、最大轮数与停止 | `is_error` 的结果、模型改参数重试、`max_tokens` 截断、`maxTurns` 停下（`stop: 'max_turns'`），stop_reason 各取值 |
| loop | `sdks` | 手写循环 vs SDK | 同一个循环在 Anthropic SDK 的 tool runner、Claude Agent SDK、OpenAI Agents SDK、LangChain `create_agent` 里由谁执行（只写下文事实表里核对过的名字） |
| mcp | `discover` | 无状态协议：版本、能力与 server/discover | 2026-07-28 版没有 initialize 握手：每个请求的 `_meta` 自带协议版本和能力，版本不对回 -32022；`server/discover`；和旧版握手的对比 |
| mcp | `toolscall` | tools/list 与 tools/call | Tool 的 inputSchema、annotations、缓存提示 ttlMs / cacheScope、分页；协议错误（-32602）和工具错误（isError）的区别；接进循环 |
| mcp | `resources` | resources 与 prompts | `resources/list`、`resources/read`（找不到是 -32602）、`prompts/list`、`prompts/get`；谁来决定用：工具由模型决定，资源和提示由应用和用户决定 |
| mcp | `stdio` | stdio 传输 | 子进程、一行一条消息、不能有内嵌换行、stderr 写日志、`notifications/cancelled`；逐字节看 stdin / stdout |
| mcp | `http` | Streamable HTTP 传输与授权 | POST、Accept 两种类型、`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 镜像请求体（-32020）、JSON 或 SSE 响应、202、没有会话；401 → Protected Resource Metadata → 授权服务器 → 带 resource 的令牌 |
| multi | `orchestrate` | 编排者与子 Agent | `agentTool`：编排者把子任务交给两个子 Agent，各自在干净的上下文里跑完，只交回结果；`grandTotals` 记总账。和 CONTEXT 的 isolation 课区分：那课讲上下文账，这课讲编排的消息流 |
| multi | `handoff` | Agent 间转交（handoff） | `handoffTool`：分诊 Agent 调用 `transfer_to_returns`，之后换成退货专员的 system 和工具，历史不变；和子 Agent 的区别（谁继续和用户说话） |
| multi | `approval` | 工具权限与人工确认 | 以工具结果里的间接提示注入为动机（`web` 节点）：`permit` 拦下危险工具、最小权限；MCP 的 elicitation（`input_required` → 用户确认 → 带 inputResponses 重发）。注入的检测和评估留给以后的 LLMOPS 课 |

和任务说明里的建议相比改了两处：

- **⑥ 不再是「初始化握手与能力协商」**。2026-11-06 核对时最新正式版是 2026-07-28，这一版把 `initialize` / `notifications/initialized` 握手和会话整个去掉了（见事实表），能力改成每个请求在 `_meta` 里声明。照旧版讲握手就是讲错的东西，所以这课改讲无状态的版本和能力协商、`server/discover`，旧版的握手作为对比放在一步里。
- **⑩ 里没有 `Mcp-Session-Id`**：同样是 2026-07-28 版去掉的，课程讲「为什么没有会话」，旧版的会话作为对比。
- 课数 13，分组 5 / 5 / 3：循环组 5 课先把单个 Agent 讲透，MCP 组 5 课正好是规范的五块（基础协议与版本、tools、resources / prompts、两种传输），多 Agent 组 3 课够讲编排、转交和权限；权限课放在多 Agent 组，因为它讲的是「谁说了算」（模型、运行时、用户），和编排同一个问题。

## 节点

`src/lessons/types.ts` 的 `NODE_IDS`，一次设计好全部课程会用到的节点，每节课在 `nodes` 里挑自己要的。设备节点有固定图形，可以挂状态面板（每个最多 4 行）；数据节点没有外形，长相就是课程给它的图元，不能挂状态面板。

| 节点 | 类型 | 用途 |
|---|---|---|
| `app` | 设备 | 应用界面：用户提问、看回答、点确认。带屏幕（`render` 逐行画出），命令框（`type`）挂在它上方 |
| `agent` | 设备 | Agent 运行时（循环 / harness）：组装请求、调用模型、执行工具、回填结果、判断停止、记账。多 Agent 组里是编排者 |
| `llm` | 设备 | 模型：Messages API 背后的大模型，写内容块（文字和 tool_use），内容是示例 |
| `tools` | 设备 | 工具执行端：应用这一侧真正执行的函数，参数先按 JSON Schema 校验 |
| `db` | 设备 | 业务数据库：订单、退货单、退款记录（内存示例数据） |
| `policy` | 设备 | 规则库：售后、退款、运费规则，BM25 检索 |
| `client` | 设备 | MCP 客户端：宿主里的连接器，编号、带 `_meta`、经传输发出去 |
| `server` | 设备 | MCP 服务器：「小铺售后服务」（`shopServer`） |
| `authz` | 设备 | 授权服务器：OAuth 2.1，发访问令牌 |
| `subagent` | 设备 | 子 Agent：在自己干净的上下文里跑完一个子任务，只交回结果 |
| `subagent2` | 设备 | 第二个子 Agent，和 `subagent` 并行 |
| `peer` | 设备 | 接手的 Agent：转交之后由它接着和用户对话 |
| `guard` | 设备 | 权限检查：工具执行前放行、拒绝或交给用户确认 |
| `web` | 设备 | 外部内容：网页、邮件、第三方评价这类不可信的文字（间接提示注入的来源） |
| `request` | 数据 | 请求：HTTP 头和 JSON 请求体的字段 |
| `response` | 数据 | 响应：content、stop_reason、usage，或 JSON-RPC 的 result |
| `messages` | 数据 | 消息历史：每个内容块一格（`historyRow`） |
| `toolset` | 数据 | 工具定义：name、description、input_schema 和它们的 token |
| `prompt` | 数据 | 展开后的提示：system、工具、每条消息、模板各占多少 token |
| `calls` | 数据 | 这一轮的 tool_use 块 |
| `results` | 数据 | tool_result 块，is_error 标出失败 |
| `usage` | 数据 | 账：每一轮的输入 / 输出 token、合计（`ledgerGrid`） |
| `turns` | 数据 | 循环状态：第几轮、每轮的 stop_reason、离最大轮数还有几轮 |
| `rpc` | 数据 | JSON-RPC 消息：id、method、result / error |
| `wire` | 数据 | 传输上的字节：stdio 的行、HTTP 报文、SSE 事件 |
| `caps` | 数据 | 版本和能力：`_meta` 里的版本和客户端能力、discover 返回的服务器能力 |
| `catalog` | 数据 | 服务器提供的东西：tools、resources、prompts 的列表 |
| `tasks` | 数据 | 子任务：编排者拆出的任务、交给谁、交回了什么 |

图元（`Prim`）和 llm、context、rag 相同：`row`、`grid`、`graph`、`ring`、`tower`，格子可以带 `heat`（0–1）。轨迹表「类型」列的取值见 `TraceType`（CALL、HTTP、JSON、TOKENS、INFER、TOOL、RESULT、STOP、RPC、NOTIFY、STDIO、SSE、AUTH、DISCOVER、DELEGATE、HANDOFF、CONFIRM、DENY、ERROR）。

## 计算核心接口（`src/core/`）

全部从 `src/core/index.ts` 导出：`import { runAgent, shopToolBox, createShop, McpClient, shopServer, ... } from '../core'`。共享包的 Messages API（`anthropic`）、计费（`pricing`）、示例 id（`ids`）、JSON、HTTP、SSE、ChatML 模板（`template`）整体转导出，另外转导出 `countTokens`、`encodeText`、`tokenLabel`、`bm25`、`termsOf`。

### 场景数据（`shop.ts`）

| 签名 | 说明 |
|---|---|
| `SHOP`、`TODAY`（`'2026-11-06'`）、`ORDER_ID`（`'A1024'`） | 店名；课程里的「今天」（和 CONTEXT 的示例时刻同一天）；主角订单 |
| `ORDERS: readonly Order[]`、`Order { order_id; item; sku; amount; status; carrier; signed_at }` | 三个订单：A1024 保温杯 129 元 11-03 签收；A1025 电热水壶 199 元 10-20 签收（超过 7 天）；A1031 密封圈 12 元未签收 |
| `POLICIES: readonly PolicyDoc[]`、`PolicyDoc { id; text }` | 8 段规则（《售后规则》4 条、《退款说明》2 段、《运费说明》、配送），id 写成 `aftersale#3` |
| `QUALITY_RETURN_DAYS`、`NO_REASON_RETURN_DAYS`（都是 7） | 退货期限 |
| `ShopState { today; orders: Map; returns: ReturnTicket[]; refunds: RefundRecord[] }`、`createShop(today = TODAY)` | 一份新的可变状态，工具改它；每课自己建一份 |
| `daysBetween(from, to)` | 两个 YYYY-MM-DD 之间的日历日数 |
| `ReturnTicket { return_id; order_id; reason; note; refund; shipping_paid_by; status }`、`RefundRecord { refund_id; order_id; amount }` | 退货单、退款记录 |

### 参数校验（`schema.ts`）

| 签名 | 说明 |
|---|---|
| `validate(schema, value, path = ''): SchemaError[]` | JSON Schema 子集：type、properties、required、additionalProperties: false、enum、minLength、maxLength、pattern、minimum、maximum、items；错误带路径（`order_id`、`items[0]`）。遇到 $ref、anyOf 等不支持的关键字直接抛错 |
| `formatErrors(errors)` | 写成一行给模型看：`order_id：缺少必填参数；id：不认识的参数` |

### 工具（`tools.ts`）

| 签名 | 说明 |
|---|---|
| `interface ToolSpec { name; title?; description; input_schema; hints?; handoff?; run(input, ctx) }` | 一个工具：定义加实现。`hints` 是 MCP ToolAnnotations 的四个提示（readOnlyHint、destructiveHint、idempotentHint、openWorldHint）；`handoff` 是转交工具的目标 |
| `interface ToolOutcome { content; is_error?; data?; child? }` | 执行结果：交回模型的文字、是否出错、结构化数据（画图用）、子 Agent 的整次运行 |
| `ToolContext { shop }` | 工具执行时能碰到的东西 |
| `GET_ORDER`、`SEARCH_POLICY`、`CREATE_RETURN`、`ISSUE_REFUND`、`SHOP_TOOLS` | 小铺的四个工具。search_policy 用 BM25 取前 top_k 段（默认 2）；create_return 自己算签收天数，超期、未签收、重复都返回 is_error；issue_refund 是 destructive，要有退货单、金额不超过实付 |
| `returnIdOf(today, seq)` | 退货单号 `R20261106-001`（本站写法） |
| `PolicyHit { id; text; score }` | search_policy 的 `data` |
| `new ToolBox(specs)`、`.definitions(): ToolDefinition[]`、`.get(name)`、`.call(name, input, ctx): ToolOutcome` | 工具箱：给模型的定义（name、description、input_schema，顺序不变）；执行（不认识的工具、参数不合格、实现抛异常都变成 is_error，不向外抛） |
| `shopToolBox(names = ['get_order', 'search_policy', 'create_return'])` | 按名字挑几个小铺的工具 |

### Agent 循环（`loop.ts`）

| 签名 | 说明 |
|---|---|
| `DEFAULT_MODEL`（`claude-opus-5-5`）、`DEFAULT_MAX_TOKENS`（1024）、`DEFAULT_MAX_TURNS`（10） | 默认值。10 和 OpenAI Agents SDK 的 `DEFAULT_MAX_TURNS` 相同；Claude Agent SDK 默认不限 |
| `AgentConfig { name; model; system; tools: ToolBox; maxTokens?; toolChoice? }` | 一个 Agent |
| `runAgent(config, user, script, options): AgentRun` | 跑一个 Agent：从用户的一句话（字符串或内容块）开始，每轮 `buildRequest` → `inputBreakdown` → `createMessage(request, 脚本这一轮的内容块)`（stop_reason、max_tokens 截断、usage 真实计算）→ usage.input_tokens 加上工具系统提示 → 追加助手消息 → tool_use 就逐个执行（先过 `permit`）→ 全部 tool_result 按顺序放进同一条 user 消息 → 停止判断（不是 tool_use 就停；到 `maxTurns` 停，stop 是 `max_turns`）。脚本不够用时抛错 |
| `RunOptions { ctx; maxTurns?; seed?; history?; permit?; agents? }` | `seed`：第 n 轮的 msg / req id 用 seed + n；`history`：之前的对话；`permit(use, spec, agent)` 返回 `{ allow: true }` 或 `{ allow: false, reason }`；`agents`：转交目标 |
| `ScriptStep = ContentBlock[] \| ((view: ScriptView) => ContentBlock[])`、`ScriptView { turn; agent; messages; lastCalls; calls }` | 脚本的一轮：写死的内容块，或拿到此刻的历史和工具结果再决定（文字里的日期、单号从结果取） |
| `text(value)`、`toolUse(name, input, seed)` | 脚本的写法：文字块；工具调用（id 是固定种子的示例 `toolu_01…`） |
| `AgentRun { agent; turns; messages; stop; final; totals; children }` | 一次运行：每一轮、最后的完整历史、停下的原因（`StopKind` = stop_reason 或 `max_turns`）、最后的回答文字、自己的累计、子 Agent 的运行 |
| `AgentTurn { index; agent; request; breakdown; toolSystem; message; cost; calls; before; after; http }` | 一轮：请求、输入的构成（ChatML 展开）、加上的工具系统提示、响应（usage 已含工具系统提示）、费用（纳美元）、工具调用、这一轮前后的累计、请求和响应的 HTTP 字节（`encodeRequest` / `encodeResponse` 的 layout） |
| `ToolCall { use; outcome; result; denied }` | 一次工具调用：tool_use 块、执行结果、回填的 tool_result 块、是否被权限拦下 |
| `Totals { turns; input; output; cost }`、`ZERO`、`addTotals(a, b)`、`grandTotals(run)` | 累计账（费用是纳美元整数）；连同子 Agent 的总账 |
| `buildRequest(config, messages)`、`toolSystemTokens(request)`、`textOf(message)` | 组装一轮的请求（历史整份复制）；工具系统提示（有工具且 tool_choice 是 auto / none 时取 `MODELS[model].toolSystemTokens`，any / tool 时抛错——本站没有那两种的数）；一条消息的文字 |
| `agentTool(name, description, child, script, options?)` | 把子 Agent 包成工具：参数 `task`，子 Agent 从它开始在干净的上下文里跑完，`final` 作为 tool_result 交回，整次运行放在 `outcome.child`；子 Agent 没有 end_turn 时结果是 is_error |
| `handoffTool(target, description)` | 转交工具 `transfer_to_<target>`（参数为空）：调用成功后循环换成 `options.agents[target]` 的 system 和工具，历史不变 |

### JSON-RPC 2.0（`mcp/jsonrpc.ts`）

| 签名 | 说明 |
|---|---|
| `JsonRpcRequest`、`JsonRpcNotification`、`JsonRpcResult`（`result.resultType` 必有）、`JsonRpcError`（id 可省）、`JsonRpcMessage`、`RequestId` | 消息类型 |
| `RPC`、`RPC_NAME` | 错误码：-32700、-32600、-32601、-32602、-32603，MCP 的 -32020 HeaderMismatch、-32021 MissingRequiredClientCapability、-32022 UnsupportedProtocolVersion |
| `rpcRequest(id, method, params?)`、`rpcNotification(method, params?)`、`rpcResult(id, result)`、`rpcError(id, code, message, data?)` | 构造 |
| `kindOf(value)`、`parseRpc(text)`、`isRequest` / `isNotification` / `isError` / `isResult` | 判断类型（id 不能是 null，params 必须是对象）；解析（JSON 坏了 -32700，结构不对 -32600，都不带 id） |

### MCP 协议（`mcp/protocol.ts`）

| 签名 | 说明 |
|---|---|
| `PROTOCOL_VERSION`（`'2026-07-28'`）、`LEGACY_VERSIONS` | 最新正式版；用 initialize 握手的旧版本 |
| `META` | `_meta` 保留键：`io.modelcontextprotocol/protocolVersion`、`/clientInfo`、`/clientCapabilities`、`/logLevel`、`/serverInfo`、`/subscriptionId` |
| `requestMeta(clientInfo, capabilities = {}, version?)` | 一个请求的 `_meta` |
| `Implementation`、`ClientCapabilities`、`ServerCapabilities`、`McpTool`、`McpToolAnnotations`、`CallToolResult`、`McpContent`、`McpResource`、`ResourceContents`、`McpPrompt`、`PromptArgument`、`PromptMessage`、`CacheHints` | 数据类型，字段名照 schema.ts |

### MCP 服务器（`mcp/server.ts`）

| 签名 | 说明 |
|---|---|
| `new McpServer(options: ServerOptions)` | `ServerOptions { info; ctx; tools?; resources?; prompts?; instructions?; versions?; cache?; pageSize?; elicit?; outputSchemas? }` |
| `outputSchemas: { 工具名: outputSchema }` | 可选（toolscall 课用）：tools/list 列出这个工具的 outputSchema，tools/call 成功时结果多带 `structuredContent`（= `ToolOutcome.data`），text 块仍是序列化的 JSON；工具出错时不带。默认没有，别的课的结果和字节不变 |
| `.handle(message \| text): JsonRpcResponse \| null` | 处理一条消息：缺 `_meta` 必填字段 -32602（data.missing）；版本不支持 -32022（data.supported / requested）；`initialize` 也回 -32022（本服务器不支持旧版）；`server/discover`、`tools/list`（可分页，cursor 坏了 -32602）、`tools/call`（找不到工具 -32602；工具失败 isError: true）、`resources/list`、`resources/read`（找不到 -32602，data.uri）、`prompts/list`、`prompts/get`（缺必填参数 -32602）；其余或没声明能力的方法 -32601。结果都带 resultType 和 `_meta` 里的 serverInfo，可缓存的带 ttlMs、cacheScope。通知返回 null（`notifications/cancelled` 记进 `.cancelled`） |
| `elicit: { 工具名: (args) => ElicitForm }` | 要用户确认的工具：客户端没声明 elicitation 回 -32021（data.requiredCapabilities）；声明了先回 `{ resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create', params } }, requestState }`，客户端带 `inputResponses.confirm`（action accept / decline / cancel）和 `requestState` 用新 id 重发才执行 |
| `.capabilities()`、`.tools()`、`.log`、`.cancelled` | 服务器能力（按有没有 tools / resources / prompts）；列出的 Tool（ToolSpec → inputSchema、annotations）；处理过的消息；被取消的 id |
| `CONFIRM_KEY`、`encodeState(value)`、`decodeState(text)`、`isLegacyVersion(v)` | 确认表单的键；requestState 的编码（本站：base64 的 JSON） |
| `ResourceSpec { resource; read() }`、`PromptSpec { prompt; render(args) }`、`ElicitForm` | 资源、提示模板、确认表单 |

### MCP 客户端（`mcp/client.ts`）

| 签名 | 说明 |
|---|---|
| `new McpClient(transport, { info, capabilities?, version?, firstId? })` | 客户端：id 从 1 起逐个加 1，每个请求的 `_meta` 带协议版本、clientInfo、客户端能力 |
| `.request(method, params?, id?): Exchange`、`.notify(method, params?)` | 发请求（按 id 找回响应，找不到抛错）；发通知。`Exchange { request; response; notifications }`，全部记在 `.exchanges` |
| `.discover()`、`.listTools(cursor?)`、`.callTool(name, args, extra?)`、`.listResources()`、`.readResource(uri)`、`.listPrompts()`、`.getPrompt(name, args?)`、`.cancel(requestId, reason?)` | 各方法的简写；`extra` 放 inputResponses、requestState |
| `Transport = (message) => JsonRpcMessage[]`、`directTransport(server)` | 传输：发一条消息，返回收到的消息；直接调用服务器 |
| `resultOf(exchange)` | 取 result，错误时抛出 |
| `toAnthropicTool(tool)`、`toToolOutcome(response)`、`mcpToolBox(client, tools)` | 接进循环：Tool → Messages API 的工具定义（inputSchema 改名 input_schema，title、annotations 不发给模型）；tools/call 的响应 → ToolOutcome（文本块连起来，isError → is_error，协议错误也作为 is_error 交回）；一个经 MCP 执行的 ToolBox |

### stdio（`mcp/stdio.ts`）

| 签名 | 说明 |
|---|---|
| `encodeLine(message \| text)`、`encodeLines(messages)` | 一条消息一行：紧凑 JSON + `\n`；传入的文字里有换行就抛错 |
| `lineSpans(bytes): LineSpan[]`、`LineSpan { from; to; text }` | 整段字节流每行的区间（含行尾 0A） |
| `new LineDecoder()`、`.push(bytes \| text): string[]`、`.buffered` | 增量切行，切口在汉字中间也行；还没凑满一行的字节数 |
| `stdioTransport(server): { send; record: { stdin; stdout } }` | 把服务器当作子进程：记下客户端写进 stdin、服务器写到 stdout 的全部字节 |

### Streamable HTTP（`mcp/http.ts`）

| 签名 | 说明 |
|---|---|
| `MCP_HOST`（`mcp.xiaopu.example`）、`MCP_PATH`（`/mcp`）、`MCP_ENDPOINT`、`ACCEPT`（`application/json, text/event-stream`） | 常量 |
| `mcpPost(message, { host?, path?, token? }): HttpRequest` | 客户端的 POST：头依次是 host、content-type、accept、mcp-protocol-version（取自 `_meta`）、mcp-method、mcp-name（tools/call、prompts/get 取 name，resources/read 取 uri）、authorization（Bearer），再补 content-length。头名小写 |
| `encodeHeaderValue(v)`、`decodeHeaderValue(v)`、`headerSafe(v)`、`nameSource(method)` | 不安全的值写成 `=?base64?…?=`（规范的五个例子都核对过）；Mcp-Name 取自哪个字段 |
| `checkHeaders(req, message): string \| null` | 服务器的头校验：缺 MCP-Protocol-Version / Mcp-Method / Mcp-Name，或和体不一致，返回原因 |
| `serveHttp(server, req, { token?, resourceMetadata?, scope?, sse?, notifications? }): HttpResponse` | 服务器处理一个请求：非 POST 405；要令牌时 401 + `www-authenticate`；JSON 坏了 400；通知 202 无体；头不一致 400 + -32020；交给 McpServer；状态码见 `statusOf`；`sse: true` 时回 `text/event-stream`（加 cache-control、x-accel-buffering: no），先是 `notifications`，最后是响应，每个事件一行 `data:` |
| `statusOf(error)` | 400：-32020 / -32021 / -32022 / -32700 / -32600 / 缺 `_meta` 的 -32602；404：-32601；其余 200（规范没规定，本站写法） |
| `readHttpResponse(res)`、`httpTransport(server, post?, serve?)`、`HttpExchange { request; response }` | 客户端读响应（202 → 空；JSON 一条；SSE 每个事件一条）；经 HTTP 的传输，记下每次的请求和响应 |

### 授权（`mcp/auth.ts`）

| 签名 | 说明 |
|---|---|
| `protectedResourceMetadata(resource, authorizationServers, { scopes?, name? })` | RFC 9728 的元数据文档：resource、authorization_servers（至少一个，否则抛错）、scopes_supported、bearer_methods_supported: ['header'] |
| `prmUrls(endpoint)`、`PRM_SUFFIX` | 没有 resource_metadata 时依次试的地址：插入端点路径的、根上的 |
| `asMetadataUrls(issuer)` | 授权服务器元数据的地址（MCP 规定的顺序：有路径三个，没路径两个） |
| `wwwAuthenticate({ resourceMetadata, scope?, error? })`、`parseWwwAuthenticate(value)` | 401 / 403 的 WWW-Authenticate；解析 |
| `authorizationUrl(params: AuthorizeParams)` | 授权请求：response_type=code、client_id、redirect_uri、scope、state、code_challenge（PKCE，值由调用方给）、code_challenge_method=S256、resource（RFC 8707） |

### 小铺的 MCP 服务器（`mcp/shop-server.ts`）

| 签名 | 说明 |
|---|---|
| `shopServer(ctx, options?)` | 四个工具、三个资源、一个提示模板、instructions，issue_refund 要确认；`options` 覆盖 ServerOptions（如 `pageSize`、`prompts: undefined`） |
| `SHOP_SERVER_INFO`（xiaopu-mcp 1.4.0）、`HOST_CLIENT_INFO`（xiaopu-agent 2.0.0）、`SHOP_INSTRUCTIONS` | 示例的 Implementation |
| `POLICY_RESOURCES` | `policy://aftersale`、`policy://refund`、`policy://shipping-fee`（text/plain，size 是 UTF-8 字节数） |
| `RETURN_PROMPT`、`refundConfirm(args)` | 提示 `return_request`（order_id 必填、problem 可选）；退款确认表单 |

## 写字节的层（`src/decode/structures.ts`）

每个函数返回一层 `LayerWriter`，`wire(at, view, fidelity, ...layers)` 拼成一个事件的解码结构。检查器开了 `segmentLayers`：每层的 hex 地址从 0 开始。

| 签名 | 说明 |
|---|---|
| `httpHead(name, layout, { mask?, notes?, example?, startNote? })`、`jsonBody(name, json, { root?, expand?, notes?, example?, shown? })`、`sseBody(name, stream, ...)` | 和 CONTEXT EXPLORER 相同。`mask: { 'x-api-key': 13 }` 只露前 13 个字符。jsonBody 的字段名从字节里的键读（MCP 的 `_meta` 键 `io.modelcontextprotocol/…` 本身带点，不能按路径切），键里没有点时和原来一样 |
| `stdioLines(name, bytes, lines, { shown?, notes? })` | stdio 的字节流：每行一个字段，行尾的 0A 是子字段 |
| `utf8Lines(name, text)`、`promptPieces(name, prompt)` | 按行的文本；展开后的提示按段（值是 token 数，internal） |
| `concept(name, fields)`、`num`（千分位）、`preview` | 概念层（无字节）、数值、截断预览 |

## 课程的小工具

`src/lessons/common.ts`：`cellsOf`、`PART_TONE`、`blocksOf(messages, prompt, extra?)`（消息历史拆成内容块，每块的 token 数取自那一轮请求的展开结果）、`historyRow(id, blocks, options)`（一排格子，key 是 `m<消息>b<块>`，帧之间保持身份）、`ledgerGrid(id, turns, { total? })`（每轮输入、输出 token 的小表）、`fixedTokens(turn)`（每轮重复的 system + 工具定义 + 工具系统提示）、`toolNames(run)`、`pct`。

`src/lessons/scenario.ts`：`MODEL`、`SYSTEM`、`USER_ASK`、`SUPPORT`（客服 Agent：三个工具）、`POLICY_QUERY`、`REACT_SCRIPT`、`dateText(iso)`（「11 月 3 日」）。别的课可以直接用 `SUPPORT` 和 `USER_ASK`，脚本照 `REACT_SCRIPT` 写。

## 增加一节课

1. 新建 `src/lessons/<id>.ts`，导出 `Lesson`，`id` 和 `group` 必须和 `index.ts` 的 `PLANNED` 一致。计算从 `../core` 取：先 `runAgent`（或建 `McpClient` / `shopServer`）真实跑一遍，事件里的数一律取自结果。事件用 `dsl.ts` 的 `pk`、`note`、`state`、`show`；每个事件带上此刻的图元（`ds`）和字节结构（`wire`）。`pk` 的轨迹行是 `[累计输入 token, 类型, 说明, 字节数]`：发请求的事件用 `turn.before.input`，响应和之后的事件用 `turn.after.input`。参考 `react.ts` 的 `roundTrip`。
2. 在 `index.ts` 里 import 它，加进 `LESSONS`，顺序和 `PLANNED` 一致（`tests/lessons.test.ts` 核对 13 课全部实现、顺序和分组）。
3. 在 narrative 测试（loop 组 `tests/narrative.test.ts`，mcp 组新建 `narrative.mcp.test.ts`，multi 组新建 `narrative.multi.test.ts`）里加这节课的文案核对：关键的数写死，文字里的说法逐条核对。`tests/lessons.test.ts` 会自动检查步骤数（4–6）、detail 句数（2–4，按 。！？ 数；引用模型的话时去掉末尾的句号，见 `react.ts` 的 `quote`）、节点显示顺序、输入列单调、字段范围、通道和数据结构是否重叠。
4. e2e 和首页的课数都从 `LESSONS` 取，不用改。
5. 文案里用了新的符号（不是中文），先用 `glyphs.py` 一类的脚本确认 Iosevka 22.1.2 里有（没有 ⏎ 和 ⚠，换行用 ↵），再重新运行字体裁剪脚本。
6. **截图看布局**：单元测试只查设备和数据结构的外接框，查不出文字互相压住。用浅色、深色，1440 宽和 380 宽各看一遍（380 宽时节点名称会按比例放大，最容易压住）。react 课的经验：消息历史会长到十来格，`w` 取 46 左右、放在画面最下面；账的小表放在左下，名称放到表下方；两个设备的状态面板挨得近时会在 380 宽压在一起（react 课因此去掉了订单库的面板）；布局的宽高比在 1.2–1.5 之间。

## 核对过的事实（2026-11-06）

### MCP

| 事实 | 来源 |
|---|---|
| 最新正式版是 **2026-07-28**（还有 draft）；之前的版本 2025-11-25、2025-06-18、2025-03-26、2024-11-05；schema.ts 里 `LATEST_PROTOCOL_VERSION = "2026-07-28"` | <https://modelcontextprotocol.io/specification>、<https://modelcontextprotocol.io/llms.txt>、<https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts> |
| 2026-07-28 去掉了 `initialize` / `notifications/initialized` 握手：每个请求在 `_meta` 里带 `io.modelcontextprotocol/protocolVersion`（必填）、`io.modelcontextprotocol/clientCapabilities`（必填）、`io.modelcontextprotocol/clientInfo`（建议）；结果的 `_meta` 建议带 `io.modelcontextprotocol/serverInfo`；缺必填字段回 -32602（HTTP 400） | <https://modelcontextprotocol.io/specification/2026-07-28/changelog>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/index>（`_meta` 一节） |
| 版本不支持回 `UnsupportedProtocolVersionError`：code -32022，message `Unsupported protocol version`，data `{ supported, requested }`；没有协商握手，客户端从 supported 里选一个重发 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning> |
| 服务器**必须**实现 `server/discover`（客户端可以不调）；结果 `supportedVersions`、`capabilities`、可选 `instructions`，带 `ttlMs`、`cacheScope` | <https://modelcontextprotocol.io/specification/2026-07-28/server/discover> |
| 所有结果必须带 `resultType`：`complete` 或 `input_required`（多轮请求 MRTR）；旧服务器不带时当作 `complete` | <https://modelcontextprotocol.io/specification/2026-07-28/basic/index> |
| 错误码：JSON-RPC 的 -32700、-32600 ~ -32603；MCP 的 -32020 HeaderMismatch、-32021 MissingRequiredClientCapability（data.requiredCapabilities）、-32022 UnsupportedProtocolVersion；-32000 ~ -32019 是遗留的实现自定义段，-32020 ~ -32099 归规范；旧的 -32002（资源不存在）改成 -32602 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/index>（Error Codes）；schema.ts |
| 请求的 id 是字符串或整数，**不能是 null**；错误响应读不出 id 时可以不带 id；通知没有 id、不回复 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/index>（Messages） |
| 协议是无状态的：服务器不能靠同一连接上之前的请求建立上下文；跨请求的状态用显式的 id（比如工具参数里的句柄）传 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/index>（Statelessness）、<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>（Stateful Tools） |
| `tools/list`：Tool 有 name、title、description、inputSchema（根必须 `type: "object"`）、outputSchema、annotations；结果带 `ttlMs`、`cacheScope`，`nextCursor` 分页；工具顺序应当确定（利于缓存）；工具名建议 1–128 个字符、只用字母数字 `_ - .` | <https://modelcontextprotocol.io/specification/2026-07-28/server/tools> |
| `tools/call`：params `name`、`arguments`；结果 `content`（text、image、audio、resource_link、resource）、`structuredContent`、`isError`；找不到工具、请求不合格是协议错误（例子是 -32602 `Unknown tool: …`），API 失败、参数校验失败、业务规则是工具错误（`isError: true`，模型能据此改正） | 同上（Error Handling）；schema.ts 的 `CallToolResult` |
| ToolAnnotations：`readOnlyHint`（默认 false）、`destructiveHint`（默认 true）、`idempotentHint`（默认 false）、`openWorldHint`（默认 true），都只是提示，不可信的服务器给的不能当真 | schema.ts 的 `ToolAnnotations` |
| 规范建议：调用工具时应当有人在回路里、能拒绝调用；敏感操作要用户确认 | <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>（User Interaction Model、Security Considerations） |
| `resources/list`、`resources/read`（结果 `contents[{ uri, mimeType?, text \| blob }]`，可缓存）、`resources/templates/list`；不存在的资源回 -32602，例子的 data 是 `{ uri }`，不能回空的 contents | <https://modelcontextprotocol.io/specification/2026-07-28/server/resources> |
| `prompts/list`、`prompts/get`（params `name`、`arguments`，结果 `description`、`messages[{ role, content }]`）；名字不对、缺必填参数回 -32602 | <https://modelcontextprotocol.io/specification/2026-07-28/server/prompts> |
| 能力：服务器 `tools: { listChanged }`、`resources: { subscribe, listChanged }`、`prompts: { listChanged }`、`completions`、`logging`（已弃用）、`extensions`；客户端 `elicitation: { form, url }`、`sampling`、`roots`（后两个已弃用）、`extensions`；没声明能力的方法回 -32601 | schema.ts 的 `ClientCapabilities`、`ServerCapabilities`、`MethodNotFoundError` |
| 多轮请求（MRTR）取代服务器主动发的请求：服务器回 `InputRequiredResult`（`resultType: "input_required"`、`inputRequests`、可选 `requestState`），客户端带 `inputResponses` 和 `requestState` 重发原请求，**id 必须不同**；elicitation 的结果 `action` 是 accept / decline / cancel | <https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr>、<https://modelcontextprotocol.io/specification/2026-07-28/server/tools>（Input Required Tool Results）；schema.ts 的 `ElicitResult` |
| 去掉了 `ping`、`logging/setLevel`、`notifications/roots/list_changed`、`resources/subscribe`（改成 `subscriptions/listen`）；Roots、Sampling、Logging 标为已弃用 | <https://modelcontextprotocol.io/specification/2026-07-28/changelog> |
| stdio：客户端把服务器作为子进程启动；每条消息一行，换行分隔，**消息里不能有内嵌换行**；stdout 上只能有 MCP 消息，日志写 stderr；服务器不在 stdout 上发请求；取消发 `notifications/cancelled`；关 stdin 是优雅退出的信号 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio> |
| Streamable HTTP：一个只接受 POST 的 MCP 端点；每条消息一个 POST；`Accept` 必须同时列 `application/json` 和 `text/event-stream`；请求回 `application/json` 或 `text/event-stream`（这个请求自己的流，先是相关通知，最后是响应）；通知回 202 无体；SSE 流建议带 `X-Accel-Buffering: no` | <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http> |
| 每个 POST 必须带 `MCP-Protocol-Version`（等于 `_meta` 里的版本）、`Mcp-Method`，tools/call、prompts/get 带 `Mcp-Name`（params.name），resources/read 带 `Mcp-Name`（params.uri）；缺头或和体不一致回 400 + -32020；不安全的值写成 `=?base64?{UTF-8 的 Base64}?=`（例：`Hello, 世界` → `=?base64?SGVsbG8sIOS4lueVjA==?=`）；版本不支持 400 + -32022；方法没实现 404 + -32601 | 同上（Request Metadata、Value Encoding、Server Validation） |
| 2026-07-28 的 Streamable HTTP 没有会话（不再有 `Mcp-Session-Id`）、没有 GET 端点（GET / DELETE 应回 405）、不能续传（不再有 `Last-Event-ID`）；这些是 2025-03-26 到 2025-11-25 的写法 | 同上（Backward Compatibility）；changelog |
| 授权（只对 HTTP 传输；stdio 从环境变量取凭据）：MCP 服务器是 OAuth 2.1 资源服务器，必须实现 Protected Resource Metadata（RFC 9728），文档里 `authorization_servers` 至少一个；401 的 `WWW-Authenticate: Bearer resource_metadata="…"`，可带 `scope`；没有时先试 `/.well-known/oauth-protected-resource/<路径>` 再试根上的；授权服务器元数据按 RFC 8414 和 OIDC Discovery 依次试（有路径三个地址）；授权和令牌请求都要带 `resource`（RFC 8707），PKCE；令牌放在 `Authorization: Bearer`，不能放查询串；令牌无效 401，权限不够 403 + `error="insufficient_scope"`；动态客户端注册（RFC 7591）已弃用，优先 Client ID Metadata Documents | <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery> |
| RFC 9728：元数据只有 `resource` 必填，`scopes_supported`、`resource_name` 建议，`authorization_servers`、`bearer_methods_supported` 等可选；后缀 `oauth-protected-resource` 插在主机和路径之间；WWW-Authenticate 的参数名 `resource_metadata` | <https://datatracker.ietf.org/doc/html/rfc9728> |
| （MCP 组课程补充，下同）无状态的原文：「all the information needed to process a request is contained in the request itself」；服务器不能靠同一连接上之前的请求建立上下文（能力、版本、身份），**不应**要求客户端复用同一条连接或同一个进程；stdio 上服务器意外退出时，「Because the protocol is stateless」，客户端重启它、重发没回来的请求。规范没有写「水平扩展」一类的理由，课程只引用这几句 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/index>（Statelessness）、<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>（Unexpected Termination） |
| 旧版（规范称 legacy，2025-11-25 及以前）的握手：连接上的第一件事是 `initialize`（params `protocolVersion`、`capabilities`、`clientInfo`），服务器回自己的 `protocolVersion`、`capabilities`、`serverInfo`、`instructions`，客户端再发 `notifications/initialized`；能力在整个会话里有效。HTTP 上服务器可以在 InitializeResult 的响应头里发 `Mcp-Session-Id`，之后每个请求都带，会话结束后回 404、客户端重新 initialize，DELETE 结束会话；GET 打开收服务器消息的 SSE 流，`Last-Event-ID` 续传 | <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>、<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>（Session Management） |
| 只支持新版的服务器收到 `initialize` **应当**在错误里写出支持的版本（旧客户端没有升级的办法）；`server/discover` 可选，用来先选版本、一次拿到能力，以及 stdio 上探测对方是新版还是旧版 | <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>、<https://modelcontextprotocol.io/specification/2026-07-28/server/discover> |
| 缓存：必须带 ttlMs / cacheScope 的只有 `server/discover`、`tools/list`、`prompts/list`、`resources/list`、`resources/templates/list`、`resources/read`（`tools/call`、`prompts/get` 不在内）；ttlMs 是新鲜度提示（类似 max-age）；`public` 表示没有用户私有数据，共享的网关、代理也可以缓存，`private` 不能跨授权上下文共享 | <https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching> |
| `outputSchema`：有它时服务器**必须**给符合它的 `structuredContent`，客户端**应当**校验；返回 structuredContent 的工具**应当**同时在 TextContent 里放序列化的 JSON。协议错误（找不到工具、请求不合格、服务器错误）模型不太能改正，客户端**可以**交给模型；工具错误（API 失败、参数校验失败、业务规则）**应当**交给模型 | <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>（Structured Content、Output Schema、Error Handling） |
| 谁来决定用：工具 **model-controlled**（模型根据上下文自己发现、调用），资源 **application-driven**（宿主决定怎样放进上下文：界面上挑、搜索过滤、按启发式或模型的选择自动带上），提示 **user-controlled**（用户明确选用，比如斜杠命令；指谁决定何时用，内容由服务器定）；三处都说协议不规定交互界面 | 同上（User Interaction Model）、<https://modelcontextprotocol.io/specification/2026-07-28/server/resources>、<https://modelcontextprotocol.io/specification/2026-07-28/server/prompts> |
| resources/read 的 contents 可以有多项（比如读目录）；文本用 `text`，二进制用 `blob`（base64）；客户端**应当**仍接受旧的 -32002；prompts/get 的结果 `description`、`messages[{ role, content }]`，prompts/list 可缓存 | <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>、<https://modelcontextprotocol.io/specification/2026-07-28/server/prompts> |
| stdio：stderr 上的输出客户端**不应**当作出错；关闭：关 stdin → 等退出 → 强制结束（POSIX 一般 SIGTERM 再 SIGKILL，Windows 用 TerminateProcess 或 Job Object），关 stdin 是主要、也是唯一可移植的优雅退出信号。取消：取消可能在请求做完之后才到，服务器可以忽略，客户端**应当**忽略随后到达的响应；HTTP 上关掉 SSE 响应流就是取消，不发 `notifications/cancelled` | <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation> |
| Streamable HTTP 镜像头的理由：「so that intermediaries (load balancers, gateways, observability tooling) can route and inspect requests without parsing the body」；头和体必须一致，防止「a load balancer routing on the header value while the MCP server executes based on the body value」。进度：请求的 `_meta.progressToken` 表示要进度，`notifications/progress` 带 progressToken、progress（必须递增）、total、message | <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>（Request Metadata、Server Validation）、<https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress> |
| 授权流程补充：client_id 可以是 Client ID Metadata Document 的 HTTPS URL；授权响应**应当**带 `iss`（RFC 9207），客户端核对后才能拿 code 换令牌；授权服务器元数据里的 `issuer` 必须和拼地址用的 issuer 一样。RFC 8414：`issuer`、`response_types_supported` 必填，`authorization_endpoint`、`token_endpoint` 一般必填，`code_challenge_methods_supported` 省略表示不支持 PKCE。RFC 7636：S256 是 `BASE64URL(SHA256(code_verifier))`，附录 B 的例子 `dBjftJeZ…` → `E9Melhoa…`（http 课用这对值，测试用 node:crypto 核对） | <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>、<https://datatracker.ietf.org/doc/html/rfc8414>、<https://datatracker.ietf.org/doc/html/rfc7636> |

### Messages API 和工具调用

| 事实 | 来源 |
|---|---|
| 请求、响应的字段，`anthropic-version: 2026-10-21`、`x-api-key`、`request-id`，stop_reason 的六个取值（end_turn、max_tokens、stop_sequence、tool_use、pause_turn、refusal），价格（Opus 5.5 输入 $4、输出 $20 / MTok）、模型 id `claude-opus-5-5` | 照抄 CONTEXT EXPLORER 的事实表（`modules/context/README.md`）；claude-api skill |
| tool_use 块 `{ type, id, name, input }`；tool_result 块 `{ type, tool_use_id, content?, is_error? }`，content 是字符串或 text / image / document / search_result 块的数组 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls> |
| tool_result 必须紧跟在对应的 tool_use 之后（中间不能夹别的消息）；含 tool_result 的 user 消息里 **tool_result 要排在最前面**，文字在后（反过来 400） | 同上（Important formatting requirements） |
| 并行工具调用默认开：一轮可以有多个 tool_use；全部 tool_result 放在**同一条** user 消息里（拆成几条会让模型以后少做并行调用）；API 不规定执行顺序，结果按 tool_use_id 对应；`disable_parallel_tool_use: true` 写在 tool_choice 里，auto 时最多一个、any / tool 时恰好一个 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use> |
| 工具执行失败时回 `is_error: true` 的 tool_result，模型会看到并调整；参数不全时模型通常会改正重试 2–3 次 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>（Handling errors with is_error） |
| tool_choice 四种：auto（有工具时默认）、any、tool、none（没工具时默认）；**Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1 不支持 any 和 tool**（400） | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>（Forcing tool use） |
| 带 tools 时 API 构造一段工具使用的系统提示，计入输入；Opus 5.5 是 286 token（auto / none） | 同上（Tool use system prompt）；token 数照抄 CONTEXT EXPLORER 的事实表 |
| 工具名要匹配 `^[a-zA-Z0-9_-]{1,128}$` | 同上（Specifying client tools） |
| 工具结果常带着外部来源的内容，要当作不可信（间接提示注入），放在 tool_result 里，不要放进 system | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls>（Warning） |
| Claude Opus 5.5 上，工具调用之间超过一两句的说明会作为进度更新的 `thinking` 块返回（默认 display 为 omitted，文字为空）；短的一句话仍可能是 text | claude-api skill（`shared/model-migration.md` 的 Migrating to Claude Opus 5.5） |
| MCP connector：Messages API 的 `mcp_servers: [{ type: "url", url, name }]` 要配上 `tools: [{ type: "mcp_toolset", mcp_server_name }]` 和 beta `mcp-client-2025-11-20` | claude-api skill |
| ReAct：Yao、Zhao、Yu、Du、Shafran、Narasimhan、Cao，ReAct: Synergizing Reasoning and Acting in Language Models，arXiv 2210.03629，ICLR 2023（oral） | <https://arxiv.org/abs/2210.03629>、<https://iclr.cc/virtual/2023/oral/12647> |
| 工具描述：「by far the most important factor in tool performance」，要写清做什么、什么时候用（和不用）、每个参数的意思、限制，「at least 3–4 sentences」；description 的定义是「what the tool does, when it should be used, and how it behaves」；坏例子是一句话、参数没有说明（tooldefs 课） | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools>（Best practices for tool definitions） |
| tool_choice：auto「the default value when tools are provided」，any 必须用某个工具，tool 指定一个，none「prevents Claude from using any tools」、没有 tools 时的默认；Opus 5.5 等不支持 any / tool 时，文档建议 auto 加上提示里点名工具、`strict: true` 保证参数合 schema，或改用结构化输出 | 同上（Forcing tool use）；claude-api skill（`shared/tool-use-concepts.md` 的 Tool Choice Options） |
| stop_reason 的含义：end_turn 自然说完；max_tokens 写到上限；stop_sequence 碰到自定义停止串；tool_use 要调用工具；pause_turn 服务器端工具的循环到了迭代上限（默认 10）；refusal 拒绝（HTTP 200）；另有 `model_context_window_exceeded`（写满上下文窗口）。max_tokens 截断时回复里可能有不完整的 tool_use 块，要加大 max_tokens 重试；refusal 时不要执行这一轮的工具 | <https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons>；claude-api skill（`shared/tool-use-concepts.md`） |

### 谁来跑循环（sdks 课用）

| 事实 | 来源 |
|---|---|
| Anthropic SDK 的 tool runner（beta）：Python `client.beta.messages.tool_runner(...)` + `@beta_tool`（异步 `@beta_async_tool`），`runner.until_done()`；TypeScript `client.beta.messages.toolRunner({...})` + `betaZodTool()` / `betaTool()`，`await runner`；可选 `max_iterations` | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner>；claude-api skill |
| Claude Agent SDK：Python 包 `claude-agent-sdk`（import `claude_agent_sdk`），TS 包 `@anthropic-ai/claude-agent-sdk`；`query(prompt=..., options=...)`、`ClaudeSDKClient`；`ClaudeAgentOptions`（TS 类型 `Options`）的 `max_turns` / `maxTurns`（默认不限）、`max_budget_usd`、`allowed_tools`、`disallowed_tools`、`permission_mode`、`can_use_tool` / `canUseTool`（返回 `PermissionResultAllow` / `PermissionResultDeny`）；自定义工具 `@tool` + `create_sdk_mcp_server`（工具名 `mcp__<server>__<tool>`）；子 Agent `agents: dict[str, AgentDefinition]`（`description`、`prompt` 必填，只把最后一条消息交回），经 `Agent` 工具调用（旧名 `Task`）；hooks `PreToolUse`、`PostToolUse` 等；消息 `SystemMessage`、`AssistantMessage`、`UserMessage`、`ResultMessage`（subtype `success`、`error_max_turns`、`error_max_budget_usd`…，带 `num_turns`、`total_cost_usd`）。文档已从 platform.claude.com 移到 code.claude.com | <https://code.claude.com/docs/en/agent-sdk/overview>、<https://code.claude.com/docs/en/agent-sdk/python>、<https://code.claude.com/docs/en/agent-sdk/typescript>、<https://code.claude.com/docs/en/agent-sdk/agent-loop>、<https://code.claude.com/docs/en/agent-sdk/hooks> |
| OpenAI Agents SDK（`pip install openai-agents`，`from agents import Agent, Runner`）：`Agent(name, instructions, tools, handoffs, model, ...)`；`Runner.run` / `run_sync` / `run_streamed`；`max_turns` 默认 `DEFAULT_MAX_TURNS = 10`，超了抛 `MaxTurnsExceeded`；`@function_tool`（别名 `@tool`）；`handoff(agent, ...)`，模型看到的是名为 `transfer_to_<agent_name>` 的工具，接手的 Agent 默认看到完整历史；`agent.as_tool(...)` 是「管理者保留控制」的写法；`result.final_output`、`result.last_agent`；`needs_approval=True` 让运行停在 `result.interruptions`，`state.approve(...)` / `reject(...)` 后继续；guardrail `@input_guardrail`、`@output_guardrail` 等 | <https://openai.github.io/openai-agents-python/agents/>、<https://openai.github.io/openai-agents-python/running_agents/>、<https://openai.github.io/openai-agents-python/handoffs/>、<https://openai.github.io/openai-agents-python/human_in_the_loop/>、<https://openai.github.io/openai-agents-python/guardrails/>；源码 `src/agents/run_config.py` |
| LangChain v1：`from langchain.agents import create_agent`（「a model calling tools in a loop until a given task is complete」），参数 `model`、`tools`、`system_prompt`、`middleware` 等，返回 `CompiledStateGraph`；LangGraph v1 弃用了 `langgraph.prebuilt.create_react_agent`；`from langchain.tools import tool`；`recursion_limit` 是配置的顶层键，超了抛 `GraphRecursionError`，Python 默认 10,007（v1.1.4 起），`create_agent` 自己设 9,999；人工确认 `HumanInTheLoopMiddleware(interrupt_on=...)`，决定 approve / edit / reject / respond，要 checkpointer；`interrupt()` + `Command(resume=...)` | <https://docs.langchain.com/oss/python/langchain/agents>、<https://docs.langchain.com/oss/python/migrate/langgraph-v1>、<https://docs.langchain.com/oss/python/langgraph/graph-api>、<https://docs.langchain.com/oss/python/langchain/human-in-the-loop>、<https://docs.langchain.com/oss/python/langgraph/interrupts>；源码 `langchain_v1/langchain/agents/factory.py` |

### 多 Agent 和权限（multi 组用）

| 事实 | 来源 |
|---|---|
| Claude Agent SDK 的子 Agent：每个子 Agent 在自己的对话里跑，默认从空白开始（fork 除外）；父 Agent 传给它的只有 Agent 工具的 prompt 字符串，它看不到父 Agent 的历史、工具结果和 system；中间的工具调用和结果留在子 Agent 里，只有最后一条消息交回父 Agent；多个子 Agent 可以并发；每个子 Agent 的 API 请求都计入 `total_cost_usd`，子 Agent 还能再派子 Agent（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 默认 3 层） | <https://code.claude.com/docs/en/agent-sdk/subagents> |
| 多 Agent 系统的 token 用量约是普通对话的 15 倍 | 照抄 CONTEXT EXPLORER 的事实表（Anthropic Engineering，How we built our multi-agent research system） |
| OpenAI Agents SDK 的 handoff：默认工具名由 `Handoff.default_tool_name()` 生成，是 `transfer_to_<agent_name>`（`Refund Agent` → `transfer_to_refund_agent`），可用 `tool_name_override`、`tool_description_override` 改；`on_handoff` 回调、`input_type`（转交工具的参数 schema）；接手的 Agent 默认看到之前的完整对话历史；`input_filter` 收一个 `HandoffInputData`（`input_history`、`pre_handoff_items`、`new_items` 等）、返回新的 `HandoffInputData`，`agents.extensions.handoff_filters.remove_all_tools` 去掉历史里工具相关的项；`nest_handoff_history`（把历史压成摘要）是默认关闭的 beta | <https://openai.github.io/openai-agents-python/handoffs/> |
| OpenAI Agents SDK 的循环：「If the LLM requests a handoff, we update the current agent and input, and re-run the loop」；`result.last_agent` 是最后运行的 Agent，「often the best agent to reuse for the next user turn after handoffs」；管理者模式（`Agent.as_tool()`）由管理者保留对话控制、负责最终回答，handoff 让专员成为当前 Agent、直接回答用户 | <https://openai.github.io/openai-agents-python/running_agents/>、<https://openai.github.io/openai-agents-python/results/>、<https://openai.github.io/openai-agents-python/multi_agent/> |
| Claude Agent SDK 的权限：工具调用依次经过 hooks、deny 规则、ask 规则、权限模式、allow 规则，都没定下来才调用 `canUseTool`；deny 规则在 `bypassPermissions` 下也生效；`disallowed_tools=["Bash"]` 把工具定义从请求里去掉，模型看不到也调不了；权限模式 `default`、`dontAsk`（该问的一律拒绝）、`acceptEdits`、`bypassPermissions`、`plan`、`auto` | <https://code.claude.com/docs/en/agent-sdk/permissions> |

multi 组没有核对、按本站写法对待的：approval 课的三条规则（不在白名单拒绝、readOnlyHint 放行、其余要确认）是本站的示例策略，不是哪个 SDK 的默认行为；handoff 课「去掉工具项」的对照是本站按 remove_all_tools 的意思在 Messages API 的消息上做的（剩下的两段想法并成一条助手消息），不是 SDK 的输出；订单评价、注入文本、后台工具 `update_refund_account` 都是示例。
| 各家的「一轮」：Claude Agent SDK 的 turn 是「one pass through the loop」（一次模型输出，有工具调用就执行），`max_turns` 要算上最后只写文字的一轮，不够就是 `error_max_turns` 且没有最终回答（`result` 字段只在 success 上）；OpenAI Agents SDK 的 `max_turns` 限的是「agent-loop turns (LLM calls)」；LangGraph 的 `recursion_limit`「caps how many super-steps one run may execute」，同一步里并行的节点共用一个 super-step（sdks 课） | <https://code.claude.com/docs/en/agent-sdk/agent-loop>（Turns and messages、Handle the result）；<https://openai.github.io/openai-agents-python/running_agents/>；<https://docs.langchain.com/oss/python/langgraph/graph-api> |
| Claude Agent SDK 自定义工具：`@tool(name, description, schema)` 的处理函数返回 `{"content": [...]}`（可带 `is_error`），`create_sdk_mcp_server(name=..., version=..., tools=[...])`，经 `ClaudeAgentOptions(mcp_servers={...}, allowed_tools=["mcp__<server>__<tool>"])` 传入；自定义工具默认串行执行，标 `readOnlyHint` 才能并行；tool search 默认开，SDK MCP 工具的 schema 按需加载 | <https://code.claude.com/docs/en/agent-sdk/custom-tools>、<https://code.claude.com/docs/en/agent-sdk/agent-loop>（Parallel tool execution） |
| LangChain `create_agent` 的调用：`agent.invoke({"messages": [{"role": "user", "content": ...}]})`；model 可以写成 `"anthropic:<模型 id>"` | <https://docs.langchain.com/oss/python/langchain/agents> |

没有核对、以示例或本站写法对待的：Streamable HTTP 的 SSE 事件要不要写 `event:` 行（规范没有给 SSE 的逐字节例子，本站只写 `data:` 行，按 SSE 规范事件类型默认是 message）；JSON-RPC 错误除了规范列出的几种以外回什么 HTTP 状态码（本站回 200）；`initialize` 打到只支持新版的服务器上用什么错误码（规范说由实现决定，本站用 -32022）；requestState、cursor 的写法（规范要求客户端当作不透明串，本站写成 base64）；PKCE 的 code_challenge（要 SHA-256，本站不算，写成示例值）；LangGraph JS 的 recursion_limit 默认值、`create_react_agent` 在 2.0 删除（没在官方页面上看到原文）；小铺的订单、规则、退货单号格式、服务器名和版本（示例数据）。

## 共享包

需要 Messages API、token 计数、ChatML 模板、计费、SSE、JSON、HTTP、BM25、示例 id 时，一律从 `packages/llm-core`（`@explorer/llm-core`）导入，不在本模块复制。为此把 CONTEXT EXPLORER 的七个文件原样搬进了共享包，context 的 `src/core/` 里同名文件改成一行转导出，接口、课程内容和数字不变（context 的单元测试和 e2e 都通过）：

- `sse.ts`：SSE 的编码和增量解析；
- `tokens.ts`：迷你 BPE 加 ChatML 两个特殊 token 的计数；
- `template.ts`：ChatML 展开（`renderRequest`、`inputBreakdown` 用它数每部分的 token）；
- `anthropic.ts`：Messages API 的类型、`MODELS`（含工具系统提示的 token 数）、`createMessage`、`inputBreakdown`、`messagesHttpRequest` / `messagesHttpResponse`、流式事件；
- `cache.ts`：提示缓存（`anthropic.ts` 依赖它）；
- `pricing.ts`：示例单价和 `costOf`；
- `ids.ts`：示例 id 和 `httpDate`。

后来 LLMOPS EXPLORER 又把本模块的 `schema.ts`（JSON Schema 子集校验）和 `shop.ts`（小铺的场景数据）原样搬进共享包，四个工具给模型看的定义（name、title、description、input_schema、hints）也搬进共享包 `shop.ts` 的 `SHOP_TOOL_DEFS`；这里的 `schema.ts`、`shop.ts` 改成一行转导出，`tools.ts` 里每个工具用 `...SHOP_TOOL_DEFS.<名字>` 加上自己的 `run`，字段顺序不变，课程的字节和数字不变（单元测试和 e2e 都通过）。

共享包的 `http.ts` 的原因短语表 `REASONS` 补了 202 Accepted、405 Method Not Allowed（http 课的 GET 和通知要用，RFC 9110 的短语；以前这两个状态码的起始行没有短语）。

`scene/ds.ts`、`scene/plugin.ts` 和 llm、context、rag 的同名文件逐字相同，`decode/structures.ts` 里的 `httpHead`、`jsonBody`、`sseBody`、`utf8Lines`、`promptPieces`、`concept` 和 CONTEXT EXPLORER 的写法相同：这是系列的约定（每个模块的场景和写字节层各一份），没有抽成共享包。

## 已知的简化和待办

- 模型每一轮写什么是脚本（示例）；真实的模型可能换一种说法、多查一次或少查一次。
- Claude Opus 5.5 默认开着自适应思考，真实响应里还会有 `thinking` 块（默认显示为空），工具调用之间较长的说明也会放进 thinking 块；本站不模拟 thinking 块，「想法」一律写成 text 块（ReAct 的经典写法）。
- token 数只代表量级关系（见「本站约定」）；工具系统提示用文档给的 286，和本站分词器数出来的部分不是同一把尺子。
- 循环是同步的：并行调用按 tool_use 的顺序逐个执行（结果和并发执行一样，因为工具之间不共享会冲突的状态）；没有超时、取消和重试退避。
- MCP 服务器只实现 2026-07-28 版（不是 dual-era）：不支持旧版的 initialize 握手和会话；没有实现 `subscriptions/listen`、`completion/complete`、`resources/templates/list`、日志和进度通知的产生（`serveHttp` 可以由课程传入要排在响应前的通知）、tasks 扩展；JSON Schema 校验只是一个子集。
- 授权只实现到能核对的部分（元数据文档、地址顺序、WWW-Authenticate、授权请求的参数），没有真正的授权服务器、令牌签发和 PKCE 的 SHA-256。
- HTTP 统一按 HTTP/1.1 展示，头名小写。
