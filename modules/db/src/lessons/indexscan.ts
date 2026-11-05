import { btMeta, btreePageLayers, concept, heapTuple, snapshotValues, wire } from '../decode/structures';
import { BTree } from '../engine/btree';
import { Clog, getSnapshot, satisfiesMVCC } from '../engine/mvcc';
import { HeapPage } from '../engine/page';
import type { TableBoard } from '../scene/board-types';
import { board, note, pk, render, show, type as typed } from './dsl';
import { ACCOUNTS, treeBoard, us } from './shared';
import type { Lesson } from './types';

/** 每页只放 4 项的真实 B 树，和 8 KiB 页共用同一份实现（后者已和 PostgreSQL 逐字节比对）。 */
const PAGE = 128;
const KEYS = [40, 10, 70, 20, 90, 50, 30, 80, 60, 42, 45, 48];
const tree = new BTree(PAGE, 0x19e1000n);
const heap = new HeapPage(ACCOUNTS);
const clog = new Clog();
const OLD = 700;
for (const [i, key] of KEYS.entries()) {
  const xid = OLD + i;
  const off = heap.insert([key, `u${key}`, key * 10], xid);
  clog.set(xid, 1);
  tree.insert(key, [0, off]);
}
/** 键 45 这一行已被删除并提交，但索引项还在：索引里没有可见性信息。 */
const DELETED = KEYS.indexOf(45) + 1;
heap.delete(DELETED, 720);
clog.set(720, 1);

const snap = getSnapshot([], 720);
const LOW = 42;
const HIGH = 50;
const { path, leaf: firstLeaf } = tree.search(LOW);
const first = tree.firstAtLeast(LOW);
const nextLeaf = tree.opaque(firstLeaf).next;
const rootBlock = tree.root;

/** 按右链扫描，得到范围内所有真实的索引项和回表结果。 */
interface Hit { key: number; tid: [number, number]; leaf: number; visible: boolean; why: string }
function rangeScan(): Hit[] {
  const hits: Hit[] = [];
  let block = first.leaf;
  let off = first.off;
  for (;;) {
    const page = tree.pages[block];
    for (; off <= page.maxOffset; off++) {
      const t = tree.tuple(block, off);
      if (t.key! >= HIGH) return hits;
      const verdict = satisfiesMVCC(heap.tuple(t.posid), snap, clog);
      hits.push({ key: t.key!, tid: [t.block, t.posid], leaf: block, visible: verdict.visible, why: verdict.path.at(-1)! });
    }
    block = tree.opaque(block).next;
    if (!block) return hits;
    off = tree.firstData(block);
  }
}
const hits = rangeScan();
const shownHits = (count: number): TableBoard => ({
  kind: 'table',
  title: '回表结果',
  sub: `WHERE id >= ${LOW} AND id < ${HIGH}`,
  columns: ['键', '叶子块', 'TID', '堆元组 xmax', '可见性', '结果'],
  widths: [40, 60, 60, 90, 70, 180],
  rows: hits.slice(0, count).map((hit, i) => {
    const h = heap.header(hit.tid[1]);
    return { cells: [String(hit.key), String(hit.leaf), `(${hit.tid[0]},${hit.tid[1]})`, String(h.xmax), hit.visible ? '可见' : '不可见', hit.visible ? String(heap.values(hit.tid[1]).join(', ')) : '被删除，跳过'], hot: i === count - 1 ? (hit.visible ? 'green' : 'red') : undefined, muted: !hit.visible };
  }),
  note: count ? undefined : '还没有回表',
});

const invisibleIndex = hits.findIndex((hit) => !hit.visible);
const footer = `真实 8 KiB 页能放约 407 个 int4 键，这里每页只放 4 项`;

