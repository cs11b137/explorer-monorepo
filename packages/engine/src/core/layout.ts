const LAYOUTS = [
  { name: 'wide', min: 1440, canvas: 1672 },
  { name: 'medium', min: 1100, canvas: 1180 },
  { name: 'tablet', min: 900, canvas: 900 },
  { name: 'narrow', min: 640, canvas: 640 },
  { name: 'phone', min: 0, canvas: 380 },
] as const;

/** 按窗口宽度选布局档。宽屏等比缩放整块画布，窄屏只缩不放。 */
export function applyLayout(shell: HTMLElement): { stacked: boolean } {
  const root = document.documentElement;
  const width = root.clientWidth;
  const layout = LAYOUTS.find((item) => width >= item.min) ?? LAYOUTS[LAYOUTS.length - 1];
  const scale = layout.name === 'wide' ? width / layout.canvas : Math.min(1, width / layout.canvas);
  const stacked = layout.name !== 'wide' && layout.name !== 'medium';
  root.dataset.layout = layout.name;
  root.classList.toggle('is-stacked', stacked);
  root.classList.toggle('is-single', layout.name === 'narrow' || layout.name === 'phone');
  shell.style.setProperty('zoom', String(scale));
  shell.style.width = `${width / scale}px`;
  shell.style.height = stacked ? '' : `${window.innerHeight / scale}px`;
  shell.style.minHeight = stacked ? `${window.innerHeight / scale}px` : '';
  return { stacked };
}
