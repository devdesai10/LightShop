// Per-document viewport state (zoom/pan). Zoom is CSS pixels per document pixel; "100%" means one
// document pixel per device pixel, like Photoshop on high-DPI displays.

import type { EditorDoc, Rect } from './doc';
import type { View } from './tools';

/** `auto` views keep fitting the window until the user zooms or pans. */
type StoredView = View & { auto: boolean; vpw: number; vph: number; bounds: string };

const views = new WeakMap<EditorDoc, StoredView>();
/** Extra area a view must be able to show besides the canvas, e.g. a crop box reaching past it. */
const extents = new WeakMap<EditorDoc, Rect>();
let vp = { w: 800, h: 600 };

export const dpr = () => window.devicePixelRatio || 1;

export function setViewportSize(w: number, h: number) {
  vp = { w, h };
}

/** The canvas plus any extent, in document pixels. */
function boundsOf(doc: EditorDoc): Rect {
  const e = extents.get(doc);
  if (!e) return { x: 0, y: 0, w: doc.width, h: doc.height };
  const x0 = Math.min(0, e.x);
  const y0 = Math.min(0, e.y);
  return { x: x0, y: y0, w: Math.max(doc.width, e.x + e.w) - x0, h: Math.max(doc.height, e.y + e.h) - y0 };
}
const boundsKey = (b: Rect) => `${b.x},${b.y},${b.w},${b.h}`;

function fitted(doc: EditorDoc): StoredView {
  const b = boundsOf(doc);
  const z = Math.max(0.01, Math.min((vp.w - 48) / b.w, (vp.h - 48) / b.h, 1));
  return { zoom: z, panX: (vp.w - b.w * z) / 2 - b.x * z, panY: (vp.h - b.h * z) / 2 - b.y * z, auto: true, vpw: vp.w, vph: vp.h, bounds: boundsKey(b) };
}

export function getView(doc: EditorDoc): View {
  let v = views.get(doc);
  if (!v || (v.auto && (v.vpw !== vp.w || v.vph !== vp.h || v.bounds !== boundsKey(boundsOf(doc))))) {
    v = fitted(doc);
    views.set(doc, v);
  }
  return v;
}

export function setView(doc: EditorDoc, patch: Partial<View>, anchor?: { sx: number; sy: number }) {
  const v = getView(doc);
  const next: StoredView = { ...(v as StoredView), ...patch, auto: false, vpw: vp.w, vph: vp.h };
  if (patch.zoom !== undefined && anchor) {
    const dx = (anchor.sx - v.panX) / v.zoom;
    const dy = (anchor.sy - v.panY) / v.zoom;
    next.panX = anchor.sx - dx * next.zoom;
    next.panY = anchor.sy - dy * next.zoom;
  }
  // The document (with any extent) always covers the middle of the window, so a fast trackpad swipe can't
  // fling it out of sight (like Photoshop); it can still be moved until an edge reaches the centre.
  const b = boundsOf(doc);
  const cx = vp.w / 2;
  const cy = vp.h / 2;
  next.panX = Math.min(cx - b.x * next.zoom, Math.max(cx - (b.x + b.w) * next.zoom, next.panX));
  next.panY = Math.min(cy - b.y * next.zoom, Math.max(cy - (b.y + b.h) * next.zoom, next.panY));
  views.set(doc, next);
  doc.onRender.emit();
}

export function fitView(doc: EditorDoc) {
  views.set(doc, fitted(doc));
  doc.onRender.emit();
}

/**
 * Lets the view show `r` (document pixels) besides the canvas, or only the canvas again when null. Zooms out
 * to fit when `r` isn't fully visible; a fitted view follows the extent by itself.
 */
export function setViewExtent(doc: EditorDoc, r: Rect | null) {
  const v = views.get(doc);
  if (r) extents.set(doc, { ...r });
  else extents.delete(doc);
  const m = 12;
  const shows = (s: StoredView, q: Rect) =>
    q.x * s.zoom + s.panX >= m && q.y * s.zoom + s.panY >= m && (q.x + q.w) * s.zoom + s.panX <= vp.w - m && (q.y + q.h) * s.zoom + s.panY <= vp.h - m;
  if (!v || (r && !shows(v, r)) || (!r && v.auto)) views.set(doc, fitted(doc));
  // Otherwise the view stays where it is (still following window resizes if it was fitted).
  else v.bounds = boundsKey(boundsOf(doc));
  doc.onRender.emit();
}

export function zoomBy(doc: EditorDoc, f: number) {
  const v = getView(doc);
  setView(doc, { zoom: Math.min(64, Math.max(0.01, v.zoom * f)) }, { sx: vp.w / 2, sy: vp.h / 2 });
}

export function setActualPixels(doc: EditorDoc) {
  setView(doc, { zoom: 1 / dpr() }, { sx: vp.w / 2, sy: vp.h / 2 });
}

/** Re-fits after edits that change the document size (crop, canvas size). */
export function refit(doc: EditorDoc) {
  views.delete(doc);
  doc.onRender.emit();
}
