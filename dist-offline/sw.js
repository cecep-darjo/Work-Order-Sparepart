self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'EngWO Inventory', body: event.data.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'EngWO Inventory', {
    body: data.body || 'Ada notifikasi baru.',
    icon: data.icon || '/notification-icon.svg',
    badge: data.badge || '/notification-icon.svg',
    tag: data.tag,
    data: data.data || { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
