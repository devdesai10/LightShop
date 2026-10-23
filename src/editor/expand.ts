// Crop tool Expand: crops and/or grows the canvas to a box that may reach past the image, optionally scales the
// result to an exact size (a wallpaper preset), and fills the new area. The fill goes on a new top layer, so it
// can be hidden, retouched or deleted, and the photo's own layers are only moved (and scaled for presets).

import { createStore } from '../state/store';
import { toast } from '../state/app';
import { createCanvas, ctx2d } from '../lib/imageio';
import { applyCanvasChange, type LayerPlacement } from './actions';
import { EditorDoc, Layer, RasterLayer, Rect, isPixel } from './doc';
import { padded } from './filters';
import type { FillReply, FillRequest, WorkerFill } from './fillWorker';
import { editor } from './session';

export type ExpandFill = 'content' | 'blur' | 'soft' | 'mirror' | 'color' | 'none';

export const FILLS: { value: ExpandFill; label: string; title: string; layer: string }[] = [
  { value: 'content', label: 'Content-Aware', title: 'Continues the scene with details matched from the photo', layer: 'Content-Aware Fill' },
  { value: 'blur', label: 'Blurred Photo', title: 'An enlarged, blurred copy of the photo behind it', layer: 'Blurred Fill' },
  { value: 'soft', label: 'Extend Edges', title: 'Carries the edge colours outward, softer the further they go', layer: 'Edge Fill' },
  { value: 'mirror', label: 'Mirror', title: 'Reflects the photo at its edges', layer: 'Mirror Fill' },
  { value: 'color', label: 'Color', title: 'Fills the new area with one colour', layer: 'Color Fill' },
  { value: 'none', label: 'Transparent', title: 'Leaves the new area empty', layer: '' },
];

export interface SizePreset {
  id: string;
  group: string;
  label: string;
  w: number;
  h: number;
}

/** Native screen resolutions (Apple's published specs) and common desktop sizes. */
export const SIZE_PRESETS: SizePreset[] = [
  { id: 'mba13', group: 'Mac', label: 'MacBook Air 13″', w: 2560, h: 1664 },
  { id: 'mba15', group: 'Mac', label: 'MacBook Air 15″', w: 2880, h: 1864 },
  { id: 'mbp14', group: 'Mac', label: 'MacBook Pro 14″', w: 3024, h: 1964 },
  { id: 'mbp16', group: 'Mac', label: 'MacBook Pro 16″', w: 3456, h: 2234 },
  { id: 'imac24', group: 'Mac', label: 'iMac 24″', w: 4480, h: 2520 },
  { id: 'studio', group: 'Mac', label: 'Studio Display', w: 5120, h: 2880 },
  { id: 'xdr', group: 'Mac', label: 'Pro Display XDR', w: 6016, h: 3384 },
  { id: 'uhd', group: 'Desktop', label: '4K UHD', w: 3840, h: 2160 },
  { id: 'qhd', group: 'Desktop', label: '1440p QHD', w: 2560, h: 1440 },
  { id: 'fhd', group: 'Desktop', label: '1080p Full HD', w: 1920, h: 1080 },
  { id: 'wqxga', group: 'Desktop', label: '16:10 WQXGA', w: 2560, h: 1600 },
  { id: 'ultrawide', group: 'Desktop', label: 'Ultrawide 21:9', w: 3440, h: 1440 },
  { id: 'ip17pm', group: 'iPhone', label: 'iPhone 17 Pro Max', w: 1320, h: 2868 },
  { id: 'ip17', group: 'iPhone', label: 'iPhone 17 and 17 Pro', w: 1206, h: 2622 },
  { id: 'ipair', group: 'iPhone', label: 'iPhone Air', w: 1260, h: 2736 },
  { id: 'ip16', group: 'iPhone', label: 'iPhone 15 and 16', w: 1179, h: 2556 },
];

/** The screen LightShop is on, in device pixels (what macOS uses for the wallpaper). */
export function displayPreset(): SizePreset | null {
  const s = window.screen;
  const d = window.devicePixelRatio || 1;
  if (!s || !s.width || !s.height) return null;
  return { id: 'display', group: 'This Mac', label: 'This display', w: Math.round(s.width * d), h: Math.round(s.height * d) };
}

export const presetById = (id: string): SizePreset | null => (id === 'display' ? displayPreset() : (SIZE_PRESETS.find((p) => p.id === id) ?? null));

