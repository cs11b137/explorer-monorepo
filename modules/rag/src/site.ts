import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatDist, formatSize, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

/**
 * 顶栏 7 档色块：一个问题找到答案，要从文档开始，经过分块、向量、索引、检索，拼进提示，最后变成回答。
 * 这是本站的教学约定，不是业界标准的分层。
 */
export const LAYER_NAMES = ['文档', '分块', '向量', '索引', '检索', '提示', '回答'] as const;

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'rag-explorer',
  lessons: LESSONS,
  brand: { title: 'RAG <em>EXPLORER</em>', tagline: '看懂一个问题如何找到它的答案', logo: LOGO },
  sidebar: {
    title: '嵌入与检索增强',
    tabs: [
      { id: 'embed', label: '嵌入' },
      { id: 'index', label: '向量检索' },
      { id: 'pipeline', label: 'RAG 流水线' },
    ],
  },
  layers: {
    names: LAYER_NAMES,
    label: '抽象层级',
    unit: '档',
    title: '本站的教学约定：一个问题从文档到回答依次经过的 7 档抽象层级',
    lessonTitle: (lesson) => {
      const [lo, hi] = lesson.layer;
      const span = lo === hi ? `「${LAYER_NAMES[lo - 1]}」这一档` : `从「${LAYER_NAMES[lo - 1]}」到「${LAYER_NAMES[hi - 1]}」`;
      return `${lesson.title}涉及的抽象层级：${span}。${lesson.layerNote}这 7 档是本站的教学约定，不是业界标准分层。`;
    },
  },
  rowTime: (row: Row) => formatDist(row.dist),
  formatSize: formatSize as (size: unknown) => string,
  trace: {
    title: '检索轨迹',
    timeHead: '距离',
    timeColClass: 'c-dist',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `累计距离计算次数：${lesson.distNote}向量和向量比一次记 1 次，是向量检索的核心成本（FAISS 统计里的 ndis）。`;
    },
  },
  overview: {
    lostFlag: '没有找到',
    lockedFlag: '独占操作',
    metaExtra: (packet) => `累计 ${formatDist((packet as PacketEvent).row.dist)} 次距离计算`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：id、密钥、模型写的回答、真实服务会给出不同数值的字段</span><span><b>··</b> 打码、内容不确定的字节</span>',
    emptyText: '这里讲的是概念，所以没有可以展示的字节。',
    lostNote: '这一步没有找到想要的结果',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row) => `累计 ${formatDist(row.dist)} 次距离计算`,
    segmentLayers: true,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.dist - (previous as PacketEvent).row.dist,
    formatGap: (count) => `${formatDist(count)} 次距离计算后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '检索增强问答结构图',
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
