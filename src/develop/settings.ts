import type { CurvePoint } from '../lib/spline';
import { deepClone, deepMerge, uid } from '../lib/util';

export interface Wheel {
  hue: number; // 0..360 (color-wheel hue)
  sat: number; // 0..100
  lum: number; // -100..100
}

export interface LocalAdjust {
  exposure: number; // EV -4..4
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  saturation: number;
  clarity: number;
}

export interface LocalMask {
  id: string;
  name: string;
  type: 'radial' | 'linear';
  enabled: boolean;
  invert: boolean;
  /** Geometry in source-image normalized coordinates (0..1). */
  radial: { cx: number; cy: number; rx: number; ry: number; angle: number; feather: number };
  linear: { x0: number; y0: number; x1: number; y1: number };
  adjust: LocalAdjust;
}

export type SpotMode = 'heal' | 'clone' | 'redeye';

/** A Touch Up spot (Lightroom-style spot removal / red eye), applied to the source before all other processing. */
export interface RetouchSpot {
  id: string;
  mode: SpotMode;
  /** Destination in source-image normalized coordinates (0..1): one point for a click, several for a brushed area. */
  path: [number, number][];
  /** Brush radius as a fraction of the image's long edge. */
  r: number;
  /** Offset from the destination to the source, normalized like `path` (unused by red eye). */
  dx: number;
  dy: number;
  feather: number; // 0..100
  opacity: number; // 0..100
  /** Pupil darkening for red eye, 0..100. */
  darken: number;
}

export interface DevelopSettings {
  version: 1;
  treatment: 'color' | 'bw';
  temperature: number; // -100..100 (relative)
  tint: number;
  exposure: number; // EV -5..5
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  curve: { master: CurvePoint[]; red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[] };
  hsl: { hue: number[]; sat: number[]; lum: number[] };
  grading: { shadows: Wheel; midtones: Wheel; highlights: Wheel; global: Wheel; blending: number; balance: number };
  sharpen: { amount: number; radius: number; detail: number; masking: number };
  noise: { luminance: number; color: number };
  vignette: { amount: number; midpoint: number; roundness: number; feather: number; highlights: number };
  grain: { amount: number; size: number; roughness: number };
  /** Crop rectangle in normalized coordinates of the straightened frame + straighten angle (degrees). */
  crop: { x: number; y: number; w: number; h: number; angle: number; aspect: number | null };
  orient: { rotate: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean };
  masks: LocalMask[];
  spots: RetouchSpot[];
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type SettingsPatch = DeepPartial<DevelopSettings>;

export const HSL_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
export const HSL_HUES = [0, 30, 60, 120, 180, 240, 270, 300];

const IDENTITY: CurvePoint[] = [
  [0, 0],
  [1, 1],
];
const wheel = (): Wheel => ({ hue: 0, sat: 0, lum: 0 });

export const DEFAULT_SETTINGS: DevelopSettings = Object.freeze({
  version: 1,
  treatment: 'color',
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  curve: { master: IDENTITY, red: IDENTITY, green: IDENTITY, blue: IDENTITY },
  hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] },
  grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
  sharpen: { amount: 0, radius: 1, detail: 25, masking: 0 },
  noise: { luminance: 0, color: 0 },
  vignette: { amount: 0, midpoint: 50, roundness: 0, feather: 50, highlights: 0 },
  grain: { amount: 0, size: 25, roughness: 50 },
  crop: { x: 0, y: 0, w: 1, h: 1, angle: 0, aspect: null },
  orient: { rotate: 0, flipH: false, flipV: false },
  masks: [],
  spots: [],
}) as DevelopSettings;

export function defaultSettings(): DevelopSettings {
  return deepClone(DEFAULT_SETTINGS);
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Validates a stored spot (arrays are replaced wholesale by deepMerge, so each one is checked here). */
function normalizeSpot(v: unknown): RetouchSpot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<RetouchSpot>;
  const path = Array.isArray(o.path)
    ? o.path.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [x, y] as [number, number])
    : [];
  if (!path.length) return null;
  return {
    id: typeof o.id === 'string' ? o.id : uid('s'),
    mode: o.mode === 'clone' || o.mode === 'redeye' ? o.mode : 'heal',
    path,
    r: num(o.r, 1e-4, 0.5, 0.01),
    dx: num(o.dx, -1, 1, 0),
    dy: num(o.dy, -1, 1, 0),
    feather: num(o.feather, 0, 100, 30),
    opacity: num(o.opacity, 0, 100, 100),
    darken: num(o.darken, 0, 100, 50),
  };
}

export function normalizeSettings(s: unknown): DevelopSettings {
  const out = deepMerge(defaultSettings(), s ?? {});
  out.spots = Array.isArray(out.spots) ? out.spots.map(normalizeSpot).filter((x): x is RetouchSpot => !!x) : [];
  return out;
}

export function applyPatch(s: DevelopSettings, patch: SettingsPatch): DevelopSettings {
  return deepMerge(s, patch);
}

export function defaultLocalAdjust(): LocalAdjust {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, saturation: 0, clarity: 0 };
}

export function newMask(type: 'radial' | 'linear', index: number): LocalMask {
  return {
    id: uid('m'),
    name: `${type === 'radial' ? 'Radial' : 'Linear'} ${index}`,
    type,
    enabled: true,
    invert: false,
    radial: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 50 },
    linear: { x0: 0.5, y0: 0.15, x1: 0.5, y1: 0.55 },
    adjust: { ...defaultLocalAdjust(), exposure: 0.5 },
  };
}