/** Smallest box of the aspect (w/h) that holds the whole canvas, centred on it. */
export function containBox(size: { width: number; height: number }, aspect: number): Rect {
  const W = size.width;
  const H = size.height;
  let w = W;
  let h = W / aspect;
  if (h < H) {
    h = H;
    w = H * aspect;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// ---------------------------------------------------------------- plan

/** Largest result the Crop tool makes (pixels): about 8000 × 8000. */
const MAX_CANVAS_PX = 64e6;
/** Larger results are filled at a reduced size and enlarged (content-aware and edge fills). */
const MAX_FILL_PX = 24e6;

export interface ExpandPlan {
  doc: EditorDoc;
  /** The crop box in whole document pixels. */
  box: Rect;
  outW: number;
  outH: number;
  /** Where the current canvas lands in the result. */
  photo: Rect;
  placements: Map<Layer, LayerPlacement>;
  masks: Map<Layer, HTMLCanvasElement>;
  /** The box reaches past the canvas. */
  expands: boolean;
  /** Document state the plan was made from. */
  state: unknown[];
}

const stateOf = (doc: EditorDoc): unknown[] => [doc.hIndex, doc.history[doc.hIndex], doc.history.length, doc.layers, doc.width, doc.height];
const sameState = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Works out the new canvas: every layer moved (and scaled to `out`), every mask remapped. Changes nothing yet. */
export function planExpand(doc: EditorDoc, rect: Rect, out?: { w: number; h: number } | null): ExpandPlan {
  const box = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) };
  const outW = Math.max(1, Math.round(out?.w ?? box.w));
  const outH = Math.max(1, Math.round(out?.h ?? box.h));
  const sx = outW / box.w;
  const sy = outH / box.h;
  const scaled = outW !== box.w || outH !== box.h;
  const place = (x: number, y: number, w: number, h: number): Rect =>
    scaled
      ? { x: Math.round((x - box.x) * sx), y: Math.round((y - box.y) * sy), w: Math.max(1, Math.round(w * sx)), h: Math.max(1, Math.round(h * sy)) }
      : { x: x - box.x, y: y - box.y, w, h };
  const photo = place(0, 0, doc.width, doc.height);
  const placements = new Map<Layer, LayerPlacement>();
  const masks = new Map<Layer, HTMLCanvasElement>();
  for (const l of doc.layers) {
    if (isPixel(l)) {
      if (!scaled) placements.set(l, { canvas: l.canvas, x: l.x - box.x, y: l.y - box.y, rasterize: false });
      else {
        const r = place(l.x, l.y, l.canvas.width, l.canvas.height);
        const c = createCanvas(r.w, r.h);
        const g = ctx2d(c);
        g.imageSmoothingQuality = 'high';
        g.drawImage(l.canvas, 0, 0, r.w, r.h);
        placements.set(l, { canvas: c, x: r.x, y: r.y, rasterize: true });
      }
    }
    if (l.mask) {
      // Masks reveal the new area, so adjustment layers and masked layers keep working there.
      const m = createCanvas(outW, outH);
      const g = ctx2d(m);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, outW, outH);
      g.clearRect(photo.x, photo.y, photo.w, photo.h);
      g.imageSmoothingQuality = 'high';
      g.drawImage(l.mask, photo.x, photo.y, photo.w, photo.h);
      masks.set(l, m);
    }
  }
  const expands = box.x < 0 || box.y < 0 || box.x + box.w > doc.width || box.y + box.h > doc.height;
  return { doc, box, outW, outH, photo, placements, masks, expands, state: stateOf(doc) };
}

/** The result's composite before any fill. */
function renderPlan(plan: ExpandPlan): HTMLCanvasElement {
  const tmp = new EditorDoc('expand', plan.outW, plan.outH);
  tmp.layers = plan.doc.layers.map((l) => {
    const p = plan.placements.get(l);
    return { ...l, ...(p ? { canvas: p.canvas, x: p.x, y: p.y } : {}), mask: plan.masks.get(l) ?? null } as Layer;
  });
  const out = createCanvas(plan.outW, plan.outH);
  tmp.renderInto(out);
  return out;
}

