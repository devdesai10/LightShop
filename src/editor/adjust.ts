// Image adjustments (Photoshop-style) implemented as SVG filter chains, so they run on the canvas
// GPU path both for live adjustment layers and for destructive Image > Adjustments.

import { hexToRgb, hsvToRgb } from '../lib/color';
import { CurvePoint, curveTable } from '../lib/spline';

export type Adjustment =
  | { type: 'brightnessContrast'; brightness: number; contrast: number }
  | { type: 'levels'; inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
  | { type: 'curves'; master: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[] }
  | { type: 'exposure'; exposure: number; offset: number; gamma: number }
  | { type: 'hueSaturation'; hue: number; saturation: number; lightness: number; colorize: boolean }
  | { type: 'colorBalance'; shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number] }
  | { type: 'blackWhite'; red: number; green: number; blue: number; tint: boolean; tintColor: string }
  | { type: 'photoFilter'; color: string; density: number; preserve: boolean }
  | { type: 'channelMixer'; r: [number, number, number]; g: [number, number, number]; b: [number, number, number] }
  | { type: 'invert' }
  | { type: 'posterize'; levels: number }
  | { type: 'threshold'; level: number }
  | { type: 'gradientMap'; from: string; to: string };

export type AdjType = Adjustment['type'];

const ID: CurvePoint[] = [
  [0, 0],
  [1, 1],
];

export const ADJ_LABELS: Record<AdjType, string> = {
  brightnessContrast: 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  hueSaturation: 'Hue/Saturation',
  colorBalance: 'Color Balance',
  blackWhite: 'Black & White',
  photoFilter: 'Photo Filter',
  channelMixer: 'Channel Mixer',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  gradientMap: 'Gradient Map',
};

export function defaultAdjustment(type: AdjType): Adjustment {
  switch (type) {
    case 'brightnessContrast': return { type, brightness: 0, contrast: 0 };
    case 'levels': return { type, inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
    case 'curves': return { type, master: ID, red: ID, green: ID, blue: ID };
    case 'exposure': return { type, exposure: 0, offset: 0, gamma: 1 };
    case 'hueSaturation': return { type, hue: 0, saturation: 0, lightness: 0, colorize: false };
    case 'colorBalance': return { type, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] };
    case 'blackWhite': return { type, red: 30, green: 59, blue: 11, tint: false, tintColor: '#e1d3b3' };
    case 'photoFilter': return { type, color: '#ec8a00', density: 25, preserve: true };
    case 'channelMixer': return { type, r: [100, 0, 0], g: [0, 100, 0], b: [0, 0, 100] };
    case 'invert': return { type };
    case 'posterize': return { type, levels: 4 };
    case 'threshold': return { type, level: 128 };
    case 'gradientMap': return { type, from: '#000000', to: '#ffffff' };
  }
}

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const table = (f: (x: number) => number, n = 256) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(c01(f(i / (n - 1))).toFixed(4));
  return out.join(' ');
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const enc = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function transfer(r: string, g = r, b = g, type = 'table') {
  return `<feComponentTransfer><feFuncR type="${type}" tableValues="${r}"/><feFuncG type="${type}" tableValues="${g}"/><feFuncB type="${type}" tableValues="${b}"/></feComponentTransfer>`;
}
const LUMA = '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0';

