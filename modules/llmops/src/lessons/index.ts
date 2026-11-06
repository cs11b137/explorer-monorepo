/**
 * 课程清单。PLANNED 是全部 13 节课的最终顺序和分组，是唯一的事实来源：
 * 单元测试和 e2e 都按它核对已实现的课是否排在正确的位置，首页测试按 LESSONS.length 核对课数。
 *
 * 新增一节课：
 *   1. 新建 src/lessons/<id>.ts，导出一个 Lesson（id、group 必须和 PLANNED 一致）；
 *   2. 在下面 import 它，加进 LESSONS（顺序和 PLANNED 一致）；
 *   3. 在对应的 narrative 测试里加这节课的文案核对：safety 组在 tests/narrative.test.ts（redteam、bias 在 tests/narrative.redteam.test.ts），
 *      eval 组在 tests/narrative.eval.test.ts，observe 组在 tests/narrative.observe.test.ts。
 */
import { direct } from './direct';
import { indirect } from './indirect';
import { moderation } from './moderation';
import { abuse } from './abuse';
import { redteam } from './redteam';
import { bias } from './bias';
import { deterministic } from './deterministic';
import { judge } from './judge';
import { human } from './human';
import { regression } from './regression';
import { trace } from './trace';
import { cost } from './cost';
import { monitor } from './monitor';
import type { Lesson, LessonGroup } from './types';

/** 13 节课的 id、分组和标题，按播放顺序。 */
export const PLANNED: ReadonlyArray<{ id: string; group: LessonGroup; title: string }> = [
  // ---------- 安全：挡住注入和滥用 ----------
  { id: 'direct', group: 'safety', title: '直接提示注入：检测与拦截' },
  { id: 'indirect', group: 'safety', title: '间接提示注入：隔离与筛查' },
  { id: 'moderation', group: 'safety', title: '输入输出防护：审核与脱敏' },
  { id: 'abuse', group: 'safety', title: '用户标识与滥用追踪' },
  { id: 'redteam', group: 'safety', title: '红队测试与攻击成功率' },
  { id: 'bias', group: 'safety', title: '偏见检测：成对提示' },
  // ---------- 评估：知道它答得好不好 ----------
  { id: 'deterministic', group: 'eval', title: '确定性评估：匹配、正则与 Schema' },
  { id: 'judge', group: 'eval', title: 'LLM 当评委：评分标准与位置偏差' },
  { id: 'human', group: 'eval', title: '人工评估与一致性' },
  { id: 'regression', group: 'eval', title: '回归测试：改提示前后' },
  // ---------- 可观测性：线上出了问题看得见 ----------
  { id: 'trace', group: 'observe', title: '一次请求的 trace' },
  { id: 'cost', group: 'observe', title: '成本与延迟拆账' },
  { id: 'monitor', group: 'observe', title: '生产监控与回流' },
];

export const LESSONS: Lesson[] = [direct, indirect, moderation, abuse, redteam, bias, deterministic, judge, human, regression, trace, cost, monitor];

export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
