// Photoshop PSD read/write, implemented from Adobe's published "Photoshop File Formats Specification".
// Supports 8-bit RGB/grayscale documents with pixel layers, opacity, blend modes, visibility and
// layer masks (RLE or raw channel data). Type and adjustment layers are written as pixels.

import { createCanvas, ctx2d } from './imageio';
import { BLEND_MODES, BlendMode, EditorDoc, isPixel } from '../editor/doc';

// ---------------------------------------------------------------- byte writer
class Writer {
  buf = new Uint8Array(1 << 20);
  pos = 0;
  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 255;
  }
  u16(v: number) {
    this.ensure(2);
    this.buf[this.pos++] = (v >> 8) & 255;
    this.buf[this.pos++] = v & 255;
  }
  u32(v: number) {
    this.ensure(4);
    this.buf[this.pos++] = (v >>> 24) & 255;
    this.buf[this.pos++] = (v >>> 16) & 255;
    this.buf[this.pos++] = (v >>> 8) & 255;
    this.buf[this.pos++] = v & 255;
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  setU32(at: number, v: number) {
    this.buf[at] = (v >>> 24) & 255;
    this.buf[at + 1] = (v >>> 16) & 255;
    this.buf[at + 2] = (v >>> 8) & 255;
    this.buf[at + 3] = v & 255;
  }
  pad(multiple: number, from = 0) {
    while ((this.pos - from) % multiple) this.u8(0);
  }
  result() {
    return this.buf.slice(0, this.pos);
  }
}

/** PackBits-compresses one row into `out`; returns the compressed length. */
function packRow(src: Uint8Array, off: number, len: number, out: Writer): number {
  const start = out.pos;
  let i = 0;
  while (i < len) {
    let run = 1;
    while (i + run < len && run < 128 && src[off + i + run] === src[off + i]) run++;
    if (run >= 2) {
      out.u8(257 - run);
      out.u8(src[off + i]);
      i += run;
      continue;
    }
    let lit = 1;
    while (i + lit < len && lit < 128) {
      if (i + lit + 1 < len && src[off + i + lit] === src[off + i + lit + 1]) break;
      lit++;
    }
    out.u8(lit - 1);
    out.bytes(src.subarray(off + i, off + i + lit));
    i += lit;
  }
  return out.pos - start;
}

/** RLE channel block: row byte counts followed by packed rows (written into `w`). */
function writeRleChannel(w: Writer, plane: Uint8Array, width: number, height: number) {
  const countsAt = w.pos;
  for (let y = 0; y < height; y++) w.u16(0);
  for (let y = 0; y < height; y++) {
    const n = packRow(plane, y * width, width, w);
    w.buf[countsAt + y * 2] = (n >> 8) & 255;
    w.buf[countsAt + y * 2 + 1] = n & 255;
  }
}

function planes(img: ImageData): Uint8Array[] {
  const n = img.width * img.height;
  const p = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const d = img.data;
  for (let i = 0; i < n; i++) {
    p[0][i] = d[i * 4];
    p[1][i] = d[i * 4 + 1];
    p[2][i] = d[i * 4 + 2];
    p[3][i] = d[i * 4 + 3];
  }
  return p;
}

interface OutLayer {
  name: string;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  opacity: number;
  blend: string;
  visible: boolean;
  mask: HTMLCanvasElement | null;
}

