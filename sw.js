const CACHE_NAME = "privacy-filter-offline-v1";

// アプリ本体（必須）
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json"
];

// kuromoji.js 本体および日本語辞書（IPADIC 12ファイル）
const DICT_ASSETS = [
  "./dict/kuromoji.js",
  "./dict/base.dat.gz",
  "./dict/cc.dat.gz",
  "./dict/check.dat.gz",
  "./dict/tid.dat.gz",
  "./dict/tid_map.dat.gz",
  "./dict/tid_pos.dat.gz",
  "./dict/unk.dat.gz",
  "./dict/unk_char.dat.gz",
  "./dict/unk_compat.dat.gz",
  "./dict/unk_invoke.dat.gz",
  "./dict/unk_map.dat.gz",
  "./dict/unk_pos.dat.gz"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS);
      // 辞書ファイルは個別にキャッシュし、万一未配置でも本体インストールを妨げない
      await Promise.allSettled(
        DICT_ASSETS.map(async (url) => {
          const response = await fetch(url);
          if (response.ok) {
            await cache.put(url, response);
          }
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // GET 以外の通信や外部オリジンへのアクセスはキャッシュ対象外
  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // キャッシュ優先（オフライン時に確実に起動させるため）
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, copy);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // ページ遷移でオフライン失敗した場合は index.html を返す
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        });
    })
  );
});