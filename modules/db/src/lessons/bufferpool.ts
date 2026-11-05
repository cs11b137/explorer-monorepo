import { bufferDesc, values, wire } from '../decode/structures';
import { lsnText } from '../engine/bytes';
import { BufferPool, nameRel, tagText, type BufTag } from '../engine/buffer';
import type { TableBoard, Tone } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { framesBoard, us } from './shared';
import type { Lesson } from './types';

const REL = 16385;
nameRel(REL, 'accounts');
const tag = (block: number): BufTag => ({ spc: 1663, db: 16436, rel: REL, fork: 0, block });
const pool = new BufferPool(8);

type Snap = ReturnType<typeof framesBoard>;
const snap = (title: string, hot: Record<number, Tone> = {}, sub?: string): Snap => framesBoard(pool, title, hot, sub);
const log: TableBoard['rows'] = [];
const logBoard = (sub: string): TableBoard => ({ kind: 'table', title: '时钟指针走过的帧', sub, columns: ['帧', 'usage_count 之前', 'ref', '动作'], widths: [60, 130, 50, 340], rows: log.slice(-5) });
const emptyLog = logBoard('还没开始');
const TITLE = '缓冲池 · 8 帧（真实默认 128 MB = 16384 帧）';

// 第 1 步：把 0–7 号页读满，页面用完就放开。第 0 页多访问几次。
const initial = snap(TITLE, {}, '全空');
const a0 = pool.read(tag(0));
const descMiss = bufferDesc(pool, a0.frame);
pool.unpin(a0.frame);
const afterFirst = snap(TITLE, { [a0.frame]: 'amber' }, '未命中：用空闲帧');

const h0 = pool.read(tag(0));
const descHit = bufferDesc(pool, h0.frame, 'green');
const hitSnap = snap(TITLE, { [h0.frame]: 'green' }, '命中：钉住，usage_count + 1');
pool.unpin(h0.frame);
const unpinSnap = snap(TITLE, { [h0.frame]: 'green' }, '放开：ref 减 1，usage_count 不变');

for (let block = 1; block < 8; block++) {
  const r = pool.read(tag(block));
  pool.unpin(r.frame);
}
for (const block of [1, 1, 3]) pool.unpin(pool.read(tag(block)).frame);
// 第 3 页被改过：脏，pd_lsn 是它最后一条 WAL 的结束位置。它的 usage 较高，所以第一次扫描不会选中它。
const DIRTY_LSN = 0x1a40838n;
const dirtyFrame = pool.lookup(tag(3))!.id;
pool.markDirty(dirtyFrame, DIRTY_LSN);
// 第 5 页被另一个进程钉着。
const pinnedFrame = pool.read(tag(5)).frame;
const fullSnap = snap(TITLE, {}, '满了：free 链表已空');

// 第 3 步：来一个不在池里的页。
const sweep1 = pool.read(tag(8));
for (const step of sweep1.sweep) {
  log.push({ cells: [String(step.frame), String(step.usage), String(step.ref), step.action === 'dec' ? 'usage_count 减 1，继续' : step.action === 'skip' ? '被钉住，跳过' : '等于 0：选它做牺牲帧'], hot: step.action === 'take' ? 'amber' : undefined });
}
const sweepSnap = snap(TITLE, { [sweep1.frame]: 'amber' }, `换出 ${tagText(sweep1.evicted?.tag ?? null)}，换入第 8 页`);
const sweepLog = logBoard(`${sweep1.sweep.length} 步找到帧 ${sweep1.frame}`);
// 检查器显示的是当时的状态，所以现在就解码，后面的操作不会影响它。
const descPinned = bufferDesc(pool, pinnedFrame, 'slate');
const descSweep = bufferDesc(pool, sweep1.frame, 'amber');
const descRead = bufferDesc(pool, sweep1.frame, 'blue');
pool.unpin(sweep1.frame);

// 第 4 步：继续读，直到牺牲帧是脏页。
const before = [] as Array<ReturnType<BufferPool['read']>>;
let victim = pool.read(tag(9));
before.push(victim);
let guard = 10;
while (!victim.evicted?.dirty && guard < 40) {
  pool.unpin(victim.frame);
  victim = pool.read(tag(guard));
  before.push(victim);
  guard += 1;
}
for (const step of victim.sweep) {
  log.push({ cells: [String(step.frame), String(step.usage), String(step.ref), step.action === 'dec' ? 'usage_count 减 1，继续' : step.action === 'skip' ? '被钉住，跳过' : '等于 0：脏页，先写出才能换'], hot: step.action === 'take' ? 'red' : undefined });
}
const descVictim = bufferDesc(pool, victim.frame, 'slate');
const dirtySnap = snap(TITLE, { [victim.frame]: 'red' }, `牺牲帧 ${victim.frame} 是脏页`);
const dirtyLog = logBoard(`第 ${guard - 1} 页也要帧`);
pool.unpin(victim.frame);
if (!victim.evicted?.dirty) throw new Error('这一步的牺牲帧必须是脏页');
// 后台写进程只写 usage_count 为 0、没被钉住的脏页（SyncOneBuffer 的 skip_recently_used）。
const bgCandidate = Array.from({ length: pool.frames.length }, (_, i) => pool.frames[(pool.hand + i) % pool.frames.length]).find((f) => f.tag && f.ref === 0 && f.usage === 0);
if (!bgCandidate) throw new Error('时钟前方应该有 usage_count 为 0 的帧');
pool.markDirty(bgCandidate.id, 0x1a40898n);
const bgFrame = bgCandidate.id;
const beforeBg = snap(TITLE, { [bgFrame]: 'amber' }, '后台写进程先看到脏页');
const bgDesc = bufferDesc(pool, bgFrame, 'amber');
pool.frames[bgFrame].dirty = false;
const afterBg = snap(TITLE, { [bgFrame]: 'green' }, `帧 ${bgFrame} 变干净，页还在缓冲池里`);

