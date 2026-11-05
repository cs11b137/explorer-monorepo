import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatOps, formatSize, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'algo-explorer',
  lessons: LESSONS,
  brand: { title: 'ALGO <em>EXPLORER</em>', tagline: '看懂数据结构与算法如何工作', logo: LOGO },
  sidebar: {
    title: '数据结构与算法',
    tabs: [
      { id: 'linear', label: '线性与查找' },
      { id: 'tree', label: '树与图' },
      { id: 'strategy', label: '排序与策略' },
    ],
  },
  layers: {
    names: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)', 'O(n!)'],
    label: '时间复杂度',
    unit: '档',
    lessonTitle: (lesson) => {
      const { best, worst, note } = lesson.complexity;
      return `${lesson.name} 的时间复杂度。最好：${best}。最坏：${worst}。${note ?? ''}`.trim();
    },
  },
  rowTime: (row: Row) => formatOps(row.ops),
  formatSize: formatSize as (size: unknown) => string,
  trace: {
    title: '操作轨迹',
    timeHead: '操作数',
    timeColClass: 'c-ops',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `操作数：${lesson.opsUnit}。由算法累计统计。`;
    },
  },
  overview: {
    lostFlag: '操作失败',
    lockedFlag: '独占操作',
    metaExtra: (packet) => `操作数 ${formatOps((packet as PacketEvent).row.ops)}`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：地址每次运行都不同</span><span><b>··</b> 内容不确定的字节：填充或未初始化的内存</span>',
    emptyText: '这里讲的是概念结构，所以没有可以展示的字节。',
    lostNote: '这个操作失败了，没有写入',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row) => `操作数 ${formatOps(row.ops)}`,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.ops - (previous as PacketEvent).row.ops,
    formatGap: (ops) => `${ops} 次操作后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '数据结构图',
    nodeInner: '<g class="ds"></g>',
    command: {
      anchor: () => 'prog',
      prompt: '$',
      place: (x, y, _width, tagScale) => ({ left: x - 74, top: y - 106 - 28 * tagScale, leader: 'M70,28 L76,42' }),
    },
    screenNodes: ['prog'],
    plugin: dsPlugin,
  },
};
