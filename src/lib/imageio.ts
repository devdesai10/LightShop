// Image decode/encode helpers built on the browser's native codecs.

export type Drawable = HTMLCanvasElement | ImageBitmap | HTMLImageElement | OffscreenCanvas;

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Canvas 2D unavailable');
  return ctx;
}

export function sizeOf(d: Drawable): { w: number; h: number } {
  if (d instanceof HTMLImageElement) return { w: d.naturalWidth, h: d.naturalHeight };
  return { w: d.width, h: d.height };
}

export function cloneCanvas(src: Drawable, w?: number, h?: number): HTMLCanvasElement {
  const s = sizeOf(src);
  const c = createCanvas(w ?? s.w, h ?? s.h);
  const ctx = ctx2d(c);
  ctx.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
  return c;
}

/** Draws `src` into a new canvas applying an EXIF orientation (1..8). */
export function orientCanvas(src: Drawable, orientation: number): HTMLCanvasElement {
  const { w, h } = sizeOf(src);
  const swap = orientation >= 5 && orientation <= 8;
  const c = createCanvas(swap ? h : w, swap ? w : h);
  const ctx = ctx2d(c);
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  return c;
}

/**
 * Decodes an image blob into a drawable, optionally limiting the longest edge.
 * `manualOrientation` is used for sources whose EXIF was stripped (RAW previews).
 */
export async function decodeImage(
  blob: Blob,
  opts: { maxSize?: number; manualOrientation?: number } = {},
): Promise<HTMLCanvasElement | ImageBitmap> {
  const o = opts.manualOrientation ?? 1;
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  if (opts.maxSize && Math.max(bmp.width, bmp.height) > opts.maxSize) {
    const s = opts.maxSize / Math.max(bmp.width, bmp.height);
    const resized = await createImageBitmap(bmp, {
      resizeWidth: Math.max(1, Math.round(bmp.width * s)),
      resizeHeight: Math.max(1, Math.round(bmp.height * s)),
      resizeQuality: 'high',
    });
    bmp.close();
    bmp = resized;
  }
  if (o !== 1) {
    const c = orientCanvas(bmp, o);
    bmp.close();
    return c;
  }
  return bmp;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error(`Encoding ${type} failed`))), type, quality),
  );
}

/** Scales a drawable down to fit `max` (longest edge) and returns a canvas. */
export function fitCanvas(src: Drawable, max: number): HTMLCanvasElement {
  const { w, h } = sizeOf(src);
  const s = Math.min(1, max / Math.max(w, h));
  const c = createCanvas(w * s, h * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
  return c;
}

export async function makeThumbnail(src: Drawable, max = 480): Promise<Blob> {
  return canvasToBlob(fitCanvas(src, max), 'image/jpeg', 0.85);
}

export const SUPPORTED_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'heic', 'heif', 'jfif'];

export function mimeFor(ext: string): string {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
    case 'jfif':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
}

/** Checkerboard pattern used behind transparent pixels. */
let checker: CanvasPattern | null = null;
export function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
  if (checker) return checker;
  const c = createCanvas(16, 16);
  const g = ctx2d(c);
  g.fillStyle = '#cfcfcf';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#9e9e9e';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  checker = ctx.createPattern(c, 'repeat')!;
  return checker;
}