export function writePsd(doc: EditorDoc): Uint8Array {
  const W = doc.width;
  const H = doc.height;
  const out: OutLayer[] = [];
  doc.layers.forEach((l, i) => {
    const blend = BLEND_MODES.find((b) => b.value === l.blend)?.psd ?? 'norm';
    if (isPixel(l)) {
      out.push({ name: l.name, canvas: l.canvas, x: l.x, y: l.y, opacity: l.opacity, blend, visible: l.visible, mask: l.mask && l.maskEnabled ? l.mask : null });
    } else {
      // Adjustment layers are baked: the composite up to this layer replaces what is below it.
      const c = createCanvas(W, H);
      doc.renderInto(c, i + 1);
      out.push({ name: `${l.name} (baked)`, canvas: c, x: 0, y: 0, opacity: 1, blend: 'norm', visible: l.visible, mask: null });
    }
  });

  const w = new Writer();
  w.ascii('8BPS');
  w.u16(1);
  for (let i = 0; i < 6; i++) w.u8(0);
  w.u16(3);
  w.u32(H);
  w.u32(W);
  w.u16(8);
  w.u16(3);
  w.u32(0); // colour mode data
  w.u32(0); // image resources

  const lmAt = w.pos;
  w.u32(0); // layer & mask info length
  const liStart = w.pos;
  w.u32(0); // layer info length
  w.u16(out.length);

  // Encode channel data first so we know the lengths.
  const encoded = out.map((l) => {
    const cw = l.canvas.width;
    const ch = l.canvas.height;
    const img = ctx2d(l.canvas, true).getImageData(0, 0, cw, ch);
    const [r, g, b, a] = planes(img);
    const chans: { id: number; data: Uint8Array }[] = [];
    for (const [id, plane] of [[-1, a], [0, r], [1, g], [2, b]] as [number, Uint8Array][]) {
      const cw2 = new Writer();
      cw2.u16(1);
      writeRleChannel(cw2, plane, cw, ch);
      chans.push({ id, data: cw2.result() });
    }
    if (l.mask) {
      const m = ctx2d(l.mask, true).getImageData(0, 0, W, H);
      const plane = planes(m)[3];
      const mw = new Writer();
      mw.u16(1);
      writeRleChannel(mw, plane, W, H);
      chans.push({ id: -2, data: mw.result() });
    }
    return chans;
  });

  out.forEach((l, i) => {
    w.i32(l.y);
    w.i32(l.x);
    w.i32(l.y + l.canvas.height);
    w.i32(l.x + l.canvas.width);
    const chans = encoded[i];
    w.u16(chans.length);
    for (const c of chans) {
      w.u16(c.id & 0xffff);
      w.u32(c.data.length);
    }
    w.ascii('8BIM');
    w.ascii(l.blend);
    w.u8(Math.round(l.opacity * 255));
    w.u8(0);
    w.u8((l.visible ? 0 : 2) | 8);
    w.u8(0);
    const extraAt = w.pos;
    w.u32(0);
    const extraStart = w.pos;
    if (l.mask) {
      w.u32(20);
      w.i32(0);
      w.i32(0);
      w.i32(H);
      w.i32(W);
      w.u8(0);
      w.u8(0);
      w.u16(0);
    } else w.u32(0);
    w.u32(0); // blending ranges
    const ascii = l.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255);
    const nameStart = w.pos;
    w.u8(ascii.length);
    w.ascii(ascii);
    w.pad(4, nameStart);
    // Unicode layer name
    w.ascii('8BIM');
    w.ascii('luni');
    const uniLen = 4 + l.name.length * 2;
    const uniPadded = uniLen + (uniLen % 4 ? 4 - (uniLen % 4) : 0);
    w.u32(uniPadded);
    w.u32(l.name.length);
    for (let k = 0; k < l.name.length; k++) w.u16(l.name.charCodeAt(k));
    for (let k = uniLen; k < uniPadded; k++) w.u8(0);
    w.setU32(extraAt, w.pos - extraStart);
  });
  for (const chans of encoded) for (const c of chans) w.bytes(c.data);
  w.pad(2, liStart + 4);
  w.setU32(liStart, w.pos - liStart - 4);
  w.u32(0); // global layer mask info
  w.setU32(lmAt, w.pos - lmAt - 4);

  // Merged composite (flattened on white), RLE.
  const flat = doc.flatten('#ffffff');
  const [r, g, b] = planes(ctx2d(flat, true).getImageData(0, 0, W, H));
  w.u16(1);
  const countsAt = w.pos;
  for (let i = 0; i < 3 * H; i++) w.u16(0);
  [r, g, b].forEach((plane, ci) => {
    for (let y = 0; y < H; y++) {
      const n = packRow(plane, y * W, W, w);
      const at = countsAt + (ci * H + y) * 2;
      w.buf[at] = (n >> 8) & 255;
      w.buf[at + 1] = n & 255;
    }
  });
  return w.result();
}

