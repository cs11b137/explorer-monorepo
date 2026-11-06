import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

/**
 * 节点是一次检索增强问答里的角色，全部课程共用这一份清单（一次设计好，后面的课在 nodes 里挑自己用的，在 place 里摆位置）。
 *
 * 有设备图形的节点（scene/devices.ts 里画了 art）可以挂状态面板（state 事件），也可以被 bump；
 * 其余是数据节点：没有固定外形，长相就是课程当前给它的数据结构图元（DsFrame 里的 row / grid / graph / tower）。
 * 数据节点不能挂状态面板（会和图元重叠），测试会检查。
 */
export const NODE_IDS = [
  // ---------- 设备 ----------
  'app', //       应用：问答界面或客服 Agent，发出问题、显示带引用的回答。带屏幕，render 事件逐行画出；命令框（type 事件）挂在它上方。
  'docs', //      文档库：原始文档（规则、商品页、售后说明）放在这里，带元数据（分类、更新日期、状态）。
  'loader', //    加载器：读文档、去掉格式、抽出正文和元数据，交给切分器。
  'chunker', //   切分器：按固定长度、句子或递归规则把文档切成块，可以带重叠。
  'embedder', //  嵌入模型 / 嵌入 API：把一段文字变成定长向量（本站是 16 维 LSA，真实服务如 OpenAI embeddings、Voyage）。
  'index', //     向量库：存向量和 id，建索引（Flat、IVF、HNSW、PQ），按查询向量找最近的 k 个。
  'meta', //      元数据过滤器：按分类、日期、状态这类条件筛文档，在向量搜索之前（前过滤）或之后（后过滤）。
  'bm25', //      关键词索引：倒排表加 BM25 打分，按字面命中检索，和向量检索互补。
  'reranker', //  重排序器：对第一轮召回的候选逐个（查询，段落）打分，重新排序（真实的是交叉编码器模型）。
  'llm', //       大模型：读拼好的提示，写出带来源编号的回答；也可以改写查询（回答内容是示例）。
  'evaluator', // 评估器：拿标注的相关段落和参考答案，算 context precision / recall、faithfulness。

  // ---------- 数据节点：外形由图元决定 ----------
  'request', //   请求：HTTP 头和 JSON 请求体的字段（嵌入 API、Messages API）。
  'response', //  响应：JSON 响应体的字段（data[].embedding、usage……）。
  'text', //      文本：一篇文档或一个问题的原文和它的 UTF-8 字节。
  'chunks', //    块：切出来的块，每块的字符区间、token 数、重叠。
  'tokens', //    词：一段文本切出来的词（汉字二元组），在不在嵌入模型的词表里，权重多少。
  'vectors', //   向量：嵌入表里查出的词向量、池化后的向量、归一化后的向量，或一批段落的向量。
  'query', //     查询：用户的问题（或改写后的问题）和它的查询向量。
  'space', //     向量空间：向量投影到平面上的样子，IVF 的质心和簇、HNSW 的分层图都画在这里。
  'codes', //     码：量化后的向量，float16、int8 或 PQ 的 uint8 码字，以及 PQ 码本和 ADC 距离表。
  'results', //   检索结果：向量检索的前 k 个（id、分数、名次）。
  'keywords', //  关键词结果：BM25 的前 k 个和命中的词。
  'fused', //     融合结果：RRF 合并后的排名，或重排序后的排名。
  'prompt', //    提示：说明、带编号的资料、问题，每部分的 token 数。
  'answer', //    回答：模型写的回答（示例），每句标的来源编号和核对结果。
  'scores', //    分数和指标：相似度矩阵、召回率、评估指标。
  'truth', //     标注：评估用的问题、人工标注的相关段落和参考答案里的关键事实。
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'CALL' //     应用调用 SDK 或服务，或结果交回应用
  | 'HTTP' //     HTTP 请求或响应
  | 'JSON' //     JSON 请求体或响应体
  | 'LOAD' //     读文档、抽元数据
  | 'CHUNK' //    切分
  | 'TOKENS' //   分词、计数
  | 'EMBED' //    算嵌入：查表、池化、归一化
  | 'VECTOR' //   向量运算：相似度、编码、量化
  | 'TRAIN' //    训练：k-means、码本
  | 'INDEX' //    建索引、入库、插入
  | 'SEARCH' //   向量检索
  | 'KEYWORD' //  关键词检索（BM25）
  | 'FILTER' //   元数据过滤
  | 'FUSE' //     融合（RRF）
  | 'RERANK' //   重排序
  | 'PROMPT' //   拼提示
  | 'INFER' //    模型生成
  | 'CITE' //     核对引用
  | 'EVAL'; //    评估

export interface Row {
  /**
   * 到这个事件为止，这一课累计的距离计算次数（向量检索的核心成本，FAISS 统计里的 ndis），记账规则见 core/meter.ts。
   * 由 core/ 的 DistanceMeter 或计算结果得到，必须单调不减，不能手写。还没比较过任何向量时是 0。
   */
  dist: number;
  type: TraceType;
  info: string;
  /** 这次传递的字节数；null 表示没有数据传输（只是控制或概念）。 */
  size: number | null;
}

// ---------- 数据结构图元：纯数据，场景按它们画出当前形态 ----------

export type Tone = Color | 'dim' | 'empty' | 'head';

export interface DsCell {
  /** 显示的值。空串表示这一格没有数据。 */
  v: string;
  /** 值的身份。同一个 key 换了格子，动画就是它移动过去。 */
  key?: string;
  tone?: Tone;
  /** 抬高，表示正在被访问。 */
  lift?: boolean;
  /** 格子下方的小字，默认是下标。 */
  sub?: string;
  /**
   * 热度 0–1：格子顶面按它在底色和 tone 色之间渐变（没有 tone 时用蓝色）。
   * 窗口占用、缓存命中率这类「越大越重要」的数用它画成热力图。
   */
  heat?: number;
}

export interface DsMark {
  /** 指向第几格；图元是 graph 时指向节点 id。 */
  at: number | string;
  text: string;
  color?: Color;
  /** 标签向右平移的像素数，标签压住相邻格子时用；立杆仍立在目标格上。 */
  dx?: number;
}

/** 一排格子：向量的各个分量、切出来的块、检索结果。axis 为 x 时格子沿右下延伸，为 y 时沿左下延伸。 */
export interface RowPrim {
  kind: 'row';
  id: string;
  /** 相对节点中心的偏移，屏幕坐标。 */
  at?: [number, number];
  cells: DsCell[];
  marks?: DsMark[];
  axis?: 'x' | 'y';
  /** 沿 x 方向的格宽。 */
  w?: number;
  /** 沿 y 方向的格深。 */
  d?: number;
  /** 哪一格（可以是小数）对准中心。默认是中间那一格。 */
  center?: number;
  title?: string;
  /** 不显示下标。 */
  bare?: boolean;
}

/** 二维表：相似度矩阵、词向量表、ADC 距离表。列沿 x，行沿 y。 */
export interface GridPrim {
  kind: 'grid';
  id: string;
  at?: [number, number];
  rows: string[];
  cols: string[];
  cells: DsCell[][];
  w?: number;
}

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  v: string;
  sub?: string;
  tone?: Tone;
  lift?: boolean;
}

