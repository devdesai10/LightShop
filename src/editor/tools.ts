// Editor tools. Each tool receives pointer events in document coordinates and may draw an overlay.

import { checkerPattern, createCanvas, ctx2d } from '../lib/imageio';
import { rgb255ToHex } from '../lib/color';
import { toast } from '../state/app';
import { createStore } from '../state/store';
import { coversDoc, ensureCovers, insertLayer } from './actions';
import { EditorDoc, PixelLayer, RasterLayer, Rect, SelectMode, combineSelection, isPixel, makeSelection, selectionFromShape } from './doc';
import { ExpandFill, FILLS, cancelPreview, containBox, expandCanvas, isExpanding, presetById, previewFor, previewKey, requestPreview } from './expand';
import { colorRange, heal, makeTip, maskToCanvas, unionRect } from './paint';
import { ScaleTarget, cancelScalePreview, commitScale, isTextTarget, percentFor, previewScale, releaseScaleCache, scaleBox, scaleTarget } from './scale';
import { EditorState, ToolId, activeDoc, editor, openPhotoInEditor, setOpts, syncDoc } from './session';
import { getView, refit, setView, setViewExtent } from './viewState';

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ToolEvent {
  x: number;
  y: number;
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  pressure: number;
  pen: boolean;
  dbl?: boolean;
}

export interface ToolCtx {
  doc: EditorDoc;
  st: EditorState;
  view: View;
  setView: (v: Partial<View>, anchor?: { sx: number; sy: number }) => void;
  redraw: () => void;
  editText: (layerId: string | null, x: number, y: number) => void;
  hover: { x: number; y: number } | null;
}

export interface Tool {
  cursor: (c: ToolCtx) => string;
  down?: (e: ToolEvent, c: ToolCtx) => void;
  move?: (e: ToolEvent, c: ToolCtx) => void;
  up?: (e: ToolEvent, c: ToolCtx) => void;
  key?: (e: KeyboardEvent, c: ToolCtx) => boolean;
  overlay?: (g: CanvasRenderingContext2D, c: ToolCtx) => void;
  deactivate?: (c: ToolCtx) => void;
  /** The cursor depends on what's under the pointer, so it's asked again as the pointer moves. */
  liveCursor?: boolean;
}

const toScreen = (v: View, x: number, y: number): [number, number] => [x * v.zoom + v.panX, y * v.zoom + v.panY];

function selectMode(e: ToolEvent, base: SelectMode): SelectMode {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return base;
}

// ---------------------------------------------------------------- painting
type PaintKind = 'brush' | 'eraser' | 'clone' | 'heal';

interface StrokeState {
  kind: PaintKind;
  layer: PixelLayer | null;
  target: 'layer' | 'mask';
  maskLayerId: string;
  canvas: HTMLCanvasElement;
  tip: HTMLCanvasElement;
  alphaTip: HTMLCanvasElement | null;
  size: number;
  flow: number;
  opacity: number;
  erase: boolean;
  last: { x: number; y: number } | null;
  carry: number;
  bbox: Rect | null;
  cloneSrc?: HTMLCanvasElement;
  cloneOff?: { x: number; y: number };
  dabTmp?: HTMLCanvasElement;
}

let stroke: StrokeState | null = null;
let cloneAlignedOffset: { x: number; y: number } | null = null;

