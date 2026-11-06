import { callRegs, chunkHeader, chunkSize, cStruct, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim } from '../scene/ds';
import { HEAP, treeLayout } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, Tone } from './types';

export interface BstNode {
  key: number;
  left: BstNode | null;
  right: BstNode | null;
  addr: bigint;
}

export type Side = 'left' | 'right';
/** 指针写在哪里：某个节点的 left 或 right，或者树根变量 root。 */
export type Link = { owner: BstNode; side: Side } | { owner: null; side: 'root' };

export interface BstHooks {
  compare?(node: BstNode, key: number, go: Side | 'hit'): void;
  created?(node: BstNode): void;
  linked?(link: Link, target: BstNode | null, why: 'insert' | 'unlink' | 'bypass'): void;
  missing?(key: number, last: BstNode | null): void;
  /** 找后继：沿右子树一路向左。 */
  walk?(node: BstNode, from: BstNode): void;
  copied?(node: BstNode, from: BstNode, old: number): void;
  freed?(node: BstNode): void;
}

/** 二叉搜索树：左子树的键都更小，右子树的键都更大，不存重复键。cmp 统计和节点键的比较，writes 统计写指针和键，walks 统计找后继走的步数。 */
export class Bst {
  root: BstNode | null = null;
  cmp = 0;
  writes = 0;
  walks = 0;
  private cursor = HEAP;

  private setLink(link: Link, target: BstNode | null, why: 'insert' | 'unlink' | 'bypass', hooks: BstHooks): void {
    if (link.owner) link.owner[link.side] = target;
    else this.root = target;
    this.writes++;
    hooks.linked?.(link, target, why);
  }

  /** 从根往下走，返回找到的节点（没有就是 null）和最后一条经过的指针。 */
  private descend(key: number, hooks: BstHooks): { node: BstNode | null; link: Link; last: BstNode | null } {
    let link: Link = { owner: null, side: 'root' };
    let node = this.root;
    let last: BstNode | null = null;
    while (node) {
      this.cmp++;
      const go: Side | 'hit' = key === node.key ? 'hit' : key < node.key ? 'left' : 'right';
      hooks.compare?.(node, key, go);
      if (go === 'hit') break;
      last = node;
      link = { owner: node, side: go };
      node = node[go];
    }
    return { node, link, last };
  }

  insert(key: number, hooks: BstHooks = {}): BstNode {
    const { node, link } = this.descend(key, hooks);
    if (node) return node;
    const fresh: BstNode = { key, left: null, right: null, addr: this.cursor };
    this.cursor += BigInt(chunkSize(24));
    hooks.created?.(fresh);
    this.setLink(link, fresh, 'insert', hooks);
    return fresh;
  }

  find(key: number, hooks: BstHooks = {}): BstNode | null {
    const { node, last } = this.descend(key, hooks);
    if (!node) hooks.missing?.(key, last);
    return node;
  }

  remove(key: number, hooks: BstHooks = {}): boolean {
    const { node, link, last } = this.descend(key, hooks);
    if (!node) {
      hooks.missing?.(key, last);
      return false;
    }
    if (node.left && node.right) {
      // 两个孩子：拿右子树里最小的键（后继）顶替，再删掉后继原来的节点。后继没有左孩子。
      let parent = node;
      let side: Side = 'right';
      let next = node.right;
      this.walks++;
      hooks.walk?.(next, node);
      while (next.left) {
        parent = next;
        side = 'left';
        next = next.left;
        this.walks++;
        hooks.walk?.(next, parent);
      }
      const old = node.key;
      node.key = next.key;
      this.writes++;
      hooks.copied?.(node, next, old);
      this.setLink({ owner: parent, side }, next.right, next.right ? 'bypass' : 'unlink', hooks);
      hooks.freed?.(next);
      return true;
    }
    const child = node.left ?? node.right;
    this.setLink(link, child, child ? 'bypass' : 'unlink', hooks);
    hooks.freed?.(node);
    return true;
  }

  preorder(): number[] {
    const out: number[] = [];
    const walk = (node: BstNode | null) => {
      if (!node) return;
      out.push(node.key);
      walk(node.left);
      walk(node.right);
    };
    walk(this.root);
    return out;
  }

  inorder(): number[] {
    const out: number[] = [];
    const walk = (node: BstNode | null) => {
      if (!node) return;
      walk(node.left);
      out.push(node.key);
      walk(node.right);
    };
    walk(this.root);
    return out;
  }

