// Offline support. Serve from cache at once and refresh the cache in the background, so a repeat
// visit opens instantly. When the refreshed page differs from the cached one, tell open tabs;
// the app reloads onto it when that interrupts nothing.
const CACHE = 'coil-v2';
const CORE = ['/', '/fonts/anybody.woff2', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

const tag = (res) => res && (res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length'));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const nav = e.request.mode === 'navigate';
  const key = nav ? '/' : e.request;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key);
      const fresh = fetch(e.request)
        .then(async (res) => {
          if (res.ok) {
            await cache.put(key, res.clone());
            if (nav && hit && tag(hit) !== tag(res)) {
              for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage('updated');
            }
          }
          return res;
        })
        .catch(() => hit);
      if (hit) e.waitUntil(fresh);
      return hit || fresh;
    }),
  );
});
