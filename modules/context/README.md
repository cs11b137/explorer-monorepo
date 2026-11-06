# Context Explorer

用交互动画讲一次大模型 API 调用里到底带了什么：HTTP 报文、JSON 字段、SSE 流式事件、chat template、工具调用、Prompt Caching、上下文预算。请求和响应逐字节解码，token 数、费用、缓存命中全部由 `src/core/` 真实计算；模型「说出来的话」无法真实生成（本站不跑大模型），作为示例写死并标 E.G.，但围绕它的字节、token 数、计费、截断都真实计算。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。和 LLM EXPLORER 是同一系列、同一套约定。

## 开发

本模块由主站统一提供服务，地址是 `/modules/context/`。启动和构建在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test                 # 本模块的单元测试
python scripts/subset-fonts.py <woff2 目录>  # 按本站字符重新裁剪 Iosevka（需要 fonttools、brotli），字体源见脚本开头
```

端到端测试在仓库根目录：`npx playwright test --project=context`。

## 结构

- `src/core/`：计算核心，纯 TypeScript，确定性（示例 id 来自固定种子）。接口见下文。
- `src/lessons/`：每节课一个文件。`index.ts` 的 `PLANNED` 是 14 节课的顺序和分组；`types.ts` 是节点、事件和图元的类型；`dsl.ts` 是写事件的简写；`common.ts` 是画格子、按来源分段的小工具。
- `src/decode/`：可信度（`writer.ts`）和按真实格式写字节的层（`structures.ts`）。
- `src/scene/`：`devices.ts` 是设备节点的图形，`ds.ts`、`plugin.ts` 和 llm 相同（数据结构图元的几何和帧间动画，含 `heat` 热力图）。
- `tests/`：`core.test.ts` 核对计算核心（期望值手写自规范）；`decode.test.ts` 核对写字节的层；`lessons.test.ts` 检查每节课的结构和布局；`narrative.test.ts` 核对 messages 课的文案和计算结果，`narrative.api.test.ts` 核对 sse、dialects、retry 三课，`core.api.test.ts` 核对 retry.ts 和 openai.ts 里 Responses 流、OpenAI / OpenRouter 错误；`narrative.context.test.ts` 核对上下文工程组五课，`core.context.test.ts` 核对 recall.ts 和 context.ts；`player.test.ts` 检查播放器。
- `e2e/app.spec.ts`：端到端测试，课程清单取自源码。
- 分词器不在本模块：用的是共享包 `packages/llm-core`（`@explorer/llm-core`）里 LLM EXPLORER 的那个字节级 BPE，见下文「为什么复用 llm 的分词器」。JSON、HTTP/1.1 和 BM25 的实现也在共享包里（和 RAG EXPLORER 共用），`core/` 里同名文件转导出。AGENT EXPLORER 新建时又把 `sse.ts`、`tokens.ts`、`template.ts`、`anthropic.ts`、`cache.ts`、`pricing.ts`、`ids.ts` 原样搬进了共享包（Agent 循环要用 Messages API 的请求和响应、token 计数和计费），这里的同名文件只剩一行转导出，接口、课程内容和数字都没变（本模块的单元测试和 e2e 都通过）。

## 本站约定

**抽象层级（顶栏 7 档）**：网络、HTTP、JSON、消息、提示、上下文、应用。一次调用从最底下的网络字节，到应用怎样组织上下文，依次经过它们。这是本站的教学约定，不是业界标准分层。每节课用 `layer: [lo, hi]` 标出跨了哪几档，`layerNote` 写一句为什么。

**token 列（轨迹表第二列，`Row.tokens`）**：到这个事件为止，这一课里模型累计处理的 token 数——读入的输入（含缓存读写）加上写出的输出。模型还没读到请求之前是 0。必须单调不减（测试检查），不能手写，从 `core/` 的计算结果取。每节课用 `tokensNote` 写一句这课具体累计了什么（以句号结尾），会拼进表头提示。字节数放在最后一列「大小」（`Row.size`）。
选它而不选「累计字节数」，是因为 14 节课里有一半（预算、压缩、记忆、缓存、失效）根本没有网络传输，而 token 是贯穿全部课程的量：计费、窗口、缓存都按它算。

**token 数的口径**：本站的 token 数是迷你分词器（96 条合并规则、词表 353 + 2 个特殊 token）的**真实计数**，但真实模型的分词器不同（词表大几百倍，中文、`system` 这类词能合成 1 个 token），所以只代表量级关系：哪部分多、哪部分少、写比读贵，和真实模型一致；绝对值不一致。课程文案里要说明这一点（messages 课的第 4 步和总结是范例）。

**可信度（检查器顶部，`Fidelity`）**：
- `format`：公开规范或 API 文档定义的真实字节：HTTP/1.1 报文（RFC 9112）、SSE（WHATWG）、JSON、UTF-8、TLS 1.3 记录头（RFC 8446），以及 Messages API、Chat Completions、Responses 文档定义的字段。
- `internal`：某一个实现的内部细节，真实但会随模型和版本变化：chat template 的写法和特殊 token、SDK 的重试策略、缓存键的算法。
- `示意`：只讲概念，没有字节（`concept()` 层）。

**示例值（E.G.）**：每次运行都不同的值（id、request-id、date、密钥）和模型写的内容，字段加 `example: true`（`jsonBody` / `httpHead` 的 `example` 选项），界面显示 E.G.。错误信息的措辞只有文档逐字给出的几条（`DOCUMENTED_ERRORS`）不标示例，其余 `ApiError.documented` 为 false，展示时也要标 E.G.。
打码和加密的字节写成未知字节（`LayerWriter.unknown`），hex 里显示 `··`：x-api-key 的后半段、TLS 密文。

**价格**：一律是示例，`core/pricing.ts` 的 `PRICE_DATE`（2026-11-06）和来源 URL 要出现在课程里（标签、facts 或 concept 层）。

**配色**（`common.ts` 的 `PART_TONE`，全站统一）：工具定义 teal、system violet、用户消息 blue、助手回复 green、模板开销和 HTTP 头 / TLS slate、检索和记忆 amber。

## 节点

`src/lessons/types.ts` 的 `NODE_IDS`，每节课在 `nodes` 里挑自己要的。设备节点有固定图形，可以挂状态面板（每个最多 4 行）；数据节点没有外形，长相就是课程给它的图元，不能挂状态面板。

| 节点 | 类型 | 用途 |
|---|---|---|
| `app` | 设备 | 应用：调用 SDK 的业务代码和它的界面。带屏幕（`render` 逐行画出），命令框（`type`）挂在它上方 |
| `sdk` | 设备 | SDK 客户端：序列化 JSON、加鉴权和版本头、发 HTTP、解析响应、按 retry-after 重试 |
| `net` | 设备 | 网络：HTTPS 的 TLS 隧道，路上只看得到加密后的记录 |
| `gateway` | 设备 | API 入口：校验密钥和字段、分配 request-id、返回 4xx / 5xx、把请求交给模型 |
| `rate` | 设备 | 限流器：令牌桶，RPM / 输入 TPM / 输出 TPM，超了返回 429 和 retry-after |
| `model` | 设备 | 模型：读入展开后的 token，逐个生成输出 token |
| `tokenizer` | 设备 | 分词器和 chat template：把 system、tools、messages 展开成带特殊 token 的文本再切成 token |
| `cache` | 设备 | 提示缓存：按前缀字节的哈希存取，命中部分按缓存读取计费 |
| `tools` | 设备 | 工具执行端：应用这一侧真正执行函数，结果作为 tool_result 送回 |
| `memory` | 设备 | 记忆系统：写下值得长期保存的事实，按相关度召回 |
| `store` | 设备 | 检索库：文档切块、建索引、按查询取回（RAG） |
| `compactor` | 设备 | 压缩器：把较早的历史交给模型写成摘要，替换原文 |
| `subagent` | 设备 | 子 Agent：主 Agent 把子任务交给它，在自己干净的上下文里调用模型和工具，只把摘要交回 |
| `request` | 数据 | 请求：HTTP 头和 JSON 请求体的字段，或某种写法的请求 |
| `response` | 数据 | 响应：JSON 响应体的字段，或错误响应 |
| `events` | 数据 | SSE 事件流，按到达顺序排开 |
| `messages` | 数据 | 消息列表：system 和一轮轮 user / assistant 消息 |
| `prompt` | 数据 | 展开后的提示：模板拼出的文本和 token 段，每段标出来源 |
| `window` | 数据 | 上下文窗口：各部分占多少 token、还剩多少、输出预留 |
| `usage` | 数据 | 用量和账单：input / output / 缓存读写的 token 数和费用 |
| `docs` | 数据 | 取回的内容：检索到的文档块、召回的记忆条目 |
| `schema` | 数据 | 工具定义和 JSON Schema |
| `out` | 数据 | 输出文本：流式拼出的回复，或解析出的结构化结果 |

图元（`Prim`）和 llm 相同：`row`、`grid`、`graph`、`ring`、`tower`，格子可以带 `heat`（0–1）画热力图。轨迹表「类型」列的取值见 `TraceType`（CALL、HTTP、TLS、JSON、SSE、TEMPLATE、TOKENS、INFER、TOOL、CACHE、ERROR、RETRY、BUDGET、TRIM、COMPACT、MEMORY、RETRIEVE）。

## 计算核心接口（`src/core/`）

全部从 `src/core/index.ts` 导出：`import { encodeJson, messagesHttpRequest, createMessage, ... } from '../core'`。

下面各节里，`sse.ts`、`tokens.ts`、`template.ts`、`anthropic.ts`、`cache.ts`、`pricing.ts`、`ids.ts` 的实现在共享包 `@explorer/llm-core` 的同名文件里（和 AGENT EXPLORER 共用），`core/` 原样转导出；接口说明仍写在这里。

### JSON（`json.ts`）

实现在共享包 `@explorer/llm-core/json`（RAG EXPLORER 也用），`core/json.ts` 原样转导出。

| 签名 | 说明 |
|---|---|
| `encodeJson(value, indent = 0): JsonBytes` | 序列化，输出和 `JSON.stringify(value, null, indent)` 逐字节相同；`JsonBytes` 是 `{ text, bytes, spans }` |
| `interface JsonSpan { path; depth; kind; from; valueFrom; to }` | 每个值的字节区间。路径写成 `messages[0].content`，顶层是 `''`；`from` 是键的引号，`valueFrom` 是值 |
| `spanOf(json, path): JsonSpan`、`childrenOf(json, path): JsonSpan[]` | 按路径取区间（路径不存在会报错）、取直接子节点 |
| `jsonSize(value): number` | 紧凑写法的字节数 |

### HTTP/1.1（`http.ts`）

实现在共享包 `@explorer/llm-core/http`（RAG EXPLORER 也用），`core/http.ts` 原样转导出。

| 签名 | 说明 |
|---|---|
| `type Header = [name, value]`、`HttpRequest { method; target; headers; body }`、`HttpResponse { status; reason; headers; body }` | 报文 |
| `makeRequest(method, target, headers, body?)` | 拼请求，补上真实的 `content-length` |
| `makeResponse(status, headers, body?)` | 拼响应，没有 `transfer-encoding` 时补 `content-length`；原因短语查 `REASONS`（529 为空） |
| `encodeRequest(req): HttpLayout`、`encodeResponse(res): HttpLayout` | 字节和各部分区间：`startLine`、`headers[]`（含 `valueFrom`）、`blank`、`body` |
| `parseMessage(bytes): { startLine; headers; body }` | 解析（按 content-length 或 chunked），用于往返核对 |
| `chunked(pieces): { bytes; chunks; last }`、`dechunk(bytes)` | chunked 编码 / 解码，`chunks` 是每块的长度行、数据、CRLF 区间 |
| `headerOf(headers, name)` | 按名取值，不区分大小写 |

### SSE（`sse.ts`）

| 签名 | 说明 |
|---|---|
| `encodeEvent({ event?, data, id?, retry? }): string`、`encodeComment(text)` | 一个事件 / 注释的文本，data 里的换行拆成多行 |
| `encodeStream(frames): { text; bytes; spans }` | 整条流和每个事件、每一行的字节区间（`FrameSpan`） |
| `class SseParser { push(chunk: bytes | string): SseEvent[]; end(): string; lastEventId; reconnectionTime; lines; comments }` | 按 WHATWG 算法的增量解析：任意切分（CRLF 中间、汉字中间）结果相同；`end()` 丢弃没以空行结尾的半个事件 |
| `parseStream(bytes | string): SseEvent[]` | 一次性解析，`SseEvent { event; data; lastEventId }` |

### token（`tokens.ts`）

| 签名 | 说明 |
|---|---|
| `countTokens(text)`、`encodeText(text)` | 普通文本的计数和编码。特殊 token 的字面文字也按字节编码（防伪造角色边界） |
| `encodeWithSpecials(text)` | 模板编码：`<|im_start|>`、`<|im_end|>` 变成 353、354 |
| `SPECIAL_TOKENS`、`SPECIAL_ID`、`VOCAB_SIZE`、`isSpecial(id)` | 特殊 token |
| `tokenLabel(id)`、`tokenBytes(id)`、`decodeTokens(ids)` | 展示文字（␣、↵、半个字符写十六进制）、字节、解码 |
| `splitByTokens(text, n)`、`truncateTokens(text, n)` | 按 token 切段；截到前 n 个 token（丢掉不完整的尾字符） |

### chat template（`template.ts`，可信度 internal）

ChatML（`<|im_start|>role\n…<|im_end|>\n`，末尾 `<|im_start|>assistant\n` 是生成提示）。本站的写法：一轮里多个内容块之间空一行；工具定义放在 system 这一轮最前面，写成 `# Tools\n<tools>…</tools>`（每个工具一行 JSON），工具调用 `<tool_call>…</tool_call>`、结果 `<tool_response>…</tool_response>`，三个标签借自 Qwen2.5。

