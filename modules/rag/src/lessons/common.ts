/**
 * 各课共用的小工具：把数组变成图元格子、全站统一的配色、向量画成一排热力格子、相似度画成小表。
 * 课程里的数字一律从 core/ 的计算结果取，这里只负责「怎么画」。
 */
import type { Vec } from '../core/vector';
import type { Color, DsCell, GridPrim, RowPrim, Tone } from './types';

export { num, preview, thousands } from '../decode/structures';

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
 * 全站统一的配色：问题和查询 blue，文档和块 teal，向量 violet，检索结果 amber，提示和协议开销 slate，模型的回答 green。
 */
export const PART_TONE = {
  query: 'blue',
  doc: 'teal',
  vector: 'violet',
  result: 'amber',
  overhead: 'slate',
  answer: 'green',
} as const satisfies Record<string, Color>;

/** 固定位数的小数，负号用 −；舍入成 0 的负数写成 0（不写 −0.00）。 */
export function fixed(x: number, digits = 2): string {
  const text = x.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text.replace('-', '−');
}

/** 向量分量的显示：两位小数。 */
export const comp = (x: number): string => fixed(x, 2);

/**
 * 一个向量画成一排热力格子：格子写分量（两位小数），热度是 |x| / 最大绝对值，正数用 tone 色，负数用 amber。
 * 下标写维度编号。keyPrefix 让同一个向量在帧之间保持身份。
 */
export function vectorRow(id: string, v: readonly number[], options: { tone?: Color; keyPrefix?: string; w?: number; title?: string; lift?: number[]; marks?: RowPrim['marks'] } = {}): RowPrim {
  const max = Math.max(1e-12, ...v.map(Math.abs));
  return {
    kind: 'row',
    id,
    w: options.w ?? 34,
    cells: v.map((x, i): DsCell => ({ v: comp(x), heat: Math.abs(x) / max, tone: x < 0 ? 'amber' : options.tone ?? 'violet', key: options.keyPrefix ? `${options.keyPrefix}${i}` : undefined, lift: options.lift?.includes(i) || undefined })),
    title: options.title,
    marks: options.marks,
  };
}

/** 相似度矩阵画成小表：对角线灰色，其余按值的大小上热度。 */
export function similarityGrid(id: string, labels: string[], matrix: readonly (readonly number[])[], options: { w?: number; digits?: number } = {}): GridPrim {
  return {
    kind: 'grid',
    id,
    w: options.w ?? 58,
    rows: labels,
    cols: labels,
    cells: matrix.map((row, r) => row.map((value, c): DsCell => (r === c ? { v: '—', tone: 'dim' } : { v: fixed(value, options.digits ?? 2), tone: 'green', heat: Math.max(0, value) }))),
  };
}

/** 百分比，保留 1 位小数。 */
export const pct = (value: number): string => `${+(value * 100).toFixed(1)}%`;

/** 一组向量两两的点积（已归一化时就是余弦）。 */
export const pairwise = (vectors: readonly Vec[], f: (a: Vec, b: Vec) => number): number[][] => vectors.map((a) => vectors.map((b) => f(a, b)));
