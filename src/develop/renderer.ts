// WebGL2 develop pipeline. Non-destructive: the source texture never changes, every render
// re-applies the settings. Passes: PREP -> (blurs, NR) -> MAIN -> FINAL (geometry/effects).

import { oklabDirOfHsv, oklabHueOfHsv, srgbToLinear, wbMultipliers } from '../lib/color';
import { cropOutSize, orientedSize } from './geometry';
import { DevelopSettings, HSL_HUES, RetouchSpot, defaultSettings, processingKey } from './settings';
import { BLUR, COPY_RECT, DOWN, FINAL, MAIN, NR, PREP, VERT } from './shaders';
import { Box, RegionImage, findSourceOffset, planSpot, renderSpot, searchRegion, spotToPx } from './retouch';
import { LUT_SIZE, buildToneLut } from './tone';

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
  size: number;
}
interface Program {
  prog: WebGLProgram;
  uniforms: Map<string, UniformInfo>;
}
interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
  float: boolean;
}
type UniformValue = number | boolean | number[] | Float32Array;

export interface ViewParams {
  targetW: number;
  targetH: number;
  /** Placement of the crop-out image on the target, in target pixels (y from top). */
  rect: [number, number, number, number];
  cropMode?: boolean;
  bg?: [number, number, number];
  before?: boolean;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  total: number;
}

export interface SourceSample {
  w: number;
  h: number;
  /** Linear-light RGB floats. */
  lin: Float32Array;
}

const HSL_CENTERS = (() => {
  const c = HSL_HUES.map((h) => (oklabHueOfHsv(h) * Math.PI) / 180);
  for (let i = 1; i < c.length; i++) if (c[i] < c[i - 1]) c[i] += Math.PI * 2;
  return [...c, c[0] + Math.PI * 2];
})();

