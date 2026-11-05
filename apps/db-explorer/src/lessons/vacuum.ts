import { btreePageLayers, concept, heapPageLayers, heapTuple, lineArray, pageHeader, wire } from '../decode/structures';
import { BTree } from '../engine/btree';
import { parseLsn } from '../engine/bytes';
import { Clog, getSnapshot, scanPage } from '../engine/mvcc';
import { HeapPage, PD_ALL_VISIBLE } from '../engine/page';
import type { LanesBoard } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { ACCOUNTS, pageBoard, treeBoard, ms } from './shared';
import type { Lesson } from './types';

/** 同一组操作的结果已和真实页面比对（tests/golden/heap-page.json，含 VACUUM 之后）。 */
const [X1, X2, X3, XU, XD] = [744, 745, 746, 747, 748];
const heap = new HeapPage(ACCOUNTS);
const clog = new Clog();
heap.insert([1, 'ann', 100], X1, parseLsn('0/19E0250'));
heap.insert([2, 'bob', 200], X2, parseLsn('0/19E0298'));
heap.insert([3, 'cat', 300], X3, parseLsn('0/19E02E0'));
for (const x of [X1, X2, X3]) clog.set(x, 1);
scanPage(heap, getSnapshot([], X3), clog);
heap.hotUpdate(2, [2, 'bob', 150], XU, parseLsn('0/19E0458'));
clog.set(XU, 1);
scanPage(heap, getSnapshot([], XU), clog);
heap.delete(3, XD, parseLsn('0/19E04B8'));
clog.set(XD, 1);
scanPage(heap, getSnapshot([], XD), clog);

/** 索引：HOT 更新不增加索引项，所以 (0,2) 还指着旧版本；删除也不碰索引。 */
const index = new BTree(128, 0x19e1000n);
index.insert(1, [0, 1]);
index.insert(2, [0, 2]);
index.insert(3, [0, 3]);
const tree0 = treeBoard(index, { title: '索引 accounts_id', sub: '键 3 还指向 (0,3)' });

const TITLE = '堆页 accounts/0';
const before = heap.clone();
const pruned = heap.clone();
const { redirects, deadItems } = pruned.prune((off) => off === 2 || off === 3);
pruned.page.lsn = parseLsn('0/19E04F0');
const leafBefore = index.root;
const indexBefore = btreePageLayers(index, leafBefore);
const removed = index.removeTid([0, deadItems[0]])!;
const indexAfter = btreePageLayers(index, removed.block);
const tree1 = treeBoard(index, { title: '索引 accounts_id', sub: `删除了指向 (0,${deadItems[0]}) 的项`, hot: { [removed.block]: 'amber' } });
const reclaimed = pruned.clone();
reclaimed.reclaimDead(deadItems);
reclaimed.page.flags = reclaimed.page.flags | PD_ALL_VISIBLE;
reclaimed.page.lsn = parseLsn('0/19E0520');

const liveNote = (h: HeapPage) => (lp: number) => {
  const m = h.header(lp);
  if (m.xmax && (lp === 2 || lp === 3)) return `死，${m.xmax} 已提交`;
  return '活';
};

const deadList = (items: number[], sub: string, hot = false): LanesBoard => ({
  kind: 'lanes',
  title: 'dead_items：要清理的 TID',
  sub,
  cell: 70,
  labelWidth: 70,
  rows: [{ label: 'TID', cells: items.map((off) => ({ text: `(0,${off})`, hot: hot ? ('amber' as const) : undefined })) }],
  footer: '放不下时会多跑几轮索引清理',
});

