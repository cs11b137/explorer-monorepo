import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatSize, formatTokens, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

/**
 * 顶栏 7 档色块：一次调用从最底下的网络字节，到应用怎样组织上下文，依次经过它们。
 * 这是本站的教学约定，不是业界标准的分层。
 */
export const LAYER_NAMES = ['网络', 'HTTP', 'JSON', '消息', '提示', '上下文', '应用'] as const;

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'context-explorer',
  lessons: LESSONS,
  brand: { title: 'CONTEXT <em>EXPLORER</em>', tagline: '看懂一次模型调用带了什么', logo: LOGO },
  sidebar: {
    title: '接口与上下文工程',
    tabs: [
      { id: 'api', label: '接口' },
      { id: 'prompt', label: '提示' },
      { id: 'context', label: '上下文工程' },
    ],
  },
  layers: {
    names: LAYER_NAMES,
    label: '抽象层级',
    unit: '档',
    title: '本站的教学约定：一次模型调用从网络字节到应用的上下文组织依次经过的 7 档抽象层级',
    lessonTitle: (lesson) => {
      const [lo, hi] = lesson.layer;
      const span = lo === hi ? `「${LAYER_NAMES[lo - 1]}」这一档` : `从「${LAYER_NAMES[lo - 1]}」到「${LAYER_NAMES[hi - 1]}」`;
      return `${lesson.title}涉及的抽象层级：${span}。${lesson.layerNote}这 7 档是本站的教学约定，不是业界标准分层。`;
    },
  },
  rowTime: (row: Row) => formatTokens(row.tokens),
  formatSize: formatSize as (size: unknown) => string,
  trace: {
    title: '调用轨迹',
    timeHead: 'token',
    timeColClass: 'c-tok',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `累计 token 数：${lesson.tokensNote}本站迷你分词器的真实计数，真实模型的分词器不同，只代表量级关系。`;
    },
  },
  overview: {
    lostFlag: '调用失败',
    lockedFlag: '独占操作',
    metaExtra: (packet) => `累计 ${formatTokens((packet as PacketEvent).row.tokens)} token`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：id、时间、密钥、模型写的回复这类每次都不同的值</span><span><b>··</b> 打码或加密、内容不确定的字节</span>',
    emptyText: '这里讲的是概念，所以没有可以展示的字节。',
    lostNote: '这次调用失败了',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row) => `累计 ${formatTokens(row.tokens)} token`,
    segmentLayers: true,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.tokens - (previous as PacketEvent).row.tokens,
    formatGap: (tokens) => `${formatTokens(tokens)} token 后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '模型调用结构图',
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
