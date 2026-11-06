/**
 * Agent 循环引擎。模型每一轮「说什么」是课程写好的脚本（示例，E.G.），循环本身是真的：
 *
 *   组装请求（system + tools + 到目前为止的全部消息）→ 按 ChatML 展开数 token（加上文档给的工具系统提示）→
 *   用脚本里的内容块构造响应（createMessage：stop_reason、max_tokens 截断、usage 都真实计算）→
 *   把助手消息原样追加进历史 → stop_reason 是 tool_use 就逐个执行工具（tools.ts，可经过权限检查）→
 *   把 tool_result 按 tool_use 的顺序放进同一条 user 消息 → 判断停止条件（end_turn、max_tokens、最大轮数）→ 下一轮。
 *
 * 每一轮记账：这一轮的输入 / 输出 token、按示例单价算的费用，以及到这一轮为止的累计（Totals）。轨迹表第一列「累计输入 token」
 * 就取 `turn.after.input`。请求和响应的 HTTP 字节也在这里编码好，课程直接拿去展示。
 *
 * 多 Agent 的两种写法也在这里：agentTool 把一个子 Agent 包成工具（编排者调用它，子 Agent 在自己的上下文里跑完一整个循环，
 * 只把最后的回答交回）；handoffTool 是转交（模型调用 transfer_to_<name>，之后的轮次换成目标 Agent 的 system 和工具，历史不变）。
 */
import { createMessage, inputBreakdown, messagesHttpRequest, messagesHttpResponse, MODELS, type ContentBlock, type ContentBlockParam, type InputBreakdown, type Message, type MessageParam, type MessagesRequest, type StopReason, type TextBlock, type ToolChoice, type ToolResultBlockParam, type ToolUseBlock } from '@explorer/llm-core/anthropic';
import { encodeRequest, encodeResponse, type HttpLayout } from '@explorer/llm-core/http';
import { EXAMPLE_EPOCH, exampleId, httpDate } from '@explorer/llm-core/ids';
import { costOf, type Cost } from '@explorer/llm-core/pricing';
import type { ToolBox, ToolContext, ToolOutcome, ToolSpec } from './tools';

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** 每次调用的 max_tokens 默认值。 */
export const DEFAULT_MAX_TOKENS = 1024;
/** 本站循环的默认最大轮数（模型调用次数）。OpenAI Agents SDK 的 DEFAULT_MAX_TURNS 也是 10；Claude Agent SDK 默认不限。 */
export const DEFAULT_MAX_TURNS = 10;

export interface AgentConfig {
  /** Agent 的名字：转交工具名 transfer_to_<name>、轨迹里标是谁在说话。 */
  name: string;
  model: string;
  system: string;
  tools: ToolBox;
  maxTokens?: number;
  toolChoice?: ToolChoice;
}

/** 累计账：模型调用了几轮、输入 / 输出 token、费用（纳美元，整数）。 */
export interface Totals {
  turns: number;
  input: number;
  output: number;
  cost: number;
}

export const ZERO: Totals = { turns: 0, input: 0, output: 0, cost: 0 };
export const addTotals = (a: Totals, b: Totals): Totals => ({ turns: a.turns + b.turns, input: a.input + b.input, output: a.output + b.output, cost: a.cost + b.cost });

export interface ToolCall {
  use: ToolUseBlock;
  outcome: ToolOutcome;
  /** 回填给模型的 tool_result 块。 */
  result: ToolResultBlockParam;
  /** 权限检查没有放行（结果是拒绝说明，工具没有执行）。 */
  denied: boolean;
}

export interface AgentTurn {
  /** 第几轮，从 1 起。 */
  index: number;
  /** 这一轮是哪个 Agent（转交之后会变）。 */
  agent: string;
  request: MessagesRequest;
  /** 输入 token 的构成（ChatML 展开）。 */
  breakdown: InputBreakdown;
  /** 带工具时 API 自动加的工具系统提示 token（文档给的数，见 MODELS[model].toolSystemTokens），已计入 usage.input_tokens。 */
  toolSystem: number;
  message: Message;
  cost: Cost;
  calls: ToolCall[];
  /** 这一轮之前、之后的累计。 */
  before: Totals;
  after: Totals;
  http: { request: HttpLayout; response: HttpLayout };
}

/** 循环停下的原因：模型的 stop_reason，或者循环自己的上限。 */
export type StopKind = StopReason | 'max_turns';

