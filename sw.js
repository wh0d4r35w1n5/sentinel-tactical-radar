// Sentinel Tactical Radar — service worker.
// Strategies:
//   static assets  -> cache-first, revalidate in background (instant paint)
//   api/*.json     -> stale-while-revalidate: serve the cached snapshot
//                     instantly (perceived latency ~0), refresh in background;
//                     on network failure the snapshot IS the answer —
//                     a Pages outage shows last-known-good data, never a hole.
//   fallback CDN   -> jsDelivr gh mirror, only when Pages itself is down
//                     (cached ~12h upstream; stale beats absent)
var VER = 'str-v8';
var STATIC = [
  '/sentinel-tactical-radar/',
  '/sentinel-tactical-radar/index.html',
  '/sentinel-tactical-radar/live-feed.js',
  '/sentinel-tactical-radar/harmonics.js',
  '/sentinel-tactical-radar/cps-detect.js',
  '/sentinel-tactical-radar/ta-engine.js',
  '/sentinel-tactical-radar/gallery.html',
  '/sentinel-tactical-radar/vendor/lightweight-charts-4.2.3.js',
  '/sentinel-tactical-radar/favicon.ico',
];
var JSD = 'https://cdn.jsdelivr.net/gh/wh0d4r35w1n5/sentinel-tactical-radar@main';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VER).then(function (c) { return c.addAll(STATIC); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return k === VER ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // API artifacts — SWR with last-known-good + jsDelivr failover
  if (url.pathname.indexOf('/sentinel-tactical-radar/api/') === 0) {
    e.respondWith(
      caches.open(VER).then(function (cache) {
        var key = url.pathname; // ignore cache-bust query for the cache key
        return cache.match(key).then(function (cached) {
          var fresh = fetch(e.request.url, { cache: 'no-store' })
            .then(function (res) {
              if (res.ok) { var cl = res.clone(); cache.put(key, cl); return res; }
              throw new Error('http ' + res.status);
            })
            .catch(function () {
              // Pages down/times out -> try the jsDelivr gh mirror once
              return fetch(JSD + url.pathname.replace('/sentinel-tactical-radar', ''), { cache: 'no-store' })
                .then(function (res) { return res.ok ? res : Promise.reject(res.status); });
            });
          // cached copy answers instantly; background fetch refreshes it.
          // Nothing cached -> wait for network (or the mirror) once.
          fresh.catch(function () {}); // swallow revalidate rejects when cache answered
          return cached || fresh.then(function (r) {
            if (r && r.ok) { try { cache.put(key, r.clone()); } catch (_) {} }
            return r;
          });
        });
      }).catch(function () { return new Response('null', { headers: { 'Content-Type': 'application/json' } }); })
    );
    return;
  }

  // HTML shell / navigations — network-first. A stale cached shell pins the
  // whole dashboard on dead render code; falling back to cache when offline
  // preserves the last-known-good behavior.
  if (e.request.mode === 'navigate' || url.pathname.slice(-5) === '.html' || url.pathname.slice(-1) === '/') {
    if (url.origin === location.origin) {
      e.respondWith(
        fetch(e.request).then(function (res) {
          if (res.ok) {
            var cl = res.clone();
            caches.open(VER).then(function (c) { c.put(e.request, cl); });
            return res;
          }
          throw new Error('http ' + res.status);
        }).catch(function () {
          return caches.match(e.request).then(function (cached) { return cached || Response.error(); });
        })
      );
      return;
    }
  }

  // same-origin static — cache-first, background revalidate
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(function (cached) {
        var reval = fetch(e.request).then(function (res) {
          if (res.ok) caches.open(VER).then(function (c) { c.put(e.request, res.clone()); });
          return res;
        }).catch(function () { return cached; });
        return cached || reval;
      })
    );
    return;
  }
});
