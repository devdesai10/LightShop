// Editor session: open documents, active tool and tool options, colours, and library round-trips.

import { createStore } from '../state/store';
import { Photo, addGeneratedPhoto, app, getPhoto, loadPhotoImage, loadProject, toast } from '../state/app';
import { canvasToBlob, createCanvas, ctx2d, decodeImage } from '../lib/imageio';
import { baseName, downloadBlob, extOf } from '../lib/util';
import { renderDeveloped } from '../develop/export';
import { isEdited, normalizeSettings } from '../develop/settings';
import { dev, flushDevelop } from '../develop/state';
import { confirmDialog } from '../ui/dialogs';
import type { Adjustment } from './adjust';
import { BlendMode, EditorDoc, Layer, RasterLayer, SelectMode, TextProps, canvasRev, renderText } from './doc';
import type { ExpandFill } from './expand';
import { refit } from './viewState';

export type ToolId =
  | 'move' | 'marquee' | 'lasso' | 'wand' | 'crop' | 'eyedropper' | 'heal' | 'brush' | 'clone' | 'eraser'
  | 'gradient' | 'bucket' | 'text' | 'shape' | 'hand' | 'zoom';

export interface BrushOpts {
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
}

export interface ToolOptions {
  brush: BrushOpts;
  eraser: BrushOpts;
  clone: BrushOpts & { aligned: boolean; sampleAll: boolean };
  heal: { size: number; hardness: number };
  marquee: { shape: 'rect' | 'ellipse'; feather: number; mode: SelectMode };
  lasso: { polygonal: boolean; feather: number; mode: SelectMode };
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean; mode: SelectMode };
  bucket: { tolerance: number; contiguous: boolean; sampleAll: boolean; opacity: number };
  gradient: { type: 'linear' | 'radial'; toTransparent: boolean; opacity: number };
  text: Omit<TextProps, 'text' | 'color'>;
  shape: { type: 'rect' | 'ellipse' | 'line'; fill: boolean; strokeWidth: number };
  /** `fill` and `fillColor` cover the new area when the crop box reaches past the canvas. */
  crop: { aspect: number | null; fill: ExpandFill; fillColor: string };
  move: { autoSelect: boolean };
}

export interface EditorState {
  docs: EditorDoc[];
  activeDoc: string | null;
  tool: ToolId;
  fg: string;
  bg: string;
  opts: ToolOptions;
  /** Source point for the clone stamp (doc coords). */
  cloneSource: { x: number; y: number } | null;
  /** Shown over the canvas while a photo is being rendered into the Editor. */
  busy: string | null;
}

const DEFAULT_OPTS: ToolOptions = {
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1 },
  eraser: { size: 40, hardness: 0.9, opacity: 1, flow: 1 },
  clone: { size: 40, hardness: 0.6, opacity: 1, flow: 1, aligned: true, sampleAll: false },
  heal: { size: 30, hardness: 0.7 },
  marquee: { shape: 'rect', feather: 0, mode: 'new' },
  lasso: { polygonal: false, feather: 0, mode: 'new' },
  wand: { tolerance: 32, contiguous: true, sampleAll: false, mode: 'new' },
  bucket: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 1 },
  gradient: { type: 'linear', toTransparent: false, opacity: 1 },
  text: { font: 'Helvetica, Arial, sans-serif', size: 64, bold: false, italic: false, align: 'left', lineHeight: 1.2 },
  shape: { type: 'rect', fill: true, strokeWidth: 0 },
  crop: { aspect: null, fill: 'content', fillColor: '#000000' },
  move: { autoSelect: false },
};

function loadOpts(): ToolOptions {
  try {
    const saved = JSON.parse(localStorage.getItem('ls.toolopts') ?? '{}');
    const out = structuredClone(DEFAULT_OPTS) as unknown as Record<string, Record<string, unknown>>;
    for (const k of Object.keys(out)) out[k] = { ...out[k], ...(saved[k] ?? {}) };
    return out as unknown as ToolOptions;
  } catch {
    return structuredClone(DEFAULT_OPTS);
  }
}

