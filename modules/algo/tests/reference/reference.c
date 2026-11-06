/* 独立参考实现：与 src/lessons 的 TypeScript 没有共享代码。
 *   clang -std=c11 -O1 -Wall tests/reference/reference.c -o /tmp/ref && /tmp/ref
 * tests/algorithms.test.ts 里的期望值抄自这个程序的输出。 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
static void pr(const char *n, const int *a, int k) { printf("%s:", n); for (int i = 0; i < k; i++) printf(" %d", a[i]); puts(""); }

static uint32_t fnv(const char *s) { uint32_t h = 2166136261u; for (; *s; s++) { h ^= (uint8_t)*s; h *= 16777619u; } return h; }

/* 快排：Lomuto，末元素作基准 */
static long qc, qs;
static void sw(int *a, int *b) { int t = *a; *a = *b; *b = t; }
static void qsrt(int *a, int lo, int hi) {
  if (lo >= hi) return;
  int p = a[hi], i = lo;
  for (int j = lo; j < hi; j++) { qc++; if (a[j] < p) { if (i != j) { sw(&a[i], &a[j]); qs++; } i++; } }
  if (i != hi) { sw(&a[i], &a[hi]); qs++; }
  qsrt(a, lo, i - 1); qsrt(a, i + 1, hi);
}
/* 归并 */
static long mc, mw;
static void msrt(int *a, int *t, int lo, int hi) {
  if (hi - lo < 2) return;
  int m = lo + (hi - lo) / 2; msrt(a, t, lo, m); msrt(a, t, m, hi);
  int i = lo, j = m, k = lo;
  while (i < m && j < hi) { mc++; t[k++] = a[i] <= a[j] ? a[i++] : a[j++]; mw++; }
  while (i < m) { t[k++] = a[i++]; mw++; }
  while (j < hi) { t[k++] = a[j++]; mw++; }
  for (k = lo; k < hi; k++) { a[k] = t[k]; mw++; }
}
/* 二分 */
static int bs(const int *a, int n, int x, int *probes) {
  int lo = 0, hi = n; *probes = 0;
  while (lo < hi) { int m = lo + (hi - lo) / 2; ++*probes; if (a[m] == x) return m; if (a[m] < x) lo = m + 1; else hi = m; }
  return -1;
}
/* 最小堆 */
static int H[32], hn; static long hc, hsw;
static void hpush(int x) { int i = hn++; H[i] = x; while (i > 0) { int p = (i - 1) / 2; hc++; if (H[p] <= H[i]) break; sw(&H[p], &H[i]); hsw++; i = p; } }
static int hpop(void) { int top = H[0]; H[0] = H[--hn]; int i = 0; for (;;) { int l = 2*i+1, r = l+1, m = i; if (l < hn) { hc++; if (H[l] < H[m]) m = l; } if (r < hn) { hc++; if (H[r] < H[m]) m = r; } if (m == i) break; sw(&H[m], &H[i]); hsw++; i = m; } return top; }
/* AVL */
struct N { int k, h; struct N *l, *r; };
static int ht(struct N *n) { return n ? n->h : 0; }
static void upd(struct N *n) { int a = ht(n->l), b = ht(n->r); n->h = 1 + (a > b ? a : b); }
static struct N *rr(struct N *y) { struct N *x = y->l; y->l = x->r; x->r = y; upd(y); upd(x); return x; }
static struct N *rl(struct N *x) { struct N *y = x->r; x->r = y->l; y->l = x; upd(x); upd(y); return y; }
static long ac, arot;
static struct N *ins(struct N *n, int k) {
  if (!n) { n = calloc(1, sizeof *n); n->k = k; n->h = 1; return n; }
  ac++; if (k < n->k) n->l = ins(n->l, k); else n->r = ins(n->r, k);
  upd(n); int b = ht(n->l) - ht(n->r);
  if (b > 1) { if (k > n->l->k) { n->l = rl(n->l); arot++; } arot++; return rr(n); }
  if (b < -1) { if (k < n->r->k) { n->r = rr(n->r); arot++; } arot++; return rl(n); }
  return n;
}
static void pre(struct N *n) { if (!n) return; printf(" %d", n->k); pre(n->l); pre(n->r); }
/* 并查集 */
static int P[8], S[8]; static long ur;
static int fnd(int x) { int r = x; ur++; while (P[r] != r) { r = P[r]; ur++; } while (P[x] != r) { int n = P[x]; P[x] = r; x = n; } return r; }
static void uni(int a, int b) { a = fnd(a); b = fnd(b); if (a == b) return; if (S[a] < S[b]) { int t = a; a = b; b = t; } P[b] = a; S[a] += S[b]; }
/* BFS */
static void bfs(int n, int m, const int (*e)[2], int s) {
  int adj[16][16], deg[16] = {0}, d[16], q[16], qh = 0, qt = 0; long scanned = 0;
  for (int i = 0; i < m; i++) { adj[e[i][0]][deg[e[i][0]]++] = e[i][1]; adj[e[i][1]][deg[e[i][1]]++] = e[i][0]; }
  for (int i = 0; i < n; i++) d[i] = -1;
  d[s] = 0; q[qt++] = s;
  while (qh < qt) { int u = q[qh++]; for (int i = 0; i < deg[u]; i++) { int v = adj[u][i]; scanned++; if (d[v] < 0) { d[v] = d[u] + 1; q[qt++] = v; } } }
  pr("bfs.order", q, qt); pr("bfs.dist", d, n); printf("bfs.scanned: %ld\n", scanned);
}
/* Dijkstra（数组扫描，和站内的堆实现不同，只比最终距离） */
static void dij(int n, int m, const int (*e)[3], int s) {
  int w[8][8], d[8], done[8] = {0}; memset(w, -1, sizeof w);
  for (int i = 0; i < m; i++) w[e[i][0]][e[i][1]] = w[e[i][1]][e[i][0]] = e[i][2];
  for (int i = 0; i < n; i++) d[i] = 1 << 30; d[s] = 0;
  for (int c = 0; c < n; c++) { int u = -1; for (int i = 0; i < n; i++) if (!done[i] && (u < 0 || d[i] < d[u])) u = i; done[u] = 1;
    for (int v = 0; v < n; v++) if (w[u][v] >= 0 && d[u] + w[u][v] < d[v]) d[v] = d[u] + w[u][v]; }
  pr("dijkstra.dist", d, n);
}
/* LCS */
static long naive_calls;
static int nv(const char *x, int i, const char *y, int j) { naive_calls++; if (!i || !j) return 0; if (x[i-1] == y[j-1]) return nv(x, i-1, y, j-1) + 1; int a = nv(x, i-1, y, j), b = nv(x, i, y, j-1); return a > b ? a : b; }
static int lcs(const char *x, const char *y) { int m = strlen(x), n = strlen(y), t[32][32]; memset(t, 0, sizeof t);
  for (int i = 1; i <= m; i++) for (int j = 1; j <= n; j++) t[i][j] = x[i-1] == y[j-1] ? t[i-1][j-1] + 1 : (t[i-1][j] > t[i][j-1] ? t[i-1][j] : t[i][j-1]);
  return t[m][n]; }
