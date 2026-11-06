/**
 * 文案和算法结果对得上。
 * 课程文案里的数字尽量从算法结果取值，这里核对两类东西：
 * 1. 取值之后的文字是否还等于手算结果（防止取错字段）；
 * 2. 文字里没法取值的说法，比如「它在链表末尾」「绕回开头」「属于 RL 型」。
 *    这些说法依赖输入。改了课程的输入，这里会报错，提醒同时改写文案。
 */
import { describe, expect, it } from 'vitest';
import { LESSON_BY_ID } from '../src/lessons';
import { avlRun, KEYS as AVL_KEYS } from '../src/lessons/avl';
import { ARR, HIT_TARGET, MISS_TARGET, searchRun } from '../src/lessons/binarysearch';
import { bfsRun, EDGES as BFS_EDGES, N as BFS_N } from '../src/lessons/bfs';
import { dijkstraRun, EDGES as WEIGHTED, N as DIJKSTRA_N } from '../src/lessons/dijkstra';
import { pushLog, VALUES } from '../src/lessons/dynarray';
import { fnv1a32, hashRun, KEYS as HASH_KEYS, SIZE } from '../src/lessons/hashtable';
import { BUILD, heapRun, PUSHED } from '../src/lessons/heap';
import { kmpRun, naiveCompares, PATTERN, TEXT } from '../src/lessons/kmp';
import { lcsRun, X, Y } from '../src/lessons/lcs';
import { FIND_TARGET, listRun, PUSHES } from '../src/lessons/linkedlist';
import { INPUT as MERGE_INPUT, mergeSort } from '../src/lessons/mergesort';
import { INPUT as QUICK_INPUT, quickSort } from '../src/lessons/quicksort';
import { CAP, ringRun } from '../src/lessons/ringqueue';
import { SECOND_PAIRS, ufRun, FIRST_PAIRS, QUERY } from '../src/lessons/unionfind';
import { countQueens, N as QUEENS_N, queensRun } from '../src/lessons/backtrack';
import { Bst, bstRun, HIT, KEYS as BST_KEYS, MISS, REMOVALS } from '../src/lessons/bst';
import { ARCS, dfsRun, N as DFS_N } from '../src/lessons/dfs';
import { EDGES as MST_EDGES, mstRun, N as MST_N } from '../src/lessons/mst';
import { INPUT as RADIX_INPUT, radixRun } from '../src/lessons/radixsort';
import { calcRun, EXPR, PREC } from '../src/lessons/stack';
import { chunkSize } from '../src/decode/structures';

const factsOf = (id: string, step: number) => Object.fromEntries(LESSON_BY_ID[id].steps[step].facts);
const stepOf = (id: string, step: number) => LESSON_BY_ID[id].steps[step];

describe('动态数组', () => {
  const [first, ...rest] = pushLog;

  it('手算结果', () => {
    expect(stepOf('dynarray', 1).desc).toContain('1 → 2 → 4');
    expect(factsOf('dynarray', 1).本步写入).toBe('2 次 push + 3 次拷贝');
    expect(factsOf('dynarray', 2)['第 5 次 push']).toBe('4 次拷贝 + 1 次写入');
    expect(factsOf('dynarray', 0).请求).toBe('malloc(4)');
    expect(stepOf('dynarray', 4).detail).toContain('1 + 2 + 4');
  });

  it('文案的说法成立', () => {
    // 「这是它的最小块」
    expect(chunkSize(first.capAfter * 4)).toBe(chunkSize(0));
    // 第 2 步「装满就翻倍」，第 3 步先有空位再装满，第 4 步「便宜的 push」
    expect(rest.slice(0, 2).every((item) => item.copies === item.capBefore && item.capAfter === item.capBefore * 2)).toBe(true);
    expect(rest[2].copies).toBe(0);
    expect(rest[3].copies).toBeGreaterThan(0);
    expect(rest.slice(4).every((item) => item.copies === 0 && item.writes === 1 && item.capAfter === item.capBefore)).toBe(true);
    // 「等比数列，总和小于最终元素数」「平均少于 3 次」
    const copies = pushLog.filter((item) => item.copies).map((item) => item.copies);
    copies.slice(1).forEach((value, index) => expect(value).toBe(copies[index] * 2));
    const total = copies.reduce((sum, value) => sum + value, 0);
    expect(total).toBeLessThan(VALUES.length);
    expect((total + VALUES.length) / VALUES.length).toBeLessThan(3);
  });
});

