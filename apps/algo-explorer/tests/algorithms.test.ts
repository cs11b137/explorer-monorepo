/**
 * 算法的独立验证。期望值有三个来源，都不是被测代码算出来的：
 * 1. 标准或公开的测试向量（FNV-1a、CLRS 的 LCS 例子、常见的 KMP 失配表）；
 * 2. tests/reference/reference.c 的输出，那是一份不共享代码的 C 实现；
 * 3. 测试里用另一种算法现算（数组内置排序、暴力枚举、Bellman-Ford 等）。
 */
import { describe, expect, it } from 'vitest';
import { LESSON_BY_ID } from '../src/lessons';
import { AvlTree, balanceOf, type AvlNode } from '../src/lessons/avl';
import { binarySearch } from '../src/lessons/binarysearch';
import { adjacency, bfs, type Edge } from '../src/lessons/bfs';
import { dijkstra, INT_MAX, type WeightedEdge } from '../src/lessons/dijkstra';
import { vecNew, vecPush } from '../src/lessons/dynarray';
import { FNV_OFFSET, FNV_PRIME, fnv1a32, HashTable } from '../src/lessons/hashtable';
import { MinHeap } from '../src/lessons/heap';
import { buildLps, kmpSearch, naiveCompares } from '../src/lessons/kmp';
import { lcs, naiveLcsCalls } from '../src/lessons/lcs';
import { List } from '../src/lessons/linkedlist';
import { mergeSort } from '../src/lessons/mergesort';
import { quickSort } from '../src/lessons/quicksort';
import { Ring } from '../src/lessons/ringqueue';
import { packetsOf } from '../src/lessons/types';
import { UnionFind } from '../src/lessons/unionfind';

