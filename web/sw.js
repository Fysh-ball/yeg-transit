// Bump ?v= here, in index.html and in app.js (sw register) with CACHE: Cloudflare edge-caches JS for 4 h.
// App shell cached for offline start; /api is always network (the page falls back to its saved timetables).
const CACHE = "yeg-v112";
const SHELL = ["./", "index.html", "style.css?v=112", "app.js?v=112", "manifest.webmanifest", "icon.svg", "cookie.svg"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first so updates land; the saved copy when offline or when the site answers an error (a 5xx while online
  // must still open the saved timetables and the 31100 button). A page with a ?query falls back to the saved app.
  const saved = () => caches.match(e.request).then((c) => c || (e.request.mode === "navigate" ? caches.match("./") : undefined));
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; } // an error page must not replace the offline copy
    return r.status >= 500 ? saved().then((c) => c || r) : r;
  }).catch(() => saved().then((c) => c || Response.error())));
});
