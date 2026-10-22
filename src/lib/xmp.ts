// Interop with Lightroom/Camera Raw develop presets. Presets are XMP documents using the public
// `crs:` (camera-raw-settings) namespace, or legacy Lua `.lrtemplate` files with the same keys.
// Values map onto LightShop's own controls; rendering is LightShop's, so looks are close, not identical.

import type { CurvePoint } from './spline';
import { DevelopSettings, HSL_NAMES, SettingsPatch } from '../develop/settings';

const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Getter = (key: string) => string | undefined;
type CurveGetter = (key: string) => number[] | undefined;

function toPatch(get: Getter, curve: CurveGetter): SettingsPatch {
  const p: SettingsPatch = {};
  const num = (k: string): number | undefined => {
    const v = get(k);
    if (v === undefined || v === '') return undefined;
    const n = parseFloat(v.replace(/^\+/, ''));
    return isNaN(n) ? undefined : n;
  };
  const set = <K extends keyof DevelopSettings>(key: K, k: string, lo = -100, hi = 100) => {
    const v = num(k);
    if (v !== undefined) (p as Record<string, unknown>)[key] = clamp(v, lo, hi);
  };
  set('exposure', 'Exposure2012', -5, 5);
  if (p.exposure === undefined) set('exposure', 'Exposure', -5, 5);
  set('contrast', 'Contrast2012');
  set('highlights', 'Highlights2012');
  set('shadows', 'Shadows2012');
  set('whites', 'Whites2012');
  set('blacks', 'Blacks2012');
  set('texture', 'Texture');
  set('clarity', 'Clarity2012');
  if (p.clarity === undefined) set('clarity', 'Clarity');
  set('dehaze', 'Dehaze');
  set('vibrance', 'Vibrance');
  set('saturation', 'Saturation');
  set('temperature', 'IncrementalTemperature');
  set('tint', 'IncrementalTint');
  if (p.temperature === undefined) {
    const k = num('Temperature');
    if (k !== undefined) p.temperature = Math.round(clamp((k - 5500) / 40, -100, 100));
  }
  if (p.tint === undefined) {
    const t = num('Tint');
    if (t !== undefined) p.tint = Math.round(clamp(t * 0.66, -100, 100));
  }
  const gray = /^true$/i.test(get('ConvertToGrayscale') ?? '');
  if (get('ConvertToGrayscale') !== undefined) p.treatment = gray ? 'bw' : 'color';

  const arr = (prefix: string) => {
    const vals = HSL_NAMES.map((n) => num(prefix + n));
    return vals.some((v) => v !== undefined) ? vals.map((v) => clamp(v ?? 0, -100, 100)) : undefined;
  };
  const hue = arr('HueAdjustment');
  const sat = arr('SaturationAdjustment');
  const lum = gray ? (arr('GrayMixer') ?? arr('LuminanceAdjustment')) : arr('LuminanceAdjustment');
  if (hue || sat || lum) p.hsl = { ...(hue && { hue }), ...(sat && { sat }), ...(lum && { lum }) };

  const grading: NonNullable<SettingsPatch['grading']> = {};
  const wheel = (hk: string, sk: string, lk?: string) => {
    const h = num(hk);
    const s = num(sk);
    const l = lk ? num(lk) : undefined;
    if (h === undefined && s === undefined && l === undefined) return undefined;
    return { hue: clamp(h ?? 0, 0, 360), sat: clamp(s ?? 0, 0, 100), lum: clamp(l ?? 0, -100, 100) };
  };
  const sh = wheel('SplitToningShadowHue', 'SplitToningShadowSaturation', 'ColorGradeShadowLum');
  const hi = wheel('SplitToningHighlightHue', 'SplitToningHighlightSaturation', 'ColorGradeHighlightLum');
  const mid = wheel('ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum');
  const glob = wheel('ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum');
  if (sh) grading.shadows = sh;
  if (hi) grading.highlights = hi;
  if (mid) grading.midtones = mid;
  if (glob) grading.global = glob;
  const bal = num('SplitToningBalance');
  if (bal !== undefined) grading.balance = clamp(bal, -100, 100);
  const blend = num('ColorGradeBlending');
  if (blend !== undefined) grading.blending = clamp(blend, 0, 100);
  if (Object.keys(grading).length) p.grading = grading;

  const sharpen: NonNullable<SettingsPatch['sharpen']> = {};
  const sa = num('Sharpness');
  if (sa !== undefined) sharpen.amount = clamp(sa, 0, 150);
  const sr = num('SharpenRadius');
  if (sr !== undefined) sharpen.radius = clamp(sr, 0.5, 3);
  const sd = num('SharpenDetail');
  if (sd !== undefined) sharpen.detail = clamp(sd, 0, 100);
  const sm = num('SharpenEdgeMasking');
  if (sm !== undefined) sharpen.masking = clamp(sm, 0, 100);
  if (Object.keys(sharpen).length) p.sharpen = sharpen;

  const nl = num('LuminanceSmoothing');
  const nc = num('ColorNoiseReduction');
  if (nl !== undefined || nc !== undefined) p.noise = { ...(nl !== undefined && { luminance: clamp(nl, 0, 100) }), ...(nc !== undefined && { color: clamp(nc, 0, 100) }) };

  const vig: NonNullable<SettingsPatch['vignette']> = {};
  const vMap: [keyof DevelopSettings['vignette'], string, number, number][] = [
    ['amount', 'PostCropVignetteAmount', -100, 100],
    ['midpoint', 'PostCropVignetteMidpoint', 0, 100],
    ['roundness', 'PostCropVignetteRoundness', -100, 100],
    ['feather', 'PostCropVignetteFeather', 0, 100],
    ['highlights', 'PostCropVignetteHighlightContrast', 0, 100],
  ];
  for (const [key, k, lo, hi2] of vMap) {
    const v = num(k);
    if (v !== undefined) vig[key] = clamp(v, lo, hi2);
  }
  if (Object.keys(vig).length) p.vignette = vig;

  const grain: NonNullable<SettingsPatch['grain']> = {};
  const ga = num('GrainAmount');
  if (ga !== undefined) grain.amount = clamp(ga, 0, 100);
  const gs = num('GrainSize');
  if (gs !== undefined) grain.size = clamp(gs, 0, 100);
  const gf = num('GrainFrequency');
  if (gf !== undefined) grain.roughness = clamp(gf, 0, 100);
  if (Object.keys(grain).length) p.grain = grain;

  const toPts = (vals: number[] | undefined): CurvePoint[] | undefined => {
    if (!vals || vals.length < 4) return undefined;
    const pts: CurvePoint[] = [];
    for (let i = 0; i + 1 < vals.length; i += 2) pts.push([clamp(vals[i] / 255, 0, 1), clamp(vals[i + 1] / 255, 0, 1)]);
    return pts.length >= 2 ? pts : undefined;
  };
  const master = toPts(curve('ToneCurvePV2012'));
  const red = toPts(curve('ToneCurvePV2012Red'));
  const green = toPts(curve('ToneCurvePV2012Green'));
  const blue = toPts(curve('ToneCurvePV2012Blue'));
  if (master || red || green || blue) p.curve = { ...(master && { master }), ...(red && { red }), ...(green && { green }), ...(blue && { blue }) };
  return p;
}

