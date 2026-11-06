import { describe, expect, it } from 'vitest';
import heapGolden from './golden/heap-page.json';
import btreeGolden from './golden/btree-pages.json';
import walGolden from './golden/wal-records.json';
import protocolGolden from './golden/protocol.json';
import { BTree } from '../src/engine/btree';
import { BufferPool } from '../src/engine/buffer';
import { fromHex, parseLsn, toHex } from '../src/engine/bytes';
import { Clog } from '../src/engine/mvcc';
import { Page, type Attr } from '../src/engine/page';
import { parseRecord, type WalEntry } from '../src/engine/wal';
import { BloomPolicy, enc, kTypeDeletion, lookupKey, MemTable, Table } from '../src/engine/lsm';
import { btMeta, btOpaque, bufferDesc, clogBytes, dataBlockLayers, filterBlockLayers, footerLayer, heapTuple, indexBlockLayers, indexTuple, lineArray, lockTagTransaction, logRecordLayers, lookupKeyLayer, memEntryLayers, metaindexBlockLayers, minimalTuple, pageHeader, protocolMessage, snapshotValues, tapeTuple, xlogLayers } from '../src/decode/structures';
import { decode, type LayerWriter } from '../src/decode/writer';
import leveldbGolden from './golden/leveldb.json';

const ACCOUNTS: Attr[] = [{ name: 'id', type: 'int4' }, { name: 'owner', type: 'text' }, { name: 'balance', type: 'int4' }];
const field = (layer: LayerWriter, name: string) => {
  const found = layer.fields.find((item) => item.name === name);
  if (!found) throw new Error(`没有字段 ${name}`);
  return found;
};
const bytesOf = (layer: LayerWriter, name: string) => {
  const f = field(layer, name);
  return layer.bytes.slice(f.from, f.to);
};

/** 真实页面：PostgreSQL 17 上 HOT 更新之后的 heap 页。pageinspect 的输出写在下面作为期望值。 */
const updated = new Page(8192, 0, fromHex(heapGolden.pages.updated));
const vacuumed = new Page(8192, 0, fromHex(heapGolden.pages.vacuumed));

describe('PageHeaderData：解码真实页面，和 page_header() 一致', () => {
  it('布局 24 字节，字段偏移符合 bufpage.h', () => {
    const layer = pageHeader(updated);
    expect(layer.length).toBe(24);
    const names = layer.fields.filter((f) => !f.depth).map((f) => [f.name, f.from, f.to]);
    expect(names).toEqual([
      ['pd_lsn', 0, 8], ['pd_checksum', 8, 10], ['pd_flags', 10, 12], ['pd_lower', 12, 14], ['pd_upper', 14, 16], ['pd_special', 16, 18], ['pd_pagesize_version', 18, 20], ['pd_prune_xid', 20, 24],
    ]);
  });

  it('HOT 更新后：lower 40，upper 8032，special 8192，prune_xid 747', () => {
    const layer = pageHeader(updated);
    expect(field(layer, 'pd_lower').value).toBe('40');
    expect(field(layer, 'pd_upper').value).toBe('8032');
    expect(field(layer, 'pd_special').value).toBe('8192');
    expect(field(layer, 'pd_prune_xid').value).toBe('747');
    expect(field(layer, '页大小').value).toBe('8192');
    expect(field(layer, '布局版本').value).toBe('4');
  });

  it('VACUUM 后 flags = 5：HAS_FREE_LINES | ALL_VISIBLE', () => {
    const layer = pageHeader(vacuumed);
    expect(field(layer, 'pd_flags').value).toBe('0x0005');
    expect(field(layer, 'PD_HAS_FREE_LINES 0x0001').value).toContain('1');
    expect(field(layer, 'PD_ALL_VISIBLE 0x0004').value).toContain('1');
    expect(field(layer, 'PD_PAGE_FULL 0x0002').value).toBe('0');
  });

  it('pd_lsn 按高 32 位、低 32 位显示，和 page_header().lsn 相同', () => {
    expect(field(pageHeader(vacuumed), 'pd_lsn').value).toBe('0/19E0520');
  });
});

