int g;

int f(int a, int b) {
  int x = 0;
  if (a < b) {
    x = a - b;
  } else {
    x = b - a;
  }
  g = x;
  return -x + g;
}
