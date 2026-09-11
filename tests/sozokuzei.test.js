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
  floor_hyaku,
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

  test("百円未満の切捨ては、計算機の誤差だけを吸収する（通則法119条1項）", () => {
    // 17条の按分が1/3のとき、浮動小数点では真の値をわずかに下回る。
    // 補正しないと100円欠ける
    assert.equal(floor_hyaku(27679999.999999996), 27680000);
    // ★補正は0.000001円。1円未満の端数を切り上げてはいけない
    //   （ここを0.5にすると下の2件が1100円・1000円になる）
    assert.equal(floor_hyaku(1099.5), 1000);
    assert.equal(floor_hyaku(999.999), 900);
    // 負にはしない（19条1項）
    assert.equal(floor_hyaku(-5000), 0);
  });

  test("各人の課税価格は千円未満を切り捨てる（通則法118条1項）", () => {
    // 贈与財産に千円未満の端数があっても、各人の課税価格は千円単位になる
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        zoyo_3nen: 1234567,
        kosei: { haigusha: false, jisshi: 2 },
      }),
      tables,
    );
    assert.equal(r.kazei_kakaku_gokei, 301234000);
    for (const m of r.pattern1.meisai) assert.equal(m.kazei_kakaku % 1000, 0);
    // 贈与を引き受けた人は、遺産部分と贈与を足してから切り捨てる
    assert.equal(r.pattern1.meisai[0].kazei_kakaku, 151234000);
  });

  test("2割加算も軽減も贈与も無ければ、納付総額は相続税の総額と一致する（17条）", () => {
    // 按分の分母は「各人の課税価格の合計」。分子だけ千円未満を切り捨てて分母を切り捨て前に
    // すると、割合の合計が1を割って納付総額が総額を下回る（財産5億円で600円）
    const r = calc_sozokuzei(
      input({ zaisan: 500000000, kosei: { haigusha: true, jisshi: 3 } }),
      tables,
    );
    assert.equal(r.pattern2.nofu_sogaku, r.sogaku);
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
      ).minpo_kosei,
      "shutoku",
    ).list;
    const kyodai = bun.filter((p) => p.label === "兄弟姉妹");
    assert.equal(kyodai.length, 2);
    assert.equal(kyodai[0].bun, 1 / 8);
    assert.equal(kyodai[0].nibai_kasan, true);
    assert.equal(bun.find((p) => p.key === "haigusha").bun, 3 / 4);
  });

  test("孫養子は2割加算の対象、代襲相続の孫は対象外（相法18条1項・2項）", () => {
    // 18条の加算は「財産を取得した者」に当たるので、民法どおりの構成で見る
    const bun = hotei_sozokubun(
      count_sozokunin(
        { haigusha: false, jisshi: 1, yoshi: 1, mago_yoshi: 1, shibo_ko: 1, daishu_mago: 2 },
        version["養子の数の制限"],
      ).minpo_kosei,
      "shutoku",
    ).list;
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
    const bun = hotei_sozokubun(c.seigen_go, "sogaku").list;
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

  test("人数に極端な値を渡しても計算モジュール側で丸める（画面のガードに頼らない）", () => {
    // ★この値はそのままループ回数になる。画面を1つ足しただけで固まる経路ができないよう、
    //   count_sozokunin 自身が上限を持つ（セキュリティ診断の低-1）
    const t0 = process.hrtime.bigint();
    const r = calc_sozokuzei(
      input({ kosei: { haigusha: true, jisshi: 100000000, yoshi: 0 } }),
      tables,
    );
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.ok, true);
    assert.equal(r.ninzu, 21); // 配偶者1＋子20（上限）
    assert.ok(ms < 100, `丸めが効いていない（${Math.round(ms)}ms かかった）`);
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

// ------------------------ ⑥ 養子の数の制限と、実際に財産を取得する人（15条2項・17条・18条）
//
// 相続税法15条2項の養子の数の制限は「相続人の数」＝基礎控除（15条1項）と
// 相続税の総額（16条は「前条第二項に規定する相続人の数に応じた相続人」と書く）にだけ効く。
// 17条は「相続又は遺贈により**財産を取得した者**」の課税価格で按分する規定で、
// 制限で数に入らなかった養子も民法上は相続人として財産を取得し、18条の加算対象になる。
//
// ★ここは金額（納付額）で断言する。`nibai_kasan` の旗だけを見るテストは、
//   2割加算を掛ける1行を消しても通ってしまう（実測で確認済み）。

describe("⑥ 養子の数の制限と、実際に財産を取得する人", () => {
  // 実子1人・養子2人（うち孫養子1人）・配偶者なし・財産3億円
  //   民法上の相続人 … 実子1・普通養子1・孫養子1 ＝ 3人
  //   15条2項の相続人の数 … 実子があるので養子は1人まで ＝ 2人
  const A = () =>
    calc_sozokuzei(
      input({
        zaisan: 300000000,
        kosei: { haigusha: false, jisshi: 1, yoshi: 2, mago_yoshi: 1 },
      }),
      tables,
    );

  test("基礎控除と相続税の総額は、制限後の相続人の数で計算する（15条1項・16条）", () => {
    const r = A();
    assert.equal(r.ok, true);
    // 3000万＋600万×2人
    assert.equal(r.kiso_kojo, 42000000);
    assert.equal(r.kazei_isan, 258000000);
    // 制限後2人が法定相続分1/2ずつ＝各1億2900万円 → 各3460万円
    assert.equal(r.kazei_isan_meisai.length, 2);
    assert.equal(r.sogaku, 69200000);
  });

  test("納付額の明細は、制限で落ちた養子も含めた実際の相続人で按分する（17条）", () => {
    const r = A();
    // 3人が法定相続分どおり（各1/3）取得 → 課税価格は各1億円
    assert.equal(r.pattern1.meisai.length, 3);
    for (const m of r.pattern1.meisai) assert.equal(m.kazei_kakaku, 100000000);
    assert.deepEqual(
      r.pattern1.meisai.map((m) => m.label),
      ["子（実子）", "子（養子）", "孫養子"],
    );
  });

  test("制限で落ちた孫養子にも2割加算がかかる（18条2項）", () => {
    const r = A();
    const [jisshi, yoshi, mago] = r.pattern1.meisai;
    // 6920万円 × 1/3 ＝ 23,066,666.66… → 百円未満切捨て
    assert.equal(jisshi.nofu, 23066600);
    assert.equal(yoshi.nofu, 23066600);
    // 同じ按分額に20％を加算する。23,066,666.66… × 1.2 ＝ 27,680,000 ちょうど
    assert.equal(mago.nofu, 27680000);
    assert.equal(r.pattern1.nofu_sogaku, 73813200);
  });

  test("養子が全員孫養子なら、制限で落ちた分も含めて全員が2割加算（18条2項）", () => {
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        kosei: { haigusha: false, jisshi: 0, yoshi: 3, mago_yoshi: 3 },
      }),
      tables,
    );
    // 実子がないので養子は2人まで＝相続人の数2人。総額は上と同じ
    assert.equal(r.kiso_kojo, 42000000);
    assert.equal(r.sogaku, 69200000);
    // 民法上は3人が相続人。全員が2割加算
    assert.equal(r.pattern1.meisai.length, 3);
    for (const m of r.pattern1.meisai) assert.equal(m.nofu, 27680000);
    assert.equal(r.pattern1.nofu_sogaku, 83040000);
  });

  test("制限にかからない構成では、これまでと同じ結果になる（回帰）", () => {
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        kosei: { haigusha: false, jisshi: 1, yoshi: 1, mago_yoshi: 1 },
      }),
      tables,
    );
    assert.equal(r.kiso_kojo, 42000000);
    assert.equal(r.sogaku, 69200000);
    assert.equal(r.pattern1.meisai.length, 2);
    assert.equal(r.pattern1.meisai[0].nofu, 34600000); // 実子
    assert.equal(r.pattern1.meisai[1].nofu, 41520000); // 孫養子＝34,600,000×1.2
    assert.equal(r.pattern1.nofu_sogaku, 76120000);
  });

  test("保険金の非課税枠は制限後の相続人の数で数える（12条1項6号は15条2項の数を引く）", () => {
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        hokenkin: 20000000,
        kosei: { haigusha: false, jisshi: 1, yoshi: 2, mago_yoshi: 1 },
      }),
      tables,
    );
    // 500万円×2人。民法どおりの3人で数えると1500万円になってしまう
    assert.equal(r.hikazei_waku, 10000000);
  });

  test("贈与を引き受けるのは配偶者以外の相続人の先頭（実子がいれば実子）", () => {
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        zoyo_3nen: 10000000,
        kosei: { haigusha: false, jisshi: 1, yoshi: 2, mago_yoshi: 1 },
      }),
      tables,
    );
    assert.equal(r.pattern1.kasan_uke_label, "子（実子）");
  });

  test("2割加算をしてから贈与税額を引く（18条→19条の順序）", () => {
    // 孫養子3人（実子なし）・財産3億円・3年以内の贈与2000万円・その贈与税900万円
    //   相続人の数2人 → 基礎控除4200万／課税価格の合計3億2000万／課税遺産2億7800万
    //   総額＝(1億3900万×40%－1700万)×2＝7720万
    //   引受人の課税価格＝3億×1/3＋2000万＝1億2000万
    //   7720万×1億2000万/3億2000万＝2895万 →×1.2＝3474万 →－900万＝2574万
    //   ★順序を逆にすると (2895万－900万)×1.2＝2394万 になり、180万円ずれる
    const r = calc_sozokuzei(
      input({
        zaisan: 300000000,
        zoyo_3nen: 20000000,
        zoyozei: 9000000,
        kosei: { haigusha: false, jisshi: 0, yoshi: 3, mago_yoshi: 3 },
      }),
      tables,
    );
    assert.equal(r.sogaku, 77200000);
    assert.equal(r.pattern1.meisai[0].kazei_kakaku, 120000000);
    assert.equal(r.pattern1.meisai[0].nofu, 25740000);
    // 贈与を引き受けていない孫養子は 7720万×1億/3億2000万×1.2
    assert.equal(r.pattern1.meisai[1].nofu, 28950000);
  });
});