| 签名 | 说明 |
|---|---|
| `renderChatML(turns: ChatTurn[], { generationPrompt? }): RenderedPrompt` | 朴素写法：先把所有轮拼成一整串字符，再整段编码，每个 token 归到它第一个字节所在的段。内容里特殊 token 的字面文字（如 `<|im_start|>`）会被认成真的特殊 token，这和 Hugging Face tokenizer 的默认行为一致；内容可能含伪造标记时用 `encodeSafely` |
| `interface RenderedPrompt { text; bytes; ids; pieces; tokens; bySource; overhead }` | `pieces` 每段的 `kind`（special / header / content / separator / prompt）、`source`、字节区间、token 数；`bySource` 按来源汇总 content；`overhead` 是模板本身的 token |
| `turnsOf(request): ChatTurn[]`、`renderRequest(request, options?)` | Messages API 请求 → 对话轮（相邻同角色合并、tools 在 system 前）→ 展开 |
| `toolsText(tools)`、`blockText(block)`、`tokensUnder(prompt, prefix)` | 工具 / 内容块在模板里的文字；按来源前缀汇总 |

source 的写法：`tools`、`system`（字符串）或 `system[i]`（块数组）、`messages[i].content`（字符串）或 `messages[i].content[j]`（块数组）。缓存断点、预算拆账都按它对应。

