// Pixel algorithms used by the editor tools: brush dabs, flood fill, healing.

import { createCanvas, ctx2d } from '../lib/imageio';
import { hexToRgb } from '../lib/color';
import type { Rect } from './doc';

/** Radial brush tip with the given hardness (0..1). Alpha-only white tip when colour is null. */
export function makeTip(size: number, hardness: number, color: string | null): HTMLCanvasElement {
  const d = Math.max(1, Math.ceil(size)) + 2;
  const c = createCanvas(d, d);
  const ctx = ctx2d(c);
  const r = size / 2;
  const cx = d / 2;
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.5, r));
  const col = color ?? '#ffffff';
  const [R, G, B] = hexToRgb(col).map((v) => Math.round(v * 255));
  const h = Math.min(0.98, Math.max(0, hardness));
  g.addColorStop(0, `rgba(${R},${G},${B},1)`);
  g.addColorStop(h, `rgba(${R},${G},${B},1)`);
  if (hardness < 1) {
    // smooth falloff
    for (let i = 1; i <= 4; i++) {
      const t = h + ((1 - h) * i) / 5;
      const a = Math.pow(1 - i / 5, 1.6);
      g.addColorStop(t, `rgba(${R},${G},${B},${a.toFixed(3)})`);
    }
  }
  g.addColorStop(1, `rgba(${R},${G},${B},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cx, Math.max(0.5, r), 0, Math.PI * 2);
  ctx.fill();
  return c;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Flood/colour-range selection. Returns an alpha mask (Uint8Array, 0/255) over `img`.
 * Tolerance compares the max channel difference (0..255) with the seed colour.
 */
export function colorRange(img: ImageData, sx: number, sy: number, tolerance: number, contiguous: boolean): Uint8Array {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const match = (i: number) => {
    const j = i * 4;
    return (
      Math.abs(data[j] - r0) <= tolerance &&
      Math.abs(data[j + 1] - g0) <= tolerance &&
      Math.abs(data[j + 2] - b0) <= tolerance &&
      Math.abs(data[j + 3] - a0) <= tolerance
    );
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (match(i)) out[i] = 255;
    return out;
  }
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * w + x;
    while (x >= 0 && !out[i] && match(i)) {
      x--;
      i--;
    }
    x++;
    i++;
    let up = false;
    let down = false;
    while (x < w && !out[i] && match(i)) {
      out[i] = 255;
      if (y > 0) {
        const u = i - w;
        if (!out[u] && match(u)) {
          if (!up) {
            stack.push(x, y - 1);
            up = true;
          }
        } else up = false;
      }
      if (y < h - 1) {
        const dn = i + w;
        if (!out[dn] && match(dn)) {
          if (!down) {
            stack.push(x, y + 1);
            down = true;
          }
        } else down = false;
      }
      x++;
      i++;
    }
  }
  return out;
}

/** Converts a 0/255 mask into a white alpha canvas. */
export function maskToCanvas(mask: Uint8Array, w: number, h: number, color = '#ffffff'): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(w, h);
  const [R, G, B] = hexToRgb(color).map((v) => Math.round(v * 255));
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const j = i * 4;
    img.data[j] = R;
    img.data[j + 1] = G;
    img.data[j + 2] = B;
    img.data[j + 3] = mask[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Spot healing: fills the painted region with texture from a nearby patch whose low-frequency
 * colour is corrected by solving a Laplace equation on the boundary difference (membrane blend).
 * `pixels` is the layer region (RGBA) and `weight` the painted coverage (0..1) of the same size.
 */
export function heal(pixels: ImageData, weight: Float32Array): ImageData {
  const { width: w, height: h, data } = pixels;
  const inside = new Uint8Array(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (weight[y * w + x] > 0.02) {
        inside[y * w + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  if (maxX < 0) return pixels;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // boundary band: outside pixels adjacent (within 2px) to the region
  const band: number[] = [];
  for (let y = Math.max(0, minY - 2); y <= Math.min(h - 1, maxY + 2); y++)
    for (let x = Math.max(0, minX - 2); x <= Math.min(w - 1, maxX + 2); x++) {
      const i = y * w + x;
      if (inside[i]) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && inside[yy * w + xx]) {
            near = true;
            break;
          }
        }
      if (near) band.push(i);
    }
  // search a source offset
  const R = Math.max(bw, bh);
  let best: [number, number] | null = null;
  let bestCost = Infinity;
  for (const k of [1.1, 1.5, 2.1]) {
    for (let a = 0; a < 16; a++) {
      const ox = Math.round(Math.cos((a / 16) * Math.PI * 2) * R * k);
      const oy = Math.round(Math.sin((a / 16) * Math.PI * 2) * R * k);
      if (minX + ox - 2 < 0 || minY + oy - 2 < 0 || maxX + ox + 2 >= w || maxY + oy + 2 >= h) continue;
      let cost = 0;
      for (const i of band) {
        const j = (i + oy * w + ox) * 4;
        const t = i * 4;
        const dr = data[t] - data[j];
        const dg = data[t + 1] - data[j + 1];
        const db = data[t + 2] - data[j + 2];
        cost += dr * dr + dg * dg + db * db;
      }
      // prefer texture similarity inside the source patch too (avoid copying the defect itself)
      if (cost < bestCost) {
        bestCost = cost;
        best = [ox, oy];
      }
    }
  }
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  if (!best) {
    // no room for a source patch: plain membrane fill
    best = [0, 0];
  }
  const [ox, oy] = best;
  // D = target - source on the boundary; harmonic interpolation inside
  const x0 = Math.max(0, minX - 1);
  const y0 = Math.max(0, minY - 1);
  const x1 = Math.min(w - 1, maxX + 1);
  const y1 = Math.min(h - 1, maxY + 1);
  const gw = x1 - x0 + 1;
  const gh = y1 - y0 + 1;
  const useSource = !(ox === 0 && oy === 0);
  for (let c = 0; c < 3; c++) {
    const D = new Float32Array(gw * gh);
    const fixed = new Uint8Array(gw * gh);
    let mean = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const g = (y - y0) * gw + (x - x0);
        if (!inside[i]) {
          const src = useSource ? data[(i + oy * w + ox) * 4 + c] : 0;
          D[g] = data[i * 4 + c] - src;
          fixed[g] = 1;
          mean += D[g];
          n++;
        }
      }
    mean = n ? mean / n : 0;
    for (let g = 0; g < D.length; g++) if (!fixed[g]) D[g] = mean;
    const iters = Math.min(600, 60 + Math.round(Math.max(gw, gh) * 3));
    for (let it = 0; it < iters; it++) {
      for (let y = 1; y < gh - 1; y++)
        for (let x = 1; x < gw - 1; x++) {
          const g = y * gw + x;
          if (fixed[g]) continue;
          const avg = (D[g - 1] + D[g + 1] + D[g - gw] + D[g + gw]) * 0.25;
          D[g] += 1.85 * (avg - D[g]);
        }
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (!inside[i]) continue;
        const g = (y - y0) * gw + (x - x0);
        const src = useSource ? data[(i + oy * w + ox) * 4 + c] : 0;
        const healed = src + D[g];
        const wgt = Math.min(1, weight[i]);
        out.data[i * 4 + c] = data[i * 4 + c] * (1 - wgt) + healed * wgt;
      }
  }
  return out;
}