/* KMP */
static void kmp(const char *t, const char *p) { int n = strlen(t), m = strlen(p), l[64] = {0}; long bc = 0, sc = 0;
  for (int i = 1, k = 0; i < m;) { bc++; if (p[i] == p[k]) l[i++] = ++k; else if (k) k = l[k-1]; else l[i++] = 0; }
  pr("kmp.lps", l, m); printf("kmp.buildcmp: %ld\nkmp.match:", bc);
  for (int i = 0, j = 0; i < n;) { sc++; if (t[i] == p[j]) { i++; j++; if (j == m) { printf(" %d", i - m); j = l[j-1]; } } else if (j) j = l[j-1]; else i++; }
  printf("\nkmp.searchcmp: %ld\n", sc);
  long nc = 0; for (int s = 0; s + m <= n; s++) for (int j = 0; j < m; j++) { nc++; if (t[s+j] != p[j]) break; } printf("kmp.naivecmp: %ld\n", nc);
}
/* 双栈求值：push、pop、看栈顶分别计数 */
static int NS[32], nt, OS[32], ot; static long epu, epo, epe;
static int prec(int c) { return c == '+' || c == '-' ? 1 : c == '*' || c == '/' ? 2 : 0; }
static void npu(int v) { NS[nt++] = v; epu++; }
static int npo(void) { epo++; return NS[--nt]; }
static void red(void) { int b = npo(), a = npo(); int o = OS[--ot]; epo++; npu(o == '+' ? a + b : o == '-' ? a - b : o == '*' ? a * b : a / b); }
static int calc(const char *s) {
  nt = ot = 0; epu = epo = epe = 0;
  for (const char *p = s; *p;) {
    if (*p >= '0' && *p <= '9') { int v = 0; while (*p >= '0' && *p <= '9') v = v * 10 + (*p++ - '0'); npu(v); continue; }
    if (*p == '(') { OS[ot++] = '('; epu++; }
    else if (*p == ')') { for (;;) { epe++; if (OS[ot-1] == '(') break; red(); } ot--; epo++; }
    else { while (ot > 0) { epe++; if (OS[ot-1] == '(' || prec(OS[ot-1]) < prec(*p)) break; red(); } OS[ot++] = *p; epu++; }
    p++;
  }
  while (ot) red();
  return npo();
}
/* 二叉搜索树：指向指针的指针，比较、写入、找后继分别计数 */
struct B { int k; struct B *l, *r; };
static struct B *broot; static long bc, bw, bwk;
static void bins(int k) { struct B **p = &broot; while (*p) { bc++; if (k == (*p)->k) return; p = k < (*p)->k ? &(*p)->l : &(*p)->r; } *p = calloc(1, sizeof **p); (*p)->k = k; bw++; }
static int bfnd(int k) { int n = 0; for (struct B *x = broot; x; x = k < x->k ? x->l : x->r) { bc++; n++; if (k == x->k) return n; } return -n; }
static void bdel(int k) {
  struct B **p = &broot; while (*p && (*p)->k != k) { bc++; p = k < (*p)->k ? &(*p)->l : &(*p)->r; }
  if (!*p) return; bc++; struct B *x = *p;
  if (x->l && x->r) { struct B **s = &x->r; bwk++; while ((*s)->l) { s = &(*s)->l; bwk++; } struct B *y = *s; x->k = y->k; bw++; *s = y->r; bw++; free(y); }
  else { *p = x->l ? x->l : x->r; bw++; free(x); }
}
static int bht(struct B *x) { if (!x) return 0; int a = bht(x->l), b = bht(x->r); return 1 + (a > b ? a : b); }
static void bpre(struct B *x) { if (!x) return; printf(" %d", x->k); bpre(x->l); bpre(x->r); }
/* DFS 拓扑排序：三色，完成时从末尾往前写 */
static int dadj[16][16], ddeg[16], dcol[16], dord[16], dpos, dfin[16], dfn; static long drd, dwr, dscan; static int dcyc;
static void dvis(int u) { dcol[u] = 1; dwr++; for (int i = 0; i < ddeg[u]; i++) { int v = dadj[u][i]; dscan++; drd++; if (dcol[v] == 1) dcyc = 1; else if (dcol[v] == 0) dvis(v); } dcol[u] = 2; dord[--dpos] = u; dwr += 2; dfin[dfn++] = u; }
static void topo(int n, int m, const int (*e)[2]) {
  memset(ddeg, 0, sizeof ddeg); memset(dcol, 0, sizeof dcol); dpos = n; dfn = 0; drd = dwr = dscan = 0; dcyc = 0;
  for (int i = 0; i < m; i++) dadj[e[i][0]][ddeg[e[i][0]]++] = e[i][1];
  for (int s = 0; s < n; s++) { drd++; if (!dcol[s]) dvis(s); }
}
/* Kruskal：qsort 按边权排序，并查集按大小合并、路径压缩 */
struct edge { int u, v, w; };
static int ecmp(const void *a, const void *b) { return ((const struct edge *)a)->w - ((const struct edge *)b)->w; }
static int KP[16], KS[16]; static long kr, kw;
static int kfnd(int x) { int r = x; kr++; while (KP[r] != r) { r = KP[r]; kr++; } while (KP[x] != r) { int n = KP[x]; KP[x] = r; kw++; x = n; } return r; }
static int kruskal(int n, int m, struct edge *e, int *examined) {
  qsort(e, m, sizeof *e, ecmp); for (int i = 0; i < n; i++) { KP[i] = i; KS[i] = 1; } kr = kw = 0;
  int total = 0, taken = 0; *examined = 0;
  for (int k = 0; k < m && taken < n - 1; k++) {
    ++*examined; int a = kfnd(e[k].u), b = kfnd(e[k].v);
    if (a == b) { printf(" -%d-%d", e[k].u, e[k].v); continue; }
    if (KS[a] < KS[b]) { int t = a; a = b; b = t; } KP[b] = a; KS[a] += KS[b]; kw += 2; total += e[k].w; taken++; printf(" +%d-%d", e[k].u, e[k].v);
  }
  return total;
}
/* LSD 基数排序：每趟一次计数排序，起始位置用前缀和 */
static void radix(int *a, int n) {
  int b[16], mx = 0; long cnt = 0, sum = 0, put = 0, cp = 0, pass = 0;
  for (int i = 0; i < n; i++) if (a[i] > mx) mx = a[i];
  for (int ex = 1; mx / ex > 0; ex *= 10) {
    int c[10] = {0}; pass++;
    for (int i = 0; i < n; i++) { c[a[i] / ex % 10]++; cnt++; }
    printf("radix.count%d:", ex); for (int d = 0; d < 10; d++) printf(" %d", c[d]); puts("");
    for (int d = 0, s = 0; d < 10; d++) { int t = c[d]; c[d] = s; s += t; sum++; }
    printf("radix.start%d:", ex); for (int d = 0; d < 10; d++) printf(" %d", c[d]); puts("");
    for (int i = 0; i < n; i++) { b[c[a[i] / ex % 10]++] = a[i]; put++; }
    for (int i = 0; i < n; i++) { a[i] = b[i]; cp++; }
    printf("radix.pass%d:", ex); for (int i = 0; i < n; i++) printf(" %d", a[i]); puts("");
  }
  printf("radix.ops: passes %ld count %ld sum %ld put %ld copy %ld\n", pass, cnt, sum, put, cp);
}
/* N 皇后：回溯找第一个解，另外数出全部解 */
static int QN, Q[16]; static long qtry, qcmp, qcall, qback, qsol;
static int qok(int row, int col) { for (int r = 0; r < row; r++) { qcmp++; if (Q[r] == col || abs(Q[r] - col) == row - r) return 0; } return 1; }
static int qsolve(int row) { qcall++; if (row == QN) return 1; for (int c = 0; c < QN; c++) { qtry++; if (!qok(row, c)) continue; Q[row] = c; if (qsolve(row + 1)) return 1; qback++; } return 0; }
static void qall(int row) { if (row == QN) { qsol++; return; } for (int c = 0; c < QN; c++) if (qok(row, c)) { Q[row] = c; qall(row + 1); } }
int main(void) {
  const char *keys[] = {"", "a", "foobar", "apple", "pear", "plum", "fig", "kiwi", "lime", "mango", "peach", "grape", "cherry", "melon", "date", 0};
  for (int i = 0; keys[i]; i++) printf("fnv %s: %08x &7=%u\n", keys[i], fnv(keys[i]), fnv(keys[i]) & 7);
  int q[] = {5,2,9,1,7,3,8,4}; qsrt(q, 0, 7); pr("quick", q, 8); printf("quick.cmp: %ld swaps: %ld\n", qc, qs);
  qc = qs = 0; int qw[] = {1,2,3,4,5,6,7,8}; qsrt(qw, 0, 7); printf("quick.sorted.cmp: %ld swaps: %ld\n", qc, qs);
  int m[] = {6,3,8,1,5,2,7,4}, t[8]; msrt(m, t, 0, 8); pr("merge", m, 8); printf("merge.cmp: %ld writes: %ld\n", mc, mw);
  int b[] = {3,8,12,17,21,26,31,38,44,52,60,71}, pb; int r = bs(b, 12, 44, &pb); printf("bs44: %d probes %d\n", r, pb); r = bs(b, 12, 40, &pb); printf("bs40: %d probes %d\n", r, pb);
  int hv[] = {9,4,7,1,8,5}; for (int i = 0; i < 6; i++) hpush(hv[i]); pr("heap.built", H, hn); printf("heap.built.cmp: %ld\n", hc);
  hc = hsw = 0; hpush(0); pr("heap.push0", H, hn); printf("heap.push.cmp: %ld swaps %ld\n", hc, hsw);
  hc = hsw = 0; int top = hpop(); pr("heap.pop", H, hn); printf("heap.top: %d cmp %ld swaps %ld\n", top, hc, hsw);
  struct N *root = 0; int av[] = {30,20,10,40,50,25}; for (int i = 0; i < 6; i++) root = ins(root, av[i]);
  printf("avl.pre:"); pre(root); printf("\navl.cmp: %ld rot: %ld height: %d\n", ac, arot, root->h);
  root = 0; for (int i = 1; i <= 7; i++) root = ins(root, i); printf("avl.seq.pre:"); pre(root); puts("");
  for (int i = 0; i < 8; i++) { P[i] = i; S[i] = 1; }
  int us[][2] = {{0,1},{2,3},{4,5},{6,7},{0,2},{4,6},{0,4}}; for (int i = 0; i < 7; i++) uni(us[i][0], us[i][1]); pr("uf.before", P, 8); pr("uf.size", S, 8);
  ur = 0; int root7 = fnd(7); pr("uf.after7", P, 8); printf("uf.find7: %d reads %ld\n", root7, ur);
  int be[][2] = {{0,1},{0,2},{1,3},{2,3},{2,4},{3,5},{4,5},{5,6}}; bfs(7, 8, be, 0);
  int de[][3] = {{0,1,7},{0,2,9},{0,5,14},{1,2,10},{1,3,15},{2,3,11},{2,5,2},{3,4,6},{4,5,9}}; dij(6, 9, de, 0);
  printf("lcs ABCBDAB/BDCABA: %d\nlcs AGGTAB/GXTXAYB: %d\nlcs ABCBD/BDCAB: %d\n", lcs("ABCBDAB","BDCABA"), lcs("AGGTAB","GXTXAYB"), lcs("ABCBD","BDCAB"));
  nv("ABCBD", 5, "BDCAB", 5); printf("lcs.naive.calls: %ld\n", naive_calls);
  kmp("ABABDABABCABAB", "ABABC");
  const char *ex[] = {"2*(3+4)-6/2", "8-3-2", "2*(3+(4-1))*5", "100/7/2", "1+2*3-4/2", "(((9)))", 0};
  for (int i = 0; ex[i]; i++) { int v = calc(ex[i]); printf("calc %s: %d push %ld pop %ld peek %ld\n", ex[i], v, epu, epo, epe); }
  int bk[] = {50,30,70,20,40,60,80,65}; for (int i = 0; i < 8; i++) bins(bk[i]);
  printf("bst.pre:"); bpre(broot); printf("\nbst.insert.cmp: %ld height %d\n", bc, bht(broot));
  printf("bst.find65: %d find45: %d\n", bfnd(65), bfnd(45));
  int bd[] = {20, 30, 50}; for (int i = 0; i < 3; i++) { bdel(bd[i]); printf("bst.del%d:", bd[i]); bpre(broot); puts(""); }
  printf("bst.cmp: %ld writes %ld walks %ld\n", bc, bw, bwk);
  int bs[] = {20,30,40,50,60,65,70,80}; broot = 0; for (int i = 0; i < 8; i++) bins(bs[i]); printf("bst.sorted.height: %d\n", bht(broot));
  int te[][2] = {{0,1},{0,2},{1,3},{2,3},{3,4},{2,5},{5,4},{6,2}}; topo(7, 8, te);
  pr("topo.order", dord, 7); pr("topo.finish", dfin, 7); printf("topo.scanned: %ld reads %ld writes %ld cyclic %d\n", dscan, drd, dwr, dcyc);
  int ce[][2] = {{0,1},{1,2},{2,0},{2,3}}; topo(4, 4, ce); printf("topo.cycle: %d\n", dcyc);
  struct edge ke[] = {{0,1,6},{0,2,4},{1,2,7},{1,3,11},{2,3,9},{2,5,12},{3,4,1},{3,5,8},{4,5,3}}; int kex;
  printf("kruskal:"); int kt = kruskal(6, 9, ke, &kex); printf("\nkruskal.total: %d examined %d reads %ld writes %ld\n", kt, kex, kr, kw);
  int ra[] = {170,45,75,90,802,24,2,66}; radix(ra, 8);
  QN = 4; qsolve(0); pr("queens4", Q, 4); printf("queens4.tries: %ld cmp %ld calls %ld back %ld\n", qtry, qcmp, qcall, qback);
  printf("queens.count:"); for (QN = 1; QN <= 8; QN++) { qsol = 0; qall(0); printf(" %ld", qsol); } puts("");
  return 0;
}
