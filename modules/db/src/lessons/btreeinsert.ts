import { btMeta, btreePageLayers, concept, wire } from '../decode/structures';
import { BTree, type InsertLog } from '../engine/btree';
import type { KvBoard } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { treeBoard, us } from './shared';
import type { Lesson } from './types';

/** 同一份 B 树代码在 8 KiB 页上和 PostgreSQL 逐字节一致；这里只把页缩到每页 4 项。 */
const PAGE = 128;
const tree = new BTree(PAGE, 0x19e1000n);
const FOOTER = '虚线格是 high key，青色虚线是右链。真实 8 KiB 页能放约 407 个 int4 键';
const TITLE = 'accounts_id';

const emptyInfo = (rows: KvBoard['rows'], sub = '第 0 页 + 每次插入的结果'): KvBoard => ({ kind: 'kv', title: '发生了什么', sub, keyWidth: 150, rows });

const initialTree = treeBoard(tree, { title: TITLE, sub: '只有元页', footer: FOOTER });
const metaWire = btMeta(tree);

const ins = (key: number): InsertLog => tree.insert(key, [0, key]);

// 第 1 步：第一个键触发建根。
const log0 = ins(50);
const rootLeafWire = btreePageLayers(tree, log0.leaf);
const t0 = treeBoard(tree, { title: TITLE, sub: `插入 50：块 ${log0.leaf} 既是根也是叶子`, hot: { [log0.leaf]: 'amber' }, footer: FOOTER });

// 第 2 步：继续插入，保持有序。
const log1 = ins(20);
const log2 = ins(80);
const t1 = treeBoard(tree, { title: TITLE, sub: `插入 20：放到第 ${log1.offset} 个行指针`, hot: { [log1.leaf]: 'amber' }, hotKey: { [log1.leaf]: 0 }, footer: FOOTER });
const inOrderWire = btreePageLayers(tree, log2.leaf);
const t2 = treeBoard(tree, { title: TITLE, sub: `插入 80：放到第 ${log2.offset} 个行指针`, hot: { [log2.leaf]: 'amber' }, footer: FOOTER });
const log3 = ins(35);
const fullFree = tree.pages[log3.leaf].free;
const t3 = treeBoard(tree, { title: TITLE, sub: `插入 35：后面的行指针后移`, hot: { [log3.leaf]: 'amber' }, hotKey: { [log3.leaf]: log3.offset - tree.firstData(log3.leaf) }, footer: FOOTER });

// 第 3 步：第 5 个键放不下，叶子分裂。
const splitLog = ins(65);
const split = splitLog.splits[0];
const t4 = treeBoard(tree, { title: TITLE, sub: `插入 65：块 ${split.block} 满，分裂出块 ${split.rightBlock}`, hot: { [split.block]: 'amber', [split.rightBlock]: 'amber' }, footer: FOOTER });
const leftWire = btreePageLayers(tree, split.block);
const rightWire = btreePageLayers(tree, split.rightBlock);
const rootAfter = splitLog.newRoot!;
const rootWire = btreePageLayers(tree, rootAfter);
const t5 = treeBoard(tree, { title: TITLE, sub: `新根 = 块 ${rootAfter}`, hot: { [rootAfter]: 'green' }, footer: FOOTER });
const metaAfter = btMeta(tree);

// 第 4 步：继续插入，分隔键进入父页。
const seq = [10, 90, 72, 95, 5];
const logs = seq.map(ins);
const parentLog = logs.find((log) => log.splits.length)!;
const midSplit = parentLog.splits[0];
const t6 = treeBoard(tree, { title: TITLE, sub: `再插入 ${seq.join(' ')}`, hot: { [tree.root]: 'green' }, footer: FOOTER });
const rootNow = btreePageLayers(tree, tree.root);
const level1Blocks = tree.level;

// 第 5 步：根也满了，树长高。
const more = [15];
let grow: InsertLog | null = null;
const moreDone: number[] = [];
for (const key of more) {
  moreDone.push(key);
  const log = ins(key);
  if (log.newRoot && log.splits.length > 1) {
    grow = log;
    break;
  }
}
const growLog = grow!;
const internalSplit = growLog.splits.find((s) => s.level === 1)!;
const t7 = treeBoard(tree, { title: TITLE, sub: `插入 ${growLog.key}：叶裂 → 内部页裂 → 新根`, hot: { [growLog.newRoot!]: 'green', [internalSplit.block]: 'amber', [internalSplit.rightBlock]: 'amber', [growLog.splits[0].block]: 'violet', [growLog.splits[0].rightBlock]: 'violet' }, footer: FOOTER });
const finalRoot = btreePageLayers(tree, tree.root);

