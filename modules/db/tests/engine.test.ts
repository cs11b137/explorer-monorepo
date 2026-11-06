import { describe, expect, it } from 'vitest';
import heapGolden from './golden/heap-page.json';
import btreeGolden from './golden/btree-pages.json';
import { BTree } from '../src/engine/btree';
import { fromHex, toHex } from '../src/engine/bytes';
import { crc32c } from '../src/engine/crc32c';
import { HeapPage, PD_ALL_VISIBLE, type Attr } from '../src/engine/page';
import walGolden from './golden/wal-records.json';
import protocolGolden from './golden/protocol.json';
import { BufferPool } from '../src/engine/buffer';
import { costBitmapScan, costIndexScan, costSeqScan, histogramSelectivity } from '../src/engine/cost';
import { externalSort, mergeOrder } from '../src/engine/extsort';
import { bucketAndBatch, chooseHashTableSize, hashInt4 } from '../src/engine/hashjoin';
import { findLockCycle, lockConflicts } from '../src/engine/locks';
import { commandComplete, dataRow, errorResponse, queryMessage, readyForQuery, rowDescription } from '../src/engine/protocol';
import { analyze, AnalyzeError, parseSelect, SqlSyntaxError, tokenize } from '../src/engine/sql';
import { Ssi } from '../src/engine/ssi';
import { commitRecord, endOfRecord, heapDeleteRecord, heapHotUpdateRecord, heapInsertRecord, parseRecord, redoOne, restoreImage, Wal, type RelLocator } from '../src/engine/wal';
import { Clog, getSnapshot, satisfiesMVCC, scanPage, TRANSACTION_STATUS_COMMITTED, xidInSnapshot } from '../src/engine/mvcc';
import leveldbGolden from './golden/leveldb.json';
import { BloomPolicy, buildTable, enc, getVarint, internalKey, kTypeDeletion, kTypeValue, LevelRandom, levelHash, LogWriter, LsmDb, maskCrc, parseFooter, parseInternalKey, shortestSeparator, shortSuccessor, str, Table, TABLE_MAGIC, unmaskCrc, varintBytes, batchRep } from '../src/engine/lsm';

const ACCOUNTS: Attr[] = [{ name: 'id', type: 'int4' }, { name: 'owner', type: 'text' }, { name: 'balance', type: 'int4' }];

/** 比较两页，失败时报出第一处不同。pd_lsn 来自 WAL 的真实位置，这里从真实页取。 */
function expectSamePage(actual: Uint8Array, expected: Uint8Array, name: string, ignore: Array<[number, number]> = []): void {
  const diffs: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    if (ignore.some(([a, b]) => i >= a && i < b)) continue;
    if (actual[i] !== expected[i]) {
      diffs.push(`@${i}: ${actual[i].toString(16)} != ${expected[i].toString(16)}`);
      if (diffs.length > 12) break;
    }
  }
  expect(diffs, name).toEqual([]);
}

