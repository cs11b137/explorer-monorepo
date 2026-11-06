/**
 * 课程清单。PLANNED 是全部 14 节课的最终顺序和分组，是唯一的事实来源：
 * 单元测试和 e2e 都按它核对已实现的课是否排在正确的位置，首页测试按 LESSONS.length 核对课数。
 *
 * 新增一节课：
 *   1. 新建 src/lessons/<id>.ts，导出一个 Lesson（id、group 必须和 PLANNED 一致）；
 *   2. 在下面 import 它，加进 LESSONS（顺序和 PLANNED 一致）；
 *   3. 在 tests/narrative.<组>.test.ts 里加这节课的文案核对（messages 在 tests/narrative.test.ts）。
 */
import { messages } from './messages';
import { sse } from './sse';
import { dialects } from './dialects';
import { retry } from './retry';
import { caching } from './caching';
import { fewshot } from './fewshot';
import { structured } from './structured';
import { template } from './template';
import { toolcall } from './toolcall';
import { budget } from './budget';
import { compaction } from './compaction';
import { memory } from './memory';
import { failure } from './failure';
import { isolation } from './isolation';
import type { Lesson, LessonGroup } from './types';

/** 14 节课的 id、分组和标题，按播放顺序。 */
export const PLANNED: ReadonlyArray<{ id: string; group: LessonGroup; title: string }> = [
  // ---------- 接口：一次调用在 HTTP 和 JSON 层面长什么样 ----------
  { id: 'messages', group: 'api', title: '一次 Messages API 调用' },
  { id: 'sse', group: 'api', title: 'SSE 流式事件序列' },
  { id: 'dialects', group: 'api', title: '同一请求的三种写法（Claude Messages / OpenAI Responses / OpenAI 兼容接口如 Ollama、OpenRouter）' },
  { id: 'retry', group: 'api', title: '限流、错误与重试' },
  // ---------- 提示：消息怎样变成模型读到的 token ----------
  { id: 'template', group: 'prompt', title: 'system、角色和约束如何经 chat template 变成 token 序列' },
  { id: 'fewshot', group: 'prompt', title: 'zero-shot / few-shot / CoT 对比' },
  { id: 'structured', group: 'prompt', title: '结构化输出（API 层）' },
  { id: 'toolcall', group: 'prompt', title: '函数调用的一个往返' },
  { id: 'caching', group: 'prompt', title: 'Prompt Caching 在 API 层（缓存断点、命中计费）' },
  // ---------- 上下文工程：窗口里放什么、放不下怎么办 ----------
  { id: 'budget', group: 'context', title: '上下文预算拆账' },
  { id: 'compaction', group: 'context', title: '上下文压缩' },
  { id: 'memory', group: 'context', title: '记忆系统写入与召回' },
  { id: 'failure', group: 'context', title: '长上下文与上下文失效模式（中段遗忘、污染、冲突）' },
  { id: 'isolation', group: 'context', title: '上下文隔离与上下文安全' },
];

export const LESSONS: Lesson[] = [messages, sse, dialects, retry, template, fewshot, structured, toolcall, caching, budget, compaction, memory, failure, isolation];

export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
