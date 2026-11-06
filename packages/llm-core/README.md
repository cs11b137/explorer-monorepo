# @explorer/llm-core

LLM EXPLORER、CONTEXT EXPLORER 和 RAG EXPLORER 共用的计算核心：纯 TypeScript，确定性，不依赖浏览器。

| 文件 | 内容 |
|---|---|
| `src/utf8.ts` | UTF-8 编解码（RFC 3629）、每个字节的角色、流式解码 `Utf8Stream` |
| `src/corpus.ts` | 内置小语料 `CORPUS`、合并数 `NUM_MERGES`、结束符的显示文字 `EOS_TEXT` |
| `src/tokenizer.ts` | 字节级 BPE 分词器 `BpeTokenizer`，以及全站共用的实例 `TOKENIZER`（在 `CORPUS` 上学 96 条合并规则，词表 353） |
| `src/prng.ts` | 固定种子的随机数 `mulberry32`、`gaussian` |
| `src/hash.ts` | 64 位 FNV-1a `fnv1a64`、`u64Bytes` |
| `src/float.ts` | IEEE 754 fp32 / fp16 / bf16 的位模式和小端字节（`f32Bits`、`f16Bits`、`bf16Bits`、`*FromBits`、`*Round`、`*Bytes`）、`i32Bytes`。原在 llm 的 `numeric.ts`，llm 转导出；RAG 的向量编码用 |
| `src/bm25.ts` | 切词 `termsOf`（汉字二元组 + 小写的字母数字词）、`bm25` 打分（k1 = 1.2、b = 0.75，Lucene 的 idf 写法），`Bm25Doc`、`Bm25Scored`、`TermScore`。原在 context 的 `recall.ts`，context 转导出；RAG 的混合检索和嵌入模型的切词用 |
| `src/json.ts` | `encodeJson`（和 `JSON.stringify` 逐字节相同，记下每个值的字节区间）、`spanOf`、`childrenOf`、`jsonSize`。原在 context，context 转导出 |
| `src/http.ts` | HTTP/1.1 报文的编码、解析、chunked（`makeRequest`、`makeResponse`、`encodeRequest`、`encodeResponse`、`parseMessage`、`chunked`、`dechunk`、`headerOf`）。原在 context，context 转导出 |

按文件导入，比如 `import { TOKENIZER } from '@explorer/llm-core/tokenizer'`。接口说明见 `modules/llm/README.md` 的「计算核心接口」（分词器、UTF-8、随机数、浮点）和 `modules/context/README.md`（JSON、HTTP、BM25）；CONTEXT EXPLORER 在分词器上面加了两个 ChatML 特殊 token。RAG EXPLORER 的嵌入模型用 `termsOf` 切词，改切词规则会同时改变 context 的记忆召回和 rag 的全部数字。

改这里的语料或分词器，会同时改变 llm 的权重指纹和三门课的全部数字（rag 的 token 数、切块的 token 数）：改完运行 `npm run train -w llm-explorer` 重新训练，再跑 `npm test`，按报错改各门课的文案。
