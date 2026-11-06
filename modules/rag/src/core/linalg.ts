/**
 * 对称矩阵的特征分解（循环 Jacobi 法）。嵌入模型（LSA）的训练用它：对段落的 Gram 矩阵做分解，得到奇异值和奇异向量。
 * Jacobi 法每次旋转消掉一个非对角元，顺序固定，结果完全确定；矩阵只有二三十阶，几毫秒就收敛。
 */

export interface Eigen {
  /** 特征值，从大到小。 */
  values: number[];
  /** 对应的特征向量（单位长度），vectors[k] 是第 k 个。符号固定为「绝对值最大的分量为正」。 */
  vectors: number[][];
  /** 用了几轮扫描。 */
  sweeps: number;
}

export function jacobiEigen(matrix: readonly (readonly number[])[], tolerance = 1e-22, maxSweeps = 100): Eigen {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const v: number[][] = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)));
  let sweeps = 0;
  for (; sweeps < maxSweeps; sweeps++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2;
    if (off < tolerance) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = a.map((row, i) => [row[i], i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  const vectors = order.map(([, i]) => {
    const col = v.map((row) => row[i]);
    const big = col.reduce((best, x) => (Math.abs(x) > Math.abs(best) ? x : best), 0);
    return big < 0 ? col.map((x) => -x) : col;
  });
  return { values: order.map(([value]) => value), vectors, sweeps };
}
