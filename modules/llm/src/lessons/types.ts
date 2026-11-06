import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

/**
 * 节点是一次推理里的角色，14 节课共用这一份清单。每节课在 nodes 里挑自己用的，在 place 里摆位置。
 *
 * 有设备图形的节点（scene/devices.ts 里画了 art）可以挂状态面板（state 事件），也可以被 bump；
 * 其余是数据节点：没有固定外形，长相就是课程当前给它的数据结构图元（DsFrame 里的 row / grid / graph / tower）。
 * 数据节点不能挂状态面板（会和图元重叠），测试会检查。
 */
export const NODE_IDS = [
  // ---------- 设备 ----------
  'client', //    应用：用户输入提示词、看到流式输出的那一端。带屏幕，render 事件逐行画出；命令框（type 事件）挂在它上方。
  'server', //    推理服务：HTTP API 入口（如 /v1/chat/completions），收请求、按 SSE 回流式响应。API 层的课用。
  'tokenizer', // 分词器：文本 ↔ token id，BPE 合并在这里发生。
  'sched', //     调度器：连续批处理里决定这一轮哪些请求进 GPU、给谁分配 KV 块、谁被抢占。
  'gpu', //       GPU：执行矩阵乘的计算单元和显存（HBM）。显存字节账、算力瓶颈都落在它身上。
  'weights', //   权重文件：磁盘上的 GGUF / safetensors，加载、量化课用。
  'sampler', //   采样器：logits → 惩罚 → temperature → top-k / top-p → 抽出下一个 token。
  'detok', //     反分词：token id → 字节 → 按 UTF-8 拼回文字；流式输出时暂存没收齐的字节。
  'grad', //      优化器：反向传播得到的梯度、按学习率更新参数（LoRA 只更新 A、B）。
  'vit', //       视觉投影：把图像 patch 展平、乘投影矩阵，变成和文本 token 同维的向量（多模态课）。

  // ---------- 数据节点：外形由图元决定 ----------
  'text', //      输入文本及其 UTF-8 字节。
  'image', //     输入图像：像素网格和切出的 patch（多模态课）。
  'tokens', //    token id 序列（模型真正的输入，int32 数组）。
  'vocab', //     词表 / 合并规则表。
  'embed', //     嵌入表 token_embd：每个 token 一行 d_model 维向量；也可以画 RoPE 前后的向量。
  'hidden', //    残差流：每个位置当前的隐藏向量 x，层与层之间传递的就是它。
  'norm', //      RMSNorm 的输入、缩放和输出。
  'attn', //      注意力：Q、K、V，分数矩阵、因果掩码、softmax 权重。
  'ffn', //       前馈网络（SwiGLU）：gate、up、激活、down。
  'kv', //        KV cache：每层每个位置的 K、V；分页时也画块表。
  'lmhead', //    输出层：最后的隐藏向量 × 输出矩阵 → 每个词表项一个 logit。
  'logits', //    logits 和概率分布（采样课的主角）。
  'queue', //     请求队列：批处理、前缀缓存课里排队的请求。
  'lora', //      LoRA 适配器：低秩矩阵 A、B 和它们的梯度。
  'out', //       已生成的输出文本（流式拼接的结果）。
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'TEXT' //    文本或字节在节点间传递
  | 'MERGE' //   BPE 合并
  | 'IDS' //     token id 序列
  | 'LOOKUP' //  查表（嵌入、词表）
  | 'MATMUL' //  矩阵乘
  | 'ATTN' //    注意力打分或加权
  | 'NORM' //    归一化
  | 'ACT' //     激活函数或逐元素运算
  | 'LOGITS' //  得到 logits
  | 'SAMPLE' //  采样选出 token
  | 'KV' //      写入或读取 KV cache
  | 'ALLOC' //   分配显存或 KV 块
  | 'FREE' //    释放
  | 'SCHED' //   调度决策
  | 'LOAD' //    从磁盘加载权重
  | 'QUANT' //   量化或反量化
  | 'GRAD' //    梯度或参数更新
  | 'HTTP' //    API 请求或响应
  | 'STREAM'; // 流式输出的一块

export interface Row {
  /**
   * 到这个事件为止，这一课累计的运算量。由课程里的真实计算统计，单位见 Lesson.opsUnit：
   * 模型类的课用 FLOPs（model/tensor.ts 的 FlopMeter，乘加算 2 次），分词课用合并表查询次数。
   */
  ops: number;
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
   * 注意力权重、概率这类「越大越重要」的数用它画成热力图。
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

/** 一排格子：向量、token 序列、字节串。axis 为 x 时格子沿右下延伸，为 y 时沿左下延伸。 */
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

/** 二维表：矩阵、注意力分数。列沿 x，行沿 y。 */
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

/** 节点和边：合并树、计算图、请求之间的共享前缀。 */
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

/** 一层层往上摞：Transformer 的层堆叠、显存占用。 */
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
  /** 只用于真实的失败：事件在半路中止并显示叉号（比如上下文超限、请求被抢占）。 */
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

export type LessonGroup = 'repr' | 'infer' | 'sample';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 这课涉及的抽象层级区间，取 1–7 的闭区间，对应 site.ts 的 LAYER_NAMES。 */
  layer: [number, number];
  /** 写进层级色块提示里的一句话：这课为什么跨这几层。 */
  layerNote: string;
  /** 轨迹表「运算量」这一课具体统计什么，写进表头提示。 */
  opsUnit: string;
  /** 运算量的短单位，时序图的间隔标签用，比如「FLOPs」「次查表」。 */
  opsShort: string;
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

/** 运算量的显示：千以上用 K、M、G，保留 3 位有效数字。 */
export function formatOps(ops: number): string {
  if (ops < 1000) return String(ops);
  const units: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'K']];
  const [scale, unit] = units.find(([value]) => ops >= value)!;
  return `${+(ops / scale).toPrecision(3)}${unit}`;
}

export function formatSize(size: Row['size']): string {
  if (size === null) return '—';
  if (size >= 1024 ** 3) return `${+(size / 1024 ** 3).toFixed(1)} GiB`;
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
