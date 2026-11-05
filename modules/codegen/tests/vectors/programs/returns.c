int f(int a, int b) {
  int t = a;
  if (b) {
    return t + 1;
  }
  while (t > 0) {
    t = t - 2;
  }
  return t;
}
