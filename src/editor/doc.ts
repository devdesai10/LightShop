// Editor document model: layers, masks, selection, compositing and undo history.

import { Emitter } from '../state/store';
import { createCanvas, ctx2d } from '../lib/imageio';
import { uid } from '../lib/util';
import { Adjustment, adjustmentFilter } from './adjust';

export type BlendMode =
  | 'normal' | 'darken' | 'multiply' | 'color-burn' | 'lighten' | 'screen' | 'color-dodge' | 'lighter'
  | 'overlay' | 'soft-light' | 'hard-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export const BLEND_MODES: { value: BlendMode; label: string; psd: string }[] = [
  { value: 'normal', label: 'Normal', psd: 'norm' },
  { value: 'darken', label: 'Darken', psd: 'dark' },
  { value: 'multiply', label: 'Multiply', psd: 'mul ' },
  { value: 'color-burn', label: 'Color Burn', psd: 'idiv' },
  { value: 'lighten', label: 'Lighten', psd: 'lite' },
  { value: 'screen', label: 'Screen', psd: 'scrn' },
  { value: 'color-dodge', label: 'Color Dodge', psd: 'div ' },
  { value: 'lighter', label: 'Linear Dodge (Add)', psd: 'lddg' },
  { value: 'overlay', label: 'Overlay', psd: 'over' },
  { value: 'soft-light', label: 'Soft Light', psd: 'sLit' },
  { value: 'hard-light', label: 'Hard Light', psd: 'hLit' },
  { value: 'difference', label: 'Difference', psd: 'diff' },
  { value: 'exclusion', label: 'Exclusion', psd: 'smud' },
  { value: 'hue', label: 'Hue', psd: 'hue ' },
  { value: 'saturation', label: 'Saturation', psd: 'sat ' },
  { value: 'color', label: 'Color', psd: 'colr' },
  { value: 'luminosity', label: 'Luminosity', psd: 'lum ' },
];

export const compositeOp = (b: BlendMode): GlobalCompositeOperation => (b === 'normal' ? 'source-over' : b);

export interface TextProps {
  text: string;
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  /** Document-sized mask; alpha channel = reveal amount. */
  mask: HTMLCanvasElement | null;
  maskEnabled: boolean;
}
export interface RasterLayer extends LayerBase {
  kind: 'raster';
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}
export interface TextLayer extends LayerBase {
  kind: 'text';
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  text: TextProps;
}
export interface AdjustLayer extends LayerBase {
  kind: 'adjust';
  adj: Adjustment;
}
export type Layer = RasterLayer | TextLayer | AdjustLayer;
export type PixelLayer = RasterLayer | TextLayer;
export const isPixel = (l: Layer | undefined | null): l is PixelLayer => !!l && l.kind !== 'adjust';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Selection {
  mask: HTMLCanvasElement;
  bounds: Rect;
  outline: Path2D;
}

/** Live, uncommitted modifications shown by the compositor (brush strokes, filter previews, moves). */
export type Preview =
  | { kind: 'stroke'; layerId: string; target: 'layer' | 'mask'; canvas: HTMLCanvasElement; opacity: number; erase: boolean }
  | { kind: 'replace'; layerId: string; canvas: HTMLCanvasElement; x: number; y: number }
  | { kind: 'mask-replace'; layerId: string; canvas: HTMLCanvasElement };

interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
  bytes: number;
}

interface LayerProps {
  kind: Layer['kind'];
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  mask: HTMLCanvasElement | null;
  maskEnabled: boolean;
  canvas?: HTMLCanvasElement;
  x?: number;
  y?: number;
  text?: TextProps;
  adj?: Adjustment;
}
interface DocState {
  width: number;
  height: number;
  layers: { layer: Layer; props: LayerProps }[];
  activeId: string;
  selection: Selection | null;
}

const HISTORY_BUDGET = 1.2e9;
const HISTORY_MAX = 80;

/**
 * Content revision of a canvas, bumped by in-place pixel edits (commitPatch) and put back by their undo/redo.
 * Whole-canvas changes replace the canvas object instead, so (canvas, revision) identifies layer content.
 */
const canvasRevs = new WeakMap<HTMLCanvasElement, number>();
let revCounter = 0;
export const canvasRev = (c: HTMLCanvasElement) => canvasRevs.get(c) ?? 0;

