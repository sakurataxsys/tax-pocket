// 延滞税・利子税の計算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_entaizei,
  ni_tsuki_keika_bi,
  count_days,
  add_days,
  split_by_year,
  pick_wariai,
  needs_kikan_tokurei_chui,
} from "../src/calc/entaizei.js";

const tables = {
  entaizei: JSON.parse(
    readFileSync(new URL("../data/entaizei.json", import.meta.url), "utf8"),
  ),
};

function input(over = {}) {
  return {
    shurui: "延滞税",
    honzei: 1000000,
    hotei_nokigen: "2026-03-31",
    nokigen: "2026-03-31",
    kanno_bi: "2026-05-31",
    is_kigengo: false,
    ...over,
  };
}

function calc(over) {
  const r = calc_entaizei(input(over), tables);
  assert.equal(r.ok, true, r.riyu ?? "計算できませんでした");
  return r;
}

// ---------------------------------------------------------------- ① 端数処理

describe("① 端数処理", () => {
  test("計算の基礎となる税額は1万円未満を切り捨てる（通則法118条3項）", () => {
    assert.equal(calc({ honzei: 19999 }).kiso_zeigaku, 10000);
    assert.equal(calc({ honzei: 20000 }).kiso_zeigaku, 20000);
  });

  test("本税が1万円未満なら延滞税は生じない（同項）", () => {
    const r = calc({ honzei: 9999 });
    assert.equal(r.kiso_zeigaku, 0);
    assert.equal(r.zeigaku, 0);
    assert.match(r.riyu_zero, /118条3項/);
  });

  test("確定額は100円未満を切り捨てる（通則法119条4項）", () => {
    const r = calc({ honzei: 1000000, kanno_bi: "2026-12-31" });
    assert.equal(r.zeigaku % 100, 0);
    assert.ok(r.kiritsute_mae >= r.zeigaku);
  });

  test("計算した額の全額が1,000円未満なら全額を切り捨てる（同項）", () => {
    // 10万円を数日だけ遅延 → 数十円にしかならない
    const r = calc({ honzei: 100000, kanno_bi: "2026-04-05" });
    assert.ok(r.kiritsute_mae < 1000, `切捨て前 ${r.kiritsute_mae}円`);
    assert.equal(r.zeigaku, 0);
    assert.match(r.riyu_zero, /1,000円未満/);
  });

  test("期間の断片ごとに1円未満を切り捨てる（措置法96条2項）", () => {
    // 暦年をまたぐと断片が2つになる。合算してから切り捨てた場合と区別できるように、
    // 各断片の金額がすべて整数であることを確かめる
    const r = calc({ hotei_nokigen: "2025-11-30", kanno_bi: "2026-06-30" });
    for (const k of r.kikan) {
      for (const row of k.rows) {
        assert.ok(Number.isInteger(row.金額), `断片が整数でない: ${row.金額}`);
      }
    }
  });

  test("1年は365日で按分する（うるう年でも変えない）", () => {
    // 令和8年（2026年・平年）と令和6年（2024年・うるう年）で、同じ日数なら同じ額になる
    assert.equal(tables.entaizei["端数処理"]["1年の日数"], 365);
    const a = calc({ hotei_nokigen: "2026-03-31", kanno_bi: "2026-04-30", honzei: 5000000 });
    const b = calc({ hotei_nokigen: "2024-03-31", kanno_bi: "2024-04-30", honzei: 5000000 });
    assert.equal(count_days("2026-04-01", "2026-04-30"), 30);
    assert.equal(count_days("2024-04-01", "2024-04-30"), 30);
    // 割合が違うので額は違うが、日数の数え方は同じ
    assert.equal(a.kikan[0].rows[0].日数, b.kikan[0].rows[0].日数);
  });
});

// ---------------------------------------------------------------- ② 境界値

