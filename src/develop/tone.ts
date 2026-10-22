// CPU-side construction of the tone lookup table used by the develop shader.
// Channel A = parametric tone (whites/blacks/shadows/highlights/contrast) followed by the master point
// curve. Channels R,G,B = per-channel point curves. Domain is [0, LUT_MAX] in display-encoded units so
// that values pushed above 1.0 by exposure can still be recovered by the highlights control.

import { isIdentityCurve, makeCurve } from '../lib/spline';
import type { DevelopSettings } from './settings';

export const LUT_SIZE = 1024;
export const LUT_MAX = 2;

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function parametricTone(x: number, s: Pick<DevelopSettings, 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>): number {
  const b = s.blacks / 100;
  const w = s.whites / 100;
  const sh = s.shadows / 100;
  const hl = s.highlights / 100;
  const c = s.contrast / 100;
  let y = x;

  // Whites & blacks move the ends of the range while leaving midtones mostly alone.
  const xc = c01(x);
  y += b * 0.15 * Math.pow(1 - xc, 3);
  y += w * 0.2 * (x < 1 ? xc * xc * xc : 1);

  // Shadows / highlights: smooth bumps centred at 1/3 and 2/3.
  let yc = c01(y);
  y += sh * (sh > 0 ? 0.3 : 0.15) * 6.75 * yc * (1 - yc) * (1 - yc);
  yc = c01(y);
  if (hl > 0) {
    y += hl * 0.2 * 6.75 * yc * yc * (1 - yc);
  } else if (hl < 0) {
    const k = -hl;
    y -= k * 0.08 * 6.75 * yc * yc * (1 - yc);
    // Soft shoulder: compresses everything above the knee (recovers values > 1 from exposure pushes).
    const knee = 1 - 0.3 * k;
    if (y > knee) y = knee + (1 - knee) * Math.tanh((y - knee) / (1 - knee));
  }

  // Contrast: power S-curve pivoting around middle grey, endpoints fixed.
  if (c !== 0 && y > 0 && y < 1) {
    const m = 0.45;
    const e = c > 0 ? 1 + 1.6 * c : 1 + 0.6 * c;
    y = y < m ? m * Math.pow(y / m, e) : 1 - (1 - m) * Math.pow((1 - y) / (1 - m), e);
  }
  return c01(y);
}

export function buildToneLut(s: DevelopSettings): Float32Array {
  const master = isIdentityCurve(s.curve.master) ? null : makeCurve(s.curve.master);
  const rc = isIdentityCurve(s.curve.red) ? null : makeCurve(s.curve.red);
  const gc = isIdentityCurve(s.curve.green) ? null : makeCurve(s.curve.green);
  const bc = isIdentityCurve(s.curve.blue) ? null : makeCurve(s.curve.blue);
  const out = new Float32Array(LUT_SIZE * 4);
  let prev = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = (i / (LUT_SIZE - 1)) * LUT_MAX;
    let y = parametricTone(x, s);
    if (master) y = c01(master(y));
    if (y < prev) y = prev; // keep monotonic so the hue-preserving mapping stays stable
    prev = y;
    const xc = Math.min(x, 1);
    out[i * 4 + 0] = rc ? c01(rc(xc)) : xc;
    out[i * 4 + 1] = gc ? c01(gc(xc)) : xc;
    out[i * 4 + 2] = bc ? c01(bc(xc)) : xc;
    out[i * 4 + 3] = y;
  }
  return out;
}
