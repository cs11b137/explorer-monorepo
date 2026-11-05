import { concept, tapeTuple, values, wire } from '../decode/structures';
import { externalSort, mergeOrder } from '../engine/extsort';
import type { Attr } from '../engine/page';
import type { LanesBoard } from '../scene/board-types';
import { board, note, pk, show } from './dsl';
import { ms } from './shared';
import type { Lesson } from './types';

const INPUT = [42, 7, 91, 15, 63, 28, 77, 3, 54, 86, 19, 35, 70, 11, 48, 96, 24, 60];
const CAPACITY = 4;
const TAPES = 3;
const log = externalSort(INPUT, CAPACITY, TAPES);
const SCHEMA: Attr[] = [{ name: 'amount', type: 'int4' }];

type Cells = LanesBoard['rows'][number]['cells'];
const cellsOf = (values: number[], hot: number[] = []): Cells => values.map((v) => ({ text: String(v), hot: hot.includes(v) ? ('amber' as const) : undefined }));

function tapeRows(tapes: number[][][], hotTape = -1): LanesBoard['rows'] {
  return Array.from({ length: TAPES }, (_, i) => {
    const cells: Cells = [];
    (tapes[i] ?? []).forEach((run, r) => {
      if (r) cells.push({ text: '', gap: true });
      cells.push(...cellsOf(run));
    });
    return { label: `磁带 ${i}`, cells, hot: i === hotTape };
  });
}

function spec(sub: string, parts: { input?: number[]; mem?: number[]; memHot?: boolean; tapes?: number[][][]; hotTape?: number; heap?: Array<{ value: number; tape: number }>; output?: number[]; label?: string; footer?: string }): LanesBoard {
  const rows: LanesBoard['rows'] = [];
  rows.push({ label: '输入', cells: (parts.input ?? INPUT).map((v) => ({ text: String(v), muted: !(parts.input ?? INPUT).includes(v) })) });
  rows.push({ label: 'work_mem', cells: cellsOf(parts.mem ?? [], parts.memHot ? (parts.mem ?? []) : []), hot: parts.memHot });
  rows.push(...tapeRows(parts.tapes ?? [], parts.hotTape ?? -1));
  rows.push({ label: '归并堆', cells: (parts.heap ?? []).map((item, i) => ({ text: String(item.value), sub: `磁带${item.tape}`, hot: i === 0 ? ('amber' as const) : undefined })) });
  rows.push({ label: parts.label ?? '输出', cells: cellsOf(parts.output ?? []) });
  return { kind: 'lanes', title: parts.label === '合并段' ? '第一趟归并' : '外部排序的状态', sub, rows, cell: 40, labelWidth: 78, footer: parts.footer };
}

/** 每生成一个归并段，就把到目前为止的磁带内容记下来。 */
const tapesUpTo = (count: number): number[][][] => {
  const tapes: number[][][] = [];
  for (let i = 0; i < count; i++) {
    tapes[log.runTape[i]] ??= [];
    tapes[log.runTape[i]].push(log.runs[i]);
  }
  return tapes;
};

const firstPass = log.passes[0];
const lastPass = log.passes[log.passes.length - 1];
const firstMerge = firstPass.merges[0];
const finalMerge = lastPass.merges[0];
const initial = spec('还没开始', { input: INPUT });
const INPUT_REMAIN = (n: number) => INPUT.slice(n);

const runEvents = log.runs.flatMap((run, i) => {
  const consumed = Math.min(INPUT.length, (i + 1) * CAPACITY);
  const raw = INPUT.slice(i * CAPACITY, consumed);
  const tape = log.runTape[i];
  const t = ms(0.2 + i * 0.5);
  return [
    board('sort', spec(`第 ${i + 1} 段：读满内存`, { input: INPUT_REMAIN(i * CAPACITY), mem: raw, memHot: true, tapes: tapesUpTo(i) })),
    pk('heap', 'executor', 'blue', `第 ${i + 1} 批`, [raw.join(' ')], [t, 'SORT', `读入 ${raw.length} 行，超过内存就触发写盘`, null],
      wire('SortTuple 数组 memtuples。这里只列排序前的键', 'vals', '示意', concept('内存里的行', raw.map((v, k): [string, string] => [`memtuples[${k}]`, String(v)]), 'blue')), { quick: true }),
    board('sort', spec(`第 ${i + 1} 段：快速排序`, { input: INPUT_REMAIN(consumed), mem: run, memHot: true, tapes: tapesUpTo(i) })),
    pk('executor', 'temp', 'amber', `段 ${i + 1} → 磁带 ${tape}`, [run.join(' ')], [t + ms(0.25), 'SORT', `dumptuples：第 ${i + 1} 段写到磁带 ${tape}`, run.length * 24],
      wire('LogicalTape 上的第一个元组。写的时候去掉了 MinimalTuple 开头 10 字节', 'mem', 'internal', tapeTuple(SCHEMA, [run[0]])), { quick: true }),
    board('sort', spec(`第 ${i + 1} 段写入磁带 ${tape}`, { input: INPUT_REMAIN(consumed), tapes: tapesUpTo(i + 1), hotTape: tape })),
  ];
});