/** Ties a document's base layer to a catalog photo's Develop settings, so Develop edits can flow in. */
export interface DevLink {
  photoId: string;
  layerId: string;
  /** Develop settings (as a key) rendered into the layer. */
  key: string;
  /** Layer content at the last sync; anything else means the layer was edited in the Editor. */
  canvas: HTMLCanvasElement;
  rev: number;
  /** Develop state the user chose not to bring in, so they aren't asked again for it. */
  declinedKey?: string;
}

export function textFont(t: TextProps) {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.size}px ${t.font}`;
}

/** Renders text into a tight canvas (with a small pad). */
export function renderText(t: TextProps): HTMLCanvasElement {
  const lines = t.text.split('\n');
  const probe = ctx2d(createCanvas(1, 1));
  probe.font = textFont(t);
  const widths = lines.map((l) => probe.measureText(l || ' ').width);
  const pad = Math.ceil(t.size * 0.25);
  const lh = t.size * t.lineHeight;
  const w = Math.ceil(Math.max(1, ...widths)) + pad * 2;
  const h = Math.ceil(lh * lines.length) + pad * 2;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.font = textFont(t);
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const lw = widths[i];
    const x = t.align === 'left' ? pad : t.align === 'center' ? pad + (w - pad * 2 - lw) / 2 : w - pad - lw;
    ctx.fillText(l, x, pad + i * lh + t.size * 0.88 + (lh - t.size) / 2);
  });
  return c;
}

export class EditorDoc extends Emitter {
  id = uid('d');
  name: string;
  width: number;
  height: number;
  layers: Layer[] = [];
  activeId = '';
  editMask = false;
  selection: Selection | null = null;
  preview: Preview | null = null;
  history: HistoryEntry[] = [];
  hIndex = -1;
  openLabel = 'Open';
  dirty = false;
  sourcePhotoId?: string;
  /** Catalog photo this document was last saved as. */
  savedPhotoId?: string;
  /** Set when the document shows a catalog photo as developed; see DevLink. */
  devLink?: DevLink;
  readonly composite: HTMLCanvasElement;
  private compositeDirty = true;
  private temps = new Map<string, HTMLCanvasElement>();
  /** Bumped whenever pixels change, for thumbnails. */
  pixelVersion = 0;

  constructor(name: string, width: number, height: number) {
    super();
    this.name = name;
    this.width = width;
    this.height = height;
    this.composite = createCanvas(width, height);
  }

  // ---------------------------------------------------------------- layers
  get active(): Layer | undefined {
    return this.layers.find((l) => l.id === this.activeId);
  }
  indexOf(id: string) {
    return this.layers.findIndex((l) => l.id === id);
  }
  layer(id: string) {
    return this.layers.find((l) => l.id === id);
  }

  newRaster(name: string, canvas?: HTMLCanvasElement, x = 0, y = 0): RasterLayer {
    return {
      id: uid('l'),
      kind: 'raster',
      name,
      visible: true,
      opacity: 1,
      blend: 'normal',
      locked: false,
      mask: null,
      maskEnabled: true,
      canvas: canvas ?? createCanvas(this.width, this.height),
      x,
      y,
    };
  }

  newText(t: TextProps, x: number, y: number): TextLayer {
    return {
      id: uid('l'),
      kind: 'text',
      name: t.text.split('\n')[0].slice(0, 32) || 'Text',
      visible: true,
      opacity: 1,
      blend: 'normal',
      locked: false,
      mask: null,
      maskEnabled: true,
      canvas: renderText(t),
      x,
      y,
      text: { ...t },
    };
  }

  newAdjust(name: string, adj: Adjustment): AdjustLayer {
    return { id: uid('l'), kind: 'adjust', name, visible: true, opacity: 1, blend: 'normal', locked: false, mask: null, maskEnabled: true, adj };
  }

  // ---------------------------------------------------------------- change notification
  /** Fires on every visual change (including live previews); panels listen to `emit` instead. */
  readonly onRender = new Emitter();

  changed(pixels = true) {
    if (pixels) {
      this.compositeDirty = true;
      this.pixelVersion++;
    }
    this.dirty = true;
    this.emit();
    this.onRender.emit();
  }
  /** Re-render request without marking the document modified (previews). */
  invalidate() {
    this.compositeDirty = true;
    this.onRender.emit();
  }

  // ---------------------------------------------------------------- history
  private snapshot(): DocState {
    return {
      width: this.width,
      height: this.height,
      activeId: this.activeId,
      selection: this.selection,
      layers: this.layers.map((l) => ({
        layer: l,
        props: {
          kind: l.kind,
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          blend: l.blend,
          locked: l.locked,
          mask: l.mask,
          maskEnabled: l.maskEnabled,
          ...(l.kind !== 'adjust' ? { canvas: l.canvas, x: l.x, y: l.y } : {}),
          ...(l.kind === 'text' ? { text: { ...l.text } } : {}),
          ...(l.kind === 'adjust' ? { adj: structuredClone(l.adj) } : {}),
        },
      })),
    };
  }

  private restore(st: DocState) {
    this.width = st.width;
    this.height = st.height;
    if (this.composite.width !== st.width || this.composite.height !== st.height) {
      this.composite.width = st.width;
      this.composite.height = st.height;
    }
    this.layers = st.layers.map(({ layer, props }) => Object.assign(layer, structuredCloneShallow(props)));
    this.activeId = st.activeId;
    this.selection = st.selection;
    this.preview = null;
  }

  private push(e: HistoryEntry) {
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(e);
    this.hIndex = this.history.length - 1;
    let total = this.history.reduce((a, h) => a + h.bytes, 0);
    while (this.history.length > 1 && (total > HISTORY_BUDGET || this.history.length > HISTORY_MAX)) {
      total -= this.history[0].bytes;
      this.history.shift();
      this.hIndex--;
      this.openLabel = '(older steps discarded)';
    }
  }

  /**
   * Runs a structural/whole-layer change as one undoable step. `fn` must replace canvases, not mutate them.
   * `hooks` run after the document state is restored on undo/redo (for state kept outside the layers).
   */
  commit(label: string, fn: () => void, hooks?: { undo?: () => void; redo?: () => void }) {
    const before = this.snapshot();
    fn();
    const after = this.snapshot();
    const old = new Set<HTMLCanvasElement>();
    for (const l of before.layers) {
      if (l.props.canvas) old.add(l.props.canvas);
      if (l.props.mask) old.add(l.props.mask);
    }
    let bytes = 0;
    for (const l of after.layers) {
      for (const c of [l.props.canvas, l.props.mask]) if (c && !old.has(c)) bytes += c.width * c.height * 4;
    }
    if (after.selection && after.selection !== before.selection) bytes += after.selection.mask.width * after.selection.mask.height * 4;
    this.push({
      label,
      undo: () => {
        this.restore(before);
        hooks?.undo?.();
      },
      redo: () => {
        this.restore(after);
        hooks?.redo?.();
      },
      bytes,
    });
    this.changed();
  }

  /** Records an in-place pixel change of `target` limited to `rect`. */
  commitPatch(label: string, target: HTMLCanvasElement, rect: Rect, draw: () => void) {
    const r = clipRect(rect, { x: 0, y: 0, w: target.width, h: target.height });
    if (!r) {
      draw();
      this.changed();
      return;
    }
    const grab = () => {
      const c = createCanvas(r.w, r.h);
      ctx2d(c).drawImage(target, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return c;
    };
    const before = grab();
    const rev0 = canvasRev(target);
    draw();
    const after = grab();
    const rev1 = ++revCounter;
    canvasRevs.set(target, rev1);
    const restorePatch = (src: HTMLCanvasElement, rev: number) => {
      const ctx = ctx2d(target);
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.drawImage(src, r.x, r.y);
      canvasRevs.set(target, rev);
    };
    this.push({ label, undo: () => restorePatch(before, rev0), redo: () => restorePatch(after, rev1), bytes: r.w * r.h * 8 });
    this.changed();
  }

  undo() {
    if (this.hIndex < 0) return;
    this.history[this.hIndex].undo();
    this.hIndex--;
    this.changed();
  }
  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex++;
    this.history[this.hIndex].redo();
    this.changed();
  }
  jumpTo(i: number) {
    while (this.hIndex > i) {
      this.history[this.hIndex].undo();
      this.hIndex--;
    }
    while (this.hIndex < i && this.hIndex < this.history.length - 1) {
      this.hIndex++;
      this.history[this.hIndex].redo();
    }
    this.changed();
  }

  // ---------------------------------------------------------------- temp canvases
  temp(key: string, w = this.width, h = this.height): HTMLCanvasElement {
    let c = this.temps.get(key);
    if (!c) {
      c = createCanvas(w, h);
      this.temps.set(key, c);
    } else if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = ctx2d(c);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    return c;
  }

  // ---------------------------------------------------------------- compositing
  /** Pixel source for a layer including any live preview (doc-positioned). */
  layerSource(l: PixelLayer): { src: HTMLCanvasElement; x: number; y: number } {
    const p = this.preview;
    if (p && p.layerId === l.id) {
      if (p.kind === 'replace') return { src: p.canvas, x: p.x, y: p.y };
      if (p.kind === 'stroke' && p.target === 'layer') {
        const t = this.temp('stroke-compose');
        const ctx = ctx2d(t);
        ctx.drawImage(l.canvas, l.x, l.y);
        const stroke = this.clipToSelection(p.canvas, 'stroke-clip');
        ctx.globalAlpha = p.opacity;
        ctx.globalCompositeOperation = p.erase ? 'destination-out' : 'source-over';
        ctx.drawImage(stroke, 0, 0);
        return { src: t, x: 0, y: 0 };
      }
    }
    return { src: l.canvas, x: l.x, y: l.y };
  }

  layerMask(l: Layer): HTMLCanvasElement | null {
    const p = this.preview;
    if (p && p.layerId === l.id) {
      if (p.kind === 'mask-replace') return p.canvas;
      if (p.kind === 'stroke' && p.target === 'mask' && l.mask) {
        const t = this.temp('mask-compose');
        const ctx = ctx2d(t);
        ctx.drawImage(l.mask, 0, 0);
        const stroke = this.clipToSelection(p.canvas, 'stroke-clip');
        ctx.globalAlpha = p.opacity;
        ctx.globalCompositeOperation = p.erase ? 'destination-out' : 'source-over';
        ctx.drawImage(stroke, 0, 0);
        return t;
      }
    }
    return l.mask && l.maskEnabled ? l.mask : null;
  }

  /** Returns `src` (doc-sized) masked by the selection, or `src` itself when nothing is selected. */
  clipToSelection(src: HTMLCanvasElement, key: string): HTMLCanvasElement {
    if (!this.selection) return src;
    const t = this.temp(key);
    const ctx = ctx2d(t);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.selection.mask, 0, 0);
    return t;
  }

  /** Renders layers [0, upto) into `out` (defaults to all layers into the composite). */
  renderInto(out: HTMLCanvasElement, upto = this.layers.length, opts: { skipHidden?: boolean } = {}) {
    const ctx = ctx2d(out);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, out.width, out.height);
    for (let i = 0; i < upto; i++) {
      const l = this.layers[i];
      if (!l.visible && opts.skipHidden !== false) continue;
      const mask = this.layerMask(l);
      if (l.kind === 'adjust') {
        this.applyAdjust(out, l, mask);
        continue;
      }
      const { src, x, y } = this.layerSource(l);
      let img: HTMLCanvasElement = src;
      let ix = x;
      let iy = y;
      if (mask) {
        const t = this.temp('mask-apply');
        const tc = ctx2d(t);
        tc.drawImage(src, x, y);
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(mask, 0, 0);
        img = t;
        ix = 0;
        iy = 0;
      }
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = compositeOp(l.blend);
      ctx.drawImage(img, ix, iy);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private applyAdjust(out: HTMLCanvasElement, l: AdjustLayer, mask: HTMLCanvasElement | null) {
    const filtered = this.temp('adj-filtered', out.width, out.height);
    const fctx = ctx2d(filtered);
    fctx.filter = adjustmentFilter(l.adj);
    fctx.drawImage(out, 0, 0);
    fctx.filter = 'none';
    const octx = ctx2d(out);
    if (!mask && l.opacity >= 1) {
      octx.save();
      octx.globalCompositeOperation = 'copy';
      octx.drawImage(filtered, 0, 0);
      octx.restore();
      return;
    }
    // out = out * (1 - m*op) + filtered * (m*op), exact for premultiplied colour via 'lighter'
    const keep = this.temp('adj-keep', out.width, out.height);
    const kctx = ctx2d(keep);
    kctx.drawImage(out, 0, 0);
    kctx.globalCompositeOperation = 'destination-out';
    kctx.globalAlpha = l.opacity;
    if (mask) kctx.drawImage(mask, 0, 0);
    else kctx.fillRect(0, 0, out.width, out.height);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.globalAlpha = l.opacity;
    if (mask) fctx.drawImage(mask, 0, 0);
    else fctx.fillRect(0, 0, out.width, out.height);
    fctx.globalAlpha = 1;
    fctx.globalCompositeOperation = 'source-over';
    octx.save();
    octx.globalCompositeOperation = 'copy';
    octx.drawImage(keep, 0, 0);
    octx.globalCompositeOperation = 'lighter';
    octx.drawImage(filtered, 0, 0);
    octx.restore();
  }

  /** Up-to-date composite of all visible layers. */
  getComposite(): HTMLCanvasElement {
    if (this.composite.width !== this.width || this.composite.height !== this.height) {
      this.composite.width = this.width;
      this.composite.height = this.height;
      this.compositeDirty = true;
    }
    if (this.compositeDirty) {
      this.renderInto(this.composite);
      this.compositeDirty = false;
    }
    return this.composite;
  }

  /** A flattened copy (new canvas), optionally on an opaque background. */
  flatten(background?: string): HTMLCanvasElement {
    const c = createCanvas(this.width, this.height);
    const ctx = ctx2d(c);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(this.getComposite(), 0, 0);
    return c;
  }

  // ---------------------------------------------------------------- selection
  setSelection(sel: Selection | null, label: string) {
    if (!sel && !this.selection) return;
    this.commit(label, () => {
      this.selection = sel;
    });
  }
}

function structuredCloneShallow<T extends object>(p: T): T {
  const out = { ...p } as unknown as Record<string, unknown>;
  if ('text' in out && out.text) out.text = { ...(out.text as object) };
  if ('adj' in out && out.adj) out.adj = structuredClone(out.adj);
  return out as T;
}

export function clipRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(Math.floor(a.x), b.x);
  const y0 = Math.max(Math.floor(a.y), b.y);
  const x1 = Math.min(Math.ceil(a.x + a.w), b.x + b.w);
  const y1 = Math.min(Math.ceil(a.y + a.h), b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- selection helpers

/** Builds a selection from an alpha mask, computing bounds and a pixel-edge outline. */
export function makeSelection(mask: HTMLCanvasElement, hint?: Rect): Selection | null {
  const W = mask.width;
  const H = mask.height;
  const area = clipRect(hint ? { x: hint.x - 2, y: hint.y - 2, w: hint.w + 4, h: hint.h + 4 } : { x: 0, y: 0, w: W, h: H }, { x: 0, y: 0, w: W, h: H });
  if (!area) return null;
  const data = ctx2d(mask, true).getImageData(area.x, area.y, area.w, area.h).data;
  const aw = area.w;
  const ah = area.h;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < aw && y < ah && data[(y * aw + x) * 4 + 3] >= 128;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const path = new Path2D();
  // horizontal edges
  for (let y = 0; y <= ah; y++) {
    let run = -1;
    for (let x = 0; x <= aw; x++) {
      const edge = x < aw && inside(x, y - 1) !== inside(x, y);
      if (edge && run < 0) run = x;
      if (!edge && run >= 0) {
        path.moveTo(area.x + run, area.y + y);
        path.lineTo(area.x + x, area.y + y);
        run = -1;
      }
    }
  }
  // vertical edges + bounds
  for (let x = 0; x <= aw; x++) {
    let run = -1;
    for (let y = 0; y <= ah; y++) {
      const edge = y < ah && inside(x - 1, y) !== inside(x, y);
      if (edge && run < 0) run = y;
      if (!edge && run >= 0) {
        path.moveTo(area.x + x, area.y + run);
        path.lineTo(area.x + x, area.y + y);
        run = -1;
      }
      if (x < aw && y < ah && inside(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { mask, bounds: { x: area.x + minX, y: area.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 }, outline: path };
}

export type SelectMode = 'new' | 'add' | 'subtract' | 'intersect';

/** Combines a freshly drawn shape mask with the existing selection. */
export function combineSelection(doc: EditorDoc, shape: HTMLCanvasElement, mode: SelectMode, hint?: Rect): Selection | null {
  const cur = doc.selection;
  if (mode === 'new' || !cur) {
    if (mode === 'subtract' || mode === 'intersect') return cur && mode === 'intersect' ? null : cur;
    return makeSelection(shape, hint);
  }
  const out = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(out);
  ctx.drawImage(cur.mask, 0, 0);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  ctx.drawImage(shape, 0, 0);
  const b = cur.bounds;
  const u = hint && mode === 'add'
    ? { x: Math.min(b.x, hint.x), y: Math.min(b.y, hint.y), w: Math.max(b.x + b.w, hint.x + hint.w) - Math.min(b.x, hint.x), h: Math.max(b.y + b.h, hint.y + hint.h) - Math.min(b.y, hint.y) }
    : b;
  return makeSelection(out, u);
}

export function selectionFromShape(doc: EditorDoc, draw: (ctx: CanvasRenderingContext2D) => void, feather = 0): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  const ctx = ctx2d(c);
  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.fillStyle = '#fff';
  draw(ctx);
  return c;
}
