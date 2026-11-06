import { foldStates as engineFoldStates, labelOf, packetsOf, type Color, type Fact } from '@explorer/engine/types';
import type { Wire } from '../decode/writer';

/**
 * 节点是一个 Agent 系统里的角色，全部课程共用这一份清单（一次设计好，后面的课在 nodes 里挑自己用的，在 place 里摆位置）。
 *
 * 有设备图形的节点（scene/devices.ts 里画了 art）可以挂状态面板（state 事件），也可以被 bump；
 * 其余是数据节点：没有固定外形，长相就是课程当前给它的数据结构图元（DsFrame 里的 row / grid / graph / tower）。
 * 数据节点不能挂状态面板（会和图元重叠），测试会检查。
 */
export const NODE_IDS = [
  // ---------- 设备 ----------
  'app', //       应用界面：用户在这里提问、看回答、点确认。带屏幕，render 事件逐行画出；命令框（type 事件）挂在它上方。
  'agent', //     Agent 运行时（循环 / harness）：组装请求、调用模型、执行工具、回填结果、判断停止、记账。多 Agent 组里是编排者。
  'llm', //       模型：Messages API 背后的大模型，读请求、写内容块（文字和 tool_use）。写的内容是示例。
  'tools', //     工具执行端：应用这一侧真正执行的函数（查订单、查规则、建退货单、退款），参数先按 JSON Schema 校验。
  'db', //        业务数据库：订单、退货单、退款记录（内存里的示例数据）。
  'policy', //    规则库：售后、退款、运费规则，search_policy 在这里做 BM25 检索。
  'client', //    MCP 客户端：宿主里的连接器，给请求编号、带上 _meta（协议版本、能力）、经传输发出去。
  'server', //    MCP 服务器：「小铺售后服务」，列出并执行工具、提供资源和提示模板。
  'authz', //     授权服务器：OAuth 2.1，给 MCP 客户端发访问令牌（Streamable HTTP 才用）。
  'subagent', //  子 Agent：编排者把子任务交给它，在自己干净的上下文里跑完一个循环，只交回结果。
  'subagent2', // 第二个子 Agent：和 subagent 并行做另一个子任务。
  'peer', //      接手的 Agent：转交（handoff）之后由它接着和用户对话，带着同一份历史、换成自己的 system 和工具。
  'guard', //     权限检查：工具执行前决定放行、拒绝或交给用户确认（最小权限、危险操作要人确认）。
  'web', //       外部内容：网页、邮件、第三方评价这类工具读回来的不可信文字（间接提示注入的来源）。

  // ---------- 数据节点：外形由图元决定 ----------
  'request', //   请求：HTTP 头和 JSON 请求体的字段（Messages API 或 MCP 的 POST）。
  'response', //  响应：JSON 响应体的字段（content、stop_reason、usage，或 JSON-RPC 的 result）。
  'messages', //  消息历史：一条条 user / assistant 消息和里面的内容块（text、tool_use、tool_result）。
  'toolset', //   工具定义：name、description、input_schema（JSON Schema），以及它们在提示里占的 token。
  'prompt', //    展开后的提示：system、工具、每条消息、模板开销各占多少 token。
  'calls', //     这一轮的 tool_use 块：工具名、参数、id。
  'results', //   tool_result 块：按 tool_use_id 回填的结果，is_error 标出失败。
  'usage', //     账：每一轮的输入 / 输出 token、累计、费用。
  'turns', //     循环状态：第几轮、每轮的 stop_reason、离最大轮数还有几轮。
  'rpc', //       JSON-RPC 消息：请求、响应、通知，id 和 method。
  'wire', //      传输上的字节：stdio 的一行行 JSON，或 HTTP 报文和 SSE 事件。
  'caps', //      版本和能力：_meta 里的协议版本、客户端能力，server/discover 返回的服务器能力。
  'catalog', //   服务器提供的东西：tools、resources、prompts 的列表。
  'tasks', //     子任务：编排者拆出的任务、交给谁、交回了什么。
] as const;
export type NodeId = (typeof NODE_IDS)[number];

export type { Color, Fact };

/** 轨迹表「类型」列的取值。 */
export type TraceType =
  | 'CALL' //     应用、运行时、SDK 之间的函数调用，或结果交回
  | 'HTTP' //     HTTP 请求或响应
  | 'JSON' //     JSON 请求体或响应体
  | 'TOKENS' //   数 token、拆账
  | 'INFER' //    模型生成（内容是示例）
  | 'TOOL' //     执行工具
  | 'RESULT' //   回填 tool_result
  | 'STOP' //     判断停止条件
  | 'RPC' //      JSON-RPC 请求或响应
  | 'NOTIFY' //   JSON-RPC 通知
  | 'STDIO' //    stdio 上的一行
  | 'SSE' //      SSE 事件
  | 'AUTH' //     授权：401、元数据、令牌
  | 'DISCOVER' // server/discover、能力和版本
  | 'DELEGATE' // 交给子 Agent
  | 'HANDOFF' //  转交给另一个 Agent
  | 'CONFIRM' //  人工确认
  | 'DENY' //     权限拒绝
  | 'ERROR'; //   错误

export interface Row {
  /**
   * 到这个事件为止，这一课里模型累计读入的输入 token（每一轮的 usage.input_tokens 之和，含工具系统提示），
   * 由 core/ 的 runAgent 记账（turn.after.input），必须单调不减，不能手写。模型还没读到请求之前是 0。
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

/** 三个标签页：Agent 循环、MCP 协议、多 Agent。 */
export type LessonGroup = 'loop' | 'mcp' | 'multi';

export interface Lesson {
  id: string;
  name: string;
  title: string;
  group: LessonGroup;
  /** 这课涉及的抽象层级区间，取 1–7 的闭区间，对应 site.ts 的 LAYER_NAMES。 */
  layer: [number, number];
  /** 写进层级色块提示里的一句话：这课为什么跨这几层。 */
  layerNote: string;
  /** 轨迹表「输入」列这一课具体累计了什么（以句号结尾），写进表头提示。 */
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
export function formatTokens(count: number): string {
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
