# LLMOps Explorer

用交互动画讲一个 AI 功能怎样上线并保持可靠：怎样挡住提示注入和滥用（安全），怎样知道它答得好不好（评估），线上出了问题怎样看得见（可观测性）。注入检测器（规则 + 在本站自写的小数据集上真训练的分类器）、PII 的校验和脱敏、限流、评估用的统计（精确率召回率、Wilson 区间、Cohen's kappa、精确 McNemar、bootstrap、分位数）、trace / span id、W3C traceparent、OTLP/JSON、GenAI 语义约定的属性、token 和费用全部由 `src/core/` 真实计算；模型写的话（客服的回答、评委的评分理由、筛查模型的判断）无法真实生成（本站不跑大模型），作为脚本写死并标 E.G.；延迟是固定种子的模拟（见「已知的简化」）。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。和 LLM、CONTEXT、RAG、AGENT EXPLORER 是同一系列、同一套约定，是这个系列的最后一门；场景还是网店「小铺」的客服处理订单 A1024 的杯盖漏水（CONTEXT 讲它的上下文，RAG 讲它的检索，AGENT 讲它的循环和工具，这门课讲它上线以后的安全、评估和可观测性）。

## 开发

本模块由主站统一提供服务，地址是 `/modules/llmops/`。启动和构建在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test                 # 本模块的单元测试
python scripts/subset-fonts.py <woff2 目录>  # 按本站字符重新裁剪 Iosevka（需要 fonttools、brotli），字体源见脚本开头
```

端到端测试在仓库根目录：`npx playwright test --project=llmops`。

## 结构

- `src/core/`：计算核心，纯 TypeScript，确定性（训练、示例 id、模拟都来自固定种子）。接口见下文。
- `src/lessons/`：每节课一个文件。`index.ts` 的 `PLANNED` 是 13 节课的顺序和分组，`LESSONS` 按同样的顺序列出全部 13 课；`types.ts` 是节点、事件和图元的类型；`dsl.ts` 是写事件的简写；`common.ts` 是画消息、贡献、结果表的小工具；`scenario.ts` 是各课共用的场景（客服的 system、用户、注入示例、正常问题和回答）。
- `src/decode/`：可信度（`writer.ts`）和按真实格式写字节的层（`structures.ts`）。
- `src/scene/`：`devices.ts` 是设备节点的图形，`ds.ts`、`plugin.ts` 和 llm、context、rag、agent 逐字相同（数据结构图元的几何和帧间动画）。
- `tests/`：`core.test.ts` 核对统计、分类器、注入检测、PII、审核、用户标识和限流，以及共享包里的 SHA-256、FNV-1a 32、令牌桶；`core.eval.test.ts` 核对评分器、回归、评委、红队、偏见、间接注入的隔离；`core.observe.test.ts` 核对 trace、traceparent、OTLP、采样、延迟、监控、一次模型调用的账；`decode.test.ts` 核对写字节的层；`lessons.test.ts` 检查每节课的结构和布局；`narrative.test.ts` 核对 direct、indirect、moderation、abuse 的文案和计算结果，`narrative.redteam.test.ts` 核对 redteam、bias，`narrative.eval.test.ts` 核对评估组，`narrative.observe.test.ts` 核对可观测性组；`player.test.ts` 检查播放器。期望值手算、取自规范和文献里的例子，或用 `node:crypto`、`JSON.stringify` 这类独立实现核对。
- `e2e/app.spec.ts`：端到端测试，课程清单取自源码。
- Messages API、token 计数、计费、JSON、HTTP、示例 id、小铺的场景数据、JSON Schema 校验、令牌桶、SHA-256 不在本模块，在共享包 `packages/llm-core`（`@explorer/llm-core`），见下文「共享包」。

## 本站约定

**抽象层级（顶栏 7 档，从下到上）**：模型调用、应用、防护、追踪、评估、监控、用户。

| 档 | 讲什么 | 哪些课在这一档（规划） |
|---|---|---|
| 1 模型调用 | 一次 Messages API 调用本身：请求、响应、usage、费用、metadata.user_id | direct、moderation、abuse、trace、cost |
| 2 应用 | 调用模型的业务代码：客服后端、工具、拼进提示的外部内容 | direct、indirect、moderation、abuse、deterministic |
| 3 防护 | 挡在应用和模型之间的检查：注入检测、审核、脱敏、限流、输出检查 | direct、indirect、moderation、abuse、redteam |
| 4 追踪 | 把一次请求记下来：span、traceparent、OTLP 导出 | trace、cost |
| 5 评估 | 离线判断好不好：评估集、评分器、评委、人工、回归、红队、偏见 | redteam、bias、deterministic、judge、human、regression |
| 6 监控 | 线上持续盯着：指标、告警、采样、把失败的请求变成评估用例 | cost、monitor |
| 7 用户 | 用户看到的、反馈的东西：被拦时的回复、点踩、人工复核 | abuse、human、monitor |

顺序按「离模型多远」排：最底下是一次调用本身，往上是调用它的应用、挡在两者之间的防护，再往上是事后的追踪、离线的评估、持续的监控，最上面是用户。把「防护」放在「应用」之上，是因为防护层包住了应用对模型的调用（输入进模型前、输出回应用前都要过它）；「追踪」在「评估」之下，是因为评估和监控都要用 trace 里的数据（回流用例就是从 trace 里挑出来的）。和任务说明的建议相同，没有调整。这是本站的教学约定，不是业界标准分层。每节课用 `layer: [lo, hi]` 标出跨了哪几档，`layerNote` 写一句为什么（以句号结尾）。

**费用列（轨迹表第二列，`Row.cost`）**：到这个事件为止，这一课里**所有模型调用的累计费用**，单位纳美元（1e-9 美元，整数），显示成 `$0.00438` 这样（共享包的 `formatUsd`）。每一次模型调用（客服回答、筛查模型、评委）都经 `core/calls.ts` 的 `callModel`，费用是 `costOf(usage, model)`；课程把 `cost.total` 累加进这一列。必须单调不减（测试检查），不能手写。每节课用 `costNote` 写一句这课具体累计了哪些调用（以句号结尾），会拼进表头提示。字节数放在最后一列「大小」（`Row.size`）。

选它而不选「累计延迟」或「累计 span 数」，因为这门课的三组都在回答同一个问题——多一道检查、多一轮评估、多一层监控，要多花多少：

- 它能精确核对：token 数是本站分词器的真实计数，单价是共享包里核对过的示例单价，费用是两者相乘的整数，测试逐项手算（direct 课：254 × 4,000 + 168 × 20,000 = 4,376,000 纳美元）。延迟在本站是模拟的，不能当事实核对；span 数只在可观测性组有意义；
- 它能体现这门课的主题：拦下的注入不进模型，这一列就停在 $0（direct 课前 16 行都是 $0）；用小模型筛查一次只要主调用的 1% 左右；评估组跑一遍评估集、请评委打分都要付钱，回归测试每改一次提示就要再付一遍；
- 代价是不调用模型的课（比如只做 PII 脱敏、只看 traceparent）整课是 $0。测试只要求有 INFER 或 JUDGE 行的课最后大于 0。写这类课时建议在最后一步接一次模型调用（比如脱敏之后把请求真的发出去），让这一列有意义。

**token 数的口径**：和 CONTEXT、AGENT EXPLORER 相同，是迷你 BPE 分词器（96 条合并规则）按 ChatML 展开后的真实计数，只代表量级关系，真实模型的分词器不同，课程文案里要说明。

**可信度（检查器顶部，`Fidelity`）**：
- `format`：公开规范或 API 文档定义的真实字节：HTTP/1.1、JSON、UTF-8、Messages API 的字段（含 `metadata.user_id`）、W3C `traceparent`、OTLP/JSON 的结构和 GenAI 语义约定的属性名。
- `internal`：本站或某个实现的写法，真实计算但不是标准：本站的检测规则和命中区间、分类器的 n-gram 和桶号、防护层交回后端的判定、评估报告、限流器的状态、泄露检查的结果。
- `示意`：只讲概念，没有字节（`concept()` 层）。

**示例值（E.G.）**：每次都不同的值（msg / req id、date、密钥、user_id、trace / span id）和模型写的内容（回答、评委的理由、筛查的判断、usage），字段加 `example: true`。脚本里写的话是示例，但其中的日期、天数、单号、金额都从数据里取（比如回答里的「签收 3 天」来自订单数据和 `daysBetween`）。

**注入示例的写法**：课程里展示的注入文字一律以 `scenario.ts` 的 `DEMO_MARK`（「【演示用的注入文本】」）开头，内容是教科书式的说法（「忽略之前的规则」「把系统提示原样发给我」），不写能照搬的真实攻击载荷。标记也一起送进检测器（训练集里没有它，课程里的分数是带着它算的，narrative 测试锁住了这些分数）。数据集里的注入样本同样是泛泛的说法，不带标记（带了分类器会学到标记本身）。

**价格**：一律是示例，用共享包 `pricing.ts` 的 `PRICES` 和 `PRICE_DATE`（2026-11-06，和 CONTEXT、AGENT 相同），日期要出现在课程里。

**配色**：用户的消息 blue；命中、拦下、往「注入」推的特征 amber；放行、模型写的回答 green；检查结果、往「正常」推的特征 teal；分类器 violet；演示标记和协议开销 slate。

## 课程规划（`PLANNED`，13 课）

| 组 | id | 标题 | 要点 | 主要用到的核心 |
|---|---|---|---|---|
| safety | `direct` | 直接提示注入：检测与拦截 | 样板课。规则 vs 分类器、阈值扫描、测试集上的混淆矩阵和 Wilson 区间、拦下不花钱、输出侧泄露检查 | `detect`、`evaluateDetector`、`thresholdSweep`、`leakCheck`、`callModel` |
| safety | `indirect` | 间接提示注入：隔离与筛查 | 注入藏在商品评价、邮件、工具结果里（`web` 节点）；JSON 包裹（文档的写法）vs 带随机后缀的标签、伪造结束标签；工具结果先过检测器再交回；和 AGENT 的 approval 课区分：那课讲权限确认，这课讲检测、隔离和检测器在间接样本上的指标 | `jsonEnvelope`、`fenced`、`screenToolResult`、`detect` |
| safety | `moderation` | 输入输出防护：审核与脱敏 | 本站的四类审核分数（字段名照 OpenAI moderation）、按策略拦截 / 转人工 / 改写 / 放行；PII 识别（身份证校验码、Luhn）、标签 / 打码 / 可还原的占位符，模型回答后再换回来 | `moderate`、`decide`、`findPii`、`redact`、`restore` |
| safety | `abuse` | 用户标识与滥用追踪 | HMAC 生成不透明的 `metadata.user_id`（文档：不放姓名邮箱电话，最长 512）、OpenAI 的 `safety_identifier`；每用户令牌桶 vs 滑动窗口，一串请求真的跑一遍；屡次触发防护的用户逐级处置 | `userIdOf`、`PerUserBuckets`、`SlidingWindow`、`simulate`、`poissonArrivals`、`OffenderLog` |
| safety | `redteam` | 红队测试与攻击成功率 | 攻击用例集（按类别）× 变形（插空格、全角、零宽、换行），规范化前后检测器的表现；ASR 和它的 Wilson 区间，按类别拆 | `mutate`、`normalize`、`runAttacks`、`wilson` |
| safety | `bias` | 偏见检测：成对提示 | 同一组模板只换姓名 / 性别，回答（示例）用确定性评分器打分，配对差、符号检验、bootstrap 区间、二元结论翻转的对数 | `pairedPrompts`、`comparePaired`、`signTest`、`bootstrap` |
| eval | `deterministic` | 确定性评估：匹配、正则与 Schema | 精确匹配（规范化）、正则（必须出现 / 不能出现）、JSON 解析和 Schema、工具调用参数核对（小铺的 input_schema）；通过率和 Wilson 区间、按标签拆 | `exactMatch`、`regexCheck`、`schemaCheck`、`toolCallCheck`、`runEval` |
| eval | `judge` | LLM 当评委：评分标准与位置偏差 | 评分标准加权、成对比较交换顺序后结论翻转的比例、和人工标注的一致性；评委调用的费用进费用列 | `rubricScore`、`positionBias`、`judgeAgreement`、`callModel` |
| eval | `human` | 人工评估与一致性 | 两到三名标注员独立标同一批，Cohen's kappa、bootstrap 区间、Landis–Koch 分档（说明只是惯例）；分歧样本怎么裁决 | `cohenKappa`、`kappaBand`、`bootstrap` |
| eval | `regression` | 回归测试：改提示前后 | 同一评估集两次运行逐用例对比：通过率变化、变好 / 变坏的用例、精确 McNemar；只看总通过率会漏掉什么 | `compareRuns`、`mcnemarExact` |
| observe | `trace` | 一次请求的 trace | span 树（invoke_agent → chat → execute_tool）、GenAI 语义约定属性、W3C traceparent 逐字节、OTLP/JSON 导出到 Collector（/v1/traces、4318） | `Tracer`、`chatRequestAttrs`、`chatResponseAttrs`、`toolAttrs`、`formatTraceparent`、`otlpTraces`、`otlpHttpRequest` |
| observe | `cost` | 成本与延迟拆账 | 每个 span 的 token 和费用、TTFT（模拟）、p50 / p95 / p99（线性插值 vs 最近秩）、GenAI 指标的桶边界 | `callModel`、`simulateCalls`、`percentiles`、`nearestRank`、`bucketCounts` |
| observe | `monitor` | 生产监控与回流 | 模拟流量和一次事故、窗口指标、连续 N 个窗口超标才告警、尾部采样 vs 按 trace id 的概率采样（阈值 T 和 `th`）、把失败的请求脱敏后变成评估用例 | `simulateTraffic`、`windows`、`evaluateAlert`、`tailSample`、`probabilitySample`、`toEvalCase` |

和任务说明的建议相比没有改课数和顺序（13 课，分组 6 / 4 / 3）：安全组 6 课从「攻击从哪来」（直接、间接）到「挡什么」（审核、脱敏、滥用）再到「挡得住吗」（红队、偏见），评估组 4 课从最便宜的确定性检查到评委、人工、回归，可观测性组 3 课从一次请求到一批请求再到持续的线上。和已有课程的边界：

- CONTEXT 的 isolation 课讲上下文隔离（谁的上下文里有什么），这门课不再讲；indirect 课只讲注入内容的检测、包裹和筛查。
- AGENT 的 approval 课已经用工具结果里的间接注入作动机，讲了危险工具要确认、最小权限，并预告「LLMOPS 会专讲注入的检测与评估」——indirect 课一句话引用它，不再讲权限确认，重点是检测器在间接样本上的指标、隔离写法的字节、筛查的代价。
- RAG 的 evaluate 课讲 RAGAS 的四个指标，评估组讲通用的评估方法（评分器、评委、人工、回归），不再讲 RAGAS。

## 节点

`src/lessons/types.ts` 的 `NODE_IDS`，一次设计好全部课程会用到的节点，每节课在 `nodes` 里挑自己要的。设备节点有固定图形，可以挂状态面板（每个最多 4 行）；数据节点没有外形，长相就是课程给它的图元，不能挂状态面板。

| 节点 | 类型 | 用途 |
|---|---|---|
| `app` | 设备 | 应用界面：用户提问、看回答。带屏幕（`render` 逐行画出），命令框（`type`）挂在它上方 |
| `backend` | 设备 | 客服后端：收消息、调用防护层和限流、组装 Messages API 请求、调用模型、把回答交回界面 |
| `guard` | 设备 | 防护层：输入筛查（注入检测、审核、PII 脱敏）和输出检查（泄露、PII），决定拦截、改写还是放行 |
| `llm` | 设备 | 模型：Messages API 背后的大模型，写的内容是示例 |
| `tools` | 设备 | 工具执行端：查订单、查规则、建退货单（工具调用的评估、trace 里的 execute_tool span） |
| `db` | 设备 | 订单库：小铺的订单和退货单（共享包的场景数据） |
| `web` | 设备 | 外部内容：网页、邮件、商品评价、工具读回的文档（间接注入的来源） |
| `limiter` | 设备 | 限流器：按 user_id 的令牌桶或滑动窗口，屡犯记录 |
| `harness` | 设备 | 评估运行器：把评估集或攻击用例集逐条跑一遍，交给评分器，汇总 |
| `judge` | 设备 | 评委模型：按评分标准打分或二选一，理由是示例 |
| `raters` | 设备 | 人工标注员：几个人独立标同一批样本 |
| `collector` | 设备 | OpenTelemetry Collector：接收 OTLP/HTTP（/v1/traces，4318），采样、转发 |
| `observe` | 设备 | 可观测性后端：存 trace 和指标、查询、看板（不指定产品） |
| `alert` | 设备 | 告警：指标连续超标时通知值班的人 |
| `message` | 数据 | 一条消息（或工具结果）按命中切成的片段，格子写 UTF-8 字节数（`messageRow`） |
| `rules` | 数据 | 规则表：每条规则在每条消息上命中几次 |
| `features` | 数据 | 分类器的特征：片段对分数的贡献 ×100，热力图（`contributionRow`） |
| `scores` | 数据 | 分数和阈值：每个类别或每条消息的概率、处置 |
| `matrix` | 数据 | 混淆矩阵 / 指标表：抓到、漏掉、误拦、放行（`outcomeGrid`） |
| `dataset` | 数据 | 数据集、评估集、攻击用例集 |
| `results` | 数据 | 逐用例的结果：过 / 不过、翻转、变好变坏 |
| `request` | 数据 | 请求：HTTP 头和 JSON 请求体的字段 |
| `response` | 数据 | 响应：content、stop_reason、usage |
| `buckets` | 数据 | 每个用户的令牌桶水位、窗口里的请求数 |
| `spans` | 数据 | span 树（瀑布图，可以用 `graph` 或一排 `row`） |
| `ledger` | 数据 | 账：每个 span 或每次调用的 token、费用、延迟 |
| `latency` | 数据 | 延迟分布：分位数、直方图桶 |
| `metrics` | 数据 | 监控指标：每个窗口的请求数、出错率、p95，告警阈值 |

图元（`Prim`）和 llm、context、rag、agent 相同：`row`、`grid`、`graph`、`ring`、`tower`，格子可以带 `heat`（0–1）。轨迹表「类型」列的取值见 `TraceType`（CALL、HTTP、INFER、SCREEN、RULE、SCORE、BLOCK、PASS、REWRITE、CHECK、LIMIT、TOOL、EVAL、JUDGE、LABEL、STATS、SPAN、EXPORT、SAMPLE、ALERT、ERROR）。

## 计算核心接口（`src/core/`）

全部从 `src/core/index.ts` 导出：`import { detect, evaluateDetector, findPii, moderate, userIdOf, runEval, Tracer, otlpTraces, wilson, callModel, ... } from '../core'`。共享包的 Messages API（`anthropic`）、计费（`pricing`）、示例 id（`ids`）、JSON、HTTP、小铺（`shop`）、JSON Schema（`schema`）整体转导出，另外转导出 `countTokens`、`sha256`、`hmacSha256`、`toHex`、`TokenBucket`、`utf8Encode`、`utf8Decode`。

下文的签名省略了可选参数的默认值写法；「锁住」的数字在 `tests/` 里有断言，改了数据集或参数要同时改测试和课程文案。

### 统计（`stats.ts`）

| 签名 | 说明 |
|---|---|
| `confusion(actual: boolean[], predicted: boolean[]): Confusion`、`Confusion { tp; fp; fn; tn }` | 二分类的混淆矩阵，true 是正类 |
| `metricsOf(c): Metrics`、`Metrics { n; precision; recall; f1; accuracy; fpr; specificity; undefinedOf }` | 精确率、召回率、F1、准确率、误报率、特异度；分母为 0 的记 0，名字列在 `undefinedOf`（文案要说明） |
| `thresholdSweep(scores, labels, thresholds): SweepRow[]`、`SweepRow { threshold; confusion; metrics }` | 分数 ≥ 阈值判为正类，逐个阈值算 |
| `rocAuc(scores, labels): number` | AUC = Mann–Whitney U / (n₊n₋)，同分算一半 |
| `Z95`、`wilson(k, n, z = Z95): Interval`、`waldInterval(k, n, z)`、`Interval { estimate; lo; hi }` | Wilson 得分区间（Newcombe 1998 的 81/263 核对过）；Wald 只用来对比（k = 0 时退化成一个点） |
| `binomPmf(k, n, p)`、`binomCdf(k, n, p)`、`binomTwoSided(k, n, p = 0.5)` | 二项分布；精确二项检验的双侧 p（把概率不大于观测值的结果加起来，R 的 binom.test 写法） |
| `mcnemarExact(before: boolean[], after: boolean[]): PairedTest`、`PairedTest { b; c; ties; p }` | 配对的过 / 不过：b 是改前过改后不过，c 是反过来，H0 下 b ~ B(b + c, 0.5) |
| `signTest(diffs: number[]): PairedTest` | 符号检验：b 是正差个数，c 是负差个数，0 丢掉 |
| `cohenKappa(a: string[], b: string[], labels?): Kappa`、`Kappa { labels; table; po; pe; kappa }` | κ = (po − pe)/(1 − pe)，可以多类；维基百科的例子（0.4）核对过；pe = 1 时记 1 |
| `kappaBand(kappa): string` | Landis–Koch 的中文分档（没有一致、轻微、一般、中等、相当、几乎完全），只是惯例 |
| `weightedKappa(a, b, labels, scheme = 'linear'): WeightedKappa`、`WeightedKappa extends Kappa { scheme; observed; expected }` | 有序标签的加权 kappa：κw = 1 − Σ wᵢⱼOᵢⱼ / Σ wᵢⱼEᵢⱼ，wᵢⱼ = \|i − j\|（linear）或 (i − j)²（quadratic）；labels 按顺序给出；po、pe、table 同不加权的；只有两类时等于 Cohen's kappa，手算的例子核对过（narrative.eval.test.ts） |
| `bootstrap(n, statistic(indices) => number, { iterations = 2000, seed = 1, level = 0.95 }): BootstrapResult` | 百分位 bootstrap，statistic 收下标数组（配对数据、kappa 都能用）；`BootstrapResult { estimate; lo; hi; iterations; seed }` |
| `sum`、`mean`、`stdev`（n − 1） | 描述统计 |
| `quantile(values, q)`、`quantileSorted(sorted, q)` | 线性插值分位数（Hyndman–Fan 第 7 种，NumPy / R 默认） |
| `nearestRank(values, q)` | 最近秩法：第 ⌈qn⌉ 个，结果一定是观测值（维基百科 Percentile 的例子核对过） |
| `percentiles(values): Percentiles`、`Percentiles { n; mean; min; p50; p95; p99; max }` | 延迟摘要 |
| `bucketCounts(values, bounds): number[]` | OTLP 显式桶：长度 = 边界数 + 1，上界包含在桶里 |

### 分类器（`classifier.ts`）

| 签名 | 说明 |
|---|---|
| `normalize(text)`、`featureText(text)` | NFKC、小写、去空白和零宽字符；`featureText` 再去掉标点（`\p{P}`） |
| `charNgrams(text, ns = [1, 2, 3]): string[]` | 规范化、去标点后按码点切 n-gram |
| `bucketOf(gram, dims)`、`featuresOf(text, dims, ns): Features`、`Features { buckets; value; grams: Map<桶, 片段[]> }` | 特征哈希：UTF-8 字节过 FNV-1a 32 取余；出现的桶值为 1/√桶数 |
| `Sample { text; label: 0 \| 1 }`、`TrainOptions { dims; ns; epochs; lr; l2; seed; positiveWeight }`、`DEFAULT_TRAIN`（1,024 桶、n 1–3、80 轮、学习率 1、L2 1e-4、种子 7、正例不加权） | 训练参数；`positiveWeight: 'balanced'` 让正例梯度乘负例数 / 正例数（正例很少时用） |
| `trainLogReg(samples, options?): LogReg`、`LogReg { options; weights; bias; losses; trained }` | 逻辑回归，SGD，每轮按 mulberry32(seed + 轮次) 打乱；特征只算一次；losses 是每轮的平均交叉熵 |
| `sigmoid(z)` | 数值稳定的 σ |
| `predict(model, text): Prediction`、`Prediction { p; logit; bias; contributions; features }`、`Contribution { bucket; amount; weight; grams }` | 概率和每个桶对 logit 的贡献（按绝对值排序）：logit = bias + Σ amount（测试核对） |
| `topWeights(model, samples, k = 8, sign = 1)` | 权重最大（或最小）的桶和训练集里落进去的片段 |

### 注入检测（`injection.ts`）

| 签名 | 说明 |
|---|---|
| `INJECTION_SET: Labeled[]`、`Labeled { id; text; label: 'injection' \| 'benign'; split; hard? }`、`TRAIN_SET`、`TEST_SET`、`toSample(item)` | 本站自写：39 条注入（inj-01…）、46 条正常（ok-01…，17 条难负例）；每类第 3、6、9… 条进测试集：训练 57、测试 28（13 注入、15 正常）（锁住） |
| `INJECTION_RULES: Rule[]`、`Rule { id; name; pattern }` | R1 要求忽略规则、R2 索要系统提示、R3 切换身份、R4 宣称新指令（本站写法，正则源码，u + i） |
| `ruleHits(text): RuleHit[]`、`RuleHit { rule; match; from; to }` | 在原文上跑规则（不规范化，所以变形能绕过），UTF-16 下标 |
| `DETECTOR: LogReg`、`DEFAULT_THRESHOLD`（0.5） | 在训练集上训练的检测器，模块加载时训练一次（几毫秒） |
| `detect(text, threshold?, model?): Detection`、`Detection { text; rules; prediction; threshold; flagged; by: 'rule+model' \| 'rule' \| 'model' \| 'pass' }` | 任一规则命中或 p ≥ 阈值就判注入 |
| `evaluateDetector(set = TEST_SET, threshold?, model?): DetectorReport`、`DetectorReport { items; rules; model; combined }`、`LayerReport { confusion; metrics; missed; falseAlarms }` | 分层评估。测试集上：规则 12 / 13、误拦 1（ok-27）、漏 inj-39；分类器 11 / 13、误拦 0、漏 inj-18、inj-33；两层 13 / 13、误拦 1（锁住） |
| `longestCommonRun(a, b)`、`leakCheck(reply, systemPrompt, { canary?, minRun = 12 }): LeakCheck`、`LeakCheck { canary; overlap; minRun; leaked }` | 输出侧的系统提示泄露检查：规范化后最长公共子串 ≥ minRun 或出现金丝雀串（本站写法） |

### 间接注入的隔离（`untrusted.ts`）

| 签名 | 说明 |
|---|---|
| `jsonEnvelope(source, body, extra?): JsonBytes` | Anthropic 文档的写法：`{"source", ...extra, "body"}` 的紧凑 JSON，和 `JSON.stringify` 逐字节相同，带字节区间 |
| `fenceTag(seed)`、`fenced(body, seed): Fenced`、`Fenced { text; tag; breakout }` | 本站对比用：`<untrusted-xxxx>` 标签包裹，正文里出现 `</untrusted…` 就标 breakout |
| `screenToolResult(content, threshold?): Screened`、`Screened { detection; content; replaced }` | 工具结果先过 `detect`，判为注入就换成一段说明 |
| `INDIRECT_SET: IndirectItem[]`、`IndirectItem extends Labeled { source }`、`ExternalSource`（review、email、web、doc、tool）、`SOURCE_LABEL` | 本站自写的间接样本：12 条藏在第三方内容里的注入（ind-01…）、12 条正常的第三方内容（ext-01…，几条用到「忽略」「系统提示」「作废」「指令」），全部是测试样本，可以直接交给 `evaluateDetector`。检测器上：规则 8 / 12、误拦 2，分类器 7 / 12、误拦 3，两层 9 / 12、误拦 5（漏 ind-01、ind-05、ind-10）（锁住，见 narrative 测试） |

### PII（`pii.ts`）

| 签名 | 说明 |
|---|---|
| `PiiKind`（phone、email、id_card、bank_card）、`PII_LABEL`、`PiiHit { kind; text; from; to; valid; reason? }` | 类型和中文名 |
| `ID_WEIGHTS`、`idCheckChar(body17)`、`validBirth(yyyymmdd)`、`idProblem(id): string \| null` | 身份证 ISO 7064 MOD 11-2：加权因子、校验码、出生日期；维基百科的两个号码核对过 |
| `luhnCheckDigit(payload)`、`luhnValid(digits)` | Luhn（ISO/IEC 7812-1 附录 B），维基百科的 1789372997 → 4 核对过 |
| `findPii(text): PiiHit[]` | 按 email → 身份证 → 银行卡（16–19 位，可带空格、短横线）→ 手机号（1[3-9]，可带 +86、分隔）匹配，先占的区间不再给后面；校验不过的 valid: false |
| `redact(text, hits?, mode = 'tag', { includeInvalid? }): Redaction`、`Redaction { text; replacements; table }` | tag：「[手机号]」；mask：留前 3 后 4 等；pseudonym：「<手机号_1>」同值同号，对照表留在应用侧 |
| `maskOf(hit)`、`restore(text, table)` | 部分打码；把占位符换回原文 |

### 内容审核（`moderation.ts`）

| 签名 | 说明 |
|---|---|
| `MOD_CATEGORIES`（harassment、illicit、self-harm、violence）、`MOD_LABEL` | 类别名取 OpenAI moderation 文档里的四个键，分数是本站的分类器算的 |
| `MODERATION_SET: ModItem[]`、`ModItem { id; text; labels; split }` | 本站自写 72 条：48 条违规（每类 12 条，都是单一类别）、24 条正常（多数带强烈情绪，几条用到「砸」「抢劫」这类词）；每类每 3 条取 1 条进测试集（共 24 条）。测试集上 24 条有 17 条的类别完全判对，没见过的说法常常认不出（比如「快递员再这样我就揍他」暴力分只有 0.26）|
| `MODERATORS: Record<类别, LogReg>`、`MOD_THRESHOLD`（0.5） | 一对其余，每类一个逻辑回归（种子 11 + i，正例梯度按负例数 / 正例数加权：`positiveWeight: 'balanced'`） |
| `moderate(text, thresholds?): ModerationResult`、`ModerationResult { flagged; categories; category_scores }`、`moderationResponse(id, model, result)` | 字段名照 OpenAI moderation 的 results[]；`moderationResponse` 包成 `{ id, model, results }` |
| `ModAction`（allow、rewrite、review、block）、`ACTION_ORDER`、`ModPolicy`、`EXAMPLE_POLICY`、`decide(result, policy?): Decision` | 本站的示例策略：辱骂改写、轻生念头转人工（阈值 0.3）、违法和威胁拦下；取超过阈值的类别里最重的处置 |
| `moderateSentences(text, thresholds?)`、`SentenceModeration { from; to; text; result }` | 按句打分（本站写法）：在 。！？!? 后切开，每句 `moderate`，每类取各句最高分再按阈值判定，返回 `{ sentences, result }`；整段打分时一句辱骂会被长串号码稀释（moderation 课：整段 0.07、按句 0.99） |

### 用户标识和限流（`abuse.ts`）

| 签名 | 说明 |
|---|---|
| `EXAMPLE_ID_SECRET`、`userIdOf(account, secret?)` | `u_` + HMAC-SHA256(密钥, 账号去空白转小写) 的前 32 个十六进制字符 |
| `ANTHROPIC_USER_ID_MAX`（512）、`OPENAI_SAFETY_ID_MAX`（128） | 文档给的长度上限 |
| `Limiter`、`Admit { ok; remaining; waitSeconds }` | 限流器接口 |
| `new PerUserBuckets(capacity, refillPerSecond)`、`.admit(user, now, cost = 1)`、`.bucketOf(user, now)` | 每用户一个共享包的 `TokenBucket`，新用户满桶 |
| `new SlidingWindow(limit, windowSeconds)`、`.admit(user, now, cost = 1)` | 窗口 (now − w, now]，被拒时等到最早的那个滑出去 |
| `simulate(arrivals: Arrival[], limiter): Admission[]`、`Arrival { at; user }` | 按时间顺序跑一串请求 |
| `poissonArrivals(user, rate, duration, seed, start = 0)` | 泊松到达（固定种子，时间保留 3 位小数） |
| `Sanction`、`EXAMPLE_ESCALATION`（1 提醒、3 限流、5 暂停）、`new OffenderLog(windowSeconds = 3600, ladder?)`、`.record(user, now)`、`.sanctionFor(count)` | 屡犯升级（本站的示例策略） |

### 红队和偏见（`redteam.ts`）

| 签名 | 说明 |
|---|---|
| `Mutation`（none、spaced、fullwidth、zero-width、newline）、`MUTATION_LABEL`、`mutate(text, mutation)` | 确定性的变形，`normalize` 能把它们还原（测试核对） |
| `AttackCase { id; category; text }`、`runAttacks(cases, defense(text) => blocked, complied(item) => boolean): AttackReport` | 没被拦且模型照做（示例）才算成功；`AttackReport { outcomes; attempts; successes; asr; blockRate; byCategory }`，ASR 和拦截率带 Wilson 区间 |
| `fill(template, values)`、`pairedPrompts(templates, slot, a, b, shared?)` | `{slot}` 模板；只换一个属性的成对提示 |
| `comparePaired(a: number[], b: number[], { seed = 3, iterations = 2000 }): PairedComparison` | `{ diffs; meanDiff; sign; ci; flips }`：配对差、符号检验、平均差的 bootstrap 区间、不一致的对数 |

### 评估（`evals.ts`）

| 签名 | 说明 |
|---|---|
| `Grade { pass; score; reason }` | 一个评分器的结果 |
| `normalizeAnswer(text)`、`exactMatch(actual, expected, { normalize = true })` | NFKC、去首尾空白、合并空白后逐字比较 |
| `regexCheck(text, pattern, { flags = 'u', mustMatch = true })` | 要匹配，或不能出现；带 `match` |
| `parseJson(text)`、`schemaCheck(text, schema)` | JSON 解析（失败给出错误信息）；再按共享包的 `validate` 校验，带 `errors` |
| `ToolCallLike { name; input }`、`ToolExpectation { name: ShopToolName; args? }`、`toolCallCheck(call \| null, expect)` | 工具名、按 `SHOP_TOOL_DEFS[name].input_schema` 校验参数、指定参数的值；带 `problems` |
| `EvalCase<E> { id; input; expected; tags? }`、`Grader<O, E>`、`runEval(cases, outputs: Record<id, O>, grader): EvalReport` | `EvalReport { rows; passed; total; rate; byTag }`，rate 带 Wilson 区间；缺输出抛错 |
| `compareRuns(before: Record<id, boolean>, after): Regression` | `{ before; after; improved; regressed; test }`，test 是精确 McNemar（b 变坏数、c 变好数） |
| `Preference`（A、B、tie）、`PairwiseVerdict { id; original; swapped }`、`unswap(p)`、`positionBias(verdicts): PositionBias` | 交换顺序后换回比较：`{ n; consistent; flipped; flipRate; samePosition; firstPosition }` |
| `Rubric { criteria: { id; text; weight }[]; scale }`、`rubricScore(rubric, scores)` | 每项线性映射到 0–1 再按权重平均；缺项、越界抛错 |
| `judgeAgreement(judge, human, labels?)` | 一致数 `agree` 加 `cohenKappa` 的全部字段 |

### 追踪（`trace.ts`）

| 签名 | 说明 |
|---|---|
| `traceIdOf(seed)`、`spanIdOf(seed)` | 16 / 8 字节的小写十六进制示例 id，不会全 0 |
| `FLAG_SAMPLED`（0x01）、`FLAG_RANDOM`（0x02，Level 2）、`TraceContext { traceId; spanId; flags }`、`formatTraceparent(ctx)` | `00-<trace-id>-<parent-id>-<flags>`，55 个字符 |
| `TRACEPARENT_LAYOUT`、`parseTraceparent(value): ParsedTraceparent` | 每段的区间；按规范检查长度、分隔符、小写、版本 ff、全 0 id，给出 sampled、random |
| `SpanKind`、`SPAN_KIND_CODE`（INTERNAL 1、SERVER 2、CLIENT 3…）、`StatusCode`、`STATUS_CODE`（UNSET 0、OK 1、ERROR 2） | trace.proto 的枚举 |
| `Attr = [key, value \| { int }]`、`int(n)`、`Span { traceId; spanId; parentSpanId; name; kind; start; end; attributes; status }` | 属性按插入顺序；整数要用 `int()` 包起来（导出成 intValue），其余数字是 doubleValue；时间是相对请求开始的毫秒 |
| `new Tracer(traceId, seed)`、`.start(name, kind, parent, start, attrs?)`、`.end(span, end, extra?, status?)`、`.spans` | span id 按开始顺序用 seed + 序号生成 |
| `spanTree(spans): SpanNode[]`、`SpanNode { span; depth; children; self }`、`flattenTree(nodes)` | 父子树（自身耗时 = 总时长 − 子 span 覆盖的时间）；深度优先展开 |
| `GENAI`（属性名常量）、`chatSpanName(model, op = 'chat')`、`chatRequestAttrs(model, maxTokens, server?)`、`chatResponseAttrs(message, ttfcSeconds?)` | 推理 span：名 `chat <模型>`，provider `anthropic`；input_tokens 把缓存读写加回去，缓存读写非 0 才写；finish_reasons 写原样的 stop_reason |
| `toolSpanName(tool)`、`toolAttrs(tool, callId)`、`agentSpanName(agent)`、`agentAttrs(agent, provider?)` | `execute_tool <工具>`、`invoke_agent <名字>` |
| `attrOf(span, key)` | 取属性值（整数返回数字） |
| `anyValue(v)`、`unixNano(ms, epoch = EXAMPLE_EPOCH)`、`otlpTraces(resource, scope, spans)`、`encodeOtlp(body)` | OTLP/JSON：resourceSpans → scopeSpans → spans，lowerCamelCase、十六进制 id、枚举整数、int64 和时间戳写成十进制字符串；`encodeOtlp` 给出字节和区间 |
| `OTLP_HTTP_PORT`（4318）、`OTLP_GRPC_PORT`（4317）、`OTLP_TRACES_PATH`、`otlpHttpRequest(body, host?)` | `POST /v1/traces`，`content-type: application/json`，主机默认 `otel-collector.xiaopu.example:4318`（示例） |
| `rejectionThreshold(p): bigint`、`thValue(T, precision = 4)`、`randomnessOf(traceId)`、`probabilitySample(traceId, p)` | T = (1 − p) × 2^56（精确换算）、tracestate 的 th 写法（OpenTelemetry 文档的 50%、25%、10%、1% 例子核对过）、R = 最右 7 字节、R ≥ T 才采样 |

### 延迟（`latency.ts`）

| 签名 | 说明 |
|---|---|
| `GENAI_DURATION_BUCKETS` | gen_ai.client.inference.duration 等指标建议的 14 个桶边界（秒） |
| `jitter(seed, sigma)`、`ModelTiming { baseMs; perInputMs; perOutputMs; sigma }`、`EXAMPLE_TIMING` | 对数正态抖动；本站假设的三个模型的延迟参数（不是实测） |
| `modelTiming(model, input, output, rand, timing?): CallTiming`、`CallTiming { ttft; total }` | ttft = (base + 输入 × perInput) × 抖动；total = ttft + 输出 × perOutput × 抖动 |
| `simulateCalls(n, model, input, output, seed): LatencyRun` | `{ timings; ttft; total; buckets }`，分位数和按秒分桶 |
| `callCost(model, input, output): Cost` | 只算未缓存输入和输出的费用（纳美元） |

### 监控（`monitor.ts`）

| 签名 | 说明 |
|---|---|
| `RequestRecord { id; traceId; at; user; input; latencyMs; cost; error; flagged; thumbsDown }`、`TrafficOptions`、`simulateTraffic(o)` | 模拟流量：每分钟 perMinute 个，延迟对数正态（σ 0.4），可注入一次事故（延迟倍数、出错率） |
| `windows(records, windowSeconds = 60): WindowStat[]`、`WindowStat { from; count; errors; errorRate; p95; cost }` | 窗口指标 |
| `AlertRule { name; metric: 'errorRate' \| 'p95'; above; forWindows }`、`evaluateAlert(stats, rule): AlertEvent[]` | 连续 forWindows 个窗口超标触发，第一个不超标的窗口恢复 |
| `TailPolicy { baseRate; slowerThanMs }`、`tailSample(record, policy): KeepReason` | 出错、慢、被拦、差评一定留，其余按 trace id 的概率采样 |
| `toEvalCase(record, reason)` | 线上请求 → 评估用例（`prod-<id>`，expected 留给人工，标签记来源和原因） |

### 一次模型调用（`calls.ts`）

| 签名 | 说明 |
|---|---|
| `callModel(request, reply: string \| ContentBlock[], seed, at = 0): ModelCall`、`ModelCall { request; message; cost; http: { request; response } }` | 共享包的 `createMessage`（usage 真实计数）、`costOf`、`messagesHttpRequest` / `Response` 的字节；msg / req id 用 seed（示例） |
| `replyText(message)` | 一条消息的全部文字 |

## 写字节的层（`src/decode/structures.ts`）

每个函数返回一层 `LayerWriter`，`wire(at, view, fidelity, ...layers)` 拼成一个事件的解码结构。检查器开了 `segmentLayers`：每层的 hex 地址从 0 开始。

| 签名 | 说明 |
|---|---|
| `httpHead(name, layout, { mask?, notes?, example?, startNote? })`、`jsonBody(name, json, { root?, expand?, notes?, example?, shown? })`、`utf8Lines(name, text, ...)`、`concept(name, fields)`、`num`、`preview` | 和 CONTEXT、AGENT EXPLORER 相同 |
| `byteOffset(text, index)` | UTF-16 下标 → UTF-8 字节偏移 |
| `segmentsOf(text, spans): Segment[]`、`Segment { from; to; text; hit }` | 按命中区间切成首尾相接的片段，重叠的合并 |
| `textSpans(name, text, segments, { notes? })` | 一段文字的 UTF-8，每个片段一个字段（命中的写标签） |
| `gramBytes(name, contributions)` | 分类器的片段：每个片段的 UTF-8 一个字段，值写桶号和贡献 |
| `traceparentField(name, value, notes?)` | traceparent 的 55 个字节按 version、trace-id、parent-id、trace-flags 切开 |

## 课程的小工具

`src/lessons/common.ts`：`pct`、`prob`（3 位小数）、`messageSegments(text, spans, mark?)`（演示标记单独一段、命中各一段、其余按标点分句）、`messageRow(id, segments, { reveal?, lift?, tone? })`、`contributionRow(id, contributions, { max? })`、`outcomeOf(report)`、`outcomeGrid(id, layers)`。

`src/lessons/scenario.ts`：`MODEL`、`SCREEN_MODEL`、`SYSTEM`、`DEMO_MARK`、`ACCOUNT`、`USER_ID`、`INJECTION_ASK`、`PARAPHRASE_ASK`、`NORMAL_ASK`、`REFUSAL`、`ORDER`、`SIGNED_DAYS`、`dateText`、`NORMAL_REPLY`、`supportRequest(text)`（带 system 和 metadata.user_id）、`screenRequest(text)`、`SCREEN_REPLY`。别的课可以直接用 `supportRequest` 和 `USER_ID`。

`src/lessons/evalset.ts`（评估组四课共用）：三个调用点的 22 条确定性用例 `DET_CASES`（意图分类 `routerRequest`、带四个工具的回答 `replyRequest`、工单 JSON `ticketRequest` 和 `TICKET_SCHEMA`），提示 v1 / v2 下的输出 `OUTPUTS_V1`、`OUTPUTS_V2`（示例），评分函数 `gradeCase(blocks, item, 'strict' | 'fixed')`；12 个开放问题的两版回答 `OPEN`（24 条，`REPLY_KEYS`），评委的提示 `judgeRequest`、`pairRequest`、评分标准 `RUBRIC` 和打分 `JUDGE_V1`、`JUDGE_V2_CHANGED`、成对比较 `PAIRWISE`，三名标注员的标签 `RATERS`、裁决 `adjudicate` / `ADJUDICATED`。分数、理由、标签都是本站写的示例数据，统计和费用在课程文件里真算。

## 增加一节课

1. 新建 `src/lessons/<id>.ts`，导出 `Lesson`，`id` 和 `group` 必须和 `index.ts` 的 `PLANNED` 一致。计算从 `../core` 取，事件里的数一律取自结果。每次模型调用都用 `callModel`，`pk` 的轨迹行是 `[累计费用（纳美元）, 类型, 说明, 字节数]`：调用之前的事件用调用前的累计，响应和之后的事件加上这一次的 `cost.total`。参考 `direct.ts`。
2. 在 `index.ts` 里 import 它，加进 `LESSONS`，顺序和 `PLANNED` 一致。
3. 在 narrative 测试里加这节课的文案核对（safety 组在 `tests/narrative.test.ts`，其中 redteam、bias 在 `narrative.redteam.test.ts`；eval 组在 `narrative.eval.test.ts`，observe 组在 `narrative.observe.test.ts`）：关键的数写死，文字里的说法逐条核对。`tests/lessons.test.ts` 会自动检查步骤数（4–6）、detail 句数（2–4，按 。！？ 数；引用一句话时去掉末尾的标点，见 `direct.ts` 的 `quote`）、节点显示顺序、费用列单调且是整数、字段范围、通道和数据结构是否重叠。
4. e2e 和首页的课数都从 `LESSONS` 取，不用改；`tests/lessons.test.ts` 核对 13 课全部实现、顺序和分组。
5. 文案里用了新的符号（不是中文），先用 `glyphs.py` 一类的脚本确认 Iosevka 22.1.2 里有（没有 ⏎ 和 ⚠，换行用 ↵；①–⑬ 有，已在裁剪脚本的 EXTRA 里），再重新运行字体裁剪脚本。
6. **截图看布局**：单元测试只查设备和数据结构的外接框，查不出文字互相压住。用浅色、深色，1440 宽和 380 宽各看一遍（380 宽时节点名称会按比例放大，最容易压住）。direct 课的经验：数据节点的名称放在图元正下方（`labelAt: [0, 115–150]`），放在左侧时 380 宽会压住表格的格子；同一个数据节点换内容时（比如 message 换成下一条消息）key 用位置（`m0`、`m1`…），格子会原地变化而不是飞来飞去；布局的宽高比在 1.2–1.5 之间（direct 课约 1.3）。

## 核对过的事实（2026-11-07）

### 安全

| 事实 | 来源 |
|---|---|
| OWASP Top 10 for LLM Applications 当前是 **2025** 版：LLM01:2025 Prompt Injection、LLM02 Sensitive Information Disclosure、LLM03 Supply Chain、LLM04 Data and Model Poisoning、LLM05 Improper Output Handling、LLM06 Excessive Agency、**LLM07:2025 System Prompt Leakage**、LLM08 Vector and Embedding Weaknesses、LLM09 Misinformation、LLM10 Unbounded Consumption | <https://genai.owasp.org/llm-top-10/> |
| LLM01 的定义：直接注入是「a user's prompt input directly alters the behavior of the model」，间接注入是模型「accepts input from external sources, such as websites or files」；越狱（jailbreaking）是提示注入的一种；缓解措施的七个标题：约束模型行为、定义并校验输出格式、输入输出过滤、最小权限、高风险操作要人确认、隔离并标出外部内容、对抗测试和攻击模拟 | <https://genai.owasp.org/llmrisk/llm01-prompt-injection/> |
| Anthropic「Mitigate jailbreaks and prompt injections」：两类威胁模型——越狱和直接注入（用户是对手）、间接注入（用户可信，第三方内容里有指令）；建议用 **Claude Haiku 5.5 这样的轻量模型先筛用户输入**，用结构化输出把结果限成一个分类，`stop_reason: "refusal"` 也当作有害；输入校验、提示词里写明边界；对反复试图绕过的用户调整回应、考虑限流或封禁 | <https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks> |
| 同一页的间接注入部分：不可信内容只放在 `tool_result` 里，不放进 system 或用户的文字块；说明内容是什么、从哪来；在 system 里写明它是不可信数据；**尽量 JSON 编码**（转义让攻击者没法闭合引号或标签跳出）；不要把自己的指令放进工具结果；最小权限；工具输出先交给 Haiku 5.5 筛查（schema 字段 `injection_suspected`）；上线前红队测试；持续监控输出 | 同上 |
| Anthropic「Reduce prompt leak」：只在确有必要时才做防泄露的提示工程（会让任务变复杂、降低表现），**先试监控手段**（输出筛查和后处理）；后处理：用正则、关键词过滤输出，也可以用提示过的模型过滤；不需要的专有细节不要放进提示；定期审计 | <https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-prompt-leak> |
| Messages API 的 `metadata.user_id`：「An external identifier for the user who is associated with the request. This should be a uuid, hash value, or other opaque identifier. Anthropic may use this id to help detect abuse. Do not include any identifying information such as name, email address, or phone number.」类型 string 或 null，**maxLength 512** | <https://platform.claude.com/docs/en/api/messages/create> |
| OpenAI Chat Completions 的 `user` 字段**已被取代**：「This field is being replaced by `safety_identifier` and `prompt_cache_key`」；`safety_identifier` 最长 128 个字符，建议哈希用户名或邮箱；`prompt_cache_key` 用于缓存 | <https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create> |
| OpenAI moderation：`POST /v1/moderations`；model 默认 `omni-moderation-latest`，可选 `omni-moderation-2024-09-26`、`text-moderation-latest`、`text-moderation-stable`；响应 `id`、`model`、`results[]`，每项 `flagged`、`categories`、`category_scores`、`category_applied_input_types`；类别键 harassment、harassment/threatening、hate、hate/threatening、illicit、illicit/violent、self-harm、self-harm/instructions、self-harm/intent、sexual、sexual/minors、violence、violence/graphic | <https://developers.openai.com/api/reference/resources/moderations/methods/create> |
| 居民身份证号码：17 位本体码 + 1 位校验码；6 位地址码、8 位出生日期、3 位顺序码（奇数男、偶数女）；校验码 ISO 7064:1983 MOD 11-2，加权因子 Wᵢ = 2^(18−i) mod 11（7 9 10 5 8 4 2 1 6 3 7 9 10 5 8 4 2），a₁₈ = (12 − S mod 11) mod 11，10 写成 X；例子 11010219840406970X、810000199408230021 | <https://zh.wikipedia.org/wiki/中华人民共和国公民身份号码>（GB 11643-1999） |
| Luhn 算法（Hans Peter Luhn，IBM，US 2950048A，1960；ISO/IEC 7812-1:2017 附录 B）：从右往左每隔一位乘 2，大于 9 减 9，校验位 (10 − s mod 10) mod 10；例子 1789372997 → 4 | <https://en.wikipedia.org/wiki/Luhn_algorithm> |
| Spotlighting（Hines 等，Microsoft，2024，arXiv:2403.14720「Defending Against Indirect Prompt Injection Attacks With Spotlighting」）：一族提示工程技术，通过变换输入标出它的来源，帮模型分清多个输入来源；三种：delimiting（在输入前后加特殊标记）、datamarking（在整段文字里穿插一个标记，比如替换空白）、encoding（用 base64 这类公开编码变换输入）。课程只引用名字和 delimiting 的定义，没有引用论文里的攻击成功率 | <https://arxiv.org/abs/2403.14720>、<https://arxiv.org/html/2403.14720v1> |
| HTTP 429 Too Many Requests（RFC 6585 §4）：用户在给定时间里发了太多请求；响应**可以**带 Retry-After 头说明等多久再来（例子 `Retry-After: 3600`）；规范不规定怎样识别用户、怎样计数；429 响应不能被缓存 | <https://www.rfc-editor.org/rfc/rfc6585#section-4> |
| promptfoo 的红队：「plugins generate adversarial inputs, strategies determine how these inputs are delivered」；静态策略有 Base64、Leetspeak、ROT13、Homoglyph、Hex 等，多轮的有 Crescendo、GOAT 等；Base64 策略把用例原文换成 Base64，检查模型会不会解码照做；「The grader is used to determine whether the attack was successful」，`redteam.provider` 同时负责生成攻击和打分（文档没有提 ASR 这个名字） | <https://www.promptfoo.dev/docs/red-team/strategies/>、<https://www.promptfoo.dev/docs/red-team/strategies/base64/>、<https://www.promptfoo.dev/docs/red-team/configuration/> |
| garak：「the LLM vulnerability scanner」（Generative AI Red-teaming & Assessment Kit，NVIDIA）；probes 生成发给模型的交互，detectors 检查模型是否出现某种失败，generators 接模型，harnesses 组织一次运行；探针 `encoding` 是「Prompt injection through text encoding」 | <https://github.com/NVIDIA/garak> |
| PyRIT：Python Risk Identification Tool for generative AI，微软的开源 AI 红队工具；仓库已从 Azure/PyRIT 搬到 microsoft/PyRIT（旧仓库 2026-03-27 归档）；组件有 targets、converters、scorers、memory，scorer 可以是真假、Likert、分类或自定义 | <https://github.com/microsoft/PyRIT>、<https://microsoft.github.io/PyRIT/1.1.0/> |
| Tamkin 等（Anthropic，2023）「Evaluating and Mitigating Discrimination in Language Model Decisions」（arXiv:2312.03689）：70 种决策场景，系统地改年龄、性别、种族（explicit），或用名字隐含种族和性别（implicit）；每个问题是「是 / 否」，「是」对当事人有利；歧视分数是混合效应回归里各人口属性对 p(yes) 的 logit 的系数（基线 60 岁白人男性）；在提示里加「Illegal to discriminate」「Ignore demographics」这类说明能明显降低歧视；数据集公开在 Hugging Face 的 `Anthropic/discrim-eval` | <https://arxiv.org/abs/2312.03689>、<https://arxiv.org/html/2312.03689> |

### 评估和统计

| 事实 | 来源 |
|---|---|
| Cohen's kappa：κ = (po − pe)/(1 − pe)；例子 50 份申请、两人的表 [[20, 5], [10, 15]] → po 0.70、pe 0.50、κ 0.40；Landis 和 Koch（1977）的分档（< 0 没有一致，0–0.20 轻微，0.21–0.40 一般，0.41–0.60 中等，0.61–0.80 相当，0.81–1 几乎完全）并非公认、没有依据；κ 的标准误由 Fleiss 等给出，也可以用 bootstrap | <https://en.wikipedia.org/wiki/Cohen%27s_kappa> |
| Wilson 得分区间的公式；Wald 区间「heavily criticised」，Wilson 可以安全用于小样本和偏斜的比例；Clopper–Pearson 是精确法、偏保守 | <https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval> |
| 测试用的 Wilson 参考值 81/263 → 0.2553–0.3662 | Newcombe RG. Two-sided confidence intervals for the single proportion: comparison of seven methods. Statistics in Medicine 1998;17:857–872（本站的实现在 4 位小数上和它一致） |
| 符号检验：成对观测去掉没有差别的对，W = 差为正的对数，H0 下 W ~ b(n, 0.5)；每对是 0 / 1 时同样的做法叫 McNemar 检验；McNemar 的精确版把 b 和 n = b + c、p = 0.5 的二项分布比较（「The binomial sign test gives an exact test for the McNemar's test」） | <https://en.wikipedia.org/wiki/Sign_test>、<https://en.wikipedia.org/wiki/McNemar%27s_test> |
| McNemar 检验用于「paired nominal data」，只看不一致的两格 b、c（主对角线「do not contribute to the decision」）；「The traditional advice has been to use the exact binomial test when b + c < 25」 | <https://en.wikipedia.org/wiki/McNemar%27s_test> |
| 加权 kappa：κ = 1 − Σ wᵢⱼxᵢⱼ / Σ wᵢⱼmᵢⱼ，对角线权重为 0，常用线性 \|i − j\| 或二次 (i − j)²（Quadratic Weighted Kappa），适合有序类别；均匀权重时等于不加权的 kappa；Cohen's kappa 只用于两名标注员 | <https://en.wikipedia.org/wiki/Cohen%27s_kappa> |
| Fleiss' kappa：固定人数的标注员，但「for each item, raters are randomly sampled」，因此「not suited for cases where all raters rate all patients」；Conger's kappa 要求所有标注员标全部样本；Fleiss' kappa 是 Scott's pi 的推广 | <https://en.wikipedia.org/wiki/Fleiss%27_kappa> |
| Anthropic「Create strong empirical evaluations」：评分方法按「fastest, most reliable, most scalable」挑——代码评分（精确匹配 `output == golden_answer`、字符串包含）最快最可靠，但缺少细微判断；人工评分最灵活、质量最高，但慢而贵，「Avoid if possible」；LLM 评分快而灵活，「Test to ensure reliability first, then scale」。LLM 评分的建议：详细清楚的评分标准、要求具体的输出（只输出 correct / incorrect 或 1–5 分）、让评委开 thinking 先推理再打分；示例代码注释：最好用和生成被评输出不同的模型来评。精确匹配的例子「typically after normalizing whitespace and case」，适合答案是固定类别的任务；设计原则「Prioritize volume over quality」 | <https://platform.claude.com/docs/en/test-and-evaluate/develop-tests> |
| Anthropic 的评估检查清单（LLM 评委）：成对比较有位置偏差，每条随机安排 A / B 或两种顺序都评；冗长偏差（告诉评委篇幅长不加分）；自我偏好（不要用被评的模型给自己打分）；不要告诉评委哪条是基线；评分标准要具体可查，候选文本当作数据而不是指令；先在几十条人工独立标过的用例上量一致率，清楚的用例上远低于约 90% 就先改评委的提示。抽查评分器判不过的用例，超过约十分之一是评分器的错就先修评分器；评分器要看结果而不是路径。两次运行的通过率之差，95% 区间半宽大约是 1/√(用例数 × 重复次数)（25 条 × 2 次约 ±14 个百分点） | claude-api skill（`shared/evals/eval-audit.md`） |
| DeepEval 的 G-Eval：「a framework that uses LLM-as-a-judge with chain-of-thoughts (CoT) to evaluate LLM outputs」，参数 name、criteria（必填）、evaluation_steps（可选，不给就由 criteria 生成）、evaluation_params、threshold（默认 0.5）、model；先用 CoT 生成评估步骤，再按「form-filling paradigm」打分（只在 judge.ts 的注释里提到） | <https://deepeval.com/docs/metrics-llm-evals> |
| 结构化输出：`output_config.format`（JSON 输出）和 `strict: true`（工具参数）保证输出可解析、符合 schema；拒答（`stop_reason: "refusal"`）或撞到 `max_tokens` 时可能不符合 | claude-api skill（`shared/tool-use-concepts.md`） |

### 可观测性

| 事实 | 来源 |
|---|---|
| **GenAI 语义约定已从 semantic-conventions 移到单独的仓库** `open-telemetry/semantic-conventions-genai`，opentelemetry.io 上原来的页面只剩搬家说明；状态 **Development**（不是 Stable） | <https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/>、<https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/README.md> |
| 推理 span：名 `{gen_ai.operation.name} {gen_ai.request.model}`，kind CLIENT；`gen_ai.operation.name` 必填（预定义值 chat、generate_content、text_completion、embeddings、execute_tool、invoke_agent、create_agent、retrieval 等）；Anthropic 的 `gen_ai.provider.name` 必须是 `"anthropic"` 且应在创建 span 时给出；推荐属性 `gen_ai.request.max_tokens`、`gen_ai.response.id`、`gen_ai.response.model`、`gen_ai.response.finish_reasons`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_write.input_tokens`（非 0 时）、`server.address`、`server.port`；流式请求的 `gen_ai.response.time_to_first_chunk`（秒）；出错时 `error.type`；`gen_ai.conversation.id` 只在有现成 id 时写，不能拿 trace id 或新 UUID 充数；输入输出消息、system 指令是 Opt-In | <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md>、<https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md> |
| **Anthropic 的 input_tokens 不含缓存**，约定要求 `gen_ai.usage.input_tokens = input_tokens + cache_read_input_tokens + cache_write_input_tokens` | 同上（anthropic.md 的注 22、23、27） |
| 工具 span：名 `execute_tool {gen_ai.tool.name}`，kind INTERNAL，`gen_ai.operation.name` 是 `execute_tool`，`gen_ai.tool.name` 必填，`gen_ai.tool.call.id`（条件必填，取模型给的 id）、`gen_ai.tool.type`（function、extension、datastore）；参数和结果是 Opt-In | <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/execute-tool.md> |
| Agent span：进程内的 invoke_agent 名 `{gen_ai.operation.name} {gen_ai.agent.name}`，kind INTERNAL | <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md> |
| 客户端推理指标（**名字和以前不同**）：`gen_ai.client.inference.duration`、`gen_ai.client.inference.time_to_first_chunk`、`gen_ai.client.inference.time_per_output_chunk`（直方图，单位 s，建议桶 0.01, 0.02, 0.04, …, 81.92 共 14 个）；token 指标是 `gen_ai.client.inference.usage.input_tokens` 等计数器；`gen_ai.client.operation.duration` 不再用于推理 | <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md>、<https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md> |
| Claude 自己的 OpenTelemetry 导出（beta）：SDK 和 API 的 span 叫 `anthropic.messages.create`（SDK 是 CLIENT、API 是 SERVER），API 里还有 `anthropic.model_request`、工具 span；属性按 GenAI 约定；**API 读请求的 traceparent，sampled 标志关着时不产生 span** | claude-api skill（`shared/opentelemetry.md`） |
| W3C Trace Context（**Recommendation，2021-11-23**）：`traceparent` 版本 00 是 `version-trace-id-parent-id-trace-flags`，trace-id 32 位、parent-id 16 位、flags 2 位小写十六进制；全 0 的 id 无效，版本 ff 无效；flags 最低位是 sampled；例子 `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`；tracestate 最多 32 项，应至少传 512 个字符 | <https://www.w3.org/TR/trace-context/> |
| Trace Context **Level 2**（候选推荐草案，2024-03-28）：flags 第二位 `random-trace-id`，置位时 trace-id 至少右边 7 个字节必须随机；继续一个 trace 时原样传下去 | <https://www.w3.org/TR/trace-context-2/> |
| OTLP 1.11.1（trace、metric、log 是 Stable）：JSON 编码的字段名用 lowerCamelCase，traceId / spanId 是十六进制字符串（不是 base64），枚举写整数，64 位整数（含 fixed64 时间戳）写成十进制字符串（解码时数字也接受）；Content-Type `application/json` 或 `application/x-protobuf`；traces 默认路径 `/v1/traces`；OTLP/HTTP 默认端口 4318、gRPC 4317 | <https://opentelemetry.io/docs/specs/otlp/> |
| trace.proto：Span 字段 trace_id、span_id、trace_state、parent_span_id、flags、name、kind、start_time_unix_nano、end_time_unix_nano、attributes、events、links、status；SpanKind 0–5（UNSPECIFIED、INTERNAL、SERVER、CLIENT、PRODUCER、CONSUMER）；StatusCode 0 UNSET、1 OK、2 ERROR；AnyValue 的 string_value、bool_value、int_value（int64）、double_value、array_value 等 | <https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto>、`common/v1/common.proto` |
| metrics.proto 的显式桶：第 i 个桶 (bᵢ₋₁, bᵢ]，上界包含，最后一个到 +∞；bucket_counts 比 explicit_bounds 多一个 | `opentelemetry/proto/metrics/v1/metrics.proto` |
| 采样：SDK 默认 `ParentBased(root=AlwaysOn)`；`TraceIdRatioBased` 的算法「was never specified」，已弃用，改用 `ProbabilitySampler`（Development）：随机值 R 一般取 trace id 最右 7 个字节，拒绝阈值 T = (1 − p) × 2^56，R ≥ T 才采样，tracestate 写 `ot=th:<T 的十六进制，去掉末尾的 0>`；例子 10% → `e666`（4 位精度）、1% → `fd71` / `fd70a` / `fd70a4`（4、5、6 位） | <https://opentelemetry.io/docs/specs/otel/trace/sdk/>、<https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/> |
| 头部采样尽早决定、不看整个 trace，单靠它「cannot ensure that all traces with an error within them are sampled」；尾部采样看过 trace 的全部或大部分 span 再决定（例：总留出错的、按整体延迟留），实现它的组件要是能接收并存下大量数据的有状态系统，Collector 有 Tail Sampling Processor | <https://opentelemetry.io/docs/concepts/sampling/> |
| Claude API 的 OpenTelemetry 导出（beta）可以发到 Langfuse、LangSmith、Arize、Braintrust、Datadog 等任何收 OTLP/HTTP 的后端；文档列的用途包括调试失败或慢的请求、跟踪 token 花费和延迟、「build evals from real traffic」。各产品自己的数据集、评估功能名本站没有核对，课程只在注释里提产品名（Helicone 没有核对，不提） | claude-api skill（`shared/opentelemetry.md`） |

