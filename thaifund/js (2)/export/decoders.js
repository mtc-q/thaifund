// Fallback decoders for formats browsers don't read natively: TIFF, PSD, TGA, QOI, PNM.
// Each returns an ImageData (8-bit RGBA) or null.

export async function decodeFallback(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const sig = String.fromCharCode(...buf.slice(0, 4));
  try {
    if (sig === 'II*\0' || sig === 'MM\0*') return await decodeTIFF(buf);
    if (sig === '8BPS') return decodePSD(buf);
    if (sig === 'qoif') return decodeQOI(buf);
    if (buf[0] === 0x50 && buf[1] >= 0x31 && buf[1] <= 0x36) return decodePNM(buf);
    if (ext === 'tga' || ext === 'icb' || ext === 'vda') return decodeTGA(buf);
  } catch (e) { console.warn('Fallback decode failed', e); }
  return null;
}

const mk = (w, h) => new ImageData(w, h);

// ---------- TIFF (strips, 8-bit, none / LZW / Deflate / PackBits, predictor 2) ----------
async function decodeTIFF(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[0] === 0x49;
  const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ifd = u32(4), n = u16(ifd), tags = {};
  const tsize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
    const sz = (tsize[type] || 1) * cnt, p = sz > 4 ? u32(e + 8) : e + 8;
    const vals = [];
    for (let k = 0; k < Math.min(cnt, 65536); k++) vals.push(type === 3 ? u16(p + k * 2) : type === 4 ? u32(p + k * 4) : type === 1 ? b[p + k] : 0);
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0];
  const bps = (tags[258] || [8])[0], spp = (tags[277] || [1])[0];
  const comp = (tags[259] || [1])[0], photo = (tags[262] || [2])[0], pred = (tags[317] || [1])[0];
  if (bps !== 8) throw new Error('Only 8-bit TIFF is supported');
  if (tags[322]) throw new Error('Tiled TIFF not supported');
  const offs = tags[273], counts = tags[279], rps = (tags[278] || [H])[0];
  const rowBytes = W * spp, out = mk(W, H), d = out.data;
  for (let s = 0; s < offs.length; s++) {
    let strip = b.subarray(offs[s], offs[s] + counts[s]);
    if (comp === 5) strip = lzwDecode(strip);
    else if (comp === 8 || comp === 32946) strip = new Uint8Array(await new Response(new Blob([strip]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    else if (comp === 32773) strip = packbitsDecode(strip, rowBytes * rps);
    else if (comp !== 1) throw new Error('Unsupported TIFF compression ' + comp);
    const y0 = s * rps;
    for (let r = 0; r < rps && y0 + r < H; r++) {
      const row = strip.subarray(r * rowBytes, (r + 1) * rowBytes);
      if (pred === 2) for (let x = spp; x < rowBytes; x++) row[x] = (row[x] + row[x - spp]) & 255;
      for (let x = 0; x < W; x++) {
        const i = ((y0 + r) * W + x) * 4, j = x * spp;
        if (spp >= 3) { d[i] = row[j]; d[i + 1] = row[j + 1]; d[i + 2] = row[j + 2]; d[i + 3] = spp >= 4 ? row[j + 3] : 255; }
        else { let v = row[j]; if (photo === 0) v = 255 - v; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = spp === 2 ? row[j + 1] : 255; }
      }
    }
  }
  return out;
}

function lzwDecode(src) {
  const out = [];
  let dict = [], bitPos = 0, codeLen = 9, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict[i] = [i]; dict[256] = null; dict[257] = null; codeLen = 9; };
  const read = () => {
    let v = 0;
    for (let i = 0; i < codeLen; i++) {
      const byte = src[(bitPos >> 3)];
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  reset();
  while ((bitPos + codeLen) <= src.length * 8) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); prev = null; continue; }
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);
    else break;
    for (const v of entry) out.push(v);
    if (prev) dict.push(prev.concat(entry[0]));
    prev = entry;
    if (dict.length + 1 >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return Uint8Array.from(out);
}

function packbitsDecode(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v; }
  }
  return out;
}

// ---------- PSD (flattened composite, 8-bit RGB / gray) ----------
function decodePSD(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ch = dv.getUint16(12), H = dv.getUint32(14), W = dv.getUint32(18), depth = dv.getUint16(22), mode = dv.getUint16(24);
  if (depth !== 8) throw new Error('Only 8-bit PSD is supported');
  let p = 26;
  p += 4 + dv.getUint32(p); // color mode data
  p += 4 + dv.getUint32(p); // image resources
  p += 4 + dv.getUint32(p); // layer & mask
  const comp = dv.getUint16(p); p += 2;
  const planes = [];
  if (comp === 0) {
    for (let c = 0; c < ch; c++) { planes.push(b.subarray(p, p + W * H)); p += W * H; }
  } else if (comp === 1) {
    const counts = [];
    for (let i = 0; i < ch * H; i++) { counts.push(dv.getUint16(p)); p += 2; }
    for (let c = 0; c < ch; c++) {
      const plane = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) { const n = counts[c * H + y]; plane.set(packbitsDecode(b.subarray(p, p + n), W), y * W); p += n; }
      planes.push(plane);
    }
  } else throw new Error('Unsupported PSD compression');
  const out = mk(W, H), d = out.data;
  for (let i = 0; i < W * H; i++) {
    if (mode === 3) { d[i * 4] = planes[0][i]; d[i * 4 + 1] = planes[1][i]; d[i * 4 + 2] = planes[2][i]; }
    else { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = planes[0][i]; }
    d[i * 4 + 3] = (mode === 3 && ch > 3) ? planes[3][i] : 255;
  }
  return out;
}

