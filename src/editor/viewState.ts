// Per-document viewport state (zoom/pan). Zoom is CSS pixels per document pixel; "100%" means one
// document pixel per device pixel, like Photoshop on high-DPI displays.

import type { EditorDoc } from './doc';
import type { View } from './tools';

/** `auto` views keep fitting the window until the user zooms or pans. */
type StoredView = View & { auto: boolean; vpw: number; vph: number; dw: number; dh: number };

const views = new WeakMap<EditorDoc, StoredView>();
let vp = { w: 800, h: 600 };

export const dpr = () => window.devicePixelRatio || 1;

export function setViewportSize(w: number, h: number) {
  vp = { w, h };
}

function fitted(doc: EditorDoc): StoredView {
  const z = Math.max(0.01, Math.min((vp.w - 48) / doc.width, (vp.h - 48) / doc.height, 1));
  return { zoom: z, panX: (vp.w - doc.width * z) / 2, panY: (vp.h - doc.height * z) / 2, auto: true, vpw: vp.w, vph: vp.h, dw: doc.width, dh: doc.height };
}

export function getView(doc: EditorDoc): View {
  let v = views.get(doc);
  if (!v || (v.auto && (v.vpw !== vp.w || v.vph !== vp.h || v.dw !== doc.width || v.dh !== doc.height))) {
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
  // The document always covers the middle of the window, so a fast trackpad swipe can't fling it out of
  // sight (like Photoshop); it can still be moved until an edge reaches the centre.
  const cx = vp.w / 2;
  const cy = vp.h / 2;
  next.panX = Math.min(cx, Math.max(cx - doc.width * next.zoom, next.panX));
  next.panY = Math.min(cy, Math.max(cy - doc.height * next.zoom, next.panY));
  views.set(doc, next);
  doc.onRender.emit();
}

export function fitView(doc: EditorDoc) {
  views.set(doc, fitted(doc));
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
