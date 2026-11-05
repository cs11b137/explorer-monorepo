import type { PlayerOptions } from './core/player';
import type { StageConfig } from './scene/stage';
import type { LessonLike, PacketLike, RowLike } from './types';

/** 一个教学站和引擎之间的全部约定。文案、配色以外的差异都从这里进来。 */
export interface SiteConfig<L extends LessonLike<any> = LessonLike<any>> {
  /** localStorage 键名前缀，比如 `os-explorer`。 */
  storagePrefix: string;
  lessons: L[];
  brand: {
    /** 顶栏标题，允许 HTML，比如 `OS <em>EXPLORER</em>`。 */
    title: string;
    tagline: string;
    logo: string;
  };
  sidebar: {
    title: string;
    tabs: Array<{ id: string; label: string }>;
  };
  layers: {
    names: readonly string[];
    label: string;
    /** 色块提示里的量词：第 N 层、第 N 档。 */
    unit: string;
    title?: string;
    /** 按课程改写色块区的提示。 */
    lessonTitle?(lesson: L): string;
  };
  /** 轨迹表、时序图里的时间或计数。 */
  rowTime(row: RowLike, lesson: L): string;
  formatSize(size: unknown): string;
  trace: {
    title: string;
    /** 第二列的表头，允许 HTML。 */
    timeHead: string;
    timeColClass?: string;
    lostChip: string;
    onLesson?(root: HTMLElement, lesson: L): void;
  };
  overview: {
    lostFlag: string;
    lockedFlag?: string;
    /** 插在事件编号后面的一项，比如累计操作数。 */
    metaExtra?(packet: PacketLike, lesson: L): string;
  };
  inspector: {
    foot: string;
    emptyText?: string;
    lostNote: string;
    fidelityText: Record<string, string>;
    /** 检查器标题里的时间项，默认和轨迹表一样。 */
    meta?(row: RowLike, lesson: L): string;
    /** view 不是 mem 时的表头。 */
    valuesHead?: string;
    /** mem 视图的表头。 */
    memHead?(count: number): string;
    /** 按层分段显示 hex，地址列用每层的真实偏移。 */
    segmentLayers?: boolean;
  };
  sequence?: {
    minLane?: number;
    left?: number;
    /** 两个相邻事件之间的距离。不提供时不做长间隔折叠。 */
    gap?(current: PacketLike, previous: PacketLike): number;
    formatGap?(gap: number, lesson: L): string;
  };
  simulation?: {
    afterNetwork?: string;
    beforeInspector?: string;
  };
  stage: StageConfig<L>;
  player?: PlayerOptions;
}

let current: SiteConfig<any> | null = null;

export function configureSite<L extends LessonLike<any>>(config: SiteConfig<L>): void {
  current = config;
}

export function site(): SiteConfig<any> {
  if (!current) throw new Error('站点配置还没有注册：先调用 createApp');
  return current;
}