export interface AgentRun {
  agent: string;
  turns: AgentTurn[];
  /** 最后的完整消息历史（含最后一条助手消息）。 */
  messages: MessageParam[];
  stop: StopKind;
  /** 最后一条助手消息的文字。 */
  final: string;
  /** 这个 Agent 自己的累计（不含子 Agent）。 */
  totals: Totals;
  /** 工具调用里跑过的子 Agent（agentTool）。 */
  children: AgentRun[];
}

/** 脚本每一轮给模型「写」的内容块（示例）。可以是函数：拿到此刻的历史和上一轮的工具结果再决定写什么。 */
export interface ScriptView {
  turn: number;
  agent: string;
  messages: readonly MessageParam[];
  /** 上一轮的工具调用。 */
  lastCalls: readonly ToolCall[];
  /** 到目前为止的全部工具调用。 */
  calls: readonly ToolCall[];
}
export type ScriptStep = readonly ContentBlock[] | ((view: ScriptView) => ContentBlock[]);

export type Permit = { allow: true } | { allow: false; reason: string };

export interface RunOptions {
  ctx: ToolContext;
  maxTurns?: number;
  /** 示例 id 的种子：第 n 轮的 msg / req id 用 seed + n。 */
  seed?: number;
  /** 之前的对话（不含这次的用户输入）。 */
  history?: MessageParam[];
  /** 执行工具前的权限检查。不放行时不执行，tool_result 写拒绝原因、is_error。 */
  permit?: (use: ToolUseBlock, spec: ToolSpec | undefined, agent: string) => Permit;
  /** 转交的目标：名字 → 配置。 */
  agents?: Record<string, AgentConfig>;
}

/** 脚本里的写法：一段文字。 */
export const text = (value: string): TextBlock => ({ type: 'text', text: value });
/** 脚本里的写法：一次工具调用，id 用固定种子的示例 toolu_…。 */
export const toolUse = (name: string, input: Record<string, unknown>, seed: number): ToolUseBlock => ({ type: 'tool_use', id: exampleId('toolu', seed), name, input });

/** 一个请求要加的工具系统提示 token：有工具、tool_choice 是 auto / none（或不写）时用文档的数。 */
export function toolSystemTokens(req: MessagesRequest): number {
  if (!req.tools?.length) return 0;
  const choice = req.tool_choice?.type ?? 'auto';
  if (choice !== 'auto' && choice !== 'none') throw new Error(`本站只记了 tool_choice 为 auto / none 时的工具系统提示 token，不支持 ${choice}`);
  return MODELS[req.model]?.toolSystemTokens ?? 0;
}

/** 组装第 n 轮的请求：消息历史整份带上（API 无状态）。 */
export function buildRequest(config: AgentConfig, messages: readonly MessageParam[]): MessagesRequest {
  const tools = config.tools.definitions();
  return {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: config.system,
    ...(tools.length ? { tools } : {}),
    ...(config.toolChoice ? { tool_choice: config.toolChoice } : {}),
    messages: messages.map((message) => ({ ...message })),
  };
}

/** 最后一条助手消息里的文字（多个 text 块直接相连）。 */
export const textOf = (message: Pick<Message, 'content'>): string => message.content.filter((block): block is TextBlock => block.type === 'text').map((block) => block.text).join('');

/**
 * 跑一个 Agent：从用户的一句话开始，一轮轮调用模型（脚本）和工具，直到停下。
 * 脚本的轮数必须够用：模型还要说话却没有脚本了会报错（课程写错了），而不是悄悄停下。
 */
