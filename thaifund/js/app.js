// Application controller: document, view, render loop.
import { Renderer } from './engine/renderer.js';
import { store } from './store.js';
import { buildGeometry, uvFromO, bbox, M3 } from './geometry.js';
import { buildUniforms, buildCurveLUT } from './params.js';
import { defaultState } from './schema.js';
import { $, toast, busy, debounce } from './ui/kit.js';
import { readExif } from './analysis.js';
import { decodeFallback } from './export/decoders.js';

export const PROXY_LONG = 1536;
const BG = [0.11, 0.11, 0.11]; // neutral grey around the photo — keeps colour judgement honest

class App extends EventTarget {
  constructor() {
    super();
    this.doc = null;
    this.view = { zoom: 1, cx: 0, cy: 0, fit: true };
    this.tool = 'hand';
    this.tab = 'adjust';
    this.cropMode = false;
    this.showMask = 0;
    this.clip = false;
    this.compare = false;
    this.split = { on: false, pos: 0.5 };
    this.maskInfo = { has: false, version: 0, w: 1, h: 1 };
    this.dirty = true;
    this.lastView = null;
    this.curveKey = '';
    this.dpr = 1;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); }

  init() {
    this.canvas = $('#glCanvas');
    this.overlay = $('#overlay');
    this.stage = $('#stage');
    this.renderer = new Renderer(this.canvas);
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); toast('The graphics context was lost. Reload the page if the image does not come back.', 'err', 8000); });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.stage);
    this.resize();
    store.on('change', ({ kind }) => { this.requestRender(); this.scheduleAux(kind); });
    const loop = () => { if (this.dirty) { this.dirty = false; this.renderView(); this.emit('rendered'); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.histDebounced = debounce(() => this.updateHistogram(), 90);
    $('#stGpu').textContent = (this.renderer.floatOK ? 'GPU · 16-bit float' : 'GPU · 8-bit') + ' · WebGL 2';
    $('#stGpu').title = this.renderer.gpuName;
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * this.dpr)), h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.overlay.width = w; this.overlay.height = h;
    }
    if (this.doc && this.view.fit) this.fitView(false);
    this.requestRender();
  }

  requestRender() { this.dirty = true; }
  scheduleAux(kind) { if (this.doc) { this.histDebounced(); this.emit('aux', kind); } }

  // ---------- document ----------
  async openFile(file) {
    if (!file) return;
    if (this.doc && store.dirty && !confirm('Open a new image? Your current edits will be discarded.')) return;
    busy(true, 'Opening ' + file.name + '…');
    try {
      const { bitmap, note } = await this.decode(file);
      await this.setImage(bitmap, file, note);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not open this file.', 'err', 7000);
    } finally { busy(false); }
  }

  async decode(file) {
    const max = Math.min(this.renderer.maxTex, 16384), maxPx = 120e6;
    let bmp = null, note = '';
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' }); }
    catch {
      try {
        const url = URL.createObjectURL(file);
        const img = new Image(); img.src = url;
        await img.decode();
        bmp = await createImageBitmap(img, { premultiplyAlpha: 'none' });
        URL.revokeObjectURL(url);
      } catch {
        const alt = await decodeFallback(file);
        if (!alt) {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (ext === 'heic' || ext === 'heif') throw new Error('HEIC/HEIF photos can only be decoded by Safari. Open the photo in Safari, or convert it to JPEG first.');
          throw new Error(`“${file.name}” is not an image format this browser can read.`);
        }
        bmp = await createImageBitmap(alt, { premultiplyAlpha: 'none' });
      }
    }
    let { width: w, height: h } = bmp;
    const k = Math.min(1, max / Math.max(w, h), Math.sqrt(maxPx / (w * h)));
    if (k < 1) {
      const nw = Math.round(w * k), nh = Math.round(h * k);
      const c = new OffscreenCanvas(nw, nh), g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, nw, nh);
      bmp.close?.();
      bmp = await createImageBitmap(c, { premultiplyAlpha: 'none' });
      note = `Image was larger than your GPU supports (${w}×${h}); working at ${nw}×${nh}.`;
    }
    return { bitmap: bmp, note };
  }

  async setImage(bitmap, file, note) {
    const W = bitmap.width, H = bitmap.height;
    // Proxy copy (CPU side) for analysis and subject segmentation.
    const k = Math.min(1, PROXY_LONG / Math.max(W, H));
    const pw = Math.max(1, Math.round(W * k)), ph = Math.max(1, Math.round(H * k));
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph;
    const pg = pc.getContext('2d', { willReadFrequently: true });
    pg.imageSmoothingQuality = 'high';
    pg.drawImage(bitmap, 0, 0, pw, ph);
    const pdata = pg.getImageData(0, 0, pw, ph);
    let hasAlpha = false;
    for (let i = 3; i < pdata.data.length; i += 4) if (pdata.data[i] < 250) { hasAlpha = true; break; }

    this.renderer.purge();
    this.renderer.setSource(bitmap, W, H, hasAlpha);
    this.doc?.bitmap?.close?.();
    this.doc = {
      bitmap, W, H, hasAlpha,
      name: file?.name || 'Pasted image', base: (file?.name || 'image').replace(/\.[^.]+$/, ''),
      type: file?.type || '', size: file?.size || 0, exif: null,
      proxy: { canvas: pc, w: pw, h: ph, data: pdata.data },
    };
    this.maskInfo = { has: false, version: 0, w: pw, h: ph };
    this.cropMode = false;
    this.showMask = 0;
    this.split.on = false;
    store.reset(defaultState(W, H));
    this.curveKey = '';
    this.fitView(false);
    this.emit('doc', this.doc);
    this.requestRender();
    this.histDebounced();
    $('#empty').hidden = true;
    if (note) toast(note, 'info', 7000);
    if (file && file.arrayBuffer) readExif(file).then(ex => { if (this.doc && this.doc.bitmap === bitmap) { this.doc.exif = ex; this.emit('exif', ex); } }).catch(() => {});
  }

  // ---------- geometry & view ----------
  get geom() { const d = this.doc, g = store.state.geo; return buildGeometry(d.W, d.H, g); }

  frameRect() {
    const g = store.state.geo;
    if (!this.cropMode) return g.crop;
    const b = bbox(this.geom.poly), c = g.crop;
    const x0 = Math.min(b.x, c.x), y0 = Math.min(b.y, c.y), x1 = Math.max(b.x + b.w, c.x + c.w), y1 = Math.max(b.y + b.h, c.y + c.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  fitView(render = true) {
    if (!this.doc) return;
    const f = this.cropMode ? bbox(this.geom.poly) : store.state.geo.crop;
    const cw = this.canvas.width, ch = this.canvas.height, m = (this.cropMode ? 56 : 28) * this.dpr;
    const z = Math.min((cw - 2 * m) / f.w, (ch - 2 * m) / f.h);
    this.view = { zoom: Math.max(1e-4, z), cx: f.x + f.w / 2, cy: f.y + f.h / 2, fit: true };
    if (render) this.requestRender();
    this.emit('view');
  }
  setZoom(z, sx, sy) {
    const v = this.view, cw = this.canvas.width, ch = this.canvas.height;
    if (sx === undefined) { sx = cw / 2; sy = ch / 2; }
    z = Math.max(0.01, Math.min(32, z));
    const [qx, qy] = this.screenToQ(sx, sy);
    v.zoom = z; v.fit = false;
    v.cx = qx - (sx - cw / 2) / z; v.cy = qy - (sy - ch / 2) / z;
    this.clampView();
    this.requestRender(); this.emit('view');
  }
  zoomBy(f, sx, sy) { this.setZoom(this.view.zoom * f, sx, sy); }
  pan(dx, dy) { this.view.cx -= dx / this.view.zoom; this.view.cy -= dy / this.view.zoom; this.view.fit = false; this.clampView(); this.requestRender(); this.emit('view'); }
  clampView() {
    const f = this.cropMode ? bbox(this.geom.poly) : store.state.geo.crop, v = this.view;
    const hw = this.canvas.width / 2 / v.zoom, hh = this.canvas.height / 2 / v.zoom;
    const clampAxis = (c, lo, size, half) => size <= 2 * half ? lo + size / 2 : Math.min(lo + size - half * 0.75, Math.max(lo + half * 0.75, c));
    v.cx = clampAxis(v.cx, f.x, f.w, hw);
    v.cy = clampAxis(v.cy, f.y, f.h, hh);
  }
  /** Zoom level as "image pixels" percentage (1 q-unit ≈ 1 source pixel). */
  zoomPercent() { return this.view.zoom / this.dpr * 100; }

  screenToQ(sx, sy) { const v = this.view; return [v.cx + (sx - this.canvas.width / 2) / v.zoom, v.cy + (sy - this.canvas.height / 2) / v.zoom]; }
  qToScreen(qx, qy) { const v = this.view; return [(qx - v.cx) * v.zoom + this.canvas.width / 2, (qy - v.cy) * v.zoom + this.canvas.height / 2]; }
  eventToScreen(e) { const r = this.stage.getBoundingClientRect(); return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr]; }
  /** Screen px → normalised source uv (or null if outside the image). */
  screenToSrcUV(sx, sy, allowOutside = false) {
    const [qx, qy] = this.screenToQ(sx, sy);
    const [u, v] = M3.apply(this.geom.uvFromQ, qx, qy);
    if (!allowOutside && (u < 0 || v < 0 || u > 1 || v > 1)) return null;
    return [u, v];
  }

  // ---------- rendering ----------
  maskParams() {
    const st = store.state, long = Math.max(this.maskInfo.w, this.maskInfo.h);
    return { has: this.maskInfo.has, feather: st.mask.feather / 100 * 0.03 * long, shift: st.mask.shift / 100 * 0.02 * long, invert: st.mask.invert };
  }

  syncCurves() {
    const key = JSON.stringify(store.state.curves);
    if (key !== this.curveKey) { this.curveKey = key; this.renderer.setCurveLUT(buildCurveLUT(store.state.curves)); }
  }

  makeJob(frame, origin, scale, out, flags, state = store.state, lookOverride) {
    const geom = buildGeometry(this.doc.W, this.doc.H, state.geo);
    const H = uvFromO(geom, frame);
    const mask = this.maskParams();
    const u = buildUniforms(state, mask.has, lookOverride);
    const crop = flags.cropMode ? { x: state.geo.crop.x - frame.x, y: state.geo.crop.y - frame.y, w: state.geo.crop.w, h: state.geo.crop.h } : { x: 0, y: 0, w: frame.w, h: frame.h };
    const ctxKey = [frame.x, frame.y, frame.w, frame.h].map(v => v.toFixed(3)).join(',') + '|' + H.map(v => v.toPrecision(9)).join(',') +
      '|' + (mask.has ? `${this.maskInfo.version},${mask.feather.toFixed(2)},${mask.shift.toFixed(2)},${mask.invert}` : '-');
    return { frame, H, origin, scale, out, crop, u, mask, lens: { on: u.lensAmount > 0, amount: u.lensAmount, boost: u.lensBoost }, ctxKey, flags };
  }

  renderView() {
    const r = this.renderer;
    r.clear(BG);
    if (this.lastView) { r.release(this.lastView.t); this.lastView = null; }
    if (!this.doc) return;
    this.syncCurves();
    const cw = this.canvas.width, ch = this.canvas.height, v = this.view;
    const frame = this.frameRect();
    const fx0 = (frame.x - v.cx) * v.zoom + cw / 2, fy0 = (frame.y - v.cy) * v.zoom + ch / 2;
    const fx1 = fx0 + frame.w * v.zoom, fy1 = fy0 + frame.h * v.zoom;
    const sx0 = Math.max(0, Math.floor(fx0)), sy0 = Math.max(0, Math.floor(fy0));
    const sx1 = Math.min(cw, Math.ceil(fx1)), sy1 = Math.min(ch, Math.ceil(fy1));
    if (sx1 <= sx0 || sy1 <= sy0) { this.emit('drawn'); return; }
    const out = { w: sx1 - sx0, h: sy1 - sy0 };
    const origin = { x: (sx0 - fx0) / v.zoom, y: (sy0 - fy0) / v.zoom };
    const flags = { cropMode: this.cropMode, showMask: this.showMask, clip: this.clip, bypass: this.compare };
    const job = this.makeJob(frame, origin, v.zoom, out, flags);
    const t = r.render(job);
    const opts = { checker: !this.cropMode, bg: BG };
    if (this.split.on && !this.compare && !this.cropMode) {
      const tb = r.render({ ...job, flags: { ...flags, bypass: true, showMask: 0, clip: false } });
      const sx = Math.round(this.split.pos * cw);
      r.presentClip(tb, sx0, sy0, 0, sx, opts);
      r.presentClip(t, sx0, sy0, sx, cw, opts);
      r.release(tb);
    } else r.present(t, sx0, sy0, opts);
    this.lastView = { t, x: sx0, y: sy0 };
    this.emit('drawn');
  }

  /** Pixel readout under the cursor (displayed values). */
  pixelAt(sx, sy) {
    const lv = this.lastView;
    if (!lv) return null;
    const x = Math.floor(sx - lv.x), y = Math.floor(sy - lv.y);
    if (x < 0 || y < 0 || x >= lv.t.w || y >= lv.t.h) return null;
    return this.renderer.readPixel(lv.t, x, y);
  }

  /** Renders the whole crop at a small size and returns RGBA pixels. */
  renderSmall(maxSide, opts = {}) {
    if (!this.doc) return null;
    this.syncCurves();
    const state = opts.state || store.state;
    const frame = state.geo.crop;
    const s = Math.min(maxSide / Math.max(frame.w, frame.h), 4);
    const out = { w: Math.max(1, Math.round(frame.w * s)), h: Math.max(1, Math.round(frame.h * s)) };
    const flags = { cropMode: false, showMask: opts.showMask || 0, clip: false, bypass: !!opts.bypass };
    const job = this.makeJob(frame, { x: 0, y: 0 }, s, out, flags, state, opts.look);
    const t = this.renderer.render(job);
    const data = this.renderer.read(t);
    this.renderer.release(t);
    return { data, w: out.w, h: out.h };
  }

  /** Draws a small render into a canvas, cropped to fill (cover). */
  drawThumb(canvas, opts = {}) {
    const W = canvas.width, Hh = canvas.height;
    const img = this.renderSmall(Math.max(W, Hh) * 1.6, opts);
    if (!img) return;
    const tmp = new OffscreenCanvas(img.w, img.h);
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer), img.w, img.h), 0, 0);
    const g = canvas.getContext('2d');
    const k = opts.contain ? Math.min(W / img.w, Hh / img.h) : Math.max(W / img.w, Hh / img.h);
    const dw = img.w * k, dh = img.h * k;
    g.clearRect(0, 0, W, Hh);
    g.imageSmoothingQuality = 'high';
    g.drawImage(tmp, (W - dw) / 2, (Hh - dh) / 2, dw, dh);
  }

  updateHistogram() {
    const c = $('#histCanvas');
    const g = c.getContext('2d');
    const W = c.width = Math.round(c.clientWidth * this.dpr) || 320, H = c.height = Math.round(c.clientHeight * this.dpr) || 110;
    g.clearRect(0, 0, W, H);
    if (!this.doc) return;
    const img = this.renderSmall(320);
    if (!img) return;
    const r = new Uint32Array(256), gg = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
    const d = img.data;
    let clipHi = 0, clipLo = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      r[d[i]]++; gg[d[i + 1]]++; b[d[i + 2]]++;
      const L = (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
      l[L]++; n++;
      if (d[i] > 253 || d[i + 1] > 253 || d[i + 2] > 253) clipHi++;
      if (d[i] < 2 && d[i + 1] < 2 && d[i + 2] < 2) clipLo++;
    }
    let peak = 1;
    for (let i = 2; i < 254; i++) peak = Math.max(peak, r[i], gg[i], b[i]);
    const y = (hist, i) => H - Math.min(1, Math.sqrt(hist[i] / peak)) * (H - 4);
    const fill = (hist, color) => {
      g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i < 256; i++) g.lineTo(i / 255 * W, y(hist, i));
      g.lineTo(W, H); g.closePath(); g.fillStyle = color; g.fill();
    };
    const line = (hist, color) => {
      g.beginPath();
      for (let i = 0; i < 256; i++) i ? g.lineTo(i / 255 * W, y(hist, i)) : g.moveTo(0, y(hist, i));
      g.strokeStyle = color; g.lineWidth = Math.max(1, this.dpr); g.stroke();
    };
    g.fillStyle = 'rgba(236,230,219,.05)';
    for (let i = 1; i < 4; i++) g.fillRect(Math.round(i * W / 4), 0, 1, H);
    // Luminance as a soft area, channels as thin lines on top.
    fill(l, 'rgba(236,230,219,.17)');
    line(b, 'rgba(98,136,226,.85)'); line(gg, 'rgba(122,180,98,.8)'); line(r, 'rgba(222,96,72,.85)');
    // clipping indicators
    const tri = (x, on, col) => { g.fillStyle = on ? col : 'rgba(255,255,255,.12)'; g.beginPath(); const s = 7 * this.dpr; if (x === 0) { g.moveTo(3, 3); g.lineTo(3 + s, 3); g.lineTo(3, 3 + s); } else { g.moveTo(W - 3, 3); g.lineTo(W - 3 - s, 3); g.lineTo(W - 3, 3 + s); } g.fill(); };
    tri(0, clipLo / Math.max(n, 1) > 0.002, '#7aa2e8');
    tri(1, clipHi / Math.max(n, 1) > 0.002, '#e2492e');
    this.emit('histogram', { clipLo: clipLo / Math.max(n, 1), clipHi: clipHi / Math.max(n, 1) });
  }

  // ---------- mask ----------
  setMaskData(data, w, h) {
    if (!data) { this.renderer.setMask(null); this.maskInfo = { ...this.maskInfo, has: false, version: this.maskInfo.version + 1 }; }
    else { this.renderer.setMask(data, w, h); this.maskInfo = { has: true, version: this.maskInfo.version + 1, w, h }; }
    this.requestRender(); this.scheduleAux('mask');
  }
  updateMaskRect(data, w, x, y, rw, rh) {
    this.renderer.updateMaskRect(data, w, x, y, rw, rh);
    this.maskInfo.version++;
    this.requestRender();
  }
}

export const app = new App();
