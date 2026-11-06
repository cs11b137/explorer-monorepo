import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatSize, formatTokens, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { dsPlugin } from './scene/plugin';

/**
 * 顶栏 7 档色块，从下到上：字节怎样在传输上走（传输），一条条 JSON-RPC 消息（JSON-RPC），双方声明支持什么（能力），
 * 一次工具调用（工具），一轮轮调用模型和工具（循环），几个 Agent 怎样分工（编排），最后是用户看到和确认的（用户）。
 * 这是本站的教学约定，不是业界标准的分层。
 */
export const LAYER_NAMES = ['传输', 'JSON-RPC', '能力', '工具', '循环', '编排', '用户'] as const;

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'agent-explorer',
  lessons: LESSONS,
  brand: { title: 'AGENT <em>EXPLORER</em>', tagline: '看懂 Agent 如何调用工具完成任务', logo: LOGO },
  sidebar: {
    title: 'Agent 与 MCP',
    tabs: [
      { id: 'loop', label: 'Agent 循环' },
      { id: 'mcp', label: 'MCP 协议' },
      { id: 'multi', label: '多 Agent' },
    ],
  },
  layers: {
    names: LAYER_NAMES,
    label: '抽象层级',
    unit: '档',
    title: '本站的教学约定：一个 Agent 系统从传输字节到用户确认的 7 档抽象层级',
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
    timeHead: '输入',
    timeColClass: 'c-tok',
    lostChip: '失败',
    onLesson(root, lesson) {
      root.querySelector<HTMLElement>('.packet-table th:nth-child(2)')!.title = `累计输入 token：${lesson.tokensNote}每一轮都要把整段历史重新发给模型，所以 Agent 的成本主要在这一列，而且一轮比一轮涨得快。`;
    },
  },
  overview: {
    lostFlag: '出错',
    lockedFlag: '需要确认',
    metaExtra: (packet) => `累计输入 ${formatTokens((packet as PacketEvent).row.tokens)} token`,
  },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：id、密钥、模型写的内容、真实服务会给出不同数值的字段</span><span><b>··</b> 打码、内容不确定的字节</span>',
    emptyText: '这里讲的是概念，所以没有可以展示的字节。',
    lostNote: '这一步出了错，错误交回给了模型或调用方',
    fidelityText: FIDELITY_TEXT,
    meta: (row: Row) => `累计输入 ${formatTokens(row.tokens)} token`,
    segmentLayers: true,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.tokens - (previous as PacketEvent).row.tokens,
    formatGap: (count) => `模型又读了 ${formatTokens(count)} token 后`,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: 'Agent 系统结构图',
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
