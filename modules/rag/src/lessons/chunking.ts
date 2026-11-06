/**
 * 第三课：分块。同一篇文档（《商品：真空保温杯 BW-350》）用不同的切法切开：固定长度、带重叠、按句、按段落、递归；
 * 同一个问题（「保温杯漏水了怎么办？」）在每种切法下检索到的块和相似度都不一样。答案那句话「先取下密封圈重新装好再试。」
 * 在原文的第 89 到 102 个字符，固定 48 个字一块时，切点正好落在它中间。
 *
 * 切分来自 core/chunk.ts，块的向量是 core/embed.ts 对块文本真实嵌入的结果，相似度是真实的点积，块数、字符数、字节数、token 数都是实时数的。
 * 没有模型写的文字。tests/narrative.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import { countTokens, docById, docText, DistanceMeter, dot, embed, fixedChunks, paragraphChunks, recursiveChunks, sentences, type Chunk } from '../core';
import { chunkBytes, concept, floatVector, num, preview, utf8Lines, wire } from '../decode/structures';
import { fixed, PART_TONE, pct, vectorRow } from './common';
import { note, pk, show, state } from './dsl';
import type { DsCell, GridPrim, Lesson, RowPrim } from './types';

// ---------- 文档、问题、答案 ----------

export const DOC = docById('cup')!;
export const TEXT = docText(DOC);
export const TEXT_CHARS = [...TEXT].length;
export const TEXT_BYTES = utf8Encode(TEXT).length;
export const TEXT_TOKENS = countTokens(TEXT);

export const QUESTION = '保温杯漏水了怎么办？';
/** 答案那句话：问题的答案「先取下密封圈重新装好再试」，连句号。 */
export const ANSWER = '先取下密封圈重新装好再试。';
export const ANSWER_FROM = TEXT.indexOf(ANSWER);
export const ANSWER_LEN = [...ANSWER].length;
export const ANSWER_TO = ANSWER_FROM + ANSWER_LEN;
export const qVec = embed(QUESTION).vector;

export const SIZE = 48;
export const OVERLAP = 10;
export const DIMS = qVec.length;
export const VECTOR_BYTES = DIMS * 4;

// ---------- 每种切法的结果 ----------

export type Outcome = 'cut' | 'hit' | 'miss';

export interface Run {
  chunks: Chunk[];
  sims: number[];
  top: number;
  topSim: number;
  /** 完整包含答案的块的下标。 */
  whole: number[];
  /** 首位块里包含了答案的几个字。 */
  inTop: number;
  /** cut：没有一块完整包含答案；hit：排第 1 的块完整包含答案；miss：有块包含，但排第 1 的不是它。 */
  outcome: Outcome;
  chars: number;
  bytes: number;
  tokens: number;
  longest: number;
  shortest: number;
}

export const meter = new DistanceMeter();
/** 每一块的嵌入和查询比较一次，记 1 次距离计算。 */
export function run(chunks: Chunk[]): Run {
  const sims = chunks.map((chunk) => dot(qVec, embed(chunk.text).vector));
  meter.add('query', chunks.length);
  const top = sims.indexOf(Math.max(...sims));
  const whole = chunks.flatMap((chunk, i) => (chunk.text.includes(ANSWER) ? [i] : []));
  const lens = chunks.map((chunk) => chunk.to - chunk.from);
  const inTop = Math.max(0, Math.min(chunks[top].to, ANSWER_TO) - Math.max(chunks[top].from, ANSWER_FROM));
  return {
    chunks,
    sims,
    top,
    topSim: sims[top],
    whole,
    inTop,
    outcome: !whole.length ? 'cut' : whole.includes(top) ? 'hit' : 'miss',
    chars: lens.reduce((a, b) => a + b, 0),
    bytes: chunks.reduce((sum, chunk) => sum + chunk.byteTo - chunk.byteFrom, 0),
    tokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
    longest: Math.max(...lens),
    shortest: Math.min(...lens),
  };
}

