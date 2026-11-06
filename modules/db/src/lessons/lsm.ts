import { concept, dataBlockLayers, filterBlockLayers, footerLayer, indexBlockLayers, logRecordLayers, lookupKeyLayer, memEntryLayers, metaindexBlockLayers, wire } from '../decode/structures';
import { blockOf, BloomPolicy, enc, kTypeValue, lookupKey, LsmDb, parseBlock, parseInternalKey, str, userOf, type DbOptions, type FileMeta, type GetResult, type MemTable, type WriteResult } from '../engine/lsm';
import type { LanesBoard, TableBoard, Tone } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { us } from './shared';
import type { Lesson } from './types';

/**
 * 和 tests/golden/leveldb.json 同一组操作：日志和每个表文件的字节都和 LevelDB 1.23 写出的真实文件一致。
 * 课程开始前，L1 有序列号 1–4 的文件，L0 有 5–8 的文件，日志 000012.log 是空的。
 */
const OPTIONS: DbOptions = { blockSize: 4096, restartInterval: 2, bitsPerKey: 10, memEntries: 4, l0Trigger: 2 };
const db = new LsmDb(OPTIONS, 12);
const fileL1 = db.install(1, 9, [
  { seq: 1, type: kTypeValue, key: 'acct:ann', value: '100' },
  { seq: 2, type: kTypeValue, key: 'acct:bob', value: '200' },
  { seq: 3, type: kTypeValue, key: 'acct:cat', value: '300' },
  { seq: 4, type: kTypeValue, key: 'acct:dan', value: '400' },
]);
const fileL0 = db.install(0, 11, [
  { seq: 5, type: kTypeValue, key: 'acct:cat', value: '310' },
  { seq: 6, type: kTypeValue, key: 'acct:eve', value: '500' },
  { seq: 7, type: kTypeValue, key: 'acct:gus', value: '700' },
  { seq: 8, type: kTypeValue, key: 'acct:hal', value: '800' },
]);
const policy = new BloomPolicy(OPTIONS.bitsPerKey);

const logName = (n: number): string => `${String(n).padStart(6, '0')}.log`;
const tableName = (n: number): string => `${String(n).padStart(6, '0')}.ldb`;
const short = (user: Uint8Array): string => str(user).replace('acct:', '');
const opText = (type: number, seq: number | bigint): string => `${type === kTypeValue ? 'Put' : 'Del'} ${seq}`;
const opName = (w: WriteResult): string => (w.op.type === kTypeValue ? `Put ${str(w.op.key)} = ${str(w.op.value)}` : `Delete ${str(w.op.key)}`);

// ---------- 结构板 ----------

type Cells = LanesBoard['rows'][number]['cells'];
/** 当前日志里的记录，换日志时清空。 */
let walRows: Array<{ key: string; seq: number; type: number }> = [];

function fileCells(files: FileMeta[], hot: Record<number, Tone>, keys: string[] = []): Cells {
  const cells: Cells = [];
  // 读 L0 时从新到旧，所以新文件放在左边。
  [...files].sort((a, b) => b.number - a.number).forEach((file, i) => {
    if (i) cells.push({ text: '', gap: true });
    cells.push({ text: `#${file.number}`, sub: `${file.table.bytes.length} B`, hot: hot[file.number] });
    for (const entry of file.table.entries()) {
      const k = parseInternalKey(entry.key);
      cells.push({ text: short(k.user), sub: opText(k.type, k.seq), hot: hot[file.number] ?? (keys.includes(str(k.user)) ? 'slate' : undefined) });
    }
  });
  return cells;
}

const memCells = (mem: MemTable | null, hot: number[] = [], tone: Tone = 'amber'): Cells => (mem?.entries ?? []).map((e) => ({ text: short(e.user), sub: opText(e.type, e.seq), hot: hot.includes(e.seq) ? tone : undefined }));

