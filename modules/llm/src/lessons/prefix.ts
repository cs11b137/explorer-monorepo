/**
 * 推理组第三课：前缀缓存（Prompt Caching 原理）。
 * 真实执行三个请求：A、B 共用同一段 18 个 token 的「系统提示」，C 只把第一个 token 换掉。
 * 前缀缓存按 4 个 token 一块、链式哈希（engine/prefix.ts，仿 vLLM 的 automatic prefix caching），
 * B 复用 A 的 K、V，只算剩下的位置；FLOPs 来自 FlopMeter，复用后的 logits 和完整重算逐位相同（tests/engine.test.ts）。
 */
import { tokenIds, wire } from '../decode/structures';
import { PrefixCache, shortHash, type BlockKey, type PrefillResult } from '../engine/prefix';
import { MODEL, TOKENIZER } from '../model';
import { FlopMeter } from '../model/tensor';
import { forward } from '../model/transformer';
import { note, pk, render, show, state, type } from './dsl';
import { conceptOf, hashInputLayer, hashLayer, kvLayer, labelOf } from './infer-common';
import type { Color, DsCell, GraphNode, GraphPrim, GridPrim, Lesson, LessonEvent, Tone } from './types';

const W = MODEL;
const T = TOKENIZER;

/** 本课的块大小。vLLM 在 GPU 上默认 16 个 token 一块；迷你模型的窗口只有 32，这里用 4。 */
export const BLOCK = 4;
/** 两个请求共用的「系统提示」：语料里的一句话。 */
export const SYSTEM = 'the model is trained to predict the next token';
/** C 的系统提示：只把第一个词 the 换成 a。 */
export const SYSTEM_C = SYSTEM.replace(/^the/, 'a');
export const QUESTIONS = { A: ' in the text.', B: ' at a time.' };

export const ids = {
  A: T.encode(SYSTEM + QUESTIONS.A),
  B: T.encode(SYSTEM + QUESTIONS.B),
  C: T.encode(SYSTEM_C + QUESTIONS.B),
};
const sysIds = T.encode(SYSTEM);

// ---------- 真实运行 ----------

const meter = new FlopMeter();
export const prefixCache = new PrefixCache(BLOCK);
const run = (tokens: number[]): PrefillResult & { flops: number; total: number } => {
  const before = meter.total;
  const result = prefixCache.prefill(W, tokens, meter);
  return { ...result, flops: meter.total - before, total: meter.total };
};
export const runA = run(ids.A);
const blocksAfterA = [...prefixCache.blocks.values()];
export const runB = run(ids.B);
const blocksAfterB = [...prefixCache.blocks.values()];
export const runC = run(ids.C);
const blocksAfterC = [...prefixCache.blocks.values()];

/** 不用前缀缓存时 B 要花的 FLOPs：完整预填充一遍。 */
export const fullB = forward(W, ids.B, { lastLogitsOnly: true }).meter.total;
export const savedShare = 1 - runB.flops / fullB;

/** C 和 B 的第 1 块 token 完全相同，但父哈希不同，所以块哈希不同。 */
export const sameTokensBlock = runB.keys.findIndex((key, i) => i > 0 && key.tokens.join() === runC.keys[i].tokens.join());
/** 同一块在 B 和 C 里第 1 层的 K：token 和位置都一样，前面的 token 不同，K 就不同。 */
export const kDiffers = (() => {
  const pos = sameTokensBlock * BLOCK;
  return runB.cache.k[1][pos].some((value, i) => value !== runC.cache.k[1][pos][i]);
})();

if (runA.hits.length !== 0 || runB.hits.length === 0 || runC.hits.length !== 0) throw new Error('prefix：命中情况和文案不符');

// ---------- 图元 ----------

const KEY_COLS = runA.keys.length;
const tail = (tokens: number[]) => tokens.length - KEY_COLS * BLOCK;

function keyRow(result: PrefillResult, mode: 'new' | 'match'): DsCell[] {
  const cells: DsCell[] = result.keys.map((key, i) => ({ v: shortHash(key.hash), tone: (mode === 'new' ? 'blue' : i < result.hits.length ? 'green' : 'amber') as Tone, lift: (mode === 'match' && i === result.missAt) || undefined }));
  return [...cells, { v: `+${tail(ids.A)}`, tone: 'dim' }];
}

