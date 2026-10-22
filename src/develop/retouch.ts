// Touch Up: Lightroom-style spot removal (heal / clone) and red-eye correction.
//
// Spots live in DevelopSettings in source-normalized coordinates and are applied to the source pixels
// before every other develop step, so preview, 1:1, thumbnails, export and the Editor all match.
// The renderer owns the pixels (a GPU texture); it hands this module small RGBA regions and uploads
// the results. Everything here is plain CPU code on top-down RGBA byte arrays.

import type { RetouchSpot } from './settings';

export type Pt = [number, number];

/** A spot resolved to pixel units of a w×h image. */
export interface SpotPx {
  mode: RetouchSpot['mode'];
  pts: Pt[];
  r: number;
  /** Integer source offset in pixels. */
  ox: number;
  oy: number;
  feather: number; // 0..1
  opacity: number; // 0..1
  darken: number; // 0..1
}

export function spotToPx(s: RetouchSpot, w: number, h: number): SpotPx {
  const L = Math.max(w, h);
  return {
    mode: s.mode,
    pts: s.path.map(([x, y]) => [x * w, y * h] as Pt),
    r: Math.max(0.75, s.r * L),
    ox: Math.round(s.dx * w),
    oy: Math.round(s.dy * h),
    feather: s.feather / 100,
    opacity: s.opacity / 100,
    darken: s.darken / 100,
  };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Integer bounds of the path grown by `pad`, clamped to the image. Null when nothing is inside. */
export function pathBox(pts: Pt[], pad: number, W: number, H: number): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const bx = Math.max(0, Math.floor(x0 - pad));
  const by = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(W, Math.ceil(x1 + pad));
  const by1 = Math.min(H, Math.ceil(y1 + pad));
  if (bx1 <= bx || by1 <= by) return null;
  return { x: bx, y: by, w: bx1 - bx, h: by1 - by };
}

/**
 * Distance from each pixel centre of `box` to the path (a point or a polyline), computed only within
 * `reach` of it (Infinity elsewhere). Cost is proportional to the swept area, not box × segments.
 */
export function distanceField(pts: Pt[], box: Box, reach: number): Float32Array {
  const { x: bx, y: by, w, h } = box;
  const d = new Float32Array(w * h).fill(Infinity);
  const seg = (ax: number, ay: number, cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, cx) - reach - bx));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, cx) + reach - bx));
    const y0 = Math.max(0, Math.floor(Math.min(ay, cy) - reach - by));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, cy) + reach - by));
    const vx = cx - ax;
    const vy = cy - ay;
    const len2 = vx * vx + vy * vy;
    for (let y = y0; y <= y1; y++) {
      const py = by + y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = bx + x + 0.5;
        let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * vx);
        const ey = py - (ay + t * vy);
        const dist = Math.sqrt(ex * ex + ey * ey);
        const i = y * w + x;
        if (dist < d[i]) d[i] = dist;
      }
    }
  };
  if (pts.length === 1) seg(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return d;
}

/**
 * Coverage of a spot at distance `d` from its path: 1 inside, soft falloff over the feathered rim.
 * The rim is at most the outer half of the radius, so a blemish that fits inside the circle is fully
 * replaced and doesn't leave a faint outline.
 */
export function coverage(d: number, r: number, feather: number): number {
  const inner = r * (1 - 0.5 * Math.min(1, Math.max(0, feather)));
  const edge = Math.max(1, r - inner);
  if (d <= r - edge) return 1;
  if (d >= r) return 0;
  const t = (r - d) / edge;
  return t * t * (3 - 2 * t);
}

/** Region the renderer must read/write for a spot. */
export interface SpotJob {
  spot: SpotPx;
  /** Destination region (also where results are written). */
  box: Box;
  /** Distance field over `box`. */
  dist: Float32Array;
  needsSource: boolean;
}

