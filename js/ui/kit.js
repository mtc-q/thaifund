// Small UI toolkit: DOM helpers, sliders, filmstrip master slider, colour wheel, toasts, modals.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function icon(id, cls = 'ic') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

const fmtDefault = (p, v) => (p.fmt ? p.fmt(v) : (v > 0 && p.min < 0 ? '+' : '') + (Number.isInteger(p.step) ? Math.round(v) : v.toFixed(2)));

/**
 * Slider row: label, editable value, range track.
 * opts: { p (param def), value, onStart, onInput(v), onCommit(v) }
 */
export function makeSlider(opts) {
  const p = opts.p;
  const range = h('input', { type: 'range', class: 'range' + (p.track ? ' track-' + p.track : ''), min: p.min, max: p.max, step: p.step, 'aria-label': p.label });
  const val = h('input', { class: 'slider-value', type: 'text', spellcheck: 'false', 'aria-label': p.label + ' value' });
  const label = h('span', { class: 'slider-label', title: 'Double-click to reset' }, p.label);
  const defPos = (p.def - p.min) / (p.max - p.min);
  const track = h('div', { class: 'track' + (defPos <= 0.001 || defPos >= 0.999 ? ' at-edge' : ''), style: { '--d': `calc(3.5px + (100% - 7px) * ${defPos})` } }, range);
  const el = h('div', { class: 'slider' }, h('div', { class: 'slider-top' }, label, val), track);
  let current = opts.value ?? p.def, started = false;

  const paint = v => {
    const span = p.max - p.min;
    const pos = x => ((Math.min(p.max, Math.max(p.min, x)) - p.min) / span) * 100;
    const a = pos(p.def), b = pos(v);
    range.style.setProperty('--a', `calc(3.5px + (100% - 7px) * ${Math.min(a, b) / 100})`);
    range.style.setProperty('--b', `calc(3.5px + (100% - 7px) * ${Math.max(a, b) / 100})`);
    el.classList.toggle('changed', Math.abs(v - p.def) > 1e-9);
    if (document.activeElement !== val) val.value = fmtDefault(p, v);
  };
  const set = v => { current = v; range.value = v; paint(v); };
  const start = () => { if (!started) { started = true; opts.onStart && opts.onStart(); } };
  const commit = v => { started = false; opts.onCommit && opts.onCommit(v); };

  range.addEventListener('pointerdown', start);
  range.addEventListener('keydown', start);
  range.addEventListener('input', () => { start(); current = +range.value; paint(current); opts.onInput && opts.onInput(current); });
  range.addEventListener('change', () => commit(+range.value));
  const reset = () => { start(); set(p.def); opts.onInput && opts.onInput(p.def); commit(p.def); };
  range.addEventListener('dblclick', reset);
  label.addEventListener('dblclick', reset);
  val.addEventListener('focus', () => { val.value = String(current); val.select(); });
  val.addEventListener('keydown', e => { if (e.key === 'Enter') val.blur(); if (e.key === 'Escape') { val.value = String(current); val.blur(); } e.stopPropagation(); });
  val.addEventListener('blur', () => {
    const n = parseFloat(val.value.replace(',', '.'));
    if (Number.isFinite(n) && n !== current) {
      const v = Math.min(p.max, Math.max(p.min, n));
      start(); set(v); opts.onInput && opts.onInput(v); commit(v);
    } else paint(current);
  });
  set(current);
  return { el, set, get: () => current };
}

/** Apple-style master slider over a filmstrip of previews. t ∈ [-1, 1]. */
export function makeFilmstrip(opts) {
  const canvas = h('canvas');
  const head = h('div', { class: 'playhead' });
  const el = h('div', { class: 'film', title: 'Drag to adjust · double-click to reset' }, canvas, h('div', { class: 'zero' }), head);
  let t = 0, drag = false;
  const set = v => { t = v; head.style.left = ((v + 1) / 2 * 100) + '%'; };
  const fromEvent = e => { const r = el.getBoundingClientRect(); return Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)); };
  el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); opts.onStart && opts.onStart(); const v = fromEvent(e); set(v); opts.onInput(v); });
  el.addEventListener('pointermove', e => { if (!drag) return; const v = fromEvent(e); set(v); opts.onInput(v); });
  const end = () => { if (!drag) return; drag = false; opts.onCommit && opts.onCommit(t); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { opts.onStart && opts.onStart(); set(0); opts.onInput(0); opts.onCommit && opts.onCommit(0); });
  set(0);
  return { el, canvas, set, get: () => t };
}

let wheelImg = null;
function wheelImage(size) {
  if (wheelImg && wheelImg.width === size) return wheelImg;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), r = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - r, dy = r - (y + 0.5), d = Math.hypot(dx, dy) / (r - 1);
    const i = (y * size + x) * 4;
    if (d > 1) { img.data[i + 3] = 0; continue; }
    const hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
    const [R, G, B] = hsv(hue, Math.min(1, d) * 0.85, 0.78);
    const edge = Math.min(1, (1 - d) * (r - 1));
    img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255 * edge;
  }
  g.putImageData(img, 0, 0);
  return (wheelImg = c);
}
export function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [r * 255, g * 255, b * 255];
}

