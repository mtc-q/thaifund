// "Subject" tab: AI subject detection, tap-to-select, refine brush, subject & background adjustments.
import { LOCAL_PARAMS, BG_PARAMS, SUBJECT_FX, defaultLocal } from '../schema.js';
import { store } from '../store.js';
import { app } from '../app.js';
import { h, icon, makeSlider, seg, toast } from '../ui/kit.js';
import { makeSection } from '../ui/section.js';
import { segmentObjects, segmentPeople, segmentAt } from '../ai/segmenter.js';
import { resizeBilinear, makeGuide, refineMask, components, softRegion, boxMean } from '../ai/refine.js';

// ---------- mask store ----------
const M = {
  w: 1, h: 1, cands: [], brush: null, base: null, final: null, guides: null,
  detected: false, running: false, nextId: 1, brushUsed: false, stroke: null,
};
export const maskStore = M;

const PRETTY = { aeroplane: 'Airplane', diningtable: 'Table', pottedplant: 'Plant', tv: 'Screen', motorbike: 'Motorbike', person: 'Person' };
const CLASS_WEIGHT = { person: 1.6, dog: 1.35, cat: 1.35, bird: 1.3, horse: 1.3, cow: 1.2, sheep: 1.2, car: 1.15, motorbike: 1.15, bicycle: 1.1, bus: 1, train: 1, boat: 1.05, aeroplane: 1.05, bottle: 0.8, chair: 0.6, diningtable: 0.5, sofa: 0.55, tv: 0.6, pottedplant: 0.75 };
const nice = s => PRETTY[s] || (s.charAt(0).toUpperCase() + s.slice(1));

function resetMaskStore(doc) {
  M.w = doc.proxy.w; M.h = doc.proxy.h;
  M.cands = []; M.detected = false; M.running = false; M.nextId = 1; M.brushUsed = false; M.guides = null;
  M.brush = new Int8Array(M.w * M.h);
  M.base = new Float32Array(M.w * M.h);
  M.final = new Uint8Array(M.w * M.h);
}

function guides() {
  if (!M.guides) {
    const long = Math.max(M.w, M.h);
    M.guides = {
      coarse: makeGuide(app.doc.proxy.data, M.w, M.h, Math.max(6, long * 0.013), 2e-3, 2),
      fine: makeGuide(app.doc.proxy.data, M.w, M.h, Math.max(3, long * 0.004), 6e-4, 2),
    };
  }
  return M.guides;
}

function ensureRefined(c) {
  if (!c.refined) c.refined = refineMask(guides(), c.raw, !!c.crisp);
  return c.refined;
}

export function hasSelection() {
  const on = store.state.mask.on;
  return M.cands.some(c => on[c.id]) || M.brushUsed;
}

function recompose() {
  if (!app.doc || !M.base) return;
  const on = store.state.mask.on, n = M.w * M.h;
  M.base.fill(0);
  for (const c of M.cands) {
    if (!on[c.id]) continue;
    const r = ensureRefined(c);
    if (c.mode === 'sub') for (let i = 0; i < n; i++) M.base[i] *= 1 - r[i];
    else for (let i = 0; i < n; i++) if (r[i] > M.base[i]) M.base[i] = r[i];
  }
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, M.base[i] + M.brush[i] / 127));
    M.final[i] = Math.round(v * 255);
    if (M.final[i]) any = true;
  }
  M.brushUsed = M.brush.some(v => v !== 0);
  if (any || M.cands.some(c => on[c.id]) || M.brushUsed) app.setMaskData(M.final, M.w, M.h);
  else app.setMaskData(null);
  refreshUI();
}

function compositeRect(x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * M.w + x;
    M.final[i] = Math.round(Math.max(0, Math.min(1, M.base[i] + M.brush[i] / 127)) * 255);
  }
}