// ---------------------------------------------------------------- reader
class Reader {
  pos = 0;
  constructor(readonly v: DataView) {}
  u8() {
    return this.v.getUint8(this.pos++);
  }
  u16() {
    const x = this.v.getUint16(this.pos);
    this.pos += 2;
    return x;
  }
  i16() {
    const x = this.v.getInt16(this.pos);
    this.pos += 2;
    return x;
  }
  u32() {
    const x = this.v.getUint32(this.pos);
    this.pos += 4;
    return x;
  }
  i32() {
    const x = this.v.getInt32(this.pos);
    this.pos += 4;
    return x;
  }
  ascii(n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
  /** Skips a block prefixed by its u32 length. */
  skipBlock() {
    const len = this.u32();
    this.pos += len;
  }
}

function unpackBits(r: Reader, out: Uint8Array, off: number, len: number, end: number) {
  let o = 0;
  while (o < len && r.pos < end) {
    const n = r.v.getInt8(r.pos++);
    if (n >= 0) {
      for (let i = 0; i <= n && o < len; i++) out[off + o++] = r.u8();
    } else if (n !== -128) {
      const b = r.u8();
      for (let i = 0; i < 1 - n && o < len; i++) out[off + o++] = b;
    }
  }
}

function readChannel(r: Reader, w: number, h: number, end: number): Uint8Array | null {
  const comp = r.u16();
  const plane = new Uint8Array(w * h);
  if (comp === 0) {
    plane.set(new Uint8Array(r.v.buffer, r.v.byteOffset + r.pos, Math.min(w * h, end - r.pos)));
    r.pos = end;
    return plane;
  }
  if (comp === 1) {
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(r.u16());
    for (let y = 0; y < h; y++) {
      const rowEnd = r.pos + counts[y];
      unpackBits(r, plane, y * w, w, rowEnd);
      r.pos = rowEnd;
    }
    r.pos = end;
    return plane;
  }
  r.pos = end;
  return null; // ZIP compression is not supported
}

const KEY_TO_BLEND = new Map(BLEND_MODES.map((b) => [b.psd, b.value]));

export async function readPsd(buf: ArrayBuffer, name: string): Promise<EditorDoc> {
  const r = new Reader(new DataView(buf));
  if (r.ascii(4) !== '8BPS') throw new Error('Not a Photoshop file');
  const version = r.u16();
  if (version !== 1) throw new Error('Large document format (PSB) is not supported');
  r.pos += 6;
  const nch = r.u16();
  const H = r.u32();
  const W = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (depth !== 8) throw new Error(`${depth}-bit PSD files are not supported (8-bit only)`);
  if (mode !== 3 && mode !== 1) throw new Error('Only RGB and Grayscale PSD files are supported');
  r.skipBlock(); // colour mode data
  r.skipBlock(); // image resources
  const lmLen = r.u32();
  const lmEnd = r.pos + lmLen;
  const doc = new EditorDoc(name, W, H);
  let unsupported = false;

  if (lmLen > 0) {
    const liLen = r.u32();
    const liEnd = r.pos + liLen;
    if (liLen > 0) {
      const count = Math.abs(r.i16());
      interface Rec {
        top: number;
        left: number;
        bottom: number;
        right: number;
        chans: { id: number; len: number }[];
        blend: string;
        opacity: number;
        hidden: boolean;
        name: string;
        mask: { top: number; left: number; bottom: number; right: number; def: number } | null;
        divider: number;
      }
      const recs: Rec[] = [];
      for (let i = 0; i < count; i++) {
        const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
        const n = r.u16();
        const chans = [];
        for (let k = 0; k < n; k++) chans.push({ id: r.i16(), len: r.u32() });
        r.ascii(4);
        const blend = r.ascii(4);
        const opacity = r.u8() / 255;
        r.u8();
        const flags = r.u8();
        r.u8();
        const extraLen = r.u32();
        const extraEnd = r.pos + extraLen;
        const maskLen = r.u32();
        let mask: Rec['mask'] = null;
        if (maskLen >= 20) {
          const mt = r.i32(), ml = r.i32(), mb = r.i32(), mr = r.i32();
          const def = r.u8();
          mask = { top: mt, left: ml, bottom: mb, right: mr, def };
          r.pos += maskLen - 17;
        } else r.pos += maskLen;
        r.skipBlock(); // blending ranges
        const nameStart = r.pos;
        const nl = r.u8();
        let lname = r.ascii(nl);
        r.pos = nameStart + Math.ceil((nl + 1) / 4) * 4;
        let divider = 0;
        while (r.pos + 12 <= extraEnd) {
          const sig = r.ascii(4);
          if (sig !== '8BIM' && sig !== '8B64') break;
          const key = r.ascii(4);
          const len = r.u32();
          const dataEnd = r.pos + len;
          if (key === 'luni') {
            const cnt = r.u32();
            let s = '';
            for (let k = 0; k < cnt; k++) s += String.fromCharCode(r.u16());
            lname = s;
          } else if (key === 'lsct' || key === 'lsdk') divider = r.u32();
          r.pos = dataEnd + (len % 2);
        }
        r.pos = extraEnd;
        recs.push({ top, left, bottom, right, chans, blend, opacity, hidden: (flags & 2) !== 0, name: lname, mask, divider });
      }
      for (const rec of recs) {
        const w = rec.right - rec.left;
        const h = rec.bottom - rec.top;
        const data = new Map<number, Uint8Array | null>();
        for (const c of rec.chans) {
          const end = r.pos + c.len;
          const cw = c.id === -2 && rec.mask ? rec.mask.right - rec.mask.left : w;
          const chh = c.id === -2 && rec.mask ? rec.mask.bottom - rec.mask.top : h;
          if (c.len < 2 || cw <= 0 || chh <= 0) {
            r.pos = end;
            continue;
          }
          const plane = readChannel(r, cw, chh, end);
          if (!plane) unsupported = true;
          data.set(c.id, plane);
        }
        if (rec.divider === 1 || rec.divider === 2 || rec.divider === 3) continue; // group markers
        if (w <= 0 || h <= 0) continue;
        const R = data.get(0) ?? null;
        const G = mode === 1 ? R : data.get(1) ?? null;
        const B = mode === 1 ? R : data.get(2) ?? null;
        if (!R || !G || !B) continue;
        const A = data.get(-1) ?? null;
        const c = createCanvas(w, h);
        const ctx = ctx2d(c);
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          img.data[i * 4] = R[i];
          img.data[i * 4 + 1] = G[i];
          img.data[i * 4 + 2] = B[i];
          img.data[i * 4 + 3] = A ? A[i] : 255;
        }
        ctx.putImageData(img, 0, 0);
        const layer = doc.newRaster(rec.name || 'Layer', c, rec.left, rec.top);
        layer.opacity = rec.opacity;
        layer.visible = !rec.hidden;
        layer.blend = (KEY_TO_BLEND.get(rec.blend) ?? 'normal') as BlendMode;
        const M = data.get(-2);
        if (M && rec.mask) {
          const mw = rec.mask.right - rec.mask.left;
          const mh = rec.mask.bottom - rec.mask.top;
          const mc = createCanvas(W, H);
          const mctx = ctx2d(mc);
          if (rec.mask.def) {
            mctx.fillStyle = '#fff';
            mctx.fillRect(0, 0, W, H);
            mctx.clearRect(rec.mask.left, rec.mask.top, mw, mh);
          }
          const mimg = mctx.createImageData(mw, mh);
          for (let i = 0; i < mw * mh; i++) {
            mimg.data[i * 4] = 255;
            mimg.data[i * 4 + 1] = 255;
            mimg.data[i * 4 + 2] = 255;
            mimg.data[i * 4 + 3] = M[i];
          }
          const tmp = createCanvas(mw, mh);
          ctx2d(tmp).putImageData(mimg, 0, 0);
          mctx.drawImage(tmp, rec.mask.left, rec.mask.top);
          layer.mask = mc;
        }
        doc.layers.push(layer);
      }
    }
    r.pos = Math.max(liEnd, r.pos);
  }
  r.pos = lmEnd;