describe('CRC-32C', () => {
  it('RFC 3720 的校验向量', () => {
    expect(crc32c([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0xe3069283);
    expect(crc32c(new Array(32).fill(0))).toBe(0x8a9136aa);
    expect(crc32c(new Array(32).fill(0xff))).toBe(0x62a8ab43);
  });
});

describe('堆页与 PostgreSQL 17 逐字节一致', () => {
  const pages = Object.fromEntries(Object.entries(heapGolden.pages).map(([k, v]) => [k, fromHex(v)])) as Record<string, Uint8Array>;
  const [x1, x2, x3] = heapGolden.xids;
  const LSN: Array<[number, number]> = [[0, 8]];

  it('全过程：插入、提示位、HOT 更新、删除、清理', () => {
    const heap = new HeapPage(ACCOUNTS);
    const clog = new Clog();
    heap.insert([1, 'ann', 100], x1);
    heap.insert([2, 'bob', 200], x2);
    heap.insert([3, 'cat', 300], x3);
    expectSamePage(heap.page.bytes, pages.inserted, '三次插入后', LSN);

    for (const x of [x1, x2, x3]) clog.set(x, TRANSACTION_STATUS_COMMITTED);
    scanPage(heap, getSnapshot([], x3), clog);
    expectSamePage(heap.page.bytes, pages.hinted, 'SELECT 写回提示位后', LSN);

    heap.hotUpdate(2, [2, 'bob', 150], heapGolden.updateXid);
    clog.set(heapGolden.updateXid, TRANSACTION_STATUS_COMMITTED);
    expectSamePage(heap.page.bytes, pages.updated, 'HOT 更新后', LSN);

    // DELETE 先顺序扫描找到目标行，途中也会给经过的元组写提示位。
    scanPage(heap, getSnapshot([], heapGolden.updateXid), clog);
    heap.delete(3, heapGolden.deleteXid);
    clog.set(heapGolden.deleteXid, TRANSACTION_STATUS_COMMITTED);
    expectSamePage(heap.page.bytes, pages.deleted, '删除后', LSN);

    scanPage(heap, getSnapshot([], heapGolden.deleteXid), clog);
    expectSamePage(heap.page.bytes, pages.rehinted, '第二次 SELECT 后', LSN);

    const { redirects, deadItems } = heap.prune((off) => off === 2 || off === 3);
    expect(redirects).toEqual([[2, 4]]);
    expect(deadItems).toEqual([3]);
    heap.reclaimDead(deadItems);
    heap.page.flags = heap.page.flags | PD_ALL_VISIBLE;
    expectSamePage(heap.page.bytes, pages.vacuumed, 'VACUUM 后', LSN);
  });
});

describe('B 树与 PostgreSQL 17 逐字节一致', () => {
  for (const name of ['sequential', 'random'] as const) {
    it(`${name}：每一页都相同（pd_lsn 除外）`, () => {
      const golden = btreeGolden[name];
      const tree = new BTree(8192);
      golden.keys.forEach((key, index) => tree.insert(key, golden.tids[index] as [number, number]));
      expect(tree.pages.length).toBe(golden.pages.length);
      golden.pages.forEach((hex, block) => expectSamePage(tree.pages[block].bytes, fromHex(hex), `${name} 第 ${block} 页`, [[0, 8]]));
    });
  }
});


describe('WAL 记录与 PostgreSQL 17 逐字节一致（含 xl_crc）', () => {
  const recs = walGolden.records;
  const rel = walGolden.rel as RelLocator;
  const lsn = (text: string) => { const [a, b] = text.split('/'); return (BigInt(`0x${a}`) << 32n) | BigInt(`0x${b}`); };
  const raw = (i: number) => fromHex(recs[i].hex as string);

  it('所有记录的 xl_crc 都能复算，xl_prev 串成链', () => {
    for (const rec of recs) {
      const parsed = parseRecord(fromHex(rec.hex as string));
      expect(parsed.crcOk, rec.lsn).toBe(true);
      expect(parsed.totLen).toBe(rec.len);
      expect(parsed.prev).toBe(lsn(rec.prev));
      expect(parsed.xid).toBe(rec.xid);
      expect(endOfRecord(lsn(rec.lsn), rec.len)).toBe(lsn(rec.end));
    }
  });

  it('带整页镜像的 INSERT、普通 INSERT、HOT UPDATE、DELETE、COMMIT 都能重新编码出同样的字节', () => {
    const fpi = parseRecord(raw(0));
    const page = restoreImage(fpi.block!.image!);
    expect(toHex(heapInsertRecord(lsn(recs[0].prev), recs[0].xid, rel, 0, page, 2, true))).toBe(recs[0].hex);
    const commit = parseRecord(raw(1));
    expect(toHex(commitRecord(lsn(recs[1].prev), recs[1].xid, commit.main.reduce((sum, b, i) => sum + (BigInt(b) << BigInt(i * 8)), 0n)))).toBe(recs[1].hex);

    // 用重放得到页面，再从页面重新编码：编码器和重放器互相验证。
    const entry = (i: number) => ({ lsn: lsn(recs[i].lsn), end: lsn(recs[i].end), prev: lsn(recs[i].prev), bytes: raw(i), parsed: parseRecord(raw(i)), label: '' });
    let current = redoOne(entry(0), page, 3).page;
    expect(current.maxOffset).toBe(2);
    current = redoOne(entry(2), current, 3).page;
    expect(toHex(heapInsertRecord(lsn(recs[2].prev), recs[2].xid, rel, 0, current, 3))).toBe(recs[2].hex);
    current = redoOne(entry(4), current, 3).page;
    expect(toHex(heapHotUpdateRecord(lsn(recs[4].prev), recs[4].xid, rel, 0, current, 2, 4))).toBe(recs[4].hex);
    current = redoOne(entry(6), current, 3).page;
    expect(toHex(heapDeleteRecord(lsn(recs[6].prev), recs[6].xid, rel, 0, 3))).toBe(recs[6].hex);
    // 重放时页 LSN 已经够新，要跳过。
    expect(redoOne(entry(6), current, 3).action).toBe('BLK_DONE');
    expect(current.lsn).toBe(lsn(recs[6].end));
  });

  it('改动任意一个字节，CRC 都能发现', () => {
    for (let at = 0; at < raw(2).length; at++) {
      if (at >= 20 && at < 24) continue;
      const bad = raw(2);
      bad[at] ^= 0x01;
      if (at < 4) continue; // 长度被改时读取范围也变了，由 xl_tot_len 检查负责
      expect(parseRecord(bad).crcOk, `第 ${at} 字节`).toBe(false);
    }
  });

  it('Wal 指针：下一条记录从 MAXALIGN 后的位置开始，跨页时跳过 24 字节页头', () => {
    const wal = new Wal(lsn(recs[2].lsn), lsn(recs[1].lsn));
    const a = wal.append(raw(2), 'a');
    expect(a.end).toBe(lsn(recs[2].end));
    expect(wal.insert).toBe(lsn(recs[3].lsn));
    expect(endOfRecord(8192n * 3n - 16n, 40)).toBe(8192n * 3n + 24n + 24n);
    expect(endOfRecord(8192n - 16n, 16)).toBe(8192n + 24n);
  });

  it('真实 CLOG：xid 760/761/762 落在第 190 字节，值 0x19', () => {
    const clog = new Clog();
    clog.set(760, 1);
    clog.set(761, 2);
    clog.set(762, 1);
    expect(clog.byteOf(760)).toBe(190);
    expect(clog.bytes[190]).toBe(0x19);
    expect(clog.get(761)).toBe(2);
  });
});

describe('前后端协议与真实抓包一致', () => {
  const sql = 'SELECT id, balance FROM acct WHERE id = 1;';
  const g = protocolGolden as Record<string, string>;

  it('Query 消息', () => {
    expect(toHex(queryMessage(sql))).toBe(g[`Q:${sql}`]);
  });

  it('RowDescription + DataRow + CommandComplete + ReadyForQuery', () => {
    const fields = [{ name: 'id', tableOid: 16517, attnum: 1, typeOid: 23, typlen: 4 }, { name: 'balance', tableOid: 16517, attnum: 2, typeOid: 23, typlen: 4 }];
    const all = [rowDescription(fields), dataRow(['1', '100']), commandComplete('SELECT 1'), readyForQuery()].map(toHex).join('');
    expect(all).toBe(g[sql]);
  });

  it('ErrorResponse：列不存在是 42703，语法错误是 42601', () => {
    const missing = errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '42703'], ['M', 'column "nope" does not exist'], ['P', '8'], ['F', 'parse_relation.c'], ['L', '3721'], ['R', 'errorMissingColumn']]);
    expect(toHex(missing) + toHex(readyForQuery())).toBe(g['SELECT nope FROM acct;']);
    const syntax = errorResponse([['S', 'ERROR'], ['V', 'ERROR'], ['C', '42601'], ['M', 'syntax error at or near "SELEC"'], ['P', '1'], ['F', 'scan.l'], ['L', '1248'], ['R', 'scanner_yyerror']]);
    expect(toHex(syntax) + toHex(readyForQuery())).toBe(g['SELEC id FROM acct;']);
  });
});