describe('链表', () => {
  it('手算结果', () => {
    expect(stepOf('linkedlist', 0).detail).toContain('依次插入 30、20、10');
    expect(factsOf('linkedlist', 0)['next 偏移']).toBe('8，前面填充 4 字节');
    expect(factsOf('linkedlist', 2).写指针).toBe('2 个');
    expect(factsOf('linkedlist', 3).写指针).toBe('1 个');
    expect(stepOf('linkedlist', 4).desc).toContain('32 字节');
  });

  it('文案的说法成立', () => {
    // 「它在链表末尾」：第一个插入的节点在尾部，比较次数等于节点数。
    expect(listRun.foundAtTail).toBe(true);
    expect(FIND_TARGET).toBe(PUSHES[0]);
    expect(listRun.findCmp).toBe(PUSHES.length);
  });
});

describe('栈', () => {
  const [inParens, byMinus, ...atEnd] = calcRun.applied;
  const peeksFor = (incoming: string) => calcRun.peeks.filter((item) => item.incoming === incoming);

  it('手算结果', () => {
    expect(factsOf('stack', 1)).toMatchObject({ 数字栈: '2 3 4', 运算符栈: '* ( +' });
    expect(stepOf('stack', 2).desc).toBe('3 + 4 = 7，括号消失');
    expect(stepOf('stack', 2).detail).toContain('这里弹出 4 和 3，再弹出 \'+\'，算出 7');
    expect(factsOf('stack', 2)).toMatchObject({ 数字栈: '2 7', 运算符栈: '*' });
    expect(factsOf('stack', 3)).toMatchObject({ 计算: '2 * 7 = 14', 数字栈: '14 6 2', 运算符栈: '- /' });
    expect(stepOf('stack', 4).detail).toContain('6 / 2 = 3，然后 14 - 3 = 11');
    expect(factsOf('stack', 4)).toMatchObject({ 结果: '11', 入栈: '14 次', 出栈: '14 次', 看栈顶: '5 次' });
    expect(stepOf('stack', 0).detail).toContain('struct stack 一共 16 字节：data 指针在 +0，top 在 +8，cap 在 +12');
  });

  it('文案的说法成立', () => {
    // 「'+' 进栈前看了一眼栈顶，是左括号，就不往下算」
    expect(peeksFor('+')).toEqual([{ top: '(', incoming: '+', reduce: false }]);
    // 「右括号……反复看运算符栈顶」「最后左括号出栈丢掉」
    expect(peeksFor(')').map((item) => item.reduce)).toEqual([true, false]);
    expect(inParens.by).toBe(')');
    // 「'-' 进栈前看到栈顶的 '*' 优先级更高」「'/' 进栈前看到的是 '-'，优先级比自己低」
    expect(peeksFor('-')).toEqual([{ top: '*', incoming: '-', reduce: true }]);
    expect(byMinus.by).toBe('-');
    expect(PREC['*']).toBeGreaterThan(PREC['-']);
    expect(peeksFor('/')).toEqual([{ top: '-', incoming: '/', reduce: false }]);
    // 「运算符栈里从下往上，优先级越来越高」
    const ops = calcRun.snaps[3].ops.filter((op) => op !== '(');
    ops.slice(1).forEach((op, index) => expect(PREC[op]).toBeGreaterThan(PREC[ops[index]]));
    // 「读完后……从栈顶开始把剩下的运算符依次算掉」
    expect(atEnd.map((item) => item.by)).toEqual(['结尾', '结尾']);
    expect(atEnd.map((item) => item.op)).toEqual(['/', '-']);
    // 「每个记号最多入栈出栈各一次」：数字和运算符各入栈一次，运算结果再入栈一次。
    const tokens = EXPR.match(/\d+|[-+*/()]/g)!;
    expect(calcRun.result.pushes).toBe(tokens.filter((token) => token !== ')').length + calcRun.applied.length);
    expect(calcRun.result.value).toBe(11);
  });
});

