/**
 * 固定种子的伪随机数。整站没有 Math.random：权重初始化、采样、批处理的到达顺序都从这里取，
 * 同样的种子永远得到同样的序列，课程文案里的数字才能和测试对上。
 */

/** mulberry32：32 位状态，返回 [0, 1) 的均匀分布。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态分布（Box–Muller），用同一个均匀分布源。 */
export function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    // 1 - rand() 落在 (0, 1]，避免 log(0)。
    const u = 1 - rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}
