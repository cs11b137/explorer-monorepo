int f(int a, int b) {
  int t = 0;
  int i = 0;
  while (i < a) {
    int j = 0;
    while (j < i) {
      t = t + i * j + b;
      j = j + 1;
    }
    i = i + 1;
  }
  return t;
}
