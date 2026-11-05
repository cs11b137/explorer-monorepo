/* 用真实编译器核对本站用到的结构布局：
 *   clang -target x86_64-unknown-linux-gnu -std=c11 -ffreestanding -fsyntax-only tests/reference/layouts.c
 * 编译通过即断言全部成立。tests/decode.test.ts 里的偏移来自这里，不来自被测代码。 */
#include <stddef.h>
#include <stdint.h>
#define AT(s, f, o) _Static_assert(offsetof(struct s, f) == (o), #s "." #f)
#define SZ(s, n) _Static_assert(sizeof(struct s) == (n), #s)
_Static_assert(sizeof(long) == 8 && sizeof(void *) == 8 && sizeof(int) == 4, "LP64");

struct vec { int *data; size_t len; size_t cap; };
AT(vec, data, 0); AT(vec, len, 8); AT(vec, cap, 16); SZ(vec, 24);

struct node { int val; struct node *next; };
AT(node, val, 0); AT(node, next, 8); SZ(node, 16);

struct ring { int *buf; uint32_t cap; uint32_t head; uint32_t tail; };
AT(ring, buf, 0); AT(ring, cap, 8); AT(ring, head, 12); AT(ring, tail, 16); SZ(ring, 24);

struct slot { const char *key; int value; uint32_t hash; uint8_t state; };
AT(slot, key, 0); AT(slot, value, 8); AT(slot, hash, 12); AT(slot, state, 16); SZ(slot, 24);

struct avl_node { int key; int height; struct avl_node *left; struct avl_node *right; };
AT(avl_node, key, 0); AT(avl_node, height, 4); AT(avl_node, left, 8); AT(avl_node, right, 16); SZ(avl_node, 24);

struct pq_item { int dist; int node; };
AT(pq_item, dist, 0); AT(pq_item, node, 4); SZ(pq_item, 8);