/** 固定种子的线性同余，让随机测试可重复。 */
function rng(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

const lastOps = (id: string) => {
  const packets = packetsOf(LESSON_BY_ID[id]);
  return packets[packets.length - 1].row.ops;
};

describe('FNV-1a', () => {
  it('参数和官方一致', () => {
    expect(FNV_OFFSET).toBe(2166136261);
    expect(FNV_PRIME).toBe(16777619);
  });

  it('draft-eastlake-fnv 附录的标准向量', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('官方页面列出的零哈希输入', () => {
    expect(fnv1a32(String.fromCharCode(0xcc, 0x24, 0x31, 0xc4))).toBe(0);
    expect(fnv1a32(String.fromCharCode(0xe0, 0x4d, 0x9f, 0xcb))).toBe(0);
  });

  it('reference.c 算出的课程用键', () => {
    expect(fnv1a32('apple')).toBe(0x10bc2abf);
    expect(fnv1a32('pear')).toBe(0xd01fc26d);
    expect(fnv1a32('plum')).toBe(0xb6adb06b);
    expect(fnv1a32('fig')).toBe(0xc1e49a15);
    expect(fnv1a32('kiwi')).toBe(0xbffdf499);
    expect(fnv1a32('mango')).toBe(0x0e74ffd5);
    expect(fnv1a32('lime')).toBe(0x07e34bbc);
  });
});

describe('开放寻址哈希表', () => {
  const build = () => {
    const table = new HashTable(8);
    const placed = [['apple', 1], ['pear', 2], ['plum', 3], ['fig', 4], ['kiwi', 5], ['mango', 6]].map(([key, value]) => table.insert(key as string, value as number));
    return { table, placed };
  };

  it('下标由哈希的低 3 位决定，冲突时线性探测并回绕', () => {
    const { placed } = build();
    // 手工按低 3 位推：7, 5, 3, 5→6, 1, 5→6→7→0。
    expect(placed.map((item) => item.index)).toEqual([7, 5, 3, 6, 1, 0]);
    expect(placed.map((item) => item.probes)).toEqual([1, 1, 1, 2, 1, 4]);
  });

  it('查找：命中、不存在', () => {
    const { table } = build();
    expect(table.find('mango')).toMatchObject({ index: 0, probes: 4 });
    expect(table.find('lime')).toMatchObject({ index: -1, probes: 1 });
    expect(table.find('apple')).toMatchObject({ index: 7, probes: 1 });
  });

  it('删除留墓碑：越过墓碑仍能找到后面的键', () => {
    const { table } = build();
    expect(table.remove('fig')).toBe(true);
    expect(table.slots[6].state).toBe('tomb');
    expect(table.find('fig').index).toBe(-1);
    expect(table.find('mango')).toMatchObject({ index: 0, probes: 4 });
  });

  it('插入复用墓碑，重复键只更新值', () => {
    const { table } = build();
    table.remove('fig');
    expect(table.insert('fig', 9).index).toBe(6);
    expect(table.insert('pear', 20).index).toBe(5);
    expect(table.slots[5].value).toBe(20);
    expect(table.slots.filter((slot) => slot.state === 'full').length).toBe(6);
  });

  it('和 Map 对照随机操作', () => {
    const next = rng(7);
    const table = new HashTable(64);
    const truth = new Map<string, number>();
    for (let round = 0; round < 400; round++) {
      const key = `k${next(30)}`;
      if (next(3) === 0) {
        expect(table.remove(key)).toBe(truth.delete(key));
      } else if (truth.size < 40 || truth.has(key)) {
        table.insert(key, round);
        truth.set(key, round);
      }
      const probe = `k${next(30)}`;
      const found = table.find(probe);
      expect(found.index >= 0).toBe(truth.has(probe));
      if (found.index >= 0) expect(table.slots[found.index].value).toBe(truth.get(probe));
    }
  });

  it('课程的操作数等于代码统计值', () => {
    // 手算：键字节 42 + 探测槽 21 + 比较键 13 + 写槽 7。
    const table = new HashTable(8);
    [['apple', 1], ['pear', 2], ['plum', 3], ['fig', 4], ['kiwi', 5], ['mango', 6]].forEach(([key, value]) => table.insert(key as string, value as number));
    table.find('mango');
    table.find('lime');
    table.remove('fig');
    table.find('mango');
    expect([table.bytes, table.probes, table.cmp, table.writes]).toEqual([42, 21, 13, 7]);
    expect(lastOps('hashtable')).toBe(83);
  });
});

describe('动态数组', () => {
  it('8 次 push：4 次扩容，7 次拷贝，15 次写入', () => {
    const vec = vecNew();
    [7, 3, 9, 1, 4, 8, 2, 6].forEach((value) => vecPush(vec, value));
    expect(vec.data).toEqual([7, 3, 9, 1, 4, 8, 2, 6]);
    expect([vec.len, vec.cap, vec.grows, vec.copies, vec.writes]).toEqual([8, 8, 4, 7, 15]);
    expect(lastOps('dynarray')).toBe(15);
  });

  it('摊还上界：n 次 push 写入少于 3n 次', () => {
    for (const n of [1, 2, 3, 7, 8, 9, 100, 1025]) {
      const vec = vecNew();
      for (let index = 0; index < n; index++) vecPush(vec, index);
      expect(vec.writes).toBeLessThan(3 * n);
      expect(vec.data.slice(0, n)).toEqual(Array.from({ length: n }, (_, index) => index));
    }
  });
});

describe('链表', () => {
  it('课程里的操作序列：手算比较和写入次数', () => {
    const list = new List();
    [30, 20, 10].forEach((value) => list.pushFront(value));
    expect(list.values()).toEqual([10, 20, 30]);
    expect(list.writes).toBe(6);
    list.find(30);
    expect(list.cmp).toBe(3);
    list.insertAfter(list.head!.next!, 25);
    expect(list.values()).toEqual([10, 20, 25, 30]);
    list.remove(20);
    expect(list.values()).toEqual([10, 25, 30]);
    expect(list.cmp).toBe(5);
    expect(list.writes).toBe(9);
    expect(lastOps('linkedlist')).toBe(14);
  });

  it('删除头节点和不存在的值', () => {
    const list = new List();
    [2, 1].forEach((value) => list.pushFront(value));
    expect(list.remove(1)?.val).toBe(1);
    expect(list.values()).toEqual([2]);
    expect(list.remove(9)).toBeNull();
  });

  it('节点地址按 glibc 块大小递增，16 字节节点占 32 字节', () => {
    const list = new List();
    const a = list.pushFront(1);
    const b = list.pushFront(2);
    expect(b.addr - a.addr).toBe(32n);
  });
});

describe('环形队列', () => {
  it('先进先出、回绕、判满', () => {
    const ring = new Ring(8);
    [11, 22, 33, 44, 55, 66].forEach((value) => expect(ring.enqueue(value)).toBe(true));
    expect([ring.dequeue(), ring.dequeue(), ring.dequeue()]).toEqual([11, 22, 33]);
    [77, 88, 99, 100, 110].forEach((value) => expect(ring.enqueue(value)).toBe(true));
    expect(ring.head).toBe(3);
    expect(ring.tail).toBe(11);
    expect(ring.index(ring.tail)).toBe(3);
    expect(ring.enqueue(120)).toBe(false);
    expect(ring.dequeue()).toBe(44);
    expect(ring.reads + ring.writes).toBe(15);
    expect(lastOps('ringqueue')).toBe(15);
  });

  it('出队不清零，值还留在缓冲区', () => {
    const ring = new Ring(4);
    ring.enqueue(5);
    ring.dequeue();
    expect(ring.buf[0]).toBe(5);
    expect(ring.dequeue()).toBeNull();
  });

  it('计数器越过 2³² 时仍然正确', () => {
    const ring = new Ring(4);
    ring.head = 0xfffffffe;
    ring.tail = 0xfffffffe;
    [1, 2, 3, 4].forEach((value) => expect(ring.enqueue(value)).toBe(true));
    expect(ring.tail).toBe(2);
    expect(ring.count).toBe(4);
    expect(ring.enqueue(5)).toBe(false);
    expect([ring.dequeue(), ring.dequeue(), ring.dequeue(), ring.dequeue()]).toEqual([1, 2, 3, 4]);
  });

  it('容量不是 2 的幂时拒绝', () => {
    expect(() => new Ring(6)).toThrow();
  });
});

describe('二分查找', () => {
  const ARR = [3, 8, 12, 17, 21, 26, 31, 38, 44, 52, 60, 71];

  it('reference.c 的结果：44 比较 3 次，40 比较 4 次', () => {
    expect(binarySearch(ARR, 44)).toEqual({ index: 8, probes: 3 });
    expect(binarySearch(ARR, 40)).toEqual({ index: -1, probes: 4 });
    expect(lastOps('binarysearch')).toBe(7);
  });

  it('所有值都能找到，比较次数不超过 ⌊log₂ n⌋ + 1', () => {
    const next = rng(11);
    for (const n of [1, 2, 3, 15, 16, 17, 1000]) {
      const a = Array.from({ length: n }, () => next(5000));
      const sorted = [...new Set(a)].sort((x, y) => x - y);
      const bound = Math.floor(Math.log2(sorted.length)) + 1;
      sorted.forEach((value, index) => {
        const found = binarySearch(sorted, value);
        expect(found.index).toBe(index);
        expect(found.probes).toBeLessThanOrEqual(bound);
      });
      expect(binarySearch(sorted, -1).index).toBe(-1);
      expect(binarySearch(sorted, 99999).index).toBe(-1);
    }
  });
});

describe('二叉堆', () => {
  const built = () => {
    const heap = new MinHeap();
    [9, 4, 7, 1, 8, 5].forEach((value) => heap.push(value));
    return heap;
  };

  it('reference.c 的数组形态和比较次数', () => {
    const heap = built();
    expect(heap.a).toEqual([1, 4, 5, 9, 8, 7]);
    expect(heap.cmp).toBe(7);
    heap.cmp = 0;
    heap.swaps = 0;
    heap.push(0);
    expect(heap.a).toEqual([0, 4, 1, 9, 8, 7, 5]);
    expect([heap.cmp, heap.swaps]).toEqual([2, 2]);
    heap.cmp = 0;
    heap.swaps = 0;
    expect(heap.pop()).toBe(0);
    expect(heap.a).toEqual([1, 4, 5, 9, 8, 7]);
    expect([heap.cmp, heap.swaps]).toEqual([3, 1]);
    expect(lastOps('heap')).toBe(8);
  });

  it('堆序不变量，弹出顺序和内置排序一致', () => {
    const next = rng(3);
    const values = Array.from({ length: 200 }, () => next(1000));
    const heap = new MinHeap();
    for (const value of values) {
      heap.push(value);
      heap.a.forEach((item, index) => {
        if (index > 0) expect(heap.a[Math.floor((index - 1) / 2)]).toBeLessThanOrEqual(item);
      });
    }
    const out: number[] = [];
    while (heap.a.length) out.push(heap.pop());
    expect(out).toEqual([...values].sort((x, y) => x - y));
  });
});

describe('AVL 树', () => {
  const check = (node: AvlNode | null): number => {
    if (!node) return 0;
    const left = check(node.left);
    const right = check(node.right);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    expect(node.height).toBe(1 + Math.max(left, right));
    expect(balanceOf(node)).toBe(left - right);
    return node.height;
  };

  it('reference.c：课程的 6 个键', () => {
    const tree = new AvlTree();
    [30, 20, 10, 40, 50, 25].forEach((key) => tree.insert(key));
    expect(tree.preorder()).toEqual([30, 20, 10, 25, 40, 50]);
    expect([tree.cmp, tree.rotations, tree.root!.height]).toEqual([11, 4, 3]);
    expect(lastOps('avl')).toBe(15);
  });

  it('有序插入 1 到 7 得到完美平衡树', () => {
    const tree = new AvlTree();
    for (let key = 1; key <= 7; key++) tree.insert(key);
    expect(tree.preorder()).toEqual([4, 2, 1, 3, 6, 5, 7]);
    expect(tree.root!.height).toBe(3);
  });

  it('随机插入：不变量成立，高度不超过 1.44 log₂(n+2)', () => {
    const next = rng(99);
    const tree = new AvlTree();
    const keys = new Set<number>();
    while (keys.size < 500) keys.add(next(100000));
    for (const key of keys) tree.insert(key);
    const height = check(tree.root);
    expect(height).toBeLessThanOrEqual(1.4405 * Math.log2(keys.size + 2));
    const inorder: number[] = [];
    const walk = (node: AvlNode | null) => {
      if (!node) return;
      walk(node.left);
      inorder.push(node.key);
      walk(node.right);
    };
    walk(tree.root);
    expect(inorder).toEqual([...keys].sort((x, y) => x - y));
  });
});

describe('并查集', () => {
  const build = () => {
    const uf = new UnionFind(8);
    [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [4, 6], [0, 4]].forEach(([a, b]) => uf.union(a, b));
    return uf;
  };

  it('reference.c：合并后的数组和路径压缩', () => {
    const uf = build();
    expect(uf.parent).toEqual([0, 0, 0, 2, 0, 4, 4, 6]);
    expect(uf.size).toEqual([8, 1, 2, 1, 4, 1, 2, 1]);
    const before = uf.reads;
    expect(uf.find(7)).toBe(0);
    expect(uf.reads - before).toBe(4);
    expect(uf.parent).toEqual([0, 0, 0, 2, 0, 4, 0, 0]);
  });

  it('课程结束时 3 和 5 同根，再次查询 7 只读 2 次', () => {
    const uf = build();
    uf.find(7);
    const before = uf.reads;
    uf.find(7);
    expect(uf.reads - before).toBe(2);
    expect(uf.find(3)).toBe(uf.find(5));
    expect(uf.parent).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('和暴力标记法对照', () => {
    const next = rng(5);
    const n = 60;
    const uf = new UnionFind(n);
    const label = Array.from({ length: n }, (_, index) => index);
    for (let round = 0; round < 80; round++) {
      const a = next(n);
      const b = next(n);
      uf.union(a, b);
      const from = label[b];
      const to = label[a];
      label.forEach((value, index) => {
        if (value === from) label[index] = to;
      });
      const x = next(n);
      const y = next(n);
      expect(uf.find(x) === uf.find(y)).toBe(label[x] === label[y]);
    }
  });
});

describe('BFS', () => {
  const EDGES: Edge[] = [[0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 5], [4, 5], [5, 6]];

  it('reference.c：访问顺序、距离、扫描边数', () => {
    const result = bfs(7, EDGES, 0);
    expect(result.order).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.dist).toEqual([0, 1, 1, 2, 2, 3, 4]);
    expect(result.scanned).toBe(16);
    // 2 次起点写入 + 7 次出队 + 16 次扫描 + 6 个新顶点各写距离和入队。
    expect(lastOps('bfs')).toBe(2 + 7 + 16 + 12);
  });

  it('和 Floyd-Warshall 对照随机图', () => {
    const next = rng(21);
    for (let round = 0; round < 20; round++) {
      const n = 12;
      const edges: Edge[] = [];
      for (let k = 0; k < 16; k++) {
        const a = next(n);
        const b = next(n);
        if (a !== b) edges.push([a, b]);
      }
      const d: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 1e9)));
      for (const [a, b] of edges) d[a][b] = d[b][a] = 1;
      for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) d[i][j] = Math.min(d[i][j], d[i][k] + d[k][j]);
      const { dist } = bfs(n, edges, 0);
      expect(dist).toEqual(d[0].map((value) => (value >= 1e9 ? -1 : value)));
      expect(adjacency(n, edges).flat().length).toBe(edges.length * 2);
    }
  });
});