function luminanceOf(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function startStroke(kind: PaintKind, e: ToolEvent, c: ToolCtx) {
  const { doc, st } = c;
  const l = doc.active;
  if (!l) return;
  const o = kind === 'brush' ? st.opts.brush : kind === 'eraser' ? st.opts.eraser : kind === 'clone' ? st.opts.clone : { ...st.opts.heal, opacity: 1, flow: 1 };
  const onMask = (doc.editMask && !!l.mask) || (l.kind === 'adjust' && !!l.mask);
  if (!onMask && !isPixel(l)) {
    toast('Select a pixel layer or a layer mask to paint on');
    return;
  }
  if (kind === 'heal' && onMask) {
    toast('The healing brush works on pixel layers');
    return;
  }
  if (l.locked) {
    toast('This layer is locked');
    return;
  }
  let erase = kind === 'eraser';
  let color: string | null = st.fg;
  if (onMask && kind === 'brush') {
    const lum = luminanceOf(st.fg);
    erase = lum < 0.5;
    color = '#ffffff';
  }
  if (onMask && kind === 'eraser') {
    erase = luminanceOf(st.bg) < 0.5;
    color = '#ffffff';
  }
  if (kind === 'eraser' || kind === 'clone' || kind === 'heal') color = kind === 'clone' ? null : '#ffffff';
  const canvas = createCanvas(doc.width, doc.height);
  stroke = {
    kind,
    layer: isPixel(l) ? l : null,
    target: onMask ? 'mask' : 'layer',
    maskLayerId: l.id,
    canvas,
    tip: makeTip(o.size, o.hardness, color ?? '#ffffff'),
    alphaTip: kind === 'clone' ? makeTip(o.size, o.hardness, null) : null,
    size: o.size,
    flow: o.flow,
    opacity: kind === 'heal' ? 0.5 : o.opacity,
    erase,
    last: null,
    carry: 0,
    bbox: null,
  };
  if (kind === 'clone') {
    const srcPt = st.cloneSource;
    if (!srcPt) {
      toast('Alt-click (Option-click) to set the clone source first');
      stroke = null;
      return;
    }
    const aligned = st.opts.clone.aligned;
    const off = aligned && cloneAlignedOffset ? cloneAlignedOffset : { x: srcPt.x - e.x, y: srcPt.y - e.y };
    if (aligned) cloneAlignedOffset = off;
    stroke.cloneOff = off;
    const snap = createCanvas(doc.width, doc.height);
    const sctx = ctx2d(snap);
    if (st.opts.clone.sampleAll) sctx.drawImage(doc.getComposite(), 0, 0);
    else if (isPixel(l)) sctx.drawImage(l.canvas, l.x, l.y);
    stroke.cloneSrc = snap;
    stroke.dabTmp = createCanvas(stroke.tip.width, stroke.tip.height);
  }
  doc.preview = { kind: 'stroke', layerId: l.id, target: stroke.target, canvas, opacity: stroke.opacity, erase: stroke.erase };
  if (kind === 'heal') doc.preview = { kind: 'stroke', layerId: l.id, target: 'layer', canvas, opacity: 0.45, erase: false };
  dab(e.x, e.y, e.pen ? e.pressure : 1);
  stroke.last = { x: e.x, y: e.y };
  doc.invalidate();
}

function dab(x: number, y: number, pressure: number) {
  const s = stroke!;
  const ctx = ctx2d(s.canvas);
  const size = s.size * (0.25 + 0.75 * pressure);
  const d = s.tip.width * (size / s.size);
  const r = d / 2;
  ctx.globalAlpha = s.flow;
  if (s.kind === 'clone' && s.cloneSrc && s.cloneOff && s.dabTmp && s.alphaTip) {
    const t = s.dabTmp;
    const tc = ctx2d(t);
    tc.globalCompositeOperation = 'copy';
    tc.drawImage(s.cloneSrc, x + s.cloneOff.x - s.tip.width / 2, y + s.cloneOff.y - s.tip.height / 2, s.tip.width, s.tip.height, 0, 0, t.width, t.height);
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(s.alphaTip, 0, 0);
    ctx.drawImage(t, x - r, y - r, d, d);
  } else {
    ctx.drawImage(s.tip, x - r, y - r, d, d);
  }
  s.bbox = unionRect(s.bbox, { x: Math.floor(x - r - 1), y: Math.floor(y - r - 1), w: Math.ceil(d + 2), h: Math.ceil(d + 2) });
}

function strokeTo(e: ToolEvent, c: ToolCtx) {
  const s = stroke;
  if (!s || !s.last) return;
  const spacing = Math.max(1, s.size * 0.12);
  const dx = e.x - s.last.x;
  const dy = e.y - s.last.y;
  const dist = Math.hypot(dx, dy);
  let t = spacing - s.carry;
  while (t <= dist) {
    dab(s.last.x + (dx * t) / dist, s.last.y + (dy * t) / dist, e.pen ? e.pressure : 1);
    t += spacing;
  }
  s.carry = dist - (t - spacing);
  s.last = { x: e.x, y: e.y };
  c.doc.invalidate();
}

const LABELS: Record<PaintKind, string> = { brush: 'Brush Tool', eraser: 'Eraser', clone: 'Clone Stamp', heal: 'Spot Healing Brush' };

function endStroke(c: ToolCtx) {
  const s = stroke;
  stroke = null;
  const { doc } = c;
  doc.preview = null;
  if (!s || !s.bbox) {
    doc.invalidate();
    return;
  }
  const strokeImg = doc.clipToSelection(s.canvas, 'stroke-commit');
  const box = s.bbox;
  const label = LABELS[s.kind];
  if (s.kind === 'heal' && s.layer) return finishHeal(doc, s, strokeImg);
  const paint = (target: HTMLCanvasElement, ox: number, oy: number) => {
    const ctx = ctx2d(target);
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    ctx.drawImage(strokeImg, -ox, -oy);
    ctx.restore();
  };
  if (s.target === 'mask') {
    const l = doc.layer(s.maskLayerId);
    if (!l?.mask) return;
    doc.commitPatch(label, l.mask, box, () => paint(l.mask!, 0, 0));
    return;
  }
  const l = s.layer!;
  if (l.kind === 'text' || !coversDoc(doc, l)) {
    doc.commit(label, () => {
      const cov = ensureCovers(doc, l);
      paint(cov.canvas, cov.x, cov.y);
      if (l.kind === 'text') {
        const r = l as unknown as RasterLayer;
        r.kind = 'raster';
      }
      Object.assign(l, cov);
    });
    return;
  }
  doc.commitPatch(label, l.canvas, { x: box.x - l.x, y: box.y - l.y, w: box.w, h: box.h }, () => paint(l.canvas, l.x, l.y));
}

function finishHeal(doc: EditorDoc, s: StrokeState, strokeImg: HTMLCanvasElement) {
  const l = s.layer!;
  if (l.kind === 'text') return toast('Rasterize the type layer first');
  const pad = Math.ceil(s.size * 2.6) + 4;
  const b = s.bbox!;
  const rx = Math.max(0, b.x - l.x - pad);
  const ry = Math.max(0, b.y - l.y - pad);
  const rw = Math.min(l.canvas.width, b.x - l.x + b.w + pad) - rx;
  const rh = Math.min(l.canvas.height, b.y - l.y + b.h + pad) - ry;
  if (rw <= 0 || rh <= 0) return doc.invalidate();
  const lctx = ctx2d(l.canvas);
  const px = lctx.getImageData(rx, ry, rw, rh);
  const wctx = ctx2d(createCanvas(rw, rh), true);
  wctx.drawImage(strokeImg, -(rx + l.x), -(ry + l.y));
  const wd = wctx.getImageData(0, 0, rw, rh).data;
  const weight = new Float32Array(rw * rh);
  for (let i = 0; i < weight.length; i++) weight[i] = Math.min(1, (wd[i * 4 + 3] / 255) * 1.6);
  const healed = heal(px, weight);
  doc.commitPatch('Spot Healing Brush', l.canvas, { x: rx, y: ry, w: rw, h: rh }, () => lctx.putImageData(healed, rx, ry));
}

function brushOverlay(kind: PaintKind) {
  return (g: CanvasRenderingContext2D, c: ToolCtx) => {
    if (!c.hover) return;
    const o = kind === 'brush' ? c.st.opts.brush : kind === 'eraser' ? c.st.opts.eraser : kind === 'clone' ? c.st.opts.clone : c.st.opts.heal;
    const [sx, sy] = toScreen(c.view, c.hover.x, c.hover.y);
    const r = Math.max(1, (o.size / 2) * c.view.zoom);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.beginPath();
    g.arc(sx, sy, r + 0.5, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.arc(sx, sy, r - 0.5 > 0 ? r - 0.5 : r, 0, Math.PI * 2);
    g.stroke();
    if (kind === 'clone') {
      const srcPt = c.st.cloneSource;
      const off = stroke?.cloneOff ?? (c.st.opts.clone.aligned ? cloneAlignedOffset : null);
      const p = off ? { x: c.hover.x + off.x, y: c.hover.y + off.y } : srcPt;
      if (p) {
        const [qx, qy] = toScreen(c.view, p.x, p.y);
        g.strokeStyle = '#fff';
        g.beginPath();
        g.moveTo(qx - 7, qy);
        g.lineTo(qx + 7, qy);
        g.moveTo(qx, qy - 7);
        g.lineTo(qx, qy + 7);
        g.stroke();
        g.beginPath();
        g.arc(qx, qy, r, 0, Math.PI * 2);
        g.setLineDash([3, 3]);
        g.stroke();
        g.setLineDash([]);
      }
    }
  };
}

function paintTool(kind: PaintKind): Tool {
  return {
    cursor: () => 'none',
    down: (e, c) => {
      if (kind === 'clone' && e.alt) {
        editor.set({ cloneSource: { x: e.x, y: e.y } });
        cloneAlignedOffset = null;
        toast('Clone source set');
        return;
      }
      startStroke(kind, e, c);
    },
    move: (e, c) => strokeTo(e, c),
    up: (_e, c) => endStroke(c),
    overlay: brushOverlay(kind),
    deactivate: (c) => {
      if (stroke) endStroke(c);
    },
  };
}

// ---------------------------------------------------------------- selection tools
let dragStart: { x: number; y: number } | null = null;
let dragNow: { x: number; y: number } | null = null;
let dragMods: ToolEvent | null = null;
let lassoPts: { x: number; y: number }[] = [];

function marqueeRect(e: ToolEvent, constrain: boolean, fromCenter: boolean): Rect {
  const s = dragStart!;
  let w = e.x - s.x;
  let h = e.y - s.y;
  if (constrain) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  if (fromCenter) return { x: s.x - Math.abs(w), y: s.y - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
  return { x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + h), w: Math.abs(w), h: Math.abs(h) };
}

let marqueeLive: Rect | null = null;

const marquee: Tool = {
  cursor: () => 'crosshair',
  down: (e) => {
    dragStart = { x: e.x, y: e.y };
    dragNow = { x: e.x, y: e.y };
    dragMods = e;
    marqueeLive = null;
  },
  move: (e, c) => {
    if (!dragStart || !dragMods) return;
    dragNow = { x: e.x, y: e.y };
    // Shift held after the drag started constrains to a square/circle; Alt draws from the centre.
    marqueeLive = marqueeRect(e, e.shift && !dragMods.shift, e.alt && !dragMods.alt);
    c.redraw();
  },
  up: (e, c) => {
    if (!dragStart || !dragMods) return;
    const { doc, st } = c;
    const mode = selectMode(dragMods, st.opts.marquee.mode);
    const r = marqueeLive ?? marqueeRect(e, false, false);
    dragStart = null;
    dragNow = null;
    marqueeLive = null;
    if (r.w < 2 || r.h < 2) {
      if (mode === 'new' && doc.selection) doc.setSelection(null, 'Deselect');
      c.redraw();
      return;
    }
    const ellipse = st.opts.marquee.shape === 'ellipse';
    const shape = selectionFromShape(
      doc,
      (g) => {
        g.beginPath();
        if (ellipse) g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        else g.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
        g.fill();
      },
      st.opts.marquee.feather,
    );
    const f = st.opts.marquee.feather * 3;
    doc.setSelection(combineSelection(doc, shape, mode, { x: r.x - f, y: r.y - f, w: r.w + f * 2, h: r.h + f * 2 }), ellipse ? 'Elliptical Marquee' : 'Rectangular Marquee');
  },
  overlay: (g, c) => {
    if (!dragStart || !dragNow || !marqueeLive) return;
    const r = marqueeLive;
    const [x, y] = toScreen(c.view, r.x, r.y);
    g.setLineDash([4, 4]);
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath();
    if (c.st.opts.marquee.shape === 'ellipse') g.ellipse(x + (r.w * c.view.zoom) / 2, y + (r.h * c.view.zoom) / 2, (r.w * c.view.zoom) / 2, (r.h * c.view.zoom) / 2, 0, 0, Math.PI * 2);
    else g.rect(x + 0.5, y + 0.5, r.w * c.view.zoom, r.h * c.view.zoom);
    g.stroke();
    g.setLineDash([]);
  },
};

function finishLasso(c: ToolCtx, mods: ToolEvent) {
  const { doc, st } = c;
  const pts = lassoPts;
  lassoPts = [];
  if (pts.length < 3) {
    c.redraw();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const shape = selectionFromShape(
    doc,
    (g) => {
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fill();
    },
    st.opts.lasso.feather,
  );
  const f = st.opts.lasso.feather * 3;
  doc.setSelection(combineSelection(doc, shape, selectMode(mods, st.opts.lasso.mode), { x: minX - f, y: minY - f, w: maxX - minX + f * 2, h: maxY - minY + f * 2 }), st.opts.lasso.polygonal ? 'Polygonal Lasso' : 'Lasso');
}

const lasso: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => {
    if (c.st.opts.lasso.polygonal) {
      if (!lassoPts.length) dragMods = e;
      const first = lassoPts[0];
      if (lassoPts.length > 2 && (e.dbl || (first && Math.hypot((e.x - first.x) * c.view.zoom, (e.y - first.y) * c.view.zoom) < 8))) {
        finishLasso(c, dragMods ?? e);
        return;
      }
      lassoPts.push({ x: e.x, y: e.y });
      c.redraw();
      return;
    }
    dragMods = e;
    lassoPts = [{ x: e.x, y: e.y }];
  },
  move: (e, c) => {
    if (c.st.opts.lasso.polygonal) {
      c.redraw();
      return;
    }
    if (!lassoPts.length) return;
    const last = lassoPts[lassoPts.length - 1];
    if (Math.hypot(e.x - last.x, e.y - last.y) * c.view.zoom > 2) lassoPts.push({ x: e.x, y: e.y });
    c.redraw();
  },
  up: (_e, c) => {
    if (c.st.opts.lasso.polygonal || !lassoPts.length) return;
    finishLasso(c, dragMods!);
  },
  key: (e, c) => {
    if (!lassoPts.length) return false;
    if (e.key === 'Enter') {
      finishLasso(c, dragMods!);
      return true;
    }
    if (e.key === 'Escape') {
      lassoPts = [];
      c.redraw();
      return true;
    }
    return false;
  },
  overlay: (g, c) => {
    if (!lassoPts.length) return;
    g.strokeStyle = '#fff';
    g.setLineDash([4, 4]);
    g.lineWidth = 1;
    g.beginPath();
    lassoPts.forEach((p, i) => {
      const [x, y] = toScreen(c.view, p.x, p.y);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    if (c.st.opts.lasso.polygonal && c.hover) {
      const [x, y] = toScreen(c.view, c.hover.x, c.hover.y);
      g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
  },
  deactivate: () => {
    lassoPts = [];
  },
};

function sampleImage(doc: EditorDoc, all: boolean): { img: ImageData; ox: number; oy: number } | null {
  if (all) {
    const c = doc.getComposite();
    return { img: ctx2d(c, true).getImageData(0, 0, c.width, c.height), ox: 0, oy: 0 };
  }
  const l = doc.active;
  if (!isPixel(l)) return null;
  const t = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(t, true);
  ctx.drawImage(l.canvas, l.x, l.y);
  return { img: ctx.getImageData(0, 0, t.width, t.height), ox: 0, oy: 0 };
}

const wand: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => {
    const { doc, st } = c;
    const o = st.opts.wand;
    const s = sampleImage(doc, o.sampleAll);
    if (!s) return toast('Select a pixel layer, or enable “Sample all layers”');
    const m = colorRange(s.img, Math.floor(e.x), Math.floor(e.y), o.tolerance, o.contiguous);
    const shape = maskToCanvas(m, doc.width, doc.height);
    doc.setSelection(combineSelection(doc, shape, selectMode(e, o.mode)), 'Magic Wand');
  },
};

// ---------------------------------------------------------------- move
let moveState: {
  layer: PixelLayer;
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  float?: HTMLCanvasElement;
  base?: HTMLCanvasElement;
  selMask?: HTMLCanvasElement;
  selBounds?: Rect;
} | null = null;

/** A Move tool drag is in progress. */
export const isMoving = () => !!moveState;

/**
 * What the Move tool is dragging, for dropping it into another document: the layer, or (with a selection)
 * the selected pixels and where they are; `grab` is where the drag started, in document pixels.
 */
export function movePayload(): { layer: PixelLayer; grab: { x: number; y: number }; pixels: { canvas: HTMLCanvasElement; x: number; y: number } | null } | null {
  const m = moveState;
  if (!m) return null;
  if (m.float && m.selBounds) {
    const b = m.selBounds;
    const c = createCanvas(b.w, b.h);
    ctx2d(c).drawImage(m.float, -b.x, -b.y);
    return { layer: m.layer, grab: { x: m.sx, y: m.sy }, pixels: { canvas: c, x: b.x, y: b.y } };
  }
  return { layer: m.layer, grab: { x: m.sx, y: m.sy }, pixels: null };
}

/** Ends a Move tool drag without moving anything (the layer or selection goes back where it was). */
export function abortMove(doc: EditorDoc) {
  const m = moveState;
  moveState = null;
  if (!m) return;
  if (m.float) doc.preview = null;
  else {
    m.layer.x = m.x0;
    m.layer.y = m.y0;
  }
  doc.invalidate();
}

function pickLayerAt(doc: EditorDoc, x: number, y: number): PixelLayer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || !isPixel(l)) continue;
    const lx = Math.floor(x - l.x);
    const ly = Math.floor(y - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
    const a = ctx2d(l.canvas).getImageData(lx, ly, 1, 1).data[3];
    if (a > 10) return l;
  }
  return null;
}

const move: Tool = {
  cursor: () => 'move',
  down: (e, c) => {
    const { doc, st } = c;
    let l = doc.active;
    if (st.opts.move.autoSelect || e.mod) {
      const hit = pickLayerAt(doc, e.x, e.y);
      if (hit) {
        doc.activeId = hit.id;
        doc.editMask = false;
        l = hit;
        doc.emit();
      }
    }
    if (!isPixel(l)) return toast('Adjustment layers cannot be moved');
    if (l.locked) return toast('This layer is locked');
    moveState = { layer: l, x0: l.x, y0: l.y, sx: e.x, sy: e.y };
    if (doc.selection && l.kind === 'raster') {
      const full = createCanvas(doc.width, doc.height);
      ctx2d(full).drawImage(l.canvas, l.x, l.y);
      const float = createCanvas(doc.width, doc.height);
      const fctx = ctx2d(float);
      fctx.drawImage(full, 0, 0);
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(doc.selection.mask, 0, 0);
      const base = createCanvas(doc.width, doc.height);
      const bctx = ctx2d(base);
      bctx.drawImage(full, 0, 0);
      if (!e.alt) {
        bctx.globalCompositeOperation = 'destination-out';
        bctx.drawImage(doc.selection.mask, 0, 0);
      }
      moveState.float = float;
      moveState.base = base;
      moveState.selMask = doc.selection.mask;
      moveState.selBounds = doc.selection.bounds;
    }
  },
  move: (e, c) => {
    const m = moveState;
    if (!m) return;
    let dx = Math.round(e.x - m.sx);
    let dy = Math.round(e.y - m.sy);
    if (e.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    const { doc } = c;
    if (m.float && m.base) {
      const comp = doc.temp('move-compose');
      const ctx = ctx2d(comp);
      ctx.drawImage(m.base, 0, 0);
      ctx.drawImage(m.float, dx, dy);
      doc.preview = { kind: 'replace', layerId: m.layer.id, canvas: comp, x: 0, y: 0 };
      (moveState as { dx?: number }).dx = dx;
      (moveState as { dy?: number }).dy = dy;
    } else {
      m.layer.x = m.x0 + dx;
      m.layer.y = m.y0 + dy;
    }
    doc.invalidate();
  },
  up: (_e, c) => {
    const m = moveState as (typeof moveState & { dx?: number; dy?: number }) | null;
    moveState = null;
    if (!m) return;
    const { doc } = c;
    if (m.float && m.base) {
      const dx = m.dx ?? 0;
      const dy = m.dy ?? 0;
      doc.preview = null;
      if (!dx && !dy) return doc.invalidate();
      doc.commit('Move', () => {
        const out = createCanvas(doc.width, doc.height);
        const ctx = ctx2d(out);
        ctx.drawImage(m.base!, 0, 0);
        ctx.drawImage(m.float!, dx, dy);
        const l = m.layer as RasterLayer;
        l.canvas = out;
        l.x = 0;
        l.y = 0;
        const sm = createCanvas(doc.width, doc.height);
        ctx2d(sm).drawImage(m.selMask!, dx, dy);
        doc.selection = makeSelection(sm);
      });
      return;
    }
    const x1 = m.layer.x;
    const y1 = m.layer.y;
    m.layer.x = m.x0;
    m.layer.y = m.y0;
    if (x1 === m.x0 && y1 === m.y0) return;
    doc.commit('Move', () => {
      m.layer.x = x1;
      m.layer.y = y1;
    });
  },
  key: (e, c) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return false;
    const l = c.doc.active;
    if (!isPixel(l) || l.locked) return true;
    const k = e.shiftKey ? 10 : 1;
    c.doc.commit('Nudge', () => {
      l.x += d[0] * k;
      l.y += d[1] * k;
    });
    return true;
  },
};

// ---------------------------------------------------------------- scale
// Handles around the active layer's content (or the selected pixels) resize it; dragging inside moves it.
// Each drag is one undo step; the pixel work is in scale.ts.

interface ScaleDrag {
  target: ScaleTarget;
  mode: 'move' | 'handle';
  hx: number;
  hy: number;
  start: Rect;
  sx: number;
  sy: number;
  box: Rect;
  center: boolean;
  cursor: string;
  /** Document state at the start; anything else changing it (an undo, say) ends the drag. */
  stamp: unknown[];
}
let scaleDrag: ScaleDrag | null = null;

const scaleStamp = (doc: EditorDoc, t: ScaleTarget) => [doc.hIndex, doc.history.length, doc.layers.includes(t.layer), t.layer.canvas, t.layer.x, t.layer.y, doc.selection];
const scaleStale = (doc: EditorDoc, d: ScaleDrag) => scaleStamp(doc, d.target).some((v, i) => v !== d.stamp[i]);

/** The box being dragged, for the options bar (null between drags). */
export const scaleUi = createStore<{ box: Rect | null }>({ box: null });

const RESIZE_CURSOR: Record<string, string> = {
  '-1,-1': 'nwse-resize',
  '1,1': 'nwse-resize',
  '1,-1': 'nesw-resize',
  '-1,1': 'nesw-resize',
  '-1,0': 'ew-resize',
  '1,0': 'ew-resize',
  '0,-1': 'ns-resize',
  '0,1': 'ns-resize',
};
const SCALE_ACCENT = '#3d8bfd';

/** What of box `r` is at document point (x, y): a handle (corners and edge middles, then anywhere along an edge), its inside, or nothing. */
function scaleHit(r: Rect, x: number, y: number, zoom: number): { hx: number; hy: number } | 'inside' | null {
  let best: { hx: number; hy: number } | null = null;
  let bd = 7 / zoom;
  for (const [hx, hy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const d = Math.max(Math.abs(x - (r.x + ((hx + 1) / 2) * r.w)), Math.abs(y - (r.y + ((hy + 1) / 2) * r.h)));
    if (d < bd) {
      bd = d;
      best = { hx, hy };
    }
  }
  if (best) return best;
  const e = 4 / zoom;
  const alongY = y > r.y - e && y < r.y + r.h + e;
  const alongX = x > r.x - e && x < r.x + r.w + e;
  if (alongY && Math.abs(x - r.x) <= e) return { hx: -1, hy: 0 };
  if (alongY && Math.abs(x - r.x - r.w) <= e) return { hx: 1, hy: 0 };
  if (alongX && Math.abs(y - r.y) <= e) return { hx: 0, hy: -1 };
  if (alongX && Math.abs(y - r.y - r.h) <= e) return { hx: 0, hy: 1 };
  return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h ? 'inside' : null;
}

let scaleFrame = 0;

/** Redraws the live preview once per frame (pointer moves can arrive several to a frame). */
function scheduleScalePreview(doc: EditorDoc) {
  if (scaleFrame) return;
  scaleFrame = requestAnimationFrame(() => {
    scaleFrame = 0;
    const d = scaleDrag;
    if (!d || scaleStale(doc, d)) return;
    previewScale(doc, d.target, d.box);
    scaleUi.set({ box: d.box });
  });
}

function endScaleDrag(doc: EditorDoc) {
  cancelAnimationFrame(scaleFrame);
  scaleFrame = 0;
  scaleDrag = null;
  scaleUi.set({ box: null });
  cancelScalePreview(doc);
}

const scaleTool: Tool = {
  liveCursor: true,
  cursor: (c) => {
    if (scaleDrag) return scaleDrag.cursor;
    const t = c.hover ? scaleTarget(c.doc).target : null;
    if (!t || !c.hover) return 'default';
    const h = scaleHit(t.box, c.hover.x, c.hover.y, c.view.zoom);
    return h === 'inside' ? 'move' : h ? RESIZE_CURSOR[`${h.hx},${h.hy}`] : 'default';
  },
  down: (e, c) => {
    const { doc } = c;
    const { target: t, reason } = scaleTarget(doc);
    const hit = t ? scaleHit(t.box, e.x, e.y, c.view.zoom) : null;
    if (!t || !hit) {
      // Clicking another layer's pixels makes it the one to scale.
      const other = pickLayerAt(doc, e.x, e.y);
      if (other && other.id !== doc.activeId) {
        doc.activeId = other.id;
        doc.editMask = false;
        doc.emit();
        c.redraw();
      } else if (!t) toast(reason);
      return;
    }
    if (t.layer.locked) return toast('This layer is locked');
    const start = { ...t.box };
    const handle = hit === 'inside' ? null : hit;
    scaleDrag = {
      target: t,
      mode: handle ? 'handle' : 'move',
      hx: handle?.hx ?? 0,
      hy: handle?.hy ?? 0,
      start,
      sx: e.x,
      sy: e.y,
      box: start,
      center: false,
      cursor: handle ? RESIZE_CURSOR[`${handle.hx},${handle.hy}`] : 'move',
      stamp: scaleStamp(doc, t),
    };
  },
  move: (e, c) => {
    const d = scaleDrag;
    if (!d) return;
    if (scaleStale(c.doc, d)) return endScaleDrag(c.doc);
    const W = c.doc.width;
    const H = c.doc.height;
    const tol = SNAP / c.view.zoom;
    const s = d.start;
    if (d.mode === 'move') {
      let x = s.x + e.x - d.sx;
      let y = s.y + e.y - d.sy;
      if (e.shift) {
        if (Math.abs(x - s.x) > Math.abs(y - s.y)) y = s.y;
        else x = s.x;
      }
      if (!e.mod) {
        x = snapMove(x, s.w, W, tol);
        y = snapMove(y, s.h, H, tol);
      }
      // By whole pixels, so a move never resamples.
      d.box = { ...s, x: s.x + Math.round(x - s.x), y: s.y + Math.round(y - s.y) };
    } else {
      // Where the handle is now (keeping the offset from where it was grabbed), snapped to the canvas.
      let px = s.x + ((d.hx + 1) / 2) * s.w + e.x - d.sx;
      let py = s.y + ((d.hy + 1) / 2) * s.h + e.y - d.sy;
      if (!e.mod) {
        px = snapTo(px, [0, W / 2, W], tol);
        py = snapTo(py, [0, H / 2, H], tol);
      }
      const lock = isTextTarget(d.target) || c.st.opts.scale.linked !== e.shift;
      d.center = e.alt;
      d.box = scaleBox(s, d.hx, d.hy, px, py, lock, e.alt);
    }
    scheduleScalePreview(c.doc);
  },
  up: (_e, c) => {
    const d = scaleDrag;
    if (!d) return;
    // The fixed point of the box, as fractions; a re-rendered type layer is aligned to it.
    const f = (h: number) => (d.mode === 'move' || d.center || !h ? 0.5 : h > 0 ? 0 : 1);
    const stale = scaleStale(c.doc, d);
    endScaleDrag(c.doc);
    if (!stale) commitScale(c.doc, d.target, d.box, { x: f(d.hx), y: f(d.hy) });
    c.redraw();
  },
  key: (e, c) => {
    if (e.key !== 'Escape' || !scaleDrag) return false;
    endScaleDrag(c.doc);
    return true;
  },
  overlay: (g, c) => {
    const d = scaleDrag && !scaleStale(c.doc, scaleDrag) ? scaleDrag : null;
    const t = d ? d.target : scaleTarget(c.doc).target;
    if (!t) return;
    const v = c.view;
    const r = d ? d.box : t.box;
    const [x, y] = toScreen(v, r.x, r.y);
    const w = r.w * v.zoom;
    const h = r.h * v.zoom;
    g.save();
    if (d?.mode === 'handle') {
      const [ox, oy] = toScreen(v, d.start.x, d.start.y);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.strokeRect(Math.round(ox) + 0.5, Math.round(oy) + 0.5, Math.round(d.start.w * v.zoom), Math.round(d.start.h * v.zoom));
      g.setLineDash([]);
    }
    const bx = Math.round(x) + 0.5;
    const by = Math.round(y) + 0.5;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.strokeRect(bx, by, Math.round(w), Math.round(h));
    g.lineWidth = 1;
    g.strokeStyle = SCALE_ACCENT;
    g.strokeRect(bx, by, Math.round(w), Math.round(h));
    for (const fx of [0, 0.5, 1])
      for (const fy of [0, 0.5, 1]) {
        if (fx === 0.5 && fy === 0.5) continue;
        const px = Math.round(x + w * fx);
        const py = Math.round(y + h * fy);
        g.fillStyle = '#fff';
        g.fillRect(px - 4, py - 4, 8, 8);
        g.strokeStyle = SCALE_ACCENT;
        g.strokeRect(px - 3.5, py - 3.5, 7, 7);
      }
    if (d) {
      const k = percentFor(t, r);
      const pct = (n: number) => `${+(n * 100).toFixed(1)}%`;
      const label = `${Math.round(r.w).toLocaleString()} × ${Math.round(r.h).toLocaleString()} px · ${Math.abs(k.x - k.y) < 0.0005 ? pct(k.x) : `${pct(k.x)} × ${pct(k.y)}`}`;
      g.font = '600 11px system-ui';
      const lw = g.measureText(label).width + 14;
      const cw = g.canvas.clientWidth;
      const ch = g.canvas.clientHeight;
      const lx = Math.round(Math.min(cw - lw - 4, Math.max(4, x + w / 2 - lw / 2)));
      const ly = Math.round(Math.min(ch - 24, Math.max(4, y - 30 > 4 ? y - 30 : y + h + 10)));
      g.fillStyle = 'rgba(20,20,22,0.85)';
      g.beginPath();
      g.roundRect(lx, ly, lw, 20, 6);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(label, lx + 7, ly + 14);
    }
    g.restore();
  },
  deactivate: (c) => {
    if (scaleDrag) endScaleDrag(c.doc);
    releaseScaleCache();
  },
};

// ---------------------------------------------------------------- crop
// The box may reach past the canvas: applying it then expands the canvas, and the crop options choose how the
// new area is filled (see expand.ts). A size preset ("Expand to") also scales the result to its exact pixels.

/** Output size of a size preset. */
export interface CropOut {
  w: number;
  h: number;
  presetId: string;
  label: string;
}
interface PendingCrop {
  docId: string;
  rect: Rect;
  out: CropOut | null;
}
type CropDrag = { mode: 'new' | 'move' | 'handle'; hx: number; hy: number; start: Rect; sx: number; sy: number };

let cropBox: PendingCrop | null = null;
let cropDrag: CropDrag | null = null;

/** The pending crop, for the options bar. Updated when a drag ends rather than on every move. */
export const cropUi = createStore<{ pending: PendingCrop | null }>({ pending: null });

const pendingFor = (doc: EditorDoc) => (cropBox && cropBox.docId === doc.id ? cropBox : null);
const docById = (id: string) => editor.get().docs.find((d) => d.id === id) ?? null;

/** Edges snap to the canvas within this many screen pixels (hold ⌘ to place freely). */
const SNAP = 8;

function snapTo(v: number, targets: number[], tol: number): number {
  let best = v;
  let bd = tol;
  for (const t of targets) {
    const d = Math.abs(v - t);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** Snaps a moved box's left (or top) edge so an edge or its centre lines up with the canvas. */
function snapMove(x: number, w: number, W: number, tol: number): number {
  let best = 0;
  let bd = tol;
  for (const d of [-x, W - x, -(x + w), W - (x + w), W / 2 - (x + w / 2)]) {
    if (Math.abs(d) < bd) {
      bd = Math.abs(d);
      best = d;
    }
  }
  return x + best;
}

/** The box while dragging a handle (or drawing a new one) to (px, py), keeping the aspect `a` if set. */
function resizeBox(d: CropDrag, px: number, py: number, a: number | null): Rect {
  const s = d.start;
  if (d.mode === 'handle' && d.hx === 0) {
    const ay = d.hy === 1 ? s.y : s.y + s.h;
    const h = Math.abs(py - ay);
    const y = py >= ay ? ay : ay - h;
    if (!a) return { x: s.x, y, w: s.w, h };
    const w = h * a;
    return { x: s.x + s.w / 2 - w / 2, y, w, h };
  }
  if (d.mode === 'handle' && d.hy === 0) {
    const ax = d.hx === 1 ? s.x : s.x + s.w;
    const w = Math.abs(px - ax);
    const x = px >= ax ? ax : ax - w;
    if (!a) return { x, y: s.y, w, h: s.h };
    const h = w / a;
    return { x, y: s.y + s.h / 2 - h / 2, w, h };
  }
  // A corner, or a new box: the opposite corner stays put.
  const ax = d.mode === 'new' || d.hx === 1 ? s.x : s.x + s.w;
  const ay = d.mode === 'new' || d.hy === 1 ? s.y : s.y + s.h;
  let w = Math.abs(px - ax);
  let h = Math.abs(py - ay);
  if (a) {
    if (w / a > h) h = w / a;
    else w = h * a;
  }
  return { x: px >= ax ? ax : ax - w, y: py >= ay ? ay : ay - h, w, h };
}

/** Shares the box with the options bar and lets the view show it (zooming out if it reaches past the window). */
function publish() {
  cropUi.set({ pending: cropBox ? { ...cropBox, rect: { ...cropBox.rect } } : null });
  const d = cropBox && docById(cropBox.docId);
  if (d) setViewExtent(d, cropBox!.rect);
}

/** Sets (or with null, removes) the crop box of `doc`. */
export function setPendingCrop(doc: EditorDoc, rect: Rect | null, out: CropOut | null = null) {
  if (!rect) return clearCrop();
  const prev = cropBox && cropBox.docId !== doc.id ? docById(cropBox.docId) : null;
  if (prev) setViewExtent(prev, null);
  cropBox = { docId: doc.id, rect: { ...rect }, out };
  publish();
  doc.onRender.emit();
}

export function clearCrop() {
  const prev = cropBox;
  cropBox = null;
  cropDrag = null;
  cancelPreview();
  cropUi.set({ pending: null });
  const d = prev && docById(prev.docId);
  if (d) setViewExtent(d, null);
}

/** The box for a size preset: its shape around the whole canvas. Applying it scales the result to the preset. */
export function startPreset(doc: EditorDoc, presetId: string) {
  const p = presetById(presetId);
  if (!p) return;
  setOpts('crop', { aspect: p.w / p.h });
  setPendingCrop(doc, containBox(doc, p.w / p.h), { w: p.w, h: p.h, presetId: p.id, label: p.label });
}

/** Locks the box to an aspect ratio (null: free), reshaping a pending box about its centre. Ends any size preset. */
export function setCropAspect(doc: EditorDoc | null, aspect: number | null) {
  setOpts('crop', { aspect });
  const cur = doc && pendingFor(doc);
  if (!doc || !cur) return;
  let r = cur.rect;
  if (aspect) {
    const w = Math.sqrt(r.w * r.h * aspect);
    const h = w / aspect;
    r = { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
  }
  setPendingCrop(doc, r, null);
}

/** Keeps the box but drops a size preset's scaling (the result keeps the box's own pixels). */
export function clearCropOut(doc: EditorDoc) {
  const cur = pendingFor(doc);
  if (cur) setPendingCrop(doc, cur.rect, null);
}

const cropTool: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => {
    const cur = pendingFor(c.doc);
    const tol = 10 / c.view.zoom;
    if (cur) {
      const r = cur.rect;
      for (const hx of [-1, 0, 1])
        for (const hy of [-1, 0, 1]) {
          if (!hx && !hy) continue;
          const px = r.x + ((hx + 1) / 2) * r.w;
          const py = r.y + ((hy + 1) / 2) * r.h;
          if (Math.abs(e.x - px) < tol && Math.abs(e.y - py) < tol) {
            cropDrag = { mode: 'handle', hx, hy, start: { ...r }, sx: e.x, sy: e.y };
            return;
          }
        }
      if (e.x > r.x && e.x < r.x + r.w && e.y > r.y && e.y < r.y + r.h) {
        cropDrag = { mode: 'move', hx: 0, hy: 0, start: { ...r }, sx: e.x, sy: e.y };
        return;
      }
    }
    // A new box, which may start outside the canvas. A size preset's output carries over (its ratio stays locked).
    const snap = SNAP / c.view.zoom;
    const x = e.mod ? e.x : snapTo(e.x, [0, c.doc.width], snap);
    const y = e.mod ? e.y : snapTo(e.y, [0, c.doc.height], snap);
    cropBox = { docId: c.doc.id, rect: { x, y, w: 0, h: 0 }, out: cur?.out ?? null };
    cropDrag = { mode: 'new', hx: 1, hy: 1, start: { x, y, w: 0, h: 0 }, sx: x, sy: y };
  },
  move: (e, c) => {
    const d = cropDrag;
    const cur = pendingFor(c.doc);
    if (!d || !cur) return;
    const W = c.doc.width;
    const H = c.doc.height;
    const tol = SNAP / c.view.zoom;
    if (d.mode === 'move') {
      let x = d.start.x + e.x - d.sx;
      let y = d.start.y + e.y - d.sy;
      if (!e.mod) {
        x = snapMove(x, d.start.w, W, tol);
        y = snapMove(y, d.start.h, H, tol);
      }
      cur.rect = { ...d.start, x, y };
    } else {
      const px = e.mod ? e.x : snapTo(e.x, [0, W], tol);
      const py = e.mod ? e.y : snapTo(e.y, [0, H], tol);
      cur.rect = resizeBox(d, px, py, c.st.opts.crop.aspect);
    }
    c.redraw();
  },
  up: (_e, c) => {
    const cur = pendingFor(c.doc);
    cropDrag = null;
    if (!cur) return;
    if (cur.rect.w < 3 || cur.rect.h < 3) clearCrop();
    else publish();
    c.redraw();
  },
  key: (e, c) => {
    if (!pendingFor(c.doc)) return false;
    if (e.key === 'Enter') {
      applyCrop(c);
      return true;
    }
    if (e.key === 'Escape') {
      clearCrop();
      c.redraw();
      return true;
    }
    return false;
  },
  overlay: (g, c) => {
    const cur = pendingFor(c.doc);
    if (!cur) return;
    const v = c.view;
    const r = cur.rect;
    const [x, y] = toScreen(v, r.x, r.y);
    const w = r.w * v.zoom;
    const h = r.h * v.zoom;
    const [dx, dy] = toScreen(v, 0, 0);
    const outside = r.x < -0.5 || r.y < -0.5 || r.x + r.w > c.doc.width + 0.5 || r.y + r.h > c.doc.height + 0.5;
    const o = editor.get().opts.crop;
    let waiting = false;
    if (outside) {
      // The new area: the box minus the canvas. It shows the fill (a small preview of it) or a checkerboard.
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.beginPath();
      g.rect(x, y, w, h);
      g.rect(dx, dy, c.doc.width * v.zoom, c.doc.height * v.zoom);
      g.clip('evenodd');
      if (o.fill === 'color') {
        g.fillStyle = o.fillColor;
        g.fillRect(x, y, w, h);
      } else {
        g.fillStyle = checkerPattern(g);
        g.fillRect(x, y, w, h);
        if (o.fill !== 'none' && !cropDrag) {
          const pv = previewFor(previewKey(c.doc, r, o.fill, o.fillColor));
          if (pv) {
            g.imageSmoothingEnabled = true;
            g.imageSmoothingQuality = 'high';
            g.drawImage(pv, x, y, w, h);
          } else {
            waiting = true;
            requestPreview(c.doc, { ...r }, o.fill, o.fillColor, () => c.doc.onRender.emit());
          }
        }
      }
      g.restore();
    }
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.rect(0, 0, g.canvas.width, g.canvas.height);
    g.rect(x, y, w, h);
    g.fill('evenodd');
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      g.moveTo(x + (w * i) / 3, y);
      g.lineTo(x + (w * i) / 3, y + h);
      g.moveTo(x, y + (h * i) / 3);
      g.lineTo(x + w, y + (h * i) / 3);
    }
    g.stroke();
    g.fillStyle = '#fff';
    for (const hx of [0, 0.5, 1]) for (const hy of [0, 0.5, 1]) if (hx !== 0.5 || hy !== 0.5) g.fillRect(x + w * hx - 4, y + h * hy - 4, 8, 8);
    const outW = cur.out ? cur.out.w : Math.round(r.w);
    const outH = cur.out ? cur.out.h : Math.round(r.h);
    const fill = outside && o.fill !== 'none' ? ` · ${FILLS.find((f) => f.value === o.fill)?.label} fill${waiting ? ' (making a preview…)' : ''}` : '';
    g.font = '11px system-ui';
    g.fillStyle = '#fff';
    g.fillText(`${outW} × ${outH} px${fill} — Enter to apply, Esc to cancel`, x + 4, y - 8 > 12 ? y - 8 : y + 16);
  },
  deactivate: () => clearCrop(),
};

/** Applies the pending crop of `c.doc`: crops, expands and fills as set up. */
export function applyCrop(c: ToolCtx) {
  const cur = pendingFor(c.doc);
  if (!cur || isExpanding()) return;
  const o = editor.get().opts.crop;
  const doc = c.doc;
  const out = cur.out;
  void expandCanvas(doc, { ...cur.rect }, { out: out && { w: out.w, h: out.h }, fill: o.fill, color: o.fillColor }).then((ok) => {
    if (!ok) return;
    if (pendingFor(doc)) clearCrop();
    c.setView({}, undefined);
  });
}
export const hasPendingCrop = (doc?: EditorDoc | null) => !!cropBox && (!doc || cropBox.docId === doc.id);

/** A tool context for `doc` outside the canvas's own events (menus, buttons, shortcuts). */
export function toolCtx(doc: EditorDoc): ToolCtx {
  return {
    doc,
    st: editor.get(),
    view: getView(doc),
    setView: (v, a) => (Object.keys(v).length ? setView(doc, v, a) : refit(doc)),
    redraw: () => doc.onRender.emit(),
    editText: () => {},
    hover: null,
  };
}

/** Switches tools, letting the previous one tidy up (a pending crop box is dropped, for instance). */
export function selectTool(t: ToolId) {
  const doc = activeDoc();
  const cur = editor.get().tool;
  if (cur !== t && doc) {
    TOOLS[cur].deactivate?.(toolCtx(doc));
    doc.onRender.emit();
  }
  editor.set({ tool: t });
}

/**
 * Opens a catalog photo (as developed) in the Editor with the Crop tool's box set to a size preset around it,
 * ready to adjust and apply. Used by Develop's Expand section.
 */
export async function expandPhotoInEditor(photoId: string, presetId: string, fill: ExpandFill) {
  setOpts('crop', { fill });
  const doc = await openPhotoInEditor(photoId, { developed: true });
  if (!doc) return;
  // An open document may first be brought up to date with Develop, which can change its size.
  await syncDoc(doc, true);
  if (!editor.get().docs.includes(doc)) return;
  editor.set({ activeDoc: doc.id });
  selectTool('crop');
  startPreset(doc, presetId);
}

// ---------------------------------------------------------------- fill tools
const bucket: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => {
    const { doc, st } = c;
    const l = doc.active;
    if (!isPixel(l) || l.kind === 'text') return toast('Select a pixel layer to fill');
    if (l.locked) return toast('This layer is locked');
    const o = st.opts.bucket;
    const s = sampleImage(doc, o.sampleAll);
    if (!s) return;
    const m = colorRange(s.img, Math.floor(e.x), Math.floor(e.y), o.tolerance, o.contiguous);
    const fill = doc.clipToSelection(maskToCanvas(m, doc.width, doc.height, st.fg), 'bucket-clip');
    doc.commit('Paint Bucket', () => {
      const cov = ensureCovers(doc, l);
      const ctx = ctx2d(cov.canvas);
      ctx.globalAlpha = o.opacity;
      ctx.drawImage(fill, -cov.x, -cov.y);
      Object.assign(l, cov);
    });
  },
};

const gradient: Tool = {
  cursor: () => 'crosshair',
  down: (e) => {
    dragStart = { x: e.x, y: e.y };
    dragNow = { x: e.x, y: e.y };
  },
  move: (e, c) => {
    if (!dragStart) return;
    dragNow = { x: e.x, y: e.y };
    if (e.shift) {
      const dx = e.x - dragStart.x;
      const dy = e.y - dragStart.y;
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      dragNow = { x: dragStart.x + Math.cos(a) * len, y: dragStart.y + Math.sin(a) * len };
    }
    c.redraw();
  },
  up: (_e, c) => {
    const s = dragStart;
    const n = dragNow;
    dragStart = null;
    dragNow = null;
    if (!s || !n || Math.hypot(n.x - s.x, n.y - s.y) < 2) return c.redraw();
    const { doc, st } = c;
    const l = doc.active;
    const o = st.opts.gradient;
    const onMask = doc.editMask && !!l?.mask;
    if (!onMask && (!isPixel(l) || l.kind === 'text')) return toast('Select a pixel layer or a mask');
    const g = createCanvas(doc.width, doc.height);
    const gc = ctx2d(g);
    const grad = o.type === 'linear' ? gc.createLinearGradient(s.x, s.y, n.x, n.y) : gc.createRadialGradient(s.x, s.y, 0, s.x, s.y, Math.hypot(n.x - s.x, n.y - s.y));
    if (onMask) {
      grad.addColorStop(0, '#fff');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    } else {
      grad.addColorStop(0, st.fg);
      grad.addColorStop(1, o.toTransparent ? hexA(st.fg, 0) : st.bg);
    }
    gc.fillStyle = grad;
    gc.fillRect(0, 0, g.width, g.height);
    const fill = doc.clipToSelection(g, 'grad-clip');
    if (onMask) {
      doc.commit('Gradient', () => {
        const m = createCanvas(doc.width, doc.height);
        ctx2d(m).drawImage(fill, 0, 0);
        l!.mask = m;
      });
      return;
    }
    const pl = l as PixelLayer;
    doc.commit('Gradient', () => {
      const cov = ensureCovers(doc, pl);
      const ctx = ctx2d(cov.canvas);
      ctx.globalAlpha = o.opacity;
      ctx.drawImage(fill, -cov.x, -cov.y);
      Object.assign(pl, cov);
    });
  },
  overlay: (g, c) => {
    if (!dragStart || !dragNow) return;
    const [x0, y0] = toScreen(c.view, dragStart.x, dragStart.y);
    const [x1, y1] = toScreen(c.view, dragNow.x, dragNow.y);
    g.strokeStyle = '#000';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.stroke();
  },
};

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const eyedropper: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => pick(e, c),
  move: (e, c) => pick(e, c),
};

function pick(e: ToolEvent, c: ToolCtx) {
  const comp = c.doc.getComposite();
  const x = Math.floor(e.x);
  const y = Math.floor(e.y);
  if (x < 0 || y < 0 || x >= comp.width || y >= comp.height) return;
  const d = ctx2d(comp).getImageData(x, y, 1, 1).data;
  if (d[3] === 0) return;
  const hex = rgb255ToHex(d[0], d[1], d[2]);
  editor.set(e.alt ? { bg: hex } : { fg: hex });
}

// ---------------------------------------------------------------- text & shapes
const text: Tool = {
  cursor: () => 'text',
  down: (e, c) => {
    const { doc } = c;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.kind === 'text' && l.visible && e.x >= l.x && e.y >= l.y && e.x <= l.x + l.canvas.width && e.y <= l.y + l.canvas.height) {
        doc.activeId = l.id;
        doc.emit();
        c.editText(l.id, l.x, l.y);
        return;
      }
    }
    c.editText(null, e.x, e.y);
  },
};

