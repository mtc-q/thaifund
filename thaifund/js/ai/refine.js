// Mask refinement: edge-aware guided filtering, connected components, resampling.

export function resizeBilinear(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** Mean filter with a (2r+1)² window, clipped at borders. O(N) via running sums. */
export function boxMean(src, w, h, r, out) {
  const tmp = new Float32Array(w * h);
  out = out || new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= r && x < w; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x > 0) { const add = x + r, sub = x - r - 1; if (add < w) sum += src[row + add]; if (sub >= 0) sum -= src[row + sub]; }
      tmp[row + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= r && y < h; y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y > 0) { const add = y + r, sub = y - r - 1; if (add < h) sum += tmp[add * w + x]; if (sub >= 0) sum -= tmp[sub * w + x]; }
      out[y * w + x] = sum / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    }
  }
  return out;
}

function downBox(src, w, h, s) {
  const ws = Math.ceil(w / s), hs = Math.ceil(h / s), out = new Float32Array(ws * hs);
  for (let y = 0; y < hs; y++) for (let x = 0; x < ws; x++) {
    let sum = 0, n = 0;
    for (let j = 0; j < s; j++) { const yy = y * s + j; if (yy >= h) break; for (let i = 0; i < s; i++) { const xx = x * s + i; if (xx >= w) break; sum += src[yy * w + xx]; n++; } }
    out[y * ws + x] = sum / n;
  }
  return out;
}
const mul = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i]; return o; };

/**
 * Precomputes the guide-image terms of a colour guided filter (He et al.), evaluated on a
 * subsampled grid ("fast guided filter") and applied at full resolution.
 */
export function makeGuide(rgba, w, h, radius, eps, s = 2) {
  const n = w * h, Ir = new Float32Array(n), Ig = new Float32Array(n), Ib = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ir[i] = rgba[i * 4] / 255; Ig[i] = rgba[i * 4 + 1] / 255; Ib[i] = rgba[i * 4 + 2] / 255; }
  const ws = Math.ceil(w / s), hs = Math.ceil(h / s), r = Math.max(1, Math.round(radius / s));
  const lr = downBox(Ir, w, h, s), lg = downBox(Ig, w, h, s), lb = downBox(Ib, w, h, s);
  const mr = boxMean(lr, ws, hs, r), mg = boxMean(lg, ws, hs, r), mb = boxMean(lb, ws, hs, r);
  const vrr = boxMean(mul(lr, lr), ws, hs, r), vrg = boxMean(mul(lr, lg), ws, hs, r), vrb = boxMean(mul(lr, lb), ws, hs, r);
  const vgg = boxMean(mul(lg, lg), ws, hs, r), vgb = boxMean(mul(lg, lb), ws, hs, r), vbb = boxMean(mul(lb, lb), ws, hs, r);
  const m = ws * hs;
  const inv = Array.from({ length: 6 }, () => new Float32Array(m));
  for (let i = 0; i < m; i++) {
    const a = vrr[i] - mr[i] * mr[i] + eps, b = vrg[i] - mr[i] * mg[i], c = vrb[i] - mr[i] * mb[i];
    const d = vgg[i] - mg[i] * mg[i] + eps, e = vgb[i] - mg[i] * mb[i], f = vbb[i] - mb[i] * mb[i] + eps;
    const A = d * f - e * e, B = c * e - b * f, C = b * e - c * d;
    const det = a * A + b * B + c * C;
    const k = 1 / det;
    inv[0][i] = A * k; inv[1][i] = B * k; inv[2][i] = C * k;
    inv[3][i] = (a * f - c * c) * k; inv[4][i] = (b * c - a * e) * k; inv[5][i] = (a * d - b * b) * k;
  }
  return { w, h, ws, hs, s, r, Ir, Ig, Ib, lr, lg, lb, mr, mg, mb, inv };
}

export function guidedFilter(G, p) {
  const { w, h, ws, hs, s, r, lr, lg, lb, mr, mg, mb, inv } = G;
  const ps = downBox(p, w, h, s);
  const mp = boxMean(ps, ws, hs, r);
  const cr = boxMean(mul(lr, ps), ws, hs, r), cg = boxMean(mul(lg, ps), ws, hs, r), cb = boxMean(mul(lb, ps), ws, hs, r);
  const m = ws * hs;
  const ar = new Float32Array(m), ag = new Float32Array(m), ab = new Float32Array(m), bb = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const vr = cr[i] - mr[i] * mp[i], vg = cg[i] - mg[i] * mp[i], vb = cb[i] - mb[i] * mp[i];
    ar[i] = inv[0][i] * vr + inv[1][i] * vg + inv[2][i] * vb;
    ag[i] = inv[1][i] * vr + inv[3][i] * vg + inv[4][i] * vb;
    ab[i] = inv[2][i] * vr + inv[4][i] * vg + inv[5][i] * vb;
    bb[i] = mp[i] - ar[i] * mr[i] - ag[i] * mg[i] - ab[i] * mb[i];
  }
  const Ar = resizeBilinear(boxMean(ar, ws, hs, r), ws, hs, w, h);
  const Ag = resizeBilinear(boxMean(ag, ws, hs, r), ws, hs, w, h);
  const Ab = resizeBilinear(boxMean(ab, ws, hs, r), ws, hs, w, h);
  const Bb = resizeBilinear(boxMean(bb, ws, hs, r), ws, hs, w, h);
  const q = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) q[i] = Math.max(0, Math.min(1, Ar[i] * G.Ir[i] + Ag[i] * G.Ig[i] + Ab[i] * G.Ib[i] + Bb[i]));
  return q;
}

/**
 * Edge refinement of a probability map. Coarse maps (low-res semantic models) get a wide
 * edge-snapping pass first; crisp maps (portrait / tap models) only get the fine pass.
 */
export function refineMask(guides, prob, crisp = false) {
  const n = prob.length, p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = Math.max(0, Math.min(1, (prob[i] - 0.5) * (crisp ? 1.6 : 2.2) + 0.5));
  let q = p;
  if (!crisp) {
    q = guidedFilter(guides.coarse, p);
    for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(1, (q[i] - 0.5) * 1.6 + 0.5));
  }
  q = guidedFilter(guides.fine, q);
  for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(1, (q[i] - 0.06) / 0.88)); q[i] = v * v * (3 - 2 * v); }
  return q;
}

/** 4-connected components of a binary map. */
export function components(bin, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || labels[start] >= 0) continue;
    const id = comps.length;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = start; labels[start] = id;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && bin[i - 1] && labels[i - 1] < 0) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && bin[i + 1] && labels[i + 1] < 0) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && bin[i - w] && labels[i - w] < 0) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && bin[i + w] && labels[i + w] < 0) { labels[i + w] = id; stack[sp++] = i + w; }
    }
    comps.push({ id, area, cx: sx / area, cy: sy / area, x0, y0, x1, y1 });
  }
  return { labels, comps };
}

/** Soft region: dilate by r then feather by r/2 (avoids box-shaped cut-offs). */
export function softRegion(bin, w, h, r) {
  return boxMean(dilate(bin, w, h, r), w, h, Math.max(1, Math.round(r / 2)));
}

/** Binary dilation by radius r (square window), returned as 0/1 floats. */
export function dilate(bin, w, h, r) {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = bin[i] ? 1 : 0;
  const m = boxMean(f, w, h, r);
  for (let i = 0; i < m.length; i++) m[i] = m[i] > 1e-4 ? 1 : 0;
  return m;
}
