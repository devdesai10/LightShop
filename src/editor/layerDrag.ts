// Dragging layers between documents, as in Photoshop: drag with the Move tool (or a row of the Layers panel) onto
// another document's tab, wait a moment for it to open, and drop on its canvas; or drop on the tab itself. The
// layer is copied in as a new layer; the original stays where it was.

import { createStore } from '../state/store';
import { createCanvas, ctx2d } from '../lib/imageio';
import { importLayer, importPixels } from './actions';
import { EditorDoc, Layer, isPixel } from './doc';
import { editor } from './session';
import { abortMove, movePayload } from './tools';
import { getView } from './viewState';

/** Drag data type for Layers panel rows. */
export const LAYER_MIME = 'application/x-lightshop-layer';

export interface LayerPayload {
  src: EditorDoc;
  /** The whole layer, or null when dragging selected pixels. */
  layer: Layer | null;
  pixels: { canvas: HTMLCanvasElement; name: string } | null;
  /** What's dragged, in the source document's pixels. */
  bounds: { x: number; y: number; w: number; h: number };
  /** How it looks (mask applied), possibly reduced; drawn at `bounds` size. */
  preview: HTMLCanvasElement | null;
  opacity: number;
  /** Where the drag started in the source (the Move tool keeps this point under the pointer), or null to centre. */
  grab: { x: number; y: number } | null;
}

/** The drag in progress, and the document point under the pointer when it's over a canvas. */
export const layerDrag = createStore<{ payload: LayerPayload | null; over: { docId: string; x: number; y: number } | null }>({ payload: null, over: null });

const PREVIEW_EDGE = 1600;

function previewOf(canvas: HTMLCanvasElement, mask: HTMLCanvasElement | null, x: number, y: number): HTMLCanvasElement {
  const k = Math.min(1, PREVIEW_EDGE / Math.max(canvas.width, canvas.height));
  const c = createCanvas(canvas.width * k, canvas.height * k);
  const g = ctx2d(c);
  g.drawImage(canvas, 0, 0, c.width, c.height);
  if (mask) {
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, -x * k, -y * k, mask.width * k, mask.height * k);
  }
  return c;
}

export function layerPayload(doc: EditorDoc, layer: Layer, grab: { x: number; y: number } | null): LayerPayload {
  if (isPixel(layer)) {
    return {
      src: doc,
      layer,
      pixels: null,
      bounds: { x: layer.x, y: layer.y, w: layer.canvas.width, h: layer.canvas.height },
      preview: previewOf(layer.canvas, layer.mask && layer.maskEnabled ? layer.mask : null, layer.x, layer.y),
      opacity: layer.opacity,
      grab,
    };
  }
  return { src: doc, layer, pixels: null, bounds: { x: 0, y: 0, w: doc.width, h: doc.height }, preview: null, opacity: 1, grab };
}

/** Where the dragged thing's top-left lands for a drop at document point (x, y). */
export function dropOrigin(p: LayerPayload, x: number, y: number) {
  if (p.grab) return { x: Math.round(x - (p.grab.x - p.bounds.x)), y: Math.round(y - (p.grab.y - p.bounds.y)) };
  return { x: Math.round(x - p.bounds.w / 2), y: Math.round(y - p.bounds.h / 2) };
}

/**
 * Adds the dragged layer or pixels to `doc`: at a document point, centred, or ('auto') at the same place when
 * both documents are the same size. Dropping a Move tool drag back on its own document just moves the layer.
 */
export function dropInto(doc: EditorDoc, p: LayerPayload, at: { x: number; y: number } | 'center' | 'auto', index?: number) {
  const same = p.src.width === doc.width && p.src.height === doc.height;
  const o =
    typeof at === 'object'
      ? dropOrigin(p, at.x, at.y)
      : at === 'auto' && same
        ? { x: p.bounds.x, y: p.bounds.y }
        : { x: Math.round((doc.width - p.bounds.w) / 2), y: Math.round((doc.height - p.bounds.h) / 2) };
  if (doc === p.src && p.layer && isPixel(p.layer) && !p.pixels) {
    const l = p.layer;
    if (l.x === o.x && l.y === o.y) return;
    doc.commit('Move', () => {
      l.x = o.x;
      l.y = o.y;
    });
    return;
  }
  if (p.pixels) importPixels(doc, p.src, p.pixels.canvas, o.x, o.y, p.pixels.name, index);
  else if (p.layer) importLayer(doc, p.src, p.layer, o.x, o.y, index);
}

// ---------------------------------------------------------------- hovering a tab opens its document

