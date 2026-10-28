// Image analysis: EXIF, auto enhance, auto white balance, auto levels, auto straighten.

const s2l = x => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const S2L = new Float32Array(256).map((_, i) => s2l(i / 255));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- EXIF ----------
export async function readExif(file) {
  const buf = await file.slice(0, 512 * 1024).arrayBuffer();
  const dv = new DataView(buf);
  try {
    if (dv.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off < dv.byteLength - 10) {
      const marker = dv.getUint16(off), len = dv.getUint16(off + 2);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) return parseTiff(dv, off + 10);
      off += 2 + len;
    }
  } catch { /* malformed */ }
  return null;
}

function parseTiff(dv, start) {
  const le = dv.getUint16(start) === 0x4949;
  const u16 = o => dv.getUint16(start + o, le), u32 = o => dv.getUint32(start + o, le), i32 = o => dv.getInt32(start + o, le);
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const readIFD = at => {
    const n = u16(at), tags = {};
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (sizes[type] || 1) * count, p = size > 4 ? u32(e + 8) : e + 8;
      try {
        if (type === 2) { let s = ''; for (let k = 0; k < count - 1; k++) s += String.fromCharCode(dv.getUint8(start + p + k)); tags[tag] = s.trim(); }
        else if (type === 3) tags[tag] = u16(p);
        else if (type === 4) tags[tag] = u32(p);
        else if (type === 5) tags[tag] = u32(p) / (u32(p + 4) || 1);
        else if (type === 10) tags[tag] = i32(p) / (i32(p + 4) || 1);
      } catch { /* out of range */ }
    }
    return tags;
  };
  const ifd0 = readIFD(u32(4));
  const exif = ifd0[0x8769] ? readIFD(ifd0[0x8769]) : {};
  return {
    make: ifd0[0x010F], model: ifd0[0x0110], software: ifd0[0x0131],
    lens: exif[0xA434], iso: exif[0x8827], exposure: exif[0x829A], fnumber: exif[0x829D],
    focal: exif[0x920A], focal35: exif[0xA405], date: exif[0x9003],
  };
}

export function exifSummary(ex) {
  if (!ex) return '';
  const parts = [];
  if (ex.iso) parts.push('ISO ' + ex.iso);
  if (ex.exposure) parts.push(ex.exposure >= 1 ? ex.exposure.toFixed(1) + 's' : '1/' + Math.round(1 / ex.exposure));
  if (ex.fnumber) parts.push('ƒ/' + (+ex.fnumber.toFixed(1)));
  if (ex.focal) parts.push(Math.round(ex.focal) + ' mm');
  return parts.join('  ');
}

// ---------- sampling helpers ----------
function sampleStride(px) { return Math.max(1, Math.floor(Math.sqrt(px / 200000))); }

/** Suggested Light/Color settings from image statistics. */
export function autoLight(proxy) {
  const { data, w, h } = proxy, st = sampleStride(w * h);
  const hist = new Uint32Array(256);
  let n = 0, satSum = 0;
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist[(r * 54 + g * 183 + b * 19) >> 8]++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx ? (mx - mn) / mx : 0; n++;
  }
  if (!n) return null;
  const pct = q => { let acc = 0; const t = q * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= t) return i / 255; } return 1; };
  const p005 = pct(0.005), p25 = pct(0.25), p50 = pct(0.5), p75 = pct(0.75), p995 = pct(0.995);
  const darkFrac = hist.slice(0, 40).reduce((a, b) => a + b, 0) / n;
  const brightFrac = hist.slice(240).reduce((a, b) => a + b, 0) / n;

  const medLin = Math.max(s2l(p50), 1e-4);
  let ev = clamp(Math.log2(0.2 / medLin) * 0.55, -1.5, 1.6);
  if (Math.abs(ev) < 0.07) ev = 0;
  const hiAfter = s2l(p995) * Math.pow(2, ev);
  const out = { exposure: +ev.toFixed(2) };
  out.highlights = Math.round(clamp(-(hiAfter - 0.85) * 90 - brightFrac * 120, -70, 0));
  out.shadows = Math.round(clamp(darkFrac * 140 - (ev > 0 ? ev * 15 : 0), 0, 50));
  out.blackPoint = Math.round(clamp((p005 - 0.03) * 220, 0, 35));
  const iqr = p75 - p25;
  out.contrast = Math.round(clamp((0.38 - iqr) * 70, -10, 25));
  out.brilliance = Math.round(clamp(10 + darkFrac * 40, 0, 30));
  out.brightness = 0;
  out.whites = Math.round(clamp((0.92 - p995) * 60, 0, 25));
  out._vibrance = Math.round(clamp((0.3 - satSum / n) * 80, 0, 25));
  return out;
}

