/**
 * 计算核心的统一入口。课程从这里取：
 *   import { detect, evaluateDetector, findPii, moderate, userIdOf, runEval, Tracer, otlpTraces, wilson, ... } from '../core';
 *
 * 本模块自己的：
 * - classifier.ts：规范化、字符 n-gram、特征哈希、逻辑回归（训练、预测、每个桶的贡献）
 * - injection.ts：注入检测的数据集、规则、检测器、在测试集上的评估、输出侧的系统提示泄露检查
 * - untrusted.ts：间接注入的隔离（JSON 包裹、带随机后缀的标签、工具结果先筛查）
 * - pii.ts：PII 识别（身份证校验码、Luhn）和脱敏（类型标签、部分打码、可还原的占位符）
 * - moderation.ts：本站的多标签审核分类器和处置策略
 * - abuse.ts：不透明的 user_id、每用户的令牌桶和滑动窗口、屡犯升级
 * - redteam.ts：变形、攻击成功率、成对提示和配对比较
 * - evals.ts：确定性评分器、评估报告、回归对比、评委的位置偏差和一致性
 * - stats.ts：混淆矩阵、精确率召回率、Wilson、kappa、精确二项检验、bootstrap、分位数、直方图
 * - trace.ts：trace / span id、traceparent、span 树、GenAI 语义约定属性、OTLP/JSON、概率采样
 * - latency.ts：模拟延迟和分位数、每次调用的费用
 * - monitor.ts：模拟流量、窗口指标、告警、尾部采样、回流成评估用例
 * - calls.ts：一次 Messages API 调用（usage、费用、HTTP 字节）
 *
 * 共享包 @explorer/llm-core 的 Messages API、计费、示例 id、JSON、HTTP、小铺的场景数据、JSON Schema 一并转导出。
 * 接口说明见 modules/llmops/README.md。
 */
export * from './stats';
export * from './classifier';
export * from './injection';
export * from './untrusted';
export * from './pii';
export * from './moderation';
export * from './abuse';
export * from './redteam';
export * from './evals';
export * from './trace';
export * from './latency';
export * from './monitor';
export * from './calls';

export * from '@explorer/llm-core/anthropic';
export * from '@explorer/llm-core/pricing';
export * from '@explorer/llm-core/ids';
export * from '@explorer/llm-core/json';
export * from '@explorer/llm-core/http';
export * from '@explorer/llm-core/shop';
export * from '@explorer/llm-core/schema';
export { countTokens } from '@explorer/llm-core/tokens';
export { sha256, hmacSha256, toHex } from '@explorer/llm-core/sha256';
export { TokenBucket } from '@explorer/llm-core/ratelimit';
export { utf8Encode, utf8Decode } from '@explorer/llm-core/utf8';
