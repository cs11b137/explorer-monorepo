import { concept, heapTuple, protocolMessage, snapshotValues, values, wire } from '../decode/structures';
import { errorResponse } from '../engine/protocol';
import { Clog, getSnapshot, scanPage, type Snapshot } from '../engine/mvcc';
import { HeapPage, type Attr } from '../engine/page';
import { Ssi } from '../engine/ssi';
import type { GraphBoard, TableBoard } from '../scene/board-types';
import { board, note, pk } from './dsl';
import { ms } from './shared';
import type { Lesson } from './types';

const ONCALL: Attr[] = [{ name: 'doctor', type: 'text' }, { name: 'on_call', type: 'int4' }];

interface World { heap: HeapPage; clog: Clog; latest: number; running: number[] }

function freshAccounts(): World {
  const heap = new HeapPage([{ name: 'id', type: 'int4' }, { name: 'balance', type: 'int4' }]);
  const clog = new Clog();
  clog.set(800, 1);
  heap.insert([2, 200], 800);
  return { heap, clog, latest: 800, running: [] };
}

function freshDoctors(): World {
  const heap = new HeapPage(ONCALL);
  const clog = new Clog();
  clog.set(900, 1);
  heap.insert(['ann', 1], 900);
  heap.insert(['bob', 1], 900);
  return { heap, clog, latest: 900, running: [] };
}

const visibleRows = (world: World, snap: Snapshot, me: number) => scanPage(world.heap, snap, world.clog, me).filter((r) => r.verdict.visible).map((r) => world.heap.values(r.off));

// ---------- READ COMMITTED：每条语句一个新快照 ----------
const rc = freshAccounts();
// A 只读，还没有事务号。B 写的时候才分配到 801。
const A_NONE = 0;
const B_RC = 801;
const rc1 = getSnapshot([], 800);
const rcFirst = visibleRows(rc, rc1, A_NONE)[0][1];
const rcOff = 1;
rc.heap.hotUpdate(rcOff, [2, 150], B_RC);
rc.clog.set(B_RC, 1);
const rc2 = getSnapshot([], B_RC);
const rcSecond = visibleRows(rc, rc2, A_NONE)[0][1];

// ---------- REPEATABLE READ：第一条语句拍的快照用到底 ----------
const rr = freshAccounts();
const B_RR = 801;
const rrSnap = getSnapshot([], 800);
const rrFirst = visibleRows(rr, rrSnap, A_NONE)[0][1];
rr.heap.hotUpdate(1, [2, 150], B_RR);
rr.clog.set(B_RR, 1);
const rrSecond = visibleRows(rr, rrSnap, A_NONE)[0][1];

// ---------- 写偏斜：两人都值班，各自查完都下班 ----------
const ws = freshDoctors();
const A_W = 901;
const B_W = 902;
const snapA = getSnapshot([A_W, B_W], 900, A_W);
const snapB = getSnapshot([A_W, B_W], 900, B_W);
const countA = visibleRows(ws, snapA, A_W).filter((v) => v[1] === 1).length;
const countB = visibleRows(ws, snapB, B_W).filter((v) => v[1] === 1).length;
ws.heap.hotUpdate(1, ['ann', 0], A_W);
ws.heap.hotUpdate(2, ['bob', 0], B_W);
ws.clog.set(A_W, 1);
ws.clog.set(B_W, 1);
const end = getSnapshot([], B_W);
const after = visibleRows(ws, end, 0).filter((v) => v[1] === 1).length;

// ---------- SSI ----------
const ssi = new Ssi();
ssi.begin(A_W, 'A');
ssi.begin(B_W, 'B');
ssi.read(A_W, 'oncall');
ssi.read(B_W, 'oncall');
const anyRead = () => true;
const edgeAB = ssi.write(A_W, 'oncall/ann', anyRead);
const edgeBA = ssi.write(B_W, 'oncall/bob', anyRead);
const commitA = ssi.commit(A_W);
const commitB = ssi.commit(B_W);

