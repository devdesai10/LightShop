// Canvas-2D overlays for the develop view: crop frame and local-adjustment mask handles.

import { Rect, Vec2, cropFits, cropOutSize, orientedSize, sourceToView, viewToSource } from './geometry';
import type { DevelopSettings, LocalMask, RetouchSpot } from './settings';

export interface ViewGeom {
  rect: Rect; // device px placement of the displayed image
  cropMode: boolean;
  fullW: number;
  fullH: number;
  dpr: number;
}

export const toScreen = (g: ViewGeom, uv: Vec2): Vec2 => [g.rect.x + uv[0] * g.rect.w, g.rect.y + uv[1] * g.rect.h];
export const toView = (g: ViewGeom, p: Vec2): Vec2 => [(p[0] - g.rect.x) / g.rect.w, (p[1] - g.rect.y) / g.rect.h];

// ---------------------------------------------------------------- crop
export type Handle = { dx: -1 | 0 | 1; dy: -1 | 0 | 1 };
export const HANDLES: Handle[] = [
  { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
  { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
  { dx: -1, dy: 1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 },
];

export function cropScreenRect(g: ViewGeom, c: DevelopSettings['crop']): Rect {
  return { x: g.rect.x + c.x * g.rect.w, y: g.rect.y + c.y * g.rect.h, w: c.w * g.rect.w, h: c.h * g.rect.h };
}

export function handlePos(r: Rect, h: Handle): Vec2 {
  return [r.x + ((h.dx + 1) / 2) * r.w, r.y + ((h.dy + 1) / 2) * r.h];
}

export function drawCrop(ctx: CanvasRenderingContext2D, g: ViewGeom, s: DevelopSettings, W: number, H: number) {
  const r = cropScreenRect(g, s.crop);
  ctx.save();
  ctx.fillStyle = 'rgba(10,10,12,0.62)';
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(r.x + (r.w * i) / 3, r.y);
    ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + (r.h * i) / 3);
    ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
  }
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * g.dpr;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  const L = 16 * g.dpr;
  ctx.lineWidth = 3 * g.dpr;
  for (const h of HANDLES) {
    const [x, y] = handlePos(r, h);
    ctx.beginPath();
    if (h.dx && h.dy) {
      ctx.moveTo(x, y + -h.dy * L);
      ctx.lineTo(x, y);
      ctx.lineTo(x + -h.dx * L, y);
    } else if (h.dx) {
      ctx.moveTo(x, y - L / 2);
      ctx.lineTo(x, y + L / 2);
    } else {
      ctx.moveTo(x - L / 2, y);
      ctx.lineTo(x + L / 2, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function hitCrop(g: ViewGeom, s: DevelopSettings, p: Vec2): { kind: 'handle'; h: Handle } | { kind: 'move' } | { kind: 'rotate' } {
  const r = cropScreenRect(g, s.crop);
  const tol = 12 * g.dpr;
  for (const h of HANDLES) {
    const [x, y] = handlePos(r, h);
    if (Math.abs(p[0] - x) < tol && Math.abs(p[1] - y) < tol) return { kind: 'handle', h };
  }
  if (p[0] > r.x && p[0] < r.x + r.w && p[1] > r.y && p[1] < r.y + r.h) return { kind: 'move' };
  return { kind: 'rotate' };
}

/** Resizes a crop rect (in frame pixels) by dragging a handle, optionally locking aspect (w/h). */
export function resizeRect(start: Rect, h: Handle, X: number, Y: number, aspect: number | null, min = 16): Rect {
  let x0 = start.x, y0 = start.y, x1 = start.x + start.w, y1 = start.y + start.h;
  if (h.dx === 1) x1 = Math.max(X, x0 + min);
  else if (h.dx === -1) x0 = Math.min(X, x1 - min);
  if (h.dy === 1) y1 = Math.max(Y, y0 + min);
  else if (h.dy === -1) y0 = Math.min(Y, y1 - min);
  if (aspect) {
    let w = x1 - x0;
    let hh = y1 - y0;
    if (h.dx && h.dy) {
      if (w / aspect > hh) hh = w / aspect;
      else w = hh * aspect;
    } else if (h.dx) hh = w / aspect;
    else w = hh * aspect;
    if (h.dx === 1) x1 = x0 + w;
    else if (h.dx === -1) x0 = x1 - w;
    else {
      const c = (x0 + x1) / 2;
      x0 = c - w / 2;
      x1 = c + w / 2;
    }
    if (h.dy === 1) y1 = y0 + hh;
    else if (h.dy === -1) y0 = y1 - hh;
    else {
      const c = (y0 + y1) / 2;
      y0 = c - hh / 2;
      y1 = c + hh / 2;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Moves from `from` toward `to` as far as possible while the crop still fits. */
export function fitToward(from: Rect, to: Rect, angle: number, wo: number, ho: number): Rect {
  if (cropFits(to, angle, wo, ho)) return to;
  let lo = 0;
  let hi = 1;
  const lerp = (t: number): Rect => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    w: from.w + (to.w - from.w) * t,
    h: from.h + (to.h - from.h) * t,
  });
  for (let i = 0; i < 14; i++) {
    const m = (lo + hi) / 2;
    if (cropFits(lerp(m), angle, wo, ho)) lo = m;
    else hi = m;
  }
  return lerp(lo);
}

// ---------------------------------------------------------------- masks
export function maskScreenPoints(g: ViewGeom, s: DevelopSettings, m: LocalMask, steps = 72): { outline: Vec2[]; inner: Vec2[] } {
  const W = g.fullW;
  const H = g.fullH;
  const map = (sx: number, sy: number) => toScreen(g, sourceToView([sx, sy], s, W, H, g.cropMode));
  if (m.type === 'radial') {
    const r = m.radial;
    const a = (r.angle * Math.PI) / 180;
    const pts = (k: number) => {
      const out: Vec2[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const ex = Math.cos(t) * r.rx * W * k;
        const ey = Math.sin(t) * r.ry * H * k;
        const px = r.cx * W + ex * Math.cos(a) - ey * Math.sin(a);
        const py = r.cy * H + ex * Math.sin(a) + ey * Math.cos(a);
        out.push(map(px / W, py / H));
      }
      return out;
    };
    return { outline: pts(1), inner: pts(Math.max(0.01, 1 - r.feather / 100)) };
  }
  // linear: two lines perpendicular to the gradient, through start and end
  const l = m.linear;
  const dx = (l.x1 - l.x0) * W;
  const dy = (l.y1 - l.y0) * H;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const ext = Math.hypot(W, H);
  const line = (x: number, y: number): Vec2[] => [
    map((x * W + nx * ext) / W, (y * H + ny * ext) / H),
    map((x * W - nx * ext) / W, (y * H - ny * ext) / H),
  ];
  return { outline: line(l.x0, l.y0), inner: line(l.x1, l.y1) };
}

export interface MaskHandle {
  id: 'center' | 'rx' | 'ry' | 'start' | 'end' | 'mid';
  pos: Vec2;
}

export function maskHandles(g: ViewGeom, s: DevelopSettings, m: LocalMask): MaskHandle[] {
  const W = g.fullW;
  const H = g.fullH;
  const map = (sx: number, sy: number) => toScreen(g, sourceToView([sx, sy], s, W, H, g.cropMode));
  if (m.type === 'radial') {
    const r = m.radial;
    const a = (r.angle * Math.PI) / 180;
    return [
      { id: 'center', pos: map(r.cx, r.cy) },
      { id: 'rx', pos: map(r.cx + (Math.cos(a) * r.rx * W) / W, r.cy + (Math.sin(a) * r.rx * W) / H) },
      { id: 'ry', pos: map(r.cx + (-Math.sin(a) * r.ry * H) / W, r.cy + (Math.cos(a) * r.ry * H) / H) },
    ];
  }
  const l = m.linear;
  return [
    { id: 'start', pos: map(l.x0, l.y0) },
    { id: 'end', pos: map(l.x1, l.y1) },
    { id: 'mid', pos: map((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2) },
  ];
}

export function drawMasks(ctx: CanvasRenderingContext2D, g: ViewGeom, s: DevelopSettings, activeId: string | null) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
  ctx.clip();
  for (const m of s.masks) {
    const active = m.id === activeId;
    const { outline, inner } = maskScreenPoints(g, s, m);
    ctx.lineWidth = (active ? 1.6 : 1) * g.dpr;
    ctx.strokeStyle = active ? '#fff' : 'rgba(255,255,255,0.45)';
    ctx.setLineDash(m.enabled ? [] : [4 * g.dpr, 4 * g.dpr]);
    const path = (pts: Vec2[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    };
    path(outline);
    ctx.setLineDash([3 * g.dpr, 3 * g.dpr]);
    path(inner);
    ctx.setLineDash([]);
    if (active) {
      for (const h of maskHandles(g, s, m)) {
        ctx.beginPath();
        ctx.arc(h.pos[0], h.pos[1], (h.id === 'center' || h.id === 'mid' ? 6 : 5) * g.dpr, 0, Math.PI * 2);
        ctx.fillStyle = h.id === 'center' || h.id === 'mid' ? '#3d8bfd' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Converts a screen point to source-normalized coordinates. */
export function screenToSource(g: ViewGeom, s: DevelopSettings, p: Vec2): Vec2 {
  return viewToSource(toView(g, p), s, g.fullW, g.fullH, g.cropMode);
}

// ---------------------------------------------------------------- touch-up spots
/** Device pixels on screen per full-resolution source pixel. */
export function screenScale(g: ViewGeom, s: DevelopSettings): number {
  return g.rect.w / cropOutSize(s, g.fullW, g.fullH, g.cropMode).w;
}

export interface SpotScreen {
  dst: Vec2[];
  src: Vec2[];
  r: number;
}

export function spotScreen(g: ViewGeom, s: DevelopSettings, sp: RetouchSpot): SpotScreen {
  const map = (x: number, y: number) => toScreen(g, sourceToView([x, y], s, g.fullW, g.fullH, g.cropMode));
  return {
    dst: sp.path.map(([x, y]) => map(x, y)),
    src: sp.path.map(([x, y]) => map(x + sp.dx, y + sp.dy)),
    r: sp.r * Math.max(g.fullW, g.fullH) * screenScale(g, s),
  };
}

function distToPolyline(p: Vec2, pts: Vec2[]): number {
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const vx = pts[i][0] - ax;
    const vy = pts[i][1] - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (ax + t * vx), p[1] - (ay + t * vy)));
  }
  return best;
}

export type SpotPart = 'dst' | 'src' | 'resize';

/** What a press at `p` grabs: the selected spot's source, rim or body first, then any other spot. */
export function hitSpot(g: ViewGeom, s: DevelopSettings, activeId: string | null, p: Vec2): { id: string; part: SpotPart } | null {
  const tol = 6 * g.dpr;
  const active = s.spots.find((x) => x.id === activeId);
  if (active) {
    const sc = spotScreen(g, s, active);
    const r = Math.max(sc.r, 4 * g.dpr);
    const dd = distToPolyline(p, sc.dst);
    if (Math.abs(dd - r) < tol && active.path.length === 1) return { id: active.id, part: 'resize' };
    if (active.mode !== 'redeye' && distToPolyline(p, sc.src) < r) return { id: active.id, part: 'src' };
    if (dd < r) return { id: active.id, part: 'dst' };
  }
  for (let i = s.spots.length - 1; i >= 0; i--) {
    const sp = s.spots[i];
    const sc = spotScreen(g, s, sp);
    if (distToPolyline(p, sc.dst) < Math.max(sc.r, 5 * g.dpr)) return { id: sp.id, part: 'dst' };
  }
  return null;
}

let scratch: HTMLCanvasElement | null = null;

/** Outline of a round-capped brush shape (a circle for one point). */
function outlineShape(ctx: CanvasRenderingContext2D, pts: Vec2[], r: number, color: string, lw: number, dash: number[] = []) {
  ctx.save();
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2);
    ctx.setLineDash(dash);
    ctx.lineWidth = lw + 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Ring = (stroke at 2r + 2·lw) minus (stroke at 2r), drawn offscreen so other overlay content survives.
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== W || scratch.height !== H) {
    scratch.width = W;
    scratch.height = H;
  }
  const sc = scratch.getContext('2d')!;
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, W, H);
  const path = () => {
    sc.beginPath();
    pts.forEach(([x, y], i) => (i ? sc.lineTo(x, y) : sc.moveTo(x, y)));
  };
  sc.lineCap = 'round';
  sc.lineJoin = 'round';
  path();
  sc.lineWidth = 2 * r + 2 * (lw + 1);
  sc.strokeStyle = 'rgba(0,0,0,0.45)';
  sc.stroke();
  path();
  sc.lineWidth = 2 * r + 2 * lw;
  sc.strokeStyle = color;
  sc.stroke();
  sc.globalCompositeOperation = 'destination-out';
  path();
  sc.lineWidth = 2 * r;
  sc.strokeStyle = '#000'; // opaque, so the interior is removed completely
  sc.stroke();
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

function arrow(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, rA: number, rB: number, dpr: number) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < rA + rB + 6 * dpr) return;
  const ux = dx / len;
  const uy = dy / len;
  const s: Vec2 = [a[0] + ux * rA, a[1] + uy * rA];
  const e: Vec2 = [b[0] - ux * rB, b[1] - uy * rB];
  const h = 7 * dpr;
  ctx.save();
  ctx.lineCap = 'round';
  for (const [color, lw] of [['rgba(0,0,0,0.45)', 3 * dpr], ['#fff', 1.4 * dpr]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(e[0], e[1]);
    ctx.moveTo(e[0] - ux * h - uy * h * 0.6, e[1] - uy * h + ux * h * 0.6);
    ctx.lineTo(e[0], e[1]);
    ctx.lineTo(e[0] - ux * h + uy * h * 0.6, e[1] - uy * h - ux * h * 0.6);
    ctx.stroke();
  }
  ctx.restore();
}

export interface SpotOverlayState {
  /** Pointer position (device px) for the brush preview, or null. */
  hover: Vec2 | null;
  /** Brush radius on screen (device px). */
  brushR: number;
  /** In-progress brushed path (device px). */
  painting: Vec2[] | null;
}

export function drawSpots(ctx: CanvasRenderingContext2D, g: ViewGeom, s: DevelopSettings, activeId: string | null, st: SpotOverlayState) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
  ctx.clip();
  const lw = 1.25 * g.dpr;
  for (const sp of s.spots) {
    if (sp.id === activeId) continue;
    const sc = spotScreen(g, s, sp);
    outlineShape(ctx, sc.dst, Math.max(sc.r, 3 * g.dpr), 'rgba(255,255,255,0.6)', lw);
  }
  const active = s.spots.find((x) => x.id === activeId);
  if (active) {
    const sc = spotScreen(g, s, active);
    const r = Math.max(sc.r, 3 * g.dpr);
    if (active.mode !== 'redeye') {
      outlineShape(ctx, sc.src, r, 'rgba(255,255,255,0.9)', lw, [4 * g.dpr, 3 * g.dpr]);
      const mid = Math.floor(sc.dst.length / 2);
      arrow(ctx, sc.src[mid], sc.dst[mid], sc.dst.length === 1 ? r : 0, sc.dst.length === 1 ? r : 0, g.dpr);
    }
    outlineShape(ctx, sc.dst, r, '#fff', 2 * g.dpr);
  }
  if (st.painting && st.painting.length) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = st.brushR * 2;
    ctx.beginPath();
    st.painting.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (st.painting.length === 1) {
      ctx.arc(st.painting[0][0], st.painting[0][1], st.brushR, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.stroke();
    ctx.restore();
  } else if (st.hover) {
    outlineShape(ctx, [st.hover], st.brushR, 'rgba(255,255,255,0.85)', lw);
  }
  ctx.restore();
}

export function orientedDims(s: DevelopSettings, w: number, h: number) {
  return orientedSize(w, h, s.orient.rotate);
}
