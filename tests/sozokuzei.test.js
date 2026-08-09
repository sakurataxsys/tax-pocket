// 相続税の概算のテスト
//
// 3種を必ず置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理  ② 境界値  ③ 改正前後の分岐
// ＋④ 税率表の取り込みミス検知  ⑤ 相続人の構成の分岐
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_sozokuzei,
  count_sozokunin,
  hotei_sozokubun,
  zoyo_kasan_kikan,
  apply_zeiritsu,
} from "../src/calc/sozokuzei.js";

function load(name) {
  return JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"));
}

const tables = { sozokuzei: load("sozokuzei"), sozokuzei_hyo: load("sozokuzei_hyo") };
const version = tables.sozokuzei["版"][0];
const HYO = tables.sozokuzei_hyo["税率表"];

/** 既定の入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    sozoku_kaishi_bi: "2026-06-01",
    zaisan: 200000000,
    hokenkin: 0,
    taishokukin: 0,
    saimu: 0,
    zoyo_3nen: 0,
    zoyo_choka: 0,
    zoyozei: 0,
    ...over,
    kosei: { haigusha: true, jisshi: 2, yoshi: 0, ...(over.kosei ?? {}) },
  };
}

// ---------------------------------------------------------------- ① 端数処理

describe("① 端数処理", () => {
  test("課税価格の合計額は千円未満を切り捨てる（通則法118条1項）", () => {
    const r = calc_sozokuzei(input({ zaisan: 200000999 }), tables);
    assert.equal(r.ok, true);
    assert.equal(r.kazei_kakaku_gokei, 200000000);
  });

  test("納付すべき税額は百円未満を切り捨てる（通則法119条1項）", () => {
    // 端数が出る額にする。各人の納付額がすべて100円単位であることだけを見る
    const r = calc_sozokuzei(input({ zaisan: 123456789 }), tables);
    assert.equal(r.ok, true);
    for (const m of r.pattern2.meisai) assert.equal(m.nofu % 100, 0, `${m.label} が100円単位でない`);
  });

  test("贈与税額を引ききれても還付しない（相続税法19条1項・0で止める）", () => {
    // 基礎控除以下なので相続税は0。贈与税額を入れてもマイナスにならない
    const r = calc_sozokuzei(
      input({ zaisan: 10000000, zoyo_3nen: 1000000, zoyozei: 5000000 }),
      tables,
    );
    assert.equal(r.ok, true);
    assert.equal(r.sogaku, 0);
    for (const m of r.pattern2.meisai) assert.ok(m.nofu >= 0, "納付額が負になっている");
  });
});

// ------------------------------------------------------------------ ② 境界値

describe("② 境界値", () => {
  test("課税価格が基礎控除ちょうどなら課税遺産総額は0", () => {
    // 配偶者＋子2人＝3人 → 3000万＋600万×3＝4800万
    const r = calc_sozokuzei(input({ zaisan: 48000000 }), tables);
    assert.equal(r.kiso_kojo, 48000000);
    assert.equal(r.kazei_isan, 0);
    assert.equal(r.sogaku, 0);
  });

  test("養子の数は実子があれば1人まで（相続税法15条2項1号）", () => {
    const c = count_sozokunin(
      { haigusha: false, jisshi: 1, yoshi: 3 },
      version["養子の数の制限"],
    );
    assert.equal(c.ninzu, 2);
    assert.equal(c.yoshi_seigen_tekiyo, true);
  });

  test("養子の数は実子がなければ2人まで（相続税法15条2項2号）", () => {
    const c = count_sozokunin(
      { haigusha: false, jisshi: 0, yoshi: 3 },
      version["養子の数の制限"],
    );
    assert.equal(c.ninzu, 2);
  });

  test("代襲相続人の孫は実子とみなすので、養子の数の制限は1人になる（15条3項2号）", () => {
    const c = count_sozokunin(
      { haigusha: false, jisshi: 0, yoshi: 2, shibo_ko: 1, daishu_mago: 1 },
      version["養子の数の制限"],
    );
    // 実子とみなす孫がいる → 養子は1人まで。相続人＝養子1＋孫1＝2人
    assert.equal(c.ninzu, 2);
  });

  test("税率表の区分の境界で税額が変わる（相続税法16条）", () => {
    assert.equal(apply_zeiritsu(10000000, HYO), 1000000); // 1000万ちょうど＝10%
    assert.equal(apply_zeiritsu(10001000, HYO), 1000000 + 1000 * 0.15);
    assert.equal(apply_zeiritsu(600000000, HYO), apply_zeiritsu(600000000, HYO));
    // 6億超は55%
    assert.equal(
      Math.round(apply_zeiritsu(600001000, HYO) - apply_zeiritsu(600000000, HYO)),
      Math.round(1000 * 0.55),
    );
  });

  test("非課税枠が保険金より大きくてもマイナスにならない（相続税法12条1項6号）", () => {
    const r = calc_sozokuzei(input({ zaisan: 100000000, hokenkin: 1000000 }), tables);
    assert.equal(r.hoken_kazei, 0);
    assert.equal(r.kazei_kakaku_gokei, 100000000);
  });

  test("保険金と退職手当金の非課税枠は別枠（12条1項6号・7号）", () => {
    // 相続人3人 → 枠は各1500万円。両方1500万円なら課税価格に入らない
    const r = calc_sozokuzei(
      input({ zaisan: 100000000, hokenkin: 15000000, taishokukin: 15000000 }),
      tables,
    );
    assert.equal(r.hikazei_waku, 15000000);
    assert.equal(r.hoken_kazei, 0);
    assert.equal(r.taishoku_kazei, 0);
    assert.equal(r.kazei_kakaku_gokei, 100000000);
  });

  test("債務が財産を超えても課税価格は0で止まる", () => {
    const r = calc_sozokuzei(input({ zaisan: 10000000, saimu: 50000000 }), tables);
    assert.equal(r.kazei_kakaku_gokei, 0);
    assert.equal(r.sogaku, 0);
  });

  test("配偶者の税額軽減は法定相続分と1億6000万円の多いほうまで（19条の2第1項2号イ）", () => {
    // 課税価格2億円・配偶者＋子2人。配偶者の法定相続分1億 < 1億6000万 → 1.6億が基準
    // 配偶者の取得1億 ≦ 1.6億 なので配偶者の納付は0
    const r = calc_sozokuzei(input({ zaisan: 200000000 }), tables);
    const h = r.pattern1.meisai.find((m) => m.label === "配偶者");
    assert.equal(h.nofu, 0);
  });
});

// -------------------------------------------------------------- ③ 改正前後

describe("③ 改正前後の分岐", () => {
  test("平成26年12月31日以前に開始した相続は収録していない", () => {
    const r = calc_sozokuzei(input({ sozoku_kaishi_bi: "2014-12-31" }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /収録/);
  });

  test("平成27年1月1日に開始した相続は計算できる", () => {
    const r = calc_sozokuzei(input({ sozoku_kaishi_bi: "2015-01-01" }), tables);
    assert.equal(r.ok, true);
  });

  test("令和8年中に開始した相続の贈与加算は3年以内だけ（経過措置）", () => {
    const k = zoyo_kasan_kikan("2026-06-01", version["贈与加算"]);
    assert.equal(k.kikan_kaishi, "2023-06-01");
    assert.equal(k.choka_kikan_ari, false);
    assert.equal(k.choka_kojo_ari, false);
  });

  test("令和9年1月1日に開始した相続は、まだ3年より前の部分がない", () => {
    // 加算の起点は令和6年1月1日で、3年前の日も令和6年1月1日。差がない
    const k = zoyo_kasan_kikan("2027-01-01", version["贈与加算"]);
    assert.equal(k.kikan_kaishi, "2024-01-01");
    assert.equal(k.choka_kikan_ari, false);
  });

  test("令和9年6月1日に開始した相続は、令和6年1月1日から加算し100万円控除も働く", () => {
    const k = zoyo_kasan_kikan("2027-06-01", version["贈与加算"]);
    assert.equal(k.kikan_kaishi, "2024-01-01");
    assert.equal(k.choka_kikan_ari, true);
    assert.equal(k.choka_kojo_ari, true);
  });

  test("令和13年以後に開始した相続は7年前から加算する", () => {
    const k = zoyo_kasan_kikan("2031-06-01", version["贈与加算"]);
    assert.equal(k.kikan_kaishi, "2024-06-01");
    assert.equal(k.choka_kikan_ari, true);
    assert.equal(k.choka_kojo_ari, true);
  });

  test("3年より前の贈与は合計額から100万円を控除して加算する（19条1項括弧書き）", () => {
    const r = calc_sozokuzei(
      input({ sozoku_kaishi_bi: "2027-06-01", zoyo_3nen: 3000000, zoyo_choka: 3000000 }),
      tables,
    );
    assert.equal(r.zoyo_kasan, 3000000 + (3000000 - 1000000));
    assert.equal(r.zoyo_choka_kojo, 1000000);
  });

  test("令和8年の相続では3年より前の欄に入れても加算しない", () => {
    const r = calc_sozokuzei(
      input({ sozoku_kaishi_bi: "2026-06-01", zoyo_3nen: 3000000, zoyo_choka: 9999999 }),
      tables,
    );
    assert.equal(r.zoyo_kasan, 3000000);
  });
});

// ------------------------------------------------------ ④ 税率表の取り込み

describe("④ 税率表の取り込みミス検知", () => {
  test("相続税法16条の表は8区分である", () => {
    assert.equal(HYO.length, 8);
  });

  test("区分の上限と税率が条文どおりである", () => {
    // 相続税法16条の表（原文の漢数字を算用数字にしたもの）
    const jobun = [
      [10000000, 10],
      [30000000, 15],
      [50000000, 20],
      [100000000, 30],
      [200000000, 40],
      [300000000, 45],
      [600000000, 50],
      [null, 55],
    ];
    assert.deepEqual(
      HYO.map((k) => [k["上限"], k["税率パーセント"]]),
      jobun,
    );
  });

  test("区分は下から連続していて、税率は上がっていく", () => {
    HYO.forEach((k, i) => {
      if (i === 0) assert.equal(k["下限"], null);
      else assert.equal(k["下限"], HYO[i - 1]["上限"], `${i}番目の区分が連続していない`);
      if (i > 0) assert.ok(k["税率パーセント"] > HYO[i - 1]["税率パーセント"]);
    });
  });

  test("速算表の控除額は持たない（法令に無い値をデータに置かない）", () => {
    for (const k of HYO) assert.equal("控除額" in k, false);
  });
});

// -------------------------------------------------- ⑤ 相続人の構成の分岐

describe("⑤ 相続人の構成の分岐", () => {
  test("配偶者＋子2人・課税価格2億円の相続税の総額は2700万円", () => {
    // 基礎控除4800万 → 課税遺産総額1億5200万
    // 配偶者1/2＝7600万 → 1580万／子各1/4＝3800万 → 各560万
    const r = calc_sozokuzei(input({ zaisan: 200000000 }), tables);
    assert.equal(r.ninzu, 3);
    assert.equal(r.kiso_kojo, 48000000);
    assert.equal(r.kazei_isan, 152000000);
    assert.equal(r.sogaku, 27000000);
  });

  test("配偶者が法定相続分を取得した場合の納付総額は1350万円", () => {
    const r = calc_sozokuzei(input({ zaisan: 200000000 }), tables);
    assert.equal(r.pattern1.nofu_sogaku, 13500000);
  });

  test("配偶者が取得しない場合の納付総額は総額と同じ2700万円", () => {
    const r = calc_sozokuzei(input({ zaisan: 200000000 }), tables);
    assert.equal(r.pattern2.nofu_sogaku, 27000000);
  });

  test("相続人が配偶者のみなら納付額は0（19条の2第1項2号イの括弧書き）", () => {
    const r = calc_sozokuzei(
      input({ zaisan: 500000000, kosei: { haigusha: true, jisshi: 0 } }),
      tables,
    );
    assert.equal(r.ninzu, 1);
    assert.ok(r.sogaku > 0);
    assert.equal(r.pattern1.nofu_sogaku, 0);
    assert.equal(r.pattern2, null);
  });

  test("兄弟姉妹は2割加算の対象で、相続分は4分の1（民法900条3号・相法18条）", () => {
    const bun = hotei_sozokubun(
      count_sozokunin(
        { haigusha: true, jisshi: 0, yoshi: 0, chokkei_sonzoku: 0, kyodai: 2 },
        version["養子の数の制限"],
      ).seigen_go,
    );
    const kyodai = bun.filter((p) => p.label === "兄弟姉妹");
    assert.equal(kyodai.length, 2);
    assert.equal(kyodai[0].bun, 1 / 8);
    assert.equal(kyodai[0].nibai_kasan, true);
    assert.equal(bun.find((p) => p.key === "haigusha").bun, 3 / 4);
  });

  test("孫養子は2割加算の対象、代襲相続の孫は対象外（相法18条1項・2項）", () => {
    const bun = hotei_sozokubun(
      count_sozokunin(
        { haigusha: false, jisshi: 1, yoshi: 1, mago_yoshi: 1, shibo_ko: 1, daishu_mago: 2 },
        version["養子の数の制限"],
      ).seigen_go,
    );
    assert.equal(bun.find((p) => p.label === "孫養子").nibai_kasan, true);
    assert.equal(bun.find((p) => p.label === "孫（代襲相続）").nibai_kasan, false);
  });

  test("代襲相続の孫は、親1人分を頭数で分ける（民法901条1項ただし書）", () => {
    // 配偶者＋実子1人＋先に亡くなった子1人（その子＝孫2人）
    // 子系統1/2を2株 → 各1/4。孫は1/4を2人で分けて各1/8
    const c = count_sozokunin(
      { haigusha: true, jisshi: 1, yoshi: 0, shibo_ko: 1, daishu_mago: 2 },
      version["養子の数の制限"],
    );
    assert.equal(c.ninzu, 4);
    const bun = hotei_sozokubun(c.seigen_go);
    assert.equal(bun.find((p) => p.label === "子（実子）").bun, 1 / 4);
    assert.equal(bun.filter((p) => p.label === "孫（代襲相続）").length, 2);
    assert.equal(bun.find((p) => p.label === "孫（代襲相続）").bun, 1 / 8);
    // 相続分の合計は1
    assert.equal(Math.round(bun.reduce((s, p) => s + p.bun, 0) * 1e6) / 1e6, 1);
  });

  test("先に亡くなった子が2人以上いる場合は計算せず理由を返す", () => {
    const r = calc_sozokuzei(
      input({ kosei: { haigusha: true, jisshi: 0, shibo_ko: 2, daishu_mago: 3 } }),
      tables,
    );
    assert.equal(r.ok, false);
    assert.match(r.riyu, /代襲/);
  });

  test("法定相続人がいない場合は計算せず理由を返す", () => {
    const r = calc_sozokuzei(input({ kosei: { haigusha: false, jisshi: 0 } }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /法定相続人/);
  });

  test("贈与加算があると、配偶者が法定相続分を取得しても納付総額は0にならない", () => {
    // 贈与は配偶者以外の相続人1人が受けたものとして計算する
    const r = calc_sozokuzei(
      input({ sozoku_kaishi_bi: "2027-06-01", zaisan: 200000000, zoyo_3nen: 10000000 }),
      tables,
    );
    assert.equal(r.ok, true);
    assert.ok(r.pattern1.nofu_sogaku > 0);
    assert.equal(r.pattern1.kasan_uke_label, "子（実子）");
  });
});