### 模型和价格

| 事实 | 来源 |
|---|---|
| 模型 id `claude-opus-5-5`（$4 / $20 每百万 token）、`claude-haiku-5-5`（$0.10 / $0.50，提示不超过 100K 那一档）；stop_reason 有 `refusal`（安全分类器拒绝，HTTP 200） | 照抄 CONTEXT、AGENT EXPLORER 的事实表（`packages/llm-core/src/pricing.ts`）；claude-api skill |

没有核对、以示例或本站写法对待的：注入和审核的数据集、规则、阈值、处置策略（本站自写，不冒充任何基准或产品）；金丝雀串和「连续 12 个字算泄露」（本站写法）；HMAC 的密钥和截成 32 位的写法；屡犯升级的次数；限流的容量；延迟参数和流量模拟；`thValue` 在阈值很小（前导 0）时怎样数精度（本站按 14 位定长四舍五入，只核对了文档的四个例子）；GenAI 约定没有给 Anthropic 的 stop_reason 到 finish_reasons 的映射（本站原样写）；Llama Guard 等其他审核模型的类别（没有核对，课程里不要写）。

## 共享包

需要 Messages API、token 计数、计费、JSON、HTTP、示例 id、小铺的场景数据、JSON Schema 校验、令牌桶、SHA-256 时，一律从 `packages/llm-core`（`@explorer/llm-core`）导入，不在本模块复制。为这门课往共享包里搬了、加了这些（原模块的课程数字和测试不变，agent、context 的单元测试和 e2e 都通过）：