const HOVER_MS = 450;
let hover: { id: string; timer: number } | null = null;

function markTab(id: string | null) {
  document.querySelectorAll('[data-doc-tab][data-drop-hover]').forEach((el) => el.removeAttribute('data-drop-hover'));
  if (id) document.querySelector(`[data-doc-tab="${CSS.escape(id)}"]`)?.setAttribute('data-drop-hover', '');
}

/** While dragging over a document tab: after a moment, `open` runs (by default it shows that document). */
export function hoverTab(id: string, open: () => void = () => editor.set({ activeDoc: id })) {
  if (hover?.id === id) return;
  clearTabHover();
  if (editor.get().activeDoc === id) return;
  markTab(id);
  hover = {
    id,
    timer: window.setTimeout(() => {
      hover = null;
      markTab(null);
      open();
    }, HOVER_MS),
  };
}

export function clearTabHover() {
  if (hover) clearTimeout(hover.timer);
  hover = null;
  markTab(null);
}

/** The document whose tab is at a screen point. */
export function tabAt(x: number, y: number): string | null {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-doc-tab]')?.dataset.docTab ?? null;
}

const docById = (id: string) => editor.get().docs.find((d) => d.id === id) ?? null;

/** The document canvas at a screen point and the document pixel there. */
export function canvasPointAt(x: number, y: number): { doc: EditorDoc; x: number; y: number } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-doc-view]');
  const doc = el && docById(el.dataset.docView!);
  if (!el || !doc) return null;
  const r = el.getBoundingClientRect();
  const v = getView(doc);
  return { doc, x: (x - r.left - v.panX) / v.zoom, y: (y - r.top - v.panY) / v.zoom };
}

function setOver(o: { docId: string; x: number; y: number } | null) {
  const prev = layerDrag.get().over;
  if (!o && !prev) return;
  layerDrag.set({ over: o });
  for (const id of new Set([prev?.docId, o?.docId])) if (id) docById(id)?.onRender.emit();
}

function endDrag() {
  clearTabHover();
  const { over } = layerDrag.get();
  layerDrag.set({ payload: null, over: null });
  if (over) docById(over.docId)?.onRender.emit();
}

// ---------------------------------------------------------------- Move tool drags

/** Ends the Move tool drag in `doc` (putting the layer back) and returns what it was dragging. */
function takeMove(doc: EditorDoc): LayerPayload | null {
  const m = movePayload();
  // Back where it started first: the payload's bounds are the layer's place before the drag.
  abortMove(doc);
  if (!m) return null;
  if (!m.pixels) return layerPayload(doc, m.layer, m.grab);
  const { canvas, x, y } = m.pixels;
  return { src: doc, layer: null, pixels: { canvas, name: m.layer.name }, bounds: { x, y, w: canvas.width, h: canvas.height }, preview: canvas, opacity: m.layer.opacity, grab: m.grab };
}

/** A Move tool drag released on another document's tab: copies what's dragged into it, centred (or in place). */
export function dropMoveOnTab(src: EditorDoc, targetId: string) {
  const target = docById(targetId);
  const p = takeMove(src);
  clearTabHover();
  if (!target || !p) return;
  editor.set({ activeDoc: target.id });
  dropInto(target, p, 'auto');
}

/**
 * Hands a Move tool drag over to the document `targetId`: the source layer goes back, that document is shown,
 * and the pointer now carries a copy until it's released over a canvas or a tab (Esc cancels).
 */
export function carryMoveTo(src: EditorDoc, targetId: string, at: { x: number; y: number }) {
  const p = takeMove(src);
  if (!p || !docById(targetId)) return;
  layerDrag.set({ payload: p, over: null });
  editor.set({ activeDoc: targetId });
  const track = (x: number, y: number) => {
    const tab = tabAt(x, y);
    if (tab) hoverTab(tab);
    else clearTabHover();
    const pt = canvasPointAt(x, y);
    setOver(pt ? { docId: pt.doc.id, x: pt.x, y: pt.y } : null);
  };
  const finish = (x: number, y: number, drop: boolean) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onCancel);
    if (drop) {
      const pt = canvasPointAt(x, y);
      const tab = tabAt(x, y);
      if (pt) dropInto(pt.doc, p, { x: pt.x, y: pt.y });
      else if (tab && docById(tab)) {
        editor.set({ activeDoc: tab });
        dropInto(docById(tab)!, p, 'auto');
      }
    }
    endDrag();
  };
  const onMove = (e: PointerEvent) => (e.buttons ? track(e.clientX, e.clientY) : finish(e.clientX, e.clientY, true));
  const onUp = (e: PointerEvent) => finish(e.clientX, e.clientY, true);
  const onCancel = () => finish(0, 0, false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(0, 0, false);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onCancel);
  // The new document's canvas appears on the next render; show the copy under the pointer as soon as it's there.
  requestAnimationFrame(() => layerDrag.get().payload === p && track(at.x, at.y));
}

