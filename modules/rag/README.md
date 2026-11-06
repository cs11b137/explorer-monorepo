# RAG Explorer

用交互动画讲一个问题怎样找到它的答案：文字怎样变成向量，向量库怎样在很多向量里快速找到最近的几个（Flat、IVF、HNSW、PQ），关键词和向量怎样混合，检索到的段落怎样拼进提示、变成带引用的回答，又怎样评估。嵌入向量、相似度、索引结构、检索结果、召回率和评估指标全部由 `src/core/` 真实计算；模型「说出来的话」无法真实生成（本站不跑大模型），作为示例写死并标 E.G.，但围绕它的提示、token 数、引用核对都真实计算。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。和 LLM EXPLORER、CONTEXT EXPLORER 是同一系列、同一套约定；知识库就是 CONTEXT EXPLORER 上下文工程组里那家网店「小铺」的规则（订单 A1024、漏水的保温杯），这门课讲的是那个客服 Agent 的 `search_docs` 工具背后发生了什么。

## 开发

本模块由主站统一提供服务，地址是 `/modules/rag/`。启动和构建在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test                 # 本模块的单元测试
python scripts/subset-fonts.py <woff2 目录>  # 按本站字符重新裁剪 Iosevka（需要 fonttools、brotli），字体源见脚本开头
```

端到端测试在仓库根目录：`npx playwright test --project=rag`。

## 结构

- `src/core/`：计算核心，纯 TypeScript，确定性（随机数全部来自固定种子）。接口见下文。
- `src/lessons/`：每节课一个文件。`index.ts` 的 `PLANNED` 是 14 节课的顺序和分组（现在只实现了 `embedtext`，其余的课还没放进 `LESSONS`）；`types.ts` 是节点、事件和图元的类型；`dsl.ts` 是写事件的简写；`common.ts` 是画格子、画向量和相似度表的小工具。
- `src/decode/`：可信度（`writer.ts`）和按真实格式写字节的层（`structures.ts`）。
- `src/scene/`：`devices.ts` 是设备节点的图形，`ds.ts`、`plugin.ts` 和 llm、context 相同（数据结构图元的几何和帧间动画，含 `heat` 热力图）。
- `tests/`：`core.test.ts` 核对计算核心（期望值手写或用 Float32Array、Buffer、JSON.stringify 这类独立实现核对）；`decode.test.ts` 核对写字节的层；`lessons.test.ts` 检查每节课的结构和布局；`narrative.test.ts` 核对 embedtext 课的文案和计算结果；`player.test.ts` 检查播放器。
- `e2e/app.spec.ts`：端到端测试，课程清单取自源码。
- 分词器、BM25、JSON、HTTP、随机数、浮点位模式不在本模块，在共享包 `packages/llm-core`（`@explorer/llm-core`），见下文「共享包」。

## 本站约定

**抽象层级（顶栏 7 档）**：文档、分块、向量、索引、检索、提示、回答。一个问题找到答案，要从原始文档开始，切成块、变成向量、建索引、检索、拼进提示，最后变成回答。这是本站的教学约定，不是业界标准分层。每节课用 `layer: [lo, hi]` 标出跨了哪几档，`layerNote` 写一句为什么（以句号结尾）。

**距离列（轨迹表第二列，`Row.dist`）**：到这个事件为止，这一课累计的**距离计算次数**。记账规则在 `core/meter.ts`，全站统一：

- 拿一个向量（查询，或建索引时正在插入的向量）和另一个完整向量（数据点、质心）比较一次，记 1 次，不管是点积、余弦还是欧氏距离；
- PQ：算 ADC 距离表时 M 个子空间各和 ksub 个子质心比较，总计算量等于 ksub 次完整距离，记 ksub 次；之后每个码查表求和得到一个近似距离，记 1 次；
- 重排序器给一对（查询，段落）打一次分，记 1 次；
- BM25、切分、拼提示、生成不涉及向量距离，记 0。

必须单调不减（测试检查），不能手写，从 `DistanceMeter` 或计算结果（`computed`、`distances`）取。每节课用 `distNote` 写一句这课具体累计了什么（以句号结尾），会拼进表头提示。字节数放在最后一列「大小」（`Row.size`）。

选它而不选「累计 token」或「累计浮点运算」，是因为距离计算次数正是向量检索的核心成本：暴力搜索是 N 次，IVF 是 nlist + 被扫的向量数，HNSW 是走过的节点数，PQ 是一张表加 N 次查表——几种索引的差别直接体现在这一列上（FAISS 的统计里也叫它 ndis）。它是整数、可以精确核对；浮点运算会让维度和实现细节（SIMD、是否开方）混进来，token 数则和索引组的课无关。代价是嵌入、切分、拼提示这些步骤这一列不动（记 0），这些课的成本在「大小」列和文案里讲。

**可信度（检查器顶部，`Fidelity`）**：
- `format`：公开规范或 API 文档定义的真实字节：IEEE 754 float32 / float16 小端、UTF-8、JSON、HTTP/1.1、base64（RFC 4648）、uint8 的 PQ 码字、int32 token id，以及嵌入 API、Messages API 文档里的字段。
- `internal`：某个实现的内部布局，真实但会随版本变化：FAISS / hnswlib 的倒排表、邻接表在内存里怎么摆，本站嵌入模型的嵌入表，本站 int8 量化的写法（float32 缩放系数在前、每个分量一个 int8）。
- `示意`：只讲概念，没有字节（`concept()` 层）。

**示例值（E.G.）**：每次都不同的值（request id、密钥）、模型写的内容，以及「真实服务会给出不同数值」的字段（嵌入 API 响应里的 embedding 数值和 usage：数值是本站 16 维模型算的，token 数是本站 BPE 数的），字段加 `example: true`，界面显示 E.G.。密钥打码写成未知字节（`LayerWriter.unknown`），hex 里显示 `··`。

**token 数的口径**：和 CONTEXT EXPLORER 相同，是迷你 BPE 分词器（96 条合并规则）的真实计数，只代表量级关系，真实模型的分词器不同。课程文案里要说明。

**配色**（`common.ts` 的 `PART_TONE`，全站统一）：问题和查询 blue，文档和块 teal，向量 violet，检索结果 amber，提示里的说明和协议开销 slate，模型的回答 green。向量画成一排热力格子（`vectorRow`）：正分量用向量的颜色，负分量用 amber，热度是 |x| / 最大绝对值。

**数值**：向量按 fp32 存（`Math.fround`），累加在 float64 里做，和 LLM EXPLORER 一致，所以检查器里展示的 float32 字节就是计算真正用到的值。文案里的余弦用两位小数（`fixed`），不写成 −0.00。

### 嵌入方法：在知识库上训练的 16 维 LSA

`core/embed.ts`。训练：段落切词（和 BM25 同一套：汉字二元组、小写的字母数字词）→ 词 × 段落的 tf-idf 矩阵 A（w = (1 + ln tf) · ln(N / df)）→ 对 Gram 矩阵 AᵀA 做 Jacobi 特征分解，取最大的 16 个特征值 → 每个词的向量 u = A[词] · v / σ（截断 SVD 的 U）。嵌入：切词 → 查表 → 按权重加权平均（池化）→ L2 归一化；词表外的词丢掉。

为什么选它：

- **确定**：训练就是一次矩阵分解，没有随机初始化和学习率，逐位可复现，浏览器里几毫秒；
- **有语义**：从「哪些词常在同一段出现」学到相近的意思。「保温杯漏水了怎么办？」和「杯盖渗水该怎么处理？」没有一个共同的有效词（BM25 给 0 分），余弦却是 0.65；
- **小**：16 维，一个向量 64 字节，能逐字节展示。

没选的两个候选：字符 n-gram 哈希加随机投影只看字面，和 BM25 是同一类，讲不出向量检索的长处（混合检索课正需要两者互补）；skip-gram 在二十几段文字上训练太噪，结果太依赖种子。真实的嵌入模型（OpenAI text-embedding-3、Voyage）是在海量语料上训练的 Transformer，上千维，词表外的说法也懂；本站只演示机制（文字 → 定长向量 → 归一化 → 比余弦），课程文案里要说明。

`tests/core.test.ts` 锁住的数：

| 一对问题 | 余弦 |
|---|---|
| 保温杯漏水了怎么办？ / 杯盖渗水该怎么处理？（同义） | 0.652 |
| 退款多久能到账？ / 钱什么时候退回来？（同义） | 0.714 |
| 保温杯漏水了怎么办？ / 怎么开发票？（无关） | 0.010 |
| 杯盖渗水该怎么处理？ / 怎么开发票？（无关） | −0.004 |

评估问题（`EVAL_SET` 的 8 个问题）用暴力检索取前 3 个，找到 12 个标注的相关段落里的 11 个。维度选 16 是试出来的：8 维时同义更近但检索召回掉到 0.75，24 维时同义对降到 0.6 以下。

### 知识库（`core/kb.ts`）

网店「小铺」的 12 篇文档、27 个段落：《售后规则》（4 条，第 3 条是 CONTEXT EXPLORER 的原文）、《退款说明》、已作废的《退款说明（2025 版）》（到账时间和现行版本冲突，`meta.status = 'archived'`，失败案例和元数据过滤课用）、《运费说明》、《配送说明》、两个商品页（真空保温杯 BW-350，配件密封圈 SR-35；电热水壶 KT-15）、《保修政策》、《发票说明》、《会员积分》、《优惠券规则》、《联系客服》。每篇有 `meta`（分类、更新日期、状态）。段落是嵌入模型的训练单位，也是检索课默认的「块」（`PARAGRAPHS`、`PARAGRAPH_VECTORS`）。

`EVAL_SET`：8 个评估问题，每个有人工标注的相关段落和参考答案里的关键事实，评估课用，别的课也可以从里面挑问题。

改知识库会改变嵌入模型和所有课程的数字：改完跑测试，按报错改文案。

## 节点

`src/lessons/types.ts` 的 `NODE_IDS`，一次设计好全部课程会用到的节点，每节课在 `nodes` 里挑自己要的。设备节点有固定图形，可以挂状态面板（每个最多 4 行）；数据节点没有外形，长相就是课程给它的图元，不能挂状态面板。

| 节点 | 类型 | 用途 |
|---|---|---|
| `app` | 设备 | 应用：问答界面或客服 Agent，发出问题、显示带引用的回答。带屏幕（`render` 逐行画出），命令框（`type`）挂在它上方 |
| `docs` | 设备 | 文档库：原始文档和元数据（分类、更新日期、状态） |
| `loader` | 设备 | 加载器：读文档、去格式、抽正文和元数据 |
| `chunker` | 设备 | 切分器：固定长度、按句或递归切分，可以带重叠 |
| `embedder` | 设备 | 嵌入模型 / 嵌入 API：文字 → 定长向量（本站 16 维 LSA；真实服务如 OpenAI、Voyage） |
| `index` | 设备 | 向量库：存向量和 id，建索引（Flat、IVF、HNSW、PQ），找最近的 k 个 |
| `meta` | 设备 | 元数据过滤器：前过滤 / 后过滤 |
| `bm25` | 设备 | 关键词索引：倒排表加 BM25 打分 |
| `reranker` | 设备 | 重排序器：逐对（查询，段落）打分重排（真实的是交叉编码器） |
| `llm` | 设备 | 大模型：读提示、写带来源编号的回答，或改写查询（内容是示例） |
| `evaluator` | 设备 | 评估器：context precision / recall、faithfulness |
| `request` | 数据 | 请求：HTTP 头和 JSON 请求体的字段 |
| `response` | 数据 | 响应：JSON 响应体的字段 |
| `text` | 数据 | 一篇文档或一个问题的原文和 UTF-8 字节 |
| `chunks` | 数据 | 切好的块：字符区间、token 数、重叠 |
| `tokens` | 数据 | 切出来的词（汉字二元组）、认不认识、权重 |
| `vectors` | 数据 | 向量：词向量、池化后、归一化后，或一批段落的向量 |
| `query` | 数据 | 查询：问题（或改写后的问题）和查询向量 |
| `space` | 数据 | 向量空间：平面投影的点、IVF 的质心和簇、HNSW 的分层图 |
| `codes` | 数据 | 码：float16、int8、PQ 的 uint8 码字，PQ 码本和 ADC 距离表 |
| `results` | 数据 | 向量检索的前 k 个 |
| `keywords` | 数据 | BM25 的前 k 个和命中的词 |
| `fused` | 数据 | RRF 融合后的排名，或重排序后的排名 |
| `prompt` | 数据 | 提示：说明、带编号的资料、问题，每部分的 token 数 |
| `answer` | 数据 | 回答（示例）：每句标的来源编号和核对结果 |
| `scores` | 数据 | 分数和指标：相似度矩阵、召回率、评估指标 |
| `truth` | 数据 | 标注：评估问题、相关段落、关键事实 |

图元（`Prim`）和 llm、context 相同：`row`、`grid`、`graph`、`ring`、`tower`，格子可以带 `heat`（0–1）画热力图。向量空间建议用 `graph`（节点是向量的平面投影，边是 HNSW 的邻居或簇的归属）。轨迹表「类型」列的取值见 `TraceType`（CALL、HTTP、JSON、LOAD、CHUNK、TOKENS、EMBED、VECTOR、TRAIN、INDEX、SEARCH、KEYWORD、FILTER、FUSE、RERANK、PROMPT、INFER、CITE、EVAL）。

## 计算核心接口（`src/core/`）

全部从 `src/core/index.ts` 导出：`import { embed, flatSearch, buildIvf, buildHnsw, trainPq, rrf, buildPrompt, ... } from '../core'`。共享包的 `bm25`、`termsOf`、`encodeJson`、`spanOf`、`encodeRequest` 等也一并转导出。

### 知识库（`kb.ts`）

| 签名 | 说明 |
|---|---|
| `KB: readonly KbDoc[]`、`KbDoc { id; title; meta; paragraphs }`、`DocMeta { category; updated; status }` | 12 篇文档；`category` 是 售后 / 退款 / 物流 / 商品 / 账务 / 会员 / 客服，`status` 是 current / archived |
| `PARAGRAPHS: readonly Paragraph[]`、`Paragraph { id; doc; index; title; text; meta }` | 27 个段落，id 写成 `文档 id#序号`（如 `aftersale#2`） |
| `paragraphById(id)`、`docById(id)`、`docText(doc)` | 按 id 取；整篇文档的全文（段落之间换行，切分课的输入） |
| `EVAL_SET: readonly EvalItem[]`、`EvalItem { id; question; relevant; facts }` | 8 个标注好的评估问题 |
| `SHOP`、`ORDER_ID` | 「小铺」、`A1024` |

