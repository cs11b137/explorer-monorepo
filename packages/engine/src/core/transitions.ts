import { EASE_OUT, reducedMotion } from './dom';

interface SlideOptions {
  axis?: 'x' | 'y';
  direction?: number;
  distance?: number;
  out?: number;
  in?: number;
}

const running = new WeakMap<Element, { update: () => void }>();

/** 让元素先滑出、换内容、再滑入。动画进行中再次调用时，只替换最终内容。 */
export function slideSwap(element: HTMLElement | SVGElement, update: () => void, options: SlideOptions = {}): void {
  const { axis = 'x', direction = 1, distance = 24, out = 160, in: inn = 300 } = options;
  if (reducedMotion()) {
    update();
    return;
  }
  const active = running.get(element);
  if (active) {
    active.update = update;
    return;
  }
  const state = { update };
  running.set(element, state);
  const at = (value: number) => (axis === 'x' ? `translateX(${value}px)` : `translateY(${value}px)`);
  const leave = element.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: at(-direction * distance * 0.5) },
    ],
    { duration: out, easing: 'ease-in', fill: 'forwards' },
  );
  leave.onfinish = () => {
    running.delete(element);
    state.update();
    leave.cancel();
    element.animate(
      [
        { opacity: 0, transform: at(direction * distance) },
        { opacity: 1, transform: 'none' },
      ],
      { duration: inn, easing: EASE_OUT },
    );
  };
}

/** 文字切换：纵向短距离滑动。文字没变时什么都不做。 */
export function swapText(element: HTMLElement, text: string, direction = 1): void {
  if (element.dataset.text === text) return;
  const first = element.dataset.text === undefined;
  element.dataset.text = text;
  const apply = () => {
    element.textContent = text;
  };
  if (first) apply();
  else slideSwap(element, apply, { axis: 'y', direction, distance: 10, out: 120, in: 240 });
}
