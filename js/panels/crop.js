// Crop & straighten: panel controls + on-canvas crop tool.
import { ASPECTS, OVERLAYS, defaultGeo } from '../schema.js';
import { store, clone } from '../store.js';
import { app } from '../app.js';
import { h, icon, toast } from '../ui/kit.js';
import { makeSection } from '../ui/section.js';
import { buildGeometry, fitRectInPoly, maxRectWithRatio, constrainRect, rectInPoly, rotateGeoCW, rotateGeoCCW, flipGeoH, flipGeoV, aspectRatio } from '../geometry.js';
import { autoStraighten } from '../analysis.js';

const MIN = 16;
let session = null;       // { startGeo }
let drag = null;          // active crop interaction
let overlay = 'thirds', spiralRot = 0;
let aspectBtns = [], dials = {}, sizeW, sizeH, customRow, customW, customH, portraitBtn;

const geo = () => store.state.geo;
const geomFor = g => buildGeometry(app.doc.W, app.doc.H, g);
const ratioOf = g => { const gm = geomFor(g); return aspectRatio(g, gm.Wo, gm.Ho, ASPECTS); };

// ---------- mode ----------
export function enterCrop() {
  if (!app.doc || app.cropMode) return;
  session = { startGeo: clone(geo()) };
  app.cropMode = true;
  app.fitView();
  app.emit('cropmode', true);
  syncPanel();
}
export function exitCrop(apply = true) {
  if (!app.cropMode) return;
  if (!apply && session) {
    store.set(st => { st.geo = clone(session.startGeo); }, 'geo');
    store.commit('Cancel Crop');
  }
  session = null; drag = null;
  app.cropMode = false;
  app.fitView();
  app.emit('cropmode', false);
}

/** Applies a geometry transform and re-fits the crop when the image outline changed. */
function updateGeo(mutate, label, base) {
  store.set(st => {
    const g = clone(st.geo);
    mutate(g);
    const gm = geomFor(g);
    const r = aspectRatio(g, gm.Wo, gm.Ho, ASPECTS);
    if (g.cropAuto !== false) {
      const ratio = r || (base || g.crop).w / (base || g.crop).h;
      g.crop = maxRectWithRatio(gm.poly, 0, 0, ratio);
    } else if (!rectInPoly(gm.poly, base || g.crop)) {
      g.crop = fitRectInPoly(gm.poly, base || g.crop);
    } else if (base) g.crop = { ...base };
    st.geo = g;
  }, 'geo');
  syncPanel();
  if (label) store.commit(label);
}

