// 所得税エンジン（src/calc/shotokuzei.js）のテスト
//
// ★最重要方針：期待値は実装のロジックを読んで作らない。
//   すべて条文（所得税法・地方税法・租税特別措置法。番号は各テストのコメントに明記）から
//   手で計算して導いている。実装と食い違う箇所はテストのコメントに「不一致」として明記し、
//   期待値は条文どおりのまま残してある（実装に合わせて書き換えていない）。
//
// 3種＋αを置く（CLAUDE.md「税務ロジックの規律」）
//   ① 端数処理　② 境界値　③ 改正前後の分岐　④ データの整合　⑤ レビュー由来の回帰テスト
//
// このリポジトリは公開されるため、テストデータはすべて架空の値を使う。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  calc_kyuyo_shotoku,
  calc_shotoku_kingaku_chosei_kojo,
  calc_kiso_kojo,
  calc_jinteki_kojo,
  calc_kazei_shotoku,
  find_genkai_zeiritsu,
  calc_jinteki_kojo_sagaku_37_1_i,
  calc_jinteki_kojo_sa_chosei_gaku,
  calc_chosei_kojo,
  calc_shotokuzei_engine,
} from "../src/calc/shotokuzei.js";
import { pick_version } from "../src/calc/version_pick.js";

const tables = {
  shotokuzei: JSON.parse(
    readFileSync(new URL("../data/shotokuzei.json", import.meta.url), "utf8"),
  ),
  juminzei: JSON.parse(
    readFileSync(new URL("../data/juminzei.json", import.meta.url), "utf8"),
  ),
  bunri_kazei: JSON.parse(
    readFileSync(new URL("../data/bunri_kazei.json", import.meta.url), "utf8"),
  ),
  income_tax: JSON.parse(
    readFileSync(
      new URL("../data/income_tax_rates.json", import.meta.url),
      "utf8",
    ),
  ),
};

// ★このファイルの既定年分は【令和7年分】。
//   令和8年分は、給与所得控除・基礎控除・扶養親族等の所得要件が令和8年度改正で
//   まるごと入れ替わっている（判断ログ D-28）。既存の期待値は令和7年分の条文から
//   導いたものなので、既定を令和7年分に固定し、令和8年分は別に書く。
const NEN_R7 = 2025;
const NEN_R8 = 2026;

const sv = pick_version(tables.shotokuzei["版"], NEN_R7);
const jv = pick_version(tables.juminzei["版"], NEN_R7);
const rv = pick_version(tables.income_tax["版"], NEN_R7);

