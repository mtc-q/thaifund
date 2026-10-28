// Image encoders. Every encoder takes { data: Uint8ClampedArray RGBA, w, h } and returns a Blob.
// Native (canvas) encoders: JPEG, PNG, WebP, AVIF. Everything else is written byte by byte here.

export const FORMATS = [
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', alpha: false, quality: true, note: 'Best for photos and sharing. Lossy, no transparency.' },
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', alpha: true, note: 'Lossless, supports transparency.' },
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', alpha: true, quality: true, native: true, note: 'Modern web format — small files, supports transparency.' },
  { id: 'avif', label: 'AVIF', ext: 'avif', mime: 'image/avif', alpha: true, quality: true, native: true, note: 'Next-gen compression. Encoding depends on your browser.' },
  { id: 'tiff', label: 'TIFF', ext: 'tif', mime: 'image/tiff', alpha: true, note: 'Lossless archival / print format.' },
  { id: 'psd', label: 'PSD', ext: 'psd', mime: 'image/vnd.adobe.photoshop', alpha: true, note: 'Photoshop document (flattened, 8-bit RGB).' },
  { id: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp', alpha: true, note: 'Uncompressed Windows bitmap.' },
  { id: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif', alpha: true, note: 'Up to 256 colours. Best for graphics, not photos.' },
  { id: 'ico', label: 'ICO', ext: 'ico', mime: 'image/x-icon', alpha: true, note: 'Windows / favicon icon with multiple sizes.' },
  { id: 'tga', label: 'TGA', ext: 'tga', mime: 'image/x-tga', alpha: true, note: 'Truevision Targa, common in games and video.' },
  { id: 'dds', label: 'DDS', ext: 'dds', mime: 'image/vnd-ms.dds', alpha: true, note: 'DirectDraw Surface texture (uncompressed BGRA).' },
  { id: 'qoi', label: 'QOI', ext: 'qoi', mime: 'image/qoi', alpha: true, note: 'Quite OK Image — fast lossless format.' },
  { id: 'ppm', label: 'PPM', ext: 'ppm', mime: 'image/x-portable-pixmap', alpha: false, note: 'Netpbm portable pixmap (binary P6).' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', alpha: false, quality: true, note: 'Single-page PDF sized by the DPI setting.' },
  { id: 'svg', label: 'SVG', ext: 'svg', mime: 'image/svg+xml', alpha: true, note: 'SVG wrapper with the photo embedded (raster).' },
  { id: 'hdr', label: 'HDR', ext: 'hdr', mime: 'image/vnd.radiance', alpha: false, note: 'Radiance RGBE, linear light.' },
];

const support = {};
export async function detectSupport() {
  for (const mime of ['image/webp', 'image/avif']) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 4;
      const b = await new Promise(r => c.toBlob(r, mime, 0.8));
      support[mime] = !!b && b.type === mime;
    } catch { support[mime] = false; }
  }
  return support;
}
export const isSupported = f => !f.native || support[f.mime] !== false;

// ---------- helpers ----------
const enc = new TextEncoder();
const ascii = s => enc.encode(s);

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function flatten(img, bg = [255, 255, 255]) {
  const d = img.data, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + bg[0] * (1 - a);
    out[i + 1] = d[i + 1] * a + bg[1] * (1 - a);
    out[i + 2] = d[i + 2] * a + bg[2] * (1 - a);
    out[i + 3] = 255;
  }
  return { data: out, w: img.w, h: img.h };
}
export function hasTransparency(img) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

export function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.w; c.height = img.h;
  const g = c.getContext('2d');
  if (!g) throw new Error(`The browser could not allocate a ${img.w}×${img.h} canvas. Try a smaller export size.`);
  g.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return c;
}
function canvasBlob(img, mime, quality) {
  const c = toCanvas(img);
  return new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error(`The browser could not encode ${img.w}×${img.h} as ${mime}. Try a smaller size.`))), mime, quality));
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- PNG / JPEG with DPI ----------
async function pngWithDpi(blob, dpi) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set(ascii('pHYs'), 4);
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk, 4, 17));
  const ihdrEnd = 8 + 25;
  // drop an existing pHYs chunk if present
  const parts = [b.subarray(0, ihdrEnd), chunk];
  let p = ihdrEnd;
  const bd = new DataView(b.buffer, b.byteOffset);
  while (p < b.length) {
    const len = bd.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type !== 'pHYs') parts.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  return new Blob([concat(parts)], { type: 'image/png' });
}