describe('ItemIdData：4 字节位域，和 heap_page_items() 一致', () => {
  it('HOT 更新后四个行指针', () => {
    const layer = lineArray(updated);
    expect(layer.length).toBe(16);
    expect(field(layer, '行指针 1').from).toBe(0);
    const values = layer.fields.filter((f) => f.name.startsWith('lp_')).map((f) => f.value);
    expect(values).toEqual(['8152', '1 LP_NORMAL', '36', '8112', '1 LP_NORMAL', '36', '8072', '1 LP_NORMAL', '36', '8032', '1 LP_NORMAL', '36']);
  });

  it('VACUUM 后：重定向、未用、普通', () => {
    const layer = lineArray(vacuumed);
    const values = layer.fields.filter((f) => f.name.startsWith('lp_')).map((f) => f.value);
    expect(values).toEqual(['8152', '1 LP_NORMAL', '36', '4', '2 LP_REDIRECT', '0', '0', '0 LP_UNUSED', '0', '8112', '1 LP_NORMAL', '36']);
  });
});

describe('HeapTupleHeaderData：23 字节头和 infomask 位', () => {
  it('字段偏移符合 htup_details.h，t_hoff = 24', () => {
    const layer = heapTuple(updated, 2, ACCOUNTS);
    const top = layer.fields.filter((f) => !f.depth).map((f) => [f.name, f.from, f.to]);
    expect(top.slice(0, 7)).toEqual([['t_xmin', 0, 4], ['t_xmax', 4, 8], ['t_cid', 8, 12], ['t_ctid', 12, 18], ['t_infomask2', 18, 20], ['t_infomask', 20, 22], ['t_hoff', 22, 23]]);
    expect(field(layer, 't_hoff').value).toBe('24');
    expect(layer.addr).toBe(8112);
  });

  it('旧版本：xmax 747，ctid (0,4)，HOT_UPDATED，infomask2 16387，infomask 258', () => {
    const layer = heapTuple(updated, 2, ACCOUNTS);
    expect(field(layer, 't_xmin').value).toBe('745');
    expect(field(layer, 't_xmax').value).toBe('747');
    expect(field(layer, 't_ctid').value).toBe('(0,4)');
    expect(field(layer, 't_infomask2').value).toBe(`0x${(16387).toString(16)}`);
    expect(field(layer, 't_infomask').value).toBe('0x0102');
    expect(field(layer, 'HEAP_HOT_UPDATED 0x4000').value).toContain('1');
    expect(field(layer, 'HEAP_XMIN_COMMITTED 0x0100').value).toContain('1');
  });

  it('新版本：ONLY_TUPLE，UPDATED，列值可解回', () => {
    const layer = heapTuple(updated, 4, ACCOUNTS);
    expect(field(layer, 'HEAP_ONLY_TUPLE 0x8000').value).toContain('1');
    expect(field(layer, 'HEAP_UPDATED 0x2000').value).toContain('1');
    expect(field(layer, 'id').value).toBe('2');
    expect(field(layer, 'owner').value).toBe('bob');
    expect(field(layer, 'balance').value).toBe('150');
    expect(bytesOf(layer, 'owner')).toEqual([0x09, 0x62, 0x6f, 0x62]);
  });
});

describe('B 树页：解码真实索引页', () => {
  const pages = btreeGolden.sequential.pages.map((hex) => new Page(8192, 0, fromHex(hex)));

  it('BTPageOpaqueData 16 字节，和 bt_page_stats() 一致', () => {
    const layer = btOpaque(pages[1]);
    expect(layer.length).toBe(16);
    expect(layer.addr).toBe(8192 - 16);
    expect(field(layer, 'btpo_prev').value).toBe('0');
    expect(field(layer, 'btpo_next').value).toBe('2');
    expect(field(layer, 'btpo_level').value).toBe('0');
    expect(field(layer, 'btpo_flags').value).toBe('0x0001');
    expect(field(layer, 'BTP_LEAF 1<<0').value).toBe('1');
  });

  it('IndexTupleData：叶子项 t_tid (0,1)，长度 16；high key 带 INDEX_ALT_TID_MASK', () => {
    const high = indexTuple(pages[1], 1, 'high');
    expect(field(high, 't_info').value).toBe('0x2010');
    expect(field(high, 'INDEX_ALT_TID_MASK 0x2000').value).toContain('1');
    expect(field(high, '键 int4').value).toBe('367');
    const leaf = indexTuple(pages[1], 2, 'leaf');
    expect(field(leaf, 't_tid').value).toBe('(0,1)');
    expect(field(leaf, 't_info').value).toBe('0x0010');
    expect(field(leaf, '键 int4').value).toBe('1');
  });

  it('内部页第一项是负无穷：8 字节，没有键', () => {
    const inf = indexTuple(pages[3], 1, 'pivot');
    expect(field(inf, 't_tid').value).toBe('(1,0)');
    expect(field(inf, 'INDEX_SIZE_MASK 0x1FFF').value).toBe('8');
    expect(field(inf, '键').value).toBe('没有');
    expect(field(indexTuple(pages[3], 2, 'pivot'), '键 int4').value).toBe('367');
  });

  it('元页：magic 0x053162，version 4，root 3，level 1（bt_metap 实测）', () => {
    const tree = new BTree(8192);
    tree.pages[0] = pages[0];
    const layer = btMeta(tree);
    expect(field(layer, 'btm_magic').value).toBe('0x053162');
    expect(field(layer, 'btm_version').value).toBe('4');
    expect(field(layer, 'btm_root').value).toBe('3');
    expect(field(layer, 'btm_level').value).toBe('1');
    expect(layer.addr).toBe(24);
  });
});

