import { rd16, rd32, lsnText } from '../engine/bytes';
import { BTP_LEAF, BTP_META, BTP_ROOT, INDEX_ALT_TID_MASK, INDEX_SIZE_MASK, readOpaque, type BTree } from '../engine/btree';
import { BM_DIRTY, BM_VALID, BUF_USAGECOUNT_SHIFT, type BufferPool, type BufTag } from '../engine/buffer';
import type { Clog, Snapshot } from '../engine/mvcc';
import { STATUS_NAMES } from '../engine/mvcc';
import { deformTuple, HEAP_HASVARWIDTH, HEAP_HOT_UPDATED, HEAP_KEYS_UPDATED, HEAP_NATTS_MASK, HEAP_ONLY_TUPLE, HEAP_UPDATED, HEAP_XMAX_COMMITTED, HEAP_XMAX_INVALID, HEAP_XMIN_COMMITTED, HEAP_XMIN_INVALID, LP_NAMES, PD_ALL_VISIBLE, PD_HAS_FREE_LINES, PD_PAGE_FULL, fillTuple, type Attr, type Page, type Value } from '../engine/page';
import { BKPBLOCK_HAS_DATA, BKPBLOCK_HAS_IMAGE, parseRecord, RM_HEAP_ID, RM_XACT_ID, RMGR_NAMES, XLOG_HEAP_DELETE, XLOG_HEAP_HOT_UPDATE, XLOG_HEAP_INSERT, type WalEntry } from '../engine/wal';
import { blockTrailer, decodeHandle, enc, FOOTER_SIZE, getFixed32, getFixed64, getVarint, HANDLE_MAX, kMaxSequenceNumber, kTypeDeletion, kTypeValue, LOG_HEADER_SIZE, LOG_TYPE_NAMES, logRecordCrc, parseBlock, parseFilterBlock, parseFooter, parseInternalKey, varintBytes, type BlockEntry, type BlockHandle, type BloomPolicy, type LogRecord, type MemEntry } from '../engine/lsm';
import type { Color } from '../lessons/types';
import { hex, LayerWriter, type Fidelity, type FieldOptions, type Wire } from './writer';

export const wire = (at: string, view: Wire['view'], fidelity: Fidelity, ...layers: LayerWriter[]): Wire => ({ at, view, fidelity, layers });

let serial = 0;
const makeLayer = (name: string, color: Color, summary = '', addr = 0) => new LayerWriter(`l${serial++}`, name, color, summary, addr);

const hx = (v: number, width = 4): string => `0x${(v >>> 0).toString(16).padStart(width, '0')}`;

/** 概念结构：只有字段，没有字节。 */
export function concept(name: string, fields: Array<[string, string, string?]>, color: Color = 'slate', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [field, value, note] of fields) layer.field(field, value, undefined, { note });
  return layer;
}

/** 一组独立的数值：每项按真实类型宽度写字节，用 vals 视图逐行显示。 */
export function values(name: string, entries: Array<[label: string, value: number | bigint, note?: string, options?: FieldOptions & { width?: 4 | 8; shown?: string }]>, color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  for (const [label, value, note, options] of entries) {
    const width = options?.width ?? 4;
    layer.field(label, options?.shown ?? String(value), () => (width === 8 ? layer.u64(value) : layer.u32(Number(value))), { note, ...options });
  }
  return layer;
}

/** double 类型（Cost、Selectivity）。写真实的 IEEE 754 字节。 */
export function doubles(name: string, entries: Array<[label: string, value: number, note?: string]>, color: Color = 'blue', summary = ''): LayerWriter {
  const layer = makeLayer(name, color, summary);
  const view = new DataView(new ArrayBuffer(8));
  for (const [label, value, note] of entries) {
    view.setFloat64(0, value, true);
    layer.field(label, Number.isInteger(value) ? `${value}.0` : String(+value.toFixed(6)), () => layer.raw(new Uint8Array(view.buffer.slice(0))), { note });
  }
  return layer;
}

// ---------- 页面 ----------

/** PageHeaderData（24 字节），从页面字节解码。 */
export function pageHeader(page: Page, color: Color = 'blue', note = ''): LayerWriter {
  const b = page.bytes;
  const layer = makeLayer('PageHeaderData', color, note || '每页开头固定 24 字节', 0);
  const u16 = (off: number) => rd16(b, off);
  layer.field('pd_lsn', lsnText(page.lsn), () => layer.raw(b.subarray(0, 8)), { note: '最后一次修改这一页的 WAL 记录的结束位置。写这页之前，WAL 必须先刷到这里。', example: true });
  layer.field('pd_checksum', u16(8), () => layer.raw(b.subarray(8, 10)), { note: '默认没有开启数据校验和（initdb --data-checksums），所以是 0。' });
  const flags = u16(10);
  layer.field('pd_flags', hx(flags), () => layer.raw(b.subarray(10, 12)));
  layer.over('PD_HAS_FREE_LINES 0x0001', flags & PD_HAS_FREE_LINES ? '1：有未用的行指针可以复用' : '0：没有未用的行指针', 10, 12);
  layer.over('PD_PAGE_FULL 0x0002', flags & PD_PAGE_FULL ? '1：上次更新时空间不够' : '0', 10, 12);
  layer.over('PD_ALL_VISIBLE 0x0004', flags & PD_ALL_VISIBLE ? '1：页上所有元组对所有事务可见' : '0', 10, 12);
  layer.field('pd_lower', u16(12), () => layer.raw(b.subarray(12, 14)), { note: '空闲空间的起点，也是行指针数组的末尾。' });
  layer.field('pd_upper', u16(14), () => layer.raw(b.subarray(14, 16)), { note: '空闲空间的终点，新元组从这里往低地址放。' });
  layer.field('pd_special', u16(16), () => layer.raw(b.subarray(16, 18)), { note: page.special === page.size ? '堆页没有特殊区，所以等于页大小。' : '特殊区的起点。B 树页在这里放 BTPageOpaqueData。' });
  const sv = u16(18);
  layer.field('pd_pagesize_version', hx(sv), () => layer.raw(b.subarray(18, 20)));
  layer.over('页大小', page.size < 256 ? `${page.size}（缩小的页）` : sv & 0xff00, 18, 20, { note: page.size < 256 ? '这个字段只能存 256 的倍数，所以字节里是 0。真实的 PostgreSQL 页最小 1 KiB。' : '高字节。' });
  layer.over('布局版本', sv & 0xff, 18, 20, { note: 'PG_PAGE_LAYOUT_VERSION，8.3 起一直是 4。' });
  layer.field('pd_prune_xid', rd32(b, 20), () => layer.raw(b.subarray(20, 24)), { note: '页上最老的可清理事务号。0 表示不用尝试清理。' });
  return layer;
}