### Messages API（`anthropic.ts`）

| 签名 | 说明 |
|---|---|
| `MessagesRequest`、`MessageParam`、`ContentBlockParam`（text / tool_use / tool_result）、`ToolDefinition`、`ToolChoice`、`CacheControl` | 请求类型，字段名照文档 |
| `MODELS: Record<string, ModelSpec>` | Opus 5.5 / Sonnet 5.5 / Haiku 5.5：窗口、max_tokens 上限、最小可缓存长度、是否支持预填充和强制工具调用、工具系统提示 token 数 |
| `API_VERSION`（`2026-10-21`）、`API_HOST`、`MESSAGES_PATH` | 常量 |
| `validateRequest(req, version?): ApiError | null` | 校验（必填、模型 404、max_tokens 上限、空 messages、采样参数、预填充、强制工具调用、≤ 4 个断点、1h 在 5m 前、tool_result 配对），返回第一个错误 |
| `apiError(type, message, documented?)`、`ERROR_STATUS`、`DOCUMENTED_ERRORS`、`isRetryable(status)` | 错误类型 ↔ 状态码；SDK 会重试的状态码（408、409、429、5xx） |
| `errorBody(err, requestId)`、`errorEvent(err)`、`errorHttpResponse(err, { requestId, retryAfter? })` | 错误 JSON、流里的 error 事件、带 request-id / retry-after 头的错误响应 |
| `inputBreakdown(req): InputBreakdown` | 输入 token 的构成：`total`、`system`、`tools`、`messages[]`、`template`，以及展开后的 `prompt` |
| `createMessage(req, reply: ContentBlock[], { id, cache? }): Message` | 用示例回复构造响应：停止序列截断、max_tokens 截断、tool_use，usage 真实计算（有缓存结果时拆成读、写、未缓存） |
| `outputTokensOf(block)`、`totalInput(usage)` | 输出块的 token 数；全部输入 = read + creation + input |
| `streamEvents(message, options?): StreamEvent[]` | 拆成流式事件：message_start（content 为空、output_tokens 初值 1）、块的 start / delta / stop、第一个块后一个 ping、message_delta、message_stop；text_delta 按 token 切且不切半个汉字，第一个 input_json_delta 是空串 |
| `eventFrame(event)`、`encodeEvents(events)`、`textPieces(text, n)` | SSE 帧（event 行 + data 行）、整条流的文本、按 token 分段 |
| `accumulate(events): Message` | 拼回完整消息（SDK 的 finalMessage），跳过不认识的事件 |
| `messagesHttpRequest(req, { apiKey?, version?, extra? })` | SDK 发出的请求：host、content-type、anthropic-version、x-api-key、content-length（头名小写） |
| `messagesHttpResponse(message, { requestId, date?, extra? })`、`streamHttpHead({ requestId, ... })` | 非流式 200 响应；流式响应头（text/event-stream、chunked） |
| `breakpointsOf(req, prompt?)`、`runCache(cache, req, now)` | 请求里的缓存断点（source → ttl，含顶层自动缓存）；用一个 `PromptCache` 跑这次请求 |
| `EXAMPLE_API_KEY` | 示例密钥 `sk-ant-api03-` + 95 个 x（长度是示例），展示时打码 |

### OpenAI 和兼容接口（`openai.ts`）

| 签名 | 说明 |
|---|---|
| `toChatCompletions(req, model?)` | → Chat Completions：system 变第一条消息，tool_use 变 `tool_calls`（arguments 是 JSON 字符串），tool_result 变 `role: tool`，`max_completion_tokens`，流式时 `stream_options.include_usage` |
| `chatCompletion(model, content, finish, usage, { id, created })`、`chatUsage(prompt, completion, cached?)`、`finishReasonOf(stop)` | 响应对象、usage、stop_reason → finish_reason |
| `chatStream(model, pieces, finish, usage | null, { id, created }): string` | 只有 data 行的流，include_usage 时多一个 choices 为空的 usage 块，最后 `data: [DONE]` |
| `toResponses(req, model?)` | → Responses：`instructions`、`input`（只有一条用户文本时是字符串）、扁平的工具、function_call / function_call_output 条目、`max_output_tokens` |
| `responseObject(model, content, usage, { id, messageId, created, incomplete? })`、`responsesUsage(input, output, cached?)` | 响应对象（`object: 'response'`、`output` 里的 message / function_call）和 usage |
| `PROVIDERS`、`providerRequest(provider, dialect, body, key, extra?)` | Anthropic、OpenAI、Ollama、OpenRouter 的主机、路径、鉴权头；拼 HTTP 请求 |

