// Offline support. App files: network-first (always fresh when online).
// Versioned CDN files (AI runtime): cache-first.
const CACHE = 'thaifund-app-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'favicon.svg', 'manifest.webmanifest',
  'js/main.js', 'js/app.js', 'js/store.js', 'js/schema.js', 'js/params.js', 'js/geometry.js', 'js/analysis.js',
  'js/engine/renderer.js', 'js/engine/shaders.js',
  'js/ui/kit.js', 'js/ui/section.js', 'js/ui/curves.js', 'js/ui/viewport.js',
  'js/panels/adjust.js', 'js/panels/subject.js', 'js/panels/crop.js', 'js/panels/looks.js', 'js/panels/export.js',
  'js/ai/segmenter.js', 'js/ai/refine.js',
  'js/export/encoders.js', 'js/export/decoders.js', 'js/export/resample.js',
  'fonts/plex-sans.woff2', 'fonts/plex-mono-400.woff2', 'fonts/plex-mono-500.woff2', 'fonts/instrument-serif.woff2', 'fonts/instrument-serif-italic.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('thaifund-app-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