/** 1 for pixels to keep: inside the old canvas, or opaque layer pixels that were outside it. */
function knownMask(w: number, h: number, photo: Rect, rgba: Uint8ClampedArray): Uint8Array {
  const k = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.ceil(photo.x - 1e-6));
  const y0 = Math.max(0, Math.ceil(photo.y - 1e-6));
  const x1 = Math.min(w, Math.floor(photo.x + photo.w + 1e-6));
  const y1 = Math.min(h, Math.floor(photo.y + photo.h + 1e-6));
  for (let y = 0; y < h; y++) {
    const inY = y >= y0 && y < y1;
    for (let x = 0, i = y * w; x < w; x++, i++) k[i] = (inY && x >= x0 && x < x1) || rgba[i * 4 + 3] >= 250 ? 1 : 0;
  }
  return k;
}

// ---------------------------------------------------------------- fills

const abortError = () => new DOMException('Cancelled', 'AbortError');
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Runs a fill in a Web Worker (or on this thread when workers are unavailable). */
function runFill(mode: WorkerFill, w: number, h: number, rgba: Uint8ClampedArray, known: Uint8Array, onProgress: (f: number) => void, signal: AbortSignal): Promise<Uint8ClampedArray<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let worker: Worker | null = null;
    let sent = false;
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker?.terminate();
      worker = null;
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const inline = async () => {
      cleanup();
      try {
        const I = await import('./inpaint');
        if (signal.aborted) return reject(abortError());
        resolve(mode === 'content' ? I.contentAwareFill({ w, h, rgba, known }) : I.softFill({ w, h, rgba, known }));
      } catch (e) {
        reject(e);
      }
    };
    signal.addEventListener('abort', onAbort);
    try {
      worker = new Worker(new URL('./fillWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      return void inline();
    }
    // The pixels are handed over only once the worker says it's running, so a worker that can't load
    // falls back to this thread with the data still here.
    timer = window.setTimeout(() => !sent && inline(), 8000);
    worker.onmessage = (e: MessageEvent<FillReply>) => {
      const m = e.data;
      if (m.type === 'ready') {
        sent = true;
        clearTimeout(timer);
        const req: FillRequest = { mode, w, h, rgba, known };
        worker!.postMessage(req, [rgba.buffer, known.buffer]);
      } else if (m.type === 'progress') onProgress(m.value);
      else if (m.type === 'done') {
        cleanup();
        resolve(m.rgba);
      } else {
        cleanup();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (!sent) return void inline();
      cleanup();
      reject(new Error(e.message || 'The fill stopped unexpectedly'));
    };
  });
}

/** The photo, enlarged to cover the canvas around its centre and strongly blurred. */
function blurInto(g: CanvasRenderingContext2D, plan: ExpandPlan, composite: HTMLCanvasElement) {
  const { outW, outH } = plan;
  const x0 = Math.max(0, plan.photo.x);
  const y0 = Math.max(0, plan.photo.y);
  const x1 = Math.min(outW, plan.photo.x + plan.photo.w);
  const y1 = Math.min(outH, plan.photo.y + plan.photo.h);
  const I = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  const cx = I.x + I.w / 2;
  const cy = I.y + I.h / 2;
  const s = Math.max((2 * Math.max(cx, outW - cx)) / I.w, (2 * Math.max(cy, outH - cy)) / I.h);
  const dw = I.w * s;
  const dh = I.h * s;
  // Blur a small copy: at this strength, enlarging it afterwards looks the same and costs nothing.
  const k = Math.min(1, 480 / Math.max(I.w, I.h));
  const sw = Math.max(1, Math.round(I.w * k));
  const sh = Math.max(1, Math.round(I.h * k));
  const small = createCanvas(sw, sh);
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(composite, I.x, I.y, I.w, I.h, 0, 0, sw, sh);
  const sigma = Math.max(1.5, (0.025 * Math.max(outW, outH) * sw) / dw);
  const pad = Math.ceil(sigma * 3) + 2;
  const p = padded(small, pad);
  const b = createCanvas(p.width, p.height);
  const bg = ctx2d(b);
  bg.filter = `blur(${sigma}px)`;
  bg.drawImage(p, 0, 0);
  g.imageSmoothingQuality = 'high';
  g.drawImage(b, pad, pad, sw, sh, cx - dw / 2, cy - dh / 2, dw, dh);
}

