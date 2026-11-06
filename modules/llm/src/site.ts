import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatOps, formatSize, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

/**
 * 顶栏 7 档色块：从最底层的字节到最上层的 API，一个 token 从进到出依次经过它们。
 * 这是本站的教学约定，不是业界标准的分层。
 */
export const LAYER_NAMES = ['字节', 'token', '向量', '注意力', '模型层', '推理引擎', 'API'] as const;

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'llm-explorer',
  lessons: LESSONS,
  brand: { title: 'LLM <em>EXPLORER</em>', tagline: '看懂一个 token 是怎么生成的', logo: LOGO },
  sidebar: {
    title: '大模型原理',
    tabs: [
      { id: 'repr', label: '表示' },
      { id: 'infer', label: '推理' },
      { id: 'sample', label: '采样与输出' },
    ],
  },
  layers: {
    names: LAYER_NAMES,
    label: '抽象层级',
    unit: '档',
    title: '本站的教学约定：一个 token 从字节到 API 依次经过的 7 档抽象层级',
    lessonTitle: (lesson) => {
      const [lo, hi] = lesson.layer;
      const span = lo === hi ? `「${LAYER_NAMES[lo - 1]}」这一档` : `从「${LAYER_NAMES[lo - 1]}」到「${LAYER_NAMES[hi - 1]}」`;
      return `${lesson.title}涉及的抽象层级：${span}。${lesson.layerNote}这 7 档是本站的教学约定，不是业界标准分层。`;
    },
  },
  rowTime: (row: Row) => formatOps(row.ops),
  formatSize: formatSize as (size: unknown) => string,
  trace: {
    title: '运算轨迹',
    timeHead: '运算量',
    timeColClass: 'c-ops',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `运算量：${lesson.opsUnit}。由课程里的真实计算累计。`;
    },
  },
  overview: {
    lostFlag: '操作失败',
    lockedFlag: '独占操作',
    metaExtra: (packet, lesson) => `运算量 ${formatOps((packet as PacketEvent).row.ops)} ${lesson.opsShort}`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：地址、时间这类每次运行都不同的值</span><span><b>··</b> 内容不确定的字节</span>',
    emptyText: '这里讲的是概念，所以没有可以展示的字节。',
    lostNote: '这个操作失败了',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row, lesson: Lesson) => `运算量 ${formatOps(row.ops)} ${lesson.opsShort}`,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.ops - (previous as PacketEvent).row.ops,
    formatGap: (ops, lesson) => `${formatOps(ops)} ${lesson.opsShort}后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '推理过程结构图',
    nodeInner: '<g class="ds"></g>',
    command: {
      anchor: () => 'client',
      prompt: '>',
      place: (x, y, _width, tagScale) => ({ left: x - 74, top: y - 100 - 28 * tagScale, leader: 'M70,28 L76,42' }),
    },
    screenNodes: ['client'],
    plugin: dsPlugin,
  },
};
