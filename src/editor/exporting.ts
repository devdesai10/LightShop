// Editor exports. File → Export As asks where to save (a Save dialog in the desktop app) and writes the chosen
// format there. Quick Export saves a JPEG, or a PNG when the image has transparent areas, to Downloads in one
// click. Both say where the file went, with a button to show it in Finder. The browser build downloads instead.

import { toast } from '../state/app';
import { canvasToBlob } from '../lib/imageio';
import { SaveResult, desktop } from '../lib/desktop';
import { downloadBlob } from '../lib/util';
import { EditorDoc } from './doc';
import { editor, hasTransparency } from './session';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'psd';

export const EXPORT_FORMATS: Record<ExportFormat, { ext: string; mime: string; label: string }> = {
  png: { ext: 'png', mime: 'image/png', label: 'PNG' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg', label: 'JPEG' },
  webp: { ext: 'webp', mime: 'image/webp', label: 'WebP' },
  psd: { ext: 'psd', mime: 'image/vnd.adobe.photoshop', label: 'Photoshop' },
};

/** JPEG and WebP quality. */
const QUALITY = 0.92;

/** Exports show a Save dialog (the desktop app) rather than downloading. */
export const exportAsks = () => !!(desktop?.chooseSaveFile && desktop.writeSaveFile);
/** Quick Export saves into Downloads itself (the desktop app). */
const quickSaves = () => !!desktop?.quickSave;

let running = false;

async function encode(doc: EditorDoc, f: ExportFormat): Promise<Blob> {
  const fmt = EXPORT_FORMATS[f];
  if (f === 'psd') {
    const { writePsd } = await import('../lib/psd');
    return new Blob([writePsd(doc) as Uint8Array<ArrayBuffer>], { type: fmt.mime });
  }
  const blob = await canvasToBlob(f === 'jpeg' ? doc.flatten('#ffffff') : doc.getComposite(), fmt.mime, QUALITY);
  // Canvases fall back to PNG for types they can't encode.
  if (blob.type !== fmt.mime) throw new Error(`this app can't encode ${fmt.label} images`);
  return blob;
}

/** Shows `msg` over the canvas if `f` takes more than a moment (big images). */
async function busyWhile<T>(msg: string, f: () => Promise<T>): Promise<T> {
  const t = window.setTimeout(() => editor.set({ busy: msg }), 250);
  try {
    return await f();
  } finally {
    clearTimeout(t);
    if (editor.get().busy === msg) editor.set({ busy: null });
  }
}

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const fileName = (doc: EditorDoc, ext: string) => `${doc.name || 'Untitled'}.${ext}`;

function report(r: SaveResult, how: 'dialog' | 'quick') {
  if (r.ok) {
    const reveal = desktop?.revealFile;
    toast(
      `Exported "${r.name}" to ${r.folder}`,
      'success',
      7000,
      reveal ? { label: desktop?.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder', run: () => reveal(r.token) } : undefined,
    );
  } else if (r.error === 'denied') {
    toast(
      how === 'quick'
        ? `LightShop isn't allowed to save in ${r.folder}. Allow it in System Settings → Privacy & Security → Files & Folders, or use File → Export As to choose a folder.`
        : `LightShop isn't allowed to save in ${r.folder}. Choose another folder.`,
      'error',
      10000,
    );
  } else if (r.error === 'full') toast(`There isn't enough free space in ${r.folder} to export.`, 'error', 8000);
  else toast(`Couldn't export: ${r.message}`, 'error', 8000);
}

async function guarded(f: () => Promise<void>) {
  if (running) return;
  running = true;
  try {
    await f();
  } catch (e) {
    console.error(e);
    toast(`Couldn't export: ${(e as Error).message}`, 'error', 8000);
  } finally {
    running = false;
  }
}

/** File → Export As: asks where to save `doc` in format `f`, then writes it there. */
export function exportAs(doc: EditorDoc, f: ExportFormat) {
  return guarded(async () => {
    const fmt = EXPORT_FORMATS[f];
    if (exportAsks()) {
      const pick = await desktop!.chooseSaveFile!({ name: doc.name || 'Untitled', ext: fmt.ext });
      if (!pick) return;
      const blob = await busyWhile(`Exporting ${pick.name}…`, () => encode(doc, f));
      report(await desktop!.writeSaveFile!(pick.token, await bytes(blob)), 'dialog');
      return;
    }
    const name = fileName(doc, fmt.ext);
    downloadBlob(await busyWhile(`Exporting ${name}…`, () => encode(doc, f)), name);
    toast(`Downloaded "${name}"`, 'success');
  });
}

/** The format Quick Export uses for `doc`: PNG when it has transparent areas, otherwise JPEG. */
export const quickFormat = (doc: EditorDoc): 'png' | 'jpeg' => (hasTransparency(doc.getComposite()) ? 'png' : 'jpeg');

/** Saves `doc` to Downloads in one click (see quickFormat). */
export function quickExport(doc: EditorDoc) {
  return guarded(async () => {
    const f = quickFormat(doc);
    const name = fileName(doc, EXPORT_FORMATS[f].ext);
    const blob = await busyWhile(`Exporting ${name}…`, () => encode(doc, f));
    if (quickSaves()) report(await desktop!.quickSave!({ name, data: await bytes(blob) }), 'quick');
    else {
      downloadBlob(blob, name);
      toast(`Downloaded "${name}"`, 'success');
    }
  });
}

/** What the Quick Export button does, for its tooltip. */
export const QUICK_EXPORT_TIP = quickSaves()
  ? 'Saves a JPEG to your Downloads folder in one click, or a PNG if the image has transparent areas. To pick the format and folder, use File → Export As.'
  : 'Downloads a JPEG in one click, or a PNG if the image has transparent areas. To pick another format, use File → Export As.';
