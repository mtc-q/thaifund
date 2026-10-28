// Export dialog: format, resolution, resampling, DPI; tiled full-resolution GPU render.
import { store, clone } from '../store.js';
import { app } from '../app.js';
import { $, h, icon, openModal, closeModal, toast, makeSlider } from '../ui/kit.js';
import { FORMATS, encode, detectSupport, isSupported, hasTransparency } from '../export/encoders.js';
import { resizeRGBA, sharpenRGBA } from '../export/resample.js';
import { hexToRgb } from '../params.js';
import { hasSelection } from './subject.js';

const KEY = 'thaifund.export';
// Yield to the UI between steps. setTimeout (not requestAnimationFrame) keeps running in background tabs.
const nextFrame = () => new Promise(r => setTimeout(r, 0));
const TILE = 2048;
const SIZE_PRESETS = [
  { id: 'original', label: 'Original size' },
  ...[6000, 4096, 3840, 3000, 2560, 2048, 1920, 1600, 1280, 1080, 800, 512].map(n => ({ id: 'long' + n, label: `Long edge ${n} px`, long: n })),
  { id: 'percent', label: 'Percentage' },
  { id: 'custom', label: 'Custom size' },
];

let opts = {
  format: 'jpeg', quality: 90, size: 'original', percent: 50, w: 0, h: 0, lock: true, resample: 'lanczos', sharpen: 'none',
  dpi: 300, bg: '#ffffff', content: 'image', gifColors: 256, gifDither: true, tiffCompression: 'deflate', icoSizes: [16, 32, 48, 256], name: '',
};
try { Object.assign(opts, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore */ }
let busyExport = false;
const ui = {};

function cropSize() { const c = store.state.geo.crop; return { w: Math.max(1, Math.round(c.w)), h: Math.max(1, Math.round(c.h)) }; }

function targetSize() {
  const { w, h } = cropSize();
  const p = SIZE_PRESETS.find(s => s.id === opts.size);
  if (opts.size === 'original') return { w, h };
  if (p && p.long) { const k = p.long / Math.max(w, h); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; }
  if (opts.size === 'percent') { const k = opts.percent / 100; return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; }
  return { w: Math.max(1, Math.round(opts.w || w)), h: Math.max(1, Math.round(opts.h || h)) };
}

function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

function persist() { try { const { name, ...rest } = opts; localStorage.setItem(KEY, JSON.stringify(rest)); } catch { /* ignore */ } }

function build() {
  const form = $('#exportForm');
  form.replaceChildren();
  // formats
  ui.fmtBtns = FORMATS.map(f => {
    const b = h('button', { class: 'fmt', type: 'button', title: f.note }, h('b', {}, f.label), h('small', {}, '.' + f.ext));
    b.onclick = () => { opts.format = f.id; refresh(); };
    return [f, b];
  });
  ui.note = h('div', { class: 'fmt-note' });
  form.append(h('div', { class: 'sub-title', style: { marginTop: '2px' } }, 'Format'), h('div', { class: 'fmt-grid' }, ui.fmtBtns.map(x => x[1])), ui.note);

  ui.quality = makeSlider({ p: { id: 'q', label: 'Quality', min: 1, max: 100, def: 90, step: 1, fmt: v => Math.round(v) + '%' }, value: opts.quality, onInput: v => { opts.quality = v; } });
  ui.qualityRow = ui.quality.el;
  ui.gifColors = h('input', { class: 'text-input num-input', type: 'number', min: 2, max: 256, value: opts.gifColors, onchange: e => { opts.gifColors = Math.max(2, Math.min(256, +e.target.value || 256)); } });
  ui.gifDither = h('input', { type: 'checkbox', checked: opts.gifDither, onchange: e => { opts.gifDither = e.target.checked; } });
  ui.gifRow = h('div', { class: 'row' }, h('label', {}, 'Colours'), ui.gifColors, h('label', { class: 'check', style: { marginLeft: '8px' } }, ui.gifDither, 'Dithering'));
  ui.tiff = h('select', { class: 'select', onchange: e => { opts.tiffCompression = e.target.value; } }, h('option', { value: 'deflate' }, 'ZIP (lossless, smaller)'), h('option', { value: 'none' }, 'None (largest, most compatible)'));
  ui.tiff.value = opts.tiffCompression;
  ui.tiffRow = h('div', { class: 'row' }, h('label', {}, 'Compression'), ui.tiff);
  ui.icoBoxes = [16, 24, 32, 48, 64, 128, 256].map(s => { const c = h('input', { type: 'checkbox', checked: opts.icoSizes.includes(s), onchange: () => { opts.icoSizes = ui.icoBoxes.filter(x => x.checked).map(x => +x.value); } }); c.value = s; return c; });
  ui.icoRow = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px 12px' } }, h('label', {}, 'Icon sizes'), ...ui.icoBoxes.map(c => h('label', { class: 'check', style: { margin: 0 } }, c, c.value)));
  form.append(ui.qualityRow, ui.gifRow, ui.tiffRow, ui.icoRow);

  // size
  ui.sizeSel = h('select', { class: 'select', onchange: e => { opts.size = e.target.value; const t = targetSize(); opts.w = t.w; opts.h = t.h; refresh(); } }, SIZE_PRESETS.map(s => h('option', { value: s.id }, s.label)));
  ui.w = h('input', { class: 'text-input num-input', type: 'number', min: 1 });
  ui.h = h('input', { class: 'text-input num-input', type: 'number', min: 1 });
  ui.lock = h('button', { class: 'lock-btn', type: 'button', title: 'Keep proportions' }, icon('i-link'));
  ui.pct = h('input', { class: 'text-input num-input', type: 'number', min: 1, max: 800 });
  const onWH = which => {
    const c = cropSize();
    let w = +ui.w.value || 1, hh = +ui.h.value || 1;
    if (opts.lock) { if (which === 'w') hh = Math.round(w * c.h / c.w); else w = Math.round(hh * c.w / c.h); }
    opts.size = 'custom'; opts.w = w; opts.h = hh; refresh();
  };
  ui.w.onchange = () => onWH('w'); ui.h.onchange = () => onWH('h');
  ui.lock.onclick = () => { opts.lock = !opts.lock; refresh(); };
  ui.pct.onchange = () => { opts.size = 'percent'; opts.percent = Math.max(1, Math.min(800, +ui.pct.value || 100)); refresh(); };
  ui.resample = h('select', { class: 'select', onchange: e => { opts.resample = e.target.value; } },
    h('option', { value: 'lanczos' }, 'Lanczos 3 (sharpest)'), h('option', { value: 'bicubic' }, 'Bicubic (smooth)'), h('option', { value: 'nearest' }, 'Nearest (pixel art)'));
  ui.sharpen = h('select', { class: 'select', onchange: e => { opts.sharpen = e.target.value; } },
    h('option', { value: 'none' }, 'None'), h('option', { value: 'low' }, 'Low (screen)'), h('option', { value: 'standard' }, 'Standard'), h('option', { value: 'high' }, 'High (print)'));
  ui.dpi = h('input', { class: 'text-input num-input', type: 'number', min: 1, max: 4800, onchange: e => { opts.dpi = Math.max(1, Math.min(4800, +e.target.value || 72)); refresh(); } });
  form.append(
    h('div', { class: 'sub-title' }, 'Size'),
    h('div', { class: 'row' }, h('label', {}, 'Resize'), ui.sizeSel),
    h('div', { class: 'row' }, h('label', {}, 'Dimensions'), ui.w, ui.lock, ui.h, h('span', { class: 'muted' }, 'px')),
    h('div', { class: 'row' }, h('label', {}, 'Scale'), ui.pct, h('span', { class: 'muted' }, '%')),
    h('div', { class: 'row' }, h('label', {}, 'Resampling'), ui.resample),
    h('div', { class: 'row' }, h('label', {}, 'Sharpen for'), ui.sharpen),
    h('div', { class: 'row' }, h('label', {}, 'Resolution'), ui.dpi, h('span', { class: 'muted' }, 'DPI')),
  );

  // content
  ui.content = h('select', { class: 'select', onchange: e => { opts.content = e.target.value; refresh(true); } },
    h('option', { value: 'image' }, 'Edited photo'), h('option', { value: 'cutout' }, 'Subject cut-out (transparent background)'), h('option', { value: 'mask' }, 'Subject mask (black & white)'));
  ui.bg = h('input', { type: 'color', class: 'color-input', value: opts.bg, onchange: e => { opts.bg = e.target.value; } });
  ui.bgRow = h('div', { class: 'row' }, h('label', {}, 'Fill transparency'), ui.bg, h('span', { class: 'muted' }, 'for formats without alpha'));
  ui.name = h('input', { class: 'text-input', type: 'text', spellcheck: 'false', onchange: e => { opts.name = e.target.value; } });
  ui.ext = h('span', { class: 'muted mono' });
  ui.name.onkeydown = e => e.stopPropagation();
  form.append(
    h('div', { class: 'sub-title' }, 'Output'),
    h('div', { class: 'row' }, h('label', {}, 'Content'), ui.content),
    ui.bgRow,
    h('div', { class: 'row' }, h('label', {}, 'File name'), ui.name, ui.ext),
  );
  ui.sizeSel.value = opts.size;
  ui.resample.value = opts.resample;
  ui.sharpen.value = opts.sharpen;
  ui.content.value = opts.content;
}

function refresh(preview = false) {
  const f = FORMATS.find(x => x.id === opts.format) || FORMATS[0];
  ui.fmtBtns.forEach(([fm, b]) => { b.classList.toggle('on', fm.id === f.id); b.disabled = !isSupported(fm); if (b.disabled) b.title = fm.label + ' encoding is not supported by this browser'; });
  ui.note.textContent = f.note;
  ui.qualityRow.hidden = !f.quality;
  ui.gifRow.hidden = f.id !== 'gif';
  ui.tiffRow.hidden = f.id !== 'tiff';
  ui.icoRow.hidden = f.id !== 'ico';
  ui.bgRow.hidden = f.alpha && opts.content !== 'mask';
  const t = targetSize();
  if (opts.size !== 'custom') { opts.w = t.w; opts.h = t.h; }
  ui.sizeSel.value = opts.size;
  if (document.activeElement !== ui.w) ui.w.value = t.w;
  if (document.activeElement !== ui.h) ui.h.value = t.h;
  const c = cropSize();
  if (document.activeElement !== ui.pct) ui.pct.value = Math.round(t.w / c.w * 1000) / 10;
  ui.lock.classList.toggle('on', opts.lock);
  ui.dpi.value = opts.dpi;
  ui.ext.textContent = '.' + f.ext;
  if (!ui.name.value) ui.name.value = opts.name || (app.doc.base + '-edited');
  const mp = (t.w * t.h / 1e6).toFixed(1);
  const inch = (n => (n / opts.dpi).toFixed(2));
  const raw = { bmp: 4, tga: 4, dds: 4, ppm: 3, psd: 4, hdr: 4 }[f.id];
  $('#exportSummary').replaceChildren(...[
    h('span', {}, 'Output'), h('b', {}, `${t.w} × ${t.h} px · ${mp} MP`),
    h('span', {}, 'Print size'), h('b', {}, `${inch(t.w)} × ${inch(t.h)} in at ${opts.dpi} DPI`),
    h('span', {}, 'Format'), h('b', {}, `${f.label} (.${f.ext})${f.alpha ? ' · alpha' : ''}`),
    raw && h('span', {}, 'Approx. size'), raw && h('b', {}, '≈ ' + fmtBytes(t.w * t.h * raw)),
    h('span', {}, 'Metadata'), h('b', {}, 'EXIF & GPS removed'),
  ].filter(Boolean));
  if (preview) drawPreview();
  persist();
}

function exportState() {
  const s = clone(store.state);
  if (opts.content === 'cutout') s.bg.mode = 'transparent';
  return s;
}

function drawPreview() {
  const c = $('#exportPreview');
  const cs = cropSize(), k = Math.min(1, 520 / Math.max(cs.w, cs.h));
  c.width = Math.max(1, Math.round(cs.w * k)); c.height = Math.max(1, Math.round(cs.h * k));
  app.drawThumb(c, { state: exportState(), showMask: opts.content === 'mask' ? 2 : 0, contain: true });
}

/** Renders the full crop at `scale` in GPU tiles. Returns RGBA pixels. */
async function renderFull(scale, onProgress) {
  const state = exportState();
  const frame = state.geo.crop;
  const gw = Math.max(1, Math.round(frame.w * scale)), gh = Math.max(1, Math.round(frame.h * scale));
  const out = new Uint8ClampedArray(gw * gh * 4);
  const r = app.renderer;
  const flags = { cropMode: false, showMask: opts.content === 'mask' ? 2 : 0, clip: false, bypass: false };
  app.syncCurves();
  const tilesX = Math.ceil(gw / TILE), tilesY = Math.ceil(gh / TILE);
  let done = 0;
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    const x0 = tx * TILE, y0 = ty * TILE, w = Math.min(TILE, gw - x0), hh = Math.min(TILE, gh - y0);
    const job = app.makeJob(frame, { x: x0 / scale, y: y0 / scale }, scale, { w, h: hh }, flags, state);
    const t = r.render(job);
    const buf = r.read(t);
    r.release(t);
    for (let y = 0; y < hh; y++) out.set(buf.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * gw + x0) * 4);
    done++;
    onProgress(done / (tilesX * tilesY));
    await nextFrame();
  }
  return { data: out, w: gw, h: gh };
}

