import { createPlayer as engineCreatePlayer, type PlayerOptions } from '@explorer/engine/core/player';

export * from '@explorer/engine/core/player';

export const PLAYER_OPTIONS: PlayerOptions = {
  gap(current, next, pace, mode) {
    if (current.type === 'probe' && current.hold) return mode === 'sequence' ? current.hold * 0.5 : current.hold;
    // 数值面板紧跟着上一个事件更新，不需要再等。
    if (next.type === 'probe') return pace.quick;
    return undefined;
  },
};

export const createPlayer: typeof engineCreatePlayer = (lesson, scene, onState, options = {}) => engineCreatePlayer(lesson, scene, onState, { ...PLAYER_OPTIONS, ...options });