const shape: Tool = {
  cursor: () => 'crosshair',
  down: (e) => {
    dragStart = { x: e.x, y: e.y };
    dragNow = { x: e.x, y: e.y };
    dragMods = e;
  },
  move: (e, c) => {
    if (!dragStart) return;
    dragNow = { x: e.x, y: e.y };
    dragMods = { ...dragMods!, shift: e.shift, alt: e.alt };
    c.redraw();
  },
  up: (e, c) => {
    const s = dragStart;
    dragStart = null;
    dragNow = null;
    if (!s) return;
    const { doc, st } = c;
    const o = st.opts.shape;
    const r = marqueeRectFrom(s, e, e.shift);
    if (o.type !== 'line' && (r.w < 2 || r.h < 2)) return c.redraw();
    const canvas = createCanvas(doc.width, doc.height);
    const g = ctx2d(canvas);
    g.fillStyle = st.fg;
    g.strokeStyle = o.type === 'line' ? st.fg : st.bg;
    g.lineWidth = Math.max(1, o.strokeWidth || (o.type === 'line' ? 4 : 0));
    g.lineCap = 'round';
    g.beginPath();
    if (o.type === 'rect') g.rect(r.x, r.y, r.w, r.h);
    else if (o.type === 'ellipse') g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else {
      g.moveTo(s.x, s.y);
      g.lineTo(e.x, e.y);
    }
    if (o.type !== 'line' && o.fill) g.fill();
    if (o.type === 'line' || o.strokeWidth > 0) g.stroke();
    const name = o.type === 'rect' ? 'Rectangle' : o.type === 'ellipse' ? 'Ellipse' : 'Line';
    let n = 1;
    while (doc.layers.some((l) => l.name === `${name} ${n}`)) n++;
    insertLayer(doc, doc.newRaster(`${name} ${n}`, canvas), `${name} Tool`);
  },
  overlay: (g, c) => {
    if (!dragStart || !dragNow) return;
    const o = c.st.opts.shape;
    const r = marqueeRectFrom(dragStart, { ...dragMods!, ...dragNow }, !!dragMods?.shift);
    const [x, y] = toScreen(c.view, r.x, r.y);
    g.strokeStyle = '#3d8bfd';
    g.lineWidth = 1.5;
    g.beginPath();
    if (o.type === 'rect') g.rect(x, y, r.w * c.view.zoom, r.h * c.view.zoom);
    else if (o.type === 'ellipse') g.ellipse(x + (r.w * c.view.zoom) / 2, y + (r.h * c.view.zoom) / 2, (r.w * c.view.zoom) / 2, (r.h * c.view.zoom) / 2, 0, 0, Math.PI * 2);
    else {
      const [a, b] = toScreen(c.view, dragStart.x, dragStart.y);
      const [cx2, cy2] = toScreen(c.view, dragNow.x, dragNow.y);
      g.moveTo(a, b);
      g.lineTo(cx2, cy2);
    }
    g.stroke();
  },
};

