/* Add cross-origin isolation on static hosts that cannot configure headers.
 * Hosts that already send COOP/COEP never register this worker. */
(function bootstrapIsolation(scope) {
  "use strict";

  if (typeof Window !== "undefined" && scope instanceof Window) {
    if (scope.crossOriginIsolated || !scope.isSecureContext ||
        !("serviceWorker" in navigator)) {
      return;
    }

    let reloading = false;
    const reloadUnderWorker = () => {
      if (reloading) return;
      reloading = true;
      scope.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", reloadUnderWorker);
    navigator.serviceWorker.register(document.currentScript.src, { scope: "./" })
      .then(registration => {
        if (registration.active && !navigator.serviceWorker.controller) {
          reloadUnderWorker();
        }
      })
      .catch(error => {
        console.warn("Static-host isolation could not start:", error);
      });
    return;
  }

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", event => {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
      return;
    }
    event.respondWith(fetch(event.request).then(response => {
      if (response.type === "opaque" || response.type === "opaqueredirect") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }));
  });
})(globalThis);
