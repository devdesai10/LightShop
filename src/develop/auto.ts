// Automatic tone and white balance (the two Auto buttons in Develop's Basic panel), computed from the
// renderer's small linear-light sample of the photo. Only the part inside the crop is analysed.
//
// Both were tuned on the 24 Kodak reference photos, with darker, brighter, faded and colour-cast copies.

import { linearToSrgb, luma, wbForNeutral, wbMultipliers } from '../lib/color';
import { sourceToView } from './geometry';
import type { SourceSample } from './renderer';
import type { DevelopSettings } from './settings';
import { parametricTone } from './tone';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step: number) => Math.round(v / step) * step;
const sq = (v: number) => v * v;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Value at quantile q (0..1) of an ascending array. */
const quantile = (sorted: ArrayLike<number>, q: number) => sorted[clamp(Math.floor(q * sorted.length), 0, sorted.length - 1)];
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Marks the sample pixels inside the crop (what the user actually sees). */
function visibleMask(sample: SourceSample, s?: DevelopSettings): Uint8Array {
  const { w, h } = sample;
  const mask = new Uint8Array(w * h).fill(1);
  if (!s || (s.crop.w >= 0.999 && s.crop.h >= 0.999 && s.crop.x <= 0.001 && s.crop.y <= 0.001 && s.crop.angle === 0)) return mask;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [u, v] = sourceToView([(x + 0.5) / w, (y + 0.5) / h], s, w, h);
      const inside = u >= 0 && v >= 0 && u <= 1 && v <= 1;
      mask[y * w + x] = inside ? 1 : 0;
      if (inside) n++;
    }
  return n >= 64 ? mask : mask.fill(1); // a tiny crop has too few samples; use the whole frame
}

// ---------------------------------------------------------------- Auto Tone

/**
 * Exposure model: a well-exposed photo's log2 average luminance ≈ KEY_T + KEY_W · key, where key (−1..1)
 * says whether the scene is mostly dark or mostly bright for its dynamic range (Reinhard's key estimate).
 * Fitted to the reference photos.
 */
const KEY_T = -3.34;
const KEY_W = 2.26;
/**
 * Haze: in a clear photo the darkest 0.5% is well below this share of the median luminance (at most
 * ~0.15 in the reference photos); anything above it is treated as a lifted floor (fade, haze, flare).
 */
const HAZE_FLOOR = 0.15;
/** Exposure may push the brightest detail this far past white (linear); Highlights rolls it back. */
const HIGHLIGHT_HEADROOM = 1.5;
/** Linear values at or above this in the source count as clipped (blown) highlights. */
const CLIPPED = 0.985;

type ToneKnobs = Pick<DevelopSettings, 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>;
type ToneFit = ToneKnobs & { exposure: number };
/** Slider, min, max, cost of moving it. Whites, Blacks and Contrast can go far for faded, hazy photos. */
const KNOBS: [keyof ToneKnobs, number, number, number][] = [
  ['highlights', -80, 0, 1],
  ['shadows', 0, 60, 1],
  ['whites', -25, 100, 1],
  ['blacks', -100, 25, 1],
  ['contrast', -25, 100, 1.5],
];
/** How far the fit may move exposure from the key estimate (EV), and what that costs. */
const EXPOSURE_RANGE = 0.75;
const EXPOSURE_COST = 0.3;

/**
 * Brightest output channel of the renderer's tone mapping for a display-encoded pixel: the average of the
 * hue-preserving curve (applyTone) and the luminance-ratio curve (lumTone) in shaders.ts.
 */
function toneMax(r: number, g: number, b: number, T: (x: number) => number) {
  const hi = Math.max(r, g, b);
  const L = Math.max(luma(r, g, b), 1e-5);
  const Lt = T(Math.min(L, 2));
  const k = smoothstep(0, 0.1, L);
  const q = (hi + (Lt - L)) * (1 - k) + hi * (Lt / L) * k;
  return 0.5 * T(Math.min(hi, 2)) + 0.5 * clamp(q, 0, 1);
}