describe('环形队列', () => {
  it('手算结果', () => {
    expect(factsOf('ringqueue', 1).tail).toBe('6');
    expect(factsOf('ringqueue', 2).读到).toBe('11, 22, 33');
    expect(factsOf('ringqueue', 3).tail).toBe('11');
    expect(stepOf('ringqueue', 3).detail).toContain('11 & 7 = 3');
  });

  it('文案的说法成立', () => {
    // 「写入位置绕回了数组开头」「tail 追上 head，入队失败」
    expect(ringRun.wrapped.tail).toBeGreaterThan(CAP);
    expect(ringRun.wrapped.tail - ringRun.wrapped.head).toBe(CAP);
    expect(ringRun.wrapped.head % CAP).toBe(ringRun.wrapped.tail % CAP);
    expect(ringRun.accepted).toBe(false);
  });
});

describe('哈希表', () => {
  const home = (key: string) => fnv1a32(key) & (SIZE - 1);

  it('手算结果：reference.c 的低 3 位推出来的下标', () => {
    expect(stepOf('hashtable', 0).desc).toContain('下标 7');
    expect(stepOf('hashtable', 2).desc).toBe('"fig" 也算到 5，往后走 1 格');
    expect(stepOf('hashtable', 3).detail).toContain('"mango" 也算到 5，这时 5、6、7 都被占了，只好走到末尾再绕回 0');
    expect(factsOf('hashtable', 3).当前负载).toBe('6 / 8 = 75%');
    expect(factsOf('hashtable', 5)['slot[6].state']).toBe('2（墓碑）');
  });

  it('文案的说法成立', () => {
    // 「直接落位」
    expect([hashRun.apple.probes, hashRun.pear.probes, hashRun.plum.probes]).toEqual([1, 1, 1]);
    // 「低 3 位和 pear 相同」「往后走」
    expect(home(HASH_KEYS.collide)).toBe(home(HASH_KEYS.direct[0]));
    expect(hashRun.fig.probes).toBeGreaterThan(1);
    // 「也算到」「绕回开头」
    expect(home(HASH_KEYS.wrap)).toBe(home(HASH_KEYS.collide));
    expect(hashRun.mango.index).toBeLessThan(home(HASH_KEYS.wrap));
    // 「起始槽是空的，1 次就能确定不存在」
    expect(hashRun.miss).toMatchObject({ index: -1, probes: 1 });
    // 「删了 fig 再查 mango，路线经过墓碑，仍然同样的探测次数」
    const path = Array.from({ length: hashRun.mango.probes }, (_, step) => (fnv1a32(HASH_KEYS.wrap) + step) & (SIZE - 1));
    expect(path).toContain(hashRun.fig.index);
    expect(hashRun.again.probes).toBe(hashRun.hit.probes);
  });
});

describe('二分查找', () => {
  it('手算结果', () => {
    expect(factsOf('binarysearch', 1)).toMatchObject({ mid: '6', 'a[mid]': '31', 排除: '7 个元素', 剩余: '5 个' });
    expect(factsOf('binarysearch', 2).比较次数).toBe('3');
  });

  it('文案的说法成立', () => {
    // 「比目标小」「命中」「不存在」「这也是最坏情况」
    expect(searchRun.first.value).toBeLessThan(HIT_TARGET);
    expect(ARR).toContain(HIT_TARGET);
    expect(ARR).not.toContain(MISS_TARGET);
    expect(searchRun.miss.probes).toBe(Math.floor(Math.log2(ARR.length)) + 1);
  });
});

