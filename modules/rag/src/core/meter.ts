/**
 * 距离计算次数：轨迹表「距离」列的来源，也是向量检索的核心成本（FAISS 的统计里叫 ndis）。
 *
 * 记账规则（全站统一）：
 * - 拿一个向量（查询，或建索引时正在插入的向量）和另一个完整向量（数据点、质心）比较一次，记 1 次，
 *   不管用的是点积、余弦还是欧氏距离；
 * - PQ：算 ADC 距离表时，M 个子空间各和 K 个子质心比较，总计算量等于 K 次完整维度的距离，记 K 次；
 *   之后每个码查表求和得到一个近似距离，记 1 次（FAISS 也把它算进 ndis）；
 * - 重排序器给一对（查询，段落）打一次分，记 1 次；
 * - BM25、切分、拼提示、生成不涉及向量距离，记 0。
 */

export type DistanceKind = 'query' | 'build' | 'centroid' | 'train' | 'adc-table' | 'adc' | 'rerank';

export class DistanceMeter {
  total = 0;
  readonly by: Record<DistanceKind, number> = { query: 0, build: 0, centroid: 0, train: 0, 'adc-table': 0, adc: 0, rerank: 0 };

  add(kind: DistanceKind, n = 1): void {
    this.total += n;
    this.by[kind] += n;
  }
}
