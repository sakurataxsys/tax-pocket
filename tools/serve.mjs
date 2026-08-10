// 開発用の静的サーバ。Node の標準モジュールだけで動く（依存を増やさないため）。
//
//   node tools/serve.mjs   →  http://localhost:8080/
//
// service worker は file:// では動かないため、動作確認は必ずこのサーバ経由で行う。
// なお本番（GitHub Pages）は資産に Cache-Control: max-age=600 を付けるが、
// このサーバは no-store を返す。HTTP キャッシュがらみの確認は本番でしかできない。

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

// tools/icon-source.html が描いた PNG を icons/ に書き戻すための口。
// **開発専用**。GitHub Pages は静的配信なので、この経路は公開先には存在しない。
// 書ける先は下の3つのファイル名だけに固定する（パスを受け取らない）。
const ICON_FILES = new Set(["icon-512.png", "icon-192.png", "apple-touch-icon-180.png"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

  // アイコンの書き戻し（開発専用）。{ file, dataurl } を受け取る
  if (req.method === "POST" && pathname === "/__save-icon") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const { file, dataurl } = JSON.parse(raw);
      if (!ICON_FILES.has(file)) throw new Error(`書ける先ではありません: ${file}`);
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataurl ?? "");
      if (!m) throw new Error("PNG の data URL ではありません");
      await writeFile(join(ROOT, "icons", file), Buffer.from(m[1], "base64"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, file }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, riyu: String(e.message ?? e) }));
    }
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";

  const file = join(ROOT, normalize(pathname));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}).listen(PORT, () => {
  console.log(`税額ポケット: http://localhost:${PORT}/`);
});
