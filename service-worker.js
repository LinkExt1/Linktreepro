// ================================================================
// SERVICE WORKER – LinkExt PWA
// Stratégie : Network First pour Firestore, Cache First pour assets
// ================================================================

const CACHE_NAME = 'linkext-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  // Ajoutez ici vos fichiers statiques (CSS, JS, images)
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://upload-widget.cloudinary.com/global/all.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
];

// Installation : mise en cache des ressources statiques
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Mise en cache des ressources statiques');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Interception des requêtes
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ---- EXCLURE STRICTEMENT FIRESTORE DU CACHE ----
  // Toutes les requêtes vers firestore.googleapis.com ou les sous-domaines
  // doivent être en Network First (jamais de cache)
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('firebaseio.com') ||
      url.pathname.startsWith('/v1/projects/') ||
      url.pathname.includes('/firestore/')) {
    
    // Stratégie Network First (avec fallback en cas d'échec, mais sans cache)
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // En cas d'échec réseau, on peut retourner une réponse d'erreur
          // ou tenter de lire le cache, mais mieux vaut ne pas cacher ces données
          return new Response('{"error":"Network error"}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // ---- AUTRES REQUÊTES : Cache First ou Network First selon le type ----
  // Pour les assets statiques (CSS, JS, images, fonts), on utilise Cache First
  if (event.request.destination === 'style' ||
      event.request.destination === 'script' ||
      event.request.destination === 'image' ||
      event.request.destination === 'font' ||
      event.request.destination === 'manifest') {
    
    event.respondWith(
      caches.match(event.request)
        .then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Si non trouvé en cache, on va chercher sur le réseau
          return fetch(event.request).then(response => {
            // Mettre en cache la nouvelle ressource (sauf si réponse non valide)
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, clone);
              });
            }
            return response;
          });
        })
        .catch(() => {
          // Fallback si tout échoue (ex: page hors ligne)
          return new Response('Ressource indisponible', { status: 404 });
        })
    );
    return;
  }

  // Pour les autres requêtes (API, pages HTML, etc.) : Network First
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // On peut mettre en cache les pages HTML pour une éventuelle lecture hors ligne
        if (response && response.status === 200 && event.request.destination === 'document') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // En cas d'échec, essayer le cache
        return caches.match(event.request)
          .then(cached => cached || new Response('Hors ligne', { status: 503 }));
      })
  );
});
