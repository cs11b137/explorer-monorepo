import { heapPageLayers, heapTuple, lineArray, pageHeader, protocolMessage, wire } from '../decode/structures';
import { parseLsn } from '../engine/bytes';
import { queryMessage } from '../engine/protocol';
import { HeapPage } from '../engine/page';
import { board, note, pk, show, type as typed } from './dsl';
import { ACCOUNTS, pageBoard, us } from './shared';
import type { Lesson } from './types';

/** 和 tests/golden/heap-page.json 同一组操作：产出的字节已和 PostgreSQL 17 比对。 */
const XIDS = [744, 745, 746];
const ROWS: Array<[number, string, number]> = [[1, 'ann', 100], [2, 'bob', 200], [3, 'cat', 300]];
const SQL = "INSERT INTO accounts VALUES (1, 'ann', 100);";

const empty = new HeapPage(ACCOUNTS);
const one = empty.clone();
one.insert(ROWS[0], XIDS[0], parseLsn('0/19E0250'));
const two = one.clone();
two.insert(ROWS[1], XIDS[1], parseLsn('0/19E0298'));
const three = two.clone();
three.insert(ROWS[2], XIDS[2], parseLsn('0/19E02E0'));

const TITLE = '堆页 accounts/0 · 8192 字节';
const lp1 = one.page.lp(1);

