// Minimal TIFF/EXIF reader (TIFF 6.0 / EXIF 2.3 structures). Used for JPEG EXIF blocks and for
// TIFF-based RAW containers (CR2, NEF, ARW, DNG, ORF, RW2, PEF...).

export interface ExifSummary {
  make?: string;
  model?: string;
  lens?: string;
  orientation?: number;
  dateTaken?: string; // "YYYY:MM:DD HH:MM:SS"
  exposureTime?: number; // seconds
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  focalLength35?: number;
  exposureBias?: number;
  flash?: boolean;
  width?: number;
  height?: number;
  software?: string;
  artist?: string;
  copyright?: string;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset (in the underlying buffer) of the value bytes. */
  valueOffset: number;
}

export class TiffReader {
  readonly le: boolean;
  constructor(
    readonly view: DataView,
    readonly base: number, // absolute offset of the TIFF header
  ) {
    const bo = view.getUint16(base);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('Not a TIFF structure');
    this.le = bo === 0x4949;
  }

  static tryCreate(view: DataView, base: number): TiffReader | null {
    try {
      if (base + 8 > view.byteLength) return null;
      return new TiffReader(view, base);
    } catch {
      return null;
    }
  }

  u16(abs: number) {
    return this.view.getUint16(abs, this.le);
  }
  u32(abs: number) {
    return this.view.getUint32(abs, this.le);
  }
  /** Offset of IFD0, relative to base. */
  firstIfd(): number {
    return this.u32(this.base + 4);
  }

  /** Reads an IFD at a base-relative offset. Returns entries and base-relative next IFD offset. */
  readIfd(rel: number): { entries: Map<number, IfdEntry>; next: number } {
    const entries = new Map<number, IfdEntry>();
    const abs = this.base + rel;
    if (rel <= 0 || abs + 2 > this.view.byteLength) return { entries, next: 0 };
    const n = this.u16(abs);
    if (n > 1000) return { entries, next: 0 };
    for (let i = 0; i < n; i++) {
      const e = abs + 2 + i * 12;
      if (e + 12 > this.view.byteLength) break;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const valueOffset = size <= 4 ? e + 8 : this.base + this.u32(e + 8);
      entries.set(tag, { tag, type, count, valueOffset });
    }
    const nextPos = abs + 2 + n * 12;
    const next = nextPos + 4 <= this.view.byteLength ? this.u32(nextPos) : 0;
    return { entries, next };
  }

  /** Numeric values of an entry (rationals are returned as floats). */
  nums(e: IfdEntry | undefined): number[] {
    if (!e) return [];
    const out: number[] = [];
    const v = this.view;
    const max = Math.min(e.count, 4096);
    for (let i = 0; i < max; i++) {
      const sz = TYPE_SIZE[e.type] ?? 1;
      const o = e.valueOffset + i * sz;
      if (o + sz > v.byteLength) break;
      switch (e.type) {
        case 1:
        case 7:
          out.push(v.getUint8(o));
          break;
        case 6:
          out.push(v.getInt8(o));
          break;
        case 3:
          out.push(v.getUint16(o, this.le));
          break;
        case 8:
          out.push(v.getInt16(o, this.le));
          break;
        case 4:
        case 13:
          out.push(v.getUint32(o, this.le));
          break;
        case 9:
          out.push(v.getInt32(o, this.le));
          break;
        case 5: {
          const d = v.getUint32(o + 4, this.le);
          out.push(d ? v.getUint32(o, this.le) / d : 0);
          break;
        }
        case 10: {
          const d = v.getInt32(o + 4, this.le);
          out.push(d ? v.getInt32(o, this.le) / d : 0);
          break;
        }
        case 11:
          out.push(v.getFloat32(o, this.le));
          break;
        case 12:
          out.push(v.getFloat64(o, this.le));
          break;
      }
    }
    return out;
  }

  num(e: IfdEntry | undefined): number | undefined {
    const n = this.nums(e);
    return n.length ? n[0] : undefined;
  }

