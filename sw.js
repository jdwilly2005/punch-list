// sw.js — the service worker that lets the app open with no signal.
//
// Strategy: the app runs from ONE complete saved copy (one VERSION), so a phone never
// mixes old and new files. When VERSION changes, the browser installs the new copy in
// the background (downloading every file fresh), then swaps it in all at once and the
// page reloads itself (see app.js).
//
// EVERY PUBLISH: bump VERSION here AND APP_VERSION in js/ui.js (they must match).
// When you add a new file to the app, also add it to APP_FILES.
// On localhost the network is always used, so local testing never shows stale files.

const VERSION = 'v23';
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
  'js/trade-picker.js',
  'js/report-pdf.js',
  'js/backup.js',
  'js/cloud.js',
  'js/account.js',
  'vendor/dexie.min.js',
  'vendor/pdf.min.mjs',
  'vendor/pdf.worker.min.mjs',
  'vendor/exceljs.min.js',
  'vendor/jszip.min.js',
  'vendor/pdf-lib.min.js',
  'vendor/supabase.min.js',
  'templates/procore-punch-import.xlsx',
  'brand/logo.png',
  'fonts/oswald-700.woff2',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's own short-term cache, so every file is truly the new version.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(
    APP_FILES.map((url) => new Request(url, { cache: 'reload' })))));
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
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin || IS_LOCAL) return;
  event.respondWith(fromSavedCopy(req));
});

// Saved copy first (fast, works offline, always one consistent version); the network
// only for anything that isn't part of the saved app.
async function fromSavedCopy(req) {
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
  return cached || fetch(req);
}
