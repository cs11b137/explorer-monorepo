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
  return 0;
}
