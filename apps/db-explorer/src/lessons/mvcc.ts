import { clogBytes, concept, heapTuple, snapshotValues, wire } from '../decode/structures';
import { parseLsn } from '../engine/bytes';
import { applyHints, Clog, getSnapshot, satisfiesMVCC, type Snapshot } from '../engine/mvcc';
import { HeapPage } from '../engine/page';
import type { LanesBoard } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { ACCOUNTS, pageBoard, snapshotBoard, us } from './shared';
import type { Lesson } from './types';

/** 初始状态：bob 的余额 200，由已提交的事务 745 写入。 */
const BASE = 745;
const WRITER = 746;
/** 一个更晚开始、已经结束的事务：它让快照的 xmax 超过 WRITER，WRITER 才会出现在 xip 里。 */
const OTHER = 747;
const heap = new HeapPage(ACCOUNTS);
const clog = new Clog();
clog.set(743, 1);
clog.set(744, 1);
clog.set(BASE, 1);
const clogBase = clog.clone();
clog.set(OTHER, 1);
const LP = 1;
heap.insert([2, 'bob', 200], BASE, parseLsn('0/19E0298'));
const v0 = heap.clone();

const TITLE = '堆页 accounts/0';
const R_FROM = 743;
const R_TO = 750;

const clogLanes = (hotXid: number | null, sub: string, c: Clog): LanesBoard => ({
  kind: 'lanes',
  title: 'CLOG（pg_xact）：每个事务 2 位',
  sub,
  cell: 92,
  labelWidth: 42,
  rows: [{ label: '状态', cells: [744, 745, 746, 747].map((xid) => ({ text: String(xid), sub: ['00 进行中', '01 已提交', '10 已回滚', '11 子提交'][c.get(xid)], hot: xid === hotXid ? ('amber' as const) : undefined })) }],
});

// 写者：UPDATE 还没提交。
heap.hotUpdate(LP, [2, 'bob', 150], WRITER, parseLsn('0/19E0458'));
const LPNEW = 2;
const v1 = heap.clone();

// 读者：写者还在运行时拍快照。
const snapA: Snapshot = getSnapshot([WRITER], OTHER);
const clogBefore = clog.clone();
const oldVerdictA = satisfiesMVCC(v1.tuple(LP), snapA, clog);
const newVerdictA = satisfiesMVCC(v1.tuple(LPNEW), snapA, clog);

const verdictCell = (verdicts: Record<number, boolean>) => (lp: number) => (verdicts[lp] === undefined ? '' : verdicts[lp] ? '可见' : '不可见');
const statusBoard = (running: number[], started: number, snap: Snapshot | undefined, sub: string, c: Clog, probe?: number, probeText?: string) =>
  snapshotBoard(c, { title: '事务号与快照', sub, from: R_FROM, to: R_TO, running, started, snapshot: snap, probe, probeText });

// 写者提交：CLOG 置位。
clog.set(WRITER, 1);
// 读者的旧快照再看一次：依然看到旧版本。
const again = satisfiesMVCC(heap.tuple(LP), snapA, clog);
const againNew = satisfiesMVCC(heap.tuple(LPNEW), snapA, clog);
// 新的查询拍新快照：写者已提交，没有人在运行。
const snapC: Snapshot = getSnapshot([], OTHER);
const v2 = heap.clone();
const oldC = satisfiesMVCC(v2.tuple(LP), snapC, clog);
const newC = satisfiesMVCC(v2.tuple(LPNEW), snapC, clog);
applyHints(v2.tuple(LP), oldC.hints);
applyHints(v2.tuple(LPNEW), newC.hints);