function wbFromRGB(R, G, B, strength = 1) {
  const lr = Math.log2(Math.max(R, 1e-5)), lg = Math.log2(Math.max(G, 1e-5)), lb = Math.log2(Math.max(B, 1e-5));
  const t = (lb - lr) / 1.2;
  const g = (lg - lr - 0.6 * t) / 0.6;
  return { warmth: Math.round(clamp(t * 100 * strength, -100, 100)), tint: Math.round(clamp(g * 100 * strength, -100, 100)) };
}

/** Grey-world estimate restricted to near-neutral midtones. */
export function autoWhiteBalance(proxy) {
  const { data, w, h } = proxy, st = sampleStride(w * h);
  let R = 0, G = 0, B = 0, n = 0, R2 = 0, G2 = 0, B2 = 0, n2 = 0;
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = (r * 54 + g * 183 + b * 19) >> 8;
    if (L < 25 || mx > 250) continue;
    const lr = S2L[r], lg = S2L[g], lb = S2L[b];
    R2 += lr; G2 += lg; B2 += lb; n2++;
    if ((mx - mn) / mx < 0.3) { R += lr; G += lg; B += lb; n++; }
  }
  if (n < 200) { R = R2; G = G2; B = B2; n = n2; }
  if (!n) return { warmth: 0, tint: 0 };
  return wbFromRGB(R / n, G / n, B / n, 0.65);
}

/** White balance from a picked neutral point (u, v in source uv). */
export function pickWhiteBalance(proxy, u, v) {
  const { data, w, h } = proxy;
  const cx = Math.round(u * (w - 1)), cy = Math.round(v * (h - 1));
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    R += S2L[data[i]]; G += S2L[data[i + 1]]; B += S2L[data[i + 2]]; n++;
  }
  if (!n) return null;
  return wbFromRGB(R / n, G / n, B / n, 1);
}

export function autoLevels(proxy) {
  const { data, w, h } = proxy, st = sampleStride(w * h);
  const hist = new Uint32Array(256); let n = 0;
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const i = (y * w + x) * 4;
    hist[Math.min(data[i], data[i + 1], data[i + 2])]++;
    hist[Math.max(data[i], data[i + 1], data[i + 2])]++;
    n += 2;
  }
  const pct = q => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= q * n) return i; } return 255; };
  const lo = pct(0.002), hi = pct(0.998);
  return { lvInBlack: Math.min(lo, 80), lvInWhite: Math.max(hi, 170), lvGamma: 1 };
}

/** Detects the dominant near-horizontal/vertical edge tilt. Returns a straighten angle in degrees, or null. */
export function autoStraighten(proxy, geo) {
  const { data, w: pw, h: ph } = proxy;
  const k = Math.min(1, 720 / Math.max(pw, ph));
  const w = Math.max(8, Math.round(pw * k)), h = Math.max(8, Math.round(ph * k));
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(pw - 1, Math.round(x / k)), sy = Math.min(ph - 1, Math.round(y / k)), i = (sy * pw + sx) * 4;
    g[y * w + x] = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  }
  const mags = [], devs = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
    const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
    const m = Math.hypot(gx, gy);
    if (m < 40) continue;
    let d = (Math.atan2(gy, gx) * 180 / Math.PI) % 90;
    d = ((d + 135) % 90) - 45;
    if (Math.abs(d) > 20) continue;
    mags.push(m); devs.push(d);
  }
  if (mags.length < 200) return null;
  const sorted = Float32Array.from(mags).sort();
  const thr = sorted[Math.floor(sorted.length * 0.8)];
  const BINS = 401, hist = new Float32Array(BINS); // 0.1° bins over [-20, 20]
  for (let i = 0; i < mags.length; i++) if (mags[i] >= thr) hist[Math.round((devs[i] + 20) * 10)] += mags[i];
  const sm = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) { let s = 0, ws = 0; for (let j = -6; j <= 6; j++) { const k2 = i + j; if (k2 < 0 || k2 >= BINS) continue; const wt = Math.exp(-j * j / 18); s += hist[k2] * wt; ws += wt; } sm[i] = s / ws; }
  let best = 0;
  for (let i = 1; i < BINS; i++) if (sm[i] > sm[best]) best = i;
  const total = sm.reduce((a, b) => a + b, 0) / BINS;
  if (sm[best] < total * 2.2) return null;
  const tilt = best / 10 - 20;
  const mirrored = geo.flipH !== geo.flipV;
  const angle = -tilt * (mirrored ? -1 : 1);
  return Math.abs(angle) < 0.05 ? 0 : +angle.toFixed(2);
}
