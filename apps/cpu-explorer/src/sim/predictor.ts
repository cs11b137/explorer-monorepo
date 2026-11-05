/** 2 位饱和计数器分支预测器。0 强不跳，1 弱不跳，2 弱跳，3 强跳。 */
export const COUNTER_NAMES = ['SN', 'WN', 'WT', 'ST'] as const;
export const COUNTER_TEXT = ['强不跳', '弱不跳', '弱跳', '强跳'] as const;

export interface DirectionPredictor {
  predict(pc: number): boolean;
  update(pc: number, taken: boolean): void;
}

export class TwoBitPredictor implements DirectionPredictor {
  table: Uint8Array;

  constructor(readonly entries = 16, initial = 1) {
    this.table = new Uint8Array(entries).fill(initial);
  }

  /** 指令按 4 字节对齐，所以跳过 PC 的低 2 位再取模。 */
  index(pc: number): number {
    return (pc >>> 2) % this.entries;
  }

  counter(pc: number): number {
    return this.table[this.index(pc)];
  }

  predict(pc: number): boolean {
    return this.counter(pc) >= 2;
  }

  update(pc: number, taken: boolean): void {
    const index = this.index(pc);
    this.table[index] = taken ? Math.min(3, this.table[index] + 1) : Math.max(0, this.table[index] - 1);
  }
}

export class OneBitPredictor implements DirectionPredictor {
  table: Uint8Array;

  constructor(readonly entries = 16) {
    this.table = new Uint8Array(entries);
  }

  predict(pc: number): boolean {
    return this.table[(pc >>> 2) % this.entries] === 1;
  }

  update(pc: number, taken: boolean): void {
    this.table[(pc >>> 2) % this.entries] = taken ? 1 : 0;
  }
}

/** 静态预测：永远猜不跳。 */
export const NOT_TAKEN: DirectionPredictor = { predict: () => false, update: () => undefined };

export interface Outcome {
  pc: number;
  taken: boolean;
  predicted: boolean;
  correct: boolean;
  counterBefore?: number;
  counterAfter?: number;
}

/** 把一串真实分支结果喂给预测器，统计每一次的对错。 */
export function replay(predictor: DirectionPredictor, trace: Array<{ pc: number; taken: boolean }>): { outcomes: Outcome[]; correct: number; total: number } {
  const outcomes: Outcome[] = [];
  let correct = 0;
  for (const { pc, taken } of trace) {
    const counterBefore = predictor instanceof TwoBitPredictor ? predictor.counter(pc) : undefined;
    const predicted = predictor.predict(pc);
    predictor.update(pc, taken);
    const counterAfter = predictor instanceof TwoBitPredictor ? predictor.counter(pc) : undefined;
    if (predicted === taken) correct++;
    outcomes.push({ pc, taken, predicted, correct: predicted === taken, counterBefore, counterAfter });
  }
  return { outcomes, correct, total: trace.length };
}
