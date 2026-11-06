import type { Decoded as EngineDecoded, Wire as EngineWire } from '@explorer/engine/decode/writer';

export { crc32, decode, hex, LayerWriter } from '@explorer/engine/decode/writer';
export type { BitWord, Byte, DecodedLayer, Field, FieldOptions } from '@explorer/engine/decode/writer';

export type Fidelity = 'disk' | 'protocol' | 'internal' | 'scaled' | 'leveldb' | 'leveldb-mem' | '示意';

export const FIDELITY_TEXT: Record<Fidelity, string> = {
  disk: '磁盘格式：布局由 PostgreSQL 17 头文件固定，写入器已与真实页面和 WAL 逐字节比对',
  protocol: '前后端协议 3.0：布局由官方文档固定，已与真实抓包比对',
  internal: '内存结构：只在进程内部使用，布局随版本变化，以 PostgreSQL 17 为准',
  scaled: '真实布局、缩小的页：字段和算法与 PostgreSQL 17 相同，只把 8 KiB 页缩小，方便一屏看全',
  leveldb: 'LevelDB 文件格式：按 LevelDB 1.23 源码编码，已与它写出的 .log 和 .ldb 文件逐字节比对（本课不压缩，block_restart_interval = 2）',
  'leveldb-mem': 'LevelDB 内存结构：MemTable 记录的编码和跳表高度与 LevelDB 1.23 相同；节点里的指针每次运行都不同，不展示',
  示意: '示意：只讲概念，不是真实内存布局',
};

export type Wire = EngineWire<Fidelity>;
export type Decoded = EngineDecoded<Fidelity>;