  if (!doc.layers.length) {
    // Fall back to the merged composite in the image data section.
    const comp = r.u16();
    const chans = Math.min(nch, mode === 1 ? 1 : 3);
    const planesOut: Uint8Array[] = [];
    if (comp === 1) {
      const counts: number[] = [];
      for (let i = 0; i < nch * H; i++) counts.push(r.u16());
      for (let c = 0; c < nch; c++) {
        const plane = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) {
          const rowEnd = r.pos + counts[c * H + y];
          unpackBits(r, plane, y * W, W, rowEnd);
          r.pos = rowEnd;
        }
        planesOut.push(plane);
      }
    } else if (comp === 0) {
      for (let c = 0; c < nch; c++) {
        planesOut.push(new Uint8Array(buf, r.pos, W * H).slice());
        r.pos += W * H;
      }
    } else throw new Error('Compressed (ZIP) PSD image data is not supported');
    const c = createCanvas(W, H);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(W, H);
    const [R, G, B] = chans === 1 ? [planesOut[0], planesOut[0], planesOut[0]] : planesOut;
    for (let i = 0; i < W * H; i++) {
      img.data[i * 4] = R[i];
      img.data[i * 4 + 1] = G[i];
      img.data[i * 4 + 2] = B[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    doc.layers.push(doc.newRaster('Background', c));
  }
  if (unsupported) console.warn('Some PSD channels used unsupported compression and were skipped');
  doc.activeId = doc.layers[doc.layers.length - 1].id;
  doc.dirty = false;
  return doc;
}