/**
 * Lightroom-style Auto Tone.
 * 1. Exposure brings the scene to a natural brightness for its key (low-key scenes stay darker, high-key
 *    brighter). Badly exposed photos are corrected fully; photos that are nearly right only get a nudge.
 * 2. Highlights, Shadows, Whites, Blacks and Contrast are fitted through the renderer's own tone curve so
 *    the photo spans the range: the brightest detail just below white, blown areas still white, the
 *    darkest detail just above black, midtones where exposure put them, and no added clipping.
 */
export function autoTone(sample: SourceSample, s: DevelopSettings): Partial<DevelopSettings> {
  const [mr, mg, mb] = wbMultipliers(s.temperature, s.tint);
  const mask = visibleMask(sample, s);
  const lin = sample.lin;
  const idx: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  const n = idx.length;
  const Y = new Float32Array(n); // linear luminance
  const maxC: number[] = [];
  const srcClipped = new Uint8Array(n);
  let clippedCount = 0;
  for (let j = 0; j < n; j++) {
    const i = idx[j] * 3;
    const clipped = Math.max(lin[i], lin[i + 1], lin[i + 2]) >= CLIPPED;
    srcClipped[j] = clipped ? 1 : 0;
    if (clipped) clippedCount++;
    const r = lin[i] * mr;
    const g = lin[i + 1] * mg;
    const b = lin[i + 2] * mb;
    Y[j] = luma(r, g, b);
    if (!clipped) maxC.push(Math.max(r, g, b));
  }
  const clippedShare = clippedCount / n;
  Y.sort();

  // 1. Exposure, judged with any haze floor taken out: the lifted shadows of a faded or hazy photo would
  // otherwise make it look brighter than it is. (Blacks and Contrast remove the haze in step 2.)
  const haze = Math.max(0, quantile(Y, 0.005) - HAZE_FLOOR * quantile(Y, 0.5));
  const logY = Float32Array.from(Y, (y) => Math.log2(Math.max(y - haze, 1 / 16384))); // still ascending
  const lo = quantile(logY, 0.01);
  const hi = quantile(logY, 0.99);
  const a = quantile(logY, 0.02);
  const z = quantile(logY, 0.98);
  let sum = 0;
  let cnt = 0;
  for (let j = 0; j < n; j++)
    if (logY[j] >= a && logY[j] <= z) {
      sum += logY[j];
      cnt++;
    }
  const avg = cnt ? sum / cnt : quantile(logY, 0.5);
  const key = clamp((2 * avg - lo - hi) / Math.max(hi - lo, 1), -1, 1);
  const wanted = KEY_T + KEY_W * key - avg;
  // Small corrections are halved (the photographer probably meant it); big ones are applied in full.
  let e0 = wanted * (0.5 + 0.5 * smoothstep(0, 1, Math.abs(wanted)));
  maxC.sort((p, q) => p - q);
  const brightest = maxC.length ? quantile(maxC, 0.995) : 0;
  const maxExposure = brightest > 0 ? Math.max(0, Math.log2(HIGHLIGHT_HEADROOM / brightest)) : 3;
  e0 = clamp(round(Math.min(e0, maxExposure), 0.05), -3, 3);

  // 2. Joint fit of exposure (near e0) and the tone sliders, through the renderer's tone curve.
  // Luminance quantiles; scaling by exposure keeps their order, so output quantile = curve(input quantile).
  const QS = [0.002, 0.005, 0.1, 0.25, 0.5, 0.75, 0.9];
  const yq = QS.map((q) => quantile(Y, q));
  // The brightest few percent of (unclipped) pixels decide where white goes and what would clip.
  const order: number[] = [];
  for (let j = 0; j < n; j++) if (!srcClipped[j]) order.push(j);
  const peak = (j: number) => Math.max(lin[idx[j] * 3] * mr, lin[idx[j] * 3 + 1] * mg, lin[idx[j] * 3 + 2] * mb);
  order.sort((p, q) => peak(q) - peak(p));
  const top = order.slice(0, Math.max(1, Math.ceil(n * 0.04)));
  const stride = Math.max(1, Math.floor(top.length / 600));
  const bright = top.filter((_, i) => i % stride === 0);
  const unit = stride / n; // share of the photo each bright sample stands for
  const rank995 = clamp(Math.round((0.005 * n) / stride) - 1, 0, Math.max(0, bright.length - 1));
  const brightOut = new Float32Array(bright.length);
  const enc = (v: number) => linearToSrgb(Math.min(4, Math.max(0, v)));
  // Display-encoded inputs for one exposure, as the tone curve sees them (cached per 0.05 EV step).
  const atCache = new Map<number, { l: number[]; px: Float32Array; blown: number }>();
  const at = (E: number) => {
    const keyE = Math.round(E * 20);
    let c = atCache.get(keyE);
    if (!c) {
      const k = Math.pow(2, keyE / 20);
      const px = new Float32Array(bright.length * 3);
      bright.forEach((j, b) => {
        const i = idx[j] * 3;
        px[b * 3] = enc(lin[i] * mr * k);
        px[b * 3 + 1] = enc(lin[i + 1] * mg * k);
        px[b * 3 + 2] = enc(lin[i + 2] * mb * k);
      });
      c = { l: yq.map((y) => enc(y * k)), px, blown: Math.min(2, enc(k * Math.max(mr, mg, mb))) };
      atCache.set(keyE, c);
    }
    return c;
  };
  const mid = clamp(at(e0).l[4], 0.3, 0.58);

  const loss = (t: ToneFit) => {
    const T = (x: number) => parametricTone(x, t);
    const { l, px, blown } = at(t.exposure);
    const [l002, l005, l10, l25, l50, l75, l90] = l.map(T);
    let newlyClipped = 0;
    for (let b = 0; b < bright.length; b++) {
      const v = toneMax(px[b * 3], px[b * 3 + 1], px[b * 3 + 2], T);
      brightOut[b] = v;
      newlyClipped += 1 / (1 + Math.exp(-(v - 0.985) / 0.004));
    }
    brightOut.sort();
    const white = bright.length ? brightOut[bright.length - 1 - rank995] : l90;
    const iqr = l75 - l25;
    let cost = EXPOSURE_COST * sq(t.exposure - e0);
    for (const [knob, , , w] of KNOBS) cost += 0.02 * w * sq(t[knob] / 100);
    return (
      30 * sq(Math.max(0, white - 0.975)) + // brightest detail at most just below white…
      6 * sq(Math.max(0, 0.93 - white)) + // …and not dull
      600 * sq(Math.max(0, newlyClipped * unit - 0.003)) + // no newly blown highlights
      (clippedShare > 0.002 ? 15 * sq(Math.max(0, 0.92 - T(blown))) : 0) + // blown areas stay near white, not grey
      6 * sq(l005 - 0.035) + // darkest detail just above black…
      60 * sq(Math.max(0, 0.008 - l002)) + // …without crushing
      4 * sq(l50 - mid) + // midtones where the scene key puts them
      3 * sq(Math.max(0, 0.07 - l10)) + // shadow detail
      3 * sq(Math.max(0, l90 - 0.9)) + // highlight detail
      3 * sq(Math.max(0, 0.2 - iqr)) + // not flat…
      3 * sq(Math.max(0, iqr - 0.42)) + // …nor harsh
      cost // prefer small moves
    );
  };
  const eMin = clamp(e0 - EXPOSURE_RANGE, -3, 3);
  const eMax = clamp(Math.min(e0 + EXPOSURE_RANGE, Math.max(e0, maxExposure)), -3, 3);
  const best: ToneFit = { exposure: e0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  let bestLoss = loss(best);
  const params: [keyof ToneFit, number, number, number][] = [['exposure', eMin, eMax, 0.05], ...KNOBS.map(([k, lo2, hi2]) => [k, lo2, hi2, 1] as [keyof ToneFit, number, number, number])];
  for (const step of [16, 8, 4, 2, 1]) {
    for (let pass = 0, improved = true; improved && pass < 40; pass++) {
      improved = false;
      for (const [p, min, max, unitStep] of params)
        for (const d of [step, -step]) {
          const v = clamp(round(best[p] + d * unitStep, unitStep), min, max);
          if (v === best[p]) continue;
          const cand = { ...best, [p]: v };
          const l = loss(cand);
          if (l < bestLoss - 1e-9) {
            Object.assign(best, cand);
            bestLoss = l;
            improved = true;
          }
        }
    }
  }
  return { ...best, exposure: Math.round(best.exposure * 20) / 20 }; // k/20 keeps the value tidy (1.2, not 1.2000000000000002)
}

// ---------------------------------------------------------------- Auto White Balance

type LogChroma = [number, number]; // [ln(R/G), ln(B/G)] of a neutral surface under the light

const usable = (r: number, g: number, b: number) => luma(r, g, b) >= 0.01 && Math.max(r, g, b) <= 0.92 && Math.min(r, g, b) > 1e-4;
const logChroma = (r: number, g: number, b: number): LogChroma => [Math.log(Math.max(r, 1e-6) / Math.max(g, 1e-6)), Math.log(Math.max(b, 1e-6) / Math.max(g, 1e-6))];

/** Shades of grey (Finlayson & Trezzi): Minkowski p-norm of the pixel values. */
function shadesOfGrey(sample: SourceSample, mask: Uint8Array, p = 6): LogChroma {
  const { lin } = sample;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const R = lin[i * 3];
    const G = lin[i * 3 + 1];
    const B = lin[i * 3 + 2];
    if (!usable(R, G, B)) continue;
    r += R ** p;
    g += G ** p;
    b += B ** p;
  }
  return logChroma(r ** (1 / p), g ** (1 / p), b ** (1 / p));
}