// ---------------------------------------------------------------- Layers panel drags (HTML drag and drop)

export const isLayerDrag = (e: { dataTransfer: DataTransfer }) => e.dataTransfer.types.includes(LAYER_MIME);

/** Starts dragging a Layers panel row. */
export function beginRowDrag(e: React.DragEvent, doc: EditorDoc, layer: Layer) {
  const p = layerPayload(doc, layer, null);
  layerDrag.set({ payload: p, over: null });
  e.dataTransfer.setData(LAYER_MIME, layer.id);
  e.dataTransfer.setData('text/plain', layer.name);
  e.dataTransfer.effectAllowed = 'copyMove';
  // The row may be gone by the time the drag ends (another document's layers are showing), so listen on the
  // element itself rather than through React.
  const el = e.currentTarget as HTMLElement;
  const done = () => setTimeout(() => layerDrag.get().payload === p && endDrag(), 0);
  el.addEventListener('dragend', done, { once: true });
  window.addEventListener('drop', done, { once: true });
}

/** Drag over a canvas: shows where the layer would land. Returns false when it isn't a layer drag for here. */
export function rowDragOver(e: React.DragEvent, doc: EditorDoc): boolean {
  const p = layerDrag.get().payload;
  if (!p || !isLayerDrag(e) || p.src === doc) return false;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const pt = canvasPointAt(e.clientX, e.clientY);
  setOver(pt ? { docId: pt.doc.id, x: pt.x, y: pt.y } : null);
  return true;
}

export function rowDragLeave(e: React.DragEvent) {
  const to = e.relatedTarget as Node | null;
  if (!to || !(e.currentTarget as Node).contains(to)) setOver(null);
}

/** Drop on a canvas. Returns false when it wasn't a layer drag for this document. */
export function rowDrop(e: React.DragEvent, doc: EditorDoc): boolean {
  const p = layerDrag.get().payload;
  if (!p || !isLayerDrag(e) || p.src === doc) return false;
  e.preventDefault();
  e.stopPropagation();
  const pt = canvasPointAt(e.clientX, e.clientY);
  dropInto(doc, p, pt && pt.doc === doc ? { x: pt.x, y: pt.y } : 'center');
  endDrag();
  return true;
}

/** Document tabs: hovering opens the document, dropping copies the layer into it. */
export const tabDragProps = (id: string) => ({
  onDragEnter: (e: React.DragEvent) => {
    if (!isLayerDrag(e)) return;
    e.preventDefault();
    hoverTab(id);
  },
  onDragOver: (e: React.DragEvent) => {
    if (!isLayerDrag(e)) return;
    e.preventDefault();
    const p = layerDrag.get().payload;
    e.dataTransfer.dropEffect = p && p.src.id === id ? 'none' : 'copy';
    hoverTab(id);
  },
  onDragLeave: (e: React.DragEvent) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as Node).contains(to)) clearTabHover();
  },
  onDrop: (e: React.DragEvent) => {
    const p = layerDrag.get().payload;
    if (!p || !isLayerDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const doc = docById(id);
    clearTabHover();
    if (doc && doc !== p.src) {
      editor.set({ activeDoc: id });
      dropInto(doc, p, 'auto');
    }
    endDrag();
  },
});

/** Draws the dragged copy where it would land on `doc` (device pixels; the document's top-left at ox, oy). */
export function drawDropPreview(g: CanvasRenderingContext2D, doc: EditorDoc, ox: number, oy: number, z: number) {
  const { payload: p, over } = layerDrag.get();
  if (!p || !over || over.docId !== doc.id) return;
  const o = dropOrigin(p, over.x, over.y);
  const x = ox + o.x * z;
  const y = oy + o.y * z;
  const w = p.bounds.w * z;
  const h = p.bounds.h * z;
  g.save();
  if (p.preview) {
    g.globalAlpha = 0.8 * p.opacity;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(p.preview, x, y, w, h);
    g.globalAlpha = 1;
  }
  g.strokeStyle = 'rgba(61,139,253,0.95)';
  g.lineWidth = 1.5;
  g.setLineDash([6, 4]);
  g.strokeRect(x, y, w, h);
  g.restore();
}