// ---------- QOI ----------
function decodeQOI(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const W = dv.getUint32(4), H = dv.getUint32(8);
  const out = mk(W, H), d = out.data, idx = new Uint8Array(256);
  let r = 0, g = 0, bl = 0, a = 255, p = 14, run = 0;
  for (let o = 0; o < W * H * 4; o += 4) {
    if (run > 0) run--;
    else {
      const b1 = b[p++];
      if (b1 === 0xFE) { r = b[p++]; g = b[p++]; bl = b[p++]; }
      else if (b1 === 0xFF) { r = b[p++]; g = b[p++]; bl = b[p++]; a = b[p++]; }
      else if ((b1 & 0xC0) === 0x00) { const i = b1 * 4; r = idx[i]; g = idx[i + 1]; bl = idx[i + 2]; a = idx[i + 3]; }
      else if ((b1 & 0xC0) === 0x40) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; bl = (bl + (b1 & 3) - 2) & 255; }
      else if ((b1 & 0xC0) === 0x80) { const b2 = b[p++], vg = (b1 & 0x3F) - 32; r = (r + vg - 8 + ((b2 >> 4) & 15)) & 255; g = (g + vg) & 255; bl = (bl + vg - 8 + (b2 & 15)) & 255; }
      else run = b1 & 0x3F;
      const hi = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4;
      idx[hi] = r; idx[hi + 1] = g; idx[hi + 2] = bl; idx[hi + 3] = a;
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = bl; d[o + 3] = a;
  }
  return out;
}

// ---------- PNM (P1–P6, 8-bit) ----------
function decodePNM(b) {
  const type = b[1] - 48;
  let p = 2;
  const token = () => {
    while (p < b.length) {
      if (b[p] === 35) { while (p < b.length && b[p] !== 10) p++; }
      else if (b[p] <= 32) p++;
      else break;
    }
    let s = '';
    while (p < b.length && b[p] > 32) s += String.fromCharCode(b[p++]);
    return s;
  };
  const W = +token(), H = +token(), max = (type === 1 || type === 4) ? 1 : +token();
  p++;
  const out = mk(W, H), d = out.data, sc = 255 / max;
  for (let i = 0; i < W * H; i++) {
    let r, g, bl;
    if (type === 6) { r = b[p++]; g = b[p++]; bl = b[p++]; }
    else if (type === 5) { r = g = bl = b[p++]; }
    else if (type === 3) { r = +token(); g = +token(); bl = +token(); }
    else if (type === 2) { r = g = bl = +token(); }
    else if (type === 1) { r = g = bl = +token() ? 0 : 1; }
    else { const x = i % W, rowBytes = Math.ceil(W / 8), y = (i / W) | 0; r = g = bl = (b[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1; }
    d[i * 4] = r * sc; d[i * 4 + 1] = g * sc; d[i * 4 + 2] = bl * sc; d[i * 4 + 3] = 255;
  }
  return out;
}

// ---------- TGA (types 2, 3, 10, 11) ----------
function decodeTGA(b) {
  const idLen = b[0], cmapType = b[1], type = b[2];
  const cmapLen = b[5] | (b[6] << 8), cmapBits = b[7];
  const W = b[12] | (b[13] << 8), H = b[14] | (b[15] << 8), bpp = b[16], desc = b[17];
  if (![2, 3, 10, 11].includes(type)) throw new Error('Unsupported TGA type');
  let p = 18 + idLen + (cmapType ? cmapLen * Math.ceil(cmapBits / 8) : 0);
  const bytes = bpp / 8, n = W * H, px = new Uint8Array(n * bytes);
  if (type === 10 || type === 11) {
    let o = 0;
    while (o < px.length) {
      const hdr = b[p++], cnt = (hdr & 0x7F) + 1;
      if (hdr & 0x80) { const v = b.subarray(p, p + bytes); p += bytes; for (let k = 0; k < cnt; k++) { px.set(v, o); o += bytes; } }
      else { px.set(b.subarray(p, p + cnt * bytes), o); p += cnt * bytes; o += cnt * bytes; }
    }
  } else px.set(b.subarray(p, p + px.length));
  const out = mk(W, H), d = out.data, top = desc & 0x20;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (y * W + x) * bytes, dy = top ? y : H - 1 - y, di = (dy * W + x) * 4;
    if (bytes === 1) { d[di] = d[di + 1] = d[di + 2] = px[si]; d[di + 3] = 255; }
    else if (bytes === 2) { const v = px[si] | (px[si + 1] << 8); d[di] = ((v >> 10) & 31) * 8.226; d[di + 1] = ((v >> 5) & 31) * 8.226; d[di + 2] = (v & 31) * 8.226; d[di + 3] = 255; }
    else { d[di] = px[si + 2]; d[di + 1] = px[si + 1]; d[di + 2] = px[si]; d[di + 3] = bytes === 4 ? px[si + 3] : 255; }
  }
  return out;
}