export const heappage: Lesson = {
  id: 'heappage',
  name: 'HEAP PAGE',
  title: '页与元组布局',
  group: 'storage',
  layer: [2, 2],
  timeUnit: 'µs',
  nodes: ['client', 'backend', 'buffer', 'disk'],
  place: { client: [120, 70], backend: [360, 70], buffer: [600, 70], disk: [840, 70] },
  labels: {
    client: ['客户端', 'INSERT'],
    backend: ['后端进程', 'heap_insert'],
    buffer: ['缓冲池', '页在这里修改'],
    disk: ['磁盘', 'base/数据库/关系'],
  },
  start: ['client', 'backend'],
  boards: {
    page: { rect: [20, 165, 900, 225], initial: pageBoard(empty, { title: TITLE, sub: '空页' }) },
    bits: {
      rect: [20, 400, 900, 145],
      initial: { kind: 'kv', title: '为什么要这样布局', keyWidth: 190, rows: [
        { k: '行指针从前往后长', v: 'pd_lower 增大' },
        { k: '元组从后往前长', v: 'pd_upper 减小' },
        { k: '两者相遇', v: '页满了，换一页' },
        { k: 'TID = (页号, 行指针号)', v: '元组在页内移动时，索引不用改' },
      ] },
    },
  },
  legend: [['blue', '写入请求'], ['amber', '修改页面'], ['teal', '解读字节'], ['green', '落盘'], [null, '字节与真实页面逐字节一致']],
  overview: {
    full: '8 KiB 页里，行指针和元组从两头往中间长',
    description: '表文件被切成 8 KiB 的页。每页开头是 24 字节页头，后面是行指针数组，元组从页尾往前放，中间是空闲空间。这一课往空页插入三行，每一步的字节都由真实的写入器产生，并和 PostgreSQL 17 的 get_raw_page 结果比对过。',
    facts: [
      ['页大小', '8192 字节（BLCKSZ）'],
      ['页头', 'PageHeaderData，24 字节'],
      ['行指针', 'ItemIdData，4 字节位域'],
      ['元组头', 'HeapTupleHeaderData，23 字节'],
      ['对齐', '元组 MAXALIGN 到 8 字节'],
      ['取证', 'pageinspect 的 page_header、heap_page_items'],
    ],
  },
  steps: [
    {
      title: '一张空页',
      desc: 'pd_lower = 24，pd_upper = 8192',
      detail: '新页由 PageInit 初始化：pd_lower 指向页头之后，pd_upper 和 pd_special 都指向页尾。堆页不用特殊区；索引页会在页尾留一块。两个指针之间就是空闲空间，现在有 8168 字节。',
      facts: [['pd_lower', '24'], ['pd_upper', '8192'], ['pd_special', '8192'], ['版本', 'PG_PAGE_LAYOUT_VERSION = 4']],
      events: [
        typed(SQL),
        show('buffer'),
        pk('client', 'backend', 'blue', 'INSERT', [`${queryMessage(SQL).length} 字节`], [0, 'MSG', 'Query 消息', queryMessage(SQL).length],
          wire('客户端到后端', 'mem', 'protocol', protocolMessage(queryMessage(SQL)))),
        pk('backend', 'buffer', 'blue', 'PageInit', ['pd_lower 24', 'pd_upper 8192'], [us(90), 'PAGE', '分配新页并初始化页头', 24],
          wire('缓冲池里的新页，只有页头有内容', 'mem', 'disk', pageHeader(empty.page))),
      ],
    },
    {
      title: '插入第一行',
      desc: '元组放到页尾，行指针放到页头之后',
      detail: `这一行占 ${lp1.len} 字节：23 字节头补齐到 24，id 4 字节，'ann' 用 1 字节短 varlena 头加 3 字节，balance 4 字节。页上按 MAXALIGN 占 40 字节，所以 pd_upper 从 8192 降到 ${one.page.upper}。行指针占 4 字节，pd_lower 升到 ${one.page.lower}。`,
      facts: [['lp_len', String(lp1.len)], ['页内占用', '40 字节'], ['pd_lower', String(one.page.lower)], ['pd_upper', String(one.page.upper)]],
      events: [
        pk('backend', 'buffer', 'amber', 'heap_insert', ['1, ann, 100', `xmin ${XIDS[0]}`], [us(120), 'PAGE', `RelationPutHeapTuple → PageAddItem，放到偏移 ${lp1.off}`, lp1.len],
          wire(`pd_lower 和 pd_upper 已更新，元组在偏移 ${lp1.off}`, 'mem', 'disk', ...heapPageLayers(one.page, ACCOUNTS, [1], 'pd_lower 和 pd_upper 变了'))),
        board('page', pageBoard(one, { title: TITLE, sub: '插入 1 行', hot: { 1: 'amber' } })),
      ],
    },
    {
      title: '再插两行',
      desc: '两个指针继续往中间走',
      detail: `第二行放在第一行前面，偏移 ${two.page.lp(2).off}；第三行在 ${three.page.lp(3).off}。行指针的编号是稳定的，元组可以移动。第三行之后还剩 ${three.page.upper - three.page.lower} 字节空闲。放不下一个新元组时，就从空闲空间映射（FSM）找别的页。`,
      facts: [['行指针数', '3'], ['空闲', `${three.page.upper - three.page.lower} 字节`], ['单行上限', 'MaxHeapTupleSize = 8160，再大走 TOAST']],
      events: [
        pk('backend', 'buffer', 'amber', 'heap_insert', ['2, bob, 200'], [us(180), 'PAGE', `第 2 行放到偏移 ${two.page.lp(2).off}`, two.page.lp(2).len],
          wire('第二行', 'mem', 'disk', heapTuple(two.page, 2, ACCOUNTS)), { quick: true }),
        board('page', pageBoard(two, { title: TITLE, sub: '插入 2 行', hot: { 2: 'amber' } })),
        pk('backend', 'buffer', 'amber', 'heap_insert', ['3, cat, 300'], [us(240), 'PAGE', `第 3 行放到偏移 ${three.page.lp(3).off}`, three.page.lp(3).len],
          wire('第三行', 'mem', 'disk', heapTuple(three.page, 3, ACCOUNTS)), { quick: true }),
        board('page', pageBoard(three, { title: TITLE, sub: '插入 3 行', hot: { 3: 'amber' } })),
      ],
    },
    {
      title: '读懂行指针',
      desc: '4 字节里塞了偏移、状态和长度',
      detail: 'ItemIdData 是 32 位位域：低 15 位是偏移，接着 2 位是状态，高 15 位是长度。15 位足够表示 32 KiB 以内的任何位置。索引和 t_ctid 存的都是（页号，行指针号），不是字节偏移，所以 VACUUM 整理页面时只需改行指针。',
      facts: [['lp_off', '位 0–14'], ['lp_flags', '位 15–16，LP_NORMAL = 1'], ['lp_len', '位 17–31'], ['第 1 项', `${three.page.lp(1).off} / 1 / ${three.page.lp(1).len}`]],
      events: [
        board('bits', { kind: 'kv', title: '行指针 1 的 32 位', sub: '从页面字节解码', keyWidth: 190, rows: [
          { k: '原始值', v: `0x${(three.page.lp(1).off | (1 << 15) | (three.page.lp(1).len << 17)).toString(16)}` },
          { k: 'lp_off  位 0–14', v: `${three.page.lp(1).off} 元组在页内的偏移`, hot: 'teal' },
          { k: 'lp_flags 位 15–16', v: '1 LP_NORMAL（还有 UNUSED / REDIRECT / DEAD）', hot: 'teal' },
          { k: 'lp_len  位 17–31', v: `${three.page.lp(1).len} 元组长度，不含对齐填充`, hot: 'teal' },
        ] }),
        pk('buffer', 'backend', 'teal', '行指针数组', ['3 项，12 字节'], [us(280), 'PAGE', 'PageGetItemId：用行指针号找到元组', 12],
          wire('页内偏移 24 开始的 12 字节', 'mem', 'disk', lineArray(three.page))),
      ],
    },
    {
      title: '读懂元组头',
      desc: 'xmin、xmax 和 infomask 决定谁能看见',
      detail: `每个元组开头 23 字节：t_xmin、t_xmax、t_cid 共 12 字节，t_ctid 6 字节，两个掩码各 2 字节，t_hoff 1 字节。t_infomask 这里是 0x0802：有变长列，且没有有效的 xmax。t_hoff 是 24，因为要 MAXALIGN；这就是教科书说的“23 字节头”实际占 24 的原因。`,
      facts: [['t_xmin', String(XIDS[0])], ['t_ctid', '(0,1)，指向自己'], ['t_infomask', '0x0802'], ['t_infomask2', '3（3 列）']],
      events: [
        board('page', pageBoard(three, { title: TITLE, sub: '点轨迹里的事件可以看到每个字节', hot: { 1: 'teal' } })),
        pk('buffer', 'backend', 'teal', '元组 1', ['23 字节头', '12 字节数据'], [us(320), 'PAGE', '解读第一行的全部字节', three.page.lp(1).len],
          wire(`页内偏移 ${three.page.lp(1).off}。悬停字段可以看到对应的字节`, 'mem', 'disk', heapTuple(three.page, 1, ACCOUNTS))),
      ],
    },
    {
      title: '这一页何时落盘',
      desc: '提交时不写它，写的是 WAL',
      detail: '插入只改了缓冲池里的内存页，并把它标记为脏。数据页以后由后台写进程或检查点写出，提交时并不写它。pd_lsn 记着最后修改这页的 WAL 位置，写页之前必须先把 WAL 刷到那里。后面的 WAL COMMIT 和 CRASH RECOVERY 两课会展开。',
      facts: [['写出者', 'bgwriter、checkpointer 或后端进程'], ['规则', '先写 WAL，再写数据页'], ['写入单位', '整页 8 KiB']],
      events: [
        show('disk'),
        pk('buffer', 'disk', 'green', '写整页', ['8192 字节'], [us(50000), 'IO', '稍后由 checkpointer 写出，不在提交路径上', 8192],
          wire('写到 base/<数据库 OID>/<文件号> 的第 0 块', 'mem', 'disk', ...heapPageLayers(three.page, ACCOUNTS, [1, 2, 3], '整页写出，这里只展示有内容的部分'))),
        note('disk', '整页写入不是原子的', 'amber'),
      ],
    },
  ],
  outro: {
    title: '两头长的页',
    desc: '一层间接，换来元组可以移动',
    text: '定长块、行指针加元组（slotted page）是通用设计，MySQL InnoDB、SQL Server 都有类似结构。PostgreSQL 的特点是元组头里有 xmin 和 xmax：多版本直接存在堆页上，不靠 undo 日志。',
    facts: [['通用', 'slotted page'], ['PG 特有', '版本信息在元组头'], ['下一课', 'BUFFER POOL']],
  },
};