function setProgress(frac, text) {
  const p = $('#exportProgress');
  p.hidden = frac === null;
  if (frac !== null) { p.querySelector('i').style.width = Math.round(frac * 100) + '%'; p.querySelector('span').textContent = text; }
}

async function produce() {
  const f = FORMATS.find(x => x.id === opts.format);
  const t = targetSize();
  if (t.w * t.h > 268e6) throw new Error('That size is larger than browsers can handle (max ≈ 268 megapixels).');
  if (opts.format === 'ico' && !opts.icoSizes.length) throw new Error('Choose at least one icon size.');
  const c = cropSize();
  const down = t.w < c.w;
  const scale = opts.resample === 'nearest' ? 1 : down ? Math.min(1, (t.w / c.w) * 2) : 1;
  setProgress(0, 'Rendering…');
  let img = await renderFull(scale, p => setProgress(p * 0.7, 'Rendering…'));
  if (img.w !== t.w || img.h !== t.h) {
    setProgress(0.72, 'Resampling…');
    await nextFrame();
    img = { data: resizeRGBA(img.data, img.w, img.h, t.w, t.h, opts.resample), w: t.w, h: t.h };
  }
  const amt = { none: 0, low: 0.25, standard: 0.5, high: 0.85 }[opts.sharpen];
  if (amt && opts.content !== 'mask') { setProgress(0.82, 'Sharpening…'); await nextFrame(); img.data = sharpenRGBA(img.data, img.w, img.h, amt); }
  setProgress(0.88, 'Encoding ' + f.label + '…');
  await nextFrame();
  const blob = await encode(f.id, img, { quality: opts.quality, dpi: opts.dpi, bg: hexToRgb(opts.bg).map(v => Math.round(v * 255)), tiffCompression: opts.tiffCompression, gifColors: opts.gifColors, gifDither: opts.gifDither, icoSizes: opts.icoSizes });
  setProgress(1, 'Done');
  return { blob, f, img };
}

