// Service worker: Web Push notifications only. There is deliberately no fetch handler
// or cache, so the app always loads fresh from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    (async () => {
      // The open page already shows what happened; only test messages always appear.
      if (!data.test) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;
      }
      await self.registration.showNotification(data.title || 'Anywhere Coding', {
        body: data.body || '',
        tag: data.tag,
        renotify: !!data.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { url: data.url || '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = windows.find((w) => w.focused) || windows[0];
      if (win) {
        await win.focus();
        // The app switches to the session itself; navigating would reload the page.
        win.postMessage({ type: 'open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The browser rotated the subscription: register the new one with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const info = await fetch('/api/push', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
      if (!info) return;
      const key = Uint8Array.from(atob(info.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    })(),
  );
});