export interface GraphEdge {
  a: string;
  b: string;
  label?: string;
  tone?: Tone;
  arrow?: boolean;
}

/** 节点和边：向量空间里的点、质心、HNSW 的邻居边。 */
export interface GraphPrim {
  kind: 'graph';
  id: string;
  at?: [number, number];
  nodes: GraphNode[];
  edges: GraphEdge[];
  marks?: DsMark[];
  /** 节点半宽。 */
  r?: number;
}

/** 环形：格子排在地面的圆上。 */
export interface RingPrim {
  kind: 'ring';
  id: string;
  at?: [number, number];
  cells: DsCell[];
  marks?: DsMark[];
  radius?: number;
  w?: number;
}

export interface TowerFrame {
  key: string;
  text: string;
  tone?: Tone;
}

/** 一层层往上摞：提示里的各部分、HNSW 的层。 */
export interface TowerPrim {
  kind: 'tower';
  id: string;
  at?: [number, number];
  frames: TowerFrame[];
}

export type Prim = RowPrim | GridPrim | GraphPrim | RingPrim | TowerPrim;
export type DsFrame = Partial<Record<NodeId, Prim[]>>;

// ---------- 事件 ----------

export interface PacketEvent {
  type: 'packet';
  from: NodeId;
  to: NodeId;
  color: Color;
  label: string;
  payload: string[];
  row: Row;
  wire: Wire;
  /** 只用于真实的失败：事件在半路中止并显示叉号（比如检索没找到、引用对不上）。 */
  lost?: boolean;
  /** 需要独占的操作，标签上显示锁形图标。 */
  locked?: boolean;
  quick?: boolean;
  /** 事件完成后数据结构的样子。 */
  ds?: DsFrame;
  /** 事件从节点内的哪一点出发、到哪一点结束（相对节点中心），通常是某一格。 */
  fromAt?: [number, number];
  toAt?: [number, number];
}