describe('二叉搜索树', () => {
  const [hit, miss] = bstRun.finds;
  const [leaf, single, double] = bstRun.removals;
  const built = () => {
    const tree = new Bst();
    BST_KEYS.forEach((key) => tree.insert(key));
    return tree;
  };

  it('手算结果', () => {
    expect(stepOf('bst', 0).detail).toContain('key 后面有 4 字节填充，整个节点 24 字节');
    expect(stepOf('bst', 0).detail).toContain('8 次插入一共比较 13 次，树高 4');
    expect(factsOf('bst', 1)).toMatchObject({ '找 65': '50 → 70 → 60 → 65', '找 45': '50 → 30 → 40 → NULL' });
    expect(stepOf('bst', 2).desc).toBe('20 没有孩子，直接摘下');
    expect(stepOf('bst', 2).detail).toContain('父节点 30');
    expect(stepOf('bst', 3).desc).toBe('30 只剩一个孩子，让孩子顶上来');
    expect(stepOf('bst', 4).desc).toBe('用后继 60 顶替 50');
    expect(stepOf('bst', 4).detail).toContain('这里 60 的右孩子 65 接到 70 的 left 上');
    expect(LESSON_BY_ID.bst.outro.facts).toContainEqual(['有序插入树高', '8']);
  });

  it('文案的说法成立', () => {
    const tree = built();
    const node = (key: number) => {
      let at = tree.root;
      while (at && at.key !== key) at = key < at.key ? at.left : at.right;
      return at!;
    };
    expect([HIT, MISS]).toEqual([hit.key, miss.key]);
    expect(miss.found).toBe(false);
    // 「比较次数最多等于树高」
    expect(hit.path.length).toBeLessThanOrEqual(bstRun.built.height);
    // 删除的三种情况：叶子、删掉叶子后只剩右孩子、两个孩子
    expect(REMOVALS).toEqual([leaf.key, single.key, double.key]);
    expect([node(leaf.key).left, node(leaf.key).right]).toEqual([null, null]);
    tree.remove(leaf.key);
    expect(node(single.key).left).toBeNull();
    expect(node(single.key).right).not.toBeNull();
    // 「孩子整棵子树都比父节点小」：30 是 50 的左孩子
    expect(single.path[single.path.length - 2]).toBeGreaterThan(single.key);
    tree.remove(single.key);
    const target = node(double.key);
    expect(target.left && target.right).toBeTruthy();
    // 「后继……没有左孩子」「进右子树后一直往左」
    let successor = target.right!;
    while (successor.left) successor = successor.left;
    expect(successor.key).toBe(double.successor);
    expect(successor.right?.key).toBe(double.relink!.target);
    expect(double.key).toBe(BST_KEYS[0]);
    // 「中序仍然有序」
    expect(bstRun.inorder).toEqual([...bstRun.inorder].sort((a, b) => a - b));
  });
});

describe('二叉堆', () => {
  it('手算结果', () => {
    expect(factsOf('heap', 0).数组).toBe('1 4 5 9 8 7');
    expect(factsOf('heap', 1)).toMatchObject({ 写入下标: '6', 父节点下标: '2' });
    expect(factsOf('heap', 2).结果).toBe('0 4 1 9 8 7 5');
    expect(factsOf('heap', 4).结果).toBe('1 4 5 9 8 7');
  });

  it('文案的说法成立', () => {
    // 动画用值当身份，所以值不能重复。
    expect(new Set([...BUILD, PUSHED]).size).toBe(BUILD.length + 1);
    // 「比路径上所有元素都小，一路走到了根」
    expect(heapRun.pushed[0]).toBe(PUSHED);
    expect(PUSHED).toBeLessThan(Math.min(...BUILD));
    expect(heapRun.popped).toBe(PUSHED);
  });
});

describe('AVL 树', () => {
  const broken = avlRun.logs.filter((log) => log.broken);

  it('手算结果', () => {
    expect(stepOf('avl', 1).title).toBe('LL 型：右旋');
    expect(stepOf('avl', 1).detail).toContain('30 的左高 2、右高 0，差 +2');
    expect(stepOf('avl', 2).title).toBe('RR 型：左旋');
    expect(stepOf('avl', 2).detail).toContain('节点 30 的右高 2、左高 0');
    expect(stepOf('avl', 3).title).toBe('RL 型：双旋');
    expect(stepOf('avl', 3).detail).toContain('25 比 20 大、比 40 小、比 30 小');
    expect(factsOf('avl', 3).修复).toBe('先右旋 40，再左旋 20');
  });

  it('文案的说法成立', () => {
    expect(AVL_KEYS.length).toBe(avlRun.logs.length);
    // 每个失衡步骤正好一次，按 LL、RR、RL 的顺序。
    expect(broken.map((log) => log.broken!.shape)).toEqual(['LL', 'RR', 'RL']);
    // 「左边太重」「右边太重」
    expect(broken[0].broken!.balance).toBeGreaterThan(0);
    expect(broken[1].broken!.balance).toBeLessThan(0);
    // 「一次旋转」「旋转了 2 次」「新键落在根的右孩子的左边」「新的根」
    expect(broken.map((log) => log.rotations.length)).toEqual([1, 1, 2]);
    expect(broken[2].path.map((item) => item.left)).toEqual([false, true, true]);
    expect(broken[2].broken!.node).toBe(broken[2].path[0].node);
    expect(avlRun.finalKeys[0]).toBe(broken[2].rotations[1].newRoot);
  });
});