const mergeEvents = (() => {
  const steps = firstMerge.steps;
  const picks = [0, 1, 2, steps.length - 1];
  return picks.flatMap((at, k) => {
    const step = steps[at];
    const output = firstMerge.output.slice(0, at + 1);
    return [
      board('sort', spec(`取堆顶 ${step.output}`, { input: [], tapes: firstPass.inputTapes, heap: step.heap, output, label: '合并段' })),
      pk('temp', 'executor', 'violet', `堆顶 ${step.output}`, [`来自磁带 ${step.fromTape}`], [ms(4 + k * 0.3), 'SORT', `mergeonerun：输出 ${step.output}，从磁带 ${step.fromTape} 补一行`, 24],
        wire('tuplesort_heap_replace_top：堆里每条输入磁带只放一行', 'vals', 'internal', values('归并堆', step.heap.map((item, i): [string, number, string] => [`堆[${i}]`, item.value, `来自磁带 ${item.tape}`]), 'violet')), { quick: true }),
    ];
  });
})();

const outputTapes = firstPass.outputTapes;

export const extsort: Lesson = {
  id: 'extsort',
  name: 'EXTERNAL SORT',
  title: '外部排序',
  group: 'query',
  layer: [1, 6],
  timeUnit: 'ms',
  nodes: ['heap', 'executor', 'temp', 'client'],
  place: { heap: [110, 70], executor: [350, 165], temp: [590, 70], client: [830, 165] },
  labels: {
    heap: ['堆文件', 'orders'],
    executor: ['执行器', 'tuplesort'],
    temp: ['临时文件', 'LogicalTape'],
    client: ['客户端', 'ORDER BY'],
  },
  start: ['heap', 'executor'],
  boards: {
    sort: { rect: [20, 250, 900, 370], initial },
    facts: {
      rect: [20, 628, 900, 92],
      initial: { kind: 'kv', title: '真实运行：work_mem = 64 kB，排序 20000 行', sub: 'trace_sort 日志', keyWidth: 180, rows: [{ k: '磁带数', v: `${mergeOrder(64 * 1024)}（下限）。第 7 段轮回写到磁带 1` }, { k: '4 MB 时的磁带数', v: String(mergeOrder(4 * 1024 * 1024)) }] },
    },
  },
  legend: [['blue', '读入'], ['amber', '写归并段'], ['violet', '归并'], ['green', '输出'], [null, `本课内存放 ${CAPACITY} 行，${TAPES} 条磁带`]],
  overview: {
    full: '内存放不下时，分段排序再归并',
    description: `ORDER BY 的数据量可能远大于 work_mem。做法分两段：内存能放多少就读多少、排好序写到临时文件，叫一个归并段；然后用堆把多个归并段合成一个。这一课真实跑一遍 ${INPUT.length} 个数：内存放 ${CAPACITY} 行，${TAPES} 条磁带。`,
    facts: [
      ['内存上限', 'work_mem（默认 4 MB）'],
      ['切换条件', 'LACKMEM'],
      ['段内排序', '快速排序'],
      ['归并方式', '平衡 k 路归并（PG 15 起）'],
      ['磁带数', 'tuplesort_merge_order，6 到 500'],
      ['EXPLAIN', 'Sort Method: external merge  Disk: …'],
    ],
  },
  steps: [
    {
      title: '内存不够',
      desc: '放不下了，切换到外部排序',
      detail: '排序先把行读进内存的 memtuples 数组。只要放得下，整个排序就是一次快速排序。一旦超过 work_mem（LACKMEM 为真），tuplesort 切换状态，开始往临时文件写。这个临时文件叫逻辑磁带（LogicalTape），名字是历史遗留。',
      facts: [['状态', 'TSS_INITIAL → TSS_BUILDRUNS'], ['函数', 'inittapes'], ['临时文件', 'base/pgsql_tmp']],
      events: [
        pk('heap', 'executor', 'slate', '开始读', [`${INPUT.length} 行`], [0, 'SCAN', '子计划逐行送来数据', null],
          wire('tuplesort_merge_order 的计算', 'vals', 'internal', values('合并阶数', [['allowedMem', 64 * 1024, '真实例子：work_mem = 64 kB。'], ['2×TAPE_BUFFER_OVERHEAD + MERGE_BUFFER_SIZE', 2 * 8192 + 8192 * 32, '每条输入磁带要的内存。'], ['mOrder', mergeOrder(64 * 1024), '结果不足 6，取 MINORDER。trace_sort 日志：switching to external sort with 6 tapes。']], 'slate'))),
        board('sort', spec('读入中', { input: INPUT })),
        note('executor', 'LACKMEM：切换到外部排序', 'amber'),
      ],
    },
    {
      title: '生成归并段',
      desc: '排好一段，写到磁带，轮流换磁带',
      detail: `读满内存就快速排序，写成一个归并段。磁带数没到上限就开新磁带，到了之后轮流写（selectnewtape），所以第 4 段又回到磁带 0。实测 64 kB 内存时，第 7 段正好写回磁带 1。这里 ${INPUT.length} 行得到 ${log.runs.length} 段。`,
      facts: [['段数', String(log.runs.length)], ['每段', `最多 ${CAPACITY} 行`], ['写入函数', 'dumptuples → writetup_heap']],
      events: [show('temp'), ...runEvents],
    },
    {
      title: '第一趟归并',
      desc: '段比磁带多，先合并一趟',
      detail: `现在有 ${log.runs.length} 段，但只有 ${TAPES} 条磁带。每条输入磁带的第一段放进最小堆，每次取堆顶输出，再从同一条磁带补一行。这样比较次数只和磁带数的对数相关。合成的段写到新的输出磁带。`,
      facts: [['这一趟', `${firstPass.merges.length} 次合并`], ['函数', 'mergeruns → mergeonerun'], ['第一次合并', `${firstMerge.inputs.length} 段 → ${firstMerge.output.length} 行`]],
      events: mergeEvents,
    },
    {
      title: '最后一趟',
      desc: '段数不超过磁带数，边归并边输出',
      detail: `第一趟结束后剩 ${log.passes[0].merges.length} 段，不超过磁带数。只要不需要随机访问结果，最后一趟不用再写回磁带，直接边归并边把行交给上层（TSS_FINALMERGE）。这省下了一次完整的写盘。`,
      facts: [['段数', String(log.passes[0].merges.length)], ['状态', 'TSS_FINALMERGE'], ['总比较次数', `${log.comparisons}（本次运行）`]],
      events: [
        board('sort', { ...spec('第一趟的输出成为输入', { input: [], tapes: outputTapes }), title: '第二趟：最后一次归并' }),
        pk('temp', 'executor', 'violet', '最后一趟', [`${finalMerge.inputs.length} 段`], [ms(6), 'SORT', `beginmerge：${finalMerge.inputs.length} 段同时归并，不再写盘`, null],
          wire('最后一趟堆的初始内容', 'vals', 'internal', values('归并堆', finalMerge.steps[0].heap.map((item, i): [string, number, string] => [`堆[${i}]`, item.value, `来自磁带 ${item.tape}`]), 'violet'))),
        board('sort', { ...spec('边归并边输出', { input: [], tapes: outputTapes, heap: finalMerge.steps[0].heap, output: finalMerge.output.slice(0, 1) }), title: '第二趟：最后一次归并' }),
      ],
    },
    {
      title: '交出结果',
      desc: '上层节点按顺序逐行取走',
      detail: `排序结果就是 ${log.output.slice(0, 3).join('、')}……这样的有序流。上层节点调用 tuplesort_gettupleslot 一行一行拿，不用等全部排完。LIMIT 可以提前停下，这也是不需要写回最后一趟的另一个好处。临时文件在排序结束时删除。`,
      facts: [['函数', 'tuplesort_gettupleslot'], ['结果行数', String(log.output.length)], ['清理', 'tuplesort_end']],
      events: [
        board('sort', { ...spec('完成', { input: [], tapes: [], output: log.output }), title: '排序完成' }),
        show('client'),
        pk('executor', 'client', 'green', '有序结果', [log.output.slice(0, 5).join(' ') + ' …'], [ms(8), 'MSG', `按序返回 ${log.output.length} 行`, null],
          wire('排序结果', 'vals', '示意', concept('输出', [['前 5 行', log.output.slice(0, 5).join(', '), ''], ['是否有序', log.output.every((v, i) => !i || log.output[i - 1] <= v) ? '是' : '否', '程序实际检查过。']], 'green'))),
      ],
    },
  ],
  outro: {
    title: '两阶段，两种磁盘访问',
    desc: '写归并段是顺序写，归并是顺序读',
    text: '外部归并是教科书上的通用算法。PostgreSQL 的细节：段内用快速排序（替换选择在 11 版已去掉），PG 15 起从多相归并改成平衡 k 路归并，磁带数由 work_mem 决定。多给 work_mem 能减少段数和归并趟数。',
    facts: [['内存影响', '段数和趟数'], ['常见错讲', 'PG 15 起不再是多相归并'], ['下一课', 'HEAP PAGE']],
  },
};
