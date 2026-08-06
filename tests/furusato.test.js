// ふるさと納税シミュレーター（src/calc/furusato.js）のテスト
//
// ★最重要方針：期待値は実装のロジックを読んで作らない。
//   このファイルは src/calc/furusato.js を書く前に書いた。期待値はすべて条文
//   （地方税法37条の2第11項・314条の7第11項・附則5条の5・附則5条の6、所得税法78条1項1号）と
//   data/*.json の数値から手で計算して導いている。
//
// 3種＋αを置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理　② 境界値　③ 改正前後の分岐　④ 上限の分岐　⑤ レビュー由来の回帰テスト
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { calc_furusato, pick_wariai, calc_joge_a } from "../src/calc/furusato.js";
import { pick_version } from "../src/calc/version_pick.js";

function load(name) {
  return JSON.parse(
    readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"),
  );
}

const tables = {
  shotokuzei: load("shotokuzei"),
  juminzei: load("juminzei"),
  bunri_kazei: load("bunri_kazei"),
  income_tax: load("income_tax_rates"),
  furusato: load("furusato"),
};

const NEN_R7 = 2025;
const NEN_R8 = 2026;

const fv = pick_version(tables.furusato["版"], NEN_R8);
const TOKUREI = fv["特例控除"];
const JIKO_FUTAN = fv["自己負担額"];