export function setAspect(id) {
  store.set(st => {
    const g = st.geo;
    g.aspect = id;
    const gm = geomFor(g);
    const r = aspectRatio(g, gm.Wo, gm.Ho, ASPECTS);
    if (r) {
      const c = g.crop;
      g.crop = maxRectWithRatio(gm.poly, c.x + c.w / 2, c.y + c.h / 2, r);
      g.cropAuto = Math.abs(c.x + c.w / 2) < 1 && Math.abs(c.y + c.h / 2) < 1;
    }
  }, 'geo');
  syncPanel();
  store.commit('Aspect ' + (ASPECTS.find(a => a.id === id)?.label || id));
}
export function swapOrientation() {
  store.set(st => { st.geo.portrait = !st.geo.portrait; if (st.geo.aspect === 'custom') st.geo.custom = [st.geo.custom[1], st.geo.custom[0]]; }, 'geo');
  const g = geo();
  if (g.aspect === 'free') {
    store.set(st => { const c = st.geo.crop, gm = geomFor(st.geo); st.geo.crop = maxRectWithRatio(gm.poly, c.x + c.w / 2, c.y + c.h / 2, c.h / c.w); }, 'geo');
    syncPanel(); store.commit('Swap Orientation');
  } else setAspect(g.aspect);
}
export function rotate90(cw = true) { updateGeo(g => Object.assign(g, cw ? rotateGeoCW(g) : rotateGeoCCW(g)), cw ? 'Rotate Right' : 'Rotate Left'); app.fitView(); }
export function flip(horizontal = true) { updateGeo(g => Object.assign(g, horizontal ? flipGeoH(g) : flipGeoV(g)), horizontal ? 'Flip Horizontal' : 'Flip Vertical'); }
export function resetGeo() {
  store.set(st => { st.geo = { ...defaultGeo(app.doc.W, app.doc.H), cropAuto: true }; }, 'geo');
  syncPanel(); app.fitView(); store.commit('Reset Crop');
}
export function cycleOverlay(back = false) {
  const i = OVERLAYS.findIndex(o => o.id === overlay);
  overlay = OVERLAYS[(i + (back ? -1 : 1) + OVERLAYS.length) % OVERLAYS.length].id;
  syncPanel(); app.requestRender();
  return OVERLAYS.find(o => o.id === overlay).label;
}
export function rotateOverlay() { spiralRot = (spiralRot + 1) % 8; app.requestRender(); }
export function autoStraightenNow() {
  const a = autoStraighten(app.doc.proxy, geo());
  if (a === null) { toast('No strong horizon or vertical lines found.', 'info'); return; }
  const base = clone(geo().crop);
  updateGeo(g => { g.angle = Math.max(-45, Math.min(45, a)); }, 'Auto Straighten', geo().cropAuto === false ? base : null);
  toast(`Straightened by ${a.toFixed(1)}°`, 'ok', 2200);
}

