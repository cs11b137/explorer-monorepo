/**
 * 各课共用的小工具：把数组变成图元格子、token 的配色、数值格式。
 * 课程里的数字一律从 model/ 的计算结果取，这里只负责「怎么画」。
 */
import { TOKENIZER } from '../model/tokenizer';
import type { Color, DsCell, Tone } from './types';

export { num } from '../decode/structures';

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

/** 相邻 token 轮流用的颜色，和常见的分词可视化工具一样，一眼看出边界。 */
export const TOKEN_TONES: Color[] = ['blue', 'teal', 'violet', 'amber'];

/** 第 i 个 token 的颜色。 */
export const tokenTone = (index: number): Color => TOKEN_TONES[index % TOKEN_TONES.length];

/** token 的展示文字，太长时截断，格子里放得下。 */
export function shortLabel(id: number, max = 7): string {
  const label = TOKENIZER.label(id);
  return [...label].length > max ? `${[...label].slice(0, max - 1).join('')}…` : label;
}

/** 百分比，保留 1 位小数。 */
export const pct = (value: number): string => `${+(value * 100).toFixed(1)}%`;