/** Grey edge (van de Weijer et al.): Minkowski p-norm of the gradients of a lightly blurred image. */
function greyEdge(sample: SourceSample, mask: Uint8Array, p = 6): LogChroma {
  const { w, h, lin } = sample;
  // 3×3 binomial blur per channel.
  const bl = new Float32Array(lin.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        let ws = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = (dx ? 1 : 2) * (dy ? 1 : 2);
            acc += lin[(yy * w + xx) * 3 + c] * k;
            ws += k;
          }
        bl[(y * w + x) * 3 + c] = acc / ws;
      }
  const e = [0, 0, 0];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!mask[i] || Math.max(lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2]) > 0.92) continue;
      for (let c = 0; c < 3; c++) {
        const gx = bl[(i + 1) * 3 + c] - bl[(i - 1) * 3 + c];
        const gy = bl[(i + w) * 3 + c] - bl[(i - w) * 3 + c];
        e[c] += Math.hypot(gx, gy) ** p;
      }
    }
  return logChroma(e[0] ** (1 / p), e[1] ** (1 / p), e[2] ** (1 / p));
}

/** Average of the brightest usable pixels (a softened white patch). */
function brightPatch(sample: SourceSample, mask: Uint8Array, share = 0.03): LogChroma {
  const { lin } = sample;
  const px: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const R = lin[i * 3];
    const G = lin[i * 3 + 1];
    const B = lin[i * 3 + 2];
    if (usable(R, G, B)) px.push(i);
  }
  if (!px.length) return [0, 0];
  const lum = (i: number) => lin[i * 3] + lin[i * 3 + 1] + lin[i * 3 + 2];
  px.sort((p, q) => lum(q) - lum(p));
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of px.slice(0, Math.max(20, Math.round(px.length * share)))) {
    r += lin[i * 3];
    g += lin[i * 3 + 1];
    b += lin[i * 3 + 2];
  }
  return logChroma(r, g, b);
}

