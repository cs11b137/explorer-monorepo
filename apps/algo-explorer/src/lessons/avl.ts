import { callRegs, chunkHeader, chunkSize, cStruct, layoutOf, wire, type CField } from '../decode/structures';
import { hex } from '../decode/writer';
import { graphAim } from '../scene/ds';
import { HEAP, treeLayout } from './common';
import { note, pk, render, show, state, type } from './dsl';
import type { Color, GraphEdge, GraphNode, GraphPrim, Lesson, LessonEvent, Tone } from './types';

export interface AvlNode {
  key: number;
  height: number;
  left: AvlNode | null;
  right: AvlNode | null;
  addr: bigint;
}

export type RotationKind = 'right' | 'left';

export interface AvlHooks {
  compare?(node: AvlNode, key: number): void;
  created?(node: AvlNode): void;
  attached?(child: AvlNode, parent: AvlNode, side: 'left' | 'right'): void;
  unbalanced?(node: AvlNode, balance: number, shape: 'LL' | 'RR' | 'LR' | 'RL'): void;
  rotated?(kind: RotationKind, oldRoot: AvlNode, newRoot: AvlNode): void;
}

export const heightOf = (node: AvlNode | null) => node?.height ?? 0;
export const balanceOf = (node: AvlNode) => heightOf(node.left) - heightOf(node.right);
const update = (node: AvlNode) => {
  node.height = 1 + Math.max(heightOf(node.left), heightOf(node.right));
};

/** AVL 树：每个节点左右子树高度差不超过 1，插入后沿路径修复。 */
export class AvlTree {
  root: AvlNode | null = null;
  cmp = 0;
  rotations = 0;
  private cursor = HEAP;

  private rotateRight(y: AvlNode, hooks: AvlHooks, relink: (node: AvlNode) => void): AvlNode {
    const x = y.left!;
    y.left = x.right;
    x.right = y;
    update(y);
    update(x);
    this.rotations++;
    relink(x);
    hooks.rotated?.('right', y, x);
    return x;
  }

  private rotateLeft(x: AvlNode, hooks: AvlHooks, relink: (node: AvlNode) => void): AvlNode {
    const y = x.right!;
    x.right = y.left;
    y.left = x;
    update(x);
    update(y);
    this.rotations++;
    relink(y);
    hooks.rotated?.('left', x, y);
    return y;
  }

  insert(key: number, hooks: AvlHooks = {}): void {
    const visit = (node: AvlNode | null, relink: (next: AvlNode) => void): AvlNode => {
      if (!node) {
        const fresh: AvlNode = { key, height: 1, left: null, right: null, addr: this.cursor };
        this.cursor += BigInt(chunkSize(24));
        hooks.created?.(fresh);
        return fresh;
      }
      this.cmp++;
      hooks.compare?.(node, key);
      if (key < node.key) {
        const child = visit(node.left, (next) => { node.left = next; });
        const wasEmpty = node.left === null;
        node.left = child;
        update(node);
        if (wasEmpty) hooks.attached?.(child, node, 'left');
      } else {
        const child = visit(node.right, (next) => { node.right = next; });
        const wasEmpty = node.right === null;
        node.right = child;
        update(node);
        if (wasEmpty) hooks.attached?.(child, node, 'right');
      }
      const balance = balanceOf(node);
      if (balance > 1) {
        if (key > node.left!.key) {
          hooks.unbalanced?.(node, balance, 'LR');
          node.left = this.rotateLeft(node.left!, hooks, (next) => { node.left = next; });
        } else hooks.unbalanced?.(node, balance, 'LL');
        return this.rotateRight(node, hooks, relink);
      }
      if (balance < -1) {
        if (key < node.right!.key) {
          hooks.unbalanced?.(node, balance, 'RL');
          node.right = this.rotateRight(node.right!, hooks, (next) => { node.right = next; });
        } else hooks.unbalanced?.(node, balance, 'RR');
        return this.rotateLeft(node, hooks, relink);
      }
      return node;
    };
    this.root = visit(this.root, (next) => { this.root = next; });
  }

  preorder(): number[] {
    const out: number[] = [];
    const walk = (node: AvlNode | null) => {
      if (!node) return;
      out.push(node.key);
      walk(node.left);
      walk(node.right);
    };
    walk(this.root);
    return out;
  }
}

