// Destructive pixel filters (Filter menu). Each takes a canvas and returns a new canvas of equal size.

import { createCanvas, ctx2d } from '../lib/imageio';
import { hexToRgb } from '../lib/color';
import { svgFilter } from './adjust';

export interface FilterParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  def: number;
  unit?: string;
}

export interface FilterDef {
  id: string;
  label: string;
  group: string;
  params: FilterParam[];
  checks?: { key: string; label: string; def: boolean }[];
  /** Filters with no parameters run immediately. */
  run: (src: HTMLCanvasElement, p: Record<string, number>, flags: Record<string, boolean>, ctx: { fg: string; bg: string }) => HTMLCanvasElement;
}

/** Copy with edges replicated by `pad` pixels on each side (avoids dark borders when blurring). */
export function padded(src: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const c = createCanvas(w + pad * 2, h + pad * 2);
  const ctx = ctx2d(c);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, pad, pad);
  ctx.drawImage(src, 0, 0, 1, h, 0, pad, pad, h);
  ctx.drawImage(src, w - 1, 0, 1, h, w + pad, pad, pad, h);
  ctx.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  ctx.drawImage(src, 0, h - 1, w, 1, pad, h + pad, w, pad);
  ctx.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad);
  ctx.drawImage(src, w - 1, 0, 1, 1, w + pad, 0, pad, pad);
  ctx.drawImage(src, 0, h - 1, 1, 1, 0, h + pad, pad, pad);
  ctx.drawImage(src, w - 1, h - 1, 1, 1, w + pad, h + pad, pad, pad);
  return c;
}

export function gaussianBlur(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return copy(src);
  const pad = Math.ceil(radius * 3) + 2;
  const p = padded(src, pad);
  const b = createCanvas(p.width, p.height);
  const bctx = ctx2d(b);
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(p, 0, 0);
  const out = createCanvas(src.width, src.height);
  ctx2d(out).drawImage(b, pad, pad, src.width, src.height, 0, 0, src.width, src.height);
  return out;
}

function copy(src: HTMLCanvasElement) {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

function motionBlur(src: HTMLCanvasElement, angle: number, dist: number): HTMLCanvasElement {
  const pad = Math.ceil(dist) + 2;
  const p = padded(src, pad);
  const acc = createCanvas(p.width, p.height);
  const ctx = ctx2d(acc);
  const n = Math.max(2, Math.min(64, Math.round(dist)));
  const a = (angle * Math.PI) / 180;
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1) - 0.5) * dist;
    ctx.globalAlpha = 1 / (k + 1);
    ctx.drawImage(p, Math.cos(a) * t, -Math.sin(a) * t);
  }
  const out = createCanvas(src.width, src.height);
  ctx2d(out).drawImage(acc, pad, pad, src.width, src.height, 0, 0, src.width, src.height);
  return out;
}

function pixelOp(src: HTMLCanvasElement, f: (d: Uint8ClampedArray, o: Uint8ClampedArray | null) => void, other?: HTMLCanvasElement) {
  const out = copy(src);
  const ctx = ctx2d(out, true);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const o = other ? ctx2d(other, true).getImageData(0, 0, other.width, other.height).data : null;
  f(img.data, o);
  ctx.putImageData(img, 0, 0);
  return out;
}

function unsharp(src: HTMLCanvasElement, amount: number, radius: number, threshold: number) {
  const blurred = gaussianBlur(src, radius);
  const k = amount / 100;
  return pixelOp(
    src,
    (d, b) => {
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const diff = d[i + c] - b![i + c];
          if (Math.abs(diff) >= threshold) d[i + c] = d[i + c] + diff * k;
        }
      }
    },
    blurred,
  );
}

function highPass(src: HTMLCanvasElement, radius: number) {
  const blurred = gaussianBlur(src, radius);
  return pixelOp(
    src,
    (d, b) => {
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = 128 + d[i + c] - b![i + c];
    },
    blurred,
  );
}

function addNoise(src: HTMLCanvasElement, amount: number, gaussian: boolean, mono: boolean) {
  const a = (amount / 100) * 255;
  const rnd = gaussian
    ? () => {
        const u = Math.random() || 1e-9;
        const v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.5;
      }
    : () => Math.random() - 0.5;
  return pixelOp(src, (d) => {
    for (let i = 0; i < d.length; i += 4) {
      if (mono) {
        const n = rnd() * a;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
      } else {
        d[i] += rnd() * a;
        d[i + 1] += rnd() * a;
        d[i + 2] += rnd() * a;
      }
    }
  });
}

function pixelate(src: HTMLCanvasElement, cell: number) {
  const w = Math.max(1, Math.round(src.width / cell));
  const h = Math.max(1, Math.round(src.height / cell));
  const small = createCanvas(w, h);
  const sctx = ctx2d(small);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, 0, 0, w, h);
  const out = createCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, src.width, src.height);
  return out;
}

function svgRun(src: HTMLCanvasElement, primitives: string) {
  const out = createCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.filter = svgFilter(primitives);
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  return out;
}

const LUMA = '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0';