export const vacuum: Lesson = {
  id: 'vacuum',
  name: 'VACUUM',
  title: '清理死元组',
  group: 'storage',
  layer: [2, 4],
  timeUnit: 'ms',
  nodes: ['vacuum', 'heap', 'btree', 'disk'],
  place: { heap: [110, 70], vacuum: [350, 165], btree: [590, 70], disk: [830, 165] },
  labels: {
    vacuum: ['VACUUM', 'heap_vacuum_rel'],
    heap: ['堆页', 'accounts/0'],
    btree: ['B+ 树', 'accounts_id'],
    disk: ['VM / FSM', '两个附属分支'],
  },
  start: ['vacuum', 'heap'],
  boards: {
    page: { rect: [20, 250, 900, 245], initial: pageBoard(before, { title: TITLE, sub: 'UPDATE 和 DELETE 之后', extra: { name: '状态', cell: liveNote(before) } }) },
    idx: { rect: [20, 503, 440, 110], initial: tree0 },
    dead: { rect: [470, 503, 450, 110], initial: deadList([], '还没开始') },
  },
  legend: [['slate', '扫描'], ['amber', '第一阶段：清理堆'], ['violet', '清理索引'], ['green', '第二阶段：回收'], [null, '页面字节和真实 VACUUM 结果一致']],
  overview: {
    full: 'MVCC 留下的旧版本，由 VACUUM 收走',
    description: 'PostgreSQL 的 UPDATE 和 DELETE 不覆盖旧数据，只留下新版本或写 xmax。旧版本占着空间，等到再没有事务需要它时，VACUUM 把它收走。清理分三步：剪枝堆页、清理索引、回收行指针。这一课的页面字节和真实 VACUUM 的结果逐字节一致。',
    facts: [
      ['入口', 'heap_vacuum_rel → lazy_scan_heap'],
      ['判定', 'HeapTupleSatisfiesVacuum'],
      ['剪枝', 'heap_page_prune_and_freeze'],
      ['索引', 'lazy_vacuum_all_indexes'],
      ['回收', 'lazy_vacuum_heap_page'],
      ['自动触发', '死元组超过 50 + 20% 行数'],
    ],
  },
  steps: [
    {
      title: '死元组怎么来的',
      desc: 'HOT 更新和删除都留下了旧版本',
      detail: `行指针 2 是 bob 的旧版本，xmax ${XU}，t_ctid 指向新版本 (0,4)。行指针 3 是被删除的 cat，xmax ${XD}。这两个事务都提交了，也没有更老的快照需要它们，所以它们已经死了。但它们还占着 80 字节。`,
      facts: [['旧版本', `行指针 2，xmax ${XU}`], ['被删除', `行指针 3，xmax ${XD}`], ['占用', '每个 40 字节']],
      events: [
        pk('vacuum', 'heap', 'slate', '读页', ['lazy_scan_heap'], [0, 'VAC', '读第 0 页，查每个元组的状态', 8192],
          wire('清理前的页面。两个死元组的 xmax 都已提交', 'mem', 'disk', ...heapPageLayers(before.page, ACCOUNTS, [2, 3]))),
        note('heap', '死了，但还占着空间', 'amber'),
      ],
    },
    {
      title: '剪枝堆页',
      desc: '没有索引项指向的直接清掉，其余留下行指针',
      detail: `第一阶段不用碰索引。行指针 2 是 HOT 链头，索引指着它，所以改成 LP_REDIRECT 指向 4，元组本身可以释放。行指针 3 没有存活版本，改成 LP_DEAD，同样释放元组，只留 4 字节行指针。PageRepairFragmentation 把剩下的元组压到页尾，pd_upper 从 ${before.page.upper} 变成 ${pruned.page.upper}。`,
      facts: [['LP_REDIRECT', `行指针 ${redirects[0][0]} → ${redirects[0][1]}`], ['LP_DEAD', `行指针 ${deadItems[0]}`], ['pd_upper', `${before.page.upper} → ${pruned.page.upper}`], ['函数', 'heap_page_prune_and_freeze']],
      events: [
        board('page', pageBoard(pruned, { title: TITLE, sub: '第一阶段：剪枝并压紧', hot: { 2: 'amber', 3: 'red', 4: 'amber' }, extra: { name: '状态', cell: () => '活，已被移动' } })),
        board('dead', deadList(deadItems, `${deadItems.length} 个`, true)),
        pk('heap', 'vacuum', 'amber', '剪枝结果', [`重定向 ${redirects.length}`, `LP_DEAD ${deadItems.length}`], [ms(1), 'VAC', 'heap_page_prune_execute：改行指针并压紧页面', 8192],
          wire('行指针 2 成了 REDIRECT，行指针 3 成了 DEAD，元组 4 被移到页尾', 'mem', 'disk', pageHeader(pruned.page), lineArray(pruned.page), heapTuple(pruned.page, 4, ACCOUNTS, 'amber', { ctid: '仍指向自己。HOT 链上的 t_ctid 不变。' }))),
      ],
    },
    {
      title: '清理索引',
      desc: '先删索引项，行指针才能回收',
      detail: `行指针 3 现在还不能复用：索引里有一项指向 (0,3)。如果立刻复用，索引扫描会读到不相干的行。所以 VACUUM 收集 LP_DEAD 的 TID，扫一遍索引，把对应的项删掉。这一步通常是 VACUUM 里最贵的，因为要扫整个索引。`,
      facts: [['要删的 TID', `(0,${deadItems[0]})`], ['函数', 'lazy_vacuum_all_indexes → btbulkdelete'], ['存放', 'TidStore（PG 17 起），上限 maintenance_work_mem'], ['HOT 的好处', '行指针 2 的重定向不用动索引']],
      events: [
        show('btree'),
        pk('vacuum', 'btree', 'violet', 'btbulkdelete', [`(0,${deadItems[0]})`], [ms(20), 'VAC', 'btvacuumscan 顺序读所有索引页', 128],
          wire('清理前的叶子页，真实布局，页缩小。第 3 项指向 (0,3)', 'mem', 'scaled', ...indexBefore)),
        board('idx', tree1),
        pk('btree', 'vacuum', 'violet', '删除完成', ['tuples_removed 1'], [ms(30), 'VAC', `从块 ${removed.block} 删除第 ${removed.off} 项`, 128],
          wire('清理后的叶子页', 'mem', 'scaled', ...indexAfter)),
      ],
    },
    {
      title: '回收行指针',
      desc: 'LP_DEAD 变成 LP_UNUSED，可以复用了',
      detail: `索引项都删了，lazy_vacuum_heap_page 把行指针 3 改成 LP_UNUSED，并打开 PD_HAS_FREE_LINES。行指针数组不会缩小，除非未用的项在末尾；所以 pd_lower 还是 ${reclaimed.page.lower}。这一页所有元组都对所有事务可见了，同时设 PD_ALL_VISIBLE。下一次插入会直接复用编号 3。`,
      facts: [['行指针 3', 'LP_UNUSED'], ['pd_flags', `0x000${reclaimed.page.flags}（FREE_LINES | ALL_VISIBLE）`], ['下一次插入', '复用行指针 3']],
      events: [
        board('page', pageBoard(reclaimed, { title: TITLE, sub: '第二阶段：和真实结果逐字节一致', hot: { 3: 'green' }, extra: { name: '状态', cell: () => '活' } })),
        board('dead', deadList([], '清空')),
        pk('vacuum', 'heap', 'green', 'LP_UNUSED', [`行指针 ${deadItems[0]}`], [ms(40), 'VAC', '第二次访问这一页，回收行指针', 8192],
          wire('最终的页面，和 VACUUM accounts 之后的 get_raw_page 一致（pd_lsn 除外）', 'mem', 'disk', pageHeader(reclaimed.page), lineArray(reclaimed.page), heapTuple(reclaimed.page, 1, ACCOUNTS), heapTuple(reclaimed.page, 4, ACCOUNTS))),
      ],
    },
    {
      title: '更新两张地图',
      desc: '可见性映射和空闲空间映射',
      detail: '这一页全可见，就在可见性映射（VM）里置位：以后 VACUUM 可以跳过它，Index Only Scan 也不用回表。释放的空间记进空闲空间映射（FSM），以后插入能找到。VM 和 FSM 都是表文件的附属分支，文件名后缀是 _vm 和 _fsm。',
      facts: [['VM', '每页 2 位：全可见、全冻结'], ['FSM', '每页 1 字节的近似空闲量'], ['分支号', 'FSM = 1，VM = 2']],
      events: [
        show('disk'),
        pk('vacuum', 'disk', 'green', '更新 VM/FSM', ['全可见', `空闲 ${reclaimed.page.upper - reclaimed.page.lower} 字节`], [ms(50), 'VAC', 'visibilitymap_set、RecordPageWithFreeSpace', null],
          wire('两张地图的内容', 'vals', '示意', concept('第 0 页的记录', [['VM all_visible', '1', '这一页所有元组对所有事务可见。'], ['VM all_frozen', '0', '元组的 xmin 还没冻结。'], ['FSM', `约 ${reclaimed.page.upper - reclaimed.page.lower} 字节`, '按 1/256 页的精度存。']], 'green'))),
      ],
    },
    {
      title: '空间还给谁',
      desc: '留给本表复用，一般不还给操作系统',
      detail: '普通 VACUUM 只是把空间标记为可复用，文件不会变小。唯一的例外是文件末尾连续的空页，lazy_truncate_heap 会截掉。要真正缩小文件得用 VACUUM FULL 或 CLUSTER，它们重写整张表，还要拿 AccessExclusive 锁。VACUUM 的另一个任务是冻结旧事务号，防止 32 位事务号回卷。',
      facts: [['普通 VACUUM', '文件一般不缩小'], ['缩小文件', 'VACUUM FULL（排他锁）'], ['冻结', '防止事务号回卷']],
      events: [
        note('disk', '文件大小不变', 'amber'),
        pk('vacuum', 'heap', 'slate', '结束', ['n_dead_tup = 0'], [ms(60), 'VAC', 'lazy_cleanup_all_indexes，更新 pg_class 和统计', null],
          wire('这一轮的结果', 'vals', '示意', concept('真实 VACUUM (VERBOSE) 的输出', [['tuples', '2 removed, 2 remain', '两个死版本被清理。'], ['pages', '0 removed, 1 remain, 1 scanned', ''], ['index scans', '1', '做了一轮索引清理。'], ['index scan needed', '1 dead item identifiers removed', '只有行指针 3 需要动索引。']], 'slate'))),
      ],
    },
  ],
  outro: {
    title: 'MVCC 的账单',
    desc: '不用 undo，代价就是定期打扫',
    text: '这是 PostgreSQL 的多版本设计带来的：旧版本和新版本都放在堆里，所以需要 VACUUM。用 undo 日志的数据库（如 InnoDB、Oracle）把旧版本放在别处，有自己的清理机制。长事务会阻止清理，这是表膨胀最常见的原因。',
    facts: [['阻止清理', '长事务、复制槽、预备事务'], ['HOT', '减少索引清理'], ['下一课', 'MVCC']],
  },
};