async function jpegWithDpi(blob, dpi) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const d = Math.min(65535, Math.round(dpi));
  if (b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(...b.subarray(6, 10)) === 'JFIF') {
    b[13] = 1; b[14] = d >> 8; b[15] = d & 255; b[16] = d >> 8; b[17] = d & 255;
    return new Blob([b], { type: 'image/jpeg' });
  }
  const app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 2, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  return new Blob([b.subarray(0, 2), app0, b.subarray(2)], { type: 'image/jpeg' });
}

// ---------- BMP ----------
function encodeBMP(img, dpi) {
  const { w, h, data } = img, alpha = hasTransparency(img);
  const ppm = Math.round(dpi / 0.0254);
  if (alpha) {
    const hdr = 14 + 108, size = hdr + w * h * 4;
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4D; dv.setUint32(2, size, true); dv.setUint32(10, hdr, true);
    dv.setUint32(14, 108, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 32, true); dv.setUint32(30, 3, true); dv.setUint32(34, w * h * 4, true);
    dv.setInt32(38, ppm, true); dv.setInt32(42, ppm, true);
    dv.setUint32(54, 0x00FF0000, true); dv.setUint32(58, 0x0000FF00, true); dv.setUint32(62, 0x000000FF, true); dv.setUint32(66, 0xFF000000, true);
    dv.setUint32(70, 0x73524742, true);
    let o = hdr;
    for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o++] = data[i + 2]; out[o++] = data[i + 1]; out[o++] = data[i]; out[o++] = data[i + 3];
    }
    return out;
  }
  const row = Math.ceil(w * 3 / 4) * 4, hdr = 54, size = hdr + row * h;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4D; dv.setUint32(2, size, true); dv.setUint32(10, hdr, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, row * h, true);
  dv.setInt32(38, ppm, true); dv.setInt32(42, ppm, true);
  for (let y = 0; y < h; y++) {
    let o = hdr + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; out[o++] = data[i + 2]; out[o++] = data[i + 1]; out[o++] = data[i]; }
  }
  return out;
}

// ---------- TIFF ----------
async function encodeTIFF(img, dpi, compression) {
  const { w, h, data } = img, alpha = hasTransparency(img), spp = alpha ? 4 : 3;
  let pix = new Uint8Array(w * h * spp);
  for (let i = 0, j = 0; i < w * h; i++) { pix[j++] = data[i * 4]; pix[j++] = data[i * 4 + 1]; pix[j++] = data[i * 4 + 2]; if (alpha) pix[j++] = data[i * 4 + 3]; }
  const deflate = compression === 'deflate' && typeof CompressionStream === 'function';
  if (deflate) {
    const rb = w * spp;
    for (let y = 0; y < h; y++) for (let x = rb - 1; x >= spp; x--) pix[y * rb + x] = (pix[y * rb + x] - pix[y * rb + x - spp]) & 255;
    pix = new Uint8Array(await new Response(new Blob([pix]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  }
  const software = ascii('Thaifund\0');
  const entries = [
    [256, 4, 1, w], [257, 4, 1, h], [258, 3, spp, null], [259, 3, 1, deflate ? 8 : 1], [262, 3, 1, 2],
    [273, 4, 1, null], [274, 3, 1, 1], [277, 3, 1, spp], [278, 4, 1, h], [279, 4, 1, pix.length],
    [282, 5, 1, null], [283, 5, 1, null], [284, 3, 1, 1], [296, 3, 1, 2], [305, 2, software.length, null],
  ];
  if (deflate) entries.push([317, 3, 1, 2]);
  if (alpha) entries.push([338, 3, 1, 2]);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const bpsOff = extra; extra += spp * 2;
  const xresOff = extra; extra += 8;
  const yresOff = extra; extra += 8;
  const swOff = extra; extra += software.length + (software.length & 1);
  const dataOff = extra;
  const out = new Uint8Array(dataOff + pix.length), dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], k) => {
    const e = 10 + k * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (tag === 258) dv.setUint32(e + 8, bpsOff, true);
    else if (tag === 273) dv.setUint32(e + 8, dataOff, true);
    else if (tag === 282) dv.setUint32(e + 8, xresOff, true);
    else if (tag === 283) dv.setUint32(e + 8, yresOff, true);
    else if (tag === 305) dv.setUint32(e + 8, swOff, true);
    else if (type === 3) dv.setUint16(e + 8, value, true);
    else dv.setUint32(e + 8, value, true);
  });
  dv.setUint32(10 + entries.length * 12, 0, true);
  for (let i = 0; i < spp; i++) dv.setUint16(bpsOff + i * 2, 8, true);
  dv.setUint32(xresOff, Math.round(dpi * 100), true); dv.setUint32(xresOff + 4, 100, true);
  dv.setUint32(yresOff, Math.round(dpi * 100), true); dv.setUint32(yresOff + 4, 100, true);
  out.set(software, swOff);
  out.set(pix, dataOff);
  return out;
}

