/**
 * 向量检索组第一课：暴力 kNN（Flat）。知识库的 27 个段落向量原样存进索引，查询和每一个都算一次点积，
 * 扫描时用一个装 k 个的堆留下最近的 k 个；再用平方欧氏距离（IndexFlatL2）算一遍，排序相同；最后放到 1000 个合成向量上，
 * 距离次数和内存都随 N 线性增长。暴力搜索的结果就是标准答案，后面几课的召回率都拿它比。
 *
 * 全部由 core/ 实时计算：flatSearch、scanTopK、benchVectors。没有模型写的文字。tests/narrative.index.test.ts 核对文案。
 */
import { utf8Encode } from '@explorer/llm-core/utf8';
import {
  BENCH_K,
  BENCH_N,
  BENCH_QUERIES,
  BENCH_TRUTH,
  BENCH_VECTORS,
  DistanceMeter,
  EMBED_DIM,
  embed,
  EVAL_SET,
  flatSearch,
  meanRecall,
  OPENAI_EMBED_DIMS,
  PARAGRAPH_VECTORS,
  scanTopK,
  type HeapStep,
} from '../core';
import { concept, floatVector, num, thousands, utf8Text, wire } from '../decode/structures';
import { fixed, PART_TONE, vectorRow } from './common';
import { note, pk, show, state, type } from './dsl';
import { idOf, queryNode, searchOutput, shortName, spaceGraph } from './index-common';
import type { DsCell, GridPrim, Lesson, RowPrim, Tone } from './types';

// ---------- 数据和查询 ----------

export const N = PARAGRAPH_VECTORS.length;
export const DIM = EMBED_DIM;
export const K = 3;
/** 每个 float32 4 字节：Flat 索引的内存就是 N × d × 4。 */
export const BYTES = N * DIM * 4;

const ITEM = EVAL_SET.find((item) => item.id === 'leak')!;
/** 查询：评估集里的「保温杯漏水了怎么办？」（和第一课同一个问题）。 */
export const QUESTION = ITEM.question;
export const qe = embed(QUESTION);
export const q = qe.vector;

export const meter = new DistanceMeter();

/** 第一次搜索：内积（IndexFlatIP），27 次。 */
export const ip = flatSearch(PARAGRAPH_VECTORS, q, K, 'ip', meter);
export const afterIp = meter.total;
/** 扫描时的堆：每个向量来了以后，放进去、替换堆顶，还是丢掉。 */
export const heapSteps = scanTopK('ip', ip.scores, K);
export const replaced = heapSteps.filter((step) => step.action === 'replace');
export const skipped = heapSteps.filter((step) => step.action === 'skip');

/** 第二次搜索：平方欧氏距离（IndexFlatL2），又是 27 次。 */
export const l2 = flatSearch(PARAGRAPH_VECTORS, q, K, 'l2', meter);
export const afterL2 = meter.total;
export const sameOrder = l2.hits.map((hit) => hit.id).join() === ip.hits.map((hit) => hit.id).join();
/** 单位向量上 l2² 和 2 − 2·ip 的最大差（fp32 舍入）。 */
export const identityGap = Math.max(...ip.scores.map((s, i) => Math.abs(l2.scores[i] - (2 - 2 * s))));

/** 规模：8 个评估问题在 1000 个合成向量上各搜一次，每次 1000 次距离。 */
export const bench = BENCH_QUERIES.map((query) => flatSearch(BENCH_VECTORS, query, BENCH_K, 'ip', meter));
export const afterBench = meter.total;
export const benchRecall = meanRecall(bench.map((r, i) => ({ found: r.hits.map((hit) => hit.id), truth: BENCH_TRUTH[i] })), BENCH_K);
export const BENCH_BYTES = BENCH_N * DIM * 4;
/** 一百万个 text-embedding-3-small 默认维数的向量，按 float32 存。 */
export const MILLION = 1_000_000;
export const BIG_DIM = OPENAI_EMBED_DIMS['text-embedding-3-small'];
export const BIG_BYTES = MILLION * BIG_DIM * 4;
const gib = (bytes: number): string => `${+(bytes / 1024 ** 3).toFixed(1)} GiB`;
const kib = (bytes: number): string => `${+(bytes / 1024).toFixed(1)} KiB`;

