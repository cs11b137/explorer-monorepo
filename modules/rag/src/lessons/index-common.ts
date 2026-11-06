/**
 * 向量检索组（flat、ivf、hnsw、pq、hybrid）共用的画法：段落的简称、向量空间的平面投影、把一批段落画成 graph 图元。
 *
 * 平面布局只用来画图：从 PCA 的前两个主成分出发，用度量 MDS（梯度下降减小应力）让平面距离接近 16 维距离，再把挤在一起的点推开（确定性的松弛）。
 * 16 维里的远近在平面上只能保留一部分，检索和距离一律按 16 维真实计算；课程文案里说明这一点。
 */
import { f32Bits } from '@explorer/llm-core/float';
import { jacobiEigen, PARAGRAPHS, PARAGRAPH_VECTORS, type Paragraph, type Vec } from '../core';
import { num } from '../decode/structures';
import { LayerWriter } from '../decode/writer';
import type { Color, GraphEdge, GraphNode, GraphPrim, Tone } from './types';

// ---------- 段落的简称 ----------

/** 每篇文档一个字：图上的节点只放得下两三个字符。 */
export const DOC_CHAR: Record<string, string> = {
  aftersale: '售',
  refund: '退',
  'refund-2025': '旧',
  'shipping-fee': '运',
  delivery: '送',
  cup: '杯',
  kettle: '壶',
  warranty: '修',
  invoice: '票',
  points: '积',
  coupon: '券',
  contact: '客',
};

/** 段落的简称：文档的字加段落序号（只有一段的文档不加），如 cup#1 → 杯1。 */
export function shortName(p: Paragraph | number): string {
  const item = typeof p === 'number' ? PARAGRAPHS[p] : p;
  const single = PARAGRAPHS.filter((other) => other.doc === item.doc).length === 1;
  return single ? DOC_CHAR[item.doc] : `${DOC_CHAR[item.doc]}${item.index}`;
}

/** 段落的 id（cup#1）和简称（杯1）。 */
export const idOf = (i: number): string => PARAGRAPHS[i].id;
export const nameOf = (i: number): string => `${shortName(i)}（${idOf(i)}）`;

// ---------- 平面投影 ----------

const D = PARAGRAPH_VECTORS[0].length;
const MEAN = Array.from({ length: D }, (_, d) => PARAGRAPH_VECTORS.reduce((sum, v) => sum + v[d], 0) / PARAGRAPH_VECTORS.length);
const COV = Array.from({ length: D }, (_, a) => Array.from({ length: D }, (_, b) => PARAGRAPH_VECTORS.reduce((sum, v) => sum + (v[a] - MEAN[a]) * (v[b] - MEAN[b]), 0)));
const EIGEN = jacobiEigen(COV);
const AXES = [EIGEN.vectors[0], EIGEN.vectors[1]];
const rawXY = (v: readonly number[]): [number, number] => {
  const [x, y] = AXES.map((axis) => axis.reduce((sum, a, d) => sum + a * (v[d] - MEAN[d]), 0));
  return [x, y];
};

/** 前两个主成分解释的方差比例（文案里说明投影丢了多少）。 */
export const PROJECTION_SHARE = (EIGEN.values[0] + EIGEN.values[1]) / EIGEN.values.reduce((sum, x) => sum + x, 0);

/** 画布上的范围：x ∈ [−W/2, W/2]，y ∈ [−H/2, H/2]。 */
export const SPACE_W = 640;
export const SPACE_H = 360;

/**
 * 从 PCA 的坐标出发，用梯度下降减小应力 Σ (‖pᵢ − pⱼ‖ − dᵢⱼ)²（dᵢⱼ 是 16 维的欧氏距离），
 * 让平面上的远近尽量接近 16 维里的远近（度量 MDS）。步数和步长固定，结果确定。
 */
const BASE: Array<[number, number]> = (() => {
  const n = PARAGRAPH_VECTORS.length;
  const target = PARAGRAPH_VECTORS.map((a) => PARAGRAPH_VECTORS.map((b) => Math.sqrt(a.reduce((sum, x, d) => sum + (x - b[d]) ** 2, 0))));
  const pts = PARAGRAPH_VECTORS.map(rawXY);
  for (let iter = 0; iter < 600; iter++) {
    const grad = pts.map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = pts[i][0] - pts[j][0];
        const dy = pts[i][1] - pts[j][1];
        const d = Math.hypot(dx, dy) || 1e-9;
        const k = (d - target[i][j]) / d;
        grad[i][0] += k * dx;
        grad[i][1] += k * dy;
      }
    }
    for (let i = 0; i < n; i++) {
      pts[i][0] -= (0.5 / n) * grad[i][0];
      pts[i][1] -= (0.5 / n) * grad[i][1];
    }
  }
  return pts;
})();
const lo = [Math.min(...BASE.map((p) => p[0])), Math.min(...BASE.map((p) => p[1]))];
const hi = [Math.max(...BASE.map((p) => p[0])), Math.max(...BASE.map((p) => p[1]))];
const scale = (p: [number, number]): [number, number] => [((p[0] - lo[0]) / (hi[0] - lo[0]) - 0.5) * SPACE_W, ((p[1] - lo[1]) / (hi[1] - lo[1]) - 0.5) * SPACE_H];

/**
 * 任意向量（查询、质心）放到画布上：取和它最近的 3 个段落，按 1 / 平方距离加权平均它们的位置（示意）。
 */
export function project(v: readonly number[]): [number, number] {
  const near = PARAGRAPH_VECTORS.map((p, i) => ({ i, d: p.reduce((sum, x, d) => sum + (x - v[d]) ** 2, 0) })).sort((a, b) => a.d - b.d).slice(0, 3);
  const weights = near.map((item) => 1 / (item.d + 0.02));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const x = near.reduce((sum, item, k) => sum + POS[item.i][0] * weights[k], 0) / total;
  const y = near.reduce((sum, item, k) => sum + POS[item.i][1] * weights[k], 0) / total;
  return [+x.toFixed(1), +y.toFixed(1)];
}

