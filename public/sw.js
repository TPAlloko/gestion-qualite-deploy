self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : { title: 'Notification', body: '' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      tag: data.tag || 'demande-decision',
      renotify: true,
      data: { url: data.url || '/demandes' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow((event.notification.data && event.notification.data.url) || '/demandes'));
});
