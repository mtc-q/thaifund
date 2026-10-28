// Turns editor state into GPU uniforms (effective values after section bypass + looks).
import { GLOBAL_PARAMS, LOCAL_PARAMS, LOOKS, HUE_PARAMS, SECTIONS } from './schema.js';

const sectionOf = {};
for (const s of SECTIONS) for (const id of s.params) sectionOf[id] = s.id;

export function effectiveParams(state, lookOverride) {
  const look = LOOKS.find(l => l.id === (lookOverride ?? state.look.id));
  const amt = lookOverride ? 1 : (state.look.amount ?? 100) / 100;
  const out = {};
  for (const p of GLOBAL_PARAMS) {
    let v = state.bypass[sectionOf[p.id]] ? p.def : state.p[p.id];
    const lv = look && look.p[p.id];
    if (lv !== undefined) {
      if (HUE_PARAMS.has(p.id)) {
        const satId = p.id.replace('Hue', 'Sat');
        if (!state.p[satId] || state.bypass.grading) v = lv;
      } else v += lv * amt;
    }
    out[p.id] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function isIdentityCurve(pts) {
  return pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}
export function curvesActive(state) {
  if (state.bypass.curves) return false;
  const c = state.curves;
  return !(isIdentityCurve(c.rgb) && isIdentityCurve(c.r) && isIdentityCurve(c.g) && isIdentityCurve(c.b));
}

/** Monotone cubic (Fritsch–Carlson) interpolation through control points. */
export function curveFn(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  if (n === 1) return () => ys[0];
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export function buildCurveLUT(curves) {
  const M = curveFn(curves.rgb), R = curveFn(curves.r), G = curveFn(curves.g), B = curveFn(curves.b);
  const lut = new Uint8Array(256 * 4);
  const c = v => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < 256; i++) {
    const m = Math.max(0, Math.min(1, M(i / 255)));
    lut[i * 4] = c(R(m)); lut[i * 4 + 1] = c(G(m)); lut[i * 4 + 2] = c(B(m)); lut[i * 4 + 3] = 255;
  }
  return lut;
}

export function buildUniforms(state, hasMask, lookOverride) {
  const e = effectiveParams(state, lookOverride);
  const P = new Float32Array(GLOBAL_PARAMS.length);
  GLOBAL_PARAMS.forEach((p, i) => { P[i] = e[p.id] * p.scale; });
  const LS = new Float32Array(LOCAL_PARAMS.length), LB = new Float32Array(LOCAL_PARAMS.length);
  LOCAL_PARAMS.forEach((p, i) => { LS[i] = state.local.subject[p.id] * p.scale; LB[i] = state.local.background[p.id] * p.scale; });
  const off = !!state.bypass.hsl;
  const hslH = Float32Array.from(state.hsl.h, v => (off ? 0 : v / 100));
  const hslS = Float32Array.from(state.hsl.s, v => (off ? 0 : v / 100));
  const hslL = Float32Array.from(state.hsl.l, v => (off ? 0 : v / 100));
  const hslOn = !off && [...state.hsl.h, ...state.hsl.s, ...state.hsl.l].some(v => v !== 0);
  const bg = state.local.background, sj = state.local.subject;
  return {
    P, LS, LB, hslH, hslS, hslL, hslOn,
    levelsOn: e.lvInBlack !== 0 || e.lvInWhite !== 255 || e.lvGamma !== 1 || e.lvOutBlack !== 0 || e.lvOutWhite !== 255,
    gradeOn: e.gsSat > 0 || e.gmSat > 0 || e.ghSat > 0,
    curveOn: curvesActive(state),
    sharpOn: e.sharpness > 0 || (hasMask && (sj.sharpness > 0 || bg.sharpness > 0)),
    sharpRadius: e.sharpRadius,
    nrOn: e.noise > 0 || e.colorNoise > 0, nrLum: e.noise / 100, nrCol: e.colorNoise / 100,
    bgMode: hasMask ? ({ keep: 0, transparent: 1, color: 2 })[state.bg.mode] : 0,
    bgColor: hexToRgb(state.bg.color),
    lensAmount: hasMask ? bg.blur / 100 : 0, lensBoost: bg.bokeh / 100,
  };
}
