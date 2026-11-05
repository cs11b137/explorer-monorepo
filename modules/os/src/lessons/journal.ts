import { concept, ext4Superblock, jbd2Commit, jbd2Descriptor, jbd2Superblock, registers, syscallRegs, wire } from '../decode/structures';
import { note, pk, render, show, state, type } from './dsl';
import type { Lesson } from './types';

const TX = 48213;
const META_BLOCK = 655362;

export const journal: Lesson = {
  id: 'journal',
  name: 'JOURNAL',
  title: '日志',
  group: 'io',
  layer: [4, 4],
  timeUnit: 'ms',
  nodes: ['app', 'kernel', 'k2', 'disk'],
  place: { app: [120, 170], kernel: [400, 400], k2: [720, 130], disk: [800, 470] },
  labels: {
    app: ['dd', 'write 后 fsync'],
    kernel: ['ext4', '文件系统'],
    k2: ['jbd2', '日志线程'],
    disk: ['磁盘', '日志区与数据区'],
  },
  start: ['app', 'kernel'],
  legend: [['blue', '系统调用'], ['teal', '写日志'], ['green', '提交'], ['amber', '写回原位'], ['slate', '断电']],
  overview: {
    full: '断电后如何不把文件系统弄坏',
    description: '写一个文件要改好几处元数据：inode、位图、目录。断电可能发生在任意两次写之间，结果就是不一致。ext4 的做法是先把要改的元数据完整写进日志，确认写稳后才写回原位。崩溃后回放日志即可。这一课按默认的 data=ordered 模式走。',
    facts: [
      ['平台', 'Linux 6.12，ext4 + jbd2'],
      ['默认模式', 'data=ordered'],
      ['记入日志的', '元数据（数据不记）'],
      ['字节序', 'jbd2 用大端，ext4 用小端'],
      ['提交点', '提交块写稳'],
      ['恢复方式', '物理重做'],
    ],
  },
  steps: [
    {
      title: '记入事务',
      desc: '元数据变更加入运行中的事务',
      detail: 'write 只是修改页缓存中的页，并标记为脏，返回成功时数据还没有落盘。延迟分配甚至还没有决定它放在哪个块。之后的 fsync 要求确保落盘：ext4 分配块，把受影响的 inode 和位图等元数据加入 jbd2 的运行中事务。多个操作会合并在同一个事务里提交。',
      facts: [['write 返回时', '数据只在页缓存'], ['延迟分配', '写回时才定块'], ['fsync', '要求写稳'], ['事务', '合并多个操作']],
      events: [
        type('dd of=out.log conv=fsync'),
        pk('app', 'kernel', 'blue', 'fsync', ['fd = 3'], [0, 'SYSCALL', 'fsync(3)，要求数据落盘', 'reg'],
          wire('程序明确要求持久化', 'regs', 'abi', syscallRegs(74, 'fsync', [['rdi', 3, 'fd。']]))),
        show('k2'),
        pk('kernel', 'k2', 'teal', '加入事务', [`事务 #${TX}`], [1000000, 'SW', 'jbd2_journal_dirty_metadata：元数据加入运行中事务', null],
          wire('handle 和 transaction 是内核内部结构，这里只讲概念', 'regs', '示意', concept('运行中事务', [
            ['事务序号', String(TX), '单调递增。'],
            ['元数据块', 'inode 表块、块位图、目录块', '要改的块在内存中先复制一份。'],
            ['ordered 文件', 'out.log', '提交前必须先写好这个文件的数据。'],
          ], 'teal'))),
        state('k2', { 事务: `#${TX} 运行中` }),
      ],
    },
    {
      title: '提交数据',
      desc: 'ordered：数据先写到最终位置',
      detail: '这是 ordered 模式的关键。数据不写日志，直接写到它在磁盘上的最终位置，并在提交块之前确保写完。这样元数据永远不会指向尚未写入的数据块。严格说，数据和日志的写入可以同时进行，但提交块必须等它们全部完成。',
      facts: [['写入位置', '数据区（最终位置）'], ['写入日志吗', '不写'], ['保证', '元数据不指向垃圾']],
      events: [
        show('disk'),
        state('k2', { 事务: `#${TX} 提交中` }),
        pk('k2', 'disk', 'amber', '写文件数据', ['ordered'], [2000000, 'BIO', 'journal_submit_data_buffers：数据写到最终位置', 4096],
          wire('文件内容是用户数据，这里不展示字节', 'regs', 'internal', concept('写入', [
            ['目标', '文件在数据区的块', 'ext4 这时已为它分配了物理块。'],
            ['等待', '提交块之前等它完成', 'journal_finish_inode_data_buffers。'],
          ], 'amber'))),
      ],
    },
    {
      title: '写日志',
      desc: '描述符块加元数据副本',
      detail: 'jbd2 先写一个描述符块，里面的标签列出后面每个日志块对应磁盘上的哪个块，再写这些元数据块的完整副本。日志区就是一段顺序写入的环形空间。所有字段都是大端，魔数 0xC03B3998。如果元数据块开头正好是这个魔数，标签会打上 ESCAPE 标记，防止恢复时认错。',
      facts: [['魔数', '0xC03B3998，大端'], ['描述符块', '类型 1'], ['记录内容', '元数据块的完整副本'], ['写入方式', '顺序写']],
      events: [
        pk('k2', 'disk', 'teal', '描述符块', [`序号 ${TX}`], [3000000, 'BIO', '写入 jbd2 描述符块', 4096],
          wire('磁盘上的日志块，前 44 字节', 'mem', 'abi', jbd2Descriptor(TX, META_BLOCK))),
        pk('k2', 'disk', 'teal', '元数据副本', [`块 ${META_BLOCK.toLocaleString('en-US')}`], [3000000, 'BIO', '写入元数据块的完整副本', 4096],
          wire('内容就是将要写回原位的元数据', 'regs', '示意', concept('日志数据块', [
            ['内容', 'inode 表块的完整副本', '4096 字节。'],
            ['恢复时', '原样写回块 655362', '这就是「物理日志」的含义。'],
          ], 'teal'))),
      ],
    },
    {
      title: '提交块',
      desc: '提交块写稳，事务才算生效',
      detail: 'jbd2 等前面所有写入都完成后，才写提交块。它带 PREFLUSH 和 FUA：先把磁盘的易失性缓存刷下去，再确保提交块本身写到稳定存储。提交块写稳的那一刻，事务就生效了。此前崩溃，整个事务当作没发生；此后崩溃，日志回放能恢复它。fsync 到这里才返回。',
      facts: [['写入标志', 'REQ_PREFLUSH | REQ_FUA'], ['类型', '2'], ['提交点', '这个块写稳'], ['fsync', '现在才返回']],
      events: [
        pk('k2', 'disk', 'green', '提交块', ['FLUSH + FUA'], [8000000, 'BIO', '写提交块，这一刻事务生效', 4096],
          wire('fs/jbd2/commit.c：journal_submit_commit_record', 'mem', 'abi', jbd2Commit(TX, 1793847014n)), { locked: true }),
        state('k2', { 事务: `#${TX} 已提交` }),
        pk('kernel', 'app', 'green', 'fsync 返回', ['rax = 0'], [12000000, 'SYSRET', 'fsync 返回 0，数据已持久', 'reg'],
          wire('程序现在可以确信数据安全', 'regs', 'abi', registers('返回值', [['rax', 0, '0 表示成功。提交块已写稳。']], 'green')), { quick: true }),
      ],
    },
    {
      title: '检查点',
      desc: '元数据写回原位，释放日志空间',
      detail: '这时元数据只在日志里是新的，原位还是旧的。稍后写回线程把这些脏元数据写到最终位置。全部写完后，这段日志就没用了，可以复用，这叫检查点。jbd2 更新日志超级块，把起点向后移动。日志是环形的，不会无限增长。',
      facts: [['何时', '提交之后，异步进行'], ['写入', '元数据的最终位置'], ['释放', '日志空间可以复用'], ['更新', 'jbd2 超级块的 s_start']],
      events: [
        pk('kernel', 'disk', 'amber', '写回原位', [`块 ${META_BLOCK.toLocaleString('en-US')}`], [5000000000, 'BIO', '把元数据写回最终位置', 4096],
          wire('写回的内容和日志里的副本相同', 'regs', '示意', concept('检查点', [
            ['目标', '块 655362', '这才是 inode 的真正位置。'],
            ['写完之后', '日志中对应的条目可以丢弃', ''],
          ], 'amber'))),
        pk('k2', 'disk', 'teal', '更新日志头', ['s_start 前移'], [5001000000, 'BIO', '写日志超级块，释放日志空间', 1024],
          wire('日志区的第一块，前 44 字节', 'mem', 'abi', jbd2Superblock({ sequence: TX + 1, start: 1842, maxlen: 262144 }))),
        state('k2', { 事务: `#${TX} 已检查点` }),
      ],
    },
    {
      title: '崩溃恢复',
      desc: '扫描，撤销，重放',
      detail: '假设断电发生了。重启挂载时，ext4 看到超级块的 RECOVER 标志，知道上次没有干净卸载。jbd2 走三遍日志：SCAN 找到最后一个完整提交的事务；REVOKE 收集撤销记录，防止旧内容覆盖新内容；REPLAY 把元数据副本写回原位。没有提交块的事务直接丢弃，相当于从未发生。',
      facts: [['判断依据', 'RECOVER 标志'], ['三遍', 'SCAN → REVOKE → REPLAY'], ['未提交的事务', '丢弃'], ['恢复方式', '物理重做']],
      events: [
        pk('kernel', 'disk', 'slate', '断电', ['写入中断'], [9000000000, 'BIO', '事务写到一半时断电', null],
          wire('这一次写入没有完成', 'regs', '示意', concept('断电时的状态', [
            ['下一个事务', '只写了一部分，没有提交块', '恢复时会被丢弃。'],
            ['已提交的事务', '完整地留在日志里', '恢复时会重放。'],
          ], 'slate')), { lost: true }),
        note('disk', '断电，然后重启', 'amber'),
        pk('disk', 'kernel', 'teal', '读超级块', ['RECOVER'], [15000000000, 'BIO', '挂载时发现 RECOVER 标志', 1024],
          wire('ext4 超级块。ext4 的字段是小端，与日志相反', 'mem', 'abi', ext4Superblock(0x46))),
        pk('disk', 'k2', 'teal', '扫描日志', ['SCAN REVOKE'], [15010000000, 'BIO', 'jbd2_journal_recover：扫描日志，收集撤销记录', 1024],
          wire('恢复从日志超级块开始', 'mem', 'abi', jbd2Superblock({ sequence: TX + 1, start: 1842, maxlen: 262144 }))),
        pk('k2', 'disk', 'green', '重放', ['REPLAY'], [15040000000, 'BIO', '把已提交事务的元数据写回原位', 4096],
          wire('恢复的结果', 'regs', '示意', concept('重放', [
            ['已提交', '写回原位', '多写几遍也没有问题，结果相同。'],
            ['未提交', '丢弃', '这些操作的 fsync 从未返回过，所以不违背承诺。'],
          ], 'green'))),
        state('k2', { 事务: '恢复完成' }),
        render,
      ],
    },
  ],
  outro: {
    title: '提交块就是那条线',
    desc: '线的这边全部生效，那边全部作废',
    text: '日志把一组零散的写变成了原子操作，但并非没有代价：元数据被写两次，还要刷磁盘缓存，所以 fsync 很慢。而且 write 成功不代表落盘。需要持久化的程序一定要调用 fsync，SQLite 等数据库正是这样做的。',
    facts: [['写两次', '先日志，后原位'], ['write 成功', '不等于已落盘'], ['下一课', 'PIPE']],
  },
};