/** エンジンの既定入力（各テストで必要な項目だけ上書きする） */
function input(over = {}) {
  return {
    nen: NEN_R7,
    shitei_toshi: false,
    kyuyo_shunyu: 0,
    nenkin_zasshotoku: 0,
    jigyo_shotoku: 0,
    fudosan_shotoku: 0,
    sonota_sogo_shotoku: 0,
    taishoku_shotoku_kingaku: 0,
    bunri: [],
    jinteki: jinteki_base(),
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

/** 人的控除の既定入力（該当なし）。calc_jinteki_kojo系の単体テストで使う。 */
function jinteki_base(over = {}) {
  return {
    honnin_shogaisha: null,
    honnin_kafu: false,
    honnin_hitorioya: null,
    honnin_kinro_gakusei: false,
    haigusha: null,
    fuyo_shinzoku: [],
    ...over,
  };
}

// ---------------------------------------------------------------- ① 端数処理

describe("① 端数処理", () => {
  describe("給与所得控除・別表第五（所法28条4項）", () => {
    test("651,000円未満は所得ゼロ", () => {
      assert.equal(calc_kyuyo_shotoku(650999, sv["給与所得控除"]).kingaku, 0);
    });

    test("651,000円は「収入−65万円」の区間に入る", () => {
      // 別表第五：651,000〜1,900,000未満は収入−65万円 → 651,000−650,000＝1,000円
      assert.equal(calc_kyuyo_shotoku(651000, sv["給与所得控除"]).kingaku, 1000);
    });

    test("4,000円刻みの同一区分内は所得が同額になる", () => {
      // 2,060,000円・2,063,999円はともに4,000円刻みの下限2,060,000円に丸められる。
      // 下限に所法28条3項の速算式（190万超360万以下：65万+(収入-190万)×30%）を当てる。
      // 2,060,000−(650,000+(2,060,000−1,900,000)×30%)＝2,060,000−698,000＝1,362,000
      const a = calc_kyuyo_shotoku(2060000, sv["給与所得控除"]);
      const b = calc_kyuyo_shotoku(2063999, sv["給与所得控除"]);
      assert.equal(a.kingaku, 1362000);
      assert.equal(b.kingaku, 1362000);
    });

    test("次の4,000円区分に上がると所得も変わる", () => {
      // 下限2,064,000円 → 2,064,000−(650,000+(2,064,000−1,900,000)×30%)＝2,064,000−699,200＝1,364,800
      assert.equal(calc_kyuyo_shotoku(2064000, sv["給与所得控除"]).kingaku, 1364800);
    });

    test("660万円直前の4,000円区分も同額になる", () => {
      // 6,596,000・6,599,999円はともに下限6,596,000円（360万超660万以下：116万+(収入-360万)×20%）
      // 6,596,000−(1,160,000+(6,596,000−3,600,000)×20%)＝6,596,000−1,759,200＝4,836,800
      const a = calc_kyuyo_shotoku(6596000, sv["給与所得控除"]);
      const b = calc_kyuyo_shotoku(6599999, sv["給与所得控除"]);
      assert.equal(a.kingaku, 4836800);
      assert.equal(b.kingaku, 4836800);
    });

    test("660万円ちょうどで別表第五から3項の速算式へ切り替わる", () => {
      // 660万円未満は別表第五（4項）、660万円以上は3項の速算式そのもの。
      // 6,600,000−(1,160,000+(6,600,000−3,600,000)×20%)＝6,600,000−1,760,000＝4,840,000
      const r = calc_kyuyo_shotoku(6600000, sv["給与所得控除"]);
      assert.equal(r.kingaku, 4840000);
      assert.equal(r.besshi5, false);
    });

    test("660万円以上は所得の1円未満を切り捨てる（別表第五 備考）", () => {
      // 7,000,001−(1,760,000+(7,000,001−6,600,000)×10%)＝7,000,001−1,800,000.1＝5,200,000.9
      // → 1円未満切捨てで5,200,000円
      assert.equal(calc_kyuyo_shotoku(7000001, sv["給与所得控除"]).kingaku, 5200000);
    });
  });

  test("課税総所得金額は千円未満を切り捨てる（通則法118条1項・地方税法20条の4の2第1項）", () => {
    // calc_kazei_shotoku は所得税・住民税の両方で共用する同一関数。
    assert.equal(calc_kazei_shotoku(10000000, 5000001), 4999000); // 残額4,999,999→切捨て
    assert.equal(calc_kazei_shotoku(10000000, 5001000), 4999000); // 残額4,999,000→同額（千円未満の中で変化なし）
    assert.equal(calc_kazei_shotoku(10000000, 5000000), 5000000); // 残額5,000,000→端数なし
  });

  describe("配偶者特別控除「5万円の整数倍から3万円」丸め（所法83条の2第1項1号ロ）", () => {
    // 条文：「三十八万円からその配偶者の合計所得金額のうち九十三万一円を超える部分の金額
    //  （当該超える部分の金額が五万円の整数倍の金額から三万円を控除した金額でないときは、
    //   五万円の整数倍の金額から三万円を控除した金額で当該超える部分の金額に満たないもののうち
    //   最も多い金額とする。）を控除した金額」
    // ★「九十三万一円」＝930,001円（93万＋1円）。超える部分の金額 E＝配偶者所得−930,001。
    // 5万円刻みの候補 Cn＝50,000n−30,000（n=1,2…）のうち E 以下で最大のものを控除する。
    // 算式に入るのは配偶者所得が95万円を超えてからなので、E は必ず20,000以上になり、n=0 は使われない。
    function haigusha_kojo(gokei_shotoku) {
      const jinteki = jinteki_base({
        haigusha: { nenrei: 40, gokei_shotoku, shogaisha: null, dokyo_tokubetsu: false },
      });
      return calc_jinteki_kojo(jinteki, 5000000, sv["人的控除"]).meisai.haigusha_tokubetsu;
    }

    test("950,000円までは定額の38万円、950,001円から算式に入る", () => {
      assert.equal(haigusha_kojo(950000), 380000);
      // E＝950,001−930,001＝20,000＝C1 → 38万−2万＝36万円
      assert.equal(haigusha_kojo(950001), 360000);
    });

    test("950,001円〜1,000,000円は同額（36万円）", () => {
      // E＝1,000,000−930,001＝69,999（C2=70,000に満たないのでC1のまま）→ 36万円
      assert.equal(haigusha_kojo(1000000), 360000);
      assert.equal(haigusha_kojo(951000), 360000);
    });

    test("1,000,001円でC2=70,000に切り替わる（31万円）", () => {
      // E＝1,000,001−930,001＝70,000＝C2 → 38万−7万＝31万円
      assert.equal(haigusha_kojo(1000001), 310000);
      // 次の段（1,050,000円）まで同額
      assert.equal(haigusha_kojo(1050000), 310000);
    });

    // ★この階段は、国税庁が公表している配偶者特別控除額の表
    //   （95万超100万以下36万／100万超105万以下31万／…／130万超133万以下3万）と全区分で一致する。
    //   条文の「九十三万一円」を931,001円と読み違えると、この表と合わなくなる。
  });

  describe("特定親族特別控除「10万円の整数倍から8万円」丸め（所法84条の2第1項2号）", () => {
    // 条文：「六十三万円からその特定親族の合計所得金額のうち八十四万一円を超える部分の金額に
    //  二を乗じた金額（当該乗じた金額が十万円の整数倍の金額から八万円を控除した金額でないときは、
    //  十万円の整数倍の金額から八万円を控除した金額で当該乗じた金額に満たないもののうち
    //  最も多い金額とする。）を控除した金額」
    function tokutei_kojo(gokei_shotoku) {
      const jinteki = jinteki_base({
        fuyo_shinzoku: [
          {
            nenrei: 20,
            gokei_shotoku,
            dokyo_rokei_sonzoku: false,
            shogaisha: null,
            dokyo_tokubetsu: false,
            kokugai: false,
          },
        ],
      });
      return calc_jinteki_kojo(jinteki, 5000000, sv["人的控除"]).meisai
        .tokutei_shinzoku_tokubetsu;
    }

    // ★「八十四万一円」＝840,001円（84万＋1円）。乗じた金額＝(合計所得−840,001)×2。
    test("850,000円までは定額の63万円、850,001円から算式に入る", () => {
      assert.equal(tokutei_kojo(850000), 630000);
      // 乗じた金額＝(850,001−840,001)×2＝20,000＝C1 → 63万−2万＝61万円
      assert.equal(tokutei_kojo(850001), 610000);
    });

    test("850,001円〜900,000円は同額（61万円）", () => {
      // 乗じた金額＝(900,000−840,001)×2＝119,998（C2=120,000に満たないのでC1のまま）→ 61万円
      assert.equal(tokutei_kojo(900000), 610000);
      assert.equal(tokutei_kojo(851000), 610000);
    });

    test("900,001円でC2=120,000に切り替わる（51万円）", () => {
      // 乗じた金額＝(900,001−840,001)×2＝120,000＝C2 → 63万−12万＝51万円
      assert.equal(tokutei_kojo(900001), 510000);
      assert.equal(tokutei_kojo(950000), 510000);
    });

    // ★この階段も、公表されている特定親族特別控除額の表
    //   （85万超90万以下61万／90万超95万以下51万／…／120万超123万以下3万）と全区分で一致する。
  });

  test("住民税の配偶者特別控除は3分の2・3分の1を1万円未満切上げする（地方税法34条1項10号の2ロ・ハ）", () => {
    // 配偶者所得1,050,000円（住民税の算式区間）での基準額を先に求める。
    // 算式の基準額は住民税も38万円（データの注記どおり）。
    // E＝1,050,000−930,001＝119,999。候補Cn=50,000n-30,000のうちE以下で最大はC2=70,000
    // （C2=70,000≤118,999<C3=120,000）。38万−7万＝31万円が本人900万円以下の額。
    const jinteki = jinteki_base({
      haigusha: { nenrei: 40, gokei_shotoku: 1050000, shogaisha: null, dokyo_tokubetsu: false },
    });
    const base900 = calc_jinteki_kojo(jinteki, 5000000, jv["所得控除"]).meisai
      .haigusha_tokubetsu;
    assert.equal(base900, 310000);

    // 900万円超950万円以下：31万円×2/3＝206,666.67…→1万円未満切上げで21万円
    const r23 = calc_jinteki_kojo(jinteki, 9200000, jv["所得控除"]).meisai
      .haigusha_tokubetsu;
    assert.equal(r23, 210000);

    // 950万円超1000万円以下：31万円×1/3＝103,333.33…→1万円未満切上げで11万円
    const r13 = calc_jinteki_kojo(jinteki, 9700000, jv["所得控除"]).meisai
      .haigusha_tokubetsu;
    assert.equal(r13, 110000);
  });

  test("復興特別所得税＝基準所得税額×2.1%（復興財源確保法13条）", () => {
    // 事業所得9,580,000円、基礎控除は58万円（合計所得9,580,000円は措法の特例の上限655万円超）。
    // 課税総所得金額＝9,580,000−580,000＝9,000,000（端数なし）
    // 算出税額＝9,000,000×23%−636,000＝1,434,000（所法89条・900万円以下900万超区分の境）
    // 復興特別所得税＝1,434,000×2.1%＝30,114円
    const r = calc_shotokuzei_engine(input({ jigyo_shotoku: 9580000 }), tables);
    assert.equal(r.shotokuzei.kazei_sogo_shotoku_kingaku, 9000000);
    assert.equal(r.shotokuzei.sanshutsu_zeigaku, 1434000);
    assert.equal(r.shotokuzei.fukko_tokubetsu_shotokuzei, 30114);
  });
});

// ------------------------------------------------------------------ ② 境界値

describe("② 境界値", () => {
  describe("給与所得控除の区分境界（所法28条3項）", () => {
    test("1,900,000円で「収入から定額を引く区間」から4,000円刻みの区間へ切り替わる", () => {
      // 1,899,999円：区間内（収入−65万）＝1,249,999円
      assert.equal(calc_kyuyo_shotoku(1899999, sv["給与所得控除"]).kingaku, 1249999);
      // 1,900,000円：4,000円刻み側（下限1,900,000円に速算式。190万円以下は控除65万円定額）
      // 1,900,000−650,000＝1,250,000円
      assert.equal(calc_kyuyo_shotoku(1900000, sv["給与所得控除"]).kingaku, 1250000);
    });

    // ★令和8年分の別表第五は 2,026,000 から刻みが始まり、最初の1区分だけ幅が2,000円
    //   （2,026,000〜2,028,000）で、以後 2,028,000 から4,000円刻みに揃う。
    //   floor(収入/4,000)×4,000 で下限を取ると、この区間だけ2,000円低い下限を拾い、
    //   給与所得を2,000円少なく返す。原文の別表第五から導いた期待値を直接置く。
    describe("令和8年分の別表第五は刻みの開始が4,000円の倍数ではない（所法28条4項・別表第五）", () => {
      const b8 = pick_version(tables.shotokuzei["版"], NEN_R8)["給与所得控除"];
      const k = (shunyu) => calc_kyuyo_shotoku(shunyu, b8).kingaku;

      test("2,025,999円までは「収入から定額を引く区間」（収入−69万円）", () => {
        assert.equal(k(2025999), 2025999 - 690000); // 1,335,999
      });
      test("2,026,000円〜2,027,999円は幅2,000円の1区分で、いずれも1,336,000円", () => {
        assert.equal(k(2026000), 1336000);
        assert.equal(k(2026001), 1336000);
        assert.equal(k(2027999), 1336000);
      });
      test("2,028,000円から4,000円刻みに揃う（2,028,000〜2,031,999は1,338,000円）", () => {
        assert.equal(k(2028000), 1338000);
        assert.equal(k(2031999), 1338000);
        assert.equal(k(2032000), 1342000);
      });
      test("691,000円未満は所得0、691,000円から「収入−69万円」に入る", () => {
        assert.equal(k(690999), 0);
        assert.equal(k(691000), 1000);
      });
      test("最低保障69万円は収入が203万円台まで効く（所法28条3項1号の括弧書き）", () => {
        // 8万＋収入×30% が69万円に達するのは収入2,033,334円から。
        // ただし別表第五の区間ではその手前で刻みに入るため、
        // 最低保障が速算式より効いていることを刻みの下限で確かめる。
        // 下限2,032,000：8万＋2,032,000×30%＝689,600＜69万 → 控除69万 → 所得1,342,000
        assert.equal(k(2032000), 2032000 - 690000);
        // 下限2,036,000：8万＋2,036,000×30%＝690,800＞69万 → 控除690,800 → 所得1,345,200
        assert.equal(k(2036000), 2036000 - 690800);
      });
    });

    test("3,600,000円で速算表の行が30%区分から20%区分へ切り替わる", () => {
      // 下限3,600,000円（190万超360万以下）：3,600,000−(650,000+(3,600,000−1,900,000)×30%)
      //   ＝3,600,000−1,160,000＝2,440,000
      assert.equal(calc_kyuyo_shotoku(3600000, sv["給与所得控除"]).kingaku, 2440000);
      // 次の4,000円区分3,604,000円（360万超660万以下）：
      //   3,604,000−(1,160,000+(3,604,000−3,600,000)×20%)＝3,604,000−1,160,800＝2,443,200
      assert.equal(calc_kyuyo_shotoku(3604000, sv["給与所得控除"]).kingaku, 2443200);
    });

    test("8,500,000円で10%区分から控除額定額（195万円）区分へ切り替わる", () => {
      // 8,500,000−(1,760,000+(8,500,000−6,600,000)×10%)＝8,500,000−1,950,000＝6,550,000
      assert.equal(calc_kyuyo_shotoku(8500000, sv["給与所得控除"]).kingaku, 6550000);
      // 8,500,001円以上は控除額が195万円で固定（収入と1対1で増える）
      // 8,500,001−1,950,000＝6,550,001
      assert.equal(calc_kyuyo_shotoku(8500001, sv["給与所得控除"]).kingaku, 6550001);
    });
  });

  describe("所得金額調整控除（措法41条の3の11第1項）", () => {
    function ko1(kyuyo_shunyu, taisho) {
      const jinteki = jinteki_base({ honnin_shogaisha: taisho ? "tokubetsu" : null });
      return calc_shotoku_kingaku_chosei_kojo(
        kyuyo_shunyu,
        0,
        0,
        jinteki,
        sv["所得金額調整控除"],
        sv["人的控除"]["年齢区分"],
      ).ko1;
    }

    test("給与収入850万円ちょうどは適用なし、850万円超で適用あり", () => {
      assert.equal(ko1(8500000, true), 0);
      // 850万円を1円超えた瞬間から適用（(850万1円−850万)×10%＝0.1円）
      assert.equal(ko1(8500001, true), 0.1);
    });

    test("控除は給与収入1,000万円で頭打ちになり、1,200万円でも同額", () => {
      // (1,000万−850万)×10%＝15万円
      assert.equal(ko1(10000000, true), 150000);
      assert.equal(ko1(12000000, true), 150000);
    });

    test("役員報酬1,200万円でも23歳未満の扶養親族・特別障害者がいなければ適用なし", () => {
      assert.equal(ko1(12000000, false), 0);
    });
  });

  test("基礎控除の各区分境界（所法86条1項・措法41条の16の2第1項）", () => {
    // [合計所得金額, 期待する基礎控除額, 措法の特例が適用されるか]
    const cases = [
      // 措法加算表の境界（1,320,000／3,360,000／4,890,000）
      [1320000, 950000, true], // 本則58万＋加算37万
      [1320001, 880000, true], // 本則58万＋加算30万
      [3360000, 880000, true],
      [3360001, 680000, true], // 本則58万＋加算10万
      [4890000, 680000, true],
      [4890001, 630000, true], // 本則58万＋加算5万
      // 措法柱書の境界（令和7・8年分は655万円）
      [6550000, 630000, true],
      [6550001, 580000, false], // 措法の特例が外れ、本則58万円のみ
      // 本則の境界（23,500,000／24,000,000／24,500,000／25,000,000）
      [23500000, 580000, false],
      [23500001, 480000, false],
      [24000000, 480000, false],
      [24000001, 320000, false],
      [24500000, 320000, false],
      [24500001, 160000, false],
      [25000000, 160000, false],
      [25000001, 0, false],
    ];
    for (const [gokei, kingaku, tokurei] of cases) {
      const r = calc_kiso_kojo(gokei, sv["基礎控除"]);
      assert.equal(r.kingaku, kingaku, `合計所得${gokei}円の基礎控除額`);
      assert.equal(r.tokurei_tekiyo, tokurei, `合計所得${gokei}円の特例適用有無`);
    }
  });

  test("所法89条の税率区分の境界と限界税率", () => {
    // [課税所得金額, 期待する限界税率%]
    const cases = [
      [1950000, 5],
      [1950001, 10],
      [3300000, 10],
      [3300001, 20],
      [6950000, 20],
      [6950001, 23],
      [9000000, 23],
      [9000001, 33],
      [18000000, 33],
      [18000001, 40],
      [40000000, 40],
      [40000001, 45],
    ];
    for (const [kazei, percent] of cases) {
      assert.equal(
        find_genkai_zeiritsu(kazei, rv["速算表"]),
        percent,
        `課税所得${kazei}円の限界税率`,
      );
    }
  });

  describe("調整控除（地方税法37条）", () => {
    test("合計課税所得金額200万円の前後で計算式が変わる", () => {
      // 人的控除差額（37条1号イの金額）を10万円とする例。
      // 200万円以下：min(10万,合計課税所得金額)＝10万円 → 道府県2%=2,000／市町村3%=3,000
      assert.deepEqual(calc_chosei_kojo(2000000, 100000, 5000000, jv["調整控除"], false), {
        dofuken: 2000,
        shichoson: 3000,
        gokei: 5000,
      });
      // 200万円超：10万円−(2,000,100−2,000,000)＝99,900円 → 2%=1,998／3%=2,997
      assert.deepEqual(calc_chosei_kojo(2000100, 100000, 5000000, jv["調整控除"], false), {
        dofuken: 1998,
        shichoson: 2997,
        gokei: 4995,
      });
    });

    test("区切り超の下限5万円で下げ止まる", () => {
      // 10万円−(2,050,000−2,000,000)＝5万円ちょうど（下限と一致）
      const at_floor = calc_chosei_kojo(2050000, 100000, 5000000, jv["調整控除"], false);
      assert.deepEqual(at_floor, { dofuken: 1000, shichoson: 1500, gokei: 2500 });
      // さらに合計課税所得金額が増えても5万円未満にはならない（下限で据え置き）
      const beyond_floor = calc_chosei_kojo(2100000, 100000, 5000000, jv["調整控除"], false);
      assert.deepEqual(beyond_floor, at_floor);
    });

    test("前年の合計所得金額が2,500万円を超えると調整控除は0になる", () => {
      assert.deepEqual(calc_chosei_kojo(2000000, 100000, 25000001, jv["調整控除"], false), {
        dofuken: 0,
        shichoson: 0,
        gokei: 0,
      });
      // 2,500万円ちょうどはまだ適用される
      const at_2500 = calc_chosei_kojo(2000000, 100000, 25000000, jv["調整控除"], false);
      assert.equal(at_2500.gokei, 5000);
    });
  });

  describe("扶養控除・特定親族特別控除（所法84条・84条の2）", () => {
    function meisai(gokei_shotoku, nenrei) {
      const jinteki = jinteki_base({
        fuyo_shinzoku: [
          {
            nenrei,
            gokei_shotoku,
            dokyo_rokei_sonzoku: false,
            shogaisha: null,
            dokyo_tokubetsu: false,
            kokugai: false,
          },
        ],
      });
      return calc_jinteki_kojo(jinteki, 5000000, sv["人的控除"]).meisai;
    }

    test("扶養親族の合計所得要件は58万円以下（所法2条1項34号）", () => {
      // 一般の扶養親族（30歳）で境界を確認
      assert.equal(meisai(580000, 30).fuyo, 380000);
      assert.equal(meisai(580001, 30).fuyo, 0);
    });

    test("特定扶養親族（合計所得58万円以下）と特定親族特別控除（58万円超）は排他的に切り替わる", () => {
      // 19歳以上23歳未満・合計所得580,000円 → 特定扶養親族として63万円
      const at_580000 = meisai(580000, 20);
      assert.equal(at_580000.fuyo, 630000);
      assert.equal(at_580000.tokutei_shinzoku_tokubetsu, 0);

      // 同じ年齢で580,001円（扶養親族の要件を1円超える）→ 特定親族特別控除の定額区分（85万円以下）で63万円
      const at_580001 = meisai(580001, 20);
      assert.equal(at_580001.fuyo, 0);
      assert.equal(at_580001.tokutei_shinzoku_tokubetsu, 630000);
    });
  });

  test("指定都市かどうかで住民税所得割の合計額は変わらない（内訳だけ変わる）", () => {
    const base = input({ jigyo_shotoku: 3000000 });
    const normal = calc_shotokuzei_engine({ ...base, shitei_toshi: false }, tables);
    const shitei = calc_shotokuzei_engine({ ...base, shitei_toshi: true }, tables);
    // 道府県4%＋市町村6%＝10%、指定都市は道府県2%＋市町村8%＝10%で合計は同じ
    assert.equal(normal.juminzei.shotokuwari.gokei, shitei.juminzei.shotokuwari.gokei);
    // 内訳は異なる
    assert.notEqual(
      normal.juminzei.shotokuwari.dofuken,
      shitei.juminzei.shotokuwari.dofuken,
    );
  });

  test("人的控除差調整額の検算（地方税法37条の2第11項1号）", () => {
    // 人的控除差調整額＝37条1号イの金額（人的控除なしなら基礎額5万円のみ）
    //   ＋max(所得税の基礎控除（措法適用後）−48万円, 0)
    const cases = [
      // [合計所得金額, 期待する人的控除差調整額]
      [1000000, 520000], // 基礎控除95万円 → 5万＋(95万−48万)＝52万
      [3000000, 450000], // 基礎控除88万円 → 5万＋(88万−48万)＝45万
      [7000000, 150000], // 基礎控除58万円（措法特例が外れる） → 5万＋(58万−48万)＝15万
    ];
    for (const [gokei, expected] of cases) {
      const sagaku = calc_jinteki_kojo_sagaku_37_1_i(
        jinteki_base(),
        gokei,
        jv["調整控除"],
        jv["所得控除"],
      );
      const kiso = calc_kiso_kojo(gokei, sv["基礎控除"]).kingaku;
      const sachosei = calc_jinteki_kojo_sa_chosei_gaku(sagaku, kiso, jv["人的控除差調整額"]);
      assert.equal(sachosei, expected, `合計所得${gokei}円の人的控除差調整額`);
    }
  });

  test("調整控除が使う37条1号イと、ふるさと納税の人的控除差調整額は同一入力でも値が異なる", () => {
    // 一般の扶養親族が1人いる場合：37条1号イ＝5万（基礎額）＋5万（扶養一般）＝10万円
    const jinteki = jinteki_base({
      fuyo_shinzoku: [
        {
          nenrei: 30,
          gokei_shotoku: 0,
          dokyo_rokei_sonzoku: false,
          shogaisha: null,
          dokyo_tokubetsu: false,
          kokugai: false,
        },
      ],
    });
    const gokei = 5000000;
    const sagaku_37_1_i = calc_jinteki_kojo_sagaku_37_1_i(
      jinteki,
      gokei,
      jv["調整控除"],
      jv["所得控除"],
    );
    assert.equal(sagaku_37_1_i, 100000);

    // 人的控除差調整額＝10万＋(基礎控除63万−48万)＝10万＋15万＝25万円（37条1号イとは別の値）
    const kiso = calc_kiso_kojo(gokei, sv["基礎控除"]).kingaku;
    assert.equal(kiso, 630000);
    const sachosei = calc_jinteki_kojo_sa_chosei_gaku(sagaku_37_1_i, kiso, jv["人的控除差調整額"]);
    assert.equal(sachosei, 250000);
    assert.notEqual(sachosei, sagaku_37_1_i);
  });

  test("ひとり親の人的控除差額は父1万円・母5万円で異なる（地方税法施行令7条の16の2）", () => {
    const chichi = calc_jinteki_kojo_sagaku_37_1_i(
      jinteki_base({ honnin_hitorioya: "chichi" }),
      5000000,
      jv["調整控除"],
      jv["所得控除"],
    );
    const haha = calc_jinteki_kojo_sagaku_37_1_i(
      jinteki_base({ honnin_hitorioya: "haha" }),
      5000000,
      jv["調整控除"],
      jv["所得控除"],
    );
    // 基礎額5万円＋ひとり親加算（父1万・母5万）
    assert.equal(chichi, 60000);
    assert.equal(haha, 100000);
  });

  test("所得控除が総所得金額を超える入力はok:falseになる", () => {
    const r = calc_shotokuzei_engine(
      input({
        jigyo_shotoku: 100000,
        butsuteki: {
          shakai_hoken_ryo: 10000000,
          shokibo_kyosai: 0,
          seimei_hokenryo: {},
          jishin_hokenryo: {},
          iryohi_kojo: 0,
          zasson_kojo: 0,
          kifukin_kojo: 0,
        },
      }),
      tables,
    );
    assert.equal(r.ok, false);
    assert.match(r.riyu, /所得控除が総所得金額を超えています/);
  });
});

// -------------------------------------------------------- ③ 改正前後の分岐

describe("③ 改正前後の分岐", () => {
  // 令和8年度改正（令和8年法律第12号）の適用時期は「令和八年分以後の所得税について適用し、
  // 令和七年分以前の所得税については、なお従前の例による」（同法附則2条・3条・9条）。
  // 以下の期待値は、令和7年分＝改正前の条文、令和8年分＝改正後の条文から手で計算している。
  const sv_r7 = pick_version(tables.shotokuzei["版"], NEN_R7);
  const sv_r8 = pick_version(tables.shotokuzei["版"], NEN_R8);

  test("基礎控除の本則は令和7年分58万円・令和8年分62万円（所法86条1項1号）", () => {
    // 合計所得2,350万円超の帯（48/32/16万円）は改正されていない
    assert.equal(calc_kiso_kojo(23500000, sv_r7["基礎控除"]).kingaku, 580000);
    assert.equal(calc_kiso_kojo(23500000, sv_r8["基礎控除"]).kingaku, 620000);
    assert.equal(calc_kiso_kojo(24000000, sv_r7["基礎控除"]).kingaku, 480000);
    assert.equal(calc_kiso_kojo(24000000, sv_r8["基礎控除"]).kingaku, 480000);
  });

  test("基礎控除の上乗せは令和8年分から4区分→2区分になる（措法41条の16の2第1項1号）", () => {
    // 令和7年分：132万以下37万／336万以下30万／489万以下10万／超5万（本則58万に加算）
    // 令和8年分：489万以下42万／超5万（本則62万に加算）。柱書のしきい値655万円は据置き
    const cases = [
      [1000000, 950000, 1040000], // 58+37=95万 ／ 62+42=104万
      [3000000, 880000, 1040000], // 58+30=88万 ／ 62+42=104万
      [4000000, 680000, 1040000], // 58+10=68万 ／ 62+42=104万
      [4890000, 680000, 1040000], // 489万ちょうど：どちらも上の帯の最後
      [4890001, 630000, 670000],  // 489万1円：58+5=63万 ／ 62+5=67万
      [6000000, 630000, 670000],
    ];
    for (const [gokei, r7, r8] of cases) {
      assert.equal(calc_kiso_kojo(gokei, sv_r7["基礎控除"]).kingaku, r7, `令和7年分 合計所得${gokei}`);
      assert.equal(calc_kiso_kojo(gokei, sv_r8["基礎控除"]).kingaku, r8, `令和8年分 合計所得${gokei}`);
    }
  });

  test("柱書のしきい値655万円の境界は令和7年分・令和8年分のどちらにもある", () => {
    assert.equal(calc_kiso_kojo(6550000, sv_r7["基礎控除"]).kingaku, 630000); // 58+5
    assert.equal(calc_kiso_kojo(6550001, sv_r7["基礎控除"]).kingaku, 580000); // 特例が外れる
    assert.equal(calc_kiso_kojo(6550000, sv_r8["基礎控除"]).kingaku, 670000); // 62+5
    assert.equal(calc_kiso_kojo(6550001, sv_r8["基礎控除"]).kingaku, 620000); // 特例が外れる
  });

  test("給与所得控除は令和8年分から構造ごと変わる（所法28条3項）", () => {
    // 令和7年分：190万円以下は一律65万円
    // 令和8年分：360万円以下は「8万円＋収入×30%」、ただし69万円を下回らない
    const k = (nen, shunyu) =>
      calc_kyuyo_shotoku(shunyu, pick_version(tables.shotokuzei["版"], nen)["給与所得控除"]).kingaku;
    // 収入200万円：令和7年分は190万円超の帯に入るので
    //   控除＝65万＋(200万−190万)×30%＝68万 → 所得132万（下限200万は4,000円の倍数）
    assert.equal(k(NEN_R7, 2000000), 1320000);
    // 令和8年分 200万は「収入から定額を引く区間」（69.1万〜202.6万）→ 200万−69万＝131万
    assert.equal(k(NEN_R8, 2000000), 1310000);
    // 収入500万円：控除＝116万＋(500万−360万)×20%＝144万（両年分とも同じ算式）
    assert.equal(k(NEN_R7, 5000000), 5000000 - 1440000);
    assert.equal(k(NEN_R8, 5000000), 5000000 - 1440000);
    // 収入900万円：控除195万（別表第五の外・上限帯。両年分とも同じ）
    assert.equal(k(NEN_R7, 9000000), 9000000 - 1950000);
    assert.equal(k(NEN_R8, 9000000), 9000000 - 1950000);
  });

  test("扶養親族の合計所得要件は令和7年分58万円・令和8年分62万円（所法2条1項34号）", () => {
    // 19歳の子（特定扶養親族）の合計所得を動かし、扶養控除63万円が付くかを見る
    const fuyo = (nen, gokei) => {
      const v = pick_version(tables.shotokuzei["版"], nen);
      return calc_jinteki_kojo(
        jinteki_base({
          fuyo_shinzoku: [
            { nenrei: 19, gokei_shotoku: gokei, shogaisha: null, dokyo_tokubetsu: false, dokyo_rokei_sonzoku: false },
          ],
        }),
        3000000,
        v["人的控除"],
      ).meisai.fuyo;
    };
    assert.equal(fuyo(NEN_R7, 580000), 630000);
    assert.equal(fuyo(NEN_R7, 580001), 0); // 令和7年分は58万円を超えると扶養控除が外れる
    assert.equal(fuyo(NEN_R8, 580001), 630000); // 令和8年分は62万円までなら残る
    assert.equal(fuyo(NEN_R8, 620000), 630000);
    assert.equal(fuyo(NEN_R8, 620001), 0);
  });

  test("収録していない年分はデータがない旨を返す", () => {
    // 収録は令和7年分・令和8年分の2年分だけ。
    // 令和9年分は所得税のひとり親控除が38万円になり（令和9年1月1日施行）、
    // 住民税のひとり親控除も33万円になる（令和10年1月1日施行）ため、まだ収録していない。
    for (const nen of [2010, 2024, 2027, 2030]) {
      const r = calc_shotokuzei_engine(input({ nen }), tables);
      assert.equal(r.ok, false, `${nen}年分`);
      assert.match(r.riyu, /収録/);
    }
  });
});

// ------------------------------------------------------------------ ④ データの整合

describe("④ データの整合", () => {
  test("3つの新データファイルの収録年のカバー範囲が一致する", () => {
    function coverage(versions) {
      const start = Math.min(...versions.map((v) => v["適用開始年"]));
      const has_open_end = versions.some((v) => v["適用終了年"] === null);
      // 全区間の最大終了年（すべて null なら Infinity 扱い）
      const end = has_open_end
        ? null
        : Math.max(...versions.map((v) => v["適用終了年"]));
      return { start, end };
    }
    const shotokuzei_range = coverage(tables.shotokuzei["版"]);
    const juminzei_range = coverage(tables.juminzei["版"]);
    const bunri_range = coverage(tables.bunri_kazei["版"]);

    // 所得税・住民税は令和7年分と令和8年分の2年分だけを収録する（判断ログ D-28）。
    // 分離課税の税率は動いていないので開いたままでよい。
    // エンジンは4つの表すべてに版があるときだけ計算するので、実効範囲は狭いほうで決まる。
    assert.deepEqual(shotokuzei_range, { start: 2025, end: 2026 });
    assert.deepEqual(juminzei_range, { start: 2025, end: 2026 });
    assert.deepEqual(bunri_range, { start: 2025, end: null });
  });

  test("人的控除の項目キーは3箇所（shotokuzei.人的控除／juminzei.所得控除／juminzei.調整控除.人的控除差額表）で一致する", () => {
    const keys_shotokuzei = Object.keys(sv["人的控除"]);
    const keys_juminzei = Object.keys(jv["所得控除"]);
    const keys_sagaku = Object.keys(jv["調整控除"]["人的控除差額表"]);

    // 3箇所すべてに現れるキーだけを対象にする
    const common = keys_shotokuzei
      .filter((k) => keys_juminzei.includes(k) && keys_sagaku.includes(k))
      .sort();

    assert.deepEqual(
      common,
      [
        "ひとり親",
        "勤労学生",
        "寡婦",
        "扶養控除",
        "特定親族特別控除",
        "障害者",
        "配偶者控除",
        "配偶者特別控除",
      ].sort(),
    );
  });

  test("bunri_kazei.jsonの区分キーをエンジンが受け付け、知らない区分はok:falseになる", () => {
    const valid = calc_shotokuzei_engine(
      input({
        jigyo_shotoku: 5000000,
        bunri: [{ kubun: "ippan_joto", shotoku_kingaku: 100000, kazei_hyojun: 100000 }],
      }),
      tables,
    );
    assert.equal(valid.ok, true);

    const invalid = calc_shotokuzei_engine(
      input({
        bunri: [{ kubun: "fugou_na_kubun", shotoku_kingaku: 100, kazei_hyojun: 100 }],
      }),
      tables,
    );
    assert.equal(invalid.ok, false);
    assert.match(invalid.riyu, /収録していません/);
  });
});

// -------------------------------------------------------- ⑤ レビュー由来の回帰テスト

describe("⑤ レビュー由来の回帰テスト", () => {
  test("配偶者特別控除の人的控除差（地方税法37条1号イ(7)）は現行法では空集合", () => {
    // 37条1号イ(7)の要件は「配偶者の前年合計所得55万円未満」かつ「控除対象配偶者に該当しない」。
    // 同一生計配偶者の所得要件が58万円以下に引き上げられた結果、両方を満たす配偶者は存在しない。
    // 配偶者の合計所得59万円（控除対象配偶者に該当せず、かつ55万円以上）で確認する。
    const jinteki = jinteki_base({
      haigusha: { nenrei: 40, gokei_shotoku: 590000, shogaisha: null, dokyo_tokubetsu: false },
    });
    const sagaku = calc_jinteki_kojo_sagaku_37_1_i(
      jinteki,
      5000000, // 本人の合計所得900万円以下
      jv["調整控除"],
      jv["所得控除"],
    );
    // 配偶者に係る加算が乗らず、基礎額5万円のまま
    assert.equal(sagaku, 50000);
  });

  test("退職所得を入れると所得税の合計所得金額は増えるが、住民税側（翌年度分）は増えない", () => {
    const r = calc_shotokuzei_engine(
      input({ jigyo_shotoku: 3000000, taishoku_shotoku_kingaku: 2000000 }),
      tables,
    );
    // 所得税：事業所得300万＋退職所得200万＝500万
    assert.equal(r.gokei_shotoku_kingaku, 5000000);
    // 住民税：退職所得は現年分離課税のため翌年度分の合計所得金額には算入しない → 300万のまま
    assert.equal(r.gokei_shotoku_kingaku_juminzei, 3000000);
  });

  test("分離課税：20%上限の分母は増えるが、割合表の引数（人的控除差調整額を引いた後の金額）は増えない", () => {
    // 基礎控除の区分が変わらない範囲で比較するため、事業所得200万円＋上場株式譲渡益10万円とする
    // （事業所得だけの300万円台の区分に留め、譲渡益を加えても措法特例の加算表の区分が動かない
    //  よう、事業所得を低めの200万円に設定している）。
    const base = calc_shotokuzei_engine(input({ jigyo_shotoku: 2000000 }), tables);
    const with_bunri = calc_shotokuzei_engine(
      input({
        jigyo_shotoku: 2000000,
        bunri: [{ kubun: "jojo_joto", shotoku_kingaku: 100000, kazei_hyojun: 100000 }],
      }),
      tables,
    );

    // 割合表の引数（課税総所得金額−人的控除差調整額）は、分離課税を足しても変わらない
    // （sogo・基礎控除の区分のいずれも分離課税の影響を受けていないことを前提に確認する）
    assert.equal(base.shotokuzei.kiso_kojo, with_bunri.shotokuzei.kiso_kojo);
    assert.equal(
      base.juminzei.kazei_sogo_minus_jinteki_sa,
      with_bunri.juminzei.kazei_sogo_minus_jinteki_sa,
    );

    // 20%上限の分母（shotokuwari.gokei）は上場株式の住民税分（10万円×5%＝5,000円）だけ増える
    assert.equal(
      with_bunri.juminzei.shotokuwari.gokei - base.juminzei.shotokuwari.gokei,
      5000,
    );
  });

  test("合計所得金額に入るのは分離課税の特別控除前の金額", () => {
    // 譲渡益3,000万円だが特別控除で課税標準は0円（措法35条3,000万円控除を模した入力）
    const base = calc_shotokuzei_engine(input({ jigyo_shotoku: 3000000 }), tables);
    assert.equal(base.shotokuzei.kiso_kojo, 880000);
    assert.equal(base.shotokuzei.kiso_kojo_tokurei_tekiyo, true);

    const with_kojo_zero = calc_shotokuzei_engine(
      input({
        jigyo_shotoku: 3000000,
        bunri: [{ kubun: "tochi_choki", shotoku_kingaku: 30000000, kazei_hyojun: 0 }],
      }),
      tables,
    );
    // 合計所得金額は特別控除前の3,000万円を含めて3,300万円まで増える
    assert.equal(with_kojo_zero.gokei_shotoku_kingaku, 33000000);
    // 合計所得金額が基礎控除の上限（2,500万円）を超えるため、基礎控除は消滅する
    assert.equal(with_kojo_zero.shotokuzei.kiso_kojo, 0);
    assert.equal(with_kojo_zero.shotokuzei.kiso_kojo_tokurei_tekiyo, false);
    // 課税標準0円の分離課税自体はエンジンとして計算可能（ok:trueのまま）
    assert.equal(with_kojo_zero.ok, true);
  });
});
