// 配布手順書の PDF を作る。
//
//   node tools/build_tejunsho_pdf.mjs
//
// docs/配布手順書.html を Chrome の印刷機能でそのまま PDF にする。
// PDF を別に組み直さないのは、手順書の正本を増やさないため。
// 直すのは docs/配布手順書.md と docs/配布手順書.html の2つだけで、PDF は毎回ここから起こす。
//
// ★PDF はリポジトリに置かない（出力先は ClaudeDocument/output）。
//   置くと「md・html・pdf の3つを揃えて直す」保守が生まれ、必ずどれかが古くなる。
//
// 用紙・余白は HTML 側の @page（A4）で指定してある。

import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const src = resolve("docs/配布手順書.html");
const out = resolve(homedir(), "ClaudeDocument/output/税額ポケット_使い方.pdf");

if (!existsSync(src)) {
  console.error(`元の HTML が見つかりません：${src}`);
  process.exit(1);
}

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("Chrome も Edge も見つかりませんでした。上の CHROME_CANDIDATES に実行ファイルの場所を足してください。");
  process.exit(1);
}

await mkdir(dirname(out), { recursive: true });

// --no-pdf-header-footer … 既定で入るURL・ページ番号・日付を消す。
//   日付が入ると、印刷した日を「手順書の更新日」と読み違える職員が出るため。
const args = [
  "--headless",
  "--disable-gpu",
  "--no-pdf-header-footer",
  `--print-to-pdf=${out}`,
  pathToFileURL(src).href,
];

const code = await new Promise((done) => {
  const p = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (b) => (err += b));
  p.on("close", (c) => {
    if (c !== 0) console.error(err.trim());
    done(c);
  });
});

if (code !== 0 || !existsSync(out)) {
  console.error("PDF を作れませんでした。");
  process.exit(1);
}

const { size } = await stat(out);
console.log(`作成しました：${out}（${(size / 1024).toFixed(0)} KB）`);
