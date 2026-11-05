import { concept, doubles, values, wire } from '../decode/structures';
import { costBitmapScan, costIndexScan, costSeqScan, cpu_index_tuple_cost, cpu_operator_cost, cpu_tuple_cost, DEFAULT_PAGE_CPU_MULTIPLIER, histogramSelectivity, random_page_cost, seq_page_cost, type Cost } from '../engine/cost';
import type { BarsBoard, KvBoard, Tone } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { us } from './shared';
import type { Lesson } from './types';

// 真实数据：20000 行的表，取自 pg_class、pg_stats、bt_metap。EXPLAIN 结果在 tests/engine.test.ts 里逐个比对。
const REL = { name: 'orders', pages: 128, tuples: 20000 };
const ID = { name: 'orders_id', pages: 57, tuples: 20000, treeHeight: 1, correlation: 1 };
const AMOUNT = { name: 'orders_amount', pages: 57, tuples: 20000, treeHeight: 1, correlation: -0.0007359975 };
const ID_BOUNDS = [1, ...Array.from({ length: 99 }, (_, i) => (i + 1) * 200), 20000];
const AMOUNT_BOUNDS = [0, ...Array.from({ length: 99 }, (_, i) => (i + 1) * 200 - 1), 19999];
const EQ = 1 / 20000;

const sel4000 = histogramSelectivity(ID_BOUNDS, 4000, EQ);
const sel16000 = histogramSelectivity(ID_BOUNDS, 16000, EQ);
const amt4000 = histogramSelectivity(AMOUNT_BOUNDS, 4000, EQ);
const seq = costSeqScan(REL, sel4000);
const idx = costIndexScan(REL, ID, sel4000);
const idxAmt = costIndexScan(REL, AMOUNT, amt4000);
const bmpAmt = costBitmapScan(REL, AMOUNT, amt4000);
const idx16 = costIndexScan(REL, ID, sel16000);
const seq16 = costSeqScan(REL, sel16000);
const f2 = (v: number) => v.toFixed(2);

const TONES: Record<string, Tone> = { 顺序读页: 'blue', 'CPU 处理元组': 'teal', 下降索引: 'slate', 读索引页: 'violet', 比较索引项: 'green', 读堆页: 'amber', 扫描索引建位图: 'violet' };
const toParts = (cost: Cost) => Object.entries(cost.parts).map(([name, value]) => ({ name, value, tone: TONES[name] ?? ('slate' as Tone) }));
const bar = (label: string, cost: Cost, winner = false) => ({ label, total: f2(cost.total), parts: toParts(cost), winner });

const costs = (title: string, sub: string, bars: BarsBoard['bars'], footer?: string): BarsBoard => ({ kind: 'bars', title, sub, max: 650, bars, footer });

const stats = (hot: string[] = [], extra: KvBoard['rows'] = []): KvBoard => ({
  kind: 'kv',
  title: '统计信息',
  sub: 'pg_class / pg_stats',
  keyWidth: 150,
  rows: [
    { k: 'orders.relpages', v: String(REL.pages), hot: hot.includes('rel') ? 'amber' : undefined },
    { k: 'orders.reltuples', v: String(REL.tuples), hot: hot.includes('rel') ? 'amber' : undefined },
    { k: 'orders_id.relpages', v: `${ID.pages}，树高 ${ID.treeHeight}`, hot: hot.includes('idx') ? 'amber' : undefined },
    { k: 'id n_distinct', v: '-1（每行都不同）', hot: hot.includes('hist') ? 'amber' : undefined },
    { k: 'id 直方图', v: '1, 200, 400 … 20000', hot: hot.includes('hist') ? 'amber' : undefined },
    { k: 'id correlation', v: String(ID.correlation), hot: hot.includes('corr') ? 'amber' : undefined },
    { k: 'amount correlation', v: AMOUNT.correlation.toFixed(4), hot: hot.includes('corr') ? 'amber' : undefined },
    ...extra,
  ],
});