/** 段落在画布上的位置：投影之后把太近的点推开（节点是 2r 宽的立方块，横向更占地方）。 */
export const POS: ReadonlyArray<[number, number]> = (() => {
  const pts = BASE.map((p) => scale(p));
  const gapX = 70;
  const gapY = 52;
  for (let round = 0; round < 400; round++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = (pts[j][0] - pts[i][0]) / gapX;
        const dy = (pts[j][1] - pts[i][1]) / gapY;
        const d = Math.hypot(dx, dy);
        if (d >= 1) continue;
        moved = true;
        const push = (1 - d) / 2 + 0.01;
        const ux = d ? dx / d : 1;
        const uy = d ? dy / d : 0;
        pts[i][0] -= ux * push * gapX;
        pts[i][1] -= uy * push * gapY;
        pts[j][0] += ux * push * gapX;
        pts[j][1] += uy * push * gapY;
      }
    }
    if (!moved) break;
  }
  return pts.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)] as [number, number]);
})();

/** 一组段落在画布上的中心（画质心用：质心在 16 维里是成员的平均，画在成员的平均位置上）。 */
export function centerOf(ids: readonly number[]): [number, number] {
  if (!ids.length) return [0, 0];
  const x = ids.reduce((sum, i) => sum + POS[i][0], 0) / ids.length;
  const y = ids.reduce((sum, i) => sum + POS[i][1], 0) / ids.length;
  return [+x.toFixed(1), +y.toFixed(1)];
}

// ---------- 图元 ----------

export interface SpaceOptions {
  /** 只画这些段落（默认全部）。 */
  only?: readonly number[];
  tones?: Record<number, Tone>;
  rest?: Tone;
  lift?: readonly number[];
  edges?: GraphEdge[];
  /** 额外的点：查询、质心。 */
  extra?: GraphNode[];
  marks?: GraphPrim['marks'];
  r?: number;
  /** 节点上写的字，默认简称。 */
  label?: (i: number) => string;
}

/** 段落节点的 id。 */
export const pid = (i: number): string => `p${i}`;

/** 向量空间：段落画成节点（简称），可以加查询、质心等额外的点和边。 */
export function spaceGraph(options: SpaceOptions = {}): GraphPrim {
  const ids = options.only ?? PARAGRAPHS.map((_, i) => i);
  const nodes: GraphNode[] = ids.map((i) => ({ id: pid(i), x: POS[i][0], y: POS[i][1], v: options.label?.(i) ?? shortName(i), tone: options.tones?.[i] ?? options.rest ?? 'teal', lift: options.lift?.includes(i) || undefined }));
  return { kind: 'graph', id: 'sp', r: options.r ?? 19, nodes: [...nodes, ...(options.extra ?? [])], edges: options.edges ?? [], marks: options.marks };
}

// ---------- 检索结果的字节 ----------

let serial = 0;
/** 本组图层的 id（和 decode/structures.ts 的 l0、l1… 不冲突）。 */
export const layerId = (): string => `ix${serial++}`;

/** int64 小端（补码）：−1 写成 8 个 FF。 */
export const i64Bytes = (value: number): number[] => {
  let big = BigInt.asUintN(64, BigInt(value));
  return Array.from({ length: 8 }, () => {
    const byte = Number(big & 0xffn);
    big >>= 8n;
    return byte;
  });
};

/**
 * FAISS Index::search 对一个查询的输出：distances 是 k 个 float32，labels 是 k 个 int64（idx_t），不够 k 个时 label 补 −1。
 * 两个数组各一层。distances 的含义随度量而变：IP 是内积（越大越近），L2 是平方距离（越小越近）。
 */
export function searchOutput(hits: ReadonlyArray<{ id: number; score: number }>, k: number, options: { metric?: 'ip' | 'l2'; color?: Color; names?: (id: number) => string } = {}): LayerWriter[] {
  const name = options.names ?? nameOf;
  const dist = new LayerWriter(`ix${serial++}`, `float32 distances[${k}] · ${k * 4} 字节`, options.color ?? 'amber', options.metric === 'l2' ? '平方欧氏距离，越小越近' : '内积，越大越近');
  const labels = new LayerWriter(`ix${serial++}`, `int64 labels[${k}] · ${k * 8} 字节`, 'slate', '向量的 id（这里是段落的下标），不够 k 个时补 −1');
  for (let i = 0; i < k; i++) {
    const hit = hits[i];
    const value = hit ? Math.fround(hit.score) : options.metric === 'l2' ? Infinity : -Infinity;
    const bits = f32Bits(value);
    dist.field(`distances[${i}] · +${i * 4}`, hit ? num(value, 4) : num(value), () => dist.raw(Array.from({ length: 4 }, (_, b) => (bits >>> (b * 8)) & 0xff)), { note: hit ? `第 ${i + 1} 名：${name(hit.id)}。` : '没有结果：距离填最远的值。' });
    labels.field(`labels[${i}] · +${i * 8}`, hit ? String(hit.id) : '−1', () => labels.raw(i64Bytes(hit ? hit.id : -1)), { note: hit ? `${name(hit.id)}。` : '不够 k 个：FAISS 用 −1 补齐。' });
  }
  return [dist, labels];
}

/** 查询画成一个额外的点。 */
export const queryNode = (v: Vec, label = '问'): GraphNode => {
  const [x, y] = project(v);
  return { id: 'q', x, y, v: label, tone: 'blue', lift: true };
};