// ---------- on-canvas tool ----------
function cropScreen() {
  const c = geo().crop;
  const [x0, y0] = app.qToScreen(c.x, c.y), [x1, y1] = app.qToScreen(c.x + c.w, c.y + c.h);
  return { x0, y0, x1, y1 };
}
export function cropHit(sx, sy) {
  const r = cropScreen(), t = 16 * app.dpr;
  const nearL = Math.abs(sx - r.x0) < t, nearR = Math.abs(sx - r.x1) < t, nearT = Math.abs(sy - r.y0) < t, nearB = Math.abs(sy - r.y1) < t;
  const inX = sx > r.x0 - t && sx < r.x1 + t, inY = sy > r.y0 - t && sy < r.y1 + t;
  if (nearT && nearL) return 'nw'; if (nearT && nearR) return 'ne'; if (nearB && nearL) return 'sw'; if (nearB && nearR) return 'se';
  if (nearT && inX) return 'n'; if (nearB && inX) return 's'; if (nearL && inY) return 'w'; if (nearR && inY) return 'e';
  if (sx > r.x0 && sx < r.x1 && sy > r.y0 && sy < r.y1) return 'move';
  return 'rotate';
}
export function cropCursor(hit) {
  return { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew', move: 'move', rotate: 'rotate' }[hit] || 'default';
}

export function cropDown(sx, sy) {
  const hit = cropHit(sx, sy);
  const [qx, qy] = app.screenToQ(sx, sy);
  const c = geo().crop;
  drag = { hit, qx, qy, crop: { ...c }, angle: geo().angle, ratio: ratioOf(geo()) };
  if (hit === 'rotate') {
    drag.cx = c.x + c.w / 2; drag.cy = c.y + c.h / 2;
    drag.a0 = Math.atan2(qy - drag.cy, qx - drag.cx);
    drag.base = { ...c };
    drag.auto = geo().cropAuto !== false;
  }
  return hit;
}

export function cropMove(sx, sy, shift) {
  if (!drag) return;
  const [qx, qy] = app.screenToQ(sx, sy);
  const g = geo(), gm = geomFor(g), poly = gm.poly, c0 = drag.crop;
  const dx = qx - drag.qx, dy = qy - drag.qy;
  if (drag.hit === 'rotate') {
    let a = drag.angle + (Math.atan2(qy - drag.cy, qx - drag.cx) - drag.a0) * 180 / Math.PI;
    if (shift) a = Math.round(a);
    a = Math.max(-45, Math.min(45, a));
    app.straightening = true;
    updateGeo(gg => { gg.angle = +a.toFixed(2); gg.cropAuto = drag.auto; }, null, drag.auto ? null : drag.base);
    return;
  }
  let next;
  if (drag.hit === 'move') {
    next = { ...c0, x: c0.x + dx, y: c0.y + dy };
    next = constrainRect(poly, c0, next, true);
  } else {
    const hit = drag.hit, r = drag.ratio || (shift ? c0.w / c0.h : 0);
    let x0 = c0.x, y0 = c0.y, x1 = c0.x + c0.w, y1 = c0.y + c0.h;
    if (hit.includes('w')) x0 = Math.min(x1 - MIN, c0.x + dx);
    if (hit.includes('e')) x1 = Math.max(x0 + MIN, c0.x + c0.w + dx);
    if (hit.includes('n')) y0 = Math.min(y1 - MIN, c0.y + dy);
    if (hit.includes('s')) y1 = Math.max(y0 + MIN, c0.y + c0.h + dy);
    if (r) {
      let w = x1 - x0, hh = y1 - y0;
      if (hit.length === 2) { if (w / hh > r) hh = w / r; else w = hh * r; }
      else if (hit === 'n' || hit === 's') w = hh * r;
      else hh = w / r;
      if (hit.includes('w')) x0 = x1 - w; else if (hit.includes('e')) x1 = x0 + w; else { const cx = c0.x + c0.w / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
      if (hit.includes('n')) y0 = y1 - hh; else if (hit.includes('s')) y1 = y0 + hh; else { const cy = c0.y + c0.h / 2; y0 = cy - hh / 2; y1 = cy + hh / 2; }
    }
    next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    next = constrainRect(poly, c0, next, !r);
  }
  store.set(st => { st.geo.crop = next; st.geo.cropAuto = false; }, 'geo');
  syncSize();
}

export function cropUp() {
  if (!drag) return;
  const hit = drag.hit;
  drag = null;
  app.straightening = false;
  app.requestRender();
  store.commit(hit === 'rotate' ? 'Straighten' : 'Crop');
  syncPanel();
}

// ---------- overlay drawing ----------
export function drawCropOverlay(g) {
  if (!app.cropMode || !app.doc) return;
  const W = app.overlay.width, H = app.overlay.height, d = app.dpr;
  const { x0, y0, x1, y1 } = cropScreen();
  g.save();
  g.fillStyle = 'rgba(10,10,12,0.62)';
  g.beginPath(); g.rect(0, 0, W, H); g.rect(x0, y0, x1 - x0, y1 - y0); g.fill('evenodd');
  const w = x1 - x0, hh = y1 - y0;
  // guides
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
  const line = (ax, ay, bx, by) => { g.beginPath(); g.moveTo(x0 + ax * w, y0 + ay * hh); g.lineTo(x0 + bx * w, y0 + by * hh); g.stroke(); };
  const straight = app.straightening || (drag && drag.hit === 'rotate');
  if (straight) {
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    for (let i = 1; i < 12; i++) { line(i / 12, 0, i / 12, 1); line(0, i / 12, 1, i / 12); }
  } else if (overlay === 'thirds') { for (const f of [1 / 3, 2 / 3]) { line(f, 0, f, 1); line(0, f, 1, f); } }
  else if (overlay === 'golden') { for (const f of [0.382, 0.618]) { line(f, 0, f, 1); line(0, f, 1, f); } }
  else if (overlay === 'grid') { g.strokeStyle = 'rgba(255,255,255,0.35)'; for (let i = 1; i < 8; i++) { line(i / 8, 0, i / 8, 1); line(0, i / 8, 1, i / 8); } }
  else if (overlay === 'diagonal') { line(0, 0, 1, 1); line(1, 0, 0, 1); const m = Math.min(w, hh); line(0, 0, m / w, m / hh); line(1, 0, 1 - m / w, m / hh); line(0, 1, m / w, 1 - m / hh); line(1, 1, 1 - m / w, 1 - m / hh); }
  else if (overlay === 'triangle') {
    const flipT = spiralRot % 2 === 1;
    const ax = flipT ? 1 : 0, bx = 1 - ax;
    line(ax, 0, bx, 1);
    const L2 = (w * w + hh * hh), dxv = (bx - ax) * w, dyv = hh;
    for (const [px, py] of [[bx, 0], [ax, 1]]) {
      const t = (((px - ax) * w) * dxv + (py * hh) * dyv) / L2;
      line(px, py, ax + t * (bx - ax), t);
    }
  } else if (overlay === 'center') { line(0.5, 0.4, 0.5, 0.6); line(0.45, 0.5, 0.55, 0.5); }
  else if (overlay === 'spiral') drawSpiral(g, x0, y0, w, hh);
  // border + handles
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 1.2 * d;
  g.strokeRect(x0, y0, w, hh);
  g.strokeStyle = '#fff'; g.lineWidth = 3.5 * d; g.lineCap = 'square';
  const L = Math.min(22 * d, w / 3, hh / 3), o = 1.5 * d;
  const corner = (x, y, sx2, sy2) => { g.beginPath(); g.moveTo(x + sx2 * L, y - sy2 * o * 0 + 0 - sy2 * o); g.lineTo(x - sx2 * o, y - sy2 * o); g.lineTo(x - sx2 * o, y + sy2 * L); g.stroke(); };
  corner(x0, y0, 1, 1); corner(x1, y0, -1, 1); corner(x0, y1, 1, -1); corner(x1, y1, -1, -1);
  const mid = (x, y, horiz) => { g.beginPath(); if (horiz) { g.moveTo(x - 10 * d, y); g.lineTo(x + 10 * d, y); } else { g.moveTo(x, y - 10 * d); g.lineTo(x, y + 10 * d); } g.stroke(); };
  g.lineWidth = 3 * d;
  mid((x0 + x1) / 2, y0 - o, true); mid((x0 + x1) / 2, y1 + o, true); mid(x0 - o, (y0 + y1) / 2, false); mid(x1 + o, (y0 + y1) / 2, false);
  // size badge while dragging
  if (drag) {
    const c = geo().crop;
    const txt = drag.hit === 'rotate' ? `${geo().angle.toFixed(1)}°` : `${Math.round(c.w)} × ${Math.round(c.h)}`;
    g.font = `500 ${11.5 * d}px 'IBM Plex Mono', monospace`;
    const tw = g.measureText(txt).width + 16 * d, th = 22 * d, bx = (x0 + x1) / 2 - tw / 2, by = y0 + 10 * d;
    g.fillStyle = 'rgba(20,19,18,.88)'; g.fillRect(bx, by, tw, th);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, bx + tw / 2, by + th / 2 + 0.5);
  }
  g.restore();
}

function drawSpiral(g, x0, y0, w, hh) {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const portrait = hh > w;
  const pts = [];
  let x = 0, y = 0, rw = PHI, rh = 1;
  for (let i = 0; i < 12; i++) {
    const s = Math.min(rw, rh);
    let cx, cy, a0;
    switch (i % 4) {
      case 0: cx = x + s; cy = y + rh; a0 = Math.PI; x += s; rw -= s; break;
      case 1: cx = x; cy = y + s; a0 = 1.5 * Math.PI; y += s; rh -= s; break;
      case 2: cx = x + rw - s; cy = y; a0 = 0; rw -= s; break;
      default: cx = x + rw; cy = y + rh - s; a0 = 0.5 * Math.PI; rh -= s; break;
    }
    for (let k = 0; k <= 12; k++) { const a = a0 + (k / 12) * Math.PI / 2; pts.push([cx + Math.cos(a) * s, cy + Math.sin(a) * s]); }
  }
  const fx = spiralRot & 1, fy = (spiralRot >> 1) & 1, tr = (spiralRot >> 2) & 1;
  g.beginPath();
  pts.forEach(([px, py], i) => {
    let u = px / PHI, v = py;
    if (portrait !== !!tr) [u, v] = [v, u];
    if (fx) u = 1 - u;
    if (fy) v = 1 - v;
    const X = x0 + u * w, Y = y0 + v * hh;
    i ? g.lineTo(X, Y) : g.moveTo(X, Y);
  });
  g.stroke();
}

// ---------- panel ----------
function dial({ label, min, max, step, get, set, fmt }) {
  const canvas = h('canvas');
  const input = h('input', { class: 'text-input num-input', type: 'text' });
  const box = h('div', { class: 'dial', title: 'Drag to adjust · double-click to reset' }, canvas);
  const el = h('div', {}, h('div', { class: 'dial-head' }, h('span', {}, label), input), box);
  let startX = 0, startV = 0, dragging = false;
  const pxPerUnit = () => (box.clientWidth / (max - min)) * 2.4;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1, W = canvas.width = box.clientWidth * dpr, H = canvas.height = box.clientHeight * dpr;
    if (!W) return;
    const g = canvas.getContext('2d'), v = get(), ppu = pxPerUnit() * dpr;
    g.clearRect(0, 0, W, H);
    const unit = (max - min) > 100 ? 2 : 1;
    for (let t = Math.ceil(min / unit) * unit; t <= max; t += unit) {
      const x = W / 2 + (t - v) * ppu;
      if (x < -2 || x > W + 2) continue;
      const major = t % (unit * 5) === 0, zero = t === 0;
      g.fillStyle = zero ? '#e3a043' : major ? 'rgba(236,230,219,.55)' : 'rgba(236,230,219,.2)';
      const th = zero ? H * 0.55 : major ? H * 0.38 : H * 0.22;
      g.fillRect(Math.round(x), H - th - 6 * dpr, Math.max(1, dpr), th);
      if (major && !zero && Math.abs(x - W / 2) > 18 * dpr) { g.fillStyle = 'rgba(236,230,219,.4)'; g.font = `${9.5 * dpr}px 'IBM Plex Mono', monospace`; g.textAlign = 'center'; g.fillText(String(t), x, 12 * dpr); }
    }
    g.fillStyle = '#ece6db'; g.fillRect(W / 2 - dpr * 0.75, 0, 1.5 * dpr, H);
    if (document.activeElement !== input) input.value = fmt(v);
  };
  const commitLabel = label;
  box.addEventListener('pointerdown', e => { dragging = true; startX = e.clientX; startV = get(); box.setPointerCapture(e.pointerId); set(startV, 'start'); });
  box.addEventListener('pointermove', e => { if (!dragging) return; let v = startV - (e.clientX - startX) / pxPerUnit() * (e.shiftKey ? 0.2 : 1); v = Math.round(Math.max(min, Math.min(max, v)) / step) * step; set(+v.toFixed(2), 'input'); draw(); });
  const end = () => { if (!dragging) return; dragging = false; set(get(), 'commit', commitLabel); };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  box.addEventListener('dblclick', () => { set(0, 'start'); set(0, 'input'); set(0, 'commit', commitLabel); draw(); });
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', () => { const n = parseFloat(input.value); if (Number.isFinite(n)) { set(get(), 'start'); set(Math.max(min, Math.min(max, n)), 'input'); set(0, 'commit', commitLabel); } draw(); });
  new ResizeObserver(draw).observe(box);
  return { el, draw };
}