export const planner: Lesson = {
  id: 'planner',
  name: 'PLANNER',
  title: '代价估算',
  group: 'query',
  layer: [6, 7],
  timeUnit: 'µs',
  nodes: ['parser', 'planner', 'catalog', 'executor'],
  place: { parser: [110, 70], planner: [350, 165], catalog: [590, 70], executor: [830, 165] },
  labels: {
    parser: ['解析器', 'Query 树'],
    planner: ['优化器', 'standard_planner'],
    catalog: ['统计信息', 'pg_statistic'],
    executor: ['执行器', '下一步'],
  },
  start: ['parser', 'planner'],
  boards: {
    stats: { rect: [20, 250, 340, 300], initial: stats() },
    cost: { rect: [370, 250, 550, 300], initial: costs('路径代价', '还没算', []) },
  },
  legend: [['blue', '查询树'], ['violet', '读统计'], ['amber', '算代价'], ['green', '选定计划'], [null, '每个数字都和真实 EXPLAIN 比对过']],
  overview: {
    full: '用 costsize.c 的公式挑最便宜的执行方式',
    description: '同一条 SQL 可以顺序扫描，也可以走索引。优化器按统计信息估算每条路径要读多少页、处理多少行，换算成一个代价数字，然后选最小的。这一课的数都是公式算的，并和 PostgreSQL 17 的 EXPLAIN 输出逐个比对过。',
    facts: [
      ['seq_page_cost', String(seq_page_cost)],
      ['random_page_cost', String(random_page_cost)],
      ['cpu_tuple_cost', String(cpu_tuple_cost)],
      ['cpu_index_tuple_cost', String(cpu_index_tuple_cost)],
      ['cpu_operator_cost', String(cpu_operator_cost)],
      ['代价单位', '一次顺序读页，不是毫秒'],
    ],
  },
  steps: [
    {
      title: '读统计信息',
      desc: '表有多大、值怎么分布',
      detail: '优化器不看数据本身，只看 ANALYZE 留下的统计信息：pg_class 记页数和行数，pg_stats 记每列的不同值个数、直方图和相关性。所以统计信息过期时计划就可能选错。页数会取文件当前的实际大小，行数按密度换算。',
      facts: [['表', '20000 行，128 页'], ['索引', '57 页，树高 1'], ['来源', 'ANALYZE']],
      events: [
        pk('parser', 'planner', 'blue', 'Query', ['SELECT * FROM orders', 'WHERE id < 4000'], [0, 'PLAN', 'pg_plan_queries → standard_planner', null],
          wire('后端进程内存', 'vals', '示意', concept('Query', [['rtable', 'orders', '要扫描的表。'], ['quals', 'id < 4000', '这个条件决定能不能用索引。']], 'blue'))),
        show('catalog'),
        pk('planner', 'catalog', 'violet', '读统计', ['pg_class', 'pg_statistic'], [us(30), 'PLAN', 'get_relation_info 取页数和行数，examine_variable 取列统计', null],
          wire('系统目录缓存', 'vals', 'internal', values('RelOptInfo', [['pages', REL.pages, 'BlockNumber。'], ['tuples', BigInt(0), '下一步的 double。', { shown: '见下', width: 8 }]], 'violet'), doubles('RelOptInfo 的行数', [['tuples', REL.tuples, '用 reltuples / relpages 的密度乘以当前页数。']], 'violet'))),
        board('stats', stats(['rel', 'idx'])),
      ],
    },
    {
      title: '估算选择率',
      desc: `id < 4000 大约返回 ${idx.rows} 行`,
      detail: `直方图的每个桶装同样多的行。4000 正好是第 20 个桶的上界，所以 x <= 4000 的比例是 20/100；条件是小于号，还要减去一个值的比例 1/20000。结果 ${sel4000.toFixed(5)}，乘以 20000 得 ${idx.rows} 行，和 EXPLAIN 的 rows 一致。`,
      facts: [['函数', 'ineq_histogram_selectivity'], ['选择率', sel4000.toFixed(5)], ['估计行数', String(idx.rows)]],
      events: [
        board('stats', stats(['hist'])),
        pk('catalog', 'planner', 'violet', '直方图', ['101 个边界', 'n_distinct -1'], [us(55), 'PLAN', `scalarineqsel：选择率 ${sel4000.toFixed(5)}`, null],
          wire('Selectivity 和 Cardinality 都是 double', 'vals', 'internal', doubles('估算结果', [['histfrac', 20 / 100, '落在第 20 个桶的上界：20 / 100。'], ['eq_selec', EQ, '1 / n_distinct。小于号要减掉它。'], ['选择率', sel4000, '两者相减。'], ['rows', idx.rows, 'clamp_row_est：四舍五入到整数。']], 'violet'))),
        note('planner', `rows = ${idx.rows}`),
      ],
    },
    {
      title: '顺序扫描',
      desc: `读全表，代价 ${f2(seq.total)}`,
      detail: `cost_seqscan 很简单：每页收 seq_page_cost，每行收 cpu_tuple_cost，再加每行算一次条件的 cpu_operator_cost。不管条件多严格，全表都要读，所以这个数和选择率无关。128 × 1 + 20000 × (0.01 + 0.0025) = ${f2(seq.total)}。`,
      facts: [['读页', `128 × 1 = ${f2(seq.parts['顺序读页'])}`], ['CPU', `20000 × 0.0125 = ${f2(seq.parts['CPU 处理元组'])}`], ['启动代价', '0']],
      events: [
        pk('planner', 'catalog', 'amber', 'cost_seqscan', [`= ${f2(seq.total)}`], [us(70), 'PLAN', `create_seqscan_path：${f2(seq.total)}`, null],
          wire('Path 结构里的两个 double', 'vals', 'internal', doubles('SeqScan 路径', [['startup_cost', seq.startup, '拿到第一行之前的代价。'], ['total_cost', seq.total, '拿到全部行的代价。']], 'amber'))),
        board('cost', costs('路径代价', `id < 4000，rows ${idx.rows}`, [bar('Seq Scan', seq)])),
      ],
    },
    {
      title: '索引扫描',
      desc: `id 和物理顺序一致，代价 ${f2(idx.total)}`,
      detail: `cost_index 分两块：索引本身（下降、读页、比较）和回表。回表最关键：相关性 1 表示 id 的顺序和堆上的物理顺序完全一致，要读的 ${Math.ceil(sel4000 * REL.pages)} 个堆页几乎是连续的，按 seq_page_cost 算。公式里按相关性的平方在最差和最好情况之间插值。`,
      facts: [['下降', `${f2(idx.parts['下降索引'])}（含每层 ${DEFAULT_PAGE_CPU_MULTIPLIER} 倍 cpu_operator_cost）`], ['读索引页', f2(idx.parts['读索引页'])], ['读堆页', `csquared = 1，${f2(idx.parts['读堆页'])}`]],
      events: [
        board('stats', stats(['corr'])),
        pk('planner', 'catalog', 'amber', 'cost_index', [`= ${f2(idx.total)}`], [us(110), 'PLAN', `create_index_path：${f2(idx.startup)}..${f2(idx.total)}`, null],
          wire('cost_index 的中间量都是 double', 'vals', 'internal', doubles('IndexScan 路径', [['startup_cost', idx.startup, 'btcostestimate：ceil(log2(行数)) × cpu_operator_cost + (树高 + 1) × 50 × cpu_operator_cost。'], ['max_IO_cost', idx.maxIO, '完全不相关：Mackert–Lohman 估出的页数 × random_page_cost。'], ['min_IO_cost', idx.minIO, '完全相关：第一页随机读，其余顺序读。'], ['csquared', idx.csquared, '相关性的平方。'], ['total_cost', idx.total, '和 EXPLAIN 的 cost 上限一致。']], 'amber'))),
        board('cost', costs('路径代价', `id < 4000，rows ${idx.rows}`, [bar('Seq Scan', seq), bar('Index Scan', idx, true)], `EXPLAIN：Index Scan using orders_id (cost=${f2(idx.startup)}..${f2(idx.total)})`)),
      ],
    },
    {
      title: '相关性决定成败',
      desc: '选择率相同，索引的代价差了 4 倍',
      detail: `amount 的值和物理顺序无关（相关性约等于 0）。同样返回约 4000 行，回表变成随机读，按 random_page_cost 算，索引扫描涨到 ${f2(idxAmt.total)}，比全表扫描还贵。这时位图扫描更划算：先从索引收集 TID，排好序再读堆页，${f2(bmpAmt.total)}。`,
      facts: [['Index Scan', f2(idxAmt.total)], ['Seq Scan', f2(costSeqScan(REL, amt4000).total)], ['Bitmap Heap Scan', `${f2(bmpAmt.total)}（胜出）`], ['id < 16000', `Seq ${f2(seq16.total)} 胜过 Index ${f2(idx16.total)}`]],
      events: [
        pk('planner', 'catalog', 'amber', 'amount < 4000', [`位图 ${f2(bmpAmt.total)}`], [us(160), 'PLAN', `换一个列：索引 ${f2(idxAmt.total)}，位图 ${f2(bmpAmt.total)}`, null],
          wire('cost_bitmap_heap_scan 的中间量', 'vals', 'internal', doubles('BitmapHeapScan 路径', [['pages_fetched', bmpAmt.pagesFetched, 'compute_bitmap_pages：Mackert–Lohman。'], ['cost_per_page', bmpAmt.costPerPage, 'random − (random − seq) × √(读的比例)。读得越多越接近顺序读。'], ['startup_cost', bmpAmt.startup, '建位图要先扫完索引。'], ['total_cost', bmpAmt.total, '和 EXPLAIN 一致。']], 'amber'))),
        board('cost', costs('路径代价', 'amount < 4000，rows 4000', [bar('Seq Scan', costSeqScan(REL, amt4000)), bar('Index Scan', idxAmt), bar('Bitmap Heap Scan', bmpAmt, true)], `EXPLAIN：Bitmap Heap Scan on orders (cost=${f2(bmpAmt.startup)}..${f2(bmpAmt.total)})`)),
      ],
    },
    {
      title: '选定计划',
      desc: '最便宜的路径变成执行计划',
      detail: `add_path 按代价淘汰被占优的路径，最后 create_plan 把胜出的路径变成计划树交给执行器。范围放大到 id < 16000 时，索引要 ${f2(idx16.total)}，顺序扫描还是 ${f2(seq16.total)}，优化器就改走全表。代价只是模型：random_page_cost 的默认值 4 偏向机械盘，SSD 上常调低。`,
      facts: [['id < 4000', `Index Scan ${f2(idx.total)}`], ['id < 16000', `Seq Scan ${f2(seq16.total)}`], ['amount < 4000', `Bitmap ${f2(bmpAmt.total)}`]],
      events: [
        board('cost', costs('路径代价', 'id < 16000，rows 15999', [bar('Seq Scan', seq16, true), bar('Index Scan', idx16)], `EXPLAIN：Seq Scan on orders (cost=0.00..${f2(seq16.total)} rows=${seq16.rows})`)),
        show('executor'),
        pk('planner', 'executor', 'green', 'PlannedStmt', ['Index Scan', `cost ${f2(idx.total)}`], [us(210), 'PLAN', 'create_plan：路径变成计划树，交给执行器', null],
          wire('计划树节点。这里只列 EXPLAIN 能看到的内容', 'vals', '示意', concept('IndexScan', [['indexid', 'orders_id', '选中的索引。'], ['indexqual', 'id < 4000', '索引条件。'], ['startup_cost', f2(idx.startup), ''], ['total_cost', f2(idx.total), ''], ['plan_rows', String(idx.rows), '']], 'green'))),
      ],
    },
  ],
  outro: {
    title: '一个可以手算的模型',
    desc: '代价公式是公开的，错了也能查出原因',
    text: '选择率来自统计信息，页数和行数来自 pg_class，权重来自几个 GUC。估错时看 EXPLAIN ANALYZE 的 rows 对比：差得多通常是统计信息问题。基于代价的选择是通用原理，这些公式和默认值是 PostgreSQL 的做法。这里没有展开并行路径。',
    facts: [['单位', '一次顺序读页'], ['关键输入', '选择率和相关性'], ['下一课', 'INDEX SCAN']],
  },
};
