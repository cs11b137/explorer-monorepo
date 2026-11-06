import { boot } from './boot';
import { contextswitch } from './contextswitch';
import { cow } from './cow';
import { exec } from './exec';
import { fileread } from './fileread';
import { fork } from './fork';
import { futex } from './futex';
import { interrupt } from './interrupt';
import { journal } from './journal';
import { mmap } from './mmap';
import { pagefault } from './pagefault';
import { pagewalk } from './pagewalk';
import { pathlookup } from './pathlookup';
import { pipe } from './pipe';
import { reclaim } from './reclaim';
import { scheduler } from './scheduler';
import { signal } from './signal';
import { syscall } from './syscall';
import type { Lesson } from './types';

export const LESSONS: Lesson[] = [
  boot, syscall, interrupt, fork, exec, contextswitch, scheduler, futex,
  pagewalk, pagefault, cow, mmap, reclaim,
  pathlookup, fileread, journal, pipe, signal,
];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