export const editor = createStore<EditorState>({
  docs: [],
  activeDoc: null,
  tool: 'brush',
  fg: '#000000',
  bg: '#ffffff',
  opts: loadOpts(),
  cloneSource: null,
  busy: null,
});

export const activeDoc = () => editor.get().docs.find((d) => d.id === editor.get().activeDoc) ?? null;

export function setOpts<K extends keyof ToolOptions>(k: K, patch: Partial<ToolOptions[K]>) {
  editor.set((s) => {
    const opts = { ...s.opts, [k]: { ...s.opts[k], ...patch } };
    localStorage.setItem('ls.toolopts', JSON.stringify(opts));
    return { opts };
  });
}

export function addDoc(doc: EditorDoc) {
  editor.set((s) => ({ docs: [...s.docs, doc], activeDoc: doc.id }));
  app.set({ module: 'editor' });
}

export async function closeDoc(id: string) {
  const d = editor.get().docs.find((x) => x.id === id);
  if (d?.dirty && !(await confirmDialog('Unsaved changes', `"${d.name}" has changes that aren't saved to the Library. Close it anyway?`, { okLabel: 'Close', danger: true }))) return;
  editor.set((s) => {
    const docs = s.docs.filter((x) => x.id !== id);
    return { docs, activeDoc: s.activeDoc === id ? (docs[docs.length - 1]?.id ?? null) : s.activeDoc };
  });
}

export function docFromImage(name: string, img: CanvasImageSource & { width: number; height: number }): EditorDoc {
  const doc = new EditorDoc(name, img.width, img.height);
  const c = createCanvas(img.width, img.height);
  ctx2d(c).drawImage(img, 0, 0);
  const bg = doc.newRaster('Background', c);
  doc.layers = [bg];
  doc.activeId = bg.id;
  doc.dirty = false;
  return doc;
}

export function newDocument(name: string, w: number, h: number, fill: string | null) {
  const doc = new EditorDoc(name, w, h);
  const c = createCanvas(w, h);
  if (fill) {
    const ctx = ctx2d(c);
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
  }
  const l = doc.newRaster(fill ? 'Background' : 'Layer 1', c);
  doc.layers = [l];
  doc.activeId = l.id;
  doc.dirty = false;
  addDoc(doc);
  return doc;
}

// ---------------------------------------------------------------- Develop -> Editor
// A photo opened from the catalog is linked to its Develop settings (doc.devLink). Whenever the
// document is shown again, Develop changes made since are brought in as an undoable step. If the
// base layer was edited in the Editor, or the crop changed the size, the user decides.

/** Develop state of a photo as a comparable key. */
const developKey = (p: Photo) => JSON.stringify(normalizeSettings(p.settings));

const inflight = new Map<string, Promise<EditorDoc | null>>();

