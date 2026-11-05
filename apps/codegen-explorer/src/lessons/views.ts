/** 把编译结果变成场景面板的视图数据。课程里只说“显示什么”，算法结果都从这里取。 */
import { fmtInst, fmtOperand, slotNames, type Inst, type IrFunc } from '../compiler/ir';
import { LEXED } from '../compiler';
import type { Token } from '../compiler/lexer';
import type { Expr, Span } from '../compiler/parser';
import { SOURCE, SOURCE_LINES } from '../compiler/source';
import type { ArtView, CodeLine, GraphEdge, GraphNode, Mark, Tone, TreeNode } from '../scene/art';

export const LINE_STARTS = SOURCE_LINES.reduce<number[]>((starts, _line, index) => {
  starts.push(index ? starts[index - 1] + SOURCE_LINES[index - 1].length + 1 : 0);
  return starts;
}, []);

/** 把源文件的字节区间换算成每行的高亮。 */
export function spanMarks(span: Span, tone: Tone = 'amber'): Map<number, Mark[]> {
  const marks = new Map<number, Mark[]>();
  LINE_STARTS.forEach((start, index) => {
    const end = start + SOURCE_LINES[index].length;
    const from = Math.max(span.from, start);
    const to = Math.min(span.to, end);
    if (from < to) marks.set(index, [{ from: from - start, to: to - start, tone }]);
  });
  return marks;
}

export interface SourceOpts {
  title?: string;
  sub?: string;
  spans?: Array<{ span: Span; tone?: Tone }>;
  lines?: Array<{ line: number; tone: Tone }>;
  focus?: number;
  size?: number;
}

export function sourceView(opts: SourceOpts = {}): ArtView {
  const marks = new Map<number, Mark[]>();
  for (const { span, tone } of opts.spans ?? []) {
    for (const [line, list] of spanMarks(span, tone)) marks.set(line, [...(marks.get(line) ?? []), ...list]);
  }
  const lines: CodeLine[] = SOURCE_LINES.map((text, index) => ({
    text,
    gutter: String(index + 1),
    marks: marks.get(index),
    tone: opts.lines?.find((item) => item.line === index + 1)?.tone,
  }));
  const firstMarked = [...marks.keys()][0];
  return { kind: 'code', title: opts.title ?? '源代码', sub: opts.sub ?? 'sum.c', lines, focus: opts.focus ?? firstMarked, size: opts.size };
}

const KIND_TAG: Partial<Record<Token['kind'], string>> = { int: 'kw', while: 'kw', return: 'kw', if: 'kw', else: 'kw', identifier: 'id', numeric_constant: 'num' };
export const tagOf = (token: Token) => KIND_TAG[token.kind] ?? 'op';

/** 前 count 个 token 的流，current 高亮。 */
export function tokenStrip(count: number, current = -1, title = 'TOKEN 流', tone: Tone = 'amber'): ArtView {
  const list = LEXED.tokens.filter((token) => token.kind !== 'eof').slice(0, count);
  return {
    kind: 'tokens',
    title,
    sub: `已产出 ${list.length} 个`,
    tokens: list.map((token, index) => ({ text: token.text, tag: tagOf(token), tone: index === current ? tone : undefined })),
  };
}

/** 表达式变成树的节点表。known 不为空时，不在其中的节点先占位但不画，树不会跳动。 */
export function exprTree(root: Expr, opts: { known?: Set<number>; lit?: Map<number, Tone>; sub?: (e: Expr) => string | undefined } = {}): TreeNode[] {
  const nodes: TreeNode[] = [];
  const walk = (e: Expr, parent: string | null) => {
    const id = String(e.id);
    const label = e.k === 'num' ? String(e.value) : e.k === 'var' ? e.name : e.k === 'bin' ? e.op : e.k === 'assign' ? '=' : e.k === 'neg' ? '-' : `${e.fn}()`;
    nodes.push({ id, label, parent, tone: opts.lit?.get(e.id), ghost: opts.known ? !opts.known.has(e.id) : false, sub: opts.sub?.(e) });
    if (e.k === 'bin') {
      walk(e.l, id);
      walk(e.r, id);
    }
    if (e.k === 'neg') walk(e.e, id);
    if (e.k === 'assign') {
      walk(e.target, id);
      walk(e.value, id);
    }
    if (e.k === 'call') e.args.forEach((arg) => walk(arg, id));
  };
  walk(root, null);
  return nodes;
}

export interface IrViewOpts {
  title: string;
  sub?: string;
  /** 按结果名或完整文本决定高亮。 */
  tone?: (text: string, inst: Inst, block: string) => Tone | undefined;
  strike?: (text: string, inst: Inst) => boolean;
  /** 只显示这些指令，用于逐条生成。 */
  known?: Set<Inst>;
  focus?: string;
  labelTone?: (block: string) => Tone | undefined;
  size?: number;
}

