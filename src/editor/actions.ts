// Editor commands used by menus, panels, shortcuts and tools. All are undoable via doc.commit().

import { createCanvas, ctx2d } from '../lib/imageio';
import { uid } from '../lib/util';
import { toast } from '../state/app';
import { ADJ_LABELS, Adjustment, adjustmentFilter } from './adjust';
import { EditorDoc, Layer, PixelLayer, RasterLayer, Rect, isPixel, makeSelection, renderText } from './doc';
import { blendThroughMask } from './filters';

let clipboard: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;

function counterName(doc: EditorDoc, base: string) {
  let n = 1;
  const names = new Set(doc.layers.map((l) => l.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function whiteMask(doc: EditorDoc, fromSelection = false): HTMLCanvasElement {
  const m = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(m);
  if (fromSelection && doc.selection) ctx.drawImage(doc.selection.mask, 0, 0);
  else {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, m.width, m.height);
  }
  return m;
}

export function insertLayer(doc: EditorDoc, layer: Layer, label: string, index?: number) {
  doc.commit(label, () => {
    const at = index ?? doc.indexOf(doc.activeId) + 1;
    doc.layers = [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)];
    doc.activeId = layer.id;
    doc.editMask = false;
  });
}

export function newLayer(doc: EditorDoc) {
  insertLayer(doc, doc.newRaster(counterName(doc, 'Layer')), 'New Layer');
}

export function addAdjustmentLayer(doc: EditorDoc, adj: Adjustment) {
  const l = doc.newAdjust(counterName(doc, ADJ_LABELS[adj.type]), adj);
  l.mask = whiteMask(doc, !!doc.selection);
  insertLayer(doc, l, `New ${ADJ_LABELS[adj.type]} Layer`);
}

export function duplicateLayer(doc: EditorDoc) {
  const l = doc.active;
  if (!l) return;
  const copy: Layer = { ...structuredCloneLayer(l), id: crypto.randomUUID(), name: `${l.name} copy` };
  insertLayer(doc, copy, 'Duplicate Layer');
}

function cloneCanvas(c: HTMLCanvasElement) {
  const n = createCanvas(c.width, c.height);
  ctx2d(n).drawImage(c, 0, 0);
  return n;
}

function structuredCloneLayer(l: Layer): Layer {
  const base = { ...l, mask: l.mask ? cloneCanvas(l.mask) : null };
  if (l.kind === 'adjust') return { ...base, kind: 'adjust', adj: structuredClone(l.adj) } as Layer;
  if (l.kind === 'text') return { ...base, kind: 'text', text: { ...l.text }, canvas: cloneCanvas(l.canvas) } as Layer;
  return { ...base, kind: 'raster', canvas: cloneCanvas(l.canvas) } as Layer;
}

export function deleteLayer(doc: EditorDoc) {
  if (doc.layers.length <= 1) return toast('A document needs at least one layer');
  const i = doc.indexOf(doc.activeId);
  doc.commit('Delete Layer', () => {
    doc.layers = doc.layers.filter((l) => l.id !== doc.activeId);
    doc.activeId = doc.layers[Math.max(0, i - 1)].id;
    doc.editMask = false;
  });
}

export function moveLayer(doc: EditorDoc, from: number, to: number) {
  if (from === to || to < 0 || to >= doc.layers.length) return;
  doc.commit('Reorder Layers', () => {
    const list = [...doc.layers];
    const [l] = list.splice(from, 1);
    list.splice(to, 0, l);
    doc.layers = list;
  });
}

export function setLayerProps(doc: EditorDoc, id: string, patch: Partial<Layer>, label: string) {
  const l = doc.layer(id);
  if (!l) return;
  doc.commit(label, () => Object.assign(l, patch));
}

/** Renders a pixel layer (incl. mask, opacity ignored) into a doc-sized canvas. */
function layerToDoc(doc: EditorDoc, l: PixelLayer, applyMask = true): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  ctx.drawImage(l.canvas, l.x, l.y);
  if (applyMask && l.mask && l.maskEnabled) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(l.mask, 0, 0);
  }
  return c;
}

