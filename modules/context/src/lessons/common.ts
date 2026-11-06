/**
 * 各课共用的小工具：把数组变成图元格子、请求各部分的配色、把展开后的提示按来源分段。
 * 课程里的数字一律从 core/ 的计算结果取，这里只负责「怎么画」。
 */
import type { Usage } from '../core/anthropic';
import { costOf, formatUsd } from '../core/pricing';
import type { RenderedPrompt } from '../core/template';
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
 * 请求各部分的配色，全站统一：
 * 工具定义 teal，system violet，用户消息 blue，助手消息 green，模板开销 slate，检索 / 记忆 amber。
 */
export const PART_TONE = {
  tools: 'teal',
  system: 'violet',
  user: 'blue',
  assistant: 'green',
  template: 'slate',
  retrieval: 'amber',
} as const satisfies Record<string, Color>;

/** 展开后的提示按来源分成的一段。 */
export interface PromptSegment {
  /** 来源：tools、system、messages[0]……，模板自己的开销是 template。 */
  source: string;
  label: string;
  tone: Color;
  tokens: number;
}

/**
 * 把展开后的提示按「来自请求的哪一部分」汇总成几段：每条消息一段（含它的所有内容块），system、tools 各一段，
 * 模板的特殊 token、角色名、换行、生成提示合成最后一段。各段之和等于总 token 数。
 */
export function promptSegments(prompt: RenderedPrompt, roles: ReadonlyArray<'user' | 'assistant'>): PromptSegment[] {
  const out: PromptSegment[] = [];
  const add = (source: string, label: string, tone: Color, tokens: number) => {
    const last = out.find((item) => item.source === source);
    if (last) last.tokens += tokens;
    else out.push({ source, label, tone, tokens });
  };
  for (const piece of prompt.pieces) {
    if (piece.kind !== 'content' || !piece.source) continue;
    const message = /^messages\[(\d+)\]/.exec(piece.source);
    if (message) {
      const i = Number(message[1]);
      add(`messages[${i}]`, `messages[${i}]`, roles[i] === 'assistant' ? PART_TONE.assistant : PART_TONE.user, piece.tokens);
    } else if (piece.source === 'tools') add('tools', 'tools', PART_TONE.tools, piece.tokens);
    else add('system', 'system', PART_TONE.system, piece.tokens);
  }
  add('template', '模板', PART_TONE.template, prompt.overhead);
  return out;
}

/** 分段画成一排格子：每格写 token 数，格子下面写来源。 */
export function segmentRow(id: string, segments: readonly PromptSegment[], options: { w?: number; lift?: string[]; title?: string } = {}): RowPrim {
  return {
    kind: 'row',
    id,
    w: options.w ?? 62,
    cells: segments.map((segment) => ({ v: String(segment.tokens), tone: segment.tone, sub: segment.label, key: segment.source, lift: options.lift?.includes(segment.source) || undefined })),
    title: options.title,
  };
}

/** usage 和费用的小表：每行一种 token，两列是 token 数和按示例单价算出的费用。 */
export function usageGrid(id: string, usage: Usage, model: string, options: { w?: number; rows?: Array<'input' | 'write' | 'read' | 'output'> } = {}): GridPrim {
  const cost = costOf(usage, model);
  const all = {
    input: ['输入', usage.input_tokens, cost.input],
    write: ['缓存写', usage.cache_creation_input_tokens, cost.write5m + cost.write1h],
    read: ['缓存读', usage.cache_read_input_tokens, cost.read],
    output: ['输出', usage.output_tokens, cost.output],
  } as const;
  const rows = options.rows ?? ['input', 'output'];
  return {
    kind: 'grid',
    id,
    w: options.w ?? 64,
    rows: rows.map((row) => all[row][0]),
    cols: ['token', '费用'],
    cells: rows.map((row): DsCell[] => [{ v: String(all[row][1]), tone: row === 'output' ? 'green' : row === 'read' ? 'teal' : 'blue' }, { v: formatUsd(all[row][2]) }]),
  };
}

/** 百分比，保留 1 位小数。 */
export const pct = (value: number): string => `${+(value * 100).toFixed(1)}%`;