/** IR 文本面板。 */
export function irView(fn: IrFunc, opts: IrViewOpts): ArtView {
  const slots = slotNames(fn);
  const lines: CodeLine[] = [];
  let focus: number | undefined;
  fn.blocks.forEach((block) => {
    const start = lines.length;
    lines.push({ text: `${block.name}:`, head: true, tone: opts.labelTone?.(block.name) });
    let any = false;
    for (const inst of block.insts) {
      if (opts.known && !opts.known.has(inst)) continue;
      any = true;
      const text = fmtInst(inst, slots);
      const tone = opts.tone?.(text, inst, block.name);
      if (tone && focus === undefined) focus = lines.length;
      lines.push({ text: `  ${text}`, tone, strike: opts.strike?.(text, inst) });
    }
    if (!any && opts.known) lines.length = start;
  });
  if (opts.focus) focus = lines.findIndex((line) => line.text.includes(opts.focus!));
  if (opts.known) focus = focus ?? lines.length - 1;
  return { kind: 'code', title: opts.title, sub: opts.sub, lines, focus, size: opts.size };
}

/** 四个基本块的固定布局，整站的 CFG 都是这个摆法。 */
export interface CfgOpts {
  title: string;
  sub?: string;
  width: number;
  height: number;
  boxW?: number;
  /** 每个块里显示的文本。 */
  lines: (block: string) => GraphNode['lines'];
  tone?: (block: string) => Tone | undefined;
  edgeTone?: (from: string, to: string) => Tone | undefined;
  /** grid：entry 和 while.cond 并排，用于指令很多的 -O0 IR。 */
  layout?: 'stack' | 'grid';
}

export function cfgView(opts: CfgOpts): ArtView {
  const { width, height } = opts;
  const boxW = opts.boxW ?? Math.min(width - 12, 300);
  const heightOf = (name: string) => 20 + Math.max((opts.lines(name) ?? []).length, 1) * 14.5;
  const halfW = (width - 16) / 2;
  const entryH = heightOf('entry');
  const condH = heightOf('while.cond');
  const lowerH = Math.max(heightOf('while.body'), heightOf('while.end'));
  const grid = opts.layout === 'grid';
  const leftX = halfW / 2 + 2;
  const rightX = width - halfW / 2 - 2;
  let spots: Record<string, { x: number; y: number; w: number; h: number }>;
  if (grid) {
    const topH = Math.max(entryH, condH);
    spots = {
      entry: { x: leftX, y: topH / 2, w: halfW - 2, h: topH },
      'while.cond': { x: rightX, y: condH / 2, w: halfW - 2, h: condH },
      'while.body': { x: leftX, y: height - lowerH / 2, w: halfW - 2, h: lowerH },
      'while.end': { x: rightX, y: height - lowerH / 2, w: halfW - 2, h: lowerH },
    };
  } else {
    const gap = Math.max((height - entryH - condH - lowerH) / 2, 14);
    spots = {
      entry: { x: width / 2, y: entryH / 2, w: boxW, h: entryH },
      'while.cond': { x: width / 2, y: entryH + gap + condH / 2, w: boxW, h: condH },
      'while.body': { x: leftX, y: height - lowerH / 2, w: halfW - 2, h: lowerH },
      'while.end': { x: rightX, y: height - lowerH / 2, w: halfW - 2, h: lowerH },
    };
  }
  const nodes: GraphNode[] = Object.entries(spots).map(([id, spot]) => ({ id, ...spot, label: id, lines: opts.lines(id), tone: opts.tone?.(id) }));
  const edge = (from: string, to: string, label?: string, bend?: number): GraphEdge => ({ from, to, label, bend, tone: opts.edgeTone?.(from, to) });
  return {
    kind: 'graph',
    title: opts.title,
    sub: opts.sub,
    width,
    height,
    nodes,
    edges: [
      edge('entry', 'while.cond'),
      edge('while.cond', 'while.body', '真', grid ? 34 : undefined),
      edge('while.cond', 'while.end', '假'),
      edge('while.body', 'while.cond', '回边', grid ? -56 : -Math.min(halfW * 0.62, 120)),
    ],
  };
}

/** CFG 方框里放不下完整的 IR，省掉 align、noundef 和 label 这些修饰词。 */
export const shortIr = (text: string) => text.replace(', align 4', '').replace(/noundef /g, '').replace(/label /g, '');

export const irLinesOf = (fn: IrFunc, block: string, map: (text: string, inst: Inst) => string | { text: string; tone?: Tone; strike?: boolean; dim?: boolean } = (text) => text) => {
  const slots = slotNames(fn);
  const found = fn.blocks.find((item) => item.name === block);
  return (found?.insts ?? []).map((inst) => map(fmtInst(inst, slots), inst));
};

export const hexBytes = (bytes: number[]) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
export const sourceSlice = (span: Span) => SOURCE.slice(span.from, span.to);

export { fmtOperand };