  str(e: IfdEntry | undefined): string | undefined {
    if (!e) return undefined;
    const end = Math.min(e.valueOffset + e.count, this.view.byteLength);
    let s = '';
    for (let i = e.valueOffset; i < end; i++) {
      const c = this.view.getUint8(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim() || undefined;
  }
}

export const TAG = {
  NewSubfileType: 0x00fe,
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  Compression: 0x0103,
  Photometric: 0x0106,
  Make: 0x010f,
  Model: 0x0110,
  StripOffsets: 0x0111,
  Orientation: 0x0112,
  StripByteCounts: 0x0117,
  Software: 0x0131,
  DateTime: 0x0132,
  Artist: 0x013b,
  SubIFDs: 0x014a,
  JpegOffset: 0x0201,
  JpegLength: 0x0202,
  Copyright: 0x8298,
  ExifIFD: 0x8769,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  ISO: 0x8827,
  DateTimeOriginal: 0x9003,
  ExposureBias: 0x9204,
  Flash: 0x9209,
  FocalLength: 0x920a,
  PixelX: 0xa002,
  PixelY: 0xa003,
  FocalLength35: 0xa405,
  LensModel: 0xa434,
  Rw2JpgFromRaw: 0x002e,
} as const;

/** Extracts a summary from IFD0 + EXIF IFD of a TIFF structure. */
export function summarizeTiff(r: TiffReader, ifd0Rel = r.firstIfd()): ExifSummary {
  const out: ExifSummary = {};
  const { entries: ifd0 } = r.readIfd(ifd0Rel);
  out.make = r.str(ifd0.get(TAG.Make));
  out.model = r.str(ifd0.get(TAG.Model));
  out.orientation = r.num(ifd0.get(TAG.Orientation));
  out.software = r.str(ifd0.get(TAG.Software));
  out.artist = r.str(ifd0.get(TAG.Artist));
  out.copyright = r.str(ifd0.get(TAG.Copyright));
  out.dateTaken = r.str(ifd0.get(TAG.DateTime));
  const exifPtr = r.num(ifd0.get(TAG.ExifIFD));
  if (exifPtr) mergeExifIfd(r, exifPtr, out);
  return out;
}

export function mergeExifIfd(r: TiffReader, rel: number, out: ExifSummary) {
  const { entries: ex } = r.readIfd(rel);
  out.exposureTime = r.num(ex.get(TAG.ExposureTime)) ?? out.exposureTime;
  out.fNumber = r.num(ex.get(TAG.FNumber)) ?? out.fNumber;
  out.iso = r.num(ex.get(TAG.ISO)) ?? out.iso;
  out.dateTaken = r.str(ex.get(TAG.DateTimeOriginal)) ?? out.dateTaken;
  out.exposureBias = r.num(ex.get(TAG.ExposureBias)) ?? out.exposureBias;
  const flash = r.num(ex.get(TAG.Flash));
  if (flash !== undefined) out.flash = (flash & 1) === 1;
  out.focalLength = r.num(ex.get(TAG.FocalLength)) ?? out.focalLength;
  out.focalLength35 = r.num(ex.get(TAG.FocalLength35)) ?? out.focalLength35;
  out.lens = r.str(ex.get(TAG.LensModel)) ?? out.lens;
  out.width = r.num(ex.get(TAG.PixelX)) ?? out.width;
  out.height = r.num(ex.get(TAG.PixelY)) ?? out.height;
}

/** Parses EXIF from a JPEG file buffer (APP1 "Exif\0\0" segment). */
export function parseJpegExif(buf: ArrayBuffer): ExifSummary | null {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marker = v.getUint8(p + 1);
    if (marker === 0xda || marker === 0xd9) return null; // start of scan: no EXIF found
    const len = v.getUint16(p + 2);
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966 /* Exif */) {
      const r = TiffReader.tryCreate(v, p + 10);
      if (!r) return null;
      try {
        return summarizeTiff(r);
      } catch {
        return null;
      }
    }
    p += 2 + len;
  }
  return null;
}

export function parseExifDate(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

export function formatShutter(t?: number): string | undefined {
  if (!t) return undefined;
  if (t >= 1) return `${+t.toFixed(1)}s`;
  return `1/${Math.round(1 / t)}s`;
}
