/* Offline shell for Card Credits.
   Firestore keeps the data offline; this keeps the page, card art, Firebase SDK and fonts offline.
   Bump VERSION when you change the precache list. */
const VERSION = 'v2';
const CACHE = `card-credits-${VERSION}`;
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.19.0/';
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'calc.js', 'catalog.js', 'catalog-seed.js',
  'img/csr.webp', 'img/gold.webp', 'img/bilt.webp',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  FIREBASE + 'firebase-app.js', FIREBASE + 'firebase-auth.js', FIREBASE + 'firebase-firestore.js'
];
// Cross-origin files worth keeping. Firestore and Auth API calls are never intercepted.
const RUNTIME_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('card-credits-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;

  const sameOrigin = url.origin === self.location.origin;

  // The page and its own scripts: network first so updates show up together, cached copy when there's
  // no signal (or it takes over 4s). Scripts aren't served stale, so index.html and calc.js never mix versions.
  if (req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.js'))) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? 'index.html' : req;
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(rej, 4000))]);
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch {
        return (await cache.match(key)) || Response.error();
      }
    })());
    return;
  }

  if (!sameOrigin && !RUNTIME_HOSTS.includes(url.hostname)) return;

  // Everything else: serve from cache, refresh in the background
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || Response.error();
  })());
});
