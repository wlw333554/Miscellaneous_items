// Web port: register the asset-cache service worker (see sw.js).
//
// Caching lives in a service worker rather than here because a page-side
// window.fetch override cannot see <script src> loads or
// audioWorklet.addModule() - and a page cannot intercept its own navigation
// either. The worker sees all of it.
//
// Cache Storage requires a secure context, so this is a no-op when the page is
// served over plain http from a LAN address; on localhost / https it works.
//
// window.__th06SwReady is awaited by the runtime bootstrap in th06.html. A
// worker does not intercept requests until it is active AND has claimed this
// page, so without that wait the very first load fires th06.data / th06.wasm /
// th06.js before the worker is in charge and none of them get cached - the
// cache would only fill up on the *second* load.
(function () {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    window.__th06SwReady = Promise.resolve(false);
    window.th06ClearAssetCache = function () { return Promise.resolve(false); };
    return;
  }

  var registered = navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (registration) {
    // Browsers only revalidate the worker script occasionally. Force a check so
    // a changed sw.js takes effect on the next load.
    try { registration.update(); } catch (e) {}
    return registration;
  }).catch(function (err) {
    console.warn('[asset-cache] service worker registration failed: ' + (err && err.message));
    return null;
  });

  // Resolve once the worker is actually controlling this page. Bounded, so a
  // broken worker can never block the game from starting.
  window.__th06SwReady = Promise.race([
    registered.then(function (registration) {
      if (!registration) return false;
      return navigator.serviceWorker.ready.then(function () {
        if (navigator.serviceWorker.controller) return true;
        // clients.claim() lands a moment after activation.
        return new Promise(function (resolve) {
          var settled = false;
          var finish = function (value) { if (!settled) { settled = true; resolve(value); } };
          navigator.serviceWorker.addEventListener('controllerchange', function () { finish(true); });
          setTimeout(function () { finish(!!navigator.serviceWorker.controller); }, 900);
        });
      });
    }),
    new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 3000); })
  ]).catch(function () { return false; });

  // Diagnostic channel: sw.js reports cache-store results here, so a failure is
  // visible from the page console instead of being silently swallowed.
  window.__th06SwLog = [];
  navigator.serviceWorker.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'th06-sw-error') return;
    window.__th06SwLog.push(data.message);
    console.log('[asset-cache] ' + data.message);
  });

  // Escape hatch for testing, or to recover from a bad entry:
  //   await th06ClearAssetCache()   then reload.
  window.th06ClearAssetCache = function () {
    try {
      if (!('caches' in window)) return Promise.resolve(false);
      return caches.keys().then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  };
})();
