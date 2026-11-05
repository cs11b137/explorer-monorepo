import { aluLesson } from './alu';
import { branch } from './branch';
import { cacheLesson } from './cache';
import { coherence } from './coherence';
import { control } from './control';
import { datapath } from './datapath';
import { dmaLesson } from './dma';
import { dramLesson } from './dram';
import { encoding } from './encoding';
import { float } from './float';
import { hazard } from './hazard';
import { integer } from './integer';
import { pipelineLesson } from './pipeline';
import type { Lesson } from './types';
import { writepolicy } from './writepolicy';

export const LESSONS: Lesson[] = [integer, float, aluLesson, encoding, datapath, control, pipelineLesson, hazard, branch, cacheLesson, writepolicy, coherence, dramLesson, dmaLesson];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