export function rasterizeLayer(doc: EditorDoc, label = 'Rasterize Type') {
  const l = doc.active;
  if (!l || l.kind !== 'text') return;
  doc.commit(label, () => {
    const r: RasterLayer = { ...l, kind: 'raster', canvas: cloneCanvas(l.canvas) } as unknown as RasterLayer;
    delete (r as unknown as { text?: unknown }).text;
    doc.layers = doc.layers.map((x) => (x.id === l.id ? r : x));
  });
}

export function mergeDown(doc: EditorDoc) {
  const i = doc.indexOf(doc.activeId);
  if (i <= 0) return;
  const top = doc.layers[i];
  const below = doc.layers[i - 1];
  if (!isPixel(below)) return toast('The layer below must be a pixel layer');
  doc.commit('Merge Down', () => {
    const c = layerToDoc(doc, below);
    const ctx = ctx2d(c);
    const tmp = doc.temp('merge');
    // composite top onto below only (respecting top's blend/opacity/mask)
    const sub = new EditorDoc('tmp', doc.width, doc.height);
    sub.layers = [{ ...doc.newRaster('b', c), visible: true }, { ...top, visible: true }];
    sub.renderInto(tmp);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(tmp, 0, 0);
    const merged: RasterLayer = { ...doc.newRaster(below.name, c), opacity: below.opacity, blend: below.blend, visible: below.visible };
    doc.layers = [...doc.layers.slice(0, i - 1), merged, ...doc.layers.slice(i + 1)];
    doc.activeId = merged.id;
    doc.editMask = false;
  });
}

export function mergeVisible(doc: EditorDoc) {
  doc.commit('Merge Visible', () => {
    const c = createCanvas(doc.width, doc.height);
    doc.renderInto(c);
    const merged = doc.newRaster('Merged', c);
    const firstVisible = doc.layers.findIndex((l) => l.visible);
    const keep = doc.layers.filter((l) => !l.visible);
    keep.splice(Math.max(0, Math.min(keep.length, firstVisible)), 0, merged);
    doc.layers = keep;
    doc.activeId = merged.id;
    doc.editMask = false;
  });
}

export function flattenImage(doc: EditorDoc) {
  doc.commit('Flatten Image', () => {
    const c = doc.flatten('#ffffff');
    const l = doc.newRaster('Background', c);
    doc.layers = [l];
    doc.activeId = l.id;
    doc.editMask = false;
  });
}

// ---------------------------------------------------------------- masks
export function addLayerMask(doc: EditorDoc, mode: 'reveal' | 'hide' | 'selection') {
  const l = doc.active;
  if (!l) return;
  if (l.mask) return toast('This layer already has a mask');
  doc.commit('Add Layer Mask', () => {
    const m = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(m);
    if (mode === 'reveal') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, m.width, m.height);
    } else if (mode === 'selection' && doc.selection) ctx.drawImage(doc.selection.mask, 0, 0);
    l.mask = m;
    l.maskEnabled = true;
    doc.editMask = true;
  });
}

export function deleteLayerMask(doc: EditorDoc, apply: boolean) {
  const l = doc.active;
  if (!l?.mask) return;
  doc.commit(apply ? 'Apply Layer Mask' : 'Delete Layer Mask', () => {
    if (apply && isPixel(l)) {
      const c = layerToDoc(doc, l);
      (l as RasterLayer).canvas = c;
      (l as RasterLayer).x = 0;
      (l as RasterLayer).y = 0;
      if (l.kind === 'text') {
        const r = l as unknown as RasterLayer;
        r.kind = 'raster';
      }
    }
    l.mask = null;
    doc.editMask = false;
  });
}

export function invertMask(doc: EditorDoc) {
  const l = doc.active;
  if (!l?.mask) return;
  doc.commit('Invert Mask', () => {
    const m = createCanvas(doc.width, doc.height);
    const ctx = ctx2d(m);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, m.width, m.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(l.mask!, 0, 0);
    l.mask = m;
  });
}

