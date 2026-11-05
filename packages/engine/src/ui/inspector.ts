import { EASE_OUT, esc, must, reducedMotion } from '../core/dom';
import { slideSwap } from '../core/transitions';
import { decode, type Decoded, type Field } from '../decode/writer';
import { site } from '../site';
import { labelOf, packetsOf, type LessonLike, type PacketLike } from '../types';

export function inspectorMarkup(): string {
  return `
  <div class="inspector" hidden aria-label="事件检查器">
    <div class="ins-head">
      <span class="ins-badge step-badge"></span>
      <div class="ins-title"><b></b><span></span></div>
      <div class="ins-nav">
        <button type="button" data-ins="prev" aria-label="上一个事件" title="上一个事件 (←)">‹</button>
        <button type="button" data-ins="next" aria-label="下一个事件" title="下一个事件 (→)">›</button>
        <button type="button" data-ins="close" aria-label="关闭" title="关闭 (Esc)">✕</button>
      </div>
    </div>
    <div class="ins-where"></div>
    <div class="ins-bar"></div>
    <div class="ins-body"><div class="ins-tree"></div><div class="ins-hex"></div></div>
    <div class="ins-foot">${site().inspector.foot}</div>
  </div>`;
}

function fieldHtml(field: Field, index: number): string {
  const classes = [`d${field.depth ?? 0}`, field.heading && 'is-heading', field.hidden && 'is-hidden', field.mono && 'is-mono'].filter(Boolean).join(' ');
  const range = field.to > field.from ? ` data-from="${field.from}" data-to="${field.to}"` : '';
  const bits = field.bits ? ` data-bits="${field.bits.word}:${field.bits.ranges.map(([hi, lo]) => `${hi}-${lo}`).join(',')}"` : '';
  const tone = field.tone ? ` c-${field.tone}` : '';
  return `
    <div class="ins-field ${classes}${tone}" data-field="${index}"${range}${bits}>
      <span class="ins-name">${esc(field.name)}</span>
      <span class="ins-value">${esc(field.value)}${field.example ? ' <i class="eg">E.G.</i>' : ''}</span>
      ${field.note ? `<p class="ins-note">${esc(field.note)}</p>` : ''}
    </div>`;
}

function treeHtml(frame: Decoded): string {
  return frame.layers
    .map((layer) => {
      const fields = frame.fields.map((field, index) => [field, index] as const).filter(([field]) => field.layer === layer.id);
      return `
      <section class="ins-layer c-${layer.color}" data-layer="${layer.id}">
        <h4><span>${esc(layer.name)}</span>${layer.summary ? `<em>${esc(layer.summary)}</em>` : ''}</h4>
        ${fields.map(([field, index]) => fieldHtml(field, index)).join('')}
      </section>`;
    })
    .join('');
}

const layerAt = (frame: Decoded, offset: number) => frame.layers.find((layer) => offset >= layer.from && offset < layer.to);

/** 覆盖某一位的最窄字段。 */
function fieldOfBit(frame: Decoded, word: number, bit: number): number {
  let best = -1;
  let bestWidth = Infinity;
  frame.fields.forEach((field, index) => {
    if (field.bits?.word !== word) return;
    const width = field.bits.ranges.reduce((sum, [hi, lo]) => sum + hi - lo + 1, 0);
    if (width < bestWidth && field.bits.ranges.some(([hi, lo]) => bit <= hi && bit >= lo)) {
      best = index;
      bestWidth = width;
    }
  });
  return best;
}

/** 位视图：高位在左，每一位都能和左边的字段联动。 */
function wordsHtml(frame: Decoded): string {
  if (!frame.words.length) return '';
  const blocks = frame.words.map((word, index) => {
    const cells: string[] = [];
    const ticks: string[] = [];
    let previous = -2;
    for (let bit = word.width - 1; bit >= 0; bit--) {
      const field = fieldOfBit(frame, index, bit);
      const tone = field >= 0 ? frame.fields[field].tone ?? word.color : word.color;
      const on = Math.floor(word.value / 2 ** bit) % 2;
      const edge = field !== previous;
      cells.push(`<span class="bt c-${tone}${on ? ' is-one' : ''}${edge && bit !== word.width - 1 ? ' is-edge' : ''}" data-b="${index}:${bit}">${on}</span>`);
      const lastOfField = bit === 0 || fieldOfBit(frame, index, bit - 1) !== field;
      ticks.push(`<span>${edge || lastOfField ? bit : ''}</span>`);
      previous = field;
    }
    const style = `--bits:${word.width}`;
    return `<div class="bt-word"><div class="bt-name">${esc(word.name)}</div><div class="bt-ticks" style="${style}">${ticks.join('')}</div><div class="bt-row" style="${style}">${cells.join('')}</div></div>`;
  });
  return `<div class="hx-head">位 <span>高位在左，悬停可对应左边的字段</span></div>${blocks.join('')}`;
}

