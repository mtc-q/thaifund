// Stage interactions: pan / zoom / pinch, tools (crop, tap-select, brush, WB picker), overlay drawing.
import { app } from '../app.js';
import { store } from '../store.js';
import { $ } from './kit.js';
import { cropDown, cropMove, cropUp, cropHit, cropCursor, drawCropOverlay } from '../panels/crop.js';
import { tapSelect, strokeBegin, strokeDab, strokeEnd, brushOpts } from '../panels/subject.js';
import { pickWhiteBalance } from '../analysis.js';

let mode = null;            // 'pan' | 'crop' | 'brush' | 'split' | 'pinch'
let last = null, spaceDown = false, hover = null, downAt = null;
const pointers = new Map();
let pinch = null;

export const keys = { get space() { return spaceDown; } };

function setCursor(c) { app.stage.dataset.cursor = c; }

function updateCursor() {
  if (!app.doc) return setCursor('default');
  if (mode === 'pan') return setCursor('grabbing');
  if (spaceDown) return setCursor('grab');
  if (app.cropMode) return setCursor(hover ? cropCursor(cropHit(hover[0], hover[1])) : 'default');
  const t = app.tool;
  if (t === 'brush' || t === 'erase') return setCursor('none');
  if (t === 'select') return setCursor('crosshair');
  if (t === 'wb') return setCursor('picker');
  setCursor(app.view.zoom * 1.001 < fitZoom() ? 'grab' : 'grab');
}
const fitZoom = () => {
  const f = store.state.geo.crop;
  return Math.min(app.canvas.width / f.w, app.canvas.height / f.h);
};

function brushRadiusProxy(sx, sy) {
  const r = brushOpts.size / 2 * app.dpr;
  const a = app.screenToSrcUV(sx, sy, true), b = app.screenToSrcUV(sx + r, sy, true);
  if (!a || !b) return 4;
  const d = app.doc.proxy;
  return Math.hypot((b[0] - a[0]) * d.w, (b[1] - a[1]) * d.h);
}

function onDown(e) {
  if (!app.doc) return;
  app.stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, app.eventToScreen(e));
  if (pointers.size === 2) {
    if (mode === 'brush') strokeEnd();
    if (mode === 'crop') cropUp();
    const [p1, p2] = [...pointers.values()];
    pinch = { d: Math.hypot(p1[0] - p2[0], p1[1] - p2[1]), z: app.view.zoom, mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
    mode = 'pinch';
    return;
  }
  const [sx, sy] = app.eventToScreen(e);
  last = [sx, sy]; downAt = [sx, sy];
  if (e.target.closest('.split-handle i')) { mode = 'split'; return; }
  if (e.button === 1 || spaceDown || (e.button === 0 && app.tool === 'hand' && !app.cropMode)) { mode = 'pan'; updateCursor(); return; }
  if (e.button !== 0) return;
  if (app.cropMode) { cropDown(sx, sy); mode = 'crop'; return; }
  if (app.tool === 'brush' || app.tool === 'erase') {
    const uv = app.screenToSrcUV(sx, sy, true);
    strokeBegin();
    strokeDab(uv[0], uv[1], brushRadiusProxy(sx, sy), (app.tool === 'erase') !== e.altKey);
    mode = 'brush';
    return;
  }
  if (app.tool === 'select' || app.tool === 'wb') { mode = 'click'; return; }
  mode = 'pan';
}

function onMove(e) {
  const p = app.eventToScreen(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  hover = p;
  if (mode === 'pinch' && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
    const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    app.pan(mid[0] - pinch.mid[0], mid[1] - pinch.mid[1]);
    pinch.mid = mid;
    app.setZoom(pinch.z * d / pinch.d, mid[0], mid[1]);
    return;
  }
  const [sx, sy] = p;
  if (mode === 'pan') { app.pan(sx - last[0], sy - last[1]); last = [sx, sy]; }
  else if (mode === 'crop') cropMove(sx, sy, e.shiftKey);
  else if (mode === 'brush') {
    const uv = app.screenToSrcUV(sx, sy, true);
    strokeDab(uv[0], uv[1], brushRadiusProxy(sx, sy), (app.tool === 'erase') !== e.altKey);
  } else if (mode === 'split') {
    const r = app.stage.getBoundingClientRect();
    app.split.pos = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width));
    app.requestRender();
  }
  if (!mode) updateCursor();
  readout(sx, sy);
  drawOverlay();
}