describe('并查集', () => {
  it('手算结果', () => {
    expect(stepOf('unionfind', 3).detail).toContain('7 → 6 → 4 → 0');
    expect(factsOf('unionfind', 3).根).toBe('0');
    expect(factsOf('unionfind', 3)['写 parent']).toBe('2 次');
    expect(factsOf('unionfind', 1).集合数).toBe('4');
    expect(factsOf('unionfind', 2).合并).toBe('(0,2) (4,6) (0,4)');
  });

  it('文案的说法成立', () => {
    // 「顺着 … 走到根」「第二次因为已经直接挂在根下」「同组」
    expect(ufRun.path[0]).toBe(QUERY);
    expect(ufRun.path[ufRun.path.length - 1]).toBe(ufRun.root);
    expect(ufRun.secondReads).toBe(2);
    expect(ufRun.rootA).toBe(ufRun.rootB);
    // 「压缩后路上的节点直接指向根」
    expect(ufRun.afterFind[QUERY]).toBe(ufRun.root);
    expect(ufRun.findWrites).toBeGreaterThan(0);
    // 第 3 步结束时已经全部连通，否则「根」不唯一。
    expect(FIRST_PAIRS.length + SECOND_PAIRS.length).toBe(7);
    expect(ufRun.beforeFind.filter((value, index) => value === index).length).toBe(1);
  });
});

describe('BFS', () => {
  const zero = bfsRun.levelOf(0);
  const one = bfsRun.levelOf(1);

  it('手算结果', () => {
    expect(factsOf('bfs', 1)).toMatchObject({ 出队: '0', 发现: '1, 2', 队列: '[1, 2]' });
    expect(factsOf('bfs', 2)).toMatchObject({ 出队: '1, 2', 发现: '3, 4' });
    expect(stepOf('bfs', 2).desc).toBe('处理 1 和 2，发现距离 2 的顶点');
    expect(stepOf('bfs', 2).detail).toContain('处理 1 时还会看到回头路 0');
    expect(stepOf('bfs', 2).detail).toContain('2 也能到 3，但 3 已被 1 发现，距离都是 2');
    expect(stepOf('bfs', 3).desc).toBe('距离 2、3、4 依次展开');
  });

  it('文案的说法成立', () => {
    expect(zero.popped.length).toBe(1);
    expect(one.back).not.toBeNull();
    expect(one.cross).not.toBeNull();
    // 「正好是边数的 2 倍」
    expect(bfsRun.result.scanned).toBe(BFS_EDGES.length * 2);
    expect(bfsRun.result.order.length).toBe(BFS_N);
  });
});

describe('DFS 拓扑排序', () => {
  const { log, result } = dfsRun;
  const outOf = (vertex: number) => ARCS.filter(([a]) => a === vertex);

  it('手算结果', () => {
    expect(stepOf('dfs', 0).desc).toBe('dfs(0) → dfs(1) → dfs(3) → dfs(4)');
    expect(factsOf('dfs', 1).完成顺序).toBe('4 → 3 → 1');
    expect(factsOf('dfs', 2).跳过的边).toBe('2 → 3，5 → 4');
    expect(factsOf('dfs', 3)).toMatchObject({ 跳过: '1, 2, 3, 4, 5', 重新出发: '6', 'order[0]': '6' });
    expect(stepOf('dfs', 4).desc).toBe('6 0 2 5 1 3 4');
  });

  it('文案的说法成立', () => {
    // 「到 4 才停下，因为它没有出边」「4 没有出边，最先完成」
    expect(outOf(log.dive[log.dive.length - 1])).toEqual([]);
    expect(result.finished[0]).toBe(log.dive[log.dive.length - 1]);
    // 「回到 0 之后看下一条出边」
    expect(outOf(log.dive[0]).length).toBeGreaterThan(1);
    // 「6 没有入边」「它的出边指向黑色顶点，马上完成」
    const restart = log.restart[0];
    expect(ARCS.some(([, b]) => b === restart)).toBe(false);
    expect(outOf(restart).every(([, b]) => result.finished.indexOf(b) < result.finished.indexOf(restart))).toBe(true);
    expect(log.restart).toEqual([restart]);
    // 「每条边都从前面的顶点指向后面的」「扫描次数正好等于边数」「没有环」
    expect(ARCS.every(([a, b]) => result.order.indexOf(a) < result.order.indexOf(b))).toBe(true);
    expect(result.scanned).toBe(ARCS.length);
    expect(result.cyclic).toBe(false);
    expect(result.order.length).toBe(DFS_N);
  });
});

