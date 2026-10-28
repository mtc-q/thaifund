// Thaifund — bootstrap & wiring.
import { app } from './app.js';
import { store } from './store.js';
import { $, $$, h, toast, openModal, closeModal, topModal, togglePopover, closePopover } from './ui/kit.js';
import { initViewport, isTyping, drawOverlay } from './ui/viewport.js';
import { buildAdjustPanel, autoEnhance } from './panels/adjust.js';
import { buildSubjectPanel, brushOpts, setMaskView } from './panels/subject.js';
import { buildCropPanel, enterCrop, exitCrop, cycleOverlay, rotateOverlay, swapOrientation, rotate90, resetGeo } from './panels/crop.js';
import { buildLooksPanel, copySettings, pasteSettings } from './panels/looks.js';
import { openExport, initExport } from './panels/export.js';
import { exifSummary } from './analysis.js';
import { defaultState } from './schema.js';

const TOOLS = ['hand', 'crop', 'select', 'brush', 'erase', 'wb'];

function boot() {
  try { app.init(); }
  catch (e) {
    console.error(e);
    $('#empty').innerHTML = `<div class="empty-card"><h1>WebGL 2 is required</h1><p>${e.message}</p><p>Please use a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.</p></div>`;
    return;
  }
  store.reset(defaultState(1, 1));
  buildAdjustPanel($('#tab-adjust'));
  buildSubjectPanel($('#tab-subject'));
  buildCropPanel($('#tab-crop'));
  buildLooksPanel($('#tab-looks'));
  initExport();
  initViewport();
  wireTopbar();
  wireTabsAndTools();
  wireFiles();
  wireKeys();
  wireStatus();
  setTab('adjust');
  setTool('hand');
  window.thaifund = { app, store, open: f => app.openFile(f).then(afterOpen) }; // handy for debugging from the console
  $('#panel').classList.add('disabled');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }
}