/** "Name", or "Name 2", "Name 3"... when a document with that name is already open. */
function uniqueDocName(base: string): string {
  const names = new Set(editor.get().docs.map((d) => d.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Shows `msg` over the canvas while `f` runs (cleared only if no newer message replaced it). */
async function withBusy<T>(msg: string, f: () => Promise<T>): Promise<T> {
  editor.set({ busy: msg });
  try {
    return await f();
  } finally {
    if (editor.get().busy === msg) editor.set({ busy: null });
  }
}

/** Shows a document in the Editor, first bringing it up to date with Develop. */
export function showDoc(doc: EditorDoc) {
  editor.set({ activeDoc: doc.id });
  app.set({ module: 'editor' });
  void syncDoc(doc, true);
}

/**
 * Switches to the Editor. Coming from Develop, the photo being developed is opened there (or its open
 * document is updated with the latest Develop edits) and shown.
 */
export function enterEditor() {
  const from = app.get().module;
  const photoId = from === 'develop' ? dev.get().photoId : null;
  if (photoId && getPhoto(photoId)) {
    flushDevelop();
    void openPhotoInEditor(photoId);
  } else {
    app.set({ module: 'editor' });
    const cur = activeDoc();
    if (cur) void syncDoc(cur, true);
  }
  // Other linked documents follow silently when nothing in them would be lost.
  for (const d of editor.get().docs) if (d.devLink && d.devLink.photoId !== photoId) void syncDoc(d, false);
}

/** Opens a catalog photo in the Editor, or shows (and updates) the document already open for it. */
export function openPhotoInEditor(photoId: string, opts: { developed?: boolean } = {}): Promise<EditorDoc | null> {
  const running = inflight.get(photoId);
  if (running) return running;
  const job = openOrShow(photoId, opts).finally(() => inflight.delete(photoId));
  inflight.set(photoId, job);
  return job;
}

async function openOrShow(photoId: string, opts: { developed?: boolean }): Promise<EditorDoc | null> {
  const p = getPhoto(photoId);
  if (!p) return null;
  const docs = editor.get().docs;
  const existing =
    docs.find((d) => d.devLink?.photoId === photoId) ?? docs.find((d) => d.savedPhotoId === photoId || (d.sourcePhotoId === photoId && !d.savedPhotoId && !d.devLink));
  if (existing) {
    showDoc(existing);
    return existing;
  }
  app.set({ module: 'editor' });
  try {
    if (p.hasProject) {
      // Layered Editor work saved to the catalog. Develop adjustments made to it afterwards aren't part of
      // those layers, so offer a flattened copy that includes them (like Lightroom's "Edit a Copy").
      const flat =
        opts.developed !== false &&
        isEdited(p.settings) &&
        (await confirmDialog('Open with Develop adjustments?', `"${p.name}" has Develop adjustments that aren't part of its Editor layers. Open a flattened copy with the adjustments, or the original layers?`, {
          okLabel: 'Flattened Copy',
          cancelLabel: 'Original Layers',
        }));
      if (!flat) {
        const proj = (await withBusy(`Opening ${p.name}…`, () => loadProject(p.id))) as Project | null;
        if (proj) {
          const doc = await withBusy(`Opening ${p.name}…`, () => docFromProject(proj));
          doc.savedPhotoId = p.id;
          doc.sourcePhotoId = p.derivedFrom ?? p.id;
          doc.dirty = false;
          addDoc(doc);
          return doc;
        }
      }
    }
    return await openLinked(p, opts.developed !== false);
  } catch (e) {
    console.error(e);
    toast(`Could not open ${p.name}: ${(e as Error).message}`, 'error', 6000);
    return null;
  }
}

async function openLinked(p: Photo, developed: boolean): Promise<EditorDoc> {
  const useDev = developed && isEdited(p.settings);
  const img = await withBusy(`Opening ${p.name}…`, () => (useDev ? renderDeveloped(p, p.settings) : loadPhotoImage(p)));
  const doc = docFromImage(baseName(p.name), img);
  if ('close' in img) img.close();
  doc.sourcePhotoId = p.id;
  doc.openLabel = useDev ? 'Open (developed)' : 'Open';
  if (developed) {
    const bg = doc.layers[0] as RasterLayer;
    doc.devLink = { photoId: p.id, layerId: bg.id, key: developKey(p), canvas: bg.canvas, rev: canvasRev(bg.canvas) };
  }
  addDoc(doc);
  return doc;
}

const syncing = new WeakMap<EditorDoc, Promise<void>>();

/**
 * Brings a linked document up to date with its photo's Develop settings. `interactive` allows asking the
 * user when the update would replace Editor edits or change the canvas size; otherwise those cases wait.
 */
export function syncDoc(doc: EditorDoc, interactive: boolean): Promise<void> {
  const running = syncing.get(doc);
  if (running) return running;
  const job = syncNow(doc, interactive).finally(() => syncing.delete(doc));
  syncing.set(doc, job);
  return job;
}

async function syncNow(doc: EditorDoc, interactive: boolean) {
  const link = doc.devLink;
  const p = link && getPhoto(link.photoId);
  if (!link || !p) return;
  const key = developKey(p);
  if (key === link.key || key === link.declinedKey) return;
  const layer = doc.layer(link.layerId);
  if (!layer || layer.kind !== 'raster') {
    doc.devLink = undefined; // the developed layer is gone; nothing left to update
    return;
  }
  const pristine = layer.canvas === link.canvas && canvasRev(layer.canvas) === link.rev;
  const shown = () => editor.get().activeDoc === doc.id;
  if (!pristine && !interactive) return;
  let img: HTMLCanvasElement;
  try {
    const render = () => renderDeveloped(p, p.settings);
    img = shown() ? await withBusy(`Updating ${p.name} from Develop…`, render) : await render();
  } catch (e) {
    console.error(e);
    toast(`Could not update ${doc.name} from Develop: ${(e as Error).message}`, 'error', 6000);
    return;
  }
  // The document may have been closed, or the link changed, while rendering.
  if (!editor.get().docs.includes(doc) || doc.devLink !== link || doc.layer(link.layerId) !== layer) return;
  const sizeChanged = img.width !== doc.width || img.height !== doc.height;
  // Only a lone, untouched, unmasked layer can simply take the new size.
  const simple = doc.layers.length === 1 && pristine && !layer.mask;
  if (sizeChanged && !simple) {
    if (!interactive) return;
    const asNew = await confirmDialog(
      'Crop changed in Develop',
      `"${p.name}" was cropped or rotated in Develop after it was opened here (${doc.width} × ${doc.height} → ${img.width} × ${img.height}). Open the updated photo as a new document? This one stays open.`,
      { okLabel: 'Open as New', cancelLabel: 'Keep This Version' },
    );
    if (!asNew) {
      link.declinedKey = key;
      return;
    }
    doc.devLink = undefined;
    const nd = docFromImage(uniqueDocName(baseName(p.name)), img);
    nd.sourcePhotoId = p.id;
    nd.openLabel = 'Open (developed)';
    const bg = nd.layers[0] as RasterLayer;
    nd.devLink = { photoId: p.id, layerId: bg.id, key, canvas: bg.canvas, rev: canvasRev(bg.canvas) };
    addDoc(nd);
    return;
  }
  if (!pristine) {
    const ok = await confirmDialog(
      'Update from Develop?',
      `"${p.name}" changed in Develop. Updating replaces the "${layer.name}" layer, including edits you made to it here (Undo brings them back). Other layers are kept.`,
      { okLabel: 'Update', cancelLabel: 'Keep Editor Version' },
    );
    if (!ok) {
      link.declinedKey = key;
      return;
    }
    if (doc.devLink !== link || doc.layer(link.layerId) !== layer) return;
  }
  const prev = { key: link.key, canvas: link.canvas, rev: link.rev };
  const wasDirty = doc.dirty;
  doc.commit(
    'Update from Develop',
    () => {
      if (sizeChanged) {
        doc.width = img.width;
        doc.height = img.height;
        doc.selection = null;
        layer.x = 0;
        layer.y = 0;
      }
      layer.canvas = img;
    },
    {
      // Undoing the update means "keep the previous version": don't offer these settings again.
      undo: () => Object.assign(link, { ...prev, declinedKey: key }),
      redo: () => Object.assign(link, { key, canvas: img, rev: canvasRev(img), declinedKey: undefined }),
    },
  );
  Object.assign(link, { key, canvas: img, rev: canvasRev(img), declinedKey: undefined });
  // A document that only mirrors the photo has nothing to lose; keep it clean. One saved to the Library
  // now differs from that saved copy, so it stays marked as changed.
  if (pristine && !wasDirty && !doc.savedPhotoId) {
    doc.dirty = false;
    doc.emit();
  }
  if (sizeChanged) refit(doc);
  if (!shown()) return;
  toast(`Updated ${doc.name} with your Develop edits`, 'success');
}

export async function openFilesInEditor(files: File[]) {
  for (const f of files) {
    try {
      if (extOf(f.name) === 'psd') {
        const { readPsd } = await import('../lib/psd');
        const doc = await readPsd(await f.arrayBuffer(), baseName(f.name));
        addDoc(doc);
      } else {
        const img = await decodeImage(f);
        const doc = docFromImage(baseName(f.name), img);
        if ('close' in img) img.close();
        addDoc(doc);
      }
    } catch (e) {
      console.error(e);
      toast(`Could not open ${f.name}: ${(e as Error).message}`, 'error', 6000);
    }
  }
}

// ---------------------------------------------------------------- projects (layered save)
export interface ProjectLayer {
  kind: Layer['kind'];
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  locked: boolean;
  maskEnabled: boolean;
  x?: number;
  y?: number;
  png?: Blob;
  mask?: Blob;
  text?: TextProps;
  adj?: Adjustment;
}
export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  activeIndex: number;
  layers: ProjectLayer[];
}

export async function docToProject(doc: EditorDoc): Promise<Project> {
  const layers: ProjectLayer[] = [];
  for (const l of doc.layers) {
    const base: ProjectLayer = { kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, maskEnabled: l.maskEnabled };
    if (l.mask) base.mask = await canvasToBlob(l.mask, 'image/png');
    if (l.kind !== 'adjust') {
      base.x = l.x;
      base.y = l.y;
      if (l.kind === 'raster') base.png = await canvasToBlob(l.canvas, 'image/png');
    }
    if (l.kind === 'text') base.text = { ...l.text };
    if (l.kind === 'adjust') base.adj = structuredClone(l.adj);
    layers.push(base);
  }
  return { version: 1, name: doc.name, width: doc.width, height: doc.height, activeIndex: doc.indexOf(doc.activeId), layers };
}

async function blobToCanvas(b: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = createCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export async function docFromProject(p: Project): Promise<EditorDoc> {
  const doc = new EditorDoc(p.name, p.width, p.height);
  const layers: Layer[] = [];
  for (const pl of p.layers) {
    let l: Layer;
    if (pl.kind === 'adjust' && pl.adj) l = doc.newAdjust(pl.name, pl.adj);
    else if (pl.kind === 'text' && pl.text) l = { ...doc.newText(pl.text, pl.x ?? 0, pl.y ?? 0), canvas: renderText(pl.text) };
    else l = doc.newRaster(pl.name, pl.png ? await blobToCanvas(pl.png) : undefined, pl.x ?? 0, pl.y ?? 0);
    Object.assign(l, { name: pl.name, visible: pl.visible, opacity: pl.opacity, blend: pl.blend, locked: pl.locked, maskEnabled: pl.maskEnabled });
    if (pl.mask) l.mask = await blobToCanvas(pl.mask);
    layers.push(l);
  }
  doc.layers = layers;
  doc.activeId = layers[Math.max(0, Math.min(layers.length - 1, p.activeIndex))]?.id ?? '';
  return doc;
}

function hasTransparency(c: HTMLCanvasElement): boolean {
  const k = Math.min(1, 256 / Math.max(c.width, c.height));
  const s = createCanvas(c.width * k, c.height * k);
  const ctx = ctx2d(s, true);
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** Saves the flattened image + layered project back into the catalog (Lightroom-style round trip). */
export async function saveDocToLibrary(doc: EditorDoc) {
  const flat = doc.getComposite();
  const transparent = hasTransparency(flat);
  const blob = await canvasToBlob(transparent ? flat : doc.flatten('#ffffff'), transparent ? 'image/png' : 'image/jpeg', 0.95);
  const project = await docToProject(doc);
  const src = getPhoto(doc.sourcePhotoId);
  const existing = getPhoto(doc.savedPhotoId);
  const name = existing?.name ?? `${src ? baseName(src.name) + '-Edit' : doc.name}.${transparent ? 'png' : 'jpg'}`;
  const photo = await addGeneratedPhoto(blob, name, doc.width, doc.height, {
    derivedFrom: doc.sourcePhotoId,
    project,
    replaceId: doc.savedPhotoId,
  });
  doc.savedPhotoId = photo.id;
  doc.dirty = false;
  doc.emit();
  toast(`Saved "${photo.name}" to the Library`, 'success');
  return photo;
}

export async function exportDoc(doc: EditorDoc, format: 'png' | 'jpeg' | 'webp' | 'psd', quality = 0.92) {
  if (format === 'psd') {
    const { writePsd } = await import('../lib/psd');
    const bytes = writePsd(doc);
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/vnd.adobe.photoshop' }), `${doc.name}.psd`);
    return;
  }
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[format];
  const c = format === 'jpeg' ? doc.flatten('#ffffff') : doc.getComposite();
  downloadBlob(await canvasToBlob(c, mime, quality), `${doc.name}.${format === 'jpeg' ? 'jpg' : format}`);
}
