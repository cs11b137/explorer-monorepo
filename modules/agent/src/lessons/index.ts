/**
 * 课程清单。PLANNED 是全部 13 节课的最终顺序和分组，是唯一的事实来源：
 * 单元测试和 e2e 都按它核对已实现的课是否排在正确的位置，首页测试按 LESSONS.length 核对课数。
 *
 * 新增一节课：
 *   1. 新建 src/lessons/<id>.ts，导出一个 Lesson（id、group 必须和 PLANNED 一致）；
 *   2. 在下面 import 它，加进 LESSONS（顺序和 PLANNED 一致）；
 *   3. 在对应的 narrative 测试里加这节课的文案核对：loop 组在 tests/narrative.test.ts，mcp 组在 tests/narrative.mcp.test.ts，
 *      multi 组在 tests/narrative.multi.test.ts。
 */
import { react } from './react';
import { tooldefs } from './tooldefs';
import { parallel } from './parallel';
import { stopping } from './stopping';
import { sdks } from './sdks';
import { discover } from './discover';
import { toolscall } from './toolscall';
import { resources } from './resources';
import { stdio } from './stdio';
import { http } from './http';
import { orchestrate } from './orchestrate';
import { handoff } from './handoff';
import { approval } from './approval';
import type { Lesson, LessonGroup } from './types';

/** 13 节课的 id、分组和标题，按播放顺序。 */
export const PLANNED: ReadonlyArray<{ id: string; group: LessonGroup; title: string }> = [
  // ---------- Agent 循环：模型决定，运行时执行 ----------
  { id: 'react', group: 'loop', title: 'ReAct：思考 → 行动 → 观察' },
  { id: 'tooldefs', group: 'loop', title: '工具定义如何进入提示' },
  { id: 'parallel', group: 'loop', title: '并行工具调用与结果回填' },
  { id: 'stopping', group: 'loop', title: '工具报错、最大轮数与停止' },
  { id: 'sdks', group: 'loop', title: '手写循环 vs SDK' },
  // ---------- MCP 协议：工具从哪里来 ----------
  { id: 'discover', group: 'mcp', title: '无状态协议：版本、能力与 server/discover' },
  { id: 'toolscall', group: 'mcp', title: 'tools/list 与 tools/call' },
  { id: 'resources', group: 'mcp', title: 'resources 与 prompts' },
  { id: 'stdio', group: 'mcp', title: 'stdio 传输' },
  { id: 'http', group: 'mcp', title: 'Streamable HTTP 传输与授权' },
  // ---------- 多 Agent：谁来做、谁说了算 ----------
  { id: 'orchestrate', group: 'multi', title: '编排者与子 Agent' },
  { id: 'handoff', group: 'multi', title: 'Agent 间转交（handoff）' },
  { id: 'approval', group: 'multi', title: '工具权限与人工确认' },
];

export const LESSONS: Lesson[] = [react, tooldefs, parallel, stopping, sdks, discover, toolscall, resources, stdio, http, orchestrate, handoff, approval];

export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
