// 退職所得の計算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_kinzoku_nensu,
  calc_taishoku_shotoku_kojo,
  judge_kubun,
  calc_taishokukin,
} from "../src/calc/taishokukin.js";
import { pick_version } from "../src/calc/version_pick.js";

const tables = {
  taishokukin: JSON.parse(
    readFileSync(new URL("../data/taishokukin.json", import.meta.url), "utf8"),
  ),
  income_tax: JSON.parse(
    readFileSync(
      new URL("../data/income_tax_rates.json", import.meta.url),
      "utf8",
    ),
  ),
};

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    shunyu: 10000000,
    kinzoku_years: 10,
    kinzoku_months: 0,
    yakuin_kinzoku_nensu: 0,
    is_shogai: false,
    is_teishutsu: true,
    nen: 2026,
    ...over,
  };
}

// ---------------------------------------------------------------- ① 端数処理

describe("① 端数処理", () => {
  test("勤続年数は1年未満の端数を1年に切り上げる（所令69条2項）", () => {
    assert.equal(calc_kinzoku_nensu(10, 0), 10);
    assert.equal(calc_kinzoku_nensu(10, 1), 11);
    assert.equal(calc_kinzoku_nensu(10, 11), 11);
  });

  test("課税退職所得金額は1,000円未満を切り捨てる（所法201条1項イ）", () => {
    // 勤続10年 → 控除400万。収入5,001,500円 → 残額1,001,500円 → 2分の1で500,750円
    const r = calc_taishokukin(
      input({ shunyu: 5001500, kinzoku_years: 10 }),
      tables,
    );
    assert.equal(r.kojo, 4000000);
    assert.equal(r.zangaku, 1001500);
    assert.equal(r.kazei_gaku, 500000);
  });

  test("所得税及び復興特別所得税は1円未満を切り捨てる", () => {
    // 勤続25年 → 控除1,150万。収入2,000万 → 残額850万 → 課税退職所得金額425万
    // （425万×20% − 427,500）＝422,500円 → ×102.1% ＝431,372.5円 → 431,372円
    const r = calc_taishokukin(
      input({ shunyu: 20000000, kinzoku_years: 25 }),
      tables,
    );
    assert.equal(r.kojo, 11500000);
    assert.equal(r.kazei_gaku, 4250000);
    assert.equal(r.shotokuzei, 431372);
  });

  test("住民税は市町村民税・道府県民税をそれぞれ100円未満切り捨てる（総務省）", () => {
    // 勤続10年 → 控除400万。収入5,002,000円 → 残額1,002,000円 → 課税退職所得金額501,000円
    // 市町村民税 501,000×6% ＝30,060円 → 30,000円 ／ 道府県民税 501,000×4% ＝20,040円 → 20,000円
    const r = calc_taishokukin(
      input({ shunyu: 5002000, kinzoku_years: 10 }),
      tables,
    );
    assert.equal(r.kazei_gaku, 501000);
    assert.equal(r.juminzei.shichoson, 30000);
    assert.equal(r.juminzei.dofuken, 20000);
    assert.equal(r.juminzei.gokei, 50000);
    // 所得税 501,000×5% ＝25,050円 → ×102.1% ＝25,576.05円 → 25,576円
    assert.equal(r.shotokuzei, 25576);
  });
});

// ------------------------------------------------------------------ ② 境界値

