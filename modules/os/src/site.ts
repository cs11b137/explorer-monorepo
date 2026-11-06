import { LESSONS } from './lessons';
import { LOGO } from './logo';
import { FIDELITY_TEXT } from './decode/writer';
import type { SiteConfig } from '@explorer/engine/site';
import { formatNsGap } from '@explorer/engine/types';
import { formatSize, formatTime, NODE_IDS, type Lesson, type PacketEvent, type Row } from './lessons/types';
import { NODE_SPECS, setDeviceArt } from './scene/devices';

export const site: SiteConfig<Lesson> = {
  storagePrefix: 'os-explorer',
  lessons: LESSONS,
  brand: { title: 'OS <em>EXPLORER</em>', tagline: '看懂操作系统如何工作', logo: LOGO },
  sidebar: {
    title: '操作系统原理',
    tabs: [
      { id: 'process', label: '进程与并发' },
      { id: 'memory', label: '内存' },
      { id: 'io', label: '文件与通信' },
    ],
  },
  layers: {
    names: ['硬件', '固件', '驱动', '内核核心', '系统调用', '运行库', '应用'],
    label: '系统层级',
    unit: '层',
    title: '系统层级是本站的教学约定，不是标准模型。驱动与内核核心其实是平级关系。',
  },
  rowTime: (row: Row, lesson) => formatTime(row.tNs, lesson.timeUnit),
  formatSize: formatSize as (size: unknown) => string,
  trace: { title: '内核轨迹', timeHead: '时间', lostChip: '故障' },
  overview: { lostFlag: '故障，事件中止', lockedFlag: '特权或原子操作' },
  inspector: {
    foot: '<span><i class="eg">E.G.</i> 示例值：每次真实运行都不同</span><span><b>··</b> 无法展示的字节：随机数、加密内容或文件内容</span>',
    lostNote: '这个事件在途中触发故障，没有完成',
    fidelityText: FIDELITY_TEXT,
  },
  sequence: {
    gap: (current, previous) => (current as PacketEvent).row.tNs - (previous as PacketEvent).row.tNs,
    formatGap: formatNsGap,
  },
  stage: {
    nodeIds: NODE_IDS,
    specs: NODE_SPECS,
    ariaLabel: '系统结构图',
    command: { anchor: () => 'app', prompt: '$' },
    screenNodes: ['app', 'proc2'],
    plugin: ({ nodeEls }) => ({
      load(lesson) {
        setDeviceArt(nodeEls.device, lesson.deviceArt ?? 'keyboard');
      },
    }),
  },
};
