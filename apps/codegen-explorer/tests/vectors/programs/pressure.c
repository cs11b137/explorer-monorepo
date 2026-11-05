int helper(int a, int b, int c);

int f(int a, int b) {
  int c = a + b;
  int d = a - b;
  int e = a * b;
  int p = c + d;
  int q = c - d;
  int r = c * d;
  int s = e + p;
  int t = e - p;
  int u = q + r;
  int v = q - r;
  int w = s * 3;
  int x = t + u;
  int y = u - v;
  int z = helper(w, x, y);
  return a + b + c + d + e + p + q + r + s + t + u + v + w + x + y + z;
}