const SERIAL_MSG = 'could not serialize access due to read/write dependencies among transactions';
const serialError = errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '40001'], ['M', SERIAL_MSG], ['D', 'Reason code: Canceled on identification as a pivot, during commit attempt.'], ['H', 'The transaction might succeed if retried.'], ['F', 'predicate.c'], ['L', '4717'], ['R', 'PreCommit_CheckForSerializationFailure']]);

type Row = TableBoard['rows'][number];
const timeline = (title: string, sub: string, rows: Row[], note?: string): TableBoard => ({ kind: 'table', title, sub, columns: ['步', '会话 A', '会话 B'], widths: [28, 240, 240], rows, note });
const versions = (world: World, sub: string, hot: Record<number, 'amber' | 'green' | 'red'> = {}, title = '堆页上的版本'): TableBoard => ({
  kind: 'table',
  title,
  sub,
  columns: ['lp', 'xmin', 'xmax', '数据'],
  widths: [34, 60, 60, 150],
  rows: Array.from({ length: world.heap.page.maxOffset }, (_, i) => {
    const h = world.heap.header(i + 1);
    return { cells: [String(i + 1), String(h.xmin), String(h.xmax), world.heap.values(i + 1).join(', ')], hot: hot[i + 1] };
  }),
});

const graph = (edges: GraphBoard['edges'], footer: string, tones: Record<string, 'amber' | 'green' | 'red'> = {}): GraphBoard => ({
  kind: 'graph',
  title: 'rw 依赖',
  sub: 'SERIALIZABLE',
  nodes: [{ id: 'A', label: '事务 A', sub: `xid ${A_W}`, tone: tones.A }, { id: 'B', label: '事务 B', sub: `xid ${B_W}`, tone: tones.B }],
  edges,
  footer,
});