### 切分（`chunk.ts`）

| 签名 | 说明 |
|---|---|
| `interface Chunk { index; text; from; to; byteFrom; byteTo; tokens; overlap }` | 字符区间（码点下标，左闭右开）、UTF-8 字节区间、本站 BPE 的 token 数、和上一块重叠的字符数；首尾空白去掉 |
| `fixedChunks(text, size, overlap = 0): Chunk[]` | 固定长度的滑动窗口，步长 size − overlap，最后一块到结尾 |
| `sentenceSpans(text)`、`sentences(text): Chunk[]` | 按句末标点（。！？；）和换行切，标点留在句子里 |
| `recursiveChunks(text, { size, overlap?, separators? }): Chunk[]` | 仿 LangChain 的 RecursiveCharacterTextSplitter：先按换行切，超长的再按 。、，、单字切；相邻小片段贪心合并到不超过 size；新块从上一块末尾带上不超过 overlap 的完整片段。分隔符留在片段末尾 |
| `paragraphChunks(text)`、`DEFAULT_SEPARATORS`、`countTokens(text)` | 一段一块；默认分隔符 `['\n', '。', '，', '']`；token 计数 |

### 嵌入（`embed.ts`，算法见上文）

| 签名 | 说明 |
|---|---|
| `EMBED_DIM`（16）、`EMBEDDER: EmbedModel` | 全站共用的模型，在 `PARAGRAPHS` 上训练 |
| `interface EmbedModel { dim; docs; vocab; df; idf; table; sigma; sweeps }` | 词表 480 个词；`table` 是嵌入表（词 → 16 维 fp32）；`sigma` 是奇异值 |
| `trainEmbedder(texts, dim = 16): EmbedModel` | 训练（确定性） |
| `embed(text, model?): EmbedTrace` | 带过程的嵌入：`terms`（全部词）、`known`（`TermHit { term; tf; idf; weight; vector }`）、`unknown`、`pooled`（加权平均，fp32）、`norm`、`vector`（归一化，fp32；一个词都不认识时是零向量） |
| `embedVector(text)`、`termVector(term)`、`termWeight(tf, idf)`、`tableBytes()` | 只要向量；查一个词；权重 (1 + ln tf) · idf；嵌入表字节数 |
| `PARAGRAPH_VECTORS: readonly Vec[]` | 全部段落的向量，和 `PARAGRAPHS` 一一对应 |