/** 按课程顺序计算，并记下每一步结束时的累计距离计算次数。 */
export const dist: number[] = [0];
export const A = run(fixedChunks(TEXT, SIZE));
dist.push(meter.total);
export const B = run(fixedChunks(TEXT, SIZE, OVERLAP));
dist.push(meter.total);
export const SENT = run(sentences(TEXT));
export const PARA = run(paragraphChunks(TEXT));
export const REC = run(recursiveChunks(TEXT, { size: SIZE, overlap: OVERLAP }));
dist.push(meter.total);
/** 重叠从 0 到 20 的固定长度切分。0 和 10 就是 A、B。 */
export const OVERLAPS = [0, 5, 10, 12, 15, 20];
export const SWEEP: Run[] = OVERLAPS.map((overlap) => (overlap === 0 ? A : overlap === OVERLAP ? B : run(fixedChunks(TEXT, SIZE, overlap))));
dist.push(meter.total);

/** 重叠够大就保证窗口里有一个能整句装下答案：窗口 size、步长 size − overlap，答案长 L，需要 overlap ≥ L − 1。 */
export const GUARANTEE = ANSWER_LEN - 1;

export const numbers = {
  chars: TEXT_CHARS,
  bytes: TEXT_BYTES,
  tokens: TEXT_TOKENS,
  answerFrom: ANSWER_FROM,
  answerTo: ANSWER_TO,
  answerLen: ANSWER_LEN,
  cut: A.chunks[1].to,
};
const N = numbers;
const bare = (q: string): string => q.replace(/？$/, '');
/** 引用在 detail 里的句子去掉句号（detail 按句号数句子）。 */
const noStop = (text: string): string => text.replace(/。$/, '');
const idx = (i: number): string => `块 ${i}`;
const growth = (r: Run): string => pct(r.chars / A.chars - 1);
const topOf = (r: Run): Chunk => r.chunks[r.top];
const OUTCOME_TEXT: Record<Outcome, string> = { cut: '答案被切断', hit: '首位有完整答案', miss: '首位没有答案' };

// ---------- 图元 ----------

const chunkRow = (id: string, r: Run, marks?: RowPrim['marks'], lift?: number[]): RowPrim => ({
  kind: 'row',
  id,
  w: r.chunks.length > 5 ? 56 : 66,
  cells: r.chunks.map((chunk, i): DsCell => ({ v: `${chunk.to - chunk.from} 字`, sub: `${chunk.from}–${chunk.to}`, tone: PART_TONE.doc, heat: (chunk.to - chunk.from) / SIZE, key: `c${chunk.from}-${chunk.to}`, lift: lift?.includes(i) || undefined })),
  marks,
});

const queryRow = (): RowPrim => vectorRow('q', qVec, { tone: PART_TONE.query, w: 27, keyPrefix: 'q' });

const simRow = (r: Run, marks?: RowPrim['marks']): RowPrim => ({
  kind: 'row',
  id: 'r',
  w: r.chunks.length > 5 ? 56 : 66,
  cells: r.sims.map((sim, i): DsCell => ({ v: fixed(sim, 3), sub: idx(i), tone: PART_TONE.result, heat: sim, key: `s${r.chunks[i].from}-${r.chunks[i].to}`, lift: i === r.top || undefined })),
  marks,
});

const gridOf = (rows: string[], cols: string[], cells: DsCell[][], w: number): GridPrim => ({ kind: 'grid', id: 'g', rows, cols, cells, w });
const cell = (v: string, tone?: DsCell['tone'], heat?: number): DsCell => ({ v, tone, heat });
const outcomeCell = (r: Run): DsCell => cell(OUTCOME_TEXT[r.outcome], r.outcome === 'hit' ? 'green' : r.outcome === 'cut' ? 'amber' : 'dim');