describe("② 境界値", () => {
  test("「2月を経過する日」は応当日の前日（通則法10条1項3号）", () => {
    // 納期限3月15日 → 起算日3月16日 → 応当日5月16日 → 前日の5月15日
    assert.equal(ni_tsuki_keika_bi("2026-03-15"), "2026-05-15");
    assert.equal(ni_tsuki_keika_bi("2026-03-31"), "2026-05-31");
  });

  test("応当する日がない月は末日に満了する（同号ただし書）", () => {
    // 納期限12月30日 → 起算日12月31日 → 翌年2月に31日はない → 2月末日
    assert.equal(ni_tsuki_keika_bi("2025-12-30"), "2026-02-28");
    // うるう年（2024年2月は29日まで）
    assert.equal(ni_tsuki_keika_bi("2023-12-30"), "2024-02-29");
    // 納期限12月29日 → 起算日12月30日 → 2月30日はない → 2月末日
    assert.equal(ni_tsuki_keika_bi("2025-12-29"), "2026-02-28");
  });

  test("2月を経過する日ちょうどまでは低い割合、その翌日から高い割合", () => {
    const keika = ni_tsuki_keika_bi("2026-03-31"); // 2026-05-31
    const chodo = calc({ kanno_bi: keika });
    assert.equal(chodo.kikan.length, 1, "低い割合の期間だけになる");
    assert.equal(chodo.kikan[0].rows[0].割合, 2.8);

    const yokujitsu = calc({ kanno_bi: add_days(keika, 1) });
    assert.equal(yokujitsu.kikan.length, 2, "高い割合の期間が生まれる");
    assert.equal(yokujitsu.kikan[1].rows[0].割合, 9.1);
    assert.equal(yokujitsu.kikan[1].rows[0].日数, 1);
  });

  test("完納日が法定納期限と同じかそれ以前なら0円", () => {
    assert.equal(calc({ kanno_bi: "2026-03-31" }).zeigaku, 0);
    assert.equal(calc({ kanno_bi: "2026-03-30" }).zeigaku, 0);
    assert.equal(calc({ kanno_bi: "2026-04-01" }).kikan.length, 1);
  });

  test("日数は両端を含めて数える", () => {
    assert.equal(count_days("2026-04-01", "2026-04-01"), 1);
    assert.equal(count_days("2026-04-01", "2026-04-02"), 2);
    assert.equal(count_days("2026-04-02", "2026-04-01"), 0);
  });

  test("期限後申告・修正申告では納期限が提出日になり、2月の起点がずれる", () => {
    const kigennai = calc({ hotei_nokigen: "2026-03-31", kanno_bi: "2026-08-31" });
    const kigengo = calc({
      hotei_nokigen: "2026-03-31",
      nokigen: "2026-06-30",
      is_kigengo: true,
      kanno_bi: "2026-08-31",
    });
    // 提出日が遅いほど低い割合の期間が長くなるので、延滞税は小さくなる
    assert.equal(kigennai.ni_tsuki_keika_bi, "2026-05-31");
    assert.equal(kigengo.ni_tsuki_keika_bi, "2026-08-31");
    assert.ok(kigengo.zeigaku < kigennai.zeigaku);
    assert.equal(kigengo.kikan.length, 1);
  });

  test("納期限が法定納期限より前の入力は受け付けない", () => {
    const r = calc_entaizei(
      input({ is_kigengo: true, nokigen: "2026-03-01" }),
      tables,
    );
    assert.equal(r.ok, false);
    assert.match(r.riyu, /納期限/);
  });

  test("通則法61条の期間の特例が働きうる入力を検知する", () => {
    assert.equal(
      needs_kikan_tokurei_chui(
        input({ is_kigengo: true, nokigen: "2027-04-30", kanno_bi: "2027-04-30" }),
      ),
      true,
    );
    assert.equal(
      needs_kikan_tokurei_chui(input({ is_kigengo: true, nokigen: "2026-06-30" })),
      false,
    );
    assert.equal(needs_kikan_tokurei_chui(input()), false);
  });
});