function geoDial(key, label, min, max, step, fmt) {
  let base = null;
  return dial({
    label, min, max, step, fmt,
    get: () => geo()[key],
    set: (v, phase, lbl) => {
      if (phase === 'start') { base = geo().cropAuto === false ? clone(geo().crop) : null; app.straightening = key === 'angle'; return; }
      if (phase === 'commit') { app.straightening = false; app.requestRender(); store.commit(lbl); return; }
      updateGeo(g => { g[key] = v; }, null, base);
    },
  });
}

function syncSize() {
  if (!sizeW || !app.doc) return;
  const c = geo().crop;
  if (document.activeElement !== sizeW) sizeW.value = Math.round(c.w);
  if (document.activeElement !== sizeH) sizeH.value = Math.round(c.h);
}

export function syncPanel() {
  if (!app.doc) return;
  const g = geo();
  aspectBtns.forEach(([id, b]) => {
    b.classList.toggle('on', id === g.aspect);
    const a = ASPECTS.find(x => x.id === id);
    if (a.r > 0 && a.r !== 1) {
      const [p, q] = a.label.split(':');
      b.lastChild.textContent = q ? (g.portrait ? `${q}:${p}` : a.label) : a.label;
    }
  });
  portraitBtn?.classList.toggle('active', !!g.portrait);
  customRow.hidden = g.aspect !== 'custom';
  customW.value = g.custom[0]; customH.value = g.custom[1];
  Object.values(dials).forEach(d => d.draw());
  overlayBtns.forEach(([id, b]) => b.classList.toggle('on', id === overlay));
  syncSize();
}
let overlayBtns = [];