// ---------- PSD ----------
function packbits(row) {
  const out = [];
  let i = 0;
  const n = row.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) { out.push(257 - run, row[i]); i += run; continue; }
    const start = i;
    let lit = 0;
    while (i < n && lit < 128) {
      if (i + 2 < n && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++; lit++;
    }
    out.push(lit - 1);
    for (let k = start; k < start + lit; k++) out.push(row[k]);
  }
  return Uint8Array.from(out);
}

function encodePSD(img, dpi) {
  const { w, h, data } = img, alpha = hasTransparency(img), ch = alpha ? 4 : 3;
  const head = new Uint8Array(26), hv = new DataView(head.buffer);
  head.set(ascii('8BPS')); hv.setUint16(4, 1); hv.setUint16(12, ch); hv.setUint32(14, h); hv.setUint32(18, w); hv.setUint16(22, 8); hv.setUint16(24, 3);
  const res = new Uint8Array(4 + 28), rv = new DataView(res.buffer);
  rv.setUint32(0, 28); res.set(ascii('8BIM'), 4); rv.setUint16(8, 0x03ED); rv.setUint16(10, 0); rv.setUint32(12, 16);
  rv.setUint32(16, Math.round(dpi * 65536)); rv.setUint16(20, 1); rv.setUint16(22, 1);
  rv.setUint32(24, Math.round(dpi * 65536)); rv.setUint16(28, 1); rv.setUint16(30, 1);
  const parts = [head, new Uint8Array(4), res, new Uint8Array(4), new Uint8Array([0, 1])];
  const counts = new Uint8Array(ch * h * 2), cv = new DataView(counts.buffer);
  const rows = [];
  const row = new Uint8Array(w);
  for (let c = 0; c < ch; c++) for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = data[(y * w + x) * 4 + c];
    const p = packbits(row);
    cv.setUint16((c * h + y) * 2, p.length);
    rows.push(p);
  }
  return concat([...parts, counts, ...rows]);
}

// ---------- GIF ----------
function quantize(img, maxColors) {
  const d = img.data, n = img.w * img.h;
  const hist = new Uint32Array(32768);
  const step = Math.max(1, Math.floor(n / 600000));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (d[o + 3] < 128) continue;
    hist[((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3)]++;
  }
  const colors = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) colors.push(k);
  if (!colors.length) colors.push(0);
  const boxStats = arr => {
    let rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0, count = 0;
    for (const k of arr) { const r = k >> 10, g = (k >> 5) & 31, b = k & 31; rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); bmin = Math.min(bmin, b); bmax = Math.max(bmax, b); count += hist[k]; }
    return { arr, count, ranges: [rmax - rmin, gmax - gmin, bmax - bmin] };
  };
  const boxes = [boxStats(colors)];
  while (boxes.length < maxColors) {
    let bi = -1, best = 0;
    boxes.forEach((b, i) => { const s = b.count * Math.max(...b.ranges); if (b.arr.length > 1 && s > best) { best = s; bi = i; } });
    if (bi < 0) break;
    const b = boxes[bi];
    const axis = b.ranges.indexOf(Math.max(...b.ranges));
    const key = k => axis === 0 ? k >> 10 : axis === 1 ? (k >> 5) & 31 : k & 31;
    b.arr.sort((a, c) => key(a) - key(c));
    let acc = 0, cut = 0;
    for (; cut < b.arr.length - 1; cut++) { acc += hist[b.arr[cut]]; if (acc >= b.count / 2) break; }
    boxes.splice(bi, 1, boxStats(b.arr.slice(0, cut + 1)), boxStats(b.arr.slice(cut + 1)));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, c = 0;
    for (const k of b.arr) { const wt = hist[k]; r += ((k >> 10) * 8 + 4) * wt; g += (((k >> 5) & 31) * 8 + 4) * wt; bl += ((k & 31) * 8 + 4) * wt; c += wt; }
    c = c || 1;
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
  });
}