// ---------- tabs & tools ----------
function setTab(t) {
  if (!app.doc && t !== 'adjust') t = 'adjust';
  if (app.tab === 'crop' && t !== 'crop') exitCrop(true);
  app.tab = t;
  $$('.tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); });
  $$('.tab-body').forEach(p => { p.hidden = p.dataset.pane !== t; });
  if (t === 'crop') { enterCrop(); if (app.tool !== 'crop') setTool('crop', true); }
  else if (app.tool === 'crop') setTool('hand', true);
  if (t === 'subject' && (app.tool === 'hand' || app.tool === 'wb')) setTool('select', true);
  if (t !== 'subject' && ['select', 'brush', 'erase'].includes(app.tool)) setTool('hand', true);
  app.emit('tab', t);
  updateHud();
}

function setTool(t, fromTab = false) {
  if (!TOOLS.includes(t)) return;
  if (!app.doc && t !== 'hand') return;
  app.tool = t;
  $$('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t || (t === 'erase' && b.dataset.tool === 'brush')));
  if (!fromTab) {
    if (t === 'crop' && app.tab !== 'crop') setTab('crop');
    else if (['select', 'brush', 'erase'].includes(t) && app.tab !== 'subject') setTab('subject');
    else if (t !== 'crop' && app.tab === 'crop') setTab('adjust');
  }
  app.emit('tool', t);
  updateHud();
}

function updateHud() {
  const hud = $('#hudMode');
  const msg = !app.doc ? '' :
    app.cropMode ? '<b>Crop</b> · drag corners · drag outside to rotate · <kbd>Enter</kbd> done · <kbd>Esc</kbd> cancel' :
    app.tool === 'select' ? '<b>Tap</b> a person or object to select it · <kbd>Alt</kbd>+click to remove' :
    app.tool === 'brush' ? '<b>Brush</b> paints the selection · <kbd>Alt</kbd> erases · <kbd>[</kbd> <kbd>]</kbd> size' :
    app.tool === 'erase' ? '<b>Erase</b> removes from the selection · <kbd>[</kbd> <kbd>]</kbd> size' :
    app.tool === 'wb' ? '<b>White balance</b> · click something that should be neutral grey or white' : '';
  hud.innerHTML = msg;
  hud.hidden = !msg;
}

function wireTabsAndTools() {
  $$('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool === app.tool && b.dataset.tool !== 'hand' ? 'hand' : b.dataset.tool)));
  $('#zoomIn').onclick = () => app.zoomBy(1.25);
  $('#zoomOut').onclick = () => app.zoomBy(0.8);
  $('#zoomFit').onclick = () => app.fitView();
  app.on('settool', t => setTool(t));
  app.on('settab', t => setTab(t));
  app.on('exitcrop', () => { if (app.cropMode) { exitCrop(true); setTab('adjust'); } });
  app.on('cropmode', () => { updateHud(); drawOverlay(); });
}

// ---------- top bar ----------
function compare(on) {
  if (!app.doc || app.compare === on) return;
  app.compare = on;
  $('#btnCompare').classList.toggle('active', on);
  app.requestRender();
}

function wireTopbar() {
  $('#btnOpen').onclick = () => $('#fileInput').click();
  $('#emptyOpen').onclick = () => $('#fileInput').click();
  $('#btnUndo').onclick = () => store.undo();
  $('#btnRedo').onclick = () => store.redo();
  $('#btnExport').onclick = () => openExport();
  const cmp = $('#btnCompare');
  cmp.addEventListener('pointerdown', () => compare(true));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => cmp.addEventListener(ev, () => compare(false)));
  $('#btnSplit').onclick = () => toggleSplit();
  $('#btnClip').onclick = () => toggleClip();
  $('#btnRevert').onclick = () => {
    if (!app.doc || !store.dirty) return;
    if (!confirm('Revert to the original photo? You can still undo this.')) return;
    store.jump(0);
    toast('Reverted to original.', 'ok', 1800);
  };
  $('#btnKeys').onclick = () => openKeys();
  $('#btnHistory').onclick = () => togglePopover($('#historyPop'), $('#btnHistory'), buildHistory);
  $('#hudZoomBtn').onclick = () => togglePopover($('#zoomPop'), $('#hudZoomBtn'), buildZoomMenu);
  store.on('history', () => {
    $('#btnUndo').disabled = !store.canUndo();
    $('#btnRedo').disabled = !store.canRedo();
    $('#btnUndo').title = store.canUndo() ? `Undo ${store.history[store.index].label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    $('#btnRedo').title = store.canRedo() ? `Redo ${store.history[store.index + 1].label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
    if (!$('#historyPop').hidden) buildHistory();
  });
}

function toggleSplit() { if (!app.doc) return; app.split.on = !app.split.on; $('#btnSplit').classList.toggle('active', app.split.on); app.requestRender(); }
function toggleClip() { if (!app.doc) return; app.clip = !app.clip; $('#btnClip').classList.toggle('active', app.clip); app.requestRender(); }

function buildHistory() {
  const list = $('#historyList');
  list.replaceChildren(...store.history.map((e, i) => {
    const li = h('li', { class: i === store.index ? 'cur' : i > store.index ? 'future' : '' }, h('i', {}, String(i)), e.label);
    li.onclick = () => store.jump(i);
    return li;
  }).reverse());
}

function buildZoomMenu() {
  const pop = $('#zoomPop');
  const item = (label, fn, key) => { const b = h('button', { class: 'menu-item', type: 'button' }, h('span', {}, label), key ? h('kbd', {}, key) : null); b.onclick = () => { fn(); closePopover(); }; return b; };
  pop.replaceChildren(
    item('Fit to screen', () => app.fitView(), 'Ctrl 0'),
    ...[12.5, 25, 50, 100, 200, 400, 800].map(p => item(p + '%', () => app.setZoom(p / 100 * app.dpr), p === 100 ? 'Ctrl 1' : null)));
}

// ---------- files ----------
function wireFiles() {
  const input = $('#fileInput');
  input.onchange = () => { if (input.files[0]) app.openFile(input.files[0]).then(afterOpen); input.value = ''; };
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropOverlay').hidden = !app.doc; $('#dropTarget')?.classList.add('drag'); });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) { $('#dropOverlay').hidden = true; $('#dropTarget')?.classList.remove('drag'); } });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0;
    $('#dropOverlay').hidden = true; $('#dropTarget')?.classList.remove('drag');
    const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/') || /\.(tiff?|heic|heif|psd|tga|qoi|ppm|pgm|pnm|pbm|avif)$/i.test(x.name)) || e.dataTransfer.files[0];
    if (f) app.openFile(f).then(afterOpen);
  });
  window.addEventListener('paste', e => {
    if (isTyping(e)) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    const blob = item.getAsFile();
    const file = new File([blob], `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${(blob.type.split('/')[1] || 'png')}`, { type: blob.type });
    app.openFile(file).then(afterOpen);
  });
  window.addEventListener('beforeunload', e => { if (app.doc && store.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

function afterOpen() {
  if (!app.doc) return;
  $('#panel').classList.remove('disabled');
  $('#btnExport').disabled = false;
  $('#hudZoom').hidden = false;
  setTab(app.tab === 'crop' ? 'adjust' : app.tab);
  if (app.tab === 'subject') app.emit('tab', 'subject');
  setTool(app.tab === 'subject' ? 'select' : 'hand', true);
}

// ---------- status ----------
function wireStatus() {
  const upd = () => {
    if (!app.doc) return;
    const d = app.doc, c = store.state.geo.crop;
    const cw = Math.round(c.w), ch = Math.round(c.h);
    $('#docTitle').innerHTML = '';
    $('#docTitle').append(h('b', {}, d.name), '  ', h('span', { class: 'dims' }, `${d.W}×${d.H}`));
    $('#stDims').textContent = (cw !== d.W || ch !== d.H) ? `${cw} × ${ch} px (cropped from ${d.W} × ${d.H})` : `${d.W} × ${d.H} px · ${(d.W * d.H / 1e6).toFixed(1)} MP`;
  };
  const zoom = () => {
    const z = app.zoomPercent();
    const t = (z >= 100 ? Math.round(z) : z.toFixed(z < 10 ? 1 : 0)) + '%';
    $('#stZoom').textContent = 'Zoom ' + t;
    $('#hudZoomBtn').textContent = t;
  };
  app.on('doc', () => { upd(); zoom(); });
  app.on('view', zoom);
  store.on('change', ({ kind }) => { if (kind === 'geo' || kind === 'all') upd(); });
  store.on('sync', upd);
  app.on('exif', ex => { $('#histMeta').textContent = exifSummary(ex) || ''; const cam = [ex?.make, ex?.model].filter(Boolean).join(' '); $('#histMeta').title = [cam, ex?.lens].filter(Boolean).join(' · '); });
  app.on('doc', () => { $('#histMeta').textContent = ''; });
}

// ---------- keyboard ----------
const SHORTCUTS = [
  ['General', [['Open image', 'Ctrl O'], ['Export', 'Ctrl E'], ['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z'], ['Paste image from clipboard', 'Ctrl V'], ['Copy / paste edit settings', 'Ctrl Shift C / V'], ['Auto enhance', 'Shift A'], ['Keyboard shortcuts', '?']]],
  ['View', [['Hold to see original', '\\'], ['Split before / after', 'Y'], ['Clipping warning', 'J'], ['Fit to screen', 'Ctrl 0'], ['100% zoom', 'Ctrl 1'], ['Zoom in / out', 'Ctrl + / −'], ['Pan', 'Space + drag'], ['Toggle mask overlay', 'M']]],
  ['Tools', [['Move / pan', 'H'], ['Crop & straighten', 'C'], ['Tap-select subject', 'S'], ['Refine brush (add)', 'B'], ['Refine brush (erase)', 'E or Alt'], ['Brush size', '[ ]'], ['White balance picker', 'W']]],
  ['Crop', [['Cycle overlay', 'O'], ['Rotate overlay', 'Shift O'], ['Swap orientation', 'X'], ['Rotate 90°', '[ ]'], ['Reset crop', 'R'], ['Apply', 'Enter'], ['Cancel', 'Esc']]],
];
function openKeys() {
  const g = $('#keysGrid');
  if (!g.childElementCount) {
    for (const [title, rows] of SHORTCUTS) {
      g.append(h('h3', {}, title));
      for (const [label, k] of rows) g.append(h('div', { class: 'key-row' }, h('span', {}, label), h('span', {}, ...k.split(' ').map(x => (x === '/' ? x : h('kbd', {}, x))))));
    }
  }
  openModal($('#keysModal'));
}

function wireKeys() {
  window.addEventListener('keydown', e => {
    const modal = topModal();
    if (e.key === 'Escape') {
      if (modal) { closeModal(modal); return; }
      closePopover();
      if (app.cropMode) { exitCrop(false); setTab('adjust'); return; }
      if (app.tool !== 'hand') setTool('hand');
      return;
    }
    if (modal || isTyping(e)) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod) {
      if (k === 'o') { e.preventDefault(); $('#fileInput').click(); }
      else if (k === 'e' || k === 's') { e.preventDefault(); openExport(); }
      else if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); store.redo(); }
      else if (k === '0') { e.preventDefault(); app.fitView(); }
      else if (k === '1') { e.preventDefault(); app.setZoom(app.dpr); }
      else if (k === '=' || k === '+') { e.preventDefault(); app.zoomBy(1.25); }
      else if (k === '-') { e.preventDefault(); app.zoomBy(0.8); }
      else if (k === 'c' && e.shiftKey) { e.preventDefault(); copySettings(); }
      else if (k === 'v' && e.shiftKey) { e.preventDefault(); pasteSettings(); }
      return;
    }
    if (!app.doc) { if (k === '?') openKeys(); return; }
    if (e.key === '\\') { compare(true); return; }
    if (e.key === '?') { openKeys(); return; }
    if (app.cropMode) {
      if (e.key === 'Enter') { exitCrop(true); setTab('adjust'); return; }
      if (k === 'o') { const n = e.shiftKey ? (rotateOverlay(), null) : cycleOverlay(); if (n) toast('Overlay: ' + n, 'info', 1000); return; }
      if (k === 'x') { swapOrientation(); return; }
      if (k === 'r') { resetGeo(); return; }
      if (e.key === '[') { rotate90(false); return; }
      if (e.key === ']') { rotate90(true); return; }
    }
    if ((app.tool === 'brush' || app.tool === 'erase') && (e.key === '[' || e.key === ']')) {
      brushOpts.size = Math.max(4, Math.min(400, Math.round(brushOpts.size * (e.key === ']' ? 1.15 : 1 / 1.15))));
      app.emit('brush'); return;
    }
    if (e.repeat) return;
    if (k === 'h') setTool('hand');
    else if (k === 'c') setTool('crop');
    else if (k === 's') setTool('select');
    else if (k === 'b') setTool(e.altKey ? 'erase' : 'brush');
    else if (k === 'e') setTool('erase');
    else if (k === 'w') setTool(app.tool === 'wb' ? 'hand' : 'wb');
    else if (k === 'y') toggleSplit();
    else if (k === 'j') toggleClip();
    else if (k === 'm') setMaskView(app.showMask ? 0 : 1);
    else if (k === 'a' && e.shiftKey) autoEnhance();
  });
  window.addEventListener('keyup', e => { if (e.key === '\\') compare(false); });
  window.addEventListener('blur', () => compare(false));
}

boot();
