import { concept, lockTagTransaction, protocolMessage, values, wire } from '../decode/structures';
import { errorResponse } from '../engine/protocol';
import { findLockCycle, LockTable, LOCK_MODES, lockConflicts } from '../engine/locks';
import type { GraphBoard, TableBoard, Tone } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { ms } from './shared';
import type { Lesson } from './types';

/** 三个事务号沿用真实运行里的数字；死锁结果和日志也来自那次运行。 */
const T1 = 789;
const T2 = 788;
const T3 = 790;
/** 真实运行时：T1 改 id=1 等 id=2；T2 改 id=2 等 id=3；T3 改 id=3 等 id=1。 */
const names: Record<number, string> = { [T1]: 'T1', [T2]: 'T2', [T3]: 'T3' };
const locks = new LockTable();

const rowTable = (holders: Record<string, number>, waits: Array<[number, number, string]>, sub: string, hotRow?: string, extra?: string): TableBoard => ({
  kind: 'table',
  title: '行上的 xmax 和等待队列',
  sub,
  columns: ['行', '元组 xmax', '谁在等'],
  widths: [40, 90, 150],
  rows: ['id=1', 'id=2', 'id=3'].map((row) => {
    const holder = holders[row];
    const waiter = waits.find((w) => w[2] === row);
    return { cells: [row, holder ? `${holder}（${names[holder]}）` : '0', waiter ? `${names[waiter[0]]} 等 xid ${waiter[1]}` : ''], hot: row === hotRow ? 'amber' : undefined };
  }),
  note: extra,
});

const toneOf = (cycle: boolean): Tone => (cycle ? 'red' : 'amber');

const graphSpec = (edges: Array<[number, number]>, sub: string, cycle = false, footer?: string, tones: Record<number, Tone> = {}): GraphBoard => ({
  kind: 'graph',
  title: '等待图',
  sub,
  nodes: [T1, T2, T3].map((xid) => ({ id: String(xid), label: names[xid], sub: `xid ${xid}`, tone: tones[xid] })),
  edges: edges.map(([from, to]) => ({ from: String(from), to: String(to), label: '等', tone: toneOf(cycle) })),
  footer,
});

const holders: Record<string, number> = {};
const lockRow = (row: string, xid: number, now: number) => {
  const result = locks.lockRow(row, xid, now);
  if (result.granted) holders[row] = xid;
  return result;
};
lockRow('id=1', T1, 0);
lockRow('id=2', T2, 0);
lockRow('id=3', T3, 0);
const initialHolders = { ...holders };

const w1 = lockRow('id=2', T1, 400);
lockRow('id=3', T2, 600);
const after2 = new Map(locks.waits);
const noCycle = findLockCycle(T1, after2);
const w3 = lockRow('id=1', T3, 800);
const edges = new Map(locks.waits);
const first = locks.firstToCheck()!;
const check = findLockCycle(first, edges);
const wokenA = locks.release(first);
const third = wokenA[0];
const edgesAfterAbort = new Map(locks.waits);

const DEADLOCK = errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '40P01'], ['M', 'deadlock detected'], ['D', `Process 8372 waits for ShareLock on transaction ${T2}; blocked by process 8371.`], ['F', 'deadlock.c'], ['L', '1135'], ['R', 'DeadLockReport']]);

const conflictRows: TableBoard['rows'] = LOCK_MODES.slice(0, 8).filter((_, i) => [0, 2, 3, 7].includes(i)).map((mode) => ({
  cells: [mode, LOCK_MODES.filter((other) => lockConflicts(mode, other)).length + ' 种', lockConflicts(mode, 'RowExclusive') ? '冲突' : '不冲突', lockConflicts(mode, 'AccessShare') ? '冲突' : '不冲突'],
}));

