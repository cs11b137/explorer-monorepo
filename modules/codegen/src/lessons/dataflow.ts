import { concept, irLine, makeLayer, wire } from '../decode/structures';
import { LIVE, SUM } from '../compiler';
import { fmtInst, predecessors, slotNames, successors } from '../compiler/ir';
import { variableFlow } from '../compiler/dataflow';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';
import { cfgView, shortIr } from './views';

const fn = SUM.o0;
const slots = slotNames(fn);
const flow = variableFlow(fn);
const BLOCKS = fn.blocks.map((block) => block.name);

/** CFG 面板里的指令文本：allocas 只记数量，省掉每行相同的 align 4。 */
function blockLines(name: string): string[] {
  const block = fn.blocks.find((item) => item.name === name)!;
  const allocas = block.insts.filter((inst) => inst.op === 'alloca').length;
  const rest = block.insts.filter((inst) => inst.op !== 'alloca').map((inst) => shortIr(fmtInst(inst, slots)));
  return allocas ? [`（${allocas} 个 alloca）`, ...rest] : rest;
}

type Sets = Map<string, { in: string[]; out: string[] }>;

function cfg(shown: string[], opts: { tone?: Tone; lit?: string; edges?: Array<[string, string]>; loopTone?: boolean; sub?: string } = {}): ArtView {
  const view = cfgView({
    title: '控制流图',
    sub: opts.sub ?? `${shown.length} 个基本块，省略修饰词`,
    width: 500,
    height: 472,
    layout: 'grid',
    lines: (name) => (shown.includes(name) ? blockLines(name) : []),
    tone: (name) => (name === opts.lit ? opts.tone ?? 'amber' : undefined),
    edgeTone: (from, to) => (opts.loopTone && from === 'while.body' && to === 'while.cond' ? 'amber' : opts.edges?.some(([a, b]) => a === from && b === to) ? 'blue' : undefined),
  });
  if (view.kind === 'graph') {
    view.nodes = view.nodes.filter((node) => shown.includes(node.id));
    view.edges = view.edges.filter((edge) => opts.edges?.some(([a, b]) => a === edge.from && b === edge.to));
  }
  return view;
}

function table(sets: Sets | null, lit?: string, show = true, sub = '后向分析'): ArtView {
  return {
    kind: 'table',
    title: '活跃变量表',
    sub,
    cols: ['基本块', 'USE', 'DEF', 'IN', 'OUT'],
    widths: [70, 50, 66, 66, 66],
    rows: flow.map((block) => ({
      cells: [block.name, show ? block.use.join(' ') || '∅' : '', show ? block.def.join(' ') || '∅' : '', sets?.get(block.name)?.in.join(' ') ?? '', sets?.get(block.name)?.out.join(' ') ?? ''],
      tone: block.name === lit ? 'amber' as Tone : undefined,
    })),
    size: 11.5,
  };
}

const logView = (lines: CodeLine[], sub: string): ArtView => ({ kind: 'code', title: '迭代记录', sub, lines, size: 12, focus: lines.length - 1 });

const edges = fn.blocks.flatMap((block) => successors(block).map((to): [string, string] => [block.name, to]));

/** 一个块的 USE/DEF：字节就是块里的第一条 IR 文本，字段是集合。 */
function flowLayer(name: string) {
  const block = flow.find((item) => item.name === name)!;
  const layer = makeLayer(`基本块 ${name}`, 'blue');
  layer.field('USE', block.use.join(' ') || '∅', () => {}, { note: '在块内被写之前就读了的变量。' });
  layer.field('DEF', block.def.join(' ') || '∅', () => {}, { note: '在块内被写过的变量。' });
  layer.field('后继', successors(fn.blocks.find((item) => item.name === name)!).join(' ') || '无');
  return layer;
}

const blockEvents: PacketEvent[] = BLOCKS.map((name, index) => {
  const block = fn.blocks[index];
  const first = fmtInst(block.insts.find((inst) => inst.op !== 'alloca')!, slots);
  return pk('ir', 'cfg', 'blue', name, [`${block.insts.length} 条指令`], [4, 'CFG', `基本块 ${name}：${block.insts.length} 条指令，以 ${block.insts[block.insts.length - 1].op === 'br' ? '跳转' : block.insts[block.insts.length - 1].op === 'condbr' ? '条件跳转' : 'ret'} 结束`, null],
    wire(`基本块 ${name} 的第一条非 alloca 指令`, 'mem', 'text', irLine(first, 'blue', name)), { quick: true, art: { cfg: cfg(BLOCKS.slice(0, index + 1), { lit: name, tone: 'blue' }) } });
});