### 向量和字节（`vector.ts`）

| 签名 | 说明 |
|---|---|
| `dot`、`norm`、`normalize`（fp32）、`cosine`、`l2sq`（平方欧氏）、`l2` | 基础运算，维度不一致时报错 |
| `type Metric = 'ip' \| 'cosine' \| 'l2'`、`metricValue(metric, a, b)`、`closeness(metric, a, b)` | 度量的原始值；排序键（越大越近，l2 取负） |
| `relation(a, b): { dot; cosine; l2sq; unit }` | 三种度量，以及是不是都是单位向量（单位向量时 l2sq = 2 − 2·dot） |
| `f32VectorBytes`、`f16VectorBytes`、`f16RoundTrip`、`f32FromVectorBytes` | IEEE 754 小端字节和往返 |
| `quantizeInt8(v): { codes; scale }`、`dequantizeInt8`、`int8Bytes`、`BYTES_PER_DIM` | 对称 int8：scale = absmax / 127（本站写法，internal） |
| `base64Encode(bytes)`、`base64Decode(text)` | RFC 4648 |
| `f32Json(x)` | fp32 值在 JSON 里的最短十进制写法（读回 fp32 不变） |

### 线性代数（`linalg.ts`）

`jacobiEigen(S, tolerance?, maxSweeps?): { values; vectors; sweeps }`：对称矩阵的循环 Jacobi 特征分解，特征值从大到小，特征向量单位长度、绝对值最大的分量为正。

### 距离计数（`meter.ts`）

`class DistanceMeter { total; by: Record<DistanceKind, number>; add(kind, n = 1) }`，`DistanceKind` 是 `query` / `build` / `centroid` / `train` / `adc-table` / `adc` / `rerank`。记账规则见「本站约定」。

### 暴力 kNN（`flat.ts`）

| 签名 | 说明 |
|---|---|
| `interface Hit { id; score }` | id 是向量在数据集里的下标；score 是度量的原始值 |
| `flatSearch(vectors, query, k, metric = 'ip', meter?, ids?): { hits; scores; computed }` | 精确搜索，算 N 次（或 `ids` 给定的前过滤候选数）距离，记 query |
| `topK(metric, scores, k, ids?)`、`closer(metric, a, b)` | 排序取前 k（同分按下标）；比较 |
| `scanTopK(metric, scores, k, ids?): HeapStep[]` | 按下标顺序扫描、用装 k 个的堆维护前 k 个，每步记 push / replace / skip 和堆的内容（不另算距离，结果和 `topK` 相同） |

### k-means（`kmeans.ts`）

| 签名 | 说明 |
|---|---|
| `kmeans(vectors, k, { iters = 20, seed = 1, meter?, kind = 'train' }): KMeansResult` | Lloyd 算法：固定种子不放回抽 k 个初始质心；每轮 N × k 次距离；空簇保留旧质心；没人换簇就停。`KMeansResult { k; init; centroids; assign; iterations; sizes }`，每轮 `KMeansIteration { centroids; assign; inertia; moved }` |
| `sampleIndices(n, k, seed)`、`nearest(centroids, v): { index; dist }` | 抽样；最近的质心 |
| `new CentroidFinder(centroids)`、`.find(v, offset = 0): number`、`.dist` | 批量找最近的质心（k-means 的分配步、`pqEncodeAll` 用）：质心按第 0 维排序，跳过 t₀² 已经大于当前最小距离的质心；下标和距离与逐个 `nearest` 逐位相同 |

### IVF（`ivf.ts`）