function clouds(src: HTMLCanvasElement, scale: number, fg: string, bg: string) {
  const [r0, g0, b0] = hexToRgb(fg);
  const [r1, g1, b1] = hexToRgb(bg);
  const out = createCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  const seed = Math.floor(Math.random() * 1000);
  ctx.filter = svgFilter(
    `<feTurbulence type="fractalNoise" baseFrequency="${(1 / scale).toFixed(5)}" numOctaves="6" seed="${seed}" result="t"/>` +
      `<feColorMatrix in="t" type="matrix" values="${LUMA.replace(/0 0 0 1 0$/, '0 0 0 0 1')}"/>` +
      `<feComponentTransfer><feFuncR type="table" tableValues="${r0} ${r1}"/><feFuncG type="table" tableValues="${g0} ${g1}"/><feFuncB type="table" tableValues="${b0} ${b1}"/></feComponentTransfer>`,
  );
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.filter = 'none';
  return out;
}

export const FILTERS: FilterDef[] = [
  { id: 'gaussian', label: 'Gaussian Blur…', group: 'Blur', params: [{ key: 'radius', label: 'Radius', min: 0.1, max: 100, step: 0.1, def: 4, unit: 'px' }], run: (s, p) => gaussianBlur(s, p.radius) },
  {
    id: 'motion',
    label: 'Motion Blur…',
    group: 'Blur',
    params: [
      { key: 'angle', label: 'Angle', min: -180, max: 180, def: 0, unit: '°' },
      { key: 'distance', label: 'Distance', min: 1, max: 200, def: 20, unit: 'px' },
    ],
    run: (s, p) => motionBlur(s, p.angle, p.distance),
  },
  {
    id: 'unsharp',
    label: 'Unsharp Mask…',
    group: 'Sharpen',
    params: [
      { key: 'amount', label: 'Amount', min: 1, max: 500, def: 100, unit: '%' },
      { key: 'radius', label: 'Radius', min: 0.1, max: 50, step: 0.1, def: 1.5, unit: 'px' },
      { key: 'threshold', label: 'Threshold', min: 0, max: 255, def: 0, unit: ' levels' },
    ],
    run: (s, p) => unsharp(s, p.amount, p.radius, p.threshold),
  },
  { id: 'sharpen', label: 'Sharpen', group: 'Sharpen', params: [], run: (s) => unsharp(s, 60, 0.8, 0) },
  { id: 'sharpen-more', label: 'Sharpen More', group: 'Sharpen', params: [], run: (s) => unsharp(s, 140, 1, 0) },
  {
    id: 'noise',
    label: 'Add Noise…',
    group: 'Noise',
    params: [{ key: 'amount', label: 'Amount', min: 0.1, max: 100, step: 0.1, def: 8, unit: '%' }],
    checks: [
      { key: 'gaussian', label: 'Gaussian distribution', def: true },
      { key: 'mono', label: 'Monochromatic', def: true },
    ],
    run: (s, p, f) => addNoise(s, p.amount, f.gaussian, f.mono),
  },
  { id: 'mosaic', label: 'Mosaic…', group: 'Pixelate', params: [{ key: 'cell', label: 'Cell size', min: 2, max: 200, def: 16, unit: 'px' }], run: (s, p) => pixelate(s, p.cell) },
  { id: 'emboss', label: 'Emboss', group: 'Stylize', params: [], run: (s) => svgRun(s, `<feColorMatrix type="matrix" values="${LUMA}"/><feConvolveMatrix order="3" kernelMatrix="-1 -1 0 -1 0 1 0 1 1" divisor="1" bias="0.5" preserveAlpha="true"/>`) },
  { id: 'edges', label: 'Find Edges', group: 'Stylize', params: [], run: (s) => svgRun(s, `<feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" divisor="1" preserveAlpha="true"/><feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>`) },
  { id: 'highpass', label: 'High Pass…', group: 'Other', params: [{ key: 'radius', label: 'Radius', min: 0.1, max: 100, step: 0.1, def: 10, unit: 'px' }], run: (s, p) => highPass(s, p.radius) },
  { id: 'clouds', label: 'Clouds…', group: 'Render', params: [{ key: 'scale', label: 'Scale', min: 10, max: 2000, def: 200, unit: 'px' }], run: (s, p, _f, c) => clouds(s, p.scale, c.fg, c.bg) },
];

/** result = orig*(1-m) + filtered*m, where m is the selection mask placed at (-ox,-oy) relative to the layer. */
export function blendThroughMask(orig: HTMLCanvasElement, filtered: HTMLCanvasElement, mask: HTMLCanvasElement, ox: number, oy: number): HTMLCanvasElement {
  const keep = createCanvas(orig.width, orig.height);
  const k = ctx2d(keep);
  k.drawImage(orig, 0, 0);
  k.globalCompositeOperation = 'destination-out';
  k.drawImage(mask, -ox, -oy);
  const f = createCanvas(orig.width, orig.height);
  const fc = ctx2d(f);
  fc.drawImage(filtered, 0, 0);
  fc.globalCompositeOperation = 'destination-in';
  fc.drawImage(mask, -ox, -oy);
  k.globalCompositeOperation = 'lighter';
  k.drawImage(f, 0, 0);
  return keep;
}