export class DevelopRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly floatOk: boolean;
  readonly maxTexture: number;
  private progs: Record<'prep' | 'down' | 'blur' | 'nr' | 'main' | 'final' | 'copy', Program>;
  private vao: WebGLVertexArrayObject;
  private src: WebGLTexture;
  private lut: WebGLTexture;
  private dummy: WebGLTexture;
  private targets = new Map<string, Target>();
  private lastKey = '';
  /** Source with touch-up spots applied (same size as `src`), rebuilt when the spots change. */
  private ret: { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number } | null = null;
  private srcFb: WebGLFramebuffer | null = null;
  private retKey = '';
  /** Whether the last processed settings read the retouched source. */
  private spotsOn = false;
  private air = 0.9;
  w = 0;
  h = 0;
  fullW = 0;
  fullH = 0;
  sample: SourceSample | null = null;
  lost = false;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.progs = {
      prep: this.program(PREP),
      down: this.program(DOWN),
      blur: this.program(BLUR),
      nr: this.program(NR),
      main: this.program(MAIN),
      final: this.program(FINAL),
      copy: this.program(COPY_RECT),
    };
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of Object.values(this.progs)) {
      const loc = gl.getAttribLocation(p.prog, 'aPos');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }
    this.src = this.texture();
    this.lut = this.texture();
    this.dummy = this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private program(fs: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    const uniforms = new Map<string, UniformInfo>();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      uniforms.set(name, { loc: gl.getUniformLocation(prog, info.name)!, type: info.type, size: info.size });
    }
    return { prog, uniforms };
  }

  private target(key: string, w: number, h: number, float = true): Target {
    const gl = this.gl;
    const useFloat = float && this.floatOk;
    const ex = this.targets.get(key);
    if (ex && ex.w === w && ex.h === h && ex.float === useFloat) return ex;
    if (ex) {
      gl.deleteTexture(ex.tex);
      gl.deleteFramebuffer(ex.fb);
    }
    const tex = this.texture();
    if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fb, w, h, float: useFloat };
    this.targets.set(key, t);
    return t;
  }

  private run(p: Program, out: Target | null, textures: Record<string, WebGLTexture>, uniforms: Record<string, UniformValue>, vw?: number, vh?: number) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : vw!, out ? out.h : vh!);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      const u = p.uniforms.get(name);
      if (!u) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.loc, unit);
      unit++;
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const u = p.uniforms.get(name);
      if (!u) continue;
      const arr = typeof v === 'number' || typeof v === 'boolean' ? [Number(v)] : Array.from(v);
      switch (u.type) {
        case gl.FLOAT: gl.uniform1fv(u.loc, arr); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, arr); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, arr); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, arr); break;
        case gl.INT:
        case gl.BOOL: gl.uniform1iv(u.loc, arr.map((x) => Math.round(x))); break;
      }
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Unbind textures so a later pass can render into them without a feedback loop.
    for (let i = 0; i < unit; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  /** Uploads a new source. `fullW/H` are the original pixel dimensions (for resolution-independent radii). */
  setImage(src: TexImageSource & { width: number; height: number }, fullW = src.width, fullH = src.height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.w = src.width;
    this.h = src.height;
    this.fullW = fullW;
    this.fullH = fullH;
    this.lastKey = '';
    this.retKey = '';
    this.sample = makeSample(src);
    this.air = estimateAirlight(this.sample);
  }

  // ---------------------------------------------------------------- touch up
  private sourceFb(): WebGLFramebuffer {
    const gl = this.gl;
    if (!this.srcFb) {
      this.srcFb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.src, 0);
    }
    return this.srcFb;
  }

  /** Reads RGBA bytes (top-down) of any box; pixels outside the image repeat the nearest edge. */
  private readBox(fb: WebGLFramebuffer, b: Box): Uint8Array {
    const gl = this.gl;
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const x0 = cl(b.x, 0, this.w);
    const y0 = cl(b.y, 0, this.h);
    const x1 = cl(b.x + b.w, 0, this.w);
    const y1 = cl(b.y + b.h, 0, this.h);
    const out = new Uint8Array(b.w * b.h * 4);
    if (x1 <= x0 || y1 <= y0) return out;
    const iw = x1 - x0;
    const ih = y1 - y0;
    const tmp = iw === b.w && ih === b.h ? out : new Uint8Array(iw * ih * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(x0, y0, iw, ih, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    if (tmp === out) return out;
    for (let y = 0; y < b.h; y++) {
      const sy = cl(b.y + y, y0, y1 - 1) - y0;
      for (let x = 0; x < b.w; x++) {
        const s = (sy * iw + (cl(b.x + x, x0, x1 - 1) - x0)) * 4;
        const d = (y * b.w + x) * 4;
        out[d] = tmp[s];
        out[d + 1] = tmp[s + 1];
        out[d + 2] = tmp[s + 2];
        out[d + 3] = tmp[s + 3];
      }
    }
    return out;
  }

  /** Rebuilds the retouched source: a copy of the source with each spot applied in order. */
  private applySpots(spots: RetouchSpot[]) {
    const gl = this.gl;
    const { w, h } = this;
    if (!this.ret || this.ret.w !== w || this.ret.h !== h) {
      if (this.ret) {
        gl.deleteTexture(this.ret.tex);
        gl.deleteFramebuffer(this.ret.fb);
      }
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.ret = { tex, fb, w, h };
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sourceFb());
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.ret.fb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const s of spots) {
      const job = planSpot(s, w, h);
      if (!job) continue;
      // Later spots see earlier ones, as in Lightroom.
      const dst = this.readBox(this.ret.fb, job.box);
      const src = job.needsSource ? this.readBox(this.ret.fb, { ...job.box, x: job.box.x + job.spot.ox, y: job.box.y + job.spot.oy }) : null;
      const out = renderSpot(job, dst, src);
      gl.bindTexture(gl.TEXTURE_2D, this.ret.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, job.box.x, job.box.y, job.box.w, job.box.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  /** A downscaled read of the current (retouched) source, for the automatic source search. */
  private readRegion(box: Box, scale: number): RegionImage {
    const gl = this.gl;
    const useRet = this.spotsOn && this.ret;
    const fb = useRet ? this.ret!.fb : this.sourceFb();
    if (scale >= 0.999) return { data: this.readBox(fb, box), w: box.w, h: box.h, x: box.x, y: box.y, scale: 1 };
    const ow = Math.max(1, Math.round(box.w * scale));
    const oh = Math.max(1, Math.round(box.h * scale));
    const t = this.target('spot-search', ow, oh, false);
    this.run(
      this.progs.copy,
      t,
      { uTex: useRet ? this.ret!.tex : this.src },
      { uRect: [box.x / this.w, box.y / this.h, box.w / this.w, box.h / this.h], uStep: [box.w / this.w / ow, box.h / this.h / oh] },
    );
    const data = new Uint8Array(ow * oh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { data, w: ow, h: oh, x: box.x, y: box.y, scale: ow / box.w };
  }

  /** Suggests a source offset (normalized dx, dy) for a heal/clone spot, Lightroom style, avoiding `exclude`. */
  findSpotSource(s: RetouchSpot, exclude: [number, number][] = []): [number, number] {
    if (!this.w || this.lost) return [0, 0];
    const spot = spotToPx(s, this.w, this.h);
    const reg = searchRegion(spot, this.w, this.h);
    if (!reg) return [0, 0];
    const img = this.readRegion(reg.box, reg.scale);
    const avoid = exclude.map(([x, y]) => [x * this.w, y * this.h] as [number, number]);
    const [ox, oy] = findSourceOffset(spot, img, this.w, this.h, avoid);
    return [ox / this.w, oy / this.h];
  }

  private blur(src: Target, factor: number, sigmaPx: number, key: string): Target {
    let cur = src;
    let f = 1;
    while (f < factor) {
      const t = this.target(`${key}_d${f * 2}`, Math.max(1, Math.ceil(cur.w / 2)), Math.max(1, Math.ceil(cur.h / 2)));
      this.run(this.progs.down, t, { uTex: cur.tex }, {});
      cur = t;
      f *= 2;
    }
    const sig = Math.max(0.35, sigmaPx / factor);
    const radius = Math.min(96, Math.ceil(sig * 3));
    const tmp = this.target(`${key}_tmp`, cur.w, cur.h);
    const out = this.target(key, cur.w, cur.h);
    this.run(this.progs.blur, tmp, { uTex: cur.tex }, { uDir: [1 / cur.w, 0], uSigma: sig, uRadius: radius });
    this.run(this.progs.blur, out, { uTex: tmp.tex }, { uDir: [0, 1 / cur.h], uSigma: sig, uRadius: radius });
    return out;
  }

  /** Runs the source-space passes if the processing-relevant settings changed. */
  process(s: DevelopSettings) {
    if (!this.w || this.lost) return;
    const key = `${this.w}x${this.h}|${processingKey(s)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const gl = this.gl;
    const { w, h } = this;
    const longEdge = Math.max(w, h);
    const scale = w / (this.fullW || w);

    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, buildToneLut(s));

    const wb = wbMultipliers(s.temperature, s.tint);
    const expMul = Math.pow(2, s.exposure);
    const spots = s.spots ?? [];
    this.spotsOn = spots.length > 0;
    if (this.spotsOn) {
      const rk = `${w}x${h}|${JSON.stringify(spots)}`;
      if (rk !== this.retKey) {
        this.applySpots(spots);
        this.retKey = rk;
      }
    }
    const prep = this.target('prep', w, h);
    this.run(this.progs.prep, prep, { uSrc: this.spotsOn ? this.ret!.tex : this.src }, { uWB: wb, uExpMul: expMul });

    const masks = s.masks.filter((m) => m.enabled).slice(0, 8);
    const needS = s.sharpen.amount > 0;
    const needM = needS || s.texture !== 0 || s.noise.color > 0;
    const needL = s.clarity !== 0 || s.dehaze !== 0 || masks.some((m) => m.adjust.clarity !== 0);

    const blurM = needM ? this.blur(prep, 2, Math.max(1.5, 0.0025 * longEdge), 'blurM') : null;
    let base = prep;
    if (s.noise.luminance > 0 || s.noise.color > 0) {
      const nr = this.target('nr', w, h);
      this.run(
        this.progs.nr,
        nr,
        { uTex: prep.tex, uBlurM: blurM ? blurM.tex : this.dummy },
        { uTexel: [1 / w, 1 / h], uLum: s.noise.luminance / 100, uCol: s.noise.color / 100 },
      );
      base = nr;
    }
    const blurS = needS ? this.blur(prep, 1, s.sharpen.radius * scale, 'blurS') : null;
    const blurL = needL ? this.blur(prep, 4, 0.012 * longEdge, 'blurL') : null;

    const hsl: number[] = [];
    let hslOn = false;
    for (let i = 0; i < 8; i++) {
      const hv = s.hsl.hue[i] / 100;
      const sv = s.hsl.sat[i] / 100;
      const lv = s.hsl.lum[i] / 100;
      if (hv || sv || lv) hslOn = true;
      hsl.push(hv, sv, lv);
    }
    const g = s.grading;
    const wheelU = (wh: { hue: number; sat: number; lum: number }) => {
      const [a, b] = oklabDirOfHsv(wh.hue);
      return [a * (wh.sat / 100), b * (wh.sat / 100), wh.lum / 100, 0];
    };
    const gradeOn = [g.shadows, g.midtones, g.highlights, g.global].some((x) => x.sat !== 0 || x.lum !== 0);

    const info: number[] = [];
    const geo: number[] = [];
    const geo2: number[] = [];
    const ma: number[] = [];
    const mb: number[] = [];
    for (const m of masks) {
      if (m.type === 'radial') {
        const a = (m.radial.angle * Math.PI) / 180;
        info.push(0, m.invert ? 1 : 0, m.radial.feather / 100, 0);
        geo.push(m.radial.cx * w, m.radial.cy * h, m.radial.rx * w, m.radial.ry * h);
        geo2.push(Math.cos(a), Math.sin(a), 0, 0);
      } else {
        info.push(1, m.invert ? 1 : 0, 0, 0);
        geo.push(m.linear.x0 * w, m.linear.y0 * h, m.linear.x1 * w, m.linear.y1 * h);
        geo2.push(0, 0, 0, 0);
      }
      const A = m.adjust;
      ma.push(A.exposure, A.contrast / 100, A.highlights / 100, A.shadows / 100);
      mb.push(A.temperature / 100, A.tint / 100, A.saturation / 100, A.clarity / 100);
    }
    while (info.length < 32) {
      info.push(0, 0, 0, 0);
      geo.push(0, 0, 1, 1);
      geo2.push(1, 0, 0, 0);
      ma.push(0, 0, 0, 0);
      mb.push(0, 0, 0, 0);
    }

    const main = this.target('main', w, h, false);
    this.run(
      this.progs.main,
      main,
      {
        uBase: base.tex,
        uBlurS: blurS ? blurS.tex : this.dummy,
        uBlurM: blurM ? blurM.tex : this.dummy,
        uBlurL: blurL ? blurL.tex : this.dummy,
        uLut: this.lut,
      },
      {
        uSize: [w, h],
        uDehaze: s.dehaze / 100,
        uAir: Math.max(0.05, this.air * expMul * Math.max(...wb)),
        uSharpen: s.sharpen.amount / 100,
        uSharpMask: s.sharpen.masking / 100,
        uTexture: s.texture / 100,
        uClarity: s.clarity / 100,
        uVibrance: s.vibrance / 100,
        uSaturation: s.saturation / 100,
        uBW: s.treatment === 'bw' ? 1 : 0,
        uHslOn: hslOn ? 1 : 0,
        uHsl: hsl,
        uHslC: HSL_CENTERS,
        uGradeS: wheelU(g.shadows),
        uGradeM: wheelU(g.midtones),
        uGradeH: wheelU(g.highlights),
        uGradeG: wheelU(g.global),
        uBlend: g.blending / 100,
        uBalance: g.balance / 100,
        uGradeOn: gradeOn ? 1 : 0,
        uMaskCount: masks.length,
        uMaskInfo: info,
        uMaskGeo: geo,
        uMaskGeo2: geo2,
        uMaskA: ma,
        uMaskB: mb,
      },
    );
    // Mipmaps let zoomed-out views, thumbnails and the histogram downsample without aliasing.
    gl.bindTexture(gl.TEXTURE_2D, main.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private finalUniforms(s: DevelopSettings, v: ViewParams, flipY: boolean): Record<string, UniformValue> {
    const o = orientedSize(this.fullW, this.fullH, s.orient.rotate);
    const out = cropOutSize(s, this.fullW, this.fullH, v.cropMode);
    const c = v.cropMode ? { x: 0, y: 0, w: 1, h: 1 } : s.crop;
    const vig = v.cropMode ? 0 : s.vignette.amount / 100;
    return {
      uRect: v.rect,
      uTarget: [v.targetW, v.targetH],
      uFlipY: flipY ? 1 : 0,
      uCrop: [c.x, c.y, c.w, c.h],
      uAngle: (s.crop.angle * Math.PI) / 180,
      uOSize: [o.w, o.h],
      uRot: s.orient.rotate,
      uFlipH: s.orient.flipH ? 1 : 0,
      uFlipV: s.orient.flipV ? 1 : 0,
      uBg: v.bg ?? [0.1, 0.1, 0.11],
      uVig: [vig, s.vignette.midpoint / 100, s.vignette.roundness / 100, s.vignette.feather / 100],
      uVigHi: s.vignette.highlights / 100,
      uGrain: [s.grain.amount / 100, s.grain.size / 100, s.grain.roughness / 100],
      uOutPx: [out.w, out.h],
      uSeed: 0,
      // Texels of the processed image per target pixel: zoomed-out views and thumbnails read a mip level.
      uLod: Math.min(16, Math.log2(Math.max(1, (out.w / Math.max(1e-6, v.rect[2])) * (this.w / (this.fullW || this.w))))),
    };
  }

  /** Renders to the canvas (default framebuffer). The caller sizes the canvas. */
  draw(s: DevelopSettings, v: ViewParams) {
    if (!this.w || this.lost) return;
    const eff = v.before ? beforeSettings(s) : s;
    this.process(eff);
    if (this.canvas.width !== v.targetW || this.canvas.height !== v.targetH) {
      this.canvas.width = v.targetW;
      this.canvas.height = v.targetH;
    }
    const main = this.targets.get('main')!;
    this.run(this.progs.final, null, { uImg: main.tex }, this.finalUniforms(eff, v, true), v.targetW, v.targetH);
  }

  /** Renders the final image at outW×outH and returns top-down RGBA pixels. */
  renderPixels(s: DevelopSettings, outW: number, outH: number, opts: { before?: boolean; key?: string } = {}): ImageData {
    const eff = opts.before ? beforeSettings(s) : s;
    this.process(eff);
    const gl = this.gl;
    const t = this.target(opts.key ?? 'export', outW, outH, false);
    const main = this.targets.get('main')!;
    this.run(this.progs.final, t, { uImg: main.tex }, this.finalUniforms(eff, { targetW: outW, targetH: outH, rect: [0, 0, outW, outH] }, false));
    const px = new Uint8ClampedArray(outW * outH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return new ImageData(px, outW, outH);
  }

  histogram(s: DevelopSettings, before = false): Histogram {
    const out = cropOutSize(s, this.fullW, this.fullH);
    const k = Math.min(1, 256 / Math.max(out.w, out.h));
    const img = this.renderPixels(s, Math.max(1, Math.round(out.w * k)), Math.max(1, Math.round(out.h * k)), { before, key: 'hist' });
    return computeHistogram(img.data);
  }

  /** Releases all GPU resources immediately. */
  dispose() {
    for (const t of this.targets.values()) {
      this.gl.deleteTexture(t.tex);
      this.gl.deleteFramebuffer(t.fb);
    }
    this.targets.clear();
    if (this.ret) {
      this.gl.deleteTexture(this.ret.tex);
      this.gl.deleteFramebuffer(this.ret.fb);
      this.ret = null;
    }
    if (this.srcFb) this.gl.deleteFramebuffer(this.srcFb);
    this.srcFb = null;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * Creates a renderer on a fresh canvas appended to `host`. A canvas keeps its WebGL context for life, so once
 * `dispose()` has lost it the canvas can't be reused; remounts (including React StrictMode's) need a new one.
 */
export function mountRenderer(host: HTMLElement, className = 'gl'): DevelopRenderer {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  host.appendChild(canvas);
  try {
    return new DevelopRenderer(canvas);
  } catch (e) {
    canvas.remove();
    throw e;
  }
}

/** Releases a renderer created by `mountRenderer` and removes its canvas. */
export function unmountRenderer(r: DevelopRenderer | null) {
  if (!r) return;
  r.dispose();
  r.canvas.remove();
}

export function beforeSettings(s: DevelopSettings): DevelopSettings {
  const b = defaultSettings();
  b.crop = s.crop;
  b.orient = s.orient;
  return b;
}

export function computeHistogram(px: Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    r[px[i]]++;
    g[px[i + 1]]++;
    b[px[i + 2]]++;
    l[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
  }
  return { r, g, b, l, total: px.length / 4 };
}

function makeSample(src: TexImageSource & { width: number; height: number }): SourceSample {
  const k = Math.min(1, 192 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lin = new Float32Array(w * h * 3);
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    lin[j] = lut[d[i]];
    lin[j + 1] = lut[d[i + 1]];
    lin[j + 2] = lut[d[i + 2]];
  }
  return { w, h, lin };
}

function estimateAirlight(s: SourceSample): number {
  const vals: number[] = [];
  for (let i = 0; i < s.lin.length; i += 3) vals.push(Math.max(s.lin[i], s.lin[i + 1], s.lin[i + 2]));
  vals.sort((a, b) => a - b);
  const v = vals[Math.floor(vals.length * 0.995)] ?? 0.9;
  return Math.min(1, Math.max(0.4, v));
}