/** ItemIdData 数组：每项 4 字节位域，lp_off:15 + lp_flags:2 + lp_len:15。 */
export function lineArray(page: Page, color: Color = 'teal', only?: number[]): LayerWriter {
  const list = only ?? Array.from({ length: page.maxOffset }, (_, i) => i + 1);
  const layer = makeLayer('ItemIdData[]', color, `行指针数组，每项 4 字节，共 ${page.maxOffset} 项`, only?.length ? page.lpOffset(only[0]) : 24);
  for (const n of list) {
    const at = page.lpOffset(n);
    const from = layer.length;
    const id = page.lp(n);
    layer.field(`行指针 ${n}`, hx(rd32(page.bytes, at), 8), () => layer.raw(page.bytes.subarray(at, at + 4)), { heading: false });
    layer.over('lp_off · 位 0–14', id.off, from, from + 2, { note: id.flags === 2 ? 'LP_REDIRECT 时这里存的是下一个行指针的编号。' : '元组在页内的偏移。' });
    layer.over('lp_flags · 位 15–16', `${id.flags} ${LP_NAMES[id.flags]}`, from + 1, from + 3);
    layer.over('lp_len · 位 17–31', id.len, from + 2, from + 4, { note: '元组的实际长度，不含对齐填充。' });
  }
  return layer;
}

const INFOMASK: Array<[number, string, string]> = [
  [HEAP_HASVARWIDTH, 'HEAP_HASVARWIDTH 0x0002', '有变长列'],
  [HEAP_XMIN_COMMITTED, 'HEAP_XMIN_COMMITTED 0x0100', '提示位：xmin 已提交，不用再查 CLOG'],
  [HEAP_XMIN_INVALID, 'HEAP_XMIN_INVALID 0x0200', '提示位：xmin 已回滚'],
  [HEAP_XMAX_COMMITTED, 'HEAP_XMAX_COMMITTED 0x0400', '提示位：xmax 已提交'],
  [HEAP_XMAX_INVALID, 'HEAP_XMAX_INVALID 0x0800', 'xmax 无效：没有人删除或锁定它'],
  [HEAP_UPDATED, 'HEAP_UPDATED 0x2000', '这是 UPDATE 产生的新版本'],
];

const INFOMASK2: Array<[number, string, string]> = [
  [HEAP_KEYS_UPDATED, 'HEAP_KEYS_UPDATED 0x2000', '元组被删除，或键列被更新'],
  [HEAP_HOT_UPDATED, 'HEAP_HOT_UPDATED 0x4000', '已被 HOT 更新，下一个版本在同一页'],
  [HEAP_ONLY_TUPLE, 'HEAP_ONLY_TUPLE 0x8000', '只有堆里有它，索引没有指向它的项'],
];

/** HeapTupleHeaderData（23 字节）和后面的列数据，从页面字节解码。 */
export function heapTuple(page: Page, n: number, schema: Attr[], color: Color = 'amber', notes: Partial<Record<'xmin' | 'xmax' | 'ctid', string>> = {}): LayerWriter {
  const id = page.lp(n);
  const t = page.bytes.subarray(id.off, id.off + id.len);
  const layer = makeLayer(`堆元组 · 行指针 ${n}`, color, `页内偏移 ${id.off}，长 ${id.len} 字节`, id.off);
  layer.field('t_xmin', rd32(t, 0), () => layer.raw(t.subarray(0, 4)), { note: notes.xmin ?? '插入这个版本的事务。', example: true });
  layer.field('t_xmax', rd32(t, 4), () => layer.raw(t.subarray(4, 8)), { note: notes.xmax ?? '删除或锁定这个版本的事务，0 表示没有。', example: true });
  layer.field('t_cid', rd32(t, 8), () => layer.raw(t.subarray(8, 12)), { note: '命令号：同一事务内的第几条命令。' });
  const blk = ((rd16(t, 12) << 16) | rd16(t, 14)) >>> 0;
  layer.field('t_ctid', `(${blk},${rd16(t, 16)})`, () => layer.raw(t.subarray(12, 18)), { note: notes.ctid ?? '指向自己，表示这是最新版本；被更新后指向新版本。' });
  layer.over('ip_blkid', blk, 12, 16, { note: 'BlockIdData：bi_hi 和 bi_lo 各 2 字节。' });
  layer.over('ip_posid', rd16(t, 16), 16, 18, { note: '行指针编号。' });
  const mask2 = rd16(t, 18);
  layer.field('t_infomask2', hx(mask2), () => layer.raw(t.subarray(18, 20)));
  layer.over('HEAP_NATTS_MASK 0x07FF', mask2 & HEAP_NATTS_MASK, 18, 20, { note: '列数。' });
  for (const [bit, name, text] of INFOMASK2) if (mask2 & bit) layer.over(name, `1：${text}`, 18, 20);
  const mask = rd16(t, 20);
  layer.field('t_infomask', hx(mask), () => layer.raw(t.subarray(20, 22)));
  for (const [bit, name, text] of INFOMASK) if (mask & bit) layer.over(name, `1：${text}`, 20, 22);
  layer.field('t_hoff', t[22], () => layer.raw(t.subarray(22, 23)), { note: '数据区的起点。23 字节头 MAXALIGN 后是 24。' });
  if (t[22] > 23) layer.field('对齐填充', t[22] - 23, () => layer.raw(t.subarray(23, t[22])));
  const data = t.subarray(t[22]);
  let cursor = t[22];
  for (const attr of deformTuple(schema, data, t[22])) {
    if (attr.pad) {
      layer.field('列对齐填充', attr.pad, () => layer.raw(t.subarray(cursor, cursor + attr.pad)));
      cursor += attr.pad;
    }
    const end = t[22] + attr.to;
    layer.field(attr.name, attr.value, () => layer.raw(t.subarray(cursor, end)), { note: typeof attr.value === 'string' ? `短 varlena：1 字节头 ${hx(t[cursor], 2)}，低位 1 表示短格式，高 7 位是总长度 ${t[cursor] >> 1}。` : 'int4，小端，按 4 字节对齐。' });
    cursor = end;
  }
  return layer;
}

/** 整页视图：页头 + 行指针 + 指定的元组。 */
export function heapPageLayers(page: Page, schema: Attr[], tuples: number[], note = ''): LayerWriter[] {
  return [pageHeader(page, 'blue', note), lineArray(page), ...tuples.map((n) => heapTuple(page, n, schema))];
}

// ---------- B 树 ----------

/** BTPageOpaqueData（16 字节，页尾特殊区）。 */
export function btOpaque(page: Page, color: Color = 'violet'): LayerWriter {
  const at = page.special;
  const b = page.bytes;
  const o = readOpaque(page);
  const layer = makeLayer('BTPageOpaqueData', color, '特殊区，每个 B 树页的最后 16 字节', at);
  layer.field('btpo_prev', o.prev, () => layer.raw(b.subarray(at, at + 4)), { note: '左兄弟的块号，0 表示最左。' });
  layer.field('btpo_next', o.next, () => layer.raw(b.subarray(at + 4, at + 8)), { note: '右兄弟的块号，0 表示最右。扫描靠它走到下一个叶子。' });
  layer.field('btpo_level', o.level, () => layer.raw(b.subarray(at + 8, at + 12)), { note: '叶子是第 0 层。' });
  layer.field('btpo_flags', hx(o.flags), () => layer.raw(b.subarray(at + 12, at + 14)));
  layer.over('BTP_LEAF 1<<0', o.flags & BTP_LEAF ? 1 : 0, 12, 14);
  layer.over('BTP_ROOT 1<<1', o.flags & BTP_ROOT ? 1 : 0, 12, 14);
  layer.over('BTP_META 1<<3', o.flags & BTP_META ? 1 : 0, 12, 14);
  layer.field('btpo_cycleid', o.cycle, () => layer.raw(b.subarray(at + 14, at + 16)), { note: 'VACUUM 周期号，没有并发清理时是 0。' });
  return layer;
}