export const btreeinsert: Lesson = {
  id: 'btreeinsert',
  name: 'B+TREE',
  title: '插入与分裂',
  group: 'storage',
  layer: [4, 4],
  timeUnit: 'µs',
  nodes: ['backend', 'btree', 'wal'],
  place: { backend: [150, 70], btree: [470, 70], wal: [790, 70] },
  labels: {
    backend: ['后端进程', '_bt_doinsert'],
    btree: ['B+ 树', 'nbtree'],
    wal: ['WAL', 'XLOG_BTREE_*'],
  },
  start: ['backend', 'btree'],
  boards: {
    tree: { rect: [20, 165, 900, 300], initial: initialTree },
    info: { rect: [20, 473, 900, 145], initial: emptyInfo([{ k: '现在', v: '只有元页，根是 0（无效块号）' }]) },
  },
  legend: [['blue', '插入请求'], ['amber', '修改页面'], ['violet', '分裂'], ['green', '新根'], [null, `页缩小到 ${PAGE} 字节，算法和布局不变`]],
  overview: {
    full: '页满就一分为二，分隔键上提，根满了树才长高',
    description: `PostgreSQL 的 B 树是 B+ 树：数据只在叶子，叶子之间有链。为了能一屏看清，这里把页缩小到 ${PAGE} 字节，每页 4 项；代码和 8 KiB 页完全相同，后者建出的 1200 和 1500 键索引已和 PostgreSQL 17 逐字节比对。`,
    facts: [
      ['每页项数', '本课 4；真实 8 KiB 页约 407 个 int4'],
      ['叶子填充率', 'BTREE_DEFAULT_FILLFACTOR = 90'],
      ['内部页填充率', 'BTREE_NONLEAF_FILLFACTOR = 70'],
      ['分裂点', '_bt_findsplitloc'],
      ['B-link', 'Lehman & Yao：high key + 右链'],
      ['元页', 'BTREE_MAGIC 0x053162'],
    ],
  },
  steps: [
    {
      title: '第一次插入',
      desc: '建根：根同时也是叶子',
      detail: '建索引时只有第 0 页元页。第一次插入时 _bt_getroot 分配块 1，打上 BTP_LEAF 和 BTP_ROOT，再更新元页里的 btm_root。这棵树只有一层，所以根也是叶子。最右边的页没有 high key，第一个数据项就在行指针 1。',
      facts: [['新页', `块 ${log0.leaf}`], ['btpo_flags', 'BTP_LEAF | BTP_ROOT'], ['btpo_level', '0'], ['函数', '_bt_getroot']],
      events: [
        pk('backend', 'btree', 'blue', '_bt_doinsert', ['键 50'], [0, 'PAGE', 'INSERT 后为索引插入一项', 16],
          wire('索引的第 0 页。真实布局，页缩小', 'mem', 'scaled', metaWire)),
        board('tree', t0),
        board('info', emptyInfo([{ k: 'btm_root', v: String(log0.leaf), hot: 'amber' }, { k: 'btm_level', v: '0' }, { k: 'btpo_flags', v: 'BTP_LEAF | BTP_ROOT' }])),
        pk('btree', 'backend', 'amber', '根/叶', ['50'], [us(40), 'PAGE', `键 50 放进块 ${log0.leaf}`, 16],
          wire(`块 ${log0.leaf}：完整的页面字节`, 'mem', 'scaled', ...rootLeafWire)),
      ],
    },
    {
      title: '保持有序',
      desc: '行指针按键排序，元组不移动',
      detail: `插入位置由 _bt_binsrch_insert 二分找到。键序靠的是行指针的顺序：插入 35 时，后面的行指针整体后移一格，元组本身按到达顺序从页尾往前放。所以页内的物理顺序和键序不同，移动 4 字节的行指针比移动整个元组便宜。`,
      facts: [['插入 20', `行指针 ${log1.offset}`], ['插入 80', `行指针 ${log2.offset}`], ['插入 35', `行指针 ${log3.offset}`], ['函数', 'PageAddItem + _bt_binsrch_insert']],
      events: [
        board('tree', t1),
        board('tree', t2),
        board('tree', t3),
        pk('backend', 'btree', 'amber', '三次插入', ['20 80 35'], [us(90), 'PAGE', '在页内二分，后移行指针', 48],
          wire(`块 ${log2.leaf}，插入 20 和 80 之后。元组的物理顺序是到达顺序`, 'mem', 'scaled', ...inOrderWire)),
        board('info', emptyInfo([{ k: '键序', v: '20 35 50 80（行指针的顺序）' }, { k: '物理顺序', v: '50 20 80 35（到达顺序）', hot: 'amber' }, { k: '页内空闲', v: `${fullFree} 字节，放不下下一项了` }], '行指针和元组是两个东西')),
      ],
    },
    {
      title: '叶子分裂',
      desc: '放不下了，一半搬到新页',
      detail: `插入 65 时页满。_bt_findsplitloc 把新项也算进去，挑一个分裂点。这是最右叶子，按 90% 填充率把左边填满，因为持续递增的键以后都落在右边。结果左边留 ${split.leftKeys.join(' ')}，右边是 ${split.rightKeys.join(' ')}。左页的 high key ${split.highKey} 来自右页第一个键，表示左页的上界。`,
      facts: [['左页', split.leftKeys.join(' ')], ['右页', split.rightKeys.join(' ')], ['high key', String(split.highKey)], ['填充率', split.fillFactor ? `${split.fillFactor * 100}%（最右叶子）` : '50:50']],
      events: [
        pk('backend', 'btree', 'blue', '_bt_doinsert', ['键 65', '页已满'], [us(150), 'PAGE', 'PageGetFreeSpace 不够，进入 _bt_split', 16],
          wire('拆分前已满的叶子', 'vals', '示意', concept('分裂前', [['全部键（含新键）', split.before.join(' '), ''], ['左边剩余空间', `${split.leftFree} 字节`, '_bt_recsplitloc 算出的 leftfree。'], ['右边剩余空间', `${split.rightFree} 字节`, 'rightfree。']], 'violet'))),
        board('tree', t4),
        pk('btree', 'backend', 'violet', '_bt_split', ['左 ' + split.leftKeys.join(' '), '右 ' + split.rightKeys.join(' ')], [us(210), 'PAGE', `块 ${split.block} 分裂出块 ${split.rightBlock}，btpo_next 连上`, PAGE],
          wire('左页（第一项是 high key）和右页，都是完整字节', 'mem', 'scaled', ...leftWire, ...rightWire)),
        board('info', emptyInfo([{ k: '左页 high key', v: `${split.highKey}（从右页第一个键复制，去掉了堆 TID）`, hot: 'violet' }, { k: 'btpo_next', v: `块 ${split.block} → 块 ${split.rightBlock}`, hot: 'violet' }, { k: '分裂点', v: `leftfree ${split.leftFree}，rightfree ${split.rightFree}` }], 'Lehman–Yao')),
      ],
    },
    {
      title: '分隔键上提',
      desc: '原来的根裂了，新建一层',
      detail: `分裂后要在父页加一个下行链接。这棵树没有父页，所以 _bt_newlevel 新建块 ${rootAfter} 作根：第一项是不存键的负无穷，指向左页；第二项是键 ${split.highKey}，指向右页。元页的 btm_root 改成 ${rootAfter}。树长高总是发生在根，所以所有叶子总在同一层。`,
      facts: [['新根', `块 ${rootAfter}`], ['第一项', '负无穷，8 字节'], ['第二项', `键 ${split.highKey}，16 字节`], ['WAL', 'XLOG_BTREE_NEWROOT']],
      events: [
        board('tree', t5),
        pk('btree', 'backend', 'green', '_bt_newlevel', [`根 = 块 ${rootAfter}`], [us(260), 'PAGE', '新根和元页同时更新', PAGE],
          wire('新根的完整字节，和更新后的元页', 'mem', 'scaled', ...rootWire, metaAfter)),
        show('wal'),
        pk('btree', 'wal', 'slate', 'XLOG_BTREE_*', ['SPLIT_R', 'NEWROOT'], [us(300), 'WAL', '分裂和新根各写一条 WAL 记录', null],
          wire('记录类型定义在 nbtxlog.h。分裂后 btpo_flags 带 BTP_INCOMPLETE_SPLIT，直到父页更新完', 'vals', '示意', concept('两条 WAL 记录', [['XLOG_BTREE_SPLIT_R', '分裂', '新项在右页。'], ['XLOG_BTREE_NEWROOT', '新根', '崩溃恢复时都能重放。'], ['BTP_INCOMPLETE_SPLIT', '中间状态', '如果在两条记录之间崩溃，下次插入会补上父页的链接。']], 'slate'))),
        note('wal', '分裂分成两步写 WAL', 'amber'),
      ],
    },
    {
      title: '普通的分裂',
      desc: '有父页时，只加一个下行链接',
      detail: `再插入 ${seq.join(' ')}。不在最右边的页按 50:50 分裂，分隔键进入根。例如插入 ${parentLog.key} 时块 ${midSplit.block} 裂成块 ${midSplit.block} 和块 ${midSplit.rightBlock}，根里多了键 ${midSplit.highKey}。树高不变，这是最常见的情况，代价只是多写一页。`,
      facts: [['这次分裂', `块 ${midSplit.block} → 块 ${midSplit.rightBlock}`], ['上提的键', String(midSplit.highKey)], ['树高', String(level1Blocks)], ['函数', '_bt_insert_parent']],
      events: [
        pk('backend', 'btree', 'blue', '继续插入', [seq.join(' ')], [us(500), 'PAGE', `${seq.length} 个键，${logs.filter((log) => log.splits.length).length} 次分裂`, 16 * seq.length],
          wire('插入后的根页', 'mem', 'scaled', ...rootNow)),
        board('tree', t6),
        board('info', emptyInfo(logs.filter((log) => log.splits.length).slice(0, 5).map((log) => ({ k: `插入 ${log.key}`, v: `块 ${log.splits[0].block} 裂出块 ${log.splits[0].rightBlock}，上提 ${log.splits[0].highKey}` })), '每次分裂都由真实算法算出')),
      ],
    },
    {
      title: '树长高',
      desc: '根也满了，再加一层',
      detail: `继续插入到 ${growLog.key} 时，分裂一路向上传递：叶子裂开后要往父页加链接，父页也满了，再裂；最后根裂开，新根让树变成 ${tree.level + 1} 层。内部页的右页第一项会被截断成负无穷。真实索引每页几百项，几千万行的表通常也只有 3 到 4 层。`,
      facts: [['树高', String(tree.level + 1)], ['连续分裂', `${growLog.splits.length} 次`], ['新根', `块 ${growLog.newRoot}`], ['真实扇出', '约 407（int4 叶子）']],
      events: [
        pk('backend', 'btree', 'blue', '继续插入', [moreDone.join(' ')], [us(900), 'PAGE', `插入 ${growLog.key} 触发连续分裂`, 16],
          wire('内部页的分裂也走同一个 _bt_split，分隔键上提', 'vals', '示意', concept('这次的分裂', growLog.splits.map((s): [string, string, string] => [`第 ${s.level} 层`, `块 ${s.block} → 块 ${s.rightBlock}`, `上提 ${s.highKey}`]), 'violet'))),
        board('tree', t7),
        pk('btree', 'backend', 'green', '新根', [`块 ${growLog.newRoot}`, `${tree.level + 1} 层`], [us(1000), 'PAGE', '树高加 1，所有叶子仍在同一层', PAGE],
          wire('新根的字节。第一项负无穷，第二项指向右边的内部页', 'mem', 'scaled', ...finalRoot)),
        board('info', emptyInfo(growLog.splits.map((s) => ({ k: `第 ${s.level} 层分裂`, v: `块 ${s.block} → 块 ${s.rightBlock}，上提 ${s.highKey}`, hot: s.level === 1 ? ('green' as const) : undefined })), '一次插入，多次分裂')),
      ],
    },
  ],
  outro: {
    title: '矮、宽、永远平衡',
    desc: '分裂从叶子往上，所以叶子都在同一层',
    text: 'B+ 树的结构和分裂是通用原理。PostgreSQL 的细节：元页、high key、右链、后缀截断（分隔键只留必要的列）、去重，以及最右叶子 90% 的分裂策略。键的分裂点在两边都有空间时才合法。',
    facts: [['通用', '分裂、上提、根长高'], ['PG 细节', 'high key、右链、元页'], ['下一课', 'VACUUM']],
  },
};