// ---------- AI ----------
let statusEl, statusText, progressBar, chipsEl, detectBtn;
function status(text, frac, kind = 'busy') {
  if (!statusEl) return;
  statusEl.className = 'ai-status ' + kind;
  statusText.textContent = text;
  progressBar.parentElement.hidden = frac === undefined || kind !== 'busy';
  if (frac !== undefined) progressBar.style.width = Math.round(frac * 100) + '%';
}

export async function detectSubjects(force = false) {
  if (!app.doc || M.running) return;
  if (M.detected && !force) return;
  M.running = true;
  detectBtn.disabled = true;
  const t0 = performance.now();
  try {
    const canvas = app.doc.proxy.canvas, W = M.w, H = M.h;
    const res = await segmentObjects(canvas, status);
    status('Analysing subjects…', 1);
    await new Promise(r => setTimeout(r, 0));
    const labels = res.labels.map(s => String(s).toLowerCase());
    const conf = res.masks.map(m => resizeBilinear(m.data, m.w, m.h, W, H));
    // The semantic model's output is low-res with grid artefacts: smooth it (lazily, per class used).
    const smoothR = Math.max(2, Math.round(Math.max(W, H) * 0.005)), smoothed = {};
    const smoothConf = c => smoothed[c] || (smoothed[c] = boxMean(boxMean(conf[c], W, H, smoothR), W, H, smoothR));
    // Work grid for connected components.
    const k = Math.min(1, 320 / Math.max(W, H)), ww = Math.max(4, Math.round(W * k)), wh = Math.max(4, Math.round(H * k));
    const cat = new Uint8Array(ww * wh);
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      const sx = Math.min(W - 1, Math.round((x + 0.5) / k)), sy = Math.min(H - 1, Math.round((y + 0.5) / k)), i = sy * W + sx;
      let best = 0, bv = -1;
      for (let c = 0; c < conf.length; c++) if (conf[c][i] > bv) { bv = conf[c][i]; best = c; }
      cat[y * ww + x] = best;
    }
    const personIdx = labels.indexOf('person');
    let personProb = null, personCrisp = false;
    if (personIdx >= 0 && cat.some(c => c === personIdx)) {
      try {
        const ppl = await segmentPeople(canvas, status);
        if (ppl) {
          // The portrait model is crisp but can hallucinate; keep it near detected people.
          const sp = resizeBilinear(ppl.data, ppl.w, ppl.h, W, H);
          const binP = new Uint8Array(ww * wh);
          for (let i = 0; i < cat.length; i++) binP[i] = cat[i] === personIdx ? 1 : 0;
          const near = resizeBilinear(softRegion(binP, ww, wh, Math.round(Math.max(ww, wh) * 0.05)), ww, wh, W, H);
          let selfieArea = 0, detArea = 0;
          for (let i = 0; i < W * H; i++) { selfieArea += sp[i] * near[i]; if (conf[personIdx][i] > 0.5) detArea++; }
          personCrisp = selfieArea >= 0.55 * detArea;
          const dl = smoothConf(personIdx);
          personProb = new Float32Array(W * H);
          for (let i = 0; i < W * H; i++) personProb[i] = personCrisp ? sp[i] * near[i] : Math.max(dl[i], sp[i] * near[i] * 0.9);
        }
      } catch (e) { console.warn('People model unavailable', e); }
    }
    const found = [];
    const minArea = ww * wh * 0.003;
    for (let c = 1; c < labels.length; c++) {
      if (!cat.some(v => v === c)) continue;
      const bin = new Uint8Array(ww * wh);
      for (let i = 0; i < cat.length; i++) bin[i] = cat[i] === c ? 1 : 0;
      const { labels: lab, comps } = components(bin, ww, wh);
      for (const comp of comps.filter(q => q.area >= minArea).sort((a, b) => b.area - a.area)) {
        const one = new Uint8Array(ww * wh);
        for (let i = 0; i < lab.length; i++) one[i] = lab[i] === comp.id ? 1 : 0;
        const region = resizeBilinear(softRegion(one, ww, wh, Math.max(2, Math.round(Math.max(ww, wh) * 0.035))), ww, wh, W, H);
        const isPerson = c === personIdx && personProb;
        const prob = isPerson ? personProb : smoothConf(c);
        const raw = new Float32Array(W * H);
        for (let i = 0; i < raw.length; i++) raw[i] = prob[i] * region[i];
        const areaF = comp.area / (ww * wh);
        const dx = comp.cx / ww - 0.5, dy = comp.cy / wh - 0.5;
        const centrality = Math.max(0.15, 1 - Math.hypot(dx, dy) / 0.75);
        const score = Math.sqrt(areaF) * centrality * (CLASS_WEIGHT[labels[c]] || 0.8);
        found.push({ cls: labels[c], baseLabel: nice(labels[c]), raw, score, kind: 'auto', mode: 'add', crisp: !!(isPerson && personCrisp) });
      }
    }
    // Label duplicates ("Person 1", "Person 2"), most prominent first.
    found.sort((a, b) => b.score - a.score);
    const seen = {};
    for (const f of found) {
      const total = found.filter(q => q.cls === f.cls).length;
      seen[f.cls] = (seen[f.cls] || 0) + 1;
      f.label = total > 1 ? `${f.baseLabel} ${seen[f.cls]}` : f.baseLabel;
    }
    // Fallback: nothing recognised → tap-segment the centre of the frame.
    if (!found.length) {
      status('No known class found — finding the main subject…', 1);
      const m = await segmentAt(canvas, 0.5, 0.5, status);
      if (m) found.push({ cls: 'object', label: 'Main subject', raw: resizeBilinear(m.data, m.w, m.h, W, H), score: 1, kind: 'center', mode: 'add', crisp: true });
    }
    // Replace previous auto candidates, keep tap-added ones.
    M.cands = M.cands.filter(c => c.kind === 'tap');
    const on = { ...store.state.mask.on };
    for (const k2 of Object.keys(on)) if (!M.cands.some(c => String(c.id) === k2)) delete on[k2];
    const people = found.filter(f => f.cls === 'person');
    const pick = people.length ? people : found.slice(0, 1);
    for (const f of found) {
      const c = { id: M.nextId++, ...f, refined: null };
      M.cands.push(c);
      if (pick.includes(f)) on[c.id] = true;
    }
    M.detected = true;
    store.set(st => { st.mask.on = on; }, 'mask');
    status('Refining edges…', 1);
    await new Promise(r => setTimeout(r, 0));
    recompose();
    store.commit('Select Subject');
    setMaskView(1);
    const ms = Math.round(performance.now() - t0);
    if (!found.length) status('No subject found. Tap on the subject to select it.', undefined, 'err');
    else status(`Found ${found.length} subject${found.length > 1 ? 's' : ''} in ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'} · tap the photo to add more`, undefined, 'ok');
  } catch (e) {
    console.error(e);
    status('AI could not start: ' + (e.message || e), undefined, 'err');
    toast('Subject detection needs a one-time download of the AI models. Check your connection and try again.', 'err', 7000);
  } finally {
    M.running = false;
    detectBtn.disabled = false;
  }
}

