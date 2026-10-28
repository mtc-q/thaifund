// Local AI segmentation with MediaPipe Tasks (WebAssembly, runs on this device).
// The runtime and models are fetched once from public CDNs and cached by the browser;
// images are never uploaded anywhere.

const VER = '0.10.21';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
export const MODELS = {
  objects: { url: `${MODEL_BASE}/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite`, mb: 2.7, label: 'object model' },
  people: { url: `${MODEL_BASE}/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`, mb: 15.6, label: 'people model' },
  tap: { url: `${MODEL_BASE}/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite`, mb: 5.9, label: 'tap-select model' },
};
const CACHE = 'thaifund-models-v1';
const DEEPLAB_LABELS = ['background', 'aeroplane', 'bicycle', 'bird', 'boat', 'bottle', 'bus', 'car', 'cat', 'chair', 'cow', 'diningtable', 'dog', 'horse', 'motorbike', 'person', 'pottedplant', 'sheep', 'sofa', 'train', 'tv'];

let visionP = null;
const tasks = {};

async function vision(status) {
  if (!visionP) {
    visionP = (async () => {
      status?.('Loading AI runtime…', 0);
      const mod = await import(`${CDN}/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      return { mod, fileset };
    })();
  }
  try { return await visionP; } catch (e) { visionP = null; throw e; }
}

async function fetchModel(key, status) {
  const { url, mb, label } = MODELS[key];
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch { cache = null; }
  status?.(`Downloading ${label} (${mb} MB, first time only)…`, 0);
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Could not download the ${label} (${res.status}).`);
  const total = +res.headers.get('content-length') || mb * 1048576;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    status?.(`Downloading ${label}… ${Math.round(got / 1048576 * 10) / 10} / ${mb} MB`, got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { await cache?.put(url, new Response(buf.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* quota */ }
  return buf;
}

async function getTask(key, status) {
  if (tasks[key]) return tasks[key];
  const { mod, fileset } = await vision(status);
  const buf = await fetchModel(key, status);
  status?.('Starting the ' + MODELS[key].label + '…', 1);
  const base = { modelAssetBuffer: buf, delegate: 'CPU' };
  tasks[key] = key === 'tap'
    ? await mod.InteractiveSegmenter.createFromOptions(fileset, { baseOptions: base, outputConfidenceMasks: true, outputCategoryMask: false })
    : await mod.ImageSegmenter.createFromOptions(fileset, { baseOptions: base, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: key === 'objects' });
  return tasks[key];
}

export function isLoaded(key) { return !!tasks[key]; }

function copyMask(m) { return { w: m.width, h: m.height, data: m.getAsFloat32Array().slice() }; }

/** DeepLab-v3 semantic segmentation (21 classes). */
export async function segmentObjects(canvas, status) {
  const seg = await getTask('objects', status);
  status?.('Detecting subjects…', 1);
  let out = null;
  seg.segment(canvas, res => {
    out = {
      masks: (res.confidenceMasks || []).map(copyMask),
      category: res.categoryMask ? { w: res.categoryMask.width, h: res.categoryMask.height, data: res.categoryMask.getAsUint8Array().slice() } : null,
    };
  });
  let labels = DEEPLAB_LABELS;
  try { const l = seg.getLabels(); if (l && l.length === out.masks.length) labels = l; } catch { /* older runtime */ }
  return { ...out, labels };
}

/** Selfie multiclass model → person probability (hair, skin, clothes, accessories). */
export async function segmentPeople(canvas, status) {
  const seg = await getTask('people', status);
  status?.('Refining people…', 1);
  let out = null;
  seg.segment(canvas, res => {
    const m = res.confidenceMasks || [];
    if (!m.length) return;
    const bg = copyMask(m[0]);
    const person = new Float32Array(bg.data.length);
    for (let i = 0; i < person.length; i++) person[i] = 1 - bg.data[i];
    out = { w: bg.w, h: bg.h, data: person };
  });
  return out;
}

/** Interactive "magic touch" segmentation around a tapped point (normalised x, y). */
export async function segmentAt(canvas, x, y, status) {
  const seg = await getTask('tap', status);
  status?.('Selecting…', 1);
  let out = null;
  seg.segment(canvas, { keypoint: { x, y } }, res => {
    const masks = (res.confidenceMasks || []).map(copyMask);
    if (!masks.length) return;
    const at = m => m.data[Math.min(m.h - 1, Math.round(y * (m.h - 1))) * m.w + Math.min(m.w - 1, Math.round(x * (m.w - 1)))];
    let best = masks[masks.length - 1];
    if (masks.length > 1) best = masks.reduce((a, b) => (at(b) > at(a) ? b : a));
    if (at(best) < 0.5) for (let i = 0; i < best.data.length; i++) best.data[i] = 1 - best.data[i];
    out = best;
  });
  return out;
}