export function planSpot(s: RetouchSpot, W: number, H: number): SpotJob | null {
  const spot = spotToPx(s, W, H);
  const needsSource = spot.mode !== 'redeye';
  // Heal needs a band of known pixels around the spot for its boundary condition.
  const band = needsSource && spot.mode === 'heal' ? Math.max(3, Math.ceil(cellSize(spot.r) * 2.5)) : 1;
  const box = pathBox(spot.pts, spot.r + band, W, H);
  if (!box) return null;
  return { spot, box, dist: distanceField(spot.pts, box, spot.r + band), needsSource };
}

/** Coarse cell size for the membrane solve: about 48 cells across the spot, whatever its size. */
const cellSize = (r: number) => Math.max(1, Math.ceil((2 * r) / 48));

/**
 * Computes the retouched destination region. `dst` and `src` are RGBA bytes of `job.box` (src already
 * offset by the spot's source offset). Returns new RGBA bytes for the region.
 */
export function renderSpot(job: SpotJob, dst: Uint8Array, src: Uint8Array | null): Uint8ClampedArray {
  const { spot, box, dist } = job;
  // Clamped: healed values can overshoot 0..255 and must saturate, not wrap around.
  const out = new Uint8ClampedArray(dst);
  const n = box.w * box.h;
  if (spot.mode === 'redeye') {
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < n; i++) {
      const a = coverage(dist[i], spot.r, spot.feather) * spot.opacity;
      if (a <= 0) continue;
      const j = i * 4;
      const r = dst[j];
      const g = dst[j + 1];
      const b = dst[j + 2];
      // Flash red eye is a strong, saturated red. Requiring both a large red excess and a high ratio
      // leaves brown irises, skin and eyelids inside the circle untouched.
      const chroma = r - Math.max(g, b);
      if (chroma <= 30) continue;
      const red = smooth(30, 90, chroma) * smooth(0.35, 0.55, chroma / (r + 1));
      if (red <= 0) continue;
      const k = a * red;
      const gb = (g + b) / 2;
      const dark = 1 - spot.darken * 0.75 * k;
      out[j] = (r + (gb - r) * k) * dark;
      out[j + 1] = g * dark;
      out[j + 2] = b * dark;
    }
    return out;
  }
  if (!src) return out;
  if (spot.mode === 'clone') {
    for (let i = 0; i < n; i++) {
      const a = coverage(dist[i], spot.r, spot.feather) * spot.opacity;
      if (a <= 0) continue;
      const j = i * 4;
      for (let c = 0; c < 3; c++) out[j + c] = dst[j + c] + (src[j + c] - dst[j + c]) * a;
    }
    return out;
  }
  const diff = healDifference(job, dst, src);
  for (let i = 0; i < n; i++) {
    const a = coverage(dist[i], spot.r, spot.feather) * spot.opacity;
    if (a <= 0) continue;
    const j = i * 4;
    const k = i * 3;
    for (let c = 0; c < 3; c++) {
      const healed = src[j + c] + diff[k + c];
      out[j + c] = dst[j + c] + (healed - dst[j + c]) * a;
    }
  }
  return out;
}

/**
 * Healing = source texture + a smooth colour correction D that matches the destination at the spot's
 * edge (Pérez seamless cloning: D is harmonic inside, D = dst − src outside). D is low-frequency, so it
 * is solved on a coarse grid (~48 cells across) with SOR and upsampled bilinearly: fast and well
 * converged at any spot size. Returns per-pixel RGB offsets for the region.
 */