export async function tapSelect(u, v, subtract) {
  if (!app.doc || M.running) return;
  M.running = true;
  try {
    const m = await segmentAt(app.doc.proxy.canvas, u, v, status);
    if (!m) throw new Error('Nothing found at that point');
    const raw = resizeBilinear(m.data, m.w, m.h, M.w, M.h);
    const n = M.cands.filter(c => c.kind === 'tap').length + 1;
    const c = { id: M.nextId++, label: subtract ? `Exclude ${n}` : `Object ${n}`, cls: 'tap', kind: 'tap', mode: subtract ? 'sub' : 'add', raw, refined: null, score: 0, crisp: true };
    M.cands.push(c);
    M.detected = true;
    store.set(st => { st.mask.on = { ...st.mask.on, [c.id]: true }; }, 'mask');
    recompose();
    store.commit(subtract ? 'Subtract Selection' : 'Add Selection');
    setMaskView(1);
    status(subtract ? 'Area removed from selection' : 'Added to selection · Alt+click to remove areas', undefined, 'ok');
  } catch (e) {
    console.error(e);
    status('Tap selection failed: ' + (e.message || e), undefined, 'err');
  } finally { M.running = false; }
}

// ---------- brush ----------
export const brushOpts = { size: 60, hardness: 0.5, flow: 0.6, smart: true };

