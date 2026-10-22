// Monotone cubic Hermite interpolation (Fritsch–Carlson) for tone curves. Points are in 0..1.

export type CurvePoint = [number, number];

export function isIdentityCurve(pts: CurvePoint[]): boolean {
  return pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}

export function makeCurve(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  // de-duplicate x
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6) ys[ys.length - 1] = y;
    else {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => ys[0];
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    let hi = n - 1;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else i = mid;
    }
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

/** Samples a curve into a 256-entry table (0..1 values). */
export function curveTable(points: CurvePoint[], size = 256): Float32Array {
  const f = makeCurve(points);
  const t = new Float32Array(size);
  for (let i = 0; i < size; i++) t[i] = Math.min(1, Math.max(0, f(i / (size - 1))));
  return t;
}