| 签名（dialects 课补的） | 说明 |
|---|---|
| `responsesStreamEvents(response, deltas): ResponsesStreamEvent[]` | 把一个只含一条 message 的 Responses 响应拆成流式事件：created → in_progress → output_item.added → content_part.added → 若干 output_text.delta → output_text.done → content_part.done → output_item.done → completed（被截断时是 incomplete）；`sequence_number` 从 0 起；created / in_progress 时 `usage` 为 null、`output` 为空 |
| `responsesFrame(event)`、`encodeResponsesStream(events)`、`responsesText(events)`、`responsesErrorEvent(code, message, sequence, param?)` | SSE 帧（event 行 + data 行，type 在最前、sequence_number 在最后）、整条流的文本、从事件里拼回文字、`type: 'error'` 事件 |
| `openaiError(...)`、`OPENAI_ERRORS`、`openaiErrorBody(err)`、`openaiErrorHttpResponse(err, { requestId, retryAfter? })` | OpenAI 的错误：外层 `error`，里面 `message`、`type`、`param`、`code`；`slowDown`（429 rate_limit_error / slow_down）、`overloaded`（503 service_unavailable_error / server_is_overloaded）、`noCredit`（429 credit_balance_exhausted，重试没用）、`serviceTier`（400，唯一逐字取自文档的措辞）；响应头 `x-request-id`、可选 `retry-after` |
| `openrouterErrorBody(code, message, metadata?)` | OpenRouter 的错误：`{ error: { code: 数字, message, metadata? } }`，HTTP 状态码与 code 相同 |

Responses 流只实现文字回复（没有 function_call 事件）；文档示例的流到 `response.completed` 为止，没有 `data: [DONE]`。真实的 response 对象还回显 instructions、tools 等许多字段，这里只带用到的。

### 限流与重试（`retry.ts`，retry 课）

时间是模拟时钟（秒），随机数来自固定种子的 PRNG。限额是演示用的小数目；SDK 的退避参数是 internal（公开文档只说指数退避、默认重试 2 次、有 retry-after 时照它）。

| 签名 | 说明 |
|---|---|
| `class TokenBucket { capacity; refillPerSecond; tryTake(n, now); spend(n, now); waitFor(n, now); available(now); untilFull(now) }` | 令牌桶：连续补充到上限；`tryTake` 不够就不扣；`spend` 可以扣成负数（输出 token 事后按实际量扣）；`waitFor` 返回还要等的秒数 |
| `class RateLimiter(limits: { rpm, itpm, otpm })` | 三个桶：`admit(inputTokens, now)` 放行并扣请求和输入，或返回 `{ ok: false, limit, waitSeconds, retryAfter }`（retryAfter 是向上取整的整秒，至少 1；缺口最大的桶决定）；`recordOutput(n, now)`；`headers(now, epoch)` 给出 `anthropic-ratelimit-{requests,input-tokens,output-tokens}-{limit,remaining,reset}`（reset 是 RFC 3339，remaining 不取整，真实响应里 token 余量取整到千） |
| `DEFAULT_POLICY`（2 次、500 ms 起步、8000 ms 封顶、抖动 25%）、`waitBefore(policy, attempt, rand, retryAfter?)` | 有 0–60 秒的 retry-after 就照它；否则 min(封顶, 起步 × 2^n) × (1 − 抖动 × rand())；返回 `{ ms, source, ceiling }` |
| `sdkRetries(status)`、`worthRetrying({ status, hopeless? })` | SDK 按状态码重试（408、409、429、5xx）；月度消费上限的 429 SDK 会重试但没用 |
| `retryTimeline(server, policy, rand, start?)` | 客户端重试循环，返回每次尝试的时刻、状态码、之后的等待 |
| `simulateHerd({ clients, policy, capacity, refillPerSecond, seed })` | 一群客户端在 t=0 同时发请求，被拒的按退避重发：返回重试的 100 ms 窗口峰值、成功和放弃数、各轮请求数 |

### 计费（`pricing.ts`）

| 签名 | 说明 |
|---|---|
| `PRICES: Record<model, Price>`、`PRICE_DATE`、`PRICE_SOURCE` | 示例单价，单位毫美元 / 百万 token（$4 / MTok = 4000） |
| `CACHE_WRITE_5M`（1.25）、`CACHE_WRITE_1H`（2）、`CACHE_READ[model]` | 缓存倍率（Opus 5.5、Sonnet 5.5 读是 0.05，Haiku 5.5 是 0.1） |
| `costOf(usage, model): Cost` | 各项费用和合计，单位纳美元（整数，没有浮点误差） |
| `formatUsd(nano)`、`formatPrice(milli)`、`priceOf(model)` | 金额和单价的文字 |

### 提示缓存（`cache.ts`）

| 签名 | 说明 |
|---|---|
| `cacheBlocks(prompt, breakpoints): CacheBlock[]` | 把展开后的提示切成可缓存块（每个内容块的结尾是一个边界），每块记前缀的字节数、token 数和链式哈希（FNV-1a，internal） |
| `class PromptCache { entries; constructor(minTokens); process(blocks, totalTokens, now): CacheOutcome }` | 查命中（每个断点向前至多 20 块）、写入新断点（前缀不足最小长度时静默不写）、读取刷新有效期，有效期从请求开始算 |
| `CacheOutcome { hitAt; read; write5m; write1h; input; writes; tooShort; expired }`、`cacheUsage(outcome)` | 结果和对应的 usage 四个字段 |
| `TTL_SECONDS`、`MAX_BREAKPOINTS`、`LOOKBACK_BLOCKS`、`shortHash(hash)` | 常量和展示用短哈希 |

### 上下文预算（`budget.ts`）

| 签名 | 说明 |
|---|---|
| `planBudget(window, parts: BudgetPart[], reserveOutput): BudgetPlan` | 拆账：每部分的占比、累计位置，输入 + 输出预留是否放得下 |
| `textPart(id, label, kind, text)` | 一段文字作为预算的一部分（真实计数） |
| `type TrimStrategy = (turns, budget) => TrimResult`、`dropOldest`、`keepLast(n)` | 截断策略接口和两种实现（从最早的一问一答丢起，最后一条保留；滑动窗口） |
| `compact(turns, keepRecent, summarize): CompactResult` | 压缩：旧的几轮换成一条摘要（摘要文字是示例，由调用方给），返回前后 token 数和压缩比 |
| `Turn`、`turnTokens`、`historyTokens` | 历史和计数 |

### 上下文工程的小工具（`context.ts`）

| 签名 | 说明 |
|---|---|
| `startsRound(message)`、`roundStarts(messages)`、`alignToRound(messages, start)` | 轮次 = 用户自己说的话 + 之后的工具往返 + 助手的回答；截断点往后对齐到下一轮开头，不拆散 tool_use / tool_result |
| `clearToolResults(messages, { keep, placeholder, exclude? })` | 只留最近 keep 次工具结果，更早的内容换成占位文字，tool_use 和配对不动；返回新消息和被清掉的 `ClearedResult[]` |
| `locate(prompt, needle, nth?): Location` | 一段文字在展开后的提示里的字节偏移、所在 token、相对位置（`share`） |
| `countOccurrences(text, needle)`、`messageText(message)` | 不重叠计数；一条消息的全部文字（含 tool_use 参数和 tool_result） |
| `factsOf(text, source)`、`conflictsOf(facts)` | 抽出「键：值」条目；同一个键出现不同的值就是冲突 |
| `ungrounded(messages, pattern)` | 助手说过、却从没在用户消息或工具结果里出现的值（被写错的订单号这类） |
| `wrapUntrusted(content, source, tag?)` | 不可信内容包进带来源的标签，内容里同名的开闭标签转义成 `&lt;`（标签写法是本站的） |
| `encodeSafely(prompt): RenderedPrompt` | 按段重新编码展开后的提示：只有模板插入的 `<|im_start|>`、`<|im_end|>` 是特殊 token，内容里的同样字符按普通文本编码，重新归账。内容里没有这种字面文字时和 `renderChatML` 完全相同；内容可能含伪造标记（网页、用户输入）时用它算 token |

