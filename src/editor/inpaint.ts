// Fills the unknown pixels of an image from its known ones (the Crop tool's Expand fills). Pure functions on
// typed arrays with no DOM access, so they run in a Web Worker as well as on the page.
//
// softFill: each new pixel takes the colour of the nearest photo pixel, blurred more the further away it
// is. Rows (or columns) keep their colours, so a sky stays at the top and a gradient keeps going.
// contentAwareFill: patch-based image completion (PatchMatch nearest-neighbour search with EM voting,
// coarse to fine, after Barnes et al. 2009 and Wexler et al. 2007). New pixels are assembled from 7×7
// patches of the photo. It starts from the soft fill, and patches beside the photo come from the same
// rows (or columns) of it, so the layout of the scene carries on past the edges.

export interface FillInput {
  w: number;
  h: number;
  /** Top-down RGBA. Only the colours of known pixels are read. */
  rgba: Uint8ClampedArray;
  /** 1 for pixels to keep, 0 for pixels to fill. */
  known: Uint8Array;
}

export type ProgressFn = (fraction: number) => void;

interface Level {
  w: number;
  h: number;
  /** Three floats (0..255) per pixel. */
  rgb: Float32Array;
  known: Uint8Array;
}

/** Patch radius: 7×7 patches. */
const PR = 3;
const PS = 2 * PR + 1;
/** Levels with up to this many target patches get full EM iterations. */
const EM_MAX = 400_000;
/** Above EM_MAX and up to this many, one refinement pass; beyond, the upsampled matches are only voted. */
const REFINE_MAX = 1_600_000;
/** Soft fill blur: about this fraction of the distance from the photo. */
const SOFT_SPREAD = 0.3;
/**
 * Layout prior: cost (in patch SSD units) of taking a patch from a different row than the target beside the
 * photo, per (offset / photo height)². 3e6 makes a 10% offset cost about as much as a 15-level colour error.
 */
const LAYOUT_COST = 3e6;
/**
 * New pixels at the image's edge are covered only by the patches centred inside it, so nothing checks
 * their matches and they drift into stray columns. The content-aware fill works on an image this much
 * larger on each side where the new area meets the edge, and the extra margin is discarded.
 */
const EDGE_PAD = 32;

// ---------------------------------------------------------------- shared helpers

interface Pad {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** EDGE_PAD on each side whose outer row or column has a pixel to fill. */
function edgePad({ w, h, known }: FillInput): Pad {
  let l = 0, r = 0, t = 0, b = 0;
  for (let y = 0; y < h && !(l && r); y++) {
    if (!known[y * w]) l = EDGE_PAD;
    if (!known[y * w + w - 1]) r = EDGE_PAD;
  }
  for (let x = 0; x < w && !(t && b); x++) {
    if (!known[x]) t = EDGE_PAD;
    if (!known[(h - 1) * w + x]) b = EDGE_PAD;
  }
  return { l, t, r, b };
}

/** The input as a float level, grown by `pad` (the margin is unknown). */
function levelFrom(input: FillInput, pad: Pad): Level {
  const { w, h, rgba, known } = input;
  const W = w + pad.l + pad.r;
  const H = h + pad.t + pad.b;
  const rgb = new Float32Array(W * H * 3);
  const kn = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w, o = (y + pad.t) * W + pad.l; x < w; x++, i++, o++) {
      if (!known[i]) continue;
      kn[o] = 1;
      rgb[o * 3] = rgba[i * 4];
      rgb[o * 3 + 1] = rgba[i * 4 + 1];
      rgb[o * 3 + 2] = rgba[i * 4 + 2];
    }
  }
  return { w: W, h: H, rgb, known: kn };
}

/** The input with its unknown pixels taken from `L` (which is grown by `pad`). */
function toRgba(input: FillInput, L: Level, pad: Pad): Uint8ClampedArray<ArrayBuffer> {
  const { w, h, known } = input;
  const out = new Uint8ClampedArray(input.rgba);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w, k = ((y + pad.t) * L.w + pad.l) * 3; x < w; x++, i++, k += 3) {
      if (known[i]) continue;
      // Uint8ClampedArray rounds to the nearest integer on assignment.
      out[i * 4] = L.rgb[k];
      out[i * 4 + 1] = L.rgb[k + 1];
      out[i * 4 + 2] = L.rgb[k + 2];
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

function countKnown(known: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < known.length; i++) n += known[i];
  return n;
}

