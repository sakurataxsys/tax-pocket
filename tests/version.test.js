// 「更新の確認」画面が寄りかかっている前提のテスト（判断ログ D-25）。
//
// この画面には税額の計算が無いので、端数処理・境界値・改正前後の分岐という3種の枠は当てはまらない。
// 代わりに、この画面が **黙って嘘をつく** 3つの経路を塞ぐ。
//   ① 版の二重管理 … src/version.js と sw.js の版がずれると、画面が別の版を名乗る
//   ② 一覧の取りこぼし … メニューを増やしたとき sw.js の DATA_FILES にだけ足すと、
//      新しい数値表が「更新の確認」から黙って消える（オフラインでは気づけない）
//   ③ 日付キーの取り違え … 決め打ったキーが実ファイルに無いと、画面が「日付が読めません」になる
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_VERSION, KOUSHIN_ICHIRAN } from "../src/version.js";

const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

const read_data = (file) =>
  JSON.parse(readFileSync(new URL(`../data/${file}.json`, import.meta.url), "utf8"));

describe("アプリの版", () => {
  test("src/version.js の APP_VERSION と sw.js の CACHE_VERSION が一致する", () => {
    const m = sw.match(/^const CACHE_VERSION = "([^"]+)";$/m);
    assert.ok(m, "sw.js の CACHE_VERSION の宣言を読み取れなかった");
    assert.equal(
      APP_VERSION,
      m[1],
      "版がずれている。ロジックを変えたら両方を同じ値に上げること",
    );
  });

  test("版は v から始まる連番の形をしている", () => {
    assert.match(APP_VERSION, /^v[0-9]+$/);
  });
});

describe("更新の確認に並べる数値表の一覧", () => {
  // sw.js の DATA_FILES（install のときに取り込む一覧）を読む
  const sw_data_files = (() => {
    const block = sw.match(/const DATA_FILES = \[([\s\S]*?)\];/);
    assert.ok(block, "sw.js の DATA_FILES を読み取れなかった");
    return [...block[1].matchAll(/"\.\/data\/([^"]+)\.json"/g)].map((m) => m[1]);
  })();

  test("sw.js の DATA_FILES と同じ顔ぶれである", () => {
    assert.deepEqual(
      [...KOUSHIN_ICHIRAN.map((t) => t.file)].sort(),
      [...sw_data_files].sort(),
      "計算メニューを増やしたときは src/version.js と sw.js の両方に足すこと",
    );
  });

  test("同じファイルを二重に並べていない", () => {
    const files = KOUSHIN_ICHIRAN.map((t) => t.file);
    assert.equal(new Set(files).size, files.length);
  });
});

describe("日付のキー", () => {
  for (const t of KOUSHIN_ICHIRAN) {
    test(`data/${t.file}.json は「${t.key}」を持つ`, () => {
      const json = read_data(t.file);
      assert.equal(
        typeof json[t.key],
        "string",
        `キー名が変わっている。画面は別の日付で代用せず「日付が読めません」と出る`,
      );
      assert.match(json[t.key], /^\d{4}-\d{2}-\d{2}$/);
    });

    test(`data/${t.file}.json は日付のキーを1つしか持たない`, () => {
      // 総当たりで拾う実装をやめた以上、複数あると「どちらが正か」が画面から見えなくなる。
      // 例：自動生成物（取得日）に人が「最終確認日」を書き足すと、生成日が画面から消える
      const json = read_data(t.file);
      const ある = ["最終確認日", "取得日", "最終更新日"].filter((k) => k in json);
      assert.deepEqual(ある, [t.key]);
    });

    test(`data/${t.file}.json は「名称」を持つ（画面の行名になる）`, () => {
      assert.equal(typeof read_data(t.file)["名称"], "string");
    });
  }
});
