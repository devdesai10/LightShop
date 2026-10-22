import { canvasToBlob, createCanvas, ctx2d } from '../lib/imageio';
import { getPhoto, loadPhotoImage, setThumbnail } from '../state/app';
import { cropOutSize } from './geometry';
import { DevelopRenderer } from './renderer';
import { DevelopSettings, normalizeSettings } from './settings';

let shared: DevelopRenderer | null = null;

/** Renders a 480px thumbnail from a renderer that already holds the photo's image. */
export async function thumbFromRenderer(r: DevelopRenderer, s: DevelopSettings, id: string) {
  const out = cropOutSize(s, r.fullW, r.fullH);
  const k = Math.min(1, 480 / Math.max(out.w, out.h));
  const w = Math.max(1, Math.round(out.w * k));
  const h = Math.max(1, Math.round(out.h * k));
  const data = r.renderPixels(s, w, h, { key: 'thumb' });
  const c = createCanvas(w, h);
  ctx2d(c).putImageData(data, 0, 0);
  await setThumbnail(id, await canvasToBlob(c, 'image/jpeg', 0.85));
}

export async function renderThumbnailFor(id: string) {
  const p = getPhoto(id);
  if (!p) return;
  const img = await loadPhotoImage(p, 1024);
  try {
    shared ??= new DevelopRenderer();
    shared.setImage(img, p.width, p.height);
    await thumbFromRenderer(shared, normalizeSettings(p.settings), id);
  } finally {
    if ('close' in img) img.close();
  }
}
