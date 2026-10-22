// Automatic tone and white balance from the renderer's small linear-light source sample.

import { linearToSrgb, luma, wbForNeutral, wbMultipliers } from '../lib/color';
import type { SourceSample } from './renderer';
import type { DevelopSettings } from './settings';

const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function autoTone(sample: SourceSample, s: DevelopSettings): Partial<DevelopSettings> {
  const [mr, mg, mb] = wbMultipliers(s.temperature, s.tint);
  const n = sample.lin.length / 3;
  const ys = new Float32Array(n);
  let logSum = 0;
  for (let i = 0; i < n; i++) {
    const y = luma(sample.lin[i * 3] * mr, sample.lin[i * 3 + 1] * mg, sample.lin[i * 3 + 2] * mb);
    ys[i] = y;
    logSum += Math.log(y + 1e-4);
  }
  const gm = Math.exp(logSum / n);
  const exposure = clamp(round(Math.log2(0.16 / Math.max(gm, 1e-4)) * 0.7, 0.05), -2, 2);
  const k = Math.pow(2, exposure);
  const p = Array.from(ys, (y) => linearToSrgb(Math.min(1, y * k))).sort((a, b) => a - b);
  const pct = (q: number) => p[Math.min(p.length - 1, Math.floor(q * p.length))];
  const lo = pct(0.005);
  const hi = pct(0.995);
  const brightShare = p.filter((v) => v > 0.92).length / p.length;
  const darkShare = p.filter((v) => v < 0.12).length / p.length;
  const whites = hi < 0.93 ? clamp(Math.round((0.97 - hi) * 250), 0, 60) : brightShare > 0.03 ? -15 : 0;
  const blacks = lo > 0.04 ? -clamp(Math.round((lo - 0.015) * 250), 0, 60) : 0;
  const highlights = -clamp(Math.round(brightShare * 500), 0, 70);
  const shadows = clamp(Math.round(darkShare * 180), 0, 50);
  const spread = pct(0.75) - pct(0.25);
  const contrast = spread < 0.3 ? clamp(Math.round((0.3 - spread) * 120), 0, 30) : 0;
  return { exposure, whites, blacks, highlights, shadows, contrast };
}

export function autoWhiteBalance(sample: SourceSample): { temperature: number; tint: number } {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < sample.lin.length; i += 3) {
    const y = luma(sample.lin[i], sample.lin[i + 1], sample.lin[i + 2]);
    if (y < 0.01 || y > 0.85) continue;
    r += sample.lin[i];
    g += sample.lin[i + 1];
    b += sample.lin[i + 2];
    n++;
  }
  if (!n) return { temperature: 0, tint: 0 };
  return wbForNeutral(r / n, g / n, b / n);
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
