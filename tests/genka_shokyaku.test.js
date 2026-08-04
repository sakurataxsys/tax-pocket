// 減価償却費の計算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
// ＋④ 償却率表（自動生成）の取り込みミス検知
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_chuko_taiyo_nensu,
  calc_kyoyo_tsukisu,
  calc_genka_shokyaku,
  judge_shogaku,
  pick_ritsu_table,
  pick_shogaku_version,
} from "../src/calc/genka_shokyaku.js";

const tables = {
  shokyakuritsu: JSON.parse(
    readFileSync(new URL("../data/shokyakuritsu.json", import.meta.url), "utf8"),
  ),
  genka_shokyaku: JSON.parse(
    readFileSync(new URL("../data/genka_shokyaku.json", import.meta.url), "utf8"),
  ),
};

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    shutoku_kagaku: 1000000,
    shutoku_year: 2026,
    shutoku_month: 4,
    kessan_month: 3,
    taiyo_nensu: 5,
    hoho: "定額法",
    is_chuko: false,
    keika_years: 0,
    keika_months: 0,
    ...over,
  };
}

/** 償却限度額の合計 */
function total(r) {
  return r.schedule.reduce((a, row) => a + row["償却限度額"], 0);
}

// ---------------------------------------------------------------- ① 端数処理

describe("① 端数処理", () => {
  test("中古資産の簡便法は1年未満を切り捨てる（耐用年数省令3条5項）", () => {
    const setting = tables.genka_shokyaku["中古資産の簡便法"];
    // 法定6年・経過2年10か月 →（6 − 2.833…）＋ 2.833…×20% ＝ 3.733… → 3年
    assert.equal(calc_chuko_taiyo_nensu(6, 34, setting), 3);
    // 法定6年・経過1年 →（6 − 1）＋ 0.2 ＝ 5.2 → 5年
    assert.equal(calc_chuko_taiyo_nensu(6, 12, setting), 5);
  });

  test("供用月数は暦に従って数える（法令59条2項）", () => {
    // 決算3月：4月供用＝12か月／8月供用＝8か月／3月供用＝1か月
    assert.equal(calc_kyoyo_tsukisu(4, 3), 12);
    assert.equal(calc_kyoyo_tsukisu(8, 3), 8);
    assert.equal(calc_kyoyo_tsukisu(3, 3), 1);
    // 決算12月（個人・暦年）：1月供用＝12か月／10月供用＝3か月
    assert.equal(calc_kyoyo_tsukisu(1, 12), 12);
    assert.equal(calc_kyoyo_tsukisu(10, 12), 3);
  });

  test("償却費は円未満を切り捨てる", () => {
    // 取得価額999,999円・耐用年数7年（定額法償却率0.143）→ 999,999×0.143＝142,999.857 → 142,999円
    const r = calc_genka_shokyaku(
      input({ shutoku_kagaku: 999999, taiyo_nensu: 7 }),
      tables,
    );
    assert.equal(r.ok, true);
    assert.equal(r.shokyakuritsu, 0.143);
    assert.equal(r.schedule[0]["償却限度額"], 142999);
  });

  test("初年度の月割も円未満を切り捨てる", () => {
    // 年額142,999円 × 8か月 ÷ 12 ＝ 95,332.66… → 95,332円
    const r = calc_genka_shokyaku(
      input({ shutoku_kagaku: 999999, taiyo_nensu: 7, shutoku_month: 8 }),
      tables,
    );
    assert.equal(r.kyoyo_tsukisu, 8);
    assert.equal(r.schedule[0]["償却限度額"], 95332);
  });
});

// ------------------------------------------------------------------ ② 境界値

