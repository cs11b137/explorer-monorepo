export const SVG_NS = 'http://www.w3.org/2000/svg';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ESC[c]);

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

export function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return found;
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const reducedMotion = (): boolean => motionQuery?.matches ?? false;

export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