export const isolation: Lesson = {
  id: 'isolation',
  name: 'ISOLATION',
  title: '隔离级别',
  group: 'txn',
  layer: [5, 7],
  timeUnit: 'ms',
  nodes: ['backend', 'heap', 'backend2'],
  place: { backend: [150, 70], heap: [470, 70], backend2: [790, 70] },
  labels: {
    backend: ['会话 A', '后端进程'],
    heap: ['堆页', '共享的数据'],
    backend2: ['会话 B', '后端进程'],
  },
  start: ['backend', 'heap', 'backend2'],
  boards: {
    time: { rect: [20, 165, 540, 230], initial: timeline('时间线', '还没开始', []) },
    data: { rect: [570, 165, 350, 230], initial: versions(freshAccounts(), '初始') },
    fact: { rect: [20, 403, 900, 140], initial: { kind: 'kv', title: 'PostgreSQL 的隔离级别', keyWidth: 170, rows: [{ k: 'READ COMMITTED', v: '默认。每条语句一个新快照' }, { k: 'REPEATABLE READ', v: '第一条语句的快照用到事务结束，也就是快照隔离' }, { k: 'SERIALIZABLE', v: '快照隔离 + SSI 依赖检查' }, { k: 'READ UNCOMMITTED', v: '接受这个写法，行为等同 READ COMMITTED' }] } },
  },
  legend: [['blue', '读'], ['amber', '写'], ['green', '提交'], ['violet', '依赖检查'], [null, '场景都在真实 PostgreSQL 17 上跑过']],
  overview: {
    full: '同一组操作，换个隔离级别结果就不同',
    description: '隔离级别决定事务能看到别人多少改动。PostgreSQL 的实现都基于快照：区别在于什么时候拍快照，以及要不要额外检查依赖。写偏斜是快照隔离防不住的异常，SERIALIZABLE 用 SSI 把它检测出来。下面的结果都在真实数据库上验证过。',
    facts: [
      ['默认级别', 'READ COMMITTED'],
      ['RC 快照', '每条语句一个'],
      ['RR 快照', '第一条语句拍，BEGIN 时还没拍'],
      ['SSI', 'Serializable Snapshot Isolation，PG 9.1 起'],
      ['SIREAD 锁', '只做记录，不阻塞任何人'],
      ['失败错误码', '40001，应用要重试'],
    ],
  },
  steps: [
    {
      title: 'READ COMMITTED',
      desc: '每条语句看到最新已提交的数据',
      detail: `A 第一次读到 ${rcFirst}。B 把余额改成 150 并提交。A 再读，这条新语句拍新快照，于是读到 ${rcSecond}。一个事务里两次读到不同的值，这叫不可重复读，在这个级别是允许的。注意快照是每条语句一个，不是每个事务一个。`,
      facts: [['A 第一次', String(rcFirst)], ['A 第二次', String(rcSecond)], ['第二次快照', `${rc2.xmin}:${rc2.xmax}:${rc2.xip.join(',')}`]],
      events: [
        board('time', timeline('READ COMMITTED', '每条语句一个快照', [{ cells: ['1', `SELECT → ${rcFirst}`, ''], hot: 'amber' }])),
        pk('backend', 'heap', 'blue', 'SELECT', [`${rc1.xmin}:${rc1.xmax}:${rc1.xip.join(',')}`], [0, 'SCAN', `语句开始时拍快照，读到 ${rcFirst}`, null],
          wire('第一条语句的快照', 'vals', 'internal', snapshotValues(rc1))),
        pk('backend2', 'heap', 'amber', 'UPDATE', ['150', '提交'], [ms(1), 'XACT', 'B 更新并提交', 32],
          wire('B 提交后页面上的旧版本', 'mem', 'disk', heapTuple(rc.heap.page, 1, rc.heap.schema, 'slate'))),
        board('time', timeline('READ COMMITTED', '每条语句一个快照', [{ cells: ['1', `SELECT → ${rcFirst}`, ''] }, { cells: ['2', '', 'UPDATE 150; COMMIT'], hot: 'amber' }, { cells: ['3', `SELECT → ${rcSecond}（新快照）`, ''], hot: 'green' }], '不可重复读在这个级别是允许的')),
        board('data', versions(rc, '两个版本都在页上', { 1: 'red', 2: 'green' })),
        pk('backend', 'heap', 'blue', 'SELECT', [`${rc2.xmin}:${rc2.xmax}:${rc2.xip.join(',')}`], [ms(2), 'SCAN', `新语句拍新快照，读到 ${rcSecond}`, null],
          wire('第二条语句的快照', 'vals', 'internal', snapshotValues(rc2))),
      ],
    },
    {
      title: 'REPEATABLE READ',
      desc: '快照固定，事务内看到的不变',
      detail: `换成 REPEATABLE READ。A 的第一条语句拍快照后就不再更新，所以 B 提交之后，A 读到的还是 ${rrSecond}。这就是快照隔离：事务像是在开始那一刻的数据库副本上运行。标准只要求防止不可重复读，PostgreSQL 的实现顺带防止了幻读。`,
      facts: [['A 第一次', String(rrFirst)], ['A 第二次', String(rrSecond)], ['快照', `${rrSnap.xmin}:${rrSnap.xmax}:${rrSnap.xip.join(',')}（不变）`], ['拍快照时机', '第一条语句，不是 BEGIN']],
      events: [
        board('data', versions(rr, 'B 已提交', { 1: 'green', 2: 'red' })),
        board('time', timeline('REPEATABLE READ', '快照用到事务结束', [{ cells: ['1', `SELECT → ${rrFirst}`, ''] }, { cells: ['2', '', 'UPDATE 150; COMMIT'], hot: 'amber' }, { cells: ['3', `SELECT → ${rrSecond}（同一个快照）`, ''], hot: 'green' }], '同一个事务里读到的永远一致')),
        pk('backend', 'heap', 'blue', 'SELECT', [`还是 ${rrSnap.xmin}:${rrSnap.xmax}:`], [ms(4), 'SCAN', `沿用第一条语句的快照，读到 ${rrSecond}`, null],
          wire(`快照不变，新版本的 xmin ${B_RR} 大于等于快照的 xmax，所以看不到`, 'vals', 'internal', snapshotValues(rrSnap))),
      ],
    },
    {
      title: '写写冲突',
      desc: '更新已被别人改过的行，就报错',
      detail: `在 REPEATABLE READ 下，如果 A 也想更新这一行，它发现最新版本不在自己的快照里，不能覆盖一个没看到的修改。于是报 40001：could not serialize access due to concurrent update，应用要重试整个事务。READ COMMITTED 则不同：它等 B 提交后，重新读取最新版本再更新（EvalPlanQual）。`,
      facts: [['RR', '报 40001'], ['RC', '等待后用最新版本继续'], ['报错位置', 'ExecUpdate（真实运行）'], ['RC 的重读', 'EvalPlanQual']],
      events: [
        board('time', timeline('REPEATABLE READ', '写同一行', [{ cells: ['1', `SELECT → ${rrFirst}`, ''] }, { cells: ['2', '', 'UPDATE 150; COMMIT'] }, { cells: ['3', 'UPDATE → 40001', ''], hot: 'red' }], '先提交者胜出，后者重试')),
        pk('backend', 'heap', 'amber', 'UPDATE', ['id = 2'], [ms(5), 'LOCK', '目标元组已被已提交的事务更新', null],
          wire('A 看到的元组：t_xmax 已提交，且不在快照之内', 'mem', 'disk', heapTuple(rr.heap.page, 1, rr.heap.schema, 'slate', { xmax: `事务 ${B_RR} 已提交更新这一行，但它在 A 的快照之后。` }))),
        note('backend', '40001 concurrent update', 'amber'),
      ],
    },
    {
      title: '写偏斜',
      desc: '两人各写各的行，约束还是破了',
      detail: `规则：至少一名医生值班。A 和 B 都查到值班人数是 ${countA}，于是各自把自己改成下班。它们改的是不同的行，没有写写冲突，快照隔离下都能提交。结果值班人数变成 ${after}，规则被破坏。任何串行顺序都不会出现这个结果。这个异常就是写偏斜（write skew）。`,
      facts: [['A 读到', String(countA)], ['B 读到', String(countB)], ['提交后', `${after} 人值班`], ['实测', 'REPEATABLE READ 下两个都 COMMIT']],
      events: [
        board('time', timeline('REPEATABLE READ', '写偏斜', [{ cells: ['1', `count → ${countA}`, `count → ${countB}`] }, { cells: ['2', "UPDATE 'ann' 下班", "UPDATE 'bob' 下班"], hot: 'amber' }, { cells: ['3', 'COMMIT', 'COMMIT'], hot: 'red' }], `结果：${after} 人值班`)),
        board('data', versions(ws, 'on_call', { 3: 'red', 4: 'red' })),
        pk('backend', 'heap', 'amber', 'ann 下班', ["UPDATE ... 'ann'"], [ms(7), 'XACT', `A 写自己那一行`, 40],
          wire('A 写的新版本', 'mem', 'disk', heapTuple(ws.heap.page, 3, ONCALL))),
        pk('backend2', 'heap', 'amber', 'bob 下班', ["UPDATE ... 'bob'"], [ms(7.2), 'XACT', `B 写自己那一行，没有冲突`, 40],
          wire('B 写的新版本', 'mem', 'disk', heapTuple(ws.heap.page, 4, ONCALL))),
        note('heap', `值班人数 = ${after}`, 'amber'),
      ],
    },
    {
      title: 'SSI 记录依赖',
      desc: '读留下 SIREAD，写时建立 rw 边',
      detail: `换成 SERIALIZABLE。读的时候留下 SIREAD 锁，它不阻塞任何人，只是记一笔。这里是全表扫描，所以锁在整张表上。A 写的时候发现 B 读过这个范围，建立 B -rw-> A；B 写的时候同理建立 A -rw-> B。一个事务既有入边又有出边，就是危险结构的中枢（pivot）。`,
      facts: [['B → A', edgeAB.length ? '建立' : '无'], ['A → B', edgeBA.length ? '建立' : '无'], ['函数', 'CheckForSerializableConflictIn、FlagRWConflict'], ['SIREAD', '全表扫描时是关系级']],
      events: [
        board('time', timeline('SERIALIZABLE', 'SSI', [{ cells: ['1', 'count，留 SIREAD', 'count，留 SIREAD'] }, { cells: ['2', "UPDATE 'ann'", "UPDATE 'bob'"], hot: 'violet' }])),
        pk('backend', 'heap', 'violet', 'FlagRWConflict', ['B -rw-> A'], [ms(9), 'LOCK', 'A 写的时候，发现 B 读过这张表', null],
          wire('SERIALIZABLEXACT 上的依赖列表', 'vals', '示意', concept('A', [['inConflicts', 'B', 'B 读了 A 要写的数据。'], ['outConflicts', '（还没有）', '']], 'violet'))),
        board('data', graph([{ from: 'B', to: 'A', label: 'rw', tone: 'amber' }], 'B 读了 A 要写的数据')),
        pk('backend2', 'heap', 'violet', 'FlagRWConflict', ['A -rw-> B'], [ms(9.2), 'LOCK', 'B 写的时候，发现 A 读过这张表', null],
          wire('现在两个事务都有入边和出边', 'vals', '示意', concept('危险结构', [['A', 'in: B，out: B', '中枢。'], ['B', 'in: A，out: A', '中枢。'], ['判定', 'T1 -rw-> T2 -rw-> T3', '这里 T1 和 T3 是同一个事务。']], 'violet'))),
        board('data', graph([{ from: 'B', to: 'A', label: 'rw', tone: 'amber' }, { from: 'A', to: 'B', label: 'rw', tone: 'amber' }], '两边都是中枢：危险结构', { A: 'amber', B: 'amber' })),
      ],
    },
    {
      title: '先提交者胜出',
      desc: 'A 提交成功，B 收到 40001',
      detail: `A 先提交，这时危险结构已成立。PreCommit_CheckForSerializationFailure 把另一个中枢 B 判死。B 提交时报 40001，整个事务回滚。真实运行的结果也是这样：A COMMIT，B 报 ${SERIAL_MSG.slice(0, 26)}…，最后 ann 下班、bob 还在值班。SSI 可能误杀，但不会放过真正的异常，所以应用要准备重试。`,
      facts: [['A', commitA.ok ? 'COMMIT' : '失败'], ['B', commitB.ok ? 'COMMIT' : '40001'], ['原因', 'Canceled on identification as a pivot, during commit attempt.'], ['结果', 'bob 还在值班']],
      events: [
        board('time', timeline('SERIALIZABLE', 'SSI', [{ cells: ['1', 'count', 'count'] }, { cells: ['2', "UPDATE 'ann'", "UPDATE 'bob'"] }, { cells: ['3', 'COMMIT 成功', ''], hot: 'green' }, { cells: ['4', '', 'COMMIT → 40001'], hot: 'red' }], '约束被保住了，B 要重试')),
        pk('backend', 'heap', 'green', 'COMMIT', ['判死 B'], [ms(10), 'XACT', 'PreCommit_CheckForSerializationFailure：A 先提交', null],
          wire('A 提交时的判断', 'vals', 'internal', values('结果', [['A 的提交序号', 1, '先提交者胜出。'], ['被判死的事务', B_W, 'SXACT_FLAG_DOOMED。', { example: true }]], 'green'))),
        board('data', graph([{ from: 'B', to: 'A', label: 'rw', tone: 'red' }, { from: 'A', to: 'B', label: 'rw', tone: 'green' }], 'B 被判死', { A: 'green', B: 'red' })),
        pk('backend2', 'heap', 'amber', 'COMMIT 失败', ['40001'], [ms(11), 'XACT', SERIAL_MSG, serialError.length],
          wire('字段和真实错误一致，行号来自 PostgreSQL 17.11', 'mem', 'protocol', protocolMessage(serialError)), { lost: true }),
      ],
    },
  ],
  outro: {
    title: '基于快照的隔离',
    desc: '读从不阻塞，SERIALIZABLE 靠重试',
    text: 'SQL 标准定义的是不允许哪些异常，每个数据库实现不同。PostgreSQL 的 RC 和 RR 是快照隔离的不同用法；很多数据库的 SERIALIZABLE 用两阶段锁，PostgreSQL 用 SSI，所以读依然不阻塞写。代价是 40001，应用必须能重试。',
    facts: [['RC 常见问题', '不可重复读'], ['RR 防不住', '写偏斜'], ['下一课', 'LOCKS']],
  },
};