export const bufferpool: Lesson = {
  id: 'bufferpool',
  name: 'BUFFER POOL',
  title: '缓冲区与时钟扫描',
  group: 'storage',
  layer: [3, 3],
  timeUnit: 'µs',
  nodes: ['backend', 'wal', 'buffer', 'bgwriter', 'disk'],
  place: { backend: [90, 70], wal: [280, 165], buffer: [470, 70], bgwriter: [660, 165], disk: [850, 70] },
  labels: {
    backend: ['后端进程', 'ReadBuffer'],
    wal: ['WAL', 'XLogFlush'],
    buffer: ['缓冲池', 'shared_buffers'],
    bgwriter: ['后台写进程', 'BgBufferSync'],
    disk: ['磁盘', '数据文件'],
  },
  start: ['backend', 'buffer'],
  boards: {
    frames: { rect: [20, 250, 900, 225], initial },
    log: { rect: [20, 483, 900, 190], initial: emptyLog },
  },
  legend: [['green', '命中'], ['blue', '读盘'], ['amber', '时钟扫描'], ['violet', '先写 WAL'], ['slate', '写脏页'], [null, '帧状态来自真实的算法运行']],
  overview: {
    full: '有限的内存帧，用时钟扫描决定换出谁',
    description: '所有读写都经过共享缓冲池，磁盘页要先读进一个帧才能用。帧用完时，时钟指针绕圈扫描：usage_count 大于 0 就减 1 并跳过，等于 0 且没人钉住才换出。这一课的格子由真实的 StrategyGetBuffer 算法驱动。',
    facts: [
      ['默认大小', 'shared_buffers = 128 MB'],
      ['帧大小', '8 KiB'],
      ['使用计数上限', 'BM_MAX_USAGE_COUNT = 5'],
      ['算法', '时钟扫描（clock sweep），不是 LRU'],
      ['函数', 'StrategyGetBuffer、ClockSweepTick'],
      ['状态字', 'BufferDesc.state，32 位原子变量'],
    ],
  },
  steps: [
    {
      title: '未命中',
      desc: '空闲帧还有，直接读盘',
      detail: 'ReadBuffer 先用（表空间、数据库、文件号、分支、块号）这个 BufferTag 查哈希表。没有就要一个帧：启动初期还有空闲链表，直接取。读盘之后 usage_count 置为 1，ref 置为 1，这个页就被钉住了。',
      facts: [['查找键', 'BufferTag，20 字节'], ['函数', 'BufTableLookup、BufferAlloc'], ['新页', 'usage = 1，ref = 1']],
      events: [
        pk('backend', 'buffer', 'blue', 'ReadBuffer', ['accounts/0'], [0, 'BUF', 'BufTableLookup 没找到：未命中', 20],
          wire('BufferTag：哈希表的键', 'mem', 'internal', descMiss)),
        show('disk'),
        pk('disk', 'buffer', 'blue', '读 8 KiB', ['accounts/0'], [us(100), 'IO', 'smgrread 把第 0 块读进帧 0', 8192],
          wire('帧 0 的 BufferDesc。state 里 ref = 1，usage = 1', 'mem', 'internal', descMiss)),
        board('frames', afterFirst),
      ],
    },
    {
      title: '命中',
      desc: '已在池里，只要加计数',
      detail: '第二次读同一页，哈希表直接命中，不碰磁盘。PinBuffer 用一次 CAS 把 refcount 和 usage_count 都加 1。放开时 ref 减 1，usage_count 保持不变，因为它要记住这一页最近被用过。',
      facts: [['usage_count', '加 1，封顶 5'], ['ref', '钉住期间不能被换出'], ['开销', '一次 CAS，不用读盘']],
      events: [
        pk('backend', 'buffer', 'green', 'PinBuffer', ['ref + 1', 'usage + 1'], [us(130), 'BUF', '命中：state 字加 1 个 ref 和 1 个 usage', 4],
          wire('state 这一个字同时放 ref、usage 和标志，所以一次 CAS 就够', 'mem', 'internal', descHit)),
        board('frames', hitSnap),
        board('frames', unpinSnap),
      ],
    },
    {
      title: '时钟扫描',
      desc: '帧用完了，指针开始转',
      detail: `所有帧都被占用后，指针逐帧前进：钉住的跳过，usage_count 大于 0 的减 1 继续，等于 0 的才被选中。常用的页 usage 高，要转好几圈才会被换出。这次走了 ${sweep1.sweep.length} 步才选中帧 ${sweep1.frame}。这比真正的 LRU 省事，不用每次访问都调整链表。`,
      facts: [['这次步数', String(sweep1.sweep.length)], ['换出', tagText(sweep1.evicted?.tag ?? null)], ['指针', `指向帧 ${sweep1.handAfter}`], ['全被钉住', '报错 no unpinned buffers available']],
      events: [
        board('frames', fullSnap),
        pk('backend', 'buffer', 'amber', 'StrategyGetBuffer', ['第 8 页', '要一个帧'], [us(200), 'BUF', `ClockSweepTick 走 ${sweep1.sweep.length} 步，选中帧 ${sweep1.frame}`, null],
          wire('被选中帧的描述符。帧 5 被钉住，指针经过时跳过', 'mem', 'internal', descPinned, descSweep)),
        board('log', sweepLog),
        board('frames', sweepSnap),
        pk('disk', 'buffer', 'blue', '读 8 KiB', ['accounts/8'], [us(310), 'IO', '读入第 8 页', 8192],
          wire('帧换了 tag', 'mem', 'internal', descRead)),
      ],
    },
    {
      title: '牺牲帧是脏页',
      desc: '要先刷 WAL，再写数据页',
      detail: `这次选中的帧 ${victim.frame} 是脏页，不能直接扔。FlushBuffer 先调用 XLogFlush，把 WAL 至少刷到这页的 pd_lsn（${lsnText(DIRTY_LSN)}），然后才写数据页。这就是预写日志规则：否则崩溃后可能找不到修改这页的日志。`,
      facts: [['牺牲帧', String(victim.frame)], ['pd_lsn', lsnText(DIRTY_LSN)], ['顺序', 'XLogFlush → smgrwrite'], ['后果', '查询可能要替别人写页']],
      events: [
        board('log', dirtyLog),
        board('frames', dirtySnap),
        show('wal'),
        pk('buffer', 'wal', 'violet', 'XLogFlush', [`到 ${lsnText(DIRTY_LSN)}`], [us(420), 'WAL', 'FlushBuffer：页 LSN 之前的 WAL 必须先落盘', null],
          wire('写数据页前先刷 WAL', 'vals', 'internal', values('FlushBuffer 的判断', [['recptr', DIRTY_LSN, 'BufferGetLSN：这一页的 pd_lsn。', { width: 8, shown: lsnText(DIRTY_LSN), example: true }]], 'violet'))),
        pk('buffer', 'disk', 'slate', '写脏页', [tagText(victim.evicted?.tag ?? null)], [us(1400), 'IO', `smgrwrite 写出 ${tagText(victim.evicted?.tag ?? null)}，帧 ${victim.frame} 可以复用`, 8192],
          wire('牺牲帧换了新 tag 之后的描述符', 'mem', 'internal', descVictim)),
        note('backend', '这次读操作被迫写了一页', 'amber'),
      ],
    },
    {
      title: '后台写进程',
      desc: '提前写脏页，让后端少等',
      detail: '让正在查询的后端写脏页很慢。后台写进程周期性地沿时钟前方扫描，把快要被换出的脏页先写掉，页还留在缓冲池里，只是变干净。它只负责腾干净帧。检查点是另一回事：由 checkpointer 把所有脏页写出，用来缩短崩溃恢复。',
      facts: [['函数', 'BgBufferSync'], ['间隔', 'bgwriter_delay = 200 ms'], ['每轮上限', 'bgwriter_lru_maxpages = 100'], ['不同于', 'checkpointer']],
      events: [
        show('bgwriter'),
        board('frames', beforeBg),
        pk('buffer', 'bgwriter', 'slate', '发现脏页', [`帧 ${bgFrame}`], [us(200000), 'BUF', '扫描时钟前方，找 usage 为 0 的脏页', null],
          wire('被后台写进程选中的帧，BM_DIRTY = 1', 'mem', 'internal', bgDesc)),
        pk('bgwriter', 'disk', 'green', '写出', [tagText(pool.frames[bgFrame].tag)], [us(200900), 'IO', '写出后清 BM_DIRTY，页仍在缓冲池', 8192],
          wire('写完之后 BM_DIRTY = 0', 'mem', 'internal', bufferDesc(pool, bgFrame, 'green'))),
        board('frames', afterBg),
      ],
    },
  ],
  outro: {
    title: '一个计数器代替一条链表',
    desc: '高并发下，不用每次访问都改全局结构',
    text: '缓冲池和换页是通用问题；PostgreSQL 的选择是时钟扫描加 0–5 的使用计数。大表顺序扫描会用环形缓冲区（BULKREAD 策略），只占 256 KiB，避免把常用页挤出去。操作系统还有自己的页缓存，所以同一页可能被缓存两次。',
    facts: [['通用', '缓冲置换'], ['PG 选择', '时钟扫描 + usage_count'], ['下一课', 'B+TREE']],
  },
};

