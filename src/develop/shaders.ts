// GLSL ES 3.00 shaders for the develop pipeline.

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLinear(vec3 c) {
  vec3 a = abs(c);
  vec3 lo = a / 12.92;
  vec3 hi = pow((a + 0.055) / 1.055, vec3(2.4));
  return sign(c) * mix(hi, lo, vec3(lessThanEqual(a, vec3(0.04045))));
}
vec3 toSrgb(vec3 c) {
  vec3 a = abs(c);
  vec3 lo = a * 12.92;
  vec3 hi = 1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055;
  return sign(c) * mix(hi, lo, vec3(lessThanEqual(a, vec3(0.0031308))));
}
float toSrgb1(float v) { return toSrgb(vec3(v)).x; }
`;

/** Pass 1: decode to linear light, apply white balance and exposure. Alpha = display-encoded luma. */
export const PREP = COMMON + /* glsl */ `
uniform sampler2D uSrc;
uniform vec3 uWB;
uniform float uExpMul;
void main() {
  vec3 c = toLinear(texture(uSrc, vUv).rgb) * uWB * uExpMul;
  fragColor = vec4(c, toSrgb1(max(luma(c), 0.0)));
}`;

/** Copies a sub-rectangle of a texture, box-filtered (4x4 bilinear taps per output pixel). Used for the touch-up source search. */
export const COPY_RECT = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform vec4 uRect;
uniform vec2 uStep;
void main() {
  vec2 base = uRect.xy + vUv * uRect.zw;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++)
    for (int x = 0; x < 4; x++) acc += texture(uTex, base + ((vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5) * uStep);
  fragColor = acc / 16.0;
}`;

/** 2x downsample with a single bilinear tap (box filter). */
export const DOWN = COMMON + /* glsl */ `
uniform sampler2D uTex;
void main() { fragColor = texture(uTex, vUv); }`;

/** Separable Gaussian blur. */
export const BLUR = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigma;
uniform int uRadius;
void main() {
  vec4 acc = texture(uTex, vUv);
  float wsum = 1.0;
  float inv = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = 1; i <= 96; i++) {
    if (i > uRadius) break;
    float fi = float(i);
    float w = exp(-fi * fi * inv);
    acc += w * (texture(uTex, vUv + uDir * fi) + texture(uTex, vUv - uDir * fi));
    wsum += 2.0 * w;
  }
  fragColor = acc / wsum;
}`;

/** Noise reduction: luminance bilateral filter + chroma replacement from a blurred copy. */
export const NR = COMMON + /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uBlurM;
uniform vec2 uTexel;
uniform float uLum;
uniform float uCol;
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 rgb = c.rgb;
  if (uLum > 0.0) {
    float sr = 0.015 + 0.12 * uLum;
    float inv = 1.0 / (2.0 * sr * sr);
    vec3 acc = vec3(0.0);
    float ws = 0.0;
    for (int y = -3; y <= 3; y++) {
      for (int x = -3; x <= 3; x++) {
        vec4 s = texture(uTex, vUv + vec2(float(x), float(y)) * uTexel);
        float ds = float(x * x + y * y);
        float dr = s.a - c.a;
        float w = exp(-ds / 4.5 - dr * dr * inv);
        acc += s.rgb * w;
        ws += w;
      }
    }
    rgb = mix(rgb, acc / ws, min(1.0, uLum * 1.25));
  }
  if (uCol > 0.0) {
    vec3 b = texture(uBlurM, vUv).rgb;
    float lc = luma(rgb);
    float lb = max(luma(b), 1e-5);
    rgb = mix(rgb, b * (lc / lb), uCol);
  }
  fragColor = vec4(rgb, toSrgb1(max(luma(rgb), 0.0)));
}`;

