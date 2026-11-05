/** costsize.c 和 selfuncs.c 的直译（REL_17_STABLE），默认参数见 src/include/optimizer/cost.h。 */
export const seq_page_cost = 1.0;
export const random_page_cost = 4.0;
export const cpu_tuple_cost = 0.01;
export const cpu_index_tuple_cost = 0.005;
export const cpu_operator_cost = 0.0025;
export const effective_cache_size = 524288; // 4 GB，按 8 KiB 页
export const DEFAULT_PAGE_CPU_MULTIPLIER = 50.0;

export interface RelStats {
  name: string;
  pages: number;
  tuples: number;
}

export interface IndexStats {
  name: string;
  pages: number;
  tuples: number;
  /** bt_metap 的 level，就是 IndexOptInfo.tree_height。 */
  treeHeight: number;
  correlation: number;
}

export interface Cost {
  startup: number;
  total: number;
  rows: number;
  parts: Record<string, number>;
}

export const clampRowEst = (rows: number): number => (rows <= 1 ? 1 : Math.round(rows));

/**
 * col < 常量：ineq_histogram_selectivity。直方图只给出 x <= 常量 的估计，
 * eqSel 是单个值的选择率（1 / n_distinct），第一个桶要补偿，`<` 还要再减掉它。
 */
export function histogramSelectivity(bounds: number[], value: number, eqSel: number): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const probe = (lo + hi) >> 1;
    if (bounds[probe] < value) lo = probe + 1;
    else hi = probe;
  }
  let histfrac: number;
  if (lo <= 0) histfrac = 0;
  else if (lo >= bounds.length) histfrac = 1;
  else {
    const low = bounds[lo - 1];
    const high = bounds[lo];
    const binfrac = high <= low ? 0.5 : (value - low) / (high - low);
    histfrac = (lo - 1 + binfrac) / (bounds.length - 1);
    if (lo === 1) histfrac += eqSel * (1 - binfrac);
    histfrac -= eqSel;
  }
  const cutoff = 0.01 / (bounds.length - 1);
  return Math.min(1 - cutoff, Math.max(cutoff, histfrac));
}

/** cost_seqscan */
export function costSeqScan(rel: RelStats, selectivity: number, quals = 1): Cost {
  const disk = seq_page_cost * rel.pages;
  const cpuPerTuple = cpu_tuple_cost + quals * cpu_operator_cost;
  const cpu = cpuPerTuple * rel.tuples;
  return { startup: 0, total: disk + cpu, rows: clampRowEst(selectivity * rel.tuples), parts: { 顺序读页: disk, 'CPU 处理元组': cpu } };
}

/** index_pages_fetched：Mackert–Lohman 公式。 */
export function indexPagesFetched(tuplesFetched: number, pages: number, totalPages: number): number {
  const T = pages > 1 ? pages : 1;
  const total = Math.max(totalPages, 1);
  let b = (effective_cache_size * T) / total;
  b = b <= 1 ? 1 : Math.ceil(b);
  if (T <= b) {
    const fetched = (2 * T * tuplesFetched) / (2 * T + tuplesFetched);
    return fetched >= T ? T : Math.ceil(fetched);
  }
  const lim = (2 * T * b) / (2 * T - b);
  const fetched = tuplesFetched <= lim ? (2 * T * tuplesFetched) / (2 * T + tuplesFetched) : b + ((tuplesFetched - lim) * (T - b)) / T;
  return Math.ceil(fetched);
}

/** genericcostestimate + btcostestimate 里的下降开销。 */
function btCost(index: IndexStats, relTuples: number, selectivity: number) {
  const numIndexTuples = Math.max(1, Math.min(index.tuples, Math.round(selectivity * relTuples)));
  const numIndexPages = index.pages > 1 && index.tuples > 1 ? Math.ceil((numIndexTuples * index.pages) / index.tuples) : 1;
  const pageIO = numIndexPages * random_page_cost;
  const tupleCpu = numIndexTuples * (cpu_index_tuple_cost + cpu_operator_cost);
  const compareDescent = index.tuples > 1 ? Math.ceil(Math.log(index.tuples) / Math.log(2)) * cpu_operator_cost : 0;
  const pageDescent = (index.treeHeight + 1) * DEFAULT_PAGE_CPU_MULTIPLIER * cpu_operator_cost;
  const startup = compareDescent + pageDescent;
  return { startup, total: pageIO + tupleCpu + startup, numIndexTuples, numIndexPages, pageIO, tupleCpu, compareDescent, pageDescent };
}

/** cost_index */
export function costIndexScan(rel: RelStats, index: IndexStats, selectivity: number, totalTablePages = rel.pages): Cost & { pagesFetched: number; maxIO: number; minIO: number; csquared: number } {
  const bt = btCost(index, rel.tuples, selectivity);
  const tuplesFetched = clampRowEst(selectivity * rel.tuples);
  const pagesRandom = indexPagesFetched(tuplesFetched, rel.pages, totalTablePages + index.pages);
  const maxIO = pagesRandom * random_page_cost;
  const pagesSeq = Math.ceil(selectivity * rel.pages);
  const minIO = pagesSeq > 0 ? random_page_cost + (pagesSeq > 1 ? (pagesSeq - 1) * seq_page_cost : 0) : 0;
  const csquared = index.correlation * index.correlation;
  const heapIO = maxIO + csquared * (minIO - maxIO);
  const cpu = cpu_tuple_cost * tuplesFetched;
  return {
    startup: bt.startup,
    total: bt.total + heapIO + cpu,
    rows: tuplesFetched,
    pagesFetched: pagesRandom,
    maxIO,
    minIO,
    csquared,
    parts: { 下降索引: bt.startup, 读索引页: bt.pageIO, 比较索引项: bt.tupleCpu, 读堆页: heapIO, 'CPU 处理元组': cpu },
  };
}

/** cost_bitmap_heap_scan（单个索引，没有 BitmapAnd/Or，也没有有损页）。 */
export function costBitmapScan(rel: RelStats, index: IndexStats, selectivity: number): Cost & { pagesFetched: number; costPerPage: number } {
  const bt = btCost(index, rel.tuples, selectivity);
  const tuplesFetched = clampRowEst(selectivity * rel.tuples);
  // cost_bitmap_tree_node：索引路径的总开销，再按返回的行数加每行 0.1 倍 cpu_operator_cost。
  const indexTotal = bt.total + 0.1 * cpu_operator_cost * tuplesFetched;
  // compute_bitmap_pages
  const T = rel.pages > 1 ? rel.pages : 1;
  const raw = (2 * T * tuplesFetched) / (2 * T + tuplesFetched);
  const pagesFetched = raw >= T ? T : Math.ceil(raw);
  // 页越多，读取顺序越接近顺序读，单页开销在 random 和 seq 之间按平方根插值。
  const costPerPage = pagesFetched >= 2 ? random_page_cost - (random_page_cost - seq_page_cost) * Math.sqrt(pagesFetched / T) : random_page_cost;
  const heapIO = pagesFetched * costPerPage;
  // 位图取回的页要复查条件，所以每行多一次 cpu_operator_cost。
  const cpu = (cpu_tuple_cost + cpu_operator_cost) * tuplesFetched;
  return {
    startup: indexTotal,
    total: indexTotal + heapIO + cpu,
    rows: tuplesFetched,
    pagesFetched,
    costPerPage,
    parts: { 扫描索引建位图: indexTotal, 读堆页: heapIO, 'CPU 处理元组': cpu },
  };
}