/** Settings that change the source-space processing passes (everything except geometry and effects). */
export function processingKey(s: DevelopSettings): string {
  const { crop: _c, orient: _o, vignette: _v, grain: _g, ...rest } = s;
  return JSON.stringify(rest);
}

/** Settings worth flagging as "edited" in the library. */
export function isEdited(s: DevelopSettings | null | undefined): boolean {
  if (!s) return false;
  return JSON.stringify(normalizeSettings(s)) !== JSON.stringify(DEFAULT_SETTINGS);
}

/** Keeps only the visual look (used for presets / copy-paste): drops geometry, local masks and touch-up spots. */
export function lookOnly(s: DevelopSettings): SettingsPatch {
  const { crop: _c, orient: _o, masks: _m, spots: _s, version: _v, ...rest } = deepClone(s);
  return rest;
}

export interface Preset {
  id: string;
  name: string;
  group: string;
  patch: SettingsPatch;
  builtin?: boolean;
}

const matte: CurvePoint[] = [
  [0, 0.1],
  [0.25, 0.24],
  [0.75, 0.8],
  [1, 0.95],
];
const fade: CurvePoint[] = [
  [0, 0.14],
  [0.5, 0.52],
  [1, 0.92],
];
const sCurve: CurvePoint[] = [
  [0, 0],
  [0.25, 0.2],
  [0.75, 0.82],
  [1, 1],
];

const p = (id: string, name: string, group: string, patch: SettingsPatch): Preset => ({ id, name, group, patch, builtin: true });

/** Starting points that reset the look before applying their own values. */
const base = (patch: SettingsPatch): SettingsPatch => deepMerge(lookOnly(defaultSettings()), patch);

export const BUILTIN_PRESETS: Preset[] = [
  p('b-auto-vivid', 'Vivid', 'Color', base({ contrast: 15, vibrance: 35, saturation: 8, clarity: 10, curve: { master: sCurve } })),
  p('b-landscape', 'Landscape Punch', 'Color', base({ dehaze: 15, clarity: 22, vibrance: 30, highlights: -45, shadows: 35, contrast: 10, whites: 10, blacks: -10 })),
  p('b-portrait', 'Soft Portrait', 'Color', base({ texture: -25, clarity: -12, vibrance: 10, highlights: -20, shadows: 12, temperature: 6, tint: 3 })),
  p('b-golden', 'Golden Hour', 'Color', base({ temperature: 28, tint: 8, vibrance: 22, highlights: -25, shadows: 10, grading: { highlights: { hue: 42, sat: 22, lum: 0 } } })),
  p('b-clean', 'Clean & Bright', 'Color', base({ exposure: 0.35, highlights: -30, shadows: 25, whites: 15, blacks: 5, vibrance: 15, clarity: 5 })),
  p('b-teal', 'Teal & Orange', 'Cinematic', base({ contrast: 20, saturation: -8, vibrance: 15, grading: { shadows: { hue: 190, sat: 28, lum: 0 }, highlights: { hue: 35, sat: 24, lum: 0 }, balance: 10 }, curve: { master: sCurve } })),
  p('b-moody', 'Moody', 'Cinematic', base({ exposure: -0.3, contrast: 22, highlights: -45, shadows: -8, blacks: -18, saturation: -22, clarity: 12, vignette: { amount: -28, midpoint: 45 }, grading: { shadows: { hue: 215, sat: 14, lum: 0 } } })),
  p('b-bleach', 'Bleach Bypass', 'Cinematic', base({ contrast: 35, saturation: -45, clarity: 25, highlights: -20, blacks: -15 })),
  p('b-matte', 'Matte', 'Film', base({ contrast: -8, saturation: -10, curve: { master: matte } })),
  p('b-warmfilm', 'Warm Film', 'Film', base({ temperature: 14, tint: 5, saturation: -6, curve: { master: matte }, grading: { shadows: { hue: 200, sat: 10, lum: 0 }, highlights: { hue: 40, sat: 16, lum: 0 } }, grain: { amount: 22, size: 30, roughness: 55 } })),
  p('b-vintage', 'Vintage Fade', 'Film', base({ temperature: 12, saturation: -25, contrast: -10, curve: { master: fade }, grading: { highlights: { hue: 50, sat: 16, lum: 0 }, shadows: { hue: 260, sat: 8, lum: 0 } }, vignette: { amount: -22 }, grain: { amount: 28, size: 35, roughness: 60 } })),
  p('b-bw-classic', 'B&W Classic', 'B&W', base({ treatment: 'bw', contrast: 22, clarity: 15 })),
  p('b-bw-high', 'B&W High Contrast', 'B&W', base({ treatment: 'bw', contrast: 55, whites: 20, blacks: -30, clarity: 28, grain: { amount: 15 } })),
  p('b-bw-soft', 'B&W Soft', 'B&W', base({ treatment: 'bw', contrast: -15, highlights: -25, shadows: 25, curve: { master: fade } })),
  p('b-bw-selenium', 'B&W Selenium', 'B&W', base({ treatment: 'bw', contrast: 20, grading: { shadows: { hue: 300, sat: 12, lum: 0 }, highlights: { hue: 40, sat: 8, lum: 0 } } })),
];
