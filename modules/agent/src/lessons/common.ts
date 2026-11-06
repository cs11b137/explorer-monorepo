/**
 * 各课共用的小工具：把数组变成图元格子、全站统一的配色、消息历史画成一排内容块、每轮的账画成小表。
 * 课程里的数字一律从 core/ 的计算结果取，这里只负责「怎么画」。
 */
import { type AgentRun, type AgentTurn, type MessageParam, type RenderedPrompt } from '../core';
import type { Color, DsCell, GridPrim, RowPrim, Tone } from './types';

export { num, preview } from '../decode/structures';

export interface CellOptions {
  tones?: Record<number, Tone>;
  lift?: number[];
  /** 值的身份：同一个值换了位置时，动画是它移过去。 */
  keys?: Array<string | number>;
  /** 其余格子的默认颜色。 */
  rest?: Tone;
  subs?: string[];
  /** 每格的热度 0–1（热力图）。 */
  heat?: number[];
}

/** 把一组值变成一排格子。null 表示这一格没有数据。 */
export function cellsOf(values: Array<number | string | null>, options: CellOptions = {}): DsCell[] {
  return values.map((value, index) => ({
    v: value === null ? '' : String(value),
    key: options.keys ? String(options.keys[index]) : undefined,
    tone: options.tones?.[index] ?? options.rest,
    lift: options.lift?.includes(index) || undefined,
    sub: options.subs?.[index],
    heat: options.heat?.[index],
  }));
}

/**
 * 全站统一的配色：用户的话 blue，模型写的文字（想法、回答）green，行动（tool_use）amber，观察（tool_result）teal，
 * system 和工具定义 violet，协议和模板的开销（HTTP 头、JSON-RPC 外壳、ChatML 标记）slate。
 */
export const PART_TONE = {
  user: 'blue',
  thought: 'green',
  call: 'amber',
  result: 'teal',
  setup: 'violet',
  overhead: 'slate',
} as const satisfies Record<string, Color>;

/** 消息历史里的一个内容块：第几条消息的第几块、什么块、占多少 token。 */
export interface BlockCell {
  message: number;
  block: number;
  kind: 'user' | 'thought' | 'call' | 'result' | 'error';
  label: string;
  tokens: number;
}

/** 一段内容在展开后的提示里占的 token（按 source 汇总，见 template.ts 的 source 写法）。 */
const tokensOf = (prompt: RenderedPrompt, source: string): number => prompt.pieces.filter((piece) => piece.kind === 'content' && piece.source === source).reduce((sum, piece) => sum + piece.tokens, 0);

/**
 * 把消息历史拆成内容块：每块一格。token 数取自这一轮请求展开后的提示（只有在这一轮请求里的消息才有数），
 * 不在 prompt 里的块（比如这一轮刚生成的回复）用 extra 传入它的 token 数。
 */
export function blocksOf(messages: readonly MessageParam[], prompt: RenderedPrompt, extra: Record<number, number[]> = {}): BlockCell[] {
  const out: BlockCell[] = [];
  messages.forEach((message, i) => {
    if (typeof message.content === 'string') {
      out.push({ message: i, block: 0, kind: message.role === 'user' ? 'user' : 'thought', label: message.role === 'user' ? '用户' : '回答', tokens: extra[i]?.[0] ?? tokensOf(prompt, `messages[${i}].content`) });
      return;
    }
    message.content.forEach((block, j) => {
      const tokens = extra[i]?.[j] ?? tokensOf(prompt, `messages[${i}].content[${j}]`);
      if (block.type === 'text') out.push({ message: i, block: j, kind: message.role === 'user' ? 'user' : 'thought', label: message.role === 'user' ? '用户' : '想法', tokens });
      else if (block.type === 'tool_use') out.push({ message: i, block: j, kind: 'call', label: block.name, tokens });
      else out.push({ message: i, block: j, kind: block.is_error ? 'error' : 'result', label: block.is_error ? '出错' : '结果', tokens });
    });
  });
  return out;
}

const BLOCK_TONE: Record<BlockCell['kind'], Tone> = { user: PART_TONE.user, thought: PART_TONE.thought, call: PART_TONE.call, result: PART_TONE.result, error: 'amber' };

/** 消息历史画成一排：每个内容块一格，格子写 token 数，下面写它是什么；同一块在各帧之间 key 不变。 */
export function historyRow(id: string, blocks: readonly BlockCell[], options: { w?: number; lift?: number[]; title?: string; marks?: RowPrim['marks'] } = {}): RowPrim {
  return {
    kind: 'row',
    id,
    w: options.w ?? 50,
    cells: blocks.map((cell, i): DsCell => ({ v: String(cell.tokens), tone: BLOCK_TONE[cell.kind], sub: cell.label, key: `m${cell.message}b${cell.block}`, lift: options.lift?.includes(i) || undefined })),
    title: options.title,
    marks: options.marks,
  };
}

/** 每一轮的账：输入、输出 token，最后一行合计（费用写在文案和字节层里，格子放不下）。 */
export function ledgerGrid(id: string, turns: readonly AgentTurn[], options: { w?: number; total?: boolean } = {}): GridPrim {
  const rows = turns.map((turn) => [turn.message.usage.input_tokens, turn.message.usage.output_tokens]);
  const labels = turns.map((turn) => `第 ${turn.index} 轮`);
  const last = turns[turns.length - 1];
  if (options.total && last) {
    rows.push([last.after.input, last.after.output]);
    labels.push('合计');
  }
  return {
    kind: 'grid',
    id,
    w: options.w ?? 58,
    rows: labels,
    cols: ['输入', '输出'],
    cells: rows.map((row, r): DsCell[] => row.map((v, c): DsCell => ({ v: String(v), tone: r === turns.length ? 'head' : c === 0 ? 'blue' : 'green' }))),
  };
}

/** 一次运行里，每一轮请求重复带上的固定部分：工具系统提示 + 工具定义 + system。 */
export const fixedTokens = (turn: AgentTurn): number => turn.toolSystem + turn.breakdown.tools + turn.breakdown.system;

/** 一次运行的 tool_use 依次是哪些工具。 */
export const toolNames = (run: AgentRun): string[] => run.turns.flatMap((turn) => turn.calls.map((call) => call.use.name));

/** 百分比，保留 1 位小数。 */
export const pct = (value: number): string => `${+(value * 100).toFixed(1)}%`;