  height(node: BstNode | null = this.root): number {
    return node ? 1 + Math.max(this.height(node.left), this.height(node.right)) : 0;
  }
}

const NODE: CField[] = [['key', 'int'], ['left', 'ptr'], ['right', 'ptr']];
const NODE_LAYOUT = layoutOf(NODE);
export const KEYS = [50, 30, 70, 20, 40, 60, 80, 65];
export const HIT = 65;
export const MISS = 45;
/** 依次删除：叶子、只有一个孩子、有两个孩子。 */
export const REMOVALS = [20, 30, 50];
const short = (addr: bigint) => `…${addr.toString(16).slice(-3)}`;
const sideName = (side: Side) => (side === 'left' ? '左' : '右');

/** 一次查找或删除实际走过的路，文案从这里取值。 */
export interface PathLog {
  key: number;
  path: number[];
  found: boolean;
  last: number | null;
}

function build() {
  const tree = new Bst();
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => tree.cmp + tree.writes + tree.walks;
  const nodeBytes = (node: BstNode, color: Color = 'blue', summary = `地址 ${hex(node.addr)}（E.G.）`) => cStruct('struct bst_node', NODE, { key: node.key, left: node.left?.addr ?? 0n, right: node.right?.addr ?? 0n }, {
    color, summary, notes: { key: '键。', left: '左子树，键都比它小。', right: '右子树，键都比它大。' },
  });
  const prim = (tones: Record<string, Tone> = {}, lift: bigint[] = [], marks: Array<[bigint, string, Color]> = []): GraphPrim => {
    if (!tree.root) return { kind: 'graph', id: 't', nodes: [{ id: 'root', x: 0, y: 0, v: 'NULL', tone: 'dim' }], edges: [], r: 24 };
    const layout = treeLayout<BstNode>(tree.root, (node) => node.left, (node) => node.right, 80, 92);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const [node, point] of layout) {
      const id = String(node.addr);
      nodes.push({ id, x: point.x, y: point.y, v: String(node.key), sub: short(node.addr), tone: tones[id], lift: lift.includes(node.addr) || undefined });
      for (const child of [node.left, node.right]) if (child) edges.push({ a: id, b: String(child.addr), tone: tones[id] && tones[String(child.addr)] ? tones[String(child.addr)] : undefined });
    }
    return { kind: 'graph', id: 't', nodes, edges, r: 24, marks: marks.map(([at, text, color]) => ({ at: String(at), text, color })) };
  };
  const linkText = (link: Link) => (link.owner ? `${link.owner.key} 的 ${link.side}` : 'root');

  const logs: PathLog[] = [];
  const current = () => logs[logs.length - 1];
  let doing = '插入';
  const hooks: BstHooks = {
    compare(node, key, go) {
      current().path.push(node.key);
      const id = String(node.addr);
      const shown = prim({ [id]: go === 'hit' ? 'green' : 'blue' }, [node.addr]);
      const how = go === 'hit' ? '相等，就是它' : `${key} ${go === 'left' ? '<' : '>'} ${node.key}，往${sideName(go)}走`;
      bucket.push(state('prog', { 操作: `${doing} ${key}`, 比较: String(tree.cmp) }));
      bucket.push(pk('prog', 'tree', go === 'hit' ? 'green' : 'blue', `${key} vs ${node.key}`, [how], [ops(), 'CMP', `${key} 和节点 ${node.key} 比较：${how}`, 4],
        wire('当前节点', 'mem', 'abi', nodeBytes(node)), { quick: true, ds: { tree: [shown] }, toAt: graphAim(shown, id) }));
    },
    created(node) {
      bucket.push(pk('alloc', 'prog', 'violet', 'malloc(24)', [`节点 ${node.key}`, hex(node.addr)], [ops(), 'ALLOC', `走到空位，malloc(${NODE_LAYOUT.size}) 返回 ${hex(node.addr)}，写入键 ${node.key}，两个指针置 NULL`, chunkSize(NODE_LAYOUT.size)],
        wire('新节点', 'mem', 'internal', chunkHeader(NODE_LAYOUT.size), nodeBytes(node, 'violet')), { quick: tree.root !== null }));
    },
    linked(link, target, why) {
      const ownerId = link.owner ? String(link.owner.addr) : null;
      const targetId = target ? String(target.addr) : null;
      const tones: Record<string, Tone> = {};
      if (ownerId) tones[ownerId] = 'teal';
      if (targetId) tones[targetId] = why === 'insert' ? 'green' : 'teal';
      const shown = prim(tones);
      const value = target ? short(target.addr) : 'NULL';
      const info = why === 'insert'
        ? link.owner ? `节点 ${link.owner.key} 的 ${link.side} 指向新节点 ${target!.key}` : `树是空的，root 指向 ${target!.key}`
        : why === 'unlink' ? `${linkText(link)} 改成 NULL，被删的节点从树上摘下` : `${linkText(link)} 改指 ${target!.key}，绕过被删的节点`;
      const aim = targetId ?? ownerId;
      bucket.push(pk('prog', 'tree', why === 'insert' ? 'green' : 'teal', `${link.owner ? `${link.owner.key}->${link.side}` : 'root'} = ${value}`, [why === 'insert' ? '接上新节点' : why === 'unlink' ? '摘下叶子' : '接上孙子'], [ops(), 'WRITE', info, 8],
        link.owner ? wire('写入后的节点', 'mem', 'abi', nodeBytes(link.owner, why === 'insert' ? 'green' : 'teal')) : wire('root 变量', 'mem', 'abi', cStruct('struct bst_node *root', [['root', 'ptr']], { root: target?.addr ?? 0n }, { color: 'green', notes: { root: '整棵树只靠这一个指针找到。' } })),
        { quick: why === 'insert' && tree.root !== target, ds: { tree: [shown] }, toAt: aim ? graphAim(shown, aim) : undefined }));
    },
    missing(key, last) {
      const shown = prim(last ? { [String(last.addr)]: 'amber' } : {});
      current().found = false;
      current().last = last?.key ?? null;
      bucket.push(note('tree', `${key} 不在树里`, 'amber'));
      bucket.push(pk('tree', 'prog', 'amber', 'NULL', [`${key} 不存在`], [ops(), 'READ', `节点 ${last?.key} 的 ${key < (last?.key ?? 0) ? 'left' : 'right'} 是 NULL，${key} 不在树里`, 8],
        wire('最后一个节点', 'mem', 'abi', nodeBytes(last!, 'amber')), { ds: { tree: [shown] }, fromAt: last ? graphAim(shown, String(last.addr)) : undefined }));
    },
    walk(node, from) {
      const shown = prim({ [String(node.addr)]: 'amber', [String(from.addr)]: 'slate' }, [node.addr]);
      bucket.push(pk('prog', 'tree', 'amber', node.left ? `${node.key}，继续向左` : `后继 ${node.key}`, [node.left ? 'left 不是 NULL' : 'left 是 NULL，到头了'], [ops(), 'READ', from.right === node ? `找后继：先进右子树，到 ${node.key}` : `找后继：${from.key} 的 left 是 ${node.key}，${node.left ? '还能往左' : '它没有左孩子，就是后继'}`, 8],
        wire('后继候选', 'mem', 'abi', nodeBytes(node, 'amber')), { quick: true, ds: { tree: [shown] }, toAt: graphAim(shown, String(node.addr)) }));
    },
    copied(node, from, old) {
      const shown = prim({ [String(node.addr)]: 'violet', [String(from.addr)]: 'amber' });
      bucket.push(pk('prog', 'tree', 'violet', `key = ${node.key}`, [`${old} 换成 ${node.key}`], [ops(), 'WRITE', `把后继的键 ${node.key} 写进 ${hex(node.addr)} 这个节点，覆盖 ${old}。节点本身不动`, 4],
        wire('被顶替的节点', 'mem', 'abi', nodeBytes(node, 'violet')), { ds: { tree: [shown] }, toAt: graphAim(shown, String(node.addr)) }));
    },
    freed(node) {
      bucket.push(pk('prog', 'alloc', 'slate', `free(${short(node.addr)})`, [`节点 ${node.key}`], [ops(), 'FREE', `节点已经摘下，free 把 ${chunkSize(NODE_LAYOUT.size)} 字节的块还给分配器`, 'reg'],
        wire('进入 free 时的寄存器', 'regs', 'abi', callRegs('void free(void *ptr)', [['ptr', node.addr, true]], 'slate')), { quick: true, ds: { tree: [prim()] } }));
    },
  };

  doing = '插入';
  for (const key of KEYS) {
    logs.push({ key, path: [], found: true, last: null });
    tree.insert(key, hooks);
  }
  const built = { cmp: tree.cmp, height: tree.height(), inorder: tree.inorder() };

  bucket = steps[1];
  doing = '查找';
  const finds: PathLog[] = [];
  for (const key of [HIT, MISS]) {
    logs.push({ key, path: [], found: true, last: null });
    const node = tree.find(key, hooks);
    if (node) {
      const shown = prim({ [String(node.addr)]: 'green' });
      bucket.push(note('tree', `找到 ${key}，比较 ${current().path.length} 次`, 'green'));
      bucket.push({ type: 'ds', frame: { tree: [shown] } });
    }
    finds.push(current());
  }

  doing = '删除';
  const removals: Array<PathLog & { shape: number[]; successor?: number; relink?: { owner: number | null; side: string; target: number | null } }> = [];
  REMOVALS.forEach((key, index) => {
    bucket = steps[2 + index];
    logs.push({ key, path: [], found: true, last: null });
    let successor: number | undefined;
    let relink: { owner: number | null; side: string; target: number | null } | undefined;
    tree.remove(key, { ...hooks, copied(node, from, old) {
      successor = node.key;
      hooks.copied!(node, from, old);
    }, linked(link, target, why) {
      relink = { owner: link.owner?.key ?? null, side: link.side, target: target?.key ?? null };
      hooks.linked!(link, target, why);
    } });
    removals.push({ ...current(), shape: tree.preorder(), successor, relink });
    bucket.push({ type: 'ds', frame: { tree: [prim()] } });
  });
  const final = prim({ [String(tree.root!.addr)]: 'green' });
  bucket.push(state('prog', { 操作: null, 比较: null }));
  bucket.push(note('tree', `中序仍然有序：${tree.inorder().join(' ')}`, 'green'));
  bucket.push({ type: 'ds', frame: { tree: [final] } });
  bucket.push(render);

  return { steps, tree, built, finds, removals, ops: ops() };
}