async function doExport() {
  if (busyExport) return;
  if ((opts.content === 'cutout' || opts.content === 'mask') && !hasSelection()) { toast('Select a subject first (Subject tab) to export a cut-out or mask.', 'err'); return; }
  busyExport = true;
  $('#exportGo').disabled = true;
  try {
    const { blob, f, img } = await produce();
    if (opts.content === 'cutout' && !f.alpha) toast(`${f.label} has no transparency — the background was filled with your fill colour.`, 'info', 5000);
    else if (f.alpha === false && hasTransparency(img) && opts.content === 'image') toast(`${f.label} has no transparency — transparent areas were filled.`, 'info', 4000);
    const name = (ui.name.value || app.doc.base + '-edited').replace(/[\\/:*?"<>|]+/g, '_') + '.' + f.ext;
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Exported ${name} · ${fmtBytes(blob.size)}`, 'ok', 4500);
    closeModal($('#exportModal'));
  } catch (e) {
    console.error(e);
    toast(e.message || 'Export failed.', 'err', 7000);
  } finally {
    busyExport = false;
    $('#exportGo').disabled = false;
    setProgress(null);
  }
}

async function copyToClipboard() {
  if (busyExport) return;
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') { toast('Clipboard images are not supported in this browser.', 'err'); return; }
  busyExport = true;
  try {
    const keep = opts.format;
    opts.format = 'png';
    const { blob } = await produce().finally(() => { opts.format = keep; });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copied to clipboard as PNG.', 'ok');
  } catch (e) { toast('Could not copy: ' + (e.message || e), 'err'); }
  finally { busyExport = false; setProgress(null); }
}

export async function openExport() {
  if (!app.doc) return;
  if (app.cropMode) app.emit('exitcrop');
  await detectSupport();
  if (!ui.fmtBtns) build();
  ui.name.value = opts.name || app.doc.base + '-edited';
  if (!isSupported(FORMATS.find(f => f.id === opts.format))) opts.format = 'jpeg';
  refresh(true);
  openModal($('#exportModal'));
}

export function initExport() {
  $('#exportGo').onclick = doExport;
  $('#exportCopy').onclick = copyToClipboard;
  app.on('doc', () => { opts.name = ''; if (ui.name) ui.name.value = ''; });
}
