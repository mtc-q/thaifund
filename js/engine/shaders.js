// GLSL sources for the WebGL2 processing pipeline.
import { GLOBAL_PARAMS, LOCAL_PARAMS } from '../schema.js';

const defines = [
  `#define NP ${GLOBAL_PARAMS.length}`,
  `#define NL ${LOCAL_PARAMS.length}`,
  ...GLOBAL_PARAMS.map((p, i) => `#define P_${p.id.toUpperCase()} ${i}`),
  ...LOCAL_PARAMS.map((p, i) => `#define L_${p.id.toUpperCase()} ${i}`),
].join('\n');

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 o;
`;

const COMMON = `
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LW); }
float l2s(float x) { x = max(x, 0.0); return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float s2l(float x) { x = max(x, 0.0); return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
vec3 L2S(vec3 c) { return vec3(l2s(c.r), l2s(c.g), l2s(c.b)); }
vec3 S2L(vec3 c) { return vec3(s2l(c.r), s2l(c.g), s2l(c.b)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
uint hashu(uvec2 v) {
  uint h = v.x * 1664525u ^ (v.y * 1013904223u + 0x9e3779b9u);
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return h;
}
float hash2(vec2 p) { return float(hashu(uvec2(ivec2(floor(p)) + 65536))) / 4294967295.0; }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i), b = hash2(i + vec2(1.0, 0.0)), c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

export const VERT = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Geometry pass: resamples the source through the crop/straighten/perspective homography
// and carries the (feathered / shifted) subject mask in alpha.
export const GEO = HEAD + `
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform mat3 uH;
uniform vec2 uOrigin;
uniform float uScale;
uniform int uHasMask;
uniform int uInvert;
uniform float uFeather;
uniform float uShift;
uniform vec2 uMaskSize;

float mAt(vec2 uv, float lod) { return textureLod(uMask, uv, lod).r; }

float sampleMask(vec2 uv) {
  vec2 tx = 1.0 / uMaskSize;
  float lodF = uFeather > 1.0 ? log2(uFeather * 0.5) : 0.0;
  if (abs(uShift) < 0.5) {
    if (uFeather < 1.0) return texture(uMask, uv).r;
    float m = mAt(uv, lodF) * 0.2;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      m += mAt(uv + vec2(cos(a), sin(a)) * uFeather * 0.55 * tx, lodF) * 0.1;
    }
    return m;
  }
  float r = abs(uShift);
  float lod = max(lodF, log2(max(r * 0.3, 1.0)));
  float m = mAt(uv, lod);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.523599;
    vec2 d = vec2(cos(a), sin(a));
    float v1 = mAt(uv + d * r * tx, lod);
    float v2 = mAt(uv + d * r * 0.5 * tx, lod);
    m = uShift > 0.0 ? max(m, max(v1, v2)) : min(m, min(v1, v2));
  }
  return m;
}

void main() {
  vec2 op = uOrigin + gl_FragCoord.xy / uScale;
  vec3 h = uH * vec3(op, 1.0);
  vec2 uv = clamp(h.xy / h.z, 0.0, 1.0);
  vec3 c = texture(uSrc, uv).rgb;
  float m = 0.0;
  if (uHasMask == 1) {
    m = sampleMask(uv);
    if (uInvert == 1) m = 1.0 - m;
  }
  o = vec4(c, m);
}`;

export const DOWN = HEAD + `
uniform sampler2D uIn;
uniform vec2 uTexel;
void main() {
  vec4 s = texture(uIn, vUV + uTexel * vec2(-1.0, -1.0)) + texture(uIn, vUV + uTexel * vec2(1.0, -1.0))
         + texture(uIn, vUV + uTexel * vec2(-1.0, 1.0)) + texture(uIn, vUV + uTexel * vec2(1.0, 1.0));
  o = s * 0.25;
}`;

export const BLUR = HEAD + `
uniform sampler2D uIn;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  float r = min(ceil(uSigma * 3.0), 24.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int k = -24; k <= 24; k++) {
    float i = float(k);
    if (abs(i) > r) continue;
    float w = exp(-0.5 * i * i / (uSigma * uSigma));
    acc += texture(uIn, vUV + uDir * i) * w;
    ws += w;
  }
  o = acc / ws;
}`;

export const PREMULT = HEAD + `
uniform sampler2D uIn;
uniform int uHasMask;
void main() {
  vec4 a = texture(uIn, vUV);
  float w = uHasMask == 1 ? 1.0 - a.a : 1.0;
  o = vec4(a.rgb * w, w);
}`;

// Bokeh lens blur on premultiplied (rgb * w, w) data — golden-angle disc sampling.
export const LENS = HEAD + COMMON + `
uniform sampler2D uIn;
uniform vec2 uTexel;
uniform float uR;
uniform float uBoost;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  const int N = 112;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float r = uR * sqrt((fi + 0.5) / float(N));
    float a = fi * 2.39996323;
    vec4 s = texture(uIn, vUV + vec2(cos(a), sin(a)) * r * uTexel);
    vec3 col = s.a > 1e-4 ? s.rgb / s.a : vec3(0.0);
    float w = 1.0 + uBoost * 7.0 * smoothstep(0.5, 0.95, luma(col));
    acc += s * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

// Edge-preserving noise reduction (joint bilateral in a perceptual YCbCr space).
export const DENOISE = HEAD + COMMON + `
uniform sampler2D uIn;
uniform vec2 uTexel;
uniform float uRad;
uniform float uLum;
uniform float uCol;
vec3 toYCC(vec3 s) { float y = dot(s, vec3(0.299, 0.587, 0.114)); return vec3(y, (s.b - y) * 0.564, (s.r - y) * 0.713); }
vec3 fromYCC(vec3 v) { float r = v.x + 1.403 * v.z; float b = v.x + 1.773 * v.y; float g = (v.x - 0.299 * r - 0.114 * b) / 0.587; return vec3(r, g, b); }
void main() {
  vec4 C = texture(uIn, vUV);
  vec3 c0 = toYCC(L2S(C.rgb));
  float sr = mix(0.012, 0.085, uLum);
  float sc = mix(0.015, 0.16, uCol);
  float ys = 0.0, yw = 0.0, cw = 0.0;
  vec2 cs = vec2(0.0);
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 off = vec2(float(i), float(j));
      vec3 s = toYCC(L2S(texture(uIn, vUV + off * (uRad / 3.0) * uTexel).rgb));
      float ws = exp(-dot(off, off) / 9.0 * 2.0);
      float dy = s.x - c0.x;
      float wy = ws * exp(-dy * dy / (2.0 * sr * sr));
      vec2 dc = s.yz - c0.yz;
      float wc = ws * exp(-dot(dc, dc) / (2.0 * sc * sc));
      ys += s.x * wy; yw += wy;
      cs += s.yz * wc; cw += wc;
    }
  }
  float y = mix(c0.x, ys / yw, clamp(uLum * 1.6, 0.0, 1.0));
  vec2 cc = mix(c0.yz, cs / cw, clamp(uCol * 1.6, 0.0, 1.0));
  o = vec4(S2L(max(fromYCC(vec3(y, cc)), 0.0)), C.a);
}`;

// Main development pass: every tonal / colour / effect adjustment.
export const FINAL = HEAD + defines + COMMON + `
uniform sampler2D uA;
uniform sampler2D uB2;
uniform sampler2D uB3;
uniform sampler2D uLens;
uniform sampler2D uSrc;
uniform sampler2D uCurve;
uniform vec2 uASize;
uniform vec2 uPad;
uniform vec2 uOrigin;
uniform float uScale;
uniform vec4 uCrop;      // crop rect in O-space (x, y, w, h) — vignette / grain reference
uniform vec4 uCtx;       // context origin (O px) and size (O px)
uniform mat3 uH;
uniform float uP[NP];
uniform float uLS[NL];
uniform float uLB[NL];
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform int uHasMask, uLensOn, uBgMode, uCropMode, uShowMask, uClip, uBypass, uCurveOn, uHslOn, uLevelsOn, uGradeOn, uSrcAlpha;
uniform vec3 uBgColor;
uniform float uLensMix;
uniform float uSharpSigma;

float scurve(float x, float k) {
  float a = exp2(k * 1.4);
  float xc = clamp(x, 0.0, 1.0);
  float y = xc < 0.5 ? 0.5 * pow(2.0 * xc, a) : 1.0 - 0.5 * pow(2.0 * (1.0 - xc), a);
  return y + (x - xc);
}
vec3 wbGains(float t, float g) {
  vec3 k = vec3(exp2(0.6 * t + 0.2 * g), exp2(-0.4 * g), exp2(-0.6 * t + 0.2 * g));
  return k / luma(k);
}
vec3 gradeOffset(float hue) { vec3 c = hsv2rgb(vec3(hue / 360.0, 1.0, 1.0)); return c - luma(c); }
float shoulder(float x) { return x < 0.72 ? x : 0.72 + 0.28 * (1.0 - exp(-(x - 0.72) / 0.28)); }

#define LP(i) (uHasMask == 1 ? mix(uLB[i], uLS[i], m) : 0.0)

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 auv = (fc + uPad) / uASize;
  vec4 A = texture(uA, auv);
  vec3 c = A.rgb;
  float m = uHasMask == 1 ? A.a : 0.0;
  vec2 op = uOrigin + fc / uScale;
  vec3 hq = uH * vec3(op, 1.0);
  vec2 suv = hq.xy / hq.z;
  float alpha = 1.0;
  if (uCropMode == 1) {
    vec2 e = step(vec2(-0.0005), suv) * step(suv, vec2(1.0005));
    alpha = e.x * e.y;
  }
  if (uSrcAlpha == 1) alpha *= textureLod(uSrc, clamp(suv, 0.0, 1.0), 0.0).a;
  float dith = (hash2(fc + 17.0) - 0.5) / 255.0;
  if (uBypass == 1) { o = vec4(clamp(L2S(c) + dith, 0.0, 1.0), alpha); return; }

  vec2 cuv = (op - uCtx.xy) / uCtx.zw;

  float exposure = uP[P_EXPOSURE] + LP(L_EXPOSURE);
  float brill = uP[P_BRILLIANCE];
  float hl = uP[P_HIGHLIGHTS] + LP(L_HIGHLIGHTS) - brill * 0.45;
  float sh = uP[P_SHADOWS] + LP(L_SHADOWS) + brill * 0.55;
  float br = uP[P_BRIGHTNESS] + LP(L_BRIGHTNESS);
  float ct = uP[P_CONTRAST] + LP(L_CONTRAST);
  float sat = uP[P_SATURATION] + LP(L_SATURATION);
  float vib = uP[P_VIBRANCE] + LP(L_VIBRANCE) + max(brill, 0.0) * 0.1;
  float warm = uP[P_WARMTH] + LP(L_WARMTH);
  float tint = uP[P_TINT] + LP(L_TINT);
  float defn = uP[P_DEFINITION] + LP(L_DEFINITION) + brill * 0.3;
  float sharp = uP[P_SHARPNESS] + LP(L_SHARPNESS);
  float glow = uP[P_GLOW] + LP(L_GLOW);

  // ---- background lens blur
  float detailKeep = 1.0;
  if (uLensOn == 1) {
    vec4 L = texture(uLens, cuv);
    vec3 lb = L.a > 0.002 ? L.rgb / L.a : c;
    float bw = 1.0 - m;
    c = mix(c, lb, bw);
    detailKeep = 1.0 - bw * uLensMix;
  }

  // ---- sharpening (unsharp mask on perceptual luminance)
  if (sharp > 0.001 && uSharpSigma > 0.0) {
    vec2 tx = 1.0 / uASize;
    float s = uSharpSigma;
    vec3 b = A.rgb * 0.25;
    b += (texture(uA, auv + vec2(s, 0.0) * tx).rgb + texture(uA, auv - vec2(s, 0.0) * tx).rgb
        + texture(uA, auv + vec2(0.0, s) * tx).rgb + texture(uA, auv - vec2(0.0, s) * tx).rgb) * 0.125;
    b += (texture(uA, auv + vec2(s, s) * tx).rgb + texture(uA, auv + vec2(-s, s) * tx).rgb
        + texture(uA, auv + vec2(s, -s) * tx).rgb + texture(uA, auv - vec2(s, s) * tx).rgb) * 0.0625;
    float d = l2s(luma(A.rgb)) - l2s(luma(b));
    d *= smoothstep(0.003, 0.018, abs(d));
    float lp = l2s(luma(c));
    float lp2 = lp + d * sharp * 2.6 * detailKeep;
    c *= clamp(s2l(max(lp2, 0.0)) / max(s2l(lp), 1e-4), 0.0, 4.0);
  }

  // ---- white balance + exposure (linear light)
  vec3 b2 = texture(uB2, cuv).rgb;
  vec3 b3 = texture(uB3, cuv).rgb;
  vec3 gains = wbGains(warm, tint) * exp2(exposure);
  c *= gains; b2 *= gains; b3 *= gains;

  // ---- dehaze (dark-channel estimate from the large-scale context)
  float dz = uP[P_DEHAZE];
  if (dz > 0.0) {
    float dark = clamp(min(min(b3.r, b3.g), b3.b), 0.0, 1.0);
    float t = max(1.0 - dz * 0.9 * dark, 0.25);
    float k = 0.92 * (1.0 - t);
    c = max((c - k) / t, 0.0); b2 = max((b2 - k) / t, 0.0); b3 = max((b3 - k) / t, 0.0);
    vib += dz * 0.15;
  } else if (dz < 0.0) {
    float k = -dz * 0.5;
    vec3 haze = vec3(luma(b3) * 0.45 + 0.42);
    c = mix(c, haze, k); b2 = mix(b2, haze, k); b3 = mix(b3, haze, k);
  }

  // ---- local tone mapping: shadows / highlights (adaptive)
  float Lp = l2s(luma(c));
  float Lm = l2s(luma(b2));
  float Lb = l2s(luma(b3));
  if (sh != 0.0 || hl != 0.0) {
    float base = clamp(mix(Lp, mix(Lm, Lb, 0.5), 0.7), 0.0, 1.5);
    float wS = 1.0 - smoothstep(0.0, 0.62, base); wS *= wS;
    float wH = smoothstep(0.36, 1.0, base);
    float g = exp2(sh * 1.8 * wS + hl * 1.5 * wH);
    c *= g; b2 *= g;
    Lp = l2s(luma(c)); Lm = l2s(luma(b2));
  }

  // ---- definition (mid-frequency local contrast)
  if (defn != 0.0) {
    float d = Lp - Lm;
    float midW = 1.0 - pow(abs(2.0 * clamp(Lp, 0.0, 1.0) - 1.0), 2.0);
    float Lp2 = Lp + defn * d * 1.5 * (0.35 + 0.65 * midW) * detailKeep;
    c *= clamp(s2l(max(Lp2, 0.0)) / max(s2l(Lp), 1e-4), 0.0, 8.0);
  }

  // ---- perceptual space
  vec3 p = L2S(c);
  float shK = clamp(max(exposure, 0.0) * 0.6 + max(hl, 0.0) * 0.4 + max(sh, 0.0) * 0.15, 0.0, 1.0);
  if (shK > 0.0) p = mix(p, vec3(shoulder(p.r), shoulder(p.g), shoulder(p.b)), shK);

  if (br != 0.0) p = pow(max(p, 0.0), vec3(exp2(-br * 0.85)));
  if (ct != 0.0) p = vec3(scurve(p.r, ct), scurve(p.g, ct), scurve(p.b, ct));

  float bp = uP[P_BLACKPOINT];
  if (bp > 0.0) { float k = bp * 0.22; p = (p - k) / (1.0 - k); }
  else if (bp < 0.0) { float k = -bp * 0.18; p = p * (1.0 - k) + k; }

  float wh = uP[P_WHITES];
  if (wh != 0.0) { float L = luma(clamp(p, 0.0, 1.0)); p *= 1.0 + wh * 0.38 * smoothstep(0.25, 1.0, L); }

  if (uLevelsOn == 1) {
    float ib = uP[P_LVINBLACK], iw = uP[P_LVINWHITE], gm = uP[P_LVGAMMA], ob = uP[P_LVOUTBLACK], ow = uP[P_LVOUTWHITE];
    p = clamp((p - ib) / max(iw - ib, 1e-3), 0.0, 1.0);
    p = pow(p, vec3(1.0 / gm));
    p = ob + p * (ow - ob);
  }

  if (uCurveOn == 1) {
    vec3 q = clamp(p, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    p = vec3(texture(uCurve, vec2(q.r, 0.5)).r, texture(uCurve, vec2(q.g, 0.5)).g, texture(uCurve, vec2(q.b, 0.5)).b);
  }

  // ---- selective colour (HSL by hue band)
  if (uHslOn == 1) {
    vec3 hsv = rgb2hsv(clamp(p, 0.0, 1.0));
    float hd = hsv.x * 360.0;
    float C[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 225.0, 270.0, 315.0, 360.0);
    int i0 = 7; float t = 0.0;
    for (int i = 0; i < 8; i++) {
      if (hd >= C[i] && hd < C[i + 1]) { i0 = i; t = (hd - C[i]) / (C[i + 1] - C[i]); }
    }
    int i1 = (i0 + 1) % 8;
    t = smoothstep(0.0, 1.0, t);
    float dH = mix(uHslH[i0], uHslH[i1], t);
    float dS = mix(uHslS[i0], uHslS[i1], t);
    float dL = mix(uHslL[i0], uHslL[i1], t);
    float w = smoothstep(0.03, 0.22, hsv.y);
    hsv.x = fract(hsv.x + dH * w * (32.0 / 360.0) + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + dS * w), 0.0, 1.0);
    vec3 np = hsv2rgb(hsv);
    np *= 1.0 + dL * w * 0.55;
    p = np;
  }

  // ---- saturation / vibrance
  {
    float L = luma(p);
    if (sat != 0.0) p = mix(vec3(L), p, 1.0 + sat);
    if (vib != 0.0) {
      vec3 pc = clamp(p, 0.0, 1.0);
      float mx = max(pc.r, max(pc.g, pc.b)), mn = min(pc.r, min(pc.g, pc.b));
      float s = (mx - mn) / max(mx, 1e-4);
      float h = rgb2hsv(pc).x;
      float skin = smoothstep(0.0, 0.03, h) * (1.0 - smoothstep(0.1, 0.15, h)) * smoothstep(0.1, 0.25, s) * (1.0 - smoothstep(0.55, 0.8, s));
      float amt = vib > 0.0 ? vib * (1.0 - s) * (1.0 - 0.7 * skin) * 1.5 : vib;
      p = mix(vec3(L), p, 1.0 + amt);
    }
  }

  // ---- black & white
  float bwI = uP[P_BWINTENSITY];
  if (bwI > 0.0) {
    float g = clamp(dot(clamp(p, 0.0, 1.0), vec3(0.30, 0.59, 0.11)), 0.0, 1.0);
    float nn = uP[P_BWNEUTRALS], tn = uP[P_BWTONE];
    if (nn != 0.0) g = pow(g, exp2(-nn * 0.8));
    if (tn != 0.0) g = scurve(g, tn);
    p = mix(p, vec3(g), bwI);
  }

  // ---- colour grading (split toning)
  if (uGradeOn == 1) {
    float L = clamp(luma(p), 0.0, 1.0);
    float pivot = clamp(0.5 - uP[P_GBALANCE] * 0.25, 0.2, 0.8);
    float wS = 1.0 - smoothstep(0.0, pivot, L);
    float wH = smoothstep(pivot, 1.0, L);
    float wM = max(1.0 - wS - wH, 0.0);
    p += gradeOffset(uP[P_GSHUE]) * uP[P_GSSAT] * 0.32 * wS
       + gradeOffset(uP[P_GMHUE]) * uP[P_GMSAT] * 0.26 * wM
       + gradeOffset(uP[P_GHHUE]) * uP[P_GHSAT] * 0.26 * wH;
  }

  float fd = uP[P_FADE];
  if (fd > 0.0) p = mix(p, p * 0.8 + 0.11, fd);

  if (glow > 0.0) {
    vec3 gs = L2S(mix(b2, b3, 0.35));
    vec3 bright = clamp((gs - 0.42) / 0.58, 0.0, 1.0);
    vec3 add = clamp(bright * bright * glow * 1.1, 0.0, 1.0);
    p = 1.0 - (1.0 - clamp(p, 0.0, 1.0)) * (1.0 - add);
    p = mix(p, max(p, gs), glow * 0.2);
  }

  // ---- vignette (relative to crop)
  float va = uP[P_VIGAMOUNT];
  if (va != 0.0) {
    vec2 n = (op - uCrop.xy) / uCrop.zw - 0.5;
    float ar = uCrop.z / uCrop.w;
    float rnd = uP[P_VIGROUNDNESS];
    vec2 sc = ar > 1.0 ? vec2(mix(1.0, ar, rnd), 1.0) : vec2(1.0, mix(1.0, 1.0 / ar, rnd));
    float r = length(n * 2.0 * sc) / length(sc);
    float rad = mix(0.15, 1.05, uP[P_VIGRADIUS]);
    float soft = uP[P_VIGSOFTNESS];
    float v = smoothstep(rad * (1.0 - soft * 0.9), rad + 0.04 + soft * 0.35, r);
    if (va > 0.0) p *= 1.0 - va * v * 0.95;
    else p = mix(p, vec3(1.0), -va * v * 0.85);
  }

  // ---- film grain (resolution independent)
  float gr = uP[P_GRAIN] + uP[P_BWGRAIN];
  if (gr > 0.0) {
    float longSide = max(uCrop.z, uCrop.w);
    float cell = mix(0.55, 3.6, uP[P_GRAINSIZE]) * max(longSide / 3000.0, 0.3);
    vec2 gp = op / cell;
    float nz = vnoise(gp) * 0.62 + vnoise(gp * 2.13 + 31.7) * 0.38 - 0.5;
    float L = clamp(luma(p), 0.0, 1.0);
    p += nz * gr * 0.34 * (0.3 + 0.7 * (1.0 - pow(abs(2.0 * L - 1.0), 2.0)));
  }

  // ---- background replacement
  if (uHasMask == 1 && uBgMode == 2) p = mix(uBgColor, clamp(p, 0.0, 1.0), m);
  if (uHasMask == 1 && uBgMode == 1) alpha *= m;

  if (uShowMask == 1 && uHasMask == 1) p = mix(clamp(p, 0.0, 1.0), vec3(0.9, 0.2, 0.11), m * 0.52); // rubylith
  if (uShowMask == 2) { p = vec3(m); alpha = uCropMode == 1 ? alpha : 1.0; }

  if (uClip == 1) {
    float mx = max(p.r, max(p.g, p.b));
    if (mx >= 0.998) p = vec3(1.0, 0.1, 0.3);
    else if (mx <= 0.004) p = vec3(0.15, 0.4, 1.0);
  }
  o = vec4(clamp(p + dith, 0.0, 1.0), alpha);
}`;

// Present a rendered tile on the screen (flips rows, draws transparency checkerboard).
export const BLIT = HEAD + `
uniform sampler2D uTex;
uniform int uChecker;
uniform vec3 uBg;
void main() {
  vec4 c = texture(uTex, vec2(vUV.x, 1.0 - vUV.y));
  vec3 under = uBg;
  if (uChecker == 1) {
    vec2 cell = floor(gl_FragCoord.xy / 9.0);
    under = mix(vec3(0.24), vec3(0.17), mod(cell.x + cell.y, 2.0));
  }
  o = vec4(mix(under, c.rgb, c.a), 1.0);
}`;