const { steps, tree, built, finds, removals, ops: totalOps } = build();
export const bstRun = { built, finds, removals, preorder: tree.preorder(), inorder: tree.inorder(), cmp: tree.cmp, writes: tree.writes, walks: tree.walks, ops: totalOps };
const [hit, miss] = finds;
const [leaf, single, double] = removals;
const sorted = [...KEYS].sort((a, b) => a - b);
const chain = new Bst();
sorted.forEach((key) => chain.insert(key));

export const bst: Lesson = {
  id: 'bst',
  name: 'BST',
  title: '二叉搜索树',
  group: 'tree',
  layer: [2, 3],
  complexity: { best: 'O(log n)，树比较平衡时，每比较一次排除一半', worst: 'O(n)，按顺序插入会退化成一条链', note: '查找、插入、删除的代价都等于走过的高度。' },
  opsUnit: '比较 + 写指针或键 + 找后继的步数',
  nodes: ['prog', 'tree', 'alloc'],
  place: { prog: [120, 470], tree: [560, 90], alloc: [900, 520] },
  labels: {
    prog: ['程序', 'bst_insert / find / remove'],
    tree: ['二叉搜索树', `struct bst_node，${NODE_LAYOUT.size} 字节`],
    alloc: ['分配器', 'glibc malloc'],
  },
  labelAt: { tree: [-260, 30] },
  radius: { tree: 60 },
  initial: { tree: [{ kind: 'graph', id: 't', nodes: [{ id: 'root', x: 0, y: 0, v: 'NULL', tone: 'dim' }], edges: [], r: 24 }] },
  start: ['prog', 'tree'],
  legend: [['blue', '比较'], ['violet', '分配或改键'], ['green', '接入或命中'], ['teal', '改指针'], ['amber', '找后继或没找到'], [null, '操作数：比较 + 写入 + 找后继']],
  overview: {
    full: '左边都小，右边都大，比较一次走一层',
    description: `二叉搜索树里每个节点的左子树都比它小，右子树都比它大，所以从根出发，比较一次就能决定往哪边走。这一课真实插入 ${KEYS.length} 个键，再查找、删除三种不同情况的节点。节点下面的小字是地址的末三位，删除时可以看到哪个节点被释放。`,
    facts: [
      ['性质', '左子树 < 节点 < 右子树'],
      ['struct bst_node', `${NODE_LAYOUT.size} 字节，key 后面有 ${NODE_LAYOUT.pads[0].size} 字节填充`],
      ['查找', '等于树高'],
      ['中序遍历', '得到有序序列'],
      ['最坏', '有序插入时退化成链'],
      ['平衡的版本', 'AVL、红黑树'],
    ],
  },
  steps: [
    {
      title: '逐个插入',
      desc: `${KEYS.join('、')}`,
      detail: `每个新键从根开始比较，小就往左，大就往右，走到 NULL 的位置就在那里接上新节点。int key 只占 4 字节，后面的指针要 8 字节对齐，所以 key 后面有 ${NODE_LAYOUT.pads[0].size} 字节填充，整个节点 ${NODE_LAYOUT.size} 字节。${KEYS.length} 次插入一共比较 ${built.cmp} 次，树高 ${built.height}。`,
      facts: [['key 偏移', String(NODE_LAYOUT.fields[0].offset)], ['left 偏移', String(NODE_LAYOUT.fields[1].offset)], ['right 偏移', String(NODE_LAYOUT.fields[2].offset)], ['树高', String(built.height)]],
      events: [type(`./bst ${KEYS.join(' ')}`), show('alloc'), ...steps[0]],
    },
    {
      title: '查找',
      desc: `找 ${hit.key} 比较 ${hit.path.length} 次，找 ${miss.key} 落空`,
      detail: `查找和插入走的是同一条路：${hit.key} 依次和 ${hit.path.join('、')} 比较，第 ${hit.path.length} 次相等。找 ${miss.key} 时经过 ${miss.path.join('、')}，下一步是 NULL，说明它不在树里，不用看其他分支。比较次数最多等于树高。`,
      facts: [[`找 ${hit.key}`, hit.path.join(' → ')], [`找 ${miss.key}`, `${miss.path.join(' → ')} → NULL`], ['最多比较', `树高 ${built.height} 次`]],
      events: steps[1],
    },
    {
      title: '删除叶子',
      desc: `${leaf.key} 没有孩子，直接摘下`,
      detail: `${leaf.key} 的两个指针都是 NULL，只要把父节点 ${leaf.path[leaf.path.length - 2]} 指向它的指针改成 NULL，再 free 掉。只写了 1 个指针，其他节点都不受影响。`,
      facts: [['路径', leaf.path.join(' → ')], ['写指针', '1 个'], ['前序', leaf.shape.join(' ')]],
      events: steps[2],
    },
    {
      title: '删除单孩子节点',
      desc: `${single.key} 只剩一个孩子，让孩子顶上来`,
      detail: `删掉 ${leaf.key} 之后，${single.key} 只有右孩子。父节点 ${single.path[single.path.length - 2]} 直接指向这个孩子，绕过 ${single.key}，再释放它。孩子整棵子树都比 ${single.path[single.path.length - 2]} 小，所以接上去仍然满足左小右大。`,
      facts: [['路径', single.path.join(' → ')], ['写指针', '1 个'], ['前序', single.shape.join(' ')]],
      events: steps[3],
    },
    {
      title: '删除双孩子节点',
      desc: `用后继 ${double.successor} 顶替 ${double.key}`,
      detail: `${double.key} 有两个孩子，没法直接绕过。先找后继，也就是右子树里最小的键：进右子树后一直往左，找到 ${double.successor}。把 ${double.successor} 写进 ${double.key} 所在的节点，再删掉后继原来的节点，它没有左孩子，退化成前面的简单情况。这里 ${double.successor} 的右孩子 ${double.relink!.target} 接到 ${double.relink!.owner} 的 ${double.relink!.side} 上。`,
      facts: [['后继', String(double.successor)], ['新根', String(tree.root!.key)], ['前序', double.shape.join(' ')], ['中序', tree.inorder().join(' ')]],
      events: steps[4],
    },
  ],
  outro: {
    title: '形状由插入顺序决定',
    desc: '顺序不好就退化成链',
    text: `同样 ${KEYS.length} 个键，按 ${sorted[0]}、${sorted[1]}、${sorted[2]} 这样从小到大插入，每个新键都接在最右边，树高变成 ${chain.height()}，查找退化成 O(n)。后面的 AVL 树在插入后旋转，把高度压在 O(log n)。`,
    facts: [['本例树高', String(built.height)], ['有序插入树高', String(chain.height())], ['下一课', 'BINARY HEAP']],
  },
};
