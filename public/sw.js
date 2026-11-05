const CACHE = "mawada-shell-chat-v2";
const ASSETS = [
  "/index.html",
  "/style.css",
  "/theme.js",
  "/access.js",
  "/operations.js",
  "/control.js",
  "/dispatch-ui.js",
  "/control-ui.js",
  "/proof-drafts.js",
  "/tracking-labels.js",
  "/demo.js",
  "/app.js",
  "/chat.js",
  "/brand/mawada-logo.png",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mawada-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  if (["/", "/driver"].includes(url.pathname)) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html")),
    );
    return;
  }
  if (ASSETS.includes(url.pathname))
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
});