describe("② 境界値", () => {
  test("定率法は調整前償却額が償却保証額に満たない年度から改定償却率に切り替わる", () => {
    // 取得価額100万・耐用年数5年・200%（償却率0.400／改定0.500／保証率0.10800）
    // 償却保証額＝108,000円
    // 1年目400,000（残600,000）／2年目240,000（残360,000）／3年目144,000（残216,000）
    // 4年目：調整前86,400 < 108,000 → 216,000×0.500＝108,000
    const r = calc_genka_shokyaku(input({ hoho: "定率法" }), tables);
    assert.equal(r.ritsu_key, "定率法200");
    assert.equal(r.hosho_gaku, 108000);
    assert.deepEqual(
      r.schedule.map((x) => x["償却限度額"]),
      [400000, 240000, 144000, 108000, 107999],
    );
    assert.equal(r.schedule[3]["摘要"], "改定償却率による");
  });

  test("最後は備忘価額1円が残る（法令61条1項2号イ）", () => {
    for (const hoho of ["定額法", "定率法"]) {
      const r = calc_genka_shokyaku(input({ hoho }), tables);
      assert.equal(r.schedule.at(-1)["期末簿価"], 1, hoho);
      assert.equal(total(r), 1000000 - 1, hoho);
    }
  });

  test("定額法は耐用年数どおりの年数で終わる（期首供用のとき）", () => {
    const r = calc_genka_shokyaku(input({ taiyo_nensu: 5 }), tables);
    assert.equal(r.schedule.length, 5);
    assert.deepEqual(
      r.schedule.map((x) => x["償却限度額"]),
      [200000, 200000, 200000, 200000, 199999],
    );
  });

  test("期中供用なら定額法は1年多くかかる", () => {
    // 決算3月・8月供用 → 初年度8か月分
    const r = calc_genka_shokyaku(input({ shutoku_month: 8 }), tables);
    assert.equal(r.schedule.length, 6);
    assert.equal(r.schedule[0]["償却限度額"], 133333); // 200,000×8÷12＝133,333.3…
    assert.equal(total(r), 1000000 - 1);
  });

  test("耐用年数2年の定率法は改定償却率と保証率が表にない（null）", () => {
    const r = calc_genka_shokyaku(
      input({ hoho: "定率法", taiyo_nensu: 2, shutoku_month: 10 }),
      tables,
    );
    assert.equal(r.ok, true);
    assert.equal(r.shokyakuritsu, 1);
    assert.equal(r.kaitei_shokyakuritsu, null);
    assert.equal(r.hosho_gaku, null);
    // 償却率1.000・6か月分 → 500,000円、翌年度に残り
    assert.equal(r.kyoyo_tsukisu, 6);
    assert.equal(r.schedule[0]["償却限度額"], 500000);
    assert.equal(total(r), 1000000 - 1);
  });

  test("中古資産の簡便法の下限は2年（耐用年数省令3条1項2号）", () => {
    const setting = tables.genka_shokyaku["中古資産の簡便法"];
    // 法定4年を全部経過 → 4×20%＝0.8年 → 2年
    assert.equal(calc_chuko_taiyo_nensu(4, 48, setting), 2);
    // 法定10年を全部経過 → 10×20%＝2年
    assert.equal(calc_chuko_taiyo_nensu(10, 120, setting), 2);
    // 法定20年を全部経過 → 20×20%＝4年
    assert.equal(calc_chuko_taiyo_nensu(20, 240, setting), 4);
  });

  test("中古資産は簡便法の耐用年数で計算される", () => {
    // 法定6年・経過2年10か月 → 3年（定率法200%の償却率0.667）
    const r = calc_genka_shokyaku(
      input({
        hoho: "定率法",
        taiyo_nensu: 6,
        is_chuko: true,
        keika_years: 2,
        keika_months: 10,
      }),
      tables,
    );
    assert.equal(r.taiyo_nensu, 3);
    assert.equal(r.shokyakuritsu, 0.667);
    assert.match(r.chuko_note, /簡便法で3年/);
  });

  test("少額の判定は「未満」（ちょうどは該当しない）", () => {
    const v = pick_shogaku_version(
      tables.genka_shokyaku["少額減価償却資産"]["版"],
      2026,
      4,
    );
    assert.equal(judge_shogaku(100000, v).length, 2); // 一括償却・中小特例
    assert.equal(judge_shogaku(99999, v).length, 3); // ＋全額損金
    assert.equal(judge_shogaku(200000, v).length, 1); // 中小特例のみ
    assert.equal(judge_shogaku(400000, v).length, 0);
    assert.equal(judge_shogaku(399999, v).length, 1);
  });

  test("耐用年数が償却率表の範囲外なら計算せず理由を返す", () => {
    const r = calc_genka_shokyaku(input({ taiyo_nensu: 101 }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /償却率表/);
  });
});

// -------------------------------------------------------- ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  test("定率法は平成24年4月1日の取得から200%になる（法令48条の2第1項1号イ(2)）", () => {
    const base = { hoho: "定率法", taiyo_nensu: 5 };
    // 平成24年3月取得 → 250%（償却率0.500）
    const r250 = calc_genka_shokyaku(
      input({ ...base, shutoku_year: 2012, shutoku_month: 3, kessan_month: 2 }),
      tables,
    );
    assert.equal(r250.ritsu_key, "定率法250");
    assert.equal(r250.shokyakuritsu, 0.5);

    // 平成24年4月取得 → 200%（償却率0.400）
    const r200 = calc_genka_shokyaku(
      input({ ...base, shutoku_year: 2012, shutoku_month: 4, kessan_month: 3 }),
      tables,
    );
    assert.equal(r200.ritsu_key, "定率法200");
    assert.equal(r200.shokyakuritsu, 0.4);
    assert.ok(r250.schedule[0]["償却限度額"] > r200.schedule[0]["償却限度額"]);
  });

  test("平成19年3月31日以前の取得は計算せず理由を返す", () => {
    const r = calc_genka_shokyaku(
      input({ shutoku_year: 2007, shutoku_month: 3 }),
      tables,
    );
    assert.equal(r.ok, false);
    assert.match(r.riyu, /平成19年3月31日以前/);

    // 平成19年4月取得は計算できる
    const ok = calc_genka_shokyaku(
      input({ shutoku_year: 2007, shutoku_month: 4 }),
      tables,
    );
    assert.equal(ok.ok, true);
  });

  test("中小企業者等の特例のしきい値は令和8年4月1日の取得から40万円になる", () => {
    // 令和8年法律第12号 附則1条（施行日＝令和8年4月1日）・附則65条（施行日以後の取得から適用）
    const versions = tables.genka_shokyaku["少額減価償却資産"]["版"];
    const kyu = pick_shogaku_version(versions, 2026, 3);
    const shin = pick_shogaku_version(versions, 2026, 4);
    assert.equal(kyu["中小企業者等の特例"]["取得価額の上限"], 300000);
    assert.equal(shin["中小企業者等の特例"]["取得価額の上限"], 400000);

    // 350,000円は取得時期で結論が変わる
    assert.equal(judge_shogaku(350000, kyu).length, 0);
    assert.equal(judge_shogaku(350000, shin).length, 1);
  });
});

