// service worker: guarda a "casca" do app para abrir sem internet. Dados vêm do IndexedDB (app.js).
const CACHE = 'clia-v0.1.0';
const ARQUIVOS = ['./', './index.html', './app.js', './app.css', './style.css', './manifest.webmanifest', './icone.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin && !u.hostname.startsWith('esm.sh') && !u.hostname.includes('fonts.g')) return; // Supabase passa direto
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    if (res.ok && e.request.method === 'GET') caches.open(CACHE).then(c => c.put(e.request, res.clone()));
    return res;
  })));
});
