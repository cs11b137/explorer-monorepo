import { dataflow } from './dataflow';
import { encoding } from './encoding';
import { frame } from './frame';
import { irgen } from './irgen';
import { isel } from './isel';
import { licm } from './licm';
import { link } from './link';
import { lexer } from './lexer';
import { llparser } from './llparser';
import { lrparser } from './lrparser';
import { optimize } from './optimize';
import { regalloc } from './regalloc';
import { ssa } from './ssa';
import { typecheck } from './typecheck';
import type { Lesson } from './types';

export const LESSONS: Lesson[] = [lexer, llparser, lrparser, typecheck, irgen, dataflow, ssa, optimize, licm, isel, regalloc, frame, encoding, link];
export const LESSON_BY_ID: Record<string, Lesson> = Object.fromEntries(LESSONS.map((lesson) => [lesson.id, lesson]));
