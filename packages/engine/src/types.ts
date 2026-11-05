import type { Wire } from './decode/writer';

/** 引擎只认识这几种事件。站点可以加自己的事件类型，引擎把它们交给场景插件处理。 */
export type Color = 'blue' | 'green' | 'amber' | 'violet' | 'teal' | 'slate';
export type Fact = [label: string, value: string];

export interface EventLike {
  type: string;
}

export interface RowLike {
  type: string;
  info: string;
  size: unknown;
}

export interface PacketLike<R extends RowLike = RowLike, N extends string = string> {
  type: 'packet';
  from: N;
  to: N;
  color: Color;
  label: string;
  payload: string[];
  row: R;
  wire: Wire;
  lost?: boolean;
  locked?: boolean;
  quick?: boolean;
  /** 事件从节点内的哪一点出发、到哪一点结束（相对节点中心）。设了就不走通道，走一条专门的直线。 */
  fromAt?: [number, number];
  toAt?: [number, number];
}

export interface StreamLike<P = PacketLike> {
  type: 'stream';
  packets: P[];
  spacing?: number;
}

export type KnownEvent =
  | PacketLike
  | StreamLike
  | { type: 'focus'; nodes: string[]; frame?: string[] }
  | { type: 'show'; nodes: string[]; frame?: string[] }
  | { type: 'camera'; frame?: string[] }
  | { type: 'type'; text: string }
  | { type: 'render' }
  | { type: 'note'; at: string; text: string; tone?: 'navy' | 'green' | 'amber' }
  | { type: 'state'; node: string; set: Record<string, string | null> };

export interface StepLike<E extends EventLike = EventLike> {
  title: string;
  desc: string;
  detail: string;
  facts: Fact[];
  events: E[];
}

export interface LessonLike<E extends EventLike = EventLike> {
  id: string;
  name: string;
  title: string;
  group: string;
  /** 顶栏 7 档色块里这节课占的闭区间，取值 1–7。每站自己定义这 7 档是什么。 */
  layer: [number, number];
  nodes: readonly string[];
  place: Partial<Record<string, [number, number]>>;
  labels: Partial<Record<string, [string, string]>>;
  start: string[];
  legend: Array<[Color | null, string]>;
  overview: { full: string; description: string; facts: Fact[] };
  steps: Array<StepLike<E>>;
  outro: { title: string; desc: string; text: string; facts: Fact[] };
}

export type PacketOf<E> = Extract<E, { type: 'packet' }>;
export type Stamped<E> = E & { step: number };

export function packetsOf<E extends EventLike>(lesson: { steps: Array<{ events: E[] }> }): Array<PacketOf<E>> {
  return lesson.steps.flatMap((step) =>
    step.events.flatMap((event) => {
      const known = event as unknown as KnownEvent;
      return known.type === 'packet' ? [known] : known.type === 'stream' ? known.packets : [];
    }),
  ) as unknown as Array<PacketOf<E>>;
}

export const labelOf = <N extends string>(lesson: { labels: Partial<Record<N, [string, string]>> }, node: N): string => lesson.labels[node]?.[0] ?? node;

/** 把 state 事件从头折叠到第 end 个事件，得到每个节点当时的状态面板内容。 */
export function foldStates<N extends string = string>(events: readonly EventLike[], end: number): Map<N, Record<string, string>> {
  const panels = new Map<N, Record<string, string>>();
  for (const event of events.slice(0, end)) {
    const known = event as KnownEvent;
    if (known.type !== 'state') continue;
    const panel = { ...panels.get(known.node as N) };
    for (const [key, value] of Object.entries(known.set)) {
      if (value === null) delete panel[key];
      else panel[key] = value;
    }
    panels.set(known.node as N, panel);
  }
  return panels;
}

/** 时序图折叠标记上的文字，单位是纳秒的站点共用。 */
export function formatNsGap(ns: number): string {
  if (ns >= 1e9) return `${+(ns / 1e9).toFixed(1)} s 后`;
  if (ns >= 1e6) return `${+(ns / 1e6).toFixed(1)} ms 后`;
  if (ns >= 1e3) return `${+(ns / 1e3).toFixed(1)} µs 后`;
  return `${ns} ns 后`;
}