describe('XLogRecord：解码真实 WAL 字节', () => {
  const entry = (i: number): WalEntry => {
    const rec = walGolden.records[i];
    const bytes = fromHex(rec.hex as string);
    return { lsn: parseLsn(rec.lsn), end: parseLsn(rec.end), prev: parseLsn(rec.prev), bytes, parsed: parseRecord(bytes), label: '' };
  };

  it('头部 24 字节，字段顺序符合 xlogrecord.h', () => {
    const [head] = xlogLayers(entry(2));
    expect(head.length).toBe(24);
    expect(head.fields.filter((f) => !f.depth).map((f) => [f.name, f.from, f.to])).toEqual([
      ['xl_tot_len', 0, 4], ['xl_xid', 4, 8], ['xl_prev', 8, 16], ['xl_info', 16, 17], ['xl_rmid', 17, 18], ['填充', 18, 20], ['xl_crc', 20, 24],
    ]);
    expect(field(head, 'xl_tot_len').value).toBe('67');
    expect(field(head, 'xl_prev').value).toBe(walGolden.records[2].prev);
    expect(field(head, 'xl_rmid').value).toBe('10 Heap');
    expect(field(head, 'xl_crc').note).toContain('一致');
  });

  it('每一层的地址就是它在记录里的真实偏移', () => {
    const layers = xlogLayers(entry(2));
    expect(layers.map((l) => [l.name, l.addr, l.length])).toEqual([['XLogRecord', 0, 24], ['块引用', 24, 20], ['XLogRecordDataHeaderShort', 44, 2], ['块数据', 46, 18], ['xl_heap_insert', 64, 3]]);
  });

  it('所有层拼起来就是原始记录', () => {
    for (let i = 0; i < walGolden.records.length; i++) {
      const frame = decode({ at: 'x', view: 'mem', fidelity: 'disk', layers: xlogLayers(entry(i)) });
      expect(toHex(frame.bytes as number[]), walGolden.records[i].type).toBe(walGolden.records[i].hex);
    }
  });

  it('INSERT 记录的主数据：offnum 3；块引用 rel 和 pg_walinspect 一致', () => {
    const layers = xlogLayers(entry(2));
    const block = layers.find((l) => l.name === '块引用')!;
    expect(field(block, 'RelFileLocator').value).toBe(walGolden.rel.join('/'));
    expect(field(block, 'BlockNumber').value).toBe('0');
    const main = layers.find((l) => l.name === 'xl_heap_insert')!;
    expect(field(main, 'offnum').value).toBe('3');
  });

  it('带整页镜像的记录：hole_offset 32，镜像 112 字节（pg_walinspect：hole offset 32 length 8080）', () => {
    const layers = xlogLayers(entry(0));
    const block = layers.find((l) => l.name === '块引用')!;
    expect(field(block, '镜像 hole_offset').value).toBe('32');
    expect(field(block, '镜像 length').value).toBe('112');
    expect(field(block, 'BKPBLOCK_HAS_IMAGE 0x10').value).toContain('1');
  });

  it('xl_page_magic 符合 REL_17：0xD116', () => {
    const header = fromHex(walGolden.firstPageHeader);
    expect(header[0] | (header[1] << 8)).toBe(0xd116);
  });
});

