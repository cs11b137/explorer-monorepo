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