/** The photo reflected at its edges, again and again outward. */
function mirrorInto(g: CanvasRenderingContext2D, plan: ExpandPlan, src: HTMLCanvasElement) {
  const P = plan.photo;
  const i0 = Math.floor((0 - P.x) / P.w);
  const i1 = Math.floor((plan.outW - 1 - P.x) / P.w);
  const j0 = Math.floor((0 - P.y) / P.h);
  const j1 = Math.floor((plan.outH - 1 - P.y) / P.h);
  g.imageSmoothingQuality = 'high';
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const fx = Math.abs(i) % 2 === 1;
      const fy = Math.abs(j) % 2 === 1;
      g.setTransform(fx ? -1 : 1, 0, 0, fy ? -1 : 1, P.x + i * P.w + (fx ? P.w : 0), P.y + j * P.h + (fy ? P.h : 0));
      g.drawImage(src, 0, 0, P.w, P.h);
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/** Pixels for the new area (the whole result size; only the unknown pixels are used). */
async function computeFill(
  plan: ExpandPlan,
  composite: HTMLCanvasElement,
  img: ImageData,
  known: Uint8Array,
  mode: ExpandFill,
  color: string,
  onProgress: (f: number) => void,
  signal: AbortSignal,
): Promise<ImageData> {
  const { outW, outH } = plan;
  if (mode === 'content' || mode === 'soft') {
    const scale = Math.min(1, Math.sqrt(MAX_FILL_PX / (outW * outH)));
    if (scale >= 1) return new ImageData(await runFill(mode, outW, outH, new Uint8ClampedArray(img.data), known.slice(), onProgress, signal), outW, outH);
    const w = Math.max(1, Math.round(outW * scale));
    const h = Math.max(1, Math.round(outH * scale));
    const small = createCanvas(w, h);
    const sg = ctx2d(small, true);
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(composite, 0, 0, w, h);
    const sImg = sg.getImageData(0, 0, w, h);
    const P = { x: plan.photo.x * (w / outW), y: plan.photo.y * (h / outH), w: plan.photo.w * (w / outW), h: plan.photo.h * (h / outH) };
    const res = await runFill(mode, w, h, sImg.data, knownMask(w, h, P, sImg.data), onProgress, signal);
    sg.putImageData(new ImageData(res, w, h), 0, 0);
    const big = createCanvas(outW, outH);
    const bg = ctx2d(big, true);
    bg.imageSmoothingQuality = 'high';
    bg.drawImage(small, 0, 0, outW, outH);
    return bg.getImageData(0, 0, outW, outH);
  }
  const c = createCanvas(outW, outH);
  const g = ctx2d(c);
  if (mode === 'color') {
    g.fillStyle = color;
    g.fillRect(0, 0, outW, outH);
  } else if (mode === 'blur') blurInto(g, plan, composite);
  else if (mode === 'mirror') mirrorInto(g, plan, plan.doc.getComposite());
  return g.getImageData(0, 0, outW, outH);
}

/** The fill as a canvas that is transparent wherever the photo is. */
function fillCanvas(img: ImageData, known: Uint8Array): HTMLCanvasElement {
  const d = img.data;
  for (let i = 0, j = 3; i < known.length; i++, j += 4) d[j] = known[i] ? 0 : 255;
  const c = createCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------------- apply

export interface ExpandJob {
  title: string;
  detail: string;
  /** 0..1, or null while it can't be measured. */
  progress: number | null;
  cancel: () => void;
}

/** The running fill, shown as a progress sheet. */
export const expandJob = createStore<{ job: ExpandJob | null }>({ job: null });

let running = false;
export const isExpanding = () => running;

/**
 * Crops or expands `doc` to `rect` (document pixels; may reach past the canvas), scales the result to `out`
 * when given, and fills any new area: one undoable step. Resolves false if nothing changed.
 */
export async function expandCanvas(doc: EditorDoc, rect: Rect, opts: { out?: { w: number; h: number } | null; fill: ExpandFill; color: string }): Promise<boolean> {
  if (running) return false;
  const plan = planExpand(doc, rect, opts.out);
  const { box, outW, outH } = plan;
  if (box.x >= doc.width || box.y >= doc.height || box.x + box.w <= 0 || box.y + box.h <= 0) {
    toast('The crop box has to overlap the image');
    return false;
  }
  if (outW * outH > MAX_CANVAS_PX) {
    toast(`${outW.toLocaleString()} × ${outH.toLocaleString()} px is too large. Make the box smaller or choose a size under Expand to.`, 'error', 6000);
    return false;
  }
  const label = plan.expands ? 'Expand Canvas' : 'Crop';
  const fill = plan.expands ? opts.fill : 'none';
  if (fill === 'none') {
    applyCanvasChange(doc, label, outW, outH, plan.placements, plan.masks, null);
    return true;
  }
  const def = FILLS.find((f) => f.value === fill)!;
  running = true;
  const ac = new AbortController();
  const slow = fill === 'content' || fill === 'soft';
  try {
    if (slow) {
      const cancel = () => ac.abort();
      expandJob.set({ job: { title: 'Expanding the canvas', detail: `${def.label} fill · ${outW.toLocaleString()} × ${outH.toLocaleString()} px`, progress: fill === 'content' ? 0 : null, cancel } });
      await nextFrame();
    }
    const composite = renderPlan(plan);
    const img = ctx2d(composite).getImageData(0, 0, outW, outH);
    const known = knownMask(outW, outH, plan.photo, img.data);
    if (known.every((v) => v === 1)) {
      applyCanvasChange(doc, label, outW, outH, plan.placements, plan.masks, null);
      return true;
    }
    let last = 0;
    const onProgress = (f: number) => {
      const job = expandJob.get().job;
      if (!job || f - last < 0.01) return;
      last = f;
      expandJob.set({ job: { ...job, progress: f } });
    };
    const filled = await computeFill(plan, composite, img, known, fill, opts.color, onProgress, ac.signal);
    if (!editor.get().docs.includes(doc)) return false;
    if (!sameState(plan.state, stateOf(doc))) {
      toast('The image changed while the fill was being made. Try again.', 'error');
      return false;
    }
    const layer: RasterLayer = doc.newRaster(def.layer, fillCanvas(filled, known), 0, 0);
    applyCanvasChange(doc, label, outW, outH, plan.placements, plan.masks, layer);
    return true;
  } catch (e) {
    if (isAbort(e)) return false;
    console.error(e);
    toast(`Could not fill the new area: ${(e as Error).message}`, 'error', 6000);
    return false;
  } finally {
    running = false;
    expandJob.set({ job: null });
  }
}

// ---------------------------------------------------------------- preview

/** Long edge of the fill preview shown in the crop box (pixels). */
const PREVIEW_EDGE = 480;

let preview: { key: string; canvas: HTMLCanvasElement } | null = null;
let pending: { key: string; ac: AbortController } | null = null;
let previewTimer = 0;

export function previewKey(doc: EditorDoc, rect: Rect, fill: ExpandFill, color: string): string {
  const r = [rect.x, rect.y, rect.w, rect.h].map(Math.round).join(',');
  return `${doc.id}|${doc.pixelVersion}|${doc.width}x${doc.height}|${r}|${fill}|${fill === 'color' ? color : ''}`;
}

/** The finished preview for this key, if any (a canvas covering the box, transparent over the photo). */
export const previewFor = (key: string): HTMLCanvasElement | null => (preview?.key === key ? preview.canvas : null);
export const previewPending = (key: string) => pending?.key === key;

/** Starts making a small preview of the fill for the box; `done` runs when it's ready. */
export function requestPreview(doc: EditorDoc, rect: Rect, fill: ExpandFill, color: string, done: () => void) {
  const key = previewKey(doc, rect, fill, color);
  if (preview?.key === key || pending?.key === key) return;
  cancelPreview();
  const ac = new AbortController();
  pending = { key, ac };
  previewTimer = window.setTimeout(async () => {
    try {
      const k = Math.min(1, PREVIEW_EDGE / Math.max(rect.w, rect.h));
      const plan = planExpand(doc, rect, { w: Math.max(1, Math.round(rect.w * k)), h: Math.max(1, Math.round(rect.h * k)) });
      const composite = renderPlan(plan);
      const img = ctx2d(composite).getImageData(0, 0, plan.outW, plan.outH);
      const known = knownMask(plan.outW, plan.outH, plan.photo, img.data);
      const filled = await computeFill(plan, composite, img, known, fill, color, () => {}, ac.signal);
      if (ac.signal.aborted) return;
      preview = { key, canvas: fillCanvas(filled, known) };
      done();
    } catch (e) {
      if (!isAbort(e)) console.warn('Fill preview failed', e);
    } finally {
      if (pending?.ac === ac) pending = null;
    }
  }, 120);
}

export function cancelPreview() {
  clearTimeout(previewTimer);
  pending?.ac.abort();
  pending = null;
}