describe('解析', () => {
  const tables = [{ name: 'acct', oid: 16517, columns: [{ name: 'id', attnum: 1, typid: 23, typname: 'int4' }, { name: 'balance', attnum: 2, typid: 23, typname: 'int4' }] }];
  const ops = { 'int4 = int4': { opno: 96, opfuncid: 65, resulttype: 16 } };

  it('关键字不区分大小写，标识符折叠成小写', () => {
    const t = tokenize('SeLeCt ID from Acct');
    expect(t.map((x) => x.token)).toEqual(['SELECT', 'IDENT', 'FROM', 'IDENT']);
    expect(t[1].text).toBe('id');
  });

  it('语义分析得到的值和 debug_print_parse 一致：opno 96，opfuncid 65，Var(1,1,23)', () => {
    const parsed = parseSelect(tokenize('SELECT id, balance FROM acct WHERE id = 42;'));
    const { op, vars, rel } = analyze(parsed, tables, ops);
    expect(op).toEqual({ opno: 96, opfuncid: 65, resulttype: 16 });
    expect(vars.map((v) => v.column.attnum)).toEqual([1, 2]);
    expect(rel.oid).toBe(16517);
  });

  it('错误分层：写错关键字是语法错误，列名不存在是语义错误', () => {
    expect(() => parseSelect(tokenize('SELEC id FROM acct;'))).toThrow(SqlSyntaxError);
    const parsed = parseSelect(tokenize('SELECT nope FROM acct WHERE id = 1'));
    try {
      analyze(parsed, tables, ops);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyzeError);
      expect((error as AnalyzeError).code).toBe('42703');
    }
  });
});

