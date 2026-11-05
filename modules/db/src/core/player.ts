import { createPlayer as engineCreatePlayer, type PlayerOptions } from '@explorer/engine/core/player';

export * from '@explorer/engine/core/player';

export const PLAYER_OPTIONS: PlayerOptions = {
  gap(current, next, pace) {
    // 结构板只是刷新内容，不需要像消息那样留出间隔。
    return next.type === 'board' || current.type === 'board' ? pace.quick : undefined;
  },
};

export const createPlayer: typeof engineCreatePlayer = (lesson, scene, onState, options = {}) => engineCreatePlayer(lesson, scene, onState, { ...PLAYER_OPTIONS, ...options });
