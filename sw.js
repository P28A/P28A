// Service Worker für die PA-28-161 Cadet Flight-Prep-App.
//
// Zweck: Die App-Hülle (index.html + die externe jsPDF-Bibliothek) wird beim ersten
// Laden gecacht, damit die App auch ohne Internetverbindung geöffnet werden kann
// (z.B. beim Antippen des Homescreen-Icons ohne Netz) – dann zeigt index.html direkt
// die eigene Offline-Seite an, statt dass Safari seine eigene Fehlermeldung zeigt.
//
// Bewusst NICHT gecacht werden Wetterdaten, NOTAMs o.ä. (die kommen ohnehin nur mit
// bestehender Verbindung sinnvoll rein) – hier geht es nur darum, dass die App selbst
// startfähig bleibt.

const CACHE_NAME = 'p28a-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Externe (cross-origin) Ressourcen einzeln im 'no-cors'-Modus cachen, damit ein
      // fehlgeschlagener CDN-Request (z.B. CORS) nicht die gesamte Installation
      // blockiert.
      return Promise.all(
        APP_SHELL.map(url => {
          const request = new Request(url, url.startsWith('http') ? {mode:'no-cors'} : {});
          return fetch(request)
            .then(response => cache.put(url, response))
            .catch(() => { /* einzelne Ressource nicht erreichbar -> ignorieren */ });
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Strategie: "Network falling back to cache" für Navigationen (HTML-Seitenaufrufe),
// damit bei bestehender Verbindung immer die aktuellste Version geladen wird und nur
// offline auf die zwischengespeicherte Version zurückgegriffen wird. Für alle anderen
// Requests (z.B. jsPDF) analog.
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(()=>{});
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('./index.html'))
      )
  );
});