/** IndexTupleData（8 字节头）加 int4 键。 */
export function indexTuple(page: Page, off: number, kind: 'leaf' | 'pivot' | 'high', color: Color = 'amber'): LayerWriter {
  const id = page.lp(off);
  const t = page.bytes.subarray(id.off, id.off + id.len);
  const info = rd16(t, 6);
  const block = ((rd16(t, 0) << 16) | rd16(t, 2)) >>> 0;
  const posid = rd16(t, 4);
  const size = info & INDEX_SIZE_MASK;
  const name = kind === 'high' ? 'high key' : kind === 'pivot' ? '下行链接' : '叶子索引项';
  const layer = makeLayer(`${name} · 行指针 ${off}`, color, `页内偏移 ${id.off}，长 ${size} 字节`, id.off);
  const tidNote = kind === 'leaf' ? '堆元组的位置：这就是 TID。' : kind === 'pivot' ? 't_tid 借来存子页块号，ip_posid 存保留的键列数。' : '这个 high key 不指向任何东西，只是右边界。块号字段没有意义，ip_posid 存保留的键列数。';
  layer.field('t_tid', `(${block},${posid})`, () => layer.raw(t.subarray(0, 6)), { note: tidNote });
  layer.field('t_info', hx(info), () => layer.raw(t.subarray(6, 8)));
  layer.over('INDEX_SIZE_MASK 0x1FFF', size, 6, 8, { note: '元组总长度。' });
  layer.over('INDEX_ALT_TID_MASK 0x2000', info & INDEX_ALT_TID_MASK ? '1：t_tid 另作他用（中枢元组）' : '0：t_tid 是真实的堆 TID', 6, 8);
  if (size > 8) {
    layer.field('键 int4', rd32(t, 8) | 0, () => layer.raw(t.subarray(8, 12)));
    layer.field('对齐填充', 4, () => layer.raw(t.subarray(12, size)), { note: '索引元组 MAXALIGN 到 8 字节。' });
  } else {
    layer.field('键', '没有', undefined, { note: '内部页的第一项是负无穷：比任何键都小，所以不用存键。' });
  }
  return layer;
}

/** 一个 B 树页的全部结构。 */
export function btreePageLayers(tree: BTree, block: number): LayerWriter[] {
  const page = tree.pages[block];
  const o = readOpaque(page);
  const layers: LayerWriter[] = [pageHeader(page, 'blue', `块 ${block}`), lineArray(page)];
  const rightmost = o.next === 0;
  const leaf = Boolean(o.flags & BTP_LEAF);
  for (let off = 1; off <= page.maxOffset; off++) {
    const isHigh = !rightmost && off === 1;
    layers.push(indexTuple(page, off, isHigh ? 'high' : leaf ? 'leaf' : 'pivot', isHigh ? 'slate' : 'amber'));
  }
  layers.push(btOpaque(page));
  return layers;
}

/** BTMetaPageData：索引的第 0 页。 */
export function btMeta(tree: BTree): LayerWriter {
  const b = tree.pages[0].bytes;
  const layer = makeLayer('BTMetaPageData', 'violet', '第 0 页。所有扫描都从这里找到根', 24);
  layer.field('btm_magic', hx(rd32(b, 24), 6), () => layer.raw(b.subarray(24, 28)), { note: 'BTREE_MAGIC。' });
  layer.field('btm_version', rd32(b, 28), () => layer.raw(b.subarray(28, 32)), { note: 'BTREE_VERSION，PG 12 起是 4。' });
  layer.field('btm_root', rd32(b, 32), () => layer.raw(b.subarray(32, 36)), { note: '根页的块号。' });
  layer.field('btm_level', rd32(b, 36), () => layer.raw(b.subarray(36, 40)), { note: '根所在的层。叶子是 0。' });
  layer.field('btm_fastroot', rd32(b, 40), () => layer.raw(b.subarray(40, 44)), { note: '“快速根”：跳过只有一个孩子的上层。这里和根相同。' });
  layer.field('btm_fastlevel', rd32(b, 44), () => layer.raw(b.subarray(44, 48)));
  return layer;
}

// ---------- WAL ----------

