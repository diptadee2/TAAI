// Service worker for the progress tracker (2026-11-20). Only job: show the
// Focus timer's notifications on browsers that won't show them straight
// from the page (Android Chrome, iPad/iPhone home-screen apps). No fetch
// handler on purpose: it never caches or intercepts anything.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf('/gate-da-progress-tracker') !== -1 && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow('/gate-da-progress-tracker');
  }));
});
