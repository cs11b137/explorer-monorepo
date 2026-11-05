import { clogBytes, heapPageLayers, pageHeader, protocolMessage, values, wire, xlogLayers } from '../decode/structures';
import { lsnText, parseLsn, toHex } from '../engine/bytes';
import { Clog, getSnapshot, satisfiesMVCC } from '../engine/mvcc';
import { HeapPage, Page } from '../engine/page';
import { commandComplete, readyForQuery } from '../engine/protocol';
import { commitRecord, heapInsertRecord, redoOne, RM_XACT_ID, validateRecord, Wal, type RelLocator, type WalEntry } from '../engine/wal';
import type { KvBoard, Tone } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { ACCOUNTS, ms, pageBoard, walBoard } from './shared';
import type { Lesson } from './types';

const REL: RelLocator = [1663, 16436, 16529];
const XA = 901;
const XB = 902;
const XC = 903;

// ---------- 崩溃之前 ----------
// 检查点时第 0 页已经干净地写到磁盘，上面有一行。
const heap = new HeapPage(ACCOUNTS);
heap.insert([1, 'ann', 100], 900);
const REDO = parseLsn('0/1A40100');
heap.page.lsn = parseLsn('0/1A400C8');
const atCheckpoint = heap.clone();

const wal = new Wal(REDO, parseLsn('0/1A400C8'));
const rec = (bytes: Uint8Array, label: string): WalEntry => wal.append(bytes, label);

// XA：检查点后第一次碰这一页，full_page_writes 让记录带上整页镜像。
const offA = heap.insert([2, 'bob', 200], XA);
const eA = rec(heapInsertRecord(wal.prev, XA, REL, 0, heap.page, offA, true), 'INSERT+镜像');
heap.page.lsn = eA.end;
const eAc = rec(commitRecord(wal.prev, XA, 0x27e952de3a000n), `COMMIT ${XA}`);
// XB：写了行，没有提交。
const offB = heap.insert([3, 'cat', 300], XB);
const eB = rec(heapInsertRecord(wal.prev, XB, REL, 0, heap.page, offB), `INSERT ${XB}`);
heap.page.lsn = eB.end;
// XC：写了行并发起提交，但提交记录只写了一半就断电。
const offC = heap.insert([4, 'dan', 400], XC);
const eC = rec(heapInsertRecord(wal.prev, XC, REL, 0, heap.page, offC), `INSERT ${XC}`);
heap.page.lsn = eC.end;
const eCc = rec(commitRecord(wal.prev, XC, 0x27e952de42000n), `COMMIT ${XC}`);
wal.flush = eC.end;
const beforeCrash = heap.clone();

// 断电：提交记录的后半没写完，磁盘上这部分是旧内容（这里是 0）。
const torn = eCc.bytes.slice();
torn.fill(0, 26);
const diskEntries: WalEntry[] = [eA, eAc, eB, eC, { ...eCc, bytes: torn }];

// 断电时第 0 页正在写，只写了前半：页头是新的，页尾还是检查点时的旧内容。
const tornPage = new Page(8192, 0, new Uint8Array(atCheckpoint.page.bytes));
tornPage.bytes.set(beforeCrash.page.bytes.subarray(0, 4096), 0);
const tornHeap = new HeapPage(ACCOUNTS);
tornHeap.page = tornPage;

// ---------- 恢复：只用磁盘上的字节 ----------
const steps: Array<{ entry: WalEntry; action: string; ok: boolean; reason: string; page: HeapPage; lsnBefore: bigint | null; lsnAfter: bigint | null }> = [];
let current = tornPage;
let prev = wal.entries[0].prev;
for (const entry of diskEntries) {
  const check = validateRecord(entry, prev);
  if (!check.ok) {
    steps.push({ entry, action: 'END', ok: false, reason: check.reason, page: snapshotHeap(current), lsnBefore: null, lsnAfter: null });
    break;
  }
  const lsnBefore = entry.parsed.block ? current.lsn : null;
  const result = redoOne(entry, current, ACCOUNTS.length);
  current = result.page;
  steps.push({ entry, action: result.action, ok: true, reason: check.reason, page: snapshotHeap(current), lsnBefore, lsnAfter: entry.parsed.block ? current.lsn : null });
  prev = entry.lsn;
}
function snapshotHeap(page: Page): HeapPage {
  const out = new HeapPage(ACCOUNTS);
  out.page = page.clone();
  return out;
}

