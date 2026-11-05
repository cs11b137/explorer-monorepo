import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatNsGap } from '@explorer/engine/types';
import { PLAYER_OPTIONS } from './core/player';
import { formatSize, formatTime, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { boardPlugin } from './scene/plugin';

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'db-explorer',
  lessons: LESSONS,
  brand: { title: 'DB <em>EXPLORER</em>', tagline: '看懂一条 SQL 如何被执行和保存', logo: LOGO },
  sidebar: {
    title: '数据库系统原理',
    tabs: [
      { id: 'query', label: '查询处理' },
      { id: 'storage', label: '存储与索引' },
      { id: 'txn', label: '事务与恢复' },
    ],
  },
  layers: {
    names: ['存储介质', '页与文件', '缓冲区', '访问方法', '事务', '执行器', 'SQL'],
    label: '系统层级',
    unit: '层',
    title: '系统层级是本站的教学约定，不是 PostgreSQL 的官方分层。事务其实横跨访问方法和存储。',
  },
  rowTime: (row: Row, lesson) => formatTime(row.tNs, lesson.timeUnit),
  formatSize: formatSize as (size: unknown) => string,
  trace: { title: '执行轨迹', timeHead: '时间 <i class="eg">E.G.</i>', lostChip: '中止' },
  overview: { lostFlag: '中止：这一步没有完成', lockedFlag: '涉及锁' },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：事务号、LSN、OID 每次运行都不同</span><span><b>··</b> 未展示的字节：内容太长，或这里只讲布局</span>',
    lostNote: '这个事件在途中中止，没有完成',
    fidelityText: FIDELITY_TEXT,
    valuesHead: '字段值 <span>各自独立，不是连续内存</span>',
    segmentLayers: true,
  },
  sequence: {
    minLane: 92,
    gap: (current, previous) => (current as PacketEvent).row.tNs - (previous as PacketEvent).row.tNs,
    formatGap: formatNsGap,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '系统结构图',
    layers: { afterState: '<g class="board-layer"></g>' },
    command: {
      anchor: () => 'client',
      prompt: '=#',
      textX: 30,
      boxPad: 62,
      checkPad: 41,
      typeMs: 28,
      place: (x, y, _width, tagScale) => ({ left: x - 54, top: y - 78 - 28 * tagScale, leader: 'M40,28 L46,42' }),
    },
    screenNodes: ['client', 'client2'],
    plugin: boardPlugin,
  },
  player: PLAYER_OPTIONS,
};