describe('代价估算与 EXPLAIN 的真实输出一致', () => {
  // 真实表：20000 行，relpages 128；两个索引都是 57 页、level 1。数值来自 pg_class / pg_stats / bt_metap。
  const rel = { name: 'orders', pages: 128, tuples: 20000 };
  const idIndex = { name: 'orders_id', pages: 57, tuples: 20000, treeHeight: 1, correlation: 1 };
  const amountIndex = { name: 'orders_amount', pages: 57, tuples: 20000, treeHeight: 1, correlation: -0.0007359975 };
  const idBounds = [1, ...Array.from({ length: 99 }, (_, i) => (i + 1) * 200), 20000];
  const amountBounds = [0, ...Array.from({ length: 99 }, (_, i) => (i + 1) * 200 - 1), 19999];
  const round2 = (v: number) => Math.round(v * 100) / 100;

  it('默认参数', async () => {
    const c = await import('../src/engine/cost');
    expect([c.seq_page_cost, c.random_page_cost, c.cpu_tuple_cost, c.cpu_index_tuple_cost, c.cpu_operator_cost]).toEqual([1, 4, 0.01, 0.005, 0.0025]);
  });

  it('顺序扫描 cost=0.00..378.00', () => {
    expect(costSeqScan(rel, 0.5).total).toBe(378);
  });

  it.each([
    [100, 99, 10.02],
    [4000, 3999, 147.27],
    [16000, 15999, 570.27],
  ])('id < %i：rows=%i，索引扫描 %f', (value, rows, cost) => {
    const s = histogramSelectivity(idBounds, value, 1 / 20000);
    const path = costIndexScan(rel, idIndex, s);
    expect(path.rows).toBe(rows);
    expect(round2(path.total)).toBe(cost);
    expect(round2(path.startup)).toBe(0.29);
  });

  it.each([
    [100, 100, 294.04],
    [1000, 1000, 541.79],
    [4000, 4000, 630.29],
    [16000, 16000, 976.29],
  ])('amount < %i：rows=%i，索引扫描 %f（相关性约等于 0）', (value, rows, cost) => {
    const s = histogramSelectivity(amountBounds, value, 1 / 20000);
    const path = costIndexScan(rel, amountIndex, s);
    expect(path.rows).toBe(rows);
    expect(round2(path.total)).toBe(cost);
  });

  it.each([
    [100, 5.06, 132.31],
    [1000, 20.04, 160.54],
    [4000, 79.29, 257.29],
  ])('amount < %i：位图扫描 %f..%f', (value, startup, total) => {
    const path = costBitmapScan(rel, amountIndex, histogramSelectivity(amountBounds, value, 1 / 20000));
    expect(round2(path.startup)).toBe(startup);
    expect(round2(path.total)).toBe(total);
  });

  it('id = 42 的等值查询：cost=0.29..8.30', () => {
    const path = costIndexScan(rel, idIndex, 1 / 20000);
    expect(round2(path.startup)).toBe(0.29);
    expect(path.total).toBeCloseTo(8.305, 3);
  });
});

describe('哈希', () => {
  it.each([[1, -1905060026], [2, 1134484726], [3, -28094569], [42, 1509752520], [100, 108199381], [-1, 385747274], [1000000, -723906379]])('hashint4(%i) = %i（来自 SELECT hashint4）', (k, expected) => {
    expect(hashInt4(k) | 0).toBe(expected);
  });

  it('桶号用低位，批号用桶号上面的位', () => {
    const hash = 0b1011_0110_1010;
    expect(bucketAndBatch(hash, 16, 4)).toEqual({ bucket: 0b1010, batch: 0b10 });
    expect(bucketAndBatch(hash, 16, 1).batch).toBe(0);
  });

  it('ExecChooseHashTableSize：work_mem=64kB，20000 行，宽度 19，得到 1024 桶 32 批（EXPLAIN ANALYZE 实测）', () => {
    const { nbuckets, nbatch } = chooseHashTableSize(20000, 19, 64 * 1024);
    expect(nbuckets).toBe(1024);
    expect(nbatch).toBe(32);
  });
});

