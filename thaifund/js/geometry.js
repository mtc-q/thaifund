// Geometry: orientation, straighten, perspective and crop math.
//
// Spaces:
//   source px   – pixels of the decoded image
//   q-space     – oriented, perspective-corrected, straightened image; origin at the image centre.
//                 The crop rectangle is axis-aligned in q-space.
//   O-space     – pixels of the current "frame" (normally the crop); O = q - frame.xy

export const M3 = {
  id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
  },
  inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const s = 1 / (a * A + b * B + c * C);
    return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
      B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
      C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
  },
  apply(m, x, y) {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  },
  translate: (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1],
  scale: (x, y) => [x, 0, 0, 0, y, 0, 0, 0, 1],
  rotate(rad) { const c = Math.cos(rad), s = Math.sin(rad); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
  toGL: m => new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]),
};

const PERSP = 0.35; // max keystone strength

export function orientedSize(W, H, rot) { return rot % 2 ? [H, W] : [W, H]; }

function orientMatrix(W, H, rot, flipH, flipV) {
  let m = M3.id(), w = W, h = H;
  if (flipH) m = M3.mul([-1, 0, W, 0, 1, 0, 0, 0, 1], m);
  if (flipV) m = M3.mul([1, 0, 0, 0, -1, H, 0, 0, 1], m);
  for (let k = 0; k < rot; k++) { m = M3.mul([0, -1, h, 1, 0, 0, 0, 0, 1], m); [w, h] = [h, w]; }
  return { m, w, h };
}

/** Builds every mapping for a source of W×H and a geometry state. */
export function buildGeometry(W, H, g) {
  const o = orientMatrix(W, H, g.rot, g.flipH, g.flipV);
  const Wo = o.w, Ho = o.h;
  const a = -(g.perspH / 100) * PERSP / (Wo / 2);
  const b = (g.perspV / 100) * PERSP / (Ho / 2);
  const K = [1, 0, 0, 0, 1, 0, a, b, 1];
  const R = M3.rotate(g.angle * Math.PI / 180);
  const qFromSrc = M3.mul(R, M3.mul(K, M3.mul(M3.translate(-Wo / 2, -Ho / 2), o.m)));
  const srcFromQ = M3.inv(qFromSrc);
  const uvFromQ = M3.mul(M3.scale(1 / W, 1 / H), srcFromQ);
  const poly = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => M3.apply(qFromSrc, x, y));
  return { W, H, Wo, Ho, qFromSrc, srcFromQ, uvFromQ, poly };
}

/** O-space px → source uv, for a frame rect in q-space. */
export function uvFromO(geom, frame) { return M3.mul(geom.uvFromQ, M3.translate(frame.x, frame.y)); }

// ---------- polygon helpers ----------
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}
export function inPoly(poly, x, y, tol = 0.02) {
  const o = Math.sign(polyArea(poly)) || 1;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const ex = x2 - x1, ey = y2 - y1, len = Math.hypot(ex, ey) || 1;
    if (((ex * (y - y1) - ey * (x - x1)) / len) * o < -tol) return false;
  }
  return true;
}
export function rectInPoly(poly, r) {
  return inPoly(poly, r.x, r.y) && inPoly(poly, r.x + r.w, r.y) && inPoly(poly, r.x + r.w, r.y + r.h) && inPoly(poly, r.x, r.y + r.h);
}
export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
export function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}
const rc = (cx, cy, w, h) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

/** Shrinks a rect about its centre (moving the centre inward if needed) until it fits. */
export function fitRectInPoly(poly, r) {
  if (rectInPoly(poly, r)) return { ...r };
  let cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (!inPoly(poly, cx, cy, -0.5)) {
    const [px, py] = centroid(poly);
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; inPoly(poly, lerp(cx, px, m), lerp(cy, py, m), -0.5) ? (hi = m) : (lo = m); }
    const t = Math.min(1, hi + 0.05);
    cx = lerp(cx, px, t); cy = lerp(cy, py, t);
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; rectInPoly(poly, rc(cx, cy, r.w * m, r.h * m)) ? (lo = m) : (hi = m); }
  return rc(cx, cy, r.w * lo, r.h * lo);
}