describe("② 境界値", () => {
  const kojo_table = tables.taishokukin["版"][0]["退職所得控除"];

  test("退職所得控除額は勤続20年で区分が変わる（所法30条3項）", () => {
    assert.equal(calc_taishoku_shotoku_kojo(20, false, kojo_table), 8000000);
    assert.equal(calc_taishoku_shotoku_kojo(21, false, kojo_table), 8700000);
  });

  test("退職所得控除額の最低額は80万円（所法30条6項2号）", () => {
    assert.equal(calc_taishoku_shotoku_kojo(1, false, kojo_table), 800000);
    assert.equal(calc_taishoku_shotoku_kojo(2, false, kojo_table), 800000);
    assert.equal(calc_taishoku_shotoku_kojo(3, false, kojo_table), 1200000);
  });

  test("障害退職は80万円の下限を適用したうえで100万円を加算する（所法30条6項3号）", () => {
    assert.equal(calc_taishoku_shotoku_kojo(1, true, kojo_table), 1800000);
    assert.equal(calc_taishoku_shotoku_kojo(10, true, kojo_table), 5000000);
  });

  test("役員等勤続年数5年以下は特定役員退職手当等、5年超は一般（所法30条5項）", () => {
    const tanki = tables.taishokukin["版"][0]["短期退職手当等"];
    assert.equal(judge_kubun(5, 5, tanki).kubun, "特定役員退職手当等");
    assert.equal(judge_kubun(6, 6, tanki).kubun, "一般退職手当等");
  });

  test("特定役員退職手当等は2分の1を適用しない", () => {
    // 勤続5年・役員等勤続年数5年、収入1,000万 → 控除200万 → 残額800万がそのまま課税退職所得金額
    const r = calc_taishokukin(
      input({ shunyu: 10000000, kinzoku_years: 5, yakuin_kinzoku_nensu: 5 }),
      tables,
    );
    assert.equal(r.kubun, "特定役員退職手当等");
    assert.equal(r.hanbun_tekiyo, false);
    assert.equal(r.kazei_gaku, 8000000);
    // （800万×23% − 636,000）＝1,204,000円 → ×102.1% ＝1,229,284円
    assert.equal(r.shotokuzei, 1229284);
  });

  test("短期退職手当等は残額300万円で計算式が変わる（所法30条2項各号）", () => {
    // 勤続5年 → 控除200万
    // 残額ちょうど300万（収入500万）→ 300万×1/2 ＝150万
    const chodo = calc_taishokukin(
      input({ shunyu: 5000000, kinzoku_years: 5 }),
      tables,
    );
    assert.equal(chodo.kubun, "短期退職手当等");
    assert.equal(chodo.kazei_gaku, 1500000);

    // 残額400万（収入600万）→ 150万 ＋（400万 − 300万）＝250万
    const koe = calc_taishokukin(
      input({ shunyu: 6000000, kinzoku_years: 5 }),
      tables,
    );
    assert.equal(koe.kazei_gaku, 2500000);
  });

  test("収入が退職所得控除額以下なら税額はゼロ", () => {
    const r = calc_taishokukin(
      input({ shunyu: 1000000, kinzoku_years: 10 }),
      tables,
    );
    assert.equal(r.zangaku, 0);
    assert.equal(r.kazei_gaku, 0);
    assert.equal(r.shotokuzei, 0);
    assert.equal(r.juminzei.gokei, 0);
    assert.equal(r.tegaki, 1000000);
  });

  test("受給に関する申告書が未提出なら収入金額の20.42%（所法201条3項）", () => {
    const r = calc_taishokukin(
      input({ shunyu: 10000000, kinzoku_years: 10, is_teishutsu: false }),
      tables,
    );
    // 1,000万 ×20% ＝200万 → ×102.1% ＝2,042,000円
    assert.equal(r.shotokuzei, 2042000);
    // 住民税は申告書の提出の有無にかかわらず通常どおり特別徴収される
    assert.equal(r.kazei_gaku, 3000000);
    assert.equal(r.juminzei.shichoson, 180000);
    assert.equal(r.juminzei.dofuken, 120000);
  });

  test("役員等の期間とそれ以外の期間が混在する場合は計算せず理由を返す", () => {
    const r = calc_taishokukin(
      input({ kinzoku_years: 30, yakuin_kinzoku_nensu: 3 }),
      tables,
    );
    assert.equal(r.ok, false);
    assert.match(r.riyu, /按分/);
  });

  test("役員等勤続年数が勤続年数を超える入力は受け付けない", () => {
    const r = calc_taishokukin(
      input({ kinzoku_years: 3, yakuin_kinzoku_nensu: 5 }),
      tables,
    );
    assert.equal(r.ok, false);
  });
});

// -------------------------------------------------------- ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  test("短期退職手当等の規定は令和4年分から適用される", () => {
    assert.equal(
      pick_version(tables.taishokukin["版"], 2021)["短期退職手当等"]["適用する"],
      false,
    );
    assert.equal(
      pick_version(tables.taishokukin["版"], 2022)["短期退職手当等"]["適用する"],
      true,
    );
  });

  test("同じ入力でも令和3年分と令和4年分で課税退職所得金額が変わる", () => {
    // 勤続5年・役員でない・収入600万 → 控除200万 → 残額400万
    const base = { shunyu: 6000000, kinzoku_years: 5 };

    // 令和3年分：短期退職手当等の規定がないため一般退職手当等 → 400万 ×1/2 ＝200万
    const r2021 = calc_taishokukin(input({ ...base, nen: 2021 }), tables);
    assert.equal(r2021.kubun, "一般退職手当等");
    assert.equal(r2021.kazei_gaku, 2000000);

    // 令和4年分：短期退職手当等 → 150万 ＋（400万 − 300万）＝250万
    const r2022 = calc_taishokukin(input({ ...base, nen: 2022 }), tables);
    assert.equal(r2022.kubun, "短期退職手当等");
    assert.equal(r2022.kazei_gaku, 2500000);

    assert.ok(r2022.shotokuzei > r2021.shotokuzei);
  });

  test("収録していない年分はデータがない旨を返す", () => {
    const r = calc_taishokukin(input({ nen: 2010 }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /収録/);
  });
});