### 记忆召回（`recall.ts`）

`termsOf`、`bm25` 在共享包 `@explorer/llm-core/bm25`（RAG EXPLORER 的混合检索也用），`recall.ts` 转导出并保留 `recall`；`MemoryEntry`、`ScoredEntry` 是共享包 `Bm25Doc`、`Bm25Scored` 的别名。k1 = 1.2、b = 0.75 和 idf 的写法已按 Lucene BM25Similarity 的文档核对（见 RAG EXPLORER 的 README）。

| 签名 | 说明 |
|---|---|
| `termsOf(text)` | 切词：汉字串按相邻两个字（二元组），字母数字按小写的词 |
| `bm25(entries, query, { k1?, b? }): ScoredEntry[]` | BM25 打分（k1 = 1.2、b = 0.75，idf = ln(1 + (N − n + 0.5)/(n + 0.5))），每条记一下命中的词、tf、idf、分项 |
| `recall(entries, query, { k, min? }): RecallResult` | 排序、取分数 ≥ min 的前 k 条；没召回的写明原因（`no-overlap`、`below-min`、`below-k`） |

上下文工程组的五课共用一个场景（网店客服 Agent、订单 A1024），在 `src/lessons/agent.ts`：system、三个工具、前三轮历史、规则片段，以及 `turnOf`、`messageTokens`（截断策略和拆账用同一把尺子，测试核对）、`budgetRow`。

### 示例 id（`ids.ts`）

`exampleId(kind, seed)`：`msg_01…`、`toolu_01…`、`req_011C…`、`chatcmpl-…`、`resp_…`、`call_…`，固定种子；`EXAMPLE_EPOCH`（2026-11-06 02:00 UTC）、`httpDate(epoch)`（IMF-fixdate）。

## 写字节的层（`src/decode/structures.ts`）

每个函数返回一层 `LayerWriter`，`wire(at, view, fidelity, ...layers)` 拼成一个事件的解码结构。检查器开了 `segmentLayers`：每层的 hex 地址从 0 开始，所以 JSON 层的偏移就是请求体里的偏移。

| 签名 | 说明 |
|---|---|
| `httpHead(name, layout, { mask?, notes?, example?, startNote? })` | 起始行、每个头一行（含 CRLF）、空行。`mask: { 'x-api-key': 13 }` 只露前 13 个字符，其余写成未知字节 |
| `jsonBody(name, json, { root?, expand?, notes?, example?, shown? })` | `root` 的每个直接子节点一个字段（键到值），`expand` 里的路径作为缩进一级的子字段 |
| `sseBody(name, stream, { notes?, shown? })` | 每个事件一个字段，每一行（event、data、空行）一个子字段 |
| `utf8Lines(name, text)`、`promptPieces(name, prompt)`、`tokenIds(name, ids)` | 按行的文本；展开后的提示按段（值是 token 数）；int32 小端 token id |
| `tlsRecord(name, plaintext)`、`TLS_TAG` | TLS 1.3 记录：0x17、0x0303、长度 = 明文 + 1 + 16，密文显示为 `··` |
| `concept(name, fields)`、`num`、`preview` | 概念层（无字节）、千分位、截断预览 |

## 课程的小工具（`src/lessons/common.ts`）

`cellsOf(values, options)`（和 llm 相同）、`PART_TONE`、`promptSegments(prompt, roles)`（按来源分段：每条消息、system、tools、模板，各段之和等于总数）、`segmentRow(id, segments, options)`、`usageGrid(id, usage, model, options)`（token 和费用的小表）、`pct`。

## 增加一节课

1. 新建 `src/lessons/<id>.ts`，导出 `Lesson`，`id` 和 `group` 必须和 `index.ts` 的 `PLANNED` 一致。计算从 `../core` 取，事件用 `dsl.ts` 的 `pk`、`note`、`state`、`show`。每个事件带上此刻的图元（`ds`）和字节结构（`wire`）。`pk` 的轨迹行是 `[累计 token, 类型, 说明, 字节数]`。
2. 在 `index.ts` 里 import 它，加进 `LESSONS`，顺序和 `PLANNED` 一致。
3. 在 `tests/narrative.<组>.test.ts`（`api` 组：messages 在 `narrative.test.ts`，其余三课在 `narrative.api.test.ts`，`prompt`、`context` 组新建 `narrative.prompt.test.ts`、`narrative.context.test.ts`）里加这节课的文案核对：关键的数写死，文字里的说法逐条核对。`tests/lessons.test.ts` 会自动检查步骤数（4–6）、detail 句数（2–4）、节点显示顺序、token 单调、字段范围、通道和数据结构是否重叠。
4. e2e 和首页的课数都从 `LESSONS` 取，不用改。
5. 文案里用了新的符号（不是中文），重新运行字体裁剪脚本。
6. **截图看布局**：单元测试只查设备和数据结构的外接框，查不出文字互相压住。用浅色、深色，1440 宽和 380 宽各看一遍（380 宽时节点名称会按比例放大，最容易压住）。经验：数据节点的名称用 `labelAt` 放到图元的左侧或右侧；`marks` 压住相邻格子时加 `dx`；状态面板不用时及时清掉（值设为 `null`）；命令框（`type`）的文字要短，它挂在 app 上方会盖住旁边的设备；布局的宽高比在 1.2–1.5 之间，太宽在 380 宽时会缩得很小。

## 核对过的 API 事实（2026-11-06）