describe('Dijkstra', () => {
  it('手算结果', () => {
    expect(stepOf('dijkstra', 1).desc).toContain('3 个邻居');
    expect(factsOf('dijkstra', 1)).toMatchObject({ 'dist[1]': '7', 'dist[2]': '9', 'dist[5]': '暂时 14' });
    expect(factsOf('dijkstra', 2)).toMatchObject({ '顶点 5': '14 → 11', '顶点 3': '22 → 20' });
    expect(stepOf('dijkstra', 2).detail).toContain('经过 2 再走到 5 只要 9 + 2 = 11，比之前记录的 14 短');
    expect(stepOf('dijkstra', 3).desc).toBe('旧的 (14, 5) 还在堆里');
  });

  it('文案的说法成立', () => {
    // 「边权非负」是算法前提。
    expect(WEIGHTED.every(([, , weight]) => weight >= 0)).toBe(true);
    // 过期条目就是被改小之前的那个值。
    const updates = dijkstraRun.history.get(dijkstraRun.firstStale.node)!;
    expect(updates[0].value).toBe(dijkstraRun.firstStale.dist);
    expect(updates[updates.length - 1].value).toBeLessThan(updates[0].value);
    // 「等于边数的 2 倍」「所有可达顶点」
    expect(dijkstraRun.result.relaxations).toBe(WEIGHTED.length * 2);
    expect(dijkstraRun.result.dist.length).toBe(DIJKSTRA_N);
    expect(dijkstraRun.result.stale).toBeGreaterThan(0);
  });
});

describe('最小生成树', () => {
  const taken = mstRun.logs.filter((log) => log.take);
  const rejected = mstRun.logs.filter((log) => !log.take);

  it('手算结果', () => {
    expect(factsOf('mst', 0).排序后).toBe('1 3 4 6 7 8 9 11 12');
    expect(stepOf('mst', 1).desc).toBe('3-4、4-5');
    expect(stepOf('mst', 1).detail).toContain('4 的根是 3，5 的根是 5，合并后 3 个顶点连成一组');
    expect(stepOf('mst', 2).desc).toBe('0-2、0-1');
    expect(stepOf('mst', 2).detail).toContain('一组的根是 0，另一组的根是 3');
    expect(stepOf('mst', 3).desc).toBe('1-2、3-5 两端已经连通');
    expect(stepOf('mst', 4).desc).toBe('总权 23');
    expect(stepOf('mst', 4).detail).toContain('1-3 和 2-5 根本没被检查');
  });

  it('文案的说法成立', () => {
    // 排序结果唯一，事件顺序和文案才不依赖排序算法。
    expect(new Set(MST_EDGES.map(([, , w]) => w)).size).toBe(MST_EDGES.length);
    // 「最轻的边两端各自是根」
    expect([taken[0].ru, taken[0].rv]).toEqual([taken[0].edge[0], taken[0].edge[1]]);
    // 前 4 条收下的边分成两组，第 5 条把它们连起来。
    expect(mstRun.logs.slice(0, 4).every((log) => log.take)).toBe(true);
    expect(rejected.length).toBe(2);
    expect(rejected.every((log) => log.ru === log.rv)).toBe(true);
    expect(taken[4].ru).not.toBe(taken[4].rv);
    expect(taken[4].merged).toBe(MST_N);
    // 「正好 V - 1 条边，循环提前结束」
    expect(mstRun.result.tree.length).toBe(MST_N - 1);
    expect(mstRun.result.examined).toBeLessThan(MST_EDGES.length);
  });
});