function lsmBoard(sub: string, hot: { wal?: number[]; mem?: number[]; imm?: boolean; files?: Record<number, Tone>; keys?: string[] } = {}): LanesBoard {
  return {
    kind: 'lanes',
    title: 'LSM 树的全貌',
    sub,
    cell: 62,
    labelWidth: 78,
    rows: [
      { label: `WAL #${db.log.number}`, cells: walRows.map((r) => ({ text: short(enc(r.key)), sub: opText(r.type, r.seq), hot: hot.wal?.includes(r.seq) ? ('violet' as const) : undefined })), hot: Boolean(hot.wal?.length) },
      { label: 'MemTable', cells: memCells(db.mem, hot.mem), hot: Boolean(hot.mem?.length) },
      { label: '只读', cells: memCells(db.imm, hot.imm ? db.imm!.entries.map((e) => e.seq) : [], 'slate'), hot: hot.imm },
      { label: 'L0', cells: fileCells(db.levels[0], hot.files ?? {}, hot.keys), hot: db.levels[0].some((f) => hot.files?.[f.number]) },
      { label: 'L1', cells: fileCells(db.levels[1], hot.files ?? {}, hot.keys), hot: db.levels[1].some((f) => hot.files?.[f.number]) },
    ],
  };
}

/** 跳表：每层一行，节点按第 0 层的顺序对齐。高度来自真实的 RandomHeight。 */
function skipBoard(mem: MemTable, sub: string, hotSeq?: number): LanesBoard {
  const top = Math.max(1, ...mem.entries.map((e) => e.height));
  const rows = Array.from({ length: top }, (_, i) => top - 1 - i).map((level) => ({
    label: `第 ${level} 层`,
    cells: [
      { text: 'head' },
      ...mem.entries.map((e) => (e.height > level ? { text: short(e.user), hot: e.seq === hotSeq ? ('amber' as const) : undefined } : { text: '', muted: true })),
      { text: 'NULL', muted: true },
    ],
  }));
  return { kind: 'lanes', title: '跳表：MemTable 的内部', sub, rows, cell: 62, labelWidth: 78, footer: '节点高度由 Random(0xdeadbeef) 决定：每多一层的概率是 1/4，最高 12 层' };
}

function sstBoard(file: FileMeta, hot: string[], sub: string): TableBoard {
  const t = file.table;
  const data = t.dataHandles();
  const index = t.index.entries.map((e) => `"${str(userOf(e.key))}"`);
  const row = (name: string, offset: number, size: number, text: string) => ({ cells: [name, String(offset), `${size} + 5`, text], hot: hot.includes(name) ? ('teal' as const) : undefined, muted: !hot.includes(name) && hot.length > 0 });
  return {
    kind: 'table',
    title: `SSTable ${tableName(file.number)}`,
    sub,
    columns: ['区段', '偏移', '长度', '内容'],
    widths: [110, 60, 80, 570],
    rows: [
      ...data.map((h, i) => {
        const block = parseBlock(blockOf(t.bytes, h));
        return row(data.length > 1 ? `数据块 ${i}` : '数据块', h.offset, h.size, `${block.entries.map((e) => short(userOf(e.key))).join(' ')}，${block.restarts.length} 个重启点`);
      }),
      row('过滤块', t.filterHandle.offset, t.filterHandle.size, `${(t.filter.filters[0].bytes.length - 1) * 8} 位的布隆过滤器，k = ${t.filter.filters[0].bytes[t.filter.filters[0].bytes.length - 1]}`),
      row('元索引块', t.footer.metaindex.offset, t.footer.metaindex.size, '过滤器的名字 → 过滤块'),
      row('索引块', t.footer.index.offset, t.footer.index.size, `${index.join(' ')} → 数据块`),
      { cells: ['Footer', String(t.bytes.length - 48), '48', '两个 BlockHandle + magic'], hot: hot.includes('Footer') ? ('teal' as const) : undefined, muted: !hot.includes('Footer') && hot.length > 0 },
    ],
  };
}

const RESULT_TEXT: Record<GetResult['steps'][number]['result'], string> = { miss: '没有', range: '跳过，不读文件', filter: '跳过，不读数据块', absent: '读了数据块，没有', found: '找到', deleted: '墓碑：NotFound' };
const RESULT_TONE: Partial<Record<GetResult['steps'][number]['result'], Tone>> = { filter: 'amber', range: 'slate', found: 'green', deleted: 'red' };

function readBoard(key: string, result: GetResult): TableBoard {
  return {
    kind: 'table',
    title: `Get(${key})`,
    sub: result.value ? `= ${str(result.value)}` : 'NotFound',
    columns: ['位置', '键范围', '检查', '结果'],
    widths: [110, 140, 330, 240],
    rows: result.steps.map((s) => {
      const range = s.file ? `${short(userOf(s.file.smallest))} .. ${short(userOf(s.file.largest))}` : '内存';
      const check = s.result === 'miss' ? '跳表里查找' : s.result === 'range' ? `${short(enc(key))} 不在键范围里` : s.result === 'filter' ? '过滤器有一位是 0' : '过滤器说可能有，读数据块';
      const found = s.result === 'found' && s.probe?.entry ? `${RESULT_TEXT.found} ${str(s.probe.entry.value)}（序列号 ${parseInternalKey(s.probe.entry.key).seq}）` : RESULT_TEXT[s.result];
      return { cells: [s.where, range, check, found], hot: RESULT_TONE[s.result], muted: s.result === 'range' };
    }),
  };
}

