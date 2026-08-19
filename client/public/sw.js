const CACHE = "crown-v1";
const ASSETS = ["/", "/index.html", "/manifest.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // API cache for games, tournaments, health (T-072, T-074)
  if (url.pathname.startsWith("/api/v1/games") || url.pathname.startsWith("/api/v1/tournaments") || url.pathname.startsWith("/api/v1/health") || url.pathname === "/health" || url.pathname.startsWith("/api/v1/leaderboard")) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match("/index.html")))
  );
});