/** xorshift32: deterministic, so the same input always gives the same fill. */
function rng(seed: number) {
  let s = seed | 0 || 0x2545f491;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Bounding box of the known pixels (inclusive), or null when there are none. */
function knownBox(w: number, h: number, known: Uint8Array): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!known[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------- soft fill

/**
 * Nearest known pixel of every pixel and the squared distance to it: an approximate Euclidean feature
 * transform in two raster passes (Danielsson-style propagation of nearest points).
 */
function nearestKnown(w: number, h: number, known: Uint8Array): { idx: Int32Array; d2: Float32Array } {
  const n = w * h;
  const idx = new Int32Array(n).fill(-1);
  const d2 = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    if (!known[i]) continue;
    idx[i] = i;
    d2[i] = 0;
  }
  const relax = (i: number, x: number, y: number, j: number) => {
    const c = idx[j];
    if (c < 0) return;
    const cx = c % w;
    const dx = x - cx;
    const dy = y - (c - cx) / w;
    const d = dx * dx + dy * dy;
    if (d < d2[i]) {
      d2[i] = d;
      idx[i] = c;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d2[i]) continue;
      if (x > 0) relax(i, x, y, i - 1);
      if (y > 0) {
        relax(i, x, y, i - w);
        if (x > 0) relax(i, x, y, i - w - 1);
        if (x < w - 1) relax(i, x, y, i - w + 1);
      }
    }
    for (let x = w - 2; x >= 0; x--) {
      const i = y * w + x;
      if (d2[i]) relax(i, x, y, i + 1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d2[i]) continue;
      if (x < w - 1) relax(i, x, y, i + 1);
      if (y < h - 1) {
        relax(i, x, y, i + w);
        if (x < w - 1) relax(i, x, y, i + w + 1);
        if (x > 0) relax(i, x, y, i + w - 1);
      }
    }
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      if (d2[i]) relax(i, x, y, i - 1);
    }
  }
  return { idx, d2 };
}

interface Mip {
  w: number;
  h: number;
  c: Float32Array;
}

/** Halves an image with a [1 3 3 1] / 8 binomial filter (a close stand-in for a Gaussian). */
function mipDown(src: Mip): Mip {
  const { w, h, c } = src;
  const nw = Math.max(1, (w + 1) >> 1);
  const nh = Math.max(1, (h + 1) >> 1);
  const tmp = new Float32Array(nw * h * 3);
  const K = [1, 3, 3, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let t = 0; t < 4; t++) {
        const sx = Math.min(w - 1, Math.max(0, 2 * x - 1 + t));
        const i = (y * w + sx) * 3;
        r += K[t] * c[i];
        g += K[t] * c[i + 1];
        b += K[t] * c[i + 2];
      }
      const o = (y * nw + x) * 3;
      tmp[o] = r / 8;
      tmp[o + 1] = g / 8;
      tmp[o + 2] = b / 8;
    }
  }
  const out = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let t = 0; t < 4; t++) {
        const sy = Math.min(h - 1, Math.max(0, 2 * y - 1 + t));
        const i = (sy * nw + x) * 3;
        r += K[t] * tmp[i];
        g += K[t] * tmp[i + 1];
        b += K[t] * tmp[i + 2];
      }
      const o = (y * nw + x) * 3;
      out[o] = r / 8;
      out[o + 1] = g / 8;
      out[o + 2] = b / 8;
    }
  }
  return { w: nw, h: nh, c: out };
}

/** Bilinear sample of mip level `m` (scale 2^k) at full-resolution pixel (x, y), into `o`. */
function sampleMip(m: Mip, k: number, x: number, y: number, o: Float32Array, at: number) {
  const s = 1 / (1 << k);
  const u = Math.min(m.w - 1, Math.max(0, (x + 0.5) * s - 0.5));
  const v = Math.min(m.h - 1, Math.max(0, (y + 0.5) * s - 0.5));
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(m.w - 1, x0 + 1);
  const y1 = Math.min(m.h - 1, y0 + 1);
  const tx = u - x0;
  const ty = v - y0;
  const c = m.c;
  const a = (y0 * m.w + x0) * 3, b = (y0 * m.w + x1) * 3, d = (y1 * m.w + x0) * 3, e = (y1 * m.w + x1) * 3;
  for (let ch = 0; ch < 3; ch++) {
    const top = c[a + ch] + (c[b + ch] - c[a + ch]) * tx;
    const bot = c[d + ch] + (c[e + ch] - c[d + ch]) * tx;
    o[at + ch] = top + (bot - top) * ty;
  }
}