// ---------------------------------------------------------------- selection
export function selectAll(doc: EditorDoc) {
  const m = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(m);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, m.width, m.height);
  doc.setSelection(makeSelection(m, { x: 0, y: 0, w: doc.width, h: doc.height }), 'Select All');
}

export function deselect(doc: EditorDoc) {
  doc.setSelection(null, 'Deselect');
}

export function invertSelection(doc: EditorDoc) {
  const m = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(m);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, m.width, m.height);
  if (doc.selection) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(doc.selection.mask, 0, 0);
  }
  doc.setSelection(makeSelection(m), 'Inverse');
}

export function featherSelection(doc: EditorDoc, radius: number) {
  if (!doc.selection) return;
  const m = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(m);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(doc.selection.mask, 0, 0);
  doc.setSelection(makeSelection(m), 'Feather');
}

export function selectLayerPixels(doc: EditorDoc) {
  const l = doc.active;
  if (!isPixel(l)) return;
  doc.setSelection(makeSelection(layerToDoc(doc, l)), 'Load Selection');
}

// ---------------------------------------------------------------- clipboard & fill
function activePixel(doc: EditorDoc): PixelLayer | null {
  const l = doc.active;
  if (!isPixel(l)) {
    toast('Select a pixel layer first');
    return null;
  }
  return l;
}

export function copySelection(doc: EditorDoc, merged = false): boolean {
  const src = merged ? doc.flatten() : (() => {
    const l = activePixel(doc);
    return l ? layerToDoc(doc, l) : null;
  })();
  if (!src) return false;
  const r: Rect = doc.selection?.bounds ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  const c = createCanvas(r.w, r.h);
  const ctx = ctx2d(c);
  ctx.drawImage(src, -r.x, -r.y);
  if (doc.selection) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(doc.selection.mask, -r.x, -r.y);
  }
  clipboard = { canvas: c, x: r.x, y: r.y };
  c.toBlob((b) => {
    if (b && navigator.clipboard && 'ClipboardItem' in window) navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).catch(() => {});
  }, 'image/png');
  return true;
}

export function clearSelection(doc: EditorDoc, label = 'Clear') {
  const l = doc.active;
  if (!l) return;
  if (doc.editMask && l.mask) {
    fillMask(doc, false);
    return;
  }
  if (!isPixel(l) || l.kind === 'text') return toast(l.kind === 'text' ? 'Rasterize the type layer first' : 'Select a pixel layer first');
  doc.commit(label, () => {
    const c = cloneCanvas(l.canvas);
    const ctx = ctx2d(c);
    if (doc.selection) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(doc.selection.mask, -l.x, -l.y);
    } else ctx.clearRect(0, 0, c.width, c.height);
    l.canvas = c;
  });
}

export function cutSelection(doc: EditorDoc) {
  if (copySelection(doc)) clearSelection(doc, 'Cut');
}

export function pasteCanvas(doc: EditorDoc, c: HTMLCanvasElement, x?: number, y?: number, name = 'Pasted Layer') {
  const px = x ?? Math.round((doc.width - c.width) / 2);
  const py = y ?? Math.round((doc.height - c.height) / 2);
  insertLayer(doc, doc.newRaster(name, c, px, py), 'Paste');
}

export function pasteInternal(doc: EditorDoc): boolean {
  if (!clipboard) return false;
  pasteCanvas(doc, cloneCanvas(clipboard.canvas), clipboard.x, clipboard.y);
  return true;
}

function fillMask(doc: EditorDoc, reveal: boolean) {
  const l = doc.active!;
  doc.commit(reveal ? 'Fill Mask' : 'Clear Mask', () => {
    const m = cloneCanvas(l.mask!);
    const ctx = ctx2d(m);
    ctx.globalCompositeOperation = reveal ? 'source-over' : 'destination-out';
    if (doc.selection) ctx.drawImage(doc.selection.mask, 0, 0);
    else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, m.width, m.height);
    }
    l.mask = m;
  });
}