export const mvcc: Lesson = {
  id: 'mvcc',
  name: 'MVCC',
  title: '快照可见性',
  group: 'txn',
  layer: [5, 5],
  timeUnit: 'µs',
  nodes: ['backend', 'backend2', 'heap', 'clog'],
  place: { backend: [120, 70], heap: [360, 165], backend2: [600, 70], clog: [840, 165] },
  labels: {
    backend: ['读者', '只读，没有事务号'],
    heap: ['堆页', '一行多个版本'],
    backend2: ['事务 746', '写者'],
    clog: ['CLOG', 'pg_xact'],
  },
  start: ['backend', 'heap'],
  boards: {
    snap: { rect: [20, 250, 900, 160], initial: statusBoard([], WRITER, undefined, '还没有快照', clogBase) },
    page: { rect: [20, 418, 900, 200], initial: pageBoard(v0, { title: TITLE, sub: '只有一个版本', extra: { name: '对读者', cell: () => '' } }) },
    clog: { rect: [20, 626, 900, 84], initial: clogLanes(null, '事务提交时才写', clogBase) },
  },
  legend: [['amber', '写新版本'], ['violet', '拍快照'], ['blue', '判断可见性'], ['green', '提交'], [null, '判断逻辑来自 heapam_visibility.c']],
  overview: {
    full: '读不阻塞写：每个事务看到自己快照里的版本',
    description: 'UPDATE 不改原来的行，而是写一个新版本。读者靠快照判断该看哪个版本，所以读写互不阻塞。PostgreSQL 没有 undo 日志，旧版本就留在堆页上，每个元组头都记着 xmin 和 xmax。这一课的判断结果由 HeapTupleSatisfiesMVCC 的直译代码算出。',
    facts: [
      ['xmin', '创建这个版本的事务'],
      ['xmax', '删除这个版本的事务，0 表示没有'],
      ['快照', 'xmin : xmax : xip'],
      ['判断函数', 'HeapTupleSatisfiesMVCC'],
      ['事务状态', 'pg_xact，每事务 2 位'],
      ['旧版本在哪', '堆页上，没有 undo 日志'],
    ],
  },
  steps: [
    {
      title: '一行的版本信息',
      desc: 'xmin = 745 表示谁创建了它',
      detail: `bob 这一行由事务 ${BASE} 写入，t_xmin 是 ${BASE}，t_xmax 是 0。这两个字段就在元组头里，每一行都占 8 字节。一行有多个版本时，就是堆页上有多个元组，靠 t_ctid 串起来。`,
      facts: [['t_xmin', String(BASE)], ['t_xmax', '0'], ['t_ctid', '(0,1)，指向自己']],
      events: [
        pk('backend', 'heap', 'blue', '看这一行', ['id = 2'], [0, 'PAGE', '读堆页上的第 1 个行指针', 36],
          wire('元组头里的事务字段', 'mem', 'disk', heapTuple(v0.page, LP, ACCOUNTS, 'amber', { xmin: '事务 745 创建了这个版本。' }))),
      ],
    },
    {
      title: '写者写新版本',
      desc: '旧版本不动内容，只写 xmax',
      detail: `事务 ${WRITER} 执行 UPDATE：在同一页放一个新元组（xmin = ${WRITER}），再把旧元组的 t_xmax 改成 ${WRITER}、t_ctid 指向新元组。旧的值 200 原封不动留在页上，没有被复制到任何 undo 区域。回滚时什么都不用恢复，CLOG 记成已回滚就行。`,
      facts: [['旧版本', `xmax = ${WRITER}，ctid = (0,${LPNEW})`], ['新版本', `xmin = ${WRITER}`], ['undo 日志', '没有'], ['状态', `${WRITER} 进行中`]],
      events: [
        show('backend2'),
        pk('backend2', 'heap', 'amber', 'heap_update', ['balance = 150'], [us(40), 'PAGE', `HOT 更新：新版本放到行指针 ${LPNEW}，还没提交`, 36],
          wire('两个版本都在页上', 'mem', 'disk', heapTuple(v1.page, LP, ACCOUNTS, 'slate', { xmax: `事务 ${WRITER} 想删除这个版本，但它还没提交。`, ctid: '指向新版本。' }), heapTuple(v1.page, LPNEW, ACCOUNTS, 'amber', { xmin: `事务 ${WRITER} 创建了这个版本。` }))),
        board('page', pageBoard(v1, { title: TITLE, sub: `两个版本。事务 ${WRITER} 未提交`, hot: { [LP]: 'slate', [LPNEW]: 'amber' }, extra: { name: '对读者', cell: () => '' } })),
        board('snap', statusBoard([WRITER], 748, undefined, `${WRITER} 正在运行，${OTHER} 已结束`, clogBefore)),
        board('clog', clogLanes(OTHER, `${OTHER} 已提交，${WRITER} 还在运行`, clogBefore)),
      ],
    },
    {
      title: '读者拍快照',
      desc: '记下哪些事务还没结束',
      detail: `读者执行查询时调用 GetSnapshotData：xmax 是最新完成的事务号加 1，xmin 是还在运行的最小事务号，xip 是两者之间正在运行的事务。${OTHER} 已结束，所以 xmax 是 ${snapA.xmax}；这里快照是 ${snapA.xmin}:${snapA.xmax}:${snapA.xip.join(',')}。只读事务不分配事务号。快照只是这几个数字，所以很便宜，pg_current_snapshot() 也是这个格式。`,
      facts: [['xmin', String(snapA.xmin)], ['xmax', String(snapA.xmax)], ['xip', snapA.xip.join(', ') || '空'], ['读者自己', '只读，没有事务号']],
      events: [
        pk('backend', 'heap', 'violet', 'GetSnapshotData', [`${snapA.xmin}:${snapA.xmax}:${snapA.xip.join(',')}`], [us(80), 'XACT', '从 ProcArray 取运行中的事务，拍快照', null],
          wire('快照存在后端内存里，这几个值互不相邻', 'vals', 'internal', snapshotValues(snapA))),
        board('snap', statusBoard([WRITER], 748, snapA, '读者的快照', clogBefore)),
      ],
    },
    {
      title: '判断可见性',
      desc: `旧版本可见，新版本不可见`,
      detail: `新版本 xmin = ${WRITER}，在 xip 里，算作还没提交，看不见。旧版本的 xmin = ${BASE} 不在进行中集合，已提交；xmax = ${WRITER} 在 xip 里，删除者还没提交，所以这个版本依然有效。于是读者读到 200，也完全不用等写者。这就是读写不互相阻塞。`,
      facts: [['旧版本', oldVerdictA.visible ? '可见' : '不可见'], ['新版本', newVerdictA.visible ? '可见' : '不可见'], ['函数', 'HeapTupleSatisfiesMVCC → XidInMVCCSnapshot']],
      events: [
        board('snap', statusBoard([WRITER], 748, snapA, '读者的快照', clogBefore, WRITER, `${WRITER} 在 xip 里：对这个快照来说它还没提交`)),
        board('page', pageBoard(v1, { title: TITLE, sub: '读者逐个版本判断', hot: { [LP]: 'green', [LPNEW]: 'red' }, extra: { name: '对读者', cell: verdictCell({ [LP]: oldVerdictA.visible, [LPNEW]: newVerdictA.visible }) } })),
        pk('heap', 'backend', 'blue', '判断结果', ['200 可见', '150 不可见'], [us(120), 'SCAN', '读到旧版本，balance = 200', 36],
          wire('HeapTupleSatisfiesMVCC 的判断路径', 'vals', '示意', concept('旧版本', oldVerdictA.path.map((text, i): [string, string] => [`第 ${i + 1} 步`, text]), 'green'), concept('新版本', newVerdictA.path.map((text, i): [string, string] => [`第 ${i + 1} 步`, text]), 'amber'))),
      ],
    },
    {
      title: '写者提交',
      desc: '只改 CLOG，元组一个字节都不动',
      detail: `事务 ${WRITER} 提交时把 pg_xact 里自己的 2 位改成 01，然后从 ProcArray 退出。没有去改新旧元组。提交这个动作只需要改一处，这是回滚和提交都很快的原因。已拍好的快照不会变，所以用它再读还是 200（REPEATABLE READ 就是这样）。`,
      facts: [['CLOG 字节', `第 ${clog.byteOf(WRITER)} 字节`], ['状态位', '01 = COMMITTED'], ['旧快照再看', again.visible && !againNew.visible ? '还是旧版本' : '变了']],
      events: [
        show('clog'),
        board('clog', clogLanes(WRITER, `${WRITER} 已提交`, clog)),
        pk('backend2', 'clog', 'green', 'CLOG 置位', ['01 COMMITTED'], [us(200), 'XACT', 'TransactionIdCommitTree：写 pg_xact', 1],
          wire(`xid ÷ 4 = 字节位置。这里是第 ${clog.byteOf(WRITER)} 字节`, 'mem', 'disk', clogBytes(clog, [744, WRITER]))),
        board('snap', statusBoard([], 748, snapA, '读者的快照没有变', clog)),
        note('backend', '旧快照依然看到 200', 'green'),
      ],
    },
    {
      title: '新快照和提示位',
      desc: '新事务看到新版本，并顺手写提示位',
      detail: `新查询的快照是 ${snapC.xmin}:${snapC.xmax}:，${WRITER} 不在进行中集合。查 CLOG 确认已提交，所以新版本可见、旧版本不可见。查 CLOG 有成本，于是把结果写进元组的 HEAP_XMIN_COMMITTED 等提示位，下次就不用查了。这一次读操作也弄脏了页面，提示位默认不写 WAL。`,
      facts: [['旧版本', oldC.visible ? '可见' : '不可见'], ['新版本', newC.visible ? '可见' : '不可见'], ['提示位', 'XMIN_COMMITTED、XMAX_COMMITTED'], ['WAL', '提示位默认不写']],
      events: [
        pk('clog', 'heap', 'blue', '查 CLOG', [`${WRITER} 已提交`], [us(300), 'XACT', 'TransactionIdDidCommit，然后 SetHintBits', 1],
          wire('快照和判断路径', 'vals', 'internal', snapshotValues(snapC), concept('新版本', newC.path.map((text, i): [string, string] => [`第 ${i + 1} 步`, text]), 'green'))),
        board('snap', statusBoard([], 748, snapC, '新查询的快照', clog, WRITER, `${WRITER} 已提交：新版本可见，旧版本不可见`)),
        board('page', pageBoard(v2, { title: TITLE, sub: '提示位已写回', hot: { [LP]: 'red', [LPNEW]: 'green' }, extra: { name: '对新事务', cell: verdictCell({ [LP]: oldC.visible, [LPNEW]: newC.visible }) } })),
        pk('heap', 'backend', 'green', '元组字节', ['infomask 变了'], [us(340), 'PAGE', '提示位写回元组头', 36],
          wire('t_infomask 现在带提示位', 'mem', 'disk', heapTuple(v2.page, LP, ACCOUNTS, 'slate'), heapTuple(v2.page, LPNEW, ACCOUNTS, 'green'))),
      ],
    },
  ],
  outro: {
    title: '版本都在堆上',
    desc: '代价是要 VACUUM，好处是回滚不用恢复数据',
    text: '多版本并发控制是通用思想。PostgreSQL 的具体做法：旧版本留在表里，靠快照加 xmin/xmax 判断，靠 CLOG 查提交状态。这里省略了子事务、MultiXact 和冻结。旧版本要等 VACUUM 清理，这是这种设计的主要代价。',
    facts: [['读阻塞写吗', '不阻塞'], ['回滚要做什么', '只写 CLOG'], ['下一课', 'ISOLATION']],
  },
};