describe('Dijkstra', () => {
  const EDGES: WeightedEdge[] = [[0, 1, 7], [0, 2, 9], [0, 5, 14], [1, 2, 10], [1, 3, 15], [2, 3, 11], [2, 5, 2], [3, 4, 6], [4, 5, 9]];

  it('reference.c 用另一种写法算出的最短距离 0 7 9 20 20 11', () => {
    const result = dijkstra(6, EDGES, 0);
    expect(result.dist).toEqual([0, 7, 9, 20, 20, 11]);
    expect(result.relaxations).toBe(18);
    expect(result.stale).toBeGreaterThan(0);
    // 顶点 4 的前驱是 5，5 的前驱是 2，2 的前驱是 0：路径 0-2-5-4，长度 20。
    expect(result.prev[4]).toBe(5);
    expect(result.prev[5]).toBe(2);
    expect(result.prev[2]).toBe(0);
  });

  it('不可达顶点保持 INT_MAX', () => {
    expect(dijkstra(3, [[0, 1, 5]], 0).dist).toEqual([0, 5, INT_MAX]);
  });

  it('和 Bellman-Ford 对照随机图', () => {
    const next = rng(13);
    for (let round = 0; round < 30; round++) {
      const n = 15;
      const edges: WeightedEdge[] = [];
      for (let k = 0; k < 30; k++) edges.push([next(n), next(n), next(50)]);
      const truth = new Array(n).fill(Infinity);
      truth[0] = 0;
      for (let pass = 0; pass < n; pass++) {
        for (const [a, b, w] of edges) {
          truth[b] = Math.min(truth[b], truth[a] + w);
          truth[a] = Math.min(truth[a], truth[b] + w);
        }
      }
      expect(dijkstra(n, edges, 0).dist).toEqual(truth.map((value) => (value === Infinity ? INT_MAX : value)));
    }
  });
});

