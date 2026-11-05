import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { PLAYER_OPTIONS } from './core/player';
import { formatCount, formatSize, NODE_IDS, PHASES, type Lesson, type Row } from './lessons/types';
import { NODE_SPECS } from './scene/devices';
import { artPlugin } from './scene/plugin';

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'codegen-explorer',
  lessons: LESSONS,
  brand: { title: 'CODEGEN <em>EXPLORER</em>', tagline: '看懂源代码如何变成机器码', logo: LOGO },
  sidebar: {
    title: '编译原理',
    tabs: [
      { id: 'front', label: '前端' },
      { id: 'middle', label: '中端' },
      { id: 'back', label: '后端' },
    ],
  },
  layers: {
    names: PHASES,
    label: '编译阶段',
    unit: '档',
    title: '编译阶段的 7 档是本站的教学划分，真实编译器的边界并不这么整齐。',
  },
  rowTime: (row: Row) => formatCount(row),
  formatSize: formatSize as (size: unknown) => string,
  trace: { title: '编译轨迹', timeHead: '阶段计数', lostChip: '报错' },
  overview: { lostFlag: '编译报错' },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：换一次运行就可能不同</span><span><b>··</b> 此时还不确定的字节：要到后面的阶段才填入</span>',
    emptyText: '这里讲的是概念结构，所以没有可以展示的字节。',
    lostNote: '编译在这里报错，没有继续往下走',
    fidelityText: FIDELITY_TEXT,
  },
  simulation: { beforeInspector: '<button class="panel-pager" type="button" hidden></button>' },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '编译流水线结构图',
    margin: 8,
    layers: { afterNodes: '<g class="art-layer"></g>' },
    stateLayer: false,
    command: false,
    fixedCamera: true,
    plugin: artPlugin,
  },
  player: PLAYER_OPTIONS,
};
