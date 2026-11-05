import { clogBytes, heapTuple, pageHeader, protocolMessage, values, wire, xlogLayers } from '../decode/structures';
import { lsnText, parseLsn } from '../engine/bytes';
import { Clog, TRANSACTION_STATUS_COMMITTED } from '../engine/mvcc';
import { HeapPage } from '../engine/page';
import { commandComplete, queryMessage, readyForQuery } from '../engine/protocol';
import { commitRecord, heapInsertRecord, Wal, type RelLocator } from '../engine/wal';
import type { KvBoard } from '../scene/board-types';
import { board, note, pk, render, show, type as typed } from './dsl';
import { ACCOUNTS, pageBoard, us, walBoard } from './shared';
import type { Lesson } from './types';

const REL: RelLocator = [1663, 16436, 16529];
const XID = 756;
const SQL = "INSERT INTO accounts VALUES (3, 'cat', 300);";

// 起点沿用真实 WAL 的 LSN（tests/golden/wal-records.json）。
const wal = new Wal(parseLsn('0/1A40758'), parseLsn('0/1A406B0'));
const prevCommit = wal.append(commitRecord(wal.prev, 755, 0x27e952de3a90fn), 'COMMIT 755');
wal.flushTo(wal.insert);

const heap = new HeapPage(ACCOUNTS);
heap.insert([1, 'ann', 100], 754);
heap.insert([2, 'bob', 200], 755);
heap.page.lsn = prevCommit.lsn;
const before = heap.clone();
const initialWal = wal.clone();

// heap_insert：改页，写 WAL，把 pd_lsn 设成记录的结束位置。
const off = heap.insert([3, 'cat', 300], XID);
const insertEntry = wal.append(heapInsertRecord(wal.prev, XID, REL, 0, heap.page, off), `INSERT ${XID}`);
heap.page.lsn = insertEntry.end;
const afterInsertWal = wal.clone();

const commitEntry = wal.append(commitRecord(wal.prev, XID, 0x27e952de40000n), `COMMIT ${XID}`);
const beforeFlushWal = wal.clone();
const flushed = wal.flushTo(commitEntry.end);
const afterFlushWal = wal.clone();

const clog = new Clog();
clog.set(754, TRANSACTION_STATUS_COMMITTED);
clog.set(755, TRANSACTION_STATUS_COMMITTED);
const clogBefore = clog.clone();
clog.set(XID, TRANSACTION_STATUS_COMMITTED);

const WALT = 'WAL：只能追加';
const walSpec = (w: Wal, sub: string, hot: number[] = []) => walBoard(w, { title: WALT, sub, hot });

const state = (rows: KvBoard['rows'], sub: string): KvBoard => ({ kind: 'kv', title: '持久性现在到哪一步', sub, keyWidth: 90, rows });

const reply = [commandComplete('INSERT 0 1'), readyForQuery()];

