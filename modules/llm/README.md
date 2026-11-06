# LLM Explorer

用交互动画讲大模型怎样生成一个 token，并逐字节解码 UTF-8、token id、fp16 / bf16 和 GGUF 量化块。课程里的数字全部来自浏览器里真实运行的迷你 Transformer：字节级 BPE 分词器、2 层 decoder-only 模型、采样器、量化器都在 `src/model/`，课程文件只负责把计算过程变成事件。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。

## 开发

本模块由主站统一提供服务，地址是 `/modules/llm/`。启动和构建在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test                 # 本模块的单元测试（含一次完整的重新训练，约 4 秒）
npm run train            # 改了语料、分词器、模型结构或训练配方后，重新生成 src/model/weights.data.ts
python tests/reference/vectors.py           # 重新生成独立参考向量（需要 numpy、gguf）
python scripts/subset-fonts.py <woff2 目录>  # 按本站字符重新裁剪 Iosevka（需要 fonttools、brotli），字体源见脚本开头
```

## 结构

- `src/model/`：计算核心，纯 TypeScript，确定性（随机数全部来自固定种子）。接口见下文。分词器、UTF-8、语料、随机数、FNV-1a 和浮点位模式在共享包 `packages/llm-core`（`@explorer/llm-core`），和 CONTEXT EXPLORER、RAG EXPLORER 共用，`src/model/index.ts` 一并导出。
- `src/lessons/`：每节课一个文件。`index.ts` 的 `PLANNED` 是 15 节课的顺序和分组；`types.ts` 是节点、事件和图元的类型；`dsl.ts` 是写事件的简写；`common.ts` 是画格子的小工具。
- `src/engine/`：推理组课程用的引擎模拟（roofline 账本、前缀缓存、分页与调度）。接口见下文。
- `src/decode/`：可信度（`writer.ts`）和按真实格式写字节的层（`structures.ts`）。
- `src/scene/`：`devices.ts` 是设备节点的图形，`ds.ts` 把图元画成等距格子（相对 algo 加了 `heat` 热力图），`plugin.ts` 负责图元在帧之间的动画。
- `tests/`：`model.test.ts` 核对计算核心；`lessons.test.ts` 检查每节课的结构和布局；`narrative.test.ts` 和 `narrative.{repr,infer,sample}.test.ts` 核对文案和计算结果；`engine.test.ts` 核对引擎模拟；`reference/vectors.py` 是独立参考，`vectors/*.json` 是它的输出。

## 本站约定

**抽象层级（顶栏 7 档）**：字节、token、向量、注意力、模型层、推理引擎、API。这是本站的教学约定，不是业界标准分层。每节课用 `layer: [lo, hi]` 标出跨了哪几档，`layerNote` 写一句为什么。

**运算量（轨迹表第二列）**：每节课累计的真实运算量，单位由课程的 `opsUnit` / `opsShort` 说明。模型类的课用 FLOPs：只计乘加，每次乘加算 2 FLOPs（矩阵乘、注意力的点积和加权求和），逐元素运算不计，由 `FlopMeter` 累计。没有浮点运算的课（分词）用自己的计数，比如合并表查询次数。必须单调不减，不能手写。

**可信度（检查器顶部）**：
- `format`：公开规范定义的真实字节：UTF-8、int32 token id（llama.cpp 的 `llama_token`）、IEEE 754 fp32 / fp16 / bf16 小端、GGUF 量化块、safetensors、tokenizer.json。
- `internal`：推理引擎的内部布局，比如 llama.cpp 或 vLLM 的 KV cache、块表。真实但会随版本变化。
- `示意`：只讲概念，没有字节。
地址、时间这类每次运行都不同的值，字段加 `example: true`，界面上显示 E.G.。

**数值**：权重和每一步的输出都按 fp32 舍入保存（`Math.fround`），累加在 float64 里做。所以 `floatVector(..., 'f32')` 展示的字节就是计算真正用到的值。训练在纯 float64 下做（`fp64: true`），保存前舍入到 fp32。

## 节点

`src/lessons/types.ts` 的 `NODE_IDS`，每节课在 `nodes` 里挑自己要的。设备节点有固定图形，可以挂状态面板；数据节点没有外形，长相就是课程给它的图元。

| 节点 | 类型 | 用途 |
|---|---|---|
| `client` | 设备 | 应用：输入提示词、看流式输出。带屏幕（`render` 逐行画出），命令框（`type`）挂在它上方 |
| `server` | 设备 | 推理服务：HTTP API 入口，SSE 流式响应 |
| `tokenizer` | 设备 | 分词器：文本 ↔ token id |
| `sched` | 设备 | 调度器：连续批处理、分配 KV 块、抢占 |
| `gpu` | 设备 | GPU：计算单元和显存（HBM），显存字节账 |
| `weights` | 设备 | 权重文件：磁盘上的 GGUF / safetensors |
| `sampler` | 设备 | 采样器：惩罚、temperature、top-k / top-p、抽样 |
| `detok` | 设备 | 反分词：id → 字节 → UTF-8 拼接，暂存半个字符 |
| `grad` | 设备 | 优化器：梯度和参数更新（LoRA） |
| `vit` | 设备 | 视觉投影：图像 patch 展平、线性投影 |
| `text` | 数据 | 输入文本和它的 UTF-8 字节 |
| `image` | 数据 | 输入图像：像素网格和 patch |
| `tokens` | 数据 | token id 序列 |
| `vocab` | 数据 | 词表、合并规则表 |
| `embed` | 数据 | 嵌入表，RoPE 前后的向量 |
| `hidden` | 数据 | 残差流：每个位置的隐藏向量 |
| `norm` | 数据 | RMSNorm 的输入、缩放、输出 |
| `attn` | 数据 | Q、K、V，分数矩阵，因果掩码，softmax 权重 |
| `ffn` | 数据 | SwiGLU：gate、up、激活、down |
| `kv` | 数据 | KV cache，分页时的块表 |
| `lmhead` | 数据 | 输出层：隐藏向量 × 输出矩阵 → logits |
| `logits` | 数据 | logits 和概率分布 |
| `queue` | 数据 | 请求队列 |
| `lora` | 数据 | LoRA 的 A、B 和梯度 |
| `out` | 数据 | 已生成的输出文本 |

图元（`Prim`）和 algo 相同：`row`（向量、序列）、`grid`（矩阵）、`graph`、`ring`、`tower`（层堆叠）。格子多一个 `heat?: number`（0–1），按比例在底色和 `tone` 色之间混合，用来画注意力权重、概率这类热力图。

## 计算核心接口（`src/model/`）

全部从 `src/model/index.ts` 导出：`import { TOKENIZER, MODEL, ... } from '../model'`。

### 全站共享的实例

| 名字 | 说明 |
|---|---|
| `TOKENIZER: BpeTokenizer` | 在内置语料上训练的字节级 BPE，96 条合并规则，词表 353（256 字节 + 96 合并 + 1 结束符） |
| `MODEL: Weights` | 预训练好的迷你 Transformer（只读；要改先 `cloneWeights`） |
| `VISION: VisionWeights` | 图像 patch 投影权重，固定种子，未训练 |
| `WEIGHTS_FILE: WeightsFile` | 权重文件内容，含训练配方 `train` 和损失日志 `train.logs` |
| `CORPUS: readonly string[]`、`NUM_MERGES`、`EOS_TEXT` | 内置语料（18 篇，英文多中文少）、合并数、结束符的显示文字 `<|end|>` |

### 随机数（`@explorer/llm-core/prng`）

| 签名 | 说明 |
|---|---|
| `mulberry32(seed: number): () => number` | 固定种子的 [0, 1) 均匀分布。全站不用 `Math.random` |
| `gaussian(rand: () => number): () => number` | 用同一个源的标准正态分布（Box–Muller） |

### UTF-8（`@explorer/llm-core/utf8`）

| 签名 | 说明 |
|---|---|
| `utf8Encode(text: string): number[]` | 文本 → 字节 |
| `utf8Decode(bytes: readonly number[]): string` | 字节 → 文本，非法序列按 WHATWG 规则换成 U+FFFD，和 `TextDecoder` 一致 |
| `utf8Chars(text): Array<{ char, bytes }>` | 每个字符和它的字节 |
| `utf8Kind(byte): 'ascii' \| 'lead2' \| 'lead3' \| 'lead4' \| 'cont' \| 'invalid'`、`utf8Length(byte)` | 字节的角色、首字节声明的长度 |
| `class Utf8Stream { pending: number[]; push(bytes): string; flush(): string }` | 流式解码：只吐出收齐的字符，半个字符先存着（流式输出课） |
| `hex2(byte): string` | 两位大写十六进制 |

### 分词器（`@explorer/llm-core/tokenizer`）

语料在 `@explorer/llm-core/corpus`。CONTEXT EXPLORER 用同一个 `TOKENIZER` 数 token，所以改语料或合并数会同时改变两门课的数字。

| 签名 | 说明 |
|---|---|
| `BpeTokenizer.train(corpus, numMerges): BpeTokenizer` | 训练：反复合并出现最多的相邻对（并列取 id 字典序最小） |
| `tok.encode(text): number[]` | 编码：先预分词，每块里反复合并 rank 最小的对 |
| `tok.encodeTrace(text): EncodeTrace` | 带过程的编码：`chunks`、`bytes`、按 rank 顺序的 `steps`（每条规则的 `merge`、命中位置 `at`、合并后 `after`、累计查表 `lookups`）、`ids`、总查表数 `lookups` |
| `tok.decode(ids): string`、`tok.bytesOf(id)`、`tok.bytesOfAll(ids)` | 解码、一个 token 的字节 |
| `tok.label(id): string` | 展示文字：空格写成 ␣，半个字符写成「E8 AF」，结束符写成 `<|end|>` |
| `tok.rankOf(a, b)`、`tok.merges: Merge[]`、`tok.vocab: number[][]`、`tok.eos`、`tok.size` | 合并表、词表、结束符 id |
| `pretokenize(text): string[]` | 预分词（连续汉字单独成块，前导空格归下一个词） |
| `mergePair(ids, pair, id, onHit?)` | 把所有不重叠的 pair 换成 id |
| `BYTE_TO_UNICODE`、`gpt2Text(bytes)`、`mergeEntry(tok, merge)` | GPT-2 的字节映射，tokenizer.json 里的写法（空格是 Ġ） |

### 张量和 FLOPs（`tensor.ts`）

| 签名 | 说明 |
|---|---|
| `type Vec = number[]`、`type Mat = number[][]` | 矩阵按行存放，`W[out][in]`，y = W·x |
| `class FlopMeter { total; by: Record<FlopKind, number>; add(kind, flops) }` | 累计 FLOPs，按类：`qkv` `score` `mix` `wo` `ffn` `lmhead` `lora` `other` |
| `matvec(W, x, round?, meter?, kind?)` | y = W·x，计 2·out·in FLOPs |
| `rmsnorm(x, gamma, eps, round?): { y, rms }`、`softmax(x, round?)`、`logSumExp(x)`、`silu`、`sigmoid`、`argmax`、`dot`、`add`、`mul` | 基础运算。`round` 默认 `FP32`（`Math.fround`），传 `FP64` 不舍入 |

### Transformer（`transformer.ts`）

结构和 LLaMA 一致：d_model 8，2 头 × 4 维，2 层，SwiGLU 隐层 16，pre-norm RMSNorm，RoPE（相邻两维一组，θ = 10000），因果注意力，上下文窗口 32。张量用 GGUF 的名字。

| 签名 | 说明 |
|---|---|
| `forward(W, tokens, options?): ForwardTrace` | 前向。`options.cache` 传入就在它上面接着算（增量解码 / 分段预填充）；`meter` 累计 FLOPs；`lastLogitsOnly` 只算最后一个位置的 logits；`fp64` 不舍入 |
| `forwardEmbeds(W, inputs: InputVector[], options?)` | 输入是向量序列（文本嵌入和图像 patch 可以混排），`forward` 就是查表后调它 |
| `embedTokens(W, tokens): InputVector[]`、`NO_TOKEN` | 查嵌入表；非文本输入的 token 记为 −1 |
| `decodeStep(W, cache, token, meter?): PositionTrace` | 增量解码一步 |
| `generate(W, prompt, { maxTokens, pick?, noCache?, stop?, meter? })` | 自回归生成，返回 `tokens`、每步的 `steps`（输入、选中、logits、累计 FLOPs、位置数）、`cache`、`meter`。`noCache` 每步从头重算（结果相同，FLOPs 多得多） |
| `lastLogits(trace)` | 最后一个位置的 logits |
| `class KVCache { k, v: Vec[][]（[层][位置]）; length; free; clone(); truncate(n); static valuesPerToken(config) }` | K 已经过 RoPE。`valuesPerToken = 2 × 层数 × d_model`，乘每个数的字节数就是显存账 |
| `rope(x, pos, config, round?, inverse?)`、`ropeFreq(config, pair)` | RoPE 旋转和频率 |
| `makeConfig(vocab)`、`initWeights(config, seed?)`、`tensorsOf(W): NamedTensor[]`、`paramCount(W)`、`LAYER_TENSORS` | 配置、固定种子初始化、按 GGUF 顺序的全部张量（名字、`ne[]` 形状、展开的值） |
| `crossEntropy(logits, target)`、`sequenceLoss(trace, targets)` | 损失（nat） |

`ForwardTrace.positions[i]`（`PositionTrace`）暴露每个位置的全部中间张量：`embed`；每层的 `LayerStep`：`input`、`attnRms`、`attnNormed`、`q`/`k`/`v`、`qRope`/`kRope`、`heads[h].scores`（已缩放，只到当前位置，之后的位置被因果掩码挡住）和 `heads[h].probs`、`mixed`、`attnOut`、`resid`、`ffnRms`、`ffnNormed`、`gate`、`up`、`act`、`ffnOut`、`output`；最后的 `finalRms`、`finalNormed`、`logits`。

保证：带 cache 逐个解码、分段预填充、一次完整前向，三者的 logits 逐位相同（`tests/model.test.ts`）。

### 训练和 LoRA（`train.ts`）

| 签名 | 说明 |
|---|---|
| `backward(W, trace, targets): Weights` | 反向传播（trace 必须从位置 0 开始，建议 `fp64`），返回和 `Weights` 同结构的梯度，已用有限差分核对 |
| `sgdStep(W, grads, lr)`、`class Adam { step(W, grads, lr?) }` | 优化器 |
| `loraGrads(dW, A, B, s): { dA, dB }`、`loraMerge(W, A, B, s)` | W' = W + s·B·A。由整矩阵梯度精确得到 dA、dB |
| `cloneWeights(W)`、`eachTensor(W, visit)`、`emptyGrads(W)` | 复制、遍历、零梯度 |
| `corpusStream(tok, corpus?)`、`pretrain(...)`、`trainFromScratch(tok)`、`PRETRAIN` | 预训练（`npm run train` 用） |

### 采样（`sample.ts`）

顺序和 Hugging Face 一致：惩罚 → 约束掩码 → temperature → softmax → top-k → top-p → 重新归一化 → 抽样。llama.cpp 默认把 temperature 放在最后。

| 签名 | 说明 |
|---|---|
| `sample(logits, history, options?, rand?): SampleTrace` | 一次采样。`options`：`temperature`（0 = 贪心）、`topK`、`topP`、`repetitionPenalty`、`presencePenalty`、`frequencyPenalty`、`allowed`（约束掩码）。不传 `rand` 也走贪心。返回每一段：`raw`、`penalized`、`masked`、`scaled`、`probs`、`ranked`、`afterTopK`、`afterTopP`、`final`（含重新归一化的 `p` 和 `cumulative`）、随机数 `u`、`chosen` |
| `applyPenalties(logits, history, options)`、`topK(ranked, k)`、`topP(candidates, p)` | 单独的各段 |
| `prefixMask(tok, sofarBytes, isPrefix, isComplete): boolean[]` | 约束解码的掩码：接上这个 token 的字节后仍是合法前缀才允许；结束符只在完整时允许 |
| `choiceConstraint(options: string[])` | 最简单的约束（枚举），返回 `isPrefix`、`isComplete`。JSON、正则可以照这个形状写 |

### 数值格式和量化（`numeric.ts`）

fp32 / fp16 / bf16 的位模式和 int32 小端（`f32Bits` 到 `i32Bytes`）在共享包 `@explorer/llm-core/float`（RAG EXPLORER 的向量编码也用），`numeric.ts` 原样转导出，接口和数字不变。

| 签名 | 说明 |
|---|---|
| `f32Bits / f32FromBits / f32Bytes` | fp32 位模式和小端字节 |
| `f16Bits / f16FromBits / f16Round / f16Bytes` | fp16，就近舍入平局取偶，次正规数、溢出到 ∞ |
| `bf16Bits / bf16FromBits / bf16Round / bf16Bytes` | bf16 |
| `i32Bytes(value)` | int32 小端 |
| `quantizeQ8_0(values): Q8Block[]`、`dequantizeQ8_0`、`q8_0Bytes(block)` | GGUF Q8_0：每 32 个一块，fp16 d + 32 个 int8，34 字节 |
| `quantizeQ4_0(values): Q4Block[]`、`dequantizeQ4_0`、`q4_0Bytes(block)` | GGUF Q4_0：每 32 个一块，fp16 d + 16 字节（低 4 位第 j 个，高 4 位第 j+16 个），18 字节 |
| `encodeAs(format, values)`、`roundTrip(format, values)`、`BYTES_PER_WEIGHT`、`QK` | 任意格式的字节、编码再解码的值（量化误差） |

和 numpy、ggml 官方 gguf-py 的输出逐字节核对过（`tests/vectors/quant.json`）。

### 图像（`vision.ts`）

一张 8×8 RGB 小图切成 4 个 4×4 patch，每个展平成 48 个数，线性投影成 d_model 维，插进文本序列。对应 ViT 的 patch embedding（Fuyu 就是这样直接送进解码器；LLaVA 等中间还有视觉编码器，本站省掉了）。

| 签名 | 说明 |
|---|---|
| `SAMPLE_IMAGE: Image`、`PALETTE` | 示例图（天空、太阳、云、草地、一朵花），`data` 是 HWC 排列的 0–255 |
| `patchify(image, patch): Patch[]` | 切块：每块的 `row`、`col`、原始 `bytes`、归一化后的 `values` |
| `normalizePixel(byte)` | (x/255 − 0.5)/0.5 → [−1, 1] |
| `patchEmbed(VISION, image, meter?): PatchEmbedTrace` | `patches`、`projected`（W·x）、`vectors`（+ 偏置 + 位置嵌入）、`meter` |
| `imageInputs(trace)`、`spliceImage(textInputs, at, imageInputs)` | 变成 `forwardEmbeds` 的输入、插到文本的第 at 个位置 |
| `ppmBytes(image)` | PPM（P6）文件的字节，最简单的真实图像格式 |
| `makeVisionConfig`、`initVisionWeights`、`numPatches`、`patchDim`、`visionFor` | 配置和权重 |

### 权重文件（`weights.ts`）

| 签名 | 说明 |
|---|---|
| `serializeWeights(W, tok, train): WeightsFile`、`deserializeWeights(file, tok)` | 仿 safetensors：header 记录每个张量的 dtype、形状（行优先）、字节区间，data 是 fp32 小端字节（base64） |
| `tokenizerFingerprint(tok)` | 合并表指纹。分词器变了而权重没重训时，加载会报错 |

## 引擎模拟（`src/engine/`）

推理组课程用的账本和调度模拟，仿 vLLM 的做法。这个目录没有 `index.ts`，直接从各文件导入，比如 `import { roofline, H100 } from '../engine/roofline'`。FLOPs 的约定和 `src/model/` 一致（每次乘加 2 FLOPs）。迷你模型的数会和 `forward` 的 `FlopMeter` 逐位核对，测试在 `tests/engine.test.ts`。

### 账本（`roofline.ts`）

| 签名 | 说明 |
|---|---|
| `interface ArchConfig { name; layers; dModel; heads; kvHeads; headDim; ffn; vocab; context }` | decoder-only（LLaMA 结构）的形状。`kvHeads < heads` 即 GQA |
| `LLAMA3_8B: ArchConfig`、`LLAMA31_CONTEXT: number` | Llama 3 8B 的公开配置（32 层，8 个 KV 头），以及 Llama 3.1 的上下文窗口 131072 |
| `archOf(config: ModelConfig, name?: string): ArchConfig` | 把迷你模型的配置换成同一种描述，公式两边共用 |
| `paramsOf(arch: ArchConfig): ParamBreakdown` | 参数量，拆成嵌入表、每层矩阵、每层 RMSNorm、输出层、最终 RMSNorm，并给出总数 |
| `forwardFlops(arch, start, n, lastOnly?): FlopBreakdown` | 一次前向处理位置 start..start+n−1 的 FLOPs，拆成线性层、注意力、输出层。`lastOnly` 时输出层只算最后一个位置 |
| `weightBytesRead(arch, n, bytesPerWeight): number` | 一次前向从显存读出的权重字节。矩阵整块读一遍，不管处理几个位置 |
| `miniWeightBytesRead(W: Weights, n, bytesPerWeight): number` | 同上，直接从迷你模型的权重形状数，用来和公式核对 |
| `kvBytesPerToken(arch, bytesPerValue): number` | 每个 token 的 KV cache 字节数：2 × 层数 × KV 头数 × head_dim × 每个数的字节数 |
| `miniKvBytesPerToken(config: ModelConfig, bytesPerValue): number` | 迷你模型的同一个数，由 `KVCache.valuesPerToken` 得到 |
| `interface GpuSpec { name; flops; bandwidth; memory }` | 一块 GPU 的算力（FLOPs/s）、显存带宽（字节/s）和显存容量 |
| `H100: GpuSpec` | H100 SXM 的规格：稠密 BF16 989 TFLOPS，显存带宽 3.35 TB/s，80 GB |
| `interface Roofline { compute; memory; time; bound; intensity }` | roofline 的结果：只算力的时间、只带宽的时间、两者取大的下限、瓶颈在哪边、算术强度 |
| `roofline(flops, bytes, gpu): Roofline` | roofline 时间下限。算和读可以重叠，所以取两者中较大的 |
| `ridgePoint(gpu): number` | 拐点（FLOPs/字节）：算术强度高于它是算力受限，低于它是访存受限 |
| `GiB`、`MiB`、`KiB: number` | 字节单位（1024 进制） |

### 前缀缓存（`prefix.ts`）

块哈希是链式的：`hash(父块哈希, 本块的 token id)`，所以前面任何一个 token 不同，后面的块哈希也不同。哈希函数用 64 位 FNV-1a 代替 vLLM 的内置哈希，链式结构和命中规则相同。

| 签名 | 说明 |
|---|---|
| `fnv1a64(bytes: readonly number[]): bigint` | 64 位 FNV-1a（实现在 `@explorer/llm-core/hash`，这里转导出） |
| `u64Bytes(value: bigint): number[]`、`ROOT_HASH: bigint` | u64 小端字节；没有父块时用的哈希（0n） |
| `interface BlockKey { index; tokens; parent; hash; bytes }` | 一个满块的逻辑块号、token、父哈希、自己的哈希，以及参与哈希的字节 |
| `blockHash(parent: bigint, tokens: readonly number[]): { hash; bytes }` | 一块的哈希：父哈希的 u64 小端字节加上每个 token 的 int32 小端字节 |
| `blockKeys(tokens, blockSize): BlockKey[]` | 把序列切成满块并逐块算链式哈希，最后不满的一块不算 |
| `interface CachedBlock extends BlockKey` | 缓存里的一块：多了物理块号、每层的 K、V，以及被复用的次数 |
| `interface PrefixMatch { keys; hits; missAt; reused }` | 逐块查表的结果：全部满块、连续命中的块、第一个未命中的块号、复用的位置数 |
| `interface PrefillResult extends PrefixMatch` | 预填充的结果：只对未命中的位置做的前向 `trace`、拼好的 `cache`、实际算的位置数 `computed`、这次新写入的块 `inserted` |
| `class PrefixCache { blocks; constructor(blockSize); match(tokens); restore(weights, hits); insert(tokens, cache); prefill(weights, tokens, meter?) }` | 前缀缓存。`match` 最多复用到倒数第二个位置，因为最后一个位置要重算才有 logits；`prefill` 查表、复用、只算剩下的位置，再把新的满块写回 |
| `shortHash(hash: bigint): string`、`fullHash(hash: bigint): string` | 画在格子里的短哈希（前 4 位十六进制）和完整的 `0x` 写法 |

### 分页与调度（`paged.ts`）

| 签名 | 说明 |
|---|---|
| `class BlockAllocator { free; constructor(numBlocks, blockSize); allocate(): number; release(blocks); get used() }` | KV cache 的物理块分配器，空闲块先进先出，用一块取一块 |
| `blocksFor(positions: number, blockSize: number): number` | 放下这么多个位置要几块 |
| `interface Request { id; prompt; maxTokens }` | 一个请求：提示词和最多生成的 token 数（即 API 的 `max_tokens`） |
| `type SeqStatus = 'waiting' \| 'running' \| 'finished'` | 请求的三种状态 |
| `interface Sequence` | 调度器里一个请求的完整状态：请求、状态、KV cache、块表、已生成的 token、进出的轮次、结束原因 |
| `interface SeqSnapshot` | 某一轮结束时一个请求的快照：状态、位置数、块表、输出 |
| `interface Iteration` | 一轮调度的记录：接纳、预填充、解码、采样、结束、分配和释放的块、累计和本轮的 FLOPs |
| `interface SchedulerOptions { numBlocks; blockSize; maxSeqs; policy; eos }` | 调度参数。`policy` 为 `continuous`（迭代级调度）或 `static`（整批结束才接下一批） |
| `class Scheduler { allocator; seqs; meter; log; constructor(weights, options); add(request); get done; step(): Iteration; run(limit?): Iteration[] }` | 调度器。`step` 跑一轮：先接纳，再让新请求预填充、老请求各解码 1 个 token，结束的请求当轮释放块。模型计算调用 `forward` |
| `reservedSlots(seqs, maxSeq): { reserved; used }` | 对照：「按最大长度预留」时占用的位置数 |
| `pagedSlots(seqs, blockSize): { reserved; used }` | 对照：分页时已分配块的位置数，差值只出现在每个请求的最后一块里 |

## 写字节的层（`src/decode/structures.ts`）

每个函数返回一层 `LayerWriter`，`wire(at, view, fidelity, ...layers)` 拼成一个事件的解码结构。

| 签名 | 说明 |
|---|---|
| `utf8Text(name, text, options?)` | 每个字符一个字段，多字节字符拆出首字节、续字节 |
| `rawBytes(name, bytes, { groups? })` | 按组（比如每个 token）写原始字节 |
| `tokenIds(name, ids, { labels?, notes? })` | int32 小端的 id 数组 |
| `floatVector(name, values, 'f32' \| 'f16' \| 'bf16', { names?, bits?, digits? })` | 浮点向量。`bits: true` 时按位展示符号、指数、尾数 |
| `floatMatrix(name, rows, format?, options?)` | 行优先的浮点矩阵 |
| `q8_0Block(name, block)`、`q4_0Block(name, block)` | GGUF 量化块，Q4_0 的每个字节拆成高低两个 4 位 |
| `u32Var(name, value)`、`concept(name, fields)` | 标量；概念结构（没有字节，配 `示意`） |
| `num(value, digits?)` | 数值显示：最多 4 位小数，负号用 −，极小值用科学计数法 |

## 增加一节课

1. 新建 `src/lessons/<id>.ts`，导出 `Lesson`，`id` 和 `group` 必须和 `index.ts` 的 `PLANNED` 一致。计算从 `../model` 取，事件用 `dsl.ts` 的 `pk`、`note`、`state`、`show`。每个事件带上此刻的图元（`ds`）和字节结构（`wire`）。
2. 在 `index.ts` 里 import 它，加进 `PLANNED` 和 `LESSONS`，两边顺序一致。
3. 在 `tests/narrative.<组>.test.ts`（`repr` / `infer` / `sample`；bpe 在 `narrative.test.ts`）里加这节课的文案核对。`tests/lessons.test.ts` 会自动检查步骤数（4–6）、detail 句数（2–4）、节点显示顺序、运算量单调、字段范围、通道和数据结构是否重叠。
4. e2e 和首页的课数都从 `LESSONS` 取，不用改。
5. 文案里用了新的符号（不是中文），重新运行字体裁剪脚本。
