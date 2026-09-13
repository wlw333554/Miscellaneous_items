// Service worker: cache every same-origin GET the game makes, so a reload reads
// from disk instead of the network. th06.data alone is 17 MB, plus the 17 bgm
// FLACs, the wasm, the soundfont and the scripts.
//
// Why a service worker and not a page-side window.fetch override: only a worker
// sees <script src> loads and audioWorklet.addModule() - those never go through
// window.fetch, so a fetch override silently misses them.
//
// Policy:
//   * HTML documents are NEVER cached, so a rebuilt page is always fetched
//     fresh. A stale cached page is the classic footgun here.
//   * Everything else is cached and revalidated with If-Modified-Since, so
//     rebuilding th06.data / th06.wasm / a FLAC is picked up automatically
//     instead of silently serving an old build.
//   * Only same-origin GETs, and only complete 200 responses.
const CACHE_NAME = 'th06-assets-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function isDocument(request, url) {
  return request.mode === 'navigate' || request.destination === 'document' || /\.html?$/i.test(url.pathname);
}

// Content-Encoding has already been applied by the network stack, so the body we
// can read is DECODED while the inherited Content-Length is the COMPRESSED size.
// Storing it verbatim would make th06.js's "(loaded/total)" readout wrong on
// every cached load, so rebuild the header from the real byte count.
function normalise(response, buffer) {
  var headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  headers.set('Content-Length', String(buffer.byteLength));
  return new Response(buffer, { status: 200, statusText: 'OK', headers: headers });
}

// Surface failures instead of swallowing them: a silently failing cache put
// looks exactly like "caching is not working" with no clue why.
function report(message) {
  try {
    self.clients.matchAll({ includeUncontrolled: true }).then(function (list) {
      list.forEach(function (client) { client.postMessage({ type: 'th06-sw-error', message: message }); });
    });
  } catch (e) {}
  console.warn('[sw] ' + message);
}

function store(cache, request, response) {
  return response.clone().arrayBuffer().then(function (buffer) {
    return cache.put(request, normalise(response, buffer)).then(function () {
      report('stored ' + request.url + ' bytes=' + buffer.byteLength);
    });
  }).catch(function (err) {
    report('store FAILED for ' + request.url + ': ' + (err && err.name) + ': ' + (err && err.message));
  });
}

function handle(event, request) {
  var cache;
  return caches.open(CACHE_NAME).then(function (opened) {
    cache = opened;
    return cache.match(request);
  }).then(function (cached) {
    if (!cached) {
      return fetch(request).then(function (response) {
        // Keep the response streaming to the page (so the progress counter still
        // moves) and write the copy out of band.
        if (response && response.ok && response.status === 200) {
          event.waitUntil(store(cache, request, response));
        }
        return response;
      });
    }
    var lastModified = cached.headers.get('Last-Modified');
    if (!lastModified) return cached; // cannot revalidate: trust the copy
    return fetch(request, {
      cache: 'no-store',
      headers: { 'If-Modified-Since': lastModified }
    }).then(function (response) {
      if (response && response.status === 304) return cached;
      if (!response || !response.ok || response.status !== 200) return cached;
      event.waitUntil(store(cache, request, response));
      return response;
    }).catch(function () {
      return cached; // offline / server error: serve the cached copy
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isDocument(request, url)) return;
  event.respondWith(handle(event, request));
});