export const walcommit: Lesson = {
  id: 'walcommit',
  name: 'WAL COMMIT',
  title: '预写日志与提交',
  group: 'txn',
  layer: [1, 5],
  timeUnit: 'µs',
  nodes: ['client', 'backend', 'clog', 'buffer', 'wal', 'disk'],
  place: { client: [80, 70], clog: [225, 165], backend: [400, 70], buffer: [575, 165], wal: [750, 70], disk: [895, 165] },
  labels: {
    client: ['客户端', 'psql'],
    backend: ['后端进程', '事务 756'],
    buffer: ['缓冲池', '脏页留在这里'],
    wal: ['WAL', 'wal_buffers → pg_wal'],
    disk: ['磁盘', '数据文件'],
    clog: ['CLOG', 'pg_xact'],
  },
  start: ['client', 'backend'],
  boards: {
    wal: { rect: [20, 250, 900, 150], initial: walSpec(initialWal, '事务开始前') },
    page: { rect: [20, 408, 560, 240], initial: pageBoard(before, { title: '堆页 accounts/0（内存）', sub: `pd_lsn ${lsnText(before.page.lsn)}`, extra: { name: '提示', cell: () => '' } }) },
    state: { rect: [590, 408, 330, 240], initial: state([{ k: '数据页', v: '干净' }, { k: 'WAL', v: '已全部落盘' }, { k: 'CLOG', v: `${XID} 进行中` }], '开始前') },
  },
  legend: [['blue', '请求'], ['amber', '改内存页'], ['violet', 'WAL'], ['green', '提交'], ['slate', '以后才做'], [null, '字节和 CRC 已与真实 WAL 比对']],
  overview: {
    full: '提交的持久性来自 WAL 的 fsync，不是数据页落盘',
    description: '改数据页要写随机位置，太慢。所以修改只写内存里的页，再顺序追加一条 WAL 记录；提交时只要把 WAL 刷到磁盘，崩溃后就能重做。这一课的记录都是真实编码的，长度、xl_prev 和 CRC-32C 都和 PostgreSQL 17 的 WAL 文件逐字节一致。',
    facts: [
      ['规则', '先写日志，再写数据页'],
      ['记录头', 'XLogRecord，24 字节'],
      ['校验', 'CRC-32C'],
      ['段大小', '16 MiB，页 8 KiB'],
      ['提交点', 'XLogFlush 返回'],
      ['配置', 'synchronous_commit 默认 on'],
    ],
  },
  steps: [
    {
      title: '修改内存页',
      desc: '只动缓冲池，磁盘上的数据页不变',
      detail: `heap_insert 拿到缓冲区的排他锁，把元组写进内存里的页，并把页标记为脏。这些都在一个临界区里，直到 WAL 记录写好才算完。这一步既不读也不写磁盘，所以事务多半只是在改内存。`,
      facts: [['xid', String(XID)], ['新元组', `行指针 ${off}，偏移 ${heap.page.lp(off).off}`], ['pd_lsn', '马上要改']],
      events: [
        typed(SQL),
        show('buffer'),
        pk('client', 'backend', 'blue', 'INSERT', [`${queryMessage(SQL).length} 字节`], [0, 'MSG', 'Query 消息', queryMessage(SQL).length],
          wire('客户端到后端', 'mem', 'protocol', protocolMessage(queryMessage(SQL)))),
        pk('backend', 'buffer', 'amber', 'heap_insert', ['3, cat, 300', `xmin ${XID}`], [us(80), 'PAGE', '改内存里的页，MarkBufferDirty', heap.page.lp(off).len],
          wire('缓冲池里的新元组', 'mem', 'disk', heapTuple(heap.page, off, ACCOUNTS))),
        board('page', pageBoard(heap, { title: '堆页 accounts/0（内存）', sub: '脏页', hot: { [off]: 'amber' }, extra: { name: '提示', cell: (lp) => (lp === off ? '新' : '') } })),
        board('state', state([{ k: '数据页', v: '内存里已改，磁盘没变', hot: 'amber' }, { k: 'WAL', v: '还没写' }, { k: 'CLOG', v: `${XID} 进行中` }], '修改内存')),
      ],
    },
    {
      title: '写 WAL 记录',
      desc: '追加到 wal_buffers，得到 LSN',
      detail: `XLogInsert 把这次修改编码成一条 ${insertEntry.bytes.length} 字节的记录，放进共享内存的 wal_buffers，记录的结束位置是 ${lsnText(insertEntry.end)}。然后把页头的 pd_lsn 改成这个值。这条记录写的是修改的内容，重放时不用读原来的行。到这里 WAL 还只在内存里。`,
      facts: [['LSN', lsnText(insertEntry.lsn)], ['结束', lsnText(insertEntry.end)], ['xl_prev', lsnText(insertEntry.prev)], ['xl_crc', `0x${insertEntry.parsed.crc.toString(16)}`]],
      events: [
        show('wal'),
        pk('backend', 'wal', 'violet', 'XLogInsert', [`${insertEntry.bytes.length} 字节`, lsnText(insertEntry.lsn)], [us(120), 'WAL', `Heap INSERT，LSN ${lsnText(insertEntry.lsn)}`, insertEntry.bytes.length],
          wire('一条真实的 Heap/INSERT 记录。编码器已用 pg_wal 里的字节验证过', 'mem', 'disk', ...xlogLayers(insertEntry))),
        board('wal', walSpec(afterInsertWal, '记录在 wal_buffers 里（黄色）', [afterInsertWal.entries.length - 1])),
        board('page', pageBoard(heap, { title: '堆页 accounts/0（内存）', sub: `pd_lsn ${lsnText(heap.page.lsn)}`, extra: { name: '提示', cell: (lp) => (lp === off ? '新' : '') } })),
        pk('wal', 'buffer', 'amber', 'PageSetLSN', [lsnText(insertEntry.end)], [us(130), 'PAGE', 'pd_lsn 设成记录的结束位置', 8],
          wire('页头 pd_lsn 变了', 'mem', 'disk', pageHeader(heap.page))),
      ],
    },
    {
      title: '提交记录',
      desc: 'COMMIT 也是一条 WAL 记录',
      detail: `应用发 COMMIT。CommitTransaction 调用 RecordTransactionCommit，先写一条 Transaction/COMMIT 记录：只有 ${commitEntry.bytes.length} 字节，正文就是一个提交时间戳。这条记录才是“事务提交了”的唯一证据。恢复时看到它，就知道这个事务成功了。`,
      facts: [['长度', `${commitEntry.bytes.length} 字节（24 头 + 2 短数据头 + 8 时间戳）`], ['rmgr', 'Transaction（1）'], ['函数', 'XactLogCommitRecord']],
      events: [
        pk('backend', 'wal', 'violet', 'COMMIT 记录', [`${commitEntry.bytes.length} 字节`], [us(180), 'WAL', `XactLogCommitRecord，LSN ${lsnText(commitEntry.lsn)}`, commitEntry.bytes.length],
          wire('Transaction/COMMIT 记录的完整字节', 'mem', 'disk', ...xlogLayers(commitEntry))),
        board('wal', walSpec(beforeFlushWal, '记录都还在内存', [beforeFlushWal.entries.length - 1])),
      ],
    },
    {
      title: 'XLogFlush',
      desc: '这次 fsync 返回，事务才算持久',
      detail: `XLogFlush 把 WAL 写到 ${lsnText(commitEntry.end)} 并 fsync，共 ${flushed} 字节。这一步返回，事务才算持久：就算现在断电，恢复时也能重放出这次修改。组提交让同时提交的事务共用一次 fsync，所以 fsync 次数可以少于提交数。整个事务的 I/O 只有这一次，而且是顺序写。`,
      facts: [['写到', lsnText(commitEntry.end)], ['字节数', String(flushed)], ['设备', 'wal_sync_method 决定怎么刷'], ['组提交', '只需要等别人刷到自己之后']],
      events: [
        show('disk'),
        pk('wal', 'disk', 'green', 'fsync', [`${flushed} 字节`], [us(1200), 'FSYNC', `XLogWrite + issue_xlog_fsync，刷到 ${lsnText(commitEntry.end)}`, flushed],
          wire('LogwrtResult 的两个指针', 'vals', 'internal', values('WAL 进度', [['Write', commitEntry.end, '已写到操作系统。', { width: 8, shown: lsnText(commitEntry.end), example: true }], ['Flush', commitEntry.end, '已经 fsync。这就是持久性的边界。', { width: 8, shown: lsnText(commitEntry.end), example: true }]], 'green'))),
        board('wal', walSpec(afterFlushWal, '已经落盘（绿色）', [afterFlushWal.entries.length - 2, afterFlushWal.entries.length - 1])),
        board('state', state([{ k: '数据页', v: '磁盘上仍是旧的' }, { k: 'WAL', v: '已 fsync，事务持久了', hot: 'green' }, { k: 'CLOG', v: `${XID} 还是进行中` }], '持久性到位')),
        note('wal', '持久了', 'green'),
      ],
    },
    {
      title: '告诉所有人',
      desc: '改 CLOG，退出 ProcArray，回复客户端',
      detail: `WAL 落盘之后才写 CLOG，把 ${XID} 的 2 位改成 01，再从 ProcArray 退出，别人的新快照才认为它提交了。顺序不能反：如果先改 CLOG，别的事务可能基于一个还没持久的结果继续工作，崩溃后就对不上了。最后才回复客户端。`,
      facts: [['顺序', 'XLogFlush → TransactionIdCommitTree → ProcArrayEndTransaction'], ['CLOG', `第 ${clog.byteOf(XID)} 字节`], ['回复', 'CommandComplete + ReadyForQuery']],
      events: [
        show('clog'),
        pk('backend', 'clog', 'green', 'CLOG 置位', [`xid ${XID} = 01`], [us(1220), 'XACT', 'TransactionIdCommitTree，写共享内存里的 SLRU 缓冲', 1],
          wire('真实的 2 位状态。字节位置 = xid ÷ 4', 'mem', 'disk', clogBytes(clogBefore, [754, 755], 'slate'), clogBytes(clog, [XID], 'green'))),
        board('state', state([{ k: '数据页', v: '磁盘上仍是旧的' }, { k: 'WAL', v: '已落盘' }, { k: 'CLOG', v: `${XID} 已提交`, hot: 'green' }, { k: 'ProcArray', v: `${XID} 已退出` }], '别人能看到了')),
        pk('backend', 'client', 'green', 'COMMIT', ['INSERT 0 1'], [us(1260), 'MSG', 'CommandComplete + ReadyForQuery', reply[0].length + reply[1].length],
          wire('回复客户端', 'mem', 'protocol', protocolMessage(reply[0]), protocolMessage(reply[1]))),
        render,
      ],
    },
    {
      title: '数据页以后再写',
      desc: '检查点或后台写进程负责，不在提交路径上',
      detail: '提交成功时，磁盘上的数据页还是旧的，这是正常的。脏页由 bgwriter 或 checkpointer 以后写出，写之前保证 WAL 已经刷到 pd_lsn。把 synchronous_commit 改成 off，就连提交时的 fsync 也不等了：崩溃可能丢最近的提交，但数据不会损坏。',
      facts: [['写数据页', 'checkpointer、bgwriter'], ['检查点间隔', 'checkpoint_timeout = 5 分钟'], ['synchronous_commit=off', '可能丢事务，不会坏数据'], ['整页镜像', 'full_page_writes，下一课讲']],
      events: [
        pk('buffer', 'disk', 'slate', '写脏页', ['8192 字节'], [us(300000), 'IO', '几分钟后由 checkpointer 写出', 8192],
          wire('这时 WAL 早已刷过 pd_lsn', 'mem', 'disk', pageHeader(heap.page))),
        board('state', state([{ k: '数据页', v: '现在才写到磁盘', hot: 'green' }, { k: 'WAL', v: '可以回收到检查点' }, { k: '检查点', v: '恢复从这里开始' }], '最终')),
      ],
    },
  ],
  outro: {
    title: '日志先行',
    desc: '一次顺序写，换来崩溃后什么都不丢',
    text: 'WAL 是通用原理，大多数数据库都有。PostgreSQL 的具体做法：记录格式和 CRC-32C、redo-only（没有 undo 记录）、组提交、CLOG。常见错讲是“提交时数据页落盘”：实际上提交只刷 WAL。',
    facts: [['提交时写', 'WAL'], ['提交时不写', '数据页'], ['下一课', 'CRASH RECOVERY']],
  },
};
