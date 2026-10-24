// Scale tool: resizes the active layer, or the selected pixels of a pixel layer, with handles around its
// content or by typed percentages. Each change is one undo step. Scaling the same layer again resamples from
// the pixels it had before the first scale, so shrinking it and enlarging it again doesn't blur it (as long as
// nothing else changed the layer in between). Type layers stay editable: they scale by font size.

import { toast } from '../state/app';
import { createCanvas, ctx2d } from '../lib/imageio';
import { EditorDoc, PixelLayer, RasterLayer, Rect, Selection, TextLayer, canvasRev, clipRect, isPixel, makeSelection, renderText } from './doc';

/** A scaled layer bigger than this (pixels, or pixels per side) keeps only the part over the canvas. */
const MAX_LAYER_PX = 64e6;
const MAX_SIDE = 16384;

/** A whole layer. `src`/`srcRect` are its pixels at 100 %; `box` is where its content is now (document pixels). */
interface LayerTarget {
  kind: 'layer';
  layer: PixelLayer;
  src: HTMLCanvasElement;
  srcRect: Rect;
  box: Rect;
  /** Type layers: the font size at 100 %. */
  size0?: number;
}
/** The selected pixels of a raster layer: `float` (document-sized) holds them, `base` the rest of the layer. */
interface PixelsTarget {
  kind: 'pixels';
  layer: RasterLayer;
  base: HTMLCanvasElement;
  float: HTMLCanvasElement;
  srcRect: Rect;
  /** The selection mask they were lifted with. */
  mask: HTMLCanvasElement;
  box: Rect;
}
export type ScaleTarget = LayerTarget | PixelsTarget;

/** How a layer canvas made by a scale relates to the pixels it came from. `rel` is the box, relative to the layer. */
interface LayerOrigin {
  src: HTMLCanvasElement;
  srcRect: Rect;
  rel: Rect;
  rev: number;
  size0?: number;
}
interface PixelsOrigin {
  base: HTMLCanvasElement;
  float: HTMLCanvasElement;
  srcRect: Rect;
  mask: HTMLCanvasElement;
  box: Rect;
  rev: number;
  selection: Selection;
}
const layerOrigins = new WeakMap<HTMLCanvasElement, LayerOrigin>();
const pixelOrigins = new WeakMap<HTMLCanvasElement, PixelsOrigin>();

export const isTextTarget = (t: ScaleTarget): t is LayerTarget & { layer: TextLayer } => t.kind === 'layer' && t.layer.kind === 'text';

// ---------------------------------------------------------------- what to scale

