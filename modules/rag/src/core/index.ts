/**
 * 计算核心的统一入口。课程从这里取：
 *   import { embed, flatSearch, buildIvf, buildHnsw, trainPq, rrf, buildPrompt, ... } from '../core';
 *
 * - kb.ts：内置知识库（网店「小铺」的规则、商品、售后文档）和标注好的评估问题
 * - chunk.ts：固定长度、按句、递归切分，带重叠；每块的字符、字节区间和 token 数
 * - embed.ts：本站的嵌入模型（在知识库段落上训练的 16 维 LSA）
 * - linalg.ts：对称矩阵的 Jacobi 特征分解（嵌入模型的训练用）
 * - vector.ts：点积、余弦、欧氏距离，float32 / float16 / int8 编码，base64
 * - meter.ts：距离计算次数（轨迹表「距离」列）
 * - flat.ts：暴力 kNN
 * - kmeans.ts：k-means（IVF 和 PQ 的训练）
 * - ivf.ts：IVF 倒排索引
 * - hnsw.ts：HNSW 分层图
 * - pq.ts：乘积量化和 ADC
 * - hybrid.ts：召回率、元数据过滤、BM25 检索、RRF 融合
 * - rerank.ts：重排序（交叉打分的本站替身）
 * - rag.ts：拼提示、核对引用、Claude 的 search_result 块
 * - eval.ts：context precision / recall、faithfulness 的近似
 * - api.ts：OpenAI embeddings 的请求和响应；Claude Messages API 的请求和响应（问答课）
 * - ingest.ts：索引流水线的原始文件、加载清洗、每块一条记录（ingest 课）
 * - bench.ts：规模实验用的合成数据集（1000 个向量，索引组的课用）
 *
 * 分词器、BM25、JSON、HTTP、随机数、浮点位模式来自共享包 @explorer/llm-core。接口说明见 modules/rag/README.md。
 */
export * from './api';
export * from './bench';
export * from './chunk';
export * from './embed';
export * from './eval';
export * from './flat';
export * from './hnsw';
export * from './hybrid';
export * from './ingest';
export * from './ivf';
export * from './kb';
export * from './kmeans';
export * from './linalg';
export * from './meter';
export * from './pq';
export * from './rag';
export * from './rerank';
export * from './vector';
export { bm25, termsOf, BM25_B, BM25_K1, type Bm25Doc, type Bm25Scored, type TermScore } from '@explorer/llm-core/bm25';
export { encodeJson, spanOf, childrenOf, jsonSize, type JsonBytes, type JsonSpan } from '@explorer/llm-core/json';
export { encodeRequest, encodeResponse, makeRequest, makeResponse, parseMessage, headerOf, type HttpLayout, type Header } from '@explorer/llm-core/http';