export const indexscan: Lesson = {
  id: 'indexscan',
  name: 'INDEX SCAN',
  title: '索引扫描',
  group: 'query',
  layer: [4, 6],
  timeUnit: 'µs',
  nodes: ['client', 'executor', 'btree', 'heap'],
  place: { client: [110, 70], executor: [350, 165], btree: [590, 70], heap: [830, 165] },
  labels: {
    client: ['客户端', '等结果'],
    executor: ['执行器', 'ExecIndexScan'],
    btree: ['B+ 树', 'accounts_id'],
    heap: ['堆文件', 'accounts'],
  },
  start: ['client', 'executor'],
  boards: {
    tree: { rect: [20, 250, 900, 262], initial: treeBoard(tree, { title: '索引 accounts_id', sub: `树高 ${tree.level}，每页 ${PAGE} 字节`, footer }) },
    rows: { rect: [20, 520, 900, 150], initial: shownHits(0) },
  },
  legend: [['blue', '扫描请求'], ['violet', '读索引页'], ['amber', '回表'], ['green', '返回结果'], [null, '每次读页都经过缓冲池，这里省略']],
  overview: {
    full: '从元页到叶子，再按 TID 回表',
    description: `索引只回答“这个键的行在哪里”，答案是一个 TID（页号，行指针号）。它不知道这一行对当前事务是否可见，所以每个 TID 都要回堆确认。这一课沿真实的 B 树扫描 id >= ${LOW} AND id < ${HIGH}，其中有一行已被删除。`,
    facts: [
      ['入口', '_bt_first'],
      ['下降', '_bt_search，每层二分 _bt_binsrch'],
      ['读叶子', '_bt_readpage'],
      ['下一个叶子', '_bt_steppage，走 btpo_next'],
      ['回表', 'index_fetch_heap'],
      ['可见性', 'HeapTupleSatisfiesMVCC'],
    ],
  },
  steps: [
    {
      title: '读元页',
      desc: '第 0 页记着根在哪里',
      detail: '索引的第 0 页是元页，不存键，只记根的块号和层数。根会随分裂变化，所以每次扫描都要从这里开始（结果会缓存在 relcache 里）。这是 PostgreSQL 的做法；很多教科书的 B+ 树没有元页这一层。',
      facts: [['btm_root', String(rootBlock)], ['btm_level', String(tree.level)], ['缓存', '_bt_getroot 用 rd_amcache']],
      events: [
        typed(`SELECT * FROM accounts WHERE id >= ${LOW} AND id < ${HIGH};`),
        show('btree'),
        pk('executor', 'btree', 'blue', '_bt_first', [`id >= ${LOW}`], [0, 'SCAN', '执行器要第一个匹配的 TID', null],
          wire('计划节点给出的扫描键', 'vals', '示意', concept('ScanKey', [['sk_attno', '1', '索引第 1 列。'], ['sk_strategy', 'BTGreaterEqualStrategyNumber', '>=。'], ['sk_argument', String(LOW), '起始键。']], 'blue'))),
        pk('btree', 'executor', 'violet', '元页', [`根 = 块 ${rootBlock}`], [us(30), 'PAGE', `读第 0 页，btm_root = ${rootBlock}`, PAGE],
          wire('索引第 0 页。真实布局，页缩小', 'mem', 'scaled', btMeta(tree))),
        board('tree', treeBoard(tree, { title: '索引 accounts_id', sub: `根 = 块 ${rootBlock}`, hot: { [rootBlock]: 'amber' }, footer })),
      ],
    },
    {
      title: '向下二分',
      desc: '每层在页内二分，选一个下行链接',
      detail: `内部页的第一项是负无穷，比任何键都小。查找键 ${LOW} 在根页二分，找到最后一个不大于它的分隔键，跟着下行链接走。比较次数是对数级，索引很大时也只有几层。B 树页很宽，这是它矮的原因。`,
      facts: [['路径', [...path.map((p) => `块 ${p.block}`), `块 ${firstLeaf}`].join(' → ')], ['函数', '_bt_search + _bt_binsrch'], ['每页键数', '真实 8 KiB 页约 407 个']],
      events: path.flatMap((step, index) => [
        pk('btree', 'executor', 'violet', `块 ${step.block}`, [`下行 → 块 ${step.next}`], [us(60 + index * 30), 'PAGE', `二分内部页，选下行链接到块 ${step.next}`, PAGE],
          wire(`内部页块 ${step.block}。真实布局，页缩小`, 'mem', 'scaled', ...btreePageLayers(tree, step.block)), { quick: true }),
        board('tree', treeBoard(tree, {
          title: '索引 accounts_id',
          sub: `id >= ${LOW}：下降到第 ${index + 1} 层`,
          hot: { [step.block]: 'amber' },
          hotKey: { [step.block]: step.chosen - tree.firstData(step.block) },
          path: path.slice(0, index + 1).map((p): [number, number] => [p.block, p.next]),
          footer,
        })),
      ]),
    },
    {
      title: '读叶子页',
      desc: '叶子里是键和 TID',
      detail: `到了块 ${firstLeaf}。_bt_binsrch 找到第一个不小于 ${LOW} 的项，_bt_readpage 把这一页里所有匹配的项一次收进内存，然后放开页锁。这样扫描不用长时间持有叶子页，别人可以并发插入。虚线格子是 high key，它是这一页的上界，不指向任何行。`,
      facts: [['起始行指针', String(first.off)], ['TID', `(${tree.tuple(first.leaf, first.off).block},${tree.tuple(first.leaf, first.off).posid})`], ['high key', String(tree.highKey(firstLeaf))]],
      events: [
        pk('btree', 'executor', 'violet', '叶子页', [`第 ${first.off} 项起`], [us(130), 'PAGE', `读叶子块 ${firstLeaf}，收集匹配的 TID`, PAGE],
          wire(`叶子页块 ${firstLeaf}。真实布局，页缩小`, 'mem', 'scaled', ...btreePageLayers(tree, firstLeaf))),
        board('tree', treeBoard(tree, { title: '索引 accounts_id', sub: `叶子块 ${firstLeaf}`, hot: { [firstLeaf]: 'amber' }, hotKey: { [firstLeaf]: first.off - tree.firstData(firstLeaf) }, path: path.map((p): [number, number] => [p.block, p.next]), footer })),
      ],
    },
    {
      title: '回表',
      desc: '按 TID 取元组，并判断可见性',
      detail: `索引项没有 xmin 和 xmax。执行器拿 TID (${hits[0].tid.join(',')}) 读堆页，再用快照判断这个版本能不能看。这就是回表，也是索引扫描慢的主要来源：TID 分散在很多页时，每次都可能是一次随机读。`,
      facts: [['函数', 'index_fetch_heap'], ['HOT 链', 'heap_hot_search_buffer 顺着链找可见版本'], ['判断', 'HeapTupleSatisfiesMVCC']],
      events: [
        show('heap'),
        pk('executor', 'heap', 'amber', '取元组', [`TID (${hits[0].tid.join(',')})`], [us(180), 'PAGE', `index_fetch_heap：读堆页 ${hits[0].tid[0]}`, heap.page.lp(hits[0].tid[1]).len],
          wire('拍快照时的 SnapshotData', 'vals', 'internal', snapshotValues(snap))),
        pk('heap', 'executor', 'amber', '元组', [`id = ${hits[0].key}`, '可见'], [us(230), 'PAGE', `${hits[0].why}`, heap.page.lp(hits[0].tid[1]).len],
          wire(`堆页 0 上的真实元组，页内偏移 ${heap.page.lp(hits[0].tid[1]).off}`, 'mem', 'disk', heapTuple(heap.page, hits[0].tid[1], ACCOUNTS))),
        board('rows', shownHits(1)),
      ],
    },
    {
      title: '索引项指向死元组',
      desc: '索引还指着，堆上已经不可见',
      detail: `键 ${hits[invisibleIndex].key} 的索引项还在，因为 DELETE 只在堆元组上写 xmax，从不碰索引。回表后发现 xmax ${heap.header(hits[invisibleIndex].tid[1]).xmax} 已提交，这一行对当前快照不可见，跳过。扫描如果确认它对所有人都死了，会把索引项标 LP_DEAD，下次就不用再回表。`,
      facts: [['键', String(hits[invisibleIndex].key)], ['判断结果', '不可见'], ['清理者', 'VACUUM（或机会性删除）']],
      events: [
        pk('heap', 'executor', 'amber', '不可见', [`xmax ${heap.header(hits[invisibleIndex].tid[1]).xmax}`], [us(290), 'PAGE', `键 ${hits[invisibleIndex].key}：${hits[invisibleIndex].why}`, heap.page.lp(hits[invisibleIndex].tid[1]).len],
          wire('这个元组的 t_xmax 已写入', 'mem', 'disk', heapTuple(heap.page, hits[invisibleIndex].tid[1], ACCOUNTS, 'amber', { xmax: '删除它的事务。已提交，所以当前快照看不到这一行。' }))),
        board('rows', shownHits(invisibleIndex + 1)),
        note('heap', '索引不知道它已被删除', 'amber'),
      ],
    },
    {
      title: '沿右链继续',
      desc: '一页扫完，走 btpo_next 到右边的叶子',
      detail: `范围可能跨页。叶子之间有 btpo_next 链接，所以不用回到根。走到下一个叶子块 ${nextLeaf}，读到第一个大于等于 ${HIGH} 的键时结束。这条右链和 high key 来自 Lehman 和 Yao 的 B-link 树，它们也让并发分裂时的扫描不会丢数据。`,
      facts: [['函数', '_bt_steppage → _bt_readnextpage'], ['右链', `块 ${firstLeaf} → 块 ${nextLeaf}`], ['结果行数', String(hits.filter((hit) => hit.visible).length)]],
      events: [
        pk('btree', 'executor', 'violet', '下一页', [`块 ${nextLeaf}`], [us(340), 'PAGE', `_bt_steppage：沿 btpo_next 到块 ${nextLeaf}`, PAGE],
          wire(`叶子页块 ${nextLeaf}。注意上一页的 btpo_next 指向它`, 'mem', 'scaled', ...btreePageLayers(tree, nextLeaf))),
        board('tree', treeBoard(tree, { title: '索引 accounts_id', sub: `沿右链到块 ${nextLeaf}`, hot: { [nextLeaf]: 'amber', [firstLeaf]: 'teal' }, footer })),
        board('rows', shownHits(hits.length)),
        pk('executor', 'client', 'green', '结果', [`${hits.filter((hit) => hit.visible).length} 行`], [us(420), 'MSG', `返回 ${hits.filter((hit) => hit.visible).length} 行，跳过 ${hits.filter((hit) => !hit.visible).length} 行`, null],
          wire('结果集', 'vals', '示意', concept('输出', hits.filter((hit) => hit.visible).map((hit): [string, string, string] => [`id ${hit.key}`, heap.values(hit.tid[1]).join(', '), `来自 TID (${hit.tid.join(',')})`]), 'green'))),
        render,
      ],
    },
  ],
  outro: {
    title: '索引只给位置',
    desc: '可见性永远在堆上判断',
    text: '只有一种情况可以不回表：Index Only Scan，列都在索引里，并且可见性映射说这一页全可见。B+ 树是通用结构；元页、high key、右链、TID 回表和 LP_DEAD 标记是 PostgreSQL 的具体做法。',
    facts: [['索引项内容', '键 + TID'], ['免回表', 'Index Only Scan + VM'], ['下一课', 'HASH JOIN']],
  },
};