export function fillSelection(doc: EditorDoc, color: string, opacity = 1) {
  const l = doc.active;
  if (!l) return;
  if (doc.editMask && l.mask) return fillMask(doc, true);
  if (!isPixel(l) || l.kind === 'text') return toast('Select a pixel layer first');
  doc.commit('Fill', () => {
    const c = ensureCovers(doc, l);
    const ctx = ctx2d(c.canvas);
    const shape = createCanvas(doc.width, doc.height);
    const s = ctx2d(shape);
    s.fillStyle = color;
    s.fillRect(0, 0, shape.width, shape.height);
    if (doc.selection) {
      s.globalCompositeOperation = 'destination-in';
      s.drawImage(doc.selection.mask, 0, 0);
    }
    ctx.globalAlpha = opacity;
    ctx.drawImage(shape, -c.x, -c.y);
    Object.assign(l, c);
  });
}

/** New canvas for `l` that covers the full document (keeps pixels outside). Returns canvas & offset. */
export function ensureCovers(doc: EditorDoc, l: PixelLayer): { canvas: HTMLCanvasElement; x: number; y: number } {
  const x0 = Math.min(l.x, 0);
  const y0 = Math.min(l.y, 0);
  const x1 = Math.max(l.x + l.canvas.width, doc.width);
  const y1 = Math.max(l.y + l.canvas.height, doc.height);
  const c = createCanvas(x1 - x0, y1 - y0);
  ctx2d(c).drawImage(l.canvas, l.x - x0, l.y - y0);
  return { canvas: c, x: x0, y: y0 };
}

export function coversDoc(doc: EditorDoc, l: PixelLayer) {
  return l.x <= 0 && l.y <= 0 && l.x + l.canvas.width >= doc.width && l.y + l.canvas.height >= doc.height;
}

// ---------------------------------------------------------------- filters & adjustments
/** Applies a canvas->canvas function to the active layer (or its mask), honouring the selection. */
export function applyToActive(doc: EditorDoc, label: string, f: (c: HTMLCanvasElement) => HTMLCanvasElement) {
  const l = doc.active;
  if (!l) return;
  if (doc.editMask && l.mask) {
    doc.commit(label, () => {
      const res = f(l.mask!);
      l.mask = doc.selection ? blendThroughMask(l.mask!, res, doc.selection.mask, 0, 0) : res;
    });
    return;
  }
  if (!isPixel(l)) return toast('Filters apply to pixel layers. Select a pixel layer or a layer mask.');
  doc.commit(label, () => {
    let target: PixelLayer = l;
    if (l.kind === 'text') {
      const r = { ...l, kind: 'raster' } as unknown as RasterLayer;
      delete (r as unknown as { text?: unknown }).text;
      doc.layers = doc.layers.map((x) => (x.id === l.id ? r : x));
      target = r;
    }
    const res = f(target.canvas);
    target.canvas = doc.selection ? blendThroughMask(target.canvas, res, doc.selection.mask, target.x, target.y) : res;
  });
}

export function applyAdjustmentDestructive(doc: EditorDoc, adj: Adjustment) {
  const filter = adjustmentFilter(adj);
  applyToActive(doc, ADJ_LABELS[adj.type], (c) => {
    const out = createCanvas(c.width, c.height);
    const ctx = ctx2d(out);
    ctx.filter = filter;
    ctx.drawImage(c, 0, 0);
    return out;
  });
}

// ---------------------------------------------------------------- image / canvas
function transformAll(doc: EditorDoc, label: string, nw: number, nh: number, mapLayer: (c: HTMLCanvasElement, x: number, y: number) => { canvas: HTMLCanvasElement; x: number; y: number }, mapMask: (m: HTMLCanvasElement) => HTMLCanvasElement) {
  doc.commit(label, () => {
    doc.width = nw;
    doc.height = nh;
    for (const l of doc.layers) {
      if (isPixel(l)) {
        const r = mapLayer(l.canvas, l.x, l.y);
        l.canvas = r.canvas;
        l.x = r.x;
        l.y = r.y;
        if (l.kind === 'text') (l as unknown as RasterLayer).kind = 'raster';
      }
      if (l.mask) l.mask = mapMask(l.mask);
    }
    doc.selection = null;
  });
}

