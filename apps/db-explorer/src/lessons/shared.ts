import { lsnText } from '../engine/bytes';
import { BTP_LEAF, type BTree } from '../engine/btree';
import type { BufferPool } from '../engine/buffer';
import { tagText } from '../engine/buffer';
import { HEAP_HOT_UPDATED, HEAP_ONLY_TUPLE, HEAP_XMAX_COMMITTED, HEAP_XMAX_INVALID, HEAP_XMIN_COMMITTED, type Attr, HeapPage, readTupleHeader, deformTuple, type Page } from '../engine/page';
import type { Clog } from '../engine/mvcc';
import type { Wal } from '../engine/wal';
import type { BTreeBoard, FramesBoard, PageBoard, SnapshotBoard, Tone, WalBoard } from '../scene/board-types';

export const ACCOUNTS: Attr[] = [{ name: 'id', type: 'int4' }, { name: 'owner', type: 'text' }, { name: 'balance', type: 'int4' }];

export const us = (n: number): number => Math.round(n * 1e3);
export const ms = (n: number): number => Math.round(n * 1e6);

/** 把 infomask 提示位压成短标记，放进表格。 */
export function hintText(t: Uint8Array): string {
  const h = readTupleHeader(t);
  const parts: string[] = [];
  if (h.infomask & HEAP_XMIN_COMMITTED) parts.push('XMIN✓');
  if (h.infomask & HEAP_XMAX_COMMITTED) parts.push('XMAX✓');
  if (h.infomask & HEAP_XMAX_INVALID) parts.push('无XMAX');
  if (h.infomask2 & HEAP_HOT_UPDATED) parts.push('HOT');
  if (h.infomask2 & HEAP_ONLY_TUPLE) parts.push('ONLY');
  return parts.join(' ') || '—';
}

export interface PageBoardOptions {
  title: string;
  sub?: string;
  hot?: Record<number, Tone>;
  muted?: number[];
  /** 每行末尾加一列：可见性结论等。 */
  extra?: { name: string; cell: (lp: number) => string };
  labels?: (lp: number) => string;
}

/** 结构板内容直接从页面字节解码，保证显示的就是真实布局。 */
export function pageBoard(heap: HeapPage, options: PageBoardOptions): PageBoard {
  const p: Page = heap.page;
  const lps = Array.from({ length: p.maxOffset }, (_, i) => {
    const id = p.lp(i + 1);
    return { n: i + 1, off: id.off, len: id.len, flags: id.flags, hot: options.hot?.[i + 1] };
  });
  const normal = lps.filter((lp) => lp.flags === 1);
  const tuples = [...normal]
    .sort((a, b) => a.off - b.off)
    .map((lp) => ({ lp: lp.n, off: lp.off, len: lp.len, label: options.labels?.(lp.n) ?? `#${lp.n}`, hot: options.hot?.[lp.n], muted: options.muted?.includes(lp.n) }));
  const rows = lps.map((lp) => {
    if (lp.flags !== 1) {
      const text = lp.flags === 2 ? `→ 行指针 ${lp.off}` : lp.flags === 3 ? '死，等索引清理' : '未使用，可复用';
      return { cells: [String(lp.n), ['未用', '', '重定向', '死'][lp.flags], '', '', '', text, ...(options.extra ? [''] : [])], hot: lp.hot, muted: true };
    }
    const t = heap.tuple(lp.n);
    const h = readTupleHeader(t);
    const data = deformTuple(heap.schema, t.subarray(h.hoff), h.hoff).map((attr) => attr.value).join(', ');
    return {
      cells: [String(lp.n), String(lp.off), String(h.xmin), String(h.xmax), `(${h.ctid[0]},${h.ctid[1]})`, data, ...(options.extra ? [options.extra.cell(lp.n)] : [hintText(t)])],
      hot: lp.hot,
      muted: options.muted?.includes(lp.n),
    };
  });
  return {
    kind: 'page',
    title: options.title,
    sub: options.sub,
    size: p.size,
    lower: p.lower,
    upper: p.upper,
    special: p.special,
    lps,
    tuples,
    columns: ['lp', 'lp_off', 'xmin', 'xmax', 't_ctid', '数据', options.extra?.name ?? '标记'],
    widths: [30, 54, 46, 46, 56, 130, 110],
    rows,
  };
}

