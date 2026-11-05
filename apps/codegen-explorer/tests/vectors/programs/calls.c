int helper(int a, int b, int c);

int f(int a, int b) {
  int x = helper(a, b, 3);
  int y = helper(x, a, b);
  return x * y + b - 7;
}
