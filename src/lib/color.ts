// Color math shared by the UI, develop pipeline setup and editor.

export type RGB = [number, number, number]; // 0..1

export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const t = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${t(r)}${t(g)}${t(b)}`;
}

export function rgb255ToHex(r: number, g: number, b: number) {
  return rgbToHex(r / 255, g / 255, b / 255);
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear sRGB -> OKLab (Björn Ottosson's published matrices). */
export function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab hue angle (degrees) of an HSV hue at full saturation/value. */
export function oklabHueOfHsv(h: number): number {
  const [r, g, b] = hsvToRgb(h, 1, 1).map(srgbToLinear) as RGB;
  const [, A, B] = linearToOklab(r, g, b);
  let deg = (Math.atan2(B, A) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** Unit OKLab (a,b) direction for an HSV hue — used to tint along the hue shown in color wheels. */
export function oklabDirOfHsv(h: number): [number, number] {
  const [r, g, b] = hsvToRgb(h, 1, 1).map(srgbToLinear) as RGB;
  const [, A, B] = linearToOklab(r, g, b);
  const len = Math.hypot(A, B) || 1;
  return [A / len, B / len];
}

/** Sums photo white balance multipliers for relative temperature/tint (-100..100). */
export function wbMultipliers(temperature: number, tint: number): RGB {
  const t = temperature / 100;
  const u = tint / 100;
  const r = (1 + 0.3 * t) * (1 + 0.1 * u);
  const g = 1 - 0.2 * u;
  const b = (1 - 0.3 * t) * (1 + 0.1 * u);
  const n = luma(r, g, b);
  return [r / n, g / n, b / n];
}

/** Inverse of wbMultipliers: slider values that neutralise a linear RGB sample. */
export function wbForNeutral(r: number, g: number, b: number): { temperature: number; tint: number } {
  const eps = 1e-6;
  const t = (b - r) / (0.3 * (r + b) + eps);
  const tc = Math.max(-1, Math.min(1, t));
  const R = r * (1 + 0.3 * tc);
  const u = (g - R) / (0.2 * g + 0.1 * R + eps);
  return {
    temperature: Math.round(Math.max(-100, Math.min(100, tc * 100))),
    tint: Math.round(Math.max(-100, Math.min(100, u * 100))),
  };
}
