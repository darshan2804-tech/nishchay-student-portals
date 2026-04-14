// Study Tracker - Enhanced Service Worker v4.0
// Strategy: Cache-first for assets, Network-first for Firebase

const CACHE_NAME = 'studytracker-v4';
const STATIC_ASSETS = [
  '/app.html',
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap'
];

// ── Install: pre-cache all static assets ──────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: smart routing ───────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and chrome-extension
  if (e.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Firebase / Google APIs → Network only (never cache auth/data)
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('googleapis.com') ||

    url.hostname.includes('accounts.google.com')
  ) {
    return; // Let browser handle normally
  }

  // Google Fonts → Cache first, fallback to network
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // App shell (HTML, CSS, JS, images) → Cache first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => null);

      return cached || fetchPromise;
    })
  );
});

// ── Background sync: flush pending saves when back online ─────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-entries') {
    e.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_REQUESTED' }));
      })
    );
  }
});

// ── Push notifications ────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Study Tracker', body: 'Time to revise!' };
  e.waitUntil(
    self.registration.showNotification(data.title || 'Study Tracker', {
      body: data.body || 'You have revisions due!',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'revision-reminder',
      renotify: true,
      vibrate: [200, 100, 200]
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/app'));
});
