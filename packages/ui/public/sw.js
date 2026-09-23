/**
 * Offline shell for the web and home-screen builds.
 *
 * There is nothing to sync with a server here - the replica is already in
 * IndexedDB and the peer connections are made by the page itself. All this
 * does is make sure the app *starts* without a network, which for a
 * home-screen icon on a phone is the difference between an app and a bookmark.
 *
 * Two policies, chosen by what the file is:
 *
 *   hashed assets   cache first. Vite puts a content hash in the filename, so
 *                   a given URL never changes meaning and the cache can never
 *                   go stale.
 *   everything else network first, falling back to cache. The entry document
 *                   has a stable name, so serving it from cache first would
 *                   pin people to whichever build they first opened.
 */
const VERSION = 's2s-v1'
const HASHED = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css)$/

self.addEventListener('install', (event) => {
  // Take over as soon as this version is ready rather than waiting for every
  // other tab to close.
  self.skipWaiting()
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest']))
      // A missing file here must not leave the app with no worker at all.
      .catch(() => {})
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (HASHED.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
  } else {
    event.respondWith(networkFirst(request))
  }
})

async function cacheFirst (request) {
  const hit = await caches.match(request)
  if (hit) return hit

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(VERSION)
    cache.put(request, response.clone())
  }
  return response
}

async function networkFirst (request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(VERSION)
      cache.put(request, response.clone())
    }
    return response
  } catch (err) {
    const hit = await caches.match(request)
    if (hit) return hit
    // A navigation with nothing cached still has to resolve to something.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html')
      if (shell) return shell
    }
    throw err
  }
}