const edgeEvents: PacketEvent[] = edges.map(([from, to], index) => {
  const back = from === 'while.body' && to === 'while.cond';
  return pk('ir', 'cfg', back ? 'amber' : 'blue', back ? '回边' : '边', [`${from} → ${to}`], [4, 'CFG', `${from} → ${to}${back ? '：回边，说明这里有循环' : ''}`, null],
    wire('边来自基本块的最后一条指令', 'mem', 'text', irLine(fmtInst(fn.blocks.find((block) => block.name === from)!.insts.at(-1)!, slots), back ? 'amber' : 'blue', from)), {
      quick: true,
      art: { cfg: cfg(BLOCKS, { edges: edges.slice(0, index + 1), loopTone: back, lit: back ? 'while.cond' : undefined }) },
    });
});

const useDefEvents: PacketEvent[] = BLOCKS.map((name) => {
  const block = flow.find((item) => item.name === name)!;
  return pk('cfg', 'ir', 'violet', name, [`USE ${block.use.join(' ') || '∅'}`, `DEF ${block.def.join(' ') || '∅'}`], [4, 'LIVE', `${name}：USE = {${block.use.join(' ')}}，DEF = {${block.def.join(' ')}}`, null],
    wire('USE 和 DEF 是分析的中间结果', 'mem', '示意', flowLayer(name)), { quick: true, art: { table: table(new Map(), name, true, `扫描 ${name}`), cfg: cfg(BLOCKS, { edges, lit: name, tone: 'violet' }) } });
});

const sets: Sets = new Map();
const log: CodeLine[] = [];
const updateEvents: PacketEvent[] = LIVE.updates.map((update) => {
  sets.set(update.block, { in: update.in, out: update.out });
  log.push({ text: `第${update.round}轮 ${update.block.padEnd(10)} IN={${update.in.join(' ')}}`, tone: update.changed ? 'amber' : undefined });
  const layer = makeLayer(`第 ${update.round} 轮 · ${update.block}`, update.changed ? 'amber' : 'slate', update.changed ? '有变化' : '没有变化');
  layer.field('OUT', update.out.join(' ') || '∅', () => {}, { note: '所有后继块 IN 的并集。' });
  layer.field('IN', update.in.join(' ') || '∅', () => {}, { note: 'USE ∪ (OUT − DEF)。' });
  return pk('cfg', 'ir', update.changed ? 'amber' : 'slate', update.block, [`IN ${update.in.join(' ') || '∅'}`], [4, 'LIVE', `第 ${update.round} 轮 ${update.block}：IN = {${update.in.join(' ')}}，OUT = {${update.out.join(' ')}}${update.changed ? '' : '，没有变化'}`, null],
    wire('迭代求解活跃变量', 'mem', '示意', layer), {
      quick: true,
      art: { table: table(new Map(sets), update.block, true, `第 ${update.round} 轮`), log: logView([...log], `第 ${update.round} 轮`), cfg: cfg(BLOCKS, { edges, lit: update.block, tone: update.changed ? 'amber' : 'slate' }) },
    });
});

const finalSets: Sets = new Map(LIVE.rows.map((row) => [row.name, { in: row.in, out: row.out }]));
const neverRead = fn.blocks.flatMap((block) => block.insts.flatMap((inst) => (inst.op === 'alloca' ? [inst.dst] : []))).filter((slot) => !fn.blocks.some((block) => block.insts.some((inst) => inst.op === 'load' && inst.ptr.k === 'reg' && inst.ptr.name === slot)));
const roundsTotal = LIVE.rounds;
const loopLive = LIVE.rows.find((row) => row.name === 'while.cond')!.in;
const preds = predecessors(fn);

