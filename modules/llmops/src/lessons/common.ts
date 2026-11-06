/**
 * 各课共用的小工具：把消息按命中切成一排格子、分类器的贡献画成热力图、指标画成小表、数字的写法。
 * 课程里的数字一律从 core/ 的计算结果取，这里只负责「怎么画」。
 */
import { utf8Encode, type Contribution, type LayerReport } from '../core';
import { segmentsOf, type Segment } from '../decode/structures';
import type { DsCell, GridPrim, RowPrim, Tone } from './types';

export { num, preview } from '../decode/structures';

/** 百分比，保留 1 位小数。 */
export const pct = (value: number): string => `${+(value * 100).toFixed(1)}%`;
/** 概率，保留 3 位小数。 */
export const prob = (value: number): string => value.toFixed(3);

/**
 * 一条消息按命中切段：演示标记单独一段（标签「标记」），命中的区间各一段，其余的文字再按逗号、句号、问号切成分句。
 * spans 的下标是 UTF-16。
 */
export function messageSegments(text: string, spans: ReadonlyArray<{ from: number; to: number; label: string }>, mark?: string): Segment[] {
  const all = [...spans];
  if (mark && text.startsWith(mark)) all.push({ from: 0, to: mark.length, label: '标记' });
  return segmentsOf(text, all).flatMap((seg) => {
    if (seg.hit) return [seg];
    const out: Segment[] = [];
    let at = seg.from;
    for (const m of seg.text.matchAll(/[，。？！,.?!]/gu)) {
      const end = seg.from + m.index! + m[0].length;
      // 只有一个标点的片段（比如命中区间后面紧跟的逗号）不单独成格，并进后面的分句。
      if (end - at <= 1) continue;
      out.push({ from: at, to: end, text: text.slice(at, end), hit: null });
      at = end;
    }
    if (at < seg.to) out.push({ from: at, to: seg.to, text: text.slice(at, seg.to), hit: null });
    return out;
  });
}

/** 消息画成一排：每段一格，格子写 UTF-8 字节数，下面写命中的标签（没命中写「…」）。reveal 时命中的段 amber 并抬起，标记 slate，其余 tone；lift 抬起全部（正在被检查）。 */
export function messageRow(id: string, segments: readonly Segment[], options: { w?: number; reveal?: boolean; tone?: Tone; title?: string; lift?: boolean } = {}): RowPrim {
  return {
    kind: 'row',
    id,
    w: options.w ?? 46,
    cells: segments.map((seg, i): DsCell => {
      const marked = seg.hit === '标记';
      const hit = options.reveal && seg.hit && !marked;
      return { v: String(utf8Encode(seg.text).length), key: `${id}${i}`, tone: marked ? 'slate' : hit ? 'amber' : (options.tone ?? 'blue'), sub: marked ? '标记' : hit ? seg.hit! : '…', lift: hit || (options.lift && !marked) || undefined };
    }),
    title: options.title,
  };
}

/** 分类器的贡献画成一排热力图：格子写贡献 ×100（取整，带符号），下面写片段；正的 amber（往「注入」推），负的 teal。 */
export function contributionRow(id: string, contributions: readonly Contribution[], options: { w?: number; max?: number } = {}): RowPrim {
  const max = options.max ?? Math.max(...contributions.map((c) => Math.abs(c.amount)));
  return {
    kind: 'row',
    id,
    w: options.w ?? 46,
    cells: contributions.map((c, i): DsCell => {
      const v = Math.round(c.amount * 100);
      return { v: `${v > 0 ? '+' : ''}${v}`, key: `${id}${i}`, tone: c.amount >= 0 ? 'amber' : 'teal', heat: Math.abs(c.amount) / max, sub: c.grams[0] };
    }),
  };
}

/** 一层检测在测试集上的四个数。 */
export const outcomeOf = (r: LayerReport) => [r.confusion.tp, r.confusion.fn, r.confusion.fp, r.confusion.tn];

/** 几层检测的结果并排画成一张表：行是抓到、漏掉、误拦、放行，列是各层。 */
export function outcomeGrid(id: string, layers: ReadonlyArray<[string, LayerReport]>, options: { w?: number } = {}): GridPrim {
  const rowTone: Tone[] = ['green', 'amber', 'amber', 'teal'];
  return {
    kind: 'grid',
    id,
    w: options.w ?? 46,
    rows: ['抓到', '漏掉', '误拦', '放行'],
    cols: layers.map(([name]) => name),
    cells: [0, 1, 2, 3].map((r) => layers.map(([, report]): DsCell => {
      const v = outcomeOf(report)[r];
      return { v: String(v), tone: v === 0 && (r === 1 || r === 2) ? 'dim' : rowTone[r] };
    })),
  };
}