/** Colour wheel (hue angle + amount radius). */
export function makeWheel(opts) {
  const canvas = h('canvas', { width: 160, height: 160 });
  const dot = h('div', { class: 'wheel-dot' });
  const box = h('div', { class: 'wheel-c' }, canvas, dot);
  const val = h('div', { class: 'wheel-val' });
  const el = h('div', { class: 'wheel', title: 'Drag to tint · double-click to reset' }, box, h('div', { class: 'wheel-label' }, opts.label), val);
  canvas.getContext('2d').drawImage(wheelImage(160), 0, 0);
  let hue = opts.hue, amt = opts.amount, drag = false;
  const paint = () => {
    const a = hue * Math.PI / 180, r = amt / 100 * 0.5;
    dot.style.left = (50 + Math.cos(a) * r * 100) + '%';
    dot.style.top = (50 - Math.sin(a) * r * 100) + '%';
    const [R, G, B] = hsv(hue / 360, amt / 100, 1);
    dot.style.background = amt > 0 ? `rgb(${R | 0},${G | 0},${B | 0})` : '#888';
    val.textContent = amt > 0 ? `${Math.round(hue)}° · ${Math.round(amt)}` : '—';
  };
  const fromEvent = e => {
    const r = box.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5, dy = 0.5 - (e.clientY - r.top) / r.height;
    let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < 0) a += 360;
    const d = Math.min(1, Math.hypot(dx, dy) * 2);
    hue = Math.round(a); amt = Math.round(d * 100); paint(); opts.onInput(hue, amt);
  };
  box.addEventListener('pointerdown', e => { drag = true; box.setPointerCapture(e.pointerId); opts.onStart && opts.onStart(); fromEvent(e); });
  box.addEventListener('pointermove', e => drag && fromEvent(e));
  const end = () => { if (drag) { drag = false; opts.onCommit && opts.onCommit(); } };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('dblclick', () => { amt = 0; paint(); opts.onInput(hue, 0); opts.onCommit && opts.onCommit(); });
  paint();
  return { el, set(hh, aa) { hue = hh; amt = aa; paint(); } };
}

export function seg(items, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const btns = items.map(it => {
    const b = h('button', { type: 'button', title: it.title || it.label, role: 'radio' }, it.icon ? icon(it.icon) : null, it.label || null);
    b.addEventListener('click', () => { set(it.value); onChange(it.value); });
    el.append(b);
    return [it.value, b];
  });
  const set = v => btns.forEach(([k, b]) => { b.classList.toggle('on', k === v); b.setAttribute('aria-checked', k === v); });
  set(value);
  return { el, set };
}

// ---------- feedback ----------
export function toast(msg, type = 'info', ms = 3600) {
  const ico = type === 'err' ? 'i-info' : type === 'ok' ? 'i-check' : 'i-info';
  const t = h('div', { class: 'toast ' + type, role: type === 'err' ? 'alert' : 'status' }, icon(ico), h('div', {}, msg));
  $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, ms);
}

let busyCount = 0;
export function busy(on, text) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (text) $('#busyText').textContent = text;
  $('#busy').hidden = busyCount === 0;
}
export function busyText(text) { $('#busyText').textContent = text; }

// ---------- modals & popovers ----------
const openModals = [];
export function openModal(el) {
  el.hidden = false;
  openModals.push(el);
  const close = () => closeModal(el);
  el._close = close;
  el.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
  el.onpointerdown = e => { if (e.target === el) close(); };
  setTimeout(() => (el.querySelector('[autofocus], .text-input, .btn.primary') || el).focus?.(), 30);
}
export function closeModal(el) {
  el.hidden = true;
  const i = openModals.indexOf(el);
  if (i >= 0) openModals.splice(i, 1);
  el.onclose && el.onclose();
}
export function topModal() { return openModals[openModals.length - 1]; }

export function promptText(title, value = '') {
  return new Promise(resolve => {
    const m = $('#promptModal'), input = $('#promptInput');
    $('#promptTitle').textContent = title;
    input.value = value;
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(m); resolve(v); };
    m.onclose = () => { if (!done) { done = true; resolve(null); } };
    $('#promptOk').onclick = () => finish(input.value.trim() || null);
    input.onkeydown = e => { if (e.key === 'Enter') finish(input.value.trim() || null); e.stopPropagation(); };
    openModal(m);
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

let openPop = null;
export function togglePopover(pop, anchor, build) {
  if (openPop === pop && !pop.hidden) { closePopover(); return; }
  closePopover();
  build && build();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left));
  let y = r.bottom + 6;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  openPop = pop;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
}
function outside(e) { if (openPop && !openPop.contains(e.target)) closePopover(); }
export function closePopover() {
  if (openPop) openPop.hidden = true;
  openPop = null;
  document.removeEventListener('pointerdown', outside, true);
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
