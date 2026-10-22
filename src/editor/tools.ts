// Editor tools. Each tool receives pointer events in document coordinates and may draw an overlay.

import { createCanvas, ctx2d } from '../lib/imageio';
import { rgb255ToHex } from '../lib/color';
import { toast } from '../state/app';
import { coversDoc, cropDoc, ensureCovers, insertLayer } from './actions';
import { EditorDoc, PixelLayer, RasterLayer, Rect, SelectMode, combineSelection, isPixel, makeSelection, selectionFromShape } from './doc';
import { colorRange, heal, makeTip, maskToCanvas, unionRect } from './paint';
import { EditorState, ToolId, editor } from './session';

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
let moveState: { layer: PixelLayer; x0: number; y0: number; sx: number; sy: number; float?: HTMLCanvasElement; base?: HTMLCanvasElement; selMask?: HTMLCanvasElement } | null = null;

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

// ---------------------------------------------------------------- crop
let cropRect: Rect | null = null;
let cropDrag: { mode: 'new' | 'move' | 'handle'; hx: number; hy: number; start: Rect; sx: number; sy: number } | null = null;

const crop: Tool = {
  cursor: () => 'crosshair',
  down: (e, c) => {
    const { doc } = c;
    const tol = 10 / c.view.zoom;
    if (cropRect) {
      const r = cropRect;
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
    cropRect = { x: e.x, y: e.y, w: 0, h: 0 };
    cropDrag = { mode: 'new', hx: 1, hy: 1, start: { x: e.x, y: e.y, w: 0, h: 0 }, sx: e.x, sy: e.y };
    void doc;
  },
  move: (e, c) => {
    const d = cropDrag;
    if (!d || !cropRect) return;
    const a = c.st.opts.crop.aspect;
    if (d.mode === 'move') {
      cropRect = { ...d.start, x: d.start.x + e.x - d.sx, y: d.start.y + e.y - d.sy };
    } else {
      let x0 = d.start.x, y0 = d.start.y, x1 = d.start.x + d.start.w, y1 = d.start.y + d.start.h;
      if (d.mode === 'new') {
        x1 = e.x;
        y1 = e.y;
      } else {
        if (d.hx === 1) x1 = e.x;
        if (d.hx === -1) x0 = e.x;
        if (d.hy === 1) y1 = e.y;
        if (d.hy === -1) y0 = e.y;
      }
      let r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (a) {
        if (r.w / a > r.h) r = { ...r, h: r.w / a };
        else r = { ...r, w: r.h * a };
        if (x1 < x0) r.x = x0 - r.w;
        if (y1 < y0) r.y = y0 - r.h;
      }
      cropRect = r;
    }
    c.redraw();
  },
  up: (_e, c) => {
    cropDrag = null;
    if (cropRect && (cropRect.w < 3 || cropRect.h < 3)) cropRect = null;
    c.redraw();
  },
  key: (e, c) => {
    if (e.key === 'Enter' && cropRect) {
      applyCrop(c);
      return true;
    }
    if (e.key === 'Escape' && cropRect) {
      cropRect = null;
      c.redraw();
      return true;
    }
    return false;
  },
  overlay: (g, c) => {
    if (!cropRect) return;
    const r = cropRect;
    const [x, y] = toScreen(c.view, r.x, r.y);
    const w = r.w * c.view.zoom;
    const h = r.h * c.view.zoom;
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
    g.font = '11px system-ui';
    g.fillStyle = '#fff';
    g.fillText(`${Math.round(r.w)} × ${Math.round(r.h)} px — Enter to crop, Esc to cancel`, x + 4, y - 8 > 12 ? y - 8 : y + 16);
  },
  deactivate: () => {
    cropRect = null;
  },
};

export function applyCrop(c: ToolCtx) {
  if (!cropRect) return;
  cropDoc(c.doc, cropRect);
  cropRect = null;
  c.setView({}, undefined);
}
export const hasPendingCrop = () => !!cropRect;

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
  marquee,
  lasso,
  wand,
  crop,
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