| 签名 | 说明 |
|---|---|
| `buildIvf(vectors, nlist, { iters?, seed?, meter? }): IvfIndex` | 训练质心（记 train）、把每个向量放进最近质心的倒排表（N × nlist，记 build）。`IvfIndex { nlist; centroids; lists; listOf; train }` |
| `ivfSearch(index, vectors, query, k, nprobe, meter?): IvfSearch` | 先比 nlist 个质心（记 centroid），扫最近的 nprobe 个倒排表（记 query）。返回 `centroidDist`、`probed`、`scanned`、`scores`、`hits`、`computed { centroids; vectors }`。nprobe = nlist 时等于暴力搜索 |

### HNSW（`hnsw.ts`）

| 签名 | 说明 |
|---|---|
| `buildHnsw(vectors, { M, efConstruction, seed?, mL?, select? }, meter?): HnswGraph` | 按 0..N−1 的顺序插入。层数 ⌊−ln(U)·mL⌋，mL 默认 1/ln(M)；第 0 层度数上限 2M，其余 M；选邻居默认论文算法 4 的启发式（`select: 'simple'` 是取最近的 M 个） |
| `HnswGraph { M; Mmax0; efConstruction; mL; select; levels; neighbors; entry; maxLevel; inserts }` | `neighbors[layer].get(node)` 是邻居表；`inserts` 是每次插入的记录 |
| `InsertTrace { node; level; entry; maxLevel; visits; links; newEntry; distances }` | 一次插入：每层的搜索（`LayerVisit { layer; entry; visited[{ node; dist }]; result }`）、每层选中的邻居和被剪掉的边、距离数 |
| `hnswSearch(graph, vectors, query, k, ef, meter?): { visits; hits; computed }` | 上层 ef = 1 贪心下降，第 0 层 ef 个候选（至少 k） |
| `drawLevels(n, mL, seed)`、`emptyHnsw(levels, options)`、`insertHnsw(graph, vectors, node, meter?)`、`edgesOf(graph, layer)` | 单独抽层数、逐个插入（做插入动画用）、某一层的无向边 |

### PQ（`pq.ts`）

| 签名 | 说明 |
|---|---|
| `trainPq(vectors, m, ksub, { iters?, seed?, meter? }): PqCodebook` | 切 m 段，每段单独 k-means（种子 seed + j）。`PqCodebook { d; m; dsub; ksub; centroids[j][c]; train }`；ksub ≤ 256 |
| `pqEncode(cb, v): number[]`、`pqDecode(cb, codes)`、`subvector(v, j, dsub)` | 编码成 m 个 uint8；解码；第 j 段 |
| `adcTable(cb, query, meter?)`、`adcDistance(table, codes)` | ADC 距离表 m × ksub（记 ksub 次 adc-table）；查表求和。`adcDistance` 等于查询到解码向量的平方距离（测试核对） |
| `pqSearch(cb, codes, query, k, meter?): { table; distances; hits }` | 建表一次，每个码查一次（记 adc） |
| `pqBytes(cb): { raw; code; codebook }` | 原始向量、一个码、整个码本的字节数 |
| `pqEncodeAll(cb, vectors, meter?)`、`pqPackedBytes(cb)` | 批量编码（每个向量记 ksub 次 build，和 ADC 表同一口径）；FAISS 按位紧挨着存时一个码的字节数 ⌈M × log2(ksub) / 8⌉ |

### 规模实验的合成数据（`bench.ts`）

`BENCH_VECTORS`：1000 个合成向量，第 i 个 = 第 (i mod 27) 个段落向量 + 每个分量标准差 0.12 的高斯噪声（种子 7），再归一化；`benchVectors(n, sigma, seed)` 可以另造。`BENCH_QUERIES` 是 8 个评估问题的查询向量，`BENCH_TRUTH` 是它们在合成数据上暴力搜索的前 `BENCH_K`（10）个。向量检索组每课最后一步都在它上面比距离次数、召回率和字节数（示例数据，课程里说明）。

### 召回率、过滤、混合检索（`hybrid.ts`）

| 签名 | 说明 |
|---|---|
| `recallAtK(found, truth, k)`、`meanRecall(pairs, k)`、`exactTopK(vectors, query, k, metric?)` | ANN 的召回率@k = \|前 k 个 ∩ 暴力搜索的前 k 个\| / k；暴力搜索的标准答案（不记距离） |
| `filteredSearch(vectors, query, k, allow, 'pre' \| 'post', metric?, meter?): FilteredSearch` | 前过滤先筛后搜（拿满 k 个）；后过滤先取前 k 再筛（可能不够 k 个）。返回 `allowed`、`searched`、`beforeFilter`、`hits`、`computed` |
| `bm25Search(docs, query, k): { ranked; scored }`、`rankedOf(hits, idOf)` | BM25 的前 k 个（分数 > 0）；向量结果写成同样的 `RankedDoc { id; score; rank }` |
| `rrf(lists, k = RRF_K): FusedDoc[]`、`RRF_K`（60） | score = Σ 1/(k + rank)，rank 从 1 开始；`FusedDoc { id; score; ranks; parts; rank }` |

### 重排序（`rerank.ts`）

| 签名 | 说明 |
|---|---|
| `crossScore(query, passage, meter?): CrossScore` | 本站的交叉打分替身：0.5 × 嵌入余弦 + 0.5 × 查询词的 idf 覆盖率（`RERANK_WEIGHTS`）；返回 `score`、`cosine`、`coverage`、`matched`、`terms`。记 1 次 rerank。真实的重排序器是交叉编码器模型 |
| `rerank(query, candidates, topN?, meter?): Reranked[]` | 重新打分排序，`Reranked { item; before; rank; cross }` |

### 拼提示和引用（`rag.ts`）

| 签名 | 说明 |
|---|---|
| `buildPrompt(question, passages, instruction?): RagPrompt` | 说明、空行、`[n] 资料`（每条一行，段落不以标题开头时补上标题）、空行、`问题：…`。`RagPrompt { text; sources; parts; tokens }`，`parts` 每部分的 kind（instruction / source / question / separator）、字符区间、token 数，各部分之和等于整段（测试核对） |
| `RAG_INSTRUCTION`、`sourceLine(source)` | 默认说明；一条资料的写法 |
| `factsOf(text)`、`coverageOf(sentence, sources)`、`supports(sentence, sources): Support`、`SUPPORT_MIN`（0.5） | 本站的支持判据：关键事实（数字连单位、编号如 SR-35）忽略空白后一字不差地出现，且句子的词至少一半出现在来源里。不含数字的句子只看词覆盖率，判得宽，文案里要说明 |
| `splitAnswer(answer): AnswerSentence[]` | 按 。！？和换行切句，句末标点后紧跟的 `[n]` 归前一句；`{ text; from; to; cites }` |
| `checkCitations(answer, sources): { sentences; supported; total }` | 每句的状态：supported、unsupported、uncited（没标）、bad-source（编号越界） |
| `searchResultBlocks(passages): SearchResultBlock[]` | 写成 Claude Messages API 的 `search_result` 块（`type`、`source`（`kb://段落 id`）、`title`、`content`、`citations: { enabled: true }`） |