/** XLogRecord（24 字节）和记录体，全部从记录字节解码。 */
export function xlogLayers(entry: WalEntry): LayerWriter[] {
  const r = entry.bytes;
  const p = parseRecord(r);
  const rm = RMGR_NAMES[p.rmid] ?? String(p.rmid);
  const head = makeLayer('XLogRecord', 'blue', `LSN ${lsnText(entry.lsn)}，共 ${p.totLen} 字节`);
  head.field('xl_tot_len', p.totLen, () => head.raw(r.subarray(0, 4)), { note: '整条记录的长度。下一条记录从 MAXALIGN 后的位置开始。' });
  head.field('xl_xid', p.xid, () => head.raw(r.subarray(4, 8)), { note: '产生这条记录的事务。', example: true });
  head.field('xl_prev', lsnText(p.prev), () => head.raw(r.subarray(8, 16)), { note: '上一条记录的起点。恢复时用来判断读到的是不是真正的下一条。', example: true });
  head.field('xl_info', hx(p.info, 2), () => head.raw(r.subarray(16, 17)), { note: '高 4 位由资源管理器解释，这里决定了记录类型。' });
  head.field('xl_rmid', `${p.rmid} ${rm}`, () => head.raw(r.subarray(17, 18)), { note: '资源管理器：恢复时由它负责重放。见 rmgrlist.h。' });
  head.field('填充', 2, () => head.raw(r.subarray(18, 20)));
  head.field('xl_crc', hx(p.crc, 8), () => head.raw(r.subarray(20, 24)), { note: `CRC-32C。先算记录体，再算头部前 20 字节。复算${p.crcOk ? '一致' : '不一致'}。` });
  const layers = [head];
  if (p.block) {
    const b = p.block;
    const block = makeLayer('块引用', 'teal', `这条记录修改的页`, 24);
    block.field('id', b.id, () => block.raw(r.subarray(b.headerAt, b.headerAt + 1)));
    block.field('fork_flags', hx(b.flags, 2), () => block.raw(r.subarray(b.headerAt + 1, b.headerAt + 2)));
    block.over('BKPBLOCK_HAS_IMAGE 0x10', b.flags & BKPBLOCK_HAS_IMAGE ? '1：带整页镜像' : '0', 1, 2);
    block.over('BKPBLOCK_HAS_DATA 0x20', b.flags & BKPBLOCK_HAS_DATA ? '1：带块数据' : '0', 1, 2);
    block.field('data_length', b.dataLength, () => block.raw(r.subarray(b.headerAt + 2, b.headerAt + 4)));
    if (b.image) {
      const at = b.image.headerAt;
      block.field('镜像 length', b.image.length, () => block.raw(r.subarray(at, at + 2)), { note: '去掉空洞后的字节数。' });
      block.field('镜像 hole_offset', b.image.holeOffset, () => block.raw(r.subarray(at + 2, at + 4)), { note: 'pd_lower 到 pd_upper 之间是空的，不用记。' });
      block.field('镜像 bimg_info', hx(b.image.info, 2), () => block.raw(r.subarray(at + 4, at + 5)), { note: 'BKPIMAGE_HAS_HOLE | BKPIMAGE_APPLY。' });
    }
    block.field('RelFileLocator', `${b.rel[0]}/${b.rel[1]}/${b.rel[2]}`, () => block.raw(r.subarray(b.relAt, b.relAt + 12)), { note: '表空间 / 数据库 / 关系文件号。', example: true });
    block.field('BlockNumber', b.number, () => block.raw(r.subarray(b.relAt + 12, b.relAt + 16)));
    layers.push(block);
  }
  if (p.mainHeaderAt >= 0) {
    const dh = makeLayer('XLogRecordDataHeaderShort', 'slate', '主数据长度不超过 255 字节时用短头', p.mainHeaderAt);
    dh.field('id', 'XLR_BLOCK_ID_DATA_SHORT 255', () => dh.raw(r.subarray(p.mainHeaderAt, p.mainHeaderAt + 1)));
    dh.field('data_length', p.mainLength, () => dh.raw(r.subarray(p.mainHeaderAt + 1, p.mainHeaderAt + 2)));
    layers.push(dh);
  }
  if (p.block?.image) {
    const img = makeLayer('整页镜像', 'violet', `${p.block.image.length} 字节，页面去掉空洞后的内容`, p.block.dataAt - p.block.image.length);
    img.field('镜像数据', `${p.block.image.length} 字节`, () => img.raw(p.block!.image!.bytes), { note: '恢复时直接覆盖这一页，所以不怕页写到一半断电。' });
    layers.push(img);
  }
  if (p.block && p.block.dataLength) {
    const d = p.block.data;
    const data = makeLayer('块数据', 'amber', 'xl_heap_header + 元组内容', p.block.dataAt);
    const op = p.info & 0x70;
    let at = 0;
    if (op === XLOG_HEAP_HOT_UPDATE) {
      const flags = p.main[7];
      if (flags & 0x20) {
        data.field('prefixlen', rd16(d, at), () => data.raw(d.subarray(at, at + 2)), { note: '和旧版本开头相同的字节数，不用重复记录。' });
        at += 2;
      }
      if (flags & 0x40) {
        data.field('suffixlen', rd16(d, at), () => data.raw(d.subarray(at, at + 2)), { note: '和旧版本结尾相同的字节数。' });
        at += 2;
      }
    }
    data.field('t_infomask2', hx(rd16(d, at)), () => data.raw(d.subarray(at, at + 2)));
    data.field('t_infomask', hx(rd16(d, at + 2)), () => data.raw(d.subarray(at + 2, at + 4)));
    data.field('t_hoff', d[at + 4], () => data.raw(d.subarray(at + 4, at + 5)));
    at += 5;
    data.field('元组内容', `${d.length - at} 字节`, () => data.raw(d.subarray(at)), { note: '从元组第 23 字节开始。xmin、ctid 不用记：重放时从记录头和块号就能算出来。' });
    layers.push(data);
  }
  if (p.mainLength) {
    const m = p.main;
    let name = '主数据';
    if (p.rmid === RM_HEAP_ID) name = ({ [XLOG_HEAP_INSERT]: 'xl_heap_insert', [XLOG_HEAP_DELETE]: 'xl_heap_delete', [XLOG_HEAP_HOT_UPDATE]: 'xl_heap_update' } as Record<number, string>)[p.info & 0x70] ?? name;
    if (p.rmid === RM_XACT_ID) name = 'xl_xact_commit';
    const main = makeLayer(name, 'green', `主数据 ${p.mainLength} 字节`, p.mainAt);
    if (name === 'xl_heap_insert') {
      main.field('offnum', rd16(m, 0), () => main.raw(m.subarray(0, 2)), { note: '元组放在第几个行指针。' });
      main.field('flags', hx(m[2], 2), () => main.raw(m.subarray(2, 3)));
    } else if (name === 'xl_heap_delete') {
      main.field('xmax', rd32(m, 0), () => main.raw(m.subarray(0, 4)), { example: true });
      main.field('offnum', rd16(m, 4), () => main.raw(m.subarray(4, 6)));
      main.field('infobits_set', hx(m[6], 2), () => main.raw(m.subarray(6, 7)), { note: 'XLHL_KEYS_UPDATED：删除也算修改了键。' });
      main.field('flags', hx(m[7], 2), () => main.raw(m.subarray(7, 8)));
    } else if (name === 'xl_heap_update') {
      main.field('old_xmax', rd32(m, 0), () => main.raw(m.subarray(0, 4)), { example: true });
      main.field('old_offnum', rd16(m, 4), () => main.raw(m.subarray(4, 6)));
      main.field('old_infobits_set', hx(m[6], 2), () => main.raw(m.subarray(6, 7)));
      main.field('flags', hx(m[7], 2), () => main.raw(m.subarray(7, 8)), { note: '0x20 前缀来自旧版本，0x40 后缀来自旧版本。' });
      main.field('new_xmax', rd32(m, 8), () => main.raw(m.subarray(8, 12)));
      main.field('new_offnum', rd16(m, 12), () => main.raw(m.subarray(12, 14)));
    } else if (name === 'xl_xact_commit') {
      main.field('xact_time', '提交时间戳', () => main.raw(m.subarray(0, 8)), { note: 'TimestampTz：从 2000-01-01 算起的微秒数。这是最简单的提交记录，没有子事务和附加信息。', example: true });
    } else {
      main.field('数据', `${p.mainLength} 字节`, () => main.raw(m));
    }
    layers.push(main);
  }
  return layers;
}

// ---------- 事务状态 ----------

/** CLOG：每个事务 2 位，低位在前。 */
export function clogBytes(clog: Clog, xids: number[], color: Color = 'green'): LayerWriter {
  const first = clog.byteOf(Math.min(...xids));
  const last = clog.byteOf(Math.max(...xids));
  const layer = makeLayer('pg_xact 页内字节', color, '每字节 4 个事务，每个事务 2 位', first);
  for (let at = first; at <= last; at++) {
    const from = layer.length;
    layer.field(`字节 ${at}`, hx(clog.bytes[at], 2), () => layer.u8(clog.bytes[at]), { note: '事务号 ÷ 4 得到字节位置，事务号 % 4 × 2 得到位移。' });
    for (let xid = at * 4; xid < (at + 1) * 4; xid++) {
      const status = clog.get(xid);
      layer.over(`xid ${xid} · 位 ${(xid % 4) * 2}–${(xid % 4) * 2 + 1}`, `${status.toString(2).padStart(2, '0')} ${STATUS_NAMES[status]}`, from, from + 1, { example: true });
    }
  }
  return layer;
}