describe('外部排序', () => {
  it('tuplesort_merge_order：64 kB 是 6 条磁带（trace_sort 实测），4 MB 是 15 条', () => {
    expect(mergeOrder(64 * 1024)).toBe(6);
    expect(mergeOrder(4 * 1024 * 1024)).toBe(15);
  });

  it('结果和直接排序一样，归并段长度等于内存容量', () => {
    const input = [9, 3, 7, 1, 8, 2, 6, 4, 5, 0, 12, 11, 10];
    const log = externalSort(input, 4, 3);
    expect(log.output).toEqual([...input].sort((a, b) => a - b));
    expect(log.runs.map((run) => run.length)).toEqual([4, 4, 4, 1]);
    expect(log.runTape).toEqual([0, 1, 2, 0]);
  });

  it('归并段比磁带多时要多归并一趟，和手算一致', () => {
    const log = externalSort(Array.from({ length: 20 }, (_, i) => 20 - i), 2, 3);
    // 10 段写 3 条磁带 → 第一趟合成 4 段 → 第二趟 2 段 → 最后一趟输出。
    expect(log.runs.length).toBe(10);
    expect(log.passes.length).toBe(3);
    expect(log.passes[0].merges.map((m) => m.output.length)).toEqual([6, 6, 6, 2]);
    expect(log.passes.at(-1)!.final).toBe(true);
  });
});

describe('时钟扫描', () => {
  const tag = (block: number) => ({ spc: 1663, db: 1, rel: 16385, fork: 0, block });

  it('手算：3 帧，usage 各为 2/1/1，指针要转到 usage 都减到 0', () => {
    const pool = new BufferPool(3);
    for (const b of [0, 1, 2]) pool.unpin(pool.read(tag(b)).frame);
    pool.unpin(pool.read(tag(0)).frame); // 命中，frame 0 的 usage = 2
    expect(pool.frames.map((f) => f.usage)).toEqual([2, 1, 1]);
    const log = pool.read(tag(9));
    expect(log.sweep.map((s) => `${s.frame}:${s.action}`)).toEqual(['0:dec', '1:dec', '2:dec', '0:dec', '1:take']);
    expect(log.frame).toBe(1);
    expect(pool.frames.map((f) => f.usage)).toEqual([0, 1, 0]);
    expect(pool.hand).toBe(2);
  });

  it('被钉住的帧跳过；usage_count 封顶 5；全都钉住时报错', () => {
    const pool = new BufferPool(2);
    const a = pool.read(tag(0)).frame;
    for (let i = 0; i < 9; i++) pool.read(tag(0));
    expect(pool.frames[a].usage).toBe(5);
    const b = pool.read(tag(1));
    expect(b.frame).not.toBe(a);
    expect(() => pool.read(tag(2))).toThrow('no unpinned buffers available');
  });

  it('state 字：refcount 低 18 位，usage 接下来 4 位，脏位是第 23 位', () => {
    const pool = new BufferPool(1);
    pool.read(tag(0));
    pool.markDirty(0, 100n);
    const state = pool.stateWord(0);
    expect(state & 0x3ffff).toBe(1);
    expect((state >>> 18) & 0xf).toBe(1);
    expect((state >>> 23) & 1).toBe(1);
  });
});

