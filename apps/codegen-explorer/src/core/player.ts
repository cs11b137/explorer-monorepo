import { createPlayer as engineCreatePlayer, type PlayerOptions } from '@explorer/engine/core/player';

export * from '@explorer/engine/core/player';

/** 课程播完后，轨迹表不再高亮最后一行。 */
export const PLAYER_OPTIONS: PlayerOptions = { clearCurrentOnDone: true };

export const createPlayer: typeof engineCreatePlayer = (lesson, scene, onState, options = {}) => engineCreatePlayer(lesson, scene, onState, { ...PLAYER_OPTIONS, ...options });