/** SVG filter primitives for an adjustment. */
export function adjustmentPrimitives(a: Adjustment): string {
  switch (a.type) {
    case 'brightnessContrast': {
      const g = Math.pow(2, -a.brightness / 100);
      const k = a.contrast >= 0 ? 1 + a.contrast / 50 : 1 + a.contrast / 100;
      return transfer(table((x) => 0.5 + (Math.pow(x, g) - 0.5) * k));
    }
    case 'levels': {
      const ib = a.inBlack / 255;
      const iw = Math.max(ib + 1 / 255, a.inWhite / 255);
      const ob = a.outBlack / 255;
      const ow = a.outWhite / 255;
      return transfer(table((x) => ob + (ow - ob) * Math.pow(c01((x - ib) / (iw - ib)), 1 / a.gamma)));
    }
    case 'curves': {
      const m = curveTable(a.master);
      const ch = (pts: CurvePoint[]) => {
        const t = curveTable(pts);
        return Array.from({ length: 256 }, (_, i) => t[Math.round(m[i] * 255)].toFixed(4)).join(' ');
      };
      return transfer(ch(a.red), ch(a.green), ch(a.blue));
    }
    case 'exposure': {
      const k = Math.pow(2, a.exposure);
      return transfer(table((x) => enc(Math.pow(c01(lin(x) * k + a.offset), 1 / a.gamma))));
    }
    case 'hueSaturation': {
      let s = '';
      if (a.colorize) {
        const [r, g, b] = hsvToRgb(a.hue < 0 ? a.hue + 360 : a.hue, Math.max(0, (a.saturation + 100) / 200), 1);
        const lr = 0.2126, lg = 0.7152, lb = 0.0722;
        const n = lr * r + lg * g + lb * b || 1;
        const row = (c: number) => `${(lr * c) / n} ${(lg * c) / n} ${(lb * c) / n} 0 0`;
        s += `<feColorMatrix type="matrix" values="${row(r)} ${row(g)} ${row(b)} 0 0 0 1 0"/>`;
      } else {
        if (a.hue) s += `<feColorMatrix type="hueRotate" values="${a.hue}"/>`;
        if (a.saturation) s += `<feColorMatrix type="saturate" values="${Math.max(0, 1 + a.saturation / 100)}"/>`;
      }
      if (a.lightness) {
        const L = a.lightness / 100;
        const slope = L > 0 ? 1 - L : 1 + L;
        const icpt = L > 0 ? L : 0;
        s += `<feComponentTransfer><feFuncR type="linear" slope="${slope}" intercept="${icpt}"/><feFuncG type="linear" slope="${slope}" intercept="${icpt}"/><feFuncB type="linear" slope="${slope}" intercept="${icpt}"/></feComponentTransfer>`;
      }
      return s || '<feOffset dx="0" dy="0"/>';
    }
    case 'colorBalance': {
      const f = (i: 0 | 1 | 2) =>
        table((x) => {
          const ws = (1 - x) * (1 - x);
          const wh = x * x;
          const wm = 4 * x * (1 - x);
          return x + ((a.shadows[i] * ws + a.midtones[i] * wm + a.highlights[i] * wh) / 100) * 0.35;
        });
      return transfer(f(0), f(1), f(2));
    }
    case 'blackWhite': {
      const t = a.red + a.green + a.blue || 1;
      const w = [a.red / t, a.green / t, a.blue / t];
      const [tr, tg, tb] = a.tint ? hexToRgb(a.tintColor) : [1, 1, 1];
      const row = (c: number) => `${w[0] * c} ${w[1] * c} ${w[2] * c} 0 0`;
      return `<feColorMatrix type="matrix" values="${row(tr)} ${row(tg)} ${row(tb)} 0 0 0 1 0"/>`;
    }
    case 'photoFilter': {
      const [r, g, b] = hexToRgb(a.color);
      const d = a.density / 100;
      let m = [1 - d + d * r, 1 - d + d * g, 1 - d + d * b];
      if (a.preserve) {
        const l = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
        m = m.map((v) => v / l);
      }
      return `<feColorMatrix type="matrix" values="${m[0]} 0 0 0 0 0 ${m[1]} 0 0 0 0 0 ${m[2]} 0 0 0 0 0 1 0"/>`;
    }
    case 'channelMixer': {
      const row = (v: [number, number, number]) => `${v[0] / 100} ${v[1] / 100} ${v[2] / 100} 0 0`;
      return `<feColorMatrix type="matrix" values="${row(a.r)} ${row(a.g)} ${row(a.b)} 0 0 0 1 0"/>`;
    }
    case 'invert':
      return transfer('1 0');
    case 'posterize': {
      const n = Math.max(2, Math.min(255, Math.round(a.levels)));
      return transfer(Array.from({ length: n }, (_, i) => (i / (n - 1)).toFixed(4)).join(' '), undefined, undefined, 'discrete');
    }
    case 'threshold': {
      const t = Array.from({ length: 256 }, (_, i) => (i >= a.level ? '1' : '0')).join(' ');
      return `<feColorMatrix type="matrix" values="${LUMA}"/>` + transfer(t, t, t, 'discrete');
    }
    case 'gradientMap': {
      const [r0, g0, b0] = hexToRgb(a.from);
      const [r1, g1, b1] = hexToRgb(a.to);
      return `<feColorMatrix type="matrix" values="${LUMA}"/>` + transfer(`${r0} ${r1}`, `${g0} ${g1}`, `${b0} ${b1}`);
    }
  }
}

// ---------------------------------------------------------------- filter registry
const NS = 'http://www.w3.org/2000/svg';
let host: SVGSVGElement | null = null;
const registry = new Map<string, string>(); // primitives -> id
let counter = 0;

function svgHost(): SVGSVGElement {
  if (host) return host;
  host = document.createElementNS(NS, 'svg');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'absolute';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  return host;
}

/** Returns a CSS filter string (`url(#id)`) for SVG filter primitives, creating the element if needed. */
export function svgFilter(primitives: string): string {
  let id = registry.get(primitives);
  if (!id) {
    id = `lsf${++counter}`;
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0');
    f.setAttribute('y', '0');
    f.setAttribute('width', '1');
    f.setAttribute('height', '1');
    f.innerHTML = primitives;
    svgHost().appendChild(f);
    registry.set(primitives, id);
    if (registry.size > 300) {
      const [oldKey, oldId] = registry.entries().next().value as [string, string];
      registry.delete(oldKey);
      document.getElementById(oldId)?.remove();
    }
  }
  return `url(#${id})`;
}

export const adjustmentFilter = (a: Adjustment) => svgFilter(adjustmentPrimitives(a));

/** Draws `src` through a CSS/SVG filter into a new canvas of the same size. */
export function filteredCopy(src: HTMLCanvasElement, filter: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.filter = filter;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  return c;
}