describe('快速排序', () => {
  it('reference.c：比较 16 次，交换 7 次', () => {
    const result = quickSort([5, 2, 9, 1, 7, 3, 8, 4]);
    expect(result.sorted).toEqual([1, 2, 3, 4, 5, 7, 8, 9]);
    expect([result.cmp, result.swaps]).toEqual([16, 7]);
    expect(lastOps('quicksort')).toBe(23);
  });

  it('有序输入是最坏情况：比较 n(n-1)/2 = 28 次', () => {
    const result = quickSort([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.cmp).toBe(28);
    expect(result.swaps).toBe(0);
  });

  it('不修改输入，和内置排序对照', () => {
    const next = rng(42);
    for (const n of [0, 1, 2, 3, 10, 257]) {
      const input = Array.from({ length: n }, () => next(100));
      const copy = [...input];
      expect(quickSort(input).sorted).toEqual([...input].sort((x, y) => x - y));
      expect(input).toEqual(copy);
    }
  });
});

describe('归并排序', () => {
  it('reference.c：比较 17 次，写入 48 次', () => {
    const result = mergeSort([6, 3, 8, 1, 5, 2, 7, 4]);
    expect(result.sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([result.cmp, result.writes]).toEqual([17, 48]);
    expect(lastOps('mergesort')).toBe(65);
  });

  it('比较次数不超过 n log₂ n，和内置排序对照', () => {
    const next = rng(77);
    for (const n of [2, 8, 16, 64, 256]) {
      const input = Array.from({ length: n }, () => next(1000));
      const result = mergeSort(input);
      expect(result.sorted).toEqual([...input].sort((x, y) => x - y));
      expect(result.cmp).toBeLessThanOrEqual(n * Math.log2(n));
      expect(result.writes).toBe(2 * n * Math.log2(n));
    }
  });
});

describe('LCS', () => {
  it('公开例子', () => {
    expect(lcs('ABCBDAB', 'BDCABA').length).toBe(4);
    expect(lcs('AGGTAB', 'GXTXAYB').length).toBe(4);
    expect(lcs('AGGTAB', 'GXTXAYB').text).toBe('GTAB');
    expect(lcs('', 'ABC').length).toBe(0);
  });

  it('reference.c：课程的字符串', () => {
    const result = lcs('ABCBD', 'BDCAB');
    expect(result.length).toBe(3);
    expect([result.cmp, result.writes]).toEqual([25, 25]);
    expect(naiveLcsCalls('ABCBD', 'BDCAB')).toBe(118);
    expect(lastOps('lcs')).toBe(50);
  });

  it('和枚举所有子序列对照', () => {
    const isSub = (small: string, big: string) => {
      let at = 0;
      for (const char of big) if (char === small[at]) at++;
      return at === small.length;
    };
    const next = rng(8);
    for (let round = 0; round < 40; round++) {
      const x = Array.from({ length: 8 }, () => 'ABC'[next(3)]).join('');
      const y = Array.from({ length: 8 }, () => 'ABC'[next(3)]).join('');
      let best = 0;
      for (let mask = 0; mask < 1 << x.length; mask++) {
        const sub = [...x].filter((_, index) => mask & (1 << index)).join('');
        if (sub.length > best && isSub(sub, y)) best = sub.length;
      }
      const result = lcs(x, y);
      expect(result.length).toBe(best);
      expect(result.text.length).toBe(best);
      expect(isSub(result.text, x) && isSub(result.text, y)).toBe(true);
    }
  });
});

describe('KMP', () => {
  it('公开的失配表', () => {
    expect(buildLps('ABABC').lps).toEqual([0, 0, 1, 2, 0]);
    expect(buildLps('ABABCABAB').lps).toEqual([0, 0, 1, 2, 0, 1, 2, 3, 4]);
    expect(buildLps('AABAACAABAA').lps).toEqual([0, 1, 0, 1, 2, 0, 1, 2, 3, 4, 5]);
    expect(buildLps('AAAA').lps).toEqual([0, 1, 2, 3]);
  });

  it('reference.c：匹配位置和比较次数', () => {
    const { lps, cmp } = buildLps('ABABC');
    expect(cmp).toBe(5);
    const found = kmpSearch('ABABDABABCABAB', 'ABABC', lps);
    expect(found.matches).toEqual([5]);
    expect(found.cmp).toBe(16);
    expect(naiveCompares('ABABDABABCABAB', 'ABABC')).toBe(22);
    expect(lastOps('kmp')).toBe(21);
  });

  it('重叠匹配', () => {
    expect(kmpSearch('aaaaa', 'aa', buildLps('aa').lps).matches).toEqual([0, 1, 2, 3]);
    expect(kmpSearch('abcabcabc', 'abcabc', buildLps('abcabc').lps).matches).toEqual([0, 3]);
    expect(kmpSearch('abc', 'd', buildLps('d').lps).matches).toEqual([]);
  });

  it('和内置 indexOf 循环对照，比较次数不超过 2n', () => {
    const next = rng(31);
    for (let round = 0; round < 200; round++) {
      const text = Array.from({ length: 40 }, () => 'AB'[next(2)]).join('');
      const pattern = Array.from({ length: 1 + next(5) }, () => 'AB'[next(2)]).join('');
      const truth: number[] = [];
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) truth.push(at);
      const found = kmpSearch(text, pattern, buildLps(pattern).lps);
      expect(found.matches).toEqual(truth);
      expect(found.cmp).toBeLessThanOrEqual(2 * text.length);
    }
  });
});

describe('课程里的数字来自算法', () => {
  it('轨迹的最后一个操作数就是算法统计的总数', () => {
    const facts = LESSON_BY_ID.quicksort.steps[4].facts;
    expect(facts).toContainEqual(['本例比较', '16']);
    expect(facts).toContainEqual(['有序输入比较', '28']);
    expect(LESSON_BY_ID.dijkstra.steps[4].facts).toContainEqual(['距离', '0 7 9 20 20 11']);
    expect(LESSON_BY_ID.kmp.overview.facts).toContainEqual(['失配表', '0 0 1 2 0']);
  });

  it('只有真实的失败才标记 lost', () => {
    const lost = Object.values(LESSON_BY_ID).flatMap((lesson) => packetsOf(lesson).filter((packet) => packet.lost).map((packet) => `${lesson.id}:${packet.label}`));
    expect(lost).toEqual(['ringqueue:入队 120']);
  });
});