export interface StreamEvent {
  type: 'stream';
  packets: PacketEvent[];
  spacing?: number;
}

export type LessonEvent =
  | PacketEvent
  | StreamEvent
  | { type: 'focus'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'show'; nodes: NodeId[]; frame?: NodeId[] }
  | { type: 'camera'; frame?: NodeId[] }
  | { type: 'type'; text: string }
  | { type: 'render' }
  | { type: 'note'; at: NodeId; text: string; tone?: 'navy' | 'green' | 'amber' }
  | { type: 'state'; node: NodeId; set: Record<string, string | null> }
  | { type: 'ds'; frame: DsFrame };

export interface Step {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: LessonEvent[];
}

/** 三个标签页：嵌入、向量检索、RAG 流水线。 */
export type LessonGroup = 'embed' | 'index' | 'pipeline';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 这课涉及的抽象层级区间，取 1–7 的闭区间，对应 site.ts 的 LAYER_NAMES。 */
  layer: [number, number];
  /** 写进层级色块提示里的一句话：这课为什么跨这几层。 */
  layerNote: string;
  /** 轨迹表「距离」列这一课具体累计了什么（以句号结尾），写进表头提示。 */
  distNote: string;
  nodes: NodeId[];
  /** 每个节点在该课场景里的位置。按课指定，避免通道穿过别的节点。 */
  place: Partial<Record<NodeId, [number, number]>>;
  labels: Partial<Record<NodeId, [string, string]>>;
  /** 数据节点的名称放在哪里，相对节点中心。 */
  labelAt?: Partial<Record<NodeId, [number, number]>>;
  /** 数据节点的通道裁切半径。 */
  radius?: Partial<Record<NodeId, number>>;
  /** 概览和第一个事件之前的数据结构。 */
  initial: DsFrame;
  start: NodeId[];
  legend: Array<[Color | null, string]>;
  overview: { full: string; description: string; facts: Fact[] };
  steps: Step[];
  outro: { title: string; desc: string; text: string; facts: Fact[] };
}

export type Timed = LessonEvent & { step: number };

export { labelOf, packetsOf };

/** 距离计算次数的显示：千以上用 K、M，保留 3 位有效数字。 */
export function formatDist(count: number): string {
  if (count < 1000) return String(count);
  const units: Array<[number, string]> = [[1e6, 'M'], [1e3, 'K']];
  const [scale, unit] = units.find(([value]) => count >= value)!;
  return `${+(count / scale).toPrecision(3)}${unit}`;
}

export function formatSize(size: Row['size']): string {
  if (size === null) return '—';
  if (size >= 1024 * 1024) return `${+(size / 1024 / 1024).toFixed(1)} MiB`;
  if (size >= 1024) return `${+(size / 1024).toFixed(1)} KiB`;
  return `${size} B`;
}

export const foldStates = (events: LessonEvent[], end: number) => engineFoldStates<NodeId>(events, end);

/** 从课程的初始形态开始，把前 end 个事件带来的数据结构变化折叠起来。只取决于事件序列，前进、后退、跳步结果一致。 */
export function foldDs(initial: DsFrame, events: LessonEvent[], end: number): DsFrame {
  const frame: DsFrame = { ...initial };
  for (const event of events.slice(0, end)) {
    const packets = event.type === 'packet' ? [event] : event.type === 'stream' ? event.packets : [];
    for (const packet of packets) if (packet.ds) Object.assign(frame, packet.ds);
    if (event.type === 'ds') Object.assign(frame, event.frame);
  }
  return frame;
}