describe('快速排序', () => {
  it('手算结果', () => {
    expect(stepOf('quicksort', 1).desc).toContain('基准 4');
    expect(factsOf('quicksort', 1).比较次数).toBe('7，区间长度减 1');
    expect(stepOf('quicksort', 4).desc).toBe('共 16 次比较，7 次交换');
  });

  it('文案的说法成立', () => {
    // 第一轮比较数等于区间长度减 1
    let firstRound = 0;
    let calls = 0;
    quickSort(QUICK_INPUT, {
      call: () => void calls++,
      compare: () => {
        if (calls === 1) firstRound++;
      },
    });
    expect(firstRound).toBe(QUICK_INPUT.length - 1);
    expect(LESSON_BY_ID.quicksort.steps[1].facts).toContainEqual(['比较次数', `${firstRound}，区间长度减 1`]);
    // 「也就是 n(n-1)/2」
    const n = QUICK_INPUT.length;
    expect(quickSort(QUICK_INPUT.map((_, index) => index + 1)).cmp).toBe((n * (n - 1)) / 2);
  });
});

describe('归并排序', () => {
  it('手算结果', () => {
    expect(stepOf('mergesort', 0).desc).toBe('区间 [0, 8)，中点 4');
    expect(factsOf('mergesort', 1).层数).toBe('log₂ 8 = 3');
  });

  it('文案的说法成立', () => {
    const n = MERGE_INPUT.length;
    // 层数和「写入数正好是 2 × n × log₂ n」要求 n 是 2 的幂。
    expect(Number.isInteger(Math.log2(n))).toBe(true);
    const result = mergeSort(MERGE_INPUT);
    expect(result.writes).toBe(2 * n * Math.log2(n));
    expect(result.cmp).toBeLessThanOrEqual(n * Math.log2(n));
  });
});

describe('基数排序', () => {
  const [ones, tens, hundreds] = radixRun.logs;

  it('手算结果', () => {
    expect(factsOf('radixsort', 0).计数).toBe('2 0 2 0 1 2 1 0 0 0');
    expect(factsOf('radixsort', 1)).toMatchObject({ 起始位置: '0 2 2 4 4 5 7 8 8 8', '第 1 趟后': '170 90 802 2 24 45 75 66' });
    expect(stepOf('radixsort', 2).detail).toContain('170 和 75 的十位相同');
    expect(factsOf('radixsort', 2)['第 2 趟后']).toBe('802 2 24 45 66 170 75 90');
    expect(stepOf('radixsort', 3).desc).toBe('6 个数的百位是 0');
    expect(stepOf('radixsort', 3).detail).toContain('只有 170 和 802 的百位不是 0');
    expect(factsOf('radixsort', 4).每趟).toBe('8 + 10 + 8 + 8 = 34');
  });

  it('文案的说法成立', () => {
    // 动画用值当身份，所以值不能重复。
    expect(new Set(RADIX_INPUT).size).toBe(RADIX_INPUT.length);
    // 「170 和 75 的十位相同，先后沿用上一趟按个位排好的顺序」
    expect(ones.after.indexOf(170)).toBeLessThan(ones.after.indexOf(75));
    expect(tens.after.indexOf(170)).toBeLessThan(tens.after.indexOf(75));
    // 「末两位已经有序」
    const lastTwo = tens.after.map((value) => value % 100);
    expect(lastTwo).toEqual([...lastTwo].sort((a, b) => a - b));
    // 「最大值是三位数，所以三趟就够了」「全程没有比较」
    expect(String(Math.max(...RADIX_INPUT)).length).toBe(radixRun.result.passes);
    expect(hundreds.after).toEqual([...RADIX_INPUT].sort((a, b) => a - b));
    expect(radixRun.result.cmp).toBe(0);
  });
});

describe('LCS', () => {
  it('手算结果', () => {
    expect(factsOf('lcs', 0).答案位置).toBe('dp[5][5]');
    expect(LESSON_BY_ID.lcs.overview.facts).toContainEqual(['表格', 'int dp[6][6]，144 字节']);
    expect(stepOf('lcs', 0).detail).toContain('(i × 6 + j) × 4');
    expect(stepOf('lcs', 3).detail).toContain('正好是 5 × 5');
  });

  it('文案的说法成立', () => {
    // 「正好是 m × n」「第 1 行只在遇到 Y 里的这个字符时才会变成 1」
    expect(lcsRun.cmp).toBe(X.length * Y.length);
    expect(Y).toContain(X[0]);
    expect(lcsRun.dp[1].indexOf(1)).toBe(Y.indexOf(X[0]) + 1);
    expect(lcsRun.text.length).toBe(lcsRun.length);
  });
});

