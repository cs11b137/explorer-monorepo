/**
 * 课程清单。PLANNED 是全部 14 节课的最终顺序和分组，是唯一的事实来源：
 * 单元测试和 e2e 都按它核对已实现的课是否排在正确的位置，首页测试按 LESSONS.length 核对课数。
 *
 * 新增一节课：
 *   1. 新建 src/lessons/<id>.ts，导出一个 Lesson（id、group 必须和 PLANNED 一致）；
 *   2. 在下面 import 它，加进 LESSONS（顺序和 PLANNED 一致）；
 *   3. 在对应的 narrative 测试里加这节课的文案核对：embed 组在 tests/narrative.test.ts，index 组在
 *      tests/narrative.index.test.ts，pipeline 组前三课在 narrative.pipeline.test.ts、后三课在 narrative.pipeline-b.test.ts。
 */
import { embedtext } from './embedtext';
import { similarity } from './similarity';
import { chunking } from './chunking';
import { flat } from './flat';
import { ivf } from './ivf';
import { hnsw } from './hnsw';
import { pq } from './pq';
import { hybrid } from './hybrid';
import { ingest } from './ingest';
import { qa } from './qa';
import { rerank } from './rerank';
import { rewrite } from './rewrite';
import { evaluate } from './evaluate';
import { finetune } from './finetune';
import type { Lesson, LessonGroup } from './types';

/** 14 节课的 id、分组和标题，按播放顺序。 */
export const PLANNED: ReadonlyArray<{ id: string; group: LessonGroup; title: string }> = [
  // ---------- 嵌入：文字怎样变成可以比较的向量 ----------
  { id: 'embedtext', group: 'embed', title: '文本变向量' },
  { id: 'similarity', group: 'embed', title: '相似度：余弦、点积与归一化' },
  { id: 'chunking', group: 'embed', title: '分块策略与重叠' },
  // ---------- 向量检索：怎样在很多向量里快速找到最近的几个 ----------
  { id: 'flat', group: 'index', title: '暴力 kNN（Flat）' },
  { id: 'ivf', group: 'index', title: 'IVF：聚类与倒排' },
  { id: 'hnsw', group: 'index', title: 'HNSW：分层图的插入与查询' },
  { id: 'pq', group: 'index', title: '乘积量化 PQ' },
  { id: 'hybrid', group: 'index', title: '元数据过滤与混合检索（BM25 + 向量，RRF）' },
  // ---------- RAG 流水线：从文档到带引用的回答 ----------
  { id: 'ingest', group: 'pipeline', title: '索引流水线：从文档到向量库' },
  { id: 'qa', group: 'pipeline', title: '一次检索增强问答（检索 → 拼提示 → 生成 → 引用）' },
  { id: 'rerank', group: 'pipeline', title: '重排序' },
  { id: 'rewrite', group: 'pipeline', title: '失败案例与查询改写' },
  { id: 'evaluate', group: 'pipeline', title: 'RAG 评估' },
  { id: 'finetune', group: 'pipeline', title: 'RAG 和微调怎么选' },
];

export const LESSONS: Lesson[] = [embedtext, similarity, chunking, flat, ivf, hnsw, pq, hybrid, ingest, qa, rerank, rewrite, evaluate, finetune];

export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
