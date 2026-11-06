/**
 * 课程清单。PLANNED 是全部 15 节课的最终顺序和分组，是唯一的事实来源：
 * 单元测试和 e2e 都按它核对已实现的课是否排在正确的位置，首页测试按 LESSONS.length 核对课数。
 *
 * 新增一节课：
 *   1. 新建 src/lessons/<id>.ts，导出一个 Lesson（id、group 必须和 PLANNED 一致）；
 *   2. 在下面 import 它，加进 PLANNED 和 LESSONS（两边顺序一致）；
 *   3. 在 tests/narrative.<组>.test.ts 里加这节课的文案核对（bpe 在 tests/narrative.test.ts）。
 */
import { bpe } from './bpe';
import { embed } from './embed';
import { attention } from './attention';
import { block } from './block';
import { vision } from './vision';
import { prefill } from './prefill';
import { kvcache } from './kvcache';
import { prefix } from './prefix';
import { batching } from './batching';
import { quant } from './quant';
import { temperature } from './temperature';
import { topk } from './topk';
import { constrained } from './constrained';
import { streaming } from './streaming';
import { lora } from './lora';
import type { Lesson, LessonGroup } from './types';

/** 15 节课的 id、分组和标题，按播放顺序。 */
export const PLANNED: ReadonlyArray<{ id: string; group: LessonGroup; title: string }> = [
  // ---------- 表示：文本怎样变成向量、向量怎样流过一层 ----------
  { id: 'bpe', group: 'repr', title: 'BPE 分词' },
  { id: 'embed', group: 'repr', title: '嵌入查表与 RoPE' },
  { id: 'attention', group: 'repr', title: '一次自注意力（QKV、因果掩码、softmax）' },
  { id: 'block', group: 'repr', title: '一层 Transformer 前向（残差、Norm、FFN）' },
  { id: 'vision', group: 'repr', title: '图像切 patch 变 token（多模态理解：ViT patch embedding）' },
  // ---------- 推理：引擎怎样把模型跑快、跑省 ----------
  { id: 'prefill', group: 'infer', title: '预填充与解码（TTFT / 每 token 延迟）' },
  { id: 'kvcache', group: 'infer', title: 'KV cache 增长与上下文窗口上限（显存字节账）' },
  { id: 'prefix', group: 'infer', title: '前缀缓存（Prompt Caching 原理）' },
  { id: 'batching', group: 'infer', title: '连续批处理与 PagedAttention' },
  { id: 'quant', group: 'infer', title: '量化（fp16 → int4，对应 GGUF / Ollama）' },
  // ---------- 采样与输出：logits 怎样变成文字 ----------
  { id: 'temperature', group: 'sample', title: 'logits → temperature → softmax' },
  { id: 'topk', group: 'sample', title: 'Top-K / Top-P / 重复惩罚' },
  { id: 'constrained', group: 'sample', title: '约束解码（结构化输出原理）' },
  { id: 'streaming', group: 'sample', title: '停止条件与流式输出（跨 token 的 UTF-8 拼接）' },
  { id: 'lora', group: 'sample', title: '训练一步与 LoRA 微调' },
];

export const LESSONS: Lesson[] = [
  bpe,
  embed,
  attention,
  block,
  vision,
  prefill,
  kvcache,
  prefix,
  batching,
  quant,
  temperature,
  topk,
  constrained,
  streaming,
  lora,
];

export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