describe('回溯', () => {
  const { attempts, rets, result } = queensRun;
  const inPhase = (phase: number) => attempts.filter((item) => item.phase === phase);

  it('手算结果', () => {
    expect(stepOf('backtrack', 0).desc).toBe('(0, 0)、(1, 2) 先放下');
    expect(stepOf('backtrack', 1).desc).toBe('第 2 行 4 个位置全部冲突');
    expect(stepOf('backtrack', 2).detail).toContain('第 1 行换到 (1, 3)');
    expect(stepOf('backtrack', 3).desc).toBe('第 0 行改放 (0, 1)');
    expect(stepOf('backtrack', 4).desc).toBe('一共试了 26 个位置');
    expect(stepOf('backtrack', 4).detail).toContain('每行随便放一个要试 256 种摆法，每列只用一次也有 24 种');
    expect(LESSON_BY_ID.backtrack.overview.facts).toContainEqual(['4 皇后的解', '2 个']);
  });

  it('文案的说法成立', () => {
    // 「第 2 行的 4 个格子都被上面的皇后攻击」
    expect(inPhase(1).length).toBe(QUEENS_N);
    expect(inPhase(1).every((item) => item.conflict !== null)).toBe(true);
    // 「这次多走了一行，最后还是没有位置」
    expect(inPhase(2).some((item) => item.row === 3)).toBe(true);
    // 「第 0 行放在第 0 列根本没有解」：把后面几行的摆法全部枚举一遍。
    const valid = (q: number[]) => q.every((a, i) => q.every((b, j) => i === j || (a !== b && Math.abs(a - b) !== Math.abs(i - j))));
    let withZero = 0;
    for (let code = 0; code < QUEENS_N ** (QUEENS_N - 1); code++) {
      const rest = Array.from({ length: QUEENS_N - 1 }, (_, k) => Math.floor(code / QUEENS_N ** k) % QUEENS_N);
      if (valid([0, ...rest])) withZero++;
    }
    expect(withZero).toBe(0);
    expect(countQueens(QUEENS_N).solutions).toBe(2);
    expect(rets.filter((item) => item.phase === 2 && !item.ok).map((item) => item.row)).toContain(1);
    expect(result.solution![0]).not.toBe(0);
    // 「接下来每一行都很快找到了位置」：这一步没有回溯。
    expect(rets.filter((item) => item.phase === 3 && !item.ok)).toEqual([]);
    expect(rets.filter((item) => item.ok).length).toBe(QUEENS_N + 1);
  });
});

describe('KMP', () => {
  it('手算结果', () => {
    expect(stepOf('kmp', 0).detail).toContain('比如 ABAB 的前缀 AB 和后缀 AB 相同，所以 lps[3] = 2');
    expect(factsOf('kmp', 1)).toMatchObject({ 已匹配: 'ABAB', 失配字符: 'D 和 C', i: '4' });
    expect(factsOf('kmp', 2)).toMatchObject({ j: '4 → 2', 模式串右移: '2 格' });
    expect(stepOf('kmp', 1).detail).toContain('把 i 退回 1');
  });

  it('文案的说法成立', () => {
    const { firstJump, lps, searched } = kmpRun;
    // 「后缀同时也是模式串的前缀」要求第一次失配时确实有重合。
    expect(firstJump.next).toBeGreaterThan(0);
    const matched = PATTERN.slice(0, firstJump.j);
    expect(matched.endsWith(PATTERN.slice(0, firstJump.next))).toBe(true);
    // 例子里的前缀确实也是后缀
    const at = lps.indexOf(Math.max(...lps));
    expect(PATTERN.slice(0, at + 1).endsWith(PATTERN.slice(0, lps[at]))).toBe(true);
    // 「找到匹配」「比暴力省」「最多约 2n」
    expect(searched.matches.length).toBeGreaterThan(0);
    expect(searched.cmp).toBeLessThan(naiveCompares(TEXT, PATTERN));
    expect(searched.cmp).toBeLessThanOrEqual(2 * TEXT.length);
  });
});