/** Largest rect with aspect ratio `ratio` centred near (cx, cy) inside poly. */
export function maxRectWithRatio(poly, cx, cy, ratio) {
  if (!inPoly(poly, cx, cy, -0.5)) [cx, cy] = centroid(poly);
  const bb = bbox(poly);
  let lo = 0, hi = Math.hypot(bb.w, bb.h);
  for (let i = 0; i < 44; i++) { const m = (lo + hi) / 2; rectInPoly(poly, rc(cx, cy, m * ratio, m)) ? (lo = m) : (hi = m); }
  // Try sliding the centre towards the centroid for a bigger fit.
  const [px, py] = centroid(poly);
  let best = { cx, cy, h: lo };
  for (let k = 1; k <= 8; k++) {
    const t = k / 8, x = lerp(cx, px, t), y = lerp(cy, py, t);
    let a = best.h, b = Math.hypot(bb.w, bb.h);
    if (!rectInPoly(poly, rc(x, y, a * ratio, a))) continue;
    for (let i = 0; i < 30; i++) { const m = (a + b) / 2; rectInPoly(poly, rc(x, y, m * ratio, m)) ? (a = m) : (b = m); }
    if (a > best.h * 1.01) best = { cx: x, cy: y, h: a };
  }
  return rc(best.cx, best.cy, best.h * ratio, best.h);
}

/** Moves from a valid rect towards a target rect as far as possible while staying inside poly. */
export function constrainRect(poly, prev, next, separateAxes = true) {
  if (rectInPoly(poly, next)) return next;
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; rectInPoly(poly, lerpRect(prev, next, m)) ? (lo = m) : (hi = m); }
  let r = lerpRect(prev, next, lo);
  if (!separateAxes) return r;
  // Let the remaining motion slide along each axis independently.
  for (const axis of ['x', 'y']) {
    const tgt = { ...r };
    if (axis === 'x') { tgt.x = next.x; tgt.w = next.w; } else { tgt.y = next.y; tgt.h = next.h; }
    let a = 0, b = 1;
    for (let i = 0; i < 24; i++) { const m = (a + b) / 2; rectInPoly(poly, lerpRect(r, tgt, m)) ? (a = m) : (b = m); }
    r = lerpRect(r, tgt, a);
  }
  return r;
}

// ---------- geometry state transforms (screen-space operations) ----------
export function rotateGeoCW(g) {
  const c = g.crop;
  return { ...g, rot: (g.rot + 1) % 4, perspV: -g.perspH, perspH: g.perspV, crop: { x: -(c.y + c.h), y: c.x, w: c.h, h: c.w }, portrait: !g.portrait };
}
export function rotateGeoCCW(g) { return rotateGeoCW(rotateGeoCW(rotateGeoCW(g))); }
export function flipGeoH(g) {
  const c = g.crop, odd = g.rot % 2 === 1;
  return { ...g, flipH: odd ? g.flipH : !g.flipH, flipV: odd ? !g.flipV : g.flipV, angle: -g.angle, perspH: -g.perspH, crop: { ...c, x: -(c.x + c.w) } };
}
export function flipGeoV(g) {
  const c = g.crop, odd = g.rot % 2 === 1;
  return { ...g, flipH: odd ? !g.flipH : g.flipH, flipV: odd ? g.flipV : !g.flipV, angle: -g.angle, perspV: -g.perspV, crop: { ...c, y: -(c.y + c.h) } };
}

/** Aspect ratio (w/h) for the current geometry, or 0 for free. */
export function aspectRatio(g, Wo, Ho, ASPECTS) {
  const a = ASPECTS.find(x => x.id === g.aspect);
  if (!a || a.r === 0) return 0;
  let r = a.r === -1 ? Wo / Ho : a.r === -2 ? (g.custom[0] / g.custom[1]) : a.r;
  if (a.r > 0 && a.r !== 1 && g.portrait) r = 1 / r;
  return r;
}