function encodeGIF(img, { colors = 256, dither = true } = {}) {
  const { w, h, data } = img;
  const transparent = hasTransparency(img);
  const maxC = Math.max(2, Math.min(256, colors)) - (transparent ? 1 : 0);
  const pal = quantize(img, maxC);
  const tIndex = transparent ? pal.length : -1;
  let size = 2, bits = 1;
  while (size < pal.length + (transparent ? 1 : 0)) { size <<= 1; bits++; }
  const cache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (cache[key] >= 0) return cache[key];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const p = pal[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, dd = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (dd < bd) { bd = dd; bi = i; } }
    cache[key] = bi;
    return bi;
  };
  const idx = new Uint8Array(w * h);
  const err = dither ? new Float32Array((w + 2) * 3 * 2) : null;
  for (let y = 0; y < h; y++) {
    if (err) { err.copyWithin(0, (w + 2) * 3); err.fill(0, (w + 2) * 3); }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (transparent && data[o + 3] < 128) { idx[y * w + x] = tIndex; continue; }
      let r = data[o], g = data[o + 1], b = data[o + 2];
      if (err) { const e = (x + 1) * 3; r = Math.max(0, Math.min(255, r + err[e])); g = Math.max(0, Math.min(255, g + err[e + 1])); b = Math.max(0, Math.min(255, b + err[e + 2])); }
      const k = nearest(r | 0, g | 0, b | 0);
      idx[y * w + x] = k;
      if (err) {
        const p = pal[k], er = r - p[0], eg = g - p[1], eb = b - p[2], e = (x + 1) * 3, n2 = (w + 2) * 3;
        const add = (off, f) => { err[off] += er * f; err[off + 1] += eg * f; err[off + 2] += eb * f; };
        add(e + 3, 7 / 16); add(n2 + e - 3, 3 / 16); add(n2 + e, 5 / 16); add(n2 + e + 3, 1 / 16);
      }
    }
  }
  const head = [...ascii('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xF0 | (bits - 1), 0, 0];
  const table = new Uint8Array(size * 3);
  pal.forEach((p, i) => table.set(p, i * 3));
  const parts = [Uint8Array.from(head), table];
  if (transparent) parts.push(Uint8Array.from([0x21, 0xF9, 4, 1, 0, 0, tIndex, 0]));
  parts.push(Uint8Array.from([0x2C, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]));
  const minCode = Math.max(2, bits);
  parts.push(Uint8Array.from([minCode]));
  const lzw = lzwEncode(idx, minCode);
  const blocks = [];
  for (let i = 0; i < lzw.length; i += 255) { const chunk = lzw.subarray(i, i + 255); blocks.push(Uint8Array.from([chunk.length]), chunk); }
  parts.push(...blocks, Uint8Array.from([0, 0x3B]));
  return concat(parts);
}

function lzwEncode(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const out = [];
  let cur = 0, shift = 0;
  const emit = code => { cur |= code << shift; shift += codeSize; while (shift >= 8) { out.push(cur & 255); cur >>>= 8; shift -= 8; } };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) { emit(clear); next = eoi + 1; codeSize = minCode + 1; dict = new Map(); }
    else { if (next >= (1 << codeSize)) codeSize++; dict.set(key, next++); }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

// ---------- ICO ----------
async function encodeICO(img, sizes) {
  const src = toCanvas(img);
  const pngs = [];
  for (const s of sizes) {
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    const k = Math.min(s / img.w, s / img.h), dw = img.w * k, dh = img.h * k;
    // step down for quality
    let cur = src, cw = img.w, chh = img.h;
    while (cw / 2 > dw) {
      const t = document.createElement('canvas'); t.width = Math.round(cw / 2); t.height = Math.round(chh / 2);
      const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'; tg.drawImage(cur, 0, 0, t.width, t.height);
      cur = t; cw = t.width; chh = t.height;
    }
    g.drawImage(cur, (s - dw) / 2, (s - dh) / 2, dw, dh);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    pngs.push(new Uint8Array(await blob.arrayBuffer()));
  }
  const head = new Uint8Array(6 + 16 * sizes.length), dv = new DataView(head.buffer);
  dv.setUint16(2, 1, true); dv.setUint16(4, sizes.length, true);
  let off = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s >= 256 ? 0 : s; head[e + 1] = s >= 256 ? 0 : s;
    dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true);
    dv.setUint32(e + 8, pngs[i].length, true); dv.setUint32(e + 12, off, true);
    off += pngs[i].length;
  });
  return concat([head, ...pngs]);
}

