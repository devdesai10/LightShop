// RAW support via embedded previews. Camera RAW containers (CR2/CR3/NEF/ARW/DNG/RAF/ORF/RW2/PEF...)
// embed a camera-rendered JPEG. We locate the largest browser-decodable JPEG stream, strip its EXIF
// (so the browser does not auto-rotate it) and report the container's orientation separately.

import { ExifSummary, TiffReader, mergeExifIfd, parseJpegExif, summarizeTiff } from './exif';

export const RAW_EXTENSIONS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw',
  'erf', '3fr', 'kdc', 'dcr', 'mrw', 'x3f', 'iiq', 'rwl', 'mos', 'fff',
];

export function isRawName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return RAW_EXTENSIONS.includes(ext);
}

interface JpegInfo {
  start: number;
  end: number;
  width: number;
  height: number;
  sof: number;
}

const DECODABLE_SOF = new Set([0xc0, 0xc1, 0xc2]);

function parseJpegAt(u8: Uint8Array, s: number): JpegInfo | null {
  const n = u8.length;
  let p = s + 2;
  let sof = -1;
  let w = 0;
  let h = 0;
  while (p + 2 <= n) {
    if (u8[p] !== 0xff) return null;
    const m = u8[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2;
      continue;
    }
    if (m === 0xd9) return sof >= 0 ? { start: s, end: p + 2, width: w, height: h, sof } : null;
    if (p + 4 > n) return null;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      sof = m;
      h = (u8[p + 5] << 8) | u8[p + 6];
      w = (u8[p + 7] << 8) | u8[p + 8];
    }
    p += 2 + len;
    if (m === 0xda) {
      // Entropy-coded segment: skip to the next real marker.
      for (;;) {
        const i = u8.indexOf(0xff, p);
        if (i < 0 || i + 1 >= n) return null;
        const nx = u8[i + 1];
        if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) {
          p = i + 2;
          continue;
        }
        if (nx === 0xff) {
          p = i + 1;
          continue;
        }
        p = i;
        break;
      }
    }
  }
  return null;
}

/** Finds every JPEG stream in the buffer; returns the largest decodable one. */
function findLargestJpeg(u8: Uint8Array): JpegInfo | null {
  let best: JpegInfo | null = null;
  let pos = 0;
  const n = u8.length;
  while (pos < n - 3) {
    const i = u8.indexOf(0xff, pos);
    if (i < 0 || i > n - 3) break;
    if (u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      const info = parseJpegAt(u8, i);
      if (info) {
        if (DECODABLE_SOF.has(info.sof) && info.width >= 64 && info.height >= 64) {
          if (!best || info.width * info.height > best.width * best.height) best = info;
        }
        pos = info.end;
        continue;
      }
    }
    pos = i + 1;
  }
  return best;
}

/** Copies a JPEG stream while dropping APP1 (EXIF/XMP) segments. */
function stripApp1(u8: Uint8Array, j: JpegInfo): Uint8Array {
  const parts: Uint8Array[] = [u8.subarray(j.start, j.start + 2)];
  let p = j.start + 2;
  while (p + 4 <= j.end) {
    const m = u8[p + 1];
    if (m === 0xda) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (m !== 0xe1) parts.push(u8.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  parts.push(u8.subarray(p, j.end));
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

function findAscii(u8: Uint8Array, s: string, limit: number): number {
  const c0 = s.charCodeAt(0);
  const end = Math.min(u8.length - s.length, limit);
  for (let i = u8.indexOf(c0); i >= 0 && i < end; i = u8.indexOf(c0, i + 1)) {
    let ok = true;
    for (let k = 1; k < s.length; k++)
      if (u8[i + k] !== s.charCodeAt(k)) {
        ok = false;
        break;
      }
    if (ok) return i;
  }
  return -1;
}

function rawMetadata(buf: ArrayBuffer): ExifSummary {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // TIFF-based containers (incl. ORF "IIRO" and RW2 "IIU" variants – only the byte order is checked).
  const tiff = TiffReader.tryCreate(v, 0);
  if (tiff) {
    try {
      return summarizeTiff(tiff);
    } catch {
      /* fall through */
    }
  }
  // Canon CR3 (ISO-BMFF): CMT1 = IFD0 TIFF, CMT2 = EXIF IFD TIFF.
  const out: ExifSummary = {};
  const c1 = findAscii(u8, 'CMT1', 4 << 20);
  if (c1 >= 0) {
    const r = TiffReader.tryCreate(v, c1 + 4);
    if (r) Object.assign(out, summarizeTiff(r));
    const c2 = findAscii(u8, 'CMT2', 4 << 20);
    const r2 = c2 >= 0 ? TiffReader.tryCreate(v, c2 + 4) : null;
    if (r2) mergeExifIfd(r2, r2.firstIfd(), out);
  }
  return out;
}

export interface RawPreview {
  blob: Blob;
  width: number;
  height: number;
  orientation: number;
  exif: ExifSummary;
}

export function extractRawPreview(buf: ArrayBuffer): RawPreview | null {
  const u8 = new Uint8Array(buf);
  const jpeg = findLargestJpeg(u8);
  if (!jpeg) return null;
  let exif: ExifSummary = {};
  try {
    exif = rawMetadata(buf);
  } catch {
    exif = {};
  }
  const embeddedExif = parseJpegExif(u8.slice(jpeg.start, Math.min(jpeg.end, jpeg.start + 131072)).buffer);
  if (embeddedExif) exif = { ...embeddedExif, ...stripUndefined(exif) };
  const orientation = exif.orientation && exif.orientation >= 1 && exif.orientation <= 8 ? exif.orientation : 1;
  const bytes = stripApp1(u8, jpeg);
  return {
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
    width: jpeg.width,
    height: jpeg.height,
    orientation,
    exif,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
