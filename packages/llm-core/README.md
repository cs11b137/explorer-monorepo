# @explorer/llm-core

LLM EXPLORER 和 CONTEXT EXPLORER 共用的计算核心：纯 TypeScript，确定性，不依赖浏览器。

| 文件 | 内容 |
|---|---|
| `src/utf8.ts` | UTF-8 编解码（RFC 3629）、每个字节的角色、流式解码 `Utf8Stream` |
| `src/corpus.ts` | 内置小语料 `CORPUS`、合并数 `NUM_MERGES`、结束符的显示文字 `EOS_TEXT` |
| `src/tokenizer.ts` | 字节级 BPE 分词器 `BpeTokenizer`，以及全站共用的实例 `TOKENIZER`（在 `CORPUS` 上学 96 条合并规则，词表 353） |
| `src/prng.ts` | 固定种子的随机数 `mulberry32`、`gaussian` |
| `src/hash.ts` | 64 位 FNV-1a `fnv1a64`、`u64Bytes` |

按文件导入，比如 `import { TOKENIZER } from '@explorer/llm-core/tokenizer'`。接口说明见 `modules/llm/README.md` 的「计算核心接口」；CONTEXT EXPLORER 在它上面加了两个 ChatML 特殊 token，见 `modules/context/README.md`。

改这里的语料或分词器，会同时改变 llm 的权重指纹和两门课的全部数字：改完运行 `npm run train -w llm-explorer` 重新训练，再跑 `npm test`，按报错改两门课的文案。
