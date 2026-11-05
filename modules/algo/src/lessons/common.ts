import type { DsCell, Tone } from './types';

/** 示例地址：真实运行时每次都不同，所以界面上都带 E.G. 标记。 */
export const HEAP = 0x55d0c8a012a0n;
export const STACK = 0x7ffd3c21a4e0n;
export const TEXT_RET = 0x55d0c7e01a4cn;

export interface CellOptions {
  tones?: Record<number, Tone>;
  lift?: number[];
  /** 值的身份：同一个值换了位置时，动画是它移过去。 */
  keys?: Array<string | number>;
  /** 其余格子的默认颜色。 */
  rest?: Tone;
  subs?: string[];
}

/** 把一组值变成一排格子。null 表示这一格没有数据。 */
export function cellsOf(values: Array<number | string | null>, options: CellOptions = {}): DsCell[] {
  return values.map((value, index) => ({
    v: value === null ? '' : String(value),
    key: options.keys ? String(options.keys[index]) : undefined,
    tone: options.tones?.[index] ?? options.rest,
    lift: options.lift?.includes(index) || undefined,
    sub: options.subs?.[index],
  }));
}

/** 按中序位置和深度给二叉树节点排坐标，根在中心上方。 */
export function treeLayout<T>(root: T | null, left: (node: T) => T | null, right: (node: T) => T | null, dx = 86, dy = 92): Map<T, { x: number; y: number; depth: number }> {
  const out = new Map<T, { x: number; y: number; depth: number }>();
  let order = 0;
  const walk = (node: T | null, depth: number) => {
    if (!node) return;
    walk(left(node), depth + 1);
    out.set(node, { x: order++ * dx, y: depth * dy, depth });
    walk(right(node), depth + 1);
  };
  walk(root, 0);
  const rootX = root ? out.get(root)!.x : 0;
  for (const value of out.values()) value.x -= rootX;
  return out;
}

/** 完全二叉树（堆）下标 i 的坐标。 */
export function heapPoint(index: number, spread = 330, dy = 88): { x: number; y: number } {
  const level = Math.floor(Math.log2(index + 1));
  const first = 2 ** level - 1;
  const slots = 2 ** level;
  const x = ((index - first + 0.5) / slots - 0.5) * spread * 2;
  return { x, y: level * dy };
}