const AVL: CField[] = [['key', 'int'], ['height', 'int'], ['left', 'ptr'], ['right', 'ptr']];
const AVL_LAYOUT = layoutOf(AVL);
export const KEYS = [30, 20, 10, 40, 50, 25];
/** 每个步骤要插入的键，在 KEYS 里的下标范围。 */
const PHASES: Array<[number, number]> = [[0, 2], [2, 3], [3, 5], [5, 6]];
const ORDERED = 7;

/** 一次插入实际发生了什么。文案里的结点、高度和旋转都从这里取。 */
export interface InsertLog {
  key: number;
  path: Array<{ node: number; left: boolean }>;
  broken: { node: number; left: number; right: number; balance: number; shape: 'LL' | 'RR' | 'LR' | 'RL' } | null;
  rotations: Array<{ kind: RotationKind; oldRoot: number; newRoot: number }>;
}
const short = (addr: bigint) => `…${addr.toString(16).slice(-3)}`;
const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

function build() {
  const tree = new AvlTree();
  const steps: LessonEvent[][] = [[], [], [], [], []];
  let bucket = steps[0];
  const ops = () => tree.cmp + tree.rotations;
  const nodeBytes = (node: AvlNode, color: Color = 'blue', summary = `地址 ${hex(node.addr)}（E.G.）`) => cStruct('struct avl_node', AVL, { key: node.key, height: node.height, left: node.left?.addr ?? 0n, right: node.right?.addr ?? 0n }, {
    color, summary, notes: { key: '键。', height: '以这个节点为根的子树高度，叶子是 1。', left: '左子树，所有键都更小。', right: '右子树，所有键都不更小。' },
  });
  const prim = (tones: Record<number, Tone> = {}, lift: number[] = [], marks: Array<[number, string, Color]> = []): GraphPrim => {
    const layout = treeLayout<AvlNode>(tree.root, (node) => node.left, (node) => node.right, 84, 96);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const [node, point] of layout) {
      nodes.push({ id: String(node.key), x: point.x, y: point.y, v: String(node.key), sub: `h${node.height} ${signed(balanceOf(node))}`, tone: tones[node.key], lift: lift.includes(node.key) || undefined });
      for (const child of [node.left, node.right]) if (child) edges.push({ a: String(node.key), b: String(child.key), tone: tones[node.key] && tones[child.key] ? tones[child.key] : undefined });
    }
    return { kind: 'graph', id: 't', nodes, edges, r: 24, marks: marks.map(([at, text, color]) => ({ at: String(at), text, color })) };
  };

  const logs: InsertLog[] = [];
  const current = () => logs[logs.length - 1];
  const hooks: AvlHooks = {
    compare(node, key) {
      current().path.push({ node: node.key, left: key < node.key });
      const shown = prim({ [node.key]: 'blue' }, [node.key]);
      bucket.push(state('prog', { 插入: String(key), 比较: String(tree.cmp) }));
      bucket.push(pk('prog', 'tree', 'blue', `${key} < ${node.key} ?`, [key < node.key ? '往左走' : '往右走'], [ops(), 'CMP', `${key} 和节点 ${node.key} 比较，${key < node.key ? '往左' : '往右'}`, 4],
        wire('当前节点', 'mem', 'abi', nodeBytes(node)), { quick: true, ds: { tree: [shown] }, toAt: graphAim(shown, String(node.key)) }));
    },
    created(node) {
      bucket.push(pk('prog', 'alloc', 'violet', 'malloc(24)', [`节点 ${node.key}`], [ops(), 'ALLOC', `走到空位，为 ${node.key} 申请 24 字节`, 'reg'],
        wire('进入 malloc 时的寄存器', 'regs', 'abi', callRegs('void *malloc(size_t size)', [['size', 24]], 'violet')), { quick: true }));
      bucket.push(pk('alloc', 'prog', 'violet', '新节点', [hex(node.addr)], [ops(), 'ALLOC', `返回 ${hex(node.addr)}，height 记为 1`, chunkSize(24)],
        wire('新节点', 'mem', 'internal', chunkHeader(24), nodeBytes(node, 'violet')), { quick: true }));
    },
    attached(child, parent, side) {
      const shown = prim({ [child.key]: 'green', [parent.key]: 'blue' });
      bucket.push(pk('prog', 'tree', 'green', `${side} = ${short(child.addr)}`, [`${parent.key} 的${side === 'left' ? '左' : '右'}子节点`], [ops(), 'WRITE', `节点 ${parent.key} 的 ${side} 指向 ${child.key}`, 8],
        wire('父节点，写入后', 'mem', 'abi', nodeBytes(parent)), { quick: true, ds: { tree: [shown] }, toAt: graphAim(shown, String(child.key)) }));
    },
    unbalanced(node, balance, shape) {
      current().broken = { node: node.key, left: heightOf(node.left), right: heightOf(node.right), balance, shape };
      const shown = prim({ [node.key]: 'amber' }, [node.key], [[node.key, `失衡 ${signed(balance)}`, 'amber']]);
      bucket.push(note('tree', `${node.key} 的平衡因子 ${signed(balance)}，属于 ${shape} 型`, 'amber'));
      bucket.push(pk('prog', 'tree', 'amber', `失衡 ${signed(balance)}`, [`${shape} 型`], [ops(), 'READ', `回溯时算出节点 ${node.key}：左高 ${heightOf(node.left)}，右高 ${heightOf(node.right)}，差 ${signed(balance)}，${shape} 型`, 24],
        wire('失衡的节点', 'mem', 'abi', nodeBytes(node, 'amber')), { ds: { tree: [shown] }, toAt: graphAim(shown, String(node.key)) }));
    },
    rotated(kind, oldRoot, newRoot) {
      current().rotations.push({ kind, oldRoot: oldRoot.key, newRoot: newRoot.key });
      const shown = prim({ [oldRoot.key]: 'violet', [newRoot.key]: 'green' });
      bucket.push(pk('prog', 'tree', 'violet', kind === 'right' ? `右旋 ${oldRoot.key}` : `左旋 ${oldRoot.key}`, [`${newRoot.key} 升上来`, `${oldRoot.key} 降下去`], [ops(), 'WRITE', `${kind === 'right' ? '右旋' : '左旋'}：写 3 个指针，${newRoot.key} 成为这棵子树的根，${oldRoot.key} 成为它的${kind === 'right' ? '右' : '左'}子节点`, 24],
        wire('旋转之后的两个节点', 'mem', 'abi', nodeBytes(newRoot, 'green'), nodeBytes(oldRoot, 'violet')), { ds: { tree: [shown] }, toAt: graphAim(shown, String(newRoot.key)) }));
    },
  };

  const insertKey = (key: number) => {
    const wasEmpty = tree.root === null;
    logs.push({ key, path: [], broken: null, rotations: [] });
    tree.insert(key, hooks);
    if (wasEmpty) {
      const shown = prim({ [key]: 'green' });
      bucket.push(pk('prog', 'tree', 'green', `root = ${short(tree.root!.addr)}`, [`节点 ${key}`], [ops(), 'WRITE', `树是空的，${key} 成为根`, 8],
        wire('根节点', 'mem', 'abi', nodeBytes(tree.root!)), { ds: { tree: [shown] }, toAt: graphAim(shown, String(key)) }));
    }
    // 回溯完成，路径上的高度都更新了。
    bucket.push({ type: 'ds', frame: { tree: [prim()] } });
  };

  const orders: number[][] = [];
  PHASES.forEach(([from, to], index) => {
    bucket = steps[index];
    KEYS.slice(from, to).forEach(insertKey);
    orders.push(tree.preorder());
  });
  const [, afterLL, afterRR, finalKeys] = orders;
  const settled = prim();
  bucket = steps[4];
  const root = tree.root!;
  bucket.push(pk('prog', 'tree', 'green', '树高', [`height = ${root.height}`], [ops(), 'READ', `根 ${root.key} 的 height = ${root.height}，${finalKeys.length} 个节点`, 24],
    wire('根节点', 'mem', 'abi', nodeBytes(root, 'green')), { ds: { tree: [prim({ [root.key]: 'green' })] }, toAt: graphAim(settled, String(root.key)) }));
  bucket.push(render);

  return { steps, tree, afterLL, afterRR, finalKeys, logs };
}

