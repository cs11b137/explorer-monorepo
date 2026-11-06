import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

/**
 * 节点是一次模型调用里的角色，14 节课共用这一份清单。每节课在 nodes 里挑自己用的，在 place 里摆位置。
 *
 * 有设备图形的节点（scene/devices.ts 里画了 art）可以挂状态面板（state 事件），也可以被 bump；
 * 其余是数据节点：没有固定外形，长相就是课程当前给它的数据结构图元（DsFrame 里的 row / grid / graph / tower）。
 * 数据节点不能挂状态面板（会和图元重叠），测试会检查。
 */
export const NODE_IDS = [
  // ---------- 设备 ----------
  'app', //       应用：调用 SDK 的业务代码和它的界面。带屏幕，render 事件逐行画出回复；命令框（type 事件）挂在它上方。
  'sdk', //       SDK 客户端：把参数序列化成 JSON、加鉴权和版本头、发 HTTP、解析响应、按 retry-after 重试。
  'net', //       网络：HTTPS 的 TLS 隧道。路上只能看到加密后的记录，看不到报文和密钥。
  'gateway', //   API 入口：校验 x-api-key 和请求字段、分配 request-id、返回 4xx / 5xx 错误、把请求交给模型。
  'rate', //      限流器：令牌桶，按 RPM / 输入 TPM / 输出 TPM 放行；超了返回 429 和 retry-after。
  'model', //     模型：读入展开后的整段 token，逐个生成输出 token（回复内容是示例，其余真实计算）。
  'tokenizer', // 分词器和 chat template：把 system、tools、messages 展开成一段带特殊 token 的文本，再切成 token、计数。
  'cache', //     提示缓存：按前缀字节的哈希存取已经算过的前缀，命中的部分按缓存读取计费。
  'tools', //     工具执行端：应用这一侧真正执行函数（查天气、查订单），把结果作为 tool_result 送回。
  'memory', //    记忆系统：把对话里值得长期保存的事实写下来，下次按相关度召回、注入上下文。
  'store', //     检索库：文档切块、建索引、按查询取回最相关的几块（RAG）。
  'compactor', // 压缩器：上下文快满时，把较早的历史交给模型写成摘要，替换原文。
  'subagent', //  子 Agent：主 Agent 把子任务交给它，它在自己干净的上下文里调用模型和工具，只把摘要交回。

  // ---------- 数据节点：外形由图元决定 ----------
  'request', //   请求：HTTP 头和 JSON 请求体的各个字段，或者某种写法（方言）的请求。
  'response', //  响应：JSON 响应体的字段（id、content、stop_reason、usage），或错误响应。
  'events', //    SSE 事件流：message_start、content_block_delta… 按到达顺序排开。
  'messages', //  消息列表：system 和一轮轮 user / assistant 消息，也就是对话历史。
  'prompt', //    展开后的提示：模板拼出的文本和 token 段，每段标出来自请求的哪一部分。
  'window', //    上下文窗口：各部分占多少 token、还剩多少、输出预留多少。
  'usage', //     用量和账单：input / output / 缓存读写的 token 数，按示例单价算出的费用。
  'docs', //      取回的内容：检索到的文档块、召回的记忆条目，等着被放进上下文。
  'schema', //    工具定义和 JSON Schema：函数名、参数结构、结构化输出的约束。
  'out', //       输出文本：流式拼出来的回复，或解析出的结构化结果。
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'CALL' //     应用调用 SDK，或 SDK 把结果交回应用
  | 'HTTP' //     HTTP 请求或响应
  | 'TLS' //      TLS 记录（加密后的字节）
  | 'JSON' //     JSON 请求体或响应体
  | 'SSE' //      SSE 事件
  | 'TEMPLATE' // chat template 展开
  | 'TOKENS' //   分词、计数
  | 'INFER' //    模型读入或生成
  | 'TOOL' //     工具调用或工具结果
  | 'CACHE' //    缓存查询、命中、写入
  | 'ERROR' //    错误响应
  | 'RETRY' //    重试、退避
  | 'BUDGET' //   上下文预算拆账
  | 'TRIM' //     截断
  | 'COMPACT' //  压缩
  | 'MEMORY' //   记忆写入或召回
  | 'RETRIEVE'; // 检索

export interface Row {
  /**
   * 到这个事件为止，这一课里模型累计处理的 token 数：读入的输入（含缓存读写）加上生成的输出。
   * 由 core/ 的真实计数得到（本站迷你分词器），必须单调不减，不能手写。模型还没读到请求之前是 0。
   */
  tokens: number;
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

/** 一排格子：字段、token 段、事件序列。axis 为 x 时格子沿右下延伸，为 y 时沿左下延伸。 */
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

/** 二维表：用量拆账、预算表。列沿 x，行沿 y。 */
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

/** 节点和边：调用链、工具往返、请求之间的共享前缀。 */
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

/** 一层层往上摞：消息列表、上下文窗口里的各部分。 */
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
  /** 只用于真实的失败：事件在半路中止并显示叉号（比如 429、529、上下文超限）。 */
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

/** 三个标签页：接口、提示、上下文工程。 */
export type LessonGroup = 'api' | 'prompt' | 'context';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 这课涉及的抽象层级区间，取 1–7 的闭区间，对应 site.ts 的 LAYER_NAMES。 */
  layer: [number, number];
  /** 写进层级色块提示里的一句话：这课为什么跨这几层。 */
  layerNote: string;
  /** 轨迹表「token」列这一课具体累计了什么，写进表头提示。 */
  tokensNote: string;
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

/** token 数的显示：千以上用 K、M，保留 3 位有效数字。 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const units: Array<[number, string]> = [[1e6, 'M'], [1e3, 'K']];
  const [scale, unit] = units.find(([value]) => tokens >= value)!;
  return `${+(tokens / scale).toPrecision(3)}${unit}`;
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
