// Keeps the app itself available offline. Departures and map tiles come from
// other hosts and are never stored here: live data must stay fresh, and
// OpenStreetMap's tile policy does not allow bulk storage. The app saves its
// last departures on its own.

const CACHE = "abfahrt-v6";
const APP_FILES = [
  "./",
  "styles.css",
  "manifest.webmanifest",
  "js/api.js",
  "js/app.js",
  "js/direction.js",
  "js/i18n.js",
  "js/icons.js",
  "js/map.js",
  "icons/favicon.svg",
  "icons/favicon-32.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((file) => new Request(file, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // Network first, so updates show up as soon as the server is reachable.
  // "no-cache" makes the browser check with the server every time: simple web
  // servers send no caching rules, and an old cached page next to new code
  // would break the app.
  event.respondWith(
    fetch(event.request.url, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        return cached || (event.request.mode === "navigate" ? caches.match("./") : Response.error());
      }),
  );
});
