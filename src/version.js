// アプリの版と、「更新の確認」画面が見る数値表の一覧。
//
// ★版をこちら側（シェルの中身）に置くのが要点。
//   service worker に版を問い合わせる作りにすると、sw.js の CACHE_VERSION を返すことになり、
//   「新しい版名のキャッシュに古い中身が入っている」事故（判断ログ D-16・D-25）のときに
//   画面が「最新です」と嘘をつく。この定数は古いシェルなら古い値のまま表示されるため、
//   反映されていない端末はそのまま反映されていないと見える。
//
// ★sw.js の CACHE_VERSION と必ず同じ文字列にする（tests/version.test.js が一致を検査する）。
export const APP_VERSION = "v12";

// 「更新の確認」画面に並べる数値表。
//
// ★日付のキー名はファイルごとに違う。
//   最終確認日 … 人が原文にあたって確認した日
//   取得日     … 条文から機械的に生成した日（tools/fetch_*.mjs）
//   最終更新日 … リンク集を見直した日
//   揺れを画面側の総当たりで吸収しない。ファイルごとに1つだけ決め打ち、
//   外れたら画面に「日付が読めません」と出す（黙って別の日付を表示しない）。
//
// ★ここの `file` の集合は sw.js の DATA_FILES と一致させる
//   （tests/version.test.js が一致を検査する。メニューを増やしたとき片方だけ足す事故を防ぐ）。
export const KOUSHIN_ICHIRAN = [
  { file: "taishokukin", key: "最終確認日" },
  { file: "income_tax_rates", key: "最終確認日" },
  { file: "shokyakuritsu", key: "取得日" },
  { file: "genka_shokyaku", key: "最終確認日" },
  { file: "inshizei_hyo", key: "取得日" },
  { file: "inshizei", key: "最終確認日" },
  { file: "toroku_menkyozei_hyo", key: "取得日" },
  { file: "toroku_menkyozei", key: "最終確認日" },
  { file: "entaizei", key: "最終確認日" },
  { file: "hojinzei_hayami", key: "最終確認日" },
  { file: "link_shu", key: "最終更新日" },
  { file: "gengo", key: "最終確認日" },
  // 所得税エンジンの数値表。画面はまだ無いが、このアプリが持つ表の中で最も動きやすいので
  // 「更新の確認」に出す（設計原則6＝適用年度を画面に出すのが更新漏れの最後の防波堤）
  { file: "shotokuzei", key: "最終確認日" },
  { file: "juminzei", key: "最終確認日" },
  { file: "bunri_kazei", key: "最終確認日" },
];
