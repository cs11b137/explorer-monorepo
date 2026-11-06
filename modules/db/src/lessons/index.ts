import { btreeinsert } from './btreeinsert';
import { bufferpool } from './bufferpool';
import { extsort } from './extsort';
import { hashjoin } from './hashjoin';
import { heappage } from './heappage';
import { indexscan } from './indexscan';
import { isolation } from './isolation';
import { locksLesson } from './locks';
import { lsm } from './lsm';
import { mvcc } from './mvcc';
import { parse } from './parse';
import { planner } from './planner';
import { recovery } from './recovery';
import type { Lesson } from './types';
import { vacuum } from './vacuum';
import { walcommit } from './walcommit';

export const LESSONS: Lesson[] = [parse, planner, indexscan, hashjoin, extsort, heappage, bufferpool, btreeinsert, lsm, vacuum, mvcc, isolation, locksLesson, walcommit, recovery];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
