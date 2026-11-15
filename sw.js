/* Bonplein : service worker minimal.
   - Pages : le réseau d'abord (une nouvelle version s'affiche tout de suite), la copie en cache si hors ligne.
   - Fichiers du site (icônes, bibliothèque) : copie en cache, mise à jour en arrière-plan.
   - Prix, adresses, comptes (autres domaines) : jamais mis en cache, toujours en direct. */
const CACHE = "bonplein-v1";
const SHELL = ["./", "manifest.webmanifest", "icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && url.search === "") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("./", copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("./"))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