const STRATEGIES: Array<[string, Run]> = [
  [`固定 ${SIZE} / 0`, A],
  [`固定 ${SIZE} / ${OVERLAP}`, B],
  ['按句', SENT],
  ['按段落', PARA],
  [`递归 ${SIZE} / ${OVERLAP}`, REC],
];

const strategyGrid = (): GridPrim =>
  gridOf(
    STRATEGIES.map(([name]) => name),
    ['块数', '最短–最长', '首位相似度', '答案'],
    STRATEGIES.map(([, r]) => [cell(String(r.chunks.length), 'teal', r.chunks.length / 6), cell(`${r.shortest}–${r.longest} 字`, 'teal', 0.5), cell(fixed(r.topSim, 3), 'amber', r.topSim), outcomeCell(r)]),
    66,
  );

const costGrid = (): GridPrim =>
  gridOf(
    OVERLAPS.map((overlap) => `重叠 ${overlap}`),
    ['块数', '字符', '向量字节', '答案'],
    SWEEP.map((r) => [cell(String(r.chunks.length), 'teal', r.chunks.length / 6), cell(`${r.chars}（${growth(r)}）`, 'teal', r.chars / SWEEP[SWEEP.length - 1].chars), cell(`${r.chunks.length * VECTOR_BYTES}`, 'violet', r.chunks.length / 6), outcomeCell(r)]),
    66,
  );

const answerMark = (at: number, text: string): NonNullable<RowPrim['marks']> => [{ at, text, color: 'amber', dx: 30 }];

// ---------- 课程 ----------