describe('MVCC（独立手写的向量）', () => {
  const schema: Attr[] = [{ name: 'id', type: 'int4' }];
  function table() {
    const heap = new HeapPage(schema);
    const clog = new Clog();
    return { heap, clog };
  }

  it('xmin 未提交、在快照里、已提交的三种情况', () => {
    const { heap, clog } = table();
    const off = heap.insert([1], 100);
    expect(satisfiesMVCC(heap.tuple(off), { xmin: 100, xmax: 101, xip: [100], curcid: 0 }, clog).visible).toBe(false);
    clog.set(100, TRANSACTION_STATUS_COMMITTED);
    expect(satisfiesMVCC(heap.tuple(off), { xmin: 100, xmax: 101, xip: [100], curcid: 0 }, clog).visible).toBe(false);
    expect(satisfiesMVCC(heap.tuple(off), { xmin: 101, xmax: 101, xip: [], curcid: 0 }, clog).visible).toBe(true);
    expect(satisfiesMVCC(heap.tuple(off), { xmin: 99, xmax: 100, xip: [], curcid: 0 }, clog).visible).toBe(false);
  });

  it('回滚的 xmin 不可见，回滚的 xmax 不影响可见性', () => {
    const { heap, clog } = table();
    const a = heap.insert([1], 100);
    clog.set(100, 2);
    expect(satisfiesMVCC(heap.tuple(a), { xmin: 101, xmax: 101, xip: [], curcid: 0 }, clog).visible).toBe(false);
    const b = heap.insert([2], 101);
    clog.set(101, 1);
    heap.delete(b, 102);
    clog.set(102, 2);
    expect(satisfiesMVCC(heap.tuple(b), { xmin: 103, xmax: 103, xip: [], curcid: 0 }, clog).visible).toBe(true);
  });

  it('自己的修改：cid 决定当前命令能否看到', () => {
    const { heap, clog } = table();
    const a = heap.insert([1], 100, undefined, 0);
    expect(satisfiesMVCC(heap.tuple(a), { xmin: 100, xmax: 100, xip: [], curcid: 0 }, clog, 100).visible).toBe(false);
    expect(satisfiesMVCC(heap.tuple(a), { xmin: 100, xmax: 100, xip: [], curcid: 1 }, clog, 100).visible).toBe(true);
  });

  it('GetSnapshotData：和 pg_current_snapshot() 实测一致', () => {
    // 实测：779 在运行，780 已结束 → 779:781:779；没有其他事务时 778:778:。
    expect(getSnapshot([779], 780)).toEqual({ xmin: 779, xmax: 781, xip: [779], curcid: 0 });
    expect(getSnapshot([], 777)).toEqual({ xmin: 778, xmax: 778, xip: [], curcid: 0 });
  });

  it('XidInMVCCSnapshot 的边界', () => {
    const s = { xmin: 10, xmax: 20, xip: [12], curcid: 0 };
    expect(xidInSnapshot(9, s)).toBe(false);
    expect(xidInSnapshot(10, s)).toBe(false);
    expect(xidInSnapshot(12, s)).toBe(true);
    expect(xidInSnapshot(19, s)).toBe(false);
    expect(xidInSnapshot(20, s)).toBe(true);
  });
});

describe('锁和死锁', () => {
  it('LockConflicts：AccessShare 只和 AccessExclusive 冲突；RowExclusive 彼此不冲突', () => {
    expect(lockConflicts('AccessShare', 'AccessExclusive')).toBe(true);
    expect(lockConflicts('AccessShare', 'Exclusive')).toBe(false);
    expect(lockConflicts('RowExclusive', 'RowExclusive')).toBe(false);
    expect(lockConflicts('ShareUpdateExclusive', 'ShareUpdateExclusive')).toBe(true);
  });

  it('只有回到发起者才算死锁', () => {
    const cyc = new Map([[1, [2]], [2, [3]], [3, [1]]]);
    expect(findLockCycle(1, cyc).cycle).toEqual([1, 2, 3]);
    const tail = new Map([[4, [1]], [1, [2]], [2, [1]]]);
    expect(findLockCycle(4, tail).cycle).toBeNull();
    expect(findLockCycle(1, tail).cycle).toEqual([1, 2]);
    expect(findLockCycle(1, new Map([[1, [2]]])).cycle).toBeNull();
  });
});

describe('SSI', () => {
  it('写偏斜：先提交的成功，后提交的报 pivot（和真实运行一致）', () => {
    const ssi = new Ssi();
    ssi.begin(1, 'A');
    ssi.begin(2, 'B');
    ssi.read(1, 'oncall');
    ssi.read(2, 'oncall');
    const overlaps = () => true;
    expect(ssi.write(1, 'oncall/ann', overlaps)).toEqual([{ reader: 2, writer: 1 }]);
    expect(ssi.write(2, 'oncall/bob', overlaps)).toEqual([{ reader: 1, writer: 2 }]);
    expect(ssi.commit(1)).toMatchObject({ ok: true, doomed: [2] });
    expect(ssi.commit(2).ok).toBe(false);
    expect(ssi.commit(2).reason).toContain('pivot');
  });

  it('只有单向依赖时都能提交', () => {
    const ssi = new Ssi();
    ssi.begin(1, 'A');
    ssi.begin(2, 'B');
    ssi.read(1, 'r');
    ssi.write(2, 'r');
    expect(ssi.commit(2).ok).toBe(true);
    expect(ssi.commit(1).ok).toBe(true);
  });
});