export function snapshotValues(snap: Snapshot, color: Color = 'violet'): LayerWriter {
  return values('SnapshotData', [
    ['xmin', snap.xmin, '小于它的事务要么已提交要么已回滚，都已结束。', { example: true }],
    ['xmax', snap.xmax, '大于等于它的事务对这个快照来说还没开始。', { example: true }],
    ['xcnt', snap.xip.length, 'xip 的长度。'],
    ...snap.xip.map((xid, i): [string, number, string, FieldOptions] => [`xip[${i}]`, xid, '拍快照时还在运行的事务。', { example: true }]),
  ], color, `pg_current_snapshot() 显示为 ${snap.xmin}:${snap.xmax}:${snap.xip.join(',')}`);
}

// ---------- 缓冲区 ----------

/** BufferDesc 开头：BufferTag（20 字节）、buf_id、state。 */
export function bufferDesc(pool: BufferPool, id: number, color: Color = 'blue'): LayerWriter {
  const f = pool.frames[id];
  const tag: BufTag = f.tag ?? { spc: 0, db: 0, rel: 0, fork: 0, block: 0 };
  const layer = makeLayer(`BufferDesc · 帧 ${id}`, color, '每个缓冲帧的描述符（前 28 字节）');
  layer.field('spcOid', tag.spc, () => layer.u32(tag.spc), { note: '表空间。1663 是 pg_default。' });
  layer.field('dbOid', tag.db, () => layer.u32(tag.db), { note: '数据库。', example: true });
  layer.field('relNumber', tag.rel, () => layer.u32(tag.rel), { note: '关系文件号。', example: true });
  layer.field('forkNum', tag.fork, () => layer.u32(tag.fork), { note: '0 是主分支，1 是 FSM，2 是可见性映射。' });
  layer.field('blockNum', tag.block, () => layer.u32(tag.block));
  layer.field('buf_id', id, () => layer.u32(id));
  const state = pool.stateWord(id);
  layer.field('state', hx(state, 8), () => layer.u32(state), { note: '一个 32 位原子变量同时放下三样东西，所以大部分操作不用加锁。' });
  layer.over('refcount · 位 0–17', state % 2 ** BUF_USAGECOUNT_SHIFT, 24, 27, { note: '钉住计数：不为 0 时不能被换出。' });
  layer.over('usage_count · 位 18–21', Math.floor(state / 2 ** BUF_USAGECOUNT_SHIFT) & 0xf, 26, 27, { note: '时钟扫描用的使用计数，最大 5。' });
  layer.over('BM_DIRTY · 位 23', (state >>> 0) & BM_DIRTY ? 1 : 0, 26, 27);
  layer.over('BM_VALID · 位 24', (state >>> 0) & BM_VALID ? 1 : 0, 27, 28);
  return layer;
}

// ---------- 执行器内部结构 ----------

/** MinimalTuple：临时文件和哈希表里的元组格式，去掉了事务字段。 */
export function minimalTuple(schema: Attr[], row: Value[], hoffNote = ''): { layer: LayerWriter; length: number } {
  const hoff = 24;
  const body = fillTuple(schema, row, hoff);
  const tLen = hoff - 8 + body.length;
  const layer = makeLayer('MinimalTupleData', 'amber', hoffNote || '只留下数据，没有 xmin/xmax');
  layer.field('t_len', tLen, () => layer.u32(tLen));
  layer.field('mt_padding', 6, () => layer.zero(6), { note: '补齐到和 HeapTupleHeaderData 后半部分相同的位置。' });
  const hasVar = schema.some((attr) => attr.type === 'text');
  layer.field('t_infomask2', schema.length, () => layer.u16(schema.length));
  layer.field('t_infomask', hx(hasVar ? HEAP_HASVARWIDTH : 0), () => layer.u16(hasVar ? HEAP_HASVARWIDTH : 0));
  layer.field('t_hoff', hoff, () => layer.u8(hoff));
  layer.field('对齐填充', 1, () => layer.u8(0));
  layer.field('列数据', row.join(', '), () => layer.raw(body));
  return { layer, length: tLen };
}

/** HashJoinTupleData：链表指针 + 哈希值，后面跟 MinimalTuple。 */
export function hashTupleHeader(hash: number, nbuckets: number, nbatch: number): LayerWriter {
  const layer = makeLayer('HashJoinTupleData', 'teal', '哈希表里每个元组前面的 16 字节');
  layer.field('next', '链表指针', () => layer.unknown(8), { note: '进程内的地址，每次运行都不同。头插法：新元组指向原来的桶头。', hidden: true });
  layer.field('hashvalue', hx(hash, 8), () => layer.u32(hash), { note: '探测时先比哈希值，相同才比键。' });
  const bits = Math.log2(nbuckets);
  layer.over(`桶号 · 低 ${bits} 位`, (hash & (nbuckets - 1)) >>> 0, 8, 12, { note: 'hashvalue & (nbuckets - 1)' });
  if (nbatch > 1) layer.over(`批号 · 再往上 ${Math.log2(nbatch)} 位`, ((hash >>> bits) & (nbatch - 1)) >>> 0, 8, 12, { note: 'pg_rotate_right32(hashvalue, log2_nbuckets) & (nbatch - 1)' });
  layer.field('对齐填充', 4, () => layer.zero(4), { note: 'HJTUPLE_OVERHEAD 是 MAXALIGN 之后的 16。' });
  return layer;
}

/** 外部排序写到磁带的格式：writetup_heap。 */
export function tapeTuple(schema: Attr[], row: Value[]): LayerWriter {
  const hoff = 24;
  const body = fillTuple(schema, row, hoff);
  const tLen = hoff - 8 + body.length;
  const tupbody = tLen - 10;
  const tuplen = tupbody + 4;
  const layer = makeLayer('磁带上的元组', 'amber', 'writetup_heap：长度字 + MinimalTuple 去掉前 10 字节');
  layer.field('tuplen', tuplen, () => layer.u32(tuplen), { note: `tupbodylen ${tupbody} + sizeof(int) 4。` });
  layer.field('t_infomask2', schema.length, () => layer.u16(schema.length));
  layer.field('t_infomask', hx(schema.some((a) => a.type === 'text') ? HEAP_HASVARWIDTH : 0), () => layer.u16(schema.some((a) => a.type === 'text') ? HEAP_HASVARWIDTH : 0));
  layer.field('t_hoff', hoff, () => layer.u8(hoff));
  layer.field('对齐填充', 1, () => layer.u8(0));
  layer.field('列数据', row.join(', '), () => layer.raw(body));
  return layer;
}

/** LOCKTAG（16 字节）。等行锁其实是等持有者事务号上的这把锁。 */
export function lockTagTransaction(xid: number, color: Color = 'violet'): LayerWriter {
  const layer = makeLayer('LOCKTAG', color, 'SET_LOCKTAG_TRANSACTION：锁表哈希键');
  layer.field('locktag_field1', xid, () => layer.u32(xid), { note: '事务号。', example: true });
  layer.field('locktag_field2', 0, () => layer.u32(0));
  layer.field('locktag_field3', 0, () => layer.u32(0));
  layer.field('locktag_field4', 0, () => layer.u16(0));
  layer.field('locktag_type', '5 LOCKTAG_TRANSACTION', () => layer.u8(5), { note: 'enum LockTagType 的第 6 项，从 0 算起是 5。' });
  layer.field('locktag_lockmethodid', '1 DEFAULT_LOCKMETHOD', () => layer.u8(1));
  return layer;
}

// ---------- 前后端协议 ----------