describe('CLOG', () => {
  it('2 位状态：真实文件里第 190 字节是 0x19', () => {
    const clog = new Clog();
    clog.set(760, 1);
    clog.set(761, 2);
    clog.set(762, 1);
    const layer = clogBytes(clog, [760, 762]);
    expect(layer.addr).toBe(190);
    expect(layer.bytes).toEqual([0x19]);
    expect(field(layer, 'xid 760 · 位 0–1').value).toBe('01 COMMITTED');
    expect(field(layer, 'xid 761 · 位 2–3').value).toBe('10 ABORTED');
    expect(field(layer, 'xid 763 · 位 6–7').value).toBe('00 IN_PROGRESS');
  });
});

describe('内存结构', () => {
  it('快照显示成 pg_current_snapshot 的写法', () => {
    const layer = snapshotValues({ xmin: 779, xmax: 781, xip: [779], curcid: 0 });
    expect(layer.summary).toContain('779:781:779');
    expect(layer.length).toBe(4 * 4);
  });

  it('BufferDesc：tag 20 字节，state 里 refcount 和 usage 的位置', () => {
    const pool = new BufferPool(1);
    pool.read({ spc: 1663, db: 5, rel: 16385, fork: 0, block: 7 });
    pool.read({ spc: 1663, db: 5, rel: 16385, fork: 0, block: 7 });
    const layer = bufferDesc(pool, 0);
    expect(layer.length).toBe(28);
    expect(field(layer, 'blockNum').from).toBe(16);
    expect(field(layer, 'state').from).toBe(24);
    expect(field(layer, 'refcount · 位 0–17').value).toBe('2');
    expect(field(layer, 'usage_count · 位 18–21').value).toBe('2');
  });

  it('LOCKTAG 16 字节，类型 5 是 LOCKTAG_TRANSACTION', () => {
    const layer = lockTagTransaction(788);
    expect(layer.length).toBe(16);
    expect(layer.bytes.slice(0, 4)).toEqual([0x14, 0x03, 0, 0]);
    expect(layer.bytes[14]).toBe(5);
    expect(layer.bytes[15]).toBe(1);
  });

  it('MinimalTuple：t_len 不含前面 8 字节，数据从第 16 字节开始', () => {
    const schema: Attr[] = [{ name: 'id', type: 'int4' }];
    const { layer, length } = minimalTuple(schema, [7]);
    expect(length).toBe(16 + 4);
    expect(layer.bytes.slice(0, 4)).toEqual([20, 0, 0, 0]);
    expect(field(layer, 't_infomask2').from).toBe(10);
    expect(field(layer, 't_hoff').from).toBe(14);
    expect(field(layer, '列数据').from).toBe(16);
  });

  it('磁带上的元组：tuplen = t_len - 10 + 4', () => {
    const schema: Attr[] = [{ name: 'id', type: 'int4' }];
    const layer = tapeTuple(schema, [7]);
    expect(layer.bytes.slice(0, 4)).toEqual([14, 0, 0, 0]);
    expect(layer.length).toBe(4 + (20 - 10));
  });
});

describe('前后端协议', () => {
  const g = protocolGolden as Record<string, string>;

  it('解码真实抓包：Query', () => {
    const bytes = fromHex(g['Q:SELECT id, balance FROM acct WHERE id = 1;']);
    const layer = protocolMessage(bytes);
    expect(field(layer, '类型').value).toBe("'Q'");
    expect(field(layer, '长度').value).toBe(String(bytes.length - 1));
    expect(field(layer, '查询字符串').value).toBe('SELECT id, balance FROM acct WHERE id = 1;');
    expect(layer.bytes).toEqual([...bytes]);
  });

  it('解码真实抓包：ErrorResponse 的 SQLSTATE', () => {
    const bytes = fromHex(g['SELECT nope FROM acct;']);
    const length = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) + 1;
    const layer = protocolMessage(bytes.subarray(0, length));
    expect(field(layer, 'C SQLSTATE').value).toBe('42703');
    expect(field(layer, 'R 函数名').value).toBe('errorMissingColumn');
  });
});

describe('writer', () => {
  it('多层字节拼接后，字段偏移换算到整体坐标', () => {
    const frame = decode({ at: 'x', view: 'mem', fidelity: 'disk', layers: [pageHeader(updated), lineArray(updated)] });
    expect(frame.bytes.length).toBe(24 + 16);
    const lp = frame.fields.find((f) => f.name === '行指针 1')!;
    expect(lp.from).toBe(24);
    expect(frame.layers[1].addr).toBe(24);
  });
});

