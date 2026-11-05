import { hashTupleHeader, minimalTuple, values, wire } from '../decode/structures';
import { chooseHashTableSize, HashJoin, type HashRow } from '../engine/hashjoin';
import type { Attr } from '../engine/page';
import type { HashBoard, LanesBoard } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { hexU32, us } from './shared';
import type { Lesson } from './types';

/** 内表的物理顺序。正好批 0 的行都在前面，这样动画顺序就是真实的读取顺序。 */
const CUSTOMERS: HashRow[] = [{ key: 1, name: 'ann' }, { key: 2, name: 'bob' }, { key: 3, name: 'cat' }, { key: 6, name: 'fay' }, { key: 8, name: 'hal' }, { key: 4, name: 'dan' }, { key: 5, name: 'eve' }, { key: 7, name: 'gus' }];
const ORDERS: HashRow[] = [{ key: 2, name: '订单A' }, { key: 5, name: '订单B' }, { key: 9, name: '订单C' }, { key: 1, name: '订单D' }, { key: 8, name: '订单E' }, { key: 4, name: '订单F' }];
const SCHEMA: Attr[] = [{ name: 'id', type: 'int4' }, { name: 'name', type: 'text' }];

const NBUCKETS = 8;
const NBATCH = 2;
const real = chooseHashTableSize(20000, 19, 64 * 1024);
const big = chooseHashTableSize(20000, 19, 8 * 1024 * 1024);

const join = new HashJoin(NBUCKETS, NBATCH);
const buildSteps = CUSTOMERS.map((row) => join.insert(row));
const inserted = buildSteps.filter((step) => step.action === 'insert');
const spilled = buildSteps.filter((step) => step.action === 'spill');

function hashBoard(sub: string, opts: { hot?: number; hotKey?: number; footer?: string; inner?: number; outer?: Array<{ text: string }>; title?: string; showInner?: boolean } = {}): HashBoard {
  return {
    kind: 'hash',
    title: opts.title ?? `哈希表 · ${NBUCKETS} 桶 ${NBATCH} 批`,
    sub,
    hotBucket: opts.hot,
    footer: opts.footer,
    buckets: stage.buckets.map((chain) => chain.map((row) => ({ text: `${row.key} ${row.name}`, hot: row.key === opts.hotKey ? ('amber' as const) : undefined }))),
    files: [
      { label: '批 1 内表（customers）', items: stage.inner.map((row) => ({ text: `${row.key} ${row.name}`, hot: row.key === opts.hotKey ? ('amber' as const) : undefined })) },
      { label: '批 1 外表（orders）', items: stage.outer.map((row) => ({ text: `${row.key} ${row.name}` })) },
    ],
  };
}

interface Stage { buckets: HashRow[][]; inner: HashRow[]; outer: HashRow[] }
const stage: Stage = { buckets: Array.from({ length: NBUCKETS }, () => []), inner: [], outer: [] };

function results(rows: string[], sub: string): LanesBoard {
  return { kind: 'lanes', title: '连接结果', sub, cell: 86, labelWidth: 42, rows: rows.length ? [{ label: '输出', cells: rows.map((text, i) => ({ text, hot: i === rows.length - 1 ? ('green' as const) : undefined })) }] : [] };
}

const events = {
  build: [] as Array<ReturnType<typeof pk> | ReturnType<typeof board>>,
  spill: [] as Array<ReturnType<typeof pk> | ReturnType<typeof board>>,
  probe: [] as Array<ReturnType<typeof pk> | ReturnType<typeof board>>,
  second: [] as Array<ReturnType<typeof pk> | ReturnType<typeof board>>,
};

let t = 120;
function hashWire(step: { row: HashRow; hash: number }, where: string) {
  const min = minimalTuple(SCHEMA, [step.row.key, step.row.name]);
  return wire(where, 'mem', 'internal', hashTupleHeader(step.hash, NBUCKETS, NBATCH), min.layer);
}