/** Bounds of the pixels with any opacity within `within` (default: all of `c`), or null when there are none. */
export function alphaBounds(c: HTMLCanvasElement, within?: Rect): Rect | null {
  const area = clipRect(within ?? { x: 0, y: 0, w: c.width, h: c.height }, { x: 0, y: 0, w: c.width, h: c.height });
  if (!area) return null;
  const g = ctx2d(c);
  const any = (x: number, y: number, w: number, h: number) => {
    const d = g.getImageData(x, y, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  };
  // Something on all four edges (the usual photo) means the bounds are the whole area.
  if (any(area.x, area.y, area.w, 1) && any(area.x, area.y + area.h - 1, area.w, 1) && any(area.x, area.y, 1, area.h) && any(area.x + area.w - 1, area.y, 1, area.h)) return area;
  const { w, h } = area;
  const d = g.getImageData(area.x, area.y, w, h).data;
  const rowEmpty = (y: number) => {
    for (let i = y * w * 4 + 3, end = i + w * 4; i < end; i += 4) if (d[i]) return false;
    return true;
  };
  let y0 = 0;
  while (y0 < h && rowEmpty(y0)) y0++;
  if (y0 === h) return null;
  let y1 = h - 1;
  while (y1 > y0 && rowEmpty(y1)) y1--;
  let x0 = w;
  let x1 = -1;
  for (let y = y0; y <= y1; y++) {
    const row = y * w * 4 + 3;
    for (let x = 0; x < x0; x++)
      if (d[row + x * 4]) {
        x0 = x;
        break;
      }
    for (let x = w - 1; x > x1; x--)
      if (d[row + x * 4]) {
        x1 = x;
        break;
      }
  }
  return { x: area.x + x0, y: area.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function layerTarget(l: PixelLayer): ScaleTarget | null {
  const o = layerOrigins.get(l.canvas);
  if (o && o.rev === canvasRev(l.canvas)) {
    return { kind: 'layer', layer: l, src: o.src, srcRect: o.srcRect, box: { x: l.x + o.rel.x, y: l.y + o.rel.y, w: o.rel.w, h: o.rel.h }, size0: o.size0 };
  }
  if (l.kind === 'text') {
    const r = { x: 0, y: 0, w: l.canvas.width, h: l.canvas.height };
    return { kind: 'layer', layer: l, src: l.canvas, srcRect: r, box: { x: l.x, y: l.y, w: r.w, h: r.h }, size0: l.text.size };
  }
  const b = alphaBounds(l.canvas);
  return b && { kind: 'layer', layer: l, src: l.canvas, srcRect: b, box: { x: l.x + b.x, y: l.y + b.y, w: b.w, h: b.h } };
}

function pixelsTarget(doc: EditorDoc, l: RasterLayer, sel: Selection): ScaleTarget | null {
  const o = pixelOrigins.get(l.canvas);
  if (o && o.rev === canvasRev(l.canvas) && o.selection === sel && l.x === 0 && l.y === 0) {
    return { kind: 'pixels', layer: l, base: o.base, float: o.float, srcRect: o.srcRect, mask: o.mask, box: { ...o.box } };
  }
  const float = createCanvas(doc.width, doc.height);
  const f = ctx2d(float);
  f.drawImage(l.canvas, l.x, l.y);
  f.globalCompositeOperation = 'destination-in';
  f.drawImage(sel.mask, 0, 0);
  const b = alphaBounds(float, sel.bounds);
  if (!b) return null;
  const base = createCanvas(doc.width, doc.height);
  const g = ctx2d(base);
  g.drawImage(l.canvas, l.x, l.y);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(sel.mask, 0, 0);
  return { kind: 'pixels', layer: l, base, float, srcRect: b, mask: sel.mask, box: { ...b } };
}

let cache: { key: unknown[]; target: ScaleTarget | null; reason: string } | null = null;

/** What the Scale tool resizes in `doc` right now, or why there's nothing (cached until the layer changes). */
export function scaleTarget(doc: EditorDoc): { target: ScaleTarget | null; reason: string } {
  const l = doc.active;
  const p = isPixel(l) ? l : null;
  const key = [doc, l, p?.canvas, p ? canvasRev(p.canvas) : 0, p?.x, p?.y, l?.kind, doc.selection, doc.width, doc.height];
  if (cache && cache.key.length === key.length && cache.key.every((v, i) => v === key[i])) return cache;
  let target: ScaleTarget | null = null;
  let reason = '';
  if (!l) reason = 'Select a layer to scale it.';
  else if (!p) reason = 'Adjustment layers have no pixels to scale. Select a pixel or type layer.';
  else if (doc.selection && p.kind === 'raster') {
    target = pixelsTarget(doc, p, doc.selection);
    if (!target) reason = 'The selection has no pixels on this layer.';
  } else {
    target = layerTarget(p);
    if (!target) reason = 'This layer is empty.';
  }
  cache = { key, target, reason };
  return cache;
}

/** Lets go of the cached target (its lifted pixels can be large). */
export function releaseScaleCache() {
  cache = null;
}

/** The scale of `box` relative to the target's pixels at 100 %. */
export function percentFor(t: ScaleTarget, box: Rect): { x: number; y: number } {
  if (isTextTarget(t)) {
    const k = (t.layer.text.size / (t.size0 ?? t.layer.text.size)) * (box.h / t.box.h);
    return { x: k, y: k };
  }
  return { x: box.w / t.srcRect.w, y: box.h / t.srcRect.h };
}

// ---------------------------------------------------------------- geometry

/**
 * The box while handle (hx, hy) of `s` (each -1, 0 or 1; 0 is an edge's middle) is dragged to (px, py).
 * The opposite edge or corner stays put, or the centre with `center`. `lock` keeps the proportions; an
 * edge handle then scales the other side about its middle. The box never flips or goes below 1 px.
 */
export function scaleBox(s: Rect, hx: number, hy: number, px: number, py: number, lock: boolean, center: boolean): Rect {
  const ax = center ? s.x + s.w / 2 : hx > 0 ? s.x : s.x + s.w;
  const ay = center ? s.y + s.h / 2 : hy > 0 ? s.y : s.y + s.h;
  const k = center ? 2 : 1;
  let w = hx ? Math.max(1, (px - ax) * hx * k) : s.w;
  let h = hy ? Math.max(1, (py - ay) * hy * k) : s.h;
  if (lock) {
    if (hx && hy) {
      if (w / s.w > h / s.h) h = (w * s.h) / s.w;
      else w = (h * s.w) / s.h;
    } else if (hx) h = (w * s.h) / s.w;
    else w = (h * s.w) / s.h;
  }
  const x = hx && !center ? (hx > 0 ? ax : ax - w) : s.x + s.w / 2 - w / 2;
  const y = hy && !center ? (hy > 0 ? ay : ay - h) : s.y + s.h / 2 - h / 2;
  return { x, y, w, h };
}

// ---------------------------------------------------------------- preview and apply

let previewCanvas: HTMLCanvasElement | null = null;

/** Shows the target scaled into `box` (a quick, live preview). */
export function previewScale(doc: EditorDoc, t: ScaleTarget, box: Rect) {
  const out = doc.temp('scale-preview');
  previewCanvas = out;
  const g = ctx2d(out);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'low';
  const s = t.srcRect;
  if (t.kind === 'pixels') {
    g.drawImage(t.base, 0, 0);
    g.drawImage(t.float, s.x, s.y, s.w, s.h, box.x, box.y, box.w, box.h);
  } else g.drawImage(t.src, s.x, s.y, s.w, s.h, box.x, box.y, box.w, box.h);
  doc.preview = { kind: 'replace', layerId: t.layer.id, canvas: out, x: 0, y: 0 };
  doc.invalidate();
}

/** Removes the live preview (if it's this tool's). */
export function cancelScalePreview(doc: EditorDoc) {
  if (doc.preview?.kind === 'replace' && doc.preview.canvas === previewCanvas) doc.preview = null;
  doc.invalidate();
}

/** Whole pixels: the size is rounded, and the side (or centre) that `anchor` keeps fixed stays where it is. */
function roundBox(r: Rect, anchor: { x: number; y: number }): Rect {
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  const place = (p: number, len: number, rounded: number, a: number) => (a <= 0 ? Math.round(p) : a >= 1 ? Math.round(p + len) - rounded : Math.round(p + len / 2 - rounded / 2));
  return { x: place(r.x, r.w, w, anchor.x), y: place(r.y, r.h, h, anchor.y), w, h };
}

/**
 * Scales (and/or moves) the target to `box` as one undo step. `anchor` is the fixed point of the box as
 * fractions (0 = left/top, 1 = right/bottom); a type layer re-rendered at its new size is aligned to it.
 * Returns false when nothing changed.
 */
export function commitScale(doc: EditorDoc, t: ScaleTarget, box: Rect, anchor = { x: 0.5, y: 0.5 }, label = 'Scale'): boolean {
  if (doc.preview?.kind === 'replace' && doc.preview.canvas === previewCanvas) doc.preview = null;
  const B = roundBox(box, anchor);
  const cur = roundBox(t.box, anchor);
  const resized = B.w !== cur.w || B.h !== cur.h;
  if (!resized && B.x === cur.x && B.y === cur.y) {
    doc.invalidate();
    return false;
  }
  const l = t.layer;
  if (l.locked) {
    toast('This layer is locked');
    doc.invalidate();
    return false;
  }
  if (t.kind === 'pixels') return commitPixels(doc, t, B, box, resized ? label : 'Move');
  if (!resized) {
    // A move: shift the layer without resampling it.
    const dx = B.x - cur.x;
    const dy = B.y - cur.y;
    doc.commit('Move', () => {
      l.x += dx;
      l.y += dy;
    });
    return true;
  }
  if (isTextTarget(t)) return commitText(doc, t, t.layer, box, anchor, label);
  return commitRaster(doc, t, l as RasterLayer, B, box, label);
}

// The pixels go to the rounded box B; the exact box is remembered (relative to the layer), so percentages
// and proportions don't drift with rounding from one scale to the next.

function commitRaster(doc: EditorDoc, t: LayerTarget, l: RasterLayer, B: Rect, exact: Rect, label: string): boolean {
  const s = t.srcRect;
  const big = B.w > MAX_SIDE || B.h > MAX_SIDE || B.w * B.h > MAX_LAYER_PX;
  const keep = big ? clipRect(B, { x: 0, y: 0, w: doc.width, h: doc.height }) : B;
  if (!keep) {
    toast('At that size the layer would be too large, and none of it would be over the canvas.', 'error');
    doc.invalidate();
    return false;
  }
  const c = createCanvas(keep.w, keep.h);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(t.src, s.x, s.y, s.w, s.h, B.x - keep.x, B.y - keep.y, B.w, B.h);
  doc.commit(label, () => {
    l.canvas = c;
    l.x = keep.x;
    l.y = keep.y;
  });
  layerOrigins.set(c, { src: t.src, srcRect: s, rel: { x: exact.x - keep.x, y: exact.y - keep.y, w: exact.w, h: exact.h }, rev: canvasRev(c) });
  if (big) toast(`At ${B.w.toLocaleString()} × ${B.h.toLocaleString()} px the whole layer would be too large, so only the part over the canvas was kept.`, 'info', 6000);
  return true;
}

function commitText(doc: EditorDoc, t: LayerTarget, l: TextLayer, box: Rect, anchor: { x: number; y: number }, label: string): boolean {
  const k = Math.sqrt((box.w / t.box.w) * (box.h / t.box.h));
  const size = Math.max(1, Math.round(l.text.size * k * 10) / 10);
  if (size === l.text.size) {
    doc.invalidate();
    return false;
  }
  const text = { ...l.text, size };
  const c = renderText(text);
  const x = Math.round(box.x + (box.w - c.width) * anchor.x);
  const y = Math.round(box.y + (box.h - c.height) * anchor.y);
  const size0 = t.size0 ?? l.text.size;
  doc.commit(label, () => {
    l.text = text;
    l.canvas = c;
    l.x = x;
    l.y = y;
  });
  const r = { x: 0, y: 0, w: c.width, h: c.height };
  layerOrigins.set(c, { src: c, srcRect: r, rel: r, rev: canvasRev(c), size0 });
  return true;
}

function commitPixels(doc: EditorDoc, t: PixelsTarget, B: Rect, exact: Rect, label: string): boolean {
  const F = t.srcRect;
  const l = t.layer;
  const out = createCanvas(doc.width, doc.height);
  const g = ctx2d(out);
  g.drawImage(t.base, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(t.float, F.x, F.y, F.w, F.h, B.x, B.y, B.w, B.h);
  // The selection goes with the pixels: the whole mask, mapped the same way.
  const sx = B.w / F.w;
  const sy = B.h / F.h;
  const m = createCanvas(doc.width, doc.height);
  const mg = ctx2d(m);
  mg.imageSmoothingEnabled = true;
  mg.imageSmoothingQuality = 'high';
  mg.setTransform(sx, 0, 0, sy, B.x - F.x * sx, B.y - F.y * sy);
  mg.drawImage(t.mask, 0, 0);
  const sel = makeSelection(m);
  doc.commit(label, () => {
    l.canvas = out;
    l.x = 0;
    l.y = 0;
    doc.selection = sel;
  });
  if (sel) pixelOrigins.set(out, { base: t.base, float: t.float, srcRect: F, mask: t.mask, box: { ...exact }, rev: canvasRev(out), selection: sel });
  return true;
}

// ---------------------------------------------------------------- typed sizes and fitting

/** Scales the target to `kx` × `ky` of its size at 100 %, about the centre of its box. */
export function setScale(doc: EditorDoc, kx: number, ky: number): boolean {
  const t = scaleTarget(doc).target;
  if (!t || !(kx > 0) || !(ky > 0)) return false;
  const k = percentFor(t, t.box);
  const w = t.box.w * (kx / k.x);
  const h = t.box.h * (ky / k.y);
  return commitScale(doc, t, { x: t.box.x + t.box.w / 2 - w / 2, y: t.box.y + t.box.h / 2 - h / 2, w, h });
}

/** Scales the target, keeping its proportions, to fit inside the canvas or to cover it, and centres it. */
export function fitToCanvas(doc: EditorDoc, mode: 'fit' | 'fill'): boolean {
  const t = scaleTarget(doc).target;
  if (!t) return false;
  const a = t.box.w / t.box.h;
  let w = doc.width;
  let h = w / a;
  if (mode === 'fit' ? h > doc.height : h < doc.height) {
    h = doc.height;
    w = h * a;
  }
  return commitScale(doc, t, { x: (doc.width - w) / 2, y: (doc.height - h) / 2, w, h }, { x: 0.5, y: 0.5 }, mode === 'fit' ? 'Fit to Canvas' : 'Fill Canvas');
}