/**
 * Near-neutral search: starting from "no cast", repeatedly average the pixels whose colour is close to the
 * current estimate, with a shrinking window that is wider along blue–amber (how light sources vary).
 * Brighter pixels count more.
 */
function neutralSearch(sample: SourceSample, mask: Uint8Array): LogChroma {
  const { lin } = sample;
  const pts: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const R = lin[i * 3];
    const G = lin[i * 3 + 1];
    const B = lin[i * 3 + 2];
    if (!usable(R, G, B)) continue;
    const [u, v] = logChroma(R, G, B);
    if (Math.abs(u) > 1.5 || Math.abs(v) > 1.5) continue;
    pts.push(u, v, sq(luma(R, G, B)));
  }
  let eu = 0;
  let ev = 0;
  for (const rad of [0.45, 0.3, 0.2, 0.14, 0.1]) {
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (let j = 0; j < pts.length; j += 3) {
      const du = pts[j] - eu;
      const dv = pts[j + 1] - ev;
      const d2 = sq((du - dv) / Math.SQRT2 / (rad * 1.6)) + sq((du + dv) / Math.SQRT2 / rad);
      if (d2 > 1) continue;
      const k = pts[j + 2] * (1 - d2);
      su += k * pts[j];
      sv += k * pts[j + 1];
      sw += k;
    }
    if (sw <= 0) break;
    eu = su / sw;
    ev = sv / sw;
  }
  return [eu, ev];
}

