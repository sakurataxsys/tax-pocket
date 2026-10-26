// 復興特別所得税・防衛特別所得税の率（income_tax_rates.json の版）のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// ★この関数には端数処理が無い（率を取り出すだけ）。①の枠は「合計が2.1%から動かないこと」に置き換える。
//   端数は使う側（退職金・報酬）のテストで見る。
//
// 期待値は条文の率を literal で書く（data から引いた値と突き合わせると、data の誤りを検知できない）。
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fuka_zeiritsu, fuka_meisho, fuka_joritsu_percent } from "../src/calc/fuka_zeiritsu.js";
import { pick_version } from "../src/calc/version_pick.js";

const income_tax_rates = JSON.parse(
  readFileSync(new URL("../data/income_tax_rates.json", import.meta.url), "utf8"),
);
const ban = (nen) => pick_version(income_tax_rates["版"], nen);

describe("① 合計は2.1%のまま（復興財確法13条・防衛財源確保法5条の9）", () => {
  test("令和8年分は復興2.1%・防衛0", () => {
    assert.deepEqual(fuka_zeiritsu(ban(2026)), { fukko: 2.1, boei: 0, gokei: 2.1 });
    assert.equal(fuka_joritsu_percent(fuka_zeiritsu(ban(2026))), 102.1);
  });

  test("令和9年分は復興1.1%＋防衛1%＝2.1%", () => {
    const fz = fuka_zeiritsu(ban(2027));
    assert.equal(fz.fukko, 1.1, "復興財確法13条（令和9年1月1日施行版）百分の一・一");
    assert.equal(fz.boei, 1, "防衛財源確保法5条の9 百分の一");
    assert.equal(fuka_joritsu_percent(fz), 102.1);
  });
});

describe("② 境界値（令和8年分と令和9年分の切れ目）", () => {
  test("2026年は版1、2027年は版2", () => {
    assert.equal(ban(2026)["適用終了年"], 2026);
    assert.equal(ban(2027)["適用開始年"], 2027);
    assert.equal(fuka_zeiritsu(ban(2026)).boei, 0);
    assert.equal(fuka_zeiritsu(ban(2027)).boei, 1);
  });

  test("平成27年分（収録の最初）も引ける", () => {
    assert.equal(fuka_zeiritsu(ban(2015)).fukko, 2.1);
  });
});

describe("③ 改正前後の分岐：税目の呼び名", () => {
  test("防衛のある年分は3つを並べる（5条の27の並び）", () => {
    assert.equal(fuka_meisho(fuka_zeiritsu(ban(2026))), "所得税及び復興特別所得税");
    assert.equal(
      fuka_meisho(fuka_zeiritsu(ban(2027))),
      "所得税、防衛特別所得税及び復興特別所得税",
    );
  });
});

describe("④ 数値表が壊れているときの守り（黙って0にしない）", () => {
  const v = (fukko, boei) => ({ 付加税率パーセント: { 復興特別所得税: fukko, 防衛特別所得税: boei } });

  test("文字列の数は数として通す（判断ログ D-41）", () => {
    assert.deepEqual(fuka_zeiritsu(v("1.1", "1")), { fukko: 1.1, boei: 1, gokei: 2.1 });
  });

  test("数にならない値・欠けたキー・null・空文字は null", () => {
    for (const [f, b] of [
      ["abc", 1],
      [1.1, "abc"],
      [undefined, 1],
      [1.1, undefined],
      [null, 1],
      [1.1, null],
      ["", 1],
      [1.1, ""],
      [-1, 1],
    ]) {
      assert.equal(fuka_zeiritsu(v(f, b)), null, `${f} / ${b}`);
    }
    assert.equal(fuka_zeiritsu({ 付加税率パーセント: null }), null);
    assert.equal(fuka_zeiritsu({ 付加税率パーセント: "2.1" }), null);
    assert.equal(fuka_zeiritsu({}), null, "どちらのキーも無い");
    assert.equal(fuka_zeiritsu(null), null);
  });

  test("旧キーだけの版（古い data を読んだ新しい画面）は防衛0として読む", () => {
    assert.deepEqual(fuka_zeiritsu({ 復興特別所得税率パーセント: 2.1 }), {
      fukko: 2.1,
      boei: 0,
      gokei: 2.1,
    });
    assert.deepEqual(fuka_zeiritsu({ 復興特別所得税率パーセント: "2.1" }).gokei, 2.1);
  });
});

describe("⑤ data の形（v24 以前の画面との両立）", () => {
  test("旧キーは入れ子の復興と同じ値（二重持ちの食い違いを検知する）", () => {
    for (const b of income_tax_rates["版"]) {
      if (Object.hasOwn(b, "復興特別所得税率パーセント")) {
        assert.equal(b["復興特別所得税率パーセント"], b["付加税率パーセント"]["復興特別所得税"]);
      }
    }
  });

  test("令和9年分以後の版に旧キーを置かない（置くと v24 以前の画面が防衛の1%を落として計算する）", () => {
    for (const b of income_tax_rates["版"]) {
      if (b["適用開始年"] >= 2027) {
        assert.equal(Object.hasOwn(b, "復興特別所得税率パーセント"), false);
      }
    }
  });

  test("すべての版で率が取り出せる", () => {
    for (const b of income_tax_rates["版"]) {
      assert.notEqual(fuka_zeiritsu(b), null, b["適用年分表示"]);
    }
  });

  test("年またぎの注意は令和9年の版にあり、令和8年の版には無い", () => {
    assert.equal(typeof ban(2027)["年またぎの注意"], "string");
    assert.equal(ban(2026)["年またぎの注意"], undefined);
  });
});