/** 解码一条前后端协议消息。一条消息一层。 */
export function protocolMessage(bytes: Uint8Array, addr = 0): LayerWriter {
  const type = String.fromCharCode(bytes[0]);
  const be32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const be16 = (o: number) => (bytes[o] << 8) | bytes[o + 1];
  const NAMES: Record<string, string> = { Q: 'Query', T: 'RowDescription', D: 'DataRow', C: 'CommandComplete', Z: 'ReadyForQuery', E: 'ErrorResponse' };
  const layer = makeLayer(`${NAMES[type] ?? type} 消息`, type === 'E' ? 'amber' : type === 'Q' ? 'blue' : 'green', `前后端协议 3.0，共 ${bytes.length} 字节`, addr);
  layer.field('类型', `'${type}'`, () => layer.raw(bytes.subarray(0, 1)));
  layer.field('长度', be32(1), () => layer.raw(bytes.subarray(1, 5)), { note: '大端。包括长度字段自己，不包括类型字节。' });
  let at = 5;
  const cstr = (label: string, note?: string) => {
    let end = at;
    while (bytes[end]) end++;
    const text = new TextDecoder().decode(bytes.subarray(at, end));
    const from = at;
    layer.field(label, text, () => layer.raw(bytes.subarray(from, end + 1)), { note });
    at = end + 1;
  };
  if (type === 'Q') cstr('查询字符串', '以 \\0 结尾。服务器收到后交给 exec_simple_query。');
  else if (type === 'C') cstr('命令标签', '告诉客户端做了什么、影响了几行。');
  else if (type === 'Z') {
    layer.field('事务状态', `'${String.fromCharCode(bytes[5])}'`, () => layer.raw(bytes.subarray(5, 6)), { note: "I 空闲，T 在事务里，E 事务已失败。" });
  } else if (type === 'T') {
    const count = be16(5);
    layer.field('列数', count, () => layer.raw(bytes.subarray(5, 7)));
    at = 7;
    for (let i = 0; i < count; i++) {
      cstr(`列 ${i + 1} 名字`);
      const from = at;
      layer.field('表 OID', be32(from), () => layer.raw(bytes.subarray(from, from + 4)), { example: true });
      layer.field('列号', be16(from + 4), () => layer.raw(bytes.subarray(from + 4, from + 6)));
      layer.field('类型 OID', be32(from + 6), () => layer.raw(bytes.subarray(from + 6, from + 10)), { note: '23 是 int4，25 是 text。' });
      layer.field('类型长度', be16(from + 10), () => layer.raw(bytes.subarray(from + 10, from + 12)));
      layer.field('类型修饰', -1, () => layer.raw(bytes.subarray(from + 12, from + 16)));
      layer.field('格式', '0 文本', () => layer.raw(bytes.subarray(from + 16, from + 18)));
      at = from + 18;
    }
  } else if (type === 'D') {
    const count = be16(5);
    layer.field('列数', count, () => layer.raw(bytes.subarray(5, 7)));
    at = 7;
    for (let i = 0; i < count; i++) {
      const from = at;
      const len = be32(from);
      layer.field(`列 ${i + 1} 长度`, len, () => layer.raw(bytes.subarray(from, from + 4)));
      layer.field(`列 ${i + 1} 值`, new TextDecoder().decode(bytes.subarray(from + 4, from + 4 + len)), () => layer.raw(bytes.subarray(from + 4, from + 4 + len)), { note: '简单查询协议总是用文本格式。' });
      at = from + 4 + len;
    }
  } else if (type === 'E') {
    const NOTE: Record<string, string> = { S: '严重级别', V: '严重级别（不翻译）', C: 'SQLSTATE', M: '消息', P: '出错位置', F: '源文件', L: '行号', R: '函数名' };
    while (bytes[at]) {
      const code = String.fromCharCode(bytes[at]);
      const from = at;
      let end = at + 1;
      while (bytes[end]) end++;
      layer.field(`${code} ${NOTE[code] ?? ''}`.trim(), new TextDecoder().decode(bytes.subarray(from + 1, end)), () => layer.raw(bytes.subarray(from, end + 1)));
      at = end + 1;
    }
    layer.field('结束', '\\0', () => layer.raw(bytes.subarray(at, at + 1)));
  }
  return layer;
}

// ---------- LSM（LevelDB 1.23） ----------