export function strokeBegin() {
  if (!app.doc) return;
  M.stroke = { before: M.brush.slice(), x0: M.w, y0: M.h, x1: -1, y1: -1, last: null };
  setMaskView(1);
}
export function strokeDab(u, v, radiusPx, subtract) {
  const s = M.stroke;
  if (!s) return;
  const cx = u * M.w, cy = v * M.h;
  const pts = [];
  if (s.last) {
    const d = Math.hypot(cx - s.last[0], cy - s.last[1]), step = Math.max(1, radiusPx * 0.22), n = Math.ceil(d / step);
    for (let i = 1; i <= n; i++) pts.push([s.last[0] + (cx - s.last[0]) * i / n, s.last[1] + (cy - s.last[1]) * i / n]);
  } else pts.push([cx, cy]);
  s.last = [cx, cy];
  const data = app.doc.proxy.data;
  const R = Math.max(1, radiusPx), hard = brushOpts.hardness, flow = brushOpts.flow * 0.6;
  let bx0 = M.w, by0 = M.h, bx1 = -1, by1 = -1;
  for (const [px, py] of pts) {
    const x0 = Math.max(0, Math.floor(px - R)), x1 = Math.min(M.w - 1, Math.ceil(px + R));
    const y0 = Math.max(0, Math.floor(py - R)), y1 = Math.min(M.h - 1, Math.ceil(py + R));
    if (x1 < x0 || y1 < y0) continue;
    const ci = (Math.min(M.h - 1, Math.max(0, Math.round(py))) * M.w + Math.min(M.w - 1, Math.max(0, Math.round(px)))) * 4;
    const cr = data[ci], cg = data[ci + 1], cb = data[ci + 2];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - px, y - py) / R;
      if (d >= 1) continue;
      let a = d <= hard ? 1 : 1 - (d - hard) / (1 - hard + 1e-6);
      a = a * a * (3 - 2 * a) * flow;
      const i = y * M.w + x;
      if (brushOpts.smart) {
        const j = i * 4, dr = (data[j] - cr) / 255, dg = (data[j + 1] - cg) / 255, db = (data[j + 2] - cb) / 255;
        a *= Math.exp(-(dr * dr + dg * dg + db * db) / (2 * 0.12 * 0.12));
      }
      const bv = M.brush[i];
      M.brush[i] = subtract ? Math.round(bv - (127 + bv) * a) : Math.round(bv + (127 - bv) * a);
    }
    bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1);
  }
  if (bx1 < 0) return;
  s.x0 = Math.min(s.x0, bx0); s.y0 = Math.min(s.y0, by0); s.x1 = Math.max(s.x1, bx1); s.y1 = Math.max(s.y1, by1);
  compositeRect(bx0, by0, bx1, by1);
  M.brushUsed = true;
  if (!app.maskInfo.has) app.setMaskData(M.final, M.w, M.h);
  else app.updateMaskRect(M.final, M.w, bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1);
}
export function strokeEnd() {
  const s = M.stroke;
  M.stroke = null;
  if (!s || s.x1 < 0) return;
  const rw = s.x1 - s.x0 + 1, rh = s.y1 - s.y0 + 1;
  const before = new Int8Array(rw * rh), after = new Int8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const o = (s.y0 + y) * M.w + s.x0;
    before.set(s.before.subarray(o, o + rw), y * rw);
    after.set(M.brush.subarray(o, o + rw), y * rw);
  }
  store.commit('Refine Brush', { kind: 'brush', x: s.x0, y: s.y0, w: rw, h: rh, before, after });
  refreshUI();
}
function applyPatch(p, dir) {
  if (p.kind !== 'brush' || !M.brush) return;
  const src = dir < 0 ? p.before : p.after;
  for (let y = 0; y < p.h; y++) M.brush.set(src.subarray(y * p.w, (y + 1) * p.w), (p.y + y) * M.w + p.x);
}