const top = ip.hits;
const name = (i: number) => shortName(i);
const s2 = (x: number) => fixed(x, 2);
const bare = (text: string) => text.replace(/？$/, '');

// ---------- 图元 ----------

/** 分数写在节点上（两位小数）；颜色一律按点积分档：前 k 个 amber，点积 ≥ 0.3 violet，其余变暗。 */
function scoreSpace(scores: readonly number[], digits = 2): ReturnType<typeof spaceGraph> {
  const tones: Record<number, Tone> = {};
  ip.scores.forEach((s, i) => (tones[i] = top.some((hit) => hit.id === i) ? 'amber' : s >= 0.3 ? 'violet' : 'dim'));
  return spaceGraph({ tones, label: (i) => fixed(scores[i], digits).replace(/^0\./, '.').replace(/^−0\./, '−.'), extra: [queryNode(q)] });
}

const ranked = (ids: readonly number[]) => ids.map((id) => top.findIndex((hit) => hit.id === id));

function heapRow(step: HeapStep, marked?: number, metric: 'ip' | 'l2' = 'ip'): RowPrim {
  const scores = metric === 'ip' ? ip.scores : l2.scores;
  const cells: DsCell[] = Array.from({ length: K }, (_, i) => {
    const id = step.heap[i];
    if (id === undefined) return { v: '', sub: `${i + 1}` };
    return { v: name(id), key: `h${id}`, tone: ranked([id])[0] >= 0 ? PART_TONE.result : 'slate', sub: s2(scores[id]), lift: id === marked || undefined };
  });
  return { kind: 'row', id: 'h', w: 60, cells };
}

const finalStep = heapSteps[heapSteps.length - 1];
const l2Final: HeapStep = { ...finalStep };

function scaleGrid(): GridPrim {
  const rows = [`${N} 段`, `${BENCH_N} 个`, '100 万'];
  const cell = (v: string, tone: Tone): DsCell => ({ v, tone });
  return {
    kind: 'grid',
    id: 'g',
    w: 62,
    rows,
    cols: ['维数', '距离', '内存'],
    cells: [
      [cell(String(DIM), 'slate'), cell(String(N), PART_TONE.result), cell(kib(BYTES), 'violet')],
      [cell(String(DIM), 'slate'), cell(String(BENCH_N), PART_TONE.result), cell(kib(BENCH_BYTES), 'violet')],
      [cell(String(BIG_DIM), 'slate'), cell('100万', PART_TONE.result), cell(gib(BIG_BYTES), 'violet')],
    ],
  };
}

// ---------- 事件用到的字节 ----------

const vectorsWire = () =>
  wire(`Flat 索引里存的东西：${N} 个向量，每个 ${DIM} 个 float32，首尾相接`, 'mem', 'internal',
    ...PARAGRAPH_VECTORS.map((v, i) => floatVector(`${shortName(i)} ${idOf(i)}`, v, 'f32', { color: 'teal', digits: 3, summary: `第 ${i} 个，偏移 ${i * DIM * 4}` })));

const heapWire = (title: string, steps: HeapStep[]) =>
  wire(title, 'vals', '示意', concept('扫描到的向量', steps.map((step): [string, string, string] => [
    `${step.id} · ${name(step.id)}`,
    `${s2(step.score)} · ${step.action === 'push' ? '放进堆' : step.action === 'replace' ? `替换 ${name(step.evicted!)}` : '丢掉'}`,
    step.action === 'skip' ? `不比堆顶 ${name(stepBefore(step).heap[K - 1])}（${s2(ip.scores[stepBefore(step).heap[K - 1]])}）近。` : `之后堆里：${step.heap.map((id) => `${name(id)} ${s2(ip.scores[id])}`).join('、')}。`,
  ]), 'amber', '堆顶是目前第 k 近的那个'));

const stepBefore = (step: HeapStep): HeapStep => heapSteps[heapSteps.indexOf(step) - 1] ?? step;

/** 堆的变化分几段讲：先装满，再看前面几次替换，最后是三个杯子。 */
const fill = heapSteps.slice(0, K);
const early = replaced.filter((step) => !top.some((hit) => hit.id === step.id));
const late = replaced.filter((step) => top.some((hit) => hit.id === step.id));
const lastEarly = early[early.length - 1];

// ---------- 课程 ----------