| 事实 | 来源 |
|---|---|
| `POST https://api.anthropic.com/v1/messages`；`model`、`max_tokens`、`messages` 必填；`system` 是字符串或 text 块数组 | claude-api skill；<https://platform.claude.com/docs/en/api/messages.md> |
| 连续的 user 或 assistant 消息会被合并成一轮；不支持预填充的模型最后一条是 assistant 时 400，信息原文见 `DOCUMENTED_ERRORS.prefill`（Claude 4.6 及以后） | <https://platform.claude.com/docs/en/api/messages.md>、<https://platform.claude.com/docs/en/api/errors.md> |
| 响应字段 `id`、`type`、`role`、`content`、`model`、`stop_reason`、`stop_sequence`、`usage`；stop_reason 取值 end_turn、max_tokens、stop_sequence、tool_use、pause_turn、refusal | <https://platform.claude.com/docs/en/build-with-claude/working-with-messages.md>；claude-api skill |
| usage 的 `input_tokens` 只是最后一个缓存断点之后的部分；全部输入 = cache_read + cache_creation + input；`cache_creation` 按 `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` 细分 | <https://platform.claude.com/docs/en/api/rate-limits.md>；claude-api skill（prompt-caching） |
| 版本头 `anthropic-version` 必填，最新 `2026-10-21`，`2023-06-01` 仍可用；`2026-10-21` 起发送 temperature / top_p / top_k 一律 400 | <https://platform.claude.com/docs/en/api/versioning.md> |
| 鉴权头 `x-api-key`；每个响应都有 `request-id` 头，错误体里同值的 `request_id` | <https://platform.claude.com/docs/en/api/errors.md> |
| 错误体 `{ type: 'error', error: { type, message }, request_id }`；400 invalid_request_error、401 authentication_error、402 billing_error、403 permission_error、404 not_found_error（信息以 `model: <id>` 开头）、409 conflict_error、413 request_too_large、429 rate_limit_error、500 api_error、504 timeout_error、529 overloaded_error | <https://platform.claude.com/docs/en/api/errors.md>；claude-api skill（error-codes） |
| `retry-after` 是等待秒数；不是每个 429 都带（月度消费上限的 429 不带）；限流按令牌桶；RPM、ITPM、OTPM；`anthropic-ratelimit-*` 响应头；缓存读不计入 ITPM | <https://platform.claude.com/docs/en/api/rate-limits.md> |
| SDK 默认重试 2 次，指数退避，有 retry-after 时照它；重试 408、409、429、5xx 和连接错误 | <https://platform.claude.com/docs/en/api/errors.md>；claude-api skill |
| 流式事件 message_start → content_block_start / content_block_delta / content_block_stop → message_delta（usage 累计）→ message_stop，可夹任意个 ping；流中错误是 `event: error`（如 overloaded_error）；text_delta、input_json_delta（第一个 partial_json 是空串）；要容忍新的事件类型 | <https://platform.claude.com/docs/en/build-with-claude/streaming.md> |
| tool_use 块 `{ type, id, name, input }`，tool_result 块 `{ type, tool_use_id, content, is_error? }`；带 tools 时自动加的工具系统提示 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 都是 286 token（auto / none）；Opus 5.5、Sonnet 5.5 不支持 tool_choice 为 any / tool，信息原文见 `DOCUMENTED_ERRORS.forcedToolChoice` | claude-api skill（curl 示例）；<https://platform.claude.com/docs/en/about-claude/pricing.md>；<https://platform.claude.com/docs/en/api/errors.md> |
| `cache_control: { type: 'ephemeral', ttl?: '5m' | '1h' }`；最多 4 个断点；渲染顺序 tools → system → messages；每个断点向前看 20 块；最小可缓存 Opus 5.5 / Sonnet 5.5 / Haiku 5.5 是 512 token；1h 的要排在 5m 前面；读取刷新有效期，有效期从请求开始算 | claude-api skill（shared/prompt-caching.md） |
| 价格（每百万 token）：Opus 5.5 输入 $4、5m 写 $5、1h 写 $8、读 $0.20、输出 $20；Sonnet 5.5 $2 / $2.50 / $4 / $0.10 / $10；Haiku 5.5（≤ 100K）$0.10 / $0.125 / $0.20 / $0.01 / $0.50；写 1.25 倍和 2 倍，读 0.1 倍（Opus 5.5、Sonnet 5.5 是 0.05 倍） | <https://platform.claude.com/docs/en/about-claude/pricing.md>；claude-api skill |
| 模型 id `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`，窗口 1M，最大输出 128K | claude-api skill |
| 请求体上限 Messages API 128 MB（413 由 Cloudflare 在到达 API 之前返回） | <https://platform.claude.com/docs/en/api/errors.md> |
| Chat Completions：`model`、`messages`；`max_tokens` 已弃用，用 `max_completion_tokens`；响应 `object: 'chat.completion'`、choices[{ index, message{ role, content, refusal, annotations }, logprobs, finish_reason }]、usage{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details }；finish_reason stop / length / tool_calls / content_filter；流只有 data 行，`chat.completion.chunk`，以 `data: [DONE]` 结束，include_usage 时多一个 choices 为空的 usage 块；tool_calls[{ id, type: 'function', function{ name, arguments } }] | <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create> |
| Responses：`instructions` + `input`；工具扁平 `{ type: 'function', name, ... }`；`function_call`（call_id、name、arguments）和 `function_call_output`（call_id、output）条目；响应 `object: 'response'`、status（completed、incomplete 等）、output 里的 message 带 `output_text`；usage{ input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details }；流式事件 response.created、response.output_text.delta、response.completed、error | <https://developers.openai.com/api/docs/guides/migrate-to-responses>；<https://developers.openai.com/api/reference/resources/responses/methods/create> |
| OpenAI 示例模型 id：模型页 Flagship models 列出 `gpt-6-astra`、`gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`，本站示例用 `gpt-6-astra`；OpenRouter 模型页存在 `anthropic/claude-opus-5.5`（带组织前缀） | <https://developers.openai.com/api/docs/models>；<https://openrouter.ai/anthropic/claude-opus-5.5> |
| Ollama：`http://localhost:11434/v1/`，有 /v1/chat/completions、/v1/responses 等；本地要求带 key 但忽略它；支持 tools、stream_options.include_usage，不支持 tool_choice；上下文长度要用 Modelfile 的 num_ctx 设 | <https://docs.ollama.com/api/openai-compatibility> |
| OpenRouter：`https://openrouter.ai/api/v1/chat/completions`，`Authorization: Bearer`，可选 `HTTP-Referer`、`X-OpenRouter-Title`（也认 `X-Title`）；模型 id 带组织前缀；流里会有注释行；也有 /api/v1/responses | <https://openrouter.ai/docs/api/reference/overview> |
| ChatML 的写法和 add_generation_prompt 追加 `<|im_start|>assistant\n` | <https://huggingface.co/docs/transformers/main/en/chat_templating> |
| Responses 的流：每个事件 `event: <type>` + `data: <JSON>`，type 在最前，有 `sequence_number`（示例从 0 起）；文字回复依次是 response.created、response.in_progress、response.output_item.added、response.content_part.added、response.output_text.delta（item_id、output_index、content_index、delta、logprobs）、response.output_text.done、response.content_part.done、response.output_item.done、response.completed；示例流没有 `data: [DONE]`；错误事件 `{ type: 'error', code, message, param, sequence_number }`；created / in_progress 时 usage 为 null | <https://developers.openai.com/api/reference/resources/responses/methods/create>（Streaming 示例）、<https://developers.openai.com/api/reference/resources/responses/streaming-events> |
| OpenAI 错误：429 rate_limit_error（`slow_down`：速率涨得太快）、429 `credit_balance_exhausted` / `organization_spend_limit_exceeded` 等重试没用、503 `service_unavailable_error` / `server_is_overloaded`、400 带 `error.param`；有 Retry-After 就至少等这么久，没有就带抖动的指数退避并限制次数；响应头 `x-request-id`、`x-ratelimit-*-requests` / `-tokens`（limit、remaining、reset） | <https://developers.openai.com/api/docs/guides/error-codes>、<https://developers.openai.com/api/docs/guides/rate-limits>、<https://developers.openai.com/api/reference/overview> |
| OpenAI usage：Chat 的 `prompt_tokens` 含缓存（`prompt_tokens_details.cached_tokens` 是 Cached tokens present in the prompt），Responses 的 `input_tokens_details.cached_tokens` 是 input_tokens 的明细；Chat 和 Responses 都有 `total_tokens`；Responses 的 temperature 参数默认 1 | <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>、<https://developers.openai.com/api/reference/resources/responses/methods/create> |
| Ollama 的 `/v1/chat/completions` 支持 `max_tokens`、`temperature`、`top_p`、`stream_options.include_usage`、tools，不支持 `tool_choice`、`n`、`logprobs`；没有列 `max_completion_tokens`；本地 `api_key` 必填但被忽略（文档示例写 `ollama`） | <https://docs.ollama.com/api/openai-compatibility> |
| OpenRouter 请求字段 `max_tokens`、`temperature`（0–2）、`stream`、messages 的 role 含 system；错误体 `{ error: { code: 数字, message, metadata? } }`，状态码 400 / 401 / 402 / 403 / 408 / 429 / 502 / 503，429、503 可带 Retry-After；流开始后（HTTP 已 200）的错误：Chat 是带顶层 `error` 的块（finish_reason 为 error），Responses 是 response.failed 事件；Chat Completions 流在 `[DONE]` 前多一个带 usage 的块；也有 `/api/v1/messages`（Anthropic 写法）端点 | <https://openrouter.ai/docs/api/reference/overview>、<https://openrouter.ai/docs/api/reference/errors-and-debugging>、<https://openrouter.ai/docs/api/reference/streaming> |
| Anthropic 流：`message_delta` 的 usage 是累计值；`ping` 可出现任意次；流中错误 `event: error` + `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`（HTTP 已 200，标准错误处理不适用）；要容忍未知事件类型；示例 message_start 的 usage 为 `{ input_tokens: 25, output_tokens: 1 }` | <https://platform.claude.com/docs/en/build-with-claude/streaming.md>、<https://platform.claude.com/docs/en/api/errors.md> |
| 限流：令牌桶连续补充；RPM、ITPM、OTPM 各自一个限额，任一超了就 429；ITPM 只计 `input_tokens` + `cache_creation_input_tokens`，缓存读不计；OTPM 按实际生成量实时计，`max_tokens` 不影响；Start 档 Sonnet 5.5 是 4,000 RPM / 2,000,000 ITPM / 400,000 OTPM；`anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` 头（token 余量取整到千，reset 为 RFC 3339）；月度消费上限的 429 无 `retry-after`，体里 `error.details.error_code` 是 `enforced_spend_limit_reached`，重试（含 SDK 自动重试）无效；自设的消费上限是 400；突增还可能因加速限制（acceleration limits）得 429 | <https://platform.claude.com/docs/en/api/rate-limits.md>、<https://platform.claude.com/docs/en/api/errors.md> |
| 结构化输出（Anthropic）：请求里 `output_config.format`，`type` 是 `"json_schema"`，`schema` 是 JSON Schema；响应是 text 块里的 JSON 字符串（SDK 的 `parse()` 帮你解析）；`stop_reason` 为 `refusal` 或 `max_tokens` 时输出可能不符合 schema；每个对象必须 `additionalProperties: false`，写成别的值 400；递归 schema、数值和字符串长度约束不支持（SDK 辅助函数会去掉，改客户端校验）；旧的 `output_format` 不带 beta 头 400；新 schema 首次有编译延迟；可与 `tools` 同时用，工具上的 `strict: true` 保证参数合法（上限 20 个 strict 工具） | <https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md> |
| 结构化输出（OpenAI）：Chat Completions 的 `response_format: { type: 'json_schema', json_schema: { name, description?, schema, strict } }`，name 限 a-z A-Z 0-9 下划线短横线、最长 64，`strict` 默认 false，true 时严格照 schema 且只支持 JSON Schema 的一个子集；Responses 写在 `text.format`（`type`、`name`、`schema`、`strict`，少一层）；拒绝时有单独的 `refusal`，不一定遵守 schema | <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>、<https://developers.openai.com/api/docs/guides/structured-outputs> |
| 工具调用往返：第一次响应 `stop_reason: tool_use`，content 里有 `tool_use` 块；第二次请求带上完整历史、assistant 消息原样含 tool_use、再加一条 user 消息放 `tool_result`（`tool_use_id`）；工具定义、`tool_use` / `tool_result` 块和自动加的工具系统提示都计入输入 token；Opus 5.5 / Sonnet 5.5 的工具系统提示 286 token（auto、none），不支持 any / tool | <https://platform.claude.com/docs/en/build-with-claude/tool-use/overview.md>（含价格一节的 token 表） |
| 提示缓存：`cache_control: { type: 'ephemeral' }`（或 `ttl: '1h'`）可放在内容块上，也可放请求顶层自动缓存；默认 5 分钟，每次使用免费刷新，有效期从写入或读取那次请求开始算；短于最小长度不缓存也不报错（512：Opus 5.5、Opus 5、Sonnet 5.5、Haiku 5.5）；usage 三项 + `cache_creation` 按 TTL 细分，`cache_creation_input_tokens` 等于细分之和；写 1.25 倍 / 2 倍，读 0.1 倍（Opus 5.5、Sonnet 5.5 是 0.05 倍）；失效层级 tools → system → messages，改动「该层和之后各层」都失效；命中要求到断点的内容 100% 相同；回看 20 个块 | <https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md> |
| 上下文窗口：system、tools、messages（含工具结果、图片、文档）和这次的输出（含思考）都计入；输入本身超过窗口一律 400 invalid_request_error（prompt is too long）；Claude 4.5 及以后，输入 + max_tokens 超过窗口时照样接受，生成撞到上限以 `stop_reason: model_context_window_exceeded` 停下（更早的模型返回校验错误）；token 越多准确率和召回越差，文档称之为 context rot；发送前可用 `POST /v1/messages/count_tokens` 计数 | <https://platform.claude.com/docs/en/build-with-claude/context-windows.md>；claude-api skill（shared/token-counting.md） |
| 服务端压缩（按阈值）：beta 头 `compact-2026-01-12`，`context_management.edits` 里加 `{ type: 'compact_20260112' }`；`trigger` 默认 `{ type: 'input_tokens', value: 150000 }`，最低 50,000，只支持 input_tokens；可选 `pause_after_compaction`（默认 false）、`instructions`（完全替换默认的摘要提示）；响应里出现 `{ type: 'compaction', content }` 块，要把 response.content 整个追加回去，下次 API 忽略它之前的所有内容块。另有按需压缩（beta 头 `compact-2026-09-04`、顶层 `compaction` 参数），本站没有展开 | <https://platform.claude.com/docs/en/build-with-claude/compaction.md>、<https://platform.claude.com/docs/en/build-with-claude/compaction-threshold.md>；claude-api skill |
| Context editing：beta 头 `context-management-2025-06-27`；`clear_tool_uses_20250919` 的 `trigger` 默认 100,000 输入 token（也可按 tool_uses），`keep` 默认 3 次（`{ type: 'tool_uses', value: 3 }`），`clear_at_least`、`exclude_tools`、`clear_tool_inputs`（默认 false，只清结果、保留 tool_use）；从最早的开始清，换成占位文字（原文没给）；在服务端发生，客户端历史不变；响应 `context_management.applied_edits[{ type, cleared_tool_uses, cleared_input_tokens }]`；清理会让缓存前缀失效，建议用 clear_at_least；另有 `clear_thinking_20251015` | <https://platform.claude.com/docs/en/build-with-claude/context-editing.md> |
| memory 工具：`{ type: 'memory_20250818', name: 'memory' }`，不写 input_schema；客户端执行，路径前缀 `/memories`，命令 view、create、str_replace、insert（`insert_line` 之后插入 `insert_text`，0 是最前）、delete、rename；带上它时 API 自动在系统提示里加一段，要求先 view 记忆目录；必须防路径穿越 | <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool.md> |
| 子 Agent 用干净的上下文做专门的任务，交回精简的结果（常见 1,000–2,000 token）；工具结果清理是最轻的一种压缩；结构化笔记（agentic memory）放在窗口之外 | Anthropic Engineering，Effective context engineering for AI agents（2025-09-29） |
| 多 Agent 系统的 token 用量约是普通对话的 15 倍（单个 Agent 约 4 倍）；子 Agent 各有自己的上下文窗口，把最重要的内容浓缩后交给主 Agent | Anthropic Engineering，How we built our multi-agent research system（2025-06-13） |
| 研究：相关信息在输入开头或结尾时表现最好，在中间时明显下降（多文档问答、键值检索） | Liu et al.，Lost in the Middle: How Language Models Use Long Contexts，arXiv 2307.03172（2023，TACL） |
| 研究：哪怕一个干扰项也会降低表现，四个更糟；输入越长表现越差 | Hong、Troynikov、Huber，Context Rot: How Increasing Input Tokens Impacts LLM Performance，Chroma 技术报告（2025-07-14），<https://www.trychroma.com/research/context-rot> |
| BM25：Robertson、Zaragoza，The Probabilistic Relevance Framework: BM25 and Beyond，Foundations and Trends in IR 3(4)，2009；k1 = 1.2、b = 0.75 和 idf = log(1 + (N − n + 0.5)/(n + 0.5)) 是 Lucene BM25Similarity 的默认值（综述原文举的例子是 b = 0.5、k1 = 2；RAG EXPLORER 新建时核对） | <https://lucene.apache.org/core/10_0_0/core/org/apache/lucene/search/similarities/BM25Similarity.html> |
| 提示注入：LLM01:2025；间接注入来自网站、文件等外部来源；缓解措施包括限制模型行为、校验输出格式、输入输出过滤、权限控制和最小权限、高风险操作要人确认、分隔并标识外部内容、对抗测试 | OWASP Top 10 for LLM Applications，<https://genai.owasp.org/llmrisk/llm01-prompt-injection/> |