/** Soft fill of a float level in place (used for small levels). */
function softLevel(L: Level) {
  const n = L.w * L.h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = L.rgb[i * 3];
    rgba[i * 4 + 1] = L.rgb[i * 3 + 1];
    rgba[i * 4 + 2] = L.rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const out = softFill({ w: L.w, h: L.h, rgba, known: L.known });
  for (let i = 0; i < n; i++) {
    if (L.known[i]) continue;
    L.rgb[i * 3] = out[i * 4];
    L.rgb[i * 3 + 1] = out[i * 4 + 1];
    L.rgb[i * 3 + 2] = out[i * 4 + 2];
  }
}

/** Continues the known pixels' colours smoothly into the unknown area. */
export function softFill(input: FillInput): Uint8ClampedArray<ArrayBuffer> {
  const { w, h, rgba, known } = input;
  const out = new Uint8ClampedArray(rgba);
  if (!countKnown(known)) return out;
  const n = w * h;
  const { idx, d2 } = nearestKnown(w, h, known);
  // Level 0: the nearest photo pixel's colour (edge stretch). Coarser levels blur it.
  let far = 0;
  for (let i = 0; i < n; i++) {
    if (known[i]) continue;
    const j = idx[i] * 4;
    out[i * 4] = rgba[j];
    out[i * 4 + 1] = rgba[j + 1];
    out[i * 4 + 2] = rgba[j + 2];
    out[i * 4 + 3] = 255;
    if (d2[i] > far) far = d2[i];
  }
  const top = Math.min(14, Math.ceil(Math.log2(1 + SOFT_SPREAD * Math.sqrt(far))) + 1);
  const base: Mip = { w, h, c: new Float32Array(n * 3) };
  for (let i = 0; i < n; i++) {
    base.c[i * 3] = out[i * 4];
    base.c[i * 3 + 1] = out[i * 4 + 1];
    base.c[i * 3 + 2] = out[i * 4 + 2];
  }
  const mips: Mip[] = [base];
  while (mips.length <= top && (mips[mips.length - 1].w > 1 || mips[mips.length - 1].h > 1)) mips.push(mipDown(mips[mips.length - 1]));
  mips[0] = { w: 0, h: 0, c: new Float32Array(0) }; // level 0 is read from `out`
  const a = new Float32Array(3);
  const b = new Float32Array(3);
  const maxK = mips.length - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      const lev = Math.min(maxK, Math.log2(1 + SOFT_SPREAD * Math.sqrt(d2[i])));
      const k0 = Math.floor(lev);
      const t = lev - k0;
      if (k0 === 0) {
        a[0] = out[i * 4];
        a[1] = out[i * 4 + 1];
        a[2] = out[i * 4 + 2];
      } else sampleMip(mips[k0], k0, x, y, a, 0);
      if (t > 0 && k0 < maxK) sampleMip(mips[k0 + 1], k0 + 1, x, y, b, 0);
      else b.set(a);
      out[i * 4] = a[0] + (b[0] - a[0]) * t;
      out[i * 4 + 1] = a[1] + (b[1] - a[1]) * t;
      out[i * 4 + 2] = a[2] + (b[2] - a[2]) * t;
    }
  }
  return out;
}

// ---------------------------------------------------------------- content-aware