- `schema.ts`：AGENT 的 JSON Schema 子集校验，原样搬过去，agent 的 `src/core/schema.ts` 改成转导出（确定性评估的 Schema 校验、工具调用核对用）；
- `shop.ts`：AGENT 的小铺场景数据，原样搬过去，agent 的 `src/core/shop.ts` 改成转导出；四个工具给模型看的定义（name、title、description、input_schema、hints）也搬进来叫 `SHOP_TOOL_DEFS`，agent 的 `tools.ts` 用 `...SHOP_TOOL_DEFS.get_order` 加上自己的 `run`，字段顺序不变（工具调用核对用）；
- `ratelimit.ts`：CONTEXT 的 `retry.ts` 里的 `TokenBucket`，原样搬过去，context 的 `retry.ts` 改成导入并转导出（每用户限流用）；
- `hash.ts` 加了 `fnv1a32`（特征哈希用，不用 BigInt，快得多）；
- `sha256.ts`（新）：SHA-256、HMAC-SHA256、`toHex`，测试用 node:crypto 核对（user_id 用）。

`scene/ds.ts`、`scene/plugin.ts` 和 llm、context、rag、agent 的同名文件逐字相同，`decode/structures.ts` 里的 `httpHead`、`jsonBody`、`utf8Lines`、`concept` 和 CONTEXT、AGENT 的写法相同：这是系列的约定（每个模块的场景和写字节层各一份），没有抽成共享包。