for (const step of buildSteps) {
  t += 40;
  if (step.action === 'insert') {
    stage.buckets[step.bucket] = [step.row, ...stage.buckets[step.bucket]];
    events.build.push(
      pk('heap', 'executor', 'blue', `${step.row.key} ${step.row.name}`, [`hash ${hexU32(step.hash)}`, `桶 ${step.bucket}，批 0`], [us(t), 'HASH', `hashint4(${step.row.key}) → 桶 ${step.bucket} 批 ${step.batch}，放入内存`, null], hashWire(step, '哈希表内存块（HashMemoryChunk）'), { quick: true }),
      board('hash', hashBoard(`建表：${step.row.key} → 桶 ${step.bucket}`, { hot: step.bucket, hotKey: step.row.key })),
    );
  } else {
    stage.inner.push(step.row);
    events.spill.push(
      pk('executor', 'temp', 'amber', `${step.row.key} ${step.row.name}`, [`hash ${hexU32(step.hash)}`, `批 ${step.batch}`], [us(t), 'HASH', `hashint4(${step.row.key}) → 批 ${step.batch}，写临时文件`, null], hashWire(step, 'ExecHashJoinSaveTuple 写到 BufFile：真实文件里是 4 字节哈希值 + MinimalTuple'), { quick: true }),
      board('hash', hashBoard(`批 1：${step.row.key} 写到临时文件`, { hotKey: step.row.key })),
    );
  }
}
const afterBuild = hashBoard('内表读完', { footer: `批 0 放内存，批 1 写文件` });

const out: string[] = [];
const probeSteps = ORDERS.map((row) => join.probe(row));
for (const step of probeSteps) {
  t += 60;
  if (step.action === 'spill') {
    stage.outer.push(step.row);
    events.probe.push(
      pk('heap2', 'temp', 'amber', `${step.row.key} ${step.row.name}`, [`批 ${step.batch}`], [us(t), 'HASH', `外表行 ${step.row.key}：批 ${step.batch} 还没加载，写临时文件`, null], hashWire(step, '外表元组，同样写到临时文件'), { quick: true }),
      board('hash', hashBoard(`探测：${step.row.key} 属于批 1`, { hotKey: step.row.key })),
    );
  } else {
    if (step.matches.length) out.push(`${step.row.name} ${step.matches[0].name}`);
    events.probe.push(
      pk('heap2', 'executor', 'green', `${step.row.key} ${step.row.name}`, [`桶 ${step.bucket}，比较 ${step.compared} 个`, step.matches.length ? `匹配 ${step.matches[0].name}` : '没有匹配'], [us(t), 'HASH', `探测桶 ${step.bucket}：${step.matches.length ? `匹配 ${step.matches[0].name}` : '链表里没有这个键'}`, null], hashWire(step, '外表元组。先比 hashvalue，相同才比键'), { quick: true }),
      board('hash', hashBoard(`探测：${step.row.key} → 桶 ${step.bucket}`, { hot: step.bucket, hotKey: step.row.key })),
      board('out', results([...out], `批 0，${out.length} 行`)),
    );
  }
}

// 第二批：清空内存，读回内表重建，再读外表文件探测。
t += 200;
const loaded = join.loadBatch(1);
const outerSaved = [...stage.outer];
stage.buckets = Array.from({ length: NBUCKETS }, () => []);
for (const step of loaded) stage.buckets[step.bucket] = [step.row, ...stage.buckets[step.bucket]];
stage.inner = [];
events.second.push(
  pk('temp', 'executor', 'violet', '载入批 1', [`${loaded.length} 行`], [us(t), 'HASH', 'ExecHashJoinNewBatch：清空哈希表，读回批 1 的内表', null],
    wire('临时文件格式：4 字节哈希值 + MinimalTuple。这里是第一行', 'mem', 'internal', values('BufFile 里的头', [['hashvalue', loaded[0].hash, '读回时不用重新计算哈希。', { shown: hexU32(loaded[0].hash) }]], 'violet'), minimalTuple(SCHEMA, [loaded[0].row.key, loaded[0].row.name]).layer)),
  board('hash', hashBoard('批 1 重新建表', { footer: '桶数组是同一个，只是内容换了' })),
);
for (const row of outerSaved) {
  t += 60;
  const step = join.probe(row, 1);
  stage.outer = stage.outer.filter((item) => item !== row);
  if (step.matches.length) out.push(`${row.name} ${step.matches[0].name}`);
  events.second.push(
    pk('temp', 'executor', 'green', `${row.key} ${row.name}`, [`桶 ${step.bucket}`, step.matches.length ? `匹配 ${step.matches[0].name}` : '没有匹配'], [us(t), 'HASH', `批 1 探测桶 ${step.bucket}：${step.matches.length ? `匹配 ${step.matches[0].name}` : '没有匹配'}`, null], hashWire(step, '从临时文件读回的外表元组'), { quick: true }),
    board('hash', hashBoard(`批 1 探测：${row.key} → 桶 ${step.bucket}`, { hot: step.bucket, hotKey: row.key })),
    board('out', results([...out], `共 ${out.length} 行`)),
  );
}

