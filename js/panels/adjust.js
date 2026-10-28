// "Adjust" tab: Light, Color, B&W, Selective Color, Curves, Levels, Grading, Detail, Effects, Vignette.
import { SECTIONS, PARAM, MASTERS, HSL_BANDS, DEPENDENT } from '../schema.js';
import { store, clone } from '../store.js';
import { app } from '../app.js';
import { h, icon, makeSlider, makeFilmstrip, makeWheel, toast, debounce } from '../ui/kit.js';
import { makeSection, actionBtn } from '../ui/section.js';
import { makeCurves } from '../ui/curves.js';
import { isIdentityCurve } from '../params.js';
import { autoLight, autoWhiteBalance, autoLevels } from '../analysis.js';

const sliders = new Map();     // param id → slider
const sections = new Map();    // section id → { sec, def }
const films = new Map();       // section id → filmstrip
let hslBand = 0, hslSliders = null, swatchEls = [], curves = null, wheels = null;
let procHist = null;

const isDefault = id => store.state.p[id] === PARAM[id].def;

function sectionModified(s) {
  const st = store.state;
  if (s.custom === 'hsl') return [...st.hsl.h, ...st.hsl.s, ...st.hsl.l].some(v => v !== 0);
  if (s.custom === 'curves') return !(isIdentityCurve(st.curves.rgb) && isIdentityCurve(st.curves.r) && isIdentityCurve(st.curves.g) && isIdentityCurve(st.curves.b));
  return s.params.some(id => !isDefault(id) && !(DEPENDENT[id] && isDefault(DEPENDENT[id])));
}

function setParam(id, v) {
  store.set(st => {
    st.p[id] = v;
    if (['bwNeutrals', 'bwTone', 'bwGrain'].includes(id) && st.p.bwIntensity === 0 && v !== 0) {
      st.p.bwIntensity = 100; sliders.get('bwIntensity')?.set(100);
    }
    if (st.bypass[sectionOfParam(id)]) st.bypass[sectionOfParam(id)] = false;
  });
  refreshHeaders();
}
const sectionOfParam = id => SECTIONS.find(s => s.params.includes(id))?.id;

function applyValues(values, label) {
  store.set(st => { Object.assign(st.p, values); });
  for (const [k, v] of Object.entries(values)) sliders.get(k)?.set(v);
  refreshHeaders();
  if (label) store.commit(label);
}

export function autoEnhance() {
  if (!app.doc) return;
  const L = autoLight(app.doc.proxy), wb = autoWhiteBalance(app.doc.proxy);
  if (!L) return;
  const { _vibrance, ...light } = L;
  applyValues({ ...light, ...wb, vibrance: _vibrance }, 'Auto Enhance');
  toast('Auto enhance applied — fine-tune any slider.', 'ok', 2400);
}

