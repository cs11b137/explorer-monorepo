import { callRegs, chunkHeader, chunkSize, cStruct, layoutOf, wire, type CField, type CValue } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim } from '../scene/ds';
import { HEAP } from './common';
import { pk, render, show, state, type } from './dsl';
import type { Color, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, Tone } from './types';

export interface ListNode {
  val: number;
  next: ListNode | null;
  addr: bigint;
}

export interface ListHooks {
  /** malloc 返回之后、写字段之前。 */
  allocated?(node: ListNode): void;
  /** 新节点的 next 写好了，链表还没变。 */
  linked?(node: ListNode, next: ListNode | null): void;
  /** head 或前驱的 next 改好了，新节点已接入。 */
  attached?(node: ListNode, prev: ListNode | null): void;
  visit?(node: ListNode, cmp: number): void;
  /** 前驱已绕过这个节点。 */
  unlinked?(node: ListNode, prev: ListNode | null): void;
}

/** 单向链表。节点独立分配，只靠 next 指针串起来。cmp 统计比较次数，writes 统计指针写入次数。 */
export class List {
  head: ListNode | null = null;
  cmp = 0;
  writes = 0;
  private cursor = HEAP;

  private alloc(val: number): ListNode {
    const node: ListNode = { val, next: null, addr: this.cursor };
    this.cursor += BigInt(chunkSize(16));
    return node;
  }

  pushFront(val: number, hooks: ListHooks = {}): ListNode {
    const node = this.alloc(val);
    hooks.allocated?.(node);
    node.next = this.head;
    this.writes++;
    hooks.linked?.(node, node.next);
    this.head = node;
    this.writes++;
    hooks.attached?.(node, null);
    return node;
  }

  find(val: number, hooks: ListHooks = {}): ListNode | null {
    for (let node = this.head; node; node = node.next) {
      this.cmp++;
      hooks.visit?.(node, this.cmp);
      if (node.val === val) return node;
    }
    return null;
  }

  insertAfter(at: ListNode, val: number, hooks: ListHooks = {}): ListNode {
    const node = this.alloc(val);
    hooks.allocated?.(node);
    node.next = at.next;
    this.writes++;
    hooks.linked?.(node, node.next);
    at.next = node;
    this.writes++;
    hooks.attached?.(node, at);
    return node;
  }

  /** 按值删除。返回被摘下的节点，调用者负责 free。 */
  remove(val: number, hooks: ListHooks = {}): ListNode | null {
    let prev: ListNode | null = null;
    for (let node = this.head; node; prev = node, node = node.next) {
      this.cmp++;
      hooks.visit?.(node, this.cmp);
      if (node.val !== val) continue;
      if (prev) prev.next = node.next;
      else this.head = node.next;
      this.writes++;
      hooks.unlinked?.(node, prev);
      return node;
    }
    return null;
  }

  values(): number[] {
    const out: number[] = [];
    for (let node = this.head; node; node = node.next) out.push(node.val);
    return out;
  }
}

const NODE: CField[] = [['val', 'int'], ['next', 'ptr']];
const NODE_LAYOUT = layoutOf(NODE);
const [VAL_FIELD, NEXT_FIELD] = NODE_LAYOUT.fields;
const NODE_PAD = NODE_LAYOUT.pads[0].size;
export const PUSHES = [30, 20, 10];
export const FIND_TARGET = 30;
export const INSERT_VALUE = 25;
export const REMOVE_TARGET = 20;
const short = (addr: bigint) => `…${addr.toString(16).slice(-3)}`;
const DX = 92;
const DY = 53;