/** エンジンに渡す入力の既定（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    nen: NEN_R8,
    shitei_toshi: false,
    kyuyo_shunyu: 0,
    nenkin_zasshotoku: 0,
    jigyo_shotoku: 0,
    fudosan_shotoku: 0,
    sonota_sogo_shotoku: 0,
    taishoku_shotoku_kingaku: 0,
    bunri: [],
    jinteki: {
      honnin_shogaisha: null,
      honnin_kafu: false,
      honnin_hitorioya: null,
      honnin_kinro_gakusei: false,
      haigusha: null,
      fuyo_shinzoku: [],
    },
    butsuteki: {
      shakai_hoken_ryo: 0,
      shokibo_kyosai: 0,
      seimei_hokenryo: {},
      jishin_hokenryo: {},
      iryohi_kojo: 0,
      zasson_kojo: 0,
      kifukin_kojo: 0,
    },
    ...over,
  };
}

// ------------------------------------------------ ① 割合の選び方（条文の号）

describe("① 割合の選び方（地方税法37条の2第11項・附則5条の5）", () => {
  describe("11項1号：課税総所得金額から人的控除差調整額を控除した金額が零以上", () => {
    // 附則5条の6が読み替えた後の割合。区分は195万／330万／695万／900万／1,800万／4,000万。
    const kyokai = [
      [1950000, 84.895],
      [1950001, 79.79],
      [3300000, 79.79],
      [3300001, 69.58],
      [6950000, 69.58],
      [6950001, 66.517],
      [9000000, 66.517],
      [9000001, 56.307],
      [18000000, 56.307],
      [18000001, 49.16],
      [40000000, 49.16],
      [40000001, 44.055],
    ];
    for (const [sashihiki, percent] of kyokai) {
      test(`差引${sashihiki.toLocaleString()}円 → ${percent}%`, () => {
        const r = pick_wariai(10000000, sashihiki, [], TOKUREI);
        assert.equal(r.wariai_percent, percent);
        assert.equal(r.konkyo, "地方税法37条の2第11項1号");
      });
    }

    test("差引がちょうど零のときも1号（「零以上であるとき」）", () => {
      const r = pick_wariai(3000000, 0, [], TOKUREI);
      assert.equal(r.wariai_percent, 84.895);
      assert.equal(r.konkyo, "地方税法37条の2第11項1号");
    });
  });

  describe("11項2号：差引が零を下回り、課税山林・課税退職を有しない", () => {
    test("分離課税がなければ90%", () => {
      const r = pick_wariai(500000, -100000, [], TOKUREI);
      assert.equal(r.wariai_percent, 90);
      assert.equal(r.konkyo, "地方税法37条の2第11項2号");
    });

    test("★90%には附則5条の6の読替えが及ばない（1.021を掛けない）", () => {
      // 附則5条の6が読み替えるのは11項1号の表と附則5条の5第1項3号〜5号だけ。
      const r = pick_wariai(500000, -1, [], TOKUREI);
      assert.equal(r.wariai_percent, 90);
    });
  });

  describe("附則5条の5：2号に該当し、かつ分離課税の適用を受けるとき", () => {
    test("長期譲渡（附則34条）だけなら74.685%", () => {
      const r = pick_wariai(500000, -100000, ["tochi_choki"], TOKUREI);
      assert.equal(r.wariai_percent, 74.685);
      assert.equal(r.konkyo, "地方税法附則5条の5第1項");
    });

    test("短期譲渡（附則35条）を足すと59.37%まで下がる（最も低い割合）", () => {
      const r = pick_wariai(500000, -100000, ["tochi_choki", "tochi_tanki"], TOKUREI);
      assert.equal(r.wariai_percent, 59.37);
    });

    test("上場株式等の譲渡・一般株式等の譲渡・上場配当はいずれも74.685%", () => {
      for (const k of ["jojo_joto", "ippan_joto", "jojo_haito"]) {
        assert.equal(pick_wariai(500000, -1, [k], TOKUREI).wariai_percent, 74.685);
      }
    });

    test("課税総所得金額を有しない場合も、分離課税があれば附則5条の5", () => {
      // 「課税総所得金額、課税退職所得金額及び課税山林所得金額を有しない場合であつて」
      const r = pick_wariai(0, 0, ["tochi_tanki"], TOKUREI);
      assert.equal(r.wariai_percent, 59.37);
      assert.equal(r.konkyo, "地方税法附則5条の5第1項");
    });
  });

  test("課税総所得金額も分離課税もないときは、どの号にも該当しない", () => {
    // 11項2号は「課税総所得金額を有する場合」が要件、3号は課税山林・課税退職が要件。
    // 附則5条の5も分離課税の適用が要件。90%と表示してはいけない。
    const r = pick_wariai(0, 0, [], TOKUREI);
    assert.equal(r.wariai_percent, null);
  });
});

// ------------------------------------- ② 限度額A（20%上限の逆算）と端数処理

describe("② 特例控除の20%上限からの逆算（地方税法37条の2第11項）", () => {
  test("所得割額240,500円・割合84.895% → 58,658円台", () => {
    // 240,500×20％＝48,100。48,100÷0.84895＝56,658.2…。＋自己負担2,000円
    const a = calc_joge_a(240500, 84.895, TOKUREI, JIKO_FUTAN);
    assert.ok(Math.abs(a - 58658.22) < 0.5, `実際の値: ${a}`);
  });

  test("割合が小さいほど限度額は大きくなる（20%上限に達するまで多く寄附できる）", () => {
    const takai = calc_joge_a(240500, 84.895, TOKUREI, JIKO_FUTAN);
    const hikui = calc_joge_a(240500, 44.055, TOKUREI, JIKO_FUTAN);
    assert.ok(hikui > takai);
  });

  test("所得割額が0なら自己負担額そのものになる（＝控除される寄附額はない）", () => {
    assert.equal(calc_joge_a(0, 84.895, TOKUREI, JIKO_FUTAN), JIKO_FUTAN);
  });

  test("★特例控除額の総額上限があるときは分子が min に切り替わる（令和9年分の寄附から）", () => {
    // 令和9年分から道府県77万2千円・市町村115万8千円＝合計193万円の総額上限が入る。
    // 令和7年分・令和8年分の版は null なので、仮の版を渡して分岐だけを固定する。
    const kari = { ...TOKUREI, 特例控除額の総額上限: 1930000 };
    // 所得割額2,000万円 → 20％は400万円。総額上限193万円のほうが低い。
    const a = calc_joge_a(20000000, 44.055, kari, JIKO_FUTAN);
    const kitai = 1930000 / 0.44055 + JIKO_FUTAN;
    assert.ok(Math.abs(a - kitai) < 0.5, `実際の値: ${a}`);
    // 上限が無い版では分子が20%のまま
    const nashi = calc_joge_a(20000000, 44.055, TOKUREI, JIKO_FUTAN);
    assert.ok(nashi > a);
  });
});

// --------------------------------------------------- ③ 統合（手計算した事例）

describe("③ 限度額の全体計算（条文から手で計算した事例）", () => {
  // 【事例1】令和8年分・給与収入500万円・社会保険料70万円・独身・ほかの控除なし
  //
  // 給与所得   5,000,000は別表第五（660万円未満）。4,000円刻みの下限は5,000,000。
  //            控除＝1,160,000＋(5,000,000−3,600,000)×20％＝1,440,000
  //            給与所得＝5,000,000−1,440,000＝3,560,000
  // 所得税の所得控除 基礎620,000＋措置法の加算420,000＝1,040,000、社会保険料700,000 → 1,740,000
  //            課税総所得金額＝3,560,000−1,740,000＝1,820,000
  // 住民税の所得控除 基礎430,000＋社会保険料700,000＝1,130,000
  //            課税総所得金額＝3,560,000−1,130,000＝2,430,000
  // 人的控除差調整額 50,000＋max(1,040,000−480,000,0)＝610,000
  // 調整控除   合計課税所得2,430,000＞2,000,000 → 50,000−430,000＜50,000 なので50,000
  //            道府県1,000／市町村1,500
  // 所得割     道府県2,430,000×4％−1,000＝96,200／市町村×6％−1,500＝144,300 → 240,500
  // 正式の引き値 2,430,000−610,000＝1,820,000 ≦1,950,000 → 84.895％
  // 簡易の引き値 1,820,000（所得税ベースの課税総所得金額）→ 同じ84.895％
  // 限度額     240,500×20％÷0.84895＋2,000＝58,658.2… → 1,000円未満切捨てで58,000円
  const jirei1 = input({ kyuyo_shunyu: 5000000, butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000 } });

  test("事例1：住民税所得割額が240,500円になる", () => {
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.ok, true);
    assert.equal(r.engine.juminzei.shotokuwari.gokei, 240500);
  });

  test("事例1：正式方式の引き値は1,820,000円・割合は84.895%", () => {
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.seishiki.hikizuru_gaku, 1820000);
    assert.equal(r.seishiki.wariai_percent, 84.895);
  });

  test("事例1：限度額は58,000円（1,000円未満切捨て）", () => {
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.seishiki.gendo_gaku, 58000);
    assert.ok(Math.abs(r.seishiki.gendo_gaku_riron - 58658.22) < 0.5);
  });

  test("事例1：物的控除に差がないので簡易方式と一致し、差額は0円", () => {
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.kani.gendo_gaku, 58000);
    assert.equal(r.sagaku, 0);
  });

  test("事例1：3つの控除の内訳の合計が「限度額−2,000円」に一致する", () => {
    // 所得税5％×1.021＝5.105％、住民税基本10％、住民税特例84.895％ → 合計100％
    const r = calc_furusato(jirei1, tables);
    const u = r.seishiki.uchiwake;
    assert.ok(Math.abs(u.shotokuzei - 56000 * 0.05105) < 0.5);
    assert.equal(u.juminzei_kihon, 5600);
    assert.ok(Math.abs(u.juminzei_tokurei - 56000 * 0.84895) < 0.5);
    assert.ok(Math.abs(u.gokei - 56000) < 0.5);
    assert.equal(u.jiko_futan_ni_osamaru, true);
  });

  // 【事例2】令和8年分・給与収入5,004,000円・社会保険料50万円・生命保険料3区分とも各8万円・独身
  //
  // ★正式方式と簡易方式で割合の区分が分かれる事例。
  //   正式の引き値＝所得税の課税総所得金額＋（所得税の物的控除−住民税の物的控除）になるため、
  //   生命保険料控除・地震保険料控除・ふるさと納税以外の寄附金控除があるときにだけズレる。
  //
  // 給与所得   下限5,004,000 → 控除1,160,000＋(5,004,000−3,600,000)×20％＝1,440,800
  //            給与所得＝3,563,200
  // 生命保険料控除 所得税は3区分とも各40,000で合計上限120,000／住民税は各28,000で合計上限70,000
  // 所得税の所得控除 1,040,000＋500,000＋120,000＝1,660,000
  //            課税総所得金額＝3,563,200−1,660,000＝1,903,200 → 千円未満切捨て1,903,000
  // 住民税の所得控除 430,000＋500,000＋70,000＝1,000,000
  //            課税総所得金額＝3,563,200−1,000,000＝2,563,200 → 千円未満切捨て2,563,000
  // 人的控除差調整額 610,000（事例1と同じ）
  // 正式の引き値 2,563,000−610,000＝1,953,000 ＞1,950,000 → 79.79％
  // 簡易の引き値 1,903,000 ≦1,950,000 → 84.895％
  // 所得割     道府県2,563,000×4％−1,000＝101,520／市町村×6％−1,500＝152,280 → 253,800
  // 正式の限度額 253,800×20％÷0.7979＋2,000＝65,616.9… → 65,000円
  // 簡易の限度額 253,800×20％÷0.84895＋2,000＝61,791.5… → 61,000円
  const hoken = { shin_seimei: 80000, shin_nenkin: 80000, kaigo_iryo: 80000 };
  const jirei2 = input({
    kyuyo_shunyu: 5004000,
    butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 500000, seimei_hokenryo: hoken },
  });

  test("事例2：正式は79.79%・簡易は84.895%で区分が分かれる", () => {
    const r = calc_furusato(jirei2, tables);
    assert.equal(r.seishiki.hikizuru_gaku, 1953000);
    assert.equal(r.seishiki.wariai_percent, 79.79);
    assert.equal(r.kani.hikizuru_gaku, 1903000);
    assert.equal(r.kani.wariai_percent, 84.895);
  });

  test("事例2：正式65,000円・簡易61,000円で、差額は4,000円", () => {
    const r = calc_furusato(jirei2, tables);
    assert.equal(r.engine.juminzei.shotokuwari.gokei, 253800);
    assert.equal(r.seishiki.gendo_gaku, 65000);
    assert.equal(r.kani.gendo_gaku, 61000);
    assert.equal(r.sagaku, 4000);
  });

  test("事例2：★正式方式では自己負担が2,000円ちょうどにならない", () => {
    // 所得税の限界税率は5％（課税総所得1,903,000）なので
    // 5.105％＋10％＋79.79％＝94.895％。残り5.105％が自己負担に乗る。
    const r = calc_furusato(jirei2, tables);
    assert.equal(r.seishiki.uchiwake.jiko_futan_ni_osamaru, false);
    assert.ok(Math.abs(r.seishiki.uchiwake.gokei - 63000 * 0.94895) < 0.5);
    // 簡易方式のほうは一致する
    assert.equal(r.kani.uchiwake.jiko_futan_ni_osamaru, true);
  });

  test("★簡易方式の限度額は正式方式を超えない（引き値は正式のほうが大きいか等しい）", () => {
    for (const inp of [jirei1, jirei2]) {
      const r = calc_furusato(inp, tables);
      assert.ok(r.kani.gendo_gaku <= r.seishiki.gendo_gaku);
    }
  });
});

// ---------------------------------------------- ④ 30%・40%の上限とその分母

describe("④ 基本控除の30%上限と所得税の寄附金控除の40%上限", () => {
  const jirei1 = input({ kyuyo_shunyu: 5000000, butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000 } });

  test("分母は合計所得金額（住民税ベース30%・所得税ベース40%）", () => {
    // 合計所得金額＝給与所得3,560,000（分離・退職なし）
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.seishiki.joge.B, 3560000 * 0.3);
    assert.equal(r.seishiki.joge.C, 3560000 * 0.4);
  });

  test("非負の入力では20%上限（A）が必ず決め手になる", () => {
    const r = calc_furusato(jirei1, tables);
    assert.equal(r.seishiki.kimete, "A");
  });

  test("★ほかの寄附金があると40%の枠を分け合う（所法78条1項1号は特定寄附金の合計額）", () => {
    const inp = input({
      kyuyo_shunyu: 5000000,
      butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000, kifukin_kojo: 100000 },
    });
    const r = calc_furusato(inp, tables);
    // 入力は控除額（＝支出額−2,000円）なので、支出額102,000円を40%枠から差し引く
    assert.equal(r.seishiki.joge.C, 3560000 * 0.4 - 102000);
    // 住民税側（30%）は他の寄附金の入力を持たないため注意書きを出す
    assert.ok(r.chui.some((s) => s.includes("ほかの寄附金")));
  });
});

// -------------------------------------------- ⑤ 回帰テスト（レビュー由来ほか）

describe("⑤ 回帰テスト", () => {
  test("★16歳未満の扶養親族の有無で限度額が変わる（所得金額調整控除）", () => {
    // 措置法41条の3の11第1項は「23歳未満の扶養親族」で発動する。16歳未満は扶養控除には効かないが
    // 所得金額調整控除には効くため、入力欄を落とすと限度額が過大に出る。
    const base = {
      kyuyo_shunyu: 9000000,
      butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 1300000 },
    };
    const nashi = calc_furusato(input(base), tables);
    const ari = calc_furusato(
      input({
        ...base,
        jinteki: {
          ...input().jinteki,
          fuyo_shinzoku: [{ nenrei: 10, gokei_shotoku: 0, shogaisha: null, dokyo_rokei_sonzoku: false }],
        },
      }),
      tables,
    );
    // 調整控除＝(9,000,000−8,500,000)×10％＝50,000 だけ給与所得が下がる
    assert.equal(ari.engine.shotoku_kingaku_chosei_kojo.gokei, 50000);
    assert.ok(ari.seishiki.gendo_gaku < nashi.seishiki.gendo_gaku);
  });

  test("★附則5条の5は実際に到達する（合計所得2,400万円超で基礎控除が48万円を下回るとき）", () => {
    // 差引＝所得税の課税総所得金額＋（所得税の物的控除−住民税の物的控除）
    //       −max(48万円−所得税の基礎控除, 0)
    // なので、基礎控除が48万円を下回る（合計所得2,400万円超）と差引が負になりうる。
    // 総合課税だけで2,400万円を超えると課税総所得金額も大きく差引は正になるため、
    // 負になるのは分離課税があるときに限られ、そのときは必ず附則5条の5が働く。
    // ＝【11項2号の90％は、このエンジンでは到達しない】
    const inp = input({
      kyuyo_shunyu: 3700000,
      bunri: [{ kubun: "tochi_choki", shotoku_kingaku: 25000000, kazei_hyojun: 25000000 }],
      jinteki: {
        ...input().jinteki,
        fuyo_shinzoku: Array.from({ length: 4 }, () => ({
          nenrei: 20,
          gokei_shotoku: 0,
          shogaisha: null,
          dokyo_rokei_sonzoku: false,
        })),
      },
    });
    const r = calc_furusato(inp, tables);
    assert.equal(r.ok, true);
    assert.ok(r.seishiki.hikizuru_gaku < 0, `差引: ${r.seishiki.hikizuru_gaku}`);
    assert.equal(r.seishiki.wariai_percent, 74.685);
    assert.equal(r.seishiki.wariai_konkyo, "地方税法附則5条の5第1項");
    // 短期譲渡を足すと最も低い割合（59.37％）に下がる
    const tanki = calc_furusato(
      { ...inp, bunri: [...inp.bunri, { kubun: "tochi_tanki", shotoku_kingaku: 1000000, kazei_hyojun: 1000000 }] },
      tables,
    );
    assert.equal(tanki.seishiki.wariai_percent, 59.37);
    // 同じ入力から分離課税だけを外すと、エンジンの打ち切りに当たる（＝2号に落ちない）
    const bunri_nashi = calc_furusato({ ...inp, bunri: [] }, tables);
    assert.equal(bunri_nashi.ok, false);
  });

  test("★令和7年分と令和8年分で限度額が変わる（令和8年度改正）", () => {
    // 給与所得控除・基礎控除・措置法の加算がまるごと入れ替わる（判断ログ D-28）。
    const over = { kyuyo_shunyu: 5000000, butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000 } };
    const r7 = calc_furusato(input({ ...over, nen: NEN_R7 }), tables);
    const r8 = calc_furusato(input({ ...over, nen: NEN_R8 }), tables);
    assert.equal(r7.ok, true);
    assert.equal(r8.ok, true);
    assert.notEqual(r7.seishiki.gendo_gaku, r8.seishiki.gendo_gaku);
  });

  test("収録していない年分は理由を返す", () => {
    const r = calc_furusato(input({ nen: 2027, kyuyo_shunyu: 5000000 }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /収録/);
  });

  test("所得控除が総所得金額を超える場合はエンジンの理由をそのまま返す", () => {
    const r = calc_furusato(input({ kyuyo_shunyu: 700000 }), tables);
    assert.equal(r.ok, false);
    assert.match(r.riyu, /所得控除/);
  });

  test("★所得割額が0になる入力は、その手前でエンジンの打ち切りに当たる（到達しない分岐）", () => {
    // 住民税の課税総所得金額が0になるのは「総所得金額＝住民税の所得控除」のときだが、
    // 所得税の基礎控除（62万円＋措置法の加算）は住民税の基礎控除（43万円）より必ず大きいので、
    // その入力では先に「所得控除が総所得金額を超えています」でエンジンが止まる。
    // したがって calc_furusato の kojo_nashi は防御的な分岐であり、通常は到達しない。
    // 到達しないことをここで固定しておく（到達するようになったら控除額の関係が変わっている）。
    let saigo_no_ng = null;
    let saisho_no_ok = null;
    for (let shunyu = 1000000; shunyu <= 2000000; shunyu += 10000) {
      const r = calc_furusato(input({ kyuyo_shunyu: shunyu }), tables);
      if (!r.ok) saigo_no_ng = shunyu;
      else if (saisho_no_ok === null) saisho_no_ok = r;
    }
    assert.ok(saigo_no_ng !== null, "打ち切りになる入力が1つも無い");
    assert.equal(saisho_no_ok.kojo_nashi, false);
    assert.ok(saisho_no_ok.engine.juminzei.shotokuwari.gokei > 0);
    // 割合が決まらないケース（課税総所得金額も分離課税も無い）も同じ理由で到達しない
    assert.equal(pick_wariai(0, 0, [], TOKUREI).wariai_percent, null);
  });

  test("指定都市かどうかで限度額は変わらない", () => {
    const over = { kyuyo_shunyu: 5000000, butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000 } };
    const futsu = calc_furusato(input(over), tables);
    const shitei = calc_furusato(input({ ...over, shitei_toshi: true }), tables);
    assert.equal(futsu.seishiki.gendo_gaku, shitei.seishiki.gendo_gaku);
  });

  test("適用年分の表示がふるさと納税の版から出る", () => {
    const r = calc_furusato(input({ kyuyo_shunyu: 5000000, butsuteki: { ...input().butsuteki, shakai_hoken_ryo: 700000 } }), tables);
    assert.equal(r.tekiyo_nenbun_hyoji, fv["適用年分表示"]);
  });
});

// ------------------------------------------------------------ ⑥ データの整合

describe("⑥ data/furusato.json の整合", () => {
  test("割合表は7区分で、最後の区分だけ上限が null", () => {
    const t = TOKUREI["割合表"];
    assert.equal(t.length, 7);
    assert.equal(t.at(-1)["課税総所得の上限"], null);
    for (const r of t.slice(0, -1)) assert.equal(typeof r["課税総所得の上限"], "number");
  });

  test("★読み替え後の割合は「90％−所得税の税率×1.021」と全区分で一致する", () => {
    // 数値としては一致するが、法令は式ではなく固定値で定めている（附則5条の6）。
    // 一致しなくなったら、読替えの改正か所得税率の改正のどちらかを取りこぼしている。
    const rv = pick_version(tables.income_tax["版"], NEN_R8);
    const fukko = 1 + rv["復興特別所得税率パーセント"] / 100;
    for (const row of TOKUREI["割合表"]) {
      const kazei = row["課税総所得の上限"] ?? 50000000;
      const zeiritsu = rv["速算表"].find(
        (x) => x["課税退職所得金額の上限"] === null || kazei <= x["課税退職所得金額の上限"],
      )["税率パーセント"];
      const kitai = Math.round((90 - zeiritsu * fukko) * 1000) / 1000;
      assert.equal(row["割合パーセント"], kitai);
    }
  });

  test("附則5条の5の割合は分離課税の5区分すべてに割り付けてある", () => {
    const bv = pick_version(tables.bunri_kazei["版"], NEN_R8);
    const keys = bv["区分"].map((k) => k["key"]).sort();
    const mine = TOKUREI["附則5条の5の割合"].map((r) => r["kubun"]).sort();
    assert.deepEqual(mine, keys);
  });

  test("令和7年分・令和8年分の版には特例控除額の総額上限が無い（令和9年分の寄附から）", () => {
    for (const nen of [NEN_R7, NEN_R8]) {
      const v = pick_version(tables.furusato["版"], nen);
      assert.equal(v["特例控除"]["特例控除額の総額上限"], null);
    }
  });

  test("復興特別所得税の乗率をこのファイルに持たない（income_tax_rates.json と二重に持たない）", () => {
    // 同じ数値を2箇所に置くと、復興特別所得税が終わったときに片方だけ直す事故が起きる。
    // 注記の文中に「1.021」が出るのは説明なので、キーとして持っていないことを確かめる。
    for (const v of tables.furusato["版"]) {
      const keys = JSON.stringify(Object.keys(v["所得税の寄附金控除"]));
      assert.equal(keys.includes("復興"), false, `キーに残っている: ${keys}`);
      assert.equal(
        Object.values(v["所得税の寄附金控除"]).includes(1.021),
        false,
      );
    }
  });
});