function buildSection(s) {
  const actions = [];
  if (s.id === 'light') { const b = actionBtn('i-wand', 'Set exposure and tones from the photo', 'Auto'); b.onclick = () => { const L = autoLight(app.doc.proxy); if (L) { delete L._vibrance; applyValues(L, 'Auto Light'); } }; actions.push(b); }
  if (s.id === 'color') {
    const b = actionBtn('i-wand', 'Neutralise the colour cast', 'Auto'); b.onclick = () => applyValues(autoWhiteBalance(app.doc.proxy), 'Auto White Balance'); actions.push(b);
    const p = actionBtn('i-picker', 'Pick a neutral grey in the photo (W)'); p.onclick = () => app.emit('settool', app.tool === 'wb' ? 'hand' : 'wb'); actions.push(p);
    app.on('tool', t => p.classList.toggle('on', t === 'wb'));
  }
  if (s.id === 'levels') { const b = actionBtn('i-wand', 'Stretch to the darkest and brightest tones', 'Auto'); b.onclick = () => applyValues(autoLevels(app.doc.proxy), 'Auto Levels'); actions.push(b); }

  const sec = makeSection({
    id: 'adj-' + s.id, title: s.title, iconId: s.icon, open: ['light', 'color'].includes(s.id), actions,
    onBypass: () => { store.set(st => { st.bypass[s.id] = !st.bypass[s.id]; }); refreshHeaders(); store.commit((store.state.bypass[s.id] ? 'Hide ' : 'Show ') + s.title); },
    onReset: () => resetSection(s),
  });
  sections.set(s.id, { sec, def: s });

  if (s.master) {
    const f = makeFilmstrip({
      onInput: t => {
        const vals = MASTERS[s.id](t);
        store.set(st => { Object.assign(st.p, vals); st.masters[s.id] = t; st.bypass[s.id] = false; });
        for (const [k, v] of Object.entries(vals)) sliders.get(k)?.set(v);
        refreshHeaders();
      },
      onCommit: () => store.commit(s.title),
    });
    films.set(s.id, f);
    sec.body.append(f.el);
    sec.el.addEventListener('toggle', e => e.detail && scheduleFilms());
  }

  if (s.custom === 'hsl') buildHSL(sec.body);
  else if (s.custom === 'curves') {
    curves = makeCurves({
      get: () => store.state.curves,
      onInput: c => { store.set(st => { st.curves = c; st.bypass.curves = false; }); refreshHeaders(); },
      onCommit: () => store.commit('Curves'),
      histogram: ch => procHist && procHist[ch],
    });
    sec.body.append(curves.el);
    sec.el.addEventListener('toggle', e => e.detail && curves.refresh());
  } else if (s.custom === 'grading') {
    const W = [['gsHue', 'gsSat', 'Shadows'], ['gmHue', 'gmSat', 'Midtones'], ['ghHue', 'ghSat', 'Highlights']];
    wheels = W.map(([hu, sa, label]) => {
      const wh = makeWheel({
        label, hue: store.state.p[hu], amount: store.state.p[sa],
        onInput: (hh, aa) => { store.set(st => { st.p[hu] = hh; st.p[sa] = aa; st.bypass.grading = false; }); refreshHeaders(); },
        onCommit: () => store.commit('Color Grading'),
      });
      wh.ids = [hu, sa];
      return wh;
    });
    sec.body.append(h('div', { class: 'wheels' }, wheels.map(w => w.el)));
    addSlider(sec.body, 'gBalance');
  } else {
    for (const id of s.params) addSlider(sec.body, id);
  }
  return sec.el;
}

function addSlider(parent, id) {
  const p = PARAM[id];
  const sl = makeSlider({
    p, value: store.state.p[id],
    onInput: v => setParam(id, v),
    onCommit: () => store.commit(p.label),
  });
  sliders.set(id, sl);
  parent.append(sl.el);
}

function buildHSL(body) {
  const sw = h('div', { class: 'swatches' });
  swatchEls = HSL_BANDS.map((b, i) => {
    const el = h('button', { class: 'swatch', type: 'button', title: b.label, style: { background: b.color } });
    el.onclick = () => { hslBand = i; syncHSL(); };
    sw.append(el);
    return el;
  });
  const mk = (key, label, track) => makeSlider({
    p: { id: 'hsl' + key, label, min: -100, max: 100, def: 0, step: 1, track },
    value: 0,
    onInput: v => { store.set(st => { st.hsl[key][hslBand] = v; st.bypass.hsl = false; }); refreshHeaders(); syncSwatches(); },
    onCommit: () => store.commit('Selective Color'),
  });
  hslSliders = { h: mk('h', 'Hue', 'hue'), s: mk('s', 'Saturation', 'sat'), l: mk('l', 'Luminance', 'mono') };
  const bandName = h('div', { class: 'sub-title' });
  hslSliders.name = bandName;
  body.append(sw, bandName, hslSliders.h.el, hslSliders.s.el, hslSliders.l.el);
  syncHSL();
}
function syncSwatches() {
  const st = store.state;
  swatchEls.forEach((el, i) => { el.classList.toggle('on', i === hslBand); el.classList.toggle('mod', st.hsl.h[i] !== 0 || st.hsl.s[i] !== 0 || st.hsl.l[i] !== 0); });
}
function syncHSL() {
  if (!hslSliders) return;
  const st = store.state;
  hslSliders.name.textContent = HSL_BANDS[hslBand].label;
  hslSliders.h.set(st.hsl.h[hslBand]); hslSliders.s.set(st.hsl.s[hslBand]); hslSliders.l.set(st.hsl.l[hslBand]);
  syncSwatches();
}