/**
 * How much of each estimated cast to correct, and the dead zones. Blue casts are corrected almost fully;
 * warm light keeps some of its warmth (it's often the mood of the photo). Tint is corrected more gently,
 * since green foliage, water or sand easily pass for a green light.
 */
const WB_STRENGTH_COOL = 0.9;
const WB_STRENGTH_WARM = 0.7;
const WB_STRENGTH_TINT = 0.6;
const WB_DEAD_TEMP = 0.05;
const WB_DEAD_TINT = 0.05;

/**
 * Auto White Balance. Four estimators that fail in different ways vote on the colour of the light: shades
 * of grey, grey edge, the brightest surfaces and a near-neutral search. Their median is used, so one being
 * fooled by a colourful scene doesn't swing the result. The correction is partial (photos keep some of
 * their mood, as Lightroom's Auto does), smaller when the estimates disagree, and nothing changes for a
 * photo that is already close to neutral.
 */
export function autoWhiteBalance(sample: SourceSample, s?: DevelopSettings): { temperature: number; tint: number } {
  if (sample.w < 8 || sample.h < 8) return { temperature: 0, tint: 0 };
  const mask = visibleMask(sample, s);
  const ests = [shadesOfGrey(sample, mask), greyEdge(sample, mask), brightPatch(sample, mask), neutralSearch(sample, mask)].filter(
    (e) => Number.isFinite(e[0]) && Number.isFinite(e[1]),
  );
  if (ests.length < 2) return { temperature: 0, tint: 0 };
  const eu = median(ests.map((e) => e[0]));
  const ev = median(ests.map((e) => e[1]));
  const spread = median(ests.map((e) => Math.hypot(e[0] - eu, e[1] - ev)));
  const confidence = 1 - 0.5 * smoothstep(0.05, 0.25, spread);
  const soft = (x: number, dead: number) => Math.sign(x) * Math.max(0, Math.abs(x) - dead);
  // The light's colour along blue (−) to amber (+), and along green (−) to magenta (+).
  const cast = soft((eu - ev) / Math.SQRT2, WB_DEAD_TEMP);
  const temp = cast * (cast < 0 ? WB_STRENGTH_COOL : WB_STRENGTH_WARM) * confidence;
  const tint = soft((eu + ev) / Math.SQRT2, WB_DEAD_TINT) * WB_STRENGTH_TINT * confidence;
  const u = (temp + tint) / Math.SQRT2;
  const v = (tint - temp) / Math.SQRT2;
  if (Math.hypot(u, v) < 1e-3) return { temperature: 0, tint: 0 };
  return wbForNeutral(Math.exp(u), 1, Math.exp(v));
}

/** Average linear RGB in a small neighbourhood (normalized source coordinates). */
export function sampleAt(sample: SourceSample, sx: number, sy: number, radius = 2): [number, number, number] {
  const cx = Math.round(sx * (sample.w - 1));
  const cy = Math.round(sy * (sample.h - 1));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = cy - radius; y <= cy + radius; y++)
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= sample.w || y >= sample.h) continue;
      const i = (y * sample.w + x) * 3;
      r += sample.lin[i];
      g += sample.lin[i + 1];
      b += sample.lin[i + 2];
      n++;
    }
  return n ? [r / n, g / n, b / n] : [0.5, 0.5, 0.5];
}