function healDifference(job: SpotJob, dst: Uint8Array, src: Uint8Array): Float32Array {
  const { spot, box, dist } = job;
  const cs = cellSize(spot.r);
  const gw = Math.ceil(box.w / cs);
  const gh = Math.ceil(box.h / cs);
  const G = gw * gh;
  const D = new Float32Array(G * 3);
  const sum = new Float32Array(G * 3);
  const cnt = new Uint32Array(G);
  const unknown = new Uint8Array(G);
  for (let y = 0; y < box.h; y++) {
    const gy = Math.floor(y / cs);
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (dist[i] < spot.r) continue;
      const g = gy * gw + Math.floor(x / cs);
      const j = i * 4;
      sum[g * 3] += dst[j] - src[j];
      sum[g * 3 + 1] += dst[j + 1] - src[j + 1];
      sum[g * 3 + 2] += dst[j + 2] - src[j + 2];
      cnt[g]++;
    }
  }
  let ring = [0, 0, 0];
  let ringN = 0;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx;
      const cx = Math.min(box.w - 1, Math.floor((gx + 0.5) * cs));
      const cy = Math.min(box.h - 1, Math.floor((gy + 0.5) * cs));
      if (dist[cy * box.w + cx] < spot.r || !cnt[g]) {
        unknown[g] = 1;
        continue;
      }
      for (let c = 0; c < 3; c++) D[g * 3 + c] = sum[g * 3 + c] / cnt[g];
      if (dist[cy * box.w + cx] < spot.r + cs * 2) {
        ring = ring.map((v, c) => v + D[g * 3 + c]);
        ringN++;
      }
    }
  if (ringN) ring = ring.map((v) => v / ringN);
  const free: number[] = [];
  for (let g = 0; g < G; g++)
    if (unknown[g]) {
      free.push(g);
      for (let c = 0; c < 3; c++) D[g * 3 + c] = ring[c];
    }
  if (free.length && free.length < G) {
    const N = Math.max(gw, gh);
    const omega = 2 / (1 + Math.sin(Math.PI / (N + 1)));
    const iters = Math.min(260, Math.max(40, N * 4));
    for (let it = 0; it < iters; it++) {
      for (const g of free) {
        const gx = g % gw;
        const gy = (g - gx) / gw;
        let k = 0;
        let a0 = 0;
        let a1 = 0;
        let a2 = 0;
        const add = (q: number) => {
          a0 += D[q * 3];
          a1 += D[q * 3 + 1];
          a2 += D[q * 3 + 2];
          k++;
        };
        if (gx > 0) add(g - 1);
        if (gx < gw - 1) add(g + 1);
        if (gy > 0) add(g - gw);
        if (gy < gh - 1) add(g + gw);
        if (!k) continue;
        D[g * 3] += omega * (a0 / k - D[g * 3]);
        D[g * 3 + 1] += omega * (a1 / k - D[g * 3 + 1]);
        D[g * 3 + 2] += omega * (a2 / k - D[g * 3 + 2]);
      }
    }
  }
  // Bilinear upsample to pixels.
  const out = new Float32Array(box.w * box.h * 3);
  for (let y = 0; y < box.h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cs - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (dist[i] >= spot.r) continue;
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cs - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const top = D[(y0 * gw + x0) * 3 + c] * (1 - tx) + D[(y0 * gw + x1) * 3 + c] * tx;
        const bot = D[(y1 * gw + x0) * 3 + c] * (1 - tx) + D[(y1 * gw + x1) * 3 + c] * tx;
        out[i * 3 + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- automatic source selection

/** A downscaled RGBA view of part of the image, as read back by the renderer. */
export interface RegionImage {
  data: Uint8Array;
  w: number;
  h: number;
  /** Region origin and size in image pixels. */
  x: number;
  y: number;
  scale: number; // region pixels per image pixel
}

/** Image region (and the scale to read it at) that the source search needs for a spot. */
export function searchRegion(spot: SpotPx, W: number, H: number): { box: Box; scale: number } | null {
  // Farthest candidate ring (5.8 r) plus the boundary band (1.7 r) must fit.
  const box = pathBox(spot.pts, spot.r * 7.6 + 2, W, H);
  if (!box) return null;
  let scale = Math.min(1, 14 / spot.r);
  scale = Math.min(scale, 480 / Math.max(box.w, box.h));
  return { box, scale: Math.max(scale, 1 / 64) };
}

/**
 * Picks the source offset (image pixels) whose surroundings best match the spot's surroundings, like
 * Lightroom's automatic source: candidates on rings around the spot, scored by the colour difference
 * of the boundary band plus a penalty for busy texture inside the candidate, preferring nearby ones.
 */
export function findSourceOffset(spot: SpotPx, img: RegionImage, W: number, H: number, avoid: Pt[] = []): Pt {
  const s = img.scale;
  const pts = spot.pts.map(([x, y]) => [(x - img.x) * s, (y - img.y) * s] as Pt);
  const r = spot.r * s;
  const box = { x: 0, y: 0, w: img.w, h: img.h };
  const reach = r * 1.7 + 1.5;
  const dist = distanceField(pts, box, reach);
  const ring: number[] = [];
  const inside: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] <= r) inside.push(i);
    else if (dist[i] <= reach) ring.push(i);
  }
  const thin = (a: number[], max: number) => (a.length <= max ? a : a.filter((_, i) => i % Math.ceil(a.length / max) === 0));
  const ringS = thin(ring, 2500);
  const insideS = thin(inside, 1500);
  const px = (i: number, c: number) => img.data[i * 4 + c];
  // The shifted spot must not overlap itself: sample the path densely and require a 2r gap.
  const dense: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    dense.push(pts[i]);
    if (i + 1 < pts.length) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r * 0.5));
      for (let k = 1; k < steps; k++) dense.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
  }
  const pathDist = (x: number, y: number) => {
    let best = Infinity;
    for (const [qx, qy] of dense) best = Math.min(best, Math.hypot(x - qx, y - qy));
    return best;
  };
  let best: { o: Pt; score: number } | null = null;
  let fallback: { o: Pt; score: number } | null = null;
  // Region bounds in region pixels, intersected with the image.
  const minX = Math.max(0, -img.x * s);
  const minY = Math.max(0, -img.y * s);
  const maxX = Math.min(img.w, (W - img.x) * s);
  const maxY = Math.min(img.h, (H - img.y) * s);
  for (const k of [2.2, 2.8, 3.6, 4.6, 5.8]) {
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2 + (k % 1) * 0.6;
      const ox = Math.round(Math.cos(th) * r * k);
      const oy = Math.round(Math.sin(th) * r * k);
      if (avoid.some(([ax, ay]) => Math.hypot(ox / s - ax, oy / s - ay) < spot.r * 0.9)) continue;
      let ok = true;
      let ssd = 0;
      for (const i of ringS) {
        const x = (i % img.w) + ox;
        const y = Math.floor(i / img.w) + oy;
        if (x < minX || y < minY || x >= maxX || y >= maxY) {
          ok = false;
          break;
        }
        const j = y * img.w + x;
        for (let c = 0; c < 3; c++) {
          const dd = px(j, c) - px(i, c);
          ssd += dd * dd;
        }
      }
      if (!ok) continue;
      let m0 = 0;
      let m1 = 0;
      let m2 = 0;
      let v = 0;
      for (const i of insideS) {
        const j = (Math.floor(i / img.w) + oy) * img.w + (i % img.w) + ox;
        m0 += px(j, 0);
        m1 += px(j, 1);
        m2 += px(j, 2);
      }
      const nI = Math.max(1, insideS.length);
      m0 /= nI;
      m1 /= nI;
      m2 /= nI;
      for (const i of insideS) {
        const j = (Math.floor(i / img.w) + oy) * img.w + (i % img.w) + ox;
        v += (px(j, 0) - m0) ** 2 + (px(j, 1) - m1) ** 2 + (px(j, 2) - m2) ** 2;
      }
      const score = (ssd / Math.max(1, ringS.length) + 0.35 * (v / nI)) * (1 + 0.06 * k);
      const overlaps = dense.some(([x, y]) => pathDist(x + ox, y + oy) < r * 1.9);
      const cand = { o: [ox / s, oy / s] as Pt, score };
      if (!overlaps) {
        if (!best || score < best.score) best = cand;
      } else if (!fallback || score < fallback.score) fallback = cand;
    }
  }
  const pick = best ?? fallback;
  if (pick) return pick.o;
  // Nothing fits (spot covers most of the region): step sideways, towards the image centre.
  return [spot.pts[0][0] < W / 2 ? spot.r * 2.4 : -spot.r * 2.4, 0];
}

/** Ramer–Douglas–Peucker simplification for brushed spot paths. */
export function simplifyPath(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.hypot(vx, vy) || 1;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * vy - (pts[i][1] - ay) * vx) / len;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