// ---------- TGA / DDS / QOI / PPM ----------
function encodeTGA(img) {
  const { w, h, data } = img;
  const head = new Uint8Array(18);
  head[2] = 2; head[12] = w & 255; head[13] = w >> 8; head[14] = h & 255; head[15] = h >> 8; head[16] = 32; head[17] = 0x28;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = data[i * 4 + 2]; px[i * 4 + 1] = data[i * 4 + 1]; px[i * 4 + 2] = data[i * 4]; px[i * 4 + 3] = data[i * 4 + 3]; }
  const foot = new Uint8Array(26); foot.set(ascii('TRUEVISION-XFILE.\0'), 8);
  return concat([head, px, foot]);
}

function encodeDDS(img) {
  const { w, h, data } = img;
  const head = new Uint8Array(128), dv = new DataView(head.buffer);
  head.set(ascii('DDS '));
  dv.setUint32(4, 124, true); dv.setUint32(8, 0x1 | 0x2 | 0x4 | 0x8 | 0x1000, true);
  dv.setUint32(12, h, true); dv.setUint32(16, w, true); dv.setUint32(20, w * 4, true);
  dv.setUint32(76, 32, true); dv.setUint32(80, 0x41, true); dv.setUint32(88, 32, true);
  dv.setUint32(92, 0x00FF0000, true); dv.setUint32(96, 0x0000FF00, true); dv.setUint32(100, 0x000000FF, true); dv.setUint32(104, 0xFF000000, true);
  dv.setUint32(108, 0x1000, true);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = data[i * 4 + 2]; px[i * 4 + 1] = data[i * 4 + 1]; px[i * 4 + 2] = data[i * 4]; px[i * 4 + 3] = data[i * 4 + 3]; }
  return concat([head, px]);
}

function encodeQOI(img) {
  const { w, h, data } = img, alpha = hasTransparency(img);
  const out = new Uint8Array(14 + w * h * 5 + 8), dv = new DataView(out.buffer);
  out.set(ascii('qoif')); dv.setUint32(4, w); dv.setUint32(8, h); out[12] = alpha ? 4 : 3; out[13] = 0;
  const idx = new Uint8Array(256);
  let p = 14, run = 0, pr = 0, pg = 0, pb = 0, pa = 255;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === n - 1) { out[p++] = 0xC0 | (run - 1); run = 0; }
      continue;
    }
    if (run > 0) { out[p++] = 0xC0 | (run - 1); run = 0; }
    const hi = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    if (idx[hi] === r && idx[hi + 1] === g && idx[hi + 2] === b && idx[hi + 3] === a) out[p++] = hi / 4;
    else {
      idx[hi] = r; idx[hi + 1] = g; idx[hi + 2] = b; idx[hi + 3] = a;
      if (a === pa) {
        const vr = ((r - pr) << 24) >> 24, vg = ((g - pg) << 24) >> 24, vb = ((b - pb) << 24) >> 24;
        const vgr = vr - vg, vgb = vb - vg;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) out[p++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) { out[p++] = 0x80 | (vg + 32); out[p++] = ((vgr + 8) << 4) | (vgb + 8); }
        else { out[p++] = 0xFE; out[p++] = r; out[p++] = g; out[p++] = b; }
      } else { out[p++] = 0xFF; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a; }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  out.set([0, 0, 0, 0, 0, 0, 0, 1], p); p += 8;
  return out.subarray(0, p);
}