export const chunking: Lesson = {
  id: 'chunking',
  name: 'CHUNKING',
  title: '分块策略与重叠',
  group: 'embed',
  layer: [2, 5],
  layerNote: '从文档切成块（分块）、块变成向量（向量），再拿问题去找最近的块（检索）。',
  distNote: `每种切法里，问题的向量和每个块的向量比较一次记 1 次，块越多次数越多，累计 ${meter.total} 次。`,
  nodes: ['docs', 'chunker', 'chunks', 'embedder', 'query', 'results', 'scores'],
  place: { docs: [90, 120], chunker: [430, 60], chunks: [330, 370], embedder: [990, 200], query: [900, 400], results: [720, 540], scores: [110, 750] },
  labels: {
    docs: ['文档库', '真空保温杯 BW-350'],
    chunker: ['切分器', `固定 ${SIZE} 字，重叠可调`],
    chunks: ['切出来的块', '格子下面是字符区间'],
    embedder: ['嵌入模型', `本站 ${DIMS} 维 LSA`],
    query: ['查询向量', '问题的向量'],
    results: ['块和问题的相似度', '点积'],
    scores: ['几种切法', '对比'],
  },
  labelAt: { chunks: [-210, 10], query: [-270, -20], results: [-250, 10], scores: [-330, 100] },
  radius: { chunks: 60, query: 80, results: 60, scores: 70 },
  initial: { chunks: [], query: [], results: [], scores: [] },
  start: ['docs', 'chunker', 'chunks'],
  legend: [['teal', '文档和块'], ['blue', '问题'], ['amber', '相似度和检索结果'], ['violet', '向量'], [null, '距离列：问题和块比较过几次']],
  overview: {
    full: '一篇文档怎样切成块',
    description: `嵌入模型和向量库处理的单位是块，不是整篇文档。同一篇${DOC.title}（${N.chars} 个字符、${N.bytes} 字节），固定 ${SIZE} 个字一块、带重叠、按句、按段落、递归切分，会切出不同的块；同一个问题「${QUESTION}」去检索，找到的块、相似度和答案是否完整都不一样。答案那句话「${noStop(ANSWER)}」在第 ${N.answerFrom} 到 ${N.answerTo} 个字符，这一课看切点落在它中间会怎样，重叠怎样把它救回来，又要多存多少。`,
    facts: [
      ['文档', `${DOC.title}，${N.chars} 字符 / ${N.bytes} 字节 / ${N.tokens} token`],
      ['问题', QUESTION],
      ['答案', `第 ${N.answerFrom}–${N.answerTo} 个字符，${N.answerLen} 个字`],
      ['切法', `固定长度（${SIZE}）、重叠、按句、按段落、递归`],
    ],
  },
  steps: [
    {
      title: `固定 ${SIZE} 个字一块`,
      desc: `${A.chunks.length} 块，切点在第 ${A.chunks.slice(1).map((chunk) => chunk.from).join('、')} 个字符`,
      detail: `文档库把整篇文档交给切分器，最简单的切法是固定长度：每 ${SIZE} 个字符切一刀，不看内容。这篇文档 ${N.chars} 个字符，切出 ${A.chunks.length} 块，长度是 ${A.chunks.map((chunk) => chunk.to - chunk.from).join('、')}（首尾的换行去掉了）。答案那句话在第 ${N.answerFrom} 到 ${N.answerTo} 个字符，第 ${N.cut} 个字符处有一个切点，正好落在它中间。`,
      facts: [['块数', String(A.chunks.length)], ['块长', A.chunks.map((chunk) => chunk.to - chunk.from).join('、') + ' 字'], ['答案', `第 ${N.answerFrom}–${N.answerTo} 字符`], ['切点', `第 ${N.cut} 字符，在答案中间`]],
      events: [
        pk('docs', 'chunker', 'teal', '整篇文档', [DOC.title, `${N.chars} 字符`, `${N.bytes} 字节`], [0, 'LOAD', `读出${DOC.title}：${N.chars} 个字符、${N.bytes} 字节、${N.tokens} token（本站 BPE）`, N.bytes],
          wire('文档的 UTF-8 字节，每个段落一行', 'mem', 'format', utf8Lines(DOC.title, TEXT, { color: 'teal', summary: `${N.chars} 个字符，段落之间一个换行` })),
          { ds: {} }),
        pk('chunker', 'chunks', 'teal', `${A.chunks.length} 块`, A.chunks.map((chunk) => `${idx(chunk.index)}：${chunk.from}–${chunk.to}`), [dist[0], 'CHUNK', `每 ${SIZE} 个字符切一刀：${A.chunks.length} 块，${A.chunks.map((chunk) => chunk.to - chunk.from).join('、')} 个字，${A.tokens} token`, A.bytes],
          wire('切出来的块：字符区间和字节区间', 'mem', 'internal', chunkBytes(DOC.title, TEXT, A.chunks, { color: 'teal', summary: `固定 ${SIZE} 字，没有重叠，切成 ${A.chunks.length} 块` })),
          { ds: { chunks: [chunkRow('c', A, answerMark(1, `切点在答案中间`))] } }),
        state('chunker', { 切法: '固定长度', 大小: `${SIZE} 字`, 重叠: '0', 块数: String(A.chunks.length) }),
      ],
    },
    {
      title: '问题检索到哪一块',
      desc: `${idx(A.top)} 最相似（${fixed(A.topSim, 3)}），但只带走答案的 ${A.inTop} 个字`,
      detail: `每一块各自嵌入成 ${DIMS} 维向量，问题「${bare(QUESTION)}」也嵌入，和每一块算点积（向量都已归一化，点积就是余弦）。最像的是${idx(A.top)}，相似度 ${fixed(A.topSim, 3)}，它从第 ${topOf(A).from} 个字符讲到第 ${topOf(A).to} 个，正是讲杯盖漏水的那一块。可是答案的 ${N.answerLen} 个字它只带走前 ${A.inTop} 个，结尾是「${[...ANSWER].slice(0, A.inTop).join('')}」，剩下的「${noStop([...ANSWER].slice(A.inTop).join(''))}」在${idx(A.top + 1)} 里；检索找对了地方，交给大模型的却是半句话。`,
      facts: [['最相似', `${idx(A.top)}（${fixed(A.topSim, 3)}）`], ['答案', `${N.answerLen} 个字，首位块带走 ${A.inTop} 个`], ['完整包含答案的块', A.whole.length ? A.whole.map(idx).join('、') : '没有'], ['比较次数', `${A.chunks.length} 次`]],
      events: [
        show('embedder', 'query', 'results'),
        pk('chunks', 'embedder', 'teal', `${A.chunks.length} 块`, A.chunks.map((chunk) => `「${preview(chunk.text, 10)}」`), [dist[0], 'EMBED', `${A.chunks.length} 块文字送去嵌入`, A.bytes],
          wire('送去嵌入的块文字（UTF-8）', 'mem', 'internal', chunkBytes(DOC.title, TEXT, A.chunks, { color: 'teal' })),
          { ds: { query: [queryRow()] } }),
        pk('embedder', 'results', 'amber', '问题和每块的点积', A.sims.map((sim, i) => `${idx(i)}：${fixed(sim, 3)}`), [dist[1], 'SEARCH', `${A.chunks.length} 个块向量各和问题向量比一次，${idx(A.top)} 最高 ${fixed(A.topSim, 3)}，但答案被切断`, A.chunks.length * VECTOR_BYTES],
          wire('每块的向量（float32）和相似度', 'mem', 'format',
            ...A.chunks.map((chunk, i) => floatVector(idx(i), embed(chunk.text).vector, 'f32', { color: 'violet', digits: 3, summary: `相似度 ${num(A.sims[i], 4)}` })),
            concept('相似度', A.sims.map((sim, i): [string, string, string] => [idx(i), num(sim, 4), i === A.top ? `最高；答案的 ${A.inTop}/${N.answerLen} 个字在这一块里。` : `答案在这一块里的字数：${Math.max(0, Math.min(A.chunks[i].to, N.answerTo) - Math.max(A.chunks[i].from, N.answerFrom))}。`]), 'amber')),
          { ds: { results: [simRow(A, answerMark(A.top, `缺「${[...ANSWER].slice(A.inTop).join('')}」`))] } }),
        state('embedder', { 块: `${A.chunks.length} 个`, 维度: String(DIMS) }),
        note('results', `${idx(A.top)}：答案只有 ${A.inTop}/${N.answerLen}`, 'amber'),
      ],
    },
    {
      title: `加 ${OVERLAP} 个字的重叠`,
      desc: `${B.chunks.length} 块，${idx(B.top)} 最相似（${fixed(B.topSim, 3)}），带着完整的答案`,
      detail: `重叠就是下一块不从上一块的结尾开始，而是往回退 ${OVERLAP} 个字，步长从 ${SIZE} 变成 ${SIZE - OVERLAP}。同样固定 ${SIZE} 个字，加上 ${OVERLAP} 个字的重叠，切出 ${B.chunks.length} 块，答案那句话（${N.answerLen} 个字）这回整句落在${B.whole.map(idx).join('、')}（第 ${B.chunks[B.whole[0]].from} 到 ${B.chunks[B.whole[0]].to} 个字符）里面。再检索，最相似的就是${idx(B.top)}，相似度从 ${fixed(A.topSim, 3)} 升到 ${fixed(B.topSim, 3)}，大模型拿到的是完整的一句。`,
      facts: [['块数', `${A.chunks.length} → ${B.chunks.length}`], ['最相似', `${idx(B.top)}（${fixed(B.topSim, 3)}）`], ['答案', `完整在${B.whole.map(idx).join('、')}`], ['相似度', `${fixed(A.topSim, 3)} → ${fixed(B.topSim, 3)}`]],
      events: [
        pk('chunker', 'chunks', 'teal', `${B.chunks.length} 块，重叠 ${OVERLAP}`, B.chunks.map((chunk) => `${idx(chunk.index)}：${chunk.from}–${chunk.to}`), [dist[1], 'CHUNK', `步长 ${SIZE - OVERLAP}：${B.chunks.length} 块，相邻两块重叠 ${OVERLAP} 个字，${B.tokens} token`, TEXT_BYTES],
          wire('带重叠的块：区间互相交错', 'mem', 'internal', chunkBytes(DOC.title, TEXT, B.chunks, { color: 'teal', summary: `固定 ${SIZE} 字，重叠 ${OVERLAP}，切成 ${B.chunks.length} 块` })),
          { ds: { chunks: [chunkRow('c', B, answerMark(B.whole[0], '答案整句在这里'))], results: [] } }),
        state('chunker', { 切法: '固定长度', 大小: `${SIZE} 字`, 重叠: String(OVERLAP), 块数: String(B.chunks.length) }),
        pk('embedder', 'results', 'amber', '问题和每块的点积', B.sims.map((sim, i) => `${idx(i)}：${fixed(sim, 3)}`), [dist[2], 'SEARCH', `${B.chunks.length} 个块向量各比一次，${idx(B.top)} 最高 ${fixed(B.topSim, 3)}，答案整句在里面`, B.chunks.length * VECTOR_BYTES],
          wire('每块的向量（float32）和相似度', 'mem', 'format',
            ...B.chunks.map((chunk, i) => floatVector(idx(i), embed(chunk.text).vector, 'f32', { color: 'violet', digits: 3, summary: `相似度 ${num(B.sims[i], 4)}` })),
            concept('相似度', B.sims.map((sim, i): [string, string, string] => [idx(i), num(sim, 4), B.chunks[i].text.includes(ANSWER) ? '这一块完整包含答案。' : `和上一块重叠 ${B.chunks[i].overlap} 个字。`]), 'amber')),
          { ds: { results: [simRow(B, answerMark(B.top, '首位含完整答案'))] } }),
        note('results', `首位 ${idx(B.top)}：${fixed(B.topSim, 3)}`, 'green'),
      ],
    },
    {
      title: '按句、按段落、递归',
      desc: `句 ${fixed(SENT.topSim, 3)}（${OUTCOME_TEXT[SENT.outcome]}），段落 ${fixed(PARA.topSim, 3)}（${OUTCOME_TEXT[PARA.outcome]}）`,
      detail: `换三种切法，按内容找边界。按句切得到 ${SENT.chunks.length} 块（${SENT.shortest} 到 ${SENT.longest} 个字），首位是「${noStop(preview(topOf(SENT).text, 14))}」，只有 ${topOf(SENT).to - topOf(SENT).from} 个字，相似度 ${fixed(SENT.topSim, 3)} 反而比答案那句高，答案却在隔壁那一句：切得太碎，块里没有了上下文。按段落切每段一块（${PARA.chunks.length} 块），答案就在${idx(PARA.top)} 里，首位相似度 ${fixed(PARA.topSim, 3)}，这篇文档的段落本来就短，段落很长的文档还得再往下切。递归切分先按换行、再按句号、逗号找边界，把小片段合并到不超过 ${SIZE} 个字，再带上 ${OVERLAP} 个字以内的整句重叠，首位是${idx(REC.top)}（${fixed(REC.topSim, 3)}），答案在${REC.whole.map(idx).join('、')} 里，没被切断，但排第 1 的不是它。`,
      facts: [['按句', `${SENT.chunks.length} 块，首位 ${fixed(SENT.topSim, 3)}，${OUTCOME_TEXT[SENT.outcome]}`], ['按段落', `${PARA.chunks.length} 块，首位 ${fixed(PARA.topSim, 3)}，${OUTCOME_TEXT[PARA.outcome]}`], ['递归', `${REC.chunks.length} 块，首位 ${fixed(REC.topSim, 3)}，${OUTCOME_TEXT[REC.outcome]}`], ['累计比较', `${dist[3]} 次`]],
      events: [
        show('scores'),
        pk('chunker', 'chunks', 'teal', '换三种切法', [`按句 ${SENT.chunks.length} 块`, `按段落 ${PARA.chunks.length} 块`, `递归 ${REC.chunks.length} 块`], [dist[2], 'CHUNK', `按句 ${SENT.chunks.length} 块，按段落 ${PARA.chunks.length} 块，递归（${SIZE}，重叠 ${OVERLAP}）${REC.chunks.length} 块`, 3 * TEXT_BYTES],
          wire('三种切法的块', 'mem', 'internal',
            chunkBytes('按句', TEXT, SENT.chunks, { color: 'teal', summary: `${SENT.chunks.length} 句` }),
            chunkBytes('按段落', TEXT, PARA.chunks, { color: 'teal', summary: `${PARA.chunks.length} 段` }),
            chunkBytes('递归', TEXT, REC.chunks, { color: 'teal', summary: `${SIZE} 字、重叠 ${OVERLAP}` })),
          { ds: { chunks: [chunkRow('c', SENT, answerMark(SENT.whole[0], '答案在这一句'))], results: [simRow(SENT, answerMark(SENT.top, `首位只有 ${topOf(SENT).to - topOf(SENT).from} 字`))] } }),
        pk('embedder', 'scores', 'amber', '五种切法对比', STRATEGIES.map(([name, r]) => `${name}：${fixed(r.topSim, 3)}`), [dist[3], 'SEARCH', `${SENT.chunks.length + PARA.chunks.length + REC.chunks.length} 个块各和问题比一次，按首位相似度和答案是否完整对比五种切法`, null],
          wire('五种切法的结果', 'mem', '示意',
            concept('对比', STRATEGIES.map(([name, r]): [string, string, string] => [name, `${r.chunks.length} 块 · ${fixed(r.topSim, 3)}`, `${OUTCOME_TEXT[r.outcome]}；首位是${idx(r.top)}（第 ${topOf(r).from}–${topOf(r).to} 个字符）。`]), 'amber')),
          { ds: { scores: [strategyGrid()] } }),
        note('scores', `按句：首位只有 ${topOf(SENT).to - topOf(SENT).from} 字`, 'amber'),
      ],
    },
    {
      title: '重叠的代价',
      desc: `重叠 ${OVERLAP}：多 ${B.chunks.length - A.chunks.length} 块、多存 ${growth(B)}；重叠 ${OVERLAPS[OVERLAPS.length - 1]}：多存 ${growth(SWEEP[SWEEP.length - 1])}`,
      detail: `重叠不是白来的：每多重叠一点，块就多一点，重复的字也多一点，嵌入的 token 和向量库里的向量都跟着多。固定 ${SIZE} 个字时，重叠 ${OVERLAP} 把块数从 ${A.chunks.length} 变成 ${B.chunks.length}，块里的字符多 ${growth(B)}（${A.chars} → ${B.chars}），要嵌入的 token 从 ${A.tokens} 变成 ${B.tokens}，每块 ${VECTOR_BYTES} 字节的向量从 ${A.chunks.length * VECTOR_BYTES} 变成 ${B.chunks.length * VECTOR_BYTES} 字节；估算是 ${SIZE} / (${SIZE} − ${OVERLAP}) = ${fixed(SIZE / (SIZE - OVERLAP), 2)} 倍，末尾不满一块，实际比它略小。重叠也不是越大越好：答案长 ${N.answerLen} 个字，重叠至少 ${GUARANTEE} 个字才保证有一块整句装下它，到 ${OVERLAPS[4]} 个字时整句还在块里，但排第 1 的变成了${idx(SWEEP[4].top)}，那一块里没有完整的答案。`,
      facts: [['重叠 0 → 10', `${A.chunks.length} → ${B.chunks.length} 块，字符多 ${growth(B)}`], ['向量字节', `${A.chunks.length * VECTOR_BYTES} → ${B.chunks.length * VECTOR_BYTES}`], ['保证整句装下', `重叠 ≥ ${GUARANTEE}（答案 ${N.answerLen} 字）`], [`重叠 ${OVERLAPS[4]}`, `${OUTCOME_TEXT[SWEEP[4].outcome]}`]],
      events: [
        pk('chunker', 'chunks', 'teal', '重叠从 0 到 20', OVERLAPS.map((overlap, i) => `重叠 ${overlap}：${SWEEP[i].chunks.length} 块，${SWEEP[i].chars} 字符`), [dist[3], 'CHUNK', `重叠 ${OVERLAPS.join('、')}：块数 ${SWEEP.map((r) => r.chunks.length).join('、')}，字符 ${SWEEP.map((r) => r.chars).join('、')}`, TEXT_BYTES],
          wire('重叠从 0 到 20，字符数和块数', 'mem', 'internal',
            concept('代价', SWEEP.map((r, i): [string, string, string] => [`重叠 ${OVERLAPS[i]}`, `${r.chunks.length} 块 · ${r.chars} 字符 · ${r.tokens} token`, `向量 ${r.chunks.length * VECTOR_BYTES} 字节；比不重叠多存 ${growth(r)}；${OUTCOME_TEXT[r.outcome]}。`]), 'teal'),
            chunkBytes(`重叠 ${OVERLAPS[OVERLAPS.length - 1]}`, TEXT, SWEEP[SWEEP.length - 1].chunks, { color: 'teal', summary: `固定 ${SIZE} 字，重叠 ${OVERLAPS[OVERLAPS.length - 1]}，${SWEEP[SWEEP.length - 1].chunks.length} 块` })),
          { ds: { chunks: [chunkRow('c', SWEEP[SWEEP.length - 1])] } }),
        pk('embedder', 'scores', 'amber', '代价和效果', SWEEP.map((r, i) => `重叠 ${OVERLAPS[i]}：${r.chunks.length} 块，${OUTCOME_TEXT[r.outcome]}`), [dist[4], 'SEARCH', `又比较了 ${dist[4] - dist[3]} 次，对比重叠 ${OVERLAPS.join('、')} 的块数、存储和检索结果`, null],
          wire('重叠的代价和效果', 'mem', '示意',
            concept('每种重叠', SWEEP.map((r, i): [string, string, string] => [`重叠 ${OVERLAPS[i]}`, `首位 ${idx(r.top)} · ${fixed(r.topSim, 3)}`, `${OUTCOME_TEXT[r.outcome]}；完整包含答案的块：${r.whole.length ? r.whole.map(idx).join('、') : '没有'}。`]), 'amber')),
          { ds: { scores: [costGrid()] } }),
        note('scores', `重叠 ${OVERLAPS[4]}：整句还在，首位没有`, 'amber'),
      ],
    },
  ],
  outro: {
    title: '切点决定检索到什么',
    desc: `答案 ${N.answerLen} 个字，重叠至少 ${GUARANTEE} 才保证整句装下`,
    text: `分块决定了检索的单位：切点落在答案中间，检索找对了地方也只能拿回半句话；重叠把切点附近的内容多存一份，换来整句不丢，代价是块数、嵌入的 token 和向量库的体积一起涨，重叠还可能让排第 1 的块换人。按句、按段落、递归切分按内容找边界，但块太碎会失去上下文，太长又稀释了答案。这一课每个块都是和问题逐个比出来的，量大了就得有索引：下一组课从暴力 kNN 讲起，看怎样在很多向量里快速找到最近的几个。`,
    facts: [['固定 48 / 0', `${A.chunks.length} 块，${OUTCOME_TEXT[A.outcome]}`], [`固定 48 / ${OVERLAP}`, `${B.chunks.length} 块，${OUTCOME_TEXT[B.outcome]}，多存 ${growth(B)}`], ['累计比较', `${meter.total} 次`], ['下一课', '暴力 kNN（Flat）']],
  },
};
