import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatCost, formatSize, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

/**
 * 顶栏 7 档色块，从下到上：一次 API 调用本身（模型调用），调用它的业务代码（应用），挡在两者之间的检查（防护），
 * 把一次请求记下来（追踪），离线判断好不好（评估），线上持续盯着（监控），最后是用户。
 * 这是本站的教学约定，不是业界标准的分层。
 */
export const LAYER_NAMES = ['模型调用', '应用', '防护', '追踪', '评估', '监控', '用户'] as const;

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'llmops-explorer',
  lessons: LESSONS,
  brand: { title: 'LLMOPS <em>EXPLORER</em>', tagline: '看懂 AI 功能如何上线并保持可靠', logo: LOGO },
  sidebar: {
    title: '安全、评估与可观测性',
    tabs: [
      { id: 'safety', label: '安全' },
      { id: 'eval', label: '评估' },
      { id: 'observe', label: '可观测性' },
    ],
  },
  layers: {
    names: LAYER_NAMES,
    label: '抽象层级',
    unit: '档',
    title: '本站的教学约定：一个上线的 AI 功能从模型调用到用户的 7 档抽象层级',
    lessonTitle: (lesson) => {
      const [lo, hi] = lesson.layer;
      const span = lo === hi ? `「${LAYER_NAMES[lo - 1]}」这一档` : `从「${LAYER_NAMES[lo - 1]}」到「${LAYER_NAMES[hi - 1]}」`;
      return `${lesson.title}涉及的抽象层级：${span}。${lesson.layerNote}这 7 档是本站的教学约定，不是业界标准分层。`;
    },
  },
  rowTime: (row: Row) => formatCost(row.cost),
  formatSize: formatSize as (size: unknown) => string,
  trace: {
    title: '调用轨迹',
    timeHead: '费用',
    timeColClass: 'c-cost',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `累计费用（示例单价）：${lesson.costNote}防护、评估、监控每多一次模型调用都要付钱，这一列从 usage 和单价精确算出。`;
    },
  },
  overview: {
    lostFlag: '出错',
    lockedFlag: '需要确认',
    metaExtra: (packet) => `累计费用 ${formatCost((packet as PacketEvent).row.cost)}`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：id、密钥、模型写的内容、真实服务会给出不同数值的字段</span><span><b>··</b> 打码、内容不确定的字节</span>',
    emptyText: '这里讲的是概念，所以没有可以展示的字节。',
    lostNote: '这一步出了错，错误交回给了调用方',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row) => `累计费用 ${formatCost(row.cost)}`,
    segmentLayers: true,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.cost - (previous as PacketEvent).row.cost,
    formatGap: (nano) => `又花了 ${formatCost(nano)} 后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: 'AI 功能的上线结构图',
    nodeInner: '<g class="ds"></g>',
    command: {
      anchor: () => 'app',
      prompt: '>',
      place: (x, y, _width, tagScale) => ({ left: x - 74, top: y - 100 - 28 * tagScale, leader: 'M70,28 L76,42' }),
    },
    screenNodes: ['app'],
    plugin: dsPlugin,
  },
};
