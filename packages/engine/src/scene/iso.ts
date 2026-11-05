/** 等距投影绘图工具：所有设备都由这些图元拼成。 */
export type Point = [number, number];
export type Project = (x: number, y: number, z?: number) => Point;

const COS30 = Math.cos(Math.PI / 6);
export const STROKE = 'var(--art-line)';

export const projector = (originX = 0, originY = 0): Project => (x, y, z = 0) => [
  originX + (x - y) * COS30,
  originY + (x + y) * 0.5 - z,
];

const pts = (points: Point[]) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
export const polygon = (points: Point[], attrs = '') => `<polygon points="${pts(points)}" ${attrs}/>`;
export const polyline = (points: Point[], attrs = '') => `<polyline points="${pts(points)}" fill="none" ${attrs}/>`;

export interface BoxStyle {
  top?: string;
  left?: string;
  right?: string;
  stroke?: string;
  width?: number;
}

/** 画一个长方体的三个可见面。 */
export function box(p: Project, x: number, y: number, z: number, w: number, d: number, h: number, style: BoxStyle = {}): string {
  const { top = 'url(#face-top)', left = 'url(#face-left)', right = 'url(#face-right)', stroke = STROKE, width = 1.8 } = style;
  const line = `stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round"`;
  return (
    polygon([p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)], `fill="${top}" ${line}`) +
    polygon([p(x, y + d, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x, y + d, z + h)], `fill="${left}" ${line}`) +
    polygon([p(x + w, y + d, z), p(x + w, y, z), p(x + w, y, z + h), p(x + w, y + d, z + h)], `fill="${right}" ${line}`)
  );
}

export interface Faces {
  top: (u: number, v: number) => Point;
  left: (u: number, v: number) => Point;
  right: (u: number, v: number) => Point;
}

/** 把面内坐标 (u, v) 映射到屏幕，用来在面上贴图案。 */
export const facesOf = (p: Project, x: number, y: number, z: number, w: number, d: number, h: number): Faces => ({
  top: (u, v) => p(x + u, y + v, z + h),
  left: (u, v) => p(x + u, y + d, z + v),
  right: (u, v) => p(x + w, y + d - u, z + v),
});

export const quad = (face: (u: number, v: number) => Point, u: number, v: number, w: number, h: number, attrs = '') =>
  polygon([face(u, v), face(u + w, v), face(u + w, v + h), face(u, v + h)], attrs);

/** 贴地阴影：向右下延伸的渐隐平行四边形。 */
export const shadow = (p: Project, x: number, y: number, w: number, d: number, reach: number) =>
  polygon([p(x + w, y), p(x + w + reach, y), p(x + w + reach, y + d), p(x + w, y + d)], 'class="iso-shadow"');

/** 贴在顶面上的文字。 */
export function topText(p: Project, x: number, y: number, z: number, text: string, size: number, extra = ''): string {
  const [tx, ty] = p(x, y, z);
  return `<text transform="matrix(${COS30.toFixed(4)} 0.5 ${(-COS30).toFixed(4)} 0.5 ${tx.toFixed(2)} ${ty.toFixed(2)})" font-size="${size}" font-weight="800" text-anchor="middle" dominant-baseline="central" ${extra}>${text}</text>`;
}