function onUp(e) {
  pointers.delete(e.pointerId);
  if (mode === 'pinch') { if (pointers.size < 2) { mode = pointers.size ? 'pan' : null; const v = [...pointers.values()][0]; if (v) last = v; } return; }
  const [sx, sy] = app.eventToScreen(e);
  if (mode === 'crop') cropUp();
  else if (mode === 'brush') strokeEnd();
  else if (mode === 'click' && downAt && Math.hypot(sx - downAt[0], sy - downAt[1]) < 6 * app.dpr) {
    const uv = app.screenToSrcUV(sx, sy);
    if (uv && app.tool === 'select') tapSelect(uv[0], uv[1], e.altKey);
    if (uv && app.tool === 'wb') {
      const wb = pickWhiteBalance(app.doc.proxy, uv[0], uv[1]);
      if (wb) { store.set(st => { st.p.warmth = wb.warmth; st.p.tint = wb.tint; st.bypass.color = false; }); store.emit('sync', { reason: 'wb' }); store.commit('White Balance'); }
    }
  }
  mode = null; downAt = null;
  updateCursor();
  drawOverlay();
}

function onWheel(e) {
  if (!app.doc) return;
  e.preventDefault();
  const [sx, sy] = app.eventToScreen(e);
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  const mouseWheel = !e.ctrlKey && dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy);
  if (e.ctrlKey || e.metaKey || mouseWheel || e.altKey) {
    app.zoomBy(Math.exp(-dy * (e.ctrlKey && !mouseWheel ? 0.01 : 0.0018)), sx, sy);
  } else {
    app.pan(-dx * app.dpr, -dy * app.dpr);
  }
  drawOverlay();
}

let readoutPending = false;
function readout(sx, sy) {
  if (readoutPending || !app.doc) return;
  readoutPending = true;
  requestAnimationFrame(() => {
    readoutPending = false;
    const px = app.pixelAt(sx, sy);
    $('#stPixel').textContent = px ? `R ${String(px[0]).padStart(3)}  G ${String(px[1]).padStart(3)}  B ${String(px[2]).padStart(3)}` : 'R —  G —  B —';
  });
}

export function drawOverlay() {
  const c = app.overlay, g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!app.doc) return;
  if (app.cropMode) drawCropOverlay(g);
  if (!app.cropMode && hover && (app.tool === 'brush' || app.tool === 'erase')) {
    const r = brushOpts.size / 2 * app.dpr;
    g.save();
    g.lineWidth = 1.5 * app.dpr;
    g.strokeStyle = 'rgba(0,0,0,.7)';
    g.beginPath(); g.arc(hover[0], hover[1], r + app.dpr, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = app.tool === 'erase' ? '#e8735c' : '#f4efe6';
    g.beginPath(); g.arc(hover[0], hover[1], r, 0, Math.PI * 2); g.stroke();
    const inner = r * brushOpts.hardness;
    if (inner > 3) { g.setLineDash([3 * app.dpr, 3 * app.dpr]); g.beginPath(); g.arc(hover[0], hover[1], inner, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
    g.fillStyle = g.strokeStyle;
    g.fillRect(hover[0] - 0.75 * app.dpr, hover[1] - 4 * app.dpr, 1.5 * app.dpr, 8 * app.dpr);
    g.fillRect(hover[0] - 4 * app.dpr, hover[1] - 0.75 * app.dpr, 8 * app.dpr, 1.5 * app.dpr);
    g.restore();
  }
  // split handle
  const sh = $('#splitHandle');
  const show = app.split.on && !app.cropMode && !app.compare;
  sh.hidden = !show;
  if (show) sh.style.left = (app.split.pos * 100) + '%';
  if (show) {
    const x = Math.round(app.split.pos * c.width);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.fillRect(x - app.dpr * 0.75, 0, app.dpr * 1.5, c.height);
  }
}

export function initViewport() {
  const st = app.stage;
  st.addEventListener('pointerdown', onDown);
  st.addEventListener('pointermove', onMove);
  st.addEventListener('pointerup', onUp);
  st.addEventListener('pointercancel', onUp);
  st.addEventListener('pointerleave', () => { hover = null; if (!mode) drawOverlay(); });
  st.addEventListener('wheel', onWheel, { passive: false });
  st.addEventListener('dblclick', e => {
    if (!app.doc || app.cropMode || app.tool !== 'hand') return;
    const [sx, sy] = app.eventToScreen(e);
    if (app.view.fit) app.setZoom(app.dpr, sx, sy); else app.fitView();
  });
  st.addEventListener('contextmenu', e => { if (app.doc) e.preventDefault(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat && !isTyping(e)) { spaceDown = true; updateCursor(); e.preventDefault(); }
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; updateCursor(); } });
  window.addEventListener('blur', () => { spaceDown = false; });
  app.on('drawn', drawOverlay);
  app.on('tool', () => { updateCursor(); drawOverlay(); });
  app.on('brush', drawOverlay);
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