// -------------------------------- ④ 償却率表（自動生成）の取り込みミス検知

describe("④ 償却率表の整合", () => {
  const 表 = tables.shokyakuritsu["表"];

  test("3表とも耐用年数2年から100年まで欠けなく入っている", () => {
    for (const [key, t] of Object.entries(表)) {
      const years = Object.keys(t["行"]).map(Number).sort((a, b) => a - b);
      assert.equal(years.length, 99, key);
      assert.equal(years[0], 2, key);
      assert.equal(years.at(-1), 100, key);
      for (let y = 2; y <= 100; y++) {
        assert.ok(t["行"][String(y)], `${key} の耐用年数${y}年がない`);
      }
    }
  });

  test("償却率は耐用年数が長いほど小さい（単調非増加）", () => {
    for (const [key, t] of Object.entries(表)) {
      for (let y = 3; y <= 100; y++) {
        assert.ok(
          t["行"][String(y)]["償却率"] <= t["行"][String(y - 1)]["償却率"],
          `${key} の耐用年数${y}年で償却率が増えている`,
        );
      }
    }
  });

  test("定率法は 保証率 < 償却率 ≦ 改定償却率（耐用年数2年を除く）", () => {
    for (const key of ["定率法250", "定率法200"]) {
      for (let y = 3; y <= 100; y++) {
        const r = 表[key]["行"][String(y)];
        assert.ok(r["保証率"] < r["償却率"], `${key} ${y}年：保証率が償却率以上`);
        assert.ok(
          r["改定償却率"] >= r["償却率"],
          `${key} ${y}年：改定償却率が償却率未満`,
        );
      }
      // 耐用年数2年だけは改定償却率・保証率がない
      assert.equal(表[key]["行"]["2"]["改定償却率"], null);
      assert.equal(表[key]["行"]["2"]["保証率"], null);
    }
  });

  test("償却率は「倍率÷耐用年数」と±0.001の範囲で一致する（列ずれの検知）", () => {
    // 別表の丸め方は表ごとに違うため厳密一致では照合しない（例：200%・6年は2÷6＝0.333…で0.333）。
    // ここで見たいのは、列や行がずれて別の数字が入っていないこと。
    const 倍率 = { 定額法: 1, 定率法250: 2.5, 定率法200: 2 };
    for (const [key, t] of Object.entries(表)) {
      for (let y = 3; y <= 100; y++) {
        const expect = 倍率[key] / y;
        const actual = t["行"][String(y)]["償却率"];
        assert.ok(
          Math.abs(actual - expect) <= 0.001,
          `${key} ${y}年：償却率${actual}（式では${expect.toFixed(5)}）`,
        );
      }
    }
  });

  test("出典が入っている", () => {
    const s = tables.shokyakuritsu["出典"];
    assert.match(s["url"], /^https:\/\/laws\.e-gov\.go\.jp\//);
    assert.ok(s["法令番号"].length > 0);
    assert.ok(s["最終改正"].length > 0);
  });

  test("取得年月で表が切り替わる", () => {
    assert.equal(pick_ritsu_table(tables.shokyakuritsu, "定率法", 2007, 3), null);
    assert.equal(
      pick_ritsu_table(tables.shokyakuritsu, "定率法", 2007, 4).key,
      "定率法250",
    );
    assert.equal(
      pick_ritsu_table(tables.shokyakuritsu, "定率法", 2012, 3).key,
      "定率法250",
    );
    assert.equal(
      pick_ritsu_table(tables.shokyakuritsu, "定率法", 2012, 4).key,
      "定率法200",
    );
  });
});
