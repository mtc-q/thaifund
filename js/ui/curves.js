// Interactive tone-curve editor (RGB master + per-channel).
import { h, seg } from './kit.js';
import { curveFn } from '../params.js';

const CH = [
  { value: 'rgb', label: 'RGB', color: '#ece6db' },
  { value: 'r', label: 'Red', color: '#ff5a5a' },
  { value: 'g', label: 'Green', color: '#4fd16a' },
  { value: 'b', label: 'Blue', color: '#5a8dff' },
];

export function makeCurves({ get, onStart, onInput, onCommit, histogram }) {
  let chan = 'rgb', drag = -1, dragOut = false, dpr = 1;
  const canvas = h('canvas', { class: 'curve-canvas' });
  const chSeg = seg(CH.map(c => ({ value: c.value, label: c.label })), chan, v => { chan = v; draw(); });
  const resetBtn = h('button', { class: 'btn sm', type: 'button', title: 'Reset this channel' }, 'Reset');
  const el = h('div', { class: 'curve-wrap' },
    h('div', { class: 'curve-tools' }, chSeg.el, resetBtn),
    canvas,
    h('div', { class: 'curve-hint' }, 'Click to add a point · drag to shape · double-click or drag off to remove'));

  const pts = () => get()[chan];
  const size = () => { const r = canvas.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; return { w: r.width, hh: r.height }; };

  function draw() {
    const { w, hh } = size();
    if (!w) return;
    const W = canvas.width = Math.round(w * dpr), H = canvas.height = Math.round(hh * dpr);
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const pad = 6 * dpr, iw = W - 2 * pad, ih = H - 2 * pad;
    const X = x => pad + x * iw, Y = y => pad + (1 - y) * ih;
    // histogram
    const hist = histogram && histogram(chan);
    if (hist) {
      let peak = 1;
      for (let i = 3; i < 253; i++) peak = Math.max(peak, hist[i]);
      g.beginPath(); g.moveTo(X(0), Y(0));
      for (let i = 0; i < 256; i++) g.lineTo(X(i / 255), Y(Math.min(1, Math.sqrt(hist[i] / peak)) * 0.95));
      g.lineTo(X(1), Y(0)); g.closePath();
      g.fillStyle = 'rgba(255,255,255,.07)'; g.fill();
    }
    // grid
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(X(i / 4), Y(0)); g.lineTo(X(i / 4), Y(1)); g.stroke();
      g.beginPath(); g.moveTo(X(0), Y(i / 4)); g.lineTo(X(1), Y(i / 4)); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.14)';
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke();
    // other channels faint
    const all = get();
    for (const c of CH) {
      if (c.value === chan) continue;
      const p = all[c.value];
      if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1) continue;
      plot(g, curveFn(p), X, Y, c.color + '55', 1.2 * dpr);
    }
    const color = CH.find(c => c.value === chan).color;
    plot(g, curveFn(pts()), X, Y, color, 1.8 * dpr);
    for (const [i, p] of pts().entries()) {
      g.beginPath(); g.arc(X(p[0]), Y(p[1]), (i === drag ? 5.5 : 4.5) * dpr, 0, Math.PI * 2);
      g.fillStyle = i === drag ? color : '#121110'; g.fill();
      g.strokeStyle = color; g.lineWidth = 1.6 * dpr; g.stroke();
    }
  }
  function plot(g, f, X, Y, color, lw) {
    g.beginPath();
    for (let i = 0; i <= 128; i++) { const x = i / 128, y = Math.max(0, Math.min(1, f(x))); i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)); }
    g.strokeStyle = color; g.lineWidth = lw; g.stroke();
  }

  const toCurve = e => {
    const r = canvas.getBoundingClientRect(), pad = 6;
    return [(e.clientX - r.left - pad) / (r.width - 2 * pad), 1 - (e.clientY - r.top - pad) / (r.height - 2 * pad), r];
  };
  const setPts = p => { const c = structuredClone(get()); c[chan] = p; onInput(c); draw(); };

  canvas.addEventListener('pointerdown', e => {
    const [x, y, r] = toCurve(e);
    const p = pts();
    let best = -1, bd = 12;
    p.forEach((q, i) => { const d = Math.hypot((q[0] - x) * r.width, (q[1] - y) * r.height); if (d < bd) { bd = d; best = i; } });
    onStart && onStart();
    if (best < 0) {
      const nx = Math.max(0.001, Math.min(0.999, x));
      const ny = Math.max(0, Math.min(1, curveFn(p)(nx)));
      const np = [...p.map(q => [...q]), [nx, Math.abs(y - ny) * r.height < 18 ? ny : Math.max(0, Math.min(1, y))]].sort((a, b) => a[0] - b[0]);
      best = np.findIndex(q => q[0] === nx);
      setPts(np);
    }
    drag = best; dragOut = false;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const [x, y, r] = toCurve(e);
    const p = pts().map(q => [...q]);
    const lo = drag > 0 ? p[drag - 1][0] + 0.01 : 0, hi = drag < p.length - 1 ? p[drag + 1][0] - 0.01 : 1;
    const end = drag === 0 || drag === p.length - 1;
    dragOut = !end && (y < -0.12 || y > 1.12 || x < -0.08 || x > 1.08) && p.length > 2;
    p[drag] = [Math.max(lo, Math.min(hi, x)), Math.max(0, Math.min(1, y))];
    void r;
    setPts(p);
  });
  const end = () => {
    if (drag < 0) return;
    if (dragOut) { const p = pts().filter((_, i) => i !== drag); drag = -1; setPts(p); }
    drag = -1; draw(); onCommit && onCommit();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', e => {
    const [x, y, r] = toCurve(e);
    const p = pts();
    const i = p.findIndex(q => Math.hypot((q[0] - x) * r.width, (q[1] - y) * r.height) < 12);
    if (i > 0 && i < p.length - 1) { onStart && onStart(); setPts(p.filter((_, k) => k !== i)); onCommit && onCommit(); }
  });
  resetBtn.addEventListener('click', () => { onStart && onStart(); setPts([[0, 0], [1, 1]]); onCommit && onCommit(); });
  new ResizeObserver(() => draw()).observe(canvas);
  return { el, refresh: draw };
}
