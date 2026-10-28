// "Looks" tab: built-in looks with live thumbnails, user presets, copy / paste settings.
import { LOOKS } from '../schema.js';
import { store, clone } from '../store.js';
import { app } from '../app.js';
import { h, icon, makeSlider, toast, promptText, debounce } from '../ui/kit.js';
import { makeSection } from '../ui/section.js';

const PKEY = 'thaifund.presets', CKEY = 'thaifund.clipboard';
let lookEls = [], amount, presetList;

const load = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { toast('Could not save to browser storage.', 'err'); return false; } };

export function recipe(st = store.state) {
  return clone({ p: st.p, hsl: st.hsl, curves: st.curves, look: st.look, masters: st.masters, bypass: st.bypass, local: st.local, bg: st.bg });
}
export function applyRecipe(r, label) {
  if (!r || !r.p) return;
  store.set(st => {
    Object.assign(st.p, r.p);
    if (r.hsl) st.hsl = clone(r.hsl);
    if (r.curves) st.curves = clone(r.curves);
    if (r.look) st.look = clone(r.look);
    if (r.masters) st.masters = clone(r.masters);
    st.bypass = clone(r.bypass || {});
    if (r.local) st.local = clone(r.local);
    if (r.bg) st.bg = clone(r.bg);
  }, 'all');
  store.emit('sync', { reason: 'recipe' });
  store.commit(label);
}

export function copySettings() {
  if (!app.doc) return;
  save(CKEY, recipe());
  toast('Edit settings copied. Open another photo and paste (Ctrl+Shift+V).', 'ok');
}
export function pasteSettings() {
  const r = load(CKEY);
  if (!r) { toast('Nothing to paste yet — copy settings first.', 'info'); return; }
  applyRecipe(r, 'Paste Settings');
  toast('Settings pasted.', 'ok', 1800);
}

function setLook(id) {
  store.set(st => { st.look = { id, amount: st.look.id === id ? st.look.amount : 100 }; }, 'all');
  amount.set(store.state.look.amount);
  syncLooks();
  store.commit('Look: ' + LOOKS.find(l => l.id === id).name);
}

function syncLooks() {
  const id = store.state.look.id;
  lookEls.forEach(([lid, el]) => el.classList.toggle('on', lid === id));
  amount.set(store.state.look.amount);
  amount.el.style.opacity = id === 'none' ? 0.4 : 1;
}

const renderThumbs = debounce(() => {
  if (!app.doc || app.tab !== 'looks') return;
  for (const [id, el] of lookEls) {
    const c = el.querySelector('canvas');
    const s = clone(store.state);
    s.look = { id: 'none', amount: 100 };
    app.drawThumb(c, { state: s, look: id });
  }
}, 250);

function renderPresets() {
  const list = load(PKEY) || [];
  presetList.replaceChildren(...list.map((p, i) => {
    const name = h('span', { title: 'Apply ' + p.name }, p.name);
    name.onclick = () => { applyRecipe(p.data, 'Preset: ' + p.name); toast(`Applied “${p.name}”.`, 'ok', 1600); };
    const del = h('button', { class: 'icon-btn', type: 'button', title: 'Delete preset' }, icon('i-trash'));
    del.onclick = () => { if (!confirm(`Delete preset “${p.name}”?`)) return; list.splice(i, 1); save(PKEY, list); renderPresets(); };
    return h('li', {}, name, del);
  }));
  if (!list.length) presetList.append(h('li', { style: { justifyContent: 'center', color: 'var(--text-3)' } }, 'No saved presets yet'));
}

async function savePreset() {
  if (!app.doc) return;
  const name = await promptText('Save preset as', 'My look');
  if (!name) return;
  const list = load(PKEY) || [];
  const i = list.findIndex(p => p.name === name);
  const entry = { name, data: recipe() };
  if (i >= 0) list[i] = entry; else list.push(entry);
  if (save(PKEY, list)) { renderPresets(); toast(`Preset “${name}” saved in this browser.`, 'ok'); }
}

function exportPresets() {
  const list = load(PKEY) || [];
  if (!list.length) { toast('No presets to export.', 'info'); return; }
  const blob = new Blob([JSON.stringify({ app: 'thaifund', version: 1, presets: list }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'thaifund-presets.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importPresets(file) {
  file.text().then(t => {
    const j = JSON.parse(t);
    const incoming = Array.isArray(j) ? j : j.presets;
    if (!Array.isArray(incoming)) throw new Error('bad');
    const list = load(PKEY) || [];
    for (const p of incoming) if (p && p.name && p.data && p.data.p) { const i = list.findIndex(q => q.name === p.name); if (i >= 0) list[i] = p; else list.push(p); }
    save(PKEY, list); renderPresets();
    toast(`Imported ${incoming.length} preset(s).`, 'ok');
  }).catch(() => toast('That file is not a Thaifund preset file.', 'err'));
}

export function buildLooksPanel(root) {
  const sec = makeSection({ id: 'looks', title: 'Looks', iconId: 'i-layers', open: true });
  amount = makeSlider({
    p: { id: 'lookAmount', label: 'Intensity', min: 0, max: 200, def: 100, step: 1, fmt: v => Math.round(v) + '%' },
    value: 100,
    onInput: v => store.set(st => { st.look.amount = v; }),
    onCommit: () => store.commit('Look Intensity'),
  });
  const grid = h('div', { class: 'looks-grid' });
  lookEls = LOOKS.map(l => {
    const el = h('button', { class: 'look', type: 'button', title: l.name }, h('canvas', { width: 120, height: 120 }), l.name);
    el.onclick = () => setLook(l.id);
    grid.append(el);
    return [l.id, el];
  });
  sec.body.append(amount.el, h('div', { style: { height: '10px' } }), grid);
  root.append(sec.el);

  const ps = makeSection({ id: 'presets', title: 'My Presets', iconId: 'i-save', open: true });
  presetList = h('ul', { class: 'preset-list' });
  const fileIn = document.getElementById('presetInput');
  fileIn.onchange = () => { if (fileIn.files[0]) importPresets(fileIn.files[0]); fileIn.value = ''; };
  ps.body.append(
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: savePreset }, icon('i-plus'), 'Save current'),
      h('button', { class: 'btn', type: 'button', onclick: () => fileIn.click(), title: 'Import presets (.json)' }, icon('i-upload'), 'Import'),
      h('button', { class: 'btn', type: 'button', onclick: exportPresets, title: 'Export presets (.json)' }, icon('i-export'), 'Export')),
    presetList,
    h('div', { class: 'sub-title' }, 'Copy edits between photos'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', type: 'button', onclick: copySettings, title: 'Ctrl+Shift+C' }, icon('i-copy'), 'Copy settings'),
      h('button', { class: 'btn', type: 'button', onclick: pasteSettings, title: 'Ctrl+Shift+V' }, icon('i-paste'), 'Paste settings')),
    h('div', { class: 'sec-note' }, 'Presets are stored only in this browser. Crop is never copied.'));
  root.append(ps.el);
  renderPresets();

  store.on('sync', syncLooks);
  app.on('aux', renderThumbs);
  app.on('tab', t => t === 'looks' && renderThumbs());
  app.on('doc', () => { syncLooks(); renderThumbs(); });
}
