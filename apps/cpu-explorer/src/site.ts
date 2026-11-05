import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { PLAYER_OPTIONS } from './core/player';
import { formatCycle, formatSize, NODE_IDS, type ClockUnit, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { widgetPlugin } from './scene/plugin';

function formatGap(gap: number, clock: ClockUnit): string {
  if (clock === 'gate') return `${gap} 门延迟后`;
  if (clock === 'step') return `${gap} 步后`;
  if (clock === 'nck') return `${gap} nCK 后`;
  return `${gap} 周期后`;
}

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'cpu-explorer',
  lessons: LESSONS,
  brand: { title: 'CPU <em>EXPLORER</em>', tagline: '看懂计算机如何执行每条指令', logo: LOGO },
  sidebar: {
    title: '计算机组成原理',
    tabs: [
      { id: 'data', label: '数据表示' },
      { id: 'cpu', label: '处理器' },
      { id: 'memio', label: '存储与 I/O' },
    ],
  },
  layers: {
    names: ['晶体管', '逻辑门', '功能部件', '微架构', '指令集', '汇编', '高级语言'],
    label: '抽象层级',
    unit: '档',
    title: '抽象层级是本站的教学约定：从晶体管到高级语言，每一层都建立在下一层之上。',
  },
  rowTime: (row: Row, lesson) => formatCycle(row.cycle, lesson.clock, row.run),
  formatSize: formatSize as (size: unknown) => string,
  trace: { title: '周期轨迹', timeHead: '周期', lostChip: '已冲掉' },
  overview: { lostFlag: '被冲掉，没有生效', lockedFlag: '独占总线' },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：参数是教学选取的，数值由模拟器算出</span><span>悬停字段、位或字节，三者会互相高亮</span>',
    lostNote: '这条指令在途中被冲掉，没有生效',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row, lesson) => `周期 ${formatCycle(row.cycle, lesson.clock, row.run)}`,
    memHead: (count) => `内存字节 <span>小端存放，共 ${count} 字节</span>`,
  },
  sequence: {
    minLane: 100,
    left: 88,
    gap(current, previous) {
      const a = (current as PacketEvent).row;
      const b = (previous as PacketEvent).row;
      return a.run === b.run ? a.cycle - b.cycle : 0;
    },
    formatGap: (gap, lesson) => formatGap(gap, lesson.clock),
  },
  simulation: { afterNetwork: '<div class="state-strip" aria-label="部件当前值"></div>' },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '系统结构图',
    maxZoomWidth: 420,
    layers: { afterNodes: '<g class="widget-layer"></g>' },
    command: { anchor: (lesson) => lesson?.start[0] ?? 'asm', prompt: '&gt;', bump: false },
    observeParent: true,
    plugin: widgetPlugin,
  },
  player: PLAYER_OPTIONS,
};
