import { concept, dirEntry, ext4Inode, modeWord, statBuf, syscallRegs, userBytes, wire } from '../decode/structures';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const PATH = '/home/alice/notes.txt';
const HOME = 131073;
const ALICE = 1835009;
const INODE = 1835042;
const PER_GROUP = 8192;
const GROUP = Math.floor((INODE - 1) / PER_GROUP);
const INDEX = (INODE - 1) % PER_GROUP;
const BLOCK_SIZE = 4096;

export const pathlookup: Lesson = {
  id: 'pathlookup',
  name: 'PATH LOOKUP',
  title: '路径查找',
  group: 'io',
  layer: [4, 5],
  timeUnit: 'µs',
  nodes: ['app', 'kernel', 'k2', 'disk'],
  place: { app: [150, 210], kernel: [510, 360], k2: [560, 90], disk: [860, 540] },
  labels: {
    app: ['bash', 'PID 1204 · 用户 alice'],
    kernel: ['内核', 'VFS + ext4'],
    k2: ['dcache', '目录项缓存'],
    disk: ['NVMe SSD', 'ext4'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['amber', '查 dcache'], ['slate', '未命中'], ['teal', '读元数据'], ['green', '命中与返回']],
  overview: {
    full: '把一个路径变成一个 inode',
    description: '几乎每个文件操作都从路径查找开始。内核把路径按 / 切成几段，每一段先确认有权限穿过当前目录，再查目录项缓存 dcache。全部命中时一路不加锁，不到一微秒；有一段不在缓存里，就要读目录块和 inode 表。这一课跟踪 test -f 查一个文件是否存在，最后一段未命中。',
    facts: [
      ['平台', 'Linux 6.12，ext4'],
      ['调用', 'newfstatat（262）'],
      ['核心函数', 'path_lookupat'],
      ['缓存', 'dcache，以父目录和名字为键'],
      ['首选模式', 'RCU 遍历，不加锁'],
      ['目录权限', '需要 x 才能穿过'],
    ],
  },
  steps: [
    {
      title: '发起调用',
      desc: 'newfstatat 把路径交给 VFS',
      detail: 'test -f 调用 glibc 的 stat()，在 x86-64 上它发起 newfstatat。内核先用 getname 把路径字符串从用户内存拷进来，最长 4096 字节。路径以 / 开头，所以从进程的根目录出发；相对路径则从当前目录出发。path_lookupat 先尝试 RCU 模式：不加锁，也不改引用计数，只要途中没有人修改目录，就能一口气走完。',
      facts: [['调用号', '262 = newfstatat'], ['路径上限', '4096 字节（PATH_MAX）'], ['起点', '/ 开头从根目录，否则从当前目录'], ['首选模式', 'RCU，不加锁']],
      events: [
        type(`test -f ${PATH}`),
        pk('app', 'kernel', 'blue', 'newfstatat', [`"${PATH}"`], [0, 'SYSCALL', `newfstatat(AT_FDCWD, "${PATH}", &st, 0)`, 'reg'],
          wire('glibc stat() 发起的系统调用', 'regs', 'abi', syscallRegs(262, 'newfstatat', [
            ['rdi', -100, 'dirfd：AT_FDCWD。路径是绝对路径，所以用不到它。'],
            ['rsi', 0x55d0c2a1b6e0n, 'pathname。', { example: true }],
            ['rdx', 0x7ffd3c21a3a0n, 'statbuf：结果写到这里。', { example: true }],
            ['r10', 0, 'flags：0，最后一段是符号链接时跟随它。'],
          ]))),
        pk('app', 'kernel', 'blue', '拷贝路径', [`${PATH.length} 字节`], [300, 'MEM', 'getname：把路径拷进内核', PATH.length],
          wire('用户内存里的路径字符串，结尾的 0 不计', 'mem', 'abi', userBytes('路径', PATH, 'blue'))),
        state('kernel', { 模式: 'RCU', 当前: '/' }),
      ],
    },
    {
      title: '逐级查找',
      desc: '每一段先查权限，再查 dcache',
      detail: 'link_path_walk 按 / 把路径切成 home、alice、notes.txt 三段。每走一段，先确认对当前目录有 x 权限，再用父目录和名字算出哈希，在 dcache 里查找。home 和 alice 最近有人用过，都命中，没有碰磁盘。注意检查的是目录的 x 位而不是 r 位：x 允许穿过目录，r 才允许列出目录内容。',
      facts: [['分段', 'home / alice / notes.txt'], ['哈希键', '父目录 + 名字'], ['目录权限', '需要 x'], ['home、alice', '都命中 dcache']],
      events: [
        show('k2'),
        pk('kernel', 'k2', 'amber', '查 home', ['父目录 /'], [600, 'MEM', '/ 的 x 权限通过，dcache 命中 home', null],
          wire('dentry 是内核内部结构，这里只讲概念', 'regs', '示意', concept('dcache 查找', [
            ['父目录', '/', '权限 755，所有人都有 x。'],
            ['名字', 'home', ''],
            ['结果', '命中', `dentry 指向 inode ${HOME.toLocaleString('en-US')}。`],
          ], 'amber'))),
        pk('kernel', 'k2', 'amber', '查 alice', ['父目录 /home'], [800, 'MEM', '/home 的 x 权限通过，dcache 命中 alice', null],
          wire('dentry 是内核内部结构，这里只讲概念', 'regs', '示意', concept('dcache 查找', [
            ['父目录', '/home', '权限 755。'],
            ['名字', 'alice', ''],
            ['结果', '命中', `dentry 指向 inode ${ALICE.toLocaleString('en-US')}。`],
          ], 'amber'))),
        pk('k2', 'kernel', 'green', '权限检查', ['0750，x 通过'], [900, 'MEM', 'may_lookup：检查 /home/alice 的 x 权限', 2],
          wire('/home/alice 的 inode 已在内存里，直接读 i_mode', 'mem', 'abi', modeWord('/home/alice 的 i_mode', 0o40750, {
            owner: 'bash 的 UID 是 1000，正是属主，所以只看这一组。x 位为 1，可以穿过。',
            group: '属主匹配后，不再看同组和其他人。',
            other: '别的用户连穿过这个目录都不行，即使文件本身是 644。',
          }, '属主 UID 1000'))),
        state('kernel', { 模式: 'RCU', 当前: '/home/alice' }),
      ],
    },
    {
      title: '缓存未命中',
      desc: 'notes.txt 不在 dcache，读目录块',
      detail: 'notes.txt 不在 dcache 里。RCU 模式下不能睡眠，没法等磁盘，于是 try_to_unlazy 给已经走过的路径加上引用，换成 ref 模式继续，再调用 ext4_lookup。这个目录只有一块，ext4 在块里逐项比较名字；目录变大后，ext4 用 htree 哈希索引先定位到某一块。找到的目录项给出 notes.txt 的 inode 号。',
      facts: [['RCU 模式', '不能睡眠，换成 ref 模式'], ['文件系统', 'ext4_lookup'], ['小目录', '线性扫描'], ['大目录', 'htree 哈希索引']],
      events: [
        pk('k2', 'kernel', 'slate', '未命中', ['notes.txt'], [1100, 'MEM', 'dcache 中没有 notes.txt，退出 RCU 模式', null],
          wire('fs/namei.c 的处理', 'regs', '示意', concept('换模式', [
            ['RCU 模式', '放弃', '接下来要读盘，可能睡眠。'],
            ['ref 模式', '从当前位置继续', '已经走过的 dentry 加上引用计数，不用从头再走。'],
            ['加锁', '父目录 inode 的读锁', '防止查找期间目录被改。'],
          ], 'slate'))),
        state('kernel', { 模式: 'ref', 当前: '/home/alice' }),
        show('disk'),
        pk('disk', 'kernel', 'teal', '目录块', ['notes.txt'], [92000, 'BIO', 'ext4_find_entry：读 /home/alice 的目录块，逐项比较', BLOCK_SIZE],
          wire('目录块开头的 5 项', 'mem', 'abi',
            dirEntry(ALICE, '.', 12, { fileType: 2, padded: true, color: 'slate' }),
            dirEntry(HOME, '..', 12, { fileType: 2, padded: true, color: 'slate' }),
            dirEntry(1835010, '.bashrc', 16, { padded: true, color: 'slate' }),
            dirEntry(1835011, '.profile', 16, { padded: true, color: 'slate' }),
            dirEntry(INODE, 'notes.txt', BLOCK_SIZE - 12 - 56, { padded: true, recNote: '最后一项一直延伸到块尾的 12 字节校验区之前。' }))),
      ],
    },
    {
      title: '读 inode',
      desc: '按 inode 号算位置，读 inode 表',
      detail: `ext4_iget 按 inode 号算位置：块组号是（inode 号 - 1）÷ 每组 inode 数，组内序号是余数。块组描述符给出这一组 inode 表的起始块，加上序号乘以 256 字节，就是要读的位置。读出的 ext4_inode 转成内存里的 struct inode，新的 dentry 指向它，一起加入 dcache。如果文件不存在，内核也会缓存一个负 dentry，下次直接返回 ENOENT。`,
      facts: [['inode 号', INODE.toLocaleString('en-US')], ['块组', `${GROUP}（每组 ${PER_GROUP} 个）`], ['组内序号', String(INDEX)], ['位置', `inode 表第 ${Math.floor((INDEX * 256) / BLOCK_SIZE)} 块，偏移 ${(INDEX * 256) % BLOCK_SIZE}`]],
      events: [
        pk('disk', 'kernel', 'teal', 'inode', [`#${INODE}`], [180000, 'BIO', '读 inode 表，得到 ext4_inode', 256],
          wire('布局见 kernel.org 的 ext4 磁盘格式文档', 'mem', 'abi', ext4Inode({ mode: 0x81a4, size: 11, links: 1, blocks: 8, extent: { logical: 0, length: 1, start: 34816 } }))),
        pk('kernel', 'k2', 'green', '加入 dcache', ['notes.txt'], [182000, 'MEM', 'd_splice_alias：新 dentry 加入 dcache', null],
          wire('dentry 是内核内部结构，这里只讲概念', 'regs', '示意', concept('新的 dentry', [
            ['父目录', '/home/alice', ''],
            ['名字', 'notes.txt', ''],
            ['inode', INODE.toLocaleString('en-US'), '下次查找直接命中。'],
          ], 'green'))),
        state('k2', { 'notes.txt': '已缓存' }),
      ],
    },
    {
      title: '返回结果',
      desc: '填好 struct stat，写回用户内存',
      detail: 'stat 只读元数据，所以对 notes.txt 本身不需要任何权限，只要求路径上每一级目录都有 x。vfs_getattr 从 inode 取出各项，cp_new_stat 填成 144 字节的 struct stat 写回用户内存。test -f 只看 st_mode 的类型位是不是普通文件。再查一次同一路径时，三段都在 dcache 里，RCU 模式一口气走完，不到一微秒。',
      facts: [['文件本身的权限', '不需要'], ['结构大小', '144 字节'], ['test -f 看', 'st_mode 的类型位'], ['再查一次', '全部命中，不到 1 微秒']],
      events: [
        pk('kernel', 'app', 'green', 'stat 返回', ['rax = 0'], [190000, 'SYSRET', 'cp_new_stat：写回 struct stat', 144],
          wire('写回用户内存的结构，x86-64 布局', 'mem', 'abi', statBuf({ major: 259, minor: 2, ino: INODE, nlink: 1, mode: 0x81a4, uid: 1000, gid: 1000, size: 11, blocks: 8, time: 1780165693 }))),
        state('kernel', { 模式: null, 当前: null }),
        note('app', '普通文件，test 返回 0', 'green'),
        render,
      ],
    },
  ],
  outro: {
    title: '缓存让路径几乎免费',
    desc: '最慢的一次只发生在第一次',
    text: '路径越长，要查的段越多，每一段都要检查权限。dcache 把这件事变成几次哈希查找，RCU 模式又让它不必加锁，所以多核同时查同一个目录也不会互相阻塞。目录项和 inode 读进来之后，下一课读文件时就只剩下数据本身要从磁盘来了。',
    facts: [['全部命中', 'RCU 模式，不加锁'], ['任一段未命中', '换成 ref 模式，读盘'], ['下一课', 'FILE READ']],
  },
};