### 评估（`eval.ts`）

| 签名 | 说明 |
|---|---|
| `contextPrecision(retrieved, relevant): { score; marks; precisions }` | RAGAS 文档的 Σ(precision@k × v_k) / 前 K 个里相关的个数；v_k 用人工标注代替大模型判断 |
| `contextRecall(facts, contexts)`、`retrievalRecall(retrieved, relevant)` | 参考答案的关键事实有几个出现在检索结果里（近似 RAGAS 的「参考答案陈述能被支持的比例」）；按段落的检索召回 |
| `faithfulness(answer, contexts): { score; statements }` | 按句拆回答，用 `supports` 判断能否从全部检索结果推出（近似 RAGAS 的 \|V\| / \|S\|） |
| `answerFacts(answer, facts)` | 回答覆盖了几个关键事实 |
| `reciprocalRank(retrieved, relevant)` | 第一个相关段落名次的倒数（MRR 的一项）：`{ score, rank }`，前 K 个里没有相关段落时是 0、rank 为 null |

### 嵌入 API（`api.ts`）

| 签名 | 说明 |
|---|---|
| `OPENAI_HOST`、`EMBEDDINGS_PATH`、`OPENAI_EMBED_MODEL`（text-embedding-3-small）、`OPENAI_EMBED_DIMS`、`EXAMPLE_OPENAI_KEY` | 常量；密钥是示例长度 |
| `embeddingsHttpRequest(body, apiKey?): { json; layout }` | `POST /v1/embeddings`，头 host、content-type、authorization（Bearer）、content-length |
| `embeddingsResponse(vectors, request): EmbeddingsResponse` | `{ object: 'list', data: [{ object: 'embedding', index, embedding }], model, usage: { prompt_tokens, total_tokens } }`；float 时每个数写成 fp32 最短十进制，base64 时写 float32 小端字节的 base64 |
| `embeddingsHttpResponse(response, requestId)`、`exampleRequestId(seed)`、`promptTokensOf(input)` | 200 响应（content-type、x-request-id）；示例 id；输入 token 数（本站 BPE） |
| `ANTHROPIC_HOST`、`MESSAGES_PATH`、`ANTHROPIC_VERSION`（2026-10-21）、`CLAUDE_MODEL`（claude-opus-5-5）、`EXAMPLE_ANTHROPIC_KEY` | Claude Messages API 的常量（和 CONTEXT EXPLORER 一致）；密钥是示例长度 |
| `messagesHttpRequest(body, apiKey?): { json; layout }`、`MessagesRequest { model; max_tokens; messages }`、`UserBlock` | `POST /v1/messages`，头 host、content-type、anthropic-version、x-api-key、content-length；user 消息的内容可以是字符串，或 text / `search_result` 块的数组 |
| `messageBody(answer, inputTokens, id): MessageBody`、`messagesHttpResponse(body, requestId)`、`exampleMessageId(seed)` | 非流式响应 `{ id, type, role, content: [{ type: 'text', text }], model, stop_reason, stop_sequence, usage }`；回答是示例，usage 是本站 BPE 的计数；200 响应带 request-id |

### 索引流水线（`ingest.ts`）

| 签名 | 说明 |
|---|---|
| `sourceFile(doc): string` | 一篇文档的原始文件（本站示例格式）：`---` 之间的 front matter（id、title、category、updated、status），`# 标题`，段落之间空一行 |
| `loadSource(raw): LoadedDoc` | 加载器的清洗：解析 front matter、去掉标题行和空行，`body` 就是 `docText`；`LoadedDoc { doc; raw; body; frontChars; heading; blankLines }`。`loadSource(sourceFile(doc))` 还原文档（测试核对） |
| `chunkRecords(loaded): { chunks; records }`、`ingestAll(docs?)` | 按段落切块，每块一条 `ChunkRecord { id; doc; title; status; updated; category; para; from; to; text }`（字符区间是块在清洗后正文里的位置）；`ingestAll` 对整个知识库走一遍，块的顺序和 `PARAGRAPHS` 一致 |

## 写字节的层（`src/decode/structures.ts`）

每个函数返回一层 `LayerWriter`，`wire(at, view, fidelity, ...layers)` 拼成一个事件的解码结构。检查器开了 `segmentLayers`：每层的 hex 地址从 0 开始。

| 签名 | 说明 |
|---|---|
| `utf8Text(name, text)`、`utf8Lines(name, text)` | 每个字符一个字段（多字节字符拆出首字节、续字节）；每行一个字段 |
| `chunkBytes(name, text, chunks)` | 整篇一个字段，每块是子字段（可以重叠），值写字数和 token 数 |
| `tokenIds(name, ids)` | int32 小端 token id，值带展示文字 |
| `floatVector(name, values, 'f32' \| 'f16', { names?, notes?, bits?, digits? })` | 浮点向量；`bits: true` 按位展示符号、指数、尾数 |
| `int8Vector(name, q)`、`pqCodes(name, codes, cb?)` | float32 缩放系数 + int8；PQ 的 uint8 码 |
| `base64Text(name, text, source)` | base64 字符（每 4 个一个字段，值是对应的 3 个字节） |
| `httpHead(name, layout, { mask?, notes?, example?, startNote? })`、`jsonBody(name, json, { root?, expand?, notes?, example?, shown? })` | 和 CONTEXT EXPLORER 相同 |
| `promptParts(name, prompt)` | RAG 提示的每一部分，值是 token 数 |
| `vectorRows(name, labels, vectors)` | 一批向量平铺存放（float32 小端，一个接一个），每个向量一个字段；Flat 一类存储的摆法，配合 internal |
| `concept(name, fields)`、`num`、`thousands`、`preview` | 概念层（无字节）、数值显示、千分位、截断预览 |

## 课程的小工具（`src/lessons/common.ts`）

向量检索组（flat、ivf、hnsw、pq、hybrid）另有 `index-common.ts`：段落简称（文档一个字加序号，如 cup#1 → 杯1）、向量空间的平面布局（从 PCA 出发做度量 MDS，再把太近的点推开；查询和质心按最近 3 个段落加权放置，只是示意）、`spaceGraph`、`searchOutput`（FAISS `search()` 输出的 float32 distances 和 int64 labels）。

`cellsOf(values, options)`（和 llm 相同）、`PART_TONE`、`fixed(x, digits)`（固定小数位，不写 −0.00）、`comp`（向量分量两位小数）、`vectorRow(id, v, options)`（向量画成一排热力格子）、`similarityGrid(id, labels, matrix)`（相似度小表）、`pairwise(vectors, f)`、`pct`。

## 增加一节课