function hexHtml(frame: Decoded): string {
  const config = site().inspector;
  if (!frame.bytes.length) {
    return `<div class="hx-head">字节</div><p class="hx-empty">${config.emptyText ?? '这是一个纯信号事件，或这里讲的是概念结构，所以没有可以展示的字节。'}</p>`;
  }
  const colorAt = (offset: number) => layerAt(frame, offset)?.color ?? 'slate';
  if (frame.view !== 'mem') return wordsHtml(frame) + regsHtml(frame, colorAt);
  const rows: string[] = [];
  // 分段时各层在页里不相邻，地址列显示它们真实的偏移。
  const spans = config.segmentLayers ? frame.layers.map((layer) => ({ from: layer.from, to: layer.to, addr: layer.addr })) : [{ from: 0, to: frame.bytes.length, addr: 0 }];
  for (const span of spans) {
    for (let at = span.from; at < span.to; at += 16) {
      const slice = frame.bytes.slice(at, Math.min(at + 16, span.to));
      const hexCells = slice
        .map((byte, index) => `<span class="hx c-${colorAt(at + index)}${byte === null ? ' is-unknown' : ''}" data-i="${at + index}">${byte === null ? '··' : byte.toString(16).padStart(2, '0')}</span>`)
        .join('');
      const textCells = slice
        .map((byte, index) => `<span class="as${byte === null ? ' is-unknown' : ''}" data-i="${at + index}">${byte === null ? '·' : byte >= 32 && byte < 127 ? esc(String.fromCharCode(byte)) : '.'}</span>`)
        .join('');
      rows.push(`<div class="hx-row"><span class="hx-at">${(span.addr + at - span.from).toString(16).padStart(4, '0')}</span><span class="hx-bytes">${hexCells}</span><span class="hx-text">${textCells}</span></div>`);
    }
  }
  const head = config.memHead?.(frame.bytes.length) ?? `字节 <span>本结构共 ${frame.bytes.length} 字节</span>`;
  return `${wordsHtml(frame)}<div class="hx-head">${head}</div>${rows.join('')}`;
}

/** 寄存器不是相邻内存：逐行显示，数值按高位在前。 */
function regsHtml(frame: Decoded, colorAt: (offset: number) => string): string {
  const rows = frame.fields
    .filter((field) => (field.depth ?? 0) === 0 && field.to > field.from)
    .map((field) => {
      const cells: string[] = [];
      for (let index = field.to - 1; index >= field.from; index--) {
        const byte = frame.bytes[index];
        cells.push(`<span class="hx c-${colorAt(index)}${byte === null ? ' is-unknown' : ''}" data-i="${index}">${byte === null ? '··' : byte.toString(16).padStart(2, '0')}</span>`);
      }
      return `<div class="hx-row hx-reg"><span class="hx-at">${esc(field.name.split(' ')[0])}</span><span class="hx-bytes">${cells.join('')}</span></div>`;
    });
  return `<div class="hx-head">${site().inspector.valuesHead ?? '寄存器 <span>各自独立，不是连续内存</span>'}</div>${rows.join('')}`;
}

function barHtml(frame: Decoded): string {
  const total = frame.bytes.length;
  return frame.layers
    .map((layer) => {
      const size = layer.to - layer.from;
      const grow = total ? Math.max(size, total * 0.045) : 1;
      return `<span class="ins-seg c-${layer.color}" data-layer="${layer.id}" style="flex:${grow}" title="${esc(layer.name)}"><b>${esc(layer.name.split(' · ')[0])}</b><i>${size ? `${size} B` : '无字节'}</i></span>`;
    })
    .join('');
}

function light(root: HTMLElement, from?: number, to?: number, field?: Element | null): void {
  root.querySelectorAll('.is-lit').forEach((element) => element.classList.remove('is-lit'));
  if (from === undefined || to === undefined) return;
  for (let index = from; index < to; index++) {
    root.querySelectorAll(`[data-i="${index}"]`).forEach((element) => element.classList.add('is-lit'));
  }
  field?.classList.add('is-lit');
  const bits = (field as HTMLElement | null | undefined)?.dataset?.bits;
  if (!bits) return;
  const [word, spec] = bits.split(':');
  for (const part of spec.split(',')) {
    const [hi, lo] = part.split('-').map(Number);
    for (let bit = lo; bit <= hi; bit++) root.querySelector(`[data-b="${word}:${bit}"]`)?.classList.add('is-lit');
  }
}