const TYPE_NAMES: Record<number, string> = { [kTypeDeletion]: 'kTypeDeletion', [kTypeValue]: 'kTypeValue' };
const printable = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`)).join('');
const seqText = (seq: bigint): string => (seq === kMaxSequenceNumber ? '最大值 2^56 − 1' : String(seq));
const slice = (bytes: ArrayLike<number>, from: number, to: number): number[] => Array.from(bytes).slice(from, to);

/** 8 字节 tag：低 8 位是类型，高 56 位是序列号。 */
function tagField(layer: LayerWriter, bytes: ArrayLike<number>, at: number, note = '序列号 << 8 | 类型，小端 8 字节。'): void {
  const tag = getFixed64(bytes, at);
  const seq = tag >> 8n;
  const type = Number(tag & 0xffn);
  const from = layer.length;
  layer.field('tag', `0x${tag.toString(16).padStart(16, '0')}`, () => layer.raw(slice(bytes, at, at + 8)), { note });
  layer.over('类型 · 低 8 位', `${type} ${TYPE_NAMES[type] ?? ''}`.trim(), from, from + 1, {
    note: type === kTypeDeletion ? '删除标记，也叫墓碑。值是空的。' : seq === kMaxSequenceNumber ? 'kValueTypeForSeek：查找时用，等于 kTypeValue。' : '普通的写入。',
  });
  layer.over('序列号 · 高 56 位', seqText(seq), from + 1, from + 8, {
    note: seq === kMaxSequenceNumber ? '比任何真实序列号都大，所以这个键排在同一用户键的所有版本前面。' : '全库递增。同一个键，序列号大的版本更新。',
  });
}

/** 写一个 varint 字段，返回它后面的位置。 */
function varintField(layer: LayerWriter, name: string, bytes: ArrayLike<number>, at: number, note?: string): { value: number; next: number } {
  const v = getVarint(bytes, at);
  layer.field(name, v.value, () => layer.raw(slice(bytes, at, v.next)), { note: note ?? (v.next - at > 1 ? `varint，${v.next - at} 字节。` : 'varint：小于 128 只占 1 字节。') });
  return v;
}

/** WriteBatch::rep_：一条日志记录的内容。 */
export function writeBatchLayer(rep: Uint8Array, addr: number): LayerWriter {
  const count = getFixed32(rep, 8);
  const layer = makeLayer('WriteBatch', 'blue', `${count} 条操作，共 ${rep.length} 字节`, addr);
  layer.field('sequence', String(getFixed64(rep, 0)), () => layer.raw(rep.subarray(0, 8)), { note: '这一批第一条操作的序列号，后面的操作依次加 1。' });
  layer.field('count', count, () => layer.raw(rep.subarray(8, 12)));
  let at = 12;
  for (let i = 0; i < count; i++) {
    const type = rep[at];
    layer.field('类型', `${type} ${TYPE_NAMES[type]}`, () => layer.u8(type), { note: type === kTypeDeletion ? '删除只写键，没有值。' : '后面是键和值，各带一个 varint 长度。' });
    const key = varintField(layer, '键长', rep, at + 1);
    layer.field('键', printable(rep.subarray(key.next, key.next + key.value)), () => layer.raw(rep.subarray(key.next, key.next + key.value)));
    at = key.next + key.value;
    if (type === kTypeValue) {
      const value = varintField(layer, '值长', rep, at);
      layer.field('值', printable(rep.subarray(value.next, value.next + value.value)), () => layer.raw(rep.subarray(value.next, value.next + value.value)));
      at = value.next + value.value;
    }
  }
  return layer;
}

/** 日志记录：7 字节头 + WriteBatch。地址是记录在 .log 文件里的偏移。 */
export function logRecordLayers(record: LogRecord): LayerWriter[] {
  const r = record.bytes;
  const masked = getFixed32(r, 0);
  const length = r[4] | (r[5] << 8);
  const type = r[6];
  const ok = logRecordCrc(type, r.subarray(LOG_HEADER_SIZE)) === masked;
  const head = makeLayer('日志记录头', 'violet', `.log 文件偏移 ${record.offset}，共 ${r.length} 字节`, record.offset);
  head.field('checksum', hx(masked, 8), () => head.raw(r.subarray(0, 4)), { note: `CRC-32C，覆盖类型字节和数据，再做掩码（循环右移 15 位，加 0xa282ead8）。复算${ok ? '一致' : '不一致'}。` });
  head.field('length', length, () => head.raw(r.subarray(4, 6)), { note: '数据部分的长度，小端 2 字节。' });
  head.field('type', `${type} ${LOG_TYPE_NAMES[type]}`, () => head.raw(r.subarray(6, 7)), { note: '放得进当前 32 KiB 块就是 FULL，否则拆成 FIRST、MIDDLE、LAST 几段。' });
  return [head, writeBatchLayer(r.subarray(LOG_HEADER_SIZE), record.offset + LOG_HEADER_SIZE)];
}

/** MemTable::Add 写进 arena 的一条记录，以及指向它的跳表节点。 */
export function memEntryLayers(entry: MemEntry, color: Color = 'amber'): LayerWriter[] {
  const e = entry.encoded;
  const layer = makeLayer('MemTable 记录', color, `${e.length} 字节，放在 arena 里`);
  const key = varintField(layer, 'internal_key_size', e, 0, '用户键长度 + 8。');
  const userLen = key.value - 8;
  layer.field('用户键', printable(e.subarray(key.next, key.next + userLen)), () => layer.raw(e.subarray(key.next, key.next + userLen)));
  tagField(layer, e, key.next + userLen);
  const value = varintField(layer, 'value_size', e, key.next + key.value);
  if (value.value) layer.field('值', printable(e.subarray(value.next, value.next + value.value)), () => layer.raw(e.subarray(value.next)));
  const node = makeLayer('SkipList::Node', 'teal', `高度 ${entry.height}：${8 + entry.height * 8} 字节`);
  node.field('key', '指向上面的记录', () => node.unknown(8), { note: '进程内的地址，每次运行都不同。', hidden: true });
  for (let i = 0; i < entry.height; i++) node.field(`next_[${i}]`, `第 ${i} 层的后继`, () => node.unknown(8), { note: i === 0 ? '第 0 层串起所有节点，按内部键排好序。' : '高层的链跳得远，查找时从最高层往下走。', hidden: true });
  return [layer, node];
}

/** LookupKey：MemTable 查找时用的键。 */
export function lookupKeyLayer(bytes: Uint8Array): LayerWriter {
  const layer = makeLayer('LookupKey', 'blue', '序列号取当前最新，找不比它新的版本');
  const key = varintField(layer, 'klength', bytes, 0, '用户键长度 + 8。');
  layer.field('用户键', printable(bytes.subarray(key.next, key.next + key.value - 8)), () => layer.raw(bytes.subarray(key.next, key.next + key.value - 8)));
  tagField(layer, bytes, key.next + key.value - 8);
  return layer;
}

/** 块尾 5 字节：压缩类型和掩码后的 CRC-32C。 */
function trailerLayer(file: Uint8Array, handle: BlockHandle): LayerWriter {
  const at = handle.offset + handle.size;
  const masked = getFixed32(file, at + 1);
  const ok = blockTrailer(file.subarray(handle.offset, at), file[at]).every((b, i) => b === file[at + i]);
  const layer = makeLayer('块尾', 'slate', '每个块后面都有', at);
  layer.field('type', `${file[at]} kNoCompression`, () => layer.raw(file.subarray(at, at + 1)), { note: '本课关闭了压缩。默认是 Snappy，压缩省不到 12.5% 时也按不压缩存。' });
  layer.field('crc', hx(masked, 8), () => layer.raw(file.subarray(at + 1, at + 5)), { note: `CRC-32C 覆盖块内容和类型字节，再做掩码。复算${ok ? '一致' : '不一致'}。` });
  return layer;
}

interface BlockView {
  name: string;
  color: Color;
  /** 每条记录的标题。 */
  title: (entry: BlockEntry, index: number) => string;
  /** 键的后半段（non_shared 部分）怎么拆。 */
  key: (layer: LayerWriter, block: Uint8Array, entry: BlockEntry, keyAt: number) => void;
  value: (layer: LayerWriter, block: Uint8Array, entry: BlockEntry, valueAt: number) => void;
}

/** 一个块：记录、重启点数组、重启点个数，加块尾。地址是在 .ldb 文件里的偏移。 */
function blockLayers(file: Uint8Array, handle: BlockHandle, view: BlockView): LayerWriter[] {
  const block = file.subarray(handle.offset, handle.offset + handle.size);
  const parsed = parseBlock(block);
  const layer = makeLayer(view.name, view.color, `${parsed.entries.length} 条记录，${parsed.restarts.length} 个重启点，${handle.size} 字节`, handle.offset);
  parsed.entries.forEach((entry, i) => {
    layer.field(`第 ${i + 1} 条`, view.title(entry, i), undefined, { heading: true });
    const shared = varintField(layer, 'shared', block, entry.offset, parsed.restarts.includes(entry.offset) ? '重启点：不和前一个键共用前缀，存完整的键。' : `和前一个键共用的前缀字节数。`);
    const nonShared = varintField(layer, 'non_shared', block, shared.next, '这个键自己要存的字节数。');
    const valueLen = varintField(layer, 'value_length', block, nonShared.next);
    view.key(layer, block, entry, valueLen.next);
    view.value(layer, block, entry, valueLen.next + entry.nonShared);
  });
  parsed.restarts.forEach((offset, i) => layer.field(`restarts[${i}]`, offset, () => layer.raw(block.subarray(parsed.restartsAt + i * 4, parsed.restartsAt + i * 4 + 4)), { note: '重启点在块内的偏移。查找时先在这些点上二分，再往后顺序扫。' }));
  layer.field('num_restarts', parsed.restarts.length, () => layer.raw(block.subarray(block.length - 4)));
  return [layer, trailerLayer(file, handle)];
}

/** 数据块和索引块的键是内部键：non_shared 部分可能只含用户键的后半段，也可能包含 tag。 */
function internalKeyPart(layer: LayerWriter, block: Uint8Array, entry: BlockEntry, at: number): void {
  const userLen = entry.key.length - 8;
  const userPart = Math.max(0, userLen - entry.shared);
  if (userPart) {
    const full = printable(entry.key.subarray(0, userLen));
    layer.field('key_delta', entry.shared ? `${printable(block.subarray(at, at + userPart))}（完整键 ${full}）` : full, () => layer.raw(block.subarray(at, at + userPart)), { note: entry.shared ? `前 ${entry.shared} 字节从上一个键借。` : '用户键。' });
  }
  if (entry.shared <= userLen) tagField(layer, block, at + userPart);
  else layer.field('key_delta', `tag 的后 ${entry.nonShared} 字节`, () => layer.raw(block.subarray(at, at + entry.nonShared)), { note: '同一个用户键的两个版本，连 tag 的前几个字节都能共用。' });
}

const textValue = (layer: LayerWriter, block: Uint8Array, entry: BlockEntry, at: number): void => {
  if (entry.valueLength) layer.field('value', printable(entry.value), () => layer.raw(block.subarray(at, at + entry.valueLength)));
};

const handleValue = (what: string) => (layer: LayerWriter, block: Uint8Array, entry: BlockEntry, at: number): void => {
  const handle = decodeHandle(entry.value);
  const from = layer.length;
  layer.field('BlockHandle', `偏移 ${handle.offset}，长 ${handle.size}`, () => layer.raw(block.subarray(at, at + entry.valueLength)), { note: `${what}的位置。两个 varint64，长度不含块尾 5 字节。` });
  const offsetLen = varintBytes(handle.offset).length;
  layer.over('offset', handle.offset, from, from + offsetLen);
  layer.over('size', handle.size, from + offsetLen, from + entry.valueLength);
};

const keyTitle = (entry: BlockEntry): string => {
  const k = parseInternalKey(entry.key);
  return `${printable(k.user)} @ ${seqText(k.seq)}${k.type === kTypeDeletion ? '（墓碑）' : ''}`;
};

export function dataBlockLayers(file: Uint8Array, handle: BlockHandle): LayerWriter[] {
  return blockLayers(file, handle, { name: '数据块', color: 'amber', title: keyTitle, key: internalKeyPart, value: textValue });
}

export function indexBlockLayers(file: Uint8Array, handle: BlockHandle): LayerWriter[] {
  return blockLayers(file, handle, { name: '索引块', color: 'green', title: (entry) => `${keyTitle(entry)} → 数据块`, key: internalKeyPart, value: handleValue('数据块') });
}

export function metaindexBlockLayers(file: Uint8Array, handle: BlockHandle): LayerWriter[] {
  return blockLayers(file, handle, {
    name: '元索引块',
    color: 'teal',
    title: (entry) => printable(entry.key),
    key: (layer, block, entry, at) => layer.field('key', printable(entry.key), () => layer.raw(block.subarray(at, at + entry.nonShared)), { note: '"filter." 加过滤策略的名字。打开表时按这个名字找过滤块。' }),
    value: handleValue('过滤块'),
  });
}

/** 过滤块：每 2 KiB 数据一个布隆过滤器，后面是偏移数组。probe 是要演示的查找键。 */
export function filterBlockLayers(file: Uint8Array, handle: BlockHandle, policy: BloomPolicy, keys: Array<{ key: string; inside: boolean }>): LayerWriter[] {
  const block = file.subarray(handle.offset, handle.offset + handle.size);
  const parsed = parseFilterBlock(block);
  const layer = makeLayer('过滤块', 'violet', `${parsed.filters.length} 个布隆过滤器，${handle.size} 字节`, handle.offset);
  parsed.filters.forEach((filter, i) => {
    const bits = (filter.bytes.length - 1) * 8;
    const from = layer.length;
    layer.field(`filter[${i}] 位数组`, `${bits} 位`, () => layer.raw(filter.bytes.subarray(0, filter.bytes.length - 1)), { note: `键数 × 10 位，不足 64 位按 64 位。` });
    for (const { key, inside } of keys) {
      const probes = policy.probes(enc(key), bits, filter.bytes[filter.bytes.length - 1]);
      const hits = probes.map((pos) => Boolean(filter.bytes[pos >> 3] & (1 << (pos & 7))));
      layer.over(`${key} 的 ${probes.length} 个探针`, probes.map((pos, j) => `${pos}${hits[j] ? '=1' : '=0'}`).join(' '), from, from + filter.bytes.length - 1, {
        note: inside ? '写入时置过这些位，所以全是 1。' : hits.every(Boolean) ? '碰巧全是 1：误判，要读数据块才知道没有。' : '有一位是 0：这个键一定不在文件里，不用读数据块。',
      });
    }
    layer.field(`filter[${i}] k`, filter.bytes[filter.bytes.length - 1], () => layer.raw(filter.bytes.subarray(filter.bytes.length - 1)), { note: '探针个数 = 10 × 0.69 取整。' });
  });
  parsed.filters.forEach((filter, i) => layer.field(`offset[${i}]`, filter.offset, () => layer.raw(block.subarray(parsed.arrayOffset + i * 4, parsed.arrayOffset + i * 4 + 4))));
  layer.field('array_offset', parsed.arrayOffset, () => layer.raw(block.subarray(block.length - 5, block.length - 1)), { note: '偏移数组的起点。' });
  layer.field('base_lg', parsed.baseLg, () => layer.raw(block.subarray(block.length - 1)), { note: `数据块偏移 >> ${parsed.baseLg} 得到过滤器编号，也就是每 ${1 << parsed.baseLg} 字节一个。` });
  return [layer, trailerLayer(file, handle)];
}

/** Footer：文件最后 48 字节。打开表时先读它。 */
export function footerLayer(file: Uint8Array): LayerWriter {
  const at = file.length - FOOTER_SIZE;
  const footer = parseFooter(file);
  const layer = makeLayer('Footer', 'blue', '文件最后 48 字节', at);
  let p = at;
  for (const [name, handle] of [['metaindex_handle', footer.metaindex], ['index_handle', footer.index]] as const) {
    const end = decodeHandle(file, p).next;
    const from = layer.length;
    layer.field(name, `偏移 ${handle.offset}，长 ${handle.size}`, () => layer.raw(file.subarray(p, end)), { note: name === 'index_handle' ? '索引块的位置。' : '元索引块的位置，元索引块再指向过滤块。' });
    const offsetLen = varintBytes(handle.offset).length;
    layer.over('offset', handle.offset, from, from + offsetLen);
    layer.over('size', handle.size, from + offsetLen, from + (end - p));
    p = end;
  }
  layer.field('填充', `${HANDLE_MAX * 2 - footer.used} 字节`, () => layer.raw(file.subarray(p, at + HANDLE_MAX * 2)), { note: '两个 BlockHandle 最多各 20 字节，补零到 40 字节，footer 才是定长的。' });
  layer.field('magic', `0x${footer.magic.toString(16)}`, () => layer.raw(file.subarray(file.length - 8)), { note: 'kTableMagicNumber，小端 8 字节。读到的不是它，就不是一个 LevelDB 表文件。' });
  return layer;
}

export { hex, hx };