1. 新建 `src/lessons/<id>.ts`，导出 `Lesson`，`id` 和 `group` 必须和 `index.ts` 的 `PLANNED` 一致。计算从 `../core` 取，事件用 `dsl.ts` 的 `pk`、`note`、`state`、`show`。每个事件带上此刻的图元（`ds`）和字节结构（`wire`）。`pk` 的轨迹行是 `[累计距离计算次数, 类型, 说明, 字节数]`，距离从 `DistanceMeter` 取。
2. 在 `index.ts` 里 import 它，加进 `LESSONS`，顺序和 `PLANNED` 一致（`tests/lessons.test.ts` 核对 14 课全部实现、顺序和分组）。
3. 在对应的 narrative 测试（`embed` 组在 `narrative.test.ts`，`index` 组在 `narrative.index.test.ts`，`pipeline` 组 ingest / qa / rerank 在 `narrative.pipeline.test.ts`、rewrite / evaluate / finetune 在 `narrative.pipeline-b.test.ts`）里加这节课的文案核对：关键的数写死，文字里的说法逐条核对。`tests/lessons.test.ts` 会自动检查步骤数（4–6）、detail 句数（2–4，按 。！？ 数，引用的问题要去掉末尾的问号）、节点显示顺序、距离单调、字段范围、通道和数据结构是否重叠。
4. e2e 和首页的课数都从 `LESSONS` 取，不用改。
5. 文案里用了新的符号（不是中文），重新运行字体裁剪脚本。Iosevka 22.1.2 没有 ⏎ 和 ⚠（换行用 ↵）；用新符号前先确认字体里有。
6. **截图看布局**：单元测试只查设备和数据结构的外接框，查不出文字互相压住。用浅色、深色，1440 宽和 380 宽各看一遍（380 宽时节点名称会按比例放大，最容易压住）。经验：16 维向量画成一排格子很长，`w` 取 26–30；数据节点的名称用 `labelAt` 放到图元的左侧、右侧或下方；`note` 挂在节点上方，会压住上面那个节点的名称；布局的宽高比在 1.2–1.5 之间。

## 核对过的事实（2026-11-06）