/** Pass 3: dehaze, detail (sharpen/texture/clarity), tone, curves, colour, local masks. */
export const MAIN = COMMON + /* glsl */ `
uniform sampler2D uBase;
uniform sampler2D uBlurS;
uniform sampler2D uBlurM;
uniform sampler2D uBlurL;
uniform sampler2D uLut;
uniform vec2 uSize;
uniform float uDehaze;
uniform float uAir;
uniform float uSharpen;
uniform float uSharpMask;
uniform float uTexture;
uniform float uClarity;
uniform float uVibrance;
uniform float uSaturation;
uniform int uBW;
uniform int uHslOn;
uniform vec3 uHsl[8];
uniform float uHslC[9];
uniform vec4 uGradeS;
uniform vec4 uGradeM;
uniform vec4 uGradeH;
uniform vec4 uGradeG;
uniform float uBlend;
uniform float uBalance;
uniform int uGradeOn;
uniform int uMaskCount;
uniform vec4 uMaskInfo[8];
uniform vec4 uMaskGeo[8];
uniform vec4 uMaskGeo2[8];
uniform vec4 uMaskA[8];
uniform vec4 uMaskB[8];

const float LUT_N = 1024.0;
float lutCoord(float x) { return clamp(x * 0.5, 0.0, 1.0) * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N; }
float toneA(float x) { return texture(uLut, vec2(lutCoord(x), 0.5)).a; }
vec3 toneTriple(float hi, float md, float lo) {
  float h = toneA(hi);
  float l = toneA(lo);
  float m = l + (h - l) * ((md - lo) / max(hi - lo, 1e-6));
  return vec3(h, m, l);
}
// Hue-preserving tone mapping: curve the largest and smallest channel, interpolate the middle one.
vec3 applyTone(vec3 c) {
  vec3 t;
  if (c.r >= c.g) {
    if (c.g >= c.b) { t = toneTriple(c.r, c.g, c.b); return vec3(t.x, t.y, t.z); }
    else if (c.b >= c.r) { t = toneTriple(c.b, c.r, c.g); return vec3(t.y, t.z, t.x); }
    else { t = toneTriple(c.r, c.b, c.g); return vec3(t.x, t.z, t.y); }
  } else {
    if (c.r >= c.b) { t = toneTriple(c.g, c.r, c.b); return vec3(t.y, t.x, t.z); }
    else if (c.b >= c.g) { t = toneTriple(c.b, c.g, c.r); return vec3(t.z, t.y, t.x); }
    else { t = toneTriple(c.g, c.b, c.r); return vec3(t.z, t.x, t.y); }
  }
}
// Luminance-ratio tone mapping: keeps chroma ratios (saturation) intact.
vec3 lumTone(vec3 p) {
  float L = max(luma(p), 1e-5);
  float Lt = toneA(L);
  vec3 q = mix(p + (Lt - L), p * (Lt / L), smoothstep(0.0, 0.1, L));
  float mx = max(q.r, max(q.g, q.b));
  if (mx > 1.0) q = Lt + (q - Lt) * ((1.0 - Lt) / max(mx - Lt, 1e-5));
  return max(q, vec3(0.0));
}
vec3 channelCurves(vec3 p) {
  return vec3(texture(uLut, vec2(lutCoord(p.r), 0.5)).r,
              texture(uLut, vec2(lutCoord(p.g), 0.5)).g,
              texture(uLut, vec2(lutCoord(p.b), 0.5)).b);
}
vec3 toOklab(vec3 c) {
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619,
                  0.5363325363, 0.6806995451, 0.2817188376,
                  0.0514459929, 0.1073969566, 0.6299787005) * c;
  lms = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371,
              0.7936177850, -2.4285922050, 0.7827717662,
              -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 fromOklab(vec3 lab) {
  vec3 lms = mat3(1.0, 1.0, 1.0,
                  0.3963377774, -0.1055613458, -0.0894841775,
                  0.2158037573, -0.0638541728, -1.2914855480) * lab;
  lms = lms * lms * lms;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863,
              -3.3077115913, 2.6097574011, -0.7034186147,
              0.2309699292, -0.3413193965, 1.7076147010) * lms;
}
vec3 wbMul(float t, float u) {
  vec3 m = vec3((1.0 + 0.3 * t) * (1.0 + 0.1 * u), 1.0 - 0.2 * u, (1.0 - 0.3 * t) * (1.0 + 0.1 * u));
  return m / luma(m);
}
float maskWeight(int i, vec2 px) {
  vec4 info = uMaskInfo[i];
  float w;
  if (info.x < 0.5) {
    vec4 g = uMaskGeo[i];
    vec2 d = px - g.xy;
    vec2 cs = uMaskGeo2[i].xy;
    vec2 q = vec2(d.x * cs.x + d.y * cs.y, -d.x * cs.y + d.y * cs.x) / max(g.zw, vec2(1.0));
    float r = length(q);
    float f = max(info.z, 0.01);
    w = 1.0 - smoothstep(1.0 - f, 1.0, r);
  } else {
    vec4 g = uMaskGeo[i];
    vec2 d = g.zw - g.xy;
    float t = dot(px - g.xy, d) / max(dot(d, d), 1e-6);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  }
  return info.y > 0.5 ? 1.0 - w : w;
}

void main() {
  vec4 base = texture(uBase, vUv);
  vec3 c = base.rgb;
  float L0 = base.a;
  vec2 px = vUv * uSize;

  float mw[8];
  float expAdj = 0.0;
  vec3 wbAdj = vec3(1.0);
  for (int i = 0; i < 8; i++) {
    mw[i] = 0.0;
    if (i >= uMaskCount) break;
    float w = maskWeight(i, px);
    mw[i] = w;
    expAdj += w * uMaskA[i].x;
    if (uMaskB[i].x != 0.0 || uMaskB[i].y != 0.0) wbAdj *= mix(vec3(1.0), wbMul(uMaskB[i].x, uMaskB[i].y), w);
  }
  c *= exp2(expAdj) * wbAdj;

  float bL = 0.0;
  vec3 blurL = vec3(0.0);
  if (uDehaze != 0.0 || uClarity != 0.0 || uMaskCount > 0) {
    vec4 t = texture(uBlurL, vUv);
    blurL = t.rgb;
    bL = t.a;
  }
  if (uDehaze != 0.0) {
    float dark = min(blurL.r, min(blurL.g, blurL.b));
    float hz = clamp(dark / uAir, 0.0, 1.0);
    if (uDehaze > 0.0) {
      float tr = max(1.0 - 0.9 * uDehaze * hz, 0.12);
      c = max((c - uAir) / tr + uAir, 0.0);
    } else {
      c = mix(c, vec3(uAir * 0.85), -uDehaze * 0.55 * (0.35 + 0.65 * hz));
    }
  }

  vec3 p = toSrgb(c);
  float dL = 0.0;
  if (uSharpen > 0.0) {
    float bS = texture(uBlurS, vUv).a;
    float bM = texture(uBlurM, vUv).a;
    float detail = L0 - bS;
    float edge = abs(L0 - bM);
    float mk = uSharpMask < 0.001 ? 1.0 : smoothstep(uSharpMask * 0.06, uSharpMask * 0.06 + 0.03, edge);
    dL += uSharpen * 1.6 * detail * mk;
  }
  if (uTexture != 0.0) {
    float bM = texture(uBlurM, vUv).a;
    dL += uTexture * 0.9 * (L0 - bM);
  }
  float mid = 1.0 - pow(abs(2.0 * clamp(L0, 0.0, 1.0) - 1.0), 2.0);
  if (uClarity != 0.0) dL += uClarity * 0.85 * (L0 - bL) * mid;
  for (int i = 0; i < 8; i++) {
    if (i >= uMaskCount) break;
    if (uMaskB[i].w != 0.0) dL += mw[i] * uMaskB[i].w * 0.85 * (L0 - bL) * mid;
  }
  p += dL;

  p = max(p, vec3(0.0));
  p = mix(applyTone(p), lumTone(p), 0.5);
  p = channelCurves(p);

  for (int i = 0; i < 8; i++) {
    if (i >= uMaskCount) break;
    float w = mw[i];
    if (w <= 0.0) continue;
    vec4 a = uMaskA[i];
    float Lm = clamp(luma(p), 0.0, 1.0);
    float d = a.y * 0.35 * (Lm - 0.45);
    d += a.z * (a.z > 0.0 ? 0.2 : 0.3) * 6.75 * Lm * Lm * (1.0 - Lm);
    d += a.w * 0.3 * 6.75 * Lm * (1.0 - Lm) * (1.0 - Lm);
    p += w * d;
  }

  vec3 lab = toOklab(max(toLinear(clamp(p, 0.0, 1.0)), vec3(0.0)));
  float C = length(lab.yz);
  float h = C > 1e-6 ? atan(lab.z, lab.y) : 0.0;
  if (uHslOn == 1) {
    float hd = h < 0.0 ? h + 6.28318531 : h;
    if (hd < uHslC[0]) hd += 6.28318531;
    int seg = 7;
    for (int k = 0; k < 8; k++) {
      if (hd >= uHslC[k] && hd < uHslC[k + 1]) { seg = k; break; }
    }
    float t = clamp((hd - uHslC[seg]) / (uHslC[seg + 1] - uHslC[seg]), 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 adj = mix(uHsl[seg], uHsl[(seg + 1) % 8], t);
    float satW = clamp(C / 0.08, 0.0, 1.0);
    h += adj.x * 0.5236 * satW;
    C *= max(0.0, 1.0 + adj.y);
    lab.x *= 1.0 + adj.z * 0.4 * satW;
  }
  if (uVibrance != 0.0) {
    float s = clamp(C / 0.22, 0.0, 1.0);
    float hdeg = degrees(h < 0.0 ? h + 6.28318531 : h);
    float skin = (hdeg > 30.0 && hdeg < 90.0) ? 0.55 : 1.0;
    C *= max(0.0, 1.0 + uVibrance * (1.0 - s) * (uVibrance > 0.0 ? skin : 1.0) * 1.2);
  }
  C *= max(0.0, 1.0 + uSaturation);
  for (int i = 0; i < 8; i++) {
    if (i >= uMaskCount) break;
    if (uMaskB[i].z != 0.0) C *= max(0.0, 1.0 + mw[i] * uMaskB[i].z);
  }
  if (uBW == 1) C = 0.0;
  lab.yz = C * vec2(cos(h), sin(h));

  if (uGradeOn == 1) {
    float Lg = clamp(lab.x, 0.0, 1.0);
    float pivot = clamp(0.5 - 0.25 * uBalance, 0.15, 0.85);
    float e = mix(2.2, 0.6, uBlend);
    float ws = pow(1.0 - smoothstep(0.0, pivot, Lg), e);
    float wh = pow(smoothstep(pivot, 1.0, Lg), e);
    float wm = max(0.0, 1.0 - ws - wh);
    lab.yz += (ws * uGradeS.xy + wm * uGradeM.xy + wh * uGradeH.xy + uGradeG.xy) * 0.12;
    lab.x += (ws * uGradeS.z + wm * uGradeM.z + wh * uGradeH.z + uGradeG.z) * 0.12;
  }

  vec3 outc = toSrgb(max(fromOklab(lab), vec3(0.0)));
  fragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

/** Pass 4: geometry (orientation, straighten, crop), vignette and grain onto the target. */
export const FINAL = COMMON + /* glsl */ `
uniform sampler2D uImg;
uniform vec4 uRect;
uniform vec2 uTarget;
uniform int uFlipY;
uniform vec4 uCrop;
uniform float uAngle;
uniform vec2 uOSize;
uniform int uRot;
uniform int uFlipH;
uniform int uFlipV;
uniform vec3 uBg;
uniform vec4 uVig;
uniform float uVigHi;
uniform vec3 uGrain;
uniform vec2 uOutPx;
uniform float uSeed;
/** Mip level for the current display scale (0 when shown at or above texture resolution). */
uniform float uLod;