export function runAgent(config: AgentConfig, user: string | ContentBlockParam[], script: readonly ScriptStep[], options: RunOptions): AgentRun {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const seed = options.seed ?? 100;
  const messages: MessageParam[] = [...(options.history ?? []), { role: 'user', content: user }];
  const turns: AgentTurn[] = [];
  const children: AgentRun[] = [];
  let totals: Totals = ZERO;
  let current = config;
  let lastCalls: ToolCall[] = [];
  const allCalls: ToolCall[] = [];
  let stop: StopKind = 'end_turn';
  for (let index = 1; ; index++) {
    const step = script[index - 1];
    if (!step) throw new Error(`${current.name} 的脚本只有 ${script.length} 轮，第 ${index} 轮没有可写的内容`);
    const reply = typeof step === 'function' ? step({ turn: index, agent: current.name, messages, lastCalls, calls: allCalls }) : step;
    const request = buildRequest(current, messages);
    const breakdown = inputBreakdown(request);
    const toolSystem = toolSystemTokens(request);
    const raw = createMessage(request, reply, { id: exampleId('msg', seed + index) });
    // 文档：带 tools 时自动加的系统提示计入 input_tokens。本站的模板展开不含它，这里加上。
    const message: Message = { ...raw, usage: { ...raw.usage, input_tokens: raw.usage.input_tokens + toolSystem } };
    const cost = costOf(message.usage, current.model);
    const before = totals;
    totals = addTotals(totals, { turns: 1, input: message.usage.input_tokens, output: message.usage.output_tokens, cost: cost.total });
    messages.push({ role: 'assistant', content: message.content.map((block) => ({ ...block })) });
    const http = {
      request: encodeRequest(messagesHttpRequest(request)),
      response: encodeResponse(messagesHttpResponse(message, { requestId: exampleId('req', seed + index), date: httpDate(EXAMPLE_EPOCH) })),
    };
    const calls: ToolCall[] = [];
    let handoff: AgentConfig | null = null;
    if (message.stop_reason === 'tool_use') {
      for (const use of message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')) {
        const spec = current.tools.get(use.name);
        const permit = options.permit?.(use, spec, current.name) ?? { allow: true };
        const outcome: ToolOutcome = permit.allow ? current.tools.call(use.name, use.input, options.ctx) : { content: permit.reason, is_error: true };
        if (outcome.child) children.push(outcome.child);
        if (permit.allow && !outcome.is_error && spec?.handoff) {
          const target = options.agents?.[spec.handoff];
          if (!target) throw new Error(`转交的目标 ${spec.handoff} 不在 agents 里`);
          handoff = target;
        }
        const result: ToolResultBlockParam = { type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.is_error ? { is_error: true } : {}) };
        calls.push({ use, outcome, result, denied: !permit.allow });
      }
      // 文档：并行调用的全部 tool_result 放在同一条 user 消息里，而且要排在任何文字之前。
      messages.push({ role: 'user', content: calls.map((call) => call.result) });
    }
    turns.push({ index, agent: current.name, request, breakdown, toolSystem, message, cost, calls, before, after: totals, http });
    lastCalls = calls;
    allCalls.push(...calls);
    if (message.stop_reason !== 'tool_use') {
      stop = message.stop_reason;
      break;
    }
    if (index >= maxTurns) {
      stop = 'max_turns';
      break;
    }
    if (handoff) current = handoff;
  }
  const last = turns[turns.length - 1].message;
  return { agent: config.name, turns, messages, stop, final: textOf(last), totals, children };
}

/** 一次运行连同全部子 Agent 的累计。 */
export const grandTotals = (run: AgentRun): Totals => run.children.reduce((sum, child) => addTotals(sum, grandTotals(child)), run.totals);

/**
 * 把一个子 Agent 包成工具：编排者调用它时传 task（一段文字），子 Agent 从这段文字开始在干净的上下文里跑完自己的循环，
 * 只有最后的回答作为 tool_result 交回编排者。子 Agent 的整次运行放在 outcome.child 里（课程画图、记账用）。
 */
export function agentTool(name: string, description: string, child: AgentConfig, script: readonly ScriptStep[], options: Omit<RunOptions, 'ctx' | 'history'> = {}): ToolSpec {
  return {
    name,
    description,
    input_schema: { type: 'object', properties: { task: { type: 'string', description: '交给子 Agent 的任务，写清楚要交回什么', minLength: 1 } }, required: ['task'], additionalProperties: false },
    hints: { readOnlyHint: false, openWorldHint: false },
    run(input, ctx) {
      const run = runAgent(child, String(input.task), script, { ...options, ctx });
      return { content: run.final, is_error: run.stop !== 'end_turn' || undefined, child: run };
    },
  };
}

/** 转交工具：名字 transfer_to_<target>（和 OpenAI Agents SDK 的写法一致）。调用成功后，循环换成目标 Agent 接着跑。 */
export function handoffTool(target: string, description: string): ToolSpec {
  return {
    name: `transfer_to_${target}`,
    description,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    hints: { readOnlyHint: true, openWorldHint: false },
    handoff: target,
    run: () => ({ content: JSON.stringify({ assistant: target }) }),
  };
}