| 事实 | 来源 |
|---|---|
| OpenAI 嵌入：`POST https://api.openai.com/v1/embeddings`；`input` 是字符串或数组（每段最多 8192 token、空串不行；数组最多 2048 段；一次请求合计最多 300,000 token），`model`，`encoding_format` 为 `float`（默认）或 `base64`，`dimensions`（text-embedding-3 及以后才支持），`user` | <https://developers.openai.com/api/reference/resources/embeddings/methods/create> |
| 响应 `{ object: "list", data: [{ object: "embedding", index, embedding }], model, usage: { prompt_tokens, total_tokens } }`（文档几个示例里字段顺序不一，本站照指南示例的顺序） | 同上；<https://developers.openai.com/api/docs/guides/embeddings> |
| 模型 `text-embedding-3-small`（默认 1536 维）、`text-embedding-3-large`（默认 3072 维）、`text-embedding-ada-002`；没有更新的嵌入模型 | 同上 |
| OpenAI 的嵌入归一化到长度 1：余弦可以直接用点积算，余弦和欧氏距离给出相同的排序；用 `dimensions` 缩短是推荐做法，自己截断要重新归一化 | <https://developers.openai.com/api/docs/guides/embeddings> |
| base64：官方 Python SDK 用 `np.frombuffer(base64.b64decode(data), dtype="float32")` 解码（本机字节序，x86 / ARM 上是小端）；不写 `encoding_format` 时 SDK 自己发 `base64` 再解码成浮点数 | openai-python 源码 `src/openai/resources/embeddings.py`、`src/openai/lib/_parsing/_embeddings.py` |
| Anthropic 没有自己的嵌入模型，文档推荐 Voyage AI（`voyage-4-large`、`voyage-4`、`voyage-4-lite` 等，`rerank-3`）；Voyage 的嵌入也归一化到长度 1 | <https://platform.claude.com/docs/en/build-with-claude/embeddings> |
| Voyage：`POST https://api.voyageai.com/v1/embeddings`，`input`（≤ 1000 段）、`model`、`input_type`（null / query / document，会在前面加提示语）、`truncation`、`output_dimension`（256 / 512 / 1024 / 2048）、`output_dtype`（float / int8 / uint8 / binary / ubinary）；响应 usage 只有 `total_tokens`；当前模型 voyage-4 系列默认 1024 维。重排序 `POST /v1/rerank`：`query`、`documents`、`model`、`top_k`，响应 `data[{ index, relevance_score }]` 按相关度降序；「rerankers are cross-encoders that jointly process a pair of query and document」 | <https://docs.voyageai.com/reference/embeddings-api>、<https://docs.voyageai.com/docs/embeddings>、<https://docs.voyageai.com/reference/reranker-api>、<https://docs.voyageai.com/docs/reranker> |
| Claude Messages API 的 `search_result` 块：必填 `type`、`source`（任意稳定字符串）、`title`、`content`（text 块数组），可选 `citations: { enabled }`（默认关，同一请求里要么都开要么都关）、`cache_control`；放在 user 消息里或工具结果里；引用是 `search_result_location`，带 `source`、`title`、`cited_text`、`search_result_index`、`start_block_index`、`end_block_index`（不含） | <https://platform.claude.com/docs/en/build-with-claude/search-results>；claude-api skill |
| FAISS：`IndexFlatL2(d)`、`IndexFlatIP(d)`；`IndexIVFFlat(quantizer, d, nlist, metric = METRIC_L2)`，`nprobe` 默认 1，没训练过不能 add / search；`IndexHNSWFlat(d, M, metric = METRIC_L2)`，`efConstruction` 默认 40、`efSearch` 默认 16，第 0 层 2·M 个邻居，层数概率按 levelMult = 1/ln(M)；`IndexPQ(d, M, nbits, metric)`（nbits 没有默认值）；`IndexIVFPQ(quantizer, d, nlist, M, nbits)`；统计里的 `ndis`（`indexIVF_stats`、`hnsw_stats`） | FAISS 源码 `faiss/IndexFlat.h`、`IndexIVF.h`、`IndexIVFFlat.h`、`IndexHNSW.h`、`impl/HNSW.h`、`impl/HNSW.cpp`、`IndexPQ.h`（2026-11-05 的 main）；<https://github.com/facebookresearch/faiss/wiki/Faiss-indexes> |
| hnswlib：默认 `M = 16`、`ef_construction = 200`、`ef = 10`，`maxM0_ = 2·M`，`mult_ = 1/ln(M)`，层数 `(int)(-log(unif(0,1)) * mult_)` | hnswlib 源码 `hnswlib/hnswalg.h`、`ALGO_PARAMS.md` |
| HNSW 论文：Malkov、Yashunin，Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs，arXiv 1603.09320（v1 2016-03-30），IEEE TPAMI 42(4)，824–836，2020；层数 l = ⌊−ln(unif(0..1))·mL⌋，「A simple choice for the optimal mL is 1/ln(M)」，Mmax0 取 2·M，efConstruction 是建图时动态候选表的大小 | <https://arxiv.org/abs/1603.09320> |
| PQ 论文：Jégou、Douze、Schmid，Product quantization for nearest neighbor search，IEEE TPAMI 33(1)，117–128，2011；SDC（查询和库向量都量化）和 ADC（查询不量化） | <https://inria.hal.science/inria-00514462/document> |
| RRF：Cormack、Clarke、Büttcher，Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods，SIGIR 2009；RRFscore(d) = Σ 1/(k + r(d))，「k = 60 was fixed during a pilot investigation」，后来的试验说 60 接近最优但不敏感 | <https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf> |
| 各家的 RRF 常数：Elasticsearch `rank_constant` 默认 60（rank 从 1 起），OpenSearch 默认 60；**Qdrant 默认 k = 2，rank 从 0 起**（可设 `{"rrf": {"k": 60}}`）；Weaviate 的 rankedFusion 用 60，但从 v1.24 起默认是 relativeScoreFusion | <https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion>、<https://qdrant.tech/documentation/concepts/hybrid-queries/> |
| RAG 论文：Lewis et al.，Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks，arXiv 2005.11401，NeurIPS 2020；检索器 DPR（双塔），生成器 BART-large | <https://arxiv.org/abs/2005.11401> |
| RAGAS：Es、James、Espinosa-Anke、Schockaert，RAGAS: Automated Evaluation of Retrieval Augmented Generation，arXiv 2309.15217，EACL 2024 系统演示；论文的三个指标 faithfulness（F = \|V\|/\|S\|）、answer relevance、context relevance；现在的文档：Context Precision@K = Σ(Precision@k × v_k) / 前 K 个里相关的个数，Context Recall = 参考答案里能被检索结果支持的陈述 / 参考答案的陈述数，Faithfulness = 回答里被支持的陈述 / 回答的陈述数 | <https://arxiv.org/abs/2309.15217>、<https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/> |
| pgvector：默认精确搜索；索引 HNSW（`m` 16、`ef_construction` 64、`hnsw.ef_search` 40）和 IVFFlat（`lists`，`ivfflat.probes` 默认 1）；运算符 `<->` L2、`<#>` 负内积、`<=>` 余弦、`<+>` L1；`vector` 建索引最多 2000 维、`halfvec` 4000；近似索引加过滤条件时是先扫索引再过滤，可能返回不足 k 条（0.8.0 起有 `hnsw.iterative_scan`） | <https://github.com/pgvector/pgvector> |
| Qdrant：HNSW 默认 `m: 16`、`ef_construct: 100`、`full_scan_threshold: 10000`（KB），查询的 ef 默认等于 ef_construct；可过滤的 HNSW 在图里搜索时就应用过滤；融合方式 `rrf`、`dbsf` | <https://qdrant.tech/documentation/concepts/indexing/>、<https://qdrant.tech/documentation/concepts/hybrid-queries/> |
| Chroma：单机用 HNSW（分布式和云版用 SPANN），`space` 默认 `l2`（平方 L2），可选 `cosine`、`ip`；`ef_construction` 100、`ef_search` 100 | <https://docs.trychroma.com/docs/collections/configure> |
| Pinecone：按元数据过滤（eq、ne、数值比较、in、nin、exists、AND / OR / NOT）；单索引的稀疏 + 稠密混合检索要求 `dotproduct` 度量 | <https://docs.pinecone.io/guides/index-data/indexing-overview>、<https://docs.pinecone.io/guides/search/hybrid-search>、<https://docs.pinecone.io/guides/legacy/vectors-api/hybrid-search-single-index> |
| Anthropic Contextual Retrieval（2024-09-19）：用 1 − recall@20 衡量；给块加 50–100 token 的上下文，检索失败率降 35%（5.7% → 3.7%），再加上下文 BM25 降 49%（→ 2.9%），再加重排序降 67%（→ 1.9%）；知识库小于 20 万 token 时直接全部放进提示；文中只说 rank fusion，没说是 RRF | <https://www.anthropic.com/news/contextual-retrieval> |
| BM25：Robertson、Zaragoza，The Probabilistic Relevance Framework: BM25 and Beyond，Foundations and Trends in IR 3(4)，2009；k1 = 1.2、b = 0.75 和 idf = log(1 + (N − n + 0.5)/(n + 0.5)) 是 Lucene `BM25Similarity` 的默认值（综述原文举的例子是 b = 0.5、k1 = 2） | <https://lucene.apache.org/core/10_0_0/core/org/apache/lucene/search/similarities/BM25Similarity.html>、<https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf> |
| LSA：Deerwester et al.，Indexing by Latent Semantic Analysis，JASIS 1990 | 没有联网核对，按常见引用写 |
| HyDE：Gao、Ma、Lin、Callan，Precise Zero-Shot Dense Retrieval without Relevance Labels，arXiv 2212.10496（2022-12-20），ACL 2023（2023.acl-long.99，1762–1777 页）；指令模型先为查询写一段假设文档，对比学习训练的编码器（Contriever）把它嵌入成向量，再按向量相似度找真实文档；摘要说假设文档「may contain false details」，由编码器的瓶颈滤掉 | <https://arxiv.org/abs/2212.10496>、<https://aclanthology.org/2023.acl-long.99/> |
| 查询改写：Ma、Gong、He、Zhao、Duan，Query Rewriting for Retrieval-Augmented Large Language Models（Rewrite-Retrieve-Read），arXiv 2305.14283，EMNLP 2023；在检索前先改写查询，用小模型做改写器、以读者模型的反馈做强化学习 | <https://arxiv.org/abs/2305.14283> |
| 多查询扩展：LangChain `MultiQueryRetriever` 的默认提示让模型「generate 3 different versions of the given user question」，每个查询各检索一次，结果取去重的并集（unique union），不打分融合；RAG-Fusion 也是一次写多个查询，但用 RRF（1 / (60 + rank)）合并排序 | langchain 源码 `libs/langchain/langchain_classic/retrievers/multi_query.py`；<https://github.com/Raudaschl/rag-fusion> |
| RAGAS 指标的现行文档：Faithfulness = 回答里能从检索上下文推出的陈述 / 回答的陈述数（例：两条陈述一条对，0.5）；Answer Relevancy = 根据回答生成 N 个问题（默认 3，参数 `strictness`），和用户问题的嵌入余弦取平均，「without evaluating factual accuracy」，理论上可以为负；Context Recall（大模型版）= 参考答案拆出的陈述里能归因到检索上下文的比例，另有 `NonLLMContextRecall`、`IDBasedContextRecall`（按 id 比较）；Context Precision 的 v_k 由大模型对照参考答案（`LLMContextPrecisionWithReference`）或回答判断，另有按 id 的 `IDBasedContextPrecision` | <https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/>、<https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/>、<https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/>、<https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/> |
| FAISS 各索引每个向量的字节数：IndexFlatL2 / IndexFlatIP `4*d`（IndexFlatIP「also for cosine (normalize vectors beforehand)」），IndexIVFFlat `4*d + 8`（8 字节是 id），IndexHNSWFlat `4*d + x * M * 2 * 4`，IndexPQ `ceil(M * nbits / 8)`，IndexIVFPQ `ceil(M * nbits/8)+8` | <https://github.com/facebookresearch/faiss/wiki/Faiss-indexes> |
| FAISS 的 L2 报告的是平方欧氏距离（「avoiding the square root」）；内积只有在向量归一化后才等于余弦 | <https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances> |
| FAISS `Index::search(n, x, k, distances, labels)`：distances 是 n × k 个 float，labels 是 n × k 个 `idx_t`（`using idx_t = int64_t`），结果不够 k 个时补 −1 | FAISS 源码 `faiss/Index.h`、`faiss/MetricType.h`（2026-11-06 的 main） |
| FAISS `IndexHNSW(d = 0, M = 32, metric)` 的 M 默认 32；`IndexHNSWFlat(d, M, metric)` 的 M 没有默认值 | FAISS 源码 `faiss/IndexHNSW.h` |
| FAISS 选型指南：数据少于 100 万时 IVF 的簇数 K 取 4√N 到 16√N，训练向量要 30 × K 到 256 × K 个；HNSW「4 <= M <= 64」，每个向量 `(d * 4 + M * 2 * 4)` 字节 | <https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index> |
| pgvector IVFFlat：lists 先取 `rows / 1000`（100 万行以内）或 `sqrt(rows)`（100 万行以上），probes 先取 `sqrt(lists)`；过滤时「filtering is applied after the index is scanned」，可能返回更少的结果 | <https://github.com/pgvector/pgvector> |
| Claude Messages API：`POST https://api.anthropic.com/v1/messages`；`model`、`max_tokens`、`messages` 必填；版本头 `anthropic-version` 必填，最新 `2026-10-21`；鉴权头 `x-api-key`，响应带 `request-id` 头；响应字段 `id`、`type`、`role`、`content`、`model`、`stop_reason`、`stop_sequence`、`usage`；当前默认模型 `claude-opus-5-5`（照抄 CONTEXT EXPLORER 的事实表） | <https://platform.claude.com/docs/en/api/messages.md>、<https://platform.claude.com/docs/en/api/versioning.md>、<https://platform.claude.com/docs/en/api/errors.md>、<https://platform.claude.com/docs/en/build-with-claude/working-with-messages.md>；claude-api skill |
| `search_result_location` 的 `cited_text` 是被引用的那几个 content 块的全文，不计入输出 token；`search_result_index` 按请求里全部 search_result 块的出现顺序从 0 数；块是最小的引用单位 | <https://platform.claude.com/docs/en/build-with-claude/search-results>（2026-11-06） |
| Voyage 重排序：`model` 必填，文档推荐 `rerank-3`（另有 `rerank-3-lite`，上下文 32,000 token；API 参考页列的是 rerank-2.5 等，两处不一致，课程只在请求示例里用 rerank-3）；`documents` 最多 1000 个；`top_k` 默认 null 返回全部；一次重排的 token 数 =「query 的 token × 文档数 + 全部文档的 token」；「Unlike embedding models that encode queries and documents separately, rerankers are cross-encoders」 | <https://docs.voyageai.com/docs/reranker>、<https://docs.voyageai.com/reference/reranker-api> |
| Cohere 重排序：`POST https://api.cohere.com/v2/rerank`，Bearer 鉴权；必填 `model`、`query`、`documents`（字符串数组，建议不超过约 1000 个），可选 `top_n`（不写返回全部）、`max_tokens_per_doc`（默认 4096）；响应 `results[{ index, relevance_score }]` 按相关度排序，分数归一化到 [0, 1]；文档示例的模型名 `rerank-v5.0-pro` | <https://docs.cohere.com/reference/rerank> |