// ---------- UI ----------
let maskViewSeg, local = { subject: new Map(), background: new Map() }, bgModeSeg, bgColorInput, featherSl, shiftSl, invertChk;
let lockedEls = [], toolSeg, brushBox, chipsHint;

export function setMaskView(v) {
  app.showMask = v;
  maskViewSeg?.set(v);
  app.requestRender();
}

function chip(c) {
  const on = !!store.state.mask.on[c.id];
  const el = h('button', { class: 'chip' + (on ? ' on' : '') + (c.mode === 'sub' ? ' sub' : ''), type: 'button', title: on ? 'Click to deselect' : 'Click to select' },
    h('span', { class: 'tick' }, icon('i-check')), c.label);
  el.onclick = e => {
    if (e.target.closest('.x')) return;
    store.set(st => { st.mask.on = { ...st.mask.on, [c.id]: !st.mask.on[c.id] }; }, 'mask');
    recompose();
    store.commit((store.state.mask.on[c.id] ? 'Select ' : 'Deselect ') + c.label);
    setMaskView(1);
  };
  if (c.kind === 'tap') {
    const x = h('span', { class: 'x', title: 'Remove' }, icon('i-x'));
    x.onclick = () => { M.cands = M.cands.filter(q => q !== c); store.set(st => { const o = { ...st.mask.on }; delete o[c.id]; st.mask.on = o; }, 'mask'); recompose(); store.commit('Remove ' + c.label); };
    el.append(x);
  }
  return el;
}

function refreshUI() {
  if (!chipsEl) return;
  chipsEl.replaceChildren(...M.cands.map(chip));
  chipsHint.hidden = M.cands.length > 0;
  const has = hasSelection();
  for (const el of lockedEls) el.classList.toggle('disabled', !has);
  for (const el of lockedEls) el.querySelector('.lock-note').hidden = has;
}

function localSlider(target, p) {
  const sl = makeSlider({
    p, value: store.state.local[target][p.id],
    onStart: () => { if (app.showMask === 1) setMaskView(0); },
    onInput: v => store.set(st => { st.local[target][p.id] = v; }, 'local'),
    onCommit: () => store.commit((target === 'subject' ? 'Subject ' : 'Background ') + p.label),
  });
  local[target].set(p.id, sl);
  return sl.el;
}

function applyFx(fx) {
  if (!hasSelection()) { toast('Select a subject first.', 'info'); return; }
  store.set(st => {
    st.local.subject = { ...defaultLocal(false), ...fx.subj };
    st.local.background = { ...defaultLocal(true), ...fx.bg };
    st.bg.mode = fx.mode;
    if (fx.color) st.bg.color = fx.color;
  }, 'local');
  syncUI();
  setMaskView(0);
  store.commit(fx.name);
}

function syncUI() {
  const st = store.state;
  for (const t of ['subject', 'background']) for (const [id, sl] of local[t]) sl.set(st.local[t][id]);
  bgModeSeg?.set(st.bg.mode);
  if (bgColorInput) bgColorInput.value = st.bg.color;
  featherSl?.set(st.mask.feather); shiftSl?.set(st.mask.shift);
  if (invertChk) invertChk.checked = st.mask.invert;
}