function downsample(L: Level): Level {
  const w = Math.max(1, (L.w + 1) >> 1);
  const h = Math.max(1, (L.h + 1) >> 1);
  const rgb = new Float32Array(w * h * 3);
  const known = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, k = 0, r = 0, g = 0, b = 0;
      for (let yy = 2 * y; yy < Math.min(L.h, 2 * y + 2); yy++) {
        for (let xx = 2 * x; xx < Math.min(L.w, 2 * x + 2); xx++) {
          const i = yy * L.w + xx;
          n++;
          if (!L.known[i]) continue;
          k++;
          r += L.rgb[i * 3];
          g += L.rgb[i * 3 + 1];
          b += L.rgb[i * 3 + 2];
        }
      }
      if (!k) continue;
      const o = (y * w + x) * 3;
      rgb[o] = r / k;
      rgb[o + 1] = g / k;
      rgb[o + 2] = b / k;
      // Known when at least half of its footprint is known; the colour only averages known pixels.
      known[y * w + x] = 2 * k >= n ? 1 : 0;
    }
  }
  return { w, h, rgb, known };
}

interface Sets {
  /** 1 where the patch centred here lies entirely on known pixels (a possible source). */
  valid: Uint8Array;
  src: Int32Array;
  /** 1 where the patch centred here covers unknown pixels (a target to match). */
  isT: Uint8Array;
  targets: Int32Array;
  /** Targets whose patch also covers known pixels: the seam with the photo. */
  band: Int32Array;
  holes: Int32Array;
  /** Unknown pixels within two patch radii of the photo. */
  nearHoles: Int32Array;
  /** Known pixels' bounding box (inclusive), for the layout prior. */
  box: { x0: number; y0: number; x1: number; y1: number };
}

function buildSets(L: Level): Sets {
  const { w, h, known } = L;
  const W1 = w + 1;
  const I = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += known[y * w + x] ? 0 : 1;
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + run;
    }
  }
  const unknownIn = (x0: number, y0: number, x1: number, y1: number) => I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
  const n = w * h;
  const valid = new Uint8Array(n);
  const isT = new Uint8Array(n);
  // Lists are filled into full-size buffers and trimmed: large images have millions of entries.
  const src = new Int32Array(n);
  const targets = new Int32Array(n);
  const band = new Int32Array(n);
  let ns = 0, nt = 0, nb = 0;
  const full = PS * PS;
  for (let y = PR; y < h - PR; y++) {
    for (let x = PR; x < w - PR; x++) {
      const u = unknownIn(x - PR, y - PR, x + PR + 1, y + PR + 1);
      const p = y * w + x;
      if (u === 0) {
        valid[p] = 1;
        src[ns++] = p;
      } else {
        isT[p] = 1;
        targets[nt++] = p;
        if (u < full) band[nb++] = p;
      }
    }
  }
  const holes = new Int32Array(n);
  const nearHoles = new Int32Array(n);
  let nh = 0, nn = 0;
  const reach = 2 * PR;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - reach);
    const y1 = Math.min(h - 1, y + reach) + 1;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (known[p]) continue;
      holes[nh++] = p;
      const x0 = Math.max(0, x - reach);
      const x1 = Math.min(w - 1, x + reach) + 1;
      if (unknownIn(x0, y0, x1, y1) < (x1 - x0) * (y1 - y0)) nearHoles[nn++] = p;
    }
  }
  return {
    valid,
    src: src.slice(0, ns),
    isT,
    targets: targets.slice(0, nt),
    band: band.slice(0, nb),
    holes: holes.slice(0, nh),
    nearHoles: nearHoles.slice(0, nn),
    box: knownBox(w, h, known) ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 },
  };
}

/** Sum of squared differences between the patches centred at p and q; stops early once above `cap`. */
function patchDist(rgb: Float32Array, w: number, p: number, q: number, cap: number): number {
  let d = 0;
  const stride = w * 3;
  let i = (p - PR * w - PR) * 3;
  let j = (q - PR * w - PR) * 3;
  for (let r = 0; r < PS; r++) {
    for (let k = 0; k < PS * 3; k++) {
      const e = rgb[i + k] - rgb[j + k];
      d += e * e;
    }
    if (d >= cap) return d;
    i += stride;
    j += stride;
  }
  return d;
}

/**
 * Layout prior for target p and source q. Beside the photo (left or right of it) a patch should come from
 * about the same row; above or below it, from about the same column; in the corners both, half as strongly.
 */