没有核对、以示例或本站写法对待的：Pinecone 的索引算法（文档没写）、Chroma HNSW 的 `max_neighbors` 默认值（页面原文截断，没确认）、Voyage `voyage-4-nano` 的默认维度（两处文档不一致）、OpenAI 嵌入的价格、真实嵌入服务的分词器和 token 数（本站用迷你 BPE）、int8 量化的写法（各家不同，本站对称 absmax / 127）、FAISS / hnswlib 的内存布局（如果课程展示倒排表或邻接表的字节，标 internal）、重排序的打分公式（本站替身）、引用核对和评估的判据（本站的字面近似，不是 RAGAS 的大模型判断）、知识库内容（示例数据）。

## 共享包

需要分词、BM25、随机数、哈希、浮点位模式、JSON 和 HTTP 时，一律从 `packages/llm-core`（`@explorer/llm-core`）导入，不在本模块复制。为此把三处代码抽进了共享包，原模块改为转导出，课程内容和数字不变（llm、context 的单元测试和 e2e 都通过）：

- `float.ts`：原在 llm 的 `src/model/numeric.ts`（fp32 / fp16 / bf16 位模式、`i32Bytes`）；
- `bm25.ts`：原在 context 的 `src/core/recall.ts`（`termsOf`、`bm25`），context 保留 `recall` 和类型别名；
- `json.ts`、`http.ts`：原在 context 的 `src/core/`。

`scene/ds.ts`、`scene/plugin.ts` 和 llm、context 的同名文件逐字相同，`decode/structures.ts` 里的 `httpHead`、`jsonBody`、`utf8Text`、`floatVector` 和两门课的写法相同：这是系列的约定（每个模块的场景和写字节层各一份，便于按课程调整），没有抽成共享包。

## 已知的简化和待办

- 回答内容（模型写的话）是示例；嵌入 API 响应里的数值和 usage 是本站模型和分词器算的。
- 嵌入模型只在这个小知识库上训练，词表外的词直接丢掉；真实模型没有这个限制。
- k-means 的空簇保留旧质心（FAISS 会拆分最大的簇）；PQ 的编号一律一个 uint8（FAISS 在 nbits < 8 时按位紧挨着存）。
- 向量检索组的规模实验用 1000 个合成向量（段落向量加噪声），簇结构和知识库一样，比真实语料容易，召回率偏高；IVF、HNSW、PQ 在它上面建索引都在页面加载时完成（Node 里 vitest 逐个 import：HNSW 课约 40 ms，其中建图约 20–30 ms；PQ 课约 30 ms，其中 256 个子质心的训练约 12–19 ms；核心约 95 ms，主要是模块加载和共享包；14 课加核心合计约 0.33 秒）。向量空间的平面图只是示意，16 维的远近保留不全。
- HNSW 的启发式选邻居没有实现 extendCandidates 和 keepPrunedConnections（和 hnswlib 的默认一致）。
- 引用核对和 faithfulness 用字面判据：关键事实一字不差、词覆盖率 ≥ 0.5；不含数字的句子判得宽。
- HTTP 统一按 HTTP/1.1 展示。
