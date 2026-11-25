// DreewSolution · notificações no celular e funcionamento com internet fraca
const CACHE = 'space-v6';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/index.html', '/manifest.webmanifest', '/icon-192.png'])).catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  // Páginas do app: tenta a internet primeiro; se cair, abre a última versão guardada.
  if (r.mode === 'navigate' && u.origin === self.location.origin) {
    const chave = (u.pathname === '/' || u.pathname === '/buscar' || u.pathname === '/buscar.html') ? '/buscar.html' : '/index.html';
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(k => k.put(chave, c)); } return res; })
      .catch(() => caches.match(chave)));
    return;
  }
  // Biblioteca do banco, fontes e ícones: usa o que já tem e atualiza por trás.
  if (u.hostname === 'cdn.jsdelivr.net' || u.hostname.endsWith('gstatic.com') || u.hostname === 'fonts.googleapis.com' || (u.origin === self.location.origin && /\.(png|webmanifest)$/.test(u.pathname))) {
    e.respondWith(caches.open(CACHE).then(k => k.match(r).then(hit => {
      const net = fetch(r).then(res => { if (res.ok || res.type === 'opaque') k.put(r, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { title: 'DreewSolution', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'DreewSolution', {
    body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
    tag: d.tag, renotify: !!d.tag, vibrate: [120, 60, 120], data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    for (const c of lista) {
      if (c.url.split('#')[0] === alvo.split('#')[0] && 'focus' in c) { c.navigate(alvo); return c.focus(); }
    }
    return clients.openWindow(alvo);
  }));
});