uint hashU(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float hash2(vec2 p) { return float(hashU(uvec2(ivec2(floor(p)) + 32768)) & 0xffffffu) / 16777215.0; }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uFlipY == 1 ? uTarget.y - gl_FragCoord.y : gl_FragCoord.y);
  vec2 uv = (frag - uRect.xy) / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { fragColor = vec4(uBg, 1.0); return; }
  vec2 f = uCrop.xy + uv * uCrop.zw;
  vec2 F = (f - 0.5) * uOSize;
  float ca = cos(uAngle);
  float sa = sin(uAngle);
  vec2 o = vec2(ca * F.x + sa * F.y, -sa * F.x + ca * F.y) / uOSize + 0.5;
  if (o.x < 0.0 || o.y < 0.0 || o.x > 1.0 || o.y > 1.0) { fragColor = vec4(uBg * 0.6, 1.0); return; }
  if (uFlipH == 1) o.x = 1.0 - o.x;
  if (uFlipV == 1) o.y = 1.0 - o.y;
  vec2 s = o;
  if (uRot == 90) s = vec2(o.y, 1.0 - o.x);
  else if (uRot == 180) s = 1.0 - o;
  else if (uRot == 270) s = vec2(1.0 - o.y, o.x);
  // Explicit LOD: the branches above make implicit derivatives unreliable, and the scale is uniform anyway.
  vec3 col = textureLod(uImg, s, uLod).rgb;

  if (uVig.x != 0.0) {
    vec2 d = (uv - 0.5) * 2.0;
    float ar = uOutPx.x / max(uOutPx.y, 1.0);
    vec2 dc = ar > 1.0 ? vec2(d.x * ar, d.y) / ar : vec2(d.x, d.y / ar) * ar;
    float round01 = uVig.z * 0.5 + 0.5;
    vec2 q = mix(d, dc, round01);
    float ex = mix(5.0, 2.0, round01);
    float r = pow(pow(abs(q.x), ex) + pow(abs(q.y), ex), 1.0 / ex);
    float start = mix(0.15, 1.15, uVig.y);
    float v = smoothstep(start, start + mix(0.04, 1.1, uVig.w), r);
    if (uVig.x < 0.0) {
      float protect = mix(1.0, 1.0 - smoothstep(0.6, 1.0, luma(col)), uVigHi);
      col *= 1.0 + uVig.x * v * protect;
    } else {
      col = mix(col, vec3(1.0), uVig.x * v);
    }
  }
  if (uGrain.x > 0.0) {
    vec2 gp = uv * uOutPx / (0.8 + uGrain.y * 4.0) + uSeed;
    float n1 = vnoise(gp);
    float n2 = vnoise(gp * 2.37 + 19.1);
    float n = mix(n1, n1 * 0.5 + n2 * 0.5, uGrain.z) - 0.5;
    float L = luma(col);
    col += n * uGrain.x * 0.28 * (1.0 - 0.6 * abs(2.0 * L - 1.0));
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