export const dataflow: Lesson = seal({
  id: 'dataflow',
  name: 'DATAFLOW',
  title: 'CFG 与活跃变量',
  group: 'middle',
  layer: [4, 4],
  nodes: ['ir', 'cfg'],
  place: { ir: [240, 56], cfg: [660, 56] },
  labels: { ir: ['LLVM IR', '-O0 的输出'], cfg: ['控制流图', '基本块和边'] },
  panels: { cfg: [10, 146, 520, 520], table: [540, 146, 350, 150], log: [540, 306, 350, 360] },
  initial: { cfg: cfg([], { sub: '等待切分' }), table: table(null, undefined, false, '等待分析'), log: logView([{ text: '从 while.end 往前算', dim: true }], '尚未开始') },
  start: ['ir'],
  legend: [['blue', '建图'], ['violet', 'USE 和 DEF'], ['amber', '集合有变化'], ['slate', '没有变化']],
  overview: {
    full: '变量在哪些地方还有用',
    description: '优化器想知道：这个值后面还用不用？答案取决于所有可能的执行路径。把函数切成基本块，连成控制流图，再用迭代的方法算出每个块入口和出口的活跃变量。寄存器分配和死代码消除都靠这个结果。',
    facts: [
      ['基本块', `${BLOCKS.length} 个`],
      ['边', `${edges.length} 条，其中 1 条回边`],
      ['分析方向', '后向'],
      ['迭代轮数', `${roundsTotal} 轮`],
      ['方程', 'IN = USE ∪ (OUT − DEF)'],
    ],
  },
  steps: [
    {
      title: '切基本块',
      desc: '第一条、跳转目标、跳转之后都开新块',
      detail: '基本块是一段只能从头进、从尾出的直线代码，只要进了第一条，后面都会执行。切分规则很机械：函数第一条、任何跳转的目标、任何跳转的下一条，都是新块的开头。这里 IR 生成器已经按块写好了。',
      facts: [['块数', String(BLOCKS.length)], ['最长的块', 'entry'], ['最短的块', 'while.cond']],
      events: [show('cfg'), ...blockEvents],
    },
    {
      title: '连接边',
      desc: '跳转指令决定边，回边就是循环',
      detail: '块的最后一条指令决定去向：无条件跳转一条边，条件跳转两条，ret 没有。while.body 跳回 while.cond 的那条边指向自己的祖先，这种回边就意味着循环。从此可以不看源码，只靠图来讨论程序的结构。',
      facts: [['边数', String(edges.length)], ['回边', 'while.body → while.cond'], ['while.cond 的前驱', preds.get('while.cond')!.join('、')]],
      events: [...edgeEvents, note('cfg', '回边 = 循环', 'amber')],
    },
    {
      title: 'USE 和 DEF',
      desc: '每个块单独扫一遍',
      detail: 'USE 是块里没写之前就读的变量，也就是它要求别人提供的。DEF 是块里写过的变量。注意 while.body 里 i 先被读后被写，所以它同时在 USE 和 DEF 里。这两个集合只看块内部，算一次就不变了。',
      facts: [['while.cond 的 USE', flow[1].use.join(' ')], ['while.body 的 DEF', flow[2].def.join(' ')], ['while.end 的 USE', flow[3].use.join(' ')]],
      events: useDefEvents,
    },
    {
      title: '迭代到不动点',
      desc: '从后往前算，直到不再变化',
      detail: `变量活跃，是说将来还可能读到它，所以信息要从后往前流。每个块用后继的 IN 算自己的 OUT，再用方程算 IN。因为有回边，第一轮算到 while.body 时 while.cond 的结果还没出来，要多算几轮。集合只增不减，所以一定会停，这里第 ${roundsTotal} 轮没有变化就结束了。`,
      facts: [['总轮数', String(roundsTotal)], ['while.cond 的 IN', loopLive.join(' ')], ['停止条件', '一整轮没有变化']],
      events: updateEvents,
    },
    {
      title: '结果有什么用',
      desc: '发现死变量，也知道谁跨越循环',
      detail: `变量 ${neverRead.map((slot) => slot.replace(/\.addr$/, '')).join('、')} 写了之后从来没人读，是死的，它的计算可以删。n、m、s、i 在循环入口活跃，要在循环里一直占着位置，这决定了寄存器压力。k 只在 entry 里用，出了 entry 就不活跃了，占的位置可以让出来。`,
      facts: [['从未被读', neverRead.map((slot) => slot.replace(/\.addr$/, '')).join(' ')], ['跨越循环', loopLive.join(' ')], ['entry 之后不活跃', 'k d']],
      events: [
        pk('cfg', 'ir', 'green', '结论', [`死变量 ${neverRead.join(' ')}`], [4, 'LIVE', `结论：${neverRead.join(' ')} 从未被读；循环入口活跃的是 ${loopLive.join(' ')}`, null],
          wire('分析结果', 'mem', '示意', concept('活跃分析的结论', [
            ['死变量', neverRead.join(' '), '定义了但没有任何路径会读。'],
            ['循环入口活跃', loopLive.join(' '), '这些值要在循环中保留。'],
            ['entry 出口活跃', LIVE.rows[0].out.join(' ')],
          ], 'green')), { art: { table: table(finalSets, undefined, true, '不动点'), cfg: cfg(BLOCKS, { edges, sub: `${roundsTotal} 轮收敛` }) } }),
      ],
    },
  ],
  outro: {
    title: '从局部信息推出全局结论',
    desc: '这种迭代框架叫数据流分析',
    text: '活跃变量只是一个例子。把方向、集合和方程换一下，同一套迭代框架就能算可用表达式、到达定义等。它不需要知道程序实际走了哪条路，只按所有可能的路径取并集，所以结论对每种运行都成立。',
    facts: [['结果类型', '保守的：可能活跃就算活跃'], ['复杂度', '循环层数少时几轮就收敛'], ['下一课', 'SSA']],
  },
});