/** 重放后的页面和崩溃前内存里的页面逐字节相同（XC 的行也重放了：记录完好）。这是 tests/lessons.test.ts 检查的不变量。 */
export const recoveredHex = toHex(current.bytes);
export const beforeCrashHex = toHex(beforeCrash.page.bytes);

const replayed = steps.filter((s) => s.ok);
const stop = steps.find((s) => !s.ok)!;
const fpiStep = steps[0];
const redoStep = steps[2];

// 恢复后的 CLOG：只有 XA 有提交记录。
const clog = new Clog();
clog.set(900, 1);
for (const s of replayed) if (s.entry.parsed.rmid === RM_XACT_ID) clog.set(s.entry.parsed.xid, 1);
const afterSnap = getSnapshot([], XC + 1);
const recovered = snapshotHeap(current);
const seen = Array.from({ length: recovered.page.maxOffset }, (_, i) => satisfiesMVCC(recovered.tuple(i + 1), afterSnap, clog));

// ---------- 关掉 full_page_writes 时：LSN 比较决定跳过 ----------
const noFpi = new HeapPage(ACCOUNTS);
noFpi.insert([1, 'ann', 100], 900);
noFpi.page.lsn = parseLsn('0/1A400C8');
const altWal = new Wal(REDO, parseLsn('0/1A400C8'));
const offN = noFpi.insert([2, 'bob', 200], XA);
const n1 = altWal.append(heapInsertRecord(altWal.prev, XA, REL, 0, noFpi.page, offN), `INSERT ${XA}`);
noFpi.page.lsn = n1.end;
const flushedPage = noFpi.page.clone();
const offM = noFpi.insert([3, 'cat', 300], XB);
const n2 = altWal.append(heapInsertRecord(altWal.prev, XB, REL, 0, noFpi.page, offM), `INSERT ${XB}`);
const skip = redoOne(n1, flushedPage.clone(), ACCOUNTS.length);
const apply = redoOne(n2, flushedPage.clone(), ACCOUNTS.length);

const pageSpec = (h: HeapPage, sub: string, hot: Record<number, Tone> = {}, extra?: (lp: number) => string) => pageBoard(h, { title: '磁盘上的 accounts/0', sub, hot, extra: { name: '状态', cell: extra ?? (() => '') } });

const control = (rows: KvBoard['rows'], sub: string): KvBoard => ({ kind: 'kv', title: 'pg_control 与恢复进度', sub, keyWidth: 132, rows });
const ctrlBase: KvBoard['rows'] = [{ k: 'state', v: 'DB_IN_PRODUCTION' }, { k: 'redo 点', v: lsnText(REDO) }];

const marks = (upto: number): Record<number, string> => Object.fromEntries(steps.slice(0, upto).map((s, i) => [i, s.ok ? (s.action === 'NO_BLOCK' ? '写 CLOG' : s.action.replace('BLK_', '')) : 'CRC 不符']));
const diskWal = (() => {
  const w = new Wal(wal.insert, wal.prev);
  w.flush = wal.insert;
  w.entries = diskEntries;
  return w;
})();
const walSpec = (sub: string, hot: number[], upto: number, torn = false) => walBoard(diskWal, { title: 'pg_wal 里的记录', sub, hot, marks: marks(upto), torn: torn ? [4] : [], pointers: [{ name: 'redo 起点', lsn: REDO, tone: 'violet' }, { name: '写到一半', lsn: eCc.lsn, tone: 'red' }] });

