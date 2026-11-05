/** 依据 src/backend/utils/sort/tuplesort.c（REL_17_STABLE）：PG 15 起使用平衡 k 路归并。 */
export const MINORDER = 6;
export const MAXORDER = 500;
export const TAPE_BUFFER_OVERHEAD = 8192;
export const MERGE_BUFFER_SIZE = 8192 * 32;

/** tuplesort_merge_order */
export function mergeOrder(allowedMem: number): number {
  const order = Math.floor(allowedMem / (2 * TAPE_BUFFER_OVERHEAD + MERGE_BUFFER_SIZE));
  return Math.min(MAXORDER, Math.max(MINORDER, order));
}

export interface MergeStep {
  /** 这一步开始时各输入归并段的头（归并堆里的内容）。 */
  heap: Array<{ value: number; tape: number }>;
  output: number;
  fromTape: number;
}

export interface MergePass {
  pass: number;
  inputTapes: number[][][];
  /** 每次 mergeonerun 的完整记录。 */
  merges: Array<{ inputs: number[][]; output: number[]; steps: MergeStep[]; destTape: number }>;
  outputTapes: number[][][];
  /** 最后一趟可以边归并边输出，不写回磁带。 */
  final: boolean;
}

export interface SortLog {
  input: number[];
  /** 依次生成的初始归并段，已排好序。 */
  runs: number[][];
  /** 每个归并段写到了哪条磁带。 */
  runTape: number[];
  /** 生成归并段时每条磁带的内容。 */
  tapes: number[][][];
  passes: MergePass[];
  output: number[];
  comparisons: number;
}

class Counter {
  n = 0;
  lt(a: number, b: number): boolean {
    this.n += 1;
    return a < b;
  }
}

/** 插入和替换堆顶，对应 tuplesort_heap_insert / tuplesort_heap_replace_top。堆元素带磁带号。 */
class TapeHeap {
  items: Array<{ value: number; tape: number }> = [];

  constructor(private counter: Counter) {}

  private less(a: { value: number; tape: number }, b: { value: number; tape: number }): boolean {
    // 键相同时按磁带号，这样归并是确定的。
    if (a.value === b.value) return a.tape < b.tape;
    return this.counter.lt(a.value, b.value);
  }

  insert(item: { value: number; tape: number }): void {
    const h = this.items;
    let j = h.length;
    h.push(item);
    while (j > 0) {
      const i = (j - 1) >> 1;
      if (!this.less(item, h[i])) break;
      h[j] = h[i];
      j = i;
    }
    h[j] = item;
  }

  replaceTop(item: { value: number; tape: number } | null): void {
    const h = this.items;
    const moved = item ?? h.pop()!;
    if (!h.length) return;
    const n = h.length;
    let i = 0;
    for (;;) {
      let j = 2 * i + 1;
      if (j >= n) break;
      if (j + 1 < n && this.less(h[j + 1], h[j])) j += 1;
      if (!this.less(h[j], moved)) break;
      h[i] = h[j];
      i = j;
    }
    h[i] = moved;
  }
}

/**
 * 真实跑一遍外部排序。capacity 是内存能放下的元组数（work_mem 的缩小版），
 * maxTapes 是磁带数（tuplesort_merge_order 的结果）。
 */
export function externalSort(input: number[], capacity: number, maxTapes: number): SortLog {
  const counter = new Counter();
  const runs: number[][] = [];
  const runTape: number[] = [];
  let tapes: number[][][] = [];

  // selectnewtape：磁带数还没到上限就开新磁带，到了之后轮流写。
  const select = (out: number[][][], outRuns: number) => {
    if (out.length < maxTapes) {
      out.push([]);
      return out.length - 1;
    }
    return outRuns % out.length;
  };

  for (let at = 0; at < input.length; at += capacity) {
    const run = input.slice(at, at + capacity).sort((a, b) => {
      counter.n += 1;
      return a - b;
    });
    const tape = select(tapes, runs.length);
    tapes[tape].push(run);
    runs.push(run);
    runTape.push(tape);
  }

  const passes: MergePass[] = [];
  const initial = tapes.map((tape) => tape.map((run) => run.slice()));
  let inputs = tapes;
  let output: number[] = [];
  for (let pass = 1; ; pass++) {
    const nRuns = inputs.reduce((sum, tape) => sum + tape.length, 0);
    const outTapes: number[][][] = [];
    const merges: MergePass['merges'] = [];
    const snapshot = inputs.map((tape) => tape.map((run) => run.slice()));
    // 剩下的归并段不超过磁带数时，最后一趟直接边归并边输出。
    const final = nRuns <= inputs.length;
    let produced = 0;
    while (inputs.some((tape) => tape.length)) {
      const heads = inputs.map((tape) => tape.shift()).map((run, tape) => (run ? { run, tape, at: 0 } : null)).filter((x): x is { run: number[]; tape: number; at: number } => x !== null);
      const heap = new TapeHeap(counter);
      for (const head of heads) heap.insert({ value: head.run[0], tape: head.tape });
      const merged: number[] = [];
      const steps: MergeStep[] = [];
      while (heap.items.length) {
        const top = heap.items[0];
        steps.push({ heap: heap.items.map((item) => ({ ...item })), output: top.value, fromTape: top.tape });
        merged.push(top.value);
        const source = heads.find((head) => head.tape === top.tape)!;
        source.at += 1;
        if (source.at < source.run.length) heap.replaceTop({ value: source.run[source.at], tape: top.tape });
        else heap.replaceTop(null);
      }
      const dest = final ? -1 : select(outTapes, produced);
      if (!final) outTapes[dest].push(merged);
      produced += 1;
      merges.push({ inputs: heads.map((head) => head.run), output: merged, steps, destTape: dest });
      if (final) output = merged;
    }
    passes.push({ pass, inputTapes: snapshot, merges, outputTapes: outTapes.map((tape) => tape.map((run) => run.slice())), final });
    if (final) break;
    inputs = outTapes;
  }
  tapes = initial;
  return { input, runs, runTape, tapes, passes, output, comparisons: counter.n };
}