function build() {
  const list = new List();
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => list.cmp + list.writes;
  const nodeBytes = (node: ListNode, summary: string, values?: Record<string, CValue>, color: Color = 'blue') =>
    cStruct('struct node', NODE, values ?? { val: node.val, next: node.next?.addr ?? 0n }, {
      color,
      summary,
      notes: { val: 'int，4 字节，放在偏移 0。', next: '指针要求 8 字节对齐，所以 val 后面有 4 字节填充。' },
    });

  interface View {
    tones?: Record<string, Tone>;
    lift?: string[];
    marks?: Array<[string, string, Color]>;
    /** 暂时放在链外的节点：刚分配还没接入，或者刚摘下来。 */
    aside?: { node: ListNode; after: number; edges: GraphEdge[] };
    edgeTones?: Record<string, Tone>;
    edges?: GraphEdge[];
  }
  const graph = (view: View = {}): GraphPrim => {
    const chain: ListNode[] = [];
    for (let node = list.head; node; node = node.next) chain.push(node);
    const slots = chain.length + 1;
    const middle = Math.max(slots - 1, 4) / 2;
    const nodes: GraphNode[] = chain.map((node, index) => ({
      id: node.addr.toString(16),
      x: (index - middle) * DX,
      y: (index - middle) * DY,
      v: String(node.val),
      sub: short(node.addr),
      tone: view.tones?.[node.addr.toString(16)],
      lift: view.lift?.includes(node.addr.toString(16)) || undefined,
    }));
    nodes.push({ id: 'null', x: (chain.length - middle) * DX, y: (chain.length - middle) * DY, v: 'NULL', tone: 'dim' });
    const edges: GraphEdge[] = chain.map((node, index) => ({
      a: node.addr.toString(16),
      b: chain[index + 1]?.addr.toString(16) ?? 'null',
      arrow: true,
      tone: view.edgeTones?.[node.addr.toString(16)],
    }));
    if (view.aside) {
      const { node, after, edges: extra } = view.aside;
      nodes.push({ id: node.addr.toString(16), x: (after + 0.5 - middle) * DX - 62, y: (after + 0.5 - middle) * DY + 92, v: String(node.val), sub: short(node.addr), tone: view.tones?.[node.addr.toString(16)] ?? 'violet' });
      edges.push(...extra);
    }
    if (view.edges) edges.push(...view.edges);
    const marks = [];
    if (list.head) marks.push({ at: list.head.addr.toString(16), text: 'head', color: 'teal' as Color });
    for (const [at, text, color] of view.marks ?? []) marks.push({ at, text, color });
    return { kind: 'graph', id: 'l', nodes, edges, marks, r: 25 };
  };
  const id = (node: ListNode) => node.addr.toString(16);

  const allocEvents = (node: ListNode, after: number, quick: boolean) => {
    bucket.push(pk('prog', 'alloc', 'violet', 'malloc(16)', ['sizeof(struct node)'], [ops(), 'ALLOC', `为节点 ${node.val} 申请 16 字节`, 'reg'],
      wire('进入 malloc 时的寄存器', 'regs', 'abi', callRegs('void *malloc(size_t size)', [['size', 16]], 'violet')), { quick }));
    bucket.push(pk('alloc', 'prog', 'violet', '新节点', [hex(node.addr)], [ops(), 'ALLOC', `返回 ${hex(node.addr)}，内容未初始化`, chunkSize(16)],
      wire('新节点的块头和用户区', 'mem', 'internal', chunkHeader(16), nodeBytes(node, `用户区地址 ${hex(node.addr)}（E.G.）`, { val: null, next: null })),
      { quick, ds: { list: [graph({ aside: { node, after, edges: [] } })] } }));
  };

  // ---------- 头插 ----------
  let pushWrites = 0;
  for (const val of PUSHES) {
    const quick = val !== PUSHES[0];
    const before = list.writes;
    list.pushFront(val, {
      allocated: (node) => allocEvents(node, -1, quick),
      linked(node, next) {
        const shown = graph({ aside: { node, after: -1, edges: [{ a: id(node), b: next ? id(next) : 'null', arrow: true, tone: 'blue' }] }, tones: { [id(node)]: 'blue' } });
        bucket.push(pk('prog', 'list', 'blue', 'n->next = head', [`val=${val}`, `next=${next ? short(next.addr) : 'NULL'}`], [ops(), 'WRITE', `写节点：val = ${val}，next 指向旧的头`, 16],
          wire('堆上的节点', 'mem', 'abi', nodeBytes(node, `地址 ${hex(node.addr)}（E.G.）`)), { quick, ds: { list: [shown] }, toAt: graphAim(shown, id(node)) }));
      },
      attached(node) {
        const shown = graph({ tones: { [id(node)]: 'blue' } });
        bucket.push(pk('prog', 'list', 'teal', 'head = n', [short(node.addr)], [ops(), 'WRITE', `head 改指 ${short(node.addr)}，头插完成`, 8],
          wire('头指针', 'mem', 'abi', cStruct('struct list', [['head', 'ptr']], { head: node.addr }, { color: 'teal', notes: { head: '整条链表只靠这一个指针进入。' } })),
          { quick, ds: { list: [shown] }, toAt: graphAim(shown, id(node)) }));
      },
    });
    pushWrites = list.writes - before;
  }

  // ---------- 遍历查找 ----------
  bucket = steps[1];
  const visitEvents = (target: number): ListHooks['visit'] => (node, cmp) => {
    const hit = node.val === target;
    const shown = graph({ tones: { [id(node)]: hit ? 'green' : 'amber' }, lift: [id(node)], marks: [[id(node), 'cur', 'blue']] });
    bucket.push(state('prog', { 目标: String(target), 比较: String(cmp) }));
    bucket.push(pk('prog', 'list', hit ? 'green' : 'blue', `cur->val == ${target} ?`, [`${node.val} ${hit ? '==' : '!='} ${target}`], [ops(), 'CMP', `读 ${short(node.addr)}：val = ${node.val}${hit ? '，就是它' : `，顺着 next 走到 ${node.next ? short(node.next.addr) : 'NULL'}`}`, 16],
      wire('当前节点', 'mem', 'abi', nodeBytes(node, `地址 ${hex(node.addr)}（E.G.）`)), { quick: true, ds: { list: [shown] }, toAt: graphAim(shown, id(node)) }));
  };
  const foundNode = list.find(FIND_TARGET, { visit: visitEvents(FIND_TARGET) });
  const findCmp = list.cmp;
  const foundAtTail = foundNode?.next === null;

  // ---------- 中间插入 ----------
  bucket = steps[2];
  const prev = list.head!.next!;
  const beforeInsert = list.writes;
  list.insertAfter(prev, INSERT_VALUE, {
    allocated: (node) => allocEvents(node, 1, true),
    linked(node, next) {
      const shown = graph({ aside: { node, after: 1, edges: [{ a: id(node), b: id(next!), arrow: true, tone: 'blue' }] }, tones: { [id(node)]: 'blue' } });
      bucket.push(pk('prog', 'list', 'blue', 'n->next = p->next', [`next = ${short(next!.addr)}`], [ops(), 'WRITE', '第一步：新节点先指向后继，链表此刻没有变', 16],
        wire('新节点', 'mem', 'abi', nodeBytes(node, `地址 ${hex(node.addr)}（E.G.）`)), { ds: { list: [shown] }, toAt: graphAim(shown, id(node)) }));
    },
    attached(node, at) {
      const shown = graph({ tones: { [id(node)]: 'green', [id(at!)]: 'blue' }, edgeTones: { [id(at!)]: 'green', [id(node)]: 'green' } });
      bucket.push(pk('prog', 'list', 'green', 'p->next = n', [`next = ${short(node.addr)}`], [ops(), 'WRITE', `第二步：${at!.val} 改指 ${node.val}。只写了 ${list.writes - beforeInsert} 个指针，别的节点一个没动`, 8],
        wire('前驱节点', 'mem', 'abi', nodeBytes(at!, `地址 ${hex(at!.addr)}（E.G.）`)), { ds: { list: [shown] }, toAt: graphAim(shown, id(at!)) }));
    },
  });

  const insertWrites = list.writes - beforeInsert;

  // ---------- 删除 ----------
  bucket = steps[3];
  const beforeRemove = list.writes;
  const removed = list.remove(REMOVE_TARGET, {
    visit: visitEvents(REMOVE_TARGET),
    unlinked(node, before) {
      const shown = graph({ aside: { node, after: 0, edges: [{ a: id(node), b: id(node.next!), arrow: true, tone: 'dim' }] }, tones: { [id(node)]: 'amber', [id(before!)]: 'blue' }, edgeTones: { [id(before!)]: 'green' } });
      bucket.push(pk('prog', 'list', 'green', 'prev->next = cur->next', [`跳过 ${short(node.addr)}`], [ops(), 'WRITE', `${before!.val} 直接指向 ${node.next!.val}，节点 ${node.val} 脱离链表`, 8],
        wire('前驱节点', 'mem', 'abi', nodeBytes(before!, `地址 ${hex(before!.addr)}（E.G.）`)), { ds: { list: [shown] }, toAt: graphAim(shown, id(before!)) }));
    },
  })!;
  bucket.push(pk('prog', 'alloc', 'slate', 'free(cur)', [hex(removed.addr)], [ops(), 'FREE', '节点还给分配器。之后再读 cur 就是未定义行为', 'reg'],
    wire('进入 free 时的寄存器', 'regs', 'abi', callRegs('void free(void *ptr)', [['ptr', removed.addr, true]], 'slate')), { ds: { list: [graph()] } }));

  const removeWrites = list.writes - beforeRemove;

  // ---------- 代价 ----------
  const firstNode = list.head!;
  const greens: Record<string, Tone> = {};
  for (let node = list.head; node; node = node.next) greens[id(node)] = 'green';
  const final = graph({ tones: greens });
  steps[4].push(pk('prog', 'list', 'green', '最终链表', [list.values().join(' → ')], [ops(), 'READ', `最终 ${list.values().length} 个节点，每个占 ${chunkSize(16)} 字节堆空间`, 16],
    wire('第一个节点', 'mem', 'abi', nodeBytes(firstNode, `地址 ${hex(firstNode.addr)}（E.G.）`)), { ds: { list: [final] }, toAt: graphAim(final, id(firstNode)) }));
  steps[4].push(render);

  return { steps, list, findCmp, foundAtTail, pushWrites, insertWrites, removeWrites };
}

