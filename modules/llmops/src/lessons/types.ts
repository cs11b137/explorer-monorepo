import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

/**
 * 节点是一个上线了的 AI 功能里的角色，全部课程共用这一份清单（一次设计好，后面的课在 nodes 里挑自己用的，在 place 里摆位置）。
 *
 * 有设备图形的节点（scene/devices.ts 里画了 art）可以挂状态面板（state 事件），也可以被 bump；
 * 其余是数据节点：没有固定外形，长相就是课程当前给它的数据结构图元（DsFrame 里的 row / grid / graph / tower）。
 * 数据节点不能挂状态面板（会和图元重叠），测试会检查。
 */
export const NODE_IDS = [
  // ---------- 设备 ----------
  'app', //       应用界面：用户在这里提问、看回答。带屏幕，render 事件逐行画出；命令框（type 事件）挂在它上方。
  'backend', //   客服后端：收用户的消息、调用防护层和限流、组装 Messages API 请求、调用模型、把回答交回界面。
  'guard', //     防护层：输入筛查（注入检测、内容审核、PII 脱敏）和输出检查（系统提示泄露、PII），决定拦截、改写还是放行。
  'llm', //       模型：Messages API 背后的大模型。写的内容是示例。
  'tools', //     工具执行端：查订单、查规则、建退货单（工具调用的评估和 trace 里的 execute_tool span 用）。
  'db', //        订单库：小铺的订单和退货单（共享包 llm-core 的场景数据）。
  'web', //       外部内容：网页、邮件、商品评价、工具读回的文档这类不可信的文字（间接注入的来源）。
  'limiter', //   限流器：按 user_id 给每个用户一个令牌桶或滑动窗口，记录屡次触发防护的用户。
  'harness', //   评估运行器：把评估集或攻击用例集逐条跑一遍，交给评分器，汇总通过率、攻击成功率和检验。
  'judge', //     评委模型：LLM 当评委，按评分标准给回答打分或二选一。写的理由是示例。
  'raters', //    人工标注员：几个人独立标同一批样本，用来算一致性、校准评委。
  'collector', // OpenTelemetry Collector：接收 OTLP/HTTP（/v1/traces，端口 4318），做采样和转发。
  'observe', //   可观测性后端：存 trace 和指标，查询、看板（Jaeger、Grafana 一类，本站不指定产品）。
  'alert', //     告警：指标连续超标时通知值班的人。

  // ---------- 数据节点：外形由图元决定 ----------
  'message', //   一条用户消息（或工具结果）：按规则命中、PII 命中切成的片段和它们的字节数。
  'rules', //     规则表：每条规则在每条消息上命中几次。
  'features', //  分类器的特征：出现的字符 n-gram 对分数的贡献（热力图）。
  'scores', //    分数和阈值：每个类别或每条消息的概率、阈值线、处置。
  'matrix', //    混淆矩阵 / 指标表：抓到、漏掉、误拦、放行，精确率、召回率。
  'dataset', //   数据集 / 评估集 / 攻击用例集：一条条用例和它们的标签。
  'results', //   逐用例的结果：过 / 不过、翻转、变好变坏。
  'request', //   请求：HTTP 头和 JSON 请求体的字段（Messages API、OTLP 导出）。
  'response', //  响应：content、stop_reason、usage。
  'buckets', //   每个用户的令牌桶水位、窗口里的请求数。
  'spans', //     span 树：一次请求里的 span，父子关系和耗时（瀑布图）。
  'ledger', //    账：每个 span 或每次调用的 token、费用、延迟。
  'latency', //   延迟分布：分位数、直方图桶。
  'metrics', //   监控指标：每个时间窗口的请求数、出错率、p95，告警阈值。
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'CALL' //     应用内部的函数调用，或结果交回
  | 'HTTP' //     HTTP 请求或响应（Messages API、OTLP/HTTP）
  | 'INFER' //    模型生成（内容是示例）
  | 'SCREEN' //   交给防护层筛查
  | 'RULE' //     规则匹配
  | 'SCORE' //    分类器打分
  | 'BLOCK' //    拦下
  | 'PASS' //     放行
  | 'REWRITE' //  改写或脱敏
  | 'CHECK' //    输出侧检查
  | 'LIMIT' //    限流决定
  | 'TOOL' //     执行工具
  | 'EVAL' //     评估：跑用例、评分、汇总
  | 'JUDGE' //    评委打分
  | 'LABEL' //    人工标注
  | 'STATS' //    统计：区间、检验、一致性
  | 'SPAN' //     开始或结束一个 span
  | 'EXPORT' //   导出 trace 或指标
  | 'SAMPLE' //   采样决定
  | 'ALERT' //    告警触发或恢复
  | 'ERROR'; //   错误

export interface Row {
  /**
   * 到这个事件为止，这一课里所有模型调用（客服回答、评委、筛查）的累计费用，单位纳美元（1e-9 美元），
   * 由 core/calls.ts 的 callModel 记账（cost.total 累加），必须单调不减，不能手写。还没有调用模型之前是 0。
   */
  cost: number;
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

/** 一排格子：消息历史、内容块、每轮的账。axis 为 x 时格子沿右下延伸，为 y 时沿左下延伸。 */
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

/** 二维表：每轮的 token 和费用、能力对照。列沿 x，行沿 y。 */
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

/** 节点和边：编排者和子任务、转交的关系。 */
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

/** 一层层往上摞：提示里的各部分、协议的分层。 */
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
  /** 只用于真实的失败：事件在半路中止并显示叉号（比如工具报错、请求被拒绝）。 */
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

/** 三个标签页：安全、评估、可观测性。 */
export type LessonGroup = 'safety' | 'eval' | 'observe';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 这课涉及的抽象层级区间，取 1–7 的闭区间，对应 site.ts 的 LAYER_NAMES。 */
  layer: [number, number];
  /** 写进层级色块提示里的一句话：这课为什么跨这几层。 */
  layerNote: string;
  /** 轨迹表「费用」列这一课具体累计了哪些调用（以句号结尾），写进表头提示。 */
  costNote: string;
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

/** 费用列的显示：纳美元 → 美元（llm-core 的 formatUsd：0 写成 $0，小于 1 美分保留 3 位有效数字）。 */
export { formatUsd as formatCost } from '@explorer/llm-core/pricing';

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
