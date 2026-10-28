// WebGL2 renderer: owns GPU resources and runs the multi-pass development pipeline.
import * as S from './shaders.js';
import { M3 } from '../geometry.js';

const CTX_LONG = 1536;          // resolution of the cached whole-frame context (large blurs, lens blur)
const SIGMA_MID = 0.012;        // definition / clarity scale (fraction of long side)
const SIGMA_LARGE = 0.06;       // local tone-mapping scale
const LENS_MAX = 0.045;         // max lens blur radius (fraction of long side)

class Program {
  constructor(gl, fs) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, S.VERT);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p));
    this.p = p; this.locs = new Map(); this.unit = 0;
  }
  loc(n) { let l = this.locs.get(n); if (l === undefined) { l = this.gl.getUniformLocation(this.p, n); this.locs.set(n, l); } return l; }
  use() { this.gl.useProgram(this.p); this.unit = 0; return this; }
  i(n, v) { this.gl.uniform1i(this.loc(n), v); return this; }
  f(n, v) { this.gl.uniform1f(this.loc(n), v); return this; }
  f2(n, a, b) { this.gl.uniform2f(this.loc(n), a, b); return this; }
  f3(n, a, b, c) { this.gl.uniform3f(this.loc(n), a, b, c); return this; }
  f4(n, a, b, c, d) { this.gl.uniform4f(this.loc(n), a, b, c, d); return this; }
  fv(n, arr) { this.gl.uniform1fv(this.loc(n), arr); return this; }
  m3(n, m) { this.gl.uniformMatrix3fv(this.loc(n), false, M3.toGL(m)); return this; }
  tex(n, t) { const gl = this.gl, u = this.unit++; gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(this.loc(n), u); return this; }
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log, '\n', src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.gl = gl;
    this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL 2';
    this.vao = gl.createVertexArray();
    this.pool = new Map();
    this.poolCount = 0;
    this.ctxCache = [];
    this.lensCache = null;
    this.src = null; this.mask = null; this.curve = null;
    this.initPrograms();
    this.dummy = this.makeTex(1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    this.curve = this.makeTex(256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  initPrograms() {
    const gl = this.gl;
    this.prog = {
      geo: new Program(gl, S.GEO), down: new Program(gl, S.DOWN), blur: new Program(gl, S.BLUR),
      premult: new Program(gl, S.PREMULT), lens: new Program(gl, S.LENS), denoise: new Program(gl, S.DENOISE),
      final: new Program(gl, S.FINAL), blit: new Program(gl, S.BLIT),
    };
  }

  makeTex(w, h, internal, format, type, data, filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ---------- resources ----------
  setSource(image, w, h, hasAlpha) {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    this.src = t; this.srcW = w; this.srcH = h; this.srcAlpha = !!hasAlpha;
    this.clearCaches();
    this.setMask(null);
  }

  setMask(data, w, h) {
    const gl = this.gl;
    if (!data) { if (this.mask) gl.deleteTexture(this.mask); this.mask = null; this.maskW = this.maskH = 1; return; }
    if (!this.mask || this.maskW !== w || this.maskH !== h) {
      if (this.mask) gl.deleteTexture(this.mask);
      this.mask = this.makeTex(w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, data, gl.LINEAR_MIPMAP_LINEAR);
      this.maskW = w; this.maskH = h;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.mask);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Uploads only a sub-rectangle of the mask (fast brush updates). */
  updateMaskRect(data, w, x, y, rw, rh) {
    const gl = this.gl;
    if (!this.mask) return;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, rw, rh, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  setCurveLUT(lut) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curve);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  clearCaches() {
    for (const c of this.ctxCache) this.freeCtx(c);
    this.ctxCache = [];
    if (this.lensCache) { this.release(this.lensCache.tex); this.lensCache = null; }
  }

  // ---------- render targets ----------
  acquire(w, h, fmt) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const key = `${w}x${h}:${fmt}`, list = this.pool.get(key);
    if (list && list.length) { this.poolCount--; return list.pop(); }
    const gl = this.gl;
    const f16 = fmt === 'f16';
    let internal, type, format = gl.RGBA;
    if (f16 && this.floatOK) { internal = gl.RGBA16F; type = gl.HALF_FLOAT; }
    else if (f16) { internal = gl.SRGB8_ALPHA8; type = gl.UNSIGNED_BYTE; }
    else { internal = gl.RGBA8; type = gl.UNSIGNED_BYTE; }
    const tex = this.makeTex(w, h, internal, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h, fmt, key };
  }
  release(t) {
    if (!t) return;
    let list = this.pool.get(t.key);
    if (!list) this.pool.set(t.key, list = []);
    list.push(t); this.poolCount++;
    if (this.poolCount > 24) this.trimPool();
  }
  trimPool() {
    const gl = this.gl;
    for (const [k, list] of this.pool) {
      while (list.length) { const t = list.pop(); gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); this.poolCount--; }
      this.pool.delete(k);
      if (this.poolCount <= 8) break;
    }
  }
  purge() {
    this.clearCaches();
    const gl = this.gl;
    for (const list of this.pool.values()) for (const t of list) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    this.pool.clear(); this.poolCount = 0;
  }

  draw(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- passes ----------
  geoPass(target, H, origin, scale, mask) {
    const p = this.prog.geo.use();
    p.tex('uSrc', this.src).tex('uMask', this.mask || this.dummy).m3('uH', H)
      .f2('uOrigin', origin.x, origin.y).f('uScale', scale)
      .i('uHasMask', mask.has && this.mask ? 1 : 0).i('uInvert', mask.invert ? 1 : 0)
      .f('uFeather', mask.feather || 0).f('uShift', mask.shift || 0).f2('uMaskSize', this.maskW || 1, this.maskH || 1);
    this.draw(target);
  }

  downsample(src) {
    const t = this.acquire(Math.ceil(src.w / 2), Math.ceil(src.h / 2), 'f16');
    this.prog.down.use().tex('uIn', src.tex).f2('uTexel', 1 / src.w, 1 / src.h);
    this.draw(t);
    return t;
  }

  gaussian(src, sigma) {
    const tmp = this.acquire(src.w, src.h, 'f16'), out = this.acquire(src.w, src.h, 'f16');
    const p = this.prog.blur;
    p.use().tex('uIn', src.tex).f2('uDir', 1 / src.w, 0).f('uSigma', sigma); this.draw(tmp);
    p.use().tex('uIn', tmp.tex).f2('uDir', 0, 1 / src.h).f('uSigma', sigma); this.draw(out);
    this.release(tmp);
    return out;
  }

  pyramid(base, levels) {
    const L = [base];
    for (let i = 1; i <= levels; i++) {
      const prev = L[i - 1];
      if (prev.w <= 4 || prev.h <= 4) break;
      L.push(this.downsample(prev));
    }
    return L;
  }

  blurFromPyramid(L, sigma) {
    let k = Math.max(0, Math.floor(Math.log2(Math.max(sigma, 1) / 2)));
    k = Math.min(k, L.length - 1);
    return this.gaussian(L[k], Math.max(0.6, sigma / Math.pow(2, k)));
  }

  /** Whole-frame low-resolution context (cached): large blurs used by local tone / definition / glow. */
  ensureContext(job) {
    const hit = this.ctxCache.find(c => c.key === job.ctxKey);
    if (hit) { this.ctxCache = [hit, ...this.ctxCache.filter(c => c !== hit)]; return hit; }
    const F = job.frame, long = Math.max(F.w, F.h);
    const cs = Math.min(1, CTX_LONG / long);
    const margin = long * 0.08;
    const region = { x: -margin, y: -margin, w: F.w + 2 * margin, h: F.h + 2 * margin };
    const A = this.acquire(Math.ceil(region.w * cs), Math.ceil(region.h * cs), 'f16');
    this.geoPass(A, job.H, { x: region.x, y: region.y }, cs, job.mask);
    const sMid = SIGMA_MID * long * cs, sLarge = SIGMA_LARGE * long * cs;
    const L = this.pyramid(A, Math.ceil(Math.log2(Math.max(sLarge, 2))));
    const B2 = this.blurFromPyramid(L, sMid);
    const B3 = this.blurFromPyramid(L, sLarge);
    for (let i = 1; i < L.length; i++) this.release(L[i]);
    const ctx = { key: job.ctxKey, A, B2, B3, rect: { x: region.x, y: region.y, w: A.w / cs, h: A.h / cs }, cs, long };
    this.ctxCache.unshift(ctx);
    while (this.ctxCache.length > 2) this.freeCtx(this.ctxCache.pop());
    return ctx;
  }
  freeCtx(c) { this.release(c.A); this.release(c.B2); this.release(c.B3); if (this.lensCache && this.lensCache.ctx === c) { this.release(this.lensCache.tex); this.lensCache = null; } }

  ensureLens(job, ctx) {
    const key = job.ctxKey + '|' + job.lens.amount.toFixed(3) + '|' + job.lens.boost.toFixed(3);
    if (this.lensCache && this.lensCache.key === key && this.lensCache.ctx === ctx) return this.lensCache.tex;
    if (this.lensCache) { this.release(this.lensCache.tex); this.lensCache = null; }
    const P0 = this.acquire(ctx.A.w, ctx.A.h, 'f16');
    this.prog.premult.use().tex('uIn', ctx.A.tex).i('uHasMask', job.mask.has && this.mask ? 1 : 0);
    this.draw(P0);
    const r = Math.pow(job.lens.amount, 1.35) * LENS_MAX * ctx.long * ctx.cs;
    const k = Math.max(0, Math.ceil(Math.log2(Math.max(r, 1) / 7)));
    const L = this.pyramid(P0, k);
    const lvl = L[L.length - 1];
    const rl = r / Math.pow(2, L.length - 1);
    const out = this.acquire(lvl.w, lvl.h, 'f16');
    this.prog.lens.use().tex('uIn', lvl.tex).f2('uTexel', 1 / lvl.w, 1 / lvl.h).f('uR', Math.max(rl, 0.5)).f('uBoost', job.lens.boost);
    this.draw(out);
    for (const t of L) this.release(t);
    this.lensCache = { key, ctx, tex: out };
    return out;
  }

  /**
   * Renders a region of the frame.
   * job: { frame, H (O px → src uv), origin {x,y} (O px at output pixel 0,0), scale, out {w,h}, crop (O rect),
   *        u (uniform bundle), mask {has, feather, shift, invert}, lens {on, amount, boost}, ctxKey, flags }
   * Returns an RGBA8 target (straight alpha, sRGB, top row first). Caller must release() it.
   */
  render(job) {
    const gl = this.gl, s = job.scale, u = job.u, fl = job.flags;
    const bypass = !!fl.bypass;
    const sharpOn = !bypass && u.sharpOn;
    const sig = sharpOn ? Math.max(0.65, u.sharpRadius * s) : 0;
    const nrOn = !bypass && u.nrOn;
    const nrRad = nrOn ? Math.min(6, Math.max(1, 2.2 * s)) : 0;
    const pad = Math.ceil(sig * 2 + nrRad + 2);
    let A = this.acquire(job.out.w + 2 * pad, job.out.h + 2 * pad, 'f16');
    this.geoPass(A, job.H, { x: job.origin.x - pad / s, y: job.origin.y - pad / s }, s, job.mask);
    if (nrOn) {
      const D = this.acquire(A.w, A.h, 'f16');
      this.prog.denoise.use().tex('uIn', A.tex).f2('uTexel', 1 / A.w, 1 / A.h).f('uRad', nrRad).f('uLum', u.nrLum).f('uCol', u.nrCol);
      this.draw(D);
      this.release(A); A = D;
    }
    const ctx = bypass ? null : this.ensureContext(job);
    const lensOn = !bypass && job.lens.on && job.mask.has && this.mask;
    const lens = lensOn ? this.ensureLens(job, ctx) : null;

    const out = this.acquire(job.out.w, job.out.h, 'u8');
    const p = this.prog.final.use();
    p.tex('uA', A.tex)
      .tex('uB2', ctx ? ctx.B2.tex : A.tex).tex('uB3', ctx ? ctx.B3.tex : A.tex)
      .tex('uLens', lens ? lens.tex : A.tex).tex('uSrc', this.src).tex('uCurve', this.curve)
      .f2('uASize', A.w, A.h).f2('uPad', pad, pad).f2('uOrigin', job.origin.x, job.origin.y).f('uScale', s)
      .f4('uCrop', job.crop.x, job.crop.y, job.crop.w, job.crop.h)
      .f4('uCtx', ctx ? ctx.rect.x : 0, ctx ? ctx.rect.y : 0, ctx ? ctx.rect.w : 1, ctx ? ctx.rect.h : 1)
      .m3('uH', job.H)
      .fv('uP', u.P).fv('uLS', u.LS).fv('uLB', u.LB).fv('uHslH', u.hslH).fv('uHslS', u.hslS).fv('uHslL', u.hslL)
      .i('uHasMask', job.mask.has && this.mask ? 1 : 0).i('uLensOn', lens ? 1 : 0).i('uBgMode', u.bgMode)
      .i('uCropMode', fl.cropMode ? 1 : 0).i('uShowMask', fl.showMask || 0).i('uClip', fl.clip ? 1 : 0)
      .i('uBypass', bypass ? 1 : 0).i('uCurveOn', u.curveOn ? 1 : 0).i('uHslOn', u.hslOn ? 1 : 0)
      .i('uLevelsOn', u.levelsOn ? 1 : 0).i('uGradeOn', u.gradeOn ? 1 : 0).i('uSrcAlpha', this.srcAlpha ? 1 : 0)
      .f3('uBgColor', u.bgColor[0], u.bgColor[1], u.bgColor[2])
      .f('uLensMix', Math.min(1, job.lens.amount * 4)).f('uSharpSigma', sig);
    this.draw(out);
    this.release(A);
    return out;
  }

  /** Draws a rendered target at a device-pixel rect on the canvas. */
  present(target, x, y, opts = {}) {
    const gl = this.gl, ch = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, ch - y - target.h, target.w, target.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, ch - y - target.h, target.w, target.h);
    const bg = opts.bg || [0.11, 0.11, 0.11];
    this.prog.blit.use().tex('uTex', target.tex).i('uChecker', opts.checker ? 1 : 0).f3('uBg', bg[0], bg[1], bg[2]);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }
  /** Same as present() but limited to a horizontal span (split view). */
  presentClip(target, x, y, clipX0, clipX1, opts) {
    const gl = this.gl, ch = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, ch - y - target.h, target.w, target.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.max(x, clipX0), ch - y - target.h, Math.max(0, Math.min(x + target.w, clipX1) - Math.max(x, clipX0)), target.h);
    const bg = opts.bg || [0.11, 0.11, 0.11];
    this.prog.blit.use().tex('uTex', target.tex).i('uChecker', opts.checker ? 1 : 0).f3('uBg', bg[0], bg[1], bg[2]);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  clear(rgb) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  read(target, out) {
    const gl = this.gl;
    const buf = out || new Uint8Array(target.w * target.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }
  readPixel(target, x, y) {
    const gl = this.gl, b = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return b;
  }
}
