// High quality resampling (separable Lanczos-3 / bicubic, alpha-aware) and output sharpening.

function kernelLanczos(x) {
  x = Math.abs(x);
  if (x < 1e-7) return 1;
  if (x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}
function kernelCubic(x) { // Mitchell–Netravali B=1/3, C=1/3
  x = Math.abs(x);
  const B = 1 / 3, C = 1 / 3;
  if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  return 0;
}

function weights(srcLen, dstLen, kernel, support) {
  const scale = dstLen / srcLen;
  const fscale = Math.max(1, 1 / scale);
  const sup = support * fscale;
  const list = new Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const lo = Math.max(0, Math.floor(center - sup)), hi = Math.min(srcLen - 1, Math.ceil(center + sup));
    const w = new Float32Array(hi - lo + 1);
    let sum = 0;
    for (let j = lo; j <= hi; j++) { const v = kernel((j - center) / fscale); w[j - lo] = v; sum += v; }
    for (let k = 0; k < w.length; k++) w[k] /= sum || 1;
    list[i] = { lo, w };
  }
  return list;
}

/** Resizes RGBA8 pixels. method: 'lanczos' | 'bicubic' | 'nearest'. */
export function resizeRGBA(src, sw, sh, dw, dh, method = 'lanczos', onProgress) {
  if (sw === dw && sh === dh) return src;
  if (method === 'nearest') {
    const out = new Uint8ClampedArray(dw * dh * 4);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, sw * sh), d32 = new Uint32Array(out.buffer);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
      for (let x = 0; x < dw; x++) d32[y * dw + x] = s32[sy * sw + Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw))];
    }
    return out;
  }
  const kernel = method === 'bicubic' ? kernelCubic : kernelLanczos;
  const support = method === 'bicubic' ? 2 : 3;
  // premultiply into float
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = src[i * 4 + 3] / 255;
    pre[i * 4] = src[i * 4] * a; pre[i * 4 + 1] = src[i * 4 + 1] * a; pre[i * 4 + 2] = src[i * 4 + 2] * a; pre[i * 4 + 3] = a * 255;
  }
  // horizontal
  const wx = weights(sw, dw, kernel, support);
  const tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4, orow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const { lo, w } = wx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) { const s = row + (lo + k) * 4, wk = w[k]; r += pre[s] * wk; g += pre[s + 1] * wk; b += pre[s + 2] * wk; a += pre[s + 3] * wk; }
      const o = orow + x * 4; tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
    if (onProgress && (y & 255) === 0) onProgress(0.5 * y / sh);
  }
  // vertical
  const wy = weights(sh, dh, kernel, support);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const { lo, w } = wy[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) { const s = ((lo + k) * dw + x) * 4, wk = w[k]; r += tmp[s] * wk; g += tmp[s + 1] * wk; b += tmp[s + 2] * wk; a += tmp[s + 3] * wk; }
      const o = (y * dw + x) * 4;
      const af = a / 255;
      if (af > 1e-4) { out[o] = r / af; out[o + 1] = g / af; out[o + 2] = b / af; }
      out[o + 3] = a;
    }
    if (onProgress && (y & 255) === 0) onProgress(0.5 + 0.5 * y / dh);
  }
  return out;
}

/** Output sharpening (unsharp mask, radius ~1px). amount 0..1 */
export function sharpenRGBA(px, w, h, amount) {
  if (amount <= 0) return px;
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (px[(y0 * w + x) * 4 + c] + px[(y1 * w + x) * 4 + c] + px[(y * w + x0) * 4 + c] + px[(y * w + x1) * 4 + c]) * 0.125 + px[i + c] * 0.5;
        out[i + c] = px[i + c] + (px[i + c] - blur) * amount * 2.2;
      }
      out[i + 3] = px[i + 3];
    }
  }
  return out;
}