describe('LSM：和 LevelDB 1.23 写出的文件逐字节一致', () => {
  const g = leveldbGolden;
  const OPTIONS = { blockSize: 4096, restartInterval: 2, bitsPerKey: 10, memEntries: 4, l0Trigger: 2 };
  const rows = (list: Array<[number, number, string, string]>) => list.map(([seq, type, key, value]) => ({ seq, type, key, value }));
  const SEQ1TO4 = rows([[1, kTypeValue, 'acct:ann', '100'], [2, kTypeValue, 'acct:bob', '200'], [3, kTypeValue, 'acct:cat', '300'], [4, kTypeValue, 'acct:dan', '400']]);
  const SEQ5TO8 = rows([[5, kTypeValue, 'acct:cat', '310'], [6, kTypeValue, 'acct:eve', '500'], [7, kTypeValue, 'acct:gus', '700'], [8, kTypeValue, 'acct:hal', '800']]);

  /** 和生成程序相同的状态：L1 有序列号 1–4，L0 有 5–8，日志 12 是新的。 */
  function scenario(): LsmDb {
    const db = new LsmDb(OPTIONS, 12);
    db.install(1, 9, SEQ1TO4);
    db.install(0, 11, SEQ5TO8);
    return db;
  }

  it('Hash：LevelDB hash_test.cc 的向量，包括高位字节（有符号 char 的老问题）', () => {
    const seed = 0xbc9f1d34;
    expect(levelHash([], seed)).toBe(0xbc9f1d34);
    expect(levelHash([0x62], seed)).toBe(0xef1345c4);
    expect(levelHash([0xc3, 0x97], seed)).toBe(0x5b663814);
    expect(levelHash([0xe2, 0x99, 0xa5], seed)).toBe(0x323c078f);
    expect(levelHash([0xe1, 0x80, 0xb9, 0x32], seed)).toBe(0xed21633a);
    const data5 = [0x01, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x14, 0, 0, 0, 0, 0, 0x04, 0, 0, 0, 0, 0x14, 0, 0, 0, 0x18, 0x28, 0, 0, 0, 0, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0];
    expect(levelHash(data5, 0x12345678)).toBe(0xf333dabb);
    for (const [key, h] of Object.entries(g.bloomHash)) expect(levelHash(enc(key), seed), key).toBe(h);
  });

  it('varint：每字节 7 位，低位在前，最高位表示后面还有', () => {
    expect(varintBytes(0)).toEqual([0]);
    expect(varintBytes(127)).toEqual([0x7f]);
    expect(varintBytes(128)).toEqual([0x80, 0x01]);
    expect(varintBytes(300)).toEqual([0xac, 0x02]);
    expect(getVarint([0xac, 0x02], 0)).toEqual({ value: 300, next: 2 });
  });

  it('CRC 掩码可以还原', () => {
    for (const crc of [0, 1, 0xe3069283, 0xffffffff]) expect(unmaskCrc(maskCrc(crc))).toBe(crc);
  });

  it('跳表高度：Random(0xdeadbeef) 的前 24 次和真实 SkipList 一致', () => {
    const rnd = new LevelRandom(0xdeadbeef);
    const heights = g.skiplistHeights.map(() => {
      let h = 1;
      while (h < 12 && rnd.next() % 4 === 0) h++;
      return h;
    });
    expect(heights).toEqual(g.skiplistHeights);
  });

  it('日志：4 次写入就是 000012.log 的全部字节（含掩码 CRC）', () => {
    const db = scenario();
    db.put('acct:ann', '120');
    db.delete('acct:dan');
    db.put('acct:fay', '600');
    db.put('acct:cat', '330');
    expect(db.log.number).toBe(g.fileNumbers.log);
    expect(toHex(db.log.bytes)).toBe(g.log);
  });

  it('长记录跨 32 KiB 块时切成 FIRST / MIDDLE / LAST', () => {
    const log = new LogWriter(1);
    const parts = log.addRecord(new Uint8Array(70000));
    expect(parts.map((p) => p.type)).toEqual([2, 3, 4]);
    expect(parts[1].offset).toBe(32768);
  });

  it('SSTable：课程开始前的 L1、L0 文件，刷盘得到的文件，合并得到的文件', () => {
    const db = scenario();
    expect(toHex(db.levels[1][0].table.bytes)).toBe(g.tables.l1Seq1to4);
    expect(toHex(db.levels[0][0].table.bytes)).toBe(g.tables.l0Seq5to8);
    db.put('acct:ann', '120');
    db.delete('acct:dan');
    db.put('acct:fay', '600');
    db.put('acct:cat', '330');
    const w = db.put('acct:ivy', '900');
    expect(w.switched).toEqual({ frozenLog: 12, newLog: 13 });
    const flushed = db.flush();
    expect(flushed.file.number).toBe(g.fileNumbers.l0Seq9to12);
    expect(flushed.file.level).toBe(0);
    expect(toHex(flushed.file.table.bytes)).toBe(g.tables.l0Seq9to12);
    expect(db.needsCompaction()).toBe(true);
    const c = db.compact();
    expect(c.outputs.length).toBe(1);
    expect(toHex(c.outputs[0].table.bytes)).toBe(g.tables.compacted);
    expect(c.deleted.map(([, n]) => n).sort((a, b) => a - b)).toEqual([9, 11, 14]);
    expect(g.levelsAfterCompaction).toContain("'acct:ann' @ 9 : 1 .. 'acct:hal' @ 8 : 1");
  });

  it('合并：同一个键只留最新版本，墓碑在最底层被丢掉', () => {
    const db = scenario();
    db.put('acct:ann', '120');
    db.delete('acct:dan');
    db.put('acct:fay', '600');
    db.put('acct:cat', '330');
    db.put('acct:ivy', '900');
    db.flush();
    const c = db.compact();
    const text = c.rows.map((r) => { const k = parseInternalKey(r.ikey); return `${str(k.user).slice(5)}@${k.seq}:${r.drop ?? 'keep'}`; });
    expect(text).toEqual(['ann@9:keep', 'ann@1:shadowed', 'bob@2:keep', 'cat@12:keep', 'cat@5:shadowed', 'cat@3:shadowed', 'dan@10:tombstone', 'dan@4:shadowed', 'eve@6:keep', 'fay@11:keep', 'gus@7:keep', 'hal@8:keep']);
  });

  it('读路径：和真实 Get 结果一致；bob 被 L0 的布隆过滤器挡掉，dan 碰到墓碑就停', () => {
    const db = scenario();
    db.put('acct:ann', '120');
    db.delete('acct:dan');
    db.put('acct:fay', '600');
    db.put('acct:cat', '330');
    db.put('acct:ivy', '900');
    db.flush();
    const bob = db.get('acct:bob');
    expect(str(bob.value!)).toBe(g.get['acct:bob']);
    expect(bob.steps.map((s) => `${s.where}:${s.result}`)).toEqual(['MemTable:miss', 'L0 #14:filter', 'L0 #11:range', 'L1 #9:found']);
    const dan = db.get('acct:dan');
    expect(dan.value).toBeNull();
    expect(g.get['acct:dan']).toContain('NotFound');
    expect(dan.steps.map((s) => `${s.where}:${s.result}`)).toEqual(['MemTable:miss', 'L0 #14:deleted']);
  });

  it('布隆过滤器：放进去的键一定命中；k = 10 × 0.69 取整 = 6', () => {
    const policy = new BloomPolicy(10);
    expect(policy.k).toBe(6);
    const keys = ['hello', 'world', 'acct:ann', 'acct:fay'].map(enc);
    const filter = policy.create(keys);
    expect(filter.length).toBe(9);
    for (const key of keys) expect(policy.mayMatch(key, filter)).toBe(true);
  });

  it('分隔键和后继：能缩短才缩短，并配上最大序列号', () => {
    const k = (user: string, seq: number) => internalKey(enc(user), seq, kTypeValue);
    expect(str(shortestSeparator(k('acct:dan', 10), k('acct:fay', 11)).subarray(0, 6))).toBe('acct:e');
    expect(shortestSeparator(k('acct:cat', 3), k('acct:dan', 4))).toEqual(k('acct:cat', 3));
    const succ = shortSuccessor(k('acct:fay', 11));
    expect(str(succ.subarray(0, 1))).toBe('b');
    expect(parseInternalKey(succ).seq).toBe((1n << 56n) - 1n);
  });

  it('footer：48 字节，magic 0xdb4775248b80fb57；独立写表也得到同样字节', () => {
    const table = new Table(fromHex(g.tables.l0Seq9to12));
    const footer = parseFooter(table.bytes);
    expect(footer.magic).toBe(TABLE_MAGIC);
    expect(toHex(table.bytes.subarray(table.bytes.length - 8))).toBe('57fb808b247547db');
    expect(footer.index.offset + footer.index.size + 5).toBe(table.bytes.length - 48);
    const entries = table.entries().map((e) => ({ ikey: e.key, value: e.value }));
    expect(toHex(buildTable(entries, OPTIONS).bytes)).toBe(g.tables.l0Seq9to12);
    expect(entries.map((e) => parseInternalKey(e.ikey).type)).toEqual([kTypeValue, kTypeValue, kTypeDeletion, kTypeValue]);
  });

  it('WriteBatch：8 字节序列号 + 4 字节条数 + 类型、键、值', () => {
    const rep = batchRep(9, [{ type: kTypeValue, key: enc('acct:ann'), value: enc('120') }]);
    expect(toHex(rep)).toBe('0900000000000000010000000108616363743a616e6e03313230');
  });
});