function keysGrid(rows: Array<['A' | 'B' | 'C', DsCell[]]>): GridPrim {
  return { kind: 'grid', id: 'q', w: 50, rows: rows.map(([name]) => name), cols: [...Array.from({ length: KEY_COLS }, (_, i) => `块${i}`), '尾'], cells: rows.map(([, cells]) => cells) };
}

/** 正在计算的格子抬起来：从第 from 块到尾巴。 */
const computing = (cells: DsCell[], from: number): DsCell[] => cells.map((cell, i) => (i >= from ? { ...cell, lift: true } : { ...cell, lift: undefined }));

const rowA = keyRow(runA, 'new');
const rowB = keyRow(runB, 'match');
const rowC = keyRow(runC, 'match');

/** 缓存里的块画成树：父块 → 子块。A 的链在上，B 在第 hits 块处分叉，C 另起一条链。 */
function cacheGraph(blocks: typeof blocksAfterC, hot: { lift?: bigint[]; tone?: Record<string, Tone> } = {}): GraphPrim {
  const ownerOf = (hash: bigint): 'A' | 'B' | 'C' => (runA.keys.some((k) => k.hash === hash) ? 'A' : runB.keys.some((k) => k.hash === hash) ? 'B' : 'C');
  const row: Record<'A' | 'B' | 'C', number> = { A: -70, B: 20, C: 110 };
  const toneOf: Record<'A' | 'B' | 'C', Tone> = { A: 'blue', B: 'violet', C: 'amber' };
  const nodes: GraphNode[] = blocks.map((block) => {
    const owner = ownerOf(block.hash);
    return { id: block.hash.toString(16), x: -200 + block.index * 100, y: row[owner], v: shortHash(block.hash), sub: `#${block.physical}`, tone: hot.tone?.[block.hash.toString(16)] ?? toneOf[owner], lift: hot.lift?.includes(block.hash) || undefined };
  });
  const present = new Set(nodes.map((node) => node.id));
  const edges = blocks.filter((block) => block.index > 0 && present.has(block.parent.toString(16))).map((block) => ({ a: block.parent.toString(16), b: block.hash.toString(16), arrow: true }));
  return { kind: 'graph', id: 'g', r: 22, nodes, edges };
}

// ---------- 事件 ----------

const tokensText = (tokens: number[]) => tokens.map(labelOf).join(' ');
const schedState = (name: string, result: PrefillResult): LessonEvent => state('sched', { 请求: name, 命中: `${result.hits.length} / ${result.keys.length} 块`, 复用: `${result.reused} 个位置`, 要算: `${result.computed} 个位置` });

const RUNS = { A: runA, B: runB, C: runC };
/** 每个请求到达时的累计 FLOPs。 */
const START = { A: 0, B: runA.total, C: runB.total };
/** 迷你模型每个位置的 KV 字节（fp16）。 */
const KV_BYTES = 2 * W.config.nLayers * W.config.dModel * 2;

function arrive(name: 'A' | 'B' | 'C', tokens: number[], color: Color): LessonEvent[] {
  const key = RUNS[name].keys[0];
  return [
    pk('client', 'server', color, `请求 ${name}`, [`${tokens.length} 个 token`], [START[name], 'HTTP', `请求 ${name}：「${T.decode(tokens)}」，${tokens.length} 个 token`, tokens.length * 4],
      wire(`请求 ${name} 的 token`, 'mem', 'format', tokenIds('prompt', tokens, { labels: labelOf, color }))),
    pk('server', 'sched', color, '切块、算哈希', [`${Math.floor(tokens.length / BLOCK)} 个满块`, `尾巴 ${tokens.length % BLOCK} 个`], [START[name], 'SCHED', `每 ${BLOCK} 个 token 一块，满块才算哈希：hash(父块哈希, 本块 token)`, key.bytes.length],
      wire(`请求 ${name} 第 0 块的哈希`, 'mem', 'internal', hashInputLayer('块0', key, color), hashLayer('hash', key, color))),
  ];
}

const hashPair = (key: BlockKey, label: string, color: Color) => [hashInputLayer(label, key, color), hashLayer(`${label} hash`, key, color)];
const missKey = runB.keys[runB.missAt];
const hitKey = runB.keys[runB.missAt - 1];