const walRecordsSize = (w: WriteResult): number => w.records.reduce((sum, r) => sum + r.bytes.length, 0);

function written(w: WriteResult): void {
  if (w.switched) walRows = [];
  walRows.push({ key: str(w.op.key), seq: w.seq, type: w.op.type });
}

// ---------- 第 1 步：先写日志，再进 MemTable ----------
const initialLsm = lsmBoard('课程开始前：键省略了前缀 acct:');
const initialSkip = skipBoard(db.mem, '空的');
const w1 = db.put('acct:ann', '120');
written(w1);
const s1Wal = lsmBoard('追加到日志', { wal: [w1.seq] });
const s1Mem = lsmBoard('插入 MemTable', { mem: [w1.seq] });
const s1Skip = skipBoard(db.mem, `ann 的高度是 ${w1.entry.height}`, w1.seq);

// ---------- 第 2 步：删除和覆盖也只是追加 ----------
const w2 = db.delete('acct:dan');
written(w2);
const s2Del = lsmBoard('删除写的是墓碑', { wal: [w2.seq], mem: [w2.seq] });
const w3 = db.put('acct:fay', '600');
written(w3);
const w4 = db.put('acct:cat', '330');
written(w4);
const s2Put = lsmBoard('cat 的旧版本还在 L0 和 L1', { wal: [w3.seq, w4.seq], mem: [w3.seq, w4.seq], keys: ['acct:cat'] });
const s2Skip = skipBoard(db.mem, `${db.mem.size} 个节点，满了`, w4.seq);
const fullMem = db.mem;

// ---------- 第 3 步：冻结，换日志，刷成 L0 文件 ----------
const w5 = db.put('acct:ivy', '900');
written(w5);
const switched = w5.switched!;
const s3Switch = lsmBoard(`冻结，换成 ${logName(switched.newLog)}`, { wal: [w5.seq], mem: [w5.seq], imm: true });
const s3Skip = skipBoard(db.mem, `新的 MemTable，ivy 的高度是 ${w5.entry.height}`, w5.seq);
const immCount = db.imm!.size;
const flushed = db.flush();
const file14 = flushed.file;
const t14 = file14.table;
const data14 = t14.dataHandles()[0];
const l0AfterFlush = db.levels[0].length;
const s3Flush = lsmBoard(`imm 写成 L0 #${file14.number}，${logName(flushed.obsoleteLog)} 可以删了`, { files: { [file14.number]: 'teal' } });

// ---------- 第 5 步：读 ----------
const readSeq = db.lastSeq;
const getBob = db.get('acct:bob');
const getDan = db.get('acct:dan');
const bobL1 = getBob.steps.find((s) => s.result === 'found')!;
const bobL0 = getBob.steps.find((s) => s.result === 'filter')!;
const danHit = getDan.steps.find((s) => s.result === 'deleted')!;
const rangeSkip = getBob.steps.find((s) => s.result === 'range')!;
const bobProbe = policy.probes(enc('acct:bob'), (t14.filter.filters[0].bytes.length - 1) * 8);
const zeroBit = bobProbe.find((pos) => !(t14.filter.filters[0].bytes[pos >> 3] & (1 << (pos & 7))))!;
if (rangeSkip.file!.number !== fileL0.number || bobL1.file!.number !== fileL1.number || bobL0.file!.number !== file14.number || danHit.file!.number !== file14.number) throw new Error('读路径和课程叙述不一致');

// ---------- 第 6 步：合并 ----------
const l0Before = db.levels[0].length;
const s6Before = lsmBoard(`L0 的 ${l0Before} 个文件和 L1 的 #${fileL1.number} 范围重叠`, { files: Object.fromEntries([...db.levels[0], fileL1].map((f) => [f.number, 'slate' as Tone])) });
const compaction = db.compact();
if (compaction.inputs[0].length !== l0Before || compaction.inputs[1][0] !== fileL1) throw new Error('合并的输入和课程叙述不一致');
const output = compaction.outputs[0];
const dropped = compaction.rows.filter((r) => r.drop);
const kept = compaction.rows.filter((r) => !r.drop);
const s6After = lsmBoard(`L0 清空，L1 只剩 #${output.number}`, { files: { [output.number]: 'green' } });
const mergeCells = (rows: typeof compaction.rows, tone?: Tone): Cells =>
  rows.map((r) => {
    const k = parseInternalKey(r.ikey);
    const sub = r.drop === 'shadowed' ? `旧版 ${k.seq}` : r.drop === 'tombstone' ? `墓碑 ${k.seq}` : opText(k.type, k.seq);
    return { text: short(k.user), sub, hot: tone, muted: Boolean(r.drop) && !tone };
  });