function resetSection(s) {
  store.set(st => {
    for (const id of s.params) st.p[id] = PARAM[id].def;
    if (s.master) st.masters[s.id] = 0;
    if (s.custom === 'hsl') st.hsl = { h: Array(8).fill(0), s: Array(8).fill(0), l: Array(8).fill(0) };
    if (s.custom === 'curves') st.curves = { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
    st.bypass[s.id] = false;
  });
  syncAll();
  store.commit('Reset ' + s.title);
}

function refreshHeaders() {
  for (const { sec, def } of sections.values()) {
    sec.setModified(sectionModified(def));
    sec.setBypassed(!!store.state.bypass[def.id]);
  }
}

function syncAll() {
  const st = store.state;
  for (const [id, sl] of sliders) sl.set(st.p[id]);
  for (const [id, f] of films) f.set(st.masters[id] || 0);
  wheels?.forEach(w => w.set(st.p[w.ids[0]], st.p[w.ids[1]]));
  syncHSL();
  curves?.refresh();
  refreshHeaders();
}

// ---------- filmstrips ----------
const scheduleFilms = debounce(renderFilms, 380);
function renderFilms() {
  if (!app.doc || app.tab !== 'adjust') return;
  for (const [id, f] of films) {
    if (!sections.get(id).sec.isOpen()) continue;
    const c = f.canvas, dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) continue;
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const n = Math.max(5, Math.min(11, Math.round(W / (H * 1.1))));
    const tw = W / n;
    const tile = document.createElement('canvas');
    tile.width = Math.ceil(tw); tile.height = H;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n * 2 - 1;
      const s = clone(store.state);
      Object.assign(s.p, MASTERS[id](t));
      s.bypass[id] = false;
      app.drawThumb(tile, { state: s });
      g.drawImage(tile, Math.round(i * tw), 0);
    }
    g.fillStyle = '#0f0e0d'; // frame gaps, like a contact strip
    for (let i = 1; i < n; i++) g.fillRect(Math.round(i * tw) - dpr, 0, 2 * dpr, H);
  }
}

function computeProcHist() {
  const d = app.doc.proxy.data;
  const rgb = new Uint32Array(256), r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) { r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++; rgb[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++; }
  procHist = { rgb, r, g, b };
}

export function buildAdjustPanel(root) {
  const top = h('div', { class: 'subject-hero', style: { display: 'flex', gap: '6px' } },
    h('button', { class: 'btn', type: 'button', style: { flex: '1' }, onclick: autoEnhance, title: 'Look at the photo and set light & colour (Shift+A)' }, 'Auto enhance'),
    h('button', { class: 'btn', type: 'button', title: 'Reset all adjustments', onclick: () => {
      store.set(st => {
        for (const s of SECTIONS) { for (const id of s.params) st.p[id] = PARAM[id].def; st.bypass[s.id] = false; }
        st.masters = { light: 0, color: 0, bw: 0 };
        st.hsl = { h: Array(8).fill(0), s: Array(8).fill(0), l: Array(8).fill(0) };
        st.curves = { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
      });
      syncAll(); store.commit('Reset Adjustments');
    } }, 'Reset all'));
  root.append(top);
  for (const s of SECTIONS) root.append(buildSection(s));

  store.on('sync', () => syncAll());
  app.on('aux', () => scheduleFilms());
  app.on('tab', t => t === 'adjust' && scheduleFilms());
  app.on('doc', () => { computeProcHist(); syncAll(); scheduleFilms(); curves?.refresh(); });
}