export function buildSubjectPanel(root) {
  // Hero: detection
  detectBtn = h('button', { class: 'btn', type: 'button', style: { flex: '1' }, title: 'Look for people and objects in the photo' }, icon('i-subject'), 'Find subject');
  detectBtn.onclick = () => detectSubjects(true);
  const tapBtn = h('button', { class: 'btn', type: 'button', title: 'Tap any object in the photo to select it (S)' }, icon('i-tap'), 'Tap to add');
  tapBtn.onclick = () => app.emit('settool', 'select');
  app.on('tool', t => tapBtn.classList.toggle('active', t === 'select'));
  statusText = h('span', {}, 'Runs in this tab. The photo is not uploaded.');
  statusEl = h('div', { class: 'ai-status' }, h('span', { class: 'dot' }), statusText);
  progressBar = h('i');
  const prog = h('div', { class: 'progress', hidden: true }, progressBar);
  chipsEl = h('div', { class: 'chips' });
  chipsHint = h('div', { class: 'empty-hint' }, 'Nothing selected yet. Find the subject, or tap something in the photo.');
  root.append(h('div', { class: 'subject-hero' }, h('p', { class: 'lede' }, 'Pick out the people or things in your photo, then treat them and the background separately.'), h('div', { class: 'tool-row' }, detectBtn, tapBtn), statusEl, prog, chipsEl, chipsHint));

  // Refine
  const refine = makeSection({ id: 'subj-refine', title: 'Refine the edges', open: true });
  toolSeg = seg([
    { value: 'select', label: 'Tap', icon: 'i-tap', title: 'Tap to select an object (Alt+click removes)' },
    { value: 'brush+', label: 'Add', icon: 'i-brush-plus', title: 'Paint to add to the selection (B)' },
    { value: 'brush-', label: 'Erase', icon: 'i-brush-minus', title: 'Paint to remove from the selection (Alt+B)' },
  ], null, v => app.emit('settool', v === 'select' ? 'select' : v === 'brush+' ? 'brush' : 'erase'));
  app.on('tool', t => toolSeg.set(t === 'select' ? 'select' : t === 'brush' ? 'brush+' : t === 'erase' ? 'brush-' : null));
  const size = makeSlider({ p: { id: 'bsize', label: 'Brush Size', min: 4, max: 400, def: 60, step: 1, fmt: v => Math.round(v) + ' px' }, value: brushOpts.size, onInput: v => { brushOpts.size = v; app.emit('brush'); } });
  const hard = makeSlider({ p: { id: 'bhard', label: 'Hardness', min: 0, max: 100, def: 50, step: 1 }, value: brushOpts.hardness * 100, onInput: v => { brushOpts.hardness = v / 100; } });
  const flow = makeSlider({ p: { id: 'bflow', label: 'Flow', min: 5, max: 100, def: 60, step: 1 }, value: brushOpts.flow * 100, onInput: v => { brushOpts.flow = v / 100; } });
  const smart = h('label', { class: 'check', title: 'Only paints over colours similar to the brush centre — follows edges' }, h('input', { type: 'checkbox', checked: brushOpts.smart, onchange: e => { brushOpts.smart = e.target.checked; } }), 'Smart edges');
  app.on('brush', () => size.set(brushOpts.size));
  brushBox = h('div', {}, size.el, hard.el, flow.el, smart);
  maskViewSeg = seg([{ value: 0, label: 'Off' }, { value: 1, label: 'Overlay' }, { value: 2, label: 'Mask' }], 0, v => { app.showMask = v; app.requestRender(); });
  featherSl = makeSlider({ p: { id: 'feather', label: 'Feather', min: 0, max: 100, def: 0, step: 1 }, value: 0, onInput: v => store.set(st => { st.mask.feather = v; }, 'mask'), onCommit: () => store.commit('Feather') });
  shiftSl = makeSlider({ p: { id: 'shift', label: 'Shift Edge', min: -100, max: 100, def: 0, step: 1 }, value: 0, onInput: v => store.set(st => { st.mask.shift = v; }, 'mask'), onCommit: () => store.commit('Shift Edge') });
  invertChk = h('input', { type: 'checkbox', onchange: e => { store.set(st => { st.mask.invert = e.target.checked; }, 'mask'); store.commit('Invert Selection'); } });
  const clearBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => {
    M.brush?.fill(0);
    store.set(st => { st.mask.on = {}; }, 'mask');
    recompose(); store.commit('Clear Selection');
  } }, icon('i-trash'), 'Clear');
  refine.body.append(
    toolSeg.el, h('div', { style: { height: '8px' } }), brushBox,
    h('div', { class: 'sub-title' }, 'Mask view'), maskViewSeg.el,
    h('div', { class: 'sub-title' }, 'Edges'), featherSl.el, shiftSl.el,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('label', { class: 'check' }, invertChk, 'Invert selection'), clearBtn),
  );
  root.append(refine.el);

  // Quick effects
  const fxSec = makeSection({ id: 'subj-fx', title: 'Quick effects', open: true });
  const grid = h('div', { class: 'fx-list' }, SUBJECT_FX.map(fx => h('button', { class: 'fx', type: 'button', onclick: () => applyFx(fx) }, h('b', {}, fx.name), h('small', {}, fx.desc))));
  fxSec.body.append(h('div', { class: 'lock-note sec-note', hidden: true }, 'Select a subject first.'), grid);
  lockedEls.push(fxSec.el);
  root.append(fxSec.el);

  // Background
  const bg = makeSection({ id: 'subj-bg', title: 'Background', open: true });
  bgModeSeg = seg([{ value: 'keep', label: 'Photo' }, { value: 'transparent', label: 'Transparent' }, { value: 'color', label: 'Color' }], 'keep', v => { store.set(st => { st.bg.mode = v; }, 'local'); store.commit('Background ' + v); });
  bgColorInput = h('input', { type: 'color', class: 'color-input', value: '#ffffff', title: 'Background colour' });
  bgColorInput.oninput = () => store.set(st => { st.bg.color = bgColorInput.value; st.bg.mode = 'color'; bgModeSeg.set('color'); }, 'local');
  bgColorInput.onchange = () => store.commit('Background Color');
  bg.body.append(h('div', { class: 'lock-note sec-note', hidden: true }, 'Select a subject first. Then you can blur, darken or replace everything behind it.'),
    h('div', { class: 'row' }, bgModeSeg.el, bgColorInput));
  for (const p of BG_PARAMS) bg.body.append(localSlider('background', p));
  bg.body.append(h('div', { class: 'sub-title' }, 'Adjust background'));
  for (const p of LOCAL_PARAMS) bg.body.append(localSlider('background', p));
  lockedEls.push(bg.el);
  root.append(bg.el);

  // Subject
  const sj = makeSection({ id: 'subj-subject', title: 'Subject', open: true });
  sj.body.append(h('div', { class: 'lock-note sec-note', hidden: true }, 'Select a subject first. Then you can brighten, sharpen or recolour just them.'));
  for (const p of LOCAL_PARAMS) sj.body.append(localSlider('subject', p));
  lockedEls.push(sj.el);
  root.append(sj.el);

  store.patchHandler = (p, dir) => applyPatch(p, dir);
  store.on('sync', ({ reason }) => { syncUI(); if (reason === 'history') recompose(); });
  app.on('doc', doc => {
    resetMaskStore(doc);
    status('Runs in this tab. The photo is not uploaded.', undefined, '');
    refreshUI(); syncUI();
  });
  app.on('tab', t => {
    if (t === 'subject' && app.doc && !M.detected && !M.running) detectSubjects();
    if (t !== 'subject' && app.showMask) setMaskView(0);
  });
  refreshUI();
}