export const locksLesson: Lesson = {
  id: 'locks',
  name: 'LOCKS',
  title: '锁与死锁检测',
  group: 'txn',
  layer: [5, 5],
  timeUnit: 'ms',
  nodes: ['backend', 'backend3', 'lock', 'backend2'],
  place: { backend: [90, 60], backend3: [290, 175], lock: [510, 100], backend2: [850, 100] },
  labels: {
    backend: ['T1', '等的最久'],
    backend3: ['T3', '第三个等待'],
    lock: ['锁管理器', 'LockAcquire'],
    backend2: ['T2', '第二个等待'],
  },
  start: ['backend', 'lock', 'backend2', 'backend3'],
  boards: {
    graph: { rect: [20, 265, 450, 280], initial: graphSpec([], '没有等待') },
    rows: { rect: [480, 265, 440, 280], initial: rowTable(initialHolders, [], '三个事务各改了一行') },
    conflict: { rect: [20, 553, 900, 110], initial: { kind: 'kv', title: '常见锁', keyWidth: 170, rows: [{ k: '表锁', v: '8 种模式，存在共享内存的锁表里（LockConflicts）' }, { k: '行锁', v: '写在元组的 xmax 上，数量不受锁表大小限制' }, { k: '事务锁', v: '等行其实是等持有者的事务号结束' }] } },
  },
  legend: [['blue', '正常加锁'], ['amber', '进入等待'], ['violet', '死锁检查'], ['green', '被唤醒'], [null, '错误和选中谁都来自真实运行']],
  overview: {
    full: '行锁在元组上，等待在事务号上，死锁靠定时检查',
    description: '三个事务各改一行，再去改下一个事务的行，形成环。PostgreSQL 等满 deadlock_timeout（默认 1 秒）才检查有没有环，因为大多数等待很快结束。这一课的等待图由真实的查环算法走出来，结果和真实运行一致：等得最久的 T1 被报错。',
    facts: [
      ['deadlock_timeout', '1 秒'],
      ['检查入口', 'CheckDeadLock → DeadLockCheck'],
      ['查环', 'FindLockCycle'],
      ['受害者', '发现死锁的那个进程自己'],
      ['错误码', '40P01'],
      ['行锁', '写在元组 xmax 上'],
    ],
  },
  steps: [
    {
      title: '行锁写在元组上',
      desc: '改一行，就把自己的事务号写进 xmax',
      detail: '三个事务各改一行。行锁没有放进共享内存的锁表，而是直接写在元组的 t_xmax 上，所以锁再多行也不会耗尽锁表。每个事务拿到事务号时，就对它持有一把 ExclusiveLock，别人想等它，就来等这把锁。',
      facts: [['T1', `持有 id=1，xid ${T1}`], ['T2', `持有 id=2，xid ${T2}`], ['T3', `持有 id=3，xid ${T3}`], ['事务号锁', 'XactLockTableInsert']],
      events: [
        pk('backend', 'lock', 'blue', '事务号锁', [`xid ${T1}`, 'ExclusiveLock'], [0, 'LOCK', 'XactLockTableInsert：拿到事务号时对自己加锁', 16],
          wire('锁表里的键。真正的 LOCK 结构还有持有者和等待队列', 'mem', 'internal', lockTagTransaction(T1))),
        note('backend', 'UPDATE id=1 成功'),
      ],
    },
    {
      title: '碰到别人的行',
      desc: 'xmax 有人写了，就去等那个事务',
      detail: `T1 要改 id=2。HeapTupleSatisfiesUpdate 看到 xmax = ${T2} 且事务还在运行，返回 TM_BeingModified。于是 T1 调用 XactLockTableWait，对事务号 ${T2} 申请 ShareLock。这和 ${T2} 自己持有的 ExclusiveLock 冲突，T1 就睡了。所以等待图的节点是事务，不是行。`,
      facts: [['T1 等', `xid ${w1.holder}`], ['申请模式', 'ShareLock'], ['函数', 'XactLockTableWait'], ['pg_locks', 'locktype = transactionid']],
      events: [
        board('rows', rowTable(holders, [[T1, T2, 'id=2']], 'T1 被挡住', 'id=2', 'T1 在 UPDATE id=2')),
        board('graph', graphSpec([[T1, T2]], 'T1 等 T2')),
        pk('backend', 'lock', 'amber', 'XactLockTableWait', [`xid ${T2}`, 'ShareLock'], [ms(400), 'LOCK', `T1 申请事务号 ${T2} 的 ShareLock，进入等待`, 16],
          wire('T1 要等的这把锁', 'mem', 'internal', lockTagTransaction(T2)), { locked: true }),
        pk('backend2', 'lock', 'amber', '继续等待', [`xid ${T3}`], [ms(600), 'LOCK', `T2 也改别人的行：等事务号 ${T3}`, 16],
          wire('T2 要等的这把锁', 'mem', 'internal', lockTagTransaction(T3)), { locked: true }),
        board('graph', graphSpec([[T1, T2], [T2, T3]], `从 T1 出发找不到环（实测 ${noCycle.cycle ? '有' : '无'}）`)),
        board('rows', rowTable(holders, [[T1, T2, 'id=2'], [T2, T3, 'id=3']], 'T2 也在等', 'id=3')),
      ],
    },
    {
      title: '形成环',
      desc: 'T3 去等 T1，三个人谁都走不了',
      detail: `T3 要改 id=1，而 id=1 的 xmax 是 T1。T3 等 T1，T1 等 T2，T2 等 T3，环闭合了。此刻数据库还不知道，三个进程都在睡，每个进程睡之前都设了 deadlock_timeout 的定时器。等待本身不用占 CPU。`,
      facts: [['T1 → T2', '等'], ['T2 → T3', '等'], ['T3 → T1', `等（xid ${w3.holder}）`], ['检测', '还没开始']],
      events: [
        board('rows', rowTable(holders, [[T1, T2, 'id=2'], [T2, T3, 'id=3'], [T3, T1, 'id=1']], '都在等', 'id=1', '没有人能继续')),
        pk('backend3', 'lock', 'amber', '等 T1', [`xid ${T1}`], [ms(800), 'LOCK', `T3 申请事务号 ${T1} 的 ShareLock：环闭合`, 16],
          wire('T3 要等的这把锁', 'mem', 'internal', lockTagTransaction(T1)), { locked: true }),
        board('graph', graphSpec([[T1, T2], [T2, T3], [T3, T1]], '环已形成，但还没人检查')),
        note('lock', '定时器还没到', 'amber'),
      ],
    },
    {
      title: '定时检查',
      desc: '等够 1 秒的进程自己去查环',
      detail: `T1 最早开始等，它的 deadlock_timeout 最先到。它醒来调用 CheckDeadLock，拿所有锁分区的 LWLock，再由 DeadLockCheck → FindLockCycle 沿等待关系走：${check.visited.map((xid) => names[xid]).join(' → ')} → 回到 ${names[first]}。回到起点才算死锁；走回中间节点不算，那个环与自己无关，由别的进程发现。`,
      facts: [['谁先检查', `${names[first]}，等了 1 秒`], ['走过的节点', check.visited.map((xid) => names[xid]).join(' → ')], ['结果', check.cycle ? '有环' : '没有环'], ['软死锁', '重排等待队列能解开时不报错']],
      events: [
        pk('backend', 'lock', 'violet', 'DeadLockCheck', [`起点 ${names[first]}`], [ms(1400), 'LOCK', `T1 等满 1 秒，FindLockCycle 从 ${names[first]} 出发`, null],
          wire('FindLockCycle 的 visitedProcs', 'vals', 'internal', values('深度优先走过的进程', check.visited.map((xid, i): [string, number, string, { example: boolean }] => [`visited[${i}]`, xid, `${names[xid]} 的事务号`, { example: true }]), 'violet'))),
        board('graph', graphSpec([[T1, T2], [T2, T3], [T3, T1]], 'FindLockCycle：回到起点', true, `路径 ${check.cycle!.map((xid) => names[xid]).join(' → ')} → ${names[first]}`, { [T1]: 'red', [T2]: 'red', [T3]: 'red' })),
        note('lock', '发现死锁', 'amber'),
      ],
    },
    {
      title: '谁来牺牲',
      desc: '发现死锁的进程自己报错',
      detail: 'PostgreSQL 不挑最年轻或代价最小的事务，发现死锁的进程直接报错回滚自己，也就是 T1。错误是 40P01 deadlock detected，DETAIL 列出整个环。真实运行里正是最早开始等的那个收到了错误，T2 和 T3 都成功提交。这和“杀掉最年轻事务”的说法不同。',
      facts: [['受害者', `${names[first]}（最早等满 1 秒）`], ['错误码', '40P01'], ['函数', 'DeadLockReport'], ['释放', '回滚后所有锁一起释放']],
      events: [
        pk('backend', 'lock', 'amber', 'ERROR 40P01', ['deadlock detected'], [ms(1401), 'XACT', `${names[first]} 报错回滚`, DEADLOCK.length],
          wire('字段和真实错误一致。进程号来自那次运行', 'mem', 'protocol', protocolMessage(DEADLOCK)), { lost: true }),
        board('graph', graphSpec([[T2, T3]], `${names[first]} 已回滚`, false, `${names[third]} 醒了`, { [T1]: 'red', [T3]: 'green' })),
        board('rows', rowTable({ 'id=2': T2, 'id=3': T3 }, [[T2, T3, 'id=3']], `${names[first]} 的锁释放了`, 'id=1', 'T3 拿到 id=1')),
      ],
    },
    {
      title: '其余事务继续',
      desc: 'T3 醒来，T2 跟着完成',
      detail: `${names[first]} 回滚后，事务号锁释放，等它的 T3 被唤醒。T3 提交后 T2 也能继续。所有事务都按一致的顺序访问资源，就不会有死锁；死锁检测只是最后的保险。默认 1 秒的定时检查意味着正常等待不用付检查开销，代价是死锁要 1 秒才能发现。`,
      facts: [['被唤醒', names[third]], ['还在等', [...edgesAfterAbort.keys()].map((xid) => names[xid]).join('、') || '没有'], ['真实结果', '1|101  2|201  3|302'], ['避免办法', '按固定顺序更新多行']],
      events: [
        show('backend2'),
        pk('lock', 'backend3', 'green', '唤醒', [`xid ${first} 结束`], [ms(1402), 'LOCK', 'ProcLockWakeup：T3 拿到 ShareLock', null],
          wire('T1 结束时释放的是它自己的事务号锁', 'mem', 'internal', lockTagTransaction(first, 'green'))),
        pk('lock', 'backend2', 'green', '唤醒', [`xid ${T3} 结束`], [ms(1610), 'LOCK', 'T3 提交后 T2 继续', null],
          wire('表锁的兼容性（LockConflicts）。这里只列 4 种模式', 'vals', '示意', concept('常见模式', conflictRows.map((row): [string, string, string] => [row.cells[0], `和 ${row.cells[1]}冲突`, `对 RowExclusive：${row.cells[2]}；对 AccessShare：${row.cells[3]}`]), 'green'))),
        board('graph', graphSpec([], '全部结束', false, 'T2、T3 都成功提交', { [T1]: 'red', [T2]: 'green', [T3]: 'green' })),
        board('rows', rowTable({}, [], '事务结束，行的 xmax 不再生效', undefined, '真实结果：1|101  2|201  3|302')),
      ],
    },
  ],
  outro: {
    title: '乐观地等，定时地查',
    desc: '大多数等待很快结束，不值得每次都查环',
    text: '等待图和查环是通用原理。PostgreSQL 的具体做法：行锁写在元组上，等待落在事务号上，等够 deadlock_timeout 才查，并且发现者自己牺牲。真实算法还处理等待队列的重排（软边），这里的例子只有硬边。',
    facts: [['行锁在', '元组 xmax'], ['受害者', '发现者自己'], ['下一课', 'WAL COMMIT']],
  },
};
