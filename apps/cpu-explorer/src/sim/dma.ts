import { Memory } from './exec';

/** 单主线总线的周期级模型：每个周期只有一个主设备能占用总线。 */
export type BusOwner = 'CPU' | 'DMA' | null;

export interface BusCycle {
  cycle: number;
  owner: BusOwner;
  /** 这一拍总线上做什么。 */
  action: string;
  /** 同时想要总线但没抢到的主设备。 */
  waiting: BusOwner;
}

export interface TransferResult {
  mode: 'pio' | 'dma';
  log: BusCycle[];
  totalCycles: number;
  /** CPU 花在这次传输上的周期（搬数据或编程 DMA）。 */
  cpuTransferCycles: number;
  /** 传输期间 CPU 能拿去算别的东西的周期。 */
  cpuFreeCycles: number;
  /** CPU 的计算任务因为总线被占用而等待的周期。 */
  cpuBusWaits: number;
  dmaBusCycles: number;
  wordsCopied: number;
  interruptAt: number | null;
  memory: Memory;
}

export interface TransferConfig {
  words: number;
  destination: number;
  /** 设备里待传的数据。 */
  source: (index: number) => number;
  /** 设备准备好下一个字需要的周期。 */
  deviceInterval: number;
  /** CPU 自己的任务每隔多少周期需要访问一次总线（取指未命中等）。 */
  cpuBusEvery: number;
  /** DMA 模式里编程要写的寄存器个数。 */
  setupWrites: number;
}

/** 程序控制 I/O：CPU 循环读设备寄存器、写内存，每个字两次总线。 */
export function runPio(config: TransferConfig): TransferResult {
  const memory = new Memory();
  const log: BusCycle[] = [];
  let cycle = 0;
  let readyAt = config.deviceInterval;
  let cpuTransferCycles = 0;
  for (let index = 0; index < config.words; index++) {
    // 轮询：设备没准备好时，CPU 只能反复读状态寄存器。
    while (cycle + 1 < readyAt) {
      cycle += 1;
      cpuTransferCycles += 1;
      log.push({ cycle, owner: 'CPU', action: '轮询状态寄存器', waiting: null });
    }
    cycle += 1;
    cpuTransferCycles += 1;
    log.push({ cycle, owner: 'CPU', action: `读设备数据 #${index}`, waiting: null });
    const value = config.source(index);
    cycle += 1;
    cpuTransferCycles += 1;
    memory.storeWord(config.destination + index * 4, value);
    log.push({ cycle, owner: 'CPU', action: `写内存 #${index}`, waiting: null });
    readyAt = Math.max(readyAt + config.deviceInterval, cycle + 1);
  }
  return { mode: 'pio', log, totalCycles: cycle, cpuTransferCycles, cpuFreeCycles: 0, cpuBusWaits: 0, dmaBusCycles: 0, wordsCopied: config.words, interruptAt: null, memory };
}

/**
 * DMA：CPU 写完寄存器就去算别的。DMA 每拿到一个字就抢一拍总线写内存（周期窃取）。
 * 仲裁固定 DMA 优先；被挡住的 CPU 总线访问顺延一拍。
 */
export function runDma(config: TransferConfig): TransferResult {
  const memory = new Memory();
  const log: BusCycle[] = [];
  let cycle = 0;
  const setup = config.setupWrites;
  for (let index = 0; index < setup; index++) {
    cycle += 1;
    log.push({ cycle, owner: 'CPU', action: `写 DMA 寄存器 #${index}`, waiting: null });
  }
  let copied = 0;
  let nextWordAt = cycle + config.deviceInterval;
  let cpuNext = cycle + config.cpuBusEvery;
  let cpuWaits = 0;
  let dmaCycles = 0;
  while (copied < config.words) {
    cycle += 1;
    const dmaWants = cycle >= nextWordAt;
    const cpuWants = cycle >= cpuNext;
    if (dmaWants) {
      memory.storeWord(config.destination + copied * 4, config.source(copied));
      log.push({ cycle, owner: 'DMA', action: `DMA 写内存 #${copied}`, waiting: cpuWants ? 'CPU' : null });
      if (cpuWants) cpuWaits += 1;
      copied += 1;
      dmaCycles += 1;
      nextWordAt = cycle + config.deviceInterval;
    } else if (cpuWants) {
      log.push({ cycle, owner: 'CPU', action: 'CPU 取指或读数据', waiting: null });
      cpuNext = cycle + config.cpuBusEvery;
    } else {
      log.push({ cycle, owner: null, action: '总线空闲', waiting: null });
    }
  }
  const interruptAt = cycle + 1;
  const free = cycle - setup - cpuWaits;
  return { mode: 'dma', log, totalCycles: cycle, cpuTransferCycles: setup, cpuFreeCycles: free, cpuBusWaits: cpuWaits, dmaBusCycles: dmaCycles, wordsCopied: copied, interruptAt, memory };
}