export function createInspector(root: HTMLElement, options: { visible(): number[]; onChange(index: number | null): void }) {
  let lesson: LessonLike<any> | null = null;
  let frame: Decoded | null = null;
  const isOpen = () => !root.hidden && !root.classList.contains('is-closing');

  function renderHeader(index: number): void {
    const config = site();
    const packet = packetsOf(lesson!)[index] as PacketLike;
    frame = decode(packet.wire);
    root.dataset.index = String(index);
    const badge = must<HTMLElement>(root, '.ins-badge');
    badge.className = `ins-badge step-badge ${packet.color}`;
    badge.textContent = String(index + 1);
    must(root, '.ins-title b').textContent = packet.label;
    must(root, '.ins-title span').textContent = [
      (config.inspector.meta ?? config.rowTime)(packet.row, lesson!),
      `${labelOf(lesson!, packet.from)} → ${labelOf(lesson!, packet.to)}`,
      packet.row.type,
      config.formatSize(packet.row.size),
    ].join(' · ');
    const notes = [frame.at, config.inspector.fidelityText[frame.fidelity]];
    if (packet.lost) notes.push(config.inspector.lostNote);
    must(root, '.ins-where').textContent = notes.join(' · ');
    must(root, '.ins-bar').innerHTML = barHtml(frame);
  }

  function renderBody(): void {
    must(root, '.ins-tree').innerHTML = treeHtml(frame!);
    must(root, '.ins-hex').innerHTML = hexHtml(frame!);
    must(root, '.ins-tree').scrollTop = 0;
    must(root, '.ins-hex').scrollTop = 0;
  }

  function open(nextLesson: LessonLike<any>, index: number): void {
    lesson = nextLesson;
    const wasOpen = isOpen();
    root.getAnimations().forEach((animation) => animation.cancel());
    root.classList.remove('is-closing');
    root.hidden = false;
    renderHeader(index);
    renderBody();
    if (!wasOpen && !reducedMotion()) {
      root.animate([{ opacity: 0, transform: 'translateY(26px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE_OUT });
    }
    options.onChange(index);
  }

  function close(): void {
    if (root.hidden) return;
    options.onChange(null);
    if (reducedMotion()) {
      root.hidden = true;
      return;
    }
    root.classList.add('is-closing');
    root.getAnimations().forEach((animation) => animation.cancel());
    root.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(18px)' }], { duration: 200, easing: 'ease-in' }).onfinish = () => {
      if (root.classList.contains('is-closing')) {
        root.classList.remove('is-closing');
        root.hidden = true;
      }
    };
  }

  function step(direction: number): void {
    if (!isOpen()) return;
    const list = options.visible();
    const next = list[list.indexOf(Number(root.dataset.index)) + direction];
    if (next === undefined) return;
    renderHeader(next);
    slideSwap(must(root, '.ins-body'), renderBody, { direction, distance: 14 });
    options.onChange(next);
  }

  root.addEventListener('click', (event) => {
    const target = event.target as Element;
    const action = target.closest<HTMLElement>('[data-ins]')?.dataset.ins;
    if (action === 'prev') step(-1);
    if (action === 'next') step(1);
    if (action === 'close') close();
    const seg = target.closest<HTMLElement>('.ins-seg');
    if (seg) root.querySelector(`.ins-layer[data-layer="${seg.dataset.layer}"]`)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  });
  root.addEventListener('mouseover', (event) => {
    const target = event.target as Element;
    const field = target.closest<HTMLElement>('.ins-field[data-from]');
    if (field) {
      light(root, Number(field.dataset.from), Number(field.dataset.to), field);
      return;
    }
    const bitCell = target.closest<HTMLElement>('[data-b]');
    if (bitCell && frame) {
      const [word, bit] = bitCell.dataset.b!.split(':').map(Number);
      const index = fieldOfBit(frame, word, bit);
      if (index < 0) return;
      const row = root.querySelector<HTMLElement>(`.ins-field[data-field="${index}"]`);
      light(root, frame.fields[index].from, frame.fields[index].to, row);
      row?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const byte = target.closest<HTMLElement>('[data-i]');
    if (!byte || !frame) return;
    const offset = Number(byte.dataset.i);
    const candidates = frame.fields
      .map((item, index) => [item, index] as const)
      .filter(([item]) => offset >= item.from && offset < item.to)
      .sort((a, b) => a[0].to - a[0].from - (b[0].to - b[0].from));
    if (!candidates.length) {
      light(root, offset, offset + 1);
      return;
    }
    const [item, index] = candidates[0];
    const row = root.querySelector(`.ins-field[data-field="${index}"]`);
    light(root, item.from, item.to, row);
    row?.scrollIntoView({ block: 'nearest' });
  });
  root.addEventListener('mouseleave', () => light(root));

  return { open, close, step, isOpen, index: () => (isOpen() ? Number(root.dataset.index) : null) };
}

export type Inspector = ReturnType<typeof createInspector>;