function encodePPM(img) {
  const { w, h, data } = img;
  const head = ascii(`P6\n# Thaifund\n${w} ${h}\n255\n`);
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = data[i * 4]; px[i * 3 + 1] = data[i * 4 + 1]; px[i * 3 + 2] = data[i * 4 + 2]; }
  return concat([head, px]);
}

// ---------- PDF ----------
async function encodePDF(img, quality, dpi) {
  const jpg = new Uint8Array(await (await canvasBlob(img, 'image/jpeg', quality)).arrayBuffer());
  const W = (img.w / dpi * 72).toFixed(2), H = (img.h / dpi * 72).toFixed(2);
  const content = ascii(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`);
  const objs = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    concat([ascii(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, ascii('\nendstream')]),
    concat([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('endstream')]),
    ascii(`<< /Producer (Thaifund) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`),
  ];
  const parts = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let off = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    const head = ascii(`${i + 1} 0 obj\n`), tail = ascii('\nendobj\n');
    offsets.push(off);
    parts.push(head, o, tail);
    off += head.length + o.length + tail.length;
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map(o => String(o).padStart(10, '0') + ' 00000 n ')].join('\n') + '\n';
  parts.push(ascii(xref), ascii(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${off}\n%%EOF\n`));
  return concat(parts);
}

// ---------- SVG / HDR ----------
async function encodeSVG(img) {
  const png = await canvasBlob(img, 'image/png');
  const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(png); });
  return ascii(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${img.w}" height="${img.h}" viewBox="0 0 ${img.w} ${img.h}">\n  <title>Exported with Thaifund</title>\n  <image width="${img.w}" height="${img.h}" xlink:href="${b64}" href="${b64}"/>\n</svg>\n`);
}

function encodeHDR(img) {
  const { w, h, data } = img;
  const lin = new Float32Array(256).map((_, i) => { const x = i / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  const head = ascii(`#?RADIANCE\n# Thaifund\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const r = lin[data[i * 4]], g = lin[data[i * 4 + 1]], b = lin[data[i * 4 + 2]], m = Math.max(r, g, b);
    if (m < 1e-32) continue;
    const e = Math.floor(Math.log2(m)) + 1, sc = 256 / Math.pow(2, e);
    px[i * 4] = Math.min(255, r * sc); px[i * 4 + 1] = Math.min(255, g * sc); px[i * 4 + 2] = Math.min(255, b * sc); px[i * 4 + 3] = e + 128;
  }
  return concat([head, px]);
}

// ---------- dispatcher ----------
export async function encode(fmtId, img, opts = {}) {
  const f = FORMATS.find(x => x.id === fmtId);
  const dpi = opts.dpi || 72, q = (opts.quality ?? 90) / 100;
  const bg = opts.bg || [255, 255, 255];
  const flat = () => flatten(img, bg);
  const blob = (bytes) => new Blob([bytes], { type: f.mime });
  switch (fmtId) {
    case 'jpeg': return jpegWithDpi(await canvasBlob(flat(), 'image/jpeg', q), dpi);
    case 'png': return pngWithDpi(await canvasBlob(img, 'image/png'), dpi);
    case 'webp': return canvasBlob(img, 'image/webp', q);
    case 'avif': return canvasBlob(img, 'image/avif', q);
    case 'tiff': return blob(await encodeTIFF(img, dpi, opts.tiffCompression));
    case 'psd': return blob(encodePSD(img, dpi));
    case 'bmp': return blob(encodeBMP(img, dpi));
    case 'gif': return blob(encodeGIF(img, { colors: opts.gifColors, dither: opts.gifDither }));
    case 'ico': return blob(await encodeICO(img, opts.icoSizes || [16, 32, 48, 256]));
    case 'tga': return blob(encodeTGA(img));
    case 'dds': return blob(encodeDDS(img));
    case 'qoi': return blob(encodeQOI(img));
    case 'ppm': return blob(encodePPM(flat()));
    case 'pdf': return blob(await encodePDF(flat(), q, dpi));
    case 'svg': return blob(await encodeSVG(img));
    case 'hdr': return blob(encodeHDR(flat()));
    default: throw new Error('Unknown format ' + fmtId);
  }
}
