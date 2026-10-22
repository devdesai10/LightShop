import { canvasToBlob, createCanvas, ctx2d, fitCanvas } from '../lib/imageio';
import { baseName, downloadBlob } from '../lib/util';
import { Photo, getPhoto, loadPhotoImage } from '../state/app';
import { cropOutSize } from './geometry';
import { DevelopRenderer } from './renderer';
import { DevelopSettings, normalizeSettings } from './settings';

export type ExportFormat = 'jpeg' | 'png' | 'webp';
export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 1..100
  longEdge: number | null;
  suffix: string;
  toFolder: boolean;
}

export const FORMAT_INFO: Record<ExportFormat, { mime: string; ext: string; label: string }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WebP' },
};

/** Renders a photo with its develop settings at full (or limited) resolution. */
export async function renderDeveloped(p: Photo, settings?: DevelopSettings | null, maxLong?: number | null): Promise<HTMLCanvasElement> {
  const img = await loadPhotoImage(p);
  const r = new DevelopRenderer();
  try {
    let src: HTMLCanvasElement | ImageBitmap = img;
    if (Math.max(img.width, img.height) > r.maxTexture) src = fitCanvas(img, r.maxTexture);
    r.setImage(src, img.width, img.height);
    const s = normalizeSettings(settings ?? p.settings);
    let { w, h } = cropOutSize(s, img.width, img.height);
    if (maxLong && Math.max(w, h) > maxLong) {
      const k = maxLong / Math.max(w, h);
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    const data = r.renderPixels(s, w, h);
    const c = createCanvas(w, h);
    ctx2d(c).putImageData(data, 0, 0);
    return c;
  } finally {
    r.dispose();
    if ('close' in img) img.close();
  }
}

type DirHandle = {
  getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
};

export const canPickFolder = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export async function exportPhotos(ids: string[], opts: ExportOptions, onProgress?: (done: number, total: number, name: string) => void): Promise<number> {
  let dir: DirHandle | null = null;
  if (opts.toFolder && canPickFolder()) {
    try {
      dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 0; // cancelled by the user
      console.warn('Folder picker unavailable, saving to Downloads instead', e);
      dir = null;
    }
  }
  const info = FORMAT_INFO[opts.format];
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = getPhoto(ids[i]);
    if (!p) continue;
    onProgress?.(i, ids.length, p.name);
    const canvas = await renderDeveloped(p, p.settings, opts.longEdge);
    const blob = await canvasToBlob(canvas, info.mime, opts.quality / 100);
    const name = `${baseName(p.name)}${opts.suffix}.${info.ext}`;
    if (dir) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      downloadBlob(blob, name);
      await new Promise((r) => setTimeout(r, 250));
    }
    n++;
  }
  onProgress?.(ids.length, ids.length, '');
  return n;
}