describe('LevelDB：解码真实的 .log 和 .ldb 文件', () => {
  const log = fromHex(leveldbGolden.log);
  const file = fromHex(leveldbGolden.tables.l0Seq9to12);
  const table = new Table(file);
  const policy = new BloomPolicy(10);
  const all = (layers: LayerWriter[]) => decode({ at: 'x', view: 'mem', fidelity: 'leveldb', layers });

  it('日志记录：7 字节头（checksum、length、type）+ WriteBatch，CRC 复算一致', () => {
    const record = { offset: 0, bytes: log.subarray(0, 33), type: 1 };
    const [head, batch] = logRecordLayers(record);
    expect(head.fields.map((f) => [f.name, f.from, f.to])).toEqual([['checksum', 0, 4], ['length', 4, 6], ['type', 6, 7]]);
    expect(field(head, 'checksum').note).toContain('一致');
    expect(field(head, 'length').value).toBe('26');
    expect(field(head, 'type').value).toBe('1 kFullType');
    expect(batch.addr).toBe(7);
    expect(field(batch, 'sequence').value).toBe('9');
    expect(field(batch, '键').value).toBe('acct:ann');
    expect(field(batch, '值').value).toBe('120');
  });

  it('删除记录：WriteBatch 里只有类型 0 和键', () => {
    const [, batch] = logRecordLayers({ offset: 33, bytes: log.subarray(33, 62), type: 1 });
    expect(batch.addr).toBe(40);
    expect(field(batch, '类型').value).toBe(`${kTypeDeletion} kTypeDeletion`);
    expect(batch.fields.some((f) => f.name === '值')).toBe(false);
  });

  it('一个表的各层拼起来就是整个文件，地址就是文件偏移', () => {
    const layers = [
      ...dataBlockLayers(file, table.dataHandles()[0]),
      ...filterBlockLayers(file, table.filterHandle, policy, [{ key: 'acct:bob', inside: false }]),
      ...metaindexBlockLayers(file, table.footer.metaindex),
      ...indexBlockLayers(file, table.footer.index),
      footerLayer(file),
    ];
    expect(toHex(all(layers).bytes as number[])).toBe(leveldbGolden.tables.l0Seq9to12);
    let at = 0;
    for (const layer of layers) {
      expect(layer.addr, layer.name).toBe(at);
      at += layer.length;
    }
  });

  it('数据块：前缀压缩和重启点', () => {
    const [block, trailer] = dataBlockLayers(file, table.dataHandles()[0]);
    const shared = block.fields.filter((f) => f.name === 'shared').map((f) => f.value);
    expect(shared).toEqual(['0', '5', '0', '5']);
    expect(block.fields.filter((f) => f.name.startsWith('restarts')).map((f) => f.value)).toEqual(['0', '39']);
    expect(block.fields.find((f) => f.name === '类型 · 低 8 位' && f.value.startsWith('0'))).toBeTruthy();
    expect(field(trailer, 'crc').note).toContain('一致');
  });

  it('过滤块：bob 有探针落在 0 上；索引块的键是 "b" 加最大序列号；footer 48 字节', () => {
    const [filter] = filterBlockLayers(file, table.filterHandle, policy, [{ key: 'acct:bob', inside: false }]);
    expect(field(filter, 'acct:bob 的 6 个探针').value).toContain('=0');
    expect(field(filter, 'base_lg').value).toBe('11');
    const [index] = indexBlockLayers(file, table.footer.index);
    expect(field(index, 'key_delta').value).toBe('b');
    expect(field(index, '序列号 · 高 56 位').value).toContain('2^56');
    const footer = footerLayer(file);
    expect(footer.length).toBe(48);
    expect(field(footer, 'magic').value).toBe('0xdb4775248b80fb57');
    expect(footer.addr).toBe(file.length - 48);
  });

  it('MemTable 记录：varint 键长 + 内部键 + varint 值长 + 值；跳表节点的指针不展示', () => {
    const mem = new MemTable();
    const entry = mem.add(9, 1, enc('acct:ann'), enc('120'));
    const [record, node] = memEntryLayers(entry);
    expect(record.length).toBe(1 + 16 + 1 + 3);
    expect(field(record, 'internal_key_size').value).toBe('16');
    expect(field(record, '序列号 · 高 56 位').value).toBe('9');
    expect(node.length).toBe(8 + 8 * entry.height);
    expect(node.bytes.every((b) => b === null)).toBe(true);
    const lookup = lookupKeyLayer(lookupKey(enc('acct:bob'), 13));
    expect(lookup.length).toBe(17);
  });
});
