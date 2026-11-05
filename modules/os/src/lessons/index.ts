import { boot } from './boot';
import { contextswitch } from './contextswitch';
import { cow } from './cow';
import { fileread } from './fileread';
import { fork } from './fork';
import { futex } from './futex';
import { interrupt } from './interrupt';
import { journal } from './journal';
import { pagefault } from './pagefault';
import { pagewalk } from './pagewalk';
import { pipe } from './pipe';
import { reclaim } from './reclaim';
import { scheduler } from './scheduler';
import { syscall } from './syscall';
import type { Lesson } from './types';

export const LESSONS: Lesson[] = [boot, syscall, fork, interrupt, contextswitch, scheduler, futex, pagewalk, pagefault, cow, reclaim, fileread, journal, pipe];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