// ------------------------------------------------------------ ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  test("暦年をまたぐと年ごとの割合が切り替わる（令和7年2.4% → 令和8年2.8%）", () => {
    const r = calc({ hotei_nokigen: "2025-11-30", kanno_bi: "2026-01-31" });
    const rows = r.kikan[0].rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].年, 2025);
    assert.equal(rows[0].割合, 2.4);
    assert.equal(rows[1].年, 2026);
    assert.equal(rows[1].割合, 2.8);
    assert.equal(rows[0].日数, 31, "12月1日から12月31日まで");
    assert.equal(rows[1].日数, 31, "1月1日から1月31日まで");
  });

  test("収録開始日より前を法定納期限とする計算は止める", () => {
    const r = calc_entaizei(input({ hotei_nokigen: "2013-12-31" }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /平成26年1月1日/);
  });

  test("★利子税は令和2年分以前と令和3年分以後で式が違う", () => {
    // 令和2年度改正で「特例基準割合（告示割合＋1%）」→「利子税特例基準割合（平均貸付割合＋0.5%）」。
    // 1つの式を全年に当てると令和2年分以前を0.5ポイント低く誤算する。
    // ここは data の値そのものを固定して、式で導き直されていないことを確かめる。
    const r2 = pick_wariai(tables.entaizei["割合"], 2020); // 令和2年
    const r3 = pick_wariai(tables.entaizei["割合"], 2021); // 令和3年
    // 令和2年：延滞税2月以内 2.6% ＝ 特例基準割合1.6% ＋ 1% ／ 利子税 ＝ 特例基準割合 1.6%
    assert.equal(r2["利子税"], 1.6);
    assert.equal(Math.round((r2["延滞税_納期限の翌日から2月以内"] - 1.0) * 10) / 10, r2["利子税"]);
    // 令和3年：延滞税2月以内 2.5% ＝ 平均貸付割合0.5% ＋ 1% ＋ 1% ／ 利子税 ＝ 0.5% ＋ 0.5% ＝ 1.0%
    assert.equal(r3["利子税"], 1.0);
    assert.equal(Math.round((r3["延滞税_納期限の翌日から2月以内"] - 1.5) * 10) / 10, r3["利子税"]);
  });

  test("利子税は提出期限の翌日から納付の日までを1本で計算する", () => {
    const r = calc({ shurui: "利子税", hotei_nokigen: "2026-05-31", kanno_bi: "2026-07-31" });
    assert.equal(r.kikan.length, 1);
    assert.equal(r.kikan[0].rows[0].割合, 1.3); // 令和8年
    assert.equal(r.kikan[0].rows[0].日数, count_days("2026-06-01", "2026-07-31"));
    assert.equal(r.ni_tsuki_keika_bi, null, "利子税に2月の区切りはない");
  });
});

// ------------------------------------------------------ ④ 割合表の取り違え検知

describe("④ 割合表の検算", () => {
  const list = tables.entaizei["割合"];

  test("平成26年から令和8年まで、抜けなく収録している", () => {
    const years = list.map((w) => w["適用年"]).sort((a, b) => a - b);
    assert.equal(years[0], 2014);
    assert.equal(years[years.length - 1], 2026);
    for (let y = 2014; y <= 2026; y++) {
      assert.ok(years.includes(y), `${y}年が抜けている`);
    }
    assert.equal(new Set(years).size, years.length, "同じ年が重複している");
  });

  test("延滞税の2つの割合の差は常に6.3ポイント（措置法94条1項）", () => {
    // 2月経過後＝特例基準割合＋7.3% ／ 2月以内＝特例基準割合＋1%
    for (const w of list) {
      const sa =
        Math.round(
          (w["延滞税_2月を経過した日以後"] - w["延滞税_納期限の翌日から2月以内"]) * 10,
        ) / 10;
      assert.equal(sa, 6.3, `${w["適用年表示"]}の差が6.3ポイントでない`);
    }
  });

  test("国税庁が公表している延滞税の割合と一致する", () => {
    // ★年次更新の書き写しミスを捕まえる砦。出典＝国税庁「延滞税の割合」
    const kohyo = {
      2014: [2.9, 9.2], 2015: [2.8, 9.1], 2016: [2.8, 9.1], 2017: [2.7, 9.0],
      2018: [2.6, 8.9], 2019: [2.6, 8.9], 2020: [2.6, 8.9], 2021: [2.5, 8.8],
      2022: [2.4, 8.7], 2023: [2.4, 8.7], 2024: [2.4, 8.7], 2025: [2.4, 8.7],
      2026: [2.8, 9.1],
    };
    for (const [y, [ika, koe]] of Object.entries(kohyo)) {
      const w = pick_wariai(list, Number(y));
      assert.equal(w["延滞税_納期限の翌日から2月以内"], ika, `${y}年の2月以内`);
      assert.equal(w["延滞税_2月を経過した日以後"], koe, `${y}年の2月経過後`);
    }
  });

  test("利子税は、令和2年分まで公表値・令和3年分以後は条文から算出と区分している", () => {
    for (const w of list) {
      const kubun = w["利子税の出典区分"];
      assert.ok(["公表", "条文から算出"].includes(kubun), `${w["適用年表示"]}の出典区分`);
      assert.equal(
        kubun,
        w["適用年"] <= 2020 ? "公表" : "条文から算出",
        `${w["適用年表示"]}の出典区分が改正の時期と合っていない`,
      );
    }
  });

  test("暦年の分割が日数を取りこぼさない", () => {
    const k = split_by_year("2024-11-15", "2026-02-10");
    assert.equal(k.length, 3);
    assert.deepEqual(k.map((x) => x.年), [2024, 2025, 2026]);
    assert.equal(
      k.reduce((s, x) => s + x.日数, 0),
      count_days("2024-11-15", "2026-02-10"),
    );
    assert.equal(k[1].日数, 365, "2025年は平年");
  });
});
