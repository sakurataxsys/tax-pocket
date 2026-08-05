// 税額ポケット の service worker
//
// キャッシュを2系統に分ける（判断ログ D-16）
//   アプリシェル … 版付きの cache-first。関与先での起動を最速にする
//   data/*.json  … network-first（2秒で打ち切り）→ 失敗したら端末のキャッシュ
//                  税率表を差し替えたその日に反映させるため
//
// ★ロジック（src/ 配下）を変更したら CACHE_VERSION を上げること。
//   data/*.json を差し替えるだけの改正では上げる必要はない（network-first のため）。

// ★src/version.js の APP_VERSION と同じ文字列にする（tests/version.test.js が一致を検査する）。
//   画面に出す版は APP_VERSION（＝シェルの中身）であって、この定数ではない。理由は src/version.js に書いた。
const CACHE_VERSION = "v9";
const SHELL_CACHE = `tax-pocket-shell-${CACHE_VERSION}`;
const DATA_CACHE = "tax-pocket-data"; // 版を付けない。シェルの版を上げてもデータは残す

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles/app.css",
  "./src/app.js",
  "./src/ui.js",
  "./src/data.js",
  "./src/format.js",
  "./src/version.js",
  "./src/calc/taishokukin.js",
  "./src/calc/genka_shokyaku.js",
  "./src/calc/inshizei.js",
  "./src/calc/toroku_menkyozei.js",
  "./src/calc/entaizei.js",
  "./src/calc/hojinzei_hayami.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon-180.png",
];

// install のときに一緒に取り込む税率表。
// ★初回訪問では service worker がまだページを制御しておらず、画面からの取得は
//   ここを通らない。install で入れておかないと「1回開いてホーム画面に追加し、
//   そのまま電波のない関与先へ行った」端末で税率表だけ無い状態になる。
// 計算メニューを増やすときは、ここにも足すこと（メニュー追加は開発者の作業なので、
// 税務職員が data/ を差し替えるだけの改正でここを触る必要はない）。
const DATA_FILES = [
  "./data/taishokukin.json",
  "./data/income_tax_rates.json",
  "./data/shokyakuritsu.json",
  "./data/genka_shokyaku.json",
  "./data/inshizei.json",
  "./data/inshizei_hyo.json",
  "./data/toroku_menkyozei.json",
  "./data/toroku_menkyozei_hyo.json",
  "./data/entaizei.json",
  "./data/link_shu.json",
  "./data/hojinzei_hayami.json",
];

const DATA_TIMEOUT_MS = 2000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // ★cache: "reload" が要る。
      // GitHub Pages は資産に Cache-Control: max-age=600 を付けるため、これを付けないと
      // 版を上げた直後10分以内に開いた端末が「新しい版名のキャッシュに古い中身」を抱え、
      // cache-first なので次の版まで直らない。
      await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));

      // 税率表も入れておく。取れなくても install は失敗させない（後で network-first が拾う）
      const data_cache = await open_data_cache();
      await Promise.all(
        DATA_FILES.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (res.ok) await data_cache.put(url, res);
          } catch {
            // 通信できない状態での install。次に開いたときに取りに行く
          }
        }),
      );

      // 待たせずに新しい版へ切り替える（関与先で古い版が残らないようにする）
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes("/data/")) {
    event.respondWith(network_first(event));
  } else {
    event.respondWith(cache_first(req));
  }
});

// data 用のキャッシュは開く約束を1つだけ持ち回す。
// 複数の JSON を同時に取りに行くと caches.open() が同時に新規作成を試みて競合し、
// どちらの保存も失われる（＝オフラインで動かなくなる）。
let data_cache_promise = null;
function open_data_cache() {
  if (!data_cache_promise) data_cache_promise = caches.open(DATA_CACHE);
  return data_cache_promise;
}

/** 指定ミリ秒で打ち切る */
function with_timeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 税率表など：つながるなら最新、つながらなければ端末のキャッシュ */
async function network_first(event) {
  const req = event.request;
  try {
    const res = await with_timeout(
      fetch(new Request(req.url, { cache: "reload" })),
      DATA_TIMEOUT_MS,
    );
    if (res && res.ok) {
      const copy = res.clone();
      try {
        const cache = await open_data_cache();
        await cache.put(req, copy);
      } catch {
        // 保存に失敗しても、取得できた内容はそのまま画面へ渡す
      }
      return res;
    }
  } catch {
    // 通信できない・遅い → キャッシュへ落とす
  }
  const cache = await open_data_cache();
  const hit = await cache.match(req);
  if (hit) return hit;
  return new Response(JSON.stringify({ error: "offline" }), {
    status: 504,
    headers: { "Content-Type": "application/json" },
  });
}

/** アプリシェル：キャッシュ優先 */
async function cache_first(req) {
  const cached = await caches.match(req, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch {
    if (req.mode === "navigate") {
      const fallback = await caches.match("./index.html", { cacheName: SHELL_CACHE });
      if (fallback) return fallback;
    }
    return new Response("", { status: 504 });
  }
}