export interface ImportedPreset {
  name: string;
  group: string;
  patch: SettingsPatch;
}

export function parseXmpPreset(text: string, fallbackName: string): ImportedPreset | null {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const descs = Array.from(doc.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description'));
  const attrs = new Map<string, string>();
  const curves = new Map<string, number[]>();
  let name: string | undefined;
  let group: string | undefined;
  for (const d of descs) {
    for (const a of Array.from(d.attributes)) if (a.namespaceURI === CRS_NS) attrs.set(a.localName, a.value);
    for (const el of Array.from(d.children)) {
      if (el.namespaceURI !== CRS_NS) continue;
      const lis = Array.from(el.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li'));
      if (el.localName.startsWith('ToneCurve') && lis.length) {
        curves.set(el.localName, lis.flatMap((li) => (li.textContent ?? '').split(',').map((v) => parseFloat(v))).filter((v) => !isNaN(v)));
      } else if (el.localName === 'Name' || el.localName === 'Group') {
        const t = (lis[0]?.textContent ?? el.textContent ?? '').trim();
        if (el.localName === 'Name') name = t;
        else group = t;
      } else if (!lis.length) {
        attrs.set(el.localName, (el.textContent ?? '').trim());
      }
    }
  }
  if (!attrs.size && !curves.size) return null;
  name ||= attrs.get('Name') || fallbackName;
  const patch = toPatch((k) => attrs.get(k), (k) => curves.get(k));
  if (!Object.keys(patch).length) return null;
  return { name, group: group || 'Imported', patch };
}

/** Legacy Lightroom `.lrtemplate` (Lua table) presets. */
export function parseLrTemplate(text: string, fallbackName: string): ImportedPreset | null {
  const settingsStart = text.indexOf('settings');
  if (settingsStart < 0) return null;
  const body = text.slice(settingsStart);
  const values = new Map<string, string>();
  const curves = new Map<string, number[]>();
  for (const m of body.matchAll(/(\w+)\s*=\s*\{([\d\s,.\-]*)\}/g)) {
    curves.set(m[1], m[2].split(',').map((v) => parseFloat(v)).filter((v) => !isNaN(v)));
  }
  for (const m of body.matchAll(/(\w+)\s*=\s*(-?[\d.]+|true|false|"[^"]*")/g)) {
    values.set(m[1], m[2].replace(/"/g, ''));
  }
  const title = /title\s*=\s*(?:ZSTR\s*)?["']([^"']+)["']/.exec(text)?.[1];
  const patch = toPatch((k) => values.get(k), (k) => curves.get(k));
  if (!Object.keys(patch).length) return null;
  return { name: title ?? fallbackName, group: 'Imported', patch };
}

export function parsePresetFile(name: string, text: string): ImportedPreset | null {
  const base = name.replace(/\.(xmp|lrtemplate)$/i, '');
  if (/\.lrtemplate$/i.test(name)) return parseLrTemplate(text, base);
  return parseXmpPreset(text, base);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const sgn = (v: number, d = 0) => (v > 0 ? `+${v.toFixed(d)}` : v.toFixed(d));

/** Serialises settings as a Camera Raw / Lightroom compatible XMP preset. */
export function exportXmpPreset(name: string, s: DevelopSettings): string {
  const a: [string, string][] = [
    ['PresetType', 'Normal'],
    ['UUID', Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()],
    ['SupportsAmount', 'False'],
    ['SupportsColor', 'True'],
    ['SupportsMonochrome', 'True'],
    ['SupportsHighDynamicRange', 'True'],
    ['SupportsNormalDynamicRange', 'True'],
    ['SupportsSceneReferred', 'True'],
    ['SupportsOutputReferred', 'True'],
    ['Version', '15.0'],
    ['ProcessVersion', '11.0'],
    ['Exposure2012', sgn(s.exposure, 2)],
    ['Contrast2012', sgn(s.contrast)],
    ['Highlights2012', sgn(s.highlights)],
    ['Shadows2012', sgn(s.shadows)],
    ['Whites2012', sgn(s.whites)],
    ['Blacks2012', sgn(s.blacks)],
    ['Texture', sgn(s.texture)],
    ['Clarity2012', sgn(s.clarity)],
    ['Dehaze', sgn(s.dehaze)],
    ['Vibrance', sgn(s.vibrance)],
    ['Saturation', sgn(s.saturation)],
    ['IncrementalTemperature', sgn(s.temperature)],
    ['IncrementalTint', sgn(s.tint)],
    ['ConvertToGrayscale', s.treatment === 'bw' ? 'True' : 'False'],
    ['Sharpness', String(Math.round(s.sharpen.amount))],
    ['SharpenRadius', sgn(s.sharpen.radius, 1)],
    ['SharpenDetail', String(Math.round(s.sharpen.detail))],
    ['SharpenEdgeMasking', String(Math.round(s.sharpen.masking))],
    ['LuminanceSmoothing', String(Math.round(s.noise.luminance))],
    ['ColorNoiseReduction', String(Math.round(s.noise.color))],
    ['PostCropVignetteAmount', sgn(s.vignette.amount)],
    ['PostCropVignetteMidpoint', String(Math.round(s.vignette.midpoint))],
    ['PostCropVignetteRoundness', sgn(s.vignette.roundness)],
    ['PostCropVignetteFeather', String(Math.round(s.vignette.feather))],
    ['PostCropVignetteHighlightContrast', String(Math.round(s.vignette.highlights))],
    ['PostCropVignetteStyle', '1'],
    ['GrainAmount', String(Math.round(s.grain.amount))],
    ['GrainSize', String(Math.round(s.grain.size))],
    ['GrainFrequency', String(Math.round(s.grain.roughness))],
    ['SplitToningShadowHue', String(Math.round(s.grading.shadows.hue))],
    ['SplitToningShadowSaturation', String(Math.round(s.grading.shadows.sat))],
    ['SplitToningHighlightHue', String(Math.round(s.grading.highlights.hue))],
    ['SplitToningHighlightSaturation', String(Math.round(s.grading.highlights.sat))],
    ['SplitToningBalance', sgn(s.grading.balance)],
    ['ColorGradeMidtoneHue', String(Math.round(s.grading.midtones.hue))],
    ['ColorGradeMidtoneSat', String(Math.round(s.grading.midtones.sat))],
    ['ColorGradeShadowLum', sgn(s.grading.shadows.lum)],
    ['ColorGradeMidtoneLum', sgn(s.grading.midtones.lum)],
    ['ColorGradeHighlightLum', sgn(s.grading.highlights.lum)],
    ['ColorGradeBlending', String(Math.round(s.grading.blending))],
    ['ColorGradeGlobalHue', String(Math.round(s.grading.global.hue))],
    ['ColorGradeGlobalSat', String(Math.round(s.grading.global.sat))],
    ['ColorGradeGlobalLum', sgn(s.grading.global.lum)],
  ];
  HSL_NAMES.forEach((n, i) => {
    a.push([`HueAdjustment${n}`, sgn(s.hsl.hue[i])]);
    a.push([`SaturationAdjustment${n}`, sgn(s.hsl.sat[i])]);
    a.push([`LuminanceAdjustment${n}`, sgn(s.hsl.lum[i])]);
    if (s.treatment === 'bw') a.push([`GrayMixer${n}`, sgn(s.hsl.lum[i])]);
  });
  a.push(['HasSettings', 'True']);
  const curve = (tag: string, pts: CurvePoint[]) =>
    `   <crs:${tag}>\n    <rdf:Seq>\n${pts.map(([x, y]) => `     <rdf:li>${Math.round(x * 255)}, ${Math.round(y * 255)}</rdf:li>`).join('\n')}\n    </rdf:Seq>\n   </crs:${tag}>`;
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="LightShop">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="${CRS_NS}"
${a.map(([k, v]) => `   crs:${k}="${esc(v)}"`).join('\n')}>
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${esc(name)}</rdf:li>
    </rdf:Alt>
   </crs:Name>
${curve('ToneCurvePV2012', s.curve.master)}
${curve('ToneCurvePV2012Red', s.curve.red)}
${curve('ToneCurvePV2012Green', s.curve.green)}
${curve('ToneCurvePV2012Blue', s.curve.blue)}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}