export const flat: Lesson = {
  id: 'flat',
  name: 'FLAT INDEX',
  title: '暴力 kNN（Flat）',
  group: 'index',
  layer: [3, 5],
  layerNote: '从向量到索引再到检索结果：Flat 索引不做任何加工，查询时把向量一个个比过去。',
  distNote: `查询和每个段落向量各比一次：内积 ${N} 次、平方距离 ${N} 次，再在 ${BENCH_N} 个合成向量上查 ${bench.length} 个问题，一共 ${thousands(afterBench)} 次。`,
  nodes: ['app', 'embedder', 'query', 'index', 'space', 'results', 'scores'],
  place: { app: [100, 130], embedder: [450, 60], query: [880, 100], index: [1180, 290], space: [660, 540], results: [1150, 660], scores: [120, 600] },
  labels: {
    app: ['应用', 'index.search(q, k)'],
    embedder: ['嵌入模型', `${DIM} 维 LSA`],
    query: ['查询向量', `${DIM} 个 float32`],
    index: ['向量库', 'Flat：原样存，逐个比'],
    space: ['向量空间', `${N} 个段落（平面示意）`],
    results: ['前 k 个', '扫描时的堆'],
    scores: ['规模', '距离次数和内存'],
  },
  labelAt: { query: [170, -80], space: [0, 245], results: [0, 75], scores: [0, 150] },
  radius: { query: 70, space: 200, results: 60, scores: 90 },
  initial: { query: [], space: [], results: [], scores: [] },
  start: ['app', 'embedder', 'index'],
  legend: [['teal', '段落向量'], ['blue', '查询'], ['amber', '前 k 个'], ['violet', '比较近的'], [null, '距离列：累计算了几次距离']],
  overview: {
    full: '最笨也最准的办法',
    description: `要在 ${N} 个段落里找出和问题最近的 ${K} 个，最直接的办法是全部比一遍。Flat 索引把向量原样存下（${N} × ${DIM} × 4 = ${thousands(BYTES)} 字节），查询时和每一个都算一次点积，用一个装 ${K} 个的堆留下最近的。结果一定是对的，所以它是所有近似索引的标准答案；代价是每次查询都要算 N 次距离，内存也是 N × d × 4，在 ${BENCH_N} 个向量上就要 ${thousands(BENCH_N)} 次。`,
    facts: [
      ['FAISS', 'IndexFlatIP / IndexFlatL2'],
      ['向量', `${N} 个 × ${DIM} 维 float32`],
      ['每次查询', `${N} 次距离`],
      ['内存', `${N} × ${DIM} × 4 = ${thousands(BYTES)} 字节`],
      ['召回率', '1（它就是标准答案）'],
    ],
  },
  steps: [
    {
      title: '入库：原样存下',
      desc: `${N} 个向量，${thousands(BYTES)} 字节`,
      detail: `知识库的 ${N} 个段落已经嵌入成 ${DIM} 维的单位向量，Flat 索引什么都不加工，按入库顺序把它们首尾相接存成一块，第 i 个向量从第 i × ${DIM * 4} 字节开始。FAISS 的文档里 IndexFlatL2、IndexFlatIP 每个向量占 4 × d 字节，没有别的开销。右边的向量空间是把 ${DIM} 维的点画到平面上的示意，远近只能保留一部分，检索一律按 ${DIM} 维真实计算。`,
      facts: [['向量', `${N} 个 × ${DIM} 维`], ['每个', `${DIM} × 4 = ${DIM * 4} 字节`], ['合计', `${thousands(BYTES)} 字节`], ['训练', '不需要']],
      events: [
        show('space'),
        pk('embedder', 'index', 'violet', `${N} 个段落向量`, [`${N} × ${DIM} 个 float32`, `${thousands(BYTES)} 字节`], [0, 'INDEX', `${N} 个 ${DIM} 维向量原样写进 Flat 索引：${N} × ${DIM} × 4 = ${thousands(BYTES)} 字节`, BYTES],
          vectorsWire(),
          { ds: { space: [spaceGraph()] } }),
        state('index', { 类型: 'Flat', 向量: `${N} 个`, 内存: `${thousands(BYTES)} 字节` }),
      ],
    },
    {
      title: '问题变成查询向量',
      desc: `「${bare(QUESTION)}」→ ${DIM} 个 float32`,
      detail: `用户问「${bare(QUESTION)}」，应用先用同一个嵌入模型把问题变成 ${DIM} 维的单位向量，查询和段落必须在同一个向量空间里才能比。然后调用 index.search(q, k)，k = ${K} 表示要最近的 ${K} 个。图上蓝色的点是查询，落在杯子那几段附近。`,
      facts: [['问题', `${[...QUESTION].length} 个字符`], ['查询向量', `${DIM} × 4 = ${DIM * 4} 字节`], ['k', String(K)]],
      events: [
        type(`index.search(q, k=${K})`),
        pk('app', 'embedder', 'blue', '嵌入问题', [QUESTION], [0, 'EMBED', `问题 ${utf8Encode(QUESTION).length} 字节，用同一个嵌入模型变成查询向量`, utf8Encode(QUESTION).length],
          wire('问题的 UTF-8 字节', 'mem', 'format', utf8Text('问题', QUESTION))),
        show('query'),
        pk('embedder', 'query', 'blue', '查询向量', [`${DIM} 个 float32`], [0, 'VECTOR', `查询向量：${DIM} 个 float32，长度 1`, DIM * 4],
          wire('查询向量：float32 小端', 'mem', 'format', floatVector('q', q, 'f32', { color: 'blue', digits: 3 })),
          { ds: { query: [vectorRow('qv', q, { tone: 'blue', keyPrefix: 'q', w: 26 })], space: [spaceGraph({ extra: [queryNode(q)] })] } }),
      ],
    },
    {
      title: `和每个向量算一次`,
      desc: `${N} 次点积，最近的 ${s2(top[0].score)}`,
      detail: `向量库拿查询和 ${N} 个向量逐个算点积，向量都是单位长度，点积就是余弦。图上每个点换成了它的分数：杯子那几段最高，${name(top[0].id)}（${idOf(top[0].id)}，讲杯盖密封圈的那段）是 ${s2(top[0].score)}，大多数段落接近 0。不管问题是什么，这一步都要算满 N 次，距离列从 0 跳到 ${afterIp}。`,
      facts: [['距离计算', `${ip.computed} 次`], ['最高', `${name(top[0].id)} ${s2(top[0].score)}`], ['≥ 0.3', `${ip.scores.filter((s) => s >= 0.3).length} 个`], ['最低', s2(Math.min(...ip.scores))]],
      events: [
        pk('query', 'index', 'blue', `search(q, k=${K})`, [`q：${DIM} 个 float32`], [0, 'SEARCH', `查询向量交给 Flat 索引，k = ${K}`, DIM * 4],
          wire('查询向量', 'mem', 'format', floatVector('q', q, 'f32', { color: 'blue', digits: 3 }))),
        pk('index', 'space', 'amber', `${N} 次点积`, [`${name(top[0].id)} ${s2(top[0].score)}`, `${name(top[1].id)} ${s2(top[1].score)}`], [afterIp, 'SEARCH', `查询和 ${N} 个向量各算一次点积，最高 ${s2(top[0].score)}（${idOf(top[0].id)}）`, N * 4],
          wire(`${N} 个点积（float32）`, 'mem', 'internal', floatVector('ip', ip.scores, 'f32', { color: 'amber', digits: 4, names: (i) => `${shortName(i)} ${idOf(i)}`, notes: Object.fromEntries(top.map((hit, r) => [hit.id, `第 ${r + 1} 名。`])) })),
          { ds: { space: [scoreSpace(ip.scores)] } }),
        note('space', `每个段落都比一次：${N} 次`, 'amber'),
      ],
    },
    {
      title: `堆里只留 ${K} 个`,
      desc: `替换 ${replaced.length} 次，丢掉 ${skipped.length} 个`,
      detail: `不用把 ${N} 个分数全部排序：扫描时维护一个装 ${K} 个的堆，堆顶是目前第 ${K} 近的那个，新来的分数比堆顶高才挤掉它，否则直接丢掉。按入库顺序扫下来，前 ${K} 个直接放进去，之后替换了 ${replaced.length} 次、丢掉 ${skipped.length} 个；最后 ${late.length} 次替换都发生在扫到杯子那几段时。N 很大时这样只占 k 个位置，排序的代价从 N log N 降到 N log k。`,
      facts: [['放进', `${fill.length} 个`], ['替换', `${replaced.length} 次`], ['丢掉', `${skipped.length} 个`], ['结果', top.map((hit) => name(hit.id)).join('、')]],
      events: [
        show('results'),
        pk('index', 'results', 'slate', `先装满 ${K} 个`, fill.map((step) => `${name(step.id)} ${s2(step.score)}`), [afterIp, 'SEARCH', `前 ${K} 个直接放进堆：${fill.map((step) => name(step.id)).join('、')}`, null],
          heapWire('堆还没满：直接放进去', fill),
          { ds: { results: [heapRow(fill[K - 1])] } }),
        pk('index', 'results', 'slate', `替换 ${early.length} 次`, early.map((step) => `${name(step.id)} 挤掉 ${name(step.evicted!)}`), [afterIp, 'SEARCH', `扫到第 ${lastEarly.id} 个为止，${early.map((step) => name(step.id)).join('、')} 各挤掉一次堆顶`, null],
          heapWire('前面几次替换：分数都很低，只是比堆顶高一点', heapSteps.slice(K, heapSteps.indexOf(lastEarly) + 1)),
          { ds: { results: [heapRow(lastEarly, lastEarly.id)] } }),
        ...late.map((step) =>
          pk('index', 'results', 'amber', `${name(step.id)} ${s2(step.score)}`, [`挤掉 ${name(step.evicted!)}`], [afterIp, 'SEARCH', `${idOf(step.id)} 的 ${s2(step.score)} 比堆顶 ${name(step.evicted!)} 高，替换它`, null],
            heapWire(`扫到 ${name(step.id)}（${idOf(step.id)}）`, [step]),
            { ds: { results: [heapRow(step, step.id)], space: [scoreSpace(ip.scores)] } })),
        pk('index', 'app', 'amber', `前 ${K} 个`, top.map((hit) => `${name(hit.id)} ${s2(hit.score)}`), [afterIp, 'CALL', `返回 ${top.map((hit) => `${idOf(hit.id)} ${s2(hit.score)}`).join('、')}`, K * 12],
          wire('search() 的输出：k 个距离和 k 个 id', 'mem', 'internal', ...searchOutput(top, K)),
          { ds: { results: [heapRow(finalStep)], space: [spaceGraph({ tones: Object.fromEntries(top.map((hit) => [hit.id, 'amber' as Tone])), lift: top.map((hit) => hit.id), extra: [queryNode(q)] })] } }),
      ],
    },
    {
      title: 'IndexFlatIP 还是 IndexFlatL2',
      desc: `平方距离 = 2 − 2 × 点积，排序${sameOrder ? '相同' : '不同'}`,
      detail: `FAISS 的暴力索引有两种：IndexFlatIP 按内积排，越大越近；IndexFlatL2 按平方欧氏距离排，越小越近，FAISS 返回的就是平方距离，省掉开方。向量都归一化过时，平方距离正好等于 2 − 2 × 点积，再用 L2 算一遍 ${N} 次，${name(top[0].id)} 是 ${s2(l2.scores[top[0].id])} = 2 − 2 × ${s2(top[0].score)}，前 ${K} 名${sameOrder ? '一个不差' : '变了'}。FAISS 文档说 IndexFlatIP 也能做余弦，前提是先把向量归一化；没归一化时两种排序会不同，上一课已经看过。`,
      facts: [['IP', `${name(top[0].id)} ${s2(top[0].score)}`], ['L2²', `${name(top[0].id)} ${s2(l2.scores[top[0].id])}`], ['距离计算', `再 ${l2.computed} 次`], ['排序', sameOrder ? '相同' : '不同']],
      events: [
        pk('index', 'space', 'violet', `${N} 次平方距离`, [`${name(top[0].id)} ${s2(l2.scores[top[0].id])}`, `= 2 − 2 × ${s2(top[0].score)}`], [afterL2, 'SEARCH', `换成平方欧氏距离再算 ${N} 次：最近的 ${idOf(l2.hits[0].id)} 是 ${s2(l2.hits[0].score)}`, N * 4],
          wire(`${N} 个平方距离（float32），和点积对照`, 'mem', 'internal',
            floatVector('l2', l2.scores, 'f32', { color: 'violet', digits: 4, names: (i) => `${shortName(i)} ${idOf(i)}`, notes: Object.fromEntries(top.map((hit) => [hit.id, `2 − 2 × ${num(ip.scores[hit.id], 4)} = ${num(2 - 2 * ip.scores[hit.id], 4)}。`])) })),
          { ds: { space: [scoreSpace(l2.scores)], results: [heapRow(l2Final, undefined, 'l2')] } }),
        pk('index', 'app', 'violet', `前 ${K} 个（L2）`, l2.hits.map((hit) => `${name(hit.id)} ${s2(hit.score)}`), [afterL2, 'CALL', `IndexFlatL2 返回 ${l2.hits.map((hit) => idOf(hit.id)).join('、')}，和 IndexFlatIP 的顺序${sameOrder ? '相同' : '不同'}`, K * 12],
          wire('IndexFlatL2 的输出', 'mem', 'internal', ...searchOutput(l2.hits, K, { metric: 'l2', color: 'violet' }))),
        note('results', sameOrder ? '顺序和点积一样' : '顺序变了', 'green'),
      ],
    },
    {
      title: `放大到 ${BENCH_N} 个向量`,
      desc: `每次 ${thousands(BENCH_N)} 次距离，内存 ${kib(BENCH_BYTES)}`,
      detail: `${N} 个段落太少，看不出成本，于是把每个段落向量加一点噪声、复制成 ${BENCH_N} 个合成向量，${bench.length} 个评估问题各查一次：每次都是 ${thousands(BENCH_N)} 次距离，一共 ${thousands(afterBench - afterL2)} 次，召回率@${BENCH_K} = ${benchRecall}，它就是标准答案。距离次数和内存都随 N 线性增长：100 万个 ${BIG_DIM} 维（text-embedding-3-small 的默认维数）的向量光存下来就要 ${gib(BIG_BYTES)}，每次查询比 100 万次。后面三课的 IVF、HNSW、PQ 都在这 ${BENCH_N} 个向量上和它比距离次数和召回率。`,
      facts: [['每次查询', `${thousands(BENCH_N)} 次距离`], [`${bench.length} 个问题`, `${thousands(afterBench - afterL2)} 次`], ['内存', `${BENCH_N} × ${DIM} × 4 = ${thousands(BENCH_BYTES)} 字节`], ['100 万 × 1536 维', gib(BIG_BYTES)]],
      events: [
        show('scores'),
        pk('app', 'index', 'blue', `${bench.length} 个问题 × ${BENCH_N}`, [`每次 ${thousands(BENCH_N)} 次距离`, `召回率@${BENCH_K} = ${benchRecall}`], [afterBench, 'SEARCH', `${BENCH_N} 个合成向量上查 ${bench.length} 个评估问题：每次 ${thousands(BENCH_N)} 次，共 ${thousands(afterBench - afterL2)} 次`, null],
          wire('规模和成本', 'vals', '示意', concept('Flat 的成本', [
            [`${N} 个段落`, `${N} 次 · ${thousands(BYTES)} 字节`, '本课前面的例子。'],
            [`${BENCH_N} 个合成向量`, `${thousands(BENCH_N)} 次 · ${thousands(BENCH_BYTES)} 字节`, `每个段落向量加标准差 0.12 的高斯噪声再归一化，轮流复制（固定种子），示例数据。`],
            ['100 万 × 1536 维', `100 万次 · ${thousands(BIG_BYTES)} 字节`, `按 N × d × 4 算出来的，没有真的建。`],
            [`召回率@${BENCH_K}`, String(benchRecall), '暴力搜索本身就是标准答案。'],
          ], 'amber')),
          { ds: { scores: [scaleGrid()] } }),
        note('scores', '距离和内存都随 N 线性增长', 'amber'),
      ],
    },
  ],
  outro: {
    title: '准，但每次都要比 N 次',
    desc: `${N} 次 → ${thousands(BENCH_N)} 次 → 100 万次`,
    text: `Flat 索引不训练、不加工，结果一定是精确的 k 个最近邻，所以评测近似索引时拿它当标准答案；向量少的时候（几千、几万个）它往往就是最好的选择。它的问题是成本：每次查询算 N 次距离，内存是 N × d × 4 字节，两者都随数据量线性增长。下一课的 IVF 先把向量聚成几簇，查询时只看最近的几簇，用一点召回率换来少得多的距离计算。`,
    facts: [['每次查询', 'N 次距离'], ['内存', 'N × d × 4 字节'], ['召回率', '1'], ['下一课', 'IVF：聚类与倒排']],
  },
};