export function rotateCanvas(doc: EditorDoc, deg: 90 | -90 | 180) {
  const W = doc.width;
  const H = doc.height;
  const swap = deg !== 180;
  const nw = swap ? H : W;
  const nh = swap ? W : H;
  const rot = (c: HTMLCanvasElement, x: number, y: number) => {
    const out = createCanvas(swap ? c.height : c.width, swap ? c.width : c.height);
    const ctx = ctx2d(out);
    let nx: number, ny: number;
    if (deg === 90) {
      ctx.translate(out.width, 0);
      ctx.rotate(Math.PI / 2);
      nx = H - (y + c.height);
      ny = x;
    } else if (deg === -90) {
      ctx.translate(0, out.height);
      ctx.rotate(-Math.PI / 2);
      nx = y;
      ny = W - (x + c.width);
    } else {
      ctx.translate(out.width, out.height);
      ctx.rotate(Math.PI);
      nx = W - (x + c.width);
      ny = H - (y + c.height);
    }
    ctx.drawImage(c, 0, 0);
    return { canvas: out, x: nx, y: ny };
  };
  transformAll(doc, deg === 180 ? 'Rotate 180°' : deg === 90 ? 'Rotate 90° CW' : 'Rotate 90° CCW', nw, nh, rot, (m) => rot(m, 0, 0).canvas);
}

