/** 结构板的数据。全部是课程里真实算法的产物，这里只描述怎么显示。 */
export type Tone = 'blue' | 'green' | 'amber' | 'violet' | 'teal' | 'slate' | 'red' | 'none';

interface Base {
  title: string;
  /** 标题右侧的短说明。 */
  sub?: string;
}

/** 堆页或索引页：一条页面带（行指针从左长，元组从右长）和一张元组表。 */
export interface PageBoard extends Base {
  kind: 'page';
  size: number;
  lower: number;
  upper: number;
  special: number;
  lps: Array<{ n: number; off: number; len: number; flags: number; hot?: Tone }>;
  /** 按页内偏移从小到大。 */
  tuples: Array<{ lp: number; off: number; len: number; label: string; hot?: Tone; muted?: boolean }>;
  /** 元组表。没有就不画。 */
  columns?: string[];
  widths?: number[];
  rows?: Array<{ cells: string[]; hot?: Tone; muted?: boolean }>;
}

/** 缓冲池：帧、标签、使用计数、钉住计数、脏标记和时钟指针。 */
export interface FramesBoard extends Base {
  kind: 'frames';
  frames: Array<{ id: number; tag: string; usage: number; ref: number; dirty: boolean; hot?: Tone }>;
  hand: number;
  columns: number;
}

export interface BtNode {
  block: number;
  keys: Array<number | undefined>;
  high?: number;
  leaf: boolean;
  children: number[];
  hot?: Tone;
  /** 高亮的键下标。 */
  hotKey?: number;
}

/** B+ 树：按层排列的节点、下行链接和叶子的右链。 */
export interface BTreeBoard extends Base {
  kind: 'btree';
  levels: BtNode[][];
  /** 高亮的下行链接：[父块号, 子块号]。 */
  path?: Array<[number, number]>;
  footer?: string;
}

/** 快照：事务号数轴，每个格子是一个事务的状态，上面标出 xmin / xmax / xip。 */
export interface SnapshotBoard extends Base {
  kind: 'snapshot';
  from: number;
  to: number;
  status: Record<number, 'committed' | 'aborted' | 'running' | 'future'>;
  xmin?: number;
  xmax?: number;
  xip?: number[];
  me?: number;
  text?: string;
  /** 要指出来的那个事务。 */
  probe?: number;
  probeText?: string;
}

export interface TableBoard extends Base {
  kind: 'table';
  columns: string[];
  widths: number[];
  rows: Array<{ cells: string[]; hot?: Tone; muted?: boolean; strike?: boolean }>;
  note?: string;
}

/** 哈希表：每个桶一行链表，右边是写到临时文件的批。 */
export interface HashBoard extends Base {
  kind: 'hash';
  buckets: Array<Array<{ text: string; hot?: Tone }>>;
  hotBucket?: number;
  files?: Array<{ label: string; items: Array<{ text: string; hot?: Tone }> }>;
  footer?: string;
}

/** 通用的行-格子图：归并段、磁带、词法单元、CLOG 位、死元组列表都用它。 */
export interface LanesBoard extends Base {
  kind: 'lanes';
  rows: Array<{
    label: string;
    cells: Array<{ text: string; hot?: Tone; muted?: boolean; sub?: string; gap?: boolean }>;
    hot?: boolean;
  }>;
  cell?: number;
  labelWidth?: number;
  footer?: string;
}

/** 等待图：进程是节点，等待是有向边。 */
export interface GraphBoard extends Base {
  kind: 'graph';
  nodes: Array<{ id: string; label: string; sub?: string; tone?: Tone }>;
  edges: Array<{ from: string; to: string; label?: string; tone?: Tone }>;
  footer?: string;
}

/** WAL：一条记录带，标出 insert / flush / redo 指针，已落盘部分带底色。 */
export interface WalBoard extends Base {
  kind: 'wal';
  records: Array<{ lsn: string; label: string; size: number; tone?: Tone; durable: boolean; hot?: boolean; torn?: boolean; mark?: string }>;
  pointers: Array<{ name: string; lsn: string; tone?: Tone }>;
  footer?: string;
}

/** 缩进树：语法树。 */
export interface TreeBoard extends Base {
  kind: 'tree';
  rows: Array<{ depth: number; name: string; detail?: string; hot?: Tone }>;
}

/** 堆叠柱：代价的组成。 */
export interface BarsBoard extends Base {
  kind: 'bars';
  max: number;
  bars: Array<{ label: string; total: string; parts: Array<{ name: string; value: number; tone: Tone }>; winner?: boolean; hot?: boolean }>;
  footer?: string;
}

/** 键值列表：公式、控制文件、统计信息。 */
export interface KvBoard extends Base {
  kind: 'kv';
  rows: Array<{ k: string; v: string; hot?: Tone }>;
  keyWidth?: number;
}

export type BoardSpec = PageBoard | FramesBoard | BTreeBoard | SnapshotBoard | TableBoard | HashBoard | LanesBoard | GraphBoard | WalBoard | TreeBoard | BarsBoard | KvBoard;