export const prefix: Lesson = {
  id: 'prefix',
  name: 'PREFIX CACHING',
  title: '前缀缓存',
  group: 'infer',
  layer: [6, 7],
  layerNote: '推理引擎按块复用相同前缀的 KV cache，API 按命中的 token 打折计费。',
  opsUnit: 'FLOPs：三个请求的预填充累计的乘加次数 × 2，命中缓存的位置不再计算',
  opsShort: 'FLOPs',
  nodes: ['client', 'server', 'sched', 'gpu', 'queue', 'kv'],
  place: { client: [160, 90], server: [160, 420], sched: [560, 420], gpu: [960, 420], queue: [560, 110], kv: [760, 700] },
  labels: {
    client: ['应用', '同一段系统提示，不同的问题'],
    server: ['推理服务', 'API 入口'],
    sched: ['调度器', `每 ${BLOCK} 个 token 一块，按哈希查缓存`],
    gpu: ['GPU', '只算没命中的位置'],
    queue: ['块哈希', '每个请求的满块'],
    kv: ['前缀缓存', '哈希 → 物理块里的 K、V'],
  },
  labelAt: { queue: [-40, 165], kv: [-330, -20] },
  radius: { queue: 120, kv: 135 },
  initial: { queue: [], kv: [] },
  start: ['client', 'server', 'sched'],
  legend: [['blue', '请求 A：算完写进缓存'], ['green', '命中：直接复用 K、V'], ['amber', '没命中：要重新算'], ['violet', '请求 B 新写入的块'], [null, '运算量：累计 FLOPs']],
  overview: {
    full: '同样的开头只算一次',
    description: `很多请求以同一段系统提示开头，这段前缀的 K、V 每次都一模一样。这一课真实运行三个请求：A 和 B 共用 ${sysIds.length} 个 token 的前缀「${SYSTEM}」，B 命中 ${runB.hits.length} 块、复用 ${runB.reused} 个位置，只算 ${runB.computed} 个，FLOPs 从 ${fullB} 降到 ${runB.flops}；C 只把第一个词换成 a，后面的 token 一样，却一块也没命中。`,
    facts: [
      ['块大小', `${BLOCK} 个 token（vLLM 默认 16）`],
      ['块哈希', 'hash(父块哈希, 本块 token)'],
      ['请求', `A、B、C 各 ${ids.A.length} 个 token`],
      ['B 的 FLOPs', `${runB.flops} / ${fullB}`],
      ['运算量', '累计 FLOPs'],
    ],
  },
  steps: [
    {
      title: '请求 A：从头算',
      desc: `${ids.A.length} 个位置全部预填充，${runA.flops} FLOPs`,
      detail: `缓存是空的，A 的 ${ids.A.length} 个 token 全部要算。调度器先把序列每 ${BLOCK} 个 token 切成一块，得到 ${runA.keys.length} 个满块，末尾 ${tail(ids.A)} 个不满一块。每块的哈希把父块的哈希也算进去，所以第 i 块的哈希代表了「从开头到第 i 块」的整段前缀。`,
      facts: [['满块', `${runA.keys.length} 个`], ['尾巴', `${tail(ids.A)} 个 token，不缓存`], ['FLOPs', String(runA.flops)]],
      events: [
        type(`A: "${SYSTEM + QUESTIONS.A}"`),
        ...arrive('A', ids.A, 'blue'),
        show('queue'),
        pk('sched', 'queue', 'blue', `${runA.keys.length} 个块哈希`, runA.keys.slice(0, 3).map((k) => shortHash(k.hash)), [0, 'SCHED', `A 的 ${runA.keys.length} 个块哈希：${runA.keys.map((k) => shortHash(k.hash)).join(' ')}`, runA.keys[1].bytes.length + 8],
          wire('第 1 块：父哈希就是第 0 块的哈希', 'mem', 'internal', ...hashPair(runA.keys[1], '块1', 'blue')),
          { ds: { queue: [keysGrid([['A', rowA]])] } }),
        schedState('A', runA),
        show('gpu'),
        pk('sched', 'gpu', 'blue', `算 ${runA.computed} 个位置`, [`${runA.flops} FLOPs`], [runA.total, 'MATMUL', `缓存为空：A 的 ${runA.computed} 个位置全部预填充，${runA.flops} FLOPs`, runA.computed * 4],
          wire('要算的位置', 'mem', 'format', tokenIds('compute', ids.A, { labels: labelOf, color: 'blue' })),
          { ds: { queue: [keysGrid([['A', computing(rowA, 0)]])] } }),
      ],
    },
    {
      title: '满块写进缓存',
      desc: `${blocksAfterA.length} 块，按哈希登记`,
      detail: `算完以后，A 的每个满块连同它 ${BLOCK} 个位置的 K、V 登记进前缀缓存，键是块哈希，值是物理块号。缓存只是一张哈希表：块之间靠父哈希连成一棵树，画面上的箭头就是这层关系。末尾那 ${tail(ids.A)} 个 token 不满一块，不登记。`,
      facts: [['登记', `${blocksAfterA.length} 块 · 物理块 #0–#${blocksAfterA.length - 1}`], ['块 0', `${shortHash(runA.keys[0].hash)}「${tokensText(runA.keys[0].tokens)}」`], ['不登记', `末尾 ${tail(ids.A)} 个 token`]],
      events: [
        show('kv'),
        pk('gpu', 'kv', 'blue', `登记 ${runA.inserted.length} 块`, [`#0–#${runA.inserted.length - 1}`], [runA.total, 'KV', `A 的 ${runA.inserted.length} 个满块写进前缀缓存，键是块哈希`, KV_BYTES * BLOCK],
          wire('块 0 的 K、V（4 个位置，fp16）', 'mem', 'internal', hashLayer('key', runA.keys[0], 'blue'), kvLayer('blk0', runA.cache, 0, BLOCK, { color: 'blue', labels: (pos) => `${pos}「${labelOf(ids.A[pos])}」` })),
          { ds: { kv: [cacheGraph(blocksAfterA)] } }),
        note('kv', `尾巴 ${tail(ids.A)} 个 token 不缓存`),
      ],
    },
    {
      title: `请求 B：命中 ${runB.hits.length} 块`,
      desc: `复用 ${runB.reused} 个位置，只算 ${runB.computed} 个`,
      detail: `B 和 A 的前 ${sysIds.length} 个 token 相同，调度器从第 0 块开始逐块查表，前 ${runB.hits.length} 块都命中，第 ${runB.missAt} 块含有 B 自己的问题，没命中就停下。B 直接拿到 ${runB.reused} 个位置的 K、V，只对剩下 ${runB.computed} 个位置做前向：${runB.flops} FLOPs，完整预填充要 ${fullB}，省了 ${Math.round(savedShare * 100)}%。系统提示的最后 ${sysIds.length - runB.reused} 个 token 和问题分在同一块里，这一块不同，它们也得重算。`,
      facts: [['命中', `块 0–${runB.hits.length - 1}`], ['要算', `${runB.computed} 个位置 · ${runB.flops} FLOPs`], ['完整预填充', `${fullB} FLOPs`]],
      events: [
        type(`B: "${SYSTEM + QUESTIONS.B}"`),
        ...arrive('B', ids.B, 'violet'),
        pk('sched', 'queue', 'violet', '逐块查表', [`${runB.hits.length} 块命中`, `块 ${runB.missAt} 没命中`], [runA.total, 'LOOKUP', `B 的块 0–${runB.hits.length - 1} 命中，块 ${runB.missAt}（「${tokensText(missKey.tokens)}」）没命中`, 16],
          wire(`块 ${runB.missAt - 1} 命中、块 ${runB.missAt} 没命中`, 'mem', 'internal', hashLayer(`块${runB.missAt - 1} hash`, hitKey, 'green'), ...hashPair(missKey, `块${runB.missAt}`, 'amber')),
          { ds: { queue: [keysGrid([['A', rowA], ['B', rowB]])] } }),
        schedState('B', runB),
        pk('kv', 'sched', 'green', `复用 ${runB.reused} 个位置`, runB.hits.map((h) => `#${h.physical}`), [runA.total, 'KV', `从物理块 ${runB.hits.map((h) => `#${h.physical}`).join(' ')} 取回 ${runB.reused} 个位置的 K、V`, BLOCK * KV_BYTES],
          wire(`命中的块 ${runB.missAt - 1}（4 个位置）`, 'mem', 'internal', kvLayer('hit', runB.cache, (runB.missAt - 1) * BLOCK, runB.missAt * BLOCK, { color: 'green', labels: (pos) => `${pos}「${labelOf(ids.B[pos])}」` })),
          { ds: { kv: [cacheGraph(blocksAfterA, { lift: runB.hits.map((h) => h.hash), tone: Object.fromEntries(runB.hits.map((h) => [h.hash.toString(16), 'green' as Tone])) })] } }),
        pk('sched', 'gpu', 'violet', `只算 ${runB.computed} 个`, [`${runB.flops} FLOPs`, `完整要 ${fullB}`], [runB.total, 'MATMUL', `只对位置 ${runB.reused}–${ids.B.length - 1} 做前向：${runB.flops} FLOPs（完整预填充 ${fullB}）`, runB.computed * 4],
          wire('B 真正要算的位置', 'mem', 'format', tokenIds('compute', ids.B.slice(runB.reused), { labels: labelOf, color: 'violet' })),
          { ds: { queue: [keysGrid([['A', rowA], ['B', computing(rowB, runB.missAt)]])] } }),
        pk('gpu', 'kv', 'violet', `登记块 ${runB.missAt}`, [shortHash(missKey.hash)], [runB.total, 'KV', `B 的块 ${runB.missAt} 写进缓存，挂在块 ${runB.missAt - 1} 下面`, 8],
          wire('新登记的块', 'mem', 'internal', hashLayer('key', missKey, 'violet')),
          { ds: { kv: [cacheGraph(blocksAfterB)] } }),
        note('gpu', `省了 ${Math.round(savedShare * 100)}% 的 FLOPs`, 'green'),
      ],
    },
    {
      title: '差一个 token 就全不命中',
      desc: `C 只换了第一个词，${runC.keys.length} 块全部没命中`,
      detail: `C 把开头的 the 换成 a，第 0 块的哈希变了；第 ${sameTokensBlock} 块的 4 个 token 和 B 一模一样，可父哈希不同，块哈希也就不同。这不是保守：从第 1 层起每个位置的 K、V 都混进了前面所有 token 的信息，B 和 C 在同一位置、同一 token 上的 K 确实不相等。所以前缀缓存只认「从第一个 token 起完全相同」，C 的 ${runC.computed} 个位置要全部重算。`,
      facts: [['块 0', `${shortHash(runB.keys[0].hash)} → ${shortHash(runC.keys[0].hash)}`], [`块 ${sameTokensBlock} 的 token`, '和 B 相同'], [`块 ${sameTokensBlock} 的哈希`, `${shortHash(runB.keys[sameTokensBlock].hash)} 对 ${shortHash(runC.keys[sameTokensBlock].hash)}`], ['FLOPs', String(runC.flops)]],
      events: [
        type(`C: "${SYSTEM_C + QUESTIONS.B}"`),
        ...arrive('C', ids.C, 'amber'),
        pk('sched', 'queue', 'amber', '块 0 就没命中', [`块 ${sameTokensBlock}：token 相同，哈希不同`], [runB.total, 'LOOKUP', `C 的块 0 没命中；块 ${sameTokensBlock} 的 token 和 B 相同，但父哈希不同`, 2 * (runB.keys[sameTokensBlock].bytes.length + 8)],
          wire(`B 和 C 的第 ${sameTokensBlock} 块`, 'mem', 'internal', ...hashPair(runB.keys[sameTokensBlock], `B 块${sameTokensBlock}`, 'violet'), ...hashPair(runC.keys[sameTokensBlock], `C 块${sameTokensBlock}`, 'amber')),
          { ds: { queue: [keysGrid([['A', rowA], ['B', rowB], ['C', rowC]])] } }),
        schedState('C', runC),
        pk('sched', 'gpu', 'amber', `全部 ${runC.computed} 个`, [`${runC.flops} FLOPs`], [runC.total, 'MATMUL', `C 一块都没命中：${runC.computed} 个位置全部预填充，${runC.flops} FLOPs`, runC.computed * 4],
          wire('C 要算的位置', 'mem', 'format', tokenIds('compute', ids.C, { labels: labelOf, color: 'amber' })),
          { ds: { queue: [keysGrid([['A', rowA], ['B', rowB], ['C', computing(rowC, 0)]])] } }),
        pk('gpu', 'kv', 'amber', `登记 ${runC.inserted.length} 块`, ['另起一条链'], [runC.total, 'KV', `C 的 ${runC.inserted.length} 块另起一条链；位置 ${sameTokensBlock * BLOCK} 的第 1 层 K 和 B ${kDiffers ? '不同' : '相同'}`, 2 * KV_BYTES],
          wire(`位置 ${sameTokensBlock * BLOCK}「${labelOf(ids.B[sameTokensBlock * BLOCK])}」在 B 和 C 里的 K、V`, 'mem', 'internal',
            kvLayer('B', runB.cache, sameTokensBlock * BLOCK, sameTokensBlock * BLOCK + 1, { color: 'violet', summary: `B：前面是「${tokensText(ids.B.slice(0, sameTokensBlock * BLOCK))}」` }),
            kvLayer('C', runC.cache, sameTokensBlock * BLOCK, sameTokensBlock * BLOCK + 1, { color: 'amber', summary: `C：前面是「${tokensText(ids.C.slice(0, sameTokensBlock * BLOCK))}」` })),
          { ds: { kv: [cacheGraph(blocksAfterC)] } }),
        note('queue', '一个 token 不同，后面全部失配', 'amber'),
      ],
    },
    {
      title: 'API 为什么按缓存打折',
      desc: `命中的 ${runB.reused} 个 token 不再做前向`,
      detail: `API 层的 Prompt Caching 是同一件事：命中缓存的输入 token 跳过了预填充，服务方省下了算力，所以按折扣计费。以 Anthropic 为例，读缓存约为基础输入价的 0.1 倍，写缓存约 1.25 倍，缓存默认保留 5 分钟；代价是这段 K、V 要一直占着显存或内存。各家服务内部怎么切块没有公开，但规则和这里一样：只认完全相同的前缀，所以要把固定的系统提示放在最前面，把会变的内容放到后面。`,
      facts: [['B 复用', `${runB.reused} / ${ids.B.length} 个 token`], ['B 省下', `${fullB - runB.flops} FLOPs（${Math.round(savedShare * 100)}%）`], ['计费（Anthropic）', '读缓存 ×0.1 · 写缓存 ×1.25']],
      events: [
        pk('server', 'client', 'green', 'usage', [`读缓存 ${runB.reused}`, `写缓存 ${runB.inserted.length * BLOCK}`, `其余 ${runB.computed - runB.inserted.length * BLOCK}`], [runC.total, 'HTTP', `B 的输入 ${ids.B.length} 个 token：${runB.reused} 个读自缓存，${runB.computed} 个重新计算`, null],
          wire('响应里的用量（以 Anthropic API 的 usage 字段为例）', 'vals', '示意', conceptOf('usage', [
            ['cache_read_input_tokens', String(runB.reused), '命中缓存的前缀，按约 0.1 倍输入价计费。'],
            ['cache_creation_input_tokens', String(runB.inserted.length * BLOCK), `B 新登记的块 ${runB.missAt}，写入按约 1.25 倍输入价计费。`],
            ['input_tokens', String(runB.computed - runB.inserted.length * BLOCK), '末尾不满一块、没进缓存的部分，按正常输入价计费。'],
          ], 'green', '迷你模型的数字套进真实 API 的字段名，只为说明对应关系')),
          { ds: { queue: [keysGrid([['B', rowB]])] } }),
        note('client', '固定的前缀放最前面', 'green'),
        render,
      ],
    },
  ],
  outro: {
    title: '相同的前缀只算一次',
    desc: `B 省下 ${Math.round(savedShare * 100)}% 的 FLOPs`,
    text: `前缀缓存把「K、V 只取决于前面的 token」这一点用到了极致：完全相同的开头，算一次就能被后面的请求复用；差一个 token，后面就全部作废。vLLM 用链式块哈希实现，SGLang 用基数树（RadixAttention），API 服务按命中的 token 打折。缓存的块和正在生成的请求共用同一块 KV 显存，下一课看引擎怎样用固定大小的块管理这块显存，并让很多请求一起跑。`,
    facts: [['A', `${runA.flops} FLOPs`], ['B', `${runB.flops} FLOPs（复用 ${runB.reused} 个位置）`], ['C', `${runC.flops} FLOPs`], ['下一课', '连续批处理与 PagedAttention']],
  },
};
