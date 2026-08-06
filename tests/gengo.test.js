// 元号変換のテスト
//
// 年単位の変換専用（月日は扱わない）。3種の代わりに、この機能の性質に合わせた5種を置く。
//   ① 元号テーブルの固定検査　② 境界値（改元年の両立表記を含む）
//   ③ 妥当性チェック（上限・下限・未来年の警告）　④ 年齢概算　⑤ format.js との整合
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  seireki_from_gengo,
  gengo_from_seireki,
  calc_nenrei_gaisan,
} from "../src/calc/gengo.js";
import { format_nen } from "../src/format.js";

const gengo = JSON.parse(
  readFileSync(new URL("../data/gengo.json", import.meta.url), "utf8"),
);
const list = gengo["元号一覧"];

// ------------------------------------------------------ ① 元号テーブルの固定検査

describe("① 元号テーブルの固定検査", () => {
  test("5元号の名称・開始西暦年が完全一致する（次の改元が起きてもテストは検知できないため、人が追記する運用）", () => {
    assert.deepEqual(list, [
      { 名称: "明治", 開始西暦年: 1868 },
      { 名称: "大正", 開始西暦年: 1912 },
      { 名称: "昭和", 開始西暦年: 1926 },
      { 名称: "平成", 開始西暦年: 1989 },
      { 名称: "令和", 開始西暦年: 2019 },
    ]);
  });
});

// -------------------------------------------------------------- ② 境界値

describe("② 境界値", () => {
  test("各元号の1年目", () => {
    assert.equal(seireki_from_gengo("明治", 1, list, 2026).seireki, 1868);
    assert.equal(seireki_from_gengo("大正", 1, list, 2026).seireki, 1912);
    assert.equal(seireki_from_gengo("昭和", 1, list, 2026).seireki, 1926);
    assert.equal(seireki_from_gengo("平成", 1, list, 2026).seireki, 1989);
    assert.equal(seireki_from_gengo("令和", 1, list, 2026).seireki, 2019);
  });

  test("改元年の逆変換は両方の元号年を返す（明治45年・大正元年など）", () => {
    assert.deepEqual(gengo_from_seireki(1912, list, 2026).kouho, [
      { mei: "明治", gengo_nen: 45 },
      { mei: "大正", gengo_nen: 1 },
    ]);
    assert.deepEqual(gengo_from_seireki(1926, list, 2026).kouho, [
      { mei: "大正", gengo_nen: 15 },
      { mei: "昭和", gengo_nen: 1 },
    ]);
    assert.deepEqual(gengo_from_seireki(1989, list, 2026).kouho, [
      { mei: "昭和", gengo_nen: 64 },
      { mei: "平成", gengo_nen: 1 },
    ]);
    assert.deepEqual(gengo_from_seireki(2019, list, 2026).kouho, [
      { mei: "平成", gengo_nen: 31 },
      { mei: "令和", gengo_nen: 1 },
    ]);
  });

  test("改元年でない年は候補が1件だけ", () => {
    assert.deepEqual(gengo_from_seireki(2026, list, 2026).kouho, [
      { mei: "令和", gengo_nen: 8 },
    ]);
  });
});

// ---------------------------------------------------------- ③ 妥当性チェック

describe("③ 妥当性チェック", () => {
  test("その元号の最終年を超える元号年はエラー（平成40年は存在しない）", () => {
    const r = seireki_from_gengo("平成", 40, list, 2026);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /平成は31年まで/);
  });

  test("明治より前の西暦はエラー", () => {
    const r = gengo_from_seireki(1867, list, 2026);
    assert.equal(r.ok, false);
  });

  test("元号年が0以下はエラー", () => {
    assert.equal(seireki_from_gengo("令和", 0, list, 2026).ok, false);
    assert.equal(seireki_from_gengo("令和", -1, list, 2026).ok, false);
  });

  test("今年+10年を大きく超える現行元号の入力は、エラーにせず警告付きで値を返す", () => {
    const r = seireki_from_gengo("令和", 50, list, 2026); // 令和50年 = 2068年
    assert.equal(r.ok, true);
    assert.equal(r.seireki, 2068);
    assert.match(r.keikoku, /先です/);
  });

  test("今年+10年を大きく超える西暦の入力も、エラーにせず警告付きで値を返す", () => {
    const r = gengo_from_seireki(2100, list, 2026);
    assert.equal(r.ok, true);
    assert.match(r.keikoku, /先です/);
  });

  test("今年からわずかに先の西暦・元号年は警告を出さない", () => {
    assert.equal(seireki_from_gengo("令和", 10, list, 2026).keikoku, null); // 令和10年=2028年
    assert.equal(gengo_from_seireki(2028, list, 2026).keikoku, null);
  });
});

// -------------------------------------------------------------- ④ 年齢概算

describe("④ 年齢概算", () => {
  test("生まれ年が今年と同じなら必ず0歳（ぶれない）", () => {
    const r = calc_nenrei_gaisan(2026, 2026);
    assert.equal(r.ok, true);
    assert.equal(r.saitei, 0);
    assert.equal(r.saiko, 0);
  });

  test("生まれ年が10年前なら 9〜10歳", () => {
    const r = calc_nenrei_gaisan(2016, 2026);
    assert.equal(r.saitei, 9);
    assert.equal(r.saiko, 10);
  });

  test("生まれ年が今年より後（未来）はエラー", () => {
    const r = calc_nenrei_gaisan(2027, 2026);
    assert.equal(r.ok, false);
  });
});

// ------------------------------------------------- ⑤ format.js との整合

describe("⑤ format.js との整合", () => {
  test("data/gengo.json の平成・令和の開始西暦年が src/format.js のハードコード値と一致する", () => {
    const heisei = list.find((g) => g["名称"] === "平成")["開始西暦年"];
    const reiwa = list.find((g) => g["名称"] === "令和")["開始西暦年"];

    // src/format.js の format_nen/wareki_nen は 1989（平成）・2019（令和）を直接埋め込んでいる。
    // 次の改元・遡って改元年を直したときに、data/gengo.json だけを直して
    // src/format.js を直し忘れる事故を、この2行が検知する。
    assert.equal(heisei, 1989);
    assert.equal(reiwa, 2019);

    assert.equal(format_nen(reiwa), "2019年（平成31年・令和元年）");
    assert.equal(format_nen(heisei), "1989年（平成元年）");
  });
});