function layoutCost(S: Sets, w: number, p: number, q: number): number {
  const b = S.box;
  const px = p % w;
  const py = (p - px) / w;
  const outX = px < b.x0 || px > b.x1;
  const outY = py < b.y0 || py > b.y1;
  if (!outX && !outY) return 0;
  const qx = q % w;
  const qy = (q - qx) / w;
  const k = outX && outY ? 0.5 : 1;
  let c = 0;
  if (outX) {
    const t = (qy - py) / (b.y1 - b.y0 + 1);
    c += t * t;
  }
  if (outY) {
    const t = (qx - px) / (b.x1 - b.x0 + 1);
    c += t * t;
  }
  return LAYOUT_COST * k * c;
}

function distances(L: Level, S: Sets, list: Int32Array, nnf: Int32Array, nnd: Float32Array) {
  for (let k = 0; k < list.length; k++) {
    const p = list[k];
    nnd[p] = layoutCost(S, L.w, p, nnf[p]) + patchDist(L.rgb, L.w, p, nnf[p], Infinity);
  }
}

/** One PatchMatch pass over `list`: propagation from the previous neighbours, then a random search. */
function pmPass(L: Level, S: Sets, list: Int32Array, nnf: Int32Array, nnd: Float32Array, rand: () => number, reverse: boolean, maxR: number) {
  const { w, h, rgb } = L;
  const { valid, isT } = S;
  const n = list.length;
  const step = reverse ? -1 : 1;
  const vstep = step * w;
  const tryQ = (p: number, q: number, bestD: number) => {
    const c = layoutCost(S, w, p, q);
    if (c >= bestD) return Infinity;
    return c + patchDist(rgb, w, p, q, bestD - c);
  };
  for (let k = 0; k < n; k++) {
    const p = list[reverse ? n - 1 - k : k];
    let best = nnf[p];
    let bestD = nnd[p];
    let a = p - step;
    if (isT[a]) {
      const q = nnf[a] + step;
      if (q !== best && valid[q]) {
        const d = tryQ(p, q, bestD);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
    a = p - vstep;
    if (isT[a]) {
      const q = nnf[a] + vstep;
      if (q !== best && valid[q]) {
        const d = tryQ(p, q, bestD);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
    }
    const bx = best % w;
    const by = (best - bx) / w;
    for (let r = maxR; r >= 1; r *= 0.5) {
      const qx = bx + Math.round((rand() * 2 - 1) * r);
      const qy = by + Math.round((rand() * 2 - 1) * r);
      if (qx < PR || qy < PR || qx >= w - PR || qy >= h - PR) continue;
      const q = qy * w + qx;
      if (q === best || !valid[q]) continue;
      const d = tryQ(p, q, bestD);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    nnf[p] = best;
    nnd[p] = bestD;
  }
}

/** Chessboard distance from each pixel to the nearest known pixel (two-pass chamfer). */
function holeDistance(L: Level): Float32Array {
  const { w, h, known } = L;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = known[i] ? 0 : 1e9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && d[i - w - 1] + 1 < v) v = d[i - w - 1] + 1;
        if (x < w - 1 && d[i - w + 1] + 1 < v) v = d[i - w + 1] + 1;
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        if (d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x < w - 1 && d[i + w + 1] + 1 < v) v = d[i + w + 1] + 1;
        if (x > 0 && d[i + w - 1] + 1 < v) v = d[i + w - 1] + 1;
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Vote weights: patches that match well count more (exp(-d / 2σ²), σ² = the 75th percentile of the
 * distances), and so do patches near the photo, whose matches are more reliable (1.3^-distance).
 */
function voteWeights(list: Int32Array, nnd: Float32Array, dist: Float32Array, out: Float32Array) {
  const n = list.length;
  if (!n) return;
  const m = Math.min(n, 4096);
  const sample = new Float32Array(m);
  for (let i = 0; i < m; i++) sample[i] = nnd[list[Math.floor((i * n) / m)]];
  sample.sort();
  const s2 = Math.max(1, sample[Math.floor(m * 0.75)]);
  for (let k = 0; k < n; k++) {
    const p = list[k];
    out[p] = Math.pow(1.3, -Math.min(60, dist[p])) * Math.exp(-Math.min(30, nnd[p] / (2 * s2)));
  }
}

/** Sets each pixel in `holes` to the weighted average of what the overlapping matched patches put there. */
function vote(L: Level, S: Sets, holes: Int32Array, nnf: Int32Array, wts: Float32Array | null) {
  const { w, h, rgb } = L;
  const isT = S.isT;
  for (let k = 0; k < holes.length; k++) {
    const t = holes[k];
    const tx = t % w;
    const ty = (t - tx) / w;
    const dx0 = Math.max(-PR, tx - (w - PR - 1));
    const dx1 = Math.min(PR, tx - PR);
    const dy0 = Math.max(-PR, ty - (h - PR - 1));
    const dy1 = Math.min(PR, ty - PR);
    let r = 0, g = 0, b = 0, ws = 0;
    for (let dy = dy0; dy <= dy1; dy++) {
      const row = t - dy * w;
      const off = dy * w;
      for (let dx = dx0; dx <= dx1; dx++) {
        const p = row - dx;
        if (!isT[p]) continue;
        const s = (nnf[p] + off + dx) * 3;
        const wt = wts ? wts[p] : 1;
        r += wt * rgb[s];
        g += wt * rgb[s + 1];
        b += wt * rgb[s + 2];
        ws += wt;
      }
    }
    if (ws > 0) {
      const o = t * 3;
      rgb[o] = r / ws;
      rgb[o + 1] = g / ws;
      rgb[o + 2] = b / ws;
    }
  }
}

function randomNnf(L: Level, S: Sets, rand: () => number): Int32Array {
  const nnf = new Int32Array(L.w * L.h);
  for (let k = 0; k < S.targets.length; k++) nnf[S.targets[k]] = S.src[(rand() * S.src.length) | 0];
  return nnf;
}

/** Carries the matches of a coarser level to this one (each at twice the offset), keeping them valid. */
function upsampleNnf(C: Level, CS: Sets, cn: Int32Array, F: Level, FS: Sets, rand: () => number): Int32Array {
  const out = new Int32Array(F.w * F.h);
  const t = FS.targets;
  const cw = C.w;
  const fw = F.w;
  for (let k = 0; k < t.length; k++) {
    const p = t[k];
    const px = p % fw;
    const py = (p - px) / fw;
    const cx = Math.min(cw - PR - 1, Math.max(PR, px >> 1));
    const cy = Math.min(C.h - PR - 1, Math.max(PR, py >> 1));
    const cp = cy * cw + cx;
    let q = -1;
    if (CS.isT[cp]) {
      const cq = cn[cp];
      const cqx = cq % cw;
      const cqy = (cq - cqx) / cw;
      const qx = 2 * cqx + (px - 2 * cx);
      const qy = 2 * cqy + (py - 2 * cy);
      if (qx >= PR && qy >= PR && qx < fw - PR && qy < F.h - PR) {
        const c = qy * fw + qx;
        if (FS.valid[c]) q = c;
      }
    }
    if (q < 0) {
      // Borrow from neighbours already assigned (left, then above) to stay coherent.
      const l = p - 1;
      if (FS.isT[l] && FS.valid[out[l] + 1]) q = out[l] + 1;
      else {
        const u = p - fw;
        if (FS.isT[u] && FS.valid[out[u] + fw]) q = out[u] + fw;
      }
    }
    if (q < 0) q = FS.src[(rand() * FS.src.length) | 0];
    out[p] = q;
  }
  return out;
}

const EMPTY_LEVEL: Level = { w: 0, h: 0, rgb: new Float32Array(0), known: new Uint8Array(0) };
const EMPTY_SETS: Sets = {
  valid: new Uint8Array(0),
  src: new Int32Array(0),
  isT: new Uint8Array(0),
  targets: new Int32Array(0),
  band: new Int32Array(0),
  holes: new Int32Array(0),
  nearHoles: new Int32Array(0),
  box: { x0: 0, y0: 0, x1: 0, y1: 0 },
};

export interface ContentAwareOptions {
  seed?: number;
  onProgress?: ProgressFn;
}

/** Synthesizes the unknown pixels from patches of the known ones. */
export function contentAwareFill(input: FillInput, opts: ContentAwareOptions = {}): Uint8ClampedArray<ArrayBuffer> {
  const known = countKnown(input.known);
  if (known === input.known.length || !known) return new Uint8ClampedArray(input.rgba);
  const rand = rng(opts.seed ?? 0x1f2e3d4c);
  const pad = edgePad(input);
  const base = levelFrom(input, pad);

  // Pyramid: halve while the photo still holds a few patches across and the image stays workable.
  const levels: Level[] = [base];
  for (;;) {
    const l = levels[levels.length - 1];
    if (levels.length >= 9 || Math.min(l.w, l.h) < 48) break;
    const next = downsample(l);
    const b = knownBox(next.w, next.h, next.known);
    if (!b || Math.min(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1) < 3 * PS) break;
    levels.push(next);
  }
  const sets = levels.map(buildSets);
  const top = levels.length - 1;
  if (!sets[top].src.length || !sets[top].targets.length) return softFill(input);

  const iterationsAt = (li: number) => {
    const n = sets[li].targets.length;
    if (n > EM_MAX) return n > REFINE_MAX ? 0 : 1;
    return Math.max(3, 10 - 2 * (top - li));
  };
  const searchRadius = (li: number) => (sets[li].targets.length > EM_MAX ? 8 : Math.max(levels[li].w, levels[li].h));
  // Progress counts work in units of one pixel vote (49 multiply-adds); a patch distance is about 3.
  const DIST = 3;
  const pmCost = (r: number) => DIST * (3 + Math.floor(Math.log2(Math.max(1, r))));
  const workAt = (li: number) => {
    const S = sets[li];
    const it = iterationsAt(li);
    const start = S.holes.length;
    if (!S.src.length || !S.targets.length) return start;
    if (!it) return start + S.band.length * (DIST + pmCost(6) + pmCost(3)) + S.nearHoles.length;
    return start + it * (S.targets.length * (DIST + pmCost(searchRadius(li))) + S.holes.length);
  };
  const total = levels.reduce((a, _l, i) => a + workAt(i), 0) || 1;
  let done = 0;
  let last = -1;
  const add = (units: number) => {
    done += units;
    const f = Math.min(1, done / total);
    if (opts.onProgress && f - last >= 0.01) {
      last = f;
      opts.onProgress(f);
    }
  };

  let prev: { L: Level; S: Sets; nnf: Int32Array } | null = null;
  for (let li = top; li >= 0; li--) {
    const L = levels[li];
    const S = sets[li];
    if (!S.src.length || !S.targets.length) {
      // No room for patches here: fill softly and start the matches afresh below.
      softLevel(L);
      prev = null;
      add(workAt(li));
      continue;
    }
    let nnf: Int32Array;
    if (!prev) {
      softLevel(L);
      nnf = randomNnf(L, S, rand);
    } else {
      nnf = upsampleNnf(prev.L, prev.S, prev.nnf, L, S, rand);
      vote(L, S, S.holes, nnf, null);
    }
    add(S.holes.length);
    const nnd = new Float32Array(L.w * L.h);
    const iters = iterationsAt(li);
    if (iters > 0) {
      const wts = new Float32Array(L.w * L.h);
      const dist = holeDistance(L);
      const maxR = searchRadius(li);
      for (let it = 0; it < iters; it++) {
        distances(L, S, S.targets, nnf, nnd);
        add(S.targets.length * DIST);
        pmPass(L, S, S.targets, nnf, nnd, rand, it % 2 === 1, maxR);
        add(S.targets.length * pmCost(maxR));
        voteWeights(S.targets, nnd, dist, wts);
        vote(L, S, S.holes, nnf, wts);
        add(S.holes.length);
      }
    } else {
      // Large level: keep the upsampled matches, refine only along the seam with the photo.
      distances(L, S, S.band, nnf, nnd);
      pmPass(L, S, S.band, nnf, nnd, rand, false, 6);
      pmPass(L, S, S.band, nnf, nnd, rand, true, 3);
      add(S.band.length * (DIST + pmCost(6) + pmCost(3)));
      vote(L, S, S.nearHoles, nnf, null);
      add(S.nearHoles.length);
    }
    prev = { L, S, nnf };
    // Coarser levels are no longer needed.
    if (li + 1 < levels.length) {
      levels[li + 1] = EMPTY_LEVEL;
      sets[li + 1] = EMPTY_SETS;
    }
  }
  return toRgba(input, base, pad);
}