const { steps, list, findCmp, foundAtTail, pushWrites, insertWrites, removeWrites } = build();
export const listRun = { foundAtTail, findCmp, pushWrites, insertWrites, removeWrites };
const initial: GraphPrim = { kind: 'graph', id: 'l', r: 25, nodes: [{ id: 'null', x: -2 * DX, y: -2 * DY, v: 'NULL', tone: 'dim' }], edges: [] };

export const linkedlist: Lesson = {
  id: 'linkedlist',
  name: 'LINKED LIST',
  title: '链表',
  group: 'linear',
  layer: [1, 3],
  complexity: { best: 'O(1)，在头部或已知位置之后插入删除', worst: 'O(n)，查找要从头走到尾', note: '操作本身只改几个指针，贵的是先找到位置。' },
  opsUnit: '比较次数 + 指针写入次数',
  nodes: ['prog', 'list', 'alloc'],
  place: { prog: [140, 470], list: [510, 290], alloc: [850, 130] },
  labels: {
    prog: ['程序', '单向链表操作'],
    list: ['链表', `struct node，${NODE_LAYOUT.size} 字节`],
    alloc: ['分配器', 'glibc malloc'],
  },
  labelAt: { list: [190, -90] },
  radius: { list: 60 },
  initial: { list: [initial] },
  start: ['prog', 'list'],
  legend: [['violet', '分配'], ['blue', '写入或比较'], ['teal', '头指针'], ['green', '接通'], ['slate', '释放'], [null, '操作数：比较 + 指针写入']],
  overview: {
    full: '节点散落在堆上，靠指针串成一条线',
    description: `数组要求元素连续，插入时得挪动后面所有元素。链表的节点各自分配，每个节点记住下一个节点的地址。这一课真实构建一条链表，看头插、查找、中间插入和删除各改了哪些指针，打开检查器还能看到 next 前面的 ${NODE_PAD} 个填充字节。`,
    facts: [
      ['struct node', 'int val; struct node *next;'],
      ['大小', `${NODE_LAYOUT.size} 字节，含 ${NODE_PAD} 字节填充`],
      ['头部插入', 'O(1)'],
      ['按值查找', 'O(n)'],
      ['随机访问', '不支持，只能顺着走'],
      ['操作数', '比较 + 指针写入'],
    ],
  },
  steps: [
    {
      title: '头部插入',
      desc: '新节点指向旧头，再改 head',
      detail: `依次插入 ${PUSHES.join('、')}，所以链表顺序和插入顺序相反。每次只写 ${pushWrites} 个指针，和链表多长无关，这就是 O(1)。顺序不能反：如果先改 head，旧链表就没有指针指向了。`,
      facts: [['节点大小', `${NODE_LAYOUT.size} 字节`], ['val 偏移', String(VAL_FIELD.offset)], ['next 偏移', `${NEXT_FIELD.offset}，前面填充 ${NODE_PAD} 字节`], ['每次写指针', `${pushWrites} 个`]],
      events: [type('./list'), show('alloc'), ...steps[0]],
    },
    {
      title: '遍历查找',
      desc: '只能从头顺着 next 走',
      detail: `节点地址之间没有规律，所以不能像数组那样算出第 k 个的位置，只能一个一个读。找 ${FIND_TARGET} 比较了 ${findCmp} 次，它在链表末尾。每一步都可能读到不在缓存里的内存，实际常比同样长度的数组慢。`,
      facts: [['比较次数', String(findCmp)], ['最坏情况', 'n 次'], ['跳到第 k 个', '要走 k 步']],
      events: steps[1],
    },
    {
      title: '中间插入',
      desc: '先接后继，再改前驱',
      detail: `已经拿到前驱节点时，插入只写 ${insertWrites} 个指针，后面的节点不用挪。先让新节点指向后继，此时链表没有任何变化；再改前驱的 next，新节点才算接入。如果顺序反了，后半条链就丢了。`,
      facts: [['写指针', `${insertWrites} 个`], ['移动元素', '0 个'], ['前提', '已经找到前驱']],
      events: steps[2],
    },
    {
      title: '删除节点',
      desc: '前驱绕过它，然后 free',
      detail: '单向链表删除时必须知道前驱，所以遍历要多记一个 prev。改完前驱的 next，节点就脱离了链表，这时才能 free。free 之后这块内存可能被别人使用，继续读它是未定义行为。',
      facts: [['写指针', `${removeWrites} 个`], ['还需要', '前驱指针'], ['常见错误', 'free 后再读 cur->next']],
      events: steps[3],
    },
    {
      title: '内存代价',
      desc: `存一个 int，占 ${chunkSize(NODE_LAYOUT.size)} 字节堆空间`,
      detail: `每个节点的 int 只有 ${VAL_FIELD.size} 字节，加上指针和填充是 ${NODE_LAYOUT.size} 字节，glibc 的 malloc 再加块头后实际占 ${chunkSize(NODE_LAYOUT.size)} 字节。同样的元素放进数组只要 ${VAL_FIELD.size} 字节一个，还紧挨在一起。所以除非频繁在已知位置增删，否则数组通常更快。`,
      facts: [['最终链表', list.values().join(' → ')], ['有效数据', `${VAL_FIELD.size} 字节`], ['实际占用', `${chunkSize(NODE_LAYOUT.size)} 字节（glibc）`], ['总操作数', String(list.cmp + list.writes)]],
      events: steps[4],
    },
  ],
  outro: {
    title: '指针换来灵活，也带来开销',
    desc: '插入删除便宜，查找和缓存昂贵',
    text: `链表把「挪动元素」换成了「改指针」，代价是失去随机访问和缓存连续性。需要从尾部操作时可以加 tail 指针，需要反向走时可以用双向链表，节点又多 ${NEXT_FIELD.size} 字节。`,
    facts: [['插入删除', 'O(1)，已知位置时'], ['查找', 'O(n)'], ['下一课', 'STACK']],
  },
};
