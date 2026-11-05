import { must } from '../core/dom';
import { stageMarkup } from '../scene/stage';
import { site } from '../site';
import { ICONS } from './icons';
import { inspectorMarkup } from './inspector';
import { sequenceMarkup } from './sequence';

export type ViewName = 'network' | 'sequence';

export function simulationMarkup(): string {
  const { simulation, stage } = site();
  return `
  <section class="panel simulation">
    ${stageMarkup(stage)}${simulation?.afterNetwork ? `
    ${simulation.afterNetwork}` : ''}
    ${sequenceMarkup()}
    <div class="view-switch" role="tablist" aria-label="视图" title="切换视图 (V)">
      <button type="button" role="tab" data-view="network" aria-selected="true" class="is-active">${ICONS.layers}<span>结构图</span></button>
      <button type="button" role="tab" data-view="sequence" aria-selected="false">${ICONS.sequence}<span>时序图</span></button>
      <i class="view-indicator"></i>
    </div>
    ${simulation?.beforeInspector ? `${simulation.beforeInspector}
    ` : ''}${inspectorMarkup()}
  </section>`;
}

export function initViewSwitch(root: HTMLElement, initial: ViewName, onChange: (view: ViewName, persist: boolean) => void) {
  const indicator = must<HTMLElement>(root, '.view-indicator');
  const buttons = [...root.querySelectorAll<HTMLElement>('.view-switch button')];
  const place = () => {
    const active = must<HTMLElement>(root, '.view-switch button.is-active');
    indicator.style.left = `${active.offsetLeft}px`;
    indicator.style.width = `${active.offsetWidth}px`;
  };
  function set(view: ViewName, persist = true): void {
    root.classList.toggle('is-sequence', view === 'sequence');
    buttons.forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    place();
    onChange(view, persist);
  }
  must(root, '.view-switch').addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('button');
    if (button) set(button.dataset.view as ViewName);
  });
  set(initial, false);
  requestAnimationFrame(() => indicator.classList.add('is-ready'));
  const observer = new ResizeObserver(place);
  buttons.forEach((button) => observer.observe(button));
  return {
    view: (): ViewName => (root.classList.contains('is-sequence') ? 'sequence' : 'network'),
    toggle: () => set(root.classList.contains('is-sequence') ? 'network' : 'sequence'),
  };
}