export const recovery: Lesson = {
  id: 'recovery',
  name: 'CRASH RECOVERY',
  title: '崩溃恢复',
  group: 'txn',
  layer: [1, 5],
  timeUnit: 'ms',
  nodes: ['startup', 'wal', 'disk', 'clog', 'client'],
  place: { clog: [90, 165], startup: [280, 70], wal: [470, 165], disk: [660, 70], client: [850, 165] },
  labels: {
    startup: ['startup 进程', 'StartupXLOG'],
    wal: ['WAL', 'pg_wal'],
    disk: ['数据文件', 'accounts/0'],
    clog: ['CLOG', 'pg_xact'],
    client: ['客户端', '等待连接'],
  },
  start: ['startup'],
  boards: {
    wal: { rect: [20, 250, 900, 150], initial: walSpec('断电前的状态', [], 0) },
    page: { rect: [20, 410, 560, 250], initial: pageSpec(snapshotHeap(atCheckpoint.page), `检查点时的状态，pd_lsn ${lsnText(atCheckpoint.page.lsn)}`) },
    ctrl: { rect: [590, 410, 330, 250], initial: control(ctrlBase, '崩溃前') },
  },
  legend: [['slate', '读控制信息'], ['violet', '读 WAL'], ['amber', '重放'], ['green', '完成'], [null, '重放只用磁盘上的字节，结果和崩溃前相同']],
  overview: {
    full: '从检查点开始，把 WAL 里的修改再做一遍',
    description: '断电时内存全部丢失。磁盘上只有两样东西：可能是旧的或写坏的数据页，以及完好的 WAL。恢复就是从最后一个检查点的 redo 点开始，把 WAL 重放到尾部。PostgreSQL 只有 redo，没有 undo：未提交事务的行留在页上，靠 CLOG 判断为不可见。这一课真实跑一遍重放。',
    facts: [
      ['入口', 'StartupXLOG → PerformWalRecovery'],
      ['起点', 'pg_control 里的 redo 点'],
      ['跳过依据', '页 LSN ≥ 记录的结束位置'],
      ['页断裂', 'full_page_writes 的整页镜像'],
      ['尾部', 'xl_crc 或 xl_prev 不对就结束'],
      ['undo', '没有。未提交的行靠 CLOG 过滤'],
    ],
  },
  steps: [
    {
      title: '断电现场',
      desc: '内存没了，页面可能写了一半',
      detail: `断电时第 0 页正在写，只写了前 4 KiB。这里要注意：操作系统和磁盘只保证 512 字节或 4 KiB 的原子写，8 KiB 页可能断裂。页头的 pd_lsn 看起来很新，后半却是旧内容，所以这一页已经坏了。WAL 也停在一条提交记录的中间。`,
      facts: [['页状态', '前 4 KiB 新，后 4 KiB 旧'], ['WAL', '最后一条写了一半'], ['内存', '全部丢失']],
      events: [
        show('wal', 'disk'),
        pk('wal', 'disk', 'amber', '断电', ['写到一半'], [0, 'IO', '正在写第 0 页和 WAL 时断电', 4096],
          wire('磁盘上这一页的头：pd_lsn 是新的，但后 4 KiB 是旧内容', 'mem', 'disk', pageHeader(tornPage)), { lost: true }),
        board('wal', walSpec('最后一条是坏的', [4], 0, true)),
        board('page', { ...pageSpec(snapshotHeap(atCheckpoint.page), `pd_lsn ${lsnText(tornPage.lsn)}，但页面已断裂`), title: '磁盘上的 accounts/0（断裂）' }),
      ],
    },
    {
      title: '找到起点',
      desc: 'pg_control 记着最后的检查点',
      detail: `postmaster 重启，看到 pg_control 的状态不是正常关闭，就启动 startup 进程做崩溃恢复。InitWalRecovery 读 pg_control 里的最新检查点，再读这条检查点记录得到 redo 点 ${lsnText(REDO)}。检查点保证在 redo 点之前的修改都已写到数据文件，所以不用从更早的地方开始。`,
      facts: [['redo 点', lsnText(REDO)], ['函数', 'InitWalRecovery、ReadCheckpointRecord'], ['检查点', '写所有脏页 + 一条 WAL 记录']],
      events: [
        pk('disk', 'startup', 'slate', 'pg_control', [`redo ${lsnText(REDO)}`], [ms(5), 'REDO', 'InitWalRecovery 读控制文件', 8192],
          wire('ControlFileData 里相关的字段（只列值，不展示偏移）', 'vals', 'internal', values('pg_control', [['state', 4, 'DB_IN_PRODUCTION：上次没有正常关闭。', { shown: 'DB_IN_PRODUCTION' }], ['checkPointCopy.redo', REDO, '恢复从这里开始。', { width: 8, shown: lsnText(REDO), example: true }]], 'slate'))),
        board('ctrl', control([...ctrlBase.map((row, i) => (i === 1 ? { ...row, hot: 'violet' as Tone } : row)), { k: '进度', v: '从 redo 点开始' }], '找到起点')),
      ],
    },
    {
      title: '整页镜像修好断页',
      desc: '第一条记录带整页，直接覆盖',
      detail: `检查点之后第一次修改一页时，WAL 记录会带上这一页的完整镜像（full_page_writes，默认开）。重放这条记录时不看磁盘上的内容，直接覆盖，所以断裂的页被修好了。这是 XLogReadBufferForRedo 返回 ${fpiStep.action} 的情况。镜像去掉了 pd_lower 和 pd_upper 之间的空洞，只有 ${eA.parsed.block!.image!.length} 字节。`,
      facts: [['动作', fpiStep.action], ['镜像大小', `${eA.parsed.block!.image!.length} 字节`], ['空洞起点', String(eA.parsed.block!.image!.holeOffset)], ['代价', '每次检查点后 WAL 变多']],
      events: [
        pk('wal', 'startup', 'violet', 'INSERT + 镜像', [`${eA.bytes.length} 字节`], [ms(10), 'REDO', `读 ${lsnText(eA.lsn)}，xl_crc 校验通过`, eA.bytes.length],
          wire('带 BKPBLOCK_HAS_IMAGE 的记录。悬停块引用可以看到空洞', 'mem', 'disk', ...xlogLayers(eA))),
        board('wal', walSpec('整页镜像', [0], 1, true)),
        board('page', pageSpec(fpiStep.page, `镜像恢复，pd_lsn ${lsnText(fpiStep.lsnAfter!)}`, { [offA]: 'green', 1: 'green' })),
        pk('startup', 'disk', 'green', '写回整页', [fpiStep.action], [ms(11), 'REDO', 'RestoreBlockImage：覆盖断裂的页', 8192],
          wire('恢复后的页头和元组', 'mem', 'disk', ...heapPageLayers(fpiStep.page.page, ACCOUNTS, [offA]))),
        board('ctrl', control([...ctrlBase, { k: '进度', v: lsnText(eA.end) }, { k: '断页', v: '已修复', hot: 'green' }], '重放中')),
      ],
    },
    {
      title: '逐条重放',
      desc: '提交和未提交的修改都重做',
      detail: `接下来的记录都按顺序重放：事务 ${XA} 的提交写进 CLOG，事务 ${XB} 和 ${XC} 的 INSERT 也重放，哪怕它们没有提交。redo 不区分提交与否，只负责把页面恢复到断电时的样子。每重放一条，页的 pd_lsn 就推进到这条记录的结束位置。结果和崩溃前内存里的页逐字节相同。`,
      facts: [['重放', replayed.map((s) => s.entry.label).join('，')], ['页 LSN', lsnText(redoStep.lsnAfter ?? steps[3].lsnAfter!)], ['字节比较', recoveredHex === beforeCrashHex ? '和崩溃前完全一致' : '不一致']],
      events: [
        pk('wal', 'startup', 'violet', `COMMIT ${XA}`, ['xact_redo_commit'], [ms(14), 'REDO', `${XA} 的提交写进 CLOG`, eAc.bytes.length],
          wire('Transaction/COMMIT 记录', 'mem', 'disk', ...xlogLayers(eAc)), { quick: true }),
        show('clog'),
        pk('startup', 'clog', 'green', `${XA} 已提交`, ['01'], [ms(15), 'XACT', 'TransactionIdCommitTree', 1],
          wire('CLOG 的 2 位', 'mem', 'disk', clogBytes(clog, [XA]))),
        pk('wal', 'startup', 'violet', `INSERT ${XB}`, ['未提交也重放'], [ms(16), 'REDO', `${steps[2].action}：页 LSN ${lsnText(steps[2].lsnBefore!)} 小于记录结束位置`, eB.bytes.length],
          wire('这条记录没有镜像，只有元组内容', 'mem', 'disk', ...xlogLayers(eB)), { quick: true }),
        pk('wal', 'startup', 'violet', `INSERT ${XC}`, ['继续'], [ms(17), 'REDO', `${steps[3].action}，pd_lsn → ${lsnText(steps[3].lsnAfter!)}`, eC.bytes.length],
          wire('XC 的 INSERT', 'mem', 'disk', ...xlogLayers(eC)), { quick: true }),
        board('wal', walSpec('记录都已重放', [1, 2, 3], 4, true)),
        board('page', pageSpec(steps[3].page, `pd_lsn ${lsnText(steps[3].lsnAfter!)}，和崩溃前相同`, { [offB]: 'amber', [offC]: 'amber' })),
        board('ctrl', control([...ctrlBase, { k: '进度', v: lsnText(eC.end) }, { k: '和崩溃前比较', v: recoveredHex === beforeCrashHex ? '逐字节相同' : '不同', hot: 'green' }], '重放中')),
      ],
    },
    {
      title: 'LSN 决定跳过',
      desc: '页比记录新，就不用重放',
      detail: `每条不带镜像的记录都要比较：记录结束位置 ≤ 页的 pd_lsn，说明这次修改已经在页上了，返回 BLK_DONE，跳过。这让重放是幂等的。开着 full_page_writes 时，镜像会先覆盖页面，所以这个例子改成关闭它的情况：已经写到磁盘的第 1 条记录被跳过（${skip.action}），第 2 条要重放（${apply.action}）。`,
      facts: [['规则', 'lsn <= PageGetLSN(page) 则跳过'], ['第 1 条', skip.action], ['第 2 条', apply.action], ['函数', 'XLogReadBufferForRedoExtended']],
      events: [
        pk('wal', 'startup', 'violet', '比较 LSN', [lsnText(n1.end), `页 ${lsnText(flushedPage.lsn)}`], [ms(19), 'REDO', `另一种配置下的结果：${skip.action} 和 ${apply.action}`, null],
          wire('两个 LSN 比较', 'vals', 'internal', values('第 1 条记录', [['EndRecPtr', n1.end, '这条记录的结束位置。', { width: 8, shown: lsnText(n1.end), example: true }], ['PageGetLSN', flushedPage.lsn, '页已写到这里，修改已在页上。', { width: 8, shown: lsnText(flushedPage.lsn), example: true }]], 'violet'), values('第 2 条记录', [['EndRecPtr', n2.end, '比页 LSN 大，要重放。', { width: 8, shown: lsnText(n2.end), example: true }]], 'amber'))),
        board('ctrl', control([{ k: 'full_page_writes', v: 'off（对比演示）' }, { k: `记录 ${lsnText(n1.lsn)}`, v: skip.action, hot: 'slate' }, { k: `记录 ${lsnText(n2.lsn)}`, v: apply.action, hot: 'amber' }, { k: '页 LSN', v: lsnText(flushedPage.lsn) }], '幂等')),
      ],
    },
    {
      title: 'WAL 的尽头',
      desc: 'CRC 不对就停，未提交的行留在页上',
      detail: `读到最后一条：${stop.reason}。这里就是 WAL 的终点，不算错误。${XC} 的提交记录没写完，所以它没有提交。不需要 undo：${XB} 和 ${XC} 的元组留在页上，CLOG 里它们不是已提交，MVCC 判断时看不到，以后由 VACUUM 清理。恢复结束时写一个检查点，开始接受连接。`,
      facts: [['停在', lsnText(eCc.lsn)], ['原因', stop.reason], ['可见的行', seen.map((v, i) => (v.visible ? `行指针 ${i + 1}` : '')).filter(Boolean).join('、')], ['undo', '没有']],
      events: [
        pk('wal', 'startup', 'amber', 'CRC 不符', ['WAL 到此结束'], [ms(20), 'REDO', `ValidXLogRecord 失败：${stop.reason}`, eCc.bytes.length],
          wire('断电时只写了前 26 字节的提交记录。解码器复算 xl_crc 不一致', 'mem', 'disk', ...xlogLayers({ ...eCc, bytes: torn, parsed: diskEntries[4].parsed })), { lost: true }),
        board('wal', walSpec('恢复结束', [4], 5, true)),
        board('page', pageSpec(recovered, '和崩溃前相同。可见性由 CLOG 决定', { [offB]: 'red', [offC]: 'red' }, (lp) => (seen[lp - 1].visible ? '可见' : '不可见'))),
        board('ctrl', control([{ k: 'state', v: 'DB_IN_PRODUCTION', hot: 'green' }, { k: `${XA}`, v: '已提交（有提交记录）', hot: 'green' }, { k: `${XB}、${XC}`, v: '没有提交记录，等于回滚', hot: 'red' }, { k: 'undo', v: '没有：靠 MVCC 过滤' }], '恢复完成')),
        show('client'),
        pk('disk', 'client', 'green', '接受连接', [`${seen.filter((v) => v.visible).length} 行可见`], [ms(30), 'MSG', '恢复完成，新连接看到一致的数据', commandComplete('SELECT 2').length + readyForQuery().length],
          wire('新查询：提交过的 ann、bob 可见，cat、dan 不可见', 'mem', 'protocol', protocolMessage(commandComplete('SELECT 2')), protocolMessage(readyForQuery()))),
        note('client', `${seen.filter((v) => v.visible).length} 行可见`, 'green'),
      ],
    },
  ],
  outro: {
    title: 'Redo 就够了',
    desc: '版本信息在元组里，所以不需要 undo',
    text: '常见的 ARIES 协议有 redo 和 undo 两个阶段，用 undo 日志的数据库崩溃后要回滚未提交事务。PostgreSQL 的 MVCC 把旧版本留在堆上，未提交事务的修改天然不可见，所以只做 redo。代价是这些死元组要等 VACUUM。恢复时间取决于 redo 点之后的 WAL 量。',
    facts: [['起点', '最后一个检查点的 redo 点'], ['断页', '整页镜像'], ['回到开头', 'PARSE']],
  },
};

