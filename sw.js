// sw.js — the service worker that lets the app open with no signal.
//
// Strategy: try the network first (so updates show up right away), but if the
// network is slow (>3s) or down, use the copy saved on the phone.
// When you add a new file to the app, add it to APP_FILES and bump VERSION.

const VERSION = 'v7';
const CACHE = `punchlist-${VERSION}`;
const APP_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/ui.js',
  'js/sheet-render.js',
  'js/drawing-view.js',
  'js/item-form.js',
  'js/photo-markup.js',
  'js/filters.js',
  'js/trades.js',
  'js/list-view.js',
  'js/project-screen.js',
  'js/export.js',
  'js/photos-view.js',
  'js/pdf-export.js',
  'vendor/dexie.min.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/exceljs.min.js',
  'vendor/jszip.min.js',
  'vendor/pdf-lib.min.js',
  'templates/procore-punch-import.xlsx',
  'brand/logo.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (!cached) return network;
  const slow = new Promise((resolve) => setTimeout(() => resolve(cached), 3000));
  return Promise.race([network.catch(() => cached), slow]);
}
