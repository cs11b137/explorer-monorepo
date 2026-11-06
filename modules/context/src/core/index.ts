/**
 * 计算核心的统一入口。课程从这里取：
 *   import { encodeJson, messagesHttpRequest, createMessage, renderRequest, costOf, ... } from '../core';
 *
 * - json.ts：JSON 序列化，记下每个值的字节区间
 * - http.ts：HTTP/1.1 报文的编码、解析、chunked
 * - sse.ts：SSE 的编码和按 WHATWG 规范的增量解析
 * - tokens.ts：token 计数（共享包 @explorer/llm-core 的迷你 BPE + ChatML 的两个特殊 token）
 * - template.ts：ChatML 模板展开，每个 token 归到请求的哪一部分
 * - anthropic.ts：Messages API 的校验、响应、流式事件、错误
 * - openai.ts：Chat Completions、Responses 两种写法，以及 OpenAI 兼容接口
 * - cache.ts：Prompt Caching 的断点、命中、写入
 * - pricing.ts：示例单价和计费
 * - budget.ts：上下文预算、截断和压缩
 * - context.ts：按轮次对齐、清理工具结果、定位、冲突、污染、包装不可信内容
 * - recall.ts：记忆召回（BM25）
 * - ids.ts：示例 id 和时间
 *
 * 接口说明见 modules/context/README.md。
 */
export * from './anthropic';
export * from './budget';
export * from './cache';
export * from './context';
export * from './http';
export * from './ids';
export * from './json';
export * from './openai';
export * from './pricing';
export * from './recall';
export * from './retry';
export * from './sse';
export * from './template';
export * from './tokens';