const mergeBoard = (sub: string, done: boolean): LanesBoard => ({
  kind: 'lanes',
  title: '多路归并：按内部键排序',
  sub,
  cell: 62,
  labelWidth: 78,
  rows: [
    { label: '输入', cells: mergeCells(compaction.rows) },
    { label: '保留', cells: done ? mergeCells(kept, 'green') : [], hot: done },
    { label: '丢弃', cells: done ? mergeCells(dropped, 'red') : [], hot: done },
  ],
});
const inputFiles = compaction.inputs.flat();
const inputBytes = inputFiles.reduce((sum, f) => sum + f.table.bytes.length, 0);

export const lsm: Lesson = {
  id: 'lsm',
  name: 'LSM TREE',
  title: 'LSM 树',
  group: 'storage',
  layer: [1, 4],
  timeUnit: 'µs',
  nodes: ['wal', 'buffer', 'client', 'heap', 'heap2', 'bgwriter'],
  place: { wal: [80, 165], buffer: [240, 70], client: [400, 165], heap: [560, 70], heap2: [720, 165], bgwriter: [880, 70] },
  labels: {
    client: ['应用线程', 'DB::Put / Get'],
    wal: ['WAL', '.log 文件'],
    buffer: ['MemTable', '跳表'],
    heap: ['L0', '文件之间可重叠'],
    heap2: ['L1', '文件之间不重叠'],
    bgwriter: ['后台线程', '刷盘与合并'],
  },
  start: ['client', 'wal'],
  boards: {
    lsm: { rect: [20, 250, 900, 262], initial: initialLsm },
    detail: { rect: [20, 520, 900, 190], initial: initialSkip },
  },
  legend: [['violet', '写日志'], ['amber', 'MemTable'], ['teal', '写 SSTable'], ['blue', '读'], ['green', '读到 / 合并结果'], ['slate', '合并的输入'], [null, '字节与 LevelDB 1.23 的真实文件一致']],
  overview: {
    full: '写入只追加，读时逐层找，后台合并收拾旧版本',
    description: 'PostgreSQL 的堆页和 B+ 树都在原来的页上修改：找到那一页，改完写回原处。LSM 树反过来：写入先进日志和内存里的有序表，攒满了整块写成只读的 SSTable 文件，旧版本留给后台合并去丢。PostgreSQL 没有 LSM，这一课用 LevelDB 1.23，日志和表文件已与它写出的真实文件逐字节比对。',
    facts: [
      ['写入路径', 'WAL → MemTable（跳表）'],
      ['文件', 'SSTable，写完不再修改'],
      ['读路径', 'MemTable → L0 从新到旧 → L1 …'],
      ['过滤器', '布隆过滤器，每个键 10 位'],
      ['合并触发', 'L0 到 4 个文件（本课 2 个）'],
      ['用在', 'LevelDB、RocksDB、Cassandra'],
    ],
  },
  steps: [
    {
      title: '先写日志',
      desc: 'Put 先追加到 .log，再插入 MemTable',
      detail: `DBImpl::Write 把 Put(acct:ann, 120) 包成一个 WriteBatch，分配序列号 ${w1.seq}，作为一条 ${walRecordsSize(w1)} 字节的记录追加到 ${logName(w1.logNumber)}。然后插入 MemTable，这是一个按键排序的跳表。L1 里 ann 的旧值 100 没有被碰，新版本只是序列号更大。LevelDB 默认 sync = false，写进操作系统就返回，不等 fsync。`,
      facts: [['序列号', String(w1.seq)], ['日志记录', `7 字节头 + ${w1.batch.length} 字节 WriteBatch`], ['跳表高度', String(w1.entry.height)], ['函数', 'log::Writer::AddRecord、MemTable::Add']],
      events: [
        pk('client', 'wal', 'violet', 'AddRecord', [`seq ${w1.seq}`, 'Put acct:ann'], [0, 'WAL', `追加到 ${logName(w1.logNumber)}，偏移 ${w1.records[0].offset}`, walRecordsSize(w1)],
          wire(`${logName(w1.logNumber)} 的第一条记录`, 'mem', 'leveldb', ...logRecordLayers(w1.records[0]))),
        board('lsm', s1Wal),
        note('wal', 'sync = false：不等 fsync', 'amber'),
        show('buffer'),
        pk('client', 'buffer', 'amber', 'MemTable::Add', ['acct:ann = 120', `高度 ${w1.entry.height}`], [us(2), 'MEM', `插入跳表，序列号 ${w1.seq}`, w1.entry.encoded.length],
          wire('arena 里的记录，和指向它的跳表节点', 'mem', 'leveldb-mem', ...memEntryLayers(w1.entry))),
        board('lsm', s1Mem),
        board('detail', s1Skip),
      ],
    },
    {
      title: '删除也是追加',
      desc: '墓碑和新版本，旧数据原样不动',
      detail: `Delete(acct:dan) 不去找 dan 在哪个文件，只追加一条类型为 0 的记录，叫墓碑，值是空的。Put(acct:cat, 330) 也一样，直接插入序列号 ${w4.seq} 的新版本，L0 和 L1 里 cat 的两个旧版本原样留着。跳表按用户键升序、序列号降序排列，所以读的时候先碰到最新的版本。B+ 树的更新要先找到那一页再原地改，LSM 的写入不需要读任何东西。`,
      facts: [['墓碑', `dan，序列号 ${w2.seq}，类型 0`], ['cat 的版本', `${w4.seq}（新）、5、3`], ['MemTable', `${fullMem.size} 条，本课的上限`], ['排序', '用户键升序，序列号降序']],
      events: [
        pk('client', 'wal', 'violet', 'Delete', [`seq ${w2.seq}`, 'acct:dan'], [us(10), 'WAL', `墓碑：类型 0，没有值，${walRecordsSize(w2)} 字节`, walRecordsSize(w2)],
          wire('删除记录。WriteBatch 里只有类型和键', 'mem', 'leveldb', ...logRecordLayers(w2.records[0]))),
        pk('client', 'buffer', 'amber', '墓碑', ['acct:dan', '值为空'], [us(11), 'MEM', `插入墓碑，序列号 ${w2.seq}`, w2.entry.encoded.length],
          wire('tag 的低 8 位是 0：kTypeDeletion', 'mem', 'leveldb-mem', ...memEntryLayers(w2.entry, 'violet'))),
        board('lsm', s2Del),
        pk('client', 'wal', 'violet', 'AddRecord ×2', ['fay = 600', 'cat = 330'], [us(20), 'WAL', '两次 Put，各一条记录，紧挨着追加', walRecordsSize(w3) + walRecordsSize(w4)],
          wire('两条记录在文件里紧挨着，地址列是真实的文件偏移', 'mem', 'leveldb', ...logRecordLayers(w3.records[0]), ...logRecordLayers(w4.records[0]))),
        pk('client', 'buffer', 'amber', 'MemTable::Add', [opName(w4), `高度 ${w4.entry.height}`], [us(21), 'MEM', `cat 的新版本，序列号 ${w4.seq}，不覆盖旧版本`, w3.entry.encoded.length + w4.entry.encoded.length],
          wire('cat 的新记录。旧的 cat 在磁盘文件里，这里完全不知道', 'mem', 'leveldb-mem', ...memEntryLayers(w4.entry))),
        board('lsm', s2Put),
        board('detail', s2Skip),
        note('buffer', '满了', 'amber'),
      ],
    },
    {
      title: '冻结并刷盘',
      desc: 'MemTable 变成只读，后台写成 L0 文件',
      detail: `本课 MemTable 放 ${OPTIONS.memEntries} 条就满（默认按 write_buffer_size 4 MiB 算）。下一次写入 Put(acct:ivy) 时，MakeRoomForWrite 把它冻结成只读的 imm，换新日志 ${logName(switched.newLog)} 和新 MemTable，写入马上继续。后台线程把 imm 的 ${immCount} 条按顺序写成 ${tableName(file14.number)}：数据块里相邻的键共用前缀 acct:，只存不同的部分，每 ${OPTIONS.restartInterval} 条存一次完整的键作为重启点。这个文件和 L0 的 #${fileL0.number} 键范围重叠，只能放在 L0。`,
      facts: [['新日志', logName(switched.newLog)], ['新文件', `${tableName(file14.number)}，${t14.bytes.length} 字节`], ['重启点间隔', `本课 ${OPTIONS.restartInterval}，默认 16`], ['层', `L${file14.level}：${flushed.reason}`]],
      events: [
        pk('client', 'wal', 'violet', '换日志', [logName(switched.newLog), opName(w5)], [us(30), 'WAL', `MakeRoomForWrite：MemTable 满了，冻结并换日志`, walRecordsSize(w5)],
          wire(`新日志的第一条记录，偏移从 0 开始`, 'mem', 'leveldb', ...logRecordLayers(w5.records[0]))),
        board('lsm', s3Switch),
        pk('client', 'buffer', 'amber', '新 MemTable', [opName(w5), `高度 ${w5.entry.height}`], [us(31), 'MEM', '旧的成为 imm，写入进新的 MemTable', w5.entry.encoded.length],
          wire('新跳表的第一个节点。随机数生成器重新从 0xdeadbeef 开始', 'mem', 'leveldb-mem', ...memEntryLayers(w5.entry))),
        board('detail', s3Skip),
        show('heap', 'bgwriter'),
        note('bgwriter', 'CompactMemTable', 'navy'),
        pk('buffer', 'heap', 'teal', 'WriteLevel0Table', [`${immCount} 条`, `数据块 ${data14.size} 字节`], [us(800), 'SST', `imm 按键序写成 ${tableName(file14.number)} 的数据块`, data14.size + 5],
          wire(`${tableName(file14.number)} 的数据块：前缀压缩和重启点`, 'mem', 'leveldb', ...dataBlockLayers(t14.bytes, data14))),
        board('lsm', s3Flush),
        board('detail', sstBoard(file14, ['数据块'], '先写数据块')),
      ],
    },
    {
      title: 'SSTable 的尾部',
      desc: '过滤块、索引块，最后 48 字节的 footer',
      detail: `数据块后面是过滤块：${immCount} 个键不足 64 位按 64 位算，每个键用 ${policy.k} 个探针置位。元索引块记下过滤块的位置；索引块每个数据块一项，键是不小于块内最大键的最短串，这里只要 "${str(userOf(t14.index.entries[0].key))}"，值是 BlockHandle（偏移和长度，两个 varint）。文件最后 48 字节是 footer：两个 BlockHandle 补齐到 40 字节，再加 magic number。打开文件时先读 footer，再把索引块和过滤块读进内存缓存。`,
      facts: [['过滤块', `${t14.filterHandle.size} 字节，k = ${policy.k}`], ['索引键', `"${str(userOf(t14.index.entries[0].key))}" + 最大序列号`], ['footer', '48 字节'], ['magic', '0xdb4775248b80fb57']],
      events: [
        pk('buffer', 'heap', 'teal', '过滤块', [`${(t14.filter.filters[0].bytes.length - 1) * 8} 位`, `k = ${policy.k}`], [us(810), 'SST', 'FilterBlockBuilder：用户键去掉 tag 后算布隆过滤器', t14.filterHandle.size + 5],
          wire('每个键的 6 个探针都置成了 1', 'mem', 'leveldb', ...filterBlockLayers(t14.bytes, t14.filterHandle, policy, t14.entries().map((e) => ({ key: str(userOf(e.key)), inside: true }))))),
        board('detail', sstBoard(file14, ['过滤块'], '布隆过滤器')),
        pk('buffer', 'heap', 'teal', '元索引 + 索引', ['过滤器名 → 过滤块', `"${str(userOf(t14.index.entries[0].key))}" → 数据块`], [us(820), 'SST', '两个块都用 BlockBuilder 写，格式和数据块相同', t14.footer.metaindex.size + t14.footer.index.size + 10],
          wire('元索引块指向过滤块，索引块指向数据块', 'mem', 'leveldb', ...metaindexBlockLayers(t14.bytes, t14.footer.metaindex), ...indexBlockLayers(t14.bytes, t14.footer.index))),
        board('detail', sstBoard(file14, ['元索引块', '索引块'], '索引')),
        pk('buffer', 'heap', 'teal', 'Footer', ['48 字节', 'magic'], [us(830), 'SST', `写完 footer，${tableName(file14.number)} 共 ${t14.bytes.length} 字节，以后不再修改`, 48],
          wire('文件最后 48 字节', 'mem', 'leveldb', footerLayer(t14.bytes))),
        board('detail', sstBoard(file14, ['Footer'], `${t14.bytes.length} 字节，只读`)),
        note('heap', `L0 有 ${l0AfterFlush} 个文件`, 'amber'),
      ],
    },
    {
      title: '读路径',
      desc: '从新到旧逐层找，过滤器替你跳过文件',
      detail: `Get(acct:bob) 先查 MemTable，没有；再按文件号从新到旧查 L0。#${file14.number} 的键范围包含 bob，但过滤器第 ${zeroBit} 位是 0，所以 bob 一定不在这里，不用读数据块；#${fileL0.number} 的范围是 ${short(userOf(fileL0.smallest))} 到 ${short(userOf(fileL0.largest))}，直接跳过。L1 的文件互不重叠，二分找到唯一可能的 #${fileL1.number}，过滤器说可能有，才读数据块拿到 200。Get(acct:dan) 在 L0 #${file14.number} 就碰到墓碑，返回 NotFound，L1 里 dan 的旧值 400 不会被读到。`,
      facts: [['查找序列号', String(readSeq)], ['bob', `L1 #${fileL1.number}，值 200`], ['dan', `L0 #${file14.number} 的墓碑`], ['读放大', 'L0 的每个文件都可能要查']],
      events: [
        pk('client', 'buffer', 'blue', 'Get', ['acct:bob', 'MemTable 没有'], [us(1000), 'GET', `MemTable::Get：找序列号不大于 ${readSeq} 的 bob`, lookupKey(enc('acct:bob'), readSeq).length],
          wire('查 MemTable 用的键：序列号取当前最新', 'mem', 'leveldb-mem', lookupKeyLayer(lookupKey(enc('acct:bob'), readSeq)))),
        pk('client', 'heap', 'blue', `L0 #${file14.number}`, ['索引 → 数据块', `第 ${zeroBit} 位 = 0`], [us(1002), 'GET', '过滤器说一定没有：不读数据块', null],
          wire('索引块和过滤块已缓存在内存里，这一步没有磁盘读', 'mem', 'leveldb', ...filterBlockLayers(t14.bytes, t14.filterHandle, policy, [{ key: 'acct:bob', inside: false }]))),
        note('heap', `#${fileL0.number} 的范围不含 bob`, 'navy'),
        show('heap2'),
        pk('client', 'heap2', 'blue', `L1 #${fileL1.number}`, ['过滤器：可能有'], [us(1004), 'GET', `FindFile 找到 #${fileL1.number}，过滤器的 ${policy.k} 位都是 1`, null],
          wire(`#${fileL1.number} 的过滤块：bob 写入时置过这些位`, 'mem', 'leveldb', ...filterBlockLayers(fileL1.table.bytes, fileL1.table.filterHandle, policy, [{ key: 'acct:bob', inside: true }]))),
        board('detail', readBoard('acct:bob', getBob)),
        pk('heap2', 'client', 'green', '200', ['acct:bob @ 2'], [us(1060), 'IO', `读数据块，在重启点上二分后找到 bob`, fileL1.table.dataHandles()[0].size + 5],
          wire(`#${fileL1.number} 的数据块`, 'mem', 'leveldb', ...dataBlockLayers(fileL1.table.bytes, fileL1.table.dataHandles()[0]))),
        pk('client', 'heap', 'blue', 'Get', ['acct:dan'], [us(1100), 'GET', `MemTable 没有，L0 #${file14.number} 的过滤器说可能有`, null],
          wire('dan 在这个文件里，6 位都是 1', 'mem', 'leveldb', ...filterBlockLayers(t14.bytes, t14.filterHandle, policy, [{ key: 'acct:dan', inside: true }]))),
        pk('heap', 'client', 'green', 'NotFound', [`墓碑 @ ${w2.seq}`], [us(1150), 'IO', '碰到墓碑就停，不再往下层找', data14.size + 5],
          wire('数据块里 dan 的记录：类型 0，值长 0', 'mem', 'leveldb', ...dataBlockLayers(t14.bytes, data14))),
        board('detail', readBoard('acct:dan', getDan)),
      ],
    },
    {
      title: '合并',
      desc: 'L0 和 L1 归并，丢掉旧版本和墓碑',
      detail: `L0 有 ${l0Before} 个文件，到了本课的触发值（LevelDB 是 4）。后台线程选中 L0 里互相重叠的全部文件，加上 L1 里范围重叠的 #${fileL1.number}，按内部键多路归并。同一个用户键只留序列号最大的版本；dan 的墓碑压住了 L1 的旧值，更深的层里也没有 dan，所以墓碑本身也可以丢。${compaction.rows.length} 条输入剩 ${kept.length} 条，写成新的 L1 #${output.number}，再用一条 VersionEdit 一次换掉 ${compaction.deleted.length} 个旧文件。`,
      facts: [['输入', `${inputFiles.length} 个文件，${inputBytes} 字节`], ['丢弃', `${dropped.length} 条（${dropped.filter((r) => r.drop === 'shadowed').length} 个旧版本，${dropped.filter((r) => r.drop === 'tombstone').length} 个墓碑）`], ['输出', `L1 #${output.number}，${output.table.bytes.length} 字节`], ['函数', 'DoCompactionWork']],
      events: [
        board('lsm', s6Before),
        pk('heap', 'bgwriter', 'slate', 'L0 输入', compaction.inputs[0].map((f) => `#${f.number}`), [us(5000), 'MERGE', 'PickCompaction：L0 的文件互相重叠，全部拉进来', compaction.inputs[0].reduce((sum, f) => sum + f.table.bytes.length, 0)],
          wire('选文件只看每个文件的最小键和最大键，它们记在 MANIFEST 里', 'vals', '示意', concept('Compaction 的输入', [
            ...inputFiles.map((f): [string, string, string] => [`L${f.level} #${f.number}`, `${str(userOf(f.smallest))} .. ${str(userOf(f.largest))}`, f.level === 0 ? 'L0 的文件之间可以重叠。' : '和 L0 输入的范围重叠，也要一起重写。']),
            ['合并后的层', `L${compaction.level + 1}`, ''],
          ], 'slate'))),
        pk('heap2', 'bgwriter', 'slate', 'L1 输入', compaction.inputs[1].map((f) => `#${f.number}`), [us(5010), 'MERGE', 'SetupOtherInputs：L1 里范围重叠的文件', compaction.inputs[1].reduce((sum, f) => sum + f.table.bytes.length, 0)],
          wire(`L1 #${fileL1.number} 的数据块，ann、cat、dan 都有更新的版本`, 'mem', 'leveldb', ...dataBlockLayers(fileL1.table.bytes, fileL1.table.dataHandles()[0]))),
        board('detail', mergeBoard(`${compaction.rows.length} 条，用户键升序、序列号降序`, false)),
        board('detail', mergeBoard(`留 ${kept.length} 条，丢 ${dropped.length} 条`, true)),
        pk('bgwriter', 'heap2', 'green', `写 L1 #${output.number}`, [`${kept.length} 条`, `${output.table.bytes.length} 字节`], [us(5600), 'SST', `新文件 ${tableName(output.number)}，和 L1 其他文件不重叠`, output.table.bytes.length],
          wire('输出文件的数据块。dan 已经彻底消失', 'mem', 'leveldb', ...dataBlockLayers(output.table.bytes, output.table.dataHandles()[0]))),
        board('lsm', s6After),
        pk('bgwriter', 'heap2', 'green', 'LogAndApply', [`删 ${compaction.deleted.length} 个`, `加 #${output.number}`], [us(5700), 'MERGE', 'VersionEdit 追加到 MANIFEST，之后删除旧文件', null],
          wire('VersionEdit 记的是文件的增删，不是数据', 'vals', '示意', concept('VersionEdit', [
            ...compaction.deleted.map(([level, number]): [string, string, string] => ['删除文件', `L${level} #${number}`, '']),
            ['新增文件', `L${output.level} #${output.number}`, `${str(userOf(output.smallest))} .. ${str(userOf(output.largest))}`],
            ['生效', '原子的', '正在读旧文件的查询继续读旧版本，读完才真正删除。'],
          ], 'green'))),
      ],
    },
  ],
  outro: {
    title: '只追加，靠合并还账',
    desc: '写入是顺序的，代价挪到了读和合并',
    text: 'B+ 树原地改页，读一次就能定位，写要随机写回整页。LSM 树只追加，写入全是顺序的；代价是读要查好几层（读放大），同一条数据要被合并重写好几次（写放大）。PostgreSQL 靠 VACUUM 清理堆里的旧版本，LSM 靠合并丢掉旧版本和墓碑。RocksDB 在 LevelDB 的基础上加了列族、多线程合并和更多的合并策略。',
    facts: [['通用', 'WAL + MemTable + 分层的只读文件'], ['LevelDB 细节', '前缀压缩、布隆过滤器、L0 触发值 4'], ['下一课', 'VACUUM']],
  },
};