export function buildCropPanel(root) {
  const asp = makeSection({ id: 'crop-aspect', title: 'Aspect Ratio', iconId: 'i-crop', open: true });
  const grid = h('div', { class: 'aspect-grid' });
  aspectBtns = ASPECTS.map(a => {
    const r = a.r > 0 ? a.r : a.r === -1 ? 1.33 : 1.2;
    const iw = r >= 1 ? 13 : Math.round(13 * r), ih = r >= 1 ? Math.round(13 / r) : 13;
    const b = h('button', { class: 'aspect', type: 'button', title: a.label }, a.r === 0 ? null : h('i', { style: { width: iw + 'px', height: ih + 'px' } }), a.label);
    b.onclick = () => setAspect(a.id);
    grid.append(b);
    return [a.id, b];
  });
  portraitBtn = h('button', { class: 'btn sm', type: 'button', title: 'Swap portrait / landscape (X)', onclick: swapOrientation }, icon('i-swap'), 'Portrait / Landscape');
  customW = h('input', { class: 'text-input num-input', type: 'number', min: 1, step: 'any' });
  customH = h('input', { class: 'text-input num-input', type: 'number', min: 1, step: 'any' });
  const applyCustom = () => { const a = parseFloat(customW.value), b = parseFloat(customH.value); if (a > 0 && b > 0) { store.set(st => { st.geo.custom = [a, b]; st.geo.portrait = false; }, 'geo'); setAspect('custom'); } };
  customW.onchange = applyCustom; customH.onchange = applyCustom;
  customRow = h('div', { class: 'row' }, h('label', {}, 'Ratio'), customW, h('span', { class: 'muted' }, ':'), customH);
  asp.body.append(grid, customRow, h('div', { class: 'row' }, portraitBtn));
  root.append(asp.el);

  const st = makeSection({ id: 'crop-straight', title: 'Straighten & Perspective', iconId: 'i-rot-right', open: true });
  dials.angle = geoDial('angle', 'Straighten', -45, 45, 0.1, v => v.toFixed(1) + '°');
  dials.perspV = geoDial('perspV', 'Vertical perspective', -100, 100, 1, v => String(Math.round(v)));
  dials.perspH = geoDial('perspH', 'Horizontal perspective', -100, 100, 1, v => String(Math.round(v)));
  const autoBtn = h('button', { class: 'btn sm', type: 'button', title: 'Detect the horizon / verticals and level the photo', onclick: autoStraightenNow }, icon('i-wand'), 'Auto straighten');
  st.body.append(dials.angle.el, h('div', { class: 'row' }, autoBtn), dials.perspV.el, dials.perspH.el,
    h('div', { class: 'sec-note' }, 'Tip: drag outside the crop box on the photo to rotate freely.'));
  root.append(st.el);

  const tr = makeSection({ id: 'crop-transform', title: 'Rotate & Flip', iconId: 'i-flip-h', open: true });
  tr.body.append(h('div', { class: 'btn-row' },
    h('button', { class: 'btn', type: 'button', title: 'Rotate left ([)', onclick: () => rotate90(false) }, icon('i-rot-left')),
    h('button', { class: 'btn', type: 'button', title: 'Rotate right (])', onclick: () => rotate90(true) }, icon('i-rot-right')),
    h('button', { class: 'btn', type: 'button', title: 'Flip horizontal', onclick: () => flip(true) }, icon('i-flip-h')),
    h('button', { class: 'btn', type: 'button', title: 'Flip vertical', onclick: () => flip(false) }, icon('i-flip-v'))));
  root.append(tr.el);

  const ov = makeSection({ id: 'crop-overlay', title: 'Composition Overlay', iconId: 'i-grid', open: true });
  const og = h('div', { class: 'overlay-grid' });
  overlayBtns = OVERLAYS.map(o => { const b = h('button', { class: 'aspect', type: 'button', onclick: () => { overlay = o.id; syncPanel(); app.requestRender(); } }, o.label); og.append(b); return [o.id, b]; });
  ov.body.append(og, h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', title: 'Rotate spiral / triangle (Shift+O)', onclick: rotateOverlay }, icon('i-rot-right'), 'Rotate overlay')),
    h('div', { class: 'sec-note' }, 'Press O to cycle overlays.'));
  root.append(ov.el);

  const sz = makeSection({ id: 'crop-size', title: 'Crop Size', iconId: 'i-fit', open: false });
  sizeW = h('input', { class: 'text-input', type: 'number', min: MIN });
  sizeH = h('input', { class: 'text-input', type: 'number', min: MIN });
  const applySize = () => {
    const w = +sizeW.value, hh = +sizeH.value;
    if (!(w >= MIN && hh >= MIN)) return;
    const g = geo(), c = g.crop, r = ratioOf(g);
    let nw = w, nh = hh;
    if (r) { if (document.activeElement === sizeH) nw = nh * r; else nh = nw / r; }
    const next = { x: c.x + c.w / 2 - nw / 2, y: c.y + c.h / 2 - nh / 2, w: nw, h: nh };
    store.set(s => { s.geo.crop = fitRectInPoly(geomFor(s.geo).poly, next); s.geo.cropAuto = false; }, 'geo');
    syncSize(); store.commit('Crop Size');
  };
  sizeW.onchange = applySize; sizeH.onchange = applySize;
  sizeW.onkeydown = sizeH.onkeydown = e => e.stopPropagation();
  sz.body.append(h('div', { class: 'size-row' }, sizeW, h('span', { class: 'muted' }, '×'), sizeH), h('div', { class: 'sec-note' }, 'Pixels of the original image.'));
  root.append(sz.el);

  root.append(h('div', { class: 'crop-actions' },
    h('button', { class: 'btn', type: 'button', onclick: resetGeo, title: 'Reset crop and rotation' }, 'Reset'),
    h('button', { class: 'btn', type: 'button', onclick: () => { exitCrop(false); app.emit('settab', 'adjust'); }, title: 'Cancel (Esc)' }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => { exitCrop(true); app.emit('settab', 'adjust'); }, title: 'Apply (Enter)' }, icon('i-check'), 'Done')));

  store.on('sync', () => syncPanel());
  store.on('change', ({ kind }) => { if (kind === 'geo' || kind === 'all') syncSize(); });
  app.on('doc', () => { overlay = 'thirds'; syncPanel(); });
}