## 已知的简化和待办

- 模型写什么是脚本（示例）：客服的回答、筛查模型的判断、以后评委的理由和「模型照没照做」都不是真实生成的；围绕它的一切（检测、统计、token、费用、字节）真实计算。
- 检测器和审核分类器是教学用的玩具：几十条自写样本、1,024 个桶的哈希 n-gram 逻辑回归，学到的东西有一部分是巧合（direct 课明说「你」「的」这类片段贡献最大）；指标在 28 条测试样本上算，区间很宽。真实产品用大得多的数据和模型。
- 延迟全部是模拟（固定种子的对数正态抖动 + 本站假设的固定开销和每 token 耗时），只用来演示长尾和分位数，不代表任何模型的实测；流量、事故也是模拟。
- token 数只代表量级关系（见「本站约定」）；不模拟 thinking 块（Claude Opus 5.5 默认开着自适应思考，真实响应里还会有 thinking 块和对应的输出 token）。
- 筛查模型的费用只按提示和回答的 token 估算，没算结构化输出（`output_config`）可能带来的额外 token。
- OTLP 只实现 JSON 编码（没有 protobuf 的二进制编码），只实现 traces（指标用直方图桶的计算，没有导出 metrics 的 JSON）；span 没有 events 和 links。
- HTTP 统一按 HTTP/1.1 展示，头名小写。
- 评估组（deterministic、judge、human、regression）：22 条确定性用例、24 条回答、三名标注员的标签都是本站自写的小样本，通过率、kappa 的区间很宽，不冒充任何基准；每条用例只跑一次，没有模拟真实模型的输出随机性（回归课提到要多跑几次）；评委不模拟 thinking 的 token（文档建议评委开 thinking，真实费用更高）；评委打分的阈值（≥ 0.75 好、≥ 0.5 可接受）和标注指南是本站定的；回归课的「改前」沿用 deterministic 课那次运行的结果，不重复计费。
