// Geometry shared by the develop shader (FINAL pass) and the UI overlays.
// Spaces: source (s, normalized, as stored) -> oriented (o, after 90° steps + flips)
//         -> frame (f, oriented image rotated by the straighten angle, same size as oriented)
//         -> crop-out (uv inside the crop rectangle of the frame).

import type { DevelopSettings } from './settings';

export type Vec2 = [number, number];
export type Orient = DevelopSettings['orient'];
export type Crop = DevelopSettings['crop'];

export function orientedSize(w: number, h: number, rotate: number): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}

export function cropOutSize(s: DevelopSettings, fullW: number, fullH: number, cropMode = false) {
  const o = orientedSize(fullW, fullH, s.orient.rotate);
  if (cropMode) return { w: o.w, h: o.h };
  return { w: Math.max(1, Math.round(o.w * s.crop.w)), h: Math.max(1, Math.round(o.h * s.crop.h)) };
}

export function sourceToOriented(p: Vec2, o: Orient): Vec2 {
  let [x, y] = p;
  if (o.rotate === 90) [x, y] = [1 - y, x];
  else if (o.rotate === 180) [x, y] = [1 - x, 1 - y];
  else if (o.rotate === 270) [x, y] = [y, 1 - x];
  if (o.flipH) x = 1 - x;
  if (o.flipV) y = 1 - y;
  return [x, y];
}

export function orientedToSource(p: Vec2, o: Orient): Vec2 {
  let [x, y] = p;
  if (o.flipH) x = 1 - x;
  if (o.flipV) y = 1 - y;
  if (o.rotate === 90) return [y, 1 - x];
  if (o.rotate === 180) return [1 - x, 1 - y];
  if (o.rotate === 270) return [1 - y, x];
  return [x, y];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function frameToOriented(f: Vec2, angleDeg: number, wo: number, ho: number): Vec2 {
  const a = rad(angleDeg);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const Fx = (f[0] - 0.5) * wo;
  const Fy = (f[1] - 0.5) * ho;
  return [(ca * Fx + sa * Fy) / wo + 0.5, (-sa * Fx + ca * Fy) / ho + 0.5];
}

export function orientedToFrame(o: Vec2, angleDeg: number, wo: number, ho: number): Vec2 {
  const a = rad(angleDeg);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const Ox = (o[0] - 0.5) * wo;
  const Oy = (o[1] - 0.5) * ho;
  return [(ca * Ox - sa * Oy) / wo + 0.5, (sa * Ox + ca * Oy) / ho + 0.5];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cropFits(r: Rect, angleDeg: number, wo: number, ho: number): boolean {
  const eps = 1e-4;
  const corners: Vec2[] = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];
  if (r.x < -eps || r.y < -eps || r.x + r.w > 1 + eps || r.y + r.h > 1 + eps) return false;
  return corners.every((c) => {
    const [x, y] = frameToOriented(c, angleDeg, wo, ho);
    return x >= -eps && y >= -eps && x <= 1 + eps && y <= 1 + eps;
  });
}

/** Shrinks a crop rectangle about its centre (after pulling the centre inwards) until it fits. */
export function constrainCrop(r: Rect, angleDeg: number, wo: number, ho: number): Rect {
  if (cropFits(r, angleDeg, wo, ho)) return r;
  let cx = r.x + r.w / 2;
  let cy = r.y + r.h / 2;
  // Pull the centre toward the middle if needed so a fit exists.
  for (let i = 0; i < 20 && !cropFits({ x: cx - 0.001, y: cy - 0.001, w: 0.002, h: 0.002 }, angleDeg, wo, ho); i++) {
    cx = cx + (0.5 - cx) * 0.3;
    cy = cy + (0.5 - cy) * 0.3;
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const t = { x: cx - (r.w * m) / 2, y: cy - (r.h * m) / 2, w: r.w * m, h: r.h * m };
    if (cropFits(t, angleDeg, wo, ho)) lo = m;
    else hi = m;
  }
  return { x: cx - (r.w * lo) / 2, y: cy - (r.h * lo) / 2, w: r.w * lo, h: r.h * lo };
}

/** Largest centred crop of a given pixel aspect ratio (w/h) that fits at the angle. */
export function maxCrop(aspect: number | null, angleDeg: number, wo: number, ho: number): Rect {
  const a = aspect ?? wo / ho;
  // normalized w/h for the pixel aspect
  let w = 1;
  let h = (wo / a) / ho;
  if (h > 1) {
    w = w / h;
    h = 1;
  }
  return constrainCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h }, angleDeg, wo, ho);
}

/** Maps a source-normalized point into crop-out uv (0..1 inside the visible crop). */
export function sourceToView(p: Vec2, s: DevelopSettings, fullW: number, fullH: number, cropMode = false): Vec2 {
  const o = orientedSize(fullW, fullH, s.orient.rotate);
  const f = orientedToFrame(sourceToOriented(p, s.orient), s.crop.angle, o.w, o.h);
  if (cropMode) return f;
  return [(f[0] - s.crop.x) / s.crop.w, (f[1] - s.crop.y) / s.crop.h];
}

export function viewToSource(uv: Vec2, s: DevelopSettings, fullW: number, fullH: number, cropMode = false): Vec2 {
  const o = orientedSize(fullW, fullH, s.orient.rotate);
  const f: Vec2 = cropMode ? uv : [s.crop.x + uv[0] * s.crop.w, s.crop.y + uv[1] * s.crop.h];
  return orientedToSource(frameToOriented(f, s.crop.angle, o.w, o.h), s.orient);
}

/** Fits a w×h box into a container, returning its placement. */
export function fitRect(w: number, h: number, cw: number, ch: number, margin = 0): Rect {
  const s = Math.min((cw - margin * 2) / w, (ch - margin * 2) / h);
  const rw = w * s;
  const rh = h * s;
  return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
}