没有核对、以示例对待的：OpenAI strict 模式对 schema 的具体限制（本站的 schema 照文档示例写，每个对象 `additionalProperties: false`、字段全部必填，未逐条核对限制清单）、Anthropic schema 是否以及怎样计入 `input_tokens`（文档没给，本站的 token 数不含 schema）、真实服务对用户内容里特殊 token 字面文字的处理（本站按「内容一律当普通文本编码」的原则演示，Claude 服务端的做法不公开）、提示缓存的块粒度和缓存键、示例 id 的长度和字符集、x-api-key 的长度、非文档原文的错误措辞、真实 usage 里字段的顺序（文档示例只列了 input_tokens 和 output_tokens，本站按常见的顺序加上缓存字段和 service_tier）。

上下文工程组没有核对、以示例或本站写法对待的：clear_tool_uses 换上的占位文字（文档没给原文，本站写「[旧的工具结果已清除]」）、工具系统提示在提示里的位置（不公开，failure 课算位置时不计它）、包装不可信内容的 `<untrusted source=…>` 标签（本站的写法）、演示窗口 2,400 / 4,000 和压缩阈值 2,800（按比例缩小的演示值）、各课里的订单、规则、网页、记忆条目（示例数据）。

## 为什么复用 llm 的分词器

需要真实的 token 计数和 chat template 展开，而 LLM EXPLORER 已经有一个讲透了的字节级 BPE（学员在 llm 的第一课见过它怎样合并）。复用它，两门课的 token 数是同一把尺子量的。所以把分词器、UTF-8、语料、随机数、FNV-1a 抽到了 `packages/llm-core`，llm 改为从它导入（课程内容和数字不变，llm 的单元测试和 e2e 都通过），本模块只加两个 ChatML 特殊 token。

## 已知的简化和待办

- 回复内容（模型写的话）是示例。
- 本站的 token 数只代表量级关系（见「本站约定」）。迷你词表里没有 `system`、`assistant` 这些词，模板开销被放大了，文案里要说明。
- Claude 的 chat template 不公开，本站用 ChatML 演示，标 internal。
- 缓存键用 FNV-1a 模拟，块边界取内容块结尾；真实服务的缓存粒度和键不公开。
- HTTP 统一按 HTTP/1.1 展示（真实 SDK 可能走 HTTP/2）。
- Responses 的流只实现了文字回复（没有 function_call 事件）；OpenAI 错误的 message 措辞除 `service_tier` 一条外都是示例。
- retry 课的限额是演示用的小数目，输出桶简化为放行时立刻扣；SDK 的退避参数（500 ms 起步、8 s 封顶、抖动 25%）、retry-after 的 60 秒上限是 internal 的常见取值，不是公开文档的承诺；「服务过载」「流中途断开」是脚本写好的情形，没有模拟服务端的真实负载。