function marqueeRectFrom(s: { x: number; y: number }, e: { x: number; y: number }, square: boolean): Rect {
  let w = e.x - s.x;
  let h = e.y - s.y;
  if (square) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  return { x: Math.min(s.x, s.x + w), y: Math.min(s.y, s.y + h), w: Math.abs(w), h: Math.abs(h) };
}

// ---------------------------------------------------------------- navigation
let panStart: { sx: number; sy: number; panX: number; panY: number } | null = null;

export const hand: Tool = {
  cursor: () => (panStart ? 'grabbing' : 'grab'),
  down: (e, c) => {
    panStart = { sx: e.sx, sy: e.sy, panX: c.view.panX, panY: c.view.panY };
  },
  move: (e, c) => {
    if (!panStart) return;
    c.setView({ panX: panStart.panX + e.sx - panStart.sx, panY: panStart.panY + e.sy - panStart.sy });
  },
  up: () => {
    panStart = null;
  },
};

const zoom: Tool = {
  cursor: () => 'zoom-in',
  down: (e, c) => {
    const f = e.alt ? 1 / 1.6 : 1.6;
    c.setView({ zoom: Math.min(32, Math.max(0.02, c.view.zoom * f)) }, { sx: e.sx, sy: e.sy });
  },
};

export const TOOLS: Record<ToolId, Tool> = {
  move,
  scale: scaleTool,
  marquee,
  lasso,
  wand,
  crop: cropTool,
  eyedropper,
  heal: paintTool('heal'),
  brush: paintTool('brush'),
  clone: paintTool('clone'),
  eraser: paintTool('eraser'),
  gradient,
  bucket,
  text,
  shape,
  hand,
  zoom,
};
