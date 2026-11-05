/** 全站贯穿的示例程序：一个带循环的求和函数。每个阶段的产物都由它算出来。 */
export const SOURCE = `int total;
int scale(int v);

int sum(int n) {
  int k = 2;
  int m = k * 3;
  int d = m + 1;
  int s = 0;
  int i = 0;
  while (i < n) {
    s = s + m * n + i;
    i = i + 1;
  }
  total = s;
  return scale(s) + n;
}
`;

/** 链接课用到的另一个编译单元，提供 scale 的定义。 */
export const SCALE_SOURCE = `int scale(int v) {
  return v * 2;
}
`;

/** 类型检查课演示报错：把 scale 多传一个实参，其余不变。 */
export const BAD_SOURCE = SOURCE.replace('scale(s) + n', 'scale(s, n) + n');

export const SOURCE_LINES = SOURCE.replace(/\n$/, '').split('\n');
