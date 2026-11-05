import { avl } from './avl';
import { binarysearch } from './binarysearch';
import { bfsLesson } from './bfs';
import { dijkstraLesson } from './dijkstra';
import { dynarray } from './dynarray';
import { hashtable } from './hashtable';
import { heap } from './heap';
import { kmp } from './kmp';
import { lcsLesson } from './lcs';
import { linkedlist } from './linkedlist';
import { mergesort } from './mergesort';
import { quicksort } from './quicksort';
import { ringqueue } from './ringqueue';
import type { Lesson } from './types';
import { unionfind } from './unionfind';

export const LESSONS: Lesson[] = [dynarray, linkedlist, ringqueue, hashtable, binarysearch, heap, avl, unionfind, bfsLesson, dijkstraLesson, quicksort, mergesort, lcsLesson, kmp];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
