/* SCI BAM Radar — service worker
   Stratégie :
   - HTML (navigation) : réseau d'abord, puis cache hors-ligne (pour voir les MAJ de la veille dès qu'on est en ligne).
   - Icônes / manifeste : cache d'abord.
   - Photos SeLoger : cache d'abord, MAJ en arrière-plan (visibles hors-ligne). */
const VERSION = 'sci-bam-v33';
const SHELL = 'shell-' + VERSION;
const IMG = 'img-' + VERSION;
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-512-maskable.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== IMG).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pages HTML : réseau d'abord (récupère les MAJ de la veille), repli cache hors-ligne.
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Photos d'annonces : cache d'abord, rafraîchies en arrière-plan.
  if (url.hostname.endsWith('seloger.com') || req.destination === 'image') {
    e.respondWith(
      caches.open(IMG).then(c => c.match(req).then(hit => {
        const net = fetch(req).then(res => { c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => hit);
        return hit || net;
      }))
    );
    return;
  }

  // Reste (icônes, manifeste, même origine) : cache d'abord.
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});
