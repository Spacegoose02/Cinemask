// Cinemask service worker: makes the app installable and quick to open, and shows a friendly
// screen when the server can't be reached. It never caches /api, so no private data is stored
// on the device and signing out leaves nothing behind.
const VERSION = 'v2';
const SHELL = `cinemask-shell-${VERSION}`;
const ASSETS = `cinemask-assets-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo-128.png', '/favicon-32.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(PRECACHE)),
      // The page's own scripts and styles were loaded before this worker existed, so save them now
      // too; otherwise the first offline open would have a page with no app in it.
      fetch('/')
        .then((res) => res.text())
        .then((html) => {
          const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          return caches.open(ASSETS).then((c) => c.addAll(files));
        })
        .catch(() => undefined),
    ]),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cinemask-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks for this when the user accepts "a new version is ready". Only our own pages can
// reach a service worker, but check the sender anyway.
self.addEventListener('message', (event) => {
  if (event.origin !== self.location.origin) return;
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Other sites (posters, trailers) and the API always go straight to the network.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;

  if (req.mode === 'navigate') {
    // Pages: always the latest from the server, the saved copy only when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Built files have a content hash in their name, so a saved copy is always right.
    event.respondWith(
      caches.open(ASSETS).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) void c.put(req, res.clone());
              return res;
            }),
        ),
      ),
    );
    return;
  }

  // Icons and other public files: answer from the cache, refresh it in the background.
  event.respondWith(
    caches.open(SHELL).then((c) =>
      c.match(req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) void c.put(req, res.clone());
            return res;
          })
          .catch(() => hit || Response.error());
        return hit || network;
      }),
    ),
  );
});

// Push notifications (Account → Notifications). The server only sends a title, a line of text
// and the page to open; nothing is stored.
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Cinemask', body: event.data ? event.data.text() : '' };
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(data.title || 'Cinemask', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/favicon-32.png',
      tag: data.tag || undefined,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin));
      if (open) return open.focus().then((w) => w.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
