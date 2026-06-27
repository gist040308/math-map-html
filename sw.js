/**
 * frontend/sw.js
 * ================
 * Service Worker：預快取 data/ 目錄文件，支援離線瀏覽。
 *
 * 策略：
 * - install 階段預快取核心文件（graph_meta.json、quadtree.json、search_index.json）
 * - data/ 下其餘請求採 stale-while-revalidate（先回快取，背景更新）
 * - 非 data/ 請求（HTML/JS/CSS）採 network-first，失敗時回退快取
 *
 * 子路徑部署相容性：
 * 這個檔案不假設網站部署在網域根目錄。例如部署到 GitHub Pages 時，
 * 實際網址會是 https://帳號.github.io/repo名稱/，比根目錄多了一層
 * /repo名稱/ 前綴。若程式碼寫死 "/data/..." 這種絕對路徑，會被誤判
 * 為網域根目錄下的 /data/，導致 404。因此這裡改用
 * self.registration.scope（Service Worker 註冊時的作用範圍，
 * 會自動包含正確的子路徑前綴）來推算所有路徑。
 */

const CACHE_VERSION = "mathlib-viz-v1";

// BASE_PATH 範例：根目錄部署時為 "/"；GitHub Pages 子路徑部署時
// 為 "/repo名稱/"。一律以 self.registration.scope 為準，不寫死。
const BASE_PATH = new URL(self.registration.scope).pathname;

const CORE_ASSETS = [
  `${BASE_PATH}data/graph_meta.json`,
  `${BASE_PATH}data/index/quadtree.json`,
  `${BASE_PATH}data/index/search_index.json`,
  `${BASE_PATH}data/index/adjacency.json`,
  `${BASE_PATH}data/stats.json`,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // 逐個快取，個別失敗不影響其他文件（避免單一 404 導致整個 install 失敗）
      return Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[sw] 預快取失敗（略過）：${url}`, err);
          })
        )
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
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET") return;

  const dataPrefix = `${BASE_PATH}data/`;
  const apiPrefix = `${BASE_PATH}api/`;

  if (url.pathname.startsWith(dataPrefix)) {
    event.respondWith(staleWhileRevalidate(event.request));
  } else if (url.pathname.startsWith(apiPrefix)) {
    // API 請求一律走網路，不快取（資料可能即時變化）
    return;
  } else {
    event.respondWith(networkFirst(event.request));
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await networkFetch) || new Response("offline", { status: 503 });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);
    return cached || new Response("offline", { status: 503 });
  }
}