const firstInsert = buildSteps[0];

export const hashjoin: Lesson = {
  id: 'hashjoin',
  name: 'HASH JOIN',
  title: '哈希连接',
  group: 'query',
  layer: [6, 6],
  timeUnit: 'µs',
  nodes: ['heap', 'executor', 'heap2', 'temp'],
  place: { heap: [110, 70], executor: [350, 165], heap2: [590, 70], temp: [830, 165] },
  labels: {
    heap: ['内表', 'customers'],
    executor: ['执行器', 'ExecHashJoin'],
    heap2: ['外表', 'orders'],
    temp: ['临时文件', 'BufFile'],
  },
  start: ['heap', 'executor'],
  boards: {
    hash: { rect: [20, 250, 900, 270], initial: { kind: 'hash', title: `哈希表 · ${NBUCKETS} 桶 ${NBATCH} 批`, sub: '空', buckets: Array.from({ length: NBUCKETS }, () => []), files: [{ label: '批 1 内表（customers）', items: [] }, { label: '批 1 外表（orders）', items: [] }] } },
    out: { rect: [20, 528, 900, 76], initial: results([], '还没有') },
  },
  legend: [['blue', '建表'], ['amber', '写临时文件'], ['green', '探测'], ['violet', '载入下一批'], [null, '哈希值是真实的 hashint4']],
  overview: {
    full: '小表建哈希表，大表来探测',
    description: 'SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id。等值连接时，把小表（内表）按连接键放进哈希表，再让大表（外表）逐行来查。内存放不下时分成几批，一批一批做。这一课的桶号和批号都由真实的 hashint4 算出。',
    facts: [
      ['哈希函数', 'hashint4 → hash_bytes_uint32'],
      ['桶号', 'hashvalue & (nbuckets - 1)'],
      ['批号', 'pg_rotate_right32(hashvalue, log2_nbuckets) & (nbatch - 1)'],
      ['内存上限', 'work_mem × hash_mem_multiplier（默认 2.0）'],
      ['最少桶数', '1024（这里缩成 8 桶方便观看）'],
      ['只支持', '等值连接'],
    ],
  },
  steps: [
    {
      title: '决定大小',
      desc: '按估计的行数定桶数和批数',
      detail: `ExecChooseHashTableSize 先估内表要占多少内存。真实例子：20000 行、宽 19 字节。hash_mem 是 64 kB 时放不下，得到 ${real.nbuckets} 桶 ${real.nbatch} 批；是 8 MB（默认）时一批就够，${big.nbuckets} 桶。两个结果都和 EXPLAIN ANALYZE 一致。桶数总是 2 的幂，因为取桶号用位运算。`,
      facts: [['每行开销', `${real.tupsize} 字节（16 + 16 + 24）`], ['64 kB', `${real.nbuckets} 桶 ${real.nbatch} 批`], ['8 MB', `${big.nbuckets} 桶 ${big.nbatch} 批`], ['本课', `缩小成 ${NBUCKETS} 桶 ${NBATCH} 批`]],
      events: [
        pk('heap', 'executor', 'slate', '内表统计', ['20000 行', '宽 19'], [0, 'HASH', 'ExecHashTableCreate → ExecChooseHashTableSize', null],
          wire('ExecChooseHashTableSize 的输入和输出', 'vals', 'internal', values('真实例子', [['ntuples', 20000, '优化器估计的内表行数。'], ['tupwidth', 19, '平均行宽。'], ['tupsize', real.tupsize, 'HJTUPLE_OVERHEAD 16 + MAXALIGN(头 15) 16 + MAXALIGN(19) 24。'], ['hash_table_bytes', 64 * 1024, 'work_mem=64kB、hash_mem_multiplier=1。默认是 4 MB × 2。'], ['nbuckets', real.nbuckets, ''], ['nbatch', real.nbatch, 'EXPLAIN ANALYZE：Buckets: 1024  Batches: 32。']], 'slate'))),
        note('executor', `本课：${NBUCKETS} 桶 ${NBATCH} 批`),
      ],
    },
    {
      title: '建哈希表',
      desc: '批 0 的行放进内存里的桶',
      detail: `每行算哈希值，低 ${Math.log2(NBUCKETS)} 位是桶号，再往上 ${Math.log2(NBATCH)} 位是批号。批 0 的行放进内存，用头插法挂到桶的链表上，所以新来的在最前面。例如键 ${firstInsert.row.key} 的哈希值是 ${hexU32(firstInsert.hash)}。`,
      facts: [['放入内存', inserted.map((step) => step.row.key).join(', ')], ['插入方式', '头插，O(1)'], ['函数', 'ExecHashTableInsert']],
      events: events.build,
    },
    {
      title: '写到临时文件',
      desc: '批 1 的行先存盘，等会儿再处理',
      detail: '批号不是当前批的行不进哈希表，写到这一批对应的临时文件。批号和桶号取自哈希值里不同的位，所以同一批的行还能均匀分到各个桶。如果实际比估计大，运行时还会把批数翻倍（ExecHashIncreaseNumBatches）。',
      facts: [['写入文件', spilled.map((step) => step.row.key).join(', ') || '没有'], ['函数', 'ExecHashJoinSaveTuple'], ['文件格式', '哈希值 + MinimalTuple']],
      events: [show('temp'), ...events.spill, board('hash', afterBuild)],
    },
    {
      title: '探测',
      desc: '外表逐行查桶，批 1 的行也先存盘',
      detail: '外表每一行也算哈希值。属于批 0 就查桶：沿链表先比哈希值，相同再调用等值函数比键，这样大多数不匹配的行不用比键。属于批 1 的行写到外表的临时文件，因为它的匹配对象还不在内存里。',
      facts: [['比较顺序', '先比 hashvalue，再比键'], ['函数', 'ExecScanHashBucket'], ['批 0 结果', `${probeSteps.filter((s) => s.matches.length).length} 行`]],
      events: [show('heap2'), ...events.probe],
    },
    {
      title: '处理下一批',
      desc: '清空内存，读回批 1 再做一遍',
      detail: `批 0 做完后，ExecHashJoinNewBatch 清空哈希表，把批 1 的内表读回来重建，再把批 1 的外表读出来探测。两边用同样的哈希函数和批号公式，所以能匹配的行一定在同一批。这就是 Grace 哈希连接的思路。`,
      facts: [['读回内表', `${loaded.length} 行`], ['读回外表', `${outerSaved.length} 行`], ['最终结果', `${out.length} 行`]],
      events: events.second,
    },
  ],
  outro: {
    title: '用内存换比较次数',
    desc: '建表和探测都是线性的',
    text: '嵌套循环要比较内外表每一对，哈希连接只比同一桶里的。代价是必须等值、要占内存。分桶和分批是通用原理；hashint4、1024 的最小桶数、hash_mem_multiplier 和 MinimalTuple 格式是 PostgreSQL 的做法。这里省略了倾斜优化和并行哈希。',
    facts: [['前提', '等值条件'], ['内存不够', '分批写临时文件'], ['下一课', 'EXTERNAL SORT']],
  },
};