export function framesBoard(pool: BufferPool, title: string, hot: Record<number, Tone> = {}, sub?: string): FramesBoard {
  return {
    kind: 'frames',
    title,
    sub,
    columns: 4,
    hand: pool.hand,
    frames: pool.frames.map((f) => ({ id: f.id, tag: tagText(f.tag), usage: f.usage, ref: f.ref, dirty: f.dirty, hot: hot[f.id] })),
  };
}

export interface TreeBoardOptions {
  title: string;
  sub?: string;
  hot?: Record<number, Tone>;
  hotKey?: Record<number, number>;
  path?: Array<[number, number]>;
  footer?: string;
}

/** 从真实的 B 树页面读出键、high key 和下行链接。 */
export function treeBoard(tree: BTree, options: TreeBoardOptions): BTreeBoard {
  return {
    kind: 'btree',
    title: options.title,
    sub: options.sub,
    path: options.path,
    footer: options.footer,
    levels: tree.levels().map((row) =>
      row.map((node) => ({ block: node.block, keys: node.keys, high: node.high, leaf: node.leaf, children: node.children, hot: options.hot?.[node.block], hotKey: options.hotKey?.[node.block] })),
    ),
  };
}

export const leafFlag = (tree: BTree, block: number): boolean => Boolean(tree.opaque(block).flags & BTP_LEAF);

export interface WalBoardOptions {
  title: string;
  sub?: string;
  hot?: number[];
  from?: number;
  pointers?: Array<{ name: string; lsn: bigint; tone?: Tone }>;
  footer?: string;
  torn?: number[];
  marks?: Record<number, string>;
  /** 崩溃恢复里，磁盘上的 WAL 状态由 flush 指针决定。 */
}

export function walBoard(wal: Wal, options: WalBoardOptions): WalBoard {
  return {
    kind: 'wal',
    title: options.title,
    sub: options.sub,
    footer: options.footer,
    records: wal.entries.slice(options.from ?? 0).map((entry, index) => {
      const at = index + (options.from ?? 0);
      return {
        lsn: lsnText(entry.lsn),
        label: entry.label,
        size: entry.bytes.length,
        durable: entry.end <= wal.flush,
        hot: options.hot?.includes(at),
        tone: options.hot?.includes(at) && !options.torn?.includes(at) ? (entry.end <= wal.flush ? ('green' as const) : ('amber' as const)) : undefined,
        torn: options.torn?.includes(at),
        mark: options.marks?.[at],
      };
    }),
    pointers: (options.pointers ?? [{ name: 'XLogCtl 写入点', lsn: wal.insert, tone: 'amber' as Tone }, { name: '已 fsync 到', lsn: wal.flush, tone: 'green' as Tone }]).map((pointer) => ({ name: pointer.name, lsn: lsnText(pointer.lsn), tone: pointer.tone })),
  };
}

export function snapshotBoard(clog: Clog, opts: { title: string; from: number; to: number; running?: number[]; started: number; snapshot?: { xmin: number; xmax: number; xip: number[] }; me?: number; probe?: number; probeText?: string; sub?: string }): SnapshotBoard {
  const status: SnapshotBoard['status'] = {};
  for (let xid = opts.from; xid <= opts.to; xid++) {
    if (xid >= opts.started) status[xid] = 'future';
    else if (opts.running?.includes(xid)) status[xid] = 'running';
    else status[xid] = clog.get(xid) === 1 ? 'committed' : clog.get(xid) === 2 ? 'aborted' : 'running';
  }
  const snap = opts.snapshot;
  return {
    kind: 'snapshot',
    title: opts.title,
    sub: opts.sub,
    from: opts.from,
    to: opts.to,
    status,
    xmin: snap?.xmin,
    xmax: snap?.xmax,
    xip: snap?.xip,
    me: opts.me,
    text: snap ? `${snap.xmin}:${snap.xmax}:${snap.xip.join(',')}` : undefined,
    probe: opts.probe,
    probeText: opts.probeText,
  };
}

export const hexU32 = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