export function flipCanvas(doc: EditorDoc, axis: 'h' | 'v') {
  const W = doc.width;
  const H = doc.height;
  const flip = (c: HTMLCanvasElement, x: number, y: number) => {
    const out = createCanvas(c.width, c.height);
    const ctx = ctx2d(out);
    if (axis === 'h') {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, c.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(c, 0, 0);
    return { canvas: out, x: axis === 'h' ? W - (x + c.width) : x, y: axis === 'v' ? H - (y + c.height) : y };
  };
  transformAll(doc, axis === 'h' ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', W, H, flip, (m) => flip(m, 0, 0).canvas);
}

export function flipLayer(doc: EditorDoc, axis: 'h' | 'v') {
  const l = doc.active;
  if (!isPixel(l)) return;
  doc.commit(axis === 'h' ? 'Flip Layer Horizontal' : 'Flip Layer Vertical', () => {
    const out = createCanvas(l.canvas.width, l.canvas.height);
    const ctx = ctx2d(out);
    if (axis === 'h') {
      ctx.translate(out.width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, out.height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(l.canvas, 0, 0);
    l.canvas = out;
    if (l.kind === 'text') (l as unknown as RasterLayer).kind = 'raster';
  });
}

export function resizeImage(doc: EditorDoc, nw: number, nh: number) {
  const sx = nw / doc.width;
  const sy = nh / doc.height;
  const scale = (c: HTMLCanvasElement, x: number, y: number) => {
    const out = createCanvas(Math.max(1, Math.round(c.width * sx)), Math.max(1, Math.round(c.height * sy)));
    const ctx = ctx2d(out);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, out.width, out.height);
    return { canvas: out, x: Math.round(x * sx), y: Math.round(y * sy) };
  };
  transformAll(doc, 'Image Size', nw, nh, scale, (m) => scale(m, 0, 0).canvas);
}

export function resizeCanvas(doc: EditorDoc, nw: number, nh: number, ax: number, ay: number) {
  const dx = Math.round((nw - doc.width) * ax);
  const dy = Math.round((nh - doc.height) * ay);
  transformAll(
    doc,
    'Canvas Size',
    nw,
    nh,
    (c, x, y) => ({ canvas: c, x: x + dx, y: y + dy }),
    (m) => {
      const out = createCanvas(nw, nh);
      const ctx = ctx2d(out);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, nw, nh);
      ctx.clearRect(dx, dy, m.width, m.height);
      ctx.drawImage(m, dx, dy);
      return out;
    },
  );
}

export function cropDoc(doc: EditorDoc, r: Rect, label = 'Crop') {
  const rx = Math.round(r.x);
  const ry = Math.round(r.y);
  const rw = Math.max(1, Math.round(r.w));
  const rh = Math.max(1, Math.round(r.h));
  transformAll(
    doc,
    label,
    rw,
    rh,
    (c, x, y) => ({ canvas: c, x: x - rx, y: y - ry }),
    (m) => {
      const out = createCanvas(rw, rh);
      ctx2d(out).drawImage(m, -rx, -ry);
      return out;
    },
  );
}

export function cropToSelection(doc: EditorDoc) {
  if (!doc.selection) return toast('Make a selection first');
  cropDoc(doc, doc.selection.bounds, 'Crop to Selection');
}

/** A pixel layer's new canvas and position after a canvas change. */
export interface LayerPlacement {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  /** Type layers become pixels (their canvas was resampled). */
  rasterize: boolean;
}

/**
 * Gives the document a new size, layer canvases/positions and masks (worked out beforehand, see expand.ts),
 * plus an optional new top layer, as one undoable step.
 */
export function applyCanvasChange(
  doc: EditorDoc,
  label: string,
  w: number,
  h: number,
  placements: Map<Layer, LayerPlacement>,
  masks: Map<Layer, HTMLCanvasElement>,
  add: RasterLayer | null,
) {
  doc.commit(label, () => {
    doc.width = w;
    doc.height = h;
    for (const l of doc.layers) {
      const p = placements.get(l);
      if (p && isPixel(l)) {
        l.canvas = p.canvas;
        l.x = p.x;
        l.y = p.y;
        if (p.rasterize && l.kind === 'text') (l as unknown as RasterLayer).kind = 'raster';
      }
      const m = masks.get(l);
      if (m) l.mask = m;
    }
    doc.selection = null;
    if (add) {
      doc.layers = [...doc.layers, add];
      doc.activeId = add.id;
      doc.editMask = false;
    }
  });
}

/**
 * Adds a copy of `layer` from document `src` to `doc` (one undoable step). Pixel layers get their top-left at
 * (x, y); an adjustment layer's mask is placed as if the source canvas's top-left were at (x, y).
 */
export function importLayer(doc: EditorDoc, src: EditorDoc, layer: Layer, x: number, y: number, index?: number) {
  const copy = { ...structuredCloneLayer(layer), id: uid('l'), name: importedName(doc, src, layer.name) } as Layer;
  const ox = isPixel(layer) ? layer.x : 0;
  const oy = isPixel(layer) ? layer.y : 0;
  if (isPixel(copy)) {
    copy.x = x;
    copy.y = y;
  }
  if (layer.mask) {
    // Masks are document-sized: move this one with the layer, revealing everything it didn't cover.
    const dx = x - ox;
    const dy = y - oy;
    const m = createCanvas(doc.width, doc.height);
    const g = ctx2d(m);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, m.width, m.height);
    g.clearRect(dx, dy, src.width, src.height);
    g.drawImage(layer.mask, dx, dy);
    copy.mask = m;
  }
  insertLayer(doc, copy, 'Drag Layer', index);
}

/** Adds pixels dragged from document `src` as a new layer with its top-left at (x, y). */
export function importPixels(doc: EditorDoc, src: EditorDoc, canvas: HTMLCanvasElement, x: number, y: number, name: string, index?: number) {
  insertLayer(doc, doc.newRaster(importedName(doc, src, name), canvas, x, y), 'Drag Layer', index);
}

/**
 * Name for a layer dragged in from `src`: its own, except that a Background (every opened photo has one)
 * takes the name of the document it came from. Numbered when `doc` already has a layer by that name.
 */
function importedName(doc: EditorDoc, src: EditorDoc, name: string) {
  const base = name === 'Background' && src !== doc ? src.name || 'Layer' : name;
  const names = new Set(doc.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Updates a text layer's properties (re-renders its pixels). */
export function updateText(doc: EditorDoc, id: string, patch: Partial<import('./doc').TextProps>, label = 'Edit Type') {
  const l = doc.layer(id);
  if (!l || l.kind !== 'text') return;
  doc.commit(label, () => {
    l.text = { ...l.text, ...patch };
    l.canvas = renderText(l.text);
    l.name = l.text.text.split('\n')[0].slice(0, 32) || 'Text';
  });
}