const { steps, tree: built, afterLL, afterRR, finalKeys, logs } = build();
export const avlRun = { logs, afterLL, afterRR, finalKeys };
const rootNode = built.root!;
const sequential = new AvlTree();
for (let key = 1; key <= ORDERED; key++) sequential.insert(key);
const phaseLast = (index: number) => logs[PHASES[index][1] - 1];
const single = phaseLast(1);
const mirror = phaseLast(2);
const double = phaseLast(3);
const rotationName = (kind: RotationKind) => (kind === 'right' ? '右旋' : '左旋');
const childName = (kind: RotationKind) => (kind === 'right' ? '右' : '左');
const phaseKeys = (index: number) => KEYS.slice(...PHASES[index]);
const shapes = new Set(logs.flatMap((log) => (log.broken ? [log.broken.shape] : [])));
const signedOf = (value: number) => (value > 0 ? `+${value}` : String(value));

export const avl: Lesson = {
  id: 'avl',
  name: 'AVL TREE',
  title: '平衡树',
  group: 'tree',
  layer: [2, 2],
  complexity: { best: 'O(log n)，插入要走到叶子再回溯', worst: 'O(log n)，树高不超过约 1.44 log₂ n', note: '查找最好时第一次就命中根，是 O(1)。这里按插入来算。' },
  opsUnit: '比较次数 + 旋转次数',
  nodes: ['prog', 'tree', 'alloc'],
  place: { prog: [130, 470], tree: [560, 90], alloc: [880, 540] },
  labels: {
    prog: ['程序', 'avl_insert'],
    tree: ['AVL 树', `struct avl_node，${AVL_LAYOUT.size} 字节`],
    alloc: ['分配器', 'glibc malloc'],
  },
  labelAt: { tree: [-200, 40] },
  radius: { tree: 60 },
  initial: { tree: [{ kind: 'graph', id: 't', nodes: [{ id: 'root', x: 0, y: 0, v: 'NULL', tone: 'dim' }], edges: [], r: 24 }] },
  start: ['prog', 'tree'],
  legend: [['blue', '比较'], ['violet', '分配或旋转'], ['amber', '失衡'], ['green', '接入'], [null, '操作数：比较 + 旋转']],
  overview: {
    full: '插入后立刻旋转，始终保持树矮',
    description: `普通二叉搜索树如果按顺序插入，会退化成一条链表，查找变成 O(n)。AVL 树给每个节点记住高度，只要左右子树高度差超过 1 就立刻旋转修复。这一课真实插入 ${KEYS.length} 个键，触发 ${shapes.size} 种失衡，每个节点下面写着高度和平衡因子。`,
    facts: [
      ['发明', 'Adelson-Velsky 和 Landis，1962 年'],
      ['平衡条件', '左右子树高度差不超过 1'],
      ['树高上界', '约 1.44 log₂ n'],
      ['struct avl_node', `${AVL_LAYOUT.size} 字节，没有填充`],
      ['旋转', '只写 3 个指针'],
      ['操作数', '比较 + 旋转'],
    ],
  },
  steps: [
    {
      title: '普通插入',
      desc: '先按二叉搜索树的规则走',
      detail: `比当前节点小就往左，否则往右，走到空位就接上新节点。节点下面的标注是高度和平衡因子，平衡因子等于左子树高度减右子树高度。两个 int 正好填满前 ${AVL_LAYOUT.fields[2].offset} 字节，两个指针紧随其后，所以这个结构没有填充。`,
      facts: AVL_LAYOUT.fields.map((field): [string, string] => [`${field.name} 偏移`, String(field.offset)]),
      events: [type(`./avl ${KEYS.join(' ')}`), show('alloc'), ...steps[0]],
    },
    {
      title: `${single.broken!.shape} 型：${rotationName(single.rotations[0].kind)}`,
      desc: `插入 ${phaseKeys(1).join('、')}，左边太重`,
      detail: `${single.key} 插到左孩子的左边后，回溯时发现 ${single.broken!.node} 的左高 ${single.broken!.left}、右高 ${single.broken!.right}，差 ${signedOf(single.broken!.balance)}。这是 ${single.broken!.shape} 型，对 ${single.rotations[0].oldRoot} 做一次${rotationName(single.rotations[0].kind)}：${single.rotations[0].newRoot} 升上来当这棵子树的根，${single.rotations[0].oldRoot} 降为它的${childName(single.rotations[0].kind)}孩子。键的中序顺序完全没变，所以仍然是合法的搜索树。结果的前序是 ${afterLL.join(' ')}。`,
      facts: [['失衡节点', String(single.broken!.node)], ['平衡因子', signedOf(single.broken!.balance)], ['修复', `${single.rotations.length} 次${rotationName(single.rotations[0].kind)}`], ['前序', afterLL.join(' ')]],
      events: steps[1],
    },
    {
      title: `${mirror.broken!.shape} 型：${rotationName(mirror.rotations[0].kind)}`,
      desc: `插入 ${phaseKeys(2).join('、')}，右边太重`,
      detail: `插入 ${mirror.key} 后，节点 ${mirror.broken!.node} 的右高 ${mirror.broken!.right}、左高 ${mirror.broken!.left}。新键落在右孩子的右边，这是 ${mirror.broken!.shape} 型，和上一步对称，对 ${mirror.rotations[0].oldRoot} 做一次${rotationName(mirror.rotations[0].kind)}，${mirror.rotations[0].newRoot} 升上来。只有最低的失衡节点需要旋转，旋转后这棵子树的高度恢复到插入前，上面的祖先不再失衡。前序变成 ${afterRR.join(' ')}。`,
      facts: [['失衡节点', String(mirror.broken!.node)], ['平衡因子', signedOf(mirror.broken!.balance)], ['修复', `${mirror.rotations.length} 次${rotationName(mirror.rotations[0].kind)}`], ['前序', afterRR.join(' ')]],
      events: steps[2],
    },
    {
      title: `${double.broken!.shape} 型：双旋`,
      desc: `插入 ${double.key}，一次旋转不够`,
      detail: `${double.key} ${double.path.map((item) => `比 ${item.node} ${item.left ? '小' : '大'}`).join('、')}，落在根的右孩子的左边，这是 ${double.broken!.shape} 型。如果只左旋一次，${double.key} 所在的子树会被带过去，树还是不平衡。所以先对右孩子 ${double.rotations[0].oldRoot} ${rotationName(double.rotations[0].kind)}，把形状变成 RR 型，再对根 ${double.rotations[1].oldRoot} ${rotationName(double.rotations[1].kind)}，${double.rotations[1].newRoot} 升为新的根。这次插入旋转了 ${double.rotations.length} 次。`,
      facts: [['失衡节点', String(double.broken!.node)], ['修复', `先${rotationName(double.rotations[0].kind)} ${double.rotations[0].oldRoot}，再${rotationName(double.rotations[1].kind)} ${double.rotations[1].oldRoot}`], ['新根', String(rootNode.key)], ['前序', finalKeys.join(' ')]],
      events: steps[3],
    },
    {
      title: '检查结果',
      desc: `${finalKeys.length} 个节点，高度 ${rootNode.height}`,
      detail: `按代码统计，${KEYS.length} 次插入一共比较 ${built.cmp} 次，旋转 ${built.rotations} 次。所有节点的平衡因子都在 -1 到 +1 之间。再拿 1 到 ${ORDERED} 有序插入对比：不旋转的搜索树退化成链，高度是 ${ORDERED}；同一份代码的 AVL 树高度只有 ${sequential.root!.height}。`,
      facts: [['比较', String(built.cmp)], ['旋转', String(built.rotations)], ['树高', String(rootNode.height)], [`有序插入 1–${ORDERED}`, `高度 ${sequential.root!.height}`]],
      events: steps[4],
    },
  ],
  outro: {
    title: '用一点写入换稳定的查找',
    desc: '树高受控，所有操作都是 O(log n)',
    text: 'AVL 树是最早被提出的自平衡二叉搜索树。它比红黑树平衡得更严格，查找略快，插入删除可能多做一些旋转。旋转只改指针，不搬动节点内容，所以节点的地址始终不变，外部持有的指针仍然有效。',
    facts: [['查找插入删除', 'O(log n)'], ['额外空间', '每个节点多一个 height'], ['下一课', 'UNION-FIND']],
  },
};
